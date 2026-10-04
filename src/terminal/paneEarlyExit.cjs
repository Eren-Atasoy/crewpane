// WIN-FIRSTRUN-01 (K2) — ERKEN ÖLÜM: AÇILIŞTA KAPANAN MOTORUN ÇIKTISI EKRANDA KALIR.
//
// ─── NEDEN ───────────────────────────────────────────────────────────────────
// RESEARCH-WIN-01 §4.3: bir pane sıfırdan farklı kodla ölünce renderer hücreyi
// ANINDA kapatır (`Terminal.applyExit → TerminalPanel.onExit → closeCell`). Motor
// açılışta tek satır hata basıp 1 sn içinde çıktığında o satır hiç okunamaz —
// müşteri 90 dakikada 70 pane açtı, hiçbirinde hata metnini göremedi.
// `keepExitedPanes` ayarı bunu ÇÖZMEZ: her ölü pane'i tutan kaba bir düğmedir ve
// varsayılanı kapalıdır (ilk-gün kullanıcısı onu bilmez).
//
// ─── KARAR ───────────────────────────────────────────────────────────────────
// DAR kural: kod≠0 + kendi kendine (sinyalsiz, kapanış dışı) + spawn'dan < 5 sn
// → "erken ölüm". Renderer bu bayrağı görünce hücreyi KAPATMAZ, motorun bastığı
// baytların altına "motor açılışta kapandı" satırı yazar. Normal bitişler (kod 0),
// bizim öldürdüklerimiz (sinyal / 128+N), kapanış ve uzun oturum sonrası ölümler
// bugünkü yolda kalır — davranış yalnız 5 saniyelik pencerede değişir.
//
// `firstDataBytes` = ölüm anına kadar pane'in ürettiği TOPLAM bayt (0 = motor tek
// bayt basmadan öldü; ADP-694'ün "exec başarısız" imzası). Renderer için bilgi,
// Sentry için etiket (K5).
//
// Saf: electron bağı yok → `node --test electron/paneEarlyExit.test.cjs`.

'use strict';

const paneExit = require('../../telemetry/paneExit.cjs');

/** "Erken" penceresi (kart önerisi 5 sn). */
const EARLY_EXIT_WINDOW_MS = 5000;

/**
 * @param {object} e
 * @param {number} e.exitCode
 * @param {number|string|null} [e.signal]
 * @param {boolean} [e.quitting]
 * @param {boolean} [e.preserve]
 * @param {number} e.msSinceSpawn
 * @param {number} [e.bytes]              ölüme kadar üretilen bayt
 * @param {number} [e.windowMs]           varsayılan EARLY_EXIT_WINDOW_MS
 * @returns {{early:boolean, reason:string, msSinceSpawn:number, firstDataBytes:number}}
 */
function classifyEarlyExit(e = {}) {
  const msSinceSpawn = Number.isFinite(Number(e.msSinceSpawn)) ? Math.max(0, Math.round(Number(e.msSinceSpawn))) : -1;
  const firstDataBytes = Number.isFinite(Number(e.bytes)) ? Math.max(0, Math.round(Number(e.bytes))) : 0;
  const windowMs = Number(e.windowMs) > 0 ? Number(e.windowMs) : EARLY_EXIT_WINDOW_MS;
  const base = { msSinceSpawn, firstDataBytes };
  const exitCode = Number(e.exitCode);
  if (exitCode === 0) return { early: false, reason: 'normal-exit', ...base };
  if (!Number.isFinite(exitCode)) return { early: false, reason: 'unknown-exit-code', ...base };
  if (e.signal) return { early: false, reason: 'signalled', ...base };
  if (e.quitting) return { early: false, reason: 'app-quitting', ...base };
  if (e.preserve) return { early: false, reason: 'preserved', ...base };
  // 128+N (POSIX) ve iyi huylu NTSTATUS (Windows) = biz/kabuk kapattı, açılış arızası değil.
  if (paneExit.signalFromExitCode(exitCode)) return { early: false, reason: 'signalled-in-code', ...base };
  if (paneExit.benignWindowsExit(exitCode)) return { early: false, reason: 'benign-win-exit', ...base };
  if (msSinceSpawn < 0) return { early: false, reason: 'no-spawn-time', ...base };
  if (msSinceSpawn >= windowMs) return { early: false, reason: 'after-window', ...base };
  return { early: true, reason: firstDataBytes === 0 ? 'early-silent' : 'early-with-output', ...base };
}

module.exports = { classifyEarlyExit, EARLY_EXIT_WINDOW_MS };
