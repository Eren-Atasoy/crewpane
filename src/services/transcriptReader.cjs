// CrewPane — SEARCH-2 (bumblebee) AJAN OTURUMU (TRANSCRIPT) OKUYUCUSU.
//
// NE OKUR: ajanların AI CLI oturum defterleri —
//   claude → ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl   (satır başına JSON)
//   codex  → ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
//
// ═══════════════════════════════════════════════════════════════════════════════
// BU MODÜLÜN ASIL İŞİ ARAMA DEĞİL, GİZLİLİKTİR
// ═══════════════════════════════════════════════════════════════════════════════
// Bu defterler ürünün EN HASSAS verisidir: SEARCH-R1 bu makinede 2.314 dosya /
// 4,30 GB ölçtü ve bunun yalnız %0,5'i (19,5 MB) kullanıcı-ajan METNİdir. Geri
// kalan %99,5 araç çıktısı, dosya içerikleri, ortam dökümleri, sistem hatırlatmaları.
// O %99,5'i indekslemek "daha iyi arama" değil, kullanıcının diskini aranabilir bir
// sızıntı yüzeyine çevirmektir. Bu yüzden kural DIŞLAYICI değil KAPSAYICIdır:
//
//   ✅ YALNIZ ŞU indekslenir: `user` / `assistant` rolündeki DÜZ METİN blokları.
//   ⛔ Her şey ATLANIR: tool_use/tool_result, attachment, image, thinking, isMeta,
//      <system-reminder>…</system-reminder>, <local-command…>, <command-name…>,
//      <environment_context>, kuyruk (queue-operation) satırları, session_meta gövdesi.
//
// Sonra kalan metin ürünün KENDİ maskesinden geçer (`memorySecretMask.maskSecrets`,
// ADP-862): prototipte 38 parça maskelendi — yani bu kapı teorik değil, ölçülmüş.
//
// 🔴 HAM JSONL HİÇBİR YERE KOPYALANMAZ. Bu modül dosyayı AKIŞLA okur (4,3 GB belleğe
// alınamaz), metni çıkarır, maskeler ve parçaları döndürür. Çağıran taraf yalnız
// maskelenmiş parçaları saklar.
//
// Saf tarafı (satır → tur) `parseLine` ile dışa açıktır ve dosyasız test edilir;
// diskle konuşan tek yer `readTranscript`/`listTranscriptFiles`.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const { maskSecrets } = require('../memory/memorySecretMask.cjs');

/** Parça boyu — SEARCH-R1 prototipiyle AYNI (ölçüm oradan geliyor). */
const MAX_CHUNK = 900;
/** Başlık yoksa ilk kullanıcı cümlesinden bu kadar karakter alınır. */
const TITLE_LEN = 100;

/**
 * Metnin KENDİSİ araç/sistem gürültüsü mü? Bir `user` satırı da bunlardan biri
 * olabilir: Claude Code kabuk komutlarının çıktısını ve hatırlatmaları kullanıcı
 * rolüyle geri besler. Rol tek başına yetmiyor — ölçüldü.
 */
const JUNK_PREFIX = /^\s*(<local-command|<command-name|<command-message|<local-command-stdout|<command-args|<environment_context|<user-prompt-submit-hook)/;

/** Etiketli blokları GÖVDEDEN söker (satırın tamamı değilse bile içinde durabilir). */
function stripEnvelopes(s) {
  return String(s)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<hafıza[^>]*>[\s\S]*?<\/hafıza>/g, ' ')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, ' ')
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, ' ');
}

function emptyStats() {
  return { lines: 0, skippedLines: 0, skippedBlocks: 0, bytes: 0, textBytes: 0, masked: 0 };
}

/**
 * BİR SATIR → sıfır ya da daha çok tur. SAF (disk yok) — testin asıl hedefi burası.
 *
 * @param {string} line ham jsonl satırı
 * @param {'claude'|'codex'} engine
 * @param {object} stats sayaç (mutasyona uğrar)
 * @returns {{turns: Array<{role:string,text:string}>, meta: object}}
 */
function parseLine(line, engine, stats = emptyStats()) {
  const empty = { turns: [], meta: {} };
  let d;
  try {
    d = JSON.parse(line);
  } catch {
    return empty; // bozuk satır: oturumun tamamını çöpe atmaz
  }
  return engine === 'codex' ? parseCodexLine(d, stats) : parseClaudeLine(d, stats);
}

function parseClaudeLine(d, stats) {
  const meta = {};
  if (d && d.type === 'ai-title' && d.aiTitle) return { turns: [], meta: { title: String(d.aiTitle).slice(0, 120) } };
  if (!d || (d.type !== 'user' && d.type !== 'assistant')) {
    stats.skippedLines++;
    return { turns: [], meta };
  }
  // `isMeta`: ürünün kendi enjeksiyonu (kimlik/brifing) — kullanıcı yazmadı.
  if (d.isMeta) {
    stats.skippedLines++;
    return { turns: [], meta };
  }
  if (d.cwd) meta.cwd = d.cwd;
  if (d.gitBranch) meta.branch = d.gitBranch;
  if (d.sessionId) meta.session = d.sessionId;
  if (d.timestamp) meta.ts = d.timestamp;

  const content = d.message && d.message.content;
  const raw = [];
  if (typeof content === 'string') raw.push(content);
  else if (Array.isArray(content)) {
    for (const b of content) {
      // `text` DIŞINDAKİ her blok tipi atlanır: tool_use, tool_result, image,
      // thinking, document… (beyaz liste — yeni bir blok tipi doğduğunda
      // kendiliğinden DIŞARIDA kalır, bu kasıtlıdır).
      if (b && b.type === 'text' && typeof b.text === 'string') raw.push(b.text);
      else stats.skippedBlocks++;
    }
  }
  return { turns: cleanTurns(raw, d.type, stats), meta };
}

function parseCodexLine(d, stats) {
  const meta = {};
  const p = (d && d.payload) || {};
  if (d && d.type === 'session_meta') {
    if (p.cwd) meta.cwd = p.cwd;
    if (p.id) meta.session = p.id;
    if (p.timestamp || d.timestamp) meta.ts = p.timestamp || d.timestamp;
    // ⚠ `base_instructions` (sistem promptu) BİLEREK okunmuyor: tur değil, gövde değil.
    return { turns: [], meta };
  }
  if (!d || d.type !== 'response_item' || p.type !== 'message' || (p.role !== 'user' && p.role !== 'assistant')) {
    stats.skippedLines++;
    return { turns: [], meta };
  }
  const raw = [];
  for (const b of p.content || []) {
    const t = b && (b.text || b.input_text || b.output_text);
    if (typeof t === 'string') raw.push(t);
    else stats.skippedBlocks++;
  }
  return { turns: cleanTurns(raw, p.role, stats), meta };
}

/** Ham metin blokları → temiz turlar (zarf sökme + gürültü kapısı). */
function cleanTurns(raw, role, stats) {
  const turns = [];
  for (const t0 of raw) {
    if (JUNK_PREFIX.test(t0)) {
      stats.skippedBlocks++;
      continue;
    }
    const t = stripEnvelopes(t0).replace(/\s+\n/g, '\n').trim();
    if (!t) continue;
    turns.push({ role: role === 'assistant' ? 'assistant' : 'user', text: t });
  }
  return turns;
}

/**
 * Turlar → İNDEKSLENECEK PARÇALAR. Maskeleme BURADA, tek noktada olur: hiçbir
 * çağıran "maskelemeyi unutamaz" (unutulabilen bir gizlilik kuralı, kural değildir).
 */
function chunkTurns(turns, stats = emptyStats()) {
  const chunks = [];
  let line = 0;
  for (const t of turns) {
    const masked = maskSecrets(t.text);
    if (masked !== t.text) stats.masked++;
    const prefix = t.role === 'user' ? '[kullanıcı] ' : '[ajan] ';
    for (let j = 0; j < masked.length; j += MAX_CHUNK) {
      line++;
      chunks.push({ line, text: prefix + masked.slice(j, j + MAX_CHUNK) });
    }
    stats.textBytes += masked.length;
  }
  return chunks;
}

/** Oturum başlığı: `ai-title` varsa o, yoksa ilk KULLANICI cümlesi. */
function titleOf(turns, aiTitle) {
  if (aiTitle) return String(aiTitle).slice(0, 120);
  const first = turns.find((t) => t.role === 'user') || turns[0];
  if (!first) return '';
  return first.text.replace(/\s+/g, ' ').trim().slice(0, TITLE_LEN);
}

/**
 * BİR DOSYA → belge (akışla okunur; ham jsonl kopyalanmaz).
 * Boş oturum (`turns` yok) `null` döner — 199 boş oturum ölçüldü, indekse girmemeli.
 */
async function readTranscript(file, engine, { stats = emptyStats(), home = os.homedir() } = {}) {
  const turns = [];
  const meta = {};
  let aiTitle = null;
  let bytes = 0;

  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const raw of rl) {
    bytes += raw.length + 1;
    stats.lines++;
    const r = parseLine(raw, engine, stats);
    if (r.meta.title) aiTitle = r.meta.title;
    for (const k of ['cwd', 'branch', 'session', 'ts']) if (!meta[k] && r.meta[k]) meta[k] = r.meta[k];
    for (const t of r.turns) turns.push(t);
  }
  stats.bytes += bytes;
  if (!turns.length) return null;

  const chunks = chunkTurns(turns, stats);
  const st = fs.statSync(file);
  return {
    type: 'session',
    key: file,
    title: titleOf(turns, aiTitle),
    path: tildify(file, home),
    meta: {
      engine,
      cwd: tildify(meta.cwd || '', home),
      branch: meta.branch || '',
      session: meta.session || '',
      ts: meta.ts || '',
      turns: turns.length,
    },
    mtime: st.mtimeMs,
    size: st.size,
    chunks,
  };
}

function tildify(p, home = os.homedir()) {
  if (!p) return '';
  return home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

/**
 * Defterlerin LİSTESİ (içerik OKUNMAZ) — artımlı planın girdisi.
 *
 * 🔴 mtime SÜZGECİ BU YÜZDEN ŞART: prototipte artımlı koşu bile 4,3 GB'ı yeniden
 * OKUDU (~16 s), çünkü "değişti mi" sorusu ancak içerik okununca cevaplanıyordu.
 * Burada cevap `stat`tan gelir: dosya boyutu+mtime aynıysa dosya AÇILMAZ.
 */
function listTranscriptFiles({ home = os.homedir(), fsImpl = fs } = {}) {
  const out = [];
  const push = (engine, file) => {
    let st;
    try {
      st = fsImpl.statSync(file);
    } catch {
      return;
    }
    if (!st.isFile()) return;
    out.push({ engine, file, mtimeMs: st.mtimeMs, size: st.size });
  };
  const walk = (dir, pred, depth = 0) => {
    if (depth > 6) return;
    let ents = [];
    try {
      ents = fsImpl.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, pred, depth + 1);
      else if (pred(p)) push(dir.includes('.codex') ? 'codex' : 'claude', p);
    }
  };
  walk(path.join(home, '.claude', 'projects'), (p) => p.endsWith('.jsonl'));
  walk(path.join(home, '.codex', 'sessions'), (p) => /rollout-.*\.jsonl$/.test(p));
  return out;
}

module.exports = {
  MAX_CHUNK,
  JUNK_PREFIX,
  emptyStats,
  parseLine,
  cleanTurns,
  chunkTurns,
  titleOf,
  stripEnvelopes,
  readTranscript,
  listTranscriptFiles,
  tildify,
};
