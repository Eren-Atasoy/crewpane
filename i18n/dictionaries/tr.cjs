// ADP-888 (ADP-885 Faz A) — ANA SÜREÇ Türkçe sözlüğü.
//
// Metinler electron/main.js'teki cümlelerin BİREBİR kendisidir (regresyon-koru).
// Anahtar paritesi kapı ile korunur: eksik/fazla anahtar → npm run check:i18n KIRMIZI
// (renderer tarafında aynı işi TS yapar; CJS'te tip yok, o yüzden kapı bakar).

'use strict';

module.exports = {
  'main.dialog.openFolder.title': 'Klasör Aç',
  'main.dialog.chooseWorkspace.title': 'Çalışma Alanı Seç',
  'main.dialog.chooseWorkspace.button': 'Bu Klasörü Kullan',
  'main.dialog.switchWorkspace.title': 'Çalışma Alanını Değiştir',

  'main.notify.crashLoop.title': 'CrewPane tekrar tekrar çöktü',
  'main.notify.crashLoop.body':
    'Pencere otomatik kurtarma denemesini bitirdi. Uygulamayı yeniden başlat — ajanlar arka planda çalışmaya devam ediyor.',
  'main.notify.screenshotsMoved.title': 'Ekran görüntüleri artık AgentShot\'ta',
  'main.notify.screenshotsMoved.body':
    '⌘⇧2 ve galeri AgentShot uygulamasına taşındı; eski kayıtların AgentShot galerisinde.',


  // HATA-03 — tek-örnek kilidi ikinci kopya diyalogu.
  'main.singleInstance.title': 'CrewPane zaten açık',
  // WIN-DUP-INSTANCE-01 — metin DÜRÜST: "öne aldık" demiyor (öne alma "Kapat"la
  // olur) ve "pencere yoksa Yine de aç'ı seç" DEMİYOR. Eski cümle, pencere kapalı
  // ama süreç canlıyken (Windows'ta X'in normal sonucu, HATA-14) kullanıcıyı her
  // seferinde ikinci bir kopya açmaya YÖNLENDİRİYORDU (FB-1012: 7 kopya).
  'main.singleInstance.message': 'CrewPane zaten çalışıyor — bu ikinci kopya açılmadı.',
  'main.singleInstance.detail':
    'Aynı veri klasörünü iki uygulama birden kullanamaz.{who}\n'
    + '"Kapat"a bastığında açık olan CrewPane öne gelir; penceresi kapalıysa yeniden açılır.\n\n'
    + '"Yine de aç" iki kopyayı aynı anda çalıştırır: oturumun düşebilir, telefon bağlantın ve '
    + 'ajan görevlerin iki kopya arasında bölünür. Yalnızca hiçbir CrewPane açık olmadığından eminsen seç.',
  'main.singleInstance.button.close': 'Kapat',
  'main.singleInstance.button.openAnyway': 'Yine de aç',
  // WIN-DUP-INSTANCE-01 — "Yine de aç" AÇIK ONAY ister: ikinci kutu, varsayılan "Vazgeç".
  'main.singleInstance.confirm.title': 'İki CrewPane aynı anda çalışacak',
  'main.singleInstance.confirm.message': 'Açık olan CrewPane kapanmadan bu kopyayı açmak istediğine emin misin?',
  'main.singleInstance.confirm.detail':
    'İki kopya aynı anda çalışırsa oturumun düşebilir, telefon bağlantın kopabilir ve ajan görevlerin '
    + 'iki kopya arasında bölünür.\n\nÖnce "Vazgeç"i seçip açık olan CrewPane\'i kapatmayı dene.',
  'main.singleInstance.confirm.button.cancel': 'Vazgeç',
  'main.singleInstance.confirm.button.yes': 'Evet, yine de aç',
  // WIN-DUP-INSTANCE-01 — koruma KURULAMADIYSA (veri klasörüne yazılamıyor) açılış
  // artık sessiz değil: kullanıcı açıkça onaylar.
  'main.singleInstance.degraded.title': 'Tek kopya koruması kurulamadı',
  'main.singleInstance.degraded.message': 'CrewPane, ikinci bir kopyanın aynı anda açılmasını önleyen korumayı kuramadı.',
  'main.singleInstance.degraded.detail':
    'Veri klasörüne yazılamıyor olabilir (salt okunur ya da izin sorunu).\n'
    + 'Başka bir CrewPane açıksa iki kopya birbirinin verisini bozabilir.\n\n'
    + 'Hiçbir CrewPane açık olmadığından eminsen "Yine de aç"ı seç; emin değilsen "Kapat".',
  // ENV-08 — üçüncü düğme: ikinci kopya sahibin veri köküne dokunmadan
  // --instance=test ile ayrı dünyada yeniden başlar.
  'main.singleInstance.button.separateProfile': 'Ayrı test profiliyle aç',

  // ENV-08 (d) — geçici konum (AppTranslocation / DMG) uyarısı.
  'main.translocation.title': 'CrewPane geçici bir konumdan çalışıyor',
  'main.translocation.message': 'Uygulama DMG içinden ya da macOS\'un geçici kopyasından (AppTranslocation) açıldı.',
  'main.translocation.detail':
    'Bu konum kalıcı değildir; güncellemeler ve veri bu yoldan güvenilir çalışmaz.\n\n'
    + 'CrewPane\'i Uygulamalar klasörüne taşıyıp oradan aç. Bu kopyayı yalnızca test '
    + 'için açtıysan "Ayrı test profiliyle yeniden başlat"ı seç — gerçek verine dokunmaz.',
  'main.translocation.button.ok': 'Anladım',
  'main.translocation.button.separateProfile': 'Ayrı test profiliyle yeniden başlat',

  'main.error.seatNotReady': 'Lisans doğrulaması henüz hazır değil — birkaç saniye sonra tekrar dene.',
  // WIN-DUP-INSTANCE-01 (FB-1012) — telefon sihirbazı: bağlantı noktası doluysa sebep
  // SÖYLENİR (iç mekanizma yok: port numarası, hata kodu yazılmaz).
  'main.mobile.portInUse': 'Bilgisayarda başka bir CrewPane açık ve bağlantı noktasını tutuyor — onu kapatıp tekrar dene.',
  'main.mobile.startFailed': 'Telefon bağlantısı başlatılamadı — uygulamayı yeniden başlatıp tekrar dene.',

  // RESET-03 — komut satırından sıfırlama (--reset) ve açılış uyarısı.
  // MAIN'in KENDİ gösterdiği kutular; uygulama içi diyalog RESET-02'nin sözlüğünde.
  // Metinde dosya adı / klasör yolu / hata kodu GEÇMEZ ([[feedback_ui_copy_no_internals]]).
  'main.reset.badLevel.title': 'Sıfırlama komutu anlaşılmadı',
  'main.reset.badLevel.detail': 'Geçerli kullanım: --reset (tümü) ya da --reset=session (yalnız oturum). Hiçbir şey silinmedi.',
  'main.reset.locked.title': 'CrewPane açık',
  'main.reset.locked.message': 'Sıfırlama için CrewPane\'in kapalı olması gerekiyor.',
  'main.reset.locked.detail': 'Açık olan CrewPane penceresini kapat, sonra bu komutu tekrar çalıştır.',
  'main.reset.confirm.title': 'Kurulumu sıfırla',
  'main.reset.confirm.message': 'Bu bilgisayardaki ofis, ajanlar, hafıza, kayıtlı anahtarlar ve oturum silinecek.',
  'main.reset.confirm.detail':
    'Hesabın ve paketin CrewPane\'da kalır; Claude/Codex gibi araçların kendi girişlerine '
    + 've proje klasörlerine dokunulmaz.\n\nBu işlem geri alınamaz.',
  'main.reset.confirm.button.yes': 'Evet, sıfırla',
  'main.reset.confirm.button.cancel': 'Vazgeç',
  'main.reset.session.message': 'Bu bilgisayardaki oturum silinecek; ofis, ajanlar ve hafıza kalır.',
  'main.reset.partial.title': 'Sıfırlama tamamlanamadı',
  'main.reset.partial.message': 'Bazı dosyalar silinemedi.',
  'main.reset.partial.detail':
    'CrewPane\'i kapatıp tekrar aç — kalan dosyalar bir sonraki açılışta silinecek.',
  'main.reset.partial.button.ok': 'Tamam',

  // WIN-FIRSTRUN-01 (K1) — Windows'ta motorun kabuk ön koşulu: rehber pane banner'ı.
  // Pane'e ham metin basılır (kaplama kapatılsa/pop-out edilse de kalır). İç mekanizma
  // GEÇMEZ ([[feedback_ui_copy_no_internals]]): yalnız ne olduğu, ne yapılacağı, nereden.
  'main.pane.shellMissing.title': '{label} bu bilgisayarda başlatılamadı',
  'main.pane.shellMissing.body':
    '{label} Windows\'ta çalışmak için Git for Windows ister; bu bilgisayarda bulunamadı. '
    + 'Aşağıdaki adresten kurun (varsayılan ayarlar yeterli):',
  'main.pane.shellMissing.after': 'Kurulum bitince bu pencerede "Tekrar dene" düğmesine basın.',

  // ENG-OPENCODE-PROVIDER-01 — model ön-doğrulama kapısı: motor HİÇ başlatılmadı, pane'e
  // ne olduğu ve ne yapılacağı basılır. Neden sert: yanlış model adı, kodu sessizce
  // BAŞKA bir (bulut) sağlayıcıya gönderir (ölçüldü). Sır/adres kimlik bilgisi GEÇMEZ.
  'main.pane.modelGate.title': '{model} ile ajan başlatılmadı',
  'main.pane.modelGate.notListed':
    "'{model}' bu bilgisayardaki {label} model listesinde yok. Terminalde `opencode models` çıktısını kontrol edin; "
    + 'yanlış yazılmış bir ad, kodunuzu sessizce başka bir sağlayıcıya gönderebilir — bu yüzden ajan açılmadı.',
  'main.pane.modelGate.internetHttp':
    "'{model}' sağlayıcısı şifresiz bir internet adresine bağlı (http://{host}). Kod ve istemler düz metin olarak giderdi; "
    + 'CrewPane bunu kabul etmiyor. Adresi https:// yapın ya da sunucuyu kendi ağınıza alın.',
  'main.pane.modelGate.lanHttpNeedsAck':
    "'{model}' sağlayıcısı yerel ağınızda şifresiz bir adrese bağlı (http://{host}). Bu sunucu kendi ağınızdaysa ve şifresiz bağlantıyı "
    + 'kabul ediyorsanız CrewPane ayarlarında `{setting}` değerini true yapın. Unutmayın: ortak Wi-Fi\'da kod düz metin gider.',
  'main.pane.modelGate.unreachable':
    "'{model}' sağlayıcısının adresi {timeout} saniye içinde cevap vermedi: {url} ({error}). Motor bu durumda dakikalarca sessizce "
    + 'yeniden deneyecekti; bu yüzden ajan açılmadı. Sunucunun açık ve ağdan erişilebilir olduğunu kontrol edin.',
  'main.pane.modelGate.invalidUrl':
    "'{model}' sağlayıcısının adresi geçersiz ({url}). opencode.json içindeki baseURL satırını düzeltin.",
  'main.pane.modelGate.guide': 'Kendi modelinizi bağlama rehberi: {guide}',
  'main.pane.modelGate.after': 'Düzelttikten sonra ajanı yeniden başlatın.',

  // WIN-FIRSTRUN-01 (K2) — açılışta ölen motorun pane'ine yazılan kapanış satırı.
  'main.pane.earlyExit.line': 'Motor açılışta kapandı — yukarıdaki satırlar motorun son söyledikleri.',
  'main.pane.earlyExit.silent': 'Motor açılışta hiçbir şey yazmadan kapandı.',

  // ENG-OPENCODE-DB-01 (C4) — aynı çalışanın ikinci penceresi kendi veritabanıyla açıldı;
  // iç mekanizma (dosya yolu/env adı) GEÇMEZ, yalnız ne olduğu.
  'main.pane.isolationTwin.line': 'Bu çalışanın başka bir penceresi zaten açık — bu pencere ayrı bir veritabanıyla açıldı; önceki konuşma diğer pencerede.',

  // ASK-CARD-01 — liderin karar sorusu Agent X onay kartına aynalanır (masaüstü + telefon).
  'main.ask.title': '{agent} kararını bekliyor',
};
