// CrewPane — ADP-838 (Ratchet): SUPERVISOR → TASK BOARD STATÜ SENKRONU.
//
// ─────────────────────────────────────────────────────────────────────────────
// NEDEN VAR
// ─────────────────────────────────────────────────────────────────────────────
// ADP-659 supervisor defteri (delegation-supervisor.json) bir alt-görevin bitişini
// ÇOKLU SİNYALLE tespit ediyor ve kaydında `taskCode` ("ADP-838") TAŞIYOR — ama o
// bitişi BOARD'a (Supabase `tasks`) yazan HİÇBİR adım yoktu. Ölçüm (2026-08-01,
// canlı defter): 39 kaydın 38'i taskCode taşıyor, 18'i `done`; board'da o görevler
// hâlâ Backlog'da duruyordu ve lider 27 statüyü ELLE düzeltti.
//
// Bu modül o eksik adımı kapatır. TASARIM KISITLARI (Eren'in kararı):
//   • dispatch anında → `in_progress`
//   • KANITLI `done` settle'ında → `review`   (ASLA `done` — insan onayı kalır)
//   • YALNIZ İLERİ geçiş: `review`/`done` bir görev GERİ çekilmez
//   • YALNIZ kendi takımının (department == tasks.project) görevleri
//   • Görev SATIRI güvenle çözülemiyorsa (0 ya da >1 aday) DOKUNMA + LOGLA.
//     Başlık TAHMİN EDİLMEZ: eşleşme, başlıktaki görev kodunun TAM TOKEN'ıdır.
//
// İLERİ-ONLY GARANTİSİ NEREDE: yalnız burada değil — PATCH isteğinin KENDİSİNDE
// (`status=in.(…)` süzgeci). Böylece "oku → karar ver → yaz" arasında board'u
// başkası (lider/insan) ileri taşımışsa yazım 0 satır etkiler; yarış yapısal olarak
// kapalıdır, iyimser kilit gerekmez.
//
// TÜM IO ENJEKTE (fetch + hedef + jeton) → `node --test` doğrudan koşar.

'use strict';

const appDbIdentity = require('../config/appDbIdentity.cjs');

const REQUEST_TIMEOUT_MS = 15_000;

/** Board'un kabul ettiği statüler (tasks_status_check ile senkron). */
const STATUSES = Object.freeze(['backlog', 'todo', 'in_progress', 'review', 'done']);

/** Statü sırası — "ileri" tanımı tek yerde. */
const ORDER = Object.freeze({ backlog: 0, todo: 1, in_progress: 2, review: 3, done: 4 });

const PHASES = Object.freeze({
  DISPATCH: 'dispatch',   // alt-görev worker'a verildi
  DONE: 'done',           // kanıtlı tamamlanma tespit edildi
});

/** Her fazın HEDEF statüsü. `done` fazı bilerek `review`e gider (insan onayı). */
const PHASE_TARGET = Object.freeze({
  [PHASES.DISPATCH]: 'in_progress',
  [PHASES.DONE]: 'review',
});

/**
 * Başlıkta görev kodu TAM TOKEN olarak geçiyor mu?
 *
 * 🪤 Neden `includes` DEĞİL: "ADP-83" araması "ADP-838 …" başlığını yakalar ve
 * YANLIŞ görevin statüsünü bozar. Kod, harf/rakam sınırlarıyla çevrili olmalı
 * ("ADP-838 — …", "(ADP-838)", "ADP-838:" hepsi geçerli; "ADP-8381" değil).
 */
function titleHasCode(title, code) {
  const c = String(code || '').trim();
  if (!c) return false;
  const esc = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9-])${esc}([^A-Za-z0-9-]|$)`, 'i').test(String(title || ''));
}

/**
 * Görev kodundan BOARD SATIRI çöz — TEK aday yoksa hüküm YOK.
 *
 * @param {string} code             kaydın `taskCode`'u ("ADP-838")
 * @param {Array}  rows             board satırları [{id,title,status,project}]
 * @param {{department?:string|null}} [scope]
 * @returns {{ok:true, task:object} | {ok:false, reason:string, candidates:string[]}}
 */
function pickBoardTask(code, rows, scope) {
  const c = String(code || '').trim();
  if (!c) return { ok: false, reason: 'no-task-code', candidates: [] };
  const dept = scope && typeof scope.department === 'string' ? scope.department.trim() : '';
  const list = Array.isArray(rows) ? rows : [];
  const hits = list.filter((r) => {
    if (!r || typeof r.id !== 'string' || !r.id) return false;
    // TAKIM KAPSAMI: kaydın departmanı biliniyorsa BAŞKA projenin görevine dokunulmaz.
    // (Departman bilinmiyorsa kapsam daraltılamaz → aşağıdaki tekillik şartı tek koruma.)
    if (dept && String(r.project || '') !== dept) return false;
    return titleHasCode(r.title, c);
  });
  if (hits.length === 1) return { ok: true, task: hits[0] };
  return {
    ok: false,
    reason: hits.length === 0 ? 'not-found' : 'ambiguous',
    candidates: hits.map((r) => r.id),
  };
}

/**
 * Bu fazda board statüsü nereye gitmeli? `null` = DOKUNMA.
 *
 * Kural TEK cümle: hedef statü mevcuttan İLERİDEYSE taşı, değilse dokunma.
 * Bilinmeyen bir mevcut statü (şema büyürse) ASLA taşınmaz — sessiz bozma yok.
 */
function nextStatusFor(current, phase) {
  const target = PHASE_TARGET[phase];
  if (!target) return null;
  const cur = String(current || '').trim();
  if (!Object.prototype.hasOwnProperty.call(ORDER, cur)) return null;
  return ORDER[target] > ORDER[cur] ? target : null;
}

/** Bu fazda mevcut statü hangi değerlerden İLERİ taşınabilir (PATCH süzgeci). */
function movableFrom(phase) {
  const target = PHASE_TARGET[phase];
  if (!target) return [];
  return STATUSES.filter((s) => ORDER[s] < ORDER[target]);
}

/**
 * Board senkronunu yarat. Tüm IO enjekte.
 *
 * deps:
 *   target()        → {url, anonKey, schema} | null   (main: rendererSupabaseTarget())
 *   accessToken()   → Promise<string|null>            (main: seatGate jetonu; null = anon)
 *   fetchImpl       → fetch uyumlu (varsayılan globalThis.fetch)
 *   log(line)       → void
 *   enabled()       → boolean (kill-switch)
 */
function createBoardTaskSync(deps) {
  const d = deps || {};
  const log = d.log || (() => {});
  const doFetch = d.fetchImpl || ((...a) => globalThis.fetch(...a));
  const enabled = d.enabled || (() => true);

  async function resolveTarget() {
    try {
      const t = typeof d.target === 'function' ? d.target() : d.target;
      if (!t || !t.url || !(t.anonKey || t.key)) return null;
      return { url: String(t.url).replace(/\/+$/, ''), key: t.anonKey || t.key, schema: t.schema || 'public' };
    } catch {
      return null;
    }
  }

  async function resolveToken() {
    if (typeof d.accessToken !== 'function') return null;
    try {
      const r = await d.accessToken();
      if (typeof r === 'string') return r || null;
      return r && r.ok && typeof r.token === 'string' && r.token ? r.token : null;
    } catch {
      return null; // jeton yok = ANON (yerel/e2e stack) — hata değil, DURUM
    }
  }

  function headers(target, token, method, extra) {
    return {
      apikey: target.key,
      authorization: `Bearer ${token || target.key}`,
      accept: 'application/json',
      ...appDbIdentity.schemaHeaders(target.schema, method),
      ...(extra || {}),
    };
  }

  async function request(target, token, method, pathPart, body, extra) {
    const res = await doFetch(`${target.url}${pathPart}`, {
      method,
      headers: {
        ...headers(target, token, method, extra),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let parsed = null;
    try { parsed = await res.json(); } catch { /* gövdesiz yanıt (204) */ }
    return { status: res.status, ok: res.ok, body: parsed };
  }

  /**
   * Tek geçiş. ASLA throw etmez — board senkronu bir YAN ETKİDİR, delegasyonu
   * düşürmesi yasaktır.
   *
   * @param {{phase:string, taskCode?:string|null, department?:string|null, key?:string}} input
   * @returns {Promise<{ok:boolean, action:string, taskId?:string, from?:string, to?:string}>}
   */
  async function sync(input) {
    const phase = input && input.phase;
    const label = (input && input.key) || (input && input.taskCode) || '?';
    const done = (action, extra) => ({ ok: action === 'updated', action, ...(extra || {}) });

    if (!enabled()) return done('disabled');
    if (!PHASE_TARGET[phase]) return done('bad-phase');
    const code = input && input.taskCode ? String(input.taskCode).trim() : '';
    if (!code) {
      // ADP-494'ün ölçülebilir imzası: taskCode YOK = board satırı GÜVENLE çözülemez.
      log(`board-sync: ${label} — görev kodu YOK, board'a DOKUNULMADI (${phase})`);
      return done('no-task-code');
    }
    const target = await resolveTarget();
    if (!target) {
      log(`board-sync: ${label} — Supabase hedefi yok, board'a DOKUNULMADI`);
      return done('unconfigured');
    }
    const token = await resolveToken();
    const dept = input && input.department ? String(input.department).trim() : '';

    // 1) ADAYLARI ÇEK. Sunucu süzgeci yalnız ÖN-ELEME'dir; kesin hüküm saf
    //    `pickBoardTask` (tam-token + departman) tarafından verilir.
    const qs = [
      'select=id,title,status,project',
      `title=ilike.${encodeURIComponent(`*${code}*`)}`,
      'limit=25',
    ];
    if (dept) qs.push(`project=eq.${encodeURIComponent(dept)}`);
    let listed;
    try {
      listed = await request(target, token, 'GET', `/rest/v1/tasks?${qs.join('&')}`);
    } catch (err) {
      log(`board-sync: ${label} — board okunamadı (${(err && err.message) || err})`);
      return done('unreachable');
    }
    if (!listed.ok || !Array.isArray(listed.body)) {
      log(`board-sync: ${label} — board okunamadı (HTTP ${listed.status})`);
      return done('read-failed');
    }

    const picked = pickBoardTask(code, listed.body, { department: dept || null });
    if (!picked.ok) {
      log(
        `board-sync: ${label} — ${code} için board görevi ${
          picked.reason === 'ambiguous'
            ? `TEKİL DEĞİL (${picked.candidates.join(', ')})`
            : 'BULUNAMADI'
        } → board'a DOKUNULMADI (yanlış eşleşme statüyü bozar)`,
      );
      return done(picked.reason, { candidates: picked.candidates });
    }

    const task = picked.task;
    // Okunan statü SABİTLENİR: rapor satırındaki "X → Y" yazımdan ÖNCEKİ hâli
    // anlatmalı (yanıt gövdesi aynı nesneyi tazelerse "backlog → in_progress"
    // yerine "in_progress → in_progress" gibi anlamsız bir iz kalırdı).
    const fromStatus = String(task.status || '');
    const to = nextStatusFor(fromStatus, phase);
    if (!to) {
      log(`board-sync: ${label} — ${task.id} zaten '${fromStatus}' (${phase} hedefi geride) → GERİ ÇEKİLMEDİ`);
      return done('no-forward-move', { taskId: task.id, from: fromStatus });
    }

    // 2) İLERİ-ONLY PATCH. Süzgeç `status=in.(…)` yarışı yapısal olarak kapatır:
    //    okuma ile yazma arasında satır ileri gittiyse 0 satır etkilenir.
    const from = movableFrom(phase);
    const patchQs = [
      `id=eq.${encodeURIComponent(task.id)}`,
      `status=in.(${from.join(',')})`,
    ];
    let res;
    try {
      res = await request(
        target,
        token,
        'PATCH',
        `/rest/v1/tasks?${patchQs.join('&')}`,
        // `tasks`ta updated_at trigger'ı YOK (task MCP de elle yazar) → board yeniden sıralansın.
        { status: to, updated_at: new Date(typeof d.now === 'function' ? d.now() : Date.now()).toISOString() },
        { prefer: 'return=representation' },
      );
    } catch (err) {
      log(`board-sync: ${label} — ${task.id} yazılamadı (${(err && err.message) || err})`);
      return done('unreachable', { taskId: task.id });
    }
    if (!res.ok) {
      log(`board-sync: ${label} — ${task.id} yazılamadı (HTTP ${res.status})`);
      return done('write-failed', { taskId: task.id, from: fromStatus, to });
    }
    const rows = Array.isArray(res.body) ? res.body : [];
    if (rows.length === 0) {
      log(`board-sync: ${label} — ${task.id} bu arada ilerlemiş, geçiş atlandı (${fromStatus} → ${to} YOK)`);
      return done('raced', { taskId: task.id, from: fromStatus, to });
    }
    log(`board-sync: ${label} — board görevi ${task.id}: ${fromStatus} → ${to} ✅`);
    return done('updated', { taskId: task.id, from: fromStatus, to });
  }

  return { sync };
}

module.exports = {
  STATUSES,
  ORDER,
  PHASES,
  PHASE_TARGET,
  titleHasCode,
  pickBoardTask,
  nextStatusFor,
  movableFrom,
  createBoardTaskSync,
};
