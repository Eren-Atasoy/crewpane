// CrewPane — Engine Auth Descriptors and Registry Tunnel.
'use strict';

const engineRegistry = require('../engineRegistry.cjs');

/**
 * E2E/test DİKİŞİ — defterde OLMAYAN bir motorun auth descriptor'ı.
 */
function envDescriptors(env) {
  if (!env || env.CREWPANE_FAKE_ENGINE_DESCRIPTORS !== '1') return null;
  let raw = null;
  try { raw = JSON.parse(String(env.CREWPANE_FAKE_ENGINE_DESCRIPTORS_JSON || '{}')); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const [id, d] of Object.entries(raw)) {
    if (!d || typeof d !== 'object' || !d.auth) continue;
    if (engineRegistry.validateAuth(d.auth).length) continue;
    out[id] = d;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Bir motorun AUTH descriptor'ı (defter → çözülmüş, çağırana hazır görünüm).
 */
function authDescriptor(engine, deps = {}) {
  const extra = deps.descriptors || envDescriptors(deps.env || process.env);
  const src = extra && Object.prototype.hasOwnProperty.call(extra, engine)
    ? extra[engine]
    : engineRegistry.getEngine(engine);
  if (!src || !src.auth) return null;
  const a = src.auth;
  return {
    engine,
    label: a.label || src.label || engine,
    accountHint: a.accountHint || null,
    signupUrl: a.signupUrl || null,
    flow: a.flow,
    needsCode: a.needsCode === true,
    statusArgv: a.statusArgv || null,
    statusParse: a.statusParse || null,
    statusField: typeof a.statusField === 'string' && a.statusField.trim() ? a.statusField.trim() : null,
    apiKeyVerifyArgv: Array.isArray(a.apiKeyVerifyArgv) && a.apiKeyVerifyArgv.length ? [...a.apiKeyVerifyArgv] : null,
    binName: typeof src.bin === 'string' && src.bin.trim() ? src.bin.trim() : engine,
    signedOutPattern: typeof a.signedOutPattern === 'string' && a.signedOutPattern.trim() ? a.signedOutPattern : null,
    statusMethodLabel: typeof a.statusMethodLabel === 'string' && a.statusMethodLabel.trim() ? a.statusMethodLabel : null,
    statusNote: typeof a.statusNote === 'string' && a.statusNote.trim() ? a.statusNote : null,
    externalNote: typeof a.externalNote === 'string' && a.externalNote.trim() ? a.externalNote : null,
    apiKeyNote: typeof a.apiKeyNote === 'string' && a.apiKeyNote.trim() ? a.apiKeyNote : null,
    loginArgv: a.loginArgv || null,
    manualLoginArgv: Array.isArray(a.manualLoginArgv) && a.manualLoginArgv.length ? [...a.manualLoginArgv] : null,
    logoutArgv: a.logoutArgv || null,
    apiKey: a.apiKey || null,
    identityEnv: src.identityEnv || null,
  };
}

/** Auth descriptor'ı olan motorların kimlikleri (env/test dikişi dahil). */
function authEngines(deps = {}) {
  const extra = deps.descriptors || envDescriptors(deps.env || process.env);
  const ids = engineRegistry.engineIds().filter((id) => !!engineRegistry.capability(id, 'auth'));
  for (const id of Object.keys(extra || {})) if (!ids.includes(id)) ids.push(id);
  return ids;
}

/**
 * Oturum yönetimi desteklenen motorlar — DEFTERDEN türer (elle liste YOK).
 */
const AUTH_ENGINES = Object.freeze(authEngines({ descriptors: null, env: {} }));

/**
 * Motor başına ürün metni + akış şekli (UI bunu tüketir; isim-bazlı if YOK).
 */
const ENGINE_AUTH_META = Object.freeze(Object.fromEntries(AUTH_ENGINES.map((id) => {
  const d = authDescriptor(id, { env: {} });
  return [id, Object.freeze({
    id,
    label: d.label,
    accountHint: d.accountHint,
    signupUrl: d.signupUrl,
    needsCode: d.needsCode,
    flow: d.flow,
  })];
})));

/**
 * ENG-08 — girişin FATURA KANALI: 'subscription' | 'api-key' | null.
 */
function authKindOf(method, plan) {
  if (/api\s*key|console|billing/i.test(String(method || ''))) return 'api-key';
  if (plan) return 'subscription';
  return null;
}

/** Motorun durum komutu (argv) — DEFTERDEN. Bilinmeyen motor/komutsuz akış → `null`. */
function statusArgv(engine, deps = {}) {
  const d = authDescriptor(engine, deps);
  return d && d.statusArgv ? [...d.statusArgv] : null;
}

/** Motorun giriş komutu (argv). Abonelik yolu olmayan akışta `null`. */
function loginArgv(engine, deps = {}) {
  const d = authDescriptor(engine, deps);
  return d && d.loginArgv ? [...d.loginArgv] : null;
}

/** Motorun çıkış komutu (argv). */
function logoutArgv(engine, deps = {}) {
  const d = authDescriptor(engine, deps);
  return d && d.logoutArgv ? [...d.logoutArgv] : null;
}

module.exports = {
  envDescriptors,
  authDescriptor,
  authEngines,
  AUTH_ENGINES,
  ENGINE_AUTH_META,
  authKindOf,
  statusArgv,
  loginArgv,
  logoutArgv,
};
