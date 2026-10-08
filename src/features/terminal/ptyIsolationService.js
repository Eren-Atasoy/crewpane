'use strict';

const worktreeStore = require('../../services/worktreeStore.cjs');
const taskCodeMod = require('../../agents/taskCode.cjs');
const projectRepos = require('../../config/projectRepos.cjs');
const worktreeService = require('../../services/worktreeService.cjs');
const taskClaim = require('../../agents/taskClaim.cjs');
const opencodeModelGate = require('../../agents/opencodeModelGate.cjs');
const engineRegistry = require('../../agents/engineRegistry.cjs');
const agentRunner = require('../../agents/agentRunner.js');
const engineInstall = require('../../agents/engineInstall.cjs');
const instancePaths = require('../../config/instancePaths.cjs');

const defaultDeps = {
  ptys: new Map(),
  crewpaneHome: () => instancePaths.crewpaneHome(),
  logLine: () => {},
  getWorkspaceRoot: () => null,
  readSettings: () => ({}),
  appI18n: { t: (k) => k, getLocale: () => 'en' },
};

function buildReusePayload(paneId, entry) {
  return {
    paneId,
    pid: entry ? entry.pid : undefined,
    command: entry ? entry.command : undefined,
    shell: entry ? entry.command : undefined,
    agentId: (entry && entry.agentId) || null,
    department: (entry && entry.department) || null,
    cwd: (entry && entry.cwd) || null,
    model: (entry && entry.launchModel) || null,
    reused: true,
  };
}

function handleClaimReuse(claim, ptys, why, logLine, agentId) {
  const existing = ptys.get(claim.paneId);
  if (!existing) return null;
  logLine(`pty:spawn GÖREV KİLİDİ (${why}) agentId=${agentId} — ${claim.why}`);
  return buildReusePayload(claim.paneId, existing);
}

function handleForceFresh(twin, opts, why, logLine, agentId) {
  const verdict = taskClaim.decideForceFresh(
    { paneId: twin.paneId, stalled: twin.entry.stalled === true },
    opts,
  );
  if (!verdict.honored) {
    logLine(`pty:spawn forceFresh REDDEDİLDİ (${why}) agentId=${agentId} sebep=${verdict.reason} — ${verdict.why}`);
    return buildReusePayload(twin.paneId, twin.entry);
  }
  logLine(
    `pty:spawn İKİNCİ PANE (forceFresh/${verdict.reason}, ${why}) agentId=${agentId} — ${verdict.why}; `
      + `mevcut canlı pane ${twin.paneId} DURUYOR. `
      + 'Bu pane\'i geri kazanmak supervisor hayalet-reap\'inin ya da operatörün işi.',
  );
  return null;
}

function extractIsolationTarget(opts) {
  const isAgent = typeof opts?.command === 'string' && opts.command !== 'shell';
  if (!isAgent) return null;
  const taskId = typeof opts?.taskId === 'string' && opts.taskId.trim() ? opts.taskId.trim() : null;
  if (!taskId) return null;
  let project = '';
  if (typeof opts?.project === 'string' && opts.project.trim()) {
    project = opts.project.trim();
  } else if (typeof opts?.department === 'string' && opts.department.trim()) {
    project = opts.department.trim();
  }
  return { taskId, project };
}

function resolveRepoForProject(project, workspaceRoot, settings, home, logLine) {
  return projectRepos.resolveProjectRepo(project, workspaceRoot, {
    settings,
    store: worktreeStore,
    homedir: home,
    log: logLine,
  });
}

function resolveIsolationCode(opts, taskId) {
  const labelCode = taskCodeMod.taskCodeOf(opts && opts.label);
  if (labelCode) return labelCode;
  const taskCode = taskCodeMod.taskCodeOf(taskId);
  return taskCode || taskId;
}

class PtyIsolationService {
  constructor(deps = {}) {
    this.deps = Object.assign({}, defaultDeps, deps);
  }

  isOwnerLive(ownerAgentId) {
    for (const e of this.deps.ptys.values()) {
      if (e && e.agentId === ownerAgentId) return true;
    }
    return false;
  }

  projectIsolationMode(project) {
    try {
      const s = this.deps.readSettings();
      const map = s && s.projectIsolation;
      const v = map && typeof map === 'object' ? map[String(project || '').toLowerCase()] : null;
      return v === 'worktree' ? 'worktree' : 'off';
    } catch {
      return 'off';
    }
  }

  activeWorktreePaths() {
    try {
      return worktreeStore.listByState('active', this.deps.crewpaneHome())
        .map((r) => r.path)
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  resolveTaskWorktreeSync(opts) {
    try {
      const taskId = typeof opts?.taskId === 'string' && opts.taskId.trim() ? opts.taskId.trim() : null;
      if (!taskId) return null;
      const rec = worktreeService.resolveExistingSync(taskId, this.deps.crewpaneHome());
      return rec ? { taskWorktree: rec.path, taskBranch: rec.branch, taskId: rec.taskId } : null;
    } catch (e) {
      this.deps.logLine(`worktree çözümü başarısız (spawn izolasyonsuz devam eder): ${e.message}`);
      return null;
    }
  }

  async prepareTaskIsolation(opts) {
    const target = extractIsolationTarget(opts);
    if (!target) return null;
    const { taskId, project } = target;

    const isolation = this.projectIsolationMode(project);
    if (isolation !== 'worktree') return null;

    const code = resolveIsolationCode(opts, taskId);
    const repo = resolveRepoForProject(
      project,
      this.deps.getWorkspaceRoot(),
      this.deps.readSettings(),
      this.deps.crewpaneHome(),
      this.deps.logLine,
    );
    if (!repo) {
      return { blocked: true, why: `proje '${project}' için git deposu bulunamadı (H-5) — izolasyon açıkken paylaşımlı ağaçta koşulmaz` };
    }

    const res = await worktreeService.ensure({
      taskId,
      code,
      project,
      agentId: (opts && typeof opts.agentId === 'string') ? opts.agentId : null,
      paneId: null,
      workspaceRoot: this.deps.getWorkspaceRoot(),
      repoPath: repo.repoPath,
      defaultBranch: (worktreeStore.getProject(project, this.deps.crewpaneHome()) || {}).defaultBranch || 'dev',
      isolation,
      ownerLive: (ownerAgentId) => this.isOwnerLive(ownerAgentId),
      homedir: this.deps.crewpaneHome(),
      log: this.deps.logLine,
    });
    if (!res.ok) {
      return res.degrade ? null : { blocked: true, why: res.why };
    }
    for (const n of res.notes || []) this.deps.logLine(`worktree[${taskId}]: ${n}`);
    return { trusted: { taskWorktree: res.path, taskBranch: res.branch, taskId } };
  }

  async preflightModelGate(opts, trusted) {
    try {
      const command = typeof opts.command === 'string' ? opts.command : '';
      if (!command || command === 'shell') return null;
      const descriptor = engineRegistry.getEngine(command);
      if (!descriptor || !descriptor.modelGate) return null;
      const model = agentRunner.sanitizeModel(opts.model, command);
      if (!model) return null;
      const resolved = agentRunner.resolveCommand(command);
      const env = agentRunner.sanitizeEnv(opts.env, process.env);
      const bin = engineInstall.resolveBinary(resolved.file, env);
      const settings = this.deps.readSettings();
      const wt = (trusted && trusted.taskWorktree) || (this.resolveTaskWorktreeSync(opts) || {}).taskWorktree;
      const cwd = agentRunner.resolveCwd(
        opts,
        this.deps.getWorkspaceRoot(),
        resolved.isAgent,
        settings.departmentDirs,
        null,
        resolved.isAgent ? wt : undefined,
      );
      return await opencodeModelGate.preflight({
        descriptor,
        model,
        bin,
        env,
        cwd,
        settings,
        t: this.deps.appI18n.t,
        locale: this.deps.appI18n.getLocale(),
        label: (engineInstall.installInfo(command) || {}).label || command,
      });
    } catch (e) {
      this.deps.logLine(`model gate ön-uçuş atlandı (senkron yol ölçecek): ${e && e.message}`);
      return null;
    }
  }

  liveIsolationFiles() {
    const out = [];
    for (const entry of this.deps.ptys.values()) {
      if (entry && typeof entry.isolationFile === 'string' && entry.isolationFile) out.push(entry.isolationFile);
    }
    return out;
  }

  livePanesForClaim() {
    const rows = [];
    for (const [paneId, entry] of this.deps.ptys) {
      rows.push({
        paneId,
        agentId: entry.agentId ?? null,
        label: entry.label ?? null,
        stalled: entry.stalled === true,
      });
    }
    return rows;
  }

  findLivePaneForAgent(agentId) {
    if (!agentId) return null;
    for (const [paneId, entry] of this.deps.ptys) {
      if (entry.agentId === agentId) return { paneId, entry };
    }
    return null;
  }

  dedupeSpawnForAgent(opts, why) {
    const agentId = typeof opts?.agentId === 'string' ? opts.agentId.trim() : '';
    if (!agentId) return null;

    const claim = taskClaim.decideSpawn(this.livePanesForClaim(), opts);
    if (claim.action === 'reuse') {
      const reuse = handleClaimReuse(claim, this.deps.ptys, why, this.deps.logLine, agentId);
      if (reuse) return reuse;
    } else if (claim.code && claim.paneId) {
      this.deps.logLine(`pty:spawn görev kapısı GEÇİRDİ (${why}) agentId=${agentId} — ${claim.why}`);
    }

    if (opts?.forceFresh === true) {
      const twin = this.findLivePaneForAgent(agentId);
      return twin ? handleForceFresh(twin, opts, why, this.deps.logLine, agentId) : null;
    }

    const existing = this.findLivePaneForAgent(agentId);
    if (!existing) return null;
    this.deps.logLine(
      `pty:spawn DEDUPED (${why}) agentId=${agentId} → reusing existing paneId=${existing.paneId} `
        + '(would have opened a duplicate; caller did not set forceFresh)',
    );
    return buildReusePayload(existing.paneId, existing.entry);
  }
}

function createPtyIsolationService(deps) {
  return new PtyIsolationService(deps);
}

module.exports = {
  createPtyIsolationService,
  PtyIsolationService,
};
