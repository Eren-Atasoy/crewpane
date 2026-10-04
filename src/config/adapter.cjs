// ADP-594 — Responses→ChatCompletions adapter for DeepSeek/Kimi (needsShim:true providers).
//
// Codex expects `wire_api="responses"` (codex-cli dropped wire_api="chat").
// Groq ships native Responses; DeepSeek/Kimi are Chat-Completions only.
// This adapter:
//   1. Spins up a local TCP server (127.0.0.1, random port OR env CREWPANE_ADAPTER_PORT).
//   2. Receives Responses-format requests (GET /openai/v1/responses?model=…&messages=[…]).
//   3. Translates to ChatCompletions (POST /v1/chat/completions).
//   4. Proxies to upstream (DeepSeek/Kimi baseUrl, env var holds real API key).
//   5. Streams back response in Responses format.
//
// Lifecycle:
//   • startAdapter() — main.js calls on boot (needsShim=true providers only).
//   • stopAdapter() — main.js calls on quit.
//   • Port is stored in env (CREWPANE_ADAPTER_PORT) so providers.js can build base_url.

'use strict';

const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const url = require('node:url');

let server = null;
let serverPort = null;

/**
 * Pick a free port by trying bind + close (avoids race, unlike traditional scan).
 */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const sock = net.createServer();
    sock.listen(0, '127.0.0.1', () => {
      const port = sock.address().port;
      sock.close(() => resolve(port));
    });
    sock.on('error', reject);
  });
}

/**
 * Parse a simple query string (only ?model=X&messages=[…]&stream=true).
 */
function parseQuery(queryStr) {
  const obj = {};
  if (!queryStr) return obj;
  const pairs = queryStr.split('&');
  for (const pair of pairs) {
    const [k, v] = pair.split('=', 2);
    obj[decodeURIComponent(k)] = v ? decodeURIComponent(v) : '';
  }
  return obj;
}

/**
 * Translate Responses messages to ChatCompletions format (minimal).
 * Responses: { role, content } array
 * ChatCompletions: same, so it's a pass-through mostly.
 */
function translateMessages(messages) {
  // messages is already in the right shape; just pass through.
  // If it arrives as JSON string, parse it.
  if (typeof messages === 'string') {
    try {
      return JSON.parse(messages);
    } catch {
      return [];
    }
  }
  return Array.isArray(messages) ? messages : [];
}

/**
 * Build a ChatCompletions request body from Responses query params.
 */
function buildUpstreamRequest(query) {
  const msgs = translateMessages(query.messages);
  const model = query.model || 'deepseek-chat';
  const stream = query.stream === 'true' || query.stream === 'True';
  return {
    model,
    messages: msgs,
    stream,
    // Optional: max_tokens, temperature, etc. from query if present.
    ...(query.temperature && { temperature: parseFloat(query.temperature) }),
    ...(query.max_tokens && { max_tokens: parseInt(query.max_tokens, 10) }),
  };
}

/**
 * Parse upstream API key from env (provider's envKey, e.g. DEEPSEEK_API_KEY).
 */
function getUpstreamKey(envKey) {
  return process.env[envKey] || null;
}

/**
 * Stream response from upstream → client.
 * Upstream is ChatCompletions streaming (SSE format like "data: {...}\n\n").
 * Codex expects Responses format, which is also SSE but with different payload shape.
 * For now, we'll pass through the JSON chunks (they're compatible enough for codex to parse).
 */
function streamProxy(upstreamRes, clientRes) {
  let buffer = '';
  upstreamRes.on('data', (chunk) => {
    buffer += chunk.toString('utf-8');
    const lines = buffer.split('\n');
    buffer = lines[lines.length - 1]; // keep incomplete line
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i].trim();
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') {
          clientRes.write('data: [DONE]\n\n');
        } else {
          try {
            const json = JSON.parse(data);
            // ChatCompletions delta shape → Responses (mostly pass-through).
            clientRes.write(`data: ${JSON.stringify(json)}\n\n`);
          } catch {
            // Malformed; skip.
          }
        }
      }
    }
  });
  upstreamRes.on('end', () => {
    if (buffer.trim()) {
      const line = buffer.trim();
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') {
          clientRes.write('data: [DONE]\n\n');
        } else {
          try {
            const json = JSON.parse(data);
            clientRes.write(`data: ${JSON.stringify(json)}\n\n`);
          } catch {
            // Ignore malformed.
          }
        }
      }
    }
    clientRes.end();
  });
  upstreamRes.on('error', (err) => {
    console.error('[adapter] upstream stream error:', err.message);
    clientRes.write(`data: {"error": "upstream stream failed: ${err.message}"}\n\n`);
    clientRes.end();
  });
}

/**
 * Build upstream URL + env key for a provider.
 * For testing, CREWPANE_ADAPTER_UPSTREAM_<PROVIDER> env var can override the real upstream URL.
 */
function getUpstreamConfig(provider) {
  let upstreamUrl = '';
  let envKey = '';

  if (provider === 'deepseek') {
    upstreamUrl = process.env.CREWPANE_ADAPTER_UPSTREAM_DEEPSEEK || 'https://api.deepseek.com/v1/chat/completions';
    envKey = 'DEEPSEEK_API_KEY';
  } else if (provider === 'moonshot') {
    upstreamUrl = process.env.CREWPANE_ADAPTER_UPSTREAM_MOONSHOT || 'https://api.moonshot.ai/v1/chat/completions';
    envKey = 'MOONSHOT_API_KEY';
  } else {
    return null;
  }

  return { upstreamUrl, envKey };
}

/**
 * Main request handler.
 */
async function handleRequest(req, res) {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  // Parse URL and extract provider from baseUrl override (injected by providers.js).
  // For now, we infer from query or env.
  const reqUrl = new url.URL(req.url, `http://${req.headers.host}`);
  const query = parseQuery(reqUrl.search.slice(1));

  // Which provider? x-adapter-provider header or default.
  let provider = req.headers['x-adapter-provider'] || 'deepseek';
  const config = getUpstreamConfig(provider);
  if (!config) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `unknown provider: ${provider}` }));
    return;
  }

  const { upstreamUrl, envKey } = config;

  const apiKey = getUpstreamKey(envKey);
  if (!apiKey) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `API key not set: ${envKey}` }));
    return;
  }

  // Build ChatCompletions request.
  const body = buildUpstreamRequest(query);

  // Create upstream request.
  const upstreamReqOptions = new url.URL(upstreamUrl);
  upstreamReqOptions.method = 'POST';
  upstreamReqOptions.headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'User-Agent': 'crewpane-adapter/1.0',
  };

  // Respond with streaming headers.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Make upstream request.
  const protocol = upstreamUrl.startsWith('https') ? https : http;
  const upstreamReq = protocol.request(upstreamReqOptions, (upstreamRes) => {
    if (upstreamRes.statusCode !== 200) {
      // Upstream error.
      let errorBody = '';
      upstreamRes.on('data', (chunk) => { errorBody += chunk.toString('utf-8'); });
      upstreamRes.on('end', () => {
        const msg = `upstream ${upstreamRes.statusCode}: ${errorBody}`;
        console.error(`[adapter] ${msg}`);
        res.write(`data: {"error": "${msg}"}\n\n`);
        res.end();
      });
      return;
    }
    // Success: stream proxy.
    streamProxy(upstreamRes, res);
  });

  upstreamReq.on('error', (err) => {
    console.error(`[adapter] upstream request error: ${err.message}`);
    res.write(`data: {"error": "upstream request failed: ${err.message}"}\n\n`);
    res.end();
  });

  upstreamReq.write(JSON.stringify(body));
  upstreamReq.end();
}

/**
 * Start the adapter server.
 * Returns { port, stop } where stop is a function to gracefully shut down.
 */
async function startAdapter() {
  if (server) {
    console.warn('[adapter] already running on port', serverPort);
    return { port: serverPort, stop: stopAdapter };
  }

  // Pick port: env override or auto-pick.
  let port = parseInt(process.env.CREWPANE_ADAPTER_PORT || '', 10);
  const fromEnv = !!(port && port >= 1 && port <= 65535);
  if (!fromEnv) {
    port = await pickFreePort();
  }

  // SMOKE-ISO-01 — MİRAS ALINAN PORT BAŞKASININ OLABİLİR.
  // `CREWPANE_ADAPTER_PORT` bağlandıktan sonra `process.env`e yazılır; pane'ler
  // (pty) bu ortamı MİRAS ALIR, dolayısıyla bir pane'den başlatılan İKİNCİ bir
  // CrewPane kopyası (duman testi, e2e, dogfood) canlı uygulamanın adapter
  // portuyla açılır. ÖLÇÜLDÜ (16.09, CRASH-R1 kanıt dosyası satır 24):
  //   `[adapter] start failed: listen EADDRINUSE ... 127.0.0.1:57578`
  // → o kopyada adapter HİÇ kalkmadı, `__ADAPTER_PORT__` şablonu çözülemedi ve
  // motor sağlayıcıları sessizce kullanılamaz oldu. Miras alınan port doluysa
  // ISRAR ETMEYİZ: boş bir porta düşeriz (canlı kopyanınkine oturmayı DENEMEYİZ).
  try {
    return await listenOn(port);
  } catch (err) {
    if (!fromEnv || (err && err.code) !== 'EADDRINUSE') throw err;
    const free = await pickFreePort();
    console.warn(`[adapter] miras alınan port ${port} dolu (başka bir kopya) → ${free} kullanılıyor`);
    return listenOn(free);
  }
}

/** Tek bir porta bağlanma denemesi. Hata `code` ile yukarı çıkar. */
function listenOn(port) {
  server = http.createServer(handleRequest);
  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      serverPort = port;
      process.env.CREWPANE_ADAPTER_PORT = String(port);
      console.log(`[adapter] listening on 127.0.0.1:${port}`);
      resolve({ port, stop: stopAdapter });
    });

    server.on('error', (err) => {
      server = null;
      serverPort = null;
      reject(err);
    });
  });
}

/**
 * Stop the adapter server.
 */
function stopAdapter() {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(() => {
      console.log('[adapter] stopped');
      server = null;
      serverPort = null;
      resolve();
    });
  });
}

module.exports = {
  startAdapter,
  stopAdapter,
  isRunning: () => serverPort !== null,
  getPort: () => serverPort,
};
