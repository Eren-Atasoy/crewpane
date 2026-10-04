// CrewPane — ADP-545 notify-log yol çözümü (dev + PACKAGED tek mantık).
//
// KÖK NEDEN (ADP-538'in kendi notundaki uyarının kanıtlanmış hali): packaged app'te
// eski resolveResumeNotifyPath REPO_ROOT'un asar içinde (salt-okunur) olması yüzünden
// notify satırlarını ~/.crewpane/resume-notifications.log'a düşürüyordu — ama HİÇBİR
// lider orayı izlemez. Liderlerin Monitor tail'leri (protokol: Optimus CLAUDE.md +
// spawn-worker NOTIFY_LOG routing'i) İŞ ALANINDAKİ dosyalardadır:
//   crewpane takımı → <workspace>/crewpane/docs/.agent-notifications
//   chatflow         → <workspace>/chatflow/docs/.agent-notifications
//   education        → <workspace>/skool/docs/.agent-notifications
// Yani ADP-538 emit-fix'i kurulu app'e girse bile satır YANLIŞ dosyaya düşecekti →
// auto-trigger yine ölü. Bu modül hedefi ADP-502'nin aday-probe deseniyle çözer:
// var olan İLK docs/ dizini kazanır, hiçbiri yoksa instance-dir fallback.
//
// Leaf modül: yalnız departmentDirs.cjs'e bağımlı → node --test doğrudan koşar.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { dirForDepartment } = require('../agents/departmentDirs.cjs');

/** Liderlerin grep'lediği dosya adı (spawn-worker NOTIFY_LOG ile birebir). */
const NOTIFY_BASENAME = '.agent-notifications';

/**
 * Notify-log dosya yolunu çöz.
 *   1. `envOverride` (CREWPANE_RESUME_NOTIFY — e2e/test dikişi) her şeyi ezer.
 *   2. Aday docs/ dizinleri sırayla probelanır (İLK VAR OLAN kazanır):
 *      a. `<dirForDepartment(department)>/docs` — chatflow/education kurulumda doğru
 *         hedefe, dev checkout'ta (dept dir = root) REPO_ROOT/docs'a çözülür.
 *      b. `<root>/crewpane/docs` — kurulu workspace'te ("CrewPane Apps" kökü)
 *         Optimus'un tail'lediği protokol hedefi; crewpane dept'in CWD'si workspace
 *         kökü olduğundan (DEPARTMENT_SUBPATH.crewpane=[]) (a) burada ıskalar.
 *      c. `<root>/docs` — root'un kendisi bir checkout ise (dev) genel hedef.
 *   3. Hiçbiri yoksa `instanceFallback` (eski packaged davranışı — en azından yazılır).
 * Saf-ish (gerçek fs probe; test tmp dizinlerle sürer). Asla throw etmez.
 */
function resolveNotifyPath(opts) {
  const o = opts || {};
  if (typeof o.envOverride === 'string' && o.envOverride.length > 0) return o.envOverride;
  const root = typeof o.workspaceRoot === 'string' && o.workspaceRoot.length > 0 ? o.workspaceRoot : null;
  const candidates = [];
  if (root) {
    if (typeof o.department === 'string' && o.department.trim()) {
      try {
        const deptDir = dirForDepartment(o.department, root, o.mapping, o.log);
        // deptDir === root (crewpane dept / bilinmeyen) ADAY DEĞİL: root/docs zaten
        // son sırada denenir. Öne alınsaydı, workspace köküne sonradan beliren bir
        // docs/ dizini (ör. bir worker'ın cwd-göreli mkdir'i) protokol hedefi olan
        // <root>/crewpane/docs'u sessizce gölgelerdi.
        if (deptDir && path.resolve(deptDir) !== path.resolve(root)) {
          candidates.push(path.join(deptDir, 'docs'));
        }
      } catch {
        /* dept resolution best-effort — kalan adaylar denenir */
      }
    }
    candidates.push(path.join(root, 'crewpane', 'docs'));
    candidates.push(path.join(root, 'docs'));
  }
  for (const dir of candidates) {
    try {
      if (fs.statSync(dir).isDirectory()) return path.join(dir, NOTIFY_BASENAME);
    } catch {
      /* aday yok — sıradakine geç; asla HOME'a yazma */
    }
  }
  return o.instanceFallback || null;
}

module.exports = { NOTIFY_BASENAME, resolveNotifyPath };
