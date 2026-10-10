// CrewPane — ADP-862 (st1) HAFIZA GERİ-ÇAĞIRMA UCU + BAĞLAM SEÇİCİ.
//
// İKİ İŞ, TEK MODÜL — çünkü ikisi de AYNI soruyu soruyor: "bu konuda ne biliyoruz?"
//
//   1) UÇ (`recall`)          — hibrit aramayı (ADP-871) çağırır, sonucu KAYNAK +
//                               ALINTI ile döndürür, sırları maskeler, bulamayınca
//                               UYDURMAZ. Hafıza sekmesi, raporlar ve (ADP-862'nin
//                               sonraki adımında) sesli katman AYNI ucu çağırır.
//   2) BAĞLAM SEÇİCİ (`focusedMemoryBlock`) — ajan oturumu başlarken 285 satırlık
//                               takım indeksinin TAMAMI yerine göreve/role İLGİLİ
//                               satırları seçer.
//
// ── NEDEN BAĞLAM SEÇİMİ BİR ÖZELLİK, "OPTİMİZASYON" DEĞİL ────────────────────
// Bugünkü kural (ADP-237) ajana "şu üç MEMORY.md'yi OKU" diyor. Ölçüldü: paylaşılan
// indeks TEK BAŞINA 146 385 bayt (285 satır). Okuma aracı bunu 25 000 jetonda kesiyor
// — yani ajan hem çok jeton yakıyor HEM de indeksin kuyruğunu hiç görmüyor. Seçici
// bunu tersine çevirir: az ama İLGİLİ satır + tam dosyanın YOLU + arama komutu.
//
// ⚠ SEÇİM KAYIPLIDIR — ve bu KABUL EDİLMİŞ bir karardır, gizlenmez:
//   • seçkinin başında kaç satırdan kaçının seçildiği YAZAR,
//   • tam indeks yolları HER ZAMAN verilir (ajan derinleşebilir),
//   • seçki bütçeye sığıyorsa indeks OLDUĞU GİBİ geçer (küçük hafızada davranış
//     bugünküyle BİREBİR aynı — yeni bir kayıp sınıfı doğurmaz).
//
// Saf-ish: node builtin + repo modülleri (electron bağı YOK) → `node --test` koşar.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const agentMemory = require('./agentMemory.cjs');
const { analyze } = require('./memoryLexical.cjs');
const { excerptFor } = require('./memoryHybrid.cjs');
const { maskSecrets, maskDeep } = require('./memorySecretMask.cjs');

/** Sonuç yoksa söylenecek TEK cümle (memoryHybrid.NOT_FOUND ile AYNI metin). */
const NOT_FOUND = 'Hafızada bunu bulamadım.';

// ── "BULAMADIM" ≠ "ÖLÇEMEDİM" ────────────────────────────────────────────────
// Ürünün kendi kuralı (engineInstall.cjs:175): bu ikisi AYRI şeylerdir ve ayrı
// gösterilir. Uç ilk sürümde ikisini de NOT_FOUND'a çeviriyordu; ölçüldü:
// indeks HİÇ KURULMAMIŞKEN de "Hafızada bunu bulamadım." diyordu. Bu uydurma
// değil ama daha sinsi bir yalan: arama HİÇ YAPILMADIĞI hâlde kullanıcı
// "demek ki hafızada yok" diye okur — ve kullanıcının bugünkü instance'ında
// `memory-index` dizini gerçekten yok, yani HER sorgu bu yalanı alırdı.
/** Arama hiç KOŞAMADIĞINDA söylenecek cümlenin ön eki (CLI ile aynı sözcük). */
const NOT_MEASURED = 'ÖLÇEMEDİM';

/** Arama koşamadıysa sebebi kullanıcının yapabileceği bir cümleye çevir. Saf. */
function unmeasuredText(reason) {
  switch (reason) {
    case 'index_not_built':
      return `${NOT_MEASURED}: arama indeksi henüz kurulmadı — Hafıza sekmesinden indekslemeyi başlatın.`;
    case 'no_search_backend':
      return `${NOT_MEASURED}: arama arka ucu bu yüzeye bağlı değil.`;
    default:
      return `${NOT_MEASURED}: arama yapılamadı (${reason || 'bilinmeyen sebep'}).`;
  }
}

/** Seçki varsayılanları — hepsi çağıranın ezebileceği eşikler. */
const DEFAULTS = Object.freeze({
  maxLines: 10, // kapsam başına en fazla satır
  maxChars: 2600, // kapsam başına karakter tavanı (asıl bütçe BUDUR)
  lineChars: 380, // tek satırın gösterilecek payı (uzun satır alıntılanır)
  minScore: 0.0001, // 0 puanlı (hiç terim tutmayan) satır seçkiye GİRMEZ
});

/**
 * ADP-872 — RAG parçası bütçesi. Kasten KÜÇÜK: bu bölümün tüm amacı indeksin
 * TAMAMINI taşımamak. Tavan aşılırsa parça ATILIR (kırpılıp yarım cümle
 * gösterilmez) ve başlık kaç parçanın girdiğini zaten yazar.
 */
const CHUNK_DEFAULTS = Object.freeze({
  max: 3, // en fazla kaç parça
  maxChars: 1500, // parça bölümünün toplam karakter tavanı
  excerptChars: 300, // tek parçanın alıntı payı
});

/**
 * MEMORY.md'yi POINTER SATIRLARINA ayır. Başlık, HTML yorumu ve boş satır atılır:
 * bunlar bilgi taşımaz, yalnız bütçe yer. Saf.
 * @returns {{ raw:string, head:string, hook:string, file:string|null }[]}
 */
function parseIndexLines(indexText) {
  const out = [];
  for (const raw of String(indexText || '').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    if (line.trim().startsWith('#')) continue;
    if (line.trim().startsWith('<!--')) continue;
    if (!line.trim().startsWith('-')) continue;
    // `- [Başlık](dosya.md) — kanca…` → başı (tıklanabilir kaynak) ayrı tutulur ki
    // kırpma onu ASLA yutmasın; ajanın derinleşme yolu o dosya adıdır.
    // 🪤 İlk sürüm `- ` ile `[` arasında hiçbir şey olmamasını bekliyordu; gerçek
    // indekslerde `- (shared) [Başlık](…)` biçimi var → başlık head'e girmiyor ve
    // ortadan kırpılan satır KAYNAKSIZ kalıyordu (ilk koşuda görüldü). Araya sınırlı
    // uzunlukta serbest metin izni verildi.
    const m = /^(\s*-\s*[^[\]]{0,80}?\[[^\]]*\]\(([^)]+)\)\s*(?:—|-)?\s*)([\s\S]*)$/.exec(line);
    if (m) out.push({ raw: line, head: m[1], hook: m[3], file: m[2] });
    else out.push({ raw: line, head: '', hook: line.replace(/^\s*-\s*/, ''), file: null });
  }
  return out;
}

/**
 * Satırları sorguya göre puanla. BM25 değil, kasıtlı olarak daha basit ve BAĞIMSIZ:
 * burada indeks veritabanı OLMAYABİLİR (ilk açılış, indeks kurulmamış) — seçici
 * hiçbir altyapıya bağlı olmadan çalışmak ZORUNDA, yoksa "bağlam optimizasyonu"
 * yalnız indeksi olan kullanıcıda devreye girer.
 *
 * Puan = Σ idf(terim)  ·  uzunluk cezası
 *   • idf = ln(1 + N/df) → her satırda geçen terim ("hafıza") ayırt etmez, bir-iki
 *     satırda geçen terim ("elevenlabs") belirleyicidir.
 *   • uzunluk cezası: takım indeksinde bazı satırlar 3 000+ karakter; ceza olmadan
 *     UZUN satır her sorguda kazanır (çok terim taşıdığı için) ve seçki tek bir dev
 *     satıra çöker. ln tabanlı yumuşak ceza ölçüldü: kısa+alakalı satırı öne alıyor,
 *     uzun+alakalıyı elemiyor.
 * Saf.
 */
function scoreLines(lines, queryText) {
  const qTerms = [...new Set(analyze(queryText))].filter((t) => t.length >= 3);
  const docs = lines.map((l) => new Set(analyze(`${l.head} ${l.hook}`)));
  const N = Math.max(1, lines.length);
  const df = new Map();
  for (const t of qTerms) {
    let n = 0;
    for (const d of docs) if (d.has(t)) n += 1;
    df.set(t, n);
  }
  return lines.map((line, i) => {
    let score = 0;
    const hits = [];
    for (const t of qTerms) {
      const n = df.get(t) || 0;
      if (!n || !docs[i].has(t)) continue;
      score += Math.log(1 + N / n);
      hits.push(t);
    }
    const len = line.raw.length;
    const penalty = 1 + Math.log(1 + len / 400); // 400 karakter ≈ ceza 1.7×
    return { line, index: i, score: score / penalty, hits };
  });
}

/**
 * Uzun bir kancayı EŞLEŞMENİN ETRAFINDAN alıntıla (baştan kesmek yerine): satırın
 * ilk cümlesi çoğu zaman sorunun cevabı değildir. `head` (başlık + dosya adı) her
 * zaman korunur. Saf.
 */
function clipHook(hook, hits, maxChars) {
  const flat = String(hook || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= maxChars) return flat;
  const lower = flat.toLocaleLowerCase('tr');
  let at = -1;
  for (const t of hits || []) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return `${flat.slice(0, maxChars).trim()}…`;
  const start = Math.max(0, at - Math.floor(maxChars / 3));
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + maxChars).trim()}…`;
}

/**
 * BİR indeks metninden göreve İLGİLİ seçki.
 * @returns {{ lines:string[], kept:number, total:number, charsBefore:number,
 *             charsAfter:number, truncated:boolean, full:boolean }}
 *   `full:true` → indeks bütçeye sığdı, HİÇBİR ŞEY atılmadı (kayıpsız).
 */
function selectIndexLines(indexText, queryText, opts = {}) {
  const { maxLines, maxChars, lineChars, minScore } = { ...DEFAULTS, ...opts };
  const all = parseIndexLines(indexText);
  const charsBefore = String(indexText || '').length;
  if (!all.length) return { lines: [], kept: 0, total: 0, charsBefore, charsAfter: 0, truncated: false, full: true };

  // KAYIPSIZ YOL: indeks zaten bütçeye sığıyorsa seçim YAPMA. Küçük hafızalı bir
  // ajan için davranış bugünküyle birebir aynı kalır (yeni kayıp sınıfı doğmaz).
  const rawTotal = all.reduce((n, l) => n + l.raw.length + 1, 0);
  if (all.length <= maxLines && rawTotal <= maxChars) {
    return {
      lines: all.map((l) => l.raw),
      kept: all.length,
      total: all.length,
      charsBefore,
      charsAfter: rawTotal,
      truncated: false,
      full: true,
    };
  }

  const scored = scoreLines(all, queryText)
    .filter((s) => s.score > minScore)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const chosen = [];
  let chars = 0;
  for (const s of scored) {
    if (chosen.length >= maxLines) break;
    const hook = clipHook(s.line.hook, s.hits, lineChars);
    const text = `${s.line.head}${hook}`.trim();
    if (chars + text.length + 1 > maxChars) continue; // sığmayanı ATLA, döngüyü kırma:
    // sonraki (daha kısa ama hâlâ alakalı) satır bütçeye girebilir.
    chosen.push({ index: s.index, text });
    chars += text.length + 1;
  }
  // Okuma sırası indeksin KENDİ sırası olsun (kronoloji/gruplama korunur).
  chosen.sort((a, b) => a.index - b.index);
  return {
    lines: chosen.map((c) => c.text),
    kept: chosen.length,
    total: all.length,
    charsBefore,
    charsAfter: chars,
    truncated: chosen.length < all.length,
    full: false,
  };
}

/** Bir kapsamın indeks yolu + ham metni. Yoksa null. */
function readScope(dir) {
  if (!dir) return null;
  const file = path.join(dir, agentMemory.INDEX_FILE);
  try {
    const text = fs.readFileSync(file, 'utf8');
    return { dir, file, text };
  } catch {
    return null;
  }
}

/**
 * ADP-872 — hibrit aramanın döndürdüğü PARÇALARI seçki bloğuna çevir. Saf.
 *
 * İndeks satırları (pointer) "hangi dosyada ne var"ı söyler; parçalar İÇERİĞİ
 * getirir — asıl RAG kazancı budur. Her satır KAYNAK + SATIR ARALIĞI + ALINTI
 * taşır (ucun sözleşmesiyle aynı) ve hangi katmanın bulduğunu `[anlam+kelime]`
 * diye yazar: ajan sonucun ne kadar güçlü olduğunu görebilmeli.
 *
 * @param {Array} hits memoryHybrid.searchHybrid sonucu
 * @param {{vector:boolean, lexical:boolean}} layers hangi katman KOŞTU
 * @param {object} [opts] CHUNK_DEFAULTS'u ezer
 * @returns {{text:string, kept:number, chars:number}}
 */
function renderChunks(hits, layers = {}, opts = {}) {
  const { max, maxChars, excerptChars } = { ...CHUNK_DEFAULTS, ...opts };
  const list = Array.isArray(hits) ? hits : [];
  if (!list.length) return { text: '', kept: 0, chars: 0 };

  const lines = [];
  let chars = 0;
  for (const h of list) {
    if (lines.length >= max) break;
    const head = Array.isArray(h.headingPath) && h.headingPath.length ? ` › ${h.headingPath.join(' › ')}` : '';
    const where = h.lineStart != null ? ` (satır ${h.lineStart}-${h.lineEnd})` : '';
    const via = Array.isArray(h.matchedBy) && h.matchedBy.length ? ` [${h.matchedBy.join('+')}]` : '';
    const excerpt = excerptFor(String(h.excerpt || h.text || ''), '', excerptChars);
    const text = `${lines.length + 1}. ${h.name || h.docPath}${head}${where}${via}\n   "${excerpt}"`;
    // Sığmayanı ATLA, döngüyü kırma: sıradaki (daha kısa) parça bütçeye girebilir.
    if (chars + text.length + 1 > maxChars) continue;
    lines.push(text);
    chars += text.length + 1;
  }
  if (!lines.length) return { text: '', kept: 0, chars: 0 };

  // Başlık, hangi katmanların KOŞTUĞUNU söyler. Anlam katmanı katılmadıysa bunu
  // gizlemek, ölçülen kaliteyi vaat edip daha zayıfını teslim etmek olurdu.
  const via = layers.vector ? 'kelime+anlam, RRF ile birleşik' : 'yalnız kelime katmanı — anlam katmanı ısınıyor';
  return {
    text: `▸ göreve İLGİLİ hafıza PARÇALARI (hibrit arama: ${via}) — ${lines.length} parça\n${lines.join('\n')}`,
    kept: lines.length,
    chars,
  };
}

/**
 * ODAKLI HAFIZA BLOĞU — ajan spawn'ında indeksin TAMAMI yerine bu geçer.
 *
 * @param {{workspaceRoot:string, agentId:string, query:string, homedir?:string,
 *          budget?:object, cliPath?:string, retrieve?:Function}} o
 * @returns {{ text:string, stats:{scopes:Array, charsBefore:number, charsAfter:number} }}
 *   `text:''` → hiçbir kapsamda hafıza yok (çağıran ADP-237'deki gibi READ cümlesini
 *   hiç eklememeli).
 */
function focusedMemoryBlock({ workspaceRoot, agentId, query, homedir, budget = {}, cliPath = null, retrieve = null } = {}) {
  const dirs = [
    { key: 'own', label: 'senin', dir: agentMemory.agentMemoryDir(workspaceRoot, agentId) },
    { key: 'shared', label: 'takım', dir: agentMemory.sharedMemoryDir(workspaceRoot) },
    { key: 'global', label: 'global', dir: agentMemory.globalMemoryDir(homedir) },
  ];
  const scopes = [];
  const parts = [];
  let charsBefore = 0;
  let charsAfter = 0;

  for (const s of dirs) {
    const read = readScope(s.dir);
    if (!read || !read.text.trim()) continue;
    // Kendi hafızası ajanın KİMLİĞİDİR — ona daha geniş bütçe verilir; takım indeksi
    // en büyüğü olduğu için asıl kırpma orada olur.
    const perScope = s.key === 'own' ? { maxLines: 14, maxChars: 3200 } : s.key === 'global' ? { maxLines: 6, maxChars: 900 } : {};
    const sel = selectIndexLines(read.text, query, { ...perScope, ...(budget[s.key] || {}) });
    charsBefore += sel.charsBefore;
    charsAfter += sel.charsAfter;
    scopes.push({ key: s.key, file: read.file, kept: sel.kept, total: sel.total, charsBefore: sel.charsBefore, charsAfter: sel.charsAfter, full: sel.full });
    if (!sel.lines.length) {
      parts.push(`▸ ${s.label} (${read.file}) — bu konuyla eşleşen satır yok, tamamı orada.`);
      continue;
    }
    const headline = sel.full
      ? `▸ ${s.label} — TAMAMI (${sel.total} kayıt) · ${read.file}`
      : `▸ ${s.label} — ${sel.total} kayıttan bu göreve EN İLGİLİ ${sel.kept}'i · tamamı: ${read.file}`;
    parts.push(`${headline}\n${sel.lines.join('\n')}`);
  }

  // ADP-872 — RAG: indeks satırlarının ÜSTÜNE göreve ilgili PARÇALAR. Arama hiç
  // koşamazsa (indeks yok, hata) blok ADP-862'deki hâliyle üretilir — geri-çağırma
  // bir spawn'ı asla bloklayamaz ve hiçbir erişim kaybolmaz.
  let chunkStats = { kept: 0, chars: 0, layers: { vector: false, lexical: false }, reason: 'not_requested' };
  if (typeof retrieve === 'function') {
    try {
      const r = retrieve(query) || {};
      const rendered = renderChunks(r.hits, r.layers || {}, budget.chunks || {});
      chunkStats = { kept: rendered.kept, chars: rendered.chars, layers: r.layers || { vector: false, lexical: false }, reason: r.reason || null, mode: r.mode || null };
      if (rendered.text) {
        charsAfter += rendered.chars;
        parts.push(rendered.text);
      }
    } catch (err) {
      chunkStats = { kept: 0, chars: 0, layers: { vector: false, lexical: false }, reason: `retrieve_threw: ${err.message}` };
    }
  }

  if (!parts.length) return { text: '', stats: { scopes, chunks: chunkStats, charsBefore: 0, charsAfter: 0 } };

  // Sırlar seçkide de maskelenir: hafıza dosyasına düşmüş bir jeton buradan spawn
  // argv'sine ve oradan process listesine geçerdi.
  const body = maskSecrets(parts.join('\n\n'));
  // `--workspace` AÇIKÇA verilir: ajanın cwd'si bir ALT depo olabilir ve orada da
  // `.crewpane/memory` bulunabilir (ölçüldü: crewpane/ içinde koşan komut yanlış,
  // indekssiz kökü seçiyordu). Tahmine bırakmak yerine kökü söylüyoruz.
  const deeper = cliPath
    ? `\nDaha derini gerektiğinde ARA (tüm indeksi okumaya gerek yok): ` +
      `\`node "${cliPath}" --workspace "${workspaceRoot}" "<konu>"\` → kaynak dosya + satır + alıntı döndürür; ` +
      `hafızada yoksa "${NOT_FOUND}" der (uydurmaz). Tam indeksi okumak da serbest — yolları yukarıda.`
    : '';
  // Not: başlıkta emoji YOK — çağıran (spawn cue'su) kendi 📓 işaretini taşıyor ve
  // ikisi yan yana gelince satır "📓 … 📓 …" diye çiftleniyordu (ilk koşuda görüldü).
  const text =
    `HAFIZA — göreve/rolüne göre SEÇİLMİŞ kayıtlar (tam indeks değil; seçki KAYIPLIDIR, ` +
    `aradığın buradaysa dosyayı aç, yoksa aşağıdaki aramayı kullan):\n${body}${deeper}`;
  return { text, stats: { scopes, chunks: chunkStats, charsBefore, charsAfter } };
}

/**
 * ARAMA UCU — ürünün TEK giriş noktası (hafıza sekmesi · raporlar · CLI · sonraki
 * adımda sesli katman AYNI fonksiyonu çağırır).
 *
 * @param {object} o
 * @param {string} o.workspaceRoot
 * @param {string} o.query
 * @param {number} [o.k]
 * @param {(args:object)=>Promise<object>} o.search  hibrit arama seam'i
 *   (main: memorySearchService.search · CLI: yalnız kelime katmanı)
 * @param {string} [o.agentId] verilirse seçki bloğu da döner (bağlam yüzeyi)
 * @returns {Promise<{ok:boolean, found:boolean, query:string, results:Array,
 *                    text:string, degraded:boolean, reason?:string, masked:number}>}
 */
function isMemoryRecordValid(record, { now = Date.now(), includeInvalid = false } = {}) {
  if (includeInvalid) return true;
  if (!record) return false;
  if (record.supersededBy) return false;
  if (record.validUntil) {
    const currentTime = typeof now === 'function' ? now() : (typeof now === 'number' ? now : Date.now());
    const vTime = typeof record.validUntil === 'number' ? record.validUntil : Date.parse(record.validUntil);
    if (Number.isFinite(vTime) && vTime < currentTime) return false;
  }
  return true;
}

function formatRecallHit(r, q) {
  const rawExcerpt = String(r.excerpt || '') || excerptFor(r.text, q);
  const excerpt = maskSecrets(rawExcerpt);
  const isMasked = excerpt !== rawExcerpt;
  return {
    hit: {
      source: r.docPath || r.name || '(bilinmiyor)',
      name: r.name || '',
      scope: r.scope || '',
      heading: Array.isArray(r.headingPath) && r.headingPath.length ? r.headingPath.join(' › ') : '',
      lineStart: r.lineStart ?? null,
      lineEnd: r.lineEnd ?? null,
      excerpt,
      matchedBy: Array.isArray(r.matchedBy) ? r.matchedBy : [],
      score: typeof r.score === 'number' ? r.score : null,
      supersededBy: r.supersededBy || null,
      validUntil: r.validUntil || null,
    },
    isMasked,
  };
}

/**
 * UÇ: `recall` — tek çağırma noktası.
 *
 * SÖZLEŞME — bu DÖRDÜ ucun VAADİDİR, çağıran bunlara güvenir:
 *   • her sonuç KAYNAK (dosya + satır) ve ALINTI taşır,
 *   • arama KOŞTU ve sonuç yoksa `measured:true, found:false` + NOT_FOUND döner —
 *     hiçbir koşulda uydurulmuş ya da "en yakın" bir kayıt sonuç gibi sunulmaz,
 *   • arama KOŞAMADIYSA (indeks yok, arka uç yok, hata) `measured:false` + ÖLÇEMEDİM
 *     metni döner — "bulamadım" DEMEZ, çünkü aranmadı,
 *   • gösterilen her metin sır maskesinden geçer.
 *   • süresi geçmiş (validUntil) veya yerini başkasına bırakmış (supersededBy) kayıtlar
 *     varsayılan olarak elenir (includeInvalid: true ile açıkça istenebilir).
 */
async function recall({
  workspaceRoot,
  query,
  k = 5,
  search,
  agentId = null,
  homedir,
  cliPath = null,
  includeInvalid = false,
  now = Date.now,
} = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, found: false, measured: false, query: '', results: [], text: 'Boş sorgu.', degraded: false, reason: 'empty_query', masked: 0 };
  if (typeof search !== 'function') {
    return { ok: false, found: false, measured: false, query: q, results: [], text: unmeasuredText('no_search_backend'), degraded: true, reason: 'no_search_backend', masked: 0 };
  }

  let raw;
  try {
    raw = await search({ workspaceRoot, query: q, k });
  } catch (err) {
    return { ok: false, found: false, measured: false, query: q, results: [], text: unmeasuredText(err.message), degraded: true, reason: err.message, masked: 0 };
  }

  // Arka uç `ok:false` dediyse ARAMA HİÇ KOŞMADI (memorySearchService.cjs:178
  // `index_not_built` bunun en sık hâli). Boş sonuç gibi davranmak = yalan.
  if (raw && raw.ok === false && raw.reason !== 'empty_query') {
    return maskDeep({
      ok: false, found: false, measured: false, query: q, results: [],
      text: unmeasuredText(raw.reason), degraded: true, reason: raw.reason, masked: 0,
    });
  }

  const rawHits = Array.isArray(raw && raw.results) ? raw.results : [];
  const hits = rawHits.filter((r) => isMemoryRecordValid(r, { now, includeInvalid }));
  let masked = 0;
  const results = [];
  for (const r of hits) {
    const formatted = formatRecallHit(r, q);
    if (formatted.isMasked) masked += 1;
    results.push(formatted.hit);
  }

  const found = results.length > 0;
  const out = {
    ok: raw && raw.ok !== false,
    found,
    // ARAMA KOŞTU. `found:false` artık dürüst bir "bulamadım"dır — çünkü
    // koşamadığı hâller yukarıda `measured:false` ile ayrıldı.
    measured: true,
    query: q,
    results,
    text: formatRecall(results),
    // Anlam katmanı katılamadıysa çağıran BİLMELİ (yalnız kelime katmanı = daha zayıf).
    degraded: Boolean(raw && raw.degraded),
    reason: raw && raw.reason ? raw.reason : undefined,
    masked,
  };
  if (agentId) {
    const block = focusedMemoryBlock({ workspaceRoot, agentId, query: q, homedir, cliPath });
    out.focused = block.text;
    out.focusedStats = block.stats;
  }
  // İkinci maskeleme katmanı: yapı içindeki HER string (uç sözleşmesi).
  return maskDeep(out);
}

/** Sonuçları okunur metne çevir: KAYNAK + SATIR + ALINTI. Boşsa dürüst ret. Saf. */
function formatRecall(results) {
  if (!results || !results.length) return NOT_FOUND;
  return results
    .map((r, i) => {
      const where = r.lineStart != null ? ` (satır ${r.lineStart}-${r.lineEnd})` : '';
      const head = r.heading ? ` › ${r.heading}` : '';
      const via = r.matchedBy && r.matchedBy.length ? ` [${r.matchedBy.join('+')}]` : '';
      return `${i + 1}. ${r.source}${head}${where}${via}\n   "${r.excerpt}"`;
    })
    .join('\n');
}

module.exports = {
  NOT_FOUND,
  NOT_MEASURED,
  unmeasuredText,
  DEFAULTS,
  CHUNK_DEFAULTS,
  parseIndexLines,
  scoreLines,
  clipHook,
  selectIndexLines,
  renderChunks,
  focusedMemoryBlock,
  formatRecall,
  recall,
  isMemoryRecordValid,
};
