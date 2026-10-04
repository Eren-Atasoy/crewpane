// ADP-827 (FAZ 7) — GROK VOICE: ücretli, gerçek-zamanlı ses SEÇENEĞİ.
//
// Eren'in kararı (2026-07-31): "Yerel ücretsiz yol VARSAYILAN kalsın AMA Grok Voice
// da SEÇENEK olarak eklensin." Bu dosya o seçeneğin main-process ayağıdır.
//
// ── NEDEN MAIN'DE (renderer'da değil) ────────────────────────────────────────
// xAI anahtarı ADP-628 kapısından (requireCredential) çözülür ve RENDERER'A ASLA
// GEÇMEZ. WebSocket'i main açar, renderer yalnız ses baytı gönderir / olay alır.
// (xAI "ephemeral token" da öneriyor — istemci tarafı için; ama o REST ucu bugün
// anahtarsız DOĞRULANAMADI, bu yüzden v1'de anahtar main'de kalıyor. Bkz. §VARSAYIM.)
//
// ── MİMARİ: "kulak + ağız", BEYİN BİZDE ──────────────────────────────────────
// ADP-827 §2: "Ses döngüsünün STT+TTS+konuşma katmanını değiştirir; EYLEM katmanı
// (karar → delegasyon/araç) AYNI kalır." Bunun protokoldeki karşılığı:
//
//   kullanıcı sesi ─► input_audio_buffer.append ─► xAI
//   xAI ─► conversation.item.input_audio_transcription.updated ─► TRANSKRİPT
//   TRANSKRİPT ─► ADP-815'in beyni (jarvis:think) ─► executeDecision   ← DEĞİŞMEZ
//   bizim cevabımız ─► `force_message` ─► xAI TTS ─► kullanıcı kulağı
//
// `force_message` xAI'a ÖZGÜ bir uzantıdır (OpenAI Realtime'da YOKTUR): modeli hiç
// çalıştırmadan, verdiğimiz metni seslendirir. Yani Grok modelinin kendisi KARAR
// VERMEZ — yalnız duyar ve konuşur. Beyin ADP-815'te kaldığı yerde kalır.
//
// ── "OpenAI kalıbını körlemesine taklit etme" (CNVS dersi) — ÖLÇÜLEN GERÇEK ───
// xAI kendi dokümanında Voice Agent API'sini "OpenAI Realtime API ile UYUMLU" diye
// tanımlıyor VE farkları tek tek sayıyor. Yani tehlike "protokol bambaşka" değil;
// tehlike SESSİZ FARKLAR. Bugün (2026-08-01) dokümandan ölçülen üç sınıf:
//
//   1. YENİDEN ADLANDIRILAN + ANLAMI DEĞİŞEN olay:
//      OpenAI `conversation.item.input_audio_transcription.delta` (ARTIMLI)
//      xAI    `conversation.item.input_audio_transcription.updated` (KÜMÜLATİF)
//      → OpenAI kalıbını kopyalayan kod parçaları BİRLEŞTİRİR: "merhaba" +
//        "merhaba nasılsın" = "merhabamerhaba nasılsın". Derleme hatası vermez,
//        test yazmayan fark eder. Bu yüzden reducer'da KÜMÜLATİF olarak işlenir
//        ve `grokVoice.test.cjs` bunu ayrıca ölçer.
//   2. DESTEKLENMEYENLER: `conversation.item.retrieve`,
//      `conversation.item.input_audio_transcription.segment`, `rate_limits.updated`.
//   3. xAI-ÖZEL UZANTILAR: `force_message` (bkz. yukarı), `resumption` (kopma
//      sonrası konuşma önbelleği), `replace` (telaffuz eşlemesi).
//
// Kaynak: https://docs.x.ai/developers/model-capabilities/audio/voice-agent
//         https://docs.x.ai/docs/guides/voice  (erişim: 2026-08-01)
//
// ── DÜRÜSTLÜK KURALI ─────────────────────────────────────────────────────────
// Dokümanda AÇIKÇA yazmayan her alan `GROK_ASSUMPTIONS` listesinde durur ve rapora
// "Eren anahtar girince koşulacak kabul listesi" olarak çıkar. Uydurulmuş bir alanı
// yorumsuz yazmak, yanlış yazmaktan kötüdür: sessizce çalışmaz.
//
// Saf + DI: `electron` require'ı YOK, WebSocket enjekte edilir → `node --test`.

'use strict';

const credentialGate = require('../security/requireCredential.cjs');
// ADP-885 Faz B — SES DİLİ tek noktadan çözülür (ADR-VOICE-LOCALE §2).
// `electron` require'ı DEĞİL: saf modül, `node --test` altında da yüklenir.
const appI18n = require('../../i18n/index.cjs');

// ── Uç nokta + modeller ──────────────────────────────────────────────────────

/** KAYNAK: docs.x.ai — Speech to Speech (Voice Agent) WebSocket ucu. */
const GROK_WS_URL = 'wss://api.x.ai/v1/realtime';

/**
 * ÖLÇÜLEN FİYATLAR — 2026-08-01, xAI'ın KENDİ fiyat sayfasından iki kez okundu
 * (docs.x.ai/docs/pricing + docs.x.ai/docs/models, aynı sayılar).
 *
 * 🔴 ALIAS TUZAĞI: `grok-voice-latest` 2026-08-05'te 2.0'a geçiyor (xAI'ın kendi
 * duyurusu). Alias'ı pinlersek kullanıcının dakika ücreti 0.05 → 0.08 USD'ye,
 * yani %60, HABERSİZ çıkar. Bu yüzden varsayılanımız alias DEĞİL, AÇIK sürümdür.
 * "Dürüst maliyet bildirimi" (ADP-827 §3) ancak fiyatı sabitleyen bir model
 * seçimiyle mümkündür.
 */
const GROK_MODELS = Object.freeze({
  'grok-voice-think-fast-1.0': Object.freeze({
    id: 'grok-voice-think-fast-1.0',
    label: 'Grok Voice 1.0',
    usdPerMinute: 0.05,
    usdPerHour: 3.0,
    usdPerTextInputMTok: 0.004, // "$0.004 / text input" (metin girdi kalemi)
  }),
  'grok-voice-think-fast-2.0': Object.freeze({
    id: 'grok-voice-think-fast-2.0',
    label: 'Grok Voice 2.0',
    usdPerMinute: 0.08,
    usdPerHour: 4.8,
    usdPerTextInputMTok: 0.004,
  }),
});

const GROK_PRICING_SOURCE = Object.freeze({
  urls: Object.freeze([
    'https://docs.x.ai/docs/pricing',
    'https://docs.x.ai/docs/models',
  ]),
  measuredAt: '2026-08-01',
  aliasFlipsAt: '2026-08-05', // grok-voice-latest → 2.0
});

/** Varsayılan: EN UCUZ ve fiyatı SABİT olan açık sürüm (alias değil — bkz. tuzak). */
const GROK_DEFAULT_MODEL = 'grok-voice-think-fast-1.0';

/** KAYNAK: docs.x.ai — yerleşik sesler (custom voice id'leri de kabul edilir). */
const GROK_VOICES = Object.freeze(['eve', 'ara', 'rex', 'sal', 'leo']);
const GROK_DEFAULT_VOICE = 'eve';

/**
 * Giriş 16 kHz: ADP-818'in ZATEN AÇIK olan uyandırma mikrofonu 16 kHz mono Float32
 * üretiyor (wakeWord.ts WAKE_SR). İkinci bir mikrofon akışı açmamak için aynı akışı
 * kullanıyoruz; 16000 xAI'ın desteklediği `audio/pcm` hızlarından biri (8000, 16000,
 * 22050, 24000, 32000, 44100, 48000). Çıkış 24 kHz = xAI varsayılanı.
 */
const GROK_INPUT_RATE = 16000;
const GROK_OUTPUT_RATE = 24000;
const GROK_PCM_FORMAT = 'audio/pcm';

// ── Ses modu (ücretsiz yerel yol ↔ ücretli Grok yolu) ────────────────────────

const VOICE_MODE_LOCAL = 'local';
const VOICE_MODE_GROK = 'grok';
const VOICE_MODES = Object.freeze([VOICE_MODE_LOCAL, VOICE_MODE_GROK]);

/**
 * Ayarlardaki değeri moda çevirir.
 *
 * 🔴 FAIL-SAFE YÖNÜ: TANINMAYAN/BOZUK her değer ÜCRETSİZ yola düşer. Ters yön
 * (bilinmeyen → grok) bir ayar dosyası hatasının kullanıcıya FATURA çıkarması
 * demekti. ADP-628'in ruhu: para harcayan dal ancak AÇIK bir seçimle açılır.
 *
 * ADP-812 dersi (defaults()'ta değer SABİTLEME) burada da geçerli: settings.json'da
 * `voiceMode: null` durur, gerçek varsayılan BU fonksiyondadır.
 */
function resolveVoiceMode(settings) {
  const raw = settings && settings.jarvis ? settings.jarvis.voiceMode : null;
  return raw === VOICE_MODE_GROK ? VOICE_MODE_GROK : VOICE_MODE_LOCAL;
}

/** Ayarlardaki model; tanınmıyorsa varsayılan (alias'a ASLA düşmez). */
function resolveGrokModel(settings) {
  const raw = settings && settings.jarvis ? settings.jarvis.grokModel : null;
  return typeof raw === 'string' && Object.prototype.hasOwnProperty.call(GROK_MODELS, raw)
    ? raw
    : GROK_DEFAULT_MODEL;
}

function resolveGrokVoice(settings) {
  const raw = settings && settings.jarvis ? settings.jarvis.grokVoice : null;
  return typeof raw === 'string' && GROK_VOICES.includes(raw) ? raw : GROK_DEFAULT_VOICE;
}

/** Anahtar VAR mı — sır DÖNMEZ (UI rozeti + "gri seçenek" kararı buradan). */
function hasGrokKey(ctx) {
  return credentialGate.hasCredential('xai', ctx || {});
}

/** Anahtar yokken gösterilecek tek cümle (kapının kendi metni). */
function grokKeyMissingMessage() {
  return credentialGate.missingMessageFor('xai');
}

function grokKeySettingsTarget() {
  return credentialGate.settingsTargetFor('xai');
}

/**
 * Dakika maliyeti metni — ADP-827 §3 "dürüst maliyet bildirimi".
 * Sayı KODA GÖMÜLÜ DEĞİL, `GROK_MODELS`ten gelir; kaynak + ölçüm tarihi de birlikte
 * döner ki UI "nereden biliyorsun" sorusunu cevaplayabilsin.
 */
function grokCostNotice(modelId) {
  const m = GROK_MODELS[modelId] || GROK_MODELS[GROK_DEFAULT_MODEL];
  return {
    model: m.id,
    label: m.label,
    usdPerMinute: m.usdPerMinute,
    usdPerHour: m.usdPerHour,
    measuredAt: GROK_PRICING_SOURCE.measuredAt,
    sourceUrl: GROK_PRICING_SOURCE.urls[0],
    text:
      `Grok Voice ÜCRETLİDİR: ${m.label} için dakikası ${m.usdPerMinute.toFixed(2)} USD `
      + `(saati ${m.usdPerHour.toFixed(2)} USD). Ücret xAI tarafından SENİN anahtarına `
      + `işlenir. Fiyat ${GROK_PRICING_SOURCE.measuredAt} tarihinde xAI'ın resmî fiyat `
      + 'sayfasından ölçüldü — değişmiş olabilir.',
  };
}

/** Konuşulan saniye → USD (sadece ses kalemi; metin girdi kalemi ayrı ve küçüktür). */
function grokCostEstimateUsd(seconds, modelId) {
  const m = GROK_MODELS[modelId] || GROK_MODELS[GROK_DEFAULT_MODEL];
  const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  return (s / 60) * m.usdPerMinute;
}

// ── Protokol: istemci olayları (saf üreticiler) ──────────────────────────────

/**
 * `session.update` — oturumun TEK yapılandırma noktası.
 *
 * `brainOwned: true` (varsayılan) = kararı BİZ veririz:
 *   • `instructions` modele "kendi başına cevap verme" der (savunmanın YÜZEYİ),
 *   • ama gerçek garanti şudur: `response.create` HİÇ göndermeyiz ve model kendi
 *     başına bir yanıt açarsa `response.cancel` ile keseriz (bkz. reduceGrokEvent).
 *   Metin garantisi promptla DEĞİL, kapıyla sağlanır (ADP-322 dersi).
 */
function buildSessionUpdate(opts = {}) {
  const model = GROK_MODELS[opts.model] ? opts.model : GROK_DEFAULT_MODEL;
  const voice = GROK_VOICES.includes(opts.voice) ? opts.voice : GROK_DEFAULT_VOICE;
  const brainOwned = opts.brainOwned !== false;
  const session = {
    voice,
    instructions: brainOwned ? BRAIN_OWNED_INSTRUCTIONS : (opts.instructions || ''),
    // KAYNAK: docs.x.ai — audio.input/output.format.{type,rate}
    audio: {
      input: {
        format: { type: GROK_PCM_FORMAT, rate: opts.inputRate || GROK_INPUT_RATE },
        // KAYNAK: docs.x.ai — BCP-47 dil ipucu ASR'ı yanlı hâle getirir.
        // Türkçe desteklenen 20+ dil listesinde AÇIKÇA var.
        // ADP-885 Faz B — SABİT 'tr' KALDIRILDI (ADR-VOICE-LOCALE §6). İpuçsuz
        // çağrıda da ikinci bir dil kuralı YAZILMAZ: tek çözücüye sorulur.
        transcription: { language_hint: opts.languageHint || appI18n.voiceLocale() },
      },
      output: {
        format: { type: GROK_PCM_FORMAT, rate: opts.outputRate || GROK_OUTPUT_RATE },
      },
    },
    // KAYNAK: docs.x.ai — 'server_vad' | null (null = elle commit).
    turn_detection:
      opts.turnDetection === 'manual'
        ? null
        : {
            type: 'server_vad',
            // KAYNAK: docs.x.ai VAD ayarları — threshold 0.1–0.9 (vars. 0.85),
            // silence_duration_ms 0–10000, prefix_padding_ms 0–10000 (vars. 333).
            ...(Number.isFinite(opts.silenceMs) ? { silence_duration_ms: opts.silenceMs } : {}),
          },
    // Modele araç VERMİYORUZ: araçlar bizim tarafımızda (executeDecision).
    tools: [],
  };
  return { type: 'session.update', session, __model: model };
}

const BRAIN_OWNED_INSTRUCTIONS =
  'Sen yalnız bir SES ARAYÜZÜSÜN. Kullanıcıyı dinle ve sustuğunda BEKLE. '
  + 'Kendi başına cevap üretme, soru sorma, yorum yapma. Cevabı sana ayrıca '
  + 'söyleteceğim. Hiçbir koşulda kendiliğinden konuşma.';

/**
 * Ses parçası. KAYNAK: docs.x.ai olay adını (`input_audio_buffer.append`) ve
 * "base64 JSON ya da ikili" taşımayı belgeliyor; ALAN ADI (`audio`) dokümandan
 * doğrulanamadı → OpenAI-uyumluluk beyanına dayanıyor (VARSAYIM A2).
 */
function buildAudioAppend(base64) {
  return { type: 'input_audio_buffer.append', audio: String(base64 || '') };
}

/** Elle tur modunda turu kapatır (server_vad açıkken gerekmez). */
function buildAudioCommit() {
  return { type: 'input_audio_buffer.commit' };
}

/** Söz kesildiğinde yolda kalan sesi ATAR (barge-in'in ikinci yarısı). */
function buildAudioClear() {
  return { type: 'input_audio_buffer.clear' };
}

/**
 * xAI-ÖZEL: modeli hiç çalıştırmadan verilen metni seslendirir.
 * Beynin ADP-815'te kalmasını mümkün kılan alan budur.
 * VARSAYIM A3: sarmalayıcı olayın tam şekli dokümanda örneklenmedi; `conversation.
 * item.create` içinde `force_message` öğesi olarak gönderiyoruz.
 */
function buildForceMessage(text) {
  return {
    type: 'conversation.item.create',
    item: { type: 'force_message', text: String(text == null ? '' : text) },
  };
}

/** Yanıtı kes. VARSAYIM A4: xAI'ın DESTEKLENMEYENLER listesinde YOK, yani var sayıyoruz. */
function buildResponseCancel() {
  return { type: 'response.cancel' };
}

// ── Protokol: sunucu olayları (saf indirgeyici) ──────────────────────────────

/** Sıfır durum. `transcript` KÜMÜLATİF tutulur (xAI'ın semantiği — §1 tuzağı). */
function initialGrokState() {
  return {
    connected: false,
    sessionId: null,
    conversationId: null,
    /** Kullanıcının o ANA KADARKİ tam transkripti (kümülatif, birleştirilmez). */
    transcript: '',
    /** Model kendi başına bir yanıt açtı mı (brainOwned'da kesilmesi gerekir). */
    pendingResponseId: null,
    /** Oynatılacak base64 PCM parçaları — çağıran tüketip temizler. */
    audioChunks: [],
    lastError: null,
    /** Kaç kez model kendiliğinden konuşmaya kalktı (kanıt sayacı). */
    cancelledResponses: 0,
  };
}

/**
 * Tek sunucu olayı → { state, effects }. SAF: soket/zaman/IO yok.
 * `effects` çağıranın YAPMASI gereken şeyler: gönderilecek istemci olayları +
 * dışarı bildirilecek anlamlı olaylar (transkript güncellendi, ses geldi…).
 */
function reduceGrokEvent(state, event, opts = {}) {
  const brainOwned = opts.brainOwned !== false;
  const s = { ...state, audioChunks: state.audioChunks };
  const effects = { send: [], emit: [] };
  const type = event && typeof event.type === 'string' ? event.type : '';

  switch (type) {
    case 'session.created':
      s.connected = true;
      s.sessionId = (event.session && event.session.id) || event.session_id || null;
      effects.emit.push({ type: 'ready' });
      break;

    case 'session.updated':
      effects.emit.push({ type: 'configured' });
      break;

    case 'conversation.created':
      // `id` kopma sonrası `?conversation_id=` ile devam ettirmeye yarar (resumption).
      s.conversationId = (event.conversation && event.conversation.id) || event.id || null;
      break;

    // 🔴 §1 TUZAĞI — OpenAI'da `.delta` ARTIMLI, xAI'da `.updated` KÜMÜLATİF.
    // Burada ASLA birleştirme yapılmaz; gelen değer transkriptin TAMAMIDIR.
    case 'conversation.item.input_audio_transcription.updated': {
      const t = typeof event.transcript === 'string' ? event.transcript : '';
      s.transcript = t;
      effects.emit.push({ type: 'transcript', text: t, final: false });
      break;
    }

    case 'conversation.item.input_audio_transcription.completed': {
      const t = typeof event.transcript === 'string' ? event.transcript : s.transcript;
      s.transcript = t;
      effects.emit.push({ type: 'transcript', text: t, final: true });
      break;
    }

    case 'response.created': {
      const id = (event.response && event.response.id) || null;
      s.pendingResponseId = id;
      if (brainOwned) {
        // Model kendiliğinden konuşmaya kalktı → KES. Prompt bir kapı değildir;
        // kapı budur. (force_message ile söylettiğimiz metin bu daldan geçmez.)
        s.cancelledResponses += 1;
        effects.send.push(buildResponseCancel());
        effects.emit.push({ type: 'model-response-cancelled', responseId: id });
      }
      break;
    }

    case 'response.output_audio.delta': {
      const b64 = typeof event.delta === 'string' ? event.delta : '';
      if (b64) {
        s.audioChunks = state.audioChunks.concat(b64);
        effects.emit.push({ type: 'audio', base64: b64, rate: GROK_OUTPUT_RATE });
      }
      break;
    }

    case 'response.done':
      s.pendingResponseId = null;
      effects.emit.push({ type: 'response-done' });
      break;

    case 'error': {
      const err = event.error || {};
      s.lastError = { code: err.code || null, message: err.message || 'bilinmeyen hata' };
      effects.emit.push({ type: 'error', error: s.lastError });
      break;
    }

    default:
      // Tanınmayan olay SESSİZCE yutulmaz — teşhis için dışarı bildirilir, ama
      // durumu değiştirmez (xAI yeni olay eklediğinde oturum çökmesin).
      if (type) effects.emit.push({ type: 'unhandled', event: type });
      break;
  }

  return { state: s, effects };
}

// ── DOKÜMANDAN DOĞRULANAMAYAN VARSAYIMLAR ───────────────────────────────────
// Bunlar rapordaki "Eren anahtar girince koşulacak kabul listesi"nin ta kendisidir.
// Her varsayımın (a) neye dayandığı ve (b) NASIL doğrulanacağı yazılıdır. Bir madde
// eklenirse `grokVoice.test.cjs` her maddede `verify` alanı olduğunu ölçer.
const GROK_ASSUMPTIONS = Object.freeze([
  Object.freeze({
    id: 'A1',
    what: 'Kimlik doğrulama `Authorization: Bearer <XAI_API_KEY>` başlığıyla, WebSocket el sıkışmasında.',
    basis: 'docs.x.ai açıkça yazıyor — ama Node WebSocket istemcisinde özel başlık geçirme yolu ortama bağlı.',
    verify: 'Anahtarla bağlan; `session.created` gelirse doğru. 401/403 gelirse başlık taşınmıyor demektir.',
  }),
  Object.freeze({
    id: 'A2',
    what: '`input_audio_buffer.append` olayında base64 sesin alan adı `audio`.',
    basis: 'Doküman olay adını ve base64 taşımayı yazıyor, ALAN ADINI örneklemiyor; OpenAI uyumluluk beyanına dayanıyor.',
    verify: 'Konuş; `conversation.item.input_audio_transcription.updated` boş DEĞİL gelirse alan doğru. Hiç transkript gelmiyorsa alan adı yanlıştır.',
  }),
  Object.freeze({
    id: 'A3',
    what: '`force_message` sarmalayıcısı `conversation.item.create` + `item.type:"force_message"` + `item.text`.',
    basis: 'Doküman `force_message`i xAI uzantısı olarak SAYIYOR ama tam JSON şeklini örneklemiyor.',
    verify: 'Bizim cevabımızı gönder; kullanıcı O METNİ duyarsa doğru. `error` dönerse şekil yanlıştır → dokümanın örneğine bak.',
  }),
  Object.freeze({
    id: 'A4',
    what: '`response.cancel` destekleniyor.',
    basis: 'xAI\'ın "desteklenmeyenler" listesinde YOK (retrieve / transcription.segment / rate_limits.updated var).',
    verify: 'Model kendiliğinden konuşmaya kalktığında kesiliyor mu — `cancelledResponses` artarken ses GELMEMELİ.',
  }),
  Object.freeze({
    id: 'A5',
    what: '`server_vad` açıkken model tur sonunda KENDİLİĞİNDEN yanıt üretir (biz `response.create` göndermesek de).',
    basis: 'Doküman `create_response` benzeri bir kapatma anahtarı BELGELEMİYOR; OpenAI\'da varsayılan üretmektir.',
    verify: 'Konuş ve sus. `response.created` geliyorsa varsayım doğru → iptal dalı gerekli. Gelmiyorsa `turnDetection:"manual"` daha ucuz.',
  }),
  Object.freeze({
    id: 'A6',
    what: 'Çıkış sesi 24 kHz mono, 16-bit little-endian PCM (`audio/pcm`).',
    basis: 'Doküman codec + hız listesini veriyor; bit derinliği "Linear16" ifadesinden türetildi.',
    verify: 'Gelen baytları 24k/16-bit olarak çal — ses NORMAL hızda ve tiz/pes bozulmadan duyulmalı.',
  }),
]);

// ── Oturum (WebSocket enjekte edilir) ────────────────────────────────────────

/**
 * Canlı Grok Voice oturumu.
 *
 * @param {object} opts
 * @param {new (url:string, opts?:object)=>any} [opts.WebSocketImpl] - test dikişi (vars. global WebSocket)
 * @param {string} [opts.url] - test dikişi (mock sunucu adresi)
 * @param {string} [opts.apiKey] - verilmezse ADP-628 kapısından çözülür
 * @param {object} [opts.settings] - model/ses/mod seçimi
 * @param {(evt:object)=>void} [opts.onEvent] - dışarı bildirilen anlamlı olaylar
 * @param {(line:string)=>void} [opts.log] - SIR ASLA GEÇMEZ
 */
function createGrokSession(opts = {}) {
  const log = opts.log || (() => {});
  const WS = opts.WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
  const brainOwned = opts.brainOwned !== false;
  const model = opts.model || resolveGrokModel(opts.settings);
  const voice = opts.voice || resolveGrokVoice(opts.settings);
  // ADP-885 Faz B (ADR-VOICE-LOCALE) — STT DİL İPUCU ARTIK ÇİVİLİ DEĞİL.
  // Eskiden `buildSessionUpdate` her oturumda 'tr' gönderiyordu ve arayüz
  // İngilizceye çevrilse bile mikrofon Türkçe dinliyordu. Karar TEK yerde
  // çözülür (appI18n.voiceLocale): kullanıcı ses dilini seçmediyse ARAYÜZ dili,
  // seçtiyse onun seçtiği dil. Burada ikinci bir kural YOK.
  const languageHint = opts.languageHint || appI18n.voiceLocale(opts.settings);

  let ws = null;
  let state = initialGrokState();
  let openedAt = null;
  let closedAt = null;

  function emit(evt) {
    try { opts.onEvent && opts.onEvent(evt); } catch { /* dinleyici hatası oturumu düşürmez */ }
  }

  function sendRaw(obj) {
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(obj));
    return true;
  }

  function handleServerMessage(raw) {
    let event = null;
    try {
      event = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      emit({ type: 'error', error: { code: 'bad-json', message: 'sunucudan JSON olmayan mesaj' } });
      return;
    }
    const r = reduceGrokEvent(state, event, { brainOwned });
    state = r.state;
    for (const out of r.effects.send) sendRaw(out);
    for (const e of r.effects.emit) emit(e);
  }

  return {
    /** Bağlan + `session.update` gönder. `session.created` gelince çözülür. */
    async connect() {
      if (!WS) throw new Error('WebSocket yok (Node 22+ / Electron 42+ gerekir)');
      // 🔒 Anahtar BURADA çözülür ve BURADAN çıkmaz: log'a, hata metnine, renderer'a
      // gitmez. Yoksa ADP-628 kapısının kendi hatası fırlar (sessiz başarısızlık yok).
      const apiKey = opts.apiKey || credentialGate.requireCredential('xai');
      const url = opts.url || `${GROK_WS_URL}?model=${encodeURIComponent(model)}`;
      // VARSAYIM A1 — başlık taşıma. Node/Electron `WebSocket` yapıcısı ikinci
      // argümanı yok sayabilir; mock sunucu bunu ölçer, canlı uç kabul listesinde.
      ws = new WS(url, { headers: { Authorization: `Bearer ${apiKey}` } });
      openedAt = null;
      closedAt = null;
      state = initialGrokState();

      return await new Promise((resolve, reject) => {
        let settled = false;
        const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

        ws.onerror = () => done(reject, new Error('grok: WebSocket hatası'));
        ws.onclose = (ev) => {
          closedAt = Date.now();
          emit({ type: 'closed', code: ev && ev.code, reason: (ev && ev.reason) || null });
          done(reject, new Error(`grok: bağlantı kapandı (${(ev && ev.code) || '?'})`));
        };
        ws.onmessage = (ev) => {
          handleServerMessage(ev && ev.data);
          if (state.connected && !settled) {
            openedAt = Date.now();
            done(resolve, { model, voice, sessionId: state.sessionId });
          }
        };
        ws.onopen = () => {
          const upd = buildSessionUpdate({
            model, voice, brainOwned,
            silenceMs: opts.silenceMs,
            turnDetection: opts.turnDetection,
            languageHint, // ADP-885 Faz B — çözülmüş ses dili (arayüzü izler ya da açık seçim)
          });
          delete upd.__model;
          sendRaw(upd);
          log(`grok: oturum açıldı model=${model} voice=${voice}`); // sır YOK
        };
      });
    },

    /** 16 kHz mono PCM16 base64 parçası gönder. */
    appendAudio(base64) { return sendRaw(buildAudioAppend(base64)); },
    commitAudio() { return sendRaw(buildAudioCommit()); },

    /** Barge-in: yolda kalan sesi at + modelin yanıtını kes. */
    interrupt() {
      const a = sendRaw(buildResponseCancel());
      const b = sendRaw(buildAudioClear());
      return a || b;
    },

    /** BİZİM cevabımızı söylet (beyin bizde — modele karar verdirtmeyiz). */
    say(text) { return sendRaw(buildForceMessage(text)); },

    /** Oynatılacak ses parçalarını al ve kuyruğu boşalt. */
    drainAudio() {
      const out = state.audioChunks;
      state = { ...state, audioChunks: [] };
      return out;
    },

    snapshot() { return { ...state, audioChunks: state.audioChunks.length }; },

    /** Oturum SÜRESİ = FATURA. Kapanınca dakika/USD hesabı buradan çıkar. */
    usage() {
      const end = closedAt || Date.now();
      const seconds = openedAt ? Math.max(0, (end - openedAt) / 1000) : 0;
      return { seconds, model, usd: grokCostEstimateUsd(seconds, model) };
    },

    close() {
      try { ws && ws.close(); } catch { /* zaten kapalı */ }
      closedAt = Date.now();
      ws = null;
    },
  };
}

module.exports = {
  // uç nokta + katalog
  GROK_WS_URL, GROK_MODELS, GROK_DEFAULT_MODEL, GROK_VOICES, GROK_DEFAULT_VOICE,
  GROK_PRICING_SOURCE, GROK_INPUT_RATE, GROK_OUTPUT_RATE, GROK_PCM_FORMAT,
  GROK_ASSUMPTIONS, BRAIN_OWNED_INSTRUCTIONS,
  // mod
  VOICE_MODE_LOCAL, VOICE_MODE_GROK, VOICE_MODES, resolveVoiceMode,
  resolveGrokModel, resolveGrokVoice,
  // kimlik + maliyet
  hasGrokKey, grokKeyMissingMessage, grokKeySettingsTarget,
  grokCostNotice, grokCostEstimateUsd,
  // protokol
  buildSessionUpdate, buildAudioAppend, buildAudioCommit, buildAudioClear,
  buildForceMessage, buildResponseCancel,
  initialGrokState, reduceGrokEvent,
  // oturum
  createGrokSession,
};
