'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile, execFileSync } = require('node:child_process');
const ttsMute = require('../ttsMute.cjs');
const { SAY_VOICE } = require('./constants.cjs');

let _currentPlayback = null;

function getCurrentPlayback() {
  return _currentPlayback;
}

function setCurrentPlayback(child) {
  _currentPlayback = child;
}

function stopPlayback() {
  if (_currentPlayback) {
    try {
      _currentPlayback.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    _currentPlayback = null;
    return true;
  }
  return false;
}

/** Yerel ses çocuğu bu kadar sürerse asılmış sayılır (tek cümle saniyeler sürer). */
const SAY_TIMEOUT_MS = Number(process.env.CREWPANE_SAY_TIMEOUT_MS || 20000);

/** Canlı `say`/`afplay` çocukları (katman A). */
const _localAudioChildren = new Set();
/** Çocuk → onu kayıttan düşürüp bekçisini iptal eden fonksiyon. */
const _releaseLocalAudioChild = new WeakMap();
let _exitHooksInstalled = false;

function _installExitHooksOnce() {
  if (_exitHooksInstalled) return;
  _exitHooksInstalled = true;
  try {
    process.on('exit', () => {
      killLocalAudioChildren();
    });
  } catch {
    /* kancasız ortam */
  }
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    try {
      process.on(sig, () => {
        killLocalAudioChildren();
        if (process.listenerCount(sig) <= 1) process.exit(0);
      });
    } catch {
      /* kancasız ortam */
    }
  }
}

/**
 * Çocuğu kayda al; kendiliğinden bitince kayıttan düş. `timeoutMs > 0` ise
 * asılma sınırı da kurulur (`onTimeout` çağrılır, sonra SIGKILL).
 */
function trackLocalAudioChild(child, { timeoutMs = 0, onTimeout } = {}) {
  if (!child || typeof child.on !== 'function') return child;
  _installExitHooksOnce();
  _localAudioChildren.add(child);
  let timer = null;
  const forget = () => {
    _localAudioChildren.delete(child);
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  _releaseLocalAudioChild.set(child, forget);
  child.on('close', forget);
  child.on('exit', forget);
  child.on('error', forget);
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timer = null;
      try {
        if (typeof onTimeout === 'function') onTimeout();
      } catch {
        /* çağıran patlamasın */
      }
      try {
        child.kill('SIGKILL');
      } catch {
        /* zaten ölmüş */
      }
      _localAudioChildren.delete(child);
    }, timeoutMs);
  }
  return child;
}

/**
 * Çocuğu kayıttan düşür + bekçisini iptal et (öldürmeden).
 */
function untrackLocalAudioChild(child) {
  const release = child && _releaseLocalAudioChild.get(child);
  if (release) release();
  else if (child) _localAudioChildren.delete(child);
}

/** Katman A — canlı tüm yerel ses çocuklarını bitir. @returns öldürülen sayısı */
function killLocalAudioChildren() {
  let n = 0;
  for (const child of Array.from(_localAudioChildren)) {
    try {
      child.kill('SIGKILL');
      n += 1;
    } catch {
      /* zaten ölmüş */
    }
    _localAudioChildren.delete(child);
  }
  if (_currentPlayback) _currentPlayback = null;
  return n;
}

/** Ölçüm/test için: şu an kayıtlı canlı çocuk sayısı. */
function liveLocalAudioChildren() {
  return _localAudioChildren.size;
}

/**
 * TTS-ORPHAN-01 · katman D — AÇILIŞTA YETİM SÜPÜRGESİ.
 */
function sweepOrphanSayProcesses({
  execFileSyncImpl = execFileSync,
  killImpl,
  marker = path.join('crewpane-jarvis', 'say-'),
  platform = process.platform,
} = {}) {
  if (platform !== 'darwin') {
    return { scanned: 0, killed: [], skipped: true, reason: `platform-${platform}` };
  }
  const kill = killImpl || ((pid) => process.kill(pid, 'SIGKILL'));
  let out = '';
  try {
    out = String(execFileSyncImpl('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }) || '');
  } catch (e) {
    return { scanned: 0, killed: [], reason: `ps-failed: ${(e && e.message) || e}` };
  }
  const killed = [];
  let scanned = 0;
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    scanned += 1;
    const [, pidStr, ppidStr, cmd] = m;
    if (!/^say(\s|$)/.test(cmd)) continue;
    if (!cmd.includes(marker)) continue;
    if (Number(ppidStr) !== 1) continue;
    try {
      kill(Number(pidStr));
      killed.push(Number(pidStr));
    } catch {
      /* zaten ölmüş */
    }
  }
  return { scanned, killed };
}

// Katman C — DOSYA RENDER KUYRUĞU. Aynı anda tek `say -o`; sıradaki bekler.
let _sayRenderChain = Promise.resolve();
function queueSayRender(fn) {
  const next = _sayRenderChain.then(fn, fn);
  _sayRenderChain = next.then(() => {}, () => {});
  return next;
}

/**
 * Speak `text` with `say -v Yelda`.
 */
function speakSay({
  text,
  voice = SAY_VOICE,
  play = true,
  mode,
  outDir,
  uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  spawnImpl = spawn,
  execFileImpl = execFile,
  muted = ttsMute.isTtsMuted(),
  timeoutMs = SAY_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve) => {
    const clean = String(text == null ? '' : text).trim();
    if (!clean) {
      resolve({ ok: false, reason: 'empty-text' });
      return;
    }
    const useMode = muted ? 'file' : (mode || (play ? 'direct' : 'file'));
    if (process.platform === 'win32') {
      const t0 = Date.now();
      let child;
      try {
        stopPlayback();
        const psScript = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $text = [Console]::In.ReadToEnd(); if ($text) { $s.Speak($text) }`;
        child = trackLocalAudioChild(spawnImpl('powershell', ['-NoProfile', '-Command', psScript]));
        child.stdin.write(clean);
        child.stdin.end();
      } catch (e) {
        resolve({ ok: false, reason: 'say-spawn-failed', detail: String((e && e.message) || e) });
        return;
      }
      _currentPlayback = child;
      ttsMute.noteAudibleOutput('say-direct');
      child.on('error', () => {
        if (_currentPlayback === child) _currentPlayback = null;
      });
      child.on('close', () => {
        if (_currentPlayback === child) _currentPlayback = null;
      });
      resolve({ ok: true, ms: Date.now() - t0, voice: 'Windows System.Speech', mode: 'direct', path: null, bytes: 0 });
      return;
    }
    if (useMode === 'direct') {
      const t0 = Date.now();
      let child;
      try {
        stopPlayback();
        child = trackLocalAudioChild(spawnImpl('say', ['-v', voice, clean]));
      } catch (e) {
        resolve({ ok: false, reason: 'say-spawn-failed', detail: String((e && e.message) || e) });
        return;
      }
      _currentPlayback = child;
      ttsMute.noteAudibleOutput('say-direct');
      child.on('error', () => {
        if (_currentPlayback === child) _currentPlayback = null;
      });
      child.on('close', () => {
        if (_currentPlayback === child) _currentPlayback = null;
      });
      resolve({ ok: true, ms: Date.now() - t0, voice, mode: 'direct', path: null, bytes: 0 });
      return;
    }
    const dir = outDir || path.join(os.tmpdir(), 'crewpane-jarvis');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* best-effort */
    }
    const file = path.join(dir, `say-${uniq}.aiff`);
    queueSayRender(() => new Promise((settle) => {
      const t0 = Date.now();
      let child;
      try {
        child = spawnImpl('say', ['-v', voice, '-o', file, clean]);
      } catch (e) {
        settle({ ok: false, reason: 'say-spawn-failed', detail: String((e && e.message) || e) });
        return;
      }
      let settled = false;
      const done = (val) => {
        if (settled) return;
        settled = true;
        untrackLocalAudioChild(child);
        settle(val);
      };
      trackLocalAudioChild(child, {
        timeoutMs,
        onTimeout: () => done({ ok: false, reason: 'say-timeout', ms: Date.now() - t0, timeoutMs }),
      });
      child.on('error', (e) => done({ ok: false, reason: 'say-error', detail: String((e && e.message) || e) }));
      child.on('close', (code) => {
        if (code !== 0) {
          done({ ok: false, reason: `say-exit-${code}` });
          return;
        }
        let bytes = 0;
        try {
          bytes = fs.statSync(file).size;
        } catch {
          /* file missing → bytes 0 */
        }
        if (bytes) ttsMute.noteSynthesized(bytes);
        if (play && muted) {
          ttsMute.noteSuppressedOutput('say-afplay');
        } else if (play) {
          try {
            stopPlayback();
            ttsMute.noteAudibleOutput('afplay');
            _currentPlayback = trackLocalAudioChild(execFileImpl('afplay', [file], () => {
              _currentPlayback = null;
            }));
          } catch {
            /* playback best-effort */
          }
        }
        done({ ok: true, path: file, bytes, ms: Date.now() - t0, voice, mode: 'file', muted: muted || undefined, playIn: play && muted ? 'none' : undefined });
      });
    })).then(resolve, (e) => resolve({ ok: false, reason: 'say-queue-failed', detail: String((e && e.message) || e) }));
  });
}

module.exports = {
  SAY_TIMEOUT_MS,
  _installExitHooksOnce,
  trackLocalAudioChild,
  untrackLocalAudioChild,
  killLocalAudioChildren,
  liveLocalAudioChildren,
  sweepOrphanSayProcesses,
  queueSayRender,
  speakSay,
  stopPlayback,
  getCurrentPlayback,
  setCurrentPlayback,
};
