'use strict';

const { registerWorktreeIpc } = require('./worktreeIpc');
const { registerBrowserIpc } = require('./browserIpc');
const { registerIntegIpc } = require('./integIpc');
const { registerSprintIpc } = require('./sprintIpc');
const { registerGitIpc } = require('./gitIpc');
const { registerTaskIpc } = require('./taskIpc');
const { registerCodeIntelIpc } = require('./codeIntelIpc');
const { registerWorkspaceIpc } = require('./workspaceIpc');

const { createIntegrationService } = require('./integrationService');

module.exports = {
  createIntegrationService,
  registerWorktreeIpc,
  registerBrowserIpc,
  registerIntegIpc,
  registerSprintIpc,
  registerGitIpc,
  registerTaskIpc,
  registerCodeIntelIpc,
  registerWorkspaceIpc,
};

