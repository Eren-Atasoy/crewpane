// RESET-01 — Kurulumu sıfırla: çekirdek SİLİCİ modülü (SPRINT-REL-0247, 0.2.47 önkoşul).
//
// NE: uygulamanın KENDİ kalıcı verisini iki seviyede güvenle siler.
//   · level:'session' → yalnız `<instanceHome>/auth` + `active-account.json`
//                       (Seviye 1 "bu cihazdan çıkış" eşdeğeri; ofis/ajan/hafıza KALIR)
//   · level:'full'    → `<instanceHome>` kökünün TAMAMI + userData'daki 4 JSON'umuz +
//                       güncelleyici önbelleği (+ loglar yalnız keepLogs:false ise)
//
// NEDEN böyle: tasarım docs/agent-results/RESET-R1-jazz.md §2b (manifest) + §2c
// (güvenlik zinciri) + §3 (bulut). Kök tehdit "rm -rf yolunda `..` ev dizinini
// sildirir" (hafıza writer-that-deletes-needs-stricter-key). Bu yüzden:
//   1. Modül DIŞARIDAN HEDEF YOLU ALMAZ — hedefi kendisi instancePaths.dirName()
//      + homedir'den türetir. Renderer'ın verebileceği tek şey `level` + `keepLogs`.
//   2. HER silme TEK BOĞAZDAN geçer: `guardedRemove` = `assertTarget` (realpath,
//      basename, parent === realpath(homedir), !== homedir, symlink reddi, `..`
//      reddi, prod-izolasyonu) ve hemen ardından `fs.rm`. Modülde `fs.rm(` sayısı
//      == `assertTarget(` çağrı sayısı == 1 (grep kapısı).
//   3. `plan()` = `execute({ dryRun:true })`: aynı assert zinciri KOŞAR ama rm
//      koşmaz → diyaloğa "ne silinecek / ne kalacak / kaç bayt" verilir.
//   4. Motor dizinleri (~/.claude, ~/.codex, ~/.gemini, ~/.config/goose…) ve
//      Chromium `Local State` manifestte YOKTUR → yapısal olarak dokunulmaz
//      (Windows DPAPI anahtarı yerinde kalır; ADP-943 giriş döngüsü riski yok).
//
// SAF + DI: Electron require YOK; `fs`, `homedir`, `userDataDir`, `logsDir`,
// `updaterCacheDir`, `log`, `now`, `isCustomerBuild` deps ile enjekte edilir →
// `node --test` tmp dizinde koşar (test:unit'in no-real-home-writes tripwire'ı
// gerçek ~/.crewpane* yazımını zaten THROW eder).
//
// BULUT (RESET-R1 §3, Eren kararı A varsayılır): silmeden ÖNCE çağıran (main.js,
// RESET-03) sırayla `seatGate.releaseDeviceLease()` → `seatGate.revokeDevice(ownId)`
// → `seatGate.signOut()` koşturur; hepsi best-effort ve sonucu `warnings`a girer.
// BU MODÜL FETCH YAPMAZ; karar B/C olursa yalnız çağıranın bir satırı değişir.
//
// SIR/PII: hiçbir dosya İÇERİĞİ okunmaz/loglanmaz; log yalnız tür + sayı + bayt.
// Yol adları `plan()` çıktısında vardır (main süreci tüketir) ama UI'a `keeps`
// ETİKETLERİ gider (i18n anahtarı), yol adı GİTMEZ (hafıza feedback_ui_copy_no_internals).

'use strict';

const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const instancePaths = require('../config/instancePaths.cjs');
const accountScope = require('../config/accountScope.cjs');
const buildChannel = require('../config/buildChannel.cjs');

const LEVELS = Object.freeze(['session', 'full']);
const MARKER_FILE = '.reset-pending.json';
const MARKER_MAX_AGE_MS = 10 * 60 * 1000; // 10 dk: daha eski işaretçi YOK SAYILIR + silinir
const MARKER_SCHEMA_VERSION = 1;
const INSTANCE_DIR_RE = /^\.crewpane(-dev|-test)?$/;
const PROD_DIR_NAME = '.crewpane';
const SIZE_BUDGET_MS = 2000; // bayt sayımı bu sürede bitmezse bytes:null ("hesaplanamadı")
const RM_OPTS = Object.freeze({ recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
/** fs.rm'nin "kilitli" saydığımız hata kodları (Windows EPERM/EBUSY, POSIX EACCES). */
const LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);

/**
 * TEK GERÇEK: neyin silineceği / neyin KALACAĞI. Diyalog `keeps` etiketlerini
 * buradan üretir (etiket = i18n anahtarı; yol adı UI'a gitmez).
 *
 *   where: 'instanceRoot' → kökün kendisi · 'instanceHome' → kökün altında `name`
 *          'userData' / 'updaterCache' / 'logs' → enjekte edilen dizin (+ `name`)
 *   optional: 'keepLogs' → execute({ keepLogs:true }) iken atlanır (varsayılan: sakla)
 *
 * Burada ADI GEÇMEYEN hiçbir şey silinmez (fail-closed).
 */
const TARGET_MANIFEST = Object.freeze({
  session: Object.freeze([
    Object.freeze({ kind: 'auth', where: 'instanceHome', name: 'auth' }),
    Object.freeze({ kind: 'activeAccount', where: 'instanceHome', name: accountScope.ACTIVE_ACCOUNT_FILE }),
  ]),
  full: Object.freeze([
    Object.freeze({ kind: 'instanceRoot', where: 'instanceRoot' }),
    Object.freeze({ kind: 'officeState', where: 'userData', name: 'office-state.json' }),
    Object.freeze({ kind: 'editorState', where: 'userData', name: 'editor-state.json' }),
    Object.freeze({ kind: 'editorGrantedRoots', where: 'userData', name: 'editor-granted-roots.json' }),
    Object.freeze({ kind: 'feedbackSeen', where: 'userData', name: 'feedback-seen.json' }),
    Object.freeze({ kind: 'updaterCache', where: 'updaterCache' }),
    Object.freeze({ kind: 'logs', where: 'logs', optional: 'keepLogs' }),
  ]),
  /** Diyalogda "Kalacak" listesi — i18n ANAHTARLARI (yol adı yok). */
  keeps: Object.freeze({
    session: Object.freeze([
      'keep.accounts',        // accounts/** (ofis, ajanlar, hafıza, ayarlar, kasa)
      'keep.device',          // device.json — aynı cihaz kimliği, hayalet cihaz yok
      'keep.engineCli',       // ~/.claude, ~/.codex, ~/.gemini, ~/.config/goose
      'keep.projects',        // kullanıcı proje klasörleri + worktree dizinleri
      'keep.cloudAccount',    // paket/abonelik/hesap sunucuda
    ]),
    full: Object.freeze([
      'keep.engineCli',
      'keep.userKeysEnv',     // ~/.crewpane/keys.env
      'keep.projectMemory',   // <proje>/.crewpane/memory
      'keep.projects',
      'keep.keychain',        // macOS Keychain "CrewPane Safe Storage" (ADP-592)
      'keep.chromiumLocalState', // userData/Local State — DPAPI anahtarı (ADP-943)
      'keep.application',     // uygulamanın kendisi
      'keep.cloudAccount',
    ]),
  }),
});

/** Kod damgalı hata (çağıran `code` ile ayırır; mesaj yol içermez → loglanabilir). */
function resetError(code, detail) {
  const e = new Error(`installReset: ${code}${detail ? ` (${detail})` : ''}`);
  e.code = code;
  return e;
}

function hasDotDotSegment(p) {
  return String(p).split(/[\\/]+/).includes('..');
}

/**
 * Dev/test dikişi: `homedir` deps'ten gelirse o (birim testi); yoksa CREWPANE_HOME
 * YALNIZ test instance'ında ve müşteri build'i DEĞİLKEN kabul; aksi halde yok say
 * + logla (değer loglanmaz). Sonra OS ev dizini.
 */
function resolveHomedir(deps) {
  if (typeof deps.homedir === 'string' && deps.homedir) return deps.homedir;
  const env = process.env.CREWPANE_HOME;
  if (!env) return os.homedir();
  const customer = typeof deps.isCustomerBuild === 'function'
    ? deps.isCustomerBuild()
    : buildChannel.isCustomerBuild();
  const id = instancePaths.instanceId();
  if (!customer && id === instancePaths.TEST) return env;
  deps.log(`installReset: CREWPANE_HOME yok sayıldı (instance=${id}, customerBuild=${customer ? 1 : 0})`);
  return os.homedir();
}

/**
 * ⚠️ TEK BOĞAZ — her `fs.rm` bundan geçer. İki mod:
 *   { homedir, dirName }  → instance KÖKÜ (`~/.crewpane[-dev|-test]`)
 *   { parent, name }      → bir dizinin hemen altındaki tek giriş (userData JSON'ları,
 *                           güncelleyici önbelleği, session hedefleri, işaretçi)
 * Zincir: `..` reddi → lstat (symlink → RESET_TARGET_SYMLINK; yok → RESET_TARGET_MISSING)
 * → realpath → basename → dirname === realpath(parent|homedir) → !== homedir →
 * prod dışı instance'ta rootsAreIsolated(hedef, ~/.crewpane). İhlal → RESET_TARGET_UNSAFE.
 * Döner: gerçek (realpath) yol.
 */
function assertTarget(abs, spec, fs = nodeFs) {
  if (typeof abs !== 'string' || !abs || !path.isAbsolute(abs)) throw resetError('RESET_TARGET_UNSAFE', 'not-absolute');
  if (hasDotDotSegment(abs)) throw resetError('RESET_TARGET_UNSAFE', 'dotdot');
  const s = spec || {};
  const rootMode = typeof s.homedir === 'string' && typeof s.dirName === 'string';
  const childMode = typeof s.parent === 'string' && typeof s.name === 'string';
  if (rootMode === childMode) throw resetError('RESET_TARGET_UNSAFE', 'spec');

  let st;
  try { st = fs.lstatSync(abs); } catch (e) {
    if (e && e.code === 'ENOENT') throw resetError('RESET_TARGET_MISSING');
    throw resetError('RESET_TARGET_UNSAFE', `lstat:${(e && e.code) || 'ERR'}`);
  }
  if (st.isSymbolicLink()) throw resetError('RESET_TARGET_SYMLINK');

  let real;
  try { real = fs.realpathSync(abs); } catch (e) { throw resetError('RESET_TARGET_UNSAFE', `realpath:${(e && e.code) || 'ERR'}`); }
  const base = path.basename(real);

  if (rootMode) {
    let realHome;
    try { realHome = fs.realpathSync(s.homedir); } catch { throw resetError('RESET_TARGET_UNSAFE', 'homedir'); }
    if (!INSTANCE_DIR_RE.test(base)) throw resetError('RESET_TARGET_UNSAFE', 'basename');
    if (base !== s.dirName) throw resetError('RESET_TARGET_UNSAFE', 'dirname-mismatch');
    // `parent` kapısı "hedef == ev dizini" durumunu da KAPSAR: bir dizin kendi
    // ebeveyni olamaz (yalnız `/` öyledir, onu da basename kapısı düşürür).
    // Ölçüldü (kontrol kolu): ayrı bir is-homedir satırı sökülünce hiçbir test
    // kırmızıya dönmüyordu → ölü kapı, taşınmıyor. childMode'daki eşi GERÇEK:
    // orada `parent` dışarıdan gelir ve ev dizinini meşru gösterebilir.
    if (path.dirname(real) !== realHome) throw resetError('RESET_TARGET_UNSAFE', 'parent');
    if (!st.isDirectory()) throw resetError('RESET_TARGET_UNSAFE', 'not-dir');
    // Dev/test kopya prod'u silmesin: ad zaten farklı ama kapı AÇIKÇA ölçülür.
    if (s.dirName !== PROD_DIR_NAME && !accountScope.rootsAreIsolated(real, path.join(realHome, PROD_DIR_NAME))) {
      throw resetError('RESET_TARGET_UNSAFE', 'prod-overlap');
    }
    return real;
  }

  // childMode
  if (hasDotDotSegment(s.name) || s.name.includes('/') || s.name.includes('\\') || !s.name) throw resetError('RESET_TARGET_UNSAFE', 'name');
  if (base !== s.name || path.basename(abs) !== s.name) throw resetError('RESET_TARGET_UNSAFE', 'basename');
  let realParent;
  try { realParent = fs.realpathSync(s.parent); } catch { throw resetError('RESET_TARGET_UNSAFE', 'parent-missing'); }
  if (path.dirname(real) !== realParent) throw resetError('RESET_TARGET_UNSAFE', 'parent');
  if (typeof s.homedir === 'string') {
    let realHome = null;
    try { realHome = fs.realpathSync(s.homedir); } catch { /* ölçülemedi → aşağıdaki eşitlik zaten düşer */ }
    if (realHome && real === realHome) throw resetError('RESET_TARGET_UNSAFE', 'is-homedir');
  }
  return real;
}

/** Bayt + giriş sayımı; symlink TAKİP EDİLMEZ; `deadline` aşılırsa bytes:null. */
function sizeOf(abs, fs, deadline) {
  let bytes = 0;
  let entries = 0;
  let timedOut = false;
  const stack = [abs];
  while (stack.length) {
    if (Date.now() > deadline) { timedOut = true; break; }
    const cur = stack.pop();
    let st;
    try { st = fs.lstatSync(cur); } catch { continue; }
    entries += 1;
    if (st.isDirectory()) {
      let names = [];
      try { names = fs.readdirSync(cur); } catch { /* okunamayan dizin: sayıma girmez */ }
      for (const n of names) stack.push(path.join(cur, n));
    } else {
      bytes += Number(st.size) || 0;
    }
  }
  return { bytes: timedOut ? null : bytes, entries, timedOut };
}

/** Manifest satırını mutlak yol + assert spec'ine çevirir (yol yoksa null → atlanır). */
function materialize(entry, ctx) {
  const { homedir, dirName, instanceHome } = ctx;
  switch (entry.where) {
    case 'instanceRoot':
      return { abs: instanceHome, spec: { homedir, dirName } };
    case 'instanceHome':
      return { abs: path.join(instanceHome, entry.name), spec: { parent: instanceHome, name: entry.name, homedir } };
    case 'userData':
      if (!ctx.userDataDir) return null;
      return { abs: path.join(ctx.userDataDir, entry.name), spec: { parent: ctx.userDataDir, name: entry.name, homedir } };
    case 'updaterCache':
      if (!ctx.updaterCacheDir) return null;
      return { abs: ctx.updaterCacheDir, spec: { parent: path.dirname(ctx.updaterCacheDir), name: path.basename(ctx.updaterCacheDir), homedir } };
    case 'logs':
      if (!ctx.logsDir) return null;
      return { abs: ctx.logsDir, spec: { parent: path.dirname(ctx.logsDir), name: path.basename(ctx.logsDir), homedir } };
    default:
      return null;
  }
}

function normalizeDeps(deps) {
  const d = deps || {};
  const log = typeof d.log === 'function' ? d.log : () => {};
  const out = {
    fs: d.fs || nodeFs,
    log,
    now: typeof d.now === 'function' ? d.now : Date.now,
    isCustomerBuild: d.isCustomerBuild,
    userDataDir: typeof d.userDataDir === 'string' && d.userDataDir ? d.userDataDir : null,
    logsDir: typeof d.logsDir === 'string' && d.logsDir ? d.logsDir : null,
    updaterCacheDir: typeof d.updaterCacheDir === 'string' && d.updaterCacheDir ? d.updaterCacheDir : null,
    homedir: d.homedir,
  };
  out.homedir = resolveHomedir({ ...out, homedir: d.homedir });
  out.dirName = instancePaths.dirName();
  out.instanceHome = path.join(out.homedir, out.dirName);
  return out;
}

/**
 * Tek silme boğazı: assert → (dryRun değilse) fs.rm. Sonuç:
 *   { status:'removed'|'planned'|'missing'|'unsafe'|'locked', code? }
 * Hiçbir durumda throw etmez (çağıran toplar); assert ihlali `unsafe` olarak döner
 * ve rm KOŞMAZ.
 */
async function guardedRemove(abs, spec, ctx, dryRun) {
  const fs = ctx.fs;
  let real;
  try {
    real = assertTarget(abs, spec, fs);
  } catch (e) {
    if (e && e.code === 'RESET_TARGET_MISSING') return { status: 'missing' };
    return { status: 'unsafe', code: (e && e.code) || 'RESET_TARGET_UNSAFE' };
  }
  if (dryRun) return { status: 'planned', real };
  try {
    await new Promise((resolve, reject) => fs.rm(real, RM_OPTS, (err) => (err ? reject(err) : resolve())));
    return { status: 'removed', real };
  } catch (e) {
    const code = (e && e.code) || 'ERR';
    return { status: 'locked', code: LOCK_CODES.has(code) ? code : `ERR:${code}` };
  }
}

function assertLevel(level) {
  if (!LEVELS.includes(level)) throw resetError('RESET_LEVEL_INVALID');
  return level;
}

/**
 * execute({ level, keepLogs?, dryRun?, ...deps }) →
 *   { ok, level, dryRun, removed:[{kind,bytes,entries}], locked:[{kind,code}],
 *     skipped:[{kind,reason}], warnings:[string], durationMs }
 * Kilit (EBUSY/EPERM…) → `locked` + ok:false, THROW YOK. Assert ihlali → `skipped`
 * reason:'unsafe:<code>' + warnings + ok:false (rm koşmadı).
 */
async function execute(opts) {
  const o = opts || {};
  const level = assertLevel(o.level);
  const ctx = normalizeDeps(o);
  const dryRun = o.dryRun === true || process.env.CREWPANE_RESET_DRY_RUN === '1';
  const keepLogs = o.keepLogs !== false; // varsayılan: günlükleri SAKLA (destek için)
  const t0 = Date.now();
  const deadline = t0 + SIZE_BUDGET_MS;
  const removed = [];
  const locked = [];
  const skipped = [];
  const warnings = [];
  if (dryRun && process.env.CREWPANE_RESET_DRY_RUN === '1' && o.dryRun !== true) warnings.push('dry_run_env');

  for (const entry of TARGET_MANIFEST[level]) {
    if (entry.optional === 'keepLogs' && keepLogs) { skipped.push({ kind: entry.kind, reason: 'keepLogs' }); continue; }
    const m = materialize(entry, ctx);
    if (!m) { skipped.push({ kind: entry.kind, reason: 'no-dir' }); continue; }
    // Boyut, silmeden ÖNCE ölçülür (sonra ölçecek bir şey kalmaz). Yok/erişilemezse 0.
    let size = { bytes: 0, entries: 0, timedOut: false };
    try { if (ctx.fs.lstatSync(m.abs)) size = sizeOf(m.abs, ctx.fs, deadline); } catch { /* yok → 0 */ }
    if (size.timedOut) warnings.push(`bytes_uncomputed:${entry.kind}`);
    const r = await guardedRemove(m.abs, m.spec, ctx, dryRun);
    if (r.status === 'removed' || r.status === 'planned') {
      removed.push({ kind: entry.kind, bytes: size.bytes, entries: size.entries });
    } else if (r.status === 'missing') {
      skipped.push({ kind: entry.kind, reason: 'missing' });
    } else if (r.status === 'unsafe') {
      skipped.push({ kind: entry.kind, reason: `unsafe:${r.code}` });
      warnings.push(`unsafe:${entry.kind}:${r.code}`);
    } else {
      locked.push({ kind: entry.kind, code: r.code });
    }
  }
  const ok = locked.length === 0 && !warnings.some((w) => w.startsWith('unsafe:'));
  const durationMs = Date.now() - t0;
  ctx.log(`installReset: ${dryRun ? 'plan' : 'execute'} level=${level} removed=${removed.length} locked=${locked.length} skipped=${skipped.length} ok=${ok ? 1 : 0} ${durationMs}ms`);
  return { ok, level, dryRun, removed, locked, skipped, warnings, durationMs };
}

/**
 * plan({ level, keepLogs?, ...deps }) → KURU KOŞUM: hiçbir şey silmez.
 *   { level, targets:[{kind,path,bytes,entries}], keeps:[{label}], bytesTotal, warnings }
 * `bytes:null` → 2 sn'de hesaplanamadı (büyük backups/); `bytesTotal` null'ları atlar.
 * `warnings` 'server_record_app_installs' taşır: telemetri açıksa sunucudaki
 * `app_installs` satırı (install_id) sıfırlamayla SİLİNMEZ, yeni installId yeni satır açar.
 */
async function plan(opts) {
  const o = opts || {};
  const level = assertLevel(o.level);
  const ctx = normalizeDeps(o);
  const res = await execute({ ...o, dryRun: true });
  const keepLogs = o.keepLogs !== false;
  const targets = [];
  for (const entry of TARGET_MANIFEST[level]) {
    const hit = res.removed.find((r) => r.kind === entry.kind);
    if (!hit) continue;
    const m = materialize(entry, ctx);
    targets.push({ kind: entry.kind, path: m ? m.abs : null, bytes: hit.bytes, entries: hit.entries });
  }
  const keeps = TARGET_MANIFEST.keeps[level].map((label) => ({ label }));
  if (level === 'full' && keepLogs) keeps.push({ label: 'keep.logs' });
  const bytesTotal = targets.reduce((s, t) => s + (typeof t.bytes === 'number' ? t.bytes : 0), 0);
  const warnings = res.warnings.filter((w) => w !== 'dry_run_env');
  if (level === 'full') warnings.push('server_record_app_installs');
  for (const s of res.skipped) if (s.reason.startsWith('unsafe:')) warnings.push(`unsafe:${s.kind}`);
  return { level, targets, keeps, bytesTotal, warnings };
}

// ── İşaretçi (.reset-pending.json) — "bir sonraki açılışta sil" sözleşmesi ───────
// Çalışırken silme YOK (Windows kilidi); main.js işaretçiyi yazar, relaunch eder,
// yeni süreç hiçbir modül dosya açmadan ÖNCE okur ve execute'u koşturur.
// 0o600, `requestedAt`; 10 dk'dan eski işaretçi yok sayılır + silinir (sahtecilik/bayat).
// `nonce` çağıranındır (RESET-03: bridge token ile HMAC) — burada yalnız taşınır.

function markerPath(instanceHome) {
  if (typeof instanceHome !== 'string' || !instanceHome || hasDotDotSegment(instanceHome)) throw resetError('RESET_TARGET_UNSAFE', 'instanceHome');
  return path.join(instanceHome, MARKER_FILE);
}

function writeMarker(instanceHome, fields, deps) {
  const d = deps || {};
  const fs = d.fs || nodeFs;
  const now = typeof d.now === 'function' ? d.now : Date.now;
  const f = fields || {};
  const level = assertLevel(f.level);
  const file = markerPath(instanceHome);
  const body = {
    schemaVersion: MARKER_SCHEMA_VERSION,
    requestedAt: new Date(now()).toISOString(),
    level,
    keepLogs: f.keepLogs !== false,
    nonce: typeof f.nonce === 'string' ? f.nonce : null,
  };
  fs.mkdirSync(instanceHome, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* Windows: mode yok */ }
  fs.renameSync(tmp, file);
  return body;
}

/** Geçerli işaretçi → { level, keepLogs, nonce, requestedAt, ageMs }; yoksa/bayat/bozuk → null. */
async function readMarker(instanceHome, deps) {
  const d = deps || {};
  const fs = d.fs || nodeFs;
  const now = typeof d.now === 'function' ? d.now : Date.now;
  const log = typeof d.log === 'function' ? d.log : () => {};
  const file = markerPath(instanceHome);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  const requestedAt = parsed && typeof parsed.requestedAt === 'string' ? Date.parse(parsed.requestedAt) : NaN;
  const ageMs = Number.isFinite(requestedAt) ? now() - requestedAt : NaN;
  const valid = parsed && LEVELS.includes(parsed.level) && Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= MARKER_MAX_AGE_MS;
  if (!valid) {
    log(`installReset: işaretçi yok sayıldı (${Number.isFinite(ageMs) ? `age=${Math.round(ageMs / 1000)}s` : 'bozuk'})`);
    await clearMarker(instanceHome, d);
    return null;
  }
  return {
    level: parsed.level,
    keepLogs: parsed.keepLogs !== false,
    nonce: typeof parsed.nonce === 'string' ? parsed.nonce : null,
    requestedAt: parsed.requestedAt,
    ageMs,
  };
}

/** İşaretçiyi siler (tek boğazdan). Yoksa da ok:true. */
async function clearMarker(instanceHome, deps) {
  const d = deps || {};
  const ctx = { fs: d.fs || nodeFs };
  const file = markerPath(instanceHome);
  const r = await guardedRemove(file, { parent: instanceHome, name: MARKER_FILE }, ctx, false);
  return { ok: r.status === 'removed' || r.status === 'missing', status: r.status, code: r.code };
}

module.exports = {
  LEVELS,
  MARKER_FILE,
  MARKER_MAX_AGE_MS,
  TARGET_MANIFEST,
  assertTarget,
  plan,
  execute,
  writeMarker,
  readMarker,
  clearMarker,
  // test/teşhis dikişleri
  _internal: Object.freeze({ resolveHomedir, sizeOf, materialize, normalizeDeps, INSTANCE_DIR_RE, SIZE_BUDGET_MS }),
};
