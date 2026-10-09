'use strict';
const { app, BrowserWindow, Menu, dialog, shell, ipcMain, session } = require('electron');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const userData = process.env.WRITER_DESK_USER_DATA
  ? path.resolve(process.env.WRITER_DESK_USER_DATA)
  : path.join(app.getPath('appData'), 'writer-desk');
app.setPath('userData', userData);
app.setName("Writer's Desk");
const hasLock = app.requestSingleInstanceLock();
let window = null, service = null, origin = '', closing = false, allowQuit = false, saveReady = false;
let closeRequest = null, lastServiceLog = '';
const serviceToken = randomBytes(32).toString('hex');
const settingsPath = path.join(userData, 'settings.json');
const storagePath = path.join(userData, 'client-storage.json');
fs.mkdirSync(userData, { recursive: true });
function readObject(file) { try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; } }
const settings = readObject(settingsPath), storage = readObject(storagePath);
let language = settings.language === 'en' ? 'en' : 'zh';
const text = (zh, en) => language === 'en' ? en : zh;
const title = () => text('作家工作台', "Writer's Desk");
function atomicWrite(file, value) {
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
}
function trusted(event) {
  try {
    return !!window && !window.isDestroyed() && event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame && !!origin && new URL(event.senderFrame.url).origin === origin;
  } catch { return false; }
}
const localURL = value => { try { return new URL(value).origin === origin; } catch { return false; } };
const externalURL = value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; } };
function openExternal(value) { if (externalURL(value)) shell.openExternal(value).catch(() => {}); }
function createMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: title(), submenu: [{ role: 'about' }, { type: 'separator' }, { label: text('退出', 'Quit'), accelerator: 'Cmd+Q', click: () => app.quit() }] }] : []),
    { label: text('文件', 'File'), submenu: [
      { label: text('打开作品数据文件夹', 'Open data folder'), click: () => shell.openPath(path.join(userData, 'data')).catch(() => {}) },
      { type: 'separator' }, { label: text('退出', 'Quit'), accelerator: 'Alt+F4', click: () => app.quit() }
    ] },
    { label: text('编辑', 'Edit'), submenu: [{ role: 'undo', label: text('撤销', 'Undo') }, { role: 'redo', label: text('重做', 'Redo') }, { type: 'separator' }, { role: 'cut', label: text('剪切', 'Cut') }, { role: 'copy', label: text('复制', 'Copy') }, { role: 'paste', label: text('粘贴', 'Paste') }, { role: 'selectAll', label: text('全选', 'Select all') }] },
    { label: text('视图', 'View'), submenu: [{ role: 'resetZoom', label: text('实际大小', 'Actual size') }, { role: 'zoomIn', label: text('放大', 'Zoom in') }, { role: 'zoomOut', label: text('缩小', 'Zoom out') }, { type: 'separator' }, { role: 'togglefullscreen', label: text('全屏', 'Full screen') }] },
    { label: text('帮助', 'Help'), submenu: [{ label: text('关于作家工作台', "About Writer's Desk"), click: () => dialog.showMessageBox(window, { type: 'info', title: title(), message: `${title()} ${app.getVersion()}`, detail: text('作品保存在本机。请定期导出完整备份。\n\n数据目录：', 'Your work stays on this computer. Export full backups regularly.\n\nData folder: ') + path.join(userData, 'data') }) }] }
  ]));
}

ipcMain.on('writer:bootstrap', event => { event.returnValue = trusted(event) ? { language, version: app.getVersion() } : {}; });
ipcMain.handle('writer:language', (event, value) => {
  if (!trusted(event) || !['zh', 'en'].includes(value)) return false;
  language = value;
  try { atomicWrite(settingsPath, { ...settings, language }); } catch { /* The UI also retains its preference. */ }
  createMenu(); return true;
});
ipcMain.on('writer:storage', (event, request) => {
  event.returnValue = { error: 'Storage unavailable' };
  if (!trusted(event) || !request || typeof request !== 'object') return;
  try {
    const { op, key, value } = request;
    if (op === 'length') { event.returnValue = { value: Object.keys(storage).length }; return; }
    if (op === 'key') { event.returnValue = { value: Number.isInteger(key) && key >= 0 ? Object.keys(storage)[key] ?? null : null }; return; }
    if (typeof key !== 'string' || key.length > 512 || !/^(yejian\.|writer-desk\.)/.test(key)) throw new Error('Invalid storage key');
    if (op === 'get') { event.returnValue = { value: typeof storage[key] === 'string' ? storage[key] : null }; return; }
    if (op === 'set') {
      if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 32 * 1024 * 1024) throw new Error('Value exceeds 32 MB');
      const previous = storage[key];
      storage[key] = value;
      try {
        if (Buffer.byteLength(JSON.stringify(storage)) > 128 * 1024 * 1024) throw new Error('Storage exceeds 128 MB');
        atomicWrite(storagePath, storage);
      } catch (error) { if (previous === undefined) delete storage[key]; else storage[key] = previous; throw error; }
    } else if (op === 'remove') {
      const previous = storage[key]; delete storage[key];
      try { atomicWrite(storagePath, storage); } catch (error) { if (previous !== undefined) storage[key] = previous; throw error; }
    } else throw new Error('Unknown storage operation');
    event.returnValue = { value: null };
  } catch (error) { event.returnValue = { error: error.message }; }
});
ipcMain.on('writer:save-ready', event => { if (trusted(event)) saveReady = true; });
ipcMain.on('writer:save-result', (event, result) => {
  if (!trusted(event) || !closeRequest || result?.token !== closeRequest.token) return;
  closeRequest.resolve(result.saved === true);
});

function waitForSave() {
  if (!window || window.isDestroyed()) return Promise.resolve(true);
  if (!saveReady) return Promise.resolve(false);
  return new Promise(resolve => {
    const token = randomBytes(16).toString('hex');
    const timer = setTimeout(() => finish(false), 15000);
    function finish(value) { clearTimeout(timer); closeRequest = null; resolve(value); }
    closeRequest = { token, resolve: finish };
    window.webContents.send('writer:before-close', token);
  });
}
async function requestClose() {
  if (closing || allowQuit) return;
  closing = true;
  let saved = await waitForSave();
  if (!saved && window && !window.isDestroyed()) {
    const answer = await dialog.showMessageBox(window, {
      type: 'warning', title: title(),
      message: text('尚未确认保存完成', 'Saving has not completed'),
      detail: text('请返回工作台重试保存，或先导出完整备份。退出时会保留已写入的本地草稿。', 'Return to the app to retry saving or export a full backup. Local drafts already written to disk will be retained.'),
      buttons: [text('返回工作台', 'Return to app'), text('重试保存', 'Retry save'), text('仍然退出', 'Exit anyway')], defaultId: 0, cancelId: 0, noLink: true
    });
    if (answer.response === 1) saved = await waitForSave();
    else if (answer.response === 2) saved = true;
  }
  closing = false;
  if (!saved) return;
  allowQuit = true;
  if (window && !window.isDestroyed()) window.destroy();
  await stopService();
  app.quit();
}
async function stopService() {
  if (!service || service.exitCode !== null) return;
  const child = service;
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}
function startService() {
  const packaged = app.isPackaged;
  const source = path.resolve(__dirname, '..');
  const command = packaged ? path.join(process.resourcesPath, 'backend', process.platform === 'win32' ? 'writer-service.exe' : 'writer-service') : (process.env.WRITER_DESK_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'));
  const args = packaged ? [] : [path.join(source, 'server.py')];
  args.push('--desktop', '--port', '0', '--data-dir', path.join(userData, 'data'));
  for (const directory of [path.join(source, 'data'), path.resolve(source, '..', 'yejian', 'data'), path.resolve(path.dirname(process.execPath), '..', 'data')]) {
    if (fs.existsSync(path.join(directory, 'writer.sqlite3'))) args.push('--legacy-data-dir', directory);
  }
  return new Promise((resolve, reject) => {
    let ready = false, output = '';
    const timer = setTimeout(() => { reject(new Error(text('本机保存服务在 20 秒内没有就绪。', 'The local save service did not become ready within 20 seconds.'))); service?.kill(); }, 20000);
    service = spawn(command, args, { cwd: packaged ? process.resourcesPath : source, env: { ...process.env, WRITER_DESKTOP_TOKEN: serviceToken, PYTHONUNBUFFERED: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    service.on('error', error => { clearTimeout(timer); reject(error); });
    service.stderr.on('data', bytes => { lastServiceLog = (lastServiceLog + bytes.toString()).slice(-4000); });
    service.stdout.on('data', bytes => {
      output += bytes.toString();
      const lines = output.split('\n'); output = lines.pop();
      for (const line of lines) if (!ready && line.startsWith('WRITER_READY ')) {
        try { const value = JSON.parse(line.slice(13)); const url = new URL(value.url); if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) throw new Error('Invalid service URL'); origin = url.origin; ready = true; clearTimeout(timer); resolve(origin); } catch (error) { clearTimeout(timer); reject(error); }
      }
    });
    service.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (!ready) reject(new Error(lastServiceLog || `Local save service exited (${code ?? signal})`));
      else if (!allowQuit && window && !window.isDestroyed()) dialog.showMessageBox(window, { type: 'error', title: title(), message: text('本机保存服务已停止', 'The local save service stopped'), detail: text('当前编辑仍在窗口中。请先用“备份与导出”下载完整备份，再重新启动作家工作台。', 'Your current edits remain in this window. Export a full backup from Backup & export, then restart Writer’s Desk.') });
    });
  });
}
function createWindow() {
  const appSession = session.fromPartition('persist:writer-desk');
  appSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  appSession.setPermissionCheckHandler(() => false);
  appSession.webRequest.onBeforeRequest((details, callback) => {
    const local = localURL(details.url) || details.url.startsWith(`blob:${origin}/`) || details.url.startsWith('data:image/');
    callback({ cancel: !local });
  });
  appSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    if (localURL(details.url)) headers['X-Writer-Desktop'] = serviceToken;
    callback({ requestHeaders: headers });
  });
  window = new BrowserWindow({
    title: title(), width: 1440, height: 960, minWidth: 780, minHeight: 600, show: false, backgroundColor: '#ffffff',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false, webSecurity: true, navigateOnDragDrop: false, webviewTag: false, session: appSession }
  });
  window.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => {
    let isDocument = false;
    try { const value = new URL(url); isDocument = localURL(url) && ['/', '/index.html'].includes(value.pathname); } catch { }
    if (!isDocument) { event.preventDefault(); if (!localURL(url)) openExternal(url); }
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => { if (mainFrame) saveReady = false; });
  appSession.on('will-download', (event, item, contents) => {
    if (contents !== window?.webContents || !(localURL(item.getURL()) || item.getURL().startsWith(`blob:${origin}/`))) { event.preventDefault(); return; }
    item.setSaveDialogOptions({ title: text('保存导出文件', 'Save exported file'), defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename())) });
    item.once('done', (_done, status) => { if (status === 'interrupted') dialog.showMessageBox(window, { type: 'error', title: title(), message: text('导出没有完成，请检查目标文件夹后重试。', 'Export did not complete. Check the destination folder and retry.') }); });
  });
  window.once('ready-to-show', () => window.show());
  window.on('close', event => { if (!allowQuit) { event.preventDefault(); requestClose(); } });
  window.on('closed', () => { window = null; });
  createMenu();
  return window.loadURL(origin + '/').then(() => console.info('[writer-desk] Desktop window loaded; local storage service is ready.'));
}

if (!hasLock) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.on('before-quit', event => { if (!allowQuit && window) { event.preventDefault(); requestClose(); } });
  app.on('window-all-closed', () => { if (allowQuit) app.quit(); });
  app.on('quit', () => { if (service && service.exitCode === null) service.kill(); });
  app.whenReady().then(async () => {
    try { await startService(); await createWindow(); }
    catch (error) { allowQuit = true; await stopService(); dialog.showErrorBox(title(), text('无法启动本机写作服务。原作品库仍保留。\n\n', 'Could not start the local writing service. Existing work is preserved.\n\n') + error.message); app.quit(); }
  });
}
