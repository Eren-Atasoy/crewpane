'use strict';

const { spawn: defaultSpawn } = require('node:child_process');

/**
 * Rebuild & Relaunch Service (ADP-139 / Phase 3.6.42)
 * Rebuilds the standalone bundle (`electron:build:prep`) and relaunches the app so
 * a renderer edit is reflected without leaving the app or running a terminal command.
 *
 * Security: the command + args are FIXED (`npm run electron:build:prep`) — nothing
 * is taken from the renderer, so there is no RCE surface (same discipline as ptyApi's
 * command whitelist). Gated to the source tree (never a packaged .app, which has no
 * source/npm). Single-flight so two clicks can't race two builds.
 */
class RebuildService {
  constructor({
    app,
    spawn = defaultSpawn,
    repoRoot,
    logLine = () => {},
    relaunchApp = () => {},
  } = {}) {
    this._app = app;
    this._spawn = spawn;
    this._repoRoot = repoRoot;
    this._logLine = logLine;
    this._relaunchApp = relaunchApp;
    this._rebuildInFlight = false;
  }

  isBusy() {
    return this._rebuildInFlight;
  }

  rebuildAndRelaunch(event) {
    if (this._app && this._app.isPackaged) return { ok: false, reason: 'packaged-unsupported' };
    if (this._rebuildInFlight) return { ok: false, reason: 'busy' };
    this._rebuildInFlight = true;

    const sender = event && event.sender;
    const emit = (payload) => {
      try {
        if (sender && !sender.isDestroyed()) sender.send('app:rebuild:progress', payload);
      } catch {
        /* best-effort */
      }
    };

    this._logLine('rebuild: starting `npm run electron:build:prep`');
    emit({ phase: 'start', line: 'Yeniden derleniyor… (electron:build:prep)' });

    // FIXED command/args — no renderer-supplied input. cwd = the source repo root.
    const child = this._spawn('npm', ['run', 'electron:build:prep'], {
      cwd: this._repoRoot,
      env: process.env,
    });

    const pipeLines = (stream) => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) {
            this._logLine('rebuild: ' + line);
            emit({ phase: 'log', line });
          }
        }
      });
    };
    if (child.stdout) pipeLines(child.stdout);
    if (child.stderr) pipeLines(child.stderr);

    child.on('error', (err) => {
      this._rebuildInFlight = false;
      this._logLine(`rebuild: spawn error: ${err.message}`);
      emit({ phase: 'error', line: `Derleme başlatılamadı: ${err.message}` });
    });

    child.on('exit', (code) => {
      this._rebuildInFlight = false;
      if (code === 0) {
        this._logLine('rebuild: success → relaunching');
        emit({ phase: 'done', line: 'Derleme tamam — yeniden başlatılıyor…' });
        // Give the renderer a beat to render the "relaunching" state before we go.
        setTimeout(() => this._relaunchApp('rebuild'), 400);
      } else {
        this._logLine(`rebuild: failed code=${code}`);
        emit({
          phase: 'error',
          line: `Derleme başarısız (çıkış kodu ${code}). Terminalden \`npm run electron:build:prep\` ile detayları gör.`,
        });
      }
    });

    return { ok: true, started: true };
  }
}

function createRebuildService(deps) {
  return new RebuildService(deps);
}

module.exports = {
  createRebuildService,
  RebuildService,
};
