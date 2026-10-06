'use strict';

/**
 * Resource Governor IPC Handlers (Faz 3.5 — Sıra 2)
 * Channels: resource:state, resource:allowAnyway, resource:configure,
 *           resource:finishedPanes, resource:closeFinished
 */
function registerResourceIpc({
  ipcMain,
  resourceGovernor,
  agentSettings,
  ptys,
  agentRunner,
  resourceGovernorModule,
  killPaneExplicitAndCleanup,
  logLine = () => {},
}) {
  ipcMain.handle('resource:state', () => ({ ok: true, state: resourceGovernor().state() }));

  ipcMain.handle('resource:allowAnyway', (_event, ms) => {
    const r = resourceGovernor().allowAnyway(Number(ms));
    return { ok: true, ...r, state: resourceGovernor().state() };
  });

  ipcMain.handle('resource:configure', (_event, patch) => {
    const clean = agentSettings.sanitizeResourceGovernor({
      ...(agentSettings.readSettings().resourceGovernor || {}),
      ...(patch && typeof patch === 'object' ? patch : {}),
    });
    try {
      agentSettings.writeSettings({ resourceGovernor: clean });
    } catch (err) {
      logLine(`resourceGovernor ayarı yazılamadı: ${err.message} — bellekte uygulanıyor`);
    }
    return { ok: true, state: resourceGovernor().configure(clean) };
  });

  ipcMain.handle('resource:finishedPanes', (_event, opts) => {
    const now = Date.now();
    const department = opts && typeof opts.department === 'string' ? opts.department : null;
    const idleMs = Number.isFinite(opts && opts.idleMs) ? Number(opts.idleMs) : undefined;
    const rows = [];
    for (const [paneId, e] of ptys) {
      rows.push({
        paneId,
        agentId: e.agentId ?? null,
        teamId: e.department ?? null,
        label: e.label ?? null,
        status: agentRunner.statusFor(e.lastDataAt, now),
        lastOutputAt: e.lastDataAt || e.startedAt || 0,
      });
    }
    const finished = resourceGovernorModule.finishedPanes(rows, { now, idleMs, teamId: department });
    return { ok: true, panes: finished, livePanes: ptys.size };
  });

  ipcMain.handle('resource:closeFinished', (_event, opts) => {
    const ids = Array.isArray(opts && opts.paneIds) ? opts.paneIds.filter((v) => typeof v === 'string') : [];
    const now = Date.now();
    const closed = [];
    const skipped = [];
    for (const paneId of ids) {
      const e = ptys.get(paneId);
      if (!e) { skipped.push({ paneId, why: 'pane yok' }); continue; }
      const row = {
        paneId,
        teamId: e.department ?? null,
        status: agentRunner.statusFor(e.lastDataAt, now),
        lastOutputAt: e.lastDataAt || e.startedAt || 0,
      };
      if (resourceGovernorModule.finishedPanes([row], { now }).length === 0) {
        skipped.push({ paneId, why: 'artık bitmiş değil (canlandı)' });
        continue;
      }
      try {
        if (killPaneExplicitAndCleanup(paneId)) closed.push(paneId);
        else skipped.push({ paneId, why: 'kapatılamadı' });
      } catch (err) {
        skipped.push({ paneId, why: err.message });
      }
    }
    logLine(`resourceGovernor: onaylı kapatma — kapandı=${closed.length} atlandı=${skipped.length}`);
    return { ok: true, closed, skipped, state: resourceGovernor().state() };
  });
}

module.exports = { registerResourceIpc };
