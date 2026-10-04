// ADP-614 (P0 satış blokeri) — CrewPane KATMAN KATALOĞU: TEK GERÇEK KAYNAK.
//
// Kök neden (ADP-613 §8/B2): canlı Stripe `crewpane.basic|pro|ultra` satarken
// istemci yalnız `crewpane.seat` arıyordu → Pro/Ultra satın alan kullanıcının
// lisansı uygulamada GÖRÜNMÜYORDU. Kapı bugün kapalı olduğu için kimse
// engellenmiyor; kapıyı açtığımız gün ÖDEYEN müşteri kilitlenirdi.
//
// SÖZLEŞME (bu dosyanın var oluş sebebi):
//   * "Hangi entitlement ürünü CrewPane erişimi verir" sorusunun cevabı YALNIZ
//     burada yazar. seatGate/main/renderer buradan OKUR — kendi listesini tutmaz.
//   * Karar İSİM KONTROLÜYLE değil VERİDEN türer: hiçbir yerde
//     `if (product === 'crewpane.pro')` gibi bir zincir YOKTUR. Yeni katman
//     eklemek = bu dosyaya bir SATIR; çağrı yerleri değişmez.
//   * Eski model (`crewpane.seat`, ADP-531 öncesi $15/$129/$199 "CrewPane
//     koltuğu") ve yeni model (basic/pro/ultra) İKİSİ DE tanınır — eski alıcılar
//     kırılmaz. Eski koltuk CÖMERT tarafta Pro'ya eşlenir (avuç dolusu erken
//     alıcıyı düşürmemek ucuz; karar VERİDİR, kod değil).
//
// ADP-660 — `caps` ARTIK ZORLANIYOR. Bu dosya hâlâ yalnız VERİ tutar; kararı
//    `planLimits.cjs` verir, boğazları (pty:spawn / integ:add / supervisor
//    auto-advance) main.js bağlar. Yeni bir limit eklemek = buraya bir alan +
//    planLimits.FEATURES'a bir satır; çağrı yerleri değişmez.
//
// Saf veri + saf fonksiyon: hiçbir require YOK → `node --test` ile doğrudan
// koşulur, Electron'a bağlı değildir (leaf modül kuralı).

'use strict';

/**
 * Katmanlar — `rank` SIRALIDIR (basic < pro < ultra). Sıralama karşılaştırması
 * isimle değil rank'la yapılır; yeni bir ara katman eklemek rank vermekle biter.
 */
const TIERS = Object.freeze({
  basic: Object.freeze({
    id: 'basic',
    rank: 1,
    label: 'Basic',
    caps: Object.freeze({
      // BL-01 — SİTE OTORİTEDİR. Bu üç sayı crewpane-com/src/components/pricing/
      // plan-compare.tsx `compareSections` satırlarının BİREBİR karşılığıdır
      // (ajan 3 · çalışma alanı 1 · entegrasyon 2). Müşteri o tabloya bakarak
      // ödedi; uygulama ondan CÖMERT davranırsa satılan şey ile teslim edilen şey
      // ayrışır (BL-01'de ölçüldü: uygulama 6 ajan/2 alan veriyordu). Bu satırlar
      // değişecekse ÖNCE site değişir.
      concurrentAgents: 3,      // null = sınırsız
      workspaces: 1,
      integrations: 2,          // ADP-660 — bağlı hesap (Entegrasyon Merkezi) tavanı
      delegateWaveMax: 3,
      autopilotChains: false,
      // BL-02 — MOBİL UZAKTAN KONTROL. Artık ZORLANIYOR: tek boğaz `startMobile()`
      // (hem açılıştaki otomatik kalkış hem `mobile:enable` oradan geçer).
      // Tasarım otoritesi: docs/design/PRICING-PSYCHOLOGY.html §6 — "Somut,
      // demo-edilebilir, altyapısı hazır; tek boğazdan (mobile:enable) zorlanır."
      mobileRemote: false,
      // TIER-DESIGN-01 — TASARIM TURU. Eren'in 23.08 kararı: "tasarım özelliği
      // sadece Pro ve Ultra pakette olacak". ZORLANIR — tek boğaz
      // `openDesignWindow()` (electron/main.js): tasarım yüzeyinin İŞLEVSEL
      // olduğu tek yer o penceredir (bar + tuval + host yapıştırması ve
      // `design:*` IPC'leri yalnız oradan hayat bulur), dolayısıyla sekme
      // tıklaması / pane düğmesi / doğrudan köprü çağrısı ÜÇÜ DE aynı kapıdan
      // geçer. Cap ile zorlama AYNI commit'te geldi (BL-02 dekoratif cap yasağı).
      designMode: false,
      // TIER-SYNC-01 — BULUT SENKRON. Bu bayrak BL-02'de silinmişti ("özellik ürünün
      // içinde YOK, cap durması yalan"); BL-02'nin kendi hükmü onu geri getirme
      // koşulunu da yazmıştı: *"Özellik geldiği gün BU alan + planLimits.FEATURES
      // satırı BİRLİKTE eklenir."* SYNC-F1-3 motoru (electron/sync/) o günü getirdi,
      // satır da zorlamasıyla AYNI commit'te döndü.
      //
      // Basic'te KAPALI olmasının gerekçesi bir fiyat kararı değil, bir TANIM:
      // Basic `devicesConcurrent:1`dir — aynı anda tek kurulum canlıdır, senkronun
      // eşitleyeceği ikinci bir uç YOKTUR. Satmadığımız bir şeyi vermemek dürüst,
      // ama daha önemlisi: açık bırakılsaydı kullanıcı hiç gelmeyecek bir faydanın
      // ağ trafiğini ve çakışma riskini üstlenirdi.
      //
      // Ultra AVANTAJI yeni bir sayı DEĞİL: aşağıdaki `devicesConcurrent` kadranı
      // (1 / 2 / 4) senkron kapsamına bağlandı — "aynı hesap aynı anda kaç cihazda
      // aynı hafızayı paylaşır" sorusunun cevabı odur (planLimits.FEATURES.cloudSync
      // metni o kadranı OKUR, elle yazmaz).
      cloudSync: false,
      // SEC-01/02 — CİHAZ POLİTİKASI, İKİ KADRAN. Bu iki alan AYNADIR: kararı
      // SUNUCU verir (crewpane-id `_shared/plan-caps.ts` → `license-token` jetonu
      // imzalamadan önce reddeder). Buradaki sayılar kullanıcıya gösterilen
      // cümleyi üretir (planLimits.FEATURES.devices*); erişim kararı ASLA buradan
      // türemez — cihaz tavanı kullanıcının kendi kaynağını değil ABONELİĞİ korur,
      // otoritesi saldırganın yamalayabildiği istemcide duramaz.
      //
      // SEC-02 — NEDEN İKİ SAYI: tek rakam iki işi birden yapamaz. Dürüst kullanıcı
      // TEK kişidir ama 2-3 makinesi vardır (sırayla kullanır); paylaşan hesap 5
      // KİŞİdir (aynı anda çalışır). Cihaz sayısını kısmak birinciyi cezalandırır,
      // ikinciyi durdurmaz. Bu yüzden envanter (`devicesRegistered`) cömert,
      // eşzamanlılık (`devicesConcurrent`) dardır.
      // Drift guard: planCatalog.test.cjs sunucudaki sayılarla karşılaştırır.
      devicesRegistered: 2,     // hesabın tanıdığı kurulum sayısı
      devicesConcurrent: 1,     // aynı anda kirası canlı olabilecek kurulum
      supportChannel: 'email',  // BİLGİ — INFO_CAPS, zorlanmaz (aşağıya bak)
      teamSeats: 1,             // BİLGİ — INFO_CAPS, zorlanmaz (aşağıya bak)
    }),
  }),
  pro: Object.freeze({
    id: 'pro',
    rank: 2,
    label: 'Pro',
    caps: Object.freeze({
      concurrentAgents: null,
      workspaces: null,
      integrations: null,
      delegateWaveMax: 12,      // electron/spawnSpec.cjs SPAWN_APPROVAL_FREE_MAX ile aynı
      autopilotChains: true,
      mobileRemote: true,
      designMode: true,      // TIER-DESIGN-01 — tasarım turu Pro'dan itibaren açık
      cloudSync: true,       // TIER-SYNC-01 — senkron Pro'dan itibaren açık (2 eşzamanlı cihaz)
      devicesRegistered: 4,     // SEC-02 — ayna (otorite: sunucu plan-caps.ts)
      devicesConcurrent: 2,     // SEC-02 — ayna
      supportChannel: 'priority',
      teamSeats: 1,
    }),
  }),
  ultra: Object.freeze({
    id: 'ultra',
    rank: 3,
    label: 'Ultra',
    caps: Object.freeze({
      concurrentAgents: null,
      workspaces: null,
      integrations: null,
      delegateWaveMax: 12,
      autopilotChains: true,
      mobileRemote: true,
      designMode: true,      // TIER-DESIGN-01 — tasarım turu Pro'dan itibaren açık
      cloudSync: true,       // TIER-SYNC-01 — senkron açık; AVANTAJ aşağıdaki kadranda
      // Ultra'nın 4 eşzamanlı cihazı bir kısıt değil SATIŞ ARGÜMANIDIR:
      // "her cihazında, aynı anda". Takım koltuğu ürün olunca (ADP-621) bu satır
      // koltuk sayısından türer.
      devicesRegistered: 10,    // SEC-02 — ayna (otorite: sunucu plan-caps.ts)
      devicesConcurrent: 4,     // SEC-02 — ayna
      supportChannel: 'founder',
      teamSeats: 1,             // takım koltuğu henüz ürün değil (ADP-621)
    }),
  }),
});

/**
 * BL-02 — **DEKORATİF CAP YASAĞI.** Bir `caps` alanı ya ZORLANIR (planLimits.FEATURES'ta
 * karşılığı vardır) ya da BURADA bilgi olarak ilan edilir. Üçüncü bir hâl — "katalogda
 * yazıyor ama kimse sormuyor" — yasaktır ve `planCatalog.test.cjs` onu kırar.
 *
 * NEDEN: BL-02'de üç bayrak (`cloudSync`, `mobileRemote`, `vipCommunity`) hiçbir yerden
 * sorulmuyordu. Zararı sessiz değil: sonraki okuyan "Basic'te bu kapalı" sanır, ürün
 * kararını ona göre verir. Yanlış güven, eksik bilgiden pahalıdır.
 *
 * İki alan bilgi olarak KALIR (ikisinin de uygulamada bir ucu YOK):
 *   • `supportChannel` — destek KANALI bir söz; uygulamada tıklanacak bir uç değil.
 *     Ayarlar/Hesap yarın bunu etiket olarak gösterebilir (satır sitede var).
 *   • `teamSeats`      — takım koltuğu HENÜZ ÜRÜN DEĞİL (ADP-621); üçü de 1.
 *
 * Kaldırılan ikisi (BL-02 hükmü, gerekçesi raporda):
 *   • `cloudSync`    — **TIER-SYNC-01'de GERİ GELDİ, koşulu yerine gelerek.** BL-02'nin
 *     şartı "özellik geldiği gün BU alan + planLimits.FEATURES satırı BİRLİKTE eklenir"
 *     idi: SYNC-F1-3 motoru (electron/sync/) yazıldı, cap ile zorlama AYNI commit'te
 *     kondu, boğaz motorun kendi giriş noktasıdır (syncEngine + syncPlanGate).
 *   • `vipCommunity` — VIP topluluk uygulamanın DIŞINDA teslim edilir (davet/kanal).
 *     Uygulamada zorlanacak bir uç asla olmayacağı için cap olarak durması yalan.
 *     Satış sözü sitede (plan-compare `support.vip`) DURUYOR — kaldırılan yalnız
 *     "istemci bunu zorluyor" izlenimi.
 */
const INFO_CAPS = Object.freeze(['supportChannel', 'teamSeats']);

/**
 * CrewPane ERİŞİMİ VEREN entitlement ürünleri → katman.
 * Burada olmayan ürün (ör. `agentshot.pro`) CrewPane açmaz.
 */
const ACCESS_PRODUCTS = Object.freeze({
  'crewpane.basic': Object.freeze({ tier: 'basic', legacy: false }),
  'crewpane.pro': Object.freeze({ tier: 'pro', legacy: false }),
  'crewpane.ultra': Object.freeze({ tier: 'ultra', legacy: false }),
  // ESKİ MODEL — ADP-531 öncesinde tek CrewPane ürünü buydu.
  'crewpane.seat': Object.freeze({ tier: 'pro', legacy: true }),
});

/**
 * Paket → açtığı entitlement ürünleri. **AYNA (mirror)** — OTORİTE sunucudadır:
 * `crewpane-id/supabase/functions/_shared/product-bundles.ts` (webhook satırları
 * ORAYA göre yazar). Buradaki kopya istemcinin beklentisini ifade eder:
 * "Pro aldıysan jetonunda Shot+Voice de olmalı". İstemci erişim kararını asla
 * bu aynadan vermez — jetonda GERÇEKTEN ne varsa onu okur (drift güvenliği).
 */
const PRODUCT_BUNDLES = Object.freeze({
  'crewpane.suite': Object.freeze(['crewpane.seat', 'agentshot.pro', 'agentvoice.pro']),
  'crewpane.pro': Object.freeze(['crewpane.pro', 'agentshot.pro', 'agentvoice.pro']),
  'crewpane.ultra': Object.freeze(['crewpane.ultra', 'agentshot.pro', 'agentvoice.pro']),
});

/** Kullanıcı-görünür etiketler (Ayarlar → Hesap rozetleri). Tek yer — drift olmasın. */
const PRODUCT_LABELS = Object.freeze({
  'crewpane.basic': 'CrewPane Basic',
  'crewpane.pro': 'CrewPane Pro',
  'crewpane.ultra': 'CrewPane Ultra',
  'crewpane.seat': 'CrewPane koltuğu',
  'agentshot.pro': 'AgentShot Pro',
  'agentvoice.pro': 'AgentVoice Pro',
  'crewpane.suite': 'CrewPane Suite',
});

/** CrewPane erişimi veren ürün kimlikleri (seatGate bu listeyi DOLAŞIR). */
function accessProductIds() {
  return Object.keys(ACCESS_PRODUCTS);
}

/** Ürün CrewPane erişimi veriyor mu? (isim kontrolü değil, katalog üyeliği) */
function isAccessProduct(productId) {
  return Object.prototype.hasOwnProperty.call(ACCESS_PRODUCTS, String(productId || ''));
}

/** Ürünün katman kimliği ('basic'|'pro'|'ultra') ya da null. */
function tierIdForProduct(productId) {
  const entry = ACCESS_PRODUCTS[String(productId || '')];
  return entry ? entry.tier : null;
}

/** Katman tanımı (rank/label/caps) ya da null. */
function tier(tierId) {
  return TIERS[String(tierId || '')] || null;
}

/**
 * YETKİLİ ürün listesinden katmanı çöz: **en yüksek rank kazanır**.
 * (Kullanıcıda birden fazla CrewPane entitlement'ı olabilir — eski koltuk +
 * yeni Pro gibi; en genişini vermek hem doğru hem müşteri-dostu.)
 * @param {string[]} entitledProductIds - jetonda AKTİF/yetkili görülen ürünler
 * @returns {{id:string,rank:number,label:string,caps:object,products:string[]}|null}
 */
function resolveTier(entitledProductIds) {
  const list = Array.isArray(entitledProductIds) ? entitledProductIds : [];
  let best = null;
  const matched = [];
  for (const id of list) {
    const tierId = tierIdForProduct(id);
    if (!tierId) continue;
    matched.push(id);
    const candidate = TIERS[tierId];
    if (!best || candidate.rank > best.rank) best = candidate;
  }
  if (!best) return null;
  return { id: best.id, rank: best.rank, label: best.label, caps: best.caps, products: matched };
}

/** Katmanın yetenek iskeleti (ZORLAMA YOK — ADP-616 uygulayacak). */
function capsFor(tierId) {
  const t = tier(tierId);
  return t ? t.caps : null;
}

/** Etiket; bilinmeyen ürün kendi kimliğiyle gösterilir (asla boş kalmaz). */
function labelFor(productId) {
  const id = String(productId || '');
  return PRODUCT_LABELS[id] || id;
}

/** Renderer'a push edilen etiket haritası (kopya — çağıran mutasyona uğratamaz). */
function productLabels() {
  return { ...PRODUCT_LABELS };
}

/** Paketin açması BEKLENEN ürünler (ayna; otorite product-bundles.ts). */
function bundledProductsFor(productId) {
  const list = PRODUCT_BUNDLES[String(productId || '')];
  return list ? [...list] : [];
}

module.exports = {
  TIERS,
  INFO_CAPS,
  ACCESS_PRODUCTS,
  PRODUCT_BUNDLES,
  PRODUCT_LABELS,
  accessProductIds,
  isAccessProduct,
  tierIdForProduct,
  tier,
  resolveTier,
  capsFor,
  labelFor,
  productLabels,
  bundledProductsFor,
};
