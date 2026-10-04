// CrewPane — WIN-W6A (SPRINT-WIN-01) BARINDIRILAN (hosted) GÖMME SAĞLAYICISI.
//
// NİYE VAR — ÖLÇÜLEN ARIZA: `memoryEmbedder.cjs` gömmeyi CİHAZDA koşturur ve ağır
// şeyler (transformers.js + onnxruntime ikilisi ~67 MB, bge-m3 ağırlığı 543 MB)
// PAKETTE DEĞİLDİR; kullanıcı onay verince `memoryEmbedInstall` bunları `npm` ile
// indirir. Windows'ta bu yol kurulmuyor (WIN-R1 §W6, Miraç'ın makinesi) → hafızanın
// ANLAM katmanı ölü, arama yalnız kelime katmanıyla dönüyor.
//
// 🔴 WIN-R1'İN TEŞHİSİ KISMEN YANLIŞTI, DÜZELTİLDİ: rapor "Python runtime paketе
// girmemiş / `sentence-transformers` fail" diyordu. Kodda Python YOKTUR — motor
// `@huggingface/transformers` (Node/ONNX). Fix yönü ("bundle VEYA hosted") doğru,
// gerekçesi yanlıştı; bu dosya doğru gerekçeyle yazıldı.
//
// EREN KARARI (2026-08-20, 1-3-1): önce hosted API — Miraç'ta hafıza HEMEN
// çalışsın; yerel bundle (WIN-W6B) ayrı görev olarak arkasından gelir. Yani bu
// katman GEÇİCİ KÖPRÜ DEĞİL, kalıcı bir fallback basamağıdır:
//
//     yerel çalışma zamanı + model VAR  → YEREL (ücretsiz, çevrimdışı, bge-m3)
//     yok + kullanıcının anahtarı VAR   → HOSTED (bu dosya)
//     ikisi de yok                      → DÜRÜST "anahtar gerekli" mesajı
//
// ── ÜÇ KURAL ────────────────────────────────────────────────────────────────
//
// 1. ANAHTAR KODA GÖMÜLMEZ ve kapıyı ATLAMAZ. Tek boğaz `requireCredential.cjs`
//    (ADP-628 fatura koruması): sır vault → Ayarlar → ~/.crewpane/keys.env →
//    (yalnız dev) .env.local sırasıyla çözülür. Bu dosya `process.env.OPENAI_API_KEY`
//    gibi YÖNETİLEN bir adı ASLA okumaz — okusaydı `requireCredential.test.cjs`
//    içindeki YAPISAL DEĞİŞMEZ testi kırmızı verirdi (ve vermelidir).
//
// 2. YENİ ANAHTAR İSTEMİYORUZ. Kayıt defteri, kullanıcının ZATEN girmiş olabileceği
//    anahtarları sırayla dener (`openai` → `gemini`): ikisinin de kapıda kaydı,
//    Ayarlar'da alanı ve "Doğrula" düğmesi VAR. Yani Windows'ta hafızayı açmak için
//    yeni bir kurulum adımı yok — anahtarı olan kullanıcı için bu katman kendiliğinden
//    devreye girer.
//
// 3. SESSİZ ÖLÜM YASAK. Anahtar yoksa dönen şey `{ok:false}` + kullanıcıya
//    GÖSTERİLECEK Türkçe cümle + Ayarlar hedefi. "Hiç sonuç yok" ile "anahtar yok"
//    aynı ekrana çıkamaz.
//
// ── 🪤 VEKTÖR UZAYI KARIŞTIRILAMAZ ──────────────────────────────────────────
//
// bge-m3 (1024 boyut) ile OpenAI (1536 boyut) vektörleri AYNI indekste anlamlı
// KIYASLANAMAZ — boyutları tutsa bile uzayları farklıdır ve kosinüs benzerliği
// gürültü üretir. Koruma indeksin PARMAK İZİNDE: `memoryIndexStore.fingerprintOf`
// {model,dtype,dim,chunk} saklar, uyuşmazlıkta indeks BAŞTAN kurulur. Bu yüzden
// `memoryIndexWorker` parmak izini SABİTLERDEN değil ÇALIŞAN MOTORDAN türetir
// (WIN-W6A'nın en kritik tek satırı). Sağlayıcı değişince indeks sıfırlanır ve
// yeniden gömülür — pahalı ama DOĞRU; alternatifi sessizce bozuk aramaydı.
//
// SAF + DI: `fetch` ve kimlik kapısı dışarıdan verilebilir → `node --test` ağa
// çıkmadan üç dalın hepsini ölçer.

'use strict';

/**
 * SAĞLAYICI KAYIT DEFTERİ — sıra ÖNCELİKTİR (ucuz olan önde).
 *
 *   credential  requireCredential.SERVICES id'si (anahtar ORADAN gelir)
 *   dim         vektör boyutu — indeks parmak izine GİRER
 *   usdPerMTok  1 milyon jeton başına USD (rapor maliyet tablosunun kaynağı)
 *   batchMax    tek istekte kaç metin (sağlayıcı tavanının ALTINDA tutuldu)
 *
 * 🪤 Anthropic BİLEREK YOK: Claude'un gömme (embeddings) API'si yoktur. "Anahtarım
 * var" diyen bir kullanıcının ANTHROPIC anahtarıyla burayı açmaya çalışmak, olmayan
 * bir uca istek atıp 404 göstermek olurdu.
 */
const PROVIDERS = Object.freeze([
  Object.freeze({
    id: 'openai',
    label: 'OpenAI',
    credential: 'openai',
    model: 'text-embedding-3-small',
    dim: 1536,
    batchMax: 96,
    usdPerMTok: 0.02,
    url: 'https://api.openai.com/v1/embeddings',
    // Anahtar BAŞLIKLA gider — URL sorgusuna ASLA (sorgu dizesi proxy/erişim
    // kayıtlarına düşer; `main.js::verifyAppApiKey` ile aynı duruş).
    header: 'Authorization',
    headerFormat: 'Bearer',
  }),
  Object.freeze({
    id: 'gemini',
    label: 'Google Gemini',
    credential: 'gemini',
    model: 'gemini-embedding-001',
    // 3072 varsayılanı yerine 1536: depo boyutu yarıya iner ve Matryoshka (MRL)
    // kırpması kaliteyi çok az düşürür. DİKKAT — 3072 DIŞINDAKİ her boyutta
    // sağlayıcı vektörü NORMALİZE ETMEDEN döner; aşağıda biz normalize ediyoruz.
    dim: 1536,
    batchMax: 64,
    usdPerMTok: 0.15,
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents',
    header: 'x-goog-api-key',
    headerFormat: null,
  }),
]);

/** Ebeveyn sürecin çocuğa sır TAŞIDIĞI değişkenler (yönetilen anahtar adı DEĞİL). */
const KEY_ENV = 'CREWPANE_EMBED_HOSTED_KEY';
const PROVIDER_ENV = 'CREWPANE_EMBED_HOSTED_PROVIDER';
/** Kaçış valfi: `0` → hosted katmanı tamamen kapalı (yalnız yerel). */
const ENABLE_ENV = 'CREWPANE_EMBED_HOSTED';

const REASON_NO_KEY = 'hosted_no_api_key';
const REASON_DISABLED = 'hosted_disabled';
const REASON_AUTH = 'hosted_auth_failed';
const REASON_RATE = 'hosted_rate_limited';
const REASON_HTTP = 'hosted_http_error';
const REASON_UNREACHABLE = 'hosted_unreachable';
const REASON_BAD_SHAPE = 'hosted_bad_response';

function providerById(id) {
  return PROVIDERS.find((p) => p.id === String(id || '')) || null;
}

function defaultGate() {
  return require('../security/requireCredential.cjs');
}

/**
 * Anahtarı olmayan kullanıcıya GÖSTERİLECEK tek cümle. Sağlayıcı adları ve Ayarlar
 * yolları kayıttan gelir — metin UYDURULMAZ (kapı kaydı değişirse cümle de değişir).
 */
function missingKeyMessage(gate = defaultGate()) {
  const parts = PROVIDERS.map((p) => {
    const spec = gate.SERVICES && gate.SERVICES[p.credential];
    return spec ? `${spec.label} (${spec.settingsWhere})` : p.label;
  });
  return `Hafıza araması için gömme modeli bu makinede kurulu değil. Anlam katmanını hemen açmak için bir API anahtarı gerekli: ${parts.join(' ya da ')}. Anahtar girilene kadar arama yalnız kelime katmanıyla çalışır.`;
}

/**
 * HANGİ sağlayıcı ve HANGİ anahtarla? Sıra:
 *   1. Ebeveyn süreç sırrı enjekte ettiyse (çatallanmış çocuk) → onu kullan.
 *      GEREKÇE: gömme işi `fork` edilmiş çocukta koşar; orada `require('electron')`
 *      yok, yani `safeStorage` KASASI OKUNAMAZ. Kasadaki anahtarı yalnız ANA süreç
 *      çözebilir ve çocuğa geçirir (engineAuth'un motorlara anahtar geçirmesiyle
 *      aynı kalıp). Enjeksiyon yoksa çocuk kapıyı kendisi çağırır ve Ayarlar /
 *      keys.env kaynaklarını yine görür.
 *   2. Kullanıcı sağlayıcı SABİTLEDİYSE (`CREWPANE_EMBED_HOSTED_PROVIDER`).
 *   3. Kayıt sırası (ucuz olan önde), ilk anahtarı bulunan kazanır.
 *
 * @returns {{ok:true, provider:object, secret:string, source:string}
 *          |{ok:false, reason:string, message:string, settingsTarget?:object|null, tried:string[]}}
 */
function resolveHostedProvider({ env = process.env, gate = defaultGate(), ctx = {} } = {}) {
  if (String(env[ENABLE_ENV] ?? '').trim() === '0') {
    return { ok: false, reason: REASON_DISABLED, message: 'Barındırılan gömme katmanı kapatılmış.', tried: [] };
  }
  const pinned = String(env[PROVIDER_ENV] || '').trim();
  const injected = String(env[KEY_ENV] || '').trim();
  if (injected) {
    const provider = providerById(pinned) || PROVIDERS[0];
    return { ok: true, provider, secret: injected, source: 'parent' };
  }

  const order = pinned ? [providerById(pinned)].filter(Boolean) : PROVIDERS;
  const tried = [];
  for (const provider of order) {
    tried.push(provider.id);
    let r;
    try {
      r = gate.resolveCredential(provider.credential, ctx);
    } catch {
      continue; // kapı patlarsa bu sağlayıcı yok sayılır, sıradakine bakılır
    }
    if (r && r.ok && r.secret) return { ok: true, provider, secret: r.secret, source: r.source };
  }
  const first = order[0] || PROVIDERS[0];
  let settingsTarget = null;
  try {
    settingsTarget = gate.settingsTargetFor ? gate.settingsTargetFor(first.credential) : null;
  } catch {
    settingsTarget = null;
  }
  return { ok: false, reason: REASON_NO_KEY, message: missingKeyMessage(gate), settingsTarget, tried };
}

/**
 * ANA SÜREÇ → ÇOCUK SÜREÇ sır köprüsü. Çatallamadan önce çağrılır; dönen nesne
 * çocuğun `env`ine eklenir. Anahtar bulunamazsa BOŞ nesne (çocuk kapıyı kendisi
 * dener, o da bulamazsa dürüst mesajla kapanır).
 *
 * 🔒 Sır YALNIZ kendi çocuğumuzun ortamına girer; loglanmaz, IPC'de dolaşmaz.
 */
function hostedKeyEnv({ env = process.env, gate = defaultGate(), ctx = {} } = {}) {
  if (String(env[ENABLE_ENV] ?? '').trim() === '0') return {};
  if (String(env[KEY_ENV] || '').trim()) return {}; // zaten ortamda — tekrar yazma
  const r = resolveHostedProvider({ env, gate, ctx });
  if (!r.ok) return {};
  return { [KEY_ENV]: r.secret, [PROVIDER_ENV]: r.provider.id };
}

/** L2 normalize — depo kosinüsü iç çarpımla hesaplar, vektörler birim olmalı. */
function l2normalize(values) {
  const vec = Float32Array.from(values);
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  if (!(norm > 0)) return vec; // sıfır vektör — bölme yok (NaN üretmeyelim)
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

/** Sağlayıcıya göre istek gövdesi. Saf → test gövdeyi doğrudan ölçer. */
function requestBodyFor(provider, texts) {
  if (provider.id === 'gemini') {
    return {
      requests: texts.map((t) => ({
        model: `models/${provider.model}`,
        content: { parts: [{ text: t }] },
        outputDimensionality: provider.dim,
      })),
    };
  }
  return { model: provider.model, input: texts, dimensions: provider.dim };
}

/** Sağlayıcı cevabı → ham vektör dizisi (normalize EDİLMEMİŞ). Saf. */
function vectorsFromResponse(provider, json) {
  if (provider.id === 'gemini') {
    const list = json && Array.isArray(json.embeddings) ? json.embeddings : null;
    return list ? list.map((e) => (e && Array.isArray(e.values) ? e.values : null)) : null;
  }
  const list = json && Array.isArray(json.data) ? json.data : null;
  if (!list) return null;
  // OpenAI `index` alanı ile sıra GARANTİ EDİLİR — dizinin geliş sırasına güvenmek
  // sessiz bir eşleşme hatası olurdu (yanlış metne yanlış vektör).
  const out = new Array(list.length).fill(null);
  for (const item of list) {
    const i = Number.isInteger(item && item.index) ? item.index : list.indexOf(item);
    if (i >= 0 && i < out.length) out[i] = Array.isArray(item.embedding) ? item.embedding : null;
  }
  return out;
}

/** İsteğin başlıkları. Sır YALNIZ burada, tek yerde biçimlenir. */
function headersFor(provider, secret) {
  const value = provider.headerFormat ? `${provider.headerFormat} ${secret}` : secret;
  return { 'content-type': 'application/json', [provider.header]: value };
}

/** HTTP kodu → makine nedeni. Kullanıcı cümlesi çağıranda üretilir. */
function reasonForStatus(status) {
  if (status === 401 || status === 403) return REASON_AUTH;
  if (status === 429) return REASON_RATE;
  return REASON_HTTP;
}

function messageForReason(reason, provider) {
  const who = provider ? provider.label : 'Sağlayıcı';
  switch (reason) {
    case REASON_AUTH:
      return `${who} anahtarı reddedildi (yetkisiz). Ayarlar'daki anahtarı kontrol et — hafıza araması o güne kadar yalnız kelime katmanıyla çalışır.`;
    case REASON_RATE:
      return `${who} istek sınırına takıldı. Bir süre sonra yeniden denenecek; arama şimdilik yalnız kelime katmanıyla çalışıyor.`;
    case REASON_UNREACHABLE:
      return `${who} sunucusuna ulaşılamadı (ağ yok ya da engelli). Arama yalnız kelime katmanıyla çalışıyor.`;
    case REASON_BAD_SHAPE:
      return `${who} beklenmeyen bir cevap döndürdü. Arama yalnız kelime katmanıyla çalışıyor.`;
    default:
      return `${who} çağrısı başarısız oldu. Arama yalnız kelime katmanıyla çalışıyor.`;
  }
}

/**
 * BARINDIRILAN GÖMME MOTORU. `memoryEmbedder.createEmbedder` ile AYNI sözleşme:
 * `{ ok, model, dtype, dim, embed(texts)->Float32Array[], close() }`.
 * Böylece `memoryIndexer.runIndex` ve `memoryEmbedWorker` hiçbir dal bilmez —
 * motoru kim ürettiyse üretsin aynı şekilde kullanılır.
 *
 * `dtype` bilerek `'api:<sağlayıcı>'`: indeks parmak izine giren alan budur, yani
 * OpenAI ile Gemini vektörleri (ikisi de 1536 boyut!) AYNI indekste karışamaz.
 */
async function createHostedEmbedder({
  env = process.env,
  gate = defaultGate(),
  ctx = {},
  fetchImpl = null,
  timeoutMs = 30000,
} = {}) {
  const picked = resolveHostedProvider({ env, gate, ctx });
  if (!picked.ok) return { ok: false, hosted: true, ...picked };

  const { provider, secret } = picked;
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return { ok: false, hosted: true, reason: REASON_UNREACHABLE, message: messageForReason(REASON_UNREACHABLE, provider) };
  }

  async function embedBatch(texts) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await doFetch(provider.url, {
        method: 'POST',
        headers: headersFor(provider, secret),
        body: JSON.stringify(requestBodyFor(provider, texts)),
        signal: ac.signal,
      });
    } catch (err) {
      // 🔒 Sağlayıcı hata metni SIRRI yansıtabilir (bazı vekiller isteği yankılar).
      // Dışarı yalnız KENDİ ürettiğimiz cümle çıkar; ham gövde asla.
      throw Object.assign(new Error(messageForReason(REASON_UNREACHABLE, provider)), {
        reason: REASON_UNREACHABLE,
        cause: err && err.name,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res || res.ok !== true) {
      const reason = reasonForStatus(res ? res.status : 0);
      throw Object.assign(new Error(messageForReason(reason, provider)), { reason, status: res ? res.status : 0 });
    }
    let json;
    try {
      json = await res.json();
    } catch {
      throw Object.assign(new Error(messageForReason(REASON_BAD_SHAPE, provider)), { reason: REASON_BAD_SHAPE });
    }
    const raw = vectorsFromResponse(provider, json);
    if (!raw || raw.length !== texts.length || raw.some((v) => !v || !v.length)) {
      throw Object.assign(new Error(messageForReason(REASON_BAD_SHAPE, provider)), { reason: REASON_BAD_SHAPE });
    }
    return raw.map(l2normalize);
  }

  async function embed(texts) {
    const list = Array.isArray(texts) ? texts : [texts];
    if (!list.length) return [];
    const out = [];
    for (let i = 0; i < list.length; i += provider.batchMax) {
      const batch = list.slice(i, i + provider.batchMax).map((t) => String(t == null ? '' : t));
      out.push(...(await embedBatch(batch)));
    }
    return out;
  }

  return {
    ok: true,
    hosted: true,
    provider: provider.id,
    model: provider.model,
    dtype: `api:${provider.id}`,
    dim: provider.dim,
    keySource: picked.source,
    embed,
    async close() {
      /* tutulan kaynak yok — HTTP istekleri istek başına kapanır */
    },
  };
}

module.exports = {
  PROVIDERS,
  KEY_ENV,
  PROVIDER_ENV,
  ENABLE_ENV,
  REASON_NO_KEY,
  REASON_DISABLED,
  REASON_AUTH,
  REASON_RATE,
  REASON_HTTP,
  REASON_UNREACHABLE,
  REASON_BAD_SHAPE,
  providerById,
  missingKeyMessage,
  resolveHostedProvider,
  hostedKeyEnv,
  l2normalize,
  requestBodyFor,
  vectorsFromResponse,
  headersFor,
  reasonForStatus,
  messageForReason,
  createHostedEmbedder,
};
