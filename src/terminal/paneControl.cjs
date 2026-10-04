// CrewPane — ADP-303 (C): leader pane-control core (list / close selection + authorization).
//
// WHY: the leader (Optimus) could OPEN panes (delegation) but had NO way to CLOSE one. The
// only escape was killing pty processes by hand — which is exactly what produced the EPIPE
// crash dialog and the `[pty exited: 143]` zombie. `crewpane_pane` (delegate MCP) → bridge
// → main now does precisely what the × button does. The DECISION (which panes a caller may
// close) lives here, pure, so `node --test` proves the guards without booting Electron.
//
// Guards (deliberately conservative — closing is cheap, closing the WRONG pane is not):
//   • team scope       — a caller may only touch panes in its own team (ADP-717: the
//     decision now lives in teamScope.cjs, SHARED with delegation — "iş verebiliyorsan
//     kapatabilirsin, kapatamıyorsan iş de veremezsin"). Explicit owner grants widen it.
//   • self-protection  — a caller can never close its own agent's pane (it would kill the
//     hand holding the knife: the leader's own session). `force:true` overrides.
//   • explicit target  — closeMany requires a filter (agentId / exited); an empty filter is
//     rejected rather than interpreted as "close everything".

'use strict';

const teamScope = require('../agents/teamScope.cjs'); // ADP-717 — TEK kapsam kararı (delege ile ortak)

/** Public shape of a live pane (what the leader sees). Keep it small — leader context is scarce. */
function summarizePane(p) {
  return {
    paneId: p.paneId,
    agentId: p.agentId ?? null,
    department: p.department ?? null,
    command: p.command ?? null,
    label: p.label ?? null,
    // ── STAT-D1 §KN-2 — "BOŞTA YALANI"NIN KÖKÜ: LİSTEDE STATÜ ALANI YOKTU ────
    // Bu özet liderin/MCP'nin GÖRDÜĞÜ tek şeydi ve içinde durum bilgisi HİÇ yoktu;
    // okunabilen tek alan `label`dı. Aynı anda `paneRecycler` label'ı 'Boşta' yazıyor
    // ⇒ label statü sanılıyor ve YALAN söylüyordu. STAT-R1 ölçtü (09:05:20):
    // pane-70 `label='Boşta'` ⟂ pid 49dk 36sn ayakta, %17.6 CPU, transcript O SANİYE
    // yazılıyor. Artık statü AYRI ve GERÇEK bir alandır; label yalnız KİMLİKTİR.
    // (`main.listPanes` bunu zaten `agentRunner.statusFor(lastDataAt)` ile üretiyordu
    // — üretiliyordu ama bu yola HİÇ girmiyordu.)
    status: p.status ?? null,
    // Statünün HAM dayanağı: lider "4 saniyedir sessiz" ile "1 saattir ölü"yü
    // ayırt edebilsin (statusFor eşiği tek başına bunu söylemez).
    lastDataAt: p.lastDataAt ?? null,
    // Pane'in ÖLÇÜLMÜŞ görev bağı (B-01 Faz B) + etiketten çıkarılan kod. Terminal
    // rozeti ve ofis bunları zaten kullanıyor; lider listesi de AYNI gerçeği görsün
    // (INV-1: iki yüzey aynı anda farklı görev gösteremez).
    taskId: p.taskId ?? null,
    labelTaskCode: p.labelTaskCode ?? null,
    pid: p.pid ?? null,
    startedAt: p.startedAt ?? null,
    // A pane whose child is gone but whose entry lingers (should not happen after the
    // ADP-303 exit-cleanup, but the leader can still spot one).
    exited: p.exited === true,
    // TASK-MQSBV4EFQ8D6B — execution (worker) pane vs leader pane.
    worker: p.disallowSubagent === true,
  };
}

/**
 * Pick the panes a `filter` targets.
 * @param {Array} panes  live pane records.
 * @param {object} filter  { paneId?, agentId?, exitedOnly?, all? }
 * @returns {{ ok: true, panes: Array } | { ok: false, error: string }}
 */
function selectPanes(panes, filter = {}) {
  const list = Array.isArray(panes) ? panes : [];
  const paneId = typeof filter.paneId === 'string' ? filter.paneId.trim() : '';
  const agentId = typeof filter.agentId === 'string' ? filter.agentId.trim() : '';
  const exitedOnly = filter.exitedOnly === true;

  if (paneId) {
    const hit = list.filter((p) => p.paneId === paneId);
    if (!hit.length) return { ok: false, error: `no such pane: ${paneId}` };
    return { ok: true, panes: hit };
  }
  if (agentId) {
    let hit = list.filter((p) => p.agentId === agentId);
    if (exitedOnly) hit = hit.filter((p) => p.exited === true);
    return { ok: true, panes: hit };
  }
  if (exitedOnly) return { ok: true, panes: list.filter((p) => p.exited === true) };

  // No target at all — REFUSE. "close everything" must be spelled out, and even then it is
  // scoped by department + self-protection below.
  if (filter.all === true) return { ok: true, panes: list.slice() };
  return { ok: false, error: 'a target is required: paneId, agentId, exitedOnly, or all:true' };
}

/**
 * May `caller` close `pane`?
 *
 * ADP-717 — the TEAM decision is delegated to `teamScope.authorize({action:'manage'})`,
 * the SAME function `/delegate` calls. That is the whole point: a leader that can start
 * work in a team can also clean it up, and one that cannot clean up cannot start either.
 * Only the pane-specific self-protection stays here.
 *
 * @param {object} pane
 * @param {object} caller  { agentId?, department?, force?, policy?, now? }
 * @returns {{ ok: true, via?: string } | { ok: false, reason: string, code?: string }}
 */
function authorizeClose(pane, caller = {}) {
  const callerAgent = typeof caller.agentId === 'string' ? caller.agentId.trim() : '';
  const force = caller.force === true;

  const scope = teamScope.authorize({
    action: 'manage',
    callerId: callerAgent,
    callerScope: caller.department,
    targetScope: pane.department,
    policy: caller.policy,
    force,
    now: caller.now,
    targetStartedAt: pane.startedAt,
  });
  if (!scope.ok) return { ok: false, reason: scope.reason, code: scope.code };

  if (callerAgent && pane.agentId === callerAgent && !force) {
    return { ok: false, code: 'own-pane', reason: 'refused: that is your OWN pane (pass force:true if you really mean it)' };
  }
  return { ok: true, via: scope.via };
}

/**
 * Full decision for a close request: which panes get closed, which are denied and why.
 * Never throws; the caller (main) only has to execute `close`.
 */
function planClose(panes, filter, caller) {
  const sel = selectPanes(panes, filter);
  if (!sel.ok) return { ok: false, error: sel.error };
  const close = [];
  const denied = [];
  for (const p of sel.panes) {
    const auth = authorizeClose(p, caller);
    if (auth.ok) close.push(p);
    else denied.push({ paneId: p.paneId, reason: auth.reason });
  }
  return { ok: true, close, denied };
}

module.exports = { summarizePane, selectPanes, authorizeClose, planClose };
