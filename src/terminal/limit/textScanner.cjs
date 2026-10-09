// CrewPane — Terminal Tail Scanner, Working Detection, and Reset Extraction.
'use strict';

const {
  TAIL_LINES,
  stripAnsiRobust,
  BRAILLE_SPINNER,
  WORK_GLYPH_WORD,
  UNICODE_COLONS,
  CONTINUE_AT,
  RESET_TZ,
  RESET_CLOCK_ALL,
  RESET_REL,
  LIMIT_LINE,
  RESET_SCAN_LINES,
  LAST_FRAME_LINES,
} = require('./constants.cjs');
const { parseAbsReset, parseMonthDayReset } = require('./timeResolver.cjs');

/** Last `maxLines` lines of `text` after ANSI-strip, with trailing blanks dropped. */
function tailText(text, maxLines = TAIL_LINES) {
  const stripped = stripAnsiRobust(typeof text === 'string' ? text : '');
  const lines = stripped.replace(/\r/g, '').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.slice(-Math.max(1, maxLines)).join('\n');
}

function isAgentWorking(tail) {
  const t = typeof tail === 'string' ? tail : '';
  if (/esc to interrupt/i.test(t)) return true;
  if (BRAILLE_SPINNER.test(t)) return true;
  if (WORK_GLYPH_WORD.test(t)) return true;
  return false;
}

function healClockText(text) {
  return String(text == null ? '' : text)
    .replace(UNICODE_COLONS, ':')
    .replace(/(\d{1,2})\s*:[\s│|>•▏▌·∙]*(\d{2})(?!\d)/g, '$1:$2');
}

/**
 * Parse reset clock/relative parts from text.
 */
function extractReset(text) {
  const t = healClockText(text);
  const out = { resetClock: null, resetRel: null, resetAbs: parseAbsReset(t), resetDate: null, resetVia: null };
  const band = t.match(CONTINUE_AT);
  if (band) {
    const after = t.slice(band.index + band[0].length, band.index + band[0].length + 60);
    const md = parseMonthDayReset(after);
    if (md) {
      out.resetDate = md;
      out.resetVia = 'cli-band';
    } else {
      const c = after.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]m)?/i);
      if (c && (c[2] || c[3])) {
        let h = parseInt(c[1], 10);
        const min = c[2] ? parseInt(c[2], 10) : 0;
        const ap = (c[3] || '').toLowerCase();
        if (ap === 'pm' && h < 12) h += 12;
        if (ap === 'am' && h === 12) h = 0;
        if (h <= 23 && min <= 59) {
          const clock = { h, min, raw: band[0] + c[0] };
          const tzm = after.slice(c[0].length, c[0].length + 40).match(RESET_TZ);
          if (tzm) clock.tz = tzm[1];
          out.resetClock = clock;
          out.resetVia = 'cli-band';
        }
      }
    }
    if (out.resetVia) return out;
  }
  const dated = /resets?(?:\s+at)?\s+(?=[a-z]{3})/i.exec(t);
  if (dated) {
    const md = parseMonthDayReset(t.slice(dated.index + dated[0].length, dated.index + dated[0].length + 60));
    if (md) {
      out.resetDate = md;
      return out;
    }
  }
  for (const c of t.matchAll(RESET_CLOCK_ALL)) {
    if (!c[2] && !c[3]) continue;
    let h = parseInt(c[1], 10);
    const min = c[2] ? parseInt(c[2], 10) : 0;
    const ap = (c[3] || '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h > 23 || min > 59) continue;
    const clock = { h, min, raw: c[0] };
    const after = t.slice(c.index + c[0].length, c.index + c[0].length + 40);
    const tzm = after.match(RESET_TZ);
    if (tzm) clock.tz = tzm[1];
    out.resetClock = clock;
    break;
  }
  const r = t.match(RESET_REL);
  if (r && (r[1] || r[2])) {
    out.resetRel = {
      h: r[1] ? parseInt(r[1], 10) : 0,
      m: r[2] ? parseInt(r[2], 10) : 0,
      raw: r[0],
    };
  }
  return out;
}

/**
 * RES-03 — read the reset time from a WIDER window than detection used.
 */
function extractResetWide(rawTail, maxLines = RESET_SCAN_LINES) {
  const wide = tailText(rawTail, Math.max(TAIL_LINES, maxLines));
  const lines = wide.split('\n').filter((l) => l.trim());
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!LIMIT_LINE.test(lines[k])) continue;
    const got = extractReset(lines.slice(k, k + 3).join('\n'));
    if (got.resetClock || got.resetRel || got.resetAbs || got.resetDate) return got;
  }
  return extractReset(wide);
}

function lastFrameText(text, lines = LAST_FRAME_LINES) {
  return tailText(text, lines);
}

function looksLikeLimitText(text) {
  const t = stripAnsiRobust(typeof text === 'string' ? text : '');
  if (!t.trim()) return false;
  return t.split('\n').some((l) => LIMIT_LINE.test(l));
}

function inferEngine(tail) {
  const t = (typeof tail === 'string' ? tail : '').toLowerCase();
  if (/message limit|try again (?:in|at)|\bcodex\b/.test(t)) return 'codex';
  if (/usage credits|session limit|claude (?:ai )?usage limit|out of (?:extra )?usage|\d-?\s*hour limit (?:reached|resets)/.test(t)) {
    return 'claude';
  }
  return null;
}

function resolveEngine(paneEngine, tail) {
  if (paneEngine === 'codex' || paneEngine === 'claude') return paneEngine;
  return inferEngine(tail);
}

module.exports = {
  tailText,
  isAgentWorking,
  healClockText,
  extractReset,
  extractResetWide,
  lastFrameText,
  looksLikeLimitText,
  inferEngine,
  resolveEngine,
};
