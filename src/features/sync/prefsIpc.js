'use strict';

/**
 * Preferences Sync IPC Handlers (Faz 3.5 — Sıra 11)
 * Channels:
 *   - prefs:publish
 *   - prefs:pull
 *   - prefs:status
 */
function registerPrefsIpc({
  ipcMain,
  prefsProjector,
  prefsWhitelist,
  logLine = () => {},
}) {
  ipcMain.handle('prefs:publish', (_e, input) => {
    const p = prefsProjector();
    if (!p) return { ok: false, reason: 'no-account' };
    const map = input && typeof input === 'object' && !Array.isArray(input.values) ? input.values : null;
    if (!map || typeof map !== 'object') return { ok: false, reason: 'bad-input' };
    try {
      return p.publishRenderer(map);
    } catch (err) {
      logLine(`[prefs] renderer yayını hatası: ${err.message}`);
      return { ok: false, reason: 'error' };
    }
  });

  ipcMain.handle('prefs:pull', () => {
    const p = prefsProjector();
    const rendererKeys = (prefsWhitelist && prefsWhitelist.RENDERER_KEYS) || [];
    if (!p) return { ok: false, reason: 'no-account', values: {}, keys: rendererKeys };
    try {
      return { ok: true, values: p.rendererValues(), keys: rendererKeys, status: p.status() };
    } catch (err) {
      logLine(`[prefs] renderer çekimi hatası: ${err.message}`);
      return { ok: false, reason: 'error', values: {}, keys: rendererKeys };
    }
  });

  ipcMain.handle('prefs:status', () => {
    const p = prefsProjector();
    if (!p) return { ok: false, reason: 'no-account' };
    try {
      return { ok: true, ...p.status() };
    } catch {
      return { ok: false, reason: 'error' };
    }
  });
}

module.exports = { registerPrefsIpc };
