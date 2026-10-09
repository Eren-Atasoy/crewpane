// CrewPane — Terminal Limit Reset Time and Timezone Resolution.
'use strict';

const {
  RESET_ABS,
  MONTHS3,
  RESET_MONTHDAY,
  RESET_TZ,
  MAX_DATED_RESET_AHEAD_MS,
  MAX_RESET_AHEAD_MS,
} = require('./constants.cjs');

/**
 * CDX-LIMIT-02 — parse an ABSOLUTE reset date ("Aug 30th, 2026 2:24 AM") to a
 * local-zone epoch.
 */
function parseAbsReset(text) {
  const m = String(text == null ? '' : text).match(RESET_ABS);
  if (!m) return null;
  const mo = MONTHS3.indexOf(m[1].toLowerCase());
  const day = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  let h = parseInt(m[4], 10);
  const min = parseInt(m[5], 10);
  const ap = m[6].toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (mo < 0 || day < 1 || day > 31 || h > 23 || min > 59) return null;
  const at = new Date(year, mo, day, h, min, 0, 0).getTime();
  return Number.isFinite(at) ? { at, raw: m[0] } : null;
}

const TZ_OK_CACHE = new Map();
function isUsableTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  if (TZ_OK_CACHE.has(tz)) return TZ_OK_CACHE.get(tz);
  let ok = false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz }).format(0);
    ok = true;
  } catch {
    ok = false;
  }
  TZ_OK_CACHE.set(tz, ok);
  return ok;
}

/**
 * Wall-clock {hour,minute,second} of `now` in `tz`. Returns null (never throws) when
 * the zone is unusable.
 */
function zoneClockParts(now, tz) {
  if (!isUsableTimeZone(tz)) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(now));
    const cur = {};
    for (const p of parts) if (p.type !== 'literal') cur[p.type] = parseInt(p.value, 10);
    if (!Number.isFinite(cur.hour) || !Number.isFinite(cur.minute)) return null;
    return {
      hour: cur.hour === 24 ? 0 : cur.hour,
      minute: cur.minute,
      second: Number.isFinite(cur.second) ? cur.second : 0,
    };
  } catch {
    return null;
  }
}

/** Wall-clock parts of `now` in the OS-local zone — no ICU involved. */
function localClockParts(now) {
  const d = new Date(now);
  return { hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds() };
}

/**
 * LIMIT-RESUME-02 — {year, month(1-12), day} of `now` in `tz`.
 */
function zoneDateParts(now, tz) {
  if (tz && isUsableTimeZone(tz)) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(new Date(now));
      const cur = {};
      for (const q of parts) if (q.type !== 'literal') cur[q.type] = parseInt(q.value, 10);
      if (Number.isFinite(cur.year) && Number.isFinite(cur.month) && Number.isFinite(cur.day)) {
        return { year: cur.year, month: cur.month, day: cur.day };
      }
    } catch {
      /* fall through to local */
    }
  }
  const d = new Date(now);
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

/**
 * LIMIT-RESUME-02 — epoch of wall-clock `year-month-day h:min` in `tz`.
 */
function zonedDateEpoch(year, month, day, h, min, tz) {
  if (!tz || !isUsableTimeZone(tz)) return new Date(year, month - 1, day, h, min, 0, 0).getTime();
  const target = Date.UTC(year, month - 1, day, h, min, 0, 0);
  let guess = target;
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    for (let i = 0; i < 2; i++) {
      const cur = {};
      for (const q of fmt.formatToParts(new Date(guess))) {
        if (q.type !== 'literal') cur[q.type] = parseInt(q.value, 10);
      }
      const wall = Date.UTC(cur.year, cur.month - 1, cur.day, cur.hour === 24 ? 0 : cur.hour, cur.minute, 0, 0);
      guess += target - wall;
    }
  } catch {
    return new Date(year, month - 1, day, h, min, 0, 0).getTime();
  }
  return guess;
}

/**
 * LIMIT-RESUME-02 — parse a YEARLESS "Sep 20 at 7pm" reset.
 */
function parseMonthDayReset(text) {
  const t = String(text == null ? '' : text);
  const m = t.match(RESET_MONTHDAY);
  if (!m) return null;
  const mo = MONTHS3.indexOf(m[1].toLowerCase());
  const day = parseInt(m[2], 10);
  let h = parseInt(m[3], 10);
  const min = m[4] ? parseInt(m[4], 10) : 0;
  const ap = m[5].toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (mo < 0 || day < 1 || day > 31 || h > 23 || min > 59) return null;
  const out = { month: mo + 1, day, h, min, raw: m[0] };
  const after = t.slice(m.index + m[0].length, m.index + m[0].length + 40);
  const tzm = after.match(RESET_TZ);
  if (tzm) out.tz = tzm[1];
  return out;
}

/** True when `at` is a sane future DATED reset instant for `now` (LIMIT-RESUME-02). */
function isSaneDatedResetAt(at, now) {
  return Number.isFinite(at) && at > now && at - now <= MAX_DATED_RESET_AHEAD_MS;
}

/**
 * Both instants a printed wall clock can mean, and which one we had to take:
 */
function clockEpochs(h, min, now, tz) {
  const cur = zoneClockParts(now, tz) || localClockParts(now);
  const deltaMin = h * 60 + min - (cur.hour * 60 + cur.minute) - cur.second / 60;
  const rolledOver = deltaMin <= 0;
  return {
    at: Math.round(now + (rolledOver ? deltaMin + 24 * 60 : deltaMin) * 60000),
    clockAt: Math.round(now + deltaMin * 60000),
    rolledOver,
  };
}

/** Next epoch (ms) at which wall-clock `h:min` occurs in `tz` (today or tomorrow). */
function nextEpochForClock(h, min, now, tz) {
  return clockEpochs(h, min, now, tz).at;
}

/** True when `at` is a sane future reset instant for `now` (ADP-938 sanity gate). */
function isSaneResetAt(at, now) {
  return Number.isFinite(at) && at > now && at - now <= MAX_RESET_AHEAD_MS;
}

/**
 * Resolve a LimitSignal's reset time.
 */
function resolveResetAt(signal, now, tz = null) {
  const none = { at: null, source: null, zone: null, rolledOver: false, clockAt: null, via: null };
  if (!signal) return none;
  if (signal.resetRel) {
    const ms = (signal.resetRel.h * 3600 + signal.resetRel.m * 60) * 1000;
    const at = ms > 0 ? now + ms : null;
    return { ...none, at: isSaneResetAt(at, now) ? at : null, source: at == null ? null : 'rel' };
  }
  if (signal.resetAbs && Number.isFinite(signal.resetAbs.at)) {
    const at = signal.resetAbs.at;
    return {
      ...none,
      at: isSaneResetAt(at, now) ? at : null,
      source: isSaneResetAt(at, now) ? 'abs' : null,
      clockAt: at,
    };
  }
  if (signal.resetDate && Number.isFinite(signal.resetDate.day)) {
    const d = signal.resetDate;
    const zone = d.tz || tz || null;
    const cur = zoneDateParts(now, zone);
    let at = zonedDateEpoch(cur.year, d.month, d.day, d.h, d.min, zone);
    if (now - at > MAX_DATED_RESET_AHEAD_MS) {
      at = zonedDateEpoch(cur.year + 1, d.month, d.day, d.h, d.min, zone);
    }
    const sane = isSaneDatedResetAt(at, now);
    return {
      ...none,
      at: sane ? at : null,
      source: sane ? 'date' : null,
      zone,
      clockAt: Number.isFinite(at) ? at : null,
      rolledOver: false,
      via: signal.resetVia || null,
    };
  }
  if (signal.resetClock) {
    const zone = signal.resetClock.tz || tz || null;
    const usable = zone == null ? true : isUsableTimeZone(zone);
    const e = clockEpochs(signal.resetClock.h, signal.resetClock.min, now, zone);
    return {
      at: isSaneResetAt(e.at, now) ? e.at : null,
      source: usable ? 'clock' : 'clock-local-fallback',
      zone,
      rolledOver: e.rolledOver,
      clockAt: e.clockAt,
      via: signal.resetVia || null,
    };
  }
  return none;
}

/**
 * Resolve a LimitSignal's reset time to an absolute epoch (ms).
 */
function parseResetAt(signal, now, tz = null) {
  return resolveResetAt(signal, now, tz).at;
}

module.exports = {
  parseAbsReset,
  isUsableTimeZone,
  zoneClockParts,
  localClockParts,
  zoneDateParts,
  zonedDateEpoch,
  parseMonthDayReset,
  isSaneDatedResetAt,
  clockEpochs,
  nextEpochForClock,
  isSaneResetAt,
  resolveResetAt,
  parseResetAt,
};
