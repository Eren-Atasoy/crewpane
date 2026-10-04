// CrewPane — QUEUE-PERSIST: meşgul-kuyruğu + paused-delegasyon kalıcılık deposu.
//
// ADP-281 busyGuard kuyruğu ve ADP-288 paused kayıtları renderer-ömürlüydü — app
// restart'ında kuyruklanmış objective'ler ve limitte duraklamış delegasyonların
// devam planı KAYBOLUYORDU (pane-düzeyi devam daemon'da yaşasa da delegasyon
// defteri ölüyordu). Bu depo sprintStore.cjs deseninin birebir uyarlaması:
// instance-scoped TEK dosya `~/.crewpane[-dev|-test]/delegation-queue.json`,
// Electron MAIN yazar (renderer fs'e inemez; IPC `dlgqueue:save/load`), atomik
// tmp+rename (yarım JSON asla görünmez), bozuk dosya asla fırlatmaz.
//
// `resume-queue.json` (pty resume daemon'ı) ve `sprint-runs/` AYRI tek-yazarlı
// state'lerdir — bu dosyaya karışmazlar.

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
const FILE_NAME = 'delegation-queue.json';

/** Per-instance dosya yolu: ~/.crewpane[-dev|-test]/delegation-queue.json. */
function queuePath(homedir) {
  return path.join(instancePaths.crewpaneHome(homedir), FILE_NAME);
}

/** Şekil toleransı: her zaman { queued: [], paused: [] } döndür. */
function normalizeState(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    queued: Array.isArray(s.queued) ? s.queued.filter((q) => q && typeof q === 'object') : [],
    paused: Array.isArray(s.paused) ? s.paused.filter((p) => p && typeof p === 'object') : [],
  };
}

/**
 * Durumu atomik yaz (tmp + rename). Hata FIRLATIR — çağıran IPC handler'ı
 * {ok:false}'a çevirir (sessiz kayıp = kuyruğun ölümü, renderer bilmeli).
 */
function saveQueueState(state, homedir) {
  const clean = normalizeState(state);
  const file = queuePath(homedir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: STORE_VERSION, ...clean }, null, 2));
  renameWithRetrySync(tmp, file);
  return file;
}

/** Durumu yükle. Yok / bozuk → boş durum (asla fırlatmaz). */
function loadQueueState(homedir) {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(queuePath(homedir), 'utf8')));
  } catch {
    return { queued: [], paused: [] };
  }
}

module.exports = { STORE_VERSION, FILE_NAME, queuePath, normalizeState, saveQueueState, loadQueueState };
