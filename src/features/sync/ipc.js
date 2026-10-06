'use strict';

/**
 * Sync IPC Handlers (Faz 3.5 — Sıra 6)
 * Channels:
 *   - sync:status, sync:now, sync:conflicts, sync:restoreLoser, sync:resolveConflict, sync:approveSecret, sync:resumeQueue, sync:refresh
 */
function registerSyncIpc({
  ipcMain,
  getSyncRuntime = () => null,
  getSyncIpcSurface = () => null,
}) {
  ipcMain.handle('sync:status', () => {
    const surface = getSyncIpcSurface();
    return surface ? surface.status() : { enabled: false };
  });

  ipcMain.handle('sync:now', async (_e, input) => {
    const runtime = getSyncRuntime();
    const surface = getSyncIpcSurface();
    const r = runtime ? await runtime.tick(input && input.reconcile === true ? { reconcile: true } : {}) : { ok: false };
    return { ok: r && r.ok !== false, result: r, status: surface ? surface.status() : { enabled: false } };
  });

  ipcMain.handle('sync:conflicts', (_e, input) => {
    const surface = getSyncIpcSurface();
    return surface ? surface.conflicts(input) : [];
  });

  ipcMain.handle('sync:restoreLoser', (_e, input) => {
    const surface = getSyncIpcSurface();
    return surface ? surface.restoreLoser(input) : { ok: false };
  });

  ipcMain.handle('sync:resolveConflict', (_e, input) => {
    const surface = getSyncIpcSurface();
    return surface ? surface.resolveConflict(input) : { ok: false };
  });

  ipcMain.handle('sync:approveSecret', (_e, input) => {
    const surface = getSyncIpcSurface();
    return surface ? surface.approveSecret(input) : { ok: false };
  });

  ipcMain.handle('sync:resumeQueue', () => {
    const surface = getSyncIpcSurface();
    return surface ? surface.resumeQueue() : { ok: false };
  });

  ipcMain.handle('sync:refresh', (_e, input) => {
    const runtime = getSyncRuntime();
    const surface = getSyncIpcSurface();
    if (runtime) runtime.refresh({ tickNow: !!(input && input.tickNow) });
    return surface ? surface.status() : { enabled: false };
  });
}

module.exports = { registerSyncIpc };
