// CrewPane — ADP-871 (SPRINT-MEMORY-SEARCH · Faz 3) KELİME KATMANI (BM25/FTS5).
//
// NEDEN VAR: ADP-870'in vektör katmanı ANLAM yakalar ama "ADP-854", "memoryChunker.cjs",
// "bge-m3" gibi TAM TERİMLERİ yakalayamaz — gömme uzayında bir görev kodu komşusundan
// ayırt edilemez. ADP-869 ölçümü: BM25 tek başına recall@5 %46.7 (vektör %66.7'nin
// altında) ama BULDUKLARI FARKLI → hibritte değerli. Bu modül o katmanın çekirdeği.
//
// ── İKİ ÖLÇÜLMÜŞ KARAR ──────────────────────────────────────────────────────
//
// 1) TÜRKÇE İÇİN "5-HARF KÖK". ADP-869'da üç leksik varyant koşuldu; kazanan
//    (%46.7) jetonları ilk 5 karaktere kırpan varyanttı. Sebebi Türkçenin sondan
//    eklemeli olması: "terminal / terminalleri / terminallerini" BM25 için ÜÇ AYRI
//    kelimedir, kırpınca aynı kelime olur. O bulgu burada AYNEN kullanılıyor.
//
// 2) AMA YALNIZ KÖK YETMEZ — TAM TERİM DE İNDEKSLENİR. Kırpma tek başına
//    "memorychunker" → "memor" yapar ve `memoryChunker.cjs` sorgusu `memoryIndexer`
//    ile aynı kovaya düşer; oysa bu katmanın VAR OLMA SEBEBİ tam terim eşleşmesi.
//    Bu yüzden her jeton İKİ biçimde indekslenir: ham hâli + (5'ten uzunsa) kökü.
//    Kısa jetonlar (kod parçaları: "854", "adp", "q8") zaten ham gider.
//    ⚠ Bedeli var: doküman uzunluğu ~2× görünür ve IDF ona göre kayar — ikisi de
//    BM25 içinde tutarlı kaldığı için sıralamayı bozmaz, ölçüldü (ADP-871 raporu §4).
//
// 3) DOSYA ADI VE BAŞLIK YOLU BURAYA GİRER. memoryChunker.embedTextFor dosya adını
//    BİLEREK gömmeye koymuyor (ADP-870 §10.2: leksik sinyal Faz 3'ten gelecek).
//    İşte o söz burada tutuluyor — ad + başlık zinciri leksik metnin başına eklenir.
//    Vektör parmak izi DEĞİŞMEZ → 21 dakikalık yeniden gömme GEREKMEZ.
//
// DEPO: SQLite'ın GÖMÜLÜ FTS5'i (ölçüldü: `ENABLE_FTS5` derleme seçeneği Electron 42'nin
// node:sqlite'ında AÇIK). Yerli modül yok, yeni bağımlılık yok — ADP-870'in "yerli modül
// eklenmedi" kararı korunur. Analiz JS'te yapılır, FTS5'e ANALİZ EDİLMİŞ metin yazılır;
// böylece Türkçe kök kuralı SQLite tokenizer'ına bağlı kalmaz.

'use strict';

const { tokens } = require('../voice/turkishMorph.cjs');

/**
 * ANALİZ SÜRÜMÜ — bu dosyadaki kurallar (kırpma boyu, katlama, alan sırası) her
 * değiştiğinde ARTIR. Vektör tarafında parmak izi zaten var (memoryIndexStore
 * `fingerprintOf`); leksik tarafta olmasaydı analiz değişince eski jetonlarla dolu
 * FTS tablosu SESSİZCE kalırdı — sorgu yeni kuralla, indeks eski kuralla çalışır ve
 * arama hiçbir hata vermeden kötüleşirdi. Bu sabit ADP-871'de bir kez ölçülerek
 * öğrenildi: ASCII katlama eklendiğinde tablo kendiliğinden yenilenmedi.
 */
const LEX_VERSION = 3;

/** 5'ten uzun jetonlar bu boya kırpılır (ADP-869 kazananı). */
const STEM_LEN = 5;

/**
 * Metni BM25 jetonlarına çevir: her jetonun HAM hâli + (uzunsa) 5-harf kökü. Saf.
 *
 * 🪤 REDDEDİLEN FİKİR — ASCII KATLAMA (ölçüldü, ADP-871 §4c). Bir birim testi gerçek
 * bir tuzağı yakaladı: `trLower('memoryIndexer')` = **'memoryındexer'** (Türkçe
 * locale'de büyük `I` NOKTASIZ `ı`'ya iner), dolayısıyla kullanıcı düz ASCII
 * "memoryindexer" yazarsa tam-terim eşleşmesi kaçar. Bariz çözüm — katlanmış biçimi
 * de indekslemek ('ı'→'i', 'ş'→'s' …) — UYGULANDI ve ÖLÇÜLDÜ:
 *
 *     yalnız kelime  %50.0 → %43.3      ürün varsayılanı  %76.7 → %66.7
 *
 * BM25'i BOZUYOR: katlama ayırt edici nadir terimleri ("sık"/"sik", "açık"/"acık")
 * tek kovaya çökertiyor, jeton başına terim sayısını ikiye katlıyor ve IDF'in
 * dayandığı seyrekliği yok ediyor. Sezgi haklı görünüyordu, ölçüm çürüttü → ALINMADI.
 * Kalan risk kabul edildi: 5-harf kök katmanı ('memor') bu vakayı kısmen kurtarıyor.
 * Yeniden denenecekse doğru yer SORGU tarafında geri-çekilme olur (sonuç boşsa
 * katlanmış sorguyla bir kez daha dene) — indeks istatistiklerine dokunmaz.
 *
 * @returns {string[]}
 */
function analyze(text) {
  const out = [];
  for (const t of tokens(text)) {
    out.push(t);
    if (t.length > STEM_LEN) out.push(t.slice(0, STEM_LEN));
  }
  return out;
}

/**
 * Bir parçanın FTS5'e yazılacak metni. Saf.
 * Dosya adı ve başlık yolu ÖNE alınır (bkz. başlıktaki 3. karar).
 */
function lexTextFor({ name = '', headingPath = [], text = '' } = {}) {
  const head = Array.isArray(headingPath) ? headingPath.filter(Boolean).join(' ') : String(headingPath || '');
  return analyze(`${name} ${head} ${text}`).join(' ');
}

/**
 * Sorguyu FTS5 MATCH ifadesine çevir. Saf.
 * Jetonlar OR'lanır (AND olsaydı doğal dildeki tek bir alakasız kelime sonucu SIFIRLARDI —
 * BM25 zaten kaç terim tuttuğuna göre sıralıyor). Her jeton çift tırnakla kaçırılır:
 * FTS5 sözdizimi `-`, `*`, `:`, `^`, `(` gibi karakterleri operatör sayar ve sorgu
 * "malformed MATCH expression" ile ATAR — sorgu metni KULLANICIDAN geliyor.
 * @returns {string} boş string = aranacak jeton yok (çağıran arama YAPMAMALI)
 */
function ftsMatchQuery(queryText) {
  const uniq = [...new Set(analyze(queryText))];
  if (!uniq.length) return '';
  return uniq.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

module.exports = {
  LEX_VERSION,
  STEM_LEN,
  analyze,
  lexTextFor,
  ftsMatchQuery,
};
