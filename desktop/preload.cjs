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
contextBridge.exposeInMainWorld('WriterDesktop', {
  isDesktop: true,
  language: boot?.language || 'zh',
  version: boot?.version || '',
  storage,
  setLanguage: language => ipcRenderer.invoke('writer:language', language),
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
