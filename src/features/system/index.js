'use strict';

const { registerFeedbackIpc } = require('./feedbackIpc');
const { registerFileIpc } = require('./fileIpc');
const { registerClipIpc } = require('./clipIpc');
const { registerAnnounceIpc } = require('./announceIpc');
const { registerDiagnosticsIpc } = require('./diagnosticsIpc');
const { registerTelemetryIpc } = require('./telemetryIpc');
const { registerMediaIpc } = require('./mediaIpc');
const { registerSettingsIpc } = require('./settingsIpc');
const { registerAppIpc } = require('./appIpc');

function registerSystemIpc(deps) {
  registerFeedbackIpc(deps);
  registerFileIpc(deps);
  registerClipIpc(deps);
  registerAnnounceIpc(deps);
}

const { createCrashWatchdogService } = require('./crashWatchdogService');
const { createFaultService, obsSurfaceFor } = require('./faultService');
const { createTelemetryService, ANALYTICS_FUNNEL_EVENT, analyticsEngineOf } = require('./telemetryService');
const { createAnnounceService } = require('./announceService');
const { createChangelogService } = require('./changelogService');
const { createResetBootService } = require('./resetBootService');
const { createMediaService } = require('./mediaService');
const { createDoctorService } = require('./doctorService');
const { createStartupSweepService } = require('./startupSweepService');
const { createAppLocaleService, AppLocaleService } = require('./appLocaleService');
const { createRebuildService, RebuildService } = require('./rebuildService');

module.exports = {
  createCrashWatchdogService,
  createFaultService,
  createTelemetryService,
  createAnnounceService,
  createChangelogService,
  createResetBootService,
  createMediaService,
  createDoctorService,
  createStartupSweepService,
  createAppLocaleService,
  AppLocaleService,
  createRebuildService,
  RebuildService,
  ANALYTICS_FUNNEL_EVENT,
  analyticsEngineOf,
  obsSurfaceFor,
  registerSystemIpc,
  registerFeedbackIpc,
  registerFileIpc,
  registerClipIpc,
  registerAnnounceIpc,
  registerDiagnosticsIpc,
  registerTelemetryIpc,
  registerMediaIpc,
  registerSettingsIpc,
  registerAppIpc,
};
