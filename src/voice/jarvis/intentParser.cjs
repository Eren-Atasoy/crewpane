'use strict';

const fanoutPolicy = require('../../agents/fanoutPolicy.cjs');
const spawnSpec = require('../../agents/spawnSpec.cjs');
const morph = require('../turkishMorph.cjs');
const entityResolve = require('../../services/entityResolve.cjs');
const uiSurfaces = require('../../services/uiSurfaces.cjs');
const uiControls = require('../../services/uiControls.cjs');

const {
  hasV,
  negV,
  STATUS_RE,
  DELEGATE_RE,
  THEME_RE,
  THEME_CHANGE_CUE_RE,
  THEME_NEG_RE,
  THEME_BASE_PRESET,
  detectThemeBase,
  SPRINT_START_RE,
  SPRINT_STATUS_RE,
  BOARD_NEW_RE,
  BOARD_LIST_RE,
  BOARD_STATUS_RE,
  REPORT_RE,
  MEMORY_WHAT_RE,
  MEMORY_PROMOTE_RE,
  AGENT_LAST_RE,
  TASK_ID_RE,
  TERMINAL_RE,
  TERM_FOCUS_RE,
  ALL_RE,
  BROWSER_BACK_RE,
  BROWSER_CLICK_RE,
  BROWSER_READ_RE,
  BROWSER_SEARCH_RE,
  BROWSER_OPEN_RE,
  BROWSER_CUE_RE,
  BROWSER_TASK_RE,
  HOST_RE,
  SCROLL_CUE_RE,
  SCROLL_TOP_RE,
  SCROLL_END_RE,
  SCROLL_START_RE,
  SCROLL_SMALL_RE,
  SCROLL_BIG_RE,
  SCROLL_STEP_DEFAULT,
  SCROLL_STEP_SMALL,
  SCROLL_STEP_BIG,
  EN_SCROLL_CUE_RE,
  EN_SCROLL_DOWN_RE,
  EN_SCROLL_UP_RE,
  EN_SCROLL_BOTTOM_RE,
  EN_SCROLL_TOP_RE,
  EN_SCROLL_SMALL_RE,
  EN_SCROLL_BIG_RE,
  EN_NEG_RE,
  EN_BARE_SCROLL_RE,
  isStoppedScroll,
  CLICK_BY_TEXT_RE,
  TYPE_INTO_RE,
  TYPE_PLAIN_RE,
  HEADINGS_RE,
  HEADINGS_SELECTOR,
  BROWSER_FORWARD_RE,
  BROWSER_RELOAD_RE,
  SCREEN_NOUN_RE,
  detectAgentName,
  normalizeBoardStatusWord,
  detectDepartment,
  departmentLabel,
} = require('./intentPatterns.cjs');

/**
 * Deterministic Turkish intent parser — the brain fallback (and a fast path for
 * tests). Pure; mirrors the claude decision shape.
 */
function parseIntent(transcript, context = {}) {
  const t = String(transcript || '').trim();
  const low = t.toLocaleLowerCase('tr');
  const toks = morph.tokens(low);
  const isStatus = STATUS_RE.test(low) || hasV(toks, 'summarize');
  const directive = fanoutPolicy.detectDirective(t);
  const isDelegate =
    (DELEGATE_RE.test(low) || directive === 'single' || directive === 'team') &&
    directive !== 'self' &&
    !negV(toks, 'delegateVerb');
  const mentionsTerminal = TERMINAL_RE.test(low);

  if (mentionsTerminal && hasV(toks, 'close')) {
    const all = ALL_RE.test(low);
    const target = all ? 'all' : detectDepartment(low, context) || null;
    const speak = null;
    return {
      action: 'terminal',
      department: target && target !== 'all' ? target : null,
      objective: null,
      op: 'kill',
      target,
      speak,
    };
  }

  const spawnParsed = spawnSpec.parseSpawnBatches(t);
  const namedEngine = /\b(claude|klod|codex|kodeks)\b/i.test(low);
  const spawnWorthy = spawnParsed.total >= 2 || (spawnParsed.batches.length > 0 && namedEngine);
  if (
    spawnParsed.batches.length > 0 &&
    spawnWorthy &&
    (spawnParsed.explicit || mentionsTerminal) &&
    hasV(toks, 'open') &&
    !/(görev|gorev|prompt|şu işi|su isi|şunu yap|sunu yap|delege)/.test(low)
  ) {
    return {
      action: 'spawn',
      department: detectDepartment(low, context) || null,
      objective: null,
      op: null,
      target: null,
      count: spawnParsed.total,
      engine: spawnParsed.batches.length === 1 ? spawnParsed.batches[0].engine : null,
      batches: spawnParsed.batches,
      explicitCount: spawnParsed.explicit,
      speak: null,
    };
  }

  {
    const tabIdx = toks.findIndex((tok) => morph.hasNoun([tok], ['sekme', 'panel', 'tab']));
    if (tabIdx > 0) {
      const target = toks[tabIdx - 1];
      if (hasV(toks, 'close')) {
        return { action: 'navigate', department: null, objective: null, op: 'tab-close', target, path: null, speak: null };
      }
      if (hasV(toks, 'open') || hasV(toks, 'goto') || hasV(toks, 'show')) {
        return { action: 'navigate', department: null, objective: null, op: 'tab', target, path: null, speak: null };
      }
    }
  }

  {
    const hit = uiControls.resolveControl(toks);
    const value = hit ? uiControls.resolveControlValue(hit.control, toks) : null;
    const changed = /(yap|değiştir|degistir|çevir|cevir|geç|gec\b|olsun|al\b|ayarla)/.test(low);
    const negated = negV(toks, 'mark') || /(değiştirme|degistirme|yapma|çevirme|cevirme)/.test(low);
    if (hit && value && changed && !negated) {
      return {
        action: hit.control.action,
        department: null,
        objective: null,
        op: hit.control.op,
        target: null,
        value,
        speak: null,
      };
    }
  }
  if (THEME_RE.test(low) && THEME_CHANGE_CUE_RE.test(low)) {
    const themeNegated = negV(toks, 'mark') || negV(toks, 'open') || negV(toks, 'change') || THEME_NEG_RE.test(low);
    const m = low.match(/(gece ?vardiyas[ıi]|derin|k[öo]m[üu]r|fosfor|k[âa][ğg][ıi]t|g[üu]nd[üu]z|sentetik ?gece|sonar|amber ?konsol|sepya|sera|bulut|grafit|obsidyen|espresso|duman|bordo|orman|beton|lavanta|kutup|f[ıi]st[ıi]k|yosun|pastel|g[üu]lkurusu|at[öo]lye|kumsal|sedef)/);
    if (m && !themeNegated) {
      const spoken = m[1].replace(/\s+/g, '-');
      const theme = /^gece-?vardiyas/.test(spoken) ? 'gece-vardiyasi'
        : /^k[öo]m[üu]r$/.test(spoken) ? 'komur'
        : /^k[âa][ğg][ıi]t$/.test(spoken) ? 'kagit'
        : /^g[üu]nd[üu]z$/.test(spoken) ? 'gunduz'
        : /^f[ıi]st[ıi]k$/.test(spoken) ? 'fistik'
        : /^g[üu]lkurusu$/.test(spoken) ? 'gulkurusu'
        : /^at[öo]lye$/.test(spoken) ? 'atolye'
        : spoken;
      return { action: 'settings', department: null, objective: null, op: 'theme', target: null, theme, speak: null };
    }
    if (!m && !themeNegated) {
      const base = detectThemeBase(low, t.toLowerCase());
      if (base) {
        return { action: 'settings', department: null, objective: null, op: 'theme', target: null, theme: THEME_BASE_PRESET[base], speak: null };
      }
    }
  }
  if (SPRINT_STATUS_RE.test(low)) {
    return { action: 'sprint', department: null, objective: null, op: 'status', target: null, speak: null };
  }
  if (SPRINT_START_RE.test(low) && hasV(toks, 'open')) {
    const objective = t.replace(/^[^]*?sprint\s*(başlat|baslat|aç|ac|start)\s*:?\s*/i, '').trim();
    if (objective) {
      return { action: 'sprint', department: detectDepartment(low, context) || null, objective, op: 'start', target: null, speak: null };
    }
  }
  if (MEMORY_PROMOTE_RE.test(low)) {
    const who = detectAgentName(low, context);
    const text = t.replace(/^[^]*?(kurala (yükselt|yukselt|çevir|cevir)|kural(a| olarak) (ekle|kaydet)|terfi et)\s*:?\s*/i, '').trim();
    if (who && text) {
      return { action: 'memory', department: null, objective: text, op: 'promote', target: who, speak: null };
    }
  }
  if (MEMORY_WHAT_RE.test(low)) {
    const who = detectAgentName(low, context);
    if (who) return { action: 'memory', department: null, objective: null, op: 'what', target: who, speak: null };
  }
  if (AGENT_LAST_RE.test(low)) {
    const who = detectAgentName(low, context);
    if (who) {
      return { action: 'agent', department: null, objective: null, op: 'last-message', target: who, speak: null };
    }
  }
  if (REPORT_RE.test(low)) {
    const taskId = entityResolve.parseTaskRef(t, { allowBare: true });
    if (hasV(toks, 'list')) {
      return { action: 'report', department: null, objective: null, op: 'list', target: null, taskId: null, speak: null };
    }
    if (hasV(toks, 'open') || hasV(toks, 'show') || /editör/.test(low)) {
      return { action: 'report', department: null, objective: null, op: 'open', target: null, taskId, speak: null };
    }
    if (hasV(toks, 'read') || /(özet\b|ne diyor)/.test(low)) {
      return { action: 'report', department: null, objective: null, op: 'read', target: null, taskId, speak: null };
    }
  }
  if (BOARD_LIST_RE.test(low) && (hasV(toks, 'list') || hasV(toks, 'show') || /(ne var|neler var|liste\b)/.test(low))) {
    const sm = low.match(BOARD_STATUS_RE);
    const taskStatus = sm ? normalizeBoardStatusWord(sm[1]) : null;
    return { action: 'board', department: null, objective: null, op: 'list', target: null, taskStatus, speak: null };
  }
  {
    const idm = t.match(TASK_ID_RE);
    if (idm) {
      const taskId = idm[1].toUpperCase();
      const who = detectAgentName(low, context);
      if (/(ata\b|ataya|atayalım|ver\b|devret)/.test(low) && hasV(toks, 'giveVerb') && who) {
        return { action: 'board', department: null, objective: null, op: 'assign', target: null, taskId, assignee: who, speak: null };
      }
      const sm = low.match(BOARD_STATUS_RE);
      if (sm && /(yap|al\b|geç|gec\b|taşı|tasi|işaretle|isaretle)/.test(low) && (hasV(toks, 'mark') || /\bal\b/.test(low))) {
        const taskStatus = normalizeBoardStatusWord(sm[1]);
        if (taskStatus) {
          return { action: 'board', department: null, objective: null, op: 'status', target: null, taskId, taskStatus, speak: null };
        }
      }
    }
  }
  if (BOARD_NEW_RE.test(low) && !mentionsTerminal && (hasV(toks, 'open') || hasV(toks, 'create'))) {
    const title = t.replace(/^[^]*?(görev|gorev|task)\s*(aç|ac|oluştur|olustur|ekle)\s*:?\s*/i, '').trim();
    if (title) {
      return { action: 'board', department: detectDepartment(low, context) || null, objective: null, op: 'create', target: null, title, speak: null };
    }
  }

  if (mentionsTerminal && hasV(toks, 'open') && !negV(toks, 'open')) {
    return { action: 'terminal', department: null, objective: null, op: 'new-shell', target: null, speak: null };
  }
  if (mentionsTerminal && TERM_FOCUS_RE.test(low) && (hasV(toks, 'focus') || hasV(toks, 'show') || /öne (al|getir)/.test(low))) {
    const target = detectDepartment(low, context) || null;
    return { action: 'terminal', department: target, objective: null, op: 'focus', target, speak: null };
  }

  const hostMatch = t.match(HOST_RE);
  const wantsBack = BROWSER_BACK_RE.test(low) && (hasV(toks, 'goto') || /önceki sayfa/.test(low));
  const wantsClick =
    BROWSER_CLICK_RE.test(low) && hasV(toks, 'click') && /(bağlant|link|buton|düğme|sonuç|sonuc|["'“”])/.test(low);
  const wantsRead = BROWSER_READ_RE.test(low) && hasV(toks, 'read');
  const wantsSearch = BROWSER_SEARCH_RE.test(low) && !isDelegate;
  const wantsOpen = !!hostMatch && (BROWSER_OPEN_RE.test(low) || BROWSER_CUE_RE.test(low)) && !isDelegate;

  if (wantsBack) {
    return { action: 'browser', department: null, objective: null, op: 'back', target: null, url: null, query: null, selector: null, speak: null };
  }
  if (wantsClick) {
    let selector = null;
    const quoted = t.match(/["'“”]([^"'“”]{1,80})["'“”]/);
    if (/(ilk|birinci|baştaki|ilkine|birincisine)/.test(low) && /(bağlant|link|sonuç|sonuc)/.test(low)) selector = 'a';
    else if (quoted) selector = quoted[1].trim();
    else if (/(buton|düğme|button)/.test(low)) selector = 'button';
    else if (/(bağlant|link)/.test(low)) selector = 'a';
    if (selector) {
      return { action: 'browser', department: null, objective: null, op: 'click', target: null, url: null, query: null, selector, speak: null };
    }
  }
  if (wantsRead) {
    return { action: 'browser', department: null, objective: null, op: 'read', target: null, url: null, query: null, selector: null, speak: null };
  }
  if (wantsSearch) {
    const query = t
      .replace(/\b(internette|internetten|web['’]?de|web['’]?den|google['’]?(?:da|de|den)?|tarayıcıda|sitede)\b/gi, ' ')
      .replace(/\bdiye\b/gi, ' ')
      .replace(/\b(arasana|aratır mısın|arar mısın|arama yap|aratt?[ıi]r|arat|ara)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (query) {
      return { action: 'browser', department: null, objective: null, op: 'search', target: null, url: null, query, selector: null, speak: null };
    }
  }
  if (wantsOpen && hostMatch) {
    const url = hostMatch[1];
    return { action: 'browser', department: null, objective: null, op: 'open', target: null, url, query: null, selector: null, speak: null };
  }

  {
    if (
      !isDelegate && SCROLL_CUE_RE.test(low) &&
      !negV(toks, 'scroll') && !negV(toks, 'move') && !negV(toks, 'goto') &&
      !isStoppedScroll(low, toks)
    ) {
      const to = SCROLL_END_RE.test(low) ? 'bottom' : SCROLL_START_RE.test(low) ? 'top' : null;
      const step = SCROLL_SMALL_RE.test(low) ? SCROLL_STEP_SMALL : SCROLL_BIG_RE.test(low) ? SCROLL_STEP_BIG : SCROLL_STEP_DEFAULT;
      const up = !to && SCROLL_TOP_RE.test(low);
      return {
        action: 'browser', department: null, objective: null, op: 'scroll', target: null,
        url: null, query: null, selector: null,
        scrollTo: to, dy: to ? null : up ? -step : step, speak: null,
      };
    }
    const lowEn = t.toLowerCase();
    const enQualified =
      EN_SCROLL_DOWN_RE.test(lowEn) || EN_SCROLL_UP_RE.test(lowEn) ||
      EN_SCROLL_BOTTOM_RE.test(lowEn) || EN_SCROLL_TOP_RE.test(lowEn) ||
      EN_SCROLL_SMALL_RE.test(lowEn) || EN_SCROLL_BIG_RE.test(lowEn) ||
      EN_BARE_SCROLL_RE.test(t.trim());
    if (!isDelegate && EN_SCROLL_CUE_RE.test(lowEn) && !EN_NEG_RE.test(lowEn) && enQualified) {
      const to = EN_SCROLL_BOTTOM_RE.test(lowEn) ? 'bottom' : EN_SCROLL_TOP_RE.test(lowEn) ? 'top' : null;
      const step = EN_SCROLL_SMALL_RE.test(lowEn)
        ? SCROLL_STEP_SMALL
        : EN_SCROLL_BIG_RE.test(lowEn)
          ? SCROLL_STEP_BIG
          : SCROLL_STEP_DEFAULT;
      const up = !to && EN_SCROLL_UP_RE.test(lowEn) && !EN_SCROLL_DOWN_RE.test(lowEn);
      return {
        action: 'browser', department: null, objective: null, op: 'scroll', target: null,
        url: null, query: null, selector: null,
        scrollTo: to, dy: to ? null : up ? -step : step, speak: null,
      };
    }
    if (!isDelegate && BROWSER_FORWARD_RE.test(low) && (hasV(toks, 'goto') || /ileri/.test(low)) && !negV(toks, 'goto')) {
      return { action: 'browser', department: null, objective: null, op: 'forward', target: null, url: null, query: null, selector: null, speak: null };
    }
    if (!isDelegate && BROWSER_RELOAD_RE.test(low) && hasV(toks, 'reload') && BROWSER_CUE_RE.test(low)) {
      return { action: 'browser', department: null, objective: null, op: 'reload', target: null, url: null, query: null, selector: null, speak: null };
    }
    if (
      HEADINGS_RE.test(low) &&
      (hasV(toks, 'read') || hasV(toks, 'tellVerb') || hasV(toks, 'list')) &&
      !detectAgentName(low, context) &&
      !detectDepartment(low, context)
    ) {
      return {
        action: 'browser', department: null, objective: null, op: 'read', target: null,
        url: null, query: null, selector: HEADINGS_SELECTOR, speak: null,
      };
    }
    if (!isDelegate && (hasV(toks, 'click') || hasV(toks, 'press')) && !negV(toks, 'click') && !negV(toks, 'press')) {
      const m = t.match(CLICK_BY_TEXT_RE);
      const findText = m ? m[1].trim().toLocaleLowerCase('tr') : null;
      if (findText && findText.length >= 2) {
        return {
          action: 'browser', department: null, objective: null, op: 'click', target: null,
          url: null, query: null, selector: null, findText, speak: null,
        };
      }
    }
    if (!isDelegate && hasV(toks, 'write') && !negV(toks, 'write')) {
      const into = t.match(TYPE_INTO_RE);
      if (into) {
        return {
          action: 'browser', department: null, objective: into[2].trim(), op: 'type', target: null,
          url: null, query: null, selector: null, findText: into[1].trim().toLocaleLowerCase('tr'), speak: null,
        };
      }
      const plain = BROWSER_CUE_RE.test(low) ? t.match(TYPE_PLAIN_RE) : null;
      if (plain && plain[1].trim()) {
        return {
          action: 'browser', department: null, objective: plain[1].trim(), op: 'type', target: null,
          url: null, query: null, selector: null, findText: null, speak: null,
        };
      }
    }
  }

  {
    const opensSurface = hasV(toks, 'open') || hasV(toks, 'show') || hasV(toks, 'goto');
    const negatedOpen = negV(toks, 'open') || negV(toks, 'show') || negV(toks, 'goto');
    const hit = uiSurfaces.resolveSurface(toks);
    if (hit && !negatedOpen && (opensSurface || (hit.surface.selfActuating && hasV(toks, 'create')))) {
      return {
        action: 'navigate', department: null, objective: null, op: 'surface',
        target: hit.surface.id, path: null, speak: null,
      };
    }
    if (!hit && opensSurface && SCREEN_NOUN_RE.test(low) && !isDelegate && !mentionsTerminal) {
      const words = toks.filter((tk) => tk.length > 3 && !SCREEN_NOUN_RE.test(tk));
      const unknown = words.length ? words[0] : null;
      if (unknown) {
        const near = uiSurfaces.suggestSurface(toks);
        return {
          action: 'reply', department: null, objective: null, op: null, target: null,
          unknownSurface: unknown,
          speak: near
            ? `Öyle bir ekran bulamadım. "${near.label}" ekranını mı demek istedin?`
            : 'Öyle bir ekran bulamadım.',
        };
      }
    }
  }

  if (isStatus && !isDelegate) {
    return { action: 'status', department: detectDepartment(low, context), objective: null, op: null, target: null, speak: null };
  }

  const isQuestion =
    /\?\s*$/.test(t) && /(^|\s)(ne|kim|kime|kimin|hangi|neden|niye|nasıl|nasil|nerede|kaç|kac)(\s|\?|$)/.test(low);
  const wantsHandoff = isDelegate || hasV(toks, 'tellVerb') || hasV(toks, 'giveVerb');
  if (wantsHandoff && !isQuestion && directive !== 'self') {
    const deptHint = detectDepartment(low, context);
    const teamDative = /(takım|takim|ekib?|ekip)[ıiu]?n?[ae]\b/.test(low);
    if (!(teamDative && deptHint)) {
      const who = entityResolve.resolveAgent(t, context);
      if (who.id) {
        return {
          action: 'tell',
          department: who.department || deptHint || context.defaultDepartment || null,
          objective: t,
          op: null,
          target: who.id,
          executor: 'single',
          resolvedVia: who.via,
          speak: null,
        };
      }
      if (who.unresolvedName) {
        return {
          action: 'reply', department: null, objective: t, op: null, target: null,
          unresolvedTarget: who.unresolvedName,
          speak: `"${who.unresolvedName}" adında bir ajan bulamadım. Kimi kastettin?`,
        };
      }
      if (who.unresolvedRole) {
        return {
          action: 'reply', department: null, objective: t, op: null, target: null,
          unresolvedRole: who.unresolvedRole,
          speak: `Ekipte bu rolde bir ajan yok. Kime vereyim?`,
        };
      }
    }
  }

  if (isDelegate) {
    const department = detectDepartment(low, context) || context.defaultDepartment || null;
    const speak = department
      ? `Tamam, ${departmentLabel(department, context)} takımına görevi ilettim.`
      : 'Tamam, görevi takıma ilettim.';
    const browserTask = BROWSER_TASK_RE.test(low);
    return { action: 'delegate', department, objective: t, browserTask, op: null, target: null, speak };
  }
  if (low.includes('durum')) {
    return { action: 'status', department: detectDepartment(low, context), objective: null, op: null, target: null, speak: null };
  }
  if (directive === 'self') {
    return {
      action: 'reply',
      department: null,
      objective: t,
      op: null,
      target: null,
      executor: 'self',
      speak: 'Bunu kendi araçlarımla yapamıyorum (kod/dosya yazımı gerekiyor). Tek ajana vereyim mi?',
    };
  }
  return { action: 'reply', department: null, objective: null, op: null, target: null, speak: null, unclassified: true };
}

module.exports = {
  parseIntent,
};
