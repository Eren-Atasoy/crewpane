// ADP-835 (790 I5) — İZİN TESTLERİNİN PLATFORM-DÜRÜST NÖBETÇİSİ.
//
// SORUN. Beş birim testi `fs.statSync(p).mode & 0o777 === 0o600/0o700` assert
// ediyor. Windows'ta bu bit HİÇBİR ZAMAN 0o600 olmaz (Node izin bitlerini yok
// sayar) → Windows CI ilk günden BEŞ BİLİNEN-KIRMIZI ile başlar. Ekip hafızası
// `gate-known-red-baseline`: bilinen-kırmızıyla açılan bir kapı körlük üretir
// (793 R7 bunu Windows CI'ı zorunlu kapı yapmanın ÖN KOŞULU sayıyor).
//
// YANLIŞ ÇÖZÜM: testi win32'de atlamak. O zaman kapı "yeşil" der ve HİÇBİR ŞEY
// ölçmemiş olur — benim ADP-833'te bizzat düştüğüm sahte-yeşil tuzağı.
//
// DOĞRU ÇÖZÜM: iki platformda da GERÇEK bir iddia ölç, ama iddia platforma göre
// FARKLI olsun:
//   posix → dosya GERÇEKTEN dar izinli (bugünkü assert, birebir aynı sertlikte)
//   win32 → `auditRestriction` "ölçemedim"i AÇIKÇA raporluyor (`unknown` +
//           `acl-not-measured`). Yani "koruma var" demiyoruz; sistemin bu konuda
//           YALAN SÖYLEMEDİĞİNİ ölçüyoruz. ACL'in kendisini ölçmek gerçek bir
//           Windows makinesi ister (rapor R-listesi).
'use strict';

const { auditRestriction, STATES } = require('./restrictPath.cjs');

/**
 * @param {import('node:assert')} assert  çağıranın assert modülü
 * @param {string} target                 ölçülecek dosya/dizin
 * @param {number} mode                   beklenen POSIX modu (0o600 / 0o700)
 * @param {object} [deps]                 { platform, fs } — enjekte edilebilir
 */
function assertRestricted(assert, target, mode, deps = {}) {
  const platform = deps.platform || process.platform;
  const r = auditRestriction(target, { ...deps, mode });
  if (platform === 'win32') {
    assert.equal(r.state, STATES.UNKNOWN, `win32: izin durumu DÜRÜSTÇE 'unknown' olmalı, gelen: ${JSON.stringify(r)}`);
    assert.equal(r.reason, 'acl-not-measured', `win32: 'ölçemedim' gerekçesi kaybolmuş: ${JSON.stringify(r)}`);
    return r;
  }
  assert.equal(r.state, STATES.APPLIED, `${target} dar izinli değil: ${JSON.stringify(r)}`);
  assert.equal(r.mode, mode, `${target} izni ${(r.mode || 0).toString(8)}, beklenen ${mode.toString(8)}`);
  return r;
}

module.exports = { assertRestricted };
