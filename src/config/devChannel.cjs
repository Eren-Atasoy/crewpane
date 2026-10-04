// ADP-780-B — DEV kanalının backend hedefi: BUILD ZAMANINDA sabit.
//
// ## Sorun
// Dev DMG bugün kimlik sunucusu olarak `PROD_CLOUD`'a (accounts.crewpane.dev +
// gerçek müşteri projesi) bakıyor, uygulama DB'si için de makinedeki
// `~/.crewpane/crewpane-public-env.json` gibi değişkenlere düşüyor. Yani
// "dev build" dediğimiz şey, çalıştığı makinenin ortamına göre bir gün PROD
// verisine bağlanabiliyor. ADP-723'te bu tam olarak ölçüldü (`launchctl setenv`
// GUI oturumunun tamamına miras geçti, prod ve dev aynı DB'ye bağlandı).
//
// ## Kural
// Paketli DEV build'de (extraMetadata.crewpaneBuild === 'dev') hedef
// `devChannelTarget.json`dan gelir ve **her şeyi ezer** — env dahil. Hedef pakete
// girer; çalışma anında yanlış ortama düşme ihtimali kalmaz.
//
//   kopya                      | kimlik + app DB hedefi
//   ---------------------------|------------------------------------------------
//   paketli prod DMG           | PROD_CLOUD (değişmedi)
//   paketli DEV DMG + enabled  | devChannelTarget.json  ← BU MODÜL
//   paketli DEV DMG + disabled | bugünkü davranış (env → .env.local → yerel)
//   kaynaktan koşu (baked yok) | bugünkü davranış (env → .env.local → yerel)
//
// Kaynaktan koşuya BİLEREK dokunulmaz: `npm run electron:dev` ve e2e harness'ı
// yerel stack'leriyle çalışmaya devam eder (regresyon yok).
//
// Saf-ish: tek I/O `require('./devChannelTarget.json')` (require cache'li) ve
// `instancePaths.bakedBuildType()`. İkisi de opts ile enjekte edilebilir →
// `node --test electron/devChannel.test.cjs` ile koşar.

'use strict';

const instancePaths = require('./instancePaths.cjs');

// ⛔ ADP-780-B — ÖLÇÜLMÜŞ PAKETLEME BUGI, TEKRARLAMASIN.
// İlk sürümde hedef YALNIZ `devChannelTarget.json`dan okunuyordu. `build.files`
// yalnız `*.js`, `*.cjs`, `package.json` ve `renderer/**` alıyor — yani JSON asar'a
// HİÇ girmedi, `require` sessizce patladı ve dev DMG **prod buluta** bağlandı
// (`[appdb] kimlik modu=crewpane-id hedef=https://rwyy….supabase.co` — kurulu dev
// app'in kendi logunda ölçüldü). Kaynakta her şey doğruydu; hata PAKETTE doğdu.
//
// Bu yüzden hedef artık ÖNCE `package.json`daki `crewpaneDevTarget` alanından
// okunur: o alan `extraMetadata` ile build anında gömülür ve package.json'un pakete
// girdiği KESİNDİR (crewpaneBuild/gitCommit aynı yolu kullanıyor, ADP-268/316).
// JSON dosyası kaynak-koşusu ve build girdisi olarak kalır (ikinci, yedek yol).
//
// BOARD-AUTH-02 (B2) — ÜÇÜNCÜ KAYNAK: `bakedBuild.json`. Yukarıdaki iki yol da
// AYRI SÜREÇTE (MCP çocuğu, hook, crewpaneCli) ÖLÇÜLEREK boş çıktı: `package.json`
// asar'ın içinde kalır, `devChannelTarget.json` ise `asarUnpack` listesinde hiç yok
// (müşteri paketinden de bilerek çıkarılır). Manifesti build/afterPack.cjs
// `app.asar.unpacked/`e yazar — `build.files` kalıplarına hiç güvenmeden.
function loadConfig(opts) {
  const o = opts || {};
  try {
    const pkg = o.pkg === undefined ? require('../../package.json') : o.pkg;
    const baked = pkg && pkg.crewpaneDevTarget;
    if (baked && typeof baked === 'object') return baked;
  } catch { /* paketlenmemiş / okunamıyor → manifeste düş */ }
  const manifest = o.manifest === undefined ? instancePaths.readBakedManifest() : o.manifest;
  if (manifest && manifest.crewpaneDevTarget && typeof manifest.crewpaneDevTarget === 'object') {
    return manifest.crewpaneDevTarget;
  }
  if (o.file === null) return null; // test dikişi: dosya yolunu kapat
  try {
    return require('./devChannelTarget.json');
  } catch {
    return null;
  }
}

function nonEmpty(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Bu kopya, dev-kanal hedefini uygulaması gereken bir paketli DEV build'i mi?
 * @param {{baked?: string|null}} [opts]
 */
function isPackagedDevBuild(opts) {
  const o = opts || {};
  const baked = o.baked === undefined ? instancePaths.bakedBuildType() : o.baked;
  return baked === 'dev';
}

/**
 * Dev kanalının UYGULAMA DB hedefi (yoksa null).
 * @param {{baked?: string|null, config?: object|null}} [opts]
 * @returns {{url: string, anonKey: string, schema: string, label: string}|null}
 */
function devAppDbTarget(opts) {
  const o = opts || {};
  if (!isPackagedDevBuild(o)) return null;
  const cfg = o.config === undefined ? loadConfig() : o.config;
  if (!cfg || cfg.enabled !== true) return null;
  const t = cfg.appDb || {};
  if (!nonEmpty(t.url) || !nonEmpty(t.anonKey)) return null;
  return {
    url: t.url.trim(),
    anonKey: t.anonKey.trim(),
    schema: nonEmpty(t.schema) ? t.schema.trim() : 'app',
    label: nonEmpty(cfg.label) ? cfg.label : 'dev',
  };
}

/**
 * Dev kanalının KİMLİK (CrewPane ID) hedefi (yoksa null).
 * loginUrl verilmemişse null döner — dev build'i PROD giriş sayfasına düşürmektense
 * yapılandırılmamış saymak doğrudur (yarım hedef = sessiz prod'a kayma).
 * @param {{baked?: string|null, config?: object|null}} [opts]
 * @returns {{supabaseUrl: string, anonKey: string, loginUrl: string, label: string}|null}
 */
function devIdentityTarget(opts) {
  const o = opts || {};
  if (!isPackagedDevBuild(o)) return null;
  const cfg = o.config === undefined ? loadConfig() : o.config;
  if (!cfg || cfg.enabled !== true) return null;
  const t = cfg.identity || {};
  if (!nonEmpty(t.supabaseUrl) || !nonEmpty(t.anonKey) || !nonEmpty(t.loginUrl)) return null;
  return {
    supabaseUrl: t.supabaseUrl.trim(),
    anonKey: t.anonKey.trim(),
    loginUrl: t.loginUrl.trim(),
    label: nonEmpty(cfg.label) ? cfg.label : 'dev',
  };
}

/**
 * ADP-780-B — SESSİZ DÜŞÜŞ YASAK. Paketli bir DEV build'in hedefi çözülemiyorsa bu,
 * "bugünkü davranış" değil GİZLİ BİR PROD BAĞLANTISIDIR (kimlik `PROD_CLOUD`'a düşer,
 * yani dev'de açılan hesap GERÇEK müşteri tablosuna girer). Ölçüldü ve yaşandı.
 * Çağıran (main.js açılışı) bunu logla; rozet zaten hedefi yazar.
 * @returns {string|null} anlatılacak uyarı satırı, sorun yoksa null
 */
function misconfigurationWarning(opts) {
  if (!isPackagedDevBuild(opts)) return null;
  const o = opts || {};
  const cfg = o.config === undefined ? loadConfig() : o.config;
  if (!cfg) {
    return '⛔ [dev-kanal] Paketli DEV build ama hedef yapılandırması PAKETTE YOK '
      + '(package.json:crewpaneDevTarget ve devChannelTarget.json okunamadı) → kimlik '
      + 'PROD buluta düşer. Bu kopyayla KAYIT OLMA. Çözüm: electron/devChannelTarget.json '
      + 'doldur + npm run electron:build:dev ile yeniden paketle.';
  }
  if (cfg.enabled !== true) return null; // bilinçli olarak kapalı
  if (!devAppDbTarget(opts) || !devIdentityTarget(opts)) {
    return '⛔ [dev-kanal] Hedef yapılandırması enabled=true ama YARIM (url/anahtar/loginUrl '
      + 'eksik) → kimlik PROD buluta düşer. Bu kopyayla KAYIT OLMA.';
  }
  return null;
}

/** Rapor/doktor için okunur özet (sır basmaz — yalnız URL ve etiket). */
function describe(opts) {
  const app = devAppDbTarget(opts);
  const id = devIdentityTarget(opts);
  return {
    packagedDevBuild: isPackagedDevBuild(opts),
    appDb: app ? { url: app.url, schema: app.schema } : null,
    identity: id ? { supabaseUrl: id.supabaseUrl, loginUrl: id.loginUrl } : null,
    label: (app && app.label) || (id && id.label) || null,
  };
}

module.exports = {
  devAppDbTarget, devIdentityTarget, isPackagedDevBuild, describe, misconfigurationWarning, loadConfig,
};
