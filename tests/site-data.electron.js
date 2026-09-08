'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, session, BrowserWindow } = require('electron');
const { partitionForSite, migrateSiteData, clearSiteData, cleanupPendingPartitions } = require('../site-data');

// Set isolation before app readiness or any Session access. Never use actual user data.
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-test-storage-'));
app.setPath('userData', testRoot);
app.setPath('sessionData', testRoot);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const timeout = setTimeout(() => { console.error('Storage tests timed out'); app.exit(1); }, 60000);
const hooked = new Set();
function sessionFor(site) {
  const ses = session.fromPartition(partitionForSite(site));
  if (!hooked.has(ses)) {
    // All test pages are local fixtures; no external website or account is contacted.
    ses.protocol.handle('https', () => new Response('<!doctype html><title>Storage fixture</title>'));
    hooked.add(ses);
  }
  return ses;
}
async function page(ses, url, script) {
  const win = new BrowserWindow({ show: false, webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false } });
  try {
    await win.loadURL(url);
    return await win.webContents.executeJavaScript(script);
  } finally { win.destroy(); }
}
const writeData = `(async () => {
  localStorage.setItem('marker', 'keep-me');
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('fixture', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('items');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction('items', 'readwrite');
    tx.objectStore('items').put('keep-me', 'marker');
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  await (await caches.open('fixture')).put('/cached', new Response('keep-me'));
})()`;
const readData = `(async () => ({
  local: localStorage.getItem('marker'),
  databases: (await indexedDB.databases()).map(db => db.name),
  caches: await caches.keys(),
}))()`;
const fullData = { local: 'keep-me', databases: ['fixture'], caches: ['fixture'] };
const emptyData = { local: null, databases: [], caches: [] };

app.whenReady().then(async () => {
  const a = { id: 'a', url: 'https://a.example.test/chat', useIndependentData: false };
  const a2 = { id: 'a2', url: 'https://a.example.test/other', useIndependentData: false };
  const b = { id: 'b', url: 'https://b.example.test/', useIndependentData: false };
  const independent = { id: 'private', url: a.url, useIndependentData: true };
  const shared = sessionFor(a);
  const isolated = sessionFor(independent);
  assert.equal(shared, sessionFor(a2));
  assert.equal(shared, sessionFor(b));
  assert.notEqual(shared, isolated);
  assert.equal(partitionForSite({ id: 'new' }), partitionForSite(a));

  const legacy = { sites: [{ id: 'old' }, { id: 'shared', useIndependentData: false }] };
  assert.equal(migrateSiteData(legacy), true);
  assert.equal(legacy.sites[0].useIndependentData, true);
  assert.equal(legacy.sites[1].useIndependentData, false);
  assert.equal(migrateSiteData(legacy), false);
  console.log('PASS: shared default, independent partition, legacy migration');

  await page(shared, a.url, writeData);
  await page(shared, b.url, writeData);
  assert.deepEqual(await page(shared, a2.url, readData), fullData);
  assert.deepEqual(await page(isolated, a.url, readData), emptyData);
  await page(isolated, a.url, writeData);
  console.log('PASS: shared entries reuse storage; independent entry isolates same URL');

  for (const details of [
    { url: a.url, name: 'login', value: 'a', path: '/' },
    { url: a.url, name: 'login', value: 'a-path', path: '/chat' },
    { url: b.url, name: 'login', value: 'b', path: '/' },
    { url: a.url, name: 'login', value: 'parent', domain: '.example.test', path: '/' },
    { url: 'https://accounts.other.test', name: 'login', value: 'oauth', path: '/' },
    { url: a.url, name: '__Host-secure', value: 'a-secure', path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction' },
  ]) await shared.cookies.set(details);
  const cookiesBefore = await shared.cookies.get({});
  await clearSiteData(shared, a, [a2, b]);
  assert.deepEqual(await page(shared, a.url, readData), fullData);
  assert.deepEqual(await shared.cookies.get({}), cookiesBefore);
  console.log('PASS: removing duplicate origin preserves data still used by another entry');

  await clearSiteData(shared, a, [b]);
  assert.deepEqual(await page(shared, a.url, readData), emptyData);
  assert.deepEqual(await page(shared, b.url, readData), fullData);
  assert.deepEqual(await page(isolated, a.url, readData), fullData);
  const cookiesAfter = await shared.cookies.get({});
  assert.equal(cookiesAfter.some(c => c.domain === 'a.example.test'), false);
  assert.equal(cookiesAfter.find(c => c.domain === 'b.example.test').value, 'b');
  assert.equal(cookiesAfter.find(c => c.domain === '.example.test').value, 'parent');
  assert.equal(cookiesAfter.find(c => c.domain === 'accounts.other.test').value, 'oauth');
  console.log('PASS: targeted storage/cookie removal preserves sibling, parent login, OAuth and isolated data');

  await shared.cookies.set({ url: a.url, name: 'nested', value: 'shared-child', domain: '.a.example.test', path: '/' });
  await clearSiteData(shared, a, [{ id: 'child', url: 'https://child.a.example.test/' }, b]);
  assert.equal((await shared.cookies.get({ name: 'nested' }))[0].value, 'shared-child');
  await shared.cookies.set({ url: a.url, name: 'port', value: 'shared-port', path: '/' });
  await clearSiteData(shared, a, [{ id: 'port', url: 'https://a.example.test:8443/' }, b]);
  assert.equal((await shared.cookies.get({ name: 'port' }))[0].value, 'shared-port');
  await assert.rejects(clearSiteData(shared, { id: 'bad', url: 'https://' }, []));
  assert.deepEqual(await page(shared, b.url, readData), fullData);
  console.log('PASS: shared subdomain/port cookies protected; invalid URL cannot trigger global deletion');

  await clearSiteData(isolated, independent, [a, b]);
  assert.deepEqual(await page(isolated, a.url, readData), emptyData);
  assert.deepEqual(await page(shared, b.url, readData), fullData);
  console.log('PASS: independent deletion clears only its own partition');

  const cleanupRoot = path.join(testRoot, 'cleanup-fixture');
  for (const dir of ['site-retained', 'site-delete', 'site-active', 'shared-sites']) {
    fs.mkdirSync(path.join(cleanupRoot, 'Partitions', dir), { recursive: true });
    fs.writeFileSync(path.join(cleanupRoot, 'Partitions', dir, 'marker'), 'keep-me');
  }
  const cleanupConfig = { sites: [{ id: 'active', useIndependentData: true }], pendingDataDeletions: ['delete', 'active', '../../outside'] };
  cleanupPendingPartitions(cleanupConfig, cleanupRoot);
  assert.equal(fs.existsSync(path.join(cleanupRoot, 'Partitions/site-delete')), false);
  for (const dir of ['site-retained', 'site-active', 'shared-sites']) {
    assert.equal(fs.readFileSync(path.join(cleanupRoot, 'Partitions', dir, 'marker'), 'utf8'), 'keep-me');
  }
  assert.deepEqual(cleanupConfig.pendingDataDeletions, ['active']);
  console.log('PASS: startup cleanup removes only explicitly queued, unused independent partitions');
  await require('./site-data-ui')(testRoot);
  await require('./popup-window')(testRoot);
  clearTimeout(timeout);
  console.log('All storage regression tests passed. Isolated test data:', testRoot);
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
