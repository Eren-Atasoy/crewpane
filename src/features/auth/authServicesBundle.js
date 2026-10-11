'use strict';

const { createAuthService } = require('./service');
const { createPlanLimitService } = require('./planLimitService');
const { createAuthUrlService } = require('./authUrlService');
const { createApiKeyService } = require('./apiKeyService');

/**
 * Auth Services Domain Bundle (Phase 3.6.64)
 * Orchestrates authentication, license seats, plan limits, auth deep-links, and API key services.
 */
function createAuthServicesBundle(deps = {}) {
  let authServiceRef = null;

  const planLimitService = createPlanLimitService({
    getSeatGate: () => (authServiceRef ? authServiceRef.getSeatGate() : null),
    getAppWindow: () => deps.getAppWindow(),
    analyticsNow: () => (typeof deps.analyticsNow === 'function' ? deps.analyticsNow() : null),
    logLine: deps.logLine,
  });

  const authService = createAuthService({
    instancePaths: deps.instancePaths,
    app: deps.app,
    shell: deps.shell,
    safeStorage: deps.safeStorage,
    logLine: deps.logLine,
    getAppWindow: () => deps.getAppWindow(),
    pushPlanLimit: (denial) => planLimitService.pushPlanLimit(denial),
    integrityReportOnce: () => (typeof deps.integrityReportOnce === 'function' ? deps.integrityReportOnce() : null),
    ptys: deps.ptys,
    persistScreenTails: () => (deps.paneQueryService ? deps.paneQueryService.persistScreenTails() : null),
    livePaneRegistry: deps.livePaneRegistry,
    crewpaneHome: () => deps.crewpaneHome(),
    killAllPtys: () => (deps.paneQueryService ? deps.paneQueryService.killAllPtys() : null),
    noteQuit: (r) => (typeof deps.noteQuit === 'function' ? deps.noteQuit(r) : null),
    armQuitBrake: (r) => (typeof deps.armQuitBrake === 'function' ? deps.armQuitBrake(r) : null),
    agentSettings: deps.agentSettings,
    getResourceGovernor: () => (deps.resourceGovernorService ? deps.resourceGovernorService.resourceGovernor() : null),
    appI18n: deps.appI18n,
    testSeamDeps: deps.testSeamDeps,
  });
  authServiceRef = authService;

  const authUrlService = createAuthUrlService({
    app: deps.app,
    appUrlPrefix: deps.appUrlPrefix,
    getSeatGate: () => (authServiceRef ? authServiceRef.getSeatGate() : null),
    isAutomatedSession: deps.isAutomatedSession,
    automatedSessionReason: deps.automatedSessionReason,
    logLine: (line) => deps.logLine(line),
  });

  const apiKeyService = createApiKeyService({
    engineRegistry: deps.engineRegistry,
    modelCatalog: deps.modelCatalog,
    providers: deps.providers,
    credentialGate: deps.credentialGate,
    agentRunner: deps.agentRunner,
    repoRoot: deps.repoRoot,
    logLine: (line) => deps.logLine(line),
  });

  return {
    planLimitService,
    authService,
    authUrlService,
    apiKeyService,
  };
}

module.exports = {
  createAuthServicesBundle,
};
