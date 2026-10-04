// ADP-203 — user settings store (~/.crewpane/settings.json).
//
// A single JSON file the user edits from the in-app Settings panel (ADP-203) and
// that the MAIN process reads at startup + on demand. Holds the things that used to
// be hard-coded / dev-only and broke the packaged build:
//   • workspaceRoot — where AGENT panes spawn (cwd) + the file-tree root. The packaged
//     app's REPO_ROOT points INSIDE the bundle (path.join(__dirname,'..') → app.asar),
//     so a delegated worker landed in /Applications/.../Resources and couldn't see the
//     real project (the ADP-187 cwd bug). Setting this to the real checkout fixes it.
//   • apiKeys.openai — the OPENAI_API_KEY for Sid voice (STT/brain/TTS). The packaged
//     app ships no .env.local, so voice was dead with "OPENAI_API_KEY yok".
//   • pushToTalkKey — Sid's push-to-talk key (default RightCommand; right Option clashed
//     with Eren's CrewPane Voice app).
//   • wakeModelPath — optional override for the wake-word .onnx, so a freshly trained
//     "Hey Sid" model drops in WITHOUT an app rebuild.
//   • mcpServers — optional extra MCP servers to expose to agents.
//
// Pure-ish: all IO is best-effort + guarded; a missing/corrupt file → DEFAULTS (never
// throws). The renderer reaches this through preload `settingsApi` (get/set) + IPC.

const fs = require('fs');
const os = require('os');
const path = require('path');
const instancePaths = require('../config/instancePaths.cjs'); // ADP-206 — instance-scoped config dir
const crewpaneEnv = require('../config/crewpaneEnv.cjs'); // ADP-244 Faz 3 — CREWPANE_* ⇄ CREWPANE_* dual-read
const codeIndex = require('../services/codeIndex.cjs'); // CIDX-1 — kod indeksi ayarının şeması (tek gerçek)
const buildChannel = require('../config/buildChannel.cjs'); // ADP-646 — "müşteri build'i mi?" (PLAN-FIX-01 F-3/FIX-B)
const updateChannel = require('../services/updateChannel.cjs'); // ADP-620 — yayın kanalı (stable|beta) tek gerçeği
const browserTrust = require('../security/browserTrust.cjs'); // ADP-343 — güven şemasının SÖZLÜĞÜ (mod adları) tek yerde
const teamScope = require('./teamScope.cjs'); // ADP-717 — takım kapsamı izinlerinin şeması/sanitizer'ı
const teamCompose = require('./teamCompose.cjs'); // TC-01 — takım kurucu özerklik kademeleri (tek sözlük)
const settingsMigrations = require('../services/settingsMigrations.cjs'); // ADP-844 — kaldırılan özelliklerin ayar artıkları
const appI18n = require('../../i18n/index.cjs'); // ADP-888 — arayüz dili tercihinin kapalı listesi (tek gerçek)
const leaderRefreshPolicy = require('./leaderRefreshPolicy.cjs'); // LDR-F1 — lider tazeleme kipinin kapalı listesi (tek gerçek)
const handOverlayContract = require('../hand/handOverlayContract.cjs'); // HAND-A1 — el kontrolü overlay ayarlarının kapalı listesi (tek gerçek)
const customProvider = require('../services/customProvider.cjs'); // ENG-OPENAI-COMPAT-01 — kullanıcının kendi OpenAI-uyumlu ucunun kapısı (tek gerçek)
// ADP-874 (790 K1) — ayar yazımının rename adımı platform boğazından geçer (win32
// retry + tmp artığı temizliği). darwin'de tek atış: davranış bit-bit aynı.
const { atomicWriteFileSync } = require('../../platform/atomicWrite.cjs');

// ADP-206 — resolved LAZILY (not a load-time const) so the instance id main.js pins
// into the env (CREWPANE_INSTANCE) is honored regardless of require order: PROD
// ~/.crewpane/settings.json, DEV ~/.crewpane-dev/settings.json.
// ADP-946 — son yazımın hükmü + uygulama log'u dikişi. `writeSettings` FIRLATMAZ
// (ADR-W10 Kural 2), o yüzden "kalıcı oldu mu" sorusunun cevabı BURADA yaşar.
// Modülün BAŞINDA tanımlı: aşağıdaki fonksiyonlardan biri modül yüklenirken
// çağrılırsa TDZ ReferenceError'ı bir `catch`e yutulurdu (ADP-833 mayını).
let _lastPersist = { ok: true, code: null, reason: 'no-write-yet', inPlace: false, file: null };
let _persistLogger = null;

function settingsDir() {
  return instancePaths.crewpaneHome();
}
function settingsPath() {
  return path.join(settingsDir(), 'settings.json');
}

// The key codes the renderer's keydown handler matches against (event.code), so the
// default + the picker speak the same language. Right Option is intentionally ABSENT
// (it clashes with CrewPane Voice).
const PUSH_TO_TALK_KEYS = ['MetaRight', 'ControlRight', 'MetaLeft', 'AltRight'];
const DEFAULT_PUSH_TO_TALK_KEY = 'MetaRight'; // right ⌘

// ADP-258 — app theme. Renderer-owned semantics (mode + accent hex); main only
// persists it as the durable source of truth (localStorage is the boot cache).
// ADP-812 — ses seçicinin eskiden HER kayıtta diske yazdığı TTS modeli. Kullanıcı
// tercihi değil, artık: okuma yolunda düşürülür (bkz. readSettings).
const LEGACY_PINNED_TTS_MODEL = 'tts-1-hd';

const THEME_MODES = ['dark', 'light', 'system'];
const THEME_ACCENT_RE = /^#[0-9a-fA-F]{6}$/;

function defaults() {
  return {
    workspaceRoot: null, // null → caller falls back to REPO_ROOT
    // BL-01 — kullanıcının BİLDİĞİ çalışma alanı kökleri (paket tavanının sayım
    // tabanı; defter workspaceOnboarding.knownWorkspaces'te yorumlanır — aktif kök
    // her hâlükârda bilinir sayılır, diskte olmayanlar budanır).
    knownWorkspaces: [],
    // ADP-234 — optional department → project-dir mapping for worker spawn cwd:
    // { "<department>": "<abs path | path relative to workspaceRoot>" }.
    // null → built-in CrewPane sibling layout (departmentDirs.cjs DEPARTMENT_SUBPATH).
    departmentDirs: null,
    // B-01 (GIT-BACKBONE-SPEC K2/A-1) — proje slug → REPO dizini:
    // { "<proje>": "<mutlak yol | workspaceRoot'a göreli>" }. `departmentDirs`in
    // KARDEŞİ ama farklı soru: o "kanat hangi dizinde çalışır" (pane cwd), bu
    // "board projesi hangi git repo'su" (branch/worktree kökü). null → otomatik
    // çözüm (projectRepos.cjs: <workspaceRoot>/<slug> → <workspaceRoot>).
    projectRepos: null,
    // B-01 (§2.1 ilke 3) — proje slug → izolasyon modu: { "<proje>": "worktree"|"off" }.
    // VARSAYILAN KAPALI: bugünkü kurulumlarda proje kaydı yok ve açık gelseydi her
    // spawn "repo tanımlı değil" ile DURURDU (bir iyileştirme çalışan uygulamayı
    // kırardı). Bir proje açıldığında o proje için sessiz paylaşımlı-ağaç YOKTUR.
    projectIsolation: null,
    // CIDX-1 (CODE-INDEX-R1 §5) — proje slug → kod indeksi kaydı:
    // { "<proje>": { enabled:boolean, indexedSha:string|null, lastIndexedAt:number|null } }.
    // 🔴 VARSAYILAN KAPALI ve bu bir ölçüm sonucudur, tercih değil — ama GEREKÇE
    // 09.09'da DEĞİŞTİ (CODEINDEX-PROOF-01 §4, CODEINDEX-TEXT-01): eski gerekçe
    // "≈5.300 jeton/tur + oturumların yalnız %29'unda amorti" idi; iki sayı da
    // ölçülmemiş TAHMİNDİ ve uçtan uca ölçülünce düştü (gerçek yük 216 jeton/tur —
    // motor araç şemalarını talep üzerine yüklüyor, bağlama yalnız araç ADLARI
    // giriyor). Kapalı kalma sebebi artık jeton değil DEĞER: A/B'de ajan indeks
    // araçlarını kendiliğinden çağırmadı ve cevap doğruluğu açık/kapalı AYNI kaldı.
    // `projectIsolation` ile aynı kapsam kuralı: çalışma alanı geneli TEK anahtar YOK.
    codeIndex: null,
    apiKeys: {}, // { openai?: string, groq?: string, … }  ← SIR: settings:get bunları ASLA döndürmez
    // ENG-OPENAI-COMPAT-01 — kullanıcının KENDİ OpenAI-uyumlu ucu (tek kayıt).
    // null = hiç eklenmemiş → sağlayıcı defteri bugünküyle BİREBİR aynı kalır.
    // SIR DEĞİL (ad + adres + model listesi); anahtar ayrı yaşar: apiKeys.custom.
    customProvider: null,
    // ADP-844 — kaldırılmış özelliklerin ayar alanları burada YOKTUR ve kullanıcının
    // diskindeki artıkları settingsMigrations.cjs bir kez temizler (defter orada).
    // HAND-A1 — "El kontrolü" ekran üstü görselleştirme katmanı. Varsayılan AÇIK
    // (Eren kararı 31.08): kamera penceresi kapalıyken tek göstergedir. density
    // kapalı listesi handOverlayContract.cjs'te (tek gerçek).
    handControl: {
      overlay: { ...handOverlayContract.DEFAULT_HAND_CONTROL.overlay },
      // HAND-BUG-01 — kullanıcının kamera seçimi (null = politika seçsin).
      camera: { ...handOverlayContract.DEFAULT_HAND_CONTROL.camera },
      // HAND-G4 — bu iki kutu VARSAYILANDA da eksikti: dosyası olmayan taze bir
      // profilde `handControl.zoom`/`tuning` undefined dönüyordu, yani okuyucular
      // (klinik, fsmConfig) varsayılanı ürünün TEK GERÇEĞİNDEN alamıyordu. Sözleşme
      // varsayılanı burada da tek kaynaktır (handOverlayContract).
      zoom: { ...handOverlayContract.DEFAULT_HAND_CONTROL.zoom },
      tuning: { ...handOverlayContract.DEFAULT_HAND_CONTROL.tuning },
    },
    // ADP-304 — EKRAN (toast) filtreleri: 5 bildirim sınıfı. "worker bitti" ekranda
    // fırtına yaratıyordu → varsayılan olarak yalnız zilde.
    notifications: {
      toast: { workerDone: false, delegationDone: true, approval: true, error: true, limit: true },
    },
    // ADP-303 — a pane whose process EXITS is closed automatically (the office must not keep
    // "[pty exited: 143]" zombies). true → keep the dead pane so its output stays readable.
    keepExitedPanes: false,
    // HATA-07 — "Görev sınıfına göre otomatik model" (ADP-565 politikası).
    // 🔴 VARSAYILAN KAPALI ve bu bilinçli: kullanıcı ajanı kurarken bir model
    // SEÇTİYSE ürün onu koşar. Politika (routine → haiku, P0 → opus) ancak bu
    // anahtar açıkken kadronun seçimini ezebilir. Kapalıyken de politika ölmez —
    // hiç model seçilmemiş ajanda hâlâ son basamak olarak devreye girer
    // (src/app/lib/modelPolicy.ts → resolveModel).
    autoModelByTaskClass: false,
    // LDR-F1 — LİDER OTURUMUNUN OTOMATİK TAZELENMESİ: 'off' | 'warn' | 'auto'.
    // 🔴 VARSAYILAN 'warn' ve bu bilinçli: `auto` seçilmeden ürün liderin pane'ine
    // KENDİLİĞİNDEN tek bayt yazmaz. Lider bağlamını silmek geri alınamaz bir
    // işlemdir (`/clear`); bu ürünün yapabileceği en pahalı yanlış odur. `warn`
    // kipinde yalnız rozet uyarır — karar kullanıcınındır, bir kez açar.
    leaderAutoRefresh: 'warn',
    // SYNC-F1-6 — BULUT SENKRONU: varsayılan KAPALI (opt-in, tasarım §5.3 · §9.3).
    // Sebebi gizlenmez: FAZ 1'de hafıza ve skill dosyaları CrewPane bulutunda
    // ŞİFRELENMEMİŞ durur. Bir kullanıcının verisini sormadan buluta taşımak, bu
    // sınırla birlikte kabul edilemez — bu yüzden varsayılan `false` ve ekran
    // açarken uyarıyı GÖSTERİR.
    cloudSyncEnabled: false,
    // SYNC-F1-7 — TERCİH PROJEKSİYONU: bulut senkronu AÇIKKEN taşınabilir
    // tercihlerin (tema, dil, düzen, davranış anahtarları) da taşınıp
    // taşınmayacağı. Varsayılan AÇIK: `cloudSyncEnabled` zaten opt-in'dir ve
    // kullanıcı senkronu açtığında beklediği şey "ikinci cihazda benim gibi
    // görünmesi"dir. Bu anahtar ÖZELLİĞİN GERİ ALMA KOLUdur: `false` yazıldığı
    // an projektör yazmayı, uygulayıcı uygulamayı bırakır (dosya taşınmaya devam
    // eder ama YEREL DURUMA DOKUNULMAZ) — yeniden başlatma gerekmez.
    // ⚠️ Bu anahtar KENDİSİ taşınabilir DEĞİLDİR (prefsWhitelist dışında): bir
    // cihazdan diğerinin senkron davranışını kapatmak kullanıcının kararı değil.
    prefsSyncEnabled: true,
    // ADP-715 — Telemetri (hata takibi + gizlilik-dostu kullanım ölçümü). OPT-OUT:
    // varsayılan AÇIK, kullanıcı kapatabilir. İçerik ASLA gönderilmez (scrub.cjs).
    telemetryEnabled: true,
    telemetryNoticeShown: false,
    // ADP-845 — heartbeat'in KALICI durumu. `installId` rastgele bir uuid'dir:
    // KURULUMU tanımlar, kullanıcıyı/donanımı DEĞİL (MAC/seri/hostname okunmaz).
    // Kullanıcı bu satırı silerse yeni bir kimlik doğar — bilinçli.
    //   { installId, sessions, daysSeen, lastDay, counters: {beyaz-listeli sayaçlar} }
    telemetryState: { installId: null, sessions: 0, daysSeen: 0, lastDay: null, counters: {} },
    // ADP-533 — Faz 1 güncelleme bildirimi: açılışta + ~6 saatte bir GitHub Releases'tan
    // son sürümü kontrol et (yalnız BİLDİRİM; indirme tarayıcıda, kurulum elle).
    updateAutoCheck: true,
    // ADP-533 — "bu sürüm için sonra": kapatılan bildirim sürümü. localStorage restart'ı
    // atlatmaz (random-port origin) → kalıcılık settings.json'da. Daha yeni bir sürüm
    // çıkınca dismiss otomatik geçersizleşir (karşılaştırma sürüm-bazlı).
    updateDismissedVersion: null,
    // ADP-907 — "başka bir aracın kancası çalışmıyor" kartı KAPATILDI mı. Kart bir
    // TEŞHİSTİR, dayatma değil: kullanıcı bir kez kapattıysa bir daha kendiliğinden
    // açılmaz (Ayarlar → Sistem durumu üzerinden geri çağrılır). Kalıcılık burada,
    // çünkü renderer localStorage'ı yeniden açılışı ATLATMAZ (random-port origin —
    // ADP-437/533 dersi) ve "kapattım, yine geldi" en can sıkıcı hatalardandır.
    foreignHookNoticeDismissed: false,
    // ADP-945 — TANITIM TURU bitirildi/atlandı mı. ADP-695 bu bayrağı
    // localStorage'a (`crewpane:tour:v1`) yazıyordu; gömülü Next sunucusu her
    // açılışta RASTGELE bir port bağladığı için renderer origin'i
    // (http://127.0.0.1:<port>) değişiyor ve o alan adına yazılan her şey bir
    // sonraki açılışta ERİŞİLEMEZ oluyor → tur turu tamamlamış kullanıcıya HER
    // AÇILIŞTA yeniden çıkıyordu. Ölçüm: kullanıcının localStorage defterinde 207
    // ayrı `http://127.0.0.1:<port>` origin'i (docs/agent-results/ADP-945-*).
    // Bu, updateDismissedVersion / foreignHookNoticeDismissed / announcementsRead
    // ile BİREBİR aynı sınıf; çözüm de aynı: kalıcılık settings.json'da.
    // TAMAMLANDIYSA bir daha kendiliğinden açılmaz (Ayarlar'dan elle çağrılır).
    productTourDone: false,
    // TOUR-02-GUIDE-PERSIST — Rehber turu (TOUR-02-B) "bitirdim/kapattım" bayrağı.
    // `productTourDone` ile AYNI sınıf ve AYNI üç nokta (varsayılan · okuma beyaz
    // listesi · normalize); ayrı bir anahtar, çünkü Rehber ile Tanıtım turu ayrı
    // yüzeyler: birini bitirmek diğerini susturmamalı.
    onboardingGuideDone: false,
    // ADP-675 — uygulama-içi duyuruların OKUNDU defteri: { [duyuruId]: epoch }.
    // Kalıcılık burada, çünkü renderer localStorage'ı restart'ı atlatmaz (random-port
    // origin — ADP-437 dersi) ve "okudum, bir daha gösterme" restart'tan SONRA da
    // geçerli olmalı. Şeridin ✕'i (oturumluk gizleme) BİLEREK diske yazılmaz.
    announcementsRead: {},
    // ADP-620 — yayın kanalı: 'auto' (varsayılan) | 'stable' | 'beta'.
    // 'auto' = kararı instance verir (prod/müşteri → stable, dev → beta); Ayarlar'daki
    // "Beta güncellemeleri al" toggle'ı AÇIK bir tercih ('beta'/'stable') yazar.
    // Çözüm mantığı tek yerde: electron/updateChannel.cjs resolveChannel().
    updateChannel: 'auto',
    // ADP-558 — pane zoom/tam-ekran kısayolu ('Meta+Shift+Enter' formatı). null →
    // renderer varsayılanı (paneZoomShortcut.ts DEFAULT_PANE_ZOOM_SHORTCUT).
    paneZoomShortcut: null,
    // KEY-01 — Rectangle tarzı YERLEŞTİRME ailesinin taşıyıcı modifier'ları
    // ('Ctrl+Alt'). Tek kombinasyon DEĞİL bir AİLE: yön tuşları ve Shift
    // niteleyicisi sabittir (src/app/lib/paneMoveKeys.ts), ayarlanan yalnız
    // öndeki modifier'lardır. null → renderer varsayılanı.
    paneMoveShortcut: null,
    // ADP-663 — terminal + okunabilir mod yazı ölçeği: 'small' | 'medium' | 'large'.
    // Tercih GLOBAL'dir (göz tercihi, pane özelliği değil) ve renderer-semantiği
    // taşır: gerçek px değerleri src/app/lib/terminalFontScale.ts'te — main yalnız
    // kalıcılaştırır (theme ile aynı iş bölümü).
    terminalFontScale: 'medium',
    // ADP-888 (ADP-885 Faz A) — ARAYÜZ DİLİ TERCİHİ: 'system' | 'tr' | 'en'.
    // TERCİH ≠ ETKİN DİL: 'system' "işletim sistemini takip et" niyetidir ve bunu
    // 'tr'/'en' saklayarak ifade etmek İMKÂNSIZDIR (ADP-885 §3.2/1) — bu yüzden
    // varsayılan 'system'; mevcut kullanıcı (macOS TR) güncellemeden sonra Türkçe
    // görmeye devam eder, yeni/global kullanıcı İngilizce açar.
    // ⚠️ Ses dili AYRI eksendir (docs/design/ADR-VOICE-LOCALE.md) — bu alan onu
    // BELİRLEMEZ; arayüz İngilizceyken Türkçe konuşmak mümkün kalır.
    locale: 'system',
    // ADP-885 Faz B (docs/design/ADR-VOICE-LOCALE.md) — SES DİLİ: 'follow-ui' | 'tr' | 'en'.
    // `locale` ile AYNI ŞEY DEĞİLDİR ve onu takip etmek ZORUNDA da değildir:
    // "arayüz İngilizce, ben Türkçe konuşuyorum" geçerli bir yapılandırmadır.
    // Varsayılan 'follow-ui' → ayar yapılmamışsa ses arayüzü izler (bugünkü davranışın
    // devamı: macOS TR kullanıcısı Türkçe konuşmaya devam eder).
    // ⚠️ ÇÖZÜMÜ BURADA YAPMA: tek nokta electron/i18n/index.cjs → voiceLocale(settings).
    voiceLocale: 'follow-ui',
    pushToTalkKey: DEFAULT_PUSH_TO_TALK_KEY,
    wakeModelPath: null, // null → bundled wake_v0.1.onnx (ADP-725: marka-nötr dosya adı)
    mcpServers: {}, // { [name]: { command, args } }
    theme: null, // null → renderer default (dark); else { mode:'dark'|'light'|'system', accent:'#rrggbb'|null }
    // ADP-343 (ADR-026 §2.5) — tarayıcı güven modeli: kullanıcının KALICI güven tercihi.
    // Kararı browserTrust.decide() verir; burada YALNIZ kalıcı olan üç şey durur:
    //   mode           'gevsek' | 'normal' | 'siki'  (sıkı = eski "her tıkta sor" davranışı)
    //   trustedOrigins kullanıcı beyaz listesi — yerleşik liste (localhost…) buna EKLENİR, buradan silinemez
    //   blockedOrigins kullanıcı kara listesi — beyaz listeyi EZER (yerleşik yasaklar gibi)
    // Görev-başı ("bu görev boyunca izin ver") ve otomasyon modu izinleri BİLEREK burada
    // DEĞİL: oturumluk, bellekte (browserGate) — diske yazılmaz.
    browserTrust: { mode: 'normal', trustedOrigins: [], blockedOrigins: [] },
    // TC-01 (ADR-TEAM-COMPOSER §9.7) — TAKIM KURUCU ÖZERKLİĞİ, üç kademe:
    //   ask        (varsayılan) her yeni kişi için onay sorulur
    //   small-auto tek kişilik eklemeyi kendi yapar, takım kurmak yine onaya bağlı
    //   auto       gerekli gördüğünde ekibi kendi büyütür
    // Kademe ne olursa olsun onay jetonunu MAIN üretir — lider kendi jetonunu
    // uyduramaz (§4.2). Varsayılan en dar kademedir: özerklik AÇIKÇA seçilir.
    teamCompose: { autonomy: teamCompose.DEFAULT_AUTONOMY },
    // ADP-717 (docs/design/DELEGATION-PERMISSIONS.md) — TAKIM KAPSAMI izinleri.
    // Varsayılan: kural AÇIK, izin YOK → her lider yalnız KENDİ takımına iş verir ve
    // yalnız kendi takımını yönetir. `enforcedSince` ilk çalıştırmada bir kez yazılır
    // (§3.5 geçiş mandalı: o andan ÖNCE başlamış pane'ler yönetilebilir kalır, yani
    // yürürlüğe giren kural KOŞAN işi yönetilemez hâle getirmez).
    // ADP-900 (SPRINT-MEMORY-SEARCH) — HAFIZA ARAMASI.
    //
    //   semanticConsent  Gömme modelini indirme ONAYI. `null` = HİÇ SORULMADI (kart
    //                    "aç" der), `{granted:false}` = kullanıcı REDDETTİ (kart
    //                    kapalı kalır, tek bayt inmez). Damga `key` taşır: model ya
    //                    da ölçülen boyut değişirse onay GEÇERSİZDİR ve yeniden
    //                    sorulur — 559 MB'a verilen onay 2 GB'ı kapsamaz.
    //                    (shared/policy-stamp-outlives-module: damganın SAHİBİ olur.)
    //   semanticEnabled  Model KURULUYKEN katmanı kullan. Kullanıcı modeli silmeden
    //                    de kapatabilsin diye AYRI alan.
    //   autoIndex        İlk açılışta hafıza indeksini kendiliğinden kur (arka planda,
    //                    düşük öncelikli). Bu indeksleme MODEL GEREKTİRMEZ (yalnız
    //                    kelime katmanı) — onay akışıyla ilgisi yoktur.
    //   sessionsIndexed  SEARCH-2 — AJAN CLI OTURUMLARI genel aramaya girsin mi?
    //                    Bu indeks YERELDİR, yalnız user/assistant DÜZ METİN bloklarını
    //                    alır (araç çıktısı/dosya içeriği/hatırlatma DIŞARIDA kalır) ve
    //                    her parça maskeden geçer. Varsayılan AÇIK — kartın dili
    //                    "opt-out" (kullanıcı kapatır), ADP-900'ün autoIndex'iyle de
    //                    tutarlı. KAPATMAK SİLER: bir sonraki tur oturum belgelerini
    //                    indeksten kaldırır ("gizle" değil).
    memorySearch: { semanticConsent: null, semanticEnabled: true, autoIndex: true, sessionsIndexed: true },
    // ENG-HONEST-CARD-01 — motor başına politika: { <engineId>: { vendorHosted: 'allow'|'block' } }.
    // Yolu descriptor SÖYLER (`usage.billing.vendorHosted.policySetting`), okuyan
    // `engineBilling.resolvePolicy`. Boş harita = her motorda descriptor varsayılanı.
    engines: {},
    // PANE-CAP-01 — KAYNAK BEKÇİSİ. Sabit pane tavanları (MAX_LIVE_PANES/SPAWN_HARD_CAP)
    // kaldırıldı; yerlerini ÖLÇÜLEN bellek baskısı aldı. `enabled:false` → hiçbir eşik
    // yok (yalnız bilgi rozeti). Varsayılanlar karttan: uyarı %25, dur-ve-sor %15.
    resourceGovernor: { enabled: false, warnFreePct: 1, criticalFreePct: 0 },
    jarvis: {
      // ADP-848 — TTS motoru: 'say' (yerel, ÜCRETSİZ) | 'openai' | 'elevenlabs' | 'azure'.
      // 'openai' SEVK EDİLMİŞ tercihtir, korunuyor; anahtar yoksa çalışma anında zaten
      // ücretsiz `say`'e düşer. 🔴 Tanınmayan/bozuk her değer ÜCRETSİZ motora düşer
      // (ttsProviders.resolveTtsEngine) — ücretli bir motor ASLA kendiliğinden seçilmez.
      ttsEngine: 'openai',
      ttsVoice: 'nova',    // openai TTS voice; see TTS_VOICES in jarvisVoice.js
      // ADP-859B — SES WIDGET'ININ GÖRÜNÜM TERCİHİ: 'mini' | 'panel' | null.
      // 🔴 Neden localStorage DEĞİL: gömülü Next sunucusu her açılışta SERBEST bir
      // port alır (main.js getFreePort) → renderer'ın origin'i değişir → origin
      // kapsamlı localStorage her yeniden açılışta BOŞ gelir (ölçüldü: 51819 →
      // 51842, yazılan anahtar okunamadı). Kullanıcının "küçük kalsın" tercihi
      // yeniden açılışta korunmak ZORUNDA olduğu için tek gerçek burasıdır.
      // null = renderer varsayılanı (mini).
      view: null,
      // ADP-812 — model burada SABİTLENMEZ. Buraya bir değer yazmak motorun
      // varsayılanını (jarvisVoice.DEFAULT_TTS_MODEL) sessizce ÖLDÜRÜR: her
      // okumada ayar galip gelir. null = "motor ne diyorsa o".
      ttsModel: null,
      // ADP-812 — VAD kuyruk-sessizliği (ms). null = motor varsayılanı.
      // ADP-854B — bu artık "cümle bitti mi" TABANIDIR (motor varsayılanı 900).
      silenceMs: null,
      // ADP-854B — cümle ORTASINDA (bağlaç/yarım ifade) beklenen TAVAN (ms).
      // null = motor varsayılanı (2500). Ölçüm: gerçek Türkçe konuşmada cümle-içi
      // duraklama p50 1500 / maks 2200 ms (jarvisVoice.js başlığı).
      endpointMaxMs: null,
      // ADP-854B — OTURUM uyku eşiği (ms): bu kadar GERÇEK sessizlikten sonra uyu.
      // Cümle-sonu eşiğinden AYRIDIR (biri işlemeyi başlatır, bu uykuya alır).
      // null = motor varsayılanı (45000).
      sleepAfterMs: null,
      // ADP-916 — mikrofon açıldıktan sonra TEK KELİME duyulmazsa kaydın kapanma
      // süresi (ms). ADP-818'de renderer'a SABİT yazılıydı (8000) ve kullanıcının
      // ayar yüzeyinde hiç yoktu; teşhiste UYGULANAN değer okunamıyordu.
      // null = motor varsayılanı (8000).
      noSpeechMs: null,
      // ── AGENTX-WAKE-01 — UYKU TÜRÜ ─────────────────────────────────────────
      // false (VARSAYILAN): uykuda YALNIZ yerel uyandırma modeli dinler; mikrofon
      //   açık kalır (macOS noktası yanar) ve arayüz bunu AÇIKÇA yazar.
      // true  (tam sessiz uyku): mikrofon uykuda tamamen kapanır; uyandırma yalnız
      //   düğme/bas-konuş ile olur ve arayüz "sesle uyandırılamaz" der.
      // Gerekçe + ölçüm: docs/agent-results/AGENTX-WAKE-01-wheeljack.md §4.
      silentSleep: false,
      // AGENTX-WAKE-01 KONTROL KOLU — true, uyandırma/cümle-sonu düzeltmelerini
      // kapatıp 08.09 davranışına döner (kusur geri gelir). Yalnız ölçüm içindir.
      wakeLegacy: false,
      // ADP-813 — STT motoru: 'local' (whisper.cpp, ücretsiz) | 'openai' (whisper-1).
      // null = motor varsayılanı ('local', bulut fallback'li). ADP-812 dersi: buraya
      // bir değer YAZMA — yazarsan motorun varsayılanı hiçbir kurulumda çalışmaz.
      sttEngine: null,
      // ADP-813 — model dosyasının yolu (boş = otomatik: <instanceHome>/models,
      // ~/.crewpane/models, Homebrew paylaşım dizini).
      whisperModelPath: null,
      // ADP-909 — SESSİZLİK/GÜRÜLTÜ KAPISI eşikleri. Konuşma İÇERMEYEN ses
      // STT'ye hiç gitmesin diye; boş bırakılırsa motorun ÖLÇÜLMÜŞ varsayılanları
      // (electron/sttSilenceGate.cjs DEFAULTS) geçerlidir.
      // 🔴 ADP-812 dersi ([[clip-prod-path-default-divergence]]): buraya SAYI
      // YAZMA. Yazarsan diskteki o değer motorun varsayılanını her okumada ezer
      // ve eşiği ileride iyileştirmek imkânsız olur. null = "motor ne diyorsa o".
      //   rmsThreshold  kare "konuşma sayılır" enerji eşiği (0..1)
      //   minSpeechMs   bu kadar konuşmalı ms'den azı = kimse konuşmadı
      //   loudFloor     p90 bunun üstündeyse ses açıkça duyulur (dinamik testi atlanır)
      //   minDynamicDb  alçak seviyede konuşma sayılmak için gereken en az dinamik
      //   draftMinDynamicDb  ADP-912: AYNI ölçüt, ama yalnız TASLAK (canlı altyazı)
      //                 katmanında — orada yanlış-negatifin bedeli yalnız bir tur
      //                 geç görünen altyazı, komut ETKİLENMEZ (final katman ayrı).
      silenceGate: {
        rmsThreshold: null,
        minSpeechMs: null,
        loudFloor: null,
        minDynamicDb: null,
        draftMinDynamicDb: null,
      },
      // ADP-827 — ses modu: null/'local' = YEREL, ÜCRETSİZ yol (varsayılan) ·
      // 'grok' = xAI Grok Voice (gerçek zamanlı, KULLANICININ anahtarıyla, ÜCRETLİ).
      // ADP-812 dersi: buraya 'local' YAZMA — motorun varsayılanı
      // (grokVoice.resolveVoiceMode) o zaman hiçbir kurulumda konuşamaz.
      // 🔴 Tanınmayan/bozuk her değer ÜCRETSİZ yola düşer (fail-safe yönü).
      voiceMode: null,
      // ADP-827 — Grok modeli ve sesi. null = motor varsayılanı (EN UCUZ açık sürüm;
      // `grok-voice-latest` ALIAS'ı bilerek kullanılmaz — 2026-08-05'te 2.0'a geçip
      // dakika ücretini 0.05→0.08 USD yapıyor, yani kullanıcının faturası habersiz artar).
      grokModel: null,
      grokVoice: null,
      // ADP-848 — ElevenLabs / Azure ayrıntıları. ADP-812 dersi: hepsi null =
      // "motor ne diyorsa o" (ttsProviders varsayılanları). Buraya bir değer
      // yazmak, sağlayıcı varsayılanını her okumada sessizce ezerdi.
      elevenModel: null,   // 'eleven_multilingual_v2' (kalite) | 'eleven_turbo_v2_5' (yarı fiyat)
      // ADP-848-B — ses artık HESAPTAN çekilen listeden seçilir (kodda sabit id
      // yok). `elevenVoiceName` yalnız GÖSTERİM içindir: liste çekilemediğinde
      // (anahtar silindi / internet yok) ekranda ham id yerine "Rachel" yazsın.
      elevenVoiceId: null,   // ElevenLabs ses id'si — kullanıcının hesabındaki listeden
      elevenVoiceName: null, // o sesin adı (yalnız ekranda göstermek için)
      azureRegion: null,   // örn. 'westeurope' — aboneliğin bölgesi
      azureVoice: null,    // 'tr-TR-EmelNeural' | 'tr-TR-AhmetNeural'
    },
  };
}

let _cache = null;

// ADP-234 — accept ONLY a plain { string: non-empty string } object; anything else
// (array, nested objects, numbers) → null (built-in mapping). Shared by read + write
// so a bad patch can't park garbage in the cache either.
function sanitizeDepartmentDirs(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k === 'string' && k.trim() && typeof v === 'string' && v.trim()) {
      out[k.trim().toLowerCase()] = v.trim();
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * B-01 — `{ "<proje>": "worktree"|"off" }`. Tanınmayan mod DÜŞÜRÜLÜR (kayda hiç
 * girmez): "worktre" yazım hatası sessizce `off` gibi davransaydı kullanıcı
 * izolasyonu açtığını sanıp paylaşımlı ağaçta koşardı — B-01'in kapatmaya çalıştığı
 * tam o sınıf. Şemada da aynı kısıt var (projects_isolation_check).
 */
function sanitizeProjectIsolation(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k !== 'string' || !k.trim()) continue;
    if (v !== 'worktree' && v !== 'off') continue;
    out[k.trim().toLowerCase()] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ADP-258 — accept ONLY { mode: known, accent?: '#rrggbb'|null, preset?: slug|null };
// anything else → null (renderer default). Shared by read + write so a bad patch
// can't park garbage in the cache (same discipline as sanitizeDepartmentDirs).
// ADP-287 — `preset` shape-only doğrulanır (kebab-case id); listede olmayan id'yi
// renderer (theme.ts normalizeTheme) düşürür — tek liste kaynağı orası.
const THEME_PRESET_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
function sanitizeTheme(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!THEME_MODES.includes(raw.mode)) return null;
  const accent =
    typeof raw.accent === 'string' && THEME_ACCENT_RE.test(raw.accent) ? raw.accent.toLowerCase() : null;
  const preset =
    typeof raw.preset === 'string' && THEME_PRESET_RE.test(raw.preset) ? raw.preset : null;
  return { mode: raw.mode, accent, preset };
}

// ADP-558 — pane zoom kısayolu: yalnız '<Modifier+>…<tuş>' şekilli string kabul edilir
// ve en az bir Shift-DIŞI modifier şarttır (düz/Shift-only tuş terminal girdisini
// çalar — settings.json elle bozulsa bile böyle bir değer cache'e park edemez).
// Gerçek parse/martch renderer'da (src/app/lib/paneZoomShortcut.ts) — burada yalnız
// şekil + güvenlik değişmezi doğrulanır; çöp → null (= renderer varsayılanı).
// ADP-663 — yazı ölçeği: KAPALI liste. Çöp/eksik değer sessizce 'medium'a düşer
// (bir ayar dosyası hatası kimsenin terminalini okunamaz hâle getirmemeli).
// Liste renderer'daki TERMINAL_FONT_SCALE_IDS ile aynı üç değerdir; px sayıları
// burada YOK — sunum kararı renderer'ın (theme ile aynı sınır).
const TERMINAL_FONT_SCALES = ['small', 'medium', 'large'];
function sanitizeTerminalFontScale(raw) {
  return typeof raw === 'string' && TERMINAL_FONT_SCALES.includes(raw) ? raw : 'medium';
}

// ADP-888 — arayüz dili TERCİHİ: kapalı liste ('system'|'tr'|'en'). Çöp değer
// 'system'a düşer (elle bozulmuş bir settings.json kullanıcıyı okuyamadığı bir
// dile kilitleyemesin). Kelime listesi tek yerde: electron/i18n/index.cjs.
function sanitizeLocale(raw) {
  return appI18n.isLocalePreference(raw) ? raw : appI18n.DEFAULT_LOCALE_PREFERENCE;
}

/** ADP-885 Faz B — ses dili tercihi: kapalı liste; çöp değer 'follow-ui'ya düşer. */
function sanitizeVoiceLocale(raw) {
  return appI18n.isVoiceLocalePreference(raw) ? raw : appI18n.DEFAULT_VOICE_LOCALE_PREFERENCE;
}

// KEY-01 — yerleştirme ailesinin TABANI: yalnız modifier jetonları ('Ctrl+Alt').
// İki sert değişmez, ikisi de güvenlik/doğruluk kapısı:
//   • En az bir Ctrl/Alt/Meta ŞART — modifier'sız bir taban çıplak yön tuşlarını
//     ele geçirirdi, yani TUI'deki imleç hareketini (settings.json elle bozulsa
//     bile böyle bir değer cache'e park edemez).
//   • `Shift` YASAK — Shift bu ailede "takas" niteleyicisidir; tabana girerse
//     "yerleştir" ile "takas" aynı olayla eşleşir ve hangisinin koştuğu
//     dinleyici sırasına kalır.
// Gerçek parse/match renderer'da (paneMoveKeys.ts); burada şekil + değişmez.
function sanitizePaneMoveShortcut(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (s.length === 0 || s.length > 32) return null;
  if (!/^(Meta|Ctrl|Alt)(\+(Meta|Ctrl|Alt))*$/.test(s)) return null;
  const parts = s.split('+');
  if (new Set(parts).size !== parts.length) return null; // 'Ctrl+Ctrl'
  return s;
}

function sanitizePaneZoomShortcut(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (s.length === 0 || s.length > 64) return null;
  if (!/^((Meta|Ctrl|Alt|Shift)\+)+[A-Za-z0-9]{1,32}$/.test(s)) return null;
  if (!/(Meta|Ctrl|Alt)\+/.test(s)) return null; // Shift-only yasak
  return s;
}

// ADP-343 — güven ayarı: bozuk değer ASLA kabul edilmez, sessizce varsayılana düşer
// (kapı bir GÜVENLİK kapısı: yarım/çöp bir liste "tanınmayan origin serbest" anlamına
// gelmemeli). Mod sözlüğü browserTrust'tan gelir (tek kaynak; TR/EN eşanlamlıları da
// orada). Girdiler kırpılır, küçük harfe çevrilir, tekilleştirilir ve sayı/uzunluk
// tavanına vurulur — Ayarlar'dan gelen serbest metin sınırsız büyümesin.
const MAX_TRUST_RULES = 200;
const MAX_TRUST_RULE_LEN = 200;
function sanitizeBrowserTrust(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const n = browserTrust.normalizeSettings({ browserTrust: src }); // mod aliası + tip süzgeci
  const clean = (list) => {
    const out = [];
    for (const v of list) {
      const s = String(v).trim().toLowerCase().slice(0, MAX_TRUST_RULE_LEN);
      if (s && !out.includes(s) && out.length < MAX_TRUST_RULES) out.push(s);
    }
    return out;
  };
  return { mode: n.mode, trustedOrigins: clean(n.trustedOrigins), blockedOrigins: clean(n.blockedOrigins) };
}

/** Read settings (cached). A missing/corrupt file → defaults. Never throws. */
// ADP-675 — okundu defteri: YALNIZ { "<duyuruId>": <epoch> }. Diskteki dosya elle
// düzenlenebilir olduğu için şekli burada zorlanır; çöp değerler sessizce düşer.
const MAX_READ_ENTRIES = 200;
/**
 * ADP-900 — hafıza arama tercihleri. Onay damgası KASITLI olarak dar: yalnız
 * `granted` (boolean) + `key` (plan damgası) + `at` (zaman) saklanır. Bilinmeyen
 * alan atılır ki diske düşen bir çöp "onay" gibi okunmasın.
 */
/**
 * TC-01 — takım kurucu ayarı. Tanınmayan/çöp değer EN DAR kademeye ('ask') düşer:
 * bozuk bir settings.json özerkliği AÇMAMALI (teamScope'un fail-closed disiplini).
 */
function sanitizeTeamCompose(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return { autonomy: teamCompose.sanitizeAutonomy(src.autonomy) };
}

function sanitizeMemorySearch(raw) {
  const out = { semanticConsent: null, semanticEnabled: true, autoIndex: true, sessionsIndexed: true };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (typeof raw.semanticEnabled === 'boolean') out.semanticEnabled = raw.semanticEnabled;
  if (typeof raw.autoIndex === 'boolean') out.autoIndex = raw.autoIndex;
  if (typeof raw.sessionsIndexed === 'boolean') out.sessionsIndexed = raw.sessionsIndexed;
  const c = raw.semanticConsent;
  if (c && typeof c === 'object' && !Array.isArray(c) && typeof c.granted === 'boolean') {
    out.semanticConsent = {
      granted: c.granted,
      key: typeof c.key === 'string' ? c.key : '',
      at: Number.isFinite(c.at) ? c.at : null,
    };
  }
  return out;
}

/**
 * ENG-HONEST-CARD-01 — motor politikaları. Kapalı liste `engineRegistry.VENDOR_GATE_POLICIES`
 * ile AYNI ('allow' | 'block'; drift testi agentSettings.test.cjs'te). Tanınmayan değer
 * DÜŞER — sessizce "block" olmaz: kullanıcıyı yazım hatası yüzünden pane'siz bırakmak
 * yanlış olurdu (engineBilling.resolvePolicy ile aynı kural). Geçerli alanı kalmayan
 * motor satırı haritadan çıkar.
 */
const VENDOR_HOSTED_POLICIES = Object.freeze(['allow', 'block']);
function sanitizeEngines(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, row] of Object.entries(raw)) {
    if (!id || !row || typeof row !== 'object' || Array.isArray(row)) continue;
    if (VENDOR_HOSTED_POLICIES.includes(row.vendorHosted)) out[id] = { vendorHosted: row.vendorHosted };
  }
  return out;
}

/**
 * PANE-CAP-01 — kaynak bekçisi ayarı. Diskteki değere GÜVENİLMEZ: çöp bir değerin
 * bekçiyi sessizce kapatması ("evet", 1, {} → true sanılması) ya da eşiği anlamsız
 * bir sayıya çekmesi tam da kapattığımız arıza sınıfıdır. `enabled` YALNIZ gerçek
 * boolean; eşikler 0-100 arası sonlu sayı; kritik eşik uyarı eşiğini geçemez
 * (geçseydi 'uyarı' seviyesi hiç görünmez, kullanıcı doğrudan karta çarpardı).
 */
function sanitizeResourceGovernor(raw) {
  const out = { enabled: false, warnFreePct: 1, criticalFreePct: 0 };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
  const pct = (v, fallback) => (Number.isFinite(v) && v >= 0 && v <= 100 ? v : fallback);
  out.warnFreePct = pct(Number(raw.warnFreePct), out.warnFreePct);
  out.criticalFreePct = pct(Number(raw.criticalFreePct), out.criticalFreePct);
  if (out.criticalFreePct > out.warnFreePct) out.criticalFreePct = out.warnFreePct;
  return out;
}

function sanitizeAnnouncementsRead(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k !== 'string' || !/^[a-z0-9._-]{1,80}$/.test(k)) continue;
    if (!Number.isFinite(v) || v <= 0) continue;
    out[k] = v;
    if (Object.keys(out).length >= MAX_READ_ENTRIES) break;
  }
  return out;
}

/**
 * ADP-845 — heartbeat durumu. Diskteki değere GÜVENİLMEZ: yalnız uuid + pozitif
 * tamsayı + gün damgası geçer. (Bu alan bir gün ürüne dışarıdan gelen bir metni
 * taşırsa telemetri içerik kanalına dönerdi.)
 */
function sanitizeTelemetryState(raw) {
  const base = { installId: null, sessions: 0, daysSeen: 0, lastDay: null, counters: {}, milestones: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  // OBS-01 — AKTİVASYON KİLOMETRE TAŞLARI: "bu kurulumda ilk kez oldu" işaretleri.
  // Sayaçlarla AYNI beyaz-liste disiplini, ama burada değer bile yok — yalnız
  // İŞARETİN VARLIĞI. Sözcükler `analyticsSchema` kapalı kümesindeki olay
  // adlarından türer; diskteki bir metin buraya sızsa da biçim kapısını geçemez.
  if (Array.isArray(raw.milestones)) {
    for (const m of raw.milestones) {
      if (typeof m === 'string' && /^[a-z0-9_:]{1,40}$/.test(m) && !base.milestones.includes(m)) {
        base.milestones.push(m);
      }
      if (base.milestones.length >= 40) break;
    }
  }
  // Sayaçlar KÜMÜLATİF olduğu için diskte yaşar. Beyaz liste BURADA DA zorlanır:
  // ayar dosyası elle düzenlenip içerik taşıyan bir anahtar konsa bile telemetriye
  // geçemez (heartbeat.cjs ve DB CHECK kısıtı üçüncü/dördüncü kapı).
  if (raw.counters && typeof raw.counters === 'object' && !Array.isArray(raw.counters)) {
    const allowed = ['panes_opened', 'agents_spawned', 'tasks_created', 'delegations', 'memory_writes', 'voice_seconds'];
    for (const k of allowed) {
      const v = Number(raw.counters[k]);
      if (Number.isFinite(v) && v > 0) base.counters[k] = Math.min(Math.floor(v), 1e9);
    }
  }
  if (typeof raw.installId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw.installId)) {
    base.installId = raw.installId.toLowerCase();
  }
  for (const k of ['sessions', 'daysSeen']) {
    const v = Number(raw[k]);
    if (Number.isFinite(v) && v > 0) base[k] = Math.min(Math.floor(v), 1e7);
  }
  if (typeof raw.lastDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.lastDay)) base.lastDay = raw.lastDay;
  return base;
}

function readSettings() {
  if (_cache) return _cache;
  const out = defaults();
  // ADP-844 — SOĞUK OKUMADA BİR KEZ: kaldırılmış özelliklerin diskteki artığını
  // (blok + uykudaki SIR) temizle. Düşürmeyi yalnız okuma/yazma yoluna bırakmak
  // YETMİYORDU: hiçbir ayarı değiştirmeyen bir kullanıcının dosyasında jeton
  // süresiz kalıyordu (ADP-844'te ölçüldü). Best-effort; hiçbir yolu bloklamaz.
  try {
    settingsMigrations.migrateSettingsFile({ file: settingsPath() });
  } catch {
    /* temizlik asla ayar okumayı düşüremez */
  }
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    if (raw && typeof raw === 'object') {
      if (typeof raw.workspaceRoot === 'string' && raw.workspaceRoot) out.workspaceRoot = raw.workspaceRoot;
      // BL-01 — beyaz liste ŞART (ADP-675/717/907 tuzağı): yoksa defter diske
      // yazılır ama BİR DAHA OKUNMAZ → her açılışta "hiç alanım yok" sanılır ve
      // paket tavanı sessizce yanlış sayardı.
      if (Array.isArray(raw.knownWorkspaces)) {
        out.knownWorkspaces = raw.knownWorkspaces.filter((r) => typeof r === 'string' && r.trim());
      }
      if ('departmentDirs' in raw) out.departmentDirs = sanitizeDepartmentDirs(raw.departmentDirs);
      // B-01 — aynı süzgeç (slug→dize haritası); `projectIsolation` ayrıca değeri
      // ENUM'a kısar, çünkü tanınmayan bir mod "izolasyon açık sandım ama kapalıymış"
      // sınıfı bir sessiz yanlışa yol açardı.
      if ('projectRepos' in raw) out.projectRepos = sanitizeDepartmentDirs(raw.projectRepos);
      if ('projectIsolation' in raw) out.projectIsolation = sanitizeProjectIsolation(raw.projectIsolation);
      // CIDX-1 — beyaz liste ŞART (ADP-675/717/907 tuzağı): yoksa kullanıcının
      // açtığı indeks anahtarı diske yazılır ama BİR DAHA OKUNMAZ → spawn her
      // seferinde "kapalı" görür ve ayar ölü bir kola dönerdi.
      if ('codeIndex' in raw) out.codeIndex = codeIndex.sanitizeCodeIndex(raw.codeIndex);
      if (raw.apiKeys && typeof raw.apiKeys === 'object') {
        out.apiKeys = { ...raw.apiKeys };
      }
      // ENG-OPENAI-COMPAT-01 — beyaz liste ŞART (ADP-675/717/907 tuzağı): yoksa
      // kullanıcının eklediği uç diske YAZILIR ama BİR DAHA OKUNMAZ → her açılışta
      // "böyle bir sağlayıcı yok" denir ve kullanıcı adresi tekrar tekrar girer.
      // HAM DEĞİL NORMALİZE saklanır: defterdeki satır kapıdan geçmiş olmalı
      // (kimlik/envKey sabit, URL doğrulanmış) — disk elle düzenlenmiş olabilir.
      if ('customProvider' in raw) {
        out.customProvider = customProvider.customProviderOrNull(raw.customProvider);
      }
      if (typeof raw.pushToTalkKey === 'string' && PUSH_TO_TALK_KEYS.includes(raw.pushToTalkKey)) {
        out.pushToTalkKey = raw.pushToTalkKey;
      }
      if (typeof raw.wakeModelPath === 'string' && raw.wakeModelPath) out.wakeModelPath = raw.wakeModelPath;
      if (typeof raw.keepExitedPanes === 'boolean') out.keepExitedPanes = raw.keepExitedPanes; // ADP-303
      // HATA-07 — beyaz liste ŞART (ADP-675/717/907 tuzağı): yoksa kullanıcının
      // açtığı anahtar diske yazılır ama BİR DAHA OKUNMAZ → panel "kapalı" gösterir.
      if (typeof raw.autoModelByTaskClass === 'boolean') out.autoModelByTaskClass = raw.autoModelByTaskClass;
      // LDR-F1 — beyaz liste ŞART (ADP-675/717/907 tuzağı): yoksa kullanıcının
      // açtığı `auto` diske yazılır ama BİR DAHA OKUNMAZ → her açılışta `warn`.
      if (typeof raw.leaderAutoRefresh === 'string') {
        out.leaderAutoRefresh = leaderRefreshPolicy.normalizeMode(raw.leaderAutoRefresh);
      }
      if (typeof raw.cloudSyncEnabled === 'boolean') out.cloudSyncEnabled = raw.cloudSyncEnabled; // SYNC-F1-6
      if (typeof raw.prefsSyncEnabled === 'boolean') out.prefsSyncEnabled = raw.prefsSyncEnabled; // SYNC-F1-7
      if (typeof raw.telemetryEnabled === 'boolean') out.telemetryEnabled = raw.telemetryEnabled; // ADP-715
      if (typeof raw.telemetryNoticeShown === 'boolean') out.telemetryNoticeShown = raw.telemetryNoticeShown; // ADP-715
      // ADP-845 — beyaz liste ŞART: yoksa install_id diske yazılır ama bir daha
      // OKUNMAZ → her açılış yeni bir "kurulum" sayılırdı (ADP-675 dersi).
      if ('telemetryState' in raw) out.telemetryState = sanitizeTelemetryState(raw.telemetryState);
      if ('paneZoomShortcut' in raw) out.paneZoomShortcut = sanitizePaneZoomShortcut(raw.paneZoomShortcut); // ADP-558
      // KEY-01 — beyaz liste ŞART (ADP-675/717 tuzağı): yoksa kullanıcı aileyi
      // yeniden atar, disk'e yazılır ama BİR DAHA OKUNMAZ ("değiştirdim, geri döndü").
      if ('paneMoveShortcut' in raw) out.paneMoveShortcut = sanitizePaneMoveShortcut(raw.paneMoveShortcut);
      if ('terminalFontScale' in raw) out.terminalFontScale = sanitizeTerminalFontScale(raw.terminalFontScale); // ADP-663
      // ADP-888 — beyaz liste ŞART: yoksa dil diske yazılır ama BİR DAHA OKUNMAZ
      // (kullanıcı "dili değiştirdim, geri döndü" görürdü — ADP-675/717 tuzağı).
      if ('locale' in raw) out.locale = sanitizeLocale(raw.locale);
      // ADP-885 Faz B — aynı beyaz-liste şartı: yoksa kullanıcı ses dilini seçer,
      // diske yazılır ama BİR DAHA OKUNMAZ ("seçtim, geri döndü").
      if ('voiceLocale' in raw) out.voiceLocale = sanitizeVoiceLocale(raw.voiceLocale);
      if (typeof raw.updateAutoCheck === 'boolean') out.updateAutoCheck = raw.updateAutoCheck; // ADP-533
      if (typeof raw.updateDismissedVersion === 'string' && raw.updateDismissedVersion) {
        out.updateDismissedVersion = raw.updateDismissedVersion; // ADP-533
      }
      // ADP-907 — beyaz liste ŞART (ADP-675/717 tuzağı): yoksa kullanıcı kartı kapatır,
      // ayar diske yazılır ama BİR DAHA OKUNMAZ → kart her açılışta geri gelir.
      if (typeof raw.foreignHookNoticeDismissed === 'boolean') {
        out.foreignHookNoticeDismissed = raw.foreignHookNoticeDismissed;
      }
      // ADP-945 — AYNI beyaz-liste şartı, beşinci kurban. Bu satır olmadan tur
      // bayrağı settings.json'a YAZILIR ama bir daha OKUNMAZ → düzeltme "yapıldı"
      // görünür, tur yine her açılışta gelir. (Birim testiyle yakalandı, ürüne
      // sızmadı: agentSettings.test.cjs "ADP-945 … YENİDEN OKUMADA diskten gelir".)
      if (typeof raw.productTourDone === 'boolean') out.productTourDone = raw.productTourDone;
      // TOUR-02-GUIDE-PERSIST — ADP-945 sınıfının ALTINCI kurbanı. Bu satır olmadan
      // Rehber'i bitiren kullanıcı onu HER AÇILIŞTA yeniden görür. Sınıfı jenerik
      // kapı kapatıyor: agentSettings.test.cjs "varsayılanlardaki HER boolean anahtar
      // yeniden okumada diskten gelir".
      if (typeof raw.onboardingGuideDone === 'boolean') out.onboardingGuideDone = raw.onboardingGuideDone;
      if (typeof raw.updateChannel === 'string') out.updateChannel = raw.updateChannel; // ADP-620
      // ADP-675 — okundu defteri. readSettings BEYAZ LİSTE olduğu için bu satır
      // ŞART: yoksa "okudum" diske yazılır ama bir daha OKUNMAZ (yeniden açılışta
      // duyuru geri gelirdi — e2e S2 bunu yakaladı).
      if ('announcementsRead' in raw) out.announcementsRead = sanitizeAnnouncementsRead(raw.announcementsRead);
      if (raw.mcpServers && typeof raw.mcpServers === 'object') out.mcpServers = { ...raw.mcpServers };
      if ('theme' in raw) out.theme = sanitizeTheme(raw.theme);
      if ('browserTrust' in raw) out.browserTrust = sanitizeBrowserTrust(raw.browserTrust); // ADP-343
      if ('teamScope' in raw) out.teamScope = teamScope.sanitizeTeamScope(raw.teamScope); // ADP-717
      // TC-01 — BEYAZ LİSTE ŞART (ADP-675/717/888/945 tuzağı): bu satır olmadan
      // kullanıcının seçtiği özerklik kademesi diske YAZILIR ama BİR DAHA OKUNMAZ →
      // her açılışta 'ask'a döner ("seçtim, geri geldi").
      if ('teamCompose' in raw) out.teamCompose = sanitizeTeamCompose(raw.teamCompose);
      // ADP-900 — BEYAZ LİSTE ŞART (ADP-675/717/888 tuzağı): yoksa kullanıcının
      // onayı diske yazılır ama BİR DAHA OKUNMAZ → her açılışta yeniden sorulurdu.
      if ('memorySearch' in raw) out.memorySearch = sanitizeMemorySearch(raw.memorySearch);
      // ENG-HONEST-CARD-01 — BEYAZ LİSTE ŞART (ADP-675/717/888/945 tuzağı, yedinci kurban):
      // bu satır olmadan "ücretsiz genel modeli kapat" diske yazılır ama BİR DAHA OKUNMAZ.
      if ('engines' in raw) out.engines = sanitizeEngines(raw.engines);
      if ('resourceGovernor' in raw) out.resourceGovernor = sanitizeResourceGovernor(raw.resourceGovernor);
      if (raw.jarvis && typeof raw.jarvis === 'object') out.jarvis = { ...out.jarvis, ...raw.jarvis };
      // ADP-812 — ESKİ SABİTLENMİŞ TTS MODELİ DÜŞÜRÜLÜR. `tts-1-hd` hiçbir zaman
      // kullanıcının SEÇTİĞİ bir değer değildi: ses seçici onu her kayıtta sessizce
      // yazıyordu (JarvisWidget.saveVoice). Diskteki bu artık kalırsa motorun yeni
      // (ölçülmüş ~2 s daha hızlı) varsayılanı hiçbir kurulumda devreye GİRMEZ —
      // kaldırılmış-özellik artıklarıyla (ADP-844) aynı desen. Model seçici bir gün
      // UI'ya gelirse BU SATIR KALKAR (o zaman değer gerçek bir tercih olur).
      if (out.jarvis && out.jarvis.ttsModel === LEGACY_PINNED_TTS_MODEL) delete out.jarvis.ttsModel;
      // HAND-A1 — beyaz liste ŞART (ADP-675/717 tuzağı): yoksa "overlay'i kapattım"
      // diske yazılır ama BİR DAHA OKUNMAZ → her açılışta yeniden açılırdı.
      if ('handControl' in raw) out.handControl = handOverlayContract.sanitizeHandControl(raw.handControl);
      // ADP-304 — iki-kademe merge: kısmi patch diğer kutuları silmesin.
      if (raw.notifications && typeof raw.notifications === 'object') {
        out.notifications = {
          ...out.notifications,
          ...raw.notifications,
          toast: { ...out.notifications.toast, ...(raw.notifications.toast || {}) },
        };
      }
    }
  } catch {
    /* no file yet / bad JSON → defaults */
  }
  // ADP-844 — ikinci kemer: disk temizliği başarısız olduysa (salt-okunur disk) bile
  // kaldırılmış bir alan ÖNBELLEĞE ve oradan hiçbir tüketiciye SIZMAZ.
  settingsMigrations.purgeRemovedKeys(out);
  _cache = out;
  return out;
}

/**
 * Merge `patch` into settings, persist, bust the cache. Returns the new settings.
 * ADP-874 — `opts.io` YALNIZ test dikişidir ({ fs, platform, sleep, log }); üretim
 * çağıranlarının hiçbiri geçmez ve geçmediğinde davranış birebir aynıdır.
 */
/** ENG-HONEST-CARD-01 — `{ opencode:{…} }` + `{ crush:{…} }` → ikisi de kalır; aynı motorda alanlar birleşir. */
function mergeEngines(cur, patch) {
  const out = {};
  for (const src of [cur, patch]) {
    if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
    for (const [id, row] of Object.entries(src)) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      out[id] = { ...(out[id] || {}), ...row };
    }
  }
  return out;
}

function writeSettings(patch, opts) {
  const cur = readSettings();
  const next = {
    ...cur,
    ...patch,
    // shallow-merge the nested objects so a partial patch doesn't wipe siblings
    apiKeys: { ...cur.apiKeys, ...(patch && patch.apiKeys) },
    // ENG-OPENAI-COMPAT-01 — özel sağlayıcı TAM DEĞİŞTİRİLİR (birleştirilmez):
    // kullanıcı model listesinden satır SİLEBİLMELİ; shallow-merge silmeyi
    // imkânsız kılardı. Yazarken de kapıdan geçer → diskte ASLA doğrulanmamış
    // bir adres durmaz (elle düzenlenmiş dosya da okurken ikinci kez süzülür).
    customProvider: patch && 'customProvider' in patch
      ? customProvider.customProviderOrNull(patch.customProvider)
      : cur.customProvider,
    mcpServers: { ...cur.mcpServers, ...(patch && patch.mcpServers) },
    jarvis: { ...cur.jarvis, ...(patch && patch.jarvis) },
    // ADP-900 — kısmi patch kardeşleri silmesin: "otomatik indeksi kapat" yazımı
    // onay damgasını çöpe atmamalı (kullanıcı 559 MB'ı yeniden indirmesin).
    memorySearch: { ...cur.memorySearch, ...(patch && patch.memorySearch) },
    // ENG-HONEST-CARD-01 — iki kademe: motor satırları birleşir, satır içi alanlar birleşir.
    engines: sanitizeEngines(mergeEngines(cur.engines, patch && patch.engines)),
    // PANE-CAP-01 — kısmi patch kardeşleri silmesin (yalnız `enabled` yazımı eşikleri
    // çöpe atmasın), sonra kapalı-liste nöbetinden geçsin.
    resourceGovernor: sanitizeResourceGovernor({ ...cur.resourceGovernor, ...(patch && patch.resourceGovernor) }),
    // ADP-304 — ekran (toast) filtreleri: iki-kademe merge (kısmi patch kardeşleri silmesin).
    notifications: {
      ...cur.notifications,
      ...(patch && patch.notifications),
      toast: { ...cur.notifications.toast, ...(patch && patch.notifications && patch.notifications.toast) },
    },
    // HAND-A1 — iki-kademe merge + kapalı-liste nöbeti: kısmi patch (yalnız
    // enabled ya da yalnız density) kardeşini silmesin; çöp değer varsayılana düşsün.
    handControl: handOverlayContract.sanitizeHandControl({
      overlay: {
        ...(cur.handControl && cur.handControl.overlay),
        ...(patch && patch.handControl && patch.handControl.overlay),
      },
      // HAND-BUG-01 — kamera seçimi de İKİ KADEME merge edilir: yalnız overlay
      // yazan bir patch kullanıcının kamera seçimini SİLMEZ (ve tersi).
      camera: {
        ...(cur.handControl && cur.handControl.camera),
        ...(patch && patch.handControl && patch.handControl.camera),
      },
      // HAND-G4 — ÖLÇÜLEN KUSUR (e2e/hand-g4-clinic Y4): bu merge YALNIZ `overlay`
      // ve `camera`yı taşıyordu, yani `zoom` ve `tuning` patch'leri SESSİZCE
      // DÜŞÜYORDU — `settings:set` `ok:true` diyor, kullanıcı eşiği yazıyor, disk
      // hiç değişmiyordu ("kaydettim ama hiçbir şey olmuyor" sınıfı). Ayar kliniğinin
      // eşik alanları bu yüzden ÖLÜ bir kontroldü. Alt nesneler ikişer kademe
      // birleşir (kardeş silinmesin), çöp değer nöbeti aynı sanitize'da kalır.
      zoom: {
        ...(cur.handControl && cur.handControl.zoom),
        ...(patch && patch.handControl && patch.handControl.zoom),
      },
      tuning: {
        ...(cur.handControl && cur.handControl.tuning),
        ...(patch && patch.handControl && patch.handControl.tuning),
      },
    }),
  };
  // ADP-844 — kaldırılmış özelliğin alanı yazıma da SIZAMAZ: `{...cur, ...patch}`
  // yayılımı eski bir renderer'ın (ya da elle düzenlenmiş dosyanın) alanını geri
  // getirmesin. Kaldırılan bir özelliğin ayarı diskte DİRİLTİLEMEZ (defter:
  // settingsMigrations.cjs).
  settingsMigrations.purgeRemovedKeys(next);
  // validate pushToTalkKey
  if (!PUSH_TO_TALK_KEYS.includes(next.pushToTalkKey)) next.pushToTalkKey = DEFAULT_PUSH_TO_TALK_KEY;
  // ADP-303 — boolean-only (a patched garbage value must not park in the cache).
  next.keepExitedPanes = next.keepExitedPanes === true;
  // HATA-07 — boolean-only. Çöp bir değerin ("evet", 1, {}) `true` okunup politikayı
  // sessizce kullanıcı seçiminin üstüne çıkarması tam da kapattığımız arızadır.
  next.autoModelByTaskClass = next.autoModelByTaskClass === true;
  // LDR-F1 — kapalı liste; her çöp değer VARSAYILANA ('warn') düşer. Yanlış yazılmış
  // bir ayarın ürünü sessizce `auto`ya sokması (yani lidere kendiliğinden yazması)
  // İMKANSIZ olsun diye beyaz liste — updateChannel'ın aynı gerekçesi.
  next.leaderAutoRefresh = leaderRefreshPolicy.normalizeMode(next.leaderAutoRefresh);
  // SYNC-F1-6 — boolean-only. Çöp bir değerin ("evet", 1, {}) `true` gibi okunup
  // senkronu SESSİZCE açması, şifrelenmemiş saklama sınırı yüzünden veri sonucu
  // olan bir hatadır: yalnız gerçek `true` sayılır.
  next.cloudSyncEnabled = next.cloudSyncEnabled === true;
  // SYNC-F1-7 — geri alma kolu: yalnız AÇIK `false` kapatır (çöp değer → varsayılan
  // AÇIK). `cloudSyncEnabled`in tersi yönde: orada sessiz açılma tehlikeliydi,
  // burada sessiz KAPANMA tehlikeli (kullanıcı senkronu açar, tercihleri gelmez).
  next.prefsSyncEnabled = next.prefsSyncEnabled !== false;
  // BL-01 — defter REPLACE (patch tam listeyi verir) + şekil zorlanır: çöp bir
  // değer önbelleğe park edip paket tavanının sayımını bozamaz.
  next.knownWorkspaces = Array.isArray(next.knownWorkspaces)
    ? next.knownWorkspaces.filter((r) => typeof r === 'string' && r.trim())
    : [];
  // ADP-945 — tur bayrağı da boolean-only. Çöp bir değer ("evet", 1, {}) `true`
  // gibi okunup turu KALICI olarak susturamaz: yalnız gerçek `true` sayılır.
  next.productTourDone = next.productTourDone === true;
  // TOUR-02-GUIDE-PERSIST — Rehber bayrağı da boolean-only, aynı gerekçeyle.
  next.onboardingGuideDone = next.onboardingGuideDone === true;
  // ADP-859B — widget görünümü kapalı liste: yalnız 'mini' | 'panel'; her çöp
  // değer null'a düşer (renderer varsayılanı kazanır, ekranda sürpriz olmaz).
  if (next.jarvis) {
    next.jarvis.view = next.jarvis.view === 'mini' || next.jarvis.view === 'panel' ? next.jarvis.view : null;
    // AGENTX-WAKE-01 — iki boolean, YALNIZ gerçek `true` açar. Çöp değer ("1",
    // "true", 1) sessizce uykuyu sağırlaştırmasın: varsayılan güvenli taraftır.
    next.jarvis.silentSleep = next.jarvis.silentSleep === true;
    next.jarvis.wakeLegacy = next.jarvis.wakeLegacy === true;
  }
  // ADP-558 — kısayol: şekil + Shift-only yasağı; çöp/null → null (renderer varsayılanı).
  next.paneZoomShortcut = sanitizePaneZoomShortcut(next.paneZoomShortcut);
  // KEY-01 — yerleştirme ailesi: modifier-only şekil + Shift yasağı; çöp → null.
  next.paneMoveShortcut = sanitizePaneMoveShortcut(next.paneMoveShortcut);
  // ADP-663 — yazı ölçeği: kapalı liste; her çöp değer 'medium'a düşer.
  next.terminalFontScale = sanitizeTerminalFontScale(next.terminalFontScale);
  // ADP-888 — arayüz dili tercihi: kapalı liste; çöp değer 'system'a düşer.
  next.locale = sanitizeLocale(next.locale);
  // ADP-885 Faz B — ses dili tercihi (AYRI eksen): çöp değer 'follow-ui'ya düşer.
  next.voiceLocale = sanitizeVoiceLocale(next.voiceLocale);
  // ADP-533 — updateAutoCheck: yalnız AÇIK boolean false kapatır (çöp değer → default true);
  // updateDismissedVersion: non-empty string ya da null (çöp → null).
  next.updateAutoCheck = next.updateAutoCheck !== false;
  // ADP-907 — boolean-only: çöp değer kartı sessizce susturamaz (varsayılan GÖSTER).
  next.foreignHookNoticeDismissed = next.foreignHookNoticeDismissed === true;
  next.updateDismissedVersion =
    typeof next.updateDismissedVersion === 'string' && next.updateDismissedVersion
      ? next.updateDismissedVersion
      : null;
  // ADP-620 — updateChannel: yalnız 'stable'|'beta' AÇIK tercihtir; her çöp değer
  // 'auto'ya düşer (= instance varsayılanı: müşteri stable). Yanlış yazılmış bir
  // ayarın müşteriyi sessizce beta'ya sokması İMKANSIZ olsun diye beyaz liste.
  next.updateChannel = updateChannel.normalizeChannel(next.updateChannel) || 'auto';
  // ADP-234 — a patched departmentDirs is REPLACED (not merged) after sanitizing;
  // patch {departmentDirs:null} explicitly resets to the built-in mapping.
  if (patch && 'departmentDirs' in patch) next.departmentDirs = sanitizeDepartmentDirs(patch.departmentDirs);
  // B-01 — aynı "REPLACE, merge etme" disiplini: {projectIsolation:null} bir projeyi
  // izolasyondan çıkarmanın tek yoludur (yarım kalmış bir harita bırakmaz).
  if (patch && 'projectRepos' in patch) next.projectRepos = sanitizeDepartmentDirs(patch.projectRepos);
  if (patch && 'projectIsolation' in patch) next.projectIsolation = sanitizeProjectIsolation(patch.projectIsolation);
  // CIDX-1 — aynı REPLACE disiplini: {codeIndex:null} tüm projelerde indeksi
  // kapatmanın tek yoludur (yarım birleşmiş bir harita "kapattım sanıyordum"
  // sınıfı bir sessiz açık kol bırakırdı — bu ayar her turda para yakıyor).
  if (patch && 'codeIndex' in patch) next.codeIndex = codeIndex.sanitizeCodeIndex(patch.codeIndex);
  // ADP-258 — a patched theme is REPLACED (not merged) after sanitizing; {theme:null}
  // explicitly resets to the renderer default.
  if (patch && 'theme' in patch) next.theme = sanitizeTheme(patch.theme);
  // ADP-343 — güven ayarı da REPLACE (merge DEĞİL): listeden silinen bir domain, eski
  // değerle birleşip geri gelirse "kaldırdım sanıyordum" = güvenlik deliği. Ayarlar
  // paneli her zaman TAM nesneyi (mod + iki liste) gönderir.
  next.browserTrust = sanitizeBrowserTrust(
    patch && 'browserTrust' in patch ? patch.browserTrust : cur.browserTrust,
  );
  // ADP-717 — takım izinleri de REPLACE (merge DEĞİL), browserTrust ile aynı gerekçe:
  // listeden KALDIRILAN bir izin, eski değerle birleşip geri gelirse "iptal ettim
  // sanıyordum" = yetki deliği. UI her zaman TAM nesneyi gönderir.
  next.teamScope = teamScope.sanitizeTeamScope(
    patch && 'teamScope' in patch ? patch.teamScope : cur.teamScope,
  );
  // TC-01 — özerklik kademesi de REPLACE (merge DEĞİL): kullanıcı kademeyi
  // düşürdüğünde eski değerle birleşip geri gelmesi "kapattım sanıyordum" =
  // yetki deliği olurdu (browserTrust/teamScope ile aynı gerekçe).
  next.teamCompose = sanitizeTeamCompose(
    patch && 'teamCompose' in patch ? patch.teamCompose : cur.teamCompose,
  );
  // ADP-737 — MANDAL ARTIK BURADA YAZILMAZ (ADP-729 §5'te ölçülen mayın).
  //
  // ADP-717'de bu satır `if (!next.teamScope.enforcedSince) … = new Date()` idi: yani
  // TEMA değişikliği, telemetri anahtarı, "duyuruyu okudum" — ayarlara yapılan HER
  // yazım kapıyı kurup damgayı basıyordu. Kapı modülünü hiç içermeyen bir build bile
  // (0.2.20) kullanıcının hesabına "kural yürürlükte" yazabildi; kullanıcı kapılı
  // sürüme geçtiği an kural GERİYE DÖNÜK yürürlükteydi ve izin listesi boştu.
  //
  // Mandalı artık YALNIZ `ensureTeamScopeMandate()` çakar — yani kapının GERÇEKTEN
  // koştuğu ilk yetki kararı. Ek olarak: bir kez usulünce çakılmış mandal (damga +
  // damgayı çakan sürüm) buradan DEĞİŞTİRİLEMEZ; Ayarlar ekranı tam nesneyi yazsa da
  // yürürlük anını ileri kaydıramaz/düşüremez (izinler elbette yazılabilir kalır).
  const curScope = teamScope.sanitizeTeamScope(cur.teamScope);
  if (teamScope.mandateArmed(curScope)) {
    next.teamScope.enforcedSince = curScope.enforcedSince;
    next.teamScope.enforcedBy = curScope.enforcedBy;
  }
  // ADP-874 (790 K1 · ADR-W10 Kural 2) — AYARIN DİSKE İNMESİ PLATFORM BOĞAZINDAN GEÇER.
  //
  // 🔴 Bu satır ADP-835'in modül başlığında tarif ettiği arızanın TA KENDİSİYDİ ve
  // taşınmamıştı: hedefin ÜZERİNE düz `writeFileSync` + istisnayı YUTAN bir catch.
  // Windows'ta Defender/Search/yedekleme ajanı yeni yazılan dosyayı açık tutunca
  // EPERM/EBUSY gelir; burada hata yutulur, `_cache` GÜNCELLENİR, kullanıcı ayarını
  // kaydedilmiş görür — ve yeniden açılışta ayar YOKTUR. Yeniden üretilemeyen bir
  // hayalet: "ayarım kaydolmadı".
  //
  // Değişen İKİ şey: (1) tmp'ye yaz + rename (atomik; win32'de rename yeniden
  // denenir, kalıcı düşüşte tmp artığı temizlenir), (2) düşüş artık SESSİZ DEĞİL.
  // DEĞİŞMEYEN: fonksiyon hâlâ FIRLATMAZ ve `_cache` yine güncellenir — çağıranların
  // hiçbirinin imzası/akışı değişmiyor (ADR-W10 Kural 2).
  // darwin: tek atış rename → gözlemlenebilir davranış farkı yok.
  //
  // ADP-946 — ÜÇÜNCÜ ŞEY: "YAZDIM" İDDİA, KANIT DEĞİL → GERİ OKU.
  // ADP-943'ün genel kuralı buraya da uyguladı: `atomicWriteFileSync` başarı dönse
  // bile diski geri okumadan "kalıcı" diyemeyiz (AV karantinası dosyayı yazımdan
  // SONRA yutabilir; roaming profil geri sarabilir). Round-trip'te `workspaceRoot`
  // eşleşmiyorsa yazım BAŞARISIZ sayılır. Sonuç `_lastPersist`e işlenir ve
  // `applySettingsPatch` üzerinden ÇAĞIRANA döner — böylece çalışma alanı seçimi
  // gerçekte düşmüşken ekranda "seçildi" DİYEMEZ (ADP-946'da ölçülen yalan).
  const io = (opts && opts.io) || {};
  const file = settingsPath();
  const payload = JSON.stringify(next, null, 2);
  let outcome = { ok: true, code: null, reason: 'written', inPlace: false, file };
  try {
    const w = atomicWriteFileSync(file, payload, {
      encoding: 'utf8',
      dirMode: undefined,
      // ADP-946 — Windows'ta rename'i bloklayan okuyucu yazımı bloklamıyor olabilir.
      inPlaceFallback: true,
      ...io,
    });
    outcome.inPlace = w.inPlace === true;
    // GERİ OKUMA — yazımın diskte GERÇEKTEN durduğunun tek kanıtı.
    const back = JSON.parse(fs.readFileSync(file, 'utf8'));
    if ((back.workspaceRoot ?? null) !== (next.workspaceRoot ?? null)) {
      outcome = { ok: false, code: 'READBACK_MISMATCH', reason: 'readback-mismatch', inPlace: outcome.inPlace, file };
    }
  } catch (e) {
    outcome = {
      ok: false,
      code: (e && e.code) || 'ERR',
      reason: e instanceof SyntaxError ? 'readback-corrupt' : 'write-failed',
      inPlace: outcome.inPlace,
      file,
      err: e, // enjekte edilmiş logger'ın iki-argümanlı imzası KORUNUR
    };
  }
  if (!outcome.ok) {
    const line = `settings persist FAILED (${outcome.code}/${outcome.reason}): ${file} — `
      + 'ayar bu oturumda geçerli ama DİSKE YAZILAMADI (yeniden açılışta kaybolur)';
    // ADP-946 — paketli Windows app'in stderr'i HİÇBİR YERE gitmez (Explorer'dan
    // açılır, konsol yoktur). Bu yüzden main artık `setPersistLogger(logLine)` ile
    // uygulama log'unu takıyor; stderr yalnız o takılı değilken son çare.
    if (typeof io.log === 'function') { try { io.log(line, outcome.err); } catch { /* ölçüm yazımı bloklamaz */ } }
    else if (_persistLogger) { try { _persistLogger(line); } catch { /* best-effort */ } }
    else { try { process.stderr.write(`[settings] ${line}\n`); } catch { /* best-effort */ } }
  } else if (outcome.inPlace && _persistLogger) {
    try { _persistLogger(`settings persist: rename bloklandı, YERİNDE yazıldı (atomik değil): ${file}`); } catch { /* best-effort */ }
  }
  _lastPersist = outcome;
  _cache = next;
  return next;
}

/** Son `writeSettings` yazımının hükmü: `{ ok, code, reason, inPlace, file }`. */
function lastPersistOutcome() {
  const { err, ..._public } = _lastPersist; // ham hata nesnesi dışarı SIZMAZ
  void err;
  return _public;
}

/** main.js açılışta `logLine`ı takar — sessiz stderr yerine uygulama log'u. */
function setPersistLogger(fn) {
  _persistLogger = typeof fn === 'function' ? fn : null;
}

/**
 * ADP-737 — mandalı çakan sürümün YEDEK kaynağı. Çağıran (main) `app.getVersion()`
 * geçer; geçmeyen yollar (Electron'suz koşan araç/test) için paketin kendi
 * `package.json`'ı okunur. Sürüm hiç çözülemezse `'unknown'` yazılır — bu bile
 * "damgayı KAPIYI TAŞIYAN bir kod çaktı" bilgisini verir (sahipsiz damgadan ayırır).
 *
 * ADP-748 — YOL DÜZELTMESİ: eskiden `../package.json` okunuyordu. Kaynak ağacında bu
 * REPO KÖKÜNÜN manifest'ine denk geliyordu (sürüm aynı olduğu için hata fark edilmedi),
 * ama app.asar'ın kökü `electron/`'dur → pakette `../package.json` asar'ın DIŞINA çıkar
 * ve YOKTUR. Sonuç: paketlenmiş uygulamada bu yedek her zaman `null` dönüyordu
 * (`enforcedBy: 'unknown'`) ve ADP-726 require-grafiği kapısı 0.2.23 yayınını haklı
 * olarak durdurdu. `./package.json` HER İKİ bağlamda da doğru dosyayı verir:
 * kaynakta `electron/package.json`, pakette asar kökündeki aynı manifest — ikisi de
 * release.sh tarafından bump'lanır. Ayrıca kök manifest'e olan bağımlılık kalkar
 * (o dosya `asar extract-file` kazalarında ezilebiliyor — ADP-319/ADP-666).
 */
let _pkgVersion;
function packagedVersion() {
  if (_pkgVersion !== undefined) return _pkgVersion;
  try {
    _pkgVersion = String(require('../../package.json').version || '') || null;
  } catch {
    _pkgVersion = null;
  }
  return _pkgVersion;
}

/**
 * ADP-717 §3.5 — kuralın YÜRÜRLÜK ANINI bir kez diske çiviler ve teamScope ayarını döner.
 *
 * TETİKLEME ZAMANI ÖNEMLİ (ve bilerek TEMBEL): mandal, ilk YETKİ KARARI anında yazılır —
 * uygulama açılışında değil. Sebep: açılışta resume, ADP-717 ÖNCESİNDEN gelen pane'leri
 * yeniden doğurur ve onlara TAZE bir `startedAt` verir. Mandalı açılışta çakarsak o
 * pane'ler "kuraldan sonra doğmuş" sayılır ve lider onları bir daha kapatamazdı — yani
 * düzeltmek istediğimiz tıkanıklığı (ADP-706/715'i teslim ettirmeyen tıkanıklık) aynen
 * geri getirirdi. İlk karar anında ne varsa, o kuraldan ÖNCEDİR.
 *
 * İdempotent: mandal doluysa hiçbir şey yazmaz (sonraki açılışlarda no-op).
 *
 * ADP-737 — MANDALIN SAHİBİ VAR. Damganın yanına onu çakan SÜRÜM de yazılır
 * (`enforcedBy`). Sahipsiz damga (`enforcedSince` var, `enforcedBy` yok) = kapıyı
 * taşımayan bir build'in/dev sürecinin bıraktığı MAYIN (ADP-729 §5): kural o hesapta
 * hiç uygulanmamış olduğu hâlde "çoktan yürürlükte" görünür. Böyle bir damga burada
 * bir kez YENİDEN çakılır: yürürlük anı = kapının gerçekten koştuğu ilk an. Böylece
 * o anda AYAKTA olan her pane §3.5 `legacy-pane` toleransına girer ve yükseltme
 * kimsenin çalışan işini yönetilemez hâle getirmez.
 *
 * @param {string} [appVersion] mandalı çakan sürüm (main: app.getVersion()).
 */
function ensureTeamScopeMandate(appVersion) {
  const cur = teamScope.sanitizeTeamScope(readSettings().teamScope);
  if (teamScope.mandateArmed(cur)) return cur;
  const by = (typeof appVersion === 'string' && appVersion.trim()) || packagedVersion() || 'unknown';
  return teamScope.sanitizeTeamScope(
    writeSettings({
      teamScope: { ...cur, enforcedSince: new Date().toISOString(), enforcedBy: by },
    }).teamScope,
  );
}

/**
 * ADP-717 — güncel takım-kapsamı politikası (teamScope.authorize'a verilen `policy`).
 * Mandalı da garanti eder (yukarıdaki tembel-yazım sözleşmesi).
 */
function teamScopePolicy(appVersion) {
  return ensureTeamScopeMandate(appVersion);
}

/**
 * ADP-737 — İZİN VER (sahibin onay akışının yazma ucu; UI'daki tam-nesne yazımının
 * yanında ikinci ve KÜÇÜK bir kapı). Karar main'de verilir, kalıcılaştırma burada:
 * mevcut izinlerle BİRLEŞTİRİR (teamScope.addGrant) — böylece "her onay yeni bir satır"
 * birikmesi olmaz ve kullanıcı Ayarlar'da ne verdiğini okuyabilir.
 * @returns {{ok:boolean, policy:object}}
 */
function grantTeamScope({ leaderId, scopes, mode, expiresAt, origin } = {}) {
  const policy = teamScopePolicy();
  const res = teamScope.addGrant(policy.grants, {
    leaderId,
    scopes,
    mode,
    expiresAt: expiresAt || null,
    // TC-05 — `'system'` = ürünün KENDİ yazdığı izin (takım kurucu apply'ı). Geri alma
    // yalnız bunu siler; sahibin eliyle verdiği `'user'` izni hiçbir akış geri almaz.
    origin: origin === 'system' ? 'system' : 'user',
  });
  if (!res.changed) return { ok: false, policy };
  const saved = writeSettings({ teamScope: { ...policy, grants: res.grants } });
  return { ok: true, policy: teamScope.sanitizeTeamScope(saved.teamScope) };
}

/**
 * TC-05 — İZNİ GERİ AL (`grantTeamScope`ın tersi). Takım kurucunun 10 dakikalık geri
 * alması, apply'ın yazdığı izni de götürür: kurulum geri alındıysa lider o takıma
 * (artık yok) iş verme yetkisini taşımaya devam etmemeli.
 *
 * `origin` ZORUNLUdur ve pratikte `'system'`dir: sahibin kendi verdiği izin bir geri
 * almayla kaybolmaz (bkz. teamScope.revokeGrant).
 * @returns {{ok:boolean, policy:object}}
 */
function revokeTeamScope({ leaderId, scope, origin } = {}) {
  const policy = teamScopePolicy();
  const res = teamScope.revokeGrant(policy.grants, { leaderId, scope, origin });
  if (!res.changed) return { ok: false, policy };
  const saved = writeSettings({ teamScope: { ...policy, grants: res.grants } });
  return { ok: true, policy: teamScope.sanitizeTeamScope(saved.teamScope) };
}

// ADP-852 v3 — "YOK" ile "BAKAMIYORUM" AYNI ŞEY DEĞİL.
//
// Eskiden `isDir` her hatayı tek bir `false`'a çeviriyordu. macOS TCC (Documents/
// Downloads/Desktop izni verilmemiş) `statSync`'i **EPERM** ile düşürür: klasör VARDIR,
// bir dizindir, yalnız çekirdek bakmamıza izin vermez. O `false` yukarıda
// "çalışma alanı seçilmemiş"e dönüşüyordu → kullanıcı ASLA gerçek sebebi (izin)
// görmüyordu. Ölçüm: sandbox-exec ile okuması reddedilen GERÇEK dizinde
// `statSync` → EPERM, `isDir` → false, `commitWorkspaceRoot` → 'not-a-directory'.
//
// `probeDir` bu üç durumu AYIRIR; `isDir` onun üstünde aynı boolean sözleşmesiyle
// kalır (mevcut çağıranların davranışı bit-bit korunur).
const DENIED_CODES = new Set(['EPERM', 'EACCES']);

/**
 * @returns {{ ok: boolean, reason: 'ok'|'unset'|'missing'|'denied'|'not-a-directory', code?: string }}
 *   ok            — var ve dizin
 *   unset         — yol verilmemiş (boş/string değil)
 *   missing       — ENOENT: silinmiş/taşınmış
 *   denied        — EPERM/EACCES: VAR ama erişim izni yok (macOS TCC sınıfı)
 *   not-a-directory — var, erişilebilir, ama dizin değil (dosya/symlink hedefi)
 */
function probeDir(p) {
  if (typeof p !== 'string' || p.length === 0) return { ok: false, reason: 'unset' };
  try {
    return fs.statSync(p).isDirectory()
      ? { ok: true, reason: 'ok' }
      : { ok: false, reason: 'not-a-directory' };
  } catch (e) {
    const code = (e && e.code) || 'ERR';
    if (DENIED_CODES.has(code)) return { ok: false, reason: 'denied', code };
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: 'missing', code };
    // Bilinmeyen hata da "bakamadım"dır — sessizce "yok" DEME.
    return { ok: false, reason: 'denied', code };
  }
}

/** Validate a dir path; return it only if it exists and is a directory. */
function isDir(p) {
  return probeDir(p).ok;
}

/**
 * ADP-232-C — the EXPLICITLY configured workspace root (env override →
 * settings.workspaceRoot), or null when neither points at a real directory.
 * "Configured" is the first-run signal: a packaged app with no configured root
 * must show the workspace onboarding instead of falling into the bundle.
 */
function configuredWorkspaceRoot() {
  return configuredWorkspaceRootStatus().root;
}

/**
 * ADP-852 v3 — İKİ EKRANIN PAYLAŞTIĞI TEK GERÇEK.
 *
 * VAKA (müşteri, 0.2.27): Ayarlar→Genel çalışma alanını DOLU gösteriyordu
 * (`settings:get` ham `settings.workspaceRoot`'u dönüyor), Sistem Durumu ise
 * KIRMIZI "Çalışma klasörü seçilmedi" diyordu (doctor çözülmüş `agentWorkspaceRoot`'u
 * alıyor). İki ekran iki FARKLI değere bakıyordu; kullanıcı için bu bir çelişki.
 *
 * Bu fonksiyon üç alanı birlikte verir, böylece her yüzey aynı hükmü anlatır:
 *   • `configured` — kullanıcının SEÇTİĞİ yol (kullanılamasa da gösterilir)
 *   • `root`       — GERÇEKTEN kullanılabilir kök (yoksa null) — eski sözleşme
 *   • `reason`     — neden kullanılamıyor ('denied' | 'missing' | 'not-a-directory' | 'unset')
 *
 * @returns {{ root: string|null, configured: string|null, source: 'env'|'settings'|null,
 *             reason: 'ok'|'unset'|'missing'|'denied'|'not-a-directory', code?: string }}
 */
function configuredWorkspaceRootStatus() {
  // PLAN-FIX-01 (F-3 / FIX-B) — ENV KAPISI MÜŞTERİ BUILD'İNDE KAPALI.
  //
  // Bu dal env'i BİRİNCİ sırada okur ve hiçbir plan kapısından geçmez: çalışma alanı
  // tavanı (Basic=1) `CREWPANE_WORKSPACE_ROOT` yazabilen herkes için ETKİSİZDİ —
  // her açılışta env'i değiştirerek sınırsız alan elde edilebiliyordu (PLAN-GATE-R1 §6).
  // Bu, ADP-646'nın `buildChannel.cjs` ile kapattığı "env yazabilen herkes için açık
  // kapı" sınıfının aynısıdır; o koruma bu kadranda eksik kalmıştı.
  //
  // Kapı YALNIZ paketli MÜŞTERİ main sürecinde iner (`escapesAllowed()` false):
  //   • `node --test` / MCP çocukları / `crewpaneCli` → Electron değil → true (env okunur)
  //   • kaynaktan koşan dev + e2e (isPackaged=false)     → true (env okunur)
  //   • bizim dev/test DMG'lerimiz (baked build)         → true (env okunur)
  // Yani env, çocuk süreçler için MEŞRU kanal olmaya devam eder; main.js kendi
  // `process.env`'ine bu adı hiç yazmaz (yalnız çocuk env'ine — main.js CREWPANE_
  // WORKSPACE_ROOT satırı), dolayısıyla müşteri main'inde bu değer varsa DIŞARIDAN
  // gelmiştir — tam da kapatılmak istenen yol.
  const env = buildChannel.escapesAllowed()
    ? crewpaneEnv.readEnv('WORKSPACE_ROOT') // ADP-244 Faz 3 — dual-read
    : undefined;
  const envProbe = probeDir(env);
  if (envProbe.ok) return { root: env, configured: env, source: 'env', reason: 'ok' };

  const fromSettings = readSettings().workspaceRoot;
  const setProbe = probeDir(fromSettings);
  if (setProbe.ok) return { root: fromSettings, configured: fromSettings, source: 'settings', reason: 'ok' };

  // Hiçbiri kullanılabilir değil. Kullanıcının SEÇTİĞİ değeri (varsa) ve o seçimin
  // NEDEN tutmadığını taşı — "seçilmedi" ile "seçildi ama erişilemiyor" ayrı hükümler.
  if (typeof fromSettings === 'string' && fromSettings) {
    return { root: null, configured: fromSettings, source: 'settings', reason: setProbe.reason, code: setProbe.code };
  }
  if (typeof env === 'string' && env) {
    return { root: null, configured: env, source: 'env', reason: envProbe.reason, code: envProbe.code };
  }
  return { root: null, configured: null, source: null, reason: 'unset' };
}

/**
 * Resolve the AGENT workspace root: env override → settings.workspaceRoot → fallback.
 * The fallback (REPO_ROOT) is passed by the caller (main.js) since only it knows the
 * bundle layout. An invalid configured path silently falls through to the fallback.
 * ADP-232-C — the packaged app passes fallback=null (its REPO_ROOT is inside the
 * app bundle; using it made delegated agents land in Resources/), so an
 * unconfigured packaged install resolves to null and the first-run gate handles it.
 */
function resolveWorkspaceRoot(fallback) {
  return configuredWorkspaceRoot() || fallback;
}

/**
 * ADP-232 — apply a settings patch and say whether a restart is needed.
 * `workspaceRoot` is resolved ONCE at module load in main.js (spawn cwd, file
 * bridge, embedded-server env), so changing it only takes effect after an app
 * restart; saving the SAME value must never demand one. Single unit-testable
 * home for the compare the `settings:set` IPC handler returns as `restartRequired`.
 */
function applySettingsPatch(patch) {
  const prevWorkspaceRoot = readSettings().workspaceRoot;
  const next = writeSettings(patch || {});
  // ADP-946 — EK ALANLAR (imza kırılmaz, ADR-W10 Kural 2): yazım gerçekten diske
  // indi mi? `writeSettings` fırlatmaz, o yüzden bunu sormanın tek yolu buydu.
  const persist = lastPersistOutcome();
  return {
    next,
    restartRequired: next.workspaceRoot !== prevWorkspaceRoot,
    persisted: persist.ok,
    persistError: persist.ok ? null : `${persist.code}/${persist.reason}`,
  };
}

/** The OpenAI API key from settings (apiKeys.openai), or '' if unset. */
function openAiKeyFromSettings() {
  const s = readSettings();
  const k = s.apiKeys && s.apiKeys.openai;
  return typeof k === 'string' ? k.trim() : '';
}

module.exports = {
  settingsPath, // ADP-206 — now a fn (instance-scoped), no longer a load-time const
  PUSH_TO_TALK_KEYS,
  THEME_MODES,
  sanitizeTheme,
  sanitizeLocale, // ADP-888 — arayüz dili tercihi (kapalı liste)
  sanitizeVoiceLocale, // ADP-885 Faz B — SES dili tercihi (ayrı eksen, kapalı liste)
  sanitizeBrowserTrust, // ADP-343
  sanitizeTelemetryState, // ADP-845 — heartbeat kalıcı durumu
  sanitizeResourceGovernor, // PANE-CAP-01 — kaynak bekçisi eşikleri (kapalı liste)
  sanitizeMemorySearch, // ADP-900 — hafıza arama tercihleri + indirme onay damgası
  sanitizeEngines, // ENG-HONEST-CARD-01 — motor politikaları (vendorHosted allow|block)
  VENDOR_HOSTED_POLICIES,
  ensureTeamScopeMandate, // ADP-717 — yürürlük mandalı (idempotent)
  sanitizeTeamCompose, // TC-01
  teamScopePolicy, // ADP-717 — authorize()'a verilen politika
  grantTeamScope, // ADP-737 — sahibin onay akışı bir izni buradan kalıcılaştırır
  revokeTeamScope, // TC-05 — takım kurucunun geri alması kendi yazdığı izni buradan siler
  DEFAULT_PUSH_TO_TALK_KEY,
  defaults,
  readSettings,
  writeSettings,
  applySettingsPatch,
  lastPersistOutcome, // ADP-946 — "yazdım" değil, GERİ OKUNMUŞ hüküm
  setPersistLogger, // ADP-946 — sessiz stderr yerine uygulama log'u (paketli Windows)
  configuredWorkspaceRoot, // ADP-232-C — first-run signal
  configuredWorkspaceRootStatus, // ADP-852 v3 — iki ekranın paylaştığı TEK gerçek
  probeDir, // ADP-852 v3 — "yok" ile "erişilemiyor" ayrımı
  resolveWorkspaceRoot,
  openAiKeyFromSettings,
  isDir,
  /**
   * ADP-716 — okuma önbelleğini DÜŞÜR. Ürün yolunda gerçek bir ihtiyaç:
   * `settingsPath()` hesap köküne (ADP-703 `accounts/<key>/`) bağlıdır ve o kök
   * açılışta `bindAccountRoot()` ile SONRADAN pinlenir. Pin'den ÖNCE herhangi bir
   * `readSettings()` çağrısı olduysa önbellek KAPSAMSIZ kökten (çoğu zaman boş
   * varsayılanlardan) dolar ve bir daha tazelenmez → hesap kökündeki gerçek ayarlar
   * o süreç boyunca GÖRÜNMEZ olur.
   *
   * Somut kurban: duyuru okundu defteri. "Okudum" doğru dosyaya YAZILIYOR, ama
   * yeniden açılışta bayat önbellek okunduğu için duyuru okunmamış görünüyordu
   * (ADP-716 canlı e2e'si yakaladı; ADP-675'in kalıcılık kanıtı ADP-703'ten sonra
   * sessizce geçersizleşmiş).
   *
   * main.js bunu hesap pin'i yazıldıktan HEMEN SONRA çağırır.
   */
  invalidateCache: () => {
    _cache = null;
  },
  // test seam — reset the module cache between cases
  _resetCache: () => {
    _cache = null;
  },
};
