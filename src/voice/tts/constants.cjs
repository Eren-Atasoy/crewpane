// CrewPane — TTS Provider constants, models, pricing, and error hints.
'use strict';

const TTS_PREVIEW_TEXT_TR =
  "Iğdır'dan İstanbul'a giden 8'inci uçakta, Gülşah'ın çiğ köftesi öğle üzeri şaşırtıcı bir üne kavuştu.";

const COST_ASSUMPTIONS = Object.freeze({
  charsPerReply: 120,   // Agent X yanıtı ~120 karakter (kısa, sesli asistan cevabı)
  repliesPerDay: 150,   // YOĞUN kullanıcı profili
  daysPerMonth: 30,
});

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
    voices: Object.freeze([]),
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
const FREE_ENGINE = 'say';
const SHIPPED_DEFAULT_ENGINE = 'openai';

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

const ASSUMPTIONS = Object.freeze([
  'ElevenLabs ses listesi kullanıcının anahtarıyla hesabından çekilir; Türkçe işareti sağlayıcının kendi meta verisinden (verified_languages / fine_tuning / labels) türer.',
  'Azure bölgesi varsayılan "westeurope"; kullanıcının aboneliği başka bölgedeyse Ayarlar\'dan değiştirilmeli.',
  'OpenAI ve Azure karakter fiyatları bilgi tabanından; UI\'da "≈" ile ve kaynak bağlantısıyla gösterilir.',
  'ElevenLabs hata gövdesindeki "needs_authorization" / "invalid_api_key" (ADP-918) ve "quota_exceeded" (ADP-902) durumları gerçek API çağrısıyla ölçüldü; "missing_permissions" / "detected_unusual_activity" sağlayıcı dokümanından alındı ve canlı anahtarla DOĞRULANMADI.',
]);

const ELEVEN_API_BASE = 'https://api.elevenlabs.io';
const ELEVEN_VOICES_URL_V2 = `${ELEVEN_API_BASE}/v2/voices`;
const ELEVEN_VOICES_URL_V1 = `${ELEVEN_API_BASE}/v1/voices`;

const TTS_BASE_OPT_IN = 'CREWPANE_ALLOW_TTS_BASE_OVERRIDE';
const TTS_BASE_OVERRIDE = 'CREWPANE_ELEVENLABS_BASE_URL';

const MULTILINGUAL_MODEL_HINTS = Object.freeze(['multilingual', 'turbo_v2_5', 'flash_v2_5', 'v3']);
const TURKISH_RANK = Object.freeze({ verified: 0, multilingual: 1, unknown: 2 });

const ELEVEN_AUTH_HINTS = Object.freeze({
  needs_authorization: {
    confidence: 'measured',
    text: 'ElevenLabs isteğinde API anahtarı HİÇ gitmemiş. Bu bir ürün hatası — anahtarını değiştirmek çözmez; ' +
      'lütfen bu ekranı bildir (Ayarlar → Ses → Erişim’de anahtarın kayıtlı göründüğünü de yaz).',
  },
  invalid_api_key: {
    confidence: 'measured',
    text: 'ElevenLabs anahtarı KABUL ETMEDİ: anahtar yanlış, silinmiş ya da başka bir hesaba ait. ' +
      'ElevenLabs → Profile → API Keys’ten anahtarı yeniden oluştur, TAMAMINI kopyala ' +
      '(başında/sonunda boşluk ya da tırnak kalmasın) ve Ayarlar → Ses → Erişim’e yapıştırıp kaydet.',
  },
  missing_permissions: {
    confidence: 'documented',
    text: 'Anahtar geçerli ama bu işlem için İZNİ yok. ElevenLabs → API Keys → anahtarını düzenle: ' +
      '“Text to Speech” ve “Voices: read” izinleri açık olmalı (ya da “Has access to all” seç), sonra tekrar dene.',
  },
  detected_unusual_activity: {
    confidence: 'documented',
    text: 'ElevenLabs hesabını geçici olarak kısıtlamış (ücretsiz katmanda olağandışı kullanım / VPN-proxy). ' +
      'Yeni anahtar almak bunu ÇÖZMEZ — ücretli plana geçmen ya da ElevenLabs desteğine yazman gerekiyor.',
  },
  quota_exceeded: {
    confidence: 'measured',
    text: 'ElevenLabs karakter kotan dolmuş. ElevenLabs → Usage’dan kalan kotana bak; ' +
      'kota yenilenene kadar bu motor konuşamaz (ücretsiz yerel ses çalışmaya devam eder).',
  },
});

const BAD_KEY_FORMAT_HINT =
  'Kayıtlı ElevenLabs anahtarında olmaması gereken karakterler var (satır sonu, boşluk ya da görünmez karakter) — ' +
  'bu yüzden istek hiç gönderilmedi. Anahtarı ElevenLabs → Profile → API Keys’ten TEK SATIR hâlinde kopyalayıp ' +
  'Ayarlar → Ses → Erişim’e yeniden yapıştır.';

module.exports = {
  TTS_PREVIEW_TEXT_TR,
  COST_ASSUMPTIONS,
  PRICING,
  TTS_PROVIDERS,
  TTS_ENGINE_IDS,
  FREE_ENGINE,
  SHIPPED_DEFAULT_ENGINE,
  ELEVEN_MODELS,
  ELEVEN_DEFAULT_MODEL,
  AZURE_DEFAULT_REGION,
  ASSUMPTIONS,
  ELEVEN_API_BASE,
  ELEVEN_VOICES_URL_V2,
  ELEVEN_VOICES_URL_V1,
  TTS_BASE_OPT_IN,
  TTS_BASE_OVERRIDE,
  MULTILINGUAL_MODEL_HINTS,
  TURKISH_RANK,
  ELEVEN_AUTH_HINTS,
  BAD_KEY_FORMAT_HINT,
};
