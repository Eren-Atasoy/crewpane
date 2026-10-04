// CrewPane — B-01 Faz C: PROJE SLUG → REPO DİZİNİ (GIT-BACKBONE-SPEC K2, açık soru A-1).
//
// `departmentDirs.cjs`'in KARDEŞİ, ama farklı bir soruyu cevaplar:
//   departmentDirs: "bu OFİS KANADI hangi dizinde çalışır"  (pane cwd'si)
//   projectRepos  : "bu BOARD PROJESİ hangi git REPO'su"     (branch/worktree kökü)
// İkisi bugün karışıyor ve A-1 tam olarak bu karışıklık: `crewpane` departmanı
// `DEPARTMENT_SUBPATH.crewpane = []` yüzünden workspace PARENT'ına düşüyor
// ("CrewPane Apps") ve orası bir git deposu bile DEĞİL (📏 B-01k §1.1). Bir görevi
// izole etmek için oradan branch açılamaz.
//
// ─────────────────────────────────────────────────────────────────────────────
// A-1 KARARI: SLUG ÇÖZÜMÜ, DEPARTMAN ÇÖZÜMÜNDEN AYRI TUTULUR
// ─────────────────────────────────────────────────────────────────────────────
// `departmentDirs`'i "crewpane → <root>/crewpane" diye değiştirmek DAHA GENİŞ bir
// değişiklikti: bugünkü kanıt yolu adayları (evidencePath §3/§4) ve notify-log yolu
// o kökten türüyor ve hepsi aynı anda kayardı. Bu modül SLUG'ı çözer ve YALNIZ git
// omurgası (ensure/merge) tarafından kullanılır — bugünkü pane cwd davranışı
// izolasyon kapalıyken bit-bit AYNI kalır. (İzolasyon AÇIKKEN cwd zaten worktree'dir,
// yani departman çözümü o yolda hiç devreye girmez.)
//
// ÇÖZÜM SIRASI (ilk GERÇEK git deposu kazanır):
//   1. Kullanıcı ayarı  `settings.projectRepos[<slug>]`  (mutlak ya da köke göreli)
//   2. Yerel defter     `worktrees.json → projects[<slug>].repoPath`
//   3. `<workspaceRoot>/<slug>`      ← A-1'i çözen satır: crewpane → …/CrewPane Apps/crewpane
//   4. `<workspaceRoot>` (kökün KENDİSİ repo ise — dev checkout kurulumu)
// Hiçbiri repo değilse `null`. Bu, "repo yok" hâlini SESSİZ bir varsayılana
// çevirmemek içindir: worktreeService null gördüğünde `isolation:'worktree'` ise
// spawn'ı DURDURUR (H-5), asla paylaşımlı ağaca düşmez.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * `dir` bir git çalışma ağacının KÖKÜ mü? (`.git` dizin ya da worktree'nin
 * `gitdir:` dosyası). Alt dizinlerde `true` DÖNMEZ: repo kökü değil de bir alt
 * dizin seçilirse `git worktree add` yine çalışırdı ama defterdeki `repoPath`
 * anlamsız olurdu ve `topLevel()` çözümü sessizce başka bir yere kayardı.
 */
function isRepoRoot(dir) {
  if (typeof dir !== 'string' || !dir) return false;
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

/** Ayardan gelen değeri mutlak yola çevir (göreli → workspace köküne göre). */
function resolveSetting(value, workspaceRoot) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const v = value.trim();
  return path.isAbsolute(v) ? path.normalize(v) : path.resolve(workspaceRoot || process.cwd(), v);
}

/**
 * Proje slug'ının repo dizinini çöz.
 *
 * @param {string} slug board `tasks.project` değeri ('crewpane')
 * @param {string} workspaceRoot main'in yetkili workspace kökü
 * @param {{settings?:object, store?:object, homedir?:string, log?:(s:string)=>void, exists?:(d:string)=>boolean}} deps
 *   `exists` dikişi testin gerçek dosya sistemine bağımlı kalmamasını sağlar.
 * @returns {{repoPath:string, source:string}|null}
 */
function resolveProjectRepo(slug, workspaceRoot, deps = {}) {
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const exists = typeof deps.exists === 'function' ? deps.exists : isRepoRoot;
  const s = typeof slug === 'string' ? slug.trim().toLowerCase() : '';
  const root = typeof workspaceRoot === 'string' && workspaceRoot ? workspaceRoot : '';
  if (!s || !root) return null;

  const candidates = [];
  const mapping = deps.settings && deps.settings.projectRepos;
  if (mapping && typeof mapping === 'object' && !Array.isArray(mapping)) {
    const fromSetting = resolveSetting(mapping[s], root);
    if (fromSetting) candidates.push({ repoPath: fromSetting, source: 'settings.projectRepos' });
  }
  if (deps.store && typeof deps.store.getProject === 'function') {
    try {
      const rec = deps.store.getProject(s, deps.homedir);
      if (rec && rec.repoPath) candidates.push({ repoPath: rec.repoPath, source: 'worktrees.json' });
    } catch {
      /* defter hatası çözümü durdurmaz */
    }
  }
  // A-1: workspace kökünün ALTINDAKİ proje dizini. `crewpane` slug'ı burada
  // ".../CrewPane Apps/crewpane"e bağlanır (bugün parent'a düşüyordu).
  candidates.push({ repoPath: path.resolve(root, s), source: '<workspaceRoot>/<slug>' });
  // Dev checkout: workspace kökünün KENDİSİ repo.
  candidates.push({ repoPath: path.resolve(root), source: '<workspaceRoot>' });

  for (const c of candidates) {
    if (exists(c.repoPath)) return c;
  }
  log(
    `projectRepos: '${s}' için git deposu bulunamadı — denenen: ${candidates.map((c) => c.repoPath).join(' | ')}`,
  );
  return null; // SESSİZ varsayılan YOK: çağıran (worktreeService) fail-closed davranır
}

module.exports = { isRepoRoot, resolveProjectRepo };
