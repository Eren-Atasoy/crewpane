// CrewPane — Seat Gate Factory and Lifecycle Core.
'use strict';

const path = require('node:path');
const { HEARTBEAT_FALLBACK_MS } = require('./constants.cjs');
const deviceLease = require('./deviceLease.cjs');
const licenseManager = require('./licenseManager.cjs');

/**
 * @param {object} opts
 * @param {object} opts.authPkg      - @crewpane/auth (require edilmiş)
 * @param {object} opts.safeStorage  - Electron safeStorage (veya test ikizi)
 * @param {string} opts.homeDir      - ~/.crewpane (instance-aware; auth/ altına yazar)
 * @param {string} opts.supabaseUrl
 * @param {string} opts.anonKey
 * @param {string} opts.scheme       - 'crewpane'
 * @param {string} [opts.loginUrl]
 * @param {(url:string)=>unknown} opts.openExternal - sistem tarayıcısı (shell.openExternal)
 * @param {(line:string)=>void} [opts.log]
 * @param {()=>void} [opts.onChange] - durum değişince (Ayarlar'a canlı push)
 * @param {boolean} [opts.requireSeat=false] - ADP-646 LİSANS KAPISI
 * @param {boolean} [opts.requireLogin=false] - ADP-520 LOGIN DUVARI
 * @param {string} [opts.billingUrl] - "Satın al" hedefi
 * @param {string} [opts.appVersion] - ADP-714: oturum kaydına düşecek ürün sürümü
 * @param {{id:string,name?:string,platform?:string}} [opts.device] - SEC-01: cihaz kimliği
 */
function createSeatGate(opts) {
  const {
    authPkg, safeStorage, homeDir, supabaseUrl, anonKey, scheme,
    loginUrl, billingUrl = null, openExternal, onChange,
    requireSeat = false, requireLogin = false, device = null,
  } = opts;
  const log = opts.log || (() => {});

  const guardStore = opts.guardSecretStore
    || require('../secretBackendState.cjs').guardTokenStore;
  const sessionStore = guardStore(authPkg.createSafeStorageTokenStore({
    safeStorage, filePath: path.join(homeDir, 'auth', 'session.bin'),
    log, label: 'session',
  }), { label: 'session', log });
  const licenseStore = guardStore(authPkg.createSafeStorageTokenStore({
    safeStorage, filePath: path.join(homeDir, 'auth', 'license.bin'),
    log, label: 'license',
  }), { label: 'license', log });

  const auth = authPkg.createDesktopAuth({
    supabaseUrl,
    apiKey: anonKey,
    redirectUri: `${scheme}://auth/callback`,
    tokenStore: sessionStore,
    openExternal,
    loginUrl: loginUrl || undefined,
    appId: 'CrewPane',
    appVersion: opts.appVersion || undefined,
  });

  const ctx = {
    opts,
    authPkg,
    safeStorage,
    homeDir,
    supabaseUrl,
    anonKey,
    scheme,
    loginUrl,
    billingUrl,
    openExternal,
    onChange,
    requireSeat,
    requireLogin,
    device,
    log,
    auth,
    sessionStore,
    licenseStore,
    signedIn: false,
    email: null,
    userId: null,
    licenseToken: null,
    lastServerTime: null,
    revocation: null,
    snapshot: null,
    deviceInfo: null,
    integrityDenied: false,
    heartbeatTimer: null,
    heartbeatMs: HEARTBEAT_FALLBACK_MS,
    emitChange() {
      try {
        if (onChange) onChange(ctx.snapshot);
      } catch (e) {
        log(`seatGate onChange error: ${e.message}`);
      }
    },
    deviceParam() {
      return deviceLease.deviceParam(ctx);
    },
    applyDeviceInfo(info) {
      return deviceLease.applyDeviceInfo(ctx, info);
    },
    startHeartbeat() {
      return deviceLease.startHeartbeat(ctx);
    },
    stopHeartbeat() {
      return deviceLease.stopHeartbeat(ctx);
    },
    evaluate() {
      return licenseManager.evaluate(ctx);
    },
    refreshLicense() {
      return licenseManager.refreshLicense(ctx);
    },
    sessionAccessToken() {
      return licenseManager.sessionAccessToken(ctx);
    },
    accessToken() {
      return licenseManager.accessToken(ctx);
    },
  };

  /** Açılış: depodan oturum + jeton yükle; çevrimiçiyse ARKADA tazele (açılışı bekletme). */
  async function init() {
    const doc = await sessionStore.load().catch(() => null);
    if (doc && doc.session) {
      ctx.signedIn = true;
      ctx.email = (doc.session.user && doc.session.user.email) || null;
      ctx.userId = (doc.session.user && doc.session.user.id) || null;
    }
    const lic = await licenseStore.load().catch(() => null);
    if (lic && typeof lic.token === 'string') {
      ctx.licenseToken = lic.token;
      ctx.lastServerTime = typeof lic.lastServerTime === 'number' ? lic.lastServerTime : null;
    }
    ctx.revocation = (lic && authPkg.normalizeRevocationStamp)
      ? authPkg.normalizeRevocationStamp(lic.revocation) : null;
    licenseManager.evaluate(ctx);
    const blob = typeof sessionStore.lastLoadOutcome === 'function'
      ? sessionStore.lastLoadOutcome() : { state: 'unknown' };
    log(`seatGate init: signedIn=${ctx.signedIn} sessionBlob=${blob.state} license=${ctx.snapshot.licenseStatus} revoked=${ctx.revocation ? ctx.revocation.reason : '-'} seat=${ctx.snapshot.seat} tier=${ctx.snapshot.tier || '-'} requireSeat=${requireSeat} requireLogin=${requireLogin} access=${ctx.snapshot.accessAllowed}`);
    if (!ctx.signedIn && blob.state && blob.state !== 'absent' && blob.state !== 'ok') {
      log('⛔ seatGate: giriş ekranı gösterilecek ama bu "çıkış yapılmış" DEĞİL — '
        + `oturum blob'u okunamadı/çözülemedi (${blob.state}). Aynı sebep her açılışta `
        + 'tekrar ederse giriş döngüsü budur (ADP-943).');
    }
    ctx.emitChange();
    if (ctx.signedIn) {
      licenseManager.refreshLicense(ctx).catch((e) => log(`seatGate init refresh error: ${e.message}`));
    }
    return ctx.snapshot;
  }

  /** Ayarlar "CrewPane ile giriş" → SİSTEM TARAYICISI (gömülü webview YASAK). */
  async function signIn() {
    const res = await auth.signIn();
    log(`seatGate: signIn başlatıldı (state=${res.state.slice(0, 8)}…)`);
    return res;
  }

  /** E-posta magic-link (e2e + tarayıcısız akış). */
  async function signInWithEmail(addr) {
    return auth.signInWithEmail(addr);
  }

  /**
   * C-07 — bu URL success sayfasının "Uygulamaya dön" ödeme dönüşü mü?
   * (<scheme>://billing/updated?plan=… — billing.cjs isBillingReturnUrl ile aynı
   * sözleşme; burada yerel, çünkü seatGate billing client tutmaz.)
   */
  function isBillingReturnUrl(url) {
    if (typeof url !== 'string' || !url) return false;
    let u;
    try { u = new URL(url); } catch { return false; }
    return u.protocol === `${scheme}:` && u.host.toLowerCase() === 'billing';
  }

  /**
   * C-07 — JETON TAZELEME ÇENGELİ (ödeme dönüşü).
   */
  async function handleBillingReturn(url, billingOpts) {
    if (!isBillingReturnUrl(url)) return { ok: false, reason: 'not_billing_url' };
    if (!ctx.signedIn) {
      log('seatGate: billing dönüşü geldi ama oturum yok — tazeleme atlandı');
      licenseManager.evaluate(ctx);
      ctx.emitChange();
      return { ok: false, reason: 'not_signed_in' };
    }
    const attempts = Math.max(1, (billingOpts && billingOpts.attempts) || 5);
    const delayMs = (billingOpts && billingOpts.delayMs) || 2000;
    const beforeSeat = !!(ctx.snapshot && ctx.snapshot.seat);
    const beforeTier = (ctx.snapshot && ctx.snapshot.tier) || null;
    log(`seatGate: billing dönüşü — lisans tazeleniyor (en çok ${attempts} deneme, aralık ${delayMs}ms)`);
    for (let i = 1; i <= attempts; i++) {
      if (i > 1) await new Promise((r) => setTimeout(r, delayMs));
      await licenseManager.refreshLicense(ctx).catch((e) => log(`seatGate billing refresh error: ${e.message}`));
      const s = ctx.snapshot || {};
      if (s.seat && (!beforeSeat || s.tier !== beforeTier)) {
        log(`seatGate: billing dönüşü TAMAM — paket tanındı (katman=${s.tier || 'seat'}, deneme ${i}/${attempts})`);
        return { ok: true, seat: true, tier: s.tier || null, attempts: i };
      }
    }
    const s = ctx.snapshot || {};
    if (s.seat) {
      log(`seatGate: billing dönüşü — katman değişimi görünmedi ama paket aktif (katman=${s.tier || 'seat'})`);
      return { ok: true, seat: true, tier: s.tier || null, attempts, changed: false };
    }
    log(`seatGate: billing dönüşü — paket ${attempts} denemede görünmedi (webhook gecikmiş olabilir); `
      + '"Durumu yenile" çalışmaya devam eder');
    return { ok: false, reason: 'entitlement_not_ready', attempts };
  }

  /** crewpane://auth/callback?code&state — open-url / second-instance'tan gelir. */
  async function handleUrl(url) {
    if (isBillingReturnUrl(url)) return handleBillingReturn(url);
    const res = await auth.handleCallback(url);
    if (res.ok) {
      ctx.signedIn = true;
      ctx.email = (res.session.user && res.session.user.email) || null;
      ctx.userId = (res.session.user && res.session.user.id) || null;
      log(`seatGate: giriş TAMAM (${ctx.email || ctx.userId || '?'})`);
      await licenseManager.refreshLicense(ctx);
    } else {
      log(`seatGate: callback reddedildi (${res.reason})`);
      licenseManager.evaluate(ctx);
      ctx.emitChange();
    }
    return res;
  }

  /** Çıkış: sunucuda revoke (best-effort) + yerel oturum & jeton HER DURUMDA silinir. */
  async function signOut() {
    await deviceLease.releaseDeviceLease(ctx).catch(() => {});
    const res = await auth.signOut().catch((e) => {
      log(`seatGate signOut error: ${e.message}`);
      return { ok: true, revoked: false };
    });
    await licenseStore.clear().catch(() => {});
    ctx.signedIn = false;
    ctx.email = null;
    ctx.userId = null;
    ctx.licenseToken = null;
    ctx.lastServerTime = null;
    ctx.revocation = null;
    ctx.deviceInfo = null;
    licenseManager.evaluate(ctx);
    ctx.emitChange();
    log('seatGate: çıkış yapıldı (oturum + lisans jetonu silindi)');
    return res;
  }

  return {
    init,
    evaluate: () => licenseManager.evaluate(ctx),
    state: () => licenseManager.state(ctx),
    listDevices: () => deviceLease.listDevices(ctx),
    revokeDevice: (deviceId) => deviceLease.revokeDevice(ctx, deviceId),
    releaseDeviceLease: (releaseOpts) => deviceLease.releaseDeviceLease(ctx, releaseOpts),
    releaseOtherDevices: () => deviceLease.releaseOtherDevices(ctx),
    heartbeat: () => deviceLease.heartbeat(ctx),
    stopHeartbeat: () => deviceLease.stopHeartbeat(ctx),
    signIn,
    signInWithEmail,
    handleUrl,
    isBillingReturnUrl,
    handleBillingReturn,
    signOut,
    refreshLicense: () => licenseManager.refreshLicense(ctx),
    accessToken: () => licenseManager.accessToken(ctx),
    requireSeat: (action) => licenseManager.requireSeatFor(ctx, action),
    _seedLicense: (token, serverTime, stamp) => licenseManager.seedLicense(ctx, token, serverTime, stamp),
  };
}

module.exports = {
  createSeatGate,
};
