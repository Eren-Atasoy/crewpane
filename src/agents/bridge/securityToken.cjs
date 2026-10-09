'use strict';

const crypto = require('node:crypto');

/** Mint a URL-safe bridge token. */
function mintToken() {
  return crypto.randomBytes(32).toString('hex');
}

/** Constant-time bearer-token check against `expected` (header may be missing). */
function checkToken(headerValue, expected) {
  if (typeof headerValue !== 'string' || !expected) return false;
  const got = headerValue.startsWith('Bearer ') ? headerValue.slice(7) : headerValue;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Header'dan kimlik beyanı (iki ad da okunur: CREWPANE_* kanonik, CREWPANE_* legacy). */
function declaredIdentity(headers) {
  const h = headers && typeof headers === 'object' ? headers : {};
  const pick = (...names) => {
    for (const n of names) {
      const v = h[n];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };
  return {
    agentId: pick('x-crewpane-agent-id', 'x-crewpane-agent-id'),
    leaderId: pick('x-crewpane-leader-id', 'x-crewpane-leader-id'),
  };
}

/** Canlı pane defterinden bir ajanın kaydı (yoksa null). Saf-ish: okuma yalnız. */
function paneRecordForAgent(agentId, homedir) {
  if (!agentId) return null;
  try {
    const registry = require('../livePaneRegistry.cjs');
    const reg = registry.loadRegistry(homedir);
    for (const [paneId, rec] of Object.entries(reg.panes || {})) {
      if (rec && rec.agentId === agentId) return { paneId, ...rec };
    }
  } catch {
    /* defter okunamadı → hüküm YOK (aşağıda 'unverified') */
  }
  return null;
}

/**
 * ENG-11 — köprünün ÇAĞIRAN-KİMLİĞİ kararı. SAF: tüm dünya bilgisi argümanlarda.
 *
 * SEC-01 — bu kapı artık `POST /delegate` ile `POST /pane/close`'un ORTAK kapısıdır.
 *
 * @param {object} o
 * @param {object} o.headers          istek başlıkları (kimlik beyanı)
 * @param {string} o.leaderId         gövdedeki leaderId (kim adına delegasyon)
 * @param {(id:string)=>object|null} o.resolveAgent  ajan → canlı pane kaydı
 * @returns {{ok:boolean, code?:string, reason?:string, verified:boolean}}
 */
function authorizeDelegateCaller({ headers, leaderId, resolveAgent } = {}) {
  const declared = declaredIdentity(headers);
  const lookup = typeof resolveAgent === 'function' ? resolveAgent : () => null;

  // 1) Beyan yalnız AGENT_ID taşıyorsa çağıran bir WORKER pane'idir (lider pane'i
  //    LEADER_ID taşır). Alt-delegasyon ADR-004'te yasak.
  if (declared.agentId && !declared.leaderId) {
    return {
      ok: false,
      code: 'worker-subdelegation',
      reason: `alt-delegasyon yasak: "${declared.agentId}" bir worker pane'i (ADR-004) — işi KENDİN yürüt`,
      verified: true,
    };
  }
  // 2) Beyan edilen lider ile gövdedeki lider AYNI olmalı: başkasının adına
  //    delegasyon açmak (kimlik ödünç alma) reddedilir.
  if (declared.leaderId && leaderId && declared.leaderId !== leaderId) {
    return {
      ok: false,
      code: 'identity-mismatch',
      reason: `kimlik uyuşmazlığı: pane "${declared.leaderId}" ama istek "${leaderId}" adına`,
      verified: true,
    };
  }
  // 3) SUNUCU TARAFI GERÇEK (istemci işbirliği GEREKMEZ): gövdedeki lider canlı
  //    defterde bir WORKER pane'i olarak duruyorsa reddedilir.
  const rec = lookup(leaderId);
  if (rec && rec.disallowSubagent === true) {
    return {
      ok: false,
      code: 'worker-subdelegation',
      reason: `alt-delegasyon yasak: "${leaderId}" canlı defterde worker pane'i (disallowSubagent) — ADR-004`,
      verified: true,
    };
  }
  // 4) Kimlik doğrulanamadı (beyan yok + defterde kayıt yok) → BUGÜNKÜ davranış
  //    korunur, ama karar `verified:false` ile loglanır: sessiz geçiş yok.
  return { ok: true, verified: !!(declared.leaderId || rec) };
}

module.exports = {
  mintToken,
  checkToken,
  declaredIdentity,
  paneRecordForAgent,
  authorizeDelegateCaller,
};
