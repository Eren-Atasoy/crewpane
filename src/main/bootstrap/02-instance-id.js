'use strict';

const instancePaths = require('../../config/instancePaths.cjs');
const crewpaneEnv = require('../../config/crewpaneEnv.cjs');

/**
 * Bootstrap Step 02: Instance ID Resolution & Isolation
 *
 * PIN the resolved instance id (PROD=packaged, DEV=source; CREWPANE_INSTANCE override wins)
 * into the env BEFORE any local module that derives a config path.
 */
function run(ctx) {
  const app = ctx.app;
  const isPackaged = app ? app.isPackaged : false;
  const argv = ctx.argv || process.argv;

  const instanceId = instancePaths.resolveInstanceId({ isPackaged, argv });
  crewpaneEnv.dualWrite(process.env, 'INSTANCE', instanceId);

  ctx.instanceId = instanceId;
  ctx.instanceHome = instancePaths.instanceHome();
  return instanceId;
}

module.exports = { run };
