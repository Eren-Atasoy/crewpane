// CrewPane — SKL-B5: GÖMÜLÜ SKILL KATALOĞUNUN yol boğazı (tek yardımcı).
//
// 🔑 NEDEN AYRI BİR MODÜL (ölçülmüş kısıt, tasarım §2.1): motorlar (claude, codex,
// gemini…) CrewPane'in çocuk süreçleridir ama Electron DEĞİLDİR — asar sanal dosya
// sistemi yalnız Electron'un yamalı `fs`'inde görünür. SKL-R3 §2.4 kurulu üründe ölçtü:
//     cat …/CrewPane.app/Contents/Resources/app.asar/package.json → Not a directory
// Bu yüzden katalog `build.files` ile DEĞİL, `build.extraResources` ile paketlenir
// (emsal: `standalone` + `mobile-web`) ve GERÇEK bir dizin olarak Resources'a iner.
// Çözüm tek yerde durur ki hem kurulum boğazı (SKL-B6) hem paket kapısı aynı kuralı
// okusun; iki ayrı yol hesabı = ikinci gerçek = sapma.
//
// Electron'a bağımlı DEĞİL: `app.isPackaged` yerine DURUMDAN türetir (hangi aday
// diskte var), böylece hem ana süreçte hem `crewpaneCli.cjs` gibi çıplak node
// çocuklarında aynı sonucu verir ve birim testi tmp dizinlerle koşar.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DIR_NAME = 'builtin-skills';
const CATALOG_FILE = 'catalog.json';
const SKILL_FILE = 'SKILL.md';

// Paketli app'te bu dosya `Resources/app.asar` (ya da `Resources/app.asar.unpacked`)
// altındadır → bir üst dizin HER İKİ durumda da `Resources`. Kaynaktan koşarken
// `electron/` → bir üst dizin repo kökü. Yani tek ifade iki dünyayı da çözer;
// `process.resourcesPath` yine de İLK aday, çünkü niyeti en açık söyleyen odur.
function resolveSkillsParent() {
  const candidates = [
    path.join(__dirname, DIR_NAME),
    path.join(__dirname, '..', DIR_NAME),
    path.join(__dirname, '..', '..', DIR_NAME),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return path.dirname(c);
  }
  return path.join(__dirname, '..', '..');
}
const MODULE_PARENT = resolveSkillsParent();

/** Bir yol asar arşivinin İÇİNDE mi? (`app.asar.unpacked` İÇİNDE DEĞİLDİR — gerçek dizin.) */
function isInsideAsar(p) {
  return String(p)
    .split(path.sep)
    .some((seg) => seg.toLowerCase().endsWith('.asar'));
}

/**
 * Aday katalog kökleri — sırayla denenir. `resourcesPath` çıplak node çocuklarında
 * undefined'dır (Electron enjekte eder); o durumda liste tek adaya düşer.
 */
function builtinSkillsCandidates({ resourcesPath = process.resourcesPath, moduleParent = MODULE_PARENT } = {}) {
  const out = [];
  if (typeof resourcesPath === 'string' && resourcesPath) out.push(path.join(resourcesPath, DIR_NAME));
  if (typeof moduleParent === 'string' && moduleParent) out.push(path.join(moduleParent, DIR_NAME));
  return out.filter((p, i) => !isInsideAsar(p) && out.indexOf(p) === i);
}

/** Bir dizin GEÇERLİ katalog kökü mü: gerçek dizin + okunabilir `catalog.json`. */
function isCatalogRoot(dir, { statSync = fs.statSync } = {}) {
  if (!dir || isInsideAsar(dir)) return false;
  try {
    if (!statSync(dir).isDirectory()) return false;
    return statSync(path.join(dir, CATALOG_FILE)).isFile();
  } catch {
    return false;
  }
}

/**
 * Gömülü katalog kökü — YOKSA `null` (uydurma yol döndürmez: çağıran "katalog yok"
 * ile "katalog bozuk"u ayırt edebilsin).
 */
function builtinSkillsDir(opts = {}) {
  return builtinSkillsCandidates(opts).find((d) => isCatalogRoot(d, opts)) || null;
}

/** `<kök>/catalog.json` — kök çözülemezse null. */
function catalogPath(opts = {}) {
  const dir = typeof opts === 'string' ? opts : builtinSkillsDir(opts);
  return dir ? path.join(dir, CATALOG_FILE) : null;
}

/** `<kök>/<ad>/SKILL.md` — kök çözülemezse ya da ad boşsa null. */
function skillFilePath(name, opts = {}) {
  const dir = typeof opts === 'string' ? opts : builtinSkillsDir(opts);
  if (!dir || typeof name !== 'string' || !name.trim()) return null;
  return path.join(dir, name, SKILL_FILE);
}

module.exports = {
  DIR_NAME,
  CATALOG_FILE,
  SKILL_FILE,
  isInsideAsar,
  isCatalogRoot,
  builtinSkillsCandidates,
  builtinSkillsDir,
  catalogPath,
  skillFilePath,
};
