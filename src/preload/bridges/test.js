'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Autotest-only instrumentation channels (proof harness, not product API).
if (process.env.CREWPANE_AUTOTEST || process.env.CREWPANE_SPIKE_AUTOTEST || process.env.NODE_ENV === 'test') {
  contextBridge.exposeInMainWorld('spikeProbe', {
    rendered: (chunk) => ipcRenderer.send('spike:rendered', chunk),
    done: (summary) => ipcRenderer.send('spike:done', summary),
  });
}
