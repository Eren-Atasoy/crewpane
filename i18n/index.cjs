// ADP-888 (ADP-885 Faz A) — ANA SÜREÇ ÇEVİRİ KATMANI + RENDERER'A GİDEN KANAL.
//
// ÜÇ İŞ:
//   1. `resolveLocale(tercih, sistemDili)` — TERCİH ≠ ETKİN DİL (ADP-885 §3.2/1).
//      'system' saklanabilir üçüncü bir değerdir; "macOS'i takip et" niyetini
//      'tr'/'en' yazarak ifade etmek imkânsızdır.
//   2. `t(anahtar, params)` — main'in diyalog/bildirim metinleri. Eksik çeviri
//      İNGİLİZCEYE düşer, HAM ANAHTAR gösterilmez (renderer ile aynı sözleşme).
//   3. `encodeArgv/decodeArgv` — BrowserWindow additionalArguments kanalı.
//      Sandboxed preload relative `require` YAPAMAZ, bu yüzden preload.js kendi
//      INLINE ikizini taşır (supabaseTarget.cjs ile birebir aynı desen) ve
//      biçim kasten en yalın hâlde: "--crewpane-locale=<etkin>:<tercih>".
//
// ⚠️ ARAYÜZ DİLİ ≠ SES DİLİ: burada çözülen dil YALNIZ yazılı arayüzü seçer.
// Ajanın konuştuğu dil ayrı bir eksendir (docs/design/ADR-VOICE-LOCALE.md) ve
// kullanıcının SÖYLEDİĞİ komut kelimeleri hiçbir zaman bu katmandan geçmez.

'use strict';

const DICTS = {
  en: require('./dictionaries/en.cjs'),
  tr: require('./dictionaries/tr.cjs'),
};

const LOCALES = ['en', 'tr'];
const DEFAULT_LOCALE = 'en';
const LOCALE_PREFERENCES = ['system', 'en', 'tr'];
const DEFAULT_LOCALE_PREFERENCE = 'system';
const ARGV_FLAG = '--crewpane-locale=';
const PARAM_RE = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;

const isLocale = (v) => typeof v === 'string' && LOCALES.includes(v);
const isLocalePreference = (v) => typeof v === 'string' && LOCALE_PREFERENCES.includes(v);

/** 'tr-TR' → 'tr'; desteklenmeyen dil → İngilizce (yarım arayüzden iyidir). */
function localeFromSystem(systemLocale) {
  if (typeof systemLocale !== 'string' || !systemLocale.trim()) return DEFAULT_LOCALE;
  const primary = systemLocale.trim().toLowerCase().split(/[-_]/)[0];
  return isLocale(primary) ? primary : DEFAULT_LOCALE;
}

/** Tercih + sistem dili → ETKİN dil. Saf; renderer'daki ikiziyle aynı kural. */
function resolveLocale(preference, systemLocale) {
  if (isLocale(preference)) return preference;
  return localeFromSystem(systemLocale);
}

let current = DEFAULT_LOCALE;
let currentPreference = DEFAULT_LOCALE_PREFERENCE;

function setLocale(preference, systemLocale) {
  currentPreference = isLocalePreference(preference) ? preference : DEFAULT_LOCALE_PREFERENCE;
  current = resolveLocale(currentPreference, systemLocale);
  return current;
}
const getLocale = () => current;
const getPreference = () => currentPreference;

/**
 * Anahtar → metin. Sıra: etkin dil → İngilizce → boş dize.
 * Boş dize bilinçli: ham anahtar ekrana ÇIKMAZ (ADP-885 §4.3).
 */
function t(key, params, locale) {
  const loc = isLocale(locale) ? locale : current;
  const value =
    (DICTS[loc] && DICTS[loc][key]) || (DICTS[DEFAULT_LOCALE] && DICTS[DEFAULT_LOCALE][key]) || '';
  if (!params) return value.replace(PARAM_RE, '');
  return value.replace(PARAM_RE, (_m, name) => (params[name] === undefined ? '' : String(params[name])));
}

/** Renderer'a giden argv bayrağı: "--crewpane-locale=<etkin>:<tercih>". */
function encodeArgv(state) {
  const loc = isLocale(state && state.locale) ? state.locale : DEFAULT_LOCALE;
  const pref = isLocalePreference(state && state.preference) ? state.preference : DEFAULT_LOCALE_PREFERENCE;
  return `${ARGV_FLAG}${loc}:${pref}`;
}

/** Bayrağı çöz (preload'ın INLINE ikizi ile aynı davranış). Yoksa null. */
function decodeArgv(argv) {
  const hit = (argv || []).find((a) => typeof a === 'string' && a.startsWith(ARGV_FLAG));
  if (!hit) return null;
  const [loc, pref] = hit.slice(ARGV_FLAG.length).split(':');
  if (!isLocale(loc)) return null;
  return { locale: loc, preference: isLocalePreference(pref) ? pref : DEFAULT_LOCALE_PREFERENCE };
}

// ── SES DİLİ (ADP-885 Faz B · docs/design/ADR-VOICE-LOCALE.md) ──────────────
//
// İKİNCİ EKSEN. Buradaki değer arayüz metnini SEÇMEZ; kullanıcının KONUŞTUĞU
// dili (STT ipucu) ve asistanın konuştuğu dili belirler. Ayrı olmasının bedeli
// bir alan, kazancı şu: "arayüz İngilizce ama Türkçe konuşuyorum" geçerli bir
// yapılandırma olur (ADR §2) — ürünün hedef kullanıcısı tam olarak odur.
//
// 'follow-ui' ÜÇÜNCÜ BİR DEĞERDİR, 'tr'/'en' ile ifade EDİLEMEZ (locale'deki
// 'system' ile birebir aynı gerekçe): niyet "arayüz hangi dildeyse o" demektir
// ve arayüz dili sonradan değişince ses de değişmelidir.
//
// ⚠️ TEK OKUMA NOKTASI: ses tarafı `voiceLocale(settings)` ÇAĞIRIR; ikinci bir
// yerde `settings.voiceLocale` okunursa iki gerçek doğar (ADP-812 dersi).
// Bugünkü tek tüketici: electron/grokVoice.cjs → createGrokSession languageHint.
const VOICE_LOCALE_PREFERENCES = ['follow-ui', 'en', 'tr'];
const DEFAULT_VOICE_LOCALE_PREFERENCE = 'follow-ui';

const isVoiceLocalePreference = (v) => typeof v === 'string' && VOICE_LOCALE_PREFERENCES.includes(v);

/**
 * Ses tercihi + ARAYÜZ dili → konuşulan dil. Saf; renderer'daki ikiziyle
 * (src/app/i18n/index.ts resolveVoiceLocale) aynı kural.
 * Bozuk/eksik tercih → 'follow-ui' (arayüzü izle), yani kullanıcı hiçbir zaman
 * anlamadığı bir dilde dinlenen bir asistanla baş başa kalmaz.
 */
function resolveVoiceLocale(preference, uiLocale) {
  if (isLocale(preference)) return preference;
  return isLocale(uiLocale) ? uiLocale : DEFAULT_LOCALE;
}

/** Ayar nesnesinden ÇÖZÜLMÜŞ ses dili. Arayüz dili = bu modülün canlı durumu. */
function voiceLocale(settings) {
  return resolveVoiceLocale(settings && settings.voiceLocale, current);
}

module.exports = {
  LOCALES,
  LOCALE_PREFERENCES,
  DEFAULT_LOCALE,
  DEFAULT_LOCALE_PREFERENCE,
  VOICE_LOCALE_PREFERENCES,
  DEFAULT_VOICE_LOCALE_PREFERENCE,
  ARGV_FLAG,
  isLocale,
  isLocalePreference,
  isVoiceLocalePreference,
  localeFromSystem,
  resolveLocale,
  resolveVoiceLocale,
  voiceLocale,
  setLocale,
  getLocale,
  getPreference,
  t,
  encodeArgv,
  decodeArgv,
  DICTS,
};
