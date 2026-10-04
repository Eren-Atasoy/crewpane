'use strict';
/**
 * CrewPane Domain: MCP
 */
const path = require('node:path');

module.exports = {
  get crewpane_browser_mcp() { return require(path.join(__dirname, "crewpane-browser-mcp.cjs")); },
  get crewpane_delegate_mcp() { return require(path.join(__dirname, "crewpane-delegate-mcp.cjs")); },
  get crewpane_integrations_mcp() { return require(path.join(__dirname, "crewpane-integrations-mcp.cjs")); },
  get crewpane_task_mcp() { return require(path.join(__dirname, "crewpane-task-mcp.cjs")); },
  get codexMcpProfile() { return require(path.join(__dirname, "codexMcpProfile.cjs")); },
  get codexRolloutProbe() { return require(path.join(__dirname, "codexRolloutProbe.cjs")); },
  get integrationAutostart() { return require(path.join(__dirname, "integrationAutostart.cjs")); },
  get integrationBriefing() { return require(path.join(__dirname, "integrationBriefing.cjs")); },
  get integrationCatalog() { return require(path.join(__dirname, "integrationCatalog.cjs")); },
  get integrationIpc() { return require(path.join(__dirname, "integrationIpc.cjs")); },
  get integrationResolver() { return require(path.join(__dirname, "integrationResolver.cjs")); },
  get integrationStatus() { return require(path.join(__dirname, "integrationStatus.cjs")); },
  get mcpLazyProxy() { return require(path.join(__dirname, "mcpLazyProxy.cjs")); },
  get mcpProbe() { return require(path.join(__dirname, "mcpProbe.cjs")); },
  get mcpProcess() { return require(path.join(__dirname, "mcpProcess.cjs")); },
  get mcpToolAliases() { return require(path.join(__dirname, "mcpToolAliases.cjs")); },
  get npxDirect() { return require(path.join(__dirname, "npxDirect.cjs")); },
};
