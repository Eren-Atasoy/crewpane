// ADP-280 — worker transcript teslim-doğrulama probu (main-side).
//
// claude her konuşmayı `~/.claude/projects/<munged-cwd>/<sessionId>.jsonl`'e yazar
// (cwd'deki her alfanumerik-dışı karakter '-'). Delegasyon prompt'u pane'e YAZILMIŞ
// olması teslim edildiği anlamına gelmez (resume-picker / boot yutması — ADP-280
// vakası): teslimin tek güvenilir kanıtı prompt metninin TRANSKRİPTE düşmesidir.
// Bu modül "pane'in transcript'inde şu metin var mı?"yı cevaplar; renderer'a
// `pty:transcriptContains` IPC'siyle açılır (fs erişimi main'de kalır; pane→
// sessionId/cwd çözümü de main'in pty defterinden gelir — renderer path GEÇEMEZ).
//
// CREWPANE_CLAUDE_HOME: test seam'i (e2e fake-claude transcript'i tmp'ye yazar).

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ledgerPath = require('../config/ledgerPath.cjs');

// Son bu kadar baytı tara — transcript büyüyebilir; teslim kanıtı her zaman
// dosyanın sonuna yakındır (yeni prompt).
const TAIL_BYTES = 512 * 1024;

/**
 * claude proje-dizini adı.
 *
 * TOK-01 — kural artık TAHMİN değil, Claude Code ikilisinden okunmuş hâli:
 * NFC + (alfanumerik-dışı → '-') + 200 karakter tavanı + base36 hash soneki.
 * Gerekçe ve ikili alıntıları `ledgerPath.cjs` başlığında. Eski hâli yalnız ilk
 * parçayı biliyordu → uzun ya da ASCII-dışı cwd'de HESAPLANAN DİZİN HİÇ YOKTU.
 */
function mungeProjectDir(cwd) {
  return ledgerPath.projectDirName(cwd);
}

/** claudeHome çözümü — tek yer (enjeksiyon > env > ~/.claude). */
function claudeHomeDir(claudeHome) {
  return claudeHome || process.env.CREWPANE_CLAUDE_HOME || path.join(os.homedir(), '.claude');
}

/** Pane cwd + sessionId → transcript dosya yolu (claudeHome enjekte edilebilir). */
function transcriptPath(cwd, sessionId, claudeHome) {
  if (!cwd || !sessionId) return null;
  return path.join(claudeHomeDir(claudeHome), 'projects', mungeProjectDir(cwd), `${sessionId}.jsonl`);
}

/**
 * ADP-306 — KANONİK-YOL TUZAĞI (canlı yakalandı): claude proje dizinini KENDİ
 * gördüğü cwd'den türetir; macOS'ta /var → /private/var (ve her symlink'li kök)
 * çözülür. pty defterindeki ham cwd ('/var/folders/…') ile claude'un yazdığı
 * ('/private/var/folders/…') munge'ları TUTMAZ → transcript "yok" sanılır.
 * (ADP-280 teslim-doğrulaması da bu yüzden sessizce buffer'a düşüyordu.)
 *
 * TOK-01 — AYNI SINIF, DAHA GENİŞ: ADP-306 tuzağı macOS'a özel sanılmıştı; aslında
 * "cwd'nin yazımı ≠ claude'un gördüğü yazım" sınıfının tek örneğiydi. Kardeşleri:
 * Windows sürücü harfi kasası (`c:` ↔ `C:`), `\\?\` uzun-yol öneki, UNC payları,
 * sondaki ayraç, NFC/NFD ve 200 karakter tavanı. Adayların tamamı (ve hiçbiri
 * tutmazsa oturum-kimliğiyle tarama) `ledgerPath.resolveSessionFile` içinde.
 *
 * Sözleşme DEĞİŞMEDİ: var olan dosya bulunursa o, bulunamazsa birincil aday
 * döner (çağıran `checked=false` / `session-not-started` görür).
 */
function resolveTranscriptFile(cwd, sessionId, claudeHome) {
  if (!cwd || !sessionId) return null;
  return ledgerPath.resolveSessionFile(cwd, sessionId, claudeHomeDir(claudeHome)).file;
}

/**
 * `resolveTranscriptFile`in KÜNYELİ hâli — dosya bulundu mu, hangi yoldan?
 * TOK-01: jeton kartı "bulunamadı"yı "0 jeton"dan ayırabilsin diye eklendi;
 * `via` alanı ölçüm tablosunda hangi normalizasyonun işe yaradığını gösterir.
 */
function resolveTranscript(cwd, sessionId, claudeHome) {
  if (!cwd || !sessionId) return { file: null, found: false, via: 'none', candidates: 0 };
  return ledgerPath.resolveSessionFile(cwd, sessionId, claudeHomeDir(claudeHome));
}

/** Dosya var mı? (asla fırlatmaz — erişilemeyen yol "yok" sayılmaz, false döner.) */
function fileExists(file) {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

/** Dosyanın son TAIL_BYTES'ını oku (yoksa/okunamazsa null — asla fırlatmaz). */
function readTail(file) {
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - start);
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
 * Transcript'te `needle` geçiyor mu?
 * @returns {{ found: boolean, checked: boolean, file: string|null, reason: string }}
 *   checked=false → transcript okunamadı (teslim hükmü VERME — çağıran bunu "kanıt yok"
 *   değil "bakılamadı" okumalı; yanlış 'undelivered' üretmesin diye ayrı bayrak).
 *   found yalnız checked=true iken anlamlı.
 *
 * ADP-896 — `reason` NEDEN bakılamadığını söyler ve checked=false'u İKİYE böler:
 *
 *   'no-target'           cwd/sessionId/needle eksik → GERÇEKTEN bilinmiyor.
 *   'unreadable'          dosya VAR ama okunamadı (izin/yarış) → bilinmiyor.
 *   'session-not-started' sessionId BİZİM mint ettiğimiz id (agentRunner
 *                         `--session-id <uuid>` ile spawn eder) ve o id'nin dosyası
 *                         HİÇ YOK. claude ilk mesajı alır almaz bu dosyayı yazar →
 *                         yokluğu "bakamadım" değil, "oturum tek mesaj bile
 *                         ALMADI"nın POZİTİF kanıtıdır.
 *
 * NEDEN önemli (ADP-896 canlı vakası): pane-128'in prompt'u ekranda
 * `[Pasted text #1 +6 lines]` olarak asılı kaldı, transkript dosyası HİÇ oluşmadı.
 * Eski kod bunu `checked:false` → çağıran tarafta `null` ("bakılamadı") diye okuyor,
 * teslim doğrulaması İLK TURDA sessizce vazgeçiyordu: yeniden gönderim yok, taze-pane
 * kurtarması yok, 'undelivered' yok, lidere uyarı yok. Yani başarısızlığın EN GÜÇLÜ
 * kanıtı, tam da onu susturan sinyaldi.
 */
function transcriptContains(paneInfo, needle, claudeHome) {
  const info = paneInfo || {};
  // ADP-306 — kanonik-yol aday çözümü (symlink'li cwd'de dosya "yok" sanılmasın).
  const file = resolveTranscriptFile(info.cwd, info.sessionId, claudeHome);
  if (!file || !needle) return { found: false, checked: false, file: file || null, reason: 'no-target' };
  const tail = readTail(file);
  if (tail === null) {
    // Aday yolların HİÇBİRİ yoksa oturum hiç yazmamıştır; varsa okuma hatasıdır.
    const missing = !fileExists(file);
    return { found: false, checked: false, file, reason: missing ? 'session-not-started' : 'unreadable' };
  }
  return { found: tail.includes(needle), checked: true, file, reason: 'ok' };
}

// ---------------------------------------------------------------------------
// ADP-306 — "X ajanının son mesajını oku": claude için EN GÜVENİLİR kaynak.
//
// TUI buffer'ı bir RENDER'dır (sarma, spinner, kutu çizgisi, kırpılmış scrollback);
// transcript ise modelin ürettiği METNİN TA KENDİSİ. Pane claude ise önce buradan
// okunur, yoksa çağıran buffer-parse'a düşer (lastReply.ts adaptörleri).
// ---------------------------------------------------------------------------

/**
 * Transcript kuyruğundan SON asistan mesajının düz metnini çıkar (saf).
 *
 * Satır şeması: {type:'assistant', isSidechain?, message:{role, content:[{type,text}]}}.
 * • Yalnız `text` blokları alınır — `thinking`/`tool_use` mesaj DEĞİLDİR.
 * • `isSidechain` (subagent konuşması) ATLANIR: patron ajanın KENDİ cevabını ister.
 * • Kuyruk dosyanın ortasından başlayabilir → bozuk ilk satır sessizce atlanır.
 * @returns {string|null} metin yoksa null (uydurma YOK — çağıran dürüst ret verir).
 */
function parseLastAssistantText(tail) {
  if (typeof tail !== 'string' || !tail) return null;
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || line[0] !== '{') continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // yarım/bozuk satır (tail kesmesi)
    }
    if (!row || row.type !== 'assistant' || row.isSidechain === true) continue;
    const content = row.message && Array.isArray(row.message.content) ? row.message.content : [];
    const text = content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text.trim())
      .filter(Boolean)
      .join('\n\n')
      .trim();
    if (text) return text;
  }
  return null;
}

/**
 * Pane'in claude transcript'indeki SON asistan mesajı.
 * @returns {{ checked: boolean, text: string|null, file: string|null }}
 *   checked=false → transcript yok / pane bilgisi eksik (claude değil, henüz yazmamış…):
 *   çağıran buffer-parse'a düşer. transcriptContains ile aynı "bakılamadı" sözleşmesi.
 */
function lastAssistantMessage(paneInfo, claudeHome) {
  const info = paneInfo || {};
  const file = resolveTranscriptFile(info.cwd, info.sessionId, claudeHome);
  if (!file) return { checked: false, text: null, file: null };
  const tail = readTail(file);
  if (tail === null) return { checked: false, text: null, file };
  return { checked: true, text: parseLastAssistantText(tail), file };
}

// ---------------------------------------------------------------------------
// ADP-705 — OTURUM BAŞLIKLARI: "bu cwd'de hangi oturum dosyaları var, ne zaman
// doğdular, hangisi bir KONUŞMA SIFIRLAMASINDAN (/clear · /new) doğdu?"
//
// NEDEN: pane'in sessionId'si spawn'da `--session-id <uuid>` ile BİZİM verdiğimiz
// id'dir ve pty defterine öyle yazılır. Ama reuse edilen bir pane'e `/clear`
// yazıldığında claude YENİ BİR OTURUM açar (yeni uuid, yeni jsonl) ve bunu bize
// SÖYLEMEZ. Defterdeki id o andan itibaren BAYATTIR; teslim-doğrulaması eski
// dosyayı okur, prompt orada YOKTUR ve `undelivered` YALANI üretilir (2026-07-28
// canlı vakaları — çalışan worker'lar bu yalanla öldürüldü).
//
// Bu fonksiyon yeniden-çapalamanın (paneSessionAnchor.cjs) GÖZÜDÜR: karar saf
// modülde verilir, fs erişimi burada kalır.
// ---------------------------------------------------------------------------

/** Oturum başlığını tanımak için okunan bayt (ilk birkaç satır yeter). */
const HEAD_BYTES = 32 * 1024;

/** `/clear` gibi bir yerel komutun konuşma-sıfırlama satırı. */
const RESET_COMMAND_ROW = /<command-name>\s*(\/[a-z-]+)\s*<\/command-name>/i;

/** Dosyanın ilk HEAD_BYTES baytı (yoksa/okunamazsa null). */
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

/**
 * Bir oturum dosyasının başlığını çözümle (saf — metin girer, künye çıkar).
 * @returns {{ sessionId: string|null, bornAt: number|null, resetCommand: string|null }}
 */
function parseSessionHead(head) {
  const out = { sessionId: null, bornAt: null, resetCommand: null };
  if (typeof head !== 'string' || !head) return out;
  const lines = head.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line[0] !== '{') continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // yarım son satır (head kesmesi) — sessizce atla
    }
    if (!row || typeof row !== 'object') continue;
    if (!out.sessionId && typeof row.sessionId === 'string') out.sessionId = row.sessionId;
    if (out.bornAt === null && typeof row.timestamp === 'string') {
      const ms = Date.parse(row.timestamp);
      if (Number.isFinite(ms)) out.bornAt = ms;
    }
    if (!out.resetCommand) {
      const content = row.message && typeof row.message.content === 'string' ? row.message.content : '';
      const m = content && RESET_COMMAND_ROW.exec(content);
      if (m) out.resetCommand = m[1].toLowerCase();
    }
  }
  return out;
}

/**
 * `cwd`'nin claude proje dizinindeki oturum künyeleri.
 * @param {string} cwd
 * @param {string} [claudeHome]
 * @param {{ sinceMs?: number, limit?: number }} [opts] sinceMs → bu andan ÖNCE
 *   değişmemiş dosyalar hiç okunmaz (yeniden-çapalama yalnız TAZE dosyalarla ilgilenir).
 * @returns {Array<{ sessionId: string, file: string, bornAt: number|null, mtimeMs: number, resetCommand: string|null }>}
 */
function listSessionHeads(cwd, claudeHome, opts) {
  const o = opts || {};
  const sinceMs = typeof o.sinceMs === 'number' ? o.sinceMs : 0;
  const limit = typeof o.limit === 'number' && o.limit > 0 ? o.limit : 40;
  const base = claudeHomeDir(claudeHome);
  // ADP-306/TOK-01 kanonik-yol tuzağı burada da geçerli: TÜM cwd yazımlarının
  // proje dizinleri taranır (realpath + sürücü kasası + UNC + NFC + tavan).
  const dirs = ledgerPath.projectDirCandidates(cwd, path.join(base, 'projects'));
  const rows = [];
  for (const dir of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs < sinceMs) continue;
      rows.push({ file, mtimeMs });
    }
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const heads = [];
  for (const row of rows.slice(0, limit)) {
    const parsed = parseSessionHead(readHead(row.file));
    if (!parsed.sessionId) continue;
    heads.push({ ...parsed, file: row.file, mtimeMs: row.mtimeMs });
  }
  return heads;
}

module.exports = {
  TAIL_BYTES,
  HEAD_BYTES,
  mungeProjectDir,
  claudeHomeDir,
  transcriptPath,
  resolveTranscriptFile,
  resolveTranscript,
  readTail,
  readHead,
  transcriptContains,
  parseLastAssistantText,
  lastAssistantMessage,
  parseSessionHead,
  listSessionHeads,
};
