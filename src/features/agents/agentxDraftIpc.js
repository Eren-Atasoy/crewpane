'use strict';

/**
 * Agent X Draft State Machine IPC Handlers (Faz 3.5 — Sıra 8)
 * Channels:
 *   - agentxDraft:get
 *   - agentxDraft:open
 *   - agentxDraft:hear
 *   - agentxDraft:edit
 *   - agentxDraft:setTarget
 *   - agentxDraft:pause
 *   - agentxDraft:noSpeech
 *   - agentxDraft:finish
 *   - agentxDraft:spoken
 *   - agentxDraft:resolve
 *   - agentxDraft:cancel
 *   - agentxDraft:undo
 *   - agentxDraft:tick
 */
function registerAgentxDraftIpc({
  ipcMain,
  agentxDraft,
  broadcastAgentxDraft = () => {},
  broadcastAgentxDraftConfirmed = () => {},
}) {
  // ── AXP-02 — AGENT X İŞ TASLAĞI (durum makinesi main'de, paneDraft deseni) ──
  // Widget (ana pencere) ses/klavye girdisini buraya YAZAR; ana pencere + pop-out
  // ayna + pane pop-out'ları `agentxDraft:changed` ile AYNI fotoğrafı okur. Karar
  // (ekle / duraksa / teyit / gönder) defterde verilir; renderer yalnız konuşur ve
  // çizer. "evet" → `agentxDraft:confirmed` (AXP-03 teslimi bunu tüketir).
  ipcMain.handle('agentxDraft:get', () => agentxDraft.getDraft());

  const draftOp = (fn) => (_event, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    let res;
    try {
      res = fn(p);
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), snapshot: agentxDraft.getDraft() };
    }
    if (res && res.changed) broadcastAgentxDraft(res.snapshot);
    if (res && res.outcome && res.outcome.kind === 'confirmed') broadcastAgentxDraftConfirmed(res.outcome.confirmed);
    return res;
  };

  ipcMain.handle('agentxDraft:open', draftOp((p) => agentxDraft.openDraft(p.route, { at: p.at })));
  ipcMain.handle('agentxDraft:hear', draftOp((p) => agentxDraft.hear(p.text, { at: p.at, startedAt: p.startedAt, control: p.control, addressTokens: p.addressTokens })));
  ipcMain.handle('agentxDraft:edit', draftOp((p) => agentxDraft.editText(p.text)));
  ipcMain.handle('agentxDraft:setTarget', draftOp((p) => agentxDraft.setTarget(p.target)));
  ipcMain.handle('agentxDraft:pause', draftOp((p) => agentxDraft.pause(p.at)));
  ipcMain.handle('agentxDraft:noSpeech', draftOp((p) => agentxDraft.noSpeech(p.at)));
  ipcMain.handle('agentxDraft:finish', draftOp((p) => agentxDraft.finish(p.at)));
  ipcMain.handle('agentxDraft:spoken', draftOp((p) => agentxDraft.markSpoken(p.id, p.at)));
  ipcMain.handle('agentxDraft:resolve', draftOp((p) => agentxDraft.resolve(p.id, p.choice, p.at)));
  ipcMain.handle('agentxDraft:cancel', draftOp((p) => agentxDraft.cancel(p.at)));
  ipcMain.handle('agentxDraft:undo', draftOp((p) => agentxDraft.undoCancel(p.at)));
  ipcMain.handle('agentxDraft:tick', draftOp((p) => agentxDraft.tick(p.at)));
}

module.exports = { registerAgentxDraftIpc };
