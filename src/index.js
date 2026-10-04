'use strict';


/**
 * CrewPane Main Architectural Export
 */
module.exports = {
  core: require('./core'),
  config: require('./config'),
  agents: require('./agents'),
  voice: require('./voice'),
  memory: require('./memory'),
  terminal: require('./terminal'),
  mcp: require('./mcp'),
  security: require('./security'),
  hand: require('./hand'),
  mobile: require('./mobile'),
  services: require('./services'),
  ui: require('./ui')
};
