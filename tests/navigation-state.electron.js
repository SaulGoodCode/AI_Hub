'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { app, BrowserWindow, WebContentsView } = require('electron');
const { captureNavigationState, restoreNavigationState } = require('../navigation-state');

const fixtureHtml = `<!doctype html>
<meta charset="utf-8">
<title>navigation-state-fixture</title>
<input id="draft" value="">
<script>window.loadedState = history.state;</script>`;

function makeView(parent) {
  const view = new WebContentsView({ webPreferences: { contextIsolation: true } });
  parent.contentView.addChildView(view);
  return view;
}

app.whenReady().then(async () => {
  let source;
  let restored;
  let parent;
  let server;
  try {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fixtureHtml);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const fixture = `http://127.0.0.1:${server.address().port}/`;

    parent = new BrowserWindow({ show: false });
    source = makeView(parent);
    await source.webContents.loadURL(fixture);
    await source.webContents.executeJavaScript(`
      history.replaceState({ __translateSession__: {
        sourceLanguageCode: 'detect', targetLanguageCode: 'it', sourceText: 'draft'
      } }, '');
      document.getElementById('draft').value = 'draft';
    `);
    // Chromium 会在同页导航提交后更新 NavigationEntry.pageState。
    await new Promise((resolve) => setTimeout(resolve, 100));

    const snapshot = captureNavigationState(source.webContents);
    assert.ok(snapshot);
    assert.equal(snapshot.entries.length, 1);
    parent.contentView.removeChildView(source);
    source.webContents.close();
    source = null;

    restored = makeView(parent);
    assert.equal(await restoreNavigationState(restored.webContents, snapshot, fixture), true);
    const state = await restored.webContents.executeJavaScript('history.state');
    assert.equal(state.__translateSession__.targetLanguageCode, 'it');
    assert.equal(state.__translateSession__.sourceText, 'draft');

    const fallback = makeView(parent);
    assert.equal(await restoreNavigationState(fallback.webContents, null, fixture), false);
    assert.equal(await fallback.webContents.executeJavaScript('document.title'), 'navigation-state-fixture');
    parent.contentView.removeChildView(fallback);
    fallback.webContents.close();

    console.log('PASS: destroyed WebContents restores history.state through NavigationHistory');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (source && !source.webContents.isDestroyed()) source.webContents.close();
    if (restored && !restored.webContents.isDestroyed()) restored.webContents.close();
    if (parent && !parent.isDestroyed()) parent.destroy();
    if (server) await new Promise((resolve) => server.close(resolve));
    app.exit(process.exitCode || 0);
  }
});
