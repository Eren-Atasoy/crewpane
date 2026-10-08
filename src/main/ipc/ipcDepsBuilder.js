'use strict';

const pkgMgr = require('../../agents/avatarPackageManager.cjs');
const officePkg = require('../../agents/officePackageManager.cjs');

/**
 * IPC Dependency Builder (Phase 3.6.45)
 * Assembles and structures domain dependencies for Services, Agents, and System IPC wiring.
 */

function _buildWindowOps(wm, ctx) {
  const ops = {
    createAppWindow: (url) => (wm ? wm.createAppWindow(url) : null),
    openPopoutWindow: (opts) => (wm ? wm.openPopoutWindow(opts) : null),
    closePopoutWindow: (paneId) => (wm ? wm.closePopoutWindow(paneId) : null),
    listPopoutPanes: () => (wm ? wm.listPopoutPanes() : []),
    popoutWindowFor: (paneId) => (wm ? wm.popoutWindowFor(paneId) : null),
    openDesignWindow: () => (wm ? wm.openDesignWindow() : null),
    closeDesignWindow: () => (wm ? wm.closeDesignWindow() : null),
    designWindowAlive: () => (wm ? wm.designWindowAlive() : false),
    popoutPaneIdForWindow: (win) => (wm ? wm.popoutPaneIdForWindow(win) : null),
  };
  const keys = Object.keys(ops);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (typeof ctx[k] === 'function') ops[k] = ctx[k];
  }
  return ops;
}

function buildPlatformAndWindowDeps(ctx) {
  const wm = ctx.windowManager;
  return {
    ipcMain: ctx.ipcMain,
    app: ctx.app,
    shell: ctx.shell,
    clipboard: ctx.clipboard,
    nativeImage: ctx.nativeImage,
    dialog: ctx.dialog,
    screen: ctx.screen,
    BrowserWindow: ctx.BrowserWindow,
    ptys: ctx.ptys,
    agentSettings: ctx.agentSettings,
    crewpaneHome: ctx.crewpaneHome,
    logLine: ctx.logLine,
    getAppWindow: ctx.getAppWindow || (() => ctx.appWindow),
    getAppBaseUrl: ctx.getAppBaseUrl || (() => ctx.appBaseUrl),
    ..._buildWindowOps(wm, ctx),
    windowManager: ctx.windowManager,
    getWindowManager: ctx.getWindowManager || (() => ctx.windowManager),
    keepPanesAliveOnWindowClose: ctx.keepPanesAliveOnWindowClose,
    crashWatchdog: ctx.crashWatchdog,
    getAppUrlScheme: ctx.getAppUrlScheme || (() => ctx.APP_URL_SCHEME),
    getAppUrlPrefix: ctx.getAppUrlPrefix || (() => ctx.APP_URL_PREFIX),
    mode: ctx.mode ?? ctx.MODE,
    relaunchApp: ctx.relaunchApp,
    rebuildAndRelaunch: ctx.rebuildAndRelaunch,
  };
}

function _buildWorkspaceFileOps(wsFiles, ctx) {
  const ops = {
    resolveInRoots: (p) => (wsFiles ? wsFiles.resolveInRoots(p) : p),
    displayPath: (abs) => (wsFiles ? wsFiles.displayPath(abs) : abs),
    readFeedbackSeen: () => (wsFiles ? wsFiles.readFeedbackSeen() : null),
    writeFeedbackSeen: (state) => (wsFiles ? wsFiles.writeFeedbackSeen(state) : null),
    readWorkspaceFile: (p) => (wsFiles ? wsFiles.readWorkspaceFile(p) : null),
    writeWorkspaceFile: (payload) => (wsFiles ? wsFiles.writeWorkspaceFile(payload) : null),
    listWorkspaceDir: (dir) => (wsFiles ? wsFiles.listWorkspaceDir(dir) : []),
    openFolderDialog: (win) => (wsFiles ? wsFiles.openFolderDialog(win) : null),
    allowPaneRoot: (paneId) => (wsFiles ? wsFiles.allowPaneRoot(paneId) : null),
    readEditorState: () => (wsFiles ? wsFiles.readEditorState() : null),
    writeEditorState: (state) => (wsFiles ? wsFiles.writeEditorState(state) : null),
    readOfficeState: () => (wsFiles ? wsFiles.readOfficeState() : null),
    writeOfficeState: (state) => (wsFiles ? wsFiles.writeOfficeState(state) : null),
    readGitBranch: (startDir) => (wsFiles ? wsFiles.readGitBranch(startDir) : ''),
    resolveSearchRoot: (p) => (wsFiles ? wsFiles.resolveSearchRoot(p) : p),
  };
  const keys = Object.keys(ops);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (typeof ctx[k] === 'function') ops[k] = ctx[k];
  }
  return ops;
}

function buildWorkspaceAndStorageDeps(ctx) {
  const wsFiles = ctx.workspaceFileService;
  const wsRoots = ctx.workspaceRootService;
  return {
    ..._buildWorkspaceFileOps(wsFiles, ctx),
    withinActiveRoots: ctx.withinActiveRoots || ((abs) => (wsRoots ? wsRoots.withinActiveRoots(abs) : true)),
    getAgentWorkspaceRoot: ctx.getAgentWorkspaceRoot || (() => ctx.agentWorkspaceRoot),
    getWorkspaceRoot: ctx.getWorkspaceRoot || (() => ctx.agentWorkspaceRoot),
    supervisorFor: ctx.supervisorFor,
    feedbackBridge: ctx.feedbackBridge,
    workspacePlanDenial: ctx.workspacePlanDenial,
    workspaceOnboarding: ctx.workspaceOnboarding,
    rememberWorkspaceRoot: ctx.rememberWorkspaceRoot,
    switchWorkspaceRoot: ctx.switchWorkspaceRoot || ((root) => (wsRoots ? wsRoots.switchWorkspaceRoot(root) : null)),
    worktreeStore: ctx.worktreeStore,
    projectRepos: ctx.projectRepos,
    agentWorkspaceRoot: ctx.agentWorkspaceRoot,
    mergeService: ctx.mergeService,
    worktreeService: ctx.worktreeService,
    activeWorktreePaths: ctx.activeWorktreePaths,
    REPO_ROOT: ctx.REPO_ROOT,
    codeIntel: ctx.codeIntel,
    gitBranchCache: ctx.gitBranchCache,
    GIT_BRANCH_TTL_MS: ctx.GIT_BRANCH_TTL_MS,
    branchName: ctx.branchName,
    codeIndexStore: ctx.codeIndexStore,
    codeIndexHealth: ctx.codeIndexHealth,
    codeIndexRepoPath: ctx.codeIndexRepoPath,
    codeIndexFreshness: ctx.codeIndexFreshness,
    codeIndexJobs: ctx.codeIndexJobs,
    invalidateGitBranchCache: ctx.invalidateGitBranchCache,
  };
}

function buildMediaAndMemoryDeps(ctx) {
  return {
    clipboardImageRoute: ctx.clipboardImageRoute,
    saveTempImage: ctx.saveTempImage,
    localSprites: ctx.localSprites,
    pkgMgr,
    officePkg,
    imageStore: ctx.mediaService ? ctx.mediaService.imageStore : ctx.imageStore,
    ingestTaskAttachment: ctx.ingestTaskAttachment,
    attachmentStore: ctx.attachmentStore,
    memoryGraph: ctx.memoryGraph,
    memoryIndexer: ctx.memoryIndexer,
    memorySearcher: ctx.memorySearcher,
    memoryEmbedder: ctx.memoryEmbedder,
    memoryEmbedInstall: ctx.memoryEmbedInstall,
    memoryEmbedInstaller: ctx.memoryEmbedInstaller,
    memoryRecall: ctx.memoryRecall,
    secretRedactor: ctx.secretRedactor,
    memoryTaskBlock: ctx.memoryTaskBlock,
    currentSessionId: ctx.currentSessionId,
    paneContextScope: ctx.paneContextScope,
    engineMemoryScope: ctx.engineMemoryScope,
    searchIndexer: ctx.searchIndexer || (() => (ctx.memoryService ? ctx.memoryService.searchIndexer() : null)),
    broadcastClipChanged: ctx.broadcastClipChanged || (() => (ctx.windowManager ? ctx.windowManager.broadcastClipChanged() : null)),
    clipboardHistoryCore: ctx.clipboardHistoryCore,
  };
}

function buildTerminalAndExecutionDeps(ctx) {
  const wm = ctx.windowManager;
  return {
    listPanes: ctx.listPanes,
    resourceGovernor: ctx.resourceGovernor,
    agentRunner: ctx.agentRunner,
    resourceGovernorModule: ctx.resourceGovernorModule,
    killPaneExplicitAndCleanup: ctx.killPaneExplicitAndCleanup,
    dedupeSpawnForAgent: ctx.dedupeSpawnForAgent,
    engineDelegation: ctx.engineDelegation,
    prepareTaskIsolation: ctx.prepareTaskIsolation,
    preflightModelGate: ctx.preflightModelGate,
    spawnPty: ctx.spawnPty,
    analyticsEngineOf: ctx.analyticsEngineOf,
    telemetryBump: ctx.telemetryBump,
    enforcePaneBudget: ctx.enforcePaneBudget,
    spendGuard: ctx.spendGuard,
    leaderComposer: ctx.leaderComposer,
    probeTranscriptContains: ctx.probeTranscriptContains,
    transcriptProbe: ctx.transcriptProbe,
    mobileTranscript: ctx.mobileTranscript,
    tokenUsage: ctx.tokenUsage,
    paneTokenBudget: ctx.paneTokenBudget,
    paneBudgetStore: ctx.paneBudgetStore,
    paneDispatchDecisionFor: ctx.paneDispatchDecisionFor,
    leaderRefreshTick: ctx.leaderRefreshTick,
    leaderRefreshViewFor: ctx.leaderRefreshViewFor,
    logDispatchDecision: ctx.logDispatchDecision,
    refreshPaneSession: ctx.refreshPaneSession,
    dispatchStore: ctx.dispatchStore,
    modelDetect: ctx.modelDetect,
    paneAskRuntime: ctx.paneAskRuntime,
    paneSessionAnchor: ctx.paneSessionAnchor,
    sessionAnchor: ctx.sessionAnchor,
    ptyResizeGate: ctx.ptyResizeGate,
    acceptRecoverablePanes: ctx.acceptRecoverablePanes,
    tmuxWindows: ctx.tmuxWindows,
    paneViewState: ctx.paneViewState,
    broadcastPaneView: ctx.broadcastPaneView || ((paneId, r) => (wm ? wm.broadcastPaneView(paneId, r) : null)),
    paneDraft: ctx.paneDraft,
    broadcastPaneDraft: ctx.broadcastPaneDraft || ((paneId, t) => (wm ? wm.broadcastPaneDraft(paneId, t) : null)),
    getPaneAskRuntime: ctx.getPaneAskRuntime || (() => ctx.paneAskRuntime),
    getPtys: ctx.getPtys || (() => ctx.ptys),
    deliverToPane: ctx.deliverToPane,
    dispatchSleep: ctx.dispatchSleep,
    authorizeTeamScopeInteractive: ctx.authorizeTeamScopeInteractive,
    runningPaneSummary: ctx.runningPaneSummary,
    closePanesForSignOut: ctx.closePanesForSignOut,
    resumePtyDaemon: ctx.resumePtyDaemon,
    livePaneRegistry: ctx.livePaneRegistry,
    killPane: ctx.killPane,
    respawnOptsFromEntry: ctx.respawnOptsFromEntry,
    agentEngineMirror: ctx.agentEngineMirror,
  };
}

function _buildUpdateAndAnnounceDeps(ctx) {
  const upd = ctx.updateService;
  const ann = ctx.announceService;
  return {
    announcements: ctx.announcements,
    announceStateForRenderer: () => (ann ? ann.announceStateForRenderer() : {}),
    runAnnounceCheck: (trigger) => (ann ? ann.runAnnounceCheck(trigger) : null),
    pushAnnounceState: () => (ann ? ann.pushAnnounceState() : null),
    announceHiddenThisSession: ann ? ann.announceHiddenThisSession : null,
    getAnnounceState: () => (ann ? ann.getAnnounceState() : null),
    updateStateForRenderer: () => (upd ? upd.updateStateForRenderer() : {}),
    runUpdateCheck: (trigger) => (upd ? upd.runUpdateCheck(trigger) : null),
    updateLicenseGateNow: () => (upd ? upd.updateLicenseGateNow() : null),
    getAutoUpdaterRef: () => (upd ? upd.getAutoUpdaterRef() : null),
    getUpdateState: () => (upd ? upd.getUpdateState() : null),
    setUpdateState: (s) => (upd ? upd.setUpdateState(s) : null),
    pushUpdateState: () => (upd ? upd.pushUpdateState() : null),
    updateCheck: ctx.updateCheck,
    noteQuit: ctx.noteQuit,
  };
}

function _buildHandAndMobileDeps(ctx) {
  const wm = ctx.windowManager;
  const mob = ctx.mobileService;
  return {
    getHandOverlayWindows: () => (wm ? wm.handOverlayWindows : new Map()),
    getHandOverlayPrefs: () => (wm ? wm.handOverlayPrefs() : { overlay: {} }),
    handOverlayAnyAlive: () => (ctx.handOverlayAnyAlive ? ctx.handOverlayAnyAlive() : false),
    closeHandOverlayWindows: (why) => (ctx.closeHandOverlayWindows ? ctx.closeHandOverlayWindows(why) : null),
    feedHandOverlay: (raw) => (ctx.feedHandOverlay ? ctx.feedHandOverlay(raw) : null),
    getHandControl: () => ctx.handControl,
    startHandControl: () => (ctx.startHandControl ? ctx.startHandControl() : null),
    stopHandControl: (why) => (ctx.stopHandControl ? ctx.stopHandControl(why) : null),
    handControlStatus: () => (ctx.handControlStatus ? ctx.handControlStatus() : null),
    handControlLive: () => (ctx.handControlLive ? ctx.handControlLive() : null),
    finishPoseSampler: () => (ctx.finishPoseSampler ? ctx.finishPoseSampler() : null),
    selectHandCamera: (sel) => (ctx.selectHandCamera ? ctx.selectHandCamera(sel) : null),
    onHandDetectFrame: ctx.onHandDetectFrame,
    handDetectAlive: ctx.handDetectAlive,
    broadcastHandControlStatus: ctx.broadcastHandControlStatus,
    handCameraPolicy: ctx.handCameraPolicy,
    handHardwareCameras: ctx.handHardwareCameras,
    handCameraPreference: ctx.handCameraPreference,
    getSyncRuntime: () => ctx.syncRuntime,
    getSyncIpcSurface: () => ctx.syncIpcSurface,
    mobilePending: ctx.mobilePending,
    mobileCommandPending: ctx.mobileCommandPending,
    emitMobileEvent: (e) => (ctx.emitMobileEvent ? ctx.emitMobileEvent(e) : null),
    getMobileGateway: () => (mob ? mob.getMobileGateway() : null),
    mobileDeviceStore: ctx.mobileDeviceStore,
    mobilePlanDenial: (opts) => (ctx.mobilePlanDenial ? ctx.mobilePlanDenial(opts) : null),
    startMobile: () => (ctx.startMobile ? ctx.startMobile() : null),
    getMobileGatewayLastFailure: () => (mob ? mob.getMobileGatewayLastFailure() : null),
    mobileStartFailure: (c) => (ctx.mobileStartFailure ? ctx.mobileStartFailure(c) : null),
    mobileKillSwitch: () => (ctx.mobileKillSwitch ? ctx.mobileKillSwitch() : null),
    mobileProbe: ctx.mobileProbe,
  };
}

function _resolveBrowserDeps(ctx) {
  const bs = ctx.browserService;
  if (!bs) return {};
  return {
    runBrowserAction: (val) => bs.runBrowserAction(val),
    browserGate: () => bs.browserGate(),
    browserGuests: bs.browserGuests,
    isOwnedGuest: (id) => bs.isOwnedGuest(id),
    guestOwners: bs.guestOwners,
    agentGuests: bs.agentGuests,
    lastUnownedGuest: () => bs.lastUnownedGuest(),
  };
}

function _resolveWidgetDeps(ctx) {
  const wm = ctx.windowManager;
  if (!wm) return {};
  return {
    openJarvisWidgetWindow: () => wm.openJarvisWidgetWindow(),
    closeJarvisWidgetWindow: (why) => wm.closeJarvisWidgetWindow(why),
    jarvisWidgetAlive: () => wm.jarvisWidgetAlive(),
    jarvisWidget: () => wm.getJarvisWidgetWindow(),
    broadcastJarvisWidget: () => wm.broadcastJarvisWidget(),
    jarvisWidgetPayload: () => wm.jarvisWidgetPayload(),
    moveJarvisWidget: (payload) => wm.moveJarvisWidget(payload),
    showAppFromJarvisWidget: () => wm.showAppFromJarvisWidget(),
    broadcastAgentxDraft: (s) => wm.broadcastAgentxDraft(s),
    broadcastAgentxDraftConfirmed: (c) => wm.broadcastAgentxDraftConfirmed(c),
  };
}

function _buildSkillAndSupervisorDeps(ctx) {
  const out = Object.assign(_resolveBrowserDeps(ctx), _resolveWidgetDeps(ctx), {
    setAppWindowGuest: ctx.setAppWindowGuest,
    getAppWindowGuest: ctx.getAppWindowGuest,
    integrations: ctx.integrations,
    planDenial: ctx.planDenial,
    mcpProcess: ctx.mcpProcess,
    integrationAutostart: ctx.integrationAutostart,
    telemetryProvisioning: ctx.telemetryProvisioning,
    sprintStore: ctx.sprintStore,
    resultRootMod: ctx.resultRootMod,
    evidencePathMod: ctx.evidencePathMod,
    spawn: ctx.spawn,
    appI18n: ctx.appI18n,
    notifyGate: ctx.notifyGate,
  });
  const overrideKeys = [
    'runBrowserAction',
    'browserGate',
    'browserGuests',
    'isOwnedGuest',
    'guestOwners',
    'agentGuests',
    'lastUnownedGuest',
    'openJarvisWidgetWindow',
    'closeJarvisWidgetWindow',
    'jarvisWidgetAlive',
    'jarvisWidget',
    'broadcastJarvisWidget',
    'jarvisWidgetPayload',
    'moveJarvisWidget',
    'showAppFromJarvisWidget',
    'broadcastAgentxDraft',
    'broadcastAgentxDraftConfirmed',
  ];
  for (let i = 0; i < overrideKeys.length; i++) {
    const k = overrideKeys[i];
    if (ctx[k] !== undefined) out[k] = ctx[k];
  }
  Object.assign(out, {
    requireSeatOrThrow: ctx.requireSeatOrThrow,
    jarvisVoice: ctx.jarvisVoice,
    grokVoice: ctx.grokVoice,
    inputSim: ctx.inputSim,
    screenCaptureMod: ctx.screenCaptureMod,
    instancePaths: ctx.instancePaths,
    getJarvisConv: () => ctx.jarvisConv,
    agentxDeliverer: ctx.agentxDeliverer,
    agentxBeamMod: ctx.agentxBeamMod,
    agentxDraft: ctx.agentxDraft,
    skillCenter: ctx.skillCenter,
    skillEngineSync: ctx.skillEngineSync,
    skillApprove: ctx.skillApprove,
    skillAuthor: ctx.skillAuthor,
    skillVersions: ctx.skillVersions,
    skillShare: ctx.skillShare,
    builtinSkills: ctx.builtinSkills,
    skillGuard: ctx.skillGuard,
    skillEngineView: ctx.skillEngineView,
    getBoundAccount: () => ctx.boundAccount,
    syncSkillEngineViews: ctx.syncSkillEngineViews,
    delegationQueueStore: ctx.delegationQueueStore,
    delegationSupervisorStore: ctx.delegationSupervisorStore,
    resumeQueueStore: ctx.resumeQueueStore,
    queueBoard: ctx.queueBoard,
    ensureDelegationSupervisor: ctx.ensureDelegationSupervisor,
    scheduleSupervisorSweep: ctx.scheduleSupervisorSweep,
    supervisorPending: ctx.supervisorPending,
    supervisorFingerprint: ctx.supervisorFingerprint,
    ensureComposeLedger: ctx.ensureComposeLedger,
    teamComposeCore: ctx.teamComposeCore,
    getComposeTransport: () => ctx.composeTransport,
    teamComposeRequest: ctx.teamComposeRequest,
    composeFail: ctx.composeFail,
    composeAutonomy: ctx.composeAutonomy,
    sampleLeaderGate: ctx.sampleLeaderGate,
  });
  return out;
}

function buildMobileAndSkillDeps(ctx) {
  return {
    ..._buildUpdateAndAnnounceDeps(ctx),
    ..._buildHandAndMobileDeps(ctx),
    ..._buildSkillAndSupervisorDeps(ctx),
  };
}

function buildSystemAuthAndEngineDeps(ctx) {
  const rb = ctx.resetBootService;
  const upd = ctx.updateService;
  const chg = ctx.changelogService;
  const api = ctx.apiKeyService;
  return {
    getModuleFaults: () => ctx.moduleFaults,
    reportModuleFault: ctx.reportModuleFault,
    getLogPath: () => ctx.LOG_PATH,
    analyticsNow: ctx.analyticsNow,
    analyticsSchema: ctx.analyticsSchema,
    analyticsFirstTime: ctx.analyticsFirstTime,
    telemetryTokenFor: ctx.telemetryTokenFor,
    credentialGate: ctx.credentialGate,
    stampIntegrationVerified: ctx.stampIntegrationVerified,
    vendorSurface: ctx.vendorSurface,
    telemetryMod: ctx.telemetryMod,
    provisionStoreMod: ctx.provisionStoreMod,
    telemetryChannelMod: ctx.telemetryChannelMod,
    getSeatGate: () => ctx.seatGate,
    gateOverrides: ctx.gateOverrides,
    signOutConfirmCopy: ctx.signOutConfirmCopy,
    accountScope: ctx.accountScope,
    relaunchForAccountChange: ctx.relaunchForAccountChange,
    schemeOwnership: ctx.schemeOwnership,
    getSchemeVerdict: () => ctx.schemeVerdict,
    setSchemeVerdict: (v) => { ctx.schemeVerdict = v; },
    isAutomatedSession: ctx.isAutomatedSession ?? ctx.IS_AUTOMATED_SESSION,
    automatedSessionReason: ctx.automatedSessionReason ?? ctx.AUTOMATED_SESSION_REASON,
    secretBackendState: ctx.secretBackendState,
    handleAuthUrl: ctx.handleAuthUrl,
    crewpaneIdConfig: ctx.crewpaneIdConfig,
    verifyAppApiKey: ctx.verifyAppApiKey || ((svc) => (api ? api.verifyAppApiKey(svc) : false)),
    planLimits: ctx.planLimits,
    appDbTokenFor: ctx.appDbTokenFor,
    resetContext: (log) => (rb ? rb.resetContext(log) : null),
    installReset: ctx.installReset,
    resetGate: ctx.resetGate,
    sendResetTelemetry: (o) => (rb ? rb.sendResetTelemetry(o) : null),
    leaderRefreshPolicy: ctx.leaderRefreshPolicy,
    handOverlayContract: ctx.handOverlayContract,
    updateChannel: ctx.updateChannel,
    currentUpdateChannel: () => (upd ? upd.currentUpdateChannel() : 'auto'),
    aiProvidersPayload: ctx.aiProvidersPayload || ((s) => (api ? api.aiProvidersPayload(s) : {})),
    engineModelCatalogPayload: ctx.engineModelCatalogPayload || (() => (api ? api.engineModelCatalogPayload() : {})),
    appApiKeysPayload: ctx.appApiKeysPayload || (() => (api ? api.appApiKeysPayload() : {})),
    engineCatalog: ctx.engineCatalog,
    teamScope: ctx.teamScope,
    browserTrustMod: ctx.browserTrustMod,
    broadcastLocale: ctx.broadcastLocale,
    prefsProjectNow: ctx.prefsProjectNow,
    applyHandOverlaySettings: ctx.applyHandOverlaySettings,
    presetAdvisor: ctx.presetAdvisor,
    engineCheck: ctx.engineCheck,
    capabilityRegistry: ctx.capabilityRegistry,
    paneCapabilityMatrix: ctx.paneCapabilityMatrix,
    engineOffering: ctx.engineOffering,
    engineLeadership: ctx.engineLeadership,
    enginePlanned: ctx.enginePlanned,
    engineAuth: ctx.engineAuth,
    engineProfiles: ctx.engineProfiles,
    engineSwitch: ctx.engineSwitch,
    limitDetect: ctx.limitDetect,
    getResetBootNotice: () => (rb ? rb.getResetBootNotice() : null),
    demoSitePath: ctx.demoSitePath,
    runDoctorNow: ctx.runDoctorNow,
    firstRunDoctor: ctx.firstRunDoctor,
    hookScanHome: ctx.hookScanHome,
    changelogStateForRenderer: () => (chg ? chg.changelogStateForRenderer() : {}),
    runChangelogCheck: (trigger) => (chg ? chg.runChangelogCheck(trigger) : null),
    getChangelogState: () => (chg ? chg.getChangelogState() : { items: [] }),
    engineKeyStore: () => (ctx.engineKeyStore ? ctx.engineKeyStore() : null),
    engineLoginLedger: ctx.engineLoginLedger,
    planCatalog: ctx.planCatalog,
  };
}

function assembleIpcDeps(ctx) {
  return {
    ...buildPlatformAndWindowDeps(ctx),
    ...buildWorkspaceAndStorageDeps(ctx),
    ...buildMediaAndMemoryDeps(ctx),
    ...buildTerminalAndExecutionDeps(ctx),
    ...buildMobileAndSkillDeps(ctx),
    ...buildSystemAuthAndEngineDeps(ctx),
  };
}

module.exports = {
  assembleIpcDeps,
  buildPlatformAndWindowDeps,
  buildWorkspaceAndStorageDeps,
  buildMediaAndMemoryDeps,
  buildTerminalAndExecutionDeps,
  buildMobileAndSkillDeps,
  buildSystemAuthAndEngineDeps,
};
