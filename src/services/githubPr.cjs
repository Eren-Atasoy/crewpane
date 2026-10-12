// PR-GITHUB-F3 — GitHub REST istemcisi (ANA SÜREÇ): PR aç (taslak → hazır), dal var mı, durum yoklaması.
//
// Neden ajanın MCP'si değil: katalogdaki GitHub MCP paketi deprecated (integrationCatalog.cjs) ve PR'ı
// ajanın değil KULLANICININ açması gerekiyor. Jeton kasadan (credentialVault) YALNIZ ana süreçte çözülür
// ve bu modüle parametre olarak girer; dönüşte, hata metninde ve log satırında YOK. Hata cümleleri bu
// modülün KENDİ cümleleridir: GitHub'ın gövdesi kullanıcıya aktarılmaz (yalnız sınıflandırma için okunur).
// Cümleler ana süreç sözlüğünden (`main.github.*`) arayüz dilinde gelir (REVIEW-MAIN-I18N-01).
//
// Yoklama ETag'li koşullu istekle yapılır: değişmemiş kaynak 304 döner ve GitHub'ın istek sınırından
// DÜŞMEZ (docs.github.com "conditional requests"). Bu yüzden açık PR'ı dakikada bir yoklamak bedava.
//
// Saf + DI (`fetch` enjekte) → `node --test` ile koşar, Electron bağı yok.

'use strict';

const appI18n = require('../../i18n/index.cjs');

const t = (k, p) => appI18n.t(k, p);
const DEFAULT_BASE = 'https://api.github.com';
const DEFAULT_TIMEOUT_MS = 15000;
const API_VERSION = '2022-11-28';

// GitHub kullanıcı/kurum adı: harf-rakam ve tire, 1-39; depo adı: harf-rakam . _ -, 1-100.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * "sahip/depo" kısa adını doğrular ya da GitHub adresinden çıkarır.
 * Kabul: `acme/app`, `https://github.com/acme/app(.git)`, `git@github.com:acme/app.git`,
 * `ssh://git@github.com/acme/app.git`. Başka alan adı, `..`, eksik parça → null.
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeSlug(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s || s.length > 300) return null;
  const scp = /^[A-Za-z0-9._-]+@github\.com:(.+)$/i.exec(s); // git@github.com:acme/app.git
  if (scp) s = scp[1];
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    let u;
    try { u = new URL(s); } catch { return null; }
    if (u.hostname.toLowerCase() !== 'github.com' && u.hostname.toLowerCase() !== 'www.github.com') return null;
    s = u.pathname;
  } else if (/^[/.~\\]/.test(s) || /^[A-Za-z]:/.test(s)) {
    return null; // yerel yol (/tmp/x.git, ./x, C:\x) — GitHub deposu değil
  }
  s = s.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  const parts = s.split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === '.' || repo === '..') return null;
  return `${owner}/${repo}`;
}

/** Git dal adı olarak güvenli mi (seçenek enjeksiyonu yok, boşluk/kontrol karakteri yok). */
function safeBranch(b) {
  return typeof b === 'string'
    && b.length > 0 && b.length <= 250
    && !b.startsWith('-')
    // eslint-disable-next-line no-control-regex
    && !/[\s\u0000-\u001F\u007F~^:?*[\\]/.test(b)
    && !b.includes('..') && !b.endsWith('.lock') && !b.endsWith('/') && !b.endsWith('.');
}

/** "pull_requests=write" → kullanıcının GitHub'da gördüğü izin adı (ince taneli anahtar). */
const PERMISSION_LABEL = {
  pull_requests: { read: 'Pull requests: Read', write: 'Pull requests: Read and write' },
  contents: { read: 'Contents: Read', write: 'Contents: Read and write' },
  metadata: { read: 'Metadata: Read', write: 'Metadata: Read' },
};
function permissionLabel(header) {
  const first = String(header || '').split(',')[0].trim(); // "pull_requests=write; contents=read" gibi de gelebilir
  const m = /^([a-z_]+)=([a-z]+)/.exec(first.split(';')[0].trim());
  if (!m) return null;
  const row = PERMISSION_LABEL[m[1]];
  return (row && row[m[2]]) || `${m[1]}: ${m[2]}`;
}

function header(res, name) {
  try { return (res && res.headers && typeof res.headers.get === 'function' && res.headers.get(name)) || null; } catch { return null; }
}

/**
 * GitHub cevabını SADE bir sınıfa çevirir. Mesaj bu modülün cümlesidir; GitHub'ın gövdesi yalnız
 * sınıflandırmak için okunur, kullanıcıya taşınmaz.
 * → { code, why, permission?, resetAt? }
 */
function classifyFailure(status, res, body) {
  const msg = String((body && body.message) || '');
  const errs = Array.isArray(body && body.errors) ? body.errors : [];
  const errText = errs.map((e) => `${e && e.field ? e.field : ''} ${e && e.code ? e.code : ''} ${e && e.message ? e.message : ''}`).join(' | ');
  if (status === 401) return { code: 'auth', why: t('main.github.err.auth') };
  const remaining = header(res, 'x-ratelimit-remaining');
  if (status === 429 || (status === 403 && remaining === '0')) {
    const reset = Number(header(res, 'x-ratelimit-reset'));
    const resetAt = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null;
    return { code: 'rate-limit', why: t('main.github.err.rateLimit'), resetAt };
  }
  if (status === 403) {
    const perm = permissionLabel(header(res, 'x-accepted-github-permissions'));
    if (perm) return { code: 'permission', permission: perm, why: t('main.github.err.permission', { permission: perm }) };
    return { code: 'forbidden', why: t('main.github.err.forbidden') };
  }
  if (status === 404) return { code: 'not-found', why: t('main.github.err.notFound') };
  if (status === 422) {
    if (/pull request already exists/i.test(`${msg} ${errText}`)) return { code: 'exists', why: t('main.github.err.exists') };
    if (/draft/i.test(`${msg} ${errText}`)) return { code: 'draft-unsupported', why: t('main.github.err.draftUnsupported') };
    if (/no commits between/i.test(`${msg} ${errText}`)) return { code: 'no-diff', why: t('main.github.err.noDiff') };
    if (/\bhead\b/i.test(errText) || /\bbase\b/i.test(errText)) return { code: 'branch-missing', why: t('main.github.err.branchOrBaseMissing') };
    return { code: 'invalid', why: t('main.github.err.invalid') };
  }
  if (status >= 500) return { code: 'server', why: t('main.github.err.server') };
  return { code: 'error', why: t('main.github.err.failed') };
}

/**
 * PR'ın panodaki durumu: merged > closed > draft > approved > open.
 * Onay: her inceleyenin SON hükmü (yorum sayılmaz); en az bir onay ve hiç "değişiklik istendi" yoksa.
 * @param {{state?:string, merged?:boolean, merged_at?:string|null, draft?:boolean}} pull
 * @param {Array<{user?:{login?:string}, state?:string}>} [reviews]
 * @returns {'merged'|'closed'|'draft'|'approved'|'open'}
 */
function prState(pull, reviews) {
  if (!pull || typeof pull !== 'object') return 'open';
  if (pull.merged === true || pull.merged_at) return 'merged';
  if (pull.state === 'closed') return 'closed';
  if (pull.draft === true) return 'draft';
  const last = new Map();
  for (const r of Array.isArray(reviews) ? reviews : []) {
    const who = r && r.user && r.user.login;
    const st = r && r.state;
    if (!who || (st !== 'APPROVED' && st !== 'CHANGES_REQUESTED' && st !== 'DISMISSED')) continue;
    last.set(who, st);
  }
  const verdicts = [...last.values()];
  if (verdicts.includes('APPROVED') && !verdicts.includes('CHANGES_REQUESTED')) return 'approved';
  return 'open';
}

/**
 * @param {{token:string, fetch?:Function, baseUrl?:string, timeoutMs?:number}} opts
 */
function createGithubClient(opts = {}) {
  const token = typeof opts.token === 'string' ? opts.token.trim() : '';
  const fetchFn = opts.fetch || globalThis.fetch;
  const base = String(opts.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

  /** → { ok, status, json, etag, notModified, res } | { ok:false, status:null, code:'timeout'|'network' } */
  async function request(method, path, { body, etag } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'AgentSpace',
      Authorization: `Bearer ${token}`,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (etag) headers['If-None-Match'] = etag;
    let res;
    try {
      res = await fetchFn(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        // Yönlendirme İZLENMEZ: Authorization başlığı başka bir adrese taşınmasın.
        redirect: 'manual',
        signal: ctrl.signal,
      });
    } catch (err) {
      const aborted = ctrl.signal.aborted || (err && err.name === 'AbortError');
      return aborted
        ? { ok: false, status: null, code: 'timeout', why: t('main.github.err.timeout') }
        : { ok: false, status: null, code: 'network', why: t('main.github.err.network') };
    } finally {
      clearTimeout(timer);
    }
    const status = res.status;
    const newEtag = header(res, 'etag');
    if (status === 304) return { ok: true, status, json: null, etag: etag || newEtag, notModified: true, res };
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    if (status >= 200 && status < 300) return { ok: true, status, json, etag: newEtag, notModified: false, res };
    return { ok: false, status, json, res, ...classifyFailure(status, res, json) };
  }

  const repoPath = (slug) => `/repos/${slug.split('/').map(encodeURIComponent).join('/')}`;

  return {
    /** Dal GitHub'da var mı → { ok, exists } | hata. */
    async branchExists(slug, branch) {
      const r = await request('GET', `${repoPath(slug)}/branches/${encodeURIComponent(branch)}`);
      if (r.ok) return { ok: true, exists: true };
      if (r.status === 404) {
        // Depo yok mu dal mı yok? Depo okunabiliyorsa dal yoktur.
        const repo = await request('GET', repoPath(slug));
        if (repo.ok) return { ok: true, exists: false };
        return repo;
      }
      return r;
    },

    /** POST /pulls → { ok, number, url, nodeId, state } | hata (code: exists/draft-unsupported/…). */
    async createPull({ slug, head, base: target, title, body, draft }) {
      const r = await request('POST', `${repoPath(slug)}/pulls`, { body: { title, body, head, base: target, draft: draft === true } });
      if (!r.ok) return r;
      const p = r.json || {};
      return { ok: true, number: p.number, url: p.html_url, nodeId: p.node_id || null, state: prState(p, []) };
    },

    /** Bu dal için AÇIK PR (yoksa null). `head` = "sahip:dal". */
    async findOpenPull(slug, branch) {
      const owner = slug.split('/')[0];
      const r = await request('GET', `${repoPath(slug)}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=5`);
      if (!r.ok) return r;
      const p = Array.isArray(r.json) ? r.json[0] : null;
      return { ok: true, pull: p ? { number: p.number, url: p.html_url, nodeId: p.node_id || null, state: prState(p, []) } : null };
    },

    /** Koşullu GET /pulls/{n} — `etag` verilirse değişmemişse 304 (`notModified`). */
    getPull(slug, number, etag) {
      return request('GET', `${repoPath(slug)}/pulls/${Number(number)}`, { etag });
    },

    /** Koşullu GET /pulls/{n}/reviews. */
    listReviews(slug, number, etag) {
      return request('GET', `${repoPath(slug)}/pulls/${Number(number)}/reviews?per_page=100`, { etag });
    },

    /** Taslak → hazır. REST'te yok; tek GraphQL mutasyonu (PR'ın node_id'si ile). */
    async markReady(nodeId) {
      const r = await request('POST', '/graphql', {
        body: { query: 'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}}', variables: { id: nodeId } },
      });
      if (!r.ok) return r;
      const errs = r.json && Array.isArray(r.json.errors) ? r.json.errors : [];
      if (errs.length) {
        const forbidden = errs.some((e) => /FORBIDDEN|not accessible/i.test(`${e && e.type} ${e && e.message}`));
        return forbidden
          ? { ok: false, status: 403, code: 'permission', permission: 'Pull requests: Read and write', why: t('main.github.err.permission', { permission: 'Pull requests: Read and write' }) }
          : { ok: false, status: 422, code: 'invalid', why: t('main.github.err.readyFailed') };
      }
      return { ok: true };
    },
  };
}

module.exports = {
  normalizeSlug,
  safeBranch,
  permissionLabel,
  classifyFailure,
  prState,
  createGithubClient,
  DEFAULT_BASE,
};
