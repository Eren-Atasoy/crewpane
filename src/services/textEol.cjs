// MEM-CRLF-01 — OKUNAN metin dosyasının TEK satır-sonu sözleşmesi.
//
// Windows'ta Not Defteri / VS Code ile kaydedilen hafıza, skill ve rapor dosyaları CRLF
// taşır; Not Defteri ayrıca baştaki UTF-8 BOM'u (U+FEFF) yazar. Ayrıştırıcılar `^---\n`,
// `startsWith('---')`, `split('\n')` + `(.*)$` varsayar: CRLF'de ön-bilgi hiç eşleşmez
// (`.` `\r` ile eşleşmez), BOM'da ilk satır `---` sayılmaz → kayıt SESSİZCE boş okunur
// (ölçüm: electron/memCrlf01.test.cjs, tabanda 30/41 kırmızı).
//
// Kural: dosyadan gelen metin ayrıştırılmadan ÖNCE buradan geçer; yazıcılar `\n` yazmaya
// devam eder (CRLF'i KORUYAN yamacılar — agentMemory.patchFrontmatter, deriveIndexText —
// bilerek ham metinle çalışır). SAF: fs/electron yok, require yok (asar.unpacked'ta tek dosya).

'use strict';

/** Baştaki UTF-8 BOM'u at, `\r\n` ve yalnız `\r`'yi `\n`'e indir. */
function normalizeReadText(text) {
  return String(text == null ? '' : text)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
}

module.exports = { normalizeReadText };
