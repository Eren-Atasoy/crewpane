// ENG-19 (SPRINT-ENGINE-03) — LİDER-UYGUNLUK: "bu motor takımı yönetebilir mi?"
//
// EREN KARARI (2026-08-18): zayıf motor lider OLABİLİR ama YALNIZ başka seçenek
// yoksa. Sisteme daha güçlü bir motor login olmuşsa lider ONDAN seçilmeli. Elle
// zayıf motor seçmek ENGELLENMEZ — yalnız UYARILIR.
//
// ─────────────────────────────────────────────────────────────────────────────
// TASARIM KARARI: HÜKÜM BEYAN EDİLMEZ, TÜRETİLİR.
//
// Görev iki yol öneriyordu: (a) her descriptor'a elle `leadership:'full'|…` yaz,
// (b) mevcut yetenek beyanlarından TÜRET. (a) reddedildi ve sebebi ENG-04'ün
// varlık sebebinin ta kendisi: elle yazılan bir hüküm DOKUZUNCU elle-senkron
// defterdir. Biri `mcp`yi `null` yapıp `leadership:'full'`ü unutursa ürün, araç
// bağlayamayan bir motoru "tam lider" diye ÖNERİR ve hiçbir kapı bunu yakalamaz —
// çünkü hüküm bir ÖLÇÜMÜN değil bir GÖRÜŞÜN aynası olur. Türetmede sapma
// TANIM GEREĞİ imkânsızdır: yetenek düşerse hüküm o anda düşer.
//
// Yani "lider-uygunluk alanı"nın EVİ burasıdır ve değeri descriptor'ın KENDİ
// alanlarından okunur (ENG-10 `paneCapabilityMatrix` + ENG-11 `completionChannels`
// ile aynı desen: eşleme burada, gerçek defterde).
//
// ⚠️ MOTOR ADI DALI YOK. Hiçbir kural `id === 'claude'` demez; kayıtsız motor
// `never` olur (tanımadığımız motoru sessizce lider yapmayız —
// [[feedback_no_hardcoded_brand_cases]]).
//
// ─────────────────────────────────────────────────────────────────────────────
// LİDER NE YAPAR — ve hangi yetenek onu taşır (kod referanslarıyla):
//
//   1. KİM OLDUĞUNU BİLİR       → `identity`  (agentRunner.js `leaderSignal` lider
//      talimatını kimlik metnine gömer; kimlik taşıyıcısı olmayan motora "sen
//      lidersin" DENEMEZ)                                        → ENGELLEYİCİ
//   2. DELEGE EDER               → matris `board` (per-launch MCP kaydı;
//      `withLeaderDelegation` delegate+task+browser server'larını AÇILIŞTA bağlar).
//      Yalnız kalıcı config dosyasına yazabilen motorda bu yol YOKTUR ve ENG-06
//      CLI köprüsünde `delegate` grubu BİLİNÇLİ KAPALIDIR (ENG-11 §C) → o motor
//      delege EDEMEZ                                             → ENGELLEYİCİ
//   3. GÖRÜNMEZ ALT-AJAN AÇMAZ  → matris `subagentBlock` (ADR-004 sert katman;
//      düşerse lider işi patronun göremediği bir alt-ajana verebilir)   → ZAYIFLATICI
//   4. HER TURDA BRİFİNG ALIR   → matris `briefing` (hook yüzeyi)       → ZAYIFLATICI
//   5. HAFIZASINA YAZAR          → matris `memoryWrite` (`--add-dir` kökleri) → ZAYIFLATICI
//
// ENGELLEYİCİ eksikse `never` (asla OTOMATİK önerilmez — elle seçim yine serbest).
// ZAYIFLATICI eksik/kısmiyse `fallback` (başka seçenek yoksa lider olur, UYARIYLA).
// Hepsi tamsa `full`.
//
// ─────────────────────────────────────────────────────────────────────────────
// İKİNCİ BOYUT — GİRİŞ. Yetenek "yapabilir"dir, giriş "bugün çalışır"dır. Giriş
// DOĞRULANMAMIŞ bir motoru önermek, [[ref_whatsapp_status_column_lies]] hatasının
// aynısı olurdu: ölçemediğimiz bir durumu "bağlı" saymak. Bu yüzden otomatik
// öneriye YALNIZ `loggedIn === true` (motorun KENDİ durum komutundan okunmuş)
// motorlar girer; "bilinmiyor" (ENG-12 üçüncü durumu) girmez ama uyarıda ADIYLA
// anılır ("X'in girişi doğrulanırsa otomatik önerilir").

'use strict';

const engineRegistry = require('./engineRegistry.cjs');
const paneCapabilityMatrix = require('../terminal/paneCapabilityMatrix.cjs');

/** Lider-uygunluk sınıfları — iyiden kötüye. */
const LEADERSHIP_CLASSES = Object.freeze(['full', 'fallback', 'never']);

/** Giriş durumu sınıfları (engineAuth `readStatus` çıktısının üç-durum özeti). */
const AUTH_STATES = Object.freeze(['in', 'unknown', 'out', 'missing']);

/**
 * Liderin işini taşıyan yetenekler. `source` hükmün NEREDEN okunduğunu söyler:
 *   • `descriptor` — doğrudan descriptor alanı (dolu/null)
 *   • `matrix`     — ENG-10 kullanıcı-yüzü matrisi (o alanın incelmeleri dahil)
 * `severity`: `blocking` → eksikse `never` · `degrading` → eksik/kısmiyse `fallback`.
 */
const LEADER_REQUIREMENTS = Object.freeze([
  Object.freeze({
    id: 'identity',
    source: 'descriptor',
    key: 'identity',
    severity: 'blocking',
    why: 'kimlik taşıyıcısı yok → pane\'e "sen lidersin" denemez (delegasyon talimatı kimlik metnindedir)',
  }),
  Object.freeze({
    id: 'delegateTool',
    source: 'matrix',
    key: 'board',
    severity: 'blocking',
    why: 'per-launch MCP kaydı yok → delegate/görev araçları pane açılışında bağlanamaz; bu motor delege EDEMEZ',
  }),
  Object.freeze({
    id: 'subagentBlock',
    source: 'matrix',
    key: 'subagentBlock',
    severity: 'degrading',
    why: 'sert alt-ajan bloğu yok → lider işi patronun GÖREMEDİĞİ bir alt-ajana verebilir (ADR-004 katmanı düşer)',
  }),
  Object.freeze({
    id: 'briefing',
    source: 'matrix',
    key: 'briefing',
    severity: 'degrading',
    why: 'tur-başı brifing yüzeyi yok → lider takımın durumunu her turda taze GÖREMEZ',
  }),
  Object.freeze({
    id: 'memoryWrite',
    source: 'matrix',
    key: 'memoryWrite',
    severity: 'degrading',
    why: 'ek kök dizini bağlanamıyor → liderin kalıcı hafıza dizini erişim kökünde OLMAYABİLİR',
  }),
]);

/** Sınıf sırası (büyük = daha uygun). */
function classRank(cls) {
  return cls === 'full' ? 2 : cls === 'fallback' ? 1 : 0;
}

/** Yetenek hükmü sırası (büyük = daha iyi) — paneCapabilityMatrix ile aynı ölçek. */
function stateRank(state) {
  return state === 'full' ? 2 : state === 'partial' ? 1 : 0;
}

/**
 * Bir motorun LİDER-UYGUNLUĞU — descriptor'ın kendi beyanından türetilmiş.
 *
 * @param {string|null} engineId
 * @param {object} [opts]
 * @param {object} [opts.registry] - test/e2e dikişi (engineRegistry API'si)
 * @param {object} [opts.matrix]   - test dikişi (paneCapabilityMatrix API'si)
 * @returns {{engine:string|null, class:string, blockers:string[], gaps:string[],
 *           requirements:Array<object>, registered:boolean}}
 */
function leadershipOf(engineId, opts = {}) {
  const reg = opts.registry || engineRegistry;
  const mtx = opts.matrix || paneCapabilityMatrix;
  const id = typeof engineId === 'string' ? engineId.trim() : '';

  if (!id || !reg.isRegisteredEngine(id)) {
    // Kayıtsız motor: yeteneklerini BİLMİYORUZ. "Bilmiyoruz" bir yetenek iddiası
    // değildir → otomatik öneriye asla girmez (ENG-R3 §14-R1 disiplini).
    return Object.freeze({
      engine: id || null,
      class: 'never',
      registered: false,
      blockers: ['unregistered'],
      gaps: [],
      requirements: [],
    });
  }

  const matrix = mtx.buildMatrix(id, { registry: reg }) || {};
  const declared = new Map();
  for (const item of reg.unsupportedCapabilities(id)) declared.set(item.capability, item);

  const requirements = [];
  const blockers = [];
  const gaps = [];

  for (const req of LEADER_REQUIREMENTS) {
    let state;
    let reason = null;
    if (req.source === 'descriptor') {
      const value = reg.capability(id, req.key);
      state = value === null || value === undefined ? 'missing' : 'full';
      if (state === 'missing') {
        const decl = declared.get(req.key);
        reason = decl ? decl.reason : 'yetenek beyan edilmemiş';
      }
    } else {
      const cell = matrix[req.key] || null;
      state = cell ? cell.state : 'missing';
      reason = cell ? cell.reason : 'yetenek matriste yok';
    }
    if (state !== 'full') {
      gaps.push(req.id);
      if (req.severity === 'blocking' && state === 'missing') blockers.push(req.id);
    }
    requirements.push(
      Object.freeze({ id: req.id, capability: req.key, severity: req.severity, state, reason, why: req.why }),
    );
  }

  const cls = blockers.length ? 'never' : gaps.length ? 'fallback' : 'full';
  return Object.freeze({
    engine: id,
    class: cls,
    registered: true,
    blockers: Object.freeze(blockers),
    gaps: Object.freeze(gaps),
    requirements: Object.freeze(requirements),
  });
}

/**
 * `engineAuth.readStatus` çıktısını ÜÇ-DURUM + kurulum özetine indirger.
 * `null`/eksik durum → 'unknown' (ölçemedik ≠ bağlı değil).
 */
function authStateOf(status) {
  if (!status || typeof status !== 'object') return 'unknown';
  if (status.installed === false) return 'missing';
  if (status.loggedIn === true) return 'in';
  if (status.statusUnknown === true || status.loggedIn === null || status.loggedIn === undefined) return 'unknown';
  if (status.error === 'probe-failed') return 'unknown';
  return status.loggedIn === false ? 'out' : 'unknown';
}

/** Otomatik öneriye girme koşulu: uygunluk `never` DEĞİL ve giriş DOĞRULANMIŞ. */
function isEligible(entry) {
  return entry.class !== 'never' && entry.auth === 'in';
}

/**
 * Adayları lider-uygunluğuna göre SIRALAR (saf, deterministik).
 *
 * Sıra anahtarları — büyükten küçüğe:
 *   1. uygun mu (sınıf ≠ never VE giriş doğrulanmış)
 *   2. sınıf (full > fallback > never)
 *   3. giriş (in > unknown > out > missing)
 *   4. eksik yetenek sayısı (az olan önde)
 *   5. defter sırası (kararlılık — İSİM tercihi DEĞİL, giriş sırasının aynası)
 *
 * @param {Array<{engine:string, status?:object, auth?:string}>} candidates
 * @param {object} [opts] - leadershipOf'a geçer (registry/matrix dikişleri)
 */
function rankLeaderCandidates(candidates, opts = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const entries = list.map((c, index) => {
    const engine = typeof c === 'string' ? c : c && c.engine;
    const fit = leadershipOf(engine, opts);
    const auth = c && typeof c.auth === 'string' ? c.auth : authStateOf(c && c.status);
    return {
      engine: fit.engine,
      class: fit.class,
      registered: fit.registered,
      blockers: fit.blockers,
      gaps: fit.gaps,
      requirements: fit.requirements,
      auth: AUTH_STATES.includes(auth) ? auth : 'unknown',
      index,
    };
  });
  const authRank = (a) => AUTH_STATES.length - AUTH_STATES.indexOf(a);
  return entries
    .map((e) => ({ ...e, eligible: isEligible(e) }))
    .sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      const c = classRank(b.class) - classRank(a.class);
      if (c) return c;
      const au = authRank(b.auth) - authRank(a.auth);
      if (au) return au;
      const g = a.gaps.length - b.gaps.length;
      if (g) return g;
      return a.index - b.index;
    });
}

/**
 * Sınıfı `cls`ten KESİN olarak daha iyi olan, ama bugün önerilemeyen motorlar —
 * uyarının "… login olursa otomatik önerilir" cümlesinin VERİSİ. Sırayı
 * `rankLeaderCandidates` belirler; burada isim/sabit liste YOKTUR.
 */
function betterCandidates(ranked, cls) {
  return ranked
    .filter((e) => !e.eligible && classRank(e.class) > classRank(cls) && e.auth !== 'missing')
    .map((e) => Object.freeze({ engine: e.engine, class: e.class, auth: e.auth }));
}

/**
 * OTOMATİK LİDER MOTORU ÖNERİSİ.
 *
 * @returns {{engine:string|null, class:string|null, auth:string|null,
 *            warning:null|{kind:string, engine:string|null, class:string|null,
 *                          gaps:string[], better:Array<object>},
 *            ranked:Array<object>}}
 *
 * `warning`:
 *   • `null`                        — önerilen motor `full` (uyarıya gerek yok)
 *   • `weak-leader-engine`          — zayıf motor lider oldu ÇÜNKÜ başka seçenek yok
 *   • `no-eligible-leader-engine`   — girişi doğrulanmış uygun motor HİÇ yok
 */
function recommendLeaderEngine(candidates, opts = {}) {
  const ranked = rankLeaderCandidates(candidates, opts);
  const best = ranked.find((e) => e.eligible) || null;
  if (!best) {
    return {
      engine: null,
      class: null,
      auth: null,
      warning: {
        kind: 'no-eligible-leader-engine',
        engine: null,
        class: null,
        gaps: [],
        better: betterCandidates(ranked, 'never'),
      },
      ranked,
    };
  }
  const warning =
    best.class === 'full'
      ? null
      : {
          kind: 'weak-leader-engine',
          engine: best.engine,
          class: best.class,
          gaps: [...best.gaps],
          better: betterCandidates(ranked, best.class),
        };
  return { engine: best.engine, class: best.class, auth: best.auth, warning, ranked };
}

/**
 * ELLE SEÇİM UYARISI — Eren kuralı: seçim ENGELLENMEZ, yalnız uyarılır.
 *
 * @returns {null|{kind:string, engine:string, class:string, gaps:string[],
 *                 auth:string, better:Array<object>}}
 *   • `null`               — motor `full` (uyarı yok)
 *   • `weak-leader-engine` — `fallback` sınıfı
 *   • `unfit-leader-engine`— `never` sınıfı (otomatik ASLA önerilmez; elle seçildi)
 */
function leadershipWarningFor(engineId, candidates, opts = {}) {
  const ranked = rankLeaderCandidates(candidates, opts);
  const id = typeof engineId === 'string' ? engineId.trim() : '';
  const self = ranked.find((e) => e.engine === id) || {
    ...leadershipOf(id, opts),
    auth: 'unknown',
    eligible: false,
  };
  if (self.class === 'full') return null;
  return {
    kind: self.class === 'never' ? 'unfit-leader-engine' : 'weak-leader-engine',
    engine: self.engine,
    class: self.class,
    auth: self.auth,
    gaps: [...self.gaps],
    better: betterCandidates(ranked, self.class),
  };
}

module.exports = {
  LEADERSHIP_CLASSES,
  AUTH_STATES,
  LEADER_REQUIREMENTS,
  leadershipOf,
  authStateOf,
  rankLeaderCandidates,
  recommendLeaderEngine,
  leadershipWarningFor,
};
