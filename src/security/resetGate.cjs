// RESET-03 — SIFIRLAMA İSTEĞİNİN KARAR KATMANI (saf; Electron require'ı YOK).
//
// ─── NEDEN AYRI BİR MODÜL ────────────────────────────────────────────────────
// `main.js` birim takımında ayağa KALKMAZ (Electron `app`/`BrowserWindow` ister),
// yani orada yaşayan hiçbir karar `node --test` ile ölçülemez. Bu kartın en
// yıkıcı kararları — "bu metin onay sayılır mı", "bu argv sıfırlama ister mi",
// "renderer'ın gönderdiği hangi alan `execute`'a geçer" — ölçülmeden sevk
// edilemez. Bu yüzden karar burada, KABLO main.js'te.
//
// Bu modül HİÇBİR ŞEY SİLMEZ ve dosya sistemine dokunmaz; `installReset.cjs`in
// API'sini de DEĞİŞTİRMEZ (RESET-01 sözleşmesi dondurulmuştur).

'use strict';

const path = require('node:path');

/** `installReset.LEVELS` ile AYNI küme — ikizlenmesin diye modülden okunur. */
const installReset = require('./installReset.cjs');

const LEVELS = installReset.LEVELS; // ['session','full']

/**
 * YAZARAK ONAY SÖZCÜĞÜ. Renderer'ın (RESET-02) `account.reset.confirmWord`
 * sözlüğüyle BİREBİR aynı olmak zorunda: kullanıcı arayüzün yazdırdığı sözcüğü
 * yazar, kararı MAIN verir. İki taraf ayrışırsa kullanıcı doğru sözcüğü yazıp
 * reddedilir — bu yüzden `resetGate.test.cjs` sözlüğü kaynaktan okuyup
 * karşılaştırır (ikiz sabit ≠ tek gerçek).
 */
const CONFIRM_WORDS = Object.freeze({ tr: 'SIFIRLA', en: 'RESET' });
const DEFAULT_LOCALE = 'en';

/**
 * Onay sözcüğü KÜÇÜK/BÜYÜK HARFE DUYARLI karşılaştırılır (emsal: GitHub'ın depo
 * silme kutusu). Türkçe'de harf katlamak ayrıca TUZAKTIR: `'sifirla'.toUpperCase()`
 * da `'SIFIRLA'` verir, yani noktasız `ı` yazmayan bir kullanıcı YIKICI eylemi
 * yanlışlıkla onaylamış olurdu. Tek esneklik: baştaki/sondaki boşluk ve Unicode
 * birleştirme biçimi (NFC) — ikisi de "kullanıcı ne yazdı" sorusunun cevabını
 * değiştirmez.
 */
function normalizeConfirm(input) {
  if (typeof input !== 'string') return '';
  return input.normalize('NFC').trim();
}

/** Bu dilde beklenen onay sözcüğü. Bilinmeyen dil → İngilizce (fail-closed değil, TANIMLI). */
function expectedConfirmWord(locale) {
  return CONFIRM_WORDS[locale] || CONFIRM_WORDS[DEFAULT_LOCALE];
}

/**
 * Kullanıcının yazdığı metin onay sayılır mı?
 *
 * ETKİN DİLİN SÖZCÜĞÜ ŞART DEĞİL: arayüz Türkçeyken `RESET` yazan bir kullanıcı
 * da niyetini kanıtlamıştır (ve tersi). Kabul edilen küme KAPALIDIR — sözlükteki
 * iki sözcük; serbest metin değil.
 */
function confirmMatches(input, locale) {
  const given = normalizeConfirm(input);
  if (!given) return false;
  if (given === expectedConfirmWord(locale)) return true;
  return Object.values(CONFIRM_WORDS).includes(given);
}

/**
 * RENDERER YÜKÜNÜN BOĞAZI — `execute`/`writeMarker`a YALNIZ buradan çıkan nesne
 * geçer. Kart kuralı: "Renderer'dan gelen hiçbir yol/level dışı alan `execute`'a
 * geçmez". Yol, ev dizini, hedef listesi gibi alanlar burada DÜŞER (kopyalanmaz,
 * loglanmaz) — `installReset` hedefi zaten kendisi türetir.
 *
 * @returns {{ok:true, level:string, keepLogs:boolean, confirmText:string}
 *          |{ok:false, reason:'bad_request'|'bad_level'}}
 */
function sanitizeRequest(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'bad_request' };
  const level = typeof raw.level === 'string' ? raw.level : '';
  if (!LEVELS.includes(level)) return { ok: false, reason: 'bad_level' };
  return {
    ok: true,
    level,
    // Varsayılan SAKLA (RESET-01 §6.2): destek isteği sıfırlamadan SONRA gelirse
    // günlük lazım. Kullanıcı kutuyu kaldırırsa `false` gelir.
    keepLogs: raw.keepLogs !== false,
    confirmText: typeof raw.confirmText === 'string' ? raw.confirmText : '',
  };
}

/**
 * `--reset` / `--reset=session` / `--reset=full` (+ `--yes` / `-y`).
 * `instancePaths.argvInstance` deseninin ikizi: yalnız TANINAN değerler kabul.
 *
 * ⚠️ BİLİNMEYEN DEĞER SESSİZCE `full`E DÜŞMEZ. `--reset=sesion` (yazım hatası)
 * sessizce TAM sıfırlama yapsaydı, yıkıcı eylemin tetiği bir harfe kalırdı.
 * O durumda `{ invalid:'<ham değer>' }` döner; main hata yazıp ÇIKAR.
 *
 * @returns {null | {level:string, yes:boolean} | {invalid:string, yes:boolean}}
 */
function argvReset(argv) {
  if (!Array.isArray(argv)) return null;
  const yes = argv.some((a) => a === '--yes' || a === '-y');
  for (const a of argv) {
    if (typeof a !== 'string') continue;
    const m = a.match(/^--reset(?:=(.*))?$/);
    if (!m) continue;
    const raw = m[1];
    if (raw === undefined || raw === '') return { level: 'full', yes };
    const v = raw.trim().toLowerCase();
    if (LEVELS.includes(v)) return { level: v, yes };
    return { invalid: raw, yes };
  }
  return null;
}

/**
 * TELEMETRİ KOVASI — ham bayt GÖNDERİLMEZ. Gerekçe: bayt sayısı bu kurulumun
 * ne kadar veri biriktirdiğini söyler ve anonim bir olayda parmak izidir; soru
 * ise "sıfırlayanlar küçük mü büyük mü kurulumlardı" — kova bunu yanıtlar.
 * `null` (RESET-01'in `bytes_uncomputed` uyarısı) → 'unknown'.
 */
function bytesBucket(bytes) {
  // ⚠️ `Number(null) === 0`. Sayıya çevirmeden ÖNCE elenmezse "ölçülemedi"
  // sessizce "100 MB'tan küçük"e dönüşür — ölçmediğimiz bir şeyi ölçmüş gibi
  // raporlamak olurdu. (Bu satır bir kırmızı testten doğdu.)
  if (typeof bytes !== 'number') return 'unknown';
  const n = bytes;
  if (!Number.isFinite(n) || n < 0) return 'unknown';
  const mb = n / (1024 * 1024);
  if (mb < 100) return 'lt100mb';
  if (mb < 500) return 'lt500mb';
  if (mb < 2048) return 'lt2gb';
  if (mb < 10240) return 'lt10gb';
  return 'gte10gb';
}

/**
 * AÇILIŞ BİLDİRİMİ — `execute()` sonucundan RAKAM üretir, CÜMLE ÜRETMEZ.
 *
 * Kart kapısı "bootBanner metni iç-mekanizma grep 0" idi; bunu yapısal olarak
 * karşılamanın yolu metni hiç üretmemektir: burada yol adı, dosya adı, hata
 * gövdesi YOK — yalnız sayılar ve kapalı bir `kind` kümesi. Cümleyi gösteren
 * yüzey (main'in native kutusu / RESET-02'nin şeridi) kendi sözlüğünden yazar.
 *
 * @returns {{kind:'done'|'partial', level:string, bytesFreed:number|null,
 *            removedCount:number, lockedCount:number, skippedCount:number}}
 */
function bootNotice(level, result) {
  const r = result || {};
  const removed = Array.isArray(r.removed) ? r.removed : [];
  const locked = Array.isArray(r.locked) ? r.locked : [];
  const skipped = Array.isArray(r.skipped) ? r.skipped : [];
  let bytesFreed = 0;
  for (const e of removed) {
    // Aynı `Number(null) === 0` tuzağı: RESET-01 bayt bütçesini aşan hedefte
    // `bytes:null` döner ve bu "0 bayt boşaldı" DEĞİLDİR.
    const b = e && e.bytes;
    if (typeof b !== 'number' || !Number.isFinite(b)) { bytesFreed = null; break; }
    bytesFreed += b;
  }
  return {
    kind: locked.length ? 'partial' : 'done',
    level,
    bytesFreed,
    removedCount: removed.length,
    lockedCount: locked.length,
    skippedCount: skipped.length,
  };
}

/**
 * GÜNCELLEYİCİ ÖNBELLEĞİ — RESET-01 riski §5.2: yol KULLANICI GİRDİSİNDEN değil,
 * Electron'un kendi köklerinden türemeli.
 *
 * ÖLÇÜLDÜ (bu makine, canlı prod kurulumu):
 *   userData              = ~/Library/Application Support/crewpane-shell
 *   gerçek önbellek dizini = ~/Library/Caches/crewpane-shell-updater
 * yani ad `basename(userData)`tir — `app.getName()` DEĞİL (main.js:220
 * `app.setName('CrewPane')` çağırır ve yol köklerini eski değerlerine geri
 * sabitler; ad değişir, kökler değişmez).
 *
 * İKİ ADAY DÖNER, main VAR OLANI seçer: electron-updater sürümleri arasında bu
 * adın `app.name`e kaydığı bir dünya olursa 300 MB'lık dizini SESSİZCE
 * kaçırmayalım. Var olmayan aday `installReset`te zaten `missing` olur (zararsız).
 *
 * @returns {string[]} mutlak yol adayları (sırayla denenecek)
 */
function updaterCacheCandidates(o) {
  const platform = (o && o.platform) || process.platform;
  const homedir = (o && o.homedir) || '';
  const env = (o && o.env) || {};
  const userDataDir = (o && o.userDataDir) || '';
  const appName = (o && o.appName) || '';
  // ⚠️ AYIRICI PLATFORMDAN GELİR, KOŞTUĞUMUZ YERDEN DEĞİL. macOS'ta `path.basename`
  // ters eğik çizgiyi BÖLMEZ → bir Windows yolu olduğu gibi "ad" sanılır ve aday
  // saçmalar. Windows davranışı mac'ten ancak böyle ÖLÇÜLEBİLİR
  // ([[lesson_windows_platform_testing]]: platform parametresini açık geç).
  const p = platform === 'win32' ? path.win32 : path.posix;
  let base;
  if (platform === 'win32') base = env.LOCALAPPDATA || p.join(homedir, 'AppData', 'Local');
  else if (platform === 'darwin') base = p.join(homedir, 'Library', 'Caches');
  else base = env.XDG_CACHE_HOME || p.join(homedir, '.cache');
  const names = [];
  if (userDataDir) names.push(p.basename(userDataDir));
  if (appName && !names.includes(appName)) names.push(appName);
  return names.filter(Boolean).map((n) => p.join(base, `${n}-updater`));
}

module.exports = {
  LEVELS,
  CONFIRM_WORDS,
  expectedConfirmWord,
  confirmMatches,
  sanitizeRequest,
  argvReset,
  bytesBucket,
  bootNotice,
  updaterCacheCandidates,
};
