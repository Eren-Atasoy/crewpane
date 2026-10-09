// CrewPane — Engine Auth Status Probing and Aggregation.
'use strict';

const { execFile } = require('node:child_process');
const engineCheck = require('../engineCheck.cjs');
const engineInstall = require('../engineInstall.cjs');
const engineBilling = require('../engineBilling.cjs');
const { STATUS_TIMEOUT_MS } = require('./constants.cjs');
const { authDescriptor, authEngines } = require('./descriptors.cjs');
const { parseStatus, statusUnmeasured } = require('./statusParser.cjs');
const { apiKeyStoreOf, apiKeyEnvFor, hasLoginRecord } = require('./apiKeyVault.cjs');
const { resolveBin, execEnv, binErrorFor, execTarget, withVerbatim } = require('./engineBin.cjs');

/**
 * Bir motorun oturum durumunu OKUR. ASLA reddetmez — hata = "bilinmiyor".
 */
async function readStatus(engine, deps = {}) {
  const desc = authDescriptor(engine, deps);
  const store = apiKeyStoreOf(deps);
  const base = {
    engine,
    label: desc ? desc.label : engine,
    accountHint: desc ? desc.accountHint : null,
    signupUrl: desc ? desc.signupUrl : null,
    needsCode: desc ? desc.needsCode : false,
    flow: desc ? desc.flow : null,
    supportsSubscription:
      !!desc && (desc.flow === 'oauth-code' || desc.flow === 'oauth-callback' || desc.flow === 'device-code'),
    codeDisplayOnly: !!desc && desc.flow === 'device-code',
    externalNote: desc ? desc.externalNote || null : null,
    externalLoginCommand:
      desc && desc.flow === 'external' && Array.isArray(desc.loginArgv) && desc.loginArgv.length
        ? [desc.binName, ...desc.loginArgv].join(' ')
        : desc && desc.flow === 'external' && Array.isArray(desc.manualLoginArgv) && desc.manualLoginArgv.length
          ? [desc.binName, ...desc.manualLoginArgv].join(' ')
          : null,
    supportsApiKey: !!(desc && desc.apiKey),
    apiKeyEnv: desc && desc.apiKey ? desc.apiKey.env : null,
    apiKeyUrl: desc && desc.apiKey ? desc.apiKey.keyUrl || null : null,
    apiKeyLabel: desc && desc.apiKey ? desc.apiKey.keyLabel || null : null,
    apiKeyNote: desc && desc.apiKey ? desc.apiKey.note || null : null,
    noApiKeyNote: desc && !desc.apiKey ? desc.apiKeyNote || null : null,
    vendorHosted: null,
    vendorLabel: null,
    vendorDisclosure: null,
    vendorPolicy: null,
    vendorBlockedHint: null,
    vendorGate: false,
    apiKeySaved: false,
    multiAccount: !!(desc && desc.identityEnv),
    installed: false,
    loggedIn: false,
    method: null,
    account: null,
    plan: null,
    org: null,
    orgId: null,
    authKind: null,
    error: null,
  };
  if (!desc) return { ...base, error: 'unsupported-engine' };
  if (desc.apiKey && store) base.apiKeySaved = store.hasKey(desc.apiKey.vaultService);

  if (engineBilling.vendorSpecOf(engine)) {
    base.vendorGate = true;
    const vh = engineBilling.vendorHostedState(engine, {
      env: deps.env || process.env,
      homedir: deps.homedir,
      settings: deps.settings,
      credentialsFile: deps.credentialsFile,
    });
    base.vendorHosted = vh.vendorHosted;
    base.vendorLabel = vh.vendorLabel;
    base.vendorDisclosure = vh.disclosure;
    base.vendorPolicy = vh.policy;
    base.vendorBlockedHint = vh.blockedHint;
  }

  const bin = await resolveBin(engine, deps);
  if (!bin || !bin.found) {
    const unknown = bin && bin.state === 'unknown';
    const guide = engineInstall.installInfo(engine, { platform: deps.platform || process.platform });
    return {
      ...base,
      installed: unknown ? null : false,
      error: binErrorFor(bin),
      reason: (bin && bin.reason) || null,
      installUrl: (guide && guide.docsUrl) || engineCheck.INSTALL_HINTS[engine] || null,
      installCommand: (guide && guide.command) || null,
    };
  }

  const statusEnv = { ...execEnv(deps), ...apiKeyEnvFor(engine, deps) };

  if (!desc.statusArgv) {
    if (desc.flow !== 'api-key') {
      return {
        ...base,
        installed: true,
        loggedIn: null,
        statusUnknown: true,
        statusNote: desc.statusNote,
        authKind: null,
        method: null,
        verified: false,
        loginRecorded: hasLoginRecord(deps),
      };
    }
    return {
      ...base,
      installed: true,
      loggedIn: base.apiKeySaved,
      authKind: base.apiKeySaved ? 'api-key' : null,
      method: base.apiKeySaved ? 'API anahtarı' : null,
      verified: false,
    };
  }

  const exec = deps.execFile || execFile;
  const statusTarget = execTarget(bin, [...desc.statusArgv], deps);
  const result = await new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => done({ err: new Error('timeout'), stdout: '', code: null }), deps.timeoutMs || STATUS_TIMEOUT_MS);
    try {
      exec(statusTarget.file, statusTarget.argv,
        withVerbatim(statusTarget, { timeout: deps.timeoutMs || STATUS_TIMEOUT_MS, env: statusEnv }),
        (err, stdout, stderr) => {
          clearTimeout(timer);
          done({ err, stdout: `${stdout || ''}${stderr || ''}`, code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0) });
        });
    } catch (e) {
      clearTimeout(timer);
      done({ err: e, stdout: '', code: null });
    }
  });

  if (result.code === null) return { ...base, installed: true, error: 'probe-failed' };
  if (statusUnmeasured(desc, result.stdout, result.code)) {
    return { ...base, installed: true, error: 'probe-failed' };
  }
  const parsed = parseStatus(desc, result.stdout, result.code);
  return { ...base, installed: true, verified: true, ...parsed };
}

/** Tüm motorların durumu. Paralel, hiçbiri diğerini bloklamaz. */
async function readAllStatus(deps = {}) {
  const ids = deps.engines || authEngines(deps);
  const engines = await Promise.all(ids.map((id) => readStatus(id, deps)));
  return { engines };
}

module.exports = {
  readStatus,
  readAllStatus,
};
