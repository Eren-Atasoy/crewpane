// CrewPane — Delegation Bridge Client & Discovery (Phase 4.13)
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const instancePaths = require('../../config/instancePaths.cjs');
const crewpaneEnv = require('../../config/crewpaneEnv.cjs');

// ADP-703 — el sıkışma dosyası CİHAZ kökünde (hesap kökünde DEĞİL): delegationBridge
// onu orada yazar ve bu sabit modül yüklenirken çözülür. Bkz. ACCOUNT-SCOPED-STORE.md §2.
const BRIDGE_FILE = path.join(instancePaths.instanceHome(), 'bridge.json');

function logErr(msg) {
  try {
    process.stderr.write(`[crewpane-mcp] ${msg}\n`);
  } catch {
    /* stderr closed */
  }
}

// ── bridge discovery (ADP-050) ───────────────────────────────────────────────
// TASK-MQTM0UIEMVZ3S (st2) — return an ORDERED, deduped list of candidate bridges.
// The spawn-time ENV snapshot (CREWPANE_BRIDGE_*) is tried FIRST (fast path), but it
// is a one-time copy taken when the pane was spawned: after an app restart the bridge
// listens on a NEW ephemeral port with a NEW token, so the pane's env goes STALE and a
// single-source discovery would fail with a confusing 401/ECONNREFUSED and never
// recover. The handshake FILE (~/.crewpane[-dev]/bridge.json) is always rewritten by
// the live bridge, so it is the self-healing second candidate. Trying both makes a
// leader's delegation survive an app restart without re-spawning the pane.
// ADP-286 — cross-instance aday reddi: handshake `instance` damgası taşıyorsa ve bizim
// CREWPANE_INSTANCE'ımızla (default prod) uyuşmuyorsa aday LİSTEYE HİÇ GİRMEZ — canlı
// incident (2026-07-10 dlg-1783672375314-1): test koşusu PROD'un bridge.json'ını okuyup
// PROD ofise delegasyon enjekte etti. Legacy-uyum (BİLİNÇLİ): `instance` alanı OLMAYAN
// handshake kabul edilir — dosya zaten instance-scoped path'ten okunur (~/.crewpane[-dev|-test]/),
// alansız dosya = aynı path'e yazan ESKİ app build'i; reddetmek her upgrade'i kırardı.
// Env-kaynaklı aday güvenilir sayılır: CREWPANE_BRIDGE_* pane'i spawn eden app'in kendi
// enjeksiyonudur (CREWPANE_INSTANCE ile aynı süreçten gelir).
function discoverBridgeCandidates(bridgeFile = BRIDGE_FILE) {
  const candidates = [];
  // ADP-244 Faz 3 — dual-read: CREWPANE_BRIDGE_* varsa o, yoksa CREWPANE_BRIDGE_* (eski
  // app build'inin spawn ettiği pane yalnız legacy adı taşır → geriye uyum şart).
  const envPort = crewpaneEnv.readEnv('BRIDGE_PORT');
  const envTok = crewpaneEnv.readEnv('BRIDGE_TOKEN');
  if (envPort && envTok) {
    candidates.push({ host: crewpaneEnv.readEnv('BRIDGE_HOST') || '127.0.0.1', port: Number(envPort), token: envTok, source: 'env' });
  }
  try {
    const j = JSON.parse(fs.readFileSync(bridgeFile, 'utf8'));
    if (j && j.port && j.token) {
      if (j.instance && j.instance !== instancePaths.instanceId()) {
        logErr(`cross-instance bridge REJECTED: handshake instance=${j.instance}, ours=${instancePaths.instanceId()} (${bridgeFile})`);
      } else {
        candidates.push({ host: j.host || '127.0.0.1', port: Number(j.port), token: j.token, source: 'file' });
      }
    }
  } catch {
    /* no handshake file */
  }
  // Dedup identical endpoints (env == file when fresh) so we never try the same one twice.
  const seen = new Set();
  return candidates.filter((c) => {
    const key = `${c.host}:${c.port}:${c.token}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Back-compat single-bridge discovery (first candidate or null). Retained for callers
// /tests that just want "is there a bridge"; the tool paths use the failover list below.
function discoverBridge() {
  const list = discoverBridgeCandidates();
  return list.length ? list[0] : null;
}

/**
 * TASK-MQTM0UIEMVZ3S (st2) — run a request against each candidate in order, failing over
 * on a STALE candidate: a transport error (ECONNREFUSED/timeout → dead port) or a 401
 * (→ wrong token) means "try the next source". Returns the first response that is neither
 * a transport error nor a 401. If every candidate answered 401, the 401 is surfaced (the
 * caller maps it to a clear "stale handshake" message); if none was reachable at all, the
 * last transport error is thrown.
 */
async function bridgeRequestFailover(candidates, method, pathPart, bodyObj) {
  let lastErr = null;
  let last401 = null;
  for (const bridge of candidates) {
    let res;
    try {
      res = await bridgeRequest(bridge, method, pathPart, bodyObj);
    } catch (err) {
      lastErr = err; // dead/stale port → try the next candidate
      continue;
    }
    if (res.status === 401) {
      last401 = res; // stale token → try the next candidate
      continue;
    }
    if (res.status === 403 && !(res.body && res.body.code === 'cross-team')) {
      // ADP-286 — cross-instance reddi (bridge tarafı): bu aday yanlış instance'ın
      // bridge'i — 401 gibi sonrakine geç (aynı failover disiplini).
      // ADP-717 — AMA takım-kapsamı reddi (`code:'cross-team'`) BAŞKA BİR ŞEYDİR: doğru
      // bridge, doğru instance, yalnız yetki yok. Onu failover'a sokmak hem gereksiz
      // ikinci denemeye yol açar hem de sebebi "bridge bulunamadı" gibi gösterirdi.
      last401 = res;
      continue;
    }
    return res;
  }
  if (last401) return last401;
  throw lastErr || new Error('no bridge candidates reachable');
}

/** Minimal JSON HTTP request to the bridge. Resolves { status, body }. */
function bridgeRequest(bridge, method, pathPart, bodyObj) {
  return new Promise((resolve, reject) => {
    const payload = bodyObj ? Buffer.from(JSON.stringify(bodyObj)) : null;
    const req = http.request(
      {
        host: bridge.host,
        port: bridge.port,
        method,
        path: pathPart,
        headers: {
          authorization: `Bearer ${bridge.token}`,
          // ADP-286 — instance beyanı: bridge tarafı uyuşmazlıkta 403 döner (kemer+askı;
          // asıl kapı yukarıdaki aday reddi).
          'x-crewpane-instance': instancePaths.instanceId(),
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        },
        timeout: 20000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            /* non-JSON */
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('bridge request timed out'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// ── tool implementations ─────────────────────────────────────────────────────
function toolError(text) {
  return { content: [{ type: 'text', text }], isError: true };
}
function toolOk(text) {
  return { content: [{ type: 'text', text }] };
}

module.exports = {
  BRIDGE_FILE,
  logErr,
  discoverBridgeCandidates,
  discoverBridge,
  bridgeRequestFailover,
  bridgeRequest,
  toolError,
  toolOk,
};
