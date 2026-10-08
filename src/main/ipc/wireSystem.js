'use strict';

const {
  registerEngineIpc,
  registerEngineAuthIpc,
  registerEngineProfilesIpc,
  registerAccountIpc,
  registerPlanIpc,
} = require('../../features/auth');
const {
  registerSettingsIpc,
  registerTelemetryIpc,
  registerDiagnosticsIpc,
  registerAppIpc,
} = require('../../features/system');

/**
 * Wires Diagnostics, Telemetry, Account, Plan, Settings, Engine, and App IPC handlers.
 * (Faz 3.6.4 — Wire IPC Modularization)
 */
function wireSystemIpc(deps) {
  const {
    ipcMain,
    app,
    shell,
    agentSettings,
    logLine,
    REPO_ROOT,
    instancePaths,
    supervisorFor,
  } = deps;

  // Diagnostics IPC
  registerDiagnosticsIpc({
    ipcMain,
    getModuleFaults: deps.getModuleFaults,
    reportModuleFault: deps.reportModuleFault,
    getLogPath: deps.getLogPath,
    shell,
  });

  // Telemetry IPC
  registerTelemetryIpc({
    ipcMain,
    analyticsNow: deps.analyticsNow,
    analyticsSchema: deps.analyticsSchema,
    analyticsFirstTime: deps.analyticsFirstTime,
    supervisorFor,
    logLine,
    telemetryTokenFor: deps.telemetryTokenFor,
    credentialGate: deps.credentialGate,
    telemetryProvisioning: deps.telemetryProvisioning,
    stampIntegrationVerified: deps.stampIntegrationVerified,
    vendorSurface: deps.vendorSurface,
    telemetryMod: deps.telemetryMod,
    provisionStoreMod: deps.provisionStoreMod,
    telemetryChannelMod: deps.telemetryChannelMod,
  });

  // Account IPC
  const accountState = deps.getAccountState || (() => {
    const seatGate = deps.getSeatGate();
    return seatGate ? seatGate.evaluate() : {
      requireSeat: false,
      requireLogin: deps.crewpaneIdConfig(process.env).requireLogin,
      signedIn: false,
      email: null,
      userId: null,
      licenseStatus: 'none',
      seat: false,
      tier: null,
      tierLabel: null,
      tierRank: 0,
      caps: null,
      accessProducts: [],
      products: [],
      productLabels: deps.planCatalog ? deps.planCatalog.productLabels() : [],
      graceRemainingSeconds: 0,
    };
  });

  registerAccountIpc({
    ipcMain,
    app,
    shell,
    getSeatGate: deps.getSeatGate,
    getAccountState: accountState,
    getAppUrlScheme: deps.getAppUrlScheme,
    getAppUrlPrefix: deps.getAppUrlPrefix,
    gateOverrides: deps.gateOverrides,
    logLine,
    runningPaneSummary: deps.runningPaneSummary,
    signOutConfirmCopy: deps.signOutConfirmCopy,
    closePanesForSignOut: deps.closePanesForSignOut,
    accountScope: deps.accountScope,
    getBoundAccount: deps.getBoundAccount,
    relaunchForAccountChange: deps.relaunchForAccountChange,
    instancePaths,
    schemeOwnership: deps.schemeOwnership,
    getSchemeVerdict: deps.getSchemeVerdict,
    setSchemeVerdict: deps.setSchemeVerdict,
    isAutomatedSession: deps.isAutomatedSession,
    automatedSessionReason: deps.automatedSessionReason,
    secretBackendState: deps.secretBackendState,
    handleAuthUrl: deps.handleAuthUrl,
    crewpaneIdConfig: deps.crewpaneIdConfig,
  });

  // Plan IPC
  registerPlanIpc({
    ipcMain,
    verifyAppApiKey: deps.verifyAppApiKey,
    planLimits: deps.planLimits,
    getSeatGate: deps.getSeatGate,
    getPtys: deps.getPtys,
    workspaceOnboarding: deps.workspaceOnboarding,
    crewpaneIdConfig: deps.crewpaneIdConfig,
    logLine,
    appDbTokenFor: deps.appDbTokenFor,
  });

  // Settings IPC
  registerSettingsIpc({
    ipcMain,
    onboardingStore: deps.onboardingStore,
    resetContext: deps.resetContext,
    installReset: deps.installReset,
    runningPaneSummary: deps.runningPaneSummary,
    resetGate: deps.resetGate,
    appI18n: deps.appI18n,
    signOutConfirmCopy: deps.signOutConfirmCopy,
    getSeatGate: deps.getSeatGate,
    closePanesForSignOut: deps.closePanesForSignOut,
    accountScope: deps.accountScope,
    sendResetTelemetry: deps.sendResetTelemetry,
    relaunchForAccountChange: deps.relaunchForAccountChange,
    agentSettings,
    getAgentWorkspaceRoot: deps.getAgentWorkspaceRoot,
    repoRoot: REPO_ROOT,
    workspaceOnboarding: deps.workspaceOnboarding,
    app,
    leaderRefreshPolicy: deps.leaderRefreshPolicy,
    handOverlayContract: deps.handOverlayContract,
    updateChannel: deps.updateChannel,
    currentUpdateChannel: deps.currentUpdateChannel,
    aiProvidersPayload: deps.aiProvidersPayload,
    engineModelCatalogPayload: deps.engineModelCatalogPayload,
    appApiKeysPayload: deps.appApiKeysPayload,
    jarvisVoice: deps.jarvisVoice,
    grokVoice: deps.grokVoice,
    engineCatalog: deps.engineCatalog,
    teamScope: deps.teamScope,
    browserTrustMod: deps.browserTrustMod,
    logLine,
    broadcastLocale: deps.broadcastLocale,
    getSyncRuntime: deps.getSyncRuntime,
    prefsProjectNow: deps.prefsProjectNow,
    applyHandOverlaySettings: deps.applyHandOverlaySettings,
    presetAdvisor: deps.presetAdvisor,
    agentRunner: deps.agentRunner,
  });

  // Engine Auth and Profile Helpers
  let activeLogin = null;

  const pushAuthEvent = (payload) => {
    const appWindow = deps.getAppWindow && deps.getAppWindow();
    if (appWindow && !appWindow.isDestroyed()) appWindow.webContents.send('engineAuth:changed', payload);
  };

  const profilesHome = () => instancePaths.crewpaneHome();
  const profileEnvFor = (engine, profileId) =>
    deps.engineProfiles.applyProfileEnv(process.env, profilesHome(), engine, profileId);
  const activeProfileOf = (engine) => deps.engineProfiles.activeProfileId(profilesHome(), engine);

  const authDeps = (engine, profileId) => ({
    env: profileEnvFor(engine, profileId),
    apiKeyStore: deps.engineKeyStore ? deps.engineKeyStore() : null,
    settings: agentSettings.readSettings(),
    log: (m) => logLine(deps.engineAuth.maskSecrets(m)),
    loginLedger: deps.engineLoginLedger.bindLedger(profilesHome(), engine, profileId),
  });

  const readProfileStatus = (engine, profileId) =>
    deps.engineAuth.readStatus(engine, authDeps(engine, profileId)).catch(() => null);

  const stampProfileIdentity = (engine, profileId, status, source) => {
    const identity = deps.engineProfiles.identityFromStatus(status, { source });
    if (!identity) return false;
    const r = deps.engineProfiles.setProfileIdentity(profilesHome(), engine, profileId, identity);
    if (r.ok) {
      logLine(`engine account identity stamped engine=${engine} profile=${profileId} source=${source} account=${deps.engineProfiles.maskAccount(identity.email || '')}`);
    }
    return r.ok;
  };

  const authEngineIds = () => deps.engineAuth.authEngines({ env: process.env });
  const pushProfilesEvent = () => {
    const appWindow = deps.getAppWindow && deps.getAppWindow();
    if (appWindow && !appWindow.isDestroyed()) appWindow.webContents.send('engineProfiles:changed', { at: Date.now() });
  };

  // Engine, Engine Auth, and Multi-Account Profiles IPC
  registerEngineIpc({
    ipcMain,
    engineCheck: deps.engineCheck,
    capabilityRegistry: deps.capabilityRegistry,
    paneCapabilityMatrix: deps.paneCapabilityMatrix,
    engineOffering: deps.engineOffering,
    engineDelegation: deps.engineDelegation,
    engineLeadership: deps.engineLeadership,
    enginePlanned: deps.enginePlanned,
    authEngineIds,
    readProfileStatus,
    activeProfileOf,
    authDeps,
    engineAuth: deps.engineAuth,
    logLine,
  });

  registerEngineAuthIpc({
    ipcMain,
    shell,
    engineAuth: deps.engineAuth,
    engineProfiles: deps.engineProfiles,
    authEngineIds,
    activeProfileOf,
    authDeps,
    pushAuthEvent,
    pushProfilesEvent,
    stampProfileIdentity,
    profilesHome,
    getActiveLogin: () => activeLogin,
    setActiveLogin: (val) => { activeLogin = val; },
    logLine,
  });

  registerEngineProfilesIpc({
    ipcMain,
    engineProfiles: deps.engineProfiles,
    engineAuth: deps.engineAuth,
    engineSwitch: deps.engineSwitch,
    limitDetect: deps.limitDetect,
    resumePtyDaemon: deps.resumePtyDaemon,
    livePaneRegistry: deps.livePaneRegistry,
    crewpaneHome: deps.crewpaneHome,
    profilesHome,
    authEngineIds,
    readProfileStatus,
    stampProfileIdentity,
    pushProfilesEvent,
    ptys: deps.ptys,
    getAppWindow: deps.getAppWindow,
    spawnPty: deps.spawnPty,
    killPane: deps.killPane,
    respawnOptsFromEntry: deps.respawnOptsFromEntry,
    agentEngineMirror: deps.agentEngineMirror,
    logLine,
  });

  // App, Doctor & Changelog IPC
  registerAppIpc({
    ipcMain,
    app,
    shell,
    mode: deps.mode,
    instancePaths,
    shellCommit: deps.shellCommit,
    getResetBootNotice: deps.getResetBootNotice,
    rebuildAndRelaunch: deps.rebuildAndRelaunch,
    demoSitePath: deps.demoSitePath,
    runDoctorNow: deps.runDoctorNow,
    firstRunDoctor: deps.firstRunDoctor,
    hookScanHome: deps.hookScanHome,
    getAgentWorkspaceRoot: deps.getAgentWorkspaceRoot,
    logLine,
    relaunchApp: deps.relaunchApp,
    changelogStateForRenderer: deps.changelogStateForRenderer,
    runChangelogCheck: deps.runChangelogCheck,
    getChangelogState: deps.getChangelogState,
    getLogPath: deps.getLogPath,
    noteQuit: deps.noteQuit,
  });
}

module.exports = {
  wireSystemIpc,
};
