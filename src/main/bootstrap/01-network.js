'use strict';

const net = require('node:net');

/**
 * Bootstrap Step 01: Network Configuration
 *
 * undici'nin happy-eyeballs katmanı autoSelectFamilyAttemptTimeout varsayılan 250ms:
 * yavaş ağda her connect denemesi 250ms'de kesiliyor → ETIMEDOUT / EHOSTUNREACH.
 * 2500ms ile hem happy-eyeballs faydası korunur hem de yavaş ağda bağlantı kurulabilir.
 * En erken noktada (ilk fetch'lerden ÖNCE) set edilmelidir.
 */
function run(ctx) {
  net.setDefaultAutoSelectFamilyAttemptTimeout(2500);
}

module.exports = { run };
