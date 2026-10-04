// CrewPane — SK-08 (ADR-SKILL-CENTER §10) SKILL PAYLAŞIMI: dışa/içe aktarım.
//
// 🔴 BU MODÜL ADR §7.1'İN ANLATTIĞI TEHDİDİN GİRİŞ KAPISIDIR. Snyk 3.984 skill'in
// %36,8'inde kusur, Koi 2.857'nin 341'inde kötücül yük ölçtü; Cloud Security Alliance
// bunu ayrı bir tedarik-zinciri yüzeyi olarak brifledi ("SKILL.md agent context
// poisoning"). Dışarıdan gelen bir SKILL.md, o ekosistemin dosyasıyla AYNI dosyadır.
//
// Bu yüzden içe aktarımın sözleşmesi TEK cümledir ve istisnası yoktur:
//
//     İÇE AKTARILAN HER SKILL TASLAĞA DÜŞER. Otomatik yayın YOKTUR.
//
// Uygulaması bir bayrak değil, bir YOL seçimidir: bu modülün `skillStore.publishDraft`
// çağırma imkânı yok — yazımı `skillAuthor.saveDraft` üzerinden yapar (SK-08 (a) tek
// boğaz) ve o boğaz `skill-drafts/` dışına yazamaz. Yani "otomatik yayın yok" bir
// karar değil, kodun ulaşamadığı bir durum.
//
// 🔑 İÇE AKTARIMDA DÜŞÜRÜLEN İKİ ŞEY (ikisi de sessiz yalan olurdu):
//   • Onay damgaları — başkasının onayı bizim onayımız değildir. Damgayla gelen bir
//     dosya, Merkez'de "incelendi" görünür ve insan onayı atlanmış olurdu.
//   • `crewpane.status: published` iddiası — statüyü dizin belirler, dosya değil.
// Bunları `skillAuthor.FORBIDDEN_META` zaten süzer; burada AYRICA provenans yazılır
// (`origin: imported` + kaynak) ki Merkez "bu dışarıdan geldi" rozetini gösterebilsin.
//
// fs'e doğrudan dokunmaz (okuma hariç) — yazım boğazdan geçer.

'use strict';

const fs = require('node:fs');
const F = require('./skillFormat.cjs');
const skillStore = require('./skillStore.cjs');
const skillAuthor = require('./skillAuthor.cjs');
const secretScan = require('./skillSecretScan.cjs');

/** İçe aktarımda ASLA korunmayan metadata anahtarları (yabancı onay iddiaları). */
const STRIPPED_ON_IMPORT = Object.freeze([
  'crewpane.reviewedBy',
  'crewpane.reviewedAt',
  'crewpane.status',
  'crewpane.version',
]);

/**
 * DIŞA AKTAR — bir skillin paylaşılabilir SKILL.md metni.
 *
 * Dışa aktarım bir YAYIN fiili değildir (dosya kullanıcının seçtiği yere gider), ama
 * yine de sır taramasından geçer: bir jetonu "yalnız dışa aktardık" diye mazur görmek,
 * sızıntının tanımını değiştirmez. Bulgu varsa metin VERİLMEZ.
 *
 * @returns {{ok:boolean, name?:string, text?:string, scope?:string, errors:Array}}
 */
function exportSkill({ workspaceRoot, name, scope = 'published' } = {}) {
  const rec = skillStore.readSkill(workspaceRoot, name, scope);
  if (!rec || !rec.exists) {
    return { ok: false, errors: [{ code: 'skill-missing', message: `Skill yok: ${name} (${scope})` }] };
  }
  const scan = secretScan.scanSkillText(rec.text);
  if (!scan.ok) {
    return { ok: false, errors: secretScan.toErrors(scan), blockedBy: 'secret-scan' };
  }
  return { ok: true, name: rec.name, scope, text: rec.text, file: rec.file, errors: [] };
}

/**
 * İÇE AKTAR (metinden) — HER ZAMAN taslağa.
 *
 * @param {object} o
 * @param {string} o.workspaceRoot
 * @param {string} o.text           ham SKILL.md
 * @param {string} [o.name]         ad zorlaması (yoksa frontmatter'daki ad)
 * @param {string} [o.source]       nereden geldi (dosya yolu/URL) — provenans
 * @param {string} [o.importedBy]   kim aldı
 * @param {boolean}[o.overwriteDraft] aynı adlı taslak varsa üzerine yaz
 * @returns {{ok:boolean, name?:string, scope?:'draft', pendingApproval?:true, errors:Array}}
 */
function importSkillText({ workspaceRoot, text, name, source, importedBy, overwriteDraft = false } = {}) {
  if (!skillStore.draftsRoot(workspaceRoot)) {
    return { ok: false, errors: [{ code: 'no-workspace', message: 'Çalışma alanı seçili değil' }] };
  }
  const raw = typeof text === 'string' ? text : '';
  if (!raw.trim()) return { ok: false, errors: [{ code: 'empty', message: 'Boş içerik' }] };

  const parsed = F.parseSkillMd(raw);
  const fm = parsed.frontmatter || {};
  const wanted = name || fm.name;
  if (!wanted) {
    return { ok: false, errors: [{ code: 'name-missing', message: 'SKILL.md `name` taşımıyor ve ad verilmedi' }] };
  }
  const slug = F.safeName(wanted);

  // Sır taraması İÇE AKTARIMDA da: yabancı dosya en çok güvenilmeyecek olandır.
  const scan = secretScan.scanSkillText(raw);
  if (!scan.ok) return { ok: false, errors: secretScan.toErrors(scan), blockedBy: 'secret-scan' };

  // Yabancı onay iddialarını düşür, provenansı yaz.
  const meta = {};
  for (const [k, v] of Object.entries((fm.metadata && typeof fm.metadata === 'object' && fm.metadata) || {})) {
    if (STRIPPED_ON_IMPORT.includes(k)) continue;
    meta[k] = v;
  }
  meta['crewpane.origin'] = 'imported';
  if (source) meta['crewpane.importedFrom'] = String(source);
  if (importedBy) meta['crewpane.importedBy'] = String(importedBy);
  meta['crewpane.importedAt'] = new Date().toISOString();

  // Aynı adlı taslak varsa: sessiz üzerine yazma YOK (mode='create' hata verir).
  const existingDraft = skillStore.readSkill(workspaceRoot, slug, 'draft');
  const mode = existingDraft && overwriteDraft ? 'update' : 'create';

  const res = skillAuthor.saveDraft({
    workspaceRoot,
    name: slug,
    description: fm.description,
    body: parsed.body,
    mode,
    origin: 'imported',
    metadata: meta,
  });
  if (!res.ok) return { ok: false, errors: res.errors || [], warnings: res.warnings || [] };

  return {
    ok: true,
    name: res.name,
    scope: 'draft',
    file: res.file,
    pendingApproval: true, // sabit: bu modülün "yayınlandı" diyebileceği yol YOK
    errors: [],
    warnings: res.warnings || [],
  };
}

/** İÇE AKTAR (dosyadan) — okuma dışında iş yapmaz, kararı `importSkillText` verir. */
function importSkillFile({ workspaceRoot, filePath, name, importedBy, overwriteDraft = false } = {}) {
  let text = '';
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { ok: false, errors: [{ code: 'read-failed', message: `Okunamadı: ${filePath} (${err.message})` }] };
  }
  return importSkillText({ workspaceRoot, text, name, source: filePath, importedBy, overwriteDraft });
}

module.exports = { STRIPPED_ON_IMPORT, exportSkill, importSkillText, importSkillFile };
