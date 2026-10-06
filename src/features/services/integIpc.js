'use strict';

/**
 * Integration Center IPC Handlers (Faz 3.5 — Sıra 3)
 * Channels: integ:list, integ:add, integ:mcpStats, integ:autostart, integ:remove, integ:test
 */
function registerIntegIpc({
  ipcMain,
  supervisorFor,
  integrations,
  planDenial,
  ptys,
  mcpProcess,
  crewpaneHome,
  integrationAutostart,
  telemetryProvisioning,
  logLine = () => {},
}) {
  function livePaneIntegrationRows() {
    const rows = [];
    try {
      for (const e of ptys.values()) {
        const info = e && e.integrations;
        if (!info) continue;
        rows.push({
          agentId: e.agentId || null,
          label: e.label || null,
          engine: e.command || null,
          services: Array.isArray(info.services) ? info.services : [],
          gated: Array.isArray(info.gated) ? info.gated : [],
          lazy: info.lazy === true,
        });
      }
    } catch {
      return [];
    }
    return rows;
  }

  ipcMain.handle('integ:list', () =>
    supervisorFor('integrations').runAsync(
      'list',
      () => integrations().ipc.list(),
      { ok: false, reason: 'error', available: false, records: [], catalog: [] },
    ));

  ipcMain.handle('integ:add', (_event, input) =>
    supervisorFor('integrations').runAsync(
      'add',
      async () => {
        const listed = await integrations().ipc.list();
        const current = Array.isArray(listed.records) ? listed.records.length : 0;
        const denial = planDenial('integrations', current);
        if (denial) {
          return {
            ok: false,
            reason: 'plan_limit',
            error: denial.message,
            title: denial.title,
            limit: denial.limit,
            current: denial.current,
            tier: denial.tier,
            requiredTier: denial.requiredTier,
            action: 'upgrade',
          };
        }
        return integrations().ipc.add(input);
      },
      { ok: false, reason: 'error', error: 'anahtar kaydedilemedi' },
    ));

  ipcMain.handle('integ:mcpStats', () =>
    supervisorFor('integrations').runAsync(
      'mcpStats',
      async () => ({ ok: true, ...mcpProcess.summarizeByService(), panes: livePaneIntegrationRows() }),
      { ok: false, measured: false, services: {}, paneCount: 0, totalMb: 0, panes: [] },
    ));

  ipcMain.handle('integ:autostart', (_event, payload) =>
    supervisorFor('integrations').runAsync(
      'autostart',
      async () => {
        const home = crewpaneHome();
        const input = payload && typeof payload === 'object' ? payload : {};
        const reply = (ok, hint) => ({
          ok,
          map: integrationAutostart.read(home),
          profile: integrationAutostart.readProfile(home),
          ...(hint ? { restartHint: true } : null),
        });
        if (input.op === 'set' && input.scope && typeof input.scope === 'object') {
          const { kind, id } = input.scope;
          const value = input.enabled === null ? null : input.enabled !== false;
          const ok = integrationAutostart.setScoped(home, kind, id, input.service, value);
          if (ok) logLine(`integrations autostart ${kind}:${id} ${input.service}=${value} (baglanti korunuyor)`);
          return reply(ok, true);
        }
        if (input.op === 'set') {
          const ok = integrationAutostart.setEnabled(home, input.service, input.enabled !== false);
          if (ok) logLine(`integrations autostart ${input.service}=${input.enabled !== false} (baglanti korunuyor)`);
          return reply(ok, true);
        }
        return reply(true, false);
      },
      { ok: false, map: {}, profile: { services: {}, roles: {}, projects: {} } },
    ));

  ipcMain.handle('integ:remove', (_event, id) =>
    supervisorFor('integrations').runAsync(
      'remove',
      async () => {
        let doomedService = null;
        try {
          const before = await integrations().ipc.list();
          const rec = (before.records || []).find((r) => r.id === id);
          if (rec && (rec.service === 'sentry' || rec.service === 'posthog')) {
            const siblings = (before.records || []).filter((r) => r.service === rec.service);
            if (siblings.length === 1) doomedService = rec.service;
          }
        } catch { /* sayamadıysak silme akışını bloklama */ }

        const res = await integrations().ipc.remove(id);
        if (res && res.ok && res.removed && doomedService) {
          try {
            await telemetryProvisioning().store.clear(doomedService);
            logLine(`telemetry-provision: ${doomedService} kurulumu da temizlendi (jeton kesildi)`);
          } catch (e) {
            logLine(`telemetry-provision: temizlenemedi (${e && e.message})`);
          }
        }
        return res;
      },
      { ok: false, reason: 'error', error: 'bağlantı kesilemedi' },
    ));

  ipcMain.handle('integ:test', (_event, input) =>
    supervisorFor('integrations').runAsync(
      'test',
      () => integrations().ipc.test(input),
      { ok: false, reason: 'error', error: 'test çalıştırılamadı' },
    ));
}

module.exports = { registerIntegIpc };
