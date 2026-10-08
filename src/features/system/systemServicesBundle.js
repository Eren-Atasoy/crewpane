'use strict';

const os = require('os');
const { safeStorage } = require('electron');
const appI18n = require('../../../i18n/index.cjs');
const agentSettings = require('../../agents/agentSettings.cjs');
const crewpaneEnv = require('../../config/crewpaneEnv.cjs');
const instancePaths = require('../../config/instancePaths.cjs');
const engineRegistry = require('../../agents/engineRegistry.cjs');
const engineCheck = require('../../agents/engineCheck.cjs');
const firstRunDoctor = require('../../agents/firstRunDoctor.cjs');
const secretBackendState = require('../../security/secretBackendState.cjs');
const credentialGate = require('../../security/requireCredential.cjs');
const installReset = require('../../security/installReset.cjs');
const resetGate = require('../../security/resetGate.cjs');
const helperReaper = require('../../core/helperReaper.cjs');
const updateCheck = require('../../services/updateCheck.cjs');
const updateChannel = require('../../services/updateChannel.cjs');
const announcements = require('../../services/announcements.cjs');
const changelogFeed = require('../../services/changelogFeed.cjs');
const tempImageStore = require('../../services/tempImageStore.cjs');
const attachmentStoreMod = require('../../services/attachmentStore.cjs');
const feedbackBridgeMod = require('../../services/feedbackBridge.cjs');
const jarvisVoice = require('../../voice/jarvisVoice.js');
const mcpProcess = require('../../mcp/mcpProcess.cjs');

const { createUpdateService } = require('../update');
const { createAppLocaleService } = require('./appLocaleService');
const { createAnnounceService } = require('./announceService');
const { createChangelogService } = require('./changelogService');
const { createResetBootService } = require('./resetBootService');
const { createMediaService } = require('./mediaService');
const { createDoctorService } = require('./doctorService');
const { createStartupSweepService } = require('./startupSweepService');
const { createTelemetryService } = require('./telemetryService');

function _createUpdateAndTelemetryServices(deps) {
  let updateService = null;
  let telemetryService = null;

  updateService = createUpdateService({
    app: deps.app,
    BrowserWindow: deps.BrowserWindow,
    instancePaths,
    agentSettings,
    updateCheck,
    updateChannel,
    logLine: deps.logLine,
    getSeatGate: () => (typeof deps.getSeatGate === 'function' ? deps.getSeatGate() : null),
    heartbeat: () => (telemetryService ? telemetryService.heartbeat() : null),
  });

  telemetryService = createTelemetryService({
    app: deps.app,
    instancePaths,
    agentSettings,
    crewpaneEnv,
    logLine: deps.logLine,
    getSeatGate: () => (typeof deps.getSeatGate === 'function' ? deps.getSeatGate() : null),
    appDbTokenFor: (action) => (deps.backendEnvService ? deps.backendEnvService.appDbTokenFor(action) : null),
    rendererSupabaseTarget: () => (deps.backendEnvService ? deps.backendEnvService.rendererSupabaseTarget() : null),
    currentUpdateChannel: () => (updateService ? updateService.currentUpdateChannel() : 'stable'),
    isAutoUpdaterActive: () => (updateService ? updateService.isAutoUpdaterActive() : false),
    resolveCredential: (service) => credentialGate.resolveCredential(service, { rootDir: deps.repoRoot }),
    engineRegistry,
    safeStorage,
  });

  const announceService = createAnnounceService({
    app: deps.app,
    BrowserWindow: deps.BrowserWindow,
    instancePaths,
    agentSettings,
    announcements,
    currentUpdateChannel: () => (updateService ? updateService.currentUpdateChannel() : 'stable'),
    logLine: deps.logLine,
  });

  return { updateService, telemetryService, announceService };
}

function _createLocaleAndDiagnosticServices(deps) {
  const appLocaleService = createAppLocaleService({
    app: deps.app,
    BrowserWindow: deps.BrowserWindow,
    appI18n,
    agentSettings,
    logLine: deps.logLine,
  });

  const changelogService = createChangelogService({
    BrowserWindow: deps.BrowserWindow,
    instancePaths,
    changelogFeed,
    logLine: deps.logLine,
  });

  const doctorService = createDoctorService({
    firstRunDoctor,
    crewpaneEnv,
    instancePaths,
    os,
    getSeatGate: () => (typeof deps.getSeatGate === 'function' ? deps.getSeatGate() : null),
    getRendererSupabaseTarget: () => (deps.backendEnvService ? deps.backendEnvService.rendererSupabaseTarget() : null),
    getEnvLayerView: () => (deps.backendEnvService ? deps.backendEnvService.envLayerView() : null),
    getIdentityMode: () => (deps.backendEnvService ? deps.backendEnvService.appDbIdentityMode().mode : null),
    getAgentWorkspaceRoot: () => (typeof deps.getAgentWorkspaceRoot === 'function' ? deps.getAgentWorkspaceRoot() : null),
    getWorkspaceStatus: () => agentSettings.configuredWorkspaceRootStatus(),
    getSecretBackend: () => secretBackendState.secretBackendState(),
    checkEngines: () => engineCheck.checkEngines(),
  });

  return { appLocaleService, changelogService, doctorService };
}

function _createMediaAndMaintenanceServices(deps, telemetryService) {
  const resetBootService = createResetBootService({
    app: deps.app,
    dialog: deps.dialog,
    appI18n,
    installReset,
    resetGate,
    helperReaper,
    analyticsNow: () => (telemetryService ? telemetryService.analyticsNow() : null),
  });

  const mediaService = createMediaService({
    nativeImage: deps.nativeImage,
    instancePaths,
    tempImageStore,
    attachmentStoreMod,
    feedbackBridgeMod,
    logLine: deps.logLine,
    getBoundAccount: () => (typeof deps.getBoundAccount === 'function' ? deps.getBoundAccount() : null),
    getLogPath: () => (typeof deps.getLogPath === 'function' ? deps.getLogPath() : null),
  });

  const startupSweepService = createStartupSweepService({
    getPublicSupabaseEnv: () => (deps.backendEnvService ? deps.backendEnvService.publicSupabaseEnv() : {}),
    agentSettings,
    getAgentWorkspaceRoot: () => (typeof deps.getAgentWorkspaceRoot === 'function' ? deps.getAgentWorkspaceRoot() : null),
    getMemoryIndexer: () => (typeof deps.getMemoryIndexer === 'function' ? deps.getMemoryIndexer() : null),
    jarvisVoice,
    mcpProcess,
    helperReaper,
    logLine: deps.logLine,
    autoIndexDelayMs: Number(process.env.CREWPANE_AUTO_INDEX_DELAY_MS || 15000),
  });

  return { resetBootService, mediaService, startupSweepService };
}

/**
 * System Services Domain Bundle (Phase 3.6.60)
 * Orchestrates and binds the 9 core system lifecycle, update, telemetry, and diagnostics services.
 */
function createSystemServicesBundle(deps = {}) {
  const { updateService, telemetryService, announceService } = _createUpdateAndTelemetryServices(deps);
  const { appLocaleService, changelogService, doctorService } = _createLocaleAndDiagnosticServices(deps);
  const { resetBootService, mediaService, startupSweepService } = _createMediaAndMaintenanceServices(deps, telemetryService);

  return {
    appLocaleService,
    updateService,
    announceService,
    changelogService,
    resetBootService,
    mediaService,
    doctorService,
    startupSweepService,
    telemetryService,
  };
}

module.exports = {
  createSystemServicesBundle,
};
