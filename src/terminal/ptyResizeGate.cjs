// WIN-FIRSTRUN-01 (K3) — ÖLÜ PTY'YE RESIZE GİTMEZ (Windows'un ertelenmiş resize'ı).
//
// ─── ÖLÇÜLDÜ (node-pty 1.1.0 `lib/windowsTerminal.js`, RESEARCH-WIN-01 §4.2) ─────
// Windows'ta `resize()` pty "hazır" (`_isReady`) olana kadar KUYRUĞA girer ve o an
// hata FIRLATMAZ; hazırlık = out-socket'in İLK `data` olayı. Kuyruk o ilk veri
// geldiğinde, bizim `onData` dinleyicimizden ÖNCE koşar. Motor açılışta tek satır
// hata basıp çıkarsa sıra şöyle olur:
//   spawn → renderer fit() → pty:resize (kuyruğa) → motor hata basar + ÇIKAR
//   (`_exitCode` yazılır) → hata metni "ilk data" olarak gelir → kuyruk koşar →
//   `windowsPtyAgent.resize`: `_exitCode !== undefined` → throw "Cannot resize a pty
//   that has already exited" → IPC handler'ın try/catch'i DIŞINDA → uncaughtException
//   → Sentry `CREWPANE-PROD-48` (fatal) + bildirim merkezinde ham hata gövdesi.
// Resize motoru öldürmedi; motor ölünce resize patladı. POSIX'te (`unixTerminal`)
// erteleme yok: ölü pty'de senkron EBADF → handler'ın catch'i yakalar, olay yok.
//
// ─── KARAR ───────────────────────────────────────────────────────────────────
// Ertelemeyi node-pty'ye BIRAKMA, kendin yap: win32'de ilk data chunk'ı gelene kadar
// `resize` çağrılmaz; boyut `entry.pendingResize`de bekler ve ilk chunk'ta (artık
// `_isReady` true, çağrı senkron) try/catch İÇİNDE uygulanır. Motor o ana kadar
// öldüyse çağrı yine throw eder ama YAKALANIR ("resize skipped (dead pane)").
// Davranışsal fark yok: node-pty zaten aynı ana kadar bekliyordu; tek fark
// throw'un sahibi. POSIX: bit-bit aynı (hemen uygula).
//
// Saf karar fonksiyonu; `platform` enjekte edilir ki Windows dalı macOS'ta ölçülsün.

'use strict';

/**
 * @param {object} o
 * @param {string} o.platform   'win32' | 'darwin' | 'linux'
 * @param {boolean} o.ready     pane ilk data chunk'ını aldı mı (entry.firstDataAt > 0)
 * @returns {'apply'|'defer'}
 */
function resizeDecision(o = {}) {
  if (o.platform !== 'win32') return 'apply';
  return o.ready ? 'apply' : 'defer';
}

/**
 * Gelen resize'ı uygula ya da beklet. `entry` main'in pane defteri girdisidir;
 * `apply(cols, rows)` gerçek çağrıdır (throw edebilir — çağıran yakalar).
 * → { action:'applied'|'deferred' }
 */
function handleResize(entry, cols, rows, o = {}) {
  const decision = resizeDecision({ platform: o.platform, ready: !!(entry && entry.firstDataAt) });
  if (decision === 'defer') {
    entry.pendingResize = { cols, rows };
    return { action: 'deferred' };
  }
  o.apply(cols, rows);
  return { action: 'applied' };
}

/**
 * İlk data chunk'ı geldi: bekleyen resize varsa ŞİMDİ uygula (try/catch çağıranda).
 * → { cols, rows } | null (bekleyen yoktu)
 */
function takePendingResize(entry) {
  if (!entry || !entry.pendingResize) return null;
  const p = entry.pendingResize;
  entry.pendingResize = null;
  return p;
}

module.exports = { resizeDecision, handleResize, takePendingResize };
