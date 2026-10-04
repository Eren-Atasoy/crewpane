// TIER-SYNC-01 (Wheeljack) — SENKRON KATMAN KAPISI: "bu paket bulut senkronu içeriyor mu?"
//                            Karar: PLAN-0823-OTOPILOT §K-2 · Emsal: TIER-DESIGN-01
//
// ═══════════════════════════════════════════════════════════════════════════════
// NEDEN AYRI (VE ÇOK KÜÇÜK) BİR DOSYA
// ═══════════════════════════════════════════════════════════════════════════════
// Karar zaten `planLimits.decide` içinde. Burada TEK BİR ŞEY yapılır: o kararı
// senkronun ihtiyaç duyduğu iki alana çevirmek —
//   1. `denial`      → motorun ağa dokunan her yönteminin döndüreceği ret nesnesi
//   2. `deviceSlots` → "aynı hesap aynı anda kaç cihazda" (Ultra avantajının kendisi)
// İkisi de KATALOG VERİSİNDEN türer; bu dosyada tek bir katman adı geçmez
// (`if (tier === 'pro')` yok — planLimits KURAL 1).
//
// Ayrı durmasının sebebi motoru ikinci bir konudan korumak: `syncEngine.cjs` 880
// satır orkestrasyon; plan kararının orada büyümesi ikinci bir gerçek doğururdu.
// Ayrıca kapı bu hâliyle motorsuz sınanabilir (`node --test`).
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 KAPI KAPALI = ZORLAMA YOK (planLimits KURAL 3)
// ─────────────────────────────────────────────────────────────────────────────
// `requireSeat !== true` (geliştirici kopyası, e2e, kaynaktan koşum) → senkron
// AÇIK. İkinci bir "acaba zorlansın mı" şalteri üretmiyoruz; lisans kapısıyla aynı
// şalter. Bu yüzden birim testleri `getPlanSnapshot: () => null` verebilir ve motoru
// plan katmanına hiç girmeden ölçebilir.

'use strict';

const planLimits = require('../src/config/planLimits.cjs');
const planCatalog = require('../src/config/planCatalog.cjs');

/** Zorlanan yetenek adı — `planLimits.FEATURES` anahtarı (tek yerde yazılır). */
const FEATURE = 'cloudSync';

/** Ultra avantajının okunduğu kadran — SEC-02'nin eşzamanlılık sayacı. */
const DEVICE_FEATURE = 'devicesConcurrent';

/**
 * Anlık karar.
 * @param {{requireSeat?:boolean, tier?:string}|null} snapshot - seatGate.state()
 * @returns {{allowed:boolean, denial:object|null, enforced:boolean, tier:string,
 *   tierLabel:string, deviceSlots:number|null, requiredTierLabel:string|null}}
 */
function evaluate(snapshot) {
  const decision = planLimits.decide({ snapshot, feature: FEATURE });
  const tier = planLimits.effectiveTierId(snapshot);
  const enforced = !!(snapshot && snapshot.requireSeat === true);
  const slots = planLimits.limitFor(tier, DEVICE_FEATURE);
  return {
    allowed: decision.allowed === true,
    denial: decision.allowed === true ? null : decision,
    enforced,
    tier,
    // Etiket ELLE YAZILMAZ: reddedildiyse kararın taşıdığı etiket, izinliyse katalog.
    tierLabel: decision.allowed === true
      ? ((planCatalog.tier(tier) || {}).label || tier)
      : decision.tierLabel,
    // Ultra AVANTAJI: yeni sayı değil, mevcut kadran. `null` = bu katmanda kadran yok.
    deviceSlots: Number.isFinite(Number(slots)) ? Number(slots) : null,
    requiredTierLabel: decision.allowed === true ? null : (decision.requiredTierLabel || null),
  };
}

/**
 * Motorun kullandığı CANLI kapı: her çağrıda anlık görüntüyü yeniden okur.
 *
 * Neden canlı (yalnız kuruluşta değil): kullanıcı oturum ortasında yükseltirse
 * senkron uygulamayı yeniden başlatmadan açılır, düşürürse aynı turda kapanır.
 * Kuruluşta bir kez ölçseydik "Pro'yken açtım, Basic'e düştüm" hâlinde senkron
 * kapanana kadar buluta yazmaya devam ederdi — satmadığımız şeyi vermek.
 *
 * @param {Function} getPlanSnapshot - () => seatGate.state() | null
 * @returns {{check:Function, snapshot:Function}}
 */
function createSyncPlanGate(getPlanSnapshot) {
  if (typeof getPlanSnapshot !== 'function') {
    throw new Error('syncPlanGate: getPlanSnapshot zorunlu (DI)');
  }
  /**
   * Anlık görüntü okunamazsa (seatGate henüz yok, çağrı patladı) KİLİTLEME:
   * `null` snapshot = zorlama yok (KURAL 3). Bir okuma arızası ödeyen kullanıcının
   * senkronunu durdurmaz (ADR-027 fail-open duruşu).
   */
  function read() {
    try { return getPlanSnapshot(); } catch { return null; }
  }
  return {
    /** @returns {object} evaluate() çıktısı */
    check: () => evaluate(read()),
    snapshot: read,
  };
}

module.exports = { evaluate, createSyncPlanGate, FEATURE, DEVICE_FEATURE };
