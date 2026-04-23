const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sunoTool', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateBrowserSettings: (settings) => ipcRenderer.invoke('settings:update-browser', settings),
  chooseBrowserExecutable: () => ipcRenderer.invoke('browser:choose-executable'),
  launchBrowser: () => ipcRenderer.invoke('browser:launch'),
  injectCheckboxes: () => ipcRenderer.invoke('browser:inject-checkboxes'),
  chooseDownloadDir: () => ipcRenderer.invoke('download:choose-dir'),
  startDownload: () => ipcRenderer.invoke('download:start'),
  retryCurrent: () => ipcRenderer.invoke('download:retry'),
  skipCurrent: () => ipcRenderer.invoke('download:skip'),
  stopAll: () => ipcRenderer.invoke('download:stop'),
  onStatus: (callback) => {
    ipcRenderer.on('status:update', (_event, payload) => callback(payload));
  },
});
