// ADP-390 (ADR-027 §2 / G9) — CrewPane'in CrewPane ID uç noktaları.
//
// AgentShot'taki (ADP-384) crewpaneId.cjs'in CrewPane eşleniği: aynı kimlik
// sunucusu (crewpane-id), farklı custom scheme. anon key PUBLIC'tir (RLS arkasında —
// ADP-383 kanıtı: anon'dan entitlements okuması 401), app'e gömülmesi TASARIM gereği;
// sır DEĞİLDİR. Varsayılanlar LOCAL dev stack'i (563xx). Prod projesi açılınca
// buradaki üç sabit değişir; env ile de ezilebilir.
//
// SEAT KAPISI (ADP-390): kapı YAZILIR ama geliştirici kopyasında varsayılan
// KAPALIDIR. Açma/kapama anahtarı KULLANICI dosyasına değil ENV'e bağlıdır:
// kullanıcı-düzenlenebilir config'teki bayrak, üründe lisans şalteri demek
// olurdu (ADP-384'ün aynı kararı).
//
// ⛔ ADP-646 (P0 GÜVENLİK) — YUKARIDAKİ PARAGRAF YALNIZ GELİŞTİRİCİ KOPYALARI
// İÇİN GEÇERLİ. Eren'in kararı: "siteden indiren biri PAKET SATIN ALMADAN ve
// KİMLİK DOĞRULAMADAN uygulamayı KULLANAMASIN". Bu yüzden:
//
//   * MÜŞTERİ build'inde (buildChannel.isCustomerBuild()) `requireLogin` VE
//     `requireSeat` HER ZAMAN true'dur; hiçbir ortam değişkeni kapıyı açamaz.
//   * Geliştirici kopyalarında (kaynaktan koşan Electron, bizim dev/test
//     DMG'lerimiz) eski davranış AYNEN sürer → e2e harness'ı ve Eren'in günlük
//     geliştirme akışı kilitlenmez.
//
// ⛔ SEC-W1-A1 (0.2.46) — "YOKSAYILIR" YETMEZ, "YOK" OLMALI. Bayrak okuyucuları
// bu dosyadan `escapes.cjs`e taşındı ve o modül müşteri paketine HİÇ GİRMEZ
// (prod-builder çıkarır, afterPack yokluğu ölçer). Müşteri kopyasında geçersiz
// kılma mantığı fiziksel olarak bulunmaz; require başarısız olur ve kod
// STRICT_GATES sabitine düşer. Tek karar noktası (G0) düşse bile bu dosyada
// açılacak bir bayrak dalı KALMAZ.
//
// "Müşteri build'i mi" kararı env'den DEĞİL app.isPackaged + gömülü build tipinden
// türer (buildChannel.cjs) — instance env'i ile kaçış YOK.

'use strict';

const buildChannel = require('./buildChannel.cjs');
// ADP-780-B — URL şeması artık KANALA göre değişir (crewpane / crewpane-dev /
// crewpane-test). Tek boğaz appScheme.cjs; burada ikinci bir sabit tutulmaz.
const { appScheme } = require('../core/appScheme.cjs');
// ADP-780-B — paketli DEV build'in kimlik hedefi BUILD ZAMANINDA sabitlenir.
const devChannel = require('./devChannel.cjs');

// ADP-520 — VARSAYILAN artık CANLI cloud (accounts.crewpane.dev + cloud Supabase):
// paketli app sıfır env ile gerçek CrewPane ID'ye gider. Local dev stack'i (563xx)
// isteyen (adp390 e2e, crewpane-id geliştirmesi) CREWPANE_ID_URL/_ANON_KEY/
// CREWPANE_LOGIN_URL env'leriyle AÇIKÇA seçer. Değerler crewpane-id/web/
// config.prod.js ile aynı kaynaktan (ADP-418); anon key PUBLIC'tir (RLS korur).
const PROD_CLOUD = {
  supabaseUrl: 'https://xjhwkikjsqiyywpolmld.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhqaHdraWtqc3FpeXl3cG9sbWxkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTExMTY2NTUsImV4cCI6MjEwNjY5MjY1NX0.JxaLPbus15lPThSRdC1SHfZo1RzzjfcJVixQETj0eFU',
  loginUrl: 'https://accounts.crewpane.dev/',
};

// ADP-780-B — ARTIK SABİT DEĞİL. Geriye dönük uyumluluk için isim korunuyor ama
// değeri bu kopyanın kanalından türer (prod → 'crewpane', dev → 'crewpane-dev').
// Modül yüklenirken bir kez çözülür: baked damga çalışma anında değişmez.
const SCHEME = appScheme();
const SEAT_PRODUCT = 'crewpane.seat';
/** Suite paketi tek satın alma ile üç ürünü açar (crewpane-id: product-bundles.ts).
 *  İstemci tarafında Suite'i AYRI kontrol ETMEYİZ — jeton zaten crewpane.seat
 *  entitlement'ını taşır. Bu sabit yalnız görüntüleme/etiket için. */
const SUITE_PRODUCT = 'crewpane.suite';

// SEC-W1-A1 — MÜŞTERİ KOPYASININ TEK DOĞRUSU. Geçersiz kılma modülü yoksa
// (müşteri paketi) kapılar bu sabitten okunur: giriş ZORUNLU, koltuk ZORUNLU,
// açılış perdesi AÇIK (perdenin bugünkü müşteri varsayılanı zaten budur).
const STRICT_GATES = Object.freeze({ requireLogin: true, requireSeat: true, bootSplash: true });

// OPSİYONEL REQUIRE — dosya müşteri paketinde YOKTUR ve bu bir hata değildir.
// `scripts/verify_asar_requires.cjs` OPTIONAL_LOCAL_REQUIRES listesinde YAZILI
// (ve çağrının gerçekten try içinde olduğunu AST ile ölçer): devChannelTarget.json
// ile birebir aynı desen (ADP-780-B).
let devEscapes = null;
try {
  // eslint-disable-next-line global-require
  devEscapes = require('./escapes.cjs');
} catch {
  devEscapes = null; // müşteri paketi — geçersiz kılma mantığı pakete girmedi
}

/**
 * Kapı kararlarının TEK boğazı. Müşteri build'inde (ya da modül pakete
 * girmemişse) STRICT_GATES döner — env HİÇ okunmaz.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{customerBuild?: boolean, escapes?: object|null}} [opts] test dikişi;
 *        `escapes: null` müşteri paketini (modül yok) taklit eder.
 * @returns {{requireLogin: boolean, requireSeat: boolean, bootSplash: boolean}}
 */
function gateOverrides(env = process.env, opts = {}) {
  const customerBuild = opts.customerBuild === undefined
    ? buildChannel.isCustomerBuild()
    : opts.customerBuild;
  const mod = opts.escapes === undefined ? devEscapes : opts.escapes;
  if (customerBuild === true || !mod) return STRICT_GATES;
  return { ...STRICT_GATES, ...mod.overrides(env) };
}

/**
 * ADP-646 kaçış probunun (yalnız test instance'ında kurulan e2e dikişi) bastığı
 * env anlık görüntüsü. Müşteri paketinde modül yok → boş nesne.
 */
function devEscapeProbeEnv(env = process.env) {
  return devEscapes ? devEscapes.probeEnv(env) : {};
}

/**
 * "Satın al" / "Aboneliği yönet" hedefi — kimlik sunucusunun faturalandırma sayfası.
 * loginUrl'den TÜRETİLİR (ikinci bir sabit tutmayız): prod'da
 * https://accounts.crewpane.dev/billing, e2e'de yerel stack'in kendi adresi.
 */
function billingUrl(loginUrl) {
  const base = String(loginUrl || PROD_CLOUD.loginUrl);
  return base.endsWith('/') ? `${base}billing` : `${base}/billing`;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{customerBuild?: boolean, devIdentity?: object|null, scheme?: string,
 *          escapes?: object|null}} [opts]
 *        test dikişi; verilmezse buildChannel / devChannel / appScheme çözer.
 *        `escapes: null` → müşteri paketini (geçersiz kılma modülü YOK) taklit eder.
 */
function crewpaneIdConfig(env = process.env, opts = {}) {
  const customerBuild = opts.customerBuild === undefined
    ? buildChannel.isCustomerBuild()
    : opts.customerBuild;
  const scheme = opts.scheme === undefined ? SCHEME : opts.scheme;
  // SEC-W1-A1 — kapı kararları TEK boğazdan; `opts.escapes` test dikişi olarak geçer.
  const gates = gateOverrides(env, { customerBuild, escapes: opts.escapes });
  // ADP-780-B — PAKETLİ DEV BUILD: kimlik hedefi build'e gömülüdür ve env dahil her
  // şeyi ezer. Müşteri build'inde bu dal ASLA çalışmaz (baked damga yok → null).
  // "Yarım hedef" (loginUrl'ü olmayan) devChannel tarafında zaten reddedilir:
  // dev app'in prod giriş sayfasına düşmesindense yapılandırılmamış sayılması doğrudur.
  const devIdentity = opts.devIdentity === undefined
    ? devChannel.devIdentityTarget()
    : opts.devIdentity;
  if (!customerBuild && devIdentity) {
    return {
      scheme,
      supabaseUrl: devIdentity.supabaseUrl,
      anonKey: devIdentity.anonKey,
      loginUrl: devIdentity.loginUrl,
      billingUrl: billingUrl(devIdentity.loginUrl),
      customerBuild: false,
      targetLabel: devIdentity.label,
      requireSeat: gates.requireSeat,
      requireLogin: gates.requireLogin,
    };
  }
  // ADP-646 — KİMLİK SUNUCUSU DA ÇİVİLİ. Müşteri build'inde CREWPANE_ID_URL /
  // _ANON_KEY / CREWPANE_LOGIN_URL env'leri YOKSAYILIR: kullanıcı app'i kendi
  // sahte kimlik sunucusuna yönlendiremez. (Tek başına bir bypass değildi —
  // sahte sunucunun ürettiği jeton gömülü ES256 public key'lerinde `unknown_kid`
  // ile düşerdi — ama saldırı yüzeyini bedavaya kapatıyoruz ve "neden giriş
  // çalışmıyor" sınıfı destek vakalarını da eliyoruz.)
  const loginUrl = (customerBuild ? null : env.CREWPANE_LOGIN_URL) || PROD_CLOUD.loginUrl;
  return {
    scheme,
    supabaseUrl: (customerBuild ? null : env.CREWPANE_ID_URL) || PROD_CLOUD.supabaseUrl,
    anonKey: (customerBuild ? null : env.CREWPANE_ID_ANON_KEY) || PROD_CLOUD.anonKey,
    loginUrl,
    billingUrl: billingUrl(loginUrl),
    customerBuild,
    // ADP-646/SEC-W1-A1 — LİSANS + GİRİŞ KAPISI. `gates` müşteri build'inde
    // STRICT_GATES'tir (env okunmaz); geliştirici kopyasında escapes.cjs karar verir.
    requireSeat: gates.requireSeat,
    requireLogin: gates.requireLogin,
  };
}

module.exports = {
  crewpaneIdConfig, gateOverrides, devEscapeProbeEnv, billingUrl,
  STRICT_GATES, SCHEME, SEAT_PRODUCT, SUITE_PRODUCT,
};
