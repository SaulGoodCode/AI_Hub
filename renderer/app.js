'use strict';

/* AI Hub 渲染进程逻辑 */

// 收集运行时错误，供 AIHUB_DIAG 诊断钩子查看
window.__aihubErrors = [];
window.addEventListener('error', (e) => {
  window.__aihubErrors.push('error: ' + e.message + ' @' + (e.filename || '') + ':' + (e.lineno || ''));
});
window.addEventListener('unhandledrejection', (e) => {
  window.__aihubErrors.push('unhandledrejection: ' + String(e.reason));
});

let sites = [];
let activeId = null;
let platform = 'win32';
let currentShortcut = 'Ctrl+Shift+Space';
let alwaysOnTopInitial = false;
let recording = false;
let pendingShortcut = '';
let currentTheme = 'system';
let dragSiteId = null; // 拖动排序中的站点 id

const listEl = document.getElementById('site-list');

function faviconUrl(url) {
  try {
    return 'https://www.google.com/s2/favicons?domain=' + new URL(url).hostname + '&sz=64';
  } catch {
    return '';
  }
}

function renderSites() {
  listEl.innerHTML = '';
  const emptyHint = document.getElementById('empty-hint');
  emptyHint.classList.toggle('hidden', sites.length > 0);

  sites.forEach((site) => {
    const li = document.createElement('li');
    li.className = 'site-item' + (site.id === activeId ? ' active' : '');
    li.dataset.siteId = site.id;
    li.title = site.name + '\n' + site.url;

    const icon = document.createElement('span');
    icon.className = 'site-icon';
    const img = document.createElement('img');
    img.src = faviconUrl(site.url);
    img.alt = '';
    img.addEventListener('error', () => {
      img.remove();
      icon.textContent = (site.name[0] || '?').toUpperCase();
    });
    icon.appendChild(img);

    const name = document.createElement('span');
    name.className = 'site-name';
    name.textContent = site.name;

    const del = document.createElement('button');
    del.className = 'site-del';
    del.title = '移除站点（本地登录数据保留）';
    del.textContent = '×';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      openDeleteModal(site);
    });

    li.append(icon, name, del);
    li.addEventListener('click', () => {
      activeId = site.id;
      renderSites();
      window.hub.activateSite(site.id);
    });
    // 右键：编辑站点（复用弹窗，预填数据）
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openEditModal(site);
    });
    // 拖动排序（仅展开态可拖；收起态下 draggable 关闭）
    li.draggable = !document.body.classList.contains('sidebar-collapsed');
    li.addEventListener('dragstart', (e) => {
      dragSiteId = site.id;
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try {
        e.dataTransfer.setData('text/plain', site.id);
      } catch {
        /* ignore */
      }
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
      if (dragSiteId) {
        // 按当前 DOM 顺序收集，持久化
        const ids = [...listEl.querySelectorAll('.site-item')].map((el) => el.dataset.siteId);
        const changed = JSON.stringify(ids) !== JSON.stringify(sites.map((s) => s.id));
        dragSiteId = null;
        if (changed && ids.length > 0) {
          window.hub.reorderSites(ids).then(async (res) => {
            if (res && res.ok) {
              sites = await window.hub.listSites();
              renderSites();
            }
          });
        }
      }
    });
    li.addEventListener('dragover', (e) => {
      if (!dragSiteId || dragSiteId === site.id) return;
      e.preventDefault();
      const rect = li.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      const dragEl = listEl.querySelector(`[data-site-id="${dragSiteId}"]`);
      if (!dragEl) return;
      if (before) {
        if (li.previousElementSibling !== dragEl) listEl.insertBefore(dragEl, li);
      } else {
        if (li.nextElementSibling !== dragEl) listEl.insertBefore(dragEl, li.nextElementSibling);
      }
    });

    listEl.appendChild(li);
  });
}

/** 应用主题到 UI：body[data-theme] 控制 CSS 变量；系统未解析时用 prefers-color-scheme 兜底 */
function applyThemeToUI(resolved) {
  const effective = resolved || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.body.dataset.theme = effective;
}

/** 同步主题选择按钮的高亮态 */
function syncThemeButtons(theme) {
  document.querySelectorAll('.theme-opt').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  });
}

async function init() {
  const cfg = await window.hub.getConfig();
  platform = cfg.platform;
  currentShortcut = cfg.shortcut;
  currentTheme = cfg.theme || 'system';

  applyThemeToUI(cfg.themeResolved);

  if (cfg.platform === 'darwin') {
    document.body.classList.add('platform-mac');
  } else {
    document.body.classList.add('platform-win');
  }

  // 侧边栏收起状态
  applySidebarCollapsed(!!cfg.sidebarCollapsed);

  sites = await window.hub.listSites();
  renderSites();
  applyFooterHint();
}

function applySidebarCollapsed(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  const btn = document.getElementById('btn-collapse');
  if (btn) {
    btn.textContent = collapsed ? '»' : '«';
    btn.title = collapsed ? '展开侧边栏' : '收起侧边栏';
  }
  // 收起态下禁用站点拖动（只留图标列，拖不动更清晰）
  document.querySelectorAll('.site-item').forEach((el) => {
    el.draggable = !collapsed;
  });
}

async function toggleSidebar() {
  const collapsed = await window.hub.toggleSidebar();
  applySidebarCollapsed(collapsed);
}

document.getElementById('btn-collapse').addEventListener('click', toggleSidebar);

function formatShortcut(accel) {
  // CommandOrControl → 平台显示名
  return accel
    .split('+')
    .map((k) => {
      if (k === 'CommandOrControl') return platform === 'darwin' ? '⌘' : 'Ctrl';
      if (k === 'Control') return 'Ctrl';
      if (k === 'Command' || k === 'Cmd') return '⌘';
      if (k === 'Option') return 'Alt';
      if (k === 'Super') return 'Win';
      if (k === 'Esc') return 'Esc';
      return k;
    })
    .join('+');
}

/** 更新底部"快捷键提示"，必须在知道 currentShortcut 和 platform 后调用 */
function applyFooterHint() {
  const shortcut = formatShortcut(currentShortcut);
  document.getElementById('foot-hint').textContent =
    platform === 'darwin'
      ? `按 ${shortcut} 唤起/隐藏窗口\n关闭窗口后常驻托盘`
      : `按 ${shortcut} 唤起/隐藏窗口\n关闭窗口后常驻托盘（点托盘图标可重新打开）`;
}

init();

window.hub.onActivated((id) => {
  activeId = id;
  renderSites();
});

window.hub.onShortcutFailed((shortcut) => {
  window.alert(`快捷键 ${formatShortcut(shortcut)} 注册失败，可能已被其他应用占用。\n请修改配置文件 config.json 中的 shortcut 字段后重启应用。`);
});

// 主题变化（设置保存 / 系统深浅模式切换）→ 实时应用到 UI
window.hub.onThemeChanged((info) => {
  currentTheme = info.theme;
  applyThemeToUI(info.resolved);
});

// ---------- 标题栏控制 ----------
document.getElementById('btn-min').addEventListener('click', () => window.hub.minimize());
document.getElementById('btn-close').addEventListener('click', () => window.hub.hide());
document.getElementById('btn-pin').addEventListener('click', async (e) => {
  const pinned = await window.hub.togglePin();
  e.currentTarget.classList.toggle('on', pinned);
});

// 最大化 / 还原
function updateMaxBtn(maximized) {
  const btn = document.getElementById('btn-max');
  if (!btn) return;
  btn.textContent = maximized ? '❐' : '□';
  btn.title = maximized ? '还原' : '最大化';
}

document.getElementById('btn-max').addEventListener('click', async () => {
  const maximized = await window.hub.toggleMaximize();
  updateMaxBtn(maximized);
});

// 系统方式（如拖到屏幕顶部）最大化时同步图标
window.hub.onMaximized(updateMaxBtn);

// 双击标题栏拖拽区 最大化/还原（Windows 惯例）
document.querySelector('.titlebar-drag').addEventListener('dblclick', async () => {
  if (document.body.classList.contains('platform-win')) {
    const maximized = await window.hub.toggleMaximize();
    updateMaxBtn(maximized);
  }
});

// ---------- 添加/编辑站点 ----------
const mask = document.getElementById('modal-mask');
const inpName = document.getElementById('inp-name');
const inpUrl = document.getElementById('inp-url');
const modalTitle = document.getElementById('modal-title');
const btnSave = document.getElementById('btn-save');
const btnDelSite = document.getElementById('btn-del-site');
let editingSiteId = null; // 非空 = 编辑模式

function openAddModal() {
  editingSiteId = null;
  inpName.value = '';
  inpUrl.value = '';
  modalTitle.textContent = '添加 AI 站点';
  btnSave.textContent = '添加';
  btnDelSite.classList.add('hidden');
  mask.classList.remove('hidden');
  window.hub.setOverlay(true); // 弹窗打开：隐藏站点视图，避免被原生子视图遮挡
  inpName.focus();
}

function openEditModal(site) {
  editingSiteId = site.id;
  inpName.value = site.name;
  inpUrl.value = site.url;
  modalTitle.textContent = '编辑站点';
  btnSave.textContent = '保存';
  btnDelSite.classList.remove('hidden');
  mask.classList.remove('hidden');
  window.hub.setOverlay(true);
  inpName.focus();
  inpName.select();
}

document.getElementById('btn-add').addEventListener('click', openAddModal);

function closeModal() {
  editingSiteId = null;
  mask.classList.add('hidden');
  window.hub.setOverlay(false); // 弹窗关闭：恢复站点视图
}

document.getElementById('btn-cancel').addEventListener('click', closeModal);
mask.addEventListener('click', (e) => {
  if (e.target === mask) closeModal();
});
inpName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveSite();
});
inpUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveSite();
  else if (e.key === 'Escape') closeModal();
});

async function saveSite() {
  const name = inpName.value.trim();
  const url = inpUrl.value.trim();
  if (!name || !/^https?:\/\//i.test(url)) {
    window.alert('请输入名称和以 http(s):// 开头的完整网址');
    return;
  }
  const res = editingSiteId
    ? await window.hub.updateSite({ id: editingSiteId, name, url })
    : await window.hub.addSite({ name, url });
  if (res && res.ok) {
    sites = await window.hub.listSites();
    if (!editingSiteId) activeId = res.site.id;
    renderSites();
    closeModal();
  } else {
    window.alert((res && res.error) || '保存失败');
  }
}

// 编辑弹窗里的删除按钮：先关编辑弹窗，再弹删除确认
btnDelSite.addEventListener('click', () => {
  if (!editingSiteId) return;
  const site = sites.find((s) => s.id === editingSiteId);
  closeModal();
  openDeleteModal(site || { id: editingSiteId, name: '' });
});

document.getElementById('btn-save').addEventListener('click', saveSite);

/* ---------- 删除站点确认弹窗 ---------- */
const delMask = document.getElementById('modal-del-mask');
const delSiteName = document.getElementById('del-site-name');
const chkDelData = document.getElementById('chk-del-data');
let pendingDeleteId = null;

function openDeleteModal(site) {
  pendingDeleteId = site.id;
  delSiteName.textContent = site.name || '';
  chkDelData.checked = false;
  delMask.classList.remove('hidden');
  window.hub.setOverlay(true); // 弹窗打开：隐藏站点视图
}

function closeDeleteModal() {
  pendingDeleteId = null;
  delMask.classList.add('hidden');
  window.hub.setOverlay(false);
}

document.getElementById('btn-del-cancel').addEventListener('click', closeDeleteModal);
delMask.addEventListener('click', (e) => {
  if (e.target === delMask) closeDeleteModal();
});

document.getElementById('btn-del-confirm').addEventListener('click', async () => {
  if (!pendingDeleteId) return;
  const id = pendingDeleteId;
  const deleteData = chkDelData.checked;
  closeDeleteModal();
  await window.hub.removeSite(id, deleteData);
  sites = await window.hub.listSites();
  if (id === activeId) activeId = null;
  renderSites();
});

/* ---------- 设置弹窗 ---------- */
const settingsMask = document.getElementById('modal-settings-mask');
const btnRecord = document.getElementById('btn-record');
const recordHint = document.getElementById('record-hint');
const chkTop = document.getElementById('chk-top');

const SPECIAL_KEYS = {
  ' ': 'Space',
  Escape: 'Esc',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  '`': '`',
  '-': '-',
  '=': '=',
  '[': '[',
  ']': ']',
  '\\': '\\',
  ';': ';',
  "'": "'",
  ',': ',',
  '.': '.',
  '/': '/',
};

async function openSettings() {
  const cfg = await window.hub.getConfig();
  currentShortcut = cfg.shortcut;
  alwaysOnTopInitial = !!cfg.alwaysOnTop;
  chkTop.checked = alwaysOnTopInitial;
  btnRecord.textContent = formatShortcut(currentShortcut);
  recordHint.textContent = '点击按钮后按下新组合键';
  syncThemeButtons(cfg.theme || 'system');
  settingsMask.classList.remove('hidden');
  window.hub.setOverlay(true); // 弹窗打开：隐藏站点视图，避免被原生子视图遮挡
}

function closeSettings() {
  stopRecording();
  settingsMask.classList.add('hidden');
  window.hub.setOverlay(false); // 弹窗关闭：恢复站点视图
}

function startRecording() {
  recording = true;
  pendingShortcut = '';
  btnRecord.classList.add('recording');
  btnRecord.textContent = '按下新的快捷键…';
  recordHint.textContent = '按 ESC 取消录制';
}

function stopRecording() {
  recording = false;
  btnRecord.classList.remove('recording');
  btnRecord.textContent = formatShortcut(pendingShortcut || currentShortcut);
  recordHint.textContent = '点击按钮后按下新组合键';
}

function handleShortcutKey(e) {
  if (!recording) return;
  e.preventDefault();
  e.stopPropagation();

  if (e.key === 'Escape') {
    pendingShortcut = '';
    stopRecording();
    return;
  }

  // 组装修饰键（存储统一用 CommandOrControl，跨平台）
  const mods = [];
  if (platform === 'darwin') {
    if (e.metaKey) mods.push('CommandOrControl');
  } else {
    if (e.ctrlKey) mods.push('CommandOrControl');
  }
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');

  // 主键
  let mainKey = '';
  if (e.key && e.key.length === 1) {
    if (/[a-zA-Z0-9]/.test(e.key)) mainKey = e.key.toUpperCase();
    else if (SPECIAL_KEYS[e.key]) mainKey = SPECIAL_KEYS[e.key];
  } else if (SPECIAL_KEYS[e.key]) {
    mainKey = SPECIAL_KEYS[e.key];
  } else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.key)) {
    mainKey = e.key;
  }

  if (!mainKey) return; // 单独按下修饰键，等待主键
  if (mods.length === 0) {
    recordHint.textContent = '至少需要一个修饰键（Ctrl / ⌘ / Alt / Shift）';
    return;
  }

  pendingShortcut = [...mods, mainKey].join('+');
  recording = false;
  btnRecord.classList.remove('recording');
  btnRecord.textContent = formatShortcut(pendingShortcut);
  recordHint.textContent = '点击「保存」生效';
}

document.addEventListener('keydown', handleShortcutKey);

document.getElementById('btn-settings').addEventListener('click', openSettings);
document.getElementById('btn-settings-close').addEventListener('click', closeSettings);
settingsMask.addEventListener('click', (e) => {
  if (e.target === settingsMask) closeSettings();
});
// 主题选择：点击高亮（保存时统一应用）
document.querySelectorAll('.theme-opt').forEach((btn) => {
  btn.addEventListener('click', () => syncThemeButtons(btn.dataset.theme));
});
btnRecord.addEventListener('click', () => {
  if (recording) stopRecording();
  else startRecording();
});

document.getElementById('btn-settings-save').addEventListener('click', async () => {
  // 1) 快捷键
  if (pendingShortcut && pendingShortcut !== currentShortcut) {
    const res = await window.hub.updateShortcut(pendingShortcut);
    if (res && res.ok) {
      currentShortcut = res.shortcut;
      applyFooterHint();
    } else {
      window.alert((res && res.error) || '快捷键更新失败');
      return;
    }
  }

  // 2) 置顶开关（仅在状态需要变化时切换一次）
  const wantTop = chkTop.checked;
  if (wantTop !== alwaysOnTopInitial) {
    await window.hub.togglePin();
    alwaysOnTopInitial = wantTop;
  }

  // 3) 外观主题（仅在变化时更新）
  const activeTheme = document.querySelector('.theme-opt.active');
  if (activeTheme && activeTheme.dataset.theme !== currentTheme) {
    const res = await window.hub.updateTheme(activeTheme.dataset.theme);
    if (res && res.ok) {
      currentTheme = res.theme;
    } else {
      window.alert((res && res.error) || '主题更新失败');
    }
  }

  pendingShortcut = '';
  closeSettings();
});
