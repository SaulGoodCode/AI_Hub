'use strict';

/** 主进程各模块共享的运行时状态（只放跨模块读写的字段） */
module.exports = {
  /** @type {import('electron').BrowserWindow | null} */
  mainWindow: null,
  /**
   * 存活的站点视图；插入顺序即 LRU 顺序（最近使用的在末尾）。
   * @type {Map<string, {view: import('electron').WebContentsView, site: object}>}
   */
  views: new Map(),
  activeSiteId: null,
  /** 正在删除中的站点 id（删除期间拒绝切换/增改） */
  deletingSiteId: null,
  /** 设置/添加站点等弹窗是否打开（打开时隐藏站点视图，避免原生子视图遮挡弹窗） */
  overlayOpen: false,
};
