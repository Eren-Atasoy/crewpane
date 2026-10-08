'use strict';

const COMPOSE_NOTIFY_RETRY_MS = 3000;
const COMPOSE_NOTIFY_BUDGET_MS = 120_000;

/**
 * Team Compose IPC Handlers (Faz 3.5 — Sıra 11)
 * Channels:
 *   - team-compose:decision
 *   - team-compose:autonomy
 *   - team-compose:undo-request
 */
function registerTeamComposeIpc({
  ipcMain,
  ensureComposeLedger,
  teamComposeCore = null,
  getComposeTransport,
  teamComposeRequest,
  composeFail,
  composeAutonomy,
  ptys,
  sampleLeaderGate,
  deliverToPane,
  dispatchSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logLine = () => {},
}) {
  const getTeamComposeCore = () => teamComposeCore || require('../../agents/teamCompose.cjs');

  function notifyLeaderCompose(leaderId, text) {
    const id = String(leaderId || '');
    if (!id) return;
    const findPane = () => {
      if (!ptys) return null;
      for (const [paneId, e] of ptys) if (e.agentId === id && e.disallowSubagent !== true) return paneId;
      return null;
    };
    (async () => {
      const deadline = Date.now() + COMPOSE_NOTIFY_BUDGET_MS;
      let tries = 0;
      while (Date.now() < deadline) {
        const paneId = findPane();
        if (!paneId) {
          logLine(`team compose: lider ${id} pane'i yok — kurulum notu teslim EDİLMEDİ (şerit patronun önünde)`);
          return;
        }
        tries += 1;
        const gate = await sampleLeaderGate(paneId);
        if (gate.safe) {
          const res = await deliverToPane(paneId, text, { label: `ekip-kurucu ${id}` });
          logLine(`team compose: lider ${id} pane=${paneId} kurulum notu ${res.delivered ? 'TESLİM EDİLDİ' : 'yazıldı, teslim DOĞRULANAMADI'} (deneme ${tries})`);
          return;
        }
        await dispatchSleep(COMPOSE_NOTIFY_RETRY_MS);
      }
      logLine(`team compose: lider ${id} ${tries} denemede hep meşguldü — kurulum notu teslim EDİLMEDİ`);
    })().catch((err) => logLine(`team compose: lider notu hata (${String((err && err.message) || err)})`));
  }

  ipcMain.handle('team-compose:decision', async (_e, req) => {
    const core = getTeamComposeCore();
    const ledger = ensureComposeLedger();
    const proposalId = String((req && req.proposalId) || '');
    const decision = String((req && req.decision) || '');
    if (decision === 'approve' && Array.isArray(req && req.rows)) {
      const allowed = Array.isArray(req.catalogSlugs) ? req.catalogSlugs : [];
      if (allowed.length) {
        const { rows } = core.sanitizeRows(req.rows, allowed);
        const cap = core.capDecision({
          rows,
          mode: (req && req.mode) || 'team',
          sessionInstalls: ledger.sessionInstalls(),
        });
        if (!cap.ok) return { ok: false, code: cap.code, error: cap.error || cap.reason };
        req = { ...req, rows };
      } else {
        req = { ...req, rows: undefined };
      }
    }
    const res = ledger.decide(proposalId, {
      decision,
      teamName: req && req.teamName,
      rows: req && req.rows,
    });
    if (!res.ok) return { ok: false, code: res.code, error: res.reason };
    if (res.rejected) return { ok: true, rejected: true };
    const transport = getComposeTransport();
    if (!transport) {
      return { ok: false, code: 'no-transport', error: 'Kurulum şu an yapılamıyor — ekip lideri bağlı değil.' };
    }
    const p = res.proposal;
    let applied;
    try {
      applied = await teamComposeRequest(
        {
          action: 'apply',
          proposalId,
          approvalToken: res.approvalToken,
          leaderId: p.leaderId,
          department: p.department,
          source: 'user-click',
        },
        transport,
      );
    } catch (err) {
      applied = composeFail(500, 'main', String((err && err.message) || err));
    }
    if (applied.status !== 200 || !applied.body || !applied.body.ok) {
      const error = (applied.body && applied.body.error) || 'ekip kurulamadı.';
      logLine(`team compose: onay tıklandı ama apply DÜŞTÜ (${applied.status}/${applied.body && applied.body.code}) — ${error}`);
      notifyLeaderCompose(
        p.leaderId,
        `❌ [EKİP KURUCU] Patron "${p.teamName || 'ekip'}" önerisini onayladı ama kurulum BAŞARISIZ: ${error} ` +
          '"ekibi kurdum" DEME; patron kartta hatayı görüyor, yeniden deneyebilir.',
      );
      return { ok: false, code: (applied.body && applied.body.code) || 'apply', error };
    }
    const body = applied.body;
    notifyLeaderCompose(
      p.leaderId,
      `✅ [EKİP KURUCU] Patron onay kartında "Ekibe ekle"ye bastı. ${core.composeReceiptText(body)}`,
    );
    return { ok: true, applied: true, proposalId, receipt: body.receipt || null, wingSlug: body.wingSlug || null };
  });

  ipcMain.handle('team-compose:autonomy', () => ({ ok: true, autonomy: composeAutonomy() }));

  ipcMain.handle('team-compose:undo-request', async (_e, req) => {
    const proposalId = String((req && req.proposalId) || '').trim();
    if (!proposalId) return { ok: false, code: 'bad-request', error: 'Geri alınacak kurulum belirtilmedi.' };
    const transport = getComposeTransport();
    if (!transport) {
      return { ok: false, code: 'no-transport', error: 'Geri alma şu an yapılamıyor.' };
    }
    try {
      const res = await teamComposeRequest({ action: 'undo', proposalId }, transport);
      if (res.status === 200) return { ok: true, ...res.body };
      return { ok: false, code: res.body && res.body.code, error: res.body && res.body.error };
    } catch (err) {
      return { ok: false, code: 'main', error: String((err && err.message) || err) };
    }
  });
}

module.exports = { registerTeamComposeIpc };
