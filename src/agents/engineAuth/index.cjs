// CrewPane — Engine Auth Public API Aggregator.
'use strict';

const {
  LOGIN_TIMEOUT_MS,
  STATUS_TIMEOUT_MS,
  maskSecrets,
} = require('./constants.cjs');

const {
  authDescriptor,
  authEngines,
  envDescriptors,
  AUTH_ENGINES,
  ENGINE_AUTH_META,
  authKindOf,
  statusArgv,
  loginArgv,
  logoutArgv,
} = require('./descriptors.cjs');

const {
  parseJsonStatus,
  parseTextStatus,
  parseStatus,
  parseClaudeStatus,
  parseCodexStatus,
  statusUnmeasured,
} = require('./statusParser.cjs');

const {
  createVaultApiKeyStore,
  apiKeyEnvFor,
} = require('./apiKeyVault.cjs');

const {
  readStatus,
  readAllStatus,
} = require('./statusProber.cjs');

const {
  extractUrl,
  wantsCode,
  startLogin,
  logout,
} = require('./loginFlow.cjs');

const {
  engineMessageOf,
  verifyApiKey,
  setApiKey,
  clearApiKey,
} = require('./apiKeyActions.cjs');

module.exports = {
  AUTH_ENGINES,
  ENGINE_AUTH_META,
  LOGIN_TIMEOUT_MS,
  STATUS_TIMEOUT_MS,
  maskSecrets,
  authDescriptor,
  authEngines,
  envDescriptors,
  parseJsonStatus,
  parseTextStatus,
  parseStatus,
  authKindOf,
  parseClaudeStatus,
  parseCodexStatus,
  statusArgv,
  loginArgv,
  logoutArgv,
  statusUnmeasured,
  extractUrl,
  wantsCode,
  readStatus,
  readAllStatus,
  startLogin,
  logout,
  createVaultApiKeyStore,
  apiKeyEnvFor,
  engineMessageOf,
  verifyApiKey,
  setApiKey,
  clearApiKey,
};
