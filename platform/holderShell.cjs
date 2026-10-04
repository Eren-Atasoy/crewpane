// ADP-833 (ADR-W7 · ADR-W10 Kural 2) — REHBER PANE'İNİ AYAKTA TUTAN SÜREÇ.
//
// NEDEN VAR (790 M4/S8). Motor kurulu değilken pane'de motor yerine bir "tutucu"
// açılır: kurulum rehberini basar, canlı kalır, ama yazılan HİÇBİR ŞEYİ ÇALIŞTIRMAZ.
// Bugünkü tutucu `/bin/sh -c "printf …; while :; do sleep …; done"` — Windows'ta
// `/bin/sh` YOKTUR: `pty.spawn` ENOENT verir, IPC hata döner, pane HİÇ AÇILMAZ.
// Yani motoru olmayan Windows kullanıcısı rehberi bile göremez; ajana tıklar ve
// hiçbir şey olmaz (ADP-694'ün kapattığı sessiz ölümün Windows'ta geri dönüşü).
//
// WINDOWS TASARIMI — İKİ DEĞİŞMEZ AYNEN KORUNUR:
//   1. GİRDİ ÇALIŞMAZ. `powershell.exe -NonInteractive -Command …` stdin'i komut
//      olarak okumaz; gövde sonsuz `Start-Sleep` döngüsüdür. Delegasyon motoru bu
//      pane'i canlı sanıp görev metni yazsa bile o metin ÇALIŞMAZ (POSIX tarafındaki
//      `printf` + `sleep` tutucusuyla aynı güvenlik hikâyesi).
//   2. ENJEKSİYON YÜZEYİ SIFIR. Banner PowerShell kaynağına GÖMÜLMEZ; base64'e
//      çevrilip `[Convert]::FromBase64String` ile geri açılır. Base64 alfabesi
//      (A-Za-z0-9+/=) tırnak, `$`, `;`, backtick taşıyamaz → kaçış hatası
//      YAPISAL OLARAK imkânsız. Komutun tamamı ayrıca `-EncodedCommand` (UTF-16LE
//      base64) olarak geçer, yani cmd/PowerShell tırnak ayrıştırması hiç devreye girmez.
//   3. TÜRKÇE + EMOJİ. `[Console]::OutputEncoding = UTF8` konsol kod sayfasını
//      65001'e çeker; aksi hâlde TR yerelinde OEM 857 ile mojibake olurdu
//      (792 §3.3 — macOS'un `ensureUtf8Locale` sorununun Windows ikizi).
//
// macOS DAVRANIŞI BİT-BİT AYNI: posix dalı bugünkü satırın kendisidir.
'use strict';

const nodePath = require('node:path');

/** Tutucunun uyanma aralığı — süreç uykuda, ölçülebilir CPU maliyeti yok. */
const HOLDER_SLEEP_SECONDS = 86400;

/** Tek-tırnaklı POSIX sh sözcüğü (`'` → `'\''`). Saf. */
function shSingleQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Windows PowerShell'in MUTLAK yolu. PATH bayat/bozuk olabilir (tam da motorun
 * bulunamamasının sebebi bu olabilir) → tutucuyu PATH'e bağlamak, kurtarma yolunu
 * kırılmış olabilecek şeye bağlamak olurdu. `powershell.exe` (Windows PowerShell
 * 5.1) 1903+ her kurulumda vardır; `pwsh` OLABİLİR ki yok — bilerek kullanılmaz.
 */
function powershellPath(env) {
  const systemRoot = (env && (env.SystemRoot || env.windir)) || 'C:\\Windows';
  return nodePath.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** PowerShell `-EncodedCommand` kodlaması: UTF-16LE + base64. Saf. */
function encodePowershellCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

/**
 * Rehber pane'ini ayakta tutan sürecin `{ file, argv }`'si.
 * `deps.platform` / `deps.env` / `deps.shell` / `deps.sleepSeconds` enjekte edilebilir.
 */
function guidanceHolderArgv(banner, deps = {}) {
  const platform = deps.platform || process.platform;
  const sleepSeconds = Number(deps.sleepSeconds) > 0 ? Math.floor(Number(deps.sleepSeconds)) : HOLDER_SLEEP_SECONDS;

  if (platform === 'win32') {
    const payload = Buffer.from(String(banner == null ? '' : banner), 'utf8').toString('base64');
    const script =
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8;' +
      `[Console]::Out.Write([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')));` +
      `while($true){Start-Sleep -Seconds ${sleepSeconds}}`;
    return {
      file: deps.shell || powershellPath(deps.env || process.env),
      argv: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowershellCommand(script)],
    };
  }

  const script = `printf '%s' ${shSingleQuote(banner)}; while :; do sleep ${sleepSeconds}; done`;
  return { file: deps.shell || '/bin/sh', argv: ['-c', script] };
}

module.exports = {
  HOLDER_SLEEP_SECONDS,
  shSingleQuote,
  powershellPath,
  encodePowershellCommand,
  guidanceHolderArgv,
};
