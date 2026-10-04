// ADP-050 (ADR-004 §A1) — delegation bridge TRANSPORT (Electron main side).
//
// The leader claude runs as a CLI process inside a pane; it cannot reach the
// renderer's `window.crewpaneDelegation.startTeamDelegation()` (ADP-033). This
// bridge is the missing hop: a loopback-only HTTP listener (token-guarded) in the
// MAIN process that forwards a delegate request to the renderer over IPC, which
// then calls the EXISTING delegation engine to spawn real worker panes.
//
//   leader's MCP server (ADP-051) ──HTTP POST 127.0.0.1:<port> (+token)──► THIS
//        │                                                                  │
//        │                       webContents.send('delegation:start', …)    │
//        ▼                                                                  ▼
//   { delegationId }  ◄──────── ipc 'delegation:start:result' ──── RENDERER handler
//                                                          → startTeamDelegation(…)
//
// Security (ADR-004 + ADR-002 RCE discipline): binds ONLY 127.0.0.1, EVERY request
// needs the bearer token (constant-time compare), body size-capped, JSON-only.
// delegationRunner is NOT re-implemented — the bridge just carries objective +
// leaderId + department (+ optional workers) to it.
//
// Pure helpers (auth + payload validation) are exported for unit tests; the server
// wiring is exercised by the ADP-050 e2e (real curl→pane).

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crewpaneEnv = require('../config/crewpaneEnv.cjs'); // ADP-244 Faz 3 — CREWPANE_* ⇄ CREWPANE_* dual-read

// ADP-095 — browser-control payload validation (CDP executor lives in browserCdp.js;
// this module only validates + gates + transports).
// ADP-341 — onay kararı ARTIK eylem türüne bakmıyor: risk kapısı (origin × hedef ×
// eylem × mod) browserGate/browserTrust'ta. Karar burada KOPYALANMAZ, çağrılır.
const { validateBrowserPayload } = require('../services/browserCdp.js');
// VOICE-TRUNC-02 — dikte gövde doğrulaması (teslim mantığı dictationDelivery.cjs'te;
// köprü yalnız taşır ve doğrular — politika/teslim burada TANIMLANMAZ).
const { validateDictationPayload } = require('../voice/dictationDelivery.cjs');
const { getBrowserGate } = require('../security/browserGate.cjs');

// TASK-MQTIYIIZE5VR7 (st2) — completion-report format helpers (pure: filename +
// markdown shape that src/lib/reports.ts parses). The bridge is the runtime-fallback
// WRITE channel; agentRunner owns the bytes so the format has one source of truth.
const { reportFileName, buildReportMarkdown, writeJsonAtomic } = require('./agentRunner.js');

// ADP-242 — 64KB'lık eski sınır 10-30 task'lık bir sprint planını (task başına
// detaylı prompt) kesebiliyordu; loopback + token-korumalı kanalda 256KB hâlâ
// sıkı bir üst sınır. Delegate payload'ları eskisi gibi minik kalır.
const MAX_BODY_BYTES = 256 * 1024;
const IPC_TIMEOUT_MS = 15000; // renderer round-trip budget
// ADP-226 — handshake delivery hardening. bridge.json is the MCP servers' ONLY
// failover path when their spawn-time env snapshot goes stale (app restart →
// new port/token). A missing file kills delegation, so: (1) a failed initial
// write retries on a short backoff, and (2) a self-heal interval re-writes the
// file (fresh updatedAt) for as long as the bridge lives — so even an external
// unlink / a pre-pid-guard sibling's teardown is repaired within one period.
const HANDSHAKE_RETRY_DELAYS_MS = [250, 1000, 4000];
const HANDSHAKE_REFRESH_MS = 30_000;
// ENV-08 — SAHİP KORUMASI eşiği: canlı bridge self-heal ile 30 sn'de bir yazar;
// updatedAt bundan 3 periyot eskiyse sahibin self-heal'i ölmüştür (süreç gitti,
// pid'i geri dönüştürülmüş olabilir) → dosya öksüzdür, üzerine yazılabilir.
const HANDSHAKE_STALE_MS = 3 * HANDSHAKE_REFRESH_MS;
// ENV-08 — sahip damgasının startedAt bileşeni: süreç başına SABİT (modül yükü ≈
// süreç başlangıcı). Her yazımda değişseydi damga "aynı sahip mi?" sorusuna
// cevap veremezdi.
const HANDSHAKE_STARTED_AT = new Date().toISOString();

/** ENV-08 — `kill(pid,0)` varlık sorusu; EPERM = var ama bizim değil → CANLI. */
function handshakeOwnerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!e && e.code === 'EPERM';
  }
}
const BROWSER_APPROVAL_TIMEOUT_MS = 120000; // a human must click İzin ver/Reddet
// ADP-206 — instance-scoped: PROD ~/.crewpane/bridge.json, DEV ~/.crewpane-dev/
// bridge.json. The bridge already listens on an EPHEMERAL port (listen(0)), so the
// two instances never collide on a port; namespacing the handshake file keeps a DEV
// MCP child from falling back onto PROD's host/port/token.
const instancePaths = require('../config/instancePaths.cjs');
// ADP-703 — bridge.json CİHAZA aittir (hesap köküne taşınmaz): açılışta yeniden yazılan
// bir çalışma-anı el sıkışmasıdır (port + token) ve bu sabit MODÜL YÜKLENİRKEN çözülür —
// yani hesap kökü bağlanmadan ÖNCE. Hesap kapsamına alınsaydı sabit bayat bir yola
// çakılırdı. Bkz. docs/design/ACCOUNT-SCOPED-STORE.md §2 (D satırları).
const BRIDGE_DIR = instancePaths.instanceHome();
const BRIDGE_FILE = path.join(BRIDGE_DIR, 'bridge.json');

// TASK-MQTIYIIZE5VR7 (st2) — where a fallback completion report lands. MUST match a
// src/lib/reports.ts `reportsDirs()` entry so the file written here is the one the
// Raporlar tab reads back. Priority: opts.resolveResultsDir (main passes the selected
// workspace root, ADP-234) → `CREWPANE_RESULTS_DIR` env (tests / packaged layout) →
// the legacy CrewPane path below (LAST-resort only — kept so a bridge started without
// the option, e.g. old unit tests, behaves as before). The bridge writes server-side so
// the file lands in the repo regardless of the worker's cwd (ADP-154 wrong-cwd class).
const MAX_REPORT_SUMMARY_LEN = 4000; // a completion summary is short; cap hard
// ADP-835 (790 Y5) — the final fallback below is Eren's single dev machine's folder
// name, hardcoded (ekip hafızası single-user-assumption-pattern). VERIFIED DEAD in the
// real running app: electron/main.js ALWAYS passes `resolveResultsDir` when wiring
// startDelegationBridge (and throws `workspace_not_configured` rather than falling back
// here if no workspace is selected) — this path is only reachable from a standalone
// caller that omits the option (today: old unit tests). Left UNCHANGED rather than
// guarded/nulled on win32: `writeReportFile`/the HTTP handler both do
// `path.join(dir, …)` on the result with NO null-check, so returning `null` here would
// turn a dead-code path into a live crash for zero behavioral benefit (win32 never
// reaches this line in production either). If this ever becomes reachable in production,
// fix it at the call site (thread resolveResultsDir through), not by weakening this
// contract.
function defaultResultsDir() {
  const envDir = crewpaneEnv.readEnv('RESULTS_DIR'); // ADP-244 Faz 3 — dual-read
  if (envDir) return envDir;
  return path.join(os.homedir(), 'Downloads', 'CrewPane Apps', 'crewpane', 'docs', 'agent-results');
}

// ───────────────────────────────────────────────────────────────────────────
// TASK-MQQ2I4FBV9R2 — the leader READS a delegation's worker output through this bridge
// (GET /delegation/status). Two problems we fix HERE, at the read channel:
//   1. the raw snapshot carries ANSI-laden pane bytes → clean them to readable lines, and
//   2. a transient engine/API error (overload/rate-limit/network) must surface as `apiError`
//      so the leader never reads a re-dispatchable hiccup as a FALSE 'failed'.
// CJS cannot import the renderer's terminalActivity.ts (separate module graph), so this is a
// small self-contained mirror of its stripAnsi + the engine's API-error signatures. Pure.
const OSC_PATTERN = new RegExp('\\x1b\\][\\s\\S]*?(?:\\x07|\\x1b\\\\)', 'g');
const ANSI_PATTERN = new RegExp(
  '[\\x1b\\x9b][[\\]()#;?]*(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]',
  'g',
);
const DEFAULT_TAIL_LINES = 14;

/** Strip ANSI/OSC escape noise so the leader reads plain text. */
function stripAnsi(input) {
  return typeof input === 'string' ? input.replace(OSC_PATTERN, '').replace(ANSI_PATTERN, '') : '';
}

/** Last `maxLines` non-blank, ANSI-free lines of a pane tail (what the leader reads). */
function cleanPaneTail(input, maxLines = DEFAULT_TAIL_LINES) {
  const lines = stripAnsi(input)
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+$/, ''))
    .filter((l) => l.trim().length > 0);
  return lines.slice(-Math.max(1, maxLines)).join('\n');
}

// The SAME specific transient-error signatures the engine (delegation.ts) classifies on, so a
// LIVE (not-yet-terminal) pane showing an API error is flagged even before the engine settles
// it. Named tokens / claude-CLI phrases only — normal prose / a successful run never trips them.
const API_ERROR_SIGNATURES = [
  /overloaded(?:_error)?\b|\b529\b/i,
  /rate[_ ]?limit(?:_error)?\b|rate limit (?:reached|exceeded|hit)/i,
  /api[_ ]?error\b/i,
  /internal[ _]server[ _]error|\b500 internal\b/i,
  /service[ _]unavailable|\b503 service\b/i,
  /bad gateway|\b502 bad\b/i,
  /request timed out|request_timeout|\bETIMEDOUT\b/i,
  /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang ?up|fetch failed|network error|connection error\b/i,
  /authentication_error|invalid x-api-key|\b401 unauthorized\b/i,
  /credit balance is too low|insufficient_quota/i,
  /usage limit|session limit|\d+-?\s*hour limit|limit (?:reached|exceeded)/i,
];

/** True when a pane tail shows a transient engine/API error (re-dispatchable, not a work failure). */
function paneHasApiError(input) {
  const t = stripAnsi(input);
  if (!t) return false;
  return API_ERROR_SIGNATURES.some((re) => re.test(t));
}

/**
 * Enrich a delegation status snapshot (one object or an array) for the LEADER: clean each
 * subtask's `output` to readable lines and set `apiError` (engine flag OR a live-detected
 * error on a still-running pane). Additive — every existing field is preserved, so the MCP
 * summary / pane-count read paths are untouched. Defensive: any odd shape passes through.
 */
function enrichDelegationSnapshot(snapshot) {
  if (!snapshot) return snapshot;
  const enrichOne = (d) => {
    if (!d || typeof d !== 'object' || !Array.isArray(d.subtasks)) return d;
    return {
      ...d,
      subtasks: d.subtasks.map((s) => {
        if (!s || typeof s !== 'object') return s;
        const apiError = s.apiError === true || (s.status !== 'done' && paneHasApiError(s.output));
        return { ...s, apiError, output: cleanPaneTail(s.output) };
      }),
    };
  };
  return Array.isArray(snapshot) ? snapshot.map(enrichOne) : enrichOne(snapshot);
}

/** Mint a URL-safe bridge token. */
function mintToken() {
  return crypto.randomBytes(32).toString('hex');
}

/** Constant-time bearer-token check against `expected` (header may be missing). */
function checkToken(headerValue, expected) {
  if (typeof headerValue !== 'string' || !expected) return false;
  const got = headerValue.startsWith('Bearer ') ? headerValue.slice(7) : headerValue;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Validate + normalize a /delegate body → { ok, value | error }. */
function validateDelegatePayload(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be a JSON object' };
  const objective = typeof body.objective === 'string' ? body.objective.trim() : '';
  const leaderId = typeof body.leaderId === 'string' ? body.leaderId.trim() : '';
  const department = typeof body.department === 'string' ? body.department.trim() : '';
  if (!objective) return { ok: false, error: 'objective is required' };
  if (!leaderId) return { ok: false, error: 'leaderId is required' };
  if (!department) return { ok: false, error: 'department is required' };
  // workers optional; pass through only if it's an array of plain objects.
  let workers;
  if (Array.isArray(body.workers)) {
    workers = body.workers.filter((w) => w && typeof w === 'object' && typeof w.agentId === 'string');
  }
  const value = { objective, leaderId, department };
  if (workers) value.workers = workers;
  if (body.bossId && typeof body.bossId === 'string') value.bossId = body.bossId;
  // ADP-565 — objective-level MODEL (applied to workers with no explicit model). Passed
  // through verbatim; agentRunner.sanitizeModel validates it main-side at spawn (a crafted
  // value is silently dropped there — never reaches the command line).
  if (body.model && typeof body.model === 'string') value.model = body.model;
  // ADP-595 — objective-level SAĞLAYICI (codex `-c model_provider=…`). Aynı sözleşme:
  // aynen geçirilir, geçerlilik main'de providers.isProvider ile karara bağlanır.
  if (body.provider && typeof body.provider === 'string') value.provider = body.provider;
  return { ok: true, value };
}

// ═══════════════════════════════════════════════════════════════════════════
// ENG-11 (ENG-R3 §8.2) — DELEGATE YETKİLENDİRMESİ: SERT KATMAN KÖPRÜYE TAŞINDI
// ═══════════════════════════════════════════════════════════════════════════
// ADR-004'ün "worker alt-delegasyon YAPAMAZ" kuralının SERT katmanı bugüne kadar
// MCP KAYDIydı: claude worker'ına `--strict-mcp-config` + yalnız browser/task
// server'ı verilir, delegate server'ı HİÇ GÖRÜNMEZ. ENG-R3 §8.2 bunun iki deliğini
// ölçtü:
//   1. codex'te `--strict` DENGİ YOK → kayıt additive; izolasyon GARANTİ değil.
//   2. Tier B köprüsü (crewpaneCli.cjs) bir SHELL komutudur: "hangi araç görünür"
//      sorusu oradan sorulamaz. Sert katman taşıyıcı değiştirmek zorunda: artık
//      soru "KÖPRÜ bu pane'in delegate çağrısını KABUL EDER Mİ".
//
// KARARIN KAYNAĞI — sunucu tarafı gerçek: `livePaneRegistry` kaydı. Delegasyonun
// AÇTIĞI worker pane'i `disallowSubagent:true` ile kaydedilir (agentRunner
// withSubagentBlock'un da girdisi). Yani "bu kimlik bir worker mı" sorusunun cevabı
// istemcinin BEYANINDA değil, bizim kendi defterimizde duruyor.
//
// İstemci beyanı (header) İKİNCİ bir ağdır: pane env'i lider pane'inde LEADER_ID,
// worker pane'inde AGENT_ID taşır (agentRunner withLeaderEnv/withBrowserEnv) —
// yani "yalnız AGENT_ID beyan eden" bir çağıran tanımı gereği worker'dır.
//
// 🔴 DÜRÜST SINIR: bu bir KİMLİK DOĞRULAMA değil. Loopback + pane env'i bu ürünün
// güven sınırıdır; kabuğu olan bir ajan env'i ezip başka bir kimlik beyan edebilir.
// Kapının kapattığı şey, ADR-004'ün YASAKLADIĞI yolun KAZAYLA ve SESSİZCE açık
// kalması (codex additive kaydı + CLI köprüsü). Bunu "çözüldü" diye raporlamak
// yanlış olurdu; kapatılan delik ölçülebilir, kalan risk beyanlıdır.

/** Header'dan kimlik beyanı (iki ad da okunur: CREWPANE_* kanonik, CREWPANE_* legacy). */
function declaredIdentity(headers) {
  const h = headers && typeof headers === 'object' ? headers : {};
  const pick = (...names) => {
    for (const n of names) {
      const v = h[n];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };
  return {
    agentId: pick('x-crewpane-agent-id', 'x-crewpane-agent-id'),
    leaderId: pick('x-crewpane-leader-id', 'x-crewpane-leader-id'),
  };
}

/** Canlı pane defterinden bir ajanın kaydı (yoksa null). Saf-ish: okuma yalnız. */
function paneRecordForAgent(agentId, homedir) {
  if (!agentId) return null;
  try {
    const registry = require('./livePaneRegistry.cjs');
    const reg = registry.loadRegistry(homedir);
    for (const [paneId, rec] of Object.entries(reg.panes || {})) {
      if (rec && rec.agentId === agentId) return { paneId, ...rec };
    }
  } catch {
    /* defter okunamadı → hüküm YOK (aşağıda 'unverified') */
  }
  return null;
}

/**
 * ENG-11 — köprünün ÇAĞIRAN-KİMLİĞİ kararı. SAF: tüm dünya bilgisi argümanlarda.
 *
 * SEC-01 — bu kapı artık `POST /delegate` ile `POST /pane/close`'un ORTAK kapısıdır.
 * Eskiden yalnız `/delegate` ondan geçiyordu ve ölçülen sonuç şuydu (gerçek köprü,
 * gerçek HTTP): `x-crewpane-agent-id` beyan eden bir WORKER pane'i
 *   /delegate   → 403 worker-subdelegation
 *   /pane/close → 200, BAŞKA takımın canlı lider pane'i ÖLDÜ
 * Yani ADR-004'ün kapattığı yol, "iş başlatma" ucunda kapalı "iş öldürme" ucunda
 * AÇIKTI — kapatmak başlatmaktan daha yıkıcı olduğu hâlde. Kapsam kararı (teamScope)
 * ADP-717'den beri ortaktı; EKSİK OLAN kimlik kararıydı.
 *
 * @param {object} o
 * @param {object} o.headers          istek başlıkları (kimlik beyanı)
 * @param {string} o.leaderId         gövdedeki leaderId (kim adına delegasyon)
 * @param {(id:string)=>object|null} o.resolveAgent  ajan → canlı pane kaydı
 * @returns {{ok:boolean, code?:string, reason?:string, verified:boolean}}
 */
function authorizeDelegateCaller({ headers, leaderId, resolveAgent } = {}) {
  const declared = declaredIdentity(headers);
  const lookup = typeof resolveAgent === 'function' ? resolveAgent : () => null;

  // 1) Beyan yalnız AGENT_ID taşıyorsa çağıran bir WORKER pane'idir (lider pane'i
  //    LEADER_ID taşır). Alt-delegasyon ADR-004'te yasak.
  if (declared.agentId && !declared.leaderId) {
    return {
      ok: false,
      code: 'worker-subdelegation',
      reason: `alt-delegasyon yasak: "${declared.agentId}" bir worker pane'i (ADR-004) — işi KENDİN yürüt`,
      verified: true,
    };
  }
  // 2) Beyan edilen lider ile gövdedeki lider AYNI olmalı: başkasının adına
  //    delegasyon açmak (kimlik ödünç alma) reddedilir.
  if (declared.leaderId && leaderId && declared.leaderId !== leaderId) {
    return {
      ok: false,
      code: 'identity-mismatch',
      reason: `kimlik uyuşmazlığı: pane "${declared.leaderId}" ama istek "${leaderId}" adına`,
      verified: true,
    };
  }
  // 3) SUNUCU TARAFI GERÇEK (istemci işbirliği GEREKMEZ): gövdedeki lider canlı
  //    defterde bir WORKER pane'i olarak duruyorsa reddedilir. codex'in additive
  //    MCP kaydında (ve CLI köprüsünde) tek gerçek kapı budur.
  const rec = lookup(leaderId);
  if (rec && rec.disallowSubagent === true) {
    return {
      ok: false,
      code: 'worker-subdelegation',
      reason: `alt-delegasyon yasak: "${leaderId}" canlı defterde worker pane'i (disallowSubagent) — ADR-004`,
      verified: true,
    };
  }
  // 4) Kimlik doğrulanamadı (beyan yok + defterde kayıt yok) → BUGÜNKÜ davranış
  //    korunur (eski MCP build'leri ve renderer-dışı çağrılar çalışmaya devam eder),
  //    ama karar `verified:false` ile loglanır: sessiz geçiş yok.
  return { ok: true, verified: !!(declared.leaderId || rec) };
}

/**
 * TASK-MQTIYIIZE5VR7 (st2) — validate + normalize a /report body.
 * Required: `taskId` (the board/subtask id → report FILENAME prefix). Optional:
 * `role` (filename suffix; default `report`), `agentName` (frontmatter `agent:`),
 * `status` (frontmatter `status:`), `summary` (report body / panel summary).
 * Returns { ok, value | error }. Path-safety is enforced downstream by
 * agentRunner.reportFileName (sanitizes every segment) — here we only shape/cap.
 */
function validateReportPayload(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be a JSON object' };
  const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : '';
  if (!taskId) return { ok: false, error: 'taskId is required' };
  // reportFileName sanitizes the id; reject only when nothing usable survives.
  if (!reportFileName(taskId, 'report')) return { ok: false, error: 'taskId has no usable characters' };
  const value = { taskId };
  if (typeof body.role === 'string' && body.role.trim()) value.role = body.role.trim();
  if (typeof body.agentName === 'string' && body.agentName.trim()) value.agentName = body.agentName.trim();
  if (typeof body.status === 'string' && body.status.trim()) value.status = body.status.trim();
  if (typeof body.summary === 'string' && body.summary.trim()) {
    value.summary = body.summary.trim().slice(0, MAX_REPORT_SUMMARY_LEN);
  }
  if (body.force === true) value.force = true; // explicit overwrite (default: fallback never clobbers)
  return { ok: true, value };
}

/**
 * TASK-MQTIYIIZE5VR7 (st2) — write a completion report into `resultsDir`. FALLBACK
 * semantics by default: if `<task>-<role>.md` already exists with content, it is the
 * worker's own (richer) report → DO NOT clobber it (returns { ok, skipped:true }).
 * Pass `force:true` for an explicit overwrite. The filename comes from the pure
 * agentRunner helper (every segment sanitized), and we re-assert the resolved path
 * stays inside `resultsDir` (defense in depth vs. path traversal). Best-effort: any
 * IO error returns { ok:false, error } rather than throwing — a missed report must
 * never crash the bridge. Exported so completion-signal / main can call it directly.
 */
function writeReportFile(value, resultsDir) {
  const dir = resultsDir || defaultResultsDir();
  const filename = reportFileName(value.taskId, value.role);
  if (!filename) return { ok: false, error: 'could not derive a report filename' };
  const full = path.join(dir, filename);
  const resolved = path.resolve(full);
  if (resolved !== path.resolve(dir, filename) || !resolved.startsWith(path.resolve(dir) + path.sep)) {
    return { ok: false, error: 'refusing to write outside the results dir' };
  }
  try {
    if (!value.force) {
      try {
        if (fs.statSync(full).size > 0) return { ok: true, filename, skipped: true };
      } catch {
        /* missing → write it */
      }
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      full,
      buildReportMarkdown({
        taskId: value.taskId,
        role: value.role,
        agentName: value.agentName,
        status: value.status,
        summary: value.summary,
      }),
    );
    return { ok: true, filename };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/**
 * ADP-242 — validate + normalize a /sprint body (uzun-sprint planı). ŞEKİL kontrolü
 * burada (transport katmanı); SEMANTİK doğrulama (döngü, kanıt-yolu SERT KURALI,
 * bilinmeyen bağımlılık) renderer'daki sprintOrchestrator.validatePlan'da — hata
 * mesajı bridge cevabıyla lidere aynen döner.
 */
function validateSprintPayload(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be a JSON object' };
  const objective = typeof body.objective === 'string' ? body.objective.trim() : '';
  const leaderId = typeof body.leaderId === 'string' ? body.leaderId.trim() : '';
  const department = typeof body.department === 'string' ? body.department.trim() : '';
  if (!objective) return { ok: false, error: 'objective is required' };
  if (!leaderId) return { ok: false, error: 'leaderId is required' };
  if (!department) return { ok: false, error: 'department is required' };
  if (!Array.isArray(body.tasks) || body.tasks.length === 0) {
    return { ok: false, error: 'tasks is required (array of {id,title,prompt,...})' };
  }
  const tasks = [];
  for (const t of body.tasks) {
    if (!t || typeof t !== 'object') return { ok: false, error: 'every task must be an object' };
    const id = typeof t.id === 'string' ? t.id.trim() : '';
    const prompt = typeof t.prompt === 'string' ? t.prompt.trim() : '';
    if (!id) return { ok: false, error: 'every task needs an id' };
    if (!prompt) return { ok: false, error: `task ${id}: prompt is required` };
    const shaped = { id, title: typeof t.title === 'string' && t.title.trim() ? t.title.trim() : id, prompt };
    if (Array.isArray(t.dependsOn)) shaped.dependsOn = t.dependsOn.filter((d) => typeof d === 'string');
    if (typeof t.workerAgentId === 'string' && t.workerAgentId.trim()) shaped.workerAgentId = t.workerAgentId.trim();
    if (typeof t.expectedOutput === 'string' && t.expectedOutput.trim()) shaped.expectedOutput = t.expectedOutput.trim();
    if (Number.isInteger(t.maxAttempts) && t.maxAttempts > 0) shaped.maxAttempts = t.maxAttempts;
    tasks.push(shaped);
  }
  const value = { objective, leaderId, department, tasks };
  if (Number.isInteger(body.maxConcurrent) && body.maxConcurrent > 0) value.maxConcurrent = body.maxConcurrent;
  if (typeof body.bossId === 'string' && body.bossId.trim()) value.bossId = body.bossId.trim();
  return { ok: true, value };
}

/**
 * DF-03 — validate + normalize a `/sprint/stop` body. `leaderId` + `department` ŞART
 * (kapsam kapısı /sprint ile aynı kararı verebilsin); `id` opsiyoneldir — verilmezse
 * renderer canlı run'ı, o da yoksa diskteki en yeni tamamlanmamış run'ı durdurur.
 */
function validateSprintStopPayload(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be a JSON object' };
  const leaderId = typeof body.leaderId === 'string' ? body.leaderId.trim() : '';
  const department = typeof body.department === 'string' ? body.department.trim() : '';
  if (!leaderId) return { ok: false, error: 'leaderId is required' };
  if (!department) return { ok: false, error: 'department is required' };
  const value = { leaderId, department };
  if (typeof body.id === 'string' && body.id.trim()) value.id = body.id.trim();
  if (typeof body.reason === 'string' && body.reason.trim()) value.reason = body.reason.trim().slice(0, 300);
  return { ok: true, value };
}

/**
 * TASK-MQSBV4EFQ8D6B — validate a /pane/recycle body. Required: `agentId` (the FINISHED
 * worker's roster agent id whose execution pane should be freed). The completion-signal
 * (TASK-MQSE75, same area) POSTs this when a worker is done so its pane is recycled — the
 * next delegation auto-places into a FRESH pane instead of writing into the finished
 * worker's stale conversation (the operator never closes a pane by hand). main only frees
 * EXECUTION panes for this agentId; the leader is structurally untouched (see main).
 */
function validateRecyclePayload(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be a JSON object' };
  const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
  if (!agentId) return { ok: false, error: 'agentId is required' };
  // ADP-266 — optional recycle MODE. 'reset' (default) clears the worker's conversation and
  // KEEPS the process; 'kill' is the old teardown. Additive + backward compatible: an older
  // client sends no mode and gets the better behavior.
  const raw = typeof body.mode === 'string' ? body.mode.trim() : '';
  if (raw && raw !== 'reset' && raw !== 'kill') return { ok: false, error: "mode must be 'reset' or 'kill'" };
  return { ok: true, value: { agentId, mode: raw || 'reset' } };
}

/**
 * ADP-303 — validate a /pane/close body. The leader identifies ITSELF (leaderId + department,
 * injected into its session env) and names a TARGET: paneId | agentId | exitedOnly | all.
 * The scope/self-protection DECISION is main-side (paneControl, unit-tested) — here we only
 * shape the payload and refuse an empty (targetless) request outright.
 */
function validatePaneClosePayload(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be a JSON object' };
  const filter = {};
  if (typeof body.paneId === 'string' && body.paneId.trim()) filter.paneId = body.paneId.trim();
  if (typeof body.agentId === 'string' && body.agentId.trim()) filter.agentId = body.agentId.trim();
  if (body.exitedOnly === true) filter.exitedOnly = true;
  if (body.all === true) filter.all = true;
  if (!filter.paneId && !filter.agentId && !filter.exitedOnly && !filter.all) {
    return { ok: false, error: 'a target is required: paneId, agentId, exitedOnly, or all' };
  }
  return {
    ok: true,
    value: {
      filter,
      leaderId: typeof body.leaderId === 'string' ? body.leaderId.trim() : '',
      department: typeof body.department === 'string' ? body.department.trim() : '',
      force: body.force === true,
    },
  };
}

/**
 * ADP-352 — bağımsız AgentShot'tan gelen "çekimi ajana gönder" gövdesi.
 * Required: `path` (AYNI diskteki mutlak .png yolu — bayt yüklemesi YOK, ADP-371'in
 * uploadId'sinin yerel karşılığı), `agentId`. Optional: `text` (prompt; kırpılır).
 * Dosyanın VARLIĞI burada değil main'de ölçülür (fs orada) — burada yalnız şekil.
 */
const SHOT_PROMPT_MAX_CHARS = 2000;
// TASK-MRZ9EAKX2LIJO — tek istekte taşınabilecek azami çekim (AgentShot'un
// MAX_SHOTS_PER_SEND tavanıyla aynı sayı; iki taraf da bağımsız reddeder).
const SHOT_MAX_PATHS = 10;
function validateShotPayload(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be a JSON object' };
  const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
  // TASK-MRZ9EAKX2LIJO — ÇOĞUL `paths` (yeni) VEYA tekil `path` (ADP-352 sözleşmesi,
  // menü-çubuğundaki "Son Çekimi Ajana Gönder" hâlâ bunu yollar). İkisi de aynı
  // normalize/uzantı kapısından geçer; çoğul yolda SIRA korunur.
  const raw = Array.isArray(body.paths)
    ? body.paths
    : (typeof body.path === 'string' ? [body.path] : []);
  const list = raw.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim());
  if (!list.length) return { ok: false, error: 'path is required' };
  if (list.length > SHOT_MAX_PATHS) return { ok: false, error: `at most ${SHOT_MAX_PATHS} paths` };
  for (const p of list) {
    if (!path.isAbsolute(p)) return { ok: false, error: 'path must be absolute' };
    if (!p.toLowerCase().endsWith('.png')) return { ok: false, error: 'path must be a .png screenshot' };
  }
  if (!agentId) return { ok: false, error: 'agentId is required' };
  const paths = list.map((p) => path.normalize(p));
  // `path` alanı KALIR: eski `onShotSend` imzasını (ve testlerini) bozmadan,
  // yeni çağıranlar `paths`i okur (tek çekimde ikisi de aynı dosyayı gösterir).
  const value = { path: paths[0], paths, agentId };
  if (typeof body.text === 'string' && body.text.trim()) {
    value.text = body.text.trim().slice(0, SHOT_PROMPT_MAX_CHARS);
  }
  return { ok: true, value };
}

/** BOARD-IMG-7 — tek çağrıda iliştirilebilecek görsel sayısı (bağlam/disk nöbeti). */
const ATTACH_MAX_PATHS = 8;

/**
 * BOARD-IMG-7 — `POST /task-attachment` gövdesi.
 *
 * `validateShotPayload`ın kardeşi ama İKİ FARKLA:
 *   · uzantı `.png`e KİLİTLİ DEĞİL — jpg/webp/gif de geçerli ek türleridir
 *     (nihai karar yine MAGIC BAYTLARDA: attachmentStore.sniffImage).
 *   · `agentId` yerine `taskId` — hedef bir pane değil, bir GÖREV SATIRI.
 * Uzantı burada yalnız UCUZ bir ön eleme; güvenlik kararı değildir.
 */
function validateTaskAttachmentPayload(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be a JSON object' };
  const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : '';
  if (!taskId) return { ok: false, error: 'taskId is required' };
  const raw = Array.isArray(body.attachments) ? body.attachments : [];
  if (!raw.length) return { ok: false, error: 'attachments[] is required' };
  if (raw.length > ATTACH_MAX_PATHS) return { ok: false, error: `at most ${ATTACH_MAX_PATHS} attachments` };
  const items = [];
  for (const it of raw) {
    const item = it && typeof it === 'object' ? it : {};
    const p = typeof item.path === 'string' ? item.path.trim() : '';
    if (!p) return { ok: false, error: 'each attachment needs a `path`' };
    if (!path.isAbsolute(p)) return { ok: false, error: `path must be absolute: ${p}` };
    const out = { path: path.normalize(p) };
    if (typeof item.title === 'string' && item.title.trim()) out.title = item.title.trim().slice(0, 200);
    if (typeof item.kind === 'string' && item.kind.trim()) out.kind = item.kind.trim();
    if (item.cover === true) out.cover = true;
    items.push(out);
  }
  const value = { taskId, attachments: items };
  if (typeof body.createdBy === 'string' && body.createdBy.trim()) value.createdBy = body.createdBy.trim().slice(0, 80);
  return { ok: true, value };
}

/**
 * Start the bridge.
 * @param {object} opts
 * @param {() => import('electron').BrowserWindow | null} opts.resolveWindow  the app window to IPC.
 * @param {(msg: string) => void} [opts.log]
 * @param {import('electron').IpcMain} opts.ipcMain
 * @param {(value:object)=>Promise<{ok:boolean, result?:any, error?:string}>} [opts.onBrowserAction]
 *        ADP-095 — main-side CDP executor; called after approval to drive the
 *        internal browser. Absent → /browser responds 501.
 * @param {(value:object)=>Promise<{url:string|null, elementInfo:object|null, found?:boolean}>} [opts.onBrowserProbe]
 *        ADP-341 — main-side RİSK PROBU: eylemin koşacağı guest'in GERÇEK adresi
 *        (guest.getURL()) + hedef elemanın CDP ile eylemden ÖNCE okunmuş bilgisi.
 *        Yoksa/hata verirse hedef bilinmez sayılır → kapı SORAR (güvenli varsayılan).
 * @param {object} [opts.browserGate]  ADP-341 — güven kapısı (test seam; varsayılan: paylaşılan tekil).
 * @param {() => string} [opts.resolveResultsDir]  TASK-MQTIYIIZE5VR7 (st2) — dir the
 *        /report fallback writes into; defaults to the crewpane `docs/agent-results`
 *        (matching src/lib/reports.ts). Injected for tests / packaged layout.
 * @param {(agentId:string)=>(number|Promise<number>)} [opts.onRecyclePane]  TASK-MQSBV4EFQ8D6B —
 *        main-side worker-pane recycler; frees a FINISHED worker's execution pane(s) by
 *        agentId (kill + forget) and returns how many were freed. Absent → /pane/recycle 501.
 * @param {() => Array} [opts.onListPanes]  ADP-303 — live panes (leader-facing shape).
 * @param {(payload:object)=>({ok:boolean, closed?:string[], denied?:object[], error?:string})} [opts.onClosePane]
 *        ADP-303 — close panes the way the × button does (kill + registry + resume-forget).
 *        Absent → /pane/close 501.
 * @param {(paneId:string)=>({ok:boolean, error?:string})} [opts.onFocusPane]  ADP-303 — bring a pane to the front.
 * @param {(req:{action:string, leaderId:string, targetScope:string})=>({ok:boolean, reason?:string, code?:string})} [opts.onAuthorizeScope]
 *        ADP-717 — TAKIM KAPSAMI KAPISI. `/delegate` + `/sprint` bunu çağırır; kararı
 *        main'deki teamScope.authorize verir — `/pane/close`'un kullandığı AYNI fonksiyon.
 *        Bu enjeksiyon olmadan (eski çağıranlar / testler) kapı AÇIK kalır: köprü bir
 *        transport katmanıdır, politikayı O tanımlamaz.
 * @param {() => Promise<Array>} [opts.onShotAgents]  ADP-352 — AgentShot köprüsü: prompt
 *        alabilecek ajanlar (ofis anlık görüntüsünden). Absent → /shot/agents 501.
 * @param {(value:{path:string, agentId:string, text?:string})=>Promise<object>} [opts.onShotSend]
 *        ADP-352 — bağımsız AgentShot'tan gelen çekimi bir ajanın pane'ine ilet. ADP-371'in
 *        attachmentPaths yolunu YENİDEN KULLANIR (yeni teslim mantığı YOK). Absent → /shot 501.
 * @param {(value:{path:string, taskId:string, title?:string, kind?:string, createdBy?:string})=>object} [opts.onTaskAttachment]
 *        BOARD-IMG-7 — GÖREV KARTI EKİ YUTAĞI. Task MCP ayrı bir Node sürecidir:
 *        satırı KENDİSİ yazabilir (zaten PostgREST'e yazıyor) ama küçük-resim
 *        ÜRETEMEZ (`nativeImage` Electron'a ait) ve hesap-kapsamlı depo kökünü
 *        bilmez. Bu rota o iki şeyi verir; INSERT çağıranda kalır. Absent → 501
 *        (araç "app kapalı" der — SESSİZCE thumb'sız satır YAZMAZ).
 * @param {() => Promise<{ok:boolean, token?:string, expiresAt?:number|null, userId?:string|null, reason?:string}>} [opts.onAppDbToken]
 *        ADP-622 — AJAN YOLU'nun kimliği: MCP child'ları (task MCP) app DB'ye ham REST
 *        yazıyor ve ANON key ile yazarsa satırlar KİMLİKSİZ kalır (ADP-623 izolasyonu
 *        kırılır). Onlar Electron değil → safeStorage'daki oturumu okuyamaz; TAZE jetonu
 *        bu rotadan (GET /app-db/token) alırlar. Absent → 501 (istemci anon'a düşer).
 * @param {(action:string)=>({reason:string, message?:string}|null)} [opts.onRequireSeat]
 *        ADP-646 — LİSANS KAPISI. `null` → izinli; bir nesne → REDDEDİLDİ (402 +
 *        sebep/mesaj). Enjekte EDİLMEZSE kapı yokmuş gibi davranılır (mevcut
 *        testler/e2e değişmez); main.js her zaman enjekte eder.
 * @param {(requested:number|undefined)=>number} [opts.onPlanWave]
 *        BL-01 — PAKET DALGA TAVANI. Sprint'i REDDETMEZ, dalgayı KISITLAR: liderin
 *        istediği (ya da hiç vermediği → varsayılan) worker sayısını alır, katmanın
 *        izin verdiği sayıyı döndürür ve kısıtlama olduysa kullanıcıya nudge'ı main
 *        gösterir. Bir paket limiti işi durdurmaz — daha az worker ile aynı iş koşar.
 *        Enjekte EDİLMEZSE tavan yok (köprü transport'tur, politikayı O tanımlamaz).
 * @param {(req:{agentId:string})=>Promise<{ok:boolean, pane:object, services:object[]}>} [opts.onIntegrationsStatus]
 *        BR-01 (ADR-INT-BRIDGE §2.1) — ENTEGRASYON KEŞFİ. Ajanın `crewpane_integrations`
 *        aracı bunu çağırır: hangi servisler bağlı, kullanıcının beyan ettiği izin kapsamı
 *        ne, anahtar en son ne zaman ÇALIŞTIĞI DOĞRULANDI. Cevabı main hesaplar (katalog +
 *        vault meta + resolver politikası); köprü sır TAŞIMAZ. Absent → 501 (eski
 *        çağıranlar/testler değişmez; araç "bu sürüm desteklemiyor" der).
 * @returns {Promise<{port:number, token:string, stop:()=>void, info:()=>({port:number,token:string})}>}
 */
/**
 * PH-01 — köprüden artırılabilen sayaç anahtarları. KAPALI KÜME.
 *
 * Bugün tek üye var (`tasks_created`): ayrı süreçte koşan görev-açma yolunun
 * main'deki musluğa ulaşabildiği tek anahtar. Liste burada durur ki yeni bir
 * anahtar eklemek bilinçli bir karar olsun — ucu "serbest sayaç yazma" hâline
 * getirmek, içerik taşımayan bu kanalı sessizce genişletirdi.
 */
const TELEMETRY_BUMP_KEYS = new Set(['tasks_created']);

/**
 * TC-01 — `/team/compose` gövde doğrulaması. SAF (birim testi için dışa açılır).
 *
 * Burada YALNIZ ŞEKİL denetlenir; POLİTİKA (rol süzgeci, tavan, jeton, kapsam)
 * main'dedir (`teamCompose.cjs` + `teamScope.cjs`). Köprü bir TRANSPORT katmanıdır —
 * `/delegate` ile aynı iş bölümü.
 */
function validateComposePayload(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'body must be an object' };
  const action = typeof raw.action === 'string' ? raw.action.trim().toLowerCase() : '';
  if (!['propose', 'apply', 'undo'].includes(action)) {
    return { ok: false, error: "action must be 'propose', 'apply' or 'undo'" };
  }
  const leaderId = typeof raw.leaderId === 'string' ? raw.leaderId.trim() : '';
  if (!leaderId) return { ok: false, error: 'leaderId is required' };
  const department = typeof raw.department === 'string' ? raw.department.trim() : '';
  if (!department) return { ok: false, error: 'department is required' };
  const value = {
    action,
    leaderId,
    department,
    source: raw.source === 'agentx' ? 'agentx' : 'leader',
  };
  if (action === 'propose') {
    const objective = typeof raw.objective === 'string' ? raw.objective.trim() : '';
    if (!objective) return { ok: false, error: 'objective is required for propose' };
    value.objective = objective;
    value.roles = Array.isArray(raw.roles) ? raw.roles.filter((r) => typeof r === 'string') : [];
    if (typeof raw.mode === 'string' && raw.mode.trim()) value.mode = raw.mode.trim();
    if (typeof raw.teamName === 'string' && raw.teamName.trim()) value.teamName = raw.teamName.trim();
    // TC-07 — mode:'engine': hedef motor + hangi çalışanlar (ajan kimlikleri). Yalnız
    // ŞEKİL: motorun sunulabilirliği ve kişilerin varlığı main/renderer'da ölçülür.
    // Verilmediyse alan HİÇ yok — eski gövde bit-bit aynı kalır.
    if (typeof raw.engine === 'string' && raw.engine.trim()) value.engine = raw.engine.trim().toLowerCase();
    if (Array.isArray(raw.agents)) {
      value.agents = raw.agents.filter((a) => typeof a === 'string' && a.trim()).map((a) => a.trim());
    }
  } else {
    const proposalId = typeof raw.proposalId === 'string' ? raw.proposalId.trim() : '';
    if (!proposalId) return { ok: false, error: `proposalId is required for ${action}` };
    value.proposalId = proposalId;
    if (action === 'apply' && typeof raw.approvalToken === 'string' && raw.approvalToken.trim()) {
      value.approvalToken = raw.approvalToken.trim();
    }
  }
  return { ok: true, value };
}

function startDelegationBridge({ resolveWindow, log = () => {}, ipcMain, onBrowserAction, onBrowserProbe, browserGate, resolveResultsDir, onRecyclePane, onListPanes, onClosePane, onFocusPane, onShotAgents, onShotSend, onTaskAttachment, onReportNotify, onAppDbToken, onRequireSeat, onPlanWave, onLeaderAck, onSupervisorStatus, onAuthorizeScope, onIntegrationsStatus, resolveAgentRecord, onTelemetryBump, onDictation, onTeamCompose }) {
  const token = mintToken();
  // ENG-11 — alt-delegasyon kapısının SUNUCU TARAFI gerçeği. Enjekte edilmezse canlı
  // pane defteri okunur (main tarafında zaten o defter yazılıyor); enjeksiyon yalnız
  // testler ve ileride farklı bir kayıt kaynağı içindir.
  const resolveDelegateAgent =
    typeof resolveAgentRecord === 'function' ? resolveAgentRecord : (agentId) => paneRecordForAgent(agentId);
  // Pending main→renderer round-trips, keyed by requestId.
  const pending = new Map();

  // One result listener for delegate + status + browser-approval; by requestId.
  const onResult = (_event, res) => {
    if (!res || typeof res.requestId !== 'string') return;
    const entry = pending.get(res.requestId);
    if (!entry) return;
    pending.delete(res.requestId);
    clearTimeout(entry.timer);
    entry.resolve(res);
  };
  ipcMain.on('delegation:start:result', onResult);
  ipcMain.on('delegation:status:result', onResult);
  ipcMain.on('browser:approval:result', onResult); // ADP-095
  ipcMain.on('sprint:start:result', onResult); // ADP-242
  ipcMain.on('sprint:status:result', onResult); // ADP-242
  ipcMain.on('sprint:stop:result', onResult); // DF-03
  // TC-01 — takım kurucu turları (propose satırları · apply kurulumu · undo silmesi).
  // Üçü de AYNI correlation defterini kullanır (requestId) — ayrı bir mekanizma YOK.
  ipcMain.on('team-compose:propose:result', onResult);
  ipcMain.on('team-compose:apply:result', onResult);
  ipcMain.on('team-compose:undo:result', onResult);

  /**
   * ADP-717 — takım kapsamı kapısı. Kararı MAIN verir (`onAuthorizeScope` →
   * teamScope.authorize); köprü yalnız taşır. Enjeksiyon yoksa AÇIK: bu dosya bir
   * transport katmanıdır, politika burada tanımlanmaz (ve eski testler/çağıranlar
   * davranış değiştirmez).
   */
  // ADP-737 — karar ASENKRON olabilir: `cross-team` reddinde main sahibe onay kartı
  // çıkarır ve cevabı bekler. Köprü yalnız bekler (politika hâlâ main'de).
  async function authorizeScope(action, leaderId, targetScope) {
    if (typeof onAuthorizeScope !== 'function') return { ok: true };
    try {
      const res = await onAuthorizeScope({ action, leaderId, targetScope });
      return res && typeof res === 'object' ? res : { ok: true };
    } catch (err) {
      // Karar veremiyorsak İŞİ DURDURMA (kullanıcıyı bir hata yüzünden çalışamaz
      // hâle getirmek, bu değişikliğin amacı değil) — ama sebebi log'a düş.
      log(`kapsam kararı verilemedi (${action}): ${String((err && err.message) || err)}`);
      return { ok: true };
    }
  }

  /** Send an IPC request to the renderer and await its correlated result. */
  function callRenderer(channel, payload, timeoutMs = IPC_TIMEOUT_MS) {
    const win = resolveWindow();
    if (!win || win.isDestroyed()) return Promise.reject(new Error('no app window'));
    const requestId = crypto.randomBytes(12).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('renderer timeout'));
      }, timeoutMs);
      pending.set(requestId, { resolve, timer });
      win.webContents.send(channel, { requestId, ...payload });
    });
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error('payload too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function send(res, status, obj) {
    const json = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
    res.end(json);
  }

  const server = http.createServer(async (req, res) => {
    try {
      // AUTH first — every route requires the bearer token.
      if (!checkToken(req.headers['authorization'] || req.headers['x-crewpane-token'], token)) {
        send(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      // ADP-286 — cross-instance kemer+askı: istemci kendi CREWPANE_INSTANCE'ını header'la
      // beyan eder; uyuşmuyorsa 403 (token doğru olsa bile — yanlış handshake'ten alınmış
      // demektir). Header'sız istemci (eski MCP build'i) legacy-uyumla kabul edilir; asıl
      // yapısal kapı istemci-taraflı aday reddi (crewpane-delegate-mcp.cjs discovery).
      const claimedInstance = req.headers['x-crewpane-instance'];
      if (claimedInstance && String(claimedInstance) !== instancePaths.instanceId()) {
        send(res, 403, {
          ok: false,
          error: `cross-instance rejected: bridge=${instancePaths.instanceId()}, client=${String(claimedInstance)}`,
        });
        return;
      }
      const url = new URL(req.url, 'http://127.0.0.1');

      if (req.method === 'POST' && url.pathname === '/delegate') {
        // ADP-646 — lisans kapısı: paketsiz kullanıcıda delegasyon renderer'a hiç
        // gitmez. 402 Payment Required = sebebi kendi anlatan durum kodu.
        const seatDenied = typeof onRequireSeat === 'function' ? onRequireSeat('bridge:/delegate') : null;
        if (seatDenied) {
          log(`delegate REDDEDİLDİ (lisans: ${seatDenied.reason})`);
          send(res, 402, {
            ok: false,
            reason: seatDenied.reason,
            error: seatDenied.message || 'CrewPane paketi gerekli.',
          });
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse((await readBody(req)) || '{}');
        } catch {
          send(res, 400, { ok: false, error: 'invalid JSON' });
          return;
        }
        const v = validateDelegatePayload(parsed);
        if (!v.ok) {
          send(res, 400, { ok: false, error: v.error });
          return;
        }
        // ENG-11 (ENG-R3 §8.2) — ALT-DELEGASYON KAPISI. MCP kaydının `--strict`
        // katmanı codex'te ve CLI köprüsünde YOKTUR; sert katman burada.
        const authz = authorizeDelegateCaller({
          headers: req.headers,
          leaderId: v.value.leaderId,
          resolveAgent: resolveDelegateAgent,
        });
        if (!authz.ok) {
          log(`delegate REDDEDİLDİ (yetki): ${authz.reason} [${authz.code}]`);
          send(res, 403, { ok: false, code: authz.code, error: authz.reason });
          return;
        }
        if (!authz.verified) {
          // Kimlik beyan edilmedi ve defterde de yok: geçiş VAR ama iz de var.
          log(`delegate kimliği DOĞRULANAMADI (beyan yok): leader=${v.value.leaderId} — geçişe izin verildi`);
        }
        // ADP-717 — TAKIM KAPSAMI. Buraya kadar HİÇBİR kapsam kontrolü yoktu: bir lider
        // başka takımın ajanlarına iş verebiliyor ama sonra onların pane'ini kapatamıyordu
        // (`/pane/close` kapsamı zorluyordu). Artık iki yol AYNI karardan geçer.
        const scoped = await authorizeScope('delegate', v.value.leaderId, v.value.department);
        if (!scoped.ok) {
          log(`delegate REDDEDİLDİ (kapsam): leader=${v.value.leaderId} target=${v.value.department} code=${scoped.code}`);
          send(res, 403, { ok: false, code: scoped.code, error: scoped.reason });
          return;
        }
        try {
          const result = await callRenderer('delegation:start', v.value);
          // ADP-289 — KUYRUK bir hata değil: hedef ajan uçuşta, iş sıraya alındı ve o
          // görev bitince otomatik başlayacak. Eskiden bu da 502 "no pty bridge" olarak
          // dönüyordu (lider köprüyü/pty'yi bozuk sanıp saatlerce yanlış yere baktı).
          if (!result.ok && result.queued) {
            const msg = result.error || 'hedef ajan meşgul — iş kuyruğa alındı';
            log(`delegate → queued (${msg})`);
            // `error` alanı da BİLE BİLE doldurulur: 200-dışını hata sayan eski istemciler
            // (MCP delegate aracı) yine de GERÇEK sebebi yazsın — asla "no pty bridge" değil.
            send(res, 202, { ok: true, queued: true, message: msg, error: msg });
            return;
          }
          if (!result.ok) {
            send(res, 502, { ok: false, error: result.error || 'delegation failed' });
            return;
          }
          log(`delegate → delegationId=${result.delegationId} dept=${v.value.department} leader=${v.value.leaderId}`);
          // TC-03 — rol boşluğu ipucu (ADR §9.3, 3. giriş noktası). Renderer yalnız
          // GERÇEK bir boşlukta ve oturumda BİR KEZ doldurur; alan yoksa gövde birebir
          // bugünkü {ok, delegationId} şeklinde kalır (eski MCP istemcileri etkilenmez).
          const body = { ok: true, delegationId: result.delegationId };
          if (typeof result.roleGapHint === 'string' && result.roleGapHint.trim()) {
            body.roleGapHint = result.roleGapHint.trim();
            log(`delegate → rol boşluğu ipucu eklendi (dept=${v.value.department})`);
          }
          send(res, 200, body);
        } catch (err) {
          send(res, 504, { ok: false, error: String(err.message || err) });
        }
        return;
      }

      // TASK-MQTIYIIZE5VR7 (st2) — runtime-fallback REPORT write. A finishing worker
      // (or completion-signal) POSTs { taskId, role?, agentName?, status?, summary? }
      // to guarantee `docs/agent-results/<task>-<role>.md` exists so the Raporlar tab
      // surfaces it. Written server-side (correct repo dir regardless of worker cwd);
      // never clobbers an existing worker-written report unless `force:true`.
      if (req.method === 'POST' && url.pathname === '/report') {
        let parsed;
        try {
          parsed = JSON.parse((await readBody(req)) || '{}');
        } catch {
          send(res, 400, { ok: false, error: 'invalid JSON' });
          return;
        }
        const v = validateReportPayload(parsed);
        if (!v.ok) {
          send(res, 400, { ok: false, error: v.error });
          return;
        }
        const dir = typeof resolveResultsDir === 'function' ? resolveResultsDir() : defaultResultsDir();
        const result = writeReportFile(v.value, dir);
        if (!result.ok) {
          send(res, 500, { ok: false, error: result.error || 'report write failed' });
          return;
        }
        log(
          `report ${result.skipped ? 'kept (exists)' : 'written'} → ${result.filename} ` +
            `task=${v.value.taskId} agent=${v.value.agentName || v.value.role || '?'}`,
        );
        // ADP-538 — /report'a düşen tamamlanma da notify-log'a yazılır (kemer+askı:
        // renderer follow-loop'u kaçırsa bile worker'ın completion-signal POST'u liderin
        // Monitor'unu tetikler). Best-effort — notify hatası /report'u kırmaz.
        if (typeof onReportNotify === 'function' && !result.skipped) {
          try {
            onReportNotify({
              kind: (v.value.status || '').toLowerCase() === 'fail' ? 'fail' : 'done',
              task: v.value.taskId,
              detail: result.filename,
            });
          } catch { /* best-effort */ }
        }
        send(res, 200, { ok: true, filename: result.filename, skipped: result.skipped === true });
        return;
      }

      // TASK-MQSBV4EFQ8D6B — free a FINISHED worker's execution pane so the next
      // delegation auto-places into a fresh pane (no manual close). The worker's
      // completion-signal POSTs { agentId } here on done/fail; main recycles ONLY that
      // agent's EXECUTION panes (the leader, spawned without the execution flag, is never
      // touched). Idempotent: recycling an already-gone pane returns recycled:0.
      if (req.method === 'POST' && url.pathname === '/pane/recycle') {
        if (typeof onRecyclePane !== 'function') {
          send(res, 501, { ok: false, error: 'pane recycle not available' });
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse((await readBody(req)) || '{}');
        } catch {
          send(res, 400, { ok: false, error: 'invalid JSON' });
          return;
        }
        const v = validateRecyclePayload(parsed);
        if (!v.ok) {
          send(res, 400, { ok: false, error: v.error });
          return;
        }
        let recycled;
        try {
          recycled = (await onRecyclePane(v.value.agentId, v.value.mode)) || 0;
        } catch (err) {
          send(res, 500, { ok: false, error: String((err && err.message) || err) });
          return;
        }
        log(`pane recycle → agent=${v.value.agentId} mode=${v.value.mode} freed=${recycled}`);
        send(res, 200, { ok: true, recycled, mode: v.value.mode });
        return;
      }

      // ADP-303 — LİDER PANE KONTROLÜ. Optimus'un eksik yeteneği: pane açabiliyor ama
      // kapatamıyordu (tek yol elle pty kill → EPIPE çökmesi + zombi pane). Bu üç rota
      // X butonunun yaptığının AYNISINI yapar; yetki (departman kapsamı + kendi pane'ini
      // kapatamama) main'deki paneControl'de karara bağlanır.
      if (req.method === 'GET' && url.pathname === '/panes') {
        if (typeof onListPanes !== 'function') {
          send(res, 501, { ok: false, error: 'pane control not available' });
          return;
        }
        // ADP-717 — süzme SUNUCU tarafında. Eskiden liste HER pane'i döndürüyor, süzmeyi
        // MCP istemcisi yapıyordu (crewpane-delegate-mcp.cjs) — yani kapsam istemciye
        // emanetti. `leader` + `department` sorgu parametreleri istemcinin KİM olduğunu
        // söyler; asıl kapsam yine main'de (liderin canlı pane kaydından) çözülür.
        const panes = (await onListPanes({
          leaderId: url.searchParams.get('leader') || '',
          department: url.searchParams.get('department') || '',
        })) || [];
        send(res, 200, { ok: true, panes });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/pane/close') {
        if (typeof onClosePane !== 'function') {
          send(res, 501, { ok: false, error: 'pane control not available' });
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse((await readBody(req)) || '{}');
        } catch {
          send(res, 400, { ok: false, error: 'invalid JSON' });
          return;
        }
        const v = validatePaneClosePayload(parsed);
        if (!v.ok) {
          send(res, 400, { ok: false, error: v.error });
          return;
        }
        // SEC-01 — ÇAĞIRAN KİMLİĞİ: `/delegate`'in kullandığı AYNI fonksiyon, AYNI
        // cevap şekli (403 + code + error). Pane BAŞINA kapsam reddi aşağıda `denied`
        // listesinde kalır — bu kapı ÇAĞIRANI reddeder, tek tek pane'i değil; delege
        // ucunda da öyle. Bu satır olmadan bir worker pane'i, kendisine YASAK olan işi
        // (başka takımın pane'ini yönetmek) köprüden serbestçe yapabiliyordu.
        const closeAuthz = authorizeDelegateCaller({
          headers: req.headers,
          leaderId: v.value.leaderId,
          resolveAgent: resolveDelegateAgent,
        });
        if (!closeAuthz.ok) {
          log(`pane close REDDEDİLDİ (yetki): ${closeAuthz.reason} [${closeAuthz.code}]`);
          send(res, 403, { ok: false, code: closeAuthz.code, error: closeAuthz.reason });
          return;
        }
        if (!closeAuthz.verified) {
          // Delege ucuyla aynı iz: geçiş VAR ama sessiz DEĞİL.
          log(`pane close kimliği DOĞRULANAMADI (beyan yok): leader=${v.value.leaderId || '-'}`);
        }
        let result;
        try {
          result = await onClosePane(v.value);
        } catch (err) {
          send(res, 500, { ok: false, error: String((err && err.message) || err) });
          return;
        }
        if (!result || result.ok !== true) {
          send(res, 400, { ok: false, error: (result && result.error) || 'close failed' });
          return;
        }
        log(
          `pane close → by=${v.value.leaderId || '-'} filter=${JSON.stringify(v.value.filter)} ` +
            `closed=${(result.closed || []).length} denied=${(result.denied || []).length}`,
        );
        send(res, 200, { ok: true, closed: result.closed || [], denied: result.denied || [] });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/pane/focus') {
        if (typeof onFocusPane !== 'function') {
          send(res, 501, { ok: false, error: 'pane control not available' });
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse((await readBody(req)) || '{}');
        } catch {
          send(res, 400, { ok: false, error: 'invalid JSON' });
          return;
        }
        const paneId = typeof parsed.paneId === 'string' ? parsed.paneId.trim() : '';
        if (!paneId) {
          send(res, 400, { ok: false, error: 'paneId is required' });
          return;
        }
        // ADP-717 — odaklama da bir YÖNETİM eylemidir: aynı kapı. (Kapsam kararını
        // main verir; paneId → o pane'in takımı orada çözülür.)
        const result = await onFocusPane(paneId, {
          leaderId: typeof parsed.leaderId === 'string' ? parsed.leaderId.trim() : '',
          department: typeof parsed.department === 'string' ? parsed.department.trim() : '',
        });
        if (!result || result.ok !== true) {
          send(res, result && result.code === 'cross-team' ? 403 : 400, {
            ok: false,
            code: result && result.code,
            error: (result && result.error) || 'focus failed',
          });
          return;
        }
        send(res, 200, { ok: true, paneId });
        return;
      }

      // VOICE-TRUNC-02 — AgentVoice DİKTE TESLİMİ. Metin köprüden TEK parça gelir;
      // main odaklı yüzeye (okunabilir kutu / xterm) `webContents.insertText` ile
      // indirir (dictationDelivery.cjs — metin en fazla BİR KEZ, Enter HİÇ).
      // VOICE-TRUNC-01'in kayıplı CGEvent salvosunun yapısal ölümü. Log'a içerik
      // DEĞİL yalnız ölçü düşer (AgentVoice'un kendi TRACE ilkesiyle aynı).
      if (req.method === 'POST' && url.pathname === '/dictation') {
        if (typeof onDictation !== 'function') {
          send(res, 501, { ok: false, error: 'dictation delivery not available' });
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse((await readBody(req)) || '{}');
        } catch {
          send(res, 400, { ok: false, error: 'invalid JSON' });
          return;
        }
        const v = validateDictationPayload(parsed);
        if (!v.ok) {
          send(res, 400, { ok: false, error: v.error });
          return;
        }
        try {
          const result = await onDictation(v.text);
          if (!result || result.ok !== true) {
            // 409 = odaklı dikte yüzeyi yok (AgentVoice pano-fallback'ine geçer).
            send(res, result && result.code === 'no-focus' ? 409 : 502, {
              ok: false,
              code: (result && result.code) || undefined,
              error: (result && result.error) || 'dictation delivery failed',
            });
            return;
          }
          log(`dictation → ${result.surface} chars=${v.text.length} verified=${result.verified === true}`);
          send(res, 200, { ok: true, surface: result.surface, verified: result.verified === true });
        } catch (err) {
          send(res, 502, { ok: false, error: String((err && err.message) || err) });
        }
        return;
      }

      // TC-01 — TAKIM KURUCU (ADR-TEAM-COMPOSER §4). Sözleşme:
      // docs/design/TEAM-COMPOSER-R1/IPC-CONTRACT.md
      //
      // Köprü burada da yalnız TAŞIR: kapsam kararı `/delegate` ile AYNI kapıdan
      // (authorizeScope) geçer, geri kalan politika (rol süzgeci, tavanlar, onay
      // jetonu, geri alma günlüğü) main'in `onTeamCompose`'undadır. `callRenderer`
      // main'e AÇIKÇA verilir — ikinci bir IPC correlation defteri doğmasın.
      if (req.method === 'POST' && url.pathname === '/team/compose') {
        if (typeof onTeamCompose !== 'function') {
          send(res, 501, { ok: false, error: 'team compose not available' });
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse((await readBody(req)) || '{}');
        } catch {
          send(res, 400, { ok: false, error: 'invalid JSON' });
          return;
        }
        const v = validateComposePayload(parsed);
        if (!v.ok) {
          send(res, 400, { ok: false, error: v.error });
          return;
        }
        // ADP-717 — KAPSAM: çalışan eklemek bir YÖNETİM eylemidir ve delegate ile
        // AYNI karardan geçer. `force` takım sınırını burada da aşmaz.
        const scoped = await authorizeScope('manage', v.value.leaderId, v.value.department);
        if (!scoped.ok) {
          log(`team compose REDDEDİLDİ (kapsam): leader=${v.value.leaderId} target=${v.value.department} code=${scoped.code}`);
          send(res, 403, { ok: false, code: scoped.code, error: scoped.reason });
          return;
        }
        let out;
        try {
          out = await onTeamCompose(v.value, { callRenderer });
        } catch (err) {
          send(res, 500, { ok: false, error: String((err && err.message) || err) });
          return;
        }
        const status = out && Number.isFinite(out.status) ? out.status : 500;
        const body = (out && out.body) || { ok: false, error: 'team compose failed' };
        log(`team compose ${v.value.action} → ${status} leader=${v.value.leaderId} dept=${v.value.department}`);
        send(res, status, body);
        return;
      }

      // ADP-242 — uzun-sprint başlat: plan renderer orkestratörüne iner
      // (sprint:start IPC → sprintRunner.startSprint). Semantik plan hatası
      // (döngü / kanıt-yolu yok) renderer'dan mesajıyla döner — lider düzeltir.
      if (req.method === 'POST' && url.pathname === '/sprint') {
        let parsed;
        try {
          parsed = JSON.parse((await readBody(req)) || '{}');
        } catch {
          send(res, 400, { ok: false, error: 'invalid JSON' });
          return;
        }
        const v = validateSprintPayload(parsed);
        if (!v.ok) {
          send(res, 400, { ok: false, error: v.error });
          return;
        }
        // ADP-717 — sprint de İŞ BAŞLATIR (n tane delegasyon): aynı kapı, aynı karar.
        const sprintScoped = await authorizeScope('delegate', v.value.leaderId, v.value.department);
        if (!sprintScoped.ok) {
          log(`sprint REDDEDİLDİ (kapsam): leader=${v.value.leaderId} target=${v.value.department} code=${sprintScoped.code}`);
          send(res, 403, { ok: false, code: sprintScoped.code, error: sprintScoped.reason });
          return;
        }
        // BL-01 — PAKET DALGA TAVANI. Kapsam kapısından SONRA, plan renderer'a
        // inmeden önce: dalga genişliği burada KESİNLEŞİR (renderer'ın varsayılanı
        // devreye girmez, çünkü değer artık açıkça yazılıdır). Sprint reddedilmez.
        if (typeof onPlanWave === 'function') {
          try {
            const capped = onPlanWave(v.value.maxConcurrent);
            if (Number.isInteger(capped) && capped > 0 && capped !== v.value.maxConcurrent) {
              log(`sprint dalgası plan tavanına kısıtlandı: ${v.value.maxConcurrent ?? '(varsayılan)'} → ${capped}`);
              v.value.maxConcurrent = capped;
            }
          } catch (err) {
            // Tavan hesaplanamıyorsa sprint DURMAZ (fail-open: ADP-660 KURAL 2 duruşu).
            log(`sprint dalga tavanı hesaplanamadı (${err.message}) — istenen değerle devam`);
          }
        }
        try {
          const result = await callRenderer('sprint:start', v.value);
          if (!result.ok) {
            send(res, 502, { ok: false, error: result.error || 'sprint start failed' });
            return;
          }
          log(`sprint → sprintId=${result.sprintId} dept=${v.value.department} tasks=${v.value.tasks.length}`);
          send(res, 200, { ok: true, sprintId: result.sprintId });
        } catch (err) {
          send(res, 504, { ok: false, error: String(err.message || err) });
        }
        return;
      }

      // DF-03 — SPRINT'İ DURDUR/BİTİR. "Tek aktif sprint" kısıtı + takılı run =
      // sistem kilidi: takılan sprint yüzünden her yeni /sprint çağrısı 502 alıyordu
      // ve kilidi açmanın tek yolu app kapalıyken run JSON'unu elle patch'lemekti.
      // Kapsam kapısı /sprint ile AYNI (iş verebildiğin takımın işini durdurabilirsin).
      if (req.method === 'POST' && url.pathname === '/sprint/stop') {
        let parsed;
        try {
          parsed = JSON.parse((await readBody(req)) || '{}');
        } catch {
          send(res, 400, { ok: false, error: 'invalid JSON' });
          return;
        }
        const v = validateSprintStopPayload(parsed);
        if (!v.ok) {
          send(res, 400, { ok: false, error: v.error });
          return;
        }
        const stopScoped = await authorizeScope('delegate', v.value.leaderId, v.value.department);
        if (!stopScoped.ok) {
          log(`sprint stop REDDEDİLDİ (kapsam): leader=${v.value.leaderId} target=${v.value.department} code=${stopScoped.code}`);
          send(res, 403, { ok: false, code: stopScoped.code, error: stopScoped.reason });
          return;
        }
        try {
          const result = await callRenderer('sprint:stop', v.value);
          if (!result.ok) {
            send(res, 502, { ok: false, error: result.error || 'sprint stop failed' });
            return;
          }
          log(`sprint DURDURULDU → ${result.sprintId} (canlı=${result.wasLive === true})`);
          send(res, 200, { ok: true, sprintId: result.sprintId, summary: result.summary, wasLive: result.wasLive === true });
        } catch (err) {
          send(res, 504, { ok: false, error: String(err.message || err) });
        }
        return;
      }

      if (req.method === 'GET' && url.pathname === '/sprint/status') {
        const id = url.searchParams.get('id') || undefined;
        try {
          const result = await callRenderer('sprint:status', { id });
          send(res, 200, { ok: true, status: result.status ?? null });
        } catch (err) {
          send(res, 504, { ok: false, error: String(err.message || err) });
        }
        return;
      }

      if (req.method === 'GET' && url.pathname === '/delegation/status') {
        const id = url.searchParams.get('id') || undefined;
        // ADP-659 — liderin status okuması = ACK. Supervisor'ın uyandırma tekrarları
        // burada durur (lider zaten bilgilendi); best-effort, status'u asla düşürmez.
        const leader = url.searchParams.get('leader');
        if (leader && typeof onLeaderAck === 'function') {
          try { onLeaderAck(leader); } catch { /* ack best-effort */ }
        }
        // ADP-672 — MAIN'in KALICI defteri. Renderer'dan ÖNCE okunur ve renderer
        // cevap veremese bile döner: canlı vakada lider "stark:working" okumaya devam
        // etti çünkü tek kaynak renderer motoruydu ve orada hiçbir şey settle olmuyordu.
        // Bu alan supervisor'ın GÖRDÜĞÜ hâli taşır (sessiz worker, kanıt, izlenmeyen pane).
        let supervisor = null;
        if (typeof onSupervisorStatus === 'function') {
          try { supervisor = onSupervisorStatus(leader || ''); } catch { supervisor = null; }
        }
        try {
          const result = await callRenderer('delegation:status', { id });
          // TASK-MQQ2I4FBV9R2 — clean the worker output + surface apiError so the leader reads
          // an accurate, readable status (no raw ANSI, no false 'failed' for an API hiccup).
          send(res, 200, { ok: true, snapshot: enrichDelegationSnapshot(result.snapshot ?? null), supervisor });
        } catch (err) {
          // Renderer yoksa/ölüyse bile lider GERÇEĞİ okuyabilmeli (eskiden 504 = kör nokta).
          if (supervisor) send(res, 200, { ok: true, snapshot: null, supervisor, rendererError: String(err.message || err) });
          else send(res, 504, { ok: false, error: String(err.message || err) });
        }
        return;
      }

      // ADP-095 — headed browser automation (CDP). Actual CDP runs in main
      // (onBrowserAction → browserCdp).
      //
      // ADP-341 (ADR-026) — RİSK KAPISI. Eskiden karar tek satırdı ("click/type → her
      // zaman sor"), bağlamdan habersizdi: kendi localhost test sunucunda bile her tık
      // bir kart çıkarıyordu (izin yorgunluğu → kullanıcı ya işi bırakır ya körlemesine
      // onaylar). Artık karar = ORIGIN güveni × HEDEF hassasiyeti × EYLEM sınıfı × mod:
      //   • origin MAIN'den gelir (guest.getURL()) — ajanın payload'ından DEĞİL,
      //   • hedef eleman CDP ile EYLEMDEN ÖNCE ölçülür (parola alanı? "Öde" butonu?),
      //   • hassas hedef güvenden BAĞIMSIZ her zaman sorar (localhost'ta bile),
      //   • prob başarısız → SOR (güvenli varsayılan; "okuyamadım = serbest" yok).
      if (req.method === 'POST' && url.pathname === '/browser') {
        if (typeof onBrowserAction !== 'function') {
          send(res, 501, { ok: false, error: 'browser control not available' });
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse((await readBody(req)) || '{}');
        } catch {
          send(res, 400, { ok: false, error: 'invalid JSON' });
          return;
        }
        const v = validateBrowserPayload(parsed);
        if (!v.ok) {
          send(res, 400, { ok: false, error: v.error });
          return;
        }
        const value = v.value;
        // ADR-020 — mobil tetikli otomasyon HER ZAMAN sıkı moddadır ve oturum izni alamaz.
        // (Ajanın `source` uydurması yalnız kendi aleyhine çalışır: 'mobile' = daha kısıtlı.)
        const source = parsed && parsed.source === 'mobile' ? 'mobile' : 'agent';
        const gate = browserGate || getBrowserGate();
        const mutating = value.action === 'click' || value.action === 'type';

        // 1) Bağlam ölçümü (main) — okuma eylemlerinde gereksiz: okuma sayfayı değiştirmez.
        let probe = { url: null, elementInfo: null };
        if (mutating && typeof onBrowserProbe === 'function') {
          try {
            probe = (await onBrowserProbe(value)) || {};
          } catch (err) {
            // Prob koşamadı → hedef BİLİNMİYOR. Karar katmanı bunu "sor"a çevirir.
            probe = { url: null, elementInfo: null, probeError: String(err.message || err) };
            log(`browser prob hatası (${value.action}): ${probe.probeError}`);
          }
          if (probe.found === false) {
            // Eleman sayfada YOK → tıklanacak/yazılacak bir şey yok: risk de yok, kart da.
            // Kullanıcıyı anlamsız bir onaya zorlamak yerine dürüst hata döndür.
            gate.audit({
              agentId: value.agentId,
              delegationId: value.delegationId,
              origin: probe.url,
              action: value.action,
              selector: value.selector,
              text: value.text,
              decision: 'error',
              reason: 'hedef eleman sayfada yok',
              source,
              ok: false,
            });
            send(res, 200, { ok: false, error: `selector not found: ${value.selector}` });
            return;
          }
        }

        // 2) Karar — deterministik, main'de. Sayfanın metni güveni YÜKSELTEMEZ.
        const d = gate.decide(value, probe, source);
        const auditBase = {
          agentId: value.agentId,
          delegationId: value.delegationId,
          origin: d.origin,
          action: value.action,
          selector: value.selector,
          text: value.text,
          sensitive: d.sensitive,
          level: d.level,
          mode: d.mode,
          source,
        };

        if (d.decision === 'deny') {
          gate.audit({ ...auditBase, decision: 'deny', reason: d.reason, ok: false });
          log(`browser ${value.action} YASAK (agent=${value.agentId || '?'} — ${d.reason})`);
          send(res, 200, { ok: false, denied: true, error: `yasak: ${d.reason}` });
          return;
        }

        if (d.decision === 'ask' || d.decision === 'ask-session') {
          const epoch = gate.epoch(); // DURDUR'a basılırsa bu değişir → gelen izin geçersiz
          let appr;
          try {
            appr = await callRenderer(
              'browser:approval',
              {
                action: value.action,
                selector: value.selector,
                // Sır ASLA karta ham düşmez: hassas metin `•••(n)` olarak gösterilir.
                text: gate.preview(value.text, d.sensitive),
                agentId: value.agentId,
                origin: d.origin,
                risk: { level: d.level, reason: d.reason, sensitive: d.sensitive },
                scope: d.scope || 'once', // 'session' → kart "bu görev boyunca izin ver" sunar (ADP-335)
              },
              BROWSER_APPROVAL_TIMEOUT_MS,
            );
          } catch (err) {
            gate.audit({ ...auditBase, decision: 'ask-timeout', reason: String(err.message || err), ok: false });
            send(res, 504, { ok: false, error: 'approval round-trip failed: ' + String(err.message || err) });
            return;
          }
          if (gate.epoch() !== epoch) {
            // Kullanıcı beklerken DURDUR'a bastı: geç gelen "izin ver" YOK sayılır.
            gate.audit({ ...auditBase, decision: 'deny-stopped', reason: 'DURDUR ile kesildi', ok: false });
            send(res, 200, { ok: false, denied: true, error: 'otomasyon DURDUR ile kesildi' });
            return;
          }
          if (!appr || !appr.approved) {
            // Ret de bir karardır: görev-başı kart reddedildiyse o origin bu görev boyunca
            // bir daha SORULMAZ (tekrar tekrar kart çıkararak yıldırmak da izin yorgunluğudur).
            if (d.decision === 'ask-session' && d.origin) gate.denySession(d.key, d.origin);
            gate.audit({ ...auditBase, decision: 'deny-user', reason: 'kullanıcı reddetti', ok: false });
            log(`browser ${value.action} REDDEDİLDİ (agent=${value.agentId || '?'} selector=${value.selector || ''})`);
            send(res, 200, { ok: false, denied: true, error: 'user denied the action' });
            return;
          }
          // "Bu görev boyunca izin ver" → oturum izni: TTL + eylem tavanı, diske YAZILMAZ.
          if (appr.scope === 'session' && d.decision === 'ask-session' && d.origin) {
            gate.grantSession(d.key, d.origin);
          }
          log(`browser ${value.action} ONAYLANDI (agent=${value.agentId || '?'} ${d.origin || ''} — ${d.reason})`);
        }

        if (mutating) gate.consume(d.key, d.origin); // oturum izni bütçesinden düş (izin yoksa no-op)

        try {
          const result = await onBrowserAction(value);
          if (!result || !result.ok) {
            gate.audit({ ...auditBase, decision: d.decision, reason: d.reason, ok: false });
            send(res, 502, { ok: false, error: (result && result.error) || 'browser action failed' });
            return;
          }
          // ADR-026 §4 — audit ONAYSIZ KOŞANLARI DA yazar (gözetim, onayın yerine geçer).
          gate.audit({ ...auditBase, decision: d.decision, reason: d.reason, ok: true });
          log(`browser ${value.action} OK (agent=${value.agentId || '?'} ${d.decision})`);
          send(res, 200, { ok: true, result: result.result ?? null });
        } catch (err) {
          gate.audit({ ...auditBase, decision: d.decision, reason: String(err.message || err), ok: false });
          send(res, 502, { ok: false, error: String(err.message || err) });
        }
        return;
      }

      // ADP-352 (ADR-024 §5-c) — BAĞIMSIZ AGENTSHOT KÖPRÜSÜ. AgentShot ücretsiz üründür
      // ve AI analizi YOKTUR; CrewPane kuruluysa çekim buradan kullanıcının KENDİ
      // ajanına düşer → analiz onun kendi claude CLI aboneliğinde koşar (COGS $0).
      // Teslim mantığı YENİDEN YAZILMAZ: onShotSend, ADP-371'in attachmentPaths yolunu
      // (mobileCommandRenderer → cmdPrompt → withAttachments → sendCommandToAgent) çağırır.
      if (req.method === 'GET' && url.pathname === '/shot/agents') {
        if (typeof onShotAgents !== 'function') {
          send(res, 501, { ok: false, error: 'shot bridge not available' });
          return;
        }
        try {
          // TASK-MRZ9EAKX2LIJO — YETENEK BİLDİRİMİ: bu köprü `paths` dizisini
          // (toplu gönderim) biliyor. AgentShot bunu ÖLÇER; alan yoksa (eski
          // CrewPane) çoklu gönderimi hiç denemez, "güncelle" der.
          send(res, 200, { ok: true, multiShot: true, agents: (await onShotAgents()) || [] });
        } catch (err) {
          send(res, 502, { ok: false, error: String(err.message || err) });
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/shot') {
        if (typeof onShotSend !== 'function') {
          send(res, 501, { ok: false, error: 'shot bridge not available' });
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse((await readBody(req)) || '{}');
        } catch {
          send(res, 400, { ok: false, error: 'invalid JSON' });
          return;
        }
        const v = validateShotPayload(parsed);
        if (!v.ok) {
          send(res, 400, { ok: false, error: v.error });
          return;
        }
        try {
          const result = await onShotSend(v.value);
          if (!result || !result.ok) {
            const error = (result && result.error) || 'shot delivery failed';
            // 'not-found' = dosya yok / ajan yok → istemci hatası; gerisi teslim hatası.
            send(res, result && result.reason === 'not-found' ? 404 : 502, { ok: false, error });
            return;
          }
          log(`shot → agent=${v.value.agentId} pane=${result.paneId || '?'} (${v.value.paths.join(', ')})`);
          send(res, 200, { ok: true, paneId: result.paneId || null, state: result.state || null });
        } catch (err) {
          send(res, 504, { ok: false, error: String(err.message || err) });
        }
        return;
      }

      // BOARD-IMG-7 — GÖREV KARTI EKİ. Task MCP buraya gelir çünkü küçük-resim
      // üretimi Electron'a aittir ve depo kökü hesap-kapsamlıdır. Bu rota BAYT
      // İŞLER, SATIR YAZMAZ: dönen metadata ile INSERT'i MCP kendi kimliğiyle
      // yapar (ADP-622 jetonu). Böylece "kim yazdı" bilgisi kaybolmaz.
      if (req.method === 'POST' && url.pathname === '/task-attachment') {
        if (typeof onTaskAttachment !== 'function') {
          send(res, 501, { ok: false, error: 'attachment ingest not available' });
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse((await readBody(req)) || '{}');
        } catch {
          send(res, 400, { ok: false, error: 'invalid JSON' });
          return;
        }
        const v = validateTaskAttachmentPayload(parsed);
        if (!v.ok) {
          send(res, 400, { ok: false, error: v.error });
          return;
        }
        const accepted = [];
        const skipped = [];
        for (const item of v.value.attachments) {
          let r;
          try {
            r = await onTaskAttachment({
              path: item.path,
              taskId: v.value.taskId,
              title: item.title,
              kind: item.kind,
              source: 'agent',
              createdBy: v.value.createdBy,
            });
          } catch (err) {
            r = { ok: false, reason: 'ingest-threw', detail: String((err && err.message) || err) };
          }
          // SESSİZ DÜŞME YOK (WIN-IMG-01 dersi): atlanan her dosya SEBEBİYLE döner,
          // araç bunu ajana aynen yazar.
          if (r && r.ok) accepted.push({ ...r, cover: item.cover === true });
          else skipped.push({ path: item.path, reason: (r && r.reason) || 'unknown', detail: r && r.detail });
        }
        log(`task-attachment → task=${v.value.taskId} kabul=${accepted.length} atlanan=${skipped.length}`);
        send(res, 200, { ok: true, accepted, skipped });
        return;
      }

      // BR-01 / INT-BRIDGE-02 (ADR-INT-BRIDGE §2.1) — ENTEGRASYON KEŞFİ.
      // Ajan "ne bağlı, iznim ne, en son ne zaman doğrulandı" diye sorar; cevabı MAIN
      // hesaplar (katalog + vault META görünümü + resolver politikası + canlı pane
      // defteri). Köprü yalnız taşır — ve TAŞIDIĞI ŞEY SIR DEĞİLDİR: cevapta anahtar
      // da maskeli anahtar da yoktur (kırmızı çizgi ADR §2.1/§5; kanıt testi
      // integrationStatus.test.cjs). `agent` = çağıranın kimliği; pane bağlamı
      // (motor/proje/ortam) BEYANDAN değil o kimliğin canlı pane kaydından çözülür.
      if (req.method === 'GET' && url.pathname === '/integrations/status') {
        if (typeof onIntegrationsStatus !== 'function') {
          send(res, 501, { ok: false, error: 'integration discovery not available' });
          return;
        }
        let out;
        try {
          out = await onIntegrationsStatus({ agentId: url.searchParams.get('agent') || '' });
        } catch (err) {
          send(res, 500, { ok: false, error: String((err && err.message) || err) });
          return;
        }
        if (!out || out.ok !== true) {
          send(res, 502, { ok: false, error: (out && out.error) || 'integration status failed' });
          return;
        }
        const n = Array.isArray(out.services) ? out.services.filter((s) => s.state === 'connected').length : 0;
        log(`integrations status → agent=${url.searchParams.get('agent') || '-'} connected=${n}`);
        send(res, 200, out);
        return;
      }

      // ADP-622 — UYGULAMA DB KİMLİĞİ (ajan/MCP yolu). Bu rota, kullanıcının
      // CrewPane ID access token'ını (TAZE — main tarafında sessiz yenilenmiş) MCP
      // child'ına verir; refresh token ve oturum dokümanı MAIN'de kalır.
      // Güven sınırı: bu rota da bridge token'ının arkasında ve yalnız 127.0.0.1'de —
      // yani zaten delegasyon yapabilen, anon key'i env'inde taşıyan ajan süreçleri.
      // Jeton LOGLANMAZ (yalnız kimin için ve ne kadar ömür kaldığı loglanır).
      if (req.method === 'GET' && url.pathname === '/app-db/token') {
        if (typeof onAppDbToken !== 'function') {
          send(res, 501, { ok: false, reason: 'app_db_token_unavailable' });
          return;
        }
        let out;
        try {
          out = await onAppDbToken();
        } catch (err) {
          send(res, 500, { ok: false, reason: 'error', error: String(err.message || err) });
          return;
        }
        if (!out || !out.ok || typeof out.token !== 'string' || !out.token) {
          // 200 + ok:false BİLİNÇLİ: "oturum yok / farklı proje" bir HATA değil, bir
          // DURUM — istemci sessizce anon'a düşer (bugünkü davranış), 4xx gürültüsü yok.
          send(res, 200, { ok: false, reason: (out && out.reason) || 'no_session' });
          return;
        }
        send(res, 200, {
          ok: true, token: out.token,
          expiresAt: Number.isFinite(out.expiresAt) ? out.expiresAt : null,
          userId: out.userId || null,
        });
        return;
      }

      // PH-01 — SAYAÇ MUSLUĞU (yalnız beyaz listedeki anahtarlar).
      //
      // Görev açma yolu (`crewpane-task-mcp.cjs`) AYRI bir süreçtir; main'deki
      // `telemetryBump`a doğrudan erişemez. Bu uç o boşluğu kapatır ve BİLEREK
      // taşıyabileceği tek şey bir anahtar ADIdır: görev başlığı, açıklaması,
      // ajanı ya da herhangi bir serbest metin buradan GEÇEMEZ — beyaz liste
      // dışındaki her şey 400 ile düşer. Sayı taşır, içerik taşımaz.
      if (req.method === 'POST' && url.pathname === '/telemetry/bump') {
        let bumpBody;
        try { bumpBody = JSON.parse((await readBody(req)) || '{}'); } catch { bumpBody = null; }
        const key = bumpBody && typeof bumpBody.key === 'string' ? bumpBody.key : '';
        if (!TELEMETRY_BUMP_KEYS.has(key)) {
          send(res, 400, { ok: false, error: 'unknown key' });
          return;
        }
        // Telemetri asla çağıranı düşürmez: kapalıysa/hata varsa da ok:true.
        try { if (typeof onTelemetryBump === 'function') onTelemetryBump(key); } catch { /* yut */ }
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        send(res, 200, { ok: true, service: 'crewpane-delegation-bridge' });
        return;
      }

      send(res, 404, { ok: false, error: 'not found' });
    } catch (err) {
      send(res, 500, { ok: false, error: String(err.message || err) });
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      // ADP-226 — handshake delivery is load-bearing (see the consts above): write
      // now, retry a failed write on a short backoff, and self-heal periodically so
      // bridge.json EXISTS with a fresh updatedAt for the bridge's whole lifetime.
      const retryTimers = [];
      if (!writeHandshake(port, token, log)) {
        for (const delayMs of HANDSHAKE_RETRY_DELAYS_MS) {
          const t = setTimeout(() => writeHandshake(port, token, log), delayMs);
          if (typeof t.unref === 'function') t.unref();
          retryTimers.push(t);
        }
      }
      const refreshTimer = setInterval(() => writeHandshake(port, token, log), HANDSHAKE_REFRESH_MS);
      if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
      log(`delegation bridge listening on 127.0.0.1:${port}`);
      resolve({
        port,
        token,
        info: () => ({ port, token }),
        stop: () => {
          ipcMain.removeListener('delegation:start:result', onResult);
          ipcMain.removeListener('delegation:status:result', onResult);
          ipcMain.removeListener('browser:approval:result', onResult); // ADP-095
          ipcMain.removeListener('sprint:start:result', onResult); // ADP-242
          ipcMain.removeListener('sprint:status:result', onResult); // ADP-242
          ipcMain.removeListener('sprint:stop:result', onResult); // DF-03
          for (const { timer } of pending.values()) clearTimeout(timer);
          pending.clear();
          clearInterval(refreshTimer);
          for (const t of retryTimers) clearTimeout(t);
          try {
            server.close();
          } catch {
            /* already closed */
          }
          removeHandshake(log);
        },
      });
    });
  });
}

/**
 * Persist port+token for the MCP server (ADP-051/052) to discover. 0600.
 * TASK-MQTM0UIEMVZ3S (st2) — written ATOMICALLY (temp+rename via the shared
 * agentRunner helper): the delegate MCP reads this handshake the instant a leader
 * pane opens, so a torn/half-written bridge.json would JSON.parse-fail in the MCP and
 * surface as "bridge not found" even though the bridge is up. Rename-over guarantees
 * the reader sees only a COMPLETE prior or new file.
 * ADP-226 — a failure is no longer quiet: it hits BOTH the app log and stderr
 * (console.error), and the caller retries/self-heals off the boolean return.
 * `file` is injectable for unit tests only; runtime always uses BRIDGE_FILE.
 *
 * ENV-08 — SAHİP KORUMASI (28.08 olayı: ikinci prod kopya Eren'in bridge.json'ını
 * 65348→61647 ezdi, liderin sevkleri test kopyasına düştü). CANLI başka bir
 * sürecin taze el sıkışması EZİLMEZ: pid bizim değil + pid canlı + updatedAt
 * taze (< HANDSHAKE_STALE_MS) → yazma reddedilir ve iki kanala loglanır.
 * Ölü/bayat sahip (çökme artığı, pid geri dönüşümü) eskisi gibi onarılır —
 * ADP-226'nın "öksüz dosya bir sonraki bridge'çe yazılır" sözleşmesi durur.
 */
function writeHandshake(port, token, log, file = BRIDGE_FILE, opts = {}) {
  const alive = opts.alive || handshakeOwnerAlive;
  try {
    let owner = null;
    try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* yok/bozuk → yazılabilir */ }
    if (owner && Number.isInteger(owner.pid) && owner.pid !== process.pid && alive(owner.pid)) {
      const age = Date.now() - (Number.isFinite(owner.updatedAt) ? owner.updatedAt : 0);
      if (age < HANDSHAKE_STALE_MS) {
        const msg = `bridge handshake NOT overwritten — live foreign owner pid=${owner.pid} instance=${owner.instance || '?'} (${file})`;
        log(msg);
        console.error(`[delegation-bridge] ${msg}`);
        return false;
      }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // ADP-286 — `instance` damgası: hangi instance'ın (prod/dev/test) bridge'i olduğunu
    // handshake'in KENDİSİ söyler. Yanlış dosyayı okuyan istemci (2026-07-10 incident:
    // test spec'i hardcoded ~/.crewpane/bridge.json'dan PROD'a delegasyon enjekte etti)
    // artık aday değerlendirmesinde yapısal olarak reddedilir (crewpane-delegate-mcp.cjs).
    writeJsonAtomic(file, {
      port,
      token,
      pid: process.pid,
      host: '127.0.0.1',
      instance: instancePaths.instanceId(),
      startedAt: HANDSHAKE_STARTED_AT, // ENV-08 — sahip damgası (pid+startedAt+instance)
      updatedAt: Date.now(),
    });
    return true;
  } catch (err) {
    log(`bridge handshake write failed: ${err.message}`);
    console.error(`[delegation-bridge] handshake write FAILED (${file}): ${(err && err.message) || err}`);
    return false;
  }
}

/**
 * ADP-226 — remove the handshake ONLY if this process wrote it (`pid` match).
 * Two overlapping lifecycles (quit→relaunch, a second instance bouncing off the
 * single-instance lock) used to let the DYING process unlink the file the LIVE
 * bridge had just written → "bridge not found" until the next write. A file we
 * can't read/parse or that carries another pid is left alone (the live owner's
 * self-heal keeps it fresh; a truly orphaned file is simply overwritten by the
 * next bridge start). Returns true only when our own file was deleted.
 */
function removeHandshake(log, file = BRIDGE_FILE) {
  let owner;
  try {
    owner = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return false; // missing or unreadable → nothing of OURS to remove
  }
  if (!owner || owner.pid !== process.pid) {
    log(`bridge handshake kept on stop (owner pid=${owner && owner.pid}, ours=${process.pid})`);
    return false;
  }
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false; /* already gone */
  }
}

module.exports = {
  startDelegationBridge,
  validateComposePayload, // TC-01
  mintToken,
  checkToken,
  validateDelegatePayload,
  // ENG-11 (ENG-R3 §8.2) — alt-delegasyon yetki kapısı (saf karar + defter okuması).
  authorizeDelegateCaller,
  declaredIdentity,
  paneRecordForAgent,
  // TASK-MQTIYIIZE5VR7 (st2) — completion-report fallback (write channel + helpers).
  validateReportPayload,
  writeReportFile,
  defaultResultsDir,
  // TASK-MQSBV4EFQ8D6B — free-pane recycle (worker done → pane freed for the next delegation).
  validateRecyclePayload,
  // ADP-303 — lider pane kontrolü (/pane/close gövde doğrulaması).
  validatePaneClosePayload,
  // ADP-352 — AgentShot köprüsü (/shot gövde doğrulaması).
  validateShotPayload,
  // BOARD-IMG-7 — görev kartı eki (/task-attachment gövde doğrulaması).
  validateTaskAttachmentPayload,
  ATTACH_MAX_PATHS,
  SHOT_PROMPT_MAX_CHARS,
  // ADP-242 — uzun-sprint plan validasyonu (şekil; semantik renderer'da).
  validateSprintPayload,
  // DF-03 — sprint durdurma gövdesi (tek-aktif-sprint kilidinin çıkış yolu).
  validateSprintStopPayload,
  // TASK-MQQ2I4FBV9R2 — leader-read enrichment: clean pane output + transient-API detection.
  stripAnsi,
  cleanPaneTail,
  paneHasApiError,
  enrichDelegationSnapshot,
  // ADP-226 — handshake durability (visible-failure write + pid-guarded remove).
  writeHandshake,
  removeHandshake,
  HANDSHAKE_REFRESH_MS,
  BRIDGE_FILE,
  BRIDGE_DIR,
};
