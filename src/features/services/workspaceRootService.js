'use strict';

/**
 * Workspace Root & Switch Service (Faz 3.6.38)
 * Encapsulates activeRoots, grandfatheredRoots, workspace validation & switching,
 * broadcast events, account bind re-resolution, and builtin skill/engine synchronization.
 */

const { BrowserWindow: ElectronBrowserWindow, app: electronApp } = require('electron');
const defaultWorkspaceOnboarding = require('../../agents/workspaceOnboarding.cjs');
const defaultWorkspaceSwitch = require('../../agents/workspaceSwitch.cjs');
const defaultAgentSettings = require('../../agents/agentSettings.cjs');
const defaultBuiltinSkills = require('../../agents/builtinSkills.cjs');
const defaultSkillEngineSync = require('../../agents/skillEngineSync.cjs');
const { invalidateGitBranchCache: defaultInvalidateGitBranchCache } = require('../../shared/utils');

const defaultDeps = {
  app: electronApp,
  BrowserWindow: ElectronBrowserWindow,
  workspaceOnboarding: defaultWorkspaceOnboarding,
  workspaceSwitch: defaultWorkspaceSwitch,
  agentSettings: defaultAgentSettings,
  builtinSkills: defaultBuiltinSkills,
  skillEngineSync: defaultSkillEngineSync,
  invalidateGitBranchCache: defaultInvalidateGitBranchCache,
  getAgentWorkspaceRoot: () => null,
  setAgentWorkspaceRoot: () => {},
  workspacePlanDenial: () => null,
  rememberWorkspaceRoot: () => {},
  logLine: () => {},
  repoRoot: '',
  forceFirstRun: false,
};

class WorkspaceRootService {
  constructor(deps = {}) {
    this.deps = deps;
    Object.assign(this, defaultDeps, deps);

    const initialRoot = this.getAgentWorkspaceRoot();
    this.activeRoots = deps.activeRoots || new Set(initialRoot ? [initialRoot] : []);
    this.grandfatheredRoots = deps.grandfatheredRoots || new Set();
  }

  validateWorkspacePlan(rawRoot, customLog) {
    const log = customLog || this.logLine;
    const planGate = this.workspacePlanDenial(rawRoot);
    if (!planGate) return null;
    log(`workspace:switch REDDEDİLDİ (plan): ${rawRoot} — ${planGate.tier} tavan=${planGate.limit}`);
    return {
      ok: false,
      reason: 'plan_limit',
      error: planGate.message,
      title: planGate.title,
      limit: planGate.limit,
      current: planGate.current,
      tier: planGate.tier,
      requiredTier: planGate.requiredTier,
      action: 'upgrade',
    };
  }

  broadcastWorkspaceSwitch(resRoot, previous, grandfathered = this.grandfatheredRoots) {
    const windows = this.BrowserWindow ? this.BrowserWindow.getAllWindows() : [];
    for (const w of windows) {
      try { w._attachReportsWatcher?.(); } catch { /* window tearing down */ }
    }
    for (const w of windows) {
      try {
        if (!w.isDestroyed()) {
          w.webContents.send('workspace:changed', {
            root: resRoot,
            previous: previous ?? null,
            grandfathered: [...grandfathered],
            at: Date.now(),
          });
        }
      } catch { /* best-effort */ }
    }
  }

  switchWorkspaceRoot(rawRoot) {
    const forbiddenPrefix = this.app && this.app.isPackaged ? process.resourcesPath : null;
    const planGate = this.validateWorkspacePlan(rawRoot, this.logLine);
    if (planGate) return planGate;

    const res = this.workspaceOnboarding.commitWorkspaceRoot(rawRoot, { forbiddenPrefix });
    if (!res.ok) {
      this.logLine(`workspace:switch REJECT ${rawRoot} → ${res.reason}`);
      return res;
    }
    this.rememberWorkspaceRoot(res.root);
    if (res.persisted === false) {
      this.logLine(`workspace:switch ${res.root} — DİSKE YAZILAMADI (${res.persistError}); seçim yalnız bu oturumda geçerli`);
    }
    const transition = this.workspaceSwitch.applyWorkspaceSwitch({
      current: this.getAgentWorkspaceRoot(),
      activeRoots: this.activeRoots,
      grandfathered: this.grandfatheredRoots,
      next: res.root,
    });
    const previous = transition.previous;
    if (!transition.changed) {
      this.logLine(`workspace:switch no-op (already ${res.root})`);
      return { ok: true, root: res.root, previous, changed: false, persisted: res.persisted !== false, persistError: res.persistError ?? null };
    }
    this.setAgentWorkspaceRoot(transition.current);
    this.seedBuiltinSkills('workspace-switch');
    this.syncSkillEngineViews('workspace-switch');
    this.invalidateGitBranchCache();
    this.broadcastWorkspaceSwitch(res.root, previous, this.grandfatheredRoots);
    this.logLine(`workspace:switch ${previous ?? '-'} → ${res.root} (grandfathered ${this.grandfatheredRoots.size})`);
    return {
      ok: true,
      root: res.root,
      previous: previous ?? null,
      changed: true,
      grandfathered: [...this.grandfatheredRoots],
      persisted: res.persisted !== false,
      persistError: res.persistError ?? null,
    };
  }

  reresolveWorkspaceRootAfterAccountBind() {
    const fallback = (this.app && this.app.isPackaged) || this.forceFirstRun ? null : this.repoRoot;
    const status = this.agentSettings.configuredWorkspaceRootStatus();
    const next = status.root || fallback;
    const currentRoot = this.getAgentWorkspaceRoot();
    if (!next || next === currentRoot) {
      if (!currentRoot && status.configured) {
        this.logLine(`workspace: seçili kök KULLANILAMIYOR (${status.reason}${status.code ? `/${status.code}` : ''}): ${status.configured}`);
      }
      return;
    }
    const transition = this.workspaceSwitch.applyWorkspaceSwitch({
      current: currentRoot,
      activeRoots: this.activeRoots,
      grandfathered: this.grandfatheredRoots,
      next,
    });
    if (!transition.changed) return;
    this.setAgentWorkspaceRoot(transition.current);
    this.invalidateGitBranchCache();
    this.logLine(`workspace: hesap bağlandıktan sonra yeniden çözüldü → ${this.getAgentWorkspaceRoot()} (kaynak=${status.source})`);
  }

  seedBuiltinSkills(reason) {
    try {
      return this.builtinSkills.ensureInstalled({
        workspaceRoot: this.getAgentWorkspaceRoot(),
        reviewedBy: 'builtin-catalog',
        log: (line) => this.logLine(`builtin-skills[${reason}] ${line.replace(/^builtin-skills /, '')}`),
      });
    } catch (err) {
      this.logLine(`builtin-skills[${reason}] tetik hatası: ${err.message}`);
      return { ran: false, reason: 'error', error: err.message, installed: [], updated: [], preserved: [], pending: [], conflicts: [], failed: [] };
    }
  }

  syncSkillEngineViews(reason) {
    try {
      return this.skillEngineSync.syncEngineViews({
        workspaceRoot: this.getAgentWorkspaceRoot(),
        appVersion: this.app && this.app.getVersion ? this.app.getVersion() : '0.0.0',
        reason,
        log: (line) => this.logLine(line),
      });
    } catch (err) {
      this.logLine(`skill-views[${reason}] tetik hatası: ${err.message}`);
      return { ran: false, reason: 'error', error: err.message, report: null, summary: null };
    }
  }
}

function createWorkspaceRootService(deps) {
  return new WorkspaceRootService(deps);
}

module.exports = {
  createWorkspaceRootService,
  WorkspaceRootService,
};
