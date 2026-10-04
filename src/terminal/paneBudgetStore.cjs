// TOK-C — PANE BÜTÇESİNİN DEFTERİ (SPRINT-TOK-01)
//
// İki ayrı ömür, tek dosya değil:
//   • AYAR   (varsayılan + pane başına limit) → KALICI (`pane-budgets.json`).
//     Kullanıcının koyduğu fren uygulamayı kapatınca kaybolmamalı; kaybolursa
//     "koydum ama tutmadı" hissi frenin kendisine olan güveni bitirir.
//   • ÖDENEK ("devam et" ile açılan pay) → OTURUMLUK, diske YAZILMAZ.
//     Sebep: ödenek O ANKİ işe verilmiş bir izindir. Diske yazsaydık, ertesi gün
//     açılan uygulama dünkü "devam"ları taşır ve fren sessizce gevşemiş olurdu —
//     kullanıcı bunu hiçbir yerde göremez. Yeni oturum = temiz fren.
//
// 🔴 Kimlik körü: defterin anahtarı `paneId`dir. Ajan adı/id'si/departmanı bu
//    modülde de GEÇMEZ (paneBudget.cjs'in 1. kuralı burada da yürürlükte).
//
// Saf-ish: tüm IO korumalı (bozuk/eksik dosya → VARSAYILAN, asla fırlatmaz).
// `node --test` doğrudan yükler; ev dizini enjekte edilebilir (`configure`).

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const paneBudget = require('./paneBudget.cjs');
// 🔴 BİÇİM TEK YERDE: renderer para/jeton biçimi KOPYALAMAZ (ADP-887 kartının
// kuralı). Bütçe satırları da aynı biçimleyicilerden geçer, yoksa kartta iki
// farklı '$' dili olurdu.
const tokenCost = require('../services/tokenCost.cjs');
const { atomicWriteFileSync } = require('../../platform/atomicWrite.cjs');

const FILE_NAME = 'pane-budgets.json';
const VERSION = 1;

/** Ev dizini enjekte edilebilir: test gerçek `~/.crewpane`e yazmasın. */
let homeResolver = () => require('../config/instancePaths.cjs').crewpaneHome();

/** OTURUMLUK ödenek defteri (paneId → grant). Diske YAZILMAZ (yukarıdaki not). */
const grants = new Map();

/** Kalıcı ayarın bellek aynası; `null` = henüz okunmadı. */
let cache = null;

function configure(opts = {}) {
  if (typeof opts.home === 'function') homeResolver = opts.home;
  else if (typeof opts.home === 'string') homeResolver = () => opts.home;
  cache = null;
  grants.clear();
}

function filePath() {
  return path.join(homeResolver(), FILE_NAME);
}

function emptyState() {
  return { version: VERSION, default: paneBudget.normalize({}), panes: {} };
}

function read() {
  if (cache) return cache;
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
  } catch {
    raw = null; // dosya yok / bozuk → varsayılan (fren kurulmamış demektir)
  }
  const state = emptyState();
  if (raw && typeof raw === 'object') {
    state.default = paneBudget.normalize(raw.default || {});
    if (raw.panes && typeof raw.panes === 'object') {
      for (const [paneId, cfg] of Object.entries(raw.panes)) {
        if (typeof paneId !== 'string' || !paneId) continue;
        const n = paneBudget.normalize(cfg || {});
        // Kapalı (limitsiz) bir pane kaydı taşımanın anlamı yok → düşür.
        if (n.enabled) state.panes[paneId] = n;
      }
    }
  }
  cache = state;
  return cache;
}

function persist() {
  const state = read();
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    atomicWriteFileSync(filePath(), JSON.stringify({ version: VERSION, default: state.default, panes: state.panes }, null, 2));
    return { ok: true };
  } catch (err) {
    // Yazamadıysak SESSİZ KALMAYIZ: çağıran log'a düşürür, ayar bellekte yaşar.
    return { ok: false, error: err.message };
  }
}

/** Bu pane için yürürlükteki bütçe: pane özel > varsayılan. */
function budgetFor(paneId) {
  const state = read();
  const own = typeof paneId === 'string' ? state.panes[paneId] : null;
  return own && own.enabled ? { ...own, scope: 'pane' } : { ...state.default, scope: 'default' };
}

/**
 * Bütçe ayarla. `paneId` yoksa VARSAYILANI değiştirir (yeni pane'ler onu alır).
 * Limitleri kaldırmak için `{usd:null, tokens:null}` gönder → kayıt düşer.
 */
function setBudget(paneId, cfg) {
  const state = read();
  const n = paneBudget.normalize(cfg || {});
  if (!paneId) {
    state.default = n;
  } else if (n.enabled) {
    state.panes[paneId] = n;
  } else {
    delete state.panes[paneId];
  }
  const w = persist();
  return { ok: true, persisted: w.ok, error: w.error || null, budget: budgetFor(paneId) };
}

/** Bu pane'in oturumluk ödeneği. */
function grantFor(paneId) {
  return paneBudget.normalizeGrant(grants.get(paneId) || {});
}

/**
 * "Devam et" — freni SİLMEZ, ödenek ekler (paneBudget.extend). Dönen sayaç
 * ekranda gösterilebilir ("2. kez devam edildi") — devam etmek görünür kalmalı.
 */
function resume(paneId, nowMs, usage) {
  if (typeof paneId !== 'string' || !paneId) return { ok: false, error: 'paneId yok' };
  /* ÖLÇÜLEN harcama ödeneğe girer (paneBudget.extend'in aşım kuralı): "devam"
     düğmesi her zaman GERÇEK bir pay bırakmalı. Ölçüm verilmezse (eski çağıran)
     davranış eskisi gibi "bir limit daha"dır. */
  const s = usage && usage.session ? usage.session : null;
  const used = s
    ? { usd: typeof s.usd === 'number' ? s.usd : typeof s.usdEquivalent === 'number' ? s.usdEquivalent : null, tokens: typeof s.tokens === 'number' ? s.tokens : null }
    : {};
  const next = paneBudget.extend(budgetFor(paneId), grantFor(paneId), typeof nowMs === 'number' ? nowMs : Date.now(), used);
  grants.set(paneId, next);
  return { ok: true, grant: next };
}

/** Pane öldü → ödeneği de düş (hayalet kayıt bırakma; paneViewState deseni). */
function clearPane(paneId) {
  return grants.delete(paneId);
}

/** Kararın TAMAMI tek çağrıda: ayar + ödenek + ölçüm → karar (+ ekran biçimi). */
function decide(paneId, usage) {
  const budget = budgetFor(paneId);
  const grant = grantFor(paneId);
  const decision = paneBudget.evaluate({ usage, budget, grant });
  const fmt = (n) =>
    n === null || n === undefined
      ? null
      : decision.metric === 'tokens'
        ? tokenCost.formatTokens(n)
        : tokenCost.formatUsd(n);
  /* "Devam et" düğmesinin ETİKETİ, o tık GERÇEKTEN ne kadar açacaksa onu yazmalı.
     Limiti yazmak (ilk hâli) yanıltıcıydı: aşımı da kapsayan ödenek çoğu zaman
     limitten BÜYÜK açıyor — düğme az söz verip çok verirdi. Önizleme aynı
     `extend` fonksiyonundan geçer (ikinci bir hesap yok). */
  let resumeGrant = null;
  if (decision.state === 'paused' || decision.state === 'warn') {
    const s = usage && usage.session ? usage.session : null;
    const used = s
      ? { usd: typeof s.usd === 'number' ? s.usd : typeof s.usdEquivalent === 'number' ? s.usdEquivalent : null, tokens: typeof s.tokens === 'number' ? s.tokens : null }
      : {};
    const preview = paneBudget.extend(budget, grant, null, used);
    const key = decision.metric === 'tokens' ? 'tokens' : 'usd';
    const delta = (preview[key] ?? 0) - (grant[key] ?? 0);
    if (delta > 0) resumeGrant = delta;
  }
  return {
    ...decision,
    scope: budget.scope,
    budget: { usd: budget.usd, tokens: budget.tokens, warnRatio: budget.warnRatio },
    usedText: fmt(decision.used),
    limitText: fmt(decision.limit),
    effectiveLimitText: fmt(decision.effectiveLimit),
    resumeGrant,
    resumeGrantText: fmt(resumeGrant),
  };
}

module.exports = {
  FILE_NAME,
  configure,
  filePath,
  budgetFor,
  setBudget,
  grantFor,
  resume,
  clearPane,
  decide,
  /** Test yardımcısı — bellek aynasını at (dosya okunması yeniden yapılsın). */
  _reset() {
    cache = null;
    grants.clear();
  },
};
