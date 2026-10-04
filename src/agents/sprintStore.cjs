// CrewPane — ADP-242 sprint-run kalıcılık deposu.
//
// Uzun-sprint orkestrasyonun (sprintOrchestrator.ts saf çekirdeği) diske yazılan
// TEK-GERÇEK durumu: `~/.crewpane[-dev|-test]/sprint-runs/<id>.json` — run başına
// bir dosya, Electron MAIN yazar (renderer'ın fs erişimi yok; IPC `sprint:save/
// load/list` buraya iner ve path'i HEP main kurar — renderer path geçemez).
// resumeQueue.cjs'in birebir deseni: instance-scoped dizin (ADP-206) + atomik
// tmp+rename yazım (yarım JSON asla görünmez) + bozuk dosya asla fırlatmaz.
//
// `resume-queue.json`'a YAZILMAZ/OKUNMAZ — o resume daemon'ının tek-yazarlı
// state'i (spec §3.5-5); sprint durumu tamamen bu dizinde yaşar.

'use strict';

const fs = require('node:fs');
// ADP-835 (790 K1) — atomik yazımın rename adımı platform boğazından geçer:
// Windows'ta Defender/Search hedefi açık tutunca EPERM/EBUSY gelir ve bu çağrıların
// çoğu best-effort catch içinde OLDUĞU İÇİN kayıt SESSİZCE kaybolurdu.
const { renameWithRetrySync } = require('../../platform/atomicWrite.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const instancePaths = require('../config/instancePaths.cjs');

const STORE_VERSION = 1;
const DIR_NAME = 'sprint-runs';
// Bir task terminal mi? (sprintOrchestrator.isSprintSettled'ın CJS aynası —
// list() "devam eden run var mı"yı renderer'a modül import'suz söyleyebilsin.)
const TERMINAL_TASK = Object.freeze(['done', 'failed', 'skipped']);

/** Per-instance sprint dizini: ~/.crewpane[-dev|-test]/sprint-runs. */
function sprintDir(homedir) {
  return path.join(instancePaths.crewpaneHome(homedir), DIR_NAME);
}

/**
 * Run id → güvenli dosya adı. Id RENDERER'dan gelir → traversal yüzeyi:
 * yalnız [A-Za-z0-9._-] kalır, ayraçlar ve ".." imkânsız. Boş kalan id null.
 */
function sprintFileName(id) {
  const safe = String(id || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '');
  return safe ? `${safe}.json` : null;
}

function sprintPath(id, homedir) {
  const name = sprintFileName(id);
  return name ? path.join(sprintDir(homedir), name) : null;
}

/** Run'daki her task terminal mi (done/failed/skipped)? Bozuk şekil → true (bitmiş say). */
function isSettledRun(run) {
  if (!run || !Array.isArray(run.tasks)) return true;
  return run.tasks.every((t) => t && TERMINAL_TASK.includes(t.status));
}

/**
 * Run'ı atomik yaz (tmp + rename; aynı dizin → aynı fs → atomik). Şekil kontrolü
 * minimal: id'li bir obje şart. Dönen değer dosya yolu; hata FIRLATIR (çağıran IPC
 * handler'ı {ok:false} çevirir — sessiz kayıp sprint kaybı demek).
 */
function saveSprintRun(run, homedir) {
  if (!run || typeof run !== 'object' || typeof run.id !== 'string' || !run.id.trim()) {
    throw new Error('sprint run: id\'li bir obje gerekli');
  }
  const file = sprintPath(run.id, homedir);
  if (!file) throw new Error(`sprint run: kullanılabilir id yok (${run.id})`);
  const dir = sprintDir(homedir);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: STORE_VERSION, run }, null, 2));
  renameWithRetrySync(tmp, file);
  return file;
}

/** Run'ı yükle. Yok / bozuk / şekilsiz → null (asla fırlatmaz). */
function loadSprintRun(id, homedir) {
  const file = sprintPath(id, homedir);
  if (!file) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const run = parsed && typeof parsed === 'object' ? parsed.run : null;
    if (!run || typeof run !== 'object' || typeof run.id !== 'string') return null;
    return run;
  } catch {
    return null;
  }
}

/**
 * Tüm kayıtlı run'ların özeti (rehydrate girişi): { id, settled, updatedAt,
 * objective, taskCount }. Bozuk dosyalar atlanır. En yeni updatedAt önce.
 */
function listSprintRuns(homedir) {
  let names;
  try {
    names = fs.readdirSync(sprintDir(homedir)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(sprintDir(homedir), name), 'utf8'));
      const run = parsed && parsed.run;
      if (!run || typeof run.id !== 'string') continue;
      out.push({
        id: run.id,
        settled: isSettledRun(run),
        updatedAt: Number.isFinite(run.updatedAt) ? run.updatedAt : 0,
        objective: typeof run.objective === 'string' ? run.objective : '',
        taskCount: Array.isArray(run.tasks) ? run.tasks.length : 0,
      });
    } catch {
      /* bozuk dosya — atla */
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Run dosyasını sil (test/temizlik). true = silindi. */
function removeSprintRun(id, homedir) {
  const file = sprintPath(id, homedir);
  if (!file) return false;
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  STORE_VERSION,
  TERMINAL_TASK,
  sprintDir,
  sprintFileName,
  sprintPath,
  isSettledRun,
  saveSprintRun,
  loadSprintRun,
  listSprintRuns,
  removeSprintRun,
};
