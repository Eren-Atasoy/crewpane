'use strict';
// ADP-833 (ADR-W6) — WINDOWS DEEP-LINK: argv'de gelen giriş dönüşünü ÇIKAR ve TESLİM ET.
//
// ## Neden bu modül var
//
// macOS'ta `<şema>://auth/callback` uygulamaya `app.on('open-url')` ile gelir.
// Windows'ta ÖYLE BİR OLAY YOKTUR: OS uygulamayı komut satırına URL'i EKLEYEREK
// açar (`CrewPane.exe "crewpane://auth/callback?code=…"`). İki durum var:
//
//   (a) uygulama KAPALI → URL doğrudan `process.argv`'dedir (soğuk açılış),
//   (b) uygulama AÇIK   → OS YENİ bir süreç başlatır; o süreç URL'i ilk kopyaya
//       aktarıp ölmelidir.
//
// Electron'un standart deseni (b) için `requestSingleInstanceLock()` +
// `app.on('second-instance', (e, argv) => …)`. Biz o dahili kilidi KULLANAMIYORUZ:
// kapsamı `userData` dizinidir ve bizim üç kanalımız (prod/dev/test) aynı
// `userData` adına pinlenmiştir → dahili kilit onları birbirine bağlar ve
// CREWPANE_HOME ile ayrılmış iki koşuyu ayırt edemez (ölçüm: ADP-832 §2.1,
// gerekçe singleInstanceLock.cjs başlığında). O karar BOZULMUYOR; bu modül onun
// ÜSTÜNE köprüyü kuruyor: ikinci kopya argv'sini `focus-request.json`a yazar,
// birinci kopya dosyayı tüketirken argv'yi BURAYA verir. Yani `second-instance`
// olayının taşıdığı bilgi (argv) aynen taşınır, taşıyıcı farklıdır.
//
// ## Kurallar
//   1. SAF ayrıştırma: `deepLinkFromArgv` fs/electron/platform bilmez → `node --test`.
//   2. Şema kıyası HARF-DUYARSIZ (RFC 3986 §3.1), geri kalanı BOZULMADAN döner —
//      PKCE `code` parametresi harf-duyarlıdır, normalize etmek girişi kırar.
//   3. Argümanlar SONDAN taranır: Windows kabuğu/registry URL'i en sona koyar,
//      Chromium anahtarları (`--flag`) önde gelir.
//   4. Teslim kararı (otomasyon oturumu vb.) ÇAĞIRANA aittir — `blocked()` dikişi.

/** Kabuk/registry tırnakları — `"crewpane://…"` biçimi Windows'ta olağandır. */
function stripQuotes(value) {
  return String(value).trim().replace(/^["']+/, '').replace(/["']+$/, '');
}

/**
 * argv içinde `<prefix>` ile başlayan İLK (sondan) argümanı döndür.
 * @param {string[]} argv
 * @param {string} prefix `crewpane://` gibi — şema + `://`
 * @returns {string|null} URL (orijinal harf düzeniyle) ya da null
 */
function deepLinkFromArgv(argv, prefix) {
  if (!Array.isArray(argv)) return null;
  const p = String(prefix || '').toLowerCase();
  if (!p.endsWith('://') || p.length <= 3) return null;
  for (let i = argv.length - 1; i >= 0; i -= 1) {
    const raw = argv[i];
    if (typeof raw !== 'string') continue;
    const value = stripQuotes(raw);
    // Yalnız şemanın kendisi (`crewpane://`) taşınacak bir dönüş DEĞİLDİR.
    if (value.length > p.length && value.toLowerCase().startsWith(p)) return value;
  }
  return null;
}

/** Kolaylık: argv bir deep-link taşıyor mu (karar noktalarında okunaklı olsun). */
function hasDeepLink(argv, prefix) {
  return deepLinkFromArgv(argv, prefix) !== null;
}

/**
 * argv → teslim eden tüketici. main.js'in üç giriş noktası da (soğuk açılış,
 * focus-request, ileride başka bir taşıyıcı) BUNU çağırır; karar mantığı tek yerde.
 *
 * @param {object} opts
 * @param {string|Function} opts.prefix  şema öneki (fonksiyon da olabilir — main.js'te
 *                                       sabit modül yüklenme sırasında henüz TDZ'de)
 * @param {Function} opts.deliver        (url) => void — gerçek işleyici (handleAuthUrl)
 * @param {Function} [opts.blocked]      (url) => string|null — sebep dönerse TESLİM EDİLMEZ
 * @param {Function} [opts.log]
 * @param {Function} [opts.defer]        (fn) => void — karar+teslim adımını ERTELER.
 *        main.js `setImmediate` verir: bu tüketici modül YÜKLENİRKEN de çağrılabiliyor
 *        (kilit kapısı ilk satırlarda ve `watchFocusRequests` bekleyen bir isteği SENKRON
 *        süpürüyor); o anda `handleAuthUrl`/`APP_URL_PREFIX` gibi sabitler henüz TDZ'de
 *        olur ve senkron teslim ReferenceError'a düşüp giriş dönüşünü SESSİZCE kaybederdi.
 *        Varsayılan: anında çalıştır (testler senkron ölçebilsin).
 * @returns {(argv: string[], source: string) => {url: string|null, delivered: boolean, reason: string|null}}
 */
function createDeepLinkConsumer(opts = {}) {
  const deliver = typeof opts.deliver === 'function' ? opts.deliver : () => {};
  const blocked = typeof opts.blocked === 'function' ? opts.blocked : () => null;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const defer = typeof opts.defer === 'function' ? opts.defer : (fn) => fn();
  const prefixOf = () => (typeof opts.prefix === 'function' ? opts.prefix() : opts.prefix);

  return function consume(argv, source = 'argv') {
    // AYRIŞTIRMA senkron kalır (hiçbir modül durumuna dokunmaz) → çağıran URL'i
    // hemen görür; ERTELENEN yalnız karar + teslimdir.
    let url = null;
    try {
      url = deepLinkFromArgv(argv, prefixOf());
    } catch (e) {
      log(`deep-link (${source}) ayrıştırma hatası: ${e && e.message}`);
      return { url: null, delivered: false, reason: 'parse-error' };
    }
    if (!url) return { url: null, delivered: false, reason: 'no-deep-link' };

    const outcome = { url, delivered: false, reason: 'deferred' };
    defer(() => {
      // Sorgu dizesi LOGLANMAZ: `code=` tek kullanımlık bir sırdır.
      log(`deep-link (${source}): ${url.split('?')[0]}`);
      let reason = null;
      try {
        reason = blocked(url) || null;
      } catch (e) {
        reason = `blocked() hatası: ${e && e.message}`;
      }
      if (reason) {
        log(`⛔ deep-link (${source}) REDDEDİLDİ — ${reason}`);
        outcome.reason = reason;
        return;
      }
      try {
        deliver(url);
        outcome.delivered = true;
        outcome.reason = null;
      } catch (e) {
        log(`deep-link (${source}) teslim hatası: ${e && e.message}`);
        outcome.reason = 'deliver-error';
      }
    });
    return outcome;
  };
}

module.exports = {
  stripQuotes,
  deepLinkFromArgv,
  hasDeepLink,
  createDeepLinkConsumer,
};
