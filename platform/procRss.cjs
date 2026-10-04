// WIN-FIX-01 (W1 · yan bulgu) — SÜREÇ BELLEK ÖLÇÜMÜNÜN TEK BOĞAZI.
//
// NEDEN AYRI BİR MODÜL. ADP-874 win32 RSS ölçümünü DOĞRU çözdü, ama çözümü
// `whisperLocal.cjs`in İÇİNDE kaldı. `claudeBrainSession.cjs` aynı ölçümü YENİDEN,
// win32 dalı OLMADAN yazdı:
//     execFile('/bin/ps', ['-o','rss=','-p', pid], …)
// Windows'ta `/bin/ps` yoktur → `err` gelir → `resolve(null)` → RSS **hiç ölçülmez**
// ve `MAX_RSS_MB` TAVANI HİÇ TETİKLENMEZ. Yani Windows'ta beyin oturumu sınırsız
// büyüyebilir ve kimse bir hata görmez (ADR-W7'nin "sessiz" işareti).
//
// İkinci kopya yazmak yerine ADP-874'ün ÖLÇÜLMÜŞ kodu buraya taşındı;
// `whisperLocal` bu modülden yeniden dışa aktarıyor (kendi testleri değişmedi).
//
// SAF: exec YOK, yalnız "hangi komut" + "çıktı nasıl okunur" kararı.
// Çalıştır: node --test electron/platform/procRss.test.cjs
'use strict';

const path = require('node:path');

/**
 * ADP-874 — RSS ölçümünün platform komutu. SAF (exec yok) → birim testiyle ölçülür.
 * posix : `/bin/ps -o rss= -p <pid>`  → tek sayı, KİLObayt
 * win32 : `tasklist /FI "PID eq <pid>" /FO CSV /NH` → CSV, son alan "12.345 K"
 *         (TR yerelinde binlik ayırıcı `.`, EN'de `,` — ikisi de temizlenir).
 * `tasklist.exe` MUTLAK yolla çağrılır: PATH bayat olabilir (bkz. restrictPath/
 * holderShell aynı gerekçe).
 */
function rssCommand(pid, { platform, env } = {}) {
  const plat = platform || process.platform;
  if (plat !== 'win32') return { file: '/bin/ps', argv: ['-o', 'rss=', '-p', String(pid)], unit: 'kb' };
  const root = (env || process.env).SystemRoot || (env || process.env).windir || 'C:\\Windows';
  return {
    file: path.win32.join(root, 'System32', 'tasklist.exe'),
    argv: ['/FI', `PID eq ${String(pid)}`, '/FO', 'CSV', '/NH'],
    unit: 'kb',
  };
}

/**
 * ADP-874 — komut çıktısını KB'ye çevir. SAF.
 * posix: çıplak sayı. win32: CSV satırının SON alanı ("1.234 K" / "1,234 K").
 * Ayrıştıramazsak 0 → tavan kapısı sessizce atlanır (fail-open; yanlış bir sayı
 * yüzünden çalışan bir süreci öldürmek daha kötü olurdu).
 */
function parseRssKb(stdout, platform) {
  const raw = String(stdout || '').trim();
  if (!raw) return 0;
  if ((platform || process.platform) !== 'win32') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  // tasklist CSV: "img.exe","1234","Console","1","12.345 K"
  const line = raw.split(/\r?\n/).filter(Boolean).pop() || '';
  const fields = line.match(/"([^"]*)"/g);
  if (!fields || !fields.length) return 0;
  const mem = fields[fields.length - 1].replace(/"/g, '');
  // "INFO: No tasks…" gibi bir satır geldiyse rakam yoktur → 0.
  const digits = mem.replace(/[^\d]/g, '');
  const n = Number(digits);
  return Number.isFinite(n) && digits ? n : 0;
}

module.exports = { rssCommand, parseRssKb };
