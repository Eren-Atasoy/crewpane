'use strict';

const childProcess = require('child_process');
const handCameraPolicy = require('../../hand/handCameraPolicy.cjs');
const handOverlayContract = require('../../hand/handOverlayContract.cjs');

const HAND_HARDWARE_TTL_MS = 30000;

function restartCameraIfLive(c, handDetectAlive) {
  const live = c.phase === 'on' || c.phase === 'starting' || c.phase === 'stalled';
  if (!live || !handDetectAlive() || !c.win || c.win.isDestroyed()) return live;
  c.cameraBlank = null;
  try {
    c.win.webContents.send('handDetect:command', { cmd: 'stop-camera' });
    c.win.webContents.send('handDetect:command', { cmd: 'start-camera' });
  } catch {
    // pencere kapanıyor: bir sonraki başlatmada uygulanır
  }
  return live;
}

/**
 * Hand Camera & Hardware Resolution Service (Faz 3.6.6)
 */
function createHandCameraService({
  systemPreferences,
  handControl,
  agentSettings = { readSettings: () => ({}), writeSettings: () => {} },
  handDetectAlive = () => false,
  broadcastHandControlStatus = () => {},
  logLine = () => {},
}) {
  let handHardwareCache = { at: 0, list: [] };

  function handHardwareCameras() {
    if (process.platform !== 'darwin') return [];
    const now = Date.now();
    if (now - handHardwareCache.at < HAND_HARDWARE_TTL_MS) return handHardwareCache.list;
    let list = [];
    try {
      const out = childProcess.execFileSync('/usr/sbin/system_profiler', ['SPCameraDataType'], {
        encoding: 'utf8',
        timeout: 8000,
        maxBuffer: 1024 * 1024,
      });
      list = handCameraPolicy.parseSystemProfilerCameras(out);
    } catch (err) {
      logLine(`hand-control donanım kamera listesi okunamadı (zararsız): ${err.message}`);
      list = [];
    }
    handHardwareCache = { at: now, list };
    return list;
  }

  function handCameraPreference() {
    let raw = {};
    try {
      raw = agentSettings.readSettings().handControl;
    } catch {
      raw = {};
    }
    const cam = handOverlayContract.sanitizeHandControl(raw).camera;
    return cam && (cam.deviceId || cam.label) ? cam : null;
  }

  async function ensureCameraAccess() {
    if (process.platform !== 'darwin') {
      const st = systemPreferences && systemPreferences.getMediaAccessStatus
        ? systemPreferences.getMediaAccessStatus('camera')
        : 'unknown';
      return {
        ok: st !== 'denied',
        status: st,
        settingsUrl: process.platform === 'win32' ? 'ms-settings:privacy-webcam' : null,
      };
    }
    if (!systemPreferences) return { ok: true, status: 'unknown' };
    const before = systemPreferences.getMediaAccessStatus('camera');
    if (before === 'granted') return { ok: true, status: 'granted' };
    if (before === 'not-determined') {
      const granted = await systemPreferences.askForMediaAccess('camera');
      return { ok: granted, status: granted ? 'granted' : 'denied', asked: true };
    }
    return {
      ok: false,
      status: before,
      settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
    };
  }

  function selectHandCamera(sel) {
    const c = handControl;
    const deviceId = sel && typeof sel.deviceId === 'string' ? sel.deviceId : null;
    const label = sel && typeof sel.label === 'string' ? sel.label : null;
    if (deviceId && c.cameraCandidates.length && !c.cameraCandidates.some((cand) => cand.deviceId === deviceId)) {
      return { ok: false, error: 'bilinmeyen kamera' };
    }
    agentSettings.writeSettings({ handControl: { camera: { deviceId, label } } });
    logLine(`hand-control kamera seçimi: ${label || deviceId || '(otomatik)'}`);
    const restarted = restartCameraIfLive(c, handDetectAlive);
    broadcastHandControlStatus();
    return { ok: true, selected: { deviceId, label }, restarted };
  }

  return {
    handHardwareCameras,
    handCameraPreference,
    ensureCameraAccess,
    selectHandCamera,
    handCameraPolicy,
  };
}

module.exports = {
  createHandCameraService,
  HAND_HARDWARE_TTL_MS,
};
