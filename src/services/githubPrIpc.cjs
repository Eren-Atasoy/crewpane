// PR-GITHUB-F3 — "GitHub'da PR aç" köprüsünün ANA SÜREÇ yarısı (status · open · sync · ready).
//
// Sınır kuralları (PR-INCELEME-F1b G-1 ile aynı duruş):
//   • Dal, hedef ve depo yolu ekrandan ALINMAZ: inceleme ekranının özeti ana süreçte çözüp
//     `resolveReview(taskId)`e koyar; burası yalnız görev kimliğini alır.
//   • Jeton kasadan YALNIZ burada çözülür (`resolveToken`) ve GitHub isteğinin başlığına girer;
//     hiçbir dönüşte, hata metninde ya da log satırında yoktur.
//   • Dal gönderimi (push) varsayılan KAPALI ve yalnız `push === true` ile olur (tasarım K5: pencere
//     her seferinde sorar). Gönderim kullanıcının KENDİ git kimliğiyle yapılır; jeton git'e verilmez
//     (komut satırına ya da ortama sır yazılmaz).
//   • Yoklama ETag'li: değişmemiş PR için GitHub 304 döner, istek sınırından düşmez.
//
// Saf + DI → `node --test` ile koşar (githubPrIpc.test.cjs).

'use strict';

const { normalizeSlug, safeBranch, prState, createGithubClient } = require('./githubPr.cjs');
const appI18n = require('../../i18n/index.cjs');

// Kullanıcıya dönen `why` cümleleri ana süreç sözlüğünden (`main.github.*`, REVIEW-MAIN-I18N-01).
const t = (k, p) => appI18n.t(k, p);

const PUSH_TIMEOUT_MS = 120000;
const TITLE_MAX = 256;
const BODY_MAX = 60000;

/** git stderr'inden kullanıcıya gösterilecek SADE cümle (adreste gömülü kimlik asla taşınmaz). */
function pushFailure(stderr) {
  const s = String(stderr || '');
  if (/non-fast-forward|fetch first|\[rejected\]/i.test(s)) {
    return { code: 'push-rejected', why: t('main.github.push.rejected') };
  }
  if (/authentication|could not read username|permission denied|403|401|terminal prompts disabled|access denied/i.test(s)) {
    return { code: 'push-auth', why: t('main.github.push.auth') };
  }
  if (/could not resolve host|unable to access|timed out|network/i.test(s)) {
    return { code: 'push-network', why: t('main.github.push.network') };
  }
  return { code: 'push-failed', why: t('main.github.push.failed') };
}

/** Adreste gömülü kimlik (https://kullanıcı:sır@…) log'a düşmesin. */
function redactUrl(s) {
  return String(s || '').replace(/(\/\/)[^@/\s]+@/g, '$1***@');
}

/**
 * @param {object} deps
 * @param {() => Promise<string|null>} deps.resolveToken - kasadaki GitHub anahtarı (yoksa null)
 * @param {() => Promise<boolean>} deps.hasConnection - GitHub bağlı mı (sırra dokunmadan)
 * @param {(taskId:string) => ({repo:string, branch:string, target:string}|null)} deps.resolveReview
 * @param {(cwd:string, args:string[], opts?:{timeout?:number}) => Promise<{ok:boolean, stdout:string, stderr:string}>} deps.git
 * @param {Function} [deps.fetch]
 * @param {string} [deps.baseUrl]
 * @param {(line:string)=>void} [deps.log]
 */
function createGithubPrIpc(deps) {
  const log = deps.log || (() => {});
  const git = deps.git;
  /** `slug#number` → { etag, reviewsEtag, pull, reviews, state, nodeId } — yalnız bellekte. */
  const cache = new Map();

  async function client() {
    let token = null;
    try { token = await deps.resolveToken(); } catch { token = null; }
    if (!token) return null;
    return createGithubClient({ token, fetch: deps.fetch, baseUrl: deps.baseUrl });
  }

  /** Deponun uzakları: { name, slug } (yalnız GitHub adresi olanlar; adres ekrana gitmez). */
  async function githubRemotes(repo) {
    const r = await git(repo, ['config', '--get-regexp', '^remote\\..*\\.url$']);
    if (!r.ok) return [];
    const out = [];
    for (const line of r.stdout.split('\n')) {
      const m = /^remote\.(.+)\.url\s+(.+)$/.exec(line.trim());
      if (!m) continue;
      const slug = normalizeSlug(m[2]);
      if (slug) out.push({ name: m[1], slug });
    }
    // origin önce
    return out.sort((a, b) => (a.name === 'origin' ? -1 : b.name === 'origin' ? 1 : 0));
  }

  function needReview(taskId) {
    const id = typeof taskId === 'string' ? taskId.trim() : '';
    const r = id ? deps.resolveReview(id) : null;
    if (!r || !safeBranch(r.branch) || !safeBranch(r.target)) return null;
    return r;
  }

  return {
    /**
     * İnceleme ekranının GitHub düğmesi için durum.
     * → { ok, connected, slug, slugSource:'project'|'remote'|null, branch, target, canPush }
     */
    async status(input = {}) {
      let connected = false;
      try { connected = await deps.hasConnection(); } catch { connected = false; }
      const r = needReview(input.taskId);
      if (!r) return { ok: false, code: 'no-summary', connected };
      const remotes = await githubRemotes(r.repo);
      const fromProject = normalizeSlug(input.slug);
      const slug = fromProject || (remotes[0] && remotes[0].slug) || null;
      return {
        ok: true,
        connected,
        slug,
        slugSource: fromProject ? 'project' : slug ? 'remote' : null,
        branch: r.branch,
        target: r.target,
        // Gönderim yalnız bu depoya giden bir uzak varsa mümkündür.
        canPush: !!slug && remotes.some((x) => x.slug.toLowerCase() === slug.toLowerCase()),
      };
    },

    /**
     * PR aç. → { ok, number, url, state, existed, pushed } | { ok:false, code, why, permission? }
     */
    async open(input = {}) {
      const r = needReview(input.taskId);
      if (!r) return { ok: false, code: 'no-summary', why: t('main.github.pr.noSummary') };
      const slug = normalizeSlug(input.slug);
      if (!slug) return { ok: false, code: 'bad-slug', why: t('main.github.pr.badSlug') };
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      if (!title || title.length > TITLE_MAX) return { ok: false, code: 'bad-title', why: t('main.github.pr.badTitle', { max: TITLE_MAX }) };
      const body = typeof input.body === 'string' ? input.body.slice(0, BODY_MAX) : '';
      const draft = input.draft === true;
      const push = input.push === true; // yalnız AÇIK onay
      const gh = await client();
      if (!gh) return { ok: false, code: 'not-connected', why: t('main.github.pr.notConnected') };

      let pushed = false;
      if (push) {
        const remote = (await githubRemotes(r.repo)).find((x) => x.slug.toLowerCase() === slug.toLowerCase());
        if (!remote) return { ok: false, code: 'no-remote', why: t('main.github.pr.noRemote', { slug }) };
        const ref = `refs/heads/${r.branch}`;
        const res = await git(r.repo, ['push', '--', remote.name, `${ref}:${ref}`], { timeout: PUSH_TIMEOUT_MS });
        if (!res.ok) {
          const f = pushFailure(res.stderr);
          log(`github:pr push REDDEDİLDİ dal=${r.branch} kod=${f.code} ${redactUrl(res.stderr).split('\n').slice(-2).join(' ').slice(0, 200)}`);
          return { ok: false, ...f };
        }
        pushed = true;
        log(`github:pr push OK dal=${r.branch} → ${remote.name}`);
      } else {
        const b = await gh.branchExists(slug, r.branch);
        if (!b.ok) return { ok: false, code: b.code, why: b.why, permission: b.permission };
        if (!b.exists) return { ok: false, code: 'branch-missing', why: t('main.github.pr.branchMissing') };
      }

      const c = await gh.createPull({ slug, head: r.branch, base: r.target, title, body, draft });
      if (c.ok) {
        log(`github:pr açıldı ${slug}#${c.number} taslak=${draft} gönderildi=${pushed}`);
        cache.delete(`${slug}#${c.number}`);
        return { ok: true, number: c.number, url: c.url, state: c.state, existed: false, pushed };
      }
      if (c.code === 'exists') {
        const f = await gh.findOpenPull(slug, r.branch);
        if (f.ok && f.pull) {
          log(`github:pr zaten açık ${slug}#${f.pull.number}`);
          return { ok: true, number: f.pull.number, url: f.pull.url, state: f.pull.state, existed: true, pushed };
        }
      }
      log(`github:pr REDDEDİLDİ ${slug} kod=${c.code} durum=${c.status}`);
      return { ok: false, code: c.code, why: c.why, permission: c.permission, pushed };
    },

    /**
     * Koşullu durum yoklaması. → { ok, state, url, notModified } | hata
     * İkisi de 304 dönerse GitHub'ın istek sınırından hiçbir şey düşmez.
     */
    async sync(input = {}) {
      const slug = normalizeSlug(input.slug);
      const number = Number(input.number);
      if (!slug || !Number.isInteger(number) || number <= 0) return { ok: false, code: 'bad-input', why: t('main.github.pr.missingInfo') };
      const gh = await client();
      if (!gh) return { ok: false, code: 'not-connected', why: t('main.github.pr.notConnected') };
      const key = `${slug}#${number}`;
      const prev = cache.get(key) || null;
      const p = await gh.getPull(slug, number, prev && prev.etag);
      if (!p.ok) return { ok: false, code: p.code, why: p.why, permission: p.permission };
      const pull = p.notModified && prev ? prev.pull : p.json;
      // Birleşmiş/kapalı PR'ın incelemesi durumu değiştirmez: ikinci istek atılmaz.
      let reviews = prev ? prev.reviews : [];
      let reviewsEtag = prev ? prev.reviewsEtag : null;
      let reviewsNotModified = true;
      const terminal = !!pull && (pull.merged === true || !!pull.merged_at || pull.state === 'closed');
      if (!terminal) {
        const rv = await gh.listReviews(slug, number, reviewsEtag);
        if (rv.ok) {
          reviewsNotModified = rv.notModified;
          if (!rv.notModified) reviews = Array.isArray(rv.json) ? rv.json.map((x) => ({ user: { login: x && x.user && x.user.login }, state: x && x.state })) : [];
          reviewsEtag = rv.etag || reviewsEtag;
        }
      }
      const slim = pull ? { state: pull.state, merged: pull.merged, merged_at: pull.merged_at, draft: pull.draft, html_url: pull.html_url, node_id: pull.node_id } : null;
      const state = prState(slim, reviews);
      cache.set(key, { etag: p.etag || (prev && prev.etag) || null, reviewsEtag, pull: slim, reviews, state });
      return { ok: true, state, url: (slim && slim.html_url) || `https://github.com/${slug}/pull/${number}`, notModified: !!p.notModified && reviewsNotModified };
    },

    /** Taslak PR'ı incelemeye hazır yap. → { ok, state } | hata */
    async ready(input = {}) {
      const slug = normalizeSlug(input.slug);
      const number = Number(input.number);
      if (!slug || !Number.isInteger(number) || number <= 0) return { ok: false, code: 'bad-input', why: t('main.github.pr.missingInfo') };
      const gh = await client();
      if (!gh) return { ok: false, code: 'not-connected', why: t('main.github.pr.notConnected') };
      const p = await gh.getPull(slug, number);
      if (!p.ok) return { ok: false, code: p.code, why: p.why, permission: p.permission };
      if (!p.json || !p.json.draft) return { ok: true, state: prState(p.json, []) };
      const m = await gh.markReady(p.json.node_id);
      if (!m.ok) return { ok: false, code: m.code, why: m.why, permission: m.permission };
      cache.delete(`${slug}#${number}`);
      log(`github:pr hazır ${slug}#${number}`);
      return { ok: true, state: 'open' };
    },
  };
}

module.exports = { createGithubPrIpc, pushFailure, redactUrl };
