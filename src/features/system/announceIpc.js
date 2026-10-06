'use strict';

/**
 * Announcement IPC Handlers (Faz 3.5 — Sıra 1)
 * Channels: announce:get, announce:checkNow, announce:markRead, announce:hide,
 *           announce:openAction, announce:openLink
 */
function registerAnnounceIpc({
  ipcMain,
  shell,
  announcements,
  agentSettings,
  announceStateForRenderer,
  runAnnounceCheck,
  pushAnnounceState,
  announceHiddenThisSession,
  getAnnounceState,
  logLine = () => {},
}) {
  ipcMain.handle('announce:get', () => announceStateForRenderer());
  ipcMain.handle('announce:checkNow', () => runAnnounceCheck('manual'));
  ipcMain.handle('announce:markRead', (_event, id) => {
    const key = announcements.cleanId(id);
    if (key) {
      const s = agentSettings.readSettings();
      const read = s.announcementsRead && typeof s.announcementsRead === 'object' ? s.announcementsRead : {};
      const next = { ...read, [key]: Date.now() };
      const keys = Object.keys(next);
      const MAX_READ = announcements.MAX_ITEMS * 4;
      if (keys.length > MAX_READ) {
        for (const k of keys.sort((a, b) => next[a] - next[b]).slice(0, keys.length - MAX_READ)) delete next[k];
      }
      agentSettings.writeSettings({ announcementsRead: next });
    }
    pushAnnounceState();
    return announceStateForRenderer();
  });
  ipcMain.handle('announce:hide', (_event, id) => {
    const key = announcements.cleanId(id);
    if (key) announceHiddenThisSession.add(key);
    pushAnnounceState();
    return announceStateForRenderer();
  });
  ipcMain.handle('announce:openAction', (_event, id) => {
    const key = announcements.cleanId(id);
    const announceState = getAnnounceState();
    const item = announceState.items.find((a) => a.id === key);
    if (!item || !item.action || !announcements.isSafeActionUrl(item.action.url)) {
      return { ok: false, reason: 'no-action' };
    }
    shell.openExternal(item.action.url);
    logLine(`announce: aksiyon açıldı (${key}) → ${item.action.url}`);
    return { ok: true, url: item.action.url };
  });
  ipcMain.handle('announce:openLink', (_event, id, url) => {
    const key = announcements.cleanId(id);
    const announceState = getAnnounceState();
    const item = announceState.items.find((a) => a.id === key);
    const target = typeof url === 'string' ? url.trim() : '';
    const bodies = [item ? item.body : '', ...Object.values((item && item.i18n) || {}).map((t) => t.body || '')];
    if (!item || !announcements.isSafeActionUrl(target) || !bodies.some((b) => b.includes(target))) {
      logLine(`announce: link REDDEDİLDİ (${key}) → ${String(url).slice(0, 120)}`);
      return { ok: false, reason: 'not-in-body' };
    }
    shell.openExternal(target);
    logLine(`announce: gövde linki açıldı (${key}) → ${target}`);
    return { ok: true, url: target };
  });
}

module.exports = { registerAnnounceIpc };
