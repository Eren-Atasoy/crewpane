// AGY-04 — ANTIGRAVITY KOŞU ZARFI: `--output-format stream-json|json` OKUYUCUSU.
//
// İki şeyi üretir ve bunun DIŞINDA hiçbir şey yapmaz (SAF, IO'SUZ leaf →
// `node --test` doğrudan koşar, [[leaf-module-node-test]]):
//   1. JETON — pane jeton rozetinin okuyacağı `usage` satırı (motorun KENDİ sayacı).
//   2. ÖNİZLEME + HÜKÜM — süpervizörün okuyacağı yanıt önizlemesi ve bitiş kararı.
//
// ── 🔴 BU DOSYANIN VAR OLMA SEBEBİ: ÖLÇÜLMÜŞ BİR SAHTE-BAŞARISIZLIK ───────────────
//
// ANTIGRAVITY-R1 §7-R1 (kanıt `ANTIGRAVITY-R1-evidence/03-mcp-identity-run.json`):
//     {"status":"ERROR","response":"(1) KOD=… (2) ARAC=… (3) PONG=…\n",
//      "error":"API error (attempt 1): UNAVAILABLE (code 503): No capacity…",
//      "usage":{…}}                                       ← ve süreç exit kodu 0
// Yani: iş BİTMİŞ, cevap TAM, motor yine de `status:"ERROR"` yazmış (ilk denemedeki
// 503 yeniden denenmiş ve tutmuş). `status`a bakan bir süpervizör BİTMİŞ İŞİ ÇÖPE ATAR.
//
// AGY-02 §5-R3 aynı tuzağın SİMETRİĞİNİ ölçtü (izin merdiveninin dört kolu):
//     {"status":"SUCCESS","response":"", …}                ← ve exit kodu 0
// Yani: iş HİÇ YAPILMAMIŞ (araç oto-reddedilmiş), motor yine de `SUCCESS` yazmış.
// `status`a bakan bir süpervizör YAPILMAMIŞ İŞİ "bitti" sayar.
//
// ⇒ İKİ YÖNDE DE `status` YALAN SÖYLÜYOR. OTORİTE: `response` (dolu mu) + ÇIKIŞ KODU.
//   `status`/`error` yalnız GEREKÇE metnidir — hükmü BELİRLEMEZ, hükmü AÇIKLAR.
//
// ── 🪤 ÖLÇÜLEN ÜÇ SAYIM TUZAĞI (agy 1.2.2, gerçek NDJSON) ────────────────────────
//
// (A) `result.usage` ADIM USAGE'LARININ TOPLAMIDIR — İKİSİ TOPLANMAZ.
//     Ölçüldü (`04-hooks-subagentblock-run.ndjson`): adım 2 → 13.918, adım 5 → 14.285,
//     `result` → 28.203 = 13.918 + 14.285. Adım toplamına `result`ı EKLEMEK maliyeti
//     TAM İKİ KATINA çıkarırdı (codex'in `total_token_usage` kümülatif tuzağının
//     bu motordaki karşılığı). ⇒ `result` geldiğinde o turun sayacı DEĞİŞTİRİLİR.
//
// (B) `thinking_tokens` ⊂ `output_tokens` — AYRI KALEM DEĞİL, ALT KÜME.
//     Üç zarfta da ölçüldü: 13.619+299 = 13.918 (thinking 240) · 14.033+252 = 14.285
//     (thinking 198) · 45.884+974 = 46.858 (thinking 781). `total_tokens` yalnız
//     input+output'tur. Düşünme jetonunu çıktıya EKLEMEK maliyeti şişirirdi.
//
// (C) BİR ADIM BİRDEN ÇOK SATIR BASAR (ACTIVE… → DONE/ERROR) ama `usage` yalnız
//     SON satırdadır. Yine de sayaç `step_index`e göre TEKİLLEŞTİRİLİR: motorun
//     bir gün ara satırda da usage basması sayıyı sessizce katlardı.
//
// ── ÖNİZLEME: ECMA-48 SÜZGECİ GEREKMİYOR (R1 §2.1 satır 10) ─────────────────────
// Önizleme `step_update.text_delta` parçalarının SIRAYLA birleştirilmesidir. Bu
// alan MODELİN metnidir; terminal boyama/imleç dizisi İÇERMEZ — pane buffer'ından
// okunan önizlemenin (`delegationBridge`) aksine `stripAnsi` GEREKMEZ. Yalnız
// `agent_response` adımları alınır: araç adımlarının metni cevap değildir.
//
// ── ÇOK TURLU AKIŞ ──────────────────────────────────────────────────────────────
// `--input-format stream-json` stdin'den satır başına bir tur okur ⇒ AKIŞTA BİRDEN
// ÇOK `result` olabilir. Jeton turlar boyunca TOPLANIR; hüküm ve önizleme SON turun.

'use strict';

/** Önizleme tavanı — rozet/kart tek satır gösterir, defterde de sınırsız metin tutmayız. */
const PREVIEW_MAX_CHARS = 2000;

/** Zarfın jeton alan adları (agy 1.2.2'de ÖLÇÜLDÜ; kayıt `engineRegistry.usage.envelope`). */
const USAGE_FIELDS = Object.freeze({
  input: 'input_tokens',
  output: 'output_tokens',
  thinking: 'thinking_tokens', // ⊂ output (tuzak B) — SAYILMAZ, yalnız beyan edilir
  cacheRead: 'cache_read_tokens',
  total: 'total_tokens',
});

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Ham `usage` bloğu → ürünün jeton şekli (`tokenCost` satırı). Şekil bozuksa null. */
function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const input = num(raw[USAGE_FIELDS.input]);
  const output = num(raw[USAGE_FIELDS.output]);
  const cacheRead = num(raw[USAGE_FIELDS.cacheRead]);
  // Tek bir alanı bile olmayan zarf JETON TAŞIMIYOR demektir — 0'larla "ölçtük"
  // demek uydurmadır (tokenUsage sözleşmesi: ölçemediğimizi göstermeyiz).
  if (!input && !output && !cacheRead) return null;
  return {
    inputTokens: input,
    outputTokens: output, // tuzak B: thinking ZATEN burada
    cacheReadTokens: cacheRead,
    // Ölçülmedi: zarfta önbellek YAZMA alanı YOK. 0 bir ölçüm değil, alanın yokluğudur.
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
  };
}

function addUsage(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWrite5mTokens: a.cacheWrite5mTokens + b.cacheWrite5mTokens,
    cacheWrite1hTokens: a.cacheWrite1hTokens + b.cacheWrite1hTokens,
  };
}

/**
 * KOŞU HÜKMÜ — R1 §7-R1 + AGY-02 §5-R3'ün TEK kuralı.
 *
 * Otorite SIRASI (yukarıdan aşağı, ilk eşleşen kazanır):
 *   1. `result` zarfı HİÇ gelmediyse            → 'unknown'  (akış kesildi / `--print-timeout`)
 *   2. çıkış kodu 0 DEĞİLSE                     → 'failed'   (süreç düştü)
 *   3. `response` DOLUYSA                       → 'done'     ← `status:"ERROR"` OLSA BİLE
 *   4. `response` BOŞSA                         → 'empty'    ← `status:"SUCCESS"` OLSA BİLE
 *
 * `status`/`error` hükmü DEĞİL, `reason`ı besler: kullanıcı "neden" diye sorduğunda
 * motorun kendi cümlesi gösterilir.
 *
 * @param {{result:object|null, exitCode:number|null|undefined}} input
 * @returns {{state:'done'|'failed'|'empty'|'unknown', via:string, status:string|null,
 *            error:string|null, responseChars:number, exitCode:number|null}}
 */
function verdict(input = {}) {
  const result = input.result && typeof input.result === 'object' ? input.result : null;
  const exitCode = typeof input.exitCode === 'number' ? input.exitCode : null;
  const status = result && typeof result.status === 'string' ? result.status : null;
  const error = result && typeof result.error === 'string' && result.error ? result.error : null;
  const response = result && typeof result.response === 'string' ? result.response : '';
  const responseChars = response.trim().length;
  const base = { status, error, responseChars, exitCode };

  if (!result) return { state: 'unknown', via: 'no-result-envelope', ...base };
  if (exitCode !== null && exitCode !== 0) return { state: 'failed', via: 'exit-code', ...base };
  if (responseChars > 0) return { state: 'done', via: 'response+exit', ...base };
  return { state: 'empty', via: 'empty-response', ...base };
}

/**
 * Akış okuyucusu. `push` parça parça beslenir (stdout chunk'ları satır sınırına
 * uymaz), `snapshot` her an okunabilir.
 *
 * @returns {{push:(chunk:string)=>object[], end:()=>object[], snapshot:()=>object}}
 */
function createReader() {
  let carry = '';
  let conversationId = null;
  let model = null;
  let turns = 0;
  /** Bu TURUN adım usage toplamı (tuzak A: `result` gelince bu DEĞİŞTİRİLİR). */
  let turnUsage = null;
  /** Kapanmış turların toplamı. */
  let closedUsage = null;
  const countedSteps = new Set(); // tuzak C
  let preview = '';
  let lastResult = null;
  let malformed = 0;

  function handle(ev) {
    if (!ev || typeof ev !== 'object') return null;

    if (ev.event === 'init' && ev.init && typeof ev.init === 'object') {
      if (typeof ev.conversation_id === 'string') conversationId = ev.conversation_id;
      if (typeof ev.init.model === 'string') model = ev.init.model;
      return ev;
    }

    if (ev.event === 'step_update' && ev.step_update && typeof ev.step_update === 'object') {
      const s = ev.step_update;
      if (typeof s.conversation_id === 'string') conversationId = s.conversation_id;
      if (s.step_type === 'agent_response' && typeof s.text_delta === 'string' && s.text_delta) {
        preview = (preview + s.text_delta).slice(-PREVIEW_MAX_CHARS);
      }
      const u = normalizeUsage(s.usage);
      // tuzak C — aynı adımın ikinci usage satırı sayacı katlamasın.
      const key = `${turns} ${s.step_index}`;
      if (u && !countedSteps.has(key)) {
        countedSteps.add(key);
        turnUsage = addUsage(turnUsage, u);
      }
      return ev;
    }

    if (ev.event === 'result' && ev.result && typeof ev.result === 'object') {
      const r = ev.result;
      if (typeof r.conversation_id === 'string') conversationId = r.conversation_id;
      lastResult = r;
      // tuzak A — `result.usage` ADIMLARIN TOPLAMIDIR: eklenmez, YERİNE geçer.
      // Zarfta usage yoksa adım toplamı elde kalır (ölçülen tek gerçek odur).
      const total = normalizeUsage(r.usage);
      closedUsage = addUsage(closedUsage, total || turnUsage);
      turnUsage = null;
      turns += 1;
      return ev;
    }

    return null;
  }

  function consumeLine(line) {
    const t = line.trim();
    // Boş satır ve JSON olmayan satır (banner/uyarı) akışı DÜŞÜRMEZ — ölçüldü ki
    // agy stdout'u temiz (loglar stderr'de), ama tek bozuk satır jetonu kaybettirmesin.
    if (!t || t[0] !== '{') return null;
    let ev;
    try {
      ev = JSON.parse(t);
    } catch {
      malformed += 1;
      return null;
    }
    return handle(ev);
  }

  return {
    /** Yeni stdout parçası → bu parçada TAMAMLANAN olaylar. */
    push(chunk) {
      const lines = (carry + String(chunk == null ? '' : chunk)).split('\n');
      carry = lines.pop() ?? ''; // son parça YARIM olabilir
      const out = [];
      for (const l of lines) {
        const ev = consumeLine(l);
        if (ev) out.push(ev);
      }
      return out;
    },
    /** Süreç kapandı: elde kalan yarım satırı da dene. */
    end() {
      const rest = carry;
      carry = '';
      const ev = rest ? consumeLine(rest) : null;
      return ev ? [ev] : [];
    },
    /**
     * @param {{exitCode?:number|null}} opts
     * @returns {{conversationId, model, turns, usage, preview, result, verdict, malformedLines}}
     */
    snapshot(opts = {}) {
      // Tur ortasında (henüz `result` yok) adım toplamı GÖSTERİLİR: rozetin canlı
      // dolmasının tek yolu budur ve sayı motorun kendi sayacıdır, tahmin değil.
      const usage = addUsage(closedUsage, turnUsage);
      return {
        conversationId,
        model,
        turns,
        usage: usage ? { ...usage } : null,
        preview,
        result: lastResult,
        verdict: verdict({ result: lastResult, exitCode: opts.exitCode }),
        malformedLines: malformed,
      };
    },
  };
}

/**
 * Tek seferde okunmuş çıktı için kısayol (`--output-format json` de buraya uyar:
 * tek satırlık gövde `result` zarfının KENDİSİDİR, `event` sarmalı olmadan).
 *
 * @param {string} text ham stdout
 * @param {{exitCode?:number|null}} opts
 */
function readAll(text, opts = {}) {
  const r = createReader();
  r.push(text);
  r.end();
  const snap = r.snapshot(opts);
  if (snap.result || snap.usage) return snap;
  // `-o json` kolu: sarmalsız tek nesne. Aynı hükmü aynı kurala uygulayalım ki
  // iki çıktı biçimi iki GERÇEK doğurmasın.
  let bare = null;
  try {
    bare = JSON.parse(String(text || '').trim());
  } catch {
    bare = null;
  }
  if (!bare || typeof bare !== 'object' || typeof bare.response !== 'string') return snap;
  return {
    ...snap,
    conversationId: typeof bare.conversation_id === 'string' ? bare.conversation_id : snap.conversationId,
    turns: 1,
    usage: normalizeUsage(bare.usage),
    result: bare,
    verdict: verdict({ result: bare, exitCode: opts.exitCode }),
  };
}

/**
 * Snapshot → `tokenUsage` adaptörünün beklediği ZARF ("run-envelope").
 * Model bilinmiyorsa satır yine yazılır ('unknown'): jeton ÖLÇÜLDÜ, fiyat ayrı sorudur.
 */
function toUsageEnvelope(snapshot) {
  if (!snapshot || !snapshot.usage) return null;
  return {
    session: [{ model: snapshot.model || 'unknown', speed: null, usage: { ...snapshot.usage } }],
    conversationId: snapshot.conversationId || null,
    turns: snapshot.turns || 0,
  };
}

module.exports = {
  PREVIEW_MAX_CHARS,
  USAGE_FIELDS,
  normalizeUsage,
  verdict,
  createReader,
  readAll,
  toUsageEnvelope,
};
