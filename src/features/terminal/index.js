'use strict';

const { registerPtyIpc } = require('./ptyIpc');
const { registerPanesIpc } = require('./panesIpc');
const { createPaneRestoreService } = require('./paneRestoreService');
const { createPtyResumeService } = require('./ptyResumeService');
const { createPtyIsolationService, PtyIsolationService } = require('./ptyIsolationService');
const { createPtySpawnService, PtySpawnService } = require('./ptySpawnService');
const { createPaneControlService, PaneControlService } = require('./paneControlService');

module.exports = {
  registerPtyIpc,
  registerPanesIpc,
  createPaneRestoreService,
  createPtyResumeService,
  createPtyIsolationService,
  PtyIsolationService,
  createPtySpawnService,
  PtySpawnService,
  createPaneControlService,
  PaneControlService,
};
