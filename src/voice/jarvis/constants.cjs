'use strict';

const { VOICE_NAME } = require('../voiceName.cjs');

const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';
const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech';
const WHISPER_MODEL = 'whisper-1';
const SAY_VOICE = 'Yelda'; // tr_TR (ADR-009 POC: 156KB .aiff produced, PASS)
const CLAUDE_TIMEOUT_MS = 30000;

// OpenAI TTS — available voices + defaults.
const TTS_VOICES = ['alloy', 'echo', 'fable', 'nova', 'onyx', 'shimmer'];
const DEFAULT_TTS_VOICE = 'nova';
const DEFAULT_TTS_MODEL = 'gpt-4o-mini-tts';
const TTS_PREVIEW_TEXT = `Merhaba! Ben ${VOICE_NAME}. Nasıl yardımcı olabilirim?`;

const DEFAULT_SILENCE_MS = 900;
const MIN_SILENCE_MS = 300;
const MAX_SILENCE_MS = 6000;
const DEFAULT_ENDPOINT_MAX_MS = 3000;
const DEFAULT_SLEEP_AFTER_MS = 45000;
const MIN_SLEEP_AFTER_MS = 5000;
const MAX_SLEEP_AFTER_MS = 600000;

/** Ayarlardan gelen VAD penceresini güvenli aralığa sıkıştır (bozuk değer → varsayılan). */
function normalizeSilenceMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SILENCE_MS;
  if (n <= 0) return DEFAULT_SILENCE_MS;
  return Math.min(MAX_SILENCE_MS, Math.max(MIN_SILENCE_MS, Math.round(n)));
}

/**
 * ADP-854B — uyarlanabilir pencerenin TAVANI. Tabandan küçük bir tavan anlamsızdır
 * (kullanıcı iki alanı ters girebilir) → taban verilirse ona yükseltilir.
 */
function normalizeEndpointMaxMs(value, baseMs) {
  const base = normalizeSilenceMs(baseMs);
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return Math.max(base, DEFAULT_ENDPOINT_MAX_MS);
  return Math.max(base, Math.min(MAX_SILENCE_MS, Math.max(MIN_SILENCE_MS, Math.round(n))));
}

/** ADP-854B — OTURUM uyku eşiği (ms) güvenli aralığa sıkıştırılır. */
function normalizeSleepAfterMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SLEEP_AFTER_MS;
  return Math.min(MAX_SLEEP_AFTER_MS, Math.max(MIN_SLEEP_AFTER_MS, Math.round(n)));
}

const DEFAULT_NO_SPEECH_MS = 8000;
const MIN_NO_SPEECH_MS = 2000;
const MAX_NO_SPEECH_MS = 60000;

/** ADP-916 — "hiç konuşulmadı" eşiği (ms) güvenli aralığa sıkıştırılır. */
function normalizeNoSpeechMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_NO_SPEECH_MS;
  return Math.min(MAX_NO_SPEECH_MS, Math.max(MIN_NO_SPEECH_MS, Math.round(n)));
}

module.exports = {
  OPENAI_TRANSCRIBE_URL,
  OPENAI_TTS_URL,
  WHISPER_MODEL,
  SAY_VOICE,
  CLAUDE_TIMEOUT_MS,
  TTS_VOICES,
  DEFAULT_TTS_VOICE,
  DEFAULT_TTS_MODEL,
  TTS_PREVIEW_TEXT,
  DEFAULT_SILENCE_MS,
  MIN_SILENCE_MS,
  MAX_SILENCE_MS,
  DEFAULT_ENDPOINT_MAX_MS,
  DEFAULT_SLEEP_AFTER_MS,
  MIN_SLEEP_AFTER_MS,
  MAX_SLEEP_AFTER_MS,
  normalizeSilenceMs,
  normalizeEndpointMaxMs,
  normalizeSleepAfterMs,
  DEFAULT_NO_SPEECH_MS,
  MIN_NO_SPEECH_MS,
  MAX_NO_SPEECH_MS,
  normalizeNoSpeechMs,
};
