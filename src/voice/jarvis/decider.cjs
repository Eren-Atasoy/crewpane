'use strict';

const fanoutPolicy = require('../../agents/fanoutPolicy.cjs');
const { parseIntent } = require('./intentParser.cjs');
const { applyExecutorPolicy } = require('./executorPolicy.cjs');
const { decideWithSession, decideWithClaude, warmupBrain } = require('./brainSession.cjs');

const FAST_LOCAL_OPS = {
  terminal: new Set(['new-shell', 'focus', 'kill']),
  navigate: new Set(['surface', 'tab', 'tab-close']),
  browser: new Set(['back', 'forward', 'reload', 'scroll', 'read', 'open', 'search']),
  report: new Set(['list', 'open', 'read']),
  board: new Set(['list']),
  memory: new Set(['what']),
  sprint: new Set(['status']),
  agent: new Set(['last-message']),
};

const FAST_LOCAL_NO_OP = new Set(['status']);

/**
 * Kural parser'ı bu transkripti GÜVENLE karara bağlayabiliyor mu?
 */
function fastLocalDecision(transcript, context) {
  let d;
  try {
    d = parseIntent(transcript, context);
  } catch {
    return null;
  }
  if (!d || !d.action) return null;
  if (FAST_LOCAL_NO_OP.has(d.action) && !d.op) return d;
  const ops = FAST_LOCAL_OPS[d.action];
  if (ops && d.op && ops.has(d.op)) return d;
  return null;
}

/** Hızlı yol açık mı? (A/B ÖLÇÜMÜ + beyni ölçen spec'ler için kapatılabilir seam.) */
function fastPathEnabled(opts = {}) {
  if (opts.fastPath === false) return false;
  if (opts.spawnImpl) return false;
  const env = String(process.env.CREWPANE_VOICE_FAST_PATH ?? '').trim();
  if (env === '0' || env.toLowerCase() === 'false') return false;
  return true;
}

async function decide(opts = {}) {
  let transcript = String(opts.transcript || '').trim();
  if (!transcript) return { ok: false, reason: 'empty-transcript' };
  if (opts.directive === 'self' && !fanoutPolicy.detectDirective(transcript)) {
    transcript = `${transcript} — sen kendin yap`;
  }
  const context = opts.context || {};
  const finish = (decision, via, extra) => ({
    ok: true,
    decision: applyExecutorPolicy(decision, transcript, context),
    via,
    ...(extra || {}),
  });
  if (fastPathEnabled(opts) && opts.useClaude !== false) {
    const fast = fastLocalDecision(transcript, context);
    if (fast) return finish(fast, 'fast-rule', { brainMs: 0, fastPath: true });
  }
  const wantSession = opts.useSession !== false && !opts.spawnImpl;
  if (opts.useClaude !== false) {
    if (wantSession) {
      const s = await decideWithSession({
        transcript,
        context,
        timeoutMs: opts.sessionTimeoutMs,
        session: opts.session,
      });
      if (s.ok && s.decision) return finish(s.decision, 'session', { brainMs: s.ms, ttftMs: s.ttftMs });
      if (!opts.session && s.reason !== 'busy') {
        void warmupBrain().catch(() => {});
      }
    }
    const c = await decideWithClaude({
      transcript,
      context,
      claudeBin: opts.claudeBin,
      timeoutMs: opts.timeoutMs,
      spawnImpl: opts.spawnImpl,
    });
    if (c.ok && c.decision) return finish(c.decision, 'claude');
  }
  return finish(parseIntent(transcript, context), 'rule');
}

module.exports = {
  FAST_LOCAL_OPS,
  FAST_LOCAL_NO_OP,
  fastLocalDecision,
  fastPathEnabled,
  decide,
};
