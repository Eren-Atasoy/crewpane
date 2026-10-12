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
// Saf veri + bağımlılıksız → `node -e "intentLexicon"`.

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
  'supabase', 'shopify', 'google', 'chatflow', 'agentdesk', 'agentspace',
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
// AX-SLEEP-IMPL-01 — `dinlen` ("dinlenmeye geç" değil, çıplak "dinlen"/"dinlenebilirsin").
// 🪤 `dinle` ile KARIŞMAZ: kutbu tersi ("dinleme" uyku, "dinlenme" uyku DEĞİL).
const SLEEP_POSITIVE_STEMS = ['uyu', 'uyuy', 'kapan', 'dinlen'];
/** OLUMSUZ biçimi uyku komutu olan kökler ("artık dinleme"). */
const SLEEP_NEGATED_STEMS = ['dinle'];
/**
 * Kısa kalıplar — tek jetona sığmayan ama tartışmasız olan söyleyişler.
 * AX-SLEEP-IMPL-01: `voiceSleep` bunları ARTIK alt-dize olarak aramaz ("dinlemeyi
 * bırakma" içinde "dinlemeyi bırak" bulunuyordu → yanlışlıkla uyku). Yerine aşağıdaki
 * jeton-dizisi kümeleri geçti; bu liste `promptRouter` TAM-EŞİTLİK kontrolü için kalır.
 */
const SLEEP_PHRASES = [
  'uykuya geç', 'uykuya gec', 'uyku moduna geç', 'uyku moduna gec',
  'dinlemeyi kapat', 'dinlemeyi bırak', 'dinlemeyi birak', 'dinlemeyi kes',
];

// ── 5a. UYKU v2 (AX-SLEEP-IMPL-01) — cümlecik bazlı kural katmanı ───────────
//
// Tasarım + ölçüm: docs/agent-results/RES-AX-SLEEP-01-wheeljack.md §4a. Kurallar
// `src/app/lib/voiceSleep.ts`te, KELİMELER burada (KI-3). Hepsi jeton ya da jeton
// DİZİSİ olarak eşleşir — alt-dize araması YOK (K5: "bırakma" ⊃ "bırak").
//
/** "kendini uyut / kendini kapat" — YALNIZ dönüşlü zamirle uyku ("Bumblebee'yi uyut" başka nesne). */
const SLEEP_REFLEXIVE_STEMS = ['uyut', 'kapat'];
/** Dönüşlü zamir: yukarıdaki köklerin uyku sayılması için cümlecikte bulunmalı. */
const SLEEP_REFLEXIVE_PRONOUNS = ['kendini'];
/** "dinlemeyi" nesnesi — ardından muhatap biçiminde bir bitirme fiili gelirse UYKU (kesme değil). */
const SLEEP_LISTEN_OBJECT = ['dinlemeyi'];
const SLEEP_LISTEN_OBJECT_VERBS = ['bırak', 'birak', 'kes', 'durdur', 'kapat', 'bitir'];
/** Ad + fiil: {uykuya, uyku moduna, …} + {geç, dal, dön}. Çok jetonlu başlar boşlukla yazılır. */
const SLEEP_NOMINAL_HEADS = ['uykuya', 'uyku moduna', 'uykuna', 'beklemeye', 'bekleme moduna', 'dinlenmeye', 'sessiz moda'];
const SLEEP_NOMINAL_VERBS = ['geç', 'gec', 'dal', 'dön', 'don'];
/**
 * TÜM-CÜMLECİK kalıpları: dolgu atıldıktan sonra cümleciğin TAMAMI olmalı
 * ("iyi geceler mesajını Kamil'e gönder" → uyku DEĞİL). Veda kalıpları bilinçli
 * olarak AÇIK (Optimus kararı 3, 26.09).
 */
const SLEEP_WHOLE_CLAUSE = [
  'şimdilik bu kadar', 'bugünlük bu kadar', 'görüşürüz', 'sonra görüşürüz', 'iyi geceler', 'iyi uykular', 'hoşça kal',
  'uyku vakti', 'yatma vakti', 'uyku zamanı', 'mola ver', 'mola verebilirsin', 'git yat', 'yat', 'kulaklarını kapat',
];
/**
 * Dolgu: içerik tavanına SAYILMAZ ve fiilden sonra gelebilir (ünlem, pekiştirici,
 * argo itici, teşekkür). 🪤 "kendini" de burada: dönüşlü zamir içerik değildir.
 * 🪤 'şimdi' / 'sen' KASTEN YOK: arayüz sözlüğünde düz etiket olarak geçiyorlar (KI-2;
 * JOB_CONTROL_WORDS emsali). 'simdi' (aksansız STT) çakışmaz, kalır. 2. tekil zamir
 * ("sen") `voiceSleep.ts`te dilbilgisi DESENİ olarak durur (ambientSpeech emsali).
 */
const SLEEP_FILLERS = [
  'hadi', 'haydi', 'artık', 'artik', 'lan', 'be', 'lütfen', 'lutfen', 'simdi', 'hemen', 'tamam', 'biraz',
  'bakalım', 'siktir', 'git', 'defol', 'ok', 'okey', 'evet', 'hayır', 'diyorum', 'ki', 'sana', 'teşekkürler',
  'tesekkurler', 'teşekkür', 'ederim', 'sağol', 'yarım', 've', 'işim', 'bitti', 'yeter', 'sus', 'kendini',
];
/**
 * Hitap: asistanın adı JETON DİZİSİ olarak ("agent x"); cümlecikten ATILIR, içerik sayılmaz.
 * 🪤 Tek başına 'agent' / 'ajan' KASTEN YOK: arayüz sözlüğünde düz etiket (KI-2).
 */
const SLEEP_ADDRESS_WORDS = ['agent x', 'ajan x', 'agentx', 'ajanx', 'jarvis'];
/** STT kesiği: son jeton `uy` ise ve hemen önünde bu itici varsa uyku ("… git uy."). */
const SLEEP_TRUNC_STUBS = ['uy'];
const SLEEP_TRUNC_PREV = ['git', 'hadi', 'artık'];
/**
 * İNGİLİZCE uyku (çeviri DEĞİL, ayrı küme — ADR-VOICE-LOCALE §4). Cümlecik =
 * [önek dolgu]* + çekirdek + [sonek dolgu]*; çekirdek TAM eşleşir ("tell Ratchet to
 * take a break" → değil). `neg` jetonları cümlecikte geçerse uyku YOK ("don't sleep").
 */
const SLEEP_EN_IMPERATIVE = [
  'sleep', 'go to sleep', 'go to bed', 'stop listening', 'stop listening to me', 'enter sleep mode', 'go to sleep mode',
  'go to standby', 'go on standby', 'take a break', 'go rest', 'rest',
];
const SLEEP_EN = Object.freeze({
  // 🪤 Çıplak 'now' leksikona GİREMEZ (arayüz sözlüğünde düz etiket, KI-2 — JOB_CONTROL_WORDS
  // emsali). Bu yüzden her EMİR çekirdeğinin "… now" biçimi TAM ifade olarak türetilir.
  core: Object.freeze([
    ...SLEEP_EN_IMPERATIVE,
    ...SLEEP_EN_IMPERATIVE.map((p) => `${p} now`),
    'time to sleep', 'sleep mode', 'standby',
    'that is all', "that's all", "that's it", 'that is it', 'good night', 'goodnight', 'bye', 'see you later', 'see you',
  ]),
  // 🪤 Çıplak 'now' KASTEN YOK: arayüz sözlüğünde düz etiket (KI-2). "for now" / "right now" kalır.
  prefix: Object.freeze([
    'ok', 'okay', 'alright', 'please', 'right now', 'thanks', 'thank you', 'agent x', 'hey agent x', 'you can', 'you may',
    'can you', 'could you', 'will you',
  ]),
  suffix: Object.freeze(['right now', 'please', 'agent x', 'for now', 'then']),
  neg: Object.freeze(["don't", 'dont', 'do not', 'never', 'keep']),
});
/**
 * SÖZ BEKÇİSİ (söz = eylem): beynin `reply` cümlesinde bir cümleciğin TAMAMI (dolgu
 * atıldıktan sonra) bunlardan biriyse ürün GERÇEKTEN uyur. 1. tekil + şimdiki/gelecek
 * zamanla sınırlı ("Wheeljack uyuyor" durum bildirimi GİRMEZ — rapor §7 risk 3).
 */
const SLEEP_PROMISE = Object.freeze({
  tr: Object.freeze([
    'uyuyorum', 'uykuya geçiyorum', 'uyku moduna geçiyorum', 'beklemeye geçiyorum', 'bekleme moduna geçiyorum',
    'dinlenmeye geçiyorum', 'dinlemeyi bırakıyorum', 'dinlemeyi kesiyorum', 'uyumaya gidiyorum',
  ]),
  en: Object.freeze([
    'going to sleep', 'going to sleep now', "i'm going to sleep", 'i am going to sleep', 'going to sleep mode', 'entering sleep mode',
    'switching to sleep mode', 'going on standby', 'going to standby', "i'll go to sleep", 'i will go to sleep',
    "i'll stop listening", 'i will stop listening',
  ]),
});
/**
 * SUSMA sözleri söz bekçisine GİRMEZ (Optimus kararı 2, 26.09): susmak ≠ uyumak.
 * Yalnız TEŞHİS izi için tanınır; beyin istemi bu sözleri zaten yasaklar.
 */
const SLEEP_PROMISE_HUSH = Object.freeze({
  tr: Object.freeze(['susuyorum', 'sessiz kalıyorum', 'sesimi kesiyorum']),
  en: Object.freeze(["i'll be quiet", 'going quiet', 'staying quiet']),
});

// ── 5b-2. ARKA PLAN SÜZGECİ (AXF-04) — uyanık modda "bu cümle BANA mı?" ─────
//
// Otomatik yeniden-dinlemede duyulan cümle Agent X'e hitap etmiyor ve bir katalog
// eylemi / iş gövdesi taşımıyorsa arka plan konuşmasıdır (video/TV). Fiil kökleri
// ZATEN yukarıda (ACTION_VERB_STEMS, LONG_VERB_STEMS, PROMPT_ROUTER.workVerbs …);
// bu grup yalnız FİİL-DIŞI hitap sinyallerini tutar. Tüketici: electron/ambientSpeech.cjs.
const AMBIENT_ADDRESS_WORDS = Object.freeze({
  // 🪤 2. tekil ZAMİR ("sen/sana/seni…") burada DEĞİL: kapalı bir çekim dizisi
  // (dilbilgisi) ve 'sen'/'senin' arayüz sözlüğünde DEĞER olarak geçiyor (KI-2
  // çakışması) → ambientSpeech.cjs'te desen olarak durur.
  // Ürünün kendi isimleri: SORU cümlesinde geçerse ("ajanlar ne yapıyor?") uygulama
  // sorusudur. Önek eşleşir. 'ajan' değil 'ajanl': çıplak 'ajan' arayüz sözlüğünde
  // DEĞER (KI-2); doğal soru zaten çoğul ("ajanlar ne yapıyor?"), tekil ajan ADIYLA sorulur.
  productNouns: Object.freeze(['ajanl', 'agentspace', 'takım', 'takim', 'ekip', 'ekib', 'görev', 'gorev']),
  // Asistanın adının ses tanımadan çıkan Türkçe yazımları ("Agent X" → "Ajan X").
  addressVariants: Object.freeze(['ajan x', 'ajanx', 'agentx']),
  // ── AXV-04 (F4) — Murat'ın kaydında "Gündüz temasına geçelim", "Ne yaptın kanka?"
  // arka plan sanılıp atıldı. Aşağıdakiler 1. ÇOĞUL istek kipinin ("geçelim") NESNE
  // kümesi ve tekil hitap sözleridir; ekler ambientSpeech.cjs'te desen olarak durur.
  //
  // TEKİL hitap: soru ya da istek kipiyle birlikte geçerse asistana söylenmiştir
  // ("Kanka ne durumdayız?"). Tek başına YETMEZ: vlog dilinde ünlem ("Abi bu oyun
  // inanılmaz") — kontrol kolu derleminde ölçüldü.
  vocatives: Object.freeze(['kanka', 'dostum', 'abi']),
  // ÇOĞUL seyirci hitabı = yayın/video dili ("El kontrolünü açtım dostlar" — Murat'ın
  // yayın anlatısı, kayıtta arka plan). Cümlede geçerse istek kipi ve tekil hitap
  // kuralları SUSAR (adres/2. tekil/emir kuralları değişmez).
  audienceVocatives: Object.freeze([
    'arkadaşlar', 'arkadaslar', 'arkadaşlarım', 'arkadaslarim', 'dostlar', 'millet',
    'beyler', 'gençler', 'gencler', 'izleyiciler',
  ]),
  // İstek kipinin ürün nesnesi: tema sözcüğü (çekim serbest: "temasına", "temayı").
  // Katalog türleri (CATALOG_WORDS.kinds) ve `productNouns` da nesnedir — burada
  // TEKRAR yazılmadı, oradan okunur.
  themeNouns: Object.freeze(['tema', 'theme']),
  // Tema ADI, "tema" sözcüğü olmadan YALNIZ yönelme hâlinde ve geçiş fiilinden HEMEN
  // önce nesnedir ("Kağıt Kağıta geçelim" — Murat'ın kaydı). Kaynak: jarvisVoice.js
  // tema dalının preset adları (ilk sözcük; yumuşamalı yazım da: kağıt → kağıda).
  // 🪤 KASTEN YOK: orman/sera/beton/bulut/duman/derin — gündelik sözcükler, anlatıda
  //    "ormana geçelim" doğaldır (kontrol kolu). Taban sözcükleri THEME_BASE_WORDS'ten
  //    okunur; 'gece' orada da düşer ("geceye geçelim", "gece geç yattım" emsali).
  themeNames: Object.freeze([
    'kağıt', 'kağıd', 'kagit', 'kagid', 'fosfor', 'kömür', 'komur', 'yörünge', 'yorunge',
    'sonar', 'sepya', 'grafit', 'obsidyen', 'espresso', 'bordo', 'lavanta', 'kutup',
    'fıstık', 'fistik', 'yosun', 'pastel', 'gülkurusu', 'gulkurusu', 'atölye', 'atolye',
    'kumsal', 'sedef', 'amber', 'sentetik',
  ]),
  themeDativeSkip: Object.freeze(['gece']),
});

// ── 5c. ONAY YANITI (ADP-903) — "izin veriyor musun?" sorusunun CEVABI ──────
//
// Agent X bir eylem için izin sorduğunda kullanıcı ekrandaki düğmeye basmadan da
// cevap verebilmeli (Murat: "klavyeye dokunmadan, bilgisayarın yanında olmadan").
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

// ── 5a. A22-SESLE-ONAY — "HER ZAMAN İZİN VER" SÖZLERİ ───────────────────────
//
// Motor izin menüsünde "don't ask again / always allow" seçeneği YIKICIDIR (bundan
// sonra o komut hiç sorulmaz). Bu kümeye uyan bir cevap sesle HİÇBİR ŞEY SEÇMEZ;
// Agent X "bunu ekranda seçmen gerek" der. Küme RET kümesinden ÖNCE okunur: "don't
// ask again" içindeki "don't" bir ret sözüdür ve aksi hâlde "hayır" seçilirdi.
const APPROVAL_ALWAYS_WORDS = Object.freeze({
  tr: Object.freeze([
    'hep izin ver', 'her zaman izin ver', 'hep onayla', 'her zaman onayla',
    'her zaman', 'hep', 'bir daha sorma', 'bir daha sormasın', 'bir daha sormasin',
    'hepsine izin ver', 'tümüne izin ver', 'tumune izin ver', 'hep evet',
  ]),
  en: Object.freeze([
    'always', 'always allow', 'allow always', "don't ask again", 'dont ask again',
    'do not ask again', 'never ask again', 'allow all',
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
//  • dismissPhrases — "bunu BOŞ VER", "VAZGEÇTİM": vazgeçme öbekleri (olumsuz kutup, AXF-01).
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
  // AXF-01 — VAZGEÇME öbekleri ("Bunu boş ver."): olumsuz kutup, ortada iş YOK. Önceden
  // hiçbir kural tanımıyordu → "uygulamada mı, ajana mı?" sorusu açılıyordu (ekran 25.09).
  // Öbek olarak aranır ve ARDINDAN ek gelemez: "boş verME" (= vazgeçme) eşleşmez.
  dismissPhrases: Object.freeze(['boş ver', 'boşver', 'bos ver', 'bosver', 'vazgeçtim', 'vazgectim']),
  // Olumsuz emrin ARDINDAN gelebilen ve olumsuzluğu bozmayan sözcükler ("iş verme ŞİMDİLİK").
  // 🪤 "-ma/-me" bir İSİM eki de olabilir: "ARAMA kutusuna yaz" / "ATAMA kurallarını yaz".
  // Olumsuz emir cümleyi ya da yan cümleyi BİTİRİR; ardından bir isim gelirse fiil değildir.
  // Bu yüzden yönlendirici olumsuzluğu yalnız (a) cümle/virgül sonunda ya da (b) bu
  // kuyruk sözcüklerinden önce sayar (ölçüldü: L7 "arama kutusuna", I10 "atama kuralları").
  negTails: Object.freeze(['şimdilik', 'simdilik', 'sakın', 'sakin', 'lütfen', 'lutfen', 'artık', 'artik', 'asla', 'dur', 'bekle', 'olmaz', 'tamam', 'ok']),
  thirdPersonDeny: Object.freeze(['kesin', 'dersin', 'istersin', 'sensin', 'bilirsin', 'görürsün', 'gorursun', 'yapmalısın', 'yapmalisin']),
  // A8-SESLI-SONUC — sonucu az önce söylenen ajana CEVAP: "ona söyle testleri de koşsun".
  // Zamir yalnız bağlamda `replyTarget` varken (son söylenen sonuç, 3 dk) hedef olur;
  // yoksa hiçbir şey çözmez ve bugünkü yol ("Kime?") aynen koşar.
  replyPronouns: Object.freeze(['ona', 'onlara', 'kendisine', 'him', 'her', 'them']),
  // AXM-UNKNOWN-TEAM-01 — "<Ad> takımına/ekibine" kalıbında adın YERİNDE duran ama takım adı
  // OLMAYAN sözcükler (gösterme/iyelik/niteleme, işin kendisi): "KENDİ takımına", "İŞİ ekibine".
  // Bunlar soru ("X diye bir takım bulamadım") AÇMAZ; aktif takım kuralı aynen kalır.
  // 🪤 'yeni' ve 'mevcut' KASTEN YOK (KI-2: arayüz sözlüğünde değer) — "yeni takımına" soru açar,
  // uydurmaz. İyelik zamirleri ("senin/onun takımına") kapalı çekim dizisi: promptRouter'da DESEN
  // (AMBIENT_ADDRESS_WORDS emsali; 'senin' de sözlükte değer).
  teamDeterminers: Object.freeze([
    'bu', 'şu', 'su', 'o', 'kendi',
    'aktif', 'seçili', 'secili', 'şimdiki', 'simdiki', 'diğer', 'diger', 'öbür', 'obur', 'öteki', 'oteki',
    'başka', 'baska', 'her', 'tüm', 'tum', 'bütün', 'butun', 'aynı', 'ayni', 'ilgili', 'hangi', 'ne', 'bir',
    'hedef', 'yanlış', 'yanlis', 'doğru', 'dogru', 'bunu', 'şunu', 'sunu', 'onu', 'işi', 'isi', 'görevi', 'gorevi',
  ]),
  selfPhrases: Object.freeze(['sen yap', 'sen kendin yap', 'kendin yap', 'kendin bak', 'kendin hallet', 'kendin çöz', 'kendin coz', 'sen bak', 'sen hallet', 'sen çöz', 'sen coz', 'kendi araçlarınla', 'kendi araclarinla']),
  // AXD-02 — RİCA ÇERÇEVESİ: "SENDEN İSTEDİĞİM, X'e şunu söylemen: …" / "söylemeni İSTİYORUM: …".
  // Fiilden isim + 2. kişi iyelik ("söyleMEN", "iletMENİ") ancak bu çerçevede iletimdir
  // ("söylemen iyi oldu" bir iş değil). requestLead + requestCue birlikte: giriş öbeği; requestTail:
  // fiilden SONRA gelip gövdeye girmeyen sözcükler ("söylemeni İSTİYORUM: …", "iletmeni RİCA EDİYORUM, …").
  requestLead: Object.freeze(['senden', 'sizden']),
  requestCue: Object.freeze(['iste', 'rica']),
  requestTail: Object.freeze(['istiyorum', 'istiyoruz', 'isterim', 'isteriz', 'rica', 'ediyorum', 'ederim', 'lazım', 'lazim', 'gerek', 'gerekiyor']),
  // AXD-02 — ileriyi gösteren nesne: "X'e söyle ŞUNU, raporu bitirsin" — ardından ayraç gelirse çerçevedir,
  // gövdeye girmez ("söyle şunu yapsın" — ayraç yok, gövdenin nesnesidir, KALIR).
  frameObjects: Object.freeze(['şunu', 'sunu', 'bunu']),
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

// ── 5e-2. KATALOG SEÇENEK CEVABI (AXC-02) — "ikincisi / rapor olan / hiçbiri" ─
//
// Agent X "Üç görev buldum: birinci…, ikinci…, üçüncü… Hangisi?" diye sorunca
// verilen cevap. Kart açıkken ONAY kapısı (approvalVoice) bu kalıpları seçenek
// düğmelerine çevirir; ret sözleri (hayır/iptal) yine ÖNCE okunur. Sayı rakamı
// ("2") ve çıplak 'none' KASTEN YOK: arayüz sözlüğünde değer (KI-2).
// Her sıra grubunun İLK kelimesi sorunun kendisinde de okunur ("birinci X, ikinci Y"
// — agentxCatalog.ts ORDINALS); sırasını değiştirme.
const CATALOG_CHOICE_WORDS = Object.freeze({
  ordinals: Object.freeze([
    Object.freeze(['birinci', 'birincisi', 'birinciyi', 'birincisini', 'ilki', 'ilkini', 'ilk olan', 'ilk olanı', 'first one', 'the first']),
    Object.freeze(['ikinci', 'ikincisi', 'ikinciyi', 'ikincisini', 'ikinci olan', 'ikinci olanı', 'second one', 'the second']),
    Object.freeze(['üçüncü', 'üçüncüsü', 'üçüncüyü', 'üçüncüsünü', 'ucuncu', 'ucuncusu', 'üçüncü olan', 'third one', 'the third']),
  ]),
  /** Son seçenek (iki adayda ikinci, üçte üçüncü). */
  last: Object.freeze(['sonuncu', 'sonuncusu', 'sonuncuyu', 'sonuncusunu', 'en sondaki', 'last one', 'the last']),
  /** "Hiçbiri" — seçim yok, hiçbir şey açılmaz. */
  none: Object.freeze(['hiçbiri', 'hicbiri', 'hiçbirisi', 'hicbirisi', 'hiçbirini', 'hicbirini', 'hiçbiri değil', 'none of them', 'neither']),
  /** Türle seçme ("rapor olan") — yalnız o türden TEK aday varsa bağlanır. */
  kinds: Object.freeze({
    task: Object.freeze(['görev olan', 'görev olanı', 'görevi', 'görev']),
    report: Object.freeze(['rapor olan', 'rapor olanı', 'raporu', 'rapor']),
    integration: Object.freeze(['entegrasyon olan', 'entegrasyonu', 'entegrasyon']),
    setting: Object.freeze(['ayar olan', 'ayarı', 'ayar']),
    skill: Object.freeze(['skill olan', 'skili', 'skill']),
    memory: Object.freeze(['hafıza olan', 'hafızayı', 'hafıza']),
    team: Object.freeze(['takım olan', 'takımı', 'takım']),
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

// ── 5f1. TASLAK DEMETİ KISMİ DÜZELTME (AXMT-04) — "ikinciyi değiştir", "DC'yi çıkar" ──
//
// Tüketici: `electron/agentxBundle.cjs`. Birden çok iş tek onayla gidecekken bir KALEMİ seçip
// düzeltme sözü. Seçici = sıra sözü (bu küme) YA DA kalemin hedef adı (takım/ajan etiketi —
// veriden gelir, burada YOK). Fiil = ne yapılacağı. Sıra sözleri KÖKTÜR: katlanmış (ü→u, ı→i)
// jetonun başı eşleşir, ek serbesttir ("ikinciyi", "ikincisine", "üçüncüsünü"); İngilizce tam
// jetondur. "son" KASTEN YOK ("sonra" ile çakışır) — yalnız "sonuncu" kökü.
const AGENTX_BUNDLE_WORDS = Object.freeze({
  /** Sıra kökleri — en çok 5 kalem (planlayıcı tavanı MAX_ITEMS). Grup sırası = kalem sırası. */
  ordinals: Object.freeze([
    Object.freeze(['birinci', 'ilk', 'first']),
    Object.freeze(['ikinci', 'second']),
    Object.freeze(['üçüncü', 'ucuncu', 'third']),
    Object.freeze(['dördüncü', 'dorduncu', 'fourth']),
    Object.freeze(['beşinci', 'besinci', 'fifth']),
  ]),
  /** Son kalem kökü. */
  last: Object.freeze(['sonuncu', 'last']),
  /** Kalemi demetten çıkar (gönderilmez). Tam jeton (katlanmış). */
  remove: Object.freeze({
    tr: Object.freeze(['çıkar', 'cikar', 'çıkart', 'cikart', 'sil', 'kaldır', 'kaldir', 'gönderme', 'gonderme', 'iptal']),
    en: Object.freeze(['remove', 'drop', 'delete', 'skip', 'cancel']),
  }),
  /** Kalemin metnini yeniden yaz — fiilden SONRAKİ metin yeni gövdedir ("ikinciyi değiştir: …"). */
  replace: Object.freeze({
    tr: Object.freeze(['değiştir', 'degistir', 'yenile', 'düzelt', 'duzelt']),
    en: Object.freeze(['change', 'replace', 'rewrite']),
  }),
  /** Kaleme ek — fiilden SONRAKİ (ya da fiilden önceki "şunu da"dan sonraki) metin eklenir. */
  add: Object.freeze({
    tr: Object.freeze(['ekle']),
    en: Object.freeze(['add', 'append']),
  }),
  /** "sadece birinciyi gönder" — seçilenler kalır, gerisi çıkar. */
  only: Object.freeze({
    tr: Object.freeze(['sadece', 'yalnız', 'yalniz', 'yalnızca', 'yalnizca']),
    en: Object.freeze(['only', 'just']),
  }),
  /**
   * Düzeltme ÖBEĞİNDE seçici ile fiil arasında durabilen sözler — başka bir söz varsa söz bir
   * düzeltme değil İŞ METNİDİR ("Marvel'in logosunu değiştir" demete ek sayılır, kalemi silmez).
   * Gösterici ("DC'ye OLANI sil"), iş adı ("ilk İŞİ çıkar"), zamir/bağlaç ("ŞUNU DA ekle",
   * "birinciyi VE üçüncüyü"), rica.
   */
  filler: Object.freeze({
    tr: Object.freeze(['olan', 'olanı', 'olani', 'olanını', 'olanini', 'giden', 'gideni', 'iş', 'is', 'işi', 'isi', 'işini', 'isini', 'şunu', 'sunu', 'bunu', 'onu', 'da', 'de', 've', 'lütfen', 'lutfen']),
    en: Object.freeze(['one', 'for', 'the', 'job', 'item', 'this', 'that', 'it', 'also', 'and', 'please', 'to']),
  }),
});

// ── 5f2. TASLAK NİYET SINIFLANDIRICISI (AXD-03) — "bu söz ne?" ─────────────
//
// Tüketici: `electron/draftIntent.cjs` → GÖNDER · EKLE · DÜZELT · İPTAL · BEKLET · BELİRSİZ.
// DRAFT_CONTROL_WORDS'ten FARKI: o küme cümle-sonu KALIP eşler ("bu kadar gönder");
// bu küme TÜKETME kuralını besler — söz YALNIZ buradaki sözcüklerden oluşuyorsa
// kontroldür, tek bir içerik sözcüğü bile varsa EKtir (rapor AX-DRAFT-UX-R1 §4).
// Biçim: TR kelimeler KATLANMIŞ yazılır (draftIntent `fold()`: ç→c ğ→g ı→i ö→o ş→s
// ü→u, kesme işareti düşer) — STT "gönder"/"gonder" ikisini de verebilir, kıyas
// katlanmış biçimde yapılır. Çok kelimeli öğeler BOŞLUKLA yazılır, jeton dizisi
// olarak eşlenir. İngilizce AYRI küme (çeviri değil).
// 🪤 'evet'/'hayir'/'yok'/'var' KUTUPLUDUR: anlamı SORUYA bağlı ("var mı?" → hayır =
//    gönder; "göndereyim mi?" → hayır = GÖNDERME). Bu yüzden `strong` kümesinde
//    DEĞİL, `polarNo`/`polarYes` kümelerinde durur; hangisinin gönderdiğini
//    `question.*` kalıpları belirler (kilit: src/app/i18n/speech.test.mts).
// 🪤 'pardon' TR'de araya girmedir (BEKLET), EN "pardon?" değil — EN belirsiz
//    kümesine KASTEN eklenmedi (katlanmış biçim iki dilde aynı jeton).
const DRAFT_INTENT_WORDS = Object.freeze({
  tr: Object.freeze({
    // Gönderme fiili kökleri. Yalnız `sendSuffixes`teki 2. kişi buyruk / rica / 1. çoğul
    // çekimiyle kapanış; 'göndersin' / 'gönderen' / 'gönderi' İÇERİKTİR.
    sendStems: Object.freeze(['gonder', 'yolla', 'ilet']),
    approve: Object.freeze(['tamam', 'tamamdir', 'olur', 'aynen', 'super', 'harika', 'mukemmel', 'guzel', 'okey', 'ok', 'iyi', 'boyle', 'oldu']),
    thanks: Object.freeze(['tesekkurler', 'tesekkur', 'ederim', 'sagol', 'sag', 'ol', 'eyvallah', 'sagolasin']),
    done: Object.freeze(['bitti', 'bitirdim', 'kadar', 'bu', 'o', 'hepsi']),
    // "var mı?" sorusuna RET (eklenecek yok). Kutup sözcükleri: `polarNo`.
    questionNo: Object.freeze(['hayir', 'yok', 'baska', 'bir', 'sey', 'gerek', 'hic']),
    polarNo: Object.freeze(['hayir', 'yok']),
    polarYes: Object.freeze(['evet']),
    filler: Object.freeze(['hadi', 'haydi', 'bakalim', 'artik', 'simdi', 'lutfen', 'ya', 'yani', 'iste', 'valla', 'lan', 'diyorum', 'evet', 'misin', 'misiniz', 'mi', 'gitsin']),
    // Hitap: söz başında/içinde düşer ("Agent X, gönder").
    // 🪤 Çıplak 'agent' / 'ajan' KASTEN YOK: arayüz sözlüğünde düz etiket (KI-2) — kalıp olarak durur.
    address: Object.freeze(['agent x', 'ajan x', 'agentx', 'ajanx', 'x', 'eks', 'iks', 'hey']),
    // "at gitsin" / "ver gitsin": yalnız 'gitsin' ile birlikte kapanış.
    gitsinVerbs: Object.freeze(['at', 'ver']),
    gitsin: Object.freeze(['gitsin']),
    // Gönderme fiilinin NESNESİ / pekiştirmesi: yalnız bir gönderme fiiliyle birlikte kontrol.
    sendObject: Object.freeze(['onu', 'sunu', 'bunu', 'hepsini', 'taslagi', 'dedim', 'diyorum', 'da', 'de']),
    // Kapanış işareti (kutupsuz). Çıplak 'evet' / 'yok' burada YOK — bkz. polarYes/polarNo.
    strong: Object.freeze(['tamam', 'tamamdir', 'olur', 'aynen', 'super', 'harika', 'mukemmel', 'okey', 'ok', 'iyi', 'bitti', 'bitirdim', 'kadar', 'tesekkurler', 'tesekkur', 'sagol', 'eyvallah', 'gitsin']),
    // Dikte ortasında 'tamam/yok' metin olabilir: yalnız bunlar kapatır.
    strongDictation: Object.freeze(['bitti', 'bitirdim', 'kadar', 'gitsin']),
    cancel: Object.freeze(['vazgec', 'vazgectim', 'iptal', 'iptal et', 'bos ver', 'taslagi sil', 'hepsini sil', 'sil hepsini', 'unut', 'unut gitsin', 'kalsin']),
    hold: Object.freeze(['dur', 'bekle', 'saniye', 'dakika', 'sus', 'pardon', 'dusuneyim', 'biraz', 'sey', 'evet', 'var', 'bir', 'diyecegim', 'soyleyecegim', 'dakka']),
    holdStrong: Object.freeze(['dur', 'bekle', 'saniye', 'dakika', 'sus', 'pardon', 'dusuneyim', 'diyecegim', 'soyleyecegim', 'var', 'evet', 'dakka']),
    // BEKLET cümlesinde içerik sayılmayan ek sözcükler ("şimdilik bekle", "bir dakka da").
    holdExtra: Object.freeze(['simdilik', 'da', 'de', 'ayar', 'cekeyim']),
    fix: Object.freeze(['oyle degil', 'yanlis', 'demedim', 'duzelt', 'cikar', 'sil', 'bastan al', 'degistir', 'yerine', 'degil']),
    // "sonuncuyu sil": bu öneklerden biri + 'sil'.
    fixLastPrefixes: Object.freeze(['sonuncu', 'son']),
    fixLastVerb: Object.freeze(['sil']),
    addMarkers: Object.freeze(['bir de', 'ayrica', 'ekle', 'bir sey daha', 'unutmadan']),
    unclear: Object.freeze(['ne', 'anlamadim', 'hmm', 'hm', 'efendim', 'hii', 'nasil', 'yani', 'ha', 'hih', 'ih', 'aha', 'mhm', 'himm', 'iii']),
    // Karşıtlık: 'tamam AMA …' bir kapanış değildir.
    // 🪤 'önce' DOĞAL yazımla: katlanmış 'once' İngilizce arayüz sözlüğünde düz etiket (KI-2).
    //    draftIntent yüklenirken her kelimeyi zaten katlar.
    contrast: Object.freeze(['ama', 'ancak', 'fakat', 'yalniz', 'önce']),
    // Soru eki ('?' yerine geçer) ve 2. kişi rica sorusu ("gönderir misin?" = buyruk).
    questionParticles: Object.freeze(['mi', 'mu']),
    politeAsk: Object.freeze(['misin', 'misiniz']),
    whWords: Object.freeze(['kime', 'ne', 'neden', 'nasil', 'hangi', 'kim']),
    // Asistanın SORUSU: hangisi sorulduysa 'hayır'ın kutbu odur.
    questionAnything: Object.freeze(['var mi', 'var mu']),
    questionConfirm: Object.freeze(['gondereyim mi', 'gonderelim mi', 'yollayayim mi', 'yollayalim mi', 'ileteyim mi', 'iletelim mi']),
  }),
  en: Object.freeze({
    sendStems: Object.freeze(['send', 'deliver', 'submit']),
    approve: Object.freeze(['ok', 'okay', 'good', 'great', 'perfect', 'fine', 'alright', 'sure', 'cool', 'nice', 'looks good', 'sounds good', 'all good', 'go ahead']),
    thanks: Object.freeze(['thanks', 'thx', 'cheers', 'thank you']),
    done: Object.freeze(['done', 'i am done', 'thats all', 'that is all', 'thats it', 'that is it', 'im done', 'all done']),
    questionNo: Object.freeze(['no', 'nope', 'nah', 'nothing', 'nothing else', 'no thanks', 'not really']),
    polarNo: Object.freeze(['no', 'nope', 'nah', 'nothing']),
    polarYes: Object.freeze(['yes', 'yeah', 'yep']),
    // 🪤 Çıplak 'now' / 'off' / 'finished' / 'change' KASTEN YOK: arayüz sözlüğünde düz etiket (KI-2).
    //    Kalıp olarak durur ('send it now', 'right now', 'send it off', 'change it').
    filler: Object.freeze(['please', 'just', 'so', 'well', 'um', 'uh', 'right now', 'it now', 'send now', 'yes', 'yeah', 'yep']),
    address: Object.freeze([]),
    sendObject: Object.freeze(['it', 'this', 'that', 'them', 'over', 'it off', 'send off', 'away']),
    strong: Object.freeze(['ok', 'okay', 'great', 'perfect', 'alright', 'looks good', 'sounds good', 'all good', 'go ahead', 'done', 'i am done', 'thats all', 'that is all', 'thats it', 'that is it', 'im done', 'all done', 'thanks', 'thank you', 'cheers']),
    strongDictation: Object.freeze(['done', 'i am done', 'thats all', 'that is all', 'thats it', 'that is it', 'im done', 'all done']),
    cancel: Object.freeze(['cancel', 'cancel it', 'never mind', 'nevermind', 'forget it', 'discard it', 'discard the draft', 'drop it', 'scrap it', 'delete everything']),
    // "don't send" / "do not send": bu sözcüklerden biri + gönderme fiili = İPTAL.
    negators: Object.freeze(['dont', 'not', 'never']),
    hold: Object.freeze(['wait', 'hold on', 'hang on', 'one sec', 'one second', 'one moment', 'just a second', 'a second', 'a moment', 'let me think', 'pause']),
    holdStrong: Object.freeze(['wait', 'hold on', 'hang on', 'one sec', 'one second', 'one moment', 'just a second', 'a second', 'a moment', 'let me think', 'pause', 'i have something', 'i have one more thing', 'one more thing', 'ill add something', 'i want to add something', 'theres more', 'there is more']),
    fix: Object.freeze(['thats wrong', 'wrong', 'not that', 'i didnt say', 'i did not say', 'instead', 'replace', 'change it', 'change that', 'remove', 'scratch that', 'undo that', 'fix']),
    addMarkers: Object.freeze(['also', 'add', 'and also', 'one more thing', 'plus']),
    unclear: Object.freeze(['what', 'huh', 'hmm', 'hm', 'eh', 'come again']),
    contrast: Object.freeze(['but', 'though', 'however']),
    politeAsk: Object.freeze(['can you', 'could you', 'would you', 'will you']),
    whWords: Object.freeze(['who', 'what', 'why', 'how', 'which', 'where', 'when', 'should', 'shall']),
    questionAnything: Object.freeze(['anything', 'anything else']),
    questionConfirm: Object.freeze(['shall i send', 'should i send', 'send it', 'can i send']),
  }),
  // Dilbilgisi (speech-grammar): gönderme kökünden SONRA gelebilecek, kapanış sayılan
  // ekler. '' = çıplak kök ("gönder"). 'ir'/'r' + 'misin' = rica sorusu.
  sendSuffixesTr: Object.freeze([
    '', 'in', 'iniz', 'yin', 'yiniz',
    'iver', 'iverin', 'yiver', 'yiverin',
    'ebilirsin', 'abilirsin', 'yabilirsin', 'ebilirsiniz', 'abilirsiniz', 'yabilirsiniz',
    'elim', 'alim', 'yalim', 'iriz',
    'ir', 'r',
    'sene', 'sana', 'senize', 'sanize',
  ]),
});

// ── 5f3. ARAYÜZ ETİKETİ EŞSESLİLERİ (KI-2'nin ANAHTAR KAPSAMLI istisnası) ──────
//
// Ev kuralı: arayüz sözlüğünde çıplak değer olan sözcük leksikona GİRMEZ ('hazır',
// 'now', 'agent' … KASTEN YOK). Bir istisna KAÇINILMAZ: 'yok'. "Bir şey var mı?"
// sorusunun cevabıdır (AXD-03: "yok" = gönder) ve kalıpla değiştirilemez; aynı
// sözcük arayüzde "değer yok" etiketidir. Kapı bu yüzden YALNIZ aşağıdaki sözlük
// ANAHTARLARINDA bu değeri kabul eder — yeni bir anahtara giren 'yok' yine KIRMIZI.
// Yeni satır eklemek bilinçli bir karardır: anahtarın bir ARAYÜZ etiketi olduğunu ve
// leksikondan taşınmadığını gerekçeyle yaz.
const UI_LABEL_HOMOGRAPHS = Object.freeze({
  yok: Object.freeze({
    file: 'src/app/i18n/dictionaries/tr.ts',
    keys: Object.freeze(['taskPanel.none', 'capability.state.missing', 'review.screen.props.none', 'review.check.value.none', 'teamChat.mention.none']),
    why: "arayüzde 'değer yok' etiketi; teamChat.mention.none tırnak eşleşmesi artığı (\"@{query}\" yok)",
  }),
  change: Object.freeze({
    file: 'src/app/i18n/dictionaries/en.ts',
    keys: Object.freeze(['teamChat.to.guessChange', 'teamChat.decision.strip.change']),
    why: "AXMT-04 'bundle.edit' fiili ('change the first: …'); arayüzde küçük harfli 'değiştir' bağlantı etiketi — aynı kelime, ses yolu bu sözlükten okumaz",
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

// ── 5g1. ÇOKLU HEDEF PLANLAYICI (AXMT-01) — "Marvel'e şunu, DC'ye bunu söyle" ──
//
// Tek sözü takım/ajan başına İŞ ve DURUM kalemlerine bölen planlayıcının sözcükleri
// (`electron/agentxPlan.cjs`). Hedef adları BURADA DEĞİL: kullanıcının kadrosu, takım
// listesi ve proje kaydı bağlamdan gelir. Burada yalnız kalemi açan/bağlayan sözler var.
// Öbekler JETON dizisidir (kesme işareti ayırıcı: "DC'ye" → dc ye) ve TAM jeton eşleşir —
// "ne yaptı" öbeği "ne yaptığını"yı (iş gövdesi) TUTMAZ.
// 🪤 'şimdi' ve ASCII 'once' KASTEN YOK (KI-2): ikisi de arayüz sözlüğünde çıplak DEĞER ("şimdi",
// İngilizce "once"). 'simdi' (STT ASCII yazımı) dolgu kümesinde duruyor; "Şimdi, Marvel'e …" sözünde
// 'şimdi' ön yan cümlede tek sözcük kalır ve gövdeye girmez (agentxPlan: önsöz ≥2 sözcük ister).
const AGENTX_PLAN_WORDS = Object.freeze({
  // Yan cümlenin BAŞINDA yeni kalemi haber veren bağlaçlar — gövdeye girmez ("sonra DC'ye söyle …").
  connectors: Object.freeze(['ondan sonra', 'sonra da', 'sonra', 'ardından', 'ardindan', 'ayrıca', 'ayrica', 'bir de', 'önce', 'bunun yanında', 'bunun yaninda', 'son olarak', 'en son da', 'en son']),
  // Aynı cümlede yan cümleleri ayıran bağlaç (virgül/noktalı virgül dışında).
  joiners: Object.freeze(['ve']),
  // "de/da" ilgeci: "DC'ye DE söyle", "Marvel'e de." — eksiltili sözün işareti.
  alsoParticles: Object.freeze(['da', 'de', 'ta', 'te']),
  // "de ki X": söyleme fiili (ilgeç "de" ile karışmasın diye "ki" ile birlikte).
  sayThatTail: Object.freeze(['ki']),
  // Hedef ile iletim fiili arasında durabilen dolgu ("Fury'ye AYRICA söyle", "Marvel'e HEMEN ilet").
  headFillers: Object.freeze(['ayrıca', 'ayrica', 'hemen', 'lütfen', 'lutfen', 'şunu', 'sunu', 'bunu', 'simdi', 'bir', 'de', 'da', 'te', 'ta', 'yine', 'gene']),
  // Rica eki ("söyler MİSİN") — iletim fiilinin parçası, gövde değil.
  politeTails: Object.freeze(['mısın', 'misin', 'musun', 'müsün', 'mısınız', 'misiniz', 'musunuz', 'müsünüz']),
  // Söz başındaki dolgu ("Şey, Marvel'e söyle …") — ilk kalemin gövdesine girmez. Hitap ("Agent X,")
  // SLEEP_ADDRESS_WORDS'ten okunur (tek gerçek).
  preambleFillers: Object.freeze(['şey', 'sey', 'hmm', 'hım', 'him', 'tamam', 'peki', 'bak', 'bakalım', 'bakalim', 'evet', 'hadi', 'haydi', 'simdi', 'ya', 'o zaman']),
  // Kendine yönelme: "BANA söyle / BİZE anlat" bir hedef DEĞİL — durum isteğidir.
  selfDatives: Object.freeze(['bana', 'bize']),
  // "BÜTÜN/TÜM/HER takıma(lara)" — niceleyici + takım ismi (TEAM_NOUN_STEMS) → bütün takımlar.
  allQuantifiers: Object.freeze(['bütün', 'butun', 'tüm', 'tum', 'her']),
  // Tek sözcükle bütün takımlar: iş ("HERKESE söyle") ya da durum ("HERKES ne yapıyor").
  allDatives: Object.freeze(['herkese', 'hepsine', 'hepinize', 'tümüne', 'tumune']),
  allNominatives: Object.freeze(['herkes', 'hepsi', 'hepiniz']),
  // "İKİSİNE de söyle" / "İKİSİ de ne yapıyor" — sözde az önce geçen iki hedef.
  pairDatives: Object.freeze(['ikisine']),
  pairNominatives: Object.freeze(['ikisi', 'ikisinin']),
  // "ÜÇ takıma da söyle" — sayı + takım ismi (rakamla da: "3 takıma").
  countWords: Object.freeze({ iki: 2, 'üç': 3, uc: 3, 'dört': 4, dort: 4, 'beş': 5, bes: 5 }),
  // DURUM sorusu (öbek): "Marvel ne yapıyor / DC nerede kaldı / Transformers ne yaptı".
  statusPhrases: Object.freeze([
    'ne yapıyor', 'ne yapiyor', 'ne yapıyorlar', 'ne yapiyorlar', 'neler yapıyor', 'neler yapiyor',
    'ne yaptı', 'ne yapti', 'ne yaptılar', 'ne yaptilar', 'neler yaptı', 'neler yapti', 'ne yapmış', 'ne yapmis',
    'ne durumda', 'ne durumdalar', 'durumu ne', 'durumları ne', 'durumlari ne', 'durumda mı', 'durumda mi',
    'neler oluyor', 'ne oluyor', 'nasıl gidiyor', 'nasil gidiyor', 'ne alemde', 'ne âlemde',
    'nerede kaldı', 'nerede kaldi', 'nerede kaldılar', 'nerede kaldilar', 'ne oldu', 'en son ne',
    'bitirdi mi', 'bitirdiler mi', 'bitirmiş mi', 'bitirmis mi', 'bitti mi', 'tamamladı mı', 'tamamladi mi',
    'takılan iş var mı', 'takilan is var mi', 'takılan bir iş var mı', 'takilan bir is var mi', 'kim çalışıyor', 'kim calisiyor',
  ]),
  // DURUM isteği (isim + bana-anlat fiili): "Marvel'in DURUMUNU özetle / anlat".
  statusNouns: Object.freeze(['durumunu', 'durumu', 'durumlarını', 'durumlarini', 'özetini', 'ozetini']),
  statusTellVerbs: Object.freeze(['özetle', 'ozetle', 'anlat', 'söyle', 'soyle', 'ver', 'nedir', 'oku']),
});

// ── 5g2. SONUÇ SAYFASINI AÇ (A23-ICTARAYICI) — "açayım mı?" sorusunun cevabı ──
//
// A8 sonucu söyledikten sonra sonuç bir SAYFAYSA Agent X "Sonuç sayfası hazır, açayım
// mı?" diye sorar. Cevap onay kümesinden ("evet", "tamam") YA DA bu kümeden gelir:
// sorunun kendi fiili ("aç", "göster"). Tüketici: `src/app/lib/resultOpen.ts` —
// yalnız soru AÇIKKEN ve cümlenin TAMAMI cevapsa (ADP-903 tek-başına kuralı): "tamam
// şimdi terminali aç" bir KOMUTTUR, cevap değil → bugünkü yoldan akar.
// 🪤 RET kümesi (APPROVAL_DENY_WORDS) önce okunur: "hayır açma" → açılmaz.
const RESULT_OPEN_WORDS = Object.freeze({
  open: Object.freeze({
    tr: Object.freeze([
      'aç', 'ac', 'göster', 'goster', 'aç onu', 'onu aç', 'evet aç', 'evet göster',
      'aç bakalım', 'göster bakalım', 'açabilirsin', 'gösterebilirsin',
      'sayfayı aç', 'sayfayi ac', 'raporu aç', 'raporu ac', 'raporu göster', 'raporu goster',
      'sonucu aç', 'sonucu ac', 'sonucu göster', 'sonucu goster', 'tarayıcıda aç', 'tarayicida ac',
    ]),
    en: Object.freeze([
      'open', 'open it', 'open that', 'show', 'show me', 'show it', 'yes open it',
      'open the page', 'open the report', 'show the report', 'show me the report',
    ]),
  }),
  // Sorunun kendi fiilinin OLUMSUZU ve erteleme ("hayır AÇMA", "sonra bakarım"). Onay
  // kapısının RET kümesi paylaşımlıdır (ADP-903) ve değiştirilmez; bu küme onun yanında okunur.
  decline: Object.freeze({
    tr: Object.freeze([
      'açma', 'acma', 'gösterme', 'gosterme', 'açmana gerek yok', 'kalsın', 'kalsin',
      'sonra', 'sonra bakarım', 'sonra bakarim', 'şimdi değil', 'simdi degil',
    ]),
    en: Object.freeze(['later', 'maybe later', 'skip', 'skip it', 'not yet']),
  }),
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

// ── 5i. OFİS SOHBET ODASI (OFFICE-CHAT-TEAM-01) — yazılı mesajın niyet sözcükleri ──
//
// Tüketici: `electron/officeRoomProtocol.cjs`. Oradan buraya TAŞINDI (INTENT-GATE-FIX-01):
// dosya KI-3'ü kırıyordu ve build:prep'i durduruyordu. Değerler ve SIRA birebir aynı —
// `classifyIntent` listeyi baştan tarar ve İLK eşleşmeyi `by` alanına yazar.
//   • connectors    → hitap jetonları düştükten sonra BAŞTA kalan bağlaç artığı
//                     ("@a ve @b, şunu yap" → "şunu yap"); gövdenin içine dokunulmaz.
//   • questionWords → gerçek soru işaretleri → SORU (canlı penceresi olmayan ajana pencere AÇILMAZ).
//   • jobVerbs      → emir kipinin gövdesi (ek alabilir: "dene", "denesene") → İŞ.
// 🪤 'ne zaman' / 'ne durumda' 'ne'den SONRA gelir: sıra değişirse `by` değişir, hüküm değişmez.
const OFFICE_ROOM_WORDS = Object.freeze({
  connectors: Object.freeze(['ve', 'ile', 'ayrıca', 'ayrica']),
  questionWords: Object.freeze([
    'ne', 'neden', 'niye', 'niçin', 'nasıl', 'kim', 'kime', 'kimin', 'hangi', 'kaç',
    'nerede', 'nereye', 'nereden', 'ne zaman', 'ne durumda', 'var mı', 'oldu mu',
  ]),
  jobVerbs: Object.freeze([
    'yap', 'dene', 'düzelt', 'ekle', 'çıkar', 'yaz', 'koş', 'çalıştır', 'test et',
    'aç', 'kapat', 'güncelle', 'sil', 'taşı', 'kur', 'ölç', 'commit', 'push',
    'incele', 'onar', 'temizle', 'oluştur', 'başlat', 'devam et', 'tekrar',
  ]),
  // CHAT-Q-01 karar kartı: soru metninden TÜRETİLEN seçenek etiketinin BAŞINDA kalınca
  // anlamsızlaşan bağ sözcükleri ("için Sonnet kullanılsın" → "Sonnet kullanılsın").
  // officeRoomProtocol.cjs `derivedLabel`'dan buraya TAŞINDI (INTENT-FIX-24): KI-3'ü kırıyordu.
  labelLeadFillers: Object.freeze(['için', 'icin', 'ile', 'da', 'de', 've', 'bu', 'şu', 'o', 'ya', 'yoksa']),
  // ENG-BLOCK-06: ajanın "KARAR GEREKENLER:" maddesi ile aynı turdaki karar satırını karşılaştırırken
  // benzerliğe sayılmayan bağ sözcükleri (3 harften kısalar zaten düşer). officeRoomProtocol `coverTokens`.
  noteCoverFillers: Object.freeze(['için', 'icin', 'ile', 'yoksa', 'veya', 'daha', 'gibi', 'ayrıca', 'ayrica', 'bir', 'olsun']),
});

// ── OFC-04 — SOHBETTEN İŞ YÖNETİMİ ("@prowl dur", "iptal et") ────────────────
// Takım sohbetine yazılan kısa emir; A9 kapısının içinde `jobControlIntent.cjs` okur.
// Kalıp cümlenin SONUNDA tam eşleşir (uzun biçim önce). Anlatı/olumsuz biçim ("durdurdum",
// "iptal etme") bilerek YOK — eşleşmeyen cümle düz mesaj olarak gider.
//   • phrases   → eylem başına kabul edilen emir/rica biçimleri (TR + EN)
//   • fillers   → anlamı değiştirmeyen sözcükler (hedefe sayılmaz)
//   • caseTails → kesme işaretiyle ayrılan hal/iyelik ekleri ("prowl'un", "Ayşe'ye")
const JOB_CONTROL_WORDS = Object.freeze({
  phrases: Object.freeze({
    stop: Object.freeze(['durdurur musun', 'durdurun', 'durdur', 'durun', 'dur', 'sus', 'stop']),
    pause: Object.freeze(['duraklatır mısın', 'duraklatın', 'duraklat', 'beklet', 'ara ver', 'pause']),
    resume: Object.freeze(['devam eder misin', 'devam edin', 'devam etsin', 'devam et', 'sürdürün', 'sürdür', 'resume', 'continue']),
    cancel: Object.freeze(['iptal eder misin', 'iptal edin', 'iptal et', 'iptal', 'cancel']),
  }),
  fillers: Object.freeze([
    // 'şimdi' / 'now' / 'task' YOK: arayüz sözlüğünde düz etiket olarak geçiyorlar (KI-2).
    'bu', 'şu', 'o', 'iş', 'işi', 'işini', 'işin', 'işine', 'görevi', 'görevini', 'lütfen', 'hemen',
    'artık', 'tamam', 'hadi', 'onu', 'bunu', 'şunu', 'the', 'job', 'please', 'it',
  ]),
  caseTails: Object.freeze(['u', 'ü', 'ı', 'i', 'un', 'ün', 'ın', 'in', 'nun', 'nün', 'nın', 'nin', 'e', 'a', 'ye', 'ya', 'yu', 'yü', 'yı', 'yi']),
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
// ── A11-SES-AYAR — AÇ/KAPA KONTROL DEĞERLERİ ─────────────────────────────────
// Ayarlar → Ses kutularını ("sesli sonuçları kapat") sesle süren kayıt satırlarının
// DEĞER sözleri (electron/uiControls.cjs → ON_OFF). Fiil burada DEĞERİN KENDİSİdir.
// Olumsuz biçim ("kapatma") değer değildir: `tokenMatches` isim ekini tolere eder,
// fiil ekini etmez; kural yolu ayrıca negV ile düşürür.
const TOGGLE_VALUE_WORDS = Object.freeze({
  // İngilizce çıplak 'on'/'off' ve Türkçe 'kapalı' YOK: çeviri sözlüğünde arayüz
  // etiketi olarak geçiyorlar (KI-2) — İngilizce kalıp iki sözcük ('turn off').
  on: Object.freeze(['aç', 'açık', 'etkinleştir', 'turn on', 'enable']),
  off: Object.freeze(['kapat', 'kapa', 'turn off', 'disable']),
});

// ── AXM-01 — TERMİNAL YÖNETİMİ ("2 Claude, 2 düz, 2 Codex aç" · "son açtığın 2 Codex'i kapat") ──
// Tüketiciler: `electron/spawnSpec.cjs` (sayı + motor yürüyüşü) ve `electron/jarvisVoice.js`
// (kapatma dalı). Motor adları pane KOMUTUNA çözülür — anahtarlar `agentRunner.js`
// ALLOWED_COMMANDS anahtarlarıdır (spawnSpec.test.cjs ölçer: listede olmayan motor = KIRMIZI).
//   • engines   → sözlü ad → pane komutu. Çok kelimeli adlar ('cloud code') BİTİŞİK iki
//                 jetondur; 🪤 çıplak 'cloud' YOK (gerçek kelime → yanlış-pozitif spawn).
//                 'shell' satırı "düz terminal"dir; 'boş' burada DEĞİL (aşağıda).
//   • shellBefore → yalnız terminal isminden HEMEN ÖNCE düz terminal olan sözler: "boş
//                 terminal" = düz, ama "5 tane boş codex" = boşta codex (dolgu).
//   • fillers   → sayı ile motor arasındaki dolgu ("5 tane ayrı codex"). ADP-444'ten taşındı.
//                 🪤 'yeni' YOK: tr.ts'te çıplak arayüz değeri (KI-2 — ölçüldü); spawnSpec onu
//                 CATALOG_WORDS.generic emsali AYRI bir desenle tanır.
//   • opened    → "senin açtığın" SIFAT-FİİL KÖKLERİ (önek eşleşmesi: açtığın/açtıkların/
//                 başlattığın). Kapatmayı Agent X'in AÇTIĞI pane'lere daraltır.
//   • idle      → "boştaki terminalleri kapat": yalnız boşta olanlar (çalışana dokunulmaz).
//                 Önek eşleşmesi (boştaki/boştakiler/boştakileri). 🪤 çıplak 'boşta' YOK: tr.ts'te
//                 arayüz değeri (KI-2 — ölçüldü) → iki kelimelik 'boşta olan' ile söylenir.
const TERMINAL_MANAGE_WORDS = Object.freeze({
  engines: Object.freeze({
    claude: Object.freeze(['claude', 'klod', 'claude code', 'cloud code', 'klod kod']),
    codex: Object.freeze(['codex', 'kodeks', 'kodex', 'codeks']),
    opencode: Object.freeze(['opencode', 'open code', 'openkod']),
    cursor: Object.freeze(['cursor', 'kürsör']),
    gemini: Object.freeze(['gemini', 'cemini', 'jemini']),
    shell: Object.freeze(['düz', 'duz', 'shell', 'kabuk', 'normal']),
  }),
  shellBefore: Object.freeze(['boş', 'bos']),
  fillers: Object.freeze(['tane', 'adet', 'ayrı', 'ayri', 'boş', 'bos', 'daha']),
  opened: Object.freeze(['açtığ', 'açtık', 'actig', 'actik', 'başlattığ', 'başlattık', 'baslattig', 'baslattik']),
  idle: Object.freeze(['boştaki', 'bostaki', 'boşta olan', 'bosta olan', 'boşta duran', 'bosta duran']),
});

// ── 5j. KATALOG (AXC-01) — "Coolify entegrasyonunu aç": TÜR ismi + AD ─────────
//
// Agent X artık ⌘K paletinin dizinini arar (src/app/lib/agentxCatalog.ts). Cümleden
// iki şey çıkar: TÜR (başın ismi: "…entegrasyonunu", "…görevini") ve AD (ondan önce
// gelenler: "Coolify", "rapor sistemi"). Türkçe baş-sonda: "rapor sistemi GÖREVİ"
// bir görevdir, rapor değil — tür, fiilden önceki SON tür ismidir.
// Tüketiciler: kural yolu (`electron/jarvisVoice.js` katalog dalı) + renderer
// (`agentxCatalog.ts`, tip cephesi `src/app/lib/intentLexicon.ts`). İki kopya YOK.
//   • kinds    → tür isim KÖKLERİ (isim çekimi serbest: turkishMorph.NOUN_SUFFIX_RE).
//                🪤 'skil' + 'skill' İKİSİ de: "skiller" = skil+ler, "skill" = skill+∅
//                ('skill'+'er' geçerli ek değil — ölçüldü).
//                🪤 'sekme'/'panel' YOK: "<ad> sekmesi" parseIntent §7'de zaten çözülür.
//   • fillers  → addan düşen dolgu (bana, şunu, ile ilgili…) — kök, ek serbest.
//   • generic  → ad TAŞIMAYAN niteleyiciler ("son raporu aç", "tüm görevleri aç"):
//                geriye yalnız bunlar kalırsa katalog dalı SUSAR, eski dal çalışır.
const CATALOG_WORDS = Object.freeze({
  kinds: Object.freeze({
    setting: Object.freeze(['ayar', 'setting']),
    integration: Object.freeze(['entegrasyon', 'integration']),
    skill: Object.freeze(['skill', 'skil', 'beceri', 'yetenek']),
    // 🪤 'task' YOK: en.ts'te çıplak "task" arayüz değeri var (KI-2 — ölçüldü).
    task: Object.freeze(['görev', 'gorev']),
    report: Object.freeze(['rapor', 'report']),
    memory: Object.freeze(['hafıza', 'hafiza', 'bellek', 'memory']),
    team: Object.freeze(['takım', 'takim', 'ekip', 'ekib', 'team']),
  }),
  fillers: Object.freeze([
    'bana', 'benim', 'için', 'icin', 'lütfen', 'lutfen', 'şu', 'su', 'bu', 'o', 'bir', 'bi',
    'ile', 'ilgili', 'alakalı', 'alakali', 'olan', 'hakkında', 'hakkinda', 'hani', 'şey', 'sey',
    'acaba', 'mısın', 'misin', 'musun', 'müsün', 'mi', 'mı', 'mu', 'mü', 'the', 'my', 'please',
  ]),
  generic: Object.freeze([
    // 🪤 'yeni'/'new' YOK: sözlüklerde çıplak arayüz değeri (KI-2 — ölçüldü). "yeni görev"
    // oluşturma niyetidir ve kural yolunda AYRI bir desenle korunur (jarvisVoice catalogBranch).
    'son', 'sonuncu', 'en', 'eski', 'ilk', 'tüm', 'tum', 'bütün', 'butun', 'hepsi', 'diğer', 'diger',
    'açık', 'acik', 'bugünkü', 'bugunku', 'last', 'latest', 'all',
  ]),
});

// ── AXC-03 — TAKIM GEÇİŞİ ("Transformers'a geç" / "ürün takımını aç") ──────
// Tüketici: `electron/teamSwitch.cjs` (kural yolu + renderer yürütücüsü aynı dosya).
//   • goto   → ACTION_VERB_STEMS.goto ile AYNI küme (burada tekrar YAZILMADI, oradan okunur).
//   • reveal → takım İSMİYLE birlikte geçişi anlatan açma fiilleri. 🪤 ACTION_VERB_STEMS.open
//              KULLANILMADI: o kümede 'kur'/'başlat' var ve "ürün takımı kur" bir OLUŞTURMA
//              niyetidir, geçiş değil (ölçüldü: open kümesiyle mevcut takıma geçiyordu).
const TEAM_SWITCH_VERB_STEMS = Object.freeze({
  reveal: Object.freeze(['aç', 'göster', 'goster', 'open']),
});

// ── 5g3. ARAYA GİRME (AXD-07) — geri kanal + bekleyen işlere devam sözleri ──
//
// Agent X konuşurken kullanıcı araya girince ses ÖNCE DURAKLAR, söylenen söz ne
// olduğuna göre karar verilir (src/app/lib/bargeIn.ts):
//   • `backchannel` — dinlediğini belli eden ses ("hı hı", okurken "evet"): KESMEZ,
//     okuma kaldığı yerden sürer (AX-DRAFT-UX-R1 §5, LiveKit "adaptive interruption").
//     Cümlenin TAMAMI bu kümeden olmalı; tek bir içerik sözcüğü varsa geri kanal DEĞİL.
//   • `queueContinue` — araya girilince bekletilen işler sorulur ("devam edeyim mi?");
//     onay kümesine (APPROVAL_ALLOW_WORDS) EK olarak "devam / sürdür" kalıpları.
// 🪤 'tamam' / 'okay' geri kanalda KASTEN YOK: "tamam tamam" Türkçede "yeter, anladım"
//    demektir — bunlar BEKLET sınıfına düşer ve "Tamam, dinliyorum." dedirtir.
// 🪤 'ne?' / 'efendim?' de YOK: duymadığını söyler, okumanın sürmesi yanlış olur.
const BARGE_WORDS = Object.freeze({
  backchannel: Object.freeze({
    tr: Object.freeze([
      'hı', 'hı hı', 'hıhı', 'hıh', 'ıhı', 'ıhım', 'hım', 'hmm', 'hm', 'mhm', 'mm', 'mmm',
      'aha', 'evet', 'evet evet', 'he', 'hee', 'anladım', 'anladim', 'peki',
    ]),
    en: Object.freeze(['uh huh', 'mhm', 'mm hmm', 'mmhmm', 'hmm', 'yeah', 'yes', 'yep', 'right', 'i see', 'got it']),
  }),
  queueContinue: Object.freeze({
    tr: Object.freeze(['devam', 'devam et', 'devam edebilirsin', 'devam edelim', 'devam eder misin', 'sürdür', 'surdur', 'kaldığın yerden devam et', 'kaldigin yerden devam et']),
    en: Object.freeze(['continue', 'go on', 'carry on', 'keep going', 'resume']),
  }),
});

const LEXICON = Object.freeze({
  'catalog.kinds': {
    kind: 'intent-token',
    words: Object.values(CATALOG_WORDS.kinds).flat(),
    why: 'AXC-01: Agent X katalog TÜR isimleri ("…entegrasyonunu aç" → entegrasyon); çevrilirse "Coolify entegrasyonunu aç" genel Entegrasyonlar’a düşer',
  },
  'catalog.fillers': {
    kind: 'intent-token',
    words: [...CATALOG_WORDS.fillers, ...CATALOG_WORDS.generic],
    why: 'AXC-01: katalog adından düşen dolgu + ad taşımayan niteleyiciler ("son raporu aç" katalog aramasına GİRMEZ)',
  },
  'action.verbs': { kind: 'intent-token', words: Object.values(ACTION_VERB_STEMS).flat(), why: 'kural yolu eylem fiilleri (aç/kapat/oku…)' },
  'target.verbs': { kind: 'intent-token', words: TARGETING_VERB_STEMS, why: 'hedefe yönelten fiiller ("X’e söyle")' },
  'target.roles': { kind: 'intent-token', words: ROLE_LEXICON.flatMap((r) => [...r.words, ...r.phrases]), why: 'konuşulan rol adları → roster slug' },
  'target.notName': { kind: 'intent-token', words: NOT_A_NAME_WORDS, why: 'ajan adı sanılmaması gereken sık kelimeler' },
  'speech.longVerbs': { kind: 'intent-token', words: LONG_VERB_STEMS, why: 'uzun iş tahmini (ADP-857 konuşma ekonomisi)' },
  'speech.handoffVerbs': { kind: 'intent-token', words: HANDOFF_VERB_STEMS, why: 'takıma iş devretme fiilleri' },
  'speech.teamNouns': { kind: 'intent-token', words: TEAM_NOUN_STEMS, why: 'takım/ekip/sprint isim kökleri' },
  'team.switchVerbs': { kind: 'intent-token', words: TEAM_SWITCH_VERB_STEMS.reveal, why: 'AXC-03: takım ismiyle geçiş fiilleri ("ürün takımını aç"); çevrilirse geçiş yeniden İŞ VERME sanılır' },
  'stop.verbs': { kind: 'intent-token', words: STOP_VERB_STEMS, why: 'barge-in kesme fiilleri (dur/sus/yeter/bekle)' },
  'stop.deny': { kind: 'intent-token', words: STOP_DENY_WORDS, why: 'morfolojik olarak fiil ama kesme DEĞİL' },
  'stop.nouns': { kind: 'intent-token', words: STOP_NOUN_STEMS, why: 'fiil olmayan kesme sözcükleri' },
  'stop.phrases': { kind: 'intent-token', words: STOP_PHRASES, why: 'çok kelimeli kesme kalıpları' },
  'ambient.addressVariants': { kind: 'intent-token', words: AMBIENT_ADDRESS_WORDS.addressVariants, why: 'AXF-04: asistan adının STT yazımları = hitap' },
  'ambient.productNouns': { kind: 'intent-token', words: AMBIENT_ADDRESS_WORDS.productNouns, why: 'AXF-04: ürün isimleri + soru = uygulama sorusu (arka plan süzgecini geçer)' },
  'ambient.vocatives': { kind: 'intent-token', words: AMBIENT_ADDRESS_WORDS.vocatives, why: 'AXV-04: tekil hitap + soru/istek kipi = asistana söylendi ("Kanka ne durumdayız?")' },
  'ambient.audienceVocatives': { kind: 'intent-token', words: AMBIENT_ADDRESS_WORDS.audienceVocatives, why: 'AXV-04: çoğul seyirci hitabı = yayın dili; istek kipi ve tekil hitap kurallarını susturur' },
  'ambient.themeNouns': { kind: 'intent-token', words: AMBIENT_ADDRESS_WORDS.themeNouns, why: 'AXV-04: 1. çoğul istek kipinin ürün nesnesi ("Gündüz temasına geçelim")' },
  'ambient.themeNames': { kind: 'intent-token', words: AMBIENT_ADDRESS_WORDS.themeNames, why: 'AXV-04: tema adı yönelme hâlinde + geçiş fiili = nesne ("Kağıt Kağıta geçelim")' },
  'ambient.themeDativeSkip': { kind: 'intent-token', words: AMBIENT_ADDRESS_WORDS.themeDativeSkip, why: 'AXV-04: taban sözcüğü ama gündelik zarf — yönelme kuralında nesne SAYILMAZ' },
  'hush.verbs': { kind: 'intent-token', words: HUSH_VERB_STEMS, why: 'CANCEL-01: yalnız sesi kesen fiiller (iş sürer) — kesme kümesinin alt kümesi' },
  'hush.phrases': { kind: 'intent-token', words: HUSH_PHRASES, why: 'CANCEL-01: çok kelimeli susturma kalıpları' },
  'sleep.positive': { kind: 'intent-token', words: SLEEP_POSITIVE_STEMS, why: 'OLUMLU biçimi uyku komutu olan kökler' },
  'sleep.negated': { kind: 'intent-token', words: SLEEP_NEGATED_STEMS, why: 'OLUMSUZ biçimi uyku komutu olan kökler' },
  'sleep.phrases': { kind: 'intent-token', words: SLEEP_PHRASES, why: 'çok kelimeli uyku kalıpları' },
  'sleep.reflexive': { kind: 'intent-token', words: [...SLEEP_REFLEXIVE_STEMS, ...SLEEP_REFLEXIVE_PRONOUNS], why: 'AX-SLEEP-IMPL-01: "kendini uyut/kapat" — zamirsiz ettirgen başka nesnedir' },
  'sleep.listenObject': { kind: 'intent-token', words: [...SLEEP_LISTEN_OBJECT, ...SLEEP_LISTEN_OBJECT_VERBS], why: 'AX-SLEEP-IMPL-01: "dinlemeyi bırak/kes" UYKUDUR, kesme değil (çalışan iş iptal edilmez)' },
  'sleep.nominal': { kind: 'intent-token', words: [...SLEEP_NOMINAL_HEADS, ...SLEEP_NOMINAL_VERBS], why: 'AX-SLEEP-IMPL-01: ad+fiil ("dinlenmeye geç", "uykuya dal")' },
  'sleep.wholeClause': { kind: 'intent-token', words: SLEEP_WHOLE_CLAUSE, why: 'AX-SLEEP-IMPL-01: cümleciğin TAMAMI olunca uyku (veda: görüşürüz / iyi geceler)' },
  'sleep.fillers': { kind: 'intent-token', words: [...SLEEP_FILLERS, ...SLEEP_ADDRESS_WORDS], why: 'AX-SLEEP-IMPL-01: içerik tavanına sayılmayan dolgu + hitap; çevrilirse uzun uyku cümleleri tavana takılır' },
  'sleep.truncation': { kind: 'intent-token', words: [...SLEEP_TRUNC_STUBS, ...SLEEP_TRUNC_PREV], why: 'AX-SLEEP-IMPL-01: STT kesiği "… git uy."' },
  'sleep.en': { kind: 'intent-token', words: [...SLEEP_EN.core, ...SLEEP_EN.prefix, ...SLEEP_EN.suffix, ...SLEEP_EN.neg], why: 'AX-SLEEP-IMPL-01: İngilizce uyku kümesi (çeviri değil, ayrı küme)' },
  'sleep.promise': { kind: 'intent-token', words: [...SLEEP_PROMISE.tr, ...SLEEP_PROMISE.en], why: 'AX-SLEEP-IMPL-01: beynin uyku SÖZÜ → gerçek uyku (söz = eylem)' },
  'sleep.promiseHush': { kind: 'intent-token', words: [...SLEEP_PROMISE_HUSH.tr, ...SLEEP_PROMISE_HUSH.en], why: 'AX-SLEEP-IMPL-01: susma sözü UYKU DEĞİL — yalnız teşhis izi' },
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
  'approval.always': {
    kind: 'intent-token',
    words: [...APPROVAL_ALWAYS_WORDS.tr, ...APPROVAL_ALWAYS_WORDS.en],
    why: 'A22: izin menüsünde "her zaman izin ver" cevabı (TR+EN) sesle SEÇİLMEZ; çevrilirse yıkıcı seçenek sesle seçilebilir hâle gelir',
  },
  'router.sets': {
    kind: 'intent-token',
    words: Object.values(PROMPT_ROUTER).flat(),
    why: 'AXP-01: niyet yönlendirici (aksiyon/prompt/belirsiz/yok) iş fiilleri, iş isimleri, olumsuz kutup, 3.tekil freni, "sen yap" kalıpları',
  },
  'toggle.values': {
    kind: 'intent-token',
    words: [...TOGGLE_VALUE_WORDS.on, ...TOGGLE_VALUE_WORDS.off],
    why: 'A11: Ayarlar → Ses aç/kapa kutularının sesli DEĞERLERİ (TR+EN); çevrilirse "sesli sonuçları kapat" sessizce ölür',
  },
  'draft.control': {
    kind: 'intent-token',
    words: Object.values(DRAFT_CONTROL_WORDS).flatMap((g) => [...g.tr, ...g.en]),
    why: 'AXP-02: taslak kontrol sözleri (gönder / sonuncuyu sil / baştan al / şunu da ekle / düzelt) TR+EN; çevrilirse sesle iş yazdırma sessizce ölür',
  },
  'plan.words': {
    kind: 'intent-token',
    words: [
      ...Object.entries(AGENTX_PLAN_WORDS).flatMap(([k, v]) => (k === 'countWords' ? Object.keys(v) : v)),
    ],
    why: 'AXMT-01: çoklu hedef planlayıcı — kalem bağlaçları, "de/da" eksiltisi, niceleyiciler (bütün/ikisine/üç takıma), durum öbekleri; çevrilirse tek söz yine TEK işe iner ve başka takımın talimatı yanlış işe karışır',
  },
  'bundle.edit': {
    kind: 'intent-token',
    words: [
      ...AGENTX_BUNDLE_WORDS.ordinals.flat(), ...AGENTX_BUNDLE_WORDS.last,
      ...['remove', 'replace', 'add', 'only', 'filler'].flatMap((k) => [...AGENTX_BUNDLE_WORDS[k].tr, ...AGENTX_BUNDLE_WORDS[k].en]),
    ],
    why: 'AXMT-04: taslak demetinde kalem seçici sıra kökleri + kısmi düzeltme fiilleri ("ikinciyi değiştir", "DC\'yi çıkar", "sadece birinciyi gönder") TR+EN; çevrilirse demetin tek kalemi sesle düzeltilemez, kullanıcı tümünü iptal etmek zorunda kalır',
  },
  'draft.intent': {
    kind: 'intent-token',
    words: [...new Set(['tr', 'en'].flatMap((l) => Object.values(DRAFT_INTENT_WORDS[l]).flat()))],
    why: 'AXD-03: taslak niyet sınıflandırıcısının kontrol sözcükleri (gönder/onay/teşekkür/kutuplu evet-hayır/iptal/beklet/düzelt/ekle) TR(katlanmış)+EN; çevrilirse "tamam teşekkürler" prompta METİN olarak yazılır',
  },
  'draft.intent.sendSuffixes': {
    kind: 'speech-grammar',
    words: DRAFT_INTENT_WORDS.sendSuffixesTr.filter(Boolean),
    why: 'AXD-03: gönder/yolla/ilet kökünden sonra KAPANIŞ sayılan 2. kişi buyruk/rica ekleri; "göndersin" (3. kişi) içerik kalır',
  },
  'barge.backchannel': {
    kind: 'intent-token',
    words: [...BARGE_WORDS.backchannel.tr, ...BARGE_WORDS.backchannel.en],
    why: 'AXD-07: araya girmede GERİ KANAL ("hı hı", okurken "evet") — ses duraklar ama okuma kaldığı yerden sürer; çevrilirse her "hı hı" konuşmayı keser',
  },
  'barge.queueContinue': {
    kind: 'intent-token',
    words: [...BARGE_WORDS.queueContinue.tr, ...BARGE_WORDS.queueContinue.en],
    why: 'AXD-07: araya girince bekletilen işler için "devam edeyim mi?" sorusunun "devam / sürdür" cevapları (onay kümesine ek); çevrilirse bekleyen işler sesle sürdürülemez',
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
  'result.open': {
    kind: 'intent-token',
    words: [...RESULT_OPEN_WORDS.open.tr, ...RESULT_OPEN_WORDS.open.en, ...RESULT_OPEN_WORDS.decline.tr, ...RESULT_OPEN_WORDS.decline.en],
    why: 'A23: "sonuç sayfası hazır, açayım mı?" sorusunun AÇ ve AÇMA cevabı (aç/göster/raporu göster · açma/sonra · open/show/later) TR+EN; çevrilirse sonuç sayfası sesle açılamaz',
  },
  'router.choice': {
    kind: 'intent-token',
    words: [...PROMPT_CHOICE_WORDS.agent.tr, ...PROMPT_CHOICE_WORDS.agent.en, ...PROMPT_CHOICE_WORDS.app.tr, ...PROMPT_CHOICE_WORDS.app.en],
    why: 'AXP-01: belirsiz sorusunun sesli cevabı — "ajana" / "uygulamada" (TR+EN); çevrilirse sesli seçim sessizce ölür',
  },
  'catalog.choice': {
    kind: 'intent-token',
    words: [
      ...CATALOG_CHOICE_WORDS.ordinals.flat(), ...CATALOG_CHOICE_WORDS.last, ...CATALOG_CHOICE_WORDS.none,
      ...Object.values(CATALOG_CHOICE_WORDS.kinds).flat(),
    ],
    why: 'AXC-02: katalog seçenek sorusunun sesli cevabı — "ikincisi" / "rapor olan" / "hiçbiri" (TR+EN); çevrilirse seçenek kartı sesle seçilemez',
  },
  'office.room': {
    kind: 'intent-token',
    words: [...OFFICE_ROOM_WORDS.connectors, ...OFFICE_ROOM_WORDS.questionWords, ...OFFICE_ROOM_WORDS.jobVerbs],
    why: 'OFFICE-CHAT-TEAM-01: ofis sohbet odası — baştaki bağlaç artığı, soru sözcükleri, iş fiilleri (soru → pencere açılmaz, iş → açılır); çevrilirse yazılı iş isteği soru sanılır ve ajan uyanmaz',
  },
  'office.labelFillers': {
    kind: 'intent-token',
    words: OFFICE_ROOM_WORDS.labelLeadFillers,
    why: 'CHAT-Q-01: karar kartı seçenek etiketinin başından atılan bağ sözcükleri (için/ile/bu/yoksa…); çevrilirse Türkçe soru metninden türeyen düğme "için Sonnet kullanılsın" gibi bağlaçla başlar',
  },
  'office.noteCoverFillers': {
    kind: 'intent-token',
    words: OFFICE_ROOM_WORDS.noteCoverFillers,
    why: 'ENG-BLOCK-06: eski "KARAR GEREKENLER" maddesini aynı turdaki karar satırıyla eşleştirirken sayılmayan bağ sözcükleri; çevrilirse "için/ile" ortak sözcük sayılır ve yanlış madde karşılanmış görünür',
  },
  'job.control': {
    kind: 'intent-token',
    words: [...Object.values(JOB_CONTROL_WORDS.phrases).flat(), ...JOB_CONTROL_WORDS.fillers],
    why: 'OFC-04: sohbetten iş yönetimi — durdur/duraklat/sürdür/iptal emirleri + dolgu sözcükleri (TR+EN); çevrilirse "@prowl dur" düz mesaja düşer ve iş durmaz',
  },
  'terminal.manage': {
    kind: 'intent-token',
    words: [
      ...Object.values(TERMINAL_MANAGE_WORDS.engines).flat(),
      ...TERMINAL_MANAGE_WORDS.shellBefore,
      ...TERMINAL_MANAGE_WORDS.fillers,
      ...TERMINAL_MANAGE_WORDS.opened,
      ...TERMINAL_MANAGE_WORDS.idle,
    ],
    why: 'AXM-01: terminal açma/kapatma — motor adları (claude/codex/opencode/cursor/gemini/düz), dolgu, "senin açtığın" kökleri, "boştaki"; çevrilirse "2 düz terminal aç" tek pane açar, "son açtığın 2 Codex\'i kapat" YENİ Codex açar',
  },
  'job.control.caseTails': {
    kind: 'speech-grammar',
    words: JOB_CONTROL_WORDS.caseTails,
    why: 'OFC-04: kesme işaretiyle ayrılan hal/iyelik ekleri ("prowl\'un işini") — hedef adından ayıklanır',
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
  { file: 'electron/spawnSpec.cjs', kind: 'intent-token', marker: 'required', why: 'AXM-01: sayı + motor yürüyüşü; motor adları ve dolgu leksikonda (TERMINAL_MANAGE_WORDS), sayı kelimeleri (NUM_WORDS) sayı dilbilgisidir' },
  { file: 'electron/entityResolve.cjs', kind: 'intent-token', marker: 'required', why: 'yönelme hâli deseni (DATIVE_NAME_RE) — dilbilgisi, kelime değil' },
  { file: 'electron/promptRouter.cjs', kind: 'intent-token', marker: 'required', why: 'AXP-01 niyet yönlendirici ÖBEK desenleri ("de ki", "için bir iş", 3. tekil emir eki); kelimeler leksikonda (PROMPT_ROUTER)' },
  { file: 'electron/agentxPlan.cjs', kind: 'intent-token', marker: 'required', why: 'AXMT-01 çoklu hedef planlayıcı: hâl eki desenleri (yönelme/tamlayan/bulunma) ve 3. tekil emir — dilbilgisi; kelimeler leksikonda (AGENTX_PLAN_WORDS)' },
  { file: 'electron/agentxDraft.cjs', kind: 'intent-token', marker: 'required', why: 'AXP-02 taslak durum makinesi ÖBEK desenleri ("X yerine Y yaz", tırnak, cümle sonundaki kapanış sözü); kelimeler leksikonda (DRAFT_CONTROL_WORDS)' },
  { file: 'electron/agentxBundle.cjs', kind: 'intent-token', marker: 'required', why: 'AXMT-04 taslak demeti: kalem seçici ÖBEK deseni (hedef adı + hâl eki, ":" sonrası yeni gövde) — dilbilgisi; kelimeler leksikonda (AGENTX_BUNDLE_WORDS)' },
  { file: 'electron/draftIntent.cjs', kind: 'intent-token', marker: 'required', why: 'AXD-03 taslak niyet sınıflandırıcısı: olumsuz-gönderme EK deseni, 1. tekil istek / gelecek / 3. kişi buyruk ekleri (dilbilgisi); kelimeler leksikonda (DRAFT_INTENT_WORDS)' },
  { file: 'src/app/lib/speechPolicy.ts', kind: 'intent-token', marker: 'required', why: 'soru/istek öbek desenleri' },
  { file: 'src/app/lib/voiceEndpoint.ts', kind: 'speech-grammar', marker: 'required', why: 'Türkçe bağlaç/edat/belirteç/dolgu/sayı + zarf-fiil ekleri: cümle BİTTİ Mİ kararı; algoritmasının yanında anlamlı' },
  { file: 'src/app/lib/voiceRuntime.ts', kind: 'intent-token', marker: 'required', why: 'kesme sınıflandırıcısı (kelimeler leksikondan gelir)' },
  { file: 'electron/ambientSpeech.cjs', kind: 'intent-token', marker: 'required', why: 'AXF-04 arka plan süzgeci: muhatap/emir EK desenleri (dilbilgisi); kelimeler leksikonda (AMBIENT_ADDRESS_WORDS)' },
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
  CATALOG_CHOICE_WORDS,
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
  SLEEP_REFLEXIVE_STEMS,
  SLEEP_REFLEXIVE_PRONOUNS,
  SLEEP_LISTEN_OBJECT,
  SLEEP_LISTEN_OBJECT_VERBS,
  SLEEP_NOMINAL_HEADS,
  SLEEP_NOMINAL_VERBS,
  SLEEP_WHOLE_CLAUSE,
  SLEEP_FILLERS,
  SLEEP_ADDRESS_WORDS,
  SLEEP_TRUNC_STUBS,
  SLEEP_TRUNC_PREV,
  SLEEP_EN,
  SLEEP_PROMISE,
  SLEEP_PROMISE_HUSH,
  AMBIENT_ADDRESS_WORDS,
  SCROLL_EN,
  APPROVAL_ALLOW_WORDS,
  APPROVAL_DENY_WORDS,
  APPROVAL_ALWAYS_WORDS,
  PROMPT_ROUTER,
  PROMPT_CHOICE_WORDS,
  RESULT_OPEN_WORDS,
  TOGGLE_VALUE_WORDS,
  DRAFT_CONTROL_WORDS,
  DRAFT_INTENT_WORDS,
  AGENTX_BUNDLE_WORDS,
  UI_LABEL_HOMOGRAPHS,
  RETRY_DELIVERY_WORDS,
  AGENTX_PLAN_WORDS,
  THEME_BASE_WORDS,
  OFFICE_ROOM_WORDS,
  JOB_CONTROL_WORDS,
  CATALOG_WORDS,
  TEAM_SWITCH_VERB_STEMS,
  TERMINAL_MANAGE_WORDS,
  BARGE_WORDS,
  // sınıf işareti + kapı yüzeyi
  LEXICON,
  allWords,
  PROTECTED_SURFACES,
  INTENT_TOKEN_MARKER,
  i18nExemptions,
};
