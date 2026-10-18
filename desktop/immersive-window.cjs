'use strict';

function createImmersiveWindow(target, { platform = process.platform, onState = () => {}, unavailable = () => false, transitionTimeout = 8000 } = {}) {
  let active = false, phase = 'idle', previous = null;
  let transition = Promise.resolve();
  const failure = code => Object.assign(new Error('Could not switch immersive writing'), { code });
  const state = () => ({ fullscreen: !target.isDestroyed() && target.isFullScreen(), maximized: !target.isDestroyed() && target.isMaximized(), immersiveWriting: active,
    priorWindowState: previous ? { fullscreen: previous.fullscreen, maximized: previous.maximized } : null });
  const publish = () => { if (!target.isDestroyed()) onState(state()); };
  function nativeTransition({ matches, eventName, change, failureCode, timeoutCode }) {
    if (target.isDestroyed()) return Promise.reject(failure('immersive-window-unavailable'));
    if (matches()) return Promise.resolve();
    // Full screen changes are asynchronous on macOS. A request is complete
    // only after the matching native event, including any OS animation.
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = error => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        target.removeListener(eventName, entered);
        target.removeListener('closed', closed);
        if (error) reject(error); else resolve();
      };
      const entered = () => finish(matches() ? null : failure(failureCode));
      const closed = () => finish(failure('immersive-window-unavailable'));
      const timer = setTimeout(() => finish(failure(timeoutCode)), transitionTimeout);
      target.once(eventName, entered);
      target.once('closed', closed);
      try { change(); }
      catch { finish(failure(failureCode)); }
    });
  }
  const fullscreen = enabled => nativeTransition({ matches: () => target.isFullScreen() === enabled,
    eventName: enabled ? 'enter-full-screen' : 'leave-full-screen', change: () => target.setFullScreen(enabled),
    failureCode: 'immersive-fullscreen-failed', timeoutCode: 'immersive-fullscreen-timeout' });
  function buttons(visible) {
    if (platform === 'darwin') target.setWindowButtonVisibility(visible);
  }
  async function restoreGeometry(snapshot) {
    if (target.isFullScreen()) return;
    // Restore the normal rectangle before maximizing again, so a later
    // native Restore action returns to the same window size and position.
    if (snapshot.maximized && !target.isMaximized()) target.setBounds(snapshot.bounds);
    await nativeTransition({ matches: () => target.isMaximized() === snapshot.maximized,
      eventName: snapshot.maximized ? 'maximize' : 'unmaximize', change: () => snapshot.maximized ? target.maximize() : target.unmaximize(),
      failureCode: 'immersive-window-restore-failed', timeoutCode: 'immersive-window-restore-timeout' });
    if (!snapshot.maximized) target.setBounds(snapshot.bounds);
  }
  async function apply(enabled) {
    // Closing first asks the renderer to save its final session. That save
    // callback may exit immersive mode, so the close guard blocks entry only.
    if (target.isDestroyed() || (enabled && unavailable())) throw failure('immersive-window-unavailable');
    if (enabled === active) return state();
    if (enabled) {
      const snapshot = { fullscreen: target.isFullScreen(), maximized: target.isMaximized(), bounds: target.getNormalBounds() };
      previous = snapshot;
      phase = 'entering';
      try {
        buttons(false);
        await fullscreen(true);
        active = true;
        phase = 'active';
      } catch (error) {
        // Rejected entry must not hide native controls or begin a session.
        try {
          if (!target.isDestroyed()) {
            await fullscreen(snapshot.fullscreen);
            await restoreGeometry(snapshot);
          }
        } catch { /* Keep the original failure actionable. */ }
        try { if (!target.isDestroyed()) buttons(true); } catch { }
        previous = null;
        phase = 'idle';
        publish();
        throw error;
      }
    } else {
      phase = 'exiting';
      try {
        if (previous.fullscreen) await restoreGeometry(previous);
        await fullscreen(previous.fullscreen);
        await restoreGeometry(previous);
        buttons(true);
        active = false;
        previous = null;
        phase = 'idle';
      } catch (error) {
        phase = 'active';
        publish();
        throw error;
      }
    }
    publish();
    return state();
  }
  function set(enabled) {
    if (typeof enabled !== 'boolean') return Promise.reject(failure('immersive-invalid-request'));
    // A quick Escape during entry waits for that animation before restoring
    // the captured state; it never toggles an in-flight native request.
    const operation = transition.then(() => apply(enabled));
    transition = operation.catch(() => {});
    return operation;
  }
  const listeners = [];
  for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    const listener = () => {
      if (phase === 'entering' || phase === 'exiting') return;
      if (event === 'leave-full-screen' && active) {
        // OS Escape, F11 and the macOS menu can bypass renderer IPC.
        set(false).catch(() => {});
      } else publish();
    };
    target.on(event, listener);
    listeners.push([event, listener]);
  }
  function dispose() {
    for (const [event, listener] of listeners) target.removeListener(event, listener);
    target.removeListener('closed', dispose);
    active = false; previous = null; phase = 'idle';
  }
  target.once('closed', dispose);
  return { set, state, phase: () => phase, dispose };
}

module.exports = { createImmersiveWindow };
