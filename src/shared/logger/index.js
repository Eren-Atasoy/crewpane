'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const logTarget = require('../../services/logTarget.cjs');
const crewpaneEnv = require('../../config/crewpaneEnv.cjs');
const secretRedactor = require('../../security/secretRedactor.cjs');
const { renameWithRetrySync } = require('../../../platform/atomicWrite.cjs');

let LOG_PATH = null;
let LOG_TARGET = null;
let canWriteStdout = () => true;

function setStdoutGuard(guardFn) {
  if (typeof guardFn === 'function') {
    canWriteStdout = guardFn;
  }
}

/**
 * Initializes the log file, applies rotation, and writes the boot header.
 */
function initLog({ app, isPackaged, mode, logsDir, homeEnv, osHome, argv, e2e, logsFolder } = {}) {
  LOG_TARGET = logTarget.resolveLogFile({
    logsDir: logsDir || (app && app.getPath('logs')),
    homeEnv: homeEnv !== undefined ? homeEnv : process.env.CREWPANE_HOME || null,
    osHome: osHome || os.homedir(),
    argv: argv || process.argv,
    e2e: !!e2e,
  });

  const folder = logsFolder || path.resolve(__dirname, '..', '..', '..', 'logs');
  if (!fs.existsSync(folder)) {
    try {
      fs.mkdirSync(folder, { recursive: true });
    } catch {
      /* best-effort */
    }
  }

  const packaged = isPackaged !== undefined ? isPackaged : app && app.isPackaged;
  LOG_PATH = packaged ? LOG_TARGET.file : path.join(folder, 'spike-log.txt');

  const gens = (() => {
    const n = Number(crewpaneEnv.readEnv('LOG_GENERATIONS'));
    return Number.isFinite(n) && n >= 1 && n <= 50 ? Math.floor(n) : 5;
  })();

  try {
    const p = path.parse(LOG_PATH);
    const gen = (i) => path.join(p.dir, `${p.name}.${i}${p.ext}`);
    try {
      renameWithRetrySync(path.join(p.dir, `${p.name}.prev${p.ext}`), gen(1));
    } catch {
      /* eski şema yoksa geç */
    }
    for (let i = gens - 1; i >= 1; i -= 1) {
      try {
        renameWithRetrySync(gen(i), gen(i + 1));
      } catch {
        /* yoksa geç */
      }
    }
    renameWithRetrySync(LOG_PATH, gen(1));
  } catch {
    /* first boot or unrotatable — best-effort */
  }

  try {
    fs.writeFileSync(LOG_PATH, `# CrewPane shell log — mode=${mode || ''} — ${new Date().toISOString()}\n`);
  } catch {
    /* logging is best-effort */
  }

  return { logPath: LOG_PATH, logTarget: LOG_TARGET };
}

/**
 * Appends a line to the active log file and stdout with secret redaction.
 */
function logLine(rawMsg) {
  const msg = secretRedactor.redact(String(rawMsg));
  try {
    if (LOG_PATH) fs.appendFileSync(LOG_PATH, msg + '\n');
  } catch {
    /* best-effort */
  }
  try {
    if (canWriteStdout()) process.stdout.write('[crewpane] ' + msg + '\n');
  } catch {
    /* raced with the pipe closing — the file log already has the line */
  }
}

function getLogPath() {
  return LOG_PATH;
}

function getLogTarget() {
  return LOG_TARGET;
}

module.exports = {
  initLog,
  logLine,
  getLogPath,
  getLogTarget,
  setStdoutGuard,
};
