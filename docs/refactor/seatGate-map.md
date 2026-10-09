# Refactoring Map: `src/security/seatGate.cjs` (Phase 4.8)

## Overview
`src/security/seatGate.cjs` (1,333 lines, 5 exports) manages CrewPane user authentication, seat entitlement evaluation, device leasing, past-due payment dunning, license token fetching, and access gating (`pty:spawn`, bridge, and app DB token gating).

This refactoring decomposes `seatGate.cjs` into 7 modular submodules under `src/security/seat/`, ensuring all files are ≤ 350 lines while preserving 100% export, contract, and behavioral parity.

## Target Structure

```
src/security/
├── seatGate.cjs             (thin facade forwarding to ./seat/index.cjs)
└── seat/
    ├── constants.cjs        (DEVICE_DENIALS, SEAT_PRODUCT, default constants)
    ├── decideAccess.cjs     (decideAccess pure decision engine)
    ├── dunningParser.cjs    (readPastDue, readCancelEnding)
    ├── deviceLease.cjs      (device lease release, list, revoke, and heartbeat actions)
    ├── licenseManager.cjs   (license token refresh, local evaluation, revocation verdict)
    ├── seatGateCore.cjs     (createSeatGate factory, desktop auth wiring, lifecycle, URL handlers)
    └── index.cjs            (public API aggregator, 5 exported symbols)
```

## Public API Contract (5 Exports)
1. `createSeatGate(opts)` (function)
2. `decideAccess(snapshot)` (function)
3. `readPastDue(verify, productIds, graceSeconds)` (function)
4. `readCancelEnding(verify, productIds)` (function)
5. `SEAT_PRODUCT` (string: `'crewpane.seat'`)

## Verification
- Unit test in `tests/units.test.cjs` asserting 5/5 exports and access decision contracts.
- Full test suite execution (`npm test`).
- ESLint verification (`npx eslint . --quiet`).
