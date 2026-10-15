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
  getLength: () => callStorage('length'),
  clearBookContent: (bookId, purgedAt) => callStorage('clear-book-content', bookId, purgedAt)
};
const boot = ipcRenderer.sendSync('writer:bootstrap');
async function nativeRequest(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
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
  platform: ['darwin', 'linux', 'win32'].includes(boot?.platform) ? boot.platform : '',
  language: boot?.language || 'zh',
  version: boot?.version || '',
  storage,
  setLanguage: language => ipcRenderer.invoke('writer:language', language),
  getAppSettings: async () => {
    const result = await nativeRequest('writer:app-settings');
    if (typeof result.version !== 'string' || typeof result.dataPath !== 'string' || !Number.isFinite(result.zoomFactor)) throw Object.assign(new Error('Invalid app settings'), { code: 'invalid-response' });
    return { version: result.version, dataPath: result.dataPath, ...checkedWindowState(result, true), updateSupported: result.updateSupported === true,
      installPath: typeof result.installPath === 'string' ? result.installPath : '', installedVersion: typeof result.installedVersion === 'string' ? result.installedVersion : '', pendingVersion: typeof result.pendingVersion === 'string' ? result.pendingVersion : '' };
  },
  chooseBackupDirectory: async () => (await nativeRequest('writer:choose-backup-directory')).path,
  networkInfo: () => nativeRequest('writer:network-info'),
  networkCheck: () => nativeRequest('writer:network-check'),
  networkDownload: () => nativeRequest('writer:network-download'),
  networkCancel: () => nativeRequest('writer:network-cancel'),
  networkInstall: () => nativeRequest('writer:network-install'),
  networkSettings: value => nativeRequest('writer:network-settings', value),
  onNetworkUpdate: callback => {
    if (typeof callback !== 'function') throw new TypeError('An update callback is required');
    const listener = (_event, value) => { if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.phase === 'string') callback(value); };
    ipcRenderer.on('writer:network-update-state', listener);
    return () => ipcRenderer.removeListener('writer:network-update-state', listener);
  },
  installUpdate: () => nativeRequest('writer:install-update'),
  restartAfterUpdate: () => nativeRequest('writer:restart-after-update'),
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
  printBookPDF: async options => {
    const result = await nativeRequest('writer:print-book-pdf', options);
    if (result.canceled === true) return { canceled: true };
    if (result.saved === true) return { saved: true };
    throw Object.assign(new Error('Invalid PDF export response'), { code: 'invalid-response' });
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
