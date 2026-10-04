'use strict';

// ADP-909 — ÇIKTI SÜZGECİ: modelin konuşma-dışı seste ürettiği BİLİNEN kalıplar.
//
// Kapı (sttSilenceGate) sesin konuşma içerip içermediğine bakar; bu modül metne
// bakar. İkisi AYRI savunma katmanıdır çünkü halüsinasyon her zaman sessizlikten
// doğmuyor: ölçüldü ki alçak seviyeli ama DİNAMİK bir sinyal (uzak/kısık bir
// video, kâğıt hışırtısı) kapıyı meşru şekilde geçip modeli yine YouTube
// külliyatına düşürebiliyor.
//
// 🔴 KALIPLAR KODA GÖMÜLÜ DEĞİL: `sttHallucinations.json`. Yeni bir kalıp
// görüldüğünde kod değişmez, veri dosyasına bir satır eklenir (ADP-909 (c)).
//
// 🔑 EŞLEŞME TAM METİN ÜZERİNDEDİR, ALT DİZE DEĞİL. Bu, görevin açıkça istediği
// NEGATİF VAKAyı garanti eder: kullanıcı GERÇEKTEN "abone sayısını kontrol et"
// derse metnin TAMAMI bir kalıba eşit olmadığı için hiçbir şey olmaz. Alt-dize
// eşleşmesi kullanılsaydı bu cümle sessizce yutulurdu — yani süzgeç, çözdüğünden
// daha kötü bir hata sınıfı üretirdi.

const fs = require('node:fs');
const path = require('node:path');

const DATA_FILE = path.join(__dirname, 'sttHallucinations.json');

/**
 * Türkçe-duyarlı normalizasyon. `toLowerCase()` TEK BAŞINA YETMEZ: 'İ' varsayılan
 * yerelde 'i̇' (i + birleşen nokta) olur ve kalıp asla tutmaz. Ayrıca model aynı
 * cümleyi bazen aksanlı bazen aksansız yazıyor (ölçüldü) → aksanları da katlıyoruz.
 */
function normalize(text) {
  let s = String(text == null ? '' : text);
  s = s
    .replace(/İ/g, 'i').replace(/I/g, 'i').replace(/ı/g, 'i')
    .replace(/Ş/g, 's').replace(/ş/g, 's')
    .replace(/Ğ/g, 'g').replace(/ğ/g, 'g')
    .replace(/Ü/g, 'u').replace(/ü/g, 'u')
    .replace(/Ö/g, 'o').replace(/ö/g, 'o')
    .replace(/Ç/g, 'c').replace(/ç/g, 'c')
    .toLowerCase();
  // Noktalama at ("Altyazı M.K." → "altyazi mk"), boşluğu sadeleştir.
  s = s.replace(/[^\p{L}\p{N}\s]+/gu, '').replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Aynı cümlenin arka arkaya tekrarını teke indir. Model uzun gürültüde kalıbı
 * ÇOĞALTIYOR (ölçüldü: "Altyazı M.K. Altyazı M.K.", "Bu ne? Bu ne?") — tekrarı
 * sadeleştirmezsek tam-metin eşleşmesi ıskalar.
 */
function collapseRepeats(normalized) {
  const words = normalized.split(' ').filter(Boolean);
  if (!words.length) return '';
  // 1..n/2 uzunluğundaki bir bloğun tam katı olarak tekrarlanmasını ara.
  for (let len = 1; len <= Math.floor(words.length / 2); len += 1) {
    if (words.length % len !== 0) continue;
    const block = words.slice(0, len).join(' ');
    let all = true;
    for (let i = len; i < words.length; i += len) {
      if (words.slice(i, i + len).join(' ') !== block) { all = false; break; }
    }
    if (all) return block;
  }
  return words.join(' ');
}

let cache = null;

/**
 * Kalıpları oku. Dosya yoksa/bozuksa BOŞ liste döner ve süzgeç sessizce devre
 * dışı kalır — bir veri dosyası hatası yüzünden konuşma tanıma ÇALIŞMAZ hâle
 * gelmemeli (fail-open: burada yanlış-negatif, yanlış-pozitiften iyidir).
 */
function loadPatterns({ file = DATA_FILE, readFile = fs.readFileSync, fresh = false } = {}) {
  if (cache && !fresh && file === DATA_FILE) return cache;
  let parsed = null;
  try {
    parsed = JSON.parse(String(readFile(file, 'utf8')));
  } catch {
    parsed = null;
  }
  const list = (parsed && Array.isArray(parsed.patterns) ? parsed.patterns : [])
    .map((p) => {
      const raw = p && typeof p === 'object' ? p.text : p;
      const norm = collapseRepeats(normalize(raw));
      return norm ? { text: String(raw), norm, note: (p && p.note) || '', observed: (p && p.observed) || '' } : null;
    })
    .filter(Boolean);
  const out = { version: (parsed && parsed.version) || 0, patterns: list };
  if (file === DATA_FILE) cache = out;
  return out;
}

/** Testler/ayar değişimi için önbelleği düşür. */
function _clearCache() { cache = null; }

/**
 * Metin BİLİNEN bir halüsinasyon kalıbının TAMAMI mı?
 * → { hit:false } | { hit:true, pattern, normalized }
 */
function inspect(text, opts = {}) {
  const normalized = collapseRepeats(normalize(text));
  if (!normalized) return { hit: false, normalized };
  const { patterns } = opts.patterns ? { patterns: opts.patterns } : loadPatterns(opts);
  for (const p of patterns) {
    if (p.norm === normalized) return { hit: true, pattern: p.text, normalized };
  }
  return { hit: false, normalized };
}

/**
 * Transkripsiyon SONUCUNU süz. Şekil korunur: konuşma yoksa çağıranların zaten
 * bildiği `{ ok:false, reason:'no-speech' }` döner (yeni bir sebep kodu icat
 * etmiyoruz — `withUserMessage`/mobil köprü/e2e o kodu ZATEN doğru karşılıyor).
 * `hallucination` alanı yalnız TEŞHİS içindir.
 */
function filterResult(result, opts = {}) {
  if (!result || result.ok !== true || typeof result.text !== 'string') return result;
  const v = inspect(result.text, opts);
  if (!v.hit) return result;
  return {
    ok: false,
    reason: 'no-speech',
    detail: result.text.slice(0, 80),
    hallucination: v.pattern,
    ...(result.engine ? { engine: result.engine } : {}),
    ...(result.ms !== undefined ? { ms: result.ms } : {}),
  };
}

module.exports = {
  DATA_FILE,
  normalize,
  collapseRepeats,
  loadPatterns,
  inspect,
  filterResult,
  _clearCache,
};
