'use strict';
// Runtime contract checks: no browser automation and no personal database access.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
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
    assert.equal((await fetch(url + '/api/books', { method: 'POST', headers: { ...headers, Origin: 'https://example.org' }, body: '{}' })).status, 403);
    assert.equal((await fetch(url + '/api/books', { method: 'POST', headers: { 'X-Writer-Client': '1', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    const stopped = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Service remained after parent pipe closed')), 3000);
      child.once('exit', code => { clearTimeout(timeout); assert.equal(code, 0); resolve(); });
    });
    child.stdin.end(); await stopped;
    console.log('PASS: random loopback port, desktop authentication, origin checks and storage API');
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
  let win, child, headersHandler, requestHandler, lastSent;
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
  const electron = { app, ipcMain, BrowserWindow: FakeWindow, session: { fromPartition: () => fakeSession }, Menu: { buildFromTemplate: value => value, setApplicationMenu: value => { app.menu = value; } }, dialog: { showErrorBox: () => assert.fail('unexpected startup failure'), showMessageBox: async () => ({ response: 0 }) }, shell: { openExternal: async () => {}, openPath: async () => {} } };
  const spawnFake = () => {
    child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null;
    child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit('exit', 0)); };
    queueMicrotask(() => child.stdout.emit('data', Buffer.from('WRITER_READY {"url":"http://127.0.0.1:38123"}\n')));
    return child;
  };
  const context = { require: name => name === 'electron' ? electron : name === 'node:child_process' ? { spawn: spawnFake } : require(name), __dirname: path.join(root, 'desktop'), process: { ...process, env: { ...process.env, WRITER_DESK_USER_DATA: userData } }, console, setTimeout, clearTimeout, URL, Buffer };
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
  headersHandler({ url: 'https://example.org/', requestHeaders: {} }, value => { result = value; }); assert.equal(result.requestHeaders['X-Writer-Desktop'], undefined);
  const event = () => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  let e = event(); ipcMain.emit('writer:storage', e, { op: 'set', key: 'yejian.draft.fixture', value: 'saved draft' }); assert.equal(e.returnValue.error, undefined);
  e = event(); ipcMain.emit('writer:storage', e, { op: 'get', key: 'yejian.draft.fixture' }); assert.equal(e.returnValue.value, 'saved draft');
  e = event(); ipcMain.emit('writer:storage', e, { op: 'length' }); assert.equal(e.returnValue.value, 1);
  e = event(); ipcMain.emit('writer:storage', e, { op: 'set', key: '../../escape', value: 'x' }); assert.match(e.returnValue.error, /Invalid/);
  e = { sender: {}, senderFrame: {} }; ipcMain.emit('writer:storage', e, { op: 'get', key: 'yejian.draft.fixture' }); assert.equal(e.returnValue.value, undefined);
  assert.equal(await ipcMain['writer:language'](event(), 'en'), true);
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
  console.log('PASS: sandbox, constrained IPC/storage/network/navigation, close-save handshake and child cleanup');
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

(async () => { try { await testService(); await testMainContract(); await testMigration(); } finally { fs.rmSync(temp, { recursive: true, force: true }); } })().catch(error => { console.error(error); process.exitCode = 1; });
