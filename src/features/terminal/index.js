'use strict';

const { registerPtyIpc } = require('./ptyIpc');
const { registerPanesIpc } = require('./panesIpc');
const { createPaneRestoreService } = require('./paneRestoreService');
const { createPtyResumeService } = require('./ptyResumeService');
const { createPtyIsolationService, PtyIsolationService } = require('./ptyIsolationService');
const { createPtySpawnService, PtySpawnService } = require('./ptySpawnService');
const { createPaneControlService, PaneControlService } = require('./paneControlService');
const { createPaneDispatchService, PaneDispatchService, REFRESH_SUBMIT_GAP_MS } = require('./paneDispatchService');
const { createPaneQueryService, PaneQueryService, captureScreenTail } = require('./paneQueryService');
const { createPaneAskService, PaneAskService, PANE_ASK_MIRROR_MAX } = require('./paneAskService');
const { createPaneTranscriptService, PaneTranscriptService } = require('./paneTranscriptService');
const { createPaneBudgetService, PaneBudgetService } = require('./paneBudgetService');
const { createTerminalServicesBundle } = require('./terminalServicesBundle');
const { probeClaudeCliVersion, getClaudeCliVersionCache } = require('./claudeCliProbe');

module.exports = {
  createTerminalServicesBundle,
  probeClaudeCliVersion,
  getClaudeCliVersionCache,
  createPaneAskService,
  PaneAskService,
  PANE_ASK_MIRROR_MAX,
  createPaneTranscriptService,
  PaneTranscriptService,
  createPaneBudgetService,
  PaneBudgetService,
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
  createPaneDispatchService,
  PaneDispatchService,
  createPaneQueryService,
  PaneQueryService,
  captureScreenTail,
  REFRESH_SUBMIT_GAP_MS,
};
