'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Design IPC Handlers (Faz 3.5 — Sıra 2)
 * Channels: design:openWindow, design:closeWindow, design:isWindowOpen,
 *           design:listAgents, design:ensureTaskDir
 */
function registerDesignIpc({
  ipcMain,
  openDesignWindow,
  closeDesignWindow,
  designWindowAlive,
  listPanes,
  resolveInRoots,
  withinActiveRoots,
  displayPath,
  logLine = () => {},
}) {
  ipcMain.handle('design:openWindow', () => {
    try {
      return openDesignWindow();
    } catch (err) {
      logLine(`design:openWindow error: ${err.message}`);
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('design:closeWindow', () => {
    try {
      return closeDesignWindow();
    } catch (err) {
      logLine(`design:closeWindow error: ${err.message}`);
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('design:isWindowOpen', () => ({ open: !!designWindowAlive() }));

  ipcMain.handle('design:listAgents', () => {
    try {
      const panes = listPanes(null).filter((p) => p.agentId);
      return { ok: true, panes };
    } catch (err) {
      logLine(`design:listAgents error: ${err.message}`);
      return { ok: false, error: String(err.message || err), panes: [] };
    }
  });

  ipcMain.handle('design:ensureTaskDir', (_event, rel) => {
    try {
      if (typeof rel !== 'string' || !rel.trim()) return { ok: false, reason: 'bad-request' };
      const clean = rel.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (!clean || clean.split('/').some((seg) => seg === '..' || seg === '.' || !seg)) {
        return { ok: false, reason: 'path-denied' };
      }
      // `docs/design/<görev>` ya da `<proje>/docs/design/<görev>` — başka hiçbir şekil.
      if (!/(^|\/)docs\/design\/[^/]+$/.test(clean)) return { ok: false, reason: 'not-design-root' };
      const abs = resolveInRoots(clean);
      if (!abs) return { ok: false, reason: 'path-denied' };
      const parent = path.dirname(abs);
      const realParent = fs.existsSync(parent) ? fs.realpathSync(parent) : parent;
      if (!withinActiveRoots(realParent)) return { ok: false, reason: 'path-denied' };
      const existed = fs.existsSync(abs);
      fs.mkdirSync(abs, { recursive: true });
      logLine(`design:ensureTaskDir ${displayPath(abs)} (${existed ? 'zaten vardı' : 'oluşturuldu'})`);
      return { ok: true, created: !existed, path: displayPath(abs) };
    } catch (err) {
      logLine(`design:ensureTaskDir error: ${err.message}`);
      return { ok: false, reason: 'mkdir-failed', detail: String(err.message || err) };
    }
  });
}

module.exports = { registerDesignIpc };
