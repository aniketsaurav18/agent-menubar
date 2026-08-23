const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getUsage: () => ipcRenderer.invoke('usage:get'),
  refresh: () => ipcRenderer.invoke('app:refresh'),
  hide: () => ipcRenderer.send('win:hide'),
  show: () => ipcRenderer.send('win:show'),
  onUpdate: (cb) => {
    const listener = (_e, snap) => cb(snap);
    ipcRenderer.on('usage:updated', listener);
    return () => ipcRenderer.removeListener('usage:updated', listener);
  },
});
