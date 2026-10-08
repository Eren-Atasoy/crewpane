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
    keepPanesAliveOnWindowClose: (typeof ctx.keepPanesAliveOnWindowClose === 'function' ? ctx.keepPanesAliveOnWindowClose : () => (ctx.paneQueryService ? ctx.paneQueryService.keepPanesAliveOnWindowClose() : false)),
    crashWatchdog: ctx.crashWatchdog,
    getAppUrlScheme: ctx.getAppUrlScheme || (() => ctx.APP_URL_SCHEME),
    getAppUrlPrefix: ctx.getAppUrlPrefix || (() => ctx.APP_URL_PREFIX),
    mode: ctx.mode ?? ctx.MODE,
    relaunchApp: ctx.relaunchApp,
    rebuildAndRelaunch: ctx.rebuildAndRelaunch || ((e) => (ctx.rebuildService ? ctx.rebuildService.rebuildAndRelaunch(e) : null)),
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
    feedbackBridge: (typeof ctx.feedbackBridge === 'function' ? ctx.feedbackBridge : () => (ctx.mediaService ? ctx.mediaService.feedbackBridge() : null)),
    workspacePlanDenial: ctx.workspacePlanDenial || ((root) => (ctx.planLimitService ? ctx.planLimitService.workspacePlanDenial(root) : null)),
    workspaceOnboarding: ctx.workspaceOnboarding,
    rememberWorkspaceRoot: ctx.rememberWorkspaceRoot || ((root) => (ctx.planLimitService ? ctx.planLimitService.rememberWorkspaceRoot(root) : null)),
    switchWorkspaceRoot: ctx.switchWorkspaceRoot || ((root) => (wsRoots ? wsRoots.switchWorkspaceRoot(root) : null)),
    worktreeStore: ctx.worktreeStore,
    projectRepos: ctx.projectRepos,
    agentWorkspaceRoot: ctx.agentWorkspaceRoot,
    mergeService: ctx.mergeService,
    worktreeService: ctx.worktreeService,
    activeWorktreePaths: ctx.activeWorktreePaths || (() => (ctx.ptyIsolationService ? ctx.ptyIsolationService.activeWorktreePaths() : [])),
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

function _resolveMediaOps(ctx) {
  const ms = ctx.mediaService;
  return {
    saveTempImage: (p) => (typeof ctx.saveTempImage === 'function' ? ctx.saveTempImage(p) : (ms ? ms.saveTempImage(p) : null)),
    ingestTaskAttachment: (p) => (typeof ctx.ingestTaskAttachment === 'function' ? ctx.ingestTaskAttachment(p) : (ms ? ms.ingestTaskAttachment(p) : null)),
    attachmentStore: () => (typeof ctx.attachmentStore === 'function' ? ctx.attachmentStore() : (ms ? ms.attachmentStore() : null)),
  };
}

function _resolveMemoryOps(ctx) {
  const mem = ctx.memoryService;
  return {
    memoryIndexer: ctx.memoryIndexer || (() => (mem ? mem.memoryIndexer() : null)),
    memorySearcher: ctx.memorySearcher || (() => (mem ? mem.memorySearcher() : null)),
    memoryEmbedInstaller: ctx.memoryEmbedInstaller || (() => (mem ? mem.memoryEmbedInstaller() : null)),
    searchIndexer: ctx.searchIndexer || (() => (mem ? mem.searchIndexer() : null)),
  };
}

function buildMediaAndMemoryDeps(ctx) {
  return {
    clipboardImageRoute: ctx.clipboardImageRoute,
    ..._resolveMediaOps(ctx),
    localSprites: ctx.localSprites,
    pkgMgr,
    officePkg,
    imageStore: ctx.mediaService ? ctx.mediaService.imageStore : ctx.imageStore,
    memoryGraph: ctx.memoryGraph,
    ..._resolveMemoryOps(ctx),
    memoryEmbedder: ctx.memoryEmbedder,
    memoryEmbedInstall: ctx.memoryEmbedInstall,
    memoryRecall: ctx.memoryRecall,
    secretRedactor: ctx.secretRedactor,
    memoryTaskBlock: ctx.memoryTaskBlock,
    currentSessionId: ctx.currentSessionId,
    paneContextScope: ctx.paneContextScope,
    engineMemoryScope: ctx.engineMemoryScope,
    broadcastClipChanged: ctx.broadcastClipChanged || (() => (ctx.windowManager ? ctx.windowManager.broadcastClipChanged() : null)),
    clipboardHistoryCore: ctx.clipboardHistoryCore,
  };
}

function _resolveTerminalQueryOps(ctx) {
  const pqs = ctx.paneQueryService;
  return {
    listPanes: (win, dep) => (typeof ctx.listPanes === 'function' ? ctx.listPanes(win, dep) : (pqs ? pqs.listPanes(win, dep) : [])),
    killPaneExplicitAndCleanup: (p) => (typeof ctx.killPaneExplicitAndCleanup === 'function' ? ctx.killPaneExplicitAndCleanup(p) : (pqs ? pqs.killPaneExplicitAndCleanup(p) : null)),
    runningPaneSummary: () => (typeof ctx.runningPaneSummary === 'function' ? ctx.runningPaneSummary() : (pqs ? pqs.runningPaneSummary() : [])),
    closePanesForSignOut: () => (typeof ctx.closePanesForSignOut === 'function' ? ctx.closePanesForSignOut() : (pqs ? pqs.closePanesForSignOut() : null)),
  };
}

function _resolveTerminalControlOps(ctx) {
  const pcs = ctx.paneControlService;
  const pss = ctx.ptySpawnService;
  const prs = ctx.ptyResumeService;
  const rst = ctx.paneRestoreService;
  const pis = ctx.ptyIsolationService;
  return {
    killPane: (p, e, a, w) => (typeof ctx.killPane === 'function' ? ctx.killPane(p, e, a, w) : (pcs ? pcs.killPane(p, e, a, w) : null)),
    authorizeTeamScopeInteractive: (o) => (typeof ctx.authorizeTeamScopeInteractive === 'function' ? ctx.authorizeTeamScopeInteractive(o) : (pcs ? pcs.authorizeTeamScopeInteractive(o) : null)),
    spawnPty: (win, o, e) => (typeof ctx.spawnPty === 'function' ? ctx.spawnPty(win, o, e) : (pss ? pss.spawnPty(win, o, e) : null)),
    dedupeSpawnForAgent: (o, w) => (typeof ctx.dedupeSpawnForAgent === 'function' ? ctx.dedupeSpawnForAgent(o, w) : (pis ? pis.dedupeSpawnForAgent(o, w) : null)),
    resumePtyDaemon: () => (typeof ctx.resumePtyDaemon === 'function' ? ctx.resumePtyDaemon() : (prs ? prs.resumePtyDaemon() : null)),
    acceptRecoverablePanes: (win) => (typeof ctx.acceptRecoverablePanes === 'function' ? ctx.acceptRecoverablePanes(win) : (rst ? rst.acceptRecoverablePanes(win) : null)),
    respawnOptsFromEntry: (e, c) => (typeof ctx.respawnOptsFromEntry === 'function' ? ctx.respawnOptsFromEntry(e, c) : (rst ? rst.respawnOptsFromEntry(e, c) : null)),
  };
}

function _resolveTerminalDispatchOps(ctx) {
  const tel = ctx.telemetryService;
  const pbs = ctx.paneBudgetService;
  const pts = ctx.paneTranscriptService;
  const pds = ctx.paneDispatchService;
  const pas = ctx.paneAskService;
  return {
    analyticsEngineOf: (c) => (typeof ctx.analyticsEngineOf === 'function' ? ctx.analyticsEngineOf(c) : (tel ? tel.analyticsEngineOf(c) : null)),
    telemetryBump: (k, b, p) => (typeof ctx.telemetryBump === 'function' ? ctx.telemetryBump(k, b, p) : (tel ? tel.telemetryBump(k, b, p) : null)),
    enforcePaneBudget: (...a) => (typeof ctx.enforcePaneBudget === 'function' ? ctx.enforcePaneBudget(...a) : (pbs ? pbs.enforcePaneBudget(...a) : null)),
    paneTokenBudget: ctx.paneTokenBudget || (pbs ? pbs.paneTokenBudget : null),
    probeTranscriptContains: (...a) => (typeof ctx.probeTranscriptContains === 'function' ? ctx.probeTranscriptContains(...a) : (pts ? pts.probeTranscriptContains(...a) : null)),
    paneDispatchDecisionFor: (...a) => (typeof ctx.paneDispatchDecisionFor === 'function' ? ctx.paneDispatchDecisionFor(...a) : (pds ? pds.paneDispatchDecisionFor(...a) : null)),
    leaderRefreshTick: (...a) => (typeof ctx.leaderRefreshTick === 'function' ? ctx.leaderRefreshTick(...a) : (pds ? pds.leaderRefreshTick(...a) : null)),
    leaderRefreshViewFor: (...a) => (typeof ctx.leaderRefreshViewFor === 'function' ? ctx.leaderRefreshViewFor(...a) : (pds ? pds.leaderRefreshViewFor(...a) : null)),
    logDispatchDecision: (...a) => (typeof ctx.logDispatchDecision === 'function' ? ctx.logDispatchDecision(...a) : (pds ? pds.logDispatchDecision(...a) : null)),
    refreshPaneSession: (...a) => (typeof ctx.refreshPaneSession === 'function' ? ctx.refreshPaneSession(...a) : (pds ? pds.refreshPaneSession(...a) : null)),
    paneAskRuntime: ctx.paneAskRuntime || (pas ? pas.paneAskRuntime : null),
  };
}

function _resolveTranscriptAndBudgetOps(ctx) {
  const pbs = ctx.paneBudgetService;
  const pts = ctx.paneTranscriptService;
  return {
    paneBudgetStore: ctx.paneBudgetStore || (pbs ? pbs.paneBudgetStore : null),
    paneSessionAnchor: ctx.paneSessionAnchor || (pts ? pts.paneSessionAnchor : null),
    sessionAnchor: ctx.sessionAnchor || (pts ? pts.sessionAnchor : null),
  };
}

function _resolvePaneViewAndDispatchOps(ctx) {
  const pqs = ctx.paneQueryService;
  const pds = ctx.paneDispatchService;
  return {
    dispatchStore: ctx.dispatchStore || (pds ? pds.dispatchStore : null),
    paneViewState: ctx.paneViewState || (pqs ? pqs.paneViewState : null),
    paneDraft: ctx.paneDraft || (pqs ? pqs.paneDraft : null),
    deliverToPane: ctx.deliverToPane || (pds ? pds.deliverToPane : null),
    dispatchSleep: ctx.dispatchSleep || (pds ? pds.dispatchSleep : null),
  };
}

function buildTerminalAndExecutionDeps(ctx) {
  const wm = ctx.windowManager;
  return Object.assign(
    _resolveTerminalQueryOps(ctx),
    _resolveTerminalControlOps(ctx),
    _resolveTerminalDispatchOps(ctx),
    _resolveTranscriptAndBudgetOps(ctx),
    _resolvePaneViewAndDispatchOps(ctx),
    {
      resourceGovernor: ctx.resourceGovernor,
      agentRunner: ctx.agentRunner,
      resourceGovernorModule: ctx.resourceGovernorModule,
      engineDelegation: ctx.engineDelegation,
      prepareTaskIsolation: ctx.prepareTaskIsolation || (ctx.ptyIsolationService ? (opts) => ctx.ptyIsolationService.prepareTaskIsolation(opts) : null),
      preflightModelGate: ctx.preflightModelGate || (ctx.ptyIsolationService ? (opts, trusted) => ctx.ptyIsolationService.preflightModelGate(opts, trusted) : null),
      spendGuard: ctx.spendGuard,
      leaderComposer: ctx.leaderComposer,
      transcriptProbe: ctx.transcriptProbe,
      mobileTranscript: ctx.mobileTranscript,
      tokenUsage: ctx.tokenUsage,
      modelDetect: ctx.modelDetect,
      ptyResizeGate: ctx.ptyResizeGate,
      tmuxWindows: ctx.tmuxWindows,
      broadcastPaneView: ctx.broadcastPaneView || ((paneId, r) => (wm ? wm.broadcastPaneView(paneId, r) : null)),
      broadcastPaneDraft: ctx.broadcastPaneDraft || ((paneId, t) => (wm ? wm.broadcastPaneDraft(paneId, t) : null)),
      getPaneAskRuntime: ctx.getPaneAskRuntime || (() => ctx.paneAskRuntime || (ctx.paneAskService ? ctx.paneAskService.paneAskRuntime : null)),
      getPtys: ctx.getPtys || (() => ctx.ptys),
      livePaneRegistry: ctx.livePaneRegistry,
      agentEngineMirror: ctx.agentEngineMirror,
    }
  );
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

function _resolveHandOps(ctx) {
  const wm = ctx.windowManager;
  const hs = ctx.handService;
  return {
    getHandOverlayWindows: () => (wm ? wm.handOverlayWindows : new Map()),
    getHandOverlayPrefs: () => (wm ? wm.handOverlayPrefs() : { overlay: {} }),
    handOverlayAnyAlive: () => (wm ? wm.handOverlayAnyAlive() : false),
    closeHandOverlayWindows: (why) => (wm ? wm.closeHandOverlayWindows(why) : null),
    feedHandOverlay: (raw) => (wm ? wm.feedHandOverlay(raw) : null),
    applyHandOverlaySettings: () => (wm ? wm.applyHandOverlaySettings() : null),
    handDetectAlive: () => (wm ? wm.handDetectAlive() : false),
    getHandControl: () => (hs ? hs.handControl : ctx.handControl),
    startHandControl: (opts) => (hs ? hs.startHandControl(opts) : null),
    stopHandControl: (why) => (hs ? hs.stopHandControl(why) : null),
    handControlStatus: () => (hs ? hs.handControlStatus() : null),
    handControlLive: () => (hs ? hs.handControlLive() : null),
    finishPoseSampler: () => (hs ? hs.finishPoseSampler() : null),
    selectHandCamera: (sel) => (hs ? hs.selectHandCamera(sel) : null),
    onHandDetectFrame: (ev, p) => (hs ? hs.onHandDetectFrame(ev, p) : null),
    broadcastHandControlStatus: () => (hs ? hs.broadcastHandControlStatus() : null),
    handCameraPolicy: hs ? hs.handCameraPolicy : ctx.handCameraPolicy,
    handHardwareCameras: () => (hs ? hs.handHardwareCameras() : null),
    handCameraPreference: () => (hs ? hs.handCameraPreference() : null),
  };
}

function _resolveMobileOps(ctx) {
  const mob = ctx.mobileService;
  const sync = ctx.syncService;
  return {
    getSyncRuntime: () => ctx.syncRuntime || (sync ? sync.syncRuntime : null),
    getSyncIpcSurface: () => ctx.syncIpcSurface || (sync ? sync.syncIpcSurface : null),
    mobilePending: ctx.mobilePending || (mob ? mob.mobilePending : null),
    mobileCommandPending: ctx.mobileCommandPending || (mob ? mob.mobileCommandPending : null),
    emitMobileEvent: (e) => (ctx.emitMobileEvent ? ctx.emitMobileEvent(e) : (mob ? mob.emitMobileEvent(e) : null)),
    getMobileGateway: () => (mob ? mob.getMobileGateway() : null),
    mobileDeviceStore: ctx.mobileDeviceStore,
    mobilePlanDenial: (opts) => (ctx.mobilePlanDenial ? ctx.mobilePlanDenial(opts) : (mob ? mob.mobilePlanDenial(opts) : null)),
    startMobile: () => (ctx.startMobile ? ctx.startMobile() : (mob ? mob.startMobile() : null)),
    getMobileGatewayLastFailure: () => (mob ? mob.getMobileGatewayLastFailure() : null),
    mobileStartFailure: (c) => (ctx.mobileStartFailure ? ctx.mobileStartFailure(c) : (mob ? mob.mobileStartFailure(c) : null)),
    mobileKillSwitch: () => (ctx.mobileKillSwitch ? ctx.mobileKillSwitch() : (mob ? mob.mobileKillSwitch() : null)),
    mobileProbe: ctx.mobileProbe,
  };
}

function _buildHandAndMobileDeps(ctx) {
  const out = Object.assign(_resolveHandOps(ctx), _resolveMobileOps(ctx));
  const handKeys = [
    'handOverlayAnyAlive', 'closeHandOverlayWindows', 'feedHandOverlay', 'applyHandOverlaySettings',
    'startHandControl', 'stopHandControl', 'handControlStatus', 'handControlLive', 'finishPoseSampler',
    'selectHandCamera', 'onHandDetectFrame', 'handDetectAlive', 'broadcastHandControlStatus',
    'handHardwareCameras', 'handCameraPreference',
  ];
  for (let i = 0; i < handKeys.length; i++) {
    const k = handKeys[i];
    if (typeof ctx[k] === 'function') out[k] = ctx[k];
  }
  return out;
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

function _resolveTeamOps(ctx) {
  const tc = ctx.teamComposeService;
  const sup = ctx.delegationSupervisorService;
  const tel = ctx.telemetryService;
  return {
    telemetryProvisioning: () => (typeof ctx.telemetryProvisioning === 'function' ? ctx.telemetryProvisioning() : (tel ? tel.telemetryProvisioning() : null)),
    ensureComposeLedger: () => (typeof ctx.ensureComposeLedger === 'function' ? ctx.ensureComposeLedger() : (tc ? tc.ensureComposeLedger() : null)),
    teamComposeRequest: (r, t) => (typeof ctx.teamComposeRequest === 'function' ? ctx.teamComposeRequest(r, t) : (tc ? tc.teamComposeRequest(r, t) : null)),
    composeFail: (s, c, e, x) => (typeof ctx.composeFail === 'function' ? ctx.composeFail(s, c, e, x) : (tc ? tc.composeFail(s, c, e, x) : null)),
    composeAutonomy: () => (typeof ctx.composeAutonomy === 'function' ? ctx.composeAutonomy() : (tc ? tc.composeAutonomy() : null)),
    ensureDelegationSupervisor: () => (typeof ctx.ensureDelegationSupervisor === 'function' ? ctx.ensureDelegationSupervisor() : (sup ? sup.ensureDelegationSupervisor() : null)),
    scheduleSupervisorSweep: (d) => (typeof ctx.scheduleSupervisorSweep === 'function' ? ctx.scheduleSupervisorSweep(d) : (sup ? sup.scheduleSupervisorSweep(d) : null)),
    supervisorPending: ctx.supervisorPending || (sup ? sup.supervisorPending : null),
    notifyGate: () => (typeof ctx.notifyGate === 'function' ? ctx.notifyGate() : (sup ? sup.notifyGate() : null)),
  };
}

function _buildSkillAndSupervisorDeps(ctx) {
  const out = Object.assign(_resolveBrowserDeps(ctx), _resolveWidgetDeps(ctx), _resolveTeamOps(ctx), {
    setAppWindowGuest: ctx.setAppWindowGuest,
    getAppWindowGuest: ctx.getAppWindowGuest,
    integrations: ctx.integrations,
    planDenial: ctx.planDenial || ((feat, curr, opts) => (ctx.planLimitService ? ctx.planLimitService.planDenial(feat, curr, opts) : null)),
    mcpProcess: ctx.mcpProcess,
    integrationAutostart: ctx.integrationAutostart,
    sprintStore: ctx.sprintStore,
    resultRootMod: ctx.resultRootMod,
    evidencePathMod: ctx.evidencePathMod,
    spawn: ctx.spawn,
    appI18n: ctx.appI18n,
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
    agentxDeliverer: ctx.agentxDeliverer || (ctx.paneDispatchService ? ctx.paneDispatchService.agentxDeliverer : null),
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
    supervisorFingerprint: ctx.supervisorFingerprint,
    teamComposeCore: ctx.teamComposeCore,
    getComposeTransport: () => (ctx.teamComposeService ? ctx.teamComposeService.getComposeTransport() : ctx.composeTransport),
    sampleLeaderGate: (typeof ctx.sampleLeaderGate === 'function' ? ctx.sampleLeaderGate : ((paneId) => (ctx.paneDispatchService ? ctx.paneDispatchService.sampleLeaderGate(paneId) : false))),
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

function _resolveSystemTelemetryAndFaultOps(ctx) {
  const tel = ctx.telemetryService;
  const flt = ctx.faultService;
  return {
    analyticsNow: () => (typeof ctx.analyticsNow === 'function' ? ctx.analyticsNow() : (tel ? tel.analyticsNow() : null)),
    analyticsFirstTime: (m) => (typeof ctx.analyticsFirstTime === 'function' ? ctx.analyticsFirstTime(m) : (tel ? tel.analyticsFirstTime(m) : null)),
    telemetryTokenFor: (s) => (typeof ctx.telemetryTokenFor === 'function' ? ctx.telemetryTokenFor(s) : (tel ? tel.telemetryTokenFor(s) : null)),
    reportModuleFault: (f) => (typeof ctx.reportModuleFault === 'function' ? ctx.reportModuleFault(f) : (flt ? flt.reportModuleFault(f) : null)),
    getModuleFaults: () => (flt ? flt.moduleFaults : ctx.moduleFaults),
  };
}

function buildSystemAuthAndEngineDeps(ctx) {
  const rb = ctx.resetBootService;
  const upd = ctx.updateService;
  const chg = ctx.changelogService;
  const api = ctx.apiKeyService;
  return {
    ..._resolveSystemTelemetryAndFaultOps(ctx),
    getLogPath: () => ctx.LOG_PATH,
    analyticsSchema: ctx.analyticsSchema,
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
    broadcastLocale: ctx.broadcastLocale || (() => (ctx.appLocaleService ? ctx.appLocaleService.broadcastLocale() : null)),
    prefsProjectNow: ctx.prefsProjectNow || ((reason) => (ctx.syncService ? ctx.syncService.prefsProjectNow(reason) : null)),
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
