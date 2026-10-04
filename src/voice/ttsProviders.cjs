// ADP-848 — TTS SAĞLAYICI KATMANI: Türkçe prozodi bir MOTOR seçimidir, ayar değil.
//
// ── SORUN (ölçülmüş, ADP-848 §1) ─────────────────────────────────────────────
// Bugün iki motor var: OpenAI TTS (varsayılan) ve macOS `say -v Yelda`. İkisi de
// GENEL AMAÇLI: kelimeleri doğru söylüyorlar ama Türkçe cümle müziği (vurgu,
// tonlama, kesme işaretli ekler) yok. Yani şikâyet "model kalitesi" değil,
// PROZODİ. Prozodiyi ayarla düzeltemezsin — Türkçe'ye özel eğitilmiş bir ses
// gerekir. Bu dosya o seçimi mümkün kılan kayıttır.
//
// ── 🔴 KARAR-BELİRLEYEN HESAP (Eren, 2026-08-02) ────────────────────────────
// ElevenLabs çok dilli kalite $0.10/1000 karakter. Yanıt başına ~120 karakter ve
// YOĞUN kullanıcı (150 yanıt/gün) varsayımıyla: 120 × 150 × 30 = 540.000 karakter
// → AYDA ~54 USD. Bizim aboneliğimiz 15 USD/ay. Yani faturayı biz üstlenirsek
// EN ÇOK KULLANAN MÜŞTERİ EN ÇOK ZARAR ETTİREN MÜŞTERİ olur.
// ⇒ Premium motor ASLA varsayılan olamaz; ASLA bizim anahtarımızla açılamaz.
// ⇒ Kural: BYO-key (kullanıcı kendi anahtarını girer, fatura ona işlenir) +
//    varsayılan ÜCRETSİZ kalır + her ücretli seçeneğin yanında DÜRÜST maliyet.
// Bu, ADP-628 (BYO-key sert kapısı) ve ADP-827 (Grok Voice) ile aynı çizgidir;
// anahtar çözümlemesi burada da TEK boğazdan (requireCredential) geçer.
//
// ── KARARI KULAK VERİR, TABLO DEĞİL ──────────────────────────────────────────
// Modülün kalbi `TTS_PREVIEW_TEXT_TR`: Türkçe'nin motorları yakan yerlerini tek
// cümlede sınayan önizleme metni (ı/İ ayrımı, ğ, ö/ü, sayı+ek, kesme işareti).
// Ayarlar aynı cümleyi her motorda seslendirir → seçim kulakla yapılır.
//
// ── FAIL-SAFE YÖN (ADP-827 dersi) ────────────────────────────────────────────
// Anahtar yok / çağrı patladı → SESSİZCE ÖLME: ücretsiz yerel motora düş, sonucu
// `fallback` alanıyla AÇIKÇA söyle ve kullanıcıya OTURUMDA BİR KEZ bildir.
// Önizlemede bu hayati: kullanıcı ElevenLabs sandığı sesi `say`'den duymamalı —
// sonuç hangi motorun GERÇEKTEN konuştuğunu her zaman taşır.
//
// Saf + DI: `electron` require'ı YOK, `fetch`/`spawn` enjekte edilebilir → `node --test`.

'use strict';

const credentialGate = require('../security/requireCredential.cjs');

// ── Önizleme metni — Türkçe'nin zor yerleri ──────────────────────────────────
/**
 * Tek cümlede sınananlar:
 *   • ı / İ ayrımı ......... "Iğdır", "İstanbul", "şaşırtıcı"  (motorlar burada
 *     İngilizce 'i' sesine kayar; en sık duyulan hata)
 *   • ğ (yumuşak g) ........ "Iğdır", "öğle", "çiğ"
 *   • ö / ü ................ "öğle", "üne", "Gülşah"
 *   • sayı + ek ............ "8'inci"  (motor "sekiz apostrof inci" derse düşer)
 *   • kesme işareti + özel ad çekimi ... "Iğdır'dan", "İstanbul'a", "Gülşah'ın"
 * Cümle KISA tutuldu: yan yana dinlemede kulak 6-8 saniyeden fazlasını
 * karşılaştıramıyor (ADP-804'te ölçülen dinleme yorgunluğu).
 */
const TTS_PREVIEW_TEXT_TR =
  "Iğdır'dan İstanbul'a giden 8'inci uçakta, Gülşah'ın çiğ köftesi öğle üzeri şaşırtıcı bir üne kavuştu.";

// ── Maliyet varsayımları — kullanıcıya gösterilen sayıların TEK kaynağı ──────
/**
 * Bu üç sayı UI'da da rapordadır; kodda ikinci bir kopya YOKTUR (ADP-614 dersi:
 * fiyatın iki kopyası varsa biri sessizce bayatlar).
 */
const COST_ASSUMPTIONS = Object.freeze({
  charsPerReply: 120,   // Agent X yanıtı ~120 karakter (kısa, sesli asistan cevabı)
  repliesPerDay: 150,   // YOĞUN kullanıcı profili
  daysPerMonth: 30,
});

/**
 * Fiyat kayıtları. `basis` = fiyatın neye göre verildiği; `confidence`:
 *   • 'measured'  — bu görevde (ADP-848) sağlayıcının fiyat sayfasından okundu
 *   • 'estimate'  — bilgi tabanından; DOĞRULANMADI, UI'da "≈" ile gösterilir
 * 🔴 Dürüstlük kuralı: doğrulanmamış sayıyı doğrulanmış gibi göstermek, sayıyı
 * hiç göstermemekten kötüdür — kullanıcı ona bakarak fatura riskine giriyor.
 */
const PRICING = Object.freeze({
  elevenlabsMultilingual: Object.freeze({
    usdPer1kChars: 0.10,
    basis: 'doğrudan API, çok dilli yüksek kalite',
    measuredAt: '2026-08-02',
    sourceUrl: 'https://elevenlabs.io/pricing',
    confidence: 'measured',
    note: 'Plan (abonelik) üzerinden aşım daha pahalı: 0,12–0,30 USD/1000 karakter.',
  }),
  elevenlabsFlash: Object.freeze({
    usdPer1kChars: 0.05,
    basis: 'doğrudan API, Flash/Turbo (yarı fiyat, biraz daha düz tonlama)',
    measuredAt: '2026-08-02',
    sourceUrl: 'https://elevenlabs.io/pricing',
    confidence: 'measured',
    note: null,
  }),
  azureNeural: Object.freeze({
    usdPer1kChars: 0.016,
    basis: 'Neural TTS, kullandıkça öde (≈16 USD / 1 milyon karakter)',
    measuredAt: '2026-08-02',
    sourceUrl: 'https://azure.microsoft.com/pricing/details/cognitive-services/speech-services/',
    confidence: 'estimate',
    note: 'Bölgeye göre değişir; ücretsiz katman aylık 500.000 karakter içerir.',
  }),
  openaiTts: Object.freeze({
    usdPer1kChars: 0.015,
    basis: 'tts-1 sınıfı (≈15 USD / 1 milyon karakter)',
    measuredAt: '2026-08-02',
    sourceUrl: 'https://openai.com/api/pricing/',
    confidence: 'estimate',
    note: 'gpt-4o-mini-tts jeton bazlı ücretlenir; bu sayı aynı mertebede bir yaklaşıklıktır.',
  }),
});

// ── Sağlayıcı kaydı ──────────────────────────────────────────────────────────
/**
 * Yeni motor eklemek = buraya BİR kayıt + `SYNTH` içine bir fonksiyon.
 * Çağıran kod (jarvisVoice, main, Ayarlar) değişmez.
 *
 * Alanlar:
 *   tier        'free' | 'paid'         — ücretsiz motorlar anahtar İSTEMEZ
 *   credential  requireCredential servis id'si | null
 *   platform    'darwin' vb. | null     — yalnız o platformda görünür
 *   cost        PRICING kaydı | null    — null = ücretsiz
 *   voiceSettingKey  `settings.jarvis` içinde bu motorun SESİNİN durduğu alan.
 *     🔴 TTS-01 — bu alan olmadan "bu motorun sesi seçilmiş mi?" sorusunu yalnız
 *     motor id'sine bakan bir `if` zinciri cevaplayabilirdi (`if id==='elevenlabs'
 *     … elevenVoiceId`). Cevap KAYITTAN gelsin: yarın eklenen, varsayılan sesi
 *     olmayan bir motor tek satır kayıtla doğru davranır; UI/ttsConfig değişmez.
 */
const TTS_PROVIDERS = Object.freeze({
  say: Object.freeze({
    id: 'say',
    label: process.platform === 'win32' ? 'Windows (yerel)' : 'Yelda — macOS (yerel)',
    tier: 'free',
    credential: null,
    platform: null,
    kind: 'local',
    voices: Object.freeze([process.platform === 'win32' ? 'Windows System.Speech' : 'Yelda']),
    defaultVoice: process.platform === 'win32' ? 'Windows System.Speech' : 'Yelda',
    voiceSettingKey: 'ttsVoice',
    mime: 'audio/aiff',
    ext: 'aiff',
    cost: null,
    blurb:
      'Cihazda çalışır, internete çıkmaz, ücretsizdir. Kelimeler doğru; cümle müziği düz. ' +
      'Sistem Ayarları → Erişilebilirlik → Konuşulan İçerik’ten “geliştirilmiş” Türkçe sesi indirirsen belirgin iyileşir.',
  }),
  openai: Object.freeze({
    id: 'openai',
    label: 'OpenAI TTS',
    tier: 'paid',
    credential: 'openai',
    platform: null,
    kind: 'cloud',
    voices: Object.freeze(['alloy', 'echo', 'fable', 'nova', 'onyx', 'shimmer']),
    defaultVoice: 'nova',
    voiceSettingKey: 'ttsVoice',
    mime: 'audio/mpeg',
    ext: 'mp3',
    cost: PRICING.openaiTts,
    blurb:
      'Bugünkü varsayılan. Türkçe’yi doğru okur, tonlaması İngilizce kalıbında. ' +
      'Zaten girdiğin OpenAI anahtarını kullanır — ayrı bir anahtar gerekmez.',
  }),
  elevenlabs: Object.freeze({
    id: 'elevenlabs',
    label: 'ElevenLabs',
    tier: 'paid',
    credential: 'elevenlabs',
    platform: null,
    kind: 'cloud',
    // ── ADP-848-B — SES LİSTESİ ARTIK GÖMÜLÜ DEĞİL ────────────────────────────
    // Eskiden burada TEK sabit ses id'si dururdu (21m00Tcm4TlvDq8ikWAM). Yanlıştı:
    // ElevenLabs'te ses listesi HESABA aittir — kullanıcının klonladığı sesler,
    // kütüphaneden ekledikleri, hesabın bölgesine göre değişen varsayılanlar.
    // Anahtar kimin ise sesler onun. Bu yüzden liste `fetchElevenVoices()` ile
    // KULLANICININ KENDİ ANAHTARIYLA çekilir; kodda sabit liste YOKTUR.
    //
    // `voices` bilerek BOŞ: "listeyi kimin doldurduğu" sorusunun cevabı tek olsun.
    // Boş liste + anahtar yok = UI durum mesajı gösterir (sessiz boşluk YASAK).
    voices: Object.freeze([]),
    // Varsayılan ses id'si de YOK: hesabında hangi seslerin olduğunu bilmediğimiz
    // biri adına seçim yapamayız. Kullanıcı listeden seçene kadar `elevenVoiceId`
    // boş kalır ve seslendirme AÇIKÇA 'no-voice' ile reddedilir (sessizce rastgele
    // bir sese düşmek, faturası kullanıcıya çıkan bir üründe kabul edilemez).
    defaultVoice: null,
    voiceSettingKey: 'elevenVoiceId',
    dynamicVoices: true,
    mime: 'audio/mpeg',
    ext: 'mp3',
    cost: PRICING.elevenlabsMultilingual,
    blurb:
      'Türkçe tonlamada bugün en iyi bilinen seçenek (eleven_multilingual_v2). ' +
      'Ücreti KENDİ anahtarına işlenir; CrewPane araya girmez.',
  }),
  azure: Object.freeze({
    id: 'azure',
    label: 'Azure Neural (tr-TR)',
    tier: 'paid',
    credential: 'azure',
    platform: null,
    kind: 'cloud',
    // Microsoft'un Türkçe'ye ÖZEL eğitilmiş sinirsel sesleri.
    voices: Object.freeze(['tr-TR-EmelNeural', 'tr-TR-AhmetNeural']),
    defaultVoice: 'tr-TR-EmelNeural',
    voiceSettingKey: 'azureVoice',
    mime: 'audio/mpeg',
    ext: 'mp3',
    cost: PRICING.azureNeural,
    blurb:
      'Türkçe’ye özel eğitilmiş sinirsel sesler (Emel / Ahmet) — karakter başına ' +
      'ElevenLabs’ın ~altıda biri. Anahtarın yanında BÖLGE de gerekir (örn. westeurope).',
  }),
});

const TTS_ENGINE_IDS = Object.freeze(Object.keys(TTS_PROVIDERS));

/**
 * ÜCRETSİZ VARSAYILAN. Tanınmayan/bozuk her değer buraya düşer ve ücretli bir
 * motor ASLA kendiliğinden seçilmez (ADP-848 kuralı 14).
 */
const FREE_ENGINE = 'say';

/**
 * ADP-874 — 🔴 ÜCRETSİZ MOTOR HER PLATFORMDA YOK.
 *
 * `FREE_ENGINE` = `say` ve o kaydın `platform` alanı `'darwin'`. Yani Windows'ta
 * ürünün ücretsiz yerel sesi HİÇ YOKTUR. Bugün bu gerçek üç yerde SESSİZCE
 * yalana dönüşüyordu:
 *   • `ttsConfig().freeEngine` → 'say' (listede olmayan, o platformda
 *     çalıştırılamayan bir motor id'si)
 *   • `fallbackNotice()` → "ücretsiz yerel sese (Yelda — macOS (yerel)) geçildi"
 *     — Windows kullanıcısına macOS'a geçtiğini söylemek
 *   • `resolveTtsEngine()` bozuk ayarı `say`e düşürüyor → o kurulumda ses YOK
 *
 * Bu fonksiyon "bu platformda ücretsiz yerel motor var mı" sorusunun TEK cevabıdır.
 * null = yok. Çağıran null'ı görünce ne diyeceğini bilir (aşağıdaki notice).
 * darwin'de değer ve dolayısıyla TÜM davranış bit-bit aynı.
 */
function freeEngineFor(platform = process.platform) {
  return isSupportedOn(FREE_ENGINE, platform) ? FREE_ENGINE : null;
}

/**
 * 🔴 ADP-812 DERSİ: motorun varsayılanını `agentSettings.defaults()` içinde
 * SABİTLEME. Oradaki `jarvis.ttsEngine` bugün 'openai' — bu, ürünün SEVK EDİLMİŞ
 * tercihi olduğu için korunuyor; bozuk/eksik değer ise ücretsiz motora düşer.
 * Anahtar yoksa OpenAI yolu zaten çalışma anında `say`'e düşer (fail-safe).
 */
const SHIPPED_DEFAULT_ENGINE = 'openai';

/** ElevenLabs modelleri — kalite/fiyat ikilemi kullanıcıya AÇIK bırakılır. */
const ELEVEN_MODELS = Object.freeze({
  eleven_multilingual_v2: Object.freeze({
    id: 'eleven_multilingual_v2',
    label: 'Multilingual v2 (en iyi tonlama)',
    cost: PRICING.elevenlabsMultilingual,
  }),
  eleven_turbo_v2_5: Object.freeze({
    id: 'eleven_turbo_v2_5',
    label: 'Turbo v2.5 (yarı fiyat, daha hızlı)',
    cost: PRICING.elevenlabsFlash,
  }),
});
const ELEVEN_DEFAULT_MODEL = 'eleven_multilingual_v2';

const AZURE_DEFAULT_REGION = 'westeurope';

/**
 * Dokümanda AÇIKÇA doğrulayamadığımız her şey burada durur ve rapora "anahtar
 * girilince koşulacak kabul listesi" olarak çıkar (ADP-827 dürüstlük kuralı).
 */
const ASSUMPTIONS = Object.freeze([
  // ADP-848-B: eski "gömülü ses id\'si geçerli mi" varsayımı ORTADAN KALKTI —
  // liste artık kullanıcının kendi hesabından çekiliyor, kodda sabit id yok.
  'ElevenLabs ses listesi kullanıcının anahtarıyla hesabından çekilir; Türkçe işareti sağlayıcının kendi meta verisinden (verified_languages / fine_tuning / labels) türer.',
  'Azure bölgesi varsayılan "westeurope"; kullanıcının aboneliği başka bölgedeyse Ayarlar\'dan değiştirilmeli.',
  'OpenAI ve Azure karakter fiyatları bilgi tabanından; UI\'da "≈" ile ve kaynak bağlantısıyla gösterilir.',
  // ADP-918 + ADP-902 — 401/400 sebep sınıflandırması. ÜÇ dal GERÇEK çağrıyla
  // ölçüldü ("quota_exceeded" ADP-902'de canlı anahtarla eklendi), ikisi hâlâ
  // sağlayıcı dokümanından; tanınmayan her `status` için sağlayıcının KENDİ
  // mesajı aktarılır (uydurma cümle üretilmez).
  'ElevenLabs hata gövdesindeki "needs_authorization" / "invalid_api_key" (ADP-918) ve "quota_exceeded" (ADP-902) durumları gerçek API çağrısıyla ölçüldü; "missing_permissions" / "detected_unusual_activity" sağlayıcı dokümanından alındı ve canlı anahtarla DOĞRULANMADI.',
]);

// ── Maliyet hesabı ───────────────────────────────────────────────────────────
/**
 * Dürüst maliyet göstergesi (ADP-848 §6). Kullanıcı neye tıkladığını BİLSİN:
 * yanıt başına kuruş + yoğun kullanımda aylık fatura.
 * @returns {{usdPer1kChars:number, perReplyUsd:number, monthlyHeavyUsd:number,
 *            charsPerReply:number, repliesPerDay:number,
 *            measuredAt:string, sourceUrl:string, confidence:string,
 *            basis:string, note:string|null}|null}  null = ücretsiz motor
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

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

// ── Motor çözümlemesi (FAIL-SAFE) ────────────────────────────────────────────
/**
 * Ayarlardaki motoru çöz. Tanınmayan/bozuk değer → ÜCRETSİZ motor.
 * Ayar hiç yoksa sevk edilmiş varsayılan ('openai') korunur — o yol da anahtar
 * yoksa çalışma anında `say`'e düşer, yani hiçbir kurulumda sessizlik olmaz.
 */
function resolveTtsEngine(settings, opts = {}) {
  const j = (settings && settings.jarvis) || {};
  const raw = j.ttsEngine;
  // ADP-874 — çöp değerin düşeceği yer PLATFORMA bağlı. macOS'ta `say` (bugünkü
  // davranış, bit-bit aynı); ücretsiz yerel motoru OLMAYAN bir platformda `say`e
  // düşmek, ÇALIŞTIRILAMAYAN bir motor id'si döndürmektir — çağıran onu "seçili
  // motor" diye gösterir ve kullanıcı ekranda macOS motoru görür. Orada sevk
  // edilmiş varsayılana düşülür: o da ÜCRETSİZ DEĞİL ama anahtar kapısı zaten
  // `no-key` ile dürüstçe reddediyor (yani ücretli motor kendiliğinden
  // ÇALIŞMAZ — ADP-848 kuralı 14'ün koruduğu değişmez korunur).
  const platform = opts.platform || process.platform;
  const fallbackId = freeEngineFor(platform) || SHIPPED_DEFAULT_ENGINE;
  // YOK / boş = "kullanıcı seçmemiş" → sevk edilmiş varsayılan.
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) return SHIPPED_DEFAULT_ENGINE;
  // VAR ama string bile değil (sayı/nesne — elle düzenlenmiş ya da bozuk ayar
  // dosyası) → ÜCRETSİZ. "Boş" ile "çöp" aynı şey değildir: çöp bir değer,
  // ücretli bir motora dolaylı yoldan da olsa kapı aralayamaz.
  if (typeof raw !== 'string') return fallbackId;
  const id = raw.trim().toLowerCase();
  return TTS_PROVIDERS[id] ? id : fallbackId;
}

/** Motorun bu platformda kullanılabilirliği (ör. `say` yalnız macOS). */
function isSupportedOn(engineId, platform = process.platform) {
  const spec = TTS_PROVIDERS[engineId];
  if (!spec) return false;
  return !spec.platform || spec.platform === platform;
}

/**
 * TTS-01 — bu motorun ŞU ANKİ sesi (ayarlardan). `''` = seçim YOK.
 * Alanın adı motorun KAYDINDA (`voiceSettingKey`) yazılıdır; burada motor id'sine
 * bakan bir `if` zinciri YOKTUR (yeni motor = tek satır kayıt).
 */
function pickVoiceFromSettings(spec, jarvis = {}) {
  const raw = spec && spec.voiceSettingKey ? jarvis[spec.voiceSettingKey] : null;
  const v = typeof raw === 'string' ? raw.trim() : '';
  // Dinamik listeli motorda (ElevenLabs) doğrulayacak sabit liste YOKTUR — liste
  // kullanıcının hesabında yaşar; ham değer olduğu gibi geçerlidir.
  if (spec.dynamicVoices) return v;
  // Statik listede TANINMAYAN değer "seçilmiş" sayılmaz: bozuk ayar, motoru
  // konuşabilir göstermemeli. Varsayılanı olan motor zaten ona düşer.
  if (v && spec.voices.includes(v)) return v;
  return spec.defaultVoice || '';
}

/** Anahtar var mı? (sır DÖNMEZ — yalnız bayrak) Ücretsiz motorlar her zaman true. */
function hasKeyFor(engineId, ctx = {}) {
  const spec = TTS_PROVIDERS[engineId];
  if (!spec) return false;
  if (!spec.credential) return true;
  const gate = ctx.gate || credentialGate;
  return gate.hasCredential(spec.credential, ctx) === true;
}

// ── "Sessizce ölme": oturumda BİR KEZ bildirim ───────────────────────────────
/**
 * Aynı arızayı her turda söylemek gürültüdür, hiç söylememek yalandır.
 * Bu yüzden motor+sebep başına OTURUMDA BİR KEZ (ADP-848 kuralı 7).
 *
 * 🔴 TTS-01 — "BİR KEZ" KURALI KENDİ KENDİNİ YİYORDU (Eren'in 0.2.31 ekranı).
 * Kural, KULLANICININ İSTEMEDİĞİ turlar (Agent X'in kendi konuşmaları, ısıtma)
 * için doğrudur: aynı arıza her cümlede tekrar edilirse ekran çöplenir. Ama
 * ÖNİZLEME ("Dinle") kullanıcının AÇIK JESTİDİR — kullanıcı bilerek soruyor,
 * cevabı "bunu sana bu oturumda bir kez söylemiştim" olamaz. Ölçülen sonuç tam
 * buydu: anahtarını doğru girmiş kullanıcı ikinci tıklamada yol gösterici cümle
 * yerine çıplak "(no-voice)" görüyor ve "anahtarı yanlış girdim" sanıp döngüye
 * giriyordu (ADP-918'in kapattığı sınıfın birebir kardeşi).
 *
 * ⇒ `once` artık ÇAĞRI BAĞLAMINDAN gelir: kendiliğinden konuşan turlar `once:true`
 * (bugünkü davranış, bit-bit aynı), önizleme yolu `once:false`. Metnin kendisi
 * TEK YERDE (bu fonksiyon) kalır — UI kendi cümlesini yazsaydı aynı arıza için
 * iki kaynak olurdu ve biri sessizce bayatlardı (ADP-614 dersi).
 */
const _noticed = new Set();

function fallbackNotice(engineId, reason, { once = true, platform = process.platform, hint = null } = {}) {
  const spec = TTS_PROVIDERS[engineId];
  const label = spec ? spec.label : engineId;
  const key = `${engineId}:${reason}`;
  if (once && _noticed.has(key)) return null;
  if (once) _noticed.add(key);
  // 🔴 ADP-918 — ÇIPLAK `api-401` KULLANICIYA HİÇBİR ŞEY SÖYLEMİYOR.
  // Sağlayıcının gövdesinden çözülmüş yönlendirici cümle varsa, jenerik
  // "çağrısı başarısız oldu (<reason>)" metninin YERİNE geçer. Düşülen ücretsiz
  // motor bilgisi korunur (ADP-848 k.7 + ADP-874 platform gerçeği).
  const directive = typeof hint === 'string' && hint.trim() ? hint.trim() : null;
  if (directive) {
    const free = freeEngineFor(platform);
    return free
      ? `${directive} (Şimdilik ücretsiz yerel sese — ${TTS_PROVIDERS[free].label} — geçildi.)`
      : `${directive} (Bu platformda ücretsiz yerel ses YOK, bu yüzden ${label} düzelene kadar Agent X sessiz kalacak.)`;
  }
  // ADP-874 — DÜŞÜLECEK BİR YER YOKSA "düştüm" DEME. Windows'ta ücretsiz yerel
  // motor yok; kullanıcıya macOS sesine geçtiğini söylemek onu, hiç var olmayan
  // bir sesi aramaya gönderir. Eksik olan neyse o söylenir (ADP-848-B kuralının
  // platform hâli): tek çözüm bir anahtar girmektir.
  const free = freeEngineFor(platform);
  // 🔴 ADP-848-B + TTS-01: "sessiz ölüm yok" kuralı yetmez — DOĞRU ŞEYİ söylemek
  // gerekir. `no-voice` durumunda anahtar VARDIR, eksik olan SES SEÇİMİDİR.
  // Kullanıcıyı anahtar alanına yollamak onu, zaten yaptığı işi tekrar yapmaya
  // gönderir ve "girdim ama olmuyor" döngüsüne sokar (Eren'de ölçüldü).
  // Bu yüzden "ne eksik" + "ne yapmalıyım" ikilisi SEBEBE göre kurulur; ücretsiz
  // yerel motorun olup olmaması yalnız SONUNU değiştirir (ADP-874 platform gerçeği).
  const missing = reason === 'no-key'
    ? `${label} için API anahtarı yok`
    : reason === 'no-voice'
    ? `${label} anahtarın kayıtlı ama henüz bir SES seçmedin (sorun anahtarda değil)`
    : `${label} çağrısı başarısız oldu`;
  const todo = reason === 'no-voice'
    ? `Ayarlar → Ses → “${label} sesi” listesinden bir ses seç, sonra “Dinle” ile dene.`
    : reason === 'no-key'
    ? `Anahtarı Ayarlar → Ses → Erişim'den ekleyebilirsin.`
    // Bilinmeyen arıza: kodu EKRANA basmak yerine yapılabilecek şeyi söyle.
    // (Makine kodu `fallback.reason`da ve log'da duruyor — teşhis kaybolmuyor.)
    : `Biraz sonra “Dinle” ile tekrar dene; sürerse Ayarlar → Ses → Erişim'den anahtarını kontrol et.`;
  // ADP-874 — DÜŞÜLECEK BİR YER YOKSA "düştüm" DEME (Windows'ta ücretsiz yerel
  // ses yok; kullanıcıyı var olmayan bir sesi aramaya göndermek olurdu).
  if (!free) {
    return `${missing} — bu platformda ücretsiz yerel ses YOK, bu yüzden Agent X ` +
      `şimdilik sessiz kalacak. ${todo}`;
  }
  return `${missing} — ücretsiz yerel sese (${TTS_PROVIDERS[free].label}) geçildi. ${todo}`;
}

/** Test/oturum sıfırlama: bir sonraki arıza yeniden duyurulsun. */
function resetNotices() { _noticed.clear(); }

// ── Bulut sağlayıcıları ──────────────────────────────────────────────────────

// (uç adresi artık `elevenApiBase()` üstünden çözülür — test dikişi aşağıda)

// ── ADP-918 — "api-401" BİR TEŞHİS DEĞİL, TEŞHİSİN SAKLANDIĞI YER ────────────
//
// ŞİKÂYET (Eren): "Dinle"ye basınca ekranda çıplak `api-401` yazıyor. Bu metin
// kullanıcıya HİÇBİR ŞEY söylemiyor — anahtar mı yanlış, izni mi eksik, hesap mı
// kısıtlı, yoksa anahtar hiç gitmedi mi? Dördü de aynı sayıyı üretiyor.
//
// ÖLÇÜM (ADP-918, gerçek api.elevenlabs.io çağrıları — sahte anahtarla):
//   • xi-api-key YOK        → 401 {"detail":{"status":"needs_authorization",
//                                  "message":"Neither authorization header nor
//                                  xi-api-key received, please provide one."}}
//   • xi-api-key YANLIŞ     → 401 {"detail":{"status":"invalid_api_key",
//                                  "message":"Invalid API key"}}
//   • ürünün BİREBİR istek biçimiyle (aynı URL + model_id + voice_settings) de
//     dönen şey `invalid_api_key` — yani istek GÖVDE/MODEL doğrulamasını geçiyor,
//     yalnız KİMLİK reddediliyor. ⇒ "istek biçimi/model-id" sınıfı 401'in sebebi
//     OLAMAZ; bunu tahmin etmiyoruz, ölçtük.
// Yani sebep HER ZAMAN gövdede yazılı; biz onu `detail`e alıp ÇÖPE ATIYORDUK.
//
// 🔴 KURAL: 401 gövdesindeki `status` alanı, kullanıcıya ne yapacağını söyleyen
// cümlenin TEK kaynağıdır. Tanımadığımız bir `status` gelirse sağlayıcının KENDİ
// mesajını gösteririz — uydurmak yerine aktarırız (ADP-848 dürüstlük kuralı).
const ELEVEN_AUTH_HINTS = Object.freeze({
  // ÖLÇÜLDÜ (ADP-918). Bu dal görünürse arıza SAĞLAYICIDA değil BİZDE: kimlik
  // kapısı boş olmayan bir sır döndürdüğü hâlde başlık isteğe eklenmemiş demektir.
  needs_authorization: {
    confidence: 'measured',
    text: 'ElevenLabs isteğinde API anahtarı HİÇ gitmemiş. Bu bir ürün hatası — anahtarını değiştirmek çözmez; ' +
      'lütfen bu ekranı bildir (Ayarlar → Ses → Erişim’de anahtarın kayıtlı göründüğünü de yaz).',
  },
  // ÖLÇÜLDÜ (ADP-918) — en sık hâl.
  invalid_api_key: {
    confidence: 'measured',
    text: 'ElevenLabs anahtarı KABUL ETMEDİ: anahtar yanlış, silinmiş ya da başka bir hesaba ait. ' +
      'ElevenLabs → Profile → API Keys’ten anahtarı yeniden oluştur, TAMAMINI kopyala ' +
      '(başında/sonunda boşluk ya da tırnak kalmasın) ve Ayarlar → Ses → Erişim’e yapıştırıp kaydet.',
  },
  // DOĞRULANMADI (sağlayıcı dokümanı; ASSUMPTIONS'ta yazılı). Kapsamlı anahtarlarda
  // en olası ikinci hâl: anahtar geçerli ama o uca izni yok.
  missing_permissions: {
    confidence: 'documented',
    text: 'Anahtar geçerli ama bu işlem için İZNİ yok. ElevenLabs → API Keys → anahtarını düzenle: ' +
      '“Text to Speech” ve “Voices: read” izinleri açık olmalı (ya da “Has access to all” seç), sonra tekrar dene.',
  },
  // DOĞRULANMADI (sağlayıcı dokümanı). Ücretsiz katmanda VPN/proxy ile kullanımda
  // görülüyor; ANAHTAR DEĞİŞTİRMEK ÇÖZMEZ — yanlış tavsiye vermemek için ayrı dal.
  detected_unusual_activity: {
    confidence: 'documented',
    text: 'ElevenLabs hesabını geçici olarak kısıtlamış (ücretsiz katmanda olağandışı kullanım / VPN-proxy). ' +
      'Yeni anahtar almak bunu ÇÖZMEZ — ücretli plana geçmen ya da ElevenLabs desteğine yazman gerekiyor.',
  },
  // ÖLÇÜLDÜ (ADP-902) — Eren'in gerçek anahtarıyla canlı `api.elevenlabs.io`
  // cevabından: `{"detail":{"code":"quota_exceeded","status":"quota_exceeded",
  // "message":"…quota of 5000. You have 2 credits remaining, while 11 credits
  // are required…"}}`. Sağlayıcı bu gövdeyi 401 VE 400 ile döndürebiliyor.
  quota_exceeded: {
    confidence: 'measured',
    text: 'ElevenLabs karakter kotan dolmuş. ElevenLabs → Usage’dan kalan kotana bak; ' +
      'kota yenilenene kadar bu motor konuşamaz (ücretsiz yerel ses çalışmaya devam eder).',
  },
});

/**
 * ADP-918 — sağlayıcı hata gövdesini oku. ASLA fırlatmaz.
 * ElevenLabs iki biçim döndürüyor: `{detail:{status,message}}` (ölçüldü) ve bazı
 * eski uçlarda `{detail:"düz metin"}`.
 * @returns {{status:string|null, message:string|null}}
 */
function parseProviderError(detail) {
  const raw = typeof detail === 'string' ? detail.trim() : '';
  if (!raw || raw[0] !== '{') return { status: null, message: null };
  let json;
  try { json = JSON.parse(raw); } catch { return { status: null, message: null }; }
  const d = json && json.detail;
  if (typeof d === 'string') return { status: null, message: d.slice(0, 200) };
  if (d && typeof d === 'object') {
    return {
      status: typeof d.status === 'string' ? d.status : null,
      message: typeof d.message === 'string' ? d.message.slice(0, 200) : null,
    };
  }
  return { status: null, message: null };
}

/**
 * ADP-918 — YETKİ hatasının kullanıcıya söylenecek hâli. `null` = bu HTTP durumu
 * için yönlendirici bir şey söyleyemiyoruz (çağıran eski metnini kullanır).
 *
 * Tanınmayan `status` sessizce yutulmaz: sağlayıcının kendi cümlesi aktarılır.
 * Böylece yarın ElevenLabs yeni bir sebep eklerse ekran yine BİR ŞEY söyler.
 * @returns {{status:string|null, providerMessage:string|null, text:string}|null}
 */
function elevenAuthHint(httpStatus, detail) {
  const { status, message } = parseProviderError(detail);
  // 🔴 ADP-902 — 401/403 KİLİDİ ÖLÇÜMLE ÇÜRÜDÜ. ADP-918 taksonomiyi bu iki koda
  // bağlamıştı; ÖLÇÜLDÜ (2026-08-07, gerçek uç, biçim-uyumlu SAHTE anahtar):
  //   HTTP 400 {"detail":{"code":"invalid_api_key","status":"invalid_api_key",
  //             "message":"API key is invalid.","param":"api_key"}}
  // AYNI arıza 400 ile de geliyor ve kapı `null` dönüp kullanıcıyı yine çıplak
  // koda ("api-400") mahkûm ediyordu — ADP-918'in düzelttiği şeyin birebir kardeşi.
  //
  // ⚖️ Ama "gövdeye bak, kodu yoksay" da YANLIŞ olurdu: ADP-918'in 429 nöbeti
  // haklı — hız sınırını "anahtarını yenile" diye okutmak, çözmeyeceği bir işe
  // yollamaktır. Ayrım şu: 401/403 TANIMI GEREĞİ yetkidir (bilinmeyen sebepte
  // bile yetki cümlesi kurulur); 400 ise genelde İSTEK BİÇİMİ hatasıdır, o yüzden
  // yalnız gövdesi BİLİNEN bir yetki/kota sebebi taşıyorsa yetki sayılır.
  const authByCode = httpStatus === 401 || httpStatus === 403;
  const knownAuthStatus = !!(status && Object.prototype.hasOwnProperty.call(ELEVEN_AUTH_HINTS, status));
  if (!authByCode && !(httpStatus === 400 && knownAuthStatus)) return null;
  const known = status && ELEVEN_AUTH_HINTS[status];
  if (known) return { status, providerMessage: message, text: known.text };
  const said = message ? ` Sağlayıcının kendi açıklaması: “${message}”.` : '';
  return {
    status: status || null,
    providerMessage: message,
    text: `ElevenLabs isteği yetki hatasıyla reddetti (HTTP ${httpStatus}).${said} ` +
      'Anahtarı ElevenLabs → Profile → API Keys’ten yeniden kopyalayıp Ayarlar → Ses → Erişim’e kaydet; ' +
      'anahtarın izinleri “Text to Speech” ve “Voices: read” içermeli.',
  };
}

// ── ADP-918 — YAPIŞTIRMA KAZALARI: "ağ hatası" kılığındaki anahtar hatası ─────
//
// ÖLÇÜLDÜ (ADP-918, Node fetch): anahtarın İÇİNDE satır sonu varsa
// `Headers.append: … is an invalid header value`, görünmez karakter (U+200B) varsa
// `Cannot convert argument to a ByteString` TypeError'ı fırlar. İkisi de bizim
// `catch`imize düşüp `fetch-failed` diye raporlanıyordu — yani anahtarını yanlış
// yapıştıran kullanıcı ekranda "ElevenLabs’a ulaşılamadı, internetini kontrol et"
// görüyordu. Yanlış yere bakması için tasarlanmış bir mesaj.
//
// Sanitasyon YALNIZ zararsız kabuğu soyar (tırnak / görünmez karakter); anahtarın
// kendisini ASLA kırpmaz, düzeltmeye ÇALIŞMAZ. Kalan bozukluk `bad-key-format` ile
// AÇIKÇA söylenir — sessizce ağ hatasına dönüşmez.
// (kaçış dizisiyle yazılı — kaynakta GÖRÜNMEZ karakter bulundurmak, sonraki
//  okuyucunun düzenlerken sessizce silmesine yol açar)
const INVISIBLE_CHARS_RE = /[\u200B-\u200D\u2060\uFEFF]/g;

/** Kopyala-yapıştır kabuğunu soy: dış boşluk, görünmez karakter, sarmalayan tırnak. */
function sanitizeApiKey(raw) {
  let k = String(raw == null ? '' : raw).replace(INVISIBLE_CHARS_RE, '').trim();
  // `.env` / JSON'dan kopyalanan anahtar tırnak İÇİNDE gelir — `trim()` bunu görmez.
  for (let i = 0; i < 3 && k.length >= 2; i += 1) {
    const a = k[0]; const b = k[k.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'") || (a === '`' && b === '`')) k = k.slice(1, -1).trim();
    else break;
  }
  return k;
}

/** HTTP başlığına konulabilir mi? (yazdırılabilir ASCII, boşluksuz) */
function isHeaderSafeKey(k) {
  return typeof k === 'string' && k.length > 0 && !/\s/.test(k) && !/[^\x20-\x7E]/.test(k);
}

const BAD_KEY_FORMAT_HINT =
  'Kayıtlı ElevenLabs anahtarında olmaması gereken karakterler var (satır sonu, boşluk ya da görünmez karakter) — ' +
  'bu yüzden istek hiç gönderilmedi. Anahtarı ElevenLabs → Profile → API Keys’ten TEK SATIR hâlinde kopyalayıp ' +
  'Ayarlar → Ses → Erişim’e yeniden yapıştır.';

/**
 * ElevenLabs → MP3 Buffer.
 * KAYNAK: https://elevenlabs.io/docs/api-reference/text-to-speech/convert
 * @returns {{ok:true, buf:Buffer, mime:string, engine:'elevenlabs', voice:string, model:string, ms:number}
 *          |{ok:false, reason:string, detail?:string, hint?:string, providerStatus?:string|null}}
 */
async function synthElevenLabs({ text, apiKey, voice, model, fetchImpl = fetch } = {}) {
  const clean = String(text == null ? '' : text).trim();
  if (!clean) return { ok: false, reason: 'empty-text' };
  const key = sanitizeApiKey(apiKey);
  if (!key) return { ok: false, reason: 'no-key' };
  if (!isHeaderSafeKey(key)) return { ok: false, reason: 'bad-key-format', hint: BAD_KEY_FORMAT_HINT };
  // 🔴 ADP-848-B: sabit varsayılan ses YOK. Kullanıcı listeden seçmediyse
  // seslendirmeyi AÇIKÇA reddet — rastgele/gömülü bir sese düşmek, faturası
  // kullanıcıya çıkan bir üründe "sessiz yanlış davranış"tır.
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
        // Türkçe'de en sık şikâyet "robotik düzlük": stability'i düşürmek tonlamayı
        // canlandırır, çok düşürmek telaffuzu bozar. 0.4 orta yol (sağlayıcının
        // kendi önerdiği aralık 0.3–0.5).
        voice_settings: { stability: 0.4, similarity_boost: 0.75 },
      }),
    });
  } catch (e) {
    return { ok: false, reason: 'fetch-failed', detail: String((e && e.message) || e) };
  }
  if (!res.ok) {
    const detail = await safeText(res);
    // ADP-918 — sebebi GÖVDEDEN oku ve TAŞI. `detail`i burada bırakmak, teşhisi
    // kullanıcının göremeyeceği bir alana gömmek demekti (şikâyetin ta kendisi).
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

// ── ADP-848-B — SES LİSTESİ: kullanıcının KENDİ hesabından ───────────────────
//
// KURAL: bu dosyada ElevenLabs ses id'si SABİT YAZILMAZ. Liste, kullanıcının
// anahtarıyla hesabından çekilir → varsayılan kütüphane sesleri + kullanıcının
// klonladığı/eklediği sesler, hepsi. Anahtar kimin ise sesler onun.
//
// TÜRKÇE ÖNCE (madde 6): Eren kararı KULAĞIYLA verecek; ekranda 60 sesin içinde
// Türkçe konuşabilen ses kaybolmamalı. Ama "hangi ses Türkçe konuşur" bilgisini
// KENDİMİZ UYDURMUYORUZ — sağlayıcının kendi meta verisinden okuyoruz:
//   • `verified_languages[].language === 'tr'`  → DOĞRULANMIŞ Türkçe (en güçlü sinyal)
//   • `fine_tuning.language === 'tr'`           → kullanıcının Türkçe klonu
//   • `labels.language` / `labels.accent`       → "turkish"/"türkçe" geçiyorsa
//   • `high_quality_base_model_ids` çok dilli bir model içeriyorsa → ÇOK DİLLİ
//     (Türkçe konuşabilir ama sağlayıcı Türkçe için doğrulamamış)
// Sabit ses-adı listesi yok: yarın ElevenLabs yeni bir Türkçe ses eklerse kodu
// değiştirmeden üste çıkar; sildiğinde de hayalet kayıt kalmaz.
const ELEVEN_API_BASE = 'https://api.elevenlabs.io';
const ELEVEN_VOICES_URL_V2 = `${ELEVEN_API_BASE}/v2/voices`;
const ELEVEN_VOICES_URL_V1 = `${ELEVEN_API_BASE}/v1/voices`;

// ── TEST DİKİŞİ: sağlayıcı adresini değiştirme (ÇOK DAR KAPILI) ──────────────
//
// Neden var: anahtarsız bir makinede "ses listesi doldu" karesini GERÇEK
// uygulamada almanın başka yolu yok — yerel bir ElevenLabs ikizine yönlendirmek
// gerekiyor. Neden tehlikeli: bu adres, kullanıcının API anahtarının GİTTİĞİ
// yerdir; zehirlenmiş bir ortam değişkeni anahtarı saldırgana yollayabilirdi.
//
// 🔴 Bu yüzden kapı, ADP-628'in kanıtlanmış kimlik-bilgisi kapısıyla AYNI
// sıkılıkta: (1) müşteri build'inde HİÇBİR koşulda açılmaz, (2) prod
// instance'ta açılmaz, (3) dev/test'te bile AÇIK OPT-IN bayrağı ister —
// "ortam değişkeninin kendisi taşıyıcı olamaz" (ADP-F1 kalıbı), (4) yalnız
// loopback adresleri kabul edilir (dışarıya yönlendirme imkânsız).
const TTS_BASE_OPT_IN = 'CREWPANE_ALLOW_TTS_BASE_OVERRIDE';
const TTS_BASE_OVERRIDE = 'CREWPANE_ELEVENLABS_BASE_URL';

/** Yalnız 127.0.0.1 / localhost / [::1] — başka bir hedef ASLA kabul edilmez. */
function isLoopbackUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname);
  } catch { return false; }
}

/**
 * Etkin ElevenLabs taban adresi. Varsayılan HER ZAMAN gerçek sağlayıcıdır.
 * @param {object} [env] - test dikişi (varsayılan process.env)
 */
function elevenApiBase(env = process.env, deps = {}) {
  const isCustomerBuild = deps.isCustomerBuild || (() => {
    try { return require('../config/buildChannel.cjs').isCustomerBuild(); } catch { return false; }
  });
  const instanceId = deps.instanceId || (() => {
    try { return require('../config/instancePaths.cjs').instanceId(); } catch { return 'prod'; }
  });
  if (isCustomerBuild()) return ELEVEN_API_BASE;
  const id = instanceId();
  if (id !== 'dev' && id !== 'test') return ELEVEN_API_BASE;
  if (String(env[TTS_BASE_OPT_IN] || '').trim() !== '1') return ELEVEN_API_BASE;
  const raw = String(env[TTS_BASE_OVERRIDE] || '').trim();
  if (!raw || !isLoopbackUrl(raw)) return ELEVEN_API_BASE;
  return raw.replace(/\/+$/, '');
}

/** Çok dilli (dolayısıyla Türkçe konuşabilen) model ailesi — id'de aranan parçalar. */
const MULTILINGUAL_MODEL_HINTS = Object.freeze(['multilingual', 'turbo_v2_5', 'flash_v2_5', 'v3']);

/** Türkçe uygunluk sırası: küçük = üstte. */
const TURKISH_RANK = Object.freeze({ verified: 0, multilingual: 1, unknown: 2 });

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
  // 🪤 BURADA DURUYORUZ. "Seçili model zaten çok dilli, o hâlde HER ses Türkçe
  // konuşabilir" demek teknik olarak doğru ama işe yaramaz: herkesi aynı etiketle
  // işaretleyen bir işaret hiçbir şeyi ayırt etmez ve liste yine 60 satır olur.
  // İşaret ancak AYIRT EDİYORSA kullanıcıya zaman kazandırır.
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
    // Kullanıcının listede ses seçerken bakacağı ipuçları (hepsi opsiyonel).
    accent: typeof labels.accent === 'string' ? labels.accent : null,
    gender: typeof labels.gender === 'string' ? labels.gender : null,
    age: typeof labels.age === 'string' ? labels.age : null,
    useCase: typeof labels.use_case === 'string' ? labels.use_case : null,
    description: typeof v.description === 'string' ? v.description.slice(0, 200) : null,
    // ElevenLabs'in kendi hazır örneği — bizim "Dinle"mizden AYRI (o gerçek
    // sentez yapar ve ücretlidir; bu bedava ama Türkçe DEĞİL, İngilizce örnek).
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
 * KAYNAK: https://elevenlabs.io/docs/api-reference/voices/search  (v2, sayfalı)
 *         v2 kullanılamıyorsa v1 `/v1/voices` (eski, tek seferde tümü).
 *
 * ASLA FIRLATMAZ. Dönüş her zaman ne olduğunu söyler (madde 7: sessiz boşluk yok).
 * @returns {{ok:true, voices:object[], counts:object, api:'v2'|'v1', ms:number}
 *          |{ok:false, reason:string, status?:number, detail?:string}}
 */
async function fetchElevenVoices({ apiKey, fetchImpl = fetch, model, pageSize = 100 } = {}) {
  // ADP-918 — anahtar sanitasyonu SENTEZ ile AYNI: iki yol aynı anahtarı okuyor,
  // biri kabuğu soyup diğeri soymazsa "liste doldu ama Dinle 401" gibi ayırt
  // edilmesi imkânsız bir çelişki doğar.
  const key = sanitizeApiKey(apiKey);
  if (!key) return { ok: false, reason: 'no-key' };
  if (!isHeaderSafeKey(key)) return { ok: false, reason: 'bad-key-format', hint: BAD_KEY_FORMAT_HINT };
  const t0 = Date.now();
  const base = elevenApiBase();
  const headers = { 'xi-api-key': key, Accept: 'application/json' };
  const size = Math.min(100, Math.max(1, Number(pageSize) || 100));

  // v2 sayfalı; hepsini topla (klonlanmış sesi olan hesaplarda 100'ü aşabilir).
  let api = 'v2';
  const rawVoices = [];
  let pageToken = null;
  let lastErr = null;
  for (let page = 0; page < 10; page += 1) { // üst sınır: sonsuz döngü yasak
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

  // v2 patladıysa (eski anahtar / uç kaldırıldı) v1'i dene — ama YETKİ hatasında
  // deneme: 401/403 anahtarın kendisiyle ilgilidir, ikinci uç da aynı cevabı verir.
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
  // Hesapta gerçekten ses yoksa bunu ARIZA gibi göstermeyelim ama SESSİZ de bırakmayalım.
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
 * Kullanıcıya gösterilecek Türkçe DURUM metni (madde 7: seçici sessizce boş kalmaz).
 * "Ne oldu" + "ne yapmalıyım" — ikisi bir arada, tek cümle.
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
  // ADP-918 — sağlayıcı gövdesinden ÖLÇÜLMÜŞ sebep varsa jenerik cümlenin YERİNE
  // geçer. Aynı metin "Dinle" tarafında da kullanılır (tek kaynak): kullanıcı iki
  // ekranda aynı arıza için iki farklı tavsiye okumasın.
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
 *
 * 🔒 KİLİTLİ KARAR (Eren, 2026-08-02): liste ÖNBELLEKLENMEZ, her açılışta TAZE
 * çekilir. Gerekçe: kullanıcı ElevenLabs'te yeni bir ses klonladığında onu
 * CrewPane'te anında görmeli — "yenile'ye basmayı bilmediği için sesi yok
 * sanmak" bu ekranın en olası hayal kırıklığı. Uç ÜCRETSİZ ve ~300 ms; kazanç
 * yok, sürpriz riski var. İleride "optimizasyon" diye önbellek eklenmesin.
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

/**
 * SSML'e gömülecek metni kaçır. 🔴 GÜVENLİK: kaçırmazsak kullanıcının cümlesindeki
 * `<` `&` SSML'i bozar (Azure 400 döner) ve teorik olarak SSML enjeksiyonu olur.
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

async function safeText(res) {
  try { return (await res.text()).slice(0, 300); } catch { return ''; }
}

/**
 * Bu modülün SAHİP OLDUĞU motorlar (say/openai jarvisVoice'ta kalır — orada
 * önbellek + oynatma zaten var; ikinci bir kopya yazmak regresyon üretirdi).
 */
const CLOUD_SYNTH = Object.freeze({ elevenlabs: synthElevenLabs, azure: synthAzure });

/**
 * Motoru ayarlardan çözüp SES BAYTLARINI üret (oynatma YOK — çağıran teslim eder).
 * Anahtar yok / çağrı patladı → { ok:false, reason, notice } döner; ÇAĞIRAN
 * ücretsiz motora düşer. Sessiz ölüm yok: `notice` metni oturumda bir kez dolar.
 *
 * 🔴 ADP-902 — `notify:false` ile ÇAĞIRAN "bu tur kullanıcıya görünmez" diyebilir.
 * ÖLÇÜLDÜ (gerçek uygulamada, iki turlu koşu): widget açılışta ACK cümlelerini
 * `play:false` ile ISITIYOR (JarvisWidget.preloadAck). ElevenLabs bozukken o
 * SESSİZ ısıtma turu, "oturumda bir kez" bildirimini TÜKETİYOR — kullanıcının
 * gerçek turunda `notice` artık `null` geliyor ve ekranda hiçbir şey çıkmıyordu.
 * Yani tek-seferlik bildirim, kimsenin duymadığı bir turda harcanıyordu.
 */
async function synthesizeCloud({ engine, text, settings, ctx = {}, fetchImpl = fetch, notify = true, noticeOnce = true } = {}) {
  const fn = CLOUD_SYNTH[engine];
  if (!fn) return { ok: false, reason: 'unsupported-engine' };
  const spec = TTS_PROVIDERS[engine];
  const gate = ctx.gate || credentialGate;
  const cred = gate.resolveCredential(spec.credential, ctx);
  // `notify:false` → bildirim ÜRETİLMEZ *ve* tek-seferlik jeton HARCANMAZ
  // (fallbackNotice hiç çağrılmaz — çağırmak, sırf `null` atmak için jetonu yakardı).
  // TTS-01 — `noticeOnce:false` = "bu tur kullanıcının AÇIK jesti" (önizleme):
  // metin her seferinde üretilir, jeton harcanmaz. Bkz. `_noticed` üstündeki not.
  const notice = (reason, opts) => (notify ? fallbackNotice(engine, reason, { once: noticeOnce, ...(opts || {}) }) : null);
  if (!cred.ok) {
    return { ok: false, reason: 'no-key', notice: notice('no-key'), settingsTarget: cred.settingsTarget || null };
  }
  const j = (settings && settings.jarvis) || {};
  // TTS-01 — SESİ, EKRANIN GÖSTERDİĞİ YERDEN OKU. Eskiden ham `j.azureVoice`
  // gidiyordu: ayarda tanınmayan bir ses varsa (elle düzenlenmiş dosya / eski
  // sürümden kalan değer) Ayarlar ekranı "Emel" yazarken istek Katja ile gidip
  // 400 alıyordu — ekran ile davranışın ayrıştığı, kullanıcının asla
  // çözemeyeceği bir arıza. Artık iki taraf da `pickVoiceFromSettings`i okur.
  // ElevenLabs'te davranış BİT-BİT AYNI (dinamik liste: ham değer geçer).
  const voice = pickVoiceFromSettings(spec, j);
  const res = engine === 'elevenlabs'
    ? await fn({ text, apiKey: cred.secret, voice, model: j.elevenModel, fetchImpl })
    : await fn({ text, apiKey: cred.secret, voice, region: j.azureRegion, fetchImpl });
  // ADP-918 — sağlayıcıdan gelen yönlendirici cümle bildirime TAŞINIR.
  if (!res.ok) return { ...res, notice: notice(res.reason, { hint: res.hint || null }) };
  return res;
}

// ── Renderer'a gidecek yapılandırma (SIR İÇERMEZ) ────────────────────────────
/**
 * Ayarlar ekranının tek veri kaynağı. Renderer fiyat/etiket/varsayılan HİÇBİR
 * ŞEYİ kendisi türetmez (ADP-827'deki grok.cost deseninin aynısı) — yani sayılar
 * tek yerde yaşar ve UI'daki kopyası sessizce bayatlayamaz.
 */
function ttsConfig(settings, ctx = {}) {
  const platform = ctx.platform || process.platform;
  const active = resolveTtsEngine(settings, { platform });
  const j = (settings && settings.jarvis) || {};
  const engines = TTS_ENGINE_IDS
    .filter((id) => isSupportedOn(id, platform))
    .map((id) => {
      const spec = TTS_PROVIDERS[id];
      // 🔴 TTS-01 — "BU MOTOR KONUŞMAYA HAZIR MI?" sorusunun TEK cevabı burada.
      // Anahtar VAR ama ses SEÇİLMEMİŞSE motor konuşamaz (ADP-848-B: varsayılan
      // ses YOK, çünkü fatura kullanıcının anahtarına işler). Eskiden UI bunu
      // hiç bilmiyordu: kullanıcı "Dinle"ye basıp arızaya çarparak öğreniyordu.
      // Kural motor ADINDAN değil KAYITTAN türer (`defaultVoice === null`), yani
      // yarın eklenen benzer bir motor tek satırla doğru davranır.
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
        // Bu motorun ŞU AN geçerli sesi ('' = hiç yok). SIR DEĞİL: yalnız ses id'si.
        selectedVoice,
        // Kullanıcıdan bir SEÇİM bekleniyor mu? (varsayılanı olmayan motor + boş seçim)
        needsVoice: spec.defaultVoice === null && !selectedVoice,
        cost: estimateCost(id),
      };
    });
  // ADP-874 — bu platformda ücretsiz yerel motor var mı? null = YOK. UI bu alanı
  // okuyup "ücretsiz seçeneğe düşülür" vaadini vermemeli; `freeEngineNotice`
  // kullanıcıya ne yapması gerektiğini tek cümlede söyler.
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
    // 🔴 Sabit varsayılan YOK (ADP-848-B): seçilmemişse BOŞ döner ve UI "listeden
    // bir ses seç" der. Kullanıcı adına ses seçmek = onun faturasına yazılan bir
    // kararı biz vermek.
    elevenVoiceId: typeof j.elevenVoiceId === 'string' && j.elevenVoiceId.trim() ? j.elevenVoiceId.trim() : '',
    // Seçili sesin adı ayarlarda saklanır: liste çekilemediğinde (anahtar
    // kaldırıldı, internet yok) ekranda ham id yerine "Rachel" yazsın.
    elevenVoiceName: typeof j.elevenVoiceName === 'string' && j.elevenVoiceName.trim() ? j.elevenVoiceName.trim() : '',
    azureRegion: typeof j.azureRegion === 'string' && j.azureRegion.trim() ? j.azureRegion.trim() : AZURE_DEFAULT_REGION,
    azureVoice: TTS_PROVIDERS.azure.voices.includes(j.azureVoice) ? j.azureVoice : TTS_PROVIDERS.azure.defaultVoice,
    engines,
  };
}

module.exports = {
  TTS_PROVIDERS,
  TTS_ENGINE_IDS,
  TTS_PREVIEW_TEXT_TR,
  PRICING,
  COST_ASSUMPTIONS,
  ELEVEN_MODELS,
  ELEVEN_DEFAULT_MODEL,
  AZURE_DEFAULT_REGION,
  ASSUMPTIONS,
  FREE_ENGINE,
  freeEngineFor,
  SHIPPED_DEFAULT_ENGINE,
  estimateCost,
  resolveTtsEngine,
  isSupportedOn,
  hasKeyFor,
  // TTS-01 — "bu motorun sesi seçilmiş mi?" (ttsConfig ve testler aynı yerden okur)
  pickVoiceFromSettings,
  fallbackNotice,
  resetNotices,
  escapeSsml,
  azureSsml,
  synthElevenLabs,
  synthAzure,
  synthesizeCloud,
  ttsConfig,
  // ADP-848-B — ses listesi (kullanıcının kendi hesabından; sabit liste YOK)
  fetchElevenVoices,
  listElevenVoices,
  elevenVoicesStatus,
  normalizeElevenVoice,
  classifyTurkish,
  sortVoicesTurkishFirst,
  ELEVEN_VOICES_URL_V1,
  ELEVEN_VOICES_URL_V2,
  ELEVEN_API_BASE,
  elevenApiBase,
  isLoopbackUrl,
  // ADP-918 — 401 teşhisi (çıplak "api-401" yerine yönlendirici cümle)
  ELEVEN_AUTH_HINTS,
  BAD_KEY_FORMAT_HINT,
  parseProviderError,
  elevenAuthHint,
  sanitizeApiKey,
  isHeaderSafeKey,
};
