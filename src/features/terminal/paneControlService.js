'use strict';

const defaultEngineRegistry = require('../../agents/engineRegistry.cjs');
const defaultLivePaneRegistry = require('../../agents/livePaneRegistry.cjs');
const defaultPaneControl = require('../../terminal/paneControl.cjs');
const defaultPaneKill = require('../../terminal/paneKill.cjs');
const defaultAgentRunner = require('../../agents/agentRunner.js');
const defaultTeamScope = require('../../agents/teamScope.cjs');
const defaultTaskCode = require('../../agents/taskCode.cjs');
const defaultAgentSettings = require('../../agents/agentSettings.cjs');

const MAX_TASKS_PER_SESSION = 10;
const RESET_ESC_GAP_MS = 150;
const RESET_SUBMIT_GAP_MS = 400;
const CROSS_TEAM_CARD_TTL_MS = 10 * 60 * 1000;
const CROSS_TEAM_CONSENT_WAIT_MS = 10000;

function labelTaskCodeOf(label, taskCodeMod = defaultTaskCode) {
  try {
    return taskCodeMod.taskCodeOf(label) || null;
  } catch {
    return null;
  }
}

function buildApprovalDialogPayload(approvalId, leaderId, callerScope, targetScope) {
  return {
    id: approvalId,
    title: 'Takım dışına iş verme izni',
    detail:
      `"${leaderId}" kendi takımının (${callerScope || 'bilinmiyor'}) DIŞINDA, ` +
      `"${targetScope}" takımından bir çalışana iş vermek istiyor.\n` +
      'İzin verirsen o takımın pane\'lerini kapatabilir de (yetki = yönetim).',
    source: 'desktop',
    choices: [
      { id: 'approve', label: 'Her zaman izin ver' },
      { id: 'single', label: 'Yalnız bu sefer' },
      { id: 'cancel', label: 'Reddet' },
    ],
  };
}

function recordConsentGranted(answer, leaderId, targetScope, agentSettings, teamScope, logLine) {
  if (answer !== 'deny') {
    const granted = agentSettings.grantTeamScope({
      leaderId,
      scopes: [teamScope.normalizeScope(targetScope)],
      mode: answer === 'once' ? 'once' : 'always',
    });
    logLine(`team scope: SAHİP İZİN VERDİ leader=${leaderId} target=${targetScope} mode=${answer} ok=${granted.ok}`);
  } else {
    logLine(`team scope: sahip İZİN VERMEDİ leader=${leaderId} target=${targetScope}`);
  }
}

const DEFAULT_PANE_CONTROL_DEPS = {
  ptys: null,
  getAppWindow: () => null,
  crewpaneHome: () => '',
  logLine: () => {},
  getPtyResumeService: () => null,
  getJarvisConv: () => null,
  appVersion: () => '0.0.0',
  isQuitting: () => false,
  engineRegistry: defaultEngineRegistry,
  livePaneRegistry: defaultLivePaneRegistry,
  paneControl: defaultPaneControl,
  paneKill: defaultPaneKill,
  agentRunner: defaultAgentRunner,
  teamScope: defaultTeamScope,
  taskCode: defaultTaskCode,
  agentSettings: defaultAgentSettings,
};

class PaneControlService {
  constructor(deps = {}) {
    const opts = Object.assign({}, DEFAULT_PANE_CONTROL_DEPS, deps);
    this._ptys = opts.ptys || new Map();
    this._getAppWindow = opts.getAppWindow;
    this._crewpaneHome = opts.crewpaneHome;
    this._logLine = opts.logLine;
    this._getPtyResumeService = opts.getPtyResumeService;
    this._getJarvisConv = opts.getJarvisConv;
    this._appVersion = opts.appVersion;
    this._isQuitting = opts.isQuitting;
    this._engineRegistry = opts.engineRegistry;
    this._livePaneRegistry = opts.livePaneRegistry;
    this._paneControl = opts.paneControl;
    this._paneKill = opts.paneKill;
    this._agentRunner = opts.agentRunner;
    this._teamScope = opts.teamScope;
    this._taskCode = opts.taskCode;
    this._agentSettings = opts.agentSettings;

    this.crossTeamConsentPending = new Map();
  }

  resetCommandFor(command) {
    const cmd = this._engineRegistry.capability(command, 'reset');
    return typeof cmd === 'string' && cmd ? cmd : null;
  }

  killPane(paneId, entry, agentId, why) {
    try {
      entry.child.kill();
    } catch {
      /* already dead */
    }
    this._ptys.delete(paneId);
    try {
      this._livePaneRegistry.freePane(paneId, this._crewpaneHome());
    } catch {
      /* best-effort */
    }
    const resumeService = this._getPtyResumeService();
    if (resumeService && typeof resumeService.forgetPane === 'function') {
      resumeService.forgetPane(paneId);
    }
    this._logLine(`pane recycled (${why}) paneId=${paneId} agent=${agentId}`);
  }

  softResetPane(paneId, entry, agentId, resetCmd) {
    try {
      entry.child.write('\x1b');
    } catch {
      return false;
    }
    setTimeout(() => {
      try {
        entry.child.write(resetCmd);
      } catch {
        return;
      }
      setTimeout(() => {
        try {
          entry.child.write('\r');
        } catch {
          /* pane died mid-reset */
        }
      }, RESET_SUBMIT_GAP_MS);
    }, RESET_ESC_GAP_MS);
    entry.lastResetAt = Date.now();
    entry.taskCount = (entry.taskCount || 0) + 1;
    this._logLine(`pane recycled (soft reset ${resetCmd}) paneId=${paneId} agent=${agentId} tasks=${entry.taskCount}`);
    return true;
  }

  recycleWorkerPanes(agentId, mode = 'reset') {
    if (typeof agentId !== 'string' || !agentId) return 0;
    let freed = 0;
    for (const [paneId, entry] of [...this._ptys]) {
      if (entry.agentId !== agentId || entry.disallowSubagent !== true) continue;
      const resetCmd = mode === 'reset' ? this.resetCommandFor(entry.command) : null;
      const overBudget = (entry.taskCount || 0) + 1 >= MAX_TASKS_PER_SESSION;
      if (!resetCmd || overBudget) {
        this.killPane(paneId, entry, agentId, overBudget ? 'task budget spent' : 'delegation free');
      } else if (!this.softResetPane(paneId, entry, agentId, resetCmd)) {
        this.killPane(paneId, entry, agentId, 'reset write failed');
      }
      freed++;
    }
    return freed;
  }

  allPanesForControl() {
    const out = [];
    const now = Date.now();
    for (const [paneId, e] of this._ptys) {
      out.push(
        this._paneControl.summarizePane({
          paneId,
          ...e,
          status: this._agentRunner.statusFor(e.lastDataAt, now),
          labelTaskCode: labelTaskCodeOf(e.label, this._taskCode),
          exited: false,
        }),
      );
    }
    return out;
  }

  callerScopeFor(leaderId, declared) {
    const id = typeof leaderId === 'string' ? leaderId.trim() : '';
    if (id) {
      for (const e of this._ptys.values()) {
        if (e && e.agentId === id && e.department) return e.department;
      }
    }
    return typeof declared === 'string' ? declared : '';
  }

  authorizeTeamScope({ action, leaderId, targetScope, force, targetStartedAt } = {}) {
    const policy = this._agentSettings.teamScopePolicy(this._appVersion());
    const decision = this._teamScope.authorize({
      action,
      callerId: leaderId,
      callerScope: this.callerScopeFor(leaderId, ''),
      targetScope,
      policy,
      force: force === true,
      targetStartedAt,
    });
    if (decision.ok && decision.via === 'grant' && action === 'delegate' && decision.grant && decision.grant.mode === 'once') {
      const consumed = this._teamScope.consumeGrant(policy.grants, decision.grant);
      if (consumed.changed) {
        this._agentSettings.writeSettings({ teamScope: { ...policy, grants: consumed.grants } });
        this._logLine(`team scope: tek-seferlik izin TÜKETİLDİ (leader=${leaderId} scope=${targetScope}) → yalnız yönetim`);
      }
    }
    this._logLine(
      `team scope: ${action} by=${leaderId || '-'} target=${targetScope || '-'} → ` +
        (decision.ok ? `İZİNLİ (${decision.via})` : `RED (${decision.code})`),
    );
    return decision;
  }

  askCrossTeamConsent({ leaderId, callerScope, targetScope }) {
    const key = `${leaderId}→${targetScope}`;
    const inflight = this.crossTeamConsentPending.get(key);
    if (inflight) return inflight;

    const promise = new Promise((resolve) => {
      const approvalId = `tsc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      let settled = false;
      let off = null;
      let timer = null;

      const finish = (answer) => {
        if (settled) return;
        settled = true;
        if (off) {
          try {
            off();
          } catch {
            /* best-effort */
          }
        }
        if (timer) clearTimeout(timer);
        this.crossTeamConsentPending.delete(key);
        recordConsentGranted(answer, leaderId, targetScope, this._agentSettings, this._teamScope, this._logLine);
        resolve(answer);
      };

      const jarvisConv = this._getJarvisConv();
      if (!jarvisConv || typeof jarvisConv.openApproval !== 'function') {
        finish('deny');
        return;
      }

      try {
        off = jarvisConv.onChange((event) => {
          if (!event || event.type !== 'approval-resolved' || event.approvalId !== approvalId) return;
          if (event.status !== 'allowed') return finish('deny');
          finish(event.choice === 'single' ? 'once' : 'always');
        });

        const dialogPayload = buildApprovalDialogPayload(approvalId, leaderId, callerScope, targetScope);
        const opened = jarvisConv.openApproval(dialogPayload);
        if (!opened) return finish('deny');

        this._logLine(`team scope: İZİN SORULDU leader=${leaderId} target=${targetScope} approvalId=${approvalId}`);
        timer = setTimeout(() => {
          try {
            jarvisConv.closeApproval(approvalId, 'expired');
          } catch {
            /* best-effort */
          }
          this._logLine(`team scope: izin kartı SÜRESİ DOLDU (leader=${leaderId} target=${targetScope})`);
          finish('deny');
        }, CROSS_TEAM_CARD_TTL_MS);
        if (timer && typeof timer.unref === 'function') timer.unref();
      } catch (err) {
        this._logLine(`team scope: izin kartı açılamadı: ${String((err && err.message) || err)}`);
        finish('deny');
      }
    });

    this.crossTeamConsentPending.set(key, promise);
    return promise;
  }

  async authorizeTeamScopeInteractive({ action, leaderId, targetScope, force, targetStartedAt } = {}) {
    const first = this.authorizeTeamScope({ action, leaderId, targetScope, force, targetStartedAt });
    if (first.ok || first.code !== 'cross-team') return first;

    const callerScope = this.callerScopeFor(leaderId, '');
    const consent = this.askCrossTeamConsent({ leaderId, callerScope, targetScope });

    let timer = null;
    const answer = await Promise.race([
      consent,
      new Promise((r) => {
        timer = setTimeout(() => r('pending'), CROSS_TEAM_CONSENT_WAIT_MS);
        if (timer && typeof timer.unref === 'function') timer.unref();
      }),
    ]);
    if (timer) clearTimeout(timer);

    if (answer === 'pending') {
      return {
        ...first,
        code: 'cross-team-consent-pending',
        reason:
          `${first.reason}\n(Sahibine SORULDU — masaüstündeki/telefondaki izin kartı açık. ` +
          'İzin verilince aynı isteği tekrar gönder.)',
      };
    }
    if (answer === 'deny') {
      return {
        ...first,
        reason: `${first.reason}\n(Sahibine soruldu; izin VERİLMEDİ.)`,
      };
    }
    return this.authorizeTeamScope({ action, leaderId, targetScope, force, targetStartedAt });
  }

  listPanesForControl(caller = {}) {
    const all = this.allPanesForControl();
    const leaderId = (caller && typeof caller.leaderId === 'string' ? caller.leaderId : '').trim();
    if (!leaderId) return all;
    return this._teamScope.visiblePanes(all, {
      callerId: leaderId,
      callerScope: this.callerScopeFor(leaderId, caller.department),
      policy: this._agentSettings.teamScopePolicy(this._appVersion()),
    });
  }

  closePanesForControl(payload = {}) {
    const filter = payload.filter && typeof payload.filter === 'object' ? payload.filter : {};
    const leaderId = typeof payload.leaderId === 'string' ? payload.leaderId : '';
    const caller = {
      agentId: leaderId,
      department: this.callerScopeFor(leaderId, payload.department),
      force: payload.force === true,
      policy: this._agentSettings.teamScopePolicy(this._appVersion()),
    };
    const plan = this._paneControl.planClose(this.allPanesForControl(), filter, caller);
    if (!plan.ok) {
      this._logLine(`pane control: close REFUSED by=${caller.agentId || '-'} reason=${plan.error}`);
      return { ok: false, error: plan.error };
    }
    const closed = [];
    const resumeService = this._getPtyResumeService();
    for (const p of plan.close) {
      const entry = this._ptys.get(p.paneId);
      if (!entry) continue;
      const res = this._paneKill.killPaneExplicit({
        paneId: p.paneId,
        entry,
        isQuitting: this._isQuitting(),
        registry: this._livePaneRegistry,
        homedir: this._crewpaneHome(),
        resumeDaemon: resumeService ? resumeService.getDaemon() : null,
        log: this._logLine,
      });
      if (res.killed) {
        this._ptys.delete(p.paneId);
        closed.push(p.paneId);
      }
    }
    this._logLine(
      `pane control: close by=${caller.agentId || '-'} dept=${caller.department || '-'} ` +
        `filter=${JSON.stringify(filter)} force=${caller.force} closed=[${closed.join(',')}] ` +
        `denied=[${plan.denied.map((d) => d.paneId).join(',')}]`,
    );
    return { ok: true, closed, denied: plan.denied };
  }

  focusPaneForControl(paneId, caller = {}) {
    const id = String(paneId || '');
    const entry = this._ptys.get(id);
    if (!entry) return { ok: false, error: `no such pane: ${id}` };
    const leaderId = typeof caller.leaderId === 'string' ? caller.leaderId.trim() : '';
    if (leaderId) {
      const scoped = this.authorizeTeamScope({
        action: 'manage',
        leaderId,
        targetScope: entry.department,
        force: true,
        targetStartedAt: entry.startedAt,
      });
      if (!scoped.ok) return { ok: false, code: scoped.code, error: scoped.reason };
    }
    const appWin = this._getAppWindow();
    const win = entry.win && !entry.win.isDestroyed() ? entry.win : appWin;
    if (!win || win.isDestroyed()) return { ok: false, error: 'no app window' };
    win.webContents.send('pane:focus', { paneId: id });
    try {
      win.show();
      win.focus();
    } catch {
      /* best-effort */
    }
    this._logLine(`pane control: focus paneId=${id} agent=${entry.agentId ?? '-'}`);
    return { ok: true, paneId: id };
  }
}

function createPaneControlService(deps = {}) {
  return new PaneControlService(deps);
}

module.exports = {
  createPaneControlService,
  PaneControlService,
  labelTaskCodeOf,
  buildApprovalDialogPayload,
  recordConsentGranted,
};
