// ADP-390 (ADR-027 / G9) — CrewPane ↔ CrewPane hesabı + seat entitlement'ı.
//
// ADP-614 (P0 satış blokeri) — CrewPane erişimi artık TEK KAYNAKTAN çözülür
// (planCatalog.cjs): eski `crewpane.seat` VE yeni `crewpane.basic|pro|ultra`
// birlikte tanınır, katman (basic<pro<ultra) snapshot'ta raporlanır.
//
// ⛔ ADP-646 (P0 GÜVENLİK) — "KAPI YAZILDI AMA ÇAĞRILMADI" DÖNEMİ BİTTİ.
// ADP-390'dan beri `requireSeat` hiçbir yerden çağrılmıyordu: giriş yapan HERKES
// ücretsiz TAM sürümü kullanıyordu. Artık kapı GERÇEKTEN çağrılır (electron/main.js:
// `pty:spawn` = tüm ajan çalıştırma yolunun tek boğazı, `appdb:token` = görev/DB
// kimliği, delegationBridge `/delegate` + `/app-db/token` = ajan yolu) ve müşteri
// build'inde varsayılan AÇIKTIR (crewpaneId.cjs + buildChannel.cjs).
//
// Bu modül:
//   * hesabı bağlar (PKCE, sistem tarayıcısı — @crewpane/auth, RFC 8252: webview YASAK),
//   * lisans jetonunu çeker/doğrular (OFFLINE, ES256 + 14g grace — ADP-383),
//   * seat durumunu RAPORLAR (Ayarlar satırı + tam-ekran kapı),
//   * kapılama yardımcısını (requireSeat) SAĞLAR.
//
// YANLIŞ POZİTİF = EN KÖTÜ SENARYO (Eren): ödeme yapmış bir kullanıcıyı kilitlemek,
// ödememiş birinin sızmasından daha pahalıdır. Bu yüzden:
//   * OFFLINE ≠ KİLİT: doğrulama tamamen yereldir (ES256 + 14 gün grace). Ağ yokken
//     ödemiş kullanıcı ÇALIŞMAYA DEVAM eder; jeton yenilenemezse cached jeton KORUNUR.
//   * `past_due` / `canceled(period_end'e kadar)` AÇIK sayılır (license.cjs semantiği).
//     PAY-1 (2026-09-05) düzeltmesi: `past_due` artık SÜRESİZ değil — damgalı satır
//     (`past_due_since`) `PAST_DUE_GRACE_SECONDS` sonra kapanır. Bu, yukarıdaki
//     yanlış-pozitif ilkesiyle çelişmez: ölçülemeyen/damgasız satır AÇIK kalır,
//     kapanan yalnız ödemesi 14 gündür düşük kalmış olandır (ödemenin YOKLUĞU
//     artık ölçülüyor, "gecikme" sonsuza kadar gecikme sayılmıyor).
//   * "jeton hiç alınamadı" (licenseStatus='none') ile "paketin yok" (seat=false)
//     AYRI reason'lardır — birincisi kullanıcıya "bağlantını kontrol et + tekrar dene"
//     der, ikincisi "paket gerekli" der. Aynı kefeye koymak yanlış suçlama olurdu.
//
// Saf DI: Electron'a doğrudan require-bağı yok (safeStorage/openExternal enjekte edilir)
// → node --test ile gerçek dosya sistemi + sahte safeStorage üstünde koşulabilir.

'use strict';

const path = require('node:path');
const { SEAT_PRODUCT } = require('../config/crewpaneId.cjs');
// ADP-614 — hangi entitlement ürünü CrewPane erişimi verir: TEK GERÇEK KAYNAK.
// Burada isim bazlı `if` YOKTUR; karar katalog VERİSİNDEN türer (yeni katman =
// planCatalog.cjs'te bir satır, bu dosya değişmez).
const planCatalog = require('../config/planCatalog.cjs');

/**
 * SEC-01/02 — sunucunun cihaz ret sınıfı → `planLimits.FEATURES` anahtarı.
 *
 * Bu haritanın kendisi SÖZLEŞMEDİR: sunucu HANGİ kadranın dolduğunu söyler,
 * istemci o kadranın cümlesini ve düğmesini kurar. Burada `if (reason === …)`
 * zinciri YOKTUR — yeni bir kadran eklemek buraya bir satırdır.
 */
const DEVICE_DENIALS = Object.freeze({
  device_limit_reached: 'devices',                    // KAYIT kadranı → "cihazı çıkar"
  device_concurrent_limit_reached: 'devicesConcurrent', // EŞZAMANLI kadranı → "bırak"
});

/**
 * ADP-646 — KAPI KARARI TEK FONKSİYONDA. Hem main'deki zorlama noktaları
 * (`pty:spawn`, bridge) hem de renderer'daki tam-ekran kapı AYNI kararı ve AYNI
 * metni kullanır: mesajlar renderer'da TEKRAR YAZILMAZ (iki dilde iki gerçek olmaz).
 *
 * `snapshot` → { allowed, reason, title, message, action } | { allowed:true }
 * action: 'sign_in' | 'buy' | 'retry' — renderer hangi butonu öne çıkaracağını bundan bilir.
 */
function decideAccess(s) {
  if (!s.requireSeat) return { allowed: true }; // kapı kapalı (geliştirici kopyası)
  // PAY-3 — ödeme gecikmesi ÖLÇÜLEBİLİYOR mu? (damgasız satır sayaç taşımaz)
  const pastDue = s.pastDue && s.pastDue.since ? s.pastDue : null;
  if (!s.signedIn) {
    return {
      allowed: false,
      reason: 'not_signed_in',
      title: 'Giriş gerekli',
      message: 'CrewPane’i kullanmak için CrewPane ID ile giriş yap.',
      action: 'sign_in',
    };
  }
  // PAY-3 — ÖDEME DÜŞTÜ VE SÜRE DOLDU: TAM KİLİT, AMA DOĞRU CÜMLEYLE.
  //
  // Bu dal HEM `license_revoked` HEM `no_seat`ten ÖNCE gelmek ZORUNDA — ikisi de
  // aynı anda tetiklenir ve ikisi de YANLIŞ cümle kurar:
  //   * PAY-1'in süresi dolunca `isProductEntitled` false döner → `seat` false →
  //     "Paketin yok, satın al" (ödeyen müşteriyi yeni satın almaya yollar),
  //   * aynı anda `revocationVerdict` yerel damgayı basar → `licenseStatus`
  //     'revoked' → "Aboneliğin sona erdi (abonelik iptali veya iade)" (yalan:
  //     ne iptal etti ne iade aldı; kartı düştü).
  // Doğru cümle ödemedir ve doğru ekran kart/ödeme ekranıdır.
  //
  // Eren kararı (2026-09-05): 15. gün TAM KİLİT, yalnız ödeme ekranı —
  // KISITLI MOD YOK. Bu yüzden burada kademe değil, tek bir kapı vardır.
  if (!s.seat && pastDue && pastDue.expired) {
    return {
      allowed: false,
      reason: 'license_past_due',
      title: 'Ödeme alınamadı',
      titleKey: 'license.pastDue.lockedTitle',
      message: 'Aboneliğinin ödemesi alınamadı ve ' + pastDue.graceDays
        + ' günlük süre doldu. Kartını güncellediğin anda ofisin geri açılır — '
        + 'hiçbir verin silinmedi.',
      messageKey: 'license.pastDue.lockedMessage',
      params: { days: pastDue.graceDays },
      action: 'billing',
    };
  }
  // PAY-ENDED-01 — ABONELİĞİ BİTTİ: TAM KİLİT, AMA DOĞRU CÜMLEYLE.
  //
  // Bu dal HEM `license_revoked` HEM `no_seat`ten ÖNCE gelmek ZORUNDA — ikisi de
  // aynı anda tetiklenir ve ikisi de YANLIŞ cümle kurar (PAY-CANCEL-01 §5.2'de
  // PROD kohortunda ölçüldü):
  //   * `no_seat` → "Bu hesapta aktif bir CrewPane paketi yok" — bu, hiç satın
  //     ALMAMIŞ birine söylenecek cümledir; dün abonesi olana değil.
  //   * `license_revoked` → "Aboneliğin sona erdi (abonelik iptali veya iade)" —
  //     iki ayrı olayı tek parantezde topluyor ve iptal edene "iade" diyor.
  //
  // İADE BURAYA GİRMEZ: `readCancelEnding` `revoked_at` damgalı satırda `null`
  // döner, yani parası geri verilen müşteri aşağıdaki `license_revoked` dalında
  // kalır (LIC-REFUND-01 cümlesi değişmedi).
  if (!s.seat && s.cancelEnding && s.cancelEnding.ended) {
    return {
      allowed: false,
      reason: 'subscription_ended',
      title: 'Aboneliğin bitti',
      titleKey: 'license.ended.lockedTitle',
      message: 'Aboneliğin sona erdi ve ofisin kapandı. Hiçbir verin silinmedi — '
        + 'ajanların, görevlerin ve hafızan duruyor. Yenilediğinde kaldığın yerden '
        + 'devam edersin.',
      messageKey: 'license.ended.lockedMessage',
      action: 'buy',
    };
  }
  // LIC-ENFORCE-01 — SUNUCU AÇIKÇA "YETKİ YOK" DEDİ. Bu dal diğer lisans
  // dallarından ÖNCE gelir, çünkü elimizdeki jeton hâlâ "fresh/grace" görünüyor
  // olabilir: kararı veren jetonun içeriği değil, sunucunun kaydedilmiş REDDİ.
  // Mesaj SUÇLAMAZ ve yalan söylemez: erişim kapandı, sebebi abonelik, çıkışı
  // yenilemek. (Kurulu sürüm çalışmaya devam eder — kapı yalnız erişimi kapatır.)
  if (s.licenseStatus === 'revoked') {
    return {
      allowed: false,
      reason: 'license_revoked',
      title: 'Aboneliğin sona erdi',
      message: 'Bu hesabın CrewPane erişimi kapatıldı (abonelik iptali veya iade). '
        + 'Devam etmek için planını yenile; yenilediğinde ofis anında açılır.',
      action: 'buy',
    };
  }
  // SEC-W2-A2 — SUNUCU "BU PAKET BİZİM GÖNDERDİĞİMİZ PAKET DEĞİL" DEDİ.
  //
  // Bu dal `license_unknown`dan ÖNCE gelmek ZORUNDA: jeton gerçekten alınamadı,
  // yani `licenseStatus` 'none'dur ve altındaki dal "İnternet bağlantını kontrol
  // et" derdi — bağlantı sağlamken bu YANLIŞ bir cümledir ve kullanıcıyı
  // çözümü olmayan bir yola sokar.
  //
  // Faturalama dallarından (`license_past_due`, `license_revoked`) SONRA gelir:
  // onlar sunucunun DİSKE YAZILMIŞ, para hakkında verilmiş hükümleridir ve
  // ödeyen bir müşteriye yanlışlıkla "dosyaların değişmiş" demek daha pahalıdır.
  //
  // Karar İSTEMCİDE VERİLMEZ: bu alan yalnız sunucunun 403'ü geldiğinde dolar.
  // İstemcinin kendi ölçümü (`integrityCheck.run`) buraya HİÇ girmez — girseydi,
  // denetimi söken kişi aynı anda bu dalı da söker ve geriye sahte bir güvenlik
  // kalırdı (SEC-BYPASS-01 §6).
  if (s.integrityDenied) {
    return {
      allowed: false,
      reason: 'integrity_mismatch',
      title: 'Uygulama dosyaları değişmiş',
      titleKey: 'integrity.mismatch.title',
      // Teknik terim 0: "hash", "manifest", "imza" geçmez. Kullanıcının
      // yapabileceği TEK şey söylenir.
      message: 'Uygulama dosyaları değiştirilmiş görünüyor; bulut ve ücretli motorlar kapalı. '
        + 'Uygulamayı crewpane.dev üzerinden yeniden indirdiğinde her şey geri açılır — '
        + 'hiçbir verin silinmedi.',
      messageKey: 'integrity.mismatch.message',
      action: 'retry',
    };
  }
  // Jeton HİÇ alınamadı: ödeme yapmamış olabilir de, ilk açılışta ağ/sunucu
  // sorunu yaşamış da olabilir. Suçlamıyoruz — durumu söylüyoruz + tekrar dene.
  if (s.licenseStatus === 'none') {
    return {
      allowed: false,
      reason: 'license_unknown',
      title: 'Lisans doğrulanamadı',
      message: 'Paket bilgin alınamadı. İnternet bağlantını kontrol edip "Durumu yenile"ye bas. '
        + 'Paketin yoksa bu ekrandan satın alabilirsin.',
      action: 'retry',
    };
  }
  if (s.licenseStatus === 'expired') {
    return {
      allowed: false,
      reason: 'license_expired',
      title: 'Paketinin süresi doldu',
      message: 'Lisansın çevrimdışı tolerans süresini (14 gün) de aştı. '
        + 'Devam etmek için paketini yenile.',
      action: 'buy',
    };
  }
  if (s.licenseStatus === 'invalid') {
    return {
      allowed: false,
      reason: 'license_invalid',
      title: 'Lisans doğrulanamadı',
      message: 'Kayıtlı lisans bilgisi geçersiz. "Durumu yenile"ye basarak yeniden al; '
        + 'sorun sürerse çıkış yapıp tekrar giriş yap.',
      action: 'retry',
    };
  }
  if (!s.seat) {
    return {
      allowed: false,
      reason: 'no_seat',
      title: 'Paket gerekli',
      message: 'Bu hesapta aktif bir CrewPane paketi yok. Basic, Pro veya Ultra '
        + 'paketlerinden birini alarak ofisini açabilirsin.',
      action: 'buy',
    };
  }
  // PAY-3 — SÜRE İÇİNDE: ERİŞİM TAM, AMA SESSİZ DEĞİL.
  //
  // Bugünkü sızıntının insan tarafı buydu: ödemesi düşen müşteri HİÇBİR uyarı
  // görmüyordu ve bir gün aniden kilitlenecekti. Band, kilidi ÖNCEDEN haber verir.
  //
  // `notice` bir REDDİN yumuşatılmışı DEĞİLDİR: `allowed` true kalır ve karar
  // hiçbir yeteneği kısmaz (Eren: "kısıtlı mod YOK"). UI yalnız bir şerit basar.
  // Kısıt alanı bilerek YOKTUR — olsaydı UI ondan yarım bir mod türetirdi.
  if (pastDue && !pastDue.expired) {
    // PAY-LOCK-01 — GERİ SAYIM SON İKİ GÜNDE AÇILIR.
    //
    // Pencere 3 güne indi (Eren 2026-09-17). Bandın tonu sabit kalsaydı kullanıcı
    // üç gün boyunca aynı cümleyi görür, aciliyetin arttığını fark etmezdi — ve
    // kilit yine sürpriz olurdu. Kartın şartı bu yüzden "kilit gününden önce İKİ
    // KEZ uyarılmış olmak": `daysLeft` 2 ve 1 iken geri sayım cümlesi çıkar.
    //
    //   gün 0 → daysLeft 3 → düz bant   ("3 gün içinde güncellemezsen…")
    //   gün 1 → daysLeft 2 → GERİ SAYIM ("2 gün sonra erişimin duracak")   ← 1. uyarı
    //   gün 2 → daysLeft 1 → GERİ SAYIM ("1 gün sonra erişimin duracak")   ← 2. uyarı
    //   gün 3 → expired    → TAM KİLİT (yukarıdaki dal)
    //
    // Eşik `daysLeft`ten türer, takvimden DEĞİL: pencere yarın 5 güne çıkarsa
    // geri sayım yine son iki günde başlar, bu blok değişmez.
    const COUNTDOWN_FROM_DAYS_LEFT = 2;
    const countdown = pastDue.daysLeft !== null && pastDue.daysLeft <= COUNTDOWN_FROM_DAYS_LEFT;
    // "1 gün sonra" İngilizcede "in 1 days" olur — bu yüzden son gün kendi
    // anahtarını taşır ("Yarın" / "tomorrow"). Sayıyı çoğul ekiyle kurtarmaya
    // çalışmak iki dilde iki ayrı kalıp demekti; ayrı anahtar daha ucuz.
    let messageKey;
    let message;
    if (!countdown) {
      messageKey = 'license.pastDue.bannerMessage';
      message = `Kartından ödeme alınamadı. ${pastDue.daysLeft} gün içinde güncellemezsen `
        + 'ofis kilitlenir; şimdilik her şey açık.';
    } else if (pastDue.daysLeft >= 2) {
      messageKey = 'license.pastDue.bannerMessageCountdown';
      message = `${pastDue.daysLeft} gün sonra erişimin duracak. Kartını güncelle — `
        + 'şimdilik her şey açık.';
    } else if (pastDue.daysLeft === 1) {
      messageKey = 'license.pastDue.bannerMessageTomorrow';
      message = 'Yarın erişimin duracak. Kartını güncelle — şimdilik her şey açık.';
    } else {
      messageKey = 'license.pastDue.bannerMessageLastDay';
      message = 'Kartından ödeme alınamadı. Süre bugün doluyor — güncellemezsen ofis yarın kilitlenir.';
    }
    return {
      allowed: true,
      notice: {
        level: countdown ? 'urgent' : 'warning',
        reason: 'payment_past_due',
        title: 'Ödemen alınamadı',
        titleKey: 'license.pastDue.bannerTitle',
        message,
        messageKey,
        params: { days: pastDue.daysLeft },
        daysLeft: pastDue.daysLeft,
        // PAY-LOCK-01 — bandın KAPATILAMAZ olduğu main'in kararıdır, renderer'ın
        // tercihi değil. Alan olarak taşınır ki "şeridi gizle" bir gün geri
        // gelirse testin yakalayacağı tek bir yer olsun.
        dismissible: false,
        countdown,
        action: 'billing',
      },
    };
  }
  // PAY-ENDED-01 — İPTAL ETTİ AMA DÖNEMİ SÜRÜYOR: ERİŞİM TAM, AMA SESSİZ DEĞİL.
  //
  // ÖLÇÜLEN SORUN (PAY-CANCEL-01 §3.2): iptal etmiş ve dönemi henüz bitmemiş 9
  // kişi var; hiçbiri uygulamada bir geri sayım görmüyor ve kapanma günü ofisini
  // kapalı buluyor. Alan JETONUN İÇİNDE zaten duruyordu (BILL-CANCEL-01,
  // `license-token` v19) — okuyan yoktu.
  //
  // Gecikme şeridinden SONRA gelir ve onu EZMEZ: ikisi aynı anda doğru olamaz
  // (`readCancelEnding` zaten `past_due` satırı varken `null` döner) ve gecikme
  // daha acil bir olaydır — orada kilit 3 gün sonra, burada ödenmiş dönemin
  // sonunda.
  //
  // `notice` bir REDDİN yumuşatılmışı DEĞİLDİR: `allowed` true kalır, hiçbir
  // yetenek kısılmaz. Kullanıcı ödediği dönemi sonuna kadar TAM kullanır.
  if (s.cancelEnding && !s.cancelEnding.ended) {
    // GERİ SAYIM SON ÜÇ GÜNDE AÇILIR (Eren kararı 2026-09-20). TEK SAYI: hem
    // tonu yükseltir hem de kullanıcının kapattığı şeridi geri getirir. İki ayrı
    // eşik yazsaydık, "hangi gün neyi gördüm" sorusunun iki cevabı olurdu.
    const COUNTDOWN_FROM_DAYS_LEFT = 3;
    const left = s.cancelEnding.daysLeft;
    const countdown = left !== null && left <= COUNTDOWN_FROM_DAYS_LEFT;
    // "1 gün sonra" İngilizcede "in 1 days" olur → son gün kendi anahtarını taşır
    // (gecikme şeridindeki aynı ders).
    //
    // 🔴 EŞLEME GECİKME ŞERİDİYLE BİREBİR AYNI (`license.pastDue.*`):
    //   floor ≥2 → "N gün sonra" · floor 1 → "Yarın" · floor 0 → "BUGÜN".
    // Son dal bir düzeltmedir: ilk hâli 0'da "yarın" diyordu ve BUGÜN akşam
    // bitecek aboneliğe bir gün fazla vaat ediyordu. Aynı sınıf kusur postada da
    // vardı ve 22.09 takvim provasında yakalandı (`dunning-copy.ts::lockedYet`).
    // "1 gün sonra" İngilizcede "in 1 days" olur → her dal kendi anahtarını taşır.
    let messageKey;
    let message;
    if (left === 0) {
      messageKey = 'license.ending.bannerMessageToday';
      message = 'Aboneliğin bugün bitiyor. Ofisin bugünden sonra kapanır; devam etmek istersen yenileyebilirsin.';
    } else if (left === 1) {
      messageKey = 'license.ending.bannerMessageTomorrow';
      message = 'Aboneliğin yarın bitiyor. Ofisin o gün kapanır; devam etmek istersen yenileyebilirsin.';
    } else {
      messageKey = 'license.ending.bannerMessage';
      message = `Aboneliğin ${left} gün sonra bitiyor. O tarihe kadar her şey açık; `
        + 'devam etmek istersen yenileyebilirsin.';
    }
    return {
      allowed: true,
      notice: {
        level: countdown ? 'urgent' : 'warning',
        reason: 'subscription_ending',
        title: 'Aboneliğin bitiyor',
        titleKey: 'license.ending.bannerTitle',
        message,
        messageKey,
        params: { days: left },
        daysLeft: left,
        // 🔴 GECİKME ŞERİDİNİN TERSİNE: BU ŞERİT KAPATILABİLİR.
        // PAY-LOCK-01 gecikme şeridini kapatılamaz yaptı, çünkü orada kullanıcı
        // şeridi kapatırsa kilide kadar bir daha uyarı GÖRMEZ (pencere 3 gün).
        // Burada durum başka: kullanıcı kararını ZATEN vermiş, ofisi ödediği
        // dönem boyunca açık ve pencere haftalarca sürebilir. Verdiği kararı her
        // gün yüzüne vuran kapatılamaz bir şerit bilgi değil, baskı olurdu.
        // Karşılığı: son 3 günde (`countdown`) şerit KENDİLİĞİNDEN geri gelir —
        // yani "kapatabilirsin" sözü "kapanma günü sürpriz olur" demek değildir.
        dismissible: true,
        countdown,
        action: 'billing',
      },
    };
  }
  return { allowed: true };
}

/**
 * PAY-ENDED-01 — JETONDAN İPTAL DURUMUNU ÖLÇ (karar DEĞİL, VERİ).
 *
 * `readPastDue`in iptal ikizi. Sunucu ikizi `_shared/dunning.ts::cancelAccessEndsAt`
 * ile BİREBİR aynı kuraldır: ofis, tek bir satırın değil SATIRLARIN BİRLİKTE
 * kararıdır. Dört kapı da `null` döndürür ve hepsi bilerek:
 *   (a) İADE damgası (`revoked_at`) → LIC-REFUND-01 erişimi ANINDA kapatır;
 *       parası geri verilene "dönmek ister misin" demek yanlış olur.
 *   (b) `past_due` satırı → kullanıcı GECİKME zincirinin müşterisi. İki farklı
 *       hikâye ("kartın geçmedi" / "aboneliğin bitiyor") aynı anda gösterilmez.
 *   (c) İptal EDİLMEMİŞ aktif satır (ör. `plan='ltd'` ömür boyu paket) → ofis
 *       kapanmıyor, veda şeridi YALAN olurdu. PROD'da 12 böyle satır var.
 *   (d) Hiç iptal adayı yok ya da dönem sonu ölçülemiyor.
 *
 * 🔴 EN GEÇ BİTEN KAZANIR — `readPastDue`in TERSİ (orada EN ERKEN damga kazanır).
 * Gecikmede erişim İLK satır düşünce durur; iptalde SON satır bitene kadar açık
 * kalır. Aynı kuralı iki yere yazmak, kullanıcıya yanlış gün söylemenin en sessiz
 * yoluydu.
 *
 * @param {object} verify - verifyLicenseToken sonucu (valid + payload)
 * @param {string[]} productIds - CrewPane erişimi veren ürün kimlikleri
 * @returns {{periodEnd:string, daysLeft:number, ended:boolean}|null}
 */
function readCancelEnding(verify, productIds) {
  if (!verify || verify.valid !== true || !verify.payload) return null;
  const all = Array.isArray(verify.payload.products) ? verify.payload.products : [];
  const wanted = new Set(productIds || []);
  const rows = all.filter((r) => r && wanted.has(r.product));
  if (rows.length === 0) return null;
  if (rows.some((r) => r.revoked_at)) return null;                      // (a)
  if (rows.some((r) => r.status === 'past_due')) return null;           // (b)

  let latest = null;
  for (const r of rows) {
    const ends = r.cancel_at_period_end === true || r.status === 'canceled';
    if (!ends) {
      // (c) Bilinmeyen statüyü "bitiyor" saymak, ölçemediğimiz bir satır yüzünden
      // ÖDEYEN müşteriye veda postası/şeridi göstermek olurdu.
      if (r.status === 'active') return null;
      continue;
    }
    const t = r.period_end ? Date.parse(r.period_end) : NaN;
    if (!Number.isFinite(t)) continue;                                  // (d)
    if (latest === null || t > latest) latest = t;
  }
  if (latest === null) return null;

  const nowSeconds = Number.isFinite(verify.effectiveNowSeconds)
    ? verify.effectiveNowSeconds
    : Math.floor(Date.now() / 1000);
  const remaining = Math.floor(latest / 1000) - nowSeconds;
  return {
    periodEnd: new Date(latest).toISOString(),
    // `Math.floor` PARİTE: sunucu ikizi `dunning.ts::daysUntilEnd` aynı ifadeyi
    // kullanır. Yukarı yuvarlasaydık şeritte "3 gün", postada "4 gün" yazardı.
    daysLeft: Math.max(0, Math.floor(remaining / 86400)),
    ended: remaining < 0,
  };
}

/**
 * PAY-3 — JETONDAN GECİKME DURUMUNU ÖLÇ (karar DEĞİL, VERİ).
 *
 * PAY-1 sunucuda `entitlements.past_due_since` damgasını yazar ve `license-token`
 * onu jetona koyar. Burada o damga bir SAYACA çevrilir: kaç gün kaldı, doldu mu.
 *
 * Damgasız satır `null` döner (ve band ÇIKMAZ): PAY-1'in geri-uyum kuralı gereği
 * damgasız `past_due` erişim vermeye devam eder — sayacı olmayan bir band
 * "N gün kaldı" diyemez ve kullanıcıyı sebepsiz telaşlandırır.
 *
 * @param {object} verify - verifyLicenseToken sonucu (valid + payload)
 * @param {string[]} productIds - CrewPane erişimi veren ürün kimlikleri
 * @param {number} graceSeconds - `PAST_DUE_GRACE_SECONDS` (istemci ikizi sabiti)
 * @returns {{since:string|null, graceDays:number, daysLeft:number|null, expired:boolean}|null}
 */
function readPastDue(verify, productIds, graceSeconds) {
  if (!verify || verify.valid !== true || !verify.payload) return null;
  const rows = Array.isArray(verify.payload.products) ? verify.payload.products : [];
  const wanted = new Set(productIds || []);
  const pastDueRows = rows.filter((r) => r && r.status === 'past_due' && wanted.has(r.product));
  if (pastDueRows.length === 0) return null;
  const graceDays = Math.round(graceSeconds / 86400);
  // Birden çok ürün gecikmişse EN ESKİ damga kazanır: kilit hepsi için aynı gün
  // düşer, kullanıcı iki ayrı sayaç görmez.
  let oldest = null;
  for (const r of pastDueRows) {
    const t = r.past_due_since ? Date.parse(r.past_due_since) : NaN;
    if (!Number.isFinite(t)) continue;
    if (oldest === null || t < oldest) oldest = t;
  }
  if (oldest === null) {
    // Satır gecikmiş ama damgası YOK/bozuk → ölçemiyoruz (PAY-1 geri-uyumu).
    return { since: null, graceDays, daysLeft: null, expired: false };
  }
  const nowSeconds = Number.isFinite(verify.effectiveNowSeconds)
    ? verify.effectiveNowSeconds
    : Math.floor(Date.now() / 1000);
  const endsAt = Math.floor(oldest / 1000) + graceSeconds;
  const remaining = endsAt - nowSeconds;
  return {
    since: new Date(oldest).toISOString(),
    graceDays,
    daysLeft: Math.max(0, Math.floor(remaining / 86400)),
    expired: remaining < 0,
  };
}

/**
 * @param {object} opts
 * @param {object} opts.authPkg      - @crewpane/auth (require edilmiş)
 * @param {object} opts.safeStorage  - Electron safeStorage (veya test ikizi)
 * @param {string} opts.homeDir      - ~/.crewpane (instance-aware; auth/ altına yazar)
 * @param {string} opts.supabaseUrl
 * @param {string} opts.anonKey
 * @param {string} opts.scheme       - 'crewpane'
 * @param {string} [opts.loginUrl]
 * @param {(url:string)=>unknown} opts.openExternal - sistem tarayıcısı (shell.openExternal)
 * @param {(line:string)=>void} [opts.log]
 * @param {()=>void} [opts.onChange] - durum değişince (Ayarlar'a canlı push)
 * @param {boolean} [opts.requireSeat=false] - ADP-646 LİSANS KAPISI: true ise aktif
 *   entitlement'ı olmayan kullanıcıya uygulama fonksiyonelitesi (ajan spawn, görev,
 *   ofis) AÇILMAZ. Müşteri build'inde her zaman true (crewpaneId.cjs).
 * @param {boolean} [opts.requireLogin=false] - ADP-520 LOGIN DUVARI: true ise renderer
 *   oturumsuz kullanıcıya tam-ekran "CrewPane ID ile giriş" gate'i basar.
 * @param {string} [opts.billingUrl] - "Satın al" hedefi (kapı ekranı bunu açar).
 * @param {string} [opts.appVersion] - ADP-714: oturum kaydına düşecek ürün sürümü.
 * @param {{id:string,name?:string,platform?:string}} [opts.device] - SEC-01: bu
 *   kurulumun cihaz kimliği (accountScope.ensureDeviceId). Verilirse jeton isteği
 *   cihaz-farkında olur ve sunucu paketin cihaz tavanını uygular. Verilmezse
 *   davranış BİT-BİT eskisi gibidir (tavan yok) — testler ve eski yollar kırılmaz.
 */
function createSeatGate(opts) {
  const {
    authPkg, safeStorage, homeDir, supabaseUrl, anonKey, scheme,
    loginUrl, billingUrl = null, openExternal, onChange,
    requireSeat = false, requireLogin = false, device = null,
  } = opts;
  const log = opts.log || (() => {});

  // ADP-943 — depo artık SEBEBİNİ söyler (log + lastLoadOutcome). "Neden yine giriş
  // ekranındayım?" sorusu böylece log'dan cevaplanabilir hâle geliyor; davranış
  // (fail-closed) değişmiyor.
  // LX-SAFESTORAGE-01 — SIR ARKA UCU ÖLÇÜLDÜYSE YAZMA HİÇ DENENMEZ.
  // Sarmalayıcı ENJEKTE EDİLEBİLİR: varsayılan modül hükmü açılışta main'de
  // ölçülür (`secretBackendState.initSecretBackendState`), testlerde ölçüm YOKTUR
  // ve sarmalayıcı ŞEFFAFTIR → mevcut seatGate testleri bit-bit aynı kalır.
  const guardStore = opts.guardSecretStore
    || require('./secretBackendState.cjs').guardTokenStore;
  const sessionStore = guardStore(authPkg.createSafeStorageTokenStore({
    safeStorage, filePath: path.join(homeDir, 'auth', 'session.bin'),
    log, label: 'session',
  }), { label: 'session', log });
  // Lisans jetonu AYRI blob'da: oturum dokümanını handleCallback KOMPLE değiştirir →
  // aynı dokümana yazılan jeton sessizce yok olurdu (ADP-389'da Keychain'de yaşandı).
  const licenseStore = guardStore(authPkg.createSafeStorageTokenStore({
    safeStorage, filePath: path.join(homeDir, 'auth', 'license.bin'),
    log, label: 'license',
  }), { label: 'license', log });

  const auth = authPkg.createDesktopAuth({
    supabaseUrl,
    apiKey: anonKey,
    redirectUri: `${scheme}://auth/callback`,
    tokenStore: sessionStore,
    openExternal,
    loginUrl: loginUrl || undefined,
    appId: 'CrewPane',
    // ADP-714 — jeton çağrılarının user-agent'ı 'CrewPane/<sürüm>' olur →
    // `auth.sessions.user_agent` "kim uygulamayı AÇTI" sorusunu cevaplar
    // (scripts/launch-status.mjs). Sürüm verilmezse yalnız ürün adı yazılır.
    appVersion: opts.appVersion || undefined,
  });

  let signedIn = false;
  let email = null;
  let userId = null;
  let licenseToken = null;
  let lastServerTime = null;
  // LIC-ENFORCE-01 — YEREL KARA-LİSTE DAMGASI (license.cjs). Sunucunun AÇIK
  // reddi diske düşer; sonraki açılış çevrimdışı olsa bile bu damgayı görür.
  // `null` = sunucu bize hiç "yetki yok" dememiş (grace normal çalışır).
  let revocation = null;
  let snapshot = null;
  // SEC-01 — sunucunun EN SON verdiği cihaz kararı. `null` = henüz bir şey
  // bilmiyoruz. Reddi burada TUTMAK şart: jeton tazeleme arka planda koşar, oysa
  // kullanıcı cümleyi Ayarlar'ı açtığında görecek — anlık bir olay olarak
  // yayınlayıp unutursak ret SESSİZ kalır (tam da yasaklanan şey).
  let deviceInfo = null;
  // SEC-W2-A2 — SUNUCUNUN bütünlük reddi. `false` = sunucu böyle bir şey
  // demedi. İstemcinin KENDİ ölçümü buraya YAZILMAZ (karar sunucunundur);
  // burada tutulan şey yalnız sunucunun en son cevabıdır. Diske DE yazılmaz:
  // kullanıcı temiz kopyayı kurduğunda bir sonraki istekte kendiliğinden düşer.
  let integrityDenied = false;
  // SEC-02 — KİRA KALP ATIŞI. Uygulama açık kaldığı sürece koltuğun bizde
  // olduğunu sunucuya söyleyen zamanlayıcı. Aralık SUNUCUDAN gelir
  // (`heartbeat_minutes`); yerel sabit yalnız sunucu susarsa devreye girer, iki
  // gerçek olmasın diye.
  const HEARTBEAT_FALLBACK_MS = 5 * 60_000;
  let heartbeatTimer = null;
  let heartbeatMs = HEARTBEAT_FALLBACK_MS;

  function emitChange() {
    try { if (onChange) onChange(snapshot); } catch (e) { log(`seatGate onChange error: ${e.message}`); }
  }

  /** Durumu YENİDEN hesapla — ucuz, tamamen yerel (ağ YOK): ES256 doğrulama + grace. */
  function evaluate() {
    let licenseStatus = 'none'; // fresh | grace | expired | invalid | none
    let seat = false;
    let products = [];
    let accessProducts = [];
    let tier = null;
    let verify = null;
    // LIC-ENFORCE-01 — damga jetondan ÖNCE sorulur mu? HAYIR: damga jetonun
    // `iat`'ıyla kıyaslandığı için önce doğrulama şart. Ama karar SIRASI şudur:
    // jeton geçerli olsa BİLE damga onu geçersiz kılabilir.
    let revoked = false;
    if (licenseToken) {
      verify = authPkg.verifyWithEmbeddedKeys(licenseToken, { lastServerTime });
      revoked = !!(authPkg.revocationApplies
        && authPkg.revocationApplies(revocation, verify, { userId }));
      if (revoked) {
        // Sunucu bu hesabın yetkisini kapattı ve elimizdeki jeton O ANDAN ÖNCE
        // imzalanmış. Grace uygulanMAZ (grace çevrimdışı ÖDEYEN müşteri içindir),
        // eski bir license.bin yedeği geri konsa da bu dal değişmez.
        licenseStatus = 'revoked';
      } else if (verify.valid) {
        licenseStatus = verify.status; // fresh | grace
        // ADP-614: eski (crewpane.seat) VE yeni (basic/pro/ultra) modelin
        // hepsi kataloğun içindedir — her biri jetona karşı AYNI yoldan
        // (isProductEntitled: status/period_end/trial semantiği) sınanır.
        accessProducts = planCatalog
          .accessProductIds()
          .filter((productId) => authPkg.isProductEntitled(verify, productId));
        tier = planCatalog.resolveTier(accessProducts); // en yüksek rank kazanır
        seat = accessProducts.length > 0;
        products = (verify.payload.products || [])
          .filter((p) => p && p.status === 'active')
          .map((p) => p.product);
      } else {
        licenseStatus = verify.reason === 'expired_beyond_grace' ? 'expired' : 'invalid';
      }
    }
    snapshot = {
      requireSeat,          // kapı açık mı (bu sürümde false)
      requireLogin,         // ADP-520 — login duvarı açık mı (renderer gate buna bakar)
      signedIn,
      email,
      userId,
      licenseStatus,
      seat,                 // CrewPane erişimi var mı (katalogdaki HERHANGİ bir ürün)
      tier: tier ? tier.id : null,          // 'basic' | 'pro' | 'ultra' | null
      tierLabel: tier ? tier.label : null,  // 'Basic' | 'Pro' | 'Ultra' | null
      tierRank: tier ? tier.rank : 0,
      // Yetenek İSKELETİ — ADP-614 hiçbir yerde ZORLAMAZ (zorlama ADP-616).
      caps: tier ? tier.caps : null,
      accessProducts,       // CrewPane erişimi veren AKTİF ürünler (çoğu zaman 1)
      products,             // jetondaki AKTİF ürünler (Pro/Ultra/Suite'te üçü birden)
      productLabels: planCatalog.productLabels(), // etiketler tek kaynaktan
      graceRemainingSeconds: verify && verify.valid && !revoked ? verify.graceRemainingSeconds : 0,
      // LIC-ENFORCE-01 — ret VERİ olarak taşınır (Ayarlar/destek "neden kapandı?"
      // sorusunu log'suz cevaplayabilsin). Metin renderer'da YAZILMAZ (denial'da).
      revocation: revoked ? { reason: revocation.reason, at: revocation.at } : null,
      billingUrl,           // ADP-646 — "Satın al" hedefi (renderer kapısı bunu açar)
      // SEC-01 — sunucunun cihaz kararı: { enforced, limit, active, tier, ... }
      // ya da tavan aşıldıysa { denied:true, limit, active, devices[] }.
      // Bu alan bir KARAR DEĞİL, sunucunun bildirdiği DURUMDUR — kapı kararı
      // (accessAllowed) buna BAKMAZ: elde geçerli bir jeton varsa kullanıcı
      // çalışmaya devam eder (yeni jeton alamamak ≠ anında kilit; 72 saatlik
      // jeton + grace zaten bunun için var).
      device: deviceInfo,
      // SEC-W2-A2 — sunucunun bütünlük reddi (karar değil, sunucunun DURUMU).
      integrityDenied,
      // PAY-3 — ödeme gecikmesi SAYACI (karar değil, VERİ). `decideAccess` bunu
      // okuyup band ya da kilit üretir; damgasız satırda `since` null gelir ve
      // hiçbir şey gösterilmez (PAY-1 geri-uyumu).
      // `revoked` olsa BİLE ölçülür: damga bir KARARDIR, gecikme sayacı VERİDİR.
      // Süre dolunca yerel damga da basılır (reason='past_due') ve bu sayaç
      // olmasaydı kapı "Aboneliğin sona erdi (iptal/iade)" derdi — ödemesi düşen
      // müşteriye YANLIŞ cümle ve yanlış ekran.
      pastDue: readPastDue(
        verify,
        planCatalog.accessProductIds(),
        // PAY-LOCK-01 — yedek sayı da İKİZDİR: `license.cjs` ile aynı olmak
        // ZORUNDA, yoksa sabit okunamadığı gün kapı sessizce eski pencereye
        // döner. Parite kapısı bu satırı da okur.
        authPkg.PAST_DUE_GRACE_SECONDS || 3 * 24 * 60 * 60,
      ),
      // PAY-ENDED-01 — iptal SAYACI (karar değil, VERİ). `decideAccess` bunu
      // okuyup geri sayım şeridi ya da "aboneliğin bitti" kilidi üretir.
      // `revoked` olsa BİLE ölçülür: damga bir KARARDIR, sayaç VERİDİR — ve bu
      // sayaç olmasaydı kapı iptal edene "iade" ya da "paketin yok" derdi.
      cancelEnding: readCancelEnding(verify, planCatalog.accessProductIds()),
    };
    // ADP-646 — kapı kararı + kullanıcı metni SNAPSHOT'IN İÇİNDE: renderer kendi
    // Türkçe cümlesini kurmaz, main ne diyorsa onu basar (tek gerçek kaynak).
    const decision = decideAccess(snapshot);
    snapshot.accessAllowed = decision.allowed;
    snapshot.denial = decision.allowed ? null : {
      reason: decision.reason,
      title: decision.title,
      message: decision.message,
      action: decision.action,
      // PAY-3 — i18n anahtarı + parametre: renderer TR/EN'i sözlükten basar,
      // metin YİNE tek kaynaktan (burası) gelir. Anahtarsız eski dallarda
      // undefined kalır ve renderer düz `message`a düşer (davranış değişmez).
      titleKey: decision.titleKey,
      messageKey: decision.messageKey,
      params: decision.params,
    };
    // PAY-3 — BAND (ret DEĞİL): erişim açıkken gösterilen uyarı şeridi.
    snapshot.notice = decision.notice || null;
    return snapshot;
  }

  function state() {
    return snapshot || evaluate();
  }

  /**
   * KAPI (ADP-646 — artık GERÇEKTEN çağrılır). Korunan her eylem bunu çağırır:
   *   const gate = seatGate.requireSeat('pty:spawn');
   *   if (!gate.allowed) throw new Error(gate.message);
   *
   * Karar `decideAccess` ile tek yerde verilir → main'in reddettiği durum ile
   * renderer'ın gösterdiği ekran ASLA ayrışamaz.
   *
   * @param {string} [action] - log/telemetri için eylem adı
   * @returns {{allowed:boolean, reason?:string, title?:string, message?:string, action?:string}}
   */
  function requireSeatFor(action) {
    const s = evaluate();
    const decision = decideAccess(s);
    if (!decision.allowed) {
      log(`seatGate: ${action || 'action'} REDDEDİLDİ (${decision.reason})`);
      return decision;
    }
    if (s.requireSeat) log(`seatGate: ${action || 'action'} izinli (katman=${s.tier || 'seat'})`);
    return { allowed: true };
  }

  /**
   * ADP-622 — UYGULAMA DB'Sİ İÇİN KİMLİK: kullanıcının CrewPane ID **access
   * token**'ı (JWT). Tek çıkış noktası burasıdır; main bunu IPC/bridge üstünden
   * dağıtır, refresh token ve oturum dokümanı MAIN'de (safeStorage) KALIR.
   *
   * Tazeleme (1c) `auth.getSession()`in içindedir: ömrü 60sn'den az kalmışsa
   * refresh_token ile SESSİZCE yenilenir, yeni oturum depoya yazılır. Yani
   * çağıran taraf "süresi doldu mu" diye uğraşmaz.
   *
   * Üç ayrı sonuç — sessizce aynı kefeye konmamalı:
   *   • ok           → jeton (+ expiresAt/userId)
   *   • not_signed_in / session_expired → oturum YOK (sunucu refresh'i reddetti;
   *     depodaki jetona düşmek YANLIŞ olurdu, o zaten silindi)
   *   • offline      → ağ hatası; depodaki jetonla devam edilir (offline ≠ çıkış,
   *     ADR-027 §4). Süresi geçmişse sunucu 401'ler — son sözü sunucu söyler.
   * @returns {Promise<{ok:true, token:string, expiresAt:number|null, userId:string|null}
   *                  |{ok:false, reason:string}>}
   */
  async function accessToken() {
    if (!signedIn) return { ok: false, reason: 'not_signed_in' };
    let session = null;
    let offline = false;
    try {
      session = await auth.getSession();
    } catch (e) {
      // Ağ hatası VE zaman aşımı (INC-20260917-02) aynı kefede: oturum KORUNUR
      // (getSession throw eder, silmez) → depodaki jetonla devam. offline ≠ çıkış.
      offline = true;
      const why = (e && e.name === 'TimeoutError') ? `zaman aşımı: ${e.message}` : e.message;
      log(`seatGate accessToken: oturum tazelenemedi (${why}) — depodaki jeton denenir`);
    }
    if (!session && offline) {
      const doc = await sessionStore.load().catch(() => null);
      session = doc && doc.session ? doc.session : null;
    }
    if (!session || typeof session.access_token !== 'string' || !session.access_token) {
      if (!offline) {
        // Sunucu refresh'i reddetti → oturum gerçekten bitti; durumu da düzelt
        // (aksi hâlde Ayarlar "giriş yapılmış" göstermeye devam ederdi).
        signedIn = false;
        email = null;
        userId = null;
        evaluate();
        emitChange();
        return { ok: false, reason: 'session_expired' };
      }
      return { ok: false, reason: 'offline_no_token' };
    }
    return {
      ok: true,
      token: session.access_token,
      // GoTrue semantiği: EPOCH SANİYE (ms değil) — önbellekler buna göre yaşar.
      expiresAt: Number.isFinite(session.expires_at) ? session.expires_at : null,
      userId: (session.user && session.user.id) || userId || null,
    };
  }

  /** Oturum jetonunu veren tek okuyucu (offline'da depodaki jetona düşer). */
  async function sessionAccessToken() {
    // getSession ağ hatasında/zaman aşımında THROW eder (offline ≠ çıkış) →
    // depodaki token'la dene. Sessiz yutma YOK: neden tek satır loglanır.
    const s = await auth.getSession().catch((e) => {
      log(`seatGate sessionAccessToken: oturum tazelenemedi (${(e && e.message) || e}) — depodaki jeton denenir`);
      return null;
    });
    if (s) return s.access_token;
    const doc = await sessionStore.load().catch(() => null);
    return doc && doc.session ? doc.session.access_token : null;
  }

  /**
   * SEC-W2-A2 — isteğe binen bütünlük raporu (tek yer).
   *
   * Sağlayıcı ATARSA rapor gönderilmez: bir ölçüm arızası ÖDEYEN müşteriyi
   * kesmemeli. `null` dönmek "ölçmedim" demektir ve sunucuda zorlama YOKTUR.
   */
  function integrityReport() {
    if (typeof opts.getIntegrityReport !== 'function') return null;
    try {
      const r = opts.getIntegrityReport();
      return r && r.jws && r.root ? { jws: r.jws, root: r.root } : null;
    } catch (e) {
      log(`seatGate: bütünlük raporu okunamadı (${e.message}) — rapor gönderilmiyor`);
      return null;
    }
  }

  /** SEC-01/02 — isteğe binen cihaz kimliği (tek yer). */
  function deviceParam() {
    return device && device.id
      ? { id: device.id, name: device.name, platform: device.platform, app: 'crewpane' }
      : undefined;
  }

  /**
   * LIC-ENFORCE-01 — SUNUCUNUN TESLİM ETTİĞİ JETONDAN DAMGA KARARI.
   *
   * Bu fonksiyon YALNIZ sunucu bir jeton teslim ettiğinde çağrılır; ağ hatası,
   * 5xx ve cihaz reddi buraya HİÇ gelmez — bu, "ödeyen çevrimdışı müşteri
   * kesilmez" kuralının kod hâlidir.
   *
   * Üç sonuç ayrılır (birbirine karıştırılırsa yanlış pozitif doğar):
   *   * `undefined` → HÜKÜM YOK (jeton doğrulanamadı; eski damgaya dokunma)
   *   * `null`      → yetki VAR   → damga DÜŞER (yeniden abone oldu)
   *   * damga       → yetki YOK   → sunucunun AÇIK reddi kaydedilir
   *
   * @returns {{v:number,userId:string|null,reason:string,at:number}|null|undefined}
   */
  function revocationVerdict(token, serverTime) {
    const verify = authPkg.verifyWithEmbeddedKeys(token, { lastServerTime });
    if (!verify.valid) return undefined; // doğrulanamayan jetondan hüküm çıkarmayız
    const ids = planCatalog.accessProductIds();
    if (ids.some((productId) => authPkg.isProductEntitled(verify, productId))) return null;
    // Sebep VERİDEN türer (isim bazlı `if` yok): erişim veren ürünlerin jetondaki
    // statüsüne bakılır. Ret cümlesi kullanıcıya "neden" diyebilsin diye taşınır.
    const entries = Array.isArray(verify.payload.products) ? verify.payload.products : [];
    const mine = entries.filter((p) => p && ids.includes(p.product));
    const reason = mine.some((p) => p.status === 'revoked') ? 'revoked'
      : mine.some((p) => p.status === 'canceled') ? 'canceled'
        // PAY-3 — ÖDEME GECİKMESİ AYRI BİR SEBEPTİR. Eskiden `inactive` kefesine
        // düşüyordu ve kullanıcı "aboneliğin sona erdi (iptal veya iade)" cümlesini
        // görüyordu; ne iptal etmişti ne iade almıştı — kartı düşmüştü.
        : mine.some((p) => p.status === 'past_due') ? 'past_due'
          : mine.length ? 'inactive' : 'no_entitlement';
    return authPkg.makeRevocationStamp({
      // Jetonun `sub`'ı SUNUCU gerçeğidir; oturum kaydı yalnız yedek.
      userId: verify.payload.sub || userId || null,
      reason,
      // `server_time` yoksa jetonun kendi `iat`'ı: ikisi de SUNUCU saatidir.
      at: Number.isFinite(serverTime) ? serverTime : verify.payload.iat,
    });
  }

  /**
   * SEC-02 — sunucunun cihaz cevabını tek şekle indir. `denied:false` alanı
   * BİLEREK her zaman yazılır: eski bir ret nesnesinin üstüne yeni bilgi
   * yazıldığında "denied" bayrağı asılı kalırsa ekran çözülmüş bir sorunu
   * göstermeye devam eder.
   */
  function applyDeviceInfo(info) {
    deviceInfo = info && typeof info === 'object' ? { ...info, denied: false } : null;
    const mins = deviceInfo && Number(deviceInfo.heartbeat_minutes);
    if (Number.isFinite(mins) && mins > 0) heartbeatMs = mins * 60_000;
  }

  /** Taze lisans jetonu çek. Ağ hatasında CACHED jeton KORUNUR (offline ≠ kilit). */
  async function refreshLicense() {
    if (!signedIn) return { ok: false, reason: 'not_signed_in' };
    const res = await authPkg.fetchLicenseToken({
      supabaseUrl,
      apiKey: anonKey,
      // SEC-01 — cihaz kimliği isteğe binen tek yer.
      device: deviceParam(),
      // SEC-W2-A2 — paket bütünlük raporu isteğe binen tek yer. Sağlayıcı
      // fonksiyon ENJEKTE edilir: seatGate paketin nerede durduğunu bilmez ve
      // bilmemelidir (test edilebilirlik + `node --test` altında Electron yok).
      // Sağlayıcı yoksa ya da atarsa rapor GÖNDERİLMEZ ve istek bugünküyle
      // bit-bit aynı olur — ölçemediğimiz bir şey yüzünden kimse kesilmez.
      integrity: integrityReport(),
      getAccessToken: sessionAccessToken,
    });
    if (res.ok) {
      if (typeof res.serverTime === 'number') {
        // Saat-oynatma defteri: monotonik sunucu zamanı (ADP-383).
        lastServerTime = authPkg.noteServerTime({ lastServerTime }, res.serverTime).lastServerTime;
      }
      licenseToken = res.token;
      // LIC-ENFORCE-01 — sunucu KONUŞTU: kararını jetonla birlikte diske yaz.
      // `undefined` = hüküm yok → eski damgaya DOKUNMA (bir doğrulama arızası
      // ne yeni kilit doğurmalı ne de var olan reddi silmeli).
      const verdict = revocationVerdict(res.token, res.serverTime);
      if (verdict !== undefined) {
        const was = revocation;
        revocation = verdict;
        if (revocation && (!was || was.at !== revocation.at)) {
          log(`seatGate: ⛔ sunucu erişimi KAPATTI (${revocation.reason}) — `
            + 'grace UYGULANMAZ, damga diske yazıldı');
        } else if (!revocation && was) {
          log('seatGate: erişim yeniden AÇILDI — kara-liste damgası düştü');
        }
      }
      await licenseStore.save({ token: licenseToken, lastServerTime, revocation });
      // Başarıda önceki ret TEMİZLENİR: kullanıcı cihaz çıkardıysa uyarı ekranda
      // ASILI KALMAMALI (çözülen bir sorunu göstermeye devam etmek güveni yer).
      applyDeviceInfo(res.device);
      // SEC-W2-A2 — sunucu jetonu TESLİM ETTİ: bütünlük reddi varsa DÜŞER.
      // Kullanıcı temiz kopyayı kurduğunda ekranda asılı kalan bir suçlama
      // bırakmak, çözülmüş bir sorunu göstermeye devam etmektir.
      if (integrityDenied) {
        integrityDenied = false;
        log('seatGate: bütünlük reddi DÜŞTÜ — paket yeniden doğrulandı');
      }
      // SEC-02 — koltuk ELİMİZDE: kirayı düzenli tazelemeye başla.
      startHeartbeat();
      log(`seatGate: lisans jetonu tazelendi (serverTime=${res.serverTime || '-'})`);
    } else if (DEVICE_DENIALS[res.reason]) {
      // SEC-01/02 — sunucu bir cihaz kadranı yüzünden reddetti. Elde ne varsa
      // KORUNUR: ret "yeni jeton yok" demektir, "şu an kilitlisin" demek DEĞİL.
      //
      // Hangi kadran olduğu VERİ olarak taşınır (`feature`): ekran cümleyi
      // planLimits'ten kurar ve doğru düğmeyi gösterir — kayıt reddinde "çıkar",
      // eşzamanlılık reddinde "bırak". Burada metin YAZILMAZ.
      deviceInfo = {
        denied: true,
        enforced: true,
        feature: DEVICE_DENIALS[res.reason],
        reason: res.reason,
        limit: res.limit,
        active: res.active,
        registered_limit: res.registeredLimit,
        registered_active: res.registeredActive,
        concurrent_limit: res.concurrentLimit,
        concurrent_active: res.concurrentActive,
        lease_minutes: res.leaseMinutes,
        tier: res.tier,
        devices: res.devices,
        actions: res.actions,
        serverMessage: res.message,
      };
      // Reddedilen cihazın kirası YOK → kalp atışının tazeleyeceği bir koltuk da
      // yok. Atışı durdurmak, reddi görmezden gelip sunucuyu 5 dakikada bir
      // aynı 403'e zorlamaktan iyidir.
      stopHeartbeat();
      log(`seatGate: CİHAZ REDDİ (${res.reason} katman=${res.tier} tavan=${res.limit} `
        + `aktif=${res.active}) — cached jeton korunuyor`);
    } else if (res.reason === 'integrity_mismatch') {
      // SEC-W2-A2 — SUNUCUNUN hükmü. Elde CACHED jeton varsa o korunur (72 saat
      // + grace): kurcalama anında kilit DEĞİLDİR ve uygulama KAPANMAZ. Kapanan
      // şey yeni jeton teslimidir; jeton dolduğunda bulut ve ücretli motorlar
      // kendiliğinden kapanır ve kullanıcı dürüst cümleyi görür.
      integrityDenied = true;
      stopHeartbeat();
      log('seatGate: BÜTÜNLÜK REDDİ — sunucu paketi tanımadı, yeni jeton yok '
        + `(build=${res.buildId || '-'}) — cached jeton korunuyor`);
    } else {
      log(`seatGate: jeton tazelenemedi (${res.reason}${res.status ? ' ' + res.status : ''}) — cached jeton korunuyor`);
    }
    evaluate();
    emitChange();
    return res;
  }

  /**
   * SEC-02 — KİRA KALP ATIŞI. Kirayı sunucu tarafında canlı tutar.
   *
   * NEDEN VAR: kira KISA (15 dk) çünkü çöken bir makinenin koltuğu saatlerce
   * asılı kalmamalı. Kısa kira, ancak açık kalan uygulama onu tazelerse çalışır
   * — yoksa 15 dakika sonra kullanıcının KENDİ açık uygulaması "ölü" sayılır ve
   * ikinci makinesi onu içeri alır (ölçüm de yanlış çıkar).
   *
   * NEDEN JETON DEĞİL: `device_action=heartbeat` jeton İMZALAMAZ. Beş dakikada
   * bir ES256 imzalatmak, hiçbir işe yaramayan bir maliyet olurdu.
   */
  function startHeartbeat() {
    if (heartbeatTimer || !device || !device.id) return;
    heartbeatTimer = setInterval(() => { void heartbeat(); }, heartbeatMs);
    // Uygulamanın çıkışını BEKLETME: zamanlayıcı event loop'u ayakta tutmasın.
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
    log(`seatGate: cihaz kirası kalp atışı başladı (${Math.round(heartbeatMs / 60000)}dk)`);
  }

  function stopHeartbeat() {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  /**
   * LIC-ENFORCE-01 — AÇIK OTURUMDA YETKİ DEĞİŞİMİNİ YAKALA (ölçülen açık).
   *
   * ÖLÇÜLDÜ (LIC-ENFORCE-01): kalp atışı YALNIZ cihaz kirasını tazeliyordu; jeton
   * imzalamadığı için ENTITLEMENT'a hiç bakmıyordu. Lisans tazelemesi ise yalnız
   * açılış/giriş/ödeme-dönüşü/"Durumu yenile" yollarında koşuyordu. Sonuç: iade
   * alan kullanıcı uygulamayı KAPATMADIĞI sürece — internet açıkken bile —
   * jetonun 72 saati (+grace) boyunca çalışmaya devam ediyordu. Eren'in
   * direktifi ("kesinlikle uygulamayı kullanamasın") tam da bunu kapatmayı ister.
   *
   * NEDEN 5 DAKİKADA BİR ES256 İMZALAMIYORUZ: gerek yok. Sunucu kalp atışının
   * cevabında zaten "bu hesapta erişim veren aktif bir ürün var mı"yı söylüyor
   * (`device.reason === 'no_tier'` ⇔ yetki YOK; aksi hâlde `device.tier` dolu).
   * Bu UCUZ sinyal ile ELİMİZDEKİ karar UYUŞMUYORSA — ve yalnız o zaman — pahalı
   * yolu (imzalı jeton) çağırırız. Kararı yine JETON verir: sunucunun kısa cevabı
   * bir KARAR DEĞİL, bir UYUŞMAZLIK SİNYALİDİR (ikinci bir gerçek kaynağı olmaz).
   *
   * KENDİ KENDİNİ SINIRLAR: tazeleme sonrası yerel karar sunucununkiyle hizalanır
   * → uyuşmazlık kalmaz → bir sonraki atış yeniden imza İSTEMEZ. Yani normal
   * kullanıcıda maliyeti SIFIR, değişim anında TEK ek çağrıdır.
   *
   * İKİ YÖN DE ÇALIŞIR (yalnız kilitlemek değil):
   *   * yetki gitti → kapı ~1 kalp atışı içinde kapanır (yeniden başlatma YOK)
   *   * yetki geldi → kullanıcı satın aldıktan sonra kapı kendiliğinden AÇILIR
   */
  async function reconcileEntitlement(info) {
    if (!info || typeof info !== 'object') return;
    // Sunucu "yetki yok" diyorsa reason='no_tier'; diyecek bir şeyi yoksa
    // (eski istemci / defter okunamadı) HÜKÜM ÇIKARMAYIZ — sessiz geçeriz.
    const serverSaysNone = info.reason === 'no_tier';
    const serverSaysSome = typeof info.tier === 'string' && !!info.tier;
    if (!serverSaysNone && !serverSaysSome) return;
    const localSeat = !!(snapshot && snapshot.seat);
    if (serverSaysNone === !localSeat) return; // uyuşuyor → pahalı yola GEREK YOK
    log(`seatGate: kalp atışı YETKİ UYUŞMAZLIĞI gördü (sunucu=${serverSaysNone ? 'yok' : (info.tier || 'var')} `
      + `yerel=${localSeat ? 'var' : 'yok'}) — imzalı jeton isteniyor`);
    await refreshLicense().catch((e) => log(`seatGate: uyuşmazlık tazelemesi hata (${e.message})`));
  }

  /**
   * Tek bir kalp atışı. Sunucu bu atışta REDDEDERSE (başka cihaz koltuğu almış,
   * paket düşmüş) durum snapshot'a yazılır — sessiz geçmez. Ağ hatası ise
   * yalnız loglanır: geçici bir kopukluk kullanıcıyı kilitlememeli.
   */
  async function heartbeat() {
    if (!signedIn || !device || !device.id) return { ok: false, reason: 'no_device' };
    const res = await authPkg.fetchLicenseToken({
      supabaseUrl,
      apiKey: anonKey,
      action: 'heartbeat',
      device: deviceParam(),
      getAccessToken: sessionAccessToken,
    }).catch((e) => ({ ok: false, reason: 'heartbeat_error', detail: e.message }));
    if (res.ok) {
      applyDeviceInfo(res.device);
      // `evaluate()` ŞART: snapshot'ı kuran tek yer orası. Yalnız emitChange
      // deseydik dinleyiciye ESKİ snapshot giderdi (sayaç ekranda donardı).
      evaluate();
      emitChange();
      // LIC-ENFORCE-01 — YETKİ UYUŞMAZLIĞINI BURADA YAKALA (ölçülen açık).
      await reconcileEntitlement(res.device);
      return res;
    }
    if (DEVICE_DENIALS[res.reason]) {
      // Kirayı kaybettik (başka cihaz aldı). Elde geçerli jeton varsa kullanıcı
      // ÇALIŞMAYA DEVAM eder — bu ret bir sonraki jeton tazelemesinde bağlar.
      log(`seatGate: kalp atışı reddedildi (${res.reason}) — koltuk başka cihazda`);
      stopHeartbeat();
      await refreshLicense().catch(() => {});
      return res;
    }
    log(`seatGate: kalp atışı başarısız (${res.reason}) — kira eskiyor, kilit YOK`);
    return res;
  }

  /**
   * SEC-02 — TEMİZ ÇIKIŞ. Uygulama kapanırken koltuğu BIRAK.
   *
   * Bu tek satır, "başka cihazda açıksın" şikâyetlerinin çoğunu doğmadan
   * öldürür: normal kapanışta koltuk 15 dakika değil ANINDA serbest kalır.
   * Cihaz hesaptan ÇIKARILMAZ — yalnız kira biter.
   *
   * Zaman aşımı ŞART: kapanış yolunda ağ bekleyen bir çağrı uygulamayı asar.
   * Bırakamazsak kayıp küçüktür (kira zaten dolacak), asılı kalan uygulama ise
   * kullanıcının gördüğü en kötü hatadır.
   */
  async function releaseDeviceLease({ timeoutMs = 1500 } = {}) {
    stopHeartbeat();
    if (!signedIn || !device || !device.id) return { ok: false, reason: 'no_device' };
    const call = authPkg.fetchLicenseToken({
      supabaseUrl,
      apiKey: anonKey,
      action: 'release',
      device: deviceParam(),
      getAccessToken: sessionAccessToken,
    }).catch((e) => ({ ok: false, reason: 'release_error', detail: e.message }));
    const res = await Promise.race([
      call,
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, reason: 'release_timeout' }), timeoutMs)),
    ]);
    log(`seatGate: cihaz kirası bırakıldı (${res.ok ? 'tamam' : res.reason})`);
    return res;
  }

  /**
   * SEC-02 — "DİĞER CİHAZLARI BIRAK" (yanlış pozitifin insan tarafındaki kaçışı).
   *
   * Uyuyan/çöken makine kirayı bırakamaz; kullanıcı 15 dakika beklemek zorunda
   * kalmasın diye kirayı KENDİSİ düşürür. Cihazlar hesapta KAYITLI KALIR
   * (`revokeDevice` ayrı ve kalıcı bir eylemdir) — kullanıcı "koltuğu bırak"
   * derken makinesini hesabından silmek istemez.
   *
   * Başarıda lisans TAZELENİR: beklenti "bıraktım, artık çalışayım"dır; bunu bir
   * sonraki otomatik tazelemeye bırakmak reddi çözülmemiş gibi gösterirdi.
   */
  async function releaseOtherDevices() {
    if (!signedIn) return { ok: false, reason: 'not_signed_in' };
    if (!device || !device.id) return { ok: false, reason: 'no_device_id' };
    const res = await authPkg.fetchLicenseToken({
      supabaseUrl,
      apiKey: anonKey,
      action: 'release_others',
      device: deviceParam(),
      getAccessToken: sessionAccessToken,
    }).catch((e) => ({ ok: false, reason: 'release_error', detail: e.message }));
    if (!res.ok) {
      log(`seatGate: diğer cihazlar bırakılamadı (${res.reason})`);
      return res;
    }
    log(`seatGate: diğer cihazların kirası bırakıldı (${res.released} cihaz)`);
    await refreshLicense();
    return { ok: true, released: res.released, device: deviceInfo };
  }

  /** Açılış: depodan oturum + jeton yükle; çevrimiçiyse ARKADA tazele (açılışı bekletme). */
  async function init() {
    const doc = await sessionStore.load().catch(() => null);
    if (doc && doc.session) {
      signedIn = true;
      email = (doc.session.user && doc.session.user.email) || null;
      userId = (doc.session.user && doc.session.user.id) || null;
    }
    const lic = await licenseStore.load().catch(() => null);
    if (lic && typeof lic.token === 'string') {
      licenseToken = lic.token;
      lastServerTime = typeof lic.lastServerTime === 'number' ? lic.lastServerTime : null;
    }
    // LIC-ENFORCE-01 — damga jetonla AYNI blob'da yaşar (safeStorage ile şifreli).
    // Açılış çevrimdışı olsa bile sunucunun son sözü burada hazır bekler.
    revocation = (lic && authPkg.normalizeRevocationStamp)
      ? authPkg.normalizeRevocationStamp(lic.revocation) : null;
    evaluate();
    // ADP-943 — "signedIn=false" TEK BAŞINA teşhis DEĞİL: kullanıcı hiç girmemiş de
    // olabilir, oturumu diskte DURUYOR ama OS anahtarı değiştiği için çözülemiyor da
    // olabilir. İkincisi Windows'ta sonsuz giriş döngüsünün ta kendisi ve eskiden
    // tek bir satır bile üretmiyordu. Sebebi burada AÇIKÇA yazıyoruz.
    const blob = typeof sessionStore.lastLoadOutcome === 'function'
      ? sessionStore.lastLoadOutcome() : { state: 'unknown' };
    log(`seatGate init: signedIn=${signedIn} sessionBlob=${blob.state} license=${snapshot.licenseStatus} revoked=${revocation ? revocation.reason : '-'} seat=${snapshot.seat} tier=${snapshot.tier || '-'} requireSeat=${requireSeat} requireLogin=${requireLogin} access=${snapshot.accessAllowed}`);
    if (!signedIn && blob.state && blob.state !== 'absent' && blob.state !== 'ok') {
      log('⛔ seatGate: giriş ekranı gösterilecek ama bu "çıkış yapılmış" DEĞİL — '
        + `oturum blob'u okunamadı/çözülemedi (${blob.state}). Aynı sebep her açılışta `
        + 'tekrar ederse giriş döngüsü budur (ADP-943).');
    }
    // Disk'ten yüklenen durumu HEMEN push'la: renderer gate'i ilk `crewpane:get`
    // çağrısını init'in disk okumasından ÖNCE yapmış olabilir (yarış) — bu push
    // olmadan oturumlu kullanıcı ağ tazelemesi bitene dek gate arkasında kalırdı.
    emitChange();
    if (signedIn) {
      refreshLicense().catch((e) => log(`seatGate init refresh error: ${e.message}`));
    }
    return snapshot;
  }

  /** Ayarlar "CrewPane ile giriş" → SİSTEM TARAYICISI (gömülü webview YASAK). */
  async function signIn() {
    const res = await auth.signIn();
    log(`seatGate: signIn başlatıldı (state=${res.state.slice(0, 8)}…)`);
    return res;
  }

  /** E-posta magic-link (e2e + tarayıcısız akış). */
  async function signInWithEmail(addr) {
    return auth.signInWithEmail(addr);
  }

  /**
   * C-07 — bu URL success sayfasının "Uygulamaya dön" ödeme dönüşü mü?
   * (<scheme>://billing/updated?plan=… — billing.cjs isBillingReturnUrl ile aynı
   * sözleşme; burada yerel, çünkü seatGate billing client tutmaz.)
   * Şema kıyası ADP-954 gereği harf-duyarsızdır; custom (non-special) şemalarda
   * Node URL host'u lowercase ETMEZ, o yüzden host da harf-duyarsız kıyaslanır.
   */
  function isBillingReturnUrl(url) {
    if (typeof url !== 'string' || !url) return false;
    let u;
    try { u = new URL(url); } catch { return false; }
    return u.protocol === `${scheme}:` && u.host.toLowerCase() === 'billing';
  }

  /**
   * C-07 — JETON TAZELEME ÇENGELİ (ödeme dönüşü). C-02'nin ölçtüğü bug: bu URL
   * auth.handleCallback'e düşüyor, host `billing` ≠ `auth` → wrong_redirect →
   * kullanıcı "Durumu yenile"ye basmadan paket tanınmıyordu.
   *
   * Sunucu webhook işledikten sonra <120 ms hazır (C-02 ölçümü); tek değişken
   * Stripe'ın webhook teslimi (tipik 1-5 sn). Kullanıcı success sayfasından
   * webhook'tan ÖNCE dönebilir — retry bunun için: paket görünene kadar
   * aralıklı tazele, görünmezse pes et ("Durumu yenile" yolu aynen durur).
   *
   * refreshLicense BİLEREK kullanılıyor (billing.cjs handleBillingReturn değil):
   * jetonu depoya yazan, cihaz kimliğini isteğe bindiren (SEC-01), snapshot'ı
   * yeniden hesaplayıp renderer'a push'layan tek yol bu — paket "tanındı"
   * demek bu üçünün olması demek.
   */
  async function handleBillingReturn(url, opts) {
    if (!isBillingReturnUrl(url)) return { ok: false, reason: 'not_billing_url' };
    if (!signedIn) {
      // Oturumsuz dönüş: tazelenecek hesap yok. Durum yine push'lanır ki
      // renderer bayat bir ekranda kalmasın.
      log('seatGate: billing dönüşü geldi ama oturum yok — tazeleme atlandı');
      evaluate();
      emitChange();
      return { ok: false, reason: 'not_signed_in' };
    }
    const attempts = Math.max(1, (opts && opts.attempts) || 5);
    const delayMs = (opts && opts.delayMs) || 2000;
    // "Tanındı" kıyası satın alma ÖNCESİNE göre: hiç paketi olmayana seat'in
    // gelmesi de, mevcut paketlinin katman değişimi de (pro→ultra) sayılır.
    const beforeSeat = !!(snapshot && snapshot.seat);
    const beforeTier = (snapshot && snapshot.tier) || null;
    log(`seatGate: billing dönüşü — lisans tazeleniyor (en çok ${attempts} deneme, aralık ${delayMs}ms)`);
    for (let i = 1; i <= attempts; i++) {
      if (i > 1) await new Promise((r) => setTimeout(r, delayMs));
      await refreshLicense().catch((e) => log(`seatGate billing refresh error: ${e.message}`));
      const s = snapshot || {};
      if (s.seat && (!beforeSeat || s.tier !== beforeTier)) {
        log(`seatGate: billing dönüşü TAMAM — paket tanındı (katman=${s.tier || 'seat'}, deneme ${i}/${attempts})`);
        return { ok: true, seat: true, tier: s.tier || null, attempts: i };
      }
    }
    const s = snapshot || {};
    if (s.seat) {
      // Aynı katmanın yenilenmesi: değişim görünmez ama jeton tazelendi ve
      // kapı zaten açık — bu bir hata değil.
      log(`seatGate: billing dönüşü — katman değişimi görünmedi ama paket aktif (katman=${s.tier || 'seat'})`);
      return { ok: true, seat: true, tier: s.tier || null, attempts, changed: false };
    }
    log(`seatGate: billing dönüşü — paket ${attempts} denemede görünmedi (webhook gecikmiş olabilir); `
      + '"Durumu yenile" çalışmaya devam eder');
    return { ok: false, reason: 'entitlement_not_ready', attempts };
  }

  /** crewpane://auth/callback?code&state — open-url / second-instance'tan gelir. */
  async function handleUrl(url) {
    // C-07 — ödeme dönüşü auth callback DEĞİL; handleCallback'e düşerse
    // wrong_redirect yer (C-02 runtime kanıtı). Önce burada ayrılır.
    if (isBillingReturnUrl(url)) return handleBillingReturn(url);
    const res = await auth.handleCallback(url);
    if (res.ok) {
      signedIn = true;
      email = (res.session.user && res.session.user.email) || null;
      userId = (res.session.user && res.session.user.id) || null;
      log(`seatGate: giriş TAMAM (${email || userId || '?'})`);
      await refreshLicense(); // hesap bağlanır bağlanmaz seat durumunu göster
    } else {
      log(`seatGate: callback reddedildi (${res.reason})`);
      evaluate();
      emitChange();
    }
    return res;
  }

  /** Çıkış: sunucuda revoke (best-effort) + yerel oturum & jeton HER DURUMDA silinir. */
  async function signOut() {
    // SEC-02 — çıkış da TEMİZ ÇIKIŞTIR: koltuğu bırak (oturum silinmeden ÖNCE,
    // çünkü bırakma isteği o oturumun jetonuyla imzalanır). Başarısız olması
    // çıkışı ENGELLEMEZ — kira zaten kendiliğinden dolar.
    await releaseDeviceLease().catch(() => {});
    const res = await auth.signOut().catch((e) => {
      log(`seatGate signOut error: ${e.message}`);
      return { ok: true, revoked: false };
    });
    await licenseStore.clear().catch(() => {});
    signedIn = false;
    email = null;
    userId = null;
    licenseToken = null;
    lastServerTime = null;
    // LIC-ENFORCE-01 — damga HESABA aittir; hesap gidince damga da gider. Kaçış
    // yolu DEĞİL: aynı hesapla tekrar girildiğinde ilk jeton isteği reddi geri
    // getirir (sunucu tek gerçek kaynak), oturumsuzken zaten kapı kapalıdır.
    revocation = null;
    deviceInfo = null; // SEC-01 — çıkışta cihaz uyarısı da gider (hesap yok, ret yok)
    evaluate();
    emitChange();
    log('seatGate: çıkış yapıldı (oturum + lisans jetonu silindi)');
    return res;
  }

  /**
   * SEC-01 — hesaba bağlı cihazlar. `deviceId` alanı BU kurulumun kimliğiyle
   * karşılaştırılabilsin diye ayrıca döner: kullanıcı listede "bu cihaz" olanı
   * ayırt edemezse yanlışlıkla oturduğu makineyi çıkarır.
   */
  async function listDevices() {
    const tok = await accessToken();
    if (!tok.ok) return { ok: false, reason: tok.reason };
    const res = await authPkg.listDevices({
      supabaseUrl, apiKey: anonKey, getAccessToken: async () => tok.token,
    });
    if (!res.ok) return res;
    return { ok: true, devices: res.devices, currentDeviceId: device ? device.id : null };
  }

  /**
   * SEC-01 — cihazı hesaptan çıkar. Başarıda lisans TAZELENİR: kullanıcının
   * beklentisi "çıkardım, artık çalışayım"dır; onu bir sonraki otomatik
   * tazelemeye (saatler sonra) bırakmak reddi çözülmemiş gibi gösterirdi.
   */
  async function revokeDevice(deviceId) {
    const tok = await accessToken();
    if (!tok.ok) return { ok: false, reason: tok.reason };
    const res = await authPkg.revokeDevice({
      supabaseUrl, apiKey: anonKey, deviceId: String(deviceId || ''),
      getAccessToken: async () => tok.token,
    });
    if (!res.ok) return res;
    log(`seatGate: cihaz çıkarıldı (${deviceId})`);
    await refreshLicense();
    return res;
  }

  return {
    init,
    evaluate,
    state,
    listDevices,
    revokeDevice,
    // SEC-02 — kira yüzeyi (koltuk bırakma; cihazı hesaptan ÇIKARMAZ)
    releaseDeviceLease,
    releaseOtherDevices,
    heartbeat,
    stopHeartbeat,
    signIn,
    signInWithEmail,
    handleUrl,
    // C-07 — ödeme dönüşü çengeli (testler ve olası çağıranlar için dışa açık;
    // normal akışta handleUrl kendisi yönlendirir).
    isBillingReturnUrl,
    handleBillingReturn,
    signOut,
    refreshLicense,
    accessToken, // ADP-622 — app DB kimliği (JWT); sır MAIN'de kalır, çağıranlar bunu ister
    requireSeat: requireSeatFor,
    /** e2e dikişi (main yalnız test instance'ında dışarı açar): jeton tohumla. */
    async _seedLicense(token, serverTime, stamp) {
      licenseToken = token;
      lastServerTime = typeof serverTime === 'number' ? serverTime : lastServerTime;
      // LIC-ENFORCE-01 — `stamp` verilmezse mevcut damga KORUNUR (undefined ≠ null).
      if (stamp !== undefined) revocation = authPkg.normalizeRevocationStamp(stamp);
      await licenseStore.save({ token, lastServerTime, revocation });
      evaluate();
      emitChange();
      return snapshot;
    },
  };
}

module.exports = { createSeatGate, decideAccess, readPastDue, readCancelEnding, SEAT_PRODUCT };
