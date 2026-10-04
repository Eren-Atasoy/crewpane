// CrewPane — ADP-659: supervisor defterinin KALICI deposu.
//
// `delegationQueueStore.cjs`'in birebir kardeşi: instance-scoped TEK dosya
// `~/.crewpane[-dev|-test]/delegation-supervisor.json`, MAIN yazar, atomik
// tmp+rename (yarım JSON asla görünmez), bozuk dosya asla fırlatmaz.
//
// AYRI dosya olmasının sebebi: `delegation-queue.json` RENDERER'ın kuyruk defteri
// (renderer yazar, o ölünce bayatlar). Bu dosya MAIN'in uçuş defteridir — renderer
// reload'una VE app restart'ına dayanması gereken tek gerçek budur (ADP-659 kök neden).

'use strict';

const fs = require('node:fs');
// ADP-835 (790 K1) — atomik yazımın rename adımı platform boğazından geçer:
// Windows'ta Defender/Search hedefi açık tutunca EPERM/EBUSY gelir ve bu çağrıların
// çoğu best-effort catch içinde OLDUĞU İÇİN kayıt SESSİZCE kaybolurdu.
const { renameWithRetrySync } = require('../../platform/atomicWrite.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const instancePaths = require('../config/instancePaths.cjs');

const FILE_NAME = 'delegation-supervisor.json';

/** Per-instance dosya yolu. */
function supervisorPath(homedir) {
  return path.join(instancePaths.crewpaneHome(homedir), FILE_NAME);
}

/** Atomik yaz (tmp + rename). Hata FIRLATIR — çağıran loglar (sessiz kayıp = defterin ölümü). */
function saveState(state, homedir) {
  const file = supervisorPath(homedir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameWithRetrySync(tmp, file);
  return file;
}

/** Yükle. Yok / bozuk → boş defter (asla fırlatmaz). */
function loadState(homedir) {
  try {
    return JSON.parse(fs.readFileSync(supervisorPath(homedir), 'utf8'));
  } catch {
    return { version: 1, records: {} };
  }
}

module.exports = { FILE_NAME, supervisorPath, saveState, loadState };
