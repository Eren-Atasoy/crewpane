// CrewPane — Resume firing, deferral guards, and pre-send zero-token probing.
'use strict';

const limitDetect = require('../limitDetect.cjs');
const resumeQueue = require('../resumeQueue.cjs');
const resumeTmux = require('../resumeTmux.cjs');
const {
  DEFER_PROBE_MS,
  UNKNOWN_MAX_DEFER_MS,
  MAX_TOTAL_DEFER_MS,
} = require('./constants.cjs');
const {
  formatClock,
  paneSignature,
} = require('./transcriptVerify.cjs');

/**
 * Resolve the session id to resume with, honoring cross-pane isolation:
 *   • a registry/minted uuid is trusted as-is (and any non-empty codex id)
 *   • claude with no id → jsonl YEDEK, but resolveSessionId returns null when
 *     the cwd has 2+ recently-active sessions (ambiguous → refuse to guess)
 * Returns { id, src }.
 */
function _resolveSession(entry, now) {
  if (resumeTmux.isUuid(entry.sessionId)) return { id: entry.sessionId, src: 'registry/minted' };
  if (entry.engine === 'codex') {
    return entry.sessionId
      ? { id: entry.sessionId, src: 'registry' }
      : { id: null, src: 'codex resume --last' };
  }
  const id = this.resolveSessionId(entry, now);
  return { id, src: id ? 'jsonl' : 'unresolved (ambiguous/missing — cross-pane korumalı)' };
}

/**
 * Scheduled callback: continue/resume the session in its pane.
 */
function fire(entrySnapshot) {
  const entry = this._reload(entrySnapshot);
  if (!resumeQueue.isActiveStatus(entry.status)) return; // already terminal
  if (entry.mode === 'native') return 'native';
  const now = this.now();

  const liveText = this.capturePane(entry.paneRef);

  if (!this.dryRun) {
    const held = this._deferWhileLimited(entry, liveText, now);
    if (held) return held;
  }

  const liveness = this.liveness(entry, liveText);

  if (!this.dryRun && liveness === 'live') {
    const probed = this._probeBeforeSend(entry, liveText, now);
    if (probed) return probed;
  }

  let sessionId = entry.sessionId;
  let src = 'live continue (session gerekmez)';
  if (liveness !== 'live') {
    const resolved = this._resolveSession(entry, now);
    sessionId = resolved.id;
    src = resolved.src;
    if (entry.engine !== 'codex' && !resumeTmux.isUuid(sessionId)) {
      return this._backoffOrFail(entry, `session-id güvenli çözülemedi (${src})`);
    }
  }

  if (this.dryRun) {
    const planned = liveness === 'live' ? null : resumeTmux.buildResumeCommand({ ...entry, sessionId });
    this._notify(
      'dryrun',
      entry,
      `limit sonrası devam ettirilecekti — engine=${entry.engine}, liveness=${liveness}, session=${src}` +
        ` (${sessionId || 'yok'}), pane ${entry.paneRef}` +
        (planned ? ` → \`${planned}\`` : ' → live: "devam et" continue keystroke'),
    );
    resumeQueue.removeEntry(entry.id, this.homedir);
    return 'dryrun';
  }

  const attemptNo = (Number.isInteger(entry.attempts) ? entry.attempts : 0) + 1;
  const live =
    resumeQueue.updateEntry(
      entry.id,
      {
        status: 'resuming',
        sessionId: sessionId || entry.sessionId,
        firedAt: now,
        firedSig: paneSignature(liveText),
      },
      this.homedir,
    ) || entry;

  const { ok, command, mode, engineSwitched, paneRef } = this.sendResume({ ...live, sessionId }, { liveness });
  this._track('send', live, {
    attempt: attemptNo,
    outcome: ok ? mode || 'sent' : 'failed',
  });
  if (!ok) {
    this._backoffOrFail(live, 'resume gönderilemedi (session-id yok / send başarısız)');
    return;
  }
  this._probe.delete(live.id);
  const after = {
    ...live,
    ...(paneRef ? { paneRef } : null),
    ...(engineSwitched ? { engine: engineSwitched.to, sessionId: null } : null),
  };
  this._notify(
    'resume',
    after,
    `limit sonrası devam tetiklendi — ${
      mode === 'continue'
        ? 'continue keystroke'
        : engineSwitched
          ? `motor değişti (${engineSwitched.from}→${engineSwitched.to}), TEMİZ yeniden açıldı`
          : '--resume'
    } ` +
      `(engine=${after.engine}, pane ${after.paneRef}, deneme ${attemptNo}/${this.verifyMaxAttempts}, ` +
      `doğrulama ${Math.round(this.verifyWindowMs / 1000)}s sonra)`,
  );
  this.scheduler.scheduleAt(after.id + this._verifySuffix, this.verifyWindowMs, () =>
    this.verify(after),
  );
  return command;
}

/**
 * ADP-938/947 — hold a resume back until the pane's reset instant has arrived.
 */
function _deferWhileLimited(entry, text, now) {
  const buffer = Number.isFinite(this.scheduler.resetBufferMs) ? this.scheduler.resetBufferMs : 0;
  const since = Number.isFinite(entry.detectedAt) ? entry.detectedAt : now;
  const ceiling = since + MAX_TOTAL_DEFER_MS - now;
  const defer = (delay, why) => {
    this.scheduler.scheduleAt(entry.id, delay, () => this.fire(entry));
    this._notify(
      'resume',
      entry,
      `erken devam ENGELLENDİ — pane ${entry.paneRef} hâlâ limitli, ${why} → ` +
        `${Math.max(1, Math.round(delay / 60_000))}dk sonra denenecek`,
    );
    const live = this._reload(entry);
    this._track('schedule', live, { delayMs: delay, outcome: 'deferred' });
    this._emit('schedule', live, 'deferred', this._statusOf(live, now + delay));
    return 'deferred';
  };

  if (Number.isFinite(entry.resetAt)) {
    const delay = entry.resetAt + buffer - now;
    if (delay <= 0) return null;
    if (ceiling <= 0) return null;
    return defer(Math.min(delay, ceiling), `reset ${formatClock(entry.resetAt)}`);
  }

  const state = limitDetect.detectLimitState(text);
  if (!state) return null;
  if (ceiling <= 0) return null;

  const fresh = limitDetect.resolveResetAt(state, now);
  const reset = this._resetSignal(state, now);
  if (Number.isFinite(reset.at) && reset.at > now) {
    resumeQueue.updateEntry(entry.id, { resetAt: reset.at, resetSource: 'reread' }, this.homedir);
    const delay = Math.min(Math.max(0, reset.at + buffer - now), ceiling);
    return defer(
      delay,
      `reset ${formatClock(reset.at)} (ekrandan yeniden okundu` +
        `${fresh.source === 'clock-local-fallback' ? ', zaman dilimi tanınmadı → yerel saat' : ''})`,
    );
  }
  if (reset.passed) {
    if (!Number.isFinite(entry.resetPassedAt)) {
      resumeQueue.updateEntry(entry.id, { resetPassedAt: now }, this.homedir);
    }
    return null;
  }
  if (now - since >= UNKNOWN_MAX_DEFER_MS) return null;
  return defer(Math.min(DEFER_PROBE_MS, ceiling), 'reset saati okunamadı');
}

/**
 * RES-05 (D8) — GÖNDERİMDEN ÖNCE SIFIR-TOKEN YOKLAMA.
 */
function _probeBeforeSend(entry, text, now) {
  if (!this.probePane) return null;
  const since = Number.isFinite(entry.detectedAt) ? entry.detectedAt : now;
  const ceilingLeft = since + MAX_TOTAL_DEFER_MS - now;
  const prev = this._probe.get(entry.id) || null;

  const fresh = prev && prev.pending && now - prev.at <= Math.max(this.probeRetryMs, this.probeSettleMs * 4);
  if (fresh) {
    const verdict = this._probeVerdict(text, prev.sig);
    if (verdict === 'clear') {
      this._probe.delete(entry.id);
      this._track('probe', entry, { outcome: 'clear' });
      return null;
    }
    if (verdict === 'limited') {
      this._probe.set(entry.id, { ...prev, pending: false, unknowns: 0 });
      return this._probeBlocked(entry, text, now, ceilingLeft);
    }
    const unknowns = prev.unknowns + 1;
    this._probe.set(entry.id, { ...prev, pending: false, unknowns });
    if (unknowns >= this.probeMaxUnknown || ceilingLeft <= 0) {
      this._probe.delete(entry.id);
      this._track('probe', entry, { outcome: 'unknown', attempt: unknowns });
      this._notify(
        'resume',
        entry,
        `ön-yoklama ${unknowns} kez sonuçsuz kaldı (TUI yanıt vermedi) — ` +
          `kör gönderime geçiliyor, hükmü doğrulama verecek (pane ${entry.paneRef})`,
      );
      return null;
    }
    const delay = Math.min(this.probeRetryMs, Math.max(0, ceilingLeft));
    this.scheduler.scheduleAt(entry.id, delay, () => this.fire(entry));
    this._track('probe', entry, { outcome: 'unknown', delayMs: delay, attempt: unknowns });
    this._emit('probe', entry, 'unknown', this._statusOf(entry, now + delay));
    this._notify(
      'resume',
      entry,
      `ön-yoklama sonuçsuz (ekran tazelenmedi) — gönderim YOK, ` +
        `${Math.max(1, Math.round(delay / 60_000))}dk sonra yeniden yoklanacak (pane ${entry.paneRef})`,
    );
    return 'probe-unknown';
  }

  if (ceilingLeft <= 0) {
    this._probe.delete(entry.id);
    return null;
  }
  let wrote = false;
  try {
    wrote = this.probePane(entry.paneRef) === true;
  } catch {
    wrote = false;
  }
  if (!wrote) {
    this._probe.delete(entry.id);
    return null;
  }
  this._probe.set(entry.id, {
    at: now,
    sig: paneSignature(text),
    pending: true,
    unknowns: prev ? prev.unknowns : 0,
  });
  this.scheduler.scheduleAt(entry.id, this.probeSettleMs, () => this.fire(entry));
  this._track('probe', entry, { outcome: 'sent', delayMs: this.probeSettleMs });
  return 'probing';
}

/**
 * RES-05 §2 — yoklama "hâlâ limitli" dedi.
 */
function _probeBlocked(entry, text, now, ceilingLeft) {
  const buffer = Number.isFinite(this.scheduler.resetBufferMs) ? this.scheduler.resetBufferMs : 0;
  const state = limitDetect.detectLimitState(text);
  const reset = state ? this._resetSignal(state, now) : { at: null, passed: false, source: 'unknown' };
  let delay = Math.min(DEFER_PROBE_MS, Math.max(0, ceilingLeft));
  let why = 'reset saati okunamadı';
  let live = entry;
  if (Number.isFinite(reset.at) && reset.at > now) {
    delay = Math.min(Math.max(0, reset.at + buffer - now), Math.max(0, ceilingLeft));
    why = `reset ${formatClock(reset.at)} (yoklamada okundu)`;
    live =
      resumeQueue.updateEntry(entry.id, { resetAt: reset.at, resetSource: 'reread' }, this.homedir) || entry;
  }
  this.scheduler.scheduleAt(entry.id, delay, () => this.fire(entry));
  this._notify(
    'resume',
    live,
    `erken devam ENGELLENDİ — ön-yoklama pane ${live.paneRef} hâlâ limitli diyor, ${why} → ` +
      `${Math.max(1, Math.round(delay / 60_000))}dk sonra denenecek (gönderim YOK, deneme sayılmadı)`,
  );
  this._track('probe', live, { outcome: 'limited', delayMs: delay });
  this._emit('probe', live, 'limited', this._statusOf(live, now + delay));
  return 'probe-blocked';
}

/**
 * RES-05 §3 — yoklamanın ÜÇ DURUMLU hükmü.
 */
function _probeVerdict(text, priorSig) {
  if (!text) return 'unknown';
  if (limitDetect.detectLimitState(text)) return 'limited';
  if (limitDetect.isAgentWorking(limitDetect.lastFrameText(text))) return 'clear';
  return paneSignature(text) !== priorSig ? 'clear' : 'unknown';
}

module.exports = {
  _resolveSession,
  fire,
  _deferWhileLimited,
  _probeBeforeSend,
  _probeBlocked,
  _probeVerdict,
};
