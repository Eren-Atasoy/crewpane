'use strict';

const { isTerminalStatus, GATE_REASON_TR } = require('./constants.cjs');
const { wakeDue, wakeTextFor } = require('./stateRecord.cjs');
const { injectionGate } = require('../leaderComposer.cjs');
const { pendingTextOnScreen } = require('../deliverPrompt.cjs');

/** Liderin KENDİ pane'i = ajan kimliği lider olan, delegasyon EXECUTION pane'i OLMAYAN. */
function findLeaderPane(panes, leaderId) {
  for (const p of panes.values()) {
    if (p.agentId === leaderId && p.disallowSubagent !== true) return p;
  }
  return null;
}

function canVerifyWake(paneId, io) {
  try { return io.wakeVerifiable(paneId) === true; } catch { return false; }
}

/**
 * ADP-672 — YAZILDI mı, ULAŞTI mı? Yazımdan `wakeVerifyMs` sonra liderin oturum
 * defterinde mesaj aranır.
 */
function verifyWakes(panes, t, ctx) {
  const { state, cfg, io, touch, log } = ctx;
  for (const rec of Object.values(state.records)) {
    const wake = rec.wake;
    if (!wake || wake.ackedAt || !wake.deliveredAt || !wake.needle) continue;
    if (t - wake.deliveredAt < cfg.wakeVerifyMs) continue;
    const pane = findLeaderPane(panes, rec.leaderId);
    let seen = null;
    try { seen = pane ? io.leaderTranscriptHas(pane.paneId, wake.needle) : null; } catch { seen = null; }
    if (seen === true) {
      wake.ackedAt = t;
      wake.verified = true;
      touch();
      log(`supervisor: uyandırma liderin defterinde DOĞRULANDI (${rec.key})`);
      continue;
    }
    if (seen === false) {
      wake.lost = (wake.lost || 0) + 1;
      wake.deliveredAt = 0;
      wake.enterOnlyNext = !!wake.needle;
      wake.needle = null;
      touch();
      if (wake.lost >= cfg.wakeLostMax) {
        wake.ackedAt = t; // pane kanalı bu kayıt için tükendi — notify-log kalıcı iz taşıyor
        log(`supervisor: uyandırma ${wake.lost} kez YUTULDU (${rec.key}) — pane kanalı bırakıldı, notify-log'da duruyor`);
      } else {
        log(`supervisor: uyandırma liderin defterine GİRMEMİŞ (${rec.key}) — yutuldu, yeniden yazılacak (${wake.lost}. kez)`);
      }
      continue;
    }
    // Bakılamadı → ADP-667 davranışı: yazıldıysa görülmüş say (yanlış tekrar üretme).
    wake.ackedAt = t;
    touch();
  }
}

/**
 * ADP-692 — KANAL A MAKBUZUNU TÜKET. Liderin `UserPromptSubmit` hook'u bir bitişi tur
 * başında anlattıysa lider ONU ZATEN BİLİYOR: kayıt ack'lenir ve pane'e ASLA yazılmaz.
 */
function consumeBriefings(t, ctx) {
  const { state, io, touch, persist, log } = ctx;
  let receipt = null;
  try { receipt = io.readBriefingReceipts(); } catch { receipt = null; }
  const entries = (receipt && receipt.entries) || null;
  if (!entries) return 0;
  let acked = 0;
  for (const [key, meta] of Object.entries(entries)) {
    const rec = state.records[key];
    if (!rec || !rec.wake) continue;
    if (rec.wake.briefedAt) continue;
    rec.wake.briefedAt = (meta && meta.at) || t;
    rec.wake.ackedAt = rec.wake.ackedAt || rec.wake.briefedAt;
    rec.wake.channel = 'briefing';
    touch();
    acked++;
  }
  if (acked) {
    log(`supervisor: ${acked} bitişi lider TUR BAŞINDA okudu (kanal A) — pane'e enjeksiyon YOK`);
    persist();
  }
  return acked;
}

/**
 * LİDER UYANDIRMA — kalıcı, backoff'lu, ack'e kadar tekrarlı.
 */
async function wakeLeaders(panes, t, ctx) {
  const { state, cfg, io, deliver, safeBuffer, lastDeferLog, touch, persist, log, now } = ctx;
  const byLeader = new Map();
  for (const rec of Object.values(state.records)) {
    if (!isTerminalStatus(rec.status) || !rec.leaderId) continue;
    if ((rec.wake.attempts || 0) === 0 && t - (rec.settledAt || 0) < cfg.wakeCoalesceMs) continue;
    if (!wakeDue(rec.wake, t, cfg.wakeBackoffMs, cfg.wakeAckWindowMs, cfg.wakeRetryBusyMs)) continue;
    if ((rec.wake.attempts || 0) >= cfg.wakeAttemptsMax) continue;
    const list = byLeader.get(rec.leaderId) || [];
    list.push(rec);
    byLeader.set(rec.leaderId, list);
  }
  for (const [leaderId, recs] of byLeader) {
    const leaderPane = findLeaderPane(panes, leaderId);
    const stamp = (busy) => {
      for (const r of recs) {
        if (busy) {
          r.wake.defers = (r.wake.defers || 0) + 1;
          r.wake.busyAt = t;
        } else {
          r.wake.attempts = (r.wake.attempts || 0) + 1;
          r.wake.busyAt = 0;
        }
        r.wake.lastAt = t;
      }
      touch();
    };
    if (!leaderPane) {
      continue;
    }
    const prevLog = lastDeferLog.get(leaderId) || { at: 0, reason: null, count: 0 };
    if (t - prevLog.at >= 30_000) {
      log(`supervisor: lider ${leaderId} composer örneklemesi başladı (gap=${cfg.wakeSampleGapMs}ms)`);
    }
    const a = safeBuffer(leaderPane.paneId);
    await io.sleep(cfg.wakeSampleGapMs);
    const b = safeBuffer(leaderPane.paneId);
    const inputOpts = () => {
      let lastInputAt = null;
      let lastSubmitAt = null;
      try { lastInputAt = io.lastInputAt(leaderPane.paneId); } catch { lastInputAt = null; }
      try { lastSubmitAt = io.lastSubmitAt(leaderPane.paneId); } catch { lastSubmitAt = null; }
      return {
        lastInputAt,
        lastSubmitAt,
        now: now(),
        quietMs: cfg.wakeInputQuietMs,
        draftGraceMs: cfg.wakeDraftGraceMs,
      };
    };
    const gate = injectionGate(a, b, inputOpts());
    if (!gate.safe) {
      stamp(true);
      const curDefers = recs[0].wake.defers || 0;
      const reasonChanged = gate.reason !== prevLog.reason;
      const timePassed = (t - prevLog.at >= 30_000);
      if (curDefers === 1 || reasonChanged || timePassed) {
        lastDeferLog.set(leaderId, { at: t, reason: gate.reason, count: curDefers });
        log(
          `supervisor: lider ${leaderId} ${GATE_REASON_TR[gate.reason] || gate.reason} — enjeksiyon YAPILMADI ` +
            `(erteleme ${curDefers}, yazım denemesi ${recs[0].wake.attempts || 0} — bütçe HARCANMADI; ` +
            `bitişler defterde duruyor, lider tur başında OKUYACAK)`,
        );
      }
      continue;
    }
    lastDeferLog.delete(leaderId);
    const text = wakeTextFor(recs);
    const c = safeBuffer(leaderPane.paneId);
    const finalGate = injectionGate(b, c, inputOpts());
    if (!finalGate.safe) {
      stamp(true);
      log(
        `supervisor: lider ${leaderId} — SON AN kontrolünde ${GATE_REASON_TR[finalGate.reason] || finalGate.reason}, ` +
          `enjeksiyon İPTAL (yarım prompt riski önlendi)`,
      );
      continue;
    }
    log(`supervisor: guard OK ${leaderId} — son satır: ${JSON.stringify(c.replace(/\s+/g, ' ').slice(-80))}`);

    const wantEnterOnly = recs.some((r) => r.wake && r.wake.enterOnlyNext);
    const enterOnlyNow = wantEnterOnly && pendingTextOnScreen(c);
    let wrote = false;
    if (enterOnlyNow) {
      log(`supervisor: lider ${leaderId} — mesaj composer'da ASILI, metin TEKRAR YAZILMIYOR (yalnız ENTER)`);
      wrote = true;
    } else {
      try { wrote = io.writePane(leaderPane.paneId, text) === true; } catch { wrote = false; }
    }
    let delivery = null;
    if (wrote) {
      delivery = await deliver(leaderPane.paneId, text, {
        mode: enterOnlyNow ? 'enter-only' : 'submit-only',
        label: `lider-uyandırma ${leaderId}`,
      });
      if (!delivery.enters) wrote = false;
    }
    stamp(false);
    if (wrote) {
      for (const r of recs) {
        r.wake.deliveredAt = t;
        r.wake.needle = String(text).slice(0, 160);
        r.wake.submitOutcome = delivery ? delivery.outcome : null;
        r.wake.textWrittenAt = t;
        r.wake.enterOnlyNext = false;
        if (!canVerifyWake(leaderPane.paneId, io)) {
          r.wake.ackedAt = t;
          r.wake.ackAssumed = true;
        }
      }
      touch();
      const assumed = recs.some((r) => r.wake && r.wake.ackAssumed);
      log(
        `supervisor: lider uyandırıldı ${leaderId} (${recs.length} kayıt TEK mesajda, deneme ${recs[0].wake.attempts})`
        + (assumed ? ' — ⚠️ TESLİM DOĞRULANAMIYOR (bu pane\'de oturum defteri yok): ack VARSAYILDI' : ''),
      );
    }
  }
  persist();
}

/**
 * ADP-667 — bekleyen bir uyandırmanın vadesi bir sonraki tick'ten ÖNCE doluyorsa
 * tek-atışlık ek sweep planla.
 */
function scheduleWakeFollowUp(t, ctx) {
  const { state, cfg, sweep, getFollowUpTimer, setFollowUpTimer } = ctx;
  let nextAt = Infinity;
  for (const rec of Object.values(state.records)) {
    if (!isTerminalStatus(rec.status) || !rec.leaderId) continue;
    const wake = rec.wake || {};
    if (wake.ackedAt || (wake.attempts || 0) >= cfg.wakeAttemptsMax) continue;
    const due =
      (wake.attempts || 0) === 0
        ? (rec.settledAt || t) + cfg.wakeCoalesceMs
        : (wake.lastAt || t) + (wake.busyAt === wake.lastAt ? cfg.wakeRetryBusyMs : 0);
    if (due < nextAt) nextAt = due;
  }
  if (!Number.isFinite(nextAt)) return;
  const delay = Math.max(250, nextAt - t + 100);
  if (delay >= cfg.tickMs) return; // normal tick zaten yetişir
  if (getFollowUpTimer()) return;
  const timer = setTimeout(() => {
    setFollowUpTimer(null);
    void sweep();
  }, delay);
  if (timer && typeof timer.unref === 'function') timer.unref();
  setFollowUpTimer(timer);
}

module.exports = {
  findLeaderPane,
  canVerifyWake,
  verifyWakes,
  consumeBriefings,
  wakeLeaders,
  scheduleWakeFollowUp,
};
