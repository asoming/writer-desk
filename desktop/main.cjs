'use strict';
const { app, BrowserWindow, Menu, dialog, shell, ipcMain, session } = require('electron');
const { spawn } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const updater = require('./updater.cjs');

const userData = process.env.WRITER_DESK_USER_DATA
  ? path.resolve(process.env.WRITER_DESK_USER_DATA)
  : path.join(app.getPath('appData'), 'writer-desk');
app.setPath('userData', userData);
app.setName("Writer's Desk");
const hasLock = app.requestSingleInstanceLock();
let window = null, service = null, origin = '', closing = false, allowQuit = false, saveReady = false;
let closeRequest = null, lastServiceLog = '', updateBusy = false, stoppingService = false;
let pdfBusy = false;
const serviceToken = randomBytes(32).toString('hex');
const settingsPath = path.join(userData, 'settings.json');
const storagePath = path.join(userData, 'client-storage.json');
fs.mkdirSync(userData, { recursive: true });
function readObject(file) { try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; } }
const settings = readObject(settingsPath), storage = readObject(storagePath);
let language = settings.language === 'en' ? 'en' : 'zh';
const text = (zh, en) => language === 'en' ? en : zh;
const title = () => text('作家工作台', "Writer's Desk");
const updateOptions = () => ({ ...updater.paths({ root: process.env.WRITER_DESK_INSTALL_ROOT, applications: process.env.WRITER_DESK_APPLICATIONS_DIR }), currentVersion: app.getVersion(), previousExecutable: process.execPath });
function updateFailure(error) { return { error: updater.errorMessage(error, language), code: typeof error?.code === 'string' && error.code.startsWith('update-') ? error.code : 'update-failed' }; }
async function installUpdate() {
  if (process.platform !== 'linux') throw Object.assign(new Error(), { code: 'update-unsupported' });
  if (updateBusy || closing || allowQuit) throw Object.assign(new Error(), { code: 'update-busy' });
  updateBusy = true;
  try {
    const selected = await dialog.showOpenDialog(window, { title: text('选择可信来源的 Linux 升级包（同目录需有 .sha256）', 'Choose a trusted Linux update package (.sha256 required beside it)'), properties: ['openFile'], filters: [{ name: 'WriterDesk Linux package', extensions: ['gz'] }] });
    if (selected.canceled || !selected.filePaths?.length) return { canceled: true };
    return await updater.stageArchive(selected.filePaths[0], updateOptions());
  } finally { updateBusy = false; }
}
async function restartAfterUpdate() {
  if (process.platform !== 'linux') throw Object.assign(new Error(), { code: 'update-unsupported' });
  if (updateBusy || closing || allowQuit) throw Object.assign(new Error(), { code: 'update-busy' });
  updateBusy = true; closing = true;
  try {
    if (!await waitForSave()) throw Object.assign(new Error(), { code: 'update-save-failed' });
    const planned = await updater.planRestart(updateOptions());
    app.relaunch({ execPath: planned.executable, args: ['--writer-activate-update', planned.token] });
    allowQuit = true;
    if (window && !window.isDestroyed()) window.destroy();
    await stopService(); app.quit();
    return { restarting: true };
  } finally { if (!allowQuit) { updateBusy = false; closing = false; } }
}
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
function folderError(code, zh, en) { return Object.assign(new Error(text(zh, en)), { code }); }
function serviceFolderError(status, body) {
  switch (body?.code) {
    case 'FOLDER_CONFLICT': return folderError('folder-conflict', '作品文件夹中的导出文件已被修改或存在同名文件，未覆盖这些文件。请移走或改名后重试。', 'Exported files were modified outside the app or files with the same names already exist. Nothing was overwritten. Move or rename those files and try again.');
    case 'FOLDER_UNSAFE': return folderError('unsafe-folder', '作品文件夹路径异常，无法安全同步。请检查目录是否为符号链接。', 'The book folder path cannot be safely synchronized. Check whether the directory is a symbolic link.');
    case 'FOLDER_FAILURE': return folderError('folder-sync-failed', '无法同步作品文件夹，请检查磁盘空间和目录权限。作品仍已保存在本机。', 'Could not synchronize the book folder. Check disk space and folder permissions. Your book is still saved locally.');
    case 'FOLDER_REQUEST': return folderError('invalid-book-id', '打开作品文件夹只接受作品编号，不接受文件路径。', 'Opening a book folder accepts only a book ID, not a file path.');
    case 'FOLDER_UNSUPPORTED': return folderError('folder-unsupported', '当前系统不支持安全打开作品文件夹。作品仍已保存在本机。', 'This system does not support safely opening book folders. Your book is still saved locally.');
    default: return status === 404
      ? folderError('book-unavailable', '找不到这部作品，请返回书架后重试。', 'This book is unavailable. Return to the bookshelf and try again.')
      : folderError('folder-prepare-failed', '无法准备作品文件夹，请检查保存状态后重试。', 'Could not prepare the book folder. Check that the book is saved and try again.');
  }
}
function validBookId(value) {
  if (typeof value !== 'string' || !value.trim() || ['.', '..'].includes(value) || [...value].length > 100 || /[\u0000-\u001f\u007f]/.test(value)) return false;
  try { encodeURIComponent(value); return true; } catch { return false; }
}
function prepareBookFolder(bookId) {
  if (!origin || !service || service.exitCode !== null) return Promise.reject(folderError('service-unavailable', '本机保存服务尚未就绪，请稍后重试。', 'The local save service is not ready. Try again shortly.'));
  return new Promise((resolve, reject) => {
    let completed = false;
    const finish = (error, result) => { if (completed) return; completed = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => request.destroy(folderError('service-timeout', '准备作品文件夹超时，请重试。', 'Preparing the book folder timed out. Try again.')), 10000);
    const request = http.request(new URL(`/api/books/${encodeURIComponent(bookId)}/folder`, origin), {
      method: 'POST', headers: { 'X-Writer-Desktop': serviceToken, 'X-Writer-Client': '1', Origin: origin, 'Content-Type': 'application/json', 'Content-Length': 2 }
    }, response => {
      let size = 0, chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 64 * 1024) { request.destroy(folderError('invalid-response', '保存服务返回的文件夹信息不正确。', 'The save service returned invalid folder information.')); return; }
        chunks.push(chunk);
      });
      response.on('error', () => finish(folderError('service-unavailable', '无法连接本机保存服务，请稍后重试。', 'Could not connect to the local save service. Try again shortly.')));
      response.on('end', () => {
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { }
        if (response.statusCode !== 200) {
          finish(serviceFolderError(response.statusCode, body));
          return;
        }
        if (body === undefined) finish(folderError('invalid-response', '保存服务返回的文件夹信息不正确。', 'The save service returned invalid folder information.'));
        else finish(null, body);
      });
    });
    request.on('error', error => finish(['service-timeout', 'invalid-response'].includes(error.code) ? error : folderError('service-unavailable', '无法连接本机保存服务，请稍后重试。', 'Could not connect to the local save service. Try again shortly.')));
    request.end('{}');
  });
}
function checkedBookFolder(bookId, folder) {
  const unsafe = () => folderError('unsafe-folder', '作品文件夹位置不正确，或包含符号链接，无法打开。', 'The book folder has an invalid location or contains a symbolic link and cannot be opened.');
  if (typeof folder !== 'string' || folder.includes('\0') || !path.isAbsolute(folder)) throw unsafe();
  const root = fs.realpathSync(userData);
  const name = 'book-' + createHash('sha256').update(bookId, 'utf8').digest('hex');
  const expected = path.join(root, 'data', 'books', name);
  if (path.relative(expected, folder) !== '' || path.normalize(folder) !== folder) throw unsafe();
  let current = root;
  for (const part of ['data', 'books', name]) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory() || path.relative(current, fs.realpathSync(current)) !== '') throw unsafe();
  }
  return expected;
}
async function openBookFolder(bookId) {
  if (!validBookId(bookId)) throw folderError('invalid-book-id', '作品编号不正确，请返回书架后重试。', 'The book ID is invalid. Return to the bookshelf and try again.');
  const prepared = await prepareBookFolder(bookId);
  if (!Number.isSafeInteger(prepared?.revision) || prepared.revision < 1) throw folderError('invalid-response', '保存服务返回的文件夹信息不正确。', 'The save service returned invalid folder information.');
  let folder;
  try { folder = checkedBookFolder(bookId, prepared.folder); }
  catch (error) { throw error.code === 'unsafe-folder' ? error : folderError('folder-unavailable', '作品文件夹不存在或无法读取，请重试。', 'The book folder is missing or cannot be read. Try again.'); }
  try { if (await shell.openPath(folder)) throw new Error('File manager rejected the folder'); }
  catch { throw folderError('open-folder-failed', '无法打开系统文件管理器，请检查桌面环境后重试。', 'Could not open the system file manager. Check your desktop environment and try again.'); }
  return { folder, revision: prepared.revision };
}
const appActions = new Set(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'zoomIn', 'zoomOut', 'resetZoom', 'toggleFullscreen', 'openDataFolder', 'quit', 'minimize', 'toggleMaximize', 'close']);
const editActions = new Set(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']);
function windowState() {
  if (!window || window.isDestroyed()) return {};
  return { zoomFactor: window.webContents.getZoomFactor(), fullscreen: window.isFullScreen(), maximized: window.isMaximized() };
}
function publishWindowState() {
  if (window && !window.isDestroyed()) window.webContents.send('writer:window-state', { fullscreen: window.isFullScreen(), maximized: window.isMaximized() });
}
async function performAppAction(action) {
  if (editActions.has(action)) window.webContents[action]();
  else if (action === 'zoomIn' || action === 'zoomOut' || action === 'resetZoom') {
    const factor = action === 'resetZoom' ? 1 : Math.round((window.webContents.getZoomFactor() + (action === 'zoomIn' ? 0.1 : -0.1)) * 10) / 10;
    window.webContents.setZoomFactor(Math.max(0.5, Math.min(2, factor)));
  } else if (action === 'toggleFullscreen') window.setFullScreen(!window.isFullScreen());
  else if (action === 'toggleMaximize') { if (window.isMaximized()) window.unmaximize(); else window.maximize(); }
  else if (action === 'minimize') window.minimize();
  else if (action === 'quit' || action === 'close') await requestClose();
  else if (action === 'openDataFolder') {
    try { if (await shell.openPath(path.join(userData, 'data'))) throw new Error('File manager rejected the folder'); }
    catch { throw folderError('open-folder-failed', '无法打开系统文件管理器，请检查桌面环境后重试。', 'Could not open the system file manager. Check your desktop environment and try again.'); }
  }
  return windowState();
}
function keyboardAction(input) {
  if (input.type !== 'keyDown' || input.isComposing) return null;
  const key = input.key.toLowerCase();
  if (key === 'f11' && !input.control && !input.meta && !input.alt) return 'toggleFullscreen';
  if (key === 'f4' && input.alt && !input.control && !input.meta) return 'close';
  if (!(input.control || input.meta) || input.alt) return null;
  if (key === 'z') return input.shift ? 'redo' : 'undo';
  if (key === 'y' && !input.shift) return 'redo';
  if (key === 'q' && process.platform === 'darwin' && input.meta) return 'quit';
  if (key === '+' || key === '=' || input.code === 'NumpadAdd') return 'zoomIn';
  if (key === '-' || key === '_' || input.code === 'NumpadSubtract') return 'zoomOut';
  if (key === '0' || input.code === 'Numpad0') return 'resetZoom';
  if (!input.shift) return { x: 'cut', c: 'copy', v: 'paste', a: 'selectAll' }[key] || null;
  return null;
}

ipcMain.on('writer:bootstrap', event => { event.returnValue = trusted(event) ? { language, version: app.getVersion(), platform: process.platform } : {}; });
ipcMain.handle('writer:language', (event, value) => {
  if (!trusted(event) || !['zh', 'en'].includes(value)) return false;
  language = value;
  configureAppMenu();
  try { atomicWrite(settingsPath, { ...settings, language }); } catch { /* The UI also retains its preference. */ }
  return true;
});
ipcMain.handle('writer:app-settings', event => {
  if (!trusted(event)) return { error: text('当前窗口无权读取应用设置。', 'This window is not authorized to read app settings.'), code: 'untrusted-sender' };
  return { version: app.getVersion(), dataPath: path.join(userData, 'data'), ...windowState(), ...updater.info(updateOptions()) };
});
for (const [channel, action] of [['writer:install-update', installUpdate], ['writer:restart-after-update', restartAfterUpdate]]) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trusted(event)) return { error: text('当前窗口无权安装升级。', 'This window is not authorized to install updates.'), code: 'untrusted-sender' };
    if (args.length) return { error: text('请通过系统文件选择器选择升级包。', 'Choose the update package through the system file picker.'), code: 'update-invalid-request' };
    try { return await action(); } catch (error) { return updateFailure(error); }
  });
}
ipcMain.handle('writer:app-action', async (event, action) => {
  if (!trusted(event)) return { error: text('当前窗口无权执行应用操作。', 'This window is not authorized to perform app actions.'), code: 'untrusted-sender' };
  if (typeof action !== 'string' || !appActions.has(action)) return { error: text('不支持此应用操作。', 'This app action is not supported.'), code: 'invalid-app-action' };
  try { return await performAppAction(action); }
  catch (error) { return { error: error.code === 'open-folder-failed' ? error.message : text('无法完成此操作，请重试。', 'Could not complete this action. Try again.'), code: error.code === 'open-folder-failed' ? error.code : 'app-action-failed' }; }
});
ipcMain.handle('writer:open-book-folder', async (event, bookId) => {
  if (!trusted(event)) return { error: text('当前窗口无权打开作品文件夹。', 'This window is not authorized to open book folders.'), code: 'untrusted-sender' };
  try { return await openBookFolder(bookId); }
  catch (error) { return { error: error.message, code: error.code || 'open-folder-failed' }; }
});
ipcMain.handle('writer:print-book-pdf', async (event, options) => {
  if (!trusted(event)) return { error: text('当前窗口无权导出 PDF。', 'This window is not authorized to export PDF.'), code: 'untrusted-sender' };
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['title', 'paper'].includes(key)) || typeof options.title !== 'string' || [...options.title].length > 200 || !['a4', 'a5'].includes(options.paper)) return { error: text('PDF 排版选项不正确。', 'Invalid PDF layout options.'), code: 'pdf-invalid-request' };
  if (pdfBusy || closing || allowQuit || updateBusy) return { error: text('请等待当前操作完成。', 'Wait for the current operation to finish.'), code: 'pdf-busy' };
  pdfBusy = true;
  let temporary;
  try {
    // Print the authenticated app's prepared document only. The bridge accepts
    // no HTML, URL or destination path and never creates a privileged window.
    const prepared = await window.webContents.executeJavaScript("document.body.classList.contains('formatted-printing') && document.querySelectorAll('#formatted-print-root[data-writer-export=book] > .formatted-book').length === 1 && !!document.getElementById('formatted-print-styles')", true);
    if (prepared !== true) throw new Error('Missing prepared book');
    const name = options.title.replace(/[<>:\"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/, '').slice(0, 100) || 'WriterDesk';
    const selected = await dialog.showSaveDialog(window, { title: text('导出 PDF', 'Export PDF'), defaultPath: path.join(app.getPath('downloads'), name + '.pdf'), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (selected.canceled || !selected.filePath) return { canceled: true };
    if (!window || window.isDestroyed() || closing || allowQuit) throw new Error('App is closing');
    const buffer = await window.webContents.printToPDF({ pageSize: options.paper.toUpperCase(), preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false, generateTaggedPDF: true });
    if (!Buffer.isBuffer(buffer) || buffer.length < 5 || buffer.subarray(0, 5).toString() !== '%PDF-' || buffer.length > 200 * 1024 * 1024) throw new Error('Invalid PDF output');
    temporary = selected.filePath + '.' + randomBytes(8).toString('hex') + '.tmp';
    await fs.promises.writeFile(temporary, buffer, { flag: 'wx', mode: 0o600 });
    await fs.promises.rename(temporary, selected.filePath);
    temporary = undefined;
    return { saved: true };
  } catch { return { error: text('无法导出 PDF，请检查磁盘空间和文件权限后重试。', 'Could not export PDF. Check disk space and file permissions, then try again.'), code: 'pdf-export-failed' }; }
  finally { if (temporary) { try { await fs.promises.unlink(temporary); } catch { } } pdfBusy = false; }
});
ipcMain.on('writer:storage', (event, request) => {
  event.returnValue = { error: 'Storage unavailable' };
  if (!trusted(event) || !request || typeof request !== 'object') return;
  try {
    const { op, key, value } = request;
    if (op === 'length') { event.returnValue = { value: Object.keys(storage).length }; return; }
    if (op === 'key') { event.returnValue = { value: Number.isInteger(key) && key >= 0 ? Object.keys(storage)[key] ?? null : null }; return; }
    if (op === 'clear-book-content') {
      if (!validBookId(key) || typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Invalid purge receipt');
      const next = { ...storage }, prefix = 'yejian.draft.' + key + '.';
      for (const name of Object.keys(next)) {
        let draft = name.startsWith(prefix) && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(name.slice(prefix.length));
        if (!draft && name.startsWith(prefix)) { try { draft = JSON.parse(next[name])?.book?.id === key; } catch { } }
        if (draft || name === 'yejian.ai-chat.' + key + '.outline' || name === 'yejian.ai-chat.' + key + '.write') delete next[name];
      }
      next['yejian.chapter-purge.' + key] = value;
      atomicWrite(storagePath, next);
      for (const name of Object.keys(storage)) delete storage[name];
      Object.assign(storage, next);
      event.returnValue = { value: null }; return;
    }
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
  if (closing || allowQuit || updateBusy) return;
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
  stoppingService = true;
  try {
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      try {
        // The service watches this pipe. EOF lets it close its HTTP server and
        // SQLite connections cleanly on Windows as well as Unix.
        if (typeof child.stdin?.end === 'function') child.stdin.end();
        else child.kill('SIGTERM');
      } catch { child.kill('SIGTERM'); }
    });
  } finally { stoppingService = false; }
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
    title: title(), width: 1440, height: 960, minWidth: 780, minHeight: 600, show: false,
    ...(process.platform === 'darwin' ? { frame: true, titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 24 } } : { frame: false }), backgroundColor: '#ffffff',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false, webSecurity: true, navigateOnDragDrop: false, webviewTag: false, session: appSession }
  });
  window.setMenu(null);
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => {
    let isDocument = false;
    try { const value = new URL(url); isDocument = localURL(url) && ['/', '/index.html'].includes(value.pathname); } catch { }
    if (!isDocument) { event.preventDefault(); if (!localURL(url)) openExternal(url); }
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('before-input-event', (event, input) => {
    const action = keyboardAction(input);
    if (!action) return;
    event.preventDefault();
    performAppAction(action).catch(() => {});
  });
  window.webContents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => { if (mainFrame) saveReady = false; });
  appSession.on('will-download', (event, item, contents) => {
    if (contents !== window?.webContents || !(localURL(item.getURL()) || item.getURL().startsWith(`blob:${origin}/`))) { event.preventDefault(); return; }
    item.setSaveDialogOptions({ title: text('保存导出文件', 'Save exported file'), defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename())) });
    item.once('done', (_done, status) => { if (status === 'interrupted') dialog.showMessageBox(window, { type: 'error', title: title(), message: text('导出没有完成，请检查目标文件夹后重试。', 'Export did not complete. Check the destination folder and retry.') }); });
  });
  window.once('ready-to-show', () => window.show());
  window.on('close', event => { if (!allowQuit) { event.preventDefault(); requestClose(); } });
  window.on('closed', () => { window = null; });
  for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) window.on(event, publishWindowState);
  return window.loadURL(origin + '/').then(() => console.info('[writer-desk] Desktop window loaded; local storage service is ready.'));
}

function configureAppMenu() {
  if (process.platform !== 'darwin') { Menu.setApplicationMenu(null); return; }
  // macOS needs its system menu for native editing, hiding and full screen.
  // It lives in the OS menu bar; no traditional menu is added inside the app.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: title(), submenu: [
      { role: 'about', label: text('关于作家工作台', "About Writer's Desk") },
      { type: 'separator' },
      { role: 'hide', label: text('隐藏作家工作台', "Hide Writer's Desk") },
      { role: 'hideOthers', label: text('隐藏其他应用', 'Hide Others') },
      { role: 'unhide', label: text('显示全部', 'Show All') },
      { type: 'separator' },
      { label: text('退出作家工作台', "Quit Writer's Desk"), accelerator: 'Command+Q', click: () => { requestClose(); } }
    ] },
    { label: text('编辑', 'Edit'), submenu: [
      { role: 'undo', label: text('撤销', 'Undo') }, { role: 'redo', label: text('重做', 'Redo') },
      { type: 'separator' },
      { role: 'cut', label: text('剪切', 'Cut') }, { role: 'copy', label: text('复制', 'Copy') },
      { role: 'paste', label: text('粘贴', 'Paste') }, { role: 'selectAll', label: text('全选', 'Select All') }
    ] },
    { label: text('窗口', 'Window'), submenu: [
      { role: 'minimize', label: text('最小化', 'Minimize') },
      { role: 'togglefullscreen', label: text('切换全屏', 'Toggle Full Screen') },
      { type: 'separator' }, { role: 'front', label: text('前置全部窗口', 'Bring All to Front') }
    ] }
  ]));
}

if (!hasLock) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.on('activate', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.on('before-quit', event => {
    if (stoppingService) { event.preventDefault(); return; }
    if (!allowQuit && window) { event.preventDefault(); requestClose(); }
  });
  // Closing the renderer happens before the service's asynchronous EOF exit.
  // Each quit/restart path explicitly awaits stopService() before app.quit().
  app.on('window-all-closed', () => {});
  app.on('quit', () => { if (service && service.exitCode === null) service.kill(); });
  app.whenReady().then(async () => {
    try {
      configureAppMenu();
      await startService(); await createWindow();
      const activationArgument = process.argv.indexOf('--writer-activate-update');
      if (activationArgument !== -1) {
        try { await updater.activatePending(process.argv[activationArgument + 1], process.execPath, { ...updateOptions(), expectedVersion: app.getVersion() }); console.info('[writer-desk] Managed update activated after successful startup.'); }
        catch (error) { console.error('[writer-desk] Managed update activation failed (' + updateFailure(error).code + ').'); dialog.showMessageBox(window, { type: 'error', title: title(), message: updater.errorMessage(error, language) }); }
      }
      const folderArgument = process.argv.indexOf('--open-book-folder');
      if (folderArgument !== -1) {
        try { await openBookFolder(process.argv[folderArgument + 1]); console.info('[writer-desk] Requested book folder opened.'); }
        catch (error) { dialog.showMessageBox(window, { type: 'error', title: title(), message: error.message }); }
      }
    }
    catch (error) { allowQuit = true; await stopService(); dialog.showErrorBox(title(), text('无法启动本机写作服务。原作品库仍保留。\n\n', 'Could not start the local writing service. Existing work is preserved.\n\n') + error.message); app.quit(); }
  });
}
