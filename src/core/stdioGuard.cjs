// CrewPane — ADP-303 (A): main-process stdio/uncaught-exception guard.
//
// WHY (Eren's 2026-07-12 incident): the leader had no pane-close tool, so it killed the
// pane pty processes by hand. The app is LAUNCHED from a terminal/pane, so main's stdout is
// a PIPE whose reader died with that process. The very next `logLine` → process.stdout.write
// hit a broken pipe. An EPIPE on a stream does NOT surface as a throw at the call site — it
// arrives ASYNCHRONOUSLY as an 'error' event on the stream, and an unhandled stream 'error'
// becomes an uncaughtException → Electron's default handler popped
// "A JavaScript error occurred in the main process — Error: write EPIPE".
//
// So a try/catch around the write is NOT enough (that was the trap): the stream needs an
// 'error' listener, and once the pipe is broken we must stop writing to it entirely.
//
// Electron's own crash dialog is registered as an uncaughtException LISTENER and it opts out
// when another listener exists (`process.listenerCount('uncaughtException') > 1`). Installing
// our handler therefore SUPPRESSES the default dialog for everything — including real bugs.
// That would be masking, not fixing. So `installStdioGuards` takes `onFatal`: benign I/O
// (EPIPE & friends) is logged and swallowed; anything else is handed back to the caller,
// which still shows the dialog. Pure/Electron-free so `node --test` can prove both branches.

'use strict';

// Broken-pipe / dead-stream family. These mean "the thing I was writing to went away" —
// never "the app is in a bad state". Also EIO: a pty's controlling terminal disappeared.
const BENIGN_IO_CODES = new Set([
  'EPIPE',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
  'ECONNRESET',
  'EIO',
  'EBADF',
]);

/** True when `err` is a dead-stream / broken-pipe I/O error (safe to swallow). */
function isBenignIoError(err) {
  if (!err) return false;
  const code = typeof err.code === 'string' ? err.code : '';
  if (BENIGN_IO_CODES.has(code)) return true;
  // node-pty/libuv sometimes surfaces the code only inside the message ("write EPIPE").
  const msg = typeof err.message === 'string' ? err.message : String(err);
  return /\b(EPIPE|EIO|EBADF|ECONNRESET|ERR_STREAM_DESTROYED|ERR_STREAM_WRITE_AFTER_END)\b/.test(msg);
}

/**
 * Install the guards on a process-like object.
 *
 * @param {object} ctx
 *   proc    — process (or a stub in tests) with stdout/stderr + .on().
 *   log     — line logger (must NOT go through the guarded stdout; file append is fine).
 *   onFatal — called with a NON-benign uncaught error; the caller keeps the crash visible
 *             (dialog) instead of us silently masking it.
 * @returns {{ canWriteStdout: () => boolean, canWriteStderr: () => boolean }}
 *   `canWriteStdout()` goes false the moment the pipe breaks — logLine skips the write
 *   from then on (the file log keeps everything).
 */
function installStdioGuards({ proc, log = () => {}, onFatal = () => {} }) {
  const broken = { stdout: false, stderr: false };

  for (const name of ['stdout', 'stderr']) {
    const stream = proc[name];
    if (!stream || typeof stream.on !== 'function') continue;
    stream.on('error', (err) => {
      if (isBenignIoError(err)) {
        if (!broken[name]) log(`stdio: ${name} pipe broken (${err.code || err.message}) — muting further writes`);
        broken[name] = true;
        return;
      }
      log(`stdio: ${name} error (${err && err.message}) — muting further writes`);
      broken[name] = true;
    });
  }

  proc.on('uncaughtException', (err) => {
    if (isBenignIoError(err)) {
      log(`uncaught benign I/O error swallowed: ${(err && err.code) || ''} ${(err && err.message) || err}`);
      return;
    }
    log(`uncaughtException: ${(err && err.stack) || err}`);
    try {
      onFatal(err);
    } catch {
      /* the fatal reporter itself must never re-crash the app */
    }
  });

  proc.on('unhandledRejection', (reason) => {
    if (isBenignIoError(reason)) {
      log(`unhandled benign I/O rejection swallowed: ${(reason && reason.message) || reason}`);
      return;
    }
    log(`unhandledRejection: ${(reason && reason.stack) || reason}`);
  });

  const writable = (name) => {
    if (broken[name]) return false;
    const s = proc[name];
    if (!s) return false;
    if (s.destroyed === true) return false;
    if (s.writable === false) return false;
    return true;
  };

  return {
    canWriteStdout: () => writable('stdout'),
    canWriteStderr: () => writable('stderr'),
  };
}

module.exports = { installStdioGuards, isBenignIoError, BENIGN_IO_CODES };
