# Refactoring Map: `src/agents/engineAuth.cjs` (Phase 4.10)

## Overview
`src/agents/engineAuth.cjs` (1,191 lines, 30 exports) manages subscription and API-key based authentication for AI engines (claude, codex, cursor, crush, etc.), status probing, background OAuth login flows, and secure credential storage.

This refactoring decomposes `engineAuth.cjs` into 5 modular submodules under `src/agents/engineAuth/`, ensuring all files are ≤ 300 lines while preserving 100% export, contract, and behavioral parity.

## Target Structure

```
src/agents/
├── engineAuth.cjs              (thin facade forwarding to ./engineAuth/index.cjs)
└── engineAuth/
    ├── constants.cjs           (LOGIN_TIMEOUT_MS, STATUS_TIMEOUT_MS, maskSecrets)
    ├── descriptors.cjs         (authDescriptor, authEngines, envDescriptors, AUTH_ENGINES, ENGINE_AUTH_META, argv helpers)
    ├── statusParser.cjs        (parseJsonStatus, parseTextStatus, parseExitCodeStatus, parseStatus, statusUnmeasured)
    ├── apiKeyStore.cjs         (createVaultApiKeyStore, apiKeyEnvFor, engineMessageOf, verifyApiKey, setApiKey, clearApiKey)
    ├── execRunner.cjs          (resolveBin, execEnv, readStatus, readAllStatus, startLogin, logout)
    └── index.cjs               (public API aggregator, 30 exported symbols)
```

## Public API Contract (30 Exports)
- Constants & Masking: `LOGIN_TIMEOUT_MS`, `STATUS_TIMEOUT_MS`, `maskSecrets`
- Descriptors: `AUTH_ENGINES`, `ENGINE_AUTH_META`, `authDescriptor`, `authEngines`, `envDescriptors`, `authKindOf`, `statusArgv`, `loginArgv`, `logoutArgv`
- Status Parsers: `parseJsonStatus`, `parseTextStatus`, `parseStatus`, `parseClaudeStatus`, `parseCodexStatus`, `statusUnmeasured`
- Execution & Login: `extractUrl`, `wantsCode`, `readStatus`, `readAllStatus`, `startLogin`, `logout`
- API Key & Vault: `createVaultApiKeyStore`, `apiKeyEnvFor`, `engineMessageOf`, `verifyApiKey`, `setApiKey`, `clearApiKey`

## Verification
- Unit test in `tests/units.test.cjs` asserting 30/30 exports and contracts.
- Full test suite execution (`npm test`).
- ESLint verification (`npx eslint . --quiet`).
