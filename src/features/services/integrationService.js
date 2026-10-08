'use strict';

const { createCredentialVault } = require('../../security/credentialVault.cjs');
const { createIntegrationResolver } = require('../../mcp/integrationResolver.cjs');
const { buildIntegrationsStatus } = require('../../mcp/integrationStatus.cjs');
const { createIntegrationIpc } = require('../../mcp/integrationIpc.cjs');
const integrationCatalog = require('../../mcp/integrationCatalog.cjs');
const mcpProbe = require('../../mcp/mcpProbe.cjs');

function findPaneEntryByAgentId(ptys, agentId) {
  if (!agentId || !ptys) return null;
  for (const e of ptys.values()) {
    if (e && e.agentId === agentId) return e;
  }
  return null;
}

function resolveIntegrationsInjectability(paneEngine, agentRunner, paneCapabilityMatrix) {
  let injectable = null;
  let reason = null;
  if (!paneEngine || !agentRunner) return { injectable, reason };

  try {
    injectable = agentRunner.integrationsInjectable(paneEngine) === true;
  } catch {
    injectable = null;
  }

  if (injectable === false && paneCapabilityMatrix) {
    try {
      const cell = (paneCapabilityMatrix.buildMatrix(paneEngine) || {}).integrations;
      reason = (cell && cell.reason) || null;
    } catch {
      reason = null;
    }
  }

  return { injectable, reason };
}

function buildPaneDescriptor(paneEntry, agentId, agentRunner, paneCapabilityMatrix) {
  const paneIntegrations = (paneEntry && paneEntry.integrations) || null;
  const paneEngine = paneEntry ? paneEntry.command : null;
  const { injectable, reason } = resolveIntegrationsInjectability(
    paneEngine,
    agentRunner,
    paneCapabilityMatrix
  );

  return {
    agentId: agentId || null,
    engine: paneEngine,
    gated: (paneIntegrations && Array.isArray(paneIntegrations.gated)) ? paneIntegrations.gated : [],
    projectId: paneIntegrations ? paneIntegrations.projectId : null,
    env: paneIntegrations ? paneIntegrations.env : 'dev',
    known: Boolean(paneEntry),
    integrationsInjectable: injectable,
    integrationsReason: reason,
  };
}

function createIntegrationsCore({
  safeStorage,
  homeDir,
  logLine,
  secretRedactor,
  baseEnv,
  credentialGate,
  repoRoot,
  vendorSurface,
}) {
  const vault = createCredentialVault({
    safeStorage,
    homeDir,
    log: (line) => logLine(line),
  });
  const resolver = createIntegrationResolver({ vault, log: (line) => logLine(line) });
  const ipc = createIntegrationIpc({
    vault,
    catalog: integrationCatalog,
    redactor: secretRedactor,
    probe: mcpProbe.probeMcpServer,
    baseEnv: baseEnv || process.env,
    externalStatus: (service) => {
      const r = credentialGate.resolveCredential(service, { rootDir: repoRoot });
      if (!r.ok) return { connected: false, masked: null };
      return { connected: true, masked: integrationCatalog.maskSecret(r.secret, service) };
    },
    isVendorSurface: () => (vendorSurface ? vendorSurface.isVendorSurface() : false),
    log: (line) => logLine(line),
  });
  return { vault, resolver, ipc };
}

/**
 * Entegrasyon Merkezi / Vault, Resolver & Status Service (Faz 3.6.12)
 */
function createIntegrationService(deps = {}) {
  const {
    instancePaths,
    safeStorage = null,
    logLine = () => {},
    secretRedactor,
    credentialGate = { resolveCredential: () => ({ ok: false }) },
    repoRoot,
    vendorSurface,
    engineAuth,
    getPtys = () => null,
    agentRunner,
    paneCapabilityMatrix,
    baseEnv = process.env,
  } = deps;

  let integrationsCore = null;

  function integrations() {
    if (integrationsCore) return integrationsCore;
    integrationsCore = createIntegrationsCore({
      safeStorage,
      homeDir: instancePaths.crewpaneHome(),
      logLine,
      secretRedactor,
      baseEnv,
      credentialGate,
      repoRoot,
      vendorSurface,
    });
    return integrationsCore;
  }

  function engineKeyStore() {
    try {
      return engineAuth ? engineAuth.createVaultApiKeyStore(integrations().vault) : null;
    } catch {
      return null;
    }
  }

  async function stampIntegrationVerified(service) {
    try {
      const { vault } = integrations();
      if (!vault.isAvailable()) return;
      const id = await vault.resolveId(service, {});
      if (id) await vault.markVerified(id);
    } catch (e) {
      logLine(`integrations: doğrulama damgası atılamadı service=${service} (${e && e.message})`);
    }
  }

  function integrationResolverOrNull() {
    try {
      return integrations().resolver;
    } catch (e) {
      logLine(`integrations resolver init failed: ${e && e.message}`);
      return null;
    }
  }

  async function integrationsStatusFor(req = {}) {
    const agentId = typeof req.agentId === 'string' ? req.agentId.trim() : '';
    const ptys = getPtys();
    const paneEntry = findPaneEntryByAgentId(ptys, agentId);
    const paneIntegrations = (paneEntry && paneEntry.integrations) || null;
    const pane = buildPaneDescriptor(paneEntry, agentId, agentRunner, paneCapabilityMatrix);

    let records = [];
    let vaultAvailable = true;
    try {
      const { vault } = integrations();
      vaultAvailable = vault.isAvailable();
      if (vaultAvailable) records = await vault.list();
    } catch (e) {
      logLine(`integrations status: vault okunamadı (${e && e.message}) — katalog yine de döner`);
      vaultAvailable = false;
    }

    return buildIntegrationsStatus({
      catalog: integrationCatalog,
      records,
      pane,
      injectedServices: paneIntegrations ? paneIntegrations.services : null,
      vaultAvailable,
    });
  }

  return {
    integrations,
    engineKeyStore,
    integrationsStatusFor,
    stampIntegrationVerified,
    integrationResolverOrNull,
  };
}

module.exports = {
  createIntegrationService,
};
