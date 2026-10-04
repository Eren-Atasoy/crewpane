// @crewpane/auth — CrewPane ID masaüstü auth kütüphanesi (ADR-027)
//
// Üç yüzey:
//   * ADP-383/G3: offline lisans-jetonu doğrulama (license.cjs + keys.cjs)
//   * ADP-382/G2: PKCE giriş akışı — signIn(), signInWithEmail(),
//     handleCallback(url), getSession(), refresh(), signOut()
//     (desktopAuth.cjs) + safeStorage token deposu (safeStorageStore.cjs).
//   * ADP-387/G6: "Pro'ya geç" — openUpgrade()/openBillingPortal() +
//     ödeme dönüşünde jeton tazeleme çengeli (billing.cjs).
//
// Giriş SİSTEM TARAYICISINDA yapılır; gömülü webview YASAK (RFC 8252 /
// ADR-027 §3) — no-embedded-webview.test.cjs bunu pakette zorlar.

'use strict';

const license = require('./license.cjs');
const { LICENSE_PUBLIC_KEYS } = require('./keys.cjs');
const desktopAuth = require('./desktopAuth.cjs');
const billing = require('./billing.cjs');
// SEC-01 — cihaz defteri (listele/çıkar). Tavan sunucuda zorlanır; bu yüzey
// kullanıcının kendi cihazını çıkarabilmesi içindir (tavanın kilide dönüşmemesi).
const devices = require('./devices.cjs');
const { createSafeStorageTokenStore } = require('./safeStorageStore.cjs');

module.exports = {
  ...license,
  ...desktopAuth,
  ...billing,
  ...devices,
  createSafeStorageTokenStore,
  LICENSE_PUBLIC_KEYS,
  /**
   * Gömülü anahtarlarla doğrulama kısayolu — uygulamaların normal giriş noktası.
   * @param {string} token
   * @param {{nowSeconds?:number, lastServerTime?:number|null}} [opts]
   */
  verifyWithEmbeddedKeys(token, opts) {
    return license.verifyLicenseToken(token, {
      publicKeys: LICENSE_PUBLIC_KEYS,
      ...(opts || {}),
    });
  },
};
