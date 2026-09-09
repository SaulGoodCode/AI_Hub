'use strict';

/**
 * 保存 Chromium 的完整导航栈。NavigationEntry.pageState 除 URL 外还包含
 * history.state、滚动位置和表单状态，适合在销毁 WebContents 后恢复同一标签页。
 */
function captureNavigationState(webContents) {
  if (!webContents || webContents.isDestroyed()) return null;
  const history = webContents.navigationHistory;
  if (!history) return null;

  const entries = history.getAllEntries();
  const index = history.getActiveIndex();
  if (!Array.isArray(entries) || entries.length === 0 || index < 0 || index >= entries.length) {
    return null;
  }
  return { entries, index };
}

function isValidNavigationState(state) {
  return !!(
    state &&
    Array.isArray(state.entries) &&
    state.entries.length > 0 &&
    Number.isInteger(state.index) &&
    state.index >= 0 &&
    state.index < state.entries.length &&
    state.entries.every((entry) => entry && typeof entry.url === 'string' && entry.url.length > 0)
  );
}

/**
 * 优先恢复之前的导航栈；没有快照时正常打开站点首页。
 * restore() 失败会回退到 loadURL，避免损坏的页面状态让站点无法打开。
 */
async function restoreNavigationState(webContents, state, fallbackUrl) {
  let restoreError = null;
  if (isValidNavigationState(state)) {
    try {
      await webContents.navigationHistory.restore({ entries: state.entries, index: state.index });
      return true;
    } catch (error) {
      if (!fallbackUrl) throw error;
      restoreError = error;
    }
  }
  if (!webContents || webContents.isDestroyed()) {
    throw restoreError || new Error('WebContents was destroyed before navigation');
  }
  await webContents.loadURL(fallbackUrl);
  return false;
}

module.exports = { captureNavigationState, restoreNavigationState, isValidNavigationState };
