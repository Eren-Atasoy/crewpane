// SYNC-F1-3 (Wheeljack) — IPC SINIRI: renderer'ın senkron hakkında görebileceği HER ŞEY.
//                         Tasarım: SYNC-F1-TASARIM.md §2.8 · §3.2 (FAZ 1 UI kapsamı)
//
// ═══════════════════════════════════════════════════════════════════════════════
// NEDEN AYRI DOSYA (integrationIpc.cjs deseni)
// ═══════════════════════════════════════════════════════════════════════════════
// `main.js` Electron olmadan `require` EDİLEMEZ, yani orada yaşayan bir doğrulama
// `node --test` ile sınanamaz. Sınır burada, `main.js`'te yalnız üç satırlık
// `ipcMain.handle` kalır. Renderer'dan gelen HER alan bu dosyada daraltılır.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 RENDERER'A GÖVDE DÖNMEZ
// ─────────────────────────────────────────────────────────────────────────────
// Çakışma listesi hafıza dosyalarının İÇERİĞİNİ taşıyabilirdi (`loser_body` 64 KB'a
// kadar). Dönmez: liste yalnız yol + sha + damga + insan-okur gerekçe verir.
// "Kaybedeni yanına yaz" eylemi baytı MAIN tarafında diske yazar ve renderer'a
// yalnız YAZILAN YOLU söyler. Böylece hafıza içeriği renderer sürecine (ve
// dolayısıyla DevTools'a, bir XSS yüzeyine, bir log'a) hiç girmez.
//
// ─────────────────────────────────────────────────────────────────────────────
// SENKRON VARSAYILAN KAPALI (§9.3 önerisi)
// ─────────────────────────────────────────────────────────────────────────────
// Motor verilmezse HER çağrı `{ok:false, reason:'sync-disabled'}` döner — çökmeden,
// "yakında" demeden. UI bu cevabı olduğu gibi gösterebilir.
//
// SAF + DI: motor enjekte edilir, Electron bağı YOK.

'use strict';

const RESOLUTIONS = ['kept-winner', 'restored-loser', 'merged-manual'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA_RE = /^[0-9a-f]{64}$/;

/** Çakışma satırının renderer'a giden GÖRÜNÜMÜ — gövde YOK. */
function conflictView(row) {
  return {
    id: row.id,
    relPath: row.rel_path,
    class: row.class,
    kind: row.kind,
    winnerSha: row.winner_sha256 || null,
    winnerDevice: row.winner_device || null,
    loserSha: row.loser_sha256 || null,
    loserDevice: row.loser_device || null,
    detail: row.detail || null,
    detectedAt: row.detected_at || null,
    resolvedAt: row.resolved_at || null,
    resolution: row.resolution || null,
    // "Kaybedeni yanına yaz" düğmesi ETKİN mi? Gövde deftere sığmadıysa yalnız
    // sha durur ve kurtarma o baytı elinde tutan cihazdan yapılabilir.
    recoverable: Boolean(row.loser_sha256),
  };
}

function disabled() {
  return { ok: false, reason: 'sync-disabled' };
}

/** `describe()` patlarsa STATUS PATLAMAZ: rozet bir teşhis alanı yüzünden kaybolamaz. */
function safeSetup(getSetup, log) {
  try { return getSetup(); } catch (err) { log(`[sync-ipc] setup okunamadı: ${err && err.message}`); return null; }
}

/** Kuruluş görüntüsünün renderer'a giden DARALTILMIŞ hâli — mutlak yol GEÇMEZ. */
function setupView(d) {
  const s = (d && d.setup) || {};
  return {
    // Kullanıcı AÇTI mı (tercih) ↔ motor KURULDU mu (gerçek). İkisi ayrışabilir ve
    // ekran o ayrışmayı göstermek zorundadır — "açık ama çalışmıyor" sessiz kalamaz.
    wanted: (d && d.wanted) === true,
    ready: (d && d.enabled) === true,
    reason: s.reason || null,
    workspaceKey: s.workspaceKey || null,
    workspaceName: s.displayName || null,
    identityCreated: s.created === true,
    // Klasör ADI geçer, MUTLAK YOL geçmez: ekranın "hangi klasör" sorusuna cevap
    // vermesi için ad yeter; yol renderer'a (ve bir log satırına) girmemeli.
    hasWorkspaceRoot: Boolean(d && d.roots && d.roots.workspaceRoot),
  };
}

/**
 * Kuruluşun okuduğu PLAN kararının renderer görünümü — motor YOKKEN de dolu.
 *
 * `getStatus().plan` yalnız motor kurulduğunda vardır; tercih kapalıyken motor
 * yoktur ve o hâlde paket kilidi hakkında SÖYLENECEK BİR ŞEY OLMAZDI. Yüzey ise
 * kilidi tercih açılmadan ÖNCE göstermek zorunda (yoksa Basic kullanıcı hiçbir
 * şey yapmayan bir "Aç" düğmesi görür). Bu yüzden kapı ayrıca buradan geçer.
 */
function planView(d) {
  const p = d && d.plan;
  if (!p) return null;
  const den = p.denial || null;
  return {
    allowed: p.allowed === true,
    enforced: p.enforced === true,
    tier: p.tier || null,
    tierLabel: p.tierLabel || null,
    requiredTierLabel: p.requiredTierLabel || null,
    deviceSlots: p.deviceSlots == null ? null : p.deviceSlots,
    title: den ? den.title : null,
    message: den ? den.message : null,
  };
}

/**
 * @param {{engine?:object|null, getEngine?:Function, getSetup?:Function, log?:Function}} deps
 */
function createSyncIpc(deps = {}) {
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const getEngine = typeof deps.getEngine === 'function'
    ? deps.getEngine
    : () => deps.engine || null;
  // SYNC-F1-6 — AÇILIŞ BAĞLAMASININ görüntüsü (syncBoot.describe). VERİLMEZSE ALAN
  // HİÇ EKLENMEZ: "motor yok" ile "motor yok, çünkü klasör seçilmemiş" iki ayrı
  // cümledir ve ikincisini yalnız kuruluşu yapan taraf söyleyebilir. Alanı koşulsuz
  // eklemek, kuruluşu bilmeyen çağıranlara `setup:null` diye BOŞ bir hüküm verirdi.
  const getSetup = typeof deps.getSetup === 'function' ? deps.getSetup : null;

  async function guard(fn) {
    const engine = getEngine();
    if (!engine) return disabled();
    try {
      return await fn(engine);
    } catch (err) {
      log(`[sync-ipc] hata: ${err && err.message}`);
      return { ok: false, reason: 'engine-error', error: String((err && err.message) || err).slice(0, 300) };
    }
  }

  /** `sync:status` — rozet bunu okur (§2.8). */
  function status() {
    const engine = getEngine();
    // Motor HİÇ YOKSA plan hakkında bir şey İDDİA ETMEYİZ (`plan:null`): "senkron
    // kapalı" ile "senkron paketinde yok" iki ayrı cümledir ve ikincisini yalnız
    // motorun kapısı söyleyebilir.
    if (!engine) {
      const off = { ok: true, enabled: false, state: 'idle', plan: null };
      if (getSetup) {
        const d = safeSetup(getSetup, log);
        off.setup = setupView(d);
        // Motor yok ama KAPI okunabilir: kilit tercih kapalıyken de görünür.
        off.plan = planView(d);
      }
      return off;
    }
    const s = engine.getStatus();
    const out = {
      ok: true,
      enabled: true,
      state: s.state,
      queued: s.queued,
      files: s.files,
      cursor: s.cursor,
      lastPullAt: s.lastPullAt,
      lastPushAt: s.lastPushAt,
      lastReconcileAt: s.lastReconcileAt,
      conflictsOpen: s.conflictsOpen,
      // Rozet YALAN SÖYLEMEZ (§2.8): kanıt yoksa UI "yedek modda" der.
      realtimeProven: s.realtimeProven,
      pollMs: s.pollMs,
      halted: s.halted ? { reason: s.halted.reason, at: s.halted.at } : null,
      disabled: s.disabled ? { reason: s.disabled.reason, at: s.disabled.at } : null,
      lastError: s.lastError,
      counters: s.counters,
      // TIER-SYNC-01 — KİLİDİ GÖSTER. Yüzey (Ayarlar → Senkron, F1-6) bu bloktan
      // dürüst yükseltme kartını kurar: hangi pakette açılır, üst pakette aynı anda
      // kaç cihaz. Renderer katman ADI SORMAZ (`tier === 'basic'` yok) — hedef
      // katman etiketi VERİ olarak gelir (TIER-DESIGN-01 deseni).
      // Cümle de burada üretilmez: motorun taşıdığı planLimits metni geçer.
      plan: s.plan || null,
    };
    if (getSetup) out.setup = setupView(safeSetup(getSetup, log));
    return out;
  }

  /** `sync:now` — "şimdi eşitle". */
  function syncNow(input = {}) {
    const reconcile = input && input.reconcile === true;
    return guard(async (engine) => {
      const r = await engine.tick({ reconcile });
      return { ok: r.ok !== false, result: r, status: status() };
    });
  }

  /** `sync:conflicts` — liste (GÖVDE YOK). */
  function conflicts(input = {}) {
    const openOnly = !(input && input.openOnly === false);
    return guard(async (engine) => {
      const r = await engine.refreshConflicts();
      if (!r.ok) return { ok: false, reason: r.kind || 'fetch-failed', error: r.error };
      const rows = openOnly ? r.rows.filter((x) => !x.resolved_at) : r.rows;
      return { ok: true, rows: rows.map(conflictView), count: rows.length };
    });
  }

  /** `sync:restoreLoser` — kaybedeni YANINA yaz (üzerine YAZMAZ). */
  function restoreLoser(input = {}) {
    const id = input && typeof input.id === 'string' ? input.id.trim() : '';
    if (!UUID_RE.test(id)) return Promise.resolve({ ok: false, reason: 'invalid-id' });
    return guard(async (engine) => {
      const r = await engine.restoreLoser(id);
      if (!r.ok) return { ok: false, reason: r.reason || r.kind || 'restore-failed', error: r.error || r.detail || null };
      return { ok: true, path: r.abs, resolved: r.resolved };
    });
  }

  /** `sync:resolveConflict` — kullanıcı kararı defterlenir. */
  function resolveConflict(input = {}) {
    const id = input && typeof input.id === 'string' ? input.id.trim() : '';
    const resolution = input && typeof input.resolution === 'string' ? input.resolution : '';
    if (!UUID_RE.test(id)) return Promise.resolve({ ok: false, reason: 'invalid-id' });
    if (!RESOLUTIONS.includes(resolution)) return Promise.resolve({ ok: false, reason: 'invalid-resolution' });
    return guard(async (engine) => {
      const r = await engine.resolveConflict(id, resolution);
      if (!r.ok) return { ok: false, reason: r.kind || 'resolve-failed', error: r.error || null };
      return { ok: true, id, resolution };
    });
  }

  /** `sync:approveSecret` — "bu dosyada sır yok, yükle" (§5.4). */
  function approveSecret(input = {}) {
    const sha = input && typeof input.sha256 === 'string' ? input.sha256.trim().toLowerCase() : '';
    if (!SHA_RE.test(sha)) return Promise.resolve({ ok: false, reason: 'invalid-sha' });
    return guard(async (engine) => engine.approveSecret(sha));
  }

  /** `sync:resumeQueue` — yeniden girişten sonra durmuş kuyruğu sürdür. */
  function resumeQueue() {
    return guard(async (engine) => {
      const s = engine.getStatus();
      if (!s.halted) return { ok: true, resumed: false, status: status() };
      const r = engine.resumeQueue();
      return { ok: true, resumed: Boolean(r && r.resumed), status: status() };
    });
  }

  return { status, syncNow, conflicts, restoreLoser, resolveConflict, approveSecret, resumeQueue, conflictView };
}

module.exports = { createSyncIpc, conflictView, setupView, planView, RESOLUTIONS, UUID_RE, SHA_RE };
