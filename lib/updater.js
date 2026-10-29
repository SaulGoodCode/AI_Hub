'use strict';

/**
 * 自动更新：electron-updater + GitHub Releases（package.json build.publish）。
 *
 * - Windows：发现新版本后后台静默下载；下载完成在标题栏提示"重启更新"，
 *   不点的话下次退出时自动安装（autoInstallOnAppQuit）。
 * - macOS：安装包未签名，Squirrel.Mac 拒绝替换未签名应用，因此只检查不下载，
 *   发现新版本时提示"前往下载"，打开对应 Release 页面手动安装。
 * - 只在打包版本里工作；开发/测试可设 AIHUB_UPDATE_URL 指向本地 generic 更新源。
 *
 * 状态通过 'update:status' 推给主界面：
 *   idle | checking | not-available | available | downloading | downloaded | error
 */

const path = require('path');
const fs = require('fs');
const { app, shell } = require('electron');
const { config, saveConfig, flushPendingWrites } = require('./config');
const { log } = require('./logger');
const state = require('./state');

const RELEASES_URL = 'https://github.com/SaulGoodCode/AI_Hub/releases';
const FIRST_CHECK_DELAY = 15 * 1000; // 启动后等站点加载完再检查，避免抢带宽
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
// macOS 未签名无法自动安装，只提示手动下载
const CAN_AUTO_INSTALL = process.platform === 'win32';

let autoUpdater = null;
let checkTimer = null;
/** 当前是否是用户手动点的检查（手动检查才把错误显示给用户） */
let manualCheck = false;
let status = { state: 'idle', currentVersion: app.getVersion(), canAutoInstall: CAN_AUTO_INSTALL };

function setStatus(next) {
  status = { currentVersion: app.getVersion(), canAutoInstall: CAN_AUTO_INSTALL, ...next };
  const win = state.mainWindow;
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send('update:status', getStatus());
  }
}

function getStatus() {
  return { ...status, enabled: !!autoUpdater, autoCheck: config.autoCheckUpdates !== false };
}

function releasePage(version) {
  return version ? RELEASES_URL + '/tag/v' + version : RELEASES_URL + '/latest';
}

function initUpdater() {
  const testFeed = process.env.AIHUB_UPDATE_URL;
  if (!app.isPackaged && !testFeed) {
    log('[update] 开发模式，跳过自动更新');
    return;
  }
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    log('[update] 加载 electron-updater 失败:', e.message);
    return;
  }

  autoUpdater.logger = {
    info: (m) => log('[update]', m),
    warn: (m) => log('[update] warn:', m),
    error: (m) => log('[update] error:', m),
    debug: () => {},
  };
  autoUpdater.autoDownload = CAN_AUTO_INSTALL;
  autoUpdater.autoInstallOnAppQuit = CAN_AUTO_INSTALL;
  autoUpdater.allowPrerelease = false;
  autoUpdater.disableWebInstaller = true; // 只发完整 NSIS 安装包，不用 web installer
  if (testFeed) {
    // 测试更新源：未打包时 electron-updater 仍要读一份 app-update.yml（下载缓存目录等），
    // 这里生成到 userData 并指过去；缓存目录与正式版分开，避免混用
    const yml = path.join(app.getPath('userData'), 'dev-app-update.yml');
    fs.writeFileSync(yml, `provider: generic\nurl: ${testFeed}\nupdaterCacheDirName: ai-hub-updater-test\n`);
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.updateConfigPath = yml;
    autoUpdater.setFeedURL({ provider: 'generic', url: testFeed });
    log('[update] 使用测试更新源:', testFeed);
  }

  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => setStatus({ state: 'not-available', checkedAt: Date.now() }));
  autoUpdater.on('update-available', (info) => {
    log('[update] 发现新版本:', info.version);
    setStatus({
      state: CAN_AUTO_INSTALL ? 'downloading' : 'available',
      version: info.version,
      percent: 0,
      releaseUrl: releasePage(info.version),
    });
  });
  autoUpdater.on('download-progress', (p) => {
    setStatus({ ...status, state: 'downloading', percent: Math.round(p.percent || 0) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    log('[update] 新版本已下载:', info.version);
    setStatus({ state: 'downloaded', version: info.version, releaseUrl: releasePage(info.version) });
  });
  autoUpdater.on('error', (err) => {
    const message = (err && err.message) || String(err);
    log('[update] 失败:', message);
    // 自动检查失败（断网/GitHub 限流等）不打扰用户：退回空闲状态，下个周期再试
    if (manualCheck) setStatus({ state: 'error', error: message.split('\n')[0] });
    else if (['checking', 'downloading'].includes(status.state)) setStatus({ state: 'idle' });
  });

  scheduleChecks();
}

function scheduleChecks() {
  clearTimeout(checkTimer);
  checkTimer = null;
  if (!autoUpdater || config.autoCheckUpdates === false) return;
  const run = () => {
    checkForUpdates(false);
    checkTimer = setTimeout(run, CHECK_INTERVAL);
  };
  checkTimer = setTimeout(run, FIRST_CHECK_DELAY);
}

/** 检查更新；manual=true 表示用户点了"检查更新"（错误会显示在设置里） */
async function checkForUpdates(manual) {
  if (!autoUpdater) return { ok: false, error: app.isPackaged ? '自动更新不可用' : '开发模式下不检查更新' };
  // 已经在下载或已下载完：不重复检查，直接返回当前状态
  if (['downloading', 'downloaded'].includes(status.state)) return { ok: true };
  manualCheck = !!manual;
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

function setAutoCheck(enabled) {
  config.autoCheckUpdates = !!enabled;
  saveConfig();
  scheduleChecks();
  return config.autoCheckUpdates;
}

/**
 * 标题栏"重启更新 / 前往下载"按钮：
 * - 已下载（Windows）：静默安装并自动重启
 * - 未签名平台：打开 Release 页面
 */
function applyUpdate() {
  if (status.state === 'downloaded' && autoUpdater) {
    log('[update] 退出并安装新版本:', status.version);
    app.isQuitting = true; // 绕过"关闭 = 隐藏到托盘"
    flushPendingWrites();
    // isSilent=true：安装包不弹向导，沿用原安装目录；isForceRunAfter=true：装完自动启动
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return { ok: true, action: 'install' };
  }
  if (status.state === 'available') {
    shell.openExternal(status.releaseUrl || releasePage());
    return { ok: true, action: 'open' };
  }
  return { ok: false, error: '没有可安装的更新' };
}

module.exports = { initUpdater, checkForUpdates, getStatus, setAutoCheck, applyUpdate };
