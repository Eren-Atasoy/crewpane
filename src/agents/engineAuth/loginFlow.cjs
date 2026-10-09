// CrewPane — Engine Auth Login Session Lifecycle and Logout Operations.
'use strict';

const { execFile, spawn } = require('node:child_process');
const { terminateTree } = require('../../../platform/procProbe.cjs');
const { LOGIN_TIMEOUT_MS, STATUS_TIMEOUT_MS, maskSecrets } = require('./constants.cjs');
const { authDescriptor } = require('./descriptors.cjs');
const { apiKeyStoreOf, loginLedgerOf } = require('./apiKeyVault.cjs');
const { resolveBin, binErrorFor, execTarget, withVerbatim, execEnv, noopBrowserFor } = require('./engineBin.cjs');
const { readStatus } = require('./statusProber.cjs');

/** stdout içinden ilk http(s) URL'ini çeker. */
function extractUrl(text) {
  const m = String(text || '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').match(/https?:\/\/[^\s"'<>]+/);
  return m ? m[0] : null;
}

/** CLI "kodu yapıştır" istemini bastı mı? */
function wantsCode(text) {
  return /paste\s+code|enter\s+(the\s+)?code|authorization\s+code/i.test(String(text || ''));
}

/**
 * Yönetilen giriş oturumu.
 */
function startLogin(engine, deps = {}) {
  const meta = authDescriptor(engine, deps);
  if (!meta) throw new Error(`unsupported engine: ${engine}`);
  if (!meta.loginArgv) throw new Error(`engine has no subscription login flow: ${engine}`);

  const session = {
    id: deps.sessionId || `login-${engine}-${(deps.now ? deps.now() : Date.now())}`,
    engine,
    state: 'starting',
    url: null,
    needsCode: meta.needsCode,
    error: null,
    status: null,
  };

  const log = deps.log || (() => {});
  const listeners = [];
  const onUpdate = (fn) => { listeners.push(fn); };
  if (typeof deps.onUpdate === 'function') listeners.push(deps.onUpdate);

  const snapshot = () => ({
    id: session.id,
    engine: session.engine,
    state: session.state,
    url: session.url,
    needsCode: session.needsCode,
    error: session.error,
    status: session.status,
    unverified: session.unverified === true,
  });

  let settled = false;
  const emit = () => { const s = snapshot(); for (const fn of listeners) { try { fn(s); } catch { /* noop */ } } };
  const transition = (state, patch = {}) => {
    if (settled) return;
    Object.assign(session, patch, { state });
    if (state === 'done' || state === 'error' || state === 'cancelled') settled = true;
    log(`engineAuth ${engine} → ${state}${session.error ? ` (${maskSecrets(session.error)})` : ''}`);
    emit();
  };

  let child = null;
  let timer = null;
  const spawnFn = deps.spawn || spawn;

  const finish = async (code) => {
    if (settled) return;
    clearTimeout(timer);
    transition('verifying');
    let status = null;
    try { status = await readStatus(engine, deps); } catch { status = null; }
    if (status && status.loggedIn) transition('done', { status });
    else if (status && status.statusUnknown && code === 0) {
      const ledger = loginLedgerOf(deps);
      if (ledger && typeof ledger.record === 'function') {
        try { ledger.record(); } catch { /* defter bir kolaylık — akışı kıramaz */ }
      }
      transition('done', { status: { ...status, loginRecorded: true }, unverified: true });
    } else transition('error', { status, error: code === 0 ? 'giriş doğrulanamadı' : `giriş tamamlanmadı (çıkış ${code})` });
  };

  (async () => {
    const bin = await resolveBin(engine, deps);
    if (!bin || !bin.found) { transition('error', { error: binErrorFor(bin) }); return; }

    const argv = [...meta.loginArgv];
    const env = execEnv(deps);
    const noopBrowser = noopBrowserFor(deps);
    if (noopBrowser) env.BROWSER = noopBrowser;

    const target = execTarget(bin, argv, deps);
    try {
      child = spawnFn(target.file, target.argv, withVerbatim(target, { env, stdio: ['pipe', 'pipe', 'pipe'] }));
    } catch (e) {
      transition('error', { error: `başlatılamadı: ${e && e.message}` });
      return;
    }

    let buf = '';
    const onData = (d) => {
      buf += String(d);
      if (!session.url) {
        const url = extractUrl(buf);
        if (url) transition('awaiting-browser', { url });
      }
      if (session.url && meta.needsCode && wantsCode(buf) && session.state === 'awaiting-browser') {
        transition('awaiting-code');
      }
    };
    if (child.stdout) child.stdout.on('data', onData);
    if (child.stderr) child.stderr.on('data', onData);
    child.on('error', (e) => transition('error', { error: `çalıştırılamadı: ${e && e.message}` }));
    child.on('exit', (code) => { void finish(typeof code === 'number' ? code : -1); });

    timer = setTimeout(() => {
      if (settled) return;
      terminateTree(child, { platform: deps.platform });
      transition('error', { error: 'zaman aşımı — giriş tamamlanmadı' });
    }, deps.loginTimeoutMs || LOGIN_TIMEOUT_MS);
  })().catch((e) => transition('error', { error: `beklenmeyen: ${e && e.message}` }));

  return {
    get id() { return session.id; },
    get engine() { return session.engine; },
    snapshot,
    onUpdate,
    submitCode(code) {
      if (settled || !child || !child.stdin) return { ok: false, error: 'oturum aktif değil' };
      const clean = String(code || '').trim();
      if (!clean) return { ok: false, error: 'kod boş' };
      try {
        child.stdin.write(`${clean}\n`);
        transition('completing');
        return { ok: true };
      } catch (e) {
        return { ok: false, error: `iletilemedi: ${e && e.message}` };
      }
    },
    cancel() {
      if (settled) return { ok: true };
      clearTimeout(timer);
      if (child) terminateTree(child, { platform: deps.platform });
      transition('cancelled');
      return { ok: true };
    },
  };
}

/**
 * Oturumu kapatır ve SONUCU DOĞRULAR.
 */
async function logout(engine, deps = {}) {
  const meta = authDescriptor(engine, deps);
  if (!meta) return { ok: false, error: 'unsupported-engine', status: null };
  const ledger = loginLedgerOf(deps);
  if (ledger && typeof ledger.clear === 'function') {
    try { ledger.clear(); } catch { /* defter bir kolaylık — çıkışı kıramaz */ }
  }
  if (!meta.logoutArgv) {
    if (meta.apiKey) {
      const store = apiKeyStoreOf(deps);
      const r = store ? await store.clearKey(meta.apiKey.vaultService) : { ok: false, error: 'vault-unavailable' };
      const status = await readStatus(engine, deps);
      return { ok: r.ok && !status.loggedIn, error: r.ok ? null : r.error, status };
    }
    return { ok: false, error: 'no-logout-flow', status: await readStatus(engine, deps) };
  }
  const bin = await resolveBin(engine, deps);
  if (!bin || !bin.found) return { ok: false, error: binErrorFor(bin), status: null };
  const exec = deps.execFile || execFile;
  const argv = [...meta.logoutArgv];
  const target = execTarget(bin, argv, deps);
  await new Promise((resolve) => {
    let settledOut = false;
    const done = () => { if (!settledOut) { settledOut = true; resolve(); } };
    const timer = setTimeout(done, deps.timeoutMs || STATUS_TIMEOUT_MS);
    try {
      exec(target.file, target.argv,
        withVerbatim(target, { timeout: deps.timeoutMs || STATUS_TIMEOUT_MS, env: execEnv(deps) }),
        () => { clearTimeout(timer); done(); });
    } catch { clearTimeout(timer); done(); }
  });
  const status = await readStatus(engine, deps);
  return { ok: !status.loggedIn, status };
}

module.exports = {
  extractUrl,
  wantsCode,
  startLogin,
  logout,
};
