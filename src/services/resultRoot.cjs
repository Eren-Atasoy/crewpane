// CrewPane — RES-IDX-01: SONUÇ RAPORU KÖKÜ görevin PROJESİNDEN türer (tek kural, tek yer).
//
// ─────────────────────────────────────────────────────────────────────────────
// KÖK NEDEN (BUG-R3 §1.8, 2026-08-30 — ÖLÇÜLDÜ)
// ─────────────────────────────────────────────────────────────────────────────
// Rapor yolu worker'ın ÇIKARIMINA kalıyordu: kimlik metni GÖRELİ `docs/agent-results/…`
// diyor, pane cwd'si ise workspace PARENT'ı ("CrewPane Apps" — git deposu bile değil,
// `departmentDirs.cjs` bilinmeyen departmanı köke düşürür). Aynı sprintte raporlar ÜÇ
// yere düştü (skool / crewpane / kök + sembolik bağ), `npm run results:index` kökte ve
// skool'da "Missing script" verdi, supervisor beklediği tek yolda dosyayı bulamayınca
// BİTMİŞ işi `failed` damgaladı.
//
// KURAL: sonuç kökü = görevin PROJESİNİN repo dizini. Çözüm sırası (ilk VAR OLAN kazanır):
//   1. `projectRepos.resolveProjectRepo(project)` — settings.projectRepos / worktrees.json /
//      `<root>/<slug>` / `<root>` (yalnız GERÇEK git deposu)
//   2. `dirForDepartment(project)` — ofis kanadı eşlemesi (education→skool gibi), kök hariç
//   3. `<root>/crewpane` — protokol hedefi (kurulu workspace'te crewpane kökün ALTINDADIR)
//   4. `<root>` — dev checkout (kökün kendisi repo) ya da son çare (LOGLANIR: bu durum
//      raporun yine "kimsesiz" kalacağı hâldir; sessiz geçilmez)
//
// Bu modül İKİ tüketiciye hizmet eder ve ikisi AYNI cevabı alır (ikinci uygulama YOK):
//   • delegasyon prompt'u (renderer, IPC `dlgsup:resultRoot` üzerinden): worker'a yol
//     MUTLAK ve TEK yazılır; yeniden denemede `<KOD>-<ajan>-2.md` (OTOPILOT-KURALLARI §3).
//   • supervisor kanıt adayları (`evidencePath.cjs`): beklenen yol yoksa aday köklerin
//     `docs/agent-results/` dizinleri TARANIR ve rapor "başka kökte bulundu" der.
//
// Leaf modül (node builtins + projectRepos + departmentDirs) → `node --test` doğrudan koşar.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveProjectRepo } = require('../config/projectRepos.cjs');
const { dirForDepartment } = require('../agents/departmentDirs.cjs');

/** Ofis sözleşmesinin sabit alt yolu (agentIdentity.RESULT_REPORT_BASELINE ile aynı). */
const RESULTS_SUBDIR = path.join('docs', 'agent-results');

/** `dir` gerçekten var olan bir dizin mi? Asla throw etmez. */
function isDir(dir) {
  if (typeof dir !== 'string' || !dir) return false;
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Bir projenin (board `tasks.project` / ofis departman slug'ı) SONUÇ KÖKÜNÜ çöz.
 *
 * @param {string} project  slug ('crewpane', 'education', 'pazarlama' …)
 * @param {string} workspaceRoot  main'in yetkili workspace kökü
 * @param {{settings?:object, store?:object, homedir?:string, mapping?:object,
 *          log?:(s:string)=>void, isDir?:(d:string)=>boolean, exists?:(d:string)=>boolean}} deps
 *   `isDir`/`exists` dikişleri testi gerçek dosya sistemine bağımlı bırakmaz.
 * @returns {{root:string, source:string, fallback:boolean}|null}
 *   `fallback:true` → kural bir proje dizini BULAMADI, kök döndü (çağıran uyarmalı).
 */
function resolveResultRoot(project, workspaceRoot, deps = {}) {
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const dirOk = typeof deps.isDir === 'function' ? deps.isDir : isDir;
  const root = typeof workspaceRoot === 'string' && workspaceRoot ? path.resolve(workspaceRoot) : '';
  if (!root) return null;
  const slug = typeof project === 'string' ? project.trim().toLowerCase() : '';

  // (1) proje → git deposu (settings.projectRepos, worktrees.json, <root>/<slug>, <root>)
  if (slug) {
    const repo = resolveProjectRepo(slug, root, {
      settings: deps.settings,
      store: deps.store,
      homedir: deps.homedir,
      exists: deps.exists,
      log,
    });
    if (repo && repo.repoPath) return { root: path.resolve(repo.repoPath), source: `projectRepos:${repo.source}`, fallback: false };
  }
  // (2) ofis kanadı eşlemesi (kökün kendisi değilse)
  if (slug) {
    try {
      const dept = dirForDepartment(slug, root, deps.mapping);
      if (dept && path.resolve(dept) !== root && dirOk(dept)) return { root: path.resolve(dept), source: 'departmentDirs', fallback: false };
    } catch {
      /* best-effort */
    }
  }
  // (3) protokol hedefi: kurulu workspace'te crewpane kökün altındadır
  const proto = path.join(root, 'crewpane');
  if (dirOk(proto)) {
    log(`resultRoot: '${slug || '-'}' için proje dizini yok → protokol hedefi ${proto}`);
    return { root: proto, source: '<workspaceRoot>/crewpane', fallback: true };
  }
  // (4) kök — son çare, LOGLANIR
  log(`resultRoot: '${slug || '-'}' için hiçbir proje dizini yok → kök ${root} (rapor kimsesiz kalabilir)`);
  return { root, source: '<workspaceRoot>', fallback: true };
}

/**
 * Sonuç dosyası MUTLAK yolu. `attempt` ≥ 2 ise `<KOD>-<ajan>-<n>.md` (OTOPILOT §3:
 * yeniden denemede yol DEĞİŞİR; aynı yola "güncelle" supervisor'ı eski dosyayı kanıt
 * sanmaya iter). Saf.
 */
function resultReportPath(root, code, agentToken, attempt) {
  const n = Number.isInteger(attempt) && attempt >= 2 ? `-${attempt}` : '';
  return path.join(root, RESULTS_SUBDIR, `${code}-${agentToken}${n}.md`);
}

/**
 * `<root>/docs/agent-results/` altında `<code>-` ile başlayan MEVCUT dosya adları
 * (yeniden-deneme numarası bunlardan türer). Dizin yoksa boş liste. Asla throw etmez.
 */
function existingReportsFor(root, code) {
  if (!root || !code) return [];
  const dir = path.join(root, RESULTS_SUBDIR);
  const prefix = `${String(code).toLowerCase()}-`;
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().startsWith(prefix) && f.toLowerCase().endsWith('.md'))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Yeniden-deneme numarası: `<code>-<token>.md` (ve `-2`, `-3`…) zaten varsa bir sonraki
 * boş numara; hiçbiri yoksa 1 (ek yok). Saf — `existing` dosya adı listesidir.
 */
function nextAttempt(existing, code, agentToken) {
  const base = `${String(code).toLowerCase()}-${String(agentToken).toLowerCase()}`;
  const taken = new Set((existing || []).map((f) => String(f).toLowerCase()));
  if (!taken.has(`${base}.md`)) return 1;
  let n = 2;
  while (taken.has(`${base}-${n}.md`)) n++;
  return n;
}

/**
 * Bu kökte `npm run results:index` VAR mı? (package.json → scripts["results:index"]).
 * OTOPILOT §8 "varsa" ibaresinin ölçülebilir hâli: script yoksa worker'a indeks adımı
 * DAYATILMAZ (BUG-R3: kökte ve skool'da "Missing script" → FAIL:st2).
 */
function hasResultsIndexScript(root) {
  if (!root) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return !!(pkg && pkg.scripts && typeof pkg.scripts['results:index'] === 'string');
  } catch {
    return false;
  }
}

/**
 * Workspace kökünün DOĞRUDAN alt dizinleri (gizli ve node_modules hariç), alfabetik.
 * Var olan proje dizinleridir — `docs/agent-results` içermesi ŞART DEĞİL (sonradan doğan
 * rapor dizininin ADAYI olarak da kullanılır, bkz. reportResultDirs). Asla throw etmez.
 */
function projectDirsUnder(workspaceRoot) {
  const root = typeof workspaceRoot === 'string' && workspaceRoot ? path.resolve(workspaceRoot) : '';
  if (!root) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map((e) => path.join(root, e.name))
    .sort();
}

/**
 * Supervisor tarama tabanı: workspace kökünün ALTINDAKİ, `docs/agent-results/` dizini
 * OLAN proje dizinleri (tek seviye — `<root>/<proje>/docs/agent-results`). Kökün kendisi de
 * (varsa) girer. Sıra alfabetik (deterministik). Asla throw etmez.
 *
 * NEDEN: "beklenen dosya yok" hükmünden önce raporun BAŞKA bir repoya düşüp düşmediği
 * ölçülmeli (aynı sprintte skool/crewpane/kök — üç yer). Sabit aday listesi (cwd,
 * dept, crewpane, kök) bunu kaçırıyordu.
 */
function resultRootsUnder(workspaceRoot, deps = {}) {
  const root = typeof workspaceRoot === 'string' && workspaceRoot ? path.resolve(workspaceRoot) : '';
  if (!root) return [];
  const dirOk = typeof deps.isDir === 'function' ? deps.isDir : isDir;
  const out = [];
  if (dirOk(path.join(root, RESULTS_SUBDIR))) out.push(root);
  for (const p of projectDirsUnder(root)) {
    if (dirOk(path.join(p, RESULTS_SUBDIR))) out.push(p);
  }
  return out;
}

/**
 * REPORTS-ROOT-01 (FB-1007) — AYARLA/DEFTERLE EŞLENMİŞ proje repo kökleri.
 * `settings.projectRepos` anahtarları + `worktrees.json` projeleri, her biri
 * `resolveProjectRepo` ile (supervisor'ın kullandığı AYNI kural) çözülür; çözülemeyen
 * (repo değil) atlanır. Kök DIŞINDAKİ bir repo yalnız bu yoldan görünür. Asla throw etmez.
 *
 * @param {string} workspaceRoot
 * @param {{settings?:object, store?:object, homedir?:string, log?:(s:string)=>void}} deps
 * @returns {string[]} mutlak repo kökleri (tekil, alfabetik)
 */
function mappedProjectRoots(workspaceRoot, deps = {}) {
  const root = typeof workspaceRoot === 'string' && workspaceRoot ? path.resolve(workspaceRoot) : '';
  if (!root) return [];
  const slugs = new Set();
  const mapping = deps.settings && deps.settings.projectRepos;
  if (mapping && typeof mapping === 'object' && !Array.isArray(mapping)) {
    for (const k of Object.keys(mapping)) slugs.add(String(k).trim().toLowerCase());
  }
  if (deps.store && typeof deps.store.listProjects === 'function') {
    try {
      const stored = deps.store.listProjects(deps.homedir) || {};
      for (const k of Object.keys(stored)) slugs.add(String(k).trim().toLowerCase());
    } catch {
      /* defter hatası listeyi durdurmaz */
    }
  }
  const out = new Set();
  for (const slug of slugs) {
    if (!slug) continue;
    const repo = resolveProjectRepo(slug, root, {
      settings: deps.settings, store: deps.store, homedir: deps.homedir, log: () => {},
    });
    if (repo && repo.repoPath) out.add(path.resolve(repo.repoPath));
  }
  return [...out].sort();
}

/**
 * REPORTS-ROOT-01 (FB-1007) — RAPORLAR SEKMESİNİN okuyacağı/izleyeceği `docs/agent-results`
 * ADAYLARI. Supervisor'ın kök kuralıyla TEK kaynak (ikinci uygulama YOK):
 *   • `<root>/docs/agent-results`
 *   • `<root>/<proje>/docs/agent-results` — kökün HER doğrudan alt dizini için. Dizinin VAR
 *     OLMASI ŞART DEĞİL: sonradan doğan (ilk rapor yazılınca `mkdir -p` ile oluşan) dizin de
 *     adaydır; izleyici bu adayları bekler, okuyucu var-olmayanı sessizce atlar.
 *   • `deps.extraRoots` (mappedProjectRoots çıktısı — kök dışındaki eşlenmiş repolar) için
 *     `<repo>/docs/agent-results`.
 * Sıra: kök → alt projeler (alfabetik) → eşlenmiş repolar; `path.resolve` ile tekil.
 * Asla throw etmez; kök yoksa [].
 *
 * @param {string} workspaceRoot
 * @param {{extraRoots?: string[]}} [deps]
 * @returns {string[]}
 */
function reportResultDirs(workspaceRoot, deps = {}) {
  const root = typeof workspaceRoot === 'string' && workspaceRoot ? path.resolve(workspaceRoot) : '';
  if (!root) return [];
  // `<root>/docs` kökün KENDİ doküman klasörüdür, proje değil (`<root>/docs/docs/agent-results`
  // hiç var olmaz; izleyiciye boş bir ata izlemesi açtırmasın).
  const bases = [root, ...projectDirsUnder(root).filter((p) => path.basename(p) !== 'docs')];
  for (const r of Array.isArray(deps.extraRoots) ? deps.extraRoots : []) {
    if (typeof r === 'string' && r.trim()) bases.push(path.resolve(r.trim()));
  }
  const seen = new Set();
  const out = [];
  for (const b of bases) {
    const dir = path.join(b, RESULTS_SUBDIR);
    const key = path.resolve(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

/**
 * REPORTS-ROOT-01 — env'den gelen yol listesi: `A<path.delimiter>B` → ['A','B'];
 * boş/undefined → []. Boş parçalar atılır. (CREWPANE_PROJECT_ROOTS / _EXTRA_REPORT_DIRS.)
 * @param {unknown} value
 * @returns {string[]}
 */
function splitPathList(value) {
  if (typeof value !== 'string' || !value.trim()) return [];
  return value.split(path.delimiter).map((s) => s.trim()).filter(Boolean);
}

module.exports = {
  RESULTS_SUBDIR,
  resolveResultRoot,
  resultReportPath,
  existingReportsFor,
  nextAttempt,
  hasResultsIndexScript,
  resultRootsUnder,
  projectDirsUnder,
  mappedProjectRoots,
  reportResultDirs,
  splitPathList,
};
