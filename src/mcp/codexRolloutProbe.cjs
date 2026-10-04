// ENG-02 — codex teslim/uyandırma probu: pane → `~/.codex/sessions/**/rollout-*.jsonl`.
//
// NEDEN VAR: ADP-280/705/920 kurtarma merdiveninin tamamı `transcriptHas` /
// `wakeVerifiable` / `leaderTranscriptHas` üçlüsüne asılıdır ve bu üçü bugüne kadar
// claude-only'ydi (`main.js` — codex pane'inde hep `null` = "bakılamadı"). Sonuç:
// codex pane'inde prompt yutulursa KİMSE fark etmiyordu — ne yeniden gönderim, ne
// taze-pane kurtarması, ne `undelivered`, ne lidere uyarı. ENG-R1 §6 Boşluk-2.
//
// codex'in kendi oturum defteri VAR ve prompt metnini HAM olarak taşır. ÖLÇÜLDÜ
// (2026-08-17, codex-cli 0.147, gerçek pty, izole CODEX_HOME):
//
//   • Kimlik POZİSYONEL prompt'uyla açılan TUI (üretimdeki spawn — `agentRunner.js:459`)
//     defteri pane açılışından **+1.35 sn** sonra yazar:
//       T0=17:59:16.4  →  session_meta.timestamp=17:59:17.781Z  (ROLLOUT DOĞDU +1609ms)
//     ⇒ `bornAt ≈ startedAt` varsayımı ÜRETİMDE geçerli; iki-yanlı pencere kurulabilir.
//   • Pozisyonel prompt OLMADAN açılan TUI defteri HİÇ yazmaz (ilk tur gelene kadar) —
//     bu yüzden "dosya yok" ASLA pozitif "teslim edilmedi" kanıtı sayılmaz (aşağıya bak).
//   • `session_meta.payload.cwd` **realpath**'tir: spawn cwd'si `/var/folders/…` iken
//     deftere `/private/var/folders/…` düşer → ham cwd ile eşleme TEK BAŞINA TUTMAZ.
//   • Kullanıcı mesajı deftere iki kez düşer (`response_item role=user` +
//     `event_msg type=user_message`) ve metin HAM'dır → düz alt-dizi araması yeter
//     (`deliveryNeedle` zaten `"` ve `\` içermeyen tek satır üretir → JSON kaçışı
//     needle'ı bozmaz; claude probuyla AYNI sözleşme).
//
// 🪤 EŞLEMENİN SINIRI — ve bu modülün asıl işi: codex pane başına oturum kimliği
// VERMEZ (claude'da `--session-id <uuid>` bizim). Eşleme cwd + açılış zamanı ile
// yapılır ve AYNI cwd'de birden çok codex pane'i normaldir (ölçüldü: bu makinede tek
// bir cwd altında 24 oturum). Bu yüzden kural: **güven düşükse `null`**. Yanlış
// "teslim edildi" demek yanlış "bakılamadı"dan KÖTÜDÜR (ilki kurtarma merdivenini
// sessizce kapatır; ikincisi yalnız eski davranışa düşer). ADP-705'in tersi de doğru:
// yanlış `undelivered` çalışan worker'ı öldürür — o yüzden belirsizlikte de `null`.
//
// Sözleşme `transcriptProbe.transcriptContains` ile BİREBİR aynıdır:
// `{ found, checked, file, reason }` + codex'e özel `candidates` künyesi.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Defter DOSYALARINI listeleme işi zaten ölçülmüş ve sınırlanmış hâlde tokenUsage'da:
// ~/.codex/sessions ağacını yeniden-eskiye yürür, 120 günden eskiyi atar, dosya
// sayısını tavanlar. Kopyalamak yerine ORTAK KULLANILIR (tek gerçek tek yer).
const tokenUsage = require('../services/tokenUsage.cjs');

/**
 * Pane açılış damgası ile codex sürecinin defteri yazması arasındaki pay.
 * GERİYE pay: `startedAt` main'de pty spawn'ından ÖNCE damgalanır, ayrıca saat
 * çözünürlüğü/uyku sapması. İLERİ pay: ölçülen +1.35 sn'ye karşı bol tampon
 * (soğuk başlangıç, MCP sunucu kurulumu, yavaş disk).
 */
const PRE_SLACK_MS = 15_000;
const POST_SLACK_MS = 120_000;

/**
 * İKİ ADAY ARASINDAKİ AYIRT EDİLEBİLİRLİK EŞİĞİ. Pencereye birden çok defter
 * giriyorsa (aynı cwd'de arka arkaya açılmış pane'ler, ya da pane içinde `/new`)
 * pane'e EN YAKIN doğan seçilir — ama yalnız ikincisi bu kadar UZAKTAYSA. Aksi
 * hâlde iki aday ayırt edilemez ⇒ `null` ("bakılamadı"), tahmin YOK.
 */
const SEPARATION_MS = 20_000;

/** Tek okumada taranacak en çok bayt. Defter 8MB'den küçükse TAMAMI okunur. */
const MAX_SCAN_BYTES = 8 * 1024 * 1024;

/** session_meta ilk satırdadır; künye için bu kadar bayt fazlasıyla yeter. */
const HEAD_BYTES = 64 * 1024;

/** codexHome çözümü — tokenUsage ile AYNI seam (enjeksiyon > env > ~/.codex). */
function codexHomeDir(override) {
  return override || process.env.CREWPANE_CODEX_HOME || path.join(os.homedir(), '.codex');
}

/** Dosyanın ilk `bytes` baytı (yoksa/okunamazsa null — asla fırlatmaz). */
function readHead(file, bytes = HEAD_BYTES) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const n = fs.readSync(fd, buf, 0, bytes, 0);
      return buf.subarray(0, n).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Dosyanın son min(size, MAX_SCAN_BYTES) baytı (yoksa/okunamazsa null). */
function readScanTail(file, maxBytes = MAX_SCAN_BYTES) {
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      if (buf.length === 0) return '';
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Defterin künyesi (saf — metin girer, künye çıkar).
 * Satır şeması: `{type:'session_meta', payload:{id, timestamp, cwd, originator}}`.
 * @returns {{ sessionId: string|null, cwd: string|null, bornAt: number|null, originator: string|null }|null}
 */
function parseSessionMeta(head) {
  if (typeof head !== 'string' || !head) return null;
  for (const raw of head.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] !== '{') continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // yarım son satır (head kesmesi) — sessizce atla
    }
    if (!row || row.type !== 'session_meta') continue;
    const p = row.payload && typeof row.payload === 'object' ? row.payload : {};
    const ms = typeof p.timestamp === 'string' ? Date.parse(p.timestamp) : NaN;
    return {
      sessionId: typeof p.id === 'string' ? p.id : null,
      cwd: typeof p.cwd === 'string' ? p.cwd : null,
      bornAt: Number.isFinite(ms) ? ms : null,
      originator: typeof p.originator === 'string' ? p.originator : null,
    };
  }
  return null;
}

/** cwd'nin bilinen tüm yazımları (ham + realpath) — ölçülen `/var` ↔ `/private/var` tuzağı. */
function cwdForms(cwd) {
  const forms = new Set();
  if (typeof cwd === 'string' && cwd) {
    forms.add(cwd);
    forms.add(cwd.replace(/\/+$/, ''));
    try {
      forms.add(fs.realpathSync(cwd));
    } catch {
      /* cwd silinmiş olabilir → ham hâliyle devam */
    }
  }
  return forms;
}

/**
 * Bu pane'in defteri hangisi? — GÜVEN KAPILI eşleme.
 *
 * @param {{cwd?: string, startedAt?: number}} paneInfo
 * @param {{codexHome?: string, files?: Array<{file: string, mtimeMs: number}>}} [opts]
 *   `files` yalnız test seam'i (gerçek ağaç yürüyüşü yerine hazır liste).
 * @returns {{ file: string|null, reason: string, candidates: number, bornAt: number|null }}
 *   reason: 'ok' | 'no-target' | 'no-session' | 'ambiguous'
 */
function matchPaneRollout(paneInfo, opts) {
  const info = paneInfo || {};
  const o = opts || {};
  const startedAt = typeof info.startedAt === 'number' && Number.isFinite(info.startedAt) ? info.startedAt : null;
  const forms = cwdForms(info.cwd);
  if (!forms.size || startedAt === null) return { file: null, reason: 'no-target', candidates: 0, bornAt: null };

  const lo = startedAt - PRE_SLACK_MS;
  const hi = startedAt + POST_SLACK_MS;
  const files = Array.isArray(o.files) ? o.files : tokenUsage.codexRolloutFiles(codexHomeDir(o.codexHome));

  const found = [];
  for (const row of files) {
    if (!row || typeof row.file !== 'string') continue;
    // UCUZ ELEME: defter EKLEMELİ → mtime her zaman bornAt'tan büyüktür. Penceremizin
    // altında kalan dosyanın başlığını okumaya hiç gerek yok (yüzlerce dosya × head okuma).
    if (typeof row.mtimeMs === 'number' && row.mtimeMs < lo) continue;
    const meta = parseSessionMeta(readHead(row.file));
    if (!meta || meta.bornAt === null || !meta.cwd) continue;
    if (!forms.has(meta.cwd)) continue;
    if (meta.bornAt < lo || meta.bornAt > hi) continue;
    found.push({ file: row.file, bornAt: meta.bornAt, delta: Math.abs(meta.bornAt - startedAt) });
  }

  if (!found.length) return { file: null, reason: 'no-session', candidates: 0, bornAt: null };
  found.sort((a, b) => a.delta - b.delta);
  if (found.length > 1 && found[1].delta - found[0].delta < SEPARATION_MS) {
    // İki defter pane açılışına neredeyse AYNI uzaklıkta doğmuş → hangisinin bu
    // pane'e ait olduğunu ÖLÇEMEYİZ. Tahmin etmek yerine "bakılamadı" deriz.
    return { file: null, reason: 'ambiguous', candidates: found.length, bornAt: null };
  }
  return { file: found[0].file, reason: 'ok', candidates: found.length, bornAt: found[0].bornAt };
}

/**
 * Pane'in codex defterinde `needle` geçiyor mu?
 *
 * `transcriptProbe.transcriptContains` ile AYNI sözleşme:
 *   checked=false → hüküm YOK (çağıran `null` okur; ASLA `undelivered` üretmez)
 *   found yalnız checked=true iken anlamlı.
 *
 * reason:
 *   'no-target'   cwd/startedAt/needle eksik → gerçekten bilinmiyor.
 *   'no-session'  pencerede bu cwd'ye ait defter YOK. ⚠️ Bu, claude'daki
 *                 'session-not-started' gibi POZİTİF bir kanıt DEĞİLDİR: pozisyonel
 *                 prompt olmadan açılan codex TUI'si ilk tura kadar defter yazmaz
 *                 (ölçüldü) → "yok" = "henüz yazmadı" da olabilir.
 *   'ambiguous'   pencerede ayırt edilemeyen birden çok defter → güven düşük.
 *   'unreadable'  defter bulundu ama okunamadı (izin/yarış).
 *   'ok'          okundu; `found` geçerli.
 *
 * @returns {{ found: boolean, checked: boolean, file: string|null, reason: string, candidates: number }}
 */
function rolloutContains(paneInfo, needle, opts) {
  const info = paneInfo || {};
  if (!needle) return { found: false, checked: false, file: null, reason: 'no-target', candidates: 0 };
  const m = matchPaneRollout(info, opts);
  if (!m.file) return { found: false, checked: false, file: null, reason: m.reason, candidates: m.candidates };
  const text = readScanTail(m.file);
  if (text === null) {
    return { found: false, checked: false, file: m.file, reason: 'unreadable', candidates: m.candidates };
  }
  return { found: text.includes(needle), checked: true, file: m.file, reason: 'ok', candidates: m.candidates };
}

/**
 * Bu pane için defter okumaya ÇALIŞMAYA değer mi? (`wakeVerifiable`in codex dalı.)
 * Yalnız "hedef bilgisi var mı" der — hükmü `rolloutContains` verir; eşleme belirsiz
 * çıkarsa çağıran zaten `null` görür ve eski davranışa (teslim=ack) düşer.
 */
function rolloutVerifiable(paneInfo) {
  const info = paneInfo || {};
  return !!(info.cwd && typeof info.startedAt === 'number' && Number.isFinite(info.startedAt));
}

module.exports = {
  PRE_SLACK_MS,
  POST_SLACK_MS,
  SEPARATION_MS,
  MAX_SCAN_BYTES,
  codexHomeDir,
  readHead,
  readScanTail,
  parseSessionMeta,
  matchPaneRollout,
  rolloutContains,
  rolloutVerifiable,
};
