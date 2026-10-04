// CrewPane — ADP-920 / AD-DELEG-01 / ENT-F1: GÖNDERİM HÜKMÜ + ENTER TEKRARI.
//
// ─────────────────────────────────────────────────────────────────────────────
// ÖLÇÜLEN KÖK NEDEN (ADP-920)
// ─────────────────────────────────────────────────────────────────────────────
// Bir agent TUI'sine prompt teslimi İKİ yazımdır: (1) metin (bracketed-paste),
// (2) submit Enter'ı. Arada SABİT bir boşluk vardı ve Enter yazıldıktan sonra
// HİÇBİR ŞEY doğrulanmıyordu. TUI yapıştırılan bloğu kendi render döngüsünde
// yutar; makine yüklüyken o döngü yavaşlar, boşluk yetmez, Enter yutulur.
// Sonuç: composer'da `> [Pasted text #1 +6 lines]` asılı kalır, worker HİÇ
// başlamaz. Çözüm TAHMİN değil ÖLÇÜM: Enter'dan sonra pane'in KENDİ çıktısından
// "composer boşaldı mı" türetilir, boşalmadıysa Enter ARTAN gecikmeyle (400 →
// 800 → 1500ms) TEKRARLANIR.
//
// GÜVENLİK SINIRI — Enter yalnız `text` (prompt işaretçisinin yanında metin)
// hâlinde tekrarlanır. Açık menü / okunamayan ekran ('menu' · 'unknown') →
// TEKRAR YOK: oralarda Enter basmak bir SEÇİM yapar ya da kabukta komut
// çalıştırır. Yeni PASTE asla gönderilmez — yalnız `\r`.
//
// ─────────────────────────────────────────────────────────────────────────────
// ENT-F1 — NEDEN BU DOSYA MAIN'DE (taşındı, KOPYALANMADI)
// ─────────────────────────────────────────────────────────────────────────────
// ENT-R1 §1c ölçtü: ADP-920 + AD-DELEG-01 korumaları YALNIZ renderer'da yaşıyordu
// (`src/app/lib/submitVerify.ts`), oysa pane'e prompt yazan dört yol ANA SÜREÇTE:
//
//   P0 delegationSupervisor.cjs — teslim edilmemiş prompt'un yeniden gönderimi
//      (bugün metni yazıp ENTER'I HİÇ BASMIYORDU — gerçek claude 2.1.246 ile
//       tekrar üretildi: `paste again to expand` çipi + oturum defteri BOŞ)
//   P1 delegationSupervisor.cjs — lider uyandırma (metin + `\r`, 0 ms boşluk)
//   P2 main.js writePromptToPane — devir özeti (400 ms sabit, doğrulama yok)
//   P3 main.js `/clear` dizisi   — 22 sıfırlamanın 4'ü TUTMAMIŞ (canlı log)
//
// Main CJS'ten renderer TS'i require EDİLEMEZ. Bu yüzden saf çekirdek buraya
// TAŞINDI ve `src/app/lib/submitVerify.ts` artık YALNIZ buradan re-export eder:
// TEK uygulama, İKİ tüketici. İkinci bir kopya yazmak AD-DELEG-01'in "üçüncü
// composer okuyucusu YAZILMAYACAK" kararıyla çelişirdi.
// Sapma kapısı: `electron/submitOutcome.test.cjs` (TS tarafı gövde taşıyor mu?).
//
// Leaf-modül disiplini: tek bağımlılık `leaderComposer.cjs` (saf, leaf) →
// `node --test` doğrudan koşar.

'use strict';

const { composerScan } = require('./leaderComposer.cjs');

/**
 * ARTAN gözlem gecikmeleri. Her eleman: "şu kadar bekle, sonra ölç". Ölçüm
 * 'pending' derse Enter tekrarlanır ve bir sonraki (daha uzun) gecikmeye geçilir.
 * Son elemandan sonra bir gözlem daha yapılır → log "başardı mı"yı yazabilir.
 */
const DEFAULT_SUBMIT_RETRY_DELAYS_MS = Object.freeze([400, 800, 1500]);

/** Yük-farkında submit boşluğu için taban/artış/tavan (ms). */
const DEFAULT_SUBMIT_GAP_MS = 400;
const SUBMIT_GAP_PER_PANE_MS = 150;
const MAX_SUBMIT_GAP_MS = 1500;

/**
 * ADP-920 (ikincil) — submit boşluğunu YÜKE göre büyüt. Yük vekili = o an canlı
 * pane sayısı (her canlı worker bir TUI render döngüsü + bir motor süreci).
 * İlk iki pane ücretsiz; sonrası pane başına `SUBMIT_GAP_PER_PANE_MS`, tavan
 * `MAX_SUBMIT_GAP_MS`. Bu bir OPTİMİZASYONDUR — doğruluğu sağlayan şey aşağıdaki
 * doğrulama/tekrar döngüsüdür; bu yalnız tekrar ihtiyacını azaltır.
 * @param {number} paneCount
 * @param {number} [baseMs]
 */
function submitGapForLoad(paneCount, baseMs = DEFAULT_SUBMIT_GAP_MS) {
  const base = Math.max(0, Number.isFinite(baseMs) ? baseMs : DEFAULT_SUBMIT_GAP_MS);
  if (base <= 0) return 0; // kabuk pane'i (atomik yazım) — davranış korunur
  const n = Number.isFinite(paneCount) ? Math.max(0, Math.floor(paneCount)) : 0;
  return Math.min(MAX_SUBMIT_GAP_MS, base + SUBMIT_GAP_PER_PANE_MS * Math.max(0, n - 2));
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * GÖNDERİLMEMİŞ YAPIŞTIRMA ÇİPİ — claude 2.1.222'de ÖLÇÜLDÜ (uydurulmadı)
 * ─────────────────────────────────────────────────────────────────────────────
 * claude composer'ı `│`/`╭` kutusuyla ÇİZMİYOR; ÇOK SATIRLI bir prompt composer
 * satırında HİÇ GÖRÜNMEZ — ayrı bir "çip" olarak çizilir:
 *
 *   ❯ Try "edit <filepath> to..."          ← composer BOŞ görünür (yer tutucu!)
 *   ⏵⏵ bypass permissions on
 *   [Pasted text #1 +124 lines]            ← GÖNDERİLMEMİŞ yapıştırma AŞAĞIDA
 *   paste again to expand
 *
 * 🪤 ÇİP SCROLLBACK'TE KALIR → kural KONUMSALDIR: yalnız SON EKRAN (son
 *    `CHIP_WINDOW` karakter) sorgulanır.
 * 🪤 TUI imleç konumlamayla çizdiği için ANSI şeritlendikten sonra kelimeler
 *    BİTİŞİK kalabiliyor → kalıp BOŞLUKSUZ eşlenir.
 */
const CHIP_WINDOW = 500;
const PASTE_CHIP_FLAT = /pasteagaintoexpand|\[pastedtext#\d+/i;

/** Son ekranda GÖNDERİLMEMİŞ yapıştırma çipi duruyor mu? (saf) */
function pendingPasteChip(buffer) {
  if (typeof buffer !== 'string' || !buffer) return false;
  return PASTE_CHIP_FLAT.test(buffer.slice(-CHIP_WINDOW).replace(/\s+/g, ''));
}

// AD-DELEG-01 — `RUNNING_HINTS`in düzleştirilmiş ikizi (boşluk yutan TUI çizimi
// için). leaderComposer'daki kalıbın kopyası DEĞİL bir TÜREVİDİR: orası satır
// bazlı çalışır, burada KONUM karşılaştırması gerekiyor.
const RUNNING_HINT_FLAT = /esctointerrupt|ctrl\+cto(stop|interrupt)/gi;

/**
 * AD-DELEG-01 — Çip GÖNDERİLMEMİŞ bir yapıştırmayı mı gösteriyor, yoksa
 * gönderilmiş bir turun SCROLLBACK artığı mı? Ayırt edici KONUMDUR:
 *   • çip … sonra `esc to interrupt` → yapıştırma GÖNDERİLDİ (artık)  → false
 *   • `esc to interrupt` … sonra çip → Enter YUTULDU, çip DİPTE asılı → true
 */
function unsentPasteChip(buffer) {
  if (!pendingPasteChip(buffer)) return false;
  const flat = buffer.slice(-CHIP_WINDOW).replace(/\s+/g, '');
  const lastIdx = (re) => {
    let idx = -1;
    for (const m of flat.matchAll(re)) idx = m.index === undefined ? idx : m.index;
    return idx;
  };
  const runIdx = lastIdx(RUNNING_HINT_FLAT);
  if (runIdx < 0) return true; // koşu imzası yok → çip son söz
  return lastIdx(new RegExp(PASTE_CHIP_FLAT.source, 'gi')) > runIdx;
}

/**
 * Pane çıktısından gönderim hükmü (saf). 'unknown' = ölçemedim (asla tekrar etme).
 *
 * SIRA ÖNEMLİ: çip kontrolü composer okumasından ÖNCE gelir, çünkü çipin çizildiği
 * sürümde composer satırı YER TUTUCU gösterir ve 'empty' okunur — yani "gönderildi"
 * yalanı tam da arızanın olduğu karede üretilirdi.
 *
 * AD-DELEG-01 — ÇİP, 'running'İN DE ÖNÜNDEDİR: ekrandaki `esc to interrupt` ESKİ
 * turun kanıtıdır, BİZİM Enter'ımızın DEĞİL (32 dk'dır koşan pane'e teslim →
 * prompt hiç gönderilmedi, hüküm yanlışlıkla 'submitted' oldu).
 * @param {string} buffer
 * @returns {'submitted'|'pending'|'unknown'}
 */
function submitOutcome(buffer) {
  const scan = composerScan(buffer);
  if (unsentPasteChip(buffer)) return 'pending';
  if (scan === 'running') {
    // Yalnız 'text' → 'pending': 'menu' (açık seçim) ve okunamayan ekranda Enter
    // TEKRARLANMAZ — ADP-920'nin güvenlik sınırı aynen korunur.
    return composerScan(buffer, { ignoreRunning: true }) === 'text' ? 'pending' : 'submitted';
  }
  switch (scan) {
    case 'text':
      return 'pending';
    case 'empty':
      return 'submitted';
    default:
      return 'unknown';
  }
}

/**
 * Enter'dan SONRA çalışır: composer boşaldı mı ÖLÇ, boşalmadıysa Enter'ı ARTAN
 * gecikmeyle TEKRARLA. Asla throw etmez (teslim yolu bir doğrulama hatasıyla
 * bozulamaz) ve ASLA yeni metin yazmaz.
 *
 * @param {string} paneId
 * @param {{readPane:(id:string)=>Promise<string>|string, write:(id:string,data:string)=>unknown,
 *          sleep:(ms:number)=>Promise<void>, delaysMs?:readonly number[],
 *          log?:(line:string)=>void}} deps
 * @returns {Promise<{outcome:'submitted'|'pending'|'unknown', retries:number,
 *                    observations:Array<'submitted'|'pending'|'unknown'>, measured:boolean}>}
 *
 * ⚠️ `observations` `string[]` DEĞİL: her eleman `submitOutcome()`ın hükmüdür.
 * JSDoc'ta `string[]` yazmak `src/app/lib/submitVerify.ts`in `SubmitOutcome[]`
 * sözleşmesiyle ayrışıyordu ve `next build`i KIRIYORDU (tsc, .cjs'in JSDoc'undan
 * tip çıkarıyor). Daraltma yalnız BEYANDA — çalışma zamanı davranışı aynı.
 */
async function verifyAndRetrySubmit(paneId, deps) {
  const delays = deps.delaysMs && deps.delaysMs.length ? deps.delaysMs : DEFAULT_SUBMIT_RETRY_DELAYS_MS;
  const observations = [];
  let retries = 0;
  let outcome = 'unknown';
  // delays.length gözlem + tekrar, ardından SON bir gözlem (sonucu loglayabilmek için).
  //
  // 🔑 'unknown' DÖNGÜYÜ BİTİRMEZ. Gerçek koşuda ÖLÇÜLEN hataydı: 400ms'de TUI çipi
  // HENÜZ ÇİZMEMİŞTİ → hüküm 'unknown' → döngü çıkıyor → asılı prompt kurtarılmadan
  // kalıyordu. "Ölçemedim" ile "gönderildi" AYNI ŞEY DEĞİLDİR: yalnız 'submitted'
  // erken çıkış sebebidir; 'unknown'da bekleyip YENİDEN ÖLÇERİZ — ama YAZMAYIZ.
  for (let i = 0; i <= delays.length; i++) {
    const wait = delays[Math.min(i, delays.length - 1)];
    try {
      await deps.sleep(wait);
    } catch {
      break;
    }
    let buffer = '';
    try {
      buffer = (await deps.readPane(paneId)) || '';
    } catch {
      buffer = '';
    }
    outcome = submitOutcome(buffer);
    observations.push(outcome);
    if (outcome === 'submitted') break;
    if (outcome !== 'pending') continue; // ölçemedik → bekle ve TEKRAR ÖLÇ (yazma YOK)
    if (i >= delays.length) break; // son tur: yalnız ölç, bir daha yazma
    try {
      deps.write(paneId, '\r');
      retries++;
    } catch {
      break;
    }
  }
  const measured = observations.some((o) => o !== 'unknown');
  if (deps.log && (retries > 0 || outcome === 'pending')) {
    deps.log(
      `ADP-920 submit-retry pane=${paneId} tekrar=${retries} sonuç=${outcome} ` +
        `gözlemler=[${observations.join(',')}]`,
    );
  }
  return { outcome, retries, observations, measured };
}

module.exports = {
  DEFAULT_SUBMIT_RETRY_DELAYS_MS,
  DEFAULT_SUBMIT_GAP_MS,
  SUBMIT_GAP_PER_PANE_MS,
  MAX_SUBMIT_GAP_MS,
  submitGapForLoad,
  pendingPasteChip,
  unsentPasteChip,
  submitOutcome,
  verifyAndRetrySubmit,
};
