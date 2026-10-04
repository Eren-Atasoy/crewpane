// ADP-622 — KİM bağlanıyor? Uygulama DB'sine taşınan KİMLİK (CrewPane ID JWT).
//
// ADP-621 `app` schema'sını RLS AÇIK / 0 POLICY bıraktı (fail-closed) ve istemci
// hâlâ ANON key ile bağlanıyor. Kiracı izolasyonu (ADP-623) `auth.uid()` ister →
// önce istemcinin AUTHENTICATED olması gerekir. Bu modül o kararın SAF çekirdeği:
// "bu app DB'sine kullanıcının CrewPane ID jetonunu takmalı mıyız?"
//
// KURAL (tek satır): jetonu YALNIZCA onu ÜRETEN projeye gönder.
//   crewpane-id auth ─── aynı proje ──► app DB   → JWT tak (authenticated)
//   crewpane-id auth ─── farklı host ─► app DB   → TAKMA (anon, bugünkü davranış)
//
// İki nedenle pazarlıksız:
//   1. GÜVENLİK — access token bir SIRDIR. Yerel 54321'e (ya da herhangi bir üçüncü
//      Supabase'e) gönderilirse o sunucunun log'una/sahibine kullanıcının bulut
//      oturumu sızar. "Sadece çalışsın" diye her hedefe takmak sessiz bir sızıntıdır.
//   2. DOĞRULUK — JWT'yi imzalayan proje ile doğrulayan proje aynı değilse PostgREST
//      imzayı çözemez ve isteği 401'ler. Yani yerel dev (54321 + bulut hesabı) jetonla
//      ÇALIŞMAZ; anon'da kalması bugünkü davranışın birebir korunması demektir.
//
// ADP-621'in "aynı proje" kararının kazancı burada nakde çevrilir: bulutta auth ile
// app aynı projede olduğu için `auth.uid()` app schema'sında DOĞRUDAN çözülür —
// ekstra JWKS köprüsü/servis jetonu GEREKMEZ.
//
// SAF MODÜL: I/O yok, process.env okuması yok, Electron bağı yok → hem main hem MCP
// child hem test aynı kararı aynı yerden alır (ikiz-drift olmaz).
// Çalıştır: node --test electron/appDbIdentity.test.cjs

'use strict';

/** Jetonu bu kadar saniye kala BAYAT say (yenilemeyi erken tetikle). */
const TOKEN_SKEW_SECONDS = 60;

/**
 * Supabase proje kimliği = URL'in ORIGIN'i (şema + host + port), küçük harf.
 * Path/query/trailing slash farkları aynı projeyi FARKLI göstermemeli.
 * @returns {string|null} ayrıştırılamayan/boş değer → null (asla "eşleşti" demez)
 */
function normalizeProjectOrigin(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    return new URL(url.trim()).origin.toLowerCase();
  } catch {
    return null;
  }
}

/** İki URL aynı Supabase projesini mi gösteriyor? Bilinmeyen taraf → false. */
function sameSupabaseProject(a, b) {
  const oa = normalizeProjectOrigin(a);
  const ob = normalizeProjectOrigin(b);
  return !!oa && !!ob && oa === ob;
}

/**
 * App DB'ye hangi kimlikle gidilecek?
 *
 * @param {{authUrl?: string, dbUrl?: string}} input
 *   authUrl = CrewPane ID (JWT'yi imzalayan) proje URL'i — crewpaneId.cjs
 *   dbUrl   = uygulama DB'si — backendTarget.cjs
 * @returns {{mode: 'crewpane-id'|'anon', reason: string, project: string|null}}
 *   mode 'crewpane-id' → istemci Authorization: Bearer <kullanıcı JWT'si> kullanır
 *                        (oturum yoksa anon key'e düşer — bu KARAR değil, DURUM).
 *   mode 'anon'        → bugünkü davranış birebir.
 */
function resolveIdentityMode(input) {
  const authUrl = input && input.authUrl;
  const dbUrl = input && input.dbUrl;
  const authOrigin = normalizeProjectOrigin(authUrl);
  const dbOrigin = normalizeProjectOrigin(dbUrl);
  if (!authOrigin) return { mode: 'anon', reason: 'no_auth_url', project: null };
  if (!dbOrigin) return { mode: 'anon', reason: 'no_db_url', project: null };
  if (authOrigin !== dbOrigin) {
    // Yerel dev'in NORMAL hâli (54321 app DB + bulut hesabı): hata değil, karar.
    return { mode: 'anon', reason: 'different_project', project: dbOrigin };
  }
  return { mode: 'crewpane-id', reason: 'same_project', project: dbOrigin };
}

/**
 * Elde tutulan jeton hâlâ kullanılabilir mi? (İstemci + MCP önbellekleri aynı
 * kuralı kullanır — biri "taze" derken diğerinin 401 yemesi olmasın.)
 *
 * @param {{token?: string, expiresAt?: number|null}|null} entry
 *   expiresAt = GoTrue semantiği: EPOCH SANİYE (ms değil). null/eksik → süre
 *   bilinmiyor demektir; jetonu bir kez kullandırırız (sunucu son sözü söyler),
 *   ama önbellekte TAZE saymayız.
 * @param {number} nowMs
 * @param {number} [skewSeconds=TOKEN_SKEW_SECONDS]
 */
function tokenIsFresh(entry, nowMs, skewSeconds = TOKEN_SKEW_SECONDS) {
  if (!entry || typeof entry.token !== 'string' || !entry.token) return false;
  if (!Number.isFinite(entry.expiresAt)) return false;
  const nowS = Math.floor((Number.isFinite(nowMs) ? nowMs : 0) / 1000);
  return entry.expiresAt - nowS > skewSeconds;
}

/**
 * PostgREST schema başlıkları. ADP-621 hedefe SCHEMA'yı ekledi ama Node tarafı
 * tüketiciler (task MCP) ham REST attığı için başlık YOKTU → bulutta her istek
 * `public`e gider ve 404 döner (ADP-621 raporu §4.3). Okuma Accept-Profile,
 * yazma Content-Profile ister; `public` varsayılan olduğu için başlık eklemeyiz
 * (yerel/e2e davranışı birebir korunur).
 *
 * @param {string|null|undefined} schema
 * @param {string} method HTTP metodu
 */
function schemaHeaders(schema, method) {
  const s = typeof schema === 'string' ? schema.trim() : '';
  if (!s || s === 'public') return {};
  const write = String(method || 'GET').toUpperCase() !== 'GET';
  return write ? { 'content-profile': s, 'accept-profile': s } : { 'accept-profile': s };
}

module.exports = {
  TOKEN_SKEW_SECONDS,
  normalizeProjectOrigin,
  sameSupabaseProject,
  resolveIdentityMode,
  tokenIsFresh,
  schemaHeaders,
};
