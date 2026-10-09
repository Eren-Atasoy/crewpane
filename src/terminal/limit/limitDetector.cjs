// CrewPane — Core Limit Detectors (detectLimit and detectLimitState).
'use strict';

const {
  stripAnsi,
  LIMIT_HIT,
  RESET_CLOCK,
  RESET_REL,
  TAIL_LINES,
  ANCHOR_LINES,
  RESET_SCAN_LINES,
  LIMIT_LINE,
} = require('./constants.cjs');
const { parseAbsReset } = require('./timeResolver.cjs');
const {
  tailText,
  isAgentWorking,
  extractReset,
  extractResetWide,
  resolveEngine,
} = require('./textScanner.cjs');
const { detectRateLimitPrompt } = require('./nativeState.cjs');

/**
 * Detect a usage/session limit in a tail of pane output.
 */
function detectLimit(rawTail) {
  if (typeof rawTail !== 'string' || rawTail.length === 0) return null;
  const t = stripAnsi(rawTail);
  const hit = t.match(LIMIT_HIT);
  if (!hit) return null;
  const sig = { resetClock: null, resetRel: null, resetAbs: parseAbsReset(t), raw: hit[0] };
  const c = t.match(RESET_CLOCK);
  if (c && (c[2] || c[3])) {
    let h = parseInt(c[1], 10);
    const min = c[2] ? parseInt(c[2], 10) : 0;
    const ap = (c[3] || '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h <= 23 && min <= 59) sig.resetClock = { h, min, raw: c[0] };
  }
  const r = t.match(RESET_REL);
  if (r && (r[1] || r[2])) {
    sig.resetRel = {
      h: r[1] ? parseInt(r[1], 10) : 0,
      m: r[2] ? parseInt(r[2], 10) : 0,
      raw: r[0],
    };
  }
  return sig;
}

/**
 * Robust limit detection for the daemon (ADP-089/098).
 */
function detectLimitState(rawTail, opts = {}) {
  const maxLines = Number.isInteger(opts.maxLines) ? opts.maxLines : TAIL_LINES;
  const anchorLines = Number.isInteger(opts.anchorLines) ? opts.anchorLines : ANCHOR_LINES;
  const resetMaxLines = Number.isInteger(opts.resetMaxLines)
    ? opts.resetMaxLines
    : Math.max(maxLines, RESET_SCAN_LINES);
  const paneEngine = opts.engine === 'codex' || opts.engine === 'claude' ? opts.engine : null;
  const tail = tailText(rawTail, maxLines);
  if (!tail) return null;
  if (isAgentWorking(tail)) return null;

  const nonEmpty = tail
    .split('\n')
    .map((l) => l)
    .filter((l) => l.trim());

  const wide = extractResetWide(rawTail, resetMaxLines);

  // (A) Format A — interactive /rate-limit-options prompt
  const prompt = detectRateLimitPrompt(nonEmpty, anchorLines, paneEngine);
  if (prompt) {
    return {
      ...prompt,
      resetClock: wide.resetClock || prompt.resetClock,
      resetRel: wide.resetRel || prompt.resetRel,
      resetAbs: wide.resetAbs || prompt.resetAbs,
      resetDate: wide.resetDate || prompt.resetDate || null,
      resetVia: wide.resetVia || prompt.resetVia || null,
    };
  }

  // (B) Format B / plain — G3 standalone limit line, G4 anchored near the bottom
  let hitIdx = -1;
  let hitLine = null;
  for (let k = nonEmpty.length - 1; k >= 0; k--) {
    if (LIMIT_LINE.test(nonEmpty[k])) {
      hitIdx = k;
      hitLine = nonEmpty[k];
      break;
    }
  }
  if (hitIdx === -1) return null;
  if (nonEmpty.length - 1 - hitIdx > anchorLines) return null;

  const ctx = nonEmpty.slice(hitIdx).join('\n');
  const base = extractReset(ctx);

  return {
    kind: 'plain',
    raw: hitLine.trim(),
    resetClock: wide.resetClock || base.resetClock || null,
    resetRel: wide.resetRel || base.resetRel || null,
    resetAbs: wide.resetAbs || base.resetAbs || null,
    resetDate: wide.resetDate || base.resetDate || null,
    resetVia: wide.resetVia || base.resetVia || null,
    engine: resolveEngine(paneEngine, tail),
    promptOptions: [],
    stopOption: null,
  };
}

module.exports = {
  detectLimit,
  detectLimitState,
};
