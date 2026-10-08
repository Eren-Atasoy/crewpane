'use strict';

const fs = require('node:fs');
const path = require('node:path');
const changelogFeedDefault = require('../../services/changelogFeed.cjs');

function getChangelogCachePath(instancePaths) {
  return path.join(instancePaths.instanceHome(), 'changelog-cache.json');
}

function writeChangelogCache(cachePath, state) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ savedAt: Date.now(), ...state }), 'utf8');
  } catch {
    /* best-effort disk cache */
  }
}

function readChangelogCache(cachePath, changelogFeed) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    return changelogFeed.normalizeFeed({
      entries: raw.items,
      recentCount: raw.recentCount,
      recentWindowDays: raw.recentWindowDays,
    });
  } catch {
    return { items: [], recentCount: null, recentWindowDays: null };
  }
}

/**
 * Changelog Core Service (Faz 3.6.15b)
 */
function createChangelogService(deps = {}) {
  const {
    BrowserWindow,
    instancePaths,
    changelogFeed = changelogFeedDefault,
    logLine = () => {},
  } = deps;

  let changelogState = {
    checked: false,
    fromCache: false,
    lastCheckedAt: null,
    recentCount: null,
    recentWindowDays: null,
    items: [],
  };

  const cachePath = () => getChangelogCachePath(instancePaths);
  const getChangelogState = () => changelogState;
  const changelogStateForRenderer = () => ({ ...changelogState });

  function pushChangelogState() {
    if (!BrowserWindow) return;
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        if (!w.isDestroyed()) w.webContents.send('changelog:state', changelogStateForRenderer());
      } catch {
        /* best-effort */
      }
    }
  }

  async function runChangelogCheck(trigger) {
    const url = process.env.CREWPANE_CHANGELOG_FEED_URL || changelogFeed.FEED_URL;
    const res = await changelogFeed.fetchFeed({ url });
    if (res.ok) {
      changelogState = {
        checked: true,
        fromCache: false,
        lastCheckedAt: Date.now(),
        recentCount: res.recentCount,
        recentWindowDays: res.recentWindowDays,
        items: res.items,
      };
      writeChangelogCache(cachePath(), changelogState);
      logLine(`changelog(${trigger}): ${res.items.length} kayıt alındı`);
      pushChangelogState();
    } else {
      logLine(`changelog(${trigger}): sessiz geçildi (${res.reason})`);
    }
    return changelogStateForRenderer();
  }

  let changelogChecksScheduled = false;

  function scheduleChangelogChecks() {
    if (changelogChecksScheduled) return;
    changelogChecksScheduled = true;
    const cached = readChangelogCache(cachePath(), changelogFeed);
    if (cached.items && cached.items.length) {
      changelogState = { ...changelogState, fromCache: true, ...cached };
      logLine(`changelog(cache): ${cached.items.length} kayıt diskten yüklendi`);
      pushChangelogState();
    }
    if (instancePaths.instanceId() === 'test' && !process.env.CREWPANE_CHANGELOG_FEED_URL) return;
    setTimeout(() => { runChangelogCheck('auto').catch(() => {}); }, 3000);
    const timer = setInterval(() => { runChangelogCheck('auto').catch(() => {}); }, changelogFeed.CHECK_INTERVAL_MS);
    timer.unref?.();
  }

  return {
    getChangelogState,
    changelogStateForRenderer,
    pushChangelogState,
    runChangelogCheck,
    scheduleChangelogChecks,
  };
}

module.exports = {
  createChangelogService,
};
