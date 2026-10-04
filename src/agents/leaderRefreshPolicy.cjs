'use strict';

// LDR-F1 — LİDER OTURUMUNUN OTOMATİK TAZELENMESİ: kararın SAF çekirdeği.
//
// ── LDR-R1'İN BULGUSU (bu dosyanın varlık sebebi) ───────────────────────────
// `dispatchPolicy` bir GELEN-İŞ kapısıdır: yalnız sistem bir pane'e iş YAZARKEN
// (lider→worker delegasyonu · board görevi) koşar. Liderin bağlamını büyüten üç
// yol (kullanıcının kendi promptları · tur-başı brifing · supervisor uyandırması)
// o kapıdan HİÇ geçmez → ölçülen canlı loglarda 42 `dispatch-policy` satırının
// 42'si de `kaynak=delegation`, lider kaynaklı SIFIR karar. Yani eşik yanlış
// değildi, ölçüm yanlış değildi, karar yanlış değildi: KİMSE SORMUYORDU.
//
// Bu modül kararı YENİDEN ÜRETMEZ. `dispatchPolicy.decide` ne diyorsa odur; burada
// yalnız "o karar liderde ŞU AN uygulanabilir mi" sorusu cevaplanır:
//   kip (off/warn/auto) · soğuma · backoff · deneme tavanı · güvenli-an · uçuşta iş.
//
// ── SÖZLEŞMELER ─────────────────────────────────────────────────────────────
//  1. SAF: Date.now yok, IO yok, log yok, kimlik yok. Zaman/tampon/defter hep
//     DIŞARIDAN girer → tek satır bile `node --test` ile ölçülebilir.
//  2. ERTELEME DENEME DEĞİLDİR (ADP-672 dersi). Kullanıcı klavyede diye ertelenen
//     bir tur backoff'u büyütmemeli; yoksa aktif kullanılan bir lider pane'i
//     birkaç turda "deneme tükendi"ye düşer ve bir daha HİÇ tazelenmez.
//  3. `warn` VARSAYILANDIR ve ürün o kipte lidere TEK BAYT yazmaz. Lider pane'ine
//     kendiliğinden yazmak bu üründeki en pahalı yanlıştır (bağlam geri gelmez):
//     kullanıcı bir kez AÇSIN.
//  4. Eşikler CONFIG'ten (`modelPricing.contextEconomics.dispatch.leader`). Bu
//     dosyadaki sabitler yalnız config OKUNAMAZSA devreye giren emniyet tabanıdır
//     ve `leaderConfigFrom` onları KAYNAK ADIYLA raporlar (sessiz varsayılan yok).

const { HANDOFF_HEADER, HANDOFF_FOOTER } = require('./handoffBlock.cjs');

/** Ayarın kapalı listesi. `auto` seçilmeden ürün lidere kendiliğinden YAZMAZ. */
const MODES = Object.freeze(['off', 'warn', 'auto']);
const DEFAULT_MODE = 'warn';

/**
 * Config okunamazsa kullanılan emniyet tabanı. 🔴 Bunlar "eşik" DEĞİLDİR: gerçek
 * tazeleme eşiği `dispatchPolicy`nin kendisindedir (200K bağlam / 300 istek) ve
 * BURADA TEKRAR EDİLMEZ. Buradakiler yalnız ZAMANLAMA parametreleridir.
 */
const LEADER_FALLBACK = Object.freeze({
  /** Uyarı hangi orandan başlasın (karar eşiğinin yüzdesi). 0,85 × 200K = 170K. */
  warnRatio: 0.85,
  /** İki OTOMATİK tazeleme arasındaki en az süre (sonsuz döngü freni). */
  cooldownMinutes: 15,
  /** Başarısız denemeler arası artan bekleme. */
  backoffMinutes: Object.freeze([2, 5, 15, 30]),
  /** Bu kadar başarısız denemeden sonra kanal bırakılır (kullanıcı elle tazeler). */
  maxAttempts: 6,
});

/**
 * Config'ten lider zamanlama parametreleri.
 * @param {object|null} pricing `modelPricing.json` (tokenCost.DEFAULT_PRICING)
 * @returns {{warnRatio:number, cooldownMinutes:number, backoffMinutes:number[],
 *           maxAttempts:number, source:'config'|'fallback'|'partial'}}
 */
function leaderConfigFrom(pricing) {
  const d = ((pricing && pricing.contextEconomics) || {}).dispatch || {};
  const raw = d.leader || null;
  const out = { ...LEADER_FALLBACK, backoffMinutes: [...LEADER_FALLBACK.backoffMinutes] };
  if (!raw || typeof raw !== 'object') return { ...out, source: 'fallback' };
  let hits = 0;
  let misses = 0;
  const num = (v, min, max) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null);
  const ratio = num(raw.warnRatio, 0.1, 1);
  if (ratio === null) misses++;
  else {
    out.warnRatio = ratio;
    hits++;
  }
  const cooldown = num(raw.cooldownMinutes, 0, 24 * 60);
  if (cooldown === null) misses++;
  else {
    out.cooldownMinutes = cooldown;
    hits++;
  }
  const attempts = num(raw.maxAttempts, 1, 100);
  if (attempts === null) misses++;
  else {
    out.maxAttempts = Math.floor(attempts);
    hits++;
  }
  const backoff = Array.isArray(raw.backoffMinutes)
    ? raw.backoffMinutes.map((m) => num(m, 0, 24 * 60)).filter((m) => m !== null)
    : [];
  if (!backoff.length) misses++;
  else {
    out.backoffMinutes = backoff;
    hits++;
  }
  return { ...out, source: misses === 0 ? 'config' : hits ? 'partial' : 'fallback' };
}

/** Kapalı liste: tanınmayan/çöp değer VARSAYILANA (`warn`) düşer. */
function normalizeMode(v) {
  return typeof v === 'string' && MODES.includes(v) ? v : DEFAULT_MODE;
}

/**
 * ROZETİN HÜKMÜ — "kullanıcı bunu görmeden özellik YOK sayılır" (LDR-R1 §5.4).
 *
 * 🔴 B5'in kapanışı: kullanıcının gördüğü "1,3M" ile kararın baktığı sayı FARKLI
 * büyüklüklerdir (biri BİRİKMİŞ İŞ, diğeri SON İSTEĞİN BAĞLAMI). Rozet bu yüzden
 * jetonu değil, kararın kendi ölçüsünü — bağlamın eşiğe oranını — basar.
 *
 * @returns {{state:'off'|'unmeasured'|'ok'|'warn'|'due', pct:number|null,
 *            ctxTokens:number|null, threshold:number|null, code:string|null}}
 */
function badgeState({ decision, mode, cfg } = {}) {
  const m = normalizeMode(mode);
  const c = cfg || LEADER_FALLBACK;
  if (m === 'off') return { state: 'off', pct: null, ctxTokens: null, threshold: null, code: null };
  if (!decision || decision.action === 'unmeasured') {
    return { state: 'unmeasured', pct: null, ctxTokens: null, threshold: null, code: decision ? decision.code : null };
  }
  const ctx = decision.measured && typeof decision.measured.ctxTokens === 'number' ? decision.measured.ctxTokens : null;
  const th =
    decision.thresholds && typeof decision.thresholds.freshCtxThresholdTokens === 'number'
      ? decision.thresholds.freshCtxThresholdTokens
      : null;
  // Oran ölçülemiyorsa UYDURULMAZ (null) — rozet sayısız kalır, yalan basmaz.
  const pct = ctx !== null && th !== null && th > 0 ? Math.round((ctx / th) * 100) : null;
  if (decision.action === 'refresh') {
    return { state: 'due', pct, ctxTokens: ctx, threshold: th, code: decision.code };
  }
  if (pct !== null && pct >= Math.round(c.warnRatio * 100)) {
    return { state: 'warn', pct, ctxTokens: ctx, threshold: th, code: decision.code };
  }
  return { state: 'ok', pct, ctxTokens: ctx, threshold: th, code: decision.code };
}

/** Backoff: n. başarısız denemeden SONRA en erken ne zaman tekrar denenir. */
function nextRetryAtMs(attempt, fromMs, cfg) {
  const c = cfg || LEADER_FALLBACK;
  const list = c.backoffMinutes && c.backoffMinutes.length ? c.backoffMinutes : LEADER_FALLBACK.backoffMinutes;
  const idx = Math.min(Math.max(0, attempt - 1), list.length - 1);
  return fromMs + list[idx] * 60_000;
}

/**
 * TAZELEME KAPISI — "şu an yazayım mı?".
 *
 * @param {object} o
 *   decision          dispatchPolicy kararı (bu modül YENİDEN ÖLÇMEZ)
 *   mode              'off'|'warn'|'auto'
 *   isLeader          pane bir LİDER pane'i mi (rol + execution-pane DEĞİL)
 *   nowMs             çağıranın saati (saflık: Date.now BURADA YOK)
 *   attempts          bu pane için PEŞ PEŞE başarısız deneme sayısı
 *   lastAttemptAtMs   son SAYILAN denemenin damgası (0 = hiç)
 *   lastRefreshAtMs   son BAŞARILI otomatik tazelemenin damgası (0 = hiç)
 *   gate              {safe:boolean, reason:string} — leaderComposer.injectionGate
 *   inFlight          bu liderin uçuştaki (dispatched/working) delegasyon sayısı
 *   cfg               leaderConfigFrom(...)
 * @returns {{go:boolean, reason:string, countAttempt:boolean, retryAtMs:number|null}}
 */
function refreshGate(o = {}) {
  const cfg = o.cfg || LEADER_FALLBACK;
  const now = typeof o.nowMs === 'number' ? o.nowMs : 0;
  const no = (reason, countAttempt = false, retryAtMs = null) => ({ go: false, reason, countAttempt, retryAtMs });

  const mode = normalizeMode(o.mode);
  // (1) KİP — `warn`/`off` kipinde ürün lidere TEK BAYT yazmaz (sözleşme 3).
  if (mode !== 'auto') return no(`mode-${mode}`);
  if (o.isLeader !== true) return no('not-leader');
  // (2) KARAR — politika "tazele" demiyorsa burada iş yok.
  if (!o.decision || o.decision.action !== 'refresh') {
    return no(o.decision ? `not-due:${o.decision.code}` : 'not-due:undecidable');
  }
  // (3) SOĞUMA — taze bir oturumun kendi tabanı ~90K'dır; art arda tazeleme
  //     bağlamı küçültmez, yalnız para ve devir turu harcar (sonsuz döngü freni).
  const lastRefresh = typeof o.lastRefreshAtMs === 'number' ? o.lastRefreshAtMs : 0;
  if (lastRefresh > 0 && now - lastRefresh < cfg.cooldownMinutes * 60_000) {
    return no('cooldown', false, lastRefresh + cfg.cooldownMinutes * 60_000);
  }
  // (4) DENEME TAVANI — kanal tükendiyse ürün ısrar etmez (rozet uyarmaya devam eder).
  const attempts = typeof o.attempts === 'number' && o.attempts > 0 ? o.attempts : 0;
  if (attempts >= cfg.maxAttempts) return no('attempts-exhausted');
  // (5) BACKOFF — son SAYILAN denemeden beri yeterli süre geçti mi.
  const lastAttempt = typeof o.lastAttemptAtMs === 'number' ? o.lastAttemptAtMs : 0;
  if (attempts > 0 && lastAttempt > 0) {
    const due = nextRetryAtMs(attempts, lastAttempt, cfg);
    if (now < due) return no('backoff', false, due);
  }
  // (6) UÇUŞTA İŞ — lider worker beklerken oturumunu tazelemek, gelen bitiş
  //     mesajının taze oturuma düşmesi demektir; kayıt kaybolmaz ama lider
  //     bağlamsız yakalar. Defter zaten kalıcı → sonraki tura ERTELE.
  if (typeof o.inFlight === 'number' && o.inFlight > 0) return no('delegation-in-flight');
  // (7) GÜVENLİ AN — insan yazıyor / tur koşuyor. 🔴 ERTELEME DENEME DEĞİLDİR.
  const gate = o.gate || { safe: false, reason: 'gate-missing' };
  if (gate.safe !== true) return no(`unsafe:${gate.reason || 'unknown'}`);
  return { go: true, reason: 'ok', countAttempt: true, retryAtMs: null };
}

/**
 * G3 — SIFIRLAMA ENGELİ. "Devir özeti alınamadıysa `/clear` yazılır mı?"
 *
 * LDR-R1 B3 (canlı log kanıtı: 19 tazelemenin 2'si `devir=hayır(timeout)`):
 * bugüne dek özet gelmese de sıfırlama YAPILIYORDU. Worker'da tolere edilebilir —
 * alt-görev metni zaten yeniden yazılacaktır. LİDERDE aynı davranış TÜM oturum
 * bağlamının KANITSIZ yok edilmesidir ve `/clear` GERİ ALINAMAZ.
 *
 * ÜÇ DAL ve üçü de bilinçli:
 *   • bayrak YOK            → bugünkü davranış (worker yolu DEĞİŞMEZ)
 *   • bayrak VAR, özet İSTENMEMİŞ → engel YOK: karar `handoff:false` derse taşınacak
 *     bağlam zaten taban altındadır (kayıp yok); orada şart koşmak tazelemeyi
 *     sonsuza dek kilitlerdi
 *   • bayrak VAR, özet İSTENMİŞ ama GELMEMİŞ → ENGEL: bağlam DURUR
 *
 * @returns {{block:boolean, reason:'ok'|'not-required'|'handoff-missing'}}
 */
function resetGate({ requireHandoff, handoffRequested, handoffOk } = {}) {
  if (requireHandoff !== true) return { block: false, reason: 'not-required' };
  if (handoffRequested !== true) return { block: false, reason: 'not-required' };
  if (handoffOk === true) return { block: false, reason: 'ok' };
  return { block: true, reason: 'handoff-missing' };
}

/**
 * G5 — TAZE OTURUMUN İLK MESAJI. Devir özeti + AÇIK alt-görevler + aktif görev kodu.
 *
 * Neden alt-görevler de: lider `/clear` yedikten sonra "kim ne yapıyordu"yu yalnız
 * supervisor defteri bilir (defter main'de KALICIDIR, renderer'a bağlı değildir).
 * Bu satırlar olmadan taze lider, uçuştaki worker'ları görmeden konuşmaya başlar.
 *
 * @param {{handoffText?:string|null, openSubtasks?:Array, taskCode?:string|null}} o
 * @returns {string} boş dize DÖNMEZ ancak her şey boşsa '' döner (çağıran yazmaz)
 */
function composeLeaderRestorePrompt(o = {}) {
  const handoff = typeof o.handoffText === 'string' ? o.handoffText.trim() : '';
  const subtasks = Array.isArray(o.openSubtasks) ? o.openSubtasks : [];
  const taskCode = typeof o.taskCode === 'string' && o.taskCode.trim() ? o.taskCode.trim() : null;
  if (!handoff && !subtasks.length && !taskCode) return '';
  const lines = [HANDOFF_HEADER];
  if (handoff) lines.push(handoff);
  if (taskCode) lines.push(`AKTİF GÖREV: ${taskCode}`);
  if (subtasks.length) {
    lines.push('AÇIK DELEGASYONLAR (supervisor defteri — bu kayıtlar tazelemeden SAĞ ÇIKTI):');
    for (const s of subtasks) {
      const who = (s && s.agentId) || '?';
      const code = (s && s.taskCode) || (s && s.subtaskId) || '?';
      const title = (s && s.title) || '';
      const st = (s && s.status) || 'in-flight';
      const pane = s && s.paneAlive === false ? ' · pane KAPALI' : '';
      lines.push(`  • ${who} — ${code}${title ? `: ${title}` : ''} [${st}]${pane}`);
    }
  } else {
    lines.push('AÇIK DELEGASYON YOK (supervisor defteri boş).');
  }
  lines.push(HANDOFF_FOOTER);
  lines.push('');
  lines.push(
    'Bağlamın tazelendi. Yukarıdaki özetten devam et: yeni iş İCAT ETME, ' +
      'açık delegasyon varsa onların durumunu takip et.',
  );
  return lines.join('\n');
}

module.exports = {
  MODES,
  DEFAULT_MODE,
  LEADER_FALLBACK,
  leaderConfigFrom,
  normalizeMode,
  badgeState,
  refreshGate,
  resetGate,
  nextRetryAtMs,
  composeLeaderRestorePrompt,
  HANDOFF_HEADER,
  HANDOFF_FOOTER,
};
