'use strict';

const registryBridge = require('./registryBridge.cjs');
const atomicFs = require('./atomicFs.cjs');
const commandWhitelist = require('./commandWhitelist.cjs');
const environment = require('./environment.cjs');
const reports = require('./reports.cjs');
const trust = require('./trust.cjs');
const mcpServers = require('./mcpServers.cjs');
const integrationsConfig = require('./integrationsConfig.cjs');
const identityCarrier = require('./identityCarrier.cjs');
const memoryDecorators = require('./memoryDecorators.cjs');
const modelDecorators = require('./modelDecorators.cjs');
const spawnDecorators = require('./spawnDecorators.cjs');
const builder = require('./builder.cjs');
const leaderDetector = require('./leaderDetector.cjs');
const spawnArgs = require('./spawnArgs.cjs');

module.exports = {
  // Command whitelist & limits
  ALLOWED_COMMANDS: commandWhitelist.ALLOWED_COMMANDS,
  DEFAULT_AGENT_ARGS: commandWhitelist.DEFAULT_AGENT_ARGS,
  defaultArgsFor: commandWhitelist.defaultArgsFor,
  IDLE_AFTER_MS: commandWhitelist.IDLE_AFTER_MS,
  MAX_SYSTEM_PROMPT_LEN: commandWhitelist.MAX_SYSTEM_PROMPT_LEN,
  isAllowedCommand: commandWhitelist.isAllowedCommand,
  resolveCommand: commandWhitelist.resolveCommand,
  sanitizeArgs: commandWhitelist.sanitizeArgs,
  sanitizeSystemPrompt: commandWhitelist.sanitizeSystemPrompt,
  sanitizeModel: commandWhitelist.sanitizeModel,

  // Registry bridge
  setEngineRegistry: registryBridge.setEngineRegistry,
  engineCapability: registryBridge.engineCapability,
  unsupportedCapabilities: registryBridge.unsupportedCapabilities,

  // Argv utilities
  applyArgs: spawnArgs.applyArgs,
  repeatFlagArgs: spawnArgs.repeatFlagArgs,

  // Identity carrier & file flags
  identityCarrier: identityCarrier.identityCarrier,
  identityFileCarrierIsOverflowOnly: identityCarrier.identityFileCarrierIsOverflowOnly,
  leaderDelegationStatus: spawnDecorators.leaderDelegationStatus,
  mcpEnvSnapshot: spawnDecorators.mcpEnvSnapshot,
  parseEnvConfigDoc: identityCarrier.parseEnvConfigDoc,
  identityUsesFileCarrier: identityCarrier.identityUsesFileCarrier,
  identityFlagIsFileOnly: identityCarrier.identityFlagIsFileOnly,
  identityFileFlagSink: identityCarrier.identityFileFlagSink,
  withIdentityFrontmatter: identityCarrier.withIdentityFrontmatter,
  supportsResumeReinject: identityCarrier.supportsResumeReinject,

  // Subagents and MCP registration
  subagentBlockArgs: spawnDecorators.subagentBlockArgs,
  mcpRegisterArgs: spawnDecorators.mcpRegisterArgs,
  codexMcpServerEnv: spawnDecorators.codexMcpServerEnv,
  contributionPosition: spawnDecorators.contributionPosition,
  integrationsInjectable: integrationsConfig.integrationsInjectable,

  // Model & providers
  withModel: modelDecorators.withModel,
  withEffort: modelDecorators.withEffort,
  resolveEffort: modelDecorators.resolveEffort,
  withProvider: modelDecorators.withProvider,

  // Identity injection & isolation
  withIdentity: identityCarrier.withIdentity,
  applyIdentityEnvFile: identityCarrier.applyIdentityEnvFile,
  identityUsesEnvFile: identityCarrier.identityUsesEnvFile,
  identityEnvDirRoot: identityCarrier.identityEnvDirRoot,
  mergeIdentityConfigDoc: identityCarrier.mergeIdentityConfigDoc,
  applyPaneIsolationEnv: identityCarrier.applyPaneIsolationEnv,
  paneIsolationPlan: identityCarrier.paneIsolationPlan,
  withPlainGuard: identityCarrier.withPlainGuard,
  isIdentitylessSpawn: identityCarrier.isIdentitylessSpawn,
  identityCarrierIsSilent: identityCarrier.identityCarrierIsSilent,
  warnIdentityClamp: identityCarrier.warnIdentityClamp,

  // Memory
  withRecalledMemory: memoryDecorators.withRecalledMemory,
  memorySpawnBlock: memoryDecorators.memorySpawnBlock,
  fitMemoryBlock: memoryDecorators.fitMemoryBlock,
  composeSpawnIdentity: memoryDecorators.composeSpawnIdentity,
  memoryLedger: memoryDecorators.memoryLedger,
  spawnRetrieverFor: memoryDecorators.spawnRetrieverFor,
  runnableRecallCli: memoryDecorators.runnableRecallCli,
  runnableEngineMemorySearchCli: memoryDecorators.runnableEngineMemorySearchCli,
  SPAWN_MEMORY_BUDGET_CHARS: memoryDecorators.SPAWN_MEMORY_BUDGET_CHARS,
  setSpawnMemoryWarm: memoryDecorators.setSpawnMemoryWarm,
  resumeMemoryPrompt: memoryDecorators.resumeMemoryPrompt,
  withMemoryDirs: memoryDecorators.withMemoryDirs,

  // Session & resume
  isUuid: modelDecorators.isUuid,
  withSessionId: modelDecorators.withSessionId,
  isResumeSpawn: modelDecorators.isResumeSpawn,
  isDeadSessionExit: modelDecorators.isDeadSessionExit,
  appendResume: modelDecorators.appendResume,
  leaderSignal: leaderDetector.leaderSignal,
  isLeaderSpawn: leaderDetector.isLeaderSpawn,

  // MCP Servers
  resolveMcpServerDir: mcpServers.resolveMcpServerDir,
  mcpServerDir: mcpServers.mcpServerDir,
  delegateMcpServerPath: mcpServers.delegateMcpServerPath,
  browserMcpServerPath: mcpServers.browserMcpServerPath,
  taskMcpServerPath: mcpServers.taskMcpServerPath,
  integrationsMcpServerPath: mcpServers.integrationsMcpServerPath,
  INTEGRATIONS_MCP_SERVER_NAME: mcpServers.INTEGRATIONS_MCP_SERVER_NAME,
  INTEGRATIONS_MCP_SERVER_FILE: mcpServers.INTEGRATIONS_MCP_SERVER_FILE,
  mcpEnvelopeFor: mcpServers.mcpEnvelopeFor,
  mcpConfigDoc: mcpServers.mcpConfigDoc,
  mcpConfigFileName: mcpServers.mcpConfigFileName,
  delegateMcpConfigPath: mcpServers.delegateMcpConfigPath,

  // Atomic file operations
  writeJsonAtomic: atomicFs.writeJsonAtomic,
  winSafeAtomicWrite: atomicFs.winSafeAtomicWrite,

  // Launchers and delegates
  ensureNodeLauncher: integrationsConfig.ensureNodeLauncher,
  ensureDelegateMcpConfig: mcpServers.ensureDelegateMcpConfig,
  withLeaderDelegation: spawnDecorators.withLeaderDelegation,
  withSubagentBlock: spawnDecorators.withSubagentBlock,
  withAgyHooks: spawnDecorators.withAgyHooks,
  agyHookRunnerPath: integrationsConfig.agyHookRunnerPath,
  withImages: modelDecorators.withImages,
  terminateImageList: modelDecorators.terminateImageList,
  browserMcpConfigPath: mcpServers.browserMcpConfigPath,
  ensureBrowserMcpConfig: mcpServers.ensureBrowserMcpConfig,
  withBrowserCapable: spawnDecorators.withBrowserCapable,
  withBrowserEnv: spawnDecorators.withBrowserEnv,
  taskMcpConfigPath: mcpServers.taskMcpConfigPath,
  ensureTaskMcpConfig: mcpServers.ensureTaskMcpConfig,
  withTaskCapable: spawnDecorators.withTaskCapable,

  // Briefing
  briefingHookPath: integrationsConfig.briefingHookPath,
  briefingSettingsPath: integrationsConfig.briefingSettingsPath,
  ensureBriefingSettings: integrationsConfig.ensureBriefingSettings,
  withTurnBriefing: spawnDecorators.withTurnBriefing,

  // Integrations config & lifecycle
  integrationsMcpConfigPath: integrationsConfig.integrationsMcpConfigPath,
  ensureIntegrationsMcpConfig: integrationsConfig.ensureIntegrationsMcpConfig,
  readIntegrationsConfigFacts: integrationsConfig.readIntegrationsConfigFacts,
  integrationsLazyManifestPath: integrationsConfig.integrationsLazyManifestPath,
  integrationsToolCacheDir: integrationsConfig.integrationsToolCacheDir,
  lazyProxyPath: integrationsConfig.lazyProxyPath,
  gateIntegrations: integrationsConfig.gateIntegrations,
  cleanupIntegrationsMcpConfig: integrationsConfig.cleanupIntegrationsMcpConfig,
  cleanupAgyWorkspacePlugin: integrationsConfig.cleanupAgyWorkspacePlugin,
  sweepStaleAgyWorkspacePlugins: integrationsConfig.sweepStaleAgyWorkspacePlugins,
  sweepStaleIntegrationsConfigs: integrationsConfig.sweepStaleIntegrationsConfigs,
  integrationsPaneKey: integrationsConfig.integrationsPaneKey,
  userFieldEnv: integrationsConfig.userFieldEnv,
  withIntegrations: spawnDecorators.withIntegrations,

  // Code index
  codeIndexMcpConfigPath: integrationsConfig.codeIndexMcpConfigPath,
  ensureCodeIndexMcpConfig: integrationsConfig.ensureCodeIndexMcpConfig,
  codeIndexInjectable: integrationsConfig.codeIndexInjectable,
  withCodeIndex: spawnDecorators.withCodeIndex,
  integrationContextFor: integrationsConfig.integrationContextFor,
  resolveIntegrationCreds: integrationsConfig.resolveIntegrationCreds,
  INTEGRATION_SECRET_ENV_PREFIX: environment.INTEGRATION_SECRET_ENV_PREFIX,

  // Environment & PATH
  withLeaderEnv: spawnDecorators.withLeaderEnv,
  sanitizeCwd: environment.sanitizeCwd,
  resolveCwd: environment.resolveCwd,
  sanitizeEnv: environment.sanitizeEnv,
  INHERITED_ENGINE_ENV: environment.INHERITED_ENGINE_ENV,
  PANE_SCOPED_ENV_KEYS: environment.PANE_SCOPED_ENV_KEYS,
  augmentedPath: environment.augmentedPath,
  setPathVar: environment.setPathVar,
  getPathVar: environment.getPathVar,
  ensureUtf8Locale: environment.ensureUtf8Locale,
  isUtf8Locale: environment.isUtf8Locale,
  DEFAULT_LANG: environment.DEFAULT_LANG,

  // Builder & status
  buildSpawn: builder.buildSpawn,
  statusFor: builder.statusFor,

  // Trust
  claudeTrustPatch: trust.claudeTrustPatch,
  isClaudeTrusted: trust.isClaudeTrusted,
  ensureClaudeTrusted: trust.ensureClaudeTrusted,
  ensureEngineTrusted: trust.ensureEngineTrusted,
  trustWritesAtSpawn: trust.trustWritesAtSpawn,
  planEngineTrust: trust.planEngineTrust,
  TRUST_WRITERS: trust.TRUST_WRITERS,
  canonicalCwd: trust.canonicalCwd,
  codexIsTrusted: trust.codexIsTrusted,
  codexTrustPatch: trust.codexTrustPatch,
  ensureCodexTrusted: trust.ensureCodexTrusted,

  // Reports
  REPORT_STATUSES: reports.REPORT_STATUSES,
  sanitizeReportToken: reports.sanitizeReportToken,
  foldAscii: reports.foldAscii,
  reportAgentToken: reports.reportAgentToken,
  reportFileName: reports.reportFileName,
  buildReportMarkdown: reports.buildReportMarkdown,
};
