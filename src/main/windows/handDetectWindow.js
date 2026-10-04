'use strict';

const { BrowserWindow } = require('electron');
const { tagTestWindow } = require('./tagTestWindow');

function resolveHandControl(deps) {
  return deps.getHandControl ? deps.getHandControl() : deps.handControl;
}

function handDetectAlive(deps) {
  const handControl = resolveHandControl(deps);
  return Boolean(handControl && handControl.win && !handControl.win.isDestroyed());
}

/**
 * Gizli tespit penceresi.
 * backgroundThrottling KAPALI şart: gizli pencerede rAF/detect döngüsü kısılırsa imleç 1 fps'e düşer.
 */
function openHandDetectWindow(deps) {
  const {
    getAppBaseUrl = () => null,
    sharedWebPreferences,
    stopHandControl = () => {},
    broadcastHandControlStatus = () => {},
    isTest = false,
  } = deps;
  const handControl = resolveHandControl(deps);

  const appBaseUrl = getAppBaseUrl();
  if (!appBaseUrl) return { ok: false, error: 'uygulama adresi yok' };
  if (handDetectAlive(deps)) return { ok: true, reused: true };

  const win = new BrowserWindow({
    width: 340,
    height: 260,
    show: false, // GİZLİ — hiç gösterilmez
    skipTaskbar: true,
    focusable: false,
    title: 'CrewPane — El kontrolü motoru',
    webPreferences: { ...sharedWebPreferences(), backgroundThrottling: false },
  });
  tagTestWindow(win, 'CrewPane — El kontrolü motoru', isTest);

  win.on('closed', () => {
    if (handControl) {
      handControl.win = null;
      if (handControl.phase !== 'off') {
        stopHandControl('tespit penceresi kapandı');
        handControl.phase = 'off';
        handControl.warm = null;
        broadcastHandControlStatus();
      }
    }
  });

  win.loadURL(`${appBaseUrl}/hand-detect`);
  if (handControl) {
    handControl.win = win;
    handControl.phase = handControl.phase === 'off' ? 'warming' : handControl.phase;
  }
  return { ok: true };
}

/**
 * Isınma — uygulama açılışında kamerasız.
 */
function scheduleHandControlWarmup(attempt = 0, deps = {}) {
  const {
    getAppBaseUrl = () => null,
    broadcastHandControlStatus = () => {},
    logLine = () => {},
  } = deps;

  setTimeout(() => {
    try {
      if (handDetectAlive(deps)) return;
      const appBaseUrl = getAppBaseUrl();
      if (!appBaseUrl) {
        if (attempt < 10) scheduleHandControlWarmup(attempt + 1, deps);
        else logLine('hand-control ısınma vazgeçti: uygulama adresi hiç gelmedi');
        return;
      }
      openHandDetectWindow(deps);
      broadcastHandControlStatus();
    } catch (err) {
      logLine(`hand-control ısınma açılamadı: ${err.message}`);
    }
  }, attempt === 0 ? 8000 : 5000);
}

module.exports = {
  handDetectAlive,
  openHandDetectWindow,
  scheduleHandControlWarmup,
};
