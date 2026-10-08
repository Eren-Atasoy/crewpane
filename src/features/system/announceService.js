'use strict';

const fs = require('node:fs');
const path = require('node:path');
const announcementsDefault = require('../../services/announcements.cjs');

function getAnnounceCachePath(instancePaths) {
  return path.join(instancePaths.instanceHome(), 'announcements-cache.json');
}

function writeAnnounceCache(cachePath, items) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ savedAt: Date.now(), items }), 'utf8');
  } catch {
    /* best-effort disk cache */
  }
}

function readAnnounceCache(cachePath, announcements) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    return announcements.normalizeFeed(raw && raw.items ? raw.items : raw);
  } catch {
    return [];
  }
}

function resolveAnnounceLocale(app, announcements) {
  try {
    return announcements.normalizeLocale(app.getLocale());
  } catch {
    return announcements.BASE_LOCALE;
  }
}

function buildAnnounceRendererState({
  announceState,
  agentSettings,
  announcements,
  app,
  currentChannel,
  announceHiddenThisSession,
}) {
  const s = agentSettings.readSettings();
  const read = s.announcementsRead && typeof s.announcementsRead === 'object' ? s.announcementsRead : {};
  const visible = announcements.selectAnnouncements(announceState.items, {
    app: announcements.APP_ID,
    version: app.getVersion(),
    channel: currentChannel,
    now: Date.now(),
  });
  const locale = resolveAnnounceLocale(app, announcements);
  return {
    checked: announceState.checked,
    fromCache: announceState.fromCache,
    lastCheckedAt: announceState.lastCheckedAt,
    currentVersion: app.getVersion(),
    locale,
    items: visible.map((a) => announcements.localize(a, locale)).map((a) => ({
      ...a,
      read: Object.prototype.hasOwnProperty.call(read, a.id),
      hidden: announceHiddenThisSession.has(a.id),
    })),
  };
}

/**
 * Announcement Core Service (Faz 3.6.15a)
 */
function createAnnounceService(deps = {}) {
  const {
    app,
    BrowserWindow,
    instancePaths,
    agentSettings,
    announcements = announcementsDefault,
    currentUpdateChannel = () => 'stable',
    logLine = () => {},
  } = deps;

  let announceState = {
    checked: false,
    fromCache: false,
    lastCheckedAt: null,
    items: [],
  };

  const announceHiddenThisSession = new Set();
  const cachePath = () => getAnnounceCachePath(instancePaths);

  const getAnnounceState = () => announceState;
  const getAnnounceHiddenThisSession = () => announceHiddenThisSession;

  const announceStateForRenderer = () => buildAnnounceRendererState({
    announceState,
    agentSettings,
    announcements,
    app,
    currentChannel: currentUpdateChannel(),
    announceHiddenThisSession,
  });

  function pushAnnounceState() {
    if (!BrowserWindow) return;
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        if (!w.isDestroyed()) w.webContents.send('announce:state', announceStateForRenderer());
      } catch {
        /* best-effort */
      }
    }
  }

  async function runAnnounceCheck(trigger) {
    const url = process.env.CREWPANE_ANNOUNCE_FEED_URL || announcements.FEED_URL;
    const res = await announcements.fetchFeed({ url });
    if (res.ok) {
      announceState = { checked: true, fromCache: false, lastCheckedAt: Date.now(), items: res.items };
      writeAnnounceCache(cachePath(), res.items);
      logLine(`announce(${trigger}): ${res.items.length} duyuru alındı`);
      pushAnnounceState();
    } else {
      logLine(`announce(${trigger}): sessiz geçildi (${res.reason})`);
    }
    return announceStateForRenderer();
  }

  let announceChecksScheduled = false;

  function scheduleAnnounceChecks() {
    if (announceChecksScheduled) return;
    announceChecksScheduled = true;
    const cached = readAnnounceCache(cachePath(), announcements);
    if (cached.length > 0) {
      announceState = { ...announceState, fromCache: true, items: cached };
      logLine(`announce(cache): ${cached.length} duyuru diskten yüklendi`);
      pushAnnounceState();
    }
    if (instancePaths.instanceId() === 'test' && !process.env.CREWPANE_ANNOUNCE_FEED_URL) return;
    setTimeout(() => { runAnnounceCheck('auto').catch(() => {}); }, 3000);
    const timer = setInterval(() => { runAnnounceCheck('auto').catch(() => {}); }, announcements.CHECK_INTERVAL_MS);
    timer.unref?.();
  }

  return {
    getAnnounceState,
    getAnnounceHiddenThisSession,
    announceHiddenThisSession,
    announceStateForRenderer,
    pushAnnounceState,
    runAnnounceCheck,
    scheduleAnnounceChecks,
  };
}

module.exports = {
  createAnnounceService,
};
