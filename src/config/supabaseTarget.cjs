// ADP-305 — which Supabase does THIS app instance talk to?
//
// THE CONSTRAINT THAT SHAPES THIS FILE
// ------------------------------------
// The renderer's Supabase URL/key come from NEXT_PUBLIC_CREWPANE_SUPABASE_*, and
// Next.js INLINES NEXT_PUBLIC_* into the client bundle AT BUILD TIME (verified: the
// anon key is a literal inside .next/static/chunks). So "launch the test app with a
// different SUPABASE_URL env var" does NOT work — the renderer ignores it and keeps
// writing to whatever was baked in. That is why every office spec leaked desks and a
// ghost agent into Eren's live office (ADP-300 / ADP-302 / ADP-305).
//
// The fix therefore needs a RUNTIME channel: main.js resolves the target here and
// hands it to the renderer via BrowserWindow `additionalArguments` → preload →
// window.crewpaneDb → src/lib/supabase.ts, which prefers it over the baked-in env.
//
// RULE: instance 'test' (every e2e run — enforced by e2e/instanceGuard.cjs) → the
// dedicated e2e stack. 'prod'/'dev' → the live stack, exactly as before.

'use strict';

// e2e/supabase-stack/supabase/config.toml
const E2E_URL = 'http://127.0.0.1:55321';

/**
 * Resolve the Supabase target for an instance. Pure — no I/O, no process.env reads
 * beyond the `env` handed in, so it is unit-testable and cannot surprise at runtime.
 *
 * @param {object} env         process.env (or a fixture)
 * @param {string} instanceId  'prod' | 'dev' | 'test'
 * @param {{url?: string, anonKey?: string}} live  the live-stack values main.js already resolved
 * @returns {{url: string, anonKey: string, isE2E: boolean}}
 */
function resolveSupabaseTarget(env, instanceId, live) {
  const e = env || {};
  const liveUrl = live && live.url;
  const liveKey = live && live.anonKey;

  if (instanceId !== 'test') {
    return { url: liveUrl, anonKey: liveKey, isE2E: false };
  }

  const url = e.CREWPANE_E2E_SUPABASE_URL || E2E_URL;
  // ADP-741 — the live key is inherited ONLY while the live stack is itself LOCAL.
  //
  // The old line was `anonKey: <env> || liveKey`, resting on "both local stacks are
  // seeded by the Supabase CLI with the same default key, so the URL is the real
  // discriminator". ADP-723/728 moved the live target to the CLOUD and that assumption
  // died without a sound: a hosted project's JWT is scoped to its own project ref, so
  // 55321 answered 401, the app concluded it was un-provisioned and opened the setup
  // wizard, and 16 e2e specs went RED as if the product were broken (ADP-733 §4.3).
  //
  // The condition is on the STATE of the live target (is it local?), not on which
  // project it happens to be — a different cloud project behaves identically. When the
  // assumption does not hold we report the gap instead of guessing; `keyMissing`
  // carries the reason so main.js can print something actionable.
  const explicit = e.CREWPANE_E2E_SUPABASE_ANON_KEY;
  const inheritable = isLoopbackUrl(liveUrl);
  const anonKey = explicit || (inheritable ? liveKey : undefined);
  const out = { url, anonKey, isE2E: true };
  if (!anonKey) {
    out.keyMissing = explicit === undefined && !inheritable
      ? `canlı hedef (${liveUrl || 'yok'}) YEREL değil — anahtarı devralınamaz; CREWPANE_E2E_SUPABASE_ANON_KEY ver`
      : 'e2e stack anahtarı yok — CREWPANE_E2E_SUPABASE_ANON_KEY ver';
  }
  return out;
}

/** Loopback = a stack on THIS machine (same predicate as electron/backendTarget.cjs). */
function isLoopbackUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '[::1]') return true;
  if (host === '0.0.0.0') return true;
  return /^127\./.test(host);
}

/** The argv flag main.js passes to the renderer (read back in preload.js). */
const ARGV_FLAG = '--crewpane-db=';

function encodeArgv(target) {
  return ARGV_FLAG + Buffer.from(JSON.stringify(target), 'utf8').toString('base64');
}

/** Parse the flag out of a preload's process.argv. Returns null when absent. */
function decodeArgv(argv) {
  const hit = (argv || []).find((a) => typeof a === 'string' && a.startsWith(ARGV_FLAG));
  if (!hit) return null;
  try {
    const json = Buffer.from(hit.slice(ARGV_FLAG.length), 'base64').toString('utf8');
    const t = JSON.parse(json);
    return t && t.url ? t : null;
  } catch {
    return null;
  }
}

module.exports = { resolveSupabaseTarget, encodeArgv, decodeArgv, isLoopbackUrl, ARGV_FLAG, E2E_URL };
