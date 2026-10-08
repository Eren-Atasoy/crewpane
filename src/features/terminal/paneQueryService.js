'use strict';

/**
 * Terminal Pane Query & Lifecycle Service (Faz 3.6.34)
 * Encapsulates pane snapshots, filtering, MCP process reaping on kill,
 * screen tail persistence, and window-binding lifecycle.
 */

const MCP_REAP_GRACE_MS = 10_000;

const optVal = (val) => (val == null ? null : val);
const flagVal = (val) => val === true;

function defaultLabelTaskCodeOf(label, taskCodeMod) {
  if (!taskCodeMod || typeof taskCodeMod.taskCodeOf !== 'function') return null;
  try {
    return taskCodeMod.taskCodeOf(label) || null;
  } catch {
    return null;
  }
}

function captureScreenTail(entry) {
  if (!entry || !entry.screen) return null;
  try {
    const t = entry.screen.tail({ lines: 40 });
    const lines = [...(t.lines || []), ...(t.live || [])].slice(-40);
    return lines.length ? lines : null;
  } catch {
    return null;
  }
}

class PaneQueryService {
  constructor(deps = {}) {
    this.deps = deps;
    this.ptys = deps.ptys;
    this.agentRunner = deps.agentRunner;
    this.taskCodeMod = deps.taskCodeMod;
    this.mcpProcess = deps.mcpProcess;
    this.paneKill = deps.paneKill;
    this.livePaneRegistry = deps.livePaneRegistry;
    this.crewpaneHome = deps.crewpaneHome || (() => '');
    this.getPtyResumeService = deps.getPtyResumeService || (() => null);
    this.paneViewState = deps.paneViewState;
    this.paneDraft = deps.paneDraft;
    this.paneBudgetStore = deps.paneBudgetStore;
    this.logLine = deps.logLine || (() => {});
    this.isQuitting = deps.isQuitting || (() => false);
    this.isAutotest = deps.isAutotest || (() => false);
    this.platform = deps.platform || process.platform;
  }

  labelTaskCodeOf(label) {
    return defaultLabelTaskCodeOf(label, this.taskCodeMod);
  }

  formatPaneSnapshot(paneId, e, now) {
    const child = e.child;
    return {
      paneId,
      agentId: optVal(e.agentId),
      department: optVal(e.department),
      command: e.command,
      label: optVal(e.label),
      pid: e.pid,
      startedAt: e.startedAt,
      status: this.agentRunner ? this.agentRunner.statusFor(e.lastDataAt, now) : 'unknown',
      cwd: optVal(e.cwd),
      modelLabel: optVal(e.modelLabel),
      launchModel: optVal(e.launchModel),
      launchEffort: optVal(e.launchEffort),
      launchProvider: optVal(e.launchProvider),
      engineProfileId: optVal(e.engineProfileId),
      stalled: flagVal(e.stalled),
      stallEvidence: optVal(e.stallEvidence),
      pendingReset: flagVal(e.pendingReset),
      cols: typeof child?.cols === 'number' ? child.cols : null,
      rows: typeof child?.rows === 'number' ? child.rows : null,
      engineMissing: optVal(e.engineMissing),
      engineInstall: optVal(e.engineInstallGuide),
      workspaceMissing: flagVal(e.workspaceMissing),
      shellMissing: optVal(e.shellMissing),
      modelGate: optVal(e.modelGate),
      taskId: optVal(e.taskId),
      labelTaskCode: this.labelTaskCodeOf(e.label),
      branch: optVal(e.branch),
      worktreePath: optVal(e.worktreePath),
      capabilities: optVal(e.capabilities),
    };
  }

  paneMatchesFilter(entry, win, department) {
    if (win && entry.win && entry.win.id !== win.id) return false;
    if (department && entry.department !== department) return false;
    return true;
  }

  listPanes(win, department) {
    const now = Date.now();
    const out = [];
    if (!this.ptys) return out;
    for (const [paneId, e] of this.ptys) {
      if (!this.paneMatchesFilter(e, win, department)) continue;
      out.push(this.formatPaneSnapshot(paneId, e, now));
    }
    return out;
  }

  scheduleMcpChildReap(enginePid, paneId) {
    if (!this.mcpProcess || !Number.isInteger(enginePid) || enginePid <= 1) return;
    let ledger = [];
    try {
      ledger = this.mcpProcess.listMcpProcesses().rows
        .filter((r) => r.ownerPid === enginePid)
        .map((r) => r.pid);
    } catch {
      return;
    }
    if (!ledger.length) return;
    const timer = setTimeout(async () => {
      try {
        const res = await this.mcpProcess.reapOrphanMcp({ pids: ledger, minAgeMs: 0 });
        if (res && res.reaped && res.reaped.length) {
          this.logLine(`mcp-reap paneId=${paneId} engine=${enginePid} reaped=${res.reaped.length}/${ledger.length} pids=${res.reaped.map((r) => r.pid).join(',')}`);
        }
      } catch (e) {
        this.logLine(`mcp-reap failed paneId=${paneId}: ${(e && e.message) || e}`);
      }
    }, MCP_REAP_GRACE_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }

  killPaneExplicitAndCleanup(paneId) {
    if (!this.ptys) return false;
    const entry = this.ptys.get(paneId);
    const enginePid = (() => {
      try { return entry?.child?.pid ?? null; } catch { return null; }
    })();
    const resumeService = this.getPtyResumeService();
    const res = this.paneKill.killPaneExplicit({
      paneId,
      entry,
      isQuitting: this.isQuitting(),
      registry: this.livePaneRegistry,
      homedir: this.crewpaneHome(),
      resumeDaemon: resumeService ? resumeService.getDaemon() : null,
      log: this.logLine,
    });
    if (res.killed) {
      this.ptys.delete(paneId);
      this.scheduleMcpChildReap(enginePid, paneId);
      if (this.paneViewState) this.paneViewState.clearPaneView(paneId);
      if (this.paneDraft) this.paneDraft.clearPaneDraft(paneId);
      if (this.paneBudgetStore) this.paneBudgetStore.clearPane(paneId);
    }
    return res.killed === true;
  }

  captureScreenTail(entry) {
    return captureScreenTail(entry);
  }

  persistScreenTails() {
    if (!this.ptys || !this.livePaneRegistry) return;
    const tails = {};
    for (const [paneId, entry] of this.ptys) {
      const tail = captureScreenTail(entry);
      if (tail) tails[paneId] = tail;
    }
    try {
      const n = this.livePaneRegistry.setScreenTails(tails, this.crewpaneHome());
      if (n) this.logLine(`quit: screen tail persisted for ${n} pane(s)`);
    } catch {
      /* best-effort */
    }
  }

  killPtysForWindow(winId) {
    if (!this.ptys) return;
    const tails = {};
    for (const [paneId, entry] of this.ptys) {
      if (entry.win && entry.win.id !== winId) continue;
      const tail = captureScreenTail(entry);
      if (tail) tails[paneId] = tail;
    }
    try {
      if (this.livePaneRegistry) this.livePaneRegistry.setScreenTails(tails, this.crewpaneHome());
    } catch {
      /* best-effort */
    }
    for (const [paneId, entry] of this.ptys) {
      if (entry.win && entry.win.id === winId) {
        entry.preserve = true;
        try { entry.child.kill(); } catch { /* already dead */ }
        this.ptys.delete(paneId);
      }
    }
  }

  killAllPtys() {
    this.persistScreenTails();
    if (!this.ptys) return;
    for (const [paneId, entry] of this.ptys) {
      entry.preserve = true;
      try { entry.child.kill(); } catch { /* already dead */ }
      this.ptys.delete(paneId);
    }
  }

  keepPanesAliveOnWindowClose() {
    return this.platform === 'darwin' && !this.isQuitting() && !this.isAutotest();
  }

  rebindOrphanPanes(win) {
    if (!win || win.isDestroyed() || !this.ptys) return 0;
    let n = 0;
    for (const entry of this.ptys.values()) {
      if (entry.win && !entry.win.isDestroyed()) continue;
      entry.win = win;
      n += 1;
    }
    if (n) this.logLine(`ADP-905 rebind: ${n} yaşayan pane yeni pencereye bağlandı (win=${win.id})`);
    return n;
  }

  liveAgentPaneCount() {
    if (!this.ptys) return 0;
    let n = 0;
    for (const entry of this.ptys.values()) if (entry.agentId) n += 1;
    return n;
  }
}

function createPaneQueryService(deps) {
  return new PaneQueryService(deps);
}

module.exports = {
  createPaneQueryService,
  PaneQueryService,
  captureScreenTail,
  defaultLabelTaskCodeOf,
  optVal,
  flagVal,
  MCP_REAP_GRACE_MS,
};
