// AD-WIN-01 — KOMUT SATIRI UZUNLUĞU: ölçüm + platform sınırı + hüküm (SAF modül).
//
// NEDEN VAR (müşteri P0, Cihan / Windows 11 / CrewPane 0.2.37). Ekip liderinin
// pane'i açılıyor ve terminalde TEK satır görünüyor:
//
//     The command line is too long.
//
// …ardından lider araçsız kalıyor (`/mcp` boş, `crewpane_delegate` yok). Sebep
// katalog/rol/paketleme DEĞİL: süreç HİÇ DOĞMUYOR. Ajan kimliği (`--append-system-
// prompt <8000 karaktere kadar metin>`) bir KOMUT SATIRI ARGÜMANI olarak geçiyor
// (agentRunner.withIdentity) ve Windows'ta motor `claude.cmd` (npm yolu) olduğu için
// binResolve.execArgs bütün argv'yi `cmd.exe /d /s /c "…"` içine sarıyor.
//
// ÜÇ FARKLI SINIR VAR, KARIŞTIRMA:
//   • cmd.exe komut satırı  → 8.191 karakter  (MS KB 830473; `cmd /c` bu sınırı taşır)
//   • CreateProcess lpCommandLine → 32.767 karakter (Win32 API sert tavanı)
//   • POSIX execve ARG_MAX  → macOS'ta 1.048.576 bayt (`getconf ARG_MAX`, ölçüldü)
// Aynı kod macOS'ta sorunsuz koşup Windows'ta ölmesinin TEK sebebi bu 128 kat fark.
//
// BU MODÜL NE YAPAR: node-pty'ye gidecek (file, argv) çiftinden İŞLETİM SİSTEMİNİN
// GÖRECEĞİ komut satırını üretir ve uzunluğunu platform sınırıyla karşılaştırır.
// Saf: `platform`/`env` enjekte edilebilir → Windows dalı macOS'ta gerçek girdilerle
// ölçülür ([[gate-for-a-platform-you-cannot-run]] §1: kararı icradan AYIR).

'use strict';

const binResolve = require('./binResolve.cjs');

/** cmd.exe'nin toplam komut satırı tavanı (MS KB 830473, XP ve sonrası). */
const WIN_CMD_LIMIT = 8191;

/** CreateProcess `lpCommandLine` sert tavanı (Win32 API dokümanı). */
const WIN_CREATEPROCESS_LIMIT = 32767;

/**
 * POSIX tarafı için kullanılan muhafazakâr taban. macOS'ta ölçülen ARG_MAX
 * 1.048.576; burada 256 KB'lık bir taban kullanıyoruz — amaç POSIX'te ASLA
 * yanlış alarm vermemek (bugünkü davranış bit-bit korunur), yalnızca gerçekten
 * absürt bir metin kaçağını yakalamak.
 */
const POSIX_SAFE_LIMIT = 262144;

/**
 * node-pty'nin `argsToCommandLine` fonksiyonunun BİREBİR kopyası (winpty projesinden
 * alınmış MSDN `CommandLineToArgvW` kaçış kuralı). Neden kopya: fonksiyon node-pty'den
 * export EDİLMİYOR ve bizim ölçmemiz gereken şey tam olarak onun ürettiği dize.
 * Kaynak: node-pty/lib/windowsPtyAgent.js (v1.1.x).
 */
function argsToCommandLine(file, args) {
  if (typeof args === 'string') {
    if (args.length === 0) return file;
    return `${argsToCommandLine(file, [])} ${args}`;
  }
  const argv = [file, ...(Array.isArray(args) ? args : [])];
  let result = '';
  for (let argIndex = 0; argIndex < argv.length; argIndex += 1) {
    if (argIndex > 0) result += ' ';
    const arg = String(argv[argIndex] == null ? '' : argv[argIndex]);
    const hasLopsidedEnclosingQuote = (arg[0] !== '"') !== (arg[arg.length - 1] !== '"');
    const hasNoEnclosingQuotes = arg[0] !== '"' && arg[arg.length - 1] !== '"';
    const quote =
      arg === '' ||
      ((arg.indexOf(' ') !== -1 || arg.indexOf('\t') !== -1) &&
        arg.length > 1 &&
        (hasLopsidedEnclosingQuote || hasNoEnclosingQuotes));
    if (quote) result += '"';
    let bsCount = 0;
    for (let i = 0; i < arg.length; i += 1) {
      const p = arg[i];
      if (p === '\\') {
        bsCount += 1;
      } else if (p === '"') {
        result += '\\'.repeat(bsCount * 2 + 1);
        result += '"';
        bsCount = 0;
      } else {
        result += '\\'.repeat(bsCount);
        bsCount = 0;
        result += p;
      }
    }
    if (quote) {
      result += '\\'.repeat(bsCount * 2);
      result += '"';
    } else {
      result += '\\'.repeat(bsCount);
    }
  }
  return result;
}

/**
 * `file`+`argv` → İŞLETİM SİSTEMİNİN göreceği komut satırı dizesi.
 *
 * win32'de İKİ dal var ve ikisinin SINIRI FARKLIDIR:
 *   • batch (`.cmd`/`.bat`) → `binResolve.execArgs` cmd.exe sarmalayıcısını kurar;
 *     ölçülen dize `<comSpec> /d /s /c "…"` → sınır cmd.exe'nin 8.191'i.
 *   • diğer (`.exe`)        → node-pty doğrudan CreateProcess'e gider → 32.767.
 * POSIX'te kabuk yoktur (execvp): "komut satırı" = argv elemanlarının toplamı.
 *
 * ÖNEMLİ — BİRİM: Windows sınırları KARAKTER (WCHAR) cinsindendir; JavaScript
 * `String.length` de UTF-16 kod birimi sayar, yani bu ölçüm Windows tarafında
 * BİREBİR doğru birimdedir (emoji = 2 birim, tıpkı Windows'ta olduğu gibi).
 * POSIX'te sınır BAYT olduğu için orada UTF-8 bayt uzunluğu sayılır.
 */
function commandLineFor({ file, argv = [], platform = process.platform, env = process.env } = {}) {
  const list = Array.isArray(argv) ? argv : [];
  if (platform !== 'win32') {
    // execvp: çekirdeğe giden şey argv dizisidir; ARG_MAX bayt üzerinden sayar.
    const parts = [String(file || ''), ...list.map((a) => String(a == null ? '' : a))];
    return { text: parts.join(' '), units: 'bytes', kind: 'posix-argv' };
  }
  const target = binResolve.execArgs(file, list, { platform: 'win32', env });
  if (target.commandLine) {
    // node-pty string-args yolu: argsToCommandLine(file, []) + ' ' + commandLine
    return {
      text: `${argsToCommandLine(target.file, [])} ${target.commandLine}`,
      units: 'chars',
      kind: 'win32-cmd',
    };
  }
  return { text: argsToCommandLine(target.file, target.argv), units: 'chars', kind: 'win32-createprocess' };
}

/** Bir `kind` için sert sınır + adı. */
function limitFor(kind) {
  if (kind === 'win32-cmd') return { limit: WIN_CMD_LIMIT, limitName: 'cmd.exe (8191)' };
  if (kind === 'win32-createprocess') return { limit: WIN_CREATEPROCESS_LIMIT, limitName: 'CreateProcess (32767)' };
  return { limit: POSIX_SAFE_LIMIT, limitName: `POSIX ARG_MAX güvenli taban (${POSIX_SAFE_LIMIT})` };
}

/**
 * HÜKÜM: bu spawn'ın komut satırı platform sınırına sığıyor mu?
 * → { fits, length, limit, limitName, kind, units, overBy }
 * Hiçbir zaman throw ETMEZ — ölçüm başarısız olursa `fits:true` döner (kapı asla
 * çalışan bir spawn'ı engellemez; yalnız KESİN taşmayı yakalar).
 */
function commandLineVerdict(input) {
  try {
    const built = commandLineFor(input);
    const length = built.units === 'bytes' ? Buffer.byteLength(built.text, 'utf8') : built.text.length;
    const { limit, limitName } = limitFor(built.kind);
    return {
      fits: length <= limit,
      length,
      limit,
      limitName,
      kind: built.kind,
      units: built.units,
      overBy: Math.max(0, length - limit),
    };
  } catch (e) {
    return { fits: true, length: 0, limit: 0, limitName: 'ölçülemedi', kind: 'unknown', units: 'chars', overBy: 0, error: String((e && e.message) || e) };
  }
}

/** Argv'nin hangi elemanı ne kadar yer kaplıyor (teşhis/log için, saf). */
function breakdown(argv = []) {
  const list = Array.isArray(argv) ? argv : [];
  return list.map((a, i) => {
    const s = String(a == null ? '' : a);
    return { index: i, length: s.length, head: s.slice(0, 40).replace(/\s+/g, ' ') };
  });
}

// ── Kullanıcıya görünen banner ───────────────────────────────────────────────
// SADE CÜMLE kuralı: kullanıcıya ham hata/stack trace GÖSTERİLMEZ. Sayılar teşhis
// için burada kalır (destek log'u yerine ekranı okuyabilsin), ama önce NE OLDUĞU ve
// NE YAPILACAĞI yazar.

const ESC = '\x1b';
const bold = (s) => `${ESC}[1m${s}${ESC}[0m`;
const warn = (s) => `${ESC}[33m${s}${ESC}[0m`;
const dim = (s) => `${ESC}[2m${s}${ESC}[0m`;
const cyan = (s) => `${ESC}[36m${s}${ESC}[0m`;

/**
 * "Komut satırı çok uzun" tutucu banner'ı (saf, test edilebilir).
 * Kullanıcıya ÜÇ şey söyler: ne oldu · neden bu makinede oluyor · ne yapmalı.
 *
 * `install` çağıran tarafından verilir (engineInstall.installInfo) — bu modül motor
 * kataloğunu BİLMEZ, ikinci bir kurulum-komutu gerçeği ÜRETMEZ (tek kaynak kuralı).
 *
 * ÖNERİNİN NEDENİ (ölçüldü): arıza yalnız motor bir BATCH dosyasıyken (npm yolu,
 * `claude.cmd`) doğar; resmî native installer `claude.exe` kurar ve o dal cmd.exe'yi
 * hiç görmez → sınır 8.191 değil 32.767 olur, aynı spawn RAHATÇA sığar. Yani burada
 * önerilen kurulum bir tahmin değil, doğrudan bu ölçümün sonucudur.
 */
function tooLongBanner(verdict = {}, install = {}) {
  const label = install.label || 'AI motoru';
  const command = install.command || null;
  const docsUrl = install.docsUrl || null;
  const lines = [
    '',
    warn('⚠  Ajan başlatılamadı — başlatma komutu bu sistemin sınırını aşıyor'),
    '',
    `Bu ajanın kimliği ve araç ayarları ${bold('komut satırıyla')} aktarılıyor.`,
    'Bu satırın işletim sisteminde bir üst sınırı var ve bu ajanda aşıldı:',
    '',
    `    gereken: ${bold(String(verdict.length ?? '?'))} karakter · ` +
      `izin verilen: ${bold(String(verdict.limit ?? '?'))} (${verdict.limitName || 'sistem sınırı'})`,
    '',
    dim('Motor hiç başlatılmadı — bu yüzden pane boş görünüyor.'),
    dim('Uygulamanın geri kalanı çalışmaya devam eder.'),
    '',
    bold('Ne yapmalı:'),
    `  1. ${label} motorunu ${bold('resmî kurulum')} ile yeniden kur.`,
    dim('     (npm ile kurulan sürüm bu sınıra takılıyor; resmî kurulum takılmıyor.)'),
  ];
  if (command) lines.push('', `     ${cyan(command)}`, '');
  if (docsUrl) lines.push(dim(`     Adımlar: ${docsUrl}`), '');
  lines.push(
    '  2. Sorun sürerse Ayarlar → Sistem Durumu → Destek\'ten',
    '     tanı bilgisini kopyalayıp bize gönder.',
    '',
    dim('Kurulum bitince bu pencerede "Tekrar dene" düğmesine bas.'),
    '',
  );
  return lines.join('\r\n') + '\r\n';
}

module.exports = {
  tooLongBanner,
  WIN_CMD_LIMIT,
  WIN_CREATEPROCESS_LIMIT,
  POSIX_SAFE_LIMIT,
  argsToCommandLine,
  commandLineFor,
  limitFor,
  commandLineVerdict,
  breakdown,
};
