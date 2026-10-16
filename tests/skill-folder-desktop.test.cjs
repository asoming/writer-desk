'use strict';
// Only disposable paths and a mocked file manager are used here.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8');
const skillCode = source.slice(source.indexOf('const builtinSkillIds = '), source.indexOf('const appActions = '));
const handlerStart = source.indexOf("ipcMain.handle('writer:show-skill-in-folder'");
const handlerCode = source.slice(handlerStart, source.indexOf("ipcMain.handle('writer:print-book-pdf'", handlerStart));
const trustedCode = source.slice(source.indexOf('function trusted(event)'), source.indexOf('const localURL = '));
const builtin = 'human-writing';
const custom = 'custom-' + 'a'.repeat(32);
function harness(t, packaged = false) {
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'writer-skill-folder-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const userData = path.join(temporary, 'user-data');
  const resourcesPath = path.join(temporary, 'resources');
  const sourceRoot = path.join(temporary, 'checkout');
  const localFolder = id => path.join(userData, 'data', 'writing-skills', id);
  const builtinFolder = id => packaged ? path.join(resourcesPath, 'backend', '_internal', 'bundled-skills', id) : path.join(sourceRoot, 'bundled-skills', id);
  for (const folder of [localFolder(builtin), localFolder(custom), builtinFolder(builtin)]) {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'SKILL.md'), '# Test rule');
  }
  const origin = 'http://127.0.0.1:38123', requests = [], opened = [];
  const window = { isDestroyed: () => false, webContents: { mainFrame: { url: origin + '/' } } };
  const event = () => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  const context = { app: { isPackaged: packaged }, path, fs, userData, __dirname: path.join(sourceRoot, 'desktop'),
    process: { resourcesPath }, origin, service: { exitCode: null }, serviceToken: 'isolated-desktop-token', window,
    text: (zh, en) => en, folderError: (code, zh, en) => Object.assign(new Error(en), { code }),
    shell: { openPath: async folder => { opened.push(folder); return ''; } },
    setTimeout, clearTimeout, URL, Buffer,
    reply: { status: 200, body: { id: builtin, origin: 'builtin', folder: builtinFolder(builtin) } } };
  context.http = { request: (url, options, callback) => {
    const request = new EventEmitter();
    request.destroy = error => { if (error) queueMicrotask(() => request.emit('error', error)); };
    request.end = body => {
      requests.push({ url, options, body });
      queueMicrotask(() => {
        const reply = context.reply;
        if (reply.requestError) { request.emit('error', new Error('Fixture unavailable')); return; }
        if (reply.hang) return;
        const response = new EventEmitter(); response.statusCode = reply.status;
        callback(response);
        if (reply.responseError) { response.emit('error', new Error('Fixture response error')); return; }
        if (reply.aborted) { response.emit('aborted'); return; }
        response.emit('data', Buffer.from(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)));
        response.emit('end');
      });
    };
    return request;
  } };
  const ipc = new Map(); context.ipcMain = { handle: (name, callback) => ipc.set(name, callback) };
  vm.runInNewContext(trustedCode + skillCode + handlerCode, context);
  return { context, temporary, event, requests, opened, localFolder, builtinFolder,
    run: (id = builtin, sender = event(), ...extra) => ipc.get('writer:show-skill-in-folder')(sender, id, ...extra) };
}
test('Skill file manager locates bundled, overridden and custom App folders in source and packaged apps', async t => {
  for (const packaged of [false, true]) {
    const h = harness(t, packaged);
    for (const [id, origin, folder] of [[builtin, 'builtin', h.builtinFolder(builtin)], [builtin, 'local', h.localFolder(builtin)], [custom, 'local', h.localFolder(custom)]]) {
      h.context.reply = { status: 200, body: { id, origin, folder } };
      assert.equal((await h.run(id)).opened, true);
      assert.equal(h.opened.at(-1), folder);
      const request = h.requests.at(-1);
      assert.equal(request.url.origin, h.context.origin);
      assert.equal(request.url.pathname, '/api/skills/' + id + '/folder');
      assert.equal(request.options.method, 'GET');
      assert.equal(request.options.headers['X-Writer-Desktop'], h.context.serviceToken);
      assert.equal(request.options.headers.Origin, h.context.origin);
      assert.equal(request.options.headers['X-Writer-Client'], '1');
      assert.equal(request.body, undefined);
    }
  }
});
test('Skill IPC accepts only one validated ID from the trusted main frame', async t => {
  const h = harness(t);
  const untrusted = [
    { sender: {}, senderFrame: h.context.window.webContents.mainFrame },
    { sender: h.context.window.webContents, senderFrame: { url: h.context.origin + '/' } },
    { sender: h.context.window.webContents, senderFrame: { url: 'https://example.com' } },
    {}, null
  ];
  for (const sender of untrusted) assert.equal((await h.run(builtin, sender)).code, 'untrusted-sender');
  for (const id of [null, [], {}, '../human-writing', '/tmp/private', 'human-writing/folder', 'custom-x', custom + '/..', 'unknown', builtin + '\0', builtin + '?path=secret']) assert.equal((await h.run(id)).code, 'invalid-skill-id');
  assert.equal((await h.run(builtin, h.event(), '/tmp/private')).code, 'invalid-request');
  assert.equal(h.requests.length, 0); assert.deepEqual(h.opened, []);
});
test('Skill file manager rejects malicious backend locations and mismatched responses', async t => {
  for (const packaged of [false, true]) {
    const h = harness(t, packaged);
    const folder = h.builtinFolder(builtin);
    for (const body of [
      { id: builtin, folder: h.temporary, origin: 'builtin' },
      { id: builtin, folder: folder + path.sep, origin: 'builtin' },
      { id: builtin, folder: path.join(folder, '..'), origin: 'builtin' },
      { id: builtin, folder: h.localFolder(builtin), origin: 'builtin' },
      { id: builtin, folder, origin: 'local' },
      { id: builtin, folder: path.join(h.temporary, '.codex', 'skills', builtin), origin: 'local' },
      { id: builtin, folder: '/tmp/arbitrary', origin: 'codex' },
      { id: 'novelskill', folder, origin: 'builtin' },
      { id: custom, folder, origin: 'builtin' },
      { id: builtin, folder: folder + '\0', origin: 'builtin' },
      { id: builtin, folder: null, origin: 'builtin' },
      { id: builtin, folder, origin: 'builtin', command: 'open anything' },
      [], null, '{}', 'not json'
    ]) {
      h.context.reply = { status: 200, body };
      assert.equal((await h.run()).opened, undefined, JSON.stringify(body));
    }
    assert.deepEqual(h.opened, []);
  }
});
test('Skill path checks reject linked Skill directories and linked ancestors', async t => {
  const h = harness(t);
  const linked = h.localFolder(custom), outside = path.join(h.temporary, 'outside');
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'SKILL.md'), '# Outside rule');
  fs.rmSync(linked, { recursive: true });
  fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  h.context.reply = { status: 200, body: { id: custom, origin: 'local', folder: linked } };
  assert.equal((await h.run(custom)).code, 'unsafe-folder');
  fs.rmSync(linked);
  const library = path.dirname(linked);
  fs.rmSync(library, { recursive: true });
  fs.symlinkSync(outside, library, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await h.run(custom)).opened, undefined);
  assert.deepEqual(h.opened, []);
});
test('Skill requests reject oversized, unavailable, redirected and interrupted responses without shell access', async t => {
  const h = harness(t);
  for (const reply of [{ status: 200, body: 'x'.repeat(65537) }, { status: 302, body: {} }, { status: 403, body: {} }, { status: 404, body: {} }, { status: 500, body: {} }, { requestError: true }, { responseError: true }, { aborted: true }]) {
    h.context.reply = reply;
    assert.equal((await h.run()).opened, undefined);
  }
  h.context.origin = '';
  assert.equal((await h.run()).code, 'untrusted-sender');
  h.context.origin = 'http://127.0.0.1:38123'; h.context.service.exitCode = 0;
  assert.equal((await h.run()).code, 'service-unavailable');
  assert.deepEqual(h.opened, []);
});
test('Skill folder timeout, missing folder and file manager failures produce localized errors', async t => {
  const h = harness(t);
  let timeout;
  h.context.setTimeout = callback => { timeout = callback; return 1; };
  h.context.clearTimeout = () => {};
  h.context.reply = { hang: true };
  const waiting = h.run(); await new Promise(resolve => setImmediate(resolve)); timeout();
  assert.equal((await waiting).code, 'service-timeout');
  h.context.reply = { status: 200, body: { id: builtin, origin: 'local', folder: h.localFolder(builtin) } };
  h.context.shell.openPath = async () => 'File manager refused';
  assert.equal((await h.run()).code, 'open-folder-failed');
  h.context.shell.openPath = async () => { throw new Error('Do not leak file manager details'); };
  const failed = await h.run(); assert.equal(failed.code, 'open-folder-failed'); assert.ok(!failed.error.includes('Do not leak'));
  fs.rmSync(h.localFolder(builtin), { recursive: true });
  assert.equal((await h.run()).code, 'skill-folder-unavailable');
});
test('Skill preload exposes only validated ID-to-folder operation and strips unexpected return data', async () => {
  let bridge;
  const invoked = [], ipcRenderer = new EventEmitter();
  ipcRenderer.sendSync = () => ({});
  ipcRenderer.invoke = async (channel, ...args) => { invoked.push({ channel, args }); return { opened: true, folder: 'private path' }; };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'desktop/preload.cjs'), 'utf8'), { require: () => ({ ipcRenderer, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } } }) });
  const result = await bridge.showSkillInFolder(custom);
  assert.deepEqual(Object.keys(result), ['opened']); assert.equal(result.opened, true);
  assert.deepEqual(invoked, [{ channel: 'writer:show-skill-in-folder', args: [custom] }]);
  for (const args of [[], [null], ['../private'], [builtin, '/tmp/private'], ['custom-x'], ['human-writing\0']]) await assert.rejects(bridge.showSkillInFolder(...args), error => error.code === 'invalid-skill-id');
  assert.equal(invoked.length, 1);
  for (const bad of [null, undefined, [], {}, { opened: 'yes' }]) {
    ipcRenderer.invoke = async () => bad;
    await assert.rejects(bridge.showSkillInFolder(builtin), error => error.code === 'invalid-response');
  }
  ipcRenderer.invoke = async () => ({ error: '无法打开系统文件管理器。', code: 'open-folder-failed' });
  await assert.rejects(bridge.showSkillInFolder(builtin), error => error.code === 'open-folder-failed' && /无法/.test(error.message));
  assert.equal(bridge.openPath, undefined); assert.equal(bridge.showItemInFolder, undefined); assert.equal(bridge.send, undefined);
});

// Copy Markdown uses Chromium's sanitized text write permission. No test writes
// to the system clipboard, and clipboard reads remain unavailable.
test('only the trusted main document can write sanitized clipboard text', () => {
  const code = source.slice(source.indexOf('function canWriteClipboard('), source.indexOf('function createWindow()'));
  const origin = 'http://127.0.0.1:38123', contents = {mainFrame: {url: origin + '/'}};
  const context = {window: {isDestroyed: () => false, webContents: contents},
    localURL: value => {try {return new URL(value).origin === origin;} catch {return false;}}};
  vm.runInNewContext(code, context);
  const details = {isMainFrame: true, requestingUrl: origin + '/'};
  assert.equal(context.canWriteClipboard(contents, 'clipboard-sanitized-write', details), true);
  for (const permission of ['clipboard-read', 'media', 'openExternal', 'fileSystem'])
    assert.equal(context.canWriteClipboard(contents, permission, details), false);
  for (const other of [{}, null]) assert.equal(context.canWriteClipboard(other, 'clipboard-sanitized-write', details), false);
  for (const request of [null, {}, {...details, isMainFrame: false}, {...details, requestingUrl: 'https://foreign.example/'}])
    assert.equal(context.canWriteClipboard(contents, 'clipboard-sanitized-write', request), false);
  contents.mainFrame.url = 'https://foreign.example/';
  assert.equal(context.canWriteClipboard(contents, 'clipboard-sanitized-write', details), false);
});
