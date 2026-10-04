// CrewPane — ADP-088 (ADR-007 Faz 2) resume scheduler core.
//
// The TIMING brain of the auto-resume system. ADP-087 built the invisible
// foundation (limit detection + session-id mint + resume-queue store). This
// module decides WHEN a queued limit should fire its resume, using plain
// `setTimeout` rather than OS cron (ADR §6.2 decision: same process → direct
// pane-handle access; restart durability comes from rescheduling the persisted
// queue on boot, not from cron surviving).
//
// PURE-ish + injectable: the class takes optional `setTimeout`/`clearTimeout`
// so tests drive a fake clock with zero real waiting (resumeScheduler.test.cjs).
// It computes delays and arms timers; it does NOT capture limits
// (terminalActivity / limitDetect) nor send the resume keystrokes (resumeTmux) —
// the daemon (scripts/resume-daemon.mjs) wires those together.
//
// Key timings (ADR §5.3 / §6.2 / §7):
//   • trigger at  resetAt + 90s buffer  (server-clock slop guard; verify catches the rest)
//   • unknown reset (resetAt=null)      → first try now + 5min, then backoff
//   • backoff      min(2^attempts min, 30min)  → 1,2,4,8,16,30,30…
//   • give up      after 8 attempts     → status=failed + notify
//   • stagger      15s between same-tick fires so N agents don't resume at once

'use strict';

// resetAt + this buffer = trigger instant. ADP-428: 60s → 90s and configurable
// (constructor opts.resetBufferMs / CREWPANE_RESUME_RESET_BUFFER_MS at the
// wiring). The incident: the "devam et" nudge landed BEFORE the limit actually
// renewed (clock slop / early reset text), so the agents stayed stuck — a wider
// margin closes the early-fire window; post-send verification catches the rest.
const RESET_BUFFER_MS = 90_000;
// resetAt unknown (time un-parseable) → first attempt this far out (ADR §5.3).
const UNKNOWN_RESET_FIRST_MS = 5 * 60_000;
// Exponential backoff cap (ADR §5.3): 1,2,4,8,16,30,30… minutes.
const BACKOFF_CAP_MS = 30 * 60_000;
// Attempts beyond this → give up (status=failed + notify, no infinite loop).
const MAX_ATTEMPTS = 8;
// Same-instant fires are spread this far apart so a reset wave doesn't trigger a
// fresh limit wave (ADR §7 staggered drain).
const STAGGER_MS = 15_000;
// setTimeout's delay is a signed 32-bit int (~24.8 days); longer waits are
// chunked. Resets are always < 24h so this is just a safety belt (ADR §6.2).
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Delay (ms, >=0) from `now` until the FIRST resume attempt for an entry.
 *   • resetAt known   → resetAt + buffer (default 90s) − now (clamped at 0 → fire now if past)
 *   • resetAt unknown → now + 5min (so a parseable-time failure still retries)
 */
function firstDelayMs(entry, now, bufferMs = RESET_BUFFER_MS) {
  const e = entry && typeof entry === 'object' ? entry : {};
  if (Number.isFinite(e.resetAt)) {
    return Math.max(0, e.resetAt + bufferMs - now);
  }
  return UNKNOWN_RESET_FIRST_MS;
}

/** Backoff delay (ms) for the Nth retry: min(2^attempts min, 30min). */
function backoffMs(attempts) {
  const a = Number.isInteger(attempts) && attempts >= 0 ? attempts : 0;
  return Math.min(2 ** a * 60_000, BACKOFF_CAP_MS);
}

/** True once an entry has exhausted its retry budget (→ caller marks failed). */
function isExhausted(attempts) {
  return Number.isInteger(attempts) && attempts >= MAX_ATTEMPTS;
}

/**
 * setTimeout that tolerates delays beyond the 32-bit cap by re-arming in chunks.
 * Returns a cancel handle ({cancel()}). `timers` is the injected {setTimeout,
 * clearTimeout} pair (real globals by default).
 */
function armLongTimeout(timers, delayMs, fn) {
  let handle = null;
  let cancelled = false;
  const arm = (remaining) => {
    if (cancelled) return;
    const chunk = Math.min(remaining, MAX_TIMEOUT_MS);
    handle = timers.setTimeout(() => {
      if (cancelled) return;
      const left = remaining - chunk;
      if (left > 0) arm(left);
      else fn();
    }, chunk);
  };
  arm(Math.max(0, delayMs));
  return {
    cancel() {
      cancelled = true;
      if (handle != null) timers.clearTimeout(handle);
    },
  };
}

/**
 * Owns the live `setTimeout` timers keyed by queue-entry id. One timer per entry;
 * scheduling the same id again replaces the prior timer (idempotent re-arm). The
 * fire callback receives the entry it was scheduled with.
 */
class ResumeScheduler {
  /**
   * @param {{setTimeout?:Function, clearTimeout?:Function}} [timers] inject for tests.
   * @param {{resetBufferMs?:number}} [opts] ADP-428 — configurable resetAt safety margin.
   */
  constructor(timers, opts) {
    this._setTimeout = (timers && timers.setTimeout) || setTimeout;
    this._clearTimeout = (timers && timers.clearTimeout) || clearTimeout;
    this.resetBufferMs =
      opts && Number.isFinite(opts.resetBufferMs) && opts.resetBufferMs >= 0
        ? opts.resetBufferMs
        : RESET_BUFFER_MS;
    /** @type {Map<string,{cancel:Function}>} */
    this._timers = new Map();
  }

  get size() {
    return this._timers.size;
  }

  has(id) {
    return this._timers.has(id);
  }

  /** Arm a timer for `id` to fire `fn` after `delayMs` (replaces any existing). */
  scheduleAt(id, delayMs, fn) {
    if (typeof id !== 'string' || !id) throw new Error('scheduleAt: id required');
    this.cancel(id);
    const t = armLongTimeout(
      { setTimeout: this._setTimeout, clearTimeout: this._clearTimeout },
      delayMs,
      () => {
        this._timers.delete(id);
        fn();
      },
    );
    this._timers.set(id, t);
    return delayMs;
  }

  /**
   * Schedule the first attempt for a queue entry. `staggerIndex>0` spreads
   * same-instant fires by STAGGER_MS (ADR §7). Returns the chosen delay (ms).
   */
  schedule(entry, fn, now, staggerIndex = 0) {
    const base = firstDelayMs(entry, now, this.resetBufferMs);
    const delay = base + Math.max(0, staggerIndex) * STAGGER_MS;
    return this.scheduleAt(entry.id, delay, () => fn(entry));
  }

  /** Re-arm a retry after a failed/limited resume, using exponential backoff. */
  scheduleBackoff(entry, fn) {
    const delay = backoffMs(entry.attempts || 0);
    return this.scheduleAt(entry.id, delay, () => fn(entry));
  }

  /**
   * Reschedule-on-boot (ADR §6.2): arm timers for every still-active entry from
   * the persisted queue. Past-due resets fire (near-)immediately; fires are
   * staggered by index so a backlog doesn't stampede. Returns the count armed.
   */
  rescheduleAll(entries, fn, now) {
    const list = Array.isArray(entries) ? entries : [];
    let n = 0;
    list.forEach((entry, i) => {
      if (!entry || typeof entry.id !== 'string') return;
      this.schedule(entry, fn, now, i);
      n++;
    });
    return n;
  }

  /** Cancel `id`'s timer if armed. Returns true if one was cancelled. */
  cancel(id) {
    const t = this._timers.get(id);
    if (!t) return false;
    t.cancel();
    this._timers.delete(id);
    return true;
  }

  /** Cancel every armed timer (shutdown). */
  clearAll() {
    for (const t of this._timers.values()) t.cancel();
    this._timers.clear();
  }
}

module.exports = {
  RESET_BUFFER_MS,
  UNKNOWN_RESET_FIRST_MS,
  BACKOFF_CAP_MS,
  MAX_ATTEMPTS,
  STAGGER_MS,
  MAX_TIMEOUT_MS,
  firstDelayMs,
  backoffMs,
  isExhausted,
  armLongTimeout,
  ResumeScheduler,
};
