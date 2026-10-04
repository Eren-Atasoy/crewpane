'use strict';

const path = require('node:path');
const { BrowserWindow } = require('electron');

/**
 * Spike/regression window — the isolated ADP-001 xterm.js renderer.
 */
function createSpikeWindow(deps) {
  const {
    AUTOTEST = false,
    sharedWebPreferences,
    logLine = () => {},
    rendererHtmlPath = path.resolve(__dirname, '../../../renderer/index.html'),
  } = deps;

  const win = new BrowserWindow({
    width: 980,
    height: 640,
    show: !AUTOTEST,
    backgroundColor: '#0d0f17',
    webPreferences: sharedWebPreferences(),
  });

  if (AUTOTEST) {
    win.webContents.on('console-message', (e) => {
      const msg = e && typeof e === 'object' && 'message' in e ? e.message : e;
      logLine('[renderer console] ' + msg);
    });
  }
  win.webContents.on('render-process-gone', (_e, details) => {
    logLine('RENDERER GONE: ' + JSON.stringify(details));
  });

  win.loadFile(rendererHtmlPath, AUTOTEST ? { search: 'autotest=1' } : undefined);
  return win;
}

module.exports = {
  createSpikeWindow,
};
