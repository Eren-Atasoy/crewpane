// CrewPane — Agent Settings modular public API.
'use strict';

const {
  PUSH_TO_TALK_KEYS,
  DEFAULT_PUSH_TO_TALK_KEY,
  THEME_MODES,
  VENDOR_HOSTED_POLICIES,
  defaults,
} = require('./constants.cjs');

const {
  sanitizeTheme,
  sanitizeLocale,
  sanitizeVoiceLocale,
  sanitizeBrowserTrust,
  sanitizeTelemetryState,
  sanitizeResourceGovernor,
  sanitizeMemorySearch,
  sanitizeEngines,
  sanitizeTeamCompose,
} = require('./sanitizers.cjs');

const {
  ensureTeamScopeMandate,
  teamScopePolicy,
  grantTeamScope,
  revokeTeamScope,
} = require('./teamScopePolicy.cjs');

const {
  probeDir,
  isDir,
  configuredWorkspaceRoot,
  configuredWorkspaceRootStatus,
  resolveWorkspaceRoot,
} = require('./workspaceRoot.cjs');

const {
  settingsPath,
  readSettings,
  writeSettings,
  applySettingsPatch,
  lastPersistOutcome,
  setPersistLogger,
  openAiKeyFromSettings,
  invalidateCache,
  _resetCache,
} = require('./settingsStore.cjs');

module.exports = {
  settingsPath,
  PUSH_TO_TALK_KEYS,
  THEME_MODES,
  sanitizeTheme,
  sanitizeLocale,
  sanitizeVoiceLocale,
  sanitizeBrowserTrust,
  sanitizeTelemetryState,
  sanitizeResourceGovernor,
  sanitizeMemorySearch,
  sanitizeEngines,
  VENDOR_HOSTED_POLICIES,
  ensureTeamScopeMandate,
  sanitizeTeamCompose,
  teamScopePolicy,
  grantTeamScope,
  revokeTeamScope,
  DEFAULT_PUSH_TO_TALK_KEY,
  defaults,
  readSettings,
  writeSettings,
  applySettingsPatch,
  lastPersistOutcome,
  setPersistLogger,
  configuredWorkspaceRoot,
  configuredWorkspaceRootStatus,
  probeDir,
  resolveWorkspaceRoot,
  openAiKeyFromSettings,
  isDir,
  invalidateCache,
  _resetCache,
};
