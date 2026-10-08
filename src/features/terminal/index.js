'use strict';

const { registerPtyIpc } = require('./ptyIpc');
const { registerPanesIpc } = require('./panesIpc');
const { createPaneRestoreService } = require('./paneRestoreService');

module.exports = {
  registerPtyIpc,
  registerPanesIpc,
  createPaneRestoreService,
};
