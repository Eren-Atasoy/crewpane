// OBS-01 — ÜRÜN ANALİTİĞİ: OLAY ŞEMASI (kapalı kayıt defteri).
//
// ─── BU DOSYA NEDEN GİZLİLİĞİN KENDİSİ ───────────────────────────────────────
// OBS-02'de hata takibi için verdiğimiz söz şuydu: "olay gövdesi SIFIRDAN, alan
// alan kurulur; sızıntı unutulmuş bir filtreyle değil, ancak BİLEREK alan
// eklenerek olabilir." Analitik AYNI sözleşmeye tabi (görev kuralı 3) — ama bir
// derece DAHA SERTİ mümkün, çünkü analitikte hata mesajı gibi kaçınılmaz bir
// serbest-metin alanı YOKTUR.
//
// Bu yüzden kural şudur:
//
//   🔴 ANALİTİK OLAYINDA SERBEST METİN ALANI YOKTUR. HİÇ.
//
// Süzgeç (`scrub.cjs`) burada İKİNCİ savunma katmanıdır, birinci değil. Birinci
// katman TÜR SİSTEMİDİR: her özellik anahtarının bir ALAN TANIMI (`domain`) vardır
// ve tanım yalnız dört şeyden biri olabilir:
//
//   enum  — değer ÖNCEDEN YAZILMIŞ bir listede olmak zorunda (kapalı küme)
//   int   — sonlu tamsayı, sınırlanır
//   bool  — true/false
//   token — `^[a-z0-9_.:+-]{1,40}$` (yalnız sürüm/os_release gibi makine damgaları)
//
// Beşinci bir tür (`text`, `string`, `free`) YOKTUR ve eklenmesi bu dosyada
// bilinçli bir karar gerektirir. Sonuç: bir prompt metni, dosya yolu, müşteri adı
// ya da API anahtarı bu şemadan GEÇEMEZ — 40 karakteri aşar, boşluk/eğik çizgi/@
// içerir ya da enum listesinde yoktur. "Unutulan bir maskeleme" diye bir senaryo
// kalmaz; unutulacak bir şey yoktur.
//
// Bilinmeyen bir OLAY ADI reddedilir (sayılır). Bilinmeyen bir ÖZELLİK ANAHTARI
// düşürülür (sayılır) — yani yeni bir ölçüm noktası eklemek isteyen kod, önce
// BURAYA satır yazmak zorundadır. Şemasız ölçüm sessizce çalışmaz.
//
// Saf + bağımsız (hiç require yok) → `node --test` altında doğrudan koşar. Site
// eşleniği: crewpane-com `src/lib/analytics/schema.ts` (aynı küme, aynı kurallar).

'use strict';

/** Makine damgası biçimi — sürüm ("0.2.32-dev.1"), os_release ("23.6.0"). */
const TOKEN_RE = /^[a-z0-9_.:+-]{1,40}$/i;

/** Alan tanımı kurucuları — ŞEMA YAZARININ kullanabileceği TEK dört tür. */
const D = {
  enum: (...values) => ({ kind: 'enum', values: Object.freeze(values.slice()) }),
  int: (max = 1e9) => ({ kind: 'int', max }),
  bool: () => ({ kind: 'bool' }),
  token: () => ({ kind: 'token' }),
};

// ─── ORTAK DAMGA (her olayda, istisnasız) ────────────────────────────────────
// OBS-02'nin `baseTags`'i ile AYNI bilgi: "hangi sürüm, hangi platform, hangi
// kanal". Hata ile kullanım aynı damgayı taşımazsa "0.2.32'de kaç kişi çarptı"
// sorusu iki panoda iki farklı cevap verirdi.
const BASE = Object.freeze({
  app: D.enum('crewpane', 'crewpane-com'),
  channel: D.enum('prod', 'dev', 'test'),
  app_version: D.token(),
  platform: D.enum('darwin', 'win32', 'linux', 'browser', 'other'),
  arch: D.enum('arm64', 'x64', 'web', 'other'),
  os_release: D.token(),
  /**
   * PLAN KATMANI — ortak damgada, çünkü görevin asıl sorusu bu:
   * "hangi limite çarpan kaç kişi Pro'ya geçti". Katman ayrı bir olay olarak
   * değil HER olayın üstünde taşınırsa, bir kullanıcının basic→pro geçişi
   * panoda kendiliğinden bir zaman çizgisi olur — ikinci bir "yükseltme olayı"
   * icat etmeye gerek kalmaz (görev kuralı: yeni ölçüm noktası icat etme).
   */
  tier: D.enum('basic', 'pro', 'ultra', 'none'),
  locale: D.enum('tr', 'en', 'other'),
});

/**
 * WIN-FIRSTRUN-01 (K5) — MOTOR KİMLİĞİ ALANI (kapalı küme). Liste engineRegistry'nin
 * defteriyle AYNI olmak zorunda; bu dosya bağımsız (require yok) kaldığı için küme
 * burada YAZILIR ve `analyticsSchema.test.cjs` defterle eşitliğini ölçer. `none` =
 * ajan olmayan pane (düz kabuk), `other` = defterde olmayan komut.
 */
const ENGINE_IDS = Object.freeze([
  'claude', 'codex', 'copilot', 'goose', 'droid', 'gemini', 'qwen', 'opencode', 'amp',
  'cursor', 'kimi', 'crush', 'antigravity', 'muse',
]);
const ENGINE = D.enum(...ENGINE_IDS, 'other', 'none');

// ─── UYGULAMA (CrewPane) OLAYLARI ──────────────────────────────────────────
//
// AKTİVASYON HUNİSİ (görevin en değerli ölçümü) üç olaydan oluşur ve ÜÇÜ DE
// MEVCUT SAYAÇ MUSLUĞUNDAN (`telemetryBump`) beslenir — yeni ölçüm noktası
// eklenmedi:
//     app_opened  →  agent_spawned  →  delegation_started
// `first_time` özelliği o kurulumda İLK KEZ olduğunu söyler; huni panoda hem
// kişi-bazlı (PostHog funnel) hem tek sayımla (first_time=true adedi) okunur.
const APP_EVENTS = Object.freeze({
  /** Uygulama açıldı. `first_run` = bu kurulumun İLK açılışı. */
  app_opened: Object.freeze({ first_run: D.bool() }),

  /**
   * Bir pane açıldı (ajan bağlı olmayabilir) — `telemetryBump('panes_opened')`.
   *
   * WIN-FIRSTRUN-01 (K5) — `engine`: KAPALI KÜME (aşağıdaki ENGINE alanı). Bugüne
   * kadar "hangi motor" bilgisi gitmiyordu; RESEARCH-WIN-01'de Windows müşterisinin
   * hangi motorla 35 kez öldüğü yalnız Sentry yarışından çıkarılabildi. Motor kimliği
   * bir ürün sabiti (claude/codex/…) — prompt değil, yol değil, kullanıcı verisi değil.
   */
  pane_opened: Object.freeze({ first_time: D.bool(), engine: ENGINE }),

  /** Bir AJAN çalıştı — huninin 2. adımı. `telemetryBump('agents_spawned')`. */
  agent_spawned: Object.freeze({ first_time: D.bool(), engine: ENGINE }),

  /** Lider bir işi worker'a dağıttı — huninin 3. adımı. `telemetryBump('delegations')`. */
  delegation_started: Object.freeze({ first_time: D.bool() }),

  /**
   * PH-01 — Board'a bir GÖREV açıldı. `telemetryBump('tasks_created')`.
   *
   * Sayaç anahtarı (`tasks_created`) heartbeat beyaz listesinde ZATEN vardı ama
   * hiçbir yer onu artırmıyordu: görev açma yolu `crewpane-task-mcp.cjs`, yani
   * AYRI BİR SÜREÇ — main'in musluğuna erişemiyordu. Köprüye eklenen
   * `POST /telemetry/bump` bu boşluğu kapatır; sayılan davranış ile ölçülen
   * davranış yine TEK yoldan geçer.
   *
   * Görevin BAŞLIĞI, açıklaması, atanan ajanı: HİÇBİRİ gönderilmez — yalnız
   * "bir görev açıldı" gerçeği ve bunun bu kurulumdaki ilk sefer olup olmadığı.
   */
  task_created: Object.freeze({ first_time: D.bool() }),

  /**
   * Hangi panel/sekme kullanılıyor. `panel` KAPALI KÜMEDİR: dock'un sekme
   * kimlikleri (WorkspaceView `dockViews`). Bilinmeyen bir kimlik `other`a düşer
   * — yani bir gün bir sekme "müşteri-adı-paneli" diye adlandırılsa bile o ad
   * dışarı çıkmaz.
   */
  panel_view: Object.freeze({
    panel: D.enum('office', 'terminals', 'editor', 'browser', 'kanban', 'reports',
      'memory', 'skills', 'jarvis', 'settings', 'other'),
    first_time: D.bool(),
  }),

  /**
   * HATA-06 — OFİS TUVALİ KURTARMA MERDİVENİNİN BASAMAK SONUCU.
   *
   * Neden gerekli: Sentry hangi basamağın DENENDİĞİNİ söylüyordu ama hangisinin
   * GERÇEKTEN KURTARDIĞINI söylemiyordu — 90 günlük prod ölçümünde `reinit` 54
   * kez "başarılı" göründü ve kullanıcının tuvali yine de ölü kaldı. `outcome`
   * tam olarak bu farkı ölçer; onsuz merdivenin işe yarayıp yaramadığı bilinemez.
   *
   * İki alan da KAPALI KÜME (serbest metin yok) ve kardinalitesi sabittir.
   * `first_time` YOK: bu bir huni adımı değil, bir arıza-kurtarma sonucudur.
   */
  canvas_recovery_step: Object.freeze({
    stage: D.enum('reinit', 'recreate-canvas', 'reload-renderer', 'recreate-window',
      'static', 'other'),
    /**
     * `verified` = basamak GERÇEKTEN çizdi (kare ölçüldü) · `failed` = çizemedi,
     * bir alt basamağa inildi · `unavailable` = bu ortam o basamağı taşımıyor ·
     * `exhausted` = ortam yapabilirdi ama bu arıza için sayfa yenileme hakkı ZATEN
     * harcandı (CANVAS-STALL-LINUX-01: `unavailable`la aynı sayılınca prod'da 4×
     * yenileme döngüsü "Linux desteklemiyor" gibi göründü) ·
     * `started` = KABUK basamağı başlatıldı (sayfa/pencere yenileniyor). `started`
     * AYRI bir değerdir çünkü sonucu bu sayfadan GÖZLEMLENEMEZ — onu `verified`
     * saymak, ölçmediğimiz bir başarıyı iddia etmek olurdu.
     */
    outcome: D.enum('verified', 'failed', 'unavailable', 'exhausted', 'started', 'other'),
  }),

  /**
   * SEC-W3-B1b-S — SUNUCU YAZMAYI ABONELİK YÜZÜNDEN REDDETTİ (oturumda İLK kez).
   *
   * Neden gerekli: 19.09'da PROD'da bir istemci 14 saat boyunca bu kapıya çarptı
   * (14 668 ret) ve Sentry'de de PostHog'da da **0 olay** vardı. Sıfır satır,
   * kusurun kendisini gizledi — arıza ancak Postgres loguna bakılınca görüldü.
   * Bu olay o körlüğü kapatır ve tam olarak bir soruya cevap verir: "kaç kurulum
   * kaydedemiyor?"
   *
   * 🔴 Ret metni, tablo adı, kullanıcı/şirket kimliği: HİÇBİRİ YOK. `surface`
   * kapalı kümedir (renderer'daki `EntitlementSurface` ile aynı liste) ve olay
   * kurulum başına oturumda BİR KEZ gönderilir — yoksa 14 668 satırlık spam'in
   * telemetri ikizi doğardı.
   */
  entitlement_write_blocked: Object.freeze({
    surface: D.enum('presence', 'sync', 'board', 'other'),
  }),

  /**
   * 🔴 PLAN LİMİTİ REDDİ — görevin ikinci ana sorusu.
   * Kaynak: main.js `pushPlanLimit` (BL serisinin ZATEN ürettiği `plan:limit`
   * yolu). `feature` listesi `planLimits.cjs` FEATURES anahtarlarıyla aynıdır;
   * o dosya bu görevde DOKUNULMAZ, bu yüzden liste burada AYNADIR ve bir kapı
   * testi iki listenin ayrışmadığını ölçer.
   */
  /**
   * TOUR-02-A — GİRİŞ TURU GÖREV GÜNLÜĞÜ: bir madde tamamlandı.
   *
   * Sözleşme: docs/design/TOUR-02-REHBER.md §6 — "HEDEF METRİK: ilk delegasyona
   * (madde 5) ulaşma oranı". Olay adı sözleşmedeki adın BİREBİR aynısıdır
   * (`onb.quest.done`); burada snake_case'e çevirmek panoda sözleşmeden farklı bir
   * ad üretir ve tasarım belgesiyle pano bir daha aynı şeyi söylemezdi.
   *
   * 🔴 Madde METNİ, kullanıcının yazdığı prompt, görev başlığı: HİÇBİRİ YOK.
   * Yalnız madde NUMARASI (kapalı küme) ve açılıştan bu yana geçen SANİYE.
   */
  'onb.quest.done': Object.freeze({
    quest: D.enum('1', '2', '3', '4', '5', '6', '7', '8', '9', '10'),
    /** Uygulamanın ilk açılışından bu yana geçen süre (sn). Tavan: 24 saat. */
    seconds: D.int(86_400),
    /** Madde ZORUNLU turun 5 adımından biri mi (huni ile isteğe bağlıyı ayırır). */
    required: D.bool(),
  }),

  /**
   * TOUR-02-A — günlük PANELİNİN durumu (§6 "açıldı/kapandı").
   * `dismissed` = kullanıcı paneli kapattı · `completed` = %100 kutlaması sonrası
   * panel kendini kapattı · `reopened` = Ayarlar → Yardım'dan geri açıldı.
   */
  'onb.quest.panel': Object.freeze({
    // TOUR-02 — `restart`: kullanıcı «Baştan başla»yı ONAYLADI (menüyü açmak
    // ya da onayda vazgeçmek ölçülmez: sıfırlama gerçekten OLDUĞUNDA sayılır).
    action: D.enum('expanded', 'collapsed', 'dismissed', 'reopened', 'completed', 'restart'),
  }),

  /**
   * TOUR-P1-01 — günlükteki "Göster" düğmesine BASILDI ve NE OLDU.
   *
   * Bu olay, kartın kök nedeninin panodaki karşılığıdır: Eren 0.2.44-dev.3'te
   * 3. maddenin "Göster"ine bastı ve HİÇBİR ŞEY olmadı. Ölü düğme, ölçülmeyen
   * düğmeydi. `outcome: 'none'` panoda görülen gün, bir kullanıcının boşa
   * tıkladığını şikâyet gelmeden biliriz.
   *
   * 🔴 Madde METNİ, hedef seçici, ajan adı: yok. Yalnız madde numarası + sonuç.
   */
  'onb.quest.show': Object.freeze({
    quest: D.enum('1', '2', '3', '4', '5', '6', '7', '8', '9', '10'),
    /** `topic` = konu turu açıldı · `none` = HİÇBİR ŞEY OLMADI (ölü düğme). */
    outcome: D.enum('opened', 'highlighted', 'composed', 'topic', 'none'),
  }),

  /**
   * TOUR-P1-01 — GERİYE DÖNÜK TAMAMLAMA koştu: kaç madde ürünün kendi verisinden
   * kapandı. Üç olgu alanı `true/false/null` ÜÇLÜSÜDÜR ("ölçülemedi" ile "yok"
   * ayrı şeylerdir; ikisini birleştirmek panoda ölçüm arızasını kullanıcı
   * davranışı gibi gösterirdi).
   */
  'onb.quest.backfill': Object.freeze({
    emitted: D.int(10),
    engine: D.enum('true', 'false', 'null'),
    office: D.enum('true', 'false', 'null'),
    board: D.enum('true', 'false', 'null'),
    /**
     * TOUR-03 — geriye dönük tamamlama KOŞMADI ve SEBEBİ. Yokluğu "normal
     * koştu" demektir; üç olgu alanı da o zaman dolu gelir.
     *
     * `reset` = kullanıcı «Baştan başla»ya basmıştı (kalıcı damga). Kapalı küme:
     * ileride ikinci bir atlama sebebi doğarsa ONA DA burada satır açılır,
     * çağıran tarafta serbest metin üretilmez.
     */
    skipped: D.enum('reset'),
  }),

  /**
   * TOUR-02-C — BAĞLAMSAL İPUCU gösterildi / kapatıldı (sözleşme §6).
   *
   * Sorunun cevabı: "hangi ipucu işe yarıyor, hangisi rahatsız ediyor". `tip`
   * KAPALI KÜMEDİR — `onboardingTips.ONB_TIPS` id'lerinin aynısı; tetiğin ADINI
   * (olay adı) göndermek yerine ipucu kimliğini göndeririz, çünkü aynı tetik
   * ileride iki ipucu doğurabilir ve pano o gün ikisini ayırt edemezdi.
   *
   * 🔴 İpucu METNİ, hangi pane'de çıktığı, kullanıcının o an ne yaptığı: HİÇBİRİ
   * YOK. Ölçülen tek şey "şu ipucu görüldü / şöyle kapatıldı".
   */
  'onb.tip.shown': Object.freeze({
    tip: D.enum('delegation', 'review', 'limit', 'paneError', 'memory', 'secondTeam'),
  }),
  'onb.tip.dismissed': Object.freeze({
    tip: D.enum('delegation', 'review', 'limit', 'paneError', 'memory', 'secondTeam'),
    /** `never` = "Bir daha gösterme" (kalıcı tercih) · `closed` = ✕. */
    action: D.enum('closed', 'never'),
  }),

  /**
   * TOUR-02-C — KONU TURU başladı / bitti.
   *
   * `from` turu KİMİN açtığını söyler: Ayarlar → Yardım listesi mi, görev
   * günlüğündeki "Göster" bağlantısı mı. İkisi farklı sorular ("kullanıcı yardım
   * arıyor" ↔ "günlük yolu gösteriyor") ve ikisini ayırmak yeni bir olay
   * gerektirmez — tek özellik yeter.
   *
   * `clean`, TOUR-01'in kirletmeme kanıtının ÖLÇÜMÜDÜR: konu turu da düzeni geri
   * yükler ve bunu her koşumda kendi kanıtına yazar. Panoda `clean=false` görülen
   * gün, kullanıcı şikâyet etmeden önce biliriz.
   */
  'onb.topic.started': Object.freeze({
    topic: D.enum('board', 'delegation', 'terminal', 'skills', 'memory', 'voice', 'hand', 'plan'),
    from: D.enum('settings', 'quest', 'other'),
  }),
  'onb.topic.done': Object.freeze({
    topic: D.enum('board', 'delegation', 'terminal', 'skills', 'memory', 'voice', 'hand', 'plan'),
    /** Oynatıcının bitiş sebebi (`FullTourProof.reason` ile birebir). */
    reason: D.enum('done', 'skipped', 'error', 'stalled', 'expired'),
    /** İzlenen adım sayısı — nerede bırakıldığını söyler. */
    steps: D.int(20),
    /** Düzen tur öncesindeki hâline döndü mü (kirletmeme kanıtı). */
    clean: D.bool(),
  }),

  /**
   * TOUR-02-B — REHBER TURUNUN ADIMI (sözleşme §6 birinci satırı):
   * "Nerede kopuyorlar; gerçek delegasyon izni oranı".
   *
   * 🔴 Adımın METNİ, kullanıcının yazdığı/düzenlediği örnek cümle, ajan adı:
   * HİÇBİRİ YOK. Yalnız adım NUMARASI, ne olduğu, süre ve turun HANGİ YOLDAN
   * gittiği (`mode`) — dördü de kapalı küme ya da sayı.
   */
  'onb.tour.step': Object.freeze({
    step: D.enum('1', '2', '3', '4', '5'),
    /**
     * `started` = balon açıldı · `done` = doğrulayıcı olay geldi · `skipped` =
     * "sonra" · `escaped` = TOUR-P1-01 çıkışı ("zaten yaptım / bu adımı atla",
     * yalnız adım `GUIDE_STUCK_MS`ten uzun süredir ilerlemiyorsa görünür).
     * `escaped` ayrı tutulur: pano "kullanıcı sonraya bıraktı" ile "adım onu
     * tuttu" arasındaki farkı görmeli — ikincisi bizim hatamızdır.
     */
    phase: D.enum('started', 'done', 'skipped', 'escaped'),
    /** Adımın açılışından bu yana geçen süre (sn). Tavan: 1 saat. */
    seconds: D.int(3_600),
    /** §4.1 izin cevabı: gerçek delegasyon mu, kayıttan mı, henüz sorulmadı mı. */
    mode: D.enum('real', 'demo', 'none'),
  }),

  /**
   * TOUR-P1-01 — Rehber'in ipucu düğmesine basıldı ve NE OLDU (`onb.quest.show`
   * ile aynı gerekçe; iki yüzey aynı yorumlayıcıyı kullanıyor, ölçümü de aynı
   * dilde konuşmalı). `kind` hedefin TÜRÜDÜR — seçici/metin değil.
   */
  'onb.tour.hintAction': Object.freeze({
    kind: D.enum('settings', 'dock', 'org', 'pane', 'compose', 'highlight'),
    outcome: D.enum('opened', 'highlighted', 'composed', 'none'),
  }),

  /**
   * TOUR-02-Q-F3 — REHBERİN KAPATILMASI (sözleşme §6 DÖRDÜNCÜ satırı):
   * "Rehber ne zaman kapatılıyor". Sözleşme §1.3'te bu olayın adı BİREBİR
   * `onb.guide.dismissed`'tır; snake_case'e çevirmek panoda tasarım belgesinden
   * farklı bir ad üretirdi (komşu `onb.*` olaylarının aynı gerekçesi).
   *
   * 🔴 Bu olay `onb.tour.step{phase:'skipped'}` DEĞİLDİR ve onun yerine geçmez:
   * "sonra" bir ADIMI atlar (tur devam eder), bu olay REHBERİ bitirir. İkisi
   * panoda ayrılmazsa §6'nın sorduğu soru — kullanıcı turu hangi adımda TERK
   * ediyor — cevaplanamaz; F3'ün açılma sebebi tam olarak bu ayrımdır.
   *
   * `via` üründeki ÜÇ kapanış yolunun aynısıdır (ölçüldü, OnboardingGuide.tsx:
   * `onb-guide-close` ✕ · Escape · `onb-guide-skip` "Turu atla"). Sözleşme §1.3
   * ilk ikisini adıyla sayar, üçüncüsü de aynı `dismissGuide` yolundan geçer:
   * tek değerde birleştirmek "✕'e mi bastı, atla'ya mı" sorusunu kaybederdi.
   *
   * 🔴 Adım METNİ, kullanıcının yazdığı örnek cümle, ajan/müşteri adı: HİÇBİRİ
   * YOK. Üç alan da kapalı küme ya da sayıdır.
   */
  'onb.guide.dismissed': Object.freeze({
    step: D.enum('1', '2', '3', '4', '5'),
    /** Kapanış yolu — üçü de `dismissGuide`'a gider ama farklı sorulardır. */
    via: D.enum('close', 'escape', 'skip'),
    /** Rehberin AÇILIŞINDAN bu yana geçen süre (sn). Tavan: 1 saat. */
    seconds: D.int(3_600),
  }),

  /**
   * 🔴 SEC-W1-C1 — KURCALAMA SİNYALİ. "Bu kopya bizim gönderdiğimiz kopya mı?"
   *
   * Neden ŞİMDİ tanımlanıyor: açılışta bütünlük denetimi (SEC-W1-A2) 0.2.47'de
   * gelecek. Şema o gün yazılsaydı ölçüm de o gün başlardı ve "kaç kopya
   * kurcalanmış" sorusunun ilk hafta cevabı olmazdı. Bugün üretilebilen tek
   * sinyal `build_flag_mismatch`tir (bkz. `electron/tamperSignals.cjs`);
   * kalan iki değer A2'nin yerini ŞİMDİDEN tutar, böylece A2 panoyu değil
   * yalnız üreticiyi ekler.
   *
   * 🔴 `app_version` ve `platform` BURADA TANIMLANMAZ: ikisi de `BASE` damgasında,
   * yani zaten HER olayda var. İkinci kez yazmak aynı anahtarın iki tanımı
   * demek olurdu ve biri bir gün sessizce ayrışırdı.
   *
   * 🔴 YOL, İÇERİK, KULLANICI VERİSİ YOK. `file` yalnız DOSYA ADIDIR ve `token`
   * alanıdır — `TOKEN_RE` eğik çizgi kabul etmez, yani bir YOL bu alandan
   * fiziksel olarak GEÇEMEZ (süzgeç değil TÜR SİSTEMİ engeli).
   */
  tamper: Object.freeze({
    /**
     * `build_flag_mismatch`  — paket damgası "müşteri paketi" diyor ama çalışma
     *   anı kararı "paket değil" diyor (asar açılmış / dosyalar dışarı serilmiş).
     * `unpacked_hash_mismatch` — A2: `app.asar.unpacked` altındaki bir dosyanın
     *   özeti build'de kaydedilenle tutmuyor.
     * `settings_flag_anomaly` — A2: kullanıcı ayar dosyasında üründe hiç
     *   yazılmayan bir kapı bayrağı var.
     */
    reason: D.enum('build_flag_mismatch', 'unpacked_hash_mismatch', 'settings_flag_anomaly'),
    /** DOSYA ADI (yol DEĞİL, içerik DEĞİL). Sinyalin dosyası yoksa alan hiç gönderilmez. */
    file: D.token(),
    /**
     * Paketin imza durumu. `unknown` = BU sinyalde ölçülmedi (ölçmediğimizi
     * 'valid' diye yazmak, olmayan bir kanıtı iddia etmek olurdu).
     */
    signature: D.enum('valid', 'invalid', 'unsigned', 'unknown'),
  }),

  /**
   * RESET-03 — KULLANICI KURULUMU SIFIRLADI (iki seviye).
   *
   * NEDEN ÖLÇÜLÜYOR: iptallerin 15/22'si ilk iki günde oluyor
   * ([[project_crewpane_churn_facts_0915]]); "kaç kurulum sıfırlanıyor" bunun
   * en erken öncü sinyalidir — sıfırlayan kullanıcı ürünü bırakmadan ÖNCE bir
   * kez daha deniyor demektir.
   *
   * ⚠️ OLAY SİLMEDEN ÖNCE GÖNDERİLİR. `distinct_id` = `settings.json` içindeki
   * `installId` ve tam sıfırlamada o dosya SİLİNİR: silmeden sonra gönderilseydi
   * olay ya kimliksiz kalır ya da YENİ bir kurulum gibi görünürdü. Bu sıra
   * kaynak taramasıyla ayrıca zorlanır (resetGate.test.cjs).
   *
   * ⚠️ HAM BAYT YOK. Kurulum boyutu anonim bir olayda parmak izidir; soru
   * "küçük mü büyük mü kurulumlar sıfırlanıyor" ve kova bunu yanıtlar.
   *
   * ⚠️ "SİLME BAŞARILI MI" ALANI YOK — BİLEREK. RESET-R1 §2b bir `ok` +
   * `lockedCount` öneriyordu; ölçüldü ki bu olayın gönderildiği AN'da sonuç
   * HENÜZ BİLİNMİYOR (silme bir sonraki açılışta olur) ve tahmin edilen bir
   * `ok:true` panoda ölçülmüş bir gerçek gibi okunurdu. Sonucu taşıyacak olan
   * açılış-sonrası olayın kimliği de yoktur (`installId` silindi, yenisi başka
   * bir kurulum gibi görünür). Alan uydurulmaktansa YOK — RESET-05 açık maddesi.
   */
  install_reset: Object.freeze({
    /** Seviye — `installReset.LEVELS` ile aynı küme. */
    level: D.enum('session', 'full'),
    /** Nereden tetiklendi: Ayarlar, komut satırı bayrağı ya da doktor (RESET-04). */
    source: D.enum('settings', 'cli', 'doctor'),
    /**
     * `plan()`in silmeden ÖNCE ölçtüğü toplamın KOVASI. "Boşalan" değil
     * "silinmesi planlanan" — ikisi kilit durumunda ayrışır ve adı bunu söyler.
     * Ölçülemediyse 'unknown' (0 DEMEZ — `bytes_uncomputed` uyarısı).
     */
    bytes_planned_bucket: D.enum('unknown', 'lt100mb', 'lt500mb', 'lt2gb', 'lt10gb', 'gte10gb'),
  }),

  plan_limit_hit: Object.freeze({
    // TIER-SYNC-01 — liste `planLimits.FEATURES` ile BİREBİR olmak ZORUNDA
    // (analyticsSchema.test.cjs kapısı). `designMode` TIER-DESIGN-01'de FEATURES'a
    // eklenmiş ama BURAYA yazılmamıştı: o günden beri her tasarım reddi 'other'a
    // düşüyordu — yani "hangi limite kaç kez çarpıldı" sorusu iki yetenek için
    // yanlış cevaplanıyordu. İkisi birden eklendi.
    feature: D.enum('agents', 'integrations', 'workspaces', 'delegateWave',
      'mobileRemote', 'designMode', 'cloudSync', 'devices', 'devicesConcurrent',
      'autopilot', 'other'),
    /** Katman tavanı (ör. Basic'te 3 ajan). */
    limit: D.int(100000),
    /** Reddin anındaki kullanım (ör. 3 ajan çalışıyordu). */
    current: D.int(100000),
    /** `kind` — sayım tavanı mı, açık/kapalı özellik mi. */
    kind: D.enum('count', 'max', 'flag', 'other'),
  }),
});

// ─── SİTE (crewpane.dev) OLAYLARI ────────────────────────────────────────────
//
// `route` KAPALI KÜMEDİR: sitenin sayfa listesi. Serbest yol kabul edilseydi
// query string (utm, e-posta) ve dinamik segmentler sızardı — Next 16'nın
// `request.path`inin query taşıması OBS-02'de zaten ölçülmüştü.
const SITE_ROUTES = Object.freeze([
  'home', 'pricing', 'download', 'products', 'products_crewpane',
  'products_agentshot', 'products_agentvoice', 'about', 'contact', 'careers',
  'changelog', 'other',
]);

const SITE_EVENTS = Object.freeze({
  page_view: Object.freeze({ route: D.enum(...SITE_ROUTES) }),

  /**
   * Dışarı çıkan tıklama. `target` HEDEF URL'DEN türetilir (bileşen adından
   * DEĞİL) — "davranış isimden değil DURUMDAN türesin" kuralı: yarın yeni bir
   * indirme butonu eklenirse hiçbir ölçüm kodu değişmeden doğru sayılır.
   */
  cta_click: Object.freeze({
    route: D.enum(...SITE_ROUTES),
    target: D.enum('checkout', 'login', 'download_mac', 'download_win', 'download_linux',
      'download_other', 'community', 'docs', 'social', 'internal', 'other'),
    product: D.enum('crewpane', 'agentshot', 'agentvoice', 'suite', 'none'),
  }),

  /** İndirim/iletişim formu GÖNDERİLDİ (istemci tarafı, sonuç henüz belli değil). */
  form_submit: Object.freeze({
    route: D.enum(...SITE_ROUTES),
    form: D.enum('lead', 'contact', 'other'),
  }),

  /**
   * Formun SONUCU (sunucu tarafı). `result` kapalı küme — sunucunun kendi karar
   * dallarının aynısı. E-posta, IP, kampanya kodu YOK: yalnız hangi dala girdi.
   */
  form_result: Object.freeze({
    form: D.enum('lead', 'contact', 'other'),
    result: D.enum('ok', 'already', 'paused', 'invalid', 'rate_limited', 'error'),
  }),
});

const EVENTS = Object.freeze({ ...APP_EVENTS, ...SITE_EVENTS });

/** Bir değeri alan tanımına göre doğrula. Geçmezse `undefined` döner (DÜŞER). */
function coerce(domain, value) {
  switch (domain.kind) {
    case 'bool':
      return typeof value === 'boolean' ? value : undefined;
    case 'int': {
      const n = Number(value);
      if (!Number.isFinite(n)) return undefined;
      return Math.max(0, Math.min(Math.floor(n), domain.max));
    }
    case 'enum':
      return typeof value === 'string' && domain.values.includes(value) ? value : undefined;
    case 'token':
      return typeof value === 'string' && TOKEN_RE.test(value) ? value : undefined;
    default:
      return undefined;
  }
}

/**
 * Bir olayı şemaya göre TEMİZLE.
 *
 * @param {string} name  olay adı (kayıtlı olmalı)
 * @param {object} props çağıranın verdiği özellikler (ortak damga + olaya özel)
 * @returns {{ok:true, name:string, properties:object, dropped:string[]}
 *          |{ok:false, reason:'unknown-event'|'bad-input'}}
 */
function sanitize(name, props) {
  if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(EVENTS, name)) {
    return { ok: false, reason: 'unknown-event' };
  }
  if (props != null && (typeof props !== 'object' || Array.isArray(props))) {
    return { ok: false, reason: 'bad-input' };
  }
  const allowed = { ...BASE, ...EVENTS[name] };
  const out = {};
  const dropped = [];
  for (const [key, value] of Object.entries(props || {})) {
    const domain = allowed[key];
    if (!domain) { dropped.push(key); continue; }   // şemada YOK → hiç var olmadı
    const clean = coerce(domain, value);
    if (clean === undefined) { dropped.push(key); continue; }
    out[key] = clean;
  }
  return { ok: true, name, properties: out, dropped };
}

/** Dock sekmesi kimliğini kapalı `panel` kümesine indir (bilinmeyen → 'other'). */
function panelOf(viewId) {
  return coerce(EVENTS.panel_view.panel, String(viewId || '')) || 'other';
}

/** planLimits yetenek kimliğini kapalı `feature` kümesine indir. */
function featureOf(id) {
  return coerce(EVENTS.plan_limit_hit.feature, String(id || '')) || 'other';
}

/**
 * SEC-W1-C1 — bir dosya YOLUNU `tamper.file` alanına indirger: yalnız TABAN AD,
 * ve o da `token` alanından geçebiliyorsa. Geçemiyorsa `null` döner ve çağıran
 * alanı HİÇ göndermez.
 *
 * Neden yardımcı var: çağıran tarafta `path.basename(...)` yazmak, bir gün birinin
 * tam yolu geçirmesini engellemez — o zaman alan sessizce DÜŞER ve panoda "dosya
 * bilinmiyor" görünür. Tek yerden geçirmek hem ayıklamayı hem niyeti sabitler.
 */
function tamperFile(nameOrPath) {
  const raw = String(nameOrPath == null ? '' : nameOrPath);
  const base = raw.split(/[/\\]/).pop();
  return coerce(EVENTS.tamper.file, base) || null;
}

/** Kurulum kimliği: yalnız uuid. Başka hiçbir şey distinct_id olamaz. */
function isDistinctId(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

module.exports = {
  EVENTS, APP_EVENTS, SITE_EVENTS, BASE, SITE_ROUTES,
  sanitize, coerce, panelOf, featureOf, tamperFile, isDistinctId,
  TOKEN_RE,
  ENGINE_IDS, // WIN-FIRSTRUN-01 (K5) — defterle eşitlik testi için
};
