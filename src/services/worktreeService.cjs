// CrewPane — B-01 Faz B/E: WORKTREE SAĞLAMA SERVİSİ (GIT-BACKBONE-SPEC §2.4).
//
//     ensure() → bind → finish → merge (mergeService) → release() → reap()
//
// ─────────────────────────────────────────────────────────────────────────────
// GÜVENLİK SÖZLEŞMESİ (G-2, G-3, G-6, G-9) — bu dosyanın tamamı için geçerli
// ─────────────────────────────────────────────────────────────────────────────
//  • TÜM git çağrıları `execFile('git', [sabit argümanlar])`. KABUK YOK. Kullanıcı/
//    board kaynaklı hiçbir dize komut satırına *yorumlanarak* girmez.
//  • Yol argümanlarından önce `--` ayracı: `-` ile başlayan bir yol git tarafından
//    bayrak sanılamaz. (Branch adları zaten `branchName` regex'inde `-` ile
//    başlayamaz; `--` ikinci kattır.)
//  • YIKICI komutlar (`worktree remove`) yalnız `worktreePath.isManagedWorktree`
//    geçen yollarda koşar (G-9). `push --force`, `reset --hard`, `checkout -f`
//    bu ürün kodunda HİÇ üretilmez (G-6).
//  • Branch/yol kararı yalnız BURADA (main tarafı) verilir; renderer bir yol ya da
//    branch adı DAYATAMAZ (G-1) — servis `opts.path`/`opts.branch` kabul etmez,
//    kendi türetir.
//
// ─────────────────────────────────────────────────────────────────────────────
// GERİ-UYUM (spec "Kurallar": sessiz yarım-izolasyon YASAK)
// ─────────────────────────────────────────────────────────────────────────────
// `isolation:'off'` ya da proje bir git repo'su değilse → `{ok:false, degrade:true}`
// döner ve ÇAĞIRAN bugünkü cwd yoluna düşer (davranış birebir korunur).
// `isolation:'worktree'` iken hazırlık başarısızsa → `{ok:false, degrade:false}`:
// spawn DURUR ve kart çıkar. Paylaşımlı ağaca SESSİZCE düşmek yoktur.

'use strict';

const { execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const branchName = require('../config/branchName.cjs');
const taskCode = require('../agents/taskCode.cjs');
const worktreePath = require('../config/worktreePath.cjs');
const store = require('./worktreeStore.cjs');

const GIT_TIMEOUT_MS = 120_000; // `worktree add` ölçüldü: 7.4 sn (1.1 GB ağaç)
const MAX_BUF = 16 * 1024 * 1024;

/** §2.4 kapasite kapısı — eşzamanlı worktree tavanı (açık soru A-3'ün varsayılanı). */
const DEFAULT_MAX_WORKTREES = 6;

/** H-9 — boş alan < KAT × (ölçülen worktree boyutu) ise fail-closed. */
const DISK_HEADROOM_FACTOR = 3;

/** Ölçülemeyen worktree boyutu için varsayılan tahmin (§4: ölçülen 1.1 GB). */
const ASSUMED_WORKTREE_BYTES = 1.2 * 1024 * 1024 * 1024;

/** `.env.local` sınıfı izin listesi — KOPYA değil symlink (§2.4, G-5). */
const DEFAULT_ENV_ALLOWLIST = Object.freeze(['.env.local', 'electron/.env.local']);

/**
 * G-5 — bu desenlerden BİRİNE uyan hiçbir yol symlink edilemez, izin listesine
 * yazılsa bile. Kod seviyesinde red: ayar dosyası bir sırrı N worktree'ye çoğaltmanın
 * yolu olamaz.
 */
const FORBIDDEN_LINK = [/(^|\/)credentials(\/|$)/i, /(^|\/)auth(\/|$)/i, /vault\.bin$/i, /(^|\/)\.ssh(\/|$)/i, /\.pem$/i, /\.key$/i];

// ═══════════════════════════════════════════════════════════════════════════
// git boğazı
// ═══════════════════════════════════════════════════════════════════════════

/**
 * git çalıştır (async). ASLA throw etmez: `{ok, stdout, stderr, code}`.
 * `cwd` git'in `-C` argümanıdır — çağıran her zaman verir (global git durumu yok).
 */
function git(cwd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { timeout: opts.timeout || GIT_TIMEOUT_MS, maxBuffer: MAX_BUF, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: String(stdout || ''),
          stderr: String(stderr || (err && err.message) || ''),
          code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
        });
      },
    );
  });
}

/** Senkron git (yalnız UCUZ okumalar: rev-parse/show-ref — main'i bloklamaz). */
function gitSync(cwd, args) {
  try {
    const stdout = execFileSync('git', ['-C', cwd, ...args], {
      timeout: 10_000,
      maxBuffer: MAX_BUF,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { ok: true, stdout: String(stdout || ''), stderr: '' };
  } catch (err) {
    return { ok: false, stdout: '', stderr: String((err && err.message) || err) };
  }
}

/** `dir` bir git çalışma ağacı mı (ya da içindeki bir dizin)? */
async function isGitRepo(dir) {
  if (typeof dir !== 'string' || !dir) return false;
  const r = await git(dir, ['rev-parse', '--git-dir']);
  return r.ok;
}

function isGitRepoSync(dir) {
  if (typeof dir !== 'string' || !dir) return false;
  return gitSync(dir, ['rev-parse', '--git-dir']).ok;
}

/** Repo'nun çalışma ağacı tepesi (worktree'ler için KENDİ tepeleri döner). */
async function topLevel(dir) {
  const r = await git(dir, ['rev-parse', '--show-toplevel']);
  return r.ok ? r.stdout.trim() || null : null;
}

/** `refs/heads/<branch>` var mı? */
async function branchExists(repo, branch) {
  const r = await git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  return r.ok;
}

function branchExistsSync(repo, branch) {
  return gitSync(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
}

/** Bir ref'in commit hash'i (yoksa null). */
async function revParse(repo, ref) {
  const r = await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const v = r.stdout.trim();
  return r.ok && /^[0-9a-f]{7,40}$/.test(v) ? v : null;
}

/**
 * Yeni branch'in TABANI: `origin/<default>` varsa o (uzak taze), yoksa yerel
 * `<default>`, o da yoksa HEAD. Kararın kendisi log'a düşer — "hangi taban"
 * sorusu inceleme diff'ini belirler, sessiz kalamaz.
 */
async function resolveBase(repo, defaultBranch) {
  const b = typeof defaultBranch === 'string' && defaultBranch ? defaultBranch : 'dev';
  for (const ref of [`refs/remotes/origin/${b}`, `refs/heads/${b}`, 'HEAD']) {
    const sha = await revParse(repo, ref);
    if (sha) return { sha, ref };
  }
  return { sha: null, ref: null };
}

/** `git worktree list --porcelain` → [{path, branch, prunable}] */
async function listGitWorktrees(repo) {
  const r = await git(repo, ['worktree', 'list', '--porcelain']);
  if (!r.ok) return [];
  const out = [];
  let cur = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur);
      cur = { path: line.slice(9).trim(), branch: null, prunable: false, detached: false };
    } else if (!cur) {
      continue;
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    } else if (line.startsWith('prunable')) {
      cur.prunable = true;
    } else if (line.startsWith('detached')) {
      cur.detached = true;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// KAPASİTE / DİSK KAPILARI (Faz E — H-9)
// ═══════════════════════════════════════════════════════════════════════════

/** Bir dizindeki boş alan (bayt) — ölçülemezse null (kapı o zaman GEÇİRİR, sahte alarm yok). */
function freeBytes(dir) {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/**
 * Disk ön-kontrolü (H-9). Boş alan < FACTOR × beklenen worktree boyutu → RED.
 * Ölçüm yapılamıyorsa GEÇER: bilinmeyeni "dolu" saymak, çalışan bir kurulumu
 * durdurmak olurdu (yanlış-negatif burada yanlış-pozitiften ucuz).
 */
function checkDisk(dir, expectedBytes = ASSUMED_WORKTREE_BYTES) {
  const free = freeBytes(dir);
  if (free == null) return { ok: true, free: null, why: 'boş alan ölçülemedi — kapı geçirildi' };
  const need = expectedBytes * DISK_HEADROOM_FACTOR;
  if (free >= need) return { ok: true, free, need };
  return {
    ok: false,
    free,
    need,
    why: `disk yetersiz: boş ${(free / 1e9).toFixed(1)} GB < gerekli ${(need / 1e9).toFixed(1)} GB (${DISK_HEADROOM_FACTOR}× worktree)`,
  };
}

/**
 * Tavan kapısı (§2.4). Aktif kayıt sayısı tavana ulaştıysa önce `merged`/`orphaned`
 * biri temizlenmeli; temizlenecek yoksa spawn DURUR (izolasyonsuz koşmaz).
 * SAF — defter kayıtları girdi.
 */
function checkCapacity(records, max = DEFAULT_MAX_WORKTREES) {
  const active = records.filter((r) => r.state === 'active');
  if (active.length < max) return { ok: true, active: active.length, max };
  const reclaimable = records.filter((r) => r.state === 'merged' || r.state === 'orphaned');
  return {
    ok: false,
    active: active.length,
    max,
    reclaimable: reclaimable.map((r) => r.taskId),
    why:
      `eşzamanlı worktree tavanı doldu (${active.length}/${max})` +
      (reclaimable.length ? ` — önce şunlar kaldırılabilir: ${reclaimable.map((r) => r.taskId).join(', ')}` : ' — kaldırılabilir kayıt yok'),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SPARSE-CHECKOUT + BAĞIMLILIK (Faz E — R-1, R-4)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * §4 — worktree'nin 1.1 GB'ının TAMAMI `docs/agent-results/` altındaki kanıt
 * MEDYASI. `.md` raporlar KALIR (ajan onları okur/yazar), yalnız medya dışlanır.
 * `--no-cone` desenleri: `!` ile dışlama sırayla uygulanır.
 */
const SPARSE_PATTERNS = Object.freeze([
  '/*',
  '!/docs/agent-results/**',
  '/docs/agent-results/*.md',
]);

async function applySparseCheckout(wt, patterns = SPARSE_PATTERNS) {
  const init = await git(wt, ['sparse-checkout', 'init', '--no-cone']);
  if (!init.ok) return { ok: false, why: `sparse-checkout init: ${init.stderr.trim()}` };
  const set = await git(wt, ['sparse-checkout', 'set', '--no-cone', '--', ...patterns]);
  if (!set.ok) return { ok: false, why: `sparse-checkout set: ${set.stderr.trim()}` };
  return { ok: true, patterns };
}

/**
 * R-4 / G-10 — `node_modules`: SYMLINK DEĞİL, APFS KLONU.
 *
 * Ekip hafızası [[worktree-nodemodules-clone-turbopack]] (2026-08-07, ölçüldü):
 * `ln -s <ana>/node_modules` kurulumunda `next build` (Turbopack) şununla düşüyor:
 * "Symlink [project]/node_modules is invalid, it points out of the filesystem root".
 * `cp -Rc` (APFS clonefile) ölçülen 6-7 sn / ek disk ~0 ve `electron:build:prep`
 * temiz geçiyor.
 *
 * G-10 KAPISI: `package-lock.json` taban ile baş arasında GERÇEKTEN değiştiyse klon
 * KURULMAZ — yanlış bağımlılıkla koşan yeşil bir test SAHTE KANITTIR. O durumda
 * `npm ci` gerektiği bildirilir (sessiz degrade yok).
 */
async function cloneNodeModules(repo, wt, { subdirs = ['', 'electron', 'mobile'], platform = process.platform } = {}) {
  const results = [];
  for (const sub of subdirs) {
    const src = path.join(repo, sub, 'node_modules');
    const dst = path.join(wt, sub, 'node_modules');
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(dst)) { results.push({ sub, skipped: 'zaten var' }); continue; }
    if (platform !== 'darwin') {
      // APFS clonefile YOK → sessiz degrade YASAK: çağıran `npm ci` uyarısını görsün.
      results.push({ sub, skipped: 'APFS değil — npm ci gerekir', needsInstall: true });
      continue;
    }
    const r = await new Promise((resolve) => {
      execFile('cp', ['-Rc', '--', src, dst], { timeout: 300_000 }, (err) => resolve(!err));
    });
    results.push(r ? { sub, cloned: true } : { sub, skipped: 'cp -Rc başarısız', needsInstall: true });
  }
  return results;
}

/** R-5 / G-5 — izin listeli `.env.local` symlink'i (KOPYA DEĞİL: tek kaynak, tek iptal). */
function linkEnvFiles(repo, wt, allowlist = DEFAULT_ENV_ALLOWLIST) {
  const done = [];
  for (const rel of allowlist) {
    if (typeof rel !== 'string' || !rel) continue;
    if (path.isAbsolute(rel) || rel.includes('..')) { done.push({ rel, skipped: 'yol politikası' }); continue; }
    if (FORBIDDEN_LINK.some((re) => re.test(rel))) {
      done.push({ rel, skipped: 'G-5: credential/vault yolu kod seviyesinde reddedildi' });
      continue;
    }
    const src = path.join(repo, rel);
    const dst = path.join(wt, rel);
    if (!fs.existsSync(src) || fs.existsSync(dst)) { done.push({ rel, skipped: 'kaynak yok / hedef dolu' }); continue; }
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.symlinkSync(src, dst);
      done.push({ rel, linked: true });
    } catch (err) {
      done.push({ rel, skipped: String((err && err.code) || err) });
    }
  }
  return done;
}

// ═══════════════════════════════════════════════════════════════════════════
// ensure — GÖREV İÇİN İZOLE AĞAÇ SAĞLA
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Görevin worktree'sini sağla. TEK KARAR NOKTASI (ADP-761 §4): branch adı, yol,
 * sahiplik ve taban burada belirlenir; çağrı yollarına kopyalanmaz.
 *
 * @param {{
 *   taskId:string, code:string, project:string, agentId?:string|null,
 *   workspaceRoot:string, repoPath:string, defaultBranch?:string,
 *   isolation?:'worktree'|'off', allowTakeover?:boolean,
 *   ownerLive?:(agentId:string)=>boolean,
 *   maxWorktrees?:number, sparse?:boolean, cloneDeps?:boolean, envAllowlist?:string[],
 *   homedir?:string, now?:number, log?:(s:string)=>void,
 * }} req
 * @returns {Promise<{ok:true, path:string, branch:string, baseCommit:string, reused:boolean, notes:string[]}
 *                 | {ok:false, degrade:boolean, why:string, code:string}>}
 */
async function ensure(req = {}) {
  const log = typeof req.log === 'function' ? req.log : () => {};
  const notes = [];
  const isolation = req.isolation === 'off' ? 'off' : 'worktree';
  const homedir = req.homedir;
  const now = Number.isFinite(req.now) ? req.now : Date.now();

  const deny = (why, code, degrade = false) => {
    log(`worktree ensure REDDEDİLDİ (${code}): ${why}`);
    return { ok: false, degrade, why, code };
  };

  if (isolation === 'off') return deny('proje izolasyonu kapalı', 'isolation_off', true);

  const taskId = String(req.taskId || '').trim();
  if (!taskId) return deny('görev kimliği yok', 'no_task', true);

  const codeNorm = taskCode.taskCodeOf(req.code) || req.code;
  const slug = taskCode.codeSlug(codeNorm);
  if (!slug) return deny(`görev kodu türetilemedi: ${JSON.stringify(req.code)}`, 'no_code', true);

  const repo = typeof req.repoPath === 'string' ? req.repoPath : '';
  if (!repo || !(await isGitRepo(repo))) {
    // H-5 — proje bir repo değil. `worktree` modunda spawn DURUR (sessiz paylaşımlı
    // ağaç yok); `off` zaten yukarıda döndü.
    return deny(`proje reposu tanımlı değil ya da git deposu değil: ${repo || '(boş)'}`, 'no_repo', false);
  }
  const repoTop = (await topLevel(repo)) || repo;

  // Ön doğrulama: kod/proje politikadan geçiyor mu? (Nihai yol BRANCH ADINDAN
  // türetilir — aşağıda; çünkü çakışmada branch soneklenir ve DİZİN DE soneklenmeli.
  // Aksi hâlde iki farklı görev aynı dizini ister ve ikincisi "already exists" ile
  // düşer — bu tam olarak entegrasyon testinin yakaladığı hataydı.)
  const probe = worktreePathFor(req.workspaceRoot, req.project, slug);
  if (!probe.ok) return deny(probe.why, 'bad_path', false);

  // ── Sahiplik (F-8 / H-4b) ────────────────────────────────────────────────
  const existing = store.getWorktree(taskId, homedir);
  const ownerLive =
    existing && existing.owner && typeof req.ownerLive === 'function'
      ? (() => { try { return req.ownerLive(existing.owner) === true; } catch { return false; } })()
      : false;
  const own = store.decideOwnership(existing, {
    agentId: req.agentId,
    allowTakeover: req.allowTakeover,
    ownerLive,
  });
  if (own.action === 'deny') return deny(own.why, 'owner_conflict', false);
  if (own.action === 'takeover') notes.push(`SAHİPLİK DEVRİ: ${existing.owner} → ${own.owner || '(anonim)'}`);

  // ── Mevcut ağaç hâlâ ayakta mı? (H-2 restart-resume / H-7 kayıp dizin) ────
  // Kayıtlı yol BİZİM ağacımızda olmak zorunda (G-9): defterde elle bozulmuş bir
  // yol yeniden kullanılamaz. Kod↔yol eşitliği ARANMAZ — çakışmada branch (ve
  // dizin) soneklenmiş olabilir ve kayıt o soneki taşır.
  if (existing && existing.path && existing.state !== 'removed'
      && worktreePath.isManagedWorktree(req.workspaceRoot, existing.path)) {
    if (fs.existsSync(path.join(existing.path, '.git'))) {
      store.putWorktree(taskId, { owner: own.owner, state: 'active', lastPaneId: req.paneId || existing.lastPaneId }, homedir, now);
      log(`worktree ensure REUSE task=${taskId} branch=${existing.branch} path=${existing.path}`);
      return { ok: true, path: existing.path, branch: existing.branch, baseCommit: existing.baseCommit, reused: true, notes };
    }
    // H-7 — dizin elle silinmiş: sessiz geçme, kartla bildir ve yeniden kur.
    notes.push(`H-7: kayıtlı worktree dizini YOK (${existing.path}) — prune + yeniden kurulum; taahhüt edilmemiş iş kaybolmuş olabilir`);
    await git(repoTop, ['worktree', 'prune']);
  }

  // ── Kapasite + disk kapıları (H-9) ───────────────────────────────────────
  const cap = checkCapacity(store.listWorktrees(homedir).filter((r) => r.taskId !== taskId), req.maxWorktrees ?? DEFAULT_MAX_WORKTREES);
  if (!cap.ok) return deny(cap.why, 'capacity', false);
  const parent = worktreePath.worktreesRoot(req.workspaceRoot);
  try { fs.mkdirSync(parent, { recursive: true }); } catch { /* aşağıdaki disk kapısı zaten ölçer */ }
  const disk = checkDisk(parent, req.sparse === false ? ASSUMED_WORKTREE_BYTES : ASSUMED_WORKTREE_BYTES / 4);
  if (!disk.ok) return deny(disk.why, 'disk', false);

  // ── Branch adı + çakışma (H-6) ───────────────────────────────────────────
  const br = branchName.resolveBranchName(slug, {
    exists: (b) => branchExistsSync(repoTop, b),
    ownerOf: (b) => store.taskIdForBranch(b, homedir),
    taskId,
  });
  if (!br.ok) return deny(br.why, 'branch_conflict', false);
  const vb = branchName.validateBranchName(br.branch, {
    // ⚠️ `check-ref-format` `--` AYRACINI KABUL ETMEZ (ölçüldü: exit 129, usage).
    // Bu tek istisnanın güvenli olmasının sebebi, değerin buraya gelene kadar
    // `BRANCH_RE` (`^task/[a-z0-9]…`) süzgecinden geçmiş olmasıdır: `-` ile
    // başlayamaz, yani bayrak olarak yorumlanamaz.
    checkRefFormat: (n) => gitSync(repoTop, ['check-ref-format', '--branch', n]).ok,
  });
  if (!vb.ok) return deny(vb.why, 'branch_invalid', false);

  // NİHAİ YOL = BRANCH ADINDAN (çakışmada `task/x-01-2` → dizin de `x-01-2`).
  // Yol kodu doğrudan kullansaydı iki farklı görev aynı dizini isterdi.
  const wtp = worktreePathFor(req.workspaceRoot, req.project, br.branch.slice(branchName.BRANCH_PREFIX.length));
  if (!wtp.ok) return deny(wtp.why, 'bad_path', false);

  const base = await resolveBase(repoTop, req.defaultBranch);
  if (!base.sha) return deny('taban commit çözülemedi (boş repo?)', 'no_base', false);
  log(`worktree ensure task=${taskId} branch=${br.branch} path=${wtp.path} base=${base.ref}@${base.sha.slice(0, 8)}`);

  // ── worktree add ─────────────────────────────────────────────────────────
  // Branch VARSA (reuse) `-b` verilmez; yoksa taban commit'ten yeni dal açılır.
  //
  // 🔑 `--no-checkout` SIRALAMASI (Faz E, ölçüldü — crewpane reposu, 2026-08-12):
  //   düz `worktree add`                       → 8.72 sn / 1.3 GB
  //   `--no-checkout` → sparse-checkout → checkout → 1.00 sn /  83 MB
  // Fark bir "optimizasyon" değil, DOĞRU SIRA: sparse desenlerini checkout'tan
  // SONRA uygulamak, 1.2 GB kanıt medyasını önce diske yazıp sonra silmek demektir.
  // (Hedef §4'te ≤150 MB / ≤2 sn idi; ölçülen ikisinin de altında.)
  const wantSparse = req.sparse !== false;
  const addArgs = br.reused
    ? ['worktree', 'add', ...(wantSparse ? ['--no-checkout'] : []), '--', wtp.path, br.branch]
    : ['worktree', 'add', '-b', br.branch, ...(wantSparse ? ['--no-checkout'] : []), '--', wtp.path, base.sha];
  const add = await git(repoTop, addArgs);
  if (!add.ok) return deny(`git worktree add: ${add.stderr.trim().slice(0, 400)}`, 'git_add', false);

  // ── Faz E hazırlıkları (hepsi best-effort ama SESSİZ DEĞİL) ──────────────
  if (wantSparse) {
    const sp = await applySparseCheckout(wtp.path);
    notes.push(sp.ok ? `sparse-checkout uygulandı (${sp.patterns.length} desen)` : `sparse-checkout ATLANDI: ${sp.why}`);
    // `--no-checkout` ile açılan ağaç BOŞTUR — dosyaları şimdi yaz. Bu adım
    // başarısız olursa ajan BOŞ bir dizinde koşardı (sessizce çalışan ama hiçbir
    // şey bulamayan bir pane): fail-closed.
    const co = await git(wtp.path, ['checkout', '-q', 'HEAD', '--']);
    if (!co.ok) {
      return deny(`sparse checkout yazılamadı (ağaç BOŞ kalırdı): ${co.stderr.trim().slice(0, 300)}`, 'git_checkout', false);
    }
  }
  if (req.cloneDeps !== false) {
    const lockChanged = await lockDiffers(repoTop, base.sha, br.branch);
    if (lockChanged) {
      notes.push('G-10: package-lock TABANDAN FARKLI — node_modules klonlanmadı, bu görevde `npm ci` gerekir');
    } else {
      for (const r of await cloneNodeModules(repoTop, wtp.path)) {
        if (r.needsInstall) notes.push(`node_modules(${r.sub || 'kök'}): ${r.skipped} → npm ci gerekir`);
      }
    }
  }
  for (const r of linkEnvFiles(repoTop, wtp.path, req.envAllowlist || DEFAULT_ENV_ALLOWLIST)) {
    if (r.skipped && /G-5/.test(r.skipped)) notes.push(`${r.rel}: ${r.skipped}`);
  }

  const rec = store.putWorktree(
    taskId,
    {
      project: wtp.project, code: wtp.code, branch: br.branch, path: wtp.path,
      baseCommit: base.sha, owner: own.owner, state: 'active', lastPaneId: req.paneId || null,
    },
    homedir,
    now,
  );
  if (!rec) {
    // [[adp946-persist-claim-vs-proof]] — "yazdım" kanıt değil. Defter yazılamadıysa
    // ağaç DURUR (iş kaybı yok) ama bağ kurulamadı: sessiz devam etmek yerine bildir.
    notes.push('UYARI: yerel defter yazılamadı — worktree diskte var ama görevle bağı KAYITLI DEĞİL (reap onu orphaned toplar)');
  }
  return { ok: true, path: wtp.path, branch: br.branch, baseCommit: base.sha, reused: false, notes };
}

/** `worktreePath.worktreePathFor` sarmalayıcısı (ensure içinde okunabilirlik için). */
function worktreePathFor(workspaceRoot, project, code) {
  return worktreePath.worktreePathFor(workspaceRoot, project, code);
}

/** G-10 — `package-lock.json` taban ile dal arasında değişti mi? */
async function lockDiffers(repo, base, head) {
  const r = await git(repo, [
    'diff', '--name-only', `${base}...${head}`, '--',
    'package-lock.json', 'electron/package-lock.json', 'mobile/package-lock.json',
  ]);
  return r.ok && r.stdout.trim().length > 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// SENKRON ÇÖZÜM (restart-resume — H-2)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Görevin ZATEN VAR OLAN worktree'sini ucuza çöz (git çağrısı YOK, yalnız defter +
 * `statSync`). `spawnPty` senkron yollarında (restoreLivePanes) kullanılır: uygulama
 * yeniden başladığında yarım görev AYNI worktree'ye döner (H-2) ve main 7 saniyelik
 * `worktree add` için BLOKLANMAZ.
 *
 * @returns {{path:string, branch:string, taskId:string}|null}
 */
function resolveExistingSync(taskId, homedir) {
  const rec = store.getWorktree(taskId, homedir);
  if (!rec || !rec.path || rec.state === 'removed') return null;
  try {
    if (!fs.statSync(rec.path).isDirectory()) return null;
    if (!fs.existsSync(path.join(rec.path, '.git'))) return null;
  } catch {
    return null;
  }
  return { path: rec.path, branch: rec.branch, taskId: rec.taskId };
}

// ═══════════════════════════════════════════════════════════════════════════
// status / release / reap
// ═══════════════════════════════════════════════════════════════════════════

/**
 * §2.6 — `review`'a geçerken main'in ÖLÇTÜĞÜ şey: kirli mi, commit var mı, diff ne.
 * Ölçüm; karar değil (kararı mergePolicy verir).
 */
async function status(taskId, homedir) {
  const rec = store.getWorktree(taskId, homedir);
  if (!rec || !rec.path) return { ok: false, why: 'defterde kayıt yok' };
  if (!fs.existsSync(rec.path)) return { ok: false, why: `worktree dizini yok: ${rec.path}`, missing: true };
  const dirty = await git(rec.path, ['status', '--porcelain']);
  const commits = await git(rec.path, ['log', '--oneline', `${rec.baseCommit}..HEAD`]);
  const stat = await git(rec.path, ['diff', '--stat', `${rec.baseCommit}...HEAD`]);
  const files = await git(rec.path, ['diff', '--name-only', `${rec.baseCommit}...HEAD`]);
  const commitLines = commits.stdout.split('\n').filter(Boolean);
  return {
    ok: true,
    taskId: rec.taskId,
    branch: rec.branch,
    path: rec.path,
    baseCommit: rec.baseCommit,
    dirty: dirty.stdout.trim().length > 0,
    dirtyFiles: dirty.stdout.split('\n').filter(Boolean).map((l) => l.slice(3)),
    commitCount: commitLines.length,
    commits: commitLines,
    diffStat: stat.stdout.trim(),
    files: files.stdout.split('\n').filter(Boolean),
  };
}

/**
 * Merge sonrası worktree'yi kaldır. G-9: yalnız YÖNETİLEN yol + TEMİZ ağaç.
 * Kirli ağaç yalnız açık `force` ile (patron onayı) silinir — ajanın işini kaçak
 * silmek yasaktır.
 */
async function release(taskId, { homedir, workspaceRoot, force = false, repoPath } = {}) {
  const rec = store.getWorktree(taskId, homedir);
  if (!rec || !rec.path) return { ok: false, why: 'defterde kayıt yok' };
  if (!worktreePath.isManagedWorktree(workspaceRoot, rec.path)) {
    return { ok: false, why: `G-9: yönetilmeyen yol silinemez: ${rec.path}` };
  }
  if (fs.existsSync(rec.path)) {
    const dirty = await git(rec.path, ['status', '--porcelain']);
    if (dirty.stdout.trim() && !force) {
      return { ok: false, why: 'ağaç KİRLİ — patron onayı olmadan silinmez (G-9)', dirty: true };
    }
    const repo = repoPath || rec.path;
    const rm = await git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), '--', rec.path]);
    if (!rm.ok) return { ok: false, why: `git worktree remove: ${rm.stderr.trim().slice(0, 300)}` };
  }
  store.putWorktree(taskId, { state: 'removed' }, homedir);
  return { ok: true, path: rec.path };
}

/**
 * REAPER (§3 tablosu). ASLA `--force` ile kirli ağaç silmez; yaptığı tek YIKICI iş
 * `git worktree prune` (git'in kendi kayıp-dizin temizliği). Geri kalanı RAPORDUR:
 * patronun temizlik listesi.
 *
 * @returns {Promise<{pruned:boolean, orphaned:string[], missing:string[], stale:string[], adhoc:string[]}>}
 */
async function reap({ homedir, workspaceRoot, repoPath, paneLive, staleMs = 7 * 24 * 3600_000, now = Date.now() } = {}) {
  const out = { pruned: false, orphaned: [], missing: [], stale: [], adhoc: [] };
  if (repoPath && (await isGitRepo(repoPath))) {
    const p = await git(repoPath, ['worktree', 'prune']);
    out.pruned = p.ok;
    // Defterde OLMAYAN ama git'in bildiği yönetilen worktree'ler = kaçak/artık.
    for (const w of await listGitWorktrees(repoPath)) {
      if (!worktreePath.isManagedWorktree(workspaceRoot, w.path)) continue;
      if (!store.taskIdForPath(w.path, homedir)) out.adhoc.push(w.path);
    }
  }
  for (const rec of store.listWorktrees(homedir)) {
    if (rec.state === 'removed') continue;
    if (rec.path && !fs.existsSync(rec.path)) {
      out.missing.push(rec.taskId);
      store.putWorktree(rec.taskId, { state: 'orphaned' }, homedir, now);
      continue;
    }
    const live = typeof paneLive === 'function' && rec.lastPaneId ? paneLive(rec.lastPaneId) === true : false;
    const idleMs = now - (rec.updatedAt || rec.createdAt || now);
    if (rec.state === 'active' && !live && idleMs > staleMs) {
      out.stale.push(rec.taskId);
      store.putWorktree(rec.taskId, { state: 'orphaned' }, homedir, now);
    }
  }
  out.orphaned = store.listByState('orphaned', homedir).map((r) => r.taskId);
  return out;
}

module.exports = {
  DEFAULT_MAX_WORKTREES,
  DISK_HEADROOM_FACTOR,
  ASSUMED_WORKTREE_BYTES,
  DEFAULT_ENV_ALLOWLIST,
  FORBIDDEN_LINK,
  SPARSE_PATTERNS,
  git,
  gitSync,
  isGitRepo,
  isGitRepoSync,
  topLevel,
  branchExists,
  branchExistsSync,
  revParse,
  resolveBase,
  listGitWorktrees,
  freeBytes,
  checkDisk,
  checkCapacity,
  applySparseCheckout,
  cloneNodeModules,
  linkEnvFiles,
  lockDiffers,
  ensure,
  resolveExistingSync,
  status,
  release,
  reap,
};
