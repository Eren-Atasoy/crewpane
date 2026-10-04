'use strict';
// ============================================================================
// escapes.cjs — GELISTIRICI KACIS MODULU (dev-only)
//
// Bu dosya MUSTERI paketine GIRMEZ; yalnizca gelistirme/test kopyasinda bulunur.
// crewpaneId.cjs bunu OPSIYONEL require eder (yoksa hata degil). Varsa, siki
// kapilarin (STRICT_GATES) uzerine `overrides(env)` ciktisi yazilir.
//
// AMAC: gelistirme ortaminda login + seat (lisans) duvarlarini asmak; boylece
// billing'e yonlendirilmeden uygulamayi acip test edebilmek.
//
// VARSAYILAN: her iki kapi da KAPALI (gerekmez) -> uygulama giris istemeden acilir.
// Gercek giris/lisans akisini test etmek istersen ortam degiskeniyle geri ac:
//   set CREWPANE_DEV_REQUIRE_LOGIN=1   -> login duvarini geri ac
//   set CREWPANE_DEV_REQUIRE_SEAT=1    -> seat/lisans kapisini geri ac
// ============================================================================

function truthy(v) {
  return v === '1' || v === 'true' || v === 'yes';
}

module.exports = {
  // gateOverrides(env) bunu STRICT_GATES uzerine spread eder.
  // Donen alanlar: requireLogin, requireSeat, bootSplash
  overrides(env = process.env) {
    return {
      requireLogin: truthy(env.CREWPANE_DEV_REQUIRE_LOGIN),
      requireSeat: truthy(env.CREWPANE_DEV_REQUIRE_SEAT),
      bootSplash: false,
    };
  },

  // devEscapeProbeEnv(env) bunu cagirir (teshis/telemetri icin env anlik goruntusu).
  probeEnv(env = process.env) {
    return {
      CREWPANE_DEV_REQUIRE_LOGIN: env.CREWPANE_DEV_REQUIRE_LOGIN || null,
      CREWPANE_DEV_REQUIRE_SEAT: env.CREWPANE_DEV_REQUIRE_SEAT || null,
    };
  },
};
