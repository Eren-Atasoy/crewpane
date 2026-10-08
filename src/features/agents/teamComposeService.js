'use strict';

const teamComposeCoreDefault = require('../../agents/teamCompose.cjs');
const teamScopeDefault = require('../../agents/teamScope.cjs');
const modelDetectDefault = require('../../agents/modelDetect.cjs');
const engineOfferingDefault = require('../../agents/engineOffering.cjs');
const engineRegistryDefault = require('../../agents/engineRegistry.cjs');
const planLimitsDefault = require('../../config/planLimits.cjs');

const COMPOSE_NOTIFY_RETRY_MS = 3000;
const COMPOSE_NOTIFY_BUDGET_MS = 120_000;

function composeFail(status, code, error, extra = {}) {
  return { status, body: { ok: false, code, error, ...extra } };
}

function checkPlanNote({ seatGate, ptys, planLimits, seatCount }) {
  try {
    const snapshot = seatGate ? seatGate.state() : null;
    const wanted = (ptys ? ptys.size : 0) + Math.max(0, Number(seatCount) || 0);
    const decision = planLimits.decide({ snapshot, feature: 'agents', current: wanted });
    return decision.allowed ? null : decision.message || null;
  } catch {
    return null;
  }
}

async function handleComposePropose({
  req, ledger, callRenderer, autonomy, engineOffering, engineRegistry,
  teamComposeCore, modelDetect, composePlanNote, getAppWindow, logLine,
}) {
  const mode = teamComposeCore.normalizeMode(req.mode);
  let engineLabel = '';
  if (mode === 'engine') {
    const engineId = String(req.engine || '').trim().toLowerCase();
    if (!engineId || !engineOffering.isOffered(engineId)) {
      return composeFail(422, 'empty', engineId ? `"${engineId}" bu üründe sunulan bir motor değil.` : 'engine alanı zorunlu.', {
        reason: 'no-such-engine',
        howTo: 'engine alanına ürünün sunduğu bir motor id\'si yaz: claude, codex, copilot, goose, gemini, qwen, opencode, cursor, kimi, crush, antigravity.',
      });
    }
    const d = engineRegistry.getEngine(engineId);
    engineLabel = (d && d.label) || engineId;
  }
  let built;
  try {
    built = await callRenderer('team-compose:propose', {
      objective: req.objective,
      roles: Array.isArray(req.roles) ? req.roles : [],
      mode,
      teamName: req.teamName || '',
      department: req.department,
      leaderId: req.leaderId,
      maxEmployees: ledger.caps.maxEmployees,
      rejectedRoles: ledger.rejectedRoles(),
      engine: req.engine || '',
      engineLabel,
      agents: Array.isArray(req.agents) ? req.agents : [],
    });
  } catch (err) {
    return composeFail(504, 'renderer-timeout', String((err && err.message) || err));
  }
  if (!built || !built.ok) {
    return composeFail(502, 'renderer', (built && built.error) || 'öneri üretilemedi.');
  }
  const allowed = Array.isArray(built.catalogSlugs) ? built.catalogSlugs : [];
  const { rows, dropped } = teamComposeCore.sanitizeRows(built.rows, allowed);
  if (dropped.length) logLine(`team compose: katalog dışı ${dropped.length} satır düştü (${dropped.join(',')})`);
  for (const r of rows) {
    const catalogLabel = r.modelLabel && r.modelLabel !== r.model ? r.modelLabel : '';
    r.modelLabel = teamComposeCore.composeModelLabel(
      r.engine,
      r.model,
      catalogLabel || modelDetect.labelForModelId(r.model) || '',
    );
  }
  const cap = teamComposeCore.capDecision({
    rows,
    mode,
    sessionInstalls: ledger.sessionInstalls(),
    dropped: built.dropped && typeof built.dropped === 'object' ? built.dropped : null,
    allowedSlugs: allowed,
  });
  if (!cap.ok) {
    if (cap.code === 'empty') {
      logLine(`team compose: öneri üretilmedi reason=${cap.reason} existing=${(cap.existing || []).join(',')} unmatched=${(cap.unmatched || []).join(',')}`);
      return composeFail(422, cap.code, cap.error || cap.reason, {
        cap: cap.cap, reason: cap.reason, howTo: cap.howTo,
        existing: cap.existing, unmatched: cap.unmatched, rejected: cap.rejected,
        unknownAgents: cap.unknownAgents, nearest: cap.nearest,
      });
    }
    return composeFail(429, cap.code, cap.reason, { cap: cap.cap });
  }
  const planNote = mode === 'engine' ? null : composePlanNote(rows.length);
  const proposal = ledger.putProposal({
    leaderId: req.leaderId,
    department: req.department,
    mode,
    objective: req.objective,
    teamName: built.teamName || req.teamName || '',
    rows,
    targetTeamId: built.targetTeamId || null,
    planNote,
    source: req.source,
    autonomy,
    engine: mode === 'engine' ? String(req.engine || '').toLowerCase() : '',
    engineLabel: mode === 'engine' ? engineLabel : '',
  });
  try {
    const win = getAppWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('team-compose:proposal', {
        proposalId: proposal.proposalId,
        mode: proposal.mode,
        objective: proposal.objective,
        teamName: proposal.teamName,
        rows: proposal.rows,
        expiresAt: new Date(proposal.expiresAtMs).toISOString(),
        planNote: proposal.planNote,
        source: proposal.source,
        autonomy: proposal.autonomy,
        engine: proposal.engine,
        engineLabel: proposal.engineLabel,
      });
    }
  } catch (err) {
    logLine(`team compose: kart gönderilemedi (${err.message})`);
  }
  return {
    status: 200,
    body: {
      ok: true,
      proposalId: proposal.proposalId,
      mode: proposal.mode,
      engine: proposal.engine,
      engineLabel: proposal.engineLabel,
      status: proposal.approval ? 'approved' : 'awaiting-approval',
      ...(proposal.approval ? { approvalToken: proposal.approval.token } : {}),
      teamName: proposal.teamName,
      rows: proposal.rows,
      planNote: proposal.planNote,
      expiresAt: new Date(proposal.expiresAtMs).toISOString(),
    },
  };
}

async function handleAwaitingOrUnknown(taken, req, ledger, getAppWindow) {
  if (taken.code === 'unknown') {
    const done = ledger.peekUndo(req.proposalId);
    if (done) {
      const given = String(req.approvalToken || '').trim();
      if (given && done.approvalToken && given !== done.approvalToken) {
        return composeFail(409, 'bad-token', 'Onay jetonu geçersiz.');
      }
      return {
        status: 200,
        body: {
          ok: true,
          alreadyApplied: true,
          proposalId: done.proposalId,
          teamId: done.teamId,
          teamName: done.teamName,
          wingSlug: done.wingSlug,
          employees: done.employeeIds.length,
          names: done.names,
          receipt: done.receipt,
          receiptText: teamComposeCoreDefault.composeReceiptText({
            teamName: done.teamName,
            receipt: done.receipt,
            alreadyApplied: true,
            mode: done.mode,
            engine: done.engine,
            engineLabel: done.engineLabel,
            engineChanges: done.engineChanges,
          }),
          unresolvedRoles: [],
          renamed: [],
          undoExpiresAt: new Date(done.expiresAtMs).toISOString(),
        },
      };
    }
  }
  if (taken.code === 'awaiting-approval' && taken.proposal) {
    try {
      const win = getAppWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('team-compose:proposal', {
          proposalId: taken.proposal.proposalId,
          mode: taken.proposal.mode,
          objective: taken.proposal.objective,
          teamName: taken.proposal.teamName,
          rows: taken.proposal.rows,
          expiresAt: new Date(taken.proposal.expiresAtMs).toISOString(),
          planNote: taken.proposal.planNote,
          source: taken.proposal.source,
          autonomy: taken.proposal.autonomy,
          engine: taken.proposal.engine,
          engineLabel: taken.proposal.engineLabel,
        });
      }
    } catch {
      /* kartı yeniden göstermek best-effort */
    }
  }
  return composeFail(taken.code === 'unknown' ? 410 : 409, taken.code, taken.reason);
}

async function applyEngineProposal(p, req, ledger, callRenderer, ptys, getAppWindow, logLine) {
  const rows = (Array.isArray(p.rows) ? p.rows : []).filter((r) => r && r.employeeId);
  if (!rows.length) {
    ledger.releaseApproval(p.proposalId);
    return composeFail(502, 'renderer', 'motoru değiştirilecek kimse yok.');
  }
  let applied;
  try {
    applied = await callRenderer(
      'team-compose:apply',
      { proposalId: p.proposalId, mode: 'engine', engine: p.engine, teamName: p.teamName, rows, targetTeamId: p.targetTeamId },
      60_000,
    );
  } catch (err) {
    ledger.releaseApproval(p.proposalId);
    return composeFail(504, 'renderer-timeout', String((err && err.message) || err));
  }
  const changes = applied && Array.isArray(applied.engineChanges) ? applied.engineChanges : [];
  if (!applied || !applied.ok || !changes.length) {
    if (!changes.length) ledger.releaseApproval(p.proposalId);
    return composeFail(502, 'renderer', (applied && applied.error) || 'motor değiştirilemedi.');
  }
  for (const c of changes) {
    let open = false;
    if (ptys) {
      for (const [, e] of ptys) if (e.agentId === c.agentId && e.disallowSubagent !== true) { open = true; break; }
    }
    c.paneOpen = open;
  }
  const entry = ledger.recordApplied(p.proposalId, {
    teamId: p.targetTeamId || null,
    createdTeam: false,
    employeeIds: changes.map((c) => c.employeeId),
    names: changes.map((c) => c.name),
    wingSlug: applied.wingSlug || null,
    teamName: p.teamName,
    leaderId: p.leaderId,
    scopeGrant: null,
    receipt: null,
    engineChanges: changes,
    mode: 'engine',
  });
  try {
    const win = getAppWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('team-compose:applied', {
        proposalId: entry.proposalId,
        mode: 'engine',
        engine: p.engine,
        engineLabel: p.engineLabel,
        teamName: entry.teamName,
        names: entry.names,
        wingSlug: entry.wingSlug,
        undoExpiresAt: new Date(entry.expiresAtMs).toISOString(),
      });
    }
  } catch {
    /* şerit best-effort */
  }
  logLine(`team compose APPLY (engine) → ${p.engine} for ${changes.map((c) => `${c.agentId}${c.paneOpen ? '(pane açık)' : ''}`).join(',')} leader=${req.leaderId}`);
  const body = {
    ok: true,
    mode: 'engine',
    engine: p.engine,
    engineLabel: p.engineLabel,
    proposalId: entry.proposalId,
    teamId: entry.teamId,
    teamName: entry.teamName,
    wingSlug: entry.wingSlug,
    employees: changes.length,
    names: entry.names,
    engineChanges: changes,
    receipt: null,
    unresolvedRoles: [],
    renamed: [],
    undoExpiresAt: new Date(entry.expiresAtMs).toISOString(),
  };
  body.receiptText = teamComposeCoreDefault.composeReceiptText(body);
  return { status: 200, body };
}

function resolveScopeGrant({ applied, p, req, callerScopeFor, teamScope, agentSettings, logLine }) {
  const appliedWing = teamScope.normalizeScope(applied.wingSlug || '');
  const leaderOwnScope = teamScope.normalizeScope(callerScopeFor(req.leaderId, req.department));
  const autoScope = applied.createdTeam === true && appliedWing && appliedWing !== leaderOwnScope ? appliedWing : null;
  let leaderCanDelegate = Boolean(appliedWing && appliedWing === leaderOwnScope);
  if (autoScope) {
    try {
      const granted = agentSettings.grantTeamScope({
        leaderId: p.leaderId,
        scopes: [autoScope],
        mode: 'always',
        origin: 'system',
      });
      leaderCanDelegate = Boolean(granted && granted.ok === true);
      logLine(`team compose: kurulan takım için lidere izin YAZILDI (leader=${p.leaderId} scope=${autoScope} ok=${granted && granted.ok})`);
    } catch (err) {
      logLine(`team compose: izin yazılamadı (${String((err && err.message) || err)})`);
    }
  }
  return { autoScope, leaderCanDelegate };
}

async function handleComposeApply(ctx) {
  const { req, ledger, callRenderer, callerScopeFor, teamScope, agentSettings, teamComposeCore, ptys, getAppWindow, logLine } = ctx;
  const taken = ledger.takeApproval(req.proposalId, req.approvalToken);
  if (!taken.ok) return handleAwaitingOrUnknown(taken, req, ledger, getAppWindow);
  const p = taken.proposal;
  if (p.mode === 'engine') return applyEngineProposal(p, req, ledger, callRenderer, ptys, getAppWindow, logLine);
  let applied;
  try {
    applied = await callRenderer('team-compose:apply', {
      proposalId: p.proposalId, mode: p.mode, teamName: p.teamName, rows: p.rows, targetTeamId: p.targetTeamId,
    }, 60_000);
  } catch (err) {
    ledger.releaseApproval(p.proposalId);
    return composeFail(504, 'renderer-timeout', String((err && err.message) || err));
  }
  if (!applied || !applied.ok) {
    const wroteAny = applied && Array.isArray(applied.employeeIds) && applied.employeeIds.length > 0;
    if (!wroteAny) ledger.releaseApproval(p.proposalId);
    return composeFail(502, 'renderer', (applied && applied.error) || 'ekip kurulamadı.');
  }

  const { autoScope, leaderCanDelegate } = resolveScopeGrant({ applied, p, req, callerScopeFor, teamScope, agentSettings, logLine });
  const undoUntilIso = new Date(Date.now() + teamComposeCore.UNDO_TTL_MS).toISOString();
  const receipt = teamComposeCore.buildReceipt({
    createdTeam: applied.createdTeam === true,
    employees: Array.isArray(applied.employeeIds) ? applied.employeeIds.length : 0,
    names: Array.isArray(applied.names) ? applied.names : [],
    wingSlug: applied.wingSlug || null,
    visible: applied.visible,
    leaderCanDelegate,
    undoUntil: undoUntilIso,
  });
  const entry = ledger.recordApplied(p.proposalId, {
    teamId: applied.teamId || null,
    createdTeam: applied.createdTeam === true,
    employeeIds: Array.isArray(applied.employeeIds) ? applied.employeeIds : [],
    names: Array.isArray(applied.names) ? applied.names : [],
    wingSlug: applied.wingSlug || null,
    teamName: p.teamName,
    leaderId: p.leaderId,
    scopeGrant: autoScope,
    receipt,
  });
  receipt.undoUntil = new Date(entry.expiresAtMs).toISOString();
  try {
    const win = getAppWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('team-compose:applied', {
        proposalId: entry.proposalId,
        teamName: entry.teamName,
        names: entry.names,
        wingSlug: entry.wingSlug,
        visible: receipt.visible,
        undoExpiresAt: new Date(entry.expiresAtMs).toISOString(),
      });
    }
  } catch {
    /* şerit best-effort */
  }
  logLine(`team compose APPLY → team=${entry.teamId || '?'} employees=${entry.employeeIds.length} createdTeam=${entry.createdTeam} leader=${req.leaderId}`);
  return {
    status: 200,
    body: {
      ok: true,
      proposalId: entry.proposalId,
      teamId: entry.teamId,
      teamName: entry.teamName,
      wingSlug: entry.wingSlug,
      employees: entry.employeeIds.length,
      names: entry.names,
      receipt,
      receiptText: teamComposeCore.composeReceiptText({ teamName: entry.teamName, receipt }),
      unresolvedRoles: Array.isArray(applied.unresolvedRoles) ? applied.unresolvedRoles : [],
      renamed: Array.isArray(applied.renamed) ? applied.renamed : [],
      undoExpiresAt: new Date(entry.expiresAtMs).toISOString(),
    },
  };
}

async function handleComposeUndo({ req, ledger, callRenderer, agentSettings, logLine }) {
  const entry = ledger.takeUndo(req.proposalId);
  if (!entry) {
    return composeFail(409, 'undo-window-closed', 'Geri alma süresi doldu ya da bu kurulum zaten geri alındı (pencere 10 dakika).');
  }
  let undone;
  try {
    undone = await callRenderer('team-compose:undo', {
      teamId: entry.teamId,
      createdTeam: entry.createdTeam,
      employeeIds: entry.mode === 'engine' ? [] : entry.employeeIds,
      mode: entry.mode,
      engineChanges: entry.mode === 'engine' ? entry.engineChanges : [],
    }, 60_000);
  } catch (err) {
    return composeFail(504, 'renderer-timeout', String((err && err.message) || err));
  }
  if (!undone || !undone.ok) {
    return composeFail(502, 'renderer', (undone && undone.error) || 'geri alınamadı.');
  }
  if (entry.mode === 'engine') {
    logLine(`team compose UNDO (engine) → restored=${undone.restoredEngines || 0} leader=${entry.leaderId}`);
    return {
      status: 200,
      body: { ok: true, removedEmployees: 0, removedTeam: false, restoredEngines: undone.restoredEngines || 0 },
    };
  }
  if (entry.scopeGrant && entry.leaderId) {
    try {
      agentSettings.revokeTeamScope({ leaderId: entry.leaderId, scope: entry.scopeGrant, origin: 'system' });
      logLine(`team compose: geri alma izni de sildi (leader=${entry.leaderId} scope=${entry.scopeGrant})`);
    } catch (err) {
      logLine(`team compose: izin silinemedi (${String((err && err.message) || err)})`);
    }
  }
  logLine(`team compose UNDO → employees=${undone.removedEmployees || 0} team=${undone.removedTeam ? 'silindi' : 'korundu'}`);
  return {
    status: 200,
    body: {
      ok: true,
      removedEmployees: undone.removedEmployees || 0,
      removedTeam: undone.removedTeam === true,
    },
  };
}

/**
 * Team Compose Service (Faz 3.6.7)
 */
function createTeamComposeService(deps = {}) {
  const {
    teamComposeCore = teamComposeCoreDefault,
    teamScope = teamScopeDefault,
    modelDetect = modelDetectDefault,
    engineOffering = engineOfferingDefault,
    engineRegistry = engineRegistryDefault,
    planLimits = planLimitsDefault,
    agentSettings = { readSettings: () => ({}), sanitizeTeamCompose: () => ({}), grantTeamScope: () => {}, revokeTeamScope: () => {} },
    seatGate = null,
    callerScopeFor = () => '',
    ptys = null,
    getAppWindow = () => null,
    logLine = () => {},
  } = deps;

  let composeLedger = null;
  let composeTransport = null;

  function ensureComposeLedger() {
    if (!composeLedger) composeLedger = teamComposeCore.createComposeLedger();
    return composeLedger;
  }

  function composeAutonomy() {
    try {
      return agentSettings.sanitizeTeamCompose(agentSettings.readSettings().teamCompose).autonomy;
    } catch {
      return teamComposeCore.DEFAULT_AUTONOMY;
    }
  }

  function composePlanNote(seatCount) {
    return checkPlanNote({ seatGate, ptys, planLimits, seatCount });
  }

  async function teamComposeRequest(req, transport) {
    const ledger = ensureComposeLedger();
    const callRenderer = transport && transport.callRenderer;
    if (typeof callRenderer !== 'function') return composeFail(501, 'no-transport', 'renderer köprüsü yok.');

    if (req.action === 'propose') {
      return handleComposePropose({
        req, ledger, callRenderer, autonomy: composeAutonomy(),
        engineOffering, engineRegistry, teamComposeCore, modelDetect,
        composePlanNote, getAppWindow, logLine,
      });
    }

    if (req.action === 'apply') {
      return handleComposeApply({
        req, ledger, callRenderer, callerScopeFor, teamScope,
        agentSettings, teamComposeCore, ptys, getAppWindow, logLine,
      });
    }

    return handleComposeUndo({ req, ledger, callRenderer, agentSettings, logLine });
  }

  return {
    ensureComposeLedger,
    composeAutonomy,
    composePlanNote,
    composeFail,
    teamComposeRequest,
    getComposeTransport: () => composeTransport,
    setComposeTransport: (t) => { composeTransport = t; },
    teamComposeCore,
    applyEngineProposal: (p, req, ledger, cr) => applyEngineProposal(p, req, ledger, cr, ptys, getAppWindow, logLine),
  };
}

module.exports = {
  createTeamComposeService,
  composeFail,
  COMPOSE_NOTIFY_RETRY_MS,
  COMPOSE_NOTIFY_BUDGET_MS,
};
