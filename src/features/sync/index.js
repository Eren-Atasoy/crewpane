'use strict';

const { registerSyncIpc } = require('./ipc');
const { registerPrefsIpc } = require('./prefsIpc');
const { createSyncService } = require('./service');

module.exports = {
  registerSyncIpc,
  registerPrefsIpc,
  createSyncService,
};
