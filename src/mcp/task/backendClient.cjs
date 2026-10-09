// CrewPane — Task Board Supabase REST & Auth Client (Phase 4.14)
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

const appDbIdentity = require('../../config/appDbIdentity.cjs');
const bridgeClient = require('../crewpane-delegate-mcp.cjs');
const publicBackendEnv = require('../../config/publicBackendEnv.cjs');

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
  const candidates = [path.join(__dirname, '..', '..', '.env.local'), path.join(process.cwd(), '.env.local')];
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
 * unconfigured.
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
 */
function boardUnavailableMessage() {
  let code = 'BOARD-CFG/unknown';
  try {
    code = publicBackendEnv.diagnosticCode(publicBackendEnv.resolvePublicBackend());
  } catch {
    /* teşhis kodu üretilemedi */
  }
  return (
    'Task board unavailable — the app could not reach its backend service. ' +
    'This is not a setting the user can fix; no account or database setup is required. ' +
    `Please ask the user to contact CrewPane support with diagnostic code: ${code}`
  );
}

// ── ADP-622 — AJANIN KİMLİĞİ (app DB'ye authenticated yazma) ──────────────────
let _tokenCache = null; // { token, expiresAt } | null
let _tokenInFlight = null;
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
        logErr('app DB kimliği yok (bridge bulunamadı — app kapalı?) → anon key ile devam');
        _tokenCache = null;
        _negativeUntilMs = Date.now() + NEGATIVE_TTL_MS;
        return null;
      }
      const res = await bridgeClient.bridgeRequestFailover(candidates, 'GET', '/app-db/token');
      const body = res && res.body;
      if (!body || !body.ok || typeof body.token !== 'string' || !body.token) {
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
    return null;
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
let _companyCache = null; // { id } | null
let _companyInFlight = null;

async function activeCompanyId(supa) {
  if (_companyCache) return _companyCache.id;
  if (_companyInFlight) return _companyInFlight;
  _companyInFlight = (async () => {
    try {
      const token = await appDbAccessToken();
      if (!token) return null;
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
/** Minimal JSON REST request to Supabase. Resolves { status, body, raw }. */
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
            /* non-JSON */
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

function bumpTasksCreated() {
  try {
    const candidates = bridgeClient.discoverBridgeCandidates();
    if (!candidates || !candidates.length) return;
    void bridgeClient
      .bridgeRequestFailover(candidates, 'POST', '/telemetry/bump', { key: 'tasks_created' })
      .catch(() => { /* fire-and-forget */ });
  } catch { /* fire-and-forget */ }
}

function _resetTokenCache() {
  _tokenCache = null;
  _tokenInFlight = null;
  _negativeUntilMs = 0;
  _companyCache = null;
  _companyInFlight = null;
  _identityMismatch = null;
}

module.exports = {
  logErr,
  parseEnvFile,
  loadEnvLocal,
  resolveSupabase,
  boardUnavailableMessage,
  appDbAccessToken,
  tokenIssuerOrigin,
  identityMatchesTarget,
  authHeaders,
  activeCompanyId,
  restRequest,
  pgError,
  bumpTasksCreated,
  _resetTokenCache,
};
