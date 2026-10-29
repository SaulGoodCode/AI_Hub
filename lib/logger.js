'use strict';

/**
 * 日志：写入 userData/aihub.log，便于排查。
 * 先进内存缓冲，200ms 内攒一批异步追加，避免主线程每行都做同步磁盘 I/O；
 * 超过 LOG_MAX_BYTES 时把当前文件轮转为 aihub.log.1（只保留一份旧日志）。
 */

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_FLUSH_DELAY = 200;
const LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
let logBuffer = [];
let logFlushScheduled = false;
let logSize = -1; // -1 = 尚未读取现有日志大小

function logFilePath() {
  return path.join(app.getPath('userData'), 'aihub.log');
}

/** 追加 bytes 之前检查是否需要轮转 */
function rotateLogIfNeeded(file, bytes) {
  if (logSize < 0) {
    try {
      logSize = fs.statSync(file).size;
    } catch (e) {
      logSize = 0;
    }
  }
  if (logSize > 0 && logSize + bytes > LOG_MAX_BYTES) {
    try {
      fs.renameSync(file, file + '.1');
    } catch (e) {
      /* ignore - 轮转失败就继续追加 */
    }
    logSize = 0;
  }
  logSize += bytes;
}

function takeLogChunk() {
  const chunk = logBuffer.join('');
  logBuffer = [];
  return chunk;
}

function flushLogs() {
  const chunk = takeLogChunk();
  if (!chunk) {
    logFlushScheduled = false;
    return;
  }
  try {
    const file = logFilePath();
    rotateLogIfNeeded(file, Buffer.byteLength(chunk));
    fs.appendFile(file, chunk, () => {
      logFlushScheduled = false;
      if (logBuffer.length) scheduleLogFlush();
    });
  } catch (e) {
    logFlushScheduled = false;
  }
}

function scheduleLogFlush() {
  if (logFlushScheduled) return;
  logFlushScheduled = true;
  setTimeout(flushLogs, LOG_FLUSH_DELAY);
}

/** 退出前同步写完缓冲区里的日志（app.exit 不会等异步写入） */
function flushLogsSync() {
  const chunk = takeLogChunk();
  if (!chunk) return;
  try {
    const file = logFilePath();
    rotateLogIfNeeded(file, Buffer.byteLength(chunk));
    fs.appendFileSync(file, chunk);
  } catch (e) {
    /* ignore */
  }
}

/** 启动时删除超过 7 天未写入的 aihub.log / aihub.log.1 */
function cleanupOldLogs() {
  const dir = app.getPath('userData');
  const now = Date.now();
  for (const name of ['aihub.log', 'aihub.log.1']) {
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > LOG_MAX_AGE_MS) {
        fs.unlinkSync(file);
        if (name === 'aihub.log') logSize = -1; // 下次写入时重新读取大小
        log('已删除过期日志:', name);
      }
    } catch (e) {
      /* 文件不存在或删除失败：忽略 */
    }
  }
}

function log(...args) {
  const line = '[' + new Date().toISOString() + '] ' + args.join(' ');
  // console.log 自身在 stdout pipe 关闭时会 EPIPE，这里也包一层防止主进程崩溃
  try {
    console.log(line);
  } catch (e) {
    /* ignore - stdout pipe 关闭不影响功能 */
  }
  logBuffer.push(line + '\n');
  scheduleLogFlush();
}

module.exports = { log, flushLogsSync, cleanupOldLogs };
