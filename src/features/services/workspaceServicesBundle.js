'use strict';

const codeIndexStore = require('../../services/codeIndex.cjs');
const projectRepos = require('../../config/projectRepos.cjs');
const worktreeStore = require('../../services/worktreeStore.cjs');
const workspaceOnboarding = require('../../agents/workspaceOnboarding.cjs');
const workspaceSwitch = require('../../agents/workspaceSwitch.cjs');
const builtinSkills = require('../../agents/builtinSkills.cjs');
const skillEngineSync = require('../../agents/skillEngineSync.cjs');
const { renameWithRetrySync } = require('../../../platform/atomicWrite.cjs');

const { createCodeIndexService } = require('./codeIndexService');
const { createWorkspaceRootService } = require('./workspaceRootService');
const { createWorkspaceFileService } = require('./workspaceFileService');

const FILE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB — editor opens source files, not blobs

/**
 * Workspace Services Domain Bundle (Phase 3.6.63)
 * Orchestrates workspace roots, file persistence, and code indexing services.
 */
function createWorkspaceServicesBundle(deps = {}) {
  const codeIndexService = createCodeIndexService({
    codeIndexStore,
    projectRepos,
    worktreeStore,
    agentSettings: deps.agentSettings,
    crewpaneHome: () => deps.crewpaneHome(),
    getAgentWorkspaceRoot: () => deps.getAgentWorkspaceRoot(),
    logLine: deps.logLine,
  });

  const workspaceRootService = createWorkspaceRootService({
    app: deps.app,
    BrowserWindow: deps.BrowserWindow,
    workspaceOnboarding,
    workspaceSwitch,
    agentSettings: deps.agentSettings,
    builtinSkills,
    skillEngineSync,
    invalidateGitBranchCache: deps.invalidateGitBranchCache,
    getAgentWorkspaceRoot: () => deps.getAgentWorkspaceRoot(),
    setAgentWorkspaceRoot: (val) => deps.setAgentWorkspaceRoot(val),
    workspacePlanDenial: (root) => (typeof deps.planLimitService === 'function' && deps.planLimitService() ? deps.planLimitService().workspacePlanDenial(root) : null),
    rememberWorkspaceRoot: (root) => (typeof deps.planLimitService === 'function' && deps.planLimitService() ? deps.planLimitService().rememberWorkspaceRoot(root) : null),
    logLine: deps.logLine,
    repoRoot: deps.repoRoot,
    forceFirstRun: deps.forceFirstRun,
  });

  const workspaceFileService = createWorkspaceFileService({
    activeRoots: workspaceRootService.activeRoots,
    getWorkspaceRoot: () => deps.getAgentWorkspaceRoot(),
    getUserDataPath: () => deps.app.getPath('userData'),
    ptys: deps.ptys,
    dialog: deps.dialog,
    appI18n: deps.appI18n,
    fileMaxBytes: deps.fileMaxBytes || FILE_MAX_BYTES,
    logLine: (line) => deps.logLine(line),
    renameWithRetry: deps.renameWithRetry || renameWithRetrySync,
  });

  return {
    codeIndexService,
    workspaceRootService,
    workspaceFileService,
    FILE_MAX_BYTES,
  };
}

module.exports = {
  createWorkspaceServicesBundle,
  FILE_MAX_BYTES,
};
