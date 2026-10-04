'use strict';
/**
 * ADP-801 — "Bu süreç bir OTOMASYON oturumu mu?" TEK gerçek kaynağı.
 *
 * ## Çözülen bug (ölçüldü 2026-07-31, Eren'in makinesi)
 *
 * e2e/ajan koşuları `/Applications/CrewPane Dev.app`'i geçici bir
 * `CREWPANE_HOME` + `--user-data-dir` ile açıyor. Paketli olduğu için o kopya
 * açılışta `crewpane-dev://` şemasını KOŞULSUZ talep ediyor ve logda
 * `claimed=true ownsDefault=true` yazıyor — yani Eren'in giriş dönüşünü
 * sahiplenen ikinci (üçüncü…) bir süreç doğuyor. macOS, aynı bundle id'nin
 * birden çok süreci varken URL'i HANGİSİNE vereceğini bize sormaz; dönüş
 * headless test kopyasına düşerse PKCE verifier orada olmadığı için
 * `code` sessizce yanar ve kullanıcı "giriş dönüşü gelmedi" görür.
 *
 * ## Neden env, neden isim değil
 *
 * Karar İSİMDEN (yol, ürün adı, "CrewPane Dev" gibi) değil DURUMDAN türer:
 * "bu süreci bir insan mı açtı, bir koşum mu?" Bunu paket kendi başına bilemez —
 * koşum BEYAN eder. Beyanın iki kabul edilen biçimi:
 *
 *   CREWPANE_E2E=1 / CREWPANE_E2E=1   → koşum açıkça "ben otomasyonum" der
 *   CREWPANE_INSTANCE=test              → zaten ayrı instance (e2e'nin varsayılanı)
 *
 * `CREWPANE_INSTANCE`'a TEK BAŞINA güvenilemez: müşteri/bakir ortam ölçen
 * koşular onu bilerek set ETMEZ (ADP-763 — TEST rozeti görünmesin diye), ama
 * yine de otomasyondur. Bu yüzden açık bayrak şart; e2e yardımcıları
 * (`e2e/schemeSafeLaunch.cjs`) onu her açılışa kendiliğinden ekler.
 *
 * Saf + DI: env enjekte edilir → `node --test electron/automatedSession.test.cjs`.
 */

/** Bu env bir otomasyon (e2e / ajan koşumu) oturumu mu tarif ediyor? */
function isAutomatedSession(env = process.env) {
  const e = env || {};
  if (String(e.CREWPANE_E2E || '') === '1') return true;
  if (String(e.CREWPANE_E2E || '') === '1') return true;
  if (String(e.CREWPANE_INSTANCE || '') === 'test') return true;
  return false;
}

/** Karara SEBEP ekler — log satırı "neden atlandı"yı tahmine bırakmasın. */
function automatedSessionReason(env = process.env) {
  const e = env || {};
  if (String(e.CREWPANE_E2E || '') === '1') return 'CREWPANE_E2E=1';
  if (String(e.CREWPANE_E2E || '') === '1') return 'CREWPANE_E2E=1';
  if (String(e.CREWPANE_INSTANCE || '') === 'test') return 'CREWPANE_INSTANCE=test';
  return null;
}

module.exports = { isAutomatedSession, automatedSessionReason };
