# Refactoring Map: `src/hand/handClickFsm.cjs` (Phase 4.16)

## Overview
`src/hand/handClickFsm.cjs` (1,008 lines, 11 exports) is the click and gesture finite state machine (FSM) controlling camera-based hand input in CrewPane / AgentSpace. It processes frame landmarks (pinch distance, hand speed, scale, finger configurations) and transitions through states: `IDLE`, `MOVE`, `ARMED`, `CLICK`, `DRAG`, `SCROLL`, `ZOOM`, and `PARK`.

This refactoring decomposes `handClickFsm.cjs` into clean, cohesive submodules under `src/hand/fsm/`, bringing every submodule to ≤ 300 lines (well under the 400-line soft limit and 800-line hard limit) while preserving 100% mathematical parity with the underlying gesture recognition engine.

With this phase complete, **0 files > 1,000 lines remain in the entire codebase**.

## Target Structure

```
src/hand/
├── handClickFsm.cjs          (thin facade forwarding to ./fsm/index.cjs)
└── fsm/
    ├── constants.cjs         (FSM states: IDLE, MOVE, ARMED, CLICK, DRAG, SCROLL, ZOOM, PARK; INF; action helper)
    ├── config.cjs            (defaultConfig, approachOf, rightApproachOf)
    ├── scrollEngine.cjs      (scroll units, relative scroll, residual flush, momentum tick/release/kill)
    ├── zoomEngine.cjs        (zoom filter, ratchet logic, log-scale conversion, zoomEnd)
    ├── gestureEngine.cjs     (arm, armed confirmation/timeout, hold/drag decision, noteClick, fireLeft/fireRight)
    ├── coreFsm.cjs           (ClickFSM constructor, update loop, state routing, speed and probation tracking)
    └── index.cjs             (aggregates prototype extensions and re-exports all 11 canonical symbols)
```

## Public API Contract (11 Exports)
- Classes & Functions: `ClickFSM`, `defaultConfig`, `action`
- State Constants: `IDLE`, `MOVE`, `ARMED`, `CLICK`, `DRAG`, `SCROLL`, `ZOOM`, `PARK`

## Verification
- Unit test in `tests/units.test.cjs` asserting 11/11 exports, state machine instantiation, gesture dispatch, and config generation.
- Full test suite execution (`npm test`).
- ESLint verification (`npx eslint . --quiet`).
