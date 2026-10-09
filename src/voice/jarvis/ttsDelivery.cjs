'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const ttsMute = require('../ttsMute.cjs');
const ttsProviders = require('../ttsProviders.cjs');
const ttsStream = require('../ttsStream.cjs');
const { OPENAI_TTS_URL, DEFAULT_TTS_VOICE, DEFAULT_TTS_MODEL } = require('./constants.cjs');
const { trackLocalAudioChild, stopPlayback, speakSay, setCurrentPlayback } = require('./audioProcess.cjs');

const TTS_CACHE_MAX_CHARS = 64;

function ttsCacheDir(cacheDir) {
  return cacheDir || path.join(os.tmpdir(), 'crewpane-jarvis', 'tts-cache');
}

function ttsCacheFile({ text, model, voice, cacheDir }) {
  if (typeof text !== 'string' || text.length === 0 || text.length > TTS_CACHE_MAX_CHARS) return null;
  const key = crypto.createHash('sha1').update(`${model}|${voice}|${text}`).digest('hex');
  return path.join(ttsCacheDir(cacheDir), `${key}.mp3`);
}

/** Önbellekten mp3 → { buf } | null. Bozuk/eksik dosya = önbellek yok (sessiz). */
function readTtsCache(args) {
  const f = ttsCacheFile(args);
  if (!f) return null;
  try {
    const buf = fs.readFileSync(f);
    return buf && buf.length > 0 ? { buf, file: f } : null;
  } catch {
    return null;
  }
}

/** Önbelleğe yaz (best-effort: disk hatası SESİ engellemez). */
function writeTtsCache(args) {
  const f = ttsCacheFile(args);
  if (!f || !args.buf || !args.buf.length) return false;
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, args.buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * Speak `text` via OpenAI TTS API → MP3.
 */
async function speakOpenAI({
  text,
  voice = DEFAULT_TTS_VOICE,
  model = DEFAULT_TTS_MODEL,
  apiKey,
  outDir,
  play = true,
  deliver = 'main',
  cacheDir,
  fetchImpl = fetch,
  execFileImpl = execFile,
  muted = ttsMute.isTtsMuted(),
} = {}) {
  const clean = String(text == null ? '' : text).trim();
  if (!clean) return { ok: false, reason: 'empty-text' };
  if (!apiKey) return { ok: false, reason: 'no-openai-key' };

  const dir = outDir || path.join(os.tmpdir(), 'crewpane-jarvis');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* best-effort */
  }

  const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const file = path.join(dir, `tts-${uniq}.mp3`);
  const t0 = Date.now();

  const cached = readTtsCache({ text: clean, model, voice, cacheDir });
  const buf0 = cached ? cached.buf : null;

  let res;
  if (!buf0) {
    try {
      res = await fetchImpl(OPENAI_TTS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, voice, input: clean }),
      });
    } catch (e) {
      return { ok: false, reason: 'tts-fetch-failed', detail: String((e && e.message) || e) };
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, reason: `tts-api-${res.status}`, detail };
    }
  }

  try {
    const buf = buf0 || Buffer.from(await res.arrayBuffer());
    const bytes = buf.length;
    if (bytes) ttsMute.noteSynthesized(bytes);
    if (!buf0) writeTtsCache({ text: clean, model, voice, cacheDir, buf });

    if (deliver === 'renderer') {
      stopPlayback();
      return {
        ok: true,
        path: null,
        bytes,
        ms: Date.now() - t0,
        voice,
        engine: 'openai',
        playIn: 'renderer',
        mime: 'audio/mpeg',
        audioBase64: buf.toString('base64'),
        cached: !!buf0,
        muted: muted || undefined,
      };
    }

    fs.writeFileSync(file, buf);
    if (play && muted) {
      ttsMute.noteSuppressedOutput('afplay');
    } else if (play) {
      try {
        stopPlayback();
        ttsMute.noteAudibleOutput('afplay');
        const playbackChild = trackLocalAudioChild(execFileImpl('afplay', [file], () => {
          setCurrentPlayback(null);
        }));
        setCurrentPlayback(playbackChild);
      } catch {
        /* best-effort */
      }
    }

    return { ok: true, path: file, bytes, ms: Date.now() - t0, voice, engine: 'openai', playIn: play && muted ? 'none' : 'main', cached: !!buf0, muted: muted || undefined };
  } catch (e) {
    return { ok: false, reason: 'tts-write-failed', detail: String((e && e.message) || e) };
  }
}

/**
 * ADP-848 — hazır ses BAYTLARINI teslim et: renderer'a base64 ya da diske + afplay.
 */
function deliverAudioBuffer({
  buf,
  mime = 'audio/mpeg',
  ext = 'mp3',
  engine,
  voice,
  ms = 0,
  play = true,
  deliver = 'main',
  outDir,
  execFileImpl = execFile,
  uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  muted = ttsMute.isTtsMuted(),
} = {}) {
  const bytes = buf ? buf.length : 0;
  if (!bytes) return { ok: false, reason: 'empty-audio', engine };
  ttsMute.noteSynthesized(bytes);
  if (deliver === 'renderer') {
    stopPlayback();
    return { ok: true, path: null, bytes, ms, voice, engine, playIn: 'renderer', mime, audioBase64: buf.toString('base64'), muted: muted || undefined };
  }
  const dir = outDir || path.join(os.tmpdir(), 'crewpane-jarvis');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* best-effort */
  }
  const file = path.join(dir, `tts-${engine}-${uniq}.${ext}`);
  try {
    fs.writeFileSync(file, buf);
  } catch (e) {
    return { ok: false, reason: 'tts-write-failed', detail: String((e && e.message) || e), engine };
  }
  if (play && muted) {
    ttsMute.noteSuppressedOutput('afplay');
  } else if (play) {
    try {
      stopPlayback();
      ttsMute.noteAudibleOutput('afplay');
      const playbackChild = trackLocalAudioChild(execFileImpl('afplay', [file], () => {
        setCurrentPlayback(null);
      }));
      setCurrentPlayback(playbackChild);
    } catch {
      /* best-effort */
    }
  }
  return { ok: true, path: file, bytes, ms, voice, engine, playIn: play && muted ? 'none' : 'main', mime, muted: muted || undefined };
}

/**
 * Choose TTS engine from settings and speak.
 */
async function speakWithSettings({
  text,
  play = true,
  deliver = 'main',
  settings,
  apiKey,
  outDir,
  fetchImpl = fetch,
  ctx,
  notify = true,
  noticeOnce = true,
  speakSayImpl = speakSay,
} = {}) {
  const j = (settings && settings.jarvis) || {};
  const engine = ttsProviders.resolveTtsEngine(settings);
  let fallback = null;
  const notice = (eng, reason, opts) => (
    notify ? ttsProviders.fallbackNotice(eng, reason, { once: noticeOnce, ...(opts || {}) }) : null
  );

  if (engine === 'openai') {
    if (apiKey) {
      const res = await speakOpenAI({
        text, play, deliver, apiKey, outDir,
        voice: j.ttsVoice || DEFAULT_TTS_VOICE,
        model: j.ttsModel || DEFAULT_TTS_MODEL,
      });
      if (res.ok) return res;
      fallback = { from: 'openai', reason: res.reason || 'tts-failed', notice: notice('openai', res.reason || 'tts-failed') };
    } else {
      fallback = { from: 'openai', reason: 'no-key', notice: notice('openai', 'no-key') };
    }
  } else if (engine === 'elevenlabs' || engine === 'azure') {
    const spec = ttsProviders.TTS_PROVIDERS[engine];
    const res = await ttsProviders.synthesizeCloud({ engine, text, settings, ctx, fetchImpl, notify, noticeOnce });
    if (res.ok) {
      const out = deliverAudioBuffer({
        buf: res.buf, mime: res.mime, ext: spec.ext, engine, voice: res.voice,
        ms: res.ms, play, deliver, outDir,
      });
      if (out.ok) return out;
      fallback = { from: engine, reason: out.reason, notice: notice(engine, out.reason) };
    } else {
      fallback = { from: engine, reason: res.reason, notice: res.notice || null, detail: res.detail || null };
    }
  }

  if (play === false && deliver === 'renderer') {
    return { ok: false, reason: 'warm-skip-say', engine: 'say', ...(fallback ? { fallback } : {}) };
  }
  const sayRes = { ...(await speakSayImpl({ text, play, outDir })), engine: 'say' };
  return fallback ? { ...sayRes, fallback } : sayRes;
}

/**
 * AGENTX-RT-3 — AKAN TTS. Ses, dosya bitmeden çalmaya başlar.
 */
async function speakStreamWithSettings({
  text,
  settings,
  apiKey,
  onChunk,
  signal,
  fetchImpl = fetch,
  cacheDir,
  muted = ttsMute.isTtsMuted(),
  env = process.env,
} = {}) {
  const clean = String(text == null ? '' : text).trim();
  if (!clean) return { ok: false, reason: 'empty-text' };
  if (typeof onChunk !== 'function') return { ok: false, reason: 'no-sink' };
  if (env && (env.CREWPANE_TTS_STREAM === '0' || env.CREWPANE_TTS_STREAM === 'off')) {
    return { ok: false, reason: 'stream-disabled' };
  }
  const engine = ttsProviders.resolveTtsEngine(settings);
  if (engine !== 'openai') return { ok: false, reason: `stream-unsupported-${engine}` };
  if (!apiKey) return { ok: false, reason: 'no-openai-key' };

  const j = (settings && settings.jarvis) || {};
  const voice = j.ttsVoice || DEFAULT_TTS_VOICE;
  const model = j.ttsModel || DEFAULT_TTS_MODEL;

  const cached = readTtsCache({ text: clean, model, voice, cacheDir });
  if (cached) {
    if (cached.buf.length) ttsMute.noteSynthesized(cached.buf.length);
    return {
      ok: true, cached: true, engine: 'openai', voice, model, playIn: 'renderer',
      mime: 'audio/mpeg', audioBase64: cached.buf.toString('base64'),
      bytes: cached.buf.length, ms: 0, muted: muted || undefined,
    };
  }

  let first = true;
  const res = await ttsStream.streamOpenAiSpeech({
    text: clean, voice, model, apiKey, fetchImpl, signal,
    onChunk: (c) => {
      if (first) {
        first = false;
        if (muted) ttsMute.noteSuppressedOutput('renderer-pcm');
        else ttsMute.noteAudibleOutput('renderer-pcm');
      }
      onChunk(muted ? { ...c, base64: Buffer.alloc(c.bytes).toString('base64') } : c);
    },
  });
  if (res.bytes) ttsMute.noteSynthesized(res.bytes);
  return { ...res, engine: 'openai', voice, model, playIn: 'renderer', muted: muted || undefined };
}

/**
 * ADP-848 — AYARLARDAKİ SESLİ ÖNİZLEME: aynı Türkçe cümleyi İSTENEN motorda
 * seslendir.
 */
async function ttsPreview({
  engine,
  voice,
  settings,
  apiKey,
  outDir,
  deliver = 'main',
  play = true,
  fetchImpl = fetch,
  ctx,
  text,
} = {}) {
  const wanted = ttsProviders.TTS_PROVIDERS[engine] ? engine : ttsProviders.resolveTtsEngine(settings);
  const previewText = (typeof text === 'string' && text.trim()) ? text.trim() : ttsProviders.TTS_PREVIEW_TEXT_TR;
  const j = (settings && settings.jarvis) || {};
  const voiceOverride = typeof voice === 'string' && voice.trim() ? voice.trim() : null;
  const perEngineVoice = {};
  if (voiceOverride) {
    if (wanted === 'elevenlabs') perEngineVoice.elevenVoiceId = voiceOverride;
    else if (wanted === 'azure') perEngineVoice.azureVoice = voiceOverride;
    else perEngineVoice.ttsVoice = voiceOverride;
  }
  const previewSettings = { ...(settings || {}), jarvis: { ...j, ttsEngine: wanted, ...perEngineVoice } };
  const res = await speakWithSettings({
    text: previewText, play, deliver, settings: previewSettings, apiKey, outDir, fetchImpl, ctx,
    noticeOnce: false,
  });
  return {
    ...res,
    requested: wanted,
    text: previewText,
    spokenBy: res.engine || (res.ok ? wanted : null),
  };
}

module.exports = {
  TTS_CACHE_MAX_CHARS,
  ttsCacheDir,
  ttsCacheFile,
  readTtsCache,
  writeTtsCache,
  speakOpenAI,
  deliverAudioBuffer,
  speakWithSettings,
  speakStreamWithSettings,
  ttsPreview,
  ttsProviders,
  ttsStream,
};
