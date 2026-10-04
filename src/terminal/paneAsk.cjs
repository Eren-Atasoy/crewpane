// ASK-CARD-01 (FB-1009) — LİDERİN KARAR SORUSU: TESPİT + "CEVAP BEKLİYOR" DEFTERİ (ana süreç).
//
// ─────────────────────────────────────────────────────────────────────────────
// NEDEN VAR
// ─────────────────────────────────────────────────────────────────────────────
// Ultra müşteri (M4): "Lider bir karar sorduğunda bütün takım benim cevabımı bekliyor
// ve ben fark etmiyorum." Bugün liderin "hangisi? / A mı B mi?" sorusu yalnız o pane'e
// BAKAN insanın gördüğü bir terminal satırıdır; pane rozeti, ofis ve telefon bunu
// "çalışıyor/boşta"dan ayırt etmez. Bu modül o satırı YAPISAL bir `ask` olayına
// çevirir ve cevaplanana kadar "cevap bekliyor" durumunu tek defterde tutar.
//
// ─────────────────────────────────────────────────────────────────────────────
// SÖZLEŞME
// ─────────────────────────────────────────────────────────────────────────────
//   • Tespit SAF ve ekran-tabanlıdır: pane'in VT ekranındaki (paneScreen.liveLines)
//     SATIRLAR okunur — kullanıcının gördüğü metnin ta kendisi. Motor adına bakılmaz
//     (claude/codex/shell fark etmez); yalnız AJANA bağlı pane'ler izlenir.
//   • YANLIŞ POZİTİF KAPISI (kartın 1. maddesi): sıradan soru ≠ karar. Bir satır
//     ancak (a) `?` ile bitiyor VE (b) SEÇİM ipucu (hangisi / yoksa / which / prefer /
//     seç…) ya da İLERLEME ipucu (devam edeyim mi / should I proceed…) taşıyorsa
//     karardır. Seçenekler soru satırının ÜSTÜNDEKİ numaralı/harfli/madde listesinden
//     ya da sorunun içindeki "A mı B mi" / "A or B" kalıbından çıkar. İlerleme sorusu
//     Evet/Hayır'a düşer. İpucu var ama liste yoksa kart SEÇENEKSİZ açılır (serbest
//     metin korunur) — yalnız GÜÇLÜ ipucuyla.
//   • TUI menüsü (❯ 1. …) ve koşan tur (`esc to interrupt`) ASLA kart açmaz: birincisi
//     paneReadiness'ın alanı (Enter seçim yapar), ikincisi liderin henüz bitmemiş
//     cümlesidir.
//   • Pane başına EN FAZLA BİR açık soru. Aynı soru (parmak izi) kapandıktan sonra
//     DEDUP_MS boyunca yeniden açılmaz — kullanıcı cevapladı, metin ekranda duruyor
//     diye ikinci kart doğmasın.
//   • Cevap TEK yoldan pane'e gider: çağıranın verdiği `deliver` (main'de ENT-F1
//     `deliverToPane`: metin bir kez + Enter tekrarı + composer ölçümü). "Yazıldı" ≠
//     "teslim edildi" — `delivered:false` dürüstçe deftere yazılır, metin ikinci kez
//     YAZILMAZ ([[ref_delivery_write_once_enter_free]]).
//   • Terminale doğrudan yazılan Enter (`pty:input` ile `\r`) soruyu 'terminal'
//     yoluyla kapatır: kullanıcı kartı değil klavyeyi seçtiyse kart yalan söylemez.
//   • 120 sn cevapsız → `reminded:true` ("lider hâlâ bekliyor"). Bu bir DURUMDUR,
//     zaman aşımı değil: 504/FAIL yok ([[unattended-pane-seam-is-disallowsubagent]]).
//     TTL (30 dk) dolunca 'expired' — kart kapanır, defterde iz kalır.
//   • AYNA: açılan her soru çağıranın `mirror.open`ına (main'de Agent X onay defteri
//     `jarvisConv.openApproval`) verilir → telefon (JarvisScreen) ve masaüstü Agent X
//     kartı AYNI düğmeleri çizer, tek-kazanan kapısından geçer. Ayna kapanınca
//     (`onMirrorResolved`) seçim BURADAN teslim edilir.
//
// TÜM IO ENJEKTE (fs/electron/pty require'ı yok) → `node --test electron/paneAsk.test.cjs`.

'use strict';

const crypto = require('node:crypto');

/** Soru satırı ekranın sonundan en fazla bu kadar İÇERİK satırı yukarıda olabilir. */
const QUESTION_WINDOW = 4;
/** Seçenek listesi soru satırının en fazla bu kadar üstünde aranır. */
const OPTIONS_WINDOW = 14;
const MAX_OPTIONS = 6;
const MAX_LABEL = 160;
const MAX_QUESTION = 400;
const MAX_FREE_TEXT = 2000;
/** Pane sustuktan ne kadar sonra ekran okunur (TUI kutusunu çizsin). */
const QUIET_MS = 1500;
/** Cevapsız kalınca "lider hâlâ bekliyor" (kartın 5. maddesi). */
const REMIND_MS = 120 * 1000;
/** Açık sorunun ömrü. */
const TTL_MS = 30 * 60 * 1000;
/** Kapanmış aynı sorunun yeniden açılmadığı pencere. */
const DEDUP_MS = 10 * 60 * 1000;
const MAX_LEDGER = 60;

// ── EKRAN GÜRÜLTÜSÜ ────────────────────────────────────────────────────────────
// claude composer kutusu + kısayol footer'ı + spinner satırları içerik değildir.
const BOX_LINE = /^\s*[╭╰│┃┌└├┤─╌]/;
const FOOTER = /\? for shortcuts|bypass permissions|shift\+tab to cycle|ctrl\+[a-z] to|esc to (?:cancel|clear)|\/help for help/i;
const RUNNING = /esc to interrupt/i;
/** TUI seçim menüsü (paneReadiness'ın alanı — Enter seçim yapar, metin yazılamaz). */
const TUI_MENU = /^\s*❯\s*\d+\.|enter to (?:select|confirm)|use arrow keys|↑\/↓ to (?:navigate|select)/i;
const SPINNER = /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏·✻✽✶✳✢*]\s*\S*(?:ing|…)/;
const ASSISTANT_MARK = /^\s*[⏺●•▎]\s+/;

// ── KARAR İPUÇLARI ─────────────────────────────────────────────────────────────
// 🔴 `\b` ASCII sınırıdır: Türkçe harften (ç ğ ı ö ş ü) sonra ÇALIŞMAZ ("seç\b" hiç
// eşleşmez). Sözcük sonu için `NW` (harf-değil ileri-bakış) kullanılır.
const NW = '(?![a-zçğıöşüi̇])';
const tr = (src) => new RegExp(src, 'i');
/** SEÇİM sorusu: cevap bir seçenektir. */
const CHOICE_CUES = [
  tr(`\\bhangi(?:si|sini|sine|sinden|sinde|ni|ne|leri|lerini)?${NW}`),
  /\byoksa\b/i,
  tr(`\\btercih(?:in|iniz|inizi|ini|edersin|edersiniz|eder misin)?${NW}`),
  tr(`\\bseç(?:elim|eyim|meliyim|meliyiz|imin|iminiz|imi|imini|er misin|ersin|iniz)?${NW}`),
  tr(`\\bkarar(?:ın|ınız|ı|senin|sizin)?${NW}`),
  // "A mı(,) (yoksa) B mi?" — soru işaretiyle biten ikili alternatif.
  /\sm[ıiuü],?\s+(?:yoksa\s+)?.+\sm[ıiuü]\s*\?$/i,
  /\bwhich(?: one| of| option| way| do| would| should| approach)?\b/i,
  /\bprefer\b/i,
  /\b(?:choose|pick|go with)\b/i,
  /\b(?:your|the) (?:call|choice|decision)\b/i,
  /\boption\b/i,
  // "Should I use X or Y?" — İngilizce ikili alternatif.
  /\b(?:should|shall|do|would) (?:i|we|you)\b.*\bor\b.*\?$/i,
];
/** İLERLEME sorusu: cevap Evet/Hayır'dır. Dil grubu teslim metnini belirler. */
const PROCEED_CUES_TR = [
  tr(`\\bdevam ed(?:eyim|elim) mi${NW}`),
  tr(`\\S+(?:ayım|eyim|alım|elim)\\s+m[ıiuü]${NW}`), // "PR açayım mı?", "taşıyalım mı?"
  tr(`\\bonayl[ıi]yor musun(?:uz)?${NW}`),
  tr(`\\bonay(?:ın|ınız)? var m[ıi]${NW}`),
  tr(`\\buygun mu(?:dur)?${NW}`),
  tr(`\\bbaşla(?:yayım|yalım) m[ıi]${NW}`),
];
const PROCEED_CUES_EN = [
  /\b(?:should|shall|may|can) (?:i|we) (?:proceed|continue|go ahead|start|begin|apply|merge|push|delete|run)\b/i,
  /\bproceed\?/i,
  /\bgo ahead\?/i,
  /\b(?:do you )?want me to\b/i,
  /\bok(?:ay)? to (?:proceed|continue|merge|push|delete)\b/i,
  /\bis (?:that|this) (?:ok|okay|fine|acceptable)\b/i,
];
/** Soru/etiket Türkçe mi (teslim metni ve dil rozeti için). */
const TURKISH = /[çğıöşüİ]|\b(?:hangi\w*|yoksa|istersin|tercih|devam|evet|hayır)\b|\sm[ıiuü]\s*[?,]/i;

const ENUM_NUM = /^\s*\(?(\d{1,2})[.)]\s+(.+?)\s*$/;
const ENUM_LETTER = /^\s*\(?([A-Ha-h])[.)]\s+(.+?)\s*$/;
const ENUM_BULLET = /^\s*[-•*▪◦]\s+(.+?)\s*$/;
const CONTINUATION = /^\s{2,}\S/;
/** "X mı(,) (yoksa) Y mi?" — iki parça da makul kısa olmalı. */
const INLINE_TR = /^(.+?)\s+m[ıiuü]\??,?\s*(?:yoksa\s+)?(.+?)\s+m[ıiuü]\s*\?$/i;
/** "… A or B?" — sonda iki alternatif: önce fiil çapası, sonra ayraç, en son kısa düz satır. */
const INLINE_EN = [
  /\b(?:with|use|using|go with|prefer|pick|choose|take|keep)\s+([^,:?]{2,60}?)\s+or\s+([^,:?]{2,60}?)\s*\?$/i,
  /[:,]\s*([^,:?]{2,60}?)\s+or\s+([^,:?]{2,60}?)\s*\?$/i,
  /^((?:\S+\s+){0,3}\S+)\s+or\s+((?:\S+\s+){0,3}\S+?)\s*\?$/i,
];

const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const clamp = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const testAny = (arr, s) => arr.some((re) => re.test(s));

/**
 * Ekran satırlarını İÇERİK satırlarına indirge (kutu/footer/spinner atılır).
 * `running:true` → motor tur koşuyor, soru henüz bitmemiş olabilir.
 */
function contentLines(lines) {
  const raw = Array.isArray(lines) ? lines : String(lines || '').split(/\r?\n/);
  const tail = raw.slice(-80);
  const running = tail.slice(-8).some((l) => RUNNING.test(String(l || '')));
  const menu = tail.some((l) => TUI_MENU.test(String(l || '')));
  const out = [];
  for (const l of tail) {
    const s = String(l || '').replace(/\s+$/, '');
    if (!s.trim()) { out.push(''); continue; }
    if (BOX_LINE.test(s) || FOOTER.test(s) || SPINNER.test(s)) continue;
    out.push(s);
  }
  // Baştaki/sondaki boşları kırp, ardışık boşları teke indir.
  const compact = [];
  for (const s of out) {
    if (s === '' && (compact.length === 0 || compact[compact.length - 1] === '')) continue;
    compact.push(s);
  }
  while (compact.length && compact[compact.length - 1] === '') compact.pop();
  return { lines: compact, running, menu };
}

function stripMark(s) {
  return norm(String(s || '').replace(ASSISTANT_MARK, ''));
}

/** Soru satırı ipucu türü: 'choice' | 'proceed' | null. */
function cueOf(q) {
  if (!/\?\s*$/.test(q)) return null;
  if (testAny(CHOICE_CUES, q)) return { kind: 'choice' };
  if (testAny(PROCEED_CUES_TR, q)) return { kind: 'proceed', lang: 'tr' };
  if (testAny(PROCEED_CUES_EN, q)) return { kind: 'proceed', lang: 'en' };
  return null;
}

/**
 * Soru satırının üstündeki numaralı/harfli/madde listesi. Pencere, "koşu"lara bölünür
 * (aynı stilde ardışık maddeler; daha derin girintili satır sarmalanmış devamdır);
 * soruya EN YAKIN ≥2 maddelik koşu seçenek listesidir — arada bir not satırı
 * ("Not: A daha riskli.") listeyi düşürmez.
 */
function listOptions(lines, qi) {
  const from = Math.max(0, qi - OPTIONS_WINDOW);
  const runs = [];
  let run = null;
  const indentOf = (s) => (/^(\s*)/.exec(s) || ['', ''])[1].length;
  const flush = () => { if (run && run.items.length) runs.push(run); run = null; };
  for (let i = from; i < qi; i++) {
    const s = lines[i];
    if (!s) continue; // boş satır koşuyu bozmaz (madde arası boşluk)
    let m;
    let kind = null;
    let label = null;
    let marker = null;
    if ((m = ENUM_NUM.exec(s))) { kind = 'num'; marker = m[1]; label = m[2]; }
    else if ((m = ENUM_LETTER.exec(s))) { kind = 'letter'; marker = m[1].toUpperCase(); label = m[2]; }
    else if ((m = ENUM_BULLET.exec(s))) { kind = 'bullet'; marker = null; label = m[1]; }
    if (kind) {
      if (!run || run.kind !== kind) { flush(); run = { kind, indent: indentOf(s), items: [] }; }
      run.items.push({ marker, label: norm(label) });
      continue;
    }
    if (run && run.items.length && indentOf(s) > run.indent && !/[:?]\s*$/.test(run.items[run.items.length - 1].label)) {
      const last = run.items[run.items.length - 1];
      last.label = norm(`${last.label} ${s}`);
      continue;
    }
    flush(); // liste dışı dolu satır: koşu bitti
  }
  flush();
  for (let r = runs.length - 1; r >= 0; r--) {
    const items = runs[r].items;
    if (items.length < 2) continue;
    // Numaralı listede 1..n sırası bozuksa (iki listenin kalıntısı) güvenme.
    if (runs[r].kind === 'num' && !items.every((it, i) => Number(it.marker) === i + 1)) continue;
    return items.filter((it) => it.label).slice(0, MAX_OPTIONS);
  }
  return [];
}

/** Sorunun içindeki "A mı B mi" / "A or B" alternatifleri. */
function inlineOptions(q) {
  let m = INLINE_TR.exec(q);
  if (m) {
    const a = norm(m[1].replace(/^.*[:—-]\s*/, ''));
    const b = norm(m[2]);
    if (a && b && a.length <= 80 && b.length <= 80 && a.toLowerCase() !== b.toLowerCase()) {
      return [{ marker: null, label: a }, { marker: null, label: b }];
    }
  }
  for (const re of INLINE_EN) {
    m = re.exec(q);
    if (!m) continue;
    const a = norm(m[1]);
    const b = norm(m[2]);
    if (a && b && a.toLowerCase() !== b.toLowerCase()) return [{ marker: null, label: a }, { marker: null, label: b }];
  }
  return [];
}

function toOptions(items) {
  return items.map((it, i) => ({
    id: `opt-${i + 1}`,
    label: clamp(it.label, MAX_LABEL),
    // Pane'e YAZILACAK metin: numaralı listede "2" değil etiketin kendisi (lider
    // etiketi yazdı, etiketle cevaplanmak en az belirsiz olan). Numara varsa başa
    // eklenir — liderin listesine birebir gönderme.
    send: it.marker ? `${it.marker}) ${clamp(it.label, MAX_LABEL)}` : clamp(it.label, MAX_LABEL),
  }));
}

/**
 * Ekran satırlarından karar sorusu çıkar. SAF.
 * @param {string[]|string} lines  VT ekranının görünür satırları (kullanıcının gördüğü)
 * @returns {null | {question:string, options:Array<{id:string,label:string,send:string}>, kind:'choice'|'proceed', lang:'tr'|'en'|null}}
 */
function detectAsk(lines) {
  const { lines: c, running, menu } = contentLines(lines);
  if (running || menu || !c.length) return null;
  // Soru satırı: sondan QUESTION_WINDOW içerik satırı içinde, `?` ile biten ilk (en alttaki).
  let qi = -1;
  let cue = null;
  let seen = 0;
  for (let i = c.length - 1; i >= 0 && seen < QUESTION_WINDOW; i--) {
    if (!c[i]) continue;
    seen++;
    const q = stripMark(c[i]);
    const k = cueOf(q);
    if (k) { qi = i; cue = k; break; }
    // `?` ile biten ama ipucusuz satır: sıradan soru → durmayız, üstteki satır
    // ("Hangisi?" + altında not) hâlâ aday olabilir.
  }
  let question = qi >= 0 ? stripMark(c[qi]) : null;
  if (qi < 0) {
    // Sarmalanmış soru ("… iki seçenek var. Hangisini" / "istersin?"): son bitişik düz
    // satır bloğunu (≤3, liste maddesi değil) birleştirip bir kez daha dene.
    const buf = [];
    let top = -1;
    for (let i = c.length - 1; i >= 0 && buf.length < 3; i--) {
      if (!c[i] || ENUM_NUM.test(c[i]) || ENUM_LETTER.test(c[i]) || ENUM_BULLET.test(c[i])) break;
      buf.unshift(stripMark(c[i]));
      top = i;
    }
    const joined = norm(buf.join(' '));
    const k = joined ? cueOf(joined) : null;
    if (!k) return null;
    qi = top;
    cue = k;
    question = joined;
  }
  question = clamp(question, MAX_QUESTION);
  if (cue.kind === 'proceed') {
    const tr = cue.lang === 'tr';
    return {
      question,
      kind: 'proceed',
      lang: cue.lang,
      options: [
        { id: 'yes', label: tr ? 'Evet' : 'Yes', send: tr ? 'Evet' : 'Yes' },
        { id: 'no', label: tr ? 'Hayır' : 'No', send: tr ? 'Hayır' : 'No' },
      ],
    };
  }
  let items = listOptions(c, qi);
  if (items.length < 2) items = inlineOptions(question);
  if (items.length < 2) items = [];
  const lang = TURKISH.test(question) || items.some((it) => TURKISH.test(it.label)) ? 'tr' : 'en';
  return { question, kind: 'choice', lang, options: toOptions(items) };
}

/** Aynı soruyu yeniden açmamak için parmak izi (soru + etiketler, boşluk/büyük-küçük duyarsız). */
function askFingerprint(ask) {
  const h = crypto.createHash('sha1');
  h.update(norm(ask.question).toLowerCase());
  for (const o of ask.options || []) h.update('|' + norm(o.label).toLowerCase());
  return h.digest('hex').slice(0, 16);
}

function newId() {
  return `ask-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

/** Renderer/telefona giden anlık görüntü (fonksiyon yok, sığ kopya). */
function publicAsk(a) {
  return {
    id: a.id,
    paneId: a.paneId,
    agentId: a.agentId,
    question: a.question,
    options: a.options.map((o) => ({ id: o.id, label: o.label })),
    kind: a.kind,
    at: a.at,
    status: a.status,
    reminded: a.reminded === true,
    sending: a.sending === true,
    answer: a.answer ? { ...a.answer } : null,
  };
}

/**
 * Çalışma zamanı: pane çıktısı → tespit → defter → kart/ayna → cevap → teslim.
 *
 * @param {object} deps
 * @param {(paneId:string)=>string[]|null} deps.readScreenLines  VT ekranının görünür satırları
 * @param {(paneId:string)=>{agentId?:string|null}|null} deps.paneInfo  pane defteri (yoksa null)
 * @param {(paneId:string,text:string)=>Promise<{delivered:boolean,outcome?:string,reason?:string}>} deps.deliver
 * @param {(event:object)=>void} [deps.emit]  'ask' | 'ask-changed' | 'ask-resolved'
 * @param {{open:(ask:object)=>void, close:(askId:string)=>void}} [deps.mirror]  Agent X onay defteri aynası
 * @param {()=>number} [deps.now]
 * @param {(fn:Function,ms:number)=>any} [deps.setTimeout]
 * @param {(h:any)=>void} [deps.clearTimeout]
 * @param {(line:string)=>void} [deps.log]
 * @param {number} [deps.quietMs] [deps.remindMs] [deps.ttlMs] [deps.dedupMs]
 */
function createPaneAskRuntime(deps) {
  const now = deps.now || (() => Date.now());
  const st = deps.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const ct = deps.clearTimeout || ((h) => clearTimeout(h));
  const log = deps.log || (() => {});
  const emit = deps.emit || (() => {});
  const quietMs = deps.quietMs ?? QUIET_MS;
  const remindMs = deps.remindMs ?? REMIND_MS;
  const ttlMs = deps.ttlMs ?? TTL_MS;
  const dedupMs = deps.dedupMs ?? DEDUP_MS;

  /** @type {object[]} tüm sorular (açık + kapalı, MAX_LEDGER) */
  let ledger = [];
  /** paneId → debounce zamanlayıcısı */
  const quietTimers = new Map();
  /** askId → { remind, ttl } */
  const askTimers = new Map();

  const openFor = (paneId) => ledger.find((a) => a.paneId === paneId && a.status === 'open') || null;
  const byId = (id) => ledger.find((a) => a.id === id) || null;

  function unref(h) { if (h && typeof h.unref === 'function') h.unref(); return h; }

  function clearAskTimers(id) {
    const t = askTimers.get(id);
    if (!t) return;
    if (t.remind) ct(t.remind);
    if (t.ttl) ct(t.ttl);
    askTimers.delete(id);
  }

  function close(a, status, extra) {
    if (!a || a.status !== 'open') return null;
    a.status = status;
    a.closedAt = now();
    a.sending = false;
    if (extra) Object.assign(a, extra);
    clearAskTimers(a.id);
    if (deps.mirror && typeof deps.mirror.close === 'function') {
      try { deps.mirror.close(a.id, status); } catch (err) { log(`pane ask: ayna kapatılamadı ${a.id}: ${String((err && err.message) || err)}`); }
    }
    log(`pane ask: KAPANDI id=${a.id} pane=${a.paneId} status=${status}${a.answer ? ` via=${a.answer.via} delivered=${a.answer.delivered}` : ''}`);
    emit({ type: 'ask-resolved', ask: publicAsk(a) });
    return a;
  }

  function open(paneId, agentId, detected) {
    const a = {
      id: newId(),
      paneId,
      agentId: agentId || null,
      question: detected.question,
      options: detected.options,
      kind: detected.kind,
      lang: detected.lang,
      fingerprint: askFingerprint(detected),
      at: now(),
      status: 'open',
      reminded: false,
      sending: false,
      answer: null,
      closedAt: null,
    };
    ledger = [...ledger, a].slice(-MAX_LEDGER);
    const remind = st(() => {
      const cur = byId(a.id);
      if (!cur || cur.status !== 'open' || cur.reminded) return;
      cur.reminded = true;
      log(`pane ask: HÂLÂ BEKLİYOR id=${a.id} pane=${paneId} (${Math.round(remindMs / 1000)} sn)`);
      emit({ type: 'ask-changed', ask: publicAsk(cur) });
    }, remindMs);
    const ttl = st(() => close(byId(a.id), 'expired'), ttlMs);
    askTimers.set(a.id, { remind: unref(remind), ttl: unref(ttl) });
    log(`pane ask: AÇILDI id=${a.id} pane=${paneId} agent=${agentId || '-'} kind=${a.kind} options=${a.options.length} q="${clamp(a.question, 80)}"`);
    emit({ type: 'ask', ask: publicAsk(a) });
    if (deps.mirror && typeof deps.mirror.open === 'function') {
      try { deps.mirror.open(publicAsk(a)); } catch (err) { log(`pane ask: ayna açılamadı ${a.id}: ${String((err && err.message) || err)}`); }
    }
    return a;
  }

  /** Pane sustu → ekranı oku → aç/kapat kararı. */
  function check(paneId) {
    const info = deps.paneInfo ? deps.paneInfo(paneId) : null;
    if (!info) { const cur = openFor(paneId); if (cur) close(cur, 'gone'); return null; }
    if (!info.agentId) return null; // ajana bağlı olmayan pane (düz shell) izlenmez
    let lines = null;
    try { lines = deps.readScreenLines(paneId); } catch { lines = null; }
    if (!lines) return null;
    const detected = detectAsk(lines);
    if (deps.debug) log(`pane ask: check pane=${paneId} lines=${lines.length} detected=${detected ? detected.kind + '/' + detected.options.length : 'yok'} ekran=${JSON.stringify(lines.slice(-12))}`);
    const cur = openFor(paneId);
    if (cur) {
      // Soru hâlâ ekranda mı? Değilse lider yoluna devam etmiş (klavyeden cevap /
      // başka çıktı) → kart yalan söylemesin.
      if (!detected || askFingerprint(detected) !== cur.fingerprint) close(cur, 'stale');
      return cur;
    }
    if (!detected) return null;
    const fp = askFingerprint(detected);
    const t = now();
    const recent = ledger.find((a) => a.paneId === paneId && a.fingerprint === fp && a.status !== 'open' && t - (a.closedAt || a.at) < dedupMs);
    if (recent) return null;
    return open(paneId, info.agentId, detected);
  }

  return {
    /**
     * pty verisi geldi: sessizlik penceresini yeniden kur (ucuz; ekran OKUNMAZ).
     *
     * İKİ OKUMA: VT'nin (paneScreen) yazımı ASENKRONDUR — sessizlik penceresi dolduğunda
     * ekran henüz tam çizilmemiş olabilir (ÖLÇÜLDÜ: 6 koşumun 2'sinde ilk okuma 7 satır,
     * soru satırı eksik; veri de bir daha gelmediği için kart HİÇ açılmıyordu). İlk
     * okuma boş çıkarsa aynı pencere kadar sonra BİR kez daha bakılır; yeni veri gelirse
     * pencere zaten sıfırlanır.
     */
    noteData(paneId) {
      const prev = quietTimers.get(paneId);
      if (prev) ct(prev);
      const run = (again) => {
        quietTimers.delete(paneId);
        let opened = null;
        try { opened = check(paneId); } catch (err) { log(`pane ask: check hata ${paneId}: ${String((err && err.message) || err)}`); }
        if (again && !opened) quietTimers.set(paneId, unref(st(() => run(false), quietMs)));
      };
      quietTimers.set(paneId, unref(st(() => run(true), quietMs)));
    },
    /**
     * Renderer'ın pty yazımı: kullanıcı klavyeden cevapladı mı? Yalnız METİN + Enter
     * kapatır (aynı chunk'ta ya da önce harfler sonra Enter). Boş composer'da basılan
     * çıplak Enter hiçbir şey göndermez — kartı kapatsaydı soru dedup penceresinde
     * bir daha açılmaz, kullanıcı "kart kayboldu" derdi.
     */
    noteInput(paneId, data) {
      if (typeof data !== 'string' || !data) return;
      const cur = openFor(paneId);
      if (!cur || cur.sending) return;
      const text = data.replace(/[\r\n]/g, '');
      if (text.trim()) cur.typedSinceOpen = true;
      if (!/[\r\n]/.test(data) || !cur.typedSinceOpen) return;
      close(cur, 'answered', { answer: { text: null, via: 'terminal', at: now(), delivered: true } });
    },
    noteExit(paneId) {
      const prev = quietTimers.get(paneId);
      if (prev) { ct(prev); quietTimers.delete(paneId); }
      const cur = openFor(paneId);
      if (cur) close(cur, 'gone');
    },
    check,
    list: () => ledger.filter((a) => a.status === 'open').map(publicAsk),
    get: (id) => { const a = byId(id); return a ? publicAsk(a) : null; },
    /**
     * Cevabı pane'e TESLİM ET. `choiceId` listedeki bir seçenek, `text` serbest metin;
     * ikisi de yoksa hata. Metin bir kez yazılır; sonuç dürüst (`delivered`).
     * @returns {Promise<{ok:boolean, delivered?:boolean, reason?:string, ask?:object}>}
     */
    async answer({ askId, choiceId, text, via } = {}) {
      const a = byId(askId);
      if (!a) return { ok: false, reason: 'not-found' };
      if (a.status !== 'open') return { ok: false, reason: 'closed', ask: publicAsk(a) };
      if (a.sending) return { ok: false, reason: 'sending', ask: publicAsk(a) };
      let send = null;
      let label = null;
      if (choiceId) {
        const o = a.options.find((x) => x.id === choiceId);
        if (!o) return { ok: false, reason: 'unknown-choice', ask: publicAsk(a) };
        send = o.send; label = o.label;
      } else {
        const t = norm(String(text || '').replace(/[\r\n]+/g, ' '));
        if (!t) return { ok: false, reason: 'empty', ask: publicAsk(a) };
        send = clamp(t, MAX_FREE_TEXT); label = send;
      }
      a.sending = true;
      emit({ type: 'ask-changed', ask: publicAsk(a) });
      let res;
      try {
        res = await deps.deliver(a.paneId, send);
      } catch (err) {
        res = { delivered: false, outcome: 'unknown', reason: String((err && err.message) || err) };
      }
      a.sending = false;
      if (byId(a.id) !== a || a.status !== 'open') return { ok: false, reason: 'closed', ask: publicAsk(a) };
      const delivered = !!(res && res.delivered);
      close(a, 'answered', {
        answer: { text: label, choiceId: choiceId || null, via: via || 'card', at: now(), delivered, reason: res && res.reason ? String(res.reason) : null },
      });
      return { ok: true, delivered, ask: publicAsk(a) };
    },
    dismiss(askId) {
      const a = byId(askId);
      if (!a || a.status !== 'open') return { ok: false, reason: 'closed' };
      close(a, 'dismissed');
      return { ok: true, ask: publicAsk(a) };
    },
    /**
     * Ayna (Agent X onay kartı) bir uçta cevaplandı. Seçim id'si listedeyse teslim
     * edilir; ikili "reddet" (choice yok) kartı kapatır, hiçbir şey yazmaz.
     */
    onMirrorResolved(askId, status, choice) {
      const a = byId(askId);
      if (!a || a.status !== 'open') return Promise.resolve({ ok: false, reason: 'closed' });
      if (status === 'expired') { close(a, 'expired'); return Promise.resolve({ ok: true }); }
      if (choice && a.options.some((o) => o.id === choice)) return this.answer({ askId, choiceId: choice, via: 'mirror' });
      close(a, 'dismissed');
      return Promise.resolve({ ok: true, ask: publicAsk(a) });
    },
    /** Test/kapatma temizliği. */
    dispose() {
      for (const h of quietTimers.values()) ct(h);
      quietTimers.clear();
      for (const id of Array.from(askTimers.keys())) clearAskTimers(id);
    },
    _ledger: () => ledger.map(publicAsk),
  };
}

module.exports = {
  QUIET_MS,
  REMIND_MS,
  TTL_MS,
  DEDUP_MS,
  MAX_OPTIONS,
  contentLines,
  detectAsk,
  askFingerprint,
  createPaneAskRuntime,
};
