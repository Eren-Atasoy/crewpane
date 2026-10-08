'use strict';

/**
 * Team Scope Authorization IPC Handler (Faz 3.5 — Sıra 11)
 * Channels:
 *   - teamScope:authorize
 */
function registerTeamScopeIpc({
  ipcMain,
  authorizeTeamScopeInteractive,
  logLine = () => {},
}) {
  ipcMain.handle('teamScope:authorize', async (_event, req) => {
    const p = req && typeof req === 'object' ? req : {};
    const action = p.action === 'manage' ? 'manage' : 'delegate';
    const leaderId = typeof p.leaderId === 'string' ? p.leaderId.trim() : '';
    const targetScope = typeof p.targetScope === 'string' ? p.targetScope.trim() : '';
    if (!leaderId || !targetScope) return { ok: false, code: 'bad-request', reason: 'leaderId + targetScope gerekli' };
    try {
      const d = await authorizeTeamScopeInteractive({ action, leaderId, targetScope });
      return { ok: d.ok === true, via: d.via || null, code: d.code || null, reason: d.reason || null };
    } catch (err) {
      logLine(`teamScope:authorize hata: ${String((err && err.message) || err)}`);
      return { ok: false, code: 'gate-error', reason: String((err && err.message) || err) };
    }
  });
}

module.exports = { registerTeamScopeIpc };
