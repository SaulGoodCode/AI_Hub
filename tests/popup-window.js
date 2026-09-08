'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { BrowserWindow, session, shell } = require('electron');
const { installPopupHandler } = require('../popup-window');

async function until(check) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > 5000) throw new Error('Popup test timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

module.exports = async function testPopups(testRoot) {
  const ses = session.fromPartition('popup-tests');
  const requests = [];
  ses.protocol.handle('https', async (request) => {
    requests.push({ url: request.url, method: request.method, body: request.method === 'POST' ? await request.text() : '' });
    if (request.url.endsWith('/redirect')) return Response.redirect('https://popup.fixture.test/final?from=redirect');
    return new Response('<!doctype html><title>测试页面 · AI Hub</title><h1>Popup fixture</h1>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  });
  const opener = new BrowserWindow({ show: false, webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false } });
  const created = [];
  const openedURLs = [];
  const originalOpen = shell.openExternal;
  shell.openExternal = async url => { openedURLs.push(url); };
  try {
    installPopupHandler(opener.webContents, {
      session: ses, preload: path.join(__dirname, '../site-preload.js'), parent: opener,
      show: false, onCreated: popup => created.push(popup),
    });
    await opener.loadURL('https://popup.fixture.test/opener');
    await opener.webContents.executeJavaScript(`window.messages = []; window.addEventListener('message', e => messages.push(e.data)); window.child = window.open('https://popup.fixture.test/start'); void 0;`);
    await until(() => created.length === 1);
    const popup = created[0];
    const pageView = popup.contentView.children[0];
    const page = pageView.webContents;
    await until(() => page.getURL().endsWith('/start') && !page.isLoading() && !popup.webContents.isLoading());
    assert.equal(page.session, ses);
    assert.equal(await page.executeJavaScript('typeof window.popup'), 'undefined');
    assert.equal(await page.executeJavaScript('window.opener !== null'), true);
    await page.executeJavaScript(`window.opener.postMessage('oauth-result', '*')`);
    await until(async () => (await opener.webContents.executeJavaScript('messages')).includes('oauth-result'));
    assert.equal(pageView.getBounds().y, 40);
    popup.setSize(640, 760);
    await until(() => pageView.getBounds().width === popup.getContentSize()[0]);
    assert.equal(pageView.getBounds().height, popup.getContentSize()[1] - 40);
    console.log('PASS: popup preserves opener, session, postMessage and resizes below titlebar');

    await page.loadURL('https://popup.fixture.test/redirect');
    await until(async () => (await popup.webContents.executeJavaScript('window.popup.getState()')).url.includes('/final?'));
    await until(async () => (await popup.webContents.executeJavaScript(`document.getElementById('popup-title').textContent`)) === '测试页面 · AI Hub');
    await popup.webContents.executeJavaScript(`document.getElementById('open-browser').click()`);
    await until(() => openedURLs.length === 1);
    assert.equal(openedURLs[0], 'https://popup.fixture.test/final?from=redirect');
    await page.executeJavaScript(`history.replaceState({}, '', '/final?from=redirect#section')`);
    await popup.webContents.executeJavaScript(`window.popup.openExternal()`);
    assert.equal(openedURLs[1], 'https://popup.fixture.test/final?from=redirect#section');
    assert.equal(popup.isDestroyed(), false);
    await popup.webContents.insertCSS(':root { color-scheme: light; }');
    await new Promise(resolve => setTimeout(resolve, 200));
    fs.writeFileSync(path.join(testRoot, 'popup-titlebar.png'), (await popup.webContents.capturePage({ x: 0, y: 0, width: 640, height: 40 }, { stayHidden: true, stayAwake: true })).toPNG());

    shell.openExternal = async () => { throw new Error('TEST browser unavailable'); };
    const failure = await popup.webContents.executeJavaScript('window.popup.openExternal()');
    assert.equal(failure.ok, false);
    await page.loadURL('about:blank');
    const blocked = await popup.webContents.executeJavaScript('window.popup.openExternal()');
    assert.equal(blocked.ok, false);
    console.log('PASS: titlebar button opens current redirected/hash URL; failures and non-web URLs handled');

    await page.loadURL('https://popup.fixture.test/start');
    await page.executeJavaScript(`window.open('https://popup.fixture.test/nested'); void 0;`);
    await until(() => created.length === 2);
    const nested = created[1];
    await until(() => !nested.webContents.isLoading());
    assert.equal(nested.getParentWindow(), popup);
    await nested.webContents.executeJavaScript(`document.getElementById('close-popup').click()`);
    await until(() => nested.isDestroyed());
    await page.executeJavaScript('window.close()').catch(() => {});
    await until(() => popup.isDestroyed());
    console.log('PASS: nested link popup, titlebar close and OAuth window.close');

    await opener.webContents.executeJavaScript(`
      const form = document.createElement('form'); form.method = 'POST'; form.target = '_blank';
      form.action = 'https://popup.fixture.test/post';
      const input = document.createElement('input'); input.name = 'state'; input.value = 'fixture';
      form.append(input); document.body.append(form); form.submit();
    `);
    await until(() => requests.some(request => request.url.endsWith('/post')));
    assert.equal(requests.find(request => request.url.endsWith('/post')).method, 'POST');
    assert.equal(requests.find(request => request.url.endsWith('/post')).body, 'state=fixture');
    console.log('PASS: target=_blank POST submissions preserved');
  } finally {
    shell.openExternal = originalOpen;
    for (const popup of created) if (!popup.isDestroyed()) popup.destroy();
    opener.destroy();
  }
};
