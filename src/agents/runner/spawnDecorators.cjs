'use strict';

const path = require('node:path');
const crewpaneEnv = require('../../config/crewpaneEnv.cjs');
const instancePaths = require('../../config/instancePaths.cjs');
const { normalizeDepartment } = require('../teamResolve.cjs');
const codexMcpProfile = require('../../mcp/codexMcpProfile.cjs');
const agyWorkspacePlugin = require('../agyWorkspacePlugin.cjs');
const mcpNode = require('../../../platform/mcpNode.cjs');
const { engineCapability, engineAutonomy, getEngineRegistry } = require('./registryBridge.cjs');
const { applyArgs, repeatFlagArgs, tomlBasicString } = require('./spawnArgs.cjs');
const { isLeaderSpawn } = require('./leaderDetector.cjs');
const { parseEnvConfigDoc } = require('./identityCarrier.cjs');
const {
  leaderMcpServers,
  commonMcpServers,
  ensureDelegateMcpConfig,
  ensureBrowserMcpConfig,
  ensureTaskMcpConfig,
} = require('./mcpServers.cjs');
const {
  integrationsPaneKey,
  ensureNodeLauncher,
  ensureBriefingSettings,
  gateIntegrations,
  ensureIntegrationsMcpConfig,
  integrationsInjectable,
  codeIndexInjectable,
  ensureCodeIndexMcpConfig,
  integrationContextFor,
  agyHookRunnerPath,
} = require('./integrationsConfig.cjs');

const CODEX_MCP_ENV_KEYS = Object.freeze([
  ...crewpaneEnv.bothNames('INSTANCE'),
  ...crewpaneEnv.bothNames('HOME'),
  ...crewpaneEnv.bothNames('ACCOUNT'),
  ...crewpaneEnv.bothNames('BRIDGE_PORT'),
  ...crewpaneEnv.bothNames('BRIDGE_TOKEN'),
  ...crewpaneEnv.bothNames('BRIDGE_HOST'),
  'NEXT_PUBLIC_CREWPANE_SUPABASE_URL',
  'NEXT_PUBLIC_CREWPANE_SUPABASE_ANON_KEY',
  'CREWPANE_MCP_LEGACY_ALIASES',
  'PATH',
]);

const CODEX_SUBAGENT_BLOCK_ARGS = Object.freeze(['--disable', 'multi_agent']);

function codexMcpServerEnv(opts, childEnv, leader) {
  const env = {};
  const base = childEnv && typeof childEnv === 'object' ? childEnv : {};
  for (const k of CODEX_MCP_ENV_KEYS) {
    if (typeof base[k] === 'string' && base[k]) env[k] = base[k];
  }
  const agentId = opts && typeof opts.agentId === 'string' ? opts.agentId.trim() : '';
  if (agentId) crewpaneEnv.dualWrite(env, leader ? 'LEADER_ID' : 'AGENT_ID', agentId);
  const department = normalizeDepartment(opts && opts.department);
  if (department) crewpaneEnv.dualWrite(env, 'DEPARTMENT', department);
  return env;
}

function codexMcpOverrideArgs(servers, env, spec) {
  const flag = (spec && spec.flag) || '-c';
  const prefix = (spec && spec.keyPrefix) || 'mcp_servers';
  const args = [];
  const entries = Object.entries(env || {});
  const table = entries.map(([k, v]) => `${tomlBasicString(k)}=${tomlBasicString(v)}`).join(',');
  for (const s of servers) {
    args.push(flag, `${prefix}.${s.name}.command="node"`);
    args.push(flag, `${prefix}.${s.name}.args=[${tomlBasicString(s.path)}]`);
    if (entries.length) args.push(flag, `${prefix}.${s.name}.env={${table}}`);
  }
  return args;
}

function commandStringExtensionArgs(servers, env, spec) {
  if (!spec || !spec.flag) return [];
  const quote = (v) => {
    const str = String(v);
    if (spec.quote !== 'single' || !/[\s'"$`\\]/.test(str)) return str;
    return `'${str.replace(/'/g, "'\\''")}'`;
  };
  const envPairs =
    spec.envInheritance === false
      ? Object.entries(env || {}).map(([k, v]) => `${k}=${quote(v)}`)
      : [];
  const args = [];
  for (const s of servers) {
    args.push(spec.flag, [...envPairs, 'node', quote(s.path)].join(' '));
  }
  return args;
}

function mcpRegisterArgs(commandKey, { servers, configPath, strict, env, homedir, childEnv, binFile, log, deps, opts } = {}) {
  let d = engineCapability(commandKey, 'mcp');
  if (!d) return [];
  if (d.kind === 'config-profile') {
    const profileD = d;
    const supported = codexMcpProfile.supportsProfileFile(
      binFile || commandKey,
      childEnv,
      deps || {},
      profileD.minVersion,
    );
    if (supported) {
      const written = codexMcpProfile.writeProfile(
        {
          servers: servers || [],
          env,
          keyPrefix: profileD.keyPrefix || 'mcp_servers',
          codexHome: codexMcpProfile.codexHomeDir(childEnv, homedir),
        },
        deps || {},
      );
      if (written) {
        if (typeof log === 'function') {
          log(`MCP kaydı DOSYADAN (${commandKey}/${profileD.flag}): ${written.file} (${written.bytes} bayt, ${(servers || []).length} sunucu)`);
        }
        return [profileD.flag, written.name];
      }
      if (typeof log === 'function') {
        log(`MCP profil dosyası YAZILAMADI (${commandKey}) → oturum-başı ${(profileD.fallback && profileD.fallback.flag) || '-c'} yoluna düşüldü (komut satırı UZUN kalır)`);
      }
    } else if (typeof log === 'function') {
      log(`MCP profil dosyası DESTEKLENMİYOR (${commandKey} < ${profileD.minVersion} ya da sürüm ölçülemedi) → oturum-başı ${(profileD.fallback && profileD.fallback.flag) || '-c'} yoluna düşüldü`);
    }
    if (!profileD.fallback) return [];
    d = profileD.fallback;
  }
  if (d.kind === 'workspace-plugin') {
    if (!Array.isArray(servers) || !servers.length) {
      if (typeof log === 'function') {
        log(`MCP kaydı ATLANDI (${commandKey}/${d.kind}): bu yol sunucu LİSTESİ vermiyor (config dosyası yolu) → demet DEĞİŞMEDİ`);
      }
      return [];
    }
    const root = agyWorkspacePlugin.pluginRootDir(
      instancePaths.crewpaneHome(homedir),
      integrationsPaneKey(opts),
    );
    const written = agyWorkspacePlugin.writePlugin({ servers: servers || [], env, root, descriptor: d });
    if (!written) {
      if (typeof log === 'function') {
        log(`MCP demeti YAZILAMADI (${commandKey}/${d.pluginName}) → pane bu araçlar OLMADAN açılıyor`);
      }
      return [];
    }
    agyWorkspacePlugin.sweepStalePlugins(instancePaths.crewpaneHome(homedir));
    if (typeof log === 'function') {
      log(
        `MCP kaydı ÇALIŞMA-ALANI DEMETİNDEN (${commandKey}): ${written.dir} ` +
          `(${written.servers} sunucu, ${written.bytes} bayt, değişen: ${written.changed.length ? written.changed.join(',') : 'YOK — idempotent'})`,
      );
    }
    return d.rootFlag ? [d.rootFlag, written.root] : [];
  }
  if (d.kind === 'env-config') {
    if (!Array.isArray(servers) || !servers.length) {
      if (typeof log === 'function') {
        log(`MCP kaydı ATLANDI (${commandKey}/${d.kind}): bu yol sunucu LİSTESİ vermiyor → belge DEĞİŞMEDİ`);
      }
      return [];
    }
    if (!d.env || typeof d.configPath !== 'string' || !d.configPath || !childEnv || typeof childEnv !== 'object') {
      if (typeof log === 'function') {
        log(`MCP kaydı YAPILAMADI (${commandKey}/${d.kind}): env/configPath beyanı ya da childEnv yok → pane bu araçlar OLMADAN açılıyor`);
      }
      return [];
    }
    const existing = typeof childEnv[d.env] === 'string' ? childEnv[d.env] : '';
    const doc = parseEnvConfigDoc(existing, d.env, 'MCP kaydı', log);
    const launcher = mcpNode.resolveMcpNode();
    const envKey = d.serverEnvPath || 'environment';
    const map = {};
    for (const s of servers) {
      map[s.name] = {
        type: 'local',
        command: [launcher.command, s.path],
        enabled: true,
        [envKey]: { ...(launcher.env || {}), ...(env || {}) },
      };
    }
    const segs = d.configPath.split('.');
    let cur = doc;
    for (const seg of segs.slice(0, -1)) {
      if (!cur[seg] || typeof cur[seg] !== 'object' || Array.isArray(cur[seg])) cur[seg] = {};
      cur = cur[seg];
    }
    const leaf = segs[segs.length - 1];
    const prev = cur[leaf] && typeof cur[leaf] === 'object' && !Array.isArray(cur[leaf]) ? cur[leaf] : {};
    cur[leaf] = { ...prev, ...map };
    childEnv[d.env] = JSON.stringify(doc);
    if (typeof log === 'function') {
      const strictNote = strict
        ? d.strictFlag
          ? `strict ${d.strictFlag}`
          : 'strict UYGULANAMAZ (motor sert izolasyon bayrağı beyan etmiyor; kullanıcı sunucuları birleşir)'
        : 'additive';
      log(
        `MCP kaydı ENV-BELGEDEN (${commandKey}): ${servers.length} sunucu → ${d.env}.${d.configPath} ` +
          `(${Object.keys(prev).length} mevcut korundu, yorumlayıcı ${launcher.source}), ${strictNote}`,
      );
    }
    return [];
  }
  if (d.kind === 'config-file') {
    if (!d.flag) return [];
    const cfgPath = typeof configPath === 'function' ? configPath() : configPath;
    if (!cfgPath) return [];
    const value = `${d.valuePrefix || ''}${cfgPath}`;
    return strict && d.strictFlag ? [d.flag, value, d.strictFlag] : [d.flag, value];
  }
  if (d.kind === 'cli-overrides') return codexMcpOverrideArgs(servers || [], env, d);
  if (d.kind === 'cli-command') return commandStringExtensionArgs(servers || [], env, d);
  return [];
}

function contributionPosition(commandKey) {
  const d = engineCapability(commandKey, 'identity');
  return d && d.position === 'last' ? 'prepend' : 'append';
}

function leaderDelegationStatus(commandKey, opts, argvBefore, argvAfter, envBefore, envAfter) {
  if (!isLeaderSpawn(opts)) return null;
  const argvWired = argvAfter !== argvBefore && argvAfter.length !== argvBefore.length;
  const envWired = (typeof envBefore === 'string' || typeof envAfter === 'string') && envBefore !== envAfter;
  if (argvWired || envWired) return { expected: true, wired: true, reason: null };
  const mcp = engineCapability(commandKey, 'mcp');
  const reason = mcp
    ? mcp.env
      ? `motorun araç kaydı '${mcp.kind}' — config belgesi (${mcp.env}) DEĞİŞMEDİ, sunucular birleştirilemedi`
      : `motorun araç kaydı '${mcp.kind}' — pane BAŞINA sunucu kaydı yapılamıyor`
    : 'motor MCP araç kaydı beyan etmiyor';
  return { expected: true, wired: false, engine: commandKey, reason };
}

function mcpEnvSnapshot(commandKey, childEnv) {
  const mcp = engineCapability(commandKey, 'mcp');
  if (!mcp || !mcp.env || !childEnv) return undefined;
  return typeof childEnv[mcp.env] === 'string' ? childEnv[mcp.env] : '';
}

function withLeaderDelegation(argv, commandKey, opts, homedir, childEnv, trusted) {
  if (!isLeaderSpawn(opts)) return argv;
  const group = [
    ...subagentBlockArgs(commandKey, argv),
    ...mcpRegisterArgs(commandKey, {
      servers: leaderMcpServers(),
      configPath: () => ensureDelegateMcpConfig(homedir, commandKey),
      strict: true,
      env: codexMcpServerEnv(opts, childEnv, true),
      opts,
      homedir,
      childEnv,
      binFile: trusted && trusted.binFile,
      log: trusted && trusted.log,
      deps: trusted && trusted.mcpProfileDeps,
    }),
  ];
  return applyArgs(argv, group, contributionPosition(commandKey));
}

function withBrowserCapable(argv, commandKey, opts, homedir, childEnv, trusted) {
  if (!opts || !opts.browserCapable) return argv;
  if (isLeaderSpawn(opts)) return argv;
  const group = [
    ...subagentBlockArgs(commandKey, argv),
    ...mcpRegisterArgs(commandKey, {
      servers: commonMcpServers(),
      configPath: () => ensureBrowserMcpConfig(homedir, commandKey),
      strict: true,
      env: codexMcpServerEnv(opts, childEnv, false),
      opts,
      homedir,
      childEnv,
      binFile: trusted && trusted.binFile,
      log: trusted && trusted.log,
      deps: trusted && trusted.mcpProfileDeps,
    }),
  ];
  return applyArgs(argv, group, contributionPosition(commandKey));
}

function withBrowserEnv(childEnv, commandKey, opts) {
  const reg = getEngineRegistry();
  if (!(reg && typeof reg.isRegisteredEngine === 'function' && reg.isRegisteredEngine(commandKey)) || !opts) return childEnv;
  if (crewpaneEnv.readEnv('LEADER_ID', childEnv)) return childEnv;
  const agentId = typeof opts.agentId === 'string' ? opts.agentId.trim() : '';
  if (agentId) crewpaneEnv.dualWrite(childEnv, 'AGENT_ID', agentId);
  return childEnv;
}

function withSubagentBlock(argv, commandKey, opts) {
  if (!opts || !opts.disallowSubagent) return argv;
  return applyArgs(argv, subagentBlockArgs(commandKey, argv), subagentBlockPosition(commandKey));
}

function subagentBlockArgs(commandKey, argv) {
  const d = engineCapability(commandKey, 'subagentBlock');
  if (!d || !Array.isArray(d.args) || !d.args.length) return [];
  if (Array.isArray(argv) && d.dedupeToken && argv.includes(d.dedupeToken)) return [];
  return [...d.args];
}

function subagentBlockPosition(commandKey) {
  return (engineCapability(commandKey, 'subagentBlock') || {}).position;
}

function withLeaderEnv(childEnv, commandKey, opts) {
  const reg = getEngineRegistry();
  if (!(reg && typeof reg.isRegisteredEngine === 'function' && reg.isRegisteredEngine(commandKey)) || !isLeaderSpawn(opts)) return childEnv;
  const agentId = opts && typeof opts.agentId === 'string' ? opts.agentId.trim() : '';
  if (agentId) crewpaneEnv.dualWrite(childEnv, 'LEADER_ID', agentId);
  const department = normalizeDepartment(opts && opts.department);
  if (department) crewpaneEnv.dualWrite(childEnv, 'DEPARTMENT', department);
  return childEnv;
}

function withTaskCapable(argv, commandKey, opts, homedir, childEnv, trusted) {
  if (isLeaderSpawn(opts)) return argv;
  if (opts && opts.browserCapable) return argv;
  const args = mcpRegisterArgs(commandKey, {
    servers: commonMcpServers(),
    configPath: () => ensureTaskMcpConfig(homedir, commandKey),
    strict: false,
    env: codexMcpServerEnv(opts, childEnv, false),
    opts,
    homedir,
    childEnv,
    binFile: trusted && trusted.binFile,
    log: trusted && trusted.log,
    deps: trusted && trusted.mcpProfileDeps,
  });
  return applyArgs(argv, args, contributionPosition(commandKey));
}

function withTurnBriefing(argv, commandKey, opts, homedir) {
  const hook = (engineCapability(commandKey, 'hooks') || {}).userPromptSubmit;
  if (!hook || !hook.flag) return argv;
  const wantBriefing = crewpaneEnv.readEnv('TURN_BRIEFING') !== '0' && isLeaderSpawn(opts);
  const wantKillGuard = crewpaneEnv.readEnv('KILL_GUARD') !== '0';
  const named = (opts && typeof opts.agentId === 'string' ? opts.agentId.trim() : '')
    || (opts && typeof opts.leaderId === 'string' ? opts.leaderId.trim() : '');
  const agentId = named || 'pane';
  const briefing = wantBriefing && !!named;
  if (!briefing && !wantKillGuard) return argv;
  const cfgPath = ensureBriefingSettings(homedir, agentId, {
    briefing,
    killGuard: wantKillGuard,
  });
  if (!cfgPath) return argv;
  return applyArgs(argv, [hook.flag, cfgPath], contributionPosition(commandKey));
}

function withAgyHooks(argv, commandKey, opts, homedir) {
  const hookD = engineCapability(commandKey, 'hooks');
  if (!hookD || hookD.carrier !== 'workspace-plugin') return argv;
  const mcpD = engineCapability(commandKey, 'mcp');
  if (!mcpD || mcpD.kind !== 'workspace-plugin' || !mcpD.rootFlag) return argv;

  const named = (opts && typeof opts.agentId === 'string' ? opts.agentId.trim() : '')
    || (opts && typeof opts.leaderId === 'string' ? opts.leaderId.trim() : '');
  const wantBriefing =
    crewpaneEnv.readEnv('TURN_BRIEFING') !== '0' && isLeaderSpawn(opts) && !!named;
  const blockD = engineCapability(commandKey, 'subagentBlock');
  const wantGuard =
    !!(blockD && blockD.via === 'workspace-plugin-hook')
    && (!!(opts && opts.disallowSubagent === true) || isLeaderSpawn(opts));
  if (!wantBriefing && !wantGuard) return argv;

  const dir = instancePaths.crewpaneHome(homedir);
  const launcher = mcpNode.resolveMcpNode();
  const launcherDir = ensureNodeLauncher(dir, { launcher });
  const runner = agyHookRunnerPath();
  const cmd = (args) => mcpNode.nodeShellCommand([runner, ...args], { launcher, launcherDir });

  const permissive = ((engineAutonomy(commandKey) || {}).level === 'full');
  const root = agyWorkspacePlugin.pluginRootDir(dir, integrationsPaneKey(opts));
  const written = agyWorkspacePlugin.writeHooks({
    root,
    descriptor: mcpD,
    hooks: {
      permissive,
      briefingCommand: wantBriefing
        ? cmd(['--event', 'PreInvocation', '--home', dir, '--agent', named])
        : null,
      guardCommand: wantGuard
        ? cmd(permissive ? ['--event', 'PreToolUse', '--permissive'] : ['--event', 'PreToolUse'])
        : null,
    },
  });
  if (!written) return argv;

  if (Array.isArray(argv) && argv.includes(written.root)) return argv;
  return applyArgs(argv, [mcpD.rootFlag, written.root], contributionPosition(commandKey));
}

function withIntegrations(argv, commandKey, opts, homedir, childEnv, resolved) {
  const broadcastEnv = (childEnv && childEnv.CREWPANE_BROADCAST) ?? process.env.CREWPANE_BROADCAST;
  if (String(broadcastEnv || '').trim() === '1') return argv;
  const gate = gateIntegrations(resolved, opts, homedir);
  const list = gate.kept;
  if (gate.skipped.length && opts && typeof opts.log === 'function') {
    const why = gate.skipped.map((sv) => `${sv}(${gate.reasons[sv] || 'genel'})`).join(', ');
    opts.log(`integrations: bu pane'in profilinde kapali → ${why} (baglanti duruyor)`);
  }
  const cfgPath = ensureIntegrationsMcpConfig(homedir, list, opts);
  if (!list.length || !cfgPath) return argv;
  if (!integrationsInjectable(commandKey)) return argv;
  if (childEnv && typeof childEnv === 'object') {
    for (const item of list) {
      if (typeof item.envVar === 'string' && typeof item.secret === 'string') {
        childEnv[item.envVar] = item.secret;
      }
    }
  }
  const args = mcpRegisterArgs(commandKey, { configPath: cfgPath, strict: false });
  return applyArgs(argv, args, contributionPosition(commandKey));
}

function withCodeIndex(argv, commandKey, opts, homedir, trusted) {
  const resolver = trusted && trusted.codeIndex;
  if (!resolver || typeof resolver.resolve !== 'function') return argv;
  if (!codeIndexInjectable(commandKey)) return argv;
  const ctx = integrationContextFor(opts);
  const projectId = ctx.projectId
    || normalizeDepartment(opts && opts.department) || null;
  let resolved = null;
  try {
    resolved = resolver.resolve(projectId);
  } catch {
    return argv;
  }
  if (!resolved || !resolved.server) return argv;
  const args = mcpRegisterArgs(commandKey, {
    configPath: () => ensureCodeIndexMcpConfig(homedir, commandKey, resolved.server),
    strict: false,
  });
  return applyArgs(argv, args, contributionPosition(commandKey));
}

module.exports = {
  applyArgs,
  repeatFlagArgs,
  CODEX_MCP_ENV_KEYS,
  CODEX_SUBAGENT_BLOCK_ARGS,
  tomlBasicString,
  codexMcpServerEnv,
  codexMcpOverrideArgs,
  commandStringExtensionArgs,
  mcpRegisterArgs,
  contributionPosition,
  leaderDelegationStatus,
  mcpEnvSnapshot,
  withLeaderDelegation,
  withBrowserCapable,
  withBrowserEnv,
  withSubagentBlock,
  subagentBlockArgs,
  subagentBlockPosition,
  withLeaderEnv,
  withTaskCapable,
  withTurnBriefing,
  withAgyHooks,
  agyHookRunnerPath,
  withIntegrations,
  withCodeIndex,
};
