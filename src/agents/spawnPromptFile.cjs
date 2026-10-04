// AD-WIN-01 — AJAN KİMLİĞİNİ KOMUT SATIRINDAN ÇIKAR (Windows P0 kök çözümü).
//
// SORUN (ölçüldü, `scripts/win/adWin01CmdLineProof.cjs`). Ajan kimliği bugün
// `--append-system-prompt <8000 karaktere kadar metin>` ile KOMUT SATIRINDAN geçiyor.
// Windows'ta motor npm ile kurulmuşsa ikili `claude.cmd`'dir; batch dosyası kabuksuz
// çalıştırılamadığı için `binResolve.execArgs` her şeyi `cmd.exe /d /s /c "…"` içine
// sarar → cmd.exe'nin 8.191 karakterlik tavanı devreye girer. Ölçülen lider komut
// satırı 8.520 karakter: 329 karakter TAŞIYOR. Sonuç: süreç HİÇ DOĞMUYOR, terminale
// tek satır düşüyor ("The command line is too long."), uygulama ise pane'i "açıldı"
// sanıyor → lider araçsız (MCP bayrakları da o komut satırındaydı).
//
// ÇÖZÜM. claude CLI dosya tabanlı bir eşdeğer taşıyor: `--append-system-prompt-file
// <yol>`. KANITLANDI (claude 2.1.231, bu makine, 2026-08-13):
//     $ printf 'Sana kod kelimesi sorulursa YALNIZCA su dizeyi yaz: ZEBRA-9147\n' > sp.txt
//     $ claude --append-system-prompt-file sp.txt -p "kod kelimesi ne?"
//     ZEBRA-9147
// Bayrak `--help` listesinde GÖRÜNMÜYOR (yalnız `--bare` açıklamasında geçiyor), bu
// yüzden varlığı VARSAYILMAZ — aşağıdaki `probeSupport` ÖLÇER.
//
// ── İKİ SERT KURAL ──────────────────────────────────────────────────────────
// 1. macOS/Linux DAVRANIŞI DEĞİŞMEZ. Dosya yolu YALNIZ win32'de ve YALNIZ ölçüm
//    "destekliyor" dediğinde seçilir. POSIX'te ARG_MAX 1.048.576 (ölçüldü) — orada
//    sorun yoktur, dolayısıyla değişiklik de yoktur.
//
//    ⚠️ GÜNCELLEME — LEAD-BEHAV-01 (2026-08-24): kural 1'in ÖNCÜLÜ EKSİKTİ. POSIX'te
//    ARG_MAX bir sorun değil, ama ürünün KENDİ tavanı (`systemPromptCap.CLI_MAX` =
//    8.000) bir sorun: ofis tıklamasıyla açılan lider pane'inin sistem promptu 9.732
//    karakter ölçüldü ve kuyruktan 1.732 karakter — delegasyon talimatının yarısı,
//    durum disiplini, rapor kültürü, kimlik mührü — SESSİZCE kesiliyordu. Bu yüzden
//    `createSink` artık POSIX'te de sink döndürür; ama sink'in KULLANILMASI
//    agentRunner'da "yalnız metin CLI tavanını aşıyorsa" kuralına bağlıdır
//    (`identityFileCarrierIsOverflowOnly`). Sığan her pane bugünkü satır-içi bayrağı
//    bit-bit korur — yani kural 1'in koruduğu şey (sıradan pane değişmez) sürüyor.
// 2. RESUME BOZULMAZ. `--append-system-prompt[-file]` PER-LAUNCH bir bayraktır
//    (ADP-276 prob kanıtı); dosya yolu bu semantiği DEĞİŞTİRMEZ — aynı anda, aynı
//    yerde, aynı metin enjekte edilir, yalnız taşıyıcı argüman yerine dosyadır.
//    Bu yüzden `resumeMemoryPrompt` yolu da aynı sink'ten geçebilir.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const atomicWrite = require('../../platform/atomicWrite.cjs');
const binResolve = require('../../platform/binResolve.cjs');

/** Bayrağın adı — tek kaynak (test + üretim aynı dizeyi kullanır). */
const PROMPT_FILE_FLAG = '--append-system-prompt-file';

/** Kimlik dosyalarının yaşadığı alt dizin (crewpaneHome altında). */
const PROMPT_DIR = 'spawn-prompts';

/** Süpürme eşiği: bundan eski kimlik dosyaları silinir (pane çoktan kapanmıştır). */
const SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// probeSupport önbelleği: ikili YOLUNA göre (kullanıcı motoru güncellerse yol aynı
// kalır ama bu önbellek yalnız uygulama ömrü boyunca yaşar → bir sonraki açılışta
// yeniden ölçülür; "güncelledim ama hâlâ eski davranış" tuzağı en fazla bir oturum sürer).
const supportCache = new Map();

/**
 * `bin` bayrağı tanıyor mu? → true | false | null ("ölçemedim")
 *
 * Prob TASARIMI (ölçülerek seçildi, claude 2.1.231):
 *   • `--version` / `--help` seçenek doğrulamasından ÖNCE kısa devre yapar → YANLIŞ
 *     POZİTİF verir (bilinmeyen bayrakla bile 0 döner). Prob olarak KULLANILAMAZ.
 *   • `-p` (stdin kapalı) seçenekleri doğrular, API'ye GİTMEZ, anında çıkar:
 *       bilinmeyen bayrak → "error: unknown option '--append-system-prompt-fileX'"
 *       bilinen bayrak    → "Error: Input must be provided either through stdin …"
 *     Yani prob ÜCRETSİZ ve çevrimdışıdır.
 *
 * Windows'ta hedef `claude.cmd` olabilir → `execArgs` ile cmd.exe sarmalayıcısı
 * kurulur (spawn hattının kendisiyle AYNI kod).
 */
function probeSupport(bin, env = process.env, deps = {}) {
  if (typeof bin !== 'string' || !bin.trim()) return null;
  const cacheKey = bin;
  if (!deps.noCache && supportCache.has(cacheKey)) return supportCache.get(cacheKey);
  const run = deps.spawnSync || spawnSync;
  const platform = deps.platform || process.platform;
  let verdict = null;
  try {
    const target = binResolve.execArgs(bin, [PROMPT_FILE_FLAG, deps.probePath || tmpProbePath(deps), '-p'], {
      platform,
      env,
    });
    const r = run(target.file, target.argv, {
      env,
      encoding: 'utf8',
      timeout: deps.timeoutMs || 20000,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(target.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    const text = `${(r && r.stdout) || ''}${(r && r.stderr) || ''}`;
    if (r && r.error) verdict = null; // ölçüm başarısız — "yok" DEMEYİZ
    else if (/unknown option/i.test(text) && text.includes(PROMPT_FILE_FLAG)) verdict = false;
    else if (text.trim()) verdict = true;
    else verdict = null;
  } catch {
    verdict = null;
  }
  if (!deps.noCache) supportCache.set(cacheKey, verdict);
  return verdict;
}

/** Prob için var olması gerekmeyen (okunmadan reddedilen) bir geçici yol. */
function tmpProbePath(deps = {}) {
  return path.join((deps.tmpdir || os.tmpdir)(), 'crewpane-prompt-probe.txt');
}

/** Test için: önbelleği boşalt. */
function resetSupportCache() {
  supportCache.clear();
}

/** Kimlik dosyalarının dizini. */
function promptDir(home) {
  return path.join(String(home || ''), PROMPT_DIR);
}

/**
 * Eski kimlik dosyalarını süpür. Windows'ta AÇIK bir dosya SİLİNEMEZ (POSIX'in
 * aksine) — bu yüzden her `unlink` tek tek try/catch'lenir ve başarısızlık SESSİZCE
 * geçilir: süpürme bir temizliktir, bir garanti değil.
 */
function sweep(home, deps = {}) {
  const io = deps.fs || fs;
  const now = deps.now || Date.now();
  const dir = promptDir(home);
  let names = [];
  try {
    names = io.readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith('.txt')) continue;
    const p = path.join(dir, name);
    try {
      if (now - io.statSync(p).mtimeMs < SWEEP_MAX_AGE_MS) continue;
      io.unlinkSync(p);
      removed += 1;
    } catch {
      /* kilitli / yarışta silinmiş — temizlik garantisi yok */
    }
  }
  return removed;
}

/**
 * Kimlik metnini bir dosyaya yaz, MUTLAK yolunu döndür. Hata → null (çağıran satır-içi
 * bayrağa geri düşer; kimlik dosyası yazılamadı diye pane AÇILMAMAZLIK etmez).
 *
 * ATOMİK yazım ŞART: claude bu dosyayı pane açılır açılmaz okur. Doğrudan yazımda
 * yarım okunan bir dosya = yarım kimlik = sessizce sakat ajan (delegate-mcp.json'da
 * ölçülen sınıfın aynısı, bkz. agentRunner.writeJsonAtomic).
 */
function writePromptFile(home, text, deps = {}) {
  if (typeof text !== 'string' || !text) return null;
  const io = deps.fs || fs;
  try {
    const dir = promptDir(home);
    io.mkdirSync(dir, { recursive: true });
    sweep(home, deps);
    const stamp = deps.stamp || `${process.pid}-${Date.now().toString(36)}-${(nextSeq()).toString(36)}`;
    const file = path.join(dir, `identity-${stamp}.txt`);
    (deps.atomicWriteFileSync || atomicWrite.atomicWriteFileSync)(file, text, { mode: 0o600 });
    return file;
  } catch {
    return null;
  }
}

let seq = 0;
function nextSeq() {
  seq += 1;
  return seq;
}

/**
 * `agentRunner.buildSpawn`a `trusted.promptFile` olarak geçen SINK'i üretir.
 * `null` dönerse buildSpawn bugünkü satır-içi davranışı AYNEN korur.
 *
 * Kapı sırası (hepsi "hayır"da no-op):
 *   1. platform win32 mi?          → değilse null (macOS bit-bit aynı)
 *   2. motor claude mü?            → değilse null (codex'te bayrak yok)
 *   3. ikili çözüldü mü?           → çözülmediyse null
 *   4. bayrak DESTEKLENİYOR mu?    → ölçüm true değilse null (eski CLI'yi kırma)
 */
function createSink({ platform = process.platform, engine, bin, env = process.env, home, log, deps = {} } = {}) {
  // LEAD-BEHAV-01 — win32 KAPISI KALDIRILDI (bkz. dosya başlığı §GÜNCELLEME).
  // Sink artık POSIX'te de kurulur; KULLANIM kararı agentRunner'ındır ve orada
  // "yalnız taşmada"dır (identityFileCarrierIsOverflowOnly), yani sığan pane'in
  // davranışı bit-bit korunur. `probeSupport` yine ÖLÇER: bayrak yoksa null.
  if (engine !== 'claude') return null;
  if (!bin || !home) return null;
  const supported = (deps.probeSupport || probeSupport)(bin, env, { ...deps, platform });
  if (supported !== true) {
    if (typeof log === 'function') {
      log(`spawn kimliği: ${PROMPT_FILE_FLAG} desteği=${supported === false ? 'YOK' : 'ÖLÇÜLEMEDİ'} → satır-içi bayrak korunuyor (bin=${bin})`);
    }
    return null;
  }
  return (text) => {
    const p = (deps.writePromptFile || writePromptFile)(home, text, deps);
    if (typeof log === 'function') {
      log(p ? `spawn kimliği DOSYADAN: ${p} (${text.length} karakter komut satırından çıkarıldı)` : 'spawn kimliği dosyaya YAZILAMADI → satır-içi bayrağa düşüldü');
    }
    return p;
  };
}

module.exports = {
  PROMPT_FILE_FLAG,
  PROMPT_DIR,
  SWEEP_MAX_AGE_MS,
  probeSupport,
  resetSupportCache,
  promptDir,
  sweep,
  writePromptFile,
  createSink,
};
