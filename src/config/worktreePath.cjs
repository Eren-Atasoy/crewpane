// CrewPane — B-01 Faz A: WORKTREE YOL TÜRETME + KUM HAVUZU (GIT-BACKBONE-SPEC K4, G-3).
//
//     <workspaceRoot>/.crewpane/worktrees/<proje-slug>/<kod-slug>
//
// ─────────────────────────────────────────────────────────────────────────────
// NEDEN TAM OLARAK BURASI (K4 — pazarlık dışı)
// ─────────────────────────────────────────────────────────────────────────────
// `evidencePath.cjs` her kanıt adayının workspace kökünün İÇİNDE olmasını ŞART
// koşar (`withinRoot`). Worktree kökün DIŞINA konursa (ör. `~/.crewpane/worktrees`)
// o guard izole koşan HER görevin kanıt dosyasını reddeder → supervisor "beklenen
// çıktı yok" der → her görev SAHTE-FAIL alır (bulgu F-7). Yani worktree'nin yeri bir
// tercih değil, mevcut kanıt zincirinin dayattığı bir KISITTIR.
// İkinci gerekçe: `.crewpane/` repo'da gitignore'dur (.gitignore:67) → workspace
// kökü repo'nun KENDİSİ olsa bile iç içe worktree kirliliği olmaz.
//
// ─────────────────────────────────────────────────────────────────────────────
// G-3 — YOL TRAVERSALİ
// ─────────────────────────────────────────────────────────────────────────────
// Proje slug'ı ve görev kodu SERBEST METİNDEN (board `tasks.project`, spawn etiketi)
// gelir. `path.join(root, '.crewpane/worktrees', '../../../../etc', 'x')` sessizce
// kökün dışına çıkar. Bu yüzden: (a) her parça dar bir alfabeden geçer, (b) `resolve`
// SONRASI yol worktrees kökünün altında olmak ZORUNDADIR, (c) ihlal TEMİZLENMEZ,
// REDDEDİLİR (temizlemek saldırgan girdiyi zararsız gösterirdi).
//
// SAF: yalnız `node:path` + `taskCode.cjs`. fs YOK → `node --test` doğrudan koşar.

'use strict';

const path = require('node:path');
const taskCode = require('../agents/taskCode.cjs');

/** `.crewpane/worktrees` — crewpanePaths'in `tasks`/`results` kardeşi. */
const WORKTREES_SUBPATH = Object.freeze(['.crewpane', 'worktrees']);

/** Proje slug alfabesi: board `tasks.project` serbest TEXT olduğu için DAR tutulur. */
const PROJECT_RE = /^[a-z0-9][a-z0-9._-]{0,48}$/;

/** `abs`, `root` ağacının içinde mi? (evidencePath.withinRoot ile BİREBİR aynı kural.) */
function withinRoot(abs, root) {
  if (!root) return false;
  const r = path.resolve(root);
  const a = path.resolve(abs);
  return a === r || a.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/** Proje slug'ını normalize et; politika dışıysa null (temizleme YOK). */
function projectSlug(project) {
  if (typeof project !== 'string') return null;
  const s = project.trim().toLowerCase();
  if (!s || !PROJECT_RE.test(s)) return null;
  if (s.includes('..')) return null;
  return s;
}

/** `<workspaceRoot>/.crewpane/worktrees` — tüm worktree'lerin ortak kökü. */
function worktreesRoot(workspaceRoot) {
  if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) return null;
  return path.join(workspaceRoot, ...WORKTREES_SUBPATH);
}

/**
 * Bir görevin worktree yolunu türet (SAF).
 *
 * @param {string} workspaceRoot main'in yetkili workspace kökü
 * @param {string} project board proje slug'ı ('crewpane')
 * @param {string} code görev kodu ('B-01' | 'b-01' | 'TASK-…')
 * @returns {{ok:true, path:string, project:string, code:string} | {ok:false, why:string}}
 */
function worktreePathFor(workspaceRoot, project, code) {
  const base = worktreesRoot(workspaceRoot);
  if (!base) return { ok: false, why: 'workspace kökü yapılandırılmamış' };
  const proj = projectSlug(project);
  if (!proj) return { ok: false, why: `geçersiz proje slug'ı: ${JSON.stringify(project)}` };
  const slug = taskCode.codeSlug(code);
  if (!slug) return { ok: false, why: `geçersiz görev kodu: ${JSON.stringify(code)}` };

  const abs = path.resolve(base, proj, slug);
  // Kuşak kemeri: parçalar zaten süzüldü, ama nihai hüküm RESOLVE SONRASI verilir —
  // bu, gelecekteki bir alfabe gevşemesinin sessizce traversal açmasını engeller.
  if (!withinRoot(abs, base)) {
    return { ok: false, why: `yol worktrees kökünün dışına çıkıyor: ${abs}` };
  }
  if (!withinRoot(abs, workspaceRoot)) {
    return { ok: false, why: `yol workspace kökünün dışına çıkıyor: ${abs}` };
  }
  return { ok: true, path: abs, project: proj, code: slug };
}

/**
 * Yolun SEMBOLİK BAĞLARDAN ARINDIRILMIŞ hâli (çözülemezse yolun kendisi).
 *
 * 🪤 NEDEN GEREKLİ (entegrasyon testi yakaladı): `git worktree list` yolları
 * GERÇEK yol olarak basar. macOS'ta `/tmp` → `/private/tmp` ve `/var` → `/private/var`
 * birer symlink'tir; bizim ürettiğimiz `/var/folders/…/ws/.crewpane/worktrees/x`
 * ile git'in bildirdiği `/private/var/folders/…/x` DİZE OLARAK EŞİT DEĞİLDİR. Saf
 * `path.resolve` karşılaştırması bu yüzden "bu worktree bize ait değil" der →
 * `isManagedWorktree` kapısı KENDİ ağacımızı reddeder (reaper kaçak sanır, release
 * G-9'a takılır). Kullanıcının workspace'i de bir symlink altında olabilir
 * (`~/Documents` iCloud yönlendirmesi gibi) — yani bu yalnız bir test artefaktı değil.
 */
function realpath(p) {
  try {
    // Lazy require: modül fs'siz kalabilsin diye üstte değil (saf yol hesapları
    // fs'e HİÇ dokunmaz; yalnız bu karşılaştırma dokunur).
    return require('node:fs').realpathSync.native(p);
  } catch {
    return p;
  }
}

/** `withinRoot`, ama iki tarafı da symlink'lerden arındırarak (git çıktısı için). */
function withinRootReal(abs, root) {
  if (withinRoot(abs, root)) return true;
  return withinRoot(realpath(abs), realpath(root));
}

/**
 * Bir yol BİZİM ürettiğimiz worktree ağacının içinde mi? (defter/temizlik kapısı)
 * `worktree remove` gibi YIKICI işlemler bunu geçmeden koşmaz (G-9).
 */
function isManagedWorktree(workspaceRoot, candidate) {
  const base = worktreesRoot(workspaceRoot);
  if (!base || typeof candidate !== 'string' || !candidate) return false;
  const abs = path.resolve(candidate);
  if (path.resolve(base) === abs || realpath(base) === realpath(abs)) return false; // kökün KENDİSİ değil
  return withinRootReal(abs, base);
}

/** İki yol aynı yeri mi gösteriyor? (symlink farkına rağmen) */
function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  if (path.resolve(a) === path.resolve(b)) return true;
  return realpath(path.resolve(a)) === realpath(path.resolve(b));
}

module.exports = {
  WORKTREES_SUBPATH,
  PROJECT_RE,
  withinRoot,
  withinRootReal,
  realpath,
  samePath,
  projectSlug,
  worktreesRoot,
  worktreePathFor,
  isManagedWorktree,
};
