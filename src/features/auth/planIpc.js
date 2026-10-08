'use strict';

/**
 * Plan Limits, Api Key Verification & AppDb Token IPC Handlers (Faz 3.5 — Sıra 11)
 * Channels:
 *   - appkey:verify
 *   - plan:get
 *   - plan:recheck
 *   - appdb:token
 */
function registerPlanIpc({
  ipcMain,
  verifyAppApiKey = async () => ({ ok: false }),
  planLimits,
  getSeatGate,
  getPtys = () => new Map(),
  workspaceOnboarding,
  crewpaneIdConfig,
  logLine = () => {},
  appDbTokenFor,
}) {
  ipcMain.handle('appkey:verify', async (_event, service) => verifyAppApiKey(String(service || '')));

  ipcMain.handle('plan:get', () => {
    const seatGate = getSeatGate();
    const ptys = typeof getPtys === 'function' ? getPtys() : getPtys;
    return {
      ok: true,
      ...planLimits.describe(seatGate ? seatGate.state() : null, {
        agents: ptys ? ptys.size : 0,
        workspaces: (() => {
          try { return workspaceOnboarding.knownWorkspaces().length; } catch { return 0; }
        })(),
        devices: (() => {
          const s = seatGate ? seatGate.state() : null;
          return (s && s.device && Number(s.device.registered_active || s.device.active)) || 0;
        })(),
        devicesConcurrent: (() => {
          const s = seatGate ? seatGate.state() : null;
          return (s && s.device && Number(s.device.concurrent_active)) || 0;
        })(),
      }),
      billingUrl: crewpaneIdConfig(process.env).billingUrl,
    };
  });

  ipcMain.handle('plan:recheck', async (_event, input) => {
    const seatGate = getSeatGate();
    const feature = typeof (input && input.feature) === 'string' ? input.feature : '';
    const asked = Number(input && input.current);
    const current = Number.isFinite(asked) ? asked : 0;
    let refreshed = false;
    let reason = null;
    if (seatGate) {
      try {
        const res = await seatGate.refreshLicense();
        refreshed = !!(res && res.ok);
        reason = (res && res.reason) || null;
      } catch (e) {
        reason = 'refresh_failed';
        logLine(`plan:recheck — jeton tazelenemedi (${e.message}) — eldeki jetonla ölçülür`);
      }
    }
    const snapshot = seatGate ? seatGate.state() : null;
    const decision = planLimits.decide({ snapshot, feature, current });
    const summary = planLimits.describe(snapshot);
    const allowed = decision.allowed !== false;
    logLine(`plan:recheck ${feature || '-'}(${current}) → tazelendi=${refreshed}${reason ? ` (${reason})` : ''} katman=${summary.tier} izin=${allowed}`);
    return {
      ok: true,
      refreshed,
      reason,
      feature,
      allowed,
      tier: summary.tier,
      tierLabel: summary.tierLabel,
      requiredTierLabel: allowed ? null : (decision.requiredTierLabel || null),
    };
  });

  ipcMain.handle('appdb:token', () => appDbTokenFor('appdb:token'));
}

module.exports = { registerPlanIpc };
