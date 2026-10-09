# Refactoring Map: `src/mobile/mobileGateway.js` (Phase 4.12)

## Overview
`src/mobile/mobileGateway.js` (1,150 lines, 12 exports) implements the local HTTP/SSE gateway server for mobile device pairing, read-only office/pane/tasks inspection, authenticated command dispatching (prompt/task delegation/approvals), mobile web UI static asset serving (SPA + immutable assets), file upload intake, and Whisper speech-to-text proxy.

This refactoring decomposes `mobileGateway.js` into cohesive submodules under `src/mobile/gateway/`, ensuring all files are ≤ 350 lines while preserving 100% export, contract, and behavioral parity.

## Target Structure

```
src/mobile/
├── mobileGateway.js               (thin facade forwarding to ./gateway/index.js)
└── gateway/
    ├── constants.js               (limits, route tables, MIME types, route/param parsers)
    ├── payloadParser.js           (readRaw, readBody, parseMultipart, readCommandPayload, withTimeout, send)
    ├── staticWeb.js               (serveWeb static asset / SPA handler with safe path traversal checks)
    ├── sttHelper.js               (runStt Whisper speech-to-text proxy with vocab hints)
    ├── gatewayServer.js           (startMobileGateway, request routing & dispatch, SSE streaming)
    └── index.js                   (public API aggregator, 12 exported symbols)
```

## Public API Contract (12 Exports)
- Constants & Configuration: `DEFAULT_PORT`, `MAX_AUDIO_BYTES`, `MAX_UPLOAD_BODY_BYTES`, `MAX_ATTACHMENTS`, `ROUTE_SCOPES`, `COMMAND_KINDS`, `QUERY_KINDS`, `TASK_STATUSES`
- URL & Param Routing: `routeKeyFor`, `queryParamsFor`
- Body Parsing: `parseMultipart`
- Server Lifecycle: `startMobileGateway`

## Verification
- Unit test in `tests/units.test.cjs` asserting 12/12 exports and router/parser contracts.
- Full test suite execution (`npm test`).
- ESLint verification (`npx eslint . --quiet`).
