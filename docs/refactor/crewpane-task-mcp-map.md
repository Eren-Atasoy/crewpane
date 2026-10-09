# Refactoring Map: `src/mcp/crewpane-task-mcp.cjs` (Phase 4.14)

## Overview
`src/mcp/crewpane-task-mcp.cjs` (1,548 lines, 30 exports) is the task board MCP server spawned inside every agent's session. It allows agents to interact with the Supabase PostgREST Task Board: listing tasks (`list_tasks`), creating tasks (`create_task`), updating task status/assignee/git backbone (`update_task`), managing projects and sprints (`create_project`, `create_sprint`, `delete_project`), and attaching screenshot evidence (`attach_to_task`).

This refactoring decomposes `crewpane-task-mcp.cjs` into 6 cohesive submodules under `src/mcp/task/`, keeping all files ≤ 400 lines while preserving 100% export, contract, and CLI execution behavior.

## Target Structure

```
src/mcp/
├── crewpane-task-mcp.cjs          (executable facade forwarding to ./task/index.cjs)
└── task/
    ├── backendClient.cjs          (resolveSupabase, appDbAccessToken, authHeaders, restRequest, pgError, tokenIssuerOrigin, identityMatchesTarget, activeCompanyId, bumpTasksCreated)
    ├── taskHelpers.cjs            (TASK_STATUSES, slugify, normalizeSprintSlug, genTaskId, selfAgentId, assigneeTeamGate, validateExplicitProject, toolOk, toolError)
    ├── taskAttachments.cjs       (ATTACH_MAX, ATTACHMENTS_SCHEMA, normalizeAttachments, attachToTask, describeSkip, runAttach)
    ├── taskRunners.cjs            (runList, runCreate, runUpdate, runCreateProject, runCreateSprint, runDeleteProject, upsertRegistry)
    ├── toolDefs.cjs               (TOOLS definitions with legacy aliases)
    ├── serverLoop.cjs             (JSON-RPC stdio protocol loop: handle, send, main)
    └── index.cjs                  (30 public exports + main)
```

## Public API Contract (30 Exports)
- Supabase & Auth: `parseEnvFile`, `loadEnvLocal`, `resolveSupabase`, `restRequest`, `appDbAccessToken`, `authHeaders`, `_resetTokenCache`, `_tokenIssuerOrigin`, `_identityMatchesTarget`, `_pgError`
- Formatting & Task Helpers: `slugify`, `normalizeSprintSlug`, `genTaskId`, `selfAgentId`, `TASK_STATUSES`, `assigneeTeamGate`, `validateExplicitProject`, `_setTeamPolicyForTest`
- Task Operations: `runList`, `runCreate`, `runUpdate`, `runCreateProject`, `runCreateSprint`, `runDeleteProject`
- Attachments: `runAttach`, `attachToTask`, `normalizeAttachments`, `describeSkip`, `ATTACH_MAX`
- Tools Schema: `TOOLS`

## Verification
- Unit test in `tests/units.test.cjs` asserting 30/30 exports and operations.
- Full test suite execution (`npm test`).
- ESLint verification (`npx eslint . --quiet`).
