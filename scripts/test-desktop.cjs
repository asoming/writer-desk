'use strict';
// Runtime contract checks: no browser automation and no personal database access.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-desktop-contract-'));

async function testService() {
  const token = 'test-token-' + Date.now();
  const command = process.env.WRITER_DESK_SERVICE || process.env.WRITER_DESK_PYTHON || 'python3';
  const args = process.env.WRITER_DESK_SERVICE ? [] : [path.join(root, 'server.py')];
  args.push('--desktop', '--port', '0', '--data-dir', path.join(temp, 'service'));
  const child = spawn(command, args, { env: { ...process.env, WRITER_DESKTOP_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const url = await new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('Service startup timed out')), 10000);
      child.once('error', reject); child.once('exit', code => reject(new Error('Early service exit ' + code)));
      child.stdout.on('data', bytes => {
        buffer += bytes;
        for (const line of buffer.split('\n')) if (line.startsWith('WRITER_READY ')) { clearTimeout(timer); resolve(JSON.parse(line.slice(13)).url); }
      });
    });
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal((await fetch(url + '/api/books')).status, 403);
    assert.equal((await fetch(url + '/', { headers: { 'X-Writer-Desktop': 'wrong' } })).status, 403);
    assert.equal((await fetch(url + '/', { headers: { 'X-Writer-Desktop': token } })).status, 200);
    const headers = { 'X-Writer-Desktop': token, 'X-Writer-Client': '1', 'Content-Type': 'application/json' };
    const response = await fetch(url + '/api/books', { method: 'POST', headers, body: JSON.stringify({ title: 'Desktop lifecycle fixture', kind: 'long' }) });
    assert.equal(response.status, 201);
    const created = await response.json();
    assert.equal((await fetch(url + '/api/books/' + created.book.id, { headers })).status, 200);
    const folderURL = url + '/api/books/' + encodeURIComponent(created.book.id) + '/folder';
    const preparedResponse = await fetch(folderURL, { method: 'POST', headers, body: '{}' });
    assert.equal(preparedResponse.status, 200);
    const prepared = await preparedResponse.json();
    const expectedFolder = path.join(fs.realpathSync(path.join(temp, 'service')), 'books', 'book-' + createHash('sha256').update(created.book.id).digest('hex'));
    assert.equal(prepared.folder, expectedFolder); assert.equal(prepared.revision, created.revision);
    const folderBackup = JSON.parse(fs.readFileSync(path.join(prepared.folder, '作品.yejian.json'), 'utf8'));
    assert.equal(folderBackup.book.id, created.book.id);
    assert.equal((await fetch(folderURL, { method: 'POST', headers, body: JSON.stringify({ path: temp }) })).status, 400);
    const manuscript = path.join(prepared.folder, '正文.txt');
    fs.writeFileSync(manuscript, 'Private external edit that must be preserved');
    const conflict = await fetch(folderURL, { method: 'POST', headers, body: '{}' });
    assert.equal(conflict.status, 409); assert.equal((await conflict.json()).code, 'FOLDER_CONFLICT');
    assert.equal(fs.readFileSync(manuscript, 'utf8'), 'Private external edit that must be preserved');
    assert.equal((await fetch(url + '/api/books', { method: 'POST', headers: { ...headers, Origin: 'https://example.org' }, body: '{}' })).status, 403);
    assert.equal((await fetch(url + '/api/books', { method: 'POST', headers: { 'X-Writer-Client': '1', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    const stopped = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Service remained after parent pipe closed')), 3000);
      child.once('exit', code => { clearTimeout(timeout); assert.equal(code, 0); resolve(); });
    });
    child.stdin.end(); await stopped;
    console.log('PASS: random loopback port, desktop authentication, origin checks, storage and book-folder API with conflict preservation');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill(); await stopped;
    }
  }
}

async function testMainContract() {
  const app = new EventEmitter();
  const ipcMain = new EventEmitter();
  ipcMain.handle = (name, callback) => { ipcMain[name] = callback; };
  const userData = path.join(temp, 'main');
  app.getPath = name => name === 'downloads' ? temp : userData;
  app.setPath = () => {}; app.setName = () => {}; app.getVersion = () => require(path.join(root, 'package.json')).version;
  app.requestSingleInstanceLock = () => true; app.whenReady = () => Promise.resolve();
  app.quit = () => {
    const event = { preventDefault() { this.prevented = true; } }; app.emit('before-quit', event);
    assert.equal(event.prevented, undefined, 'The final explicit quit must not be blocked');
    assert.notEqual(child?.exitCode, null, 'Electron must wait for the service exit'); app.quitCalled = true; app.emit('quit');
  }; app.isPackaged = false;
  let win, child, headersHandler, requestHandler, lastSent, folderReply, finishService, pipeClosed = 0, shellError = '', shellThrows = false;
  const folderRequests = [], openedFolders = [], sentEvents = [], edits = [], dialogs = [];
  const httpFake = { request: (url, options, callback) => {
    const request = new EventEmitter();
    request.destroy = error => queueMicrotask(() => request.emit('error', error));
    request.end = body => {
      folderRequests.push({ url, options, body });
      queueMicrotask(() => {
        const response = new EventEmitter(); response.statusCode = folderReply.status;
        callback(response);
        response.emit('data', Buffer.from(typeof folderReply.body === 'string' ? folderReply.body : JSON.stringify(folderReply.body)));
        response.emit('end');
      });
    };
    return request;
  } };
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super(); win = this; this.options = options;
      this.zoom = 1; this.fullscreen = false; this.maximized = false; this.minimized = false;
      this.webContents = new EventEmitter(); this.webContents.mainFrame = { url: '' };
      this.webContents.setWindowOpenHandler = callback => { this.popup = callback; };
      this.webContents.send = (channel, token) => { lastSent = { channel, token }; sentEvents.push(lastSent); };
      this.webContents.getZoomFactor = () => this.zoom;
      this.webContents.setZoomFactor = value => { this.zoom = value; };
      for (const action of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']) this.webContents[action] = () => edits.push(action);
    }
    isDestroyed() { return !!this.destroyed; }
    loadURL(url) { this.url = url; this.webContents.mainFrame.url = url; return Promise.resolve(); }
    destroy() { this.destroyed = true; this.emit('closed'); app.emit('window-all-closed'); }
    show() {} focus() {} isMinimized() { return this.minimized; }
    minimize() { this.minimized = true; }
    isMaximized() { return this.maximized; }
    maximize() { this.maximized = true; this.emit('maximize'); }
    unmaximize() { this.maximized = false; this.emit('unmaximize'); }
    isFullScreen() { return this.fullscreen; }
    setFullScreen(value) { this.fullscreen = value; this.emit(value ? 'enter-full-screen' : 'leave-full-screen'); }
    setMenu(value) { this.menu = value; }
    setMenuBarVisibility(value) { this.menuBarVisible = value; }
  }
  const fakeSession = new EventEmitter();
  fakeSession.webRequest = { onBeforeRequest: callback => { requestHandler = callback; }, onBeforeSendHeaders: callback => { headersHandler = callback; } };
  fakeSession.setPermissionRequestHandler = () => {}; fakeSession.setPermissionCheckHandler = () => {};
  const electron = { app, ipcMain, BrowserWindow: FakeWindow, session: { fromPartition: () => fakeSession }, Menu: { buildFromTemplate: () => assert.fail('Native menus must not be rebuilt'), setApplicationMenu: value => { app.menu = value; } }, dialog: { showErrorBox: () => assert.fail('unexpected startup failure'), showMessageBox: async (_window, options) => { dialogs.push(options); return { response: 0 }; } }, shell: { openExternal: async () => {}, openPath: async folder => { openedFolders.push(folder); if (shellThrows) throw new Error('private OS failure'); return shellError; } } };
  const spawnFake = () => {
    child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null;
    child.kill = () => assert.fail('Normal close must use the EOF shutdown');
    child.stdin = { end() { pipeClosed++; finishService = () => { child.exitCode = 0; child.emit('exit', 0); }; } };
    queueMicrotask(() => child.stdout.emit('data', Buffer.from('WRITER_READY {"url":"http://127.0.0.1:38123"}\n')));
    return child;
  };
  const context = { require: name => name === 'electron' ? electron : name === 'node:child_process' ? { spawn: spawnFake } : name === 'node:http' ? httpFake : name.startsWith('./') ? require(path.join(root, 'desktop', name)) : require(name), __dirname: path.join(root, 'desktop'), process: { ...process, env: { ...process.env, WRITER_DESK_USER_DATA: userData, WRITER_DESK_INSTALL_ROOT: path.join(temp, 'managed-installation'), WRITER_DESK_APPLICATIONS_DIR: path.join(temp, 'applications') } }, console, setTimeout, clearTimeout, URL, Buffer };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(win.options.webPreferences.sandbox, true);
  assert.equal(win.options.webPreferences.contextIsolation, true);
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  assert.equal(win.options.webPreferences.webviewTag, false);
  assert.equal(win.options.frame, false);
  assert.equal(app.menu, null); assert.equal(win.menu, null); assert.equal(win.menuBarVisible, false);
  let result;
  requestHandler({ url: 'https://example.org/' }, value => { result = value; }); assert.equal(result.cancel, true);
  requestHandler({ url: win.url + 'api/books' }, value => { result = value; }); assert.equal(result.cancel, false);
  headersHandler({ url: win.url + 'api/books', requestHeaders: {} }, value => { result = value; }); assert.equal(result.requestHeaders['X-Writer-Desktop'].length, 64);
  const authenticatedToken = result.requestHeaders['X-Writer-Desktop'];
  headersHandler({ url: 'https://example.org/', requestHeaders: {} }, value => { result = value; }); assert.equal(result.requestHeaders['X-Writer-Desktop'], undefined);
  const event = () => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  // Network operations accept no renderer-controlled URLs, paths or versions.
  // Invalid inputs must be rejected before a request or save-close handshake.
  for (const name of ['info', 'check', 'download', 'cancel', 'install']) {
    const callback = ipcMain['writer:network-' + name]; assert.equal(typeof callback, 'function');
    assert.ok((await callback({ sender: {}, senderFrame: {} })).error);
    assert.ok((await callback(event(), '/renderer/path-or-url')).error);
  }
  assert.ok((await ipcMain['writer:network-settings'](event(), { endpoint: 'https://evil.test' })).error);
  const networkInfo = await ipcMain['writer:network-info'](event());
  assert.equal(networkInfo.currentVersion, app.getVersion()); assert.equal(networkInfo.settings.autoDownload, false);
  assert.ok(!JSON.stringify(networkInfo).includes(userData));
  assert.equal((await ipcMain['writer:network-cancel'](event())).cancelled, false);

  let e = event(); ipcMain.emit('writer:storage', e, { op: 'set', key: 'yejian.draft.fixture', value: 'saved draft' }); assert.equal(e.returnValue.error, undefined);
  e = event(); ipcMain.emit('writer:storage', e, { op: 'get', key: 'yejian.draft.fixture' }); assert.equal(e.returnValue.value, 'saved draft');
  e = event(); ipcMain.emit('writer:storage', e, { op: 'length' }); assert.equal(e.returnValue.value, 1);
  e = event(); ipcMain.emit('writer:storage', e, { op: 'set', key: '../../escape', value: 'x' }); assert.match(e.returnValue.error, /Invalid/);
  e = { sender: {}, senderFrame: {} }; ipcMain.emit('writer:storage', e, { op: 'get', key: 'yejian.draft.fixture' }); assert.equal(e.returnValue.value, undefined);
  const draftKey = 'yejian.draft.purge-fixture.11111111-1111-4111-8111-111111111111';
  for (const key of [draftKey, 'yejian.ai-chat.purge-fixture.write', 'yejian.draft.purge-fixture.other.11111111-1111-4111-8111-111111111111']) {
    e = event(); ipcMain.emit('writer:storage', e, { op: 'set', key, value: 'chapter text' }); assert.equal(e.returnValue.error, undefined);
  }
  e = event(); ipcMain.emit('writer:storage', e, { op: 'clear-book-content', key: 'purge-fixture', value: '2026-10-12T08:00:00Z' }); assert.equal(e.returnValue.error, undefined);
  for (const key of [draftKey, 'yejian.ai-chat.purge-fixture.write']) { e = event(); ipcMain.emit('writer:storage', e, { op: 'get', key }); assert.equal(e.returnValue.value, null); }
  e = event(); ipcMain.emit('writer:storage', e, { op: 'get', key: 'yejian.draft.purge-fixture.other.11111111-1111-4111-8111-111111111111' }); assert.equal(e.returnValue.value, 'chapter text');
  const stored = JSON.parse(fs.readFileSync(path.join(userData, 'client-storage.json'), 'utf8'));
  assert.equal(stored[draftKey], undefined); assert.equal(stored['yejian.chapter-purge.purge-fixture'], '2026-10-12T08:00:00Z');

  const openFolder = (id, sender = event()) => ipcMain['writer:open-book-folder'](sender, id);
  const bookId = 'fixture/独立作品';
  const bookFolder = path.join(userData, 'data', 'books', 'book-' + createHash('sha256').update(bookId).digest('hex'));
  fs.mkdirSync(bookFolder, { recursive: true });
  folderReply = { status: 200, body: { folder: bookFolder, revision: 7 } };
  assert.equal((await openFolder(bookId, { sender: {}, senderFrame: {} })).code, 'untrusted-sender');
  assert.equal((await openFolder(bookId, { sender: win.webContents, senderFrame: { url: win.url } })).code, 'untrusted-sender');
  for (const invalid of [null, {}, '', '..', 'x'.repeat(101), '\0', '\ud800']) assert.equal((await openFolder(invalid)).code, 'invalid-book-id');
  assert.equal(folderRequests.length, 0);
  const opened = await openFolder(bookId);
  assert.equal(opened.folder, bookFolder); assert.equal(opened.revision, 7);
  assert.equal(openedFolders[0], bookFolder);
  assert.equal(folderRequests[0].url.href, win.url + 'api/books/' + encodeURIComponent(bookId) + '/folder');
  assert.equal(folderRequests[0].options.method, 'POST'); assert.equal(folderRequests[0].body, '{}');
  assert.equal(folderRequests[0].options.headers['X-Writer-Desktop'], authenticatedToken);
  assert.equal(folderRequests[0].options.headers['X-Writer-Desktop'].length, 64);
  assert.equal(folderRequests[0].options.headers['X-Writer-Client'], '1');
  assert.equal(folderRequests[0].options.headers.Origin, new URL(win.url).origin);
  for (const folder of [temp, path.join(userData, 'data', 'books'), path.join(bookFolder, '..', 'other'), bookFolder + '-other']) {
    folderReply.body = { folder, revision: 7 };
    assert.equal((await openFolder(bookId)).code, 'unsafe-folder');
  }
  folderReply.body = { folder: bookFolder, revision: 7 };
  fs.rmdirSync(bookFolder); fs.symlinkSync(temp, bookFolder, 'dir');
  assert.equal((await openFolder(bookId)).code, 'unsafe-folder');
  fs.unlinkSync(bookFolder); fs.mkdirSync(bookFolder);
  const booksRoot = path.dirname(bookFolder), movedRoot = booksRoot + '-real';
  fs.renameSync(booksRoot, movedRoot); fs.symlinkSync(movedRoot, booksRoot, 'dir');
  assert.equal((await openFolder(bookId)).code, 'unsafe-folder');
  fs.unlinkSync(booksRoot); fs.renameSync(movedRoot, booksRoot);
  folderReply = { status: 302, body: { folder: bookFolder, revision: 7 } };
  assert.equal((await openFolder(bookId)).code, 'folder-prepare-failed');
  folderReply = { status: 404, body: {} }; assert.equal((await openFolder(bookId)).code, 'book-unavailable');
  const folderFailures = [
    ['FOLDER_CONFLICT', 'folder-conflict', /移走或改名/, /Move or rename/],
    ['FOLDER_UNSAFE', 'unsafe-folder', /符号链接/, /symbolic link/],
    ['FOLDER_FAILURE', 'folder-sync-failed', /磁盘空间和目录权限/, /disk space and folder permissions/],
    ['FOLDER_REQUEST', 'invalid-book-id', /只接受作品编号/, /only a book ID/],
    ['FOLDER_UNSUPPORTED', 'folder-unsupported', /当前系统不支持/, /does not support/]
  ];
  for (const [code, expectedCode, chinese] of folderFailures) {
    folderReply = { status: 409, body: { code, error: 'raw private server exception' } };
    const failure = await openFolder(bookId);
    assert.equal(failure.code, expectedCode); assert.match(failure.error, chinese);
    assert.doesNotMatch(failure.error, /raw private/);
  }
  folderReply = { status: 500, body: { code: 'UNKNOWN', error: 'raw private server exception' } };
  assert.equal((await openFolder(bookId)).code, 'folder-prepare-failed');
  assert.doesNotMatch((await openFolder(bookId)).error, /raw private/);
  folderReply = { status: 500, body: 'raw private non-JSON exception' };
  assert.equal((await openFolder(bookId)).code, 'folder-prepare-failed');
  folderReply = { status: 200, body: 'not json' }; assert.equal((await openFolder(bookId)).code, 'invalid-response');
  folderReply = { status: 200, body: { folder: bookFolder, revision: 0 } }; assert.equal((await openFolder(bookId)).code, 'invalid-response');
  folderReply = { status: 200, body: { folder: bookFolder, revision: 7 } };
  assert.equal(openedFolders.length, 1);
  shellError = 'no file manager';
  assert.match((await openFolder(bookId)).error, /文件管理器/);
  assert.equal(await ipcMain['writer:language'](event(), 'en'), true);
  assert.match((await openFolder(bookId)).error, /system file manager/); shellError = '';
  for (const [code, expectedCode, _chinese, english] of folderFailures) {
    folderReply = { status: 409, body: { code, error: 'raw private server exception' } };
    const failure = await openFolder(bookId);
    assert.equal(failure.code, expectedCode); assert.match(failure.error, english);
    assert.doesNotMatch(failure.error, /raw private/);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')).language, 'en');
  assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'client-storage.json'), 'utf8'))['yejian.draft.fixture'], 'saved draft');
  assert.equal(win.popup({ url: 'file:///etc/passwd' }).action, 'deny');
  const navigate = { preventDefault() { this.prevented = true; } };
  win.webContents.emit('will-navigate', navigate, 'file:///etc/passwd'); assert.equal(navigate.prevented, true);
  const appSettings = sender => ipcMain['writer:app-settings'](sender || event());
  const action = (name, sender) => ipcMain['writer:app-action'](sender || event(), name);
  const initialSettings = appSettings();
  assert.equal(initialSettings.version, require(path.join(root, 'package.json')).version); assert.equal(initialSettings.dataPath, path.join(userData, 'data'));
  assert.equal(initialSettings.zoomFactor, 1); assert.equal(initialSettings.fullscreen, false); assert.equal(initialSettings.maximized, false);
  const initialOpened = openedFolders.length;
  for (const sender of [{ sender: {}, senderFrame: {} }, { sender: win.webContents, senderFrame: { url: win.url } }]) {
    assert.equal(appSettings(sender).code, 'untrusted-sender');
    for (const name of ['openDataFolder', 'quit', 'close', 'copy', 'toggleMaximize', 'minimize', 'zoomIn']) assert.equal((await action(name, sender)).code, 'untrusted-sender');
  }
  const localFrameURL = win.webContents.mainFrame.url;
  win.webContents.mainFrame.url = 'https://example.org/';
  assert.equal(appSettings().code, 'untrusted-sender'); assert.equal((await action('openDataFolder')).code, 'untrusted-sender');
  win.webContents.mainFrame.url = localFrameURL;
  assert.equal(openedFolders.length, initialOpened); assert.equal(edits.length, 0); assert.equal(win.minimized, false); assert.equal(app.quitCalled, undefined);
  for (const value of [undefined, null, {}, [], 7, 'constructor', '__proto__', 'destroy', 'openExternal', '/tmp']) assert.equal((await action(value)).code, 'invalid-app-action');
  for (const name of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']) await action(name);
  assert.deepEqual(edits, ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']);
  await action('zoomIn'); assert.equal(win.zoom, 1.1);
  for (let i = 0; i < 20; i++) await action('zoomIn'); assert.equal(win.zoom, 2);
  for (let i = 0; i < 30; i++) await action('zoomOut'); assert.equal(win.zoom, 0.5);
  assert.equal((await action('resetZoom')).zoomFactor, 1);
  assert.equal((await action('toggleMaximize')).maximized, true); assert.equal((await action('toggleMaximize')).maximized, false);
  assert.equal((await action('toggleFullscreen')).fullscreen, true); assert.equal((await action('toggleFullscreen')).fullscreen, false);
  assert.deepEqual(sentEvents.filter(value => value.channel === 'writer:window-state').map(value => JSON.parse(JSON.stringify(value.token))), [
    { fullscreen: false, maximized: true }, { fullscreen: false, maximized: false }, { fullscreen: true, maximized: false }, { fullscreen: false, maximized: false }
  ].map(value => ({ ...value, immersiveWriting: false, immersiveExitRequested: false, priorWindowState: null })));
  await action('minimize'); assert.equal(win.minimized, true);
  await action('openDataFolder'); assert.equal(openedFolders.at(-1), path.join(userData, 'data'));
  shellError = 'Private OS command details';
  assert.match((await action('openDataFolder')).error, /system file manager/);
  assert.doesNotMatch((await action('openDataFolder')).error, /Private OS/);
  await ipcMain['writer:language'](event(), 'zh');
  assert.match((await action('openDataFolder')).error, /文件管理器/);
  shellError = ''; shellThrows = true;
  assert.equal((await action('openDataFolder')).code, 'open-folder-failed'); shellThrows = false;
  assert.equal(app.menu, null); assert.equal(dialogs.length, 0);
  const keyboard = input => {
    const keyboardEvent = { preventDefault() { this.prevented = true; } };
    win.webContents.emit('before-input-event', keyboardEvent, { type: 'keyDown', key: '', control: false, meta: false, alt: false, shift: false, ...input });
    return keyboardEvent;
  };
  for (const [input, expected] of [
    [{ key: 'z', control: true }, 'undo'], [{ key: 'z', meta: true, shift: true }, 'redo'], [{ key: 'y', control: true }, 'redo'],
    [{ key: 'x', control: true }, 'cut'], [{ key: 'c', meta: true }, 'copy'], [{ key: 'v', control: true }, 'paste'], [{ key: 'a', meta: true }, 'selectAll']
  ]) { assert.equal(keyboard(input).prevented, true); assert.equal(edits.at(-1), expected); }
  assert.equal(keyboard({ key: '=', control: true }).prevented, true); assert.equal(win.zoom, 1.1);
  assert.equal(keyboard({ key: '-', meta: true }).prevented, true); assert.equal(win.zoom, 1);
  keyboard({ key: '+', control: true }); keyboard({ key: '0', control: true }); assert.equal(win.zoom, 1);
  assert.equal(keyboard({ key: 'F11' }).prevented, true); assert.equal(win.fullscreen, true);
  keyboard({ key: 'F11' }); assert.equal(win.fullscreen, false);
  const editsBeforeComposition = edits.length;
  for (const input of [{ key: 'Alt', alt: true }, { key: 'c' }, { key: 's', control: true }, { key: 'z', control: true, type: 'keyUp' }, { key: 'x', control: true, alt: true }, { key: 'z', control: true, isComposing: true }, { key: 'v', meta: true, isComposing: true }]) assert.equal(keyboard(input).prevented, undefined);
  assert.equal(edits.length, editsBeforeComposition);
  assert.equal(app.menu, null); assert.equal(win.menuBarVisible, false);
  ipcMain.emit('writer:save-ready', event());
  const close = { preventDefault() { this.prevented = true; } };
  win.emit('close', close); assert.equal(close.prevented, true); assert.equal(lastSent.channel, 'writer:before-close'); assert.equal(win.destroyed, undefined);
  ipcMain.emit('writer:save-result', event(), { token: lastSent.token, saved: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(win.destroyed, undefined); assert.equal(child.exitCode, null);
  for (const name of ['quit', 'close']) {
    const pending = action(name);
    assert.equal(lastSent.channel, 'writer:before-close'); assert.equal(win.destroyed, undefined);
    ipcMain.emit('writer:save-result', { sender: {}, senderFrame: {} }, { token: lastSent.token, saved: true });
    assert.equal(win.destroyed, undefined);
    ipcMain.emit('writer:save-result', event(), { token: lastSent.token, saved: false });
    const retainedState = await pending;
    assert.equal(retainedState.zoomFactor, 1); assert.equal(retainedState.fullscreen, false); assert.equal(retainedState.maximized, false);
    assert.equal(win.destroyed, undefined); assert.equal(child.exitCode, null); assert.equal(app.quitCalled, undefined);
  }
  assert.equal(keyboard({ key: 'F4', alt: true }).prevented, true);
  ipcMain.emit('writer:save-result', event(), { token: lastSent.token, saved: false });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(win.destroyed, undefined);
  const finalClose = action('close');
  ipcMain.emit('writer:save-result', event(), { token: 'wrong', saved: true }); assert.equal(win.destroyed, undefined);
  ipcMain.emit('writer:save-result', event(), { token: lastSent.token, saved: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(win.destroyed, true); assert.equal(pipeClosed, 1); assert.equal(child.exitCode, null); assert.equal(app.quitCalled, undefined);
  const pendingQuit = { preventDefault() { this.prevented = true; } }; app.emit('before-quit', pendingQuit); assert.equal(pendingQuit.prevented, true);
  finishService();
  const closedState = await finalClose; assert.equal(Object.keys(closedState).length, 0);
  assert.equal(win.destroyed, true); assert.equal(child.exitCode, 0); assert.equal(app.quitCalled, true);
  console.log('PASS: authenticated book-folder bridge, trusted frame/ID checks, path and symlink isolation, localized file-manager errors');
  console.log('PASS: sandbox, constrained IPC/storage/network/navigation, close-save handshake and child cleanup');
  console.log('PASS: frameless/menu-free window, trusted settings/action whitelist, edit/zoom/window shortcuts and state, localized data-folder failures, protected settings/window exit');
}

async function testPreloadContract() {
  const ipcRenderer = new EventEmitter(); let bridge, invoked;
  ipcRenderer.sendSync = () => ({ language: 'zh', version: 'test' });
  ipcRenderer.send = () => {};
  ipcRenderer.invoke = async (channel, value) => { invoked = { channel, value }; return { folder: '/fixture', revision: 2 }; };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'desktop/preload.cjs'), 'utf8'), { require: () => ({ ipcRenderer, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } } }) });
  assert.equal((await bridge.openBookFolder('book-fixture')).revision, 2);
  assert.deepEqual(invoked, { channel: 'writer:open-book-folder', value: 'book-fixture' });
  ipcRenderer.invoke = async () => ({ error: '无法打开作品文件夹', code: 'open-folder-failed' });
  await assert.rejects(bridge.openBookFolder('book-fixture'), error => error.message === '无法打开作品文件夹' && error.code === 'open-folder-failed');
  const settings = { version: '0.4.0', dataPath: '/fixture/data', zoomFactor: 1, fullscreen: false, maximized: true, updateSupported: true, installPath: '/fixture/app', installedVersion: '0.4.0', pendingVersion: '0.4.1' };
  ipcRenderer.invoke = async (channel, ...args) => { invoked = { channel, args }; return settings; };
  assert.deepEqual(JSON.parse(JSON.stringify(await bridge.getAppSettings())), settings);
  assert.deepEqual(invoked, { channel: 'writer:app-settings', args: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(await bridge.performAppAction('zoomIn'))), { zoomFactor: 1, fullscreen: false, maximized: true });
  assert.deepEqual(invoked, { channel: 'writer:app-action', args: ['zoomIn'] });
  await bridge.installUpdate('/arbitrary/renderer/path');
  assert.deepEqual(invoked, { channel: 'writer:install-update', args: [] });
  await bridge.restartAfterUpdate('/arbitrary/renderer/path');
  assert.deepEqual(invoked, { channel: 'writer:restart-after-update', args: [] });
  for (const [method, channel] of [['networkInfo','info'], ['networkCheck','check'], ['networkDownload','download'], ['networkCancel','cancel'], ['networkInstall','install']]) {
    await bridge[method]('/arbitrary/renderer/path');
    assert.deepEqual(invoked, { channel: 'writer:network-' + channel, args: [] });
  }
  await bridge.networkSettings({ autoCheck: false, autoDownload: false, includePrerelease: true });
  assert.deepEqual(JSON.parse(JSON.stringify(invoked)), { channel: 'writer:network-settings', args: [{ autoCheck: false, autoDownload: false, includePrerelease: true }] });
  const updateEvents = [], beforeUpdates = ipcRenderer.listenerCount('writer:network-update-state');
  const stopUpdates = bridge.onNetworkUpdate(value => updateEvents.push(value));
  for (const value of [null, [], {}, { phase: 1 }]) ipcRenderer.emit('writer:network-update-state', {}, value);
  assert.equal(updateEvents.length, 0);
  ipcRenderer.emit('writer:network-update-state', {}, { phase: 'downloading', received: 2, total: 10 });
  assert.equal(updateEvents.length, 1); stopUpdates(); assert.equal(ipcRenderer.listenerCount('writer:network-update-state'), beforeUpdates);

  ipcRenderer.invoke = async () => ({});
  assert.equal(Object.keys(await bridge.performAppAction('close')).length, 0);
  await assert.rejects(bridge.getAppSettings(), error => error.code === 'invalid-response');
  for (const malformed of [undefined, null, [], { zoomFactor: NaN }, { fullscreen: 'yes' }, { maximized: 1 }]) {
    ipcRenderer.invoke = async () => malformed;
    await assert.rejects(bridge.performAppAction('toggleMaximize'), error => error.code === 'invalid-response');
  }
  ipcRenderer.invoke = async () => ({ error: '当前窗口无权执行应用操作。', code: 'untrusted-sender' });
  await assert.rejects(bridge.performAppAction('quit'), error => error.code === 'untrusted-sender' && /无权/.test(error.message));
  assert.throws(() => bridge.onWindowState(null), /callback/);
  const observed = [];
  const beforeListeners = ipcRenderer.listenerCount('writer:window-state');
  const unsubscribe = bridge.onWindowState(state => observed.push(state));
  assert.equal(ipcRenderer.listenerCount('writer:window-state'), beforeListeners + 1);
  for (const malformed of [null, [], {}, { fullscreen: true }, { fullscreen: 'false', maximized: true }, { fullscreen: false, maximized: 0 }]) ipcRenderer.emit('writer:window-state', { dangerous: true }, malformed);
  assert.equal(observed.length, 0);
  ipcRenderer.emit('writer:window-state', { dangerous: true }, { fullscreen: true, maximized: false, secret: 'not exposed' });
  assert.deepEqual(JSON.parse(JSON.stringify(observed)), [{ fullscreen: true, maximized: false }]);
  unsubscribe(); unsubscribe();
  assert.equal(ipcRenderer.listenerCount('writer:window-state'), beforeListeners);
  ipcRenderer.emit('writer:window-state', {}, { fullscreen: false, maximized: false });
  assert.equal(observed.length, 1);
  assert.equal(bridge.readClipboard, undefined); assert.equal(bridge.openPath, undefined);
  console.log('PASS: preload exposes only a book-ID operation and propagates localized failures');
  console.log('PASS: settings/action preload responses, narrow state subscription validation, event isolation and unsubscribe');
}

async function testMigration() {
  const legacy = path.join(temp, 'legacy');
  fs.mkdirSync(legacy);
  const script = `import importlib.util,sys,json\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('writer_test',sys.argv[1]); m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nm.DB_PATH=Path(sys.argv[2])/'writer.sqlite3';m.initialize()\nc=m.connect();c.execute('PRAGMA journal_mode=WAL');c.execute('PRAGMA wal_autocheckpoint=0');m.insert_book(c,m.new_book('Uncheckpointed migration fixture'));c.commit();print('READY',flush=True);sys.stdin.read();c.close()\n`;
  const holder = spawn(process.env.WRITER_DESK_PYTHON || 'python3', ['-c', script, path.join(root, 'server.py'), legacy], { stdio: ['pipe', 'pipe', 'pipe'] });
  let service;
  try {
    await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('error', reject); holder.once('exit', code => reject(new Error('Fixture failed ' + code))); });
    assert.equal(fs.existsSync(path.join(legacy, 'writer.sqlite3-wal')), true);
    const args = [path.join(root, 'server.py'), '--desktop', '--port', '0', '--data-dir', path.join(temp, 'migrated'), '--legacy-data-dir', legacy];
    service = spawn(process.env.WRITER_DESK_PYTHON || 'python3', args, { env: { ...process.env, WRITER_DESKTOP_TOKEN: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const url = await new Promise((resolve, reject) => { let buffer = ''; service.stdout.on('data', bytes => { buffer += bytes; for (const line of buffer.split('\n')) if (line.startsWith('WRITER_READY ')) resolve(JSON.parse(line.slice(13)).url); }); service.once('error', reject); service.once('exit', code => reject(new Error('Migration service failed ' + code))); });
    const result = await (await fetch(url + '/api/books')).json();
    assert.equal(result.books.some(book => book.title === 'Uncheckpointed migration fixture'), true);
    assert.equal(fs.existsSync(path.join(legacy, 'writer.sqlite3')), true);
    console.log('PASS: first-launch SQLite migration includes committed WAL and preserves source');
  } finally {
    for (const child of [service, holder]) if (child && child.exitCode === null && child.signalCode === null) { const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill(); await stopped; }
  }
}

(async () => { try { await testService(); await testMainContract(); await testPreloadContract(); await testMigration(); } finally { fs.rmSync(temp, { recursive: true, force: true }); } })().catch(error => { console.error(error); process.exitCode = 1; });
