// ADP-885/st1 (Wheeljack) — SESLİ KOMUT LEKSİKONU: TEK GERÇEK, ÇEVRİLEMEZ SINIF.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ BU DOSYADAKİ TÜRKÇE KELİMELER **ARAYÜZ METNİ DEĞİLDİR** — ÇEVRİLEMEZ.    ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// ── SINIF TANIMI (tek tek dize DEĞİL, kapatılan hata sınıfı) ────────────────
// Uygulama çok dilli olacak (ADP-885). Bir i18n turunda "ekranda görünen Türkçe
// metni sözlüğe taşı" refleksi bu dosyadaki kelimelere de uzanır — ve o an
// **hiçbir şey kırılmaz**: tip hatası yok, birim testi yok, derleme yeşil.
// Ama ürün SESSİZCE ölür: kullanıcı "terminali kapat" der, karşılaştırılan liste
// artık `['close','kill']` olduğu için hiçbir dal eşleşmez, komut LLM'e düşer ya
// da hiç çalışmaz. Şikâyet "bot beni anlamıyor" diye gelir, "çeviri bozdu" diye
// DEĞİL — kök nedene giden yol kapalıdır.
//
// Sebep basit ve mimari: bu kelimeler **ÇIKTI değil GİRDİ**dir.
//   • Arayüz etiketi   = biz kullanıcıya YAZARIZ  → dili kullanıcı seçer, ÇEVRİLİR.
//   • Niyet jetonu     = kullanıcı bize SÖYLER    → dili KONUŞAN seçer, ÇEVRİLMEZ.
// Bir Türkçe konuşan, arayüzü İngilizceye alsa bile "kapat" demeye devam eder
// (bkz. ses dili ≠ arayüz dili kararı: docs/design/ADR-VOICE-LOCALE.md).
// İngilizce komut desteği "çeviri" değil, İNGİLİZCE BİR LEKSİKON EKLEMEKTİR —
// yani bu dosyaya `en` kümesi eklenir, `tr` kümesi YERİNDE KALIR.
//
// ── YENİ KOMUT EKLERKEN NE YAPILMALI ───────────────────────────────────────
//  1. Kelimeyi BURAYA ekle (başka dosyaya çıplak dizi YAZMA — kapı kırmızı verir).
//  2. Kökü ÇEKİMSİZ yaz: 'kapat' evet, 'kapatın' hayır. Çekimi `turkishMorph`
//     çözer; çatı türevleri (kapa→kapat, ara→arat) AYRI KÖK olarak listelenir.
//  3. `electron/intentCorpus.cjs`e en az bir OLUMLU ve bir OLUMSUZ ("…ma/me")
//     vaka ekle — ADP-854 korpusu yeni kökü de korusun.
//  4. `npm run check:intent -- --update` ile kilidi tazele (bilinçli değişiklik
//     imzalanır; kazara değişiklik kırmızı kalır).
//  5. `node --test electron/intentRegression.test.cjs` yeşil olmalı.
//
// ── KAPI (ADP-885'in çeviri kapısıyla ÇAKIŞMAZ) ────────────────────────────
//  • `npm run check:intent` (scripts/check-intent-lexicon.mjs) — bu sınıfı korur.
//  • ADP-885 K1 (eslint `no-literal-string`, `src/**`): bu dosya `electron/`
//    altında olduğu için K1 onu ZATEN GÖRMEZ (eslint.config.mjs `electron/**`i
//    globalIgnores ediyor) → iki kapı yapısal olarak birbirini iptal EDEMEZ.
//    TS tarafındaki cephe (`src/app/lib/intentLexicon.ts`) sıfır Türkçe literal
//    taşır — K1 orada da susar.
//  • ADP-885 K3 (`electron/**` Türkçe taraması) bu dosyayı ihlal sanmasın diye
//    muafiyet MAKİNE OKUNUR yayımlanır: `i18nExemptions()` (aşağıda). K3 yazan
//    kişi listeyi elle kopyalamaz — bu fonksiyonu çağırır.
//  • ADP-885 K2 (`tr satisfies typeof en` anahtar paritesi): buradaki hiçbir
//    kelime sözlüğe girmediği için K2 ile kesişme YOKTUR.
//
// Saf veri + bağımlılıksız → `node -e "require('./intentLexicon.cjs')"`.

'use strict';

// ── 1. EYLEM FİİLLERİ (kural yolu) ──────────────────────────────────────────
//
// ADP-854'ten taşındı (eski yeri: jarvisVoice.js::STEMS). `hasV/negV` bu kümeyi
// `turkishMorph` üstünden sorar — çıplak alt-dize araması YOK ("kapatma" ≠ "kapat").
const ACTION_VERB_STEMS = {
  open: ['aç', 'başlat', 'baslat', 'kur', 'spawn', 'start', 'open'],
  close: ['kapat', 'kapa', 'sonlandır', 'sonlandir', 'durdur', 'öldür', 'oldur', 'sil', 'kill'],
  focus: ['odakla', 'odaklan', 'focus'],
  read: ['oku', 'özetle', 'ozetle'],
  summarize: ['özetle', 'ozetle'],
  search: ['ara', 'arat'],
  tellVerb: ['söyle', 'soyle', 'ilet', 'yolla', 'gönder', 'gonder'],
  giveVerb: ['ver', 'ata', 'devret'],
  list: ['listele', 'sırala', 'sirala'],
  create: ['oluştur', 'olustur', 'ekle'],
  show: ['göster', 'goster'],
  goto: ['geç', 'gec', 'dön', 'don', 'git', 'gir'],
  click: ['tıkla', 'tikla'],
  // ADP-884 — tarayıcı etkileşim fiilleri.
  // `press` ("bas") tıklamanın konuşma dilindeki hâli ("düğmeye BAS").
  press: ['bas'],
  write: ['yaz', 'gir', 'doldur'],
  scroll: ['kaydır', 'kaydir', 'kaydırt', 'kaydirt'],
  // 'in'/'çık' TEK BAŞINA çok geniş kökler (inceleme/çıkar…) — bu liste YALNIZ bir
  // yön sözcüğü ("aşağı"/"yukarı") zaten eşleştikten SONRA sorulur (bkz. SCROLL_CUE_RE).
  move: ['in', 'çık', 'cik'],
  reload: ['yenile', 'tazele', 'refresh'],
  // DELEGATE_RE'nin fiil listesi — yalnız OLUMSUZLAMA kontrolü için.
  delegateVerb: ['başlat', 'baslat', 'söyle', 'soyle', 'hallet', 'çalıştır', 'calistir', 'yaptır', 'yaptir', 'ata', 'ver'],
  // Pano durum fiilleri. 'al' KASTEN YOK: "altı" → "al"+"tı" geçerli bir çekim gibi
  // görünür (ölçüldü). Regex'teki `al\b` sınırla zaten korunuyor.
  mark: ['yap', 'geç', 'gec', 'taşı', 'tasi', 'işaretle', 'isaretle'],
  // AXP-01 — niyet yönlendiricinin OLUMSUZLAMA kapısı için: "temayı DEĞİŞTİRME",
  // "sekmeyi değiştirme" → `yok` sınıfı. Yalnız `negV` ile sorulur; olumlu biçim
  // ("temayı değiştir") ayar dalını değiştirmez (orası kendi regex'iyle çalışır).
  change: ['değiştir', 'degistir'],
  // AXP-01 — "X'e SOR": iletim fiili ailesinin sorusu. `tellVerb`e EKLENMEDİ,
  // çünkü o küme `wantsHandoff`u tetikler ve "temayı Parker'a sor" (belirsiz)
  // anında `tell` olurdu. Yönlendirici bunu AYRI sorar (§2.2 adım 5).
  askVerb: ['sor'],
};

// ── 2. HEDEF ÇÖZÜMLEME (kime söylendi?) ─────────────────────────────────────
//
// Eski yeri: entityResolve.cjs. "X'e SÖYLE / VER / ATA / DEVRET".
const TARGETING_VERB_STEMS = ['söyle', 'soyle', 'ver', 'ilet', 'ata', 'devret', 'yolla', 'gönder', 'gonder'];

/**
 * Rol sözlüğü — konuşulan rol adı → roster slug'ı.
 * `words` isim çekimine toleranslı eşleşir; `phrases` ÇOK KELİMELİ ve ÖNCE denenir
 * ("takım lideri" → 'lead', çıplak "lider"den daha spesifik).
 * ⚠️ `slug` bir KİMLİKTİR, kelime değil — çevrilemez olan `words`/`phrases`tir.
 */
const ROLE_LEXICON = [
  { slug: 'frontend', words: ['frontend', 'frontendçi', 'frontendci', 'önyüz', 'onyuz', 'arayüzcü'], phrases: ['ön yüz', 'ön uç', 'arayüz geliştirici'] },
  { slug: 'backend', words: ['backend', 'backendçi', 'backendci', 'arkauç'], phrases: ['arka uç', 'sunucu tarafı'] },
  { slug: 'qa', words: ['qa', 'testçi', 'testci'], phrases: ['test mühendisi', 'kalite mühendisi', 'test uzmanı'] },
  { slug: 'design', words: ['tasarımcı', 'tasarimci', 'dizayncı'], phrases: ['tasarım ekibi', 'ui tasarımcı'] },
  { slug: 'lead', words: ['lider', 'orkestratör', 'orchestrator'], phrases: ['takım lideri', 'ekip lideri', 'takım lider'] },
  { slug: 'devops', words: ['devops', 'altyapıcı'], phrases: ['altyapı mühendisi'] },
  { slug: 'security', words: ['güvenlikçi', 'guvenlikci'], phrases: ['güvenlik mühendisi', 'güvenlik uzmanı'] },
  { slug: 'pm', words: ['pm'], phrases: ['ürün yöneticisi', 'product manager', 'proje yöneticisi'] },
  { slug: 'marketing', words: ['pazarlamacı', 'pazarlamaci'], phrases: ['pazarlama ekibi', 'pazarlama uzmanı'] },
  { slug: 'rnd', words: ['arge'], phrases: ['ar-ge', 'ar ge', 'araştırma mühendisi'] },
  { slug: 'data-engineer', words: [], phrases: ['veri mühendisi', 'data mühendisi'] },
  { slug: 'support', words: ['destekçi'], phrases: ['destek ekibi', 'müşteri destek'] },
  { slug: 'explorer', words: ['araştırmacı', 'arastirmaci', 'explorer'], phrases: [] },
];

/** Ajan adı OLMADIĞI kesin olan, kesme işaretiyle çekimlenen sık kelimeler. */
const NOT_A_NAME_WORDS = [
  'branch', 'main', 'dev', 'repo', 'github', 'gitlab', 'terminal', 'pane', 'konsol',
  'rapor', 'sprint', 'görev', 'gorev', 'takım', 'takim', 'ekip', 'pano', 'board',
  'sekme', 'dosya', 'klasör', 'klasor', 'proje', 'sunucu', 'server', 'api', 'db',
  'supabase', 'shopify', 'google', 'chatflow', 'crewpane', 'crewpane',
];

// ── 3. KONUŞMA EKONOMİSİ (uzun iş tahmini — ADP-857) ────────────────────────
//
// Eski yeri: src/app/lib/speechPolicy.ts.
const LONG_VERB_STEMS = [
  'araştır', 'arastir', 'incele', 'analiz', 'hazırla', 'hazirla', 'düzelt', 'duzelt', 'yenile',
  'yaptır', 'yaptir', 'yenilet', 'hazırlat', 'hazirlat', 'koştur', 'kostur', 'düzelttir', 'duzelttir',
];
const HANDOFF_VERB_STEMS = ['ver', 'ilet', 'dağıt', 'dagit', 'devret'];
// 'ekib' AYRI bir kök: Türkçede ünsüz yumuşaması (p→b) çekimli biçimi değiştirir
// ("ekip" → "ekibe/ekibine"); tek kökle arayan bir liste bunları KAÇIRIR.
const TEAM_NOUN_STEMS = ['takım', 'takim', 'ekip', 'ekib', 'sprint'];

// ── 4. KESME / BARGE-IN (ADP-818, ADP-859) ─────────────────────────────────
//
// Eski yeri: src/app/lib/voiceRuntime.ts. Çatı türevleri AYRI kök.
// 🪤 AGENTX-RT-2 — 'bekle' EMİR kipinde bir kesme komutudur ("bekle, onu yapma"),
// ama BİLDİRME kipinde ("3 komut bekliyor") tam tersine BİLGİ verir. Morfoloji bu
// ikisini AYIRMAZ (ölçüldü: verbHit('kaç komut bekliyor') → {stem:'bekle'}), o yüzden
// bildirme biçimleri aşağıda AÇIKÇA deny listesine yazıldı. Yanlış bir "dur" işi
// iptal eder; kaçırılan "dur" yalnız bir tur geciktirir (ADP-854 §4 asimetrisi).
const STOP_VERB_STEMS = ['dur', 'durdur', 'sus', 'sustur', 'yet', 'vazgeç', 'vazgec', 'kes', 'bırak', 'birak', 'bekle'];

/**
 * Morfoloji GEÇERLİ sayar ama kesme DEĞİLDİR — gerekçeli deny listesi.
 * 🪤 `kesin` = "kes"+"-in" (2. çoğul emir) → morfolojik olarak kusursuz bir fiil
 * biçimi, ama günlük Türkçede "kesinlikle" anlamında BELİRTEÇ olarak kullanılıyor.
 * Yanlış bir "dur" kullanıcının işini iptal eder; şüphede DOKUNMA (ADP-854 §4).
 */
const STOP_DENY_WORDS = ['kesin', 'kesinlikle', 'durum', 'durumu', 'durumda', 'bıraktığı', 'biraktigi', 'bekliyor', 'bekliyorum', 'bekliyoruz', 'bekliyorsun', 'bekliyorlar', 'bekler', 'beklerim', 'beklediğim', 'bekledigim'];

/** Fiil olmayan kesme sözcükleri (isim/ünlem). */
const STOP_NOUN_STEMS = ['iptal'];
const STOP_PHRASES = ['boş ver', 'bos ver', 'boşver', 'bosver', 'yeter artık', 'yeter artik', 'tamam yeter'];

// ── 4b. SUSTURMA (CANCEL-01) — "sus" ≠ "iptal" ──────────────────────────────
//
// "sus" yalnız ÇALAN SESİ keser; koşan iş SÜRER. "dur/iptal/bekle" işi de durdurur.
// Kümeler İÇ İÇEDİR: susturma kökleri STOP_VERB_STEMS'te de durur (morfoloji ve
// main'deki kontrol-komutu kapısı tek listeyle çalışır); sınıflandırıcı önce
// susturma alt-kümesine bakar. Yanlış yön ucuz: "sus"u kesme sanmak işi iptal
// ederdi (pahalı), kesmeyi "sus" sanmak yalnız işi sürdürür (kullanıcı tekrar der).
const HUSH_VERB_STEMS = ['sus', 'sustur'];
const HUSH_PHRASES = ['sesi kes', 'sesini kes'];

// ── 5. UYKU KOMUTU (ADP-854B) ───────────────────────────────────────────────
//
// Eski yeri: src/app/lib/voiceSleep.ts. Kutup KÖKTE yaşar: "uyu" OLUMLU biçimde,
// "dinle" OLUMSUZ biçimde uyku komutudur.
//
// 🪤 `uyuy` ayrı bir kök: Türkçede ünlüyle biten köke ek gelirken KAYNAŞTIRMA 'y'si
// girer ("uyu"+"abilirsin" → "uyuyabilirsin") ve turkishMorph'un ünlü-düşmesi dalı
// bu biçimi çözmez (ÖLÇÜLDÜ).
const SLEEP_POSITIVE_STEMS = ['uyu', 'uyuy', 'kapan'];
/** OLUMSUZ biçimi uyku komutu olan kökler ("artık dinleme"). */
const SLEEP_NEGATED_STEMS = ['dinle'];
/** Kısa kalıplar — tek jetona sığmayan ama tartışmasız olan söyleyişler. */
const SLEEP_PHRASES = [
  'uykuya geç', 'uykuya gec', 'uyku moduna geç', 'uyku moduna gec',
  'dinlemeyi kapat', 'dinlemeyi bırak', 'dinlemeyi birak', 'dinlemeyi kes',
];

// ── 5c. ONAY YANITI (ADP-903) — "izin veriyor musun?" sorusunun CEVABI ──────
//
// Agent X bir eylem için izin sorduğunda kullanıcı ekrandaki düğmeye basmadan da
// cevap verebilmeli (Eren: "klavyeye dokunmadan, bilgisayarın yanında olmadan").
// Bu iki küme o cevabın kelimeleridir — yani ÇIKTI değil GİRDİ: dosyanın
// başındaki sınıf tanımına birebir uyar ve ÇEVRİLMEZ. İngilizcesi "çeviri" değil
// AYRI BİR KÜME'dir (ADR-VOICE-LOCALE §4).
//
// 🔴 ÜÇ TASARIM KURALI — üçü de yıkıcı bir eylemin kapısı olduğu için:
//
//  (a) EŞLEŞME JETON DÜZEYİNDE, alt-dize DEĞİL. "izin ver" alt-dize olarak
//      "izin VERME"nin İÇİNDEDİR → alt-dize araması reddi onaya çevirirdi.
//      Tüketici (`src/app/lib/approvalVoice.ts`) sözcük dizisi eşitliği arar.
//      JS `\b` de yetmez: Türkçe 'ı/ş/ğ' ASCII sözcük karakteri SAYILMAZ,
//      `\bhayır\b` beklenmedik yerde eşleşir/eşleşmez. Bu yüzden Unicode
//      jetonlama (`\p{L}\p{N}`) kullanılır.
//
//  (b) RET ÖNCE OKUNUR. Çakışan bir cümlede ("hayır izin verme") güvenli taraf
//      REDDİR. Tüketici bu sırayı test eder; buradaki sıra yalnız okunabilirlik.
//
//  (c) KÜME DAR TUTULUR. "peki", "olur mu", "belki" gibi zayıf onaylar KASTEN
//      YOK: yanlış tetiklenme bedeli geri alınamaz bir pane kapatmadır. Emin
//      olunmayan her cevap 'unclear'a düşer → bir kez tekrar sorulur → reddedilir.
//
//  (d) ADP-919 — ÇEKİM EKSİKLERİ ÖLÇÜLDÜ, TAHMİN EDİLMEDİ. 54 doğal cevap
//      varyantı sınıflandırıcıdan geçirildi (rapor §4 tablosu). Aşağıdaki
//      eklemeler o tablonun `no-match` satırlarıdır ve HEPSİ var olan bir kökün
//      başka bir çekimidir ('ver' → 'verebilirsin', 'onayla' → 'onaylandı').
//      (c) kuralı korunur: "peki" / "elbette" / "oldu" / "okey" hâlâ YOK —
//      ölçüldüler ama zayıf onay oldukları için bilerek dışarıda bırakıldılar
//      (yanlış tetiklenmenin bedeli hâlâ geri alınamaz bir pane kapatma).
//      RET tarafı daha CÖMERT genişletilir: oraya doğru hata yapmak güvenlidir.
const APPROVAL_ALLOW_WORDS = Object.freeze({
  tr: Object.freeze([
    'izin ver', 'izin veriyorum', 'izin verdim',
    'evet', 'tamam', 'onayla', 'onaylıyorum', 'onayliyorum', 'kabul',
    'yap', 'devam et', 'olur',
    // ADP-919 — ölçülen çekimler (aynı köklerin başka kipleri)
    'izin verebilirsin', 'verebilirsin', 'onay veriyorum',
    'onaylandı', 'onaylandi', 'kabul ediyorum', 'kabul et',
    'tamamdır', 'tamamdir', 'yapabilirsin',
    // ADP-919/2 — "evet ver": İKİ güçlü onay jetonu yan yana ama hiçbiri tek
    // başına cümleyi TÜKETMİYORDU ('ver' kümede yok, 'evet' tek başına kalıyor)
    // → yıkıcı eşikte `not-standalone` düşüp tekrar sorduruyordu. Ölçüldü
    // (rapor §5). Kalıp olarak eklenir; 'ver' TEK BAŞINA hâlâ YOK — "bana bir
    // terminal ver" gibi bir cümlenin onay sayılması (c) kuralının ihlali olurdu.
    'evet ver',
  ]),
  en: Object.freeze([
    'allow', 'allow it', 'allowed', 'approve', 'approved', 'confirm', 'confirmed',
    'yes', 'yeah', 'yep', 'ok', 'okay', 'go ahead', 'do it', 'permission granted',
    // ADP-919 — aynı sınıfın İngilizce çekimleri
    'you can', 'i allow it', 'granted', 'sure',
  ]),
});

const APPROVAL_DENY_WORDS = Object.freeze({
  tr: Object.freeze([
    'hayır', 'hayir', 'izin verme', 'verme', 'olmaz', 'yapma',
    'iptal', 'iptal et', 'vazgeç', 'vazgec', 'reddet', 'dur', 'gerek yok', 'boş ver', 'bos ver',
    // ADP-919 — ölçülen ret çekimleri (güvenli yön: cömert genişletilir)
    'izin vermiyorum', 'vermiyorum', 'vazgeçtim', 'vazgectim',
    'reddediyorum', 'reddet onu', 'istemiyorum', 'kapatma', 'hayır hayır',
  ]),
  en: Object.freeze([
    'no', 'nope', 'deny', 'denied', 'reject', 'cancel', 'stop', 'abort',
    'do not', "don't", 'dont', 'never mind', 'nevermind', 'not now',
    // ADP-919
    'no way', 'forget it', 'do not do it', 'leave it',
  ]),
});

// ── 5b. İNGİLİZCE KAYDIRMA (ADP-884/jazz) ───────────────────────────────────
//
// Bu dosyanın başlığındaki kararın İLK UYGULAMASI: "İngilizce komut desteği çeviri
// DEĞİL, İNGİLİZCE BİR LEKSİKON EKLEMEKTİR" → `tr` kümeleri yerinde kalır, yanına
// `en` kümesi gelir. Ölçülen boşluk: kural yolu yalnız Türkçe kaydırma ipuçlarını
// tanıyordu; "scroll down" / "go to the bottom" beyin anlamadığında SESSİZCE
// `reply`e düşüyordu (8/8 İngilizce vaka kırmızı — ADP-884 raporu).
//
// 🪤 İngilizcede OLUMSUZLAMA EKTE DEĞİL AYRI SÖZCÜKTEDİR: `turkishMorph.negV`
// ("kaydırma" ≠ "kaydır") "don't scroll"u OLUMLU görür. Bu yüzden `negation`
// kümesi AYRI bir alan olarak burada yaşar — ADP-854'ün kapattığı sınıfın
// İngilizce karşılığı kapının dışında kalmasın.
//
// 🪤 SÖZCÜK SEÇİMİ DAR: 'start' KASTEN YOK ("scroll down and start the build"
// cümlesini 'top' sanardı) · 'end' yalnız uç-nokta grubunda anlamlı.
const SCROLL_EN = Object.freeze({
  /** Kaydırma niyetini TEK BAŞINA taşıyan fiil. */
  verbs: Object.freeze(['scroll']),
  down: Object.freeze(['down', 'downward', 'downwards']),
  up: Object.freeze(['up', 'upward', 'upwards']),
  /** Uç nokta — miktarı EZER (TR tarafındaki `scrollTo` ile aynı sözleşme). */
  bottom: Object.freeze(['bottom', 'end']),
  top: Object.freeze(['top', 'beginning']),
  small: Object.freeze(['a bit', 'a little', 'slightly', 'a tad']),
  big: Object.freeze(['a lot', 'a ton', 'way down', 'all the way']),
  /**
   * 🪤 'stop' ÖLÇÜLEREK EKLENDİ (ADP-884 2. tur QA): Türkçede "kaydırmayı bırak"
   * (çevresel olumsuzlama) kapıya takılırken İngilizce ikizi "stop scrolling down"
   * beyin yolunda AÇIKTI — `don't` ailesi yalnız EK-YERİNE-SÖZCÜK biçimini görüyordu,
   * FİİLLE olumsuzlamayı değil. TR gate'iyle simetrik olsun diye burada yaşar.
   */
  negation: Object.freeze(["don't", 'do not', 'dont', 'never', 'without', 'stop']),
});

// ── 5d. NİYET YÖNLENDİRİCİ (AXP-01) — aksiyon / prompt / belirsiz / yok ─────
//
// Tasarım: docs/design/AXP-01-DESIGN.md §2. Kelimeler burada, DESEN `promptRouter.cjs`te.
// Hepsi GİRDİ (kullanıcının söylediği) → ÇEVRİLMEZ; İngilizce desteği ayrı küme olur.
//
//  • workVerbs   — "iş gövdesi var ama alıcı yok" sinyali ("landing sayfasını DÜZELT",
//                  "şu testleri KOŞTUR"): tek başına eylem seçmez, `belirsiz` sorusunu açar.
//                  ADP-857'nin uzun-iş kökleri (LONG_VERB_STEMS) bu kümeye DAHİLDİR;
//                  buradakiler yalnız oradaki listede OLMAYAN ekler.
//  • jobNouns    — "X için bir İŞ", "GÖREV vereceğim": niyet beyanı + "için … iş" kalıbı.
//  • jobAdjs     — "küçük/ufak/şu/yeni bir iş" kalıbının ortasındaki sıfatlar.
//  • noneWords   — "KİMSEYE iş verme", "HİÇBİR şey söyleme": olumsuz kutup sözcükleri.
//  • thirdPersonDeny — `-sin/-sın` 3. tekil emir gibi GÖRÜNEN ama emir OLMAYAN
//                  sözcükler ("kesin", "dersin"); ölçülen yanlış-pozitif freni.
//  • selfPhrases — "sen yap / kendin bak": kullanıcı UYGULAMADA yapılmasını
//                  söyledi → yönlendirici prompt/belirsiz ÜRETMEZ (fanoutPolicy
//                  SELF_RE'nin OLUMLU yarısı; olumsuz yarısı ("ajan açma") `yok`tur).
const PROMPT_ROUTER = Object.freeze({
  workVerbs: Object.freeze([
    'düzenle', 'duzenle', 'ilgilen', 'çöz', 'coz', 'topla', 'yaz', 'kısalt', 'kisalt',
    'test', 'ölç', 'olc', 'taşı', 'tasi',
    // AXP-06 — "Şunu/bunu HALLET" alıcısız iş fiilidir (belirsiz → tek soru); `delegateVerb`te
    // de durur (hedefli "Stark'a hallettir" iletimdir). 'halled' AYRI kök: ünsüz yumuşaması
    // (t→d) "halleder misin / halledin" biçimlerini tek kökle KAÇIRIR ('ekib' örneği).
    'hallet', 'halled',
  ]),
  // 🪤 'task' ve 'yeni' KASTEN YOK: ikisi de arayüz sözlüğünde DEĞER olarak geçiyor
  // (KI-2 çakışması); "yeni bir iş" yine yakalanır çünkü sıfat {0,2} isteğe bağlı.
  jobNouns: Object.freeze(['iş', 'is', 'görev', 'gorev']),
  jobAdjs: Object.freeze(['bir', 'küçük', 'kucuk', 'ufak', 'şu', 'su', 'acil']),
  // Soru sözcükleri/ekleri: soru cümlesi prompt/belirsiz OLMAZ ("Parker bugün ne yaptı?").
  questionWords: Object.freeze(['mı', 'mi', 'mu', 'mü', 'ne', 'kim', 'kime', 'kimin', 'hangi', 'neden', 'niye', 'nasıl', 'nasil', 'nerede', 'kaç', 'kac']),
  // Kesme işaretinden KOPAN hâl ekleri ("Parker'ın" → 'parker','ın'): ad + bu jeton = HİTAP DEĞİL.
  // Dilbilgisi verisi ama turkishMorph'a bağlanmadı (motor saf kalsın) — yönlendiricinin tek tüketicisi.
  caseSuffixes: Object.freeze(['ın', 'in', 'un', 'ün', 'nın', 'nin', 'nun', 'nün', 'a', 'e', 'ya', 'ye', 'na', 'ne', 'ı', 'i', 'u', 'ü', 'yı', 'yi', 'yu', 'yü', 'nı', 'ni', 'nu', 'nü', 'da', 'de', 'ta', 'te', 'dan', 'den', 'tan', 'ten', 'la', 'le', 'yla', 'yle', 'ile']),
  noneWords: Object.freeze(['kimseye', 'hiçbir', 'hicbir', 'hiçbirine', 'hicbirine', 'kimseyle']),
  // Olumsuz emrin ARDINDAN gelebilen ve olumsuzluğu bozmayan sözcükler ("iş verme ŞİMDİLİK").
  // 🪤 "-ma/-me" bir İSİM eki de olabilir: "ARAMA kutusuna yaz" / "ATAMA kurallarını yaz".
  // Olumsuz emir cümleyi ya da yan cümleyi BİTİRİR; ardından bir isim gelirse fiil değildir.
  // Bu yüzden yönlendirici olumsuzluğu yalnız (a) cümle/virgül sonunda ya da (b) bu
  // kuyruk sözcüklerinden önce sayar (ölçüldü: L7 "arama kutusuna", I10 "atama kuralları").
  negTails: Object.freeze(['şimdilik', 'simdilik', 'sakın', 'sakin', 'lütfen', 'lutfen', 'artık', 'artik', 'asla', 'dur', 'bekle', 'olmaz', 'tamam', 'ok']),
  thirdPersonDeny: Object.freeze(['kesin', 'dersin', 'istersin', 'sensin', 'bilirsin', 'görürsün', 'gorursun', 'yapmalısın', 'yapmalisin']),
  selfPhrases: Object.freeze(['sen yap', 'sen kendin yap', 'kendin yap', 'kendin bak', 'kendin hallet', 'kendin çöz', 'kendin coz', 'sen bak', 'sen hallet', 'sen çöz', 'sen coz', 'kendi araçlarınla', 'kendi araclarinla']),
});

// ── 5e. BELİRSİZ SORUSUNUN SESLİ CEVABI (AXP-01) — "ajana mı, uygulamada mı?" ─
//
// ADP-903 onay kümesinin kardeşi: kart iki düğme gösterir (Ajana iş ver /
// Uygulamada yap) ve kullanıcı ekrana dokunmadan cevaplayabilmeli. Aynı üç kural:
// jeton düzeyinde eşleşme, küme dar, İngilizce AYRI küme (çeviri değil).
// Tüketici: `src/app/lib/approvalVoice.ts` (kapı) — kart kimliğiyle bağlanır.
const PROMPT_CHOICE_WORDS = Object.freeze({
  agent: Object.freeze({
    tr: Object.freeze(['ajana', 'ajana ver', 'ajana ilet', 'iş ver', 'iş olarak ver', 'ona ver', 'ona ilet', 'ilet', 'ajan yapsın', 'ajan yapsin', 'iş vereceğim', 'is verecegim']),
    // 🪤 çıplak 'agent' KASTEN YOK: arayüz sözlüğünde değer olarak geçiyor (KI-2).
    en: Object.freeze(['to the agent', 'to an agent', 'give it to the agent', 'send it', 'delegate it', 'assign it']),
  }),
  app: Object.freeze({
    tr: Object.freeze(['uygulamada', 'uygulamada yap', 'sen yap', 'kendin yap', 'sen kendin yap', 'burada yap', 'terminalini aç', 'terminali aç', 'aç']),
    en: Object.freeze(['in the app', 'do it yourself', 'you do it', 'yourself', 'open it', 'open the terminal']),
  }),
});

// ── 5f. TASLAK KONTROL SÖZLERİ (AXP-02) — "gönder / sonuncuyu sil / baştan al" ─
//
// Agent X'e bir ajana İŞ yazdırırken (taslak durum makinesi, electron/agentxDraft.cjs)
// söylenen her cümle TASLAĞA EKLENİR; yalnız bu kümelerdeki kalıplar taslağı
// yönetir. Aynı üç kural: jeton düzeyinde eşleşme, küme dar, İngilizce AYRI küme.
// 🪤 Duraksama BİR KONTROL SÖZÜ DEĞİLDİR: sessizlik taslağı gönderemez — bu kümede
//    "sessizlik" adına hiçbir şey yoktur, kilit test bunu ölçer (agentxDraft.test.cjs).
// 🪤 'hazır' KASTEN YOK: arayüz sözlüğünde değer olarak geçiyor (KI-2 çakışması).
// 🪤 'iptal' / 'vazgeç' zaten STOP ve RET kümelerinde: taslak iptali oradan okunur
//    (`cancel` kümesi yalnız taslağa ÖZGÜ ifadeleri taşır).
const DRAFT_CONTROL_WORDS = Object.freeze({
  // Kapanış sözü: "bu kadar, gönder" — TEYİT'e geçirir (göndermez; teyit ayrı adım).
  finish: Object.freeze({
    tr: Object.freeze(['gönder', 'gonder', 'ilet', 'gönderebilirsin', 'gonderebilirsin', 'iletebilirsin', 'bitti', 'bu kadar', 'bitirdim', 'tamam gönder', 'tamam gonder', 'tamam ilet', 'bu kadar gönder', 'bu kadar gonder']),
    en: Object.freeze(['send', 'send it', 'deliver it', 'done', "that's all", 'that is all', 'that is it', 'ok send', 'okay send']),
  }),
  // Son eklenen parçayı geri al.
  removeLast: Object.freeze({
    tr: Object.freeze(['sonuncuyu sil', 'sonuncusunu sil', 'son cümleyi sil', 'son cumleyi sil', 'sonuncuyu çıkar', 'sonuncuyu cikar', 'sonuncuyu kaldır', 'sonuncuyu kaldir', 'son cümleyi çıkar', 'son cumleyi cikar', 'sonuncuyu geri al', 'onu sil', 'bunu sil', 'şunu sil', 'sunu sil']),
    en: Object.freeze(['delete the last one', 'remove the last one', 'delete the last sentence', 'remove the last sentence', 'scratch that', 'undo that']),
  }),
  // Taslağı sıfırla (hedef kalır).
  restart: Object.freeze({
    tr: Object.freeze(['baştan al', 'bastan al', 'baştan alalım', 'bastan alalim', 'baştan başla', 'bastan basla', 'hepsini sil', 'taslağı boşalt', 'taslagi bosalt', 'taslağı temizle', 'taslagi temizle']),
    en: Object.freeze(['start over', 'start again', 'clear the draft', 'delete everything']),
  }),
  // Taslağı bırak (ve iptal et). 'vazgeç'/'iptal' STOP kümesinde — burada yalnız taslak-özgü.
  // Yalnız CÜMLENİN TAMAMI eşleşince (bkz. agentxDraft `wholeIs`): "iptal düğmesini
  // kırmızı yap" bir metindir, iptal değil. Kısa sözler STOP/RET kümeleriyle KASTEN
  // ortak — aynı kelime, taslakta ayrı anlam (bırak), o yüzden burada da kayıtlı.
  cancel: Object.freeze({
    tr: Object.freeze(['vazgeç', 'vazgec', 'vazgeçtim', 'vazgectim', 'iptal', 'iptal et', 'boş ver', 'bos ver', 'taslağı sil', 'taslagi sil', 'taslaktan vazgeç', 'taslaktan vazgec', 'göndermeyeceğim', 'gondermeyecegim', 'gönderme', 'gonderme']),
    en: Object.freeze(['cancel', 'never mind', 'nevermind', 'forget it', 'discard the draft', 'drop the draft', 'forget the draft', 'do not send', "don't send"]),
  }),
  // "şunu da ekle …" ön eki: kalan kısım metindir.
  addPrefix: Object.freeze({
    tr: Object.freeze(['şunu da ekle', 'sunu da ekle', 'bunu da ekle', 'şunu ekle', 'sunu ekle', 'bir de şunu ekle', 'bir de sunu ekle', 'ekle']),
    en: Object.freeze(['also add', 'add this', 'and add', 'add']),
  }),
  // TEYİT'te "düzelt": taslağa geri dön (ret değil, düzenleme).
  fix: Object.freeze({
    tr: Object.freeze(['düzelt', 'duzelt', 'düzelteyim', 'duzelteyim', 'düzenleyeyim', 'duzenleyeyim', 'bir şey daha', 'bir sey daha', 'dur bir şey daha', 'dur bir sey daha', 'ekleme yapacağım', 'ekleme yapacagim', 'değiştireceğim', 'degistirecegim']),
    en: Object.freeze(['edit', 'let me edit', 'fix it', 'one more thing', 'wait one more thing', 'change it']),
  }),
});

// ── 5g. TESLİMİ YENİDEN DENE SÖZLERİ (AXP-15) — "tekrar gönder / yeniden dene" ─
//
// AXP-09 §5: "Tekrar gönder." bir İLETİLEMEDİ makbuzunu yeniden denemek yerine yeni
// bir taslak açıyordu (yönlendirici `gönder` fiilini görüp prompt/belirsiz dedi).
// Bu küme bir KONTROL SINIFIDIR (dur/sus/uyu gibi): renderer beyne/yönlendiriciye
// varmadan yakalar ve son `doğrulanamadı` makbuza `retry` gönderir. Tüketici:
// `electron/agentxRetryVoice.cjs` (tam-cümle eşleşme; "Raporu tekrar gönder" gövdeli
// bir cümledir, kontrol değil). Aynı üç kural: jeton düzeyinde, küme dar, EN ayrı küme.
// 🪤 'gönder' tek başına KASTEN YOK: taslak kapanış sözüdür (DRAFT_CONTROL_WORDS.finish).
const RETRY_DELIVERY_WORDS = Object.freeze({
  tr: Object.freeze(['tekrar gönder', 'tekrar gonder', 'yeniden gönder', 'yeniden gonder', 'bir daha gönder', 'bir daha gonder', 'tekrar dene', 'yeniden dene', 'bir daha dene', 'tekrar ilet', 'yeniden ilet', 'tekrar yolla', 'yeniden yolla']),
  en: Object.freeze(['send again', 'send it again', 'try again', 'try it again', 'try once more', 'retry', 'retry it', 'resend', 'resend it']),
});

// ── 5h. TEMA TABAN SÖZCÜKLERİ (AXP-08) — "koyu / açık" preset ADI DEĞİLDİR ──
//
// Ölçülen boşluk (AXP-05 §3 S1): kural yolu (beyin kapalı/soğumada) yalnız preset
// ADLARINI tanıyordu (Fosfor, Kömür, Gündüz…). "Temayı koyu yap" hiçbir preset adına
// uymadığı için katalog `unclassified` döndü ve Agent X "Bunu anlayamadım" dedi —
// oysa aynı cümle beyin AÇIKKEN çalışıyordu. 31 ifadelik ölçüm: 13/31 geçiyordu.
//
// Bunlar preset ADI değil TABAN sözcükleridir: `THEME_PRESETS[].base` ('dark'|'light')
// eksenini konuşma diliyle söylerler. Preset adı ÖNCE denenir (jarvisVoice.js tema
// dalı) — "Gece Vardiyası temasına geç" hâlâ o preset'e gider, 'gece' tabanına DEĞİL.
//
// 🪤 KÖKLER ÇEKİMSİZ + YUMUŞAMA AYRI KÖK: "karanlığa al" / "aydınlığa geç" biçimlerinde
//    k→ğ yumuşaması kökü değiştirir ('ekib' örneğiyle aynı sınıf) → 'karanlığ'/'aydınlığ'
//    AYRI yazılır. Eşleşme SÖZCÜK BAŞINDAN yapılır (ek serbest, ön ek değil).
// 🪤 'gündüz' bir preset ADI da (Gündüz teması) — burada da durur çünkü kullanıcı onu
//    taban olarak da söyler ("gündüz temasına geç"); preset dalı zaten önce yakalar,
//    iki yol da AYNI açık temaya çıkar (çelişki yok).
// 🪤 'siyah'/'beyaz' ÖLÇÜLDÜ, tahmin edilmedi: ikisi de doğal Türkçe söyleyiş
//    ("temayı siyah yap"). 'gri' KASTEN YOK — hangi tabana ait olduğu belirsiz.
const THEME_BASE_WORDS = Object.freeze({
  dark: Object.freeze(['koyu', 'karanlık', 'karanlik', 'karanlığ', 'karanlig', 'gece', 'siyah', 'dark']),
// 🪤 NOKTASIZ ı İKİZLERİ BURADA YOK, KASITLI: büyük harfli metinde
//    'LIGHT'/'SIYAH'/'ACIK' Türkçe küçültmede 'lıght'/'sıyah'/'acık' olur. Bu,
//    sözlüğe 12 ikiz eklenerek DEĞİL, eşleştirmenin metni iki biçimde birden
//    araması ile çözüldü (jarvisVoice.js `detectThemeBase`). Nöbetçi:
//    intentRegression.test.cjs "AXP-08 TÜRKÇE KÜÇÜLTME".
  light: Object.freeze(['açık', 'acik', 'açığ', 'acig', 'aydınlık', 'aydinlik', 'aydınlığ', 'aydinlig', 'gündüz', 'gunduz', 'beyaz', 'light']),
});

// ── 6. KAYIT (makine okunur sınıf işareti) ──────────────────────────────────
//
// Kapı bu kayıttan beslenir: hangi küme, hangi sınıf, hangi gerekçe. Sınıf bir
// YORUM DEĞİL VERİ olduğu için `check-intent-lexicon.mjs` onu okuyabilir, kilit
// dosyası imzalayabilir ve sözlüğe sızan bir kelimeyi ADIYLA gösterebilir.
//
// kind:
//   'intent-token'  → kullanıcının SÖYLEDİĞİ kelime (girdi). ÇEVRİLMEZ.
//   'speech-grammar'→ Türkçe dilbilgisi verisi (ek/bağlaç/edat). ÇEVRİLMEZ.
const LEXICON = Object.freeze({
  'action.verbs': { kind: 'intent-token', words: Object.values(ACTION_VERB_STEMS).flat(), why: 'kural yolu eylem fiilleri (aç/kapat/oku…)' },
  'target.verbs': { kind: 'intent-token', words: TARGETING_VERB_STEMS, why: 'hedefe yönelten fiiller ("X’e söyle")' },
  'target.roles': { kind: 'intent-token', words: ROLE_LEXICON.flatMap((r) => [...r.words, ...r.phrases]), why: 'konuşulan rol adları → roster slug' },
  'target.notName': { kind: 'intent-token', words: NOT_A_NAME_WORDS, why: 'ajan adı sanılmaması gereken sık kelimeler' },
  'speech.longVerbs': { kind: 'intent-token', words: LONG_VERB_STEMS, why: 'uzun iş tahmini (ADP-857 konuşma ekonomisi)' },
  'speech.handoffVerbs': { kind: 'intent-token', words: HANDOFF_VERB_STEMS, why: 'takıma iş devretme fiilleri' },
  'speech.teamNouns': { kind: 'intent-token', words: TEAM_NOUN_STEMS, why: 'takım/ekip/sprint isim kökleri' },
  'stop.verbs': { kind: 'intent-token', words: STOP_VERB_STEMS, why: 'barge-in kesme fiilleri (dur/sus/yeter/bekle)' },
  'stop.deny': { kind: 'intent-token', words: STOP_DENY_WORDS, why: 'morfolojik olarak fiil ama kesme DEĞİL' },
  'stop.nouns': { kind: 'intent-token', words: STOP_NOUN_STEMS, why: 'fiil olmayan kesme sözcükleri' },
  'stop.phrases': { kind: 'intent-token', words: STOP_PHRASES, why: 'çok kelimeli kesme kalıpları' },
  'hush.verbs': { kind: 'intent-token', words: HUSH_VERB_STEMS, why: 'CANCEL-01: yalnız sesi kesen fiiller (iş sürer) — kesme kümesinin alt kümesi' },
  'hush.phrases': { kind: 'intent-token', words: HUSH_PHRASES, why: 'CANCEL-01: çok kelimeli susturma kalıpları' },
  'sleep.positive': { kind: 'intent-token', words: SLEEP_POSITIVE_STEMS, why: 'OLUMLU biçimi uyku komutu olan kökler' },
  'sleep.negated': { kind: 'intent-token', words: SLEEP_NEGATED_STEMS, why: 'OLUMSUZ biçimi uyku komutu olan kökler' },
  'sleep.phrases': { kind: 'intent-token', words: SLEEP_PHRASES, why: 'çok kelimeli uyku kalıpları' },
  'scroll.en': {
    kind: 'intent-token',
    words: Object.values(SCROLL_EN).flat(),
    why: 'ADP-884: İngilizce kaydırma ipuçları + İngilizce olumsuzluk sözcükleri (ek değil AYRI sözcük)',
  },
  'approval.allow': {
    kind: 'intent-token',
    words: [...APPROVAL_ALLOW_WORDS.tr, ...APPROVAL_ALLOW_WORDS.en],
    why: 'ADP-903: "izin veriyor musun?" sorusuna ONAY cevabı (TR+EN); çevrilirse sesli izin sessizce ölür',
  },
  'approval.deny': {
    kind: 'intent-token',
    words: [...APPROVAL_DENY_WORDS.tr, ...APPROVAL_DENY_WORDS.en],
    why: 'ADP-903: aynı sorunun RET cevabı (TR+EN); çakışmada RET kazanır (güvenli varsayılan)',
  },
  'router.sets': {
    kind: 'intent-token',
    words: Object.values(PROMPT_ROUTER).flat(),
    why: 'AXP-01: niyet yönlendirici (aksiyon/prompt/belirsiz/yok) iş fiilleri, iş isimleri, olumsuz kutup, 3.tekil freni, "sen yap" kalıpları',
  },
  'draft.control': {
    kind: 'intent-token',
    words: Object.values(DRAFT_CONTROL_WORDS).flatMap((g) => [...g.tr, ...g.en]),
    why: 'AXP-02: taslak kontrol sözleri (gönder / sonuncuyu sil / baştan al / şunu da ekle / düzelt) TR+EN; çevrilirse sesle iş yazdırma sessizce ölür',
  },
  'receipt.retry': {
    kind: 'intent-token',
    words: [...RETRY_DELIVERY_WORDS.tr, ...RETRY_DELIVERY_WORDS.en],
    why: 'AXP-15: "tekrar gönder / yeniden dene" → son İLETİLEMEDİ makbuzu yeniden dener (TR+EN); çevrilirse sesli yeniden deneme sessizce ölür ve yeni taslak açılır',
  },
  'theme.base': {
    kind: 'intent-token',
    words: [...THEME_BASE_WORDS.dark, ...THEME_BASE_WORDS.light],
    why: 'AXP-08: tema TABAN sözcükleri (koyu/karanlık/gece/siyah · açık/aydınlık/gündüz/beyaz) — preset adı yoksa taban preset\u2019i seçilir; çevrilirse "temayı koyu yap" kural yolunda yine sessizce ölür',
  },
  'router.choice': {
    kind: 'intent-token',
    words: [...PROMPT_CHOICE_WORDS.agent.tr, ...PROMPT_CHOICE_WORDS.agent.en, ...PROMPT_CHOICE_WORDS.app.tr, ...PROMPT_CHOICE_WORDS.app.en],
    why: 'AXP-01: belirsiz sorusunun sesli cevabı — "ajana" / "uygulamada" (TR+EN); çevrilirse sesli seçim sessizce ölür',
  },
});

/** Kayıttaki TÜM kelimeler (kapı sözlük taramasında bunları arar). */
function allWords() {
  const out = new Set();
  for (const entry of Object.values(LEXICON)) {
    for (const w of entry.words) if (w) out.add(String(w));
  }
  return [...out];
}

// ── 7. YERİNDE KORUNAN YÜZEYLER (taşınmadı — gerekçesiyle) ─────────────────
//
// Aşağıdaki dosyalar da AYNI SINIFTAN veri taşır ama buraya taşınmadı: taşımak
// ya bir kısıtı ihlal ederdi ya da bağlamından koparıp okunmaz hâle getirirdi
// (dilbilgisi verisi kendi algoritmasının yanında anlamlıdır). Bunlar yerinde
// **işaretlenir** ve kapı işaretin varlığını ZORUNLU kılar — yani "makine
// tarafından ayırt edilebilir" olma şartı burada da sağlanır.
//
// marker:
//   'required' → dosya `INTENT_TOKEN_MARKER` işaretini TAŞIMAK ZORUNDA.
//   'deferred' → başka bir görev o dosyada çalışıyor; işaret o görev bitince
//                eklenecek (gerekçe + görev kodu zorunlu).
const INTENT_TOKEN_MARKER = 'i18n-exempt: intent-token';

const PROTECTED_SURFACES = Object.freeze([
  { file: 'electron/intentLexicon.cjs', kind: 'intent-token', marker: 'required', why: 'leksikonun kendisi (tek gerçek)' },
  { file: 'electron/turkishMorph.cjs', kind: 'speech-grammar', marker: 'required', why: 'Türkçe ek dilbilgisi + birleşik fiil kökleri; motor SAF kalsın diye leksikona bağlanmadı' },
  { file: 'electron/uiSurfaces.cjs', kind: 'intent-token', marker: 'required', why: 'ADP-883 yüzey kaydı: her satır bir yüzey + onu söyleyen Türkçe ifadeler; ifade ile açma köprüsü aynı satırda anlamlı' },
  { file: 'electron/uiControls.cjs', kind: 'intent-token', marker: 'required', why: 'ADP-921 kontrol kaydı: uiSurfaces\'in bir katman ALTI — ekranın İÇİNDEKİ kontrolü ve DEĞERİNİ söyleyen Türkçe ifadeler; aynı gerekçeyle yerinde durur (ifade ↔ yürütücü köprüsü aynı satırda anlamlı)' },
  { file: 'electron/jarvisVoice.js', kind: 'intent-token', marker: 'required', why: 'kural yolu ÖBEK desenleri (regex); ADP-854 TARAYICI kapısı ayrıca korur' },
  { file: 'electron/entityResolve.cjs', kind: 'intent-token', marker: 'required', why: 'yönelme hâli deseni (DATIVE_NAME_RE) — dilbilgisi, kelime değil' },
  { file: 'electron/promptRouter.cjs', kind: 'intent-token', marker: 'required', why: 'AXP-01 niyet yönlendirici ÖBEK desenleri ("de ki", "için bir iş", 3. tekil emir eki); kelimeler leksikonda (PROMPT_ROUTER)' },
  { file: 'electron/agentxDraft.cjs', kind: 'intent-token', marker: 'required', why: 'AXP-02 taslak durum makinesi ÖBEK desenleri ("X yerine Y yaz", tırnak, cümle sonundaki kapanış sözü); kelimeler leksikonda (DRAFT_CONTROL_WORDS)' },
  { file: 'src/app/lib/speechPolicy.ts', kind: 'intent-token', marker: 'required', why: 'soru/istek öbek desenleri' },
  { file: 'src/app/lib/voiceEndpoint.ts', kind: 'speech-grammar', marker: 'required', why: 'Türkçe bağlaç/edat/belirteç/dolgu/sayı + zarf-fiil ekleri: cümle BİTTİ Mİ kararı; algoritmasının yanında anlamlı' },
  { file: 'src/app/lib/voiceRuntime.ts', kind: 'intent-token', marker: 'required', why: 'kesme sınıflandırıcısı (kelimeler leksikondan gelir)' },
  { file: 'src/app/lib/voiceSleep.ts', kind: 'intent-token', marker: 'required', why: 'uyku sınıflandırıcısı + muhatap eki deseni' },
  {
    file: 'src/app/lib/widgetView.ts',
    kind: 'intent-token',
    marker: 'deferred',
    task: 'ADP-882',
    why: 'büyüt/küçült komut kümesi AYNI SINIFTAN; bumblebee ADP-882 kapsamında minimize görünümde çalışıyor — çakışma riskiyle dosyaya DOKUNULMADI, işaret + taşıma o görevden sonra',
  },
]);

/**
 * ADP-885'in K3 kapısı (`electron/**` Türkçe taraması) için MAKİNE OKUNUR muafiyet.
 * K3'ü yazan kişi bu listeyi elle KOPYALAMAZ — çağırır. Kopya olsaydı iki liste
 * ayrışırdı ve kapı sessizce yanlış dosyayı korurdu (ADP-883'ün "el-yazması ikiz
 * kapı değildir" dersi).
 *
 * @returns {{file:string, kind:string, why:string}[]}
 */
function i18nExemptions() {
  return PROTECTED_SURFACES.map((s) => ({ file: s.file, kind: s.kind, why: s.why }));
}

module.exports = {
  // niyet jetonları (tek gerçek)
  ACTION_VERB_STEMS,
  TARGETING_VERB_STEMS,
  ROLE_LEXICON,
  NOT_A_NAME_WORDS,
  LONG_VERB_STEMS,
  HANDOFF_VERB_STEMS,
  TEAM_NOUN_STEMS,
  STOP_VERB_STEMS,
  STOP_DENY_WORDS,
  STOP_NOUN_STEMS,
  STOP_PHRASES,
  HUSH_VERB_STEMS,
  HUSH_PHRASES,
  SLEEP_POSITIVE_STEMS,
  SLEEP_NEGATED_STEMS,
  SLEEP_PHRASES,
  SCROLL_EN,
  APPROVAL_ALLOW_WORDS,
  APPROVAL_DENY_WORDS,
  PROMPT_ROUTER,
  PROMPT_CHOICE_WORDS,
  DRAFT_CONTROL_WORDS,
  RETRY_DELIVERY_WORDS,
  THEME_BASE_WORDS,
  // sınıf işareti + kapı yüzeyi
  LEXICON,
  allWords,
  PROTECTED_SURFACES,
  INTENT_TOKEN_MARKER,
  i18nExemptions,
};
