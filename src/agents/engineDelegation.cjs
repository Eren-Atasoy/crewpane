// ENG-17 (SPRINT-ENGINE-03) — DELEGASYON VATANDAŞLIĞI: "bu motora İŞ VERİLEBİLİR Mİ?"
//
// NEDEN AYRI BİR HÜKÜM: ENG-19 `engineLeadership` "bu motor takımı YÖNETEBİLİR Mİ?"
// sorusunu cevaplıyor. Bu dosya TERS yönü sorar: motor bir delegasyon WORKER'ı olarak
// sürülebilir mi — yani lider ona görev verip ilerlemesini İZLEYEBİLİR mi?
//
// İkisi aynı şey DEĞİLDİR ve crush bunu ölçümle gösterdi: crush kimliğini alır,
// araçlarını bağlar, alt-ajanını kapatır, jetonunu ve MALİYETİNİ bile raporlar —
// ama KOŞARKEN hiçbir yapılandırılmış şey basmaz (`crush run --json` → "Unknown
// flag: --json"). Süpervizör tur boyunca KÖRDÜR: ilerleme yok, araç çağrısı yok,
// asılma sinyali yok, oturum kimliği yok. Böyle bir süreci "worker" saymak,
// ilerlemesini ÖLÇEMEDİĞİMİZ bir işi "yürüyor" diye raporlamaktır.
//
// ─────────────────────────────────────────────────────────────────────────────
// TASARIM KARARI: HÜKÜM BEYAN EDİLMEZ, TÜRETİLİR (ENG-19 ile aynı disiplin).
//
// Görev metni "descriptor'a `delegation:false` yaz" diyordu. Elle yazılan bir bayrak
// ONUNCU elle-senkron defterdir ve ENG-16'nın dersi tam buydu: amp delegasyona
// "kapalı" diye YAZILMADI, kapalı OLDUĞU MAKİNEYLE uygulandı (`identity: null` →
// leadership 'never'). Burada da aynı: crush'ın kapısını kapatan şey `output: null`
// beyanıdır — bir gün motor `--output-format json` eklerse ve descriptor ölçümle
// güncellenirse hüküm KENDİLİĞİNDEN açılır. Elle bayrak olsaydı ilk unutulan
// yerde ters yönde kalırdı.
//
// ⚠️ MOTOR ADI DALI YOK. Hiçbir kural `id === 'crush'` demez; kayıtsız motor
// 'unknown' + capable:false olur ([[feedback_no_hardcoded_brand_cases]]).

'use strict';

const engineRegistry = require('./engineRegistry.cjs');
const paneCapabilityMatrix = require('../terminal/paneCapabilityMatrix.cjs');

/**
 * Vatandaşlık sınıfları:
 *   • `delegation-worker`      — lider bu pane'e iş verebilir ve ilerlemesini izler
 *   • `interactive-companion`  — pane'de İNSAN EŞLİĞİNDE koşar; otomatik iş VERİLMEZ
 *   • `unknown`                — motor defterde yok; sessizce yetenekli SAYILMAZ
 */
const DELEGATION_CLASSES = Object.freeze(['delegation-worker', 'interactive-companion', 'unknown']);

/**
 * Worker olmanın ön koşulları. `severity`:
 *   • `blocking`  — eksikse worker OLAMAZ (sınıf `interactive-companion`)
 *   • `degrading` — eksikse worker olur ama UYARIYLA (rozet bunu söyler)
 *
 * `source`: `descriptor` (alan dolu/null) · `matrix` (ENG-10 kullanıcı-yüzü hükmü).
 */
const WORKER_REQUIREMENTS = Object.freeze([
  Object.freeze({
    id: 'output',
    source: 'descriptor',
    key: 'output',
    severity: 'blocking',
    why:
      'koşunun yapılandırılmış çıktısı yok → süpervizör tur SIRASINDA ilerlemeyi, araç çağrısını, ' +
      'asılmayı ve bitiş nedenini GÖREMEZ; ilerlemesi ölçülemeyen bir süreç worker olarak sürülemez',
  }),
  Object.freeze({
    id: 'identity',
    source: 'descriptor',
    key: 'identity',
    severity: 'blocking',
    why:
      'per-pane kimlik taşıyıcısı yok → worker\'a "sen kimsin, görevin ne, raporunu nereye yaz" ' +
      'denemez; aynı dizindeki iki worker ayrışamaz',
  }),
  Object.freeze({
    id: 'resume',
    source: 'matrix',
    key: 'resume',
    severity: 'degrading',
    why: 'oturum sürdürme yarım → kesilen bir iş kaldığı yerden devam ettirilemez (ADP-192 yolu kapalı)',
  }),
  Object.freeze({
    id: 'subagentBlock',
    source: 'matrix',
    key: 'subagentBlock',
    severity: 'degrading',
    why: 'sert alt-ajan bloğu yok → worker işi patronun GÖREMEDİĞİ bir alt-ajana verebilir (ADR-004 katmanı düşer)',
  }),
]);

/** 'full' > 'partial' > 'missing' — matris hükmünün sayısal karşılığı. */
function stateRank(state) {
  return state === 'full' ? 2 : state === 'partial' ? 1 : 0;
}

/**
 * Bir motorun DELEGASYON vatandaşlığı — descriptor'ın kendi beyanından türetilmiş.
 *
 * @param {string|null} engineId
 * @param {object} [opts]
 * @param {object} [opts.registry] - test dikişi (engineRegistry API'si)
 * @param {object} [opts.matrix]   - test dikişi (paneCapabilityMatrix API'si)
 * @returns {{engine:string|null, class:string, capable:boolean,
 *           blockers:Array<{id:string,severity:string,why:string,reason:string|null}>,
 *           warnings:Array<{id:string,severity:string,why:string,reason:string|null}>,
 *           badge:string}}
 */
function delegationVerdict(engineId, opts = {}) {
  const reg = opts.registry || engineRegistry;
  const mtx = opts.matrix || paneCapabilityMatrix;
  const id = typeof engineId === 'string' ? engineId.trim() : '';

  if (!id || !reg.isRegisteredEngine(id)) {
    return Object.freeze({
      engine: null,
      class: 'unknown',
      capable: false,
      blockers: Object.freeze([]),
      warnings: Object.freeze([]),
      badge: 'Bu motor ürün defterinde YOK → otomatik iş VERİLMEZ (tanımadığımız motor sessizce yetenekli sayılmaz).',
    });
  }

  // Gerekçelerin TEK kaynağı descriptor'ın kendi beyanı (uydurma metin yok).
  const declared = new Map();
  for (const item of reg.unsupportedCapabilities(id)) declared.set(item.capability, item);
  const matrix = mtx.buildMatrix(id) || {};

  const blockers = [];
  const warnings = [];
  for (const req of WORKER_REQUIREMENTS) {
    let ok;
    let reason = null;
    if (req.source === 'descriptor') {
      const value = reg.capability(id, req.key);
      ok = value !== null && value !== undefined;
      const decl = declared.get(req.key);
      reason = decl ? decl.reason : null;
    } else {
      const cell = matrix[req.key];
      ok = !!cell && stateRank(cell.state) === 2;
      reason = cell ? cell.reason : null;
    }
    if (ok) continue;
    const item = Object.freeze({ id: req.id, severity: req.severity, why: req.why, reason });
    (req.severity === 'blocking' ? blockers : warnings).push(item);
  }

  const capable = blockers.length === 0;
  return Object.freeze({
    engine: id,
    class: capable ? 'delegation-worker' : 'interactive-companion',
    capable,
    blockers: Object.freeze(blockers),
    warnings: Object.freeze(warnings),
    badge: buildBadge(reg.getEngine(id).label || id, capable, blockers, warnings),
  });
}

/**
 * Rozet cümlesi. KAPALI bir motorda cümle ne olduğunu ve NEDEN olduğunu SÖYLER
 * (ENG-16 fatura rozetiyle aynı sözleşme: rozet bir etiket değil, bir açıklamadır).
 */
function buildBadge(label, capable, blockers, warnings) {
  if (capable) {
    if (!warnings.length) return `${label}: delegasyon worker'ı olarak AÇIK (dört ön koşul da tam).`;
    return (
      `${label}: delegasyon worker'ı olarak AÇIK — ama eksikle: ` +
      warnings.map((w) => w.id).join(', ') +
      `. ${warnings[0].why}`
    );
  }
  return (
    `${label}: pane'de koşar ama otomatik iş VERİLMEZ (interaktif eşlik motoru). ` +
    `Engelleyen: ${blockers.map((b) => b.id).join(', ')} — ${blockers[0].why}.`
  );
}

/** Kısa hüküm: bu motora delegasyon yapılabilir mi? */
function canDelegateTo(engineId, opts = {}) {
  return delegationVerdict(engineId, opts).capable;
}

module.exports = {
  DELEGATION_CLASSES,
  WORKER_REQUIREMENTS,
  delegationVerdict,
  canDelegateTo,
};
