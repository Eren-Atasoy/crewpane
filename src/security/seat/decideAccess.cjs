// CrewPane — Seat Gate Access Decision Engine.
'use strict';

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

module.exports = {
  decideAccess,
};
