// CrewPane — Resume verification, retry scheduling, and failure handling.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const limitDetect = require('../limitDetect.cjs');
const resumeQueue = require('../resumeQueue.cjs');
const resumeTmux = require('../resumeTmux.cjs');
const { isExhausted } = require('../resumeScheduler.cjs');
const { MAX_TOTAL_DEFER_MS } = require('./constants.cjs');
const {
  formatClock,
  paneSignature,
  assistantLinesAfter,
} = require('./transcriptVerify.cjs');

/**
 * Post-resume check (ADR §5.3 + ADP-428): re-capture the pane and re-run ROBUST
 * detection, then demand POSITIVE evidence that the assistant actually produced
 * output after our send.
 */
function verify(entrySnapshot) {
  const entry = this._reload(entrySnapshot);
  const text = this.capturePane(entry.paneRef);
  const since = Number.isFinite(entry.firedAt) ? entry.firedAt : entry.detectedAt || 0;
  const evidence = this.activityEvidence(entry, since, text) || { ok: false };

  // (1) RES-02 §2 — the engine ANSWERED our nudge with its own limit line.
  if (evidence.limitAgain) {
    this._track('verify', entry, { outcome: 'limit-again', evidenceSrc: evidence.src || null });
    return this._verifyRetryOrFail(
      entry,
      'devam denemesi limite ÇARPTI (motor limit satırını geri döndürdü)',
      { limitText: evidence.limitText, outcome: 'limit-again' },
    );
  }
  if (limitDetect.detectLimitState(text)) {
    this._track('verify', entry, { outcome: 'still-limited', evidenceSrc: 'pane' });
    return this._verifyRetryOrFail(entry, 'resume sonrası hâlâ limitli', { limitText: text });
  }
  if (evidence.ok) {
    resumeQueue.updateEntry(entry.id, { status: 'resumed', lastError: null }, this.homedir);
    this._notify(
      'resume',
      entry,
      `kaldığı yerden devam ediyor ✓ (pane ${entry.paneRef}, kanıt: ${evidence.src || '?'})`,
    );
    this._track('verify', entry, { outcome: 'resumed', evidenceSrc: evidence.src || null });
    this._emit('resumed', entry, evidence.src || null, {
      nextAttemptAt: null,
      resetAt: null,
      resetKnown: false,
      verdict: null,
    });
    resumeQueue.removeEntry(entry.id, this.homedir);
    this._watchdog.delete(entry.id); // ADP-947
    this._probe.delete(entry.id); // RES-05
    return 'resumed';
  }
  this._track('verify', entry, { outcome: 'no-evidence' });
  return this._verifyRetryOrFail(entry, 'resume sonrası asistan çıktısı yok (kanıt bulunamadı)');
}

/**
 * Post-send evidence. ADP-428 made it POSITIVE-only; RES-02 makes it HONEST about
 * the negative case.
 */
function _activityEvidence(entry, sinceMs, text) {
  const changedSinceSend =
    !entry || !entry.firedSig || entry.firedSig !== paneSignature(text);
  if (changedSinceSend && limitDetect.isAgentWorking(limitDetect.lastFrameText(text))) {
    return { ok: true, src: 'pane-working' };
  }
  if (entry && entry.engine !== 'codex' && entry.cwd && resumeTmux.isUuid(entry.sessionId)) {
    try {
      const dir = resumeTmux.claudeProjectsDir(entry.cwd, this.homedir);
      const file = path.join(dir, `${entry.sessionId}.jsonl`);
      if (fs.statSync(file).mtimeMs > sinceMs) {
        const lines = assistantLinesAfter(file, sinceMs);
        const refusal = lines.find((l) => l.kind === 'limit');
        if (refusal) return { ok: false, limitAgain: true, limitText: refusal.text, src: 'transcript-limit' };
        if (lines.length) return { ok: true, src: 'transcript' };
      }
    } catch {
      /* no transcript → no evidence */
    }
  }
  return { ok: false };
}

/**
 * ADP-428 — a verify failure re-sends with escalating waits.
 */
function _verifyRetryOrFail(entry, reason, opts = {}) {
  const attempts = (Number.isInteger(entry.attempts) ? entry.attempts : 0) + 1;
  if (attempts >= this.verifyMaxAttempts) {
    return this._fail(entry, attempts, reason);
  }
  const now = this.now();
  const buffer = Number.isFinite(this.scheduler.resetBufferMs) ? this.scheduler.resetBufferMs : 0;

  const ceiling = MAX_TOTAL_DEFER_MS;
  let resetAt = null;
  if (opts.limitText) {
    const parsed = limitDetect.extractResetWide(opts.limitText);
    if (parsed.resetClock || parsed.resetRel) {
      const r = this._resetSignal(parsed, now);
      if (Number.isFinite(r.at) && r.at > now && r.at + buffer - now <= ceiling) resetAt = r.at;
    }
  }
  const delay = resetAt
    ? Math.max(0, resetAt + buffer - now)
    : this.verifyRetryDelaysMs[Math.min(attempts - 1, this.verifyRetryDelaysMs.length - 1)];

  const patch = { status: 'scheduled', attempts, lastError: reason };
  if (resetAt) {
    patch.resetAt = resetAt;
    patch.resetSource = 'reread'; // RES-08
  }
  const updated =
    resumeQueue.updateEntry(entry.id, patch, this.homedir) || { ...entry, attempts };
  this.scheduler.scheduleAt(updated.id, delay, () => this.fire(updated));
  this._track('retry', updated, { attempt: attempts, delayMs: delay, outcome: opts.outcome || 'verify-retry' });
  this._emit('retry', updated, reason, this._statusOf(updated, now + delay));
  this._notify(
    'resume',
    updated,
    `devam doğrulanamadı (${reason}) — deneme ${attempts}/${this.verifyMaxAttempts} başarısız, ` +
      (resetAt
        ? `cevaptaki reset saatine (${formatClock(resetAt)}) yeniden zamanlandı`
        : `${Math.round(delay / 60_000)}dk sonra yeniden denenecek`) +
      ` (pane ${updated.paneRef})`,
  );
  return opts.outcome || 'verify-retry';
}

/** Terminal failure: persist + FAIL notice + onFail hook (visible alert). */
function _fail(entry, attempts, reason) {
  this._watchdog.delete(entry.id); // ADP-947
  this._probe.delete(entry.id); // RES-05
  this._track('fail', entry, { attempt: attempts, outcome: reason }); // RES-08
  resumeQueue.updateEntry(
    entry.id,
    { status: 'failed', attempts, lastError: reason },
    this.homedir,
  );
  this._notify('fail', entry, `auto-resume vazgeçti (${attempts} deneme): ${reason}`);
  if (this.onFail) {
    try {
      this.onFail(entry, `${reason} (${attempts} deneme)`);
    } catch {
      /* alert hook is best-effort */
    }
  }
  return 'failed';
}

/** Bump attempts; reschedule with exponential backoff, or FAIL after the budget. */
function _backoffOrFail(entry, reason) {
  const attempts = (Number.isInteger(entry.attempts) ? entry.attempts : 0) + 1;
  if (isExhausted(attempts)) {
    return this._fail(entry, attempts, reason);
  }
  const updated =
    resumeQueue.updateEntry(
      entry.id,
      { status: 'scheduled', attempts, lastError: reason },
      this.homedir,
    ) || { ...entry, attempts };
  this.scheduler.scheduleBackoff(updated, (e) => this.fire(e));
  return 'backoff';
}

module.exports = {
  verify,
  _activityEvidence,
  _verifyRetryOrFail,
  _fail,
  _backoffOrFail,
};
