// CrewPane — ADP-870 (SPRINT-MEMORY-SEARCH · Faz 2) Markdown parçalayıcı.
//
// NEDEN BAŞLIK BAZLI: hafıza dosyaları (ADP-235) disiplinli yazılıyor — frontmatter +
// `##` başlıklı bölümler. Başlık sınırı DOĞAL anlam sınırıdır; sabit karakter penceresi
// bir tuzağın ortasından kesip iki yarım fikir üretir. Faz 1 düzeneği (docs/research/
// rag-embed-bench/corpus.mjs) bilerek sabit-pencere kullandı (modelleri kıyaslamak için
// yeter) ve doküman başına yalnız ilk 8 parçayı görüyordu — korpusun %70'i indekssizdi.
// Bu modül o iki kısıtı da kaldırır: TÜM doküman, başlık sınırlarında.
//
// SAF: node builtins bile gerekmiyor. Jeton sayacı ENJEKTE edilir (`countTokens`) —
// varsayılan tahmin testler için, indeksleyici GERÇEK bge-m3 tokenizer'ını geçirir.
//
// 🪤 ADP-869 ölçümü: sabit karakter indeksinden dilimlemek emoji'yi ORTADAN İKİYE böler
// (JS string'i UTF-16; `🪤` iki "karakter"). Yarım surrogate GEÇERSİZ metindir ve HF'in
// Rust tokenizer'ı `TextEncodeInput must be Union[...]` ile koşuyu KOMPLE düşürür.
// 9079 parçanın 4'ü yetmişti. Burada satır sınırında bölmek bunu çoğunlukla önler ama
// tek bir satır bütçeyi aşarsa yine karakterden kesiyoruz → çıktı HER ZAMAN temizlenir.

'use strict';

// Hedefler jeton cinsinden (görev spec'i: 256-512 jeton, %10 örtüşme).
const DEFAULTS = Object.freeze({
  maxTokens: 512, // bir parçanın aşamayacağı tavan
  targetTokens: 384, // uzun bölüm bölünürken hedeflenen boy
  minTokens: 64, // bundan küçük bölüm komşusuyla birleştirilir
  overlapRatio: 0.1, // %10 örtüşme
});

// ADP-870 ÖLÇÜMÜ (785 hafıza dosyası, bge-m3'ün kendi XLM-R tokenizer'ı):
// 2 855 020 karakter → 984 667 jeton = **2.899 karakter/jeton**.
// İngilizce için akılda kalan "~4 karakter/jeton" Türkçe+emoji+kod karışımında
// YANLIŞ: ilk denemede 3.53 yazdım, ölçünce parçaların %7.5'i (297/3947) 512'yi
// aştı (en büyüğü 740). Sabit ölçülen değere çekildi — tahmin ile gerçek arasındaki
// sapma doğrudan "bütçe aşımı" demek.
//
// Neden tokenizer'ı parçalayıcıya SOKMUYORUZ: gerçek tokenizer'ı satır başına
// çağırmak 785 dosyada dakikalarca sürüyor (ölçüldü — 2 dk'da bitmedi), tahminle
// parçalayıp sonucu gerçekle DOĞRULAMAK aynı güvenceyi saniyeler içinde veriyor.
// `countTokens` seam'i duruyor: isteyen gerçek tokenizer'ı enjekte edebilir.
const CHARS_PER_TOKEN = 2.899;

/** Yarım kalan (eşsiz) surrogate + ham NUL temizliği. Saf. */
function sanitize(s) {
  return s
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    // eslint-disable-next-line no-control-regex -- korpusta ham NUL taşıyan dosya ÖLÇÜLDÜ
    .replace(/\u0000/g, '');
}

/** Varsayılan jeton tahmini (gerçek tokenizer yokken). Saf. */
function estimateTokens(s) {
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

/**
 * Dosyayı bölümlere ayır: frontmatter + her ATX başlığı yeni bölüm başlatır.
 * Çitli kod blokları (``` / ~~~) İÇİNDEKİ `#` satırları başlık SAYILMAZ — yoksa
 * shell yorumları (`# npm install`) dosyayı paramparça eder.
 * Dönen bölüm: { headingPath: string[], lineStart, lineEnd, lines: string[] }
 * lineStart/lineEnd 1-tabanlı ve KAPSAYICI (editörde "şu satırlar" demek için).
 */
function splitSections(text) {
  const lines = text.split('\n');
  const sections = [];
  const stack = []; // [{level, title}]
  let cur = { headingPath: [], lineStart: 1, lines: [] };
  let fence = null; // açık çit dizisi (``` veya ~~~)
  let inFrontmatter = false;

  const close = (endLine) => {
    if (cur.lines.some((l) => l.trim())) sections.push({ ...cur, lineEnd: endLine });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    // Frontmatter: yalnız dosyanın İLK satırındaki `---` açar.
    if (lineNo === 1 && /^---\s*$/.test(line)) {
      inFrontmatter = true;
      cur.lines.push(line);
      continue;
    }
    if (inFrontmatter) {
      cur.lines.push(line);
      if (/^---\s*$/.test(line)) inFrontmatter = false;
      continue;
    }

    const fenceM = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceM) {
      if (fence && fenceM[1][0] === fence[0] && fenceM[1].length >= fence.length) fence = null;
      else if (!fence) fence = fenceM[1];
      cur.lines.push(line);
      continue;
    }

    const h = fence ? null : line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      close(lineNo - 1);
      const level = h[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title: h[2].trim() });
      cur = { headingPath: stack.map((s) => s.title), lineStart: lineNo, lines: [line] };
      continue;
    }
    cur.lines.push(line);
  }
  close(lines.length);
  return sections;
}

/**
 * Tek bir satırı (bütçeyi tek başına aşan uzun tablo/URL satırı) karakterden kes.
 * Örtüşme YOK — bu bir kaçış yolu, normal yol satır sınırıdır. Her dilim temizlenir.
 */
function hardSplitLine(line, maxTokens, countTokens) {
  const out = [];
  const approxChars = Math.max(200, Math.floor(maxTokens * CHARS_PER_TOKEN * 0.9));
  for (let i = 0; i < line.length; i += approxChars) {
    let piece = sanitize(line.slice(i, i + approxChars));
    // Gerçek tokenizer tahminden büyük derse kırp (tavan SERT olmalı — model penceresi).
    while (piece && countTokens(piece) > maxTokens) piece = sanitize(piece.slice(0, Math.floor(piece.length * 0.85)));
    if (piece.trim()) out.push(piece);
  }
  return out.length ? out : [sanitize(line).trim()].filter(Boolean);
}

/**
 * Bir bölümü jeton bütçesine sığan pencerelere böl. Pencere SINIRI SATIRDIR →
 * satır aralığı meta verisi kesin çıkar ve emoji ortadan bölünmez.
 * Örtüşme: bir sonraki pencere, öncekinin son ~%10'luk jetonunu kapsayan satırlardan başlar.
 */
function windowSection(section, opts, countTokens) {
  const { targetTokens, maxTokens, overlapRatio } = opts;
  const items = []; // { text, line, tokens } — hard-split parçaları aynı satır no'sunu paylaşır
  for (let i = 0; i < section.lines.length; i++) {
    const raw = section.lines[i];
    const lineNo = section.lineStart + i;
    const clean = sanitize(raw);
    const t = countTokens(clean);
    if (t > maxTokens) {
      for (const piece of hardSplitLine(clean, maxTokens, countTokens)) {
        items.push({ text: piece, line: lineNo, tokens: countTokens(piece) });
      }
    } else {
      items.push({ text: clean, line: lineNo, tokens: t });
    }
  }

  const windows = [];
  let start = 0;
  while (start < items.length) {
    let end = start;
    let tokens = 0;
    while (end < items.length) {
      const next = tokens + items[end].tokens;
      // En az bir öğe HER ZAMAN alınır (aksi halde sonsuz döngü).
      if (end > start && next > targetTokens) break;
      tokens = next;
      end++;
      if (tokens >= targetTokens) break;
    }
    const slice = items.slice(start, end);
    if (slice.some((it) => it.text.trim())) {
      windows.push({
        text: slice.map((it) => it.text).join('\n').trim(),
        lineStart: slice[0].line,
        lineEnd: slice[slice.length - 1].line,
        tokens,
      });
    }
    if (end >= items.length) break;
    // %10 örtüşme: pencerenin sonundan geriye doğru overlapRatio kadar jeton al.
    const budget = Math.max(1, Math.round(tokens * overlapRatio));
    let back = 0;
    let acc = 0;
    while (back < slice.length - 1 && acc < budget) {
      acc += slice[slice.length - 1 - back].tokens;
      back++;
    }
    start = Math.max(start + 1, end - back);
  }
  return windows;
}

/**
 * Dosya metnini parçalara böl.
 *
 * @param {string} text ham markdown
 * @param {{maxTokens?,targetTokens?,minTokens?,overlapRatio?,countTokens?}} [options]
 * @returns {{ordinal:number,headingPath:string[],lineStart:number,lineEnd:number,tokens:number,text:string}[]}
 */
function chunkMarkdown(text, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const countTokens = typeof options.countTokens === 'function' ? options.countTokens : estimateTokens;
  const body = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  if (!body.trim()) return [];

  const sections = splitSections(body);

  // Küçük ARDIŞIK bölümleri birleştir: hafıza dosyalarında "## Başlık" + 2 satır çok
  // yaygın; tek başına gömülen 20 jetonluk parça hem indeksi şişirir hem bağlamsızdır.
  // Birleşen grubun headingPath'i İLK bölümünkidir; satır aralığı grubu kapsar, yani
  // "nereden geldi" hâlâ kesin.
  const merged = [];
  for (const s of sections) {
    const tokens = countTokens(s.lines.join('\n'));
    const prev = merged[merged.length - 1];
    if (prev && prev.tokens < opts.minTokens && prev.tokens + tokens <= opts.targetTokens && prev.lineEnd + 1 === s.lineStart) {
      prev.lines = prev.lines.concat(s.lines);
      prev.lineEnd = s.lineEnd;
      prev.tokens += tokens;
      prev.mergedCount = (prev.mergedCount || 1) + 1;
      continue;
    }
    merged.push({ ...s, tokens, mergedCount: 1 });
  }

  const chunks = [];
  for (const s of merged) {
    const windows = s.tokens <= opts.maxTokens
      ? [{ text: s.lines.join('\n').trim(), lineStart: s.lineStart, lineEnd: s.lineEnd, tokens: s.tokens }]
      : windowSection(s, opts, countTokens);
    for (const w of windows) {
      const clean = sanitize(w.text).trim();
      if (!clean) continue;
      chunks.push({
        ordinal: chunks.length,
        headingPath: s.headingPath,
        lineStart: w.lineStart,
        lineEnd: w.lineEnd,
        tokens: w.tokens,
        text: clean,
      });
    }
  }
  return chunks;
}

/**
 * Gömülecek metin: başlık yolu parçanın kendisinde YAZMIYOR olabilir (bölüm ortasından
 * gelen pencere) — başlık zinciri en ucuz bağlam sinyalidir, önüne eklenir.
 * Dosya ADI bilerek EKLENMEZ: Faz 1'de leksik taban çizgisi zaten dosya adına bakıyordu;
 * hibrit (Faz 3) o sinyali BM25 tarafından getirecek, burada tekrar etmek anlamsal
 * vektörü dosya-adı gürültüsüyle kirletir. (A/B'si Faz 3'e bırakıldı — ÖLÇÜLMEDİ.)
 */
function embedTextFor(chunk) {
  const head = Array.isArray(chunk.headingPath) ? chunk.headingPath.filter(Boolean).join(' › ') : '';
  return head ? `${head}\n${chunk.text}` : chunk.text;
}

module.exports = {
  chunkMarkdown,
  embedTextFor,
  splitSections,
  sanitize,
  estimateTokens,
  DEFAULTS,
  CHARS_PER_TOKEN,
};
