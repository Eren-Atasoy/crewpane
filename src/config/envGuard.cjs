// ENV-03 — ORTAM KAPISI (tek karar noktası, SAF modül).
//
// NEDEN BU DOSYA VAR
// -----------------------------------------------------------------------------
// ENV-R3 (2026-08-26) üç şeyi ÖLÇTÜ:
//   B1 — bir ajan pane'inde `CREWPANE_INSTANCE=dev` uygulama DB'sini PRODUCTION
//        buluta çözüyor (https://rwyydz….supabase.co · schema `app`). Aynı komut
//        temiz kabukta 127.0.0.1:54321'e gidiyor; fark komutu yazana GÖRÜNMEZ.
//   B2 — dört e2e spec'i tam bunu yapıp yorumunda "→ prod'a dokunmaz" diyor.
//   B3 — bulut `app` şemasında ADP-307 DB bariyeri YOK; son savunma hattı
//        uygulama katmanının pin'ine dayanıyor ve B1 o pin'in delindiği yer.
//
// Kapıların ANLAMI `crewpane-id/scripts/dev-env/guard.mjs`ten (ADP-780-A) birebir
// taşındı; İMZASI taşınamadı: oranın birimi Supabase proje ref'i (yönetim API'si),
// buranın birimi PostgREST URL'i. O yüzden modül KOPYALANMADI, deseni yeniden
// kuruldu — ve kapılar aynı dört ilkeye uyuyor:
//
//   KAPI A — İZİN LİSTESİ (statik): hedef URL, `e2e/test-targets.json`da KAYITLI
//            bir test hedefiyle birebir aynı olmalı. "prod değil ⇒ test" çıkarımı
//            YAPILMAZ. Bugünkü `testDb.isLive()` bunun TERSİ: iki girdilik bir red
//            listesi — listede olmayan HER şey (bulut prod dâhil) kabul ediliyordu.
//   KAPI B — RED LİSTESİ (statik): host PROD'a ya da PAYLAŞIMLI bulut dev'e mi ait?
//            KAPI A'yı geçse bile (biri kayıt dosyasına prod yazsa) burada ölür.
//            Kasıtlı olarak "gereksiz" görünür — savunma derinliği budur.
//   KAPI C — CANLI DAMGA (dinamik): hedefin KENDİSİ "ben test'im" diyor mu
//            (`public.env_marker`)? Statik kapılar yazım hatasına karşı korur;
//            bu kapı hedefin GERÇEKTEN ne olduğunu HEDEFE SORAR. Prod'da böyle
//            bir satır YOKTUR → damganın yokluğu "burası prod" demektir.
//
// SABİTLER SABİTTİR: `PROD_HOSTS`/`SHARED_DEV_HOSTS` env'den BESLENMEZ. Env'i
// yazabilen herkes için açık olan bir koruma, koruma değildir (ADP-723 dersi).
// Bunu bir YAPISAL TEST kanıtlar (envGuard.test.cjs → "sabit env'le ezilemez").
//
// SAF MODÜL: I/O yok, `process.env` okuması yok (env parametreyle gelir), ağ yok.
// → birim testi kolay, mutasyon testiyle KIRMIZI verebildiği kanıtlanabilir:
//   node --test electron/envGuard.test.cjs
//   node scripts/envGuard-mutation-proof.mjs

'use strict';

/**
 * PRODUCTION host'ları — SABİT. Buraya asla env'den değer gelmez.
 * `backendTarget.PROD_CLOUD.url` ile aynı proje; oradaki sabit URL, buradaki host
 * listesi. (İki yerde yazılı olması bilinçli: biri HEDEF seçer, biri hedefi REDDEDER.)
 */
const PROD_PROJECT_REF = 'xjhwkikjsqiyywpolmld';
/** PAYLAŞIMLI bulut DEV projesi (crewpane-dev) — prod değil, ama atılabilir de değil. */
const SHARED_DEV_PROJECT_REF = 'vpctwyxjdjeetznsuiqi';

/**
 * Supabase YÖNETİM API'si. Host tek başına bir şey söylemez (aynı host hem dev hem
 * prod projeye hizmet eder) — karar YOLDAKİ proje ref'ine bakılarak verilir.
 * ENV-R3 V7 tam olarak buradan kaçıyordu: `roledef02` GATE spec'i her koşuda
 * `api.supabase.com/v1/projects/rwyydz…/database/query` çağırıyor ve host tabanlı
 * hiçbir liste bunu görmüyordu.
 */
const MANAGEMENT_HOSTS = Object.freeze(['api.supabase.com']);

const PROD_HOSTS = Object.freeze([
  'xjhwkikjsqiyywpolmld.supabase.co',
  'db.xjhwkikjsqiyywpolmld.supabase.co',
  'accounts.crewpane.dev',
  'crewpane.dev',
  'n8n.crewpane.dev',
]);

/**
 * PAYLAŞIMLI bulut DEV — prod değil ama "atılabilir" de değil: başka oturumlar da
 * aynı veritabanına yazıyor (ENV-R3 V11). Bir e2e koşusu buraya YAZAMAZ; test
 * verisi yalnız adanmış e2e stack'ine (55321) gider.
 */
const SHARED_DEV_HOSTS = Object.freeze([
  'vpctwyxjdjeetznsuiqi.supabase.co',
  'db.vpctwyxjdjeetznsuiqi.supabase.co',
  'accounts-dev.crewpane.dev',
]);

/** KAPI C — canlı damga sözleşmesi. `dev` damgası da vardır ama e2e YALNIZ `test` kabul eder. */
const ENV_MARKER = Object.freeze({
  table: 'public.env_marker',
  key: 'environment',
  test: 'test',
  dev: 'dev',
});

class EnvGuardError extends Error {
  constructor(gate, message) {
    super(`[ENV-03 KAPI ${gate}] ${message}`);
    this.name = 'EnvGuardError';
    this.gate = gate;
  }
}

const norm = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/** Sondaki '/' anlamlı değil — karşılaştırma öncesi düşürülür. */
function normalizeUrl(value) {
  return norm(value).replace(/\/+$/, '');
}

/** URL/host karışık gelebilir — hepsinden host çıkar (çıkmazsa ham değeri döndür). */
function hostOf(value) {
  const v = norm(value);
  if (!v) return '';
  if (!v.includes('://')) return v.split('/')[0];
  try {
    return new URL(v).hostname;
  } catch {
    return v;
  }
}

/**
 * Bir URL'in işaret ettiği Supabase PROJE REF'i.
 *   https://<ref>.supabase.co/…                       → <ref>   (PostgREST/GoTrue)
 *   https://api.supabase.com/v1/projects/<ref>/…      → <ref>   (yönetim API'si)
 * Bulunamazsa '' döner (host tabanlı kapılar yine de koşar).
 */
function refFromUrl(url) {
  const h = hostOf(url);
  const m = /^(?:db\.)?([a-z0-9]{20})\.supabase\.co$/.exec(h);
  if (m) return m[1];
  if (MANAGEMENT_HOSTS.includes(h)) {
    const p = /\/v1\/projects\/([a-z0-9]{20})(?:[/?#]|$)/.exec(norm(url));
    if (p) return p[1];
  }
  return '';
}

/** KAPI B — hedef PRODUCTION mu? (host VEYA proje ref'i; şüphede prod say: fail-closed) */
function isProdTarget(url) {
  const h = hostOf(url);
  if (h && PROD_HOSTS.includes(h)) return true;
  return refFromUrl(url) === PROD_PROJECT_REF;
}

/** KAPI B — hedef PAYLAŞIMLI bulut dev mi? (host VEYA proje ref'i) */
function isSharedDevTarget(url) {
  const h = hostOf(url);
  if (h && SHARED_DEV_HOSTS.includes(h)) return true;
  return refFromUrl(url) === SHARED_DEV_PROJECT_REF;
}

/** Yasak host'lardan herhangi biri (tripwire tek soru sorar). */
function isForbiddenTarget(url) {
  return isProdTarget(url) || isSharedDevTarget(url);
}

/**
 * KAPI B — yalnız RED listesi. ATAR ya da hedefi döndürür.
 * KAPI A'nın uygulanamadığı yerlerde (tripwire, script kapıları) tek başına kullanılır.
 */
function assertNotForbiddenTarget(url, what = 'hedef') {
  if (isProdTarget(url)) {
    throw new EnvGuardError(
      'B',
      `${what} PRODUCTION (${hostOf(url)}). Test/e2e kipindeki hiçbir koşu prod'a çıkamaz. ` +
        `Bu bir yapılandırma hatasıdır — komutu değil, hedefi düzelt.`,
    );
  }
  if (isSharedDevTarget(url)) {
    throw new EnvGuardError(
      'B',
      `${what} PAYLAŞIMLI bulut DEV (${hostOf(url)}). Orası atılabilir bir veritabanı DEĞİL — ` +
        `başka oturumlar da aynı satırları okuyor. Test verisi yalnız adanmış e2e stack'ine gider.`,
    );
  }
  return normalizeUrl(url);
}

/**
 * KAPI A + KAPI B — statik kapılar. Geçemezse ATAR.
 *
 * @param {string} url            gidilmek istenen hedef
 * @param {{targets?: Array<{url: string, label?: string, marker?: string}>}} registered
 *        `e2e/test-targets.json` içeriği. BOŞ ⇒ hiçbir koşu yazmaz (fail-closed).
 * @returns {{url: string, label: string, marker: string}} kayıtlı hedefin kaydı
 */
function assertTestTarget(url, registered) {
  // KAPI B ÖNCE koşar: prod işareti taşıyan hiçbir şey ilerlemesin (kayıt bozuk olsa bile).
  assertNotForbiddenTarget(url, 'e2e hedefi');

  const list = Array.isArray(registered && registered.targets) ? registered.targets : [];
  if (list.length === 0) {
    throw new EnvGuardError(
      'A',
      `Kayıtlı test hedefi YOK (e2e/test-targets.json → targets boş). Boş izin listesi ` +
        `= hiçbir koşu yazamaz (fail-closed). Hedefi kaydet, sonra koş.`,
    );
  }
  for (const t of list) {
    // Kayıt dosyasına prod yazılmış olabilir — savunma derinliği: kaydın kendisi de denetlenir.
    if (isProdTarget(t && t.url) || isSharedDevTarget(t && t.url)) {
      throw new EnvGuardError(
        'B',
        `e2e/test-targets.json içinde YASAK bir hedef kayıtlı (${hostOf(t.url)}). Kayıt ` +
          `bozulmuş — dosyayı düzeltmeden hiçbir e2e koşusu başlamaz.`,
      );
    }
  }

  const want = normalizeUrl(url);
  if (!want) {
    throw new EnvGuardError('A', `e2e hedefi çözülemedi (URL boş).`);
  }
  const hit = list.find((t) => normalizeUrl(t && t.url) === want);
  if (!hit) {
    const known = list.map((t) => t.url).join(', ');
    throw new EnvGuardError(
      'A',
      `Hedef (${url}) KAYITLI test hedeflerinden biri değil [${known}]. Tanınmayan hedef ` +
        `reddedilir — "prod değilse test'tir" varsayımı YAPILMAZ. e2e stack'ini başlat: ` +
        `npm run e2e:db:start`,
    );
  }
  return { url: normalizeUrl(hit.url), label: hit.label || '', marker: hit.marker || ENV_MARKER.test };
}

/**
 * KAPI C — canlı damga. `public.env_marker` sorgusunun SONUCU verilir (satır dizisi).
 * Satır yoksa / değer beklenenden farklıysa ATAR. Sorguyu bu modül YAPMAZ (saf kalsın).
 *
 * Damganın YOKLUĞU bir bilgidir: prod'da bu tablo yoktur, dolayısıyla "damga yok" =
 * "burası prod olabilir" demektir ve fail-closed reddedilir.
 */
function assertLiveMarker(rows, expected = ENV_MARKER.test) {
  const list = Array.isArray(rows) ? rows : [];
  const hit = list.find((r) => norm(r && (r.key ?? r.k)) === ENV_MARKER.key);
  if (!hit) {
    throw new EnvGuardError(
      'C',
      `Hedef veritabanında ${ENV_MARKER.table} damgası YOK. Bu veritabanı bir test ortamı ` +
        `olduğunu SÖYLEMİYOR → yazma yapılmaz. (Damgayı ENV-03 migration'ı koyar; prod'da ` +
        `bu tablo hiç yoktur.)`,
    );
  }
  const value = norm(hit.value ?? hit.v);
  if (value !== norm(expected)) {
    throw new EnvGuardError(
      'C',
      `${ENV_MARKER.table} damgası '${value || '(boş)'}' — beklenen '${expected}'. ` +
        `Yerel geliştirme DB'si ('dev') e2e hedefi DEĞİLDİR.`,
    );
  }
  return true;
}

module.exports = {
  PROD_PROJECT_REF,
  SHARED_DEV_PROJECT_REF,
  MANAGEMENT_HOSTS,
  PROD_HOSTS,
  SHARED_DEV_HOSTS,
  ENV_MARKER,
  EnvGuardError,
  hostOf,
  refFromUrl,
  normalizeUrl,
  isProdTarget,
  isSharedDevTarget,
  isForbiddenTarget,
  assertNotForbiddenTarget,
  assertTestTarget,
  assertLiveMarker,
};
