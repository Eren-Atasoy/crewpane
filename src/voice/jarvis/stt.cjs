'use strict';

const fs = require('node:fs');
const path = require('node:path');
const credentialGate = require('../../security/requireCredential.cjs');
const instancePaths = require('../../config/instancePaths.cjs');
const whisperLocal = require('../whisperLocal.cjs');
const engineCatalog = require('../../agents/engineCatalog.cjs');
const { OPENAI_TRANSCRIBE_URL, WHISPER_MODEL } = require('./constants.cjs');

// ADP-312 — Whisper dosya tipini DOSYA ADININ UZANTISINDAN belirler (content-type'ı
// yok sayar). Ölçüldü: aynı AAC baytları `audio.m4a` adıyla transkript oluyor,
// `audio.mp4` adıyla "Invalid file format" 400'ü alıyor — mp4 desteklenenler
// listesinde yazsa bile. Telefon (expo-audio, iOS/Android) m4a üretir → uzantı m4a olmalı.
function extForMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('webm')) return 'webm';
  if (m.includes('ogg') || m.includes('oga')) return 'ogg';
  if (m.includes('m4a') || m.includes('mp4')) return 'm4a';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('wav')) return 'wav';
  if (m.includes('flac')) return 'flac';
  return 'wav';
}

// Whisper'ın kabul ettiği uzantılar (mp4 BİLEREK yok: ses-only mp4 400 alıyor → m4a'ya çevrilir).
const STT_EXTS = new Set(['flac', 'm4a', 'mp3', 'mpeg', 'mpga', 'oga', 'ogg', 'wav', 'webm']);

/**
 * Gönderilecek dosya uzantısı. mime tanınıyorsa o belirler; tanınmıyorsa (octet-stream /
 * boş) kaydın kendi uzantısına düşülür — telefon bazen ham bayt + jenerik tip yollar.
 */
function resolveExt(mimeType, fileName) {
  const m = String(mimeType || '').toLowerCase();
  const known = /webm|ogg|oga|m4a|mp4|mpeg|mp3|wav|flac/.test(m);
  if (known) return extForMime(m);
  const fromName = (String(fileName || '').match(/\.([a-z0-9]{2,5})$/i) || [, ''])[1].toLowerCase(); // eslint-disable-line no-sparse-arrays -- intentional hole
  if (fromName === 'mp4') return 'm4a';
  return STT_EXTS.has(fromName) ? fromName : extForMime(m);
}

/** STT `reason` → patronun anlayacağı Türkçe. Ham OpenAI gövdesi kullanıcıya gitmez. */
function sttErrorMessage(reason, detail) {
  const r = String(reason || 'bilinmiyor');
  // ADP-628 §1d — anahtarsız özelliğe basınca kullanıcı NE yapacağını görsün
  // (sessiz başarısızlık yasak). Metnin tek kaynağı kapının kendisi.
  if (r === 'no-openai-key') return credentialGate.missingMessageFor('openai');
  if (r === 'no-audio' || r === 'empty-audio') return 'ses boş geldi — kayıt alınamamış.';
  if (r === 'bad-audio') return 'ses verisi bozuk (base64 çözülemedi).';
  if (r === 'empty-transcript' || r === 'no-speech') return 'ses algılanmadı — sessiz kayıt ya da çok kısa.';
  if (r === 'network') return 'OpenAI\'a ulaşılamadı (ağ).';
  // ADP-813 — yerel STT sebepleri KULLANICIYA çıkmaz (buluta düşüldüğü için görünmez);
  // yalnız her iki yol da başarısızsa görünür → o zaman da bilgilendirici olsun.
  if (r === 'local-no-model') return 'yerel ses modeli yok (scripts/fetch-whisper-model.sh) ve bulut da kullanılamadı.';
  if (r === 'local-no-binary') return 'whisper-server bulunamadı (brew install whisper-cpp) ve bulut da kullanılamadı.';
  if (r === 'local-no-ffmpeg') return 'ffmpeg bulunamadı (brew install ffmpeg) ve bulut da kullanılamadı.';
  if (r.startsWith('local-')) return `yerel ses çözümleyici çalışmadı (${r}).`;
  if (r.startsWith('http-')) {
    // Format reddi en sık hata → kullanıcıya net söyle (anahtar ASLA burada değil).
    if (/invalid file format/i.test(String(detail || ''))) return 'ses formatı desteklenmiyor.';
    return `OpenAI reddetti (${r}).`;
  }
  return `ses çözümlenemedi (${r}).`;
}

/**
 * ADP-642 — KULLANICI METNİ SONUCUN İÇİNDE GİDER.
 */
function withUserMessage(result) {
  if (!result || result.ok) return result;
  const reason = result.reason;
  const out = { ...result, message: sttErrorMessage(reason, result.detail || result.error) };
  if (reason === 'no-openai-key') {
    out.credential = 'openai';
    out.credentialTarget = credentialGate.settingsTargetFor('openai');
  }
  return out;
}

function dumpAudioForDebug(buf, name, log) {
  if (String(process.env.CREWPANE_STT_DEBUG || '') !== '1') return null;
  try {
    const dir = path.join(instancePaths.crewpaneHome(), 'stt-debug');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${name}`);
    fs.writeFileSync(file, buf);
    if (typeof log === 'function') log(`stt debug: ${buf.length}B → ${file}`);
    return file;
  } catch {
    return null; // debug best-effort; asla akışı bozmaz
  }
}

const VOCAB_PROMPT_MAX = 240;

function buildVocabPrompt(names) {
  const seen = new Set();
  const clean = [];
  for (const raw of Array.isArray(names) ? names : []) {
    const n = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
    if (!n || n.length > 32) continue;
    const key = n.toLocaleLowerCase('tr');
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(n);
  }
  if (!clean.length) return '';
  let out = `CrewPane ekibi: ${clean.join(', ')}.`;
  if (out.length > VOCAB_PROMPT_MAX) out = `${out.slice(0, VOCAB_PROMPT_MAX - 1)}…`;
  return out;
}

const NO_SPEECH_PROB = 0.5;

function isHallucinatedSilence(json) {
  const segs = json && Array.isArray(json.segments) ? json.segments : [];
  if (!segs.length) return false;
  return segs.every((s) => Number(s && s.no_speech_prob) >= NO_SPEECH_PROB);
}

/**
 * Transcribe base64 audio via Whisper → { ok, text } | { ok:false, reason }.
 */
async function transcribeWhisper({
  audioBase64,
  mimeType,
  fileName,
  apiKey,
  language = 'tr',
  prompt,
  fetchImpl = fetch,
  log,
}) {
  if (!apiKey) return { ok: false, reason: 'no-openai-key' };
  if (!audioBase64) return { ok: false, reason: 'no-audio' };
  let buf;
  try {
    buf = Buffer.from(audioBase64, 'base64');
  } catch {
    return { ok: false, reason: 'bad-audio' };
  }
  if (!buf.length) return { ok: false, reason: 'empty-audio' };

  const type = mimeType || 'audio/wav';
  const name = `audio.${resolveExt(type, fileName)}`;
  dumpAudioForDebug(buf, name, log);
  const form = new FormData();
  form.append('file', new Blob([buf], { type }), name);
  form.append('model', WHISPER_MODEL);
  if (language) form.append('language', language);
  {
    const hint = String(prompt == null ? '' : prompt).trim().slice(0, VOCAB_PROMPT_MAX);
    if (hint) form.append('prompt', hint);
  }
  form.append('response_format', 'verbose_json');

  let res;
  try {
    res = await fetchImpl(OPENAI_TRANSCRIBE_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
    });
  } catch (e) {
    return { ok: false, reason: 'network', detail: String((e && e.message) || e) };
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    return { ok: false, reason: `http-${res.status}`, detail };
  }
  let json;
  try {
    json = await res.json();
  } catch {
    return { ok: false, reason: 'bad-json' };
  }
  const text = json && typeof json.text === 'string' ? json.text.trim() : '';
  if (isHallucinatedSilence(json)) return { ok: false, reason: 'no-speech', detail: text.slice(0, 80) };
  const filtered = whisperLocal.hallucinationGuard.filterResult({ ok: true, text });
  if (!filtered.ok && typeof log === 'function') {
    log(`[stt:openai] halüsinasyon süzgeci: "${text.slice(0, 60)}" ≡ "${filtered.hallucination}" → reddedildi`);
  }
  return filtered;
}

const DEFAULT_STT_ENGINE = engineCatalog.DEFAULT_STT_ENGINE;

/** Ayarlardan STT motoru (ADP-812 kuralı: varsayılan `defaults()`te SABİTLENMEZ). */
function resolveSttEngine(settings) {
  return engineCatalog.resolveSttEngine(settings);
}

/**
 * Konuşmayı metne çevir. Yerel motor → başarısızsa bulut.
 * `no-speech` BULUTA DÜŞMEZ (kullanıcı konuşmadıysa bulut da bulamaz; para+gecikme).
 */
async function transcribeSpeech(payload = {}) {
  const settings = payload.settings || null;
  const engine = payload.engine || resolveSttEngine(settings);
  const deps = { settings, log: payload.log };
  if (engine === 'local') {
    const local = await whisperLocal.transcribeLocal(payload, deps);
    if (local.ok) return local;
    if (!whisperLocal.shouldFallbackToCloud(local.reason)) return local;
    if (typeof payload.log === 'function') {
      payload.log(`[stt] yerel başarısız (${local.reason}) → bulut fallback`);
    }
    const cloud = await transcribeWhisper(payload);
    return { ...cloud, engine: 'openai', localReason: local.reason };
  }
  const cloud = await transcribeWhisper(payload);
  return { ...cloud, engine: 'openai' };
}

module.exports = {
  extForMime,
  resolveExt,
  sttErrorMessage,
  withUserMessage,
  dumpAudioForDebug,
  buildVocabPrompt,
  isHallucinatedSilence,
  transcribeWhisper,
  resolveSttEngine,
  DEFAULT_STT_ENGINE,
  transcribeSpeech,
  whisperLocal,
};
