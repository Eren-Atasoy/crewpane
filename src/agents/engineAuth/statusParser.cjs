// CrewPane — Engine Auth Status Parsers and Measurement Verification.
'use strict';

const { authDescriptor, authKindOf } = require('./descriptors.cjs');

/**
 * JSON durum çıktısını normalize eder (`statusParse: 'json'` — claude ailesi).
 */
function parseJsonStatus(stdout, loggedInField = 'loggedIn') {
  let json = null;
  try {
    const s = String(stdout || '');
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) json = JSON.parse(s.slice(a, b + 1));
  } catch { json = null; }
  if (!json || typeof json !== 'object') return { loggedIn: false, method: null, account: null, plan: null, org: null, orgId: null, authKind: null };
  const field = typeof loggedInField === 'string' && loggedInField ? loggedInField : 'loggedIn';
  const loggedIn = json[field] === true;
  const method = typeof json.authMethod === 'string' && json.authMethod !== 'none' ? json.authMethod : null;
  const plan = typeof json.subscriptionType === 'string' ? json.subscriptionType : null;
  return {
    loggedIn,
    method,
    account: typeof json.email === 'string' ? json.email : null,
    plan,
    org: typeof json.orgName === 'string' && json.orgName.trim() ? json.orgName.trim() : null,
    orgId: typeof json.orgId === 'string' && json.orgId.trim() ? json.orgId.trim() : null,
    authKind: loggedIn ? authKindOf(method, plan) : null,
  };
}

/**
 * Metin durum çıktısını normalize eder (`statusParse: 'text'` — codex ailesi).
 */
function parseTextStatus(stdout, exitCode) {
  const s = String(stdout || '').trim();
  const loggedIn = exitCode === 0 && /logged\s+in/i.test(s) && !/not\s+logged\s+in/i.test(s);
  if (!loggedIn) return { loggedIn: false, method: null, account: null, plan: null, org: null, orgId: null, authKind: null };
  const m = s.match(/logged\s+in\s+using\s+(.+?)\s*$/im);
  const method = m ? m[1].trim() : null;
  const isApiKey = /api\s*key/i.test(method || '');
  const account = (s.match(/\(([^)]*@[^)]*)\)/) || [])[1] || null;
  const plan = isApiKey ? null : method;
  return { loggedIn: true, method, account, plan, org: null, orgId: null, authKind: authKindOf(method, plan) };
}

/**
 * ENG-ENABLE-01 — ÜÇÜNCÜ ŞEKİL: `statusParse: 'exit-code'`.
 */
function parseExitCodeStatus(desc, stdout, exitCode) {
  if (exitCode !== 0) return { loggedIn: false, method: null, account: null, plan: null, org: null, orgId: null, authKind: null };
  return {
    loggedIn: true,
    method: (desc && desc.statusMethodLabel) || null,
    account: null,
    plan: null,
    org: null,
    orgId: null,
    authKind: null,
  };
}

const parseClaudeStatus = parseJsonStatus;
const parseCodexStatus = parseTextStatus;

/** Descriptor'a göre doğru ayrıştırıcı. Bilinmeyen şekil → "girişsiz" (fail-closed). */
function parseStatus(desc, stdout, exitCode) {
  if (desc && desc.statusParse === 'json') return parseJsonStatus(stdout, desc.statusField || 'loggedIn');
  if (desc && desc.statusParse === 'text') return parseTextStatus(stdout, exitCode);
  if (desc && desc.statusParse === 'exit-code') return parseExitCodeStatus(desc, stdout, exitCode);
  return { loggedIn: false, method: null, account: null, plan: null, org: null, orgId: null, authKind: null };
}

/**
 * ADP-893 — "ÖLÇEMEDİM" ile "HAYIR"ı ayırır.
 */
function statusUnmeasured(engineOrDesc, stdout, exitCode) {
  if (exitCode === 0) return false;
  const desc = typeof engineOrDesc === 'string' ? authDescriptor(engineOrDesc, { env: {} }) : engineOrDesc;
  const s = String(stdout || '');
  if (desc && desc.statusParse === 'text') return !/logged\s+in/i.test(s);
  if (desc && desc.statusParse === 'exit-code') {
    const rx = desc.signedOutPattern ? new RegExp(desc.signedOutPattern, 'i') : null;
    return !(rx && rx.test(s));
  }
  const a = s.indexOf('{');
  return !(a >= 0 && s.lastIndexOf('}') > a);
}

module.exports = {
  parseJsonStatus,
  parseTextStatus,
  parseExitCodeStatus,
  parseClaudeStatus,
  parseCodexStatus,
  parseStatus,
  statusUnmeasured,
};
