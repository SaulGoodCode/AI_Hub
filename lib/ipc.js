'use strict';

/** 渲染进程（主界面 / 站点 preload）→ 主进程的 IPC 处理 */

const { app, ipcMain, globalShortcut, nativeTheme, session } = require('electron');
// 以模块对象引用 site-data：测试会替换其中的 clearSiteData 注入失败场景
const siteData = require('../site-data');
const { config, saveConfig, saveConfigSoon, applyTheme, KEEP_ALIVE_MAX } = require('./config');
const {
  showSite,
  layoutViews,
  evictBackgroundViews,
  destroyView,
  closeSitePopups,
  restoreActiveView,
} = require('./site-views');
const { showMain, toggleMain } = require('./window');
const { refreshTray, setPinned } = require('./tray');
const { log } = require('./logger');
const state = require('./state');

const { siteURL, normalizeIcon, partitionForSite } = siteData;
const { views } = state;

function resolvedTheme() {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

function registerIpc() {
  ipcMain.handle('app:get-config', () => ({
    platform: process.platform,
    shortcut: config.shortcut,
    alwaysOnTop: !!config.alwaysOnTop,
    sidebarCollapsed: !!config.sidebarCollapsed,
    theme: config.theme,
    themeResolved: resolvedTheme(),
    keepAliveSites: config.keepAliveSites,
    version: app.getVersion(),
  }));

  // 后台保活站点数：调小时立即回收多余的后台视图
  ipcMain.handle('settings:update-keep-alive', (_e, value) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > KEEP_ALIVE_MAX) {
      return { ok: false, error: '保活数量需为 1–' + KEEP_ALIVE_MAX + ' 的整数' };
    }
    config.keepAliveSites = n;
    saveConfig();
    evictBackgroundViews();
    log('后台保活站点数已更新:', n);
    return { ok: true, keepAliveSites: n };
  });

  // 切换亮/暗/跟随系统主题：写入配置 + 应用 nativeTheme.themeSource，
  // 内置网页的 prefers-color-scheme 会自动跟随（Claude/DeepSeek/豆包等支持暗色的站点即时生效）。
  // 不主动 reload 站点：重载会打断正在进行的对话；少数加载时缓存配色的站点，
  // 用户可右键刷新或下次加载时生效。
  ipcMain.handle('settings:update-theme', (_e, theme) => {
    if (!['light', 'dark', 'system'].includes(theme)) {
      return { ok: false, error: '无效主题: ' + theme };
    }
    config.theme = theme;
    saveConfig();
    applyTheme();
    const win = state.mainWindow;
    if (win && !win.isDestroyed()) {
      win.webContents.send('theme:changed', { theme: config.theme, resolved: resolvedTheme() });
    }
    return { ok: true, theme: config.theme };
  });

  // 系统主题变化（仅 theme='system' 时由 OS 驱动，如 Windows 的深浅模式切换）
  nativeTheme.on('updated', () => {
    const win = state.mainWindow;
    if (win && !win.isDestroyed() && config.theme === 'system') {
      win.webContents.send('theme:changed', { theme: 'system', resolved: resolvedTheme() });
    }
  });

  // 侧边栏收起/展开
  ipcMain.handle('sidebar:toggle', () => {
    config.sidebarCollapsed = !config.sidebarCollapsed;
    saveConfigSoon();
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
    if (state.deletingSiteId) return { ok: false, error: '正在删除站点，请稍后重试' };
    const name = String((payload && payload.name) || '').trim();
    const url = String((payload && payload.url) || '').trim();
    if (!name) return { ok: false, error: '请输入站点名称' };
    try { siteURL(url); } catch { return { ok: false, error: '请输入以 http(s):// 开头的合法网址' }; }
    let icon;
    try { icon = normalizeIcon(payload.icon); } catch (error) { return { ok: false, error: error.message }; }

    const id = 'site-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    const site = { id, name, url, enabled: true, useIndependentData: payload.useIndependentData === true };
    if (icon) site.icon = icon;
    config.sites.push(site);
    saveConfig();

    showSite(site.id);
    return { ok: true, site };
  });

  ipcMain.handle('sites:remove', async (_e, id, deleteData) => {
    if (state.deletingSiteId) return { ok: false, error: '正在删除站点，请稍后重试' };
    const site = config.sites.find((s) => s.id === id);
    if (!site) return { ok: false, error: '站点不存在或已被删除' };
    state.deletingSiteId = id;
    destroyView(id);
    closeSitePopups(id);
    try {
      // 独立站点删除后无法通过新增 ID 恢复，必须清空；共享站点仍由用户选择。
      if (site.useIndependentData === true || deleteData) {
        await siteData.clearSiteData(session.fromPartition(partitionForSite(site)), site, config.sites);
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
      state.deletingSiteId = null;
      if (state.activeSiteId === id) showSite(id);
      return { ok: false, error: '部分本地数据可能已清除，站点仍保留。请重试：' + error.message };
    } finally {
      state.deletingSiteId = null;
    }
    if (state.activeSiteId === id) {
      state.activeSiteId = null;
      if (config.sites.length > 0) showSite(config.sites[0].id);
    }
    return { ok: true };
  });

  // 编辑站点：改名/改网址。保留原 id（登录态 partition 不丢）
  ipcMain.handle('sites:update', (_e, payload) => {
    if (state.deletingSiteId) return { ok: false, error: '正在删除站点，请稍后重试' };
    const id = String((payload && payload.id) || '');
    const name = String((payload && payload.name) || '').trim();
    const url = String((payload && payload.url) || '').trim();
    const site = config.sites.find((s) => s.id === id);
    if (!site) return { ok: false, error: '站点不存在或已被删除' };
    if (!name) return { ok: false, error: '请输入站点名称' };
    try { siteURL(url); } catch { return { ok: false, error: '请输入以 http(s):// 开头的合法网址' }; }
    let icon;
    try { icon = normalizeIcon(payload.icon); } catch (error) { return { ok: false, error: error.message }; }

    const urlChanged = site.url !== url;
    const useIndependentData = typeof payload.useIndependentData === 'boolean'
      ? payload.useIndependentData : site.useIndependentData;
    const storageChanged = useIndependentData !== site.useIndependentData;
    site.name = name;
    site.url = url;
    site.useIndependentData = useIndependentData;
    // 留空 = 不自定义，回落到自动拉取的图标
    if (icon) site.icon = icon;
    else delete site.icon;
    // 换了网址，旧的自动图标不再可信，等新页面重新上报
    if (urlChanged) delete site.favicon;
    saveConfig();

    // 切换模式仅切换会话，保留原分区，避免自动合并账号或删除登录态。
    if (urlChanged || storageChanged) {
      destroyView(id); // 不保留导航状态：旧网址/旧会话的历史不能带到新视图
      closeSitePopups(id);
      if (state.activeSiteId === id) {
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
    saveConfigSoon();
    return { ok: true };
  });

  ipcMain.handle('window:toggle-pin', () => {
    const win = state.mainWindow;
    if (!win || win.isDestroyed()) return false;
    return setPinned(!win.isAlwaysOnTop());
  });

  // 最大化 / 还原（无边框窗口的自定义标题栏按钮）
  ipcMain.handle('window:toggle-max', () => {
    const win = state.mainWindow;
    if (!win || win.isDestroyed()) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });

  // 弹窗（设置/添加站点）打开时隐藏站点视图，避免原生子视图遮挡弹窗；关闭时恢复
  ipcMain.on('overlay:set', (_e, open) => {
    state.overlayOpen = !!open;
    if (open) {
      const entry = views.get(state.activeSiteId);
      if (entry) entry.view.setVisible(false);
    } else {
      restoreActiveView();
    }
  });

  // 站点通知被点击（site-preload 只转发用户真实点击）：唤起窗口并切到发通知的站点
  ipcMain.on('site:notification-click', (e) => {
    for (const [id, entry] of views) {
      if (entry.view.webContents === e.sender) {
        log('通知点击，切换到站点:', entry.site.name);
        if (state.activeSiteId !== id) showSite(id);
        showMain();
        return;
      }
    }
  });

  ipcMain.on('window:minimize', () => {
    const win = state.mainWindow;
    if (win && !win.isDestroyed()) win.minimize();
  });
  ipcMain.on('window:hide', () => {
    const win = state.mainWindow;
    if (win && !win.isDestroyed()) win.hide();
  });
}

module.exports = { registerIpc };
