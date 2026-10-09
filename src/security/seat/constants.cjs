// CrewPane — Seat Gate constants and device denials dictionary.
'use strict';

const { SEAT_PRODUCT } = require('../../config/crewpaneId.cjs');

/**
 * SEC-01/02 — sunucunun cihaz ret sınıfı → `planLimits.FEATURES` anahtarı.
 */
const DEVICE_DENIALS = Object.freeze({
  device_limit_reached: 'devices',                    // KAYIT kadranı → "cihazı çıkar"
  device_concurrent_limit_reached: 'devicesConcurrent', // EŞZAMANLI kadranı → "bırak"
});

const HEARTBEAT_FALLBACK_MS = 5 * 60_000;

module.exports = {
  DEVICE_DENIALS,
  SEAT_PRODUCT,
  HEARTBEAT_FALLBACK_MS,
};
