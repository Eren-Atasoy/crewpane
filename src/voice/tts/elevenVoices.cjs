// CrewPane — ElevenLabs Voice Discovery, Turkish Classification, and Status Reporting.
'use strict';

const credentialGate = require('../../security/requireCredential.cjs');
const {
  MULTILINGUAL_MODEL_HINTS,
  TURKISH_RANK,
  BAD_KEY_FORMAT_HINT,
} = require('./constants.cjs');
const {
  elevenApiBase,
  elevenAuthHint,
  sanitizeApiKey,
  isHeaderSafeKey,
} = require('./elevenAuth.cjs');

async function safeText(res) {
  try { return (await res.text()).slice(0, 300); } catch { return ''; }
}

function lower(v) { return typeof v === 'string' ? v.toLowerCase() : ''; }

/** Bir dil alanı Türkçe'yi mi gösteriyor? ('tr', 'tr-TR', 'turkish', 'türkçe') */
function saysTurkish(v) {
  const s = lower(v).trim();
  if (!s) return false;
  return s === 'tr' || s.startsWith('tr-') || s.startsWith('tr_') || s.includes('turkish') || s.includes('türk');
}

/**
 * Sağlayıcının meta verisinden Türkçe uygunluğunu türet.
 * @returns {{fit:'verified'|'multilingual'|'unknown', why:string}}
 */
function classifyTurkish(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  // 1) Sağlayıcı DOĞRULAMIŞ (v2 `verified_languages`)
  const verified = Array.isArray(v.verified_languages) ? v.verified_languages : [];
  for (const item of verified) {
    const code = item && typeof item === 'object' ? (item.language || item.locale || item.language_code) : item;
    if (saysTurkish(code)) return { fit: 'verified', why: 'sağlayıcı Türkçe için doğruladı' };
  }
  // 2) Kullanıcının kendi Türkçe klonu (fine_tuning.language)
  const ft = v.fine_tuning && typeof v.fine_tuning === 'object' ? v.fine_tuning : {};
  if (saysTurkish(ft.language)) return { fit: 'verified', why: 'Türkçe olarak eğitilmiş (senin klonun)' };
  // 3) Etiketler (labels.language / labels.accent / labels.descriptive)
  const labels = v.labels && typeof v.labels === 'object' ? v.labels : {};
  for (const key of ['language', 'accent', 'locale']) {
    if (saysTurkish(labels[key])) return { fit: 'verified', why: `etiket: ${labels[key]}` };
  }
  // 4) Çok dilli model destekliyor mu? (Türkçe konuşabilir; doğrulanmış DEĞİL)
  const models = Array.isArray(v.high_quality_base_model_ids) ? v.high_quality_base_model_ids : [];
  const hit = models.find((m) => MULTILINGUAL_MODEL_HINTS.some((h) => lower(m).includes(h)));
  if (hit) return { fit: 'multilingual', why: `çok dilli model destekli (${hit})` };
  return { fit: 'unknown', why: 'dil bilgisi sağlayıcı meta verisinde yok' };
}

/** Kullanıcının KENDİ sesi mi (klon/profesyonel) — eşit Türkçe uygunlukta üste alınır. */
function isOwnVoice(category) {
  const c = lower(category);
  return c === 'cloned' || c === 'professional' || c === 'generated';
}

/** Ham API kaydını UI'ın kullandığı sade biçime indir (SIR İÇERMEZ). */
function normalizeElevenVoice(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  const id = typeof v.voice_id === 'string' ? v.voice_id : (typeof v.voiceId === 'string' ? v.voiceId : '');
  if (!id) return null;
  const labels = v.labels && typeof v.labels === 'object' ? v.labels : {};
  const tr = classifyTurkish(v);
  return {
    id,
    name: typeof v.name === 'string' && v.name.trim() ? v.name.trim() : id,
    category: typeof v.category === 'string' ? v.category : 'unknown',
    own: isOwnVoice(v.category),
    accent: typeof labels.accent === 'string' ? labels.accent : null,
    gender: typeof labels.gender === 'string' ? labels.gender : null,
    age: typeof labels.age === 'string' ? labels.age : null,
    useCase: typeof labels.use_case === 'string' ? labels.use_case : null,
    description: typeof v.description === 'string' ? v.description.slice(0, 200) : null,
    previewUrl: typeof v.preview_url === 'string' ? v.preview_url : null,
    turkish: tr.fit,
    turkishWhy: tr.why,
  };
}

/** Türkçe-önce sıralama: doğrulanmış → çok dilli → bilinmeyen; sonra kendi sesin; sonra ad. */
function sortVoicesTurkishFirst(voices) {
  return voices.slice().sort((a, b) => {
    const ra = TURKISH_RANK[a.turkish] ?? 9;
    const rb = TURKISH_RANK[b.turkish] ?? 9;
    if (ra !== rb) return ra - rb;
    if (a.own !== b.own) return a.own ? -1 : 1;
    return a.name.localeCompare(b.name, 'tr');
  });
}

/**
 * ElevenLabs ses listesini ÇEK (kullanıcının kendi anahtarıyla).
 * @returns {{ok:true, voices:object[], counts:object, api:'v2'|'v1', ms:number}
 *          |{ok:false, reason:string, status?:number, detail?:string}}
 */
async function fetchElevenVoices({ apiKey, fetchImpl = fetch, model, pageSize = 100 } = {}) {
  const key = sanitizeApiKey(apiKey);
  if (!key) return { ok: false, reason: 'no-key' };
  if (!isHeaderSafeKey(key)) return { ok: false, reason: 'bad-key-format', hint: BAD_KEY_FORMAT_HINT };
  const t0 = Date.now();
  const base = elevenApiBase();
  const headers = { 'xi-api-key': key, Accept: 'application/json' };
  const size = Math.min(100, Math.max(1, Number(pageSize) || 100));

  let api = 'v2';
  const rawVoices = [];
  let pageToken = null;
  let lastErr = null;
  for (let page = 0; page < 10; page += 1) {
    const url = new URL(`${base}/v2/voices`);
    url.searchParams.set('page_size', String(size));
    if (pageToken) url.searchParams.set('next_page_token', pageToken);
    let res;
    try {
      res = await fetchImpl(url.toString(), { method: 'GET', headers });
    } catch (e) {
      return { ok: false, reason: 'fetch-failed', detail: String((e && e.message) || e) };
    }
    if (!res.ok) { lastErr = { status: res.status, detail: await safeText(res) }; break; }
    let json;
    try { json = await res.json(); } catch (e) {
      lastErr = { status: res.status, detail: 'geçersiz JSON' }; break;
    }
    const list = Array.isArray(json && json.voices) ? json.voices : [];
    rawVoices.push(...list);
    pageToken = json && json.has_more && typeof json.next_page_token === 'string' ? json.next_page_token : null;
    if (!pageToken) { lastErr = null; break; }
  }

  if (lastErr) {
    if (lastErr.status === 401 || lastErr.status === 403) {
      const hint = elevenAuthHint(lastErr.status, lastErr.detail);
      return {
        ok: false,
        reason: `api-${lastErr.status}`,
        status: lastErr.status,
        detail: lastErr.detail,
        providerStatus: hint ? hint.status : null,
        hint: hint ? hint.text : null,
      };
    }
    api = 'v1';
    rawVoices.length = 0;
    let res;
    try {
      res = await fetchImpl(`${base}/v1/voices`, { method: 'GET', headers });
    } catch (e) {
      return { ok: false, reason: 'fetch-failed', detail: String((e && e.message) || e) };
    }
    if (!res.ok) {
      const detail = await safeText(res);
      const hint = elevenAuthHint(res.status, detail);
      return {
        ok: false,
        reason: `api-${res.status}`,
        status: res.status,
        detail,
        providerStatus: hint ? hint.status : null,
        hint: hint ? hint.text : null,
      };
    }
    try {
      const json = await res.json();
      rawVoices.push(...(Array.isArray(json && json.voices) ? json.voices : []));
    } catch {
      return { ok: false, reason: 'bad-json' };
    }
  }

  const voices = sortVoicesTurkishFirst(rawVoices.map((v) => normalizeElevenVoice(v)).filter(Boolean));
  if (!voices.length) return { ok: false, reason: 'empty-list', api, ms: Date.now() - t0 };
  return {
    ok: true,
    api,
    ms: Date.now() - t0,
    voices,
    counts: {
      total: voices.length,
      turkishVerified: voices.filter((v) => v.turkish === 'verified').length,
      multilingual: voices.filter((v) => v.turkish === 'multilingual').length,
      own: voices.filter((v) => v.own).length,
    },
  };
}

/**
 * Kullanıcıya gösterilecek Türkçe DURUM metni.
 * @returns {{tone:'ok'|'warn'|'info', text:string}}
 */
function elevenVoicesStatus(res) {
  if (res && res.ok) {
    const c = res.counts || {};
    const parts = [`${c.total} ses bulundu`];
    if (c.turkishVerified) parts.push(`${c.turkishVerified} tanesi Türkçe için doğrulanmış`);
    else if (c.multilingual) parts.push(`${c.multilingual} tanesi çok dilli (Türkçe konuşabilir)`);
    if (c.own) parts.push(`${c.own} tanesi senin kendi sesin`);
    return { tone: 'ok', text: `${parts.join(' · ')}. Seçip “Dinle”ye bas, kararı kulağın versin.` };
  }
  const reason = (res && res.reason) || 'unknown';
  const detail = res && res.detail ? ` (${String(res.detail).slice(0, 120)})` : '';
  if (res && typeof res.hint === 'string' && res.hint) return { tone: 'warn', text: res.hint };
  switch (reason) {
    case 'no-key':
      return {
        tone: 'warn',
        text: 'ElevenLabs API anahtarı yok — ses listesi hesabından çekilir. Yukarıdaki “ElevenLabs API anahtarı” alanına anahtarını gir, liste kendiliğinden dolar.',
      };
    case 'bad-key-format':
      return { tone: 'warn', text: BAD_KEY_FORMAT_HINT };
    case 'api-401':
    case 'api-403':
      return {
        tone: 'warn',
        text: 'ElevenLabs anahtarını kabul etmedi (yetki hatası). Anahtarı ElevenLabs → Profile → API Keys’ten yeniden kopyalayıp kaydet; iznin “Text to Speech” ve “Voices: read” içermeli.',
      };
    case 'api-429':
      return { tone: 'warn', text: 'ElevenLabs istek sınırına takıldı. Bir dakika bekleyip “Listeyi yenile”ye bas.' };
    case 'fetch-failed':
      return { tone: 'warn', text: `ElevenLabs’a ulaşılamadı — internet ya da güvenlik duvarı engelliyor olabilir${detail}. Bağlantını kontrol edip “Listeyi yenile”ye bas.` };
    case 'empty-list':
      return { tone: 'info', text: 'Anahtar çalıştı ama hesabında hiç ses yok. ElevenLabs → Voices’tan kütüphaneden bir ses ekle (ya da kendi sesini klonla), sonra “Listeyi yenile”ye bas.' };
    case 'bad-json':
      return { tone: 'warn', text: 'ElevenLabs beklenmedik bir cevap döndü. “Listeyi yenile”ye bas; sürerse anahtarını kontrol et.' };
    default:
      return { tone: 'warn', text: `Ses listesi alınamadı (${reason})${detail}. “Listeyi yenile”ye basıp tekrar dene.` };
  }
}

/**
 * Ayarlar ekranının çağırdığı üst yüzey: anahtarı KAPIDAN çöz, listeyi çek,
 * durum metnini üret. Sır DÖNMEZ.
 */
async function listElevenVoices({ settings, ctx = {}, fetchImpl = fetch } = {}) {
  const gate = ctx.gate || credentialGate;
  const cred = gate.resolveCredential('elevenlabs', ctx);
  if (!cred.ok) {
    const res = { ok: false, reason: 'no-key', settingsTarget: cred.settingsTarget || null };
    return { ...res, voices: [], status: elevenVoicesStatus(res) };
  }
  const j = (settings && settings.jarvis) || {};
  const res = await fetchElevenVoices({ apiKey: cred.secret, model: j.elevenModel, fetchImpl });
  return { ...res, voices: res.voices || [], status: elevenVoicesStatus(res) };
}

module.exports = {
  classifyTurkish,
  normalizeElevenVoice,
  sortVoicesTurkishFirst,
  fetchElevenVoices,
  elevenVoicesStatus,
  listElevenVoices,
};
