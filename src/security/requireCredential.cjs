// ADP-628 (P0 · FATURA KORUMASI) — BYO-key SERT KAPI: tek boğaz `requireCredential`.
//
// SORUN (Eren 2026-07-25): "AgentVoice/AgentShot için arka planda AI token/API key
// varsa onlar BANA AİT. Müşteriler KENDİ API key'lerini girmeli, girmeden ÇALIŞMAMALI
// — yoksa bana yazar, ÜCRET çıkar, ZARAR EDERİM."
//
// Kanıtlanmış risk: `jarvisVoice.openAiKey()` sırayla `.env.local` → `process.env`
// → Ayarlar'a bakıyordu. Geliştirme makinesindeki `.env.local` (Eren'in anahtarı)
// bir müşteri build'ine herhangi bir yolla sızarsa (yanlış paketleme, kopyalanmış
// klasör, ortak makine), müşteri hiçbir şey girmeden Jarvis'i konuşturur ve FATURA
// EREN'A çıkar. Bu modül o zinciri KESER.
//
// TASARIM — üç kural:
//   1. TEK BOĞAZ. API anahtarı isteyen HER özellik buradan geçer. Yeni bir özellik
//      `process.env.X_API_KEY` okumaya kalkarsa `requireCredential.test.cjs`
//      içindeki YAPISAL DEĞİŞMEZ testi KIRMIZI verir (kapı yalnız disiplinle değil,
//      testle zorlanır — bkz. ADP-365 dersi "kapının kırmızı verebildiğini kanıtla").
//   2. PROD'DA ORTAM DALI YOK. `.env.local` / `process.env` anahtarı YALNIZ dev
//      instance'ta (ve açık opt-in ile test instance'ta) okunur. PROD'da bu dal
//      tamamen kapalıdır ve HİÇBİR env değişkeni onu açamaz — "ambient env asla
//      taşıyıcı olamaz, açık opt-in bayrağı taşır" (ADP-F1 kalıbı).
//   3. SESSİZ BAŞARISIZLIK YASAK. Anahtar yoksa çağıran NET bir hata alır
//      (`CredentialRequiredError.userMessage`) ve kullanıcı Ayarlar'a yönlendirilir.
//      "Bir şekilde çalışsın" diye başka bir anahtara DÜŞMEK yasaktır.
//
// SIR HİJYENİ: bu modül sırrı ASLA log'lamaz/hata mesajına koymaz. Log satırları
// yalnız `service` + `source` taşır; hata mesajları anahtar İÇERMEZ (testli).
//
// Saf + DI: Electron'a doğrudan require-bağı YOK (varsayılan kapı `electron`i tembel
// + guard'lı çeker) → `node --test` ile gerçek dosya sistemi üstünde koşar.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { VOICE_NAME, VOICE_SETTINGS_LABEL } = require('../voice/voiceName.cjs');

/**
 * SERVİS KAYIT DEFTERİ — anahtar isteyen her özellik burada tanımlıdır.
 *   settingsKey      ~/.crewpane/settings.json → apiKeys.<settingsKey> (Ayarlar paneli)
 *   envVar           DEV-ONLY .env.local/process.env adı (prod'da OKUNMAZ)
 *   feature          kullanıcıya gösterilen özellik adı (hata mesajında geçer)
 *   settingsPath     kullanıcıya GÖSTERİLEN Ayarlar yolu (insan metni)
 *   settingsWhere    o yolun CÜMLE İÇİNDEKİ hâli — Türkçe eki spec'e ait
 *   settingsCategory SettingsPanel kategori id'si — düğmenin GİTTİĞİ yer (makine)
 *   settingsField    o kategorideki input'un DOM id'si — odaklanılacak ALAN (makine)
 *
 * 🪤 `settingsWhere` neden ayrı alan: eski şablon `${settingsPath}'ndan ekle.` diye
 * ek YAPIŞTIRIYORDU. "AI Motorları'ndan" doğru çıkıyordu ama yol değişince
 * "Ses & Agent X'ndan" gibi bozuk Türkçe üretti. Ek, yolun kendisine ait bir
 * özelliktir (ünlü/ünsüz uyumu) → şablon değil, spec taşır.
 * Yeni servis eklemek = buraya bir satır; çağıran taraf değişmez.
 *
 * 🔴 ADP-749 — ÜÇ ÇELİŞKİ, TEK KÖK: metin ile GERÇEK yer birbirinden bağımsızdı.
 * Eskiden `openai` şöyle diyordu: feature='AgentVoice', settingsPath='Ayarlar → AI
 * Motorları'. Üçü de ölçülerek yanlış bulundu:
 *   1. YANLIŞ ÜRÜN. Anahtarı isteyen şey UYGULAMA İÇİNDEKİ sesli asistan (VOICE_NAME),
 *      AgentVoice ise AYRI bir ürün (bağımsız dikte uygulaması). Ve anahtar PAYLAŞILMIYOR:
 *      AgentVoice kendi anahtarını macOS login Keychain'de tutar (generic-password,
 *      service "AgentVoice" / eski "CrewPane Voice", account OPENAI_API_KEY —
 *      voice/voice_prompt.py::keychain_get_api_key), CrewPane ise
 *      <crewpaneHome>/credentials/vault.bin ya da settings.json→apiKeys.openai'de.
 *      İki AYRI kayıt: birine girilen anahtar diğerini AÇMAZ. Bu yüzden metinden
 *      "AgentVoice" TAMAMEN çıktı (paylaşım olmadığı için "paylaşılır" da denmez).
 *   2. YANLIŞ SEKME. "AI Motorları" sekmesinde OpenAI alanı YOK — oradaki BYOK
 *      sağlayıcıları groq/deepseek/moonshot (electron/providers.cjs) + Claude Code /
 *      Codex motor hesapları. Kullanıcı doğru sekmeye gidip alanı bulamıyordu.
 *   3. GERÇEK YER. Alan ZATEN var: Ayarlar → "Ses & <VOICE_NAME>" → Erişim →
 *      "OpenAI API anahtarı" (`#voice-openai-key`). Ürün eksik değildi, İŞARET yanlıştı.
 * Artık işaret MAKİNE-OKUR: `settingsCategory` + `settingsField` düğmeyi doğrudan
 * alana götürür ve `credentialSettingsTarget.test.cjs` alanın o sekmede GERÇEKTEN
 * var olduğunu ölçer (metin ile UI bir daha sessizce ayrışamaz).
 */
const SERVICES = Object.freeze({
  openai: Object.freeze({
    id: 'openai',
    label: 'OpenAI',
    settingsKey: 'openai',
    envVar: 'OPENAI_API_KEY',
    feature: `${VOICE_NAME} sesli asistanı`,
    settingsPath: `Ayarlar → ${VOICE_SETTINGS_LABEL}`,
    // Bölüm adı ("Erişim") de söylenir: kullanıcı doğru sekmede bile alanı arıyordu.
    settingsWhere: `Ayarlar → ${VOICE_SETTINGS_LABEL} → Erişim'den ekle`,
    settingsCategory: 'voice',
    settingsField: 'voice-openai-key',
  }),
  // ADP-827 — Grok Voice (xAI) SEÇENEĞİ. Yerel ücretsiz yol varsayılan kalır; bu
  // anahtar YALNIZ kullanıcı ses modunu "Grok Voice"a çevirdiğinde okunur.
  // Anahtar yoksa seçenek Ayarlar'da GRİ kalır ve yerel yol hiç etkilenmez —
  // yani bu kaydın yokluğu bir ARIZA değil, ürünün varsayılan hâlidir.
  // Fatura xAI tarafından KULLANICININ anahtarına işlenir (ADP-628'in ta kendisi:
  // ücretli bir yolu bizim anahtarımızla açmak yasak).
  xai: Object.freeze({
    id: 'xai',
    label: 'xAI',
    settingsKey: 'xai',
    envVar: 'XAI_API_KEY',
    feature: `${VOICE_NAME} — Grok Voice ses modu`,
    settingsPath: `Ayarlar → ${VOICE_SETTINGS_LABEL}`,
    settingsWhere: `Ayarlar → ${VOICE_SETTINGS_LABEL} → Erişim'den ekle`,
    settingsCategory: 'voice',
    settingsField: 'voice-xai-key',
  }),
  // ADP-848 — TÜRKÇE PROZODİ için ücretli TTS SEÇENEKLERİ. Kayıtların varlığı bir
  // vaat DEĞİL: varsayılan ücretsiz yerel ses olarak KALIR; bu anahtarlar yalnız
  // kullanıcı Ayarlar'dan o motoru AÇIKÇA seçtiğinde okunur.
  // 🔴 Fatura sağlayıcı tarafından KULLANICININ anahtarına işlenir — ADP-848'in
  // karar-belirleyen hesabı: yoğun kullanıcı ElevenLabs'te ayda ~54 USD yakar,
  // bizim aboneliğimiz 15 USD/ay. Bizim anahtarımızla açmak ürünü zarara sokar.
  elevenlabs: Object.freeze({
    id: 'elevenlabs',
    label: 'ElevenLabs',
    settingsKey: 'elevenlabs',
    envVar: 'ELEVENLABS_API_KEY',
    feature: `${VOICE_NAME} — ElevenLabs seslendirme`,
    settingsPath: `Ayarlar → ${VOICE_SETTINGS_LABEL}`,
    settingsWhere: `Ayarlar → ${VOICE_SETTINGS_LABEL} → Erişim'den ekle`,
    settingsCategory: 'voice',
    settingsField: 'voice-elevenlabs-key',
  }),
  azure: Object.freeze({
    id: 'azure',
    label: 'Azure Speech',
    settingsKey: 'azure',
    envVar: 'AZURE_SPEECH_KEY',
    feature: `${VOICE_NAME} — Azure Türkçe sinirsel ses`,
    settingsPath: `Ayarlar → ${VOICE_SETTINGS_LABEL}`,
    settingsWhere: `Ayarlar → ${VOICE_SETTINGS_LABEL} → Erişim'den ekle`,
    settingsCategory: 'voice',
    settingsField: 'voice-azure-key',
  }),
  // ADP-749 not: `fal` şu an UYGULAMADA HİÇ TÜKETİLMİYOR (requireCredential('fal')
  // çağıran yok — ölçüldü) ve CrewPane Ayarlar'ında fal alanı da YOK; AgentShot
  // ayrı üründür, anahtarını kendi tutar. Bu yüzden makine-hedefi BİLEREK null:
  // olmayan bir alana derin-bağlantı vaat etmiyoruz. Bir gün burada bir tüketici
  // olursa `settingsField` eklenmeli — nöbet testi kapsamı bunu yakalar.
  // ── INT-OBS-01 — GÖZLEMLENEBİLİRLİK KİMLİKLERİ (Sentry · PostHog) ──────────
  //
  // Bunlar diğerlerinden FARKLI bir iş yapar: bir özelliği açan tüketim anahtarı
  // değil, ürünün KULLANICI ADINA KURULUM YAPMASINI sağlayan YÖNETİM jetonudur.
  // Kullanıcı tek kimlik yapıştırır; ürün org'u bulur, projeleri açar, DSN /
  // `phc_…` anahtarını çeker ve kanal başına yerine yazar.
  //
  // 🔴 NEDEN BURADA (ikinci bir depo değil): jeton, diğer entegrasyon anahtarları
  // ile AYNI kasada (credentialVault) ve AYNI kapıdan (`resolveCredential`)
  // okunur. Kurulumun ÜRETTİĞİ türev anahtarlar ise `telemetry/provisionStore`da
  // yaşar — bilinçli ayrım, gerekçesi o dosyada (plan tavanı + UI görünürlüğü).
  //
  // 🔴 ÜCRET DURUŞU (ADP-628 ile tutarlı): fatura KULLANICININ Sentry/PostHog
  // hesabına işlenir. Bizim jetonumuz yok, koda gömülü DSN yok; anahtar yoksa
  // gözlemlenebilirlik KAPALIDIR ve bu bir arıza değil, varsayılan hâldir.
  sentry: Object.freeze({
    id: 'sentry',
    label: 'Sentry',
    settingsKey: 'sentry',
    envVar: 'SENTRY_AUTH_TOKEN',
    feature: 'Hata takibi (otomatik kurulum)',
    settingsPath: 'Ayarlar → Entegrasyonlar',
    settingsWhere: "Ayarlar → Entegrasyonlar'dan ekle",
    // 🪤 MAKİNE HEDEFİ BİLEREK null (ADP-749 `fal` içtihadı): Entegrasyon Merkezi
    // kartları KATALOGDAN üretilir, alanın DOM id'si çalışma anında kurulur
    // (`integ-secret-${entry.id}`) ve form yalnız "Bağla"ya basınca açılır. Yani
    // panelde sabit bir `id="…"` YOKTUR; olmayan bir sabite derin-bağlantı
    // VAAT ETMİYORUZ. Kullanıcı yine doğru yeri okur (`settingsWhere`).
    settingsCategory: 'integrations',
    settingsField: null,
  }),
  posthog: Object.freeze({
    id: 'posthog',
    label: 'PostHog',
    settingsKey: 'posthog',
    envVar: 'POSTHOG_PERSONAL_API_KEY',
    feature: 'Ürün analitiği (otomatik kurulum)',
    settingsPath: 'Ayarlar → Entegrasyonlar',
    settingsWhere: "Ayarlar → Entegrasyonlar'dan ekle",
    settingsCategory: 'integrations',
    settingsField: null, // gerekçe: yukarıdaki `sentry` notu (katalog-üretimli alan)
  }),
  fal: Object.freeze({
    id: 'fal',
    label: 'fal.ai',
    settingsKey: 'fal',
    envVar: 'FAL_KEY',
    feature: 'AgentShot',
    settingsPath: 'Ayarlar → AI Motorları',
    settingsWhere: "Ayarlar → AI Motorları'ndan ekle",
    settingsCategory: null,
    settingsField: null,
  }),
  // ── SKL-B3 (K-8) — ÜRÜNÜN KENDİ Gemini API çağrıları ──────────────────────
  //
  // 🔴 BU KAYIT `gemini` MOTORU DEĞİLDİR. İki ayrı şey aynı adı taşıyor ve
  // karıştırılırsa fatura da kimlik de yanlış yere gider:
  //   • `gemini` MOTORU  = spawn edilen CLI. Kimliği kendi oturumunda yaşar
  //     (engineRegistry `gemini`.auth → apiKey.vaultService
  //     'crewpane-gemini-api-key', engineAuth akışı). BU DOSYA ONA DOKUNMAZ.
  //   • `gemini` SERVİSİ = burada tanımlanan şey: ÜRÜNÜN KENDİ yaptığı Gemini API
  //     çağrıları (SKL-B1 video araştırma skill'i). Kasa kaydı `resolveCredential`
  //     içinde spec.id ile aranır → 'gemini' ≠ 'crewpane-gemini-api-key', yani
  //     iki kayıt aynı kasada bile ÇARPIŞMAZ.
  // Motorun oturumu varken ürünün anahtarı olmayabilir (ve tersi); ikisini tek
  // değere bağlamak, kullanıcının CLI aboneliğini bizim API faturamıza çevirirdi.
  //
  // GERİYE-UYUM (K-8'in ta kendisi): anahtar bugüne kadar YALNIZ elle yazılmış
  // `~/.crewpane/keys.env` dosyasında yaşıyordu. O dosya ÇALIŞMAYA DEVAM EDER
  // (`keysEnvFile: true` → kaynak zincirine 'keys-env' basamağı girer), ama artık
  // ZORUNLU değildir: Ayarlar'a girilen değer ÖNCE gelir (aşağıdaki zincir sırası).
  gemini: Object.freeze({
    id: 'gemini',
    label: 'Google Gemini',
    settingsKey: 'gemini',
    envVar: 'GEMINI_API_KEY',
    feature: 'Video araştırma skill’i (Gemini API)',
    settingsPath: 'Ayarlar → AI Motorları',
    settingsWhere: "Ayarlar → AI Motorları'ndan ekle",
    settingsCategory: 'engines',
    settingsField: 'appkey-gemini',
    // ~/.crewpane/keys.env YEDEK kaynak olarak okunur (aşağıdaki `fromKeysEnvFile`).
    // Yalnız bunu BEYAN eden servis için: diğer servislerin (openai/xai/…) bugünkü
    // kaynak zinciri BİT-BİT aynı kalsın — beyansız davranış değişikliği yok.
    keysEnvFile: true,
    // ENG-14'ün auth rozeti alanları, ürün tarafında AYNI dille (kullanıcı iki
    // ekranda aynı cümleyi görsün; metin uydurulmaz, kayıttan gelir).
    keyUrl: 'https://aistudio.google.com/apikey',
    keyLabel: 'Gemini API anahtarı (Google AI Studio)',
    // Ayarlar'da KENDİ kartını çizer (renderer isim-bazlı dal kurmaz; kartlar bu
    // bayrağı beyan eden kayıtlardan TÜRER — yeni ürün anahtarı = tek satır).
    productCard: true,
    // "Doğrula" düğmesinin GERÇEK çağrısı. Anahtar BAŞLIKLA gider (URL sorgusuna
    // ASLA: sorgu dizesi proxy/erişim kayıtlarına düşer). Beyan etmeyen servis
    // düğmeyi hiç görmez — olmayan bir doğrulama vaat edilmez.
    verify: Object.freeze({
      url: 'https://generativelanguage.googleapis.com/v1beta/models',
      header: 'x-goog-api-key',
      countPath: 'models',
    }),
  }),
  // ── GROQ-SET — Groq API anahtarı (ürünün kendi çağrıları) ──────────────
  groq: Object.freeze({
    id: 'groq',
    label: 'Groq',
    settingsKey: 'groq',
    envVar: 'GROQ_API_KEY',
    feature: 'Ürün AI çağrıları (Groq API)',
    settingsPath: 'Ayarlar → AI Motorları',
    settingsWhere: "Ayarlar → AI Motorları'ndan ekle",
    settingsCategory: 'engines',
    settingsField: 'appkey-groq',
    keysEnvFile: true,
    keyUrl: 'https://console.groq.com/keys',
    keyLabel: 'Groq API anahtarı',
    productCard: true,
    verify: Object.freeze({
      url: 'https://api.groq.com/openai/v1/models',
      header: 'Authorization',
      headerFormat: 'Bearer',
      countPath: 'data',
    }),
  }),
});

const CODE_REQUIRED = 'ERR_CREDENTIAL_REQUIRED';
const CODE_UNKNOWN_SERVICE = 'ERR_UNKNOWN_CREDENTIAL_SERVICE';

/** Açık opt-in bayrağı — YALNIZ `test` instance'ında ortam dalını açar (prod'da ASLA). */
const ENV_FALLBACK_OPT_IN = 'CREWPANE_ALLOW_ENV_CREDENTIALS';

class CredentialRequiredError extends Error {
  constructor(service, userMessage) {
    super(`${CODE_REQUIRED}: ${service} — ${userMessage}`);
    this.name = 'CredentialRequiredError';
    this.code = CODE_REQUIRED;
    this.service = service;
    this.userMessage = userMessage;
  }
}

class UnknownCredentialServiceError extends Error {
  constructor(service) {
    super(`${CODE_UNKNOWN_SERVICE}: ${service}`);
    this.name = 'UnknownCredentialServiceError';
    this.code = CODE_UNKNOWN_SERVICE;
    this.service = service;
  }
}

/** Kullanıcıya gösterilen tek metin — sessiz başarısızlığın yerine geçen şey (§1d). */
function missingMessage(spec) {
  return `${spec.feature} için ${spec.label} anahtarı gerekli — ${spec.settingsWhere}.`;
}

/**
 * ADP-749 — düğmenin MAKİNE hedefi (metnin ikizi). `null` = bu servisin uygulama
 * içinde bir anahtar alanı yok → çağıran derin-bağlantı düğmesi GÖSTERMEZ (olmayan
 * yere götüren düğme, yanlış yere götüren düğmeden iyi değildir).
 */
function settingsTarget(spec) {
  if (!spec || !spec.settingsCategory || !spec.settingsField) return null;
  return { category: spec.settingsCategory, field: spec.settingsField };
}

/** dotenv gövdesi → { KEY: value }. Tırnak + yorum satırlarını ayıklar. */
function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text == null ? '' : text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function trimmed(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * @param {object} opts
 * @param {() => string} [opts.instanceId] - instancePaths.instanceId ('prod'|'dev'|'test')
 * @param {() => boolean} [opts.isCustomerBuild] - ADP-646 buildChannel.isCustomerBuild (test dikişi)
 * @param {{resolveSync:(service:string,ctx?:object)=>object|null}|null} [opts.vault] - ADP-584 credentialVault
 * @param {() => object} [opts.readSettings] - agentSettings.readSettings
 * @param {object} [opts.processEnv] - test seam (varsayılan process.env)
 * @param {string} [opts.rootDir] - `.env.local`in bulunduğu dizin (dev dalı)
 * @param {(line:string)=>void} [opts.log] - sır ASLA geçmez, yalnız service/source
 */
function createCredentialGate(opts = {}) {
  const instanceId = opts.instanceId || (() => require('../config/instancePaths.cjs').instanceId());
  // ADP-646 — env ile değiştirilemeyen "müşteri build'i mi" sinyali (buildChannel.cjs).
  const isCustomerBuild =
    opts.isCustomerBuild || (() => require('../config/buildChannel.cjs').isCustomerBuild());
  const processEnv = opts.processEnv || process.env;
  const rootDir = opts.rootDir || path.join(__dirname, '..');
  const log = opts.log || (() => {});
  const readSettings =
    opts.readSettings || (() => {
      try { return require('../agents/agentSettings.cjs').readSettings(); } catch { return {}; }
    });

  // Vault tembel kurulur: `electron.safeStorage` yoksa (düz node, unit test) vault
  // YOKTUR → kapı diğer kaynaklara devam eder. `null` açıkça "vault yok" demektir.
  let _vault = opts.vault;
  function vault() {
    if (_vault !== undefined) return _vault;
    try {
      const { safeStorage } = require('electron');
      const { createCredentialVault } = require('./credentialVault.cjs');
      _vault = createCredentialVault({ safeStorage });
    } catch {
      _vault = null;
    }
    return _vault;
  }

  /** @type {Map<string,object>} dizin → parse edilmiş .env.local (bir kez okunur) */
  const _envLocalCache = new Map();
  /** `.env.local` — YALNIZ ortam dalı açıkken okunur (prod'da bu fonksiyon çağrılmaz). */
  function envLocal(dir) {
    const d = dir || rootDir;
    if (_envLocalCache.has(d)) return _envLocalCache.get(d);
    let parsed = {};
    try {
      parsed = parseEnvFile(fs.readFileSync(path.join(d, '.env.local'), 'utf8'));
    } catch {
      /* dosya yok (paketli app) → boş */
    }
    _envLocalCache.set(d, parsed);
    return parsed;
  }

  /**
   * 🔴 ADP-628 §1c — ORTAM DALI KAPISI.
   *   prod → HER ZAMAN false. Hiçbir env değişkeni bunu açamaz; Eren'in `.env.local`i
   *          müşteri build'ine sızsa bile PROD'DA OKUNMAZ.
   *   dev  → true (geliştirme kolaylığı; makine zaten Eren'in).
   *   test → yalnız AÇIK opt-in bayrağıyla (e2e gerçek-Whisper koşusu için).
   *
   * 🔒 ADP-646 EKİ — `instanceId()`in BİRİNCİ kaynağı `CREWPANE_INSTANCE` env'idir
   * (instancePaths resolveInstanceId §1). Yani müşteri, indirdiği prod DMG'yi
   * `CREWPANE_INSTANCE=dev` ile başlatarak yukarıdaki "dev → true" dalına
   * düşebiliyordu. Artık ilk kontrol env-DEĞİŞTİRİLEMEZ: paketli + build tipi
   * gömülmemiş kopya (= siteden inen DMG) hiçbir koşulda ortam anahtarı okumaz.
   * Bu SIKILAŞTIRMADIR: geliştirici kopyalarında (kaynak, dev/test DMG) davranış aynı.
   */
  function envFallbackAllowed() {
    if (isCustomerBuild()) return false;
    const id = instanceId();
    if (id === 'dev') return true;
    if (id === 'test') return trimmed(processEnv[ENV_FALLBACK_OPT_IN]) === '1';
    return false; // 'prod' (ve tanınmayan her şey) → KAPALI
  }

  /** Vault kaydının ortam kapsamı: prod instance 'prod', diğerleri 'dev'. */
  function vaultEnvFor(id) {
    return id === 'prod' ? 'prod' : 'dev';
  }

  function fromVault(spec, ctx) {
    const v = vault();
    if (!v || typeof v.resolveSync !== 'function') return '';
    try {
      const rec = v.resolveSync(spec.id, {
        env: ctx && ctx.env !== undefined ? ctx.env : vaultEnvFor(instanceId()),
        projectId: (ctx && ctx.projectId) || null,
      });
      return rec ? trimmed(rec.secret) : '';
    } catch {
      return ''; // vault kapalı/bozuk = kayıt yok (fail-closed, ADP-584 duruşu)
    }
  }

  function fromSettings(spec) {
    try {
      const s = readSettings() || {};
      return trimmed(s.apiKeys && s.apiKeys[spec.settingsKey]);
    } catch {
      return '';
    }
  }

  /**
   * SKL-B3 (K-8) — `~/.crewpane/keys.env` YEDEK kaynağı. YALNIZ `keysEnvFile: true`
   * beyan eden servis için okunur; beyansız servisin zinciri değişmez.
   *
   * 🔴 NEDEN `envFallbackAllowed()` KAPISINA TABİ DEĞİL (ADP-628 ihlali değildir):
   * o kapının koruduğu şey, GELİŞTİRİCİNİN anahtarının müşteri kopyasına SIZMASIDIR
   * — `.env.local` repo ağacında yaşar ve yanlış paketleme ile DMG'nin içine girebilir.
   * `~/.crewpane/keys.env` ise kullanıcının KENDİ ev dizinindedir (600), uygulama
   * paketiyle taşınamaz ve oraya yalnız o makinenin sahibi yazar. Prod'da kapatmak,
   * K-8'in çözmeye çalıştığı kullanıcıyı (bugün anahtarı orada olan herkesi) kırardı.
   * Emsal: `providerKeysEnvFile.mergeProviderKeys` aynı dosyayı BYOK sağlayıcı
   * anahtarları için zaten prod'da okuyor (PROV-01).
   *
   * Değer ASLA log'a girmez; okunamayan/olmayan dosya = "anahtar yok".
   */
  function fromKeysEnvFile(spec, ctx) {
    if (!spec.keysEnvFile) return '';
    try {
      const read =
        opts.readKeysEnvFile ||
        require('../config/providerKeysEnvFile.cjs').readProviderKeysFromEnvFile;
      const map = read({
        ...(ctx && ctx.keysEnvFile ? { file: ctx.keysEnvFile } : {}),
        ...(ctx && ctx.home ? { home: ctx.home } : {}),
        providers: [{ settingsKey: spec.settingsKey, envKey: spec.envVar }],
      });
      return trimmed(map && map[spec.settingsKey]);
    } catch {
      return ''; // dosya yok/bozuk = kayıt yok (fail-closed)
    }
  }

  // 🔴 Kapı BURADA — `envFallbackAllowed()` false ise `.env.local` DOSYASINA BİLE
  // dokunulmaz (okuma yok, cache yok). Prod'da Eren'in anahtarı okunmaz.
  function fromEnv(spec, ctx) {
    if (!envFallbackAllowed()) return '';
    const dir = (ctx && ctx.rootDir) || rootDir;
    return trimmed(envLocal(dir)[spec.envVar]) || trimmed(processEnv[spec.envVar]);
  }

  /**
   * Anahtarı çözümle — ASLA fırlatmaz. Kaynak sırası: vault (şifreli) → Ayarlar →
   * (beyan edenlerde) ~/.crewpane/keys.env → (yalnız dev) .env.local/process.env.
   * `secret` YALNIZ ok:true'da vardır.
   * @returns {{ok:boolean, service:string, secret?:string, source:string,
   *            code?:string, message?:string, settingsPath?:string,
   *            settingsTarget?:{category:string,field:string}|null}}
   */
  function resolveCredential(service, ctx = {}) {
    const spec = SERVICES[service];
    if (!spec) {
      return {
        ok: false,
        service: String(service || ''),
        source: 'none',
        code: CODE_UNKNOWN_SERVICE,
        message: `Bilinmeyen servis: ${String(service || '')}`,
      };
    }
    for (const [source, get] of [
      ['vault', () => fromVault(spec, ctx)],
      ['settings', () => fromSettings(spec)],
      // SKL-B3 — Ayarlar'ın ARDINDAN: kullanıcının panelden girdiği değer, elle
      // yazılmış dosyayı EZER (kartın öncelik kuralı). Dosya yalnız Ayarlar boşken
      // konuşur → "dosyam vardı, çalışıyordu" hâli bozulmaz.
      ['keys-env', () => fromKeysEnvFile(spec, ctx)],
      ['env-dev', () => fromEnv(spec, ctx)],
    ]) {
      const secret = get();
      if (secret) {
        log(`credential ok service=${spec.id} source=${source}`); // sır ASLA log'a girmez
        return { ok: true, service: spec.id, secret, source };
      }
    }
    log(`credential missing service=${spec.id} instance=${instanceId()}`);
    return {
      ok: false,
      service: spec.id,
      source: 'none',
      code: CODE_REQUIRED,
      message: missingMessage(spec),
      settingsPath: spec.settingsPath,
      // ADP-749 — metnin MAKİNE ikizi: renderer düğmesi bunu kullanır (kendi
      // kategori adını HARDCODE ETMEZ; eski hata tam buydu → category:'engines').
      settingsTarget: settingsTarget(spec),
    };
  }

  return {
    SERVICES,
    resolveCredential,

    /**
     * SERT KAPI — anahtar yoksa FIRLATIR (sessiz başarısızlık yasak).
     * @returns {string} secret
     * @throws {CredentialRequiredError|UnknownCredentialServiceError}
     */
    requireCredential(service, ctx = {}) {
      const r = resolveCredential(service, ctx);
      if (r.ok) return r.secret;
      if (r.code === CODE_UNKNOWN_SERVICE) throw new UnknownCredentialServiceError(service);
      throw new CredentialRequiredError(r.service, r.message);
    },

    /** Yetenek bayrağı (UI "hasKey") — sır DÖNMEZ. */
    hasCredential(service, ctx = {}) {
      return resolveCredential(service, ctx).ok === true;
    },

    /** Anahtar yokken gösterilecek kullanıcı metni (özellik kilitli ekranları için). */
    missingMessageFor(service) {
      const spec = SERVICES[service];
      return spec ? missingMessage(spec) : `Bilinmeyen servis: ${String(service || '')}`;
    },

    /**
     * ADP-749 — "Ayarlar'ı aç" düğmesinin gideceği yer: {category, field} ya da null.
     * Metinle AYNI kayıttan türer, yani cümle ile düğme ayrışamaz.
     */
    settingsTargetFor(service) {
      return settingsTarget(SERVICES[service]);
    },

    /** Test/teşhis: ortam dalı bu instance'ta açık mı? */
    envFallbackAllowed,

    /**
     * DEV-ONLY `.env.local` görünümü (geriye-uyum yüzeyi). Ortam dalı kapalıysa
     * (= prod) `{}` döner ve DOSYA HİÇ AÇILMAZ.
     */
    devEnvLocal(dir) {
      if (!envFallbackAllowed()) return {};
      return { ...envLocal(dir) };
    },
  };
}

// ── Varsayılan kapı (uygulama içi tek örnek) ─────────────────────────────────
let _default = null;
function defaultGate() {
  if (!_default) _default = createCredentialGate();
  return _default;
}

module.exports = {
  SERVICES,
  ENV_FALLBACK_OPT_IN,
  CODE_REQUIRED,
  CODE_UNKNOWN_SERVICE,
  CredentialRequiredError,
  UnknownCredentialServiceError,
  parseEnvFile,
  missingMessage,
  settingsTarget, // ADP-749 — saf türetim (nöbet testi doğrudan bunu ölçer)
  createCredentialGate,
  // Uygulama yüzeyi — çağıranlar bunları kullanır (varsayılan kapı üstünden).
  requireCredential: (service, ctx) => defaultGate().requireCredential(service, ctx),
  resolveCredential: (service, ctx) => defaultGate().resolveCredential(service, ctx),
  hasCredential: (service, ctx) => defaultGate().hasCredential(service, ctx),
  missingMessageFor: (service) => defaultGate().missingMessageFor(service),
  settingsTargetFor: (service) => defaultGate().settingsTargetFor(service),
  devEnvLocal: (dir) => defaultGate().devEnvLocal(dir),
  // test seam — varsayılan kapıyı sıfırla
  _resetDefault: () => { _default = null; },
};
