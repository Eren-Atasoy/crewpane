// CrewPane — SEARCH-2 (bumblebee) GENEL ARAMA SERVİSİ (ana süreç).
//
// İki işi vardır ve ikisi BİLEREK ayrıdır:
//   1. YAZAN taraf: indeksleme çocuğunu (`searchIndexWorker.cjs`) `fork` ile başlatır
//      ve ilerlemesini yayar. Yazma HİÇBİR ZAMAN main'de olmaz (tam kurulum 30,7 s
//      ölçüldü — main'de koşsa pencere o süre boyunca boyanmazdı).
//   2. OKUYAN taraf: sorgular için AYRI, SALT-OKUNUR bir bağlantı tutar. SQLite'ın
//      WAL kipinde okur yazarı beklemez → indeksleme sürerken arama çalışır.
//
// 🪤 SALT-OKUNUR AÇILIŞ DOSYA YOKSA PATLAR: ilk açılışta indeks henüz kurulmamıştır.
// O yüzden bağlantı TEMBEL kurulur ve başarısızlık `reason` ile GÖRÜNÜR döner —
// "sonuç yok" ile "indeks yok" aynı şey değildir ve kullanıcıya aynı şey denmemelidir.
//
// Desen ADP-870'in `memoryIndexService.cjs`inden alındı (fork + ELECTRON_RUN_AS_NODE
// + düşük öncelik + ilerleme yayını); model/gömme tarafı YOK, bu indeks salt kelime.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');

const store = require('./searchIndexStore.cjs');

const WORKER = path.join(__dirname, 'searchIndexWorker.cjs');

/**
 * @param {object} opts
 *  - dbFile: indeks dosyası
 *  - repoRoot / workspaceRoot / home
 *  - logLine: main'in günlükçüsü
 *  - onEvent: ilerleme yayını (renderer'a köprü)
 *  - spawnImpl / sqlite: testin dikişleri
 */
function createSearchIndexService(opts = {}) {
  const {
    dbFile,
    repoRoot,
    workspaceRoot,
    home = os.homedir(),
    logLine = () => {},
    onEvent = () => {},
    spawnImpl = null,
    lowPriority = true,
  } = opts;

  let child = null;
  let state = { running: false, phase: 'idle', startedAt: 0, lastResult: null, reason: '' };
  let readDb = null;
  let readDbError = '';
  let sessionsEnabled = opts.sessionsEnabled !== false;

  const tasksFile = dbFile ? `${dbFile}.tasks.jsonl` : '';

  /** Sorgu bağlantısı — TEMBEL. Dosya yoksa hata SAKLANMAZ, `status`ta görünür. */
  function reader() {
    if (readDb) return readDb;
    try {
      if (!fs.existsSync(dbFile)) {
        readDbError = 'index_not_built';
        return null;
      }
      readDb = store.openIndex({ file: dbFile, readonly: true });
      readDbError = '';
      return readDb;
    } catch (err) {
      readDbError = err && err.message ? err.message : String(err);
      return null;
    }
  }

  /** İndeks dosyası değiştiyse okur bağlantısını tazele (yeni kurulum sonrası). */
  function refreshReader() {
    if (readDb) {
      try {
        readDb.close();
      } catch {
        /* zaten kapalı */
      }
      readDb = null;
    }
    readDbError = '';
  }

  /**
   * Görev anlık görüntüsünü diske yaz — işçi Supabase'e BAĞLANMAZ.
   * Renderer zaten kartları belleğinde tutuyor; yeni bir ağ yolu icat etmiyoruz.
   */
  function syncTasks(rows) {
    if (!tasksFile) return { ok: false, reason: 'no_db' };
    try {
      const lines = (rows || [])
        .filter((t) => t && t.id)
        .map((t) => JSON.stringify({ id: t.id, title: t.title, description: t.description, status: t.status, sprint: t.sprint, project: t.project, assigned_agent_id: t.assigned_agent_id, updated_at: t.updated_at, created_at: t.created_at }));
      fs.mkdirSync(path.dirname(tasksFile), { recursive: true });
      fs.writeFileSync(tasksFile, lines.join('\n'));
      return { ok: true, rows: lines.length };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  function start({ force = false } = {}) {
    if (state.running) return { ok: false, reason: 'already_running' };
    if (!dbFile) return { ok: false, reason: 'no_db' };
    const args = [
      '--db', dbFile,
      '--repo', repoRoot,
      '--workspace', workspaceRoot,
      '--home', home,
      '--sessions', sessionsEnabled ? '1' : '0',
    ];
    if (tasksFile && fs.existsSync(tasksFile)) args.push('--tasks', tasksFile);
    if (force) args.push('--force', '1');

    const spawn = spawnImpl || ((mod, argv, o) => fork(mod, argv, o));
    try {
      child = spawn(WORKER, args, {
        execPath: process.execPath,
        // Paketli app'te process.execPath = Electron ikilisi → Node modu ŞART.
        // Ayrıca FTS5 YALNIZ Electron'un node'unda var (sistem Node 23.6'da yok).
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
    } catch (err) {
      state = { ...state, running: false, phase: 'error', reason: err.message };
      return { ok: false, reason: err.message };
    }

    // İndeksleme kullanıcının önüne geçmez (ADP-900 dersi): CPU önceliği düşürülür.
    if (lowPriority && child && child.pid) {
      try {
        os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        /* desteklenmeyen platformda sessizce atlanır */
      }
    }

    state = { running: true, phase: 'start', startedAt: Date.now(), lastResult: null, reason: '' };
    onEvent({ phase: 'start' });

    child.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      state = { ...state, phase: msg.phase || state.phase };
      if (msg.phase === 'done') {
        state = { ...state, lastResult: msg };
        refreshReader();
      }
      if (msg.phase === 'error') state = { ...state, reason: msg.reason || '' };
      onEvent(msg);
    });
    if (child.stderr) child.stderr.on('data', (b) => logLine(`searchIndex[worker]: ${String(b).trim()}`));
    child.on('exit', (code) => {
      state = { ...state, running: false, phase: state.phase === 'done' ? 'done' : 'exit' };
      child = null;
      refreshReader();
      onEvent({ phase: 'exit', code });
    });
    return { ok: true, dbFile };
  }

  function stop() {
    if (!child) return { ok: false, reason: 'not_running' };
    try {
      child.kill();
    } catch {
      /* zaten ölmüş */
    }
    return { ok: true };
  }

  /**
   * SORGU — indeks yoksa `ok:false, reason:'index_not_built'`.
   * "Sonuç yok" ile "indeks yok" ayrı cevaplardır; ikisini birleştirmek kullanıcıya
   * ürünün çalıştığını ama hiçbir şey bulamadığını söylemek olurdu.
   */
  function query({ text, types = null, agent = null, perType = 5 } = {}) {
    const db = reader();
    if (!db) return { ok: false, reason: readDbError || 'index_not_built', groups: {}, total: 0 };
    if (!store.hasFts(db)) return { ok: false, reason: 'fts_unavailable', groups: {}, total: 0 };
    const r = store.query(db, text, { types, agent, perType });
    return { ok: true, ...r };
  }

  function status() {
    const db = reader();
    const s = db ? store.stats(db) : null;
    const built = db ? store.lastBuild(db) : null;
    let dbBytes = 0;
    try {
      dbBytes = fs.statSync(dbFile).size;
    } catch {
      dbBytes = 0;
    }
    return {
      running: state.running,
      phase: state.phase,
      startedAt: state.startedAt,
      reason: state.reason || readDbError,
      sessionsEnabled,
      dbFile,
      dbBytes,
      stats: s,
      // "İndeks VAR" ile "indeks TAZE" ayrı sorulardır: ilkine bakıp ikincisini
      // sormayan bir tetikleyici, indeksi ilk kurulumda dondurur (e2e yakaladı:
      // ikinci koşumda yeni rapor ve yeni oturum indekse HİÇ girmedi).
      lastBuildAt: built && Number.isFinite(built.at) ? built.at : 0,
      lastResult: state.lastResult ? { ms: state.lastResult.ms, sources: state.lastResult.sources, dbBytes: state.lastResult.dbBytes } : null,
    };
  }

  /**
   * OPT-OUT. Kapatmak "gizle" değil SİL demektir: bir sonraki tur oturum belgelerini
   * indeksten kaldırır. Kullanıcı "aramasın" dediğinde verinin diskte aranabilir
   * hâlde durması, ayarın yalan söylemesidir.
   */
  function setSessionsEnabled(next) {
    const v = !!next;
    if (v === sessionsEnabled) return { ok: true, sessionsEnabled, changed: false };
    sessionsEnabled = v;
    const r = state.running ? { ok: false, reason: 'already_running' } : start();
    return { ok: true, sessionsEnabled, changed: true, reindex: r };
  }

  function dispose() {
    stop();
    refreshReader();
  }

  return { start, stop, query, status, syncTasks, setSessionsEnabled, dispose, get sessionsEnabled() { return sessionsEnabled; } };
}

module.exports = { createSearchIndexService, WORKER };
