// CrewPane — Engine Auth API Key Vault Store and Environment Adapters.
'use strict';

const { maskSecrets } = require('./constants.cjs');
const { authDescriptor } = require('./descriptors.cjs');

/**
 * `credentialVault` (ADP-584) üzerine ince bir motor-anahtarı görünümü.
 */
function createVaultApiKeyStore(vault) {
  const guard = () => vault && typeof vault.isAvailable === 'function' && vault.isAvailable();
  return {
    hasKey(service) {
      try { return guard() ? vault.servicesSync().includes(service) : false; } catch { return false; }
    },
    readKey(service) {
      try {
        if (!guard()) return null;
        const r = vault.resolveSync(service, { env: null });
        return r && typeof r.secret === 'string' ? r.secret : null;
      } catch { return null; }
    },
    async saveKey(service, secret, opts = {}) {
      if (!guard()) return { ok: false, error: 'vault-unavailable' };
      try {
        for (const rec of await vault.list()) {
          if (rec.service === service) await vault.remove(rec.id);
        }
        await vault.add({ service, secret, authKind: 'api_key', env: null, keyLabel: opts.keyLabel || '' });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: maskSecrets(String((e && e.message) || 'vault-write-failed')) };
      }
    },
    async clearKey(service) {
      if (!guard()) return { ok: false, error: 'vault-unavailable' };
      try {
        let removed = false;
        for (const rec of await vault.list()) {
          if (rec.service === service) removed = (await vault.remove(rec.id)) || removed;
        }
        return { ok: true, removed };
      } catch (e) {
        return { ok: false, error: maskSecrets(String((e && e.message) || 'vault-write-failed')) };
      }
    },
  };
}

/** Bu çağrı için anahtar deposu (yoksa `null` — api-key yolu kapalı demektir). */
function apiKeyStoreOf(deps = {}) {
  if (deps.apiKeyStore) return deps.apiKeyStore;
  if (deps.vault) return createVaultApiKeyStore(deps.vault);
  return null;
}

/**
 * ENG-F4-01 — "burada giriş yapıldı" DEFTERİ dikişi (`electron/engineLoginLedger.cjs`).
 */
function loginLedgerOf(deps = {}) {
  const l = deps.loginLedger;
  return l && typeof l.has === 'function' ? l : null;
}

/** Kayıtlı giriş var mı? Defter yoksa/patlarsa "yok" — kayıt akışı kıramaz. */
function hasLoginRecord(deps = {}) {
  const ledger = loginLedgerOf(deps);
  if (!ledger) return false;
  try { return ledger.has() === true; } catch { return false; }
}

/**
 * ENG-08 — bir motorun API anahtarının ENV KATKISI (spawn boğazı bunu kullanır).
 */
function apiKeyEnvFor(engine, deps = {}) {
  const d = authDescriptor(engine, deps);
  if (!d || !d.apiKey) return {};
  const store = apiKeyStoreOf(deps);
  if (!store) return {};
  const secret = store.readKey(d.apiKey.vaultService);
  return secret ? { [d.apiKey.env]: secret } : {};
}

module.exports = {
  createVaultApiKeyStore,
  apiKeyStoreOf,
  loginLedgerOf,
  hasLoginRecord,
  apiKeyEnvFor,
};
