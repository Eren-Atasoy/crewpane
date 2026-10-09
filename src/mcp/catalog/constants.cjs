'use strict';

/**
 * ADP-848-B — ElevenLabs ve benzeri: anahtar başka bir yüzeyde yönetilir.
 */
const EXTERNAL_KEY_STORE = 'settings';

const DEFAULT_MASK = { keepPrefix: 2, keepSuffix: 4 };

/**
 * INT-0-E — KASADA SIR TAŞIYAN authKind'ler (Katman B).
 */
const SECRET_AUTH_KINDS = Object.freeze(['api_key', 'dsn']);

module.exports = {
  EXTERNAL_KEY_STORE,
  DEFAULT_MASK,
  SECRET_AUTH_KINDS,
};
