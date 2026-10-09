// CrewPane — Application Composition Root
//
// Assembles all domain services, bundles, state, and lifecycle wires.
// Pure composition root: instantiated once during startup by src/main/index.js.
'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  dialog,
  screen,
  globalShortcut,
  Notification,
  nativeImage,
} = require('electron');

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const instancePaths = require('../config/instancePaths.cjs');
const backendTarget = require('../config/backendTarget.cjs');
const publicBackendEnv = require('../config/publicBackendEnv.cjs');
const appDbIdentity = require('../config/appDbIdentity.cjs');
const mixedTargetGuard = require('../config/mixedTargetGuard.cjs');
const crewpaneEnv = require('../config/crewpaneEnv.cjs');
const envProfileModule = require('../config/envProfile.cjs');
const { crewpaneIdConfig } = require('../config/crewpaneId.cjs');
const { appScheme, appSchemePrefix } = require('../core/appScheme.cjs');

const { registerPrefsIpc, createSyncService } = require('../features/sync');
const { createMemoryService } = require('../features/memory');
const { createMobileService } = require('../features/mobile');
const { createMainIpcWiring } = require('./ipc');
const { createWindowManager } = require('./windows');
const { createNextServerManager } = require('./server');
const { setupLifecycleServices } = require('./lifecycle');
const { createTerminalServicesBundle } = require('../features/terminal');
const { createDelegationSupervisorService } = require('../features/agents');
const { createJarvisConversationService, createDictationDeliveryService } = require('../features/voice');
const { createBackendEnvService } = require('../features/services');

const agentRunner = require('../agents/agentRunner.js');
const delegationBridgeMod = require('../agents/delegationBridge.js');
const browserCdp = require('../services/browserCdp.js');
const browserGateMod = require('../security/browserGate.cjs');
const jarvisVoice = require('../voice/jarvisVoice.js');
const engineRegistry = require('../agents/engineRegistry.cjs');
const providers = require('../agents/providers.cjs');
const modelCatalog = require('../agents/modelCatalog.cjs');
const resetGate = require('../security/resetGate.cjs');
const quitFunnel = require('../core/quitFunnel.cjs');
const agentSettings = require('../agents/agentSettings.cjs');
const appI18n = require('../../i18n/index.cjs');
const updateCheck = require('../services/updateCheck.cjs');
const crewpanePaths = require('../config/crewpanePaths.cjs');
const tamperSignals = require('../security/tamperSignals.cjs');
const integrityCheck = require('../security/integrityCheck.cjs');

const { createIntegrityService } = require('../security');
const stdioGuard = require('../core/stdioGuard.cjs');
const notifyLog = require('../services/notifyLog.cjs');
const moduleGuard = require('../agents/moduleGuard.cjs');
const engineAuth = require('../agents/engineAuth.cjs');
const secretBackendState = require('../security/secretBackendState.cjs');
const crashWatchdog = require('../core/crashWatchdog.cjs');
const integrationCatalog = require('../mcp/integrationCatalog.cjs');
const credentialGate = require('../security/requireCredential.cjs');
const { createSecretRedactor } = require('../security/secretRedactor.cjs');
const logger = require('../shared/logger/index.js');

const {
  createFaultService,
  createRebuildService,
  createSystemServicesBundle,
  createResourceGovernorService,
  createCrashWatchdogService,
} = require('../features/system');

const livePaneRegistry = require('../agents/livePaneRegistry.cjs');
const { isAutomatedSession, automatedSessionReason } = require('../agents/automatedSession.cjs');
const vendorSurface = require('../core/vendorSurface.cjs');
const { createAuthServicesBundle } = require('../features/auth');
const {
  createIntegrationService,
  createWorkspaceServicesBundle,
  createBrowserService,
} = require('../features/services');
const {
  gitBranchCache,
  GIT_BRANCH_TTL_MS,
  invalidateGitBranchCache,
} = require('../shared/utils');
const { createHandService } = require('../features/hand');
const jarvisConversationMod = require('../voice/jarvisConversation.cjs');
const { createTeamComposeService, createDelegationBridgeService } = require('../features/agents');

function resolveRepoRoot() {
  const root = path.resolve(__dirname, '..', '..');
  if (fs.existsSync(path.join(root, 'package.json')) && fs.existsSync(path.join(root, 'standalone'))) {
    return root;
  }
  return path.join(root, '..');
}

function _initCoreLoggingAndStdio(state) {
  state.logLine = (line) => logger.logLine(line);

  state.initLog = () => {
    const res = logger.initLog({
      app,
      mode: state.MODE,
      e2e: state.AUTOTEST || process.env.CREWPANE_E2E === '1',
    });
    state.LOG_PATH = res.logPath;
    state.LOG_TARGET = res.logTarget;
    return res;
  };

  agentSettings.setPersistLogger((line) => state.logLine(`[settings] ${line}`));

  const stdioGuards = stdioGuard.installStdioGuards({
    proc: process,
    log: (msg) => {
      try { if (state.LOG_PATH) fs.appendFileSync(state.LOG_PATH, `[stdio] ${msg}\n`); } catch { /* best-effort */ }
    },
    onFatal: (err) => {
      if (state.faultService) {
        state.faultService.reportModuleFault({
          module: 'main',
          label: 'uncaughtException',
          message: String((err && err.message) || err),
          location: moduleGuard.faultLocation(err),
          count: 1,
          stopped: false,
          fatal: true,
          at: Date.now(),
        }, { stack: err && err.stack });
      }
      if (!state.appWindow || state.appWindow.isDestroyed()) {
        try {
          dialog.showErrorBox('A JavaScript error occurred in the main process', String((err && err.stack) || err));
        } catch { /* pre-ready / headless */ }
      }
    },
  });
  logger.setStdoutGuard(() => stdioGuards.canWriteStdout());
}

function _createSystemServicesGroup(state, bootstrapCtx) {
  const { REPO_ROOT, ENV_PROFILE, APP_URL_SCHEME } = state;

  state.integrityService = createIntegrityService({
    integrityCheck,
    tamperSignals,
    instancePaths,
    isCustomerBuild: () => require('../config/buildChannel.cjs').isCustomerBuild(),
    resourcesPath: process.resourcesPath || null,
    logLine: (line) => state.logLine(line),
    analyticsNow: () => (state.telemetryService ? state.telemetryService.analyticsNow() : null),
    obsReporterNow: () => (state.faultService ? state.faultService.obsReporterNow() : null),
  });

  state.secretRedactor = createSecretRedactor({ mask: integrationCatalog.maskSecret });

  state.backendEnvService = createBackendEnvService({
    repoRoot: REPO_ROOT,
    publicBackendEnv,
    backendTarget,
    appDbIdentity,
    envProfileModule,
    mixedTargetGuard,
    devChannel: require('../config/devChannel.cjs'),
    crewpaneIdConfig,
    instancePaths,
    getSeatGate: () => (state.authService ? state.authService.getSeatGate() : null),
    seatDenial: (act) => (state.authService ? state.authService.seatDenial(act) : null),
    logLine: state.logLine,
    envProfile: ENV_PROFILE,
    appUrlScheme: APP_URL_SCHEME,
    app,
    dialog,
  });

  const sysBundle = createSystemServicesBundle({
    app,
    BrowserWindow,
    dialog,
    nativeImage,
    logLine: state.logLine,
    getSeatGate: () => (state.authService ? state.authService.getSeatGate() : null),
    getBoundAccount: () => (state.authService ? state.authService.getBoundAccount() : null),
    backendEnvService: state.backendEnvService,
    getAgentWorkspaceRoot: () => state.agentWorkspaceRoot,
    getMemoryIndexer: () => (state.memoryService ? state.memoryService.memoryIndexer() : null),
    getLogPath: () => state.LOG_PATH,
    repoRoot: REPO_ROOT,
  });
  Object.assign(state, sysBundle);

  state.faultService = createFaultService({
    app,
    getAppWindow: () => state.appWindow,
    logLine: state.logLine,
    telemetryEnvNow: () => state.telemetryService.telemetryEnvNow(),
    telemetryEnabledNow: () => state.telemetryService.telemetryEnabledNow(),
    appRoot: path.resolve(REPO_ROOT, '..'),
  });

  state.resourceGovernorService = createResourceGovernorService({
    agentSettings,
    getAppWindow: () => state.appWindow,
    logLine: state.logLine,
  });

  state.crashWatchdogService = createCrashWatchdogService({
    app,
    BrowserWindow,
    ptys: state.ptys,
    logLine: state.logLine,
    resourceGovernor: () => state.resourceGovernorService.resourceGovernor(),
    crashWatchdog,
  });
}

function _createTerminalAndAgentsGroup(state) {
  const { REPO_ROOT, ptys, logLine } = state;

  const termBundle = createTerminalServicesBundle({
    ptys,
    crewpaneHome: () => state.crewpaneHome(),
    logLine,
    getAppWindow: () => state.appWindow,
    reportModuleFault: (f) => (state.faultService ? state.faultService.reportModuleFault(f) : null),
    planLimitService: () => (state.planLimitService || null),
    isRestoreDisabled: () => state.RESTORE_DISABLED,
    isAppProbe: () => state.APP_PROBE,
    getMode: () => state.MODE,
    isAutoresumeDisabled: () => state.AUTORESUME_DISABLED,
    limitResume02: state.LIMIT_RESUME_02,
    getAgentWorkspaceRoot: () => state.agentWorkspaceRoot,
    isPackaged: () => app.isPackaged,
    repoRoot: REPO_ROOT,
    getDepartmentDirs: () => agentSettings.readSettings().departmentDirs || [],
    readSettings: () => agentSettings.readSettings() || {},
    appI18n,
    integrationService: () => state.integrationService || null,
    codeIndexService: () => state.codeIndexService || null,
    getDelegationBridge: () => (state.delegationBridgeService ? state.delegationBridgeService.getBridge() : null),
    publicSupabaseEnv: () => state.backendEnvService.publicSupabaseEnv(),
    memoryService: () => state.memoryService || null,
    delegationSupervisorService: () => state.delegationSupervisorService || null,
    sendPaneEvent: (win, id, ch, p) => (state.windowManager ? state.windowManager.sendPaneEvent(win, id, ch, p) : null),
    jarvisWidgetAlive: () => (state.windowManager ? state.windowManager.jarvisWidgetAlive() : false),
    invalidateGitBranchCache,
    isQuitting: () => Boolean(app.isQuitting),
    isAutotest: () => state.AUTOTEST,
    hasMobileSubscribers: () => (state.mobileService && state.mobileService.mobileSubscribers ? state.mobileService.mobileSubscribers.size > 0 : false),
    emitMobileEvent: (evt) => (state.mobileService ? state.mobileService.emitMobileEvent(evt) : null),
    getJarvisConv: () => state.jarvisConv || null,
    appVersion: () => app.getVersion(),
    secretRedactor: () => state.secretRedactor || null,
    BrowserWindow,
    agentSettings,
    agentRunner,
  });
  Object.assign(state, termBundle);

  state.delegationSupervisorService = createDelegationSupervisorService({
    ptys,
    crewpaneHome: () => state.crewpaneHome(),
    logLine,
    getAppWindow: () => state.appWindow,
    planDenial: (feat, count, opts) => state.planLimitService.planDenial(feat, count, opts),
    supervisorFor: (name) => state.faultService.supervisorFor(name),
    resolveWorkerNotifyPath: (dept) => state.ptyResumeService.resolveWorkerNotifyPath(dept),
    rendererSupabaseTarget: () => state.backendEnvService.rendererSupabaseTarget(),
    appDbTokenFor: (action) => state.backendEnvService.appDbTokenFor(action),
    telemetryBump: (key, by, props) => state.telemetryService.telemetryBump(key, by, props),
    resetCommandFor: (cmd) => state.paneControlService.resetCommandFor(cmd),
    maxTasksPerSession: 10,
    killPane: (id, entry, aid, why) => state.paneControlService.killPane(id, entry, aid, why),
    probeTranscriptVerdict: (paneId, needle, opts) => state.paneTranscriptService.probeTranscriptVerdict(paneId, needle, opts),
    probeTranscriptVerifiable: (paneId) => state.paneTranscriptService.probeTranscriptVerifiable(paneId),
  });

  state.memoryService = createMemoryService({
    repoRoot: REPO_ROOT,
    getAgentWorkspaceRoot: () => state.agentWorkspaceRoot,
    getAppWindow: () => state.appWindow,
    logLine,
    agentRunner,
    agentSettings,
  });

  state.browserService = createBrowserService({
    getAppWindow: () => state.appWindow,
    logLine,
    saveBrowserShot: (b64, tag) => state.mediaService.saveBrowserShot(b64, tag),
    getAppWindowGuest: () => state.appWindowGuest,
    setAppWindowGuest: (g) => { state.appWindowGuest = g; },
    browserCdp,
    browserGateMod,
  });
}

function _createAuthAndWorkspaceServices(state) {
  const { REPO_ROOT, ptys, logLine, APP_URL_PREFIX } = state;

  const authBundle = createAuthServicesBundle({
    app,
    shell,
    instancePaths,
    ptys,
    agentSettings,
    appI18n,
    logLine,
    getAppWindow: () => state.appWindow,
    analyticsNow: () => state.telemetryService.analyticsNow(),
    integrityReportOnce: () => state.integrityService.integrityReportOnce(),
    paneQueryService: state.paneQueryService,
    livePaneRegistry,
    crewpaneHome: () => state.crewpaneHome(),
    noteQuit: (r) => state.noteQuit(r),
    armQuitBrake: (r) => state.armQuitBrake(r),
    resourceGovernorService: state.resourceGovernorService,
    appUrlPrefix: APP_URL_PREFIX,
    isAutomatedSession: state.IS_AUTOMATED_SESSION,
    automatedSessionReason: state.AUTOMATED_SESSION_REASON,
    engineRegistry,
    modelCatalog,
    providers,
    credentialGate,
    agentRunner,
    repoRoot: REPO_ROOT,
    testSeamDeps: {
      updateCheck,
      supervisorPushRenderer: (c, p) => state.delegationSupervisorService.supervisorPushRenderer(c, p),
      planWaveLimit: (r) => state.planLimitService.planWaveLimit(r),
      spawnPty: (win, opts) => state.ptySpawnService.spawnPty(win, opts),
      ptys,
      livePaneRegistry,
      crewpaneHome: () => state.crewpaneHome(),
      killPane: (id, e, aid, r) => state.paneControlService.killPane(id, e, aid, r),
      mobilePlanDenial: (opts) => (state.mobileService ? state.mobileService.mobilePlanDenial(opts) : null),
      designPlanDenial: ({ notify = true } = {}) => state.planLimitService.planDenial('designMode', 0, { notify }),
      BrowserWindow,
      getRestoreSkippedByPlan: () => state.paneRestoreService.getRestoreSkippedByPlan(),
      getSupervisorAdvanceBlocked: () => state.delegationSupervisorService.getSupervisorAdvanceBlocked(),
    },
  });
  Object.assign(state, authBundle);

  state.integrationService = createIntegrationService({
    instancePaths,
    safeStorage: require('electron').safeStorage,
    logLine,
    secretRedactor: state.secretRedactor,
    credentialGate,
    repoRoot: REPO_ROOT,
    vendorSurface,
    engineAuth,
    getPtys: () => ptys,
    agentRunner,
  });

  const wsBundle = createWorkspaceServicesBundle({
    app,
    BrowserWindow,
    dialog,
    ptys,
    agentSettings,
    crewpaneHome: () => state.crewpaneHome(),
    getAgentWorkspaceRoot: () => state.agentWorkspaceRoot,
    setAgentWorkspaceRoot: (val) => { state.agentWorkspaceRoot = val; },
    planLimitService: () => (state.planLimitService || null),
    invalidateGitBranchCache,
    appI18n,
    logLine,
    repoRoot: REPO_ROOT,
    forceFirstRun: state.FORCE_FIRST_RUN,
  });
  Object.assign(state, wsBundle);
}

function _createWindowAndServerServices(state) {
  const { REPO_ROOT, ptys, logLine } = state;

  state.nextServerManager = createNextServerManager({
    app,
    repoRoot: REPO_ROOT,
    logLine,
    noteQuit: state.noteQuit,
    getAgentWorkspaceRoot: () => state.agentWorkspaceRoot,
    crewpaneHome: state.crewpaneHome,
    crewpaneEnv,
    mappedProjectRootsForReports: () => state.ptyIsolationService.mappedProjectRootsForReports(state.agentWorkspaceRoot),
  });

  state.rebuildService = createRebuildService({
    app,
    repoRoot: REPO_ROOT,
    logLine,
    relaunchApp: (reason) => state.authService.relaunchApp(reason),
  });

  state.handService = createHandService({
    BrowserWindow,
    screen,
    systemPreferences: require('electron').systemPreferences,
    globalShortcut,
    getAppWindow: () => state.appWindow,
    openHandDetectWindow: () => state.windowManager.openHandDetectWindow(),
    handDetectAlive: () => state.windowManager.handDetectAlive(),
    feedHandOverlay: (raw) => state.windowManager.feedHandOverlay(raw),
    handOverlayPrefs: () => state.windowManager.handOverlayPrefs(),
    handTuningConfig: (prefs) => state.windowManager.handTuningConfig(prefs),
    agentSettings,
    logLine,
  });

  state.windowManager = createWindowManager({
    backendEnvService: state.backendEnvService,
    applyAppLocale: () => state.appLocaleService.applyAppLocale(),
    isTest: instancePaths.isTest(),
    crewpaneHome: state.crewpaneHome,
    APP_PROBE: state.APP_PROBE,
    PROBE_WAIT: state.PROBE_WAIT,
    PROBE_CLICKS: state.PROBE_CLICKS,
    PROBE_PATH: state.PROBE_PATH,
    START_PATH: state.START_PATH,
    AUTOTEST: state.AUTOTEST,
    getAppWindow: () => state.appWindow,
    setAppWindow: (w) => { state.appWindow = w; },
    getAppBaseUrl: () => state.appBaseUrl,
    setAppBaseUrl: (u) => { state.appBaseUrl = u; },
    setPanesRestored: (val) => { state.paneRestoreService.setPanesRestored(val); },
    getAgentWorkspaceRoot: () => state.agentWorkspaceRoot,
    logLine,
    rebindOrphanPanes: (win) => state.paneQueryService.rebindOrphanPanes(win),
    restoreLivePanes: (win) => state.paneRestoreService.restoreLivePanes(win),
    startPtyResumeDaemonOnce: () => state.ptyResumeService.startPtyResumeDaemonOnce(),
    ptys,
    noteQuit: state.noteQuit,
    keepPanesAliveOnWindowClose: () => state.paneQueryService.keepPanesAliveOnWindowClose(),
    liveAgentPaneCount: () => state.paneQueryService.liveAgentPaneCount(),
    killPtysForWindow: (winId) => state.paneQueryService.killPtysForWindow(winId),
    armQuitBrake: state.armQuitBrake,
    activeWorktreePaths: () => state.ptyIsolationService.activeWorktreePaths(),
    mappedProjectRootsForReports: () => state.ptyIsolationService.mappedProjectRootsForReports(state.agentWorkspaceRoot),
    browserGuests: state.browserService.browserGuests,
    ghostGuests: () => state.browserService.ghostGuests,
    guestOwners: state.browserService.guestOwners,
    agentGuests: state.browserService.agentGuests,
    getPendingAgentTabs: () => state.browserService.pendingAgentTabs,
    getAppWindowGuest: () => state.appWindowGuest,
    setAppWindowGuest: (g) => { state.appWindowGuest = g; },
    lastUnownedGuest: () => state.browserService.lastUnownedGuest(),
    getHandControl: () => state.handService.handControl,
    stopHandControl: (why) => state.handService.stopHandControl(why),
    broadcastHandControlStatus: () => state.handService.broadcastHandControlStatus(),
  });
}

function _createVoiceMobileAndSyncServices(state) {
  const { REPO_ROOT, ptys, logLine } = state;

  const jarvisConvService = createJarvisConversationService({
    jarvisConversationMod,
    logLine,
    BrowserWindow,
    emitMobileEvent: (event) => (state.mobileService ? state.mobileService.emitMobileEvent(event) : null),
  });
  state.jarvisConv = jarvisConvService.conversation;

  state.mobileService = createMobileService({
    app,
    ptys,
    getAppWindow: () => state.appWindow,
    rendererSupabaseTarget: () => state.backendEnvService.rendererSupabaseTarget(),
    getMobileAppDbToken: () => state.backendEnvService.mobileAppDbToken(),
    planDenial: (f, c, o) => state.planLimitService.planDenial(f, c, o),
    delegationBridgeMod,
    secretRedactor: state.secretRedactor,
    currentSessionId: (id) => state.paneTranscriptService.currentSessionId(id),
    agentRunner,
    jarvisVoice,
    jarvisConv: state.jarvisConv,
    logLine,
    repoRoot: REPO_ROOT,
    shellCommit: state.SHELL_COMMIT,
    standaloneDir: () => state.nextServerManager.standaloneDir(),
  });

  state.syncService = createSyncService({
    agentSettings,
    getBoundAccount: () => state.authService.getBoundAccount(),
    getAgentWorkspaceRoot: () => state.agentWorkspaceRoot,
    publicSupabaseEnv: () => state.backendEnvService.publicSupabaseEnv(),
    getSeatGate: () => state.authService.getSeatGate(),
    appDbTokenFor: (action) => state.backendEnvService.appDbTokenFor(action),
    pushPlanLimit: (denial) => state.planLimitService.pushPlanLimit(denial),
    logLine,
    broadcastLocale: () => state.appLocaleService.broadcastLocale(),
    getAppWindow: () => state.appWindow,
    getPopoutWindows: () => (state.windowManager ? state.windowManager.popoutWindows : new Map()),
  });

  registerPrefsIpc({
    ipcMain,
    prefsProjector: () => state.syncService.prefsProjector(),
    logLine,
  });

  const dictationDelivery = createDictationDeliveryService({
    BrowserWindow,
    getAppWindow: () => state.appWindow,
    logLine,
  });
  state.deliverDictationToFocusedSurface = dictationDelivery.deliverDictationToFocusedSurface;

  state.teamComposeService = createTeamComposeService({
    agentSettings,
    seatGate: {
      state: () => (state.authService && state.authService.getSeatGate() ? state.authService.getSeatGate().state() : null),
    },
    paneControlService: state.paneControlService,
    ptys,
    getAppWindow: () => state.appWindow,
    logLine,
  });

  state.delegationBridgeService = createDelegationBridgeService({
    delegationBridgeMod,
    crewpaneEnv,
    crewpanePaths,
    resolveWindow: () => state.appWindow,
    logLine,
    ipcMain,
    runBrowserAction: (val) => state.browserService.runBrowserAction(val),
    probeBrowserTarget: (val) => state.browserService.probeBrowserTarget(val),
    getBrowserGate: () => state.browserService.browserGate(),
    paneControlService: state.paneControlService,
    teamComposeService: state.teamComposeService,
    delegationSupervisorService: state.delegationSupervisorService,
    telemetryService: state.telemetryService,
    mediaService: state.mediaService,
    ptyResumeService: state.ptyResumeService,
    getAgentWorkspaceRoot: () => state.agentWorkspaceRoot,
    mobileService: state.mobileService,
    notifyLog,
    appDbTokenFor: (source) => state.backendEnvService.appDbTokenFor(source),
    integrationsStatusFor: (req) => state.integrationService.integrationsStatusFor(req),
    seatDenial: (action) => state.authService.seatDenial(action),
    planWaveLimit: (requested) => state.planLimitService.planWaveLimit(requested),
    deliverDictationToFocusedSurface: (text) => state.deliverDictationToFocusedSurface(text),
  });
}

function _collectRuntimeIpcDeps(state) {
  return {
    ptys: state.ptys,
    crewpaneHome: state.crewpaneHome,
    logLine: state.logLine,
    appWindow: state.appWindow,
    appBaseUrl: state.appBaseUrl,
    windowManager: state.windowManager,
    APP_URL_SCHEME: state.APP_URL_SCHEME,
    APP_URL_PREFIX: state.APP_URL_PREFIX,
    MODE: state.MODE,
    REPO_ROOT: state.REPO_ROOT,
    LOG_PATH: state.LOG_PATH,
    agentWorkspaceRoot: state.agentWorkspaceRoot,
    gitBranchCache,
    GIT_BRANCH_TTL_MS,
    invalidateGitBranchCache,
    schemeVerdict: state.schemeVerdict,
    IS_AUTOMATED_SESSION: state.IS_AUTOMATED_SESSION,
    AUTOMATED_SESSION_REASON: state.AUTOMATED_SESSION_REASON,
    secretBackendState,
    updateCheck,
    noteQuit: state.noteQuit,
    jarvisConv: state.jarvisConv,
    setAppWindowGuest: (g) => { state.appWindowGuest = g; },
    getAppWindowGuest: () => state.appWindowGuest,
    authService: state.authService,
    authUrlService: state.authUrlService,
    planLimitService: state.planLimitService,
    apiKeyService: state.apiKeyService,
    workspaceFileService: state.workspaceFileService,
    workspaceRootService: state.workspaceRootService,
    codeIndexService: state.codeIndexService,
    paneQueryService: state.paneQueryService,
    paneControlService: state.paneControlService,
    ptySpawnService: state.ptySpawnService,
    ptyIsolationService: state.ptyIsolationService,
    ptyResumeService: state.ptyResumeService,
    paneRestoreService: state.paneRestoreService,
    paneBudgetService: state.paneBudgetService,
    paneTranscriptService: state.paneTranscriptService,
    paneDispatchService: state.paneDispatchService,
    paneAskService: state.paneAskService,
    resourceGovernorService: state.resourceGovernorService,
    telemetryService: state.telemetryService,
    updateService: state.updateService,
    announceService: state.announceService,
    changelogService: state.changelogService,
    resetBootService: state.resetBootService,
    doctorService: state.doctorService,
    appLocaleService: state.appLocaleService,
    backendEnvService: state.backendEnvService,
    browserService: state.browserService,
    integrationService: state.integrationService,
    handService: state.handService,
    mobileService: state.mobileService,
    syncService: state.syncService,
    memoryService: state.memoryService,
    mediaService: state.mediaService,
    faultService: state.faultService,
    rebuildService: state.rebuildService,
    teamComposeService: state.teamComposeService,
    delegationSupervisorService: state.delegationSupervisorService,
    secretRedactor: state.secretRedactor,
  };
}

function _buildLifecycleDeps(state, bootstrapCtx, wireIpc) {
  return {
    startupGateDeps: {
      app,
      dialog,
      singleInstanceGate: bootstrapCtx.singleInstanceGate,
      singleInstanceEarlyLog: bootstrapCtx.singleInstanceEarlyLog,
      resetGate,
      resetBootService: state.resetBootService,
      resetT: (k) => state.resetBootService.resetT(k),
      logEnvBannerAndGuard: () => state.backendEnvService.logEnvBannerAndGuard(),
      applyAppLocale: () => state.appLocaleService.applyAppLocale(),
      initLog: () => state.initLog(),
      logLine: (line) => state.logLine(line),
      crewpaneHome: () => state.crewpaneHome(),
      logTarget: () => state.LOG_TARGET,
      logPath: () => state.LOG_PATH || '',
    },
    bootDeps: {
      paneRestoreService: state.paneRestoreService,
      getAppWindow: () => state.appWindow,
      logLine: state.logLine,
      crashWatchdogService: state.crashWatchdogService,
      app,
      startupSweepService: state.startupSweepService,
      workspaceFileService: state.workspaceFileService,
      crewpaneHome: state.crewpaneHome,
      repoRoot: state.REPO_ROOT,
      nextServerManager: state.nextServerManager,
      setSchemeVerdict: (v) => { state.schemeVerdict = v; },
      safeStorageScope: bootstrapCtx.safeStorageScope,
      secretBackendState,
      instanceHome: instancePaths.instanceHome(),
      authService: state.authService,
      syncService: state.syncService,
      authUrlService: state.authUrlService,
      workspaceRootService: state.workspaceRootService,
      wireIpc,
      resourceGovernorService: state.resourceGovernorService,
      windowManager: state.windowManager,
      autotest: state.AUTOTEST,
      noteQuit: state.noteQuit,
      registerJarvisShortcut: () => state.registerJarvisShortcut(),
      handService: state.handService,
      updateService: state.updateService,
      announceService: state.announceService,
      changelogService: state.changelogService,
      memoryService: state.memoryService,
      notifyScreenshotsMovedOnce: () => state.notifyScreenshotsMovedOnce(),
      doctorService: state.doctorService,
      telemetryService: state.telemetryService,
      faultService: state.faultService,
      faultInject: state.FAULT_INJECT,
      mode: state.MODE,
      delegationBridgeService: state.delegationBridgeService,
      mobileService: state.mobileService,
    },
    lifecycleDeps: {
      app,
      authService: state.authService,
      isAutotest: state.AUTOTEST,
      crewpaneHome: () => state.crewpaneHome(),
      armQuitBrake: (label) => state.armQuitBrake(label),
      crashWatchdogService: state.crashWatchdogService,
      paneQueryService: state.paneQueryService,
      nextServerManager: state.nextServerManager,
      noteQuit: (reason, signal) => state.noteQuit(reason, signal),
      getLivePaneCount: () => state.ptys.size,
      getQuitReason: () => state.quitReason,
      getQuitSignal: () => state.quitSignal,
      appStartedAt: state.APP_STARTED_AT,
      logLine: state.logLine,
      ptyResumeService: state.ptyResumeService,
      delegationBridgeService: state.delegationBridgeService,
      delegationSupervisorService: state.delegationSupervisorService,
    },
  };
}

function _initContainerState(bootstrapCtx) {
  const REPO_ROOT = resolveRepoRoot();
  const FORCE_FIRST_RUN = crewpaneEnv.readEnv('FORCE_FIRST_RUN') === '1';

  const state = {
    REPO_ROOT,
    FORCE_FIRST_RUN,
    APP_URL_SCHEME: appScheme(),
    APP_URL_PREFIX: appSchemePrefix(),
    ENV_PROFILE: bootstrapCtx.envProfile,
    SHELL_COMMIT: bootstrapCtx.shellCommit,
    appWindow: null,
    appBaseUrl: null,
    appWindowGuest: null,
    schemeVerdict: null,
    quitReason: null,
    quitSignal: null,
    LOG_PATH: null,
    LOG_TARGET: null,
    ptys: new Map(),
    quitBrakeState: {},
    QUIT_BRAKE_MS: 5000,
    APP_STARTED_AT: Date.now(),
    RESTORE_DISABLED: process.env.CREWPANE_DISABLE_RESTORE === '1',
    AUTORESUME_DISABLED: process.env.CREWPANE_DISABLE_AUTORESUME === '1',
    LIMIT_RESUME_02: process.env.CREWPANE_LIMIT_RESUME_02 !== '0',
    AUTOTEST: process.env.CREWPANE_SPIKE_AUTOTEST === '1',
    APP_PROBE: process.env.CREWPANE_APP_PROBE === '1',
    PROBE_PATH: process.env.CREWPANE_PROBE_PATH || '',
    START_PATH: '/workspace',
    PROBE_WAIT: Number(process.env.CREWPANE_PROBE_WAIT || 200),
    PROBE_CLICKS: Number(process.env.CREWPANE_PROBE_CLICKS || 0),
    FAULT_INJECT: String(process.env.CREWPANE_FAULT_INJECT || '').split(',').map((s) => s.trim()).filter(Boolean),
    IS_AUTOMATED_SESSION: isAutomatedSession(process.env),
    AUTOMATED_SESSION_REASON: automatedSessionReason(process.env),
    JARVIS_SHORTCUT: 'CommandOrControl+Shift+J',
    crewpaneHome: () => process.env.CREWPANE_HOME || os.homedir(),
    agentWorkspaceRoot: agentSettings.resolveWorkspaceRoot(app.isPackaged || FORCE_FIRST_RUN ? null : REPO_ROOT),
  };

  const resolveMode = () => {
    if (state.AUTOTEST) return 'spike';
    const env = process.env.CREWPANE_MODE;
    if (env === 'dev' || env === 'prod' || env === 'spike') return env;
    return app.isPackaged ? 'prod' : 'dev';
  };
  state.MODE = resolveMode();

  state.armQuitBrake = (label) => quitFunnel.armForceExit(state.quitBrakeState, {
    ms: state.QUIT_BRAKE_MS,
    log: state.logLine,
    exit: (code) => app.exit(code),
    label,
  });

  state.noteQuit = (reason, signal) => {
    if (state.quitReason) return state.quitReason;
    state.quitReason = reason || 'unknown';
    if (signal) state.quitSignal = signal;
    try { state.logLine(`[crash-r1] kapanış sebebi: ${state.quitReason}${signal ? ` (${signal})` : ''}`); } catch { /* ignore */ }
    return state.quitReason;
  };

  require('../core/e2eParentWatchdog.cjs').armE2EParentWatchdog({
    quit: () => { state.noteQuit('watchdog', 'e2e-parent-gone'); app.quit(); },
  });

  state.notifyScreenshotsMovedOnce = () => {
    try {
      const marker = path.join(instancePaths.instanceHome(), 'screenshots-moved-notice.json');
      if (fs.existsSync(marker)) return;
      const legacyShots = path.join(instancePaths.instanceHome(), 'shots');
      const used = fs.existsSync(legacyShots) && fs.readdirSync(legacyShots).some((f) => f.toLowerCase().endsWith('.png'));
      if (used) {
        new Notification({
          title: appI18n.t('main.notify.screenshotsMoved.title'),
          body: appI18n.t('main.notify.screenshotsMoved.body'),
        }).show();
        state.logLine('screenshots-moved notice shown (one-time)');
      }
      fs.writeFileSync(marker, JSON.stringify({ notifiedAt: new Date().toISOString(), usedFeature: used }));
    } catch (e) { state.logLine(`screenshots-moved notice error: ${e.message}`); }
  };

  state.registerJarvisShortcut = () => {
    try {
      const ok = globalShortcut.register(state.JARVIS_SHORTCUT, () => {
        state.logLine('global shortcut fired → jarvis toggle');
        try {
          if (state.appWindow && !state.appWindow.isDestroyed()) state.appWindow.webContents.send('jarvis:hotkey');
        } catch (e) { state.logLine(`jarvis hotkey send error: ${e.message}`); }
      });
      state.logLine(`globalShortcut '${state.JARVIS_SHORTCUT}' registered=${ok}`);
    } catch (e) { state.logLine(`jarvis globalShortcut register error: ${e.message}`); }
  };

  state.handleFocusWindow = (record) => {
    try {
      if (state.authUrlService) state.authUrlService.consumeArgvDeepLink(record && record.argv, 'focus-request');
    } catch (e) {
      try { process.stderr.write(`[single-instance] deep-link error: ${e.message}\n`); } catch { /* ignore */ }
    }
    try {
      let win = state.appWindow;
      if (!win || win.isDestroyed()) {
        if (!state.appBaseUrl) {
          process.stderr.write('[single-instance] odak isteği geldi ama pencere henüz yok (açılış sürüyor)\n');
          return;
        }
        state.logLine('[single-instance] odak isteği: ana pencere kapalıydı — yeniden açılıyor');
        if (state.windowManager) state.windowManager.createAppWindow(state.appBaseUrl);
        win = state.appWindow;
        if (!win || win.isDestroyed()) return;
      }
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      try { win.flashFrame(true); } catch { /* best-effort */ }
    } catch (e) {
      try { process.stderr.write(`[single-instance] focus error: ${e.message}\n`); } catch { /* ignore */ }
    }
  };

  return state;
}

function createAppContainer(bootstrapCtx = {}) {
  const state = _initContainerState(bootstrapCtx);

  _initCoreLoggingAndStdio(state);
  _createSystemServicesGroup(state, bootstrapCtx);
  _createTerminalAndAgentsGroup(state);
  _createAuthAndWorkspaceServices(state);
  _createWindowAndServerServices(state);
  _createVoiceMobileAndSyncServices(state);

  const wireIpc = () => createMainIpcWiring(_collectRuntimeIpcDeps(state)).wireIpc();
  const lifecycleDepsBundle = _buildLifecycleDeps(state, bootstrapCtx, wireIpc);

  setupLifecycleServices({
    app,
    ...lifecycleDepsBundle,
  });

  return {
    handleFocusWindow: state.handleFocusWindow,
    ptys: state.ptys,
    getAppWindow: () => state.appWindow,
    getAppBaseUrl: () => state.appBaseUrl,
  };
}

module.exports = {
  createAppContainer,
};
