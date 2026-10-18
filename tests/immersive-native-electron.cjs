'use strict';

// Real native window transitions through the production controller. The
// disposable profile contains no writing service, books or personal settings.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createImmersiveWindow } = require('../desktop/immersive-window.cjs');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-immersive-native-electron-'));
const reportIndex = process.argv.indexOf('--report');
const reportPath = reportIndex >= 0 ? path.resolve(process.argv[reportIndex + 1]) : null;
const report = { passed: false, platform: process.platform, arch: process.arch, electron: process.versions.electron,
  productionController: true, isolatedProfile: true, realUserBooksTouched: false, cases: {} };
app.setName('WriterImmersiveNativeTest');
app.setPath('userData', path.join(temporary, 'profile'));
app.on('window-all-closed', () => {});
let win, controller, windowManager, finished = false;
const timeout = setTimeout(() => finish(new Error('Native immersive workflow timed out')), 120000);
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(check, label, milliseconds = 12000) {
  const start = Date.now();
  while (Date.now() - start < milliseconds) { if (check()) return; await pause(40); }
  throw new Error('Timed out: ' + label);
}
function sameBounds(actual, expected) {
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(actual[key] - expected[key]) <= 2, 'Restored window ' + key + ': ' + JSON.stringify({ actual, expected }));
}
async function nativeFullscreen(enabled) {
  if (win.isFullScreen() === enabled) return;
  await new Promise((resolve, reject) => {
    const event = enabled ? 'enter-full-screen' : 'leave-full-screen';
    const timer = setTimeout(() => { win.removeListener(event, done); reject(new Error('Native setup fullscreen timed out')); }, 12000);
    const done = () => { clearTimeout(timer); resolve(); };
    win.once(event, done); win.setFullScreen(enabled);
  });
}
async function startWindowManager() {
  if (process.env.WRITER_TEST_WINDOW_MANAGER !== 'openbox' || process.platform !== 'linux') return;
  windowManager = spawn('openbox', ['--sm-disable'], { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 350);
    windowManager.once('error', error => { clearTimeout(timer); reject(error); });
    windowManager.once('exit', code => { clearTimeout(timer); reject(new Error('Isolated window manager exited: ' + code)); });
  });
  report.isolatedWindowManager = true;
}
async function stopWindowManager() {
  if (!windowManager || windowManager.exitCode !== null || windowManager.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { windowManager.kill('SIGKILL'); resolve(); }, 1500);
    windowManager.once('exit', () => { clearTimeout(timer); resolve(); });
    windowManager.kill('SIGTERM');
  });
}
async function finish(error) {
  if (finished) return;
  finished = true; clearTimeout(timeout);
  if (error) { report.passed = false; report.error = error.stack || String(error); }
  controller?.dispose();
  if (win && !win.isDestroyed()) win.destroy();
  await stopWindowManager();
  const output = JSON.stringify(report, null, 2) + '\n';
  if (reportPath) { fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, output); }
  (error ? console.error : console.log)(output);
  try { fs.rmSync(temporary, { recursive: true, force: true }); } catch { }
  app.exit(error ? 1 : 0);
}
app.whenReady().then(async () => {
  try {
    await startWindowManager();
    const configuration = { width: 980, height: 700, x: 70, y: 70, show: false,
      ...(process.platform === 'darwin' ? { frame: true, titleBarStyle: 'hiddenInset' } : { frame: false }),
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } };
    win = new BrowserWindow(configuration);
    win.setMenu(null); win.setMenuBarVisibility(false);
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><title>Isolated immersive native test</title><p>Native fullscreen test</p>'));
    win.showInactive(); await pause(150);
    let controlsVisible = true, unavailable = false;
    const buttonCalls = [];
    if (process.platform === 'darwin') {
      const setButtons = win.setWindowButtonVisibility.bind(win);
      win.setWindowButtonVisibility = value => { buttonCalls.push(value); controlsVisible = value; return setButtons(value); };
    }
    const updates = [], originalListenerCount = win.listenerCount('leave-full-screen');
    controller = createImmersiveWindow(win, { onState: value => updates.push(value), unavailable: () => unavailable, transitionTimeout: 12000 });
    const original = win.getNormalBounds();
    let state = await controller.set(true);
    assert.equal(win.isFullScreen(), true); assert.equal(state.immersiveWriting, true); assert.equal(state.priorWindowState.fullscreen, false);
    if (process.platform === 'darwin') assert.equal(controlsVisible, false);
    else assert.equal(configuration.frame, false);
    const count = updates.length;
    assert.deepEqual(await controller.set(true), state); assert.equal(updates.length, count, 'Repeated enter must not toggle the native window');
    state = await controller.set(false);
    assert.equal(win.isFullScreen(), false); assert.equal(state.immersiveWriting, false); assert.equal(controlsVisible, true);
    sameBounds(win.getNormalBounds(), original);
    report.cases.normalWindow = { fullscreenEntered: true, restoredBounds: true, repeatedEntryIdempotent: true, nativeControlsHidden: true };

    const beforeMaximize = win.getNormalBounds();
    win.maximize(); await until(() => win.isMaximized(), 'initial maximize');
    await controller.set(true); state = await controller.set(false);
    await until(() => win.isMaximized(), 'restored maximize');
    assert.equal(state.immersiveWriting, false); assert.equal(state.fullscreen, false);
    win.unmaximize();
    // The OS can clear isMaximized before applying the normal rectangle.
    // Require the original geometry across consecutive native observations;
    // the exact restoration assertion below still checks the same bounds.
    let restoredObservations = 0;
    await until(() => {
      const bounds = win.getNormalBounds();
      const restored = !win.isMaximized() && ['x', 'y', 'width', 'height'].every(key => Math.abs(bounds[key] - beforeMaximize[key]) <= 2);
      restoredObservations = restored ? restoredObservations + 1 : 0;
      return restoredObservations >= 3;
    }, 'leave maximize and restore stable normal geometry');
    sameBounds(win.getNormalBounds(), beforeMaximize);
    report.cases.maximizedWindow = { enteredFromMaximized: true, restoredMaximized: true, restoredNormalBounds: true };

    await nativeFullscreen(true);
    state = await controller.set(true); assert.equal(state.priorWindowState.fullscreen, true);
    state = await controller.set(false); assert.equal(state.fullscreen, true); assert.equal(state.immersiveWriting, false); assert.equal(controlsVisible, true);
    await nativeFullscreen(false);
    report.cases.priorFullscreen = { restoredPriorFullscreen: true, immersiveEnded: true, controlsRestored: true };

    await controller.set(true);
    win.setFullScreen(false);
    await until(() => !controller.state().immersiveWriting && !win.isFullScreen(), 'native external fullscreen exit');
    assert.equal(updates.at(-1).immersiveWriting, false); assert.equal(controlsVisible, true);
    report.cases.nativeExit = { nativeLeaveEventEndsImmersive: true, rendererNotified: true, controlsRestored: true };

    const entering = controller.set(true), exiting = controller.set(false);
    assert.equal((await entering).immersiveWriting, true); assert.equal((await exiting).immersiveWriting, false);
    assert.equal(win.isFullScreen(), false); assert.equal(controlsVisible, true);
    report.cases.quickExit = { inFlightEntrySerialized: true, restoredOriginalState: true };

    await controller.set(true); unavailable = true;
    assert.equal((await controller.set(false)).immersiveWriting, false, 'The close save callback must still be able to end immersive writing');
    await assert.rejects(controller.set(true), { code: 'immersive-window-unavailable' });
    assert.equal(win.isFullScreen(), false); assert.equal(controller.state().immersiveWriting, false);
    report.cases.closingGuard = { entryRejectedBeforeNativeChange: true, exitAllowedForCloseSave: true };
    if (process.platform === 'darwin') {
      assert.ok(buttonCalls.includes(false)); assert.equal(buttonCalls.at(-1), true);
      report.cases.macNativeControls = { actualWindowButtonAPI: true, hiddenDuringImmersive: true, restoredAfterExit: true };
    }
    controller.dispose(); assert.equal(win.listenerCount('leave-full-screen'), originalListenerCount);
    report.cases.cleanup = { nativeListenersRemoved: true };
    report.passed = true; await finish();
  } catch (error) { await finish(error); }
});
