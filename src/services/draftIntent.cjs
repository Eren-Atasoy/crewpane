'use strict';
// AXD-03 (Ratchet) — TASLAK NİYET SINIFLANDIRICISI.
// i18n-exempt: intent-token
//
// Tek soru: "Agent X taslağı açıkken söylenen bu söz ne?"
//   SEND · ADD · FIX · CANCEL · HOLD · UNCLEAR
//
// Kaynak: AX-DRAFT-UX-R1 prototipi v3 (docs/agent-results/AX-DRAFT-UX-R1-evidence/
// proto-intent.cjs). Kural mantığı AYNEN taşındı; sözcükler leksikona alındı
// (intentLexicon.cjs → DRAFT_INTENT_WORDS) ve iki şey eklendi: SORUYA GÖRE KUTUP
// (polarity parametresi + questionPolarity) ve İngilizce küme.
//
// Üç ilke (rapor §4):
//  1. SORUYA GÖRE KUTUP. Soru "…bir şey var mı?" ise "hayır / yok" = EKLENECEK YOK = gönder,
//     çıplak "evet / var" = eklenecek VAR → dinle. Soru "Göndereyim mi?" ise tersine:
//     "evet" = gönder, "hayır" = GÖNDERME. Soru bilinmiyorsa kutuplu sözcük asla göndermez.
//  2. TÜKETME KURALI. Söz yalnız KONTROL sözcüklerinden oluşuyorsa kontroldür; tek bir
//     İÇERİK sözcüğü bile varsa EKtir. Kontrol sözü asla prompta yazılmaz.
//  3. EK-BİLİNÇLİ FİİL. gönder/yolla/ilet yalnız 2. kişi buyruk / rica çekimiyle kapanış.
//     "göndersin", "gönderen", "gönderi" İÇERİKTİR. Olumsuz ek (gönderme) → İPTAL, her şeyden önce.
//
// Saf fonksiyon, yan etki yok. Tüketici: electron/agentxDraft.cjs (AXD-04 durum makinesi v2).
// Kapı: electron/draftIntent.test.cjs (132 söz + 660 bozulma, dondurulmuş küme sha256).

const { DRAFT_INTENT_WORDS: W } = require('./intentLexicon.cjs');

const INTENTS = Object.freeze(['SEND', 'ADD', 'FIX', 'CANCEL', 'HOLD', 'UNCLEAR']);
const POLARITY = Object.freeze({ ANYTHING_ELSE: 'anything-else', CONFIRM_SEND: 'confirm-send' });

function fold(s) {
  return String(s ?? '')
    .replace(/İ/g, 'i').replace(/I/g, 'ı')
    .toLowerCase()
    .replace(/[’']/g, '') // "Optimus'a" → "optimusa", "don't" → "dont"
    .replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '');
}
function tokens(s) {
  return fold(s).match(/[\p{L}\p{N}]+/gu) ?? [];
}

// ── Leksikondan türetilen kümeler (TR ∪ EN) ────────────────────────────────
// Leksikon kelimeleri yüklenirken KATLANIR: 'önce' → 'once', 'don't' → 'dont'. Kıyas hep katlanmış biçimde.
const both = (key) => [...(W.tr[key] ?? []), ...(W.en[key] ?? [])].map((w) => tokens(w).join(' ')).filter(Boolean);
const seqs = (list) => list.map((p) => p.split(' '));
const singles = (list) => new Set(list.filter((p) => !p.includes(' ')));

const SEND_STEMS_TR = W.tr.sendStems.map(fold);
const SEND_WORDS_EN = new Set(W.en.sendStems);
const SEND_SUFFIX_TR = new Set(W.sendSuffixesTr);
const NEG_SEND_RE = new RegExp(`^(${SEND_STEMS_TR.join('|')})(me|ma)(y\\w*|sin\\w*|z\\w*|dim\\w*|di\\w*)?$`);
const NEGATORS_EN = new Set(W.en.negators);

const APPROVE = seqs(both('approve'));
const THANKS = seqs(both('thanks'));
const DONE = seqs(both('done'));
const QNEG = seqs(both('questionNo'));
const FILLER = seqs(both('filler'));
const POLITE = seqs(both('politeAsk'));
const POLAR_NO = singles(both('polarNo'));
const POLAR_YES = singles(both('polarYes'));
const GITSIN = new Set(W.tr.gitsin);
const GITSIN_VERBS = new Set(W.tr.gitsinVerbs);
const SEND_OBJ = seqs(both('sendObject'));
const STRONG = seqs(both('strong'));
const STRONG_DICTATION = seqs(both('strongDictation'));
const CANCEL = seqs(both('cancel'));
const HOLD = seqs(both('hold'));
const HOLD_STRONG = seqs(both('holdStrong'));
const HOLD_EXTRA = new Set(W.tr.holdExtra);
const FIX = seqs(both('fix'));
const FIX_LAST_PREFIX = new RegExp(`^(${W.tr.fixLastPrefixes.join('|')})`);
const FIX_LAST_VERB = new Set(W.tr.fixLastVerb);
const ADD_MARKERS = seqs(both('addMarkers'));
const UNCLEAR = seqs(both('unclear'));
const CONTRAST = singles(both('contrast'));
const ADDRESS = seqs(both('address'));
const Q_PARTICLES = new Set(W.tr.questionParticles);
const WH_RE = new RegExp(`^(${both('whWords').join('|')})`);
const Q_ANYTHING = seqs(both('questionAnything'));
const Q_CONFIRM = seqs(both('questionConfirm'));
// "bir şey daha" / "one more thing": çok kelimeli EK işaretleri — yalnız bekletmeyle birlikteyse BEKLET.
const MORE_MARKERS = ADD_MARKERS.filter((p) => p.length >= 3);
// Çok kelimeli BEKLET kalıpları (EN: "ill add something"): içlerindeki 'add' bir EK işareti sayılmaz.
const HOLD_PHRASES_MULTI = HOLD_STRONG.filter((p) => p.length > 1);

// ── Dilbilgisi: TR ek desenleri ────────────────────────────────────────────
const isFuture1sg = (t) => /(ecegim|acagim|yecegim|yacagim)$/.test(t); // ekleyeceğim, söyleyeceğim
const isOptative1sg = (t) => /(eyim|ayim|yeyim|yayim)$/.test(t) && t.length > 5; // düşüneyim, çekeyim
const isJussive3 = (t) => /(sin|sun|sinler|sunlar)$/.test(t) && t.length > 4 && !['misin', 'gitsin', 'yapabilirsin', 'ebilirsin'].includes(t) && !/bilirsin$/.test(t);

function sendVerb(t) {
  if (SEND_WORDS_EN.has(t)) return true;
  for (const s of SEND_STEMS_TR) {
    if (t.startsWith(s) && SEND_SUFFIX_TR.has(t.slice(s.length))) return true;
  }
  return false;
}

function hasSeq(toks, seq) {
  for (let i = 0; i + seq.length <= toks.length; i += 1) {
    if (seq.every((w, j) => toks[i + j] === w)) return true;
  }
  return false;
}
/** Jeton başına: bu jeton listedeki bir kalıbın (tek ya da çok kelimeli) içinde mi? */
function cover(toks, list) {
  const mask = new Array(toks.length).fill(false);
  for (const seq of list) {
    for (let i = 0; i + seq.length <= toks.length; i += 1) {
      if (seq.every((w, j) => toks[i + j] === w)) for (let j = 0; j < seq.length; j += 1) mask[i + j] = true;
    }
  }
  return mask;
}
const any = (mask) => mask.some(Boolean);

/**
 * Asistanın SORDUĞU sorudan kutbu çıkarır: son '?' cümlesi.
 *   "…bir şey var mı?" / "Anything to fix or add?"  → 'anything-else'  (hayır = gönder)
 *   "Göndereyim mi?"   / "Shall I send it?"          → 'confirm-send'   (evet = gönder, hayır = gönderme)
 *   ikisi birden ya da hiçbiri                       → null             (kutuplu söz göndermez)
 * @param {string} questionText
 * @returns {'anything-else'|'confirm-send'|null}
 */
function questionPolarity(questionText) {
  const sentences = String(questionText ?? '').split(/(?<=[.?!])\s+/).map((s) => s.trim()).filter(Boolean);
  const q = [...sentences].reverse().find((s) => /\?\s*$/.test(s));
  if (!q) return null;
  const toks = tokens(q);
  const confirm = Q_CONFIRM.some((p) => hasSeq(toks, p));
  const anything = Q_ANYTHING.some((p) => hasSeq(toks, p));
  if (confirm === anything) return null;
  return confirm ? POLARITY.CONFIRM_SEND : POLARITY.ANYTHING_ELSE;
}

/**
 * @param {string} text  STT çıktısı (tek sonlandırılmış söz)
 * @param {{ctx?: 'review'|'dictation'|'speaking', polarity?: 'anything-else'|'confirm-send'|null}} [opts]
 *   ctx 'review'   : taslak geri okundu, soru SORULDU — `polarity` o sorudan (questionPolarity).
 *   ctx 'dictation': taslak açık, bekleyen soru yok.
 *   ctx 'speaking' : Agent X konuşurken araya girildi (soru henüz yok → kutupsuz).
 * @returns {{label: 'SEND'|'ADD'|'FIX'|'CANCEL'|'HOLD'|'UNCLEAR', why: string, readback?: true}}
 *   `readback: true` (yalnız HOLD): dikte ortasında çıplak onay ("Tamam.") — durum makinesi
 *   metni geri okuyup sorar; gönderme YOK (AXD-04).
 */
function classifyDraftIntent(text, opts = {}) {
  const ctx = opts.ctx ?? 'review';
  const polarity = ctx === 'review' ? (opts.polarity ?? null) : null;
  const raw = String(text ?? '').trim();
  // NORMALLEŞTİRME (bozulma testi): adres sözü ve baştaki 'şey' dolgusu düşer, art arda
  // aynı jeton tekilleşir ("At at gitsin"). Soru eki (mi/mu) '?' yerine geçer.
  // Tekilleştirme hitaptan ÖNCE de yapılır: "Agent Agent X" → "agent x" (çıplak 'agent' leksikonda yok, KI-2).
  const lead = tokens(raw)
    .filter((t, i, a) => !(i === 0 && t === 'sey' && a.length > 1))
    .filter((t, i, a) => i === 0 || t !== a[i - 1]);
  const mAddress = cover(lead, ADDRESS);
  const toks = lead
    .filter((_, i) => !mAddress[i])
    .filter((t, i, a) => i === 0 || t !== a[i - 1]);
  if (!toks.length) return { label: 'UNCLEAR', why: 'boş' };

  // 1) OLUMSUZ GÖNDERME her şeyden önce: "hayır gönderme", "don't send".
  if (toks.some((t) => NEG_SEND_RE.test(t))) return { label: 'CANCEL', why: 'olumsuz gönderme fiili' };
  if (toks.some((t, i) => SEND_WORDS_EN.has(t) && i > 0 && NEGATORS_EN.has(toks[i - 1]))) return { label: 'CANCEL', why: 'olumsuz gönderme fiili (en)' };

  const anySend = toks.some(sendVerb) || (toks.some((t) => GITSIN.has(t)) && toks.some((t) => GITSIN_VERBS.has(t) || sendVerb(t)));

  // 2) Tüketme: söz tamamen kontrol sözlüğünden mi?
  const mApprove = cover(toks, APPROVE);
  const mThanks = cover(toks, THANKS);
  const mDone = cover(toks, DONE);
  const mFiller = cover(toks, FILLER);
  const mQneg = cover(toks, QNEG);
  const mPolite = cover(toks, POLITE);
  const mSendObj = cover(toks, SEND_OBJ);
  const isControl = (t, i) =>
    (anySend && mSendObj[i]) ||
    sendVerb(t) || mApprove[i] || mThanks[i] || mDone[i] || mFiller[i] || mQneg[i] || mPolite[i] ||
    (GITSIN_VERBS.has(t) && GITSIN.has(toks[i + 1]));
  const allControl = toks.every(isControl);

  // 3) İPTAL: "vazgeçtim, sil hepsini". Gönderme fiili varsa "boş ver, gönder" = vazgeçme
  //    değil kapanış → aşağıda SEND.
  //    AXD-04: iptal sözünün YANINDA tek bir içerik sözcüğü bile varsa İPTAL DEĞİLDİR —
  //    "iptal düğmesini kırmızı yap" bir iş metnidir (taslağı silmek yıkıcıdır, güvenli taraf EKLE).
  const mCancel = cover(toks, CANCEL);
  const cancelOnly = toks.every((t, i) => mCancel[i] || mFiller[i] || mApprove[i] || mQneg[i] || mThanks[i] || mDone[i]);
  if (!anySend && any(mCancel) && cancelOnly && toks.length <= 5) return { label: 'CANCEL', why: 'iptal sözü' };

  // SORU asla kapanış değildir: "Gönderelim mi?" kullanıcı soruyor. İstisna: 2. kişi
  // rica sorusu ("gönderir misin?", "can you send it?") bir buyruktur.
  const question = /\?[.\s]*$/.test(raw) || toks.some((t) => Q_PARTICLES.has(t));
  const politeAsk = any(mPolite);
  if (allControl && question && !politeAsk) return { label: 'UNCLEAR', why: 'soru: kapanış değil' };
  const contrast = toks.some((t) => CONTRAST.has(t));

  if (allControl && !contrast) {
    const polarNo = toks.some((t) => POLAR_NO.has(t));
    const polarYes = toks.some((t) => POLAR_YES.has(t));
    // "Göndereyim mi?" sorusuna "hayır" = GÖNDERME (yanında onay sözü olsa bile; güvenli taraf).
    if (polarity === POLARITY.CONFIRM_SEND && polarNo && !anySend) return { label: 'HOLD', why: "'göndereyim mi?' sorusuna hayır: gönderme" };
    const strong = ctx === 'dictation' ? cover(toks, STRONG_DICTATION) : cover(toks, STRONG);
    const polarSend = (polarity === POLARITY.ANYTHING_ELSE && polarNo) || (polarity === POLARITY.CONFIRM_SEND && polarYes);
    if (anySend || any(strong) || polarSend) {
      const why = anySend ? 'gönderme fiili, içerik yok' : polarSend ? `soruya göre kutup (${polarity})` : 'kapanış/onay sözü, içerik yok';
      return { label: 'SEND', why };
    }
    // Yalnız 'evet' / dolgu: "var mı?" sorusuna evet = eklenecek VAR → dinle (gönderme YOK).
    if (toks.every((t, i) => POLAR_YES.has(t) || mFiller[i])) {
      return polarity === POLARITY.ANYTHING_ELSE
        ? { label: 'HOLD', why: 'çıplak evet = eklenecek var' }
        : { label: 'UNCLEAR', why: 'çıplak evet, kutup bilinmiyor' };
    }
    // Dikte ortasında çıplak onay ('tamam'): gönderme yok, geri okuma sorusu.
    if (ctx === 'dictation' && any(mApprove)) return { label: 'HOLD', why: 'dikte ortasında onay → geri oku, sor', readback: true };
    return { label: 'UNCLEAR', why: 'yalnız ret/dolgu, kapanış yok' };
  }

  // Karşıtlık: '… ama bir şey daha var / ekleyeceğim' → HOLD; 'gönder ama önce göster' → UNCLEAR.
  if (contrast) {
    if (toks.some((t) => t === 'var' || isFuture1sg(t) || isOptative1sg(t)) || hasSeq(toks, ['bir', 'sey', 'daha']) || any(cover(toks, HOLD_PHRASES_MULTI))) {
      return { label: 'HOLD', why: 'karşıtlık + devamı var' };
    }
    if (anySend) return { label: 'UNCLEAR', why: 'gönder + koşul' };
  }
  // Yarım kalan ekleme öneki: 'Bir de.' / 'Also.' → devamını bekle.
  const nonFiller = toks.filter((t, i) => !mFiller[i]).length;
  if (ADD_MARKERS.some((p) => p.length === nonFiller && hasSeq(toks, p))) return { label: 'HOLD', why: 'yarım ekleme öneki' };

  // 4) DÜZELTME: "öyle değil", "X değil Y", "şunu çıkar", "sonuncuyu sil", "that's wrong".
  if (FIX.some((p) => hasSeq(toks, p)) || toks.some((t) => FIX_LAST_PREFIX.test(t) && toks.some((u) => FIX_LAST_VERB.has(u)))) {
    return { label: 'FIX', why: 'düzeltme işareti' };
  }

  // 5) BEKLET / ARAYA GİRME: kısa, içerik fiili yok, bekletme işareti ya da 1. tekil istek kipi.
  // AXD-04: "Dur, bir şey daha var." / "Bir dakika, bir şey daha ekleyeceğim." — bekletme +
  // "bir şey daha" + (var | 1. tekil gelecek), İÇERİK YOK → BEKLET. Önceden EKLE çıkıyordu ve
  // kontrol sözü prompta "Ekledim: Dur, bir şey daha var." diye yazılacaktı.
  const mMore = cover(toks, MORE_MARKERS);
  if (any(mMore) && toks.length <= 8) {
    const mH = cover(toks, HOLD);
    const mHS = cover(toks, HOLD_STRONG);
    const onlyHold = toks.every((t, i) => mMore[i] || mH[i] || mHS[i] || mFiller[i] || mApprove[i] || HOLD_EXTRA.has(t) || isFuture1sg(t) || isOptative1sg(t));
    if (onlyHold) return { label: 'HOLD', why: 'bekletme + bir şey daha (içerik yok)' };
  }
  const mHoldPhrase = cover(toks, HOLD_PHRASES_MULTI);
  const addToks = toks.filter((_, i) => !mHoldPhrase[i]);
  if (toks.length <= 6 && !toks.some(isJussive3) && !ADD_MARKERS.some((p) => hasSeq(addToks, p) && toks.length > p.length + 1)) {
    const mHold = cover(toks, HOLD);
    const mHoldStrong = cover(toks, HOLD_STRONG);
    const holdy = toks.every((t, i) => mHold[i] || mHoldStrong[i] || isOptative1sg(t) || isFuture1sg(t) || mFiller[i] || mApprove[i] || mQneg[i] || HOLD_EXTRA.has(t));
    if ((any(mHoldStrong) || toks.some(isOptative1sg) || toks.some(isFuture1sg)) && (holdy || toks.some(isOptative1sg))) {
      return { label: 'HOLD', why: 'bekletme / araya girme' };
    }
  }

  // 6) BELİRSİZ: kısa soru ya da anlamadım sınıfı (içerik fiili yok).
  const mUnclear = cover(toks, UNCLEAR);
  if (!toks.some(isJussive3) && (mUnclear.every(Boolean) || (toks.length === 1 && toks[0].length <= 3) || ((question || WH_RE.test(toks[0])) && toks.length <= 5))) {
    return { label: 'UNCLEAR', why: 'soru / anlamadım' };
  }

  // 7) Geri kalan her şey İÇERİKTİR → taslağa AYNEN eklenir.
  return { label: 'ADD', why: 'içerik' };
}

module.exports = { classifyDraftIntent, questionPolarity, INTENTS, POLARITY, fold, tokens, sendVerb };
