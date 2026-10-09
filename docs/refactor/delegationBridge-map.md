# Refactoring Map: `src/agents/delegationBridge.js` (Phase 4.5)

## Overview
`src/agents/delegationBridge.js` (1,836 lines) is the loopback HTTP delegation bridge (Electron main process) connecting leader CLI processes and MCP servers to the renderer and internal automation systems. It provides token-authenticated HTTP endpoints for delegation, sprint orchestration, reporting, pane recycling, pane control, AgentShot screenshot delivery, board task attachments, integration status discovery, app DB access tokens, dictation delivery, telemetry, and headed CDP browser control.

This refactoring decomposes `delegationBridge.js` into 9 modular submodules under `src/agents/bridge/`, reducing file complexity to ≤ 450 lines per file while preserving 100% contract and behavioral parity.

## Target Structure

```
src/agents/
├── delegationBridge.js             (thin facade forwarding to ./bridge/index.cjs)
└── bridge/
    ├── constants.cjs               (MAX_BODY_BYTES, IPC_TIMEOUT_MS, HANDSHAKE_*, BRIDGE_*, ATTACH_MAX_PATHS, SHOT_*, TELEMETRY_*)
    ├── securityToken.cjs           (mintToken, checkToken, declaredIdentity, paneRecordForAgent, authorizeDelegateCaller)
    ├── payloadValidators.cjs       (validateDelegatePayload, validateComposePayload, validateReportPayload, validateRecyclePayload, validatePaneClosePayload, validateShotPayload, validateTaskAttachmentPayload, validateSprintPayload, validateSprintStopPayload)
    ├── reportWriter.cjs            (defaultResultsDir, writeReportFile)
    ├── snapshotEnrich.cjs          (stripAnsi, cleanPaneTail, paneHasApiError, enrichDelegationSnapshot)
    ├── handshake.cjs               (writeHandshake, removeHandshake)
    ├── httpRouter.cjs              (createBridgeRequestHandler dispatching all HTTP routes)
    ├── bridgeServer.cjs            (startDelegationBridge server lifecycle, IPC wiring, timers, cleanup)
    └── index.cjs                   (public API aggregator, 28 exported symbols)
```

## Public API Contract (28 Exports)
1. `startDelegationBridge(opts)`
2. `validateComposePayload(raw)`
3. `mintToken()`
4. `checkToken(headerValue, expected)`
5. `validateDelegatePayload(body)`
6. `authorizeDelegateCaller(opts)`
7. `declaredIdentity(headers)`
8. `paneRecordForAgent(agentId, homedir)`
9. `validateReportPayload(body)`
10. `writeReportFile(value, resultsDir)`
11. `defaultResultsDir()`
12. `validateRecyclePayload(body)`
13. `validatePaneClosePayload(body)`
14. `validateShotPayload(body)`
15. `validateTaskAttachmentPayload(body)`
16. `ATTACH_MAX_PATHS`
17. `SHOT_PROMPT_MAX_CHARS`
18. `validateSprintPayload(body)`
19. `validateSprintStopPayload(body)`
20. `stripAnsi(input)`
21. `cleanPaneTail(input, maxLines)`
22. `paneHasApiError(input)`
23. `enrichDelegationSnapshot(snapshot)`
24. `writeHandshake(port, token, log, file, opts)`
25. `removeHandshake(log, file)`
26. `HANDSHAKE_REFRESH_MS`
27. `BRIDGE_FILE`
28. `BRIDGE_DIR`

## Verification
- Unit test in `tests/units.test.cjs` asserting 28/28 exports and pure validator / security helper functionality.
- Full test suite execution (`npm test`).
- ESLint verification (`npx eslint . --quiet`).
