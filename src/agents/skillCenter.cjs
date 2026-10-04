// CrewPane — SK-03 (ADR-SKILL-CENTER §8) Skill Merkezi'nin OKUMA katmanı.
//
// Bu modül SK-02'nin kurduğu depoyu YENİDEN YAZMAZ; onu okur ve UI'nin tek çağrıda
// çizebileceği bir kayda dönüştürür:
//
//   skillStore.listSkills   → hangi skiller var, geçerli mi, ne yazıyor
//   skillEngineView.classify→ o skilli BUGÜN hangi motor GERÇEKTEN görüyor
//
// 🔑 NEDEN İKİSİ BİRDEN: "yayında" bir depo durumudur, "motor görüyor" ise DİSKTEKİ
// bağın durumudur ve ikisi ayrışabilir (bağ hiç kurulmamış · bayat kalmış · win32'de
// kopyaya düşmüş · yabancı bir girdi yolu kapatmış). Yalnız depoyu gösteren bir panel
// "yayında" der ve kullanıcı skillini hiçbir ajanda göremez. Bu yüzden rozet DEPO
// DEĞİL DİSK ölçer.
//
// ⚠️ SALT OKUNUR — SÖZLEŞME: burada hiçbir fonksiyon dosya sistemine YAZMAZ (mkdir
// dahil). `reconcileEngineViews` bilerek ÇAĞRILMAZ: bir listeleme çağrısının yan
// etkisi olarak motor dizinlerini oluşturmak/düzeltmek, paneli açmayı bir MUTASYON
// hâline getirirdi. Panel sapmayı GÖSTERİR, sessizce onarmaz.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const skillStore = require('./skillStore.cjs');
const engineView = require('./skillEngineView.cjs');

// Köken damgası → UI'nin iki rozeti. SK-02'nin yazdığı örnek `crewpane.origin: agent`
// kullanıyor; damgasız bir dosyayı bir ajan YAZMAMIŞTIR (ajan yazımı SK-06'da damgayı
// zorunlu kılar) → damgasız = kullanıcı. Ham `origin` detayda AYNEN gösterilir, yani
// bu eşleme bilgi kaybetmez, yalnız rozeti seçer.
const AI_ORIGINS = Object.freeze(['agent', 'ai', 'assistant']);

/** `metadata.crewpane.origin` → 'ai' | 'user'. Bilinmeyen/boş damga → 'user'. */
function sourceOf(origin) {
  const s = typeof origin === 'string' ? origin.trim().toLowerCase() : '';
  return AI_ORIGINS.includes(s) ? 'ai' : 'user';
}

/**
 * Bir skillin bir motor dizinindeki GERÇEK durumu (classifyEntry'nin UI diline çevirisi).
 *   linked   bağ kurulu ve kanonik dosyayı gösteriyor          → motor görüyor
 *   copy     win32 yedeği (R6): kopya — bayatlayabilir          → motor görüyor, uyarıyla
 *   absent   girdi yok                                          → motor GÖRMÜYOR
 *   dangling bizim bağ ama hedefi yok (bayat görünüm)           → motor GÖRMÜYOR
 *   conflict yabancı bir dizin/dosya/bağ yolu tutuyor           → motor BAŞKA bir şey görüyor
 *   exposed  TASLAK motor dizininde belirmiş → ONAY KAPISI DELİK (ADR R8/T6)
 */
function engineStateFor({ entryPath, canonicalRoot, scope }) {
  const c = engineView.classifyEntry(entryPath, canonicalRoot);
  if (scope === 'draft') {
    // Taslak için TEK doğru durum yokluktur; her varlık ihlaldir (kapı dizindir).
    return c.kind === 'absent' ? 'absent' : 'exposed';
  }
  switch (c.kind) {
    case 'ours-link':
      return 'linked';
    case 'ours-copy':
      return 'copy';
    case 'ours-link-dangling':
    case 'broken-link':
      return 'dangling';
    case 'absent':
      return 'absent';
    default:
      return 'conflict';
  }
}

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/** skillStore kaydını UI kaydına çevir (gövde HARİÇ — liste ucuz kalmalı). */
function toEntry(rec, { canonicalRoot, engines, enabled }) {
  const meta = (rec.frontmatter && typeof rec.frontmatter.metadata === 'object' && rec.frontmatter.metadata) || {};
  return {
    name: rec.name,
    description: rec.description || '',
    source: sourceOf(rec.origin),
    origin: rec.origin || null,
    author: rec.author || null,
    status: rec.status || (rec.scope === 'draft' ? 'draft' : 'published'),
    scope: rec.scope,
    path: rec.dir,
    file: rec.file,
    exists: rec.exists,
    ok: rec.ok,
    errors: rec.errors || [],
    warnings: rec.warnings || [],
    version: rec.version || null,
    task: meta['crewpane.task'] || null,
    sourceMemory: meta['crewpane.sourceMemory'] || null,
    // SK-06 — AI ÖNERİSİNİN provenansı. Bir ajanın yazdığı taslak bir ÖNERİDİR ve
    // insan onun NEREDEN geldiğini görmeden onaylayamaz: hangi tetikle (T-A açık
    // istek / T-B kapanış değerlendirmesi), hangi gerekçeyle, ne zaman. Damgasız
    // kayıtlarda `null` — panel "—" gösterir, uydurmaz.
    trigger: meta['crewpane.trigger'] || null,
    rationale: meta['crewpane.rationale'] || null,
    suggestedAt: meta['crewpane.suggestedAt'] || null,
    reviewedBy: meta['crewpane.reviewedBy'] || null,
    reviewedAt: meta['crewpane.reviewedAt'] || null,
    license: (rec.frontmatter && rec.frontmatter.license) || null,
    updatedAt: mtimeOf(rec.file),
    // Kill-switch açıkken bağ KURULMAZ; diski yine de okuruz ama rozet yalan
    // söylemesin diye durumu açıkça 'disabled' deriz (sessiz "absent" değil).
    engines: engines.map(({ engine, dir }) => ({
      engine,
      dir,
      state: enabled
        ? engineStateFor({ entryPath: path.join(dir, rec.name), canonicalRoot, scope: rec.scope })
        : 'disabled',
    })),
  };
}

/**
 * Skill Merkezi listesi — TEK IPC çağrısının tüm cevabı.
 * Dönen: { ok, enabled, workspaceRoot, roots, engines, counts, skills:[entry] }
 * Çalışma alanı seçili değilse `ok:false, reason:'no-workspace'` (boş liste DEĞİL:
 * "hiç skill yok" ile "nereye bakacağımı bilmiyorum" farklı cevaplardır).
 */
function listSkillCenter({ workspaceRoot, env = process.env, homedir = os.homedir(), codexHome } = {}) {
  const canonicalRoot = skillStore.skillsRoot(workspaceRoot);
  const draftsRoot = skillStore.draftsRoot(workspaceRoot);
  const enabled = engineView.skillsEnabled(env);
  const engines = engineView.skillEnginePaths({ workspaceRoot, env, homedir, codexHome });
  if (!canonicalRoot || !draftsRoot) {
    return { ok: false, reason: 'no-workspace', enabled, workspaceRoot: null, roots: null, engines, counts: { published: 0, draft: 0, invalid: 0 }, skills: [] };
  }

  const skills = skillStore
    .listSkills(workspaceRoot, { scope: 'all' })
    .map((rec) => toEntry(rec, { canonicalRoot, engines, enabled }))
    // Taslaklar üstte: onay BEKLEYEN iş, biten işten önce görünmeli.
    .sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === 'draft' ? -1 : 1));

  const counts = {
    published: skills.filter((s) => s.scope === 'published').length,
    draft: skills.filter((s) => s.scope === 'draft').length,
    invalid: skills.filter((s) => !s.ok).length,
  };
  return { ok: true, enabled, workspaceRoot, roots: { published: canonicalRoot, drafts: draftsRoot }, engines, counts, skills };
}

/**
 * TEK skillin tam kaydı — liste kaydının aynısı + `body`/`text` (SKILL.md'nin kendisi).
 * Yoksa null (uydurma boş kayıt DÖNMEZ; UI "seçim düştü" diyebilsin).
 */
function readSkillCenter({ workspaceRoot, name, scope, env = process.env, homedir = os.homedir(), codexHome } = {}) {
  const rec = skillStore.readSkill(workspaceRoot, name, scope);
  if (!rec) return null;
  const canonicalRoot = skillStore.skillsRoot(workspaceRoot);
  const enabled = engineView.skillsEnabled(env);
  const engines = engineView.skillEnginePaths({ workspaceRoot, env, homedir, codexHome });
  return { ...toEntry(rec, { canonicalRoot, engines, enabled }), body: rec.body || '', text: rec.text || '' };
}

module.exports = { AI_ORIGINS, sourceOf, engineStateFor, listSkillCenter, readSkillCenter };
