'use strict';

const path = require('path');
const resumePtyDaemon = require('../../terminal/resumePtyDaemon.cjs');
const instancePaths = require('../../config/instancePaths.cjs');
const engineProfiles = require('../../agents/engineProfiles.cjs');
const notifyPathMod = require('../../services/notifyPath.cjs');
const spendGuard = require('../../security/spendGuard.cjs');

const defaultDeps = {
  ptys: new Map(),
  getAppWindow: () => null,
  crewpaneHome: () => process.env.HOME || '',
  logLine: () => {},
  enforcePaneBudget: () => ({ allow: true }),
  respawnOptsFromEntry: () => ({}),
  paneEngineResolver: { drift: () => null },
  spawnPty: () => null,
  killPane: () => {},
  isAutoresumeDisabled: () => false,
  isAppProbe: () => false,
  getMode: () => '',
  limitResume02: false,
  probeClaudeCliVersion: () => {},
  getClaudeCliVersionCache: () => null,
  getAgentWorkspaceRoot: () => null,
  isPackaged: () => false,
  repoRoot: process.cwd(),
  getDepartmentDirs: () => ({}),
};

function resumeRetryDelaysFromEnv() {
  const delays = (process.env.CREWPANE_RESUME_RETRY_DELAYS_MS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0);
  return delays.length ? delays : undefined;
}

function handleWritePane(ptys, paneId, data) {
  const entry = ptys.get(paneId);
  if (!entry) return false;
  try {
    entry.child.write(data);
    return true;
  } catch {
    return false;
  }
}

function handleBudgetGate(paneId, enforcePaneBudget) {
  const guard = enforcePaneBudget({
    paneId,
    origin: spendGuard.SYSTEM_ORIGIN,
    source: 'resume-daemon',
  });
  return { allow: guard.allow, reason: guard.reason };
}

function handleClosePane(paneId, ptys, killPane) {
  const entry = ptys.get(paneId);
  if (!entry) return false;
  killPane(paneId, entry, entry.agentId, 'engine account switch (ADP-938)');
  return true;
}

function buildEngineAccounts(crewpaneInstanceHome) {
  return {
    home: crewpaneInstanceHome,
    enabled: () => engineProfiles.autoSwitchOnLimit(crewpaneInstanceHome),
    listProfiles: (engine) => engineProfiles.listProfiles(crewpaneInstanceHome, engine),
    activeProfile: (engine) => engineProfiles.activeProfileId(crewpaneInstanceHome, engine),
    setActive: (engine, profileId) =>
      engineProfiles.setActiveProfile(crewpaneInstanceHome, engine, profileId),
  };
}

function handleRespawnPane(entry, opts, ctx) {
  const targetWin = ctx.getAppWindow();
  if (!targetWin || targetWin.isDestroyed()) return null;
  try {
    const drifted = ctx.paneEngineResolver.drift(entry);
    const base = ctx.respawnOptsFromEntry(entry, { where: 'limit-daemon' });
    if (engineProfiles.isProfileId(opts && opts.engineProfileId)) {
      base.engineProfileId = opts.engineProfileId;
    }
    base.spawnIntent = 'replace';
    const res = ctx.spawnPty(targetWin, base);
    if (res && drifted) res.engineSwitched = drifted;
    return res;
  } catch (e) {
    const aid = entry && entry.agentId ? entry.agentId : '-';
    ctx.logLine(`pty-resume respawn failed agent=${aid}: ${e.message}`);
    return null;
  }
}

function shouldSkipDaemonStart(isAutoresumeDisabled, isAppProbe, getMode) {
  if (isAutoresumeDisabled()) return true;
  if (isAppProbe()) return true;
  return getMode() === 'spike';
}

class PtyResumeService {
  constructor(deps) {
    const d = Object.assign({}, defaultDeps, deps);
    this.ptys = d.ptys;
    this.getAppWindow = d.getAppWindow;
    this.crewpaneHome = d.crewpaneHome;
    this.logLine = d.logLine;
    this.enforcePaneBudget = d.enforcePaneBudget;
    this.respawnOptsFromEntry = d.respawnOptsFromEntry;
    this.paneEngineResolver = d.paneEngineResolver;
    this.spawnPty = d.spawnPty;
    this.killPane = d.killPane;
    this.isAutoresumeDisabled = d.isAutoresumeDisabled;
    this.isAppProbe = d.isAppProbe;
    this.getMode = d.getMode;
    this.limitResume02 = d.limitResume02;
    this.probeClaudeCliVersion = d.probeClaudeCliVersion;
    this.getClaudeCliVersionCache = d.getClaudeCliVersionCache;
    this.getAgentWorkspaceRoot = d.getAgentWorkspaceRoot;
    this.isPackaged = d.isPackaged;
    this.repoRoot = d.repoRoot;
    this.getDepartmentDirs = d.getDepartmentDirs;

    this.ptyResumeDaemon = null;
  }

  resolveWorkerNotifyPath(department) {
    const wsRoot = this.getAgentWorkspaceRoot() || (!this.isPackaged() ? this.repoRoot : null);
    return notifyPathMod.resolveNotifyPath({
      envOverride: process.env.CREWPANE_RESUME_NOTIFY,
      department,
      workspaceRoot: wsRoot,
      mapping: this.getDepartmentDirs(),
      log: this.logLine,
      instanceFallback: path.join(instancePaths.crewpaneHome(this.crewpaneHome()), 'resume-notifications.log'),
    });
  }

  resolveResumeNotifyPath() {
    return this.resolveWorkerNotifyPath(undefined);
  }

  startPtyResumeDaemonOnce() {
    if (this.ptyResumeDaemon) return;
    if (shouldSkipDaemonStart(this.isAutoresumeDisabled, this.isAppProbe, this.getMode)) return;

    if (this.limitResume02) this.probeClaudeCliVersion();

    const respawnCtx = {
      getAppWindow: this.getAppWindow,
      paneEngineResolver: this.paneEngineResolver,
      respawnOptsFromEntry: this.respawnOptsFromEntry,
      spawnPty: this.spawnPty,
      logLine: this.logLine,
    };

    try {
      this.ptyResumeDaemon = resumePtyDaemon.startPtyResumeDaemon({
        getPanes: () => this.ptys,
        limitResume02: this.limitResume02,
        claudeVersion: () => this.getClaudeCliVersionCache(),
        writePane: (paneId, data) => handleWritePane(this.ptys, paneId, data),
        budgetGate: (paneId) => handleBudgetGate(paneId, this.enforcePaneBudget),
        respawnPane: (entry, opts) => handleRespawnPane(entry, opts, respawnCtx),
        closePane: (paneId) => handleClosePane(paneId, this.ptys, this.killPane),
        engineAccounts: buildEngineAccounts(instancePaths.crewpaneHome()),
        homedir: this.crewpaneHome(),
        notifyLog: this.resolveResumeNotifyPath(),
        dryRun: process.env.CREWPANE_RESUME_DRYRUN === '1',
        pollMs: Number(process.env.CREWPANE_RESUME_POLL_MS) || undefined,
        verifyWindowMs: Number(process.env.CREWPANE_RESUME_VERIFY_MS) || undefined,
        resetBufferMs: Number(process.env.CREWPANE_RESUME_RESET_BUFFER_MS) || undefined,
        verifyMaxAttempts: Number(process.env.CREWPANE_RESUME_MAX_SEND_ATTEMPTS) || undefined,
        verifyRetryDelaysMs: resumeRetryDelaysFromEnv(),
        log: this.logLine,
        onEvent: (evt) => {
          const win = this.getAppWindow();
          if (win && !win.isDestroyed()) win.webContents.send('resume:event', evt);
        },
      });
    } catch (e) {
      this.logLine(`pty-resume daemon failed to start: ${e.message}`);
      this.ptyResumeDaemon = null;
    }
  }

  stop() {
    const daemon = this.ptyResumeDaemon;
    this.ptyResumeDaemon = null;
    if (daemon) {
      try {
        daemon.stop();
      } catch { /* best-effort */ }
    }
  }

  forgetPane(paneId) {
    if (this.ptyResumeDaemon) {
      try {
        this.ptyResumeDaemon.forgetPane(paneId);
      } catch { /* best-effort */ }
    }
  }

  getDaemon() {
    return this.ptyResumeDaemon;
  }
}

function createPtyResumeService(deps) {
  return new PtyResumeService(deps);
}

module.exports = {
  createPtyResumeService,
  PtyResumeService,
  resumeRetryDelaysFromEnv,
};
