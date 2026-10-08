'use strict';

const { shell: defaultShell } = require('electron');

/**
 * Diagnostics & Fault Reporting IPC Handlers (Faz 3.5 — Sıra 11)
 * Channels:
 *   - module:faults
 *   - module:reportRenderer
 *   - module:openLog
 */
function registerDiagnosticsIpc({
  ipcMain,
  getModuleFaults = () => [],
  reportModuleFault,
  getLogPath = () => '',
  shell = defaultShell,
}) {
  const STAGES = new Set([
    'initial', 'reinit', 'recreate-canvas', 'reload-renderer', 'recreate-window', 'static',
  ]);
  const RENDERERS = new Set(['webgl', 'canvas', 'none']);

  ipcMain.handle('module:faults', () => ({ ok: true, faults: getModuleFaults().slice(-20) }));

  ipcMain.handle('module:reportRenderer', (_event, payload) => {
    const f = payload && typeof payload === 'object' ? payload : {};
    const clip = (v, n) => (v == null ? '' : String(v).slice(0, n));
    const level = f.level === 'warning' || f.level === 'info' ? f.level : 'error';
    const stage = STAGES.has(f.stage) ? f.stage : null;
    const renderer = RENDERERS.has(f.renderer) ? f.renderer : null;
    const attempt = Number.isFinite(f.attempt) ? Math.max(0, Math.min(99, Math.trunc(f.attempt))) : null;
    reportModuleFault({
      module: 'renderer',
      label: clip(f.label, 60) || 'ui',
      message: clip(f.message, 400) || 'bilinmeyen hata',
      location: clip(f.location, 200) || null,
      stopped: !!f.stopped,
      level,
      at: Date.now(),
      ...(stage ? { stage } : {}),
      ...(renderer ? { renderer } : {}),
      ...(attempt != null ? { attempt } : {}),
    }, { stack: clip(f.stack, 4000) || undefined });
    return { ok: true };
  });

  ipcMain.handle('module:openLog', async () => {
    const logPath = typeof getLogPath === 'function' ? getLogPath() : getLogPath;
    try {
      await shell.openPath(logPath);
      return { ok: true, path: logPath };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
}

module.exports = { registerDiagnosticsIpc };
