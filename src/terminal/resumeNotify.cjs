// CrewPane — ADP-088 (ADR-007 Faz 2) resume notifications.
//
// Q1 KARAR (Eren): resume is SESSİZ-AUTOMATIC — no approval gate. The only human
// touchpoint is an after-the-fact notice. This appends one timestamped line to
// the SAME notify log spawn-worker/watch-agent-result already use
// (docs/.agent-notifications), so a resume event shows up in Optimus's existing
// monitor tail (`grep RESUME|DONE|TIMEOUT|FAIL`). Best-effort + pure-ish: the
// line builder is testable; the append never throws (a failed notify must not
// break a resume).

'use strict';

const fs = require('node:fs');

/** HH:MM:SS for a given epoch (default now), local time — matches watch-agent-result. */
function stamp(now) {
  const d = Number.isFinite(now) ? new Date(now) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Build a notify line for a resume lifecycle event. `kind` is the leading tag the
 * monitor greps for:
 *   • RESUME  → fired / back to work after a limit
 *   • FAIL    → gave up after backoff (Eren should look)
 *   • DRYRUN  → ADP-089: what the daemon WOULD do (default-off safety mode), but
 *               did not send to any pane. Optimus reviews these before going live.
 * Returns e.g. "[10:31:05] RESUME: ADP-086 limit sonrası devam etti (pane crewpane:adteam.5)".
 */
function buildLine(kind, taskOrAgent, detail, now) {
  const tag = kind === 'fail' ? 'FAIL' : kind === 'dryrun' ? 'DRYRUN' : 'RESUME';
  const who = taskOrAgent || '?';
  const tail = detail ? ` ${detail}` : '';
  return `[${stamp(now)}] ${tag}: ${who}${tail}`;
}

/** Append a line to the notify log (best-effort; returns true on success). */
function append(logPath, line) {
  try {
    fs.appendFileSync(logPath, line.endsWith('\n') ? line : `${line}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Convenience: build + append a resume/fail notice. */
function notify(logPath, kind, taskOrAgent, detail, now) {
  return append(logPath, buildLine(kind, taskOrAgent, detail, now));
}

module.exports = { stamp, buildLine, append, notify };
