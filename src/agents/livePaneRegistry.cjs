// CrewPane — ADP-192 (SPRINT-AD-23) live-pane registry for restart-resume.
//
// WHY: an CrewPane agent pane is a node-pty CHILD of the Electron app. When the
// app restarts (a .dmg update, or quit→reopen) every child dies → the running
// claude/codex conversations are SEVERED. The work itself is durable (files,
// commits, the task board), but the agent's in-flight CONVERSATION context is
// lost and the operator must re-launch every worker by hand. Eren: "ajanlar
// neredeyse tüm gün çalışıyor; güncelleme onları böler — kaldığı yerden devam".
//
// This registry is the persistent bridge across that restart. spawnPty records
// every AGENT pane here (with the minted claude --session-id, ADP-087); on the
// next launch main.js reads it and re-spawns each pane with `claude --resume
// <session-id>` (ADP-088 reuse) so the agent continues the SAME conversation.
//
// It is the sibling of resumePaneRegistry.cjs (ADP-089, the LIMIT-resume tmux
// map). Different subsystem, same disciplines:
//   • File: ~/.crewpane/live-panes.json (shared dir, ADR-004).
//   • PURE-ish: every fn takes an optional `homedir` so it is unit-testable on a
//     tmp dir (and main.js can honor an CREWPANE_HOME test seam).
//   • Reads never throw (missing / corrupt / wrong-shape → empty map).
//   • Writes are atomic (tmp + rename) so a mid-write crash can't truncate it.
//
// An entry stores exactly the spawn shape needed to RE-spawn the pane (resume OR,
// when the session can't be resumed, a clean identityful fallback — ADP-192 DoD):
//   { agentId, department, cwd, engine:'claude'|'codex'|null, sessionId, label, role,
//     plain, browserCapable, disallowSubagent, systemPrompt, startedAt, updatedAt }
// ENG-05 — `engine` NULL OLABİLİR: tanınmayan bir motor artık claude'a düşürülmez
// (bkz. normalize + engineCoerce.cjs). Böyle bir kayıt restore edilmez (spawn komut
// beyaz listesinden geçemez) ve restore döngüsü bunu LOG'a yazar — sessiz yanlış
// motorla açmaktansa açmamak doğrudur.
//
// Lifecycle (main.js): recordPane at spawn; removePane when a pane is CLOSED on
// purpose (user kill, or the agent exits by itself); but panes still alive when
// the app is TEARING DOWN are deliberately KEPT (those are the running agents we
// restore next launch). restoreSnapshot()+clearAll() consume it at launch.

'use strict';

const os = require('node:os');
const fs = require('node:fs');
// ADP-835 (790 K1) — atomik yazımın rename adımı platform boğazından geçer:
// Windows'ta Defender/Search hedefi açık tutunca EPERM/EBUSY gelir ve bu çağrıların
// çoğu best-effort catch içinde OLDUĞU İÇİN kayıt SESSİZCE kaybolurdu.
// ADP-946 — defter/snapshot yazımı artık ELDE ÖRÜLMÜŞ tmp+rename değil, boğazın
// KENDİSİ (`atomicWriteFileSync`): kalıcı düşüşte `.tmp` artığı temizlenir ve
// win32'de son çare yerinde-yazım denenir. Ölçüldü (ADP-946): elde örülmüş yol
// kalıcı EPERM'de veri kökünde her yazım başına bir `.tmp` bırakıyordu.
const { renameWithRetrySync, atomicWriteFileSync } = require('../../platform/atomicWrite.cjs');
// ADP-835 (790 P5) — canlılık probunun tek boğazı.
const procProbe = require('../../platform/procProbe.cjs');
const path = require('node:path');
// ADP-946 — `crypto` KALDIRILDI: tmp adı üretimi artık `atomicWriteFileSync`in içinde.
const instancePaths = require('../config/instancePaths.cjs'); // ADP-206 — instance-scoped config dir
const accountScope = require('../config/accountScope.cjs');   // ADP-734 — çok-kök keşif için hesap kökleri
const journal = require('../terminal/paneSessionsJournal.cjs'); // ADP-734 Kapı 3 — silinmeyen oturum defteri
const engineCoerce = require('./engineCoerce.cjs'); // ENG-05 — kalıcı veriye yazılacak motor değerinin kapısı
const systemPromptCap = require('../../platform/systemPromptCap.cjs'); // AD-WIN-02 — kimlik tavanının TEK kaynağı
const paneCapabilityMatrix = require('../terminal/paneCapabilityMatrix.cjs'); // ENG-10 — kullanıcı-yüzü yetenek alanlarının TEK listesi

const REGISTRY_VERSION = 1;

/**
 * Per-instance config dir (ADP-206): PROD ~/.crewpane, DEV ~/.crewpane-dev. Routed
 * through instancePaths so a DEV launch reads/writes its OWN live-panes.json and
 * never restores or clobbers PROD's running panes. `homedir` seam preserved (unit
 * tests pass a tmp dir; env unset → 'prod' → legacy '.crewpane').
 */
function crewpaneDir(homedir) {
  return instancePaths.crewpaneHome(homedir);
}

/** Absolute path of the live-pane registry JSON. */
function registryPath(homedir) {
  return path.join(crewpaneDir(homedir), 'live-panes.json');
}

/** TASK-MRDXOGZJDQLJG — absolute path of the write-ahead quit snapshot. */
function snapshotPath(homedir) {
  return path.join(crewpaneDir(homedir), 'live-panes.quit-snapshot.json');
}

// A fallback snapshot older than this is STALE — restoring it would resurrect panes
// from some long-past run instead of the shutdown that just happened. The legit
// wipe scenarios (self-update, quit-races) relaunch within seconds/minutes.
const SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1000;

function emptyRegistry() {
  return { version: REGISTRY_VERSION, panes: {} };
}

/** Load the registry. Missing / corrupt / wrong-shape → empty (never throws). */
function loadRegistry(homedir) {
  try {
    const raw = fs.readFileSync(registryPath(homedir), 'utf8');
    const r = JSON.parse(raw);
    if (!r || typeof r !== 'object' || !r.panes || typeof r.panes !== 'object') {
      return emptyRegistry();
    }
    return { version: REGISTRY_VERSION, panes: r.panes };
  } catch {
    return emptyRegistry();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ADP-734 Kapı 2 — DEFTER KÜÇÜLME NÖBETİ (yedekle + logla + geri yüklemeyi teklif et)
// ═══════════════════════════════════════════════════════════════════════════
// Defter bir CANLI KÜMEdir: meşru olarak küçülür (bir pane kapandı) ve meşru olarak
// boşalır (teardown, launch-consume). Ama TAM DA bu yüzden "7 pane → 0" yazımı
// hiçbir yerde iz bırakmadan gerçekleşebiliyordu. Bu nöbet, kaybı ÖNLEMEYE çalışmaz
// (yazım meşru olabilir) — kaybı GERİ ALINABİLİR ve GÖRÜNÜR yapar:
//   • yedek: <root>/backups/live-panes.<ISO>.json (son MAX_SHRINK_BACKUPS tanesi)
//   • log + gözlemci: main bunu log'a basar ve "N pane kurtarılabilir" teklifini yollar
// Tek pane'lik düşüş (normal kapatma) sessiz geçer — gürültü, nöbeti işe yaramaz kılar.

const SHRINK_BACKUP_DIR = 'backups';
const MAX_SHRINK_BACKUPS = 10;

/** Kaç pane'lik ANİ düşüş "beklenenden az" sayılır (tek kapatma normaldir). */
const SHRINK_DROP_THRESHOLD = 2;

let shrinkObserver = null;

/**
 * main.js buraya "logla + kullanıcıya teklif et" davranışını takar. Saf modül
 * IPC bilmez; gözlemci dikişi testte de gerçek çağrıyı ölçmeyi sağlar.
 * @param {null|((info:{prev:number,next:number,reason:string,backup:string|null,panes:object})=>void)} fn
 */
function setShrinkObserver(fn) {
  shrinkObserver = typeof fn === 'function' ? fn : null;
}

function backupsDir(homedir) {
  return path.join(crewpaneDir(homedir), SHRINK_BACKUP_DIR);
}

/** Eski yedekleri buda — teşhis dosyası diski doldurmamalı. */
function pruneBackups(dir) {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((n) => n.startsWith('live-panes.') && n.endsWith('.json'))
      .sort();
    for (const name of files.slice(0, Math.max(0, files.length - MAX_SHRINK_BACKUPS))) {
      try { fs.unlinkSync(path.join(dir, name)); } catch { /* best-effort */ }
    }
  } catch { /* best-effort */ }
}

/** Küçülmeden ÖNCEKİ defteri zaman damgalı dosyaya yaz. Yol veya null döner. */
function backupPanes(panes, homedir, now) {
  const dir = backupsDir(homedir);
  const stamp = new Date(Number.isFinite(now) ? now : Date.now())
    .toISOString()
    .replace(/[:.]/g, '-');
  const file = path.join(dir, `live-panes.${stamp}.json`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: REGISTRY_VERSION, backedUpAt: now || Date.now(), panes }, null, 2));
    pruneBackups(dir);
    return file;
  } catch {
    return null; // yedek alınamadıysa bile yazımı BLOKLAMA (loglanır)
  }
}

/**
 * Yazımdan ÖNCE çağrılır. Defter beklenenden AZ pane ile yazılacaksa yedekler ve
 * gözlemciyi uyarır. `reason:'consume'` (launch'ta clearAll) yedek almaz — o yolun
 * kendi write-ahead snapshot'ı zaten var — ama yine de RAPOR EDİLİR.
 */
function guardShrink(prevPanes, nextPanes, homedir, opts = {}) {
  const prev = Object.keys(prevPanes || {}).length;
  const next = Object.keys(nextPanes || {}).length;
  if (!prev || next >= prev) return null;
  const emptying = next === 0;
  if (!emptying && prev - next < SHRINK_DROP_THRESHOLD) return null;
  const reason = typeof opts.reason === 'string' && opts.reason ? opts.reason : 'write';
  const backup = reason === 'consume' ? null : backupPanes(prevPanes, homedir, opts.now);
  const info = { prev, next, reason, backup, panes: prevPanes };
  if (shrinkObserver) {
    try { shrinkObserver(info); } catch { /* gözlemci hatası yazımı bozmaz */ }
  }
  return info;
}

/** Atomically persist (tmp+rename). Creates ~/.crewpane if needed. Returns path. */
function persist(reg, homedir, opts = {}) {
  const dir = crewpaneDir(homedir);
  // ADP-734 Kapı 2 — küçülme nöbeti: diskteki HÂLİ oku, yazılacakla kıyasla.
  if (opts.guard !== false) {
    try { guardShrink(loadRegistry(homedir).panes, reg.panes || {}, homedir, opts); } catch { /* nöbet yazımı bloklamaz */ }
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = registryPath(homedir);
  atomicWriteFileSync(
    file,
    JSON.stringify({ version: REGISTRY_VERSION, panes: reg.panes || {} }, null, 2),
    { inPlaceFallback: true }, // ADP-946
  );
  return file;
}

// Bound the persisted system prompt the same way agentRunner caps it on spawn, so
// a crafted/runaway identity can't bloat the on-disk registry either.
//
// AD-WIN-02 — BU SAYI ARTIK ELLE KOPYALANMIYOR. Eskiden burada ikinci bir `8000`
// duruyordu; agentRunner'daki tavan yükseltilse bu kopya kesmeye DEVAM ederdi
// (restore edilen pane, ilk spawn'ından FARKLI — kesik — bir kimlikle geri gelirdi).
// Kayıt defteri bir komut satırı değildir: buradaki sınır yalnız disk şişmesine
// karşıdır, o yüzden en geniş tavanı (STORAGE_MAX = dosya dalı) kullanır.
const MAX_SYSTEM_PROMPT_LEN = systemPromptCap.STORAGE_MAX;

// ADP-386 — teardown'da saklanan VT ekran kuyruğu (pane'in son görünür satırları).
// restore, yeni pty'nin replay buffer'ını bununla tohumlar: engine (`claude --resume`)
// ilk baytı basana kadar pane SİMSİYAH kalıyordu (ölçüldü: pty:attach bufLen=0).
// Sınırlar disk şişmesini keser (pane başına ≤ ~20 KB).
const MAX_SCREEN_TAIL_LINES = 40;
const MAX_SCREEN_TAIL_CHARS = 500;

// ENG-07 — motorun beyan edilmiş eksik/kısmi yetenekleri (rozet girdisi). Defter bir
// log değil: madde sayısı yetenek alanı sayısıyla, gerekçe uzunluğu ipucu boyuyla sınırlı.
const MAX_CAPABILITY_ITEMS = 32;
const MAX_CAPABILITY_REASON_CHARS = 400;

/** ADP-386 — screenTail'i kanonik, sınırlı şekle indir (dizi değilse null). */
function normalizeScreenTail(tail) {
  if (!Array.isArray(tail)) return null;
  const lines = tail
    .filter((s) => typeof s === 'string')
    .slice(-MAX_SCREEN_TAIL_LINES)
    .map((s) => (s.length > MAX_SCREEN_TAIL_CHARS ? `${s.slice(0, MAX_SCREEN_TAIL_CHARS - 1)}…` : s));
  return lines.length ? lines : null;
}

/** Coerce a recorded pane info into the canonical, bounded, serialisable shape. */
function normalize(info, now) {
  const i = info && typeof info === 'object' ? info : {};
  const sp = typeof i.systemPrompt === 'string' ? i.systemPrompt : null;
  return {
    agentId: typeof i.agentId === 'string' ? i.agentId : null,
    // PANE-RESTORE-DUP-01 — PANE'İN KALICI KİMLİĞİ. `paneId` (pane-1, pane-2…) her
    // açılışta SIFIRDAN sayılır, yani bir kaydın ANAHTARI değil o turdaki KOLTUK
    // NUMARASIDIR: restore edilen pane kendini YENİ bir paneId altına yazınca aynı
    // pane defterde İKİNCİ bir satır oluyordu. `agentId` bu boşluğu yalnız AJANLI
    // pane'ler için dolduruyordu; ÇIPLAK motor pane'inde (agentId=null) hiçbir kimlik
    // yoktu → 3 pane 4 açılışta 24 oldu (ölçüldü: e2e-BEFORE-fix.txt).
    // `restoreKey` ilk kayıtta basılır ve restore boyunca TAŞINIR (main.js
    // respawnOptsFromEntry → spawnPty → recordPane), yani pane hangi koltuğa
    // otursun otursun aynı satırı günceller. Eski kayıtlarda null → `identityKey`
    // türetilmiş anahtara düşer (aşağıya bak).
    restoreKey: typeof i.restoreKey === 'string' && i.restoreKey ? i.restoreKey : null,
    department: typeof i.department === 'string' ? i.department : null,
    cwd: typeof i.cwd === 'string' ? i.cwd : null,
    // ENG-05 — TANINMAYAN MOTOR ARTIK `claude` DEĞİL, `null`. Eski satır
    // (`i.engine === 'codex' ? 'codex' : 'claude'`) bir varsayılan gibi görünüyordu
    // ama veri UYDURUYORDU: üçüncü motor eklendiği gün her kaydı claude yapardı ve
    // jeton ölçümü/resume/rozet sessizce yanlış motora bakardı (ENG-R3 §11.1, R2).
    // `null` = "motor bilinmiyor" — tüketicilerdeki mevcut dürüst yol (tokenUsage
    // `engine-not-measurable`, integrationStatus `toolsLive=false`).
    engine: engineCoerce.coerceEngine(i.engine, {
      where: 'livePaneRegistry.normalize',
      agentId: typeof i.agentId === 'string' ? i.agentId : null,
    }),
    sessionId: typeof i.sessionId === 'string' ? i.sessionId : null,
    // ADP-565/595 — the pane's per-launch MODEL + codex custom PROVIDER. Both are
    // per-launch flags (`--model`, `-c model_provider=…`), NOT conversation state, so a
    // restart-resume must re-pass them or the pane silently comes back on the engine's
    // default model/provider. main.js recorded them before, but normalize() dropped
    // unknown keys → they never survived the snapshot (that is what is fixed here).
    // null = engine default (today's behavior for every legacy record).
    model: typeof i.model === 'string' && i.model ? i.model : null,
    provider: typeof i.provider === 'string' && i.provider ? i.provider : null,
    label: typeof i.label === 'string' ? i.label : null,
    role: typeof i.role === 'string' ? i.role : null,
    plain: i.plain === true,
    browserCapable: i.browserCapable === true,
    disallowSubagent: i.disallowSubagent === true,
    systemPrompt: sp && sp.length > MAX_SYSTEM_PROMPT_LEN ? sp.slice(0, MAX_SYSTEM_PROMPT_LEN) : sp,
    // ADP-386 — teardown'da yakalanan ekran kuyruğu; restore bunu yeni pane'in
    // replay buffer'ına tohumlar (siyah-pencere fix'i). Yoksa null (eski kayıtlar).
    screenTail: normalizeScreenTail(i.screenTail),
    startedAt: Number.isFinite(i.startedAt) ? i.startedAt : Number.isFinite(now) ? now : Date.now(),
    updatedAt: Number.isFinite(now) ? now : Date.now(),
    // B-01 (GIT-BACKBONE-SPEC §2.5, H-2) — GÖREV ↔ BRANCH ↔ İZOLE AĞAÇ BAĞI.
    // Bu üç alan olmadan restart-resume izolasyonu KAYBEDER: pane geri gelir ama
    // `cwd` alanı ortak ağacı gösterirse ajan yarım işini bir daha bulamaz ve —
    // daha kötüsü — paylaşımlı ağaçta koşmaya devam eder (sessiz yarım-izolasyon).
    // `cwd` zaten worktree yolunu taşır; `worktreePath` onun AMACINI kaydeder
    // (restore, yol hâlâ geçerli mi diye defterden doğrulayabilsin) ve `taskId`/
    // `branch` pane başlığındaki rozetlerin TEK KAYNAĞI olur (§2.10: rozet artık
    // cwd'nin HEAD'ini tahmin etmez, görev kaydını okur).
    // Legacy kayıtlarda üçü de null → bugünkü davranış birebir.
    taskId: typeof i.taskId === 'string' && i.taskId ? i.taskId : null,
    branch: typeof i.branch === 'string' && i.branch ? i.branch : null,
    worktreePath: typeof i.worktreePath === 'string' && i.worktreePath ? i.worktreePath : null,
    // ADP-269 — which CrewPane process owns this pane. `restoreSnapshot` refuses to resume a
    // pane whose owner is STILL RUNNING, so a second instance (an e2e/test app launched while
    // prod is open) can never re-attach `claude --resume <sessionId>` to a conversation the
    // live instance is actively writing. Recorded here, not by the caller, so every write path
    // stamps it. `null` on legacy records → treated as unowned (resumable), as before.
    ownerPid: Number.isFinite(i.ownerPid) ? i.ownerPid : process.pid,
    // ENG-07 (ENG-R3 §2.3) — motorun BEYAN EDİLMİŞ eksik/kısmi yetenekleri. Kaynak
    // `engineRegistry` descriptor'ı (buildSpawn üretir) → kayıt bir İDDİA değil, argv
    // hunisinin okuduğu AYNI verinin aynası. Eski kayıtlarda `null` (bugünkü davranış).
    capabilities: normalizeCapabilities(i.capabilities),
  };
}

/**
 * ENG-07 — yetenek beyanını sınırlandırılmış, serileştirilebilir hâle getir.
 * Gerekçe metinleri kullanıcıya gösterilecek (rozet ipucu) ama defter bir LOG değil:
 * madde sayısı + gerekçe uzunluğu kapaklı, tanınmayan alanlar DÜŞER.
 */
function normalizeCapabilities(value) {
  if (!value || typeof value !== 'object') return null;
  const list = Array.isArray(value.unsupported) ? value.unsupported : [];
  const items = list
    .filter((i) => i && typeof i.capability === 'string')
    .slice(0, MAX_CAPABILITY_ITEMS)
    .map((i) => ({
      capability: i.capability,
      state: i.state === 'partial' ? 'partial' : 'missing',
      reason:
        typeof i.reason === 'string'
          ? i.reason.length > MAX_CAPABILITY_REASON_CHARS
            ? `${i.reason.slice(0, MAX_CAPABILITY_REASON_CHARS - 1)}…`
            : i.reason
          : null,
      severity: i.severity === 'security' ? 'security' : 'info',
    }));
  return {
    engine: typeof value.engine === 'string' && value.engine ? value.engine : null,
    unsupported: items,
    summary: typeof value.summary === 'string' ? value.summary.slice(0, MAX_CAPABILITY_REASON_CHARS) : '',
    // ENG-10 — KULLANICI-YÜZÜ matris (rozetlerin okuduğu şey). Restart'tan sonra
    // rozet motoru yeniden ölçmek zorunda kalmasın diye kayıtta yaşar. Bilinmeyen
    // alanlar DÜŞER (defter bir log değil) ve `null` = eski kayıt → rozet çizilmez.
    matrix: normalizeCapabilityMatrix(value.matrix),
  };
}

/** ENG-10 — matrisi kanonik/sınırlı hâle indir. Tanınmayan alan ve durum DÜŞER. */
function normalizeCapabilityMatrix(value) {
  if (!value || typeof value !== 'object') return null;
  const out = {};
  for (const id of paneCapabilityMatrix.CAPABILITY_IDS) {
    const e = value[id];
    if (!e || typeof e !== 'object') continue;
    const state = e.state === 'full' || e.state === 'partial' || e.state === 'missing' ? e.state : null;
    if (!state) continue;
    const reason = typeof e.reason === 'string' ? e.reason : null;
    out[id] = {
      state,
      capability: typeof e.capability === 'string' ? e.capability : null,
      reason:
        reason && reason.length > MAX_CAPABILITY_REASON_CHARS
          ? `${reason.slice(0, MAX_CAPABILITY_REASON_CHARS - 1)}…`
          : reason,
      severity: e.severity === 'security' ? 'security' : 'info',
    };
  }
  return Object.keys(out).length ? out : null;
}

/**
 * ADP-269 — is `pid` a process that is still alive and NOT us? `kill(pid, 0)` sends no signal;
 * it just probes existence (ESRCH → gone, EPERM → alive but foreign). A dead owner means the
 * pane belongs to a previous run of this app and is ours to resume.
 *
 * Caveat: the OS may recycle a pid. A false "alive" only SKIPS a resume (the pane is left for
 * the user to reopen) — it never resumes the wrong session, so the failure mode is safe.
 */
// ADP-835 (790 P5) — canlılık probu artık TEK BOĞAZDAN (`platform/procProbe`).
// Davranış AYNEN korunuyor: EPERM = "var ama yabancı" → canlı. Boğaza taşımanın
// sebebi, aynı sorunun ağaçta İKİ ayrı yerde farklı cevaplanıyor olmasıydı
// (`instance-isolation-proof.cjs` her hatayı "ölü" sayıyor). Ayrıca `unknown`
// (EIO gibi beklenmedik kodlar) artık "ölü" DEĞİL — canlı bir pane'i defterden
// düşürmek, ölü bir kaydı bırakmaktan daha pahalıdır.
function ownerAlive(pid) {
  if (!Number.isFinite(pid) || pid === process.pid) return false;
  return procProbe.livenessState(pid, { selfPid: process.pid }).state !== 'gone';
}

/**
 * PANE-RESTORE-DUP-01 — BİR KAYDIN KİMLİĞİ (paneId DEĞİL).
 *
 * Sıra bilinçli: (1) `agentId` — ajanlı pane'in doğal tekilliği ("bir ajan = bir
 * pane", ADP-201/487) HER ŞEYİN ÜSTÜNDEDİR: aynı ajanın iki kaydı iki KOPYAdır,
 * kaç farklı anahtar taşırlarsa taşısınlar; (2) `restoreKey` — ÇIPLAK pane'in ilk
 * kayıtta basılan, restore boyunca taşınan kalıcı anahtarı; (3) TÜRETİLMİŞ anahtar —
 * motor+etiket+cwd. Üçüncü basamak
 * yalnız ESKİ kayıtlar içindir (restoreKey'siz defterler): çıplak motor pane'inin
 * etiketi zaten sayaçlıdır (`Goose 6`, `Cursor CLI 12` — TerminalPanel handleNewPane),
 * yani aynı motor+etiket+cwd üçlüsü pratikte AYNI pane demektir. İki gerçekten farklı
 * pane'in çakışma riski vardır ama bedeli "biri geri gelmez"dir; bugünkü bedel ise
 * her açılışta İKİYE KATLANMAKTI (192 kayıt, 3,4 GB).
 */
function identityKey(entry) {
  const e = entry && typeof entry === 'object' ? entry : {};
  if (typeof e.agentId === 'string' && e.agentId) return `agent:${e.agentId}`;
  if (typeof e.restoreKey === 'string' && e.restoreKey) return `key:${e.restoreKey}`;
  return `bare:${e.engine ?? ''}|${e.label ?? ''}|${e.cwd ?? ''}`;
}

/** Yeni bir kalıcı pane anahtarı bas (yalnız İLK kayıtta çağrılır). */
function mintRestoreKey() {
  try {
    return require('node:crypto').randomUUID();
  } catch {
    // Kripto yoksa bile kayıt yazılabilmeli: kimlik ZAYIFLAR ama YOK OLMAZ.
    return `pk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * Record (upsert) a live AGENT pane at spawn time, keyed by its paneId. The caller
 * (spawnPty) records ONLY agent panes (claude/codex) — a bare login shell has no
 * conversation to resume. Returns the stored entry (or null for a bad paneId).
 *
 * PANE-RESTORE-DUP-01 — YAZIM ARTIK **KİMLİĞE GÖRE UPSERT**. Eskiden yalnız
 * `reg.panes[paneId] = …` vardı: paneId her açılışta yeniden sayıldığı için aynı
 * pane'in ESKİ satırı defterde kalıyordu. Artık aynı `identityKey`i taşıyan başka
 * satırlar DÜŞER — yazım idempotenttir: N kez koşmak N satır değil 1 satır bırakır.
 */
function recordPane(paneId, info, homedir, now) {
  if (typeof paneId !== 'string' || !paneId) return null;
  const reg = loadRegistry(homedir);
  const entry = normalize(info, now);
  // Anahtar YALNIZ çıplak pane'e basılır: ajanlı pane'in kimliği zaten `agentId`dir ve
  // ona ikinci bir anahtar basmak "bir ajan = bir pane" tekilliğini BOZARDI (aynı ajanın
  // iki kaydı iki farklı anahtar taşıyıp ikisi de restore edilirdi).
  if (!entry.agentId && !entry.restoreKey) entry.restoreKey = mintRestoreKey();
  const key = identityKey(entry);
  for (const [otherId, other] of Object.entries(reg.panes)) {
    if (otherId !== paneId && identityKey(other) === key) delete reg.panes[otherId];
  }
  reg.panes[paneId] = entry;
  persist(reg, homedir, { reason: 'record', now });
  // ADP-734 Kapı 3 — silinmeyen defter: `clearAll` bu satırı ASLA silmez.
  journal.appendEvent('spawn', { paneId, ...reg.panes[paneId] }, homedir, now);
  return reg.panes[paneId];
}

/**
 * ADP-386 — teardown anında pane'lerin VT ekran kuyruğunu kayıtlara işle (tek
 * yükle/persist). `tailsByPaneId`: paneId → string[]. Kayıtta olmayan paneId'ler
 * sessizce atlanır (yalnız agent pane'leri kayıtlıdır). Yazılan kayıt sayısını döner.
 */
function setScreenTails(tailsByPaneId, homedir) {
  const entries = Object.entries(tailsByPaneId || {});
  if (!entries.length) return 0;
  const reg = loadRegistry(homedir);
  let n = 0;
  for (const [paneId, tail] of entries) {
    const e = reg.panes[paneId];
    if (!e) continue;
    const norm = normalizeScreenTail(tail);
    if (!norm) continue;
    e.screenTail = norm;
    n += 1;
  }
  if (n) persist(reg, homedir);
  return n;
}

/**
 * ADP-705 — pane'in oturum id'sini TAZELE. `/clear` claude'da yeni bir oturum açar
 * (yeni uuid, yeni jsonl); kayıttaki id bayat kalırsa restart-resume `--resume` ile
 * SIFIRLAMADAN ÖNCEKİ konuşmayı geri getirir. Kayıtta olmayan pane sessizce atlanır.
 * @returns {boolean} kayıt güncellendi mi
 */
function setSessionId(paneId, sessionId, homedir) {
  if (typeof paneId !== 'string' || !paneId) return false;
  if (typeof sessionId !== 'string' || !sessionId) return false;
  const reg = loadRegistry(homedir);
  const e = reg.panes[paneId];
  if (!e || e.sessionId === sessionId) return false;
  e.sessionId = sessionId;
  persist(reg, homedir, { reason: 'session' });
  journal.appendEvent('session', { paneId, ...e }, homedir); // ADP-734 Kapı 3
  return true;
}

/** Forget a pane (its worker was closed on purpose). Returns true if one was removed. */
function removePane(paneId, homedir) {
  const reg = loadRegistry(homedir);
  if (!(paneId in reg.panes)) return false;
  const gone = reg.panes[paneId];
  delete reg.panes[paneId];
  persist(reg, homedir, { reason: 'close' });
  journal.appendEvent('close', { paneId, ...gone }, homedir); // ADP-734 Kapı 3
  return true;
}

/**
 * TASK-MQSBV4EFQ8D6B — forget a pane that main RECYCLED because its delegation work is
 * done (the worker finished; main killed the pane so the next delegation auto-spawns a
 * fresh one). Same intent as an explicit close: drop the entry so restart-resume never
 * resurrects a deliberately-freed worker pane. Thin semantic alias over removePane so the
 * recycle path reads clearly at the call site (and so the registry owns the wording).
 */
function freePane(paneId, homedir) {
  return removePane(paneId, homedir);
}

/**
 * The panes to restore on launch: an array of { paneId, ...entry }, newest first.
 * Empty array when nothing was running (never throws). De-dupes by agentId — if
 * two stale entries share an agentId (a pane that was itself restored, then the
 * app restarted again), only the most-recent is kept so we never double-spawn one
 * agent. Entries WITHOUT an agentId (a raw agent pane) are all kept.
 */
function restoreSnapshot(homedir, isOwnerAlive = ownerAlive) {
  return snapshotEntries(loadRegistry(homedir).panes, isOwnerAlive);
}

/** Shared core of restoreSnapshot/fallbackSnapshot: panes map → ordered, deduped,
 * owner-filtered entry list ({ paneId, ...entry }, newest first). */
function snapshotEntries(panes, isOwnerAlive = ownerAlive) {
  const all = Object.entries(panes || {})
    .map(([paneId, e]) => ({ paneId, ...normalize(e, e && e.updatedAt) }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const seen = new Set();
  const out = [];
  for (const e of all) {
    // ADP-269 — another CrewPane process is alive and owns this pane: do NOT resume it.
    // Without this, an e2e/test instance that resolves to the prod dir would run
    // `claude --resume <sessionId>` against the conversation the PROD app is live in.
    if (isOwnerAlive(e.ownerPid)) continue;
    // PANE-RESTORE-DUP-01 — TEKİLLEŞTİRME ARTIK HER KAYIT İÇİN. Eskiden yalnız
    // `e.agentId` olanlar elenirdi ve buranın yorumu bunu bir KARAR gibi anlatıyordu
    // ("Entries WITHOUT an agentId are all kept"). O karar çıplak motor pane'ini
    // KİMLİKSİZ bırakıyordu: aynı pane'in iki satırı da restore edilip iki pty
    // doğuruyordu. Kimlik `identityKey` ile tanımlı (restoreKey → agentId → türetilmiş),
    // en TAZE satır kazanır (liste updatedAt'e göre yeniden-eskiye sıralı).
    const key = identityKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/**
 * TASK-MRDXOGZJDQLJG — write-ahead snapshot: atomically copy the CURRENT registry
 * to live-panes.quit-snapshot.json. Called (1) at the very top of before-quit,
 * BEFORE any teardown touches a pty, and (2) by restoreLivePanes right before it
 * consumes (clearAll's) the registry — so no code path can wipe the registry
 * without a recoverable copy surviving on disk.
 *
 * Deliberately a NO-OP (returns 0) when the registry is empty: an empty snapshot
 * would clobber the last useful one — and the empty-registry state is exactly the
 * wipe this snapshot exists to recover from. Trade-off: closing ALL agent panes by
 * hand and quitting leaves the previous snapshot behind; the staleness bound
 * (SNAPSHOT_MAX_AGE_MS) plus the fallback's "only when the registry is empty" rule
 * keep any false resurrection rare, visible (logged) and re-closable — losing live
 * sessions is the worse failure. Returns the number of panes snapshotted.
 */
function writeQuitSnapshot(homedir, now) {
  const reg = loadRegistry(homedir);
  const count = Object.keys(reg.panes).length;
  if (!count) return 0;
  const dir = crewpaneDir(homedir);
  fs.mkdirSync(dir, { recursive: true });
  const file = snapshotPath(homedir);
  atomicWriteFileSync(
    file,
    JSON.stringify(
      {
        version: REGISTRY_VERSION,
        snapshotAt: Number.isFinite(now) ? now : Date.now(),
        panes: reg.panes,
      },
      null,
      2,
    ),
    { inPlaceFallback: true }, // ADP-946
  );
  return count;
}

/**
 * TASK-MRDXOGZJDQLJG — the restore fallback: entries from a FRESH quit snapshot,
 * shaped exactly like restoreSnapshot's output. Empty array when the snapshot is
 * missing / corrupt / wrong-shape / STALE (older than maxAgeMs) — never throws.
 * restoreLivePanes reaches for this ONLY when the registry itself came up empty.
 */
function fallbackSnapshot(homedir, opts = {}) {
  const maxAgeMs = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : SNAPSHOT_MAX_AGE_MS;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const isOwnerAlive = opts.isOwnerAlive || ownerAlive;
  try {
    const raw = JSON.parse(fs.readFileSync(snapshotPath(homedir), 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.panes || typeof raw.panes !== 'object') return [];
    if (!Number.isFinite(raw.snapshotAt) || now - raw.snapshotAt > maxAgeMs) return [];
    return snapshotEntries(raw.panes, isOwnerAlive);
  } catch {
    return [];
  }
}

/** Wipe the registry (consumed at launch after snapshotting). Returns path. */
function clearAll(homedir) {
  return persist(emptyRegistry(), homedir, { reason: 'consume' });
}

// ═══════════════════════════════════════════════════════════════════════════
// PANE-RESTORE-DUP-01 — ŞİŞMİŞ DEFTERİN TEK SEFERLİK, YEDEKLİ SIKIŞTIRILMASI
// ═══════════════════════════════════════════════════════════════════════════
// Fix ileriye dönüktür: bundan sonra yazılan kayıt idempotenttir. Ama KULLANICININ
// DİSKİNDE zaten şişmiş defterler var (Eren'in dev profili: 192 kayıt, aynı 7 etiket
// ~29'ar kez). Onlar dokunulmazsa fix'li sürümün İLK açılışı yine 192 pty doğurur —
// yani düzeltme kullanıcının gözünde ÇALIŞMAZ.
//
// Sıkıştırma SİLME DEĞİL SEÇMEdir: her `identityKey` için EN TAZE satır kalır, öncesi
// zaman damgalı yedeğe (`backups/live-panes.<ISO>.json`) yazılır — geri dönüş yolu
// ÖNCEDEN hazırdır. İdempotent: kopya yoksa dosyaya HİÇ dokunulmaz (`changed:false`).
const COMPACT_MAX_BACKUPS = MAX_SHRINK_BACKUPS;

/**
 * @returns {{before:number, after:number, removed:number, changed:boolean, backup:string|null}}
 */
function compactRegistry(homedir, now) {
  const reg = loadRegistry(homedir);
  const entries = Object.entries(reg.panes || {});
  const before = entries.length;
  if (before < 2) return { before, after: before, removed: 0, changed: false, backup: null };
  // En TAZE önce — `snapshotEntries` ile AYNI sıra kuralı (tek gerçek).
  const ordered = entries
    .map(([paneId, e]) => [paneId, normalize(e, e && e.updatedAt)])
    .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
  const keep = {};
  const seen = new Set();
  for (const [paneId, e] of ordered) {
    const key = identityKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    keep[paneId] = e;
  }
  const after = Object.keys(keep).length;
  if (after === before) return { before, after, removed: 0, changed: false, backup: null };
  const backup = backupPanes(reg.panes, homedir, now);
  // `guard:false` — düşüş BİLEREK yapılıyor; küçülme nöbetinin ikinci bir yedek alıp
  // "beklenmedik kayıp" diye rapor etmesi burada YANLIŞ sinyal olurdu.
  persist({ panes: keep }, homedir, { guard: false });
  return { before, after, removed: before - after, changed: true, backup };
}

// ═══════════════════════════════════════════════════════════════════════════
// ADP-734 Kapı 1 — ÇOK-KÖK KEŞİF (veri kökü göçü tek-yönlü kapı OLAMAZ)
// ═══════════════════════════════════════════════════════════════════════════
// KÖK NEDEN (ADP-732'de kanıtlandı): ADP-703 hesap göçü defteri
// `~/.crewpane/` → `~/.crewpane/accounts/u-…/` TAŞIDI. Eren 0.2.21'den 0.2.20'ye
// geri döndü; o sürümde `accountScope.cjs` YOK → `registryPath()` KÖK yolu döndürdü
// → dosya yok → `loadRegistry` SESSİZCE boş defter verdi → 7 canlı ajan ekrandan
// silindi. Göç ileriye test edilir, GERİ DÖNÜŞ test edilmez; ama kullanıcı yeni
// sürüm bozuksa HEP geri döner.
//
// Bu kapı iki yönlüdür:
//   (a) accountScope göçü artık defteri KOPYALAR (taşımaz) — eski sürüm de bulur;
//   (b) burada: aktif kök boş çıkarsa bu makinedeki TÜM veri kökleri (instance
//       kökü + accounts/*) hem defter hem quit-snapshot için taranır, EN TAZE dolu
//       kayıt seçilir ve seçim RAPOR EDİLİR (sessiz boş defter artık imkânsız).

/** Bu makinede pane defteri barındırabilecek TÜM veri kökleri (aktif kök önce). */
function registryRoots(homedir) {
  const roots = [crewpaneDir(homedir)];
  let instanceRoot;
  try { instanceRoot = instancePaths.instanceHome(homedir); } catch { instanceRoot = null; }
  if (instanceRoot) {
    roots.push(instanceRoot);
    try {
      const dir = accountScope.accountsDir(instanceRoot);
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith('.')) continue;
        const p = path.join(dir, name);
        try { if (fs.statSync(p).isDirectory()) roots.push(p); } catch { /* atla */ }
      }
    } catch { /* accounts/ yok → tek kök */ }
  }
  return [...new Set(roots)];
}

/** Bir kökteki defter/snapshot dosyasını oku → {panes, at} ya da null (asla atmaz). */
function readPanesFile(file, kind) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.panes || typeof raw.panes !== 'object') return null;
    const panes = raw.panes;
    const count = Object.keys(panes).length;
    if (!count) return null;
    // Tazelik: snapshot kendi damgasını taşır; defterde en yeni `updatedAt` kullanılır,
    // ikisi de yoksa dosya mtime'ı (elle kopyalanmış/eski şema kayıtları için).
    let at = Number.isFinite(raw.snapshotAt) ? raw.snapshotAt : 0;
    if (!at) {
      for (const e of Object.values(panes)) {
        if (e && Number.isFinite(e.updatedAt) && e.updatedAt > at) at = e.updatedAt;
      }
    }
    if (!at) {
      try { at = fs.statSync(file).mtimeMs; } catch { at = 0; }
    }
    return { file, kind, panes, count, at };
  } catch {
    return null;
  }
}

/**
 * Tüm köklerdeki dolu defter/snapshot adayları — EN TAZE önce.
 * @returns {Array<{root:string,file:string,kind:'registry'|'snapshot',count:number,at:number}>}
 */
function discoverCandidates(homedir) {
  const out = [];
  for (const root of registryRoots(homedir)) {
    for (const [kind, name] of [['registry', 'live-panes.json'], ['snapshot', 'live-panes.quit-snapshot.json']]) {
      const found = readPanesFile(path.join(root, name), kind);
      if (found) out.push({ root, ...found });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/**
 * KURTARILABİLİR EN TAZE KAYIT — Kapı 1 + Kapı 2'nin ortak giriş noktası.
 * Aktif kökün kendi defteri zaten doluysa çağıran buraya HİÇ gelmez (normal yol).
 *
 * `stale` = kayıt `maxAgeMs`'ten eski. ESKİ KAYIT ARTIK SESSİZCE ATILMAZ (ADP-732
 * RC-2: 23 dakikalık gecikme kusursuz bir 7-pane yedeğini çöpe attı) — döndürülür,
 * çağıran otomatik açmak yerine kullanıcıya TEKLİF eder.
 *
 * @returns {{entries:Array,source:{root,file,kind,count,at},stale:boolean}|null}
 */
function discoverRecoverable(homedir, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const maxAgeMs = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : SNAPSHOT_MAX_AGE_MS;
  const isOwnerAlive = opts.isOwnerAlive || ownerAlive;
  for (const cand of discoverCandidates(homedir)) {
    const entries = snapshotEntries(cand.panes, isOwnerAlive);
    if (!entries.length) continue; // hepsi başka bir CANLI sürece ait → aday değil
    return {
      entries,
      source: { root: cand.root, file: cand.file, kind: cand.kind, count: cand.count, at: cand.at },
      stale: now - cand.at > maxAgeMs,
    };
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// ADP-761 — TÜKETİLEN YABANCI DEFTERİ EMEKLİYE AYIR (iki-defter uyuşmazlığı)
// ═══════════════════════════════════════════════════════════════════════════
// Ölçülen canlı durum (2026-07-30): AYNI makinede İKİ pane defteri yan yana duruyordu
//   • `~/.crewpane/live-panes.json`                       → 8 kayıt, ownerPid=2185 (ÖLÜ süreç),
//                                                             ratchet İKİ KEZ
//   • `~/.crewpane/accounts/u-…/live-panes.json`          → 8 kayıt, ownerPid=72917 (canlı)
// Sebep: sürüm geri dönüşü (ADP-732/734) sırasında kapsamsız kökte koşan bir build
// oraya yazdı. ADP-734 Kapı 1 bu YABANCI köke bakıp kaybı KURTARIYOR (doğru), ama
// tükettiği dosyayı OLDUĞU GİBİ bırakıyordu: `clearAll()` yalnız AKTİF kökü boşaltır.
// Sonuç, kendini besleyen bir döngü: aynı ölü kayıtlar HER açılışta yeniden keşfedilir,
// aktif deftere "ek" olarak katılır ve o an canlı olmayan her ajan aylar öncesinin
// oturumuyla diriltilebilir — yani defter ÖLÜMSÜZ olur.
//
// Emeklilik = SİLME DEĞİL, yeniden ADLANDIRMA (`<ad>.consumed-<ISO>.json`): veri
// incelenebilir kalır, `discoverCandidates` bir daha görmez (yalnız iki sabit adı
// tarar). İdempotent: dosya yoksa sessizce geçer.
function retireConsumedSource(file) {
  if (typeof file !== 'string' || !file) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = file.replace(/\.json$/, '') + `.consumed-${stamp}.json`;
  try {
    renameWithRetrySync(file, target);
    return target;
  } catch {
    return null; // dosya yok / izin yok → kurtarma yine yapıldı, döngü riski loglanır
  }
}

module.exports = {
  REGISTRY_VERSION,
  SNAPSHOT_MAX_AGE_MS, // TASK-MRDXOGZJDQLJG
  MAX_SYSTEM_PROMPT_LEN, // AD-WIN-02 — tek kaynaktan gelir (systemPromptCap.STORAGE_MAX)
  crewpaneDir,
  registryPath,
  snapshotPath, // TASK-MRDXOGZJDQLJG
  emptyRegistry,
  loadRegistry,
  persist,
  normalize,
  normalizeScreenTail, // ADP-386
  identityKey, // PANE-RESTORE-DUP-01 — paneId DEĞİL, kaydın kalıcı kimliği
  compactRegistry, // PANE-RESTORE-DUP-01 — şişmiş defteri yedekleyerek tekilleştir
  COMPACT_MAX_BACKUPS, // PANE-RESTORE-DUP-01
  recordPane,
  setScreenTails, // ADP-386
  setSessionId, // ADP-705 — `/clear` sonrası tazelenen oturum id'si
  removePane,
  freePane,
  restoreSnapshot,
  writeQuitSnapshot, // TASK-MRDXOGZJDQLJG
  fallbackSnapshot, // TASK-MRDXOGZJDQLJG
  ownerAlive, // ADP-269
  clearAll,
  // ── ADP-734 Kapı 1 (çok-kök keşif) ──────────────────────────────────────
  registryRoots,
  discoverCandidates,
  discoverRecoverable,
  retireConsumedSource, // ADP-761 — tüketilen YABANCI defteri emekliye ayır
  // ── ADP-734 Kapı 2 (küçülme nöbeti) ─────────────────────────────────────
  SHRINK_DROP_THRESHOLD,
  MAX_SHRINK_BACKUPS,
  setShrinkObserver,
  backupsDir,
  guardShrink,
};
