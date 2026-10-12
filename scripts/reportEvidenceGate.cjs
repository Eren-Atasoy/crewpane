// REPORT-GATE-01 — RAPOR KANIT KAPISI. Saf (I/O yok), tek gerçek, iki tüketici.
//
// NEDEN. ENVANTER-B (22.09, `docs/agent-results/ENVANTER-B-inferno.md`) üç repodaki
// 3 764 raporu taradı: **188 rapor "bitti" diyor ama içinde tek satır kanıt yok** ve
// bunların **109'u kapalı bir kartın tek dayanağı**. Aynı gün iki kez daha aynı sınıf
// yaşandı: süpervizör raporun VARLIĞINA bakıp işi bitmiş saydı, oysa rapor yarım
// şablondu ve asıl hedef hiç olmamıştı. "Bitti" ucuz bir cümle; bu modül ona bir
// fiyat koyar.
//
// NE YAPAR — üç soruyu SAF olarak cevaplar ve hükmü NEDENİYLE döner:
//   1. Hükmün sınıfı nedir?           → `verdictClass`   (bitti · kısmen · başarısız · belirsiz)
//   2. Kanıt var mı, hangi türden?    → `evidenceKinds`  (komut çıktısı · test sayısı · kare · commit)
//   3. Rapor yarım şablon mu?         → `templateHoles`  ((doldurulacak) · TBD · boş bölüm başlığı)
// artı sözleşme v2'nin dört alanı (tip · görev · hüküm · platform) → `contractFields`.
//
// NE YAPMAZ. Hiçbir dosyaya DOKUNMAZ (fs import'u yoktur — kapı, üslup değil). Rapor
// metnini değiştirmez, silmez, taşımaz: yalnız SINIFLANDIRIR.
//
// KİM ÇAĞIRIR (iki yer, tek gerçek):
//   · `scripts/reportsIndexV2.cjs` (REPORTS-V2-A1) — indeks üretiminde her rapora `kapi`
//     alanı + reddedilenler için `kapi_red[]` defteri.
//   · `electron/delegationSupervisor.cjs` — tamamlanma tespitinde: dosya VAR ama kapıdan
//     geçmiyorsa iş `done` SAYILMAZ.
//
// DEVRALINDI, YENİDEN YAZILMADI:
//   · Hüküm cümlesi A1'in `extractVerdict`inden gelir (ikinci bir çıkarıcı yok).
//   · Hüküm SINIFLANDIRMASI ve dört kanıt kategorisi ENVANTER-B'nin ölçülmüş
//     tanımlarıdır (o tarama scratchpad'de kalmıştı; buraya ÜRÜN KODU olarak alındı ki
//     "188" sayısı bir daha yeniden icat edilmesin). Kalibrasyonu ve bilinen hata payı
//     ENVANTER-B §8'de: hüküm sınıflandırıcısı 8/10, kanıt puanı 10/10.
//
// ÜÇ TUZAK — hepsi ölçülmüş, hepsi burada kapalı:
//   (a) TÜRKÇE KELİME SINIRI. `/\btamamlandı\b/` HİÇBİR ZAMAN eşleşmez: `ı` bir `\w`
//       karakteri değildir, sondaki `\b` düşer. `başarısız` (b…z) ise eşleşir → "bitti"
//       dedektörü körken "başarısız" dedektörü çalışır ve dağılım %84 `belirsiz` çıkar.
//       Çözüm: Unicode lookaround (`W` yardımcısı). Kontrol testi: `W('tamamlandı')`.
//   (b) KAPI KENDİ İÇERİĞİNİ YEMESİN. Bu kapının RAPORU, ret sebeplerini metin olarak
//       yazmak zorundadır (`(doldurulacak)`, `TBD`). Şablon deliği araması bu yüzden
//       KOD BLOKLARINI VE SATIR-İÇİ KODU ÖNCE SÖKER: bir işaret ancak DÜZ metinde
//       geçerse delik sayılır. (Genel kural: `ui-copy-gate-must-exclude-the-content-it-shows`.)
//   (c) BOŞ BAŞLIK ≠ İÇ BAŞLIK. `## 1. Ne yapıldı` hemen ardından `### 1.1 …` gelmesi
//       BOŞ DEĞİLDİR. Bir başlık ancak kendisinden sonraki ilk dolu satır AYNI ya da
//       DAHA SIĞ seviyede bir başlıksa (veya dosya bitmişse) boştur.

'use strict';

// RPT4-12 — hüküm AÇILIŞ sözlüğü tek yerde durur (yazım aracı ile kapı aynı kelimeye
// bakar). Saf modüldür (fs yok); paketlenmiş uygulamada `Resources/electron/` altına
// extraResources ile kopyalanır (electron/package.json — reportAgentId.cjs'in aynı yolu).
const { verdictOpening } = require('../electron/reportSchema.cjs');

/**
 * Unicode-duyarlı kelime sınırı. `\b` Türkçe harflerde sessizce düşer (tuzak (a)).
 * @param {string} w regex gövdesi (alternasyon içerebilir)
 */
const W = (w) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${w})(?![\\p{L}\\p{N}])`, 'iu');

// ─── hüküm sözlükleri (ENVANTER-B'den devralındı) ────────────────────────────

const FAIL = [
  'başarısız', 'başarısızdı', 'FAIL', 'FAILED', 'çalışmıyor', 'yapılamadı', 'engellendi',
  'bloke', 'bloke oldu', 'iptal edildi', 'reddedildi', 'koşulamadı', 'tamamlanamadı',
  'doğrulanamadı', 'çözülemedi', 'vazgeçildi', 'kırmızı kaldı', 'üretilemedi', 'kurulamadı',
  'başaramadım', 'hata verdi', 'patladı', 'geri alındı', 'revert edildi',
].map(W);

const PARTIAL = [
  'kısmen', 'kısmi', 'yarım kaldı', 'ertelendi', 'eksik kaldı', 'açık kaldı', 'kalan iş',
  'tamamlanmadı', 'bir kısmı', 'ikinci faza', 'ayrı karta', 'devam ediyor', 'in_progress',
  'henüz ölçülmedi', 'ölçülmedi', 'ölçülemedi', 'TODO kaldı', 'yarıda', 'askıda', 'beklemede',
].map(W);

const DONE = [
  'tamamlandı', 'tamamlandi', 'TAMAM', 'bitti', 'DONE', 'PASS', 'PASSED', 'geçti', 'yeşil',
  'doğrulandı', 'çalışıyor', 'kuruldu', 'eklendi', 'düzeltildi', 'merge edildi', 'kapatıldı',
  'teslim edildi', 'sevk edildi', 'yayınlandı', 'çözüldü', 'kaldırıldı', 'uygulandı',
  'güncellendi', 'sağlandı', 'başarılı', 'hazır', 'canlıda', 'yeşile döndü', 'oldu',
].map(W);

/** Beyan edilmiş hüküm GÜÇLÜ kaynaktır; `ilk-paragraf` bir TAHMİNDİR. */
const GUCLU_KAYNAK = /^(beyan|ön-bilgi)/;

/**
 * Hüküm cümlesinin AÇILIŞI belirleyicidir: "✅ tamamlandı — …(dev)" bir BİTTİ hükmüdür;
 * ardından gelen kapsam notu onu kısmen YAPMAZ. Yalnız SERT arıza belirteci aşağı çeker.
 */
const ACILIS_BITTI = /^[\s✅🟢☑️✔️*_>#·-]*(?:durum\s*:\s*)?[\s✅🟢✔️*_]*(tamamland[ıi]|TAMAM|bitti|done|başarıyla|çözüldü|kapatıldı|teslim edildi|geçti|PASS|yeşil|canlıda|yayınlandı)/iu;

const SERT_ARIZA = [
  'GATE FAIL', 'FAIL', 'FAILED', 'başarısız', 'çalışmıyor', 'tamamlanamadı', 'doğrulanamadı',
  'koşulamadı', 'yapılamadı', 'kurulamadı', 'üretilemedi', 'patladı', 'kırmızı',
].map(W);
const SERT_ARIZA_ISARET = /🔴|✗|❌/;

/** Başlık/meta bölgesindeki "iş bitti AMA X yapılmadı" durdurucuları. */
const DURDURUCU = [
  'YAPILMADI', 'yayınlanmadı', 'yayinlanmadi', 'BEKLİYOR', 'bekliyor',
  'TEST YAPILIYOR', 'onay bekliyor', 'koşulamadı', 'açık madde', 'madde EKSİK',
  'yarım kaldı', 'tamamlanmadı', 'uygulanmadı', 'gönderilmedi', 'merge edilmedi',
].map(W);
const SERT_DURDURUCU = ['koşulamadı', 'tamamlanamadı', 'doğrulanamadı', 'çalışmıyor'].map(W);

/**
 * DAR bölge: yalnız H1 başlığı + AÇIK durum satırları (ilk 30 satır). Tablo satırı
 * BİLEREK dışarıda — "bitti" raporları başlıkta sorun TABLOSU taşır ve durdurucu
 * kelimeler oradan sahte çelişki üretir (ENVANTER-B tier-A örneklemesi: 6'da 5 yanlış).
 * Pure.
 */
function basligVeMeta(md) {
  const lines = String(md || '').split('\n').slice(0, 30);
  const out = [];
  for (const l of lines) {
    if (/^\s*\|/.test(l)) continue;
    if (/^#\s+/.test(l)) { out.push(l); continue; }
    if (/(\*\*)?\s*(Durum|Sonuç|Hüküm|Status|Sonuc|Hukum)\s*(\*\*)?\s*:/i.test(l)) out.push(l);
  }
  return out.join('\n');
}

/**
 * Baştaki `---` ön-bilgi bloğundan YALNIZ platform satırını söker (yalnız sınıflama
 * içindir; gövde ve diğer alanlar olduğu gibi kalır). Pure.
 */
function withoutPlatformLine(md) {
  const s = String(md || '');
  const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?=\r?\n|$)/.exec(s);
  if (!m) return s;
  const fm = m[1].split(/\r?\n/).filter((l) => !/^\s*(platform|platforms|platform kapsamı|platform kapsami)\s*:/i.test(l));
  return `---\n${fm.join('\n')}\n---${s.slice(m[0].length)}`;
}

/**
 * Hükmün sınıfı. `hukum`/`hukumKaynak` A1'in `extractVerdict`inden gelir (çağıran verir —
 * bu modül A1'i import ETMEZ ki A1 de bunu import edebilsin: döngüsel bağımlılık yok).
 * @returns {{sinif:'bitti'|'kısmen'|'başarısız'|'belirsiz', kaynak:string, guven:string}}
 * Pure.
 */
function verdictClass(md, hukum, hukumKaynak) {
  const guclu = GUCLU_KAYNAK.test(String(hukumKaynak || ''));
  // RPT4-12 — ön-bilgideki PLATFORM satırı gövde taramasına GİRMEZ: sözleşmenin istediği
  // "Windows koşulamadı" beyanı FAIL sözlüğüne düşüp açılış kelimesiz her hükmü
  // "başarısız" gösteriyordu (shared hafıza report-verdict-needs-opening-keyword). Ön-bilginin
  // GERİ KALANI kalır: `status: done` gerçek bir sinyaldir (ölçüldü — tüm bloğu sökmek
  // 3 916 raporun 19'unda 'bitti'yi 'belirsiz'e düşürüyordu).
  const govde = withoutPlatformLine(md).slice(0, 2500);
  const bas = basligVeMeta(md);
  const h = String(hukum || '');
  const siniftan = (src) => {
    if (!src || !src.trim()) return null;
    if (FAIL.some((re) => re.test(src))) return 'başarısız';
    if (PARTIAL.some((re) => re.test(src))) return 'kısmen';
    if (DONE.some((re) => re.test(src))) return 'bitti';
    return null;
  };
  const sertArizaVar = (src) => SERT_ARIZA.some((re) => re.test(src)) || SERT_ARIZA_ISARET.test(src);

  // RPT4-12 — v3 AÇILIŞ KELİMESİ OTORİTEDİR ("Bitti:", "Kısmen bitti:", "Başarısız:" ve
  // İngilizce "Done:", "Partial:", "Failed:"). Eskiden FAIL sözlüğü açılıştan ÖNCE
  // bakıyordu: "Kısmen bitti: … Windows koşulamadı." 'başarısız' çıkıyordu (RPT4-01 §4.1).
  // Yazar sınıfı kelimeyle SÖYLEDİ; kapı onu yeniden tahmin etmez.
  // ⟦kural:açılış-otorite⟧
  const acilis = h.trim() ? verdictOpening(h) : null;
  if (acilis) return { sinif: acilis.sinif, kaynak: 'açılış', guven: 'yüksek' };
  // ⟦/kural⟧

  if (h.trim() && ACILIS_BITTI.test(h)) {
    if (sertArizaVar(h)) return { sinif: 'kısmen', kaynak: 'beyan-açılış+sert-arıza', guven: 'yüksek' };
    return { sinif: 'bitti', kaynak: 'beyan-açılış', guven: guclu ? 'yüksek' : 'orta' };
  }
  let sinif = null, kaynak = null, guven = null;
  if (guclu) { const s = siniftan(h); if (s) { sinif = s; kaynak = 'beyan-hüküm'; guven = 'yüksek'; } }
  if (SERT_DURDURUCU.some((re) => re.test(bas))) {
    const bittiSinyali = DONE.some((re) => re.test(bas));
    if (sinif !== 'başarısız') {
      sinif = bittiSinyali ? 'kısmen' : (sinif === null ? 'başarısız' : 'kısmen');
      kaynak = 'başlık-durdurucu(sert)'; guven = 'yüksek';
    }
  } else if (DURDURUCU.some((re) => re.test(bas)) && sinif !== 'başarısız') {
    sinif = 'kısmen'; kaynak = 'başlık-durdurucu'; guven = guven || 'orta';
  }
  if (sinif) return { sinif, kaynak, guven };
  const t = siniftan(h);
  if (t) return { sinif: t, kaynak: 'tahmin-hüküm', guven: 'orta' };
  const g = siniftan(govde);
  if (g) return { sinif: g, kaynak: 'gövde', guven: 'düşük' };
  return { sinif: 'belirsiz', kaynak: 'yok', guven: 'yok' };
}

// ─── kanıt (dört kategori) ───────────────────────────────────────────────────

/** Sözleşmenin saydığı dört KOPYALANMIŞ kanıt türü. Sıra sabittir (rapor tabloları). */
const EVIDENCE_KINDS = Object.freeze(['komut_ciktisi', 'test_sayisi', 'kare_yolu', 'commit']);

const FENCE = /```[\s\S]*?```/g;
const OUTPUT_MARK = /(^|\n)\s*(\$|>|#)\s*\S|✓|✔|✗|✖|×|\bPASS\b|\bFAIL\b|\bok\b\s*\d|passing|failing|\bexit\s+\d|error|Error:|npm (run|test)|node |git |curl |tsc\b|eslint\b|\d+\s*\/\s*\d+/i;

// DLG-SMOKE-P2-0310 (REPORT-GATE-CMD) — `$ ` öneksiz kabuk bloğu: komut satırı + en az bir çıktı
// satırı. Codex `echo X` + çıktısını öneksiz yazdı, kapı "kanıtsız-bitti" dedi (DLG-SMOKE-REAL-01
// bulgu 8). Blok kabuk diliyle işaretliyse ilk satır komuttur; dilsizse ilk satır bilinen bir
// komutla başlamalı (düz not kanıt sayılmasın). Çıktısız tek komut kanıt DEĞİLDİR.
const SHELL_LANG = /^(?:bash|sh|zsh|fish|shell|console|terminal|shell-session|powershell|pwsh|ps1?|cmd|bat)$/i;
const KNOWN_CMD = /^(?:echo|printf|ls|cat|head|tail|grep|rg|find|wc|pwd|cd|python3?|pip3?|node|npm|npx|pnpm|yarn|bun|deno|git|gh|curl|wget|tsc|eslint|make|cargo|go|pytest|jest|vitest|docker|kubectl|sqlite3|psql|jq|sed|awk|diff|du|df|ps|which|uname|date|test|bash|sh|zsh|Get-[A-Za-z]+|dir|type)\b/;

function shellBlockWithOutput(block) {
  const m = /^```[ \t]*([^\n`]*)\n([\s\S]*?)\n?```$/.exec(block);
  if (!m) return false;
  const lang = m[1].trim().split(/\s+/)[0] || '';
  if (lang && !SHELL_LANG.test(lang)) return false;
  const lines = m[2].split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  return lang ? true : KNOWN_CMD.test(lines[0]);
}

/**
 * Hangi kanıt türleri VAR? Puan = bulunan tür sayısı (0-3'te tavanlanır — ENVANTER-B
 * ile aynı ölçek, sayılar yan yana konabilsin diye). Pure.
 * @returns {{puan:number, bulunan:string[], eksik:string[]}}
 */
function evidenceKinds(md) {
  const text = String(md || '');
  const kat = {};
  // 1) kopyalanmış komut çıktısı: çıktı-benzeri işaret taşıyan kod bloğu
  const fences = text.match(FENCE) || [];
  kat.komut_ciktisi = fences.some((b) => OUTPUT_MARK.test(b.replace(/^```.*\n/, '')) || shellBlockWithOutput(b));
  // 2) test sayısı ("14/14", "26 test", "tests: 213")
  //
  // ⚠ DEVRALINAN TANIMDAKİ BOŞLUK — ÖLÇÜLDÜ VE KAPATILDI. ENVANTER-B'nin deseni sayıyı
  // yalnız kelimeden ÖNCE arıyordu; oysa bu deponun en yaygın test çıktısı `node --test`
  // TAP özetidir ve sayı kelimeden SONRA gelir (`# tests 12` · `# pass 12`). Yani
  // ENVANTER-B `test_sayisi` kategorisini sistematik olarak EKSİK saydı. Geriye dönük
  // koşumda bu farkın etkisi AYRI ölçülmüştür (rapor §"sapma"): pratikte küçüktür, çünkü
  // TAP özeti neredeyse her zaman bir kod bloğunun içindedir ve o blok zaten
  // `komut_ciktisi` sayılır — ama tanımın kendisi yanlıştı ve burada düzeltildi.
  kat.test_sayisi = /\b\d+\s*\/\s*\d+\b|\b\d+\s+(test|tests|spec|specs|passing|geçti|assertion)/i.test(text)
    || /\btests?\s*[:=]\s*\d+/i.test(text)
    || /(^|\n)\s*[#ℹ]\s*(tests?|pass|fail|suites|skipped|todo)\s+\d+/i.test(text);
  // 3) kare / görsel yolu
  kat.kare_yolu = /\.(png|jpe?g|webp|gif)\b/i.test(text) || /screenshots?\//i.test(text);
  // 4) commit hash'i — yalnız git bağlamıyla birlikte (rastgele hex sayılmasın)
  kat.commit = /\b[0-9a-f]{7,40}\b/.test(text)
    && /(commit|merge|HEAD|git (log|show|rev-parse|commit))/i.test(text);
  const bulunan = EVIDENCE_KINDS.filter((k) => kat[k]);
  const eksik = EVIDENCE_KINDS.filter((k) => !kat[k]);
  return { puan: Math.min(3, bulunan.length), bulunan, eksik };
}

// ─── yarım şablon ────────────────────────────────────────────────────────────

/**
 * Metni DÜZ hâle indir: kod blokları ve satır-içi kod SÖKÜLÜR (tuzak (b)). Bir şablon
 * işareti ancak düz metinde geçerse delik sayılır — aksi hâlde bu kapının kendi raporu
 * kendi kapısından geçemezdi. Pure.
 */
function stripCode(md) {
  return String(md || '')
    .replace(FENCE, (b) => '\n'.repeat((b.match(/\n/g) || []).length)) // satır sayısı korunur
    .replace(/`[^`\n]*`/g, '');
}

/**
 * Şablon yer-tutucu işaretleri (düz metinde) — DAR tutuldu ve bu ölçülmüştür.
 *
 * İlk sürüm `placeholder` / `buraya` / `burada` kelimelerini de sayıyordu ve 1 965
 * raporda 30 yanlış-pozitif üretti: bu depoda `placeholder` bir KONU kelimesidir
 * ("Maestro(placeholder) reactive waveform", "placeholder/stok 0"). A1'in `rehber`
 * kelimesiyle yaşadığı tuzağın aynısı — ürünün kendi sözlüğü kapının sözlüğüyle
 * çakışıyor. Geriye yalnız hiçbir konuda geçmeyen, SADECE şablondan kalan jetonlar
 * bırakıldı.
 */
const HOLE_MARKS = [
  { tur: 'doldurulacak', re: /[([<]\s*doldurulacak[^)\]>]*[)\]>]|\bdoldurulacak\b/iu },
  { tur: 'TBD', re: /(?<![\p{L}\p{N}])TBD(?![\p{L}\p{N}])/u },
  { tur: 'yer-tutucu', re: /[([<]\s*(xxx+|lorem ipsum|to ?be ?filled|tamamlanacak)\s*[)\]>]/iu },
];

/**
 * Raporun ALTI ZORUNLU bölümü (protokol). Bir bölüm başlığı bunlardan biriyse ve İÇİ
 * BOŞSA bu "yarım şablon"dur — sözleşmenin kendi istediği bölüm doldurulmamış demektir.
 * Başka bir başlığın boş kalması bilgi taşıyabilir ("### 🟥 Blocker — YOK") ve SERT
 * sayılmaz; ölçüldü, 58 boş başlığın çoğu bu sınıftı.
 */
const ZORUNLU_BOLUM = /^#{1,6}\s*\d*[.)]?\s*\**\s*(ne yapıldı|what was done|kanıt|kanit|evidence|değişen dosyalar|degisen dosyalar|changed files|riskler|risks|açık sorular|acik sorular|open questions|sonraki adım|sonraki adim|next step)/i;

/**
 * Satır satır "bu satır bir kod bloğunun İÇİNDE mi" haritası. Boş-başlık ölçümü ham
 * metinde koşar (aşağıdaki gerekçe) ama bir kod bloğunun içindeki `# yorum` satırı
 * başlık DEĞİLDİR; bu harita ikisini ayırır. Pure.
 */
function fenceMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let open = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { mask[i] = true; open = !open; continue; }
    mask[i] = open;
  }
  return mask;
}

/**
 * Yarım şablon izleri. İki sınıf, İKİ FARKLI METİN ÜZERİNDE — ve bu ayrım ölçülmüştür:
 *
 *   (1) AÇIK YER-TUTUCU (`(doldurulacak)`, `TBD`, `(buraya …)`) → DÜZ metinde aranır
 *       (`stripCode`), çünkü bu kapının kendi raporu ret sebeplerini metin olarak
 *       yazmak zorundadır (tuzak (b)).
 *   (2) BOŞ BÖLÜM BAŞLIĞI → HAM metinde ölçülür. İlk sürüm bunu da düz metinde ölçtü ve
 *       1 965 raporda 1 192 "boş başlık" saydı: `stripCode` kod bloğunu söktüğü için
 *       `### Kanıt` + kod bloğu deseni BOŞ görünüyordu — yani kapı EN GÜÇLÜ kanıtı
 *       delik sayıyordu. Kod bloğu İÇERİKTİR; yalnız içindeki `#` satırı başlık değildir.
 *
 * Boş başlık tanımı (tuzak (c)): başlıktan sonraki ilk DOLU satır aynı ya da daha SIĞ
 * seviyede bir başlıksa — veya dosya bitmişse — o başlık boştur. `---` yatay çizgisi ve
 * ön-bilgi kapanışı içerik SAYILMAZ. Pure.
 * @returns {{tur:string, satir:number, alinti:string}[]}
 */
function templateHoles(md) {
  const out = [];
  // (1) yer-tutucu — DÜZ metin
  const plain = stripCode(md).split('\n');
  for (let i = 0; i < plain.length; i++) {
    for (const m of HOLE_MARKS) {
      if (m.re.test(plain[i])) {
        out.push({ tur: m.tur, agirlik: 'sert', satir: i + 1, alinti: plain[i].trim().slice(0, 160) });
        break;
      }
    }
  }
  // (2) boş başlık — HAM metin, kod bloğu içerik sayılır
  const lines = String(md || '').split('\n');
  const inFence = fenceMask(lines);
  const headingAt = (i) => {
    if (inFence[i]) return 0;
    const h = /^(#{1,6})\s+\S/.exec(lines[i]);
    return h ? h[1].length : 0;
  };
  const bosSatir = (i) => !lines[i].trim() || /^\s*-{3,}\s*$/.test(lines[i]);
  for (let i = 0; i < lines.length; i++) {
    const lvl = headingAt(i);
    if (!lvl) continue;
    let j = i + 1;
    while (j < lines.length && bosSatir(j)) j++;
    const nextLvl = j < lines.length ? headingAt(j) : 0;
    const bos = j >= lines.length || (nextLvl > 0 && nextLvl <= lvl);
    if (!bos) continue;
    // SERT yalnız sözleşmenin ZORUNLU bölümlerinde: boş bir "## Kanıt" yarım şablondur,
    // boş bir "### 🟥 Blocker — YOK" ise CEVABIN KENDİSİDİR (ölçüldü: 58 boş başlığın
    // çoğu ikinci sınıf). Yumuşak olanlar yine SAYILIR ve kendi kovasında görünür.
    // Başlığın KENDİSİ cevabı taşıyorsa ("## 5. Açık sorular — yok.") bölüm boş değil,
    // CEVAPLANMIŞTIR: etiketten sonra kelime varsa SERT sayılmaz.
    const zm = ZORUNLU_BOLUM.exec(lines[i]);
    const kuyruk = zm ? lines[i].slice(zm[0].length).replace(/[\s*_:#·—–-]/g, '') : '';
    const zorunlu = Boolean(zm) && kuyruk.length < 2;
    out.push({
      tur: zorunlu ? 'boş-zorunlu-bölüm' : 'boş-başlık',
      agirlik: zorunlu ? 'sert' : 'yumuşak',
      satir: i + 1,
      alinti: lines[i].trim().slice(0, 160),
    });
  }
  return out.sort((a, b) => a.satir - b.satir);
}

// ─── sözleşme v2'nin dört alanı ──────────────────────────────────────────────

/**
 * Dört alanın BEYAN durumu. Değerleri çağıran (A1) verir; bu fonksiyon yalnız
 * "beyan edilmiş mi" sorusunu cevaplar — beyanın DOĞRULUĞUNU değil. Pure.
 * @param {{tip?:string, tipKaynak?:string, gorevSayisi?:number, hukum?:string|null, platform?:string|null}} f
 */
function contractFields(f) {
  const v = f || {};
  return {
    tip: Boolean(v.tip) && v.tip !== 'diğer',
    gorev: Number(v.gorevSayisi || 0) > 0,
    hukum: Boolean(v.hukum),
    platform: Boolean(v.platform),
  };
}

// ─── REL-EVIDENCE-STAMP-01 — kabul/e2e raporunun kanıt damgası ─────────────────
//
// NEDEN. 0.3.0 yolunda birden çok kabul turu bayat arayüzle koştu: worktree'ye ana
// ağacın 12 günlük `.next`'i kopyalanmıştı, pencere `v0.3.0-dev.24 · 9a24a078` (17.09)
// diyordu ve kimse bakmadı (Murat: "Eski versiyonu test ediyorsun resmen"; shared hafıza
// `worker-e2e-stale-renderer-copy`, REL-PROCESS-AUDIT-01 §4). Damga ÜÇ satırdır ve üçü de
// koşulan şeyi KANITLAR, iddia etmez:
//   · BUILD_ID      — `.next/BUILD_ID` değeri (arayüz derlemesinin kimliği)
//   · başlık commit'i — pencere başlığı/ekran damgasındaki commit (arayüz HANGİ uçtan)
//   · sürüm satırı  — koşulan sürüm (`0.3.4-dev.2`)
// Kapı DOĞRULUĞU ölçmez (rapor metninden ucu bilemez); damgasız rapor ise artık geçmez,
// ve damgayı yazmak için ajan ona BAKMAK zorundadır — tuzağı yakalayan şey o bakıştır.

/** Hangi raporlar kabul/e2e sayılır: beyan (ön-bilgi), dosya adındaki kod, H1 başlığı. */
const KABUL_DEGER = /^(kabul|kabul[ -]testi|kabul[ -]turu|e2e|acceptance|acceptance[ -]test)$/i;
const KABUL_ALAN = /^\s*(tip|type|tür|tur|koşum|kosum|run)\s*:\s*(.+?)\s*$/i;
const KABUL_KOD = /(?:^|[-_.])(E2E|KABUL|ACCEPT|ACCEPTANCE)(?=$|[-_.\d])/i;
// Başlıkta TEK BAŞINA `e2e` YETMEZ — ölçüldü (3 137 rapor): "e2e derlemesi kaynak haritası
// yüklemez", "docs/, scripts/, e2e/ taramasından çıkarıldı", "ghost e2e hafıza" gibi başlıklar
// koşum değil konu adıdır. Kart kodundaki `E2E` ise koşum işidir (dosya-adı kolu).
const KABUL_BASLIK = W('kabul testi|kabul turu|kabul koşumu|kabul koşusu|kabul e2e|e2e kabul|e2e turu|e2e koşumu|acceptance test|acceptance run');

/** Ön-bilgi bloğunun satırları (yoksa boş). Pure. */
function frontmatterLines(md) {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?=\r?\n|$)/.exec(String(md || ''));
  return m ? m[1].split(/\r?\n/) : [];
}

/**
 * Rapor kabul/e2e raporu mu? Yanıt NEDENİYLE döner (hangi işaret). Pure.
 * @returns {{kabul:boolean, kaynak:string|null}}
 */
function acceptanceKind(md, filename) {
  for (const l of frontmatterLines(md)) {
    const m = KABUL_ALAN.exec(l);
    if (m && KABUL_DEGER.test(m[2].replace(/^["'`]|["'`]$/g, ''))) return { kabul: true, kaynak: `beyan:${m[1].toLowerCase()}` };
  }
  const base = String(filename || '').split(/[\\/]/).pop().replace(/\.(md|html?)$/i, '');
  if (base && KABUL_KOD.test(base)) return { kabul: true, kaynak: 'dosya-adı' };
  const h1 = String(md || '').split('\n').find((l) => /^#\s+\S/.test(l));
  if (h1 && KABUL_BASLIK.test(h1)) return { kabul: true, kaynak: 'başlık' };
  return { kabul: false, kaynak: null };
}

/** Damganın üç satırı. Sıra sabittir (nedenler ve rapor tabloları). */
const DAMGA_ALANLARI = Object.freeze(['build_id', 'baslik_commit', 'surum']);

// Değer, yer-tutucu olmayan bir jeton olmalı: `<BUILD_ID>`, `xxxxxxxx`, `…` sayılmaz.
// Next'in BUILD_ID'si nanoid'dir (büyük/küçük harf + rakam karışık); tamamı küçük harfli
// tek kelime ("standalone", "tarihi") değer değildir.
const DEGER = /[A-Za-z0-9_-]{8,64}/g;
const degerMi = (tok) => /[A-Z0-9]/.test(tok) && !/^(x+|X+|0+)$/.test(tok);
const HEX = /(?<![0-9a-zA-Z])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![0-9a-zA-Z])/;
const SURUM = /v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/;
/** Ekrandaki damganın kendisi: `v0.3.0-dev.24 · 9a24a078` (sürüm + commit tek satırda). */
const EKRAN_DAMGASI = new RegExp(`${SURUM.source}\\s*[·•|/@-]\\s*\`?${HEX.source}`);
const BASLIK_ETIKET = /pencere|başlık çubu|baslik cubu|başlıkta|başlıktaki|başlık commit|baslik commit|üst çubu|ust cubu|window title|title ?bar|ekran damga/i;
const SURUM_SATIRI = new RegExp(`(?<![\\p{L}\\p{N}_])(sürüm|surum|version|versiyon)[^\\n]{0,40}?${SURUM.source}`, 'iu');

/**
 * Damga satırları var mı? Kod blokları DAHİL aranır: damga çoğu kez bir komut
 * çıktısıdır (`cat .next/BUILD_ID`). Pure.
 * @returns {{bulunan:string[], eksik:string[]}}
 */
function stampFields(text) {
  const s = String(text || '');
  const lines = s.split('\n');
  const f = {};
  // 1) BUILD_ID: etiket + aynı satırda ya da hemen sonraki dolu satırda değer.
  f.build_id = lines.some((l, i) => {
    const m = /BUILD_ID|build[ _-]?id/i.exec(l);
    if (!m) return false;
    const next = lines.slice(i + 1).find((x) => x.trim()) || '';
    // `<…>` yer-tutucusu ve etiketin kendisi değer değildir (`BUILD_ID: <BUILD_ID>`).
    const kuyruk = (l.slice(m.index + m[0].length) + '\n' + next)
      .replace(/<[^>\n]*>/g, ' ')
      .replace(/BUILD_ID|build[ _-]?id/gi, ' ');
    return (kuyruk.match(DEGER) || []).some(degerMi);
  });
  // 2) başlık commit'i: pencere başlığı / üst çubuk / ekran damgası etiketli satırda commit,
  //    ya da ekran damgasının kendisi. Çıplak "title" SAYILMAZ (ölçüldü: "ipucu (title)
  //    satırına eklendi" bir UI metni cümlesidir).
  f.baslik_commit = EKRAN_DAMGASI.test(s)
    || lines.some((l) => BASLIK_ETIKET.test(l) && HEX.test(l));
  // 3) sürüm satırı: sürüm etiketi + sayı, ya da ekran damgasındaki sürüm. Etiketin solu
  //    kelime sınırıdır: `lastLaunchedVersion="0.3.3-dev.6"` bir ayar değeridir, damga değil.
  f.surum = EKRAN_DAMGASI.test(s) || SURUM_SATIRI.test(s);
  return {
    bulunan: DAMGA_ALANLARI.filter((k) => f[k]),
    eksik: DAMGA_ALANLARI.filter((k) => !f[k]),
  };
}

/**
 * Kabul/e2e raporunun damgası. Kabul raporu değilse `eksik` boş döner (kural uygulanmaz).
 * @returns {{kabul:boolean, kaynak:string|null, bulunan:string[], eksik:string[]}}
 * Pure.
 */
function acceptanceStamp(text, filename, md) {
  const k = acceptanceKind(md === undefined ? text : md, filename);
  if (!k.kabul) return { kabul: false, kaynak: null, bulunan: [], eksik: [] };
  return { ...k, ...stampFields(text) };
}

/** Kuralın kendi anahtarı (kontrol kolu ve acil durum). */
function stampRuleEnabled(env) {
  const e = (env || process.env || {});
  const v = String(e.AGENTSPACE_REPORT_STAMP_GATE ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'kapalı' || v === 'kapali');
}

// ─── KAPI ────────────────────────────────────────────────────────────────────

/** Ret kovaları — ağırdan hafife. `tam` = geçti. */
const KOVALAR = Object.freeze(['tam', 'yarım-şablon', 'hükümsüz', 'kanıtsız-bitti', 'damgasız-kabul', 'kanıtsız-hüküm', 'boş-bölüm', 'sözleşme-eksik']);

/** Raporu `done` saymayı ENGELLEYEN kovalar (süpervizör bunlara bakar). */
const BLOKE_KOVALAR = Object.freeze(['yarım-şablon', 'hükümsüz', 'kanıtsız-bitti', 'damgasız-kabul']);

// ─── RPT4-12 — hüküm zorunluluğu (yalnız YAZIM yolu) ───────────────────────────

/**
 * Hüküm BEYAN edilmiş mi? Yalnız iki kaynak beyandır: ön-bilgideki `hüküm:`/`verdict:`
 * alanı ve gövdedeki açık `Hüküm:` etiketi. A1'in `ilk-paragraf` tahmini, `özet:` ya da
 * `durum:` satırı hüküm DEĞİLDİR (Murat kararı K2, 23.09: "hüküm satırı zorunlu"). Pure.
 */
const HUKUM_BEYAN_KAYNAK = /^(ön-bilgi|beyan:(tek cümlelik hüküm|hüküm|hukum))$/;
function verdictDeclared(hukum, hukumKaynak) {
  return Boolean(String(hukum || '').trim()) && HUKUM_BEYAN_KAYNAK.test(String(hukumKaynak || ''));
}

/**
 * Raporun dili — ajana gidecek cümle bu dilde yazılır (ajan kullanıcının dilinde
 * raporluyor). Sıra yazım aracıyla (reportTools.pickLang) aynı: açılış kelimesinin dili,
 * yoksa Türkçe harf, yoksa İngilizce. Pure.
 */
function reportLang(md, hukum) {
  const op = verdictOpening(hukum);
  if (op) return op.dil;
  const s = String(md || '');
  if (/[çğıöşüÇĞİÖŞÜ]/.test(s)) return 'tr';
  return /[A-Za-z]{3}/.test(s) ? 'en' : 'tr';
}

/**
 * Hükümsüz raporda ajana gidecek TEK cümle: ne yazacağını ve nereye yazacağını söyler,
 * iç mekanizma adı taşımaz. Pure.
 * @param {'tr'|'en'} dil
 * @param {string} [dosya] rapor dosyasının adı (yol değil)
 */
function verdictNudge(dil, dosya) {
  const f = String(dosya || '').split(/[\\/]/).pop();
  if (dil === 'en') {
    return `Your report${f ? ` (${f})` : ''} is not accepted yet because it has no verdict line: add \`verdict: Done: <what you measured>\` (or \`Partial:\` / \`Failed:\`) to the \`---\` block at the top of the file.`;
  }
  return `Raporun${f ? ` (${f})` : ''} henüz kabul edilmedi çünkü hüküm satırı yok: dosyanın başındaki \`---\` bloğuna \`hüküm: Bitti: <ne ölçtüğün>\` satırını (ya da \`Kısmen bitti:\` / \`Başarısız:\`) ekle.`;
}

/**
 * KAPI. Tek girdi, tek hüküm, NEDENİYLE.
 *
 * KARAR — neden sözleşme eksiği BLOKE ETMEZ. Kart dört alanı ZORUNLU kılıyor ve bu modül
 * onları ölçüyor; ama ölçüm şunu söylüyor: platform beyanı üç repoda %7,6 (ENVANTER-B §2).
 * Bloke eden bir kural bugün raporların ~%92'sini reddederdi, ilk haftada kapatılırdı ve
 * geriye HİÇBİR kapı kalmazdı (`live_counter_gate_not_equality`in aynı dersi). Bu yüzden
 * kapı İKİ KADEMELİDİR ve ikisi de SESSİZ DEĞİLDİR:
 *   · BLOKE (kırmızı): yarım şablon · "bitti" deyip sıfır kanıt  → iş `done` sayılmaz
 *   · KAYIT (sarı):    sözleşme alanı eksik · kanıtsız (bitti olmayan) hüküm → sayılır,
 *                      kendi kovasında listelenir, ekranda görünür, ama işi durdurmaz
 * Kartın §2b'si zaten bu ayrımı yapıyor: süpervizör dalında YALNIZ yarım-şablon ve kanıt
 * yokluğu sayılıyor.
 *
 * @param {object} arg
 * @param {string} arg.md rapor metni
 * @param {string} [arg.filename]
 * @param {string|null} [arg.hukum] A1 `extractVerdict().hukum`
 * @param {string} [arg.hukumKaynak] A1 `extractVerdict().kaynak`
 * @param {object} [arg.alanlar] `contractFields` girdisi
 * @param {{durum:'var'|'yok', metin?:string}} [arg.sayfa] RPT5-07a — künyesi `biçim: html`
 *   olan raporun sayfası (çağıran okur: `metin` = düz metin, `reportHtmlText`). Kanıt türleri
 *   künye + özet + sayfa metni üzerinden sayılır; `durum:'yok'` → BLOKE (yarım-şablon).
 *   Verilmezse (markdown rapor ya da sayfaya bakılamadı) davranış eskisiyle BİREBİR aynı.
 * @param {string[]} [arg.kanitDosyalari] RPT5-07a — `<KOD>-evidence/` içindeki dosya adları
 * @param {object} [opts]
 * @param {boolean} [opts.enabled=true] KONTROL KOLU — false ⇒ kapı hüküm vermez
 * @param {boolean} [opts.hukumZorunlu=false] RPT4-12 — YAZIM yolu (süpervizör): beyan
 *   edilmiş hüküm yoksa kova `hükümsüz` (BLOKE) ve `ajana` cümlesi döner. Okuma yolu
 *   (indeks, Raporlar listesi) bunu GEÇMEZ: eski hükümsüz raporlar orada KIRILMAZ.
 * @returns {{gecti:boolean, bloke:boolean, kova:string, nedenler:string[], hukum_sinifi:string,
 *            hukum_guven:string, kanit:{puan:number,bulunan:string[],eksik:string[]},
 *            delikler:{tur:string,satir:number,alinti:string}[], alanlar:object, acik:boolean}}
 * Pure.
 */
function gateReport(arg, opts) {
  const o = opts || {};
  const acik = o.enabled !== false;
  const md = String((arg && arg.md) || '');
  // RPT5-07a — HTML rapor: `.md` yalnız künye + özet taşır; kanıt sayfada ve ek klasöründe.
  const sayfa = arg && arg.sayfa && typeof arg.sayfa === 'object' ? arg.sayfa : null;
  const sayfaMetni = sayfa && typeof sayfa.metin === 'string' ? sayfa.metin : '';
  const kanitAdlari = Array.isArray(arg && arg.kanitDosyalari) ? arg.kanitDosyalari.filter((x) => typeof x === 'string') : [];
  const kanit = evidenceKinds([md, sayfaMetni, kanitAdlari.join('\n')].filter(Boolean).join('\n\n'));
  // Sayfadaki yalnız SERT delikler sayılır: etkileşimli sayfada düğmeden ibaret bölüm
  // düz metinde "boş başlık" görünür ve bu bir eksik değildir.
  const delikler = [...templateHoles(md), ...(sayfaMetni ? templateHoles(sayfaMetni).filter((d) => d.agirlik === 'sert').map((d) => ({ ...d, sayfa: true })) : [])];
  const hv = verdictClass(md, arg && arg.hukum, arg && arg.hukumKaynak);
  const alanlar = contractFields((arg && arg.alanlar) || {});
  const eksikAlanlar = Object.entries(alanlar).filter(([, v]) => !v).map(([k]) => k);
  // REL-EVIDENCE-STAMP-01 — damga künye + sayfa metninde aranır (HTML raporda sayfadadır).
  const damga = acceptanceStamp([md, sayfaMetni].filter(Boolean).join('\n\n'), arg && arg.filename, md);

  // KONTROL KOLU — kapı kapalıyken hiçbir ret üretilmez, ÖLÇÜM yine döner. Böylece
  // "kapalıyken de aynı sayıları basıyor" diye bir sahte-yeşil kurulamaz: `kova` her
  // zaman `tam`dır ve bunu `acik:false` ile SÖYLER.
  if (!acik) {
    return {
      gecti: true, bloke: false, kova: 'tam', nedenler: [], acik: false,
      hukum_sinifi: hv.sinif, hukum_guven: hv.guven, kanit, delikler, alanlar, damga,
    };
  }

  const nedenler = [];
  const sertDelik = delikler.filter((d) => d.agirlik === 'sert');
  const yumusakDelik = delikler.filter((d) => d.agirlik !== 'sert');
  let kova = 'tam';
  // ⟦kural:html-sayfa-yok⟧
  if (sayfa && sayfa.durum === 'yok') {
    kova = 'yarım-şablon';
    nedenler.push('HTML sayfa yok: künye `biçim: html` diyor ama yanındaki .html dosyası bulunamadı');
  }
  // ⟦/kural⟧
  if (sertDelik.length) {
    if (kova === 'tam') kova = 'yarım-şablon';
    const ozet = sertDelik.slice(0, 3).map((d) => `${d.tur}@${d.satir}`).join(', ');
    nedenler.push(`yarım şablon izi (${sertDelik.length}): ${ozet}${sertDelik.length > 3 ? ' …' : ''}`);
  }
  // RPT4-12 — hüküm zorunluluğu. Yarım şablondan sonra, kanıttan ÖNCE: hükümsüz bir
  // raporun "bitti" olup olmadığını kimse bilemez, önce cümle gelmeli.
  let ajana = null;
  // ⟦kural:hüküm-zorunlu⟧
  if (o.hukumZorunlu === true && !verdictDeclared(arg && arg.hukum, arg && arg.hukumKaynak)) {
    if (kova === 'tam') kova = 'hükümsüz';
    nedenler.push('sözleşme alanı eksik: hüküm — iş "bitti" SAYILMAZ, ajana ne yazacağı söylendi');
    ajana = verdictNudge(reportLang(md, arg && arg.hukum), arg && arg.filename);
  }
  // ⟦/kural⟧
  if (kanit.puan === 0) {
    if (hv.sinif === 'bitti') {
      if (kova === 'tam') kova = 'kanıtsız-bitti';
      nedenler.push('hüküm "bitti" ama dört kanıt türünün HİÇBİRİ yok (komut çıktısı · test sayısı · kare yolu · commit)');
    } else {
      if (kova === 'tam') kova = 'kanıtsız-hüküm';
      nedenler.push(`hüküm "${hv.sinif}" ve kanıt yok — bloke etmez, defterde kalır`);
    }
  }
  // REL-EVIDENCE-STAMP-01 — hüküm kuralıyla aynı emsal: YALNIZ yazım yolunda (süpervizör)
  // bloke eder. Okuma yolu (indeks, Raporlar listesi) geçmez; eski kabul raporları orada
  // geriye dönük kırmızıya boyanmaz, ama ölçüm `damga` alanında yine döner. Hükmün sınıfına
  // BAKILMAZ: eski arayüzle koşulmuş "Başarısız:" da sahte-kırmızıdır.
  // ⟦kural:kabul-damgası⟧
  if (o.damgaZorunlu === true && damga.kabul && damga.eksik.length) {
    if (kova === 'tam') kova = 'damgasız-kabul';
    nedenler.push(`kabul/e2e raporunda kanıt damgası eksik: ${damga.eksik.join(' · ')} — koşulan derlemenin BUILD_ID'si, pencere başlığındaki commit ve sürüm satırı yazılmalı`);
  }
  // ⟦/kural⟧
  if (yumusakDelik.length) {
    if (kova === 'tam') kova = 'boş-bölüm';
    nedenler.push(`boş bölüm başlığı (${yumusakDelik.length}): ${yumusakDelik.slice(0, 3).map((d) => `@${d.satir}`).join(', ')} — bloke etmez`);
  }
  if (eksikAlanlar.length) {
    if (kova === 'tam') kova = 'sözleşme-eksik';
    nedenler.push(`sözleşme v2 alanı eksik: ${eksikAlanlar.join(' · ')}`);
  }

  const bloke = BLOKE_KOVALAR.includes(kova);
  return {
    gecti: kova === 'tam', bloke, kova, nedenler, acik: true,
    hukum_sinifi: hv.sinif, hukum_guven: hv.guven, kanit, delikler, alanlar, damga,
    ...(ajana ? { ajana } : {}),
  };
}

/**
 * RPT4-12 — hüküm kuralının kendi anahtarı (kontrol kolu ve acil durum). Kapı kapalıysa
 * bu da anlamsızdır; açıkken yalnız hüküm kuralını kapatır.
 */
function verdictRuleEnabled(env) {
  const e = (env || process.env || {});
  const v = String(e.AGENTSPACE_REPORT_VERDICT_GATE ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'kapalı' || v === 'kapali');
}

/** Ortam anahtarı — kapıyı kapatmanın TEK yolu (kontrol kolu ve acil durum). */
function gateEnabled(env) {
  const e = (env || process.env || {});
  const v = String(e.AGENTSPACE_REPORT_GATE ?? e.REPORT_GATE ?? '').trim().toLowerCase();
  if (v === '0' || v === 'off' || v === 'false' || v === 'kapalı' || v === 'kapali') return false;
  return true;
}

module.exports = {
  W,
  ZORUNLU_BOLUM,
  EVIDENCE_KINDS,
  KOVALAR,
  BLOKE_KOVALAR,
  basligVeMeta,
  withoutPlatformLine,
  verdictDeclared,
  reportLang,
  verdictNudge,
  verdictRuleEnabled,
  DAMGA_ALANLARI,
  acceptanceKind,
  stampFields,
  acceptanceStamp,
  stampRuleEnabled,
  verdictClass,
  evidenceKinds,
  stripCode,
  fenceMask,
  templateHoles,
  contractFields,
  gateReport,
  gateEnabled,
};
