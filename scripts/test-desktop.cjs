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
  app.setPath = () => {}; app.setName = () => {}; app.getVersion = () => 'test';
  app.requestSingleInstanceLock = () => true; app.whenReady = () => Promise.resolve();
  app.quit = () => { app.quitCalled = true; }; app.isPackaged = false;
  let win, child, headersHandler, requestHandler, lastSent, folderReply, shellError = '';
  const folderRequests = [], openedFolders = [];
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
      this.webContents = new EventEmitter(); this.webContents.mainFrame = { url: '' };
      this.webContents.setWindowOpenHandler = callback => { this.popup = callback; };
      this.webContents.send = (channel, token) => { lastSent = { channel, token }; };
    }
    isDestroyed() { return !!this.destroyed; }
    loadURL(url) { this.url = url; this.webContents.mainFrame.url = url; return Promise.resolve(); }
    destroy() { this.destroyed = true; this.emit('closed'); }
    show() {} focus() {} isMinimized() { return false; }
  }
  const fakeSession = new EventEmitter();
  fakeSession.webRequest = { onBeforeRequest: callback => { requestHandler = callback; }, onBeforeSendHeaders: callback => { headersHandler = callback; } };
  fakeSession.setPermissionRequestHandler = () => {}; fakeSession.setPermissionCheckHandler = () => {};
  const electron = { app, ipcMain, BrowserWindow: FakeWindow, session: { fromPartition: () => fakeSession }, Menu: { buildFromTemplate: value => value, setApplicationMenu: value => { app.menu = value; } }, dialog: { showErrorBox: () => assert.fail('unexpected startup failure'), showMessageBox: async () => ({ response: 0 }) }, shell: { openExternal: async () => {}, openPath: async folder => { openedFolders.push(folder); return shellError; } } };
  const spawnFake = () => {
    child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null;
    child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit('exit', 0)); };
    queueMicrotask(() => child.stdout.emit('data', Buffer.from('WRITER_READY {"url":"http://127.0.0.1:38123"}\n')));
    return child;
  };
  const context = { require: name => name === 'electron' ? electron : name === 'node:child_process' ? { spawn: spawnFake } : name === 'node:http' ? httpFake : require(name), __dirname: path.join(root, 'desktop'), process: { ...process, env: { ...process.env, WRITER_DESK_USER_DATA: userData } }, console, setTimeout, clearTimeout, URL, Buffer };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(win.options.webPreferences.sandbox, true);
  assert.equal(win.options.webPreferences.contextIsolation, true);
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  assert.equal(win.options.webPreferences.webviewTag, false);
  let result;
  requestHandler({ url: 'https://example.org/' }, value => { result = value; }); assert.equal(result.cancel, true);
  requestHandler({ url: win.url + 'api/books' }, value => { result = value; }); assert.equal(result.cancel, false);
  headersHandler({ url: win.url + 'api/books', requestHeaders: {} }, value => { result = value; }); assert.equal(result.requestHeaders['X-Writer-Desktop'].length, 64);
  const authenticatedToken = result.requestHeaders['X-Writer-Desktop'];
  headersHandler({ url: 'https://example.org/', requestHeaders: {} }, value => { result = value; }); assert.equal(result.requestHeaders['X-Writer-Desktop'], undefined);
  const event = () => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  let e = event(); ipcMain.emit('writer:storage', e, { op: 'set', key: 'yejian.draft.fixture', value: 'saved draft' }); assert.equal(e.returnValue.error, undefined);
  e = event(); ipcMain.emit('writer:storage', e, { op: 'get', key: 'yejian.draft.fixture' }); assert.equal(e.returnValue.value, 'saved draft');
  e = event(); ipcMain.emit('writer:storage', e, { op: 'length' }); assert.equal(e.returnValue.value, 1);
  e = event(); ipcMain.emit('writer:storage', e, { op: 'set', key: '../../escape', value: 'x' }); assert.match(e.returnValue.error, /Invalid/);
  e = { sender: {}, senderFrame: {} }; ipcMain.emit('writer:storage', e, { op: 'get', key: 'yejian.draft.fixture' }); assert.equal(e.returnValue.value, undefined);
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
  ipcMain.emit('writer:save-ready', event());
  const close = { preventDefault() { this.prevented = true; } };
  win.emit('close', close); assert.equal(close.prevented, true); assert.equal(lastSent.channel, 'writer:before-close'); assert.equal(win.destroyed, undefined);
  ipcMain.emit('writer:save-result', event(), { token: lastSent.token, saved: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(win.destroyed, undefined); assert.equal(child.exitCode, null);
  win.emit('close', { preventDefault() {} });
  ipcMain.emit('writer:save-result', event(), { token: 'wrong', saved: true }); assert.equal(win.destroyed, undefined);
  ipcMain.emit('writer:save-result', event(), { token: lastSent.token, saved: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(win.destroyed, true); assert.equal(child.exitCode, 0); assert.equal(app.quitCalled, true);
  console.log('PASS: authenticated book-folder bridge, trusted frame/ID checks, path and symlink isolation, localized file-manager errors');
  console.log('PASS: sandbox, constrained IPC/storage/network/navigation, close-save handshake and child cleanup');
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
  console.log('PASS: preload exposes only a book-ID operation and propagates localized failures');
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
