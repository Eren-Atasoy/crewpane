# Refactoring Map: `src/agents/agentRunner.js`

> **Original File:** `src/agents/agentRunner.js` (5,198 lines, 115 exported symbols)  
> **Goal:** Decompose into cohesive modules under `src/agents/runner/`, keeping each file ≤ 800 lines and functions ≤ 120 lines, while preserving 100% contract compatibility and zero behavioral change.

---

## 1. Domain Clusters & Module Responsibilities

| Sub-Module | Responsibility | Key Symbols / Exports |
|---|---|---|
| `runner/commandWhitelist.cjs` | RCE guard, allowed commands, default arguments, and command sanitization | `ALLOWED_COMMANDS`, `isAllowedCommand`, `resolveCommand`, `sanitizeArgs`, `sanitizeSystemPrompt`, `sanitizeModel`, `defaultArgsFor`, `IDLE_AFTER_MS`, `MAX_SYSTEM_PROMPT_LEN` |
| `runner/environment.cjs` | Environment variables, PATH augmentation, and UTF-8 locale handling | `sanitizeEnv`, `augmentedPath`, `setPathVar`, `getPathVar`, `ensureUtf8Locale`, `isUtf8Locale`, `DEFAULT_LANG`, `INHERITED_ENGINE_ENV`, `PANE_SCOPED_ENV_KEYS`, `sanitizeCwd`, `resolveCwd` |
| `runner/reports.cjs` | Task completion report formatting and agent token naming | `REPORT_STATUSES`, `sanitizeReportToken`, `foldAscii`, `reportAgentToken`, `reportFileName`, `buildReportMarkdown` |
| `runner/trust.cjs` | Engine workspace trust pre-acceptance (Claude, Codex, generic trust writers) | `claudeTrustPatch`, `isClaudeTrusted`, `ensureClaudeTrusted`, `ensureEngineTrusted`, `trustWritesAtSpawn`, `planEngineTrust`, `TRUST_WRITERS`, `canonicalCwd`, `codexIsTrusted`, `codexTrustPatch`, `ensureCodexTrusted` |
| `runner/mcpConfig.cjs` | MCP server paths, JSON config writers, briefing & integrations files, cleanup sweeps | `resolveMcpServerDir`, `mcpServerDir`, `delegateMcpServerPath`, `browserMcpServerPath`, `taskMcpServerPath`, `integrationsMcpServerPath`, `INTEGRATIONS_MCP_SERVER_NAME`, `INTEGRATIONS_MCP_SERVER_FILE`, `mcpEnvelopeFor`, `mcpConfigDoc`, `mcpConfigFileName`, `delegateMcpConfigPath`, `writeJsonAtomic`, `winSafeAtomicWrite`, `ensureNodeLauncher`, `ensureDelegateMcpConfig`, `browserMcpConfigPath`, `ensureBrowserMcpConfig`, `taskMcpConfigPath`, `ensureTaskMcpConfig`, `briefingHookPath`, `briefingSettingsPath`, `ensureBriefingSettings`, `integrationsMcpConfigPath`, `ensureIntegrationsMcpConfig`, `readIntegrationsConfigFacts`, `integrationsLazyManifestPath`, `integrationsToolCacheDir`, `lazyProxyPath`, `gateIntegrations`, `cleanupIntegrationsMcpConfig`, `cleanupAgyWorkspacePlugin`, `sweepStaleAgyWorkspacePlugins`, `sweepStaleIntegrationsConfigs`, `integrationsPaneKey`, `userFieldEnv`, `codeIndexMcpConfigPath`, `ensureCodeIndexMcpConfig`, `codeIndexInjectable`, `integrationContextFor`, `resolveIntegrationCreds`, `INTEGRATION_SECRET_ENV_PREFIX` |
| `runner/spawnDecorators.cjs` | Argv builders, identity & prompt injection, memory integration, session management, hooks, and decorators | `applyArgs`, `repeatFlagArgs`, `identityCarrier`, `withIdentity`, `withModel`, `withEffort`, `withProvider`, `withLeaderDelegation`, `withSubagentBlock`, `withAgyHooks`, `withImages`, `withBrowserCapable`, `withTaskCapable`, `withTurnBriefing`, `withIntegrations`, `withCodeIndex`, `withLeaderEnv`, `withRecalledMemory`, `withSessionId`, `appendResume`, etc. |
| `runner/builder.cjs` | Primary entry point turning requests into concrete `(file, argv, cwd, env)` and status derivation | `buildSpawn(req, opts)`, `statusFor(exitCode, signal)` |
| `agentRunner.js` | Facade module re-exporting the entire API surface from `runner/index.cjs` for backward compatibility | All 115 exported symbols |

---

## 2. Refactoring Steps

1. Create `src/agents/runner/` directory.
2. Extract pure leaf modules:
   - `commandWhitelist.cjs`
   - `environment.cjs`
   - `reports.cjs`
   - `trust.cjs`
3. Extract `mcpConfig.cjs` (MCP configuration and file life-cycle management).
4. Extract `spawnDecorators.cjs` (argv assembly, prompt injection, and engine decorators).
5. Extract `builder.cjs` (`buildSpawn` and `statusFor`).
6. Assemble `src/agents/runner/index.cjs` and wire `src/agents/agentRunner.js` as the thin facade.
7. Run characterization tests and linting to ensure zero regressions.
