'use strict';

const defaultEngineRegistry = require('../../agents/engineRegistry.cjs');
const defaultModelCatalog = require('../../agents/modelCatalog.cjs');
const defaultProviders = require('../../agents/providers.cjs');
const defaultCredentialGate = require('../../security/requireCredential.cjs');
const defaultAgentRunner = require('../../agents/agentRunner.js');

function scrubSecret(text, secret) {
  if (!secret) return String(text == null ? '' : text).slice(0, 300);
  return String(text == null ? '' : text).split(secret).join('«gizli»').slice(0, 300);
}

function buildVerifyHeader(specVerify, secret) {
  const headerValue = specVerify.headerFormat
    ? `${specVerify.headerFormat} ${secret}`
    : secret;
  return { [specVerify.header]: headerValue };
}

async function parseResponseBody(res, countPath, secret) {
  try {
    const body = await res.json();
    let count = null;
    const list = countPath ? body[countPath] : null;
    if (Array.isArray(list)) count = list.length;
    let detail = '';
    if (!res.ok) {
      detail = scrubSecret((body && body.error && body.error.message) || '', secret);
    }
    return { count, detail };
  } catch {
    return { count: null, detail: '' };
  }
}

async function executeVerifyRequest(url, headers, timeoutMs = 15000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'GET',
      headers,
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

const DEFAULT_DEPS = {
  engineRegistry: defaultEngineRegistry,
  modelCatalog: defaultModelCatalog,
  providers: defaultProviders,
  credentialGate: defaultCredentialGate,
  agentRunner: defaultAgentRunner,
  repoRoot: '',
  logLine: () => {},
};

class ApiKeyService {
  constructor(deps = {}) {
    this.deps = Object.assign({}, DEFAULT_DEPS, deps);
  }

  engineModelCatalogPayload() {
    const out = {};
    const { engineRegistry, modelCatalog, agentRunner } = this.deps;

    for (const id of engineRegistry.engineIds()) {
      const cat = modelCatalog.catalogFor(id);
      const effortCap = engineRegistry.capability(id, 'effort');
      const engineEfforts = effortCap && Array.isArray(effortCap.values) ? [...effortCap.values] : [];
      out[id] = {
        source: cat.source,
        stale: cat.stale,
        engineEfforts,
        models: cat.models.map((m) => ({
          id: m.id,
          label: m.label,
          descriptionKey: m.descriptionKey || null,
          description: m.description || null,
          defaultEffort: m.defaultEffort || null,
          efforts: modelCatalog.effortChoices(engineEfforts, m),
          usable: Boolean(agentRunner.sanitizeModel(m.id)),
        })),
      };
    }
    return out;
  }

  aiProvidersPayload(settings) {
    const adapterReady = Boolean(process.env.CREWPANE_ADAPTER_PORT);
    const custom = (settings && settings.customProvider) || null;
    const { providers, agentRunner } = this.deps;

    return providers.allProviders(custom).map((p) => {
      const hasKey = Boolean(settings && settings.apiKeys && settings.apiKeys[p.settingsKey]);
      return {
        id: p.id,
        label: p.label,
        settingsKey: p.settingsKey,
        needsShim: p.needsShim,
        custom: p.custom === true,
        baseUrl: p.custom === true ? p.baseUrl : null,
        hasKey,
        models: p.models.map((m) => ({
          id: m.id,
          label: m.label,
          usable: Boolean(agentRunner.sanitizeModel(m.id)),
        })),
        ready: p.needsShim ? adapterReady : true,
        adapterRequired: p.needsShim,
        adapterReady,
      };
    });
  }

  appApiKeysPayload() {
    const { credentialGate, repoRoot } = this.deps;

    return Object.values(credentialGate.SERVICES)
      .filter((s) => s.productCard)
      .map((s) => {
        const r = credentialGate.resolveCredential(s.id, { rootDir: repoRoot });
        return {
          id: s.id,
          label: s.label,
          settingsKey: s.settingsKey,
          settingsField: s.settingsField,
          keyLabel: s.keyLabel || null,
          keyUrl: s.keyUrl || null,
          feature: s.feature,
          hasKey: r.ok === true,
          source: r.ok ? r.source : null,
          canVerify: Boolean(s.verify),
        };
      });
  }

  async verifyAppApiKey(service) {
    const { credentialGate, repoRoot, logLine } = this.deps;
    const spec = credentialGate.SERVICES[service];
    if (!spec || !spec.verify) return { ok: false, reason: 'unsupported' };
    const r = credentialGate.resolveCredential(spec.id, { rootDir: repoRoot });
    if (!r.ok) {
      return {
        ok: false,
        reason: 'no-key',
        message: r.message,
        settingsTarget: r.settingsTarget || null,
      };
    }

    try {
      const headers = buildVerifyHeader(spec.verify, r.secret);
      const res = await executeVerifyRequest(spec.verify.url, headers);
      const { count, detail } = await parseResponseBody(res, spec.verify.countPath, r.secret);
      logLine(`appkey verify service=${spec.id} source=${r.source} http=${res.status}`);
      if (!res.ok) {
        return { ok: false, reason: 'rejected', status: res.status, detail, source: r.source };
      }
      return { ok: true, source: r.source, status: res.status, count };
    } catch (e) {
      logLine(`appkey verify service=${spec.id} source=${r.source} ÖLÇEMEDİ`);
      return {
        ok: false,
        reason: 'unreachable',
        detail: scrubSecret(e && e.message, r.secret),
        source: r.source,
      };
    }
  }
}

function createApiKeyService(deps) {
  return new ApiKeyService(deps);
}

module.exports = {
  ApiKeyService,
  createApiKeyService,
};
