// ADP-387 (ratchet) — app'ten "Pro'ya geç" akışı (ADR-027 §5-7 / G6)
//
// Sözleşme:
//   * openUpgrade(): oturumun access token'ıyla billing-checkout Edge Function'ını
//     çağırır ve dönen Stripe Checkout URL'ini SİSTEM TARAYICISINDA açar
//     (gömülü webview YASAK — RFC 8252 ile aynı duruş; bu modül pencere AÇMAZ,
//     yalnız enjekte edilen openExternal'ı çağırır). Web login gerekmez —
//     app zaten oturumlu, checkout session'ı kendi token'ıyla yaratılır.
//   * openBillingPortal(): "Aboneliği yönet" — Stripe Billing Portal.
//   * isBillingReturnUrl()/handleBillingReturn(): ödeme sonrası success sayfası
//     <scheme>://billing/updated deep-link'iyle app'e döner → JETON TAZELEME
//     ÇENGELİ: fetchLicenseToken ile taze lisans jetonu çekilir (Pro anında açılır).
//   * fetchLicenseToken(): GET /functions/v1/license-token (ADP-383 ucu).
//
// desktopAuth.cjs ile aynı stil: sıfır bağımlılık, hatalar { ok:false, reason },
// yalnız konfig hataları throw; fetch/openExternal/getAccessToken enjekte edilir.

'use strict';

/**
 * @param {object} config
 * @param {string} config.supabaseUrl - ör. http://127.0.0.1:56321 (crewpane-id)
 * @param {string} config.apiKey - anon/publishable key (public; secret DEĞİL)
 * @param {()=>Promise<string|null>} config.getAccessToken - oturumun access
 *   token'ını veren fn (tipik: async () => (await auth.getSession())?.access_token)
 * @param {(url:string)=>any} [config.openExternal] - sistem tarayıcısı
 *   (Electron: shell.openExternal). openUpgrade/openBillingPortal için zorunlu.
 * @param {string} [config.product] - default ürün (ör. 'agentshot.pro')
 * @param {string} [config.appScheme] - app'in custom scheme'i (ör. 'agentshot');
 *   verilirse checkout success sayfası "Return to the app" deep-link'i gösterir
 *   ve handleBillingReturn bu scheme'in billing dönüşlerini tanır.
 * @param {Function} [config.fetch] - test enjeksiyonu (default: global fetch)
 */
function createBillingClient(config) {
  const cfg = config || {};
  if (typeof cfg.supabaseUrl !== 'string' || !cfg.supabaseUrl) {
    throw new Error('createBillingClient: supabaseUrl zorunlu');
  }
  if (typeof cfg.apiKey !== 'string' || !cfg.apiKey) {
    throw new Error('createBillingClient: apiKey zorunlu');
  }
  if (typeof cfg.getAccessToken !== 'function') {
    throw new Error('createBillingClient: getAccessToken zorunlu');
  }
  const base = cfg.supabaseUrl.replace(/\/+$/, '');
  const doFetch = cfg.fetch || globalThis.fetch;

  function requireOpenExternal(fn) {
    if (typeof cfg.openExternal !== 'function') {
      throw new Error(`${fn}: openExternal enjekte edilmedi (Electron: shell.openExternal)`);
    }
  }

  async function callFn(name, payload) {
    const token = await cfg.getAccessToken();
    if (typeof token !== 'string' || !token) {
      return { ok: false, reason: 'not_signed_in' };
    }
    let res;
    try {
      res = await doFetch(`${base}/functions/v1/${name}`, {
        method: 'POST',
        headers: {
          apikey: cfg.apiKey,
          Authorization: 'Bearer ' + token,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload || {}),
      });
    } catch (e) {
      return { ok: false, reason: 'network_error', detail: String((e && e.message) || e) };
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || typeof body.url !== 'string') {
      return {
        ok: false,
        reason: res.status === 404 ? 'no_billing_customer'
          : res.status === 401 ? 'not_signed_in'
            : 'billing_failed',
        status: res.status,
        detail: String(body.error || '').slice(0, 200),
      };
    }
    return { ok: true, url: body.url };
  }

  /**
   * "Pro'ya geç": checkout session yarat + sistem tarayıcısında aç.
   * @param {{plan?:'monthly'|'yearly'|'ltd', product?:string}} [opts]
   * @returns {Promise<{ok:true, url:string}|{ok:false, reason:string, status?:number, detail?:string}>}
   */
  async function openUpgrade(opts) {
    requireOpenExternal('openUpgrade');
    const r = await callFn('billing-checkout', {
      product: (opts && opts.product) || cfg.product || undefined,
      plan: (opts && opts.plan) || 'monthly',
      app: cfg.appScheme || undefined,
    });
    if (!r.ok) return r;
    await cfg.openExternal(r.url);
    return r;
  }

  /**
   * "Aboneliği yönet": Stripe Billing Portal'ı sistem tarayıcısında aç.
   * Hiç satın alma yoksa { ok:false, reason:'no_billing_customer' }.
   */
  async function openBillingPortal() {
    requireOpenExternal('openBillingPortal');
    const r = await callFn('billing-portal', {});
    if (!r.ok) return r;
    await cfg.openExternal(r.url);
    return r;
  }

  /** Bu URL success sayfasının app'e dönüş deep-link'i mi? (<scheme>://billing/…) */
  function isBillingReturnUrl(url) {
    if (typeof url !== 'string' || !cfg.appScheme) return false;
    let u;
    try { u = new URL(url); } catch { return false; }
    return u.protocol === cfg.appScheme + ':' && u.host === 'billing';
  }

  /**
   * JETON TAZELEME ÇENGELİ — ödeme dönüşünde çağrılır: taze lisans jetonu çeker.
   * (Webhook → entitlement yazımı birkaç saniye sürebilir; retry içeride.)
   * @param {string} url - deep-link (<scheme>://billing/updated?plan=…)
   * @param {{attempts?:number, delayMs?:number}} [opts]
   */
  async function handleBillingReturn(url, opts) {
    if (!isBillingReturnUrl(url)) return { ok: false, reason: 'not_billing_url' };
    const attempts = (opts && opts.attempts) || 1;
    const delayMs = (opts && opts.delayMs) || 2000;
    let last = { ok: false, reason: 'no_attempt' };
    for (let i = 0; i < Math.max(1, attempts); i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, delayMs));
      last = await fetchLicenseToken({
        supabaseUrl: base, apiKey: cfg.apiKey,
        getAccessToken: cfg.getAccessToken, fetch: doFetch,
      });
      if (last.ok) return last;
    }
    return last;
  }

  return { openUpgrade, openBillingPortal, isBillingReturnUrl, handleBillingReturn };
}

/**
 * Taze lisans jetonu çek (GET /functions/v1/license-token — ADP-383 ucu).
 * Dönen { token, server_time } doğrulama için verifyWithEmbeddedKeys'e ve
 * saat-oynatma koruması için noteServerTime'a verilir (license.cjs).
 *
 * SEC-01 — `device` verilirse cihaz kimliği isteğe eklenir; sunucu cihazı
 * deftere yazar ve paketin cihaz tavanını AŞAN istekleri jetonu imzalamadan
 * reddeder. Kimlik GÖNDERİLMEZSE sunucu eski davranışı sürdürür (kilit yok) —
 * eski kurulumların bir gecede kilitlenmemesi için bilinçli bir yol.
 *
 * SEC-02 — `action` aynı ucun DÖRT işini seçer (yeni uç AÇILMADI, çünkü kararın
 * ve kiranın tek sahibi bu fonksiyondur; ikinci bir uç ikinci bir gerçek olurdu):
 *   'token'          (varsayılan) → kapıdan geç + kirayı tazele + jetonu al
 *   'heartbeat'      → YALNIZ kirayı tazele (imza yok; uzun oturum bunu kullanır)
 *   'release'        → BU cihazın kirasını bırak (uygulama kapanışı)
 *   'release_others' → DİĞER cihazların kirasını bırak (kilit açma düğmesi)
 * `release*` cihazı hesaptan ÇIKARMAZ (o ayrı eylem: devices.cjs `revokeDevice`).
 *
 * SEC-W2-A2 — `integrity` verilirse paket bütünlük RAPORU isteğe biner. Rapor
 * bir KARAR değildir: istemcinin ÖLÇTÜĞÜ kök özet (`root`) ile build makinesinin
 * İMZASI (`jws`) taşınır, hükmü sunucu verir. Rapor yoksa istek bugünküyle
 * BİT-BİT aynıdır — eski sürümler ve denetimin koşmadığı yollar etkilenmez.
 *
 * @param {{supabaseUrl:string, apiKey:string,
 *          getAccessToken:()=>Promise<string|null>, fetch?:Function,
 *          action?:'token'|'heartbeat'|'release'|'release_others',
 *          integrity?:{jws:string|null, root:string|null}|null,
 *          device?:{id:string, name?:string, platform?:string, app?:string}}} opts
 */
async function fetchLicenseToken(opts) {
  const o = opts || {};
  if (typeof o.supabaseUrl !== 'string' || !o.supabaseUrl
    || typeof o.apiKey !== 'string' || !o.apiKey
    || typeof o.getAccessToken !== 'function') {
    throw new Error('fetchLicenseToken: supabaseUrl, apiKey, getAccessToken zorunlu');
  }
  const doFetch = o.fetch || globalThis.fetch;
  const token = await o.getAccessToken();
  if (typeof token !== 'string' || !token) {
    return { ok: false, reason: 'not_signed_in' };
  }
  const action = o.action || 'token';
  const qs = new URLSearchParams();
  if (o.device && o.device.id) {
    qs.set('device_id', String(o.device.id));
    if (o.device.name) qs.set('device_name', String(o.device.name));
    if (o.device.platform) qs.set('platform', String(o.device.platform));
    if (o.device.app) qs.set('app', String(o.device.app));
  }
  if (action !== 'token') qs.set('device_action', action);
  const url = `${o.supabaseUrl.replace(/\/+$/, '')}/functions/v1/license-token`
    + (qs.toString() ? `?${qs}` : '');
  const headers = { apikey: o.apiKey, Authorization: 'Bearer ' + token };
  // SEC-W2-A2 — rapor YALNIZ iki alanı da doluysa binilir. Yarım bir rapor
  // sunucuda "ölçemedim" kefesine düşerdi; hiç göndermemekle aynı sonuç, ama
  // günlüğü gereksiz kirletirdi.
  if (o.integrity && o.integrity.jws && o.integrity.root) {
    headers['x-integrity-jws'] = String(o.integrity.jws);
    headers['x-integrity-root'] = String(o.integrity.root);
  }
  let res;
  try {
    res = await doFetch(url, { headers });
  } catch (e) {
    return { ok: false, reason: 'network_error', detail: String((e && e.message) || e) };
  }
  const body = await res.json().catch(() => ({}));
  // SEC-01/02 — CİHAZ REDDİ. Bunu genel "license_fetch_failed" içine gömmek,
  // kullanıcıya "lisans alınamadı" gibi ÇARESİZ bir hata gösterirdi; oysa bu
  // reddin İKİ somut çözümü var (cihazı çıkar/bırak · paketi yükselt). Bu yüzden
  // ret YAPISAL olarak taşınır — çağıran cümleyi planLimits ile kurar.
  //
  // İki ret sınıfı AYRI taşınır çünkü çözümleri farklıdır (kayıt → çıkar,
  // eşzamanlı → bırak). Sunucunun listesini tek bir sınıfa indirmek, ekranda
  // yanlış düğmeyi göstermek demekti.
  // SEC-W2-A2 — BÜTÜNLÜK REDDİ. Cihaz reddi gibi YAPISAL taşınır: bu reddin de
  // tek somut çözümü var (temiz kopyayı yeniden indir) ve onu "lisans alınamadı"
  // içine gömmek kullanıcıya ÇARESİZ bir hata göstermek olurdu.
  if (res.status === 403 && body && body.error === 'integrity_mismatch') {
    return {
      ok: false,
      reason: 'integrity_mismatch',
      status: 403,
      buildId: typeof body.build_id === 'string' ? body.build_id : null,
      message: typeof body.message === 'string' ? body.message : '',
    };
  }

  const DEVICE_DENIALS = ['device_limit_reached', 'device_concurrent_limit_reached'];
  if (res.status === 403 && body && DEVICE_DENIALS.includes(body.error)) {
    return {
      ok: false,
      reason: body.error,
      status: 403,
      limit: Number(body.limit) || null,
      active: Number(body.active) || 0,
      registeredLimit: Number(body.registered_limit) || null,
      registeredActive: Number(body.registered_active) || 0,
      concurrentLimit: Number(body.concurrent_limit) || null,
      concurrentActive: Number(body.concurrent_active) || 0,
      leaseMinutes: Number(body.lease_minutes) || null,
      tier: body.tier || null,
      devices: Array.isArray(body.devices) ? body.devices : [],
      actions: Array.isArray(body.actions) ? body.actions : [],
      message: typeof body.message === 'string' ? body.message : '',
    };
  }
  // Kira eylemleri jeton İSTEMEZ — `token` alanını arayan kontrol onları
  // "başarısız" sanardı. Yanıt şekli farklı olduğu için ayrı ele alınır.
  if (action === 'release' || action === 'release_others' || action === 'heartbeat') {
    if (!res.ok || body.ok !== true) {
      return {
        ok: false, reason: `device_${action}_failed`, status: res.status,
        detail: String(body.reason || body.error || '').slice(0, 200),
      };
    }
    return {
      ok: true,
      action,
      released: Number(body.released) || 0,
      serverTime: body.server_time,
      device: body.device && typeof body.device === 'object' ? body.device : null,
    };
  }
  if (!res.ok || typeof body.token !== 'string') {
    return {
      ok: false, reason: 'license_fetch_failed', status: res.status,
      detail: String(body.error || '').slice(0, 200),
    };
  }
  return {
    ok: true, token: body.token, serverTime: body.server_time,
    device: body.device && typeof body.device === 'object' ? body.device : null,
  };
}

/**
 * ADP-416 — kartsız süreli deneme talebi (POST /functions/v1/trial-claim).
 * Sunucu tekillik kapısı: kullanıcı-ürün başına ÖMÜR BOYU tek deneme
 * (entitlements unique(user_id, product)); tekrar çağrılması güvenlidir —
 * { ok:true, granted:false, reason:'already_exists' } döner, mevcut satıra dokunulmaz.
 * @param {{supabaseUrl:string, apiKey:string, product:string,
 *          getAccessToken:()=>Promise<string|null>, fetch?:Function}} opts
 */
async function claimTrial(opts) {
  const o = opts || {};
  if (typeof o.supabaseUrl !== 'string' || !o.supabaseUrl
    || typeof o.apiKey !== 'string' || !o.apiKey
    || typeof o.product !== 'string' || !o.product
    || typeof o.getAccessToken !== 'function') {
    throw new Error('claimTrial: supabaseUrl, apiKey, product, getAccessToken zorunlu');
  }
  const doFetch = o.fetch || globalThis.fetch;
  const token = await o.getAccessToken();
  if (typeof token !== 'string' || !token) {
    return { ok: false, reason: 'not_signed_in' };
  }
  let res;
  try {
    res = await doFetch(`${o.supabaseUrl.replace(/\/+$/, '')}/functions/v1/trial-claim`, {
      method: 'POST',
      headers: {
        apikey: o.apiKey,
        Authorization: 'Bearer ' + token,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ product: o.product }),
    });
  } catch (e) {
    return { ok: false, reason: 'network_error', detail: String((e && e.message) || e) };
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false, reason: 'trial_claim_failed', status: res.status,
      detail: String(body.error || '').slice(0, 200),
    };
  }
  return {
    ok: true,
    granted: body.granted === true,
    reason: body.reason,
    periodEnd: body.current_period_end || null,
  };
}

module.exports = { createBillingClient, fetchLicenseToken, claimTrial };
