// ENV-08 (d) — GEÇİCİ KONUM TESPİTİ. 28.08 olayı: 0.2.42 DMG'si doğrudan açıldı →
// macOS Gatekeeper uygulamayı AppTranslocation altına KOPYALAYIP oradan koşturdu;
// kopya prod instance çözdü ve gerçek ~/.crewpane köküne bağlandı. Tek-örnek
// kilidi (singleInstanceLock, ENV-08 a) çarpışmayı artık engelliyor; bu modül ise
// kullanıcıya NEDENİNİ söyler: "geçici konumdan çalışıyorsun — Uygulamalar'a taşı".
//
// Saf fonksiyon, platform parametresi AÇIK (PIPE-03 dersi: `process.platform`
// fallback'ine bırakılan platform dalları CI'da yanlış dala düşer). main.js
// whenReady sonrası çağırır ve dialog'u kendisi gösterir — burada Electron yok.
'use strict';

/**
 * Uygulama kalıcı olmayan bir konumdan mı koşuyor?
 *  - macOS AppTranslocation: /private/var/folders/…/AppTranslocation/… (Gatekeeper
 *    karantina kopyası — DMG'den/indirilenden doğrudan açış)
 *  - DMG mount: /Volumes/… (imaj çıkarılınca yol kaybolur)
 * Yalnız darwin'de anlamlıdır; diğer platformlar daima false.
 */
function isTransientLocation(execPath, platform = process.platform) {
  if (platform !== 'darwin') return false;
  const p = String(execPath || '');
  if (p.includes('/AppTranslocation/')) return true;
  if (/^\/Volumes\//.test(p)) return true;
  return false;
}

module.exports = { isTransientLocation };
