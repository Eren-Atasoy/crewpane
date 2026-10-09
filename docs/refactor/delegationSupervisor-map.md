# Refactoring Map: `src/agents/delegationSupervisor.cjs` (Phase 4.4)

## Overview
`src/agents/delegationSupervisor.cjs` (1,872 lines) is the core delegation supervisor responsible for managing sub-task delegations, tracking completions, delivery verification, ghost pane reaping, queue advancing, leader wakeups, restart repairs, and external shutdown markings.

This refactoring decomposes `delegationSupervisor.cjs` into 8 modular submodules under `src/agents/supervisor/`, reducing file complexity to ≤ 400 lines per file while preserving 100% contract and behavioral parity.

## Target Structure

```
src/agents/
├── delegationSupervisor.cjs        (thin facade forwarding to ./supervisor/index.cjs)
└── supervisor/
    ├── constants.cjs               (STORE_VERSION, DEFAULTS, GATE_REASON_TR, SETTLE_SOURCES, isTerminalStatus)
    ├── stateRecord.cjs             (recordKey, normalizeState, deliveryVerdict, wakeDue, wakeTextFor)
    ├── evidenceDetect.cjs          (evidencePaths, foundElsewhereNote, baselineFor, evidenceChanged, evidenceFresh, evidenceSeen, markerCount, markerSeen, detect)
    ├── deliveryVerify.cjs          (verifyDelivery, recoverHangingPrompts)
    ├── leaderWake.cjs              (findLeaderPane, canVerifyWake, verifyWakes, consumeBriefings, wakeLeaders, scheduleWakeFollowUp)
    ├── ghostReaper.cjs             (notifyOnce, advanceQueue, reapGhostPane, markExternalShutdown, externalShutdownNote, repairAfterRestart, prune)
    ├── supervisorCore.cjs          (createDelegationSupervisor factory, lifecycle, state orchestration, sweep tick loop, runBoardSync)
    └── index.cjs                   (public API aggregator, 9 exported symbols)
```

## Public API Contract (9 Exports)
1. `STORE_VERSION` (number)
2. `DEFAULTS` (frozen object)
3. `SETTLE_SOURCES` (frozen object)
4. `recordKey(delegationId, subtaskId)` (function)
5. `normalizeState(raw)` (function)
6. `wakeDue(wake, now, backoff, ackWindowMs, busyRetryMs)` (function)
7. `wakeTextFor(records)` (function)
8. `deliveryVerdict(ev)` (function)
9. `createDelegationSupervisor(deps)` (function)

## Verification
- Unit test in `tests/units.test.cjs` asserting 9/9 exports and pure helper functionality.
- Full test suite execution (`npm test`).
- ESLint verification (`npx eslint . --quiet`).
