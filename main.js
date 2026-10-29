'use strict';

/**
 * AI Hub 主进程入口
 * - 单窗口多标签：WebContentsView 内嵌第三方 AI 网页
 * - 默认共享持久化会话，可按站点选择独立数据
 * - 全局快捷键唤起/隐藏（默认 Ctrl+Shift+Space，可在 config.json 修改）
 * - 系统托盘常驻，关闭按钮=隐藏到托盘
 * 支持 Windows 11 / macOS
 *
 * 本文件只负责进程级防护和应用生命周期，具体功能在 lib/ 下：
 *   config      配置读写/迁移          logger     日志
 *   window      主窗口/唤起/快捷键     site-views 站点视图与 LRU 保活
 *   tray        托盘                   ipc        渲染进程 IPC
 *   google-compat  UA 清理与 Google 登录兼容（请求头侧）
 *   dev-server  开发期热重载钩子
 */

const { app, BrowserWindow, globalShortcut, Menu } = require('electron');

// 防护：若因 ELECTRON_RUN_AS_NODE 环境变量导致以纯 Node 模式运行，给出明确提示
if (!app) {
  console.error(
    '[aihub] Electron 以纯 Node 模式启动（app API 不可用）。\n' +
      '      请检查系统环境变量是否设置了 ELECTRON_RUN_AS_NODE=1（多为某些工具遗留），\n' +
      '      删除该变量后重启；或使用 npm start（启动脚本会自动清除该变量）。'
  );
  process.exit(1);
}

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

const { cleanupPendingPartitions } = require('./site-data');
const { log, cleanupOldLogs } = require('./lib/logger');
const { config, loadConfig, saveConfig, applyTheme, flushPendingWrites, pruneCorruptBackups } = require('./lib/config');
const { destroyAllViews } = require('./lib/site-views');
const { createWindow, showMain, registerShortcut, relaunchOnce } = require('./lib/window');
const { createTray } = require('./lib/tray');
const { registerIpc } = require('./lib/ipc');
const { startDevServerIfAny } = require('./lib/dev-server');
const state = require('./lib/state');

// GPU 不可用（远程桌面/虚拟机/驱动/沙箱受限环境）时自动降级：
// GPU 子进程反复崩溃 → 自动带 --disable-gpu --no-sandbox 重启一次（最多一次）
if (process.argv.includes('--disable-gpu') || process.env.AIHUB_NO_GPU === '1') {
  app.disableHardwareAcceleration();
}
app.on('child-process-gone', (_event, details) => {
  if (details.type !== 'GPU') return;
  if (app.commandLine.hasSwitch('disable-gpu')) {
    // 已处于软件渲染仍出现 GPU 子进程退出：Chromium 会自动走软件方案，忽略
    return;
  }
  relaunchOnce(['--disable-gpu', '--no-sandbox'], 'GPU 进程异常退出，将以软件渲染+关闭沙箱模式重启…');
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());

  app.whenReady().then(() => {
    app.setAppUserModelId('com.saul.aihub');
    loadConfig();
    cleanupOldLogs();
    pruneCorruptBackups();
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
      state.mainWindow.webContents.once('did-finish-load', () => {
        state.mainWindow.webContents.send('shortcut:failed', config.shortcut);
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
    flushPendingWrites();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
