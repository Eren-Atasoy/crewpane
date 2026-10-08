'use strict';
/**
 * CrewPane Domain: SECURITY
 */
const path = require('node:path');

module.exports = {
  get browserGate() { return require(path.join(__dirname, "browserGate.cjs")); },
  get browserTrust() { return require(path.join(__dirname, "browserTrust.cjs")); },
  get copyrightGate() { return require(path.join(__dirname, "copyrightGate.cjs")); },
  get credentialVault() { return require(path.join(__dirname, "credentialVault.cjs")); },
  get entitlementBlock() { return require(path.join(__dirname, "entitlementBlock.cjs")); },
  get installReset() { return require(path.join(__dirname, "installReset.cjs")); },
  get integrity() { return require(path.join(__dirname, "integrity.cjs")); },
  get integrityCheck() { return require(path.join(__dirname, "integrityCheck.cjs")); },
  get killGuard() { return require(path.join(__dirname, "killGuard.cjs")); },
  get killGuardHook() { return require(path.join(__dirname, "killGuardHook.cjs")); },
  get killGuardShim() { return require(path.join(__dirname, "killGuardShim.cjs")); },
  get requireCredential() { return require(path.join(__dirname, "requireCredential.cjs")); },
  get resetGate() { return require(path.join(__dirname, "resetGate.cjs")); },
  get safeStorageIdentity() { return require(path.join(__dirname, "safeStorageIdentity.cjs")); },
  get seatGate() { return require(path.join(__dirname, "seatGate.cjs")); },
  get secretBackendState() { return require(path.join(__dirname, "secretBackendState.cjs")); },
  get secretRedactor() { return require(path.join(__dirname, "secretRedactor.cjs")); },
  get spendGuard() { return require(path.join(__dirname, "spendGuard.cjs")); },
  get tamperSignals() { return require(path.join(__dirname, "tamperSignals.cjs")); },
  get integrityService() { return require(path.join(__dirname, "integrityService.js")); },
  get createIntegrityService() { return require(path.join(__dirname, "integrityService.js")).createIntegrityService; },
  get IntegrityService() { return require(path.join(__dirname, "integrityService.js")).IntegrityService; },
};
