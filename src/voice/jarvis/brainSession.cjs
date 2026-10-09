'use strict';

const { spawn } = require('node:child_process');
const { augmentedPath } = require('../../agents/agentRunner.js');
const engineCatalog = require('../../agents/engineCatalog.cjs');
const claudeBrainSession = require('../../agents/claudeBrainSession.cjs');
const { CLAUDE_TIMEOUT_MS } = require('./constants.cjs');
const {
  buildBrainPrompt,
  buildBrainSystemPrompt,
  buildBrainTurnMessage,
  parseClaudeDecision,
} = require('./brainPrompt.cjs');

/** Spawn `claude -p` and resolve a decision, or {ok:false} on any failure. */
function decideWithClaude({
  transcript,
  context,
  claudeBin = engineCatalog.BRAIN_CLI,
  timeoutMs = CLAUDE_TIMEOUT_MS,
  spawnImpl = spawn,
}) {
  return new Promise((resolve) => {
    const prompt = buildBrainPrompt(transcript, context);
    const args = ['-p', prompt, '--output-format', 'json'];
    let child;
    try {
      const brainEnv = { ...process.env, PATH: augmentedPath(process.env.PATH) };
      child = spawnImpl(claudeBin, args, { env: brainEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, reason: 'spawn-failed', detail: String((e && e.message) || e) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(val);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish({ ok: false, reason: 'timeout' });
    }, timeoutMs);
    child.stdout && child.stdout.on('data', (d) => (stdout += d));
    child.stderr && child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) =>
      finish({ ok: false, reason: 'proc-error', detail: String((e && e.message) || e) }),
    );
    child.on('close', () => {
      const decision = parseClaudeDecision(stdout);
      if (decision) finish({ ok: true, decision });
      else finish({ ok: false, reason: 'parse-failed', detail: (stderr || stdout).slice(0, 200) });
    });
  });
}

let _brainSession = null;

function brainSession() {
  if (!_brainSession) _brainSession = claudeBrainSession.createSession({});
  return _brainSession;
}

/**
 * Oturumu kur + ilk turu öde.
 */
async function warmupBrain(opts = {}) {
  const s = brainSession();
  if (s.isReady()) return { ok: true, already: true };
  if (s.isBusy()) return { ok: false, reason: 'busy' };
  return s.warmup({ systemPrompt: buildBrainSystemPrompt(), model: opts.model || null });
}

/** Uygulama kapanırken (before-quit) — yetim `claude` süreci bırakma. */
function stopBrain() {
  if (!_brainSession) return false;
  return _brainSession.stop('quit');
}

function brainStats() {
  return _brainSession ? _brainSession.stats() : { alive: false, ready: false, busy: false, turns: 0 };
}

/** Kasıtlı öldürme — çökme gözcüsünün GERÇEK testi (ölçüm/e2e kaçış kapısı). */
function killBrainForTest(signal) {
  return _brainSession ? _brainSession.killForTest(signal) : false;
}

/** Kalıcı oturumdan bir karar iste. Oturum yoksa/ölüyse {ok:false} (beklemez). */
async function decideWithSession({ transcript, context, timeoutMs, session }) {
  const s = session || brainSession();
  const r = await s.ask(buildBrainTurnMessage(transcript, context), timeoutMs ? { timeoutMs } : {});
  if (!r.ok) return r;
  const decision = parseClaudeDecision(r.raw);
  if (!decision) return { ok: false, reason: 'parse-failed', detail: String(r.raw || '').slice(0, 200) };
  return { ok: true, decision, ms: r.ms, ttftMs: r.ttftMs };
}

module.exports = {
  claudeBrainSession,
  decideWithClaude,
  brainSession,
  warmupBrain,
  stopBrain,
  brainStats,
  killBrainForTest,
  decideWithSession,
};
