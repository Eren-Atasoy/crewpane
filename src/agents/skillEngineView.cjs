// CrewPane — SK-02 (ADR-SKILL-CENTER Karar 3) motor görünümü: kanonik depo + SEMBOLİK BAĞ.
//
// Kanonik dosya TEK yerde durur (`.crewpane/skills/<ad>/SKILL.md`); her motor onu kendi
// beklediği yolda bir bağ üzerinden görür. KOPYA YOK — kopya = ikinci gerçek = sapma.
//
//   claude (proje kapsamı) : <workspaceRoot>/.claude/skills/<ad>  → kanonik   (SK-01 Ö3)
//   codex                  : $CODEX_HOME/skills/<ad>              → kanonik   (SK-01 Ö4/Ö5)
//
// 🪤 R1 — DOKÜMAN İLE İKİLİ ÇELİŞEBİLİR: OpenAI dokümanı codex için `.agents/skills` diyor,
// kurulu 0.146 ikilisinde o dize 0 kez geçiyor (`.codex/skills` 4 kez). Bu yüzden yol
// üretimi TEK BOĞAZDAN (`skillEnginePaths`) geçer: codex sürümü değişip yol kayarsa
// güncellenecek tek nokta burasıdır.
//
// KAPI (bu modülün asıl işi): buradan YALNIZ `skills/` (yayın) bağlanır. `skill-drafts/`
// hiçbir koşulda bağlanmaz — `auditEngineViews` bunu ölçen nöbetçidir (ADR R8/T6).
//
// KILL-SWITCH: CREWPANE_SKILLS=0 → hiçbir bağ kurulmaz, hiçbir şey silinmez; davranış
// bu özellik öncesiyle birebir aynı olur (emsal: TURN_BRIEFING=0).

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const skillStore = require('./skillStore.cjs');
const engineRegistry = require('./engineRegistry.cjs'); // ENG-12 — motor skill dizinlerinin TEK kaynağı

// Kopya-yedek (win32: sembolik bağ yönetici/geliştirici modu isteyebilir) ile üretilen
// dizinleri işaretler → temizlik "bizim mi" sorusunu bağ olmadan da cevaplayabilir.
const VIEW_MARKER = '.crewpane-view';

/** Kill-switch okuma. Yalnız açık '0' kapatır (tanımsız = açık). */
function skillsEnabled(env = process.env) {
  return String((env && env.CREWPANE_SKILLS) ?? '1') !== '0';
}

/** codex kökü: $CODEX_HOME → yoksa ~/.codex (SK-01 Ö4'te ölçülen yol). */
function codexHomeDir({ env = process.env, homedir = os.homedir() } = {}) {
  const fromEnv = env && typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim() ? env.CODEX_HOME.trim() : null;
  return fromEnv || path.join(homedir, '.codex');
}

/**
 * TEK BOĞAZ: motor skill dizinleri. Saf — fs'ye bakmaz.
 * Dönen: [{ engine, dir }] (workspaceRoot yoksa `workspace` kapsamlı girdiler düşer).
 *
 * ENG-12 — liste artık ELLE yazılmıyor, `engineRegistry.skillsDir` beyanından türer.
 * Eskiden burada iki motor sabit kodluydu; üçüncü motor (copilot) eklendiğinde bu
 * dosya güncellenmeseydi copilot pane'i skill'leri GÖRÜR ama ürün onun dizinini
 * YÖNETMEZDİ — yani bayat/taslak bir bağ oraya sızsa denetim (auditEngineViews) onu
 * hiç aramazdı: tam olarak "sessiz yetenek kaybı" sınıfı (ENG-R3 §14-R1).
 *
 * 🪤 İKİ MOTOR AYNI DİZİNİ paylaşabilir (ölçüldü: copilot `.claude/skills` dizinini
 * de tarıyor). Liste yine motor-başına döner — çağıran hangi motorun neyi gördüğünü
 * bilmek zorunda — ama YAZAN/DENETLEYEN döngüler dizine göre TEKİLLEŞTİRİR.
 */
function skillEnginePaths({ workspaceRoot, env = process.env, homedir = os.homedir(), codexHome } = {}) {
  // Geriye-uyum: çağıranlar bugün yalnız codex kökünü ezebiliyor (`codexHome`).
  // Bir HARİTA olarak taşınır ki yeni motor eklendiğinde imza değişmesin.
  const homeOverrides = { codex: codexHome };
  const out = [];
  for (const engine of engineRegistry.engineIds()) {
    const d = engineRegistry.capability(engine, 'skillsDir');
    if (!d || !Array.isArray(d.segments) || !d.segments.length) continue; // beyan yok → dizin yönetilmez
    let root = null;
    if (d.scope === 'workspace') {
      root = typeof workspaceRoot === 'string' && workspaceRoot.trim() ? workspaceRoot : null;
    } else if (d.scope === 'engine-home') {
      const fromEnv = d.homeEnv && env && typeof env[d.homeEnv] === 'string' && env[d.homeEnv].trim()
        ? env[d.homeEnv].trim()
        : null;
      const fallback = typeof d.homeFallback === 'string' && d.homeFallback.startsWith('~/')
        ? path.join(homedir, d.homeFallback.slice(2))
        : d.homeFallback || null;
      root = homeOverrides[engine] || fromEnv || fallback;
    }
    if (!root) continue;
    out.push({ engine, dir: path.join(root, ...d.segments) });
  }
  return out;
}

/** Yayına uygun skiller: geçerli + `retired` olmayan. */
function publishableNames(workspaceRoot) {
  return skillStore
    .listSkills(workspaceRoot, { scope: 'published' })
    .filter((s) => s.exists && s.ok && s.status !== 'retired')
    .map((s) => s.name);
}

function lstat(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/** Bir motor girdisi BİZİM mü? (kanonik depoya bakan bağ ya da işaretli kopya) */
function classifyEntry(entryPath, canonicalRoot) {
  const st = lstat(entryPath);
  if (!st) return { kind: 'absent' };
  if (st.isSymbolicLink()) {
    let target = null;
    try {
      target = path.resolve(path.dirname(entryPath), fs.readlinkSync(entryPath));
    } catch {
      return { kind: 'broken-link', target: null };
    }
    const rel = path.relative(canonicalRoot, target);
    const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    if (!inside) return { kind: 'foreign-link', target };
    return { kind: fs.existsSync(target) ? 'ours-link' : 'ours-link-dangling', target };
  }
  if (st.isDirectory()) {
    if (fs.existsSync(path.join(entryPath, VIEW_MARKER))) return { kind: 'ours-copy' };
    return { kind: 'foreign-dir' };
  }
  return { kind: 'foreign-file' };
}

/**
 * Bir motor girdisini SİL. 🪤 `fs.rmSync(p, {recursive,force})` BAYAT (kırık) bir sembolik
 * bağı SESSİZCE SİLMEZ: hedefi izleyen stat ENOENT verir ve `force` onu yutar → çağrı
 * başarılı görünür, bağ diskte kalır. SK-02'de bu gerçek koşuda yakalandı; birim test
 * `existsSync` ile baktığı için YALANCI-YEŞİL vermişti (existsSync de bağı İZLER).
 * Bağ için tek doğru araç `unlinkSync`, ve varlık kontrolü `lstatSync` ile yapılır.
 */
function removeEntry(entryPath) {
  const st = lstat(entryPath);
  if (!st) return false;
  if (st.isSymbolicLink()) fs.unlinkSync(entryPath);
  else fs.rmSync(entryPath, { recursive: true, force: true });
  return true;
}

function linkOne(entryPath, target, { platform = process.platform } = {}) {
  removeEntry(entryPath);
  try {
    fs.symlinkSync(target, entryPath, platform === 'win32' ? 'junction' : 'dir');
    return { mode: 'symlink' };
  } catch (err) {
    // R6 — win32'de bağ kurulamayabilir. SESSİZ BAŞARISIZLIK YOK: kopyala ve bunu
    // raporda mode:'copy' diye söyle (kopya bayatlayabilir; UI bunu göstermeli).
    try {
      fs.cpSync(target, entryPath, { recursive: true });
      fs.writeFileSync(path.join(entryPath, VIEW_MARKER), `canonical: ${target}\n`, 'utf8');
      return { mode: 'copy', reason: err && err.code ? err.code : String(err && err.message) };
    } catch (copyErr) {
      return { mode: 'failed', reason: (copyErr && copyErr.message) || String(copyErr) };
    }
  }
}

/**
 * Motor görünümlerini kanonik depoyla eşitle.
 * • Yalnız YAYINDAKİ, geçerli, emekli-olmayan skiller bağlanır.
 * • Bizim olmayan girdilere DOKUNULMAZ (codex'in `.system`i gibi) — yalnız raporlanır.
 * • Bizim olup artık karşılığı olmayan bağ silinir (bayat görünüm bırakmayız).
 * Dönen: { enabled, engines: [{ engine, dir, linked, removed, conflicts, failed }] }
 */
function reconcileEngineViews({ workspaceRoot, env = process.env, homedir = os.homedir(), codexHome, platform = process.platform } = {}) {
  const enabled = skillsEnabled(env);
  const canonicalRoot = skillStore.skillsRoot(workspaceRoot);
  const engines = skillEnginePaths({ workspaceRoot, env, homedir, codexHome });
  if (!enabled || !canonicalRoot) {
    return { enabled, reason: enabled ? 'no-workspace' : 'kill-switch', engines: engines.map((e) => ({ ...e, linked: [], removed: [], conflicts: [], failed: [] })) };
  }

  const desired = new Set(publishableNames(workspaceRoot));
  const report = { enabled: true, engines: [] };

  // ENG-12 — AYNI DİZİNİ paylaşan motorlar (claude + copilot: `.claude/skills`) dizini
  // BİR KEZ işler. İkinci geçiş zaten kurulmuş bağları "yeniden" kurup raporda ÇİFT
  // sayardı — rapor bir ölçüdür, iki kez saymak onu yalancı yapar.
  //
  // ⚠️ Rapor yine MOTOR başınadır ve paylaşan motor AYNI sonucu görür: "copilot ne
  // görüyor?" sorusunun doğru cevabı "claude'unkiyle aynı bağlar"dır. Boş liste
  // döndürmek, copilot pane'inde skill YOK sanılmasına yol açardı.
  const byDir = new Map();
  for (const { engine, dir } of engines) {
    if (byDir.has(dir)) {
      report.engines.push({ ...byDir.get(dir), engine, sharedWith: byDir.get(dir).engine });
      continue;
    }
    const linked = [];
    const removed = [];
    const conflicts = [];
    const failed = [];
    fs.mkdirSync(dir, { recursive: true });

    // 1) Bayat/bizim-ama-artık-istenmeyen girdileri temizle.
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      /* yeni oluşturuldu */
    }
    for (const name of entries) {
      const p = path.join(dir, name);
      const c = classifyEntry(p, canonicalRoot);
      const ours = c.kind === 'ours-link' || c.kind === 'ours-copy' || c.kind === 'ours-link-dangling';
      if (!ours) continue;
      if (!desired.has(name) || c.kind === 'ours-link-dangling') {
        removeEntry(p);
        removed.push(name);
      }
    }

    // 2) İstenenleri kur (yabancı girdinin ÜZERİNE YAZMA — çakışmayı görünür yap).
    for (const name of desired) {
      const p = path.join(dir, name);
      const target = path.join(canonicalRoot, name);
      const c = classifyEntry(p, canonicalRoot);
      if (c.kind === 'ours-link' && c.target === target) continue;
      if (c.kind === 'foreign-dir' || c.kind === 'foreign-file' || c.kind === 'foreign-link') {
        conflicts.push({ name, kind: c.kind, path: p });
        continue;
      }
      const r = linkOne(p, target, { platform });
      if (r.mode === 'failed') failed.push({ name, reason: r.reason });
      else linked.push({ name, mode: r.mode, ...(r.reason ? { fallbackReason: r.reason } : {}) });
    }

    const entry = { engine, dir, linked, removed, conflicts, failed };
    byDir.set(dir, entry);
    report.engines.push(entry);
  }
  return report;
}

/**
 * NÖBETÇİ (ADR R8 + T6) — kapının kendisi kırıldı mı?
 * İhlaller:
 *   • draft-exposed : bir TASLAK adı motor dizininde beliriyor (kapı delinmiş)
 *   • agent-written : motor dizininde bizim olmayan GERÇEK bir dizin, adı depomuzla
 *                     çakışıyor → insan onayını atlayarak yayın yapılmış (T6)
 *   • dangling      : kanonik karşılığı olmayan bizim bağ (bayat görünüm)
 * Yabancı ve çakışmayan girdiler (codex `.system` gibi) ihlal DEĞİLDİR.
 */
function auditEngineViews({ workspaceRoot, env = process.env, homedir = os.homedir(), codexHome } = {}) {
  const canonicalRoot = skillStore.skillsRoot(workspaceRoot);
  const violations = [];
  if (!canonicalRoot) return { ok: true, violations, checked: [] };

  const draftNames = new Set(skillStore.listSkills(workspaceRoot, { scope: 'draft' }).map((s) => s.name));
  const publishedNames = new Set(skillStore.listSkills(workspaceRoot, { scope: 'published' }).map((s) => s.name));
  const checked = [];

  for (const { engine, dir } of skillEnginePaths({ workspaceRoot, env, homedir, codexHome })) {
    // ENG-12 — paylaşılan dizin bir KEZ denetlenir; aksi hâlde tek bir ihlal iki
    // motor adıyla iki kez raporlanır ve "kaç ihlal var" sorusu yanlış cevaplanır.
    if (checked.includes(dir)) continue;
    checked.push(dir);
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue; // dizin yok → ihlal de yok
    }
    for (const name of entries) {
      const p = path.join(dir, name);
      const c = classifyEntry(p, canonicalRoot);
      if (draftNames.has(name) && !publishedNames.has(name)) {
        violations.push({
          code: 'draft-exposed',
          engine,
          name,
          path: p,
          message: `TASLAK "${name}" motor dizininde görünüyor (${p}) — onay kapısı delinmiş`,
        });
        continue;
      }
      if (c.kind === 'ours-link-dangling') {
        violations.push({ code: 'dangling', engine, name, path: p, message: `Bayat bağ: ${p} → ${c.target} (kanonik yok)` });
        continue;
      }
      if ((c.kind === 'foreign-dir' || c.kind === 'foreign-file') && (draftNames.has(name) || publishedNames.has(name))) {
        violations.push({
          code: 'agent-written',
          engine,
          name,
          path: p,
          message: `Motor dizininde bizim olmayan gerçek girdi: ${p} — insan onayı atlanmış olabilir (T6)`,
        });
      }
    }
  }
  return { ok: violations.length === 0, violations, checked };
}

module.exports = {
  VIEW_MARKER,
  removeEntry,
  skillsEnabled,
  codexHomeDir,
  skillEnginePaths,
  publishableNames,
  classifyEntry,
  reconcileEngineViews,
  auditEngineViews,
};
