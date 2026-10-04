// CrewPane — ADP-660: PLAN LİMİTİ KARARI (Basic ⇄ Pro/Ultra) — TEK GERÇEK KAYNAK.
//
// ─────────────────────────────────────────────────────────────────────────────
// NEDEN AYRI BİR KARAR KATMANI
// ─────────────────────────────────────────────────────────────────────────────
// ADP-614 kataloğu yazdı (`caps`), ADP-646 KAPIYI bağladı ("paketin var mı?").
// Arada eksik olan halka: **paketin VAR ama HANGİ paket?** Basic satın alan bir
// kullanıcı bugüne kadar Ultra'nın her şeyini kullanıyordu — katalog "6 eşzamanlı
// ajan" diyordu, kimse okumuyordu.
//
// İKİ KARAR AYRI TUTULUR (ve karışması yasaktır):
//   • seatGate.decideAccess → ERİŞİM: "içeri girebilir mi?" (yoksa TAM EKRAN kapı)
//   • planLimits.decide     → MİKTAR: "bu eylem paketinin içinde mi?" (yoksa NUDGE)
// Bir limit ASLA uygulamayı kilitlemez: kullanıcı çalışmaya devam eder, yalnız o
// eylem reddedilir ve yükseltme yolu gösterilir.
//
// ─────────────────────────────────────────────────────────────────────────────
// ÜÇ SERT KURAL
// ─────────────────────────────────────────────────────────────────────────────
// 1. **İSİM KONTROLÜ YOK.** Hiçbir yerde `if (tier === 'pro')` yoktur. Limit de,
//    "hangi paket açar" da katalog VERİSİNDEN (planCatalog.TIERS + rank) türer.
//    Yeni katman = planCatalog'a bir satır; bu dosya değişmez.
// 2. **BİLİNMEYEN KATMAN = BASIC, KİLİT DEĞİL.** Jeton bozuk/eksik/tanınmayan bir
//    ürün taşıyorsa kullanıcı KİLİTLENMEZ — en dar ücretli katmanın (Basic)
//    haklarıyla çalışmaya devam eder. Yanlış pozitif (ödeyeni kilitlemek) bu üründe
//    en pahalı hatadır (ADR-027 / ADP-646 duruşu); "tanıyamadım → hiçbir şey yok"
//    demek tam da o hatadır.
// 3. **KAPI KAPALIYSA LİMİT DE YOK.** `requireSeat !== true` (geliştirici kopyası,
//    e2e, kaynak koşumu) → hiçbir limit uygulanmaz. Lisans kapısıyla AYNI şalter;
//    ikinci bir "acaba zorlansın mı" politikası üretmek iki gerçek yaratırdı.
//
// Saf veri + saf fonksiyon (tek require: planCatalog) → `node --test` doğrudan
// koşar, Electron'a bağlı değildir ([[leaf-module-node-test]]).

'use strict';

const planCatalog = require('./planCatalog.cjs');

/** Katman çözülemediğinde düşülecek taban — KİLİT değil, en dar ücretli katman. */
const FALLBACK_TIER_ID = 'basic';

/**
 * Zorlanan yetenekler. `cap` = planCatalog caps alanı; `kind`:
 *   'count' → BİRİKMİŞ kullanım tavanı (null = sınırsız): `current < limit` ise
 *             izinli — "elimde N tane var, bir tane daha ekleyeyim mi?"
 *   'max'   → TALEP EDİLEN MİKTAR tavanı: `current <= limit` ise izinli — burada
 *             `current` birikmiş kullanım değil, tek seferde İSTENEN sayıdır
 *             ("bu dalgada 5 worker koştur"). BL-01'de eklendi: 'count' ile
 *             ölçmek 3 worker isteyen bir kullanıcıyı 3 tavanında reddederdi.
 *   'flag'  → açık/kapalı yetenek (true ise izinli)
 * `text(ctx)` kullanıcı cümlesini üretir — METİN BURADA, renderer'da DEĞİL
 * (seatGate.decideAccess ile aynı disiplin: main'in reddettiği durumla ekranın
 * gösterdiği cümle yapısal olarak ayrışamaz).
 *
 * SEC-02 — `selfServe` (opsiyonel): reddin YÜKSELTMEDEN ÇÖZÜLEBİLDİĞİ hâller için
 * ikinci eylem. `{ id, label }` VERİDİR: renderer bu kimliği bir eyleme bağlar,
 * kendi cümlesini kurmaz ve `feature === '...'` karşılaştırması YAPMAZ. Böylece
 * BL-03'ün tek kanalı (`plan:limit`) korunur — ret hâlâ tek yerden geçer, yalnız
 * artık iki tıklanabilir çıkışı olabilir ("bırak" + "yükselt").
 */
const FEATURES = Object.freeze({
  agents: Object.freeze({
    id: 'agents',
    cap: 'concurrentAgents',
    kind: 'count',
    title: 'Eşzamanlı ajan sınırına ulaştın',
    text: (c) =>
      `${c.tierLabel} paketinde aynı anda en fazla ${c.limit} ajan çalıştırabilirsin `
      + `(şu an ${c.current}). Çalışan bir ajanı kapatıp tekrar dene — ya da `
      + `${c.requiredTierLabel} paketine geç: orada eşzamanlı ajan sınırı yok.`,
    // PLAN-FIX-01 (F-4) — RESTORE BAĞLAMININ KENDİ CÜMLESİ.
    // Varsayılan metin "çalışan bir ajanı kapatıp tekrar dene" der; açılış/kurtarma
    // restore'unda kapatılacak bir şey YOKTUR (pane'ler daha hiç açılmadı) — o cümle
    // orada yalan olurdu. İkinci bir FEATURES satırı da açılmaz (BL-02: her cap ya
    // zorlanır ya bilgi; ikiz satır ikinci gerçek demektir): aynı yeteneğin BAĞLAM
    // VARYANTI. `c.pending` = plan tavanı yüzünden açılmayan pane sayısı.
    texts: Object.freeze({
      restore: (c) =>
        `${c.tierLabel} paketinde aynı anda ${c.limit} ajan çalışır; önceki oturumdan `
        + `${c.pending} pane geri getirilmedi. Kayıtları duruyor — bir ajanı kapatınca `
        + `elle açabilirsin ya da ${c.requiredTierLabel} paketine geç.`,
    }),
  }),
  integrations: Object.freeze({
    id: 'integrations',
    cap: 'integrations',
    kind: 'count',
    title: 'Entegrasyon sınırına ulaştın',
    text: (c) =>
      `${c.tierLabel} paketinde en fazla ${c.limit} entegrasyon bağlayabilirsin `
      + `(şu an ${c.current}). Bağlı entegrasyonların çalışmaya devam eder; yenisini `
      + `eklemek için birini kaldır ya da ${c.requiredTierLabel} paketine geç.`,
  }),
  // BL-01 — ÇALIŞMA ALANI tavanı. Ölçüm birimi: kullanıcının BİLDİĞİ kök sayısı
  // (aktif kök + daha önce açtıkları). Karar YALNIZ yeni bir kök benimsemede
  // sorulur; bilinen bir köke geçiş limite hiç girmez → "mevcut alanlar çalışmaya
  // devam eder" sözleşmesi entegrasyonlarla birebir aynı (`integ:add` deseni).
  workspaces: Object.freeze({
    id: 'workspaces',
    cap: 'workspaces',
    kind: 'count',
    title: 'Çalışma alanı sınırına ulaştın',
    text: (c) =>
      `${c.tierLabel} paketinde en fazla ${c.limit} çalışma alanı kullanabilirsin `
      + `(şu an ${c.current}). Mevcut çalışma alanın açık kalır ve içindeki hiçbir şey `
      + `kaybolmaz; başka bir klasörü de çalışma alanı yapmak için ${c.requiredTierLabel} `
      + `paketine geç.`,
  }),
  // BL-01 — DELEGASYON DALGASI tavanı: tek dalgada aynı anda koşan worker sayısı.
  // 'max' türü (talep edilen miktar): Basic 3, Pro/Ultra 12 —
  // electron/spawnSpec.cjs SPAWN_APPROVAL_FREE_MAX ile aynı sayı, çünkü onay-kartsız
  // açılabilen pane sayısı ile ücretli dalga tavanı iki ayrı gerçek olamaz.
  delegateWave: Object.freeze({
    id: 'delegateWave',
    cap: 'delegateWaveMax',
    kind: 'max',
    title: 'Dalga sınırına ulaşıldı — daha az worker ile devam',
    text: (c) =>
      `${c.tierLabel} paketinde bir delegasyon dalgasında en fazla ${c.limit} worker `
      + `aynı anda çalışır (${c.current} istendi). Sprint DURMADI: dalga ${c.limit} `
      + `worker'a düşürüldü, kalan görevler sıradaki dalgalarda koşacak. Daha geniş `
      + `dalga için ${c.requiredTierLabel} paketine geç.`,
  }),
  // BL-02 — MOBİL UZAKTAN KONTROL. Tek boğaz `startMobile()` (main.js): hem açılışta
  // deftere bakıp kendiliğinden kalkan yol hem `mobile:enable` oradan geçer, yani
  // "Pro'yken açtım, Basic'e düştüm" hâlinde gateway bir sonraki açılışta da KALKMAZ.
  // Reddin ELİNDEN ALDIĞI şey yalnız UZAKTAN ERİŞİMDİR: eşleşmiş cihaz defteri,
  // yüklemeler ve ayarlar diskte DURUR — yükseltince aynı cihazlar geri gelir
  // (entegrasyon deseninin aynısı: "bağlı olanlar koparılmaz").
  mobileRemote: Object.freeze({
    id: 'mobileRemote',
    cap: 'mobileRemote',
    kind: 'flag',
    title: 'Mobil uzaktan kontrol Pro özelliği',
    text: (c) =>
      `Telefondan ofisini görmek ve ajanlarına iş vermek ${c.requiredTierLabel} paketinde. `
      + `${c.tierLabel} paketinde masaüstü uygulaman tam kapasite çalışır; eşleşmiş `
      + `cihazların ve ayarların da silinmez — ${c.requiredTierLabel} paketine geçtiğin an `
      + `mobil erişim kaldığı yerden açılır.`,
  }),
  // TIER-DESIGN-01 — TASARIM TURU. Eren'in 23.08 kararı: tasarım özelliği yalnız
  // Pro + Ultra. `mobileRemote` deseninin birebir kardeşi ('flag' + tek boğaz):
  // boğaz `openDesignWindow()` (electron/main.js) — tasarım yüzeyinin İŞLEVSEL
  // olduğu tek yer o penceredir, dolayısıyla sekme tıklaması, pane düğmesi ve
  // doğrudan `designApi.openWindow()` çağrısı ÜÇÜ DE oradan geçer.
  //
  // Reddin ELİNDEN ALDIĞI şey yalnız TURUN KENDİSİDİR: `docs/design/` altındaki
  // artboard'lar, sürümler, notlar ve kuyruk diskte DURUR — yükseltince tur
  // kaldığı yerden açılır (entegrasyon/mobil deseninin aynısı: "var olan
  // koparılmaz"). Metin bunu söylemek ZORUNDA, yoksa kullanıcı reddi "işim silindi"
  // diye okur.
  designMode: Object.freeze({
    id: 'designMode',
    cap: 'designMode',
    kind: 'flag',
    title: 'Tasarım Turu Pro özelliği',
    text: (c) =>
      `Tasarım Turu ${c.requiredTierLabel} paketinde: önce çiz, görselde iterate et, `
      + `onayla — sonra kodlansın. ${c.tierLabel} paketinde ajanlarına doğrudan iş `
      + `vermeye devam edersin; çizdiğin artboard'lar, sürümler ve notlar da silinmez `
      + `— ${c.requiredTierLabel} paketine geçtiğin an tur kaldığı yerden açılır.`,
  }),
  // TIER-SYNC-01 — BULUT SENKRON (Basic KAPALI · Pro/Ultra AÇIK). `designMode`/
  // `mobileRemote` üçlüsünün kardeşi ('flag' + TEK BOĞAZ); boğaz burada motorun
  // KENDİ giriş noktasıdır (`electron/sync/syncPlanGate.cjs` → `syncEngine`in ağa
  // dokunan her yöntemi). Kapıyı main.js'e koymadık: motor F1-6'da bağlanacak ve
  // "kapıyı bağlamayı unutmak" ile "özelliği bağlamayı unutmak" aynı hata olmalı —
  // bu yüzden plan kanalı motorun ZORUNLU bağımlılığıdır (DI), opsiyonel değil.
  //
  // BASIC'TE KAPALI OLMASININ GEREKÇESİ BİR FİYAT KARARI DEĞİL, TANIM: Basic
  // `devicesConcurrent:1`dir — senkronun eşitleyeceği ikinci bir uç yoktur.
  // Metin bunu SÖYLER, çünkü sebebini söylemeyen bir ret keyfî okunur.
  //
  // ULTRA AVANTAJI: yeni sayı İCAT EDİLMEDİ — mevcut `devicesConcurrent` kadranı
  // (1/2/4) senkron kapsamına bağlandı. Cümledeki sayılar KATALOGDAN okunur
  // (`limitFor`), en üst katman da rank taramasıyla bulunur: burada `'ultra'` gibi
  // bir isim kontrolü YOKTUR (KURAL 1), yarın bir katman eklenirse cümle kendini
  // günceller.
  //
  // Reddin ELİNDEN ALDIĞI şey yalnız BULUTA TAŞIMAKTIR: hafıza/beceri/tercih
  // dosyaları diskte olduğu gibi DURUR, hiçbir şey silinmez ve yükseltince ilk tur
  // (bootstrap) onları buluta taşır. Metin bunu açıkça söylemek ZORUNDA — veri
  // kaybı korkusu iade sebebidir (mobileRemote/designMode sözleşmesinin aynısı).
  cloudSync: Object.freeze({
    id: 'cloudSync',
    cap: 'cloudSync',
    kind: 'flag',
    title: 'Bulut senkron Pro özelliği',
    text: (c) => {
      const top = tiersByRank().slice(-1)[0];
      const mine = limitFor(c.tier, 'devicesConcurrent');
      return `Hafızanın, becerilerinin ve tercihlerinin cihazların arasında `
        + `senkronlanması ${c.requiredTierLabel} paketinde. ${c.tierLabel} paketinde `
        + `hesabın aynı anda ${mine} cihazda çalışır — senkronlanacak ikinci bir uç yok. `
        + `Dosyaların bu bilgisayarda duruyor, hiçbir şey silinmez ve yükseltirsen ilk `
        + `turda oldukları gibi buluta taşınır. ${top.label} paketinde aynı hesap aynı `
        + `anda ${top.caps.devicesConcurrent} cihazda çalışır ve hepsi aynı hafızayı paylaşır.`;
    },
  }),
  // SEC-01 — CİHAZ TAVANI. Diğer yeteneklerden BİR YÖNÜYLE AYRILIR ve bu ayrım
  // bilinçlidir: KARAR BURADA VERİLMEZ. Reddi SUNUCU verir (`license-token`,
  // jetonu imzalamadan önce); bu satır o reddin KULLANICI CÜMLESİNİ üretir.
  //
  // Neden yine de burada: BL-02'nin kuralı "her cap ya zorlanır ya bilgi diye
  // ilan edilir" idi. Cihaz tavanı ZORLANIYOR — yalnız zorlayan taraf sunucu.
  // Cümleyi de sunucuda yazsaydık iki gerçek olurdu: sunucunun TR metni ile
  // uygulamanın nudge dili ayrışır, "üst pakete geç" düğmesi hedefsiz kalırdı.
  // Bu yüzden ret VERİ olarak gelir (limit/current), cümle burada kurulur —
  // seatGate.refreshLicense sunucunun `device_limit_reached` gövdesini bu
  // yeteneğe çevirir (`current` = sunucunun bildirdiği AÇIK cihaz sayısı).
  //
  // `describe()` içinde `current` bilinmiyorsa 0 görünür (cihaz listesi ağdan
  // gelir); Ayarlar → Hesap gerçek sayıyı listeyle birlikte gösterir.
  devices: Object.freeze({
    id: 'devices',
    cap: 'devicesRegistered',
    kind: 'count',
    title: 'Bu hesap başka cihazlarda kayıtlı',
    text: (c) =>
      `${c.tierLabel} paketinde aynı hesabı en fazla ${c.limit} cihaza kurabilirsin `
      + `(şu an ${c.current} cihaz kayıtlı). Bu cihazda çalışmaya devam etmek için `
      + `Ayarlar → Hesap'tan kullanmadığın bir cihazı çıkar — çıkardığın cihazdaki `
      + `hiçbir şey silinmez — ya da ${c.requiredTierLabel} paketine geç.`,
  }),
  // SEC-02 — İKİNCİ KADRAN: AYNI ANDA AKTİF. `devices` ile aynı sınıf ama AYRI
  // bir yetenek olması ŞART, çünkü ÇÖZÜMÜ farklıdır:
  //   • `devices` (kayıt) aşıldı  → bir cihazı hesaptan ÇIKAR (kalıcı karar)
  //   • bu (eşzamanlı) aşıldı     → diğer cihazları BIRAK (anlık, geri alınabilir)
  // Tek yetenekte birleştirseydik kullanıcıya yanlış çözümü söylerdik: makinesini
  // hesabından silmek, aslında yalnız koltuğu bırakması gereken bir durumda.
  //
  // Cümle üç şeyi birden taşır ve üçü de ölçülmüş bir korkuyu karşılar:
  //   1. "kaç cihazda aktif" — kullanıcı neyle karşılaştığını bilsin
  //   2. "kendiliğinden serbest kalır" — uyuyan/çöken makine yüzünden SONSUZA
  //      kilitlendiğini sanmasın (yanlış pozitif korkusu)
  //   3. iki çıkış yolu — bırak / yükselt
  devicesConcurrent: Object.freeze({
    id: 'devicesConcurrent',
    cap: 'devicesConcurrent',
    kind: 'count',
    // İKİNCİ EYLEM — yükseltmeden çözülebilen tek cihaz reddi budur.
    selfServe: Object.freeze({ id: 'releaseOtherDevices', label: 'Diğer cihazları bırak' }),
    title: 'Bu hesap şu an başka cihazda aktif',
    text: (c) =>
      `${c.tierLabel} paketinde aynı hesabı aynı anda en fazla ${c.limit} cihazda `
      + `kullanabilirsin (şu an ${c.current} cihaz aktif). Diğer cihazları bırakabilirsin `
      + `— oradaki hiçbir şey silinmez ve o cihaz hesabında kayıtlı kalır — ya da `
      + `${c.requiredTierLabel} paketine geç. Kullanılmayan cihazlar zaten kısa süre `
      + `içinde kendiliğinden serbest kalır.`,
  }),
  autopilot: Object.freeze({
    id: 'autopilot',
    cap: 'autopilotChains',
    kind: 'flag',
    title: 'Gözetimsiz devam Pro özelliği',
    text: (c) =>
      `Alt-görev bitince sıradakini kendiliğinden başlatma (gözetimsiz devam) `
      + `${c.requiredTierLabel} paketinde. ${c.tierLabel} paketinde iş kaybolmaz: `
      + `biten görev sana bildirilir, sırayı sen başlatırsın.`,
  }),
});

/** Katmanlar rank sırasında (basic → ultra). Karar hep bu sıradan türer. */
function tiersByRank() {
  return Object.values(planCatalog.TIERS).slice().sort((a, b) => a.rank - b.rank);
}

/** Yetenek tanımı ya da null (bilinmeyen ad = zorlama YOK, sessiz izin değil hata değil). */
function featureFor(featureId) {
  return FEATURES[String(featureId || '')] || null;
}

/** Katmanın bu yetenek için tavanı: sayı | null(sınırsız) | boolean. */
function limitFor(tierId, featureId) {
  const feature = featureFor(featureId);
  if (!feature) return null;
  const caps = planCatalog.capsFor(tierId);
  if (!caps) return null;
  return caps[feature.cap];
}

/** Tavan verilen değere izin veriyor mu (saf; kind'e göre). */
function capAllows(feature, limit, current) {
  if (feature.kind === 'flag') return limit === true;
  if (limit === null || limit === undefined) return true; // sınırsız
  // 'max' → `current` TALEP edilen miktardır: tavana EŞİT talep izinlidir.
  // 'count' → `current` birikmiş kullanımdır: bir tane daha eklemek için altında olmalı.
  if (feature.kind === 'max') return Number(current) <= Number(limit);
  return Number(current) < Number(limit);
}

/**
 * KURAL 2 — katmanı çöz, çözülemiyorsa BASIC'e düş (asla null/kilit döndürme).
 * @param {{tier?:string|null}|null} snapshot - seatGate anlık görüntüsü
 * @returns {string} 'basic' | 'pro' | 'ultra'
 */
function effectiveTierId(snapshot) {
  const raw = snapshot && typeof snapshot.tier === 'string' ? snapshot.tier : '';
  return planCatalog.tier(raw) ? raw : FALLBACK_TIER_ID;
}

/** Katman etiketi (kullanıcı cümlesinde geçer) — katalogdan, elle yazılmaz. */
function tierLabel(tierId) {
  const t = planCatalog.tier(tierId);
  return t ? t.label : tierId;
}

/**
 * KURAL 1 — bu yeteneği açan EN DÜŞÜK katman (isimle değil, rank taramasıyla).
 * @returns {{id:string,label:string}|null}
 */
function requiredTierFor(featureId, current) {
  const feature = featureFor(featureId);
  if (!feature) return null;
  for (const t of tiersByRank()) {
    if (capAllows(feature, t.caps[feature.cap], current)) return { id: t.id, label: t.label };
  }
  return null;
}

/**
 * ZORLAMA KARARI. Reddedilen her eylemin metni + yükseltme hedefi buradan çıkar.
 *
 * @param {object} args
 * @param {object|null} args.snapshot - seatGate.state() (requireSeat + tier taşır)
 * @param {string} args.feature       - FEATURES anahtarı
 * @param {number} [args.current=0]   - şu anki kullanım (count türü için)
 * @returns {{allowed:true}|{allowed:false, reason:'plan_limit', feature:string,
 *   tier:string, tierLabel:string, limit:number|boolean|null, current:number,
 *   requiredTier:string|null, requiredTierLabel:string|null, title:string,
 *   message:string, action:'upgrade'}}
 */
function decide({ snapshot, feature: featureId, current = 0, variant = null, context = null }) {
  const feature = featureFor(featureId);
  if (!feature) return { allowed: true }; // bilinmeyen yetenek adı kimseyi engellemez
  // KURAL 3 — lisans kapısı kapalıysa (geliştirici kopyası/e2e) limit de yok.
  if (!snapshot || snapshot.requireSeat !== true) return { allowed: true };

  const tierId = effectiveTierId(snapshot);
  const limit = limitFor(tierId, featureId);
  const used = Number.isFinite(Number(current)) ? Number(current) : 0;
  if (capAllows(feature, limit, used)) return { allowed: true };

  const required = requiredTierFor(featureId, used);
  const ctx = {
    // PLAN-FIX-01 (F-4) — çağıranın taşıdığı EK metin bağlamı (ör. restore'da `pending`).
    // ÖNCE yazılır: kanonik alanlar (tavan, katman etiketi) bir bağlam anahtarıyla
    // EZİLEMEZ, yoksa cümle ile düğme ayrışırdı (BL-03 nöbetinin koruduğu şey).
    ...(context && typeof context === 'object' ? context : {}),
    tier: tierId,
    tierLabel: tierLabel(tierId),
    limit,
    current: used,
    requiredTierLabel: required ? required.label : 'üst',
  };
  // PLAN-FIX-01 (F-4) — BAĞLAM VARYANTI. Aynı ret, farklı ÇIKIŞ YOLU olan bir
  // bağlamda başka bir cümleyle anlatılır. Varyant BİLİNMİYORSA sessizce varsayılan
  // metne düşer: yeni bir çağrı yeri yanlış bir ad yazarsa kullanıcı cümlesiz kalmaz.
  const textFn = (variant && feature.texts && typeof feature.texts[variant] === 'function')
    ? feature.texts[variant]
    : feature.text;
  return {
    allowed: false,
    reason: 'plan_limit',
    feature: feature.id,
    tier: tierId,
    tierLabel: ctx.tierLabel,
    limit,
    current: used,
    requiredTier: required ? required.id : null,
    requiredTierLabel: required ? required.label : null,
    title: feature.title,
    message: textFn(ctx),
    action: 'upgrade',
    // SEC-02 — varsa İKİNCİ çıkış (yükseltmeden çözüm). `null` = tek yol var.
    selfServe: feature.selfServe ? { ...feature.selfServe } : null,
  };
}

/**
 * BL-01 — 'max' türü yetenekler için KISITLA-ve-SÖYLE. Bir dalga tavanı işi
 * reddetmek için değil DARALTMAK için vardır: sprint durursa müşteri işini
 * kaybeder, oysa ürün vaadi "daha az worker, aynı iş". Karar yine `decide`ın
 * kendisidir (ikinci bir politika yok); burada yalnız izinli değere kırpılır.
 *
 * @param {object} args
 * @param {object|null} args.snapshot
 * @param {string} args.feature   - 'max' türü FEATURES anahtarı
 * @param {number} args.requested - kullanıcının/liderin istediği miktar
 * @returns {{value:number, clamped:boolean, denial:object|null}}
 */
function clamp({ snapshot, feature: featureId, requested }) {
  const asked = Number.isFinite(Number(requested)) ? Number(requested) : 0;
  const decision = decide({ snapshot, feature: featureId, current: asked });
  if (decision.allowed) return { value: asked, clamped: false, denial: null };
  // Reddeden karar tavanı taşır; 'max' türünde tavan HER ZAMAN sayıdır.
  const limit = Number(decision.limit);
  const value = Number.isFinite(limit) && limit > 0 ? Math.min(asked, limit) : asked;
  return { value, clamped: value !== asked, denial: decision };
}

/**
 * Renderer'ın (Ayarlar/nudge) okuyacağı özet: hangi katmandayız, ne zorlanıyor,
 * her yetenekte tavan ve mevcut kullanım. Karar ÜRETMEZ — `decide` tek karar yeri.
 * @param {object|null} snapshot
 * @param {Record<string, number>} [counts] - {agents: n, integrations: n}
 */
function describe(snapshot, counts = {}) {
  const enforced = !!(snapshot && snapshot.requireSeat === true);
  const tierId = effectiveTierId(snapshot);
  const features = {};
  for (const id of Object.keys(FEATURES)) {
    const current = Number(counts[id]) || 0;
    const decision = decide({ snapshot, feature: id, current });
    features[id] = {
      limit: limitFor(tierId, id),
      current,
      allowed: decision.allowed,
      // TIER-DESIGN-01 — KİLİDİ GÖSTERMEK İÇİN HEDEF KATMAN. Yüzey "🔒 Pro" diyebilmek
      // için katman adını bir yerden almak zorunda; ELİYLE yazarsa (ya da
      // `tier === 'basic'` diye sorarsa) ikinci bir gerçek doğar. Karar burada
      // ÜRETİLMEZ — `decide`ın ZATEN bulduğu hedef taşınır (izinliyse null).
      requiredTierLabel: decision.allowed ? null : (decision.requiredTierLabel || null),
    };
  }
  return {
    enforced,
    tier: tierId,
    tierLabel: tierLabel(tierId),
    // Katman çözülemediği için Basic'e düşüldü mü (teşhis: "jetonum var ama Basic görüyorum")
    fallback: !(snapshot && planCatalog.tier(snapshot.tier)),
    features,
  };
}

module.exports = {
  FEATURES,
  FALLBACK_TIER_ID,
  effectiveTierId,
  limitFor,
  requiredTierFor,
  decide,
  clamp,
  describe,
};
