'use strict';

/**
 * src/features/agents/jevIpc.js
 *
 * Jev AI IPC Kanalları
 * - jev:route-task (Görev zorluk ve model seçimi)
 * - jev:decision-log (Öneri ve karar geçmişi)
 */

const jevRouter = require('../../agents/jevRouter.cjs');

const DECISION_LOG_CAP = 50;
const _decisionLogs = [];

function recordDecisionLog(entry) {
  _decisionLogs.unshift(entry);
  if (_decisionLogs.length > DECISION_LOG_CAP) {
    _decisionLogs.length = DECISION_LOG_CAP;
  }
}

function getDecisionLogs(limit = 20) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), DECISION_LOG_CAP);
  return _decisionLogs.slice(0, n);
}

function clearDecisionLogs() {
  _decisionLogs.length = 0;
}

async function resolveCandidateEngines(engineAuth, explicit) {
  if (Array.isArray(explicit)) return explicit;
  if (!engineAuth || typeof engineAuth.readAllStatus !== 'function') return [];
  const statusRes = await engineAuth.readAllStatus();
  return (statusRes.engines || []).map((e) => ({
    id: e.id,
    installed: e.installed === true,
    loggedIn: e.loggedIn === true,
    authKind: e.authKind || null,
  }));
}

async function handleRouteTask(params, deps) {
  const { agentSettings, engineAuth, outcomeLedger } = deps;
  const settings = agentSettings ? agentSettings.readSettings() : {};
  const jevConfig = settings.jev || { mode: 'suggest', policy: 'balanced' };
  if (jevConfig.mode === 'off' && params.force !== true) {
    return { ok: true, mode: 'off', skipped: true };
  }

  const engines = await resolveCandidateEngines(engineAuth, params.engines);
  const history = outcomeLedger && typeof outcomeLedger.summary === 'function'
    ? outcomeLedger.summary()
    : null;

  const decision = jevRouter.decide({
    task: params.task || {},
    engines,
    policy: params.policy || jevConfig.policy || 'balanced',
    history,
    classifier: params.classifier,
  });

  const logEntry = {
    id: `jev-dec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
    task: params.task,
    decision,
    policy: params.policy || jevConfig.policy,
    overriddenBy: null,
  };
  recordDecisionLog(logEntry);

  return {
    ok: true,
    mode: jevConfig.mode,
    decision,
    logId: logEntry.id,
  };
}

function registerJevIpc(deps = {}) {
  const { ipcMain, logLine } = deps;
  if (!ipcMain) return;

  ipcMain.handle('jev:route-task', async (_event, params = {}) => {
    try {
      return await handleRouteTask(params, deps);
    } catch (err) {
      logLine?.(`[jev:route-task] error: ${err.message}`);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('jev:decision-log', (_event, params = {}) => {
    return {
      ok: true,
      logs: getDecisionLogs(params?.limit),
    };
  });
}

module.exports = {
  registerJevIpc,
  recordDecisionLog,
  getDecisionLogs,
  clearDecisionLogs,
};
