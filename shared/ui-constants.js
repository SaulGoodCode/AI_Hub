'use strict';

/**
 * 主进程与页面共用的界面常量 / 工具函数（唯一来源）。
 * - 主进程：require('./shared/ui-constants')
 * - 页面：<script src="../shared/ui-constants.js">，挂到 window.AIHubUI，
 *   并立即把尺寸写进 CSS 变量（--titlebar-height 等），CSS 里不再写死这些数值。
 *   放在 <head> 里加载，首帧渲染前变量就已就位。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.AIHubUI = api;
    if (typeof document !== 'undefined') api.applyCssVars(document.documentElement);
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const TITLEBAR_HEIGHT = 36; // 主窗口标题栏高度：站点视图从这里往下排
  const SIDEBAR_WIDTH = 232; // 侧边栏展开宽度
  const SIDEBAR_COLLAPSED_WIDTH = 60; // 侧边栏收起宽度（只留图标）
  const POPUP_TITLEBAR_HEIGHT = 40; // 站点弹窗（OAuth 等）顶部标题栏高度

  /**
   * 把 Electron accelerator 字符串渲染为用户友好文本。
   * "CommandOrControl+Space" → Windows: "Ctrl+Space"，macOS: "⌘+Space"。
   */
  function formatShortcut(accel, platform) {
    if (!accel) return '';
    const isMac = platform === 'darwin';
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

  /** 页面侧：把布局尺寸写进 CSS 变量 */
  function applyCssVars(el) {
    el.style.setProperty('--titlebar-height', TITLEBAR_HEIGHT + 'px');
    el.style.setProperty('--sidebar-width', SIDEBAR_WIDTH + 'px');
    el.style.setProperty('--sidebar-collapsed-width', SIDEBAR_COLLAPSED_WIDTH + 'px');
    el.style.setProperty('--popup-titlebar-height', POPUP_TITLEBAR_HEIGHT + 'px');
  }

  return {
    TITLEBAR_HEIGHT,
    SIDEBAR_WIDTH,
    SIDEBAR_COLLAPSED_WIDTH,
    POPUP_TITLEBAR_HEIGHT,
    formatShortcut,
    applyCssVars,
  };
});
