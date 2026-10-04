'use strict';

/**
 * IPC Router (Faz 3.4)
 * Provides centralized IPC registration with schema validation and error formatting.
 * Template adheres to Section 2.3 of the refactor specification.
 */
function createIpcRouter({ ipcMain, logger }) {
  if (!ipcMain) {
    throw new Error('createIpcRouter requires ipcMain');
  }

  const logWarn = (msg, meta) => {
    if (logger && typeof logger.warn === 'function') {
      logger.warn(msg, meta);
    } else if (logger && typeof logger.logLine === 'function') {
      logger.logLine(`[WARN] ${msg} ${JSON.stringify(meta || {})}`);
    }
  };

  const logError = (msg, meta) => {
    if (logger && typeof logger.error === 'function') {
      logger.error(msg, meta);
    } else if (logger && typeof logger.logLine === 'function') {
      logger.logLine(`[ERROR] ${msg} ${JSON.stringify(meta || {})}`);
    }
  };

  return function register(contract, handlers) {
    if (!contract || typeof contract !== 'object') {
      throw new Error('createIpcRouter: contract object is required');
    }

    const channels = contract.channels || {};
    const schemas = contract.schemas || {};

    for (const [key, channel] of Object.entries(channels)) {
      const handler = handlers[key];
      if (!handler) {
        throw new Error(`Missing handler for ${channel}`);
      }
      const schema = schemas[channel] || schemas[key];

      ipcMain.handle(channel, async (event, payload) => {
        const parsed = schema && typeof schema.safeParse === 'function'
          ? schema.safeParse(payload)
          : { success: true, data: payload };

        if (!parsed.success) {
          logWarn('ipc.invalid_payload', { channel, issues: parsed.error ? parsed.error.issues : undefined });
          return { ok: false, error: 'INVALID_PAYLOAD' };
        }

        try {
          const res = await handler(parsed.data, event);
          if (res !== null && typeof res === 'object' && ('ok' in res)) {
            return res;
          }
          return { ok: true, data: res };
        } catch (err) {
          logError('ipc.handler_failed', { channel, err: err ? err.message : String(err) });
          return { ok: false, error: (err && err.code) || 'INTERNAL' };
        }
      });
    }
  };
}

module.exports = { createIpcRouter };
