// ADP-727 — YARDIMCI SÜREÇ DEFTERİ + YETİM TOPLAYICI.
//
// ÖLÇÜLEN SORUN (2026-07-29, Eren'in makinesi): `ps` ile 11 adet PPID=1
// `next-server` bulundu — en eskisi 8 GÜN 17 SAAT ayakta, biri %340 CPU yiyordu.
// Kök neden zinciri:
//   1. `startNextServer()` çocuğu normal spawn eder; macOS'ta EBEVEYN ÖLÜNCE ÇOCUK
//      ÖLMEZ (process-group kill yok) — yalnız `init`e (PPID=1) devredilir.
//   2. Tek temizleme yeri `app.on('before-quit')` → `stopNextServer()`. Bu handler
//      SIGKILL'de (jetsam bellek-baskısı kill'i, Force Quit, çökme) HİÇ ÇALIŞMAZ.
//   3. `window-all-closed` darwin'de sunucuyu KASITLI ayakta bırakır (ADP-334,
//      mobil gateway) → pencere kapalıyken app ölürse yetim GARANTİ.
//   4. Sonraki açılışta kimse eski yetimi aramaz → biriktiler.
//
// ÇÖZÜM İKİ KATMANLI (biri yetmez):
//   A. DEFTER + AÇILIŞTA TOPLAMA (bu dosya): her yardımcı süreç diske yazılır
//      (pid + başlangıç zamanı + komut imzası); sonraki açılışta hâlâ yaşayan ve
//      İMZASI TUTAN yetimler öldürülür. Çökme/SIGKILL sonrası tek güvenilir yol.
//   B. ÇOCUK TARAFINDA NÖBETÇİ (helperWatchdog.cjs): çocuk kendi `process.ppid`ini
//      yoklar; 1'e düştüyse (= ebeveyn öldü) kendini sonlandırır. Bu, bir sonraki
//      açılışı BEKLEMEDEN temizler.
//
// PID YENİDEN KULLANIMI: pid tek başına YETMEZ — makine 8 gün sonra o pid'i başka
// bir sürece vermiş olabilir. Bu yüzden defterde `startedAt` (ps lstart) ve komut
// imzası da tutulur; ÜÇÜ birden tutmazsa süreç ASLA öldürülmez.

// ADP-835 (790 P3/P4 · ADR-W10 Kural 2) — WINDOWS DALLARI `platform/procProbe.cjs`e
// TAŞINDI. Bu dosyadaki `ps`/`lsof`/`process.kill` çağrıları Windows'ta ENOENT verip
// sessizce boş liste üretiyordu (yetim toplayıcı ÇALIŞIYOR görünüp hiçbir şey
// bulmuyordu). İmzalar ve macOS davranışı DEĞİŞMEDİ; yalnız araç seçimi ve
// "yetim" tanımı platform boğazından geliyor.
const fs = require('node:fs');
const path = require('node:path');
const procProbe = require('../../platform/procProbe.cjs');

const FILE = 'helpers.json';

function helpersPath(home) {
  return path.join(home, '.crewpane', FILE);
}

function readLedger(home) {
  try {
    const raw = fs.readFileSync(helpersPath(home), 'utf8');
    const j = JSON.parse(raw);
    return Array.isArray(j?.helpers) ? j.helpers : [];
  } catch { return []; }
}

function writeLedger(home, helpers) {
  const p = helpersPath(home);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ helpers, updatedAt: new Date().toISOString() }, null, 2));
    return true;
  } catch { return false; }
}

/**
 * pid → { startedAt, command }. Süreç yoksa null.
 * posix `ps -o lstart=,command=` · win32 CIM (`Win32_Process`) — bkz. procProbe.
 */
function defaultProcInfo(pid) {
  return procProbe.procInfo(pid);
}

/**
 * Defter kaydı ekle. `signature` = komutun ayırt edici parçası (ör. 'next-server',
 * 'server.js'); yeniden-kullanılmış bir pid'i yanlışlıkla öldürmemek için şart.
 */
function recordHelper(home, { pid, kind, signature }, { procInfo = defaultProcInfo } = {}) {
  if (!pid) return false;
  const info = procInfo(pid);
  const entry = {
    pid,
    kind: kind || 'helper',
    signature: signature || '',
    startedAt: info?.startedAt || null,
    command: info?.command ? info.command.slice(0, 300) : null,
    ownerPid: process.pid,
    recordedAt: new Date().toISOString(),
  };
  const helpers = readLedger(home).filter((h) => h.pid !== pid);
  helpers.push(entry);
  return writeLedger(home, helpers);
}

function forgetHelper(home, pid) {
  const helpers = readLedger(home).filter((h) => h.pid !== pid);
  return writeLedger(home, helpers);
}

/**
 * ÜÇLÜ KİMLİK KAPISI — bir kaydın hâlâ O süreç olduğunu doğrular.
 * pid yaşıyor + başlangıç zamanı AYNI + komut imzası tutuyor. Biri bile tutmazsa
 * false → asla öldürme (pid yeniden kullanılmış olabilir).
 */
function stillOurs(entry, info) {
  if (!info) return false;
  if (entry.startedAt && info.startedAt && entry.startedAt !== info.startedAt) return false;
  const sig = entry.signature || entry.kind;
  if (sig && !String(info.command).includes(sig)) return false;
  return true;
}

/**
 * ADP-835 (790 P4) — YETİMİ ÖLDÜRMENİN PLATFORM KARŞILIĞI.
 * posix: `process.kill(pid, SIGTERM)` — bugünkü satır, birebir.
 * win32: Windows'ta ebeveyni öldürmek ÇOCUKLARI ÖLDÜRMEZ; yetim `next-server`ın
 *        kendi worker'ları hayatta kalıp aynı sızıntıyı sürdürürdü. `taskkill /T /F`
 *        AĞACI hedefler. (Sinyal semantiği zaten yok — bkz. procProbe başlığı.)
 */
function defaultKill(platform) {
  const plat = platform || process.platform;
  if (plat !== 'win32') return (pid, sig) => process.kill(pid, sig);
  return (pid) => {
    const r = procProbe.terminateTree({ pid }, { platform: plat });
    if (!r.ok) { const e = new Error(`taskkill failed: ${r.code || r.reason || 'unknown'}`); e.code = r.code || 'ETASKKILL'; throw e; }
  };
}

/**
 * Açılışta çağrılır: defterdeki HAYATTA KALMIŞ yardımcıları toplar.
 * Şimdiki sürecin kendi çocuklarına DOKUNMAZ (defter yalnız ÖNCEKİ oturumdan
 * kalanları taşır; kendi kaydımız `ownerPid === process.pid` ile ayıklanır).
 *
 * Dönen: { checked, reaped:[{pid,kind,signal}], skipped:[{pid,why}] }
 */
function reapStaleHelpers(home, opts = {}) {
  const procInfo = opts.procInfo || defaultProcInfo;
  const kill = opts.kill || defaultKill(opts.platform);
  const selfPid = opts.selfPid ?? process.pid;
  const log = opts.log || (() => {});
  const helpers = readLedger(home);
  const reaped = [];
  const skipped = [];
  for (const h of helpers) {
    if (h.pid === selfPid || h.ownerPid === selfPid) { skipped.push({ pid: h.pid, why: 'own-session' }); continue; }
    // ⚠️ EN KRİTİK KAPI — SAHİBİ HÂLÂ YAŞIYORSA O YETİM DEĞİLDİR.
    // Defter dosyası ~/.crewpane altında PAYLAŞILIR: e2e kopyası, ikinci bir
    // pencere, ya da dogfood instance'ı aynı dosyayı okur. Bu kontrol olmadan
    // AÇILAN her yeni instance, ÇALIŞAN diğer instance'ın Next sunucusunu
    // öldürürdü (Eren'in app'i bir e2e koşusu yüzünden beyaz ekrana düşerdi).
    // Yetimin tanımı: yardımcı yaşıyor AMA onu doğuran süreç ÖLMÜŞ.
    if (h.ownerPid && procInfo(h.ownerPid)) { skipped.push({ pid: h.pid, why: 'owner-alive' }); continue; }
    const info = procInfo(h.pid);
    if (!info) { skipped.push({ pid: h.pid, why: 'already-gone' }); continue; }
    if (!stillOurs(h, info)) { skipped.push({ pid: h.pid, why: 'identity-mismatch' }); continue; }
    try {
      kill(h.pid, 'SIGTERM');
      reaped.push({ pid: h.pid, kind: h.kind, signal: 'SIGTERM' });
      log(`reaped orphan helper pid=${h.pid} kind=${h.kind} (${h.command || ''})`);
    } catch (e) {
      skipped.push({ pid: h.pid, why: `kill-failed:${e.code || e.message}` });
    }
  }
  // Defteri buda: BU oturumun kayıtları + sahibi hâlâ yaşayan BAŞKA oturumların
  // kayıtları KALIR (onları silmek, o instance kapandığında yetimini kaybettirir).
  const keepPids = new Set(skipped.filter((s) => s.why === 'own-session' || s.why === 'owner-alive').map((s) => s.pid));
  writeLedger(home, helpers.filter((h) => keepPids.has(h.pid)));
  return { checked: helpers.length, reaped, skipped };
}

/**
 * ADP-727 — DEFTERSİZ YETİM SÜPÜRGESİ (defter yalnız BUNDAN SONRASINI kapsar).
 *
 * Defter kaydı yalnız bu sürümden itibaren yazılıyor; Eren'in makinesinde ZATEN
 * 11 yetim vardı (en eskisi 8 gün 18 saat) ve hiçbiri defterde değil → yalnız
 * defterle çalışan bir toplayıcı onları ASLA temizleyemez. Bu süpürge onları
 * PPID=1 + komut imzası + **çalışma dizini** üçlüsüyle bulur.
 *
 * ⚠️ ÇALIŞMA DİZİNİ ŞART, imza TEK BAŞINA YETMEZ: Next süreç başlığını
 * `next-server (v16.2.6)` olarak DEĞİŞTİRİR — komut satırında repo yolu KALMAZ.
 * Ölçüldü: aynı makinedeki PPID=1 next-server'lardan biri `crewpane-com`
 * projesine aitti. Kör bir "tüm PPID=1 next-server'ları öldür" BAŞKA BİR PROJENİN
 * sunucusunu öldürürdü. Kimlik ancak cwd ile kurulur.
 *
 * `roots` = bize ait olduğu kesin dizinler (repo kökü / standalone / resources).
 *
 * ── ADP-835 (790 P3) — WINDOWS'TA İKİ ADIM DA FARKLI ────────────────────────
 * 1. YETİM TANIMI. Windows'ta reparenting YOKTUR: ebeveyn ölse bile
 *    `ParentProcessId` ölü pid'i göstermeye devam eder → `ppid===1` ASLA
 *    gerçekleşmez ve POSIX filtresi orada "hiç yetim yok" demenin süslü hâli
 *    olurdu. `procProbe.orphanFilter` win32'de "ebeveyn canlı listede yok (ya da
 *    çocuktan SONRA başlamış = pid yeniden kullanılmış)" testini uygular.
 * 2. KİMLİK. `Win32_Process`te cwd ALANI YOK → `cwdOf` win32'de dürüstçe null
 *    döner. Ama oradaki kısıt POSIX'tekinin AYNISI DEĞİL: süreç başlığı
 *    yeniden yazma (`next-server (v…)`) Windows'ta komut satırını EZMEZ, repo
 *    yolu `CommandLine`da DURUR. Yani kimlik yine kurulabiliyor — yalnız
 *    farklı bir alandan. cwd de CommandLine da bizi doğrulamıyorsa süreç
 *    ASLA öldürülmez (belirsizlik "dokunma" lehine çözülür).
 */
function sweepUnledgeredOrphans(roots, opts = {}) {
  const platform = opts.platform || process.platform;
  const list = opts.list || defaultProcList;
  const cwdOf = opts.cwdOf || defaultCwdOf;
  const kill = opts.kill || defaultKill(platform);
  const signature = opts.signature || 'next-server';
  const log = opts.log || (() => {});
  const selfPid = opts.selfPid ?? process.pid;
  const ours = (roots || []).filter(Boolean).map((r) => String(r));
  const reaped = [];
  const skipped = [];
  if (!ours.length) return { reaped, skipped };
  // Yol karşılaştırması: win32'de ayırıcı `\`, ayrıca büyük/küçük harf duyarsız.
  const underRoot = (candidate) => {
    if (!candidate) return false;
    const norm = (s) => (platform === 'win32' ? String(s).replace(/\//g, '\\').toLowerCase() : String(s));
    const c = norm(candidate);
    const sep = platform === 'win32' ? '\\' : '/';
    return ours.some((r) => { const rr = norm(r); return c === rr || c.startsWith(`${rr}${sep}`); });
  };
  for (const p of orphanFilterFor(list(), { platform, selfPid })) {
    if (p.pid === selfPid) continue;
    if (!String(p.command).includes(signature)) continue;
    const cwd = cwdOf(p.pid);
    // Kimlik kaynağı: cwd (posix) → yoksa komut satırı (win32'de tek yol).
    let evidence = null;
    if (cwd && underRoot(cwd)) evidence = { how: 'cwd', value: cwd };
    else if (!cwd && platform === 'win32' && commandRoot(p.command, ours, platform)) {
      evidence = { how: 'command-line', value: p.command };
    }
    if (!evidence) {
      skipped.push({ pid: p.pid, why: cwd ? 'not-ours' : 'cwd-unknown' });
      continue;
    }
    try {
      kill(p.pid, 'SIGTERM');
      reaped.push({ pid: p.pid, cwd: cwd || null, via: evidence.how });
      log(`swept unledgered orphan pid=${p.pid} via=${evidence.how} ${evidence.value}`);
    } catch (e) {
      skipped.push({ pid: p.pid, why: `kill-failed:${e.code || e.message}` });
    }
  }
  return { reaped, skipped };
}

/** Platforma göre yetim süzgeci — enjekte edilebilir (test/ölçüm için). */
function orphanFilterFor(procs, deps) {
  return procProbe.orphanFilter(procs, deps);
}

/**
 * Komut satırında geçen ve `roots`tan birinin ALTINDA olan ilk yolu döndürür.
 * Windows'ta kimliğin tek kaynağı bu (cwd API'si yok). Eşleşme yoksa `null` →
 * süreç öldürülmez.
 *
 * ⚠️ SINIR KONTROLÜ ZORUNLU (bu testi yazarken KIRMIZI verdi): düz `includes`
 * `C:\repo\crewpane`i `C:\repo\crewpane-eski\server.js` içinde bulur ve BAŞKA
 * BİR PROJENİN sunucusunu bizim sanardı. POSIX tarafında bu tuzağın nöbetçisi
 * zaten vardı ("cwd kökün UZANTISI olan farklı dizini bizim sanmaz"); win32 dalı
 * onu yeniden üretmesin diye kökten sonra AYIRICI (ya da satır/tırnak sonu) şart.
 */
function commandRoot(command, roots, platform) {
  const win = platform === 'win32';
  const c = String(command || '');
  const hay = win ? c.replace(/\//g, '\\').toLowerCase() : c;
  for (const r of roots) {
    const needle = win ? String(r).replace(/\//g, '\\').toLowerCase() : String(r);
    if (!needle) continue;
    let at = hay.indexOf(needle);
    while (at !== -1) {
      const next = hay[at + needle.length];
      // kökün TAM kendisi (satır sonu) · alt yol (`\` ya da `/`) · kapanan tırnak
      if (next === undefined || next === '\\' || next === '/' || next === '"') return r;
      at = hay.indexOf(needle, at + 1);
    }
  }
  return null;
}

/** Süreç listesi: posix `ps -axo pid=,ppid=,command=` · win32 CIM. */
function defaultProcList() {
  return procProbe.procList();
}

/**
 * Sürecin çalışma dizini. Yoksa null → asla öldürme.
 * posix `lsof` · **win32'de null** — `Win32_Process`te cwd alanı YOK (procProbe
 * bunu `unknown` olarak raporluyor). Süpürge win32'de kimliği CommandLine'dan
 * kurar, çünkü Windows'ta süreç başlığı komut satırını ezmez.
 */
function defaultCwdOf(pid) {
  return procProbe.cwdOf(pid);
}

/**
 * SIGTERM'e cevap vermeyen yardımcıya SIGKILL. `stopNextServer()` yalnız SIGTERM
 * gönderiyordu; asılı kalan bir Next sunucusu (açık bağlantı, kapanmayan soket)
 * SIGTERM'i yutup yaşamaya devam eder → yine yetim.
 *
 * ADP-835 (790 P4): Windows'ta sinyal yok — `TerminateProcess` anında öldürür ve
 * ÇOCUKLARI BIRAKIR. Orada `taskkill /T` (ağaç) kullanılır; nezaket penceresi
 * konsol süreçleri için GERÇEK DEĞİLDİR (procProbe başlığı). Bu fonksiyonun
 * dönüşü (`true`/`false`) ve macOS davranışı DEĞİŞMEDİ.
 */
function killWithGrace(pid, opts = {}) {
  const deps = { alive: (p) => !!defaultProcInfo(p), ...opts };
  return procProbe.killWithGrace(pid, deps).started;
}

module.exports = {
  helpersPath, readLedger, writeLedger, recordHelper, forgetHelper,
  reapStaleHelpers, killWithGrace, stillOurs, defaultProcInfo,
  sweepUnledgeredOrphans, defaultProcList, defaultCwdOf,
  defaultKill, commandRoot, // ADP-835 — win32 dalları için test yüzeyi
};
