'use strict';

/**
 * CrewPane Preload Entry Point
 *
 * Modular bridges bundled into dist/preload.js via esbuild.
 * Sandboxed runtime: 'electron' is the only allowed external module.
 */

require('./bridges/platform.js');
require('./bridges/database.js');
require('./bridges/core.js');
require('./bridges/terminal.js');
require('./bridges/agents.js');
require('./bridges/skills.js');
require('./bridges/tasks.js');
require('./bridges/voice.js');
require('./bridges/files.js');
require('./bridges/services.js');
require('./bridges/hand.js');
require('./bridges/mobile.js');
require('./bridges/settings.js');
require('./bridges/sync.js');
require('./bridges/browser.js');
require('./bridges/system.js');
require('./bridges/test.js');
