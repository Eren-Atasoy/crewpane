'use strict';

/**
 * Mobile Gateway Lifecycle Controller (Phase 3.6.65)
 * Manages mobile gateway start, stop, kill-switch, and background upload sweeping.
 */
function createMobileGatewayLifecycle({
  app,
  shellCommit,
  logLine,
  mobilePlanDenial,
  mobileGatewayMod,
  mobileSpriteDir,
  mobileWebRoot,
  mobileListPanes,
  mobilePaneTail,
  mobilePaneTranscript,
  mobileQueryRenderer,
  mobileOfficeSnapshot,
  mobileReports,
  mobileCommandRenderer,
  mobileTranscribe,
  mobileUploads,
  jarvisConv,
  mobileSubscribers,
  mobileDeviceStore,
  mobileStartFailure,
}) {
  let mobileGateway = null;
  let mobileGatewayLastFailure = null;
  let mobileUploadsSweepTimer = null;

  function mobileKillSwitch() {
    const state = mobileDeviceStore.loadState();
    state.enabled = false;
    mobileDeviceStore.saveState(state);
    if (mobileGateway) {
      mobileGateway.stop();
      mobileGateway = null;
    }
    logLine('mobile gateway: KILL-SWITCH — mobil erişim kapatıldı');
    return { ok: true };
  }

  function _sweepOldUploads() {
    try {
      const n = mobileUploads.sweepUploads({});
      if (n) logLine(`mobile uploads: ${n} eski gün klasörü temizlendi`);
    } catch (err) {
      logLine(`mobile uploads: temizlik hatası: ${err.message}`);
    }
  }

  function _ensureUploadsSweep() {
    if (!mobileUploadsSweepTimer) {
      _sweepOldUploads();
      mobileUploadsSweepTimer = setInterval(_sweepOldUploads, 24 * 60 * 60 * 1000);
      mobileUploadsSweepTimer.unref?.();
    }
  }

  function _buildGatewayDeps() {
    return {
      log: logLine,
      appInfo: { version: app.getVersion(), commit: shellCommit },
      spriteDir: mobileSpriteDir(),
      webRoot: mobileWebRoot(),
      listPanes: mobileListPanes,
      paneTail: mobilePaneTail,
      paneTranscript: mobilePaneTranscript,
      queryRenderer: mobileQueryRenderer,
      officeSnapshot: mobileOfficeSnapshot,
      reportsList: (params) => mobileReports.listReports({ params }),
      reportRead: (reportId, opts) => mobileReports.readReport({ reportId, page: opts && opts.page }),
      command: mobileCommandRenderer,
      transcribe: mobileTranscribe,
      saveUpload: (p) => mobileUploads.saveUpload(p),
      resolveUpload: (id) => mobileUploads.resolveUpload(id),
      jarvisHistory: (q) => jarvisConv.history(q),
      killSwitch: mobileKillSwitch,
      subscribe: (cb) => {
        mobileSubscribers.add(cb);
        return () => mobileSubscribers.delete(cb);
      },
    };
  }

  async function startMobile() {
    if (mobileGateway) return mobileGateway;
    const planGate = mobilePlanDenial({ notify: false });
    if (planGate) {
      logLine(`mobile gateway: plan tavanı — kalkmadı (katman=${planGate.tier}); cihaz defteri diskte KORUNUYOR`);
      return null;
    }
    try {
      mobileGateway = await mobileGatewayMod.startMobileGateway(_buildGatewayDeps());
    } catch (err) {
      logLine(`mobile gateway failed to start: ${err.message}`);
      mobileGateway = null;
      mobileGatewayLastFailure = mobileStartFailure(err);
    }
    if (mobileGateway) {
      _ensureUploadsSweep();
    }
    return mobileGateway;
  }

  function stopMobile() {
    if (mobileGateway) {
      try {
        mobileGateway.stop();
      } catch {
        /* best-effort */
      }
      mobileGateway = null;
    }
    if (mobileUploadsSweepTimer) {
      clearInterval(mobileUploadsSweepTimer);
      mobileUploadsSweepTimer = null;
    }
  }

  return {
    getMobileGateway: () => mobileGateway,
    getMobileGatewayLastFailure: () => mobileGatewayLastFailure,
    startMobile,
    stopMobile,
    mobileKillSwitch,
  };
}

module.exports = { createMobileGatewayLifecycle };
