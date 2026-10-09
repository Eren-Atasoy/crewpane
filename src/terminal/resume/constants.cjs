// CrewPane — ADP-089 (ADR-007 v2) resume daemon orchestration constants.
'use strict';

// ADP-428: watch the pane 3min post-send (was 90s). The incident proved 90s is
// inside claude's own retry chatter; 3min gives the agent time to produce REAL
// assistant output (or re-print the limit) before we judge the attempt.
const DEFAULT_VERIFY_WINDOW_MS = 180_000;

// ADP-428 — a verify FAILURE (still limited / no assistant output) re-sends with
// this escalating wait chain; after VERIFY_MAX_ATTEMPTS total sends → failed +
// onFail (visible alert). Distinct from the pre-send backoff (1,2,4… ×8): here
// the send LANDED but did not take, so we wait longer and give up sooner+louder.
//
// RES-04 — 5m,15m ×3 → 2m,5m,15m,30m ×6.
const VERIFY_RETRY_DELAYS_MS = Object.freeze([2 * 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000]);
const VERIFY_MAX_ATTEMPTS = 6;

// ADP-938 — early-fire guard (see _deferWhileLimited). While a pane still shows its
// limit and the reset instant is UNKNOWN we re-look this often instead of sending…
const DEFER_PROBE_MS = 5 * 60_000;

// …but never longer than this after detection: an unknown reset must not turn into a
// permanently parked agent. Past this, the send goes out and verify/retry judges it.
const UNKNOWN_MAX_DEFER_MS = 60 * 60_000;

// Hard ceiling on ANY unknown-reset deferral chain, measured from detection. Claude's
// session window is 5h; past 6h a still-limited screen is far likelier to be stale
// output than a live limit, so we stop holding the agent back.
const MAX_TOTAL_DEFER_MS = 6 * 60 * 60_000;

// ADP-947 — a printed wall clock that passed within this window means the reset
// ALREADY HAPPENED, not that it is due tomorrow (see _resetInstant). Same 6h as
// above and for the same reason: claude's session window is 5h, so a reset clock
// more than 6h behind us belongs to a screen we should no longer be waiting on.
const STALE_CLOCK_GRACE_MS = MAX_TOTAL_DEFER_MS;

// ADP-947 — poll-driven watchdog: how often an entry whose reset is already due may
// be re-fired from the poll loop when its own setTimeout never came due.
const WATCHDOG_MIN_GAP_MS = DEFER_PROBE_MS;

// ─── RES-05 — SIFIR-TOKEN ÖN-YOKLAMA ────────────────────────────────────────
const PROBE_SETTLE_MS = 1_500;
const PROBE_RETRY_MS = 60_000;
const PROBE_MAX_UNKNOWN = 3;

// ─── LIMIT-RESUME-02 — MOTORUN OTOMATİK-DEVAMI ANA YOL, DAEMON YALNIZ NÖBETÇİ ───
const SENTINEL_GRACE_MS = 10 * 60_000;
const SENTINEL_QUIET_MS = 10 * 60_000;
const SENTINEL_MAX_NUDGES = 2;
const EXTERNAL_CHECK_MIN_GAP_MS = 30_000;

// ADP-428 — how much of the transcript tail to scan for a post-send assistant line.
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

module.exports = {
  DEFAULT_VERIFY_WINDOW_MS,
  VERIFY_RETRY_DELAYS_MS,
  VERIFY_MAX_ATTEMPTS,
  DEFER_PROBE_MS,
  UNKNOWN_MAX_DEFER_MS,
  MAX_TOTAL_DEFER_MS,
  STALE_CLOCK_GRACE_MS,
  WATCHDOG_MIN_GAP_MS,
  PROBE_SETTLE_MS,
  PROBE_RETRY_MS,
  PROBE_MAX_UNKNOWN,
  SENTINEL_GRACE_MS,
  SENTINEL_QUIET_MS,
  SENTINEL_MAX_NUDGES,
  EXTERNAL_CHECK_MIN_GAP_MS,
  TRANSCRIPT_TAIL_BYTES,
};
