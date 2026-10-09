// CrewPane — Interactive Rate-Limit Prompts and Native Auto-Continue Phases.
'use strict';

const {
  TAIL_LINES,
  ANCHOR_LINES,
  OPTION_LINE,
  SLASH_LIMIT_MARKER,
  PROMPT_QUESTION,
  LIMIT_LINE,
  LEAD_NOISE,
  NATIVE_AGAIN,
  NATIVE_STALE,
  NATIVE_CANCELLED,
  NATIVE_ARMED,
} = require('./constants.cjs');
const { tailText, extractReset, resolveEngine } = require('./textScanner.cjs');

function isLiveMenuTrailing(line) {
  const t = String(line || '').trim();
  if (!t) return true;
  if (/^[╭╮╰╯─━│|┃\s]+$/.test(t)) return true;
  if (
    /enter to (?:confirm|select|continue)|esc to (?:cancel|exit|interrupt|go back)|press enter|arrow keys|↑.?↓|to (?:select|navigate)|\? for shortcuts|use .* to (?:select|move)/i.test(
      t,
    )
  ) {
    return true;
  }
  return false;
}

function classifyOption(label) {
  const lc = String(label || '').toLowerCase();
  if (/switch\s+to/.test(lc)) return 'upgrade';
  if (/wait|stop|reset|later|pause|don'?t|no\b|keep current/.test(lc)) return 'wait';
  if (/credit|upgrade|continue|keep|switch|yes\b/.test(lc)) return 'upgrade';
  return 'other';
}

function detectRateLimitPrompt(nonEmpty, anchorLines, paneEngine = null) {
  const opts = [];
  for (let i = 0; i < nonEmpty.length; i++) {
    const m = nonEmpty[i].match(OPTION_LINE);
    if (m) opts.push({ i, n: parseInt(m[1], 10), label: m[2].replace(/[\s│|]+$/, '').trim() });
  }
  if (opts.length < 2) return null;
  const lastOptIdx = opts[opts.length - 1].i;
  if (nonEmpty.length - 1 - lastOptIdx > anchorLines) return null;
  if (!nonEmpty.slice(lastOptIdx + 1).every(isLiveMenuTrailing)) return null;

  const promptOptions = opts.map((o) => ({ n: o.n, label: o.label, kind: classifyOption(o.label) }));
  const hasWait = promptOptions.some((o) => o.kind === 'wait');
  const hasUpgrade = promptOptions.some((o) => o.kind === 'upgrade');

  const ctxStart = Math.max(0, opts[0].i - 4);
  const ctx = nonEmpty.slice(ctxStart).join('\n');
  const ctxLc = ctx.toLowerCase();

  const isLimitPrompt =
    SLASH_LIMIT_MARKER.test(ctx) ||
    (/\blimits?\b/.test(ctxLc) && hasWait) ||
    (hasWait && hasUpgrade && /reset|usage|credit|upgrade|plan/.test(ctxLc));
  if (!isLimitPrompt) return null;

  const base = extractReset(nonEmpty.join('\n'));
  const wait = promptOptions.find((o) => o.kind === 'wait');
  const stopOption = wait ? wait.n : null;
  const rawLine =
    nonEmpty.slice(ctxStart).find((l) => LIMIT_LINE.test(l) || /\blimit\b/i.test(l)) ||
    nonEmpty.slice(ctxStart).find((l) => PROMPT_QUESTION.test(l)) ||
    opts[0].label;

  return {
    kind: 'prompt',
    raw: String(rawLine).trim(),
    resetClock: base.resetClock || null,
    resetRel: base.resetRel || null,
    resetAbs: base.resetAbs || null,
    resetDate: base.resetDate || null,
    resetVia: base.resetVia || null,
    engine: resolveEngine(paneEngine, nonEmpty.join('\n')),
    promptOptions,
    stopOption,
  };
}

function detectNativeContinueState(rawTail, opts = {}) {
  const maxLines = Number.isInteger(opts.maxLines) ? opts.maxLines : TAIL_LINES;
  const anchorLines = Number.isInteger(opts.anchorLines) ? opts.anchorLines : ANCHOR_LINES;
  const tail = tailText(rawTail, maxLines);
  if (!tail) return null;
  const lines = tail.split('\n').filter((l) => l.trim());
  const lead = new RegExp(LEAD_NOISE);
  for (let k = lines.length - 1; k >= Math.max(0, lines.length - 1 - anchorLines); k--) {
    const line = lines[k].replace(lead, '');
    let phase = null;
    if (NATIVE_AGAIN.test(line)) phase = 'again';
    else if (NATIVE_STALE.test(line)) phase = 'stale';
    else if (NATIVE_CANCELLED.test(line)) phase = 'cancelled';
    else if (NATIVE_ARMED.test(line)) phase = 'armed';
    if (phase) {
      const got = extractReset(lines.slice(k, k + 3).join('\n'));
      return {
        phase,
        raw: line.trim(),
        resetClock: got.resetClock || null,
        resetDate: got.resetDate || null,
        resetRel: got.resetRel || null,
        resetAbs: got.resetAbs || null,
        resetVia: got.resetVia || (got.resetClock || got.resetDate ? 'cli-band' : null),
      };
    }
  }
  return null;
}

module.exports = {
  isLiveMenuTrailing,
  classifyOption,
  detectRateLimitPrompt,
  detectNativeContinueState,
};
