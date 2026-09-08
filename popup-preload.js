'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('popup', {
  getState: () => ipcRenderer.invoke('popup:get-state'),
  openExternal: () => ipcRenderer.invoke('popup:open-external'),
  close: () => ipcRenderer.invoke('popup:close'),
  onState: (callback) => ipcRenderer.on('popup:state', (_event, state) => callback(state)),
});
