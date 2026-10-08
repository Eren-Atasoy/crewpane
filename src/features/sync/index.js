'use strict';

const { registerSyncIpc } = require('./ipc');
const { registerPrefsIpc } = require('./prefsIpc');

module.exports = {
  registerSyncIpc,
  registerPrefsIpc,
};
