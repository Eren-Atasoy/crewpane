// CrewPane — ADP-206 (SPRINT-AD-25, P0) instance isolation helper.
//
// WHY: the MacBook runs the PACKAGED prod app (in /Applications) AND, while we
// develop, source DEV instances (`npm run electron:dev|prod`). Before this module
// EVERY instance shared the same `~/.crewpane` dir (live-panes.json, settings,
// the MCP configs, bridge.json, resume-queue, pane-sessions, shots), the same tmux
// session, and the same bridge handshake file. So a dev launch read PROD's
// live-panes.json, re-spawned + then clearAll()'d it, and its teardown severed the
// running PROD agent panes — "2 gündür CrewPane'te geliştirme yapılamıyor". The
// fix is a single source of truth for the per-instance config dir (+ tmux session)
// so DEV lives in its OWN world and NEVER touches PROD's registry.
//
// AUTOMATIC, ZERO-CONFIG split:
//   • PROD instance  → packaged prod DMG (no crewpaneBuild baked)   → ~/.crewpane
//   • DEV  instance  → packaged dev DMG (crewpaneBuild="dev" baked) → ~/.crewpane-dev
//   • DEV  instance  → unpackaged src (electron:dev / electron:prod) → ~/.crewpane-dev
//   • TEST instance  → packaged test DMG (crewpaneBuild="test")     → ~/.crewpane-test
// Override: CREWPANE_INSTANCE=prod|dev|test env var wins over everything.
//
// HOW it threads through the codebase: main.js PINS the resolved id into
// process.env.CREWPANE_INSTANCE at startup (resolveInstanceId), so every CHILD it
// spawns — agent panes, the embedded Next server, the MCP servers (which read this
// module too) — inherits the SAME instance. Every other module derives its
// `~/.crewpane[-dev]` path from crewpaneHome() instead of hard-coding '.crewpane'.
//
// PURE-ish + test-safe: instanceId() reads only the env, defaulting to 'prod' when
// unset (so existing unit tests that pass a tmp homedir keep resolving to
// '.crewpane' — zero behavior change for PROD/tests). crewpaneHome(homedir) keeps
// the optional `homedir` seam every registry/settings module already relies on.

// ADP-703 — HESAP KAPSAMI (ikinci eksen). Instance ekseni "hangi KURULUM" sorusunu
// çözer (prod/dev/test); hesap ekseni "hangi KULLANICI" sorusunu: aynı kurulum içinde
// her CrewPane hesabının kendi veri kökü vardır (`<instanceHome>/accounts/<key>`).
// CREWPANE_ACCOUNT env'i, CREWPANE_INSTANCE ile BİREBİR aynı desende çalışır: main.js
// açılışta PIN'ler, her çocuk süreç (pane, MCP, Next server) miras alır. Pin YOKSA
// eski davranış birebir korunur (crewpaneHome() = instance kökü) → mevcut birim
// testleri ve `homedir` dikişleri değişmeden geçer.
// Tasarım: docs/design/ACCOUNT-SCOPED-STORE.md

'use strict';

const os = require('node:os');
const path = require('node:path');
const accountScope = require('./accountScope.cjs'); // saf modül — BU dosyayı require ETMEZ (döngü yok)

const PROD = 'prod';
const DEV  = 'dev';
const TEST = 'test';

/** Normalize an arbitrary instance string → 'prod' | 'dev' | 'test' | null (unrecognized). */
function normalize(value) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (v === PROD) return PROD;
  if (v === DEV)  return DEV;
  if (v === TEST) return TEST;
  return null;
}

// ── BOARD-AUTH-02 — PAKETLEME SİNYALİ AYRI SÜREÇTE DE OKUNABİLMELİ ──────────
//
// ÖLÇÜLEN ARIZA (BOARD-AUTH-01 §1.3, hipotez değil): MCP server'ları + hook'lar +
// `crewpaneCli` düz `node` çocuklarıdır ve `app.asar.unpacked/` altından koşarlar.
// Orada `package.json` YOKTUR (asar'ın İÇİNDE kalır) ve düz node'un asar desteği de
// yoktur → `require('../../package.json')` patlar → `bakedBuildType()` null döner.
// Üç sonucu birden ölçüldü:
//   B2  paketli DEV build'de `devChannel.devAppDbTarget()` → null; "hedef build
//       zamanında sabittir" kuralı ayrı-süreçte SESSİZCE uygulanmaz.
//   B3  ⚠️ GÜVENLİK: müşteri prod paketinde `buildChannel.escapesAllowed()` → true
//       (kurulu app'in unpacked'ında ölçüldü) → müşteri kabuğunda
//       `CREWPANE_APP_SUPABASE_URL/ANON_KEY` board'u YABANCI bir DB'ye taşıyabilir.
//   B4  codex pane'lerinde MCP çocuğu pane env'ini MİRAS ALMAZ (ADP-227; canlı
//       ölçüm: `CREWPANE_INSTANCE` ve `NEXT_PUBLIC_*` yok) → kanal hiç bilinmez.
//
// İKİ BAĞIMSIZ SİNYAL (biri sessizce kaybolursa diğeri ayakta kalsın):
//   1. `bakedBuild.json` — build/afterPack.cjs `app.asar.unpacked/`e YAZAR. Kanalı,
//      dev hedefini ve "paketliyim" bayrağını taşır. ⚠️ `build.files` kalıplarına
//      GÜVENMEZ: ADP-780-B'de `devChannelTarget.json` tam da o yüzden pakete hiç
//      girmemişti. afterPack dosyayı yazar VE geri okuyup doğrular.
//   2. Modülün KENDİ yolu (`__dirname`) — `app.asar.unpacked` içinden koşuyorsak
//      bu paketli bir kopyadır. Bu sinyal env ile DEĞİŞTİRİLEMEZ ve (1) hiç
//      shipping edilmese bile ayakta kalır → B3 fail-closed olur.
const BAKED_MANIFEST = 'bakedBuild.json';

/**
 * `bakedBuild.json`u oku. `opts.manifest` test dikişidir.
 *
 * ⚠️ SONUÇ (YOKLUK DAHİL) ÖNBELLEKLENİR. `instanceId()` bu yola düşer ve o fonksiyon
 * SICAK bir yoldur (her dosya işlemi `crewpaneHome()` üzerinden çağırır). Node
 * BAŞARISIZ require'ı önbelleklemez → kaynak koşusunda her çağrı bir MODULE_NOT_FOUND
 * fırlatıp yakalardı. Dosya build ANINDA yazılır ve çalışma boyunca değişmez, yani
 * önbellek doğru.
 * @returns {object|null}
 */
let _bakedManifest; // undefined = henüz okunmadı · null = yok
function readBakedManifest(opts) {
  const o = opts || {};
  if (o.manifest !== undefined) return o.manifest;
  if (_bakedManifest !== undefined) return _bakedManifest;
  try {
    // eslint-disable-next-line global-require
    _bakedManifest = require(`./${BAKED_MANIFEST}`);
  } catch {
    // Phase 1: src/resolver.cjs used to fall back to PROJECT_ROOT for relative requests;
    // afterPack writes the manifest at the app root, so keep that lookup explicit.
    try {
      // eslint-disable-next-line global-require
      _bakedManifest = require(`../../${BAKED_MANIFEST}`);
    } catch { _bakedManifest = null; }
  }
  return _bakedManifest;
}

/**
 * Bu dizin PAKETLİ bir uygulamanın içinde mi? Saf string kararı — env okumaz,
 * dosya sistemine dokunmaz, Electron'a bağlı değildir.
 */
function packagedByPath(dir) {
  const d = String(dir == null ? '' : dir).replace(/\\/g, '/');
  if (!d) return false;
  if (/(^|\/)app\.asar(\.unpacked)?(\/|$)/.test(d)) return true;      // mac + win + linux
  if (/\.app\/Contents\/Resources(\/|$)/.test(d)) return true;         // macOS, asar'sız yerleşim
  return false;
}

/**
 * "Bu süreç paketli bir kopyanın içinden mi koşuyor?" — `app.isPackaged`in
 * Electron'suz karşılığı. `buildChannel` bunu YALNIZ `app.isPackaged` bilinmediğinde
 * (yani ayrı-süreç çocuklarında) kullanır.
 * @returns {true|null} true = paketli · null = bilinmiyor (kaynak koşusu / CI dahil)
 */
function packagedBuild(opts) {
  const o = opts || {};
  const manifest = readBakedManifest(o);
  if (manifest && manifest.packaged === true) return true;
  const dir = o.dir === undefined ? __dirname : o.dir;
  return packagedByPath(dir) ? true : null;
}

/**
 * Read the build type baked into the packaged app's package.json via
 * electron-builder `extraMetadata.crewpaneBuild`. Prod builds leave this field
 * absent (→ null); dev/test builds inject "dev"/"test" so a packaged app can
 * resolve its own instance without relying on the isPackaged heuristic.
 *
 * BOARD-AUTH-02: `package.json` okunamıyorsa (ayrı-süreç çocuğu) `bakedBuild.json`
 * manifestine düşer. Sıra bilinçli — bugünkü main-process davranışı BİREBİR korunur.
 */
function bakedBuildType(opts) {
  const o = opts || {};
  if (o.bakedBuild !== undefined) return normalize(o.bakedBuild);
  try {
    // require() is cached — safe to call repeatedly.
    const pkg = require('../../package.json');
    const v = normalize(pkg && pkg.crewpaneBuild);
    if (v) return v;
  } catch { /* ayrı-süreç çocuğu: package.json asar'ın içinde kaldı → manifeste düş */ }
  const manifest = readBakedManifest(o);
  return manifest ? normalize(manifest.crewpaneBuild) : null;
}

/**
 * ENV-08 — argv'den açık instance isteği: `--instance=<id>` ya da
 * `--crewpane-instance=<id>`. Tek-örnek kilidinin "Ayrı test profiliyle aç"
 * yolu `app.relaunch({args})` ile yeniden başlar; env oraya taşınamaz, argv
 * taşınır. Yalnız tanınan değerler ('prod'|'dev'|'test') kabul edilir.
 */
function argvInstance(argv) {
  if (!Array.isArray(argv)) return null;
  for (const a of argv) {
    const m = typeof a === 'string' ? a.match(/^--(?:crewpane-)?instance=(.+)$/) : null;
    if (m) {
      const v = normalize(m[1]);
      if (v) return v;
    }
  }
  return null;
}

/**
 * Resolve the instance id from first principles — used ONCE by main.js to PIN the
 * value into the env. Priority:
 *   0. `--instance=` argv override (ENV-08 — the separate-profile relaunch path;
 *      an explicit flag on THIS launch beats an env var inherited from a shell)
 *   1. CREWPANE_INSTANCE env override (explicit 'prod'|'dev'|'test')
 *   2. crewpaneBuild baked by electron-builder extraMetadata (packaged dev/test builds)
 *   3. opts.isPackaged hint (app.isPackaged): true → prod, false → dev
 *   4. default 'prod' (the safe, legacy ~/.crewpane world)
 */
function resolveInstanceId(opts) {
  const fromArgv = argvInstance(opts && opts.argv);
  if (fromArgv) return fromArgv;
  const override = normalize(process.env.CREWPANE_INSTANCE);
  if (override) return override;
  const baked = bakedBuildType();
  if (baked) return baked;
  if (opts && typeof opts.isPackaged === 'boolean') return opts.isPackaged ? PROD : DEV;
  return PROD;
}

/**
 * The instance id every OTHER module reads (after main.js pinned the env). Reads
 * ONLY the env so child processes (MCP servers, agent panes) stay consistent with
 * the parent. Unset → 'prod' (legacy / unit tests → '.crewpane', no regression).
 */
function instanceId(opts) {
  const fromEnv = normalize(process.env.CREWPANE_INSTANCE);
  if (fromEnv) return fromEnv;
  // BOARD-AUTH-02 / B4 — codex pane'lerinde MCP çocuğu pane env'ini MİRAS ALMAZ
  // (ölçüldü: canlı codex task-MCP çocuğunda CREWPANE_INSTANCE yok). Damga olmadan
  // 'prod'a düşerdik → paketli DEV app'in aracı PROD board'a yazardı. Damga env
  // DEĞİLDİR: pakete build anında girer, kabuktan yazılamaz. Kaynak koşusunda ve
  // birim testlerinde damga yoktur → davranış birebir aynı kalır.
  const o = opts || {};
  const baked = o.baked === undefined ? bakedBuildType() : normalize(o.baked);
  return baked || PROD;
}

/** True when running as the DEV (unpackaged / source) instance. */
function isDev() {
  return instanceId() === DEV;
}

/** True when running as the TEST (auto-launched by e2e / agents) instance. */
function isTest() {
  return instanceId() === TEST;
}

/**
 * Basename of the per-instance config dir. PROD keeps the legacy '.crewpane';
 * DEV gets '.crewpane-dev'; TEST gets '.crewpane-test'.
 */
function dirName() {
  const id = instanceId();
  if (id === DEV)  return '.crewpane-dev';
  if (id === TEST) return '.crewpane-test';
  return '.crewpane';
}

/**
 * Absolute per-instance config dir (PROD ~/.crewpane, DEV ~/.crewpane-dev). The
 * optional `homedir` is the SAME seam the registry/settings modules already accept
 * (unit tests pass a tmp dir; main.js honors the CREWPANE_HOME test seam). When
 * omitted it falls back to CREWPANE_HOME (e2e relocation) then the OS home.
 *
 * ADP-703 — this is the DEVICE root: it holds the things that must NOT travel with a
 * CrewPane account (auth blobs — they DECIDE the account, so they can't live inside
 * it; the runtime bridge handshake; machine logs/caches). Everything else lives in
 * the ACCOUNT root below. Callers that were already account-agnostic keep using
 * crewpaneHome(); a caller must opt INTO instanceHome() deliberately.
 */
function instanceHome(homedir) {
  const base = homedir || process.env.CREWPANE_HOME || os.homedir();
  return path.join(base, dirName());
}

/**
 * ADP-703 — the pinned account key (`CREWPANE_ACCOUNT`), sanitized. Reads ONLY the
 * env so every child process resolves the SAME account root as its parent — exactly
 * the instanceId() contract. Unset/invalid → null → legacy (unscoped) behaviour.
 */
function accountKey() {
  return accountScope.normalizeAccountKey(process.env.CREWPANE_ACCOUNT);
}

/**
 * The ACCOUNT-scoped data root — what every store module (settings, memory, pane
 * registry, delegation ledger, sprint runs, vault…) resolves. With an account pinned:
 * `<instanceHome>/accounts/<key>`; without one: the instance root itself (legacy
 * behaviour, byte-for-byte — unit tests and pre-ADP-703 installs are unaffected).
 */
function crewpaneHome(homedir) {
  const root = instanceHome(homedir);
  const key = accountKey();
  return key ? path.join(root, accountScope.ACCOUNTS_DIR, key) : root;
}

/**
 * The tmux session the in-app team-window switch (tmuxWindows) + tmux resume target.
 * Instance-scoped so DEV's tmux commands never select/disturb PROD's operator
 * session. Env override (CREWPANE_TMUX_SESSION) still wins. PROD default 'crewpane'
 * (unchanged); DEV default 'crewpane-dev'.
 */
function tmuxSession() {
  if (process.env.CREWPANE_TMUX_SESSION) return process.env.CREWPANE_TMUX_SESSION;
  const id = instanceId();
  if (id === DEV)  return 'crewpane-dev';
  if (id === TEST) return 'crewpane-test';
  return 'crewpane';
}

module.exports = {
  PROD,
  DEV,
  TEST,
  normalize,
  bakedBuildType,
  readBakedManifest,
  packagedByPath,
  packagedBuild,
  BAKED_MANIFEST,
  argvInstance,
  resolveInstanceId,
  instanceId,
  isDev,
  isTest,
  dirName,
  instanceHome,
  accountKey,
  crewpaneHome,
  tmuxSession,
};
