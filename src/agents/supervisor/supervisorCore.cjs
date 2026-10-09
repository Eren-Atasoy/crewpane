'use strict';

const { DEFAULTS, SETTLE_SOURCES, isTerminalStatus } = require('./constants.cjs');
const { recordKey, normalizeState } = require('./stateRecord.cjs');
const { evidenceSeen, evidenceChanged, markerCount, detect } = require('./evidenceDetect.cjs');
const { verifyDelivery, recoverHangingPrompts } = require('./deliveryVerify.cjs');
const { verifyWakes, consumeBriefings, wakeLeaders, scheduleWakeFollowUp } = require('./leaderWake.cjs');
const {
  notifyOnce,
  advanceQueue,
  reapGhostPane,
  markExternalShutdown,
  externalShutdownNote,
  repairAfterRestart,
  prune,
} = require('./ghostReaper.cjs');
const { createDeliverPrompt } = require('../deliverPrompt.cjs');
const { PHASES: BOARD_PHASES } = require('../boardTaskSync.cjs');

/**
 * Supervisor'ı yarat. Tüm IO `deps` ile enjekte edilir.
 */
function createDelegationSupervisor(deps) {
  const d = deps || {};
  const cfg = { ...DEFAULTS, ...(d.opts || {}) };
  const now = d.now || (() => Date.now());
  const log = d.log || (() => {});
  const noop = () => {};
  const io = {
    loadState: d.loadState || (() => ({})),
    saveState: d.saveState || noop,
    listPanes: d.listPanes || (() => []),
    readPaneBuffer: d.readPaneBuffer || (() => ''),
    writePane: d.writePane || (() => false),
    reapPane: d.reapPane || (() => false),
    fingerprint: d.fingerprint || (() => null),
    evidenceStat: d.evidenceStat || (() => null),
    transcriptHas: d.transcriptHas || (() => null),
    notify: d.notify || noop,
    pushRenderer: d.pushRenderer || (async () => false),
    lastInputAt: d.lastInputAt || (() => null),
    lastSubmitAt: d.lastSubmitAt || (() => null),
    boardSync: d.boardSync || (async () => ({ ok: false, action: 'not-wired' })),
    readBriefingReceipts: d.readBriefingReceipts || (() => null),
    consumeBriefingReceipts: d.consumeBriefingReceipts || (() => {}),
    wakeVerifiable: d.wakeVerifiable || (() => false),
    leaderTranscriptHas: d.leaderTranscriptHas || (() => null),
    sleep: d.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
  };

  let state = normalizeState(io.loadState());
  let dirty = false;
  let softDirty = false;
  const lastDeferLog = new Map();
  let timer = null;
  let followUpTimer = null;
  let sweeping = false;
  let lastPaneCount = 0;

  const EAGER_PERSIST = process.env.CREWPANE_SUPERVISOR_EAGER_PERSIST === '1';
  const SOFT_PERSIST_MIN_MS = 30_000;
  let lastSoftPersistAt = 0;

  const persist = (opts) => {
    const t = now();
    const softDue = !!(opts && opts.includeSoft) && softDirty
      && (t - lastSoftPersistAt >= SOFT_PERSIST_MIN_MS);
    if (!dirty && !softDue) return;
    try {
      io.saveState(state);
      dirty = false;
      softDirty = false;
      lastSoftPersistAt = t;
    } catch (err) {
      log(`supervisor: defter yazılamadı: ${(err && err.message) || err}`);
    }
  };

  const touch = () => { dirty = true; };
  const touchSoft = () => { if (EAGER_PERSIST) dirty = true; else softDirty = true; };

  function safeBuffer(paneId) {
    try { return io.readPaneBuffer(paneId) || ''; } catch { return ''; }
  }

  function paneIndex() {
    const map = new Map();
    let panes = [];
    try { panes = io.listPanes() || []; } catch { panes = []; }
    for (const p of panes) if (p && p.paneId) map.set(p.paneId, p);
    return map;
  }

  function reconcilePaneIdentity(panes) {
    let cut = 0;
    for (const rec of Object.values(state.records)) {
      if (isTerminalStatus(rec.status) || !rec.paneId || !rec.agentId) continue;
      const p = panes.get(rec.paneId);
      if (!p || !p.agentId || p.agentId === rec.agentId) continue;
      log(
        `supervisor: pane KİMLİK uyuşmazlığı ${rec.key} — ${rec.paneId} artık ` +
          `${p.agentId} (kayıt ${rec.agentId}) → pane bağı kesildi (yanlış ajana yazım/reap YOK)`,
      );
      rec.paneLostFrom = rec.paneId;
      rec.paneId = null;
      cut += 1;
      touch();
    }
    if (cut) persist();
    return cut;
  }

  const deliver = createDeliverPrompt({
    readPaneBuffer: (id) => safeBuffer(id),
    writePane: (id, data) => {
      try { return io.writePane(id, data) === true; } catch { return false; }
    },
    sleep: (ms) => io.sleep(ms),
    now,
    livePaneCount: () => lastPaneCount,
    log,
  });

  const boardInFlight = new Set();
  async function runBoardSync(rec, phase) {
    if (!rec || !rec.board) return null;
    const stampAt = phase === BOARD_PHASES.DISPATCH ? 'dispatchAt' : 'reviewAt';
    const stampAction = phase === BOARD_PHASES.DISPATCH ? 'dispatchAction' : 'reviewAction';
    if (rec.board[stampAt]) return null;
    const guard = `${rec.key}|${phase}`;
    if (boardInFlight.has(guard)) return null;
    boardInFlight.add(guard);
    let res = null;
    try {
      res = await io.boardSync({
        phase,
        key: rec.key,
        taskCode: rec.taskCode || null,
        department: rec.department || null,
        agentId: rec.agentId || null,
        evidencePath: rec.evidencePath || null,
      });
    } catch (err) {
      res = { ok: false, action: `error:${(err && err.message) || err}` };
    } finally {
      boardInFlight.delete(guard);
    }
    if (res && res.action === 'not-wired') return res;
    rec.board[stampAt] = now();
    rec.board[stampAction] = (res && res.action) || 'unknown';
    if (res && res.taskId) rec.board.taskId = res.taskId;
    touch();
    persist();
    return res;
  }

  function markSettled(rec, status, by, reason) {
    rec.status = status;
    rec.settledBy = by;
    rec.settledAt = now();
    rec.reason = reason || null;
    rec.settleBytes = rec.paneSeen ? rec.paneSeen.bytes : null;
    touch();
  }

  function record(input) {
    if (!input || !input.delegationId || !input.subtaskId) return null;
    const key = recordKey(input.delegationId, input.subtaskId);
    const prev = state.records[key];
    if (prev && isTerminalStatus(prev.status)) return prev;
    const rec = {
      key,
      delegationId: String(input.delegationId),
      subtaskId: String(input.subtaskId),
      agentId: input.agentId || null,
      leaderId: input.leaderId || null,
      department: input.department || null,
      title: input.title || null,
      taskCode: input.taskCode || null,
      origin: input.origin || null,
      paneId: input.paneId || null,
      evidencePath: input.evidencePath || null,
      evidenceBaseline: input.evidenceBaseline === undefined ? null : input.evidenceBaseline,
      evidenceAlt: Array.isArray(input.evidenceAlt) ? input.evidenceAlt.filter((p) => typeof p === 'string' && p) : [],
      evidenceBaselines:
        input.evidenceBaselines && typeof input.evidenceBaselines === 'object' ? input.evidenceBaselines : null,
      promptPayload: input.promptPayload || null,
      promptSignature: input.promptSignature || null,
      transcriptPath: input.transcriptPath || null,
      dispatchedAt: (prev && prev.dispatchedAt) || now(),
      status: null,
      settledAt: null,
      settledBy: null,
      reason: null,
      delivery: (prev && prev.delivery) || {
        verified: null, attempts: 0, lastAt: 0, textWrittenAt: 0, deliveredAt: 0,
      },
      wake: (prev && prev.wake) || {
        attempts: 0, lastAt: 0, deliveredAt: 0, ackedAt: 0, enterOnlyNext: false,
      },
      note: (prev && prev.note) || null,
      notifiedAt: (prev && prev.notifiedAt) || 0,
      advancedAt: (prev && prev.advancedAt) || 0,
      reapedAt: (prev && prev.reapedAt) || 0,
      paneSeen: (prev && prev.paneSeen) || { bytes: -1, at: now() },
      paneGoneAt: 0,
      board: (prev && prev.board) || { dispatchAt: 0, dispatchAction: null, reviewAt: 0, reviewAction: null },
    };
    {
      const buf = rec.paneId ? safeBuffer(rec.paneId) : '';
      rec.markerBaseline = markerCount(rec, buf);
      rec.markerBufferLen = buf.length;
      if (rec.markerBaseline > 0) {
        log(`supervisor: bayat marker tabanı ${key} — tamponda ${rec.markerBaseline} adet DONE:${rec.subtaskId} zaten var`);
      }
    }
    state.records[key] = rec;
    touch();
    persist();
    log(`supervisor: kayıt açıldı ${key} agent=${rec.agentId} pane=${rec.paneId} kanıt=${rec.evidencePath || '-'}`);
    void runBoardSync(rec, BOARD_PHASES.DISPATCH);
    return rec;
  }

  function settle(delegationId, subtaskId, outcome) {
    const key = recordKey(delegationId, subtaskId);
    const rec = state.records[key];
    if (!rec || isTerminalStatus(rec.status)) return false;
    let status = (outcome && outcome.status) || 'done';
    let by = SETTLE_SOURCES.RENDERER;
    let reason = (outcome && outcome.reason) || null;

    if (status !== 'done') {
      const seen = evidenceSeen(rec, io);
      if (seen) {
        log(`supervisor: motor '${status}' dedi ama KANIT DİSKTE (${seen.path}) → hüküm DONE'a düzeltildi (${key})`);
        reason = `motor '${status}' dedi (${reason || 'sebep yok'}); supervisor beklenen çıktıyı diskte buldu: ${seen.path}`;
        status = 'done';
        by = SETTLE_SOURCES.EVIDENCE;
      }
    }
    const corrected = by !== SETTLE_SOURCES.RENDERER;
    markSettled(rec, status, by, reason);
    rec.settleOrigin = 'renderer';
    rec.notifiedAt = corrected ? 0 : now();
    rec.advancedAt = corrected ? 0 : now();
    if (outcome && outcome.note) rec.note = String(outcome.note).slice(0, 400);
    if (!cfg.ownLeaderWake) rec.wake.ackedAt = now();
    touch();
    persist();
    return true;
  }

  function ack(leaderId) {
    let n = 0;
    const t = now();
    for (const rec of Object.values(state.records)) {
      if (rec.leaderId === leaderId && rec.wake && !rec.wake.ackedAt && isTerminalStatus(rec.status)) {
        rec.wake.ackedAt = t;
        n++;
      }
    }
    if (n) { touch(); persist(); log(`supervisor: lider ack (${leaderId}) — ${n} kayıt kapandı`); }
    return n;
  }

  async function sweep() {
    if (sweeping) return;
    sweeping = true;
    try {
      const t = now();
      const panes = paneIndex();
      lastPaneCount = panes.size;
      reconcilePaneIdentity(panes);

      // 1) Uçuştaki kayıtlar: teslimat doğrulama + çoklu-sinyal tespiti
      for (const rec of Object.values(state.records)) {
        if (isTerminalStatus(rec.status)) continue;
        const pane = rec.paneId ? panes.get(rec.paneId) : null;
        if (await verifyDelivery(rec, pane, t, { io, cfg, deliver, safeBuffer, markSettled, touch, log })) continue;
        const verdict = detect(rec, pane, t, { io, cfg, touch, touchSoft, safeBuffer, log });
        if (verdict) {
          if (pane && typeof pane.bytes === 'number') rec.paneSeen = { bytes: pane.bytes, at: t };
          markSettled(rec, verdict.status, verdict.by, verdict.reason);
          log(`supervisor: TESPİT ${rec.key} → ${verdict.status} (${verdict.by})`);
        }
      }

      // 2) Terminal kayıtlar: notify → kuyruk ilerlet → hayalet pane reap
      for (const rec of Object.values(state.records)) {
        if (!isTerminalStatus(rec.status)) continue;
        if (rec.settledBy !== SETTLE_SOURCES.RENDERER) {
          notifyOnce(rec, { io, touch, log, now });
          await advanceQueue(rec, { io, touch, log, now });
        }
        if (rec.status === 'done' && rec.board && !rec.board.reviewAt) {
          if (evidenceSeen(rec, io)) {
            void runBoardSync(rec, BOARD_PHASES.DONE);
          } else if (!rec.boardNoEvidenceLogged) {
            rec.boardNoEvidenceLogged = true;
            touch();
            log(`supervisor: ${rec.key} 'done' ama KANIT diskte yok → board statüsü DEĞİŞTİRİLMEDİ`);
          }
        }
        reapGhostPane(rec, panes, t, { state, cfg, io, touch, log, now });
      }

      // 2.5) ENT-F1 — ekranda ASILI kalmış prompt'ları kurtar
      await recoverHangingPrompts(panes, t, { state, cfg, io, deliver, safeBuffer, touch, log, now });

      // 3) ADP-692 KANAL A — liderin tur-başı brifingi
      consumeBriefings(t, { state, io, touch, persist, log });

      // 4) Uyandırma TESLİMAT doğrulaması → lider uyandırma
      verifyWakes(panes, t, { state, cfg, io, touch, log });
      await wakeLeaders(panes, t, { state, cfg, io, deliver, safeBuffer, lastDeferLog, touch, persist, log, now });

      prune(t, panes, { state, cfg, touch });
      persist({ includeSoft: true });
      scheduleWakeFollowUp(t, {
        state,
        cfg,
        sweep,
        getFollowUpTimer: () => followUpTimer,
        setFollowUpTimer: (val) => { followUpTimer = val; },
      });
    } catch (err) {
      log(`supervisor: sweep hatası: ${(err && err.message) || err}`);
    } finally {
      sweeping = false;
    }
  }

  function doRepairAfterRestart() {
    return repairAfterRestart({
      state,
      paneIndex,
      reconcilePaneIdentity,
      markSettled,
      evidenceChanged,
      io,
      log,
      persist,
      now,
    });
  }

  function start() {
    doRepairAfterRestart();
    if (timer) return;
    timer = setInterval(() => { void sweep(); }, cfg.tickMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    log(`supervisor: başladı (tick=${cfg.tickMs}ms, ${Object.keys(state.records).length} kayıt)`);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (followUpTimer) { clearTimeout(followUpTimer); followUpTimer = null; }
    lastSoftPersistAt = 0;
    persist({ includeSoft: true });
  }

  function leaderStatus(leaderId) {
    const t = now();
    const panes = paneIndex();
    const wanted = String(leaderId || '').trim();
    const all = Object.values(state.records);
    const claimedPanes = new Set(all.filter((r) => r.paneId).map((r) => r.paneId));
    const records = all
      .filter((r) => !wanted || r.leaderId === wanted)
      .sort((a, b) => (a.dispatchedAt || 0) - (b.dispatchedAt || 0))
      .map((r) => ({
        delegationId: r.delegationId,
        subtaskId: r.subtaskId,
        agentId: r.agentId,
        leaderId: r.leaderId,
        department: r.department,
        taskCode: r.taskCode,
        title: r.title,
        paneId: r.paneId,
        evidencePath: r.evidencePath,
        status: r.status || 'in-flight',
        settledBy: r.settledBy,
        reason: r.reason,
        note: r.note,
        dispatchedAt: r.dispatchedAt || 0,
        settledAt: r.settledAt || 0,
        ageMs: t - (r.dispatchedAt || t),
        paneAlive: r.paneId ? panes.has(r.paneId) : false,
        leaderNotified: !!(r.wake && (r.wake.deliveredAt || r.wake.ackedAt)),
        board: r.board || null,
      }));
    const untracked = [...panes.values()]
      .filter((p) => p.disallowSubagent === true && !claimedPanes.has(p.paneId))
      .map((p) => ({ paneId: p.paneId, agentId: p.agentId || null, command: p.command || null }));
    return { at: t, records, untracked };
  }

  return {
    record,
    settle,
    ack,
    sweep,
    leaderStatus,
    start,
    stop,
    repairAfterRestart: doRepairAfterRestart,
    markExternalShutdown: (signal) => markExternalShutdown(signal, { state, touch, persist, log, now }),
    externalShutdownNote,
    consumeBriefings: (t) => consumeBriefings(typeof t === 'number' ? t : now(), { state, io, touch, persist, log }),
    snapshot: () => JSON.parse(JSON.stringify(state)),
    config: () => ({ ...cfg }),
  };
}

module.exports = {
  createDelegationSupervisor,
};
