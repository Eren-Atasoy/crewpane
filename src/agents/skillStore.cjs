// CrewPane — SK-02 (ADR-SKILL-CENTER Karar 2) skill deposu: taslak/yayın İKİ katman.
//
//   <workspace>/.crewpane/
//   ├── memory/            (ADP-235 — "ne öğrendim")
//   ├── skills/            ✅ YAYINDA — motorların gördüğü TEK küme (skillEngineView bağlar)
//   └── skill-drafts/      📝 TASLAK — HİÇBİR motor yoluna bağlı DEĞİL
//
// 🔑 NEDEN İKİ DİZİN (bu tasarımın kalbi): SK-01 Ö7 ölçtü — her pane
// `--dangerously-skip-permissions` ile koşuyor (agentRunner.js:73). Yani bir skillin gövdesi
// ayrıcalığın kendisidir ve `allowed-tools` gibi alanlar bizde HİÇBİR ŞEYİ kısıtlamaz.
// Geriye tek gerçek denetim noktası kalıyor: **bir metnin bağlama girip girmediği**.
// Bu yüzden onay kapısı DOSYA SİSTEMİ seviyesindedir — ajan `skill-drafts/`e yazabilir,
// oradan hiçbir motor okuyamaz; yayın (= motor yoluna bağlanma) insan onayıyla olur.
// ADR-017'nin hafızada kurduğu disiplinin aynısı: terfi ASLA otomatik değil.
//
// Sürüm defteri YOK: skilller workspace ağacındaki dosyalardır → gerçek geçmiş git'tir
// (`git log -- .crewpane/skills/<ad>/`). `metadata.crewpane.version` insan-okur sayaç.
//
// fs kullanır ama Electron'a bağımlı DEĞİL (unit test tmp dizinlerle koşar).

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteFileSync } = require('../../platform/atomicWrite.cjs');
const F = require('./skillFormat.cjs');

const SKILLS_SUBPATH = Object.freeze(['.crewpane', 'skills']);
const DRAFTS_SUBPATH = Object.freeze(['.crewpane', 'skill-drafts']);
const SCOPES = Object.freeze(['published', 'draft']);

const DRAFTS_README =
  '# Skill TASLAKLARI — motorlara AÇIK DEĞİL\n\n' +
  'Buradaki hiçbir dosya hiçbir ajanın bağlamına giremez: bu dizin hiçbir motor yoluna\n' +
  '(`.claude/skills`, `$CODEX_HOME/skills`) bağlanmaz. Onay kapısı budur (ADR-SKILL-CENTER §3).\n\n' +
  'Yayına almak = `../skills/` altına taşımak — bunu yalnız insan onayı yapar.\n' +
  '`metadata.crewpane.status: draft` yazmak KAPI DEĞİLDİR; motorlar metadata içeriğine\n' +
  'göre davranmaz. Kapı dizindir.\n';

const SKILLS_README =
  '# YAYINDAKİ skilller — motorların gördüğü küme\n\n' +
  'Buradaki her skill `.claude/skills/<ad>` ve `$CODEX_HOME/skills/<ad>` sembolik bağları\n' +
  'üzerinden ajanların bağlamına girebilir (kopya YOK — kopya = ikinci gerçek = sapma).\n' +
  'Buraya elle dosya taşımak = onay kapısını atlamak. Taslak için `../skill-drafts/`.\n';

function validRoot(workspaceRoot) {
  return typeof workspaceRoot === 'string' && workspaceRoot.trim() ? workspaceRoot : null;
}

/** Yayındaki skill kökü: `<root>/.crewpane/skills`. Root yoksa null. */
function skillsRoot(workspaceRoot) {
  const root = validRoot(workspaceRoot);
  return root ? path.join(root, ...SKILLS_SUBPATH) : null;
}

/** Taslak kökü: `<root>/.crewpane/skill-drafts`. Root yoksa null. */
function draftsRoot(workspaceRoot) {
  const root = validRoot(workspaceRoot);
  return root ? path.join(root, ...DRAFTS_SUBPATH) : null;
}

/** Kapsam → kök dizin. Bilinmeyen kapsam null (çağıran sessizce yanlış dizine yazamasın). */
function scopeRoot(workspaceRoot, scope) {
  if (scope === 'published') return skillsRoot(workspaceRoot);
  if (scope === 'draft') return draftsRoot(workspaceRoot);
  return null;
}

/**
 * Bir skillin dizini. `name` slug'lanır ve sonuç kökün İÇİNDE kalmak zorundadır
 * (savunma: `../` ile motor yoluna sıçramak yayın kapısını atlatırdı).
 */
function skillDir(workspaceRoot, name, scope) {
  const root = scopeRoot(workspaceRoot, scope);
  if (!root) return null;
  const slug = F.safeName(name);
  const dir = path.join(root, slug);
  const rel = path.relative(root, dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return dir;
}

/** İki katmanı da (README'leriyle) kur. Idempotent. Dönen: { skills, drafts }. */
function ensureSkillScaffold(workspaceRoot) {
  const skills = skillsRoot(workspaceRoot);
  const drafts = draftsRoot(workspaceRoot);
  if (!skills || !drafts) return null;
  for (const [dir, readme] of [[skills, SKILLS_README], [drafts, DRAFTS_README]]) {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'README.md');
    if (!fs.existsSync(f)) atomicWriteFileSync(f, readme, { encoding: 'utf8' });
  }
  return { skills, drafts };
}

function readDirNames(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name)
      .filter((n) => !n.startsWith('.'))
      .sort();
  } catch {
    return [];
  }
}

function describe(workspaceRoot, name, scope) {
  const dir = skillDir(workspaceRoot, name, scope);
  if (!dir) return null;
  const file = path.join(dir, F.SKILL_FILE);
  let text = '';
  let exists = true;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    exists = false;
  }
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    /* dizin yok → entries boş */
  }
  if (!exists) {
    return {
      name,
      scope,
      dir,
      file,
      exists: false,
      ok: false,
      errors: [{ code: 'skill-md-missing', message: `${F.SKILL_FILE} yok: ${file}` }],
      warnings: [],
      frontmatter: {},
      body: '',
      description: '',
      status: null,
      text: '',
    };
  }
  const v = F.validateSkill({ text, dirName: name, entries });
  const meta = v.frontmatter && typeof v.frontmatter.metadata === 'object' ? v.frontmatter.metadata : {};
  return {
    name,
    scope,
    dir,
    file,
    exists: true,
    ok: v.ok,
    errors: v.errors,
    warnings: v.warnings,
    frontmatter: v.frontmatter,
    body: v.body,
    description: v.description,
    status: meta['crewpane.status'] || (scope === 'draft' ? 'draft' : 'published'),
    origin: meta['crewpane.origin'] || null,
    author: meta['crewpane.author'] || null,
    version: meta['crewpane.version'] || null,
    text,
  };
}

/** Bir kapsamdaki (veya 'all') skillleri listele — her biri doğrulanmış olarak. */
function listSkills(workspaceRoot, { scope = 'all' } = {}) {
  const scopes = scope === 'all' ? SCOPES : SCOPES.filter((s) => s === scope);
  const out = [];
  for (const s of scopes) {
    const root = scopeRoot(workspaceRoot, s);
    if (!root) continue;
    for (const name of readDirNames(root)) {
      const d = describe(workspaceRoot, name, s);
      if (d) out.push(d);
    }
  }
  return out;
}

/** Tek skill oku (doğrulanmış). Yoksa null. */
function readSkill(workspaceRoot, name, scope) {
  const dir = skillDir(workspaceRoot, name, scope);
  if (!dir || !fs.existsSync(dir)) return null;
  return describe(workspaceRoot, F.safeName(name), scope);
}

/**
 * TASLAK yaz. Ajanların tek yazma yolu budur — `skills/`e yazmak API'de YOK
 * (yayın ayrı bir fiil ve insan onayına bağlı).
 * Geçersiz içerik diske YAZILMAZ: bozuk bir taslak, incelemesi zaman yiyen bir gürültüdür.
 */
function writeDraft(workspaceRoot, { name, description, body, license, metadata } = {}) {
  const slug = F.safeName(name);
  const dir = skillDir(workspaceRoot, slug, 'draft');
  if (!dir) return { ok: false, errors: [{ code: 'no-workspace', message: 'workspaceRoot yok/geçersiz' }] };

  const meta = { 'crewpane.status': 'draft', ...(metadata && typeof metadata === 'object' ? metadata : {}) };
  meta['crewpane.status'] = 'draft'; // taslak dosyası KENDİNİ yayında ilan edemez
  if (!meta['crewpane.version']) meta['crewpane.version'] = '1';

  const { content } = F.composeSkillMd({ name: slug, description, license, metadata: meta, body });
  const v = F.validateSkill({ text: content, dirName: slug, entries: [] });
  if (!v.ok) return { ok: false, errors: v.errors, warnings: v.warnings };

  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, F.SKILL_FILE);
  atomicWriteFileSync(file, content, { encoding: 'utf8' });
  return { ok: true, name: slug, dir, file, errors: [], warnings: v.warnings };
}

/**
 * TASLAK → YAYIN (insan onayı; tek terfi noktası).
 * • Lint KIRMIZIysa terfi YOK (yayın = tüm ekibe koşulsuz yordam dağıtmak).
 * • Kaynak dizin TAŞINIR (kopya bırakılmaz) — iki gerçek olmaz.
 * • Aynı adlı yayın varsa `overwrite` şart; sürüm sayacı artırılır.
 * • `reviewedBy`/`reviewedAt` damgalanır (T5 bayatlık rozetinin veri kaynağı).
 */
function publishDraft(workspaceRoot, name, { reviewedBy, reviewedAt, overwrite = false } = {}) {
  const slug = F.safeName(name);
  const src = skillDir(workspaceRoot, slug, 'draft');
  const dst = skillDir(workspaceRoot, slug, 'published');
  if (!src || !dst) return { ok: false, errors: [{ code: 'no-workspace', message: 'workspaceRoot yok/geçersiz' }] };
  if (!fs.existsSync(path.join(src, F.SKILL_FILE))) {
    return { ok: false, errors: [{ code: 'draft-missing', message: `Taslak yok: ${src}` }] };
  }

  const draft = describe(workspaceRoot, slug, 'draft');
  if (!draft.ok) return { ok: false, errors: draft.errors, warnings: draft.warnings };

  const existing = fs.existsSync(dst) ? describe(workspaceRoot, slug, 'published') : null;
  if (existing && !overwrite) {
    return {
      ok: false,
      errors: [{ code: 'already-published', message: `Zaten yayında: ${slug} (üzerine yazmak için overwrite)` }],
    };
  }

  // Sürüm = "kaçıncı YAYIN" sayacı: ilk yayın 1, her overwrite bir artar. Taslağın kendi
  // sayacı bilerek yok sayılır (taslak defalarca yeniden yazılır, o bir yayın değildir).
  const prev = existing && existing.version ? parseInt(existing.version, 10) : 0;
  const version = String((Number.isFinite(prev) && prev > 0 ? prev : 0) + 1);

  const meta = { ...(draft.frontmatter.metadata || {}) };
  meta['crewpane.status'] = 'published';
  meta['crewpane.version'] = version;
  if (reviewedBy) meta['crewpane.reviewedBy'] = reviewedBy;
  if (reviewedAt) meta['crewpane.reviewedAt'] = reviewedAt;

  const { content } = F.composeSkillMd({
    name: slug,
    description: draft.frontmatter.description,
    license: draft.frontmatter.license,
    compatibility: draft.frontmatter.compatibility,
    metadata: meta,
    body: draft.body,
  });
  const check = F.validateSkill({ text: content, dirName: slug, entries: [] });
  if (!check.ok) return { ok: false, errors: check.errors, warnings: check.warnings };

  // Taşı: önce hedefi temizle (overwrite), sonra rename; rename farklı aygıtta düşerse
  // kopyala+sil (sessiz başarısızlık YOK — hata çağırana gider).
  if (existing) fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    fs.renameSync(src, dst);
  } catch (err) {
    if (err && err.code === 'EXDEV') {
      fs.cpSync(src, dst, { recursive: true });
      fs.rmSync(src, { recursive: true, force: true });
    } else throw err;
  }
  atomicWriteFileSync(path.join(dst, F.SKILL_FILE), content, { encoding: 'utf8' });

  return { ok: true, name: slug, dir: dst, file: path.join(dst, F.SKILL_FILE), version, errors: [], warnings: check.warnings };
}

module.exports = {
  SKILLS_SUBPATH,
  DRAFTS_SUBPATH,
  SCOPES,
  skillsRoot,
  draftsRoot,
  scopeRoot,
  skillDir,
  ensureSkillScaffold,
  listSkills,
  readSkill,
  writeDraft,
  publishDraft,
};
