// CrewPane — Cloud TTS Synthesis (ElevenLabs, Azure) and Renderer Configuration.
'use strict';

const credentialGate = require('../../security/requireCredential.cjs');
const {
  TTS_PROVIDERS,
  TTS_ENGINE_IDS,
  TTS_PREVIEW_TEXT_TR,
  COST_ASSUMPTIONS,
  ELEVEN_MODELS,
  ELEVEN_DEFAULT_MODEL,
  AZURE_DEFAULT_REGION,
  ASSUMPTIONS,
  BAD_KEY_FORMAT_HINT,
} = require('./constants.cjs');
const {
  elevenApiBase,
  elevenAuthHint,
  sanitizeApiKey,
  isHeaderSafeKey,
} = require('./elevenAuth.cjs');
const {
  estimateCost,
  resolveTtsEngine,
  isSupportedOn,
  freeEngineFor,
  hasKeyFor,
  pickVoiceFromSettings,
  fallbackNotice,
} = require('./costEngine.cjs');

async function safeText(res) {
  try { return (await res.text()).slice(0, 300); } catch { return ''; }
}

/**
 * ElevenLabs → MP3 Buffer.
 * KAYNAK: https://elevenlabs.io/docs/api-reference/text-to-speech/convert
 */
async function synthElevenLabs({ text, apiKey, voice, model, fetchImpl = fetch } = {}) {
  const clean = String(text == null ? '' : text).trim();
  if (!clean) return { ok: false, reason: 'empty-text' };
  const key = sanitizeApiKey(apiKey);
  if (!key) return { ok: false, reason: 'no-key' };
  if (!isHeaderSafeKey(key)) return { ok: false, reason: 'bad-key-format', hint: BAD_KEY_FORMAT_HINT };
  const voiceId = typeof voice === 'string' && voice.trim() ? voice.trim() : '';
  if (!voiceId) return { ok: false, reason: 'no-voice' };
  const modelId = ELEVEN_MODELS[model] ? model : ELEVEN_DEFAULT_MODEL;
  const t0 = Date.now();
  let res;
  try {
    res = await fetchImpl(`${elevenApiBase()}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: {
        'xi-api-key': key,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text: clean,
        model_id: modelId,
        voice_settings: { stability: 0.4, similarity_boost: 0.75 },
      }),
    });
  } catch (e) {
    return { ok: false, reason: 'fetch-failed', detail: String((e && e.message) || e) };
  }
  if (!res.ok) {
    const detail = await safeText(res);
    const hint = elevenAuthHint(res.status, detail);
    return {
      ok: false,
      reason: `api-${res.status}`,
      detail,
      providerStatus: hint ? hint.status : null,
      providerMessage: hint ? hint.providerMessage : null,
      hint: hint ? hint.text : null,
    };
  }
  try {
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return { ok: false, reason: 'empty-audio' };
    return { ok: true, buf, mime: 'audio/mpeg', engine: 'elevenlabs', voice: voiceId, model: modelId, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, reason: 'read-failed', detail: String((e && e.message) || e) };
  }
}

/**
 * SSML'e gömülecek metni kaçır.
 */
function escapeSsml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function azureSsml(text, voice) {
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="tr-TR">` +
    `<voice name="${escapeSsml(voice)}">${escapeSsml(text)}</voice></speak>`;
}

/**
 * Azure Cognitive Services (Speech) → MP3 Buffer.
 * KAYNAK: https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech
 */
async function synthAzure({ text, apiKey, voice, region, fetchImpl = fetch } = {}) {
  const clean = String(text == null ? '' : text).trim();
  if (!clean) return { ok: false, reason: 'empty-text' };
  if (!apiKey) return { ok: false, reason: 'no-key' };
  const reg = String(region || AZURE_DEFAULT_REGION).trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(reg)) return { ok: false, reason: 'bad-region' };
  const voiceName = voice || TTS_PROVIDERS.azure.defaultVoice;
  const t0 = Date.now();
  let res;
  try {
    res = await fetchImpl(`https://${reg}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': apiKey,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
        'User-Agent': 'CrewPane',
      },
      body: azureSsml(clean, voiceName),
    });
  } catch (e) {
    return { ok: false, reason: 'fetch-failed', detail: String((e && e.message) || e) };
  }
  if (!res.ok) {
    const detail = await safeText(res);
    return { ok: false, reason: `api-${res.status}`, detail };
  }
  try {
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return { ok: false, reason: 'empty-audio' };
    return { ok: true, buf, mime: 'audio/mpeg', engine: 'azure', voice: voiceName, region: reg, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, reason: 'read-failed', detail: String((e && e.message) || e) };
  }
}

const CLOUD_SYNTH = Object.freeze({ elevenlabs: synthElevenLabs, azure: synthAzure });

/**
 * Motoru ayarlardan çözüp SES BAYTLARINI üret.
 */
async function synthesizeCloud({ engine, text, settings, ctx = {}, fetchImpl = fetch, notify = true, noticeOnce = true } = {}) {
  const fn = CLOUD_SYNTH[engine];
  if (!fn) return { ok: false, reason: 'unsupported-engine' };
  const spec = TTS_PROVIDERS[engine];
  const gate = ctx.gate || credentialGate;
  const cred = gate.resolveCredential(spec.credential, ctx);
  const notice = (reason, opts) => (notify ? fallbackNotice(engine, reason, { once: noticeOnce, ...(opts || {}) }) : null);
  if (!cred.ok) {
    return { ok: false, reason: 'no-key', notice: notice('no-key'), settingsTarget: cred.settingsTarget || null };
  }
  const j = (settings && settings.jarvis) || {};
  const voice = pickVoiceFromSettings(spec, j);
  const res = engine === 'elevenlabs'
    ? await fn({ text, apiKey: cred.secret, voice, model: j.elevenModel, fetchImpl })
    : await fn({ text, apiKey: cred.secret, voice, region: j.azureRegion, fetchImpl });
  if (!res.ok) return { ...res, notice: notice(res.reason, { hint: res.hint || null }) };
  return res;
}

/**
 * Ayarlar ekranının tek veri kaynağı.
 */
function ttsConfig(settings, ctx = {}) {
  const platform = ctx.platform || process.platform;
  const active = resolveTtsEngine(settings, { platform });
  const j = (settings && settings.jarvis) || {};
  const engines = TTS_ENGINE_IDS
    .filter((id) => isSupportedOn(id, platform))
    .map((id) => {
      const spec = TTS_PROVIDERS[id];
      const selectedVoice = pickVoiceFromSettings(spec, j);
      return {
        id,
        label: spec.label,
        tier: spec.tier,
        blurb: spec.blurb,
        voices: spec.voices.slice(),
        defaultVoice: spec.defaultVoice,
        credential: spec.credential,
        hasKey: hasKeyFor(id, ctx),
        selectedVoice,
        needsVoice: spec.defaultVoice === null && !selectedVoice,
        cost: estimateCost(id),
      };
    });
  const free = freeEngineFor(platform);
  return {
    engine: active,
    freeEngine: free,
    freeEngineNotice: free
      ? null
      : 'Bu platformda ücretsiz yerel ses yok — Agent X\'in konuşabilmesi için ' +
        'aşağıdaki motorlardan birine anahtar girmen gerekiyor.',
    previewText: TTS_PREVIEW_TEXT_TR,
    assumptions: ASSUMPTIONS.slice(),
    costAssumptions: { ...COST_ASSUMPTIONS },
    elevenModels: Object.values(ELEVEN_MODELS).map((m) => ({ id: m.id, label: m.label, usdPer1kChars: m.cost.usdPer1kChars })),
    elevenModel: ELEVEN_MODELS[j.elevenModel] ? j.elevenModel : ELEVEN_DEFAULT_MODEL,
    elevenVoiceId: typeof j.elevenVoiceId === 'string' && j.elevenVoiceId.trim() ? j.elevenVoiceId.trim() : '',
    elevenVoiceName: typeof j.elevenVoiceName === 'string' && j.elevenVoiceName.trim() ? j.elevenVoiceName.trim() : '',
    azureRegion: typeof j.azureRegion === 'string' && j.azureRegion.trim() ? j.azureRegion.trim() : AZURE_DEFAULT_REGION,
    azureVoice: TTS_PROVIDERS.azure.voices.includes(j.azureVoice) ? j.azureVoice : TTS_PROVIDERS.azure.defaultVoice,
    engines,
  };
}

module.exports = {
  escapeSsml,
  azureSsml,
  synthElevenLabs,
  synthAzure,
  synthesizeCloud,
  ttsConfig,
};
