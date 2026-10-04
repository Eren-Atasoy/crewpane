// ADP-368 — MOBİL OKUMA MODU: yapılandırılmış transcript sayfası (main-side).
//
// ADP-401 — bu modül artık MASAÜSTÜNÜN de okuma-modu çekirdeği: ofis konuşma
// kutusu (PromptBox → AgentReplyFlow) aynı sayfayı `pty:transcriptPage` IPC'siyle
// çeker (main.js wireIpc). İki yüzey TEK ayrıştırıcıyı paylaşır — şema/kırpma
// değişikliği yaparken hem mobil (gateway /m/panes/:id/transcript) hem masaüstü
// tüketicisini birlikte düşün.
//
// NEDEN: pty/VT hattı bir RENDER'dır (ADP-324'te ölçüldü: claude alternatif ekranda
// koşar, scrollback yok, ara kareler kayıp) — telefonda "okunabilir akış" terminal
// baytlarından KURTARILAMAZ. Kayıpsız kaynak claude'un kendi oturum defteri:
//   ~/.claude/projects/<munged-cwd>/<sessionId>.jsonl   (satır başına bir JSON)
// Pane → {cwd, sessionId} çözümü main'in pty defterinden gelir (transcriptProbe ile
// aynı yol sözleşmesi: munge + /var→/private/var kanonik-yol adayları).
//
// TASARIM SINIRLARI:
//   • Dosya BÜYÜK olabilir (40+ MB görüldü) → HER ZAMAN kuyruktan okunur; `before`
//     imleci BAYT OFSETİDİR, sayfalama geriye doğru pencere büyüterek ilerler.
//     Satır sınırları '\n' (tek bayt, ASCII) → pencere kesiği çok-baytlı UTF-8
//     karakteri BÖLEMEZ: yarım ilk satır zaten atılır, kalan satırlar bütündür
//     (Türkçe karakterler uçtan uca bozulmaz — ADP-366'nın VT bozulma sınıfı
//     burada yapısal olarak imkânsız).
//   • Ayrıştırma SAF (parseTranscriptWindow) → node --test ile fixture'dan sürülür.
//   • Bozuk/yarım satır sessizce atlanır (kuyruk kesiği, uçuştaki yazım) — asla fırlatmaz.
//
// SATIR ŞEMASI (gerçek dosyadan ÖLÇÜLDÜ, 2026-07-14 · claude 2.1.20x):
//   {type:'user',      isSidechain?, isMeta?, uuid, timestamp,
//    message:{content: string | [{type:'text'|'tool_result'|'image', ...}]}}
//   {type:'assistant', isSidechain?, uuid, timestamp,
//    message:{content: [{type:'text'|'thinking'|'tool_use', ...}]}}
//   Diğer type'lar (mode, attachment, system, queue-operation…) sohbet DEĞİLDİR → atlanır.
//   tool_result, tool_use'un SONRAKİ user satırında `tool_use_id` ile gelir → burada
//   eşleştirilir (telefon korelasyon yapmaz; çip + kısaltılmış sonuç tek parça gider).
//
// CDX-READ-02 — İKİNCİ SATIR AİLESİ: codex rollout defteri (gerçek dosyadan ÖLÇÜLDÜ,
// 2026-08-29 · codex-cli 0.147 · ~/.codex/sessions/**/rollout-*.jsonl):
//   {timestamp, type:'session_meta',  payload:{id, timestamp, cwd, originator}}
//   {timestamp, type:'response_item', payload:{type:'message', role:'user'|'assistant'|'developer',
//      content:[{type:'input_text'|'output_text', text}]}}
//   {timestamp, type:'response_item', payload:{type:'function_call'|'custom_tool_call',
//      name, arguments|input, call_id}}
//   {timestamp, type:'response_item', payload:{type:'function_call_output'|'custom_tool_call_output',
//      call_id, output: string | [{type:'input_text', text}]}}
//   {timestamp, type:'event_msg',     payload:{type:'task_complete', error?:{message}}}
//   reasoning ŞİFRELİ (encrypted_content) → akışa girmez; world_state/turn_context kurulum → atlanır.
// Ayrıştırıcı satırı MOTOR ADINA değil ŞEKLİNE göre tanır (row.type + payload.type):
// iki aile aynı pencerede karışsa bile her satır kendi yolundan çıkar; tanınmayan
// şekil sessizce atlanır (bilinmeyen motorun makul varsayılanı = ham VT görünümü).

'use strict';

const fs = require('node:fs');

const probe = require('../services/transcriptProbe.cjs');
// CDX-READ-02 — pane→rollout eşlemesi ZATEN çözülmüş (ENG-02: cwd+açılış-zamanı,
// güven düşükse null). Kopyalamak yerine ortak kullanılır — tek gerçek tek yer.
const codexProbe = require('../mcp/codexRolloutProbe.cjs');

// Bir sayfalık mesajı bulmak için geriye doğru büyüyen okuma penceresi.
const CHUNK_BYTES = 256 * 1024;
const MAX_SCAN_BYTES = 2 * 1024 * 1024; // tek istekte en fazla bu kadar taranır
const LIMIT_DEFAULT = 30;
const LIMIT_MAX = 120;
// Mobil gövde tavanları: metin ekranda "devamını gör" ile açılır ama tek mesaj
// megabaytlarca markdown taşımasın; araç özeti/sonucu çip içinde kısadır.
//
// ⚠️ ADP-738 — BU TAVAN ARTIK VARSAYILAN DEĞİL. Eskiden her okuyucu (masaüstü
// okunabilir mod dahil) 6000 karakterde SESSİZCE kesiliyordu: 6508 karakterlik bir
// lider mesajının 6000. karakteri tam olarak bir madde işaretinden sonraya düştü →
// ekranda boş bir madde + kayıp kuyruk (3. madde ve tüm "KARAR GEREKENLER" bölümü).
// Kural: okunabilir mod veri DÜŞÜRMEZ. Tavan artık yalnız AĞ yüzeyinin (mobil HTTP)
// açıkça istediği bir seçenek; süreç-içi masaüstü IPC'si sınırsız okur.
const MAX_TEXT = 6000;
const MAX_SUMMARY = 160;
const MAX_RESULT = 500;

/** Tek satıra indir + kırp (çip özeti). */
function oneLine(s, max) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Araç çağrısının tek satırlık insan-okur özeti ("Bash · git status" çipinin gövdesi). */
function toolSummary(input) {
  if (!input || typeof input !== 'object') return '';
  const cand =
    input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query ??
    input.url ?? input.description ?? input.prompt ?? input.skill;
  if (typeof cand === 'string' && cand.trim()) return oneLine(cand, MAX_SUMMARY);
  try {
    return oneLine(JSON.stringify(input), MAX_SUMMARY);
  } catch {
    return '';
  }
}

/** tool_result gövdesinden düz metin çıkar (string | [{type:'text'|'image'}]). */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      if (!b || typeof b !== 'object') return '';
      // claude: 'text' · codex rollout: 'input_text'/'output_text' — aynı düz metin.
      if ((b.type === 'text' || b.type === 'input_text' || b.type === 'output_text') && typeof b.text === 'string') return b.text;
      if (b.type === 'image') return '[görsel]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

// Ajanın kendisine enjekte edilen yerel-komut/hatırlatma sargıları sohbet değildir.
const NOISE_USER = /^\s*<(?:command-name|command-message|local-command-stdout|system-reminder)/;

// CDX-READ-02 — codex'in KENDİ kurulum sargıları (AGENTS.md / user_instructions /
// environment_context / skills_instructions) kullanıcının yazdığı şey değildir;
// desenler gerçek rollout dosyasından ölçüldü (role:user satırlarında geliyorlar).
// (<recommended_plugins> canlı kanıt koşusunda sızdı ve listeye eklendi — fresh-session-proof)
const CODEX_NOISE_USER = /^\s*(?:#\s*AGENTS\.md instructions\b|<user_instructions>|<environment_context>|<skills_instructions>|<recommended_plugins>|<turn_context)/;

/**
 * CDX-READ-02 — codex araç satırının tek satırlık özeti: `custom_tool_call.input`
 * ham betik metnidir (doğrudan kısalt); `function_call.arguments` JSON'dur —
 * çözülürse claude özetiyle AYNI yoldan (toolSummary) geçer, çözülmezse ham hali.
 */
function codexToolSummary(p) {
  if (typeof p.input === 'string' && p.input.trim()) return oneLine(p.input, MAX_SUMMARY);
  if (typeof p.arguments === 'string' && p.arguments.trim()) {
    try {
      return toolSummary(JSON.parse(p.arguments)) || oneLine(p.arguments, MAX_SUMMARY);
    } catch {
      return oneLine(p.arguments, MAX_SUMMARY);
    }
  }
  return '';
}

/**
 * ADP-738 — DÜRÜST KIRPMA. Kırpmak zorunda kalırsak (yalnız ağ yüzeyi) kesme noktası
 * markdown'ı BOZMAYACAK bir sınıra çekilir: satır sonuna inilir, geriye yalnız bir
 * liste/başlık İŞARETİ kaldıysa (içeriksiz "- ") o satır da atılır ve açık kalan kod
 * çiti kapatılır. Yoksa ayrıştırıcı boş bir madde çizip kalanı düşürür — Eren'in
 * gördüğü hatanın görünen yüzü buydu. `truncated` bayrağı ÇAĞIRANA döner: her yüzey
 * "kısaltıldı" notunu göstermek ZORUNDA (sessiz kayıp yasak).
 *
 * @param {string} t  kırpılacak metin
 * @param {number} max  karakter tavanı; sonlu ve >0 değilse KIRPMA YOK
 */
function clampText(t, max) {
  if (!Number.isFinite(max) || max <= 0 || t.length <= max) return { text: t, truncated: false };
  let cut = t.slice(0, max);
  // Satır sınırına çek — ama tek dev satırda her şeyi silme (yarıdan fazlası gitmesin).
  const nl = cut.lastIndexOf('\n');
  if (nl > max / 2) cut = cut.slice(0, nl);
  // İçeriksiz liste/başlık/alıntı işaretiyle biten satırı at (boş madde üretir).
  cut = cut.replace(/\n[ \t]*(?:[-*+]|\d+[.)]|#{1,6}|>)[ \t]*$/, '');
  cut = cut.replace(/\s+$/, '');
  // Açık kalan fenced kod bloğu kapatılır: yoksa kırpma notu kodun İÇİNDE kalır.
  if ((cut.match(/^\s{0,3}```/gm) || []).length % 2 === 1) cut += '\n```';
  return { text: cut, truncated: true };
}

function pushText(items, row, off, role, text, maxText, blockIndex = 0) {
  const t = String(text ?? '').trim();
  if (!t) return;
  const clamped = clampText(t, maxText);
  items.push({
    id: `${row.uuid || `off-${off}`}:${blockIndex}`,
    off,
    role,
    kind: 'text',
    text: clamped.text,
    textTruncated: clamped.truncated,
    at: row.timestamp ? Date.parse(row.timestamp) || null : null,
  });
}

/**
 * Bir bayt penceresini ({buf, baseOff}) sohbet öğelerine çevir. SAF — fs yok.
 * `skipFirstPartial` true ise ilk '\n'e kadarki yarım satır atılır (pencere dosya
 * ortasından başladı). Dönen items DOSYA SIRASINDADIR (eskiden yeniye).
 *
 * ADP-738 — `opts.maxText` VERİLMEZSE metin KIRPILMAZ (kayıpsız varsayılan). Kırpma
 * isteyen yüzey (mobil HTTP) tavanı açıkça geçer; bkz. `clampText`.
 */
function parseTranscriptWindow(buf, baseOff, skipFirstPartial, opts) {
  const maxText = opts && Number.isFinite(opts.maxText) ? opts.maxText : 0;
  const items = [];
  const toolById = new Map(); // tool_use id → item (sonuç sonraki satırlarda gelir)
  let pos = 0;
  if (skipFirstPartial) {
    const nl = buf.indexOf(0x0a);
    if (nl < 0) return { items };
    pos = nl + 1;
  }
  while (pos < buf.length) {
    let nl = buf.indexOf(0x0a, pos);
    if (nl < 0) nl = buf.length; // dosya sonu: kuyrukta \n'siz (muhtemelen tam) satır
    const off = baseOff + pos;
    const line = buf.toString('utf8', pos, nl).trim();
    pos = nl + 1;
    if (!line || line[0] !== '{') continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // yarım/bozuk satır (uçuştaki yazım ya da kuyruk kesiği)
    }
    if (!row || row.isSidechain === true) continue; // subagent konuşması patronun akışı değil

    if (row.type === 'assistant') {
      const content = row.message && Array.isArray(row.message.content) ? row.message.content : [];
      for (const [blockIndex, b] of content.entries()) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text') pushText(items, row, off, 'assistant', b.text, maxText, blockIndex);
        else if (b.type === 'tool_use') {
          const item = {
            id: `${row.uuid || `off-${off}`}:${blockIndex}`,
            off,
            role: 'assistant',
            kind: 'tool',
            tool: {
              name: typeof b.name === 'string' ? b.name : '?',
              summary: toolSummary(b.input),
              resultPreview: null, // sonuç henüz düşmediyse null kalır → "koşuyor"
              resultTruncated: false,
              ok: null,
            },
            at: row.timestamp ? Date.parse(row.timestamp) || null : null,
          };
          items.push(item);
          if (typeof b.id === 'string') toolById.set(b.id, item);
        }
        // 'thinking' mesaj değildir (ADP-280 ile aynı kural) → akışa girmez.
      }
      continue;
    }

    if (row.type === 'user' && row.isMeta !== true) {
      const content = row.message ? row.message.content : null;
      if (typeof content === 'string') {
        if (!NOISE_USER.test(content)) pushText(items, row, off, 'user', content, maxText);
        continue;
      }
      if (!Array.isArray(content)) continue;
      const texts = [];
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'tool_result') {
          const target = typeof b.tool_use_id === 'string' ? toolById.get(b.tool_use_id) : null;
          if (target) {
            const full = resultText(b.content).trim();
            target.tool.resultPreview = full ? (full.length > MAX_RESULT ? full.slice(0, MAX_RESULT) : full) : '';
            target.tool.resultTruncated = full.length > MAX_RESULT;
            target.tool.ok = b.is_error === true ? false : true;
          }
          // hedefi pencerede olmayan (daha eski sayfadaki) sonuç sessizce düşer —
          // o araç çipi kendi sayfası çekildiğinde sonuçsuz görünür, uydurma yok.
        } else if (b.type === 'text' && typeof b.text === 'string' && !NOISE_USER.test(b.text)) {
          texts.push(b.text);
        }
      }
      if (texts.length) pushText(items, row, off, 'user', texts.join('\n\n'), maxText);
      continue;
    }

    // ── CDX-READ-02 — codex rollout ailesi (satır ŞEKLİNDEN tanınır) ──────────
    if (row.type === 'response_item' && row.payload && typeof row.payload === 'object') {
      const p = row.payload;
      const meta = { uuid: typeof p.id === 'string' ? p.id : null, timestamp: row.timestamp };
      if (p.type === 'message') {
        // developer/system = motorun kurulum enjeksiyonu (skills/collaboration-mode) — sohbet değil.
        if (p.role !== 'user' && p.role !== 'assistant') continue;
        // OFV14: reasoning and directed messages are not public conversation.
        // A missing channel is the legacy public-message format. Unknown explicit
        // channels fail closed; tool calls retain their separate technical chips.
        if (p.role === 'assistant' && (
          (p.channel != null && !['final', 'commentary'].includes(p.channel)) ||
          (p.recipient != null && p.recipient !== 'all')
        )) continue;
        const text = resultText(p.content);
        if (!text.trim()) continue; // boş final_answer iskeleti (ölçüldü) — akışa girmez
        if (p.role === 'user' && CODEX_NOISE_USER.test(text)) continue;
        pushText(items, meta, off, p.role, text, maxText);
      } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        const item = {
          id: `${meta.uuid || `off-${off}`}:0`,
          off,
          role: 'assistant',
          kind: 'tool',
          tool: {
            name: typeof p.name === 'string' ? p.name : '?',
            summary: codexToolSummary(p),
            resultPreview: null, // çıktı satırı henüz düşmediyse null kalır → "koşuyor"
            resultTruncated: false,
            ok: null,
          },
          at: row.timestamp ? Date.parse(row.timestamp) || null : null,
        };
        items.push(item);
        if (typeof p.call_id === 'string') toolById.set(p.call_id, item);
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        const target = typeof p.call_id === 'string' ? toolById.get(p.call_id) : null;
        if (target) {
          const full = resultText(p.output).trim();
          target.tool.resultPreview = full ? (full.length > MAX_RESULT ? full.slice(0, MAX_RESULT) : full) : '';
          target.tool.resultTruncated = full.length > MAX_RESULT;
          // Rollout çıkış satırı hata bayrağı TAŞIMAZ (ölçüldü) → "bitti" bilinir, hüküm yok.
          target.tool.ok = true;
        }
      }
      // reasoning (şifreli) ve diğer payload tipleri sohbet değildir → atlanır.
      continue;
    }

    // Turu KESEN hata (limit mesajı gibi) kullanıcıya görünmeli (BUG-R3 #3/#4 kesişimi):
    // yoksa "cevap gelmedi" ekranda hiçbir iz bırakmaz.
    if (row.type === 'event_msg' && row.payload && row.payload.type === 'task_complete') {
      const err = row.payload.error;
      if (err && typeof err.message === 'string' && err.message.trim()) {
        pushText(items, { uuid: null, timestamp: row.timestamp }, off, 'assistant', `⚠ ${err.message}`, maxText);
      }
    }
  }
  return { items };
}

/**
 * Pane'in transcript'inden BİR SAYFA sohbet öğesi (kuyruktan; `before` bayt imleci
 * ile geriye). Dosya yok / pane bilgisi eksik (codex, shell…) → supported:false —
 * çağıran ham VT görünümüne düşer, hüküm verilmez.
 *
 * ADP-738 — `opts.maxText` verilmezse mesaj metni KIRPILMAZ. Ağ yüzeyi (mobil) tavanı
 * kendisi geçer; süreç-içi masaüstü IPC'si geçmez (okunabilir mod veri düşürmez).
 *
 * @returns {{ supported:boolean, items:Array, firstOff:number, hasMore:boolean, file:string|null }}
 */
function readTranscriptPage(opts) {
  const o = opts || {};
  const limit = Number.isFinite(o.limit) ? Math.min(LIMIT_MAX, Math.max(1, Math.trunc(o.limit))) : LIMIT_DEFAULT;
  const maxText = Number.isFinite(o.maxText) ? Math.max(0, Math.trunc(o.maxText)) : 0;
  const none = (file) => ({ supported: false, items: [], firstOff: 0, hasMore: false, file: file || null });
  const exists = (f) => {
    try {
      return !!f && fs.existsSync(f);
    } catch {
      return false;
    }
  };
  // CDX-READ-02 — DEFTER ÇÖZÜMÜ MOTOR-BAĞIMSIZ. Önce claude oturum dosyası (sessionId
  // KESİN kimliktir); pane'in oturum kimliği YOKSA diskteki diğer defter ailelerine
  // bakılır — bugün codex rollout'u (cwd+açılış-zamanı eşlemesi codexRolloutProbe'da;
  // güven düşükse null → ham VT görünümü kalır, tahmin yok). Shell pane'i defter
  // TARAMAZ: delegasyon dalgası pane'leri AYNI saniyede açar — aynı cwd'de o an doğan
  // bir codex oturumunun defteri yanlışlıkla shell'e iliştirilmesin (ölçülen risk).
  // Bilinmeyen motor (goose/opencode…): hiçbir aday tutmaz → supported:false (varsayılan).
  let file = probe.resolveTranscriptFile(o.cwd, o.sessionId, o.claudeHome);
  if (!exists(file) && !o.sessionId && o.engine !== 'shell') {
    const m = codexProbe.matchPaneRollout({ cwd: o.cwd, startedAt: o.startedAt }, { codexHome: o.codexHome });
    if (m.file) file = m.file;
  }
  if (!file) return none(null);
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return none(file); // transcript HENÜZ yok (taze pane) — "bakılamadı", hata değil
  }
  const end = Number.isFinite(o.before) ? Math.max(0, Math.min(Math.trunc(o.before), size)) : size;

  // Geriye doğru büyüyen pencere: bir sayfayı dolduracak kadar mesaj bulunana ya da
  // tarama tavanına/dosya başına dayanana dek genişlet. Her turda pencere BAŞTAN
  // ayrıştırılır (tool_use↔tool_result eşleşmesi pencere-içi ileri yönlü kurulur).
  let span = Math.min(CHUNK_BYTES, Math.max(1, end));
  let parsed = { items: [] };
  let start = end;
  while (end > 0) {
    start = Math.max(0, end - span);
    let fd;
    let buf;
    try {
      fd = fs.openSync(file, 'r');
      buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, buf.length, start);
    } catch {
      return none(file);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    parsed = parseTranscriptWindow(buf, start, start > 0, { maxText });
    if (parsed.items.length > limit || start === 0 || span >= MAX_SCAN_BYTES) break;
    span = Math.min(MAX_SCAN_BYTES, span * 2);
  }

  const items = parsed.items.slice(-limit);
  const firstOff = items.length ? items[0].off : start;
  return {
    supported: true,
    items,
    firstOff,
    // Sayfanın en eskisinden önce dosyada bayt varsa daha eski sayfa vardır. (O baytlar
    // sohbet-dışı satırlar da olabilir → bir sonraki sayfa boş dönebilir; yanlış "yok" demez.)
    hasMore: firstOff > 0,
    file,
  };
}

module.exports = {
  CHUNK_BYTES,
  MAX_SCAN_BYTES,
  LIMIT_DEFAULT,
  LIMIT_MAX,
  MAX_TEXT,
  MAX_RESULT,
  toolSummary,
  resultText,
  clampText,
  parseTranscriptWindow,
  readTranscriptPage,
};
