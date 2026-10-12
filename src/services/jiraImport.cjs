// JIRA-IMPORT-01 — "Masaya al": Jira'nın açık sprintindeki ticket'lar → AgentSpace görev kartı.
//
// ## Bölüşüm (kim neyi bilir)
//
//   main (bu modül)  — Jira'ya konuşur (anahtar kasadan, yalnız burada), ticket GÖVDESİNİ yerel
//                       deftere yazar, dal adını türetir, proje eşlemesini hatırlar.
//   renderer         — listeyi gösterir, seçimi alır, bulut satırını (başlık + kaynak + anahtar +
//                       bağlantı + dal) yazar. Gövdeyi HİÇ görmez.
//   task MCP         — ajanın kart okuması (get_task) gövdeyi köprüden bu defterden ister.
//
// ## Gövde neden buluta gitmez
//
// LOCAL-BOARD-SPIKE-01 önerisi (a): "Ticket metni pano bulutuna yazılmaz: yerel kalır ya da
// yalnız başlık ve anahtar gider." Şirketin Jira metni müşteri adı, sözleşme, iç tartışma
// taşıyabilir; bulut panosu takımla paylaşılır ve başka cihazlara eşitlenir. Bulut satırı yalnız
// başlık + `source='jira'` + anahtar + bağlantı + dal taşır; gövde bu bilgisayarda,
// hesap kökünün altında `jira-tickets/<görev-id>.md` dosyasındadır.
//
// ## Dal adı
//
// `task/<ANAHTAR>-<kısa>` — anahtar BÜYÜK harfle kalır: Jira'nın geliştirme paneli dalı yalnız
// büyük harfli anahtarla bağlar (Atlassian belgesi: "two or more uppercase letters, hyphen,
// number"; `feature/pm-1` PM-1'e bağlanmaz). Kısa kısım ASCII küçük harf + rakam + `-`;
// Türkçe harfler katlanır, Windows'ta dosya adında yasak karakterler (`<>:"/\|?*`, sonda nokta /
// boşluk) zaten alfabede yok. Politika `branchName.JIRA_BRANCH_RE`.
//
// 🔴 Ticket gövdesi ve anahtar LOGLANMAZ. Log satırları yalnız sayı + HTTP kodu taşır.
//
// Saf + DI (`fetch`, `fs`, `now` enjekte) → `node --test electron/jiraImport.test.cjs`.

'use strict';

const path = require('node:path');
const nodeFs = require('node:fs');
const crypto = require('node:crypto');
const { normalizeSite, isEmail, siteBaseUrl } = require('./jiraConnect.cjs');

/** Jira proje anahtarı: büyük harfle başlar, 2-10 karakter (Atlassian varsayılanı). */
const PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]{1,9}$/;
/** Ticket anahtarı: `PROJ-12`. */
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]{1,9}-[1-9][0-9]{0,6}$/;
/** Görev kimliği (panonun `newTaskId` biçimi). */
const TASK_ID_RE = /^TASK-[A-Z0-9]{6,20}$/;
/** AgentSpace proje kısa adı (worktreePath.PROJECT_RE ile aynı alfabe). */
const PROJECT_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,48}$/;
/** LINEAR-OAUTH-01 — Linear'ın yerel defter site anahtarı (linearImport.SITE_RE ile aynı). */
const LINEAR_SITE_RE = /^linear:[a-z0-9][a-z0-9-]{0,63}$/;

const DEFAULT_TIMEOUT_MS = 15000;
/** Bir seferde listelenen / alınan ticket tavanı. Sprint 100'ü aşarsa ilk 100 (sıra = Jira sırası). */
const MAX_ISSUES = 100;
const MAX_IMPORT = 50;
const SUMMARY_MAX = 200;
const SLUG_MAX = 32;
/** worktree dizin adı tavanı (taskCode.codeSlug MAX_CODE_LEN). */
const DIR_MAX = 40;
/** Gövde tavanı: 200 KB. Fazlası kesilir ve bunu söyleyen bir satır eklenir. */
const BODY_MAX = 200_000;
const DIR_NAME = 'jira-tickets';
const INDEX_FILE = 'index.json';

// ─── küçük yardımcılar ──────────────────────────────────────────────────────

/** Kontrol karakteri yok, tavanlı, tek satır. */
function cleanLine(v, max = SUMMARY_MAX) {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

const TR_FOLD = { ı: 'i', İ: 'i', ş: 's', Ş: 's', ğ: 'g', Ğ: 'g', ü: 'u', Ü: 'u', ö: 'o', Ö: 'o', ç: 'c', Ç: 'c' };

/**
 * Başlıktan dalın kısa kısmı: `Giriş ekranında şifre hatası!` → `giris-ekraninda-sifre-hatasi`.
 * ASCII dışı her şey düşer; boş kalırsa null (dal yalnız anahtarla adlanır).
 */
function shortSlug(summary, max = SLUG_MAX) {
  const s = String(summary || '')
    .replace(/[ıİşŞğĞüÜöÖçÇ]/g, (c) => TR_FOLD[c])
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!s) return null;
  let out = s.slice(0, max);
  // Sözcük ortasında kesme: son tireye kadar geri çekil (yarısından kısa kalmayacaksa).
  if (s.length > max) {
    const cut = out.lastIndexOf('-');
    if (cut >= Math.floor(max / 2)) out = out.slice(0, cut);
  }
  return out.replace(/-+$/g, '') || null;
}

/**
 * Jira ticket'ının görev dalı: `task/PROJ-12-giris-hatasi` (kısa kısım boşsa `task/PROJ-12`).
 * Anahtar geçersizse null — "bir şey uydur" yok.
 */
function jiraBranchName(key, summary) {
  if (typeof key !== 'string' || !ISSUE_KEY_RE.test(key)) return null;
  // Dizin adı (worktree) taskCode.codeSlug tavanına (40) sığmalı: anahtar + '-' + kısa + çakışma
  // soneki ('-10' = 3). Uzun anahtarda kısa kısım kısalır.
  const room = DIR_MAX - key.length - 1 - 3;
  const slug = room >= 4 ? shortSlug(summary, Math.min(SLUG_MAX, room)) : null;
  return slug ? `task/${key}-${slug}` : `task/${key}`;
}

/** Ticket'ın tarayıcı adresi — her zaman gerçek Atlassian adresi (sahte kök yalnız API içindir). */
function issueUrl(site, key) {
  const s = normalizeSite(site);
  if (!s || !ISSUE_KEY_RE.test(String(key || ''))) return null;
  return `${siteBaseUrl(s)}/browse/${key}`;
}

// ─── ADF (Atlassian Document Format) → düz metin ───────────────────────────

/**
 * Jira v3 açıklaması ADF ağacıdır. Ajan için okunur bir markdown'a indirilir: paragraf,
 * başlık, liste, kod bloğu, alıntı, tablo (satır satır), bağlantı/anma/emoji metni.
 * Bilinmeyen düğümün yalnız metin çocukları alınır (içerik kaybolmaz, biçim kaybolabilir).
 */
function adfToText(doc) {
  if (doc == null) return '';
  if (typeof doc === 'string') return doc; // v2 / düz metin açıklama
  const out = [];
  const inline = (nodes) => (Array.isArray(nodes) ? nodes.map(inlineOf).join('') : '');
  function inlineOf(n) {
    if (!n || typeof n !== 'object') return '';
    switch (n.type) {
      case 'text': {
        let t = typeof n.text === 'string' ? n.text : '';
        const marks = Array.isArray(n.marks) ? n.marks : [];
        if (marks.some((m) => m && m.type === 'code')) t = `\`${t}\``;
        const link = marks.find((m) => m && m.type === 'link' && m.attrs && typeof m.attrs.href === 'string');
        if (link && link.attrs.href !== t) t = `${t} (${link.attrs.href})`;
        return t;
      }
      case 'hardBreak': return '\n';
      case 'mention': return (n.attrs && (n.attrs.text || n.attrs.displayName)) || '@?';
      case 'emoji': return (n.attrs && (n.attrs.text || n.attrs.shortName)) || '';
      case 'inlineCard': return (n.attrs && n.attrs.url) || '';
      case 'date': {
        const ts = Number(n.attrs && n.attrs.timestamp);
        return Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : '';
      }
      case 'status': return (n.attrs && n.attrs.text) ? `[${n.attrs.text}]` : '';
      default: return inline(n.content);
    }
  }
  function block(n, prefix = '') {
    if (!n || typeof n !== 'object') return;
    const c = Array.isArray(n.content) ? n.content : [];
    switch (n.type) {
      case 'doc': c.forEach((x) => block(x, prefix)); return;
      case 'paragraph': out.push(prefix + inline(c).replace(/\n/g, `\n${prefix}`)); out.push(''); return;
      case 'heading': {
        const lvl = Math.min(6, Math.max(1, Number(n.attrs && n.attrs.level) || 2));
        out.push(`${prefix}${'#'.repeat(lvl)} ${inline(c)}`); out.push(''); return;
      }
      case 'bulletList':
      case 'orderedList':
        c.forEach((item, i) => {
          const mark = n.type === 'orderedList' ? `${i + 1}. ` : '- ';
          const before = out.length;
          (Array.isArray(item && item.content) ? item.content : []).forEach((x) => block(x, prefix + '   '));
          // İlk satırın girintisini işaretle değiştir; boş satırları sıkıştır.
          const added = out.splice(before).filter((l) => l.trim() !== '');
          if (added.length) added[0] = prefix + mark + added[0].slice((prefix + '   ').length);
          out.push(...added);
        });
        out.push('');
        return;
      case 'taskList':
        c.forEach((item) => {
          const done = item && item.attrs && item.attrs.state === 'DONE';
          out.push(`${prefix}- [${done ? 'x' : ' '}] ${inline(item && item.content)}`);
        });
        out.push('');
        return;
      case 'codeBlock':
        out.push(`${prefix}\`\`\`${(n.attrs && n.attrs.language) || ''}`);
        out.push(...inline(c).split('\n').map((l) => prefix + l));
        out.push(`${prefix}\`\`\``); out.push('');
        return;
      case 'blockquote': c.forEach((x) => block(x, `${prefix}> `)); return;
      case 'panel': c.forEach((x) => block(x, `${prefix}> `)); return;
      case 'rule': out.push(`${prefix}---`); out.push(''); return;
      case 'table':
        for (const row of c) {
          const cells = (Array.isArray(row && row.content) ? row.content : [])
            .map((cell) => {
              const save = out.length;
              (Array.isArray(cell && cell.content) ? cell.content : []).forEach((x) => block(x));
              return out.splice(save).filter((l) => l.trim()).join(' ').replace(/\|/g, '\\|');
            });
          out.push(`${prefix}| ${cells.join(' | ')} |`);
        }
        out.push('');
        return;
      case 'mediaSingle':
      case 'mediaGroup':
        out.push(`${prefix}(ek: Jira'da görüntülenir)`); out.push('');
        return;
      default: {
        const t = inline(c);
        if (t.trim()) { out.push(prefix + t); out.push(''); }
      }
    }
  }
  block(doc);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ─── Jira REST ──────────────────────────────────────────────────────────────

/**
 * Kasadan gelen kayıttan bağlantı bilgisi. Eksikse null.
 * @param {{secret?:string, userFields?:Record<string,string>}|null} resolved
 */
function credsFrom(resolved) {
  if (!resolved || typeof resolved.secret !== 'string' || !resolved.secret.trim()) return null;
  const uf = resolved.userFields || {};
  const site = normalizeSite(uf.ATLASSIAN_SITE_NAME);
  const email = typeof uf.ATLASSIAN_USER_EMAIL === 'string' ? uf.ATLASSIAN_USER_EMAIL.trim() : '';
  if (!site || !isEmail(email)) return null;
  return { site, email, token: resolved.secret.trim() };
}

/**
 * Tek GET isteği. → { ok:true, status, body } | { ok:false, status, cause }
 * cause: auth · site · forbidden · rate-limit · server · timeout · network · bad-response
 */
async function jiraGet(creds, pathAndQuery, deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch;
  const baseUrlFor = typeof deps.baseUrlFor === 'function' ? deps.baseUrlFor : siteBaseUrl;
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : DEFAULT_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchFn(`${baseUrlFor(creds.site)}${pathAndQuery}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${creds.email}:${creds.token}`, 'utf8').toString('base64')}`,
      },
      redirect: 'manual', // Basic başlığı başka adrese taşınmasın (jiraConnect ile aynı duruş)
      signal: ctrl.signal,
    });
  } catch (err) {
    const aborted = ctrl.signal.aborted || (err && err.name === 'AbortError');
    return { ok: false, status: null, cause: aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
  const status = res.status;
  if (status === 200) {
    try {
      return { ok: true, status, body: await res.json() };
    } catch {
      return { ok: false, status, cause: 'bad-response' };
    }
  }
  let cause = 'server';
  if (status === 401) cause = 'auth';
  else if (status === 403) cause = 'forbidden';
  else if (status === 404 || (status >= 300 && status < 400)) cause = 'site';
  else if (status === 429) cause = 'rate-limit';
  else if (status === 400) cause = 'query';
  return { ok: false, status, cause };
}

/** Kullanıcının görebildiği Jira projeleri → [{key, name}] (ada göre). */
async function listProjects(creds, deps = {}) {
  const r = await jiraGet(creds, '/rest/api/3/project/search?maxResults=100&orderBy=name', deps);
  if (!r.ok) return r;
  const values = Array.isArray(r.body && r.body.values) ? r.body.values : [];
  const projects = values
    .map((p) => ({ key: String((p && p.key) || ''), name: cleanLine(p && p.name, 120) }))
    .filter((p) => PROJECT_KEY_RE.test(p.key));
  return { ok: true, status: r.status, projects };
}

const LIST_FIELDS = 'summary,status,issuetype,priority';

function issueView(site, it) {
  const f = (it && it.fields) || {};
  const key = String((it && it.key) || '');
  return {
    key,
    summary: cleanLine(f.summary) || key,
    status: cleanLine(f.status && f.status.name, 40) || null,
    statusCategory: cleanLine(f.status && f.status.statusCategory && f.status.statusCategory.key, 20) || null,
    type: cleanLine(f.issuetype && f.issuetype.name, 40) || null,
    priority: cleanLine(f.priority && f.priority.name, 40) || null,
    url: issueUrl(site, key),
  };
}

/**
 * Projenin AÇIK sprint(ler)indeki ticket'lar (gövdesiz liste). Sıra = Jira'daki sıra (Rank).
 * JQL yalnız doğrulanmış anahtarla kurulur (enjeksiyon yok).
 */
async function listSprintIssues(creds, projectKey, deps = {}) {
  if (!PROJECT_KEY_RE.test(String(projectKey || ''))) return { ok: false, status: null, cause: 'invalid-input' };
  const jql = `project = "${projectKey}" AND sprint in openSprints() ORDER BY Rank ASC`;
  const q = `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=${LIST_FIELDS}&maxResults=${MAX_ISSUES}`;
  const r = await jiraGet(creds, q, deps);
  if (!r.ok) return r;
  const issues = (Array.isArray(r.body && r.body.issues) ? r.body.issues : [])
    .map((it) => issueView(creds.site, it))
    .filter((i) => ISSUE_KEY_RE.test(i.key) && i.key.startsWith(`${projectKey}-`));
  return { ok: true, status: r.status, issues, truncated: r.body && r.body.isLast === false };
}

/**
 * Seçilen ticket'ların gövdeli hâli (alım anında TAZE okunur; liste önbelleğe alınmaz).
 * → { ok:true, issues:[{...issueView, body}] } — istenip gelmeyen anahtar `missing`te.
 */
async function fetchIssuesWithBody(creds, keys, deps = {}) {
  const want = [...new Set((Array.isArray(keys) ? keys : []).filter((k) => ISSUE_KEY_RE.test(String(k))))];
  if (!want.length) return { ok: false, status: null, cause: 'invalid-input' };
  const jql = `key in (${want.join(',')})`;
  const q = `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=${LIST_FIELDS},description&maxResults=${MAX_IMPORT}`;
  const r = await jiraGet(creds, q, deps);
  if (!r.ok) return r;
  const got = new Map();
  for (const it of Array.isArray(r.body && r.body.issues) ? r.body.issues : []) {
    const v = issueView(creds.site, it);
    if (!want.includes(v.key)) continue;
    let body = adfToText(it.fields && it.fields.description);
    if (body.length > BODY_MAX) body = `${body.slice(0, BODY_MAX)}\n\n(açıklamanın devamı Jira'da)`;
    got.set(v.key, { ...v, body });
  }
  return {
    ok: true,
    status: r.status,
    issues: want.filter((k) => got.has(k)).map((k) => got.get(k)),
    missing: want.filter((k) => !got.has(k)),
  };
}

// ─── yerel defter (hesap kökü / jira-tickets) ──────────────────────────────

/**
 * Defter: `index.json` = { version, tickets: { [taskId]: {key, site, project, branch, url, importedAt} },
 * projectMap: { "<site>/<JIRAKEY>": "<agentspace-slug>" } } · gövde `<taskId>.md`.
 * Hesap kökü yoksa (oturum yok) yazma yok.
 */
function createTicketStore(opts = {}) {
  const fs = opts.fs || nodeFs;
  const rootFn = typeof opts.root === 'function' ? opts.root : () => opts.root || null;
  const now = opts.now || Date.now;

  const dir = () => {
    const r = rootFn();
    return r ? path.join(r, DIR_NAME) : null;
  };
  function read() {
    const d = dir();
    const empty = { version: 1, tickets: {}, projectMap: {} };
    if (!d) return empty;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(d, INDEX_FILE), 'utf8'));
      return {
        version: 1,
        tickets: j && typeof j.tickets === 'object' && j.tickets ? j.tickets : {},
        projectMap: j && typeof j.projectMap === 'object' && j.projectMap ? j.projectMap : {},
      };
    } catch {
      return empty;
    }
  }
  function write(doc) {
    const d = dir();
    if (!d) return false;
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    const file = path.join(d, INDEX_FILE);
    const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  }
  const mapKey = (site, projectKey) => `${site}/${projectKey}`;
  // LINEAR-OAUTH-01 — aynı defter Linear issue'larını da tutar; Linear'ın site anahtarı
  // `linear:<çalışma alanı>` (Jira etiketiyle çakışmaz, `:` Jira etiketinde olamaz).
  const siteOk = (site) => !!normalizeSite(site) || LINEAR_SITE_RE.test(String(site || ''));

  return {
    available: () => !!dir(),
    /** Jira projesi → AgentSpace projesi (bu bilgisayarda hatırlanan). */
    getMapping(site, projectKey) {
      const v = read().projectMap[mapKey(site, projectKey)];
      return typeof v === 'string' && PROJECT_SLUG_RE.test(v) ? v : null;
    },
    setMapping(site, projectKey, slug) {
      if (!siteOk(site) || !PROJECT_KEY_RE.test(String(projectKey || '')) || !PROJECT_SLUG_RE.test(String(slug || ''))) return false;
      const doc = read();
      doc.projectMap[mapKey(site, projectKey)] = slug;
      return write(doc);
    },
    /** taskId → kayıt (gövdesiz). */
    get(taskId) {
      if (!TASK_ID_RE.test(String(taskId || ''))) return null;
      const t = read().tickets[taskId];
      return t && typeof t === 'object' ? { taskId, ...t } : null;
    },
    /** Bu bilgisayarda bu anahtarla alınmış görev var mı (bulut tekilliği asıl kapı; bu ön süzgeç). */
    taskIdForKey(site, key) {
      for (const [id, t] of Object.entries(read().tickets)) if (t && t.site === site && t.key === key) return id;
      return null;
    },
    /** Gövdeyi + kaydı yaz. Gövde dosyası 0600. */
    put(taskId, rec, body) {
      if (!TASK_ID_RE.test(String(taskId || ''))) return false;
      const d = dir();
      if (!d) return false;
      fs.mkdirSync(d, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(d, `${taskId}.md`), String(body || ''), { mode: 0o600 });
      const doc = read();
      doc.tickets[taskId] = {
        // Kaynak yoksa Jira (LINEAR-OAUTH-01 öncesi kayıtlar).
        ...(rec.source && rec.source !== 'jira' ? { source: String(rec.source) } : {}),
        key: rec.key, site: rec.site, project: rec.project, branch: rec.branch, url: rec.url,
        summary: rec.summary, importedAt: now(),
        // Geri alma için: dal bu alımda mı açıldı ve hangi commit'ten (uç hâlâ oradaysa silinebilir).
        branchCreated: rec.branchCreated === true,
        baseSha: typeof rec.baseSha === 'string' && /^[0-9a-f]{7,64}$/.test(rec.baseSha) ? rec.baseSha : null,
      };
      return write(doc);
    },
    /** Gövde metni (yoksa null). */
    body(taskId) {
      if (!TASK_ID_RE.test(String(taskId || ''))) return null;
      const d = dir();
      if (!d) return null;
      try { return fs.readFileSync(path.join(d, `${taskId}.md`), 'utf8'); } catch { return null; }
    },
    /** Bulut yazımı düştüyse geri al: kayıt + gövde silinir. */
    remove(taskId) {
      if (!TASK_ID_RE.test(String(taskId || ''))) return false;
      const d = dir();
      if (!d) return false;
      try { fs.unlinkSync(path.join(d, `${taskId}.md`)); } catch { /* yoksa sorun değil */ }
      const doc = read();
      if (!doc.tickets[taskId]) return false;
      delete doc.tickets[taskId];
      return write(doc);
    },
  };
}

/** Panonun görev kimliği biçimi (TaskBoard `newTaskId` ile aynı: TASK- + zaman + rastgele, büyük harf). */
function newTaskId(nowMs = Date.now()) {
  return `TASK-${nowMs.toString(36).toUpperCase()}${crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 5)}`;
}

module.exports = {
  PROJECT_KEY_RE,
  ISSUE_KEY_RE,
  TASK_ID_RE,
  PROJECT_SLUG_RE,
  MAX_IMPORT,
  BODY_MAX,
  DIR_NAME,
  shortSlug,
  jiraBranchName,
  issueUrl,
  adfToText,
  credsFrom,
  jiraGet,
  listProjects,
  listSprintIssues,
  fetchIssuesWithBody,
  createTicketStore,
  newTaskId,
};
