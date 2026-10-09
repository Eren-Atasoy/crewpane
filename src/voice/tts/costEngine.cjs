// CrewPane — TTS Cost Estimation, Engine Resolution, and Notice Delivery.
'use strict';

const credentialGate = require('../../security/requireCredential.cjs');
const {
  TTS_PROVIDERS,
  COST_ASSUMPTIONS,
  FREE_ENGINE,
  SHIPPED_DEFAULT_ENGINE,
} = require('./constants.cjs');

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

/**
 * Dürüst maliyet göstergesi (ADP-848 §6).
 */
function estimateCost(engineId, opts = {}) {
  const spec = TTS_PROVIDERS[engineId];
  if (!spec || !spec.cost) return null;
  const charsPerReply = num(opts.charsPerReply, COST_ASSUMPTIONS.charsPerReply);
  const repliesPerDay = num(opts.repliesPerDay, COST_ASSUMPTIONS.repliesPerDay);
  const days = num(opts.daysPerMonth, COST_ASSUMPTIONS.daysPerMonth);
  const per1k = spec.cost.usdPer1kChars;
  return {
    usdPer1kChars: per1k,
    perReplyUsd: round4((charsPerReply / 1000) * per1k),
    monthlyHeavyUsd: round2((charsPerReply * repliesPerDay * days / 1000) * per1k),
    charsPerReply,
    repliesPerDay,
    basis: spec.cost.basis,
    measuredAt: spec.cost.measuredAt,
    sourceUrl: spec.cost.sourceUrl,
    confidence: spec.cost.confidence,
    note: spec.cost.note,
  };
}

/** Motorun bu platformda kullanılabilirliği (ör. `say` yalnız macOS). */
function isSupportedOn(engineId, platform = process.platform) {
  const spec = TTS_PROVIDERS[engineId];
  if (!spec) return false;
  return !spec.platform || spec.platform === platform;
}

/**
 * ADP-874 — 🔴 ÜCRETSİZ MOTOR HER PLATFORMDA YOK.
 */
function freeEngineFor(platform = process.platform) {
  return isSupportedOn(FREE_ENGINE, platform) ? FREE_ENGINE : null;
}

/**
 * Ayarlardaki motoru çöz. Tanınmayan/bozuk değer → ÜCRETSİZ motor.
 */
function resolveTtsEngine(settings, opts = {}) {
  const j = (settings && settings.jarvis) || {};
  const raw = j.ttsEngine;
  const platform = opts.platform || process.platform;
  const fallbackId = freeEngineFor(platform) || SHIPPED_DEFAULT_ENGINE;
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) return SHIPPED_DEFAULT_ENGINE;
  if (typeof raw !== 'string') return fallbackId;
  const id = raw.trim().toLowerCase();
  return TTS_PROVIDERS[id] ? id : fallbackId;
}

/**
 * TTS-01 — bu motorun ŞU ANKİ sesi (ayarlardan). `''` = seçim YOK.
 */
function pickVoiceFromSettings(spec, jarvis = {}) {
  const raw = spec && spec.voiceSettingKey ? jarvis[spec.voiceSettingKey] : null;
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (spec && spec.dynamicVoices) return v;
  if (v && spec && spec.voices && spec.voices.includes(v)) return v;
  return (spec && spec.defaultVoice) || '';
}

/** Anahtar var mı? (sır DÖNMEZ — yalnız bayrak) Ücretsiz motorlar her zaman true. */
function hasKeyFor(engineId, ctx = {}) {
  const spec = TTS_PROVIDERS[engineId];
  if (!spec) return false;
  if (!spec.credential) return true;
  const gate = ctx.gate || credentialGate;
  return gate.hasCredential(spec.credential, ctx) === true;
}

const _noticed = new Set();

function fallbackNotice(engineId, reason, { once = true, platform = process.platform, hint = null } = {}) {
  const spec = TTS_PROVIDERS[engineId];
  const label = spec ? spec.label : engineId;
  const key = `${engineId}:${reason}`;
  if (once && _noticed.has(key)) return null;
  if (once) _noticed.add(key);

  const directive = typeof hint === 'string' && hint.trim() ? hint.trim() : null;
  if (directive) {
    const free = freeEngineFor(platform);
    return free
      ? `${directive} (Şimdilik ücretsiz yerel sese — ${TTS_PROVIDERS[free].label} — geçildi.)`
      : `${directive} (Bu platformda ücretsiz yerel ses YOK, bu yüzden ${label} düzelene kadar Agent X sessiz kalacak.)`;
  }

  const free = freeEngineFor(platform);
  const missing = reason === 'no-key'
    ? `${label} için API anahtarı yok`
    : reason === 'no-voice'
    ? `${label} anahtarın kayıtlı ama henüz bir SES seçmedin (sorun anahtarda değil)`
    : `${label} çağrısı başarısız oldu`;
  const todo = reason === 'no-voice'
    ? `Ayarlar → Ses → “${label} sesi” listesinden bir ses seç, sonra “Dinle” ile dene.`
    : reason === 'no-key'
    ? `Anahtarı Ayarlar → Ses → Erişim'den ekleyebilirsin.`
    : `Biraz sonra “Dinle” ile tekrar dene; sürerse Ayarlar → Ses → Erişim'den anahtarını kontrol et.`;

  if (!free) {
    return `${missing} — bu platformda ücretsiz yerel ses YOK, bu yüzden Agent X ` +
      `şimdilik sessiz kalacak. ${todo}`;
  }
  return `${missing} — ücretsiz yerel sese (${TTS_PROVIDERS[free].label}) geçildi. ${todo}`;
}

/** Test/oturum sıfırlama: bir sonraki arıza yeniden duyurulsun. */
function resetNotices() { _noticed.clear(); }

module.exports = {
  estimateCost,
  isSupportedOn,
  freeEngineFor,
  resolveTtsEngine,
  pickVoiceFromSettings,
  hasKeyFor,
  fallbackNotice,
  resetNotices,
};
