'use strict';

const fs = require('fs');
const path = require('path');

const SHARED_PARTITION = 'persist:shared-sites';

function partitionForSite(site) {
  return site.useIndependentData === true ? 'persist:site-' + site.id : SHARED_PARTITION;
}

function siteURL(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('请输入有效的 HTTP(S) 网址');
  return url;
}

// Only entries read from an existing config need this migration. New entries default to shared.
function migrateSiteData(config) {
  let changed = false;
  for (const site of config.sites) {
    if (typeof site.useIndependentData !== 'boolean') {
      site.useIndependentData = true;
      changed = true;
    }
  }
  return changed;
}

function cookieAppliesToHost(cookie, host) {
  const domain = cookie.domain.replace(/^\./, '').toLowerCase();
  return host === domain || (!cookie.hostOnly && host.endsWith('.' + domain));
}

async function clearSiteData(ses, site, remainingSites) {
  if (site.useIndependentData === true) {
    await ses.clearData();
    return;
  }

  // Parse every URL before deleting anything; invalid input must never become an unfiltered clear.
  const target = siteURL(site.url);
  const others = remainingSites
    .filter((other) => other.id !== site.id && partitionForSite(other) === SHARED_PARTITION)
    .map((other) => siteURL(other.url));

  // Two entries for the same origin own the very same data. Keep it until the last entry is removed.
  if (others.some((other) => other.origin === target.origin)) return;

  await ses.clearData({
    origins: [target.origin],
    originMatchingMode: 'origin-in-all-contexts',
    dataTypes: ['backgroundFetch', 'fileSystems', 'indexedDB', 'localStorage', 'serviceWorkers', 'webSQL'],
  });
  // Do not clear the session-wide HTTP/shader/dictionary caches in shared mode.
  await ses.clearStorageData({ origin: target.origin, storages: ['cachestorage'] });

  const cookies = await ses.cookies.get({});
  for (const cookie of cookies) {
    const domain = cookie.domain.replace(/^\./, '').toLowerCase();
    // Preserve parent-domain / third-party login cookies, and cookies used by another entry.
    if (domain !== target.hostname || others.some((other) => cookieAppliesToHost(cookie, other.hostname))) continue;

    // Expire the exact (name, domain, path) cookie. cookies.remove(url, name) can also
    // remove same-name parent-domain cookies, affecting sibling websites.
    const details = {
      url: `${cookie.secure ? 'https:' : 'http:'}//${target.host}${cookie.path || '/'}`,
      name: cookie.name,
      value: '',
      path: cookie.path || '/',
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      expirationDate: 1,
    };
    if (!cookie.hostOnly) details.domain = cookie.domain;
    await ses.cookies.set(details);
  }
  await ses.cookies.flushStore();
}

// Only explicitly requested independent-partition deletions are retried at startup.
// An absent sidebar entry is not permission to delete its retained data.
function cleanupPendingPartitions(config, userData, log = () => {}) {
  const pending = config.pendingDataDeletions;
  if (!Array.isArray(pending) || !pending.length) return false;
  const base = path.resolve(userData, 'Partitions');
  config.pendingDataDeletions = pending.filter((id) => {
    if (typeof id !== 'string' || !/^[a-z0-9_-]+$/i.test(id)) return false;
    if (config.sites.some((site) => site.id === id)) return true;
    const target = path.resolve(base, 'site-' + id);
    if (path.dirname(target) !== base) return false;
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return false;
    } catch (error) {
      log('清理待删除分区失败:', id, error.message);
      return true;
    }
  });
  return true;
}

module.exports = { SHARED_PARTITION, partitionForSite, siteURL, migrateSiteData, clearSiteData, cleanupPendingPartitions };
