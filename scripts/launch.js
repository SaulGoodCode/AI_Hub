'use strict';

/**
 * 启动脚本（跨平台）
 * 1. 清除会破坏 Electron 的环境变量（ELECTRON_RUN_AS_NODE / NODE_OPTIONS）
 * 2. （启用文件监听时）监听项目源码变化，自动通知主进程 reload
 *
 * 文件变化策略：
 *   - renderer/ 任意文件 → webContents.reload()（秒级生效，无窗口闪动）
 *   - preload.js         → webContents.reload()（preload 必须重新加载）
 *   - main.js            → app.relaunch()（主进程代码无法热替换，会闪一下窗口）
 * 200ms debounce 避免编辑器保存时多次触发。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');

delete process.env.ELECTRON_RUN_AS_NODE;
delete process.env.NODE_OPTIONS;

const root = path.join(__dirname, '..');
const ENABLE_WATCH = process.env.AIHUB_DEV === '1' || process.argv.includes('--dev');

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function postReload(port, payload) {
  const data = JSON.stringify(payload);
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 2000,
      },
      (res) => res.on('data', () => {}).on('end', resolve)
    );
    req.on('error', () => resolve());
    req.write(data);
    req.end();
  });
}

function setupWatcher(port) {
  const rendererDir = path.join(root, 'renderer');
  const watchFiles = (files, kind, action) => {
    const trigger = () => {
      const key = kind + '|' + action;
      if (watchFiles._debounce.has(key)) clearTimeout(watchFiles._debounce.get(key));
      watchFiles._debounce.set(
        key,
        setTimeout(() => {
          watchFiles._debounce.delete(key);
          console.log(`[dev] ${kind} 变化 → ${action}`);
          postReload(port, { target: action }).catch(() => {});
        }, 200)
      );
    };
    files.forEach((f) => {
      if (!fs.existsSync(f)) return;
      try {
        fs.watch(f, { persistent: true }, trigger);
      } catch {
        fs.watchFile(f, { interval: 400 }, trigger);
      }
    });
  };
  watchFiles._debounce = new Map();

  watchFiles(['main.js', 'site-data.js', 'popup-window.js', 'popup-preload.js'].map((file) => path.join(root, file)), 'main', 'main-relaunch');
  watchFiles([path.join(root, 'preload.js')], 'preload', 'preload');
  if (fs.existsSync(rendererDir)) {
    fs.watch(rendererDir, { recursive: true, persistent: true }, (_evt, filename) => {
      if (!filename) return;
      const full = path.join(rendererDir, filename);
      if (!fs.existsSync(full)) return;
      if (full.endsWith('.js') || full.endsWith('.html') || full.endsWith('.css')) {
        const key = 'renderer|renderer';
        if (watchFiles._debounce.has(key)) clearTimeout(watchFiles._debounce.get(key));
        watchFiles._debounce.set(
          key,
          setTimeout(() => {
            watchFiles._debounce.delete(key);
            console.log(`[dev] renderer/${filename} 变化 → reload`);
            postReload(port, { target: 'renderer' }).catch(() => {});
          }, 200)
        );
      }
    });
  }
  console.log(`[dev] 文件监听已启用（reload 端口 ${port}）`);
}

async function main() {
  if (ENABLE_WATCH) {
    const port = await pickFreePort();
    process.env.AIHUB_DEV_PORT = String(port);
    setupWatcher(port);
  }

  const electronPath = require('electron');
  let extraArgs = process.argv.slice(2).filter((a) => a !== '--dev');

  // 测试隔离（强制）：
  // - AIHUB_TEST_DATA=1：显式要求隔离
  // - AIHUB_DIAG=1 但未显式 AIHUB_TEST_DATA=1：自动强制隔离（DIAG 会模拟删除站点/清数据，
  //   绝不允许跑在真实 userData 上 —— 历史教训：曾两次误删用户登录态）
  // 隔离 = 独立临时 userData 目录，读写不到真实 %APPDATA%/AI Hub
  const mustIsolate =
    process.env.AIHUB_TEST_DATA === '1' ||
    (process.env.AIHUB_DIAG === '1' && process.env.AIHUB_TEST_DATA !== '0');
  if (mustIsolate) {
    const os = require('os');
    const testDir = path.join(os.tmpdir(), 'aihub-test-' + Date.now());
    if (!extraArgs.some((a) => a.startsWith('--user-data-dir='))) {
      extraArgs.push('--user-data-dir=' + testDir);
    }
    console.log(`[test] 使用隔离 userData: ${testDir}（不读写真实数据）`);
  }

  const child = spawn(electronPath, ['.', ...extraArgs], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });

  child.on('error', (err) => {
    console.error('[aihub] 启动失败:', err.message);
    process.exit(1);
  });

  child.on('exit', (code) => {
    process.exit(code == null ? 0 : code);
  });
}

main().catch((e) => {
  console.error('[aihub] 启动失败:', e);
  process.exit(1);
});
