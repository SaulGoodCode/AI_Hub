'use strict';

/**
 * 配置：userData/config.json 的读取、迁移、原子写入与延迟写入。
 * `config` 是一个固定的对象引用，loadConfig 只替换它的内容，
 * 其他模块可以放心地 `const { config } = require('./config')` 后长期持有。
 */

const path = require('path');
const fs = require('fs');
const { app, nativeTheme } = require('electron');
const { migrateSiteData } = require('../site-data');
const { log, flushLogsSync } = require('./logger');

const PRODUCT_NAME = 'AI Hub';

const DEFAULT_CONFIG = {
  shortcut: 'Ctrl+Shift+Space',
  alwaysOnTop: false,
  sidebarCollapsed: false,
  lastSiteId: null,
  // 主题：'light' | 'dark' | 'system'（跟随系统）
  // 通过 nativeTheme.themeSource 同步进内置浏览器（prefers-color-scheme）
  theme: 'system',
  // 同时保活的站点视图数（含当前站点）。后台站点继续运行，切回时不重载、不打断正在生成的回复；
  // 超出上限时回收最久未用的。1 = 只保留当前站点（最省内存）
  keepAliveSites: 3,
  // 上次关闭时的窗口位置/尺寸（非最大化状态下的），null = 首次启动居中
  windowBounds: null,
  windowMaximized: false,
  // 启动后及每 6 小时自动检查 GitHub Releases 上的新版本
  autoCheckUpdates: true,
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

const KEEP_ALIVE_MAX = 10;
const CORRUPT_CONFIG_KEEP = 3;
const CONFIG_SAVE_DELAY = 300;

let configPath = '';
const config = {};
let configSaveTimer = null;

/** 用新内容替换 config（保持对象引用不变） */
function replaceConfig(next) {
  for (const key of Object.keys(config)) delete config[key];
  Object.assign(config, next);
}

function loadConfig() {
  configPath = path.join(app.getPath('userData'), 'config.json');
  let loaded = null;
  let raw = null;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') log('读取配置失败:', e.message);
  }
  if (raw !== null) {
    try {
      loaded = JSON.parse(raw);
      if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) throw new Error('配置不是 JSON 对象');
      if (!Array.isArray(loaded.sites)) loaded.sites = [];
    } catch (e) {
      // 配置损坏：先把原文件另存，避免下面写入默认配置时把用户的站点列表彻底覆盖掉
      loaded = null;
      const backup = configPath.replace(/\.json$/, '') + '.corrupt-' + Date.now() + '.json';
      try {
        fs.copyFileSync(configPath, backup);
        log('配置文件损坏，已备份到', backup, '原因:', e.message);
      } catch (copyErr) {
        log('配置文件损坏且备份失败:', copyErr.message);
      }
    }
  }
  if (loaded) {
    replaceConfig(loaded);
  } else {
    replaceConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
    saveConfig();
  }
  if (migrateSiteData(config)) saveConfig();
  config.shortcut = config.shortcut || DEFAULT_CONFIG.shortcut;
  config.alwaysOnTop = !!config.alwaysOnTop;
  config.sidebarCollapsed = !!config.sidebarCollapsed;
  config.lastSiteId = config.lastSiteId || null;
  // 主题：'light'/'dark'/'system'，非法值回退 'system'
  if (!['light', 'dark', 'system'].includes(config.theme)) config.theme = 'system';
  config.keepAliveSites = normalizeKeepAlive(config.keepAliveSites);
  config.windowMaximized = !!config.windowMaximized;
  config.autoCheckUpdates = config.autoCheckUpdates !== false; // 老配置没有该字段：默认开启
  migrateBuiltinSites();
}

/** 保活数量规范化：非法值回退默认，限制在 1..KEEP_ALIVE_MAX */
function normalizeKeepAlive(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_CONFIG.keepAliveSites;
  return Math.min(n, KEEP_ALIVE_MAX);
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

/**
 * 原子写入配置：先写临时文件并刷盘，再 rename 覆盖。
 * 写到一半崩溃/断电时 config.json 要么是旧内容要么是新内容，不会出现半截 JSON。
 */
function saveConfig() {
  // 立即写入会带上所有改动，挂起的延迟写入就不需要了
  clearTimeout(configSaveTimer);
  configSaveTimer = null;
  const tmpPath = configPath + '.tmp';
  const data = JSON.stringify(config, null, 2);
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeFileSync(fd, data, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmpPath, configPath);
    } catch (e) {
      // Windows 上目标文件被杀毒软件/索引服务短暂占用时 rename 会 EPERM/EBUSY，退回直接覆盖
      fs.writeFileSync(configPath, data, 'utf8');
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  } catch (e) {
    console.error('[aihub] save config failed:', e);
  }
}

/**
 * 延迟写入：切站、favicon 上报、侧边栏收起、拖动排序这类高频小改动合并成一次落盘。
 * 增删改站点、设置项等重要改动仍走 saveConfig() 立即写入。
 */
function saveConfigSoon() {
  clearTimeout(configSaveTimer);
  configSaveTimer = setTimeout(saveConfig, CONFIG_SAVE_DELAY);
}

/** 退出/重启前把挂起的配置和日志同步写完（app.exit 不会等定时器和异步写入） */
function flushPendingWrites() {
  if (configSaveTimer) saveConfig();
  flushLogsSync();
}

/** 启动时清理配置损坏备份：config.corrupt-*.json 只保留最新 3 个 */
function pruneCorruptBackups() {
  const dir = app.getPath('userData');
  let backups = [];
  try {
    backups = fs.readdirSync(dir).filter((name) => /^config\.corrupt-\d+\.json$/.test(name));
  } catch (e) {
    return;
  }
  // 文件名里的时间戳即备份时间，新的排前面
  const stamp = (name) => Number(name.match(/\d+/)[0]);
  backups.sort((a, b) => stamp(b) - stamp(a));
  for (const name of backups.slice(CORRUPT_CONFIG_KEEP)) {
    try {
      fs.unlinkSync(path.join(dir, name));
      log('已删除旧的损坏配置备份:', name);
    } catch (e) {
      /* ignore */
    }
  }
}

module.exports = {
  PRODUCT_NAME,
  KEEP_ALIVE_MAX,
  config,
  loadConfig,
  saveConfig,
  saveConfigSoon,
  flushPendingWrites,
  normalizeKeepAlive,
  applyTheme,
  pruneCorruptBackups,
};
