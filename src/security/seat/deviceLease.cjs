// CrewPane — Seat Gate Device Leasing and Heartbeat Operations.
'use strict';

const { DEVICE_DENIALS } = require('./constants.cjs');

/** SEC-01/02 — isteğe binen cihaz kimliği (tek yer). */
function deviceParam(ctx) {
  const { device } = ctx;
  return device && device.id
    ? { id: device.id, name: device.name, platform: device.platform, app: 'crewpane' }
    : undefined;
}

/**
 * SEC-02 — sunucunun cihaz cevabını tek şekle indir. `denied:false` alanı
 * BİLEREK her zaman yazılır: eski bir ret nesnesinin üstüne yeni bilgi
 * yazıldığında "denied" bayrağı asılı kalırsa ekran çözülmüş bir sorunu
 * göstermeye devam eder.
 */
function applyDeviceInfo(ctx, info) {
  ctx.deviceInfo = info && typeof info === 'object' ? { ...info, denied: false } : null;
  const mins = ctx.deviceInfo && Number(ctx.deviceInfo.heartbeat_minutes);
  if (Number.isFinite(mins) && mins > 0) ctx.heartbeatMs = mins * 60_000;
}

/**
 * SEC-02 — KİRA KALP ATIŞI. Kirayı sunucu tarafında canlı tutar.
 *
 * NEDEN VAR: kira KISA (15 dk) çünkü çöken bir makinenin koltuğu saatlerce
 * asılı kalmamalı. Kısa kira, ancak açık kalan uygulama onu tazelerse çalışır
 * — yoksa 15 dakika sonra kullanıcının KENDİ açık uygulaması "ölü" sayılır ve
 * ikinci makinesi onu içeri alır (ölçüm de yanlış çıkar).
 *
 * NEDEN JETON DEĞİL: `device_action=heartbeat` jeton İMZALAMAZ. Beş dakikada
 * bir ES256 imzalatmak, hiçbir işe yaramayan bir maliyet olurdu.
 */
function startHeartbeat(ctx) {
  if (ctx.heartbeatTimer || !ctx.device || !ctx.device.id) return;
  ctx.heartbeatTimer = setInterval(() => { void heartbeat(ctx); }, ctx.heartbeatMs);
  // Uygulamanın çıkışını BEKLETME: zamanlayıcı event loop'u ayakta tutmasın.
  if (typeof ctx.heartbeatTimer.unref === 'function') ctx.heartbeatTimer.unref();
  ctx.log(`seatGate: cihaz kirası kalp atışı başladı (${Math.round(ctx.heartbeatMs / 60000)}dk)`);
}

function stopHeartbeat(ctx) {
  if (!ctx.heartbeatTimer) return;
  clearInterval(ctx.heartbeatTimer);
  ctx.heartbeatTimer = null;
}

/**
 * LIC-ENFORCE-01 — AÇIK OTURUMDA YETKİ DEĞİŞİMİNİ YAKALA (ölçülen açık).
 *
 * ÖLÇÜLDÜ (LIC-ENFORCE-01): kalp atışı YALNIZ cihaz kirasını tazeliyordu; jeton
 * imzalamadığı için ENTITLEMENT'a hiç bakmıyordu. Lisans tazelemesi ise yalnız
 * açılış/giriş/ödeme-dönüşü/"Durumu yenile" yollarında koşuyordu. Sonuç: iade
 * alan kullanıcı uygulamayı KAPATMADIĞI sürece — internet açıkken bile —
 * jetonun 72 saati (+grace) boyunca çalışmaya devam ediyordu. Eren'in
 * direktifi ("kesinlikle uygulamayı kullanamasın") tam da bunu kapatmayı ister.
 *
 * NEDEN 5 DAKİKADA BİR ES256 İMZALAMIYORUZ: gerek yok. Sunucu kalp atışının
 * cevabında zaten "bu hesapta erişim veren aktif bir ürün var mı"yı söylüyor
 * (`device.reason === 'no_tier'` ⇔ yetki YOK; aksi hâlde `device.tier` dolu).
 * Bu UCUZ sinyal ile ELİMİZDEKİ karar UYUŞMUYORSA — ve yalnız o zaman — pahalı
 * yolu (imzalı jeton) çağırırız. Kararı yine JETON verir: sunucunun kısa cevabı
 * bir KARAR DEĞİL, bir UYUŞMAZLIK SİNYALİDİR (ikinci bir gerçek kaynağı olmaz).
 *
 * KENDİ KENDİNİ SINIRLAR: tazeleme sonrası yerel karar sunucununkiyle hizalanır
 * → uyuşmazlık kalmaz → bir sonraki atış yeniden imza İSTEMEZ. Yani normal
 * kullanıcıda maliyeti SIFIR, değişim anında TEK ek çağrıdır.
 *
 * İKİ YÖN DE ÇALIŞIR (yalnız kilitlemek değil):
 *   * yetki gitti → kapı ~1 kalp atışı içinde kapanır (yeniden başlatma YOK)
 *   * yetki geldi → kullanıcı satın aldıktan sonra kapı kendiliğinden AÇILIR
 */
async function reconcileEntitlement(ctx, info) {
  if (!info || typeof info !== 'object') return;
  // Sunucu "yetki yok" diyorsa reason='no_tier'; diyecek bir şeyi yoksa
  // (eski istemci / defter okunamadı) HÜKÜM ÇIKARMAYIZ — sessiz geçeriz.
  const serverSaysNone = info.reason === 'no_tier';
  const serverSaysSome = typeof info.tier === 'string' && !!info.tier;
  if (!serverSaysNone && !serverSaysSome) return;
  const localSeat = !!(ctx.snapshot && ctx.snapshot.seat);
  if (serverSaysNone === !localSeat) return; // uyuşuyor → pahalı yola GEREK YOK
  ctx.log(`seatGate: kalp atışı YETKİ UYUŞMAZLIĞI gördü (sunucu=${serverSaysNone ? 'yok' : (info.tier || 'var')} `
    + `yerel=${localSeat ? 'var' : 'yok'}) — imzalı jeton isteniyor`);
  await ctx.refreshLicense().catch((e) => ctx.log(`seatGate: uyuşmazlık tazelemesi hata (${e.message})`));
}

/**
 * Tek bir kalp atışı. Sunucu bu atışta REDDEDERSE (başka cihaz koltuğu almış,
 * paket düşmüş) durum snapshot'a yazılır — sessiz geçmez. Ağ hatası ise
 * yalnız loglanır: geçici bir kopukluk kullanıcıyı kilitlememeli.
 */
async function heartbeat(ctx) {
  if (!ctx.signedIn || !ctx.device || !ctx.device.id) return { ok: false, reason: 'no_device' };
  const res = await ctx.authPkg.fetchLicenseToken({
    supabaseUrl: ctx.supabaseUrl,
    apiKey: ctx.anonKey,
    action: 'heartbeat',
    device: deviceParam(ctx),
    getAccessToken: ctx.sessionAccessToken,
  }).catch((e) => ({ ok: false, reason: 'heartbeat_error', detail: e.message }));
  if (res.ok) {
    applyDeviceInfo(ctx, res.device);
    // `evaluate()` ŞART: snapshot'ı kuran tek yer orası. Yalnız emitChange
    // deseydik dinleyiciye ESKİ snapshot giderdi (sayaç ekranda donardı).
    ctx.evaluate();
    ctx.emitChange();
    // LIC-ENFORCE-01 — YETKİ UYUŞMAZLIĞINI BURADA YAKALA (ölçülen açık).
    await reconcileEntitlement(ctx, res.device);
    return res;
  }
  if (DEVICE_DENIALS[res.reason]) {
    // Kirayı kaybettik (başka cihaz aldı). Elde geçerli jeton varsa kullanıcı
    // ÇALIŞMAYA DEVAM eder — bu ret bir sonraki jeton tazelemesinde bağlar.
    ctx.log(`seatGate: kalp atışı reddedildi (${res.reason}) — koltuk başka cihazda`);
    stopHeartbeat(ctx);
    await ctx.refreshLicense().catch(() => {});
    return res;
  }
  ctx.log(`seatGate: kalp atışı başarısız (${res.reason}) — kira eskiyor, kilit YOK`);
  return res;
}

/**
 * SEC-02 — TEMİZ ÇIKIŞ. Uygulama kapanırken koltuğu BIRAK.
 *
 * Bu tek satır, "başka cihazda açıksın" şikâyetlerinin çoğunu doğmadan
 * öldürür: normal kapanışta koltuk 15 dakika değil ANINDA serbest kalır.
 * Cihaz hesaptan ÇIKARILMAZ — yalnız kira biter.
 *
 * Zaman aşımı ŞART: kapanış yolunda ağ bekleyen bir çağrı uygulamayı asar.
 * Bırakamazsak kayıp küçüktür (kira zaten dolacak), asılı kalan uygulama ise
 * kullanıcının gördüğü en kötü hatadır.
 */
async function releaseDeviceLease(ctx, { timeoutMs = 1500 } = {}) {
  stopHeartbeat(ctx);
  if (!ctx.signedIn || !ctx.device || !ctx.device.id) return { ok: false, reason: 'no_device' };
  const call = ctx.authPkg.fetchLicenseToken({
    supabaseUrl: ctx.supabaseUrl,
    apiKey: ctx.anonKey,
    action: 'release',
    device: deviceParam(ctx),
    getAccessToken: ctx.sessionAccessToken,
  }).catch((e) => ({ ok: false, reason: 'release_error', detail: e.message }));
  const res = await Promise.race([
    call,
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, reason: 'release_timeout' }), timeoutMs)),
  ]);
  ctx.log(`seatGate: cihaz kirası bırakıldı (${res.ok ? 'tamam' : res.reason})`);
  return res;
}

/**
 * SEC-02 — "DİĞER CİHAZLARI BIRAK" (yanlış pozitifin insan tarafındaki kaçışı).
 *
 * Uyuyan/çöken makine kirayı bırakamaz; kullanıcı 15 dakika beklemek zorunda
 * kalmasın diye kirayı KENDİSİ düşürür. Cihazlar hesapta KAYITLI KALIR
 * (`revokeDevice` ayrı ve kalıcı bir eylemdir) — kullanıcı "koltuğu bırak"
 * derken makinesini hesabından silmek istemez.
 *
 * Başarıda lisans TAZELENİR: beklenti "bıraktım, artık çalışayım"dır; bunu bir
 * sonraki otomatik tazelemeye bırakmak reddi çözülmemiş gibi gösterirdi.
 */
async function releaseOtherDevices(ctx) {
  if (!ctx.signedIn) return { ok: false, reason: 'not_signed_in' };
  if (!ctx.device || !ctx.device.id) return { ok: false, reason: 'no_device_id' };
  const res = await ctx.authPkg.fetchLicenseToken({
    supabaseUrl: ctx.supabaseUrl,
    apiKey: ctx.anonKey,
    action: 'release_others',
    device: deviceParam(ctx),
    getAccessToken: ctx.sessionAccessToken,
  }).catch((e) => ({ ok: false, reason: 'release_error', detail: e.message }));
  if (!res.ok) {
    ctx.log(`seatGate: diğer cihazlar bırakılamadı (${res.reason})`);
    return res;
  }
  ctx.log(`seatGate: diğer cihazların kirası bırakıldı (${res.released} cihaz)`);
  await ctx.refreshLicense();
  return { ok: true, released: res.released, device: ctx.deviceInfo };
}

/**
 * SEC-01 — hesaba bağlı cihazlar. `deviceId` alanı BU kurulumun kimliğiyle
 * karşılaştırılabilsin diye ayrıca döner: kullanıcı listede "bu cihaz" olanı
 * ayırt edemezse yanlışlıkla oturduğu makineyi çıkarır.
 */
async function listDevices(ctx) {
  const tok = await ctx.accessToken();
  if (!tok.ok) return { ok: false, reason: tok.reason };
  const res = await ctx.authPkg.listDevices({
    supabaseUrl: ctx.supabaseUrl, apiKey: ctx.anonKey, getAccessToken: async () => tok.token,
  });
  if (!res.ok) return res;
  return { ok: true, devices: res.devices, currentDeviceId: ctx.device ? ctx.device.id : null };
}

/**
 * SEC-01 — cihazı hesaptan çıkar. Başarıda lisans TAZELENİR: kullanıcının
 * beklentisi "çıkardım, artık çalışayım"dır; onu bir sonraki otomatik
 * tazelemeye (saatler sonra) bırakmak reddi çözülmemiş gibi gösterirdi.
 */
async function revokeDevice(ctx, deviceId) {
  const tok = await ctx.accessToken();
  if (!tok.ok) return { ok: false, reason: tok.reason };
  const res = await ctx.authPkg.revokeDevice({
    supabaseUrl: ctx.supabaseUrl, apiKey: ctx.anonKey, deviceId: String(deviceId || ''),
    getAccessToken: async () => tok.token,
  });
  if (!res.ok) return res;
  ctx.log(`seatGate: cihaz çıkarıldı (${deviceId})`);
  await ctx.refreshLicense();
  return res;
}

module.exports = {
  deviceParam,
  applyDeviceInfo,
  startHeartbeat,
  stopHeartbeat,
  reconcileEntitlement,
  heartbeat,
  releaseDeviceLease,
  releaseOtherDevices,
  listDevices,
  revokeDevice,
};
