'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const delegationSupervisorMod = require('../../agents/delegationSupervisor.cjs');
const delegationSupervisorStore = require('../../agents/delegationSupervisorStore.cjs');
const boardTaskSyncMod = require('../../agents/boardTaskSync.cjs');
const leaderBriefing = require('../../agents/leaderBriefing.cjs');
const notifyGateMod = require('../../services/notifyGate.cjs');
const notifyLog = require('../../services/notifyLog.cjs');
const secretRedactor = require('../../security/secretRedactor.cjs');
const crewpaneEnv = require('../../config/crewpaneEnv.cjs');

const SUPERVISOR_NULL = Object.freeze({
  record: () => null,
  settle: () => false,
  ack: () => 0,
  leaderStatus: () => ({ at: 0, records: [], untracked: [], disabled: true }),
  sweep: async () => {},
  start: () => {},
  stop: () => {},
  repairAfterRestart: () => 0,
  markExternalShutdown: () => [],
  externalShutdownNote: () => null,
  snapshot: () => ({ version: 0, records: {}, disabled: true }),
  config: () => ({ disabled: true }),
});

const ENV_OVERRIDES_MAP = [
  ['CREWPANE_SUPERVISOR_TICK_MS', 'tickMs', 1],
  ['CREWPANE_SUPERVISOR_DELIVERY_MS', 'deliveryCheckMs', 1],
  ['CREWPANE_SUPERVISOR_PANE_GRACE_MS', 'paneGoneGraceMs', 0],
  ['CREWPANE_SUPERVISOR_WAKE_ACK_MS', 'wakeAckWindowMs', 1],
  ['CREWPANE_SUPERVISOR_REAP_GRACE_MS', 'reapGraceMs', 0],
  ['CREWPANE_SUPERVISOR_IDLE_MS', 'idleMs', 0],
  ['CREWPANE_SUPERVISOR_WAKE_VERIFY_MS', 'wakeVerifyMs', 0],
  ['CREWPANE_SUPERVISOR_WAKE_COALESCE_MS', 'wakeCoalesceMs', 0],
  ['CREWPANE_SUPERVISOR_INPUT_QUIET_MS', 'wakeInputQuietMs', 0],
  ['CREWPANE_SUPERVISOR_SAMPLE_GAP_MS', 'wakeSampleGapMs', 0],
  ['CREWPANE_SUPERVISOR_DRAFT_GRACE_MS', 'wakeDraftGraceMs', 0],
];

function buildSupervisorOverrides() {
  const overrides = {};
  for (const [envKey, optKey, minVal] of ENV_OVERRIDES_MAP) {
    const val = Number(process.env[envKey]);
    if (Number.isFinite(val) && val >= minVal) {
      overrides[optKey] = val;
    }
  }
  if (crewpaneEnv.readEnv('LEADER_WAKE_OWNER') === 'renderer') {
    overrides.ownLeaderWake = false;
  }
  return overrides;
}

function supervisorFingerprint(absPath) {
  try {
    const buf = fs.readFileSync(absPath);
    return crypto.createHash('sha1').update(buf).digest('hex');
  } catch {
    return null;
  }
}

function readReceiptsFile(homedir) {
  try {
    const p = path.join(homedir, leaderBriefing.RECEIPT_FILE);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function readEvidenceFileStat(absPath) {
  try {
    const s = fs.statSync(absPath);
    return { exists: s.isFile(), mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return { exists: false, mtimeMs: 0, size: 0 };
  }
}

function isInactiveStatus(status) {
  return status === 'done' || status === 'failed' || status === 'undelivered';
}

const defaultDeps = {
  ptys: new Map(),
  crewpaneHome: () => process.env.HOME || '',
  logLine: () => {},
  getAppWindow: () => null,
  planDenial: () => false,
  supervisorFor: () => ({ run: (_name, fn) => fn() }),
  resolveWorkerNotifyPath: () => null,
  rendererSupabaseTarget: () => null,
  appDbTokenFor: () => null,
  telemetryBump: () => {},
  resetCommandFor: () => null,
  maxTasksPerSession: 10,
  killPane: () => {},
  probeTranscriptVerdict: () => null,
  probeTranscriptVerifiable: () => false,
};

class DelegationSupervisorService {
  constructor(deps) {
    const d = Object.assign({}, defaultDeps, deps);
    this.ptys = d.ptys;
    this.crewpaneHome = d.crewpaneHome;
    this.logLine = d.logLine;
    this.getAppWindow = d.getAppWindow;
    this.planDenial = d.planDenial;
    this.supervisorFor = d.supervisorFor;
    this.resolveWorkerNotifyPath = d.resolveWorkerNotifyPath;
    this.rendererSupabaseTarget = d.rendererSupabaseTarget;
    this.appDbTokenFor = d.appDbTokenFor;
    this.telemetryBump = d.telemetryBump;
    this.resetCommandFor = d.resetCommandFor;
    this.maxTasksPerSession = d.maxTasksPerSession;
    this.killPane = d.killPane;
    this.probeTranscriptVerdict = d.probeTranscriptVerdict;
    this.probeTranscriptVerifiable = d.probeTranscriptVerifiable;

    this.delegationSupervisor = null;
    this.supervisorSweepTimer = null;
    this.notifyGateInstance = null;
    this.boardTaskSyncInstance = null;
    this.supervisorPending = new Map();
    this.supervisorReqSeq = 0;
    this.supervisorAdvanceBlocked = 0;
  }

  notifyGate() {
    if (this.notifyGateInstance) return this.notifyGateInstance;
    const envNum = (name, fallback) => {
      const v = Number(crewpaneEnv.readEnv(name));
      return Number.isFinite(v) && v >= 0 ? v : fallback;
    };
    this.notifyGateInstance = notifyGateMod.createNotifyGate({
      emit: (evt) => {
        const dest = this.resolveWorkerNotifyPath(evt && evt.department);
        notifyLog.appendWorkerEvent(dest, secretRedactor.redactDeep(evt));
      },
      log: (line) => this.logLine(line),
      opts: {
        coalesceMs: envNum('NOTIFY_COALESCE_MS', notifyGateMod.DEFAULTS.coalesceMs),
        dedupeTtlMs: envNum('NOTIFY_DEDUPE_TTL_MS', notifyGateMod.DEFAULTS.dedupeTtlMs),
      },
    });
    return this.notifyGateInstance;
  }

  boardTaskSync() {
    if (this.boardTaskSyncInstance) return this.boardTaskSyncInstance;
    this.boardTaskSyncInstance = boardTaskSyncMod.createBoardTaskSync({
      target: () => {
        const t = this.rendererSupabaseTarget();
        return t && t.url && t.anonKey ? { url: t.url, anonKey: t.anonKey, schema: t.schema } : null;
      },
      accessToken: () => this.appDbTokenFor('supervisor:board-sync'),
      enabled: () => crewpaneEnv.readEnv('BOARD_SYNC') !== '0',
      log: (line) => this.logLine(line),
    });
    return this.boardTaskSyncInstance;
  }

  supervisorListPanes() {
    const out = [];
    for (const [paneId, entry] of this.ptys) {
      out.push({
        paneId,
        agentId: entry.agentId || null,
        command: entry.command || null,
        bytes: entry.bytes || 0,
        disallowSubagent: entry.disallowSubagent === true,
      });
    }
    return out;
  }

  reapWorkerPane(paneId, why) {
    const entry = this.ptys.get(paneId);
    if (!entry || entry.disallowSubagent !== true) return false;
    const resetCmd = this.resetCommandFor(entry.command);
    const overBudget = (entry.taskCount || 0) + 1 >= this.maxTasksPerSession;
    if (!resetCmd || overBudget) {
      this.killPane(paneId, entry, entry.agentId, why);
      return true;
    }
    entry.pendingReset = true;
    const aid = entry.agentId || '-';
    this.logLine(`pane reap ERTELENDİ (çıktı ekranda kalsın) paneId=${paneId} agent=${aid} why=${why}`);
    return true;
  }

  supervisorAskRenderer(channel, payload, timeoutMs = 8000) {
    const win = this.getAppWindow();
    if (!win || win.isDestroyed()) return Promise.resolve(false);
    const requestId = `sup-${++this.supervisorReqSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.supervisorPending.delete(requestId);
        resolve(false);
      }, timeoutMs);
      this.supervisorPending.set(requestId, { resolve, timer });
      try {
        win.webContents.send(channel, { requestId, ...payload });
      } catch {
        clearTimeout(timer);
        this.supervisorPending.delete(requestId);
        resolve(false);
      }
    });
  }

  supervisorPushRenderer(channel, payload) {
    if (channel === 'dlgsup:advance' && this.planDenial('autopilot')) {
      this.supervisorAdvanceBlocked++;
      return Promise.resolve(false);
    }
    return this.supervisorAskRenderer(channel, payload);
  }

  scheduleSupervisorSweep(delayMs = 1500) {
    if (!this.delegationSupervisor || this.supervisorSweepTimer) return;
    this.supervisorSweepTimer = setTimeout(() => {
      this.supervisorSweepTimer = null;
      if (this.delegationSupervisor) void this.delegationSupervisor.sweep();
    }, delayMs);
    if (this.supervisorSweepTimer.unref) this.supervisorSweepTimer.unref();
  }

  buildSupervisorDeps(guard, overrides) {
    return {
      loadState: () => delegationSupervisorStore.loadState(this.crewpaneHome()),
      saveState: (s) => delegationSupervisorStore.saveState(s, this.crewpaneHome()),
      listPanes: () => this.supervisorListPanes(),
      readPaneBuffer: (paneId) => {
        const e = this.ptys.get(paneId);
        return e ? e.buffer || '' : '';
      },
      writePane: (paneId, text) => {
        const e = this.ptys.get(paneId);
        if (!e) return false;
        try { e.child.write(text); return true; } catch { return false; }
      },
      reapPane: (paneId, why) => guard.run('reap', () => this.reapWorkerPane(paneId, why), false),
      fingerprint: supervisorFingerprint,
      evidenceStat: (absPath) => readEvidenceFileStat(absPath),
      transcriptHas: (rec) => {
        if (!rec.paneId || !rec.promptSignature) return null;
        return this.probeTranscriptVerdict(rec.paneId, String(rec.promptSignature));
      },
      wakeVerifiable: (paneId) => this.probeTranscriptVerifiable(paneId),
      leaderTranscriptHas: (paneId, needle) => {
        if (!needle) return null;
        const e = this.ptys.get(paneId);
        return this.probeTranscriptVerdict(paneId, String(needle), { sessionId: e ? e.sessionId : null });
      },
      notify: (evt) => this.notifyGate().admit(evt),
      lastInputAt: (paneId) => {
        const e = this.ptys.get(paneId);
        return e && typeof e.lastInputAt === 'number' ? e.lastInputAt : null;
      },
      lastSubmitAt: (paneId) => {
        const e = this.ptys.get(paneId);
        return e && typeof e.lastSubmitAt === 'number' ? e.lastSubmitAt : null;
      },
      readBriefingReceipts: () => readReceiptsFile(this.crewpaneHome()),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      pushRenderer: (ch, p) => this.supervisorPushRenderer(ch, p),
      boardSync: (input) => {
        if (input && input.phase === 'dispatch') this.telemetryBump('delegations');
        return this.boardTaskSync().sync(input);
      },
      log: (line) => this.logLine(line),
      opts: overrides,
    };
  }

  ensureDelegationSupervisor() {
    if (this.delegationSupervisor) return this.delegationSupervisor;
    if (crewpaneEnv.readEnv('SUPERVISOR') === '0') {
      this.logLine('supervisor: KAPALI (CREWPANE_SUPERVISOR=0) — ADP-659 öncesi davranış');
      this.delegationSupervisor = SUPERVISOR_NULL;
      return this.delegationSupervisor;
    }
    const guard = this.supervisorFor('delegation-supervisor');
    const overrides = buildSupervisorOverrides();
    const deps = this.buildSupervisorDeps(guard, overrides);

    this.delegationSupervisor = delegationSupervisorMod.createDelegationSupervisor(deps);
    this.delegationSupervisor.start();
    return this.delegationSupervisor;
  }

  getSupervisor() {
    return this.delegationSupervisor || SUPERVISOR_NULL;
  }

  markExternalShutdown(sig) {
    return (this.delegationSupervisor || SUPERVISOR_NULL).markExternalShutdown(sig);
  }

  externalShutdownNote(hits) {
    return (this.delegationSupervisor || SUPERVISOR_NULL).externalShutdownNote(hits);
  }

  leaderInFlightCount(agentId) {
    if (!agentId || !this.delegationSupervisor) return 0;
    try {
      const st = this.delegationSupervisor.leaderStatus(String(agentId));
      const recs = (st && st.records) || [];
      return recs.filter((r) => !isInactiveStatus(r.status)).length;
    } catch {
      return 1;
    }
  }

  leaderOpenSubtasks(agentId) {
    if (!agentId || !this.delegationSupervisor) return [];
    try {
      const st = this.delegationSupervisor.leaderStatus(String(agentId));
      return ((st && st.records) || []).filter((r) => !isInactiveStatus(r.status));
    } catch {
      return [];
    }
  }

  getSupervisorAdvanceBlocked() {
    return this.supervisorAdvanceBlocked;
  }
}

function createDelegationSupervisorService(deps) {
  return new DelegationSupervisorService(deps);
}

module.exports = {
  createDelegationSupervisorService,
  DelegationSupervisorService,
  SUPERVISOR_NULL,
  supervisorFingerprint,
};
