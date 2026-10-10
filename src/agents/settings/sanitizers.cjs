// CrewPane — Agent Settings sanitizers and normalizers.
'use strict';

const browserTrust = require('../../security/browserTrust.cjs');
const teamCompose = require('../teamCompose.cjs');
const appI18n = require('../../../i18n/index.cjs');
const {
  THEME_MODES,
  THEME_ACCENT_RE,
  THEME_PRESET_RE,
  TERMINAL_FONT_SCALES,
  MAX_TRUST_RULES,
  MAX_TRUST_RULE_LEN,
  MAX_READ_ENTRIES,
  VENDOR_HOSTED_POLICIES,
} = require('./constants.cjs');

function sanitizeDepartmentDirs(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k === 'string' && k.trim() && typeof v === 'string' && v.trim()) {
      out[k.trim().toLowerCase()] = v.trim();
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function sanitizeProjectIsolation(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k !== 'string' || !k.trim()) continue;
    if (v !== 'worktree' && v !== 'off') continue;
    out[k.trim().toLowerCase()] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function sanitizeTheme(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!THEME_MODES.includes(raw.mode)) return null;
  const accent =
    typeof raw.accent === 'string' && THEME_ACCENT_RE.test(raw.accent) ? raw.accent.toLowerCase() : null;
  const preset =
    typeof raw.preset === 'string' && THEME_PRESET_RE.test(raw.preset) ? raw.preset : null;
  return { mode: raw.mode, accent, preset };
}

function sanitizeTerminalFontScale(raw) {
  return typeof raw === 'string' && TERMINAL_FONT_SCALES.includes(raw) ? raw : 'medium';
}

function sanitizeLocale(raw) {
  return appI18n.isLocalePreference(raw) ? raw : appI18n.DEFAULT_LOCALE_PREFERENCE;
}

function sanitizeVoiceLocale(raw) {
  return appI18n.isVoiceLocalePreference(raw) ? raw : appI18n.DEFAULT_VOICE_LOCALE_PREFERENCE;
}

function sanitizePaneMoveShortcut(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (s.length === 0 || s.length > 32) return null;
  if (!/^(Meta|Ctrl|Alt)(\+(Meta|Ctrl|Alt))*$/.test(s)) return null;
  const parts = s.split('+');
  if (new Set(parts).size !== parts.length) return null;
  return s;
}

function sanitizePaneZoomShortcut(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (s.length === 0 || s.length > 64) return null;
  if (!/^((Meta|Ctrl|Alt|Shift)\+)+[A-Za-z0-9]{1,32}$/.test(s)) return null;
  if (!/(Meta|Ctrl|Alt)\+/.test(s)) return null;
  return s;
}

function sanitizeBrowserTrust(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const n = browserTrust.normalizeSettings({ browserTrust: src });
  const clean = (list) => {
    const out = [];
    for (const v of list) {
      const s = String(v).trim().toLowerCase().slice(0, MAX_TRUST_RULE_LEN);
      if (s && !out.includes(s) && out.length < MAX_TRUST_RULES) out.push(s);
    }
    return out;
  };
  return { mode: n.mode, trustedOrigins: clean(n.trustedOrigins), blockedOrigins: clean(n.blockedOrigins) };
}

function sanitizeTeamCompose(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return { autonomy: teamCompose.sanitizeAutonomy(src.autonomy) };
}

function sanitizeMemorySearch(raw) {
  const out = { semanticConsent: null, semanticEnabled: true, autoIndex: true, sessionsIndexed: true };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (typeof raw.semanticEnabled === 'boolean') out.semanticEnabled = raw.semanticEnabled;
  if (typeof raw.autoIndex === 'boolean') out.autoIndex = raw.autoIndex;
  if (typeof raw.sessionsIndexed === 'boolean') out.sessionsIndexed = raw.sessionsIndexed;
  const c = raw.semanticConsent;
  if (c && typeof c === 'object' && !Array.isArray(c) && typeof c.granted === 'boolean') {
    out.semanticConsent = {
      granted: c.granted,
      key: typeof c.key === 'string' ? c.key : '',
      at: Number.isFinite(c.at) ? c.at : null,
    };
  }
  return out;
}

function sanitizeEngines(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, row] of Object.entries(raw)) {
    if (!id || !row || typeof row !== 'object' || Array.isArray(row)) continue;
    if (VENDOR_HOSTED_POLICIES.includes(row.vendorHosted)) out[id] = { vendorHosted: row.vendorHosted };
  }
  return out;
}

function mergeEngines(cur, patch) {
  const out = {};
  for (const src of [cur, patch]) {
    if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
    for (const [id, row] of Object.entries(src)) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      out[id] = { ...(out[id] || {}), ...row };
    }
  }
  return out;
}

function sanitizeResourceGovernor(raw) {
  const out = { enabled: false, warnFreePct: 1, criticalFreePct: 0 };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
  const pct = (v, fallback) => (Number.isFinite(v) && v >= 0 && v <= 100 ? v : fallback);
  out.warnFreePct = pct(Number(raw.warnFreePct), out.warnFreePct);
  out.criticalFreePct = pct(Number(raw.criticalFreePct), out.criticalFreePct);
  if (out.criticalFreePct > out.warnFreePct) out.criticalFreePct = out.warnFreePct;
  return out;
}

function sanitizeAnnouncementsRead(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k !== 'string' || !/^[a-z0-9._-]{1,80}$/.test(k)) continue;
    if (!Number.isFinite(v) || v <= 0) continue;
    out[k] = v;
    if (Object.keys(out).length >= MAX_READ_ENTRIES) break;
  }
  return out;
}

function sanitizeTelemetryState(raw) {
  const base = { installId: null, sessions: 0, daysSeen: 0, lastDay: null, counters: {}, milestones: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  if (Array.isArray(raw.milestones)) {
    for (const m of raw.milestones) {
      if (typeof m === 'string' && /^[a-z0-9_:]{1,40}$/.test(m) && !base.milestones.includes(m)) {
        base.milestones.push(m);
      }
      if (base.milestones.length >= 40) break;
    }
  }
  if (raw.counters && typeof raw.counters === 'object' && !Array.isArray(raw.counters)) {
    const allowed = ['panes_opened', 'agents_spawned', 'tasks_created', 'delegations', 'memory_writes', 'voice_seconds'];
    for (const k of allowed) {
      const v = Number(raw.counters[k]);
      if (Number.isFinite(v) && v > 0) base.counters[k] = Math.min(Math.floor(v), 1e9);
    }
  }
  if (typeof raw.installId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw.installId)) {
    base.installId = raw.installId.toLowerCase();
  }
  for (const k of ['sessions', 'daysSeen']) {
    const v = Number(raw[k]);
    if (Number.isFinite(v) && v > 0) base[k] = Math.min(Math.floor(v), 1e7);
  }
  if (typeof raw.lastDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.lastDay)) base.lastDay = raw.lastDay;
  return base;
}

function sanitizeJev(raw) {
  const base = { mode: 'suggest', policy: 'balanced' };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const mode = ['off', 'suggest', 'auto'].includes(raw.mode) ? raw.mode : base.mode;
  const policy = ['frugal', 'balanced', 'quality'].includes(raw.policy) ? raw.policy : base.policy;
  return { mode, policy };
}

module.exports = {
  sanitizeDepartmentDirs,
  sanitizeProjectIsolation,
  sanitizeTheme,
  sanitizeTerminalFontScale,
  sanitizeLocale,
  sanitizeVoiceLocale,
  sanitizePaneMoveShortcut,
  sanitizePaneZoomShortcut,
  sanitizeBrowserTrust,
  sanitizeTeamCompose,
  sanitizeMemorySearch,
  sanitizeEngines,
  mergeEngines,
  sanitizeResourceGovernor,
  sanitizeAnnouncementsRead,
  sanitizeTelemetryState,
  sanitizeJev,
};
