// CrewPane — Task Board MCP stdio Protocol Loop (Phase 4.14)
'use strict';

const { logErr } = require('./backendClient.cjs');
const { toolError } = require('./taskHelpers.cjs');
const { TOOLS } = require('./toolDefs.cjs');

const SERVER_INFO = { name: 'crewpane-task', version: '1.0.0' };

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
  logErr('crewpane task MCP server ready (stdio)');
}

module.exports = {
  SERVER_INFO,
  send,
  handle,
  main,
};
