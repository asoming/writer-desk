'use strict';
const { contextBridge, ipcRenderer } = require('electron');
let beforeClose = null;
const callStorage = (op, key, value) => {
  const result = ipcRenderer.sendSync('writer:storage', { op, key, value });
  if (result?.error) throw new Error(result.error);
  return result?.value ?? null;
};
const storage = {
  getItem: key => callStorage('get', key),
  setItem: (key, value) => callStorage('set', key, value),
  removeItem: key => callStorage('remove', key),
  key: index => callStorage('key', index),
  getLength: () => callStorage('length')
};
const boot = ipcRenderer.sendSync('writer:bootstrap');
async function nativeRequest(channel, value) {
  const result = await ipcRenderer.invoke(channel, value);
  if (result?.error) throw Object.assign(new Error(result.error), { code: result.code });
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw Object.assign(new Error('Invalid app response'), { code: 'invalid-response' });
  return result;
}
function checkedWindowState(value, required = false) {
  const state = {};
  for (const key of ['fullscreen', 'maximized']) {
    if (typeof value[key] === 'boolean') state[key] = value[key];
    else if (required || Object.hasOwn(value, key)) throw Object.assign(new Error('Invalid window state'), { code: 'invalid-response' });
  }
  if (Object.hasOwn(value, 'zoomFactor')) {
    if (!Number.isFinite(value.zoomFactor) || value.zoomFactor <= 0 || value.zoomFactor > 5) throw Object.assign(new Error('Invalid zoom factor'), { code: 'invalid-response' });
    state.zoomFactor = value.zoomFactor;
  }
  return state;
}
contextBridge.exposeInMainWorld('WriterDesktop', {
  isDesktop: true,
  language: boot?.language || 'zh',
  version: boot?.version || '',
  storage,
  setLanguage: language => ipcRenderer.invoke('writer:language', language),
  getAppSettings: async () => {
    const result = await nativeRequest('writer:app-settings');
    if (typeof result.version !== 'string' || typeof result.dataPath !== 'string' || !Number.isFinite(result.zoomFactor)) throw Object.assign(new Error('Invalid app settings'), { code: 'invalid-response' });
    return { version: result.version, dataPath: result.dataPath, ...checkedWindowState(result, true) };
  },
  performAppAction: async action => checkedWindowState(await nativeRequest('writer:app-action', action)),
  onWindowState: callback => {
    if (typeof callback !== 'function') throw new TypeError('A window state callback is required');
    const listener = (_event, value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      let state;
      try { state = checkedWindowState(value, true); } catch { return; }
      callback({ fullscreen: state.fullscreen, maximized: state.maximized });
    };
    ipcRenderer.on('writer:window-state', listener);
    return () => ipcRenderer.removeListener('writer:window-state', listener);
  },
  openBookFolder: async bookId => {
    const result = await ipcRenderer.invoke('writer:open-book-folder', bookId);
    if (result?.error) throw Object.assign(new Error(result.error), { code: result.code });
    return result;
  },
  onBeforeClose: callback => {
    if (typeof callback !== 'function') throw new TypeError('A save callback is required');
    beforeClose = callback;
    ipcRenderer.send('writer:save-ready');
  }
});
ipcRenderer.on('writer:before-close', async (_event, token) => {
  let saved = false;
  try { saved = !!(beforeClose && await beforeClose()); } catch { saved = false; }
  ipcRenderer.send('writer:save-result', { token, saved });
});
