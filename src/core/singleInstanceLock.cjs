// ADP-832 (ADR-W5) + ENV-08 — TEK-ÖRNEK KİLİDİ: "bir veri kökü = bir yazar",
// HER PLATFORMDA.
//
// NEDEN VAR. Windows'ta hiçbir şey iki süreci engellemez; macOS'ta ise eski
// varsayım ("LaunchServices aynı bundle'ı ikinci kez açmaz") yalnız AYNI bundle
// için doğruydu. ENV-08 (28.08 olayı): DMG'den doğrudan açılan İKİNCİ prod kopya
// (AppTranslocation kopyası = FARKLI bundle yolu) macOS'ta hiçbir kapıya
// takılmadan Eren'in ~/.crewpane köküne bağlandı, bridge.json'ı kendi
// port/pid'iyle ezdi (65348→61647), liderin sevkleri test kopyasına düştü ve
// kapanırken dosyayı sildi. İki süreç aynı veri kökünü (bridge.json handshake'i,
// live-panes defteri, log/kilit durumu) paylaşırsa ADP-206'nın çözdüğü bozulma
// (kayıt silme, pane koparma) geri gelir — platformdan bağımsız.
//
// NEDEN ELECTRON'UN DAHİLİ KİLİDİ DEĞİL (ÖLÇÜLDÜ — ADP-832 §2.1). ADR-W5 kilidi
// `crewpane-${hash(dataRoot)}` gibi bir ANAHTARLA kapsamlamayı tasarlıyor; ama
// Electron 42'nin imzası `requestSingleInstanceLock(additionalData?)` — anahtar
// parametresi YOK. Kilidin kapsamı Chromium'un ProcessSingleton'ıdır ve
// `userData` DİZİNİNE bağlıdır (ölçüm: aynı userData → ikinci süreç false,
// farklı userData → ikisi de true; kilit artefaktı `<userData>/SingletonLock`).
// Bizim userData'mız ise main.js'te üç instance için de AYNI ada pinlenir
// ('crewpane-shell') → dahili kilit prod/dev/test'i birbirine bağlar ve
// CREWPANE_HOME ile ayrılmış iki koşuyu ayırt EDEMEZ. Yani ADR-W5'in koruduğu
// değişmez (veri kökü kapsamı) dahili API ile İFADE EDİLEMİYOR. Bu yüzden kilit
// veri kökünün İÇİNDE bir dosyadır: kapsam, konumun kendisidir.
//
// TASARIM KURALLARI
//   1. ENV-08 — kilit HER PLATFORMDA uygulanır (eski "yalnız win32" kuralı
//      kalktı; gerekçesi kopya bundle'lar için yanlıştı, yukarıya bak). Bugünkü
//      3-instance düzeni bozulmaz (prod/dev/test veri kökleri zaten ayrık →
//      ayrı kilit kapsamı); paralel e2e de bozulmaz (her koşu mkdtemp
//      CREWPANE_HOME alır — kural 2 kendiliğinden ayırır).
//   2. Kapsam = ÇÖZÜLMÜŞ veri kökü (instancePaths.instanceHome() — CREWPANE_HOME
//      dahil). e2e her koşuda mkdtemp kök aldığı için kendiliğinden ayrışır.
//   3. FAIL-OPEN: kilit dosyası YAZILAMIYORSA (salt-okunur profil, EACCES…)
//      uygulama AÇILABİLİR. "Kilit yazamadım" yüzünden açılmayan bir app,
//      önlemeye çalıştığımız hasardan daha kötüdür. WIN-DUP-INSTANCE-01: bu
//      açılış artık SESSİZ değil — kullanıcı kutuda açıkça onaylar (diyalogsuz
//      yollar: deep-link taşıyıcısı ve AUTO=force eskisi gibi açılır).
//   4. Bayat kilit ASLA kalıcı kapı olmaz: kayıt okunamıyorsa, anahtarı
//      yabancıysa, pid ölüyse veya pid biz'sek kilit DEVRALINIR.
//      HATA-03 ile İKİ HALKA DAHA: (a) kayıt ÖNCEKİ AÇILIŞTAN ise devralınır —
//      Windows pid'leri yeniden dağıtır, "pid canlı" tek başına sahip yaşıyor
//      demek DEĞİLDİR; (b) hiçbir otomatik ölçünün ayıramadığı son durumda
//      (aynı açılış içinde pid geri dönüşümü) kullanıcıya "Yine de aç" düğmesi
//      sunulur. Bu kural artık kanıtlıdır, temenni değil.
//      WIN-DUP-INSTANCE-01 (FB-1012): "Yine de aç" tek tıkla devralıyordu ve kutu
//      metni pencere görünmüyorsa onu ÖĞÜTLÜYORDU → Windows'ta 7 kopya. Artık
//      ikinci bir onay kutusu ister; "Kapat" ise sahibin penceresi kapalıysa onu
//      YENİDEN AÇTIRIR (main.js focusWindow) — "pencere yok" bir daha "kopya yok"
//      gibi okunmasın.
//   5. İkinci kopya sessizce ölmez: odak isteği bırakır (birinci kopya onu
//      izliyor), kullanıcıya nazik mesajı gösterir, sonra çıkar.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
// HATA-03 — ikinci kopya diyalogunun metinleri SÖZLÜKTEN gelir. Bu modül ana
// süreçte, `app.whenReady()`ten ÇOK önce koşuyor; i18n katmanı saf JS olduğu için
// (yalnız iki sözlük nesnesi) o erken noktada güvenle require edilebilir.
const appI18n = require('../../i18n/index.cjs');
// ADP-833 (ADR-W6) — ikinci kopyanın argv'si bir giriş dönüşü TAŞIYOR mu? Taşıyorsa
// o kopya bir "kullanıcı hatası" değil, OS'un kurduğu bir TESLİMATTIR → hata kutusu
// gösterilmez (aşağıda `enforce`).
const deepLinkArgv = require('../services/deepLinkArgv.cjs');

/** Kilit dosyası — veri kökünün İÇİNDE (kapsam = konum). */
const LOCK_FILE = 'single-instance.lock';
/** İkinci kopyanın "beni öne al" isteği. Birinci kopya tüketip SİLER. */
const FOCUS_FILE = 'focus-request.json';
// Kayıt şeması sürümü. HATA-03'te `uptime` alanı EKLENDİ ama sürüm ARTMADI:
// okuyucular alanın VARLIĞINA bakıyor (yoksa duvar saatine düşüyorlar), yani
// eski/yeni sürüm birbirinin kaydını sorunsuz okuyor — ayrışma taşımıyor.
const RECORD_VERSION = 1;
/** Kilit yaratma yarışında (iki kopya aynı anda açılırsa) deneme sayısı. */
const ACQUIRE_ATTEMPTS = 3;
/**
 * HATA-03 — AÇILIŞ (boot) TOLERANSLARI.
 *
 * `uptime` monotoniktir; toleransı sıfıra yakın tutuyoruz — yalnız saniye
 * yuvarlamasını soğurur. Duvar saati yolu (eski kayıtlar) ise NTP düzeltmelerine
 * açıktır, orada tolerans cömerttir: yanlış "bayat" kararı CANLI bir kilidi
 * çalar, yanlış "canlı" kararı ise kullanıcıya yalnız bir düğme bastırır.
 */
const UPTIME_TOLERANCE_S = 5;
const BOOT_TOLERANCE_MS = 10 * 60 * 1000;

/** Makine kaç saniyedir ayakta. Enjekte edilebilir (birim testler ölçebilsin). */
const defaultUptime = () => os.uptime();

/**
 * Veri kökünün kimliği. ADR-W5'in `crewpane-${hash(dataRoot)}` fikri burada
 * yaşıyor: kilit dosyanın KONUMU kapsamı verir, bu anahtar ise kaydın gerçekten
 * BU köke ait olduğunu doğrular (kopyalanmış/taşınmış bir veri kökü, içindeki
 * yabancı pid'le uygulamayı kilitleyemesin).
 *
 * Kanonikleştirme platformdan BAĞIMSIZ tutuldu (her yerde küçük harf + `/`) —
 * kilit yalnız win32'de koşuyor (orada yollar zaten harf-duyarsız), ve böylece
 * birim testi macOS'ta da aynı değeri ölçebiliyor.
 */
function lockKey(dataRoot) {
  const canon = String(dataRoot || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return `crewpane-${crypto.createHash('sha256').update(canon).digest('hex').slice(0, 16)}`;
}

function lockPath(dataRoot) {
  return path.join(dataRoot, LOCK_FILE);
}

function focusPath(dataRoot) {
  return path.join(dataRoot, FOCUS_FILE);
}

/** JSON kayıt okuma — bozuk/eksik dosya `null` (çağıran onu BAYAT sayar). */
function readRecord(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Süreç yaşıyor mu? `kill(pid, 0)` sinyal göndermez, yalnız varlığı sorar.
 * EPERM = süreç VAR ama bize ait değil → YAŞIYOR sayılır (aksi hâlde başka
 * kullanıcının süreci yüzünden kilidi devralıp iki yazar yaratırdık).
 */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!e && e.code === 'EPERM';
  }
}

/**
 * HATA-03 — KAYIT BU AÇILIŞTAN ÖNCE Mİ YAZILDI?
 *
 * NEDEN GEREKLİ. `isProcessAlive` tek başına YETMEZ: Windows pid'leri yeniden
 * dağıtır. Uygulama çöktükten (ya da makine kapandıktan) sonra kilitte yazan pid
 * başka bir sürecin olabilir; `kill(pid,0)` onu görüp "sahip yaşıyor" der ve
 * kilit KALICI KAPIYA dönüşür — kullanıcının gördüğü hata tam olarak budur
 * ("CrewPane zaten açık" diyor ama ortada açık pencere yok, app hiç açılmıyor).
 * Oysa Tasarım Kuralı 4 bunu yasaklıyor.
 *
 * ÖLÇÜ NEDEN `uptime`, NEDEN DUVAR SAATİ DEĞİL. Kayıt yazılırken o anki
 * `os.uptime()` de saklanıyor. Şimdiki uptime kayıttakinden KÜÇÜKSE makine
 * arada yeniden başlamıştır — bu karşılaştırma monotoniktir, NTP düzeltmesi ya
 * da kullanıcının saati değiştirmesi onu yanıltamaz.
 *
 * ESKİ KAYITLAR (0.2.42 ve öncesi) `uptime` taşımıyor: orada elimizde yalnız
 * `startedAt` var, açılış anını duvar saatiyle tahmin ediyoruz. Yükseltmeden
 * ÖNCE oluşmuş bir kilit yüzünden kimse dışarıda kalmasın diye bu yol duruyor.
 *
 * FAIL-CLOSED: uptime ölçülemiyorsa (NaN/negatif) HÜKÜM YOK — canlı görünen bir
 * kilidi asla ölçemediğimiz bir şeye dayanıp çalmayız.
 */
function rebootedSince(holder, { uptime = defaultUptime, now = Date.now } = {}) {
  let up = NaN;
  try { up = Number(uptime()); } catch { return false; }
  if (!Number.isFinite(up) || up < 0) return false;

  if (Number.isFinite(holder.uptime)) {
    return up + UPTIME_TOLERANCE_S < holder.uptime;
  }

  const startedAt = Date.parse(holder.startedAt);
  if (!Number.isFinite(startedAt)) return false;
  const bootedAt = now() - up * 1000;
  return startedAt < bootedAt - BOOT_TOLERANCE_MS;
}

/**
 * Kilidi tutan kayıt hakkında hüküm. `stale:true` → devralınabilir.
 * @returns {{stale:boolean, why:string}}
 */
function holderVerdict(holder, { key, pid, alive = isProcessAlive, uptime = defaultUptime, now = Date.now } = {}) {
  if (!holder) return { stale: true, why: 'unreadable-record' };
  if (holder.key !== key) return { stale: true, why: 'foreign-key' };
  if (holder.pid === pid) return { stale: true, why: 'self-pid' };
  if (!alive(holder.pid)) return { stale: true, why: 'dead-pid' };
  // HATA-03 — pid CANLI görünüyor; ama kayıt önceki açılıştansa o süreç makineyle
  // birlikte öldü, gördüğümüz pid yeniden dağıtılmış bir numaradır.
  if (rebootedSince(holder, { uptime, now })) return { stale: true, why: 'pre-boot-record' };
  return { stale: false, why: 'alive' };
}

/**
 * Kilidi al. Yaratım ATOMİKTİR (`flag: 'wx'` = yoksa yarat, varsa EEXIST) —
 * iki kopya aynı anda açılırsa yalnız biri kazanır. `writeFileSync` bilerek
 * seçildi: `no-real-home-writes` tripwire'ı bu girişi sarıyor, `openSync`'i
 * sarmıyor (birim testler gerçek ~/.crewpane'e yazamasın).
 *
 * HATA-03 — `force:true` KULLANICI KARARIDIR, kod kararı değil: ikinci kopya
 * diyalogunda "Yine de aç" seçildiğinde geliyor. Sahibin kaydına bakılmaksızın
 * kilit devralınır (aynı-açılış pid geri dönüşümü hiçbir otomatik ölçüyle
 * ayırt edilemez; orada tek doğru hakem kullanıcıdır).
 *
 * @returns {{ok:true, key:string, path:string, record:object, forced?:boolean,
 *            degraded?:boolean, reason?:string}
 *          |{ok:false, key:string, path:string, holder:object|null, why:string}}
 */
function acquire(opts = {}) {
  const dataRoot = opts.dataRoot;
  if (!dataRoot) throw new TypeError('acquire: dataRoot required');
  const pid = Number.isInteger(opts.pid) ? opts.pid : process.pid;
  const alive = opts.alive || isProcessAlive;
  const now = opts.now || (() => Date.now());
  const uptime = opts.uptime || defaultUptime;
  const force = !!opts.force;
  const key = lockKey(dataRoot);
  const file = lockPath(dataRoot);
  // HATA-03 — `uptime`: yazım anında makine kaç saniyedir ayakta. EK BİR ALAN,
  // sürüm kırmıyor: eski sürüm alanı görmezden gelir, yeni sürüm yokluğunda
  // duvar saatine düşer (bkz. rebootedSince).
  let uptimeAtWrite = null;
  try {
    const up = Number(uptime());
    if (Number.isFinite(up) && up >= 0) uptimeAtWrite = Math.floor(up);
  } catch { /* ölçülemedi → alan null, eski yola düşülür */ }
  const record = {
    v: RECORD_VERSION,
    key,
    pid,
    startedAt: new Date(now()).toISOString(),
    uptime: uptimeAtWrite,
    instanceId: opts.instanceId || null,
    exec: opts.exec || null,
  };

  try {
    fs.mkdirSync(dataRoot, { recursive: true });
    let holder = null;
    let why = 'contended';
    for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
      try {
        fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
        return force
          ? { ok: true, key, path: file, record, forced: true }
          : { ok: true, key, path: file, record };
      } catch (e) {
        if (!e || e.code !== 'EEXIST') throw e;
        holder = readRecord(file);
        const verdict = force
          ? { stale: true, why: 'forced' }
          : holderVerdict(holder, { key, pid, alive, uptime, now });
        why = verdict.why;
        if (!verdict.stale) return { ok: false, key, path: file, holder, why };
        // Bayat → sil ve tekrar dene (silme yarışını başkası kazanırsa döngü
        // yeniden okur ve bu kez CANLI kaydı görüp reddedilir — doğru sonuç).
        try { fs.unlinkSync(file); } catch { /* başkası sildi; retry yeter */ }
      }
    }
    return { ok: false, key, path: file, holder, why };
  } catch (e) {
    // FAIL-OPEN (kural 3): kilit altyapısı çalışmıyorsa uygulama açılır.
    return { ok: true, key, path: file, record, degraded: true, reason: `${e && e.code ? `${e.code}: ` : ''}${e && e.message}` };
  }
}

/** Kilidi bırak — YALNIZ kayıt bizimse (başkasının kilidini asla silmeyiz). */
function release(opts = {}) {
  const dataRoot = opts.dataRoot;
  if (!dataRoot) return false;
  const pid = Number.isInteger(opts.pid) ? opts.pid : process.pid;
  const file = lockPath(dataRoot);
  const holder = readRecord(file);
  if (!holder || holder.pid !== pid) return false;
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * ADP-837 (P7) — YENİDEN BAŞLATMADAN ÖNCE KİLİDİ BIRAK.
 *
 * NEDEN AYRI BİR GİRİŞ. `enforce()` kilidi iki kancayla bırakır: `will-quit` ve
 * `process 'exit'`. Uygulamanın yeniden başlatma yolu ise `app.relaunch()` +
 * **`app.exit(0)`** kullanıyor — ve Electron belgesi `app.exit()` için açıkça
 * "before-quit ve will-quit YAYILMAZ" diyor. Geriye tek kemer olarak Node'un
 * `exit` olayı kalıyor; onun `app.exit()` altında koştuğu GARANTİ DEĞİL.
 *
 * Kalırsa ne olur: yeni süreç kilidi ESKİ pid ile dolu bulur. Kural 4 (bayat
 * kilit devralınır) bunu genelde kurtarır — ama YALNIZ eski süreç o an ölmüşse.
 * Yeniden başlatmada iki süreç ömrü tanım gereği ÜST ÜSTE BİNEBİLİR; o pencerede
 * yeni kopya "CrewPane zaten açık" kutusunu gösterip ÇIKAR ve kullanıcı için
 * uygulama yeniden başlatmadan GERİ GELMEZ. Bu fonksiyon o bağımlılığı komple
 * kaldırır: kilidi biz, çıkmadan önce, açıkça bırakırız.
 *
 * ENV-08 — kilit her platformda uygulandığı için bırakma da her platformda koşar
 * (eski win32-only erken dönüş kalktı; `opts.platform` geri uyum için imzada
 * duruyor ama kararı değiştirmiyor).
 *
 * @param {object} opts
 * @param {string} opts.dataRoot
 * @param {string} [opts.platform]
 * @param {number} [opts.pid]
 * @param {Function} [opts.log]
 * @returns {{released:boolean, reason?:string}}
 */
function releaseForRelaunch(opts = {}) {
  void (opts.platform || process.platform); // ENV-08 — karar platformdan bağımsız
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const released = release({ dataRoot: opts.dataRoot, pid: opts.pid });
  log(released ? 'yeniden başlatma öncesi kilit bırakıldı' : 'yeniden başlatma: bırakılacak kilit yok');
  return { released, reason: released ? 'released' : 'not-holder' };
}

/**
 * İkinci kopyanın odak isteği. `argv`/`cwd` BİLEREK yazılıyor: ADR-W6 (Windows
 * deep-link) bu payload'ı TÜKETİR — Chromium'un `second-instance` argv'sinden
 * farklı olarak burada sıra ve içerik BOZULMAZ. ADP-833'ten beri birinci kopya
 * yalnız pencereyi öne almaz, `record.argv`'deki giriş dönüşünü de işler
 * (main.js `focusWindow` → `consumeArgvDeepLink`).
 *
 * ⚠️ Payload bir PKCE `code` taşıyabilir → diskte kalış süresi mümkün olan en
 * kısa tutulur: `watchFocusRequests` dosyayı OKUMADAN ÖNCE değil, okur okumaz
 * SİLER ve izleyici başlarken bekleyen istekleri de süpürür.
 */
function requestFocus(opts = {}) {
  const dataRoot = opts.dataRoot;
  if (!dataRoot) return false;
  const now = opts.now || (() => Date.now());
  const payload = {
    v: RECORD_VERSION,
    key: lockKey(dataRoot),
    requestedBy: Number.isInteger(opts.pid) ? opts.pid : process.pid,
    at: new Date(now()).toISOString(),
    argv: Array.isArray(opts.argv) ? opts.argv.slice() : [],
    cwd: typeof opts.cwd === 'string' ? opts.cwd : null,
  };
  try {
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(focusPath(dataRoot), `${JSON.stringify(payload, null, 2)}\n`);
    return true;
  } catch {
    return false; // odak en iyi-çaba; başarısızlığı ikinci kopyayı durdurmaz
  }
}

/**
 * Kilit SAHİBİ tarafı: odak isteklerini izler. İstek dosyası TÜKETİLİR (okunup
 * silinir) → aynı istek iki kez işlenmez ve auth callback taşıyan bir argv
 * diskte kalmaz.
 *
 * @returns {{stop:()=>void}}
 */
function watchFocusRequests(opts = {}) {
  const dataRoot = opts.dataRoot;
  const onRequest = typeof opts.onRequest === 'function' ? opts.onRequest : () => {};
  const log = opts.log || (() => {});
  const file = focusPath(dataRoot);

  const consume = () => {
    let record = null;
    try {
      if (!fs.existsSync(file)) return;
      record = readRecord(file);
    } catch { /* yarış: dosya arada silindi */ }
    try { fs.unlinkSync(file); } catch { /* zaten yok */ }
    if (record) {
      try { onRequest(record); } catch (e) { log(`focus handler error: ${e && e.message}`); }
    }
  };

  // Kilidi almadan ÖNCE yazılmış bir istek olabilir (açılış yarışı) → süpür.
  consume();

  let watcher = null;
  try {
    watcher = fs.watch(dataRoot, (_event, name) => {
      if (!name || name === FOCUS_FILE) consume();
    });
    watcher.on('error', (e) => log(`focus watcher error: ${e && e.message}`));
    // WIN-DUP-INSTANCE-01 — izleyici döngüyü AYAKTA TUTMAZ: Electron'da uygulama
    // zaten yaşıyor; `node --test`te ise `release()` çağrılmayan her birinci-kopya
    // testi bu tutamaçla süreci asılı bırakıyordu (taban kolunda ölçüldü: 66/66
    // geçti, dosya 20 sn'de "timed out"). Davranış bit-bit aynı, yalnız ref düşer.
    try { if (typeof watcher.unref === 'function') watcher.unref(); } catch { /* best-effort */ }
  } catch (e) {
    log(`focus watcher unavailable: ${e && e.message}`); // en iyi-çaba
  }
  return {
    stop() {
      try { if (watcher) watcher.close(); } catch { /* best-effort */ }
    },
  };
}

/**
 * İkinci kopyanın gördüğü diyalog — suçlayıcı değil, ne yapacağını söyleyen.
 *
 * HATA-03 — İKİ DEĞİŞİKLİK:
 *   1. Metin SÖZLÜKTEN gelir (kodda gömülü Türkçe kalırsa İngilizce kullanıcı
 *      anlamadığı bir kutu görür).
 *   2. İkinci düğme: "Yine de aç". Otomatik bayatlık ölçüsü (rebootedSince)
 *      AYNI AÇILIŞ içinde geri dönüştürülmüş bir pid'i ayırt EDEMEZ; o dar
 *      pencerede kararı kullanıcı verir. Kilit hiçbir koşulda kalıcı kapı olmaz.
 */
function secondCopyDialog(holder, locale, { degraded = false } = {}) {
  const tr = (key, params) => appI18n.t(key, params, locale);
  // SAHİP DAMGASI SÖZLÜKTE DEĞİL, BİLEREK: içinde çevrilecek tek sözcük yok
  // ("PID" + sayı + ISO zaman damgası). Sözlüğe konsaydı TR ve EN değerleri
  // birebir aynı olur ve çeviri kapısı (scripts/check-i18n.mjs) haklı olarak
  // "çevrilmemiş" diye kırmızı verirdi.
  const who = holder && holder.pid
    ? ` (PID ${holder.pid}${holder.startedAt ? ` · ${holder.startedAt}` : ''})`
    : '';
  // WIN-DUP-INSTANCE-01 — koruma KURULAMADIYSA (kural 3, degraded) kutu başka
  // konuşur: ortada bir sahip yok, "yazamadık" var. Düğmeler aynı (Kapat / Yine de
  // aç / Ayrı profil) — ayrı profil burada gerçekten işe yarar (başka veri kökü).
  const ns = degraded ? 'main.singleInstance.degraded' : 'main.singleInstance';
  return {
    title: tr(`${ns}.title`),
    message: tr(`${ns}.message`),
    detail: tr(`${ns}.detail`, { who }),
    buttons: [
      tr('main.singleInstance.button.close'),
      tr('main.singleInstance.button.openAnyway'),
      tr('main.singleInstance.button.separateProfile'), // ENV-08
    ],
  };
}

/**
 * WIN-DUP-INSTANCE-01 — "Yine de aç"ın İKİNCİ kutusu (açık onay).
 *
 * NEDEN. FB-1012 (Windows, 0.2.45): aynı veri kökünde 7 canlı kopya ölçüldü.
 * Kilidin otomatik ölçüleri (ölü pid / önceki açılış / yabancı anahtar) geçilmedi;
 * geçilen kural HATA-03'ün 4b'siydi — "Yine de aç" tek tıkla kilidi devralıyordu
 * ve eski kutu metni, pencere görünmüyorsa TAM BUNU yapmayı ÖĞÜTLÜYORDU. Windows'ta
 * X'e basmak pencereyi kapatıp süreci yaşatıyordu (HATA-14), yani "pencere yok ama
 * kopya canlı" NORMAL durumdu → her açılış bir kopya daha doğurdu. Onay kutusunun
 * varsayılanı ve iptali "Vazgeç"tir: Enter/Esc devralmaz, yalnız açık tıklama devralır.
 */
function secondCopyConfirmDialog(locale) {
  const tr = (key) => appI18n.t(key, undefined, locale);
  return {
    title: tr('main.singleInstance.confirm.title'),
    message: tr('main.singleInstance.confirm.message'),
    detail: tr('main.singleInstance.confirm.detail'),
    buttons: [
      tr('main.singleInstance.confirm.button.cancel'),
      tr('main.singleInstance.confirm.button.yes'),
    ],
  };
}

/** Düğmesiz (`showErrorBox`) yola düşen çağıranlar için düz metin gövde. */
function secondCopyMessage(holder, locale) {
  const d = secondCopyDialog(holder, locale);
  return `${d.message}\n\n${d.detail}`;
}

/**
 * main.js'in çağırdığı tek giriş. ENV-08'den beri HER platformda uygulanır.
 *
 * @param {object} opts
 * @param {object} opts.app        Electron `app` (enjekte — test edilebilirlik)
 * @param {object} [opts.dialog]   Electron `dialog`
 * @param {string} opts.dataRoot   Çözülmüş veri kökü (instancePaths.instanceHome())
 * @param {string} [opts.platform] Varsayılan `process.platform`
 * @param {object} [opts.env]      Varsayılan `process.env`
 * @param {string} [opts.deepLinkPrefix] ADP-833 — bu kopyanın URL şeması (`crewpane://`).
 *        Verilirse: argv bu öneki taşıyan ikinci kopya hata kutusu GÖRMEZ (OS teslimatı).
 * @param {string} [opts.locale] HATA-03 — ikinci kopya diyalogunun dili ('tr'|'en').
 *        Verilmezse i18n katmanının o anki dili. Kilit kapısı ayar dosyasından ÖNCE
 *        koştuğu için (veri köküne tek bir yazma bile olmadan) çağıran bu değeri
 *        işletim sisteminin dilinden çözer — bkz. main.js çağrı yeri.
 * @param {Function} [opts.focusWindow] Sahip tarafı: pencereyi öne al (+ argv'deki
 *        deep-link'i tüket — çağıran tarafın işi, kayıt `record.argv` ile gelir)
 * @returns {{enforced:boolean, primary?:boolean, reason?:string, holder?:object|null,
 *           degraded?:boolean, key?:string, watcher?:{stop:()=>void}}}
 */
function enforce(opts = {}) {
  // ENV-08 — `platform` kararı artık DEĞİŞTİRMİYOR (kilit her platformda);
  // parametre imzada kalıyor ki çağıranlar/testler platformu açık yazmayı sürdürsün.
  void (opts.platform || process.platform);
  const env = opts.env || process.env;
  const log = opts.log || (() => {});

  // Kaçış kapağı: kilit bir gün yolu tıkarsa kullanıcı/otomasyon açabilsin.
  if (env.CREWPANE_SINGLE_INSTANCE === '0') {
    log('kilit ATLANDI — CREWPANE_SINGLE_INSTANCE=0');
    return { enforced: false, reason: 'disabled-by-env' };
  }

  const dataRoot = opts.dataRoot;
  const app = opts.app;
  const acquireOpts = {
    dataRoot,
    instanceId: opts.instanceId || null,
    exec: opts.exec || (Array.isArray(opts.argv) ? opts.argv[0] : null),
    pid: opts.pid,
    alive: opts.alive,
    now: opts.now,
    uptime: opts.uptime,
  };
  const res = acquire(acquireOpts);

  // HATA-03 — BİRİNCİ KOPYA OLMA YOLU TEK YERDE. İki giriş var: kilidi normal
  // almak ve kullanıcının "Yine de aç" demesiyle devralmak. İkisi de AYNI
  // kancaları (odak izleyici + will-quit/exit bırakma) kurmak zorunda; ayrı iki
  // kopya kod olsaydı devralan kopya kilidi çıkarken bırakmayı unuturdu.
  const becomePrimary = (taken) => {
    if (taken.degraded) log(`kilit YAZILAMADI, fail-open ile devam: ${taken.reason}`);
    else log(`kilit alındı: ${taken.path} (key=${taken.key})${taken.forced ? ' [DEVRALINDI]' : ''}`);
    const watcher = watchFocusRequests({
      dataRoot,
      log,
      onRequest: (record) => {
        log(`odak isteği alındı (pid ${record.requestedBy})`);
        try {
          if (typeof opts.focusWindow === 'function') opts.focusWindow(record);
        } catch (e) {
          log(`focusWindow error: ${e && e.message}`);
        }
      },
    });
    const letGo = () => {
      watcher.stop();
      release({ dataRoot, pid: opts.pid });
    };
    try {
      if (app && typeof app.on === 'function') app.on('will-quit', letGo);
      // 'will-quit' bazı çıkışlarda (app.exit / sinyal) ateşlenmez → ikinci kemer.
      if (opts.process && typeof opts.process.on === 'function') opts.process.on('exit', letGo);
      else process.on('exit', letGo);
    } catch (e) {
      log(`release hook error: ${e && e.message}`);
    }
    return {
      enforced: true,
      primary: true,
      key: taken.key,
      degraded: !!taken.degraded,
      forced: !!taken.forced,
      watcher,
      release: letGo,
    };
  };

  if (res.ok && !res.degraded) return becomePrimary(res);

  // WIN-DUP-INSTANCE-01 — FAIL-OPEN ARTIK SESSİZ DEĞİL (kural 3 daraltıldı).
  // Kilit YAZILAMADIYSA uygulama yine açılabilir, ama yalnız kullanıcı açıkça
  // onaylayınca: ortada canlı bir sahip olup olmadığını ÖLÇEMEDİK, iki yazar
  // riski gerçek. Diyalogsuz yollar karar veremez: deep-link taşıyıcısı (OS
  // teslimatı, ADP-833) ve CREWPANE_SECOND_COPY_AUTO=force eskisi gibi açılır;
  // AUTO=close/separate ise ikinci kopya gibi davranır. Bu aşağıdaki ortak
  // ikinci-kopya makinesine `holder=null` ile girer; "Yine de aç" oradaki
  // `acquire({force:true})` ile yine degraded-ok döner ve `becomePrimary` fail-open
  // satırını loglar — tek kod yolu.
  const degraded = !!(res.ok && res.degraded);
  if (degraded) {
    log(`kilit YAZILAMADI (${res.reason}) — fail-open yalnız açık onayla (WIN-DUP-INSTANCE-01)`);
    res.holder = null;
    res.why = `degraded:${res.reason}`;
  } else {
    // --- İkinci kopya: odak isteği → (gerekiyorsa) nazik mesaj → çık ---
    log(`kilit REDDEDİLDİ (${res.why}); sahip pid=${res.holder && res.holder.pid}`);
  }
  // ODAK İSTEĞİ — "ÖNE AL" YALNIZ AYRILIRKEN (ENV-08-FIX-01). Ölçüldü (paketli
  // 0.2.43-dev.1, frontprobe): istek YAZILIR YAZILMAZ birinci kopya kendini öne
  // alıyor (t+2,5 sn) ve ikinci kopyanın uyarısı ondan SONRA açıldığı için (t+3,6 sn)
  // BİRİNCİ KOPYANIN PENCERESİNİN ARKASINDA kalıyordu — `app.focus({steal:true})`
  // penceresiz bir uygulamada bu yarışı kazanmıyor. Kullanıcıya soru sorarken önü
  // karşı tarafa vermek zaten yanlış: istek artık kopya GERÇEKTEN ayrılırken
  // yazılıyor ("Kapat" = "açık olanı göster"). Diyalogsuz yollarda (deep-link
  // teslimatı, CREWPANE_SECOND_COPY_AUTO) hemen yazılır — davranış bit-bit aynı.
  // Yan fayda: "Yine de aç"/"Ayrı profil" artık isteği YAZIP SİLMİYOR (izleyici
  // arada onu tüketebiliyordu — sessiz yarış).
  let focused = false;
  const askFocus = () => {
    if (focused) return focused;
    focused = requestFocus({ dataRoot, argv: opts.argv, cwd: opts.cwd, pid: opts.pid, now: opts.now });
    log(`odak isteği yazıldı=${focused}`);
    return focused;
  };
  // ADP-833 (ADR-W6) — TAŞIYICI KOPYA SESSİZ ÇIKAR. Windows'ta giriş dönüşü
  // "yeni bir süreç + argv'de URL" olarak gelir; o süreç kullanıcının AÇTIĞI ikinci
  // kopya değil, OS'un kurduğu TESLİMAT ARACIDIR. Ona "CrewPane zaten açık" hata
  // kutusu göstermek, kullanıcının hiç yapmadığı bir hatayı ona söylemek olur —
  // üstelik giriş TAM O SIRADA başarıyla tamamlanırken. Prefix verilmezse (eski
  // çağıranlar) davranış bit-bit eskisi gibidir: kutu gösterilir.
  const carriedDeepLink = deepLinkArgv.deepLinkFromArgv(opts.argv, opts.deepLinkPrefix);
  const locale = appI18n.isLocale(opts.locale) ? opts.locale : appI18n.getLocale();
  // ENV-08 — OTOMASYON DİKİŞİ: native diyalog otomasyonla tıklanamaz; e2e/betikler
  // ikinci kopya kararını env ile beyan eder. Deep-link taşıyan kopyada YOK
  // SAYILIR: teslimat aracı karar veremez, sessizce çıkar (ADP-833 sözleşmesi).
  const auto = typeof env.CREWPANE_SECOND_COPY_AUTO === 'string'
    ? env.CREWPANE_SECOND_COPY_AUTO.trim().toLowerCase() : '';

  // ── ENV-08-FIX-01 — KARAR ERKEN KALIR, YÜZEY READY'YE ERTELENİR ───────────
  //
  // ÖLÇÜM (REL-0243-QA §3 F-A, 0.2.43 yayın engelleyicisi): paketli macOS'ta
  // ikinci kopya açılınca kilit KARARI doğruydu (sahibin kilidi/bridge.json'ı
  // dokunulmadı, odak isteği birinci kopyaya gitti) ama DİYALOG hiç çizilmedi:
  // pencere 0, kutu 0, süreç sonsuza dek uykuda. Kök neden yığın örneğiyle
  // ölçüldü — `enforce()` `app.whenReady()`ten ÖNCE koşuyor, orada
  // `showMessageBoxSync` "dialog module can only be used after app is ready"
  // atıyor, catch dalındaki `showErrorBox` yedeği ise bu Electron'da NSAlert'i
  // SUNMADAN dönüyor. Sonuç: kullanıcı hiçbir şey görmüyor, görünmez kopya Force
  // Quit istiyor ve HATA-03'ün "Yine de aç" kaçış kapağı ölü kalıyor.
  //
  // ÇÖZÜM. İkiye ayır:
  //   • KARAR (yukarıdaki `acquire`) ERKEN kalır — veri güvenliği buna bağlı:
  //     ikinci kopya veri köküne tek bayt yazamadan reddedilmiş olur.
  //   • YÜZEY (düğmeli diyalog + ona bağlı çıkış/devralma/relaunch) `whenReady`
  //     SONRASINA ertelenir. Ready'ye kadar `app.exit` ÇAĞRILMAZ: yarım çizilmiş
  //     bir kutunun arkasında asılı kalan süreç kalmaz.
  // Ertelenen kopya bu arada modül yüklemesine devam eder; veri köküne yazan her
  // şey main.js'te `app.whenReady()` İÇİNDEDİR (`initLog()` dahil) ve bizim
  // kancamız EN ERKEN kaydedilen whenReady olduğu için hepsinden ÖNCE koşar —
  // "Kapat" seçildiğinde süreç o yazımların hiçbirine ulaşmadan biter (e2e adım 4
  // bunu sahibin kilidi + bridge.json'ı üzerinden ölçüyor).
  //
  // TEK KOD YOLU: platform dalı YOK (PIPE-03 dersi). Windows/Linux da aynı sırayı
  // izler — `showErrorBox`in orada ready-öncesi görünüp görünmediğine bahis
  // oynamıyoruz. Diyalogsuz yollar (deep-link teslimatı, `CREWPANE_SECOND_COPY_AUTO`)
  // ERKEN kalır: ertelenecek bir yüzey yok, davranışları bit-bit aynı (e2e dikişi).

  // AÇILIŞ BARİYERİ. `app.exit()` ASENKRONDUR (main.js ENV-01 kapısında ölçülmüş
  // ve orada da `return` ile kesiliyor): ready SONRASINDA çağrıldığında sırada
  // bekleyen `app.whenReady()` kancaları KOŞMAYA DEVAM EDER. Ölçüldü (paketli
  // 0.2.43-dev.1, ENV-08-FIX-01 sürücüsü): "Kapat"tan sonra ölmekte olan kopya
  // hesabı bağladı, standalone sunucuyu ve Next'i başlattı — yani tam da
  // engellemeye çalıştığımız İKİNCİ YAZAR oldu ve süreç 30 sn'de bile ölmedi.
  // Bu yüzden karar "çık" ise bayrak kalkar; main.js kendi ready kancasının ilk
  // satırında bu bayrağa bakıp açılışın kalanını KESER.
  let bootStopped = false;
  // ...ve karar HENÜZ VERİLMEDİYSE açılış BEKLER. Asenkron kutuya geçince (K3)
  // senkron modal'ın açılışı bloklama yan etkisi kayboldu: ölçüldü — main.js'in
  // ready kancası kutu ekrandayken koştu, taşınma uyarısını gösterdi ve sunucuları
  // başlattı. Bu yüzden bariyer bir BAYRAK değil, bir SÖZ: main.js kararı bekler,
  // "Yine de aç" ise açılış kaldığı yerden sürer.
  let settleDecision = null;
  const decided = new Promise((r) => { settleDecision = r; });
  const finish = (stop) => {
    bootStopped = stop;
    try { if (settleDecision) settleDecision(stop); } catch { /* best-effort */ }
  };

  /**
   * Kullanıcı/otomasyon kararını UYGULA. Erken (diyalogsuz) yolda doğrudan,
   * diyalog yolunda ready sonrasında çağrılır — tek gövde, iki çağrı yeri.
   */
  const applyDecision = ({ openAnyway = false, separateProfile = false } = {}) => {
    // ENV-08 — "Ayrı test profiliyle aç": aynı ikili --instance=test ile yeniden
    // başlar → veri kökü ~/.crewpane-test, bridge dosyası da orada; sahibin
    // dünyasına tek bayt yazılmaz. Odak isteği geri alınır (ayrı profil isteyen
    // kullanıcı birincil pencerenin öne fırlamasını istemedi).
    if (separateProfile) {
      finish(true);
      log('ikinci kopya AYRI TEST PROFİLİYLE yeniden başlatılıyor (--instance=test) — açılışın kalanı KESİLDİ');
      try { fs.unlinkSync(focusPath(dataRoot)); } catch { /* zaten yok */ }
      const args = (Array.isArray(opts.argv) ? opts.argv.slice(1) : process.argv.slice(1))
        .filter((a) => !/^--(crewpane-)?instance=/.test(a))
        .concat(['--instance=test']);
      try {
        if (app && typeof app.relaunch === 'function') app.relaunch({ args });
      } catch (e) { log(`relaunch error: ${e && e.message}`); }
      try {
        if (app && typeof app.exit === 'function') app.exit(0);
        else if (app && typeof app.quit === 'function') app.quit();
      } catch (e) { log(`exit error: ${e && e.message}`); }
      return {
        enforced: true,
        primary: false,
        separateProfile: true,
        stopBoot: () => bootStopped,
        whenDecided: () => decided,
        holder: res.holder,
        why: res.why,
        focusRequested: focused,
        deepLink: null,
      };
    }

    if (openAnyway) {
      log('kullanıcı "Yine de aç" dedi — kilit DEVRALINIYOR');
      finish(false); // açılış SÜRSÜN: bu kopya birinci olacak
      // Az önce bıraktığımız odak isteğini geri al: devralan kopya birinci kopya
      // olur ve izleyici o isteği KENDİNE teslim ederdi (kendi argv'sindeki
      // deep-link'i iki kez işlemek dahil).
      try { fs.unlinkSync(focusPath(dataRoot)); } catch { /* zaten yok */ }
      const forced = acquire({ ...acquireOpts, force: true });
      if (forced.ok) return becomePrimary(forced);
      log(`devralma BAŞARISIZ (${forced.why}) — ikinci kopya olarak çıkılıyor`);
    }

    finish(true);
    askFocus(); // ayrılıyoruz: ŞİMDİ birinci kopyayı öne al
    log('ikinci kopya KAPANIYOR — açılışın kalanı KESİLDİ (app.exit asenkron)');
    try {
      if (app && typeof app.exit === 'function') app.exit(0);
      else if (app && typeof app.quit === 'function') app.quit();
    } catch (e) {
      log(`exit error: ${e && e.message}`);
    }
    return {
      enforced: true,
      primary: false,
      stopBoot: () => bootStopped,
      whenDecided: () => decided,
      holder: res.holder,
      why: res.why,
      focusRequested: focused,
      deepLink: carriedDeepLink, // ADP-833 — ne teslim edildiği ölçülebilir olsun
    };
  };

  /** Diyaloğu göster, kullanıcının seçimini karara çevir. */
  const askUser = () => {
    const box = secondCopyDialog(res.holder, locale, { degraded });
    try {
      if (opts.dialog && typeof opts.dialog.showMessageBoxSync === 'function') {
        // HATA-03 — varsayılan ve iptal DÜĞMESİ 0 ("Kapat"): Enter/Esc/pencere
        // kapatma hiçbir zaman kilidi devralmaz, yalnız açık tıklama devralır.
        const picked = opts.dialog.showMessageBoxSync({
          type: 'warning',
          title: box.title,
          message: box.message,
          detail: box.detail,
          buttons: box.buttons,
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (picked !== 1) return { openAnyway: false, separateProfile: picked === 2 }; // ENV-08 — 2 = ayrı profil
        // WIN-DUP-INSTANCE-01 — "Yine de aç" AÇIK ONAY ister (ikinci kutu, varsayılan Vazgeç).
        const confirm = secondCopyConfirmDialog(locale);
        const sure = opts.dialog.showMessageBoxSync({
          type: 'warning',
          title: confirm.title,
          message: confirm.message,
          detail: confirm.detail,
          buttons: confirm.buttons,
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        log(sure === 1 ? '"Yine de aç" ONAYLANDI (ikinci kutu)' : '"Yine de aç" onay kutusunda VAZGEÇİLDİ');
        return { openAnyway: sure === 1, separateProfile: false };
      }
      if (opts.dialog && typeof opts.dialog.showErrorBox === 'function') {
        // Geri uyum: düğmeli API'yi enjekte etmeyen çağıran ADP-832 davranışını alır.
        opts.dialog.showErrorBox(box.title, secondCopyMessage(res.holder, locale));
      }
    } catch (e) {
      log(`dialog error: ${e && e.message}`);
      // Yedek yol KALIYOR (düğmesiz kutu) ama artık TEK savunma değil: asıl
      // düzeltme kutunun ready SONRASINDA çıkması. Buraya düşersek kullanıcı en
      // azından NEDENİ görür, kopya güvenle çıkar (veri kökü korunur).
      try {
        if (opts.dialog && typeof opts.dialog.showErrorBox === 'function') {
          opts.dialog.showErrorBox(box.title, secondCopyMessage(res.holder, locale));
        }
      } catch { /* headless */ }
    }
    return { openAnyway: false, separateProfile: false };
  };

  // WIN-DUP-INSTANCE-01 — diyalogsuz yollarda degraded kararı: taşıyıcı kopya ve
  // AUTO=force eskisi gibi AÇILIR (sorulacak kimse yok / beyan env'de).
  if (degraded && (carriedDeepLink || auto === 'force')) {
    log(`fail-open ile devam (${carriedDeepLink ? 'deep-link taşıyıcısı' : 'CREWPANE_SECOND_COPY_AUTO=force'})`);
    return becomePrimary(res);
  }

  // ADP-833 (ADR-W6) — taşıyıcı kopya SESSİZ çıkar (gerekçe yukarıda).
  if (carriedDeepLink) {
    askFocus(); // teslimat aracı: argv'deki dönüş birinci kopyaya GECİKMEDEN gitmeli
    log(`deep-link taşıyan kopya — hata kutusu GÖSTERİLMEDİ (${carriedDeepLink.split('?')[0]})`);
    return applyDecision();
  }
  if (auto === 'close' || auto === 'separate' || auto === 'force') {
    askFocus(); // diyalogsuz yol: davranış ADP-832/HATA-03'teki gibi kalsın
    log(`ikinci kopya kararı env'den (CREWPANE_SECOND_COPY_AUTO=${auto}) — diyalog atlandı`);
    return applyDecision({ openAnyway: auto === 'force', separateProfile: auto === 'separate' });
  }

  /**
   * Ready sonrası yol: ASENKRON kutu. Neden `showMessageBoxSync` DEĞİL — ölçüldü
   * (paketli 0.2.43-dev.1): pencere-siz bir uygulamada `app.focus({steal:true})`
   * kutu AÇILMADAN ÖNCE çağrılınca macOS uygulamayı öne almıyor ve uyarı, AYNI
   * bundle'ın diğer kopyasının penceresinin ARKASINDA kalıyor (AX'te var, ekranda
   * görünmüyor — kullanıcı için "kutu yok"tan farksız). Senkron API çağrı yığınını
   * modal'ın içinde tuttuğu için kutu AÇILDIKTAN SONRA hiçbir şey yapamıyoruz.
   * Asenkron API'de kutu açılır, kontrol döngüye döner ve uygulamayı ÖNE ALIRIZ —
   * modal onunla birlikte gelir. Sync API'yi enjekte eden çağıranlar (birim
   * testler / eski çağıranlar) eski yola düşer: davranış bit-bit aynı.
   */
  const askUserAsync = async () => {
    if (!opts.dialog || typeof opts.dialog.showMessageBox !== 'function') return askUser();
    const box = secondCopyDialog(res.holder, locale, { degraded });
    const raise = () => { try { if (typeof app.focus === 'function') app.focus({ steal: true }); } catch { /* best-effort */ } };
    try {
      const pending = opts.dialog.showMessageBox({
        type: 'warning',
        title: box.title,
        message: box.message,
        detail: box.detail,
        buttons: box.buttons,
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      raise();                       // kutu açıldı: ŞİMDİ öne al
      setTimeout(raise, 400);        // pencere sunucusu geç yerleştirirse ikinci deneme
      const picked = await pending;
      const idx = picked && typeof picked.response === 'number' ? picked.response : 0;
      if (idx !== 1) return { openAnyway: false, separateProfile: idx === 2 };
      // WIN-DUP-INSTANCE-01 — "Yine de aç" AÇIK ONAY ister (ikinci kutu, varsayılan Vazgeç).
      const confirm = secondCopyConfirmDialog(locale);
      const sure = await opts.dialog.showMessageBox({
        type: 'warning',
        title: confirm.title,
        message: confirm.message,
        detail: confirm.detail,
        buttons: confirm.buttons,
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      const ok = !!(sure && sure.response === 1);
      log(ok ? '"Yine de aç" ONAYLANDI (ikinci kutu)' : '"Yine de aç" onay kutusunda VAZGEÇİLDİ');
      return { openAnyway: ok, separateProfile: false };
    } catch (e) {
      log(`dialog error: ${e && e.message}`);
      try {
        if (typeof opts.dialog.showErrorBox === 'function') {
          opts.dialog.showErrorBox(box.title, secondCopyMessage(res.holder, locale));
        }
      } catch { /* headless */ }
      return { openAnyway: false, separateProfile: false };
    }
  };

  // Diyalog yolu. `app` ready DEĞİLSE yüzeyi ertele; ready ise (ya da çağıran
  // ready durumunu bildirmiyorsa — birim testlerin sade `app` casusu) eskisi gibi
  // hemen sor.
  const notReady = !!app && typeof app.whenReady === 'function'
    && typeof app.isReady === 'function' && !app.isReady();
  if (!notReady) return applyDecision(askUser());

  log('ikinci kopya diyaloğu READY SONRASINA ertelendi (ENV-08-FIX-01) — ready öncesi exit YOK');
  app.whenReady().then(async () => {
    try { if (typeof app.focus === 'function') app.focus({ steal: true }); } catch { /* best-effort */ }
    log('ikinci kopya diyaloğu gösteriliyor (ready SONRASI)');
    applyDecision(await askUserAsync());
  }).catch((e) => {
    log(`ertelenmiş diyalog gösterilemedi (${e && e.message}) — kopya güvenle çıkıyor`);
    try { applyDecision(); } catch { /* çıkış best-effort */ }
  });
  return {
    enforced: true,
    primary: false,
    pending: true, // yüzey ertelendi; karar (red) ZATEN verildi
    // main.js bu nesneyi tutar ve kendi ready kancasında sorar: kullanıcı
    // "Kapat"/"Ayrı profil" dediyse açılışın kalanı KESİLİR (yukarıdaki gerekçe).
    stopBoot: () => bootStopped,
    // main.js bunu BEKLER: karar verilene kadar açılış ilerlemez (yukarıdaki gerekçe).
    whenDecided: () => decided,
    holder: res.holder,
    why: res.why,
    focusRequested: focused,
    deepLink: null,
  };
}

module.exports = {
  LOCK_FILE,
  FOCUS_FILE,
  RECORD_VERSION,
  lockKey,
  lockPath,
  focusPath,
  isProcessAlive,
  rebootedSince,
  holderVerdict,
  acquire,
  release,
  releaseForRelaunch,
  requestFocus,
  watchFocusRequests,
  secondCopyDialog,
  secondCopyConfirmDialog,
  secondCopyMessage,
  enforce,
};
