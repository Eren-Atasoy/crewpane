'use strict';

// AXP-02 — AGENT X PROMPT TASLAĞI — pencereler arası TEK GERÇEK, main'de.
//
// Eren: "prompt verirken düşünmeler, beklemeler, eklemeler, çıkarmalar oluyor."
// Bir ajana verilecek iş bir CÜMLE değil bir TASLAKTIR:
//
//   dinliyor → taslak → duraksama (yarıda GÖNDERME) → ekle / sonuncuyu sil /
//   baştan al → teyit (sesli özet, özet BİTTİKTEN sonra cevap) → gönderildi / iptal
//
// Bu modül [[paneDraft.cjs]]'in kardeşidir ve aynı disiplindedir: saf, Electron'suz
// (yaprak modül → `node --test` doğrudan yükler), main yalnız IPC + yayın ekler.
// Renderer'daki panel (widget) ve pop-out ayna bu defterin YAZDIRILMIŞ hâlidir —
// kopya değil. Pop-out AYRI bir renderer'dır (ADP-786 ölçümü: React state pencere
// değişiminde ölür); taslak burada yaşadığı için pencere geçişinde durur.
//
// ── DURUM MAKİNESİ (docs/design/AXP-01-DESIGN.md §3) ────────────────────────
//
//   idle       hiç taslak yok
//   draft      cümleler eklenir; her sonlandırılmış cümle EKLENİR, gönderilmez
//   paused     sessizlik: metin AYNEN durur; tek çıkış yeni cümle/düzenleme —
//              ⛔ buradan 'confirm'e GEÇİŞ YOKTUR (kilit test)
//   target     kapanış sözü geldi ama hedef yok → "Kime göndereyim?"
//   confirm    kapanış sözü geldi; sesli özet sorulur; cevap yalnız özet bittikten
//              (`spokenAt`) SONRA başlayan kayıttan sayılır — geç biten eski kayıt
//              onay DEĞİLDİR
//   (confirmed) → outcome olarak dışarı verilir, defter 'idle'a döner; taslak
//              `lastConfirmed` olarak teşhis için tutulur
//
// ── SÖZLEŞME ─────────────────────────────────────────────────────────────────
//   Tüketir  RouteDecision { cls:'prompt', target?, body? }        (AXP-01)
//   Üretir   DraftSnapshot { text, target, state, revision, … }     (bu dosya)
//            draft:confirmed { revision, digest, target, text }     (AXP-03 tüketir)
//
// Metin KIRPILMAZ (paneDraft ilkesi); tavan 16 000 karakter — aşınca teyit
// açılmaz, `notice:'limit'` düşer. Ses ve klavye AYNI defteri yazar: klavye
// `editText` ile, ses `hear` ile; ikisi de `revision`'ı ilerletir ve açık bir
// teyidi GEÇERSİZ kılar (değişen metne eski "evet" işlemez).

// i18n-exempt: intent-token — kontrol sözleri leksikondan gelir; burada yalnız
// ÖBEK desenleri (tırnak, "X yerine Y yaz", cümle sonundaki kapanış sözü) var.

const crypto = require('node:crypto');
const { DRAFT_CONTROL_WORDS, APPROVAL_ALLOW_WORDS, APPROVAL_DENY_WORDS } = require('./intentLexicon.cjs');

const DRAFT_LIMIT = 16_000;
/** Teyit özet cevabı beklenirken bu kadar sessizlik → taslağa dön ("Taslağın duruyor"). */
const CONFIRM_TIMEOUT_MS = 45_000;
/** Teyitte anlaşılmayan KISA cevap bir kez tekrar sorulur; ikincisi taslağa döner. */
const CONFIRM_REASK_MAX = 1;
/** Kısa cevap eşiği (ADP-919 kuralı: cevap denemesi kısadır, içerik uzundur). */
const SHORT_REPLY_TOKENS = 3;
/** İptal sonrası "geri al" penceresi. */
const UNDO_WINDOW_MS = 60_000;

// ── Metin yardımcıları ───────────────────────────────────────────────────────

/** Eşleşme için katla: küçük harf + aksan/ı düzleme (approvalVoice.foldForMatch ile aynı). */
function fold(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ı/g, 'i');
}
function tokenize(text) {
  return fold(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}
function containsSequence(hay, needle) {
  if (!needle.length || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i += 1) {
    let hit = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (hay[i + j] !== needle[j]) { hit = false; break; }
    }
    if (hit) return true;
  }
  return false;
}
function phraseTokens(group) {
  return [...group.tr, ...group.en].map((p) => tokenize(p)).filter((t) => t.length);
}
const FINISH = phraseTokens(DRAFT_CONTROL_WORDS.finish);
const REMOVE_LAST = phraseTokens(DRAFT_CONTROL_WORDS.removeLast);
const RESTART = phraseTokens(DRAFT_CONTROL_WORDS.restart);
const CANCEL = phraseTokens(DRAFT_CONTROL_WORDS.cancel);
const ADD_PREFIX = phraseTokens(DRAFT_CONTROL_WORDS.addPrefix);
const FIX = phraseTokens(DRAFT_CONTROL_WORDS.fix);
const ALLOW = phraseTokens(APPROVAL_ALLOW_WORDS);
const DENY = phraseTokens(APPROVAL_DENY_WORDS);
/**
 * Cevapta atılan dolgu (approvalVoice FILLER_TOKENS ile aynı sınıf). Set TEK jeton eşler:
 * AXP-11 — eski 'evet evet' girdisi tokenize'ın hiç üretmediği iki kelimelik bir jetondu (ÖLÜ);
 * tekrarlar artık `repeatedCoreIs` ile TEKİLLEŞTİRİLİR, dolgu listesine yazılmaz.
 */
const FILLER = new Set(['lutfen', 'hadi', 'peki', 'ya', 'yani', 'hmm', 'please', 'go']);
/**
 * AXP-11 — TEYİT dolgusu (ÖLÇÜLDÜ, Eren 19.09 gerçek Whisper: "Evet. Lan evet diyorum. Evet."):
 * onayın etrafındaki konuşma jestleri. Yalnız tekrar/dolgu indirgemesinde düşer; 'tamam' burada
 * DEĞİL — o bir onay sözüdür ve tekilleştirme zaten "tamam tamam"ı tek kalıba indirir.
 */
const CONFIRM_FILLER = new Set(['lan', 'diyorum', 'iste', 'hadi', 'ya', 'yani', 'sey', 'valla', 'aynen']);

/**
 * Jeton dizisinin TAMAMI verilen kalıplardan biri mi (dolgu hariç)?
 *
 * 🪤 ÖLÇÜLDÜ (real-voice.mjs, gerçek Whisper): "Sonuncuyu sil." → "sonuncuyusi" — STT iki
 * kelimeyi BİTİŞTİRDİ ve son harfi yuttu; kontrol sözü taslağa METİN olarak düştü.
 * Tolerans DAR ve ÖLÇÜLÜ: yalnız cümlenin tamamı kısaysa (≤ 3 jeton) ve bitişik
 * yazım en az 8 harfse, kalıpla boşluksuz düzenleme uzaklığı ≤ len/6 (8–11 harf → 1,
 * 12–17 → 2) kabul edilir — yalnız KISALMA yönünde (olumsuz ek eklenmiş biçim eşleşmez). "gönder" (6 harf) toleranssızdır: "gönderi" bir kelimedir.
 */
function wholeIs(tokens, phrases, extraSkip = []) {
  const skip = new Set([...FILLER, ...extraSkip.map((s) => fold(s))]);
  const core = tokens.filter((t) => !skip.has(t));
  if (!core.length) return false;
  if (phrases.some((p) => p.length === core.length && p.every((w, i) => w === core[i]))) return true;
  if (core.length > 3) return false;
  const joined = core.join('');
  if (joined.length < 8) return false;
  const budget = Math.floor(joined.length / 6);
  return phrases.some((p) => {
    const pj = p.join('');
    // Yalnız KISALMA tolere edilir (STT harf yutar, eklemez): "sonuncuyu silME" olumsuz
    // biçimi kalıptan UZUNDUR ve asla eşleşmez.
    return pj.length >= 8 && joined.length <= pj.length && pj.length - joined.length <= budget && editDistance(pj, joined) <= budget;
  });
}
/** Levenshtein — kısa dizgiler için (kontrol sözü toleransı). */
function editDistance(a, b) {
  const m = a.length; const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
/**
 * AXP-11 — TEKRAR + DOLGU indirgemesi: "Gönder. Gönder. Gönder." / "Gönder gönder." /
 * "Evet. Lan evet diyorum. Evet." → dolgu düşer, kalan jetonlar TEKİLLEŞİR; kalan küme
 * BOŞ DEĞİL ve tamamı tek-jetonlu kabul sözlerinden (`singles`) oluşuyorsa eşleşir.
 * `wholeIs` tam-dizi eşitliği ister; STT'nin doğal tekrarı 1 kalıbı 3 jetona çevirir ve
 * orada takılır (AXP-09 §2.1). Çok jetonlu kalıplar ("devam et") kasten kapsam dışı.
 */
function repeatedCoreIs(tokens, singles, extraSkip = []) {
  const skip = new Set([...FILLER, ...CONFIRM_FILLER, ...extraSkip.map((s) => fold(s))]);
  const distinct = new Set(tokens.filter((t) => !skip.has(t)));
  if (!distinct.size) return false;
  for (const t of distinct) if (!singles.has(t)) return false;
  return true;
}
function singlesOf(phrases) {
  return new Set(phrases.filter((p) => p.length === 1).map((p) => p[0]));
}
function startsWithPhrase(tokens, phrases) {
  let best = null;
  for (const p of phrases) {
    if (p.length <= tokens.length && p.every((w, i) => w === tokens[i])) {
      if (!best || p.length > best.length) best = p;
    }
  }
  return best;
}
function anyPhrase(tokens, phrases) {
  return phrases.some((p) => containsSequence(tokens, p));
}

/**
 * Açık tırnak var mı (agimen AX-24'ün doğru parçası, alındı). Tırnak içindeyken
 * hiçbir kontrol sözü çalışmaz — "'gönder' yazan düğme" bir metindir.
 * Türkçe kelime içi kesme ("Parker'ın") tırnak DEĞİLDİR.
 */
function hasOpenQuote(text) {
  let close = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if ((c === "'" || c === '’') && /[\p{L}\p{N}]/u.test(text[i - 1] || '') && /[\p{L}\p{N}]/u.test(text[i + 1] || '')) continue;
    if (close) { if (c === close) close = ''; continue; }
    if (c === '"' || c === "'" || c === '`') close = c;
    else if (c === '“' || c === '„') close = '”';
    else if (c === '‘') close = '’';
    else if (c === '«') close = '»';
  }
  return !!close;
}

/** Klavyeden gelen metni cümlelere böl ("sonuncuyu sil" bir cümle siler). */
function splitUnits(text) {
  return String(text ?? '')
    .split(/(?<=[.!?…])\s+|\n+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}
function joinUnits(units) {
  return units.join(' ');
}
function digestOf(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}
function preview(text, words = 12) {
  const w = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  return w.length <= words ? w.join(' ') : `${w.slice(0, words).join(' ')}…`;
}

// ── Defter ───────────────────────────────────────────────────────────────────

const STATES = Object.freeze(['idle', 'draft', 'paused', 'target', 'confirm']);

function emptyState() {
  return {
    state: 'idle',
    units: [],
    target: null,
    revision: 0,
    /** Açık teyit: { id, revision, spokenAt, reasks, openedAt, digest } */
    pending: null,
    /** Son geçici ipucu (UI çipi): appended|removed|restarted|clarify|limit|stale|kept|reask|cancelled|confirmed|null */
    notice: null,
    /** Son silinen parça (üstü çizili gösterim için). */
    lastRemoved: null,
    /** İptal edilen taslak (geri al penceresi). */
    undo: null,
    /** Teşhis: son onaylanan taslak. */
    lastConfirmed: null,
  };
}

let S = emptyState();
let seq = 0;

function snapshot() {
  const text = joinUnits(S.units);
  return {
    state: S.state,
    text,
    units: [...S.units],
    target: S.target ? { ...S.target } : null,
    revision: S.revision,
    pending: S.pending ? { id: S.pending.id, spokenAt: S.pending.spokenAt, revision: S.pending.revision } : null,
    notice: S.notice,
    lastRemoved: S.lastRemoved,
    canUndo: !!S.undo,
    limit: DRAFT_LIMIT,
    overLimit: text.length > DRAFT_LIMIT,
    unitCount: S.units.length,
  };
}

/** Değişiklik = yeni revizyon; açık teyit GEÇERSİZ olur. */
function bump(notice) {
  S.revision += 1;
  S.pending = null;
  if (notice !== undefined) S.notice = notice;
}
function result(outcome, changed = true) {
  return { ok: true, changed, outcome, snapshot: snapshot() };
}

function getDraft() {
  return snapshot();
}

/**
 * Niyet yönlendiricisinin `prompt` kararı taslağı AÇAR. Gövde varsa ilk parça
 * olarak eklenir; hedef verilmişse yazılır (açık taslakta hedef boşsa doldurur,
 * doluysa KORUNUR — kullanıcı konuşurken hedef sessizce değişmez).
 */
function openDraft(route, opts = {}) {
  const r = route && typeof route === 'object' ? route : {};
  if (r.cls && r.cls !== 'prompt') return { ok: false, error: 'route prompt değil', outcome: { kind: 'ignored' }, snapshot: snapshot() };
  const wasIdle = S.state === 'idle';
  if (wasIdle) {
    S = { ...emptyState(), lastConfirmed: S.lastConfirmed };
  }
  if (r.target && (r.target.agentId || r.target.role || r.target.teamId) && !S.target) {
    S.target = normalizeTarget(r.target);
  }
  const body = typeof r.body === 'string' ? r.body.trim() : '';
  if (body) S.units.push(body);
  S.state = 'draft';
  S.undo = null;
  bump(body ? 'appended' : null);
  void opts;
  return result({ kind: wasIdle ? 'opened' : 'appended', appended: body || null });
}

function normalizeTarget(t) {
  if (!t || typeof t !== 'object') return null;
  const out = {};
  for (const k of ['agentId', 'agentLabel', 'role', 'teamId', 'teamLabel', 'paneKey']) {
    if (typeof t[k] === 'string' && t[k]) out[k] = t[k];
  }
  return Object.keys(out).length ? out : null;
}

function setTarget(target) {
  if (S.state === 'idle') return { ok: false, error: 'taslak yok', outcome: { kind: 'ignored' }, snapshot: snapshot() };
  const next = normalizeTarget(target);
  if (JSON.stringify(next) === JSON.stringify(S.target)) return result({ kind: 'unchanged' }, false);
  S.target = next;
  bump();
  // HEDEF SORUSU'ndayken hedef geldi → teyide geç (kapanış sözü zaten söylenmişti).
  if (S.state === 'target' && next) return openConfirm(Date.now());
  return result({ kind: 'target' });
}

/** Klavye: metnin tamamı yeniden yazıldı. Ses ve klavye AYNI defter. */
function editText(text) {
  if (S.state === 'idle') {
    // Klavyeden sıfırdan taslak: kullanıcı yazmaya başladı, taslak açılır.
    S = { ...emptyState(), lastConfirmed: S.lastConfirmed };
  }
  const units = splitUnits(text);
  if (joinUnits(units) === joinUnits(S.units) && S.state !== 'confirm') return result({ kind: 'unchanged' }, false);
  S.units = units;
  S.state = 'draft';
  S.lastRemoved = null;
  bump(null);
  return result({ kind: 'edited' });
}

/** Sessizlik: taslak DURAKSAR. Başka hiçbir şey değişmez — özellikle teyit AÇILMAZ. */
function pause(at = Date.now()) {
  void at;
  if (S.state !== 'draft') return result({ kind: 'ignored' }, false);
  S.state = 'paused';
  S.notice = 'paused';
  return result({ kind: 'paused' });
}

/**
 * Kayıt hiç ses duymadan kapandı. Taslakta = duraksama; teyitte = cevap gelmedi
 * (iki kez → taslağa dön, "Taslağın duruyor"). Hiçbir dalda gönderme yok.
 */
function noSpeech(at = Date.now()) {
  if (S.state === 'draft') return pause(at);
  if (S.state === 'confirm' && S.pending) {
    S.pending.silences = (S.pending.silences || 0) + 1;
    if (S.pending.silences >= 2) return keepDraft();
    return result({ kind: 'waiting' }, false);
  }
  return result({ kind: 'ignored' }, false);
}

function keepDraft() {
  S.pending = null;
  S.state = 'draft';
  S.notice = 'kept';
  return result({ kind: 'kept' });
}

/** Kapanış sözü / Gönder düğmesi: hedef yoksa HEDEF SORUSU, varsa TEYİT. */
function finish(at = Date.now()) {
  if (S.state === 'idle') return { ok: false, error: 'taslak yok', outcome: { kind: 'ignored' }, snapshot: snapshot() };
  if (S.state === 'confirm' && S.pending) return result({ kind: 'confirm', pending: pendingView() }, false);
  const text = joinUnits(S.units);
  if (!text.trim()) { S.notice = 'empty'; return result({ kind: 'empty' }); }
  if (text.length > DRAFT_LIMIT) { S.notice = 'limit'; return result({ kind: 'limit' }); }
  if (hasOpenQuote(text)) { S.notice = 'clarify'; return result({ kind: 'clarify', reason: 'open-quote' }); }
  if (!S.target) { S.state = 'target'; S.notice = null; return result({ kind: 'target-needed' }); }
  return openConfirm(at);
}

function openConfirm(at) {
  const text = joinUnits(S.units);
  seq += 1;
  S.pending = {
    id: `d${Date.now().toString(36)}-${seq}`,
    revision: S.revision,
    spokenAt: null,
    reasks: 0,
    silences: 0,
    openedAt: at,
    digest: digestOf(text),
  };
  S.state = 'confirm';
  S.notice = null;
  return result({ kind: 'confirm', pending: pendingView() });
}

function pendingView() {
  const text = joinUnits(S.units);
  return {
    id: S.pending.id,
    revision: S.pending.revision,
    target: S.target ? { ...S.target } : null,
    unitCount: S.units.length,
    preview: preview(text),
    text,
  };
}

/** TTS özeti BİTTİ: bundan ÖNCE başlayan hiçbir kayıt cevap sayılmaz. */
function markSpoken(id, at = Date.now()) {
  if (!S.pending || S.pending.id !== id) return result({ kind: 'ignored' }, false);
  S.pending.spokenAt = at;
  return result({ kind: 'spoken' }, false);
}

/** Düğme: Gönder / Düzenle / Vazgeç. Düğme ekrandadır, spokenAt kapısı ses içindir. */
function resolve(id, choice, at = Date.now()) {
  if (S.state !== 'confirm' || !S.pending || S.pending.id !== id) return { ok: false, error: 'teyit yok', outcome: { kind: 'ignored' }, snapshot: snapshot() };
  if (S.pending.revision !== S.revision) { S.pending = null; S.state = 'draft'; S.notice = 'changed'; return result({ kind: 'changed' }); }
  if (choice === 'send' || choice === true) return confirmNow(at);
  if (choice === 'cancel') return cancel(at);
  S.pending = null;
  S.state = 'draft';
  S.notice = null;
  return result({ kind: 'edit' });
}

function confirmNow(at) {
  const text = joinUnits(S.units);
  const confirmed = {
    id: S.pending.id,
    revision: S.revision,
    digest: digestOf(text),
    target: S.target ? { ...S.target } : null,
    text,
    unitCount: S.units.length,
    at,
  };
  S.lastConfirmed = confirmed;
  S = { ...emptyState(), lastConfirmed: confirmed, notice: 'confirmed' };
  return { ok: true, changed: true, outcome: { kind: 'confirmed', confirmed }, snapshot: snapshot() };
}

function cancel(at = Date.now()) {
  if (S.state === 'idle') return result({ kind: 'ignored' }, false);
  const text = joinUnits(S.units);
  const undo = text ? { units: [...S.units], target: S.target, at } : null;
  S = { ...emptyState(), lastConfirmed: S.lastConfirmed, undo, notice: 'cancelled' };
  return result({ kind: 'cancelled', canUndo: !!undo });
}

function undoCancel(at = Date.now()) {
  if (!S.undo || S.state !== 'idle') return result({ kind: 'ignored' }, false);
  if (at - S.undo.at > UNDO_WINDOW_MS) { S.undo = null; return result({ kind: 'expired' }); }
  S.units = [...S.undo.units];
  S.target = S.undo.target;
  S.undo = null;
  S.state = 'draft';
  bump('restored');
  return result({ kind: 'restored' });
}

/** Zaman nöbeti: teyit cevabı gelmezse taslağa dön; geri-al penceresi biter. */
function tick(at = Date.now()) {
  if (S.state === 'confirm' && S.pending && at - S.pending.openedAt >= CONFIRM_TIMEOUT_MS) return keepDraft();
  if (S.undo && at - S.undo.at > UNDO_WINDOW_MS) { S.undo = null; return result({ kind: 'undo-expired' }); }
  return result({ kind: 'idle' }, false);
}

// ── Ses: sonlandırılmış bir cümle geldi ─────────────────────────────────────

/** Tek jetonluk onay sözleri ("evet", "tamam", "olur"…): kapanış sözünün önünde dolgu sayılır. */
const SINGLE_ALLOW = singlesOf(ALLOW);
/** Tek jetonluk kapanış sözleri ("gönder", "ilet", "bitti"…). */
const SINGLE_FINISH = singlesOf(FINISH);
/** Teyitte kabul: onay ∪ kapanış tek-jeton kalıpları (AXP-11 tekrar/dolgu indirgemesi için). */
const CONFIRM_SINGLES = new Set([...SINGLE_ALLOW, ...SINGLE_FINISH]);
/**
 * Onay öneki düşünce kalan KAPANIŞ sözü mü? "tamam bitti" / "evet gönder" / "tamam. gönder."
 * → evet. Önek TEK BAŞINA ("tamam") eşleşmez: core boş kalır. Teyitte de taslakta da aynı.
 */
function finishAfterAllowPrefix(tokens, addressTokens) {
  const core = tokens.filter((t) => !SINGLE_ALLOW.has(t));
  return core.length > 0 && core.length < tokens.length && wholeIs(core, FINISH, addressTokens);
}
function classifyReply(tokens, addressTokens) {
  // RET ÖNCE: "hayır gönderme" içinde 'gönderme' değil 'hayır' hüküm verir (AXP-11 kontrol kolu).
  if (anyPhrase(tokens, DENY)) return 'deny';
  if (anyPhrase(tokens, FIX)) return 'fix';
  // Onay yalnız cümlenin TAMAMI onaysa: "tamam şunu da ekle" bir onay değildir.
  if (wholeIs(tokens, ALLOW, addressTokens)) return 'allow';
  // "Göndereyim mi?" sorusuna "gönder" / "evet gönder" / "tamam ilet" de EVET'tir
  // (kapanış sözü teyitte onaydır; "evet"+kapanış = onay).
  if (finishAfterAllowPrefix(tokens, addressTokens)) return 'allow';
  if (wholeIs(tokens, FINISH, addressTokens)) return 'allow';
  // AXP-11 — doğal tekrar + dolgu: "Gönder. Gönder. Gönder." / "Evet. Lan evet diyorum. Evet."
  // → {gonder} / {evet} ⊆ onay∪kapanış → onay. "evet ama şunu da ekle" → 'ama','ekle' ∉ küme → unclear.
  if (repeatedCoreIs(tokens, CONFIRM_SINGLES, addressTokens)) return 'allow';
  return 'unclear';
}

/**
 * Sonlandırılmış cümle. `startedAt` = KAYDIN başladığı an (transkriptin geldiği an
 * değil). Dönüş `outcome.kind`:
 *   pass            taslak yok — normal komut yoluna
 *   appended        eklendi (draft)
 *   removed         sonuncu silindi · restarted · cancelled
 *   target-needed   kapanış sözü geldi, hedef yok
 *   target-answer   HEDEF SORUSU'na cevap — çağıran roster'dan çözer, setTarget çağırır
 *   confirm         teyit açıldı (özet söylenecek, sonra markSpoken)
 *   confirmed       "evet" → gönder (payload `confirmed`)
 *   edit            "hayır/düzelt" → taslağa dönüldü
 *   stale           özet bitmeden başlayan kayıt — YOK SAYILDI
 *   reask           kısa anlaşılmayan cevap, bir kez tekrar sor
 *   kept            (reason:'unclear') ikinci kısa anlaşılmayan cevap — taslağa dönüldü, cevap YAZILMADI
 *   clarify / limit
 */
function hear(text, opts = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return result({ kind: 'ignored' }, false);
  if (S.state === 'idle') return result({ kind: 'pass' }, false);
  const at = typeof opts.at === 'number' ? opts.at : Date.now();
  const startedAt = typeof opts.startedAt === 'number' ? opts.startedAt : at;
  const addressTokens = Array.isArray(opts.addressTokens) ? opts.addressTokens : [];
  const tokens = tokenize(raw);
  const inQuote = hasOpenQuote(joinUnits(S.units));

  // ── TEYİT: yalnız özet bittikten SONRA başlayan kayıt cevaptır ──────────
  if (S.state === 'confirm' && S.pending) {
    const p = S.pending;
    if (p.spokenAt === null || startedAt <= p.spokenAt) {
      S.notice = 'stale';
      return result({ kind: 'stale', reason: p.spokenAt === null ? 'not-spoken-yet' : 'started-before-summary' });
    }
    const cls = classifyReply(tokens, addressTokens);
    if (cls === 'allow') return confirmNow(at);
    if (cls === 'deny') {
      // "vazgeç"/"iptal" taslağı BIRAKIR; "hayır"/"olmaz" taslağa DÖNER (ret ≠ iptal).
      if (wholeIs(tokens, CANCEL, addressTokens)) return cancel(at);
      S.pending = null; S.state = 'draft'; S.notice = null;
      return result({ kind: 'edit' });
    }
    if (cls === 'fix') { S.pending = null; S.state = 'draft'; S.notice = null; return result({ kind: 'edit' }); }
    // Anlaşılmadı: KISA cevap → bir kez tekrar sor; hakkı bitince taslağa DÖN ama
    // cevabı YAZMA (AXP-11: "Evet. Lan evet diyorum. Evet." taslağa metin olmuştu —
    // kısa cevap HİÇBİR koşulda eklenmez). Uzun cümle → kullanıcı devam ediyor,
    // taslağa dön ve ekle (sessiz düşüş yok, metin kaybı yok).
    if (tokens.length <= SHORT_REPLY_TOKENS) {
      if (p.reasks < CONFIRM_REASK_MAX) {
        p.reasks += 1;
        p.spokenAt = null; // tekrar soru söylenecek; yeni damga gelecek
        S.notice = 'reask';
        return result({ kind: 'reask', pending: pendingView() });
      }
      // `kind:'kept'` + `reason:'unclear'` — renderer 'kept' dalında "Taslağın duruyor." der ve
      // cevap penceresini açar; yeni bir kind (`kept-unclear`) bugünkü renderer'da SESSİZ düşerdi.
      const r = keepDraft();
      return { ...r, outcome: { ...r.outcome, reason: 'unclear' } };
    }
    S.pending = null; S.state = 'draft';
    return append(raw, 'appended-from-confirm');
  }

  // ── HEDEF SORUSU: cümle hedef adayıdır, çözüm çağıranda ──────────────────
  if (S.state === 'target') {
    if (!inQuote && wholeIs(tokens, CANCEL, addressTokens)) return cancel(at);
    return result({ kind: 'target-answer', text: raw }, false);
  }

  // ── TASLAK / DURAKSAMA ────────────────────────────────────────────────────
  if (!inQuote) {
    if (wholeIs(tokens, CANCEL, addressTokens)) return cancel(at);
    // Kesme sınıfı ("dur", "bekle", "sus"): çağıran STOP leksikonundan tanıdı. Taslağa
    // YAZILMAZ; iptal değilse yalnız DURAKSAR (metin aynen durur).
    if (opts.control === 'stop') return pause(at);
    if (wholeIs(tokens, RESTART, addressTokens) || anyPhrase(tokens, RESTART)) {
      S.units = []; S.lastRemoved = null; S.state = 'draft'; bump('restarted');
      return result({ kind: 'restarted' });
    }
    if (wholeIs(tokens, REMOVE_LAST, addressTokens)) {
      if (!S.units.length) { S.state = 'draft'; S.notice = 'empty'; return result({ kind: 'empty' }); }
      S.lastRemoved = S.units.pop(); S.state = 'draft'; bump('removed');
      return result({ kind: 'removed', removed: S.lastRemoved });
    }
    // "X" yerine "Y" yaz · "X" kısmını çıkar — tırnaklı, deterministik; tek eşleşme şart.
    const replacement = raw.match(/^(?:hayır[, ]+)?["“]([^"”]+)["”]\s+yerine\s+["“]([^"”]*)["”]\s+(?:yaz|koy|değiştir|olsun)[.!]?$/iu);
    const removal = raw.match(/^(?:hayır[, ]+)?["“]([^"”]+)["”]\s+(?:kısmını\s+|kelimesini\s+)?(?:çıkar|sil|kaldır)[.!]?$/iu);
    const from = replacement?.[1] ?? removal?.[1];
    if (from !== undefined) {
      const text = joinUnits(S.units);
      const first = text.indexOf(from);
      if (first < 0 || text.indexOf(from, first + from.length) >= 0) { S.state = 'draft'; S.notice = 'clarify'; return result({ kind: 'clarify', reason: first < 0 ? 'not-found' : 'ambiguous' }); }
      const next = text.slice(0, first) + (replacement?.[2] ?? '') + text.slice(first + from.length);
      S.units = splitUnits(next.replace(/\s{2,}/g, ' ')); S.state = 'draft'; bump('edited');
      return result({ kind: 'replaced' });
    }
    // Kapanış sözü cümlenin TAMAMI → bitir.
    if (wholeIs(tokens, FINISH, addressTokens)) return finish(at);
    // AXP-11 — "Tamam bitti." / "Tamam. Gönder." (onay öneki + kapanış) ve "Gönder. Gönder."
    // (tekrar) de kapanıştır; önek/tekrar taslağa METİN olarak yazılmaz. Yalnız 'tamam' metindir.
    if (finishAfterAllowPrefix(tokens, addressTokens) || repeatedCoreIs(tokens, SINGLE_FINISH, addressTokens)) return finish(at);
    // Kapanış sözü cümlenin SONUNDA ("…karta ekle, gönder") → gövde eklenir, son söz tetikler.
    const ending = raw.match(/^([\s\S]*[.!?,;…])\s+([^.!?,;]+?)[.!?]?$/u);
    if (ending && wholeIs(tokenize(ending[2]), FINISH, addressTokens) && !hasOpenQuote(ending[1])) {
      append(ending[1].replace(/[,;]\s*$/u, '').trim(), 'appended');
      return finish(at);
    }
    // "şunu da ekle …" ön eki: kalan metindir.
    const pre = startsWithPhrase(tokens, ADD_PREFIX);
    if (pre && tokens.length > pre.length) {
      const rest = stripLeadingPhrase(raw, pre);
      if (rest) return append(rest, 'appended');
    }
  }
  return append(raw, 'appended');
}

/** Ön eki HAM metinden düşür (jeton sayısı kadar kelime atılır; noktalama korunur). */
function stripLeadingPhrase(raw, phrase) {
  const words = raw.split(/\s+/);
  let n = 0; let consumed = 0;
  for (const w of words) {
    const toks = tokenize(w);
    n += toks.length; consumed += 1;
    if (n >= phrase.length) break;
  }
  return words.slice(consumed).join(' ').replace(/^[:,\-–—]\s*/u, '').trim();
}

function append(text, notice) {
  const t = String(text ?? '').trim();
  if (!t) return result({ kind: 'ignored' }, false);
  S.units.push(t);
  S.lastRemoved = null;
  S.state = 'draft';
  bump(notice);
  const over = joinUnits(S.units).length > DRAFT_LIMIT;
  if (over) S.notice = 'limit';
  return result({ kind: 'appended', appended: t, overLimit: over });
}

/** Test yardımcısı — defteri boşalt. */
function resetDraft() {
  S = emptyState();
  seq = 0;
}

module.exports = {
  DRAFT_LIMIT,
  CONFIRM_TIMEOUT_MS,
  UNDO_WINDOW_MS,
  STATES,
  getDraft,
  openDraft,
  setTarget,
  editText,
  hear,
  pause,
  noSpeech,
  finish,
  markSpoken,
  resolve,
  cancel,
  undoCancel,
  tick,
  resetDraft,
  // saf yardımcılar (test + renderer köprüsü)
  hasOpenQuote,
  splitUnits,
  digestOf,
  preview,
};
