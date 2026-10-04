'use strict';

const fs = require('node:fs');
const path = require('node:path');
const envProfileModule = require('../../config/envProfile.cjs');
const buildChannel = require('../../config/buildChannel.cjs');

/**
 * Bootstrap Step 03: Environment Profile Application
 *
 * TEK ANAHTARLI HAT SEÇİMİ: CREWPANE_ENV=local|dev|prod.
 * Fail-fast: tanınmayan değer veya ayrışan ikiz ad durumunda stderr + diyalog ve app.exit(1).
 */
function run(ctx) {
  const app = ctx.app;
  const dialog = ctx.dialog;
  const projectRoot = path.resolve(__dirname, '..', '..', '..');

  const envProfile = envProfileModule.applyEnvProfile({
    target: process.env,
    configDir: path.join(projectRoot, 'config'),
    join: path.join,
    readFile: (p) => {
      try {
        return fs.readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    },
    customerBuild: buildChannel.isCustomerBuild(),
    packaged: app ? app.isPackaged : false,
  });

  if (envProfile.errors && envProfile.errors.length) {
    const detail = envProfile.errors.join('\n\n');
    try {
      process.stderr.write(`[env] ⛔ profil hatası:\n${detail}\n`);
    } catch {
      /* best-effort */
    }
    try {
      if (dialog && typeof dialog.showErrorBox === 'function') {
        dialog.showErrorBox('CrewPane — ortam profili hatalı', detail);
      }
    } catch {
      /* headless */
    }
    if (app && typeof app.exit === 'function') {
      app.exit(1);
    }
  }

  ctx.envProfile = envProfile;
  return envProfile;
}

module.exports = { run };
