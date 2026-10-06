'use strict';

/**
 * Mobile Gateway & Access IPC Handlers (Faz 3.5 — Sıra 6)
 * Channels:
 *   - on mobile:query:result, mobile:event, mobile:command:result
 *   - handle mobile:status, mobile:enable, mobile:disable, mobile:pair, mobile:probe, mobile:revoke, mobile:scope
 */
function registerMobileIpc({
  ipcMain,
  mobilePending,
  mobileCommandPending,
  emitMobileEvent = () => {},
  getMobileGateway = () => null,
  mobileDeviceStore,
  mobilePlanDenial = () => null,
  startMobile = async () => null,
  getMobileGatewayLastFailure = () => null,
  mobileStartFailure = () => ({ reason: 'unknown', error: 'başlatılamadı' }),
  mobileKillSwitch = () => ({ ok: true }),
  mobileProbe,
}) {
  // ── Renderer Response Listeners ────────────────────────────────────────────
  ipcMain.on('mobile:query:result', (_e, res) => {
    if (!res || typeof res.requestId !== 'string' || !mobilePending) return;
    const entry = mobilePending.get(res.requestId);
    if (!entry) return;
    mobilePending.delete(res.requestId);
    clearTimeout(entry.timer);
    entry.resolve(res.data ?? {});
  });

  ipcMain.on('mobile:event', (_e, event) => {
    if (event && typeof event.type === 'string') emitMobileEvent(event);
  });

  ipcMain.on('mobile:command:result', (_e, res) => {
    if (!res || typeof res.requestId !== 'string' || !mobileCommandPending) return;
    const entry = mobileCommandPending.get(res.requestId);
    if (!entry) return;
    mobileCommandPending.delete(res.requestId);
    clearTimeout(entry.timer);
    entry.resolve(res.result ?? { ok: false, error: 'boş cevap' });
  });

  // ── Mobile Management Handlers ─────────────────────────────────────────────
  ipcMain.handle('mobile:status', () => {
    const gw = getMobileGateway();
    return {
      running: !!gw,
      ...(gw ? gw.info() : { enabled: mobileDeviceStore ? mobileDeviceStore.loadState().enabled : false }),
    };
  });

  ipcMain.handle('mobile:enable', async () => {
    const planGate = mobilePlanDenial();
    if (planGate) {
      return { ok: false, reason: 'plan_limit', error: planGate.message, denial: planGate };
    }
    const state = mobileDeviceStore.loadState();
    state.enabled = true;
    mobileDeviceStore.saveState(state);
    const gw = await startMobile();
    if (gw) return { ok: true, ...gw.info() };
    const failure = getMobileGatewayLastFailure() || mobileStartFailure(null);
    return { ok: false, reason: failure.reason, error: failure.error };
  });

  ipcMain.handle('mobile:disable', () => mobileKillSwitch());

  ipcMain.handle('mobile:pair', () => {
    const gw = getMobileGateway();
    return gw ? gw.createPairing() : { error: 'gateway kapalı' };
  });

  ipcMain.handle('mobile:probe', async () => {
    const tailnet = mobileProbe.probeTailnet();
    let peers = { available: false };
    try {
      peers = await mobileProbe.probePeers();
    } catch {
      /* ipucu ölçümü kilit üretmez */
    }
    const gw = getMobileGateway();
    return {
      tailnet: { ...tailnet, dnsName: peers.dnsName ?? null },
      gateway: {
        running: !!gw,
        ...(gw ? gw.info() : { enabled: mobileDeviceStore ? mobileDeviceStore.loadState().enabled : false }),
      },
      peers,
    };
  });

  ipcMain.handle('mobile:revoke', (_e, deviceId) => {
    const gw = getMobileGateway();
    return { ok: !!(gw && gw.revokeDevice(String(deviceId || ''))) };
  });

  ipcMain.handle('mobile:scope', (_e, deviceId, scope) => {
    const gw = getMobileGateway();
    return {
      ok: !!(gw && gw.setDeviceScope(String(deviceId || ''), String(scope || 'read'))),
    };
  });
}

module.exports = { registerMobileIpc };
