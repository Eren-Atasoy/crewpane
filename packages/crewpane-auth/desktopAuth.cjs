// ADP-382 (wheeljack) — masaüstü giriş akışı: PKCE + state (ADR-027 §3 / G2)
//
// Sözleşme (ADR-027 §3):
//   * Giriş SİSTEM TARAYICISINDA olur (gömülü webview YASAK — RFC 8252;
//     bu paket tarayıcı penceresi AÇMAZ, yalnız enjekte edilen openExternal'ı çağırır).
//   * PKCE (S256) + state ZORUNLU: state redirect_uri'nin query'sinde taşınır —
//     GoTrue redirect_to'daki mevcut query paramlarını KORUR (bu stack'te kanıtlandı).
//   * Dönüş: <scheme>://auth/callback?code=…&state=… → handleCallback(url)
//     state'i doğrular (timing-safe) + code'u verifier ile oturuma çevirir
//     (supabase-js exchangeCodeForSession'ın REST eşleniği: /token?grant_type=pkce).
//   * Token saklama enjekte edilen tokenStore'dadır — Electron'da
//     safeStorageStore.cjs (Keychain destekli), DÜZ DOSYAYA ASLA.
//
// Bağımlılık YOK — yalnız node:crypto + global fetch. Saat, fetch, tarayıcı-açma
// ve depo enjekte edilebilir (test için). license.cjs ile aynı stil: hatalar
// { ok:false, reason } döner (yalnız konfig hataları throw).

'use strict';

const crypto = require('node:crypto');

const PENDING_TTL_SECONDS = 15 * 60;      // signIn → callback arası azami süre
const DEFAULT_MIN_VALIDITY_SECONDS = 60;  // getSession: bundan az ömür kaldıysa tazele

// INC-20260917-02 — AĞ ÇAĞRISI ÜST SINIRI (tek yer).
// Zaman aşımı OLMAYAN bir fetch, ağ sessizce asıldığında (paket düşüyor, TCP açık
// ama cevap gelmiyor) SONSUZA kadar bekler: refresh() askıda kalır →
// seatGate.accessToken() → `appdb:token` IPC → renderer açılış kapısı kilitlenir.
// Zaman aşımı bir AĞ HATASIDIR: oturum SİLİNMEZ (offline ≠ çıkış, ADR-027 §4).
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/**
 * INC-20260917-04 — SUNUCU ARIZASI mı, SUNUCU REDDİ mi?
 *
 * Reddetme (4xx) kullanıcı hakkında bir HÜKÜMDÜR: refresh_token gerçekten geçersiz,
 * oturum bitmiştir. Arıza (5xx) ya da "sonra tekrar dene" (408 zaman aşımı, 429
 * kısıtlama) kullanıcı hakkında HİÇBİR ŞEY söylemez — sadece sunucunun o anki hâlidir.
 * İkisini aynı kefeye koymak, bir veritabanı kesintisini TOPLU ÇIKIŞA çevirir
 * (2026-09-17'de tam olarak bu oldu). Bu yüzden karar tek yerde ve adıyla durur.
 */
function isServerUnavailable(status) {
  return status >= 500 || status === 408 || status === 429;
}

/** base64url (padding'siz) */
function b64u(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** RFC 7636 PKCE çifti: verifier (64 kar, [43..128] bandında) + S256 challenge. */
function createPkcePair() {
  const verifier = b64u(crypto.randomBytes(48));
  const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** CSRF state — tahmin edilemez, tek kullanımlık. */
function createState() {
  return b64u(crypto.randomBytes(24));
}

/** Uzunluk farkında timing-safe string karşılaştırma. */
function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Test/geçici kullanım için bellek-içi depo (kalıcılık YOK). */
function createInMemoryTokenStore() {
  let doc = null;
  return {
    async load() { return doc; },
    async save(next) { doc = next; },
    async clear() { doc = null; },
  };
}

/** GoTrue token cevabını sabit şekle indir. */
function normalizeSession(body, nowS) {
  const expiresAt = Number.isFinite(body.expires_at)
    ? body.expires_at
    : nowS + (Number.isFinite(body.expires_in) ? body.expires_in : 3600);
  const user = body.user && typeof body.user === 'object'
    ? { id: body.user.id, email: body.user.email }
    : null;
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    token_type: body.token_type || 'bearer',
    expires_at: expiresAt,
    user,
  };
}

/**
 * Masaüstü auth istemcisi.
 *
 * @param {object} config
 * @param {string} config.supabaseUrl - ör. http://127.0.0.1:56321 (crewpane-id)
 * @param {string} config.apiKey - anon/publishable key (public; secret DEĞİL)
 * @param {string} config.redirectUri - app'in custom-scheme callback'i,
 *   ör. 'agentshot://auth/callback'. RFC 8252 gereği custom scheme ya da
 *   http loopback olmalı; başka https origin REDDEDİLİR.
 * @param {{load:Function, save:Function, clear:Function}} config.tokenStore -
 *   Electron'da createSafeStorageTokenStore(...) (Keychain destekli).
 * @param {(url:string)=>any} [config.openExternal] - sistem tarayıcısını açan fn
 *   (Electron: shell.openExternal). signIn/signInWithProvider için zorunlu.
 * @param {string} [config.loginUrl] - hosted login sayfası
 *   (accounts.crewpane.dev; crewpane-id/web). Verilirse signIn() bunu açar.
 * @param {string} [config.appId] - hosted sayfadaki 'app' etiketi (ör. 'AgentShot').
 *   ADP-714: aynı zamanda GoTrue çağrılarının user-agent'ı olur → `auth.sessions`
 *   "bu oturum hangi üründen geldi" sorusunu cevaplar.
 * @param {string} [config.appVersion] - ürün sürümü (ör. '0.2.20'); UA'ya eklenir.
 * @param {Function} [config.fetch] - test enjeksiyonu (default: global fetch)
 * @param {number} [config.fetchTimeoutMs] - ağ isteği üst sınırı (default 10000).
 *   Aşılırsa `TimeoutError` fırlar; bu bir AĞ hatasıdır, oturum SİLİNMEZ.
 * @param {()=>number} [config.nowSeconds] - test enjeksiyonu (epoch saniye)
 */
function createDesktopAuth(config) {
  const cfg = config || {};
  if (typeof cfg.supabaseUrl !== 'string' || !cfg.supabaseUrl) {
    throw new Error('createDesktopAuth: supabaseUrl zorunlu');
  }
  if (typeof cfg.apiKey !== 'string' || !cfg.apiKey) {
    throw new Error('createDesktopAuth: apiKey zorunlu');
  }
  if (!cfg.tokenStore || typeof cfg.tokenStore.load !== 'function'
    || typeof cfg.tokenStore.save !== 'function' || typeof cfg.tokenStore.clear !== 'function') {
    throw new Error('createDesktopAuth: tokenStore {load,save,clear} zorunlu');
  }

  let redirect;
  try {
    redirect = new URL(cfg.redirectUri);
  } catch {
    throw new Error('createDesktopAuth: redirectUri geçerli bir URL değil');
  }
  const isLoopback = redirect.protocol === 'http:'
    && (redirect.hostname === 'localhost' || redirect.hostname === '127.0.0.1');
  if (!isLoopback && (redirect.protocol === 'http:' || redirect.protocol === 'https:')) {
    // RFC 8252: masaüstü public client dönüşü custom scheme ya da loopback'tir;
    // uzak https origin'e code göndermek phishing yüzeyi açar.
    throw new Error('createDesktopAuth: redirectUri custom scheme ya da http loopback olmalı');
  }
  if (redirect.search) {
    throw new Error('createDesktopAuth: redirectUri query içeremez (state paketçe eklenir)');
  }

  const base = cfg.supabaseUrl.replace(/\/+$/, '');
  const store = cfg.tokenStore;
  const rawFetch = cfg.fetch || globalThis.fetch;
  const fetchTimeoutMs = (Number.isFinite(cfg.fetchTimeoutMs) && cfg.fetchTimeoutMs > 0)
    ? cfg.fetchTimeoutMs
    : DEFAULT_FETCH_TIMEOUT_MS;

  /**
   * Bu paketin TEK ağ çıkışı — her GoTrue çağrısı buradan geçer, zaman aşımlı.
   *
   * İki katman bilerek: `AbortSignal.timeout` gerçek fetch'in soketini KAPATIR
   * (kaynak sızmaz), yarıştaki zamanlayıcı ise sinyali umursamayan bir fetch
   * (test enjeksiyonu, eski polyfill) asılırsa çağıranı yine de kurtarır.
   * Reddin adı `TimeoutError`dır → çağıranlar bunu ağ hatası gibi ele alır.
   */
  function doFetch(url, init) {
    const opts = { ...(init || {}) };
    if (!opts.signal && typeof AbortSignal !== 'undefined'
      && typeof AbortSignal.timeout === 'function') {
      opts.signal = AbortSignal.timeout(fetchTimeoutMs);
    }
    const p = Promise.resolve().then(() => rawFetch(url, opts));
    p.catch(() => {}); // yarışı zamanlayıcı kazanırsa iptal reddi "unhandled" olmasın
    let timer = null;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error(`auth: ağ isteği ${fetchTimeoutMs}ms içinde yanıtlamadı`);
        e.name = 'TimeoutError';
        reject(e);
      }, fetchTimeoutMs);
      // unref YOK: zamanlayıcı unref'lenirse asılı bir istekte olay döngüsü
      // boşalıp süreç zaman aşımı DOLMADAN çıkabilir — kurtarma hiç çalışmaz.
      // finally'deki clearTimeout zaten en fazla fetchTimeoutMs tutar.
    });
    return Promise.race([p, guard]).finally(() => { if (timer) clearTimeout(timer); });
  }
  const now = typeof cfg.nowSeconds === 'function'
    ? cfg.nowSeconds
    : () => Math.floor(Date.now() / 1000);

  // ADP-714 — LANSMAN GÖRÜNÜRLÜĞÜ: GoTrue her oturuma isteğin user-agent'ını yazar
  // (`auth.sessions.user_agent`). Varsayılan olarak burada 'node'/'undici' görünür →
  // "bu kullanıcı uygulamayı gerçekten AÇTI mı, hangisini, hangi sürümü?" sorusu
  // sunucuda CEVAPLANAMIYORDU. appId (+ appVersion) verildiğinde jeton çağrılarına
  // `CrewPane/0.2.20` gibi bir UA koyuyoruz: yeni tablo, yeni uç, yeni KİŞİSEL VERİ
  // yok — zaten tutulan bir kolon anlamlı hâle geliyor (scripts/launch-status.mjs).
  const clientUa = (typeof cfg.appId === 'string' && cfg.appId)
    ? cfg.appId + (typeof cfg.appVersion === 'string' && cfg.appVersion ? `/${cfg.appVersion}` : '')
    : null;

  /** GoTrue çağrılarının ortak başlıkları (+ varsa ürün UA'sı). */
  function authHeaders(extra) {
    const h = { apikey: cfg.apiKey, 'content-type': 'application/json', ...(extra || {}) };
    if (clientUa) h['user-agent'] = clientUa;
    return h;
  }

  function redirectWithState(state) {
    const u = new URL(redirect.toString());
    u.searchParams.set('state', state);
    return u.toString();
  }

  async function loadDoc() {
    const doc = await store.load();
    return doc && typeof doc === 'object' ? doc : {};
  }

  async function savePending(pending) {
    const doc = await loadDoc();
    await store.save({ ...doc, pending });
  }

  function requireOpenExternal() {
    if (typeof cfg.openExternal !== 'function') {
      throw new Error('signIn: openExternal enjekte edilmedi (Electron: shell.openExternal)');
    }
  }

  /**
   * Girişi SİSTEM TARAYICISINDA başlat.
   * provider verilirse GoTrue authorize'a direkt gider (google/github/apple);
   * verilmezse hosted login sayfası (loginUrl) açılır.
   * @param {{provider?: string}} [opts]
   * @returns {Promise<{url:string, state:string}>}
   */
  async function signIn(opts) {
    requireOpenExternal();
    const provider = opts && opts.provider;
    const { verifier, challenge } = createPkcePair();
    const state = createState();
    const returnTo = redirectWithState(state);

    let url;
    if (provider) {
      const u = new URL(base + '/auth/v1/authorize');
      u.searchParams.set('provider', provider);
      u.searchParams.set('redirect_to', returnTo);
      u.searchParams.set('code_challenge', challenge);
      u.searchParams.set('code_challenge_method', 's256');
      url = u.toString();
    } else if (typeof cfg.loginUrl === 'string' && cfg.loginUrl) {
      // crewpane-id/web login sayfası sözleşmesi (ADP-381): redirect_uri + code_challenge + app
      const u = new URL(cfg.loginUrl);
      u.searchParams.set('redirect_uri', returnTo);
      u.searchParams.set('code_challenge', challenge);
      if (cfg.appId) u.searchParams.set('app', cfg.appId);
      url = u.toString();
    } else {
      throw new Error('signIn: provider verilmedi ve loginUrl konfigüre edilmedi');
    }

    // Önce persist, sonra tarayıcı — callback pending'den önce dönemesin.
    await savePending({ state, verifier, createdAt: now() });
    await cfg.openExternal(url);
    return { url, state };
  }

  /**
   * E-posta magic-link girişi (PKCE'li): GoTrue /otp. Link kullanıcının
   * posta kutusuna düşer; tıklanınca verify → app callback'ine ?code=&state= döner.
   * @param {string} email
   * @returns {Promise<{ok:true, state:string}|{ok:false, reason:string, status?:number, detail?:string}>}
   */
  async function signInWithEmail(email) {
    if (typeof email !== 'string' || !email.includes('@')) {
      return { ok: false, reason: 'bad_email' };
    }
    const { verifier, challenge } = createPkcePair();
    const state = createState();
    const returnTo = redirectWithState(state);

    const u = new URL(base + '/auth/v1/otp');
    u.searchParams.set('redirect_to', returnTo);
    let res;
    try {
      res = await doFetch(u.toString(), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          email,
          create_user: true,
          code_challenge: challenge,
          code_challenge_method: 's256',
        }),
      });
    } catch (e) {
      return { ok: false, reason: 'network_error', detail: String((e && e.message) || e) };
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, reason: 'otp_failed', status: res.status, detail: detail.slice(0, 200) };
    }
    await savePending({ state, verifier, createdAt: now() });
    return { ok: true, state };
  }

  /**
   * Custom-scheme callback'ini işle: state doğrula (timing-safe) +
   * code'u verifier ile oturuma çevir + oturumu depoya yaz.
   * @param {string} url - ör. 'agentshot://auth/callback?code=…&state=…'
   */
  async function handleCallback(url) {
    if (typeof url !== 'string') return { ok: false, reason: 'malformed' };
    let cb;
    try {
      cb = new URL(url);
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    if (cb.protocol !== redirect.protocol || cb.host !== redirect.host
      || cb.pathname !== redirect.pathname) {
      return { ok: false, reason: 'wrong_redirect' };
    }
    const err = cb.searchParams.get('error') || cb.searchParams.get('error_code');
    if (err) {
      return {
        ok: false, reason: 'provider_error',
        detail: (cb.searchParams.get('error_description') || err).slice(0, 300),
      };
    }
    const state = cb.searchParams.get('state');
    if (!state) return { ok: false, reason: 'missing_state' };

    const doc = await loadDoc();
    const pending = doc.pending;
    if (!pending || typeof pending.verifier !== 'string' || typeof pending.state !== 'string') {
      return { ok: false, reason: 'no_pending' };
    }
    if (Number.isFinite(pending.createdAt) && now() - pending.createdAt > PENDING_TTL_SECONDS) {
      await store.save({ ...doc, pending: null });
      return { ok: false, reason: 'pending_expired' };
    }
    if (!timingSafeEqualStr(state, pending.state)) {
      // pending KORUNUR: sahte/yanlış callback gerçek dönüşü iptal ettirmemeli.
      return { ok: false, reason: 'state_mismatch' };
    }
    const code = cb.searchParams.get('code');
    if (!code) return { ok: false, reason: 'missing_code' };

    let res;
    try {
      res = await doFetch(base + '/auth/v1/token?grant_type=pkce', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ auth_code: code, code_verifier: pending.verifier }),
      });
    } catch (e) {
      // Ağ hatası: pending KORUNUR (code tüketilmedi, tekrar denenebilir).
      return { ok: false, reason: 'network_error', detail: String((e && e.message) || e) };
    }
    let body;
    try {
      body = await res.json();
    } catch (e) {
      // Başlıklar geldi ama gövde okunamadı. Sunucu ZATEN reddettiyse (4xx) gövde
      // önemsiz; 2xx'te ise bu bir AĞ kopması/zaman aşımıdır → pending KORUNUR.
      if (res.ok) return { ok: false, reason: 'network_error', detail: String((e && e.message) || e) };
      body = {};
    }
    if (!res.ok || !body.access_token || !body.refresh_token) {
      await store.save({ ...doc, pending: null }); // code tek kullanımlık — replay kapanır
      return {
        ok: false, reason: 'exchange_failed', status: res.status,
        detail: String(body.error_description || body.msg || '').slice(0, 300),
      };
    }
    const session = normalizeSession(body, now());
    await store.save({ pending: null, session });
    return { ok: true, session };
  }

  /**
   * Depodaki oturumu döndür; ömrü minValiditySeconds'tan az kaldıysa tazelemeyi dener.
   * Oturum yoksa null. OFFLINE'da (ağ hatası) eldeki oturum korunur ve hata fırlar —
   * caller lisans jetonunun grace'ine güvenir (ADR-027 §4).
   */
  async function getSession(opts) {
    const minValidity = (opts && Number.isFinite(opts.minValiditySeconds))
      ? opts.minValiditySeconds : DEFAULT_MIN_VALIDITY_SECONDS;
    const doc = await loadDoc();
    const session = doc.session;
    if (!session || typeof session.access_token !== 'string') return null;
    if (Number.isFinite(session.expires_at) && session.expires_at - now() > minValidity) {
      return session;
    }
    return refresh();
  }

  /**
   * refresh_token ile oturumu tazele. Sunucu REDDEDERSE (4xx) oturum SİLİNİR ve
   * null döner; ağ hatasında oturum KORUNUR ve hata fırlar (offline ≠ çıkış).
   *
   * INC-20260917-04 — TOPLU LOGOUT OLAYI. Bu ayrım eskiden `!res.ok` ile tek kefede
   * tutuluyordu: crewpane-id'nin veritabanı düşünce (57P03) GoTrue 5xx döndürdü ve
   * bu dal HER istemcinin oturumunu SİLDİ → kullanıcılar toplu çıkış yedi, sonra da
   * veritabanı kapalı olduğu için geri giremedi. Jeton ~1 saatte bir tazelendiğinden
   * kesinti penceresindeki neredeyse HERKES etkilendi.
   *
   * Kural: sunucu ARIZASI (5xx/408/429) bir REDDETME DEĞİLDİR — ağ hatasıyla aynı
   * kefededir: oturum korunur, hata fırlar, çağıran (seatGate) depodaki jetona düşer.
   * Yalnız gerçek reddi (4xx: süresi geçmiş/iptal edilmiş refresh_token) oturumu siler.
   */
  async function refresh() {
    const doc = await loadDoc();
    const session = doc.session;
    if (!session || typeof session.refresh_token !== 'string') return null;
    const res = await doFetch(base + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
    let body;
    try {
      body = await res.json();
    } catch (e) {
      // 2xx'te gövde okunamıyorsa bağlantı koptu/abort edildi — SUNUCU reddetmedi.
      // Burada oturumu silmek offline kullanıcıyı çıkış yaptırırdı (ADR-027 §4).
      if (res.ok) throw e;
      body = {};
    }
    if (isServerUnavailable(res.status)) {
      // Sunucu ARIZASI — oturuma DOKUNMA (INC-20260917-04). Ağ hatasıyla aynı kefe.
      const e = new Error(`auth: sunucu şu an yanıt veremiyor (${res.status})`);
      e.name = 'ServerUnavailableError';
      throw e;
    }
    if (!res.ok || !body.access_token || !body.refresh_token) {
      await store.save({ ...doc, session: null });
      return null;
    }
    const next = normalizeSession(body, now());
    await store.save({ ...doc, session: next });
    return next;
  }

  /**
   * Çıkış: sunucuda refresh token'ı iptal etmeyi DENER (best-effort; offline'da
   * atlanır), yereldeki oturumu HER DURUMDA siler. ADR-027 §3: logout =
   * local sil + token revoke.
   */
  async function signOut() {
    const doc = await loadDoc();
    const session = doc.session;
    let revoked = false;
    if (session && typeof session.access_token === 'string') {
      try {
        const res = await doFetch(base + '/auth/v1/logout?scope=global', {
          method: 'POST',
          headers: authHeaders({ Authorization: 'Bearer ' + session.access_token }),
        });
        revoked = res.ok;
      } catch {
        // offline: yerel silme yeter, revoke sonraki girişte zaten anlamsız
      }
    }
    await store.clear();
    return { ok: true, revoked };
  }

  return { signIn, signInWithEmail, handleCallback, getSession, refresh, signOut };
}

module.exports = {
  PENDING_TTL_SECONDS,
  DEFAULT_FETCH_TIMEOUT_MS,
  isServerUnavailable,
  createPkcePair,
  createState,
  timingSafeEqualStr,
  createInMemoryTokenStore,
  createDesktopAuth,
};
