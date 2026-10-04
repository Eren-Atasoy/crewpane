// ADP-835 (790 K1/K2 · ADR-W10 Kural 2) — ATOMİK YAZIM + ROTASYON TEK BOĞAZI.
//
// NEDEN VAR (790 K1 ölçtü). Ağaçta 26 üretim `fs.renameSync` çağrısı var ve hepsi
// aynı deseni tekrarlıyor: `tmp` dosyasına yaz → hedefin ÜZERİNE rename et. POSIX'te
// bu desen kusursuz: hedef başka bir süreç tarafından AÇIK olsa bile rename başarılı
// olur (dizin girdisi değişir, açık handle eski inode'u okumaya devam eder).
//
// Windows'ta AYNI DESEN AYNI ŞEY DEĞİL. `MoveFileEx(..., MOVEFILE_REPLACE_EXISTING)`
// hedef dosya başka bir handle tarafından paylaşımsız açıksa `ERROR_ACCESS_DENIED` /
// `ERROR_SHARING_VIOLATION` verir → libuv bunu `EPERM` / `EACCES` / `EBUSY` olarak
// yükseltir. Bu handle'ı açan şey KULLANICININ BAŞKA BİR PROGRAMI DEĞİL, sistemin
// kendisidir: Defender yeni yazılan her dosyayı tarar, Windows Search indeksler,
// yedekleme ajanı okur. Yani hata NADİR ama SÜREKLİ olasıdır.
//
// Zararın şekli 790'ın "🔇 sessiz" işaretini hak ediyor: bu çağrıların çoğu
// `try { … } catch { /* best-effort */ }` içinde. Rename patlayınca istisna YUTULUR,
// `tmp` dosyası diskte kalır ve HEDEF ESKİ HÂLİYLE DURUR. Kullanıcı için bu
// "ayarım kaydolmadı" / "pane'im geri gelmedi" olarak, aralıklı ve yeniden
// üretilemeyen bir hayalet bug olarak görünür.
//
// ÇÖZÜM — TEK BOĞAZ + KISA GERİ-ÇEKİLMELİ YENİDEN DENEME:
//   • `renameWithRetrySync` — rename'in TEK giriş kapısı. win32'de geçici kilit
//     kodlarında (EPERM/EACCES/EBUSY/UNKNOWN) artan bekleme ile yeniden dener.
//   • `atomicWriteFileSync` — "tmp yaz + rename" desenini tekilleştirir; başarısız
//     olursa `tmp` artığını temizler (bugün 26 çağrının hiçbiri temizlemiyor).
//   • `rotateSeriesSync` — K2: `file.N → file.N+1`, `file → file.1` rotasyonu.
//
// macOS DAVRANIŞI BİT-BİT AYNI. darwin dalında `attempts = 1`, bekleme = 0,
// fırlatılan hata bugünkü `fs.renameSync`'in fırlattığının TA KENDİSİ (sarmalanmaz,
// kodu/mesajı korunur). Yani darwin'de bu modül `fs.renameSync`e ek olarak HİÇBİR
// gözlemlenebilir davranış getirmiyor — nöbetçi testler bunu ölçüyor.
//
// NEDEN İSTİSNAYI YUTMUYOR: çağıranların yarısı bugün rename hatasını kendi
// `catch`inde ele alıyor (ADR-W10 Kural 2 — çağıranın imzası değişmez). Bu modül
// üç-durumlu bir PROBE değil bir MUTATÖR; sözleşmesi "başarılıysa ölçüm kaydı
// döndür, başarısızsa BUGÜNKÜ hatayı fırlat". Ölçmek isteyen `onRetry`/`log`
// enjekte eder; "denedim ama ölçemedim" hâli üç-durumlu `probeRenameSupport()`
// ile ayrı olarak sunulur.
'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const nodeCrypto = require('node:crypto');

/**
 * Windows'ta rename'i GEÇİCİ olarak düşüren hata kodları. Hepsi "dosya şu an
 * başka bir handle tarafından tutuluyor" anlamına gelir ve milisaniyeler içinde
 * kendiliğinden geçer.
 *   EPERM/EACCES → ERROR_ACCESS_DENIED (paylaşım ihlali, Defender'ın klasik izi)
 *   EBUSY        → ERROR_SHARING_VIOLATION / ERROR_LOCK_VIOLATION
 *   UNKNOWN      → libuv'un eşleyemediği Win32 kodu (nadir, ama gözlemlenmiş)
 * KALICI hatalar (ENOENT: kaynak yok, ENOSPC: disk dolu, EROFS, EXDEV) yeniden
 * DENENMEZ — beklemek onları düzeltmez, yalnız kullanıcıyı bekletir.
 */
const TRANSIENT_CODES = Object.freeze(['EPERM', 'EACCES', 'EBUSY', 'UNKNOWN']);

/**
 * Denemeler arası bekleme (ms). Toplam en fazla 310 ms — bir ayar yazımının
 * kullanıcı tarafından fark edilmeyeceği ama Defender'ın tarama penceresinin
 * (tipik olarak onlarca ms) rahatça sığdığı aralık. 6 deneme = 1 + 5 bekleme.
 */
const BACKOFF_MS = Object.freeze([10, 20, 40, 80, 160]);

/**
 * Ana süreçte GERÇEK senkron uyku. `Atomics.wait` çekirdeğe iner (meşgul-bekleme
 * DEĞİL, CPU yakmaz). Bu yolun tamamı senkron (`renameSync`) olduğu için async
 * bir bekleme mümkün değil: `await` eklemek 26 çağıranın hepsinin imzasını
 * değiştirirdi (ADR-W10 Kural 2 ihlali).
 */
function sleepSync(ms) {
  const wait = Number(ms);
  if (!Number.isFinite(wait) || wait <= 0) return 0;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
  return wait;
}

/** Hata geçici mi? (yalnız win32'de anlamlı — darwin'de hiç sorulmaz.) */
function isTransientRenameError(err) {
  return !!err && TRANSIENT_CODES.includes(err.code);
}

/**
 * ÜÇ-DURUMLU SÖZLEŞME (ADR-W7 · ADR-W10 Kural 3) — mutatörün ölçüm yüzü.
 * "Bu platformda rename yeniden-deneme gerektirir mi?" sorusunun dürüst cevabı:
 *   { state:'retrying'  } → win32: geçici kilit beklenir, yeniden denenir
 *   { state:'immediate' } → darwin/linux: tek atış, bugünkü davranış
 *   { state:'unknown'   } → tanımadığımız platform: DAVRANIŞ darwin gibi
 *                           (tek atış) ama bunu "ölçtük" diye sunmuyoruz.
 */
function probeRenameSupport(platform = process.platform) {
  if (platform === 'win32') return { state: 'retrying', attempts: BACKOFF_MS.length + 1, maxWaitMs: BACKOFF_MS.reduce((a, b) => a + b, 0) };
  if (platform === 'darwin' || platform === 'linux') return { state: 'immediate', attempts: 1, maxWaitMs: 0 };
  return { state: 'unknown', attempts: 1, maxWaitMs: 0, reason: `unmapped-platform:${platform}` };
}

/**
 * `fs.renameSync`in TEK giriş kapısı.
 *
 * Başarılıysa `{ from, to, attempts, waitedMs, retried }` döner.
 * Başarısızsa BUGÜNKÜ hatayı fırlatır (sarmalanmaz) — çağıranın `catch`i aynen çalışır.
 *
 * `deps`: { platform, fs, sleep, onRetry } — hepsi test için enjekte edilebilir.
 */
function renameWithRetrySync(from, to, deps = {}) {
  const platform = deps.platform || process.platform;
  const fs = deps.fs || nodeFs;
  const sleep = deps.sleep || sleepSync;
  const onRetry = typeof deps.onRetry === 'function' ? deps.onRetry : null;
  const backoff = Array.isArray(deps.backoffMs) ? deps.backoffMs : BACKOFF_MS;
  // darwin/linux: TEK ATIŞ. Bugünkü satırın kendisi; hiçbir yeni davranış yok.
  const waits = platform === 'win32' ? backoff : [];

  let waitedMs = 0;
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return { from, to, attempts: attempt, waitedMs, retried: attempt > 1 };
    } catch (err) {
      const nextWait = waits[attempt - 1];
      if (nextWait === undefined || !isTransientRenameError(err)) throw err;
      if (onRetry) {
        try { onRetry({ from, to, attempt, code: err.code, nextWaitMs: nextWait }); } catch { /* ölçüm yazımı yazmayı bloklamaz */ }
      }
      waitedMs += sleep(nextWait);
    }
  }
}

/** `${file}.<pid>.<rand>.tmp` — ağaçtaki mevcut geçici-dosya konvansiyonunun aynısı. */
function tmpPathFor(file, deps = {}) {
  const pid = deps.pid ?? process.pid;
  const rand = deps.rand || nodeCrypto.randomBytes(3).toString('hex');
  return `${file}.${pid}.${rand}.tmp`;
}

/**
 * "tmp'ye yaz → hedefin üzerine rename et" deseninin TEK boğazı (790 K1).
 *
 * Bugünkü 26 çağrıdan farkı ÜÇ şey:
 *   1. win32'de rename yeniden denenir (asıl düzeltme),
 *   2. rename kalıcı olarak başarısızsa `tmp` ARTIĞI TEMİZLENİR — bugün her
 *      başarısız yazım diskte bir `.tmp` bırakıyor ve kimse toplamıyor,
 *   3. `mode` hem `writeFileSync` seçeneği hem de restrictPath boğazı üzerinden
 *      uygulanabilir (bkz. `platform/restrictPath.cjs`; burada yalnız POSIX modu
 *      geçirilir, ACL kararı orada verilir).
 *
 * ADP-946 — `inPlaceFallback: true` (OPT-IN, yalnız win32'de etkili): 6 denemenin
 * ardından rename KALICI olarak düştüyse, vazgeçmeden önce hedefe DOĞRUDAN bir
 * yazım denenir. Gerekçe Win32 API farkı: `MoveFileEx` hedefe DELETE erişimi ister,
 * bu yüzden dosyayı `FILE_SHARE_READ|FILE_SHARE_WRITE` ile (DELETE olmadan) açık
 * tutan bir okuyucu — yedekleme ajanı, indeksleyici, senkronizasyon istemcisi —
 * rename'i bloklar ama `CreateFile(GENERIC_WRITE)`'ı BLOKLAMAZ. Yani rename'in
 * kalıcı düşüşü "yazamıyorum" demek DEĞİLDİR; bugüne kadar öyle sayılıyordu ve
 * kullanıcının ayarı/pane defteri sessizce çöpe gidiyordu (ADP-946'da ölçüldü).
 *
 * Bedeli dürüstçe: yerinde yazım ATOMİK DEĞİL (tam o anda çökersek dosya yarım
 * kalabilir). Bu yüzden SON ÇAREdir ve `inPlace:true` ile RAPOR EDİLİR — çağıran
 * "yazıldı ama atomik değil" ile "atomik yazıldı"yı ayırt edebilir. Takas bilinçli:
 * yarım dosya riski küçük ve görünür, sessiz KAYIP kesin ve görünmez.
 *
 * Dönen: `{ file, tmp, attempts, waitedMs, retried, inPlace }`. Hata: rename'in
 * ORİJİNAL hatası (yerinde yazım da düşerse — çağıranın `catch`i aynı kodu görür).
 */
function atomicWriteFileSync(file, data, opts = {}) {
  const fs = opts.fs || nodeFs;
  const platform = opts.platform || process.platform;
  const tmp = opts.tmp || tmpPathFor(file, opts);
  if (opts.mkdir !== false) {
    fs.mkdirSync(nodePath.dirname(file), { recursive: true, ...(opts.dirMode ? { mode: opts.dirMode } : {}) });
  }
  const writeOpts = {};
  if (opts.mode !== undefined) writeOpts.mode = opts.mode;
  if (opts.encoding !== undefined) writeOpts.encoding = opts.encoding;
  fs.writeFileSync(tmp, data, Object.keys(writeOpts).length ? writeOpts : undefined);
  try {
    const r = renameWithRetrySync(tmp, file, opts);
    return { file, tmp, attempts: r.attempts, waitedMs: r.waitedMs, retried: r.retried, inPlace: false };
  } catch (err) {
    // ADP-946 — SON ÇARE (yalnız win32 + opt-in): hedefe doğrudan yaz.
    if (opts.inPlaceFallback === true && platform === 'win32') {
      try {
        fs.writeFileSync(file, data, Object.keys(writeOpts).length ? writeOpts : undefined);
        try { fs.unlinkSync(tmp); } catch { /* artık gereksiz */ }
        if (typeof opts.onInPlace === 'function') {
          try { opts.onInPlace({ file, code: err.code }); } catch { /* ölçüm yazımı bloklamaz */ }
        }
        return { file, tmp, attempts: 0, waitedMs: 0, retried: true, inPlace: true };
      } catch { /* yerinde yazım da düştü → aşağıdaki orijinal hata fırlatılır */ }
    }
    // Artık temizliği: rename kalıcı olarak düştü → yarım kalan tmp'yi bırakma.
    try { fs.unlinkSync(tmp); } catch { /* zaten yok / silinemiyor: yutulur, asıl hata daha önemli */ }
    throw err;
  }
}

/**
 * K2 — LOG/JOURNAL ROTASYONU. `base.N → base.N+1` (en eskiden en yeniye), sonra
 * `base → base.1`.
 *
 * Windows'ta neden ayrı bir sorun: rotasyonun kaynağı ÇOĞU ZAMAN BİZİM KENDİ
 * AÇIK HANDLE'IMIZ. `appendFileSync` handle'ı kapatır, ama bir `createWriteStream`
 * ya da eşzamanlı ikinci bir pencere dosyayı açık tutuyorsa rename düşer →
 * rotasyon DURUR ve dosya sınırsız büyür (790 K2: `paneSessionsJournal`,
 * `mobileDeviceStore`, `main.js` log'u).
 *
 * Yeniden deneme burada da geçerli; ama rotasyon best-effort olduğu için
 * `throwOnFail` varsayılan olarak KAPALI — bugünkü çağıranların üçü de
 * `try { … } catch { /* yoksa geç *\/ }` yazıyor, o semantik korunuyor.
 * Dönen kayıt rotasyonun GERÇEKTEN olup olmadığını söyler (sessiz değil).
 */
function rotateSeriesSync(base, opts = {}) {
  const fs = opts.fs || nodeFs;
  const keep = Number.isFinite(opts.keep) && opts.keep > 0 ? Math.floor(opts.keep) : 3;
  const nameOf = typeof opts.nameOf === 'function' ? opts.nameOf : (i) => `${base}.${i}`;
  const moved = [];
  const failed = [];
  for (let i = keep - 1; i >= 1; i -= 1) {
    const from = nameOf(i);
    const to = nameOf(i + 1);
    try {
      if (!fs.existsSync(from)) continue;
      renameWithRetrySync(from, to, opts);
      moved.push({ from, to });
    } catch (err) {
      failed.push({ from, to, code: err.code || 'ERR' });
    }
  }
  try {
    if (fs.existsSync(base)) {
      renameWithRetrySync(base, nameOf(1), opts);
      moved.push({ from: base, to: nameOf(1) });
    }
  } catch (err) {
    failed.push({ from: base, to: nameOf(1), code: err.code || 'ERR' });
    if (opts.throwOnFail) throw err;
  }
  return { rotated: failed.length === 0 && moved.length > 0, moved, failed };
}

module.exports = {
  TRANSIENT_CODES,
  BACKOFF_MS,
  sleepSync,
  isTransientRenameError,
  probeRenameSupport,
  renameWithRetrySync,
  tmpPathFor,
  atomicWriteFileSync,
  rotateSeriesSync,
};
