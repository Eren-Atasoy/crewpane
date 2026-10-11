'use strict';

const { registerWorktreeIpc } = require('./worktreeIpc');
const { registerBrowserIpc } = require('./browserIpc');
const { registerIntegIpc } = require('./integIpc');
const { registerSprintIpc } = require('./sprintIpc');
const { registerGitIpc } = require('./gitIpc');
const { registerTaskIpc } = require('./taskIpc');
const { registerCodeIntelIpc } = require('./codeIntelIpc');
const { registerWorkspaceIpc } = require('./workspaceIpc');
const { registerSystemIpc } = require('../system');

const { createIntegrationService } = require('./integrationService');
const { createBrowserService, BrowserService } = require('./browserService');
const { createWorkspaceFileService, WorkspaceFileService } = require('./workspaceFileService');
const { createCodeIndexService, CodeIndexService } = require('./codeIndexService');
const { createWorkspaceRootService, WorkspaceRootService } = require('./workspaceRootService');
const { createBackendEnvService, BackendEnvService, APPDB_TOKEN_TIMEOUT_MS } = require('./backendEnvService');
const { createWorkspaceServicesBundle } = require('./workspaceServicesBundle');

module.exports = {
  createWorkspaceServicesBundle,
  createIntegrationService,
  createBrowserService,
  BrowserService,
  createWorkspaceFileService,
  WorkspaceFileService,
  createCodeIndexService,
  CodeIndexService,
  createWorkspaceRootService,
  WorkspaceRootService,
  createBackendEnvService,
  BackendEnvService,
  APPDB_TOKEN_TIMEOUT_MS,
  registerWorktreeIpc,
  registerBrowserIpc,
  registerIntegIpc,
  registerSprintIpc,
  registerGitIpc,
  registerTaskIpc,
  registerCodeIntelIpc,
  registerWorkspaceIpc,
  registerSystemIpc,
};

