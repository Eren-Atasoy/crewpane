# Refactoring Map: `src/agents/agentSettings.cjs` (Phase 4.7)

## Overview
`src/agents/agentSettings.cjs` (1,361 lines, 32 exports) is the central settings store (`~/.crewpane/settings.json`) used by the main process and preload bridge. It manages workspace roots, theme, language preferences, browser trust lists, telemetry state, resource governor thresholds, memory search preferences, provider policies, and team scope permissions.

This refactoring decomposes `agentSettings.cjs` into 6 cohesive submodules under `src/agents/settings/`, ensuring every file is well under 400 lines while preserving 100% export and behavioral parity.

## Target Structure

```
src/agents/
├── agentSettings.cjs           (thin facade forwarding to ./settings/index.cjs)
└── settings/
    ├── constants.cjs           (push-to-talk keys, theme modes, regexes, defaults factory)
    ├── sanitizers.cjs          (pure validators & normalizers for themes, trust, telemetry, engines, etc.)
    ├── teamScopePolicy.cjs     (team scope mandate and permission grants/revocations)
    ├── workspaceRoot.cjs       (directory probing, configured workspace root status, resolution)
    ├── settingsStore.cjs       (cached read/write, atomic persistence, roundtrip verification)
    └── index.cjs               (public API aggregator, 32 exported symbols)
```

## Public API Contract (32 Exports)
1. `settingsPath()`
2. `PUSH_TO_TALK_KEYS`
3. `THEME_MODES`
4. `sanitizeTheme(raw)`
5. `sanitizeLocale(raw)`
6. `sanitizeVoiceLocale(raw)`
7. `sanitizeBrowserTrust(raw)`
8. `sanitizeTelemetryState(raw)`
9. `sanitizeResourceGovernor(raw)`
10. `sanitizeMemorySearch(raw)`
11. `sanitizeEngines(raw)`
12. `VENDOR_HOSTED_POLICIES`
13. `ensureTeamScopeMandate(appVersion)`
14. `sanitizeTeamCompose(raw)`
15. `teamScopePolicy(appVersion)`
16. `grantTeamScope(opts)`
17. `revokeTeamScope(opts)`
18. `DEFAULT_PUSH_TO_TALK_KEY`
19. `defaults()`
20. `readSettings()`
21. `writeSettings(patch, opts)`
22. `applySettingsPatch(patch)`
23. `lastPersistOutcome()`
24. `setPersistLogger(fn)`
25. `configuredWorkspaceRoot()`
26. `configuredWorkspaceRootStatus()`
27. `probeDir(p)`
28. `resolveWorkspaceRoot(fallback)`
29. `openAiKeyFromSettings()`
30. `isDir(p)`
31. `invalidateCache()`
32. `_resetCache()`

## Verification
- Unit test in `tests/units.test.cjs` asserting 32/32 exports and pure helper functionality.
- Full test suite execution (`npm test`).
- ESLint verification (`npx eslint . --quiet`).
