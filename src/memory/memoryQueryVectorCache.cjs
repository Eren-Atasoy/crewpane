// CrewPane — ADP-872 (Faz 4) SORGU VEKTÖRÜ ÖNBELLEĞİ.
//
// ── NEDEN VAR (ölçülmüş bir kısıt) ──────────────────────────────────────────
// Hibrit arama iki liste ister: kelime (BM25) + anlam (vektör). Kelime katmanı
// SENKRON çalışır (SQLite). Anlam katmanı ise sorguyu GÖMMEK zorundadır ve gömme
// modeli 543 MB'lık bir ÇOCUK SÜREÇTE yaşar (ADP-870 §4c: ilk yükleme onlarca
// saniye). Ajan spawn'ı ise senkron bir argv kurulumudur — orada onlarca saniye
// beklemek kabul edilemez, "spawn 40 saniye sürüyor" diye geri gelirdi.
//
// Çözüm: spawn sorgusu SABİTTİR (ajanın kimliği + rolü + rol şablonu). Yani aynı
// vektör her spawn'da yeniden hesaplanacak bir şey değil, BİR KEZ hesaplanıp
// diske yazılacak bir şeydir. Bu modül o vektörü tutar:
//   • okuma SENKRON ve ucuz (tek dosya, ham Float32) → spawn yolunda kullanılabilir,
//   • yazma uygulamanın SICAK gömme sürecinden gelir (memorySearchService.warmQuery).
//
// 🔴 DÜRÜSTLÜK: önbellek YOKSA arama yine koşar — yalnız kelime katmanıyla. Yani
// ilk spawn tek katmanlı, sonraki spawn'lar TAM hibrittir. Çağıran bunu görebilsin
// diye `readVector` null döner ve retrieval katmanı `layers.vector=false` bildirir;
// hiçbir yerde "anlam katmanı koştu" diye yalan söylenmez.
//
// Biçim: ham Float32 little-endian (başlık YOK). Boyut = bayt/4. 1024 boyutlu
// bge-m3 vektörü = 4 KB. JSON'a göre ~5× küçük ve ayrıştırma maliyeti sıfır.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { indexDbPath } = require('./memoryIndexService.cjs');

/** Sorgu metninin dosya-adı anahtarı. Sorgu METNİ diske YAZILMAZ (hafızada sır olabilir). */
function queryKey(query) {
  return crypto.createHash('sha1').update(String(query || '')).digest('hex').slice(0, 16);
}

/**
 * Önbellek dosyasının yolu. İndeksin YANINDA yaşar (aynı instance, aynı workspace):
 * indeks silinince/instance değişince önbellek de doğal olarak geçersiz olur.
 */
// SMOKE-ISO-01 — varsayılan `undefined`: bkz. memoryIndexService.indexDbPath.
function vectorPath({ workspaceRoot, homedir = undefined, query }) {
  const db = indexDbPath({ workspaceRoot, homedir });
  return path.join(path.dirname(db), 'qvec', `${path.basename(db, '.db')}-${queryKey(query)}.f32`);
}

/**
 * Önbellekteki vektör. Yoksa/bozuksa null (çağıran kelime katmanıyla devam eder).
 * SENKRON — spawn yolunun tek şartı budur.
 * @returns {Float32Array|null}
 */
function readVector({ file }) {
  try {
    const buf = fs.readFileSync(file);
    if (!buf.length || buf.length % 4 !== 0) return null;
    // Buffer'ın byteOffset'i 4'e hizalı olmayabilir → KOPYALA (Float32Array aksi
    // hâlde RangeError atar; ölçüldü, alignment havuzun doluluğuna göre değişiyor).
    const out = new Float32Array(buf.length / 4);
    for (let i = 0; i < out.length; i += 1) out[i] = buf.readFloatLE(i * 4);
    return out;
  } catch {
    return null;
  }
}

/**
 * Vektörü yaz (atomik: tmp + rename — yarım dosya okunmasın).
 * @returns {boolean} yazılabildi mi
 */
function writeVector({ file, vec }) {
  try {
    if (!vec || !vec.length) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const buf = Buffer.alloc(vec.length * 4);
    for (let i = 0; i < vec.length; i += 1) buf.writeFloatLE(vec[i], i * 4);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

module.exports = { queryKey, vectorPath, readVector, writeVector };
