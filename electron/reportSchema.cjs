'use strict';

// RPT4-01 — RAPOR SÖZLEŞMESİ v3 + BLOK GRAMERİ: TEK DOĞRULAYICI (saf leaf).
//
// ── NEDEN BU DOSYA VAR ──────────────────────────────────────────────────────
// Rapor v4'te yazımın üç yolu var: araç (`rapor_yaz`, RPT4-02), komut köprüsü
// (`agentspace report yaz`, RPT4-03) ve düz dosya. Üçü de AYNI kuralları bu modülden
// alır — ikinci bir doğrulayıcı yazılmaz. Ölçüm (REPORTS-V4-ARCH §1.1): son 7 günde 915
// raporun yalnız 30'u (%3,3) hükmü beyan etmiş; sözleşme v2 disiplinle tutmuyor, hüküm
// YAPIYLA zorunlu olmalı.
//
// ── İKİ KİP (geri uyumun kalbi) ─────────────────────────────────────────────
//   • kip 'yaz'  — YENİ yazım yolu. Sözleşme ihlali `hatalar[]`'a gider → çağıran reddeder.
//   • kip 'oku'  — okuma yolu (varsayılan). HİÇBİR ŞEY reddedilmez: 4 649 eski rapor
//     (hükümsüz, bloksuz) `bicim: 'eski'` olarak tanınır ve her bulgu `uyarilar[]`'a
//     iner. Eski raporu okuyan hiçbir yol bu modül yüzünden kırılmaz.
//
// ── SÖZLEŞME (docs/design/AJAN-RAPOR-SOZLESMESI-V3.md) ──────────────────────
//   hüküm    ZORUNLU; açılış kelimesi `Bitti:` | `Kısmen bitti:` | `Başarısız:`
//            (shared hafıza report-verdict-needs-opening-keyword: açılışsız hüküm kapıda
//            gövdeye düşüp yanlış sınıflanıyordu).
//   tip      ZORUNLU; A1'in yedi değeri AYNEN (scripts/reportsIndexV2.cjs TYPES — test eşitler).
//   okur     `ekip` | `kullanıcı`; yoksa `ekip` (tip `rehber` ise `kullanıcı`).
//   platform ZORUNLU, dolu.
//   ekler    rapor klasörüne göreli; `..`, mutlak yol (posix, `C:\`, `\\sunucu`), `~` RED.
//
// ── BLOKLAR ─────────────────────────────────────────────────────────────────
// On blok markdown ÇİTLİ KOD BLOĞUDUR (```akış). Bozuk blok REDDEDİLMEZ: uyarı döner,
// okuyucu onu düz kod olarak çizer (yazımı kırmayız). İSTİSNA: blok içindeki DOSYA YOLU
// (kanıt/sayfa) ekle aynı yol kuralına tabidir — kip 'yaz'da hata (güvenlik > hoşgörü).
// Blok adları ve anahtarlar Türkçe harfsiz de yazılabilir (`akis`, `secenek`): karşılaştırma
// katlanmış biçimle yapılır, `ad` alanı hep kanonik Türkçe addır.
//
// ── NE YAPMAZ ───────────────────────────────────────────────────────────────
// IO yok (fs/path import'u yoktur), global yok → main (CJS), renderer (TS import,
// `reportSchema.d.cts`), script ve `node --test` aynı dosyayı yükler. SVG'yi TEMİZLEMEZ
// (o çizicinin işi, RPT4-04) — yalnız temizlenecek öğeleri SAYAR. Kişisel veri taraması
// kategori + SAYI döner, eşleşen DEĞERİ asla döndürmez.
//
// ── KONTROL KOLU ────────────────────────────────────────────────────────────
// Üç çekirdek kural `⟦kural:…⟧ … ⟦/kural⟧` işaretleri arasındadır. Birim testi kaynağı
// okuyup işaretli bölgeyi söker ve modülü yeniden yükler: hükümsüz, açılışsız ve `..`
// ekli girdinin o zaman GEÇTİĞİNİ gösterir (testler gerçekten kuralı ölçüyor).

const SCHEMA_VERSION = 3;

/** A1'in yedi tipi — AYNEN (reportsIndexV2.cjs TYPES ile test eşitler). */
const TYPES = Object.freeze(['hata', 'araştırma', 'yayın', 'ölçüm', 'karar', 'rehber', 'diğer']);
const READERS = Object.freeze(['ekip', 'kullanıcı']);

/** Kanonik blok adları (sözleşme sırası). */
const BLOCKS = Object.freeze([
  'uyarı', 'adımlar', 'karşılaştır', 'kanıt', 'grafik', 'akış', 'şekil', 'karar', 'yapılacak', 'sayfa',
  // CHAT-RICH-04 (S6) — "kopyala-yapıştır" not bloğu. Sohbet VE rapor aynı sözlüğü kullanır
  // (ikinci ad listesi yok); çizimi `src/components/rich/CopyNoteBlock.tsx`.
  'kopyala',
]);

/** Kanonik adın dışındaki kabul edilen yazımlar (katlanmış → kanonik). */
const BLOCK_ALIASES = Object.freeze({ copy: 'kopyala' });

/** `kopyala` bloğunun gövde sınırı (bayt, UTF-8). Üstü uyarı; blok yine çizilir. */
const COPY_NOTE_MAX_BYTES = 8 * 1024;

/** Ek sayfa boyut sınırı (ADR §3.2-C: 39 sayfanın 35'i sığıyor). */
const PAGE_MAX_BYTES = 512 * 1024;
/**
 * RPT5-07a — HTML RAPORUN (birincil sayfa) sınırı. Ölçüm 25.09: çalışma alanındaki 142 tekil
 * `docs/artifacts/*.html`'in 136'sı (%96) sığıyor; aşan 6'nın 5'i ağırlıkla gömülü görsel.
 * `PAGE_MAX_BYTES` (`sayfa` bloğuyla eklenen ek sayfa) değişmez — sözleşme v3 §6.3.
 */
const HTML_PAGE_MAX_BYTES = 2 * 1024 * 1024;
const VERDICT_MAX_CHARS = 300;

/**
 * Türkçe harfleri katla + küçük harf. `toLocaleLowerCase('tr')` KULLANILMAZ: `I` → `ı`
 * yapar ve ASCII yazılmış `KANIT` katlanamazdı. Pure.
 */
function fold(s) {
  return String(s == null ? '' : s)
    .replace(/[çÇ]/g, 'c').replace(/[ğĞ]/g, 'g').replace(/[ıIİ]/g, 'i')
    .replace(/[öÖ]/g, 'o').replace(/[şŞ]/g, 's').replace(/[üÜ]/g, 'u')
    .toLowerCase().trim();
}

const BLOCK_BY_FOLD = new Map(BLOCKS.map((b) => [fold(b), b]));
const TYPE_BY_FOLD = new Map(TYPES.map((t) => [fold(t), t]));
const READER_BY_FOLD = new Map(READERS.map((r) => [fold(r), r]));
// REPORT-HTML-DEFAULT-01 — okur değer normalizasyonu: ajanların yazdığı eş anlamlılar kanonik
// değere iner (R2 ölçümü: alan yalnız bildirim süzgecinde okunuyor, kayan değer süzgeci ıskalar).
for (const [a, r] of [
  ['team', 'ekip'], ['worker', 'ekip'], ['agent', 'ekip'], ['ajan', 'ekip'], ['ajanlar', 'ekip'], ['takım', 'ekip'],
  ['user', 'kullanıcı'], ['owner', 'kullanıcı'], ['boss', 'kullanıcı'], ['patron', 'kullanıcı'], ['müşteri', 'kullanıcı'],
  ['customer', 'kullanıcı'], ['ofis sahibi', 'kullanıcı'],
]) READER_BY_FOLD.set(fold(a), r);

/**
 * Geçersiz tip için ÖNERİ (otomatik eşleme DEĞİL — araç reddeder, ajan düzeltir).
 * Ölçüm (2 018 rapor): 56 ön-bilgide tip yedi değerin dışında ve çoğu board kartının
 * sözlüğü (`feature`, `fix`, `spike`, `runtime`). Kurallar reportsIndexV2.cjs
 * `mapDeclaredType` ile aynı; eşlenemeyen her şey `diğer` (test iki tabloyu eşitler). Pure.
 */
function suggestType(raw) {
  const d = fold(raw).split(/[\/,(+—–\s-]/)[0];
  if (/^(bug|bugfix|hata|fix|regres|crash|cok|incident|inc)/.test(d)) return 'hata';
  if (/^(spike|arastirma|research|kesif|inceleme)/.test(d)) return 'araştırma';
  if (/^(release|yayin|surum|rc|hotfix)/.test(d)) return 'yayın';
  if (/^(olcum|measure|benchmark|denetim|audit|sayim|envanter|qa|test)/.test(d)) return 'ölçüm';
  if (/^(karar|decision|adr|tasarim|design|mimari)/.test(d)) return 'karar';
  if (/^(rehber|kilavuz|guide|playbook|runbook|talimat)/.test(d)) return 'rehber';
  return 'diğer';
}

/** Info dizesi → kanonik blok adı; blok değilse null (ör. `js`, `bash`). Pure. */
function canonicalBlockName(info) {
  const first = String(info || '').trim().split(/\s+/)[0] || '';
  return BLOCK_BY_FOLD.get(fold(first)) || BLOCK_ALIASES[fold(first)] || null;
}

/**
 * CHAT-RICH-04 — `kopyala` bloğunun gramer ayrımı (çizici ile doğrulayıcı AYNI fonksiyonu
 * kullanır). İsteğe bağlı başlık satırı(ları) + `---` ayırıcı, altı ham metin:
 *
 *   başlık: Müşteriye gönderilecek mesaj
 *   ---
 *   Merhaba, siparişiniz bugün kargoya verildi.
 *
 * Ayırıcı yoksa gövdenin TAMAMI metindir (ajan ne yazdıysa o). Metnin başındaki ve
 * sonundaki BOŞ satırlar atılır; satır içi boşluk, sekme ve iç boş satırlar korunur.
 * Markdown işlenmez. Pure.
 * @returns {{ baslik: string|null, metin: string }}
 */
function parseCopyNote(raw) {
  const lines = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n').split('\n');
  let baslik = null;
  let bodyLines = lines;
  const sep = lines.findIndex((l) => /^\s*-{3,}\s*$/.test(l));
  if (sep > 0 && sep <= 3) {
    const head = lines.slice(0, sep);
    const m = head.map((l) => /^\s*(başlık|baslik|title)\s*:\s*(.+)$/i.exec(l)).find(Boolean);
    if (m && head.every((l) => !l.trim() || /^\s*(başlık|baslik|title)\s*:/i.test(l))) {
      baslik = m[2].trim() || null;
      bodyLines = lines.slice(sep + 1);
    }
  }
  let a = 0;
  let b = bodyLines.length;
  while (a < b && !bodyLines[a].trim()) a++;
  while (b > a && !bodyLines[b - 1].trim()) b--;
  return { baslik, metin: bodyLines.slice(a, b).join('\n') };
}

// ─── iletiler (tr + en) ─────────────────────────────────────────────────────
// Ajana ve (RPT4-02/09 üzerinden) kullanıcıya gider. Her ileti NE YAZILACAĞINI söyler.

const MESSAGES = Object.freeze({
  HUKUM_YOK: {
    tr: 'hüküm yok. Tek cümle yaz ve şu kelimelerden biriyle aç: "Bitti:", "Kısmen bitti:" ya da "Başarısız:" (İngilizce: "Done:", "Partial:", "Failed:"). "Çalışıyor" yetmez; ne ölçtüğünü söyle.',
    en: 'verdict is missing. Write one sentence that starts with "Done:", "Partial:" or "Failed:". "It works" is not enough; say what you measured.',
  },
  HUKUM_ACILIS: {
    tr: 'hüküm açılış kelimesiyle başlamıyor. "Bitti:", "Kısmen bitti:" ya da "Başarısız:" ile başlat.',
    en: 'verdict does not start with an opening word. Start it with "Done:", "Partial:" or "Failed:".',
  },
  HUKUM_BOS: {
    tr: 'hüküm yalnız açılış kelimesinden ibaret. İki noktadan sonra sonucu yaz.',
    en: 'verdict has only the opening word. Write the result after the colon.',
  },
  HUKUM_UZUN: {
    tr: 'hüküm {n} karakter; tek cümle olmalı (en çok {max}). Ayrıntıyı gövdeye taşı.',
    en: 'verdict is {n} characters; keep it to one sentence (at most {max}). Move details to the body.',
  },
  TIP_YOK: {
    tr: 'tip yok. Şunlardan birini yaz: {liste}.',
    en: 'type is missing. Use one of: {liste}.',
  },
  TIP_GECERSIZ: {
    tr: '"{deger}" geçerli bir tip değil; büyük olasılıkla "{oneri}". Şunlardan birini yaz: {liste}.',
    en: '"{deger}" is not a valid type; most likely "{oneri}". Use one of: {liste}.',
  },
  OKUR_GECERSIZ: {
    tr: '"{deger}" geçerli bir okur değil. "ekip" ya da "kullanıcı" yaz.',
    en: '"{deger}" is not a valid reader. Use "ekip" (team) or "kullanıcı" (user).',
  },
  PLATFORM_YOK: {
    tr: 'platform beyanı yok. Hangi platformda doğruladığını yaz; koşamadığın platformu "koşulamadı + neden" diye yaz.',
    en: 'platform statement is missing. Say where you verified; for a platform you could not run, write "not run + why".',
  },
  GOREV_YOK: {
    tr: 'görev kodu yok (board kartının tam kimliği, ör. TASK-…).',
    en: 'task id is missing (the full board card id, e.g. TASK-…).',
  },
  YOL_BOS: { tr: 'dosya yolu boş.', en: 'file path is empty.' },
  YOL_UST: {
    tr: '"{yol}" üst klasöre çıkıyor (".."). Yol rapor klasörünün altında kalmalı.',
    en: '"{yol}" goes up a folder (".."). Keep the path inside the report folder.',
  },
  YOL_MUTLAK: {
    tr: '"{yol}" mutlak bir yol. Rapor klasörüne göreli yol yaz (ör. RPT4-01-evidence/kare.png).',
    en: '"{yol}" is an absolute path. Use a path relative to the report folder (e.g. RPT4-01-evidence/shot.png).',
  },
  // RPT-SCRATCH-RULE-01 — geçici klasör (Claude Code scratchpad, /tmp, %TEMP%) yeniden başlatmada silinir.
  YOL_GECICI: {
    tr: '"{yol}" geçici klasörde; önce docs/artifacts/<KOD>/ altına taşı (geçici klasör yeniden başlatmada silinir, sayfa Raporlar\'a oradan girer).',
    en: '"{yol}" is in a temp folder; move it under docs/artifacts/<KOD>/ first (the temp folder is wiped on restart; the page reaches the Reports tab from there).',
  },
  YOL_KARAKTER: {
    tr: '"{yol}" izin verilmeyen karakter içeriyor.',
    en: '"{yol}" contains a character that is not allowed.',
  },
  SAYFA_BOYUT: {
    tr: 'ek sayfa "{yol}" {kb} KB; sınır {max} KB. Veriyi ayrı bir ek dosyaya böl.',
    en: 'attached page "{yol}" is {kb} KB; the limit is {max} KB. Split the data into a separate file.',
  },
  SAYFA_BOS: {
    tr: 'sayfa boş. Raporun HTML sayfasını ver (sayfa ya da sayfa_dosyasi).',
    en: 'the page is empty. Give the report\'s HTML page (sayfa or sayfa_dosyasi).',
  },
  SAYFA_HTML_DEGIL: {
    tr: 'sayfa HTML değil (hiç etiket yok). Rapor HTML sayfasıdır: <h1>, <p>, <table> … ile yaz; markdown gönderme.',
    en: 'the page is not HTML (no tags). The report is an HTML page: write it with <h1>, <p>, <table> …; do not send markdown.',
  },
  SAYFA_BUYUK: {
    tr: 'sayfa {kb} KB; sınır {max} KB. Kareleri küçült (≤ 1200 px, webp) ya da {klasor} klasörüne koyup çift yazımla göster (<img data-kanit="ad" src="{klasor}ad">, data-kanit önce); kanit: tek başına Chrome\'da kırılır.',
    en: 'the page is {kb} KB; the limit is {max} KB. Shrink images (≤ 1200 px, webp) or put them in {klasor} and show them double-written (<img data-kanit="name" src="{klasor}name">, data-kanit first); a bare kanit: breaks in Chrome.',
  },
  // RPT-VISUAL-C2 — görünüş kapısı (reportPageGate.cjs). GORSEL_KIRIK ret, gerisi uyarı.
  GORSEL_KIRIK: {
    tr: 'sayfada {n} kırık kare var; rapor yazılmadı. Patron sayfayı Chrome\'da dosyadan da, okuyucuda da açar, kare ikisinde de görünmeli. Kareler: {liste}',
    en: 'the page has {n} broken image(s); the report was not written. The page is opened in Chrome from the file and in the reader; images must show in both. Images: {liste}',
  },
  GORSEL_AZ: {
    tr: 'okur kullanıcı ama sayfada {n} görsel bileşen var (en az {min}: SVG grafik {svg}, kare {kare}, data-gorsel {isaretli}). Sayıları çizerek göster: çubuk/çizgi/halka grafik, akış, zaman çizelgesi, önce/sonra — kopyalanabilir parçalar docs/design/rapor-ornekleri/parcalar.html. CSS ile çizdiğin grafiğe data-gorsel yaz.',
    en: 'the reader is the user but the page has {n} visual component(s) (at least {min}: SVG chart {svg}, image {kare}, data-gorsel {isaretli}). Draw the numbers: bar/line/donut chart, flow, timeline, before/after — copyable parts in docs/design/rapor-ornekleri/parcalar.html. Mark a CSS-drawn chart with data-gorsel.',
  },
  YOGUN_SAYFA: {
    tr: 'sayfa okur için yoğun ({n} sorun): {liste}. Okur kullanıcı: kısa bölüm, kart, tablo, çizim; ayrıntıyı <details> içine al.',
    en: 'the page is dense for its reader ({n} issues): {liste}. The reader is the user: short sections, cards, tables, drawings; put detail inside <details>.',
  },
  STILSIZ: {
    tr: 'sayfa Chrome\'da stilsiz açılıyor ({neden}). Kendi <style>\'ını yaz; kit değişkenine yedek ver: --v-s1: var(--surface-1, #fff) (parcalar.html 1. ve 2. bölüm).',
    en: 'the page opens unstyled in Chrome ({neden}). Write your own <style>; give kit variables a fallback: --v-s1: var(--surface-1, #fff) (parcalar.html sections 1 and 2).',
  },
  TASMA_390: {
    tr: 'telefonda (390 px) sayfa yana kayıyor ({px} px). Geniş tabloyu ve maketi kaydırma kabına al (overflow:auto) ya da max-width:100% ver.',
    en: 'on a phone (390 px) the page scrolls sideways ({px} px). Put wide tables and mock-ups in a scroll box (overflow:auto) or give them max-width:100%.',
  },
  ONIZLEME_YOK: {
    tr: 'sayfa gizli pencerede açılamadı ({neden}); kırık kare yalnız adres ve dosya varlığına göre denetlendi. Teslimden önce docs/design/rapor-ornekleri/kontrol/kontrol.cjs ile bak.',
    en: 'the page could not be opened in the hidden window ({neden}); broken images were checked from addresses and files only. Check it with docs/design/rapor-ornekleri/kontrol/kontrol.cjs before handing it in.',
  },
  DIS_KAYNAK: {
    tr: 'sayfa dışarıdan kaynak çağırıyor ({liste}). Rapor internete kapalı çalışır; bunlar yüklenmez. Betiği ve stili sayfanın içine koy.',
    en: 'the page loads outside resources ({liste}). Reports run offline; these will not load. Put scripts and styles inside the page.',
  },
  KANIT_YOK: {
    tr: 'sayfa "kanit:{ad}" gösteriyor ama {klasor}/{ad} yok. Dosyayı oraya koy ya da adı düzelt.',
    en: 'the page shows "kanit:{ad}" but {klasor}/{ad} does not exist. Put the file there or fix the name.',
  },
  SAYFA_YOK: {
    tr: 'biçim html ama sayfa yok. HTML metnini `sayfa` ile ya da dosyasını `sayfa_dosyasi` ile ver.',
    en: 'format is html but there is no page. Give the HTML text in `sayfa` or its file in `sayfa_dosyasi`.',
  },
  SAYFA_IKI_KAYNAK: {
    tr: '`sayfa` ve `sayfa_dosyasi` birlikte verildi. Yalnız birini ver.',
    en: '`sayfa` and `sayfa_dosyasi` were both given. Give only one.',
  },
  SAYFA_DOSYA_YOK: {
    tr: '"{yol}" rapor klasöründe (docs/agent-results/) bulunamadı. Yol o klasöre göreli olmalı.',
    en: '"{yol}" was not found in the report folder (docs/agent-results/). The path must be relative to that folder.',
  },
  SAYFA_UZANTI: {
    tr: '"{yol}" bir .html dosyası değil.',
    en: '"{yol}" is not an .html file.',
  },
  SAYFA_KLASOR_DISI: {
    tr: '"{yol}" rapor klasörünün dışına çıkıyor (bağlantı ya da kısayol). Dosyayı rapor klasörüne kopyala.',
    en: '"{yol}" points outside the report folder (link or shortcut). Copy the file into the report folder.',
  },
  BICIM_GECERSIZ: {
    tr: '"{deger}" geçerli bir biçim değil. "html" ya da "md" yaz.',
    en: '"{deger}" is not a valid format. Use "html" or "md".',
  },
  HTML_AYRI: {
    tr: 'rapor ayrı bir sayfa anıyor ({liste}). Görselli raporu biçim: html ile yaz (rapor_yaz bicim="html" + sayfa ya da sayfa_dosyasi): sayfa Raporlar\'da raporun kendisi olarak açılır, tarayıcıda açılmaz.',
    en: 'the report mentions a separate page ({liste}). Write a visual report with format html (rapor_yaz bicim="html" + sayfa or sayfa_dosyasi): the page opens in Reports as the report itself, not in a browser.',
  },
  KARAR_BAGSIZ: {
    tr: 'sayfadaki karar kutusu karar kaydına bağlı değil ({liste}). govde\'ye aynı kimlikle bir karar bloğu ekle (kimlik, soru, en az 2 seçenek); yoksa seçim yalnız sayfada kalır.',
    en: 'a decision box on the page is not linked to the decision record ({liste}). Add a karar block with the same id to govde (kimlik, soru, at least 2 seçenek); otherwise the choice stays on the page only.',
  },
  OZET_UZUN: {
    tr: 'özet {n} satır; 3-8 satır olmalı. Ayrıntı sayfada kalsın.',
    en: 'the summary has {n} lines; keep it to 3-8. Leave details on the page.',
  },
  KISISEL_VERI: {
    tr: 'raporda kişisel veriye benzeyen {sayi} değer var ({kategoriler}). Yayından önce kaldır ya da maskele.',
    en: 'the report has {sayi} values that look like personal data ({kategoriler}). Remove or mask them before sharing.',
  },
  BLOK_KAPANMADI: {
    tr: '"{blok}" bloğu kapanmadı (satır {satir}). Aynı sayıda ` ile kapat.',
    en: '"{blok}" block is not closed (line {satir}). Close it with the same number of backticks.',
  },
  BLOK_BOS: { tr: '"{blok}" bloğu boş.', en: '"{blok}" block is empty.' },
  BLOK_BUYUK: {
    tr: '"{blok}" bloğu {kb} KB; sınır {max} KB. Metni böl ya da ayrı bir dosya olarak ekle.',
    en: '"{blok}" block is {kb} KB; the limit is {max} KB. Split the text or attach it as a separate file.',
  },
  BLOK_ANAHTAR_YOK: {
    tr: '"{blok}" bloğunda "{anahtar}:" satırı zorunlu.',
    en: '"{blok}" block needs a "{anahtar}:" line.',
  },
  BLOK_DEGER: {
    tr: '"{blok}" bloğunda "{anahtar}" için "{deger}" geçersiz. İzinli: {liste}.',
    en: '"{blok}" block: "{deger}" is not valid for "{anahtar}". Allowed: {liste}.',
  },
  BLOK_SATIR: {
    tr: '"{blok}" bloğunun {satir}. satırı gramere uymuyor: {beklenen}.',
    en: '"{blok}" block, line {satir} does not match the grammar: {beklenen}.',
  },
  BLOK_METIN_YOK: {
    tr: '"{blok}" bloğunda gösterilecek metin yok.',
    en: '"{blok}" block has no text to show.',
  },
  BLOK_SIRA: {
    tr: '"adımlar" bloğunda numara sırası bozuk: {beklenen} beklenirken {bulunan} geldi.',
    en: '"adımlar" block: step numbers are out of order: expected {beklenen}, got {bulunan}.',
  },
  BLOK_SUTUN: {
    tr: '"karşılaştır" bloğunun {satir}. satırında {bulunan} sütun var, başlıkta {beklenen}.',
    en: '"karşılaştır" block, line {satir} has {bulunan} columns; the header has {beklenen}.',
  },
  BLOK_SAYI: {
    tr: '"grafik" bloğunda "{etiket}" değeri sayı değil: "{deger}".',
    en: '"grafik" block: the value for "{etiket}" is not a number: "{deger}".',
  },
  BLOK_ESIK: {
    tr: '"{blok}" bloğunda en az {min} {ne} gerekli, {bulunan} var.',
    en: '"{blok}" block needs at least {min} {ne}; found {bulunan}.',
  },
  BLOK_KIMLIK: {
    tr: '"{blok}" bloğunun kimliği "{deger}" geçersiz: küçük harf, rakam, "-" ya da "_" (en çok 32).',
    en: '"{blok}" block id "{deger}" is not valid: use lowercase letters, digits, "-" or "_" (max 32).',
  },
  BLOK_KIMLIK_TEKRAR: {
    tr: '"{deger}" kimliği bu raporda birden çok blokta kullanılmış. Her karar/yapılacak bloğuna ayrı kimlik ver.',
    en: 'the id "{deger}" is used by more than one block in this report. Give each decision/to-do block its own id.',
  },
  BLOK_KARAR_KIMLIGI: {
    tr: '"karar" bloğunda karar_kimligi "{deger}" geçersiz: karar_sor\'un verdiği kimliği yaz (ör. K-0142).',
    en: '"karar" block: karar_kimligi "{deger}" is not valid: write the id karar_sor returned (e.g. K-0142).',
  },
  // KRR-AGENT-FLOW-01 — düz yazı karar sorusu (reportLedger kapısı; K21: önce uyarı).
  ACIK_SORU_KARARSIZ: {
    tr: '"{baslik}" bölümünde {n} soru var ama rapora bağlı karar yok. Kullanıcıya soruyorsan karar olarak sor: rapor_yaz `kararlar` alanı ([{soru, secenekler, oneri: {kod, gerekce}}]) — düz yazı soru Kararlar sekmesine düşmez, kaybolur. Soru değilse başlığı değiştir (ör. "Notlar").',
    en: 'the "{baslik}" section has {n} question(s) but no decision is linked to this report. If you are asking the user, ask it as a decision: rapor_yaz `kararlar` ([{soru, secenekler, oneri: {kod, gerekce}}]) — a plain-text question never reaches the Decisions tab and gets lost. If it is not a question, rename the heading (e.g. "Notes").',
  },
  BLOK_SECENEK_TEKRAR: {
    tr: '"karar" bloğunda "{deger}" seçeneği iki kez var.',
    en: '"karar" block: option "{deger}" appears twice.',
  },
  BLOK_SECENEK_YOK: {
    tr: '"karar" bloğunda "{anahtar}: {deger}" hiçbir seçeneğe karşılık gelmiyor.',
    en: '"karar" block: "{anahtar}: {deger}" does not match any option.',
  },
  BLOK_SVG_YOK: {
    tr: '"şekil" bloğu <svg> … </svg> ile başlayıp bitmeli.',
    en: '"şekil" block must start with <svg> and end with </svg>.',
  },
  BLOK_SVG_TEMIZLIK: {
    tr: '"şekil" bloğundaki şu öğeler çizilirken silinecek: {liste}.',
    en: 'these parts of the "şekil" block will be removed when drawn: {liste}.',
  },
  BLOK_SAYFA_UZANTI: {
    tr: '"sayfa" bloğunun dosyası .html olmalı: "{deger}".',
    en: '"sayfa" block file must be .html: "{deger}".',
  },
  BLOK_YUKSEKLIK: {
    tr: '"sayfa" bloğunda yükseklik {min}–{max} arası bir tam sayı olmalı: "{deger}".',
    en: '"sayfa" block height must be a whole number between {min} and {max}: "{deger}".',
  },
});

function render(kod, params, lang) {
  const m = MESSAGES[kod];
  const tpl = (m && (m[lang] || m.tr)) || kod;
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (params && params[k] != null ? String(params[k]) : `{${k}}`));
}

// ─── ön-bilgi (A1 ile AYNI ayrıştırma) ──────────────────────────────────────

// MEM-CRLF-01 — Not Defteri'nin baştaki UTF-8 BOM'u (U+FEFF) ön-bilgiyi düşürüyordu. Metin
// burada NORMALİZE EDİLMEZ: gövde ham metnin SONEKİ kalmalı (reportLedger.readReport ön-bilgiyi
// `md.slice(0, md.length - body.length)` ile keser); CRLF'i `\s*` + satır kırpma zaten taşır.
const FM_RE = /^\uFEFF?---\s*\n([\s\S]*?)\n---\s*(\n|$)/;

/**
 * `---` bloğu → anahtar/değer. scripts/reportsIndexV2.cjs `frontmatter` ile birebir aynı
 * davranış (anahtar küçük harf, değer kırpılmış, tırnak sökülmez) — geri uyum testi
 * 50 gerçek raporda ikisinin aynı sonucu verdiğini ölçer. Pure.
 */
function frontmatter(md) {
  const out = {};
  const m = FM_RE.exec(md || '');
  if (!m) return out;
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-zÇĞİÖŞÜçğıöşü0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) out[kv[1].toLowerCase()] = kv[2].trim();
  }
  return out;
}

/** Ön-bilgi bloğunu gövdeden ayır: {fm, body, bodyStartLine}. Pure. */
function splitFrontmatter(md) {
  const s = String(md || '');
  const m = FM_RE.exec(s);
  if (!m) return { fm: {}, body: s, bodyStartLine: 1, hasFrontmatter: false };
  return {
    fm: frontmatter(s),
    body: s.slice(m[0].length),
    bodyStartLine: m[0].split('\n').length - (m[0].endsWith('\n') ? 1 : 0) + 1,
    hasFrontmatter: true,
  };
}

/** Katlanmış anahtarla ön-bilgiden değer al (`hüküm`/`hukum`/`verdict` hepsi). Pure. */
function pick(fm, ...keys) {
  const want = new Set(keys.map(fold));
  for (const [k, v] of Object.entries(fm || {})) if (want.has(fold(k))) return v;
  return undefined;
}

/**
 * Biçim: `sözleşme: 3` damgası → 'v3'; ön-bilgi var → 'v2'; yok → 'eski'.
 * Damga yazım aracının (RPT4-02) işi; damgasız ama v3 alanlı rapor 'v2' sayılır ve
 * okuma yolunda aynen çizilir — biçim bir ETİKETTİR, kabul koşulu değil. Pure.
 */
function classifyFormat(md) {
  const { fm, hasFrontmatter } = splitFrontmatter(md);
  const stamp = pick(fm, 'sözleşme', 'contract');
  if (stamp && /^v?3\b/i.test(String(stamp).trim())) return 'v3';
  return hasFrontmatter ? 'v2' : 'eski';
}

// ─── hüküm ──────────────────────────────────────────────────────────────────

// RPT4-02 — İngilizce açılışlar da kabul (Optimus kararı 23.09): müşteri ajanları
// İngilizce çalışır. `Partially done:` da `Partial:` sayılır. Sınıf adları Türkçe kalır
// (kapı ve okuyucu tek sözlüğe bakar); `dil` alanı hangi dilde yazıldığını söyler.
const OPENINGS = Object.freeze([
  { sinif: 'kısmen', dil: 'tr', re: /^kısmen\s+bitti\s*:/iu, ascii: /^kismen\s+bitti\s*:/i },
  { sinif: 'başarısız', dil: 'tr', re: /^başarısız\s*:/iu, ascii: /^basarisiz\s*:/i },
  { sinif: 'bitti', dil: 'tr', re: /^bitti\s*:/iu, ascii: /^bitti\s*:/i },
  { sinif: 'kısmen', dil: 'en', re: /^partial(?:ly\s+done)?\s*:/i, ascii: /^partial(?:ly\s+done)?\s*:/i },
  { sinif: 'başarısız', dil: 'en', re: /^failed\s*:/i, ascii: /^failed\s*:/i },
  { sinif: 'bitti', dil: 'en', re: /^done\s*:/i, ascii: /^done\s*:/i },
]);

/**
 * Hükmün açılış kelimesi → sınıf. v3'te hükmün sınıfının TEK otoritesi budur (kapı,
 * RPT4-12, bunu okumalı: bugünkü `verdictClass` "Kısmen bitti: … koşulamadı" hükmünü
 * FAIL sözlüğü önce baktığı için 'başarısız' sınıflar — RPT4-01 raporu §2).
 * Türkçe harfsiz yazım (`Kismen bitti:`) ve İngilizce açılış (`Done:`, `Partial:`,
 * `Failed:`) da tanınır. Açılış yoksa null. Pure.
 * @returns {{sinif:'bitti'|'kısmen'|'başarısız', dil:'tr'|'en', geri:string}|null}
 */
function verdictOpening(hukum) {
  const h = String(hukum || '').trim();
  for (const o of OPENINGS) {
    const m = o.re.exec(h) || o.ascii.exec(fold(h));
    if (m) return { sinif: o.sinif, dil: o.dil, geri: h.slice(m[0].length).trim() };
  }
  return null;
}

// ─── yol kuralı ─────────────────────────────────────────────────────────────

// ─── geçici klasör (RPT-SCRATCH-RULE-01) ────────────────────────────────────
//
// R14 (02.10): geçici klasörde Raporlar'a hiç girmemiş 74 sayfa/rapor taslağı vardı, 65'inin başka
// kopyası yoktu — ajan patrona gösterilecek sayfayı tezgâh dosyasıyla aynı yere yazıyor ve macOS
// geçici klasörü yeniden başlatmada siler. Kural yalnız RAPORUN GÖSTERDİĞİ yollar için: scratchpad
// tezgâh olarak serbest (düz metinde anılan /tmp yolu, kod bloğu, kanıt komutu RED DEĞİL).
//
// Yollar (ölçüldü — Claude Code 2.1.289 ikilisi: `<CLAUDE_CODE_TMPDIR|"/tmp">/claude-<uid>/<cwd'nin
// [^a-zA-Z0-9] → '-' hâli>/<oturum>/scratchpad`, kök realpath'lenir): mac `/private/tmp/claude-501/…`,
// Linux `/tmp/claude-<uid>/…`, Windows'ta `process.getuid` yok → `claude-0`, "/tmp" sürücü köküne
// çözülür (`C:\tmp\claude-0\…`). Ayrıca işletim sisteminin geçici klasörü: mac `/var/folders/…/T`,
// Windows `%TEMP%` = `C:\Users\<ad>\AppData\Local\Temp`. IO katmanı `os.tmpdir()`'i (TMPDIR/TEMP
// değişkenine göre) `geciciKokler` olarak ekler; bu modül yine saf kalır.
const TEMP_PATTERNS = Object.freeze([
  /^\/(?:private\/)?(?:var\/)?tmp(?:\/|$)/i, // /tmp, /private/tmp, /var/tmp (Claude Code scratchpad burada)
  /^\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/t(?:\/|$)/i, // macOS os.tmpdir()
  /^[a-z]:\/(?:windows\/)?te?mp(?:\/|$)/i, // C:\tmp (Claude Code "/tmp"), C:\Temp, C:\Windows\Temp
  /^(?:[a-z]:\/users\/[^/]+|~)\/appdata\/local\/temp(?:\/|$)/i, // %TEMP%
  /^(?:%(?:temp|tmp)%|\$env:(?:temp|tmp)|\$\{?(?:tmpdir|temp|tmp)\}?)(?:\/|$)/i, // değişkenle yazılmış
]);

/** Yol/URL → karşılaştırılabilir biçim: `file://` sökülür, %xx çözülür, `\` → `/`. Pure. */
function normalizeLoosePath(p) {
  let s = String(p == null ? '' : p).trim().replace(/^["'<]+|["'>]+$/g, '');
  if (/^file:/i.test(s)) {
    s = s.replace(/^file:(?:\/\/(?:localhost)?)?/i, '');
    try { s = decodeURIComponent(s); } catch { /* bozuk kaçış: olduğu gibi */ }
    if (/^\/[a-z]:[\\/]/i.test(s)) s = s.slice(1); // file:///C:/… → C:/…
  }
  return s.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
}

/**
 * Yol (ya da `file://` URL) geçici klasörde mi? Desen + `kokler` (IO katmanının verdiği
 * `os.tmpdir()` vb.). Sürücü harfli/Windows biçiminde büyük-küçük harf duyarsız. Pure.
 * @param {string} p
 * @param {string[]} [kokler]
 */
function isTempPath(p, kokler) {
  const s = normalizeLoosePath(p);
  if (!s) return false;
  if (TEMP_PATTERNS.some((re) => re.test(s))) return true;
  for (const k of Array.isArray(kokler) ? kokler : []) {
    const r = normalizeLoosePath(k).replace(/\/+$/, '');
    if (!r || r.length < 3 || r === '~') continue;
    const ci = /^[a-z]:\//i.test(r) || /^[a-z]:\//i.test(s);
    const [a, b] = ci ? [s.toLowerCase(), r.toLowerCase()] : [s, r];
    if (a === b || a.startsWith(`${b}/`)) return true;
  }
  return false;
}

/**
 * Raporun GÖSTERDİĞİ dosya göndermeleri: HTML'de src/href/poster/data/action/srcset ve CSS url()
 * değerleri + metnin her yerindeki `file://` URL'leri; markdown'da bağlantı/görsel hedefleri.
 * Kod çiti ve satır içi kod atlanır (orada geçen yol bir gösterim değildir). Pure.
 * @returns {string[]} tekrarsız
 */
function shownFileRefs(text, { markdown = false } = {}) {
  let t = String(text || '');
  if (markdown) t = t.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const out = new Set();
  for (const m of t.matchAll(/\b(?:src|href|poster|data|action)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) out.add((m[1] ?? m[2] ?? m[3] ?? '').trim());
  for (const m of t.matchAll(/\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    for (const part of String(m[1] ?? m[2] ?? '').split(',')) out.add(part.trim().split(/\s+/)[0]);
  }
  for (const m of t.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi)) out.add((m[1] ?? m[2] ?? m[3] ?? '').trim());
  if (markdown) for (const m of t.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.add(m[1].trim());
  for (const m of t.matchAll(/file:\/\/[^\s"'<>)`]+/gi)) out.add(m[0]);
  out.delete('');
  return [...out];
}

/** Raporun gösterdiği göndermelerden geçici klasördekiler (en çok `max`). Pure. */
function tempRefsOf(text, { markdown = false, kokler = [], max = 5 } = {}) {
  return shownFileRefs(text, { markdown }).filter((r) => isTempPath(r, kokler)).slice(0, max);
}

/**
 * Rapor klasörüne göreli, güvenli yol mu? `\` ayırıcı sayılır (Windows'ta yazılmış
 * yol da yakalanır). Kod döner, yol DÖNDÜRMEZ. Pure.
 * @param {string} p
 * @param {{geciciKokler?:string[]}} [opts] IO katmanının geçici kökleri (`os.tmpdir()`)
 * @returns {null|'YOL_BOS'|'YOL_UST'|'YOL_MUTLAK'|'YOL_KARAKTER'|'YOL_GECICI'}
 */
function checkRelPath(p, opts) {
  const s = String(p == null ? '' : p).trim();
  if (!s) return 'YOL_BOS';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(s)) return 'YOL_KARAKTER';
  // RPT-SCRATCH-RULE-01 — mutlak-yol kuralından ÖNCE: ileti "göreli yaz" değil "kalıcı yere taşı" demeli.
  // ⟦kural:geçici-yol⟧
  if (isTempPath(s, opts && opts.geciciKokler)) return 'YOL_GECICI';
  // ⟦/kural⟧
  // ⟦kural:yol-kafesi⟧
  if (/^[\\/]/.test(s) || /^[A-Za-z]:/.test(s) || /^~/.test(s) || /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return 'YOL_MUTLAK';
  if (s.split(/[\\/]+/).some((seg) => seg === '..')) return 'YOL_UST';
  // ⟦/kural⟧
  return null;
}

// ─── kişisel veri taraması ──────────────────────────────────────────────────

const PII_PATTERNS = Object.freeze({
  // Yerel kısım "noreply" türü ve örnek alan adları kişisel değildir (commit imzası, belge örneği).
  eposta: {
    re: /(?<![\p{L}\p{N}._%+-])([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})(?![\p{L}\p{N}])/gu,
    // `ikon@2x.png` (HTML sayfalarda srcset/CSS) e-posta değildir: dosya uzantılı "alan adı" sayılmaz.
    skip: (m) => /^(no-?reply|noreply\+?.*)$/i.test(m[1]) || /(^|\.)(example\.(com|org|net)|invalid|test|localhost)$/i.test(m[2])
      || /\.(png|jpe?g|gif|webp|svg|avif|ico|css|js|mjs|json|woff2?|ttf|html?)$/i.test(m[2]),
  },
  // TR cep (0 5xx … / +90 5xx …) ve "+" ile başlayan uluslararası numara. Sürüm, boyut,
  // tarih, sayı kümesi (4 649) "+" ya da 05 öneki taşımadığı için eşleşmez.
  telefon: {
    re: /(?<![\p{L}\p{N}+])(?:(?:\+90|0090|0)[\s.-]?5\d{2}[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}|\+(?!90)[1-9]\d{0,2}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{2,4})(?![\p{N}])/gu,
    skip: () => false,
  },
});

/**
 * Metinde kişisel veriye benzeyen değerleri KATEGORİ + SAYI olarak döner; eşleşen
 * değer asla dönmez (shared hafıza pii-scan-section-must-not-list-strings). Yazım
 * aracı bunu SON yazımdan sonra çağırır. Pure.
 * @returns {{eposta:number, telefon:number}}
 */
function scanPersonalData(text) {
  const s = String(text || '');
  const out = {};
  for (const [cat, { re, skip }] of Object.entries(PII_PATTERNS)) {
    let n = 0;
    for (const m of s.matchAll(re)) if (!skip(m)) n++;
    out[cat] = n;
  }
  return out;
}

/** LEAD-WF-I2 — maskede değerin yerine yazılan iz (değerin uzunluğu bile sızmaz). */
const PII_MASK = Object.freeze({ eposta: '[e-posta gizlendi]', telefon: '[telefon gizlendi]' });

/**
 * LEAD-WF-I2 — `scanPersonalData` ile AYNI desenler ve AYNI istisnalar (noreply, örnek alan
 * adı, `ikon@2x.png`): sayılan her değer maskelenir, sayılmayan dokunulmaz. İki ayrı desen
 * seti tutulmaz — tarayıcı ile maske ayrışamaz. Pure.
 * @returns {{text:string, counts:{eposta:number, telefon:number}}}
 */
function maskPersonalData(text) {
  let s = String(text == null ? '' : text);
  const counts = {};
  for (const [cat, { re, skip }] of Object.entries(PII_PATTERNS)) {
    let n = 0;
    s = s.replace(re, (...args) => {
      // Desenlerde adlı grup yok → son iki argüman (offset, girdi) atılınca kalan `m` dizisidir.
      if (skip(args.slice(0, -2))) return args[0];
      n++;
      return PII_MASK[cat];
    });
    counts[cat] = n;
  }
  return { text: s, counts };
}

// ─── blok ayrıştırma ────────────────────────────────────────────────────────

/**
 * Gövdedeki çitli kod bloklarından BİLİNEN adlı olanları çıkarır. CommonMark çit kuralı:
 * açılış ≥3 ` ya da ~ (en çok 3 boşluk girinti), kapanış aynı karakter ve ≥ aynı uzunluk.
 * Dıştaki ````markdown örneğinin içindeki ```akış BLOK DEĞİLDİR (içerik). Kapanmayan
 * çit dosya sonuna kadar sürer (CommonMark) ve uyarı üretir. Pure.
 * @returns {Array<{ad:string, info:string, satir:number, govde:string[], kapandi:boolean}>}
 */
function extractBlocks(body, lineOffset = 1) {
  // \r?\n: JS'de `.` \r ile eşleşmez; CRLF dosyada açılış çiti düşüyor ve Windows'ta
  // yazılmış raporun blokları sessizce kayboluyordu (test: "CRLF …").
  const lines = String(body || '').split(/\r?\n/);
  const out = [];
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!open) {
      const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (!m) continue;
      if (m[1][0] === '`' && m[2].includes('`')) continue; // satır içi kod, çit değil
      open = { fence: m[1], info: m[2].trim(), satir: i + lineOffset, govde: [] };
      continue;
    }
    const c = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
    if (c && c[1][0] === open.fence[0] && c[1].length >= open.fence.length) {
      const ad = canonicalBlockName(open.info);
      if (ad) out.push({ ad, info: open.info, satir: open.satir, govde: open.govde, kapandi: true });
      open = null;
      continue;
    }
    open.govde.push(line);
  }
  if (open) {
    const ad = canonicalBlockName(open.info);
    if (ad) out.push({ ad, info: open.info, satir: open.satir, govde: open.govde, kapandi: false });
  }
  return out;
}

/** `anahtar: değer` satırı → [katlanmış anahtar, değer] ya da null. Pure. */
function kv(line) {
  const m = /^\s*([\p{L}_][\p{L}\p{N}_-]*)\s*:\s?(.*)$/u.exec(line);
  return m ? [fold(m[1]), m[2].trim()] : null;
}

const CALLOUT_KINDS = ['bilgi', 'dikkat', 'tehlike'];
const CHART_KINDS = ['çubuk', 'çizgi', 'halka'];
const ID_SHAPE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
// KRR-03 — `karar` bloğunun karar kaydına bağı: `karar_kimligi: K-0142` (KARAR-SOZLESMESI-V1 kimliği).
const DECISION_REF = /^K-\d{1,8}$/;
const DECISION_REF_KEYS = new Set(['karar_kimligi', 'karar-kimligi', 'decision_id', 'decision-id']);
const PAGE_HEIGHT = { min: 120, max: 2000 };

/** Sayı: `3,5` · `4 649` · `%12` · `12%` kabul. Pure. */
function parseNumber(v) {
  const s = String(v).replace(/[\s\u00a0\u202f]/g, '').replace(/^%|%$/g, '');
  if (!/^[-+]?\d+(?:[.,]\d+)?$/.test(s)) return null;
  return Number(s.replace(',', '.'));
}

/**
 * Tek bloğun gramerini denetler. Bozukluk `sorunlar[]`'a gider; blok `gecerli:false`
 * olur ama YAZIM REDDEDİLMEZ. Yol ihlalleri ayrıca `yollar[]`'da döner (çağıran
 * kip 'yaz'da onları hataya çevirir). Pure.
 */
function checkBlock(block) {
  const { ad } = block;
  const sorunlar = [];
  const yollar = [];
  const add = (kod, p = {}) => sorunlar.push({ kod, params: { blok: ad, ...p } });
  const lines = block.govde;
  const nonEmpty = lines.map((l, i) => ({ l, n: i + 1 })).filter((x) => x.l.trim() !== '');
  const veri = {};

  if (!block.kapandi) add('BLOK_KAPANMADI', { satir: block.satir });
  if (nonEmpty.length === 0) {
    add('BLOK_BOS');
    return { sorunlar, yollar, veri };
  }

  switch (ad) {
    case 'kopyala': {
      const note = parseCopyNote(lines.join('\n'));
      // TextEncoder: bu dosya renderer'da da yüklenir (blocks.ts) — Buffer orada yok.
      const bytes = new TextEncoder().encode(note.metin).length;
      if (!note.metin) add('BLOK_METIN_YOK');
      else if (bytes > COPY_NOTE_MAX_BYTES) add('BLOK_BUYUK', { kb: Math.ceil(bytes / 1024), max: COPY_NOTE_MAX_BYTES / 1024 });
      Object.assign(veri, note);
      break;
    }
    case 'uyarı': {
      let tur = 'bilgi';
      const metin = [];
      for (const { l } of nonEmpty) {
        const p = kv(l);
        if (p && p[0] === 'tur') {
          const t = CALLOUT_KINDS.find((k) => fold(k) === fold(p[1]));
          if (!t) add('BLOK_DEGER', { anahtar: 'tür', deger: p[1], liste: CALLOUT_KINDS.join(', ') });
          else tur = t;
        } else metin.push(l.trim());
      }
      if (!metin.length) add('BLOK_METIN_YOK');
      Object.assign(veri, { tur, metin: metin.join('\n') });
      break;
    }
    case 'adımlar': {
      const adimlar = [];
      for (const { l, n } of nonEmpty) {
        const m = /^\s*(\d+)[.)]\s+(\S.*)$/.exec(l);
        const p = kv(l);
        if (m) {
          const beklenen = adimlar.length + 1;
          if (Number(m[1]) !== beklenen) add('BLOK_SIRA', { beklenen, bulunan: m[1] });
          adimlar.push({ metin: m[2].trim(), kare: null });
        } else if (p && p[0] === 'kare' && /^\s/.test(l) && adimlar.length) {
          adimlar[adimlar.length - 1].kare = p[1];
          yollar.push(p[1]);
        } else add('BLOK_SATIR', { satir: n, beklenen: '"1. metin" ya da girintili "kare: yol"' });
      }
      if (!adimlar.length) add('BLOK_ESIK', { min: 1, ne: 'adım', bulunan: 0 });
      veri.adimlar = adimlar;
      break;
    }
    case 'karşılaştır': {
      const rows = nonEmpty.map(({ l, n }) => ({
        n,
        cells: l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()),
      }));
      const width = rows[0].cells.length;
      if (width < 2) add('BLOK_ESIK', { min: 2, ne: 'sütun', bulunan: width });
      for (const r of rows.slice(1)) {
        if (r.cells.length !== width) add('BLOK_SUTUN', { satir: r.n, bulunan: r.cells.length, beklenen: width });
      }
      if (rows.length < 2) add('BLOK_ESIK', { min: 1, ne: 'satır (başlık dışında)', bulunan: 0 });
      Object.assign(veri, { basliklar: rows[0].cells, satirlar: rows.slice(1).map((r) => r.cells) });
      break;
    }
    case 'kanıt': {
      const kareler = [];
      for (const { l, n } of nonEmpty) {
        const p = kv(l);
        if (p && p[0] === 'dosya') {
          kareler.push({ dosya: p[1], altyazi: '' });
          yollar.push(p[1]);
        } else if (p && p[0] === 'altyazi' && kareler.length) kareler[kareler.length - 1].altyazi = p[1];
        else add('BLOK_SATIR', { satir: n, beklenen: '"dosya: yol" ve ardından isteğe bağlı "altyazı: metin"' });
      }
      if (!kareler.length) add('BLOK_ANAHTAR_YOK', { anahtar: 'dosya' });
      veri.kareler = kareler;
      break;
    }
    case 'grafik': {
      let tur = null;
      const meta = {};
      const seri = [];
      for (const { l, n } of nonEmpty) {
        // Etiket serbest metindir (boşluklu olabilir): son ":" değil İLK ":" ayırır.
        const raw = /^\s*(.+?)\s*:\s*(.*)$/.exec(l);
        if (!raw) {
          add('BLOK_SATIR', { satir: n, beklenen: '"etiket: sayı"' });
          continue;
        }
        const key = fold(raw[1]);
        if (key === 'tur') {
          tur = CHART_KINDS.find((k) => fold(k) === fold(raw[2])) || null;
          if (!tur) add('BLOK_DEGER', { anahtar: 'tür', deger: raw[2], liste: CHART_KINDS.join(', ') });
        } else if (key === 'baslik' || key === 'birim') meta[key === 'baslik' ? 'baslik' : 'birim'] = raw[2];
        else {
          const v = parseNumber(raw[2]);
          if (v === null) add('BLOK_SAYI', { etiket: raw[1].trim(), deger: raw[2] });
          else seri.push({ etiket: raw[1].trim(), deger: v });
        }
      }
      if (!tur && !sorunlar.some((s) => s.kod === 'BLOK_DEGER')) add('BLOK_ANAHTAR_YOK', { anahtar: 'tür' });
      if (!seri.length) add('BLOK_ESIK', { min: 1, ne: 'veri satırı', bulunan: 0 });
      if (tur === 'halka' && seri.some((x) => x.deger < 0)) {
        add('BLOK_DEGER', { anahtar: 'değer', deger: '< 0', liste: 'halka grafikte 0 ve üstü' });
      }
      Object.assign(veri, { tur, ...meta, seri });
      break;
    }
    case 'akış': {
      const kenarlar = [];
      const gruplar = [];
      for (const { l, n } of nonEmpty) {
        const p = kv(l);
        if (p && p[0] === 'grup') {
          const g = /^(.+?)\s*\|\s*(.+)$/.exec(p[1]);
          const uyeler = g ? g[2].split(',').map((x) => x.trim()).filter(Boolean) : [];
          if (!g || !uyeler.length) add('BLOK_SATIR', { satir: n, beklenen: '"grup: Ad | A, B"' });
          else gruplar.push({ ad: g[1].trim(), uyeler });
          continue;
        }
        const e = /^\s*(.+?)\s*(?:->|→)\s*(.+?)\s*(?::\s*(.*))?$/.exec(l);
        if (!e || !e[1].trim() || !e[2].trim() || /(->|→)/.test(e[2])) {
          add('BLOK_SATIR', { satir: n, beklenen: '"A -> B" ya da "A -> B : etiket"' });
          continue;
        }
        kenarlar.push({ kaynak: e[1].trim(), hedef: e[2].trim(), etiket: (e[3] || '').trim() });
      }
      if (!kenarlar.length) add('BLOK_ESIK', { min: 1, ne: 'bağlantı ("A -> B")', bulunan: 0 });
      Object.assign(veri, { kenarlar, gruplar });
      break;
    }
    case 'şekil': {
      const svg = lines.join('\n').trim();
      if (!/^<svg[\s>]/i.test(svg) || !/<\/svg>\s*$/i.test(svg)) {
        add('BLOK_SVG_YOK');
        break;
      }
      const temiz = [];
      const say = (re, ad2) => { const k = (svg.match(re) || []).length; if (k) temiz.push(`${ad2} (${k})`); };
      say(/<script\b/gi, 'betik');
      say(/<foreignObject\b/gi, 'foreignObject');
      say(/\son[a-z]+\s*=/gi, 'olay niteliği');
      say(/(?:xlink:)?href\s*=\s*["']?\s*(?!#)[a-z][a-z0-9+.-]*:/gi, 'dış bağlantı');
      if (temiz.length) sorunlar.push({ kod: 'BLOK_SVG_TEMIZLIK', params: { blok: ad, liste: temiz.join(', ') }, bilgi: true });
      veri.boyut = svg.length;
      break;
    }
    case 'karar': {
      const f = { secenekler: [] };
      for (const { l, n } of nonEmpty) {
        const p = kv(l);
        if (!p) { add('BLOK_SATIR', { satir: n, beklenen: '"anahtar: değer"' }); continue; }
        const [k, v] = p;
        if (k === 'secenek') {
          const s = /^(.+?)\s*\|\s*(.+)$/.exec(v);
          if (!s) { add('BLOK_SATIR', { satir: n, beklenen: '"seçenek: A | metin"' }); continue; }
          if (f.secenekler.some((x) => x.anahtar === s[1].trim())) add('BLOK_SECENEK_TEKRAR', { deger: s[1].trim() });
          else f.secenekler.push({ anahtar: s[1].trim(), metin: s[2].trim() });
        } else if (['kimlik', 'soru', 'oneri', 'varsayilan'].includes(k)) f[k] = v;
        // KRR-03 — karar kaydına bağ (ajan `karar_sor` ile açtığı kararın kimliğini yazar).
        else if (DECISION_REF_KEYS.has(k)) f.kararKimligi = v.toUpperCase();
        else add('BLOK_SATIR', { satir: n, beklenen: 'kimlik / soru / seçenek / öneri / varsayılan / karar_kimligi' });
      }
      if (!f.kimlik) add('BLOK_ANAHTAR_YOK', { anahtar: 'kimlik' });
      else if (!ID_SHAPE.test(f.kimlik)) add('BLOK_KIMLIK', { deger: f.kimlik });
      if (f.kararKimligi && !DECISION_REF.test(f.kararKimligi)) add('BLOK_KARAR_KIMLIGI', { deger: f.kararKimligi });
      if (!f.soru) add('BLOK_ANAHTAR_YOK', { anahtar: 'soru' });
      if (f.secenekler.length < 2) add('BLOK_ESIK', { min: 2, ne: 'seçenek', bulunan: f.secenekler.length });
      for (const [k, tr] of [['oneri', 'öneri'], ['varsayilan', 'varsayılan']]) {
        if (f[k] && !f.secenekler.some((x) => x.anahtar === f[k])) add('BLOK_SECENEK_YOK', { anahtar: tr, deger: f[k] });
      }
      Object.assign(veri, { kimlik: f.kimlik || null, soru: f.soru || '', secenekler: f.secenekler, oneri: f.oneri || null, varsayilan: f.varsayilan || null, kararKimligi: f.kararKimligi || null });
      break;
    }
    case 'yapılacak': {
      let kimlik = null;
      const maddeler = [];
      for (const { l, n } of nonEmpty) {
        const m = /^\s*[-*]\s+\[( |x|X)\]\s+(\S.*)$/.exec(l);
        const p = kv(l);
        if (m) maddeler.push({ metin: m[2].trim(), isaretli: m[1] !== ' ' });
        else if (p && p[0] === 'kimlik' && !maddeler.length) {
          kimlik = p[1];
          if (!ID_SHAPE.test(kimlik)) add('BLOK_KIMLIK', { deger: kimlik });
        } else add('BLOK_SATIR', { satir: n, beklenen: '"- [ ] metin" ya da "- [x] metin"' });
      }
      if (!maddeler.length) add('BLOK_ESIK', { min: 1, ne: 'madde', bulunan: 0 });
      Object.assign(veri, { kimlik, maddeler });
      break;
    }
    case 'sayfa': {
      const f = {};
      for (const { l, n } of nonEmpty) {
        const p = kv(l);
        if (p && ['dosya', 'ozet', 'yukseklik'].includes(p[0])) f[p[0]] = p[1];
        else add('BLOK_SATIR', { satir: n, beklenen: 'dosya / özet / yükseklik' });
      }
      if (!f.dosya) add('BLOK_ANAHTAR_YOK', { anahtar: 'dosya' });
      else {
        yollar.push(f.dosya);
        if (!/\.html?$/i.test(f.dosya)) add('BLOK_SAYFA_UZANTI', { deger: f.dosya });
      }
      if (!f.ozet) add('BLOK_ANAHTAR_YOK', { anahtar: 'özet' });
      let yukseklik = null;
      if (f.yukseklik != null) {
        const h = /^\d+$/.test(f.yukseklik) ? Number(f.yukseklik) : NaN;
        if (!(h >= PAGE_HEIGHT.min && h <= PAGE_HEIGHT.max)) add('BLOK_YUKSEKLIK', { deger: f.yukseklik, ...PAGE_HEIGHT });
        else yukseklik = h;
      }
      Object.assign(veri, { dosya: f.dosya || null, ozet: f.ozet || '', yukseklik });
      break;
    }
    default:
      break;
  }
  return { sorunlar, yollar, veri };
}

/**
 * RPT4-06 — `yapılacak` bloğunun defter kimliği: yazılmışsa o, yoksa rapordaki geçerli
 * yapılacak blokları arasındaki sırası (`yapilacak-1`). Okuyucu ve defter AYNI kuralı
 * kullansın diye burada (saf modül; renderer da yükler). Pure.
 */
function todoBlockId(veri, n) {
  return (veri && veri.kimlik) || `yapilacak-${n + 1}`;
}

/**
 * Gövdedeki blokları ayrıştır + denetle. Rapor genelinde karar/yapılacak kimlik
 * tekrarını da yakalar. Pure.
 * @returns {Array<{ad, satir, gecerli, veri, sorunlar, yollar}>}
 */
function parseBlocks(body, lineOffset = 1) {
  const seen = new Map();
  return extractBlocks(body, lineOffset).map((b) => {
    const r = checkBlock(b);
    const id = (b.ad === 'karar' || b.ad === 'yapılacak') && r.veri.kimlik;
    if (id) {
      if (seen.has(id)) r.sorunlar.push({ kod: 'BLOK_KIMLIK_TEKRAR', params: { blok: b.ad, deger: id } });
      seen.set(id, true);
    }
    return {
      ad: b.ad,
      satir: b.satir,
      gecerli: !r.sorunlar.some((s) => !s.bilgi),
      veri: r.veri,
      sorunlar: r.sorunlar,
      yollar: r.yollar,
    };
  });
}

// ─── rapor doğrulayıcı ──────────────────────────────────────────────────────

/**
 * Alanlar + gövde → karar. Yazım aracı (RPT4-02) alanları nesne olarak verir; dosya
 * yolu `validateReport` üzerinden ön-bilgiyi ayrıştırıp buraya gelir. Pure.
 *
 * @param {object} fields  {hukum, tip, okur, platform, gorev, ajan, ekler?: Array<string|{yol, boyut?}>}
 * @param {string} body    markdown gövde (ön-bilgisiz)
 * @param {object} [opts]  {kip:'yaz'|'oku' (varsayılan 'oku'), dil:'tr'|'en', bicim?, satirOfseti?}
 */
function validateFields(fields, body, opts = {}) {
  const kip = opts.kip === 'yaz' ? 'yaz' : 'oku';
  const dil = opts.dil === 'en' ? 'en' : 'tr';
  const f = fields || {};
  const hatalar = [];
  const uyarilar = [];
  const issue = (kod, alan, params = {}, extra = {}) => ({ kod, alan, ...extra, mesaj: render(kod, params, dil) });
  // Sözleşme ihlali: yaz kipinde hata, oku kipinde uyarı (eski rapor asla reddedilmez).
  const ihlal = (kod, alan, params, extra) => (kip === 'yaz' ? hatalar : uyarilar).push(issue(kod, alan, params, extra));
  const uyar = (kod, alan, params, extra) => uyarilar.push(issue(kod, alan, params, extra));
  const liste = TYPES.join(', ');

  // hüküm
  const hukum = String(f.hukum == null ? '' : f.hukum).trim();
  let acilis = null;
  // ⟦kural:hüküm-zorunlu⟧
  if (!hukum) ihlal('HUKUM_YOK', 'hüküm');
  // ⟦/kural⟧
  if (hukum) {
    acilis = verdictOpening(hukum);
    // ⟦kural:hüküm-açılış⟧
    if (!acilis) ihlal('HUKUM_ACILIS', 'hüküm');
    // ⟦/kural⟧
    if (acilis && !acilis.geri) ihlal('HUKUM_BOS', 'hüküm');
    if (hukum.length > VERDICT_MAX_CHARS) uyar('HUKUM_UZUN', 'hüküm', { n: hukum.length, max: VERDICT_MAX_CHARS });
  }

  // tip
  const tipRaw = String(f.tip == null ? '' : f.tip).trim();
  const tip = TYPE_BY_FOLD.get(fold(tipRaw)) || null;
  if (!tipRaw) ihlal('TIP_YOK', 'tip', { liste });
  else if (!tip) ihlal('TIP_GECERSIZ', 'tip', { deger: tipRaw, liste, oneri: suggestType(tipRaw) });

  // okur (yoksa ekip; rehber → kullanıcı; yazımda karar soran rapor → kullanıcı, bloklardan sonra)
  const okurRaw = String(f.okur == null ? '' : f.okur).trim();
  let okur = okurRaw ? READER_BY_FOLD.get(fold(okurRaw)) || null : tip === 'rehber' ? 'kullanıcı' : 'ekip';
  if (okurRaw && !okur) {
    ihlal('OKUR_GECERSIZ', 'okur', { deger: okurRaw });
    okur = 'ekip';
  }

  // platform
  const platform = String(f.platform == null ? '' : f.platform).trim();
  if (!platform) ihlal('PLATFORM_YOK', 'platform');

  const gorev = String(f.gorev == null ? '' : f.gorev).trim();
  if (!gorev) uyar('GOREV_YOK', 'görev');

  // ekler
  const ekler = [];
  const geciciKokler = Array.isArray(opts.geciciKokler) ? opts.geciciKokler : [];
  for (const e of Array.isArray(f.ekler) ? f.ekler : []) {
    const yol = typeof e === 'string' ? e : e && e.yol;
    const kod = checkRelPath(yol, { geciciKokler });
    if (kod) { ihlal(kod, 'ekler', { yol: String(yol == null ? '' : yol) }); continue; }
    ekler.push(String(yol).trim());
    const boyut = e && typeof e === 'object' ? e.boyut : undefined;
    if (/\.html?$/i.test(yol) && typeof boyut === 'number' && boyut > PAGE_MAX_BYTES) {
      ihlal('SAYFA_BOYUT', 'ekler', { yol, kb: Math.ceil(boyut / 1024), max: PAGE_MAX_BYTES / 1024 });
    }
  }

  // bloklar
  const bloklar = parseBlocks(body, opts.satirOfseti || 1);
  const ekSayfalar = [];
  for (const b of bloklar) {
    for (const s of b.sorunlar) uyar(s.kod, 'blok', s.params, { blok: b.ad, satir: b.satir });
    for (const y of b.yollar) {
      const kod = checkRelPath(y, { geciciKokler });
      if (kod) ihlal(kod, 'blok', { yol: String(y) }, { blok: b.ad, satir: b.satir });
    }
    if (b.ad === 'sayfa' && b.gecerli) ekSayfalar.push({ ...b.veri, satir: b.satir });
  }
  // RPT-SCRATCH-RULE-01 — gövdenin GÖSTERDİĞİ bağlantı/görsel geçici klasördeyse (kod çiti hariç).
  // ⟦kural:geçici-gövde⟧
  for (const yol of tempRefsOf(body, { markdown: true, kokler: geciciKokler })) ihlal('YOL_GECICI', 'gövde', { yol });
  // ⟦/kural⟧
  // REPORT-HTML-DEFAULT-01 — karar soran rapor patrona yazılmıştır: okur beyan edilmediyse
  // yazımda `kullanıcı`. Okuma yolu eski raporların okurunu DEĞİŞTİRMEZ.
  if (kip === 'yaz' && !okurRaw && bloklar.some((b) => b.ad === 'karar' && b.gecerli)) okur = 'kullanıcı';

  // kişisel veri (kategori + sayı; değer YOK)
  const kisiselVeri = scanPersonalData(`${hukum}\n${platform}\n${body || ''}`);
  const toplam = Object.values(kisiselVeri).reduce((a, b) => a + b, 0);
  if (toplam) {
    const kategoriler = Object.entries(kisiselVeri).filter(([, n]) => n).map(([k, n]) => `${k}: ${n}`).join(', ');
    uyar('KISISEL_VERI', 'gövde', { sayi: toplam, kategoriler });
  }

  return {
    surum: SCHEMA_VERSION,
    kip,
    bicim: opts.bicim || 'v3',
    gecerli: hatalar.length === 0,
    alanlar: { hukum: hukum || null, hukumSinifi: acilis ? acilis.sinif : null, tip, okur, platform: platform || null, gorev: gorev || null, ajan: f.ajan ? String(f.ajan).trim() : null },
    ekler,
    ekSayfalar,
    bloklar: bloklar.map(({ ad, satir, gecerli, veri }) => ({ ad, satir, gecerli, veri })),
    kisiselVeri,
    hatalar,
    uyarilar,
  };
}

/**
 * Markdown raporu (ön-bilgi + gövde) → karar. Varsayılan kip 'oku': eski raporlar
 * `bicim:'eski'`, hatalar her zaman boş. Pure.
 * @param {string} md
 * @param {object} [opts] {kip:'yaz'|'oku', dil:'tr'|'en', ekler?}
 */
function validateReport(md, opts = {}) {
  const { fm, body, bodyStartLine } = splitFrontmatter(md);
  const fields = {
    hukum: pick(fm, 'hüküm', 'verdict'),
    tip: pick(fm, 'tip', 'type'),
    okur: pick(fm, 'okur', 'reader'),
    platform: pick(fm, 'platform', 'platformlar'),
    gorev: pick(fm, 'görev', 'task'),
    ajan: pick(fm, 'ajan', 'agent'),
    ekler: opts.ekler,
  };
  return validateFields(fields, body, { ...opts, bicim: classifyFormat(md), satirOfseti: bodyStartLine });
}

// ─── RPT5-07a — HTML rapor (sözleşme v3 §6) ─────────────────────────────────

/** Rapor biçimleri: künyede `biçim:` yoksa markdown. */
const FORMATS = Object.freeze(['md', 'html']);

/**
 * Sayfadaki `kanit:<ad>` göndermeleri (src/href/srcset/CSS url()). Sıra korunur, tekrar
 * yok. Yol kuralını UYGULAMAZ (o `validateHtmlPage`te). `reportHtmlText` de bunu kullanır. Pure.
 * @returns {string[]}
 */
function evidenceRefs(html) {
  const seen = new Set();
  for (const m of String(html || '').matchAll(/kanit:([^\s"'<>()`,]+)/gi)) {
    const ad = m[1].replace(/[.;]+$/, '');
    if (ad) seen.add(ad);
  }
  return [...seen];
}

// Dış kaynak: kafes (RPT4-05 CSP) bunları zaten yüklemez; yazara SÖYLEMEK için sayılır.
const EXTERNAL = Object.freeze([
  ['script src', /<script\b[^>]*?\bsrc\s*=\s*["']?\s*(?:https?:)?\/\//gi],
  ['link href', /<link\b[^>]*?\bhref\s*=\s*["']?\s*(?:https?:)?\/\//gi],
  ['@import', /@import\s+(?:url\(\s*)?["']?\s*(?:https?:)?\/\//gi],
  ['fetch(', /(?<![\w$.])fetch\s*\(/g],
]);

/**
 * HTML raporun SAYFASI → karar (sözleşme v3 §6.3). Künye alanları burada DEĞİL,
 * `validateFields`te denetlenir (hüküm zorunluluğu tek yerde). Kip 'yaz'da boş/HTML-değil/
 * büyük sayfa ve yol kuralını çiğneyen `kanit:` adı RED; dış kaynak ve kişisel veri her
 * kipte UYARI (kişisel veri: kategori + sayı, değer dönmez). `kanit:` adının diskte olup
 * olmadığı IO katmanının işi (`KANIT_YOK`). Pure.
 *
 * @param {string} html
 * @param {{kip?:'yaz'|'oku', dil?:'tr'|'en', kod?:string}} [opts] `kod` → ileti "<KOD>-evidence/" der
 * @returns {{gecerli:boolean, bayt:number, disKaynak:object, kanitlar:string[],
 *            kisiselVeri:{eposta:number, telefon:number}, hatalar:object[], uyarilar:object[]}}
 */
function validateHtmlPage(html, opts = {}) {
  const kip = opts.kip === 'yaz' ? 'yaz' : 'oku';
  const dil = opts.dil === 'en' ? 'en' : 'tr';
  const s = String(html == null ? '' : html);
  const hatalar = [];
  const uyarilar = [];
  const issue = (kod, params = {}) => ({ kod, alan: 'sayfa', mesaj: render(kod, params, dil) });
  const ihlal = (kod, params) => (kip === 'yaz' ? hatalar : uyarilar).push(issue(kod, params));
  // TextEncoder: bu dosya renderer'da da yüklenir — Buffer orada yok.
  const bayt = new TextEncoder().encode(s).length;
  const klasor = `${opts.kod ? String(opts.kod) : '<KOD>'}-evidence/`;

  // ⟦kural:sayfa-boyut⟧
  if (!s.trim()) ihlal('SAYFA_BOS');
  else if (!/<[a-z!][^>]*>/i.test(s)) ihlal('SAYFA_HTML_DEGIL');
  if (bayt > HTML_PAGE_MAX_BYTES) ihlal('SAYFA_BUYUK', { kb: Math.ceil(bayt / 1024), max: HTML_PAGE_MAX_BYTES / 1024, klasor });
  // ⟦/kural⟧

  const disKaynak = {};
  for (const [ad, re] of EXTERNAL) {
    const n = (s.match(re) || []).length;
    if (n) disKaynak[ad] = n;
  }
  const dk = Object.entries(disKaynak);
  if (dk.length) uyarilar.push(issue('DIS_KAYNAK', { liste: dk.map(([k, n]) => `${k} ×${n}`).join(', ') }));

  // RPT-SCRATCH-RULE-01 — sayfanın gösterdiği `file://`/mutlak bağlantı geçici klasördeyse: o dosya
  // yeniden başlatmada silinir, Raporlar'daki sayfa kırık kalır.
  const geciciKokler = Array.isArray(opts.geciciKokler) ? opts.geciciKokler : [];
  // ⟦kural:geçici-sayfa⟧
  for (const yol of tempRefsOf(s, { kokler: geciciKokler })) ihlal('YOL_GECICI', { yol });
  // ⟦/kural⟧

  const kanitlar = [];
  for (const ad of evidenceRefs(s)) {
    const kod = checkRelPath(ad, { geciciKokler });
    if (kod) { ihlal(kod, { yol: `kanit:${ad}` }); continue; }
    kanitlar.push(ad);
  }

  // Ham sayfa taranır: kişisel veri betik içindeki gömülü veride de olabilir.
  const kisiselVeri = scanPersonalData(s);
  const toplam = Object.values(kisiselVeri).reduce((a, b) => a + b, 0);
  if (toplam) {
    const kategoriler = Object.entries(kisiselVeri).filter(([, n]) => n).map(([k, n]) => `${k}: ${n}`).join(', ');
    uyarilar.push({ kod: 'KISISEL_VERI', alan: 'sayfa', mesaj: render('KISISEL_VERI', { sayi: toplam, kategoriler }, dil) });
  }
  return { gecerli: hatalar.length === 0, bayt, disKaynak, kanitlar, kisiselVeri, hatalar, uyarilar };
}

/**
 * Künyeye göre raporun HTML sayfası (sözleşme v3 §6.2). Okuyucu biçimi BUNA bakarak seçer,
 * HTML'in içinden tahmin etmez. `biçim: html` değilse ya da `sayfa` geçersizse null.
 * `dosyaAdi` (`.md`'nin adı) verilirse sayfa adı onun gövde adıyla AYNI olmalı. Pure.
 * @param {string} md
 * @param {string} [dosyaAdi] ör. `RPT5-07a-wheeljack.md`
 * @returns {{sayfa:string}|null}
 */
function htmlPageOf(md, dosyaAdi) {
  const fm = frontmatter(md);
  if (fold(pick(fm, 'biçim', 'format') || '') !== 'html') return null;
  const sayfa = String(pick(fm, 'sayfa', 'page') || '').trim();
  if (!sayfa || /[\\/]/.test(sayfa) || checkRelPath(sayfa) || !/\.html?$/i.test(sayfa)) return null;
  if (dosyaAdi) {
    const base = String(dosyaAdi).split(/[\\/]/).pop().replace(/\.md$/i, '');
    if (sayfa.replace(/\.html?$/i, '') !== base) return null;
  }
  return { sayfa };
}

// ─── KRR-AGENT-FLOW-01 — düz yazı karar sorusu ──────────────────────────────
//
// Ölçüm (02.10): 1.692 raporda "Açık sorular" düz yazı bölümü vardı, karar kaydına bağlı
// rapor 1. Kullanıcının kararı düz yazıda kayboluyor. Bu dedektör "kullanıcıya soru"
// başlıklı bölümde gerçek madde var mı diye bakar; "Yok", "—", "Yok (… kararı verildi)"
// sayılmaz. Markdown başlığı (`## 5. Açık sorular`), kalın satır (`**Açık sorular:**`) ve
// etiket satırı (`Açık sorular: …`) tanınır; kod çitinin içi atlanır. HTML rapor
// `htmlToText` ile aynı başlık biçimine iner. Pure.

const OPEN_Q_HEAD = /^(?:\d+[.)]\s*)?(?:acik\s+(?:sorular?|konular?|kararlar?)|open\s+(?:questions?|decisions?)|(?:murat|kullanici|patron|lider)(?:'?[ae])?\s+(?:sorular?|soru)|karar(?:\s+bekleyen(?:ler)?|lar?\s+bekleniyor|\s+gerekenler?|\s+bekliyor)|bekleyen\s+kararlar?|questions?\s+for\s+(?:the\s+)?(?:user|murat|you|owner)|decisions?\s+(?:needed|pending|required)|pending\s+decisions?)\b/;
const OPEN_Q_NONE = /^(?:yok|hayir|none|no\b|n\/a|-+|—|bulunmuyor|kalmadi|acik\s+(?:soru|karar)\s+(?:yok|kalmadi)|soru\s+yok|karar\s+yok|no\s+open|nothing)/;
const MD_HEAD = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const BOLD_HEAD = /^ {0,3}(?:\*\*|__)(.+?)(?:\*\*|__)\s*:?\s*(.*)$/;
const LABEL_HEAD = /^ {0,3}([^:]{3,60}):\s*(.*)$/;
const ITEM = /^\s*(?:[-*+•]|\d{1,2}[.)])\s+(.+)$/;

// Madde SORU mu: soru işareti ya da karar sözcüğü. "Ölçülmedi", "bulgu", "izlenmeli" gibi bilgi
// notları bu başlığın altına da yazılıyor (örneklemde 12/38 yanlış alarm) — onlar sayılmaz.
const OPEN_Q_ASK = /\?|\b(?:karar|onay|oneri|onerim|secenek|tercih|yoksa|ister\s+mi|should|whether|decide|decision|approve|which)\b|\b(?:mi|mu)\b/;
const cleanHead = (s) => fold(String(s).replace(/[*_`#>]/g, '').replace(/\s+/g, ' ')).replace(/[:.\s]+$/, '');
const isNone = (s) => OPEN_Q_NONE.test(fold(String(s).replace(/[*_`]/g, '').replace(/^\s*(?:[-*+•]|\d{1,2}[.)])\s+/, '')).trim());
const isAsk = (s) => OPEN_Q_ASK.test(fold(String(s).replace(/`[^`]*`/g, ' ')));

/**
 * Raporun "kullanıcıya açık soru" bölümleri ve içlerindeki madde sayısı. Pure.
 * @param {string} text  markdown gövde (ya da `htmlToText().metin`)
 * @returns {Array<{baslik:string, satir:number, sorular:number, ornek:string}>}
 */
function openQuestionSections(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let cur = null;
  let fence = null;
  const close = () => {
    if (!cur) return;
    const items = cur.items.filter((x) => x && !isNone(x) && isAsk(x));
    // İlk madde "Yok …" ise geri kalan açıklamadır (ör. "Yok. Not: …").
    const first = cur.items.find((x) => x);
    if (items.length && !(first && isNone(first))) out.push({ baslik: cur.baslik, satir: cur.satir, sorular: items.length, ornek: items[0].slice(0, 120) });
    cur = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; continue; }
    if (f) { fence = f[1]; continue; }
    const md = MD_HEAD.exec(line);
    const bold = !md && BOLD_HEAD.exec(line);
    const label = !md && !bold && !ITEM.test(line) && LABEL_HEAD.exec(line);
    const head = md ? { ad: md[2], level: md[1].length, rest: '' }
      : bold ? { ad: bold[1], level: 7, rest: bold[2] }
        : label && OPEN_Q_HEAD.test(cleanHead(label[1])) ? { ad: label[1], level: 7, rest: label[2] } : null;
    if (head) {
      // Kalın/etiket başlığı yalnız başka bir kalın/etiket ya da HER markdown başlığıyla kapanır;
      // markdown başlığı yalnız kendi düzeyi ya da üstüyle.
      if (cur && (head.level <= cur.level || cur.level === 7)) close();
      if (!cur && OPEN_Q_HEAD.test(cleanHead(head.ad))) {
        cur = { baslik: String(head.ad).replace(/[*_`]/g, '').trim(), satir: i + 1, level: head.level, items: [] };
        if (head.rest.trim()) cur.items.push(head.rest.trim());
      }
      continue;
    }
    if (!cur) continue;
    const t = line.trim();
    if (!t) { cur.br = true; continue; }
    const it = ITEM.exec(line);
    // Girintili alt madde, üst maddenin açıklamasıdır — ayrı soru sayılmaz.
    if (it && /^\s{2,}/.test(line) && cur.items.length) continue;
    if (it) cur.items.push(it[1].trim());
    else if (cur.items.length && !cur.br) cur.items[cur.items.length - 1] += ` ${t}`;
    else cur.items.push(t);
    cur.br = false;
  }
  close();
  return out;
}

/** Raporun gövdesinde karar KAYDINA bağlı (karar_kimligi'li) geçerli karar bloğu sayısı. Pure. */
function linkedDecisionCount(body) {
  return parseBlocks(body).filter((b) => b.ad === 'karar' && b.veri && b.veri.kararKimligi).length;
}

module.exports = {
  SCHEMA_VERSION,
  TYPES,
  READERS,
  BLOCKS,
  BLOCK_ALIASES,
  COPY_NOTE_MAX_BYTES,
  PAGE_MAX_BYTES,
  HTML_PAGE_MAX_BYTES,
  FORMATS,
  VERDICT_MAX_CHARS,
  MESSAGES,
  render,
  fold,
  canonicalBlockName,
  parseCopyNote,
  suggestType,
  frontmatter,
  splitFrontmatter,
  classifyFormat,
  verdictOpening,
  checkRelPath,
  isTempPath,
  shownFileRefs,
  tempRefsOf,
  scanPersonalData,
  maskPersonalData,
  PII_MASK,
  extractBlocks,
  parseBlocks,
  todoBlockId,
  validateFields,
  validateReport,
  evidenceRefs,
  validateHtmlPage,
  htmlPageOf,
  openQuestionSections,
  linkedDecisionCount,
};
