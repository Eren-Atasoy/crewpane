// CrewPane — Task Board MCP Module Aggregator (Phase 4.14)
'use strict';

const {
  parseEnvFile,
  loadEnvLocal,
  resolveSupabase,
  restRequest,
  appDbAccessToken,
  authHeaders,
  tokenIssuerOrigin,
  identityMatchesTarget,
  pgError,
  _resetTokenCache,
} = require('./backendClient.cjs');

const {
  TASK_STATUSES,
  slugify,
  normalizeSprintSlug,
  genTaskId,
  selfAgentId,
  assigneeTeamGate,
  validateExplicitProject,
  _setTeamPolicyForTest,
} = require('./taskHelpers.cjs');

const {
  ATTACH_MAX,
  normalizeAttachments,
  attachToTask,
  describeSkip,
  runAttach,
} = require('./taskAttachments.cjs');

const {
  runList,
  runCreate,
  runUpdate,
  runCreateProject,
  runCreateSprint,
  runDeleteProject,
} = require('./taskRunners.cjs');

const {
  TOOLS,
} = require('./toolDefs.cjs');

const {
  main,
} = require('./serverLoop.cjs');

module.exports = {
  parseEnvFile,
  loadEnvLocal,
  resolveSupabase,
  restRequest,
  appDbAccessToken,
  authHeaders,
  _resetTokenCache,
  _tokenIssuerOrigin: tokenIssuerOrigin,
  _identityMatchesTarget: identityMatchesTarget,
  _pgError: pgError,
  slugify,
  normalizeSprintSlug,
  genTaskId,
  selfAgentId,
  TASK_STATUSES,
  runList,
  runCreate,
  runUpdate,
  runCreateProject,
  runCreateSprint,
  runDeleteProject,
  assigneeTeamGate,
  validateExplicitProject,
  _setTeamPolicyForTest,
  runAttach,
  attachToTask,
  normalizeAttachments,
  describeSkip,
  ATTACH_MAX,
  TOOLS,
  main,
};
