// TOUR-02-A — "İLK 10 DAKİKA" GÖREV GÜNLÜĞÜNÜN KALICILIĞI (main ucu).
//
// İki dosya, iki iş:
//
//   1. `<crewpaneHome>/onboarding.json`         — YEREL kayıt (bu cihaz)
//   2. `<crewpaneHome>/prefs/app-prefs.json`    — TAŞINABİLİR TERCİH projeksiyonu
//      → `onboarding.progress` anahtarı altında. Bu yol tesadüf değil: senkron
//        sınıf kaydının (`electron/sync/syncClasses.cjs` PREFS_REL_PATH) `prefs`
//        sınıfı için MÜHÜRLEDİĞİ TEK yoldur. Yani ilerleme, bulut senkronu açık
//        bir kullanıcıda ikinci cihaza kendiliğinden gider; ikinci bir taşıma
//        yolu icat edilmedi.
//
// ─── NEDEN settings.json DEĞİL ──────────────────────────────────────────────
// `productTourDone` orada yaşıyor (ADP-945) ve bu dosya onu TAŞIMAZ. Gerekçe:
// settings.json SIRLARI taşır (`apiKeys`) ve tam da bu yüzden hiçbir senkron
// sınıfının alt ağacında DEĞİLDİR (syncClasses "kök izolasyonu"). Görev günlüğü
// ise taşınabilir olmak ZORUNDA (sözleşme §3 "ikinci cihazda aynı ilerleme").
// İlerlemeyi settings.json'a koymak ya onu senkronlanamaz ya da settings.json'ı
// senkronlanabilir yapardı — ikincisi kabul edilemez.
//
// ─── BU MODÜL BİRLEŞTİRME YAPMAZ ────────────────────────────────────────────
// LWW kuralı `src/app/lib/onboardingQuests.ts` `mergeProgress`tedir ve orada
// birim testlidir. Main iki HAM kaydı okur ve ikisini de geri verir; birleştirme
// renderer'da TEK yerde olur. İkinci bir birleştirme kopyası yazsaydık, "iki
// gerçek" sınıfını (bu depoda defalarca ölçülmüş) bedavaya açardık.
//
// SAF-İMSİ + DI: `fs`, `dir`, `now` enjekte edilebilir → `node --test`. Hiçbir
// yol FIRLATMAZ: bozuk/okunamayan dosya `null` demektir, açılışı düşürmez.

'use strict';

const nodeFs = require('node:fs');
const path = require('node:path');
const instancePaths = require('../config/instancePaths.cjs');
const { atomicWriteFileSync } = require('../../platform/atomicWrite.cjs');
// SYNC-F1-7 — projeksiyon dosyasının ŞEKLİ artık TEK yerde tanımlı: damgalı
// LWW-register map (`{schemaVersion, keys:{k:{v,at,dev}}}`). Bu modül o şekli
// KOPYALAMAZ, ondan geçer. Kopyalasaydı iki yazar aynı dosyaya iki farklı biçim
// yazar ve biri diğerinin anahtarlarını SESSİZCE görünmez kılardı (ölçüldü:
// düz biçimde yazılan `onboarding.progress`, v1 okuyucusunda `keys` dışında
// kaldığı için hiç görünmüyor).
const prefsDoc = require('../../prefs/prefsDoc.cjs');

/** Taşınabilir tercih nesnesindeki anahtar (sözleşme + görev kartı). */
const PREF_KEY = 'onboarding.progress';
/** `syncClasses.PREFS_REL_PATH` ile AYNI yol — parite testi ikisini bağlar. */
const PREFS_REL_PATH = path.join('prefs', 'app-prefs.json');
const LOCAL_FILE = 'onboarding.json';

// TOUR-02-C — İKİNCİ KAYIT: bağlamsal ipuçları (hangi ipucu gösterildi, hangi
// tetik kaç kez görüldü). AYRI dosya + AYRI tercih anahtarı, aynı iki yüzey.
//
// Neden günlüğün İÇİNE yazılmadı: `onboarding.json`ın gövdesi TOUR-02-A'nın
// `QuestProgress` ŞEMASIDIR ve `parseProgress` bilinmeyen anahtarı düşürür. İpucu
// kaydını oraya sıkıştırmak ya o şemayı gevşetmeyi (bilinmeyen alanı korumayı)
// ya da iki şemayı tek dosyada birleştirmeyi gerektirirdi; ikisi de "tek dosya,
// iki gerçek" demekti. Yazma/okuma MANTIĞI ise ortaktır (aşağıdaki iki yardımcı)
// — kopya IO yok.
/** İpucu kaydının taşınabilir tercih anahtarı. */
const TIPS_PREF_KEY = 'onboarding.tips';
const TIPS_LOCAL_FILE = 'onboarding-tips.json';

function homeDir(opts) {
  return (opts && opts.dir) || instancePaths.crewpaneHome();
}

/** JSON oku; yok/bozuk → null (ASLA fırlatmaz). */
function readJson(file, fs) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * İKİ HAM KAYIT (tek dosya adı + tek tercih anahtarı için). Renderer birleştirir.
 * @returns {{local: object|null, portable: object|null}}
 */
function loadRecord(localName, prefKey, opts = {}) {
  const fs = opts.fs || nodeFs;
  const dir = homeDir(opts);
  const local = readJson(path.join(dir, localName), fs);
  let raw = null;
  try { raw = fs.readFileSync(path.join(dir, PREFS_REL_PATH), 'utf8'); } catch { raw = null; }
  // `parse` HER İKİ biçimi de okur: v1 damgalı VE SYNC-F1-7 öncesi düz biçim.
  // Göç böylece kendiliğinden olur, ayrı bir migration adımı YOKTUR.
  const entry = raw == null ? null : prefsDoc.parse(raw).doc.keys[prefKey];
  const portable = entry && typeof entry.v === 'object' && entry.v && !Array.isArray(entry.v)
    ? entry.v
    : null;
  return { local, portable };
}

/**
 * İKİ HAM KAYIT. Renderer birleştirir (mergeProgress).
 * @returns {{local: object|null, portable: object|null}}
 */
function load(opts = {}) {
  return loadRecord(LOCAL_FILE, PREF_KEY, opts);
}

/**
 * BİRLEŞMİŞ kaydı iki yüzeye de yaz.
 *
 * Taşınabilir dosyada başka anahtarlar olabilir (ileride başka taşınabilir
 * tercihler): dosya OKUNUP yalnız kendi anahtarımız değiştirilir — bu projeksiyonu
 * "tek anahtarlı dosya" sanıp üzerine yazmak, komşu tercihi sessizce silerdi.
 *
 * @returns {{ok:boolean, local:string, portable:string, error:string|null}}
 */
function save(progress, opts = {}) {
  return saveRecord(LOCAL_FILE, PREF_KEY, progress, opts);
}

function saveRecord(localName, prefKey, progress, opts = {}) {
  const fs = opts.fs || nodeFs;
  const dir = homeDir(opts);
  const localFile = path.join(dir, localName);
  const prefsFile = path.join(dir, PREFS_REL_PATH);
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) {
    return { ok: false, local: localFile, portable: prefsFile, error: 'bad-input' };
  }
  const body = JSON.stringify(progress, null, 2);
  try {
    atomicWriteFileSync(localFile, body, { fs, inPlaceFallback: true });
  } catch (err) {
    return { ok: false, local: localFile, portable: prefsFile, error: (err && err.code) || 'write-failed' };
  }
  try {
    let raw = null;
    try { raw = fs.readFileSync(prefsFile, 'utf8'); } catch { raw = null; }
    const cur = raw == null ? prefsDoc.emptyDoc() : prefsDoc.parse(raw).doc;
    // `stamp` DEĞİŞMEYEN anahtara damga vurmaz ⇒ aynı ilerlemenin ikinci yazımı
    // aynı baytı üretir (idempotent) ve senkronu boş yere uyandırmaz.
    const at = new Date(typeof opts.now === 'function' ? opts.now() : Date.now()).toISOString();
    const next = prefsDoc.stamp(cur, { [prefKey]: progress }, { at, dev: opts.deviceId || null }).doc;
    try { fs.mkdirSync(path.dirname(prefsFile), { recursive: true }); } catch { /* var */ }
    atomicWriteFileSync(prefsFile, prefsDoc.serialize(next), { fs, inPlaceFallback: true });
  } catch (err) {
    // Yerel yazım TUTTU: ilerleme bu cihazda kayıp değil. Taşınabilir projeksiyon
    // bir sonraki yazımda yeniden denenir; kullanıcıya hata GÖSTERİLMEZ.
    return { ok: true, local: localFile, portable: prefsFile, error: (err && err.code) || 'prefs-write-failed' };
  }
  return { ok: true, local: localFile, portable: prefsFile, error: null };
}

/** TOUR-02-C — bağlamsal ipucu kaydı (aynı iki yüzey, ayrı dosya/anahtar). */
function loadTips(opts = {}) {
  return loadRecord(TIPS_LOCAL_FILE, TIPS_PREF_KEY, opts);
}

function saveTips(tips, opts = {}) {
  return saveRecord(TIPS_LOCAL_FILE, TIPS_PREF_KEY, tips, opts);
}

module.exports = {
  load, save, PREF_KEY, PREFS_REL_PATH, LOCAL_FILE,
  loadTips, saveTips, TIPS_PREF_KEY, TIPS_LOCAL_FILE,
};
