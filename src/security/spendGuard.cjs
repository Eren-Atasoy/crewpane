// CrewPane — TOK-C (D-02 v2): HARCAMA KAPISI — "bu yazım parayı harcar mı,
// harcayacaksa bütçe buna izin veriyor mu?"
//
// ─────────────────────────────────────────────────────────────────────────────
// NEDEN AYRI BİR MODÜL
// ─────────────────────────────────────────────────────────────────────────────
// TOK-C'nin ilk turunda fren YALNIZ `pty:writeGuarded` kapısına takıldı ve rapor
// o kapıyı "sistemin bir pane'e iş yazdığı TEK yol" diye tarif etti. ÖLÇÜLDÜ —
// öyle değil (dosya:satır zinciri):
//
//   • src/app/lib/taskAssignment.ts:183  startTaskOnAgent → sendCommandToAgent
//     → src/app/lib/sendCommand.ts:191   api.write(paneId, prompt)
//     → electron/preload.js:175          ipcRenderer.send('pty:input', …)
//     → electron/main.js  pty:input      → entry.child.write(...)   ← BÜTÇE YOK
//     Yani board görevinin ajana DAĞITILMASI (ürünün asıl para harcatan yolu)
//     frenin tamamen DIŞINDAYDI.
//
//   • electron/resumePtyDaemon.cjs writeLine() → main.js'in `writePane`
//     kapanışı → entry.child.write(...)                             ← BÜTÇE YOK
//     Yani limit sonrası OTOMATİK DEVAM (insan yokken koşan tek şey) da
//     frenin dışındaydı.
//
// Bir freni ürünün en pahalı iki yoluna takmadan "bütçe var" demek, ölçüme
// dayanmayan bir güvenlik hissidir. Bu modül o kararı TEK yerde, SAF olarak
// verir; main onu üç çağrı yerinde uygular (writeGuarded · pty:input · resume).
//
// ─────────────────────────────────────────────────────────────────────────────
// İKİ SINIR (paneBudget.cjs'in üç kuralının bu kapıdaki karşılığı)
// ─────────────────────────────────────────────────────────────────────────────
// 1) 🔴 İNSANIN KLAVYESİ ASLA ENGELLENMEZ. Fren SİSTEMİN harcamasına takılır.
//    `origin` alanı yazımı KİM'in değil NE'nin başlattığını söyler: 'system'
//    (otomasyon) ya da 'human'. Bilinmeyen/eksik origin = insan sayılır —
//    güvenli taraf yazımın GEÇMESİ; çünkü yanlış tarafa düşmenin bedeli
//    kullanıcının tuşunun yutulmasıdır (sessiz ve tarifsiz bir kusur).
//
// 2) 🔴 ÖLÇÜLEMEYEN PANE ENGELLENMEZ. Karar `unmeasured` ise (defter yok, model
//    fiyatlanamıyor) yazım GEÇER. Tahminle iş durdurmak yok.
//
// 🔴 Kimlik körlüğü: bu modülün girdisinde ajan adı/id'si, departman, rol YOKTUR.
// "Şu ajanı frenleme" istisnası yazılacak alan bulunmadığı için yazılamaz; test
// bunu modülün KAYNAĞINDA da arar (spendGuard.test.cjs "kimlik körlüğü").

'use strict';

const paneBudget = require('../terminal/paneBudget.cjs');

/** Otomasyon kaynağı: yalnız bu değer freni tetikler. */
const SYSTEM_ORIGIN = 'system';

/**
 * Bir yazımın kaynağını normalize eder.
 * Bilinmeyen / eksik / bozuk → 'human' (kural 1: güvenli taraf GEÇMEKtir).
 * @param {unknown} origin
 * @returns {'system'|'human'}
 */
function normalizeOrigin(origin) {
  return origin === SYSTEM_ORIGIN ? SYSTEM_ORIGIN : 'human';
}

/**
 * Kapının cevabı.
 *
 * @param {object} args
 * @param {unknown} [args.origin]    'system' → otomasyon; başka her şey insan
 * @param {object|null} [args.decision] `paneBudget.evaluate()` çıktısı
 * @returns {{allow: boolean, reason: string, origin: 'system'|'human'}}
 *   reason: 'human-input' | 'budget-paused' | 'within-budget'
 */
function allowWrite(args = {}) {
  const origin = normalizeOrigin(args.origin);
  // Kural 1 — insanın tuşu kapıya hiç uğramaz.
  if (origin !== SYSTEM_ORIGIN) return { allow: true, reason: 'human-input', origin };
  // Kural 2 — yalnız `paused` engeller (`unmeasured` ENGELLEMEZ; blocksAutomation).
  if (paneBudget.blocksAutomation(args.decision)) {
    return { allow: false, reason: 'budget-paused', origin };
  }
  return { allow: true, reason: 'within-budget', origin };
}

module.exports = { SYSTEM_ORIGIN, normalizeOrigin, allowWrite };
