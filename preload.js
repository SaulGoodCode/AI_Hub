'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hub', {
  platform: process.platform,

  // 配置与站点
  getConfig: () => ipcRenderer.invoke('app:get-config'),
  listSites: () => ipcRenderer.invoke('sites:list'),
  activateSite: (id) => ipcRenderer.invoke('sites:activate', id),
  addSite: (payload) => ipcRenderer.invoke('sites:add', payload),
  updateSite: (payload) => ipcRenderer.invoke('sites:update', payload),
  removeSite: (id, deleteData) => ipcRenderer.invoke('sites:remove', id, !!deleteData),
  reorderSites: (ids) => ipcRenderer.invoke('sites:reorder', ids),
  reloadSite: (id) => ipcRenderer.invoke('sites:reload', id),

  // 设置
  updateShortcut: (shortcut) => ipcRenderer.invoke('settings:update-shortcut', shortcut),
  toggleSidebar: () => ipcRenderer.invoke('sidebar:toggle'),
  updateTheme: (theme) => ipcRenderer.invoke('settings:update-theme', theme),

  // 窗口控制
  minimize: () => ipcRenderer.send('window:minimize'),
  hide: () => ipcRenderer.send('window:hide'),
  togglePin: () => ipcRenderer.invoke('window:toggle-pin'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggle-max'),
  onMaximized: (cb) => ipcRenderer.on('window:maximized', (_e, maximized) => cb(maximized)),
  onPinned: (cb) => ipcRenderer.on('window:pinned', (_e, pinned) => cb(pinned)),

  // 弹窗遮挡控制：打开弹窗时隐藏站点视图
  setOverlay: (open) => ipcRenderer.send('overlay:set', open),

  // 主进程 → 渲染进程事件
  onActivated: (cb) => ipcRenderer.on('sites:activated', (_e, id) => cb(id)),
  onShortcutFailed: (cb) => ipcRenderer.on('shortcut:failed', (_e, shortcut) => cb(shortcut)),
  onThemeChanged: (cb) => ipcRenderer.on('theme:changed', (_e, info) => cb(info)),
});
