// PROV-01 — `~/.crewpane/keys.env` sağlayıcı anahtarı OKUYUCUSU.
//
// NEDEN: ADP-580 BYOK yolu anahtarı YALNIZ `settings.json → apiKeys.<settingsKey>`ten
// okuyor (main.js → trusted.providerKeys → providers.providerKeyEnv). Kullanıcının
// anahtarı ise `~/.crewpane/keys.env` dosyasında (600) duruyordu ⇒ `provider:'groq'`
// seçili bir pane anahtarsız doğuyor ve codex kimlik hatası veriyordu.
//
// KARAR: anahtarı settings.json'a KOPYALAMIYORUZ. İki yerde duran bir sır, iki kez
// sızar ve hangisinin güncel olduğu belirsizleşir. Bunun yerine keys.env FALLBACK
// olarak okunur: settings.json'da bir değer VARSA o kazanır (kullanıcının Ayarlar'dan
// yaptığı seçim üstündür), yoksa dosyadan gelir.
//
// GEÇİCİLİK: kalıcı ev SPRINT-AD-55 Entegrasyon Merkezi kasasıdır (credentialVault).
// Bu modül o kasa gelene kadarki en küçük doğru dikiştir ve kasa geldiğinde TEK
// çağrı noktası (main.js) değiştirilerek kaldırılır.
//
// GÜVENLİK: değer ASLA loglanmaz — döndürülen tek şey haritanın kendisidir, log satırı
// yalnız HANGİ sağlayıcının anahtar bulduğunu (adını) söyler.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Varsayılan dosya: ~/.crewpane/keys.env */
function defaultKeysFile(home) {
  return path.join(home || os.homedir(), '.crewpane', 'keys.env');
}

/**
 * `KEY=value` satırlarını ayrıştırır. Yorum (`#`) ve boş satır atlanır; `export ` öneki
 * kabul edilir; değerdeki tek/çift tırnak soyulur. Ayrıştırılamayan satır SESSİZCE
 * atlanır — bir yazım hatası uygulamanın açılışını düşüremez.
 *
 * @param {string} text
 * @returns {Record<string,string>}
 */
function parseEnvFile(text) {
  const out = {};
  if (typeof text !== 'string') return out;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const name = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    let value = body.slice(eq + 1).trim();
    if (value.length >= 2 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (value) out[name] = value;
  }
  return out;
}

/**
 * keys.env'i sağlayıcı kayıt defterinin `settingsKey`lerine göre haritalar:
 * `{ groq: '…', deepseek: '…' }`. Dosya yoksa/okunamıyorsa BOŞ nesne (çağıran için
 * "anahtar yok" ile aynı) — bu yol hiçbir zaman spawn'ı düşürmez.
 *
 * @param {{file?:string, home?:string, providers?:Array<{settingsKey:string,envKey:string}>}} [opts]
 * @returns {Record<string,string>}
 */
function readProviderKeysFromEnvFile(opts = {}) {
  const list = Array.isArray(opts.providers) ? opts.providers : require('../agents/providers.cjs').allProviders();
  const file = opts.file || defaultKeysFile(opts.home);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const env = parseEnvFile(text);
  const out = {};
  for (const p of list) {
    if (p && p.settingsKey && p.envKey && env[p.envKey]) out[p.settingsKey] = env[p.envKey];
  }
  return out;
}

/**
 * Ayarlardaki anahtarları keys.env ile BİRLEŞTİRİR. Ayarlar KAZANIR (kullanıcının
 * açık seçimi dosyadan üstündür); yalnız eksik olanlar dosyadan doldurulur.
 *
 * @param {Record<string,string>|null|undefined} settingsKeys
 * @param {Parameters<typeof readProviderKeysFromEnvFile>[0]} [opts]
 * @returns {{keys:Record<string,string>, filled:string[]}} — `filled`: dosyadan gelen
 *   sağlayıcı ADLARI (değer DEĞİL; loglanabilir).
 */
function mergeProviderKeys(settingsKeys, opts = {}) {
  const raw = settingsKeys && typeof settingsKeys === 'object' ? settingsKeys : {};
  // 🪤 BOŞLUK DEĞER: settings.json'da `"groq": "   "` gibi bir artık, düz birleştirmede
  // dosyadaki GERÇEK anahtarı EZERDİ ve providerKeyEnv onu boş sayıp null döndürdüğü
  // için pane sessizce anahtarsız doğardı. Bu yüzden ayarlar tarafında yalnız DOLU
  // değerler öncelik kazanır.
  const fromSettings = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' && v.trim()) fromSettings[k] = v;
  }
  const fromFile = readProviderKeysFromEnvFile(opts);
  const keys = { ...raw, ...fromFile, ...fromSettings };
  const filled = Object.keys(fromFile).filter((k) => !(k in fromSettings));
  return { keys, filled };
}

module.exports = {
  defaultKeysFile,
  parseEnvFile,
  readProviderKeysFromEnvFile,
  mergeProviderKeys,
};
