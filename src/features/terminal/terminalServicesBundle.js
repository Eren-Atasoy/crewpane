'use strict';

const paneSessionAnchor = require('../../terminal/paneSessionAnchor.cjs');
const paneBudgetStore = require('../../terminal/paneBudgetStore.cjs');
const paneControl = require('../../terminal/paneControl.cjs');
const paneKill = require('../../terminal/paneKill.cjs');
const paneViewState = require('../../terminal/paneViewState.cjs');
const paneDraft = require('../../terminal/paneDraft.cjs');
const paneAskMod = require('../../terminal/paneAsk.cjs');
const dispatchPolicy = require('../../agents/dispatchPolicy.cjs');
const tokenUsage = require('../../services/tokenUsage.cjs');
const tokenCost = require('../../services/tokenCost.cjs');
const spendGuard = require('../../security/spendGuard.cjs');
const leaderRefreshPolicy = require('../../agents/leaderRefreshPolicy.cjs');
const leaderRole = require('../../agents/leaderRole.cjs');
const leaderComposer = require('../../agents/leaderComposer.cjs');
const transcriptProbe = require('../../services/transcriptProbe.cjs');
const codexRolloutProbe = require('../../mcp/codexRolloutProbe.cjs');
const livePaneRegistry = require('../../agents/livePaneRegistry.cjs');
const teamScope = require('../../agents/teamScope.cjs');
const taskCodeMod = require('../../agents/taskCode.cjs');
const mcpProcess = require('../../mcp/mcpProcess.cjs');
const { createDeliverPrompt } = require('../../agents/deliverPrompt.cjs');
const agentxDeliverMod = require('../../agents/agentxDeliver.cjs');
const delegationBridgeMod = require('../../agents/delegationBridge.js');
const engineRegistry = require('../../agents/engineRegistry.cjs');

const { createPaneRestoreService } = require('./paneRestoreService');
const { createPtyResumeService } = require('./ptyResumeService');
const { createPtyIsolationService } = require('./ptyIsolationService');
const { createPtySpawnService } = require('./ptySpawnService');
const { createPaneControlService } = require('./paneControlService');
const { createPaneDispatchService, REFRESH_SUBMIT_GAP_MS } = require('./paneDispatchService');
const { createPaneQueryService } = require('./paneQueryService');
const { createPaneAskService, PANE_ASK_MIRROR_MAX } = require('./paneAskService');
const { createPaneTranscriptService } = require('./paneTranscriptService');
const { createPaneBudgetService } = require('./paneBudgetService');

function _createTranscriptBudgetControlServices(deps, ptys) {
  let ptyResumeServiceRef = null;

  const paneTranscriptService = createPaneTranscriptService({
    ptys,
    paneSessionAnchor,
    transcriptProbe,
    codexRolloutProbe,
    livePaneRegistry,
    crewpaneHome: () => deps.crewpaneHome(),
    logLine: (line) => deps.logLine(line),
  });

  const paneBudgetService = createPaneBudgetService({
    ptys,
    currentSessionId: (id) => paneTranscriptService.currentSessionId(id),
    paneBudgetStore,
    tokenUsage,
    spendGuard,
    getAppWindow: () => deps.getAppWindow(),
    logLine: (line) => deps.logLine(line),
  });

  const paneControlService = createPaneControlService({
    ptys,
    getAppWindow: () => deps.getAppWindow(),
    crewpaneHome: () => deps.crewpaneHome(),
    logLine: (line) => deps.logLine(line),
    getPtyResumeService: () => ptyResumeServiceRef,
    getJarvisConv: () => (typeof deps.getJarvisConv === 'function' ? deps.getJarvisConv() : null),
    appVersion: () => deps.appVersion(),
    isQuitting: () => Boolean(deps.isQuitting()),
    engineRegistry,
    livePaneRegistry,
    paneControl,
    paneKill,
    agentRunner: deps.agentRunner,
    teamScope,
    agentSettings: deps.agentSettings,
  });

  return {
    paneTranscriptService,
    paneBudgetService,
    paneControlService,
    setPtyResumeServiceRef: (s) => { ptyResumeServiceRef = s; },
    getPtyResumeServiceRef: () => ptyResumeServiceRef,
  };
}

function _createIsolationQueryDispatchAskServices(deps, ptys, baseServices) {
  const ptyIsolationService = createPtyIsolationService({
    ptys,
    crewpaneHome: () => deps.crewpaneHome(),
    logLine: (line) => deps.logLine(line),
    getWorkspaceRoot: () => deps.getAgentWorkspaceRoot(),
    readSettings: () => deps.readSettings(),
    appI18n: { t: (k) => deps.appI18n.t(k), getLocale: () => deps.appI18n.getLocale() },
  });

  const paneQueryService = createPaneQueryService({
    ptys,
    agentRunner: deps.agentRunner,
    taskCodeMod,
    mcpProcess,
    paneKill,
    livePaneRegistry,
    crewpaneHome: () => deps.crewpaneHome(),
    getPtyResumeService: () => baseServices.getPtyResumeServiceRef(),
    paneViewState,
    paneDraft,
    paneBudgetStore,
    logLine: (line) => deps.logLine(line),
    isQuitting: () => Boolean(deps.isQuitting()),
    isAutotest: () => deps.isAutotest(),
  });

  const paneDispatchService = createPaneDispatchService({
    ptys,
    tokenUsage,
    tokenCost,
    dispatchPolicy,
    currentSessionId: (paneId) => baseServices.paneTranscriptService.currentSessionId(paneId),
    logLine: (line) => deps.logLine(line),
    enforcePaneBudget: (opts) => baseServices.paneBudgetService.enforcePaneBudget(opts),
    spendGuard,
    leaderRefreshPolicy,
    leaderRole,
    agentSettings: deps.agentSettings,
    delegationSupervisorService: typeof deps.delegationSupervisorService === 'function' ? deps.delegationSupervisorService() : null,
    leaderComposer,
    transcriptProbe,
    secretRedactor: typeof deps.secretRedactor === 'function' ? deps.secretRedactor() : null,
    getAppWindow: () => deps.getAppWindow(),
    createDeliverPrompt,
    agentxDeliverMod,
    authorizeTeamScope: (opts) => baseServices.paneControlService.authorizeTeamScope(opts),
    jarvisWidgetAlive: () => (typeof deps.jarvisWidgetAlive === 'function' ? deps.jarvisWidgetAlive() : false),
    labelTaskCodeOf: (label) => paneQueryService.labelTaskCodeOf(label),
    sessionAnchor: baseServices.paneTranscriptService.sessionAnchor,
  });

  const paneAskService = createPaneAskService({
    paneAskMod,
    cleanPaneTail: (buf, max) => delegationBridgeMod.cleanPaneTail(buf, max),
    BrowserWindow: deps.BrowserWindow,
    ptys,
    deliverToPane: (p, t, o) => paneDispatchService.deliverToPane(p, t, o),
    getJarvisConv: () => (typeof deps.getJarvisConv === 'function' ? deps.getJarvisConv() : null),
    appI18n: deps.appI18n,
    logLine: deps.logLine,
    submitGapMs: REFRESH_SUBMIT_GAP_MS,
    mirrorMax: PANE_ASK_MIRROR_MAX,
  });

  return {
    ptyIsolationService,
    paneQueryService,
    paneDispatchService,
    paneAskService,
  };
}

function _createSpawnRestoreResumeServices(deps, ptys, baseServices, midServices) {
  let ptySpawnServiceRef = null;
  let paneRestoreServiceRef = null;

  const ptySpawnService = createPtySpawnService({
    ptys,
    getAppWindow: () => deps.getAppWindow(),
    crewpaneHome: () => deps.crewpaneHome(),
    logLine: (line) => deps.logLine(line),
    getWorkspaceRoot: () => deps.getAgentWorkspaceRoot(),
    readSettings: () => deps.readSettings(),
    appI18n: { t: (k) => deps.appI18n.t(k), getLocale: () => deps.appI18n.getLocale() },
    planDenial: (feature, current, opts) => (deps.planLimitService ? deps.planLimitService().planDenial(feature, current, opts) : null),
    dedupeSpawnForAgent: (opts, why) => midServices.ptyIsolationService.dedupeSpawnForAgent(opts, why),
    resolveTaskWorktreeSync: (opts) => midServices.ptyIsolationService.resolveTaskWorktreeSync(opts),
    liveIsolationFiles: () => midServices.ptyIsolationService.liveIsolationFiles(),
    integrationResolverOrNull: () => (deps.integrationService ? deps.integrationService().integrationResolverOrNull() : null),
    codeIndexResolverOrNull: () => (deps.codeIndexService ? deps.codeIndexService().codeIndexResolverOrNull() : null),
    getDelegationBridge: () => (typeof deps.getDelegationBridge === 'function' ? deps.getDelegationBridge() : null),
    publicSupabaseEnv: () => (typeof deps.publicSupabaseEnv === 'function' ? deps.publicSupabaseEnv() : {}),
    engineKeyStore: () => (deps.integrationService ? deps.integrationService().engineKeyStore() : null),
    reportModuleFault: (fault) => (typeof deps.reportModuleFault === 'function' ? deps.reportModuleFault(fault) : null),
    settleMemoryUsage: (opts) => (deps.memoryService ? deps.memoryService().settleMemoryUsage(opts) : null),
    scheduleSupervisorSweep: (delayMs) => (deps.delegationSupervisorService ? deps.delegationSupervisorService().scheduleSupervisorSweep(delayMs) : null),
    sendPaneEvent: (win, paneId, channel, payload) => (typeof deps.sendPaneEvent === 'function' ? deps.sendPaneEvent(win, paneId, channel, payload) : null),
    sessionAnchor: { forget: (id) => baseServices.paneTranscriptService.sessionAnchor.forget(id) },
    dispatchStore: { clear: (id) => midServices.paneDispatchService.dispatchStore.clear(id) },
    dispatchApplied: { delete: (id) => midServices.paneDispatchService.dispatchApplied.delete(id) },
    leaderRefreshState: { delete: (id) => (midServices.paneDispatchService && midServices.paneDispatchService.leaderRefreshState ? midServices.paneDispatchService.leaderRefreshState.delete(id) : undefined) },
    invalidateGitBranchCache: (dir) => (typeof deps.invalidateGitBranchCache === 'function' ? deps.invalidateGitBranchCache(dir) : null),
    isQuitting: () => Boolean(deps.isQuitting()),
    isAutotest: () => deps.isAutotest(),
    isRestoreDisabled: () => deps.isRestoreDisabled(),
    hasMobileSubscribers: () => (typeof deps.hasMobileSubscribers === 'function' ? deps.hasMobileSubscribers() : false),
    emitMobileEvent: (evt) => (typeof deps.emitMobileEvent === 'function' ? deps.emitMobileEvent(evt) : null),
    getPaneAskRuntime: () => midServices.paneAskService.runtime,
  });
  ptySpawnServiceRef = ptySpawnService;

  const paneRestoreService = createPaneRestoreService({
    crewpaneHome: () => deps.crewpaneHome(),
    logLine: (line) => deps.logLine(line),
    reportModuleFault: (fault) => (typeof deps.reportModuleFault === 'function' ? deps.reportModuleFault(fault) : null),
    planDenial: (feature, current, opts) => (deps.planLimitService ? deps.planLimitService().planDenial(feature, current, opts) : null),
    spawnPty: (win, opts) => ptySpawnServiceRef.spawnPty(win, opts),
    getAppWindow: () => deps.getAppWindow(),
    ptys,
    isRestoreDisabled: () => deps.isRestoreDisabled(),
    isAppProbe: () => deps.isAppProbe(),
    getMode: () => deps.getMode(),
  });
  paneRestoreServiceRef = paneRestoreService;

  const ptyResumeService = createPtyResumeService({
    ptys,
    getAppWindow: () => deps.getAppWindow(),
    crewpaneHome: () => deps.crewpaneHome(),
    logLine: (line) => deps.logLine(line),
    enforcePaneBudget: (opts) => baseServices.paneBudgetService.enforcePaneBudget(opts),
    respawnOptsFromEntry: (entry, ctx) => paneRestoreServiceRef.respawnOptsFromEntry(entry, ctx),
    paneEngineResolver: paneRestoreServiceRef.paneEngineResolver,
    spawnPty: (win, opts) => ptySpawnServiceRef.spawnPty(win, opts),
    killPane: (id, entry, aid, reason) => baseServices.paneControlService.killPane(id, entry, aid, reason),
    isAutoresumeDisabled: () => deps.isAutoresumeDisabled(),
    isAppProbe: () => deps.isAppProbe(),
    getMode: () => deps.getMode(),
    limitResume02: deps.limitResume02,
    probeClaudeCliVersion: () => (typeof deps.probeClaudeCliVersion === 'function' ? deps.probeClaudeCliVersion() : null),
    getClaudeCliVersionCache: () => (typeof deps.getClaudeCliVersionCache === 'function' ? deps.getClaudeCliVersionCache() : null),
    getAgentWorkspaceRoot: () => deps.getAgentWorkspaceRoot(),
    isPackaged: () => deps.isPackaged(),
    repoRoot: deps.repoRoot,
    getDepartmentDirs: () => (typeof deps.getDepartmentDirs === 'function' ? deps.getDepartmentDirs() : []),
  });

  baseServices.setPtyResumeServiceRef(ptyResumeService);

  return {
    ptySpawnService,
    paneRestoreService,
    ptyResumeService,
  };
}

/**
 * Terminal Services Domain Bundle (Phase 3.6.61)
 * Encapsulates the 10 terminal, pty execution, and ask services and manages shared ptys registry.
 */
function createTerminalServicesBundle(deps = {}) {
  const ptys = deps.ptys || new Map();
  const baseServices = _createTranscriptBudgetControlServices(deps, ptys);
  const midServices = _createIsolationQueryDispatchAskServices(deps, ptys, baseServices);
  const spawnServices = _createSpawnRestoreResumeServices(deps, ptys, baseServices, midServices);

  return {
    ptys,
    paneTranscriptService: baseServices.paneTranscriptService,
    paneBudgetService: baseServices.paneBudgetService,
    paneControlService: baseServices.paneControlService,
    ptyIsolationService: midServices.ptyIsolationService,
    paneQueryService: midServices.paneQueryService,
    paneDispatchService: midServices.paneDispatchService,
    paneAskService: midServices.paneAskService,
    paneAskRuntime: midServices.paneAskService.runtime,
    ptySpawnService: spawnServices.ptySpawnService,
    paneRestoreService: spawnServices.paneRestoreService,
    ptyResumeService: spawnServices.ptyResumeService,
  };
}

module.exports = {
  createTerminalServicesBundle,
};
