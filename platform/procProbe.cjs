// ADP-835 (790 P3/P4/P5 · ADR-W7 · ADR-W10 Kural 2) — SÜREÇ YOKLAMA + SONLANDIRMA.
//
// NEDEN VAR. `helperReaper.cjs` yetim `next-server` avını ÜÇ POSIX aracına
// dayandırıyor: `ps -o lstart=,command=`, `ps -axo pid=,ppid=,command=`,
// `lsof -a -p N -d cwd -Fn`. Windows'ta ÜÇÜ DE YOKTUR → `execFileSync` ENOENT →
// `catch` → boş liste. Sonuç 790 P3'ün 🔇 işareti: toplayıcı ÇALIŞIYOR görünür,
// hiçbir şey bulmaz, ADP-727'nin kapattığı yetim sızıntısı Windows'ta geri döner.
//
// ── WINDOWS'TA YETİMİN TANIMI FARKLI (algoritmanın kendisi değişiyor) ────────
// POSIX'te ebeveyn ölünce çocuk `init`e devredilir → `ppid === 1` yetimin
// İMZASIDIR. Windows'ta REPARENTING YOKTUR: ebeveyn ölse bile çocuğun
// `ParentProcessId` alanı ÖLÜ pid'i göstermeye devam eder. Yani `ppid===1`
// Windows'ta ASLA doğru olmaz — POSIX filtresini olduğu gibi taşımak "hiç yetim
// yok" demenin süslü hâli olurdu.
// Windows karşılığı: **ebeveyn pid'i artık canlı süreç listesinde değil** — ya da
// canlı ama ÇOCUKTAN SONRA başlamış (pid yeniden kullanımı; bu durumda o süreç
// bizim ebeveynimiz olamaz). İkisini de `orphanFilter` uyguluyor.
//
// ── CWD YOK, KİMLİK VAR (790'ın ölçmediği ayrım) ─────────────────────────────
// `sweepUnledgeredOrphans` kimliği ÇALIŞMA DİZİNİYLE kuruyor, çünkü Next süreç
// başlığını POSIX'te `next-server (v…)` olarak yeniden yazıyor ve komut satırında
// repo yolu KALMIYOR. Windows'ta `Win32_Process.CommandLine` süreç başlığından
// ETKİLENMEZ (Node Windows'ta yalnız konsol başlığını değiştirir) → repo yolu
// komut satırında DURUR. Yani Windows'ta kimlik cwd'siz kurulabilir; `cwdOf`
// dürüstçe `unknown` döner ve süpürge win32 dalında CommandLine'a bakar.
//
// ── ARAÇ SEÇİMİ: neden PowerShell/CIM, neden wmic DEĞİL ──────────────────────
//   tasklist : her Windows'ta var — ama ppid YOK, komut satırı YOK, başlangıç
//              zamanı YOK. Üçlü kimlik kapısını (790 `stillOurs`) besleyemez;
//              yalnız "yaşıyor mu" sorusuna yeter → son çare olarak kullanılır.
//   wmic     : üçünü de verir — ama Windows 11 24H2 / Server 2025 ile birlikte
//              varsayılan kurulumdan KALDIRILDI. Tek dayanak yapılamaz; eski
//              makineler için YEDEK.
//   PowerShell `Get-CimInstance Win32_Process` : Windows PowerShell 5.1 her
//              desteklenen sürümde kutu-içi → BİRİNCİL. Komut `-EncodedCommand`
//              ile geçirilir (cmd tırnak ayrıştırması hiç devreye girmez;
//              holderShell.cjs'teki ADP-833 deseninin aynısı, yeniden kullanılıyor).
//
// ── SİNYALLER: WINDOWS'TA NEZAKET PENCERESİ YOKTUR (790 P4) ─────────────────
// `process.kill(pid,'SIGTERM')` Node'da Windows'ta libuv `uv_kill`e gider ve 0
// dışındaki HER sinyal için `TerminateProcess` çağırır. Yani SIGTERM == SIGKILL:
// süreç ANINDA ölür, hiçbir kapanış kancası koşmaz. `killWithGrace`in 3 sn'lik
// nezaket penceresi Windows'ta BİR KURGUDUR — 3 sn sonra "hâlâ yaşıyor mu" diye
// bakıp SIGKILL atmak, çoktan ölmüş bir pid'e (ya da pid yeniden kullanıldıysa
// MASUM bir sürece) atış yapmaktır.
// Ayrıca Windows ebeveyn ölünce ÇOCUKLARI ÖLDÜRMEZ → `next-server`ın kendi alt
// süreçleri her hâlükârda yetim kalır.
// Bu yüzden win32 dalı `taskkill` kullanır:
//   1. `taskkill /PID n /T`      → AĞACI hedefler; pencereli süreçlere WM_CLOSE
//      gönderir (gerçek, küçük bir nezaket penceresi). KONSOL süreçleri için bu
//      adım etkisizdir — bu bir eksiklik değil, Windows'un gerçeği; belgelenir.
//   2. graceMs sonra hâlâ yaşıyorsa `taskkill /PID n /T /F` → zorla, ağaçla.
// SONUÇ — ÜRÜN KURALI: Windows'ta kapanışta korunması gereken durum bir sinyal
// kancasında DEĞİL, öldürme çağrısından ÖNCE diske yazılmalıdır.
//
// macOS DAVRANIŞI BİT-BİT AYNI: posix dalları bugünkü `ps`/`lsof`/`process.kill`
// satırlarının kendisidir; win32 mantığı yalnız win32 dalında yaşar ve birim
// testleri iki dalı da platform enjeksiyonuyla koşturur.
'use strict';

const nodeChildProcess = require('node:child_process');
const nodePath = require('node:path');
const { encodePowershellCommand, powershellPath } = require('./holderShell.cjs');

/** Windows System32 altındaki mutlak araç yolu (PATH bayat olabilir). */
function system32(env, exe) {
  const root = (env && (env.SystemRoot || env.windir)) || 'C:\\Windows';
  return nodePath.win32.join(root, 'System32', exe);
}

/** PowerShell'i `-EncodedCommand` ile çağıran `{ file, argv }`. */
function psInvocation(script, env) {
  return {
    file: powershellPath(env || process.env),
    argv: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowershellCommand(script)],
  };
}

/**
 * TEK SÜREÇ SORGUSU — `{ file, argv, parse }`. SAF (exec yok).
 * posix: bugünkü `ps -o lstart=,command= -p N` satırı, birebir.
 * win32: CIM → `{StartedAt, CommandLine}` JSON.
 */
function procInfoQuery(pid, deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform === 'win32') {
    const script =
      `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid) | 0}" -ErrorAction SilentlyContinue;` +
      'if($null -eq $p){exit 3};' +
      "[Console]::Out.Write((@{StartedAt=$p.CreationDate.ToString('o');CommandLine=[string]$p.CommandLine;Name=[string]$p.Name}|ConvertTo-Json -Compress))";
    return { ...psInvocation(script, deps.env), tool: 'cim', parse: parseProcInfoWin };
  }
  return { file: 'ps', argv: ['-o', 'lstart=,command=', '-p', String(pid)], tool: 'ps', parse: parseProcInfoPosix };
}

/** `ps` çıktısı → `{ startedAt, command }`. lstart SABİT 24 karakter. */
function parseProcInfoPosix(out) {
  const s = String(out || '').trim();
  if (!s) return null;
  return { startedAt: s.slice(0, 24).trim(), command: s.slice(24).trim() };
}

/** CIM JSON → `{ startedAt, command }`. Komut satırı yoksa görüntü adına düşer. */
function parseProcInfoWin(out) {
  const s = String(out || '').trim();
  if (!s) return null;
  let j;
  try { j = JSON.parse(s); } catch { return null; }
  if (!j || (!j.StartedAt && !j.CommandLine && !j.Name)) return null;
  return { startedAt: j.StartedAt || null, command: String(j.CommandLine || j.Name || '').trim() };
}

/**
 * SÜREÇ LİSTESİ SORGUSU — `{ file, argv, parse }`. SAF.
 * posix: `ps -axo pid=,ppid=,command=`
 * win32: CIM → `[{pid, ppid, command, startedAt}]`
 */
function procListQuery(deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform === 'win32') {
    const script =
      '$l=@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue|' +
      "ForEach-Object{@{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;command=[string]$_.CommandLine;name=[string]$_.Name;startedAt=$(if($_.CreationDate){$_.CreationDate.ToString('o')}else{$null})}});" +
      '[Console]::Out.Write((ConvertTo-Json -Compress -Depth 3 -InputObject $l))';
    return { ...psInvocation(script, deps.env), tool: 'cim', parse: parseProcListWin };
  }
  return { file: 'ps', argv: ['-axo', 'pid=,ppid=,command='], tool: 'ps', parse: parseProcListPosix };
}

/** `ps -axo` çıktısı → `[{pid, ppid, command}]`. Bugünkü ayrıştırıcının kendisi. */
function parseProcListPosix(out) {
  return String(out || '').trim().split('\n').map((l) => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return m ? { pid: +m[1], ppid: +m[2], command: m[3] } : null;
  }).filter(Boolean);
}

/** CIM JSON dizisi → `[{pid, ppid, command, startedAt}]`. */
function parseProcListWin(out) {
  const s = String(out || '').trim();
  if (!s) return [];
  let j;
  try { j = JSON.parse(s); } catch { return []; }
  // `@(...)` tek elemanda bile dizi verir; yine de savunmacı davran.
  const rows = Array.isArray(j) ? j : [j];
  return rows
    .filter((r) => r && Number.isFinite(Number(r.pid)))
    .map((r) => ({
      pid: Number(r.pid),
      ppid: Number.isFinite(Number(r.ppid)) ? Number(r.ppid) : 0,
      command: String(r.command || r.name || '').trim(),
      startedAt: r.startedAt || null,
    }));
}

/**
 * ÇALIŞMA DİZİNİ — üç-durumlu (ADR-W7).
 *   posix : `lsof` sorgusu döner → ölçülebilir
 *   win32 : `{ state:'unknown' }` — Win32_Process'te cwd ALANI YOKTUR ve ucuz
 *           bir karşılığı da yok. "Ölçemedim" diyoruz; süpürge bunu görüp
 *           CommandLine kimliğine geçiyor. Sessizce `null` DÖNMÜYORUZ.
 */
function cwdQuery(pid, deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform === 'win32') return { state: 'unknown', reason: 'no-cwd-api-on-win32', tool: 'none' };
  return {
    state: 'measurable',
    tool: 'lsof',
    file: 'lsof',
    argv: ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
    parse: (out) => {
      const line = String(out || '').split('\n').find((l) => l.startsWith('n'));
      return line ? line.slice(1) : null;
    },
  };
}

/**
 * YETİM SÜZGECİ — platforma göre "ebeveynsiz" tanımı.
 *
 * posix: `ppid === 1` (init'e devredilmiş).
 * win32: ebeveyn pid'i canlı listede YOK **ya da** canlı ama çocuktan SONRA
 *        başlamış (pid yeniden kullanılmış → o süreç bizim ebeveynimiz değil).
 *        Ebeveynin başlangıç zamanı okunamıyorsa YETİM SAYILMAZ (öldürmeye
 *        yönelik her belirsizlik "dokunma" lehine çözülür).
 */
function orphanFilter(procs, deps = {}) {
  const platform = deps.platform || process.platform;
  const list = Array.isArray(procs) ? procs : [];
  if (platform !== 'win32') return list.filter((p) => p && p.ppid === 1);
  const byPid = new Map(list.map((p) => [p.pid, p]));
  return list.filter((p) => {
    if (!p || !Number.isFinite(p.ppid) || p.ppid <= 0) return false;
    const parent = byPid.get(p.ppid);
    if (!parent) return true;                       // ebeveyn ölmüş → yetim
    if (!parent.startedAt || !p.startedAt) return false; // ölçemedim → dokunma
    return Date.parse(parent.startedAt) > Date.parse(p.startedAt); // pid yeniden kullanılmış
  });
}

// ── SONLANDIRMA ─────────────────────────────────────────────────────────────

/** `taskkill` çağrıları — SAF, exec yok. `/T` = süreç AĞACI. */
function taskkillCommands(pid, deps = {}) {
  const exe = deps.taskkill || system32(deps.env || process.env, 'taskkill.exe');
  const id = String(Number(pid) | 0);
  return {
    polite: { file: exe, argv: ['/PID', id, '/T'] },
    force: { file: exe, argv: ['/PID', id, '/T', '/F'] },
  };
}

/**
 * ÜÇ-DURUMLU CANLILIK PROBU (790 P5).
 *   alive   → süreç var
 *   gone    → ESRCH: yok
 *   unknown → ölçemedim
 * `EPERM` = süreç VAR ama erişilemiyor → **alive**. (Bugünkü
 * `livePaneRegistry.ownerAlive` bunu zaten doğru yapıyor; `instance-isolation-proof`
 * yapmıyor. Boğaz, ikisini tek doğruda birleştirir.)
 */
function livenessState(pid, deps = {}) {
  const kill = deps.kill || ((p, s) => process.kill(p, s));
  const selfPid = deps.selfPid ?? process.pid;
  if (!Number.isFinite(pid) || pid <= 0) return { state: 'unknown', reason: 'bad-pid' };
  if (pid === selfPid) return { state: 'alive', self: true };
  try {
    kill(pid, 0);
    return { state: 'alive' };
  } catch (err) {
    const code = err && err.code;
    if (code === 'ESRCH') return { state: 'gone' };
    if (code === 'EPERM') return { state: 'alive', foreign: true };
    return { state: 'unknown', reason: code || 'probe-failed' };
  }
}

/** Geriye-uyumlu boolean (ADR-W10 Kural 2): `unknown` → **alive sayılır**. */
function isAlive(pid, deps = {}) {
  return livenessState(pid, deps).state !== 'gone';
}

/**
 * NEZAKETLİ SONLANDIRMA — platforma göre GERÇEKÇİ.
 *
 * posix: bugünkü davranış BİREBİR (SIGTERM → graceMs → yaşıyorsa SIGKILL).
 * win32: `taskkill /T` (ağaç, pencereli süreçlere WM_CLOSE) → graceMs →
 *        yaşıyorsa `taskkill /T /F`. Node sinyali KULLANILMAZ: `TerminateProcess`
 *        zaten zorla öldürür ve ÇOCUKLARI BIRAKIR.
 *
 * Dönen: `{ started:boolean, mechanism:'signal'|'taskkill', graceReal:boolean }`.
 * `graceReal:false` → "bu platformda konsol süreçleri için nezaket penceresi
 * GERÇEK DEĞİL" (çağıran durumu önceden diske yazmalı). Sessiz yalan yok.
 */
function killWithGrace(pid, deps = {}) {
  const platform = deps.platform || process.platform;
  const graceMs = Number.isFinite(deps.graceMs) ? deps.graceMs : 3000;
  const setTimer = deps.setTimer || setTimeout;
  const alive = deps.alive || ((p) => isAlive(p, deps));

  if (platform !== 'win32') {
    const kill = deps.kill || ((p, s) => process.kill(p, s));
    try { kill(pid, 'SIGTERM'); } catch { return { started: false, mechanism: 'signal', graceReal: true }; }
    setTimer(() => {
      if (alive(pid)) { try { kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    }, graceMs);
    return { started: true, mechanism: 'signal', graceReal: true };
  }

  const run = deps.execFile || ((file, argv) => nodeChildProcess.execFileSync(file, argv, { stdio: 'ignore' }));
  const cmds = taskkillCommands(pid, deps);
  // Nezaket adımı KONSOL süreçlerinde etkisizdir ve taskkill çıkış kodu 1 verir —
  // bu bir HATA DEĞİL, beklenen durum; yutulur ve zorlama adımına geçilir.
  try { run(cmds.polite.file, cmds.polite.argv); } catch { /* pencere yok / zaten ölü */ }
  setTimer(() => {
    if (alive(pid)) { try { run(cmds.force.file, cmds.force.argv); } catch { /* gone */ } }
  }, graceMs);
  return { started: true, mechanism: 'taskkill', graceReal: false };
}

/**
 * ÇOCUK SÜRECİ AĞACIYLA SONLANDIR (engineAuth iptali/zaman aşımı gibi yerler).
 * posix: `child.kill(signal)` — bugünkü satır.
 * win32: `taskkill /PID <child.pid> /T /F` — `child.kill()` TORUNLARI BIRAKIR
 *        (giriş CLI'ı tarayıcı açıcı/yardımcı doğurmuş olabilir).
 */
function terminateTree(child, deps = {}) {
  const platform = deps.platform || process.platform;
  if (!child) return { ok: false, reason: 'no-child' };
  if (platform !== 'win32') {
    // BUGÜNKÜ SATIRIN KENDİSİ. `pid` ŞART DEĞİL — `child.kill()` onu istemez.
    // (İlk taslakta `!child.pid` ön koşulu vardı; engineAuth'un iptal testi
    // KIRMIZI verip yakaladı: pid'i olmayan bir çocuk artık hiç öldürülmüyordu.
    // Windows'ta taskkill pid ister, POSIX'te İSTEMEZ — ön koşul dala ait.)
    if (typeof child.kill !== 'function') return { ok: false, reason: 'no-kill' };
    try { child.kill(deps.signal || 'SIGTERM'); return { ok: true, mechanism: 'signal' }; } catch (e) { return { ok: false, mechanism: 'signal', code: e && e.code }; }
  }
  if (!child.pid) return { ok: false, reason: 'no-pid' }; // taskkill pid'siz çalışamaz
  const run = deps.execFile || ((file, argv) => nodeChildProcess.execFileSync(file, argv, { stdio: 'ignore' }));
  const { force } = taskkillCommands(child.pid, deps);
  try { run(force.file, force.argv); return { ok: true, mechanism: 'taskkill' }; } catch (e) {
    try { child.kill('SIGKILL'); return { ok: true, mechanism: 'signal-fallback' }; } catch { return { ok: false, mechanism: 'taskkill', code: e && e.code }; }
  }
}

// ── ÇALIŞTIRICILAR (varsayılan yürütme yolu) ────────────────────────────────

function runQuery(q, deps = {}) {
  const exec = deps.execFileSync || nodeChildProcess.execFileSync;
  try {
    const out = exec(q.file, q.argv, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    return q.parse(out);
  } catch { return null; }
}

/** `helperReaper.defaultProcInfo` karşılığı — platform-farkında. */
function procInfo(pid, deps = {}) {
  return runQuery(procInfoQuery(pid, deps), deps);
}

/** `helperReaper.defaultProcList` karşılığı — platform-farkında. */
function procList(deps = {}) {
  return runQuery(procListQuery(deps), deps) || [];
}

/** `helperReaper.defaultCwdOf` karşılığı — win32'de dürüstçe `null` + `unknown`. */
function cwdOf(pid, deps = {}) {
  const q = cwdQuery(pid, deps);
  if (q.state === 'unknown') return null;
  return runQuery(q, deps);
}

module.exports = {
  system32,
  psInvocation,
  procInfoQuery,
  parseProcInfoPosix,
  parseProcInfoWin,
  procListQuery,
  parseProcListPosix,
  parseProcListWin,
  cwdQuery,
  orphanFilter,
  taskkillCommands,
  livenessState,
  isAlive,
  killWithGrace,
  terminateTree,
  procInfo,
  procList,
  cwdOf,
};
