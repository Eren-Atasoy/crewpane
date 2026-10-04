'use strict';

const fs = require('node:fs');
const instancePaths = require('../../config/instancePaths.cjs');
const appIdentity = require('../../../platform/appIdentity.cjs');
const safeStorageIdentity = require('../../security/safeStorageIdentity.cjs');

/**
 * Bootstrap Step 04: Application Identity & SafeStorage Pinning
 *
 * Windows Bildirim Kimliği: app.setAppUserModelId() en erken noktada ayarlanır.
 * Keychain Kimliği: app.setName() ready öncesi çağrılır, userData/sessionData/logs yolları korunur.
 */
function run(ctx) {
  const app = ctx.app;
  if (!app) return;

  const instanceId = ctx.instanceId || instancePaths.instanceId();

  // 1. Windows Notification Identity
  appIdentity.applyAppUserModelId({
    app,
    instanceId,
    log: (m) => {
      try {
        process.stderr.write(`[app-identity] ${m}\n`);
      } catch {
        /* best-effort */
      }
    },
  });

  // 2. SafeStorage Scope & Path Pinning
  const safeStorageScope = safeStorageIdentity.safeStorageAppName({
    isPackaged: app.isPackaged,
    instanceId,
  });

  const pinned = [];
  for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
    try {
      pinned.push([key, app.getPath(key)]);
    } catch {
      /* bu yol bu platformda yok */
    }
  }

  app.setName(safeStorageScope);

  for (const [key, value] of pinned) {
    try {
      fs.mkdirSync(value, { recursive: true });
    } catch {
      /* best-effort */
    }
    try {
      app.setPath(key, value);
    } catch {
      /* best-effort */
    }
  }

  ctx.safeStorageScope = safeStorageScope;
}

module.exports = { run };
