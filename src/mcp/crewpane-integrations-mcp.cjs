#!/usr/bin/env node
// BR-01 / INT-BRIDGE-02 (ADR-INT-BRIDGE §2.1) — ENTEGRASYON KEŞİF aracı (stdio MCP).
//
// Ürün kuralı: "entegrasyonun kullanıcısı ayar ekranı değil, AJANDIR." Bugüne kadar
// ajan yalnız BAĞLI servislerin araçlarını görüyordu; "Sentry bağlı değil" ile
// "Sentry diye bir şey desteklenmiyor"u AYIRAMIYORDU. Bu server tek bir soru açar:
//
//   agent ── crewpane_integrations ──► bridge GET /integrations/status ──► MAIN
//                                        (katalog + vault meta + resolver politikası)
//
// NEDEN KÖPRÜ, NEDEN SPAWN-ANI ENJEKSİYON DEĞİL: status CANLI olmalı. Kullanıcı pane
// açıkken Sentry'yi bağlarsa, spawn'da env'e gömülmüş bir "bağlılar listesi" YALAN
// söylerdi. Köprü her soruda taze cevap verir (ve `toolsLiveInThisPane` ile "bağlı ama
// bu pane'e yüklenmedi" hâlini ayrıca söyler).
//
// 🔴 SIR TAŞIMAZ: cevapta anahtar da, MASKELİ anahtar da YOKTUR — yalnız durum +
// metadata. Vault'a ikinci bir erişim yolu AÇILMAZ (ADR §5: tek kimlik yolu).
//
// Keşif/wire format: crewpane-browser-mcp.cjs ile birebir aynı (newline-delimited
// JSON-RPC over stdio; stdout YALNIZ protokol, log'lar stderr). Köprü keşfi ve
// failover'ı YENİDEN YAZILMAZ — delegate MCP'nin ADP-286 damgalı, cross-instance
// reddeden keşfi aynen kullanılır (task MCP ile aynı desen).

'use strict';

const { withLegacyAliases } = require('./mcpToolAliases.cjs'); // ADP-244 Faz 2 — kanonik crewpane_*
const crewpaneEnv = require('../config/crewpaneEnv.cjs'); // ADP-244 Faz 3 — env dual-read
const bridgeClient = require('./crewpane-delegate-mcp.cjs'); // ADP-286 keşif + failover (tek kaynak)
const { TOOL_FOOTER } = require('./integrationBriefing.cjs'); // BR-02 — konuşma kalıpları TEK kaynak

const SERVER_INFO = { name: 'crewpane-integrations', version: '1.0.0' };

function logErr(msg) {
  try {
    process.stderr.write(`[crewpane-integrations-mcp] ${msg}\n`);
  } catch {
    /* stderr closed */
  }
}

function toolError(text) {
  return { content: [{ type: 'text', text }], isError: true };
}
function toolOk(text) {
  return { content: [{ type: 'text', text }] };
}

/** Epoch ms → kısa, okunur damga ("2026-08-11 14:32"); null → "hiç". */
function stamp(ms) {
  if (!Number.isFinite(ms)) return 'hiç';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Bir servisin tek satırlık ayrıntısı (izin beyanı + son doğrulama = görevin sorusu). */
function detailLine(s) {
  const bits = [];
  if (s.scope) bits.push(s.scope.type === 'project' ? `kapsam: proje ${s.scope.projectId}` : 'kapsam: çalışma alanı');
  if (s.env) bits.push(`ortam: ${s.env}`);
  else if (s.scope) bits.push('ortam: her ikisi');
  bits.push(`izin beyanı: ${s.scopeHint || 'BEYAN YOK'}`);
  // INT-0-D — ÜÇ HÂL, ÜÇ CÜMLE. Eskiden ikisi ("hiç denenmedi" / "denendi, olmadı")
  // tek "hiç" altında birleşiyordu; oysa biri "test et" der, diğeri "anahtarı yenile".
  // 🔴 Başarısızlığın SEBEBİ iddia EDİLMEZ ("reddedildi" demiyoruz): probe ağ
  // hatasıyla da düşer ve yanlış teşhis, sessizlikten beterdir (ADR §3).
  if (s.lastVerifiedAt) bits.push(`son doğrulama: ${stamp(s.lastVerifiedAt)}`);
  else if (s.lastVerifyFailedAt) bits.push(`son deneme BAŞARISIZ: ${stamp(s.lastVerifyFailedAt)} — anahtar bu hâliyle çalışmayabilir`);
  else bits.push('son doğrulama: hiç denenmedi');
  return bits.join(' · ');
}

/**
 * Cevabı ajanın OKUYACAĞI metne çevir. Sözleşme kuralı: liste DAİMA tam katalogdur —
 * bağlı olmayanlar da yazılır, yoksa "bağlarsan senin için yaparım" cümlesi kurulamaz.
 */
function summarizeStatus(body, filterService) {
  const pane = (body && body.pane) || {};
  const all = Array.isArray(body && body.services) ? body.services : [];
  const services = filterService ? all.filter((s) => s.service === filterService) : all;
  if (filterService && !services.length) {
    return `"${filterService}" diye bir entegrasyon KATALOGDA YOK. Katalogdakiler: ${all.map((s) => s.service).join(', ')}.`;
  }

  const out = [];
  const paneBits = [`motor: ${pane.engine || 'bilinmiyor'}`, `ortam: ${pane.env || 'dev'}`];
  if (pane.projectId) paneBits.push(`proje: ${pane.projectId}`);
  out.push(`Bu pane — ${paneBits.join(' · ')}`);
  if (body && body.vaultAvailable === false) {
    out.push('⚠️ Anahtar deposu (Keychain) AÇILAMIYOR — bağlı kayıtlar okunamadı; aşağıdaki liste eksik olabilir.');
  }

  const live = services.filter((s) => s.state === 'connected' && s.toolsLiveInThisPane === true);
  const notLive = services.filter((s) => s.state === 'connected' && s.toolsLiveInThisPane !== true);
  const elsewhere = services.filter((s) => s.state === 'connected-elsewhere');
  const missing = services.filter((s) => s.state === 'not-connected');
  const external = services.filter((s) => s.state === 'externally-managed');

  if (live.length) {
    out.push('', 'BAĞLI — araçları BU pane\'de kullanılabilir:');
    for (const s of live) out.push(`• ${s.label} (${s.service}) — ${detailLine(s)}`);
  }
  if (notLive.length) {
    out.push('', 'BAĞLI — ama bu pane açıldığında yoktu (araçları BU pane\'de YOK):');
    for (const s of notLive) {
      // ENG-21 (G4) — GEREKÇE SUNUCUDAN GELİR, BURADA MOTOR ADI DALI YOKTUR.
      // Eskiden bu satır "motor claude değilse araç yok" diyordu; oysa anahtar copilot ve qwen
      // pane'lerine GERÇEKTEN enjekte ediliyor (ölçüldü) → o iki ajana yalan
      // söyleniyordu. Hüküm ve gerekçe artık `integrationStatus`ın pane bloğunda
      // (tek ev: `agentRunner.integrationsInjectable`).
      const missing = Array.isArray(s.missingUserFields) ? s.missingUserFields : [];
      const why =
        // INT-0-A — EN ÖNCE eksik ayar. Kullanıcı anahtarı girmiş ama servisin
        // çalışması için gereken (gizli OLMAYAN) alanı boş bırakmışsa "yeni pane'de
        // yaparım" demek YALANDIR: yeni pane'de de düşer. Ajan ne eksik olduğunu
        // ADIYLA söylemeli, yoksa kullanıcı neyi dolduracağını bilemez.
        missing.length
          ? `EKSİK AYAR — ${missing.join(', ')} boş; anahtar kayıtlı ama servis bu hâliyle ÇALIŞMAZ. `
            + `Kullanıcıya "${s.connectHint} ekranından ${missing.join(', ')} alanını doldur" de; `
            + 'yeni bir pane açmak bunu ÇÖZMEZ'
          // MCP-LAZY-01 — PROFIL KAPISI. Bu servis kullanicinin isaretiyle BU pane'de
          // kapatilmis. "Yeni pane'de yaparim" demek burada YALAN olurdu: yeni pane
          // de ayni profili tasir. Ajan ne yapilacagini ADIYLA soylemeli.
          : typeof s.notLiveReason === 'string' && s.notLiveReason.startsWith('profile-gate')
          ? `BU PANE'DE KAPALI — baglanti duruyor ama ${
              s.notLiveReason.endsWith('role') ? 'bu ajan rolu'
                : s.notLiveReason.endsWith('project') ? 'bu proje' : 'genel ayar'
            } icin otomatik acilma KAPATILMIS. Yeni bir pane acmak bunu COZMEZ; `
            + `kullaniciya "${s.connectHint} ekranindan bu ajan icin ac" de`
          : pane.integrationsInjectable === false
          ? `bu motorun (${pane.engine || 'bilinmiyor'}) MCP kanalı sır TAŞIYAMIYOR → entegrasyon araçları bu pane'de yok`
            + (pane.integrationsReason ? ` — ${pane.integrationsReason}` : '')
          : s.toolsLiveInThisPane === null
            ? 'bu pane köprünün canlı defterinde bulunamadı — emin değilim'
            : 'yeni bir pane\'de (ya da beni yeniden başlatınca) kullanabilirim';
      out.push(`• ${s.label} (${s.service}) — ${detailLine(s)} · ${why}`);
    }
  }
  if (elsewhere.length) {
    out.push('', 'BAĞLI — ama BU bağlama (proje/ortam) değil:');
    for (const s of elsewhere) out.push(`• ${s.label} (${s.service}) — ${detailLine(s)} · bu pane: ${pane.env || 'dev'}`);
  }
  if (missing.length) {
    out.push('', 'BAĞLI DEĞİL — kullanıcı bağlarsa kullanabilirim:');
    for (const s of missing) out.push(`• ${s.label} (${s.service}) — bağlama yolu: ${s.connectHint}`);
  }
  if (external.length) {
    out.push('', 'Anahtarı BAŞKA bir yüzey yönetiyor (ajan aracı değil):');
    for (const s of external) out.push(`• ${s.label} (${s.service}) — ${s.connectHint}`);
  }

  // BR-02 — üç-durum protokolünün kısa hatırlatması. Metin BURADA YAZILMAZ:
  // `integrationBriefing.cjs` tek kaynaktır (aynı kurallar sistem promptuna da girer;
  // iki yerde ayrı ayrı yazılsaydı metinler çatallanıp iki farklı davranış üretirdi).
  out.push('', TOOL_FOOTER);
  return out.join('\n');
}

/** Bu pane'in kimliği — köprü, canlı pane defterinde bunu arar. */
function selfAgentId() {
  return (crewpaneEnv.readEnv('LEADER_ID') || crewpaneEnv.readEnv('AGENT_ID') || '').trim() || '';
}

async function runIntegrations(args = {}) {
  const service = typeof args.service === 'string' ? args.service.trim() : '';
  const candidates = bridgeClient.discoverBridgeCandidates();
  if (!candidates.length) {
    return toolError(
      'CrewPane köprüsü bulunamadı — entegrasyon durumu yalnız uygulama açıkken sorulabilir. '
        + 'Kullanıcıya uygulamanın açık olup olmadığını sor.',
    );
  }
  // Yalnız KİMLİK gönderilir. Motor/proje/ortam BEYAN EDİLMEZ: onları main, ajanın
  // CANLI pane kaydından okur (spawn anında yazılır, ajan erişemez) — ADP-717'nin
  // "çağıranın kapsamı beyandan değil kendi kaydından çözülür" kuralının aynısı.
  // Beyana yaslanan bir cevap, ajanın kendi hakkında yanılmasıyla birlikte yanılırdı.
  const qs = new URLSearchParams();
  const agentId = selfAgentId();
  if (agentId) qs.set('agent', agentId);

  let res;
  try {
    res = await bridgeClient.bridgeRequestFailover(candidates, 'GET', `/integrations/status?${qs.toString()}`);
  } catch (err) {
    return toolError(`CrewPane köprüsüne ulaşılamadı: ${err.message}`);
  }
  if (res.status === 401) return toolError('CrewPane köprüsü jetonu reddetti (bayat el sıkışma?).');
  if (res.status === 501) {
    return toolError('bu uygulama sürümü entegrasyon keşfini desteklemiyor (köprü ucu yok).');
  }
  const body = res.body;
  if (res.status !== 200 || !body || body.ok !== true) {
    return toolError(`entegrasyon durumu alınamadı (${res.status}): ${(body && body.error) || 'bilinmeyen hata'}`);
  }
  return toolOk(summarizeStatus(body, service));
}

const CANONICAL_TOOLS = [
  {
    name: 'crewpane_integrations',
    description:
      'Ask CrewPane which external services (Sentry, GitHub, PostHog, Supabase, Stripe, …) are CONNECTED for '
      + 'this pane, what permissions the user declared for each key, and when each key was last verified to work. '
      + 'ALWAYS call this BEFORE telling the user you can (or cannot) use an external service — never guess. '
      + 'The answer lists the FULL catalog: connected services (with scope/env), services connected in a different '
      + 'project/environment, services that are not connected at all (so you can offer "connect it and I will do X"), '
      + 'and services whose key is managed elsewhere. It NEVER returns secrets. Optional `service` narrows the answer.',
    inputSchema: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          description: 'Optional: a single service id (e.g. "sentry") to ask about instead of the whole catalog.',
        },
      },
    },
    run: runIntegrations,
  },
];

// Kanonik + legacy (crewpane_integrations) — ikisi de aynı handler'ı çalıştırır.
const TOOLS = withLegacyAliases(CANONICAL_TOOLS);

// ── JSON-RPC stdio loop (browser/task MCP ile birebir) ───────────────────────
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
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
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
        logErr('bad JSON line ignored');
        continue;
      }
      void handle(parsed);
    }
  });
  process.stdin.on('end', () => process.exit(0));
  logErr('crewpane integrations MCP server ready (stdio)');
}

module.exports = { summarizeStatus, detailLine, stamp, runIntegrations, selfAgentId, TOOLS, CANONICAL_TOOLS };
if (require.main === module) main();
