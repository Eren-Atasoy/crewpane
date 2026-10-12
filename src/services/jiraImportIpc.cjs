// JIRA-IMPORT-01 — "Masaya al" IPC çekirdeği (Electron'suz; main.js yalnız kanalları bağlar).
//
// Akış (renderer ↔ main):
//   1. status    → Jira bağlı mı (kasada kayıt + site/e-posta)? Düğme yalnız bağlıyken çizilir.
//   2. projects  → bağlı hesabın Jira projeleri + her birinin hatırlanan AgentSpace projesi.
//   3. issues    → seçilen projenin AÇIK sprint ticket'ları (gövdesiz).
//   4. prepare   → seçilenler: gövde Jira'dan TAZE okunur ve YEREL deftere yazılır, dal adı
//                  türetilir, proje klasörü bir git deposuysa dal ref'i açılır. Renderer'a
//                  gövdesiz kart verisi döner (görev kimliği + başlık + anahtar + bağlantı + dal).
//   5. (renderer bulut satırını yazar — tekillik indeksi yarışı keser)
//   6. finish    → yazılamayanlar geri alınır (defter + gövde + açılan dal), yazılanlar sayılır:
//                  `ticket_imported{count}`.
//   7. ticket    → kart detayı / ajanın kart okuması için yerel gövde.
//
// 🔴 Anahtar kasadan yalnız burada çözülür, renderer'a hiçbir dönüşte yoktur. Gövde ve anahtar
// LOGA YAZILMAZ: log satırları sayı + HTTP kodu + sonuç taşır.

'use strict';

const J = require('./jiraImport.cjs');
const branchName = require('../config/branchName.cjs');

/** Renderer'a gidecek sade hata kodları (cümleyi renderer kendi dilinde kurar). */
const CAUSES = new Set(['not-connected', 'auth', 'site', 'forbidden', 'rate-limit', 'server', 'timeout',
  'network', 'bad-response', 'query', 'invalid-input', 'no-account', 'error']);
const fail = (cause, extra = {}) => ({ ok: false, cause: CAUSES.has(cause) ? cause : 'error', ...extra });

/**
 * LINEAR-OAUTH-01 — KAYNAK BAĞDAŞTIRICISI. Akış (eşleme, yerel defter, dal, geri alma) tek; kaynak
 * yalnız "nasıl sorulur"u söyler. Şekil:
 *   { id, creds() → c|null, siteOf?(c) → ekrandaki ad (ağsız),
 *     projects(c) → {ok, projects, site, siteLabel}, issues(c, key) → {ok, issues, truncated, site, siteLabel, mode},
 *     withBody(c, keys) → {ok, issues:[{…, body}], missing, site}, branchName(key, summary) }
 * `site` yerel defterin anahtarıdır (Jira: site etiketi · Linear: `linear:<çalışma alanı>`).
 */
function jiraSource(deps) {
  const jiraDeps = deps.jiraDeps || {};
  const label = (c) => `${c.site}.atlassian.net`;
  const withSite = (c, r) => (r.ok ? { ...r, site: c.site, siteLabel: label(c) } : r);
  return {
    id: 'jira',
    async creds() {
      let resolved = null;
      try { resolved = await deps.resolveCreds(); } catch { resolved = null; }
      return J.credsFrom(resolved);
    },
    siteOf: label,
    projects: async (c) => withSite(c, await J.listProjects(c, jiraDeps)),
    issues: async (c, key) => withSite(c, await J.listSprintIssues(c, key, jiraDeps)),
    withBody: async (c, keys) => withSite(c, await J.fetchIssuesWithBody(c, keys, jiraDeps)),
    branchName: J.jiraBranchName,
  };
}

/**
 * @param {{
 *   resolveCreds: () => Promise<{secret:string,userFields:object}|null>,
 *   sources?: Record<string, object>,                            // LINEAR-OAUTH-01 — ek kaynaklar (linear)
 *   store: ReturnType<typeof J.createTicketStore>,
 *   jiraDeps?: object,
 *   resolveRepo?: (projectSlug:string) => string|null,        // proje klasörü (git) ya da null
 *   git?: { branchExists:Function, resolveBase:Function, run:(repo:string,args:string[])=>Promise<{ok:boolean,stdout:string}> },
 *   defaultBranchFor?: (projectSlug:string) => string,
 *   track?: (event:string, props:object) => void,
 *   log?: (line:string) => void,
 *   now?: () => number,
 * }} deps
 */
function createJiraImportIpc(deps) {
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const now = deps.now || Date.now;
  const store = deps.store;
  const sources = { jira: jiraSource(deps), ...(deps.sources || {}) };
  /** Girdideki kaynak; yoksa Jira (eski çağıranlar aynen çalışır). Bilinmeyen kaynak → null. */
  const sourceOf = (input) => {
    const id = input && typeof input.source === 'string' ? input.source : 'jira';
    return Object.prototype.hasOwnProperty.call(sources, id) ? sources[id] : null;
  };

  /**
   * Dal ref'ini aç (yalnız proje klasörü bir git deposuysa). Var olan dal EZİLMEZ: varsa
   * sonek denenir (`-2`…`-10`, worktreeService ile aynı tavan).
   * → { branch, created:boolean, baseSha|null, note? }
   */
  async function openBranch(project, wanted) {
    const repo = typeof deps.resolveRepo === 'function' ? deps.resolveRepo(project) : null;
    if (!repo || !deps.git) return { branch: wanted, created: false, baseSha: null, note: 'no-repo' };
    for (let i = 1; i <= branchName.MAX_SUFFIX; i++) {
      const name = i === 1 ? wanted : `${wanted}-${i}`;
      if (!branchName.validateBranchName(name).ok) break;
      // eslint-disable-next-line no-await-in-loop
      if (await deps.git.branchExists(repo, name)) continue;
      const def = typeof deps.defaultBranchFor === 'function' ? deps.defaultBranchFor(project) : 'dev';
      // eslint-disable-next-line no-await-in-loop
      const base = await deps.git.resolveBase(repo, def);
      if (!base || !base.sha) return { branch: name, created: false, baseSha: null, note: 'no-base' };
      // Ad politikadan geçti (harfle başlar → bayrak sanılamaz); `--no-track` yerel dal.
      // eslint-disable-next-line no-await-in-loop
      const res = await deps.git.run(repo, ['branch', '--no-track', name, base.sha]);
      if (!res.ok) return { branch: name, created: false, baseSha: null, note: 'git-failed' };
      return { branch: name, created: true, baseSha: base.sha, baseRef: base.ref };
    }
    return { branch: wanted, created: false, baseSha: null, note: 'taken' };
  }

  /** Geri alma: dal yalnız HİÇ commit almadıysa (ucu açıldığı taban) silinir. */
  async function dropBranch(rec) {
    if (!rec || !rec.branchCreated || !rec.baseSha || !deps.git) return false;
    const repo = typeof deps.resolveRepo === 'function' ? deps.resolveRepo(rec.project) : null;
    if (!repo || !branchName.validateBranchName(rec.branch).ok) return false;
    const tip = await deps.git.run(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${rec.branch}^{commit}`]);
    if (!tip.ok || tip.stdout.trim() !== rec.baseSha) return false;
    const del = await deps.git.run(repo, ['branch', '-D', rec.branch]);
    return del.ok;
  }

  return {
    async status(input) {
      const src = sourceOf(input);
      if (!src) return { ok: true, connected: false, site: null };
      // Ağsız soru varsa o (Linear: jeton yenilemeye gitmeden "izin ya da anahtar var mı").
      if (typeof src.connected === 'function') return { ok: true, connected: await src.connected(), site: null };
      const c = await src.creds();
      if (!c) return { ok: true, connected: false, site: null };
      return { ok: true, connected: true, site: typeof src.siteOf === 'function' ? src.siteOf(c) : null };
    },

    async projects(input) {
      const src = sourceOf(input);
      if (!src) return fail('invalid-input');
      const c = await src.creds();
      if (!c) return fail('not-connected');
      const r = await src.projects(c);
      log(`${src.id}-import projects ok=${r.ok} status=${r.status ?? '-'} n=${r.ok ? r.projects.length : 0}`);
      if (!r.ok) return fail(r.cause);
      return {
        ok: true,
        site: r.siteLabel,
        projects: r.projects.map((p) => ({ ...p, mappedTo: store.getMapping(r.site, p.key) })),
      };
    },

    async issues(input) {
      const src = sourceOf(input);
      const projectKey = input && typeof input.projectKey === 'string' ? input.projectKey : '';
      if (!src || !J.PROJECT_KEY_RE.test(projectKey)) return fail('invalid-input');
      const c = await src.creds();
      if (!c) return fail('not-connected');
      const r = await src.issues(c, projectKey);
      log(`${src.id}-import issues ok=${r.ok} status=${r.status ?? '-'} n=${r.ok ? r.issues.length : 0}`);
      if (!r.ok) return fail(r.cause);
      return {
        ok: true,
        projectKey,
        mappedTo: store.getMapping(r.site, projectKey),
        truncated: !!r.truncated,
        mode: r.mode || 'sprint',
        // Bu bilgisayarda daha önce alınanlar işaretlenir (bulut tekilliği asıl kapı).
        issues: r.issues.map((i) => ({ ...i, importedTaskId: store.taskIdForKey(r.site, i.key) })),
      };
    },

    /**
     * @param {{source?:string, projectKey:string, keys:string[], project:string}} input
     * → { ok, items:[{taskId,key,summary,url,branch,branchCreated}], missing:[], skipped:[] }
     */
    async prepare(input) {
      const src = sourceOf(input);
      if (!src) return fail('invalid-input');
      const projectKey = input && typeof input.projectKey === 'string' ? input.projectKey : '';
      const project = input && typeof input.project === 'string' ? input.project.trim().toLowerCase() : '';
      const keys = Array.isArray(input && input.keys) ? input.keys.filter((k) => typeof k === 'string') : [];
      if (!J.PROJECT_KEY_RE.test(projectKey) || !J.PROJECT_SLUG_RE.test(project) || !keys.length || keys.length > J.MAX_IMPORT) {
        return fail('invalid-input');
      }
      if (keys.some((k) => !J.ISSUE_KEY_RE.test(k) || !k.startsWith(`${projectKey}-`))) return fail('invalid-input');
      if (!store.available()) return fail('no-account');
      const c = await src.creds();
      if (!c) return fail('not-connected');

      const r = await src.withBody(c, keys);
      if (!r.ok) {
        log(`${src.id}-import prepare ok=false status=${r.status ?? '-'} cause=${r.cause}`);
        return fail(r.cause);
      }
      const site = r.site;
      // Eşleme: ilk alımda seçilen proje hatırlanır; sonraki alımda sorulmaz.
      if (store.getMapping(site, projectKey) !== project) store.setMapping(site, projectKey, project);
      const items = [];
      const skipped = [];
      let t = now();
      for (const issue of r.issues) {
        const already = store.taskIdForKey(site, issue.key);
        if (already) { skipped.push({ key: issue.key, taskId: already }); continue; }
        const wanted = src.branchName(issue.key, issue.summary);
        if (!wanted) { skipped.push({ key: issue.key, taskId: null }); continue; }
        // eslint-disable-next-line no-await-in-loop
        const br = await openBranch(project, wanted);
        const taskId = J.newTaskId(t++);
        const rec = {
          source: src.id, key: issue.key, site, project, branch: br.branch, url: issue.url, summary: issue.summary,
          branchCreated: br.created, baseSha: br.baseSha,
        };
        store.put(taskId, rec, issue.body);
        items.push({ taskId, key: issue.key, summary: issue.summary, url: issue.url, branch: br.branch, branchCreated: br.created, type: issue.type });
      }
      log(`${src.id}-import prepare ok=true n=${items.length} atlanan=${skipped.length} eksik=${r.missing.length} dal=${items.filter((i) => i.branchCreated).length}`);
      return { ok: true, items, missing: r.missing, skipped };
    },

    /**
     * Bulut yazımından sonra: yazılamayanları geri al, yazılanları say.
     * @param {{imported:string[], failed:string[]}} input
     */
    async finish(input) {
      const imported = (Array.isArray(input && input.imported) ? input.imported : []).filter((id) => store.get(id));
      const failed = (Array.isArray(input && input.failed) ? input.failed : []).filter((id) => J.TASK_ID_RE.test(String(id)));
      let dropped = 0;
      for (const id of failed) {
        const rec = store.get(id);
        // eslint-disable-next-line no-await-in-loop
        if (rec && await dropBranch(rec)) dropped++;
        store.remove(id);
      }
      if (imported.length && typeof deps.track === 'function') {
        try { deps.track('ticket_imported', { count: Math.min(imported.length, J.MAX_IMPORT) }); } catch { /* analitik akışı bozmaz */ }
      }
      log(`jira-import finish alınan=${imported.length} geri-alınan=${failed.length} silinen-dal=${dropped}`);
      return { ok: true, imported: imported.length, reverted: failed.length };
    },

    /** Kart detayı / ajanın kart okuması: yerel gövde. Bu bilgisayarda değilse `local:false`. */
    ticket(input) {
      const taskId = input && typeof input.taskId === 'string' ? input.taskId : '';
      if (!J.TASK_ID_RE.test(taskId)) return fail('invalid-input');
      const rec = store.get(taskId);
      if (!rec) return { ok: true, local: false };
      return { ok: true, local: true, source: rec.source || 'jira', key: rec.key, url: rec.url, branch: rec.branch, project: rec.project, body: store.body(taskId) || '' };
    },

    /** worktreeService için: bu görevin Jira dalı (yalnız politikaya uyan). */
    branchFor(taskId) {
      const rec = J.TASK_ID_RE.test(String(taskId || '')) ? store.get(taskId) : null;
      return rec && branchName.JIRA_BRANCH_RE.test(String(rec.branch || '')) ? rec.branch : null;
    },
  };
}

module.exports = { createJiraImportIpc };
