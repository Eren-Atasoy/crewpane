// CrewPane — B-01 Faz A: GÖREV KODU TEK KAYNAĞI (GIT-BACKBONE-SPEC §2.3, bulgu F-6).
//
// ─────────────────────────────────────────────────────────────────────────────
// NEDEN AYRI MODÜL
// ─────────────────────────────────────────────────────────────────────────────
// Görev kodu bugün İKİ ayrı işe yarıyor ve yarın ÜÇÜNCÜSÜ geliyor:
//   1. ikiz-spawn kapısı        (taskClaim.cjs — "aynı görev zaten uçuşta mı")
//   2. board statü senkronu     (boardTaskSync.cjs — başlıkta kod TAM TOKEN mı)
//   3. YENİ: branch + worktree adı (branchName.cjs / worktreePath.cjs)
//
// Üçü FARKLI regex'lerle yaşarsa "aynı görev" tanımı üç yerde ayrışır — ve bu zaten
// OLDU: `taskClaim.cjs`'in regex'i `ADP-\d+ | AD-\d+ | TASK-[A-Z0-9]{6,}` idi, yani
// **`B-01`, `A-02`, `C-07`, `W-03`, `DF-01` biçimlerini HİÇ eşleştirmiyordu.** Etiketi
// yalnız kısa kod taşıyan bir görevde ikiz kapısı hiç ateşlenmedi (B-01k ölçümü, F-6).
// B-01k spike'ının kendisi tam olarak böyle çift-spawn edildi (F-8).
//
// ─────────────────────────────────────────────────────────────────────────────
// YANLIŞ-POZİTİF DENGESİ (spec'in ham regex'ine göre BİLİNÇLİ daralma)
// ─────────────────────────────────────────────────────────────────────────────
// Ham `[A-Z]{1,4}-\d+` deseni "UTF-8", "SHA-256", "RFC-793", "ADR-014" gibi
// GÖREV OLMAYAN dizeleri de yakalar. Bir etiket "UTF-8 kodlamasını düzelt" ise
// kodun `UTF-8` çıkması iki gerçek zarar üretir:
//   • branch `task/utf-8` — yanlış ama zararsız;
//   • ikiz kapısı "UTF-8" geçen İKİ AYRI görevi aynı görev sanar → ikinci ajan
//     REDDEDİLİR (yanlış-pozitif blok, gerçek iş kaybı).
// Bu yüzden çıkarım ÜÇ KADEMELİDİR ve güven sırasına göre okur:
//   K1. `TASK-[A-Z0-9]{6,}` — board id, hiçbir yerde kazara oluşmaz (nerede olursa)
//   K2. Etiketin BAŞINDAKİ kısa kod — ofis konvansiyonu ("B-01 · …", "ADP-894 — …")
//   K3. Metnin İÇİNDEKİ kısa kod — ama NOT_A_TASK ön eki değilse
// K1'in K2'den önce gelmemesi bilinçli: K3 kararı (§2.3) kısa kodu TERCİH eder,
// board id yalnız kısa kod yoksa kullanılır. Bu yüzden gerçek sıra K2 → K1 → K3.
//
// ─────────────────────────────────────────────────────────────────────────────
// GERİYE UYUM
// ─────────────────────────────────────────────────────────────────────────────
// `taskCodeOf` bugünkü `taskClaim.taskCodeOf` ile aynı imzayı taşır ve BÜYÜK HARF
// normalize kod döner (ADP-894, TASK-MSOS…) — taskClaim onu kopyalamaz, ÇAĞIRIR.
// Tek davranış farkı: eskiden `null` dönen kısa-kod biçimleri artık kod döner
// (F-6 düzeltmesinin ta kendisi).
//
// SAF: yalnız node builtins yok — hiç require YOK. `node --test` doğrudan koşar.

'use strict';

/** Kod uzunluk tavanı — branch adı ve dosya yolu sınırlarının üst sınırı. */
const MAX_CODE_LEN = 40;

/** Board id: `TASK-` + en az 6 alfanümerik. Kazara oluşmaz → en güvenilir kademe. */
const BOARD_ID = /\bTASK-[A-Z0-9]{6,}\b/;

/**
 * Kısa ofis kodu: 1-4 harf + `-` + rakamlar + isteğe bağlı TEK harf soneki.
 * (`ADP-927`, `AD-26`, `B-01K`, `DF-01`, `W-03V`). Sonek küçük harfle yazılır ama
 * karşılaştırma büyük harf üzerinden yapılır.
 */
const SHORT_CODE = /\b([A-Z]{1,4}-\d{1,6}[A-Z]?)\b/;
const SHORT_CODE_ANCHORED = /^([A-Z]{1,4}-\d{1,6}[A-Z]?)\b/;

/**
 * GÖREV OLMAYAN ön ekler — `[A-Z]{1,4}-\d+` şeklinde görünen ama teknik sabit olan
 * dizeler. YALNIZ K3'te (metin içi arama) uygulanır: bir etiket gerçekten "UTF-8 …"
 * diye BAŞLIYORSA (K2) onu kod saymak da yanlış olurdu — o yüzden liste K2'de de
 * geçerlidir. Liste ölçüme göre büyür; eksik bir giriş yalnız garip bir branch adı
 * üretir, veri kaybı YAPMAZ.
 */
const NOT_A_TASK = new Set([
  'UTF', 'SHA', 'RFC', 'ISO', 'MD', 'SHA1', 'AES', 'RSA', 'EC', 'IPV', 'HTTP',
  'ADR', 'PG', 'ES', 'ISO8601', 'CVE', 'PEP', 'RGB', 'UTC', 'GMT', 'X', 'H',
]);

/** `PREFIX-123X` → `PREFIX`. */
function prefixOf(code) {
  const i = code.indexOf('-');
  return i > 0 ? code.slice(0, i) : code;
}

function isTaskish(code) {
  return !NOT_A_TASK.has(prefixOf(code));
}

/**
 * Etiket/başlıktan görev kodunu çıkar (SAF).
 *
 * @param {unknown} label spawn etiketi ya da board başlığı
 * @returns {string|null} BÜYÜK HARF normalize kod (`B-01K`, `ADP-927`, `TASK-…`) ya da null
 */
function taskCodeOf(label) {
  if (typeof label !== 'string' || !label) return null;
  const up = label.toUpperCase();

  // K2 — etiketin başındaki kısa kod (ofis konvansiyonu). Baştaki süsler atılır.
  const head = up.replace(/^[\s\-–—*#[(]+/, '');
  const anchored = SHORT_CODE_ANCHORED.exec(head);
  if (anchored && isTaskish(anchored[1]) && anchored[1].length <= MAX_CODE_LEN) return anchored[1];

  // K1 — board id (nerede geçerse geçsin; kazara oluşmaz).
  const board = BOARD_ID.exec(up);
  if (board && board[0].length <= MAX_CODE_LEN) return board[0];

  // K3 — metin içindeki ilk GÖREVE BENZER kısa kod.
  let rest = up;
  for (;;) {
    const m = SHORT_CODE.exec(rest);
    if (!m) return null;
    if (isTaskish(m[1]) && m[1].length <= MAX_CODE_LEN) return m[1];
    rest = rest.slice(m.index + m[1].length);
  }
}

/**
 * Kodu dosya-sistemi/branch güvenli SLUG'a çevir (SAF).
 *
 * Küçük harf ZORUNLU (§2.3): macOS dosya sistemi büyük/küçük harfe duyarsızdır ve
 * `refs/heads/task/B-01` ile `refs/heads/task/b-01` aynı dosyaya düşüp çakışır.
 * Beklenmedik karakter kalırsa (savunma katmanı — `taskCodeOf` zaten üretmez) slug
 * REDDEDİLİR: sessizce temizlemek `../` gibi bir girdiyi zararsız gösterirdi.
 *
 * @param {unknown} code
 * @returns {string|null} `b-01k` | `task-msosasha4hpbw` | null
 */
function codeSlug(code) {
  if (typeof code !== 'string') return null;
  const s = code.trim().toLowerCase();
  if (!s || s.length > MAX_CODE_LEN) return null;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(s)) return null;
  if (s.includes('..')) return null; // yol traversali (G-3) — asla temizlenmez, reddedilir
  return s;
}

/**
 * Etiketten doğrudan slug (kısayol). Kod bulunamazsa null.
 * @param {unknown} label
 */
function slugOf(label) {
  return codeSlug(taskCodeOf(label));
}

/**
 * İki etiket AYNI göreve mi ait? (ikiz kapısının tek karşılaştırma noktası)
 * Kod çıkarılamayan taraf ASLA eşleşmez — isimsiz işi engellemek yanlış-pozitiftir.
 */
function sameTask(labelA, labelB) {
  const a = taskCodeOf(labelA);
  const b = taskCodeOf(labelB);
  return !!a && !!b && a === b;
}

module.exports = { MAX_CODE_LEN, NOT_A_TASK, taskCodeOf, codeSlug, slugOf, sameTask };
