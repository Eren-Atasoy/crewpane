'use strict';

const { createAccountBindingService } = require('./accountBindingService');
const { createSeatGateService } = require('./seatGateService');

/**
 * Unified Auth & Account Core Service (Faz 3.6.8)
 */
function createAuthService(deps = {}) {
  const {
    instancePaths,
    app,
    shell,
    safeStorage,
    logLine = () => {},
    getAppWindow = () => null,
    pushPlanLimit = () => {},
    testSeamDeps = {},
    integrityReportOnce = () => null,
    ptys = null,
    persistScreenTails = () => {},
    livePaneRegistry = null,
    crewpaneHome = () => '',
    killAllPtys = () => {},
    noteQuit = () => {},
    armQuitBrake = () => {},
    agentSettings,
    getResourceGovernor = () => null,
    appI18n,
  } = deps;

  const accountBindingService = createAccountBindingService({
    instancePaths,
    app,
    agentSettings,
    getResourceGovernor,
    ptys,
    persistScreenTails,
    livePaneRegistry,
    crewpaneHome,
    killAllPtys,
    noteQuit,
    armQuitBrake,
    logLine,
  });

  const seatGateService = createSeatGateService({
    app,
    shell,
    safeStorage,
    logLine,
    getAppWindow,
    instancePaths,
    pushPlanLimit,
    testSeamDeps,
    integrityReportOnce,
    reconcileAccountBinding: (snapshot) => accountBindingService.reconcileAccountBinding(snapshot),
  });

  return {
    initSeatGate: () => seatGateService.initSeatGate(),
    getSeatGate: () => seatGateService.getSeatGate(),
    getSeatGateReady: () => seatGateService.getSeatGateReady(),
    pushAccountState: (snapshot) => seatGateService.pushAccountState(snapshot),
    pushDeviceDenial: (snapshot) => seatGateService.pushDeviceDenial(snapshot),
    requireSeatOrThrow: (action) => seatGateService.requireSeatOrThrow(action, appI18n),
    seatDenial: (action) => seatGateService.seatDenial(action),

    getBoundAccount: () => accountBindingService.getBoundAccount(),
    bindAccountRoot: (reason) => accountBindingService.bindAccountRoot(seatGateService.getSeatGateReady(), reason),
    reconcileAccountBinding: (snapshot) => accountBindingService.reconcileAccountBinding(snapshot),
    runningPaneSummary: () => accountBindingService.runningPaneSummary(),
    signOutConfirmCopy: (panes) => accountBindingService.signOutConfirmCopy(panes),
    closePanesForSignOut: () => accountBindingService.closePanesForSignOut(),
    relaunchApp: (reason) => accountBindingService.relaunchApp(reason),
    relaunchForAccountChange: (nextKey, reason) => accountBindingService.relaunchForAccountChange(nextKey, reason),

    seatGateService,
    accountBindingService,
  };
}

module.exports = {
  createAuthService,
};
