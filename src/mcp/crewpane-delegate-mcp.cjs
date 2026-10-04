#!/usr/bin/env node
// ADP-051 (ADR-004 §A) — crewpane delegation MCP server (stdio JSON-RPC).
//
// Spawned INSIDE a leader claude session (via `claude --mcp-config …`, wired by
// ADP-052). It exposes two tools so the leader can delegate from natural-language
// chat WITHOUT using claude's internal `Task` subagent:
//   • crewpane_delegate({objective, department?, workers?})
//   • crewpane_delegation_status({delegationId?})
// Each call reaches the ADP-050 Electron-main loopback bridge (HTTP + token) →
// renderer → `startTeamDelegation` → REAL worker panes (each its own engine +
// identity). The MCP server is the leader's hand on that bridge.
//
// Dependency-free: minimal newline-delimited JSON-RPC over stdio (the MCP wire
// format claude speaks; proven in the ADR-004 POC) + node http. stdout carries
// ONLY protocol messages; all logs go to stderr.
//
// Discovery (ADP-050 contract): env CREWPANE_BRIDGE_{HOST,PORT,TOKEN} first, else
// ~/.crewpane/bridge.json. Leader identity: env CREWPANE_LEADER_ID +
// CREWPANE_DEPARTMENT (injected per-leader by ADP-052; a tool `department` arg
// overrides). Bridge absent/unreachable → graceful tool error (no crash).

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const instancePaths = require('../config/instancePaths.cjs'); // ADP-206 — instance-scoped (inherits CREWPANE_INSTANCE from the agent pane's env)
const { withLegacyAliases } = require('./mcpToolAliases.cjs'); // ADP-244 Faz 2 — crewpane_* kanonik + crewpane_* legacy alias
const crewpaneEnv = require('../config/crewpaneEnv.cjs'); // ADP-244 Faz 3 — env dual-read (CREWPANE_* → CREWPANE_*)
const SERVER_INFO = { name: 'crewpane', version: '1.0.0' };
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

async function runDelegate(args) {
  const objective = typeof args.objective === 'string' ? args.objective.trim() : '';
  if (!objective) return toolError('objective is required (the work to distribute; a numbered list works best).');

  const candidates = discoverBridgeCandidates();
  if (!candidates.length) {
    return toolError(
      'CrewPane app bridge not found — open the CrewPane app (its workspace) so delegation can spawn real worker panes.',
    );
  }
  const leaderId = (crewpaneEnv.readEnv('LEADER_ID') || '').trim();
  const department = (typeof args.department === 'string' && args.department.trim()) || (crewpaneEnv.readEnv('DEPARTMENT') || '').trim();
  if (!leaderId) return toolError('leader identity missing (CREWPANE_LEADER_ID not set on this session).');
  if (!department) return toolError('department missing — pass `department` or set CREWPANE_DEPARTMENT.');

  const payload = { objective, leaderId, department };
  if (Array.isArray(args.workers)) payload.workers = args.workers;
  // ADP-565 — objective-level MODEL (applied to workers with no explicit model). The bridge
  // + agentRunner.sanitizeModel validate it downstream; a crafted value is dropped there.
  if (typeof args.model === 'string' && args.model.trim()) payload.model = args.model.trim();
  // ADP-595 — objective-level SAĞLAYICI (görev-başına override). Aynı disiplin: burada
  // doğrulanmaz, main'de `providers.isProvider` bilinmeyeni düşürür (motor varsayılanına döner).
  if (typeof args.provider === 'string' && args.provider.trim()) payload.provider = args.provider.trim();

  let res;
  try {
    res = await bridgeRequestFailover(candidates, 'POST', '/delegate', payload);
  } catch (err) {
    return toolError(`could not reach the CrewPane bridge: ${err.message}`);
  }
  if (res.status === 401) return toolError('CrewPane bridge rejected the token (stale handshake?).');
  // ADP-717 — TAKIM KAPSAMI reddi. Mesaj kullanıcı diliyle gelir ve İZNİN NASIL VERİLECEĞİNİ
  // söyler; lider bunu patrona aynen iletebilsin diye AYNEN geçiriyoruz (kendi cümlemizle
  // örtmüyoruz — "delegasyon başarısız" demek bu vakada kullanıcıyı hiçbir yere götürmez).
  if (res.status === 403) {
    return toolError(
      `${(res.body && res.body.error) || 'bu takıma iş verme iznin yok.'} ` +
        'Bu bir hata DEĞİL: iş verebildiğin her takımı YÖNETEBİLMEN (pane kapatabilmen) için ' +
        'kapsam tek kural olarak uygulanıyor. İzin gerekiyorsa patrondan iste.',
    );
  }
  // ADP-538 — KUYRUK ≠ HATA ≠ BAŞLADI (hayalet-görev fix'i). Köprü 202 {ok,queued}
  // döndüğünde iş SIRAYA girdi ama HİÇBİR pane açılmadı; eski kod bunu
  // "delegation failed (202): …kuyruğa alındı" diye basıyordu — lider ya "failed"
  // ya da (mesajı okuyup) "verdim" diye raporluyordu, ikisi de gerçek değil.
  if (res.status === 202 && res.body && res.body.queued) {
    return toolOk(
      `⏳ KUYRUĞA ALINDI — görev henüz BAŞLAMADI (hiçbir worker pane açılmadı): ${res.body.message || res.body.error || 'hedef ajan meşgul'}. ` +
        'Uçuştaki iş bitince otomatik başlayacak. Bu görevi "verildi/başladı" diye RAPORLAMA; ' +
        'crewpane_delegation_status ile başladığını görene kadar "kuyrukta" de.',
    );
  }
  if (res.status !== 200 || !res.body || !res.body.ok) {
    return toolError(`delegation failed (${res.status}): ${(res.body && res.body.error) || 'unknown error'}`);
  }
  const delegationId = res.body.delegationId;

  // ADP-538 — "started" iddiası status probuyla DOĞRULANIR: alt-görev listesi
  // gelirse pane sayısı raporlanır; gelmezse lider teyitsiz "başladı" dememesi
  // için açık uyarı taşır (iyimser varsayım = hayalet görev).
  let paneNote = '';
  let verified = false;
  try {
    const st = await bridgeRequestFailover(candidates, 'GET', `/delegation/status?id=${encodeURIComponent(delegationId)}`);
    const subs = st.body && st.body.snapshot && Array.isArray(st.body.snapshot.subtasks) ? st.body.snapshot.subtasks : null;
    if (subs) {
      verified = true;
      paneNote = ` ${subs.length} worker pane(s) are spawning (one per subtask), each in its own pane with its own engine.`;
    }
  } catch {
    /* status is optional */
  }

  // TC-03 (ADR §9.3, 3. giriş noktası) — ROL BOŞLUĞU İPUCU. Köprü bu alanı YALNIZ
  // hedefin andığı bir katalog rolü ekipte yokken ve o rol bu oturumda İLK KEZ geçerken
  // doldurur (döngü koruması renderer'da: rosterRoleGap.RoleGapMemory). İş ZATEN
  // dağıtıldı — bu satır bir hata değil, liderin "bu rolde kimse yok, önereyim mi"
  // diyebilmesi için tek satırlık bir bilgidir.
  const roleGapNote =
    res.body && typeof res.body.roleGapHint === 'string' && res.body.roleGapHint.trim()
      ? ` ${res.body.roleGapHint.trim()}`
      : '';
  return toolOk(
    `Delegation started in the CrewPane app (delegationId=${delegationId}).${paneNote} ` +
      'These are REAL worker panes (not a Task subagent) — the boss can watch them in the office. ' +
      (verified
        ? 'Call crewpane_delegation_status to follow progress.'
        : 'UYARI: başlangıç status ile DOĞRULANAMADI — crewpane_delegation_status ile teyit etmeden bu görevi "verildi/başladı" diye raporlama.') +
      roleGapNote,
  );
}

async function runStatus(args) {
  const candidates = discoverBridgeCandidates();
  if (!candidates.length) return toolError('CrewPane app bridge not found (is the app running?).');
  const id = typeof args.delegationId === 'string' && args.delegationId.trim() ? args.delegationId.trim() : '';
  // ADP-659 — bu çağrı liderin GERÇEKTEN baktığının kanıtıdır (ACK). Lider kimliği
  // sorguya eklenir; app tarafındaki supervisor bu ajana bekleyen uyandırma
  // tekrarlarını kapatır (aksi halde lider zaten okumuşken nudge basmaya devam eder).
  const leaderId = (crewpaneEnv.readEnv('LEADER_ID') || '').trim();
  const q = [id ? `id=${encodeURIComponent(id)}` : '', leaderId ? `leader=${encodeURIComponent(leaderId)}` : '']
    .filter(Boolean)
    .join('&');
  let res;
  try {
    res = await bridgeRequestFailover(candidates, 'GET', `/delegation/status${q ? `?${q}` : ''}`);
  } catch (err) {
    return toolError(`could not reach the CrewPane bridge: ${err.message}`);
  }
  if (res.status === 401) return toolError('CrewPane bridge rejected the token.');
  if (res.status !== 200 || !res.body || !res.body.ok) {
    return toolError(`status failed (${res.status}).`);
  }
  // ADP-672 — MOTOR defteri + MAIN defteri BİRLİKTE. Canlı vaka: lider yalnız motor
  // defterini okuyordu, orada hiçbir şey settle olmadığı için 48 dakika "stark:working"
  // gördü ve patrona "hâlâ çalışıyor" dedi. Main defteri renderer'dan bağımsızdır ve
  // sessiz worker / kanıt / izlenmeyen pane gerçeğini taşır.
  return toolOk([summarizeStatus(res.body.snapshot), summarizeSupervisor(res.body.supervisor)].filter(Boolean).join('\n\n'));
}

/** Yaş → insan okur ("3dk", "2sa 5dk"). */
function humanAge(ms) {
  const m = Math.max(0, Math.round(Number(ms || 0) / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}sa ${m % 60}dk` : `${m}dk`;
}

/**
 * ADP-672 — main'in KALICI defteri, liderin okuyacağı dille. Üç şeyi açıkça söyler:
 *   • uçuştaki iş GERÇEKTEN uçuşta mı (pane yaşıyor mu, ne kadardır bekliyor),
 *   • biten iş nasıl tespit edildi (kanıt/marker/sessizlik) ve kanıtı nerede,
 *   • defterde KAYDI OLMAYAN açık worker pane'leri (eski-yol delegasyon) — sessizce
 *     "her şey yolunda" DENMEZ.
 */
function summarizeSupervisor(sup) {
  if (!sup || typeof sup !== 'object') return '';
  const recs = Array.isArray(sup.records) ? sup.records : [];
  const untracked = Array.isArray(sup.untracked) ? sup.untracked : [];
  if (recs.length === 0 && untracked.length === 0) return '';
  const lines = ['SUPERVISOR DEFTERİ (main süreç, kalıcı — renderer\'dan bağımsız GERÇEK):'];
  for (const r of recs) {
    const bits = [`${r.agentId || '?'}: ${r.status}`];
    if (r.taskCode) bits.push(r.taskCode);
    if (r.status === 'in-flight') {
      bits.push(`${humanAge(r.ageMs)}dır uçuşta`, r.paneAlive ? 'pane AYAKTA' : 'pane YOK');
    } else {
      if (r.settledBy) bits.push(`tespit=${r.settledBy}`);
      if (r.status === 'done' && r.evidencePath) bits.push(`→ ${r.evidencePath}`);
      if (r.status !== 'done' && r.reason) bits.push(String(r.reason).slice(0, 140));
      bits.push(r.leaderNotified ? 'sana bildirildi' : 'HENÜZ bildirilmedi');
    }
    lines.push(`• ${bits.join(' · ')}`);
  }
  if (untracked.length) {
    lines.push(
      `⚠ İZLENMEYEN ${untracked.length} worker pane (bu delegasyon motoruyla açılmamış — ` +
        `supervisor tamamlanmasını TESPİT EDEMEZ, kendin kontrol et): ` +
        untracked.map((p) => `${p.paneId}${p.agentId ? `(${p.agentId})` : ''}`).join(', '),
    );
  }
  return lines.join('\n');
}

/** Turn a delegation snapshot (one or many) into a short human summary. */
// ADP-563 — lider TEK komutla GERÇEĞİ okusun: done alt-görevde kanıt dosyası, geç-kanıtla
// düzeltilmişte "(geç-kanıt)" izi, başarısızda kısa neden. Eski özet yalnız "worker:status"
// döndürüyordu — lider hangi sonuç dosyasının düştüğünü/neden fail göründüğünü göremiyordu.
// DLG-MSG-01 (BUG-R3 #7) — durum satırı sebep hijyeni. Kaynak hijyen renderer'da
// (delegation.ts sanitizeFailReason); burası SON savunma: eski/yabancı snapshot'ta
// bile doldurulmamış şablon (`<sebep>]`) ve `]]` biçimi basılamaz.
function cleanStatusReason(raw) {
  let s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s || /^<[^<>]+>\s*\]?$/.test(s)) return null;
  while (s.endsWith(']') && (s.match(/\[/g) || []).length < (s.match(/\]/g) || []).length) {
    s = s.slice(0, -1).trimEnd();
  }
  return s || null;
}

function summarizeStatus(snapshot) {
  if (!snapshot) return 'No active delegations.';
  const list = Array.isArray(snapshot) ? snapshot : [snapshot];
  if (list.length === 0) return 'No active delegations.';
  const lines = list.map((d) => {
    const subs = Array.isArray(d.subtasks) ? d.subtasks : [];
    const parts = subs
      .map((s) => {
        let p = `${s.workerAgentId || '?'}:${s.status || '?'}`;
        // PANE-CAP-01 — KAPASİTE BEKLEMESİ ≠ BAŞARISIZLIK. Alt-görev 'pending'
        // kalır (statü YALAN söylemez) ama liderin bunu "duruyor/unutulmuş" diye
        // okumaması için sebep AÇIKÇA yazılır. 02.09'da kaynak yokluğu 'failed'
        // olarak yüzeye çıkıyordu ve lider sprint'i düşmüş sanıyordu.
        if (s.capacityWait) {
          p += `(⏳ kaynak bekliyor — ${s.capacityWait.attempts || 1}. deneme; makine boşalınca kendiliğinden sürecek)`;
        }
        if (s.lateEvidence === true) p += '(geç-kanıt)';
        if (s.status === 'done' && s.evidenceRef) p += ` → ${s.evidenceRef}`;
        else if (s.status !== 'done' && s.error) {
          // DLG-MSG-01 — sebep hijyeni: şablon sebep HİÇ basılmaz, dengesiz kuyruk `]`
          // silinir → `yagmur:failed [<sebep>]]` sınıfı liderin ekranına çıkamaz.
          const r = cleanStatusReason(s.error);
          if (r) p += ` [${r.slice(0, 90)}]`;
        }
        return p;
      })
      .join(', ');
    return `• ${d.id} [${d.status}] — ${subs.length} subtask(s): ${parts || '(none)'}`;
  });
  return lines.join('\n');
}

// ── ADP-242 — uzun-sprint araçları ───────────────────────────────────────────

async function runSprint(args) {
  // DF-03 — action:"stop" ile AYNI araç sprint'i bitirir. Ayrı bir araç yerine
  // aksiyon olmasının sebebi: takılı sprint yaşandığında lider zaten bu aracı
  // çağırıyor ve 502 alıyor; çıkış yolu aynı yerde durmalı.
  const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : 'start';
  if (action === 'stop') return runSprintStop(args);
  if (action && action !== 'start') return toolError(`unknown action '${action}' — use 'start' or 'stop'.`);

  const objective = typeof args.objective === 'string' ? args.objective.trim() : '';
  if (!objective) return toolError('objective is required (sprint hedefi, tek cümle yeter).');
  if (!Array.isArray(args.tasks) || args.tasks.length === 0) {
    return toolError('tasks is required — [{id, title, prompt, dependsOn?, workerAgentId?}] listesi. Her prompt sonuç dosyası YOLU içermeli (ör. docs/agent-results/<id>-<rol>.md), yoksa plan reddedilir.');
  }
  const candidates = discoverBridgeCandidates();
  if (!candidates.length) {
    return toolError('CrewPane app bridge not found — open the CrewPane app so the sprint can run real worker panes.');
  }
  const leaderId = (crewpaneEnv.readEnv('LEADER_ID') || '').trim();
  const department = (typeof args.department === 'string' && args.department.trim()) || (crewpaneEnv.readEnv('DEPARTMENT') || '').trim();
  if (!leaderId) return toolError('leader identity missing (CREWPANE_LEADER_ID not set on this session).');
  if (!department) return toolError('department missing — pass `department` or set CREWPANE_DEPARTMENT.');

  const payload = { objective, leaderId, department, tasks: args.tasks };
  if (Number.isInteger(args.maxConcurrent) && args.maxConcurrent > 0) payload.maxConcurrent = args.maxConcurrent;

  let res;
  try {
    res = await bridgeRequestFailover(candidates, 'POST', '/sprint', payload);
  } catch (err) {
    return toolError(`could not reach the CrewPane bridge: ${err.message}`);
  }
  if (res.status === 401) return toolError('CrewPane bridge rejected the token (stale handshake?).');
  // ADP-717 — TAKIM KAPSAMI reddi. Mesaj kullanıcı diliyle gelir ve İZNİN NASIL VERİLECEĞİNİ
  // söyler; lider bunu patrona aynen iletebilsin diye AYNEN geçiriyoruz (kendi cümlemizle
  // örtmüyoruz — "delegasyon başarısız" demek bu vakada kullanıcıyı hiçbir yere götürmez).
  if (res.status === 403) {
    return toolError(
      `${(res.body && res.body.error) || 'bu takıma iş verme iznin yok.'} ` +
        'Bu bir hata DEĞİL: iş verebildiğin her takımı YÖNETEBİLMEN (pane kapatabilmen) için ' +
        'kapsam tek kural olarak uygulanıyor. İzin gerekiyorsa patrondan iste.',
    );
  }
  if (res.status !== 200 || !res.body || !res.body.ok) {
    return toolError(`sprint start failed (${res.status}): ${(res.body && res.body.error) || 'unknown error'}`);
  }
  return toolOk(
    `Sprint started (sprintId=${res.body.sprintId}, ${args.tasks.length} task). ` +
      'Plan artık DİSKTE ve app içinde dalga dalga koşuyor — bu oturum kapansa bile devam eder. ' +
      'Planı unutabilirsin; ilerlemeyi crewpane_sprint_status ile sorgula (sayısal özet döner).',
  );
}

/**
 * DF-03 — SPRINT'İ DURDUR/BİTİR. Kalan pending/dispatched görevler dürüstçe
 * `skipped` yazılır; biten iş KORUNUR. Tek-aktif-sprint kilidi burada açılır.
 */
async function runSprintStop(args) {
  const candidates = discoverBridgeCandidates();
  if (!candidates.length) {
    return toolError('CrewPane app bridge not found — open the CrewPane app to stop a sprint.');
  }
  const leaderId = (crewpaneEnv.readEnv('LEADER_ID') || '').trim();
  const department = (typeof args.department === 'string' && args.department.trim()) || (crewpaneEnv.readEnv('DEPARTMENT') || '').trim();
  if (!leaderId) return toolError('leader identity missing (CREWPANE_LEADER_ID not set on this session).');
  if (!department) return toolError('department missing — pass `department` or set CREWPANE_DEPARTMENT.');

  const payload = { leaderId, department };
  if (typeof args.sprintId === 'string' && args.sprintId.trim()) payload.id = args.sprintId.trim();
  if (typeof args.reason === 'string' && args.reason.trim()) payload.reason = args.reason.trim();

  let res;
  try {
    res = await bridgeRequestFailover(candidates, 'POST', '/sprint/stop', payload);
  } catch (err) {
    return toolError(`could not reach the CrewPane bridge: ${err.message}`);
  }
  if (res.status === 401) return toolError('CrewPane bridge rejected the token (stale handshake?).');
  if (res.status === 403) return toolError((res.body && res.body.error) || 'bu takımın sprintini durdurma iznin yok.');
  if (res.status !== 200 || !res.body || !res.body.ok) {
    return toolError(`sprint stop failed (${res.status}): ${(res.body && res.body.error) || 'unknown error'}`);
  }
  const c = (res.body && res.body.summary) || {};
  return toolOk(
    `Sprint durduruldu (${res.body.sprintId}${res.body.wasLive ? ', canlı sürücü kapatıldı' : ', diskte takılıydı'}). ` +
      `${c.done ?? 0}/${c.total ?? '?'} bitmişti; kalanlar 'skipped' yazıldı. ` +
      'Tek-aktif-sprint kilidi AÇIK — yeni sprint başlatabilirsin.',
  );
}

async function runSprintStatus(args) {
  const candidates = discoverBridgeCandidates();
  if (!candidates.length) return toolError('CrewPane app bridge not found (is the app running?).');
  const id = typeof args.sprintId === 'string' && args.sprintId.trim() ? args.sprintId.trim() : '';
  let res;
  try {
    res = await bridgeRequestFailover(candidates, 'GET', `/sprint/status${id ? `?id=${encodeURIComponent(id)}` : ''}`);
  } catch (err) {
    return toolError(`could not reach the CrewPane bridge: ${err.message}`);
  }
  if (res.status === 401) return toolError('CrewPane bridge rejected the token.');
  if (res.status !== 200 || !res.body || !res.body.ok) return toolError(`sprint status failed (${res.status}).`);
  return toolOk(summarizeSprintStatus(res.body.status));
}

/** Sprint durumunu lider-context-dostu KISA metne çevir (tail yok, sayısal özet). */
function summarizeSprintStatus(status) {
  const list = Array.isArray(status) ? status : status ? [status] : [];
  if (!list.length) return 'No sprints found.';
  return list
    .map((s) => {
      const c = s.summary || {};
      const head = `• ${s.id}${s.active ? ' [RUNNING]' : s.settled ? ' [SETTLED]' : ' [ON DISK]'} — ` +
        `${c.done ?? 0}/${c.total ?? '?'} done, ${c.dispatched ?? 0} in-flight, ${c.pending ?? 0} pending, ` +
        `${c.failed ?? 0} failed, ${c.skipped ?? 0} skipped` +
        (Array.isArray(c.pausedWorkers) && c.pausedWorkers.length ? `, paused: ${c.pausedWorkers.join(',')}` : '');
      const tasks = Array.isArray(s.tasks) ? `\n  ${s.tasks.join(' · ')}` : '';
      return head + tasks;
    })
    .join('\n');
}

// ── ADP-303 — pane kontrolü (aç/kapat/odakla) ────────────────────────────────
// The leader could OPEN panes but not CLOSE them: the only way out was killing pty
// processes by hand, which produced the "write EPIPE" crash dialog and a `[pty exited: 143]`
// zombie pane. `crewpane_pane` does exactly what the × button does — nothing is lost:
// the closed pane's claude transcript stays on disk (resumable).

/** Bir pane listesini lider için tek satırlık özetlere çevir. */
function summarizePanes(panes) {
  if (!Array.isArray(panes) || panes.length === 0) return 'No live panes.';
  // STAT-D1 §KN-2 — STATÜ artık AYRI bir alan olarak basılır ve label'dan ÖNCE gelir.
  // Liderin okuduğu satırda bugüne kadar durum bilgisi YOKTU: tek okunabilir alan
  // `label`dı ve `paneRecycler` onu 'Boşta' yazdığı için lider çalışan bir worker'ı
  // boşta sanıyordu (STAT-R1 §KN-2: pane-70, 49 dk boyunca). Label artık KİMLİK,
  // statü ise ÖLÇÜM — ikisi ayrı okunur.
  return panes
    .map((p) => {
      const st = p.status ? p.status.toUpperCase() : 'UNKNOWN';
      const task = p.taskId || p.labelTaskCode;
      return (
        `• ${p.paneId} — ${p.agentId || '(no agent)'}${p.department ? ` @${p.department}` : ''} ` +
        `[${st}]${task ? ` <${task}>` : ''} ` +
        `[${p.command || '?'}${p.worker ? ', worker' : ''}${p.exited ? ', EXITED' : ''}]` +
        `${p.label ? ` "${p.label}"` : ''}`
      );
    })
    .join('\n');
}

async function runPane(args) {
  const action = typeof args.action === 'string' ? args.action.trim() : '';
  if (!['list', 'close', 'focus'].includes(action)) {
    return toolError("action is required: 'list' | 'close' | 'focus'");
  }
  const candidates = discoverBridgeCandidates();
  if (!candidates.length) return toolError('CrewPane app bridge not found (is the app running?).');
  const leaderId = (crewpaneEnv.readEnv('LEADER_ID') || '').trim();
  const department =
    (typeof args.department === 'string' && args.department.trim()) || (crewpaneEnv.readEnv('DEPARTMENT') || '').trim();

  try {
    if (action === 'list') {
      // ADP-717 — SÜZME ARTIK SUNUCUDA. Eskiden köprü HER pane'i döndürüyor, kapsam
      // süzmesini bu istemci yapıyordu: yani "ne görürüm" kararı ajanın kendi
      // kodundaydı. Artık kimliğimizi söylüyoruz, listeyi main süzüyor (kapatma/odaklama
      // ile AYNI karar → gördüğün = yönetebildiğin).
      const qs = new URLSearchParams();
      if (leaderId) qs.set('leader', leaderId);
      if (department) qs.set('department', department);
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      const res = await bridgeRequestFailover(candidates, 'GET', `/panes${suffix}`);
      if (res.status !== 200 || !res.body || !res.body.ok) return toolError(`pane list failed (${res.status}).`);
      return toolOk(summarizePanes(res.body.panes || []));
    }

    if (action === 'focus') {
      const paneId = typeof args.paneId === 'string' ? args.paneId.trim() : '';
      if (!paneId) return toolError('paneId is required for action=focus.');
      // ADP-717 — kimliği gönder: odaklama da bir yönetim eylemidir, aynı kapıdan geçer.
      const res = await bridgeRequestFailover(candidates, 'POST', '/pane/focus', { paneId, leaderId, department });
      if (res.status === 403) {
        return toolError((res.body && res.body.error) || 'bu pane senin takımında değil.');
      }
      if (res.status !== 200 || !res.body || !res.body.ok) {
        return toolError(`focus failed (${res.status}): ${(res.body && res.body.error) || 'unknown error'}`);
      }
      return toolOk(`Pane ${paneId} is now in front.`);
    }

    // close
    const payload = { leaderId, department, force: args.force === true };
    if (typeof args.paneId === 'string' && args.paneId.trim()) payload.paneId = args.paneId.trim();
    if (typeof args.agentId === 'string' && args.agentId.trim()) payload.agentId = args.agentId.trim();
    if (args.exitedOnly === true) payload.exitedOnly = true;
    if (args.all === true) payload.all = true;
    const res = await bridgeRequestFailover(candidates, 'POST', '/pane/close', payload);
    if (res.status !== 200 || !res.body || !res.body.ok) {
      return toolError(`close failed (${res.status}): ${(res.body && res.body.error) || 'unknown error'}`);
    }
    const closed = res.body.closed || [];
    const denied = res.body.denied || [];
    const deniedNote = denied.length
      ? `\nRefused: ${denied.map((d) => `${d.paneId} (${d.reason})`).join('; ')}`
      : '';
    return toolOk(
      (closed.length
        ? `Closed ${closed.length} pane(s): ${closed.join(', ')} — gone from the office exactly as if the × button was pressed (transcripts stay on disk).`
        : 'No pane was closed.') + deniedNote,
    );
  } catch (err) {
    return toolError(`could not reach the CrewPane bridge: ${err.message}`);
  }
}

// ── TC-01 — TAKIM KURUCU (ADR-TEAM-COMPOSER §4) ──────────────────────────────
// Sözleşme: docs/design/TEAM-COMPOSER-R1/IPC-CONTRACT.md
//
// Bu araç KENDİ BAŞINA bir modele istek ATMAZ (§9.2): öneriyi üreten, bu aracı
// çağıran liderin kendi motorudur. Araç yalnız liderin şema-içi tercihini köprüye
// taşır; katalog dışı rol, para alanı ve tavan kararı main tarafında uygulanır.
async function runTeamCompose(args) {
  const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : '';
  if (!['propose', 'apply', 'undo'].includes(action)) {
    return toolError("action is required — use 'propose', 'apply' or 'undo'.");
  }

  const candidates = discoverBridgeCandidates();
  if (!candidates.length) {
    return toolError('CrewPane app bridge not found — open the CrewPane app so the team card can be shown.');
  }
  const leaderId = (crewpaneEnv.readEnv('LEADER_ID') || '').trim();
  const department =
    (typeof args.department === 'string' && args.department.trim()) || (crewpaneEnv.readEnv('DEPARTMENT') || '').trim();
  if (!leaderId) return toolError('leader identity missing (CREWPANE_LEADER_ID not set on this session).');
  if (!department) return toolError('department missing — pass `department` or set CREWPANE_DEPARTMENT.');

  const payload = { action, leaderId, department, source: 'leader' };
  if (action === 'propose') {
    const objective = typeof args.objective === 'string' ? args.objective.trim() : '';
    if (!objective) return toolError('objective is required for propose (the boss\'s sentence, verbatim).');
    payload.objective = objective;
    // Şema dışı alan taşınmaz; katalog dışı slug main'de SESSİZCE düşer (§9.2).
    if (Array.isArray(args.roles)) payload.roles = args.roles.filter((r) => typeof r === 'string');
    if (typeof args.mode === 'string' && args.mode.trim()) payload.mode = args.mode.trim();
    if (typeof args.teamName === 'string' && args.teamName.trim()) payload.teamName = args.teamName.trim();
    // TC-07 — mode:'engine': mevcut çalışan(lar)ın motorunu değiştir. Motor id'si ve
    // ajan kimlikleri köprüye AYNEN gider; sunulabilirlik/varlık kararı main'dedir.
    if (typeof args.engine === 'string' && args.engine.trim()) payload.engine = args.engine.trim().toLowerCase();
    if (Array.isArray(args.agents)) payload.agents = args.agents.filter((a) => typeof a === 'string' && a.trim());
  } else {
    const proposalId = typeof args.proposalId === 'string' ? args.proposalId.trim() : '';
    if (!proposalId) return toolError(`proposalId is required for ${action} (it comes back from propose).`);
    payload.proposalId = proposalId;
    if (action === 'apply' && typeof args.approvalToken === 'string' && args.approvalToken.trim()) {
      payload.approvalToken = args.approvalToken.trim();
    }
  }

  let res;
  try {
    res = await bridgeRequestFailover(candidates, 'POST', '/team/compose', payload);
  } catch (err) {
    return toolError(`could not reach the CrewPane bridge: ${err.message}`);
  }
  if (res.status === 401) return toolError('CrewPane bridge rejected the token (stale handshake?).');
  if (res.status === 501) return toolError('team compose is not wired in this build.');
  const body = res.body || {};
  // ADP-717 — kapsam reddi kullanıcı diliyle gelir ve İZNİN NASIL VERİLECEĞİNİ söyler;
  // delegate'te olduğu gibi AYNEN geçiriyoruz (kendi cümlemizle örtmüyoruz).
  if (res.status === 403) return toolError(body.error || 'bu takıma çalışan ekleme iznin yok.');
  // 429 = TAVAN, 409 = onay beklemesi/jeton. İkisi de HATA DEĞİL bir DURUMDUR;
  // lider bunları patrona aynen aktarabilsin diye sebep cümlesi korunur.
  if (res.status === 429) return toolError(body.error || 'öneri tavanı aşıldı.');
  if (res.status === 409) {
    if (body.code === 'awaiting-approval') {
      // TC-FIX-01 — düğmenin GERÇEK adı "Ekibe ekle" (tr.ts) / "Add to the team" (en.ts);
      // eski metin olmayan bir düğme ("Ekibi kur") aratıyordu. Tıklama artık KURULUMDUR:
      // lider apply çağırmaz, sonucu pane'ine gelen ✅ notundan öğrenir.
      return toolOk(
        `⏳ ONAY BEKLENİYOR — kart kullanıcıya gösterildi, HİÇBİR satır yazılmadı. ${body.error || ''} `.trim() +
          ' Kullanıcı karttaki "Ekibe ekle" / "Add to the team" düğmesine basınca ürün ekibi KENDİSİ kurar ve sana ' +
          'terminaline ✅ [EKİP KURUCU] notu gelir — apply çağırmana gerek yok; kendi onayını UYDURAMAZSIN, ' +
          'not gelmeden "ekibi kurdum" DEME.',
      );
    }
    if (body.code === 'in-progress') {
      return toolOk(
        `⏳ KURULUM SÜRÜYOR — ${body.error || 'patron onayladı, ürün kuruyor.'} Sonuç terminaline ✅ [EKİP KURUCU] ` +
          'notu olarak gelecek; apply tekrar ÇAĞIRMA, not gelmeden "ekibi kurdum" DEME.',
      );
    }
    return toolError(body.error || 'onay jetonu geçersiz ya da kullanılmış.');
  }
  // TC-07 — 422 = ÖNERİ ÜRETİLMEDİ, kart AÇILMADI. Eski metin ("rol listesinde
  // karşılığı yok") YANLIŞ neden veriyordu (20.09: roller katalogdaydı, koltuklar
  // DOLUYDU) ve OpenCode lideri "katalog eşleşmesi yok" deyip hiç kart çıkmadan
  // "kartı deniyorum" diye devam etti. Şimdi main'in yapısal gövdesi (reason /
  // existing / unmatched / nearest / howTo) lidere AYNEN + okunur biçimde gider ve
  // "kuruldu DEME" tembihi eklenir. Eski main (yapısız gövde) yine okunur.
  if (res.status === 422) {
    const list = (k) => (Array.isArray(body[k]) ? body[k].filter((x) => typeof x === 'string' && x) : []);
    const lines = [
      `❌ ÖNERİ ÜRETİLMEDİ — KART AÇILMADI, hiçbir çalışan eklenmedi/değişmedi. reason=${body.reason || 'no-match'}`,
      body.error ? `Neden: ${body.error}` : '',
      list('existing').length ? `Ekipte zaten var: ${list('existing').join(', ')}` : '',
      list('unmatched').length ? `Katalogda yok: ${list('unmatched').join(', ')}` : '',
      list('nearest').length ? `En yakın katalog rolleri: ${list('nearest').join(', ')}` : '',
      list('rejected').length ? `Patron bu oturumda reddetti: ${list('rejected').join(', ')}` : '',
      list('unknownAgents').length ? `Takımda böyle biri yok: ${list('unknownAgents').join(', ')}` : '',
      body.howTo ? `Nasıl: ${body.howTo}` : '',
      'Patrona bunu OLDUĞU GİBİ söyle; "ekledim/kurdum/motoru değiştirdim" DEME — hiçbir şey yazılmadı. ' +
        'Doğru çağrı şeklini yukarıdan al ve bir kez daha dene; yine reddedilirse patrona sor.',
    ].filter(Boolean);
    return toolError(lines.join('\n'));
  }
  if (res.status !== 200 || !body.ok) {
    return toolError(`team compose failed (${res.status}): ${body.error || 'unknown error'}`);
  }

  if (action === 'propose' && body.mode === 'engine') {
    // TC-07 — motor değişikliği kartı: satır yazılmaz, "Ekibe ekle" düğmesi YOKTUR;
    // düğmenin GERÇEK adı "Motoru değiştir" (tr.ts) / "Switch engine" (en.ts).
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const lines = rows.map((r) => `• ${r.name} (${r.roleTitle}) · ${r.oneLiner} → ${r.modelLabel}${r.effort ? ` · ${r.effort}` : ''}`);
    const head =
      body.status === 'approved'
        ? 'Motor değişikliği önerisi hazır ve ayarın gereği ÖNCEDEN ONAYLI — apply ile uygulayabilirsin.'
        : 'Motor değişikliği önerisi kullanıcıya KART olarak gösterildi. Henüz hiçbir şey değişmedi.';
    return toolOk(
      [
        `${head} (proposalId=${body.proposalId})`,
        ...lines,
        body.status === 'approved'
          ? 'Uygulamak için: action:"apply" + bu proposalId.'
          : 'Kullanıcı karttaki "Motoru değiştir" / "Switch engine" düğmesine basınca ürün motoru KENDİSİ değiştirir ve ' +
            'terminaline ✅ [EKİP KURUCU] notu gelir. apply ÇAĞIRMA; onayı SEN veremezsin; not gelmeden "motoru değiştirdim" DEME. ' +
            'Pane açık olanlar için patron ayrıca "Yeni motorla yeniden başlat" şeridine basar — o zamana kadar eski motor koşar.',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  if (action === 'propose') {
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const lines = rows.map((r) => `• ${r.roleTitle} — ${r.name} · ${r.oneLiner} · ${r.modelLabel}${r.effort ? ` · ${r.effort}` : ''}`);
    const head =
      body.status === 'approved'
        ? 'Ekip önerisi hazır ve ayarın gereği ÖNCEDEN ONAYLI — apply ile kurabilirsin.'
        : 'Ekip önerisi kullanıcıya KART olarak gösterildi. Henüz hiçbir satır yazılmadı.';
    return toolOk(
      [
        `${head} (proposalId=${body.proposalId})`,
        body.teamName ? `Takım: ${body.teamName}` : '',
        ...lines,
        body.planNote || '',
        body.status === 'approved'
          ? 'Kurmak için: action:"apply" + bu proposalId.'
          : 'Kullanıcı karttaki "Ekibe ekle" / "Add to the team" düğmesine basınca ürün ekibi KENDİSİ kurar ve ' +
            'terminaline ✅ [EKİP KURUCU] notu gelir. apply ÇAĞIRMA; onayı SEN veremezsin; not gelmeden "ekibi kurdum" DEME.',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  if (action === 'apply') {
    // TC-FIX-01 §6 — cümleyi MAIN kurar (makbuzun `visible` alanına göre: "ofiste
    // görünüyor" yalnız sekme GERÇEKTEN çizildi ve seçiliyse). Bu süreç ikinci bir
    // cümle KURMAZ; makbuzsuz eski build'e karşı yalnız "yazıldı" der, "masasına
    // oturdu" demez (ölçülmeyen şey söylenmez).
    if (typeof body.receiptText === 'string' && body.receiptText.trim()) return toolOk(body.receiptText.trim());
    const names = Array.isArray(body.names) ? body.names : [];
    return toolOk(
      `Ekip kuruldu: ${body.teamName || 'takım'} — ${body.employees || names.length} kişi yazıldı` +
        (names.length ? ` (${names.join(', ')})` : '') +
        '. Ofiste görünüp görünmediği ÖLÇÜLEMEDİ — "masalarında" deme. Aynı oturumda crewpane_delegate ile ' +
        'onlara iş verebilirsin. Kullanıcı 10 dakika içinde geri alabilir.',
    );
  }

  // TC-07 — mode:'engine' geri alması satır SİLMEZ, eski motora döner.
  if (Number(body.restoredEngines) > 0 && !(body.removedEmployees > 0)) {
    return toolOk(
      `Geri alındı: ${body.restoredEngines} kişinin motoru eski hâline döndü. Kimse silinmedi; açık pane'lerde şerit yine "Yeni motorla yeniden başlat" der.`,
    );
  }
  return toolOk(
    `Geri alındı: ${body.removedEmployees || 0} çalışan` +
      (body.removedTeam ? ' ve takım' : '') +
      ' silindi. Yetim kalan satır yok.',
  );
}

// ── tool registry ────────────────────────────────────────────────────────────
// ADP-244 Faz 2 — KANONİK adlar `crewpane_*`; `withLegacyAliases` her biri için AYNI
// handler'a bağlı `crewpane_*` (deprecated ama çalışır) ikizini ekler. Server KEY'i
// (SERVER_INFO.name = 'crewpane') ve dosya adı SABİT — dış MCP config'leri kırılmasın.
const CANONICAL_TOOLS = [
  {
    name: 'crewpane_delegate',
    description:
      "Delegate an objective to your team in the CrewPane app. Spawns a REAL worker pane per subtask " +
      "(each worker runs its own AI engine + identity and the subtask is delivered as a prompt) and tracks them. " +
      "Use THIS for any 'distribute to the team / start the workers / have the team do X' request — do NOT use " +
      "claude's Task/subagent tool (those are invisible to the boss; only this opens real, watchable panes).",
    inputSchema: {
      type: 'object',
      properties: {
        objective: {
          type: 'string',
          description:
            'The work to distribute. A numbered or bulleted list is ideal — each item becomes one worker subtask. ' +
            'The objective reaches the worker VERBATIM plus a fixed template (ADP-458): the result-file directive is ' +
            'derived deterministically — an explicit docs/agent-results|outputs path in the item wins, else it derives ' +
            'from the task code + worker (docs/agent-results/<CODE>-<agent>.md) — so include the board task code ' +
            '(e.g. "ADP-453") in each item; files merely mentioned in prose are never turned into instructions.',
        },
        department: {
          type: 'string',
          description:
            'ADP-717 — the TEAM to delegate within. Defaults to YOUR OWN team, and that is the only team you may ' +
            'use unless the owner granted you cross-team permission (Settings → Takım İzinleri). Naming another ' +
            "team without a grant is refused, and the refusal says how to lift it. This is deliberate: you may only " +
            'give work to a team you can also MANAGE (close its panes) — you can never start work you cannot clean up.',
        },
        model: {
          type: 'string',
          description:
            "ADP-565 — the AI MODEL every spawned worker should run, e.g. 'opus' (strongest), " +
            "'sonnet' (default), 'haiku' (cheap), or a full id ('claude-opus-4-8'). Applied to any " +
            'worker without its own model. Omit → the task-class policy picks (P0/architecture → opus, ' +
            'routine → haiku, else sonnet). A per-worker `model` in `workers` overrides this.',
        },
        provider: {
          type: 'string',
          description:
            "ADP-595 — run this objective on a codex custom PROVIDER instead of the agent's own " +
            "setting, e.g. 'groq' (\"bu işi Groq'ta koştur\"). Only affects CODEX workers and only " +
            'together with a model (the provider hosts the model). Omit → each worker keeps its ' +
            'recorded provider (employees.provider) → the engine default. A per-worker `provider` ' +
            'in `workers` overrides this. Unknown ids are dropped main-side (registry: providers.cjs).',
        },
        workers: {
          type: 'array',
          description:
            'Optional explicit workers ([{agentId, engine?, model?, provider?}]); omit to use your full team ' +
            "roster automatically. `model` pins THAT worker's model (highest priority), overriding the objective " +
            "model + policy; `provider` likewise pins that worker's codex provider (ADP-595).",
          items: { type: 'object' },
        },
      },
      required: ['objective'],
    },
    run: runDelegate,
  },
  {
    name: 'crewpane_delegation_status',
    description: 'Check progress of your CrewPane delegations (per-worker subtask statuses).',
    inputSchema: {
      type: 'object',
      properties: {
        delegationId: { type: 'string', description: 'Optional; omit to list all your active delegations.' },
      },
    },
    run: runStatus,
  },
  {
    name: 'crewpane_sprint',
    description:
      'ADP-242 — start a LONG SPRINT (10-30 tasks) in the CrewPane app: give the FULL plan once ' +
      '(tasks with dependencies), then forget it — the app runs it wave by wave with real worker panes, ' +
      'persists state to disk (survives app/leader restarts and usage limits), and enforces per-worker ' +
      'serialization. RULES: every task prompt MUST contain its result-file path ' +
      '(e.g. docs/agent-results/<id>-<role>.md) or the plan is rejected; dependsOn ids must exist; no cycles. ' +
      'Use this instead of many crewpane_delegate calls whenever the work is a multi-task plan. ' +
      "STOP: call with action:'stop' to END a sprint (remaining tasks become 'skipped', finished work is kept). " +
      'Use it when a sprint is stuck — only ONE sprint may be active, so a stuck run blocks every new sprint.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop'], description: "'start' (default) | 'stop' (end a running/stuck sprint)." },
        sprintId: { type: 'string', description: "action='stop' only; omit to stop the active (or newest unfinished) sprint." },
        reason: { type: 'string', description: "action='stop' only; short note recorded on the skipped tasks." },
        objective: { type: 'string', description: 'Sprint hedefi (tek cümle).' },
        tasks: {
          type: 'array',
          description: 'The full plan. Each: {id, title, prompt, dependsOn?: string[], workerAgentId?, expectedOutput?, maxAttempts?}. prompt = the worker instruction INCLUDING the result-file path.',
          items: { type: 'object' },
        },
        department: { type: 'string', description: 'Team/wing (optional; defaults to your own team).' },
        maxConcurrent: { type: 'number', description: 'Max parallel workers per wave (default 4).' },
      },
      // DF-03 — `required` KALDIRILDI: action:'stop' çağrısında objective/tasks yoktur.
      // Zorunluluk çalışma anında uygulanır (runSprint) ve mesajı lidere aynen döner —
      // şemada tutulsaydı stop çağrısı istemci tarafında reddedilirdi.
    },
    run: runSprint,
  },
  {
    name: 'crewpane_sprint_status',
    description: 'Progress of a long sprint: numeric summary (done/in-flight/pending/failed/skipped + paused workers) + compact task list. Context-cheap — no pane output.',
    inputSchema: {
      type: 'object',
      properties: {
        sprintId: { type: 'string', description: 'Optional; omit to list active/recent sprints.' },
      },
    },
    run: runSprintStatus,
  },
  {
    name: 'crewpane_pane',
    description:
      'ADP-303 — control the office panes: list them, CLOSE one (or a set), or bring one to the front. ' +
      'Closing does exactly what the × button does (kills the pty, removes the pane from the office, clears ' +
      'its stall/queue ledger); the pane\'s transcript stays on disk, so nothing is lost. ' +
      'Use THIS to clean up finished/stray panes — NEVER kill pty processes from a shell (that crashes the app ' +
      'and leaves a "[pty exited]" zombie pane behind). ' +
      'ADP-717 SCOPE: your own TEAM — exactly the same scope crewpane_delegate uses. Whatever team you may give ' +
      'work to, you may also manage (and vice versa). A team outside that scope needs an owner grant ' +
      '(Settings → Takım İzinleri); `force` does NOT cross team boundaries. Your OWN pane needs force:true.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'close', 'focus'], description: "'list' | 'close' | 'focus'" },
        paneId: { type: 'string', description: 'Target pane (close/focus). Get it from action=list.' },
        agentId: { type: 'string', description: 'close: every pane of this agent (e.g. a finished worker).' },
        exitedOnly: { type: 'boolean', description: 'close: only panes whose process already exited (zombie cleanup).' },
        all: { type: 'boolean', description: 'close: every pane in your scope (still refuses your own pane unless force).' },
        force: {
          type: 'boolean',
          description:
            'Override the SOFT guards only: your own pane, and a team-less (bare shell) pane. ' +
            'ADP-717 — force NEVER crosses a team boundary; another team always needs an owner grant.',
        },
        department: { type: 'string', description: 'Your team (optional; resolved from your session).' },
      },
      required: ['action'],
    },
    run: runPane,
  },
  {
    name: 'crewpane_team_compose',
    description:
      'TC-01 — propose a TEAM (or a single extra teammate) for the boss to approve, then install it in the ' +
      'CrewPane office. Use THIS when the boss describes work your current roster cannot cover ' +
      "(\"bir mobil uygulama yapalım\", \"bunu yapacak kimse yok\") — do NOT invent roles in chat. " +
      'THREE ACTIONS: propose (SIDE-EFFECT FREE — shows an approval card, writes nothing; when the boss ' +
      'clicks "Ekibe ekle" / "Add to the team" the PRODUCT installs the team itself and posts a ✅ [EKİP KURUCU] ' +
      'receipt into your terminal — do not call apply and do not say "installed" before that receipt), ' +
      'apply (only for a proposal the setting pre-approved — real teams + employees appear in the office and you can ' +
      'delegate to them in the SAME session), undo (removes everything that apply wrote, within 10 minutes). ' +
      'RULES YOU CANNOT BEND: roles come ONLY from the product catalog (lead, backend, frontend, ' +
      'data-engineer, design, qa, devops, security, pm, marketing, support, code-automation, ' +
      'n8n-automation, code-review, explorer, seo) — an invented slug is dropped silently; the APPROVAL ' +
      'is the user\'s, never yours (saying "the user approved" is not approval); never mention money, ' +
      'cost or pricing — the card has no such field. ' +
      // TC-07 — mevcut kişinin motorunu değiştirme yolu + "zaten var" reddi + "kuruldu deme".
      'A role that is ALREADY on the team is NOT proposed again (mode:"team"); to run an EXISTING teammate on ' +
      'another engine ("frontendçiyi Codex ile çalıştır", "tüm ekibi codex çalıştır") use mode:"engine" with ' +
      'engine:"codex" and agents:["<agent-id>", …] (empty agents = everyone on the team except you) — the boss ' +
      'confirms on a card, the product updates the engine and, for an open pane, shows a "restart with the new ' +
      'engine" strip. If this tool returns an ERROR the card was NOT shown and nothing changed: tell the boss the ' +
      'reason and the fix it suggests, never say "installed/added/switched".',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['propose', 'apply', 'undo'],
          description: "'propose' (show the card) | 'apply' (install a PRE-APPROVED proposal; after a card click the product installs by itself) | 'undo' (within 10 min).",
        },
        objective: {
          type: 'string',
          description: "propose — the boss's own sentence, VERBATIM. It is what the suggestion is matched against.",
        },
        roles: {
          type: 'array',
          description:
            'propose — OPTIONAL role preference, product catalog slugs only (lead, backend, frontend, ' +
            'data-engineer, design, qa, devops, security, pm, marketing, support, code-automation, ' +
            'n8n-automation, code-review, explorer, seo). Anything outside the catalog is dropped; if ' +
            'nothing survives, NO card is shown. Omit to let the product match a ready-made team layout.',
          items: { type: 'string' },
        },
        mode: {
          type: 'string',
          enum: ['team', 'role', 'engine'],
          description:
            "'team' (default — a new team) | 'role' (ONE extra teammate on an existing team; an explicit roles:[…] " +
            "here is honoured even if that role already exists — the boss decides on the card) | 'engine' (change the " +
            'engine of EXISTING teammates — no new employee; needs `engine`, optional `agents`).',
        },
        engine: {
          type: 'string',
          description:
            "mode:'engine' — target engine id exactly as the product names it: claude | codex | copilot | goose | gemini | " +
            'qwen | opencode | cursor | kimi | crush | antigravity. Engines the product does not offer are refused.',
        },
        agents: {
          type: 'array',
          items: { type: 'string' },
          description:
            "mode:'engine' — agent ids of the teammates to switch (from crewpane_pane action:'list' or the office). " +
            'Omit or leave empty for EVERYONE on the team except yourself. Unknown ids are reported back, not guessed.',
        },
        teamName: { type: 'string', description: 'propose — suggested team name; the user can change it on the card.' },
        department: {
          type: 'string',
          description:
            'The team this concerns. Defaults to YOUR OWN team and that is the only one you may use unless ' +
            'the owner granted cross-team permission — exactly the same scope rule as crewpane_delegate.',
        },
        proposalId: { type: 'string', description: 'apply/undo — the id returned by propose.' },
        approvalToken: {
          type: 'string',
          description:
            'apply — OPTIONAL. It is minted by the app when the USER approves; you cannot create one. ' +
            'If you pass a value it must match exactly, otherwise the call is refused.',
        },
      },
      required: ['action'],
    },
    run: runTeamCompose,
  },
];

// Kanonik + legacy (crewpane_*) alias'lar — ikisi de aynı handler'ı çalıştırır.
const TOOLS = withLegacyAliases(CANONICAL_TOOLS);

// ── JSON-RPC stdio loop ──────────────────────────────────────────────────────
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function handle(msg) {
  const { id, method, params } = msg || {};
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return; // notifications get no response
  }
  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) },
    });
    return;
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      send({ jsonrpc: '2.0', id, result: toolError(`unknown tool: ${name}`) });
      return;
    }
    try {
      const result = await tool.run(args);
      send({ jsonrpc: '2.0', id, result });
    } catch (err) {
      logErr(`tool ${name} threw: ${err.message}`);
      send({ jsonrpc: '2.0', id, result: toolError(`tool error: ${err.message}`) });
    }
    return;
  }
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

function main() {
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        logErr(`bad JSON line ignored`);
        continue;
      }
      void handle(parsed);
    }
  });
  process.stdin.on('end', () => process.exit(0));
  logErr('crewpane delegate MCP server ready (stdio)');
}

// Export internals for unit tests; run the loop only when invoked directly.
module.exports = { discoverBridge, discoverBridgeCandidates, bridgeRequestFailover, summarizeStatus, summarizeSupervisor, runDelegate, runStatus, runSprint, runSprintStatus, summarizeSprintStatus, runPane, summarizePanes, runTeamCompose, TOOLS, CANONICAL_TOOLS, bridgeRequest, BRIDGE_FILE };
if (require.main === module) main();
