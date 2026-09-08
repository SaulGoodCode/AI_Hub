'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const electron = require('electron');

module.exports = async function testUI(testRoot) {
  const root = path.resolve(__dirname, '..');
  let failClear = false;
  const mainRequire = createRequire(path.join(root, 'main.js'));
  // Exercise the production config/IPC handlers without starting a tray, global
  // shortcut or external site. All actual Session and renderer APIs remain real.
  const fakeApp = new Proxy(electron.app, {
    get(target, key) {
      if (key === 'whenReady') return () => new Promise(() => {});
      if (key === 'requestSingleInstanceLock') return () => true;
      if (key === 'on') return () => {};
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const sandbox = {
    require: (name) => {
      if (name === 'electron') return { ...electron, app: fakeApp };
      if (name === './site-data') {
        const data = mainRequire(name);
        return { ...data, clearSiteData: (...args) => failClear ? Promise.reject(new Error('TEST clear failure')) : data.clearSiteData(...args) };
      }
      return mainRequire(name);
    },
    __dirname: root, module: { exports: {} }, console, process, URL, setTimeout, clearTimeout,
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8') + '\nmodule.exports = { loadConfig, registerIpc };', sandbox);
  sandbox.module.exports.loadConfig();
  sandbox.module.exports.registerIpc();

  const ses = electron.session.fromPartition('ui-test');
  ses.protocol.handle('https', () => new Response('', { status: 404 }));
  const win = new electron.BrowserWindow({
    show: false, width: 1000, height: 720,
    webPreferences: { session: ses, preload: path.join(root, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
  });
  const run = (script) => win.webContents.executeJavaScript(script);
  try {
    await win.loadFile(path.join(root, 'renderer/index.html'));
    await run('init()');
    assert.equal(await run('sites.every(s => s.useIndependentData === false)'), true);
    await run(`window.alert = message => { window.lastAlert = message; }; openAddModal()`);
    assert.equal(await run('chkIndependentData.checked'), false);
    await run(`inpName.value = 'Shared fixture'; inpUrl.value = 'https://ui.example.test/'; saveSite()`);
    const shared = await run(`sites.find(s => s.name === 'Shared fixture')`);
    assert.equal(shared.useIndependentData, false);
    await run(`openAddModal(); inpName.value = 'Independent fixture'; inpUrl.value = 'https://ui.example.test/'; chkIndependentData.checked = true; saveSite()`);
    const isolated = await run(`sites.find(s => s.name === 'Independent fixture')`);
    assert.equal(isolated.useIndependentData, true);
    await run(`openEditModal(sites.find(s => s.id === ${JSON.stringify(isolated.id)}))`);
    assert.equal(await run('chkIndependentData.checked'), true);
    await run(`chkIndependentData.checked = false; saveSite()`);
    assert.equal(await run(`sites.find(s => s.id === ${JSON.stringify(isolated.id)}).useIndependentData`), false);
    await run(`openAddModal()`);
    assert.equal(await run('chkIndependentData.checked'), false);
    await run(`applyThemeToUI('light')`);
    await new Promise(resolve => setTimeout(resolve, 300));
    fs.writeFileSync(path.join(testRoot, 'add-site.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());

    // Submit real renderer delete UI through the production IPC handler, with a
    // controlled failure to verify it keeps the entry and offers a retry.
    await run(`closeModal(); openDeleteModal(sites.find(s => s.id === ${JSON.stringify(shared.id)})); chkDelData.checked = true`);
    await new Promise(resolve => setTimeout(resolve, 300));
    fs.writeFileSync(path.join(testRoot, 'delete-shared.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    failClear = true;
    await run(`btnDelConfirm.click(); new Promise((resolve, reject) => {
      const start = Date.now();
      const poll = () => {
        if (!deleteInProgress) return resolve();
        if (Date.now() - start > 4000) return reject(new Error('Delete UI timed out'));
        setTimeout(poll, 10);
      }; poll();
    })`);
    assert.equal(await run(`sites.some(s => s.id === ${JSON.stringify(shared.id)})`), true);
    assert.equal(await run(`delMask.classList.contains('hidden')`), false);
    assert.match(await run('window.lastAlert'), /TEST clear failure/);
    failClear = false;
    await run(`btnDelConfirm.click(); new Promise((resolve, reject) => {
      const start = Date.now();
      const poll = () => {
        if (!deleteInProgress) return resolve();
        if (Date.now() - start > 4000) return reject(new Error('Delete retry timed out'));
        setTimeout(poll, 10);
      }; poll();
    })`);
    assert.equal(await run(`sites.some(s => s.id === ${JSON.stringify(shared.id)})`), false);
    assert.equal(await run(`delMask.classList.contains('hidden')`), true);
    assert.deepEqual(await run('window.__aihubErrors'), []);

    const cfg = JSON.parse(fs.readFileSync(path.join(testRoot, 'config.json'), 'utf8'));
    assert.equal(cfg.sites.find(s => s.id === isolated.id).useIndependentData, false);
    assert.equal((cfg.pendingDataDeletions || []).includes(shared.id), false);
    const mandatory = await run(`(async () => {
      const result = await window.hub.addSite({ name: 'Mandatory cleanup', url: 'https://cleanup.example.test', useIndependentData: true });
      sites = await window.hub.listSites();
      openDeleteModal(result.site);
      return result.site;
    })()`);
    assert.equal(await run('chkDelData.checked && chkDelData.disabled'), true);
    assert.equal(await run('btnDelConfirm.textContent'), '删除并清理数据');
    const privateSession = electron.session.fromPartition('persist:site-' + mandatory.id);
    const sharedSession = electron.session.fromPartition('persist:shared-sites');
    await privateSession.cookies.set({ url: mandatory.url, name: 'login', value: 'private' });
    await sharedSession.cookies.set({ url: mandatory.url, name: 'login', value: 'shared' });
    // Even callers supplying false cannot bypass mandatory independent cleanup.
    const removedPrivate = await run(`window.hub.removeSite(${JSON.stringify(mandatory.id)}, false)`);
    assert.equal(removedPrivate.ok, true);
    assert.equal((await privateSession.cookies.get({})).length, 0);
    assert.equal((await sharedSession.cookies.get({ url: mandatory.url })).find(cookie => cookie.domain === 'cleanup.example.test').value, 'shared');
    const saved = JSON.parse(fs.readFileSync(path.join(testRoot, 'config.json'), 'utf8'));
    assert.equal(saved.pendingDataDeletions.includes(mandatory.id), true);
    await run(`closeDeleteModal(); openDeleteModal(sites.find(s => s.id === ${JSON.stringify(isolated.id)}))`);
    assert.equal(await run('chkDelData.checked'), false);
    assert.equal(await run('chkDelData.disabled'), false);
    // Shared deletion without opting in must preserve its website's cookies.
    const retained = await run(`(async () => {
      const result = await window.hub.addSite({ name: 'Keep shared data', url: 'https://cleanup.example.test' });
      return window.hub.removeSite(result.site.id, false);
    })()`);
    assert.equal(retained.ok, true);
    assert.equal((await sharedSession.cookies.get({ url: mandatory.url })).find(cookie => cookie.domain === 'cleanup.example.test').value, 'shared');
    console.log('PASS: independent cleanup mandatory in UI and IPC; shared cleanup remains optional');
    console.log('PASS: real add/edit/delete UI + IPC, saved modes, deletion failure and retry');
    console.log('UI screenshots:', path.join(testRoot, 'add-site.png'), path.join(testRoot, 'delete-shared.png'));
  } finally { win.destroy(); }
};
