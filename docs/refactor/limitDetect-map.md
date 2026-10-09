# Refactoring Map: `src/terminal/limitDetect.cjs` (Phase 4.11)

## Overview
`src/terminal/limitDetect.cjs` (1,081 lines, 34 exports) is the rate/usage limit detection and auto-resume analysis engine for terminal sessions (claude, codex, gemini). It parses wall clocks, relative delays, absolute dates, handles ConPTY ANSI escapes, detects interactive rate-limit selection menus, and identifies native CLI auto-continue phases.

This refactoring decomposes `limitDetect.cjs` into 5 modular submodules under `src/terminal/limit/`, ensuring all files are ≤ 300 lines while preserving 100% export, contract, and behavioral parity.

## Target Structure

```
src/terminal/
├── limitDetect.cjs             (thin facade forwarding to ./limit/index.cjs)
└── limit/
    ├── constants.cjs           (ANSI patterns, regexes, window limits, stripAnsi, stripAnsiRobust)
    ├── timeResolver.cjs        (clockEpochs, zoneClockParts, zonedDateEpoch, parseResetAt, resolveResetAt, parseAbsReset, parseMonthDayReset)
    ├── textScanner.cjs         (tailText, lastFrameText, looksLikeLimitText, isAgentWorking, inferEngine, resolveEngine, healClockText, extractReset, extractResetWide)
    ├── nativeState.cjs         (detectNativeContinueState, classifyOption, isLiveMenuTrailing, detectRateLimitPrompt)
    ├── limitDetector.cjs       (detectLimit, detectLimitState)
    └── index.cjs               (public API aggregator, 34 exported symbols)
```

## Public API Contract (34 Exports)
- ANSI & Text Stripping: `stripAnsi`, `stripAnsiRobust`
- Core Detection: `detectLimit`, `detectLimitState`
- Time & Clock Resolution: `parseResetAt`, `nextEpochForClock`, `clockEpochs`, `isUsableTimeZone`, `zoneClockParts`, `isSaneResetAt`, `resolveResetAt`, `MAX_RESET_AHEAD_MS`, `healClockText`, `extractReset`, `parseAbsReset`, `parseMonthDayReset`, `zonedDateEpoch`, `isSaneDatedResetAt`, `MAX_DATED_RESET_AHEAD_MS`
- Text Scanning & Engines: `TAIL_LINES`, `ANCHOR_LINES`, `tailText`, `RESET_SCAN_LINES`, `LAST_FRAME_LINES`, `extractResetWide`, `lastFrameText`, `looksLikeLimitText`, `isAgentWorking`, `inferEngine`, `resolveEngine`
- Native Continue & Menus: `detectNativeContinueState`, `classifyOption`, `isLiveMenuTrailing`, `detectRateLimitPrompt`

## Verification
- Unit test in `tests/units.test.cjs` asserting 34/34 exports and contracts.
- Full test suite execution (`npm test`).
- ESLint verification (`npx eslint . --quiet`).
