# Refactoring Map: `src/terminal/resumeDaemonCore.cjs` (Phase 4.6)

## Overview
`src/terminal/resumeDaemonCore.cjs` (1,806 lines, 19 exports) orchestrates the resume daemon core state machine (`detect → prompt-stop / native → schedule → resume → verify → backoff`). It coordinates robust limit detection, tmux/pty liveness, session resolution, multi-tier timers, zero-token pre-probing, sentinel nudges, auto account switching, and post-send activity verification.

This refactoring decomposes `resumeDaemonCore.cjs` into 7 modular submodules under `src/terminal/resume/`, ensuring files are well under 800 lines (soft ≤ 400 lines) while maintaining 100% contract and behavioral parity.

## Target Structure

```
src/terminal/
├── resumeDaemonCore.cjs        (thin facade forwarding to ./resume/index.cjs)
└── resume/
    ├── constants.cjs           (all timeouts, probe intervals, sentinel windows, limits)
    ├── transcriptVerify.cjs    (formatClock, formatWhen, assistantText, assistantLinesAfter, hasAssistantLineAfter, transcriptInterruptedAfter, paneSignature)
    ├── observeHandler.cjs      (observe, _notePane, _isNative, _activeEntryOf, _observeNative, _nativeStatus, _sayNative, _externalResume, _interruptedSince, _sentinel, _tryAutoSwitch, _handlePrompt, _handlePlain, _resetSignal, _carryResetAt, _watchdogDue, _watchdogFire, _armIfNeeded, _announceSchedule, _ensureArmed)
    ├── fireHandler.cjs         (fire, _deferWhileLimited, _probeBeforeSend, _probeBlocked, _probeVerdict, _resolveSession)
    ├── verifyHandler.cjs       (verify, _activityEvidence, _verifyRetryOrFail, _fail, _backoffOrFail)
    ├── daemonCore.cjs          (ResumeDaemonCore class definition, constructor, state maps, lifecycle, prototype wiring)
    └── index.cjs               (public API aggregator, 19 exported symbols)
```

## Public API Contract (19 Exports)
1. `ResumeDaemonCore` (class)
2. `DEFAULT_VERIFY_WINDOW_MS` (number: 180_000)
3. `VERIFY_RETRY_DELAYS_MS` (frozen array: [120000, 300000, 900000, 1800000])
4. `VERIFY_MAX_ATTEMPTS` (number: 6)
5. `DEFER_PROBE_MS` (number: 300_000)
6. `UNKNOWN_MAX_DEFER_MS` (number: 3_600_000)
7. `MAX_TOTAL_DEFER_MS` (number: 21_600_000)
8. `STALE_CLOCK_GRACE_MS` (number: 21_600_000)
9. `WATCHDOG_MIN_GAP_MS` (number: 300_000)
10. `PROBE_SETTLE_MS` (number: 1_500)
11. `PROBE_RETRY_MS` (number: 60_000)
12. `PROBE_MAX_UNKNOWN` (number: 3)
13. `SENTINEL_GRACE_MS` (number: 600_000)
14. `SENTINEL_QUIET_MS` (number: 600_000)
15. `SENTINEL_MAX_NUDGES` (number: 2)
16. `transcriptInterruptedAfter(file, sinceMs)` (function)
17. `hasAssistantLineAfter(file, sinceMs)` (function)
18. `assistantLinesAfter(file, sinceMs)` (function)
19. `paneSignature(text)` (function)

## Verification
- Unit tests in `tests/units.test.cjs` asserting 19/19 exports, pure helper functionality, and class instantiation.
- Full test suite execution (`npm test`).
- ESLint verification (`npx eslint . --quiet`).
