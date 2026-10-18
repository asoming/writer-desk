'use strict';
// Execute the real main/preload contracts with native window events. No live
// Electron instance, network, installer or personal library is involved.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const root = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'desktop/preload.cjs'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));

async function harness(t, platform = 'darwin', options = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-immersive-native-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const app = new EventEmitter(), ipc = new EventEmitter(), sent = [], dialogs = [], calls = [];
  let win;
  Object.assign(app, { isPackaged: false, getPath: () => temporary, setPath() {}, setName() {}, getVersion: () => 'test',
    requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), quit() { app.quitCalled = true; } });
  ipc.handle = (name, callback) => { ipc[name] = callback; };
  const event = () => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  class FakeWindow extends EventEmitter {
    constructor(config) {
      super(); win = this; this.config = config; this.fullscreen = options.fullscreen === true; this.maximized = options.maximized === true;
      this.bounds = { x: 90, y: 120, width: 1100, height: 750 }; this.buttons = true; this.pending = [];
      this.webContents = new EventEmitter(); this.webContents.mainFrame = { url: '' };
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.getZoomFactor = () => 1;
      this.webContents.send = (channel, state) => {
        sent.push({ channel, state: copy(state) });
        if (channel === 'writer:before-close') queueMicrotask(() => ipc.emit('writer:save-result', event(), { token: state, saved: false }));
      };
    }
    loadURL(url) { this.webContents.mainFrame.url = url; return Promise.resolve(); }
    setMenu() {} setMenuBarVisibility() {} show() {} focus() {}
    isDestroyed() { return this.destroyed === true; }
    isFullScreen() { return this.fullscreen; }
    isMaximized() { return this.maximized; }
    isMinimized() { return false; }
    getNormalBounds() { return { ...this.bounds }; }
    setBounds(bounds) { calls.push(['bounds', { ...bounds }]); this.bounds = { ...bounds }; }
    maximize() { calls.push(['maximize']); if (!this.holdMaximize) this.completeMaximize(true); }
    unmaximize() { calls.push(['unmaximize']); this.maximized = false; this.emit('unmaximize'); }
    completeMaximize(maximized) { this.maximized = maximized; this.emit(maximized ? 'maximize' : 'unmaximize'); }
    setWindowButtonVisibility(visible) { calls.push(['buttons', visible]); this.buttons = visible; }
    setFullScreen(fullscreen) {
      calls.push(['fullscreen', fullscreen]);
      if (this.rejectFullscreen) throw new Error('Fixture native failure');
      if (this.holdFullscreen || this.ignoreFullscreen) { this.pending.push(fullscreen); return; }
      queueMicrotask(() => this.completeFullscreen(fullscreen));
    }
    completeFullscreen(fullscreen) { this.fullscreen = fullscreen; this.emit(fullscreen ? 'enter-full-screen' : 'leave-full-screen'); }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const appSession = new EventEmitter();
  Object.assign(appSession, { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {}, onBeforeSendHeaders() {} } });
  const electron = { app, ipcMain: ipc, BrowserWindow: FakeWindow,
    Menu: { buildFromTemplate: value => value, setApplicationMenu() {} }, session: { fromPartition: () => appSession }, shell: {},
    dialog: { showMessageBox: async (_window, value) => { dialogs.push(value); return { response: 0 }; }, showErrorBox: () => assert.fail('Unexpected startup error') } };
  const spawn = () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null;
    child.kill = () => {}; child.stdin = { end() { child.exitCode = 0; child.emit('exit', 0); } };
    queueMicrotask(() => child.stdout.emit('data', 'WRITER_READY {"url":"http://127.0.0.1:38123"}\n'));
    return child;
  };
  vm.runInNewContext(mainSource, {
    require: name => name === 'electron' ? electron : name === 'node:child_process' ? { spawn }
      : name === './immersive-window.cjs' ? { createImmersiveWindow: (target, config) => require('../desktop/immersive-window.cjs').createImmersiveWindow(target, { ...config, transitionTimeout: options.fastTimeout ? 10 : 8000 }) }
        : name.startsWith('./') ? require(path.join(root, 'desktop', name)) : require(name),
    __dirname: path.join(root, 'desktop'), process: { ...process, platform, argv: [], env: { ...process.env, WRITER_DESK_USER_DATA: temporary,
      WRITER_DESK_INSTALL_ROOT: path.join(temporary, 'install'), WRITER_DESK_APPLICATIONS_DIR: path.join(temporary, 'applications') } },
    console: { info() {}, error() {} }, setTimeout,
    clearTimeout, URL, Buffer
  });
  await tick();
  assert.ok(win);
  return { win, ipc, app, event, sent, calls, dialogs, invoke: (...args) => ipc['writer:immersive-writing'](event(), ...args),
    state: () => copy(sent.filter(item => item.channel === 'writer:window-state').at(-1)?.state),
    key(key) { const input = { type: 'keyDown', key, control: false, meta: false, alt: false, shift: false, isComposing: false };
      const keyboardEvent = { preventDefault() { this.prevented = true; } }; win.webContents.emit('before-input-event', keyboardEvent, input); return keyboardEvent; } };
}

test('immersive IPC authenticates the main frame and accepts exactly one boolean', async t => {
  const h = await harness(t);
  for (const sender of [{}, null, { sender: {}, senderFrame: h.win.webContents.mainFrame },
    { sender: h.win.webContents, senderFrame: { url: h.win.webContents.mainFrame.url } }]) {
    assert.equal((await h.ipc['writer:immersive-writing'](sender, true)).code, 'untrusted-sender');
  }
  for (const args of [[], [null], [1], ['true'], [{}], [true, false], [false, undefined]]) assert.equal((await h.invoke(...args)).code, 'immersive-invalid-request');
  assert.deepEqual(h.calls, []);
  assert.equal((await h.invoke(false)).immersiveWriting, false);
});

for (const platform of ['linux', 'win32', 'darwin']) {
  test(`${platform} immersive entry and exit restore the original normal window`, async t => {
    const h = await harness(t, platform), originalBounds = { ...h.win.bounds };
    const entered = await h.invoke(true);
    assert.equal(entered.fullscreen, true); assert.equal(entered.immersiveWriting, true);
    assert.deepEqual(copy(entered.priorWindowState), { fullscreen: false, maximized: false });
    assert.equal(h.win.config.frame, platform === 'darwin');
    if (platform === 'darwin') assert.equal(h.win.buttons, false);
    h.win.bounds = { x: 0, y: 0, width: 1800, height: 1200 };
    const exited = await h.invoke(false);
    assert.equal(exited.fullscreen, false); assert.equal(exited.maximized, false); assert.equal(exited.immersiveWriting, false); assert.equal(exited.priorWindowState, null);
    assert.deepEqual(h.win.bounds, originalBounds); assert.equal(h.win.buttons, true);
    assert.deepEqual(h.calls.filter(call => call[0] === 'fullscreen'), [['fullscreen', true], ['fullscreen', false]]);
    assert.equal(h.state().immersiveWriting, false);
  });
  test(`${platform} immersive exit restores a previously maximized window`, async t => {
    const h = await harness(t, platform, { maximized: true }), normalBounds = { ...h.win.bounds };
    assert.equal((await h.invoke(true)).priorWindowState.maximized, true);
    h.win.maximized = false;
    h.win.bounds = { x: 0, y: 0, width: 1800, height: 1200 };
    const exited = await h.invoke(false);
    assert.equal(exited.maximized, true); assert.equal(exited.fullscreen, false);
    assert.equal(h.calls.filter(call => call[0] === 'maximize').length, 1);
    assert.deepEqual(h.win.bounds, normalBounds);
  });
}

test('entering from existing fullscreen is idempotent and exit preserves it', async t => {
  const h = await harness(t, 'darwin', { fullscreen: true });
  const first = await h.invoke(true), repeated = await h.invoke(true);
  assert.equal(first.priorWindowState.fullscreen, true); assert.deepEqual(copy(first), copy(repeated));
  assert.equal((await h.invoke(false)).fullscreen, true);
  assert.deepEqual(h.calls.filter(call => call[0] === 'fullscreen'), []);
  assert.equal(h.win.buttons, true);
});

test('macOS entry waits for its native event and Escape during entry queues a complete exit', async t => {
  const h = await harness(t); h.win.holdFullscreen = true;
  let completed = false;
  const entering = h.invoke(true).then(value => { completed = true; return value; });
  await tick(); assert.equal(completed, false); assert.equal(h.win.buttons, false); assert.deepEqual(h.win.pending, [true]);
  assert.equal(h.key('Escape').prevented, true);
  h.win.completeFullscreen(true); assert.equal((await entering).immersiveWriting, true);
  await tick(); assert.deepEqual(h.win.pending, [true, false]); assert.equal(h.win.buttons, false);
  h.win.completeFullscreen(false); await tick();
  assert.equal(h.state().immersiveWriting, false); assert.equal(h.win.buttons, true); assert.equal(h.win.fullscreen, false);
});

test('native fullscreen exit restores the previous state and notifies the renderer once complete', async t => {
  const h = await harness(t, 'darwin', { maximized: true }); await h.invoke(true);
  h.win.maximized = false; h.win.completeFullscreen(false); await tick();
  assert.equal(h.state().immersiveWriting, false); assert.equal(h.state().maximized, true); assert.equal(h.win.buttons, true);
  const wasFullscreen = await harness(t, 'darwin', { fullscreen: true, maximized: true }); await wasFullscreen.invoke(true);
  wasFullscreen.win.maximized = false; wasFullscreen.win.completeFullscreen(false); await tick();
  assert.equal(wasFullscreen.state().immersiveWriting, false); assert.equal(wasFullscreen.state().fullscreen, true); assert.equal(wasFullscreen.state().maximized, true);
});

test('exit waits for a delayed native maximize restoration before reporting completion', async t => {
  const h = await harness(t, 'darwin', { maximized: true }); await h.invoke(true);
  h.win.maximized = false; h.win.holdMaximize = true;
  let completed = false;
  const exiting = h.invoke(false).then(value => { completed = true; return value; });
  await tick(); assert.equal(completed, false); assert.equal(h.win.fullscreen, false); assert.equal(h.win.buttons, false);
  h.win.completeMaximize(true); const restored = await exiting;
  assert.equal(restored.maximized, true); assert.equal(restored.immersiveWriting, false); assert.equal(h.win.buttons, true);
});

test('Escape and F11 exit immersive while the ordinary fullscreen action remains available', async t => {
  const h = await harness(t, 'linux'); await h.invoke(true);
  assert.equal(h.key('Escape').prevented, true); await tick(); assert.equal(h.state().immersiveWriting, false);
  await h.invoke(true); assert.equal(h.key('F11').prevented, true); await tick(); assert.equal(h.state().immersiveWriting, false);
  await h.ipc['writer:app-action'](h.event(), 'toggleFullscreen'); await tick(); assert.equal(h.win.fullscreen, true); assert.equal(h.state().immersiveWriting, false);
  await h.ipc['writer:app-action'](h.event(), 'toggleFullscreen'); await tick(); assert.equal(h.win.fullscreen, false);
});

test('failed or timed out native entry restores controls without beginning a session', async t => {
  const h = await harness(t); h.win.rejectFullscreen = true;
  assert.equal((await h.invoke(true)).code, 'immersive-fullscreen-failed'); assert.equal(h.win.buttons, true);
  assert.equal(h.state().immersiveWriting, false); assert.equal(h.state().priorWindowState, null);
  const timeout = await harness(t, 'darwin', { fastTimeout: true }); timeout.win.ignoreFullscreen = true;
  assert.equal((await timeout.invoke(true)).code, 'immersive-fullscreen-timeout'); assert.equal(timeout.win.buttons, true); assert.equal(timeout.state().immersiveWriting, false);
});

test('failed native exit retains the active contract and captured state for an explicit retry', async t => {
  const h = await harness(t); await h.invoke(true); h.win.rejectFullscreen = true;
  assert.equal((await h.invoke(false)).code, 'immersive-fullscreen-failed');
  assert.equal(h.state().immersiveWriting, true); assert.equal(h.state().priorWindowState.fullscreen, false); assert.equal(h.win.fullscreen, true); assert.equal(h.win.buttons, false);
  h.win.rejectFullscreen = false;
  assert.equal((await h.invoke(false)).immersiveWriting, false); assert.equal(h.win.fullscreen, false); assert.equal(h.win.buttons, true);
});

test('native close in immersive writing still requires the existing save confirmation', async t => {
  const h = await harness(t); await h.invoke(true); h.ipc.emit('writer:save-ready', h.event());
  const closeEvent = { preventDefault() { this.prevented = true; } }; h.win.emit('close', closeEvent);
  const exitDuringSave = h.invoke(false);
  await tick(); await tick();
  assert.equal(closeEvent.prevented, true); assert.ok(h.sent.some(item => item.channel === 'writer:before-close'));
  assert.equal(h.dialogs.length, 1); assert.equal(h.win.destroyed, undefined); assert.equal(h.app.quitCalled, undefined);
  assert.equal((await exitDuringSave).immersiveWriting, false, 'Closing blocks new sessions but must allow the before-close save callback to exit');
});

function preloadHarness() {
  let bridge; const ipc = new EventEmitter(), calls = [];
  ipc.sendSync = () => ({ platform: 'darwin' });
  ipc.response = { fullscreen: true, maximized: false, immersiveWriting: true, priorWindowState: { fullscreen: false, maximized: false } };
  ipc.invoke = async (...args) => { calls.push(args); return ipc.response; };
  vm.runInNewContext(preloadSource, { require: () => ({ ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } } }) });
  return { bridge, ipc, calls };
}

test('preload exposes a narrow boolean API and validates native immersive responses', async () => {
  const h = preloadHarness();
  for (const args of [[], [null], ['true'], [true, null]]) await assert.rejects(h.bridge.setImmersiveWriting(...args), { code: 'immersive-invalid-request' });
  assert.deepEqual(h.calls, []);
  const state = await h.bridge.setImmersiveWriting(true); assert.equal(state.immersiveWriting, true);
  assert.deepEqual(h.calls, [['writer:immersive-writing', true]]);
  for (const response of [{ fullscreen: true, maximized: false }, { ...h.ipc.response, immersiveWriting: 'yes' },
    { ...h.ipc.response, priorWindowState: { fullscreen: 'yes', maximized: false } }, { ...h.ipc.response, priorWindowState: [] }]) {
    h.ipc.response = response; await assert.rejects(h.bridge.setImmersiveWriting(false), { code: 'invalid-response' });
  }
});

test('preload forwards authenticated window state without paths and ignores malformed updates', () => {
  const h = preloadHarness(), states = [], off = h.bridge.onWindowState(value => states.push(copy(value)));
  h.ipc.emit('writer:window-state', {}, { fullscreen: true, maximized: false });
  h.ipc.emit('writer:window-state', {}, { fullscreen: false, maximized: true, immersiveWriting: false, priorWindowState: null, secretPath: '/private' });
  h.ipc.emit('writer:window-state', {}, { fullscreen: false, maximized: true, immersiveWriting: 'false' });
  h.ipc.emit('writer:window-state', {}, { fullscreen: false, maximized: true, priorWindowState: { fullscreen: false } });
  assert.deepEqual(states, [{ fullscreen: true, maximized: false }, { fullscreen: false, maximized: true, immersiveWriting: false, priorWindowState: null }]);
  off(); h.ipc.emit('writer:window-state', {}, { fullscreen: false, maximized: false }); assert.equal(states.length, 2);
});
