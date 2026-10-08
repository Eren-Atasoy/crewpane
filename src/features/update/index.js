'use strict';

const { registerUpdateIpc } = require('./ipc');
const { createUpdateService, noteUpdateResult } = require('./updateService');

module.exports = {
  registerUpdateIpc,
  createUpdateService,
  noteUpdateResult,
};
