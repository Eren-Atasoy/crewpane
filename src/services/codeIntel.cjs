// ADP-206 — editor code-intelligence bridge: git diff (committed vs working) + workspace
// file list + content grep. The PURE parser (parseDiffHunks) is unit-tested; the IO
// functions shell out to `git` (read-only, fixed args → no injection) inside the repo
// root. All best-effort: a non-repo / missing git / error → a benign empty result.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MAX_BUF = 8 * 1024 * 1024; // diffs/listings can be large; cap to 8 MB
const GREP_MAX = 500; // cap grep hits so the panel stays responsive
const LIST_MAX = 12000; // cap the file-list walk (non-git roots) so quick-open stays snappy

// TASK-MQTIVZSDYPNRH — heavy/derived dirs to skip when the search root is NOT a single
// git repo (a multi-project parent like "CrewPane Apps", or a plain folder). Inside a
// real repo we let `git` honor .gitignore instead; this set is the fallback's ignore
// list (git grep --no-index does NOT reliably honor nested .gitignores, and a plain
// FS walk has none). Keeps build output, vendored deps, caches and browser/CI profiles
// (e.g. lead-scraper/.browser-data — a Playwright profile, ~21k files) out of results.
const IGNORE_DIRS = new Set([
  '.git', 'node_modules', '.next', 'dist', 'build', 'out', 'coverage', '.cache',
  '.turbo', '.parcel-cache', '.svelte-kit', '.expo', '.vercel', '.netlify',
  '__pycache__', '.venv', 'venv', 'env', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  'Pods', 'vendor', 'target', '.gradle', '.idea', '.vscode',
  '.browser-data', '.pyinstaller', '.DS_Store',
]);

/**
 * PURE — parse `git diff --unified=0` output into per-line change sets for gutter
 * decorations. Returns { added:[lineNo…], modified:[lineNo…], removed:[lineNo…],
 * summary:{added, removed} } where line numbers index the WORKING (new) file. `removed`
 * marks the new-file line AFTER which one or more old lines were deleted.
 *   @@ -oldStart,oldCount +newStart,newCount @@   (count defaults to 1 when omitted)
 */
function parseDiffHunks(diffText) {
  const added = [];
  const modified = [];
  const removed = [];
  let addedCount = 0;
  let removedCount = 0;
  const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  for (const line of String(diffText == null ? '' : diffText).split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    const oldCount = m[2] === undefined ? 1 : parseInt(m[2], 10);
    const newStart = parseInt(m[3], 10);
    const newCount = m[4] === undefined ? 1 : parseInt(m[4], 10);
    addedCount += newCount;
    removedCount += oldCount;
    if (oldCount === 0 && newCount > 0) {
      for (let i = 0; i < newCount; i++) added.push(newStart + i);
    } else if (newCount === 0 && oldCount > 0) {
      removed.push(Math.max(1, newStart)); // deletion sits after this working line
    } else {
      for (let i = 0; i < newCount; i++) modified.push(newStart + i);
    }
  }
  return { added, modified, removed, summary: { added: addedCount, removed: removedCount } };
}

/** Resolve a (possibly absolute) file path to repo-relative POSIX form. */
function toRepoRel(repoRoot, filePath) {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(repoRoot, filePath);
  return path.relative(repoRoot, abs).split(path.sep).join('/');
}

// SEARCH-FIX-01 (RESEARCH-SEARCH-01 §2.2, ölçüldü) — app Finder/Dock'tan açılınca çocuk
// süreçler LANG/LC_*'siz doğar → C locale → `grep -i` / `git grep -i` yalnız ASCII'yi
// katlar ("şirket" ≠ "Şirket", "geçenler" ≠ "GEÇENLER"). UTF-8 locale'i AÇIKÇA veriyoruz:
// macOS'ta `C.UTF-8` YOK (`locale -a`), `en_US.UTF-8` var; glibc ≥ 2.35 / git-bash'te
// `C.UTF-8` standart. Tanınmayan locale ASCII'ye düşer — bugünkü davranış, regresyon değil.
const TOOL_LC_ALL = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
function toolEnv() {
  // PATH oturumda değişebilir → her çağrıda taze process.env, üstüne sabit LC_ALL.
  return { ...process.env, LC_ALL: TOOL_LC_ALL };
}

/** SEARCH-FIX-01 — execFile hatasını kullanıcıya SÖYLENEBİLİR bir nedene indirger; null = hata değil. */
function toolFailure(err) {
  if (!err) return null;
  if (err.code === 'ENOENT') return 'tool-missing'; // git/grep PATH'te yok (Windows'ta grep tipik)
  if (err.killed || err.signal) return 'timeout'; // 15 sn timeout / maxBuffer → süreç öldürüldü
  return null; // exit 1 = eşleşme yok, exit 2 = okunamayan dosya vb. → stdout yine işlenir
}

function run(repoRoot, args, cb) {
  execFile('git', ['-C', repoRoot, ...args], { maxBuffer: MAX_BUF, timeout: 15000, env: toolEnv() }, cb);
}

/**
 * TASK-MQTIVZSDYPNRH — resolve the git work-tree top-level that CONTAINS `root`, or null
 * if `root` is not inside any repo. This is the heart of "resolve repoRoot to the ACTIVE
 * workspace": the editor hands us the active file's directory; we scope the search to its
 * enclosing repo (e.g. `…/CrewPane Apps/crewpane/src` → `…/CrewPane Apps/crewpane`).
 * That makes `git grep`/`git ls-files` fast + .gitignore-aware, instead of crawling the
 * whole non-git multi-project parent. Resolves null on any error (→ FS-walk fallback).
 */
function gitToplevel(root) {
  return new Promise((resolve) => {
    run(root, ['rev-parse', '--show-toplevel'], (err, stdout) => {
      const top = String(stdout || '').trim();
      resolve(!err && top ? top : null);
    });
  });
}

/**
 * TASK-MQTIVZSDYPNRH — list files under `root` WITHOUT git (non-repo / multi-project
 * root). Recursive, ignoring IGNORE_DIRS, capped at LIST_MAX. Returns POSIX paths
 * relative to `root` (so they round-trip through the workspace fileApi for open-on-click).
 */
function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    if (out.length >= LIST_MAX) break;
    const dir = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir → skip (best-effort)
    }
    for (const e of ents) {
      if (out.length >= LIST_MAX) break;
      if (IGNORE_DIRS.has(e.name)) continue;
      const fp = path.join(dir, e.name);
      let dirent = e;
      // Resolve symlinks just enough to know dir-vs-file; ignore broken links.
      if (e.isSymbolicLink()) {
        try { dirent = fs.statSync(fp); } catch { continue; }
      }
      if (dirent.isDirectory()) stack.push(fp);
      else if (dirent.isFile()) out.push(path.relative(root, fp).split(path.sep).join('/'));
    }
  }
  const sorted = out.sort();
  // SEARCH-FIX-01 — tavana takıldıysa SÖYLE: CrewPane Apps kökünde 226.522 dosyanın 12.000'i
  // taranıyordu ve bayrak yanmıyordu (%94,7 sessizce dışarıda). `partial` = liste kesik.
  sorted.partial = out.length >= LIST_MAX;
  return sorted;
}

/**
 * Diff one file (committed HEAD vs working tree) → { ok, tracked, relPath,
 * committedText, ...parseDiffHunks }. `committedText` is the HEAD blob (for the
 * side-by-side DiffEditor); empty + tracked:false when the file is new/untracked.
 */
function gitDiffFile(repoRoot, filePath) {
  return new Promise((resolve) => {
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(repoRoot, filePath);
    // TASK-MQTIX5XW2HFST — scope to the file's ENCLOSING git repo (same fix as search,
    // 73f3e5c), NOT the passed-in root. `repoRoot` is the global WORKSPACE_ROOT, which may
    // be a non-git multi-project parent ("CrewPane Apps") — there `git -C <parent> diff HEAD`
    // fails → empty hunks + empty committedText (tracked:false), so the inline diff showed
    // NO red/green and the gutter +/− summary stayed blank. Narrowing to the active file's
    // toplevel makes diff/show run inside the real repo. Falls back to `repoRoot` when the
    // file isn't inside any git repo (untracked → empty diff, exactly as before).
    gitToplevel(path.dirname(abs)).then((top) => {
      const base = top || repoRoot;
      const rel = toRepoRel(base, abs);
      if (rel.startsWith('..')) return resolve({ ok: false, reason: 'outside-repo' });
      run(base, ['diff', '--unified=0', '--no-color', 'HEAD', '--', rel], (err, stdout) => {
        // err is non-fatal here (e.g. untracked file → diff is empty). Get committed blob:
        run(base, ['show', `HEAD:${rel}`], (showErr, committed) => {
          const tracked = !showErr;
          const hunks = parseDiffHunks(stdout || '');
          resolve({
            ok: true,
            tracked,
            relPath: rel,
            committedText: tracked ? String(committed) : '',
            ...hunks,
          });
        });
      });
    });
  });
}

/**
 * All workspace files → { ok, files:[ABSOLUTE…] }. (TASK-MQTIVZSDYPNRH — returns absolute
 * paths now; main.js rebases them to its display form so they round-trip through fileApi.)
 * `root` is the editor's active workspace (active file's dir or open folder). We scope to
 * its enclosing git repo: inside a repo → `git ls-files` (tracked+untracked, .gitignore-
 * aware, FAST). NOT in a repo (the non-git "CrewPane Apps" parent → `git ls-files` failed
 * → quick-open showed ZERO files) → a .gitignore-free FS walk (IGNORE_DIRS + cap).
 */
function listWorkspaceFiles(root) {
  return new Promise((resolve) => {
    gitToplevel(root).then((top) => {
      if (top) {
        run(top, ['ls-files', '--cached', '--others', '--exclude-standard'], (err, stdout) => {
          if (err) {
            // In a repo per rev-parse but ls-files failed → degrade to a walk of `root`.
            try { const w = walkAbs(root); return resolve({ ok: true, files: w, partial: w.partial }); }
            catch (e) { return resolve({ ok: false, reason: String((e && e.message) || e), files: [] }); }
          }
          const files = String(stdout)
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((rel) => path.resolve(top, rel));
          resolve({ ok: true, files, partial: false }); // git ls-files tavansız
        });
        return;
      }
      // Not inside any git repo → filesystem walk of `root`.
      try {
        const w = walkAbs(root);
        resolve({ ok: true, files: w, partial: w.partial });
      } catch (e) {
        resolve({ ok: false, reason: String((e && e.message) || e), files: [] });
      }
    });
  });
}

/** walkFiles → absolute paths (main rebases to display form). */
function walkAbs(root) {
  const rel = walkFiles(root);
  const abs = rel.map((r) => path.resolve(root, r));
  abs.partial = rel.partial;
  return abs;
}

/**
 * Parse `grep -n`/`git grep -n` output lines (`path:lineNo:text`) INTO `hits`, capped at
 * GREP_MAX. Each emitted `file` is resolved to ABSOLUTE against `base`. Returns true once
 * the cap is reached (caller stops).
 */
function parseGrepInto(stdout, hits, base) {
  const lines = String(stdout || '').split('\n');
  for (const ln of lines) {
    if (!ln) continue;
    const i1 = ln.indexOf(':');
    const i2 = ln.indexOf(':', i1 + 1);
    if (i1 < 0 || i2 < 0) continue;
    const file = ln.slice(0, i1);
    const line = parseInt(ln.slice(i1 + 1, i2), 10);
    const text = ln.slice(i2 + 1);
    if (!Number.isFinite(line)) continue;
    hits.push({ file: path.resolve(base, file), line, text: text.length > 400 ? text.slice(0, 400) + '…' : text });
    if (hits.length >= GREP_MAX) return true;
  }
  return false;
}

/**
 * TASK-MQTIVZSDYPNRH — grep an EXPLICIT file list with system `grep` (non-git root). We
 * pass the pre-filtered file list from walkFiles() so grep never descends into ignored
 * dirs (.browser-data, node_modules, …). Batched to stay under ARG_MAX. Note: when the
 * active workspace IS a repo we use `git grep` instead (far faster on rare terms); this
 * path only runs for a plain/non-git folder.
 */
function grepFiles(root, q, files) {
  return new Promise((resolve) => {
    const hits = [];
    const BATCH = 1500;
    let idx = 0;
    const next = () => {
      if (idx >= files.length) return resolve({ hits, truncated: false });
      const batch = files.slice(idx, idx + BATCH);
      idx += BATCH;
      execFile(
        'grep',
        ['-nIH', '-F', '-i', '-e', q, '--', ...batch],
        { cwd: root, maxBuffer: MAX_BUF, timeout: 15000, env: toolEnv() },
        (err, stdout) => {
          // grep exit 1 = no match in this batch (not an error); exit 2 = unreadable file,
          // stdout still parsed. ENOENT/timeout → tell the caller instead of a silent [].
          const failure = toolFailure(err);
          if (failure) return resolve({ ok: false, reason: failure, hits, truncated: false });
          const capped = parseGrepInto(stdout, hits, root);
          if (capped) return resolve({ hits, truncated: true });
          next();
        },
      );
    };
    next();
  });
}

/**
 * Content search → { ok, hits:[{file:ABS, line, text}], truncated, partial, reason? }. Scoped to the git
 * repo enclosing `root` (the editor's active workspace): inside a repo → `git grep`
 * (fast, .gitignore-aware). NOT in a repo (the non-git "CrewPane Apps" parent — plain
 * `git grep` fails with "not a git repository" → content search returned NOTHING) → grep
 * the clean walkFiles() list with system `grep`. Empty query → [].
 */
function grepWorkspace(root, query) {
  return new Promise((resolve) => {
    const q = String(query == null ? '' : query);
    if (!q.trim()) return resolve({ ok: true, hits: [], truncated: false, partial: false });
    gitToplevel(root).then((top) => {
      if (top) {
        // `--untracked` so content search matches the file list's reach: listWorkspaceFiles
        // uses `ls-files --others --exclude-standard` (tracked + untracked, .gitignore-aware),
        // so grep must ALSO see untracked-but-not-ignored files — otherwise a freshly created
        // (uncommitted) file shows in ⌘P quick-open yet its contents are invisible to ⌘⇧F.
        run(top, ['grep', '-n', '-I', '--no-color', '--untracked', '-F', '-i', '-e', q], (err, stdout) => {
          // git grep exits 1 when there are NO matches — that's not an error for us.
          const failure = toolFailure(err);
          if (failure) return resolve({ ok: false, reason: failure, hits: [], truncated: false, partial: false });
          const hits = [];
          const truncated = parseGrepInto(stdout, hits, top);
          resolve({ ok: true, hits, truncated, partial: false });
        });
        return;
      }
      // Not inside a repo → grep the pre-filtered file list (no junk-dir traversal).
      let files;
      try {
        files = walkFiles(root);
      } catch (e) {
        return resolve({ ok: false, reason: String((e && e.message) || e), hits: [], truncated: false, partial: false });
      }
      grepFiles(root, q, files).then((r) => {
        if (r.ok === false) return resolve({ ok: false, reason: r.reason, hits: [], truncated: false, partial: false });
        // SEARCH-FIX-01 — liste tavana takıldıysa hit sayısı ne olursa olsun `partial:true`.
        resolve({ ok: true, hits: r.hits, truncated: r.truncated, partial: files.partial === true });
      });
    });
  });
}

module.exports = { parseDiffHunks, toRepoRel, gitDiffFile, listWorkspaceFiles, grepWorkspace };

// ─────────────────────────────────────────────────────────────────────────────
// TASK-MQTIX5XW2HFST — INLINE DIFF (in-file red/green toggle) · SONUÇ / KANIT
// (SCROLL_E2E_1782152441119 · dev branch · crewpane)
//
// Misyon: editörün "Diff" butonu ARTIK toggle — basınca AÇIK DOSYANIN İÇİNDE inline diff
//   (kırmızı=silinen / yeşil=eklenen / normal satır), tekrar basınca normal kod. Tam-ekran
//   ayrı DiffModal kaldırıldı.
//
// Yapılanlar:
//   1. gitDiffFile (BU DOSYA) — artık dosyanın ENCLOSING git repo'suna scope ediyor
//      (gitToplevel(dirname(abs))); WORKSPACE_ROOT non-git "CrewPane Apps" parent olduğu için
//      eskiden `git -C <parent> diff HEAD` boş dönüyordu (committedText='', tracked:false →
//      ne inline ne gutter +/− çalışıyordu). Search fix'iyle (73f3e5c) aynı desen.
//   2. electron/main.js git:diff handler — path'i active-root'a confine edip ABSOLUTE geçiyor.
//   3. src/app/components/InlineDiff.tsx (YENİ, DiffModal.tsx silindi) — Monaco DiffEditor
//      renderSideBySide:false (INLINE tek kolon), editör host'unun üstüne absolute overlay.
//   4. CodeEditorPane.tsx — diffOpen modal state → inlineDiff toggle; "Diff" butonu
//      data-active + yeşil aktif stil; tab değişince diff kapanır.
//   5. monacoLoader.ts + scripts/build-monaco.mjs — Monaco EDITOR WORKER'ı (public/monaco/
//      editor.worker.js, iife) build edip getWorker'a verdik. KÖK NEDEN: no-op worker diff'i
//      web-worker'da HESAPLATMADIĞI için red/green hiç çizilmiyordu; gerçek worker → çizildi.
//      Worker yüklenemezse no-op'a fallback (editing worker-free kalır, regresyon yok).
//
// GERÇEK e2e (Playwright-Electron, prod standalone) — e2e/inline-diff.spec.cjs:
//   ✓ committed blob non-git parent üzerinden çözüldü (tracked, 1304 B) — git-root fix
//   ✓ gutter özeti "+2 −1" doldu (eskiden boş)
//   ✓ TOGGLE ON → [data-editor-inline-diff] .monaco-diff-editor: .line-insert/char ×5 (YEŞİL)
//     + .line-delete/char ×5 (KIRMIZI); INLINE tek kolon (side-by-side DEĞİL)
//   ✓ TOGGLE OFF → overlay kalkıyor, normal kod; buton data-active=false
//   ✓ Screenshot: docs/agent-results/TASK-MQTIX5XW2HFST-screenshots/inline-diff-{on,off}.png
//   ✓ Regresyon yok: vim --INSERT--/--NORMAL-- gerçek worker'la çalışıyor; codeIntel unit 7/7;
//     tsc temiz. (code-editor.spec.cjs fail'i PRE-EXISTING: workspaceRoot=parent path bayatlığı,
//     bu değişiklikle ilgisiz — preload/o spec'e dokunulmadı.)
//
// Sonuç dosyası: docs/agent-results/TASK-MQTIX5XW2HFST-inline-diff.md
// ─────────────────────────────────────────────────────────────────────────────
