// INT-OBS-01 — SENTRY + POSTHOG YÖNETİM API'Sİ (tek jetondan otomatik kurulum).
//
// ÜRÜN NİYETİ (Eren): "Entegrasyonda Sentry ve PostHog'u bağladıktan sonra geri
// kalan her işlemi senin OTOMATİK yapmanı istiyorum." Yani kullanıcı servis başına
// TEK kimlik yapıştırır; org bulma, proje açma, DSN/api_token çekme, kanal başına
// yerine yazma işini ÜRÜN yapar.
//
// ─── BU DOSYANIN SINIRI ──────────────────────────────────────────────────────
// Burası SAF PROTOKOL katmanıdır: HTTP + hata sınıflandırma. Vault'a yazmaz,
// ayar okumaz, Electron'a bağlanmaz (`httpJson` enjekte edilir) → `node --test`
// ile koşar. Kurulum akışının kendisi `telemetryProvision.cjs`tedir.
//
// ─── SIR HİJYENİ (Kural 3) ───────────────────────────────────────────────────
// Jeton YALNIZ `Authorization` başlığında taşınır. Hiçbir dönüş değeri, hiçbir
// hata mesajı, hiçbir log satırı jetonu İÇERMEZ — hata gövdeleri de sunucudan
// geldiği gibi DEĞİL, `classify()` ile bizim yazdığımız metne çevrilerek çıkar
// (bir sunucu isteği yankılayabilir; `provisionApi.test.cjs` bunu ölçer).
//
// ─── SESSİZ BAŞARISIZLIK YASAK (Kural 4 · ADP-918 dersi) ─────────────────────
// Hiçbir fonksiyon `throw` etmez ve hiçbir fonksiyon çıplak HTTP kodu döndürmez.
// Her başarısızlık `{ok:false, code, message}` olur; `message` KULLANICIYA NE
// YAPACAĞINI söyler ("token'da project:write izni yok — Sentry → Settings → Auth
// Tokens'tan ekle"), "403" demez.
//
// ─── ÖLÇÜLEN GERÇEKLER (F1 spike · 2026-08-10, jetonsuz gerçek çağrılar) ──────
//  • `GET https://sentry.io/api/0/organizations/` geçersiz jetonla **401**
//    `{"detail":"Invalid token"}` + `x-sentry-rate-limit-limit: 40` başlıkları.
//    → JETON DOĞRULAMA UCU BUDUR (aşağıdaki 404 tuzağının panzehiri).
//  • 🪤 ORG KAPSAMLI uçlar (`/organizations/<slug>/projects/`,
//    `/teams/…`, `/projects/…/keys/`) geçersiz jetonla **404**
//    `{"error":"apigateway","detail":"Not found"}` döndü — 401 DEĞİL. Yani
//    "404 = jeton bozuk" diye eşlemek YANLIŞ teşhis üretir. Sentry bu yolları
//    BÖLGE silosuna yönlendirir; doğru taban adres org kaydındaki
//    `links.regionUrl`dur. Bu yüzden org listesi önce çekilir, org-kapsamlı her
//    çağrı O ORG'UN regionUrl'i üzerinden gider (`orgBase`).
//  • PostHog her iki bölgede de **401** `{"type":"authentication_error",
//    "code":"authentication_failed","detail":"Personal API key … is invalid."}`
//    — yapılı gövde, doğrudan eşlenebilir. Oran-sınırı başlığı YOK.
//  • PostHog kişisel anahtarları BÖLGEYE bağlıdır (eu/us). Kullanıcıya bölge
//    SORMUYORUZ: iki bölge de denenir, 200 dönen bölge O anahtarın bölgesidir
//    (ikisi de 401 ise anahtar geçersizdir). Bkz. `detectPostHogRegion`.
//
// ─── DOKÜMANDAN ALINAN SÖZLEŞMELER (kanıt: docs.sentry.io / posthog.com) ─────
//  • Sentry proje oluşturma TAKIM ister: `POST /teams/{org}/{team}/projects/`
//    (scope: project:write veya project:admin). Yani "org + jeton" YETMEZ,
//    önce takım listelenir (`org:read`).
//  • Sentry DSN: `GET /projects/{org}/{proj}/keys/` → `keys[0].dsn.public`
//    (scope: project:read).
//  • PostHog: `GET|POST /api/organizations/{org}/projects/`
//    (scope: project:read / project:write); proje nesnesi `api_token` taşır.

'use strict';

const SENTRY_DEFAULT_HOST = 'https://sentry.io';
const POSTHOG_HOSTS = Object.freeze({
  eu: 'https://eu.posthog.com',
  us: 'https://us.posthog.com',
});
/** Ürünün açtığı projeler — ad/slug TEK yerde (idempotanlığın anahtarı da bu). */
const DEFAULT_PROJECT_SLUGS = Object.freeze({ prod: 'crewpane-prod', dev: 'crewpane-dev' });

// ── Hata sınıflandırma ───────────────────────────────────────────────────────

/**
 * Sağlayıcıya özgü "bu izni nereden eklersin" cümleleri. Kullanıcı hata
 * mesajından SONRA ne yapacağını bilmeli — ADP-918'in tek dersi bu.
 */
const SCOPE_HELP = Object.freeze({
  sentry: {
    where: 'Sentry → Settings → Auth Tokens',
    scopes: 'org:read, project:read, project:write',
    // Kimliğin SERVİSTEKİ adı. Sentry "auth token", PostHog "personal API key"
    // der; kullanıcının ekranda gördüğü kelimeyi kullanmazsak aradığı şeyi
    // bulamaz ("jetonun geçersiz" diyen bir mesaj, PostHog ekranında "token"
    // diye bir alan olmadığı için yönlendirmez).
    noun: 'jetonu',
  },
  posthog: {
    where: 'PostHog → Settings → Personal API keys',
    scopes: 'organization:read, project:read, project:write',
    noun: 'kişisel API anahtarı',
  },
});

/**
 * INT-OBS-02 — sunucunun `detail` cümlesini GÖSTERMEDEN önce süz: uzun kesintisiz
 * dizgiler sır (jeton yankısı) olabilir (Kural 3), ve sınırsız metin UI'yı bozar.
 * Süzülen cümle YALNIZ tanınmayan-403 dalında kullanılır — uydurmak yerine
 * sunucunun kendi açıklamasını göstermek için.
 */
function sanitizeDetail(detail) {
  const s = typeof detail === 'string' ? detail.trim() : '';
  if (!s) return '';
  return s.replace(/[A-Za-z0-9_-]{20,}/g, '…').slice(0, 300);
}

/** `x-sentry-rate-limit-reset` unix saniyesi → "N saniye" (yoksa null). */
function retryAfterSeconds(headers, nowMs) {
  const get = (k) => (headers && typeof headers.get === 'function' ? headers.get(k) : null);
  const retryAfter = Number(get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.ceil(retryAfter);
  const reset = Number(get('x-sentry-rate-limit-reset'));
  if (Number.isFinite(reset) && reset > 0) {
    const secs = Math.ceil(reset - (nowMs || Date.now()) / 1000);
    if (secs > 0) return secs;
  }
  return null;
}

/**
 * HTTP sonucunu KULLANICI CÜMLESİNE çevir. Çıplak kod ASLA dışarı çıkmaz;
 * `code` makine tarafı içindir, `message` insan tarafı.
 *
 * @param {'sentry'|'posthog'} provider
 * @param {{status:number, headers?:object, body?:any, networkError?:string}} res
 * @param {{action:string, scope?:string, subject?:string}} ctx  action = "ne yapmaya çalışıyorduk"
 * @returns {{ok:false, code:string, message:string, status:number|null, retryAfterSec?:number}}
 */
function classify(provider, res, ctx = {}, nowMs) {
  const help = SCOPE_HELP[provider] || SCOPE_HELP.sentry;
  const label = provider === 'sentry' ? 'Sentry' : 'PostHog';
  const action = ctx.action || 'istek';

  if (res.networkError) {
    return {
      ok: false,
      code: 'network',
      status: null,
      message: `${label} sunucusuna ulaşılamadı (${action}). İnternet bağlantını kontrol edip tekrar dene; `
        + 'kurumsal ağ/VPN kullanıyorsan bu adresi engelliyor olabilir.',
    };
  }

  const status = res.status;
  if (status === 401) {
    return {
      ok: false,
      code: 'invalid-token',
      status,
      message: `${label} ${help.noun} kabul edilmedi (süresi dolmuş ya da yanlış kopyalanmış olabilir). `
        + `${help.where} adresinden yenisini üret ve buraya yapıştır.`,
    };
  }
  if (status === 403) {
    // 🔑 INT-OBS-02 — 403 TEK ANLAMLI DEĞİLDİR; gövdedeki `detail` okunmadan
    // "scope eksik" demek YANLIŞ TEŞHİS üretir. Canlı vaka (2026-08-11): PostHog
    // ücretsiz planı proje tavanına çarptı ("maximum limit of allowed projects…"),
    // ürün bunu "project:write izni eksik" diye çevirip kullanıcıyı anahtar
    // yeniletmeye gönderdi — izin SEÇİLİYDİ. Yanlış mesaj sessizlikten beterdir.
    const rawDetail = res.body && typeof res.body.detail === 'string' ? res.body.detail : '';

    // 1) PLAN SINIRI — sunucunun ölçülmüş cümlesinden tanınır. İzin sorunu DEĞİL.
    if (/maximum limit of allowed/i.test(rawDetail) || /limit[^.]*for your current plan/i.test(rawDetail)) {
      return {
        ok: false,
        code: 'plan-limit',
        status,
        message: `${label} planın yeni proje açmaya izin vermiyor (${action}): mevcut planda proje sınırına `
          + `ulaşılmış. Bu bir izin sorunu DEĞİL — ${help.noun.replace(/ı$/, 'ını')} yenilemen gerekmez. `
          + `Mevcut proje kullanılabilir; daha fazla proje için ${label} planını yükselt.`,
      };
    }

    // 2) SCOPE — sunucu eksik kapsamın ADINI söylüyorsa ONU kullan (tahmin değil).
    const scopeHit = rawDetail.match(/['"‘“]?([a-z_]+:(?:read|write|admin))['"’”]?\s*scope/i)
      || rawDetail.match(/scope[s]?\s*['"‘“]?([a-z_]+:(?:read|write|admin))/i);
    // Gövde boş ya da izin/scope dilinde konuşuyorsa: bildiğimiz eksik-izin vakası.
    if (!rawDetail || scopeHit || /permission|scope/i.test(rawDetail)) {
      const needed = scopeHit
        ? `\`${scopeHit[1]}\``
        : (ctx.scope ? `\`${ctx.scope}\`` : `\`${help.scopes}\``);
      return {
        ok: false,
        code: 'missing-scope',
        status,
        message: `${label} ${help.noun} ${needed} iznini taşımıyor (${action}). ${help.where} bölümünden `
          + 'bu izni ekleyip yeniden üret — var olan bir kimliğin izinleri sonradan genişletilemez.',
      };
    }

    // 3) TANINMAYAN 403 — teşhis UYDURMA: sunucunun kendi açıklamasını (süzülmüş) göster.
    return {
      ok: false,
      code: 'forbidden',
      status,
      message: `${label} isteği reddetti (${action}). Sunucunun açıklaması: “${sanitizeDetail(rawDetail)}”. `
        + 'Sorun bu açıklamadan çözülmüyorsa Ayarlar → Sistem Durumu\'ndaki günlüğü destekle paylaş.',
    };
  }
  if (status === 404) {
    return {
      ok: false,
      code: 'not-found',
      status,
      // 🪤 F1 ölçümü: Sentry org-kapsamlı uçlarda GEÇERSİZ JETONA DA 404 döndürüyor.
      // Bu yüzden burada "jetonun bozuk" DEMİYORUZ — jeton zaten `verifyToken`de
      // doğrulandı; buraya gelindiyse sorun görünürlük/ad'dır.
      message: `${label} tarafında ${ctx.subject || 'kayıt'} bulunamadı (${action}). `
        + 'Jetonun bu organizasyona erişimi olmayabilir: jetonu doğru organizasyonda üret '
        + 'ya da o organizasyona davet edildiğinden emin ol.',
    };
  }
  if (status === 429) {
    const secs = retryAfterSeconds(res.headers, nowMs);
    return {
      ok: false,
      code: 'rate-limited',
      status,
      retryAfterSec: secs,
      message: `${label} istek sınırına takıldı (${action}). `
        + (secs ? `${secs} saniye sonra tekrar dene.` : 'Bir dakika bekleyip tekrar dene.'),
    };
  }
  if (status >= 500) {
    return {
      ok: false,
      code: 'server-error',
      status,
      message: `${label} servisi şu an hata veriyor (${action}). Bu bizim tarafımızda bir sorun değil; `
        + 'birkaç dakika sonra tekrar dene.',
    };
  }
  if (status === 400 || status === 409 || status === 422) {
    return {
      ok: false,
      code: 'rejected',
      status,
      // Sunucu gövdesini AYNEN yankılamıyoruz (jeton yankısı riski + anlaşılmaz metin);
      // yalnız hangi alanın reddedildiğini biliyorsak onu söyleriz.
      message: `${label} isteği reddetti (${action}). Aynı adda bir kayıt zaten olabilir ya da `
        + 'ad kurallara uymuyor olabilir; farklı bir ad dene.',
    };
  }
  return {
    ok: false,
    code: 'unexpected',
    status,
    message: `${label} beklenmedik bir yanıt verdi (${action}). Tekrar dene; sürerse `
      + 'Ayarlar → Sistem Durumu\'ndaki günlüğü destekle paylaş.',
  };
}

// ── Taşıyıcı ─────────────────────────────────────────────────────────────────

/**
 * Varsayılan JSON taşıyıcı. ASLA throw etmez: ağ hatası da bir SONUÇTUR
 * (`networkError`), çünkü çağıran her iki durumu da aynı `classify` ile
 * kullanıcı cümlesine çevirmeli.
 * @returns {Promise<{status:number, headers:Headers|null, body:any, networkError?:string}>}
 */
async function defaultHttpJson({ url, method = 'GET', token, body, timeoutMs = 20000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: res.status, headers: res.headers, body: parsed };
  } catch (e) {
    return { status: 0, headers: null, body: null, networkError: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

function ok2xx(status) {
  return status >= 200 && status < 300;
}

// ── Sentry ───────────────────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {(req:object)=>Promise<object>} [deps.httpJson]
 * @param {string} [deps.host]  self-hosted / bölge adresi (varsayılan sentry.io)
 * @param {()=>number} [deps.now]
 */
function createSentryApi(deps = {}) {
  const httpJson = deps.httpJson || defaultHttpJson;
  const host = String(deps.host || SENTRY_DEFAULT_HOST).replace(/\/+$/, '');
  const now = deps.now || (() => Date.now());
  const fail = (res, ctx) => classify('sentry', res, ctx, now());

  /**
   * Org-kapsamlı çağrıların TABAN adresi. F1 tuzağının çözümü: Sentry org'ları
   * bölge silolarında tutar ve org kaydı `links.regionUrl` verir. Onu kullanmazsak
   * doğru jetonla bile `apigateway 404` alırız.
   */
  function orgBase(org) {
    const region = org && org.links && typeof org.links.regionUrl === 'string' ? org.links.regionUrl : '';
    return region ? region.replace(/\/+$/, '') : host;
  }

  return {
    host,
    orgBase,

    /**
     * JETON DOĞRULAMA + ORG LİSTESİ — akışın İLK adımı ve tek 401 üreten uç.
     * @returns {Promise<{ok:true, orgs:Array}|{ok:false, code, message}>}
     */
    async verifyToken(token) {
      const res = await httpJson({ url: `${host}/api/0/organizations/`, token });
      if (!ok2xx(res.status)) {
        return fail(res, { action: 'organizasyonlar listelenirken', scope: 'org:read' });
      }
      const orgs = Array.isArray(res.body) ? res.body : [];
      if (!orgs.length) {
        return {
          ok: false,
          code: 'no-org',
          status: res.status,
          message: 'Bu Sentry jetonu hiçbir organizasyon göremiyor. Jetonu sentry.io\'da bir '
            + 'organizasyon içindeyken (Settings → Auth Tokens) üret; kişisel hesap jetonu yetmez.',
        };
      }
      return {
        ok: true,
        orgs: orgs.map((o) => ({
          slug: o.slug,
          name: o.name || o.slug,
          regionUrl: (o.links && o.links.regionUrl) || null,
          links: o.links || null,
        })),
      };
    },

    /** Org'un takımları — proje oluşturma TAKIM ister (docs.sentry.io sözleşmesi). */
    async listTeams(token, org) {
      const base = orgBase(org);
      const res = await httpJson({ url: `${base}/api/0/organizations/${org.slug}/teams/`, token });
      if (!ok2xx(res.status)) {
        return fail(res, { action: 'takımlar listelenirken', scope: 'org:read', subject: `“${org.slug}” organizasyonu` });
      }
      const teams = Array.isArray(res.body) ? res.body : [];
      return { ok: true, teams: teams.map((t) => ({ slug: t.slug, name: t.name || t.slug })) };
    },

    /** Org'un projeleri — İDEMPOTANLIK (Kural 5) buradan okunur: varsa oluşturma. */
    async listProjects(token, org) {
      const base = orgBase(org);
      const res = await httpJson({ url: `${base}/api/0/organizations/${org.slug}/projects/`, token });
      if (!ok2xx(res.status)) {
        return fail(res, { action: 'projeler listelenirken', scope: 'project:read', subject: `“${org.slug}” organizasyonu` });
      }
      const projects = Array.isArray(res.body) ? res.body : [];
      return { ok: true, projects: projects.map((p) => ({ slug: p.slug, name: p.name || p.slug, id: p.id })) };
    },

    /**
     * Projeyi BUL ya da OLUŞTUR (idempotent — Kural 5).
     * @returns {Promise<{ok:true, project:object, created:boolean}|{ok:false,…}>}
     */
    async ensureProject(token, org, team, slug, name) {
      const existing = await this.listProjects(token, org);
      if (!existing.ok) return existing;
      const hit = existing.projects.find((p) => p.slug === slug);
      // 🔴 Kural 5: "Bağla"ya ikinci kez basmak ikinci proje DOĞURMAZ. Var olanı
      // bulmak, oluşturmayı DENEYİP 409'u yutmaktan üstündür — çünkü yazma izni
      // OLMAYAN bir jeton da bu yoldan geçebilir (aşağıdaki dürüstlük notu).
      if (hit) return { ok: true, project: hit, created: false };

      const base = orgBase(org);
      const res = await httpJson({
        url: `${base}/api/0/teams/${org.slug}/${team.slug}/projects/`,
        method: 'POST',
        token,
        body: { name, slug, platform: 'node' },
      });
      if (!ok2xx(res.status)) {
        return fail(res, { action: `“${slug}” projesi oluşturulurken`, scope: 'project:write', subject: `“${team.slug}” takımı` });
      }
      const p = res.body || {};
      return { ok: true, project: { slug: p.slug || slug, name: p.name || name, id: p.id }, created: true };
    },

    /** Projenin DSN'i (`keys[0].dsn.public`) — scope: project:read. */
    async projectDsn(token, org, projectSlug) {
      const base = orgBase(org);
      const res = await httpJson({ url: `${base}/api/0/projects/${org.slug}/${projectSlug}/keys/`, token });
      if (!ok2xx(res.status)) {
        return fail(res, { action: 'DSN okunurken', scope: 'project:read', subject: `“${projectSlug}” projesi` });
      }
      const keys = Array.isArray(res.body) ? res.body : [];
      const active = keys.find((k) => k && k.isActive !== false && k.dsn && k.dsn.public) || keys[0];
      const dsn = active && active.dsn && active.dsn.public;
      if (!dsn) {
        return {
          ok: false,
          code: 'no-dsn',
          status: res.status,
          message: `“${projectSlug}” projesinde etkin bir istemci anahtarı (DSN) yok. `
            + 'Sentry → Settings → Projects → Client Keys bölümünden bir anahtar oluştur, sonra tekrar dene.',
        };
      }
      return { ok: true, dsn };
    },

    /**
     * DOĞRULAMA OKUMASI — "olay panoda göründü mü" sorusunun PROGRAMLI cevabı.
     * `event:read` ister; jetonda yoksa AÇIKÇA söyleriz (sahte "doğrulandı" YOK).
     */
    async latestEvents(token, org, projectSlug) {
      const base = orgBase(org);
      const res = await httpJson({ url: `${base}/api/0/projects/${org.slug}/${projectSlug}/events/`, token });
      if (!ok2xx(res.status)) {
        return fail(res, { action: 'gelen olaylar okunurken', scope: 'event:read', subject: `“${projectSlug}” projesi` });
      }
      return { ok: true, events: Array.isArray(res.body) ? res.body : [] };
    },
  };
}

// ── PostHog ──────────────────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {(req:object)=>Promise<object>} [deps.httpJson]
 * @param {string} [deps.host]  eu/us bölge adresi (detectRegion ile bulunur)
 */
function createPostHogApi(deps = {}) {
  const httpJson = deps.httpJson || defaultHttpJson;
  const host = String(deps.host || POSTHOG_HOSTS.eu).replace(/\/+$/, '');
  const now = deps.now || (() => Date.now());
  const fail = (res, ctx) => classify('posthog', res, ctx, now());

  return {
    host,

    /** JETON DOĞRULAMA + ORG LİSTESİ (scope: organization:read). */
    async verifyToken(token) {
      const res = await httpJson({ url: `${host}/api/organizations/`, token });
      if (!ok2xx(res.status)) {
        return fail(res, { action: 'organizasyonlar listelenirken', scope: 'organization:read' });
      }
      const orgs = Array.isArray(res.body && res.body.results) ? res.body.results : [];
      if (!orgs.length) {
        return {
          ok: false,
          code: 'no-org',
          status: res.status,
          message: 'Bu PostHog anahtarı hiçbir organizasyon göremiyor. Anahtarı üretirken '
            + '"All organizations" kapsamını seç ya da organizasyona erişimin olduğundan emin ol.',
        };
      }
      return { ok: true, orgs: orgs.map((o) => ({ id: o.id, name: o.name || o.id })) };
    },

    /** Org'un projeleri (scope: project:read) — idempotanlığın okuma ayağı. */
    async listProjects(token, org) {
      const res = await httpJson({ url: `${host}/api/organizations/${org.id}/projects/`, token });
      if (!ok2xx(res.status)) {
        return fail(res, { action: 'projeler listelenirken', scope: 'project:read', subject: `“${org.name}” organizasyonu` });
      }
      const results = Array.isArray(res.body && res.body.results) ? res.body.results : [];
      return {
        ok: true,
        projects: results.map((p) => ({ id: p.id, name: p.name, apiToken: p.api_token || null })),
      };
    },

    /** Projeyi BUL ya da OLUŞTUR (idempotent — ada göre eşleşme). */
    async ensureProject(token, org, name) {
      const existing = await this.listProjects(token, org);
      if (!existing.ok) return existing;
      const hit = existing.projects.find((p) => p.name === name);
      if (hit) return { ok: true, project: hit, created: false };

      const res = await httpJson({
        url: `${host}/api/organizations/${org.id}/projects/`,
        method: 'POST',
        token,
        body: { name },
      });
      if (!ok2xx(res.status)) {
        return fail(res, { action: `“${name}” projesi oluşturulurken`, scope: 'project:write', subject: `“${org.name}” organizasyonu` });
      }
      const p = res.body || {};
      return {
        ok: true,
        project: { id: p.id, name: p.name || name, apiToken: p.api_token || null },
        created: true,
      };
    },

    /**
     * DOĞRULAMA OKUMASI — HogQL ile son olayları say (scope: query:read).
     * Yoksa açıkça söyleriz; "gönderdim demek = göründü" saymayız.
     */
    async countRecentEvents(token, projectId, eventName, sinceIso) {
      const res = await httpJson({
        url: `${host}/api/projects/${projectId}/query/`,
        method: 'POST',
        token,
        body: {
          query: {
            kind: 'HogQLQuery',
            query: `SELECT count() FROM events WHERE event = {name} AND timestamp > {since}`,
            values: { name: eventName, since: sinceIso },
          },
        },
      });
      if (!ok2xx(res.status)) {
        return fail(res, { action: 'gönderilen olay panoda aranırken', scope: 'query:read', subject: 'proje olayları' });
      }
      const results = (res.body && res.body.results) || [];
      const count = Array.isArray(results[0]) ? Number(results[0][0]) : Number(results[0]);
      return { ok: true, count: Number.isFinite(count) ? count : 0 };
    },
  };
}

/**
 * BÖLGE OTOMATİK BULMA — kullanıcıya "EU mu US mu" diye SORMUYORUZ.
 * PostHog kişisel anahtarı bölgeye bağlıdır: doğru bölgede 200, yanlış bölgede
 * 401 döner. İkisi de 401 ise anahtar gerçekten geçersizdir; bu ayrımı yapmadan
 * "anahtar geçersiz" demek yanlış teşhis olurdu.
 *
 * @returns {Promise<{ok:true, region:'eu'|'us', host:string, api:object, orgs:Array}
 *                  |{ok:false, code, message}>}
 */
async function detectPostHogRegion(token, deps = {}) {
  const order = deps.regionOrder || ['eu', 'us'];
  let lastFailure = null;
  for (const region of order) {
    const api = createPostHogApi({ ...deps, host: POSTHOG_HOSTS[region] });
    const res = await api.verifyToken(token);
    if (res.ok) return { ok: true, region, host: POSTHOG_HOSTS[region], api, orgs: res.orgs };
    // Ağ hatası bölge bilgisi taşımaz → diğer bölgeyi denemenin anlamı var, ama
    // en anlamlı hatayı sakla (401 değilse muhtemelen asıl sorun odur).
    if (!lastFailure || res.code !== 'invalid-token') lastFailure = res;
  }
  return lastFailure || {
    ok: false,
    code: 'invalid-token',
    message: 'PostHog anahtarı ne AB ne de ABD bölgesinde kabul edildi. '
      + 'PostHog → Settings → Personal API keys bölümünden yeni bir anahtar üret.',
  };
}

module.exports = {
  SENTRY_DEFAULT_HOST,
  POSTHOG_HOSTS,
  DEFAULT_PROJECT_SLUGS,
  SCOPE_HELP,
  classify,
  sanitizeDetail,
  retryAfterSeconds,
  defaultHttpJson,
  createSentryApi,
  createPostHogApi,
  detectPostHogRegion,
};
