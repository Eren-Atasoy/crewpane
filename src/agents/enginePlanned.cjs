// ENG-HONEST-CARD-01 (OC-DESIGN-0919 §5(e), karar E1) — "YOLDA" ETİKETİNİN TEK EVİ.
//
// Motor kartındaki "Henüz değil" sütunu bir satırın yanına "yolda" yazabilmek için
// o satırı TAM'a çekecek bir board KARTININ var olmasını ister. Etiketin veri kaynağı
// descriptor'ın gerekçe METNİ değil (oradaki "takip kalemi" cümlesine bakmak ikinci
// bir defter olurdu, RESEARCH-OC-02 §3.1-4), BU haritadaki kart kodudur.
//
// KURAL (ADR C6 madde 1): kartı KAPATAN uygulama kartı buradaki kendi satırını
// SİLER — böylece etiket bayatlamaz. Kontrol kolu paneCapabilityMatrix.test.cjs'te:
// haritadan kod silinince etiket düşer. TAM olan satırda etiket zaten çıkmaz
// (`buildMatrix` state kapısı önce gelir), yani unutulan bir satır bile ekranda
// yalan üretemez; yine de silinmelidir (defter doğru kalsın).
//
// ⚠️ Motor adı dalı YOK: harita motor kimliğine göre okunur ama hüküm üretmez —
// "hangi kartın planlı olduğu" bilgisi tek başına bir yetenek iddiası değildir.
//
// Tarihçe: ADR taslağı `board`/`browser`/`leader` satırlarını ENG-OPENCODE-MCP-01'e
// bağlıyordu; o kart (C1) bu harita doğmadan ÖNCE dev'e girdi ve satırları TAM'a
// çekti (`buildMatrix('opencode')` board/browser 'full', lider 'fallback' — ölçüldü).
// Kapanan kartın satırı yazılmaz: harita bugün yalnız AÇIK kartı taşır.

'use strict';

/**
 * motor id → { yetenek id → board kart kodu }.
 * Yetenek id'leri `paneCapabilityMatrix.CAPABILITY_IDS` ile aynı ad-alanı; `leader`
 * lider sınıfı satırı için ayrılmıştır (matris satırı değil, rol hükmü).
 */
const PLANNED = Object.freeze({
  opencode: Object.freeze({
    // C3 — restart-resume: kimliksiz `--continue` + cwd/PWD/DB üçlü kapısı.
    resume: 'ENG-OPENCODE-RESUME-01',
  }),
});

/**
 * Bu motorda bu yeteneği TAM'a çekecek planlı kartın kodu (yoksa `null`).
 * @param {string} engineId
 * @param {string} capabilityId
 * @param {object} [map] - test dikişi (varsayılan: dondurulmuş harita)
 * @returns {string|null}
 */
function plannedCardFor(engineId, capabilityId, map = PLANNED) {
  if (!map || typeof map !== 'object') return null;
  const row = typeof engineId === 'string' ? map[engineId] : null;
  if (!row || typeof row !== 'object') return null;
  const code = row[capabilityId];
  return typeof code === 'string' && code.trim() ? code.trim() : null;
}

module.exports = { PLANNED, plannedCardFor };
