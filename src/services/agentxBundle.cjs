'use strict';

// AXMT-04 — TASLAK DEMETİ: tek sözden çıkan birden çok iş TEK onayla gider.
//
//   "Marvel takımına söyle şablon önizlemeyi eklesin. Sonra DC'ye söyle kapak görselini yapsın.
//    Bir de Transformers ne yaptı?"
//   → "İki iş hazır. Bir: Marvel'e, Fury'ye: …. İki: DC'ye, Batman'e: …. Transformers'ın durumunu
//      gönderdikten sonra söyleyeceğim. Düzeltmek ya da eklemek istediğin bir şey var mı?"
//   → "ikinciyi değiştir: kapak görselini mavi yapsın" · "DC'yi çıkar" · "sadece birinciyi gönder"
//   → "hayır, gönder" → draft:bundle-confirmed { items:[…], statusesAfter:[…] }
//
// NEDEN BURADA, agentxDraft İÇİNDE DEĞİL: AXD-04 taslak defteri TEK örnekli bir modül durumudur
// (`S`); N taslağı taşıyamaz ve tek-iş akışı ona bağlı. Demet onu YENİDEN YAZMAZ: her kalem aynı
// sözleşmenin bir taslağıdır (metin parçaları + hedef), aynı kurallarla:
//   · k1 birebir metin — gövde kullanıcının sözünden kesilir (AXMT-01), burada hiç yeniden yazılmaz;
//   · TEK ONAY = GERİ OKUMA KAPSAMI (AXD-04) — kapsam özeti `agentxDraft.scopeDigest` (metin +
//     hedef); bir kalemin metni ya da hedefi değişince o kalemin okuması düşer;
//   · niyet `draftIntent.classifyDraftIntent` (AXD-03), kutup söylenen sorudan `questionPolarity`;
//   · soru bitmeden başlayan kayıt cevap sayılmaz (spokenAt kapısı; ölçü sesin başı — `hear` notu);
//   · sessizlik/zaman aşımı/geri yükleme ASLA göndermez.
//
// DEMETE ÖZGÜ KURALLAR
//   ⛔ okunmamış KALEM gitmez — sesle GÖNDER ancak demetteki HER kalem okunmuşsa gönderir; TTS
//      ikinci kalemde kesildiyse GÖNDER yalnız okunmamış kalemleri okutur (tamamını değil).
//   ⛔ gövde sızıntısı (AXMT-01 `plan.leaks`) olan kalem sesle gitmez — kalem düzeltilir/çıkarılır
//      ya da ekrandaki Gönder düğmesine basılır (metin görünür).
//   · kısmi düzeltme: sıra sözü ("ikinciyi", "sonuncuyu") YA DA hedef adı ("DC'yi", "Fury'ninkini")
//     bir kalemi seçer; seçilemezse TEK soru "Hangisini: …?". Fiil: çıkar · değiştir · ekle ·
//     sadece … gönder. Düzeltilen kalem yeniden okunur, diğerlerinin okuması DURUR.
//   · durum kalemleri onay istemez (yan etkisi yok) — karar AX-MULTITEAM k2 A: işler
//     gönderildikten SONRA söylenir → `confirmed.statusesAfter`. İptalde de söylenir
//     (`cancelled.statusesAfter`): kullanıcı sordu, iş iptali soruyu iptal etmez.
//   · okuma bütçesi: demetteki okunacak metin toplam 60 kelimeye kadar TAMAMI; fazlasında her
//     kalemin ilk 12 kelimesi (tamamı ekranda) — AX-MULTITEAM §4, AXD-04'ün 60 kelime kuralı.
//
// Bu modül CÜMLE ÜRETMEZ: geri okuma cümlesini çağıran sözlükten kurar (`pending.reading`),
// söylediği cümleyi `markSpoken(id, at, said)` ile geri verir; kapsam ondan ölçülür.
//
// SAF: Electron yok, IO yok — main yalnız IPC + yayın ekler; kalıcılık `agentxResume.cjs`.
//   node --test electron/agentxBundle.test.cjs
//
// i18n-exempt: intent-token — kalem seçici ve düzeltme fiilleri leksikonda (AGENTX_BUNDLE_WORDS);
// burada yalnız ÖBEK desenleri (hedef adı + hâl eki, fiilden sonraki metin) var.

const { DRAFT_INTENT_WORDS, AGENTX_BUNDLE_WORDS: BW } = require('./intentLexicon.cjs');
const { classifyDraftIntent, questionPolarity, tokens: intentTokens, sendVerb } = require('./draftIntent.cjs');
const { scopeDigest, digestOf, DRAFT_LIMIT, CONFIRM_TIMEOUT_MS, UNDO_WINDOW_MS, READBACK_FULL_WORDS } = require('../agents/agentxDraft.cjs');

/** Demette en çok bu kadar iş (planlayıcının tavanı AXMT-01 MAX_ITEMS ile aynı). */
const MAX_ITEMS = 5;
/** Bütçe aşılınca her kalemden okunan kelime (AX-MULTITEAM §4). */
const BUNDLE_HEAD_WORDS = 12;
/** BELİRSİZ cevap en çok bir kez yeniden sorulur (agentxDraft CONFIRM_REASK_MAX ile aynı). */
const REASK_MAX = 1;
/** Düzeltme öbeğinde fiil en geç bu sırada gelir ("Marvel'inkine şunu da ekle" = 4). */
const EDIT_HEAD_MAX = 6;

const STATES = Object.freeze(['idle', 'target', 'confirm', 'which', 'text', 'paused']);

// ── Sözcük kümeleri (leksikondan, katlanmış) ────────────────────────────────

const foldTok = (w) => intentTokens(w).join(' ');
const setOf = (...lists) => new Set(lists.flat().map(foldTok).filter(Boolean));
const ORDINAL_STEMS = BW.ordinals.map((g) => g.map(foldTok));
const LAST_STEMS = BW.last.map(foldTok);
const REMOVE = setOf(BW.remove.tr, BW.remove.en);
const REPLACE = setOf(BW.replace.tr, BW.replace.en);
const ADD = setOf(BW.add.tr, BW.add.en);
const ONLY = setOf(BW.only.tr, BW.only.en);
const W_TR = DRAFT_INTENT_WORDS.tr;
const W_EN = DRAFT_INTENT_WORDS.en;
/** Seçici ile fiil arasında durabilen sözler: gösterici/iş adı/zamir + baştaki "hayır/evet/tamam". */
const FILLER = setOf(BW.filler.tr, BW.filler.en, W_TR.polarNo, W_TR.polarYes, W_TR.approve, W_EN.polarNo, W_EN.polarYes, W_EN.approve);

/**
 * Kısa (≤ 3 harf) hedef adından sonra kabul edilen hâl/iyelik eki — "DC'yi", "DC'ye", "DC'nin",
 * "DC'ninkini", "DC'deki". STT kesmeyi yutar ("dcyi"); ek tanınmazsa ad SEÇİCİ değildir
 * ("dcx…" gibi rastlantısal önek eşleşmesin). Uzun adlarda ek serbest (≤ 9 harf).
 */
const SHORT_NAME_SUFFIX = /^(?:y?[iuea]|n?[iu]n(?:ki(?:n[ie]?|ni|ne)?)?|[iu]nki(?:n[ie]?|ni|ne)?|[dt][ae](?:n|ki)?|n[ae]|y[ae])$/;
/** Sıra kökünden sonra ek: "ikinciyi", "ikincisine", "üçüncüsünü" (katlanmış). */
const ORDINAL_SUFFIX = /^[a-z]{0,6}$/;

// ── Defter ───────────────────────────────────────────────────────────────────

function emptyState() {
  return {
    state: 'idle',
    /** İş kalemleri, sözdeki sırayla: { key, units, target, labels:{team,agent}, question, leak, read, elided } */
    items: [],
    /** Durum kalemleri (onay yok): { scope, teamId, agentId, said } — işlerden SONRA söylenir (k2 A). */
    statuses: [],
    /** Planlayıcının tavanı aşıldı: atılan iş sayısı (çağıran "ilk 5'i hazırladım" der). */
    dropped: 0,
    revision: 0,
    /**
     * Açık soru: { id, kind:'confirm'|'which'|'text'|'target', revision, spokenAt, polarity, reasks,
     *   silences, openedAt, mode:'full'|'items'|'question', reading:[{key,text,truncated}], reason,
     *   op?, keys?, addText? }
     */
    pending: null,
    notice: null,
    undo: null,
    lastConfirmed: null,
    seq: 0,
  };
}

let B = emptyState();
let idSeq = 0;

function normalizeTarget(t) {
  if (!t || typeof t !== 'object') return null;
  const out = {};
  for (const k of ['agentId', 'agentLabel', 'role', 'teamId', 'teamLabel', 'paneKey']) {
    if (typeof t[k] === 'string' && t[k]) out[k] = t[k];
  }
  // AXM-03 — takım adıyla verilen iş liderine gider (planlayıcı `viaLeader` der, taslak `asLeader`).
  if ((t.asLeader === true || t.viaLeader === true) && out.agentId) out.asLeader = true;
  return Object.keys(out).length ? out : null;
}

/** Kalemin seçici adları: hedefin kendi etiketi, yoksa bağlamdaki takım/ajan kaydı. */
function labelsOf(target, ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const t = target || {};
  const dep = (Array.isArray(c.departments) ? c.departments : []).find((d) => d && t.teamId && d.id === t.teamId);
  const ali = (Array.isArray(c.aliases) ? c.aliases : []).find((a) => a && t.agentId && (a.id === t.agentId || a.match === t.agentId));
  return {
    team: t.teamLabel || (dep && (dep.label || dep.shortLabel)) || null,
    agent: t.agentLabel || (ali && (ali.label || ali.match)) || null,
  };
}

const textOf = (it) => it.units.join(' ');
const itemDigest = (it) => scopeDigest(it.units, it.target);
const isRead = (it) => !!it.read && it.read === itemDigest(it);
const allRead = () => B.items.length > 0 && B.items.every((it) => it.target && isRead(it));
const leaking = () => B.items.filter((it) => it.leak);

function viewItem(it, i) {
  return {
    n: i + 1,
    key: it.key,
    target: it.target ? { ...it.target } : null,
    labels: { ...it.labels },
    text: textOf(it),
    question: it.question || null,
    leak: !!it.leak,
    read: isRead(it),
    elided: !!it.elided,
    overLimit: textOf(it).length > DRAFT_LIMIT,
  };
}

function pendingView() {
  const p = B.pending;
  if (!p) return null;
  return {
    id: p.id,
    kind: p.kind,
    revision: p.revision,
    spokenAt: p.spokenAt,
    polarity: p.polarity,
    mode: p.mode,
    reason: p.reason,
    /** Bu turda SESLİ okunacak kalemler (sırayla) — çağıran cümleyi bundan kurar. */
    reading: p.reading.map((r) => ({ ...r, n: B.items.findIndex((it) => it.key === r.key) + 1 })),
    /** "Hangisini?" sorusunun adayları / hedef sorusunun kalemi. */
    candidates: (p.keys || []).map((k) => B.items.findIndex((it) => it.key === k) + 1).filter((n) => n > 0),
    op: p.op || null,
    question: p.question || null,
  };
}

function snapshot() {
  return {
    state: B.state,
    items: B.items.map(viewItem),
    statuses: B.statuses.map((s) => ({ ...s })),
    count: B.items.length,
    dropped: B.dropped,
    revision: B.revision,
    pending: pendingView(),
    /** Tek onay koşulu: her kalem hedefli ve okunmuş. */
    readCovered: allRead(),
    leaks: leaking().map((it) => B.items.indexOf(it) + 1),
    notice: B.notice,
    canUndo: !!B.undo,
  };
}

function result(outcome, changed = true) {
  return { ok: true, changed, outcome, snapshot: snapshot() };
}
function ignored(error) {
  return { ok: false, error, changed: false, outcome: { kind: 'ignored' }, snapshot: snapshot() };
}
function bump(notice) {
  B.revision += 1;
  B.pending = null;
  if (notice !== undefined) B.notice = notice;
}
function newKey() {
  B.seq += 1;
  return `k${B.seq}`;
}
function nextId() {
  idSeq += 1;
  return `b${Date.now().toString(36)}-${idSeq}`;
}

function getBundle() {
  return snapshot();
}

// ── Açılış: planlayıcının kalemleri → demet ───────────────────────────────

/**
 * AXMT-03 `plan` kararı demeti AÇAR. Kabul: RouteDecision `{cls:'plan', plan}` ya da çıplak plan
 * (`{items, dropped, leaks}`). İş kalemleri sırasıyla taslak olur; durum kalemleri ayrı tutulur.
 *   · hiç iş yoksa demet açılmaz → `status-only` (durumlar hemen söylenebilir; onay yok)
 *   · hedefi çözülmemiş kalem varsa ilk onun için HEDEF SORUSU (`target`, `question` planlayıcıdan)
 *   · gerisi → geri okuma + TEK soru (`confirm`, mode 'full')
 * Açık bir demetin üstüne açılmaz (sözdeki iş kaybolmasın: çağıran önce gönderir/iptal eder).
 * @param {object} routeOrPlan
 * @param {{at?:number, context?:object}} [opts] context = classify bağlamı (takım/ajan etiketleri)
 */
function openBundle(routeOrPlan, opts = {}) {
  const r = routeOrPlan && typeof routeOrPlan === 'object' ? routeOrPlan : {};
  if (r.cls && r.cls !== 'plan') return ignored('route plan değil');
  const plan = r.cls === 'plan' ? r.plan : r;
  if (!plan || !Array.isArray(plan.items)) return ignored('plan yok');
  if (B.state !== 'idle') return ignored('açık demet var');
  const at = typeof opts.at === 'number' ? opts.at : Date.now();
  const ctx = opts.context || {};
  const leakIdx = new Set((Array.isArray(plan.leaks) ? plan.leaks : []).map((l) => l && l.item).filter(Number.isInteger));
  const lastConfirmed = B.lastConfirmed;
  B = { ...emptyState(), lastConfirmed };
  const jobs = [];
  plan.items.forEach((it, idx) => {
    if (!it || typeof it !== 'object') return;
    if (it.kind === 'status') {
      B.statuses.push({ scope: it.scope || 'all', teamId: it.teamId || null, agentId: it.agentId || null, said: typeof it.said === 'string' ? it.said : '' });
      return;
    }
    if (it.kind !== 'job') return;
    // k1 — gövde BİREBİR: kırpma dışında dönüşüm yok. Gövdesiz iş (eksilti çözülemedi) boş kalır → sorulur.
    const body = typeof it.body === 'string' ? it.body.trim() : '';
    const target = normalizeTarget(it.target);
    jobs.push({
      key: newKey(),
      units: body ? [body] : [],
      target,
      labels: labelsOf(target, ctx),
      question: it.question || null,
      leak: leakIdx.has(idx),
      read: null,
      elided: !!it.elided,
    });
  });
  B.dropped = (Number.isInteger(plan.dropped) && plan.dropped > 0 ? plan.dropped : 0) + Math.max(0, jobs.length - MAX_ITEMS);
  B.items = jobs.slice(0, MAX_ITEMS);
  if (!B.items.length) {
    const statusesAfter = takeStatuses();
    B = { ...emptyState(), lastConfirmed };
    return result({ kind: 'status-only', statusesAfter }, false);
  }
  B.revision = 1;
  return advance(at, { reason: 'opened' });
}

/** Sıradaki adım: hedefsiz/gövdesiz kalem varsa onu sor; yoksa geri okuma + tek soru. */
function advance(at, o = {}) {
  const missing = B.items.find((it) => !it.target || !it.units.length);
  if (missing) return openQuestion(at, { kind: missing.target ? 'text' : 'target', keys: [missing.key], op: missing.target ? 'replace' : null, question: missing.question, reason: missing.target ? 'empty' : 'target' });
  return openConfirm(at, o);
}

/** Okunacak kalemler için bütçeli geri okuma metni. */
function readingOf(items) {
  const words = (it) => textOf(it).trim().split(/\s+/).filter(Boolean);
  const total = items.reduce((n, it) => n + words(it).length, 0);
  return items.map((it) => {
    const w = words(it);
    if (total <= READBACK_FULL_WORDS || w.length <= BUNDLE_HEAD_WORDS) return { key: it.key, text: w.join(' '), truncated: false };
    return { key: it.key, text: w.slice(0, BUNDLE_HEAD_WORDS).join(' '), truncated: true };
  });
}

/**
 * ONAY SORUSU: mode 'full' (hepsi okunur), 'items' (yalnız okunmamış/değişen kalemler), 'question'
 * (hepsi zaten okunmuş — yalnız soru). Kapsam ANCAK `markSpoken` söylenen metni getirince ilerler.
 */
function openConfirm(at, o = {}) {
  const unread = B.items.filter((it) => !isRead(it));
  let mode = o.mode;
  if (!mode) mode = unread.length === B.items.length ? 'full' : unread.length ? 'items' : 'question';
  const toRead = mode === 'full' ? B.items : mode === 'items' ? (o.only || unread) : [];
  return openQuestion(at, { kind: 'confirm', mode, reading: readingOf(toRead), reason: o.reason, notice: o.notice, outKind: o.outKind, extra: o.extra, reasks: o.reasks, id: o.id });
}

function openQuestion(at, o) {
  B.pending = {
    id: o.id || nextId(),
    kind: o.kind,
    revision: B.revision,
    spokenAt: null,
    polarity: null,
    reasks: o.reasks || 0,
    silences: 0,
    openedAt: at,
    mode: o.mode || null,
    reading: o.reading || [],
    reason: o.reason || null,
    keys: o.keys || null,
    op: o.op || null,
    addText: o.addText || null,
    question: o.question || null,
  };
  B.state = o.kind;
  if (o.notice !== undefined) B.notice = o.notice;
  const kind = o.outKind || (o.kind === 'confirm' ? 'confirm' : o.kind === 'target' ? 'target-needed' : o.kind === 'which' ? 'which' : 'ask-text');
  return result({ kind, pending: pendingView(), ...(o.reason ? { reason: o.reason } : {}), ...(o.extra || {}) });
}

/**
 * TTS soruyu BİTİRDİ. `said` = GERÇEKTEN söylenen cümle: kutup ondan, kapsam ondan. Okunan kalem
 * metinleri cümlede SIRAYLA aranır (aynı metinli iki kalem — dağıtım — tek okumayla ikisi birden
 * okunmuş sayılmasın). `said` gelmezse kapsam ilerlemez, kutup yok.
 */
function markSpoken(id, at = Date.now(), said = null) {
  const p = B.pending;
  if (!p || p.id !== id) return result({ kind: 'ignored' }, false);
  p.spokenAt = at;
  const spoken = typeof said === 'string' ? said : '';
  p.polarity = spoken ? questionPolarity(spoken) : null;
  const covered = [];
  if (spoken && p.revision === B.revision && p.reading.length) {
    const hay = intentTokens(spoken);
    let from = 0;
    for (const r of p.reading) {
      const need = intentTokens(r.text);
      const hit = need.length ? indexOfSeq(hay, need, from) : -1;
      if (hit < 0) break; // sıra bozulduysa (TTS kesildi) sonrakiler okunmamış sayılır
      from = hit + need.length;
      const it = B.items.find((x) => x.key === r.key);
      if (it) { it.read = itemDigest(it); covered.push(B.items.indexOf(it) + 1); }
    }
  }
  return result({ kind: 'spoken', covered, readCovered: allRead(), polarity: p.polarity }, covered.length > 0);
}

function indexOfSeq(hay, needle, from) {
  for (let i = from; i + needle.length <= hay.length; i += 1) {
    let hit = true;
    for (let j = 0; j < needle.length; j += 1) if (hay[i + j] !== needle[j]) { hit = false; break; }
    if (hit) return i;
  }
  return -1;
}

// ── Kalem seçici ─────────────────────────────────────────────────────────────

function ordinalOf(tok) {
  for (let g = 0; g < ORDINAL_STEMS.length; g += 1) {
    for (const stem of ORDINAL_STEMS[g]) {
      if (tok === stem || (tok.startsWith(stem) && ORDINAL_SUFFIX.test(tok.slice(stem.length)) && /[a-z]/.test(stem))) return g;
    }
  }
  return -1;
}
function isLast(tok) {
  return LAST_STEMS.some((s) => tok === s || (tok.startsWith(s) && ORDINAL_SUFFIX.test(tok.slice(s.length))));
}
/** Ad `label` jeton dizisi `toks[i…]`da başlıyor mu? Son jetonda ek serbest (kısa adda dar). */
function nameAt(toks, i, label) {
  const lt = intentTokens(label);
  if (!lt.length || i + lt.length > toks.length) return 0;
  for (let j = 0; j < lt.length - 1; j += 1) if (toks[i + j] !== lt[j]) return 0;
  const last = lt[lt.length - 1];
  const tok = toks[i + lt.length - 1];
  if (!tok.startsWith(last)) return 0;
  const rest = tok.slice(last.length);
  if (!rest) return lt.length;
  if (last.length <= 3) return SHORT_NAME_SUFFIX.test(rest) ? lt.length : 0;
  return rest.length <= 9 && /^[a-z]+$/.test(rest) ? lt.length : 0;
}

/**
 * Jeton dizisinin [from, to) aralığındaki seçiciler → kalem indeksleri. Aralıkta seçici ya da dolgu
 * DIŞINDA bir söz varsa `{ clean:false }` (söz düzeltme öbeği değil, iş metnidir).
 */
function selectorsIn(toks, from, to) {
  const picked = [];
  let named = false;
  let clean = true;
  for (let i = from; i < to;) {
    const t = toks[i];
    const ord = ordinalOf(t);
    if (ord >= 0) { if (ord < B.items.length) picked.push(ord); else clean = false; i += 1; continue; }
    if (isLast(t)) { picked.push(B.items.length - 1); i += 1; continue; }
    let hit = 0;
    B.items.forEach((it, idx) => {
      for (const label of [it.labels.team, it.labels.agent]) {
        const n = label ? nameAt(toks, i, label) : 0;
        if (n) { picked.push(idx); hit = Math.max(hit, n); }
      }
    });
    if (hit) { named = true; i += hit; continue; }
    if (!FILLER.has(t)) clean = false;
    i += 1;
  }
  return { picked: [...new Set(picked)].sort((a, b) => a - b), named, clean };
}

/**
 * Kısmi düzeltme öbeği: `[sadece] <seçici…> [dolgu…] <fiil> [: yeni metin]`.
 * @returns {null | {op:'remove'|'replace'|'add'|'only', picked:number[], rest:string}}
 *   `picked` boş = seçilemedi (çağıran "Hangisini?" sorar).
 */
function parseEdit(raw) {
  const words = String(raw ?? '').trim().split(/\s+/).filter(Boolean);
  const toks = [];
  const wordOf = [];
  words.forEach((w, wi) => { for (const t of intentTokens(w)) { toks.push(t); wordOf.push(wi); } });
  if (!toks.length) return null;
  const only = ONLY.has(toks[0]);
  const start = only ? 1 : 0;
  let v = -1;
  let op = null;
  for (let i = start; i < Math.min(toks.length, start + EDIT_HEAD_MAX); i += 1) {
    const t = toks[i];
    if (only && sendVerb(t)) { v = i; op = 'only'; break; }
    if (!only && REMOVE.has(t)) { v = i; op = 'remove'; break; }
    if (!only && REPLACE.has(t)) { v = i; op = 'replace'; break; }
    if (!only && ADD.has(t)) { v = i; op = 'add'; break; }
  }
  if (v < 0) return null;
  let sel = selectorsIn(toks, start, v);
  if (!sel.clean) return null;
  let restAt = v + 1;
  if (v === start) {
    // Fiil başta (İngilizce sıra: "remove the second one", "change the first: …"): seçici fiilden
    // SONRAKİ en uzun temiz öbektir. Seçicisiz çıplak fiil ("değiştir", "sil", "ekle …") taslağın
    // kendi dilbilgisine (sınıflandırıcı) kalır.
    let best = null;
    for (let k = v + 2; k <= Math.min(toks.length, v + 1 + EDIT_HEAD_MAX); k += 1) {
      const s = selectorsIn(toks, v + 1, k);
      if (!s.clean) break;
      if (s.picked.length) best = { s, k };
      if (/[:;]$/u.test(words[wordOf[k - 1]])) break; // ":" sonrası yeni metindir, seçici değil
    }
    if (!best) return null;
    sel = best.s;
    restAt = best.k;
  }
  const restWords = restAt < toks.length ? words.slice(wordOf[restAt] === wordOf[restAt - 1] ? wordOf[restAt] + 1 : wordOf[restAt]) : [];
  const rest = restWords.join(' ').replace(/^[:,;\-–—]\s*/u, '').trim();
  // Çıkar/yalnız-gönder öbeğinin ardında seçici dışında söz varsa söz bir iş metnidir.
  if ((op === 'remove' || op === 'only') && rest && !selectorsIn(toks, restAt, toks.length).clean) return null;
  return { op, picked: sel.picked, rest };
}

// ── Düzenlemeler ─────────────────────────────────────────────────────────────

function replaceItem(idx, text) {
  const it = B.items[idx];
  it.units = [text];
  it.leak = false; // kullanıcı metni kendisi yeniden söyledi — sızıntı kapısı planlayıcının metnine aitti
  it.read = null;
  bump('edited');
}
function appendItem(idx, text) {
  B.items[idx].units.push(text);
  B.items[idx].read = null;
  bump('added');
}
function removeAt(indices) {
  const drop = new Set(indices);
  const removed = B.items.filter((_, i) => drop.has(i)).map((it, k) => ({ n: [...drop].sort((a, b) => a - b)[k] + 1, text: textOf(it), target: it.target }));
  B.items = B.items.filter((_, i) => !drop.has(i));
  bump('removed');
  return removed;
}

/** Düzeltmeyi uygula; ardından okunmamış kalem(ler) okunur ya da yalnız soru yeniden sorulur. */
function applyEdit(e, at) {
  if (!e.picked.length) return askWhich(at, e.op, e.rest);
  if ((e.op === 'replace' || e.op === 'add') && e.picked.length > 1) return askWhich(at, e.op, e.rest, e.picked);
  const idx = e.picked[0];
  if (e.op === 'remove') {
    const removed = removeAt(e.picked);
    if (!B.items.length) return emptied(at, removed);
    return openConfirm(at, { reason: 'removed', notice: 'removed', extra: { removed } });
  }
  if (e.op === 'only') {
    const keep = new Set(e.picked);
    const removed = removeAt(B.items.map((_, i) => i).filter((i) => !keep.has(i)));
    return sendIfRead(at, 'voice', { removed });
  }
  if (!e.rest) return openQuestion(at, { kind: 'text', keys: [B.items[idx].key], op: e.op, reason: e.op });
  if (e.op === 'replace') replaceItem(idx, e.rest);
  else appendItem(idx, e.rest);
  if (textOf(B.items[idx]).length > DRAFT_LIMIT) { B.notice = 'limit'; return openConfirm(at, { mode: 'question', reason: 'limit', notice: 'limit' }); }
  return openConfirm(at, { only: [B.items[idx]], mode: 'items', reason: e.op === 'replace' ? 'edited' : 'added', notice: e.op === 'replace' ? 'edited' : 'added' });
}

function askWhich(at, op, addText, among) {
  const keys = (among && among.length ? among.map((i) => B.items[i]) : B.items).map((it) => it.key);
  return openQuestion(at, { kind: 'which', keys, op, addText: addText || null, reason: op });
}

/** Demet boşaldı (son kalem de çıkarıldı) → iptal gibi kapanır; durumlar yine söylenir. */
function emptied(at, removed) {
  const statusesAfter = takeStatuses();
  const lastConfirmed = B.lastConfirmed;
  B = { ...emptyState(), lastConfirmed, notice: 'emptied' };
  return result({ kind: 'emptied', removed, statusesAfter });
}

function takeStatuses() {
  const s = B.statuses;
  B.statuses = [];
  return s;
}

/** GÖNDER: her kalem okunmuşsa demet gider; okunmamış kalem varsa YALNIZ onlar okunur. */
function sendIfRead(at, via, extra = {}) {
  if (!B.items.length) return emptied(at, extra.removed || []);
  const over = B.items.filter((it) => textOf(it).length > DRAFT_LIMIT);
  if (over.length) { B.notice = 'limit'; return openConfirm(at, { mode: 'question', reason: 'limit', notice: 'limit', extra }); }
  const leaks = leaking();
  if (leaks.length) return openQuestion(at, { kind: 'which', keys: leaks.map((it) => it.key), op: 'replace', reason: 'leak', notice: 'leak', outKind: 'clarify' });
  if (allRead()) return confirmNow(at, via, extra);
  return openConfirm(at, { reason: 'unread', extra });
}

function confirmNow(at, via = 'button', extra = {}) {
  const items = B.items.map((it, i) => ({
    n: i + 1,
    key: it.key,
    target: it.target ? { ...it.target } : null,
    text: textOf(it),
    digest: digestOf(textOf(it)),
    unitCount: it.units.length,
  }));
  const confirmed = { id: B.pending ? B.pending.id : nextId(), revision: B.revision, items, statusesAfter: takeStatuses(), at, via };
  B = { ...emptyState(), lastConfirmed: confirmed, notice: 'confirmed' };
  return { ok: true, changed: true, outcome: { kind: 'confirmed', confirmed, ...extra }, snapshot: snapshot() };
}

function cancel(at = Date.now()) {
  if (B.state === 'idle') return result({ kind: 'ignored' }, false);
  const undo = { items: B.items.map((it) => ({ ...it, units: [...it.units], read: null })), at };
  const statusesAfter = takeStatuses();
  B = { ...emptyState(), lastConfirmed: B.lastConfirmed, undo, notice: 'cancelled', seq: B.seq };
  return result({ kind: 'cancelled', canUndo: true, statusesAfter });
}

function undoCancel(at = Date.now()) {
  if (!B.undo || B.state !== 'idle') return result({ kind: 'ignored' }, false);
  if (at - B.undo.at > UNDO_WINDOW_MS) { B.undo = null; return result({ kind: 'expired' }); }
  B.items = B.undo.items;
  B.undo = null;
  B.state = 'paused';
  bump('restored');
  return result({ kind: 'restored' });
}

// ── Ses ──────────────────────────────────────────────────────────────────────

/**
 * Sonlandırılmış cümle. `startedAt` = KAYDIN başladığı an. Dönüş `outcome.kind`:
 *   pass           demet yok — normal yol
 *   stale          soru bitmeden başlayan kayıt — YOK SAYILDI (kendi sesini duyma dahil)
 *   confirm        geri okuma + soru (`pending.mode` full|items|question; `reason`)
 *   confirmed      TEK onay: demet gider (`confirmed.items`, `confirmed.statusesAfter`)
 *   which          "Hangisini?" — seçici bulunamadı / birden çok kalem seçildi
 *   ask-text       seçilen kalemin yeni metni soruluyor ("ikinciyi değiştir" — metinsiz)
 *   clarify        sızıntılı kalem sesle gitmez (`reason:'leak'`, `pending.candidates`)
 *   target-answer  HEDEF SORUSU'na cevap — çağıran çözer, `setItemTarget` ile verir
 *   paused · cancelled · emptied · kept
 *
 * AXD-07 — `opts.bargeIn`: söz Agent X soruyu OKURKEN araya girilerek söylendi (enerji kapısı
 * kullanıcının sesiyle ateşledi, okuma DURDU, kayıt konuşmanın başından tutuldu). Kayıt okuma
 * bitmeden başladığı için bayat kapısına takılırdı; kendi sesini duyma riski yok → bayat
 * sayılmaz (taslak defteriyle aynı kural). Yarıda kalan okuma `said:''` ile damgalanır: kapsam
 * ilerlemez, kutup yok → GÖNDER okunmamış kalemi göndermez.
 *
 * AXMT-STALE-01 — `opts.voiceAt`: bu kayıtta kullanıcının SESİNİN başladığı an (VAD'in ilk tiki).
 * Kayıt damgadan önce açılmış olabilir (yeniden-dinleme zamanlayıcısı; AXMT-08 B1'de 20 sn'lik cevap
 * penceresi alan kayıt geri okuma boyunca açık kaldı) — o kayıtta damgadan SONRA başlayan ses cevaptır.
 * Bayat kapısı max(kayıt başı, ses başı)'nı ölçer: ses kayıttan önce başlayamaz (eski turun damgası
 * yok sayılır); ses damgadan önce başladıysa (kendi sesi / sorunun üstüne konuşma) kural aynen.
 */
function hear(text, opts = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return result({ kind: 'ignored' }, false);
  if (B.state === 'idle') return result({ kind: 'pass' }, false);
  const at = typeof opts.at === 'number' ? opts.at : Date.now();
  const startedAt = typeof opts.startedAt === 'number' ? opts.startedAt : at;
  const heardFrom = typeof opts.voiceAt === 'number' && opts.voiceAt > startedAt ? opts.voiceAt : startedAt;
  const bargeIn = opts.bargeIn === true;
  const p = B.pending;

  if (B.state === 'target') {
    const c = classifyDraftIntent(raw, { ctx: 'dictation' });
    // Hedef sorusunda "vazgeç" = YALNIZ bu kalem çıkar (öteki işler sorulmadan gitmez, okunur).
    if (c.label === 'CANCEL') {
      const idx = B.items.findIndex((it) => it.key === p.keys[0]);
      const removed = removeAt([idx]);
      if (!B.items.length) return emptied(at, removed);
      return advance(at, { reason: 'removed', notice: 'removed', extra: { removed } });
    }
    return result({ kind: 'target-answer', n: B.items.findIndex((it) => it.key === p.keys[0]) + 1, text: raw }, false);
  }

  if (!bargeIn && p && (p.spokenAt === null || heardFrom <= p.spokenAt)) {
    // Sınıflandırılmaz: TTS'in kendi cümlesi mikrofona sızmış olabilir (AXD-04 ile aynı kapı).
    B.notice = 'stale';
    return result({ kind: 'stale', reason: p.spokenAt === null ? 'not-spoken-yet' : 'started-before-summary' }, false);
  }

  if (B.state === 'text') return hearText(raw, at);
  if (B.state === 'which') return hearWhich(raw, at);
  return hearReview(raw, at, opts);
}

/** "İkinci işin yeni metni ne?" → cevap AYNEN o kalemin metni (k1). İptal sözü soruyu kapatır. */
function hearText(raw, at) {
  const p = B.pending;
  const c = classifyDraftIntent(raw, { ctx: 'dictation' });
  if (c.label === 'CANCEL') return openConfirm(at, { reason: 'kept' });
  const idx = B.items.findIndex((it) => it.key === p.keys[0]);
  if (idx < 0) return openConfirm(at, { reason: 'kept' });
  return applyEdit({ op: p.op === 'add' ? 'add' : 'replace', picked: [idx], rest: raw }, at);
}

/** "Hangisini?" → yalnız seçici okunur; seçilemezse bir kez daha sorulur, sonra soru kapanır. */
function hearWhich(raw, at) {
  const p = B.pending;
  const toks = intentTokens(raw);
  const c = classifyDraftIntent(raw, { ctx: 'dictation' });
  if (c.label === 'CANCEL') return openConfirm(at, { reason: 'kept' });
  // Cevap kendi başına tam bir düzeltmeyse ("ikinciyi değiştir: …") o uygulanır — metni yutulmaz.
  const full = parseEdit(raw);
  if (full && full.picked.length) return applyEdit(full, at);
  const sel = selectorsIn(toks, 0, toks.length);
  const among = new Set(p.keys);
  const picked = sel.picked.filter((i) => among.has(B.items[i].key));
  if (picked.length === 1 || (picked.length > 1 && p.op === 'remove')) {
    return applyEdit({ op: p.op || 'replace', picked, rest: p.addText || '' }, at);
  }
  if (p.reasks < REASK_MAX) {
    return openQuestion(at, { kind: 'which', keys: p.keys, op: p.op, addText: p.addText, reason: p.reason, id: p.id, reasks: p.reasks + 1, notice: 'reask', outKind: 'reask' });
  }
  return openConfirm(at, { reason: 'kept', notice: 'kept', outKind: 'kept' });
}

/** ONAY SORUSU (ve duraklamış demet): önce kısmi düzeltme öbeği, sonra taslak niyeti. */
function hearReview(raw, at, opts) {
  const p = B.pending;
  if (opts.control === 'stop') { B.pending = null; B.state = 'paused'; B.notice = 'hold'; return result({ kind: 'paused', reason: 'hold' }); }
  const e = parseEdit(raw);
  if (e) return applyEdit(e, at);
  const toks = intentTokens(raw);
  const c = classifyDraftIntent(raw, { ctx: p ? 'review' : 'dictation', polarity: p ? p.polarity : null });
  let label = c.label;
  if (label === 'ADD' && toks.length <= 1) label = 'UNCLEAR'; // AXP-11: kısa cevap metne yazılmaz
  switch (label) {
    case 'SEND':
      return sendIfRead(at, 'voice');
    case 'CANCEL':
      return cancel(at);
    case 'ADD': {
      // Seçicisiz ek: tek iş varsa ona; birden çoksa hangisine olduğu sorulur (metin kaybolmaz).
      const body = stripLeadingControl(raw);
      if (B.items.length === 1) return applyEdit({ op: 'add', picked: [0], rest: body }, at);
      return askWhich(at, 'add', body);
    }
    case 'FIX':
      return askWhich(at, 'replace', '');
    case 'HOLD':
      B.pending = null; B.state = 'paused'; B.notice = 'hold';
      return result({ kind: 'paused', reason: 'hold' });
    default:
      if (p && p.reasks < REASK_MAX) {
        return openConfirm(at, { mode: 'question', reason: 'unclear', notice: 'reask', outKind: 'reask', reasks: p.reasks + 1, id: p.id });
      }
      B.pending = null; B.state = 'paused'; B.notice = 'kept';
      return result({ kind: 'kept', reason: 'unclear' });
  }
}

const LEAD_CONTROL = setOf(W_TR.polarNo, W_TR.polarYes, W_TR.approve, W_EN.polarNo, W_EN.polarYes, W_EN.approve);
/** Baştaki "Hayır," / "Evet," / "Tamam," (virgüllü) atılır; gerisi AYNEN (agentxDraft ile aynı kural). */
function stripLeadingControl(raw) {
  let rest = raw;
  for (;;) {
    const m = rest.match(/^([\p{L}']+)\s*[,;:]\s+([\s\S]+)$/u);
    if (!m || !LEAD_CONTROL.has(foldTok(m[1]))) return rest;
    rest = m[2];
  }
}

// ── Düğme / klavye / zaman ───────────────────────────────────────────────────

/** HEDEF SORUSU cevabı çağıranda çözüldü → kaleme yaz; sıradaki eksik ya da geri okuma. */
function setItemTarget(n, target, at = Date.now()) {
  const it = B.items[n - 1];
  if (!it) return ignored('kalem yok');
  const t = normalizeTarget(target);
  if (!t) return ignored('hedef yok');
  it.target = t;
  it.labels = { team: t.teamLabel || it.labels.team, agent: t.agentLabel || it.labels.agent };
  it.question = null;
  it.read = null;
  bump(null);
  return advance(at, { reason: 'target' });
}

/** Klavye: kalemin metni (k1 — aynen). Değişen kalem yeniden okunur; ötekiler okunmuş kalır. */
function editItem(n, text, at = Date.now()) {
  const t = String(text ?? '').trim();
  if (!B.items[n - 1] || !t) return ignored('kalem yok');
  replaceItem(n - 1, t);
  B.state = 'paused';
  return result({ kind: 'edited', n });
}

function removeItem(n, at = Date.now()) {
  if (!B.items[n - 1]) return ignored('kalem yok');
  const removed = removeAt([n - 1]);
  if (!B.items.length) return emptied(at, removed);
  B.state = 'paused';
  return result({ kind: 'removed', removed });
}

/** Düğme: 'send' | 'edit' | 'cancel'. Düğme ekrandadır (metin görünür) — ses kapsamı aranmaz. */
function resolve(id, choice, at = Date.now()) {
  const p = B.pending;
  if (!p || p.id !== id) return ignored('soru yok');
  if (p.revision !== B.revision) { B.pending = null; B.state = 'paused'; B.notice = 'changed'; return result({ kind: 'changed' }); }
  if (choice === 'send' || choice === true) {
    if (!B.items.every((it) => it.target && it.units.length)) return advance(at, { reason: 'target' });
    if (B.items.some((it) => textOf(it).length > DRAFT_LIMIT)) { B.notice = 'limit'; return result({ kind: 'limit' }, false); }
    return confirmNow(at, 'button');
  }
  if (choice === 'cancel') return cancel(at);
  B.pending = null; B.state = 'paused'; B.notice = null;
  return result({ kind: 'edit' });
}

/** "Bitti" düğmesi / duraklamış demete dönüş: eksik varsa sorar, yoksa okunmamışı okur — göndermez. */
function finish(at = Date.now()) {
  if (B.state === 'idle') return ignored('demet yok');
  if (B.pending) return result({ kind: B.pending.kind, pending: pendingView() }, false);
  return advance(at, { reason: 'finish' });
}

/** Kayıt ses duymadan kapandı: ONAY SORUSU'nda iki sessiz tur → sessizce duraklar. ASLA göndermez. */
function noSpeech(at = Date.now()) {
  void at;
  const p = B.pending;
  if (!p || B.state === 'target') return result({ kind: 'ignored' }, false);
  p.silences += 1;
  if (p.silences >= 2) { B.pending = null; B.state = 'paused'; B.notice = 'waiting'; return result({ kind: 'waiting', reason: 'silence' }); }
  return result({ kind: 'waiting' }, false);
}

function tick(at = Date.now()) {
  const p = B.pending;
  if (p && B.state !== 'target' && at - p.openedAt >= CONFIRM_TIMEOUT_MS) {
    B.pending = null; B.state = 'paused'; B.notice = 'waiting';
    return result({ kind: 'waiting', reason: 'timeout' });
  }
  if (B.undo && at - B.undo.at > UNDO_WINDOW_MS) { B.undo = null; return result({ kind: 'undo-expired' }); }
  return result({ kind: 'idle' }, false);
}

// ── Kalıcılık (agentxResume) ─────────────────────────────────────────────────
//
// ⛔ Geri yükleme GÖNDERMEZ: demet `paused` + `notice:'resumed'` döner. Okuma kapsamı, açık soru ve
// DURUM kalemleri saklanmaz — önceki oturumun okuması ve "evet"i yeni oturumda hiçbir şey göndermez;
// eski durum sorusunun cevabı bayattır (yeniden sorulur, eskisi okunmaz).

function exportBundle() {
  if (B.state === 'idle' || !B.items.length) return null;
  return {
    items: B.items.map((it) => {
      const target = it.target ? { ...it.target } : null;
      if (target) delete target.paneKey; // pencere kimliği oturuma ait
      return { units: [...it.units], target: target && Object.keys(target).length ? target : null, labels: { ...it.labels } };
    }),
  };
}

function restoreBundle(saved) {
  if (B.state !== 'idle') return ignored('açık demet var');
  const list = saved && Array.isArray(saved.items) ? saved.items : [];
  const items = [];
  for (const s of list.slice(0, MAX_ITEMS)) {
    if (!s || typeof s !== 'object') continue;
    const units = (Array.isArray(s.units) ? s.units : []).filter((u) => typeof u === 'string').map((u) => u.trim()).filter(Boolean);
    if (!units.length) continue;
    const target = normalizeTarget(s.target);
    if (target) delete target.paneKey;
    const labels = s.labels && typeof s.labels === 'object' ? s.labels : {};
    items.push({
      key: newKey(),
      units,
      target: target && Object.keys(target).length ? target : null,
      labels: { team: typeof labels.team === 'string' ? labels.team : null, agent: typeof labels.agent === 'string' ? labels.agent : null },
      question: null,
      leak: false,
      read: null, // önceki oturumun okuması bu oturumda onay kapsamı DEĞİLDİR
      elided: false,
    });
  }
  if (!items.length) return result({ kind: 'ignored' }, false);
  B.items = items;
  B.state = 'paused';
  bump('resumed');
  return result({ kind: 'resumed', count: items.length });
}

/** "Devam et": geri gelen demet bu oturumun demetidir — soru yine okumayla açılır (`finish`). */
function ackResume() {
  if (B.notice !== 'resumed' || B.state === 'idle') return result({ kind: 'ignored' }, false);
  B.notice = null;
  return result({ kind: 'acknowledged' });
}

function resetBundle() {
  B = emptyState();
  idSeq = 0;
}

module.exports = {
  MAX_ITEMS,
  BUNDLE_HEAD_WORDS,
  STATES,
  getBundle,
  openBundle,
  setItemTarget,
  hear,
  markSpoken,
  finish,
  noSpeech,
  tick,
  resolve,
  editItem,
  removeItem,
  cancel,
  undoCancel,
  exportBundle,
  restoreBundle,
  ackResume,
  resetBundle,
  // saf yardımcılar (test)
  _internal: { parseEdit, selectorsIn, nameAt, ordinalOf, readingOf },
};
