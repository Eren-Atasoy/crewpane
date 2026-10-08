'use strict';

/**
 * Agent X Delivery, Receipts, and Beam Overlay IPC Handlers (Faz 3.5 — Sıra 8)
 * Channels:
 *   - agentx:deliver
 *   - agentx:resolve
 *   - agentx:probe
 *   - agentx:receipts
 *   - agentx:retry
 *   - agentx:cancel
 *   - agentx:beam:measured (on)
 *   - agentx:beam:source
 *   - agentx:beam:show
 *   - agentx:beam:clear
 */
function registerAgentxIpc({
  ipcMain,
  BrowserWindow,
  screen,
  agentxDeliverer,
  agentxBeamMod,
  getAppWindow = () => null,
  jarvisWidgetAlive = () => null,
  logLine = () => {},
}) {
  // ── AXP-03 — Agent X teslim + makbuz IPC'leri ───────────────────────────────
  // `agentx:deliver` AXP-02'nin `draft:confirmed` olayını tüketir: {from, target, text,
  // digest?, revision?, ctx:{aliases, departments, activeDepartment}}. Roster renderer'ın
  // gerçeğidir (jarvis:think ile aynı `context` şekli); pane listesi main'in.
  ipcMain.handle('agentx:deliver', async (_event, req) => {
    try {
      return await agentxDeliverer.deliverConfirmed(req);
    } catch (err) {
      logLine(`agentx:deliver error: ${err && err.message}`);
      return { ok: false, kind: 'error', reason: String((err && err.message) || err) };
    }
  });

  /** HEDEF SORUSU için teslimsiz çözüm (AXP-02 widget'ı "Kime göndereyim?" öncesi sorar). */
  ipcMain.handle('agentx:resolve', (_event, req) => {
    const r = req && typeof req === 'object' ? req : {};
    return agentxDeliverer.resolve(r.target || {}, r.ctx || {});
  });

  /** AXP-14 — ışık kapısı: uçuştan ÖNCE hedef yoklanır (tek bayt yazılmaz, makbuz üretilmez). */
  ipcMain.handle('agentx:probe', async (_event, req) => {
    const r = req && typeof req === 'object' ? req : {};
    try {
      return await agentxDeliverer.probe(r.target || {}, r.ctx || {});
    } catch (err) {
      logLine(`agentx:probe error: ${err && err.message}`);
      return { resolved: { kind: 'unknown', reason: 'no-target', said: null, suggestions: [] }, pane: null, state: 'none' };
    }
  });

  /** "Son işlemler" — oturum içi makbuz defteri (en yeni önde). */
  ipcMain.handle('agentx:receipts', () => agentxDeliverer.list());
  ipcMain.handle('agentx:retry', (_event, id) => agentxDeliverer.retry(String(id || '')));
  ipcMain.handle('agentx:cancel', (_event, id) => agentxDeliverer.cancel(String(id || '')));

  // ── AXP-04 — IŞIK: kaynak ölçümü (pop-out kipleri) + masaüstü katmanı ──────────
  // Renderer overlay'i ana pencere CSS px'inde çizer; Agent X pop-out'taysa kaynak o
  // pencerenin GERÇEK ekran konumudur (`agentxBeam.source` → `beamSource` dört kip).
  // Pop-out renderer'ı gösterge dikdörtgenini `agentx:beam:measured` ile geri verir.
  const beamMeasureWaiters = new Map();
  ipcMain.on('agentx:beam:measured', (_event, p) => {
    const w = p && beamMeasureWaiters.get(p.measurementId);
    if (w) {
      beamMeasureWaiters.delete(p.measurementId);
      w(p.rect || null);
    }
  });

  const agentxBeam = agentxBeamMod.createAgentxBeam({
    BrowserWindow,
    screen,
    getHost: () => {
      const appWin = getAppWindow();
      return appWin && !appWin.isDestroyed() ? appWin : null;
    },
    getPopout: () => jarvisWidgetAlive(),
    measurePopout: (win, measurementId) =>
      new Promise((resolve) => {
        beamMeasureWaiters.set(measurementId, resolve);
        try {
          win.webContents.send('agentx:beam:measure', { measurementId });
        } catch {
          beamMeasureWaiters.delete(measurementId);
          resolve(null);
        }
      }),
    log: logLine,
  });

  ipcMain.handle('agentx:beam:source', (_event, p) => agentxBeam.source(p && typeof p === 'object' ? p : {}));
  ipcMain.handle('agentx:beam:show', (_event, seg) => agentxBeam.show(seg));
  ipcMain.handle('agentx:beam:clear', () => {
    agentxBeam.clear();
    return { ok: true };
  });
}

module.exports = { registerAgentxIpc };
