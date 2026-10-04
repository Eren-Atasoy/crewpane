// AXP-01 (jazz) — NİYET YÖNLENDİRİCİ: her cümle DÖRT sınıftan birine düşer.
//
//   aksiyon  → uygulamanın kendi düğmesi (tema/dil/sekme/terminal/tarayıcı…) — BUGÜNKÜ
//              yol aynen koşar, bu modül ona DOKUNMAZ.
//   prompt   → bir ajana / role / takıma İŞ VERME niyeti. Cümle terminale YAZILMAZ;
//              karar `RouteDecision` olarak taşınır (AXP-02 taslak akışı bunu tüketir,
//              AXP-01 köprüsü mevcut teslim ilkeline bağlar — src/app/lib/jarvisVoice.ts).
//   belirsiz → iş var ama alıcı belirsiz / aksiyon fiili ile iletim fiili birlikte /
//              yalnız bir ad → TEK SORU, İKİ SEÇENEK. Yan etki YOK. "Anladım" YOK.
//   yok      → olumsuz cümle ("…ma/me", "kimseye", "hiçbir şey") → hiçbir şey; kısa
//              sesli onay ("Tamam, dokunmadım.").
//
// KÖK BULGU (AXP-00 §1.1): üründe "prompt" diye bir sınıf YOKTU — hedefli cümle kural
// yolunda `tell` olup ANINDA pane'e yazılıyordu ("Stark'a bir iş vereceğim" cümlesinin
// kendisi Stark'ın terminaline düşüyordu). Ve "kim / ne / nasıl teslim" üç katmanda üç
// ayrı gerçekti (§1.2): beyin hedefi bulsa bile yürütücü-politika onu YENİDEN türetip
// "Kime, ne iletmemi istiyorsun?" diye soruyordu (agimen döngüsü). Bu modül TEK karar
// noktasıdır: kararı verir, sonraki katmanlar onu TAŞIR, yeniden türetmez.
//
// KARAR SIRASI (docs/design/AXP-01-DESIGN.md §2.2 — deterministik, beyinden ÖNCE ve
// beyinden BAĞIMSIZ):
//   1. kontrol komutu (dur/uyu — kısa cümle)                      → verdict YOK (kapı dışı)
//   2. olumsuzlama (negV · kimseye · hiçbir şey) ∧ ¬"sen yap"      → yok
//   3. aksiyon kataloğu TAM eşleşme (parseIntent somut eylem ∨ kayıtlı ayar kontrolü)
//      ↳ istisna: ajan/rol/takım + iletim fiili | "de ki" | "için bir iş" | 3.tekil emir → 4
//   4. prompt işaretleri (hedef+iletim fiili · hedef+"de ki"/"için iş"/":" · hitap+emir ·
//      niyet beyanı "iş/görev vereceğim")                          → prompt
//   5. aksiyon sözcüğü + iletim/sor fiili · yalnız ad · iş gövdesi var alıcı yok → belirsiz
//   6. hiçbiri → verdict YOK: beyin karar verir. `mergeBrain` beyin `tell/delegate` derse
//      bunu `prompt` olarak ALIR (hedefi de alır — yeniden türetmez).
//
// Kural ↔ beyin çelişkisi (§2.2 son satır): kural `aksiyon`, beyin `tell` → `belirsiz`
// (şüphede eylem yok — ADP-854 §4 asimetrisi: yanlış eylem pahalı, bir soru ucuz).
//
// SAF: I/O yok, Electron yok. Katalog kararı (parseIntent çıktısı) DIŞARIDAN verilir —
// döngüsel require olmasın ve testler sahte katalogla da koşabilsin.
//
// ADP-885/st1 — i18n-exempt: intent-token. Buradaki Türkçe desenler ARAYÜZ METNİ DEĞİL,
// kullanıcının SÖYLEDİĞİ ifade kalıplarıdır. Kelime kümeleri `intentLexicon.cjs`te
// (PROMPT_ROUTER); burada yalnız ÖBEK desenleri yaşar. Sorular (`question.text`) ise
// asistanın SÖYLEDİĞİ metindir ve `parseIntent`in soru metinleriyle aynı sınıftadır.

'use strict';

const morph = require('../voice/turkishMorph.cjs');
const entityResolve = require('../services/entityResolve.cjs');
const fanoutPolicy = require('./fanoutPolicy.cjs');
const uiControls = require('../services/uiControls.cjs');
const {
  ACTION_VERB_STEMS: STEMS,
  LONG_VERB_STEMS,
  HANDOFF_VERB_STEMS,
  TEAM_NOUN_STEMS,
  STOP_VERB_STEMS,
  STOP_NOUN_STEMS,
  STOP_PHRASES,
  SLEEP_POSITIVE_STEMS,
  SLEEP_PHRASES,
  PROMPT_ROUTER,
} = require('./intentLexicon.cjs');

/** Sınıf adları — sözleşme (RouteDecision.cls). */
const CLS = Object.freeze({ ACTION: 'aksiyon', PROMPT: 'prompt', UNCLEAR: 'belirsiz', NONE: 'yok' });

/** Katalogda "somut eylem" SAYILMAYAN kararlar (beyin/yönlendirici alanı). */
const NON_CATALOG_ACTIONS = new Set(['reply', 'tell', 'delegate', 'self', 'prompt']);
/**
 * Adım 3 istisnasının UYGULANABİLDİĞİ katalog eylemleri: bunlar ajan adını "yanlış okumuş"
 * olabilir ("Romanoff ARAŞTIRSIN" → browser/search). `board/agent/office/terminal/status/
 * report/sprint/memory` ise ajan adını KENDİ parametresi olarak tüketir ("Ratchet'e ADP-854'ü
 * ata" = pano ataması) — orada istisna YOK, katalog kazanır.
 */
const EXCEPTION_ELIGIBLE = new Set(['browser', 'navigate', 'spawn', 'input', 'screen', 'settings', 'chain']);

/** OLUMSUZLAMA için sorulan fiil grupları (leksikon anahtarları). */
const NEGATABLE_GROUPS = [
  'delegateVerb', 'tellVerb', 'giveVerb', 'askVerb', 'open', 'close', 'goto', 'show', 'scroll',
  'read', 'summarize', 'search', 'click', 'write', 'create', 'focus', 'change', 'mark',
];

// ── Öbek desenleri (kelimeler leksikonda; burada yalnız BİÇİM) ──────────────

/** "X'a DE Kİ …" — iletim kalıbı (fiil "de" tek başına çok kısa, öbek olarak aranır). */
const SAY_THAT_RE = /(^|\s)de\s+ki(\s|$)/;
/** Yönelme/"için" + [sıfat] + iş/görev — "Wanda için bir iş:", "Vision'a küçük bir iş". */
const JOB_PHRASE_RE = new RegExp(
  `(?:için|['’]y?[ae]|['’]n[ae])\\s+(?:(?:${anyOf(PROMPT_ROUTER.jobAdjs)})\\s+){0,2}(?:${anyOf(PROMPT_ROUTER.jobNouns)})(?:\\s|:|$)`,
);
/** 3. tekil emir eki: "düzeltSİN", "araştırSIN", "gelSİNLER". */
const THIRD_PERSON_RE = /^[a-zçğıöşü]{2,}s[ıiuü]n(?:l[ae]r)?$/;
/**
 * AXP-06 EK(b) — RİCA soru eki: "söyler MİSİN", "iletir MİSİNİZ", "sorar MISIN". İletim fiilinin
 * hemen ardından gelirse cümle SORU DEĞİL İLETİMDİR ("X'e söyler misin?" = "X'e söyle"); gövde bu
 * ekten ve onu izleyen "?"den SONRA başlar; rica tek başınaysa gövde YOK (taslak hedefli açılır).
 * "söyleDİN Mİ?" (geçmiş zaman + ayrı "mi") bu kalıba GİRMEZ — o bilgi sorusudur, beyin cevaplar.
 */
const POLITE_SUFFIX_RE = /^m[ıiuü]s[ıiuü]n(?:[ıiuü]z)?$/;
/** Soru cümlesi: soru işareti · soru eki · soru sözcüğü (jeton düzeyinde; kelimeler leksikonda). */
const QUESTION_TOKENS = new Set(PROMPT_ROUTER.questionWords);
/** Kesme işaretinden kopan hâl ekleri — "Parker'ın" → ['parker','ın']: bu bir HİTAP değildir. */
const CASE_SUFFIX_TOKENS = new Set(PROMPT_ROUTER.caseSuffixes);
/** Takım yönelme hâli — "ChatFlow TAKIMINA dağıt" (takım kelimesi işin parçası olabilir; yönelme şart). */
const TEAM_DATIVE_RE = new RegExp(`(?:${anyOf(TEAM_NOUN_STEMS)})[ıiu]?n?[ae](?:\\s|$)`);
/** Değiştirme fiilleri — kayıtlı ayar kontrolü + bu fiil = aksiyon (değer beyinde çözülse bile). */
const CHANGE_CUE_RE = /(yap|değiştir|degistir|çevir|cevir|geç|gec\b|olsun|al\b|ayarla|aç\b)/;

function escRe(w) {
  return String(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function anyOf(words) {
  return words.map(escRe).join('|');
}

function hasV(toks, key) {
  return STEMS[key] ? morph.hasVerb(toks, STEMS[key]) : false;
}
function negV(toks, key) {
  return STEMS[key] ? morph.hasNegatedVerb(toks, STEMS[key]) : false;
}

// ── Yardımcılar ─────────────────────────────────────────────────────────────

/** Adım 1 — kontrol komutu mu? (kısa cümle, tamamı kesme/uyku sözcüğü) */
function isControlUtterance(low, toks) {
  if (toks.length === 0) return true;
  if (STOP_PHRASES.some((p) => low === p) || SLEEP_PHRASES.some((p) => low === p)) return true;
  if (toks.length > 2) return false;
  const stopHit = morph.verbHit(toks, STOP_VERB_STEMS);
  const sleepHit = morph.verbHit(toks, SLEEP_POSITIVE_STEMS);
  const nounHit = toks.some((t) => STOP_NOUN_STEMS.includes(t));
  return !!((stopHit && !stopHit.negated) || (sleepHit && !sleepHit.negated) || nounHit);
}

/** "sen yap / kendin bak" — kullanıcı UYGULAMADA yapılmasını söyledi. */
function hasSelfPhrase(low) {
  return PROMPT_ROUTER.selfPhrases.some((p) => low.includes(p));
}

/**
 * Adım 2 — olumsuz kutup.
 *
 * 🪤 "-ma/-me" hem OLUMSUZ EMİR hem FİİLDEN İSİM ekidir: "sayfayı okuMA" (emir) ama
 * "araMA kutusuna yaz" (isim). turkishMorph yalnız "arama YAP" (yardımcı fiil) ayrımını
 * bilir. Yönlendirici ikinci bir sinyal ister: olumsuz emir yan cümleyi BİTİRİR — ardından
 * ya hiçbir şey, ya noktalama, ya da bir kuyruk sözcüğü ("şimdilik") gelir. Ardından
 * çekimli bir isim geliyorsa ("kutusuna", "kurallarını") fiil değil isimdir → kutup değil.
 */
function isNegated(text, low, toks) {
  if (toks.some((t) => PROMPT_ROUTER.noneWords.includes(t))) return true;
  const spans = tokenSpans(low);
  for (let i = 0; i < toks.length; i++) {
    for (const g of NEGATABLE_GROUPS) {
      const stems = STEMS[g];
      if (!stems) continue;
      const neg = stems.some((st) => morph.classifyToken(toks[i], st) === 'negative');
      if (!neg) continue;
      if (morph.isLightVerbToken(toks[i + 1])) continue; // "arama yap" — birleşik fiil
      const after = spans[i] ? low.slice(spans[i].end).replace(/^\s+/, '') : '';
      if (!after || /^[,.;:!?…—–-]/.test(after)) return true;
      if (PROMPT_ROUTER.negTails.includes(toks[i + 1])) return true;
    }
  }
  return false;
}

/** Jetonların küçültülmüş metindeki [start,end) konumları (jeton sırası `morph.tokens` ile aynı). */
function tokenSpans(low) {
  const out = [];
  const re = /[a-zçğıöşü0-9]+/g;
  let m;
  while ((m = re.exec(low)) !== null) out.push({ start: m.index, end: m.index + m[0].length });
  return out;
}

function isQuestion(text, toks) {
  if (/\?\s*$/.test(text)) return true;
  return toks.some((t) => QUESTION_TOKENS.has(t));
}

/** Cümlede bir 3. tekil emir (-sin/-sın) var mı? Ölçülen yanlış-pozitif freni: thirdPersonDeny. */
function hasThirdPersonImperative(toks) {
  return toks.some((t) => THIRD_PERSON_RE.test(t) && !PROMPT_ROUTER.thirdPersonDeny.includes(t));
}

/** İş fiili (belirsiz sınıfı için): ADP-857 uzun-iş kökleri ∪ yönlendirici ekleri. */
function hasWorkVerb(toks) {
  return morph.hasVerb(toks, LONG_VERB_STEMS) || morph.hasVerb(toks, PROMPT_ROUTER.workVerbs);
}

/** İletim fiili: söyle/ilet/yolla/gönder · ver/ata/devret · yaptır/hallet/çalıştır/başlat · dağıt. */
function hasTransferVerb(toks) {
  return hasV(toks, 'tellVerb') || hasV(toks, 'giveVerb') || hasV(toks, 'delegateVerb') || morph.hasVerb(toks, HANDOFF_VERB_STEMS);
}

/**
 * İletim/sor fiili + hemen ardından rica eki ("söyler misin") → o fiilin vuruşu; yoksa null.
 * Soru sayılmaz (adım 4'e girer) ve gövde çıkarımı eki atlar.
 */
function politeRequestHit(toks) {
  const hit =
    morph.verbHit(toks, STEMS.tellVerb) || morph.verbHit(toks, STEMS.giveVerb) || morph.verbHit(toks, STEMS.delegateVerb) ||
    morph.verbHit(toks, HANDOFF_VERB_STEMS) || morph.verbHit(toks, STEMS.askVerb);
  if (!hit || hit.negated) return null;
  const next = toks[hit.index + 1];
  return next && POLITE_SUFFIX_RE.test(next) ? hit : null;
}

/** Niyet beyanı: "(bir) görev/iş VERECEĞİM" — fiil + iş ismi, gövde henüz yok. */
function hasIntentDeclaration(toks) {
  return hasV(toks, 'giveVerb') && morph.hasNoun(toks, PROMPT_ROUTER.jobNouns);
}

/**
 * HİTAP: cümle bir ajan adıyla BAŞLIYOR ve ad çekimsiz ("Barton, …", "Parker şu hatayı…").
 * "Parker'ın terminalini" (tamlayan) ve "Stark ile" (edat) hitap DEĞİLDİR.
 */
function isVocative(toks, who) {
  if (!who || !who.id || toks.length < 2) return false;
  const first = toks[0];
  const name = morph.trLower(who.matchedName || who.id);
  if (first !== name && morph.editDistance(first, name, 1) > 1) return false;
  const second = toks[1];
  if (CASE_SUFFIX_TOKENS.has(second)) return false;
  return true;
}

/**
 * Takım hedefi: "ChatFlow takımına …" → departman id (yalnız YÖNELME hâlinde — "Jazz'a
 * söyle regresyon takımını koşsun" cümlesinde takım işin parçasıdır, hedef değil).
 */
function detectTeamTarget(low, context) {
  if (!TEAM_DATIVE_RE.test(low)) return null;
  const depts = Array.isArray(context.departments) ? context.departments : [];
  for (const d of depts) {
    if (!d) continue;
    const cands = [d.id, d.label, d.shortLabel].filter(Boolean).map((x) => morph.trLower(x));
    if (cands.some((c) => c.length > 2 && low.includes(c))) return d.id;
    const label = morph.trLower(d.label || '');
    for (const tok of label.split(/\s+/)) {
      if (tok.length > 3 && !['crewpane', 'takım', 'takim', 'ekip'].includes(tok) && low.includes(tok)) return d.id;
    }
  }
  // Takım yönelmesi var ama hangi takım söylenmedi ("takıma dağıt") → aktif takım.
  return context.defaultDepartment || null;
}

/**
 * İŞ GÖVDESİ: cümleden hitap/iletim öbeği çıkarılınca kalan metin. Bulunamazsa null
 * (niyet beyanı: "Stark'a bir iş vereceğim" — gövde sonraki cümlelerde, AXP-02).
 * KIRPMA YOK: gövde bulunduysa OLDUĞU GİBİ döner (paneDraft.cjs ilkesi).
 */
function extractBody(text, low, toks, who) {
  const t = String(text || '').trim();
  // (a) İki nokta: "Parker'a söyle: X" / "Wanda için bir iş: X" / "Romanoff araştırsın: X"
  const colon = t.indexOf(':');
  if (colon > 0 && colon < t.length - 1) {
    const rest = t.slice(colon + 1).trim();
    if (rest) return rest;
  }
  // (b) "de ki X"
  const sayThat = low.match(/(^|\s)de\s+ki\s+(.+)$/);
  if (sayThat && sayThat[2]) return t.slice(t.length - sayThat[2].length).trim();
  // (c) İletim fiilinden sonrası: "Cap'e ilet, X" / "Takım liderine söyle X" / "Şunu Stark'a yaptır X"
  const verbHit =
    morph.verbHit(toks, STEMS.tellVerb) || morph.verbHit(toks, STEMS.giveVerb) || morph.verbHit(toks, STEMS.delegateVerb) || morph.verbHit(toks, HANDOFF_VERB_STEMS);
  if (verbHit && !verbHit.negated) {
    // AXP-06 EK(b): "söyler MİSİN? …" — rica eki gövdenin parçası DEĞİL; ekten (ve "?"den) sonrası gövde.
    const next = toks[verbHit.index + 1];
    const skip = next && POLITE_SUFFIX_RE.test(next) ? 1 : 0;
    const after = afterToken(t, toks[verbHit.index + skip], verbHit.index + skip, toks);
    if (after !== null) return after;
  }
  // (d) Hitap: "Barton, X" / "Parker X"
  if (who && isVocative(toks, who)) {
    const after = afterToken(t, toks[0], 0, toks);
    if (after !== null) return after;
  }
  return null;
}

/** Orijinal metinde `index`inci jetonun sonundan sonrasını (virgül/boşluk kırpılmış) döner; boşsa null. */
function afterToken(t, token, index, toks) {
  const low = morph.trLower(t);
  // jetonun orijinaldeki konumu: aynı jetonun `index`inci örneğinin sonu
  let pos = -1;
  let seen = -1;
  const re = /[a-zçğıöşü0-9]+/g;
  let m;
  while ((m = re.exec(low)) !== null) {
    seen += 1;
    if (seen === index) {
      pos = m.index + m[0].length;
      break;
    }
  }
  if (pos < 0) return null;
  const rest = t.slice(pos).replace(/^[\s,;:—–\-?!.]+/, '').trim();
  if (!rest) return null;
  // Tek jetonluk kalıntı ("dinle") gövde değildir — kontrol sözü.
  const restToks = morph.tokens(rest);
  if (restToks.length < 2) return null;
  void toks;
  return rest;
}

/** RouteDecision.target — çözülen hedef (ajan / rol / takım) ya da null. */
function buildTarget(who, teamId) {
  if (who && who.id) return { agentId: who.id, teamId: who.department || null };
  if (who && who.unresolvedRole) return { role: who.unresolvedRole };
  if (teamId) return { teamId };
  return null;
}

/** Belirsiz sorusu: TEK soru, İKİ seçenek (§2.4). */
function unclearQuestion(kind, who, context) {
  if (kind === 'only-name' && who && who.id) {
    const label = agentLabel(who.id, context);
    return {
      text: `${label} — terminalini mi açayım, ona iş mi vereceksin?`,
      options: [
        { id: 'app', label: 'Terminalini aç' },
        { id: 'agent', label: 'İş vereceğim' },
      ],
    };
  }
  return {
    text: 'Bunu uygulamada mı yapayım, bir ajana mı ileteyim?',
    options: [
      { id: 'agent', label: 'Ajana iş ver' },
      { id: 'app', label: 'Uygulamada yap' },
    ],
  };
}

function agentLabel(id, context) {
  const aliases = Array.isArray(context.aliases) ? context.aliases : [];
  const a = aliases.find((x) => x && x.id === id);
  const raw = (a && (a.label || a.match)) || id;
  const s = String(raw);
  return s.charAt(0).toLocaleUpperCase('tr') + s.slice(1);
}

// ── Ana karar ───────────────────────────────────────────────────────────────

/**
 * Kural yolu sınıflandırması (BEYİN YOK).
 *
 * @param {string} transcript
 * @param {object} context   renderer bağlamı (aliases/departments/defaultDepartment)
 * @param {{catalog?: object|null}} opts  `catalog` = parseIntent(transcript, context) çıktısı
 *        (somut eylem sinyali). Verilmezse katalog eşleşmesi YOK sayılır.
 * @returns {RouteDecision & { verdict: boolean }}  `verdict:false` = kural yolu karar
 *        VERMEDİ (adım 6: beyin karar verir).
 *
 * @typedef {{
 *   cls: 'aksiyon'|'prompt'|'belirsiz'|'yok',
 *   target?: {agentId?:string, role?:string, teamId?:string}|null,
 *   body?: string|null,
 *   question?: {text:string, options:Array<{id:string,label:string}>},
 *   via: string,
 * }} RouteDecision
 */
function classify(transcript, context = {}, opts = {}) {
  const t = String(transcript || '').trim();
  const low = morph.trLower(t);
  const toks = morph.tokens(low);
  const catalog = opts.catalog || null;
  const none = { cls: null, verdict: false, via: 'none' };
  if (!t) return none;

  // 1. Kontrol komutu — kapı dışı.
  if (isControlUtterance(low, toks)) return { ...none, via: 'control' };

  const directive = fanoutPolicy.detectDirective(t);
  const selfSaid = hasSelfPhrase(low);

  // 2. Olumsuz kutup — "sen yap / kendin bak" varsa kullanıcı bir şey İSTİYOR, kutup değil.
  if (isNegated(t, low, toks) && !selfSaid) {
    return { cls: CLS.NONE, verdict: true, via: 'negated', target: null, body: null };
  }
  // "sen kendin yap" → uygulamada; yönlendirici prompt/belirsiz üretmez, kural yolu halleder.
  if (directive === 'self' || selfSaid) return { ...none, via: 'self-directive' };

  const who = entityResolve.resolveAgent(t, context);
  const hasAgent = !!(who && who.id);
  const hasRole = !!(who && who.unresolvedRole);
  const teamId = detectTeamTarget(low, context);
  // AXP-06 EK(b): "X'e söyler misin?" bir SORU değil rica kipinde İLETİMDİR — adım 4'e girer.
  const polite = politeRequestHit(toks);
  const question = isQuestion(t, toks) && !polite;
  const transfer = hasTransferVerb(toks);
  const sayThat = SAY_THAT_RE.test(low);
  const jobPhrase = JOB_PHRASE_RE.test(low);
  const third = hasThirdPersonImperative(toks);
  const vocative = hasAgent && isVocative(toks, who);

  // 3. Aksiyon kataloğu.
  const catalogAction = !!(catalog && catalog.action && !NON_CATALOG_ACTIONS.has(catalog.action));
  const control = uiControls.resolveControl(toks);
  const controlAction = !!control && CHANGE_CUE_RE.test(low) && !hasAgent && !hasRole;
  if (catalogAction || controlAction) {
    const eligible = controlAction || (catalog && EXCEPTION_ELIGIBLE.has(catalog.action));
    const promptException =
      eligible && (hasAgent || teamId) && (transfer || sayThat || jobPhrase || third) && !question;
    if (!promptException) {
      return { cls: CLS.ACTION, verdict: true, via: catalogAction ? 'catalog' : 'control', target: null, body: null };
    }
  }

  // 4. Prompt işaretleri.
  // Çözülemeyen rol/ad ("Tasarımcı bir ajana ver", "Zorbotron'a söyle") BURADA prompt OLMAZ:
  // kural yolunun dürüst sorusu ("Ekipte bu rolde bir ajan yok. Kime vereyim?") konuşur —
  // uydurup başkasına verme yasağı (ADP-854 §4) aynen kalır.
  if (!question && !hasRole) {
    const targeted = hasAgent || !!teamId;
    // 4a/4b — hedef + iletim fiili · hedef + "de ki" / "için bir iş" / ":"
    if (targeted && (transfer || sayThat || jobPhrase || (hasAgent && low.includes(':')))) {
      const body = extractBody(t, low, toks, who);
      // İSTİSNA (adım 5): aksiyon sözcüğü (kayıtlı kontrol: tema/dil/…) + iletim fiili ve
      // İŞ GÖVDESİ YOK ("temayı Parker'a sor") → belirsiz. Gövde varsa kontrol sözcüğü işin
      // parçasıdır ("… tema değişince kayboluyor, düzeltsin") → prompt.
      if (control && !body && !jobPhrase && !sayThat) {
        return { cls: CLS.UNCLEAR, verdict: true, via: 'control+transfer', target: buildTarget(who, teamId), body: null, question: unclearQuestion('generic', who, context) };
      }
      const via = transfer ? 'target+verb' : sayThat ? 'target+say-that' : jobPhrase ? 'target+job' : 'target+colon';
      return { cls: CLS.PROMPT, verdict: true, via, target: buildTarget(who, teamId), body };
    }
    // 4c — hitap + emir / 3. tekil ("Barton, … test et" · "Parker şu hatayı düzeltsin")
    if (hasAgent && (vocative || third) && toks.length >= 3) {
      const body = extractBody(t, low, toks, who);
      return { cls: CLS.PROMPT, verdict: true, via: third ? 'name+third-person' : 'vocative', target: buildTarget(who, teamId), body };
    }
    // 4d — niyet beyanı ("bir görev vereceğim, dinle")
    if (hasIntentDeclaration(toks)) {
      return { cls: CLS.PROMPT, verdict: true, via: 'intent-declaration', target: buildTarget(who, teamId), body: extractBody(t, low, toks, who) };
    }
    // 4e — iletim fiili + gövde/direktif ama HEDEF YOK ("Tek bir ajana ver: X", "Şunu ilet: X")
    //      → prompt, hedef null (AXP-02 HEDEF SORUSU; AXP-01 köprüsü bugünkü delegasyon yolu).
    if (!targeted && transfer && (directive === 'single' || directive === 'team' || low.includes(':'))) {
      const body = extractBody(t, low, toks, null);
      return { cls: CLS.PROMPT, verdict: true, via: 'verb-no-target', target: directive === 'team' ? { teamId: context.defaultDepartment || null } : null, body };
    }
  }

  // 5. Belirsiz.
  if (!question) {
    // hedef + "sor" (iletim ailesinin sorusu) → aksiyon sözcüğü varsa belirsiz, yoksa prompt
    if (hasAgent && hasV(toks, 'askVerb')) {
      const body = extractBody(t, low, toks, who);
      if (control && !body) {
        return { cls: CLS.UNCLEAR, verdict: true, via: 'control+ask', target: buildTarget(who, teamId), body: null, question: unclearQuestion('generic', who, context) };
      }
      return { cls: CLS.PROMPT, verdict: true, via: 'target+ask', target: buildTarget(who, teamId), body };
    }
    // yalnız ad
    if (hasAgent && toks.length <= 2 && !transfer) {
      return { cls: CLS.UNCLEAR, verdict: true, via: 'only-name', target: buildTarget(who, teamId), body: null, question: unclearQuestion('only-name', who, context) };
    }
    // ad var, iletim yok, katalog yok ("Stark ile ilgilen") · iş gövdesi var alıcı yok ("landing sayfasını düzelt")
    if ((hasAgent && !catalogAction) || (!hasAgent && hasWorkVerb(toks) && !catalogAction)) {
      return { cls: CLS.UNCLEAR, verdict: true, via: hasAgent ? 'name-no-verb' : 'work-no-target', target: buildTarget(who, teamId), body: null, question: unclearQuestion('generic', who, context) };
    }
  }

  // 6. Beyin karar verir.
  return none;
}

/**
 * Kural kararı + beynin kararı → nihai RouteDecision.
 *
 * `brain` = beynin (ya da kural yolunun) JarvisDecision'ı. Sözleşme:
 *   • kural `yok`/`prompt`/`belirsiz` → kural (beyinden bağımsız) — TEK istisna:
 *     kural `belirsiz` + beyin `tell/delegate` → prompt (beyin eşitliği bozar; hedefi taşır).
 *     kural `belirsiz` + beyin SOMUT uygulama eylemi → aksiyon (geri alınabilir, ucuz).
 *   • kural `aksiyon` + beyin `tell/delegate` → belirsiz (çelişki → soru).
 *   • kural karar VERMEDİ + beyin `tell/delegate` → prompt (hedef beyinden, YENİDEN TÜRETİLMEZ).
 *   • kural karar VERMEDİ + beyin `reply` ve cümle sınıflandırılamadı ("Anladım." yolu) → belirsiz.
 */
function mergeBrain(rule, brain, transcript, context = {}) {
  const r = rule || { cls: null, verdict: false, via: 'none' };
  const b = brain && typeof brain === 'object' ? brain : null;
  const brainHandoff = !!b && (b.action === 'tell' || b.action === 'delegate');
  const brainCatalog = !!b && !!b.action && !NON_CATALOG_ACTIONS.has(b.action);

  if (r.verdict) {
    if (r.cls === CLS.NONE || r.cls === CLS.PROMPT) return strip(r);
    if (r.cls === CLS.UNCLEAR) {
      if (brainHandoff) return { cls: CLS.PROMPT, via: `${r.via}+brain`, target: r.target || brainTarget(b, context), body: r.body ?? null };
      if (brainCatalog) return { cls: CLS.ACTION, via: `${r.via}+brain-catalog`, target: null, body: null };
      return strip(r);
    }
    // aksiyon
    if (brainHandoff) {
      return {
        cls: CLS.UNCLEAR, via: 'rule-action+brain-handoff', target: brainTarget(b, context), body: null,
        question: unclearQuestion('generic', null, context),
      };
    }
    return strip(r);
  }
  // kural karar vermedi
  if (brainHandoff) {
    return { cls: CLS.PROMPT, via: 'brain', target: brainTarget(b, context), body: b.objective || null };
  }
  if (b && b.action === 'reply' && b.unclassified) {
    return { cls: CLS.UNCLEAR, via: 'unclassified', target: null, body: null, question: unclearQuestion('generic', null, context) };
  }
  if (brainCatalog) return { cls: CLS.ACTION, via: 'brain-catalog', target: null, body: null };
  return null; // beyin reply (sohbet) — yönlendirici alanı dışı
}

function strip(r) {
  const { verdict, ...rest } = r;
  void verdict;
  return rest;
}

/** Beynin hedefi OLDUĞU GİBİ taşınır (ad → id eşlemesi renderer'da, bugünkü gibi). */
function brainTarget(b, context) {
  if (!b) return null;
  if (b.action === 'tell' && b.target) {
    const who = entityResolve.resolveAgent(String(b.target), context);
    return who && who.id ? { agentId: who.id, teamId: who.department || null } : { agentId: String(b.target) };
  }
  if (b.action === 'delegate') return b.department ? { teamId: b.department } : null;
  return null;
}

/**
 * AXP-06 EK(a) — YANKI KAPISI: beynin/katalogun `objective`i cümlenin KENDİSİ mi?
 *
 * Kök (AXP-05 B1, AXP-09 §2.5): yönlendirici hüküm vermeyince (`route=null`) parseIntent'in
 * eski `tell/delegate` refleksi "Kamil amcaya söyler misin?" / "Şunu hallet." cümlesinin
 * kendisini objective yapıp terminale/pane'e taşıyordu. Yankı = (harf katlamalı, noktalamasız
 * eşitlik ∨ ≥%90 jeton örtüşmesi) ∧ cümle bir HEDEF ya da İLETİM İŞARETİ taşıyor (ajan adı /
 * takım yönelmesi / iletim fiili / rica eki / iş-verme öbeği). İkinci koşul şarttır: "şu konsol
 * hatasına bir bak" cümlesinde beyin hedefi BAĞLAMDAN bulur ve cümlenin kendisi İŞ GÖVDESİDİR —
 * onu boşaltmak AXP-01 taşımasını kırardı (intentRegression "AXP-01 TAŞIMA").
 */
function isEchoObjective(objective, transcript, context = {}) {
  const o = normEcho(objective);
  const t = normEcho(transcript);
  if (!o || !t) return false;
  let same = o === t;
  if (!same) {
    const ot = morph.tokens(o);
    const tt = morph.tokens(t);
    const n = Math.max(ot.length, tt.length);
    if (n > 0) {
      const set = new Set(tt);
      const shared = ot.filter((x) => set.has(x)).length;
      same = shared / n >= 0.9;
    }
  }
  if (!same) return false;
  const low = morph.trLower(String(transcript || '').trim());
  const toks = morph.tokens(low);
  const who = entityResolve.resolveAgent(String(transcript || ''), context);
  const hasAgent = !!(who && (who.id || who.unresolvedRole));
  return hasAgent || !!detectTeamTarget(low, context) || hasTransferVerb(toks) || !!politeRequestHit(toks) || SAY_THAT_RE.test(low) || JOB_PHRASE_RE.test(low);
}

function normEcho(s) {
  return morph.trLower(String(s || '')).replace(/[\s.,;:!?…"'’“”]+/g, ' ').trim();
}

/** "Tamam, dokunmadım." — `yok` sınıfının sesli onayı (ADP-857: geçmiş zaman, sonuç iddiası değil). */
const NONE_ACK = 'Tamam, dokunmadım.';

module.exports = {
  CLS,
  classify,
  mergeBrain,
  extractBody,
  isVocative,
  hasThirdPersonImperative,
  unclearQuestion,
  isEchoObjective,
  brainTarget,
  NONE_ACK,
  // testler için
  _internal: { JOB_PHRASE_RE, SAY_THAT_RE, THIRD_PERSON_RE, TEAM_DATIVE_RE, isNegated, isControlUtterance, EXCEPTION_ELIGIBLE },
};
