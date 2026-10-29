'use strict';

/**
 * QA 调试钩子（仅开发 / QA 使用，不打进安装包）。由 lib/window.js 在主窗口 ready-to-show 后按需加载：
 * - AIHUB_SCREENSHOT=1：4 秒后保存 UI 截图到 userData/ui.png
 * - AIHUB_DIAG=1：模拟一串 UI 操作（收起侧边栏 / 切站 / 主题 / 右键编辑 / 拖动排序 / 删除 / 唤起聚焦），
 *   把结果写进日志。会模拟删除站点、清数据，必须在隔离的 userData 下运行（npm run dev 会自动隔离）。
 */

const fs = require('fs');
const path = require('path');
const { app, nativeTheme } = require('electron');
const { config } = require('../lib/config');
const { toggleMain } = require('../lib/window');
const { log } = require('../lib/logger');
const state = require('../lib/state');

function run() {
const mainWindow = state.mainWindow;
const { views } = state;
// 调试钩子：AIHUB_SCREENSHOT=1 时自动保存 UI 截图（QA 验证用）
if (process.env.AIHUB_SCREENSHOT === '1') {
  setTimeout(async () => {
    try {
      const img = await mainWindow.webContents.capturePage();
      fs.writeFileSync(path.join(app.getPath('userData'), 'ui.png'), img.toPNG());
      log('UI 截图已保存: ui.png');
    } catch (e) {
      log('UI 截图失败:', e && e.message);
    }
  }, 4000);
}

// 调试钩子：AIHUB_DIAG=1 时模拟操作，验证侧边栏收起 / 站点切换 / 视图销毁 / lastSiteId（QA 验证用）
// 安全防线：DIAG 会模拟删除站点/清数据，强制要求 userData 已隔离（launch.js 在 AIHUB_DIAG 时
// 会自动加 --user-data-dir 临时目录；若直启 electron 绕过，这里直接拒绝运行 DIAG）
if (process.env.AIHUB_DIAG === '1') {
  const userDataPath = app.getPath('userData');
  const isolated = userDataPath.includes('aihub-test-') || userDataPath.includes('\\Temp\\') || userDataPath.includes('/tmp/');
  if (!isolated && process.env.AIHUB_ALLOW_REAL_DIAG !== '1') {
    log('【安全拦截】AIHUB_DIAG 检测到 userData 未隔离: ' + userDataPath);
    log('DIAG 会模拟删除站点/清数据，禁止在真实 userData 上运行。');
    log('请使用 npm run dev（launch.js 自动隔离），或显式 AIHUB_TEST_DATA=1。');
    process.exit(0);
  }
  setTimeout(async () => {
    try {
      // 窗口边框检查：无边框窗口 outer 与 inner 尺寸应一致（差值为 0）
      if (mainWindow && !mainWindow.isDestroyed()) {
        const outer = mainWindow.getSize();
        const inner = mainWindow.getContentSize();
        log('窗口边框检查: outer=' + outer[0] + 'x' + outer[1] + ' inner=' + inner[0] + 'x' + inner[1] + ' diff=' + (outer[1] - inner[1]));
      }
      const ui = await mainWindow.webContents.executeJavaScript(`(async () => {
        const out = {};
        const collapseBtn = document.getElementById('btn-collapse');
        out.collapseBtnExists = !!collapseBtn;
        if (collapseBtn) { try { collapseBtn.click(); } catch (e) { out.clickErr = String(e); } }
        await new Promise((r) => setTimeout(r, 400));
        out.collapsedNow = document.body.classList.contains('sidebar-collapsed');
        out.collapseBtnText = collapseBtn ? collapseBtn.textContent : '';
        // 收起状态截图标记（截图前保持收起）
        window.__diagCollapsed = out.collapsedNow;
        out.jsErrors = (window.__aihubErrors || []).slice(0, 8);
        return JSON.stringify(out);
      })()`);
      log('功能测试(UI-收起):', ui);
      await new Promise((r) => setTimeout(r, 600));
      const img = await mainWindow.webContents.capturePage();
      fs.writeFileSync(path.join(app.getPath('userData'), 'diag.png'), img.toPNG());
      log('收起状态截图已保存: diag.png');
      // 再测切站
      const ui2 = await mainWindow.webContents.executeJavaScript(`(async () => {
        const out = {};
        const items = document.querySelectorAll('.site-item');
        out.siteCount = items.length;
        if (items[1]) { try { items[1].click(); } catch (e) { out.switchErr = String(e); } }
        await new Promise((r) => setTimeout(r, 800));
        const active = document.querySelector('.site-item.active .site-name');
        out.activeHighlight = active ? active.textContent : 'NONE';
        return JSON.stringify(out);
      })()`);
      log('功能测试(UI-切站):', ui2);
      // 收起态下设置按钮应显示为图标（btn-text 隐藏、按钮可见）
      const uiCollapsed = await mainWindow.webContents.executeJavaScript(`(async () => {
        const out = {};
        const body = document.body;
        // 确保处于收起态
        if (!body.classList.contains('sidebar-collapsed')) {
          const b = document.getElementById('btn-collapse');
          if (b) b.click();
          await new Promise((r) => setTimeout(r, 300));
        }
        out.collapsed = body.classList.contains('sidebar-collapsed');
        const btn = document.getElementById('btn-settings');
        const text = btn ? btn.querySelector('.btn-text') : null;
        out.btnDisplay = btn ? getComputedStyle(btn).display : 'MISSING';
        out.btnVisible = btn ? btn.offsetWidth > 0 && btn.offsetHeight > 0 : false;
        out.textDisplay = text ? getComputedStyle(text).display : 'NO_TEXT';
        return JSON.stringify(out);
      })()`);
      log('功能测试(UI-收起设置图标):', uiCollapsed);
      log('功能测试(main):', JSON.stringify({
        viewsSize: views.size,
        activeSiteId: state.activeSiteId,
        lastSiteId: config.lastSiteId,
        sidebarCollapsed: config.sidebarCollapsed,
      }));
      // 主题功能测试：切到暗色 → 验证 UI 与 nativeTheme
      const themeBefore = config.theme;
      const t = await mainWindow.webContents.executeJavaScript(`(async () => {
        const out = {};
        // 模拟打开设置 → 点暗色 → 保存
        document.getElementById('btn-settings').click();
        await new Promise((r) => setTimeout(r, 500));
        const opts = document.querySelectorAll('.theme-opt');
        out.themeOptCount = opts.length;
        const dark = document.querySelector('.theme-opt[data-theme="dark"]');
        if (dark) dark.click();
        out.darkActive = document.querySelector('.theme-opt.active') ? document.querySelector('.theme-opt.active').dataset.theme : 'NONE';
        document.getElementById('btn-settings-save').click();
        await new Promise((r) => setTimeout(r, 1200));
        out.bodyTheme = document.body.dataset.theme;
        out.cssBg = getComputedStyle(document.body).backgroundColor;
        out.jsErrors = (window.__aihubErrors || []).slice(0, 8);
        return JSON.stringify(out);
      })()`);
      log('功能测试(UI-主题):', t);
      log('功能测试(main-主题):', JSON.stringify({
        themeBefore,
        themeAfter: config.theme,
        themeSource: nativeTheme.themeSource,
        shouldUseDark: nativeTheme.shouldUseDarkColors,
      }));
      // 右键编辑功能测试：右键站点 → 弹窗预填 → 改名称保存 → 验证
      const editTest = await mainWindow.webContents.executeJavaScript(`(async () => {
        const out = {};
        // 先展开侧边栏（收起态下站点项可点但文字不可见）
        if (document.body.classList.contains('sidebar-collapsed')) {
          document.getElementById('btn-collapse').click();
          await new Promise((r) => setTimeout(r, 300));
        }
        const item = document.querySelector('.site-item');
        out.siteExists = !!item;
        if (!item) return JSON.stringify(out);
        const origName = item.querySelector('.site-name').textContent;
        out.origName = origName;
        // 触发右键
        const evt = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        item.dispatchEvent(evt);
        await new Promise((r) => setTimeout(r, 400));
        const inpName = document.getElementById('inp-name');
        const title = document.getElementById('modal-title');
        out.maskOpen = !document.getElementById('modal-mask').classList.contains('hidden');
        out.title = title ? title.textContent : 'MISSING';
        out.prefilledName = inpName ? inpName.value : '';
        out.delVisible = !document.getElementById('btn-del-site').classList.contains('hidden');
        // 改名保存
        const newName = origName + '✎';
        if (inpName) { inpName.value = newName; }
        document.getElementById('btn-save').click();
        await new Promise((r) => setTimeout(r, 1200));
        const updated = [...document.querySelectorAll('.site-item .site-name')].map(n => n.textContent);
        out.updatedNames = updated;
        out.hasNewName = updated.includes(newName);
        out.jsErrors = (window.__aihubErrors || []).slice(0, 8);
        return JSON.stringify(out);
      })()`);
      log('功能测试(UI-右键编辑):', editTest);
      log('功能测试(main-右键编辑):', JSON.stringify({
        siteCount: config.sites.length,
        names: config.sites.map((s) => s.name),
      }));
      // 拖动排序功能测试：把最后一个站点拖到最前 → 验证 config 顺序变化
      const reorderTest = await mainWindow.webContents.executeJavaScript(`(async () => {
        const out = {};
        const items = [...document.querySelectorAll('.site-item')];
        out.itemCount = items.length;
        out.orderBefore = items.map((el) => el.querySelector('.site-name').textContent);
        if (items.length < 2) return JSON.stringify(out);
        const source = items[items.length - 1];
        const target = items[0];
        // 模拟：dragstart(source) → dragover(target, 上方) → dragend(source)
        try {
          const dt = new DataTransfer();
          source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
          target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: 0 }));
          source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
        } catch (e) {
          out.dragErr = String(e);
        }
        await new Promise((r) => setTimeout(r, 800));
        const itemsAfter = [...document.querySelectorAll('.site-item')];
        out.orderAfter = itemsAfter.map((el) => el.querySelector('.site-name').textContent);
        out.draggableFirst = itemsAfter[0] ? itemsAfter[0].draggable : 'MISSING';
        return JSON.stringify(out);
      })()`);
      log('功能测试(UI-拖动排序):', reorderTest);
      log('功能测试(main-拖动排序):', JSON.stringify({
        names: config.sites.map((s) => s.name),
        ids: config.sites.map((s) => s.id),
      }));
      // 添加按钮位置检查：应在 site-list 之后、sidebar-foot 之前
      const addBtnPos = await mainWindow.webContents.executeJavaScript(`(() => {
        const sidebar = document.getElementById('sidebar');
        const children = [...sidebar.children];
        const idx = (n) => children.indexOf(n);
        return JSON.stringify({
          btnAddText: document.getElementById('btn-add').innerText,
          afterList: idx(document.getElementById('btn-add')) === idx(document.getElementById('site-list')) + 1,
          beforeFoot: idx(document.getElementById('btn-add')) === idx(document.querySelector('.sidebar-foot')) - 1,
          inHead: document.querySelector('.sidebar-head').contains(document.getElementById('btn-add')),
        });
      })()`);
      log('功能测试(UI-添加按钮位置):', addBtnPos);
      // 删除确认 UI 验证；共享/独立数据隔离由 npm test 的真实 Session 测试覆盖。
      const delVictim = config.sites[config.sites.length - 1];
      const delVictimId = delVictim ? delVictim.id : '';
      const delTest = await mainWindow.webContents.executeJavaScript(`(async () => {
        const out = {};
        const items = [...document.querySelectorAll('.site-item')];
        if (items.length === 0) { out.error = 'no sites'; return JSON.stringify(out); }
        const victim = items[items.length - 1];
        const victimName = victim.querySelector('.site-name').textContent;
        out.victim = victimName;
        // 点击删除按钮（×）触发确认弹窗
        victim.querySelector('.site-del').click();
        await new Promise((r) => setTimeout(r, 400));
        const delMask = document.getElementById('modal-del-mask');
        out.maskOpen = !delMask.classList.contains('hidden');
        out.delNameText = document.getElementById('del-site-name').textContent;
        // 勾选"同时删除本地数据"
        const chk = document.getElementById('chk-del-data');
        chk.checked = true;
        out.checked = chk.checked;
        document.getElementById('btn-del-confirm').click();
        await new Promise((r) => setTimeout(r, 1200));
        const namesAfter = [...document.querySelectorAll('.site-item .site-name')].map(n => n.textContent);
        out.removed = !namesAfter.includes(victimName);
        out.namesAfter = namesAfter;
        out.jsErrors = (window.__aihubErrors || []).slice(0, 8);
        return JSON.stringify(out);
      })()`);
      log('功能测试(UI-删除):', delTest);
      log('功能测试(main-删除):', JSON.stringify({
        siteCount: config.sites.length,
        names: config.sites.map((s) => s.name),
      }));
      // 独立数据已清空，目录在下次启动清理；共享会话永不入队整区删除。
      log('功能测试(删除数据验证):', JSON.stringify({
        victim: delVictimId,
        useIndependentData: delVictim && delVictim.useIndependentData,
        queuedForDirectoryCleanup: (config.pendingDataDeletions || []).includes(delVictimId),
      }));
      // 唤起窗口自动聚焦输入框测试：hide + 模拟快捷键唤起 → 查日志
      // 主窗口先 hide 一下
      mainWindow.hide();
      await new Promise((r) => setTimeout(r, 600));
      toggleMain(); // 模拟用户按全局快捷键
      await new Promise((r) => setTimeout(r, 1500));
      // 这里日志里应出现 "focus input: {"ok":true,...}"
      // 额外验证：焦点是否真的落在站点输入框（activeElement 是否 textarea/contenteditable）
      const focusVerify = await mainWindow.webContents.executeJavaScript(
        'document.activeElement ? document.activeElement.tagName + (document.activeElement.placeholder || "") : "BODY"'
      ).catch(() => 'ERR');
      log('焦点验证(主UI activeElement):', focusVerify);
      // 同时验证站点 webContents 内的 activeElement
      if (state.activeSiteId && views.has(state.activeSiteId)) {
        const siteWc = views.get(state.activeSiteId).view.webContents;
        const siteFocus = await siteWc
          .executeJavaScript(
            `(() => {
              const el = document.activeElement;
              if (!el || el === document.body) return 'BODY';
              return el.tagName + '|' + (el.placeholder || el.getAttribute('aria-label') || '');
            })()`,
            true
          )
          .catch((e) => 'ERR:' + e.message);
        log('焦点验证(站点activeElement):', siteFocus);
      }
    } catch (e) {
      log('诊断失败:', e && e.message);
    }
  }, 6000);
    }
}

module.exports = { run };
