#!/usr/bin/env node
// ADP-095 (ADR-006 — headed automation) — crewpane browser MCP server (stdio).
//
// Spawned inside an agent's claude/codex session (via `--mcp-config`, same wiring
// as the ADP-051 delegation MCP). It exposes ONE tool, `crewpane_browser`, that
// lets the agent drive the app's internal browser — navigate / click / type /
// read / readPage / screenshot — over the ADP-050 loopback bridge (HTTP + token).
//
//   agent's MCP tool ──HTTP POST 127.0.0.1:<port>/browser (+token)──► bridge
//        │                                                              │
//        │                    approval (click/type) → renderer İzin ver │
//        ▼                                                              ▼
//   { result }  ◄──────────────── CDP on the <webview> guest (main, headed) ◄──
//
// MVP policy (enforced by the bridge/main, not here): navigate/read/screenshot are
// auto; click/type are approval-gated; every action is logged. Discovery + wire
// format mirror crewpane-delegate-mcp.cjs (env CREWPANE_BRIDGE_* or
// ~/.crewpane/bridge.json; newline-delimited JSON-RPC; logs to stderr only).

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const instancePaths = require('../config/instancePaths.cjs'); // ADP-206 — instance-scoped (inherits CREWPANE_INSTANCE from the agent pane's env)
const { withLegacyAliases } = require('./mcpToolAliases.cjs'); // ADP-244 Faz 2 — crewpane_browser kanonik + crewpane_browser legacy alias
const crewpaneEnv = require('../config/crewpaneEnv.cjs'); // ADP-244 Faz 3 — env dual-read (CREWPANE_* → CREWPANE_*)
const SERVER_INFO = { name: 'crewpane-browser', version: '1.0.0' };
// ADP-703 — el sıkışma dosyası CİHAZ kökünde (bkz. ACCOUNT-SCOPED-STORE.md §2).
const BRIDGE_FILE = path.join(instancePaths.instanceHome(), 'bridge.json');

function logErr(msg) {
  try {
    process.stderr.write(`[crewpane-browser-mcp] ${msg}\n`);
  } catch {
    /* stderr closed */
  }
}

// ── bridge discovery (ADP-050 contract) ──────────────────────────────────────
// ENV-08 — cross-instance damga reddi (ADP-286 paritesi): delegate MCP yabancı
// instance'ın handshake'ini reddediyordu, burası etmiyordu. Damgasız (eski build)
// dosya legacy-uyumla kabul edilir — ADP-286 ile aynı karar. `bridgeFile` yalnız
// birim test dikişidir; çalışma anında daima BRIDGE_FILE.
function discoverBridge(bridgeFile = BRIDGE_FILE) {
  // ADP-244 Faz 3 — dual-read (kanonik CREWPANE_BRIDGE_* → legacy CREWPANE_BRIDGE_*).
  const envPort = crewpaneEnv.readEnv('BRIDGE_PORT');
  const envTok = crewpaneEnv.readEnv('BRIDGE_TOKEN');
  if (envPort && envTok) {
    return { host: crewpaneEnv.readEnv('BRIDGE_HOST') || '127.0.0.1', port: Number(envPort), token: envTok };
  }
  try {
    const j = JSON.parse(fs.readFileSync(bridgeFile, 'utf8'));
    if (j && j.port && j.token) {
      if (j.instance && j.instance !== instancePaths.instanceId()) {
        logErr(`cross-instance bridge REJECTED: handshake instance=${j.instance}, ours=${instancePaths.instanceId()} (${bridgeFile})`);
        return null;
      }
      return { host: j.host || '127.0.0.1', port: Number(j.port), token: j.token };
    }
  } catch {
    /* no handshake file */
  }
  return null;
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
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        },
        // A click/type may block on a human approval — allow a generous window.
        timeout: 130000,
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

// ── tool helpers ─────────────────────────────────────────────────────────────
function toolError(text) {
  return { content: [{ type: 'text', text }], isError: true };
}
function toolOk(text) {
  return { content: [{ type: 'text', text }] };
}

/** Render a /browser result object into a short human/agent summary. */
function summarizeResult(action, result) {
  if (!result) return `browser ${action}: done.`;
  const parts = [];
  if (action === 'navigate') parts.push(`navigated to ${result.url || '(url)'}`);
  else if (action === 'read' || action === 'readPage') {
    const text = typeof result.text === 'string' ? result.text : '';
    parts.push(`read ${text.length} chars:\n${text.slice(0, 4000)}`);
  } else if (action === 'click') parts.push(`clicked ${result.selector || '(element)'}`);
  else if (action === 'type') parts.push(`typed into ${result.selector || '(element)'}`);
  else if (action === 'screenshot') parts.push('captured screenshot');
  else parts.push('done');
  if (result.screenshot) parts.push(`screenshot: ${result.screenshot}`);
  return parts.join('\n');
}

async function runBrowser(args) {
  const action = typeof args.action === 'string' ? args.action.trim() : '';
  if (!action) return toolError('action is required (navigate|click|type|read|readPage|screenshot).');

  const bridge = discoverBridge();
  if (!bridge) {
    return toolError('CrewPane app bridge not found — open the CrewPane app so the internal browser can be driven.');
  }

  const payload = { action };
  if (typeof args.url === 'string') payload.url = args.url;
  if (typeof args.selector === 'string') payload.selector = args.selector;
  if (typeof args.text === 'string') payload.text = args.text;
  // ADP-244 Faz 3 — dual-read; öncelik sırası (lider → ajan) korunur.
  payload.agentId = (crewpaneEnv.readEnv('LEADER_ID') || crewpaneEnv.readEnv('AGENT_ID') || '').trim() || undefined;

  let res;
  try {
    res = await bridgeRequest(bridge, 'POST', '/browser', payload);
  } catch (err) {
    return toolError(`could not reach the CrewPane bridge: ${err.message}`);
  }
  if (res.status === 401) return toolError('CrewPane bridge rejected the token (stale handshake?).');
  if (res.status === 501) return toolError('browser control not available in this app build.');
  if (res.body && res.body.denied) {
    return toolError(`the user denied the ${action} action.`);
  }
  if (res.status !== 200 || !res.body || !res.body.ok) {
    return toolError(`browser ${action} failed (${res.status}): ${(res.body && res.body.error) || 'unknown error'}`);
  }
  return toolOk(summarizeResult(action, res.body.result));
}

// ── tool registry ────────────────────────────────────────────────────────────
// ADP-244 Faz 2 — kanonik `crewpane_browser`; `withLegacyAliases` aynı handler'a bağlı
// `crewpane_browser` (deprecated ama çalışır) ikizini ekler. Server KEY'i
// (SERVER_INFO.name = 'crewpane-browser') SABİT.
const CANONICAL_TOOLS = [
  {
    name: 'crewpane_browser',
    description:
      "Drive the CrewPane app's internal browser (headed — the user watches it live). " +
      'Actions: navigate(url), click(selector), type(selector,text), read(selector), readPage, screenshot. ' +
      'navigate/read/readPage/screenshot run immediately; click and type ask the user to approve first. ' +
      'Use CSS selectors. Returns the result: page text for read/readPage; a screenshot file path for the screenshot action (navigate/click/type run silently without a screenshot — call screenshot or readPage if you need to confirm visually).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['navigate', 'click', 'type', 'read', 'readPage', 'screenshot'],
          description: 'What to do in the internal browser.',
        },
        url: { type: 'string', description: 'For navigate: the address (bare host/search is normalized).' },
        selector: { type: 'string', description: 'CSS selector for click / type / read.' },
        text: { type: 'string', description: 'For type: the text to enter into the focused element.' },
      },
      required: ['action'],
    },
    run: runBrowser,
  },
];

// Kanonik + legacy (crewpane_browser) alias — ikisi de aynı handler'ı çalıştırır.
const TOOLS = withLegacyAliases(CANONICAL_TOOLS);

// ── JSON-RPC stdio loop (newline-delimited; mirrors the delegation MCP) ───────
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
    return;
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
        logErr('bad JSON line ignored');
        continue;
      }
      void handle(parsed);
    }
  });
  process.stdin.on('end', () => process.exit(0));
  logErr('crewpane browser MCP server ready (stdio)');
}

module.exports = { discoverBridge, summarizeResult, runBrowser, TOOLS, CANONICAL_TOOLS, bridgeRequest, BRIDGE_FILE };
if (require.main === module) main();
