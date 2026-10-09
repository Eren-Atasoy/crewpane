// CrewPane — ADP-013 agent runner core facade.
//
// ADR-002 (ADP-011) decided the app-owned pane runner is an ADDITIVE extension
// of the proven ADP-003 paneId-keyed pty bridge: `pty:spawn` gains an optional
// agent-aware shape (`{ command, args, cwd, env, agentId, department, label }`)
// while a bare spawn still launches today's login shell (fully backward
// compatible — the ADP-001 regression keeps spawning `$SHELL`).
//
// Refactored in Phase 4.2 into modular submodules under `./runner/`:
//   • registryBridge.cjs    - Engine registry access & capabilities
//   • spawnArgs.cjs         - CLI flag & arg utilities
//   • leaderDetector.cjs    - Leader role & delegation marker detection
//   • atomicFs.cjs          - Windows-safe atomic writes
//   • commandWhitelist.cjs  - Whitelisted RCE guards & bounds
//   • reports.cjs           - Agent report formatting & sanitization
//   • environment.cjs       - UTF-8 locale, PATH & env handling
//   • trust.cjs             - Workspace trust directory & config writers
//   • mcpServers.cjs        - MCP server paths & config document factories
//   • integrationsConfig.cjs- Integration gate, proxy, briefing hooks
//   • identityCarrier.cjs   - Prompt isolation & carrier wrappers
//   • memoryDecorators.cjs  - Memory ledger & recall cues composition
//   • modelDecorators.cjs   - Model, effort, provider, resume decorators
//   • spawnDecorators.cjs   - Spawn MCP, briefing, delegation decorators
//   • builder.cjs           - Master buildSpawn pipeline & status resolution
//   • index.cjs             - Master aggregator exporting all 149 symbols
//
// main.js requires this facade and calls buildSpawn(); agentRunner.test.cjs exercises
// it directly (node --test).

'use strict';

module.exports = require('./runner/index.cjs');
