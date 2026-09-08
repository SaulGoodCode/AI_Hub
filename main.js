'use strict';

/**
 * AI Hub 主进程
 * - 单窗口多标签：WebContentsView 内嵌第三方 AI 网页
 * - 默认共享持久化会话，可按站点选择独立数据
 * - 全局快捷键唤起/隐藏（默认 Ctrl+Shift+Space，可在 config.json 修改）
 * - 系统托盘常驻，关闭按钮=隐藏到托盘
 * 支持 Windows 11 / macOS
 */

const {
  app,
  BrowserWindow,
  WebContentsView,
  session,
  globalShortcut,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  nativeTheme,
} = require('electron');

// 防护：若因 ELECTRON_RUN_AS_NODE 环境变量导致以纯 Node 模式运行，给出明确提示
if (!app) {
  console.error(
    '[aihub] Electron 以纯 Node 模式启动（app API 不可用）。\n' +
      '      请检查系统环境变量是否设置了 ELECTRON_RUN_AS_NODE=1（多为某些工具遗留），\n' +
      '      删除该变量后重启；或使用 npm start（启动脚本会自动清除该变量）。'
  );
  process.exit(1);
}
const path = require('path');
const fs = require('fs');
const { partitionForSite, siteURL, migrateSiteData, clearSiteData, cleanupPendingPartitions } = require('./site-data');
const { installPopupHandler } = require('./popup-window');

/**
 * 把 Electron accelerator 字符串渲染为用户友好文本（按当前平台）。
 * "CommandOrControl+Space" → Windows: "Ctrl+Space"，macOS: "⌘+Space"。
 * 此函数在主进程 / 渲染进程各有一份（主进程托盘 tooltip/菜单要用），
 * 行为必须与 renderer/app.js 中的 formatShortcut 保持一致。
 */
function formatShortcut(accel) {
  if (!accel) return '';
  const isMac = process.platform === 'darwin';
  return accel
    .split('+')
    .map((k) => {
      if (k === 'CommandOrControl') return isMac ? '⌘' : 'Ctrl';
      if (k === 'Control') return 'Ctrl';
      if (k === 'Command' || k === 'Cmd') return '⌘';
      if (k === 'Option') return 'Alt';
      if (k === 'Super') return 'Win';
      return k;
    })
    .join('+');
}

const TITLEBAR_HEIGHT = 36; // 必须与 renderer/style.css 中的 --titlebar-height 一致
const PRODUCT_NAME = 'AI Hub';

const SIDEBAR_WIDTH = 232; // 展开时侧边栏宽度（须与 renderer/style.css 中 --sidebar-width 一致）
const SIDEBAR_COLLAPSED_WIDTH = 60; // 收起时侧边栏宽度（只留图标）

// ---------------- 配置 ----------------
const DEFAULT_CONFIG = {
  shortcut: 'Ctrl+Shift+Space',
  alwaysOnTop: false,
  sidebarCollapsed: false,
  lastSiteId: null,
  // 主题：'light' | 'dark' | 'system'（跟随系统）
  // 通过 nativeTheme.themeSource 同步进内置浏览器（prefers-color-scheme）
  theme: 'system',
  sites: [
    { id: 'claude', name: 'Claude', url: 'https://claude.ai/chat/', enabled: true, useIndependentData: false },
    { id: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/', enabled: true, useIndependentData: false },
    { id: 'doubao', name: '豆包', url: 'https://www.doubao.com/chat/', enabled: true, useIndependentData: false },
    { id: 'gemini', name: 'Gemini', url: 'https://gemini.google.com/app', enabled: true, useIndependentData: false },
  ],
};

// v0.1.0 的内置站点集合。老版本写出的 config.json 没有 builtinSeen 字段，
// 迁移时用它作为"已下发过"的初始值，这样只会补上之后版本新增的内置站点。
const LEGACY_BUILTIN_IDS = ['claude', 'deepseek', 'doubao'];

let configPath = '';
let config = null;
let mainWindow = null;
let tray = null;
/** @type {Map<string, {view: WebContentsView, site: object}>} */
let views = new Map();
let activeSiteId = null;
let deletingSiteId = null;
let overlayOpen = false;
const sitePopups = new Map();
let relaunchedForGpu = false;

// ---------------- 日志（写入 userData/aihub.log，便于排查） ----------------
// 让进程 stdout/stderr pipe 关闭时不再抛 EPIPE（开发模式下 npm 把 electron 输出管道化，
// 用户关闭终端/SIGTERM 时父进程 pipe 断开，console.log 继续写会 EPIPE 触发 uncaughtException）
try {
  process.stdout.on('error', (e) => {
    if (e && e.code !== 'EPIPE') console.error('stdout error:', e);
  });
  process.stderr.on('error', (e) => {
    if (e && e.code !== 'EPIPE') console.error('stderr error:', e);
  });
} catch (e) {
  /* ignore */
}

function log(...args) {
  const line = '[' + new Date().toISOString() + '] ' + args.join(' ');
  // console.log 自身在 stdout pipe 关闭时会 EPIPE，这里也包一层防止主进程崩溃
  try {
    console.log(line);
  } catch (e) {
    /* ignore - stdout pipe 关闭不影响功能 */
  }
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'aihub.log'), line + '\n');
  } catch (e) {
    /* ignore */
  }
}

// GPU 不可用（远程桌面/虚拟机/驱动/沙箱受限环境）时自动降级：
// GPU 子进程反复崩溃 → 自动带 --disable-gpu --no-sandbox 重启一次（最多一次）
if (process.argv.includes('--disable-gpu') || process.env.AIHUB_NO_GPU === '1') {
  app.disableHardwareAcceleration();
}
let relaunchTimestamp = 0; // 记录上次自动重启时间，避免循环
app.on('child-process-gone', (_event, details) => {
  if (details.type !== 'GPU') return;
  if (app.commandLine.hasSwitch('disable-gpu')) {
    // 已处于软件渲染仍出现 GPU 子进程退出：Chromium 会自动走软件方案，忽略
    return;
  }
  if (!relaunchedForGpu && Date.now() - relaunchTimestamp > 10000) {
    relaunchedForGpu = true;
    relaunchTimestamp = Date.now();
    log('GPU 进程异常退出，将以软件渲染+关闭沙箱模式重启…');
    app.relaunch({ args: [...process.argv.slice(1), '--disable-gpu', '--no-sandbox'] });
    app.exit(0);
  }
});

function loadConfig() {
  configPath = path.join(app.getPath('userData'), 'config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    config = JSON.parse(raw);
    if (!Array.isArray(config.sites)) config.sites = [];
  } catch {
    config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    saveConfig();
  }
  if (migrateSiteData(config)) saveConfig();
  config.shortcut = config.shortcut || DEFAULT_CONFIG.shortcut;
  config.alwaysOnTop = !!config.alwaysOnTop;
  config.sidebarCollapsed = !!config.sidebarCollapsed;
  config.lastSiteId = config.lastSiteId || null;
  // 主题：'light'/'dark'/'system'，非法值回退 'system'
  if (!['light', 'dark', 'system'].includes(config.theme)) config.theme = 'system';
  migrateBuiltinSites();
}

/** 两个网址是否指向同一站点（只比 hostname，忽略路径差异） */
function sameHost(a, b) {
  try {
    return new URL(a).hostname.toLowerCase() === new URL(b).hostname.toLowerCase();
  } catch (e) {
    return false;
  }
}

/**
 * 内置站点增量下发：把新版本新增的内置站点补进已有 config.json。
 * builtinSeen 记录"已经下发过"的内置 id —— 只补没见过的，
 * 用户主动删掉的内置站点不会在下次启动时复活。
 * 已经手动加过同域名站点的（比如自己添过 Gemini），也不会再补一份重复的。
 */
function migrateBuiltinSites() {
  if (!Array.isArray(config.builtinSeen)) {
    config.builtinSeen = LEGACY_BUILTIN_IDS.slice();
  }
  let changed = false;
  for (const site of DEFAULT_CONFIG.sites) {
    if (config.builtinSeen.includes(site.id)) continue;
    config.builtinSeen.push(site.id);
    changed = true;
    if (!config.sites.some((s) => s.id === site.id || sameHost(s.url, site.url))) {
      config.sites.push({ ...site });
      log('已补充内置站点:', site.name, site.url);
    }
  }
  if (changed) saveConfig();
}

/** 应用主题到 nativeTheme（影响整个应用 + 所有内置网页的 prefers-color-scheme） */
function applyTheme() {
  try {
    nativeTheme.themeSource = config.theme || 'system';
    log('主题已应用:', config.theme, '(实际渲染: ' + (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') + ')');
  } catch (e) {
    log('应用主题失败:', e && e.message);
  }
}

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

function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    console.error('[aihub] save config failed:', e);
  }
}

// ---------------- UA 清理 ----------------
// 去掉 Electron / 应用标识，让第三方站点识别为普通 Chrome，减少风控/兼容问题。
// 另外把 Chrome 版本号降到 major.0.0.0：真实 Chrome 自 110 起做 UA reduction，
// 只报大版本；带完整版本号（如 150.0.7871.212）反而是嵌入式浏览器的明显指纹。
function cleanUA(ua) {
  return ua
    .replace(new RegExp('\\s' + PRODUCT_NAME.replace(/\s+/g, '') + '/[\\d.]+', 'i'), '')
    .replace(/\sElectron\/[\d.]+/i, '')
    .replace(/\sElectron\//i, ' ')
    .replace(/\bChrome\/(\d+)[\d.]*/i, 'Chrome/$1.0.0.0');
}

// ---------------- Google 登录兼容层 ----------------
// 症状：内嵌浏览器登录 Google 账号（Gemini）时，先弹 Windows 安全密钥对话框，
//       关掉后输账号又被拦："请尝试使用其他浏览器"。
// 成因：Electron 的 UA 客户端提示品牌列表只有 "Chromium"，真实 Chrome 一定同时含
//       "Google Chrome"，Google 据此判定为嵌入式浏览器。安全密钥弹窗则是 Google 的
//       passkey 条件式 UI 触发了 Chromium 的 Windows Hello 集成。
// 对策：请求头侧在这里补齐 Chrome 品牌；页面侧（navigator.userAgentData + 关 WebAuthn）
//       由 site-preload.js 负责，两侧必须一致，否则对不上更可疑。
const SITE_PRELOAD = path.join(__dirname, 'site-preload.js');
const CHROME_FULL_VERSION = process.versions.chrome; // 150.0.7871.212
const CHROME_MAJOR_VERSION = CHROME_FULL_VERSION.split('.')[0]; // 150

// google.com / google.cn / google.com.hk / google.co.jp 等各地区域名，外加 Google 自家的静态资源域
const GOOGLE_HOST_RE =
  /(^|\.)(google\.[a-z]{2,3}(\.[a-z]{2})?|gstatic\.com|googleapis\.com|googleusercontent\.com|youtube\.com)$/i;

/** Chromium 报的平台名（真实 Chrome 的 Sec-CH-UA-Platform 取值） */
function chromePlatform() {
  if (process.platform === 'darwin') return 'macOS';
  if (process.platform === 'win32') return 'Windows';
  return 'Linux';
}

/**
 * 往品牌列表里补一项 "Google Chrome"。
 * 保留 Chromium 自己生成的 GREASE 项（如 "Not;A=Brand"）而不是整串重写，
 * 这样和浏览器每个版本自带的伪装项保持一致，最接近真实 Chrome。
 */
function withChromeBrand(value, version) {
  const entry = '"Google Chrome";v="' + version + '"';
  if (!value) return '"Not;A=Brand";v="8", "Chromium";v="' + version + '", ' + entry;
  if (/"Google Chrome"/i.test(value)) return value;
  return value + ', ' + entry;
}

/**
 * Accept-Language 头：真实 Chrome 发 "zh-CN,zh;q=0.9"（主语言 + 基础语言），
 * Electron 只发 "zh-CN"。与 site-preload.js 里改写的 navigator.languages 保持一致。
 */
function buildAcceptLanguage() {
  let locale = 'en-US';
  try {
    locale = app.getLocale() || locale;
  } catch (e) {
    /* app 未 ready 时兜底 */
  }
  const base = locale.split('-')[0];
  return base && base !== locale ? locale + ',' + base + ';q=0.9' : locale;
}

/**
 * 给站点 session 挂上 Google 请求头补丁。
 * 只处理 Google 域名，其余请求原样透传，避免影响别的站点。
 */
function attachGoogleCompat(ses) {
  const acceptLanguage = buildAcceptLanguage();
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    let hostname = '';
    try {
      hostname = new URL(details.url).hostname;
    } catch (e) {
      /* 非法 URL：原样放行 */
    }
    if (!GOOGLE_HOST_RE.test(hostname)) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }

    const headers = details.requestHeaders;
    // Chromium 发出的头大小写不固定，按小写名找到实际的 key
    const keyOf = (name) =>
      Object.keys(headers).find((k) => k.toLowerCase() === name) || name;

    // 低熵提示：真实 Chrome 每个请求都带，缺了同样可疑，直接补齐
    const uaKey = keyOf('sec-ch-ua');
    headers[uaKey] = withChromeBrand(headers[uaKey], CHROME_MAJOR_VERSION);
    headers[keyOf('sec-ch-ua-mobile')] = '?0';
    headers[keyOf('sec-ch-ua-platform')] = '"' + chromePlatform() + '"';
    headers[keyOf('accept-language')] = acceptLanguage;

    // 高熵提示：只有站点用 Accept-CH 要过才会出现，没有就别凭空加（凭空加本身才反常）
    const fullListKey = keyOf('sec-ch-ua-full-version-list');
    if (headers[fullListKey]) {
      headers[fullListKey] = withChromeBrand(headers[fullListKey], CHROME_FULL_VERSION);
    }

    callback({ requestHeaders: headers });
  });
}

// ---------------- 站点视图 ----------------
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
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen()) {
      mainWindow.setFullScreen(false);
    }
  });
}

function createView(site) {
  const partition = partitionForSite(site);
  const ses = session.fromPartition(partition);
  try {
    ses.setUserAgent(cleanUA(ses.getUserAgent()));
  } catch (e) {
    console.error('[aihub] setUserAgent failed:', e);
  }
  attachGoogleCompat(ses);

  // 权限：放行麦克风（语音输入）、全屏、剪贴板写入，其余拒绝
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ['media', 'fullscreen', 'clipboard-sanitized-write'];
    callback(allowed.includes(permission));
  });

  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      preload: SITE_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  installPopupHandler(view.webContents, {
    parent: mainWindow,
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

  view.webContents.loadURL(site.url).catch((e) => {
    console.error('[aihub] loadURL failed:', site.url, e);
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
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [w, h] = mainWindow.getContentSize();
  const sw = sidebarWidth();
  for (const [id, entry] of views) {
    if (id === activeSiteId) {
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
  if (id === deletingSiteId) return;
  const site = config.sites.find((s) => s.id === id);
  if (!site || !mainWindow) return;

  // 需求：切换站点即销毁上一个站点视图，释放内存（登录态在 partition 中持久化，不丢失）
  for (const vid of [...views.keys()]) {
    if (vid !== id) destroyView(vid);
  }

  // 确保当前视图存在（若被销毁则重建，从持久化分区恢复登录态）
  const entry = ensureView(site);
  activeSiteId = id;

  // 重新 add 保证 z-order 在最上
  try {
    mainWindow.contentView.removeChildView(entry.view);
  } catch (e) {
    /* 忽略未添加的情况 */
  }
  mainWindow.contentView.addChildView(entry.view);
  entry.view.setVisible(!overlayOpen);
  layoutViews();

  // 记住上次站点，下次启动自动打开
  if (config.lastSiteId !== id) {
    config.lastSiteId = id;
    saveConfig();
  }

  if (!mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('sites:activated', id);
  }
}

function destroyView(id) {
  const entry = views.get(id);
  if (!entry) return;
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.contentView.removeChildView(entry.view);
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
  activeSiteId = null;
}

// ---------------- 窗口 ----------------
function showMain() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  mainWindow.show();
  mainWindow.focus();
  // 唤起窗口后自动聚焦当前站点输入框，省去手动点击
  focusActiveSiteInput();
}

/**
 * 唤起窗口后自动聚焦当前激活站点的对话输入框
 * - 关键：先把 Chromium 键盘焦点切到站点 webContents（否则按键被主 UI 侧边栏截获，
 *   DOM focus 了输入框也收不到键盘事件）
 * - 覆盖主流 AI 站点：Claude/DeepSeek/豆包 都用 <textarea> 作为输入框
 * - 兼容少数站点使用 contenteditable div（如部分新版页面）
 * - 第一次立即尝试；若站点正在加载，监听 did-finish-load 后再试；1s 后兜底再试一次
 */
function focusActiveSiteInput() {
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

  if (wc.isLoading()) {
    wc.once('did-finish-load', () => setTimeout(tryFocus, 150));
  } else {
    tryFocus();
    // 兜底：1s 后再试一次，应对站点页面局部刷新/输入框刚渲染的情况
    setTimeout(tryFocus, 1000);
  }
}

function toggleMain() {
  if (!mainWindow) return;
  if (mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
  } else {
    showMain();
  }
}

function createWindow() {
  const isMac = process.platform === 'darwin';

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 620,
    show: false,
    alwaysOnTop: !!config.alwaysOnTop,
    backgroundColor: '#f6f7fb',
    // Windows 任务栏/标题栏图标（ico 多尺寸；macOS 由 .icns 提供，这里忽略）
    icon: isMac
      ? path.join(__dirname, 'build', 'icon.png')
      : path.join(__dirname, 'build', 'icon.ico'),
    // Windows：完全无边框（frame:false）+ 自定义标题栏接管窗口控制；
    // macOS：原生边框 + hiddenInset 隐藏标准标题栏（保留红绿灯），自定义标题栏融入
    frame: isMac ? true : false,
    titleBarStyle: isMac ? 'hiddenInset' : undefined,
    trafficLightPosition: isMac ? { x: 16, y: 12 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log('渲染进程退出:', JSON.stringify(details));
    // 启动早期渲染进程被杀（常见于沙箱受限环境）：自动关闭沙箱重启一次
    if (
      details.reason === 'killed' &&
      !relaunchedForGpu &&
      Date.now() - relaunchTimestamp > 10000
    ) {
      relaunchedForGpu = true;
      relaunchTimestamp = Date.now();
      log('渲染进程被异常终止，将尝试关闭沙箱重启…');
      app.relaunch({ args: [...process.argv.slice(1), '--no-sandbox'] });
      app.exit(0);
    }
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log('窗口页面加载失败:', code, desc, url);
  });
  watchFullscreen(mainWindow.webContents, '主窗口');

  mainWindow.on('resize', layoutViews);
  mainWindow.on('maximize', () => {
    if (!mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('window:maximized', true);
  });
  mainWindow.on('unmaximize', () => {
    if (!mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('window:maximized', false);
  });
  mainWindow.on('close', (e) => {
    // 点关闭 = 隐藏到托盘；真正退出走托盘菜单 / Cmd+Q
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    destroyAllViews();
    mainWindow = null;
  });
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    log('主窗口已显示');
    // 自动打开上次使用的站点（没有则用第一个）
    const lastId = config.lastSiteId;
    const target = config.sites.find((s) => s.id === lastId) || config.sites[0];
    if (target) {
      showSite(target.id);
    }
    runDebugHooks();
  });
}

// ---------------- 快捷键 ----------------
function registerShortcut() {
  try {
    globalShortcut.unregisterAll();
  } catch (e) {
    /* ignore */
  }
  return globalShortcut.register(config.shortcut, toggleMain);
}

// ---------------- 托盘 ----------------
function setPinned(pinned) {
  config.alwaysOnTop = !!pinned;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setAlwaysOnTop(config.alwaysOnTop);
    if (!mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('window:pinned', config.alwaysOnTop);
    }
  }
  saveConfig();
  refreshTray();
  return config.alwaysOnTop;
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '显示主窗口', click: showMain },
    { label: `快捷键：${formatShortcut(config.shortcut)}`, enabled: false },
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
  const tip = `${PRODUCT_NAME} — 按 ${formatShortcut(config.shortcut)} 唤起/隐藏`;
  tray.setToolTip(tip);
  tray.setContextMenu(buildTrayMenu());
  // 调试：实际渲染的 tooltip 写日志，便于排查 Windows 托盘显示问题
  log('[tray] tooltip:', tip);
}

function createTray() {
  // 托盘专用裁剪版：去掉米色大边距，托盘上看起来更紧凑
  const iconPath = path.join(__dirname, 'build', 'tray.png');
  let icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'));
  if (icon.isEmpty()) icon = nativeImage.createEmpty();
  icon = icon.resize({ width: 18, height: 18 });

  tray = new Tray(icon);
  refreshTray();
  tray.on('click', showMain); // Windows 单击托盘图标显示窗口
}

// ---------------- IPC ----------------
function registerIpc() {
  ipcMain.handle('app:get-config', () => ({
    platform: process.platform,
    shortcut: config.shortcut,
    alwaysOnTop: !!config.alwaysOnTop,
    sidebarCollapsed: !!config.sidebarCollapsed,
    theme: config.theme,
    themeResolved: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    version: app.getVersion(),
  }));

  // 切换亮/暗/跟随系统主题：写入配置 + 应用 nativeTheme.themeSource，
  // 内置网页的 prefers-color-scheme 会自动跟随（Claude/DeepSeek/豆包等支持暗色的站点即时生效）
  ipcMain.handle('settings:update-theme', (_e, theme) => {
    if (!['light', 'dark', 'system'].includes(theme)) {
      return { ok: false, error: '无效主题: ' + theme };
    }
    config.theme = theme;
    saveConfig();
    applyTheme();
    // 主题变化后刷新当前站点视图（部分站点加载时缓存配色，重载后才会切）
    if (activeSiteId && views.has(activeSiteId)) {
      const wc = views.get(activeSiteId).view.webContents;
      try {
        wc.reload();
      } catch (e) {
        /* ignore */
      }
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('theme:changed', {
        theme: config.theme,
        resolved: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
      });
    }
    return { ok: true, theme: config.theme };
  });

  // 系统主题变化（仅 theme='system' 时由 OS 驱动，如 Windows 的深浅模式切换）
  nativeTheme.on('updated', () => {
    if (mainWindow && !mainWindow.isDestroyed() && config.theme === 'system') {
      mainWindow.webContents.send('theme:changed', {
        theme: 'system',
        resolved: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
      });
    }
  });

  // 侧边栏收起/展开
  ipcMain.handle('sidebar:toggle', () => {
    config.sidebarCollapsed = !config.sidebarCollapsed;
    saveConfig();
    layoutViews();
    log('侧边栏' + (config.sidebarCollapsed ? '收起' : '展开'));
    return config.sidebarCollapsed;
  });

  // 更新全局快捷键：先注册新的（成功才替换），再卸载旧的
  ipcMain.handle('settings:update-shortcut', (_e, shortcut) => {
    const accel = String(shortcut || '').trim();
    if (!accel) return { ok: false, error: '快捷键不能为空' };
    if (accel === config.shortcut) return { ok: true, shortcut: accel };

    let ok = false;
    try {
      ok = globalShortcut.register(accel, toggleMain);
    } catch (e) {
      return { ok: false, error: '快捷键格式不正确：' + e.message };
    }
    if (!ok) {
      return { ok: false, error: '快捷键注册失败，可能已被其他应用占用' };
    }

    // 注册成功：卸载旧的，更新配置与托盘显示
    try {
      globalShortcut.unregister(config.shortcut);
    } catch (e) {
      /* ignore */
    }
    config.shortcut = accel;
    saveConfig();
    refreshTray();
    log('全局快捷键已更新:', accel);
    return { ok: true, shortcut: accel };
  });

  ipcMain.handle('sites:list', () => config.sites);

  ipcMain.handle('sites:activate', (_e, id) => {
    const site = config.sites.find((s) => s.id === id);
    if (site) {
      showSite(id);
    }
    return !!site;
  });

  ipcMain.handle('sites:add', (_e, payload) => {
    if (deletingSiteId) return { ok: false, error: '正在删除站点，请稍后重试' };
    const name = String((payload && payload.name) || '').trim();
    const url = String((payload && payload.url) || '').trim();
    if (!name) return { ok: false, error: '请输入站点名称' };
    try { siteURL(url); } catch { return { ok: false, error: '请输入以 http(s):// 开头的合法网址' }; }

    const id = 'site-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    const site = { id, name, url, enabled: true, useIndependentData: payload.useIndependentData === true };
    config.sites.push(site);
    saveConfig();

    showSite(site.id);
    return { ok: true, site };
  });

  ipcMain.handle('sites:remove', async (_e, id, deleteData) => {
    if (deletingSiteId) return { ok: false, error: '正在删除站点，请稍后重试' };
    const site = config.sites.find((s) => s.id === id);
    if (!site) return { ok: false, error: '站点不存在或已被删除' };
    deletingSiteId = id;
    destroyView(id);
    closeSitePopups(id);
    try {
      // 独立站点删除后无法通过新增 ID 恢复，必须清空；共享站点仍由用户选择。
      if (site.useIndependentData === true || deleteData) {
        await clearSiteData(session.fromPartition(partitionForSite(site)), site, config.sites);
        if (site.useIndependentData) {
          if (!Array.isArray(config.pendingDataDeletions)) config.pendingDataDeletions = [];
          if (!config.pendingDataDeletions.includes(id)) config.pendingDataDeletions.push(id);
        }
      }
      config.sites = config.sites.filter((s) => s.id !== id);
      if (config.lastSiteId === id) config.lastSiteId = null;
      saveConfig();
    } catch (error) {
      log('删除站点数据失败:', site.name, error.message);
      deletingSiteId = null;
      if (activeSiteId === id) showSite(id);
      return { ok: false, error: '部分本地数据可能已清除，站点仍保留。请重试：' + error.message };
    } finally {
      deletingSiteId = null;
    }
    if (activeSiteId === id) {
      activeSiteId = null;
      if (config.sites.length > 0) showSite(config.sites[0].id);
    }
    return { ok: true };
  });

  // 编辑站点：改名/改网址。保留原 id（登录态 partition 不丢）
  ipcMain.handle('sites:update', (_e, payload) => {
    if (deletingSiteId) return { ok: false, error: '正在删除站点，请稍后重试' };
    const id = String((payload && payload.id) || '');
    const name = String((payload && payload.name) || '').trim();
    const url = String((payload && payload.url) || '').trim();
    const site = config.sites.find((s) => s.id === id);
    if (!site) return { ok: false, error: '站点不存在或已被删除' };
    if (!name) return { ok: false, error: '请输入站点名称' };
    try { siteURL(url); } catch { return { ok: false, error: '请输入以 http(s):// 开头的合法网址' }; }

    const urlChanged = site.url !== url;
    const useIndependentData = typeof payload.useIndependentData === 'boolean'
      ? payload.useIndependentData : site.useIndependentData;
    const storageChanged = useIndependentData !== site.useIndependentData;
    site.name = name;
    site.url = url;
    site.useIndependentData = useIndependentData;
    saveConfig();

    // 切换模式仅切换会话，保留原分区，避免自动合并账号或删除登录态。
    if (urlChanged || storageChanged) {
      destroyView(id);
      closeSitePopups(id);
      if (activeSiteId === id) {
        showSite(id); // showSite 内部会 ensureView 按新 url 重建
      }
    }
    return { ok: true, site };
  });

  ipcMain.handle('sites:reload', (_e, id) => {
    const entry = views.get(id);
    if (entry && !entry.view.webContents.isDestroyed()) entry.view.webContents.reload();
    return true;
  });

  // 拖动排序：按传入的 id 数组重排 config.sites
  ipcMain.handle('sites:reorder', (_e, orderedIds) => {
    if (!Array.isArray(orderedIds)) return { ok: false, error: '参数错误' };
    const map = new Map(config.sites.map((s) => [s.id, s]));
    const seen = new Set();
    const next = [];
    for (const id of orderedIds) {
      const site = map.get(id);
      if (site && !seen.has(id)) {
        next.push(site);
        seen.add(id);
      }
    }
    // 兜底：未出现在列表中的站点（异常情况）追加到末尾，避免丢配置
    for (const site of config.sites) {
      if (!seen.has(site.id)) next.push(site);
    }
    config.sites = next;
    saveConfig();
    return { ok: true };
  });

  ipcMain.handle('window:toggle-pin', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    const next = !mainWindow.isAlwaysOnTop();
    return setPinned(next);
  });

  // 最大化 / 还原（无边框窗口的自定义标题栏按钮）
  ipcMain.handle('window:toggle-max', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });

  // 弹窗（设置/添加站点）打开时隐藏站点视图，避免原生子视图遮挡弹窗；关闭时恢复
  ipcMain.on('overlay:set', (_e, open) => {
    overlayOpen = !!open;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const entry = views.get(activeSiteId);
    if (!entry) return;
    if (open) {
      entry.view.setVisible(false);
    } else {
      try {
        mainWindow.contentView.removeChildView(entry.view);
      } catch (e) {
        /* ignore */
      }
      mainWindow.contentView.addChildView(entry.view);
      entry.view.setVisible(true);
      layoutViews();
    }
  });

  ipcMain.on('window:minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  });
  ipcMain.on('window:hide', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  });
}

// ---------------- 应用生命周期 ----------------

/**
 * 开发期文件变化触发器（仅在 AIHUB_DEV_PORT 环境变量存在时启用）。
 * launch.js 启动 electron 子进程前会选一个空闲端口，并设置该环境变量；
 * 随后 launch.js 用 fs.watch 监听 main.js / preload.js / renderer/ 变化，
 * 通过 POST 请求通知主进程做对应动作：
 *   - target=renderer|main|preload  → webContents.reload()（preload 必须重新加载）
 *   - target=main-relaunch            → app.relaunch()（主进程代码无法热替换）
 * 打包/正式运行时不会传入该环境变量，server 不会启动，对发布版本零开销。
 */
function startDevServerIfAny() {
  const port = parseInt(process.env.AIHUB_DEV_PORT, 10);
  if (!port) return;

  const http = require('http');
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url) {
      res.writeHead(404);
      res.end();
      return;
    }
    // 简易 POST body 收集
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      let payload = {};
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        /* ignore */
      }
      const target = payload.target || req.url.replace(/[?#].*$/, '').replace(/^\/+/, '');
      const file = payload.file || '';
      log(`[dev] reload 触发: ${target}${file ? ' (' + file + ')' : ''}`);

      const doReload = () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.reload();
          if (mainWindow.webContents.isLoading()) {
            mainWindow.webContents.once('did-finish-load', () => showMain());
          } else {
            showMain();
          }
        }
      };

      switch (target) {
        case 'renderer':
        case 'preload':
          doReload();
          res.end(JSON.stringify({ ok: true, action: 'reload' }));
          break;
        case 'main-relaunch':
          // 用户确认主进程代码变化需要完整重启
          // 这里延迟一小会儿让响应回到 launch.js 再退出
          res.end(JSON.stringify({ ok: true, action: 'relaunch' }));
          setTimeout(() => {
            app.isQuitting = true;
            app.relaunch();
            app.exit(0);
          }, 150);
          break;
        default:
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: 'unknown target' }));
      }
    });
  });

  server.on('error', (e) => log('[dev] HTTP server error:', e.message));
  server.listen(port, '127.0.0.1', () => {
    log(`[dev] reload 钩子已就绪: http://127.0.0.1:${port}`);
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());

  app.whenReady().then(() => {
    app.setAppUserModelId('com.saul.aihub');
    loadConfig();
    log('应用启动, platform=' + process.platform, 'argv=' + JSON.stringify(process.argv));
    applyTheme(); // 在创建窗口前应用主题（窗口背景/内置网页配色都会跟随）
    if (cleanupPendingPartitions(config, app.getPath('userData'), log)) saveConfig();
    createWindow();
    createTray();

    // 隐藏 Electron 默认应用菜单栏，避免与我们自定义标题栏叠加出现两个顶部栏
    // macOS：保留精简菜单（appMenu 提供 Hide/Quit，editMenu 提供 Cmd+C/V/X/Undo/Redo）
    // Windows：完全隐藏（我们的标题栏 + 标题栏右侧自定义按钮足够）
    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }])
      );
    } else {
      Menu.setApplicationMenu(null);
    }

    const ok = registerShortcut();
    if (!ok) {
      console.warn('[aihub] 快捷键注册失败（可能被其他应用占用）: ' + config.shortcut);
      mainWindow.webContents.once('did-finish-load', () => {
        mainWindow.webContents.send('shortcut:failed', config.shortcut);
      });
    } else {
      log('全局快捷键注册成功:', config.shortcut);
    }

    registerIpc();
    startDevServerIfAny();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showMain();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    destroyAllViews();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

// ---------------- 调试钩子（AIHUB_SCREENSHOT / AIHUB_DIAG，仅 QA 环境使用）----------------
function runDebugHooks() {
// 调试钩子：AIHUB_SCREENSHOT=1 时自动保存 UI 截图（QA 验证用）
if (process.env.AIHUB_SCREENSHOT === '1') {
  setTimeout(async () => {
    try {
      const img = await mainWindow.webContents.capturePage();
      fs.writeFileSync(path.join(app.getPath('userData'), 'ui.png'), img.toPNG());
      log('UI 截图已保存: ui.png');
    } catch (e) {
      log('UI 截图失败:', e && e.message);
    }
  }, 4000);
}

// 调试钩子：AIHUB_DIAG=1 时模拟操作，验证侧边栏收起 / 站点切换 / 视图销毁 / lastSiteId（QA 验证用）
// 安全防线：DIAG 会模拟删除站点/清数据，强制要求 userData 已隔离（launch.js 在 AIHUB_DIAG 时
// 会自动加 --user-data-dir 临时目录；若直启 electron 绕过，这里直接拒绝运行 DIAG）
if (process.env.AIHUB_DIAG === '1') {
  const userDataPath = app.getPath('userData');
  const isolated = userDataPath.includes('aihub-test-') || userDataPath.includes('\\Temp\\') || userDataPath.includes('/tmp/');
  if (!isolated && process.env.AIHUB_ALLOW_REAL_DIAG !== '1') {
    log('【安全拦截】AIHUB_DIAG 检测到 userData 未隔离: ' + userDataPath);
    log('DIAG 会模拟删除站点/清数据，禁止在真实 userData 上运行。');
    log('请使用 npm run dev（launch.js 自动隔离），或显式 AIHUB_TEST_DATA=1。');
    process.exit(0);
  }
  setTimeout(async () => {
    try {
      // 窗口边框检查：无边框窗口 outer 与 inner 尺寸应一致（差值为 0）
      if (mainWindow && !mainWindow.isDestroyed()) {
        const outer = mainWindow.getSize();
        const inner = mainWindow.getContentSize();
        log('窗口边框检查: outer=' + outer[0] + 'x' + outer[1] + ' inner=' + inner[0] + 'x' + inner[1] + ' diff=' + (outer[1] - inner[1]));
      }
      const ui = await mainWindow.webContents.executeJavaScript(`(async () => {
        const out = {};
        const collapseBtn = document.getElementById('btn-collapse');
        out.collapseBtnExists = !!collapseBtn;
        if (collapseBtn) { try { collapseBtn.click(); } catch (e) { out.clickErr = String(e); } }
        await new Promise((r) => setTimeout(r, 400));
        out.collapsedNow = document.body.classList.contains('sidebar-collapsed');
        out.collapseBtnText = collapseBtn ? collapseBtn.textContent : '';
        // 收起状态截图标记（截图前保持收起）
        window.__diagCollapsed = out.collapsedNow;
        out.jsErrors = (window.__aihubErrors || []).slice(0, 8);
        return JSON.stringify(out);
      })()`);
      log('功能测试(UI-收起):', ui);
      await new Promise((r) => setTimeout(r, 600));
      const img = await mainWindow.webContents.capturePage();
      fs.writeFileSync(path.join(app.getPath('userData'), 'diag.png'), img.toPNG());
      log('收起状态截图已保存: diag.png');
      // 再测切站
      const ui2 = await mainWindow.webContents.executeJavaScript(`(async () => {
        const out = {};
        const items = document.querySelectorAll('.site-item');
        out.siteCount = items.length;
        if (items[1]) { try { items[1].click(); } catch (e) { out.switchErr = String(e); } }
        await new Promise((r) => setTimeout(r, 800));
        const active = document.querySelector('.site-item.active .site-name');
        out.activeHighlight = active ? active.textContent : 'NONE';
        return JSON.stringify(out);
      })()`);
      log('功能测试(UI-切站):', ui2);
      // 收起态下设置按钮应显示为图标（btn-text 隐藏、按钮可见）
      const uiCollapsed = await mainWindow.webContents.executeJavaScript(`(async () => {
        const out = {};
        const body = document.body;
        // 确保处于收起态
        if (!body.classList.contains('sidebar-collapsed')) {
          const b = document.getElementById('btn-collapse');
          if (b) b.click();
          await new Promise((r) => setTimeout(r, 300));
        }
        out.collapsed = body.classList.contains('sidebar-collapsed');
        const btn = document.getElementById('btn-settings');
        const text = btn ? btn.querySelector('.btn-text') : null;
        out.btnDisplay = btn ? getComputedStyle(btn).display : 'MISSING';
        out.btnVisible = btn ? btn.offsetWidth > 0 && btn.offsetHeight > 0 : false;
        out.textDisplay = text ? getComputedStyle(text).display : 'NO_TEXT';
        return JSON.stringify(out);
      })()`);
      log('功能测试(UI-收起设置图标):', uiCollapsed);
      log('功能测试(main):', JSON.stringify({
        viewsSize: views.size,
        activeSiteId,
        lastSiteId: config.lastSiteId,
        sidebarCollapsed: config.sidebarCollapsed,
      }));
      // 主题功能测试：切到暗色 → 验证 UI 与 nativeTheme
      const themeBefore = config.theme;
      const t = await mainWindow.webContents.executeJavaScript(`(async () => {
        const out = {};
        // 模拟打开设置 → 点暗色 → 保存
        document.getElementById('btn-settings').click();
        await new Promise((r) => setTimeout(r, 500));
        const opts = document.querySelectorAll('.theme-opt');
        out.themeOptCount = opts.length;
        const dark = document.querySelector('.theme-opt[data-theme="dark"]');
        if (dark) dark.click();
        out.darkActive = document.querySelector('.theme-opt.active') ? document.querySelector('.theme-opt.active').dataset.theme : 'NONE';
        document.getElementById('btn-settings-save').click();
        await new Promise((r) => setTimeout(r, 1200));
        out.bodyTheme = document.body.dataset.theme;
        out.cssBg = getComputedStyle(document.body).backgroundColor;
        out.jsErrors = (window.__aihubErrors || []).slice(0, 8);
        return JSON.stringify(out);
      })()`);
      log('功能测试(UI-主题):', t);
      log('功能测试(main-主题):', JSON.stringify({
        themeBefore,
        themeAfter: config.theme,
        themeSource: nativeTheme.themeSource,
        shouldUseDark: nativeTheme.shouldUseDarkColors,
      }));
      // 右键编辑功能测试：右键站点 → 弹窗预填 → 改名称保存 → 验证
      const editTest = await mainWindow.webContents.executeJavaScript(`(async () => {
        const out = {};
        // 先展开侧边栏（收起态下站点项可点但文字不可见）
        if (document.body.classList.contains('sidebar-collapsed')) {
          document.getElementById('btn-collapse').click();
          await new Promise((r) => setTimeout(r, 300));
        }
        const item = document.querySelector('.site-item');
        out.siteExists = !!item;
        if (!item) return JSON.stringify(out);
        const origName = item.querySelector('.site-name').textContent;
        out.origName = origName;
        // 触发右键
        const evt = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        item.dispatchEvent(evt);
        await new Promise((r) => setTimeout(r, 400));
        const inpName = document.getElementById('inp-name');
        const title = document.getElementById('modal-title');
        out.maskOpen = !document.getElementById('modal-mask').classList.contains('hidden');
        out.title = title ? title.textContent : 'MISSING';
        out.prefilledName = inpName ? inpName.value : '';
        out.delVisible = !document.getElementById('btn-del-site').classList.contains('hidden');
        // 改名保存
        const newName = origName + '✎';
        if (inpName) { inpName.value = newName; }
        document.getElementById('btn-save').click();
        await new Promise((r) => setTimeout(r, 1200));
        const updated = [...document.querySelectorAll('.site-item .site-name')].map(n => n.textContent);
        out.updatedNames = updated;
        out.hasNewName = updated.includes(newName);
        out.jsErrors = (window.__aihubErrors || []).slice(0, 8);
        return JSON.stringify(out);
      })()`);
      log('功能测试(UI-右键编辑):', editTest);
      log('功能测试(main-右键编辑):', JSON.stringify({
        siteCount: config.sites.length,
        names: config.sites.map((s) => s.name),
      }));
      // 拖动排序功能测试：把最后一个站点拖到最前 → 验证 config 顺序变化
      const reorderTest = await mainWindow.webContents.executeJavaScript(`(async () => {
        const out = {};
        const items = [...document.querySelectorAll('.site-item')];
        out.itemCount = items.length;
        out.orderBefore = items.map((el) => el.querySelector('.site-name').textContent);
        if (items.length < 2) return JSON.stringify(out);
        const source = items[items.length - 1];
        const target = items[0];
        // 模拟：dragstart(source) → dragover(target, 上方) → dragend(source)
        try {
          const dt = new DataTransfer();
          source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
          target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: 0 }));
          source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
        } catch (e) {
          out.dragErr = String(e);
        }
        await new Promise((r) => setTimeout(r, 800));
        const itemsAfter = [...document.querySelectorAll('.site-item')];
        out.orderAfter = itemsAfter.map((el) => el.querySelector('.site-name').textContent);
        out.draggableFirst = itemsAfter[0] ? itemsAfter[0].draggable : 'MISSING';
        return JSON.stringify(out);
      })()`);
      log('功能测试(UI-拖动排序):', reorderTest);
      log('功能测试(main-拖动排序):', JSON.stringify({
        names: config.sites.map((s) => s.name),
        ids: config.sites.map((s) => s.id),
      }));
      // 添加按钮位置检查：应在 site-list 之后、sidebar-foot 之前
      const addBtnPos = await mainWindow.webContents.executeJavaScript(`(() => {
        const sidebar = document.getElementById('sidebar');
        const children = [...sidebar.children];
        const idx = (n) => children.indexOf(n);
        return JSON.stringify({
          btnAddText: document.getElementById('btn-add').innerText,
          afterList: idx(document.getElementById('btn-add')) === idx(document.getElementById('site-list')) + 1,
          beforeFoot: idx(document.getElementById('btn-add')) === idx(document.querySelector('.sidebar-foot')) - 1,
          inHead: document.querySelector('.sidebar-head').contains(document.getElementById('btn-add')),
        });
      })()`);
      log('功能测试(UI-添加按钮位置):', addBtnPos);
      // 删除确认 UI 验证；共享/独立数据隔离由 npm test 的真实 Session 测试覆盖。
      const delVictim = config.sites[config.sites.length - 1];
      const delVictimId = delVictim ? delVictim.id : '';
      const delTest = await mainWindow.webContents.executeJavaScript(`(async () => {
        const out = {};
        const items = [...document.querySelectorAll('.site-item')];
        if (items.length === 0) { out.error = 'no sites'; return JSON.stringify(out); }
        const victim = items[items.length - 1];
        const victimName = victim.querySelector('.site-name').textContent;
        out.victim = victimName;
        // 点击删除按钮（×）触发确认弹窗
        victim.querySelector('.site-del').click();
        await new Promise((r) => setTimeout(r, 400));
        const delMask = document.getElementById('modal-del-mask');
        out.maskOpen = !delMask.classList.contains('hidden');
        out.delNameText = document.getElementById('del-site-name').textContent;
        // 勾选"同时删除本地数据"
        const chk = document.getElementById('chk-del-data');
        chk.checked = true;
        out.checked = chk.checked;
        document.getElementById('btn-del-confirm').click();
        await new Promise((r) => setTimeout(r, 1200));
        const namesAfter = [...document.querySelectorAll('.site-item .site-name')].map(n => n.textContent);
        out.removed = !namesAfter.includes(victimName);
        out.namesAfter = namesAfter;
        out.jsErrors = (window.__aihubErrors || []).slice(0, 8);
        return JSON.stringify(out);
      })()`);
      log('功能测试(UI-删除):', delTest);
      log('功能测试(main-删除):', JSON.stringify({
        siteCount: config.sites.length,
        names: config.sites.map((s) => s.name),
      }));
      // 独立数据已清空，目录在下次启动清理；共享会话永不入队整区删除。
      log('功能测试(删除数据验证):', JSON.stringify({
        victim: delVictimId,
        useIndependentData: delVictim && delVictim.useIndependentData,
        queuedForDirectoryCleanup: (config.pendingDataDeletions || []).includes(delVictimId),
      }));
      // 唤起窗口自动聚焦输入框测试：hide + 模拟快捷键唤起 → 查日志
      // 主窗口先 hide 一下
      mainWindow.hide();
      await new Promise((r) => setTimeout(r, 600));
      toggleMain(); // 模拟用户按全局快捷键
      await new Promise((r) => setTimeout(r, 1500));
      // 这里日志里应出现 "focus input: {"ok":true,...}"
      // 额外验证：焦点是否真的落在站点输入框（activeElement 是否 textarea/contenteditable）
      const focusVerify = await mainWindow.webContents.executeJavaScript(
        'document.activeElement ? document.activeElement.tagName + (document.activeElement.placeholder || "") : "BODY"'
      ).catch(() => 'ERR');
      log('焦点验证(主UI activeElement):', focusVerify);
      // 同时验证站点 webContents 内的 activeElement
      if (activeSiteId && views.has(activeSiteId)) {
        const siteWc = views.get(activeSiteId).view.webContents;
        const siteFocus = await siteWc
          .executeJavaScript(
            `(() => {
              const el = document.activeElement;
              if (!el || el === document.body) return 'BODY';
              return el.tagName + '|' + (el.placeholder || el.getAttribute('aria-label') || '');
            })()`,
            true
          )
          .catch((e) => 'ERR:' + e.message);
        log('焦点验证(站点activeElement):', siteFocus);
      }
    } catch (e) {
      log('诊断失败:', e && e.message);
    }
  }, 6000);
    }
}
