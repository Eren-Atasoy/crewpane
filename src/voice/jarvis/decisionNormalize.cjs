'use strict';

const uiControls = require('../../services/uiControls.cjs');
const { BROWSER_TASK_RE, SCROLL_STEP_DEFAULT, BOARD_STATUSES } = require('./intentPatterns.cjs');

const TERMINAL_OPS = ['kill', 'focus', 'new-shell'];
const BROWSER_OPS = ['open', 'search', 'click', 'type', 'read', 'back', 'forward', 'reload', 'scroll'];
const NAVIGATE_OPS = ['team', 'tab', 'tab-close', 'file', 'surface'];
const INPUT_OPS = ['click', 'type', 'scroll'];
const BOARD_OPS = ['create', 'status', 'assign', 'list'];
const SPRINT_OPS = ['start', 'status'];
const SETTINGS_OPS = uiControls.opsFor('settings');
const MEMORY_OPS = ['what', 'promote'];
const REPORT_OPS = ['open', 'read', 'list'];
const AGENT_OPS = ['last-message'];
const SCREEN_OPS = ['capture', 'window'];
const OFFICE_OPS = ['select', 'say'];

const JARVIS_ACTIONS = [
  'self',
  'delegate', 'tell', 'spawn', 'status', 'reply', 'terminal', 'browser', 'navigate', 'input',
  'board', 'sprint', 'settings', 'memory', 'report', 'agent', 'chain',
  'screen', 'office',
];

/** Trimmed string or null (the brain likes to emit "" / undefined). */
function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Fall back to a spoken question instead of running a half-specified action. */
function reply(department, speak) {
  return { action: 'reply', department, objective: null, op: null, target: null, speak };
}

/** ADP-265 — input sim: x/y (click) · objective (type) · dx/dy (scroll). */
function normalizeInputDecision(d, rawOp, { objective, speak }) {
  if (!INPUT_OPS.includes(rawOp)) return reply(null, speak || 'Fare/klavye komutunu anlayamadım.');
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  if (rawOp === 'click') {
    const x = num(d.x);
    const y = num(d.y);
    if (x === null || y === null) return reply(null, speak || 'Nereye tıklayayım? Koordinat (x, y) söyler misin?');
    return { action: 'input', department: null, objective: null, op: 'click', target: null, x, y, speak };
  }
  if (rawOp === 'type') {
    if (!objective) return reply(null, speak || 'Ne yazayım?');
    return { action: 'input', department: null, objective, op: 'type', target: null, speak };
  }
  return { action: 'input', department: null, objective: null, op: 'scroll', target: null, dx: num(d.dx), dy: num(d.dy), speak };
}

/** ADP-291 — board: create (title) · status (taskId+taskStatus) · assign (taskId+assignee) · list. */
function normalizeBoardDecision(d, rawOp, { department, objective, target, speak }) {
  if (!BOARD_OPS.includes(rawOp)) return reply(department, speak || 'Görev komutunu anlayamadım — görev aç, durum değiştir, ata ya da listele diyebilirsin.');
  const taskId = str(d.taskId) || target;
  const rawStatus = str(d.taskStatus) || str(d.status);
  const taskStatus = rawStatus && BOARD_STATUSES.includes(rawStatus.toLowerCase().replace(/\s+/g, '_'))
    ? rawStatus.toLowerCase().replace(/\s+/g, '_')
    : null;

  if (rawOp === 'create') {
    const title = str(d.title) || objective;
    if (!title) return reply(department, speak || 'Görevin başlığı ne olsun?');
    return { action: 'board', department, objective: null, op: 'create', target: null, title, speak };
  }
  if (rawOp === 'status') {
    if (!taskId) return reply(department, speak || 'Hangi görevin durumunu değiştireyim?');
    if (!taskStatus) return reply(department, speak || 'Hangi duruma alayım? (backlog, todo, in_progress, review, done)');
    return { action: 'board', department, objective: null, op: 'status', target: null, taskId, taskStatus, speak };
  }
  if (rawOp === 'assign') {
    const assignee = str(d.assignee);
    if (!taskId) return reply(department, speak || 'Hangi görevi atayayım?');
    if (!assignee) return reply(department, speak || 'Kime atayayım?');
    return { action: 'board', department, objective: null, op: 'assign', target: null, taskId, assignee, speak };
  }
  return { action: 'board', department, objective: null, op: 'list', target: null, taskStatus, speak };
}

/** Coerce a raw decision-ish object into the strict shape, or null if unusable. */
function normalizeDecision(d) {
  if (!d || typeof d !== 'object') return null;
  let action = String(d.action || '').toLowerCase().trim();
  if (!JARVIS_ACTIONS.includes(action)) {
    const opl = typeof d.op === 'string' ? d.op.toLowerCase().trim().replace(/[\s_]+/g, '-') : '';
    if (Array.isArray(d.steps) && d.steps.length) action = 'chain';
    else if (AGENT_OPS.includes(opl) || opl === 'lastmessage') action = 'agent';
    else if (SCREEN_OPS.includes(opl) || opl === 'screenshot' || opl === 'ekran-goruntusu') action = 'screen';
    else if (OFFICE_OPS.includes(opl) || opl === 'bubble' || opl === 'balon') action = 'office';
    else if (NAVIGATE_OPS.includes(opl) || d.path) action = 'navigate';
    else if (BROWSER_OPS.includes(opl) || d.url || d.query) action = 'browser';
    else if (d.op) action = 'terminal';
    else if (d.objective && typeof d.target === 'string' && d.target.trim()) action = 'tell';
    else if (d.objective) action = 'reply';
    else action = 'reply';
  }
  const department =
    typeof d.department === 'string' && d.department.trim() ? d.department.trim() : null;
  const objective =
    typeof d.objective === 'string' && d.objective.trim() ? d.objective.trim() : null;
  const speak = typeof d.speak === 'string' && d.speak.trim() ? d.speak.trim() : null;
  const rawOp =
    typeof d.op === 'string' && d.op.trim()
      ? d.op.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/^lastmessage$/, 'last-message')
      : null;
  let op = rawOp;
  if (op === 'newshell' || op === 'shell' || op === 'open') op = 'new-shell';
  if (op === 'close' || op === 'kapat') op = 'kill';
  const target =
    typeof d.target === 'string' && d.target.trim() ? d.target.trim() : null;

  if (action === 'terminal') {
    if (!TERMINAL_OPS.includes(op)) {
      return { action: 'reply', department, objective: null, op: null, target: null, speak: speak || 'Terminal komutunu anlayamadım — kapat, odakla ya da yeni terminal aç diyebilirsin.' };
    }
    return { action: 'terminal', department, objective: null, op, target, speak };
  }
  if (action === 'tell') {
    if (!target) {
      return { action: 'reply', department, objective, op: null, target: null, speak: speak || 'Kime ileteyim?' };
    }
    if (!objective) {
      return { action: 'reply', department, objective: null, op: null, target, speak: speak || 'Ne söyleyeyim?' };
    }
    return { action: 'tell', department, objective, op: null, target, speak };
  }
  if (action === 'spawn') {
    const rawCount = Number(d.count);
    const count = Number.isFinite(rawCount) ? Math.max(1, Math.round(rawCount)) : 1;
    const rawEngine = typeof d.engine === 'string' ? d.engine.toLowerCase().trim() : '';
    const engine = rawEngine === 'claude' || rawEngine === 'codex' ? rawEngine : null;
    return { action: 'spawn', department, objective, op: null, target: null, count, engine, speak };
  }
  if (action === 'browser') {
    return normalizeBrowserDecision(d, rawOp, speak);
  }
  if (action === 'navigate') {
    return normalizeNavigateDecision(d, rawOp, { department, target, speak });
  }
  if (action === 'input') {
    return normalizeInputDecision(d, rawOp, { objective, speak });
  }
  if (action === 'board') {
    return normalizeBoardDecision(d, rawOp, { department, objective, target, speak });
  }
  if (action === 'sprint') {
    if (!SPRINT_OPS.includes(rawOp)) return reply(department, speak || 'Sprint komutunu anlayamadım — "sprint başlat" ya da "sprint durumu" diyebilirsin.');
    if (rawOp === 'start' && !objective) return reply(department, speak || 'Sprint hedefi ne olsun?');
    return { action: 'sprint', department, objective, op: rawOp, target: null, speak };
  }
  if (action === 'settings') {
    if (!SETTINGS_OPS.includes(rawOp)) return reply(department, speak || 'Ayar komutunu anlayamadım.');
    if (rawOp === 'theme') {
      const theme = str(d.theme) || target;
      if (!theme) return reply(department, speak || 'Hangi temayı yapayım? (Gece Vardiyası, Derin, Kömür, Fosfor, Kâğıt, Gündüz)');
      return { action: 'settings', department, objective: null, op: 'theme', target: null, theme, speak };
    }
    {
      const control = uiControls.controlByOp('settings', rawOp);
      if (control && control.param.kind === 'enum') {
        const allowed = uiControls.allowedValues(control);
        const spoken = str(d.value) || str(d[control.param.name]) || target;
        const value = allowed.includes(spoken)
          ? spoken
          : uiControls.resolveControlValue(control, String(spoken || ''));
        if (!value) {
          return reply(department, speak || `${control.label} için hangi değer? (${allowed.join(', ')})`);
        }
        return { action: 'settings', department, objective: null, op: rawOp, target: null, value, speak };
      }
    }
    const path = str(d.path);
    if (!path) return reply(department, speak || 'Hangi klasör olsun?');
    return { action: 'settings', department, objective: null, op: 'workspace', target: null, path, speak };
  }
  if (action === 'memory') {
    if (!MEMORY_OPS.includes(rawOp)) return reply(department, speak || 'Hafıza komutunu anlayamadım.');
    if (!target) return reply(department, speak || 'Hangi ajanın hafızası?');
    if (rawOp === 'promote' && !objective) return reply(department, speak || 'Hangi deneyimi kurala çevireyim?');
    return { action: 'memory', department, objective, op: rawOp, target, speak };
  }
  if (action === 'report') {
    if (!REPORT_OPS.includes(rawOp)) return reply(department, speak || 'Rapor komutunu anlayamadım.');
    return { action: 'report', department, objective: null, op: rawOp, target: null, taskId: str(d.taskId) || target, speak };
  }
  if (action === 'agent') {
    if (!AGENT_OPS.includes(rawOp)) {
      return reply(department, speak || 'Ajan komutunu anlayamadım — "X\'in son mesajını oku" diyebilirsin.');
    }
    if (!target) return reply(department, speak || 'Kimin son mesajını okuyayım?');
    return { action: 'agent', department, objective: null, op: 'last-message', target, speak };
  }
  if (action === 'screen') {
    const op = SCREEN_OPS.includes(rawOp) ? rawOp : 'capture';
    return { action: 'screen', department, objective, op, target, speak };
  }
  if (action === 'office') {
    let op = rawOp;
    if (op === 'focus' || op === 'odakla' || op === 'click' || op === 'tıkla' || op === 'tikla') op = 'select';
    if (op === 'bubble' || op === 'balon' || op === 'speak' || op === 'söyle' || op === 'soyle' || op === 'talk') op = 'say';
    if (!OFFICE_OPS.includes(op)) op = objective ? 'say' : 'select';
    if (!target) return reply(department, speak || 'Ofiste kime bakayım?');
    if (op === 'say' && !objective) return reply(department, speak || 'Baloncukta ne yazsın?');
    return { action: 'office', department, objective: op === 'say' ? objective : null, op, target, speak };
  }
  if (action === 'self') {
    const raw = Array.isArray(d.steps) ? d.steps : [];
    const steps = raw
      .map((s) => normalizeDecision(s))
      .filter((s) => s && s.action !== 'chain' && s.action !== 'self' && s.action !== 'reply' && s.action !== 'delegate');
    if (!steps.length) {
      return {
        action: 'reply',
        department,
        objective,
        op: null,
        target: null,
        executor: 'self',
        speak: speak || 'Bunu kendi araçlarımla yapamıyorum (kod/dosya yazımı gerekiyor). Tek ajana vereyim mi?',
      };
    }
    if (steps.length === 1) {
      return { ...steps[0], executor: 'self', speak: speak || steps[0].speak };
    }
    return { action: 'self', department, objective, op: null, target: null, steps, executor: 'self', speak };
  }
  if (action === 'chain') {
    const raw = Array.isArray(d.steps) ? d.steps : [];
    const steps = raw
      .map((s) => normalizeDecision(s))
      .filter((s) => s && s.action !== 'chain' && s.action !== 'reply');
    if (!steps.length) return reply(department, speak || 'Planı anlayamadım — adımları tek tek söyler misin?');
    return { action: 'chain', department, objective, op: null, target: null, steps, speak };
  }
  if (action === 'delegate' && !objective) {
    return { action: 'reply', department, objective: null, op: null, target: null, speak: speak || 'Görevi anlayamadım, tekrar eder misin?' };
  }
  if (action === 'delegate') {
    const browserTask = d.browserTask === true || d.browserTask === 'true' || BROWSER_TASK_RE.test(String(objective));
    return { action, department, objective, browserTask, op: null, target: null, speak };
  }
  return { action, department, objective, op: null, target: null, speak };
}

/** ADP-135 — normalize a browser decision (op synonyms + url/query/selector). */
function normalizeBrowserDecision(d, rawOp, speak) {
  let op = rawOp;
  if (op === 'navigate' || op === 'goto' || op === 'go-to' || op === 'visit' || op === 'open-url' || op === 'git' || op === 'aç') op = 'open';
  if (op === 'find' || op === 'google' || op === 'ara') op = 'search';
  if (op === 'readpage' || op === 'read-page' || op === 'summarize' || op === 'oku' || op === 'özetle' || op === 'ozetle') op = 'read';
  if (op === 'goback' || op === 'go-back' || op === 'geri') op = 'back';
  if (op === 'goforward' || op === 'go-forward' || op === 'ileri' || op === 'next') op = 'forward';
  if (op === 'refresh' || op === 'yenile' || op === 'tazele') op = 'reload';
  if (op === 'kaydır' || op === 'kaydir' || op === 'scroll-to' || op === 'scrollto') op = 'scroll';
  if (op === 'yaz' || op === 'fill' || op === 'input' || op === 'doldur') op = 'type';
  const url = typeof d.url === 'string' && d.url.trim() ? d.url.trim() : null;
  const query = typeof d.query === 'string' && d.query.trim() ? d.query.trim() : null;
  const selector = typeof d.selector === 'string' && d.selector.trim() ? d.selector.trim() : null;
  const objective = typeof d.objective === 'string' && d.objective.trim() ? d.objective.trim() : null;
  const findText = typeof d.findText === 'string' && d.findText.trim() ? d.findText.trim() : null;
  const scrollTo = d.scrollTo === 'top' || d.scrollTo === 'bottom' ? d.scrollTo : null;
  const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
  const dy = num(d.dy);
  const dx = num(d.dx);
  if (!BROWSER_OPS.includes(op)) {
    op = url ? 'open' : query ? 'search' : scrollTo || dy != null ? 'scroll' : selector || findText ? 'click' : 'read';
  }
  if (op === 'open' && !url && query) op = 'search';
  if (op === 'search' && !query && url) op = 'open';
  const replyMsg = (msg) => ({ action: 'reply', department: null, objective: null, op: null, target: null, speak: speak || msg });
  if (op === 'open' && !url) return replyMsg('Hangi siteyi açayım?');
  if (op === 'search' && !query) return replyMsg('Ne aramamı istersin?');
  if (op === 'click' && !selector && !findText) return replyMsg('Sayfada neye tıklayayım?');
  if (op === 'type' && !objective) return replyMsg('Ne yazmamı istiyorsun?');
  return {
    action: 'browser', department: null,
    objective: op === 'type' ? objective : null,
    op, target: null, url, query, selector, findText,
    ...(op === 'scroll' ? { scrollTo, dy: dy != null ? dy : scrollTo ? null : SCROLL_STEP_DEFAULT, dx } : {}),
    speak,
  };
}

/**
 * ADP-263 — normalize a navigate decision (op synonyms + required-field checks).
 */
function normalizeNavigateDecision(d, rawOp, { department, target, speak }) {
  let op = rawOp;
  if (op === 'takım' || op === 'takim' || op === 'wing' || op === 'kanat' || op === 'switch-team' || op === 'switchteam') op = 'team';
  if (op === 'sekme' || op === 'view' || op === 'open-tab' || op === 'opentab') op = 'tab';
  if (op === 'sekme-kapat' || op === 'close-tab' || op === 'closetab' || op === 'tab-kapat' || op === 'tabclose') op = 'tab-close';
  if (op === 'dosya' || op === 'open-file' || op === 'openfile' || op === 'edit') op = 'file';
  const path = typeof d.path === 'string' && d.path.trim() ? d.path.trim() : null;
  if (!NAVIGATE_OPS.includes(op)) {
    op = path ? 'file' : department && !target ? 'team' : target ? 'tab' : null;
  }
  const replyMsg = (msg) => ({ action: 'reply', department, objective: null, op: null, target: null, speak: speak || msg });
  if (op === 'team' && !department && !target) return replyMsg('Hangi takıma geçeyim?');
  if ((op === 'tab' || op === 'tab-close') && !target) return replyMsg('Hangi sekmeyi açayım?');
  if (op === 'file' && !path) return replyMsg('Hangi dosyayı açayım?');
  if (op === 'surface' && !target) return replyMsg('Hangi ekranı açayım?');
  if (!op) return replyMsg('Nereye gideyim, anlayamadım.');
  return { action: 'navigate', department, objective: null, op, target, path, speak };
}

module.exports = {
  TERMINAL_OPS,
  BROWSER_OPS,
  NAVIGATE_OPS,
  INPUT_OPS,
  BOARD_OPS,
  SPRINT_OPS,
  SETTINGS_OPS,
  MEMORY_OPS,
  REPORT_OPS,
  AGENT_OPS,
  SCREEN_OPS,
  OFFICE_OPS,
  BOARD_STATUSES,
  JARVIS_ACTIONS,
  str,
  reply,
  normalizeInputDecision,
  normalizeBoardDecision,
  normalizeDecision,
  normalizeBrowserDecision,
  normalizeNavigateDecision,
};
