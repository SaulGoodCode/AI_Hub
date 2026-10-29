'use strict';

/**
 * 开发期文件变化触发器（仅在 AIHUB_DEV_PORT 环境变量存在时启用）。
 * launch.js 启动 electron 子进程前会选一个空闲端口，并设置该环境变量；
 * 随后 launch.js 用 fs.watch 监听源码变化，通过 POST 请求通知主进程做对应动作：
 *   - target=renderer|preload  → webContents.reload()（preload 必须重新加载）
 *   - target=main-relaunch     → app.relaunch()（主进程代码无法热替换）
 * 打包/正式运行时不会传入该环境变量，server 不会启动，对发布版本零开销。
 */

const { app } = require('electron');
const { flushPendingWrites } = require('./config');
const { showMain } = require('./window');
const { log } = require('./logger');
const state = require('./state');

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
        const win = state.mainWindow;
        if (win && !win.isDestroyed()) {
          win.webContents.reload();
          if (win.webContents.isLoading()) {
            win.webContents.once('did-finish-load', () => showMain());
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
            flushPendingWrites();
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

module.exports = { startDevServerIfAny };
