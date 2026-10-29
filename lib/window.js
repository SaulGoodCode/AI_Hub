'use strict';

/**
 * 主窗口：创建、唤起/隐藏、位置尺寸记忆、唤起后聚焦站点输入框、全局快捷键。
 */

const path = require('path');
const { app, BrowserWindow, globalShortcut, screen } = require('electron');
const { TITLEBAR_HEIGHT } = require('../shared/ui-constants');
const { config, saveConfig, flushPendingWrites } = require('./config');
const { showSite, layoutViews, destroyAllViews, watchFullscreen } = require('./site-views');
const { log } = require('./logger');
const state = require('./state');

const ROOT = path.join(__dirname, '..');

// ---------------- 异常自动重启（最多一次） ----------------
let relaunched = false;
let relaunchTimestamp = 0; // 记录上次自动重启时间，避免循环

/**
 * GPU 进程崩溃 / 渲染进程启动早期被杀时，带降级参数自动重启一次。
 * 返回 false 表示已经重启过（或 10s 内刚重启），不再重复。
 */
function relaunchOnce(extraArgs, reason) {
  if (relaunched || Date.now() - relaunchTimestamp <= 10000) return false;
  relaunched = true;
  relaunchTimestamp = Date.now();
  log(reason);
  app.relaunch({ args: [...process.argv.slice(1), ...extraArgs] });
  flushPendingWrites();
  app.exit(0);
  return true;
}

// ---------------- 唤起 / 隐藏 ----------------
function showMain() {
  const win = state.mainWindow;
  if (!win) {
    createWindow();
    return;
  }
  win.show();
  win.focus();
  // 唤起窗口后自动聚焦当前站点输入框，省去手动点击
  focusActiveSiteInput();
}

function toggleMain() {
  const win = state.mainWindow;
  if (!win) return;
  if (win.isVisible() && win.isFocused()) {
    win.hide();
  } else {
    showMain();
  }
}

function registerShortcut() {
  try {
    globalShortcut.unregisterAll();
  } catch (e) {
    /* ignore */
  }
  return globalShortcut.register(config.shortcut, toggleMain);
}

/** 取消上一次唤起挂起的聚焦重试（页面加载中反复按快捷键时，监听器和定时器不再叠加） */
let cancelPendingFocus = null;

/**
 * 唤起窗口后自动聚焦当前激活站点的对话输入框
 * - 关键：先把 Chromium 键盘焦点切到站点 webContents（否则按键被主 UI 侧边栏截获，
 *   DOM focus 了输入框也收不到键盘事件）
 * - 覆盖主流 AI 站点：Claude/DeepSeek/豆包 都用 <textarea> 作为输入框
 * - 兼容少数站点使用 contenteditable div（如部分新版页面）
 * - 第一次立即尝试；若站点正在加载，监听 did-finish-load 后再试；1s 后兜底再试一次
 */
function focusActiveSiteInput() {
  if (cancelPendingFocus) {
    cancelPendingFocus();
    cancelPendingFocus = null;
  }
  const { views, activeSiteId } = state;
  if (!activeSiteId || !views.has(activeSiteId)) return;
  const wc = views.get(activeSiteId).view.webContents;
  if (!wc || wc.isDestroyed()) return;

  // 关键步骤 1：让站点 webContents 获得键盘焦点（键盘事件路由进站点页面）
  try {
    wc.focus();
  } catch (e) {
    /* ignore */
  }

  // 在站点页面内执行：找输入框并聚焦（带回显用于日志）
  // eslint-disable-next-line no-useless-concat
  const FOCUS_JS =
    '(' +
    function () {
      const sels = [
        'textarea:not([readonly]):not([disabled])',
        'div[contenteditable="true"][aria-label*="消息" i]',
        'div[contenteditable="true"][aria-label*="输入" i]',
        'div[contenteditable="true"]',
        'input[type="text"]:not([readonly]):not([disabled])',
      ];
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return (
          r.width > 0 &&
          r.height > 0 &&
          s.display !== 'none' &&
          s.visibility !== 'hidden' &&
          s.opacity !== '0'
        );
      };
      let el = null;
      let matchedSel = '';
      for (const sel of sels) {
        let visible = [];
        try {
          visible = [...document.querySelectorAll(sel)].filter(isVisible);
        } catch (e) {
          continue;
        }
        if (visible.length) {
          // 取最后一个（AI 站点输入框通常在页面底部）
          el = visible[visible.length - 1];
          matchedSel = sel;
          break;
        }
      }
      if (!el) return { ok: false, reason: 'no input found' };
      try {
        // 只聚焦，不主动滚动页面：
        // scrollIntoView({block:'center'}) 会把页面底部的输入框拉到屏幕正中央，
        // 导致唤起后界面停在对话中间（用户反馈的问题）。浏览器 focus 一个滚动
        // 容器外的元素时本身就会自动滚动到可见位置（滚动量最小），所以无需手动滚。
        el.focus();
      } catch (e) {
        return { ok: false, reason: 'focus threw: ' + e.message };
      }
      return {
        ok: true,
        tag: el.tagName.toLowerCase(),
        sel: matchedSel,
        placeholder: el.placeholder || el.getAttribute('aria-label') || '',
      };
    } +
    ')()';

  const tryFocus = () => {
    if (wc.isDestroyed()) return;
    // 每次尝试前都把键盘焦点切到站点 webContents（窗口刚 show 时焦点可能仍落在主 UI）
    try {
      wc.focus();
    } catch (e) {
      /* ignore */
    }
    wc.executeJavaScript(FOCUS_JS, true)
      .then((res) => log('focus input:', JSON.stringify(res)))
      .catch((e) => log('focus failed:', e && e.message));
  };

  const timers = [];
  const tryLater = (ms) => timers.push(setTimeout(tryFocus, ms));
  if (wc.isLoading()) {
    const onLoad = () => tryLater(150);
    wc.once('did-finish-load', onLoad);
    cancelPendingFocus = () => {
      try {
        wc.removeListener('did-finish-load', onLoad);
      } catch (e) {
        /* ignore */
      }
      timers.forEach(clearTimeout);
    };
  } else {
    tryFocus();
    // 兜底：1s 后再试一次，应对站点页面局部刷新/输入框刚渲染的情况
    tryLater(1000);
    cancelPendingFocus = () => timers.forEach(clearTimeout);
  }
}

// ---------------- 窗口位置 / 尺寸记忆 ----------------
const WINDOW_DEFAULT_SIZE = { width: 1180, height: 760 };
const WINDOW_MIN_SIZE = { width: 960, height: 620 };

/**
 * 还原上次的窗口位置/尺寸。
 * 位置只在标题栏仍落在某块显示器工作区内时才沿用（外接显示器拔掉、分辨率变化后
 * 窗口可能跑到屏幕外拖不回来），否则只保留尺寸、由系统居中。
 */
function restoredWindowBounds() {
  const b = config.windowBounds;
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return { ...WINDOW_DEFAULT_SIZE };
  const width = Math.max(WINDOW_MIN_SIZE.width, Math.round(b.width));
  const height = Math.max(WINDOW_MIN_SIZE.height, Math.round(b.height));
  const x = Math.round(b.x);
  const y = Math.round(b.y);
  const titlebarVisible = screen.getAllDisplays().some(({ workArea: a }) => {
    const overlapX = Math.min(x + width, a.x + a.width) - Math.max(x, a.x);
    const overlapY = Math.min(y + TITLEBAR_HEIGHT, a.y + a.height) - Math.max(y, a.y);
    return overlapX >= 100 && overlapY > 0;
  });
  return titlebarVisible ? { x, y, width, height } : { width, height };
}

let boundsSaveTimer = null;
/**
 * 窗口创建后的实际尺寸。Windows 非整数缩放（如 175%）下无边框窗口创建时尺寸会被
 * 取整放大几个像素；若原样保存，每次重启都会再大一点。用户没动过窗口时不覆盖已保存的值。
 */
let createdBounds = null;

const sameBounds = (a, b) =>
  !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** 记录非最大化状态下的窗口位置/尺寸，以及是否最大化 */
function persistWindowBounds() {
  clearTimeout(boundsSaveTimer);
  boundsSaveTimer = null;
  const win = state.mainWindow;
  if (!win || win.isDestroyed()) return;
  // 最小化/全屏时的尺寸不是用户想要的窗口尺寸
  if (win.isMinimized() || win.isFullScreen()) return;
  const b = win.getNormalBounds();
  const next = { x: b.x, y: b.y, width: b.width, height: b.height };
  const maximized = win.isMaximized();
  const boundsChanged = !sameBounds(next, createdBounds) && !sameBounds(next, config.windowBounds);
  if (!boundsChanged && config.windowMaximized === maximized) return;
  if (boundsChanged) config.windowBounds = next;
  config.windowMaximized = maximized;
  saveConfig();
}

/** 拖动/缩放过程中事件很密集，停下 500ms 后再落盘 */
function schedulePersistWindowBounds() {
  clearTimeout(boundsSaveTimer);
  boundsSaveTimer = setTimeout(persistWindowBounds, 500);
}

// ---------------- 创建窗口 ----------------
function createWindow() {
  const isMac = process.platform === 'darwin';

  const win = new BrowserWindow({
    ...restoredWindowBounds(),
    minWidth: WINDOW_MIN_SIZE.width,
    minHeight: WINDOW_MIN_SIZE.height,
    show: false,
    alwaysOnTop: !!config.alwaysOnTop,
    backgroundColor: '#f6f7fb',
    // Windows 任务栏/标题栏图标（ico 多尺寸；macOS 由 .icns 提供，这里忽略）
    icon: isMac
      ? path.join(ROOT, 'build', 'icon.png')
      : path.join(ROOT, 'build', 'icon.ico'),
    // Windows：完全无边框（frame:false）+ 自定义标题栏接管窗口控制；
    // macOS：原生边框 + hiddenInset 隐藏标准标题栏（保留红绿灯），自定义标题栏融入
    frame: isMac ? true : false,
    titleBarStyle: isMac ? 'hiddenInset' : undefined,
    trafficLightPosition: isMac ? { x: 16, y: 12 } : undefined,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  state.mainWindow = win;

  createdBounds = win.getNormalBounds();

  win.loadFile(path.join(ROOT, 'renderer', 'index.html'));

  win.webContents.on('render-process-gone', (_e, details) => {
    log('渲染进程退出:', JSON.stringify(details));
    // 启动早期渲染进程被杀（常见于沙箱受限环境）：自动关闭沙箱重启一次
    if (details.reason === 'killed') {
      relaunchOnce(['--no-sandbox'], '渲染进程被异常终止，将尝试关闭沙箱重启…');
    }
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log('窗口页面加载失败:', code, desc, url);
  });
  watchFullscreen(win.webContents, '主窗口');

  win.on('resize', () => {
    layoutViews();
    schedulePersistWindowBounds();
  });
  win.on('move', schedulePersistWindowBounds);
  win.on('maximize', () => {
    if (!win.webContents.isDestroyed()) win.webContents.send('window:maximized', true);
    schedulePersistWindowBounds();
  });
  win.on('unmaximize', () => {
    if (!win.webContents.isDestroyed()) win.webContents.send('window:maximized', false);
    schedulePersistWindowBounds();
  });
  win.on('close', (e) => {
    persistWindowBounds();
    // 点关闭 = 隐藏到托盘；真正退出走托盘菜单 / Cmd+Q
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    destroyAllViews();
    state.mainWindow = null;
  });
  win.once('ready-to-show', () => {
    if (config.windowMaximized) win.maximize();
    win.show();
    log('主窗口已显示');
    // 自动打开上次使用的站点（没有则用第一个）
    const lastId = config.lastSiteId;
    const target = config.sites.find((s) => s.id === lastId) || config.sites[0];
    if (target) {
      showSite(target.id);
    }
    runDebugHooksIfRequested();
  });
}

/**
 * QA 调试钩子（AIHUB_SCREENSHOT / AIHUB_DIAG）。脚本在 scripts/ 下，不打进安装包；
 * 只有设置了对应环境变量才加载，正式运行零开销。
 */
function runDebugHooksIfRequested() {
  if (process.env.AIHUB_SCREENSHOT !== '1' && process.env.AIHUB_DIAG !== '1') return;
  try {
    require('../scripts/diag-hooks').run();
  } catch (e) {
    log('调试钩子加载失败（打包版本不含 scripts/）:', e && e.message);
  }
}

module.exports = {
  relaunchOnce,
  createWindow,
  showMain,
  toggleMain,
  registerShortcut,
};
