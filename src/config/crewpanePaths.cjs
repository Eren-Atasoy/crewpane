// CrewPane — ADP-233 (ADR-014 Karar 1) task/results yol türetme.
//
// Görev spec'leri ve sonuç raporları repo-gömülü `docs/agent-{tasks,results}`ten
// ürün-genel `<workspaceRoot>/.crewpane/{tasks,results}`e taşınır (hafızanın
// `.crewpane/memory` deseniyle simetrik — agentMemory.cjs). Bu modül TEK kaynak:
// yeni kanonik dizinler + legacy (dual-read) aday listesi. Pure — node:path'ten
// başka bağımlılık yok, fs erişimi YOK (var-olma süzgeci çağıranın işi; reports.ts
// existsSync ile süzer, bridge yazarken mkdir eder).
//
// ⚠️ İKİZ SÖZLEŞME: renderer/Next tarafı aynı mantığı `src/lib/crewpanePaths.ts`ten
// okur (CJS/ESM ayrık modül grafı — delegationBridge.js'teki gerekçenin aynısı).
// Buradaki subpath/legacy listesi değişirse TS ikizi de değişmeli; parity testi
// `crewpanePaths.test.cjs` iki dosyayı senkron tutar.

'use strict';

const path = require('node:path');

// ⚠️ Disk üzerindeki dizin adı renderer ile bir SÖZLEŞMEDİR: derlenmiş Next tarafı
// (`src/lib/crewpanePaths.ts` ikizi) `.crewpane/{tasks,results}` okur. Frontend
// kaynağı yeniden derlenmeden bu ad DEĞİŞTİRİLEMEZ (marka adı ≠ veri dizini adı).
const TASKS_SUBPATH = Object.freeze(['.crewpane', 'tasks']);
const RESULTS_SUBPATH = Object.freeze(['.crewpane', 'results']);

// Legacy (DONMUŞ) nesil — dual-read'de okunmaya devam eder, yeni yazım gelmez.
const LEGACY_SUBDIRS = Object.freeze(['', 'crewpane', 'chatflow']);

/** Girdi doğrulaması (agentMemory deseni): workspaceRoot boş/string-değilse null. */
function validRoot(workspaceRoot) {
  return typeof workspaceRoot === 'string' && workspaceRoot.trim() ? workspaceRoot : null;
}

/** Kanonik görev-spec dizini: `<root>/.crewpane/tasks`. Null when no root. */
function tasksDir(workspaceRoot) {
  const root = validRoot(workspaceRoot);
  return root ? path.join(root, ...TASKS_SUBPATH) : null;
}

/** Kanonik sonuç-raporu dizini: `<root>/.crewpane/results`. Null when no root. */
function resultsDir(workspaceRoot) {
  const root = validRoot(workspaceRoot);
  return root ? path.join(root, ...RESULTS_SUBPATH) : null;
}

function legacyDirs(workspaceRoot, leaf) {
  const root = validRoot(workspaceRoot);
  if (!root) return [];
  return LEGACY_SUBDIRS.map((sub) => path.join(root, sub, 'docs', leaf));
}

/** Legacy görev-spec dizin adayları (var-olma kontrolü çağıranın işi). */
function legacyTasksDirs(workspaceRoot) {
  return legacyDirs(workspaceRoot, 'agent-tasks');
}

/** Legacy sonuç-raporu dizin adayları (var-olma kontrolü çağıranın işi). */
function legacyResultsDirs(workspaceRoot) {
  return legacyDirs(workspaceRoot, 'agent-results');
}

module.exports = {
  TASKS_SUBPATH,
  RESULTS_SUBPATH,
  tasksDir,
  resultsDir,
  legacyTasksDirs,
  legacyResultsDirs,
};
