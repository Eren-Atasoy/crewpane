// ADP-621 — HANGİ backend? Kanal (instance) bazlı uygulama-veritabanı hedefi.
//
// ÇÖZÜLEN BUG (ADP-616 §5.2)
// -------------------------
// Paketli app müşterinin bilgisayarında `http://127.0.0.1:54321`e bağlanmaya
// çalışıyordu: main.js üç kademeli çözümlemesinin (process.env → .env.local →
// ~/.crewpane/crewpane-public-env.json) ÜÇÜ DE müşteride boş kalıyor, renderer
// da derleme-zamanı gömülü NEXT_PUBLIC_* değerine düşüyordu — yani geliştirme
// makinesinin yerel Supabase'ine. Sonuç: "TypeError: Failed to fetch" + BOŞ OFİS.
//
// Bu modül o çözümlemenin ÜSTÜNE tek bir kural koyar:
//
//   instance | uygulama DB'si                            | schema
//   ---------|-------------------------------------------|--------
//   prod     | BULUT CrewPane projesi (xjhwkikjsqiyywpolmld) | public
//   dev      | yerel 54321 (ya da açıkça verilen staging)| public
//   test     | e2e 55321 (ADP-305 — DEĞİŞMEZ)            | public
//
// FAIL-CLOSED: `prod` kanalında loopback (127.0.0.1/localhost/::1) bir hedef
// **REDDEDİLİR** ve bulut varsayılanına düşülür. Yani müşterinin app'i, ortamında
// ne yazarsa yazsın, yapısal olarak yerel bir adrese bağlanamaz — bugünkü bug
// yeniden ÜRETİLEMEZ. (Geliştirici kaçışı için tek bir açık env bayrağı var;
// aşağıya bak — müşteri kurulumunda o bayrak yoktur.)
//
// SCHEMA NEDEN BURADA: bulut projede uygulama tabloları `app` schema'sında
// (ADP-621 migration), `public` ise CrewPane ID'nin ÜYELİK/FATURA schema'sı.
// Yerel/e2e stack'lerde ise tablolar `public`te. Hedef URL ile schema birlikte
// seyahat etmezse istemci yanlış schema'yı sorgular → 404. Bu yüzden schema
// hedefin bir PARÇASI, ayrı bir ayar değil.
//
// SAF MODÜL: I/O yok, `process.env` okuması yok (env parametreyle gelir) →
// birim testi kolay, çalışma zamanında sürpriz yapmaz.
// Çalıştır: node --test electron/backendTarget.test.cjs

// ADP-723 — YUKARIDAKİ "müşteri kurulumunda o bayrak yoktur" CÜMLESİ YETMEZ.
// -----------------------------------------------------------------------------
// Ölçüldü (Eren'in makinesi, 2026-07-29): `launchctl setenv` ile konan
// CREWPANE_ALLOW_LOCAL_APP_DB=1 + CREWPANE_APP_SUPABASE_URL=127.0.0.1:54321
// GUI oturumunun TAMAMINA miras geçiyor → Finder/Dock'tan açılan HER app onu alıyor.
// Sonuç: prod kanalı ile dev kanalı AYNI yerel veritabanına (54321/public) bağlandı,
// yani kanal ayrımı fiilen kalktı ("test app'te oluşturduğum takım prod app'te de var").
//
// O vakada bunlar Eren'in kendi bayraklarıydı — ama aynı tuzak müşteride de kurulabilir
// (kurulum script'i, MDM profili, `launchctl setenv`, kötü niyetli bir yükleyici). Env'e
// bağlı bir koruma, env'i yazabilen herkes için AÇIKTIR. Bu yüzden kaçış bayrakları artık
// ADP-646 desenine bağlandı: MÜŞTERİ build'inde (buildChannel.isCustomerBuild())
//   * CREWPANE_ALLOW_LOCAL_APP_DB   → YOK SAYILIR (loopback her hâlükârda reddedilir)
//   * CREWPANE_APP_SUPABASE_URL/KEY → YOK SAYILIR (prod başka bir DB'ye çekilemez)
//   * CREWPANE_APP_SUPABASE_SCHEMA  → YOK SAYILIR
//   * CREWPANE_INSTANCE=dev|test     → KANAL kararında YOK SAYILIR (prod'a sabitlenir);
//     yoksa müşteri kendini "dev" ilan edip yerel/serbest bir hedefe geçebilirdi.
// Yani müşteri kopyasında veri kaynağı ENV'DEN BAĞIMSIZ tek bir sabittir: PROD_CLOUD.

'use strict';

const supabaseTarget = require('./supabaseTarget.cjs'); // ADP-305 e2e semantiği TEK yerde kalsın
const buildChannel = require('./buildChannel.cjs');     // ADP-646 — "müşteri build'i mi?" TEK kaynak
const devChannel = require('./devChannel.cjs');         // ADP-780-B — paketli DEV build'in hedefi BUILD ZAMANINDA sabit

// ADP-520/ADP-418 ile aynı kaynak: crewpane-id/web/config.prod.js.
// anon (publishable) key PUBLIC'tir — RLS korur, sır DEĞİLDİR (app zaten renderer
// bundle'ına gömülü bir anon key ile çalışıyor). service_role ASLA buraya yazılmaz.
const PROD_CLOUD = {
  url: 'https://xjhwkikjsqiyywpolmld.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhqaHdraWtqc3FpeXl3cG9sbWxkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTExMTY2NTUsImV4cCI6MjEwNjY5MjY1NX0.JxaLPbus15lPThSRdC1SHfZo1RzzjfcJVixQETj0eFU',
};

/**
 * Bulut projede uygulama verisinin schema'sı. CrewPane'in kendi projesinde tablolar,
 * yerel stack'le AYNI migration setiyle `public`te oluşturulur (supabase/migrations).
 */
const APP_SCHEMA = 'public';
/** Yerel + e2e stack'lerde tablolar hâlâ public'te. */
const LOCAL_SCHEMA = 'public';

/** Loopback = "bu makine". Müşteride böyle bir sunucu YOKTUR. */
function isLoopbackUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false; // ayrıştırılamayan değeri loopback SAYMA (aşağıda zaten eksik sayılır)
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '[::1]') return true;
  if (host === '0.0.0.0') return true;
  return /^127\./.test(host);
}

/** 'prod' | 'dev' | 'test'; tanınmayan değer → 'dev' (ADP-616 G1: bilinmeyen kanal buluta gitmez). */
function normalizeInstance(value) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return v === 'prod' || v === 'test' ? v : 'dev';
}

/**
 * GELİŞTİRİCİ KAÇIŞI — yalnız '1'/'true' açar (diğer geliştirici bayraklarıyla aynı semantik).
 * Neden var: Eren'in GÜNLÜK sürücüsü paketli app, yani `prod` kanalı; ofisinin 26
 * ajanı/1495 görevi hâlâ yerel 54321'de. Bu bayrak olmadan bu değişiklik onun kendi
 * ofisini bir anda boş buluta çevirirdi. Bayrak ENV'de (kullanıcı-düzenlenebilir
 * config'te DEĞİL) ve müşteri kurulumunda YOKTUR → koruma müşteri için bozulmaz.
 */
function localAppDbAllowed(env) {
  const raw = String((env && env.CREWPANE_ALLOW_LOCAL_APP_DB) ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

/** Bir adayın kullanılabilmesi için hem URL hem anahtar gerekir (yarım aday sessizce atlanır). */
function complete(candidate) {
  return !!(candidate && candidate.url && candidate.anonKey);
}

/**
 * ADP-723 — MÜŞTERİ build'inde hedefi oynatabilen env anahtarları. Bunlar "kapatılır"
 * DEĞİL, env kopyasından SİLİNİR: aşağıdaki kod yollarının hiçbiri özel-durum bilmek
 * zorunda kalmasın (tek karar noktası burası), okuyanlar da "acaba başka bir yerde
 * gizlice okunuyor mu?" diye aramasın.
 */
const ESCAPE_KEYS = [
  'CREWPANE_ALLOW_LOCAL_APP_DB',
  'CREWPANE_APP_SUPABASE_URL',
  'CREWPANE_APP_SUPABASE_ANON_KEY',
  'CREWPANE_APP_SUPABASE_SCHEMA',
  // ENV-01 — tek anahtarlı hat seçimi (envProfile.cjs). Müşteri kopyasında hat
  // ENV ile OYNATILAMAZ: `envProfile.applyEnvProfile` zaten `customerBuild` altında
  // hiç uygulamıyor, bu satırlar İKİNCİ kilit — biri o dalı kaldırsa bile anahtar
  // env kopyasından SİLİNİR ve izi `rejected`e düşer.
  'CREWPANE_ENV',
  'CREWPANE_ENV',
  // ENV-01 Faz 3 — karışım reddinin geliştirici kaçışı. Müşteride karışım zaten
  // yapısal olarak imkânsız (zincir tek elemanlı); bayrağın orada bir anlamı yok.
  'CREWPANE_ALLOW_MIXED_TARGETS',
];

/** Kaçış anahtarlarını düşürülmüş bir env KOPYASI döndürür (orijinali değiştirmez). */
function stripEscapes(env, trace) {
  const out = {};
  for (const k of Object.keys(env)) {
    if (ESCAPE_KEYS.includes(k) && env[k]) {
      // İz LOGA gider: anahtar değerini basma (anon key public olsa da sır-benzeri
      // değerleri log'a düşürmeyi alışkanlık hâline getirmeyelim — [[adp586-secret-masking-limits]]).
      const shown = /KEY/.test(k) ? '<gizlendi>' : env[k];
      if (trace) trace.push({ url: `${k}=${shown}`, reason: 'env_escape_ignored_in_customer_build' });
      continue;
    }
    out[k] = env[k];
  }
  return out;
}

/**
 * Uygulama DB hedefini çöz.
 *
 * @param {object} env         process.env (veya fixture)
 * @param {string} instanceId  'prod' | 'dev' | 'test'
 * @param {{url?: string, anonKey?: string}} live  main.js'in çözdüğü "canlı" değerler
 *        (process.env → .env.local → ~/.crewpane/crewpane-public-env.json)
 *        `live.schema` (ENV-01) verilirse ve `live` adayı seçilirse ŞEMA da ondan gelir.
 * @param {{escapesAllowed?: boolean}} [opts] ADP-723 test dikişi; verilmezse buildChannel çözer.
 * @returns {{instance: string, url: string|null, anonKey: string|null, schema: string,
 *           isE2E: boolean, source: string, customerBuild: boolean,
 *           rejected: Array<{url: string, reason: string}>}}
 */
function resolveBackendTarget(env, instanceId, live, opts) {
  const o = opts || {};
  // ADP-723 — env'in DEĞİŞTİREMEDİĞİ sinyal: paketli mi + build'e gömülü kanal etiketi.
  const escapes = o.escapesAllowed === undefined ? buildChannel.escapesAllowed() : o.escapesAllowed;

  // MÜŞTERİ kopyası: kanal kararı bile env'e bırakılmaz. CREWPANE_INSTANCE=dev diyerek
  // "geliştirici gibi" bir veri kaynağına geçmek yapısal olarak imkânsız olsun.
  const requested = normalizeInstance(instanceId);
  const instance = escapes ? requested : 'prod';
  // Yok sayılan her kaçışın İZİ kalsın (log + doktor + rozet bunu okur; sessiz koruma
  // ölçülemeyen korumadır).
  const escapeTrace = [];
  if (!escapes && requested !== 'prod') {
    escapeTrace.push({ url: `instance=${requested}`, reason: 'instance_override_ignored_in_customer_build' });
  }

  const e = escapes ? (env || {}) : stripEscapes(env || {}, escapeTrace);
  // ENV-01 (ölçülmüş bug) — `publicBackendEnv.readLivePair()` ŞEMAYI da çözüyordu
  // (`NEXT_PUBLIC_CREWPANE_SUPABASE_SCHEMA`), ama çağıran onu buraya HİÇ getirmiyordu ve
  // `finalize()` şemayı URL ailesinden TAHMİN ediyordu. Sonuç: tek-stack yerel kurulumda
  // (56321 + `app`) her istek `public`e gidip 404 dönüyordu — ENV-R2 §5 "vaka B2" tuzağı.
  // Şema hedefin PARÇASIDIR, URL'den türetilmez (ADP-780-B'nin dev-baked dalında zaten
  // öğrenilmiş ders; burada `live` dalına uzatılıyor). Yalnız aday `live` iken uygulanır:
  // baked/env hedefinin şemasını ambient bir NEXT_PUBLIC değeri EZEMEZ.
  const livePair = {
    url: (live && live.url) || null,
    anonKey: (live && live.anonKey) || null,
    schema: (live && live.schema) || null,
  };

  // --- test: ADP-305 sözleşmesi. Tek satır bile canlı DB'ye gitmez. ---------
  if (instance === 'test') {
    const t = supabaseTarget.resolveSupabaseTarget(e, 'test', livePair);
    return finalize(e, escapes, {
      instance,
      url: t.url,
      anonKey: t.anonKey,
      isE2E: true,
      source: e.CREWPANE_E2E_SUPABASE_URL ? 'e2e-env' : 'e2e-default',
      // ADP-741 — "e2e hedefi var ama anahtarı yok" DURUMU taşınır. Sessizce
      // düşürülürse çağıran canlı çifte geri düşer (test app'i ÜRETİM verisine
      // bağlanır) — ADP-305 sözleşmesinin tam tersi.
      keyMissing: t.keyMissing,
      rejected: escapeTrace,
    });
  }

  // Açık env ezmesi (staging/başka bulut proje): İKİSİ birden verilmeli.
  const envPair = {
    url: e.CREWPANE_APP_SUPABASE_URL || null,
    anonKey: e.CREWPANE_APP_SUPABASE_ANON_KEY || null,
  };

  // --- dev: PAKETLİ DEV BUILD'de hedef BUILD ZAMANINDA sabittir; ------------
  //     aksi hâlde bugünkü davranış aynen korunur (env → live → yerel 54321).
  //
  // ADP-780-B — sıralamada `baked` EN ÖNDE: dev DMG'nin hangi backend'e bakacağı
  // makinenin ortamına (launchctl setenv, .env.local, ~/.crewpane/*.json) bırakılamaz.
  // ADP-723'te ölçülen tuzağın dev-kanalı karşılığı budur. Kaynaktan koşuda
  // (`baked` yok) devChannel null döner → hiçbir geliştirici akışı değişmez.
  if (instance === 'dev') {
    const baked = o.devAppDb === undefined ? devChannel.devAppDbTarget() : o.devAppDb;
    if (baked) {
      if (complete(envPair)) {
        escapeTrace.push({ url: envPair.url, reason: 'env_target_ignored_in_packaged_dev_build' });
      }
      // ENV-01 — `live` çifti de yok sayıldı. Bu iz OLMADAN paketli dev DMG'de
      // `CREWPANE_ENV=local` verildiğinde hiçbir yerde "profilin hedefi düşürüldü"
      // yazmıyordu (ölçüldü, T7): kullanıcı profili verdiğini sanıp bulut dev'e
      // bakan bir app'le çalışıyordu. Sessiz koruma, ölçülemeyen korumadır.
      if (complete(livePair) && livePair.url !== baked.url) {
        escapeTrace.push({ url: livePair.url, reason: 'live_target_ignored_in_packaged_dev_build' });
      }
      return finalize(e, escapes, {
        instance,
        url: baked.url,
        anonKey: baked.anonKey,
        isE2E: false,
        source: 'dev-baked',
        schemaOverride: baked.schema,
        rejected: escapeTrace,
      });
    }
    const picked = complete(envPair) ? { ...envPair, source: 'app-env' }
                 : complete(livePair) ? { ...livePair, source: 'live' }
                 : { url: null, anonKey: null, source: 'none' };
    return finalize(e, escapes, {
      instance, ...picked, isE2E: false, rejected: escapeTrace,
      liveSchema: picked.source === 'live' ? livePair.schema : null,
    });
  }

  // --- prod: loopback YASAK; sırayla ilk TAM ve loopback-olmayan aday. ------
  const allowLocal = localAppDbAllowed(e); // müşteri build'inde `e` zaten arındırıldı → false
  const rejected = escapeTrace;
  // ADP-723 — MÜŞTERİ kopyasında zincir TEK elemanlıdır: uzak bir hedefi kabul eden her
  // aday (env ezmesi VE ~/.crewpane/crewpane-public-env.json gibi makine dosyaları)
  // prod'u yabancı bir veritabanına taşıyabilir. Kaçış yolu "yerel adres" ile sınırlı
  // değildir; o yüzden müşteride hedef tek bir SABİTTİR.
  const chain = escapes
    ? [
      { ...envPair, source: 'app-env' },
      { ...livePair, source: 'live' },
      { ...PROD_CLOUD, source: 'cloud-default' },
    ]
    : [{ ...PROD_CLOUD, source: 'cloud-default' }];
  if (!escapes && complete(livePair)) {
    rejected.push({ url: livePair.url, reason: 'machine_env_file_ignored_in_customer_build' });
  }

  for (const candidate of chain) {
    if (!complete(candidate)) continue;
    if (isLoopbackUrl(candidate.url) && !allowLocal) {
      // Bugünkü bug tam olarak burada ölür: prod kanalı yerel adrese BAĞLANMAZ.
      rejected.push({ url: candidate.url, reason: 'loopback_rejected_in_prod' });
      continue;
    }
    return finalize(e, escapes, {
      instance, ...candidate, isE2E: false, rejected,
      liveSchema: candidate.source === 'live' ? livePair.schema : null,
    });
  }

  // Buraya düşmek için PROD_CLOUD'un da eksik olması gerekir (sabit → pratikte imkânsız).
  return finalize(e, escapes, {
    instance, url: null, anonKey: null, isE2E: false, source: 'none', rejected,
  });
}

/**
 * Schema'yı hedefin URL ailesinden türet (env ile açıkça ezilebilir — müşteri build'inde
 * o env anahtarı zaten `stripEscapes` ile düşürülmüştür).
 *
 * ADP-723 — dönen görüntüye `customerBuild` eklendi: kanal rozeti (DataSourceBadge) ve
 * açılış logu "bu kopyada kaçış bayrakları etkisiz mi?" sorusunu TÜRETMEDEN okuyabilsin.
 */
function finalize(env, escapes, target) {
  // ADP-780-B — dev-baked hedef ŞEMAYI DA taşır: dev projede tablolar `app` şemasında
  // olabilir ama URL bulut olmayabilir (yerel dev stack). Şema hedefin parçasıdır,
  // URL'den TAHMİN edilmez (ADP-621'in aynı dersi, bir kanal daha).
  // Öncelik: baked damga → açık ESCAPE anahtarı → `live` çiftinin KENDİ şeması
  // (ENV-01) → URL ailesinden türetme (son çare). `liveSchema` yalnız `live` adayı
  // seçildiğinde dolar, yani bu satır baked/env hedeflerini etkilemez.
  const schema = target.schemaOverride
    || (env && env.CREWPANE_APP_SUPABASE_SCHEMA)
    || target.liveSchema
    || (target.url && !isLoopbackUrl(target.url) ? APP_SCHEMA : LOCAL_SCHEMA);
  return {
    instance: target.instance,
    url: target.url || null,
    anonKey: target.anonKey || null,
    schema,
    isE2E: !!target.isE2E,
    source: target.source,
    customerBuild: !escapes,
    keyMissing: target.keyMissing || null, // ADP-741
    rejected: target.rejected || [],
  };
}

module.exports = {
  resolveBackendTarget,
  isLoopbackUrl,
  normalizeInstance,
  localAppDbAllowed,
  PROD_CLOUD,
  APP_SCHEMA,
  LOCAL_SCHEMA,
  ESCAPE_KEYS, // ADP-723 — denetim/rapor script'leri aynı listeyi ikinci kez yazmasın
};
