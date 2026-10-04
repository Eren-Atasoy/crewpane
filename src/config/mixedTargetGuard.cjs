// ENV-01 Faz 3 (ENV-R1 §6) — ORTAM KARIŞIMI: tespit değil, RED.
//
// ## Ölçülen durum
// `appDbIdentity.resolveIdentityMode` auth ile app DB ayrıştığında
// `{mode:'anon', reason:'different_project'}` döner — ve bu bir HATA değil, bilinçli
// bir KARAR olarak kodlanmış (`appDbIdentity.cjs:73`). Yani karışım ürünün normal
// işleyişi sayılıyor. Sonuç (ENV-R1 §0, S1): bare-run PROD kimlik sunucusunda gerçek
// kullanıcı satırı açıyor, sonra o hesapla yerel bir DB'ye anon bağlanıyor.
//
// ## Neden UYARI değil BLOK
//  1. Uyarı ZATEN VAR ve İŞE YARAMADI. `devChannel.misconfigurationWarning()` tam bu
//     cümleyi ("Bu kopyayla KAYIT OLMA") basıyor, `main.js` log'a yazıyor — ve olay
//     yine yaşandı (ADP-780-B). GUI'den açılan bir app'te log'a yazılan uyarı,
//     kimsenin GÖRMEDİĞİ uyarıdır.
//  2. Bedeli geri alınamaz: prod `auth.users`'a düşen satır temizlik + risk demek.
//     Bir boot'u durdurmanın maliyeti 10 saniye.
//  3. Ürünün kendi deseni bu: `backendTarget.cjs:19` prod kanalında loopback'i
//     REDDEDİYOR, sessizce kabul etmiyor. Bu, aynı desenin KİMLİK eksenine uzatılması.
//
// ## Kural (tek satır)
// Kimlik origin'i ≠ app DB origin'i **VE** taraflardan en az biri BULUT ⇒ BLOK.
//
// ## Üç istisna (bloklamaz — sarı, log + rozet)
//  1. `instanceId === 'test'` **ve** app DB loopback — e2e bugün böyle koşuyor
//     (ENV-R1 §2, S7). Blok, 16 spec'i anında kırardı. ENV-03 bunu kendi kapılarıyla
//     ele alacak (ENV-R3 §2.1: asıl tehlike taşınan URL çiftidir, guard değil).
//  2. İKİ TARAF DA LOOPBACK — ENV-R2 "Profil A" hâli (app 54321 + kimlik 56321).
//     Veri prod'a GİTMEZ; yalnız `auth.uid()` çözülmez → tenant RLS lokalde test
//     edilmiyor. Bu bir uyarıdır, felaket değil.
//  3. `CREWPANE_ALLOW_MIXED_TARGETS=1` — AÇIK geliştirici kaçışı. `isCustomerBuild()`
//     altında YOK SAYILIR (`backendTarget.ESCAPE_KEYS` deseni).
//
// Müşteri build'inde guard hiç konuşmaz: orada hedefler zaten tek sabittir
// (`backendTarget` zinciri tek elemanlı) — karışım yapısal olarak imkânsız.
//
// SAF MODÜL: I/O yok, `process.env` okuması yok, Electron bağı yok.
// Çalıştır: node --test electron/mixedTargetGuard.test.cjs

'use strict';

const { normalizeProjectOrigin } = require('./appDbIdentity.cjs');
const { isLoopbackUrl } = require('./backendTarget.cjs');

/** ENV-R1 §6 istisna 3 — açık geliştirici kaçışı. */
const ALLOW_MIXED_KEY = 'CREWPANE_ALLOW_MIXED_TARGETS';

function truthy(v) {
  const raw = String(v ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

/** URL bulut mu? (loopback DEĞİL ve ayrıştırılabilir) */
function isCloudUrl(url) {
  const origin = normalizeProjectOrigin(url);
  if (!origin) return false;
  return !isLoopbackUrl(origin);
}

/**
 * Karışım kararı.
 *
 * @param {{authUrl?: string, dbUrl?: string, loginUrl?: string, instanceId?: string,
 *          allowMixed?: boolean, customerBuild?: boolean}} input
 * @returns {{level: 'ok'|'warn'|'block', reason: string, message: string|null,
 *            authOrigin: string|null, dbOrigin: string|null, cloudSide: string|null}}
 */
function checkMixedTargets(input) {
  const i = input || {};
  const authOrigin = normalizeProjectOrigin(i.authUrl);
  const dbOrigin = normalizeProjectOrigin(i.dbUrl);
  const base = { authOrigin, dbOrigin, cloudSide: null, message: null };

  // Hedeflerden biri hiç çözülmediyse karışım İDDİA ETME. "Yapılandırılmamış" ayrı
  // bir durumdur (board zaten öyle der) — burada sessiz kalmak doğru, çünkü aksi
  // hâlde ilk açılışta herkese kırmızı kart çıkardı.
  if (!authOrigin || !dbOrigin) {
    return { ...base, level: 'ok', reason: !authOrigin ? 'no_auth_url' : 'no_db_url' };
  }
  if (authOrigin === dbOrigin) return { ...base, level: 'ok', reason: 'same_project' };

  // --- buradan aşağısı: KARIŞIM VAR. Kalan soru yalnız "blok mu, sarı mı?" -------
  const authCloud = isCloudUrl(authOrigin);
  const dbCloud = isCloudUrl(dbOrigin);
  const cloudSide = authCloud && dbCloud ? 'both' : authCloud ? 'auth' : dbCloud ? 'db' : null;

  // Müşteri kopyası: hedef tek sabittir, kaçış anahtarları zaten silinmiştir.
  if (i.customerBuild === true) {
    return { ...base, level: 'ok', reason: 'customer_build', cloudSide };
  }
  // İstisna 2 — iki taraf da loopback: veri prod'a gitmez.
  if (!authCloud && !dbCloud) {
    return {
      ...base, level: 'warn', reason: 'both_loopback', cloudSide,
      message:
        `⚠️ İKİ-STACK yerel kurulum — kimlik ${authOrigin}, uygulama DB ${dbOrigin}. ` +
        'Veri buluta GİTMİYOR, ama auth.uid() çözülmediği için kiracı RLS\'i (ADP-623) ' +
        'lokalde TEST EDİLMİYOR. Tek stack için: CREWPANE_ENV=local.',
    };
  }
  // İstisna 1 — e2e/test kanalı + loopback app DB (ENV-R1 §6, ENV-R3 §2.1).
  if (String(i.instanceId || '') === 'test' && !dbCloud) {
    return {
      ...base, level: 'warn', reason: 'test_channel', cloudSide,
      message:
        `⚠️ TEST kanalı: app DB ${dbOrigin} (yerel) ama kimlik ${authOrigin}. ` +
        'Blok yok (16 e2e spec\'i kırılırdı) — kapılar ENV-03\'ün işi.',
    };
  }
  // İstisna 3 — açık geliştirici kaçışı.
  if (i.allowMixed === true) {
    return {
      ...base, level: 'warn', reason: 'allow_mixed_escape', cloudSide,
      message:
        `⚠️ ORTAM KARIŞIMI ${ALLOW_MIXED_KEY}=1 ile GEÇİLDİ — kimlik ${authOrigin}, ` +
        `uygulama DB ${dbOrigin}. Bulut taraf: ${cloudSide}. Giriş yaparsan kayıt ` +
        'kimlik sunucusunda açılır.',
    };
  }

  return {
    ...base,
    level: 'block',
    reason: 'mixed_cloud_targets',
    cloudSide,
    message: blockMessage({
      dbUrl: dbOrigin, authUrl: authOrigin, loginUrl: i.loginUrl, authCloud, dbCloud,
    }),
  };
}

/** Kırmızı kartın METNİ (ENV-R1 §6 taslağı). Kopyalanabilir çare ZORUNLU. */
function blockMessage(v) {
  const mark = (url, cloud) => `${url}${cloud ? '  (PROD/BULUT ⛔)' : '  (yerel)'}`;
  const lines = [
    '⛔ ORTAM KARIŞIMI — açılış durduruldu',
    '',
    `   uygulama DB  : ${mark(v.dbUrl, v.dbCloud)}`,
    `   kimlik       : ${mark(v.authUrl, v.authCloud)}`,
  ];
  if (v.loginUrl) lines.push(`   giriş sayfası: ${v.loginUrl}`);
  lines.push(
    '',
    'Bu kopyayla giriş yaparsan kayıt BULUT müşteri tablosunda GERÇEK kullanıcı olarak açılır,',
    'sonra o hesapla farklı bir veritabanına anon bağlanırsın (auth.uid() çözülmez → boş ofis).',
    '',
    '   Çare : CREWPANE_ENV=local npm run electron:dev',
    `   Kaçış: ${ALLOW_MIXED_KEY}=1   (yalnız geliştirici kopyası)`,
  );
  return lines.join('\n');
}

module.exports = { checkMixedTargets, isCloudUrl, blockMessage, ALLOW_MIXED_KEY, truthy };
