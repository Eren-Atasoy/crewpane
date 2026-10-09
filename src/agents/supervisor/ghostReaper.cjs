'use strict';

const { SETTLE_SOURCES, isTerminalStatus } = require('./constants.cjs');

function notifyOnce(rec, ctx) {
  const { io, touch, log, now } = ctx;
  if (rec.notifiedAt) return;
  const kind = rec.status === 'done' ? 'done' : 'fail';
  try {
    const res = io.notify({
      kind,
      task: rec.taskCode || rec.subtaskId,
      detail: rec.status === 'done'
        ? `${rec.agentId ? `${rec.agentId}: ` : ''}${rec.evidencePath || rec.title || ''}`.trim() || undefined
        : rec.reason || undefined,
      department: rec.department || undefined,
      delegationId: rec.delegationId,
      subtaskId: rec.subtaskId,
      evidence: rec.evidencePath || undefined,
    });
    if (res && res.duplicate) log(`supervisor: bildirim zaten yazılmış, tekrarlanmadı (${rec.key})`);
    rec.notifiedAt = now();
    touch();
  } catch { /* notify best-effort */ }
}

/** Kuyruğu ilerlet: renderer'a "bu iş bitti, defterini hizala + kuyruğu boşalt" push'u. */
async function advanceQueue(rec, ctx) {
  const { io, touch, log, now } = ctx;
  if (rec.advancedAt) return;
  let ok = false;
  try {
    ok = await io.pushRenderer('dlgsup:advance', {
      delegationId: rec.delegationId,
      subtaskId: rec.subtaskId,
      agentId: rec.agentId,
      status: rec.status,
      reason: rec.reason,
      settledBy: rec.settledBy,
      evidencePath: rec.evidencePath,
    });
  } catch { ok = false; }
  if (ok) {
    rec.advancedAt = now();
    touch();
    log(`supervisor: kuyruk ilerletildi ${rec.key} (${rec.settledBy})`);
  }
}

/**
 * HAYALET PANE REAP — settle olmuş kaydın execution pane'i hâlâ ayakta duruyorsa
 * geri kazan.
 */
function reapGhostPane(rec, panes, t, ctx) {
  const { state, cfg, io, touch, log, now } = ctx;
  if (rec.reapedAt || !rec.paneId) return;
  const pane = panes.get(rec.paneId);
  if (!pane) { rec.reapedAt = now(); touch(); return; } // zaten yok
  if (pane.disallowSubagent !== true) { rec.reapedAt = now(); touch(); return; } // lider/insan pane'i — ASLA
  if (rec.settledBy === SETTLE_SOURCES.RENDERER || rec.settleOrigin === 'renderer') { rec.reapedAt = now(); touch(); return; }
  if (t - (rec.settledAt || 0) < cfg.reapGraceMs) return;
  for (const other of Object.values(state.records)) {
    if (other.key !== rec.key && other.paneId === rec.paneId && !isTerminalStatus(other.status)) return;
  }
  const bytesNow = typeof pane.bytes === 'number' ? pane.bytes : null;
  if (bytesNow !== null) {
    if (rec.postSettle == null || rec.postSettle.bytes !== bytesNow) {
      rec.postSettle = { bytes: bytesNow, at: t };
      touch();
      return; // yeni çıktı → sessizlik saati sıfırlandı
    }
    if (t - rec.postSettle.at < cfg.reapGraceMs) return;
  }
  let done = false;
  try { done = io.reapPane(rec.paneId, `supervisor ${rec.settledBy}`); } catch { done = false; }
  if (done) {
    rec.reapedAt = now();
    touch();
    log(`supervisor: hayalet pane reap edildi ${rec.paneId} (${rec.key})`);
  }
}

/**
 * KILL-GUARD-01 — DIŞ KAPANIŞ DAMGASI.
 */
function markExternalShutdown(signal, ctx) {
  const { state, touch, persist, log, now } = ctx;
  const t = now();
  const hit = [];
  for (const rec of Object.values(state.records)) {
    if (isTerminalStatus(rec.status)) continue;
    rec.externalShutdown = { signal: String(signal || 'signal'), at: t };
    hit.push({
      taskCode: rec.taskCode || null,
      agentId: rec.agentId || null,
      title: rec.title || null,
      subtaskId: rec.subtaskId || null,
    });
  }
  if (hit.length) {
    touch();
    persist(); // ÇIKIŞ ANINDA: bir sonraki tick gelmeyecek
    log(`supervisor: dış kapanış (${signal}) — ${hit.length} uçuştaki delegasyon damgalandı`);
  }
  return hit;
}

/** Dış kapanış damgasından tek satırlık devir notu (yoksa null). */
function externalShutdownNote(hits) {
  if (!hits || !hits.length) return null;
  const names = hits
    .map((h) => h.taskCode || h.title || h.agentId || h.subtaskId)
    .filter(Boolean)
    .slice(0, 6);
  return (
    `⚠️ DEVİR — ${hits.length} worker dış kapanışla kesildi (uygulama dışarıdan kapatıldı): ` +
    `${names.join(', ')}${hits.length > names.length ? ' …' : ''}. İşleri YARIM; yeniden dağıtman gerekebilir.`
  );
}

function repairAfterRestart(ctx) {
  const { state, paneIndex, reconcilePaneIdentity, markSettled, evidenceChanged, io, log, persist, now } = ctx;
  const panes = paneIndex();
  reconcilePaneIdentity(panes);
  let repaired = 0;
  const externallyKilled = [];
  for (const rec of Object.values(state.records)) {
    if (isTerminalStatus(rec.status)) continue;
    if (rec.paneId && panes.has(rec.paneId)) continue; // pane restore edildi → normal takip
    const ext = rec.externalShutdown;
    if (evidenceChanged(rec, io)) {
      markSettled(rec, 'done', SETTLE_SOURCES.REPAIR, null);
    } else if (ext) {
      markSettled(
        rec,
        'failed',
        SETTLE_SOURCES.EXTERNAL_KILL,
        `uygulama DIŞARIDAN kapatıldı (${ext.signal}) — pane öldü, iş yarım kaldı, kanıt yok`,
      );
      externallyKilled.push({
        taskCode: rec.taskCode || null,
        agentId: rec.agentId || null,
        title: rec.title || null,
        subtaskId: rec.subtaskId || null,
      });
    } else {
      markSettled(rec, 'failed', SETTLE_SOURCES.REPAIR, 'uygulama yeniden başladı, pane kayboldu ve kanıt yok');
    }
    rec.wake = { attempts: 0, lastAt: 0, deliveredAt: 0, ackedAt: 0 };
    repaired++;
  }
  if (repaired) {
    log(`supervisor: restart onarımı — ${repaired} öksüz kayıt dürüstçe kapatıldı`);
    const note = externalShutdownNote(externallyKilled);
    if (note) log(`supervisor: ${note}`);
    persist();
  }
  return repaired;
}

/**
 * Terminal + ack'lenmiş eski kayıtları buda.
 */
function prune(t, panes, ctx) {
  const { state, cfg, touch } = ctx;
  const keepByPane = new Map();
  if (panes && typeof panes.has === 'function') {
    for (const rec of Object.values(state.records)) {
      if (!rec.paneId || !panes.has(rec.paneId)) continue;
      const cur = keepByPane.get(rec.paneId);
      if (!cur || (rec.settledAt || 0) > (cur.settledAt || 0)) keepByPane.set(rec.paneId, rec);
    }
  }
  for (const [key, rec] of Object.entries(state.records)) {
    if (!isTerminalStatus(rec.status)) continue;
    if (t - (rec.settledAt || 0) < cfg.retentionMs) continue;
    if (rec.paneId && keepByPane.get(rec.paneId) === rec) continue;
    delete state.records[key];
    touch();
  }
}

module.exports = {
  notifyOnce,
  advanceQueue,
  reapGhostPane,
  markExternalShutdown,
  externalShutdownNote,
  repairAfterRestart,
  prune,
};
