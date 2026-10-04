// ADP-844 — KALDIRILAN ÖZELLİKLERİN AYAR ARTIKLARI (tek defter).
//
// Bir özellik üründen sökülünce KODU gider; kullanıcının DİSKİNDEKİ ayarı ve (varsa)
// SIRRI kalır. Bu artık iki şekilde zarar verir:
//   1) uykuda duran bir sır (bot jetonu) hiçbir özelliğe hizmet etmeden diskte durur;
//   2) eski bir sürüm ya da elle düzenlenmiş bir dosya özelliği geri "diriltebilir".
//
// Bu dosya o artıkların TEK sözlüğüdür ve iki iş yapar:
//   • purgeRemovedKeys(obj)      — okuma/yazma yolunda artığı düşürür (şema temiz kalır)
//   • migrateSettingsFile({...}) — artık DİSKTE ise dosyayı bir kez yeniden yazar; yani
//     temizlik kullanıcının bir ayarı değiştirmesine BAĞLI DEĞİLDİR.
//
// KAPI SÖZLEŞMESİ: kaldırılan özelliğin adı ürün kodunun başka hiçbir yerinde geçmez
// (`npm run check:removed` → scripts/check-removed-features.mjs). Bu dosya o kuralın
// bilinçli istisnasıdır: artığı SİLEBİLMEK için adını bilmek zorunda. Testler ve e2e
// kapıları da adı buradan (REMOVED_FEATURE_TERMS) okur, kendi içine YAZMAZ.

const fs = require('fs');
const path = require('path');
// ADP-835 (790 K1) — atomik yazımın rename adımı platform boğazından geçer:
// Windows'ta Defender/Search hedefi açık tutunca EPERM/EBUSY gelir ve bu çağrı
// best-effort catch içinde OLDUĞU İÇİN artık-temizliği SESSİZCE kaybolurdu.
const { renameWithRetrySync } = require('../../platform/atomicWrite.cjs');

/**
 * Kaldırılmış özelliklerin ayar defteri. Yeni bir özellik söküldüğünde buraya bir
 * kayıt eklenir; kod tarafında başka hiçbir yerde özel-durum yazılmaz.
 *
 * keys: settings.json içindeki yol dizileri (['a','b'] → obj.a.b)
 */
const REMOVED_SETTINGS = [
  {
    feature: 'telegram', // ADP-295 (eklendi) → ADP-765 (söküldü) → ADP-844 (artık temizliği)
    // Gerekçe: çok kullanıcılı bir üründe "kimin Telegram'ı?" sorusunun cevabı yok;
    // çekirdeğe gömülü tek-kullanıcılı bir bot ölçeklenmiyor. Geri gelirse doğru yer
    // entegrasyon hub'ıdır (kullanıcı kendi kanalını bağlar), main süreci değil.
    keys: [['telegram'], ['apiKeys', 'telegramBot']],
    // Bu yoldaki değer bir SIR: temizlik "ayar sıfırlama" değil, sır silmedir.
    secrets: [['apiKeys', 'telegramBot']],
  },
];

/** Kapıların (grep gate + e2e + unit) okuduğu yasaklı terim listesi. */
const REMOVED_FEATURE_TERMS = REMOVED_SETTINGS.map((r) => r.feature);

// ── ADP-916 — ÇİVİLENMİŞ ESKİ VARSAYILANI SÖK ────────────────────────────────
//
// 🔴 ÖLÇÜLEN ARIZA: motor varsayılanını iyileştirmek KULLANICIYA ULAŞMIYORDU.
// Ayarlar ekranı alanları ÇÖZÜLMÜŞ değerle dolduruyor (`String(ep.silenceMs)`) ve
// kaydederken o sayıyı diske geri yazıyordu — yani kullanıcı BAŞKA bir ayarı
// (ör. TTS sesini) kaydettiği anda dinleme eşikleri o günün varsayılanına
// ÇİVİLENİYOR. Eren'in hesabında ölçüldü (accounts/<id>/settings.json,
// 2026-08-05): `silenceMs: 900, endpointMaxMs: 2500, sleepAfterMs: 45000` —
// üçü de o sürümün varsayılanının BİREBİR kopyası, hiçbiri onun tercihi değil.
// Sonuç: ADP-916'nın taban düzeltmesi (900 → 2000) onun makinesinde HİÇ
// yürürlüğe girmezdi; diskteki 900 sonsuza dek kazanırdı.
// (Aynı sınıf: [[clip-prod-path-default-divergence]] v2 — "motorun sahibi olduğu
// değeri defaults()'ta SABİTLEME".)
//
// Bu yüzden ESKİ varsayılan üçlüsü, TAMAMI birebir eşleştiğinde `null`a çekilir
// ("motor ne diyorsa o"). Tek bir değere değil ÜÇLÜYE bakmak kasten: çiviyi atan
// eski panel üçünü BİRLİKTE yazıyordu, dolayısıyla bu imza artığa özgüdür.
// Bilerek 900 ms seçen bir kullanıcının aynı kayıtta 2500 + 45000'i de taşıması
// (panelde artık 2000/3000 yazarken) pratikte imkânsızdır → tercih korunur.
// Damga/şema sürümü GEREKMEZ: temizlik sonrası değer `null`dır, imza bir daha
// eşleşmez (idempotent). Şema anahtarı eklemek de mümkün değildi — `readSettings`
// beyaz liste kullanıyor, tanınmayan anahtar ilk yazımda SESSİZCE düşerdi.
const SUPERSEDED_DEFAULTS = [
  {
    reason: 'ADP-916: dinleme eşikleri ADP-854B varsayılanına çivilenmiş',
    // Hepsi eşleşmezse HİÇBİRİ silinmez.
    match: [
      { keys: ['jarvis', 'silenceMs'], value: 900 },
      { keys: ['jarvis', 'endpointMaxMs'], value: 2500 },
      { keys: ['jarvis', 'sleepAfterMs'], value: 45000 },
    ],
    // `sleepAfterMs` DOKUNULMAZ: ADP-916 onu değiştirmiyor, dolayısıyla 45000
    // hâlâ geçerli varsayılan — silmek bir şeyi düzeltmez, yalnız gürültü olur.
    unpin: [['jarvis', 'silenceMs'], ['jarvis', 'endpointMaxMs']],
  },
];

/** Tüm artık yolları düz liste halinde. */
function removedKeyPaths() {
  return REMOVED_SETTINGS.flatMap((r) => r.keys);
}

function isSecretPath(keyPath) {
  const s = keyPath.join('.');
  return REMOVED_SETTINGS.some((r) => (r.secrets || []).some((p) => p.join('.') === s));
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * `obj` üzerinden kaldırılmış anahtarları SİLER (yerinde). Bulunamayan yol no-op.
 *
 * @returns {{changed: boolean, removed: string[]}} removed: 'apiKeys.telegramBot' gibi
 *          YOL adları — DEĞERLER asla dönmez/loglanmaz (sır sızmasın).
 */
function purgeRemovedKeys(obj) {
  const removed = [];
  if (!isPlainObject(obj)) return { changed: false, removed };
  for (const keyPath of removedKeyPaths()) {
    let node = obj;
    for (let i = 0; i < keyPath.length - 1; i += 1) {
      node = isPlainObject(node) ? node[keyPath[i]] : undefined;
      if (!isPlainObject(node)) break;
    }
    const leaf = keyPath[keyPath.length - 1];
    if (isPlainObject(node) && Object.prototype.hasOwnProperty.call(node, leaf)) {
      delete node[leaf];
      removed.push(keyPath.join('.'));
    }
  }
  return { changed: removed.length > 0, removed };
}

/** `['a','b']` yolundaki değeri oku (yol yoksa `undefined`). */
function readPath(obj, keyPath) {
  let node = obj;
  for (const k of keyPath) {
    if (!isPlainObject(node)) return undefined;
    node = node[k];
  }
  return node;
}

/**
 * ADP-916 — eski varsayılana ÇİVİLENMİŞ değerleri `null`a çeker (yerinde).
 * İmzanın TAMAMI eşleşmezse o kayıt için hiçbir şey yapılmaz.
 *
 * @returns {{changed: boolean, unpinned: string[]}} unpinned: 'jarvis.silenceMs' gibi YOLLAR
 */
function unpinSupersededDefaults(obj) {
  const unpinned = [];
  if (!isPlainObject(obj)) return { changed: false, unpinned };
  for (const rec of SUPERSEDED_DEFAULTS) {
    if (!rec.match.every((m) => readPath(obj, m.keys) === m.value)) continue;
    for (const keyPath of rec.unpin) {
      const parent = readPath(obj, keyPath.slice(0, -1));
      const leaf = keyPath[keyPath.length - 1];
      if (isPlainObject(parent) && parent[leaf] !== null) {
        parent[leaf] = null; // "motor ne diyorsa o" — anahtarı SİLMEK de aynı anlam,
        unpinned.push(keyPath.join('.')); // ama `null` niyeti diskte GÖRÜNÜR kılar.
      }
    }
  }
  return { changed: unpinned.length > 0, unpinned };
}

/**
 * Kullanıcının settings.json dosyasındaki artıkları BİR KEZ temizler.
 *
 * Neden okuma yolunda (writeSettings'i beklemeden): ADP-765 artığı okurken düşürüyordu
 * ama diske ancak kullanıcı bir ayarı DEĞİŞTİRDİĞİNDE yansıyordu — yani jeton, hiçbir
 * şey değiştirmeyen bir kullanıcının diskinde süresiz kalıyordu (ölçüldü: ADP-844,
 * hesap dosyasında 46 karakterlik bot jetonu hâlâ duruyordu).
 *
 * Best-effort: dosya yok / bozuk JSON / salt-okunur disk → sessizce no-op.
 * Yazım atomiktir (tmp + rename) ki yarım yazım ayarları kaybettirmesin.
 *
 * @param {{file: string, log?: (msg: string) => void}} opts
 * @returns {{migrated: boolean, removed: string[], reason?: string}}
 */
function migrateSettingsFile({ file, log } = {}) {
  if (!file) return { migrated: false, removed: [], reason: 'no-file' };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { migrated: false, removed: [], reason: e && e.code === 'ENOENT' ? 'absent' : 'unreadable' };
  }
  if (!isPlainObject(raw)) return { migrated: false, removed: [], reason: 'not-an-object' };
  const { changed, removed } = purgeRemovedKeys(raw);
  // ADP-916 — aynı soğuk-okuma turunda çiviyi de sök: temizlik kullanıcının bir
  // ayarı DEĞİŞTİRMESİNE bağlı olamaz (ADP-844'ün öğrettiği kural).
  const { changed: unpinChanged, unpinned } = unpinSupersededDefaults(raw);
  if (!changed && !unpinChanged) return { migrated: false, removed: [], unpinned: [], reason: 'clean' };
  const tmp = `${file}.migrate.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(raw, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameWithRetrySync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* tmp zaten yok */
    }
    return { migrated: false, removed: [], reason: `write-failed: ${e.message}` };
  }
  const hadSecret = removed.some((r) => isSecretPath(r.split('.')));
  if (typeof log === 'function') {
    // Yalnızca YOL adları loglanır; değer ASLA. hadSecret "jeton silindi" izini bırakır.
    const parts = [];
    if (removed.length) parts.push(`removed ${removed.join(', ')}${hadSecret ? ' (secret purged)' : ''}`);
    // ADP-916 — çivi sökümü İZ BIRAKIR: kullanıcı "eşiğim neden değişti" diye
    // sorduğunda cevap kayıttan okunabilsin (sessiz ayar değişikliği yasak).
    if (unpinned.length) parts.push(`unpinned ${unpinned.join(', ')} → null (motor varsayılanı)`);
    log(`settings migration: ${parts.join(' · ')}`);
  }
  return { migrated: true, removed, unpinned };
}

/** Test/araç kolaylığı: bir dizindeki settings.json'un yolu. */
function settingsFileIn(dir) {
  return path.join(dir, 'settings.json');
}

module.exports = {
  REMOVED_SETTINGS,
  REMOVED_FEATURE_TERMS,
  removedKeyPaths,
  purgeRemovedKeys,
  migrateSettingsFile,
  settingsFileIn,
  // ADP-916 — eski varsayılana çivilenmiş eşiklerin sökümü.
  SUPERSEDED_DEFAULTS,
  unpinSupersededDefaults,
};
