'use strict';

/** 系统托盘：常驻图标、右键菜单、置顶开关 */

const path = require('path');
const { app, Tray, Menu, nativeImage } = require('electron');
const { formatShortcut } = require('../shared/ui-constants');
const { config, saveConfig, PRODUCT_NAME } = require('./config');
const { showMain } = require('./window');
const { log } = require('./logger');
const state = require('./state');

let tray = null;

function setPinned(pinned) {
  config.alwaysOnTop = !!pinned;
  const win = state.mainWindow;
  if (win && !win.isDestroyed()) {
    win.setAlwaysOnTop(config.alwaysOnTop);
    if (!win.webContents.isDestroyed()) {
      win.webContents.send('window:pinned', config.alwaysOnTop);
    }
  }
  saveConfig();
  refreshTray();
  return config.alwaysOnTop;
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '显示主窗口', click: showMain },
    { label: `快捷键：${formatShortcut(config.shortcut, process.platform)}`, enabled: false },
    { type: 'separator' },
    {
      label: '总是置顶',
      type: 'checkbox',
      checked: !!config.alwaysOnTop,
      click: (item) => {
        setPinned(item.checked);
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function refreshTray() {
  if (!tray) return;
  const tip = `${PRODUCT_NAME} — 按 ${formatShortcut(config.shortcut, process.platform)} 唤起/隐藏`;
  tray.setToolTip(tip);
  tray.setContextMenu(buildTrayMenu());
  // 调试：实际渲染的 tooltip 写日志，便于排查 Windows 托盘显示问题
  log('[tray] tooltip:', tip);
}

function createTray() {
  // 托盘专用裁剪版：去掉米色大边距，托盘上看起来更紧凑
  const buildDir = path.join(__dirname, '..', 'build');
  let icon = nativeImage.createFromPath(path.join(buildDir, 'tray.png'));
  if (icon.isEmpty()) icon = nativeImage.createFromPath(path.join(buildDir, 'icon.png'));
  if (icon.isEmpty()) icon = nativeImage.createEmpty();
  icon = icon.resize({ width: 18, height: 18 });

  tray = new Tray(icon);
  refreshTray();
  tray.on('click', showMain); // Windows 单击托盘图标显示窗口
}

module.exports = { createTray, refreshTray, setPinned };
