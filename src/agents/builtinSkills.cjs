// CrewPane — SKL-B6: GÖMÜLÜ KATALOG → KANONİK DEPO kurulum boğazı.
//
// Paketle gelen salt-okunur katalog (`Resources/builtin-skills/`, SKL-B5) ile kullanıcının
// kanonik deposu (`<workspace>/.crewpane/skills/`, SK-02) arasındaki TEK köprü budur.
// Yeni indiren kullanıcı uygulamayı açtığında skill'leri HAZIR bulur; sürüm yükseltmesi
// yeni/güncel skill'leri getirir; kullanıcının ELLE DEĞİŞTİRDİĞİ kopyaya DOKUNULMAZ.
//
// ── ÜÇ SÖZLEŞME (üçü de kodun ulaşamadığı durum, niyet değil) ──────────────────
//
// 1) `publishDraft`e ERİŞİM YOK (tasarım §2.2 · SK-08 (a) deseni). Bu modül taslak
//    katmanına hiç uğramaz: katalog içeriği zaten İKİ kapıdan geçmiştir (SKL-B4 lint
//    kapısı + Kapı-3 gerçek-iş testi) ve kurulum bir YAYIN fiilidir. Yazım kendi
//    atomik yazıcısındadır; `skillStore.writeDraft`/`publishDraft` çağrılmaz —
//    `skillGuard.PRIVILEGED` nöbetçisi bunu kaynak seviyesinde ölçer.
//
// 2) İÇE-AKTARIM SÜZGECİ AYNEN GEÇERLİ. `skillShare.importSkillText`in üç değişmezi
//    burada da koşar ve tekrar YAZILMAZ, ÇAĞRILIR/YENİDEN KULLANILIR:
//      • yabancı onay damgaları SÖKÜLÜR (`skillShare.STRIPPED_ON_IMPORT`)
//      • sır taraması (`skillSecretScan`) — bulgu varsa kurulum DURUR
//      • provenans yazılır (`origin: builtin` + kaynak + sha256 + upstreamCommit)
//    Katalog "bizim" diye istisna açılmaz: imzalı paket bile diskte kurcalanabilir
//    (SKL-B5 açık soru-1) — bu yüzden kurulumdan ÖNCE beyan/dosya sha256'sı ölçülür.
//
// 3) SESSİZ ÜZERİNE YAZMA YOK (tasarım §2.5). Üç ayrı durum, üç ayrı cevap:
//      • aynı adlı KULLANICI skill'i var          → kurulmaz, `<ad>-builtin` önerilir
//      • kurulu kopya KULLANICI TARAFINDAN değişmiş → çatal KORUNUR, güncelleme beklemede
//      • kurulu kopya bizim yazdığımız gibi duruyor → yükseltmede sessizce tazelenir
//    Üçüncüsü bir istisna DEĞİL: orada üzerine yazılan baytların tamamını bu modül
//    yazmıştı, yani kullanıcının kaybedecek bir şeyi yok. Kaybı olan tek durum
//    ikincisidir ve orası dokunulmazdır.
//
// ── KULLANICI KAPATIRSA (kalıcı) ───────────────────────────────────────────────
// `uninstall` bir tercih kaydıdır: adı `.crewpane/builtin-skills.json` içindeki
// `optOut` listesine yazar. Aksi hâlde bir sonraki açılış kullanıcının kaldırdığı
// skill'i geri kurar ve "kapat" düğmesi yalan söylerdi. Durum DOSYADAN türetilir,
// ad kontrolünden değil.
//
// Electron'a bağımlı DEĞİL (fs + saf modüller) → birim testi tmp dizinlerle koşar.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { atomicWriteFileSync } = require('../../platform/atomicWrite.cjs');
const F = require('./skillFormat.cjs');
const skillStore = require('./skillStore.cjs');
const skillShare = require('./skillShare.cjs'); // yalnız STRIPPED_ON_IMPORT (davranışı değiştirilmez)
const secretScan = require('./skillSecretScan.cjs');
const builtinPath = require('./builtinSkillsPath.cjs');

/** Kurulu kopyanın köken damgası — Skill Merkezi rozetinin ve bu modülün sahipliğinin ölçüsü. */
const ORIGIN = 'builtin';

/** Kullanıcı tercihi (opt-out) defteri: kanonik deponun DIŞINDA, `.crewpane/` kökünde. */
const STATE_SUBPATH = Object.freeze(['.crewpane', 'builtin-skills.json']);

/** Ad çakışmasında önerilen ek. */
const CONFLICT_SUFFIX = '-builtin';

/** Kurulumun yazdığı damgalar (tek yerde: rapor ve testler aynı listeye bakar). */
const PROVENANCE_KEYS = Object.freeze([
  'crewpane.origin',
  'crewpane.sourceCatalog',
  'crewpane.upstreamCommit',
  'crewpane.sha256',
  'crewpane.bodySha256',
  'crewpane.installedAt',
]);

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Gövde parmak izi — kurulu kopyanın kullanıcı tarafından değiştirilip değiştirilmediğini
 * ölçer. NEDEN GÖVDE (dosyanın tamamı değil): damga `bodySha256` dosyanın İÇİNDE yaşar,
 * dolayısıyla dosyanın tamamının özeti kendine referans verirdi (döngü).
 */
function bodyFingerprint(body) {
  return sha256Hex(Buffer.from(String(body == null ? '' : body).trim(), 'utf8'));
}

function nowIso(now) {
  return (now instanceof Date ? now : new Date()).toISOString();
}

// ── Katalog okuma ────────────────────────────────────────────────────────────

/**
 * Gömülü katalog. Yol hesabı YENİDEN YAZILMAZ — SKL-B5'in tek boğazı çağrılır.
 * Katalog yoksa `ok:false, reason:'catalog-missing'` (boş katalog DEĞİL: "hiç skill yok"
 * ile "kataloğu bulamadım" farklı cevaplardır).
 */
function loadCatalog({ catalogDir } = {}) {
  const dir = catalogDir || builtinPath.builtinSkillsDir();
  if (!dir) return { ok: false, reason: 'catalog-missing', dir: null, catalogVersion: null, skills: [] };
  const file = path.join(dir, builtinPath.CATALOG_FILE);
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { ok: false, reason: 'catalog-unreadable', error: err.message, dir, file, catalogVersion: null, skills: [] };
  }
  const skills = Array.isArray(parsed && parsed.skills) ? parsed.skills.filter((s) => s && typeof s.name === 'string') : [];
  return {
    ok: true,
    dir,
    file,
    catalogVersion: (parsed && parsed.catalogVersion) || null,
    generatedAt: (parsed && parsed.generatedAt) || null,
    skills,
  };
}

/**
 * SKL-PONYTAIL-02 — AÇILIŞTA KENDİLİĞİNDEN KURULUR MU?
 *
 * Ölçülen durum (2026-09-15, gerçek açılış log'u): tohumlayıcı katalogdaki HER skilli
 * kurar ve `skillEngineView` onu HER motorun dizinine bağlar ⇒ skill o çalışma alanındaki
 * HER ajanın bağlamına girer. Rol boyutu yoktur. Bu, bilgi veren skiller için doğru
 * varsayılandır; ÇALIŞMA BİÇİMİNİ değiştiren (çıktı kalitesini etkileyen) skiller için
 * değildir — kullanıcı onu seçmemiştir.
 *
 * Alan YOKSA `true`: 15 mevcut girdinin davranışı DEĞİŞMEZ (sessiz kapanma yok).
 * Yalnız `=== false` kapatır; `"false"` dizgesi kapatmaz ve kapı onu zaten reddeder.
 */
function seedsByDefault(entry) {
  return !(entry && entry.defaultEnabled === false);
}

function catalogEntry(catalog, name) {
  const slug = F.safeName(name);
  return (catalog.skills || []).find((s) => F.safeName(s.name) === slug) || null;
}

/**
 * Katalogdaki bir skill'in DİSKTEKİ hâli + BÜTÜNLÜK ölçümü.
 * Beyan (catalog.json) ile dosya ayrışıyorsa `builtin-tampered`: paket imzası bir
 * KOD imzasıdır, kurulumdan sonraki disk kurcalamasını kapsamaz (SKL-B5 açık soru-1).
 */
function readCatalogSkill(catalog, name) {
  const entry = catalogEntry(catalog, name);
  if (!entry) return { ok: false, code: 'not-in-catalog', message: `Katalogda yok: ${name}` };
  const file = builtinPath.skillFilePath(entry.name, catalog.dir);
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { ok: false, code: 'builtin-orphan', message: `Katalog gövdesi okunamadı: ${file} (${err.message})`, entry, file };
  }
  const digest = sha256Hex(Buffer.from(raw, 'utf8'));
  if (entry.sha256 && entry.sha256 !== digest) {
    return {
      ok: false,
      code: 'builtin-tampered',
      message: `Katalog beyanı ile dosya AYRIŞIYOR — beyan ${String(entry.sha256).slice(0, 12)}… · dosya ${digest.slice(0, 12)}…`,
      entry,
      file,
      digest,
    };
  }
  return { ok: true, entry, file, text: raw, digest };
}

// ── Tercih defteri (opt-out) ─────────────────────────────────────────────────

function statePath(workspaceRoot) {
  if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) return null;
  return path.join(workspaceRoot, ...STATE_SUBPATH);
}

function readState(workspaceRoot) {
  const file = statePath(workspaceRoot);
  const empty = { version: 1, optOut: [], catalogVersion: null, lastSeedAt: null };
  if (!file) return empty;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      version: 1,
      optOut: Array.isArray(j.optOut) ? j.optOut.map((n) => F.safeName(n)) : [],
      catalogVersion: j.catalogVersion || null,
      lastSeedAt: j.lastSeedAt || null,
    };
  } catch {
    return empty; // bozuk/eksik defter = tercih yok (kurulum kararı diske bakarak alınır)
  }
}

function writeState(workspaceRoot, next) {
  const file = statePath(workspaceRoot);
  if (!file) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFileSync(file, `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`, { encoding: 'utf8' });
  return true;
}

function setOptOut(workspaceRoot, name, wanted) {
  const slug = F.safeName(name);
  const state = readState(workspaceRoot);
  const set = new Set(state.optOut);
  if (wanted) set.add(slug);
  else set.delete(slug);
  writeState(workspaceRoot, { ...state, optOut: [...set].sort() });
  return [...set];
}

// ── Durum ────────────────────────────────────────────────────────────────────

/**
 * Bir katalog skill'inin kullanıcı deposundaki GERÇEK durumu.
 *
 * `state`:
 *   absent           kurulu değil
 *   opted-out        kullanıcı kaldırmış (açılış geri kurmaz)
 *   installed        kurulu ve katalogla aynı sürümde
 *   update-available kurulu, katalog ilerledi, kopya bizim yazdığımız gibi → tazelenebilir
 *   forked           kullanıcı DÜZENLEMİŞ → dokunulmaz
 *   forked-update    kullanıcı düzenlemiş VE katalog ilerledi → dokunulmaz, diff gösterilir
 *   conflict         aynı adlı ama BİZİM OLMAYAN bir skill yolu tutuyor
 *   tampered         katalog dosyası beyanıyla ayrışıyor (kurulum reddeder)
 *   missing-catalog  katalogda karşılığı yok (kurulu ise `orphan`)
 */
/**
 * Bir ADI kim tutuyor? (yayın önce, sonra taslak — taslak da bir addır ve onu ezmek
 * kullanıcının bekleyen işini yok etmek olurdu.) Yoksa null.
 */
function occupantOf(workspaceRoot, target) {
  const published = skillStore.readSkill(workspaceRoot, target, 'published');
  if (published) {
    const meta = (published.frontmatter && published.frontmatter.metadata) || {};
    return { scope: 'published', rec: published, meta, ours: meta['crewpane.origin'] === ORIGIN };
  }
  const draft = skillStore.readSkill(workspaceRoot, target, 'draft');
  if (draft) return { scope: 'draft', rec: draft, meta: (draft.frontmatter && draft.frontmatter.metadata) || {}, ours: false };
  return null;
}

/** Kurulu bir kopyanın kaynağa göre durumu — `install` ve `statusOf` AYNI hükmü kullanır. */
function compareInstalled(occ, catalogDigest) {
  const stored = occ.meta['crewpane.bodySha256'] || null;
  const modified = !!stored && bodyFingerprint(occ.rec.body) !== stored;
  const upToDate = !!occ.meta['crewpane.sha256'] && occ.meta['crewpane.sha256'] === catalogDigest;
  if (modified) return upToDate ? 'forked' : 'forked-update';
  return upToDate ? 'installed' : 'update-available';
}

function statusOf({ workspaceRoot, name, catalog } = {}) {
  const cat = catalog && catalog.ok ? catalog : loadCatalog();
  const slug = F.safeName(name);
  const entry = cat.ok ? catalogEntry(cat, slug) : null;
  const optedOut = readState(workspaceRoot).optOut.includes(slug);
  const occ = occupantOf(workspaceRoot, slug);

  const base = {
    name: slug,
    inCatalog: !!entry,
    catalogVersion: cat.catalogVersion || null,
    installed: !!(occ && occ.scope === 'published'),
    ours: !!(occ && occ.ours),
    optedOut,
    file: occ ? occ.rec.file : null,
    version: occ ? occ.meta['crewpane.version'] || null : null,
    installedSha: occ ? occ.meta['crewpane.sha256'] || null : null,
    catalogSha: entry ? entry.sha256 || null : null,
    sourceCatalog: occ ? occ.meta['crewpane.sourceCatalog'] || null : null,
    modified: false,
  };

  if (occ && !occ.ours) return { ...base, state: 'conflict', conflictScope: occ.scope, suggestion: `${slug}${CONFLICT_SUFFIX}` };
  if (!entry) return { ...base, state: occ ? 'orphan' : 'missing-catalog' };

  // Katalog bütünlüğü: beyan ↔ dosya. Kurcalanmış katalogdan KURULUM YAPILMAZ.
  const src = readCatalogSkill(cat, slug);
  if (!src.ok && src.code === 'builtin-tampered') return { ...base, state: 'tampered', message: src.message };
  if (!src.ok) return { ...base, state: 'missing-catalog', message: src.message };

  if (!occ) return { ...base, state: optedOut ? 'opted-out' : 'absent' };

  const state = compareInstalled(occ, src.digest);
  return { ...base, modified: state === 'forked' || state === 'forked-update', state };
}

/** Katalogdaki HER skill için durum — Skill Merkezi'nin "Dahili" sekmesinin tek çağrısı. */
function listCatalog({ workspaceRoot, catalogDir } = {}) {
  const catalog = loadCatalog({ catalogDir });
  if (!catalog.ok) {
    return { ok: false, reason: catalog.reason, catalogVersion: null, dir: catalog.dir || null, skills: [] };
  }
  const skills = catalog.skills.map((entry) => {
    const st = statusOf({ workspaceRoot, name: entry.name, catalog });
    return {
      name: F.safeName(entry.name),
      description: entry.description || '',
      license: entry.license || null,
      source: entry.source || null,
      sizeBytes: entry.sizeBytes || null,
      sha256: entry.sha256 || null,
      requires: Array.isArray(entry.requires) ? entry.requires : [],
      riskNotes: entry.riskNotes || '',
      // SKL-PONYTAIL-02 — Skill Merkezi bunları ÇİZER; kararı burada verilmiş olarak alır.
      defaultEnabled: seedsByDefault(entry),
      suggestedRoles: Array.isArray(entry.suggestedRoles) ? entry.suggestedRoles : [],
      ...st,
    };
  });
  return {
    ok: true,
    dir: catalog.dir,
    catalogVersion: catalog.catalogVersion,
    generatedAt: catalog.generatedAt,
    counts: {
      total: skills.length,
      installed: skills.filter((s) => s.state === 'installed').length,
      pending: skills.filter((s) => s.state === 'update-available' || s.state === 'forked-update').length,
      forked: skills.filter((s) => s.modified).length,
    },
    skills,
  };
}

// ── Kurulum ──────────────────────────────────────────────────────────────────

function fail(code, message, extra = {}) {
  return { ok: false, changed: false, action: 'none', errors: [{ code, message }], ...extra };
}

/**
 * KUR / GÜNCELLE — kanonik depoya (`.crewpane/skills/<ad>/SKILL.md`) yazar.
 *
 * @param {object} o
 * @param {string} o.workspaceRoot
 * @param {string} o.name             katalog adı
 * @param {string} [o.catalogDir]     test/ölçüm için katalog kökü ezmesi
 * @param {string} [o.installAs]      ad çakışmasında kullanıcının seçtiği ikinci ad
 * @param {boolean}[o.applyUpdate]    kurulu ve güncel-değilse tazelenmesine izin
 * @param {boolean}[o.force]          ÇATALI da ez (yalnız kullanıcının açık ikinci onayı)
 * @param {string} [o.reviewedBy]     onay damgası (UI'dan gelen tıklamada bağlı hesap)
 * @returns {{ok:boolean, changed:boolean, action:'installed'|'updated'|'unchanged'|'none', …}}
 */
function install({
  workspaceRoot,
  name,
  catalogDir,
  installAs = null,
  applyUpdate = true,
  force = false,
  reviewedBy = 'builtin-catalog',
  now = new Date(),
} = {}) {
  if (!skillStore.skillsRoot(workspaceRoot)) return fail('no-workspace', 'Çalışma alanı seçili değil');

  const catalog = loadCatalog({ catalogDir });
  if (!catalog.ok) return fail(catalog.reason, `Gömülü katalog okunamadı (${catalog.reason})`);

  const src = readCatalogSkill(catalog, name);
  if (!src.ok) return fail(src.code, src.message);

  // Hedef ad: çakışmada kullanıcı `<ad>-builtin` seçebilir. Dizin adı = `name` (standart).
  const target = F.safeName(installAs || src.entry.name);

  // 🔴 İÇE-AKTARIM SÜZGECİ (1/2) — SIR TARAMASI. Katalog "bizim" diye atlanmaz.
  const scan = secretScan.scanSkillText(src.text);
  if (!scan.ok) {
    return { ok: false, changed: false, action: 'none', blockedBy: 'secret-scan', errors: secretScan.toErrors(scan) };
  }

  // Hedef adı kim tutuyor? Karar `statusOf` ile AYNI hükümden (`compareInstalled`) çıkar;
  // `installAs` verildiğinde hedef ad katalogda YOKTUR, bu yüzden durum adın kendisinden
  // değil işgalcisinden türetilir.
  const occ = occupantOf(workspaceRoot, target);
  const state = occ ? (occ.ours ? compareInstalled(occ, src.digest) : 'conflict') : 'absent';

  if (state === 'conflict') {
    return fail(
      'name-conflict',
      installAs
        ? `Seçilen ad da dolu: ${target}`
        : `Aynı adlı kendi skill'in var (${occ.scope}) — üzerine YAZILMAZ`,
      { suggestion: `${target}${CONFLICT_SUFFIX}`, conflictScope: occ.scope },
    );
  }
  if (state === 'installed' && !force) {
    return { ok: true, changed: false, action: 'unchanged', name: target, file: occ.rec.file, errors: [] };
  }
  if ((state === 'forked' || state === 'forked-update') && !force) {
    // §2.5 — ÇATAL DOKUNULMAZ. "Güncelleme var" bilgisi çağırana döner, karar insanındır.
    return fail('user-modified', `Kurulu kopya DÜZENLENMİŞ — sessiz üzerine yazma yok (${target})`, {
      state,
      updateAvailable: state === 'forked-update',
      file: occ.rec.file,
    });
  }
  if (state === 'update-available' && !applyUpdate && !force) {
    return fail('update-pending', `Güncelleme var ama otomatik uygulanmadı (${target})`, { state, file: occ.rec.file });
  }

  // 🔴 İÇE-AKTARIM SÜZGECİ (2/2) — YABANCI DAMGA SÖKÜMÜ + PROVENANS.
  const parsed = F.parseSkillMd(src.text);
  const fm = parsed.frontmatter || {};
  const meta = {};
  for (const [k, v] of Object.entries((fm.metadata && typeof fm.metadata === 'object' && fm.metadata) || {})) {
    if (skillShare.STRIPPED_ON_IMPORT.includes(k)) continue; // başkasının onayı bizim onayımız değil
    if (PROVENANCE_KEYS.includes(k)) continue; // provenansı KATALOG değil KURULUM yazar
    meta[k] = v;
  }

  const body = parsed.body;
  const stamp = nowIso(now);
  const prevVersion = occ ? parseInt(String(occ.meta['crewpane.version'] || 0), 10) : 0;
  meta['crewpane.origin'] = ORIGIN;
  meta['crewpane.sourceCatalog'] = `${F.safeName(src.entry.name)}@${catalog.catalogVersion || '0'}`;
  if (src.entry.source && src.entry.source.upstreamCommit) meta['crewpane.upstreamCommit'] = src.entry.source.upstreamCommit;
  if (src.entry.source && src.entry.source.url) meta['crewpane.sourceUrl'] = src.entry.source.url;
  meta['crewpane.sha256'] = src.digest;
  meta['crewpane.bodySha256'] = bodyFingerprint(body);
  meta['crewpane.installedAt'] = stamp;
  meta['crewpane.status'] = 'published';
  meta['crewpane.version'] = String((Number.isFinite(prevVersion) && prevVersion > 0 ? prevVersion : 0) + 1);
  meta['crewpane.reviewedBy'] = reviewedBy;
  meta['crewpane.reviewedAt'] = stamp;

  const { content } = F.composeSkillMd({
    name: target,
    description: fm.description,
    license: fm.license,
    compatibility: fm.compatibility,
    metadata: meta,
    body,
  });
  const check = F.validateSkill({ text: content, dirName: target, entries: [] });
  if (!check.ok) return { ok: false, changed: false, action: 'none', errors: check.errors, warnings: check.warnings };

  skillStore.ensureSkillScaffold(workspaceRoot);
  const dir = skillStore.skillDir(workspaceRoot, target, 'published');
  if (!dir) return fail('no-workspace', 'Hedef dizin çözülemedi');
  fs.mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(path.join(dir, F.SKILL_FILE), content, { encoding: 'utf8' });

  setOptOut(workspaceRoot, target, false); // kullanıcı yeniden kurdu → tercih düşer

  return {
    ok: true,
    changed: true,
    action: occ ? 'updated' : 'installed',
    name: target,
    dir,
    file: path.join(dir, F.SKILL_FILE),
    sha256: src.digest,
    sourceCatalog: meta['crewpane.sourceCatalog'],
    errors: [],
    warnings: check.warnings,
  };
}

/**
 * KALDIR — kurulu kopya silinir ve adı `optOut` defterine yazılır (bir sonraki açılış
 * geri kurmasın). Motor bağlarını bu modül SÖKMEZ: `reconcileEngineViews` yayındaki
 * küme küçüldüğü için bayat bağı zaten temizler — çağıran onu tetikler (SKL-B0 deseni).
 *
 * BİZİM OLMAYAN bir skill'i kaldırmaz: kullanıcının kendi dosyasını silmek bu modülün
 * işi değildir (`not-ours`).
 */
function uninstall({ workspaceRoot, name } = {}) {
  if (!skillStore.skillsRoot(workspaceRoot)) return fail('no-workspace', 'Çalışma alanı seçili değil');
  const slug = F.safeName(name);
  const rec = skillStore.readSkill(workspaceRoot, slug, 'published');
  if (!rec) {
    setOptOut(workspaceRoot, slug, true);
    return { ok: true, changed: false, action: 'unchanged', name: slug, errors: [] };
  }
  const meta = (rec.frontmatter && rec.frontmatter.metadata) || {};
  if (meta['crewpane.origin'] !== ORIGIN) {
    return fail('not-ours', `\`${slug}\` dahili katalogdan gelmedi — bu uçtan silinmez`);
  }
  fs.rmSync(rec.dir, { recursive: true, force: true });
  setOptOut(workspaceRoot, slug, true);
  return { ok: true, changed: true, action: 'removed', name: slug, dir: rec.dir, errors: [] };
}

/**
 * AÇILIŞ TOHUMLAMASI — "yeni kullanıcı skill'leri HAZIR bulur" gereksiniminin fiili.
 *
 * İdempotent ve DURUMDAN türer (ilk-açılış bayrağı YOK: bayrak ile disk ayrışabilir,
 * disk ayrışamaz):
 *   • kurulu değil + opt-out değil  → KURULUR            (ilk açılış · yeni skill)
 *   • kurulu, katalog ilerledi      → `updatePolicy`e göre tazelenir ya da beklemeye alınır
 *   • kullanıcı düzenlemiş          → KORUNUR, beklemeye yazılır (asla ezilmez)
 *   • ad çakışması                  → KURULMAZ, çakışma listesine yazılır
 *
 * `updatePolicy`:
 *   'auto-unmodified' (varsayılan) — YALNIZ kendi yazdığımız, el değmemiş kopyayı tazeler.
 *                                    Kullanıcının kaybedeceği bayt yoktur; her tazeleme loglanır.
 *   'notify'                       — hiçbir kurulu kopyaya dokunmaz, hepsini `pending`e yazar
 *                                    (tasarım §2.5'in katı okuması; UI diff gösterir).
 */
function ensureInstalled({
  workspaceRoot,
  catalogDir,
  updatePolicy = 'auto-unmodified',
  reviewedBy = 'builtin-catalog',
  env = process.env,
  log = null,
  now = new Date(),
} = {}) {
  const say = (line) => {
    if (typeof log === 'function') {
      try { log(line); } catch { /* log yolu koşuyu düşüremez */ }
    }
  };
  const empty = { ran: false, installed: [], updated: [], preserved: [], pending: [], conflicts: [], failed: [], catalogVersion: null };

  if (String((env && env.CREWPANE_SKILLS) ?? '1') === '0') {
    say('builtin-skills atlandı — CREWPANE_SKILLS=0 (kill-switch)');
    return { ...empty, reason: 'kill-switch' };
  }
  if (!skillStore.skillsRoot(workspaceRoot)) {
    say('builtin-skills atlandı — çalışma alanı yok');
    return { ...empty, reason: 'no-workspace' };
  }
  const catalog = loadCatalog({ catalogDir });
  if (!catalog.ok) {
    say(`builtin-skills atlandı — ${catalog.reason}`);
    return { ...empty, reason: catalog.reason };
  }

  const out = { ran: true, reason: null, catalogVersion: catalog.catalogVersion, installed: [], updated: [], preserved: [], pending: [], conflicts: [], failed: [] };

  for (const entry of catalog.skills) {
    const slug = F.safeName(entry.name);
    let st;
    try {
      st = statusOf({ workspaceRoot, name: slug, catalog });
    } catch (err) {
      out.failed.push({ name: slug, reason: (err && err.message) || String(err) });
      continue;
    }

    if (st.state === 'opted-out') { out.preserved.push({ name: slug, why: 'opted-out' }); continue; }
    // SKL-PONYTAIL-02 — RIZA KAPISI. YALNIZ `absent` dalında: kullanıcı skilli elle
    // kurduysa durum `installed`/`update-available` olur ve güncelleme normal yolundan
    // akar. Burada `continue` etmek "kullanıcının kurduğu skill bir daha güncellenmez"
    // demek olurdu — tam tersi bir arıza.
    if (st.state === 'absent' && !seedsByDefault(entry)) {
      out.preserved.push({ name: slug, why: 'opt-in' });
      continue;
    }
    if (st.state === 'installed') continue;
    if (st.state === 'conflict') { out.conflicts.push({ name: slug, scope: st.conflictScope, suggestion: st.suggestion }); continue; }
    if (st.state === 'tampered') { out.failed.push({ name: slug, reason: 'builtin-tampered' }); continue; }
    if (st.state === 'forked') { out.preserved.push({ name: slug, why: 'user-modified' }); continue; }
    if (st.state === 'forked-update') {
      out.preserved.push({ name: slug, why: 'user-modified' });
      out.pending.push({ name: slug, why: 'user-modified', state: st.state });
      continue;
    }
    if (st.state === 'update-available' && updatePolicy !== 'auto-unmodified') {
      out.pending.push({ name: slug, why: 'update-available', state: st.state });
      continue;
    }
    if (st.state === 'missing-catalog' || st.state === 'orphan') continue;

    const res = install({ workspaceRoot, name: slug, catalogDir: catalog.dir, applyUpdate: true, reviewedBy, now });
    if (!res.ok) {
      out.failed.push({ name: slug, reason: (res.errors && res.errors[0] && res.errors[0].code) || 'unknown' });
      continue;
    }
    if (res.action === 'installed') out.installed.push(slug);
    else if (res.action === 'updated') out.updated.push(slug);
  }

  const state = readState(workspaceRoot);
  writeState(workspaceRoot, { ...state, catalogVersion: catalog.catalogVersion, lastSeedAt: nowIso(now) });

  const bits = [
    `katalog v${catalog.catalogVersion || '?'}`,
    `kur:${out.installed.length}`,
    `güncelle:${out.updated.length}`,
    `koru:${out.preserved.length}`,
    `bekleyen:${out.pending.length}`,
  ];
  if (out.conflicts.length) bits.push(`çakışma:${out.conflicts.length}`);
  if (out.failed.length) bits.push(`düştü:${out.failed.length}`);
  say(`builtin-skills ${bits.join(' · ')}`);
  return out;
}

/**
 * NÖBETÇİ — dahili skill'lerin iki sessiz bozulma sınıfı (kart md.7).
 *
 *   builtin-tampered : KATALOG dosyası beyanıyla ayrışıyor (imzalı paket diskte
 *                      kurcalanmış ya da bozulmuş) → o skill KURULMAZ.
 *   builtin-orphan   : kurulu bir dahili skill'in katalogda karşılığı YOK (sürüm
 *                      düşürüldü / skill kataloğdan çıkarıldı) → kaynağı olmayan
 *                      bir dosya tüm ajanların bağlamında koşuyor.
 *
 * ⚠️ KULLANICININ DÜZENLEDİĞİ kopya ihlal DEĞİLDİR — §2.5 onu açıkça korur. Bu yüzden
 * ayrı ve `severity:'info'` bir bulgu olarak (`builtin-forked`) raporlanır: "kurcalandı"
 * demek kullanıcının kendi düzenlemesini suç ilan etmek olurdu ve kapıyı gürültüye boğardı.
 */
function auditBuiltin({ workspaceRoot, catalogDir } = {}) {
  const violations = [];
  const info = [];
  if (!skillStore.skillsRoot(workspaceRoot)) return { ok: true, violations, info, checked: 0 };

  const catalog = loadCatalog({ catalogDir });

  // (1) Katalog tarafı — beyan ↔ dosya.
  if (catalog.ok) {
    for (const entry of catalog.skills) {
      const src = readCatalogSkill(catalog, entry.name);
      if (!src.ok && (src.code === 'builtin-tampered' || src.code === 'builtin-orphan')) {
        violations.push({ code: src.code, name: F.safeName(entry.name), where: 'catalog', path: src.file || null, message: src.message });
      }
    }
  }

  // (2) Kurulu taraf — kaynağı var mı, gövde bizim yazdığımız gibi mi.
  const installed = skillStore
    .listSkills(workspaceRoot, { scope: 'published' })
    .filter((rec) => ((rec.frontmatter && rec.frontmatter.metadata) || {})['crewpane.origin'] === ORIGIN);

  for (const rec of installed) {
    const meta = (rec.frontmatter && rec.frontmatter.metadata) || {};
    const entry = catalog.ok ? catalogEntry(catalog, rec.name) : null;
    if (!entry) {
      violations.push({
        code: 'builtin-orphan',
        name: rec.name,
        where: 'installed',
        path: rec.file,
        message: `\`${rec.name}\` dahili olarak kurulu ama katalogda karşılığı YOK (${meta['crewpane.sourceCatalog'] || 'kaynak damgası yok'})`,
      });
      continue;
    }
    const stored = meta['crewpane.bodySha256'] || null;
    if (stored && bodyFingerprint(rec.body) !== stored) {
      info.push({
        code: 'builtin-forked',
        severity: 'info',
        name: rec.name,
        where: 'installed',
        path: rec.file,
        message: `\`${rec.name}\` kurulu kopyası DÜZENLENMİŞ — güncelleme bu kopyayı ezmeyecek (çatal korunuyor)`,
      });
    }
  }

  return { ok: violations.length === 0, violations, info, checked: installed.length };
}

module.exports = {
  seedsByDefault,
  ORIGIN,
  STATE_SUBPATH,
  CONFLICT_SUFFIX,
  PROVENANCE_KEYS,
  bodyFingerprint,
  occupantOf,
  compareInstalled,
  loadCatalog,
  readCatalogSkill,
  statePath,
  readState,
  writeState,
  statusOf,
  listCatalog,
  install,
  uninstall,
  ensureInstalled,
  auditBuiltin,
};
