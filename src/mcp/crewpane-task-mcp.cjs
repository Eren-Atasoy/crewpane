#!/usr/bin/env node
// ADP-183 (Ratchet) — crewpane TASK MCP server (stdio JSON-RPC).
//
// Spawned inside EVERY agent's claude session (via `--mcp-config`, wired by
// agentRunner like the ADP-051 delegate + ADP-095 browser MCPs). It exposes the
// `crewpane_task` family so any agent can see + drive the office Task Board:
//   • list_tasks      — see the board (filter by status/sprint/project/assignee)
//   • create_task     — open a new task (title, desc, assignee, project, sprint, status)
//   • update_task     — change a task (status / assignee / fields)
//   • create_project  — register a new project (a tasks.project value)
//   • create_sprint   — register a new sprint  (a tasks.sprint  value)
//
// UNLIKE the browser/delegate MCPs (which hop the ADP-050 loopback bridge to reach
// the live renderer), the board is durable Supabase state — so this server writes
// DIRECTLY to Supabase PostgREST with the app's PUBLIC anon key. A `create_task`
// inserts a `tasks` row → the TaskBoard's realtime subscription shows it INSTANTLY
// (no bridge needed). The anon key is `NEXT_PUBLIC_…` (it ships to the renderer —
// not a secret); resolved from process.env first, else the app root's .env.local
// (electron/.. , parsed locally — Electron main has no Next dotenv).
//
// Wire format mirrors crewpane-delegate-mcp.cjs / crewpane-browser-mcp.cjs:
// dependency-free newline-delimited JSON-RPC over stdio; stdout carries ONLY
// protocol messages; all logs go to stderr.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

const crewpaneEnv = require('../config/crewpaneEnv.cjs'); // ADP-244 Faz 3 — env dual-read (CREWPANE_* → CREWPANE_*)
// PDF2-1 — wing (departman) → tasks.project eşlemesi. Board sekmesi bu eşlemeyle
// SÜZÜYOR; varsayılan proje de aynı eşlemeden geçmezse yazan ile okuyan ayrışır.
const { wingToProject } = require('../agents/wingProject.cjs');
// ADP-622 — KİMLİK + SCHEMA kararları TEK yerden (saf modül); main ile ikiz-drift olmasın.
const appDbIdentity = require('../config/appDbIdentity.cjs');
// ADP-622 — bridge keşfi/failover'ı YENİDEN YAZILMAZ: delegate MCP'nin ADP-286 damgalı,
// cross-instance reddeden, stale-handshake'e failover eden keşfi aynen kullanılır.
const bridgeClient = require('./crewpane-delegate-mcp.cjs');
// CFG-01 — "hangi backend?" kararının TEK boğazı (main.js ile AYNI kod yolu). Bu MCP
// ayrı bir süreçtir ve main'in çözümlemesini MİRAS ALMAZ; bu yüzden kararı KENDİSİ,
// ama İKİNCİ BİR ÇÖZÜMLEME YAZMADAN, o boğazdan alır.
const publicBackendEnv = require('../config/publicBackendEnv.cjs');
// B-01 (Faz C) — merge durum makinesinin TEK kaynağı. Bu araç kuralı KOPYALAMAZ:
// main'in merge servisi ile aynı fiili çağırır (iki kopya = iki farklı "geçerli
// geçiş" tanımı). ⚠️ Paketleme: `mergePolicy.cjs` electron/package.json'ın
// asarUnpack listesindedir — MCP çocuğu asar dışından koşar ve orada bulamazsa
// araç HİÇ açılmaz ([[ref_crewpane_delegate_mcp_fix]]: instancePaths.cjs vakası).
const mergePolicy = require('../services/mergePolicy.cjs');
// GIT-BB-CLOUD-01 — `default_branch` doğrulaması TEK kaynaktan (git ref grameri).
// ⚠️ branchName.cjs + bağımlılığı taskCode.cjs de asarUnpack listesindedir; olmasaydı
// paketli build'de bu require patlar ve araç HİÇ açılmazdı (aynı tuzak, aynı çözüm).
const branchName = require('../config/branchName.cjs');

const SERVER_INFO = { name: 'crewpane-task', version: '1.0.0' };

// tasks_status_check (migration 20260520010000) — keep in sync.
const TASK_STATUSES = Object.freeze(['backlog', 'todo', 'in_progress', 'review', 'done']);

function logErr(msg) {
  try {
    process.stderr.write(`[crewpane-task-mcp] ${msg}\n`);
  } catch {
    /* stderr closed */
  }
}

// ── .env.local loader (mirrors jarvisVoice.parseEnvFile; NEXT_PUBLIC anon key) ─
/** Parse a dotenv-style file body → { KEY: value }. Strips quotes + comments. */
function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text == null ? '' : text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

let _envCache = null;
/** Load (once) the app root's .env.local. Candidates: <electron/..>, cwd. */
function loadEnvLocal() {
  if (_envCache) return _envCache;
  _envCache = {};
  const candidates = [path.join(__dirname, '..', '.env.local'), path.join(process.cwd(), '.env.local')];
  for (const p of candidates) {
    try {
      _envCache = parseEnvFile(fs.readFileSync(p, 'utf8'));
      if (_envCache && Object.keys(_envCache).length) break;
    } catch {
      /* try next candidate */
    }
  }
  return _envCache;
}

/**
 * Resolve the Supabase REST endpoint + anon key (+ ADP-621 schema), or null if
 * unconfigured. `schema` bulutta 'app'tir (uygulama tabloları orada yaşar); yerel
 * ve e2e stack'lerinde 'public' → başlık hiç eklenmez, davranış birebir aynı kalır.
 *
 * CFG-01 — BU FONKSİYON ARTIK KENDİ ÇÖZÜMLEMESİNİ YAPMAZ.
 * Eskiden yalnız `process.env` + `.env.local` okuyordu; MÜŞTERİ kopyasında ikisi de
 * YOKTUR (paketli app asgari launchd env'iyle açılır, `.env.local` gitignore'lu bir
 * geliştirici dosyasıdır) → null → "Supabase is not configured" → ödeyen kullanıcı
 * kendi altyapısını kurmaya çalıştı. Karar artık main.js ile AYNI boğazdan gelir
 * (publicBackendEnv → backendTarget.resolveBackendTarget): müşteri kopyasında hedef
 * env'den BAĞIMSIZ, gömülü bir sabittir (PROD_CLOUD). Gerekçenin tamamı ve ölçüm:
 * electron/publicBackendEnv.cjs başlığı.
 *
 * `loadEnvLocal()` (aşağıda) yalnız GERİYE DÖNÜK dikiş olarak duruyor — çözümleme
 * yolunda değil; kaldırmak dışarıdan require eden testleri kırardı.
 */
function resolveSupabase() {
  const resolved = publicBackendEnv.resolvePublicBackend();
  if (!resolved.configured) return null;
  return {
    url: resolved.url.replace(/\/+$/, ''),
    key: resolved.anonKey,
    schema: resolved.schema || 'public',
  };
}

/**
 * CFG-01 — YAPILANDIRMA YOKSA KULLANICIYA NE DENİR?
 *
 * ESKİ metin: "Supabase is not configured (NEXT_PUBLIC_CREWPANE_SUPABASE_*)".
 * İki ayrı hata birden: (a) kullanıcıyı KENDİ Supabase'ini kurmaya yönlendiriyordu —
 * oysa backend ürüne gömülü, kullanıcının yapabileceği hiçbir ayar yok; (b) iç
 * değişken adını kullanıcı yüzeyine sızdırıyordu. Müşteri gerçekten oturup ayar yaptı.
 *
 * YENİ metin hiçbir kurulum talep etmez, sorumluluğu doğru yere (destek) koyar ve
 * teşhis için ürün-içi bir KOD taşır (kanal/kaynak/build tipi — sır değil, iç ad değil).
 */
function boardUnavailableMessage() {
  let code = 'BOARD-CFG/unknown';
  try {
    code = publicBackendEnv.diagnosticCode(publicBackendEnv.resolvePublicBackend());
  } catch {
    /* teşhis kodu üretilemedi — mesaj yine de dürüst kalsın */
  }
  return (
    'Task board unavailable — the app could not reach its backend service. ' +
    'This is not a setting the user can fix; no account or database setup is required. ' +
    `Please ask the user to contact CrewPane support with diagnostic code: ${code}`
  );
}

// ── ADP-622 — AJANIN KİMLİĞİ (app DB'ye authenticated yazma) ──────────────────
//
// Bu server bir Electron süreci DEĞİL: kullanıcının safeStorage'daki oturumunu
// okuyamaz. Jetonu, panelini açan app'ten loopback bridge üstünden ister
// (GET /app-db/token — jeton main'de üretilir, süresi dolmuşsa SESSİZCE yenilenir).
// Alamazsa ANON key ile devam eder = bugünkü davranış (yerel dev / app kapalıyken
// board çalışmaya devam eder). ADP-623 policy'leri geldiğinde bu jeton, ajanın
// yazdığı satırın KİMİN adına yazıldığını belirleyen tek şeydir.
let _tokenCache = null; // { token, expiresAt } | null
let _tokenInFlight = null;
// NEGATİF ÖNBELLEK: "kimlik yok" YAYGIN ve NORMAL bir durumdur (yerel dev =
// different_project, app kapalı = bridge yok). Onu önbelleklemezsek HER board
// isteği önce bridge'i yoklar ve stderr'i aynı satırla doldururuz.
const NEGATIVE_TTL_MS = 60_000;
let _negativeUntilMs = 0;

/** Taze access token (yoksa null → anon). Eşzamanlı çağrılar tek isteğe biner. */
async function appDbAccessToken() {
  if (appDbIdentity.tokenIsFresh(_tokenCache, Date.now())) return _tokenCache.token;
  if (Date.now() < _negativeUntilMs) return null;
  if (_tokenInFlight) return _tokenInFlight;
  _tokenInFlight = (async () => {
    try {
      const candidates = bridgeClient.discoverBridgeCandidates();
      if (!candidates.length) {
        // App kapalı / bridge yok → anon. Sessiz kalmıyoruz: ADP-623'te "bu satırı
        // kim yazdı" sorusunun cevabı burada kayboluyor olabilir.
        logErr('app DB kimliği yok (bridge bulunamadı — app kapalı?) → anon key ile devam');
        _tokenCache = null;
        _negativeUntilMs = Date.now() + NEGATIVE_TTL_MS;
        return null;
      }
      const res = await bridgeClient.bridgeRequestFailover(candidates, 'GET', '/app-db/token');
      const body = res && res.body;
      if (!body || !body.ok || typeof body.token !== 'string' || !body.token) {
        // Kimliğin SESSİZCE düşmesi, ADP-623 izolasyonunda "sahipsiz satır" olarak
        // geri gelir → sebebi HER ZAMAN yaz. 'different_project'/'not_signed_in'
        // normal durumlardır; 401/403 (bayat handshake / cross-instance) ise bir
        // KABLO arızasıdır ve bu satır olmadan görünmez kalırdı.
        const why = (body && (body.reason || body.error)) || `HTTP ${res && res.status}`;
        logErr(`app DB kimliği yok (${why}) → anon key ile devam`);
        _tokenCache = null;
        _negativeUntilMs = Date.now() + NEGATIVE_TTL_MS;
        return null;
      }
      _tokenCache = {
        token: body.token,
        expiresAt: Number.isFinite(body.expiresAt) ? body.expiresAt : null,
      };
      return body.token;
    } catch (err) {
      logErr(`app DB jetonu alınamadı (${err.message}) → anon key ile devam`);
      _tokenCache = null;
      _negativeUntilMs = Date.now() + NEGATIVE_TTL_MS;
      return null;
    } finally {
      _tokenInFlight = null;
    }
  })();
  return _tokenInFlight;
}

// ── BOARD-AUTH-01 — KİMLİK ile HEDEF AYNI PROJEDEN Mİ? ───────────────────────
//
// ÖLÇÜLEN ARIZA (03.09, dev 0.2.43-dev.3): bu süreç REST hedefini KENDİSİ çözer
// (`resolveSupabase`), kimliği ise KÖPRÜDEN alır (`/app-db/token`, main çözer).
// İki çözümleme AYRIŞABİLİR — ve ayrıştı: hedef PROD projesi, jeton DEV projesinin
// kullanıcı jetonu. PostgREST bir başka projenin imzasını doğrulayamaz ve
// `PGRST301 No suitable key or wrong key type` döner. Ajanın gördüğü tek şey buydu;
// "hangi iki proje karıştı" bilgisi HİÇBİR YERDE yazmıyordu, o yüzden arıza
// "board bozuk / JWT hatası" diye rapor edildi ve kök nedene ulaşmak bir gün aldı.
//
// Bu kapı ucuz ve YERELDİR: JWT'nin `iss` claim'i PUBLIC bir alandır (imza
// DOĞRULANMAZ, jetonun kendisi ASLA loglanmaz/raporlanmaz — yalnız origin'i).
// Uyuşmazlıkta jeton GÖNDERİLMEZ (garantili 401 üretirdi) ve sebep saklanır:
// `pgError` onu hatanın önüne ekler, böylece mesaj kullanıcının/ajanın
// yapabileceği bir şeye işaret eder.
let _identityMismatch = null; // { tokenOrigin, targetOrigin } | null

/** JWT'nin `iss` origin'i — yalnız payload okunur, imza doğrulanmaz. */
function tokenIssuerOrigin(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(b64 + '='.repeat((4 - (b64.length % 4)) % 4), 'base64').toString('utf8');
    const iss = JSON.parse(json).iss;
    return iss ? new URL(iss).origin : null;
  } catch {
    return null; // okunamayan jeton bir KARAR sebebi değil → bugünkü yol
  }
}

/** Jeton hedefle aynı projeden mi? `iss` okunamıyorsa BUGÜNKÜ davranış (gönder). */
function identityMatchesTarget(token, supa) {
  const tokenOrigin = tokenIssuerOrigin(token);
  if (!tokenOrigin) return true;
  let targetOrigin = null;
  try { targetOrigin = new URL(supa.url).origin; } catch { return true; }
  if (tokenOrigin === targetOrigin) {
    _identityMismatch = null;
    return true;
  }
  if (!_identityMismatch || _identityMismatch.tokenOrigin !== tokenOrigin) {
    logErr(`⛔ kimlik/hedef UYUŞMAZLIĞI: jeton ${tokenOrigin} projesinden, board hedefi ${targetOrigin} `
      + '→ jeton GÖNDERİLMİYOR (PostgREST onu doğrulayamaz). Uygulama ile bu araç farklı backend\'e bakıyor.');
  }
  _identityMismatch = { tokenOrigin, targetOrigin };
  return false;
}

/**
 * Bir istek için başlıklar: kimlik (Bearer) + schema profili.
 * `apikey` HER ZAMAN anon key kalır — PostgREST/Kong onu ister; `authorization`
 * ise KİMLİĞİ taşır (jeton varsa kullanıcı, yoksa anon key = bugünkü davranış).
 */
async function authHeaders(supa, method) {
  const token = await appDbAccessToken();
  const usable = token ? identityMatchesTarget(token, supa) : false;
  return {
    ...(usable ? { authorization: `Bearer ${token}` } : {}),
    ...appDbIdentity.schemaHeaders(supa && supa.schema, method),
  };
}

// ── TASKDB-RLS-01 — YAZILAN SATIRIN KİRACISI (company_id) ────────────────────
//
// ADP-623 `fill_company_id` trigger'ı boş `company_id`yi `app.current_company_id()`
// ile doldurur; O FONKSİYON **BİRDEN ÇOK ÜYELİKTE BİLEREK NULL DÖNER** ("belirsizliği
// tahmin etmeyiz, çağıran company_id'yi AÇIKÇA yazmak zorunda kalır" — ADP-623 §1).
// Bu server o sözleşmenin gerektirdiği açık yazmayı hiç yapmıyordu: kullanıcı ikinci
// bir company'ye üye olur olmaz trigger NULL bırakıyor, INSERT'in WITH CHECK'i
// `NULL in (...)` → NULL → 42501 "new row violates row-level security policy"
// veriyordu. SELECT/UPDATE `user_company_ids()` kullandığı için ETKİLENMİYOR — arıza
// tam da bu yüzden "list/update çalışıyor, create çalışmıyor" şeklinde görünüyor.
//
// KİRACI KURALI UYDURULMADI — uygulamanın KENDİ kuralı birebir yansıtılıyor:
// `companies`, `created_at` artan, ilk satır (src/lib/auth.ts resolveOwnCompany +
// hooks/useOfficeWings). Satırları zaten RLS süzer, yani sonuç HER ZAMAN kullanıcının
// üyesi olduğu bir company'dir → perde ZAYIFLAMAZ (başka kiracının id'si yazılırsa
// policy yine 42501 döndürür; ölçüldü). Ajanın açtığı kart, kullanıcının ofiste
// GÖRDÜĞÜ şirkete düşer.
//
// Kimlik yoksa (yerel 54321 / e2e 55321 anon stack'leri) `null` döner ve istek
// BUGÜNKÜ hâliyle — company_id'siz — atılır: o yolların davranışı bit-bit korunur.
let _companyCache = null; // { id } | null
let _companyInFlight = null;

async function activeCompanyId(supa) {
  if (_companyCache) return _companyCache.id;
  if (_companyInFlight) return _companyInFlight;
  _companyInFlight = (async () => {
    try {
      const token = await appDbAccessToken();
      if (!token) return null; // kimliksiz yol — bugünkü davranış
      const res = await restRequest(
        supa,
        'GET',
        '/rest/v1/companies?select=id&order=created_at.asc&limit=1',
        null,
        await authHeaders(supa, 'GET'),
      );
      const id = Array.isArray(res.body) && res.body[0] && res.body[0].id;
      if (res.status !== 200 || !id) {
        logErr(`kiracı çözülemedi (http ${res.status}) → company_id'siz devam`);
        return null;
      }
      _companyCache = { id };
      return id;
    } catch (err) {
      logErr(`kiracı çözülemedi (${err.message}) → company_id'siz devam`);
      return null;
    } finally {
      _companyInFlight = null;
    }
  })();
  return _companyInFlight;
}

// ── PostgREST request ─────────────────────────────────────────────────────────
/** Minimal JSON REST request to Supabase. Resolves { status, body }. */
function restRequest(supa, method, pathPart, bodyObj, extraHeaders) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(supa.url + pathPart);
    } catch (err) {
      reject(err);
      return;
    }
    const payload = bodyObj != null ? Buffer.from(JSON.stringify(bodyObj)) : null;
    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        method,
        path: target.pathname + target.search,
        headers: {
          apikey: supa.key,
          authorization: `Bearer ${supa.key}`,
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...(extraHeaders || {}),
        },
        timeout: 20000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            /* non-JSON (PostgREST always JSON on error too, but be safe) */
          }
          resolve({ status: res.statusCode, body: parsed, raw: data });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Supabase request timed out')));
    if (payload) req.write(payload);
    req.end();
  });
}

// ── helpers ─────────────────────────────────────────────────────────────────
function toolError(text) {
  return { content: [{ type: 'text', text }], isError: true };
}
function toolOk(text) {
  return { content: [{ type: 'text', text }] };
}

/** Normalize a free-text name into a safe slug, preserving case (SPRINT-AD-23). */
function slugify(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .replace(/^-+|-+$/g, '');
}

// ADP-253 — sprint slug'ının KANONİK formu BÜYÜK harftir (board `tasks.sprint`
// TEXT'ini sprints.slug ile metin-eşleştirir; "sprint-ad-27" ≠ "SPRINT-AD-27"
// bölünmesi görevleri yanlış grupta bıraktı). Her sprint yazan yol (create_task /
// update_task / create_sprint / list filtresi) buradan geçer; DB tarafındaki ikizi
// migration 20260710120000'in normalize_sprint_slug() trigger'ı — ikisi senkron kalmalı.
function normalizeSprintSlug(value) {
  return slugify(value).toUpperCase();
}

/** Generate a unique TEXT task id (tasks.id is a caller-supplied PK). */
function genTaskId() {
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 60466176).toString(36); // up to 6 base36 digits
  return `TASK-${t}${r}`.toUpperCase();
}

/** The agent's own id (for assignee default / attribution), best-effort. */
function selfAgentId() {
  // ADP-244 Faz 3 — dual-read; lider → ajan önceliği korunur.
  return (crewpaneEnv.readEnv('LEADER_ID') || crewpaneEnv.readEnv('AGENT_ID') || '').trim() || null;
}

// BOARD-AUTH-01 — HATA METNİ TEŞHİS TAŞIR.
//
// Eski hâli PostgREST'in ham cümlesini AYNEN geçiriyordu. `PGRST301 No suitable key
// or wrong key type` bir ajana/kullanıcıya HİÇBİR ŞEY söylemez: ne hangi iki
// backend'in karıştığını, ne de ne yapması gerektiğini. Ölçülen sonuç, liderin
// "board bozuk, geçici kimlik uyduruyorum" demesi oldu.
//
// Ham metin KORUNUR (destek/teşhis onu okur); önüne yalnız, ÖLÇÜLMÜŞ bir uyuşmazlık
// varsa, ne olduğunu ve çıkış yolunu söyleyen bir cümle eklenir. Sır taşımaz:
// yalnız iki ORIGIN (jeton ne diyor / hedef ne) — jeton, e-posta, claim YOK.
function pgError(res, fallback) {
  const b = res && res.body;
  const base = (b && (b.message || b.hint || b.details))
    ? [b.message, b.details, b.hint].filter(Boolean).join(' — ')
    : `${fallback} (HTTP ${res ? res.status : '?'})`;
  if (_identityMismatch && res && (res.status === 401 || res.status === 403)) {
    return (
      'Board connection mismatch — the app is signed in to a DIFFERENT backend than this tool is '
      + `querying (session: ${_identityMismatch.tokenOrigin} · board: ${_identityMismatch.targetOrigin}). `
      + 'The board was NOT reached and nothing was written. Ask the user to restart CrewPane from a clean '
      + 'shell (a stale NEXT_PUBLIC_CREWPANE_SUPABASE_* in the launching environment causes this); '
      + `if it persists, contact CrewPane support. Underlying error: ${base}`
    );
  }
  return base;
}

// ── TEAM-SCOPE-01 — GÖREV ATAMASINDA TAKIM SINIRI + PROJE SLUG NÖBETİ ─────────
//
// Eren PDF bulgu #1/#3 (BUG-R3 §1.1): lider (a) serbest bir `project` slug'ıyla
// board'da SESSİZCE yeni grup doğurabiliyor ("Youtube Longform Growth" vakası),
// (b) BAŞKA takımın ajanına görev atayabiliyordu (Joker/Batman/Inferno/Arrow).
// ADP-717 aynı sınırı delegasyonda koyar; İLKE BİREBİR AYNI ve KARAR AYNI
// MODÜLDEN alınır (teamScope.authorize) — ret mesajı da aynı dili konuşur
// (explainRefusal): mesaj farkı, kuralın farklı sanılmasına yol açardı.
//
// İzin listesi (sahibin grants'ı) settings.json'da yaşar; bu süreç onu
// agentSettings.readSettings() ile SALT-OKUR. Mandal çakma (ensureTeamScopeMandate)
// BURADAN ÇAĞRILMAZ: o bir YAZMA'dır ve main ile bu çocuk sürecin aynı dosyaya
// yazması yarış doğururdu. Ayarlar okunamazsa varsayılan politika geçerlidir
// (kural AÇIK, izin YOK → yalnız kendi takım).
//
// FAIL-OPEN SINIRI (bilinçli, teamMembership.ts ile aynı ilke): ajanın departmanını
// OKUYAMAMAK (ağ/REST arızası) bir yetki kararı değildir → kapı atlanır. Ama ajan
// GERÇEKTEN yoksa (satır yok) FK hatasını beklemeden erken ve anlaşılır ret döner.
const teamScope = require('../agents/teamScope.cjs');

let _teamPolicyProvider = () => {
  // Lazy require: agentSettings, instancePaths üzerinden CREWPANE_INSTANCE'a göre
  // doğru home'u seçer (pane env'i taşır). Yalnız okuma; asarUnpack listesinde ✓.
  return require('../agents/agentSettings.cjs').readSettings().teamScope;
};
/** Test dikişi — birim testler gerçek settings.json'a dokunmaz. */
function _setTeamPolicyForTest(fn) {
  _teamPolicyProvider = typeof fn === 'function' ? fn : () => undefined;
}
function readTeamScopePolicy() {
  try {
    return teamScope.sanitizeTeamScope(_teamPolicyProvider());
  } catch {
    return teamScope.sanitizeTeamScope(undefined);
  }
}

/** Çağıranın kendi takımı (pane env'inden; ADP-244 dual-read). */
function callerScope() {
  return (crewpaneEnv.readEnv('DEPARTMENT') || '').trim();
}

/**
 * Assignee bu çağıranın iş verebileceği biri mi? — ADP-717 kapısının görev-ataması
 * yüzü. Karar: kendine atama serbest · kendi takım serbest · başka takım = sahibin
 * grant'ı şart (delegasyonla AYNI izin, AYNI ret cümlesi).
 */
async function assigneeTeamGate(supa, assigneeId) {
  const self = selfAgentId();
  if (self && assigneeId === self) return { ok: true }; // kendine atama her zaman serbest
  const mine = callerScope();
  if (!mine) return { ok: true }; // kapsamsız çağıran (script/shell) — authorize'ın caller-scope-unknown kararıyla aynı

  let row = null;
  try {
    const res = await restRequest(
      supa,
      'GET',
      `/rest/v1/agents?id=eq.${encodeURIComponent(assigneeId)}&select=id,department`,
      null,
      await authHeaders(supa, 'GET'),
    );
    if (res.status !== 200 || !Array.isArray(res.body)) return { ok: true }; // okunamadı → fail-open
    row = res.body[0] || null;
  } catch {
    return { ok: true }; // ağ arızası yetki kararı değildir
  }
  if (!row) {
    return {
      ok: false,
      error: `assignee "${assigneeId}" is not a known agent — görev atanmadı. Ajanın gerçek id'sini kullan (görünen ad değil).`,
    };
  }
  const dept = typeof row.department === 'string' ? row.department.trim() : '';
  if (!dept) {
    return {
      ok: false,
      error: `assignee "${assigneeId}" hiçbir takımda görünmüyor (department boş) — görev atanmadı. Önce ajanı bir takıma bağla.`,
    };
  }
  const dec = teamScope.authorize({
    action: 'delegate', // görev atamak = iş vermek; delegasyonla AYNI eylem sınıfı
    callerId: self || '',
    callerScope: mine,
    targetScope: dept,
    policy: readTeamScopePolicy(),
  });
  if (dec.ok) return { ok: true };
  return { ok: false, error: `assignee "${assigneeId}": ${dec.reason}` };
}

/**
 * Açıkça verilen `project` slug'ının nöbeti — bilinmeyen slug SESSİZCE yeni board
 * grubu doğurmaz. Geçerli sayılanlar: çağıranın kendi takımı · projects kaydında
 * olan · en az bir görevin kullandığı (legacy serbest etiketler kırılmaz).
 */
async function validateExplicitProject(supa, slug) {
  const s = String(slug || '').trim();
  if (!s) return { ok: true };
  const mine = callerScope();
  if (mine && s.toLowerCase() === mine.toLowerCase()) return { ok: true };
  try {
    const reg = await restRequest(
      supa,
      'GET',
      `/rest/v1/projects?slug=eq.${encodeURIComponent(s)}&select=slug&limit=1`,
      null,
      await authHeaders(supa, 'GET'),
    );
    if (reg.status === 200 && Array.isArray(reg.body) && reg.body.length) return { ok: true };
    const used = await restRequest(
      supa,
      'GET',
      `/rest/v1/tasks?project=eq.${encodeURIComponent(s)}&select=id&limit=1`,
      null,
      await authHeaders(supa, 'GET'),
    );
    if (used.status === 200 && Array.isArray(used.body) && used.body.length) return { ok: true };
    if (reg.status !== 200 || used.status !== 200) return { ok: true }; // okunamadı → fail-open (görev açmayı ağ arızası düşürmez)
  } catch {
    return { ok: true };
  }
  return {
    ok: false,
    error:
      `unknown project "${s}" — board'da böyle bir proje yok ve bilinmeyen slug sessizce yeni grup AÇMAZ. ` +
      // PDF2-1 — ESKİ CÜMLE YANILTIYORDU: "kendi takımının projesi" ile "kendi
      // departmanının slug'ı" AYNI ŞEY DEĞİL (DC'de departman `education`, proje
      // `skool`). O tavsiyeyi izleyen lider `project` vermeyi bıraktı ve kartlar
      // görünmeyen bir gruba düştü. Artık varsayılan eşlemeden geçtiği için
      // tavsiye DOĞRU — ama cümle de ne yaptığını AÇIKÇA söylüyor.
      'Ya `project` alanını hiç verme (görev, takımının board projesine düşer — ' +
      'departman slug\'ın proje slug\'ından farklıysa eşleme otomatik uygulanır), ' +
      'ya da gerçekten yeni bir proje gerekiyorsa önce create_project ile AÇIKÇA kaydet.',
  };
}

// ── BOARD-IMG-7 — GÖREV KARTI EKLERİ (task_attachments) ──────────────────────
//
// İŞ BÖLÜMÜ (tasarım §5): BAYTLARI main işler, SATIRI bu süreç yazar.
//   · Bu süreç Electron DEĞİL → `nativeImage` yok → küçük-resim ÜRETEMEZ, ve
//     hesap-kapsamlı depo kökünü bilmez. Onları köprüden ister (POST /task-attachment).
//   · Satırı KENDİSİ yazar çünkü ZATEN PostgREST'e yazıyor (görev açma) ve
//     kimliği (ADP-622 jetonu) buradadır — main'e yazdırsaydık "bu satırı kim
//     yazdı" bilgisi kaybolurdu.
//
// APP KAPALIYSA: köprü yok → küçük-resim ve depo kökü yok. O hâlde satır
// YAZILMAZ ve araç DÜRÜSTÇE hata döner. `thumb_data_url: null` + `local_rel_path:
// null` bir satır yazmak, board'da SONSUZA KADAR boş bir ek bırakırdı (WIN-IMG-01
// dersi: sessiz düşme yasak).

/** Tek çağrıda iliştirilebilecek görsel sayısı (köprüdeki tavanla aynı). */
const ATTACH_MAX = 8;

/** Çağıranın verdiği ek listesini normalize et (şekil nöbeti; MIME kararı main'de). */
function normalizeAttachments(raw) {
  if (!Array.isArray(raw)) return { ok: false, error: '`attachments` bir dizi olmalı.' };
  const list = [];
  for (const it of raw) {
    const item = it && typeof it === 'object' ? it : {};
    const p = typeof item.path === 'string' ? item.path.trim() : '';
    if (!p) return { ok: false, error: 'her ek bir `path` (mutlak dosya yolu) ister.' };
    const out = { path: p };
    if (typeof item.title === 'string' && item.title.trim()) out.title = item.title.trim();
    if (typeof item.kind === 'string' && item.kind.trim()) out.kind = item.kind.trim();
    if (item.cover === true) out.cover = true;
    list.push(out);
  }
  if (!list.length) return { ok: false, error: '`attachments` boş.' };
  if (list.length > ATTACH_MAX) return { ok: false, error: `en fazla ${ATTACH_MAX} görsel iliştirilebilir.` };
  return { ok: true, list };
}

/**
 * Baytları köprüye (main) yolla → { accepted[], skipped[] }.
 * Köprü yoksa/501 dönerse `ok:false` + KULLANILABİLİR bir sebep.
 */
async function ingestViaBridge(taskId, list, createdBy) {
  let candidates = [];
  try {
    candidates = bridgeClient.discoverBridgeCandidates();
  } catch (err) {
    return { ok: false, error: `köprü keşfi başarısız: ${err.message}` };
  }
  if (!candidates.length) {
    return { ok: false, error: 'CrewPane açık değil — görsel iliştirmek için uygulama çalışıyor olmalı (küçük-resim ve ek deposu orada üretilir).' };
  }
  let res;
  try {
    res = await bridgeClient.bridgeRequestFailover(candidates, 'POST', '/task-attachment', {
      taskId,
      attachments: list,
      ...(createdBy ? { createdBy } : {}),
    });
  } catch (err) {
    return { ok: false, error: `görsel iliştirilemedi (köprü): ${err.message}` };
  }
  const body = res && res.body;
  if (!body || body.ok !== true) {
    const why = (body && body.error) || `HTTP ${res && res.status}`;
    return { ok: false, error: `görsel iliştirilemedi: ${why}` };
  }
  return { ok: true, accepted: Array.isArray(body.accepted) ? body.accepted : [], skipped: Array.isArray(body.skipped) ? body.skipped : [] };
}

/** Kabul edilen ekleri `task_attachments`e yaz. Kapak seçimi ayrı bir RPC'dir. */
async function insertAttachmentRows(supa, taskId, accepted) {
  const rows = accepted.map((a, i) => ({
    task_id: taskId,
    sha256: a.sha256,
    mime: a.mime,
    bytes: a.bytes,
    ...(Number.isFinite(a.width) ? { width: a.width } : {}),
    ...(Number.isFinite(a.height) ? { height: a.height } : {}),
    local_rel_path: a.localRelPath || null,
    origin_device: a.originDevice || null,
    thumb_data_url: a.thumbDataUrl || null,
    kind: a.kind || 'screenshot',
    source: 'agent',
    title: a.title || null,
    created_by: a.createdBy || selfAgentId(),
    sort_order: 100 + i,
  }));
  let res;
  try {
    res = await restRequest(supa, 'POST', '/rest/v1/task_attachments', rows, {
      prefer: 'return=representation',
      ...(await authHeaders(supa, 'POST')),
    });
  } catch (err) {
    return { ok: false, error: `Supabase'e ulaşılamadı: ${err.message}` };
  }
  if (res.status !== 201 && res.status !== 200) {
    return { ok: false, error: pgError(res, 'ek satırı yazılamadı') };
  }
  return { ok: true, rows: Array.isArray(res.body) ? res.body : [] };
}

/** Kapak seç — `set_task_cover()` RPC'si (tek işlem, iki ifade; §3.1). */
async function setCover(supa, taskId, attachmentId) {
  try {
    const res = await restRequest(supa, 'POST', '/rest/v1/rpc/set_task_cover',
      { p_task_id: taskId, p_attachment_id: attachmentId },
      await authHeaders(supa, 'POST'));
    if (res.status >= 200 && res.status < 300) return { ok: true };
    return { ok: false, error: pgError(res, 'kapak ayarlanamadı') };
  } catch (err) {
    return { ok: false, error: `kapak ayarlanamadı: ${err.message}` };
  }
}

/**
 * Ortak iliştirme akışı — `create_task`/`update_task`/`attach_to_task` üçü de bunu
 * çağırır. Dönen METİN ajanın okuyacağı özettir; ATLANAN HER DOSYA SEBEBİYLE yazılır.
 */
async function attachToTask(supa, taskId, rawAttachments, opts = {}) {
  const norm = normalizeAttachments(rawAttachments);
  if (!norm.ok) return { ok: false, error: norm.error };

  const ing = await ingestViaBridge(taskId, norm.list, opts.createdBy || selfAgentId());
  if (!ing.ok) return { ok: false, error: ing.error };

  const lines = [];
  let insertedIds = [];
  if (ing.accepted.length) {
    const ins = await insertAttachmentRows(supa, taskId, ing.accepted);
    if (!ins.ok) return { ok: false, error: ins.error };
    insertedIds = ins.rows.map((r) => r && r.id).filter(Boolean);
    const names = ing.accepted.map((a) => a.title || a.sha256.slice(0, 8)).join(', ');
    lines.push(`${ing.accepted.length} görsel ${taskId}'e iliştirildi (${names}). Kart board'da anında güncellendi.`);

    // Kapak: çağıran `cover:true` dediyse O, demediyse ve görev henüz kapaksızsa
    // İLK ek. "İlk ek kapak olsun" varsayılanı, ajanın ekstra bir çağrı yapmadan
    // ızgarada görünür bir kart üretmesini sağlar.
    const coverIdx = ing.accepted.findIndex((a) => a.cover === true);
    const pickIdx = coverIdx >= 0 ? coverIdx : (await taskHasCover(supa, taskId) ? -1 : 0);
    if (pickIdx >= 0 && insertedIds[pickIdx]) {
      const cov = await setCover(supa, taskId, insertedIds[pickIdx]);
      if (cov.ok) lines.push(`Kapak: ${ing.accepted[pickIdx].title || ing.accepted[pickIdx].sha256.slice(0, 8)}`);
      else lines.push(`(kapak ayarlanamadı: ${cov.error})`);
    }
  }
  for (const s of ing.skipped) {
    lines.push(`Atlandı: ${s.path} — ${describeSkip(s.reason)}${s.detail ? ` (${s.detail})` : ''}`);
  }
  if (!ing.accepted.length) return { ok: false, error: lines.join('\n') || 'hiçbir görsel iliştirilemedi.' };
  return { ok: true, text: lines.join('\n'), count: ing.accepted.length };
}

/** Ham `reason` kodunu ajanın anlayacağı cümleye çevir (ham kod sızdırmayız). */
function describeSkip(reason) {
  switch (reason) {
    case 'unsupported-type': return 'desteklenmeyen tür (yalnız png/jpeg/webp/gif — tür UZANTIDAN değil dosya içeriğinden okunur)';
    case 'not-found': return 'dosya bu makinede bulunamadı';
    case 'not-a-file': return 'bir dosya değil (dizin?)';
    case 'too-large': return 'çok büyük (tavan 25 MB)';
    case 'unreadable': return 'okunamadı (izin?)';
    case 'bad-task-id': return 'görev kimliği yol olarak kullanılamaz';
    case 'empty': return 'dosya boş';
    default: return reason || 'bilinmeyen sebep';
  }
}

/** Bu görevin zaten bir kapağı var mı? (yoksa ilk ek kapak yapılır) */
async function taskHasCover(supa, taskId) {
  try {
    const res = await restRequest(
      supa, 'GET',
      `/rest/v1/task_attachments?task_id=eq.${encodeURIComponent(taskId)}&cover=is.true&select=id&limit=1`,
      null, await authHeaders(supa, 'GET'),
    );
    return res.status === 200 && Array.isArray(res.body) && res.body.length > 0;
  } catch {
    return false; // bilinmiyorsa kapak ATAMA yolunu seçeriz; en kötü ihtimalle RPC no-op'tur
  }
}

/** `attach_to_task` — var olan bir karta görsel iliştir (başka alan EZİLMEZ). */
async function runAttach(args) {
  const supa = resolveSupabase();
  if (!supa) return toolError(boardUnavailableMessage());

  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) return toolError('id is required (the task to attach to).');

  // `set_cover` tek başına da kullanılabilir: "şu var olan eki kapak yap".
  if (!args.attachments && typeof args.set_cover === 'string' && args.set_cover.trim()) {
    const cov = await setCover(supa, id, args.set_cover.trim());
    return cov.ok ? toolOk(`Kapak güncellendi (${id}).`) : toolError(cov.error);
  }
  if (!args.attachments) return toolError('attachments[] is required (or set_cover to pick an existing one).');

  const r = await attachToTask(supa, id, args.attachments);
  if (!r.ok) return toolError(r.error);
  if (typeof args.set_cover === 'string' && args.set_cover.trim()) {
    const cov = await setCover(supa, id, args.set_cover.trim());
    if (!cov.ok) return toolOk(`${r.text}\n(kapak ayarlanamadı: ${cov.error})`);
  }
  return toolOk(r.text);
}

// ── tool implementations ──────────────────────────────────────────────────────
async function runList(args) {
  const supa = resolveSupabase();
  if (!supa) return toolError(boardUnavailableMessage());

  // B-01 (Faz C) — GİT OMURGASI ALANLARI. `branch` + `merge_state` listeye girer:
  // "hangi görev hangi dalda, kaçı merge bekliyor" sorusu bugün hiçbir yerden
  // cevaplanamıyordu.
  //
  // 🪤 KADEMELİ ALAN: bu kolonlar migration 20260812090000 ile gelir ve BULUT
  // (prod board) migration'ı Eren'in onayıyla AYRI uygulanır. Yani kolonlar
  // HENÜZ OLMAYABİLİR ve PostgREST bilinmeyen kolona 400 döner — o hâlde araç
  // TAMAMEN çöker ve ajan board'u hiç göremez. Bu yüzden istek düşerse eski
  // select ile TEKRAR denenir ve düşüş RAPOR EDİLİR (sessiz degrade yok).
  const BASE_SELECT = 'id,title,status,project,sprint,assigned_agent_id,priority';
  const GIT_SELECT = `${BASE_SELECT},branch,merge_state`;
  const qp = [`select=${GIT_SELECT}`, 'order=updated_at.desc'];
  if (typeof args.status === 'string' && args.status.trim()) qp.push(`status=eq.${encodeURIComponent(args.status.trim())}`);
  if (typeof args.sprint === 'string' && args.sprint.trim())
    qp.push(`sprint=eq.${encodeURIComponent(normalizeSprintSlug(args.sprint))}`);
  if (typeof args.project === 'string' && args.project.trim()) qp.push(`project=eq.${encodeURIComponent(args.project.trim())}`);
  if (typeof args.assignee === 'string' && args.assignee.trim())
    qp.push(`assigned_agent_id=eq.${encodeURIComponent(args.assignee.trim())}`);
  let limit = Number(args.limit);
  if (!Number.isFinite(limit) || limit <= 0) limit = 20;
  limit = Math.min(Math.max(1, Math.floor(limit)), 100);
  qp.push(`limit=${limit}`);

  let res;
  let gitColumns = true;
  try {
    res = await restRequest(supa, 'GET', `/rest/v1/tasks?${qp.join('&')}`, null, await authHeaders(supa, 'GET'));
    if (res.status === 400 && /branch|merge_state/.test(pgError(res, ''))) {
      // Kolonlar bu hedefte HENÜZ YOK → eski select ile devam, ama SESSİZCE değil.
      gitColumns = false;
      qp[0] = `select=${BASE_SELECT}`;
      res = await restRequest(supa, 'GET', `/rest/v1/tasks?${qp.join('&')}`, null, await authHeaders(supa, 'GET'));
    }
  } catch (err) {
    return toolError(`could not reach Supabase: ${err.message}`);
  }
  if (res.status !== 200 || !Array.isArray(res.body)) return toolError(pgError(res, 'list_tasks failed'));
  const note = gitColumns ? '' : '\n(not: bu board git-omurgası kolonlarını taşımıyor — B-01 migration\'ı bu hedefe uygulanmamış)';
  if (res.body.length === 0) return toolOk(`No tasks match the filter.${note}`);
  const lines = res.body.map((t) => {
    const who = t.assigned_agent_id ? ` @${t.assigned_agent_id}` : '';
    const sp = t.sprint ? ` {${t.sprint}}` : '';
    // B-01 — dal ve merge durumu. 'none' BASILMAZ: görevlerin ezici çoğunluğu
    // izolasyonsuzdur ve her satıra "«none»" yazmak listeyi okunmaz yapardı.
    const br = t.branch ? ` ⎇${t.branch}` : '';
    const ms = t.merge_state && t.merge_state !== 'none' ? ` «${t.merge_state}»` : '';
    return `• ${t.id} [${t.status}]${who}${sp} (${t.project})${br}${ms} — ${t.title}`;
  });
  return toolOk(`${res.body.length} task(s):\n${lines.join('\n')}${note}`);
}

async function runCreate(args) {
  const supa = resolveSupabase();
  if (!supa) return toolError(boardUnavailableMessage());

  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (!title) return toolError('title is required.');

  const status = typeof args.status === 'string' && args.status.trim() ? args.status.trim() : 'backlog';
  if (!TASK_STATUSES.includes(status)) {
    return toolError(`invalid status "${status}" — use one of: ${TASK_STATUSES.join(', ')}.`);
  }
  // TEAM-SCOPE-01 — açık `project` doğrulanır (bilinmeyen slug sessizce grup doğurmaz);
  // verilmezse varsayılan zaten çağıranın takımıdır (doğru davranış — Eren PDF #1).
  const explicitProject = typeof args.project === 'string' && args.project.trim() ? args.project.trim() : '';
  if (explicitProject) {
    const v = await validateExplicitProject(supa, explicitProject);
    if (!v.ok) return toolError(`create_task failed: ${v.error}`);
  }
  // PDF2-1 — VARSAYILAN PROJE EŞLEMEDEN GEÇER.
  //
  // Eskiden `DEPARTMENT` env'i OLDUĞU GİBİ yazılıyordu. DC ajanlarında bu değer
  // `education`; board'un DC sekmesi ise `WING_TO_PROJECT` ile `skool` süzüyor →
  // yeni kartlar sekmede GÖRÜNMÜYORDU (Eren, PDF v2 s.9-10: "yeni sprintleri
  // gitmiş yeni DC takım sekmesi açmış görevlerde oraya koymuş"). Yazan ile
  // okuyan artık AYNI tanımdan geçiyor (`electron/wingProject.cjs`; renderer
  // ikizi TaskBoard.tsx `WING_TO_PROJECT`, drift kapısı wingProject.test.cjs).
  //
  // AÇIKÇA verilen `project` eşlemeden GEÇMEZ: varsayılan bir kolaylıktır, açık
  // niyeti ezmez (eski `education` grubunu bilerek hedefleyen çağrı çalışsın).
  const project =
    explicitProject ||
    wingToProject((crewpaneEnv.readEnv('DEPARTMENT') || '').trim()) || // ADP-244 Faz 3 — dual-read
    'crewpane';

  // TEAM-SCOPE-01 — assignee takım sınırı (ADP-717 ile aynı kapı, görev-ataması yüzü).
  if (typeof args.assignee === 'string' && args.assignee.trim()) {
    const gate = await assigneeTeamGate(supa, args.assignee.trim());
    if (!gate.ok) return toolError(`create_task failed: ${gate.error}`);
  }

  const row = { id: genTaskId(), title, project, status };
  if (typeof args.description === 'string' && args.description.trim()) row.description = args.description.trim();
  if (typeof args.sprint === 'string' && args.sprint.trim()) row.sprint = normalizeSprintSlug(args.sprint);
  if (typeof args.assignee === 'string' && args.assignee.trim()) row.assigned_agent_id = args.assignee.trim();
  if (Number.isFinite(Number(args.priority))) row.priority = Math.floor(Number(args.priority));
  // TASKDB-RLS-01 — kiracıyı AÇIKÇA yaz (trigger çok-üyelikte dolduramaz).
  const companyId = await activeCompanyId(supa);
  if (companyId) row.company_id = companyId;

  let res;
  try {
    res = await restRequest(supa, 'POST', '/rest/v1/tasks', row, {
      prefer: 'return=representation',
      ...(await authHeaders(supa, 'POST')),
    });
  } catch (err) {
    return toolError(`could not reach Supabase: ${err.message}`);
  }
  if (res.status !== 201 && res.status !== 200) {
    // Most common avoidable failure: assignee is not a known agent (FK violation).
    const msg = pgError(res, 'create_task failed');
    if (row.assigned_agent_id && /foreign key|violates/i.test(msg)) {
      return toolError(`create_task failed: assignee "${row.assigned_agent_id}" is not a known agent. ${msg}`);
    }
    return toolError(`create_task failed: ${msg}`);
  }
  const created = Array.isArray(res.body) ? res.body[0] : res.body;
  const id = (created && created.id) || row.id;
  bumpTasksCreated(); // PH-01 — yalnız GERÇEKTEN oluşan görev sayılır (hata dalı yukarıda döndü)
  const sp = row.sprint ? ` in sprint ${row.sprint}` : '';
  const who = row.assigned_agent_id ? `, assigned to ${row.assigned_agent_id}` : '';
  let base = `Created task ${id} [${status}]${sp}${who} on project "${project}". It appears on the board instantly.`;
  // BOARD-IMG-7 — ekler görev YAZILDIKTAN SONRA iliştirilir: ek yolu düşerse
  // GÖREV YİNE AÇILMIŞ olur (görsel, görevin ön koşulu değildir). Hata gizlenmez,
  // aynı cevaba eklenir.
  if (args.attachments) {
    const att = await attachToTask(supa, id, args.attachments);
    base += `\n${att.ok ? att.text : `Görsel iliştirilemedi: ${att.error}`}`;
  }
  return toolOk(base);
}

// PH-01 — "kaç görev açıldı" ölçümü. Bu süreç main'in `telemetryBump` musluğuna
// erişemez (ayrı process), o yüzden köprünün beyaz-listeli `/telemetry/bump`
// ucundan geçer. Giden gövde TEK bir anahtar adıdır: görev başlığı/açıklaması/
// ajanı bu kanaldan ÇIKAMAZ. Fire-and-forget: köprü kapalıysa, app kapalıysa,
// jeton bayatsa görev açma AKIŞI HİÇ ETKİLENMEZ — ölçüm sessizce düşer.
function bumpTasksCreated() {
  try {
    const candidates = bridgeClient.discoverBridgeCandidates();
    if (!candidates || !candidates.length) return;
    void bridgeClient
      .bridgeRequestFailover(candidates, 'POST', '/telemetry/bump', { key: 'tasks_created' })
      .catch(() => { /* ölçüm asla görev açmayı düşürmez */ });
  } catch { /* aynı sebep */ }
}

async function runUpdate(args) {
  const supa = resolveSupabase();
  if (!supa) return toolError(boardUnavailableMessage());

  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) return toolError('id is required (the task to update).');

  const patch = {};
  if (typeof args.status === 'string' && args.status.trim()) {
    const status = args.status.trim();
    if (!TASK_STATUSES.includes(status)) return toolError(`invalid status "${status}" — use one of: ${TASK_STATUSES.join(', ')}.`);
    patch.status = status;
  }
  if (typeof args.assignee === 'string') {
    const a = args.assignee.trim();
    if (a) {
      // TEAM-SCOPE-01 — atamayı DEĞİŞTİRMEK de atamaktır: create ile aynı kapı.
      const gate = await assigneeTeamGate(supa, a);
      if (!gate.ok) return toolError(`update_task failed: ${gate.error}`);
    }
    patch.assigned_agent_id = a || null;
  }
  if (typeof args.title === 'string' && args.title.trim()) patch.title = args.title.trim();
  if (typeof args.description === 'string') patch.description = args.description;
  if (typeof args.sprint === 'string') patch.sprint = normalizeSprintSlug(args.sprint) || null;
  if (typeof args.project === 'string' && args.project.trim()) {
    // TEAM-SCOPE-01 — proje değişikliği de aynı nöbetten geçer.
    const v = await validateExplicitProject(supa, args.project.trim());
    if (!v.ok) return toolError(`update_task failed: ${v.error}`);
    patch.project = args.project.trim();
  }
  if (Number.isFinite(Number(args.priority))) patch.priority = Math.floor(Number(args.priority));

  // ── B-01 (Faz C) — merge_state GEÇİŞİ ─────────────────────────────────────
  // Board'dan gelen keyfi bir değer durumu ZIPLATAMAZ (`none → merged`: hiç
  // ölçülmemiş bir dalı "merge edildi" ilan etmek). Kural TEK yerde yaşar:
  // mergePolicy.cjs (main, merge servisi ve bu araç aynı fiili kullanır) —
  // ikinci bir kopya olsaydı "geçerli geçiş" tanımı iki yerde ayrışırdı.
  if (typeof args.merge_state === 'string' && args.merge_state.trim()) {
    const to = args.merge_state.trim();
    if (!mergePolicy.STATES.includes(to)) {
      return toolError(`invalid merge_state "${to}" — use one of: ${mergePolicy.STATES.join(', ')}.`);
    }
    // MEVCUT durumu OKU: geçiş kararı çağıranın iddiasına değil BOARD'A bakar.
    let cur = 'none';
    try {
      const c = await restRequest(
        supa, 'GET', `/rest/v1/tasks?id=eq.${encodeURIComponent(id)}&select=merge_state`,
        null, await authHeaders(supa, 'GET'),
      );
      if (c.status === 400) {
        return toolError('this board has no git-backbone columns yet (B-01 migration not applied here) — merge_state cannot be set.');
      }
      const row = Array.isArray(c.body) ? c.body[0] : null;
      if (!row) return toolError(`no task with id "${id}" (nothing updated).`);
      cur = typeof row.merge_state === 'string' ? row.merge_state : 'none';
    } catch (err) {
      return toolError(`could not reach Supabase: ${err.message}`);
    }
    if (cur !== to) {
      const tr = mergePolicy.transition(cur, to);
      if (!tr.ok) return toolError(`merge_state: ${tr.why}. İzinli hedefler: ${(mergePolicy.TRANSITIONS[cur] || []).join(', ') || '(yok)'}.`);
    }
    patch.merge_state = to;
  }
  if (typeof args.branch === 'string' && args.branch.trim()) {
    // Dal adı NİHAİ olarak main tarafında türetilir (branchName.cjs) ve orada
    // doğrulanır; burada yalnız biçim nöbeti var ki board'a serbest metin girmesin.
    const b = args.branch.trim();
    if (!/^task\/[a-z0-9][a-z0-9._-]{0,60}$/.test(b)) {
      return toolError(`invalid branch "${b}" — expected task/<code> (lowercase).`);
    }
    patch.branch = b;
  }

  // BOARD-IMG-7 — yalnız görsel iliştirmek için `update_task` çağrılabilir (alan
  // güncellemesi zorunlu değil). Görev VARLIĞI ekleme yolunda zaten doğrulanır.
  if (Object.keys(patch).length === 0 && args.attachments) {
    const att = await attachToTask(supa, id, args.attachments);
    return att.ok ? toolOk(att.text) : toolError(att.error);
  }
  if (Object.keys(patch).length === 0) {
    return toolError('nothing to update — pass at least one of: status, assignee, title, description, sprint, project, priority, merge_state, branch, attachments.');
  }
  // No updated_at trigger on tasks → set it so the board re-orders to reflect the change.
  patch.updated_at = new Date().toISOString();

  let res;
  try {
    res = await restRequest(supa, 'PATCH', `/rest/v1/tasks?id=eq.${encodeURIComponent(id)}`, patch, {
      prefer: 'return=representation',
      ...(await authHeaders(supa, 'PATCH')),
    });
  } catch (err) {
    return toolError(`could not reach Supabase: ${err.message}`);
  }
  if (res.status !== 200) return toolError(`update_task failed: ${pgError(res, 'update_task failed')}`);
  const rows = Array.isArray(res.body) ? res.body : [];
  if (rows.length === 0) return toolError(`no task with id "${id}" (nothing updated).`);
  const changed = Object.keys(patch).filter((k) => k !== 'updated_at').join(', ');
  let out = `Updated task ${id} (${changed}). The board reflects it instantly.`;
  if (args.attachments) {
    const att = await attachToTask(supa, id, args.attachments);
    out += `\n${att.ok ? att.text : `Görsel iliştirilemedi: ${att.error}`}`;
  }
  return toolOk(out);
}

/**
 * Shared upsert for the projects / sprints registry tables.
 *
 * @param {object} [optionalCols] GIT-BB-CLOUD-01 — KADEMELİ kolonlar: bu hedefte
 *   HENÜZ olmayabilirler (B-01 migration'ı prod board'a Eren onayıyla ayrı gider).
 *   PostgREST bilinmeyen kolona 400 döner ve o hâlde `create_project` TAMAMEN
 *   çökerdi; bu yüzden istek düşerse kolonlar ÇIKARILIP tekrar denenir ve düşüş
 *   RAPOR EDİLİR (`degraded:true`) — sessiz degrade yok (list_tasks ile aynı kural).
 */
async function upsertRegistry(table, args, extraCols, makeSlug, optionalCols) {
  const supa = resolveSupabase();
  if (!supa) return toolError(boardUnavailableMessage());

  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name) return toolError('name is required.');
  const toSlug = makeSlug || slugify;
  const slug = (typeof args.slug === 'string' && args.slug.trim() && toSlug(args.slug)) || toSlug(name);
  if (!slug) return toolError('could not derive a slug from the name — pass an explicit `slug`.');

  const opt = optionalCols && typeof optionalCols === 'object' ? optionalCols : null;
  const row = { slug, name, ...extraCols, ...(opt || {}) };
  if (typeof args.description === 'string' && args.description.trim()) row.description = args.description.trim();
  // TASKDB-RLS-01 — `sprints`/`projects` de `fill_company_id` trigger'ına bağlı.
  const companyId = await activeCompanyId(supa);
  if (companyId) row.company_id = companyId;

  const post = async (body) =>
    restRequest(supa, 'POST', `/rest/v1/${table}?on_conflict=slug`, body, {
      prefer: 'resolution=merge-duplicates,return=representation',
      ...(await authHeaders(supa, 'POST')),
    });

  let res;
  let degraded = false;
  try {
    res = await post(row);
    if (res.status === 400 && opt && Object.keys(opt).some((c) => pgError(res, '').includes(c))) {
      // Kolonlar bu hedefte HENÜZ YOK → kayıt kolonsuz açılır, ama SESSİZCE değil.
      degraded = true;
      const bare = { ...row };
      for (const c of Object.keys(opt)) delete bare[c];
      res = await post(bare);
    }
  } catch (err) {
    return toolError(`could not reach Supabase: ${err.message}`);
  }
  if (res.status !== 201 && res.status !== 200) return toolError(`create failed: ${pgError(res, 'create failed')}`);
  return { ok: true, slug, name, degraded };
}

/**
 * GIT-BB-CLOUD-01 — YENİ PROJEDE İZOLASYON **AÇIK** (Eren kararı 02.09).
 *
 * Bu kararın yeri BURASI, kolon varsayılanı DEĞİL: `NOT NULL DEFAULT 'worktree'`
 * ile bir kolon eklemek PostgreSQL'de MEVCUT satırları da doldurur, yani migration
 * bugünkü projeleri de izolasyona geçirirdi. DB nötr kalır ('off'), "yeni proje
 * açık gelir" sözünü satırı YARATAN yer tutar (bkz. 20260903000000 migration'ı).
 */
const PROJECT_ISOLATIONS = ['worktree', 'off'];
const PROJECT_MERGE_APPROVALS = ['boss', 'leader', 'auto'];

async function runCreateProject(args) {
  const iso = typeof args.isolation === 'string' && args.isolation.trim() ? args.isolation.trim() : 'worktree';
  if (!PROJECT_ISOLATIONS.includes(iso)) {
    return toolError(`invalid isolation "${iso}" — use one of: ${PROJECT_ISOLATIONS.join(', ')}.`);
  }
  const approval =
    typeof args.merge_approval === 'string' && args.merge_approval.trim() ? args.merge_approval.trim() : 'boss';
  if (!PROJECT_MERGE_APPROVALS.includes(approval)) {
    return toolError(`invalid merge_approval "${approval}" — use one of: ${PROJECT_MERGE_APPROVALS.join(', ')}.`);
  }
  const branch = typeof args.default_branch === 'string' && args.default_branch.trim() ? args.default_branch.trim() : 'dev';
  const refErr = branchName.refFormatError(branch);
  if (refErr) return toolError(`invalid default_branch ${JSON.stringify(branch)}: ${refErr}`);

  const r = await upsertRegistry('projects', args, {}, undefined, {
    isolation: iso,
    default_branch: branch,
    merge_approval: approval,
  });
  if (r.isError) return r;
  const note = r.degraded
    ? '\n(not: bu board git-omurgası kolonlarını taşımıyor — B-01 migration\'ı bu hedefe uygulanmamış; ' +
      'izolasyon/dal/onay AYARLARI YAZILAMADI)'
    : `\nGit omurgası: izolasyon=${iso} · varsayılan dal=${branch} · merge onayı=${approval}.`;
  return toolOk(
    `Project "${r.name}" is registered (slug: ${r.slug}). Use this slug as the \`project\` of new tasks.${note}`,
  );
}

async function runCreateSprint(args) {
  const status = typeof args.status === 'string' && args.status.trim() ? args.status.trim() : 'active';
  // ADP-253 — sprints.slug create_task'in yazdığı kanonik (BÜYÜK) formla birebir aynı üretilir.
  const r = await upsertRegistry('sprints', args, { status }, normalizeSprintSlug);
  if (r.isError) return r;
  return toolOk(
    `Sprint "${r.name}" is registered (slug: ${r.slug}). Set tasks' \`sprint\` to this slug; the board groups by sprint.`,
  );
}

/**
 * TEAM-SCOPE-01 (Eren PDF #2) — BOŞ proje kaydını sil; DOLU proje KORUNUR.
 *
 * Board açılır listesi görevlerden türediği için boş grup listeden kendiliğinden
 * düşer (TaskBoard.tsx) — asıl yetim, `projects` KAYIT tablosundaki satırdır
 * (BUG-R3 §1.2: yalnız yazılan, hiç silinemeyen tablo). Bu araç o satırı kaldırır.
 * GERİ ALINABİLİRLİK: silinen satır cevapta aynen durur; geri almak =
 * create_project'i aynı name/slug/description ile çağırmak.
 */
async function runDeleteProject(args) {
  const supa = resolveSupabase();
  if (!supa) return toolError(boardUnavailableMessage());
  const s = typeof args.slug === 'string' ? args.slug.trim() : '';
  if (!s) return toolError('slug is required (the project to delete).');

  let reg;
  try {
    reg = await restRequest(
      supa,
      'GET',
      `/rest/v1/projects?slug=eq.${encodeURIComponent(s)}&select=slug,name,description,created_at&limit=1`,
      null,
      await authHeaders(supa, 'GET'),
    );
  } catch (err) {
    return toolError(`could not reach Supabase: ${err.message}`);
  }
  if (reg.status !== 200 || !Array.isArray(reg.body)) return toolError(pgError(reg, 'delete_project failed'));
  const row = reg.body[0] || null;

  // Bağlı görev sayısı — dolu proje silinMEZ (görevleri yetim bırakmak yasak).
  let count = 0;
  try {
    const used = await restRequest(
      supa,
      'GET',
      `/rest/v1/tasks?project=eq.${encodeURIComponent(s)}&select=id&limit=1001`,
      null,
      await authHeaders(supa, 'GET'),
    );
    if (used.status !== 200 || !Array.isArray(used.body)) {
      return toolError(pgError(used, 'delete_project failed (task count)'));
    }
    count = used.body.length;
  } catch (err) {
    return toolError(`could not reach Supabase: ${err.message}`);
  }
  if (count > 0) {
    const n = count > 1000 ? '1000+' : String(count);
    return toolError(
      `delete_project rejected: project "${s}" has ${n} task(s) attached — deleting it would orphan them. ` +
      'Move those tasks to another project first (update_task project=...), then delete.',
    );
  }
  if (!row) {
    return toolError(
      `no project registered with slug "${s}" (and no tasks use it) — nothing to delete. ` +
      'The board dropdown derives from tasks; an empty label disappears by itself.',
    );
  }

  let del;
  try {
    del = await restRequest(supa, 'DELETE', `/rest/v1/projects?slug=eq.${encodeURIComponent(s)}`, null, {
      prefer: 'return=representation',
      ...(await authHeaders(supa, 'DELETE')),
    });
  } catch (err) {
    return toolError(`could not reach Supabase: ${err.message}`);
  }
  if (del.status !== 200 && del.status !== 204) {
    return toolError(`delete_project failed: ${pgError(del, 'delete_project failed')}`);
  }
  const deleted = Array.isArray(del.body) && del.body[0] ? del.body[0] : row;
  return toolOk(
    `Project "${s}" deleted (it had 0 tasks). It disappears from the registry instantly.\n` +
    `Undo: create_project name="${deleted.name || s}" slug="${s}"` +
    `${deleted.description ? ` description="${deleted.description}"` : ''}\n` +
    `Deleted row (for the record): ${JSON.stringify(deleted)}`,
  );
}

// ── tool registry ──────────────────────────────────────────────────────────────

// BOARD-IMG-7 — `attachments` parametresinin TEK tanımı (create/update/attach üçü
// de bunu paylaşır; üç kopya = üç ayrı sözleşme demek olurdu).
const ATTACHMENTS_SCHEMA = Object.freeze({
  type: 'array',
  description:
    'Bu göreve iliştirilecek görseller (kanıt ekran görüntüsü / referans). Her öğe BU MAKİNEDE '
    + 'var olan bir dosya YOLUDUR — baytlar ek deposuna kopyalanır, kart board ızgarasında '
    + 'kapakla görünür. cover:true olan (yoksa ilk öğe) kart kapağı olur. '
    + 'GİZLİLİK: müşteri adı / telefon / sipariş no içeren bir görseli iliştirmeden ÖNCE '
    + 'o bölgeyi bulanıklaştır — ekran görüntüsü metinden daha çok sızdırır ve grep\'lenemez.',
  items: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Mutlak dosya yolu (png/jpeg/webp/gif, ≤25 MB). Tür UZANTIDAN değil dosya içeriğinden doğrulanır.' },
      title: { type: 'string', description: 'Kısa etiket (galeri altyazısı). Boşsa dosya adı kullanılır.' },
      cover: { type: 'boolean', description: 'Izgara kartında kapak olsun mu (görev başına bir tane).' },
      kind: { type: 'string', enum: ['screenshot', 'evidence', 'reference', 'other'], description: 'Ek türü (varsayılan screenshot).' },
    },
    required: ['path'],
  },
});

const TOOLS = [
  {
    name: 'list_tasks',
    description:
      'List tasks from the office Task Board (most-recently-updated first). Optional filters: status, ' +
      'sprint, project, assignee (agent id), limit (default 20, max 100).',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: TASK_STATUSES, description: 'Filter by status.' },
        sprint: { type: 'string', description: 'Filter by sprint slug.' },
        project: { type: 'string', description: 'Filter by project slug.' },
        assignee: { type: 'string', description: 'Filter by assigned agent id.' },
        limit: { type: 'number', description: 'Max rows (default 20, max 100).' },
      },
    },
    run: runList,
  },
  {
    name: 'create_task',
    description:
      'Open a NEW task on the board. It appears on the office Task Board instantly (realtime). ' +
      'Required: title. Optional: description, assignee (an existing agent id), project (slug; defaults to your ' +
      "department), sprint (slug), status (one of backlog/todo/in_progress/review/done; default backlog), priority.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title.' },
        description: { type: 'string', description: 'Longer description / spec.' },
        assignee: {
          type: 'string',
          description:
            'Agent id to assign — must be an existing agent ON YOUR TEAM. Cross-team assignment needs '
            + 'an owner grant (same rule and same refusal as delegation).',
        },
        project: {
          type: 'string',
          description:
            'Project slug — USUALLY OMIT IT (defaults to your team/department). An unknown slug is '
            + 'REJECTED; it never silently creates a new board group. Register a truly new project '
            + 'with create_project first.',
        },
        sprint: { type: 'string', description: 'Sprint slug (e.g. SPRINT-AD-23; normalized to UPPERCASE).' },
        status: { type: 'string', enum: TASK_STATUSES, description: 'Initial status (default backlog).' },
        priority: { type: 'number', description: 'Priority (lower = higher; default 5).' },
        attachments: ATTACHMENTS_SCHEMA,
      },
      required: ['title'],
    },
    run: runCreate,
  },
  {
    name: 'update_task',
    description:
      'Update an EXISTING task by id — typically its status (backlog→todo→in_progress→review→done) or assignee. ' +
      'Change reflects on the board instantly. Pass `id` plus any of: status, assignee, title, description, sprint, project, priority.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task id to update.' },
        status: { type: 'string', enum: TASK_STATUSES, description: 'New status.' },
        assignee: { type: 'string', description: 'New assignee agent id (empty string to unassign).' },
        title: { type: 'string', description: 'New title.' },
        description: { type: 'string', description: 'New description.' },
        sprint: { type: 'string', description: 'New sprint slug (empty string to clear; normalized to UPPERCASE).' },
        project: { type: 'string', description: 'New project slug.' },
        priority: { type: 'number', description: 'New priority.' },
        merge_state: {
          type: 'string',
          enum: [...mergePolicy.STATES],
          description:
            'B-01 git backbone: merge state. Only VALID transitions are accepted (e.g. none→merged is rejected); '
            + 'isolated→review is how an agent signals "my work is done, please review".',
        },
        branch: { type: 'string', description: 'B-01: the task branch (task/<code>, lowercase).' },
        attachments: ATTACHMENTS_SCHEMA,
      },
      required: ['id'],
    },
    run: runUpdate,
  },
  {
    name: 'attach_to_task',
    description:
      'Attach IMAGES to an EXISTING task (evidence screenshot / reference). Paths must exist ON THIS '
      + 'MACHINE — the bytes are copied into the attachment store and the card updates instantly '
      + '(realtime). Use this instead of update_task when you only want to add evidence: no other '
      + 'field can be overwritten by accident. Requires the CrewPane app to be running (the '
      + 'thumbnail and the store live there). PRIVACY: blur customer names/phone numbers BEFORE attaching.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task id to attach to.' },
        attachments: ATTACHMENTS_SCHEMA,
        set_cover: { type: 'string', description: 'An EXISTING attachment id to make the card cover (no upload).' },
      },
      required: ['id'],
    },
    run: runAttach,
  },
  {
    name: 'create_project',
    description:
      'Register a new PROJECT (a tasks.project value). Required: name. Optional: slug (defaults to a normalized name), ' +
      'description, isolation (worktree|off — NEW projects default to worktree), default_branch (dev), ' +
      'merge_approval (boss|leader|auto). New tasks reference it by slug.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name.' },
        slug: { type: 'string', description: 'Project slug (optional; defaults to a normalized name).' },
        description: { type: 'string', description: 'Optional description.' },
        isolation: {
          type: 'string',
          enum: ['worktree', 'off'],
          description: 'Task isolation (B-01). worktree = every task runs in its own git worktree on task/<code>. Default: worktree.',
        },
        default_branch: {
          type: 'string',
          description: 'Merge target for finished tasks (default: dev). "main" is never chosen automatically.',
        },
        merge_approval: {
          type: 'string',
          enum: ['boss', 'leader', 'auto'],
          description: 'Who approves a merge (default: boss). leader/auto only apply while autopilot runs.',
        },
      },
      required: ['name'],
    },
    run: runCreateProject,
  },
  {
    name: 'delete_project',
    description:
      'Delete an EMPTY project from the registry (a tasks.project value with no tasks attached). ' +
      'A project that still has tasks is NOT deleted — the reply says how many tasks block it. ' +
      'The reply echoes the deleted row, so the action is reversible via create_project.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Project slug to delete (must have 0 tasks).' },
      },
      required: ['slug'],
    },
    run: runDeleteProject,
  },
  {
    name: 'create_sprint',
    description:
      'Register a new SPRINT (a tasks.sprint value). Required: name. Optional: slug (defaults to a normalized name), ' +
      'description, status (default active). The board groups tasks by sprint.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Sprint name (e.g. SPRINT-AD-24).' },
        slug: { type: 'string', description: 'Sprint slug (optional; defaults to the name, normalized to UPPERCASE).' },
        description: { type: 'string', description: 'Optional description.' },
        status: { type: 'string', description: 'Sprint status (default active).' },
      },
      required: ['name'],
    },
    run: runCreateSprint,
  },
];

// ── JSON-RPC stdio loop (mirrors the delegate/browser MCPs) ───────────────────
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function handle(msg) {
  const { id, method, params } = msg || {};
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return;
  }
  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) },
    });
    return;
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      send({ jsonrpc: '2.0', id, result: toolError(`unknown tool: ${name}`) });
      return;
    }
    try {
      const result = await tool.run(args);
      send({ jsonrpc: '2.0', id, result });
    } catch (err) {
      logErr(`tool ${name} threw: ${err.message}`);
      send({ jsonrpc: '2.0', id, result: toolError(`tool error: ${err.message}`) });
    }
    return;
  }
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

function main() {
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        logErr('bad JSON line ignored');
        continue;
      }
      void handle(parsed);
    }
  });
  process.stdin.on('end', () => process.exit(0));
  logErr('crewpane task MCP server ready (stdio)');
}

module.exports = {
  parseEnvFile,
  loadEnvLocal,
  resolveSupabase,
  restRequest,
  // ADP-622 — kimlik yolu (test dikişleri): jeton önbelleği modül-içi olduğu için
  // testler arasında sıfırlanabilmeli.
  appDbAccessToken,
  authHeaders,
  // TASKDB-RLS-01 — kiracı önbelleği de sıfırlanır; aksi hâlde bir testin çözdüğü
  // company bir sonrakine SIZAR ve testler birbirinin kurgusunu ölçer.
  _resetTokenCache: () => {
    _tokenCache = null; _tokenInFlight = null; _negativeUntilMs = 0;
    _companyCache = null; _companyInFlight = null;
    _identityMismatch = null; // BOARD-AUTH-01 — teşhis de süreç-ömürlü değil, koşu-ömürlü
  },
  // BOARD-AUTH-01 — test dikişleri (saf fonksiyonlar; ölçüm için dışa açılır).
  _tokenIssuerOrigin: tokenIssuerOrigin,
  _identityMatchesTarget: identityMatchesTarget,
  _pgError: pgError,
  slugify,
  normalizeSprintSlug,
  genTaskId,
  selfAgentId,
  TASK_STATUSES,
  runList,
  runCreate,
  runUpdate,
  runCreateProject,
  runCreateSprint,
  // TEAM-SCOPE-01 — proje silme + takım sınırı / proje nöbeti (test dikişleri)
  runDeleteProject,
  assigneeTeamGate,
  validateExplicitProject,
  _setTeamPolicyForTest,
  // BOARD-IMG-7 — ek yolu (test dikişleri)
  runAttach,
  attachToTask,
  normalizeAttachments,
  describeSkip,
  ATTACH_MAX,
  TOOLS,
};
if (require.main === module) main();
