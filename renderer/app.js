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

/**
 * 图标候选地址（按优先级）：自定义图标优先；未自定义时依次尝试
 * 页面上报的真实 favicon → Google 图标服务 → 站点根目录 favicon.ico
 */
function iconCandidates(site) {
  if (site.icon) return [site.icon];
  const list = [];
  if (site.favicon) list.push(site.favicon);
  try {
    const u = new URL(site.url);
    list.push('https://www.google.com/s2/favicons?domain=' + u.hostname + '&sz=64');
    if (u.protocol === 'https:') list.push(u.origin + '/favicon.ico');
  } catch {
    /* 网址非法：只显示首字母 */
  }
  return list;
}

/** 在 container 中渲染图标：候选地址逐个尝试，全部失败显示名称首字母 */
function fillIcon(container, candidates, name) {
  container.textContent = '';
  const fallback = () => {
    container.textContent = ((name || '').trim()[0] || '?').toUpperCase();
  };
  const tryAt = (i) => {
    if (i >= candidates.length) return fallback();
    const img = document.createElement('img');
    img.alt = '';
    img.addEventListener('error', () => {
      img.remove();
      tryAt(i + 1);
    });
    img.src = candidates[i];
    container.appendChild(img);
  };
  tryAt(0);
}

function renderSites() {
  listEl.innerHTML = '';
  const emptyHint = document.getElementById('empty-hint');
  emptyHint.classList.toggle('hidden', sites.length > 0);

  sites.forEach((site) => {
    const li = document.createElement('li');
    li.className = 'site-item' + (site.id === activeId ? ' active' : '');
    li.dataset.siteId = site.id;
    li.title = site.name + '\n' + site.url + '\n' + (site.useIndependentData ? '独立数据' : '共享数据');

    const icon = document.createElement('span');
    icon.className = 'site-icon';
    fillIcon(icon, iconCandidates(site), site.name);

    const name = document.createElement('span');
    name.className = 'site-name';
    name.textContent = site.name;

    const del = document.createElement('button');
    del.className = 'site-del';
    del.title = site.useIndependentData ? '删除站点及独立数据' : '移除站点（可选择清理本地数据）';
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
  updatePinState(cfg.alwaysOnTop);

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

/** CommandOrControl → 平台显示名（实现在 shared/ui-constants.js，与主进程托盘共用） */
function formatShortcut(accel) {
  return window.AIHubUI.formatShortcut(accel, platform);
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

// 页面上报了新的 favicon：更新本地缓存并重绘（自定义图标的站点不受影响）
window.hub.onFavicon(({ id, favicon }) => {
  const site = sites.find((s) => s.id === id);
  if (!site || site.favicon === favicon) return;
  site.favicon = favicon;
  if (!site.icon) renderSites();
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
function updatePinState(pinned) {
  const button = document.getElementById('btn-pin');
  button.classList.toggle('on', !!pinned);
  button.setAttribute('aria-pressed', String(!!pinned));
  button.title = pinned ? '取消窗口置顶' : '窗口置顶';
  button.setAttribute('aria-label', button.title);
  alwaysOnTopInitial = !!pinned;
  document.getElementById('chk-top').checked = !!pinned;
}

window.hub.onPinned(updatePinState);
document.getElementById('btn-pin').addEventListener('click', async () => {
  updatePinState(await window.hub.togglePin());
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
const chkIndependentData = document.getElementById('chk-independent-data');
const storageTip = document.getElementById('storage-tip');
const modalTitle = document.getElementById('modal-title');
const btnSave = document.getElementById('btn-save');
const btnDelSite = document.getElementById('btn-del-site');
const inpIcon = document.getElementById('inp-icon');
const iconPreview = document.getElementById('icon-preview');
const fileIcon = document.getElementById('file-icon');
let editingSiteId = null; // 非空 = 编辑模式
let pickedIconData = ''; // 本地图片转成的 data URL（输入框只显示提示文字）

/** 设置弹窗里的自定义图标：data URL 或 https 地址，'' = 自动获取 */
function setIconInput(icon) {
  pickedIconData = icon && icon.startsWith('data:') ? icon : '';
  inpIcon.readOnly = !!pickedIconData;
  inpIcon.value = pickedIconData ? '已选择本地图片' : icon || '';
  updateIconPreview();
}

function currentIconInput() {
  return pickedIconData || inpIcon.value.trim();
}

function updateIconPreview() {
  const editing = sites.find((s) => s.id === editingSiteId);
  const url = inpUrl.value.trim();
  fillIcon(iconPreview, iconCandidates({
    url,
    icon: currentIconInput(),
    // 网址没改时沿用已拉取到的真实 favicon
    favicon: editing && editing.url === url ? editing.favicon : '',
  }), inpName.value);
}

/** 把本地图片缩放成 64×64 PNG data URL，控制配置文件体积 */
function imageFileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('无法识别该图片'));
      img.onload = () => {
        const size = 64;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const scale = Math.min(size / img.width, size / img.height) || 1;
        const w = img.width * scale;
        const h = img.height * scale;
        canvas.getContext('2d').drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        resolve(canvas.toDataURL('image/png'));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

document.getElementById('btn-icon-pick').addEventListener('click', () => fileIcon.click());
document.getElementById('btn-icon-reset').addEventListener('click', () => setIconInput(''));
fileIcon.addEventListener('change', async () => {
  const file = fileIcon.files && fileIcon.files[0];
  fileIcon.value = '';
  if (!file) return;
  try {
    setIconInput(await imageFileToDataUrl(file));
  } catch (error) {
    window.alert(error.message);
  }
});
inpIcon.addEventListener('input', updateIconPreview);
inpUrl.addEventListener('input', updateIconPreview);
inpName.addEventListener('input', updateIconPreview);

function openAddModal() {
  editingSiteId = null;
  inpName.value = '';
  inpUrl.value = '';
  setIconInput('');
  chkIndependentData.checked = false;
  storageTip.textContent = '默认共享登录状态和网站数据。勾选后单独保存，可登录其他账号。登录状态会自动保存在本地。';
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
  setIconInput(site.icon || '');
  chkIndependentData.checked = site.useIndependentData === true;
  storageTip.textContent = '取消勾选使用共享数据。切换模式后可能需要重新登录；原有数据会保留，切回原模式可继续使用，不会自动合并账号。';
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
[inpUrl, inpIcon].forEach((input) => input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveSite();
  else if (e.key === 'Escape') closeModal();
}));

async function saveSite() {
  const name = inpName.value.trim();
  const url = inpUrl.value.trim();
  const useIndependentData = chkIndependentData.checked;
  const icon = currentIconInput();
  if (!name || !/^https?:\/\//i.test(url)) {
    window.alert('请输入名称和以 http(s):// 开头的完整网址');
    return;
  }
  const res = editingSiteId
    ? await window.hub.updateSite({ id: editingSiteId, name, url, useIndependentData, icon })
    : await window.hub.addSite({ name, url, useIndependentData, icon });
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
let pendingDeleteIndependent = false;
let deleteInProgress = false;
const btnDelConfirm = document.getElementById('btn-del-confirm');
const btnDelCancel = document.getElementById('btn-del-cancel');

function openDeleteModal(site) {
  pendingDeleteId = site.id;
  pendingDeleteIndependent = site.useIndependentData === true;
  delSiteName.textContent = site.name || '';
  chkDelData.checked = pendingDeleteIndependent;
  chkDelData.disabled = pendingDeleteIndependent;
  btnDelConfirm.textContent = pendingDeleteIndependent ? '删除并清理数据' : '删除';
  document.getElementById('del-data-label').textContent = site.useIndependentData
    ? '删除该站点的独立数据和缓存（必选）'
    : '同时清除该网站专属的本地数据';
  document.getElementById('del-data-tip').textContent = site.useIndependentData
    ? '删除独立站点会同时清空当前独立空间，包括登录状态和缓存，无法撤销。重新添加将创建全新的独立空间。'
    : '仅清理此网址所属网站的存储和专属 Cookie。其他入口仍在使用的数据、跨网站登录 Cookie 和共享网络缓存会保留。不勾选则只移除入口。';
  delMask.classList.remove('hidden');
  window.hub.setOverlay(true); // 弹窗打开：隐藏站点视图
}

function closeDeleteModal() {
  if (deleteInProgress) return;
  pendingDeleteId = null;
  pendingDeleteIndependent = false;
  delMask.classList.add('hidden');
  window.hub.setOverlay(false);
}

document.getElementById('btn-del-cancel').addEventListener('click', closeDeleteModal);
delMask.addEventListener('click', (e) => {
  if (e.target === delMask) closeDeleteModal();
});

btnDelConfirm.addEventListener('click', async () => {
  if (!pendingDeleteId || deleteInProgress) return;
  const id = pendingDeleteId;
  const deleteData = pendingDeleteIndependent || chkDelData.checked;
  deleteInProgress = true;
  btnDelConfirm.disabled = btnDelCancel.disabled = chkDelData.disabled = true;
  btnDelConfirm.textContent = '正在删除…';
  let removed = false;
  try {
    const res = await window.hub.removeSite(id, deleteData);
    if (!res || !res.ok) throw new Error((res && res.error) || '删除失败');
    removed = true;
    sites = await window.hub.listSites();
    if (id === activeId) activeId = null;
    renderSites();
  } catch (error) {
    window.alert(error.message || '删除失败，请重试');
  } finally {
    deleteInProgress = false;
    btnDelConfirm.disabled = btnDelCancel.disabled = false;
    chkDelData.disabled = pendingDeleteIndependent;
    btnDelConfirm.textContent = pendingDeleteIndependent ? '删除并清理数据' : '删除';
    if (removed) closeDeleteModal();
  }
});

/* ---------- 设置弹窗 ---------- */
const settingsMask = document.getElementById('modal-settings-mask');
const btnRecord = document.getElementById('btn-record');
const recordHint = document.getElementById('record-hint');
const chkTop = document.getElementById('chk-top');
const selKeepAlive = document.getElementById('sel-keep-alive');
let keepAliveInitial = 3;

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
  keepAliveInitial = cfg.keepAliveSites || 3;
  // 手动改过 config.json 的非预设值：补一个选项，避免下拉框显示为空
  if (![...selKeepAlive.options].some((o) => Number(o.value) === keepAliveInitial)) {
    selKeepAlive.add(new Option(String(keepAliveInitial), String(keepAliveInitial)));
  }
  selKeepAlive.value = String(keepAliveInitial);
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
    updatePinState(await window.hub.togglePin());
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

  // 4) 后台保活站点数（仅在变化时更新）
  const keepAlive = Number(selKeepAlive.value);
  if (keepAlive !== keepAliveInitial) {
    const res = await window.hub.updateKeepAlive(keepAlive);
    if (!res || !res.ok) window.alert((res && res.error) || '保活设置更新失败');
  }

  pendingShortcut = '';
  closeSettings();
});
