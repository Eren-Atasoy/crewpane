'use strict';

const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Reserve a free TCP port from the OS, then release it for Next to bind.
 */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Poll the server until it answers an HTTP request (any status) or we time out.
 */
function waitForServer(url, { timeoutMs = 60000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error(`server not ready within ${timeoutMs}ms: ${url}`));
        } else {
          setTimeout(attempt, intervalMs);
        }
      });
      req.setTimeout(2000, () => req.destroy());
    };
    attempt();
  });
}

/**
 * Resolves Next.js standalone directory.
 */
function resolveStandaloneDir({ app, repoRoot }) {
  const localStandalone = path.join(repoRoot, 'standalone');
  if (fs.existsSync(localStandalone)) return localStandalone;
  return app.isPackaged
    ? path.join(process.resourcesPath, 'standalone')
    : path.join(repoRoot, '.next', 'standalone');
}

/**
 * Builds environment variables for the Next child process.
 */
function buildNextEnv(options) {
  const {
    workspaceRoot,
    crewpaneEnv,
    mappedProjectRoots,
    helperWatchdogPath,
  } = options;

  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    ...(workspaceRoot ? { CREWPANE_WORKSPACE_ROOT: workspaceRoot } : {}),
    ...crewpaneEnv.dualWrite({}, 'PROJECT_ROOTS', mappedProjectRoots.join(path.delimiter)),
    CREWPANE_PARENT_PID: String(process.pid),
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ''}--require ${JSON.stringify(helperWatchdogPath)}`,
  };
}

/**
 * Embedded Next Server Manager (Faz 3.6.5)
 */
function createNextServerManager(deps) {
  const {
    app,
    spawn,
    repoRoot,
    logLine = () => {},
    noteQuit = () => {},
    getAgentWorkspaceRoot = () => null,
    crewpaneHome = () => '',
    crewpaneEnv = require('../../config/crewpaneEnv.cjs'),
    helperReaper = require('../../core/helperReaper.cjs'),
    nextServerPolicy = require('../../config/nextServerPolicy.cjs'),
    mappedProjectRootsForReports = () => [],
    helperWatchdogPath = path.join(repoRoot, 'src', 'core', 'helperWatchdog.cjs'),
  } = deps;

  let nextServer = null;
  let nextServerRestartState = nextServerPolicy.initialState();

  function standaloneDir() {
    return resolveStandaloneDir({ app, repoRoot });
  }

  function handleServerExit(proc, code, signal, { mode, port, host }) {
    logLine(`next server exited code=${code} signal=${signal ?? '-'}`);
    try {
      helperReaper.forgetHelper(crewpaneHome(), proc.pid);
    } catch {
      /* best-effort */
    }
    if (nextServer === proc) nextServer = null;
    if (!app.isQuitting && !proc.__stopping) {
      const decision = nextServerPolicy.decideOnUnexpectedExit(nextServerRestartState, Date.now());
      nextServerRestartState = decision.state;
      if (decision.action === 'restart') {
        logLine(`next server beklenmedik öldü (code=${code} signal=${signal ?? '-'}) → ${decision.why}; port ${port} korunuyor (deneme ${decision.attempt})`);
        startNextServer(mode, { port }).then(
          () => logLine(`next server yeniden ayakta: http://${host}:${port}`),
          (err) => {
            logLine(`next server yeniden başlatılamadı: ${(err && err.message) || err}`);
            noteQuit('next-server-gone', `restart-failed code=${code} signal=${signal ?? '-'}`);
            app.quit();
          },
        );
        return;
      }
      logLine(`next server yine öldü → ${decision.why}; kapatılıyor`);
      noteQuit('next-server-gone', `code=${code} signal=${signal ?? '-'} ${decision.why}`);
      app.quit();
    }
  }

  function spawnServerProcess(mode, port, host, nodeEnv) {
    if (mode === 'dev') {
      const nextBin = path.join(repoRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
      logLine(`starting next dev on http://${host}:${port} (cwd=${repoRoot})`);
      return spawn(
        process.execPath,
        [nextBin, 'dev', '--hostname', host, '--port', String(port)],
        { cwd: repoRoot, env: nodeEnv, stdio: 'inherit' },
      );
    }
    const dir = standaloneDir();
    const serverJs = path.join(dir, 'server.js');
    if (!fs.existsSync(serverJs)) {
      throw new Error(
        `standalone server not found at ${serverJs}. Run "npm run build" (and copy ` +
        `.next/static + public into .next/standalone) — see npm run electron:build:prep.`,
      );
    }
    logLine(`starting standalone server on http://${host}:${port} (${serverJs})`);
    return spawn(process.execPath, [serverJs], {
      cwd: dir,
      env: { ...nodeEnv, NODE_ENV: 'production', PORT: String(port), HOSTNAME: host },
      stdio: 'inherit',
    });
  }

  async function startNextServer(mode, opts = {}) {
    const port = Number.isFinite(opts.port) ? opts.port : await getFreePort();
    const host = '127.0.0.1';
    const url = `http://${host}:${port}`;
    const workspaceRoot = getAgentWorkspaceRoot();
    const mappedProjectRoots = mappedProjectRootsForReports();

    const nodeEnv = buildNextEnv({
      workspaceRoot,
      crewpaneEnv,
      mappedProjectRoots,
      helperWatchdogPath,
    });

    nextServer = spawnServerProcess(mode, port, host, nodeEnv);
    const proc = nextServer;

    try {
      helperReaper.recordHelper(crewpaneHome(), {
        pid: proc.pid,
        kind: 'next-server',
        signature: mode === 'dev' ? 'next/dist/bin/next' : 'server.js',
      });
    } catch {
      /* best-effort */
    }

    proc.on('exit', (code, signal) => {
      handleServerExit(proc, code, signal, { mode, port, host, url });
    });
    proc.on('error', (err) => logLine(`next server spawn error: ${err.message}`));

    await waitForServer(url);
    logLine(`next server ready: ${url}`);
    return url;
  }

  function stopNextServer() {
    if (nextServer && !nextServer.killed) {
      logLine('killing next server');
      nextServer.__stopping = true;
      helperReaper.killWithGrace(nextServer.pid, { graceMs: 3000 });
    }
    nextServer = null;
  }

  return {
    getFreePort,
    waitForServer,
    standaloneDir,
    startNextServer,
    stopNextServer,
    getNextServer: () => nextServer,
    getNextServerRestartState: () => nextServerRestartState,
  };
}

module.exports = {
  createNextServerManager,
  getFreePort,
  waitForServer,
  resolveStandaloneDir,
};
