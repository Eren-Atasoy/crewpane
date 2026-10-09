'use strict';

const path = require('node:path');
const fs = require('node:fs');
const instancePaths = require('../../config/instancePaths.cjs');
const crewpaneEnv = require('../../config/crewpaneEnv.cjs');
const mcpNode = require('../../../platform/mcpNode.cjs');
const killGuardShim = require('../../security/killGuardShim.cjs');
const agyWorkspacePlugin = require('../agyWorkspacePlugin.cjs');
const codeIndexStore = require('../../services/codeIndex.cjs');
const npxDirect = require('../../mcp/npxDirect.cjs');
const integrationAutostart = require('../../mcp/integrationAutostart.cjs');
const paneCapabilityMatrix = require('../../terminal/paneCapabilityMatrix.cjs');
const { winSafeAtomicWrite, writeJsonAtomic } = require('./atomicFs.cjs');
const { engineCapability } = require('./registryBridge.cjs');
const { mcpServerDir, mcpConfigDoc, mcpConfigFileName, mcpEntry } = require('./mcpServers.cjs');

const BRIEFING_HOOK_FILE = 'leaderBriefingHook.cjs';

function briefingHookPath() {
  return path.join(mcpServerDir(), BRIEFING_HOOK_FILE);
}

const KILL_GUARD_HOOK_FILE = 'killGuardHook.cjs';
const KILL_GUARD_SHIM_FILE = 'killGuardShim.cjs';
const AGY_HOOK_FILE = 'agyHookRunner.cjs';

function agyHookRunnerPath() {
  return path.join(mcpServerDir(), AGY_HOOK_FILE);
}

function killGuardHookPath() {
  return path.join(mcpServerDir(), KILL_GUARD_HOOK_FILE);
}

function killGuardShimCliPath() {
  return path.join(mcpServerDir(), KILL_GUARD_SHIM_FILE);
}

function resolveRealBin(name, deps = {}) {
  const platform = deps.platform || process.platform;
  const exists = deps.exists || ((p) => {
    try { fs.accessSync(p, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return true; } catch { return false; }
  });
  if (platform === 'win32') {
    const root = (deps.env || process.env).SystemRoot || (deps.env || process.env).windir || 'C:\\Windows';
    const sys32 = path.join(root, 'System32');
    const cands = name === 'wmic'
      ? [path.join(sys32, 'wbem', 'WMIC.exe'), path.join(sys32, 'wbem', 'wmic.exe')]
      : [path.join(sys32, `${name}.exe`)];
    for (const p of cands) if (exists(p)) return p;
    return null;
  }
  for (const p of [`/usr/bin/${name}`, `/bin/${name}`, `/usr/sbin/${name}`]) {
    if (exists(p)) return p;
  }
  return null;
}

function ensureKillGuardShims(dir, deps = {}) {
  try {
    const platform = deps.platform || process.platform;
    const launcher = deps.launcher || mcpNode.resolveMcpNode();
    const realBins = {};
    for (const verb of killGuardShim.shimmedFor(platform)) {
      const real = resolveRealBin(verb, { ...deps, platform });
      if (real) realBins[verb] = real;
    }
    const files = killGuardShim.shimFiles({
      cliPath: deps.cliPath || killGuardShimCliPath(),
      launcher,
      realBins,
      platform,
    });
    if (!files.length) return null;
    const binDir = path.join(dir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    for (const f of files) {
      winSafeAtomicWrite(path.join(binDir, f.name), f.contents, {});
      try { fs.chmodSync(path.join(binDir, f.name), f.mode); } catch { /* win32: no-op */ }
    }
    return binDir;
  } catch {
    return null;
  }
}

function briefingSettingsPath(homedir, agentId) {
  const safe = String(agentId || '').replace(/[^A-Za-z0-9_.-]/g, '_') || 'leader';
  return path.join(instancePaths.crewpaneHome(homedir), `briefing-settings-${safe}.json`);
}

function ensureNodeLauncher(dir, deps = {}) {
  try {
    const launcher = deps.launcher || mcpNode.resolveMcpNode();
    const binDir = path.join(dir, 'bin');
    const files = mcpNode.nodeLauncherFiles(launcher, { platform: deps.platform, dir: binDir });
    if (!files.length) return null;
    fs.mkdirSync(binDir, { recursive: true });
    for (const f of files) {
      winSafeAtomicWrite(path.join(binDir, f.name), f.contents, {});
      try { fs.chmodSync(path.join(binDir, f.name), f.mode); } catch { /* win32: no-op */ }
    }
    return binDir;
  } catch {
    return null;
  }
}

function ensureBriefingSettings(homedir, agentId, opts = {}) {
  try {
    const dir = instancePaths.crewpaneHome(homedir);
    fs.mkdirSync(dir, { recursive: true });
    const cfgPath = briefingSettingsPath(homedir, agentId);
    const launcher = mcpNode.resolveMcpNode();
    const launcherDir = ensureNodeLauncher(dir, { launcher });
    const cmd = mcpNode.nodeShellCommand(
      [briefingHookPath(), '--home', dir, '--agent', agentId],
      { launcher, launcherDir },
    );
    const hooks = {};
    if (opts.briefing !== false) {
      hooks.UserPromptSubmit = [
        {
          hooks: [
            { type: 'command', command: cmd, timeout: 10 },
          ],
        },
      ];
    }
    if (opts.killGuard !== false) {
      hooks.PreToolUse = [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: mcpNode.nodeShellCommand([killGuardHookPath()], { launcher, launcherDir }),
              timeout: 5,
            },
          ],
        },
      ];
    }
    if (!Object.keys(hooks).length) return null;
    writeJsonAtomic(cfgPath, { hooks });
    return cfgPath;
  } catch {
    return null;
  }
}

function integrationsMcpConfigDir(homedir) {
  return path.join(instancePaths.crewpaneHome(homedir), 'mcp');
}

function identityPaneKey(opts) {
  return String((opts && (opts.agentId || opts.paneId)) || 'pane').replace(/[^A-Za-z0-9_.-]/g, '_') || 'pane';
}

function integrationsPaneKey(opts) {
  const o = opts || {};
  if (o.agentId || o.paneId) return identityPaneKey(o);
  return identityPaneKey({ agentId: o.leaderId });
}

function integrationsMcpConfigPath(homedir, opts) {
  return path.join(integrationsMcpConfigDir(homedir), `integrations-${integrationsPaneKey(opts)}.json`);
}

const INTEGRATIONS_CONFIG_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function sweepStaleIntegrationsConfigs(homedir, now = Date.now()) {
  const dir = integrationsMcpConfigDir(homedir);
  let removed = 0;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!/^integrations-.+\.json$/.test(name)) continue;
    const full = path.join(dir, name);
    try {
      if (now - fs.statSync(full).mtimeMs <= INTEGRATIONS_CONFIG_MAX_AGE_MS) continue;
      fs.unlinkSync(full);
      removed += 1;
    } catch {
      /* best-effort */
    }
  }
  return removed;
}

function removeLegacySharedIntegrationsConfig(homedir) {
  try {
    fs.unlinkSync(path.join(instancePaths.crewpaneHome(homedir), 'integrations-mcp.json'));
    return true;
  } catch {
    return false;
  }
}

function cleanupIntegrationsMcpConfig(homedir, opts) {
  try {
    fs.unlinkSync(integrationsLazyManifestPath(homedir, opts));
  } catch {
    /* zaten yok */
  }
  try {
    fs.unlinkSync(integrationsMcpConfigPath(homedir, opts));
    return true;
  } catch {
    return false;
  }
}

function cleanupAgyWorkspacePlugin(homedir, opts) {
  return agyWorkspacePlugin.cleanupPlugin(instancePaths.crewpaneHome(homedir), integrationsPaneKey(opts));
}

function sweepStaleAgyWorkspacePlugins(homedir, now = Date.now()) {
  return agyWorkspacePlugin.sweepStalePlugins(instancePaths.crewpaneHome(homedir), now);
}

function userFieldEnv(entry, userFields) {
  const out = {};
  if (!userFields || typeof userFields !== 'object') return out;
  const declared = Array.isArray(entry.userFields) ? entry.userFields : [];
  for (const field of declared) {
    const name = field && field.envVar;
    if (typeof name !== 'string' || !name || name === entry.envVar) continue;
    const value = userFields[name];
    if (typeof value !== 'string' || !value.trim()) continue;
    out[name] = value;
  }
  return out;
}

function integrationServerBlock(entry, item) {
  const server = entry.mcpServer;
  if (!server) return null;
  const fields = userFieldEnv(entry, item.userFields);
  const transport = server.transport === 'http' ? 'http' : 'stdio';

  if (transport === 'stdio') {
    if (typeof server.command !== 'string' || !server.command) return null;
    const direct = crewpaneEnv.readEnv('MCP_NPX_DIRECT') === '0'
      ? null
      : npxDirect.directCommand(server);
    return {
      command: direct ? direct.command : server.command,
      args: direct ? [...direct.args] : (Array.isArray(server.args) ? [...server.args] : []),
      env: { [entry.envVar]: `\${${item.envVar}}`, ...fields, ...(direct && direct.env) },
    };
  }

  const map = new Map([[entry.envVar, `\${${item.envVar}}`]]);
  for (const [name, value] of Object.entries(fields)) map.set(name, value);
  let broke = false;
  const expand = (raw) => String(raw).replace(/\$\{([A-Za-z0-9_]+)\}/g, (whole, name) => {
    if (!map.has(name)) { broke = true; return whole; }
    return map.get(name);
  });

  if (typeof server.url !== 'string' || !server.url) return null;
  const url = expand(server.url);
  const headers = {};
  for (const [name, value] of Object.entries(server.headers || {})) {
    if (typeof value !== 'string') return null;
    headers[name] = expand(value);
  }
  if (broke) return null;
  if (!/^https:\/\//i.test(url)) return null;
  return { type: 'http', url, headers };
}

const LAZY_PROXY_FILE = 'mcpLazyProxy.cjs';
const LAZY_MIN_SERVICES_DEFAULT = 2;
const LAZY_IDLE_MS_DEFAULT = 10 * 60 * 1000;

function lazyProxyPath() {
  return path.join(mcpServerDir(), LAZY_PROXY_FILE);
}

function integrationsLazyManifestPath(homedir, opts) {
  return path.join(integrationsMcpConfigDir(homedir), `lazy-${integrationsPaneKey(opts)}.json`);
}

function integrationsToolCacheDir(homedir) {
  return path.join(integrationsMcpConfigDir(homedir), 'tool-cache');
}

function lazyEnabled() {
  return crewpaneEnv.readEnv('MCP_LAZY') !== '0';
}

function lazyMinServices() {
  const raw = Number(crewpaneEnv.readEnv('MCP_LAZY_MIN'));
  return Number.isFinite(raw) && raw >= 1 ? raw : LAZY_MIN_SERVICES_DEFAULT;
}

function buildLazyIntegrationServers(stdioBlocks, homedir, opts) {
  const ids = Object.keys(stdioBlocks);
  if (ids.length < lazyMinServices()) return null;
  const proxyScript = lazyProxyPath();
  try {
    if (!fs.existsSync(proxyScript)) return null;
  } catch {
    return null;
  }
  const env = {};
  const services = [];
  for (const id of ids) {
    const b = stdioBlocks[id];
    const envKeys = Object.keys(b.env || {}).filter(k => k !== 'ELECTRON_RUN_AS_NODE');
    for (const k of envKeys) env[k] = b.env[k];
    services.push({ id, command: b.command, args: Array.isArray(b.args) ? [...b.args] : [], envKeys,
      ...(b.env && b.env.ELECTRON_RUN_AS_NODE === '1' ? { runAsNode: true } : {}),
    });
  }
  const manifestPath = integrationsLazyManifestPath(homedir, opts);
  const idleMin = Number(crewpaneEnv.readEnv('MCP_IDLE_MIN'));
  const manifest = {
    version: 1,
    cacheDir: integrationsToolCacheDir(homedir),
    idleMs: Number.isFinite(idleMin) && idleMin >= 0 ? idleMin * 60 * 1000 : LAZY_IDLE_MS_DEFAULT,
    services,
  };
  const entry = mcpEntry(proxyScript);
  return {
    manifestPath,
    manifest,
    servers: {
      integrations: { command: entry.command, args: [...entry.args, manifestPath], env: { ...env, ...entry.env } },
    },
  };
}

function readIntegrationsConfigFacts(homedir, opts) {
  try {
    const doc = JSON.parse(fs.readFileSync(integrationsMcpConfigPath(homedir, opts), 'utf8'));
    const servers = Object.keys((doc && doc.mcpServers) || {});
    return { lazy: servers.includes('integrations'), servers };
  } catch {
    return null;
  }
}

function ensureIntegrationsMcpConfig(homedir, resolved, opts) {
  const list = Array.isArray(resolved) ? resolved.filter(Boolean) : [];
  try {
    const dir = integrationsMcpConfigDir(homedir);
    const cfgPath = integrationsMcpConfigPath(homedir, opts);
    const mcpServers = {};
    for (const item of list) {
      const entry = item.entry;
      if (!entry || !entry.mcpServer || !entry.envVar || !item.envVar) continue;
      const block = integrationServerBlock(entry, item);
      if (!block) continue;
      mcpServers[entry.id || item.service] = block;
    }
    if (lazyEnabled()) {
      const stdioBlocks = {};
      const httpBlocks = {};
      for (const [id, block] of Object.entries(mcpServers)) {
        if (block && block.type === 'http') httpBlocks[id] = block;
        else stdioBlocks[id] = block;
      }
      const lazy = buildLazyIntegrationServers(stdioBlocks, homedir, opts);
      if (lazy) {
        fs.mkdirSync(dir, { recursive: true });
        writeJsonAtomic(lazy.manifestPath, lazy.manifest);
        for (const k of Object.keys(mcpServers)) delete mcpServers[k];
        Object.assign(mcpServers, httpBlocks, lazy.servers);
        if (opts && typeof opts.log === 'function') {
          opts.log(`integrations: tembel baslatma acik → ${lazy.manifest.services.length} servis ilk cagriya kadar surec ACMAZ`);
        }
      }
    }
    if (!Object.keys(mcpServers).length) {
      let removed = false;
      try {
        fs.unlinkSync(cfgPath);
        removed = true;
      } catch {
        /* zaten yok */
      }
      if (removed && opts && typeof opts.log === 'function') {
        opts.log(`integrations: bu pane için çözümlenen kayıt yok → ${path.basename(cfgPath)} silindi`);
      }
      return null;
    }
    fs.mkdirSync(dir, { recursive: true });
    writeJsonAtomic(cfgPath, { mcpServers });
    removeLegacySharedIntegrationsConfig(homedir);
    sweepStaleIntegrationsConfigs(homedir);
    return cfgPath;
  } catch {
    return null;
  }
}

function gateIntegrations(resolved, opts, homedir) {
  const all = Array.isArray(resolved) ? resolved.filter(Boolean) : [];
  return integrationAutostart.filterResolved(all, instancePaths.crewpaneHome(homedir), {
    scope: integrationAutostart.scopeOf(opts),
  });
}

function codeIndexMcpConfigPath(homedir, commandKey) {
  return path.join(instancePaths.crewpaneHome(homedir), mcpConfigFileName('code-index-mcp', commandKey));
}

function ensureCodeIndexMcpConfig(homedir, commandKey, server) {
  try {
    if (!server || typeof server.command !== 'string' || !server.command) return null;
    const dir = instancePaths.crewpaneHome(homedir);
    fs.mkdirSync(dir, { recursive: true });
    const cfgPath = codeIndexMcpConfigPath(homedir, commandKey);
    writeJsonAtomic(cfgPath, mcpConfigDoc(commandKey, {
      [codeIndexStore.SERVER_NAME]: { command: server.command, args: Array.isArray(server.args) ? [...server.args] : [] },
    }));
    return cfgPath;
  } catch {
    return null;
  }
}

function codeIndexInjectable(commandKey) {
  const d = engineCapability(commandKey, 'mcp');
  return !!(d && d.kind === 'config-file' && d.flag);
}

function integrationsInjectable(commandKey) {
  return paneCapabilityMatrix.mcpCanCarrySecrets(engineCapability(commandKey, 'mcp'));
}

function integrationContextFor(opts) {
  const o = opts || {};
  return {
    projectId: typeof o.projectId === 'string' ? o.projectId : null,
    env: o.integrationEnv === 'prod' ? 'prod' : 'dev',
    services: Array.isArray(o.integrations) ? o.integrations : null,
  };
}

function resolveIntegrationCreds(opts, trusted) {
  const resolver = trusted && trusted.integrations;
  if (!resolver || typeof resolver.resolve !== 'function') return [];
  try {
    const out = resolver.resolve(integrationContextFor(opts));
    return Array.isArray(out) ? out.filter(Boolean) : [];
  } catch {
    return [];
  }
}

module.exports = {
  BRIEFING_HOOK_FILE,
  briefingHookPath,
  KILL_GUARD_HOOK_FILE,
  KILL_GUARD_SHIM_FILE,
  AGY_HOOK_FILE,
  agyHookRunnerPath,
  killGuardHookPath,
  killGuardShimCliPath,
  resolveRealBin,
  ensureKillGuardShims,
  briefingSettingsPath,
  ensureNodeLauncher,
  ensureBriefingSettings,
  integrationsMcpConfigDir,
  integrationsPaneKey,
  integrationsMcpConfigPath,
  INTEGRATIONS_CONFIG_MAX_AGE_MS,
  sweepStaleIntegrationsConfigs,
  removeLegacySharedIntegrationsConfig,
  cleanupIntegrationsMcpConfig,
  cleanupAgyWorkspacePlugin,
  sweepStaleAgyWorkspacePlugins,
  userFieldEnv,
  integrationServerBlock,
  LAZY_PROXY_FILE,
  LAZY_MIN_SERVICES_DEFAULT,
  LAZY_IDLE_MS_DEFAULT,
  lazyProxyPath,
  integrationsLazyManifestPath,
  integrationsToolCacheDir,
  lazyEnabled,
  lazyMinServices,
  buildLazyIntegrationServers,
  readIntegrationsConfigFacts,
  ensureIntegrationsMcpConfig,
  gateIntegrations,
  codeIndexMcpConfigPath,
  ensureCodeIndexMcpConfig,
  codeIndexInjectable,
  integrationsInjectable,
  integrationContextFor,
  resolveIntegrationCreds,
};
