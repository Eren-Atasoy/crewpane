// WIN-DUP-INSTANCE-01 (FB-1012) — mobil gateway KALKIŞ HATASI → sihirbaz cümlesi.
//
// NEDEN VAR. Müşteri logunda `listen EADDRINUSE …:7823` üç kez vardı; sihirbaz
// 4. adımda yalnız "gateway hatası" diyordu. Sebep (aynı bilgisayarda oturumsuz
// ikinci bir CrewPane kopyası portu tutuyordu) kullanıcıya hiç söylenmiyordu.
// Bu modül saf: Electron'suz `node --test` ile ölçülür; main.js yalnız bağlar.
//
// KURAL — cümlede iç mekanizma YOK: port numarası, hata kodu, "gateway" yazılmaz.
'use strict';

/**
 * @param {unknown} err  gateway kalkışının reddettiği hata (Node `listen` hatası)
 * @param {(key:string)=>string} t  sözlük çevirici (main.* anahtarları)
 * @returns {{reason:'port_in_use'|'start_failed', error:string}}
 */
function mobileStartFailure(err, t) {
  const code = err && typeof err === 'object' ? err.code : null;
  if (code === 'EADDRINUSE') return { reason: 'port_in_use', error: t('main.mobile.portInUse') };
  return { reason: 'start_failed', error: t('main.mobile.startFailed') };
}

module.exports = { mobileStartFailure };
