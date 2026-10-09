# Refactoring Map: `src/mcp/integrationCatalog.cjs` (Phase 4.15)

## Overview
`src/mcp/integrationCatalog.cjs` (1,258 lines, 16 exports) is the single source of truth for all external integrations in CrewPane / AgentSpace. It serves both the Settings UI (declaring which services exist, what keys are required, and how to configure least-privilege tokens) and the spawn resolver / MCP launcher (command, args, env variables, capabilities, and transport protocols).

This refactoring decomposes `integrationCatalog.cjs` into clean, cohesive submodules under `src/mcp/catalog/`, partitioning the 22 service definitions by domain and separating constants, masking utilities, and catalog query helpers. Every file remains well under the 400-line soft limit (and strictly ≤ 800 lines) with 100% export and contract parity.

## Target Structure

```
src/mcp/
├── integrationCatalog.cjs          (thin facade forwarding to ./catalog/index.cjs)
└── catalog/
    ├── constants.cjs               (EXTERNAL_KEY_STORE, DEFAULT_MASK, SECRET_AUTH_KINDS)
    ├── masking.cjs                 (maskDsn, maskSecret)
    ├── helpers.cjs                 (carriesSecret, isExternallyManaged, get, list, has, userFields, requiresUserFields, scopeOptions, guidanceFor, isVendorOnlyProvision)
    ├── services/
    │   ├── infraServices.cjs       (supabase, postgres, coolify, hostinger, vercel, netlify)
    │   ├── devServices.cjs         (github, gitlab, sentry, posthog)
    │   ├── collabServices.cjs      (linear, notion, figma, n8n, metabase)
    │   ├── commServices.cjs        (stripe, shopify, resend, discord, slack)
    │   ├── aiServices.cjs          (fal, elevenlabs)
    │   └── index.cjs               (aggregates all partitioned service dictionaries into CATALOG)
    └── index.cjs                   (re-exports all 16 canonical symbols)
```

## Public API Contract (16 Exports)
- Constants & Types: `CATALOG`, `DEFAULT_MASK`, `EXTERNAL_KEY_STORE`, `SECRET_AUTH_KINDS`
- Predicates & Queries: `carriesSecret`, `isExternallyManaged`, `get`, `list`, `has`, `isVendorOnlyProvision`
- Masking: `maskSecret`, `maskDsn`
- Fields & Scopes: `userFields`, `requiresUserFields`, `scopeOptions`, `guidanceFor`

## Verification
- Unit test in `tests/units.test.cjs` asserting 16/16 exports, catalog entries, masking logic, and helper functions.
- Full test suite execution (`npm test`).
- ESLint verification (`npx eslint . --quiet`).
