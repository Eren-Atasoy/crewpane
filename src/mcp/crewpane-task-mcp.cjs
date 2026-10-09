#!/usr/bin/env node
// CrewPane — Task Board MCP Server Facade.
// Modular submodules live under ./task/ (Phase 4.14).
'use strict';

const task = require('./task/index.cjs');

module.exports = {
  parseEnvFile: task.parseEnvFile,
  loadEnvLocal: task.loadEnvLocal,
  resolveSupabase: task.resolveSupabase,
  restRequest: task.restRequest,
  appDbAccessToken: task.appDbAccessToken,
  authHeaders: task.authHeaders,
  _resetTokenCache: task._resetTokenCache,
  _tokenIssuerOrigin: task._tokenIssuerOrigin,
  _identityMatchesTarget: task._identityMatchesTarget,
  _pgError: task._pgError,
  slugify: task.slugify,
  normalizeSprintSlug: task.normalizeSprintSlug,
  genTaskId: task.genTaskId,
  selfAgentId: task.selfAgentId,
  TASK_STATUSES: task.TASK_STATUSES,
  runList: task.runList,
  runCreate: task.runCreate,
  runUpdate: task.runUpdate,
  runCreateProject: task.runCreateProject,
  runCreateSprint: task.runCreateSprint,
  runDeleteProject: task.runDeleteProject,
  assigneeTeamGate: task.assigneeTeamGate,
  validateExplicitProject: task.validateExplicitProject,
  _setTeamPolicyForTest: task._setTeamPolicyForTest,
  runAttach: task.runAttach,
  attachToTask: task.attachToTask,
  normalizeAttachments: task.normalizeAttachments,
  describeSkip: task.describeSkip,
  ATTACH_MAX: task.ATTACH_MAX,
  TOOLS: task.TOOLS,
};

if (require.main === module) task.main();
