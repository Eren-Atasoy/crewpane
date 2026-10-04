// AXP-03 — AGENT X HEDEF ÇÖZÜMÜ: "Marvel'daki Parker" / "tasarım takımına" / "Parker"
// → takım + ajan + CANLI pane. (Tasarım: docs/design/AXP-01-DESIGN.md §4.1.)
//
// NEDEN AYRI BİR KATMAN: bugün "kim / ne / nasıl teslim" üç yerde üç ayrı gerçek
// (AXP-01-DESIGN §1.2). Bu modül "kim"in TEK karar noktasıdır; sonraki katman
// (agentxDeliver) kararı TAŞIR, yeniden türetmez.
//
// KURALLAR
//   1. Roster KULLANICININ GERÇEK listesidir (ctx.aliases) — sabit ad YOK
//      ([[feedback_no_hardcoded_brand_cases]]). Ad çözümü `entityResolve.resolveAgent`
//      üstüne kurulur (yeniden yazılmadı).
//   2. Takım adı HARFE DUYARSIZ ([[team-name-free-text-vs-slug-eq]]: `.eq()` 0 satır
//      dönüyordu; belirti "takım yok" değil "0 uygun worker"). Her karşılaştırma
//      `trLower` ile iki taraflı küçültülür.
//   3. Çift eşleşme → TEK SORU (uydurma yok; ADP-854 §4). Yok → dürüst cevap + en
//      yakın 3 öneri. ASLA başkasına verme.
//   4. Rolde birden çok ajan: aktif takım önce, sonra BOŞTA olan önce (bugünkü
//      "ilk sıradaki" kuralı yerine).
//   5. Takım hedefi → takım liderinin pane'i (`leaderRole.isLeaderRoleSlug`); lider
//      yoksa soru.
//
// SAF: IO yok, Electron yok → `node --test electron/agentxTarget.test.cjs`.

'use strict';

const morph = require('../voice/turkishMorph.cjs');
const entityResolve = require('../services/entityResolve.cjs');
const { isLeaderRoleSlug } = require('./leaderRole.cjs');

/** Pane hâli — agentxDeliver'ın kuyruk kararı buna bakar. */
const PANE_STATE = Object.freeze({ IDLE: 'idle', BUSY: 'busy', FRESH: 'fresh', UNKNOWN: 'unknown' });

const trLower = (s) => morph.trLower(s);

/**
 * Cümlede geçen takım (departman) id'si — iki taraflı küçültülmüş karşılaştırma.
 * `jarvisVoice.detectDepartment`in takım dalıyla aynı kural (o dosya ağır; buraya
 * yalnız takım sözlüğü kuralı alındı, ajan-alias dalı `resolveAgent`te zaten var).
 * @param {string} text
 * @param {Array<{id?:string,label?:string,shortLabel?:string}>} departments
 * @returns {string|null}
 */
function matchTeam(text, departments) {
  const low = trLower(text);
  if (!low.trim()) return null;
  const depts = Array.isArray(departments) ? departments.filter(Boolean) : [];
  // Tam kimlik/etiket önce (en spesifik), ayırt edici etiket jetonu sonra.
  for (const d of depts) {
    for (const cand of [d.id, d.label, d.shortLabel]) {
      const c = trLower(cand);
      if (c.length > 1 && low.includes(c)) return d.id;
    }
  }
  for (const d of depts) {
    const label = trLower(d.label);
    for (const tok of label.split(/\s+/)) {
      if (tok.length > 3 && tok !== 'crewpane' && tok !== 'takım' && low.includes(tok)) return d.id;
    }
  }
  return null;
}

/** Takım etiketi (bilinmiyorsa id). */
function teamLabelOf(teamId, departments) {
  const hit = (Array.isArray(departments) ? departments : []).find((d) => d && d.id === teamId);
  return (hit && (hit.label || hit.shortLabel)) || teamId || null;
}

/**
 * Ajan etiketi — SUNUM için (makbuz `to.agentLabel`, "X aldı." sesi, "Son işlemler",
 * sekme geçişi cümlesi, gri halka etiketi hepsi bunu okur).
 * AXP-07: `label` = görünen ad (`display_name`, harf hâli korunmuş). `match` ise
 * renderer'ın EŞLEŞTİRME için `toLocaleLowerCase('tr')` ile küçülttüğü kopya —
 * ondan etiket türetmek "ıris aldı." / "ipek" (I→ı, İ→i) veriyordu. `label` yoksa
 * eski şekle (match, sonra id) düşer; eşleştirme kuralı DEĞİŞMEZ.
 */
function agentLabelOf(alias) {
  return (alias && (alias.label || alias.match || alias.id)) || null;
}

/**
 * Ajanın CANLI pane'i (exited olmayan). Birden çok varsa boşta olan tercih edilir.
 * @returns {{paneId:string,state:string}|null}
 */
function livePaneFor(agentId, panes) {
  const list = (Array.isArray(panes) ? panes : []).filter((p) => p && p.agentId === agentId && !p.exited);
  if (!list.length) return null;
  const rank = { [PANE_STATE.IDLE]: 0, [PANE_STATE.BUSY]: 1, [PANE_STATE.FRESH]: 2, [PANE_STATE.UNKNOWN]: 3 };
  list.sort((a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9));
  return { paneId: list[0].paneId, state: list[0].state || PANE_STATE.UNKNOWN };
}

/** Roster'dan en yakın N ad (düzenleme mesafesi; STT bir harf düşürür). */
function nearestNames(said, aliases, n = 3) {
  const s = trLower(said);
  const scored = [];
  for (const a of aliases) {
    const name = trLower(agentLabelOf(a));
    if (!name) continue;
    scored.push({ name: agentLabelOf(a), d: morph.editDistance(s, name, 6) });
  }
  scored.sort((a, b) => a.d - b.d);
  return scored.slice(0, n).map((x) => x.name);
}

/**
 * Hedef çözümü — ilk tutan kazanır (AXP-01-DESIGN §4.1 sırası).
 *
 * @param {{agentId?:string|null, role?:string|null, teamId?:string|null, text?:string|null}} target
 *   AXP-01/02'nin taşıdığı hedef. `text` = kullanıcının hedef ifadesi ("Marvel'daki Parker").
 * @param {{
 *   aliases?: Array<{id?:string, match?:string, label?:string, department?:string, role?:string}>,
 *   departments?: Array<{id:string, label?:string, shortLabel?:string}>,
 *   panes?: Array<{paneId:string, agentId?:string|null, department?:string|null, state?:string, exited?:boolean}>,
 *   activeDepartment?: string|null,
 * }} ctx
 * @returns {
 *   | {kind:'resolved', agentId:string, agentLabel:string, teamId:string|null, teamLabel:string|null, via:string, pane:{paneId:string,state:string}|null}
 *   | {kind:'ambiguous', options:Array<{agentId:string, agentLabel:string, teamId:string|null, teamLabel:string|null}>}
 *   | {kind:'unknown', reason:'no-target'|'no-such-agent'|'no-role'|'no-leader'|'no-such-team', said:string|null, suggestions:string[]}
 * }
 */
function resolveTarget(target, ctx = {}) {
  const t = target && typeof target === 'object' ? target : {};
  const aliases = (Array.isArray(ctx.aliases) ? ctx.aliases : []).filter((a) => a && (a.id || a.match));
  const departments = Array.isArray(ctx.departments) ? ctx.departments : [];
  const panes = Array.isArray(ctx.panes) ? ctx.panes : [];
  const active = ctx.activeDepartment || null;
  const text = typeof t.text === 'string' ? t.text : '';

  const resolved = (a, via) => {
    const agentId = a.id || a.match;
    const teamId = a.department || null;
    return {
      kind: 'resolved',
      agentId,
      agentLabel: agentLabelOf(a),
      teamId,
      teamLabel: teamLabelOf(teamId, departments),
      via,
      pane: livePaneFor(agentId, panes),
    };
  };
  const ambiguous = (list) => ({
    kind: 'ambiguous',
    options: list.map((a) => ({
      agentId: a.id || a.match,
      agentLabel: agentLabelOf(a),
      teamId: a.department || null,
      teamLabel: teamLabelOf(a.department || null, departments),
    })),
  });
  const unknown = (reason, said, suggestions = []) => ({ kind: 'unknown', reason, said: said || null, suggestions });

  // ── 0) Açık agentId (AXP-01 beynin/kural yolunun çözdüğü) — doğrulanır, uydurulmaz ──
  if (t.agentId) {
    const idLow = trLower(t.agentId);
    const hits = aliases.filter((a) => trLower(a.id) === idLow || trLower(a.match) === idLow);
    if (hits.length === 1) return resolved(hits[0], 'id');
    if (hits.length > 1) {
      // Aynı ad iki takımda: takım ipucu (teamId ya da metin) ayırır, yoksa soru.
      const teamHint = t.teamId ? trLower(t.teamId) : matchTeam(text, departments);
      const inTeam = teamHint ? hits.filter((a) => trLower(a.department) === trLower(teamHint)) : [];
      if (inTeam.length === 1) return resolved(inTeam[0], 'id+team');
      return ambiguous(hits);
    }
    return unknown('no-such-agent', t.agentId, nearestNames(t.agentId, aliases));
  }

  // ── 1) Takım + ad: "Marvel'daki Parker" ───────────────────────────────────
  const teamFromText = text ? matchTeam(text, departments) : null;
  const teamId = t.teamId ? (departments.find((d) => trLower(d.id) === trLower(t.teamId)) || {}).id || null : teamFromText;
  if (t.teamId && !teamId) return unknown('no-such-team', t.teamId, departments.map((d) => d.label || d.id).slice(0, 3));

  if (text) {
    const r = entityResolve.resolveAgent(text, { aliases, defaultDepartment: active });
    // Rol eşleşmesi (`via:'role'`) burada ALINMAZ: entityResolve "ilk sıradaki" kuralıyla
    // seçer; §4.1 boşta-önce sırasını aşağıdaki rol dalı uygular.
    if (r.id && r.via !== 'role') {
      // `resolveAgent` İLK tutan alias'ı döner; aynı GÖRÜNEN AD başka takımda da
      // olabilir (id'ler farklı) → adaşları görünen ada göre topla, sonra ayır.
      const first = aliases.find((a) => (a.id || a.match) === r.id) || null;
      const shown = first ? trLower(first.match) : '';
      const candidates = shown ? aliases.filter((a) => trLower(a.match) === shown) : first ? [first] : [];
      if (candidates.length > 1) {
        // ── 2) Yalnız ad, iki takımda aynı ad → takım ipucu ya da SORU ──────
        const inTeam = teamId ? candidates.filter((a) => trLower(a.department) === trLower(teamId)) : [];
        if (inTeam.length === 1) return resolved(inTeam[0], `${r.via}+team`);
        return ambiguous(candidates);
      }
      const a = candidates[0] || first;
      if (a) {
        if (teamId && a.department && trLower(a.department) !== trLower(teamId)) {
          // "Marvel'daki Parker" dedi ama Parker başka takımda: uydurma, dürüst söyle.
          return unknown('no-such-agent', `${teamLabelOf(teamId, departments)} / ${agentLabelOf(a)}`, [
            `${agentLabelOf(a)} (${teamLabelOf(a.department, departments)})`,
          ]);
        }
        return resolved(a, r.via);
      }
    }
    if (r.unresolvedName) return unknown('no-such-agent', r.unresolvedName, nearestNames(r.unresolvedName, aliases));
    if (r.unresolvedRole) return unknown('no-role', r.unresolvedRole, []);
  }

  // ── 3) Rol: aktif takım önce, sonra BOŞTA olan önce ───────────────────────
  const roleSlug = t.role || (text ? entityResolve.detectRoleSlug(text) : null);
  if (roleSlug) {
    let inRole = aliases.filter((a) => entityResolve.roleMatches(a.role, roleSlug));
    if (teamId) inRole = inRole.filter((a) => trLower(a.department) === trLower(teamId));
    if (!inRole.length) return unknown('no-role', roleSlug, []);
    if (inRole.length === 1) return resolved(inRole[0], 'role');
    const paneState = (a) => (livePaneFor(a.id || a.match, panes) || {}).state || null;
    const score = (a) =>
      (active && a.department === active ? 0 : 10) + (paneState(a) === PANE_STATE.IDLE ? 0 : paneState(a) ? 1 : 2);
    const sorted = [...inRole].sort((x, y) => score(x) - score(y));
    return resolved(sorted[0], 'role+idle-first');
  }

  // ── 4) Takım: "ChatFlow takımına" → takım liderinin pane'i ───────────────
  if (teamId) {
    const leaders = aliases.filter((a) => trLower(a.department) === trLower(teamId) && isLeaderRoleSlug(a.role));
    if (leaders.length === 1) return resolved(leaders[0], 'team-leader');
    if (leaders.length > 1) return ambiguous(leaders);
    return unknown('no-leader', teamLabelOf(teamId, departments), []);
  }

  // ── 5) Hiçbiri → HEDEF SORUSU (AXP-02 §3) ─────────────────────────────────
  return unknown('no-target', text || null, aliases.slice(0, 3).map(agentLabelOf));
}

module.exports = { PANE_STATE, matchTeam, livePaneFor, nearestNames, resolveTarget };
