// CrewPane — ONNX-CRASH-01 · GÖMME GİRDİ TAVANI (tek kaynak).
//
// NEDEN VAR: 24.08.2026 16:31'de (0.2.41) gömme çocuğu macOS'ta SIGTRAP ile öldü.
// Gerçek çökme raporunun yığını
//   Add<float>::Compute → UntypedBroadcastTwo → BFCArena::Extend → posix_memalign
// ve x3/x19/x21 = 0x80000000 → **tek seferde 2 GiB** ayırma denemesi.
//
// MEKANİZMA (ölçüldü, tahmin değil): dikkat skoru tensörü
//     B · H · S² · 4 bayt          (B=parti, H=16 kafa, S=dizi uzunluğu)
// yani girdi uzunluğunda KAREsel. bge-m3 (XLM-R large) için:
//     S=512,  B=16 → 268 MB      S=1024, B=16 → 1 GiB → arena 2 GiB'a genişler ✝
//     S=2048, B=1  → ölçülen tepe RSS 2.9 GB
//     S=4096, B=1  → ölçülen tepe RSS 8.9 GB, 37.7 sn
//     S=8192, B=1  → ölçülen tepe RSS 8.4 GB, 76.6 sn  (tokenizer tavanı burası)
//   ✝ BFCArena bölgeyi İKİYE KATLAYARAK büyütür; 1 GiB'lık bir tensör için istenen
//     sonraki bölge tam 0x80000000'dir — çökme raporundaki değerin BİREBİR aynısı.
//
// KUSUR NEREDEYDİ: zincirin HİÇBİR yerinde jeton tavanı yoktu.
//   • memoryChunker 512 jetonluk bir tavan uyguluyor ama TAHMİNLE (2.899 kar./jeton).
//     Ölçüm: 1 938 parçanın 39'u (%2.0) gerçek tokenizer'da 512'yi aşıyor (en kötü 638).
//     Parti `padding:true` ile EN UZUNA doldurulduğu için tek bir uzun parça 16'lık
//     partinin TAMAMINI o boya şişirir.
//   • Sorgu yolunda (memoryEmbedWorker) tavan HİÇ yok: gelen metin ne ise gömülür.
//     transformers.js'in tek freni tokenizer'ın `model_max_length`i = **8192** —
//     yukarıdaki ölçüme göre bu freni kullanmak zaten 8+ GB ve 76 saniye demek.
//
// TAVAN NEREDEN GELİR: modelin BEYANINDAN (8192) DEĞİL, ölçülen bellek eğrisinden.
// Model metadata'sı yalnız ÜST SINIR olarak okunur (`resolveMaxTokens`) — beyan
// bizimkinden küçükse (başka model) ona uyulur, büyükse bizim tavanımız kazanır.
//
// SAF MODÜL: node builtin'i bile gerekmiyor; jeton sayacı ENJEKTE edilir.

'use strict';

const chunker = require('./memoryChunker.cjs'); // sanitize + estimateTokens (tek kaynak)

/**
 * Bir çıkarım dizisinin aşamayacağı GERÇEK jeton sayısı.
 * 512 seçildi çünkü (a) memoryChunker'ın hedefiyle aynı — indeksin anlamı değişmez,
 * (b) B=16 partide dikkat tensörü 268 MB'ta kalır (ölçülen eğrinin güvenli bölgesi).
 */
const MAX_SEQ_TOKENS = 512;

/** Bir metin en çok bu kadar parçaya bölünür; gerisi DÜŞER (kırpma bildirilir). */
const MAX_PIECES = 8;

/**
 * Tokenizer'a girmeden ÖNCEKİ ham karakter tavanı. Gerekçe ayrı bir ölçüm:
 * tokenizer'ın kendi maliyeti süperdoğrusal — 10 000 karakter 532 ms, 100 000
 * karakter **72 783 ms**. Yani sınırsız girdi, ONNX'e hiç varmadan çocuğu
 * dakikalarca kilitler. Tavan MAX_PIECES × MAX_SEQ_TOKENS × 2.899 kar./jeton
 * (≈11 900) üstüne %50 pay: zaten MAX_PIECES daha erken kesecek.
 */
const MAX_INPUT_CHARS = 18000;

/** Tek partideki en fazla dizi sayısı (bugünkü indeksleyici partisiyle aynı). */
const MAX_BATCH_SEQS = 16;

/**
 * Parti maliyeti tavanı, jeton² cinsinden: `dizi_sayısı × en_uzun_dizi²`.
 * B·H·S²·4 formülünün H ve 4'ü sabit olduğundan geriye bu çarpım kalır.
 * MAX_BATCH_SEQS × MAX_SEQ_TOKENS² = 16 × 512² → dikkat tensörü 268 MB.
 */
const MAX_BATCH_COST = MAX_BATCH_SEQS * MAX_SEQ_TOKENS * MAX_SEQ_TOKENS;

/**
 * Bu koşunun jeton tavanı. Modelin beyanı yalnız ÜST SINIR olarak okunur:
 * beyan daha küçükse (küçük pencereli başka bir model) ona uyulur.
 * @param {number|null|undefined} modelMaxLength tokenizer_config.model_max_length
 */
function resolveMaxTokens(modelMaxLength, ceiling = MAX_SEQ_TOKENS) {
  const declared = Number(modelMaxLength);
  const upper = Number.isFinite(declared) && declared > 0 ? declared : Infinity;
  return Math.max(16, Math.min(ceiling, upper));
}

/**
 * Metni jeton bütçesine sığan parçalara böl.
 *
 * ÖNCE KARAKTERDEN, SONRA JETONDAN: pencere karakterle kesilir (ucuz), sonra
 * GERÇEK sayaçla bütçeye kadar kırpılır. Tersi (önce hepsini tokenize et) yukarıdaki
 * süperdoğrusal maliyete girerdi.
 *
 * @param {string} text
 * @param {{countTokens:(s:string)=>number, maxTokens?:number, maxPieces?:number,
 *          maxChars?:number, charsPerToken?:number}} opts
 * @returns {{pieces:string[], pieceTokens:number[], truncated:boolean, clipped:boolean, tokens:number}}
 */
function planInput(text, {
  countTokens,
  maxTokens = MAX_SEQ_TOKENS,
  maxPieces = MAX_PIECES,
  maxChars = MAX_INPUT_CHARS,
  charsPerToken = chunker.CHARS_PER_TOKEN,
} = {}) {
  const count = typeof countTokens === 'function' ? countTokens : chunker.estimateTokens;
  const raw = String(text == null ? '' : text);
  const clipped = raw.length > maxChars;
  // 🪤 Karakterden kesmek yarım surrogate bırakabilir — HF'in tokenizer'ı bunda
  // koşuyu komple düşürüyor (memoryChunker başlığındaki ölçüm). Her dilim temizlenir.
  const body = chunker.sanitize(clipped ? raw.slice(0, maxChars) : raw);

  // Kısa metnin (ezici çoğunluk) maliyeti TEK sayaç çağrısı olsun.
  if (!body.trim()) {
    const n = count(body);
    return { pieces: [body], pieceTokens: [n], truncated: false, clipped, tokens: n };
  }
  const whole = count(body);
  if (whole <= maxTokens) return { pieces: [body], pieceTokens: [whole], truncated: false, clipped, tokens: whole };

  const window = Math.max(64, Math.floor(maxTokens * charsPerToken * 0.9));
  const pieces = [];
  const pieceTokens = [];
  let cursor = 0;
  let tokens = 0;
  while (cursor < body.length && pieces.length < maxPieces) {
    let piece = chunker.sanitize(body.slice(cursor, cursor + window));
    let used = window;
    // Tahmin tuttuysa tek sayaç; tutmadıysa küçülterek in (memoryChunker.hardSplitLine
    // deseninin aynısı — tavan SERT olmak zorunda, model penceresi bu).
    let n = count(piece);
    while (piece.length > 1 && n > maxTokens) {
      used = Math.floor(piece.length * 0.85);
      piece = chunker.sanitize(body.slice(cursor, cursor + used));
      n = count(piece);
    }
    if (piece.trim()) {
      pieces.push(piece);
      pieceTokens.push(n);
      tokens += n;
    }
    cursor += Math.max(1, used);
  }
  return { pieces, pieceTokens, truncated: cursor < body.length, clipped, tokens };
}

/**
 * Dizileri partilere böl: hem SAYI hem MALİYET tavanına uyar.
 * `padding:true` partiyi EN UZUN diziye doldurduğu için maliyet
 * `sayı × enUzun²`dir — bu yüzden tek uzun dizi partiyi küçültür.
 * @param {number[]} tokenCounts
 * @returns {Array<{start:number,end:number,seqs:number,maxTokens:number,cost:number}>}
 */
function planBatches(tokenCounts, { maxSeqs = MAX_BATCH_SEQS, maxCost = MAX_BATCH_COST } = {}) {
  const out = [];
  let i = 0;
  while (i < tokenCounts.length) {
    let end = i;
    let peak = 0;
    while (end < tokenCounts.length) {
      const next = Math.max(peak, Math.max(1, tokenCounts[end] || 1));
      const seqs = end - i + 1;
      // En az bir dizi HER ZAMAN alınır (aksi halde sonsuz döngü).
      if (end > i && (seqs > maxSeqs || seqs * next * next > maxCost)) break;
      peak = next;
      end++;
    }
    out.push({ start: i, end, seqs: end - i, maxTokens: peak, cost: (end - i) * peak * peak });
    i = end;
  }
  return out;
}

module.exports = {
  MAX_SEQ_TOKENS,
  MAX_PIECES,
  MAX_INPUT_CHARS,
  MAX_BATCH_SEQS,
  MAX_BATCH_COST,
  resolveMaxTokens,
  planInput,
  planBatches,
};
