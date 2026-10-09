# Refactoring Map: `src/mcp/crewpane-delegate-mcp.cjs` (Phase 4.13)

## Overview
`src/mcp/crewpane-delegate-mcp.cjs` (1,112 lines, 17 exports) is the delegation MCP server spawned inside leader Claude sessions. It provides tools for task delegation (`crewpane_delegate`), delegation and supervisor status checking (`crewpane_delegation_status`), long sprints (`crewpane_sprint`, `crewpane_sprint_status`), pane lifecycle control (`crewpane_pane`), and team/employee composition (`crewpane_team_compose`). It also serves as the bridge client library for `crewpane-task-mcp.cjs` and `crewpane-integrations-mcp.cjs`.

This refactoring decomposes `crewpane-delegate-mcp.cjs` into 5 modular submodules under `src/mcp/delegate/`, keeping all files ≤ 350 lines while preserving 100% export, contract, and CLI execution behavior.

## Target Structure

```
src/mcp/
├── crewpane-delegate-mcp.cjs      (executable facade forwarding to ./delegate/index.cjs)
└── delegate/
    ├── bridgeClient.cjs           (BRIDGE_FILE, discoverBridge, discoverBridgeCandidates, bridgeRequest, bridgeRequestFailover, toolOk, toolError, logErr)
    ├── formatters.cjs             (humanAge, cleanStatusReason, summarizeStatus, summarizeSupervisor, summarizeSprintStatus, summarizePanes)
    ├── toolRunners.cjs            (runDelegate, runStatus, runSprint, runSprintStop, runSprintStatus, runPane, runTeamCompose)
    ├── toolDefs.cjs               (CANONICAL_TOOLS, TOOLS, withLegacyAliases)
    ├── serverLoop.cjs             (JSON-RPC stdio protocol loop: handle, send, main)
    └── index.cjs                  (17 public exports + main)
```

## Public API Contract (17 Exports)
- Bridge Client: `discoverBridge`, `discoverBridgeCandidates`, `bridgeRequestFailover`, `bridgeRequest`, `BRIDGE_FILE`
- Status Formatters: `summarizeStatus`, `summarizeSupervisor`, `summarizeSprintStatus`, `summarizePanes`
- Tool Run Handlers: `runDelegate`, `runStatus`, `runSprint`, `runSprintStatus`, `runPane`, `runTeamCompose`
- Tool Definitions: `TOOLS`, `CANONICAL_TOOLS`

## Verification
- Unit test in `tests/units.test.cjs` asserting 17/17 exports and formatter/tool contracts.
- Full test suite execution (`npm test`).
- ESLint verification (`npx eslint . --quiet`).
