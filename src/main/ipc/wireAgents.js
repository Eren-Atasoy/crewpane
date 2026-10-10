'use strict';

const {
  registerSkillsIpc,
  registerAgentxIpc,
  registerAgentxDraftIpc,
  registerDelegationIpc,
  registerTeamComposeIpc,
  registerTeamScopeIpc,
  registerJevIpc,
} = require('../../features/agents');
const { registerPtyIpc, registerPanesIpc } = require('../../features/terminal');
const { registerVoiceIpc } = require('../../features/voice');
const { registerMemoryIpc } = require('../../features/memory');
const { registerHandIpc } = require('../../features/hand');
const { registerSyncIpc } = require('../../features/sync');
const { registerMobileIpc } = require('../../features/mobile');

/**
 * Wires Agents, Terminal, Voice, Hand, Memory, Sync, and Mobile IPC handlers.
 * (Faz 3.6.4 — Wire IPC Modularization)
 */
function wireAgentsIpc(deps) {
  const {
    ipcMain,
    app,
    screen,
    BrowserWindow,
    ptys,
    agentSettings,
    crewpaneHome,
    logLine,
    REPO_ROOT,
    appI18n,
    getWorkspaceRoot,
    supervisorFor,
  } = deps;

  // Memory IPC
  registerMemoryIpc({
    ipcMain,
    memoryGraph: deps.memoryGraph,
    getAgentWorkspaceRoot: getWorkspaceRoot,
    memoryIndexer: deps.memoryIndexer,
    memorySearcher: deps.memorySearcher,
    agentSettings,
    memoryEmbedder: deps.memoryEmbedder,
    REPO_ROOT,
    memoryEmbedInstall: deps.memoryEmbedInstall,
    memoryEmbedInstaller: deps.memoryEmbedInstaller,
    memoryRecall: deps.memoryRecall,
    secretRedactor: deps.secretRedactor,
    ptys,
    agentRunner: deps.agentRunner,
    memoryTaskBlock: deps.memoryTaskBlock,
    currentSessionId: deps.currentSessionId,
    paneContextScope: deps.paneContextScope,
    engineMemoryScope: deps.engineMemoryScope,
    searchIndexer: deps.searchIndexer,
    logLine,
  });

  // Hand Control IPC
  registerHandIpc({
    ipcMain,
    screen,
    BrowserWindow,
    getHandOverlayWindows: deps.getHandOverlayWindows,
    getHandOverlayPrefs: deps.getHandOverlayPrefs,
    handOverlayAnyAlive: deps.handOverlayAnyAlive,
    closeHandOverlayWindows: deps.closeHandOverlayWindows,
    feedHandOverlay: deps.feedHandOverlay,
    getWindowManager: deps.getWindowManager,
    getHandControl: deps.getHandControl,
    startHandControl: deps.startHandControl,
    stopHandControl: deps.stopHandControl,
    handControlStatus: deps.handControlStatus,
    handControlLive: deps.handControlLive,
    finishPoseSampler: deps.finishPoseSampler,
    selectHandCamera: deps.selectHandCamera,
    onHandDetectFrame: deps.onHandDetectFrame,
    handDetectAlive: deps.handDetectAlive,
    broadcastHandControlStatus: deps.broadcastHandControlStatus,
    handCameraPolicy: deps.handCameraPolicy,
    handHardwareCameras: deps.handHardwareCameras,
    handCameraPreference: deps.handCameraPreference,
    logLine,
  });

  // Sync IPC
  registerSyncIpc({
    ipcMain,
    getSyncRuntime: deps.getSyncRuntime,
    getSyncIpcSurface: deps.getSyncIpcSurface,
  });

  // Mobile IPC
  registerMobileIpc({
    ipcMain,
    mobilePending: deps.mobilePending,
    mobileCommandPending: deps.mobileCommandPending,
    emitMobileEvent: deps.emitMobileEvent,
    getMobileGateway: deps.getMobileGateway,
    mobileDeviceStore: deps.mobileDeviceStore,
    mobilePlanDenial: deps.mobilePlanDenial,
    startMobile: deps.startMobile,
    getMobileGatewayLastFailure: deps.getMobileGatewayLastFailure,
    mobileStartFailure: deps.mobileStartFailure,
    mobileKillSwitch: deps.mobileKillSwitch,
    mobileProbe: deps.mobileProbe,
  });

  // PTY Terminal IPC
  registerPtyIpc({
    ipcMain,
    BrowserWindow,
    requireSeatOrThrow: deps.requireSeatOrThrow,
    dedupeSpawnForAgent: deps.dedupeSpawnForAgent,
    planDenial: deps.planDenial,
    ptys,
    resourceGovernor: deps.resourceGovernor,
    engineDelegation: deps.engineDelegation,
    prepareTaskIsolation: deps.prepareTaskIsolation,
    preflightModelGate: deps.preflightModelGate,
    spawnPty: deps.spawnPty,
    analyticsEngineOf: deps.analyticsEngineOf,
    telemetryBump: deps.telemetryBump,
    workspaceOnboarding: deps.workspaceOnboarding,
    enforcePaneBudget: deps.enforcePaneBudget,
    spendGuard: deps.spendGuard,
    leaderComposer: deps.leaderComposer,
    probeTranscriptContains: deps.probeTranscriptContains,
    transcriptProbe: deps.transcriptProbe,
    currentSessionId: deps.currentSessionId,
    secretRedactor: deps.secretRedactor,
    mobileTranscript: deps.mobileTranscript,
    tokenUsage: deps.tokenUsage,
    paneTokenBudget: deps.paneTokenBudget,
    getWorkspaceRoot,
    paneBudgetStore: deps.paneBudgetStore,
    paneDispatchDecisionFor: deps.paneDispatchDecisionFor,
    leaderRefreshTick: deps.leaderRefreshTick,
    leaderRefreshViewFor: deps.leaderRefreshViewFor,
    logDispatchDecision: deps.logDispatchDecision,
    refreshPaneSession: deps.refreshPaneSession,
    dispatchStore: deps.dispatchStore,
    getAppWindow: deps.getAppWindow,
    popoutPaneIdForWindow: deps.popoutPaneIdForWindow,
    listPanes: deps.listPanes,
    agentRunner: deps.agentRunner,
    modelDetect: deps.modelDetect,
    paneAskRuntime: deps.paneAskRuntime,
    paneSessionAnchor: deps.paneSessionAnchor,
    sessionAnchor: deps.sessionAnchor,
    ptyResizeGate: deps.ptyResizeGate,
    killPaneExplicitAndCleanup: deps.killPaneExplicitAndCleanup,
    logLine,
  });

  // Panes IPC
  registerPanesIpc({
    ipcMain,
    BrowserWindow,
    acceptRecoverablePanes: deps.acceptRecoverablePanes,
    tmuxWindows: deps.tmuxWindows,
    paneViewState: deps.paneViewState,
    broadcastPaneView: deps.broadcastPaneView,
    paneDraft: deps.paneDraft,
    broadcastPaneDraft: deps.broadcastPaneDraft,
    getPaneAskRuntime: deps.getPaneAskRuntime,
    logLine,
  });

  // Voice & Jarvis IPC
  registerVoiceIpc({
    ipcMain,
    app,
    BrowserWindow,
    getAppWindow: deps.getAppWindow,
    openJarvisWidgetWindow: deps.openJarvisWidgetWindow,
    closeJarvisWidgetWindow: deps.closeJarvisWidgetWindow,
    jarvisWidgetAlive: deps.jarvisWidgetAlive,
    windowManager: deps.windowManager,
    jarvisWidget: deps.jarvisWidget,
    broadcastJarvisWidget: deps.broadcastJarvisWidget,
    jarvisWidgetPayload: deps.jarvisWidgetPayload,
    moveJarvisWidget: deps.moveJarvisWidget,
    showAppFromJarvisWidget: deps.showAppFromJarvisWidget,
    agentSettings,
    jarvisVoice: deps.jarvisVoice,
    REPO_ROOT,
    appI18n,
    grokVoice: deps.grokVoice,
    inputSim: deps.inputSim,
    screenCaptureMod: deps.screenCaptureMod,
    instancePaths: deps.instancePaths,
    getJarvisConv: deps.getJarvisConv,
    logLine,
  });

  // Agent X IPC
  registerAgentxIpc({
    ipcMain,
    BrowserWindow,
    screen,
    agentxDeliverer: deps.agentxDeliverer,
    agentxBeamMod: deps.agentxBeamMod,
    getAppWindow: deps.getAppWindow,
    jarvisWidgetAlive: deps.jarvisWidgetAlive,
    logLine,
  });

  registerAgentxDraftIpc({
    ipcMain,
    agentxDraft: deps.agentxDraft,
    broadcastAgentxDraft: deps.broadcastAgentxDraft,
    broadcastAgentxDraftConfirmed: deps.broadcastAgentxDraftConfirmed,
  });

  // Skills IPC
  registerSkillsIpc({
    ipcMain,
    app,
    skillCenter: deps.skillCenter,
    skillEngineSync: deps.skillEngineSync,
    skillApprove: deps.skillApprove,
    skillAuthor: deps.skillAuthor,
    skillVersions: deps.skillVersions,
    skillShare: deps.skillShare,
    builtinSkills: deps.builtinSkills,
    skillGuard: deps.skillGuard,
    skillEngineView: deps.skillEngineView,
    getWorkspaceRoot,
    getBoundAccount: deps.getBoundAccount,
    syncSkillEngineViews: deps.syncSkillEngineViews,
    logLine,
  });

  // Delegation IPC
  registerDelegationIpc({
    ipcMain,
    delegationQueueStore: deps.delegationQueueStore,
    delegationSupervisorStore: deps.delegationSupervisorStore,
    resumeQueueStore: deps.resumeQueueStore,
    queueBoard: deps.queueBoard,
    evidencePathMod: deps.evidencePathMod,
    supervisorFor,
    ensureDelegationSupervisor: deps.ensureDelegationSupervisor,
    scheduleSupervisorSweep: deps.scheduleSupervisorSweep,
    supervisorPending: deps.supervisorPending,
    supervisorFingerprint: deps.supervisorFingerprint,
    ptys,
    crewpaneHome,
    getWorkspaceRoot,
    agentSettings,
    REPO_ROOT,
    activeWorktreePaths: deps.activeWorktreePaths,
    logLine,
  });

  // Team Compose & Scope IPC
  registerTeamComposeIpc({
    ipcMain,
    ensureComposeLedger: deps.ensureComposeLedger,
    teamComposeCore: deps.teamComposeCore,
    getComposeTransport: deps.getComposeTransport,
    teamComposeRequest: deps.teamComposeRequest,
    composeFail: deps.composeFail,
    composeAutonomy: deps.composeAutonomy,
    ptys,
    sampleLeaderGate: deps.sampleLeaderGate,
    deliverToPane: deps.deliverToPane,
    dispatchSleep: deps.dispatchSleep,
    logLine,
  });

  registerTeamScopeIpc({
    ipcMain,
    authorizeTeamScopeInteractive: deps.authorizeTeamScopeInteractive,
    logLine,
  });

  // Jev AI IPC (Faz 3)
  registerJevIpc({
    ipcMain,
    agentSettings,
    engineAuth: deps.engineAuth,
    outcomeLedger: deps.outcomeLedger,
    logLine,
  });
}

module.exports = {
  wireAgentsIpc,
};
