'use strict';

const path = require('path');
const { BrowserWindow, WebContentsView, ipcMain, shell } = require('electron');

const TITLEBAR_HEIGHT = 40;
const popups = new Map();
let ipcRegistered = false;

function browserURL(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function stateFor(entry) {
  const url = entry.page.isDestroyed() ? '' : entry.page.getURL();
  return {
    platform: process.platform,
    title: entry.page.isDestroyed() ? 'AI Hub' : (entry.page.getTitle() || 'AI Hub'),
    url,
    canOpen: !!browserURL(url),
  };
}

function registerIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;
  // Only the local popup titlebar can invoke these actions. The remote page has
  // its own WebContents and never receives this preload/API.
  const entryFor = (event) => {
    const entry = popups.get(event.sender.id);
    return entry && !entry.popup.isDestroyed() && event.senderFrame === event.sender.mainFrame ? entry : null;
  };
  ipcMain.handle('popup:get-state', (event) => {
    const entry = entryFor(event);
    return entry ? stateFor(entry) : null;
  });
  ipcMain.handle('popup:open-external', async (event) => {
    const entry = entryFor(event);
    if (!entry || entry.page.isDestroyed()) return { ok: false, error: '窗口已关闭' };
    // Read the live page URL here, rather than trusting a URL supplied by a renderer.
    const url = browserURL(entry.page.getURL());
    if (!url) return { ok: false, error: '当前页面无法在浏览器中打开' };
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch {
      return { ok: false, error: '无法打开系统浏览器，请重试' };
    }
  });
  ipcMain.handle('popup:close', (event) => {
    const entry = entryFor(event);
    if (entry) entry.popup.close();
  });
}

function installPopupHandler(contents, { parent, session, preload, onCreated, show = true }) {
  registerIpc();
  contents.setWindowOpenHandler((details) => {
    if (!browserURL(details.url)) return { action: 'deny' };
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 520,
        height: 680,
        webPreferences: { session, preload, contextIsolation: true, nodeIntegration: false },
      },
      createWindow: (options) => {
        // Adopt Electron's guest WebContents to retain window.opener, postMessage,
        // POST submissions and OAuth redirects. The shell only renders the titlebar.
        const pageView = new WebContentsView({ webContents: options.webContents, webPreferences: options.webPreferences });
        const page = pageView.webContents;
        const popup = new BrowserWindow({
          width: options.width,
          height: options.height,
          minWidth: 360,
          minHeight: 240,
          parent: parent && !parent.isDestroyed() ? parent : undefined,
          show: false,
          autoHideMenuBar: true,
          minimizable: false,
          maximizable: false,
          ...(process.platform === 'darwin'
            ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 12, y: 12 } }
            : { frame: false }),
          title: 'AI Hub',
          webPreferences: {
            preload: path.join(__dirname, 'popup-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        });
        const entry = { popup, page };
        const shellId = popup.webContents.id;
        popups.set(shellId, entry);
        popup.contentView.addChildView(pageView);
        const layout = () => {
          if (popup.isDestroyed()) return;
          const [width, height] = popup.getContentSize();
          pageView.setBounds({ x: 0, y: TITLEBAR_HEIGHT, width, height: Math.max(0, height - TITLEBAR_HEIGHT) });
        };
        const update = () => {
          if (popup.isDestroyed() || popup.webContents.isDestroyed()) return;
          const state = stateFor(entry);
          popup.setTitle(state.title);
          popup.webContents.send('popup:state', state);
        };
        layout();
        popup.on('resize', layout);
        page.on('page-title-updated', update);
        page.on('did-navigate', update);
        page.on('did-navigate-in-page', update);
        page.on('did-stop-loading', update);
        // Keep normal page close/beforeunload behavior, including OAuth window.close().
        popup.on('close', (event) => {
          if (!page.isDestroyed()) {
            event.preventDefault();
            page.close({ waitForBeforeUnload: true });
          }
        });
        page.once('destroyed', () => { if (!popup.isDestroyed()) popup.destroy(); });
        popup.once('closed', () => {
          popups.delete(shellId);
          if (!page.isDestroyed()) page.close();
        });
        popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        popup.webContents.on('will-navigate', (event) => event.preventDefault());
        popup.webContents.once('did-finish-load', () => {
          update();
          if (show && !popup.isDestroyed()) popup.show();
        });
        popup.loadFile(path.join(__dirname, 'renderer/popup.html')).catch(() => {
          if (!popup.isDestroyed()) popup.destroy();
        });
        installPopupHandler(page, { parent: popup, session, preload, onCreated, show });
        if (onCreated) onCreated(popup);
        // Background-tab requests may not come with a pre-created guest; Electron
        // delegates navigation to createWindow in that case.
        if (!options.webContents) {
          page.loadURL(details.url, { httpReferrer: details.referrer }).catch(() => {});
        }
        return page;
      },
    };
  });
}

module.exports = { installPopupHandler };
