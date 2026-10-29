'use strict';

/**
 * 站点视图：每个站点一个 WebContentsView，内嵌在主窗口标题栏下方、侧边栏右侧。
 * 最近使用的若干个站点在后台保活（LRU），超出上限的回收并保存导航状态。
 */

const path = require('path');
const { WebContentsView, session } = require('electron');
const { partitionForSite, normalizeIcon } = require('../site-data');
const { installPopupHandler } = require('../popup-window');
const { captureNavigationState, restoreNavigationState } = require('../navigation-state');
const { TITLEBAR_HEIGHT, SIDEBAR_WIDTH, SIDEBAR_COLLAPSED_WIDTH } = require('../shared/ui-constants');
const { config, saveConfigSoon, normalizeKeepAlive } = require('./config');
const { cleanUA, attachGoogleCompat } = require('./google-compat');
const { log } = require('./logger');
const state = require('./state');

const { views } = state;
const SITE_PRELOAD = path.join(__dirname, '..', 'site-preload.js');

/** 销毁后台 WebContents 前保存的浏览历史；用于重建时恢复 history.state、滚动位置和表单状态。 */
const siteNavigationStates = new Map();
const sitePopups = new Map();

function closeSitePopups(id) {
  for (const popup of sitePopups.get(id) || []) {
    if (!popup.isDestroyed()) popup.destroy();
  }
  sitePopups.delete(id);
}

/** 当前侧边栏实际宽度（收起时为窄条） */
function sidebarWidth() {
  return config.sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH;
}

/** 最近进入 HTML 全屏的 webContents（用于 ESC 兜底退出） */
let htmlFullscreenWC = null;

/**
 * 监听 webContents 的 HTML5 全屏状态，并兜底 ESC 退出。
 * 背景：Windows 无边框窗口（frame:false）下，Chromium 默认的 ESC 退出全屏
 * 经常失效（Electron 已知问题），需要手动调用 document.exitFullscreen()。
 */
function watchFullscreen(wc, label) {
  if (!wc || wc.isDestroyed()) return;

  wc.on('did-enter-html-full-screen', () => {
    htmlFullscreenWC = wc;
    log('HTML 全屏进入:', label);
  });
  wc.on('did-leave-html-full-screen', () => {
    if (htmlFullscreenWC === wc) htmlFullscreenWC = null;
    log('HTML 全屏退出:', label);
  });

  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'Escape') return;
    // 无边框窗口下 ESC 退出全屏可能失效，手动兜底
    if (htmlFullscreenWC && !htmlFullscreenWC.isDestroyed()) {
      htmlFullscreenWC
        .executeJavaScript(
          '(function(){ if (document.fullscreenElement) { document.exitFullscreen(); return true; } return false; })()'
        )
        .catch(() => {});
    }
    // 窗口级全屏兜底（非 HTML 全屏场景）
    const win = state.mainWindow;
    if (win && !win.isDestroyed() && win.isFullScreen()) {
      win.setFullScreen(false);
    }
  });
}

/** 已完成 UA / 请求头 / 权限配置的 partition。这些设置挂在 session 上，每个 partition 只需配一次 */
const configuredPartitions = new Set();

function configureSession(partition) {
  const ses = session.fromPartition(partition);
  if (configuredPartitions.has(partition)) return ses;
  configuredPartitions.add(partition);
  try {
    ses.setUserAgent(cleanUA(ses.getUserAgent()));
  } catch (e) {
    console.error('[aihub] setUserAgent failed:', e);
  }
  attachGoogleCompat(ses);

  // 权限：放行麦克风（语音输入）、全屏、剪贴板写入、通知（后台站点回复完成时提醒），其余拒绝
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ['media', 'fullscreen', 'clipboard-sanitized-write', 'notifications'];
    callback(allowed.includes(permission));
  });
  return ses;
}

function createView(site) {
  const ses = configureSession(partitionForSite(site));

  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      preload: SITE_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  installPopupHandler(view.webContents, {
    parent: state.mainWindow,
    session: ses,
    preload: SITE_PRELOAD,
    onCreated: (popup) => {
      if (!sitePopups.has(site.id)) sitePopups.set(site.id, new Set());
      sitePopups.get(site.id).add(popup);
      popup.on('closed', () => sitePopups.get(site.id)?.delete(popup));
    },
  });

  watchFullscreen(view.webContents, site.name);

  view.webContents.on('did-start-loading', () => {
    log('站点加载中:', site.name, site.url);
  });
  view.webContents.on('did-finish-load', () => {
    log('站点加载完成:', site.name);
  });
  view.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log('站点加载失败:', site.name, code, desc, url);
  });
  // 自动拉取图标：记录页面声明的真实 favicon，未自定义图标时侧边栏使用它
  view.webContents.on('page-favicon-updated', (_e, favicons) => {
    let favicon = '';
    for (const candidate of favicons || []) {
      try {
        favicon = normalizeIcon(candidate);
        if (favicon) break;
      } catch {
        /* 跳过 http: 等渲染进程无法加载的地址 */
      }
    }
    if (!favicon || site.favicon === favicon || !config.sites.includes(site)) return;
    site.favicon = favicon;
    saveConfigSoon();
    const win = state.mainWindow;
    if (win && !win.isDestroyed()) {
      win.webContents.send('sites:favicon', { id: site.id, favicon });
    }
  });

  const savedNavigation = siteNavigationStates.get(site.id);
  siteNavigationStates.delete(site.id);
  restoreNavigationState(view.webContents, savedNavigation, site.url).catch((e) => {
    console.error('[aihub] navigation failed:', site.url, e);
  });

  return { view, site };
}

function ensureView(site) {
  let entry = views.get(site.id);
  if (!entry) {
    entry = createView(site);
    views.set(site.id, entry);
  }
  return entry;
}

function layoutViews() {
  const win = state.mainWindow;
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  const sw = sidebarWidth();
  for (const [id, entry] of views) {
    if (id === state.activeSiteId) {
      entry.view.setBounds({
        x: sw,
        y: TITLEBAR_HEIGHT,
        width: Math.max(0, w - sw),
        height: Math.max(0, h - TITLEBAR_HEIGHT),
      });
    }
  }
}

function showSite(id) {
  if (id === state.deletingSiteId) return;
  const site = config.sites.find((s) => s.id === id);
  const win = state.mainWindow;
  if (!site || !win) return;

  // 确保当前视图存在（若被回收则重建，从持久化分区恢复登录态）
  const entry = ensureView(site);
  state.activeSiteId = id;

  // views 的插入顺序即 LRU 顺序：当前站点移到末尾（最近使用）
  views.delete(id);
  views.set(id, entry);

  // 其余站点转入后台：移出窗口但保留 WebContents，页面继续运行（流式回复不中断）
  for (const [vid, other] of views) {
    if (vid === id) continue;
    other.view.setVisible(false);
    try {
      win.contentView.removeChildView(other.view);
    } catch (e) {
      /* 忽略未添加的情况 */
    }
  }
  evictBackgroundViews();

  // 重新 add 保证 z-order 在最上
  try {
    win.contentView.removeChildView(entry.view);
  } catch (e) {
    /* 忽略未添加的情况 */
  }
  win.contentView.addChildView(entry.view);
  entry.view.setVisible(!state.overlayOpen);
  layoutViews();

  // 记住上次站点，下次启动自动打开
  if (config.lastSiteId !== id) {
    config.lastSiteId = id;
    saveConfigSoon();
  }

  if (!win.webContents.isDestroyed()) {
    win.webContents.send('sites:activated', id);
  }
}

/**
 * 超出保活上限时回收最久未用的后台视图。
 * 回收前保存 Chromium 导航状态：除 partition 中的登录态外，
 * history.state、滚动位置和表单状态也会在重建时恢复。
 */
function evictBackgroundViews() {
  const limit = normalizeKeepAlive(config.keepAliveSites);
  for (const vid of [...views.keys()]) {
    if (views.size <= limit) break;
    if (vid !== state.activeSiteId) destroyView(vid, { preserveNavigation: true });
  }
}

function destroyView(id, options = {}) {
  const entry = views.get(id);
  if (!entry) {
    if (!options.preserveNavigation) siteNavigationStates.delete(id);
    return;
  }
  if (options.preserveNavigation) {
    try {
      const navState = captureNavigationState(entry.view.webContents);
      if (navState) siteNavigationStates.set(id, navState);
      else siteNavigationStates.delete(id);
    } catch (e) {
      siteNavigationStates.delete(id);
      log('保存站点导航状态失败:', entry.site.name, e.message);
    }
  } else {
    siteNavigationStates.delete(id);
  }
  try {
    const win = state.mainWindow;
    if (win && !win.isDestroyed()) {
      win.contentView.removeChildView(entry.view);
    }
  } catch (e) {
    /* ignore */
  }
  try {
    entry.view.webContents.close();
  } catch (e) {
    /* ignore */
  }
  views.delete(id);
}

function destroyAllViews() {
  for (const id of [...views.keys()]) destroyView(id);
  siteNavigationStates.clear();
  state.activeSiteId = null;
}

/** 当前站点视图重新放回窗口最上层并显示（弹窗关闭后调用） */
function restoreActiveView() {
  const win = state.mainWindow;
  const entry = views.get(state.activeSiteId);
  if (!win || win.isDestroyed() || !entry) return;
  try {
    win.contentView.removeChildView(entry.view);
  } catch (e) {
    /* ignore */
  }
  win.contentView.addChildView(entry.view);
  entry.view.setVisible(true);
  layoutViews();
}

module.exports = {
  watchFullscreen,
  showSite,
  layoutViews,
  evictBackgroundViews,
  destroyView,
  destroyAllViews,
  closeSitePopups,
  restoreActiveView,
};
