'use strict';
// SEC-W2-A2 — PAKET BÜTÜNLÜĞÜ: "gönderdiğimiz dosyalar hâlâ bu mu?"
//
// NEDEN VAR (SEC-BYPASS-01 §5 A2): ölçülmüş atlatma TEK bir istemci dosyasının
// (`app.asar.unpacked/buildChannel.cjs`) gövdesini düzenlemekle yapıldı. SEC-W1-A1
// paketten bir şey ÇIKARMAYI kapıya bağladı, SEC-W1-C1 kurcalamanın en kaba hâlini
// (damga ⇄ çalışma anı çelişkisi) görünür kıldı. Geriye asıl soru kaldı: pakete
// GİREN dosyalar build'de yazdığımız dosyalar mı?
//
// ── BU MODÜL BİR KARAR VERMEZ ───────────────────────────────────────────────
// Burada YALNIZ ÖLÇÜM var: dosya listesi, sha256'lar ve listenin kök özeti.
// "Bulut kapansın mı" kararı SUNUCUDA verilir (`integrityReport.cjs` raporu
// taşır, crewpane-id `license-token` doğrular). Sebebi SEC-BYPASS-01 §6'da
// yazılı: hash listesi İSTEMCİDE doğrulanırsa doğrulayıcı da düzenlenir ve
// geriye SAHTE bir güvenlik duygusu kalır. İstemcinin yerel karşılaştırması
// yalnız TELEMETRİ içindir (hangi dosya ayrıştı) — yetki kararı değil.
//
// ── KÖK ÖZET (root) NEDEN VAR ───────────────────────────────────────────────
// Sunucuya 324 satırlık bir liste göndermek gereksiz; imzalanan da tek bir
// değer olmalı ki JWS küçük kalsın. `root` = kanonik (ada göre sıralı)
// "ad\0özet\n" satırlarının sha256'sı. Tek bir dosya bir bit değişirse root
// değişir; build'in imzaladığı root ile istemcinin hesapladığı root ayrışır.
//
// Saf + DI: Electron'a require-bağı YOK → `node --test` altında doğrudan koşar.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** Manifest şema sürümü. Sunucu bilmediği sürümü REDDETMEZ, "ölçemedim" der. */
const MANIFEST_VERSION = 1;

/** Manifestin paket içindeki adı. `app.asar.unpacked/` altına yazılır. */
const MANIFEST_FILE = 'integrity.json';

const ALGO = 'sha256';

/**
 * Kapsam — `Resources/` köküne göre.
 *
 * `app.asar` BİLEREK İÇERİDE (kartın metni yalnız `.unpacked` diyordu; sapma
 * raporda adıyla bildirildi): kaçış mantığının tüketicilerinin çoğu
 * (`main.js`, `crewpaneId.cjs`, `seatGate.cjs`) asar'ın İÇİNDE yaşar. Ölçüldü:
 * 27,6 MB'lık asar'ın sha256'sı 24 ms — 324 dosyalık unpacked yürüyüşü 418 ms.
 * Yani en büyük kod kütlesini kapsama almanın bedeli toplam maliyetin %6'sı.
 */
const ASAR_ENTRY = 'app.asar';
const UNPACKED_DIR = 'app.asar.unpacked';

/**
 * Manifestin KENDİSİ listeye giremez (kendine referans) — ayrıca `.DS_Store`
 * gibi işletim sistemi artıkları da giremez: kullanıcının Finder'da klasöre
 * bakması bir kurcalama DEĞİLDİR ve yanlış pozitif üretirse kapı kapatılır.
 */
const EXCLUDED_BASENAMES = Object.freeze(new Set([MANIFEST_FILE, '.DS_Store', 'Thumbs.db']));

/**
 * ⚠️ KAPSAM YALNIZ BETİKTİR — YERLİ İKİLİLER DIŞARIDA. ÖLÇÜLMÜŞ SEBEP:
 *
 * `app.asar.unpacked` altında 10 `.node` + 3 `spawn-helper` yaşıyor. macOS'ta
 * bunlar `afterPack`ten SONRA imzalanır: kurulu 0.2.46 paketinde dosya damgası
 * 01:13, gömülü imza damgası **01:15:24**. Yani manifesti afterPack'te üretip
 * bu dosyaları da listeye alsaydık, İMZALAMA KENDİ PAKETİMİZİ "kurcalanmış"
 * gösterirdi — her müşteride, her build'de. Windows'ta aynı sınıf: Authenticode
 * `.node`ların içine imza bloğu yazar (SEC-B1 geldiğinde de aynı kalır).
 *
 * Bu yüzden kapsam UZANTIYLA daraltılır ve ayrıca sihirli-bayt ile DOĞRULANIR
 * (`looksNative`): uzantı listesi bir gün gevşetilirse bile Mach-O/PE/ELF bir
 * dosya listeye SESSİZCE giremez. Yerli ikililerin bütünlüğü işletim sisteminin
 * kendi imzasının işidir — bizim listemizin değil.
 */
const SCRIPT_EXTENSIONS = Object.freeze(new Set(['.cjs', '.mjs', '.js', '.json']));

/** Mach-O (her iki endian + fat), PE (`MZ`), ELF (`\x7fELF`) → listeye GİRMEZ. */
const NATIVE_MAGIC = Object.freeze([
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca,
]);

function looksNative(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4);
    if (fs.readSync(fd, buf, 0, 4, 0) < 4) return false;
    if (buf[0] === 0x4d && buf[1] === 0x5a) return true; // MZ → PE
    if (buf[0] === 0x7f && buf.toString('latin1', 1, 4) === 'ELF') return true;
    return NATIVE_MAGIC.includes(buf.readUInt32BE(0));
  } catch {
    return false;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* yok */ } }
  }
}

/** Bir dosyanın sha256'sı (hex). Okunamıyorsa `null` — atmaz. */
function hashFile(file) {
  try {
    return crypto.createHash(ALGO).update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/** Dizini yinelemeli gez; POSIX ayraçlı, `base`e göreli yollar döner (sıralı). */
function listFiles(dir, base, out) {
  const acc = out || [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      listFiles(full, base, acc);
      continue;
    }
    // Sembolik bağ bir DOSYA DEĞİLDİR: hedefi paketin dışını gösterebilir ve
    // özeti "paketin içeriği" hakkında bir şey söylemez. Listeye alınmaz.
    if (!e.isFile()) continue;
    if (EXCLUDED_BASENAMES.has(e.name)) continue;
    if (!SCRIPT_EXTENSIONS.has(path.extname(e.name).toLowerCase())) continue;
    // İkinci kapı: uzantı doğru olsa bile içerik yerli ikiliyse listeye girmez.
    if (looksNative(full)) continue;
    acc.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return acc;
}

/**
 * Kapsamdaki dosyaları `Resources/` köküne göre sıralı listele.
 * @param {string} resources paketin `Resources` dizini
 */
function scopeFiles(resources) {
  const files = [];
  if (fs.existsSync(path.join(resources, ASAR_ENTRY))) files.push(ASAR_ENTRY);
  listFiles(path.join(resources, UNPACKED_DIR), resources, files);
  return files.sort();
}

/**
 * Kanonik kök özet. Girdi {ad: özet} nesnesi; ÇIKTI ada göre sıralı, ayraçlı,
 * belirlenimci. Aynı dosya kümesi her makinede aynı kökü verir.
 *
 * `\0` ayracı bilerek: dosya adında geçemeyen tek bayt. Ayraç olarak `:` ya da
 * `-` kullanılsaydı `a:b`+`c` ile `a`+`b:c` aynı kökü verirdi (çakışma).
 */
function rootDigest(files) {
  const h = crypto.createHash(ALGO);
  for (const name of Object.keys(files || {}).sort()) {
    h.update(name);
    h.update('\0');
    h.update(String(files[name]));
    h.update('\n');
  }
  return h.digest('hex');
}

/**
 * Paket dizinini ÖLÇ → {files, root, count}.
 * Okunamayan dosya listeye `null` özetle GİRMEZ; `unreadable` altında sayılır
 * (sessizce düşerse root sahte bir şekilde "temiz" kalırdı).
 */
function measure(resources) {
  const names = scopeFiles(resources);
  const files = {};
  const unreadable = [];
  for (const name of names) {
    const digest = hashFile(path.join(resources, name));
    if (digest === null) { unreadable.push(name); continue; }
    files[name] = digest;
  }
  return { files, root: rootDigest(files), count: names.length, unreadable };
}

/**
 * ÖLÇÜLEN paketi MANİFESTLE karşılaştır — YEREL, yalnız telemetri için.
 *
 * Üç ayrışma sınıfı AYRI taşınır çünkü üçü ayrı şeyi anlatır:
 *   * `changed` — dosya var, içerik farklı (klasik kurcalama)
 *   * `missing` — manifestte var, pakette yok (dosya silinmiş)
 *   * `added`   — pakette var, manifestte yok (dosya eklenmiş)
 * Üçünü tek "mismatch" kefesine koymak, "ne oldu" sorusunu ölçülemez yapardı.
 *
 * @returns {{ok:boolean, root:string, expectedRoot:string|null,
 *            changed:string[], missing:string[], added:string[]}}
 */
function compare(measured, manifest) {
  const expected = (manifest && manifest.files && typeof manifest.files === 'object')
    ? manifest.files : null;
  const got = (measured && measured.files) || {};
  if (!expected) {
    return {
      ok: false, root: measured ? measured.root : rootDigest({}),
      expectedRoot: (manifest && typeof manifest.root === 'string') ? manifest.root : null,
      changed: [], missing: [], added: [],
    };
  }
  const changed = [];
  const missing = [];
  for (const name of Object.keys(expected).sort()) {
    if (!(name in got)) { missing.push(name); continue; }
    if (got[name] !== expected[name]) changed.push(name);
  }
  const added = Object.keys(got).sort().filter((n) => !(n in expected));
  const expectedRoot = typeof manifest.root === 'string' ? manifest.root : rootDigest(expected);
  return {
    ok: changed.length === 0 && missing.length === 0 && added.length === 0
      && measured.root === expectedRoot,
    root: measured.root,
    expectedRoot,
    changed,
    missing,
    added,
  };
}

/**
 * Manifesti diskten oku. Bozuk/eksik → `null` (ATMAZ: açılış yolunda bir JSON
 * hatası uygulamayı düşüremez — SEC-W1-C1'in "uygulama KAPANMAZ" kuralı).
 */
function readManifest(resources) {
  try {
    const raw = fs.readFileSync(path.join(resources, UNPACKED_DIR, MANIFEST_FILE), 'utf8');
    const doc = JSON.parse(raw);
    if (!doc || typeof doc !== 'object') return null;
    if (doc.v !== MANIFEST_VERSION) return null;
    if (typeof doc.root !== 'string' || !doc.root) return null;
    if (typeof doc.jws !== 'string' || !doc.jws) return null;
    return doc;
  } catch {
    return null;
  }
}

module.exports = {
  MANIFEST_VERSION,
  MANIFEST_FILE,
  ALGO,
  ASAR_ENTRY,
  UNPACKED_DIR,
  EXCLUDED_BASENAMES,
  SCRIPT_EXTENSIONS,
  looksNative,
  hashFile,
  scopeFiles,
  rootDigest,
  measure,
  compare,
  readManifest,
};
