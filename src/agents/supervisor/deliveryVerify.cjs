'use strict';

const { SETTLE_SOURCES, GATE_REASON_TR, isTerminalStatus } = require('./constants.cjs');
const { deliveryVerdict } = require('./stateRecord.cjs');
const { humanPresence } = require('../leaderComposer.cjs');
const { pendingTextOnScreen } = require('../deliverPrompt.cjs');

/**
 * Dispatch worker'a GERÇEKTEN ulaştı mı? Ulaşmadıysa supervisor KENDİ yeniden
 * gönderir; yeniden gönderim de tutmazsa dürüstçe 'undelivered' damgalar.
 *
 * @returns {Promise<boolean>} kayıt bu tick'te terminal oldu mu
 */
async function verifyDelivery(rec, pane, t, ctx) {
  const { io, cfg, deliver, safeBuffer, markSettled, touch, log } = ctx;
  const del = rec.delivery;
  if (del.verified === true) return false;
  if (!rec.promptPayload && !rec.promptSignature) return false; // doğrulanacak imza yok
  if (t - rec.dispatchedAt < cfg.deliveryCheckMs) return false;
  if (del.lastAt && t - del.lastAt < cfg.deliveryCheckMs) return false;

  let transcript = null;
  try { transcript = io.transcriptHas(rec); } catch { transcript = null; }
  const verdict = deliveryVerdict({
    transcript,
    buffer: pane && rec.promptSignature ? safeBuffer(rec.paneId) : '',
    signature: rec.promptSignature,
  });
  del.lastAt = t;
  touch();

  if (verdict === null) return false;   // bakılamadı → ASLA undelivered (ADP-280 kuralı)
  if (verdict === true) { del.verified = true; log(`supervisor: teslim doğrulandı ${rec.key}`); return false; }

  // TESLİM EDİLMEMİŞ — resume-picker/boot yutması. Kendi yeniden gönder.
  if (del.attempts < cfg.deliveryResendMax && rec.paneId && rec.promptPayload) {
    del.attempts += 1;
    const pendingNow = pendingTextOnScreen(safeBuffer(rec.paneId));
    const enterOnly = del.attempts > 1 && !!del.textWrittenAt && pendingNow;
    const res = await deliver(rec.paneId, rec.promptPayload, {
      mode: enterOnly ? 'enter-only' : 'auto',
      textWrittenAt: del.textWrittenAt || null,
      label: `yeniden-gönderim#${del.attempts} ${rec.key}`,
    });
    if (res.wroteText && res.textWrittenAt) del.textWrittenAt = res.textWrittenAt;
    if (res.delivered) {
      del.deliveredAt = t;
    }
    log(
      `supervisor: teslim YOK ${rec.key} → yeniden gönderim #${del.attempts} ` +
        `(${res.delivered ? 'teslim doğrulandı' : `teslim DOĞRULANAMADI: ${res.reason}`}, ` +
        `ekrandaBekleyenMetin=${pendingNow}, mod=${enterOnly ? 'enter-only' : 'auto'}, ` +
        `metin=${res.wroteText ? 'yazıldı' : 'yazılmadı'}, enter=${res.enters})`,
    );
    touch();
    return false;
  }

  markSettled(
    rec,
    'undelivered',
    SETTLE_SOURCES.PANE_EXIT,
    `prompt worker'ın oturum defterine (transcript) hiç düşmedi — ${del.attempts} yeniden-gönderim de teslim edemedi; ` +
      `pane geri kazanılıyor, işi TAZE bir pane'e yeniden delege et`,
  );
  return true;
}

/**
 * ASILI PROMPT KURTARMA TARAMASI (yalnız `\r`).
 */
async function recoverHangingPrompts(panes, t, ctx) {
  const { state, cfg, io, deliver, safeBuffer, touch, log, now } = ctx;
  for (const rec of Object.values(state.records)) {
    if (isTerminalStatus(rec.status)) continue;
    const del = rec.delivery;
    if (!del || del.verified === true) continue;
    if (!rec.paneId || !panes.has(rec.paneId)) continue;
    if (t - rec.dispatchedAt < cfg.deliveryCheckMs) continue;
    if (del.recoverAt && t - del.recoverAt < cfg.deliveryCheckMs) continue;

    const a = safeBuffer(rec.paneId);
    if (!pendingTextOnScreen(a)) continue; // ekranda bekleyen metin YOK → dokunma
    await io.sleep(cfg.wakeSampleGapMs);
    const b = safeBuffer(rec.paneId);
    let lastInputAt = null;
    let lastSubmitAt = null;
    try { lastInputAt = io.lastInputAt(rec.paneId); } catch { lastInputAt = null; }
    try { lastSubmitAt = io.lastSubmitAt(rec.paneId); } catch { lastSubmitAt = null; }

    const presence = humanPresence({
      lastInputAt,
      lastSubmitAt,
      now: now(),
      quietMs: cfg.wakeInputQuietMs,
      draftGraceMs: cfg.wakeDraftGraceMs,
    });
    if (presence.present) {
      del.recoverAt = t;
      touch();
      log(
        `supervisor: ${rec.key} composer'ında asılı prompt VAR ama İNSAN etkileşimde ` +
          `(${GATE_REASON_TR[presence.reason] || presence.reason}) — ENTER BASILMADI`,
      );
      continue;
    }
    // Ekran iki okuma arasında DEĞİŞTİYSE TUI hâlâ çiziyor ya da biri yazıyor → ertele.
    if (a !== b) { del.recoverAt = t; touch(); continue; }

    del.recoverAt = t;
    del.recovered = (del.recovered || 0) + 1;
    touch();
    const res = await deliver(rec.paneId, rec.promptPayload || '', {
      mode: 'enter-only',
      label: `kurtarma#${del.recovered} ${rec.key}`,
    });
    log(
      `supervisor: ASILI PROMPT kurtarma ${rec.key} → ` +
        `${res.delivered ? 'teslim doğrulandı' : `hâlâ ${res.outcome} (${res.reason})`} ` +
        `(enter=${res.enters}, metin=YAZILMADI)`,
    );
  }
}

module.exports = {
  verifyDelivery,
  recoverHangingPrompts,
};
