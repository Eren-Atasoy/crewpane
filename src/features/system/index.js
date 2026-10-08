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

module.exports = {
  createCrashWatchdogService,
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
