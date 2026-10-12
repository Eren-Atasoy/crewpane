'use strict';

/**
 * CrewPane Preload Entry Point (0.4.0 Extended Architecture)
 *
 * Bundles:
 *   1. Full 0.4.0 Preload Surface (77 bridges)
 *   2. CrewPane Compatibility Aliases (crewpanePlatform, crewpaneDb, crewpaneApi, etc.)
 *   3. Task Management & Cleanup API (taskApi)
 *   4. Jev AI Orchestrator UI Bridge (floating widget, mode/policy toggles, simulator)
 *
 * Sandboxed runtime: 'electron' is the only allowed external module.
 */

require('./basePreload.js');
require('./bridges/crewpaneCompat.js');
require('./bridges/jevUiBridge.js');
