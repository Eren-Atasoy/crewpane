// CRASH-R1 — KALICI ÇÖKME/KAPANIŞ DEFTERİ (`<instanceHome>/crash-journal.jsonl`).
//
// NEDEN VAR (ölçülmüş, 16.09 01:39): uygulama Eren başında değilken kapandı ve
// "neden" sorusu SAATLER süren bir günlük arkeolojisine dönüştü. Elde olan her
// şey dolaylıydı:
//   • `~/Library/Logs/crewpane-shell/*.log` — rotasyon kanıtı böler ve duman
//     kopyasının satırlarıyla karışır (bkz. logTarget.cjs).
//   • macOS birleşik günlüğü — `log show` YALNIZ son ~saatleri tutar ve olaydan
//     sonra koşulursa pencere kapanmış olur.
//   • DiagnosticReports — TEMİZ kapanışta hiç dosya yazılmaz (ölçüldü: 16.09
//     olayında CrewPane için sıfır rapor).
//
// ÖLÇÜLEN BOŞLUK: uygulama kapanış yolunu DÜZGÜN koştu (`before-quit` çalıştı,
// pane defteri yazıldı, çıkış durumu 0) — yani "çökme" değil, BİRİ `app.quit()`
// çağırdı. Ama HANGİ çağrı olduğu hiçbir yere yazılmıyordu. Bu defter tam olarak
// o eksiği kapatır: her kapanış, SEBEBİYLE birlikte, tek satır JSON olarak diske
// düşer ve bir sonraki açılış onu günlüğün BAŞINA basar.
//
// SINIRI DÜRÜSTÇE: SIGKILL (jetsam / Force Quit / kernel panic) hiçbir JS
// handler'ı koşturmaz → o vakada satır YAZILAMAZ. Bunu gizlemiyoruz: açılışta
// "önceki kapanış defterde YOK" satırı basılır ve bu BAŞLI BAŞINA bir kanıttır
// (temiz kapanışta satır hep vardır — yokluğu 'sert ölüm' demektir).
//
// PLATFORM: saf fs/JSON — darwin/win32/linux'ta aynı. Yol `instanceHome()`ten
// gelir (Windows'ta `%USERPROFILE%\.crewpane`), ayırıcıyı `path` verir.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FILE = 'crash-journal.jsonl';
/** Defter SINIRLI: olay incelemesi son onlarca kapanışa bakar, yıllara değil. */
const MAX_ENTRIES = 200;

/** Bilinen kapanış sebepleri. Listede olmayan bir sebep de yazılır (dürüstlük > şema). */
const REASONS = Object.freeze([
  'user-quit',     // kullanıcı Cmd+Q / pencere kapattı
  'signal',        // dışarıdan SIGTERM/SIGHUP/SIGINT (killall, installer, pkill)
  'relaunch',      // hesap değişimi / rebuild — app.relaunch() + quit
  'update',        // updater quitAndInstall
  'watchdog',      // e2e ebeveyn nöbetçisi / autotest zaman aşımı
  'next-server-gone', // gömülü Next sunucusu BEKLENMEDİK öldü (main.js ADP-334 dalı)
  'probe',         // CREWPANE_APP_PROBE duman testi kendini kapattı
  'fatal',         // açılışta yakalanmış ölümcül hata
  'unknown',       // sebep işaretlenmeden quit edildi — bu da bir BULGUDUR
]);

function journalPath(home) {
  return path.join(String(home || ''), FILE);
}

/**
 * Tek kapanış kaydı yaz. ASLA fırlatmaz ve ASLA çıkışı geciktirmez:
 * `before-quit` içinde koşar, senkron ve tek `appendFileSync` çağrısıdır.
 *
 * @param {string} home  instanceHome() — `~/.crewpane`
 * @param {object} entry {reason, signal?, uptimeMs, rssBytes, panes, version, pid}
 * @returns {boolean} yazıldı mı
 */
function record(home, entry = {}, deps = {}) {
  const writeFile = deps.appendFileSync || fs.appendFileSync;
  const mkdir = deps.mkdirSync || fs.mkdirSync;
  const line = {
    at: entry.at || new Date().toISOString(),
    reason: entry.reason || 'unknown',
    ...(entry.signal ? { signal: entry.signal } : {}),
    uptimeMs: Number.isFinite(entry.uptimeMs) ? Math.round(entry.uptimeMs) : null,
    rssMb: Number.isFinite(entry.rssBytes) ? Math.round(entry.rssBytes / 1024 ** 2) : null,
    panes: Number.isFinite(entry.panes) ? entry.panes : null,
    version: entry.version || null,
    pid: Number.isFinite(entry.pid) ? entry.pid : null,
  };
  try {
    try { mkdir(String(home), { recursive: true }); } catch { /* zaten var */ }
    writeFile(journalPath(home), `${JSON.stringify(line)}\n`);
    return true;
  } catch {
    return false; // defter yazılamadıysa kapanış YİNE DE sürer
  }
}

/** Defterdeki SON kayıt (yoksa null). Bozuk satır sessizce atlanır. */
function readLast(home, deps = {}) {
  const readFile = deps.readFileSync || fs.readFileSync;
  let raw;
  try { raw = String(readFile(journalPath(home), 'utf8')); } catch { return null; }
  const lines = raw.split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch { /* bozuk satır — bir öncekine bak */ }
  }
  return null;
}

/**
 * Defteri MAX_ENTRIES satıra buda. Açılışta bir kez koşar; dosya küçükse dokunmaz
 * (gereksiz yazma yok).
 */
function trim(home, deps = {}) {
  const readFile = deps.readFileSync || fs.readFileSync;
  const writeFile = deps.writeFileSync || fs.writeFileSync;
  const max = deps.max || MAX_ENTRIES;
  let raw;
  try { raw = String(readFile(journalPath(home), 'utf8')); } catch { return 0; }
  const lines = raw.split('\n').filter((l) => l.trim());
  if (lines.length <= max) return 0;
  const keep = lines.slice(lines.length - max);
  try { writeFile(journalPath(home), `${keep.join('\n')}\n`); } catch { return 0; }
  return lines.length - keep.length;
}

/** İnsan cümlesi — açılışta günlüğe basılır. */
function formatPrevious(entry) {
  if (!entry) {
    // SIGKILL/panic yolu: temiz kapanışta satır HEP yazılır, yokluğu bulgudur.
    return 'önceki kapanış: defterde KAYIT YOK — ya bu ilk açılış ya da süreç '
      + 'SIGKILL ile öldü (jetsam / Force Quit / kernel panic: hiçbir handler koşmaz)';
  }
  const when = String(entry.at || '').replace('T', ' ').replace(/\.\d+Z$/, 'Z');
  const bits = [];
  if (entry.signal) bits.push(`sinyal ${entry.signal}`);
  if (Number.isFinite(entry.uptimeMs)) bits.push(`ayakta ${Math.round(entry.uptimeMs / 60000)} dk`);
  if (Number.isFinite(entry.rssMb)) bits.push(`rss ${entry.rssMb} MB`);
  if (Number.isFinite(entry.panes)) bits.push(`${entry.panes} pane`);
  if (entry.version) bits.push(`sürüm ${entry.version}`);
  return `önceki kapanış: ${entry.reason || 'unknown'} @ ${when}`
    + (bits.length ? ` (${bits.join(' · ')})` : '');
}

module.exports = { record, readLast, trim, formatPrevious, journalPath, REASONS, FILE, MAX_ENTRIES };
