'use strict';

const path = require('node:path');
const crashWatchdogCore = require('../../core/crashWatchdog.cjs');
const { createStallMonitor } = require('../../core/mainStallMonitor.cjs');

const ADVISE_TICKS = 12; // 12 × 5 sn ≈ 1 dk ısrarlı uyarı

function maybeAutoHeapSnapshot({
  heapSnapshotMb,
  appMetrics,
  crashWatchdog,
  BrowserWindow,
  app,
  logLine,
  state,
}) {
  if (!heapSnapshotMb || state.heapSnapshotTaken) return;
  const rendererMb = (crashWatchdog.memoryByType(appMetrics).Renderer || 0) / (1024 ** 2);
  if (rendererMb < heapSnapshotMb) return;
  if (!BrowserWindow || !BrowserWindow.getAllWindows) return;
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return;
  state.heapSnapshotTaken = true;
  const file = path.join(app.getPath('logs'), `renderer-${Date.now()}.heapsnapshot`);
  logLine(`[watchdog] renderer ${rendererMb.toFixed(0)}MB ≥ ${heapSnapshotMb}MB → heap snapshot yazılıyor: ${file}`);
  Promise.resolve(win.webContents.takeHeapSnapshot(file))
    .then(() => logLine(`[watchdog] heap snapshot yazıldı: ${file}`))
    .catch((e) => logLine(`[watchdog] heap snapshot BAŞARISIZ: ${e.message}`));
}

function maybeAdviseMemory({ assessment, panes, ptys, logLine, state }) {
  if (state.memAdvised) return;
  if (!assessment || assessment.level !== 'warn') {
    state.memAdviseStreak = 0;
    return;
  }
  state.memAdviseStreak += 1;
  if (state.memAdviseStreak < ADVISE_TICKS) return;
  state.memAdvised = true;
  const idle = (Array.isArray(panes) ? panes : []).filter((x) => x && x.bytesPerSec === 0).map((x) => x.paneId);
  const hint = idle.length
    ? `en eski boş pane'ler aday: ${idle.slice(0, 3).join(', ')}`
    : 'boş pane yok — açık pane sayısını azaltmak yardımcı olur';
  logLine(
    `⚠️ BELLEK UYARISI — ${(assessment.totalBytes / (1024 ** 2)).toFixed(0)} MB birleşik bellek, `
    + `${ptys ? ptys.size : 0} pane açık. ÖNERİ: kullanmadığın bir pane'i kapat (${hint}). `
    + 'Otomatik kapatma YAPILMADI — karar senin.',
  );
}

/**
 * Crash Watchdog & Stall Monitor Service (Faz 3.6.9)
 */
function createCrashWatchdogService(deps = {}) {
  const {
    app,
    BrowserWindow,
    ptys = new Map(),
    logLine = () => {},
    resourceGovernor = () => null,
    crashWatchdog = crashWatchdogCore,
    tickMs = Number(process.env.CREWPANE_WATCHDOG_TICK_MS || 5000),
    heapSnapshotMb = Number(process.env.CREWPANE_HEAP_SNAPSHOT_MB || 0),
  } = deps;

  let watchdogTimer = null;
  let watchdogPrevTotalBytes = null;
  let watchdogPrevPaneBytes = new Map();
  let watchdogPrevTickAt = null;
  let powerMonitorBound = false;
  const state = { heapSnapshotTaken: false, memAdviseStreak: 0, memAdvised: false };

  const mainStallMonitor = createStallMonitor({
    setInterval,
    clearInterval,
    now: Date.now,
    log: logLine,
    onStall: (ev) => {
      try {
        const gov = resourceGovernor();
        if (gov && typeof gov.noteStall === 'function') gov.noteStall(ev);
      } catch {
        /* bekçi yoksa durma izi yine günlükte */
      }
    },
  });


  function bindPowerMonitorToStallMonitor() {
    if (powerMonitorBound) return;
    try {
      const { powerMonitor } = require('electron');
      if (!powerMonitor || typeof powerMonitor.on !== 'function') return;
      powerMonitor.on('suspend', () => {
        try {
          mainStallMonitor.suspend();
          logLine('[main-power] sistem askıya alındı — durma ölçümü duraklatıldı');
        } catch {
          /* kanca asla açılışı düşürmez */
        }
      });
      powerMonitor.on('resume', () => {
        try {
          mainStallMonitor.resume();
          logLine('[main-power] sistem uyandı — ilk tik atlanacak (monitör sıfırlandı)');
        } catch {
          /* aynı */
        }
      });
      powerMonitorBound = true;
    } catch {
      /* headless/test: kanca yoksa tavan tek başına korur */
    }
  }

  let tickCount = 0;
  function watchdogTick() {
    try {
      const memUsage = process.memoryUsage();
      const appMetrics = app && app.getAppMetrics ? app.getAppMetrics() : [];
      maybeAutoHeapSnapshot({
        heapSnapshotMb,
        appMetrics,
        crashWatchdog,
        BrowserWindow,
        app,
        logLine,
        state,
      });
      const assessment = crashWatchdog.assessMemory({ memUsage, appMetrics }, watchdogPrevTotalBytes);
      const now = Date.now();
      const currPaneBytes = new Map();
      if (ptys) {
        for (const [paneId, entry] of ptys) currPaneBytes.set(paneId, entry.bytes || 0);
      }
      const dtMs = watchdogPrevTickAt ? now - watchdogPrevTickAt : 0;
      const panes = crashWatchdog.paneThroughput(watchdogPrevPaneBytes, currPaneBytes, dtMs);

      const heartbeatDue = assessment.level === 'warn' || panes.some((p) => p.burst);
      tickCount += 1;
      if (heartbeatDue || tickCount % 6 === 0) {
        logLine(crashWatchdog.formatHeartbeat({
          memUsage, assessment, panes, appMetrics, at: new Date().toISOString(),
        }));
      }
      maybeAdviseMemory({ assessment, panes, ptys, logLine, state });
      watchdogPrevTotalBytes = assessment.totalBytes;
      watchdogPrevPaneBytes = currPaneBytes;
      watchdogPrevTickAt = now;
    } catch (e) {
      logLine(`watchdog tick error: ${e.message}`);
    }
  }

  function startCrashWatchdog() {
    if (watchdogTimer) return;
    logLine(`crash watchdog started (tick=${tickMs}ms)`);
    watchdogTimer = setInterval(watchdogTick, tickMs);
    if (watchdogTimer.unref) watchdogTimer.unref();
    bindPowerMonitorToStallMonitor();
    mainStallMonitor.start();
  }

  function stopCrashWatchdog() {
    if (!watchdogTimer) return;
    clearInterval(watchdogTimer);
    watchdogTimer = null;
    mainStallMonitor.stop();
  }

  return {
    startCrashWatchdog,
    stopCrashWatchdog,
    watchdogTick,
    mainStallMonitor,
  };
}

module.exports = {
  createCrashWatchdogService,
};
