'use strict';

const path = require('node:path');
const { execSync } = require('node:child_process');

/**
 * Bootstrap Step 07: Shell Commit Resolution & Environment Scrubbing
 *
 * 1. Resolves git commit of the shell for diagnostic / header badges.
 * 2. Scrubs foreign child session environment variables.
 */
function run(ctx) {
  const app = ctx.app;
  const projectRoot = path.resolve(__dirname, '..', '..', '..');

  const shellCommit = (() => {
    if (app && app.isPackaged) {
      try {
        const pkg = require(path.join(projectRoot, 'package.json'));
        return String(pkg.gitCommit ?? '').trim() || null;
      } catch {
        return null;
      }
    }
    try {
      return execSync('git rev-parse --short HEAD', {
        cwd: projectRoot,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim() || null;
    } catch {
      return null;
    }
  })();

  for (const k of [
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_EXECPATH',
    'CLAUDE_EFFORT',
    'CLAUDECODE',
  ]) {
    delete process.env[k];
  }

  ctx.shellCommit = shellCommit;
  return shellCommit;
}

module.exports = { run };
