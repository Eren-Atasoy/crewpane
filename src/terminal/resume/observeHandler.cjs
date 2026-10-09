// CrewPane — Resume observation, prompt handling, and sentinel logic.
'use strict';

const path = require('node:path');
const limitDetect = require('../limitDetect.cjs');
const resumeQueue = require('../resumeQueue.cjs');
const resumeTmux = require('../resumeTmux.cjs');
const {
  STALE_CLOCK_GRACE_MS,
  WATCHDOG_MIN_GAP_MS,
  EXTERNAL_CHECK_MIN_GAP_MS,
  SENTINEL_MAX_NUDGES,
} = require('./constants.cjs');
const {
  formatClock,
  formatWhen,
  paneSignature,
  transcriptInterruptedAfter,
} = require('./transcriptVerify.cjs');

/**
 * ADP-947 — the reset instant to ARM, with the roll-forward trap closed.
 * @returns {{at:number|null, passed:boolean, source:string}}
 */
function _resetSignal(signal, now) {
  const r = limitDetect.resolveResetAt(signal, now);
  const passed =
    !!r.rolledOver && Number.isFinite(r.clockAt) && now - r.clockAt <= STALE_CLOCK_GRACE_MS;
  const at = passed ? null : r.at;
  let source = 'unknown';
  if (Number.isFinite(at)) {
    if (r.source === 'rel') source = 'rel';
    else if (r.source === 'abs') source = 'abs';
    else if (r.source === 'date') source = 'date';
    else if (r.source === 'clock-local-fallback') source = 'clock-local';
    else if (r.source === 'clock') source = 'clock';
    if (r.via === 'cli-band') source = 'cli-band';
  }
  return { at, passed, source };
}

/**
 * ADP-947 — never let a NOISIER later read ERASE a reset instant already resolved.
 */
function _carryResetAt(id, resetAt) {
  if (Number.isFinite(resetAt)) return resetAt;
  if (!id || !id.agentId) return resetAt;
  const now = this.now();
  const prev = resumeQueue
    .activeEntries(this.homedir)
    .find((e) => e.agentId === id.agentId && Number.isFinite(e.resetAt));
  return prev && prev.resetAt > now ? prev.resetAt : resetAt;
}

/**
 * ADP-947 — WATCHDOG: the 5-second poll is the SECOND trigger.
 */
function _watchdogDue(entry, now) {
  if (!entry || entry.status !== 'scheduled') return false;
  if (!Number.isFinite(entry.resetAt)) return false;
  const buffer = Number.isFinite(this.scheduler.resetBufferMs) ? this.scheduler.resetBufferMs : 0;
  if (now < entry.resetAt + buffer) return false;
  const last = this._watchdog.get(entry.id);
  if (Number.isFinite(last) && now - last < WATCHDOG_MIN_GAP_MS) return false;
  this._watchdog.set(entry.id, now);
  return true;
}

/**
 * ADP-947 — fire this agent's captured limit FROM THE POLL when its reset instant
 * is already past.
 */
function _watchdogFire(id) {
  if (!id || !id.agentId) return false;
  const now = this.now();
  const entry = resumeQueue.activeEntries(this.homedir).find((e) => e.agentId === id.agentId);
  if (!entry || !this._watchdogDue(entry, now)) return false;
  this.scheduler.scheduleAt(entry.id, 0, () => this.fire(entry));
  this._notify(
    'resume',
    entry,
    `reset saati (${formatClock(entry.resetAt)}) geçmiş ama tetik gelmemiş ` +
      `(pane ${entry.paneRef}) — devam yoklamadan tetiklendi`,
  );
  return true;
}

/** Pane sessizlik ölçümü: imza değiştiyse `changedAt = now`. → {quietMs, changed} */
function _notePane(paneRef, text, now) {
  if (!paneRef) return { quietMs: 0, changed: true };
  const sig = paneSignature(text);
  const prev = this._pane.get(paneRef);
  if (!prev || prev.sig !== sig) {
    this._pane.set(paneRef, { sig, changedAt: now });
    return { quietMs: 0, changed: true, sig };
  }
  return { quietMs: now - prev.changedAt, changed: false, sig };
}

/** Bu pane'in motoru limitte kendi devam eder mi. */
function _isNative(id) {
  if (!this.nativeContinue) return false;
  try {
    return this.nativeContinue(id) === true;
  } catch {
    return false;
  }
}

/** Bu ajanın aktif kaydı (native ya da değil). */
function _activeEntryOf(id) {
  if (!id || !id.agentId) return null;
  return resumeQueue.activeEntries(this.homedir).find((e) => e.agentId === id.agentId) || null;
}

/** observe() dönüşü (heartbeat/rozet için): kind 'native' + eylem + saat. */
function _nativeStatus(entry, action, now, extra = {}) {
  return {
    kind: 'native',
    paneRef: entry.paneRef,
    agentId: entry.agentId,
    engine: entry.engine,
    action,
    entryId: entry.id,
    resetAt: Number.isFinite(entry.resetAt) ? entry.resetAt : null,
    status: entry.status,
    ...extra,
  };
}

/** Dürüst durum satırı — aynı durum için bir kez (her 5 sn'de bir değil). */
function _sayNative(entry, band, now) {
  const known = Number.isFinite(entry.resetAt);
  const key = `${entry.id}|${known ? entry.resetAt : 'unknown'}|${band ? band.phase : '-'}`;
  if (this._nativeSaid.get(entry.paneRef) === key) return;
  this._nativeSaid.set(entry.paneRef, key);
  let line;
  if (band && band.phase === 'stale') {
    line = `motor "limit yenilendi, Enter bekliyorum" diyor (pane ${entry.paneRef}) — nöbetçi sessizlik + ${Math.round(this.sentinelGraceMs / 60_000)}dk sonra tek Enter gönderecek`;
  } else if (band && band.phase === 'cancelled') {
    line = `motorun otomatik devamı İPTAL olmuş (pane ${entry.paneRef}) — ${known ? `reset ${formatClock(entry.resetAt)} + ${Math.round(this.sentinelGraceMs / 60_000)}dk sonra tek "devam et"` : 'saat okunamadı → bekliyor, gönderim yok'}`;
  } else if (known) {
    line = `limit (pane ${entry.paneRef}) — motor ${formatWhen(entry.resetAt, now)}'de KENDİ devam edecek; daemon tuşa basmıyor, ESC yazmıyor (kaynak: ${entry.resetSource})`;
  } else {
    line = `limit (pane ${entry.paneRef}) — bekliyor — saat okunamadı; motor kendi devam ederse sürer, etmezse ekrandaki "press enter" bandı görülünce tek Enter gönderilir (gönderim 0, FAIL yok)`;
  }
  this._notify('resume', entry, line);
  this._track('native', entry, { outcome: band ? band.phase : known ? 'armed-clock' : 'waiting-no-clock' });
}

/**
 * §6.3/3-4 — motor (ya da kullanıcı) KENDİ devam etti mi?
 */
function _externalResume(entry, text, now) {
  const since = Number.isFinite(entry.sentinelAt) ? entry.sentinelAt : entry.detectedAt || 0;
  let src = null;
  const frame = limitDetect.lastFrameText(text);
  if (limitDetect.isAgentWorking(frame) && !limitDetect.detectLimitState(text)) {
    src = 'pane-working';
  } else {
    const last = this._external.get(entry.id) || 0;
    if (now - last >= EXTERNAL_CHECK_MIN_GAP_MS) {
      this._external.set(entry.id, now);
      const ev = this.activityEvidence(entry, since, text) || { ok: false };
      if (ev.ok) src = ev.src || 'transcript';
    }
  }
  if (!src) return null;
  if (this._interruptedSince(entry, since)) {
    const key = `${entry.id}|interrupted`;
    if (this._nativeSaid.get(entry.paneRef) !== key) {
      this._nativeSaid.set(entry.paneRef, key);
      this._notify('resume', entry, `pane ${entry.paneRef} hareketlendi ama transcript'te kullanıcı KESMESİ var — "devam etti" sayılmadı, kayıt açık`);
      this._track('external', entry, { outcome: 'interrupted', evidenceSrc: src });
    }
    return null;
  }
  const via = Number.isFinite(entry.sentinelAt) ? `nöbetçi ${entry.sentinelPhase}` : 'dış/native';
  this._notify('resume', entry, `kaldığı yerden devam ediyor ✓ (pane ${entry.paneRef}, ${via}, kanıt: ${src}) — daemon hiçbir tuş yazmadı${Number.isFinite(entry.sentinelAt) ? ' (tek nöbetçi dokunuşu hariç)' : ''}`);
  this._track('external', entry, { outcome: Number.isFinite(entry.sentinelAt) ? 'resumed-after-sentinel' : 'resumed-externally', evidenceSrc: src });
  this._emit('resumed', entry, src, { nextAttemptAt: null, resetAt: null, resetKnown: false, verdict: null });
  resumeQueue.updateEntry(entry.id, { status: 'resumed', lastError: null }, this.homedir);
  resumeQueue.removeEntry(entry.id, this.homedir);
  this._external.delete(entry.id);
  this._nativeSaid.delete(entry.paneRef);
  if (entry.agentId) this._nativeWatch.delete(entry.agentId);
  if (this.autoSwitch) {
    try {
      this.autoSwitch.noteClear(entry, now);
    } catch { /* poll'u kesmez */ }
  }
  return this._nativeStatus(entry, Number.isFinite(entry.sentinelAt) ? 'resumed-after-sentinel' : 'resumed-externally', now, { evidenceSrc: src });
}

/** Transcript'te `since` sonrası kullanıcı kesmesi var mı. */
function _interruptedSince(entry, since) {
  if (!entry || entry.engine === 'codex' || !entry.cwd || !resumeTmux.isUuid(entry.sessionId)) return false;
  try {
    const file = path.join(resumeTmux.claudeProjectsDir(entry.cwd, this.homedir), `${entry.sessionId}.jsonl`);
    return transcriptInterruptedAfter(file, since);
  } catch {
    return false;
  }
}

/**
 * §6.3/2 — NÖBETÇİ.
 */
function _sentinel(entry, signal, band, text, now, paneState) {
  if (this.dryRun) return null;
  if (!paneState || paneState.quietMs < this.sentinelQuietMs) return null;
  if (limitDetect.isAgentWorking(limitDetect.lastFrameText(text))) return null;
  if ((entry.sentinelCount || 0) >= SENTINEL_MAX_NUDGES) return null;
  const phase = band ? band.phase : signal ? (signal.kind === 'prompt' ? 'menu' : 'plain') : null;
  if (!phase || phase === 'armed' || phase === 'again') return null;
  if (entry.sentinelPhase === phase) return null;
  if (Number.isFinite(entry.sentinelAt) && now - entry.sentinelAt < this.sentinelGraceMs) return null;

  const known = Number.isFinite(entry.resetAt);
  let action = null;
  if (phase === 'stale') {
    action = 'enter';
  } else if (known && now >= entry.resetAt + this.sentinelGraceMs) {
    action = phase === 'menu' ? 'menu-select' : 'continue';
  }
  if (!action) return null;

  let ok = false;
  let detail = '';
  if (action === 'enter') {
    ok = this.pressEnter ? this.pressEnter(entry.paneRef) === true : false;
    detail = 'tek Enter (motor "press enter to continue" diyordu)';
    if (!this.pressEnter) detail = 'Enter yolu enjekte edilmemiş → gönderim yok';
  } else if (action === 'menu-select') {
    ok = Number.isInteger(signal && signal.stopOption) ? this.selectOption(entry.paneRef, signal.stopOption) !== false : false;
    detail = `menü hâlâ ekranda, reset ${formatClock(entry.resetAt)} geçti → zarif seçenek ${signal && signal.stopOption} bir kez`;
  } else {
    const r = this.sendResume({ ...entry }, { liveness: 'live' });
    ok = !!(r && r.ok);
    detail = `tek "devam et" (reset ${formatClock(entry.resetAt)} + ${Math.round(this.sentinelGraceMs / 60_000)}dk geçti, pane ${Math.round(paneState.quietMs / 60_000)}dk sessiz, band: ${phase})`;
  }
  const count = (entry.sentinelCount || 0) + 1;
  const live =
    resumeQueue.updateEntry(
      entry.id,
      { sentinelAt: now, sentinelPhase: phase, sentinelCount: count, firedAt: now, firedSig: paneSignature(text) },
      this.homedir,
    ) || entry;
  this._track('sentinel', live, { outcome: ok ? action : `${action}-failed`, attempt: count });
  this._notify('resume', live, `nöbetçi: ${detail} (pane ${live.paneRef}, dokunuş ${count}/${SENTINEL_MAX_NUDGES})${ok ? '' : ' — YAZILAMADI'}`);
  this._emit('sentinel', live, action, this._statusOf(live, null));
  this._pane.set(live.paneRef, { sig: paneSignature(text), changedAt: now });
  return this._nativeStatus(live, `sentinel-${action}`, now, { ok });
}

/**
 * Native pane'in poll yolu.
 */
function _observeNative(signal, id, text, now, paneState) {
  const band = limitDetect.detectNativeContinueState(text);
  if (!signal && !band && !(id.agentId && this._nativeWatch.has(id.agentId))) {
    if (this.autoSwitch) {
      try {
        this.autoSwitch.noteClear(id, now);
      } catch { /* poll'u kesmez */ }
    }
    return null;
  }
  let entry = this._activeEntryOf(id);
  if (!entry && id.agentId) this._nativeWatch.delete(id.agentId);

  if (entry && entry.mode === 'native') {
    const ext = this._externalResume(entry, text, now);
    if (ext) return ext;
  }

  if (!signal && !band) {
    if (this.autoSwitch) {
      try {
        this.autoSwitch.noteClear(id, now);
      } catch { /* poll'u kesmez */ }
    }
    return entry && entry.mode === 'native' ? this._nativeStatus(entry, 'watching', now) : null;
  }

  const src = signal || band;
  const reset = this._resetSignal(src, now);
  let resetAt = reset.at;
  if (!Number.isFinite(resetAt) && entry && Number.isFinite(entry.resetAt)) resetAt = entry.resetAt;
  const { entry: rec, changed } = resumeQueue.captureLimit(
    {
      ...id,
      detectedAt: now,
      resetAt,
      resetSource: reset.source,
      resetPassedAt: reset.passed ? now : null,
      resetRaw: (signal && signal.raw) || (band && band.raw) || null,
      status: 'scheduled',
      mode: 'native',
    },
    this.homedir,
  );
  if (rec.mode !== 'native') {
    this.scheduler.cancel(rec.id);
    this.scheduler.cancel(rec.id + this._verifySuffix);
    resumeQueue.updateEntry(rec.id, { mode: 'native' }, this.homedir);
    rec.mode = 'native';
  }
  entry = rec;
  if (entry.agentId) this._nativeWatch.add(entry.agentId);
  if (changed) {
    this._track('detect', entry, { outcome: signal ? `${signal.kind}-native` : `band-${band.phase}` });
    this._emit('schedule', entry, 'native', this._statusOf(entry, Number.isFinite(entry.resetAt) ? entry.resetAt : null));
  }
  this._sayNative(entry, band, now);

  const nudged = this._sentinel(entry, signal, band, text, now, paneState);
  if (nudged) return nudged;
  return this._nativeStatus(entry, band ? `band-${band.phase}` : 'limited', now, { changed });
}

/**
 * ADP-938 — limit görüldü: müsait BAŞKA hesap varsa oraya geç.
 */
function _tryAutoSwitch(signal, meta) {
  if (!this.autoSwitch) return null;
  const id = this._identity({ ...(meta || {}), engine: (meta && meta.engine) || signal.engine });
  const now = this.now();
  let res = null;
  try {
    const resetAt = this._resetSignal(signal, now).at;
    if (this.dryRun) {
      res = this.autoSwitch.previewSwitch
        ? this.autoSwitch.previewSwitch({ ...id, resetAt }, now)
        : { switched: false, reason: 'dryrun', message: null };
      if (res && res.message) this._notify('dryrun', id, `hesap geçişi: ${res.message}`);
      return null;
    }
    res = this.autoSwitch.trySwitch({ ...id, resetAt, raw: signal.raw }, now);
  } catch (err) {
    this._notify('resume', id, `otomatik hesap geçişi denenemedi: ${(err && err.message) || err}`);
    return null;
  }
  if (!res) return null;
  if (res.message) this._notify('resume', id, `${res.message} (pane ${id.paneRef})`);
  if (!res.switched) return null;
  if (id.paneRef) this._promptSelected.delete(id.paneRef);
  return {
    kind: 'switch',
    paneRef: id.paneRef,
    agentId: id.agentId,
    engine: id.engine,
    from: res.from,
    to: res.to,
    newPaneId: res.paneId || null,
  };
}

/**
 * Format A — interactive rate-limit prompt.
 */
function _handlePrompt(signal, meta) {
  const id = this._identity({ ...meta, engine: meta.engine || signal.engine });
  const paneRef = id.paneRef;
  const sig = `${signal.stopOption}|${signal.raw}`;
  const result = {
    kind: 'prompt',
    paneRef,
    agentId: id.agentId,
    engine: id.engine,
    stopOption: signal.stopOption,
    raw: signal.raw,
  };
  if (paneRef && this._promptSelected.get(paneRef) === sig) {
    const armed = this._watchdogFire(id) || this._ensureArmed(id);
    const rec = id.agentId
      ? resumeQueue.activeEntries(this.homedir).find((e) => e.agentId === id.agentId)
      : null;
    return {
      ...result,
      action: armed ? 'watchdog-fire' : 'already-selected',
      resetAt: rec && Number.isFinite(rec.resetAt) ? rec.resetAt : null,
    };
  }
  if (paneRef) this._promptSelected.set(paneRef, sig);

  if (!Number.isInteger(signal.stopOption)) {
    this._notify('resume', { ...id }, `limit prompt'u algılandı ama 'wait' seçeneği bulunamadı (pane ${paneRef}) — native auto-resume'e bırakıldı`);
    return { ...result, action: 'no-stop-option' };
  }
  if (this.dryRun) {
    this._notify(
      'dryrun',
      { ...id },
      `2-seçenekli limit prompt'u: seçenek ${signal.stopOption} (graceful stop) seçilecekti (pane ${paneRef}) → Claude native auto-resume devralır`,
    );
    return { ...result, action: 'dryrun-select' };
  }
  this.selectOption(paneRef, signal.stopOption);
  const now = this.now();
  const reset = this._resetSignal(signal, now);
  const resetAt = this._carryResetAt(id, reset.at);
  const { entry, changed } = resumeQueue.captureLimit(
    {
      ...id,
      detectedAt: now,
      resetAt,
      resetSource: reset.source,
      resetPassedAt: reset.passed ? now : null,
      resetRaw: signal.raw,
      status: 'scheduled',
    },
    this.homedir,
  );
  if (changed) this._track('detect', entry, { outcome: 'prompt' });
  this._armIfNeeded(entry, changed, now);
  this._notify(
    'resume',
    { ...id },
    `limit prompt'u: graceful stop seçildi (seçenek ${signal.stopOption}, pane ${paneRef}) → reset'te "devam et" gönderilecek (${resetAt ? formatClock(resetAt) : '~5dk fallback'})`,
  );
  return {
    ...result,
    action: 'select-and-schedule',
    entryId: entry.id,
    resetAt: entry.resetAt,
  };
}

/**
 * Format B / plain — capture the limit and arm the scheduled `claude --resume`.
 */
function _handlePlain(signal, meta) {
  const id = this._identity({ ...meta, engine: meta.engine || signal.engine });
  const now = this.now();
  const reset = this._resetSignal(signal, now);
  const resetAt = this._carryResetAt(id, reset.at);

  const { entry, changed } = resumeQueue.captureLimit(
    {
      ...id,
      detectedAt: now,
      resetAt,
      resetSource: reset.source,
      resetPassedAt: reset.passed ? now : null,
      resetRaw: signal.raw,
      status: 'scheduled',
    },
    this.homedir,
  );

  if (changed) this._track('detect', entry, { outcome: 'plain' });
  this._armIfNeeded(entry, changed, now);
  return entry;
}

/**
 * RES-02 §5 / RES-04 — the ONE place a poll may arm a trigger.
 */
function _armIfNeeded(entry, changed, now) {
  if (this.scheduler.has(entry.id + this._verifySuffix)) return;
  const armed = this.scheduler.has(entry.id);
  if (!changed && !armed) {
    this._notify(
      'resume',
      entry,
      `INVARIANT: aktif kayıt (${entry.status}) için armlanmış tetik yoktu — ` +
        `yeniden kuruldu (pane ${entry.paneRef})`,
    );
  }
  if (changed || !armed) {
    let delay;
    if (!Number.isFinite(entry.resetAt) && Number.isFinite(entry.resetPassedAt)) {
      delay = this.scheduler.scheduleAt(entry.id, 0, () => this.fire(entry));
    } else {
      delay = this.scheduler.schedule(entry, (e) => this.fire(e), now);
    }
    this._announceSchedule(entry, delay, now);
    return;
  }
  if (this._watchdogDue(entry, now)) {
    this.scheduler.scheduleAt(entry.id, 0, () => this.fire(entry));
    this._announceSchedule(entry, 0, now, 'watchdog');
  }
}

/**
 * RES-07 §2 + RES-08 — "sıradaki deneme ŞU AN" bilgisini TEK yerden yay.
 */
function _announceSchedule(entry, delayMs, now, reason) {
  const at = Number.isFinite(delayMs) ? now + delayMs : null;
  const st = this._statusOf(entry, at);
  this._track('schedule', entry, { delayMs: Number.isFinite(delayMs) ? delayMs : null, outcome: reason || 'armed' });
  this._emit('schedule', entry, reason || null, st);
}

/**
 * RES-02 §5 — invariant sweep for a poll path that does NOT go through captureLimit.
 */
function _ensureArmed(id) {
  if (!id || !id.agentId) return false;
  const entry = resumeQueue.activeEntries(this.homedir).find((e) => e.agentId === id.agentId);
  if (!entry) return false;
  if (this.scheduler.has(entry.id) || this.scheduler.has(entry.id + this._verifySuffix)) {
    return false;
  }
  this._armIfNeeded(entry, false, this.now());
  return true;
}

/**
 * Feed one pane's captured output through ROBUST detection.
 */
function observe(text, meta) {
  const paneRef = meta && meta.paneRef;
  const now = this.now();
  const paneState = this._notePane(paneRef, text, now);
  const signal = limitDetect.detectLimitState(text);
  const nativeId = this.nativeContinue ? this._identity(meta || {}) : null;
  if (nativeId && this._isNative(nativeId)) {
    if (paneRef) this._promptSelected.delete(paneRef);
    return this._observeNative(signal, nativeId, text, now, paneState);
  }
  if (!signal) {
    if (paneRef) this._promptSelected.delete(paneRef);
    if (this.autoSwitch) {
      try {
        this.autoSwitch.noteClear(this._identity(meta || {}), this.now());
      } catch { /* defter/karar hatası poll'u ASLA kesmez */ }
    }
    return null;
  }
  const switched = this._tryAutoSwitch(signal, meta);
  if (switched) return switched;
  if (signal.kind === 'prompt') {
    return this._handlePrompt(signal, meta);
  }
  if (paneRef) this._promptSelected.delete(paneRef);
  return this._handlePlain(signal, meta);
}

module.exports = {
  _resetSignal,
  _carryResetAt,
  _watchdogDue,
  _watchdogFire,
  _notePane,
  _isNative,
  _activeEntryOf,
  _nativeStatus,
  _sayNative,
  _externalResume,
  _interruptedSince,
  _sentinel,
  _observeNative,
  _tryAutoSwitch,
  _handlePrompt,
  _handlePlain,
  _armIfNeeded,
  _announceSchedule,
  _ensureArmed,
  observe,
};
