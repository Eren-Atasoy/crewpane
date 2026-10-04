// ENG-04 (SPRINT-ENGINE-03) — MOTOR TANIMLAYICISI (Engine Descriptor): motor
// "vatandaşlığı" tek bir BİLDİRİMSEL veri nesnesinde.
//
// NEDEN: bugün bir motorun kim olduğu 8 elle-senkron defterde + ~84 koşul dalında
// yaşıyor (ölçüm: ENG-R3-ironhide.md §1.2/§1.3). Hiçbiri derleyici tarafından
// zorlanmıyor; unutulan defter SESSİZ yanlış davranış üretiyor (ENG-R3 §14-R1:
// "sessiz yetenek kaybı" — bugünkü `return argv` deseni bilinmeyen motorda kimliği,
// alt-ajan bloğunu, board'u kimseye söylemeden düşürür).
//
// BU DOSYA DAVRANIŞ DEĞİŞTİRMEZ. Kimse henüz buradan okumuyor: ENG-04 yalnız
// descriptor'ı + iki kapıyı (şema testi, drift testi) kurar. Davranışın buraya
// taşınması ENG-07/08'in işi — taşınacak bir YER olsun diye önce bu var.
//
// ⚠️ TEK KURAL: buradaki her alan BUGÜNKÜ kodun AYNASIDIR, iyileştirilmiş hâli
// değil. Bir alan bugünkü davranıştan farklıysa bu bir HATA'dır, "düzeltme" değil —
// `engineRegistry.test.cjs` DRIFT bloğu tam olarak bunu kırmızıya çevirir.
//
// ─────────────────────────────────────────────────────────────────────────────
// ÜÇ KAPI (ENG-R2-inferno.md §9-2): motoru 8 yetenek yerine üç soyutlamayla oku
//   1. KİMLİK enjeksiyonu → `identity.kind`: flag | env-file | project-file |
//      positional | none
//   2. ARAÇ bağlama       → `mcp.kind`: config-file | config-profile | cli-overrides | config-only | none
//   3. SÜPERVİZÖR okuma   → `output.kind`: json | jsonl | text
// (`env-file`/`project-file`/`config-only`/`text` bugün hiçbir kayıtta KULLANILMIYOR;
//  şemada yaşıyorlar çünkü ENG-R2 §3'teki 14 motorun 11'i onlardan biri. İsim
//  kontrolü değil YETENEK kontrolü — `feedback_no_hardcoded_brand_cases` deseni.)
//
// ─────────────────────────────────────────────────────────────────────────────
// `null` YETENEK = BİLİNÇLİ BEYAN, sessiz boşluk DEĞİL.
// Bir yetenek `null` ise `unsupported[<alan>]` GEREKÇESİ ZORUNLUDUR (şema testi
// bunu makine olarak zorlar — yorum satırı denetlenemez, gerekçe alanı denetlenir).
// Yeteneğin YARIM olduğu yerlerde `partial[<alan>]` aynı işi görür (ör. codex MCP
// kaydı ADDITIVE — `--strict` dengi yok, ENG-R3 §14-R4).
// `unsupportedCapabilities()` bu iki haritayı bir pane'in "yapamayacakları"
// listesine çevirir (ENG-10 rozet girdisi) ve KAYITSIZ motorda HER şeyi listeler:
// tanımadığımız motor sessizce yetenekli sayılmaz.
//
// ─────────────────────────────────────────────────────────────────────────────
// `verification` — her yetenek için KANAL beyanı (ENG-R3 §14-R7: "doküman ≠ ikili").
//   • `measured` — gerçek koşu/pty ile ÖLÇÜLDÜ (ENG-R2 §2 turları, ADP probe'ları)
//   • `source`   — bu üründeki kodun aynası (dosya:satır verilir)
//   • `doc`      — yalnız resmî doküman; ölçülmedi (bugünkü iki kayıtta YOK)
//   • `unverified` — beyan edilmemiş; şema testi non-null yetenekte REDDEDER

'use strict';

/** Bir kaydın taşıyabileceği yetenek alanları (hepsi `null` olabilir = beyan). */
const CAPABILITY_KEYS = Object.freeze([
  'identity',
  'model',
  // CDX-F1 (H1) — AKIL-YÜRÜTME EFORU. Model'den AYRI bir kol: aynı model `low` ile de
  // `high` ile de koşar ve fark ÖLÇÜLDÜ (CDX-R1 §3-B kol E: +%129 jeton / +%154 süre).
  // Bugüne kadar ürün bu kolu HİÇ çekmiyordu → codex pane'i kullanıcının
  // `~/.codex/config.toml` varsayılanıyla (bu makinede "low") koşuyordu ve bunu kimse
  // beyan etmiyordu. Alan CAPABILITY_KEYS'e girdiği an her motor efor taşıyıcısını
  // (ya da yokluğunun GEREKÇESİNİ) yazmak zorunda — sessiz kalite kaybı yasağı.
  'effort',
  'images',
  'provider',
  'session',
  'subagentBlock',
  // TOKEN-BUDGET-01 — BAĞLAM KAPSAMI. Motorun KENDİ enjekte ettiği belgeler (proje
  // talimatı zinciri + kalıcı hafıza indeksi) çalışma alanı sınırı tanımıyor ve
  // pane başına HER İSTEKTE 14.051 jeton taşıyor (ölçüldü). Alan buraya girdiği an
  // her motor ya kapsam taşıyıcısını beyan eder ya da beyan ETMEYEREK bugünkü
  // davranışta kalır — sessiz bağlam şişmesi yasağı.
  'contextScope',
  'trust',
  'reset',
  'tui',
  'mcp',
  'hooks',
  'extraRoots',
  'skillsDir',
  'identityEnv',
  'auth',
  'usage',
  'output',
  'install',
]);

/** Yetenek dışı zorunlu kimlik alanları. */
const REQUIRED_KEYS = Object.freeze(['id', 'label', 'bin', 'defaultArgs']);

/**
 * Kaybı GÜVENLİK sorunu olan yetenekler. Bunlar eksikse rozet/log "bilgi" değil
 * UYARI basmalı: ENG-R3 §2.3 — alt-ajan bloğu düşen bir motorda ADR-004'ün SERT
 * katmanı kaybolur ve bugün kimse fark etmez.
 */
const SECURITY_CRITICAL_CAPABILITIES = Object.freeze(['identity', 'subagentBlock', 'mcp', 'trust']);

/** `verification` kanalları (ENG-R3 §14-R7). */
const VERIFICATION_CHANNELS = Object.freeze(['measured', 'source', 'doc', 'unverified']);

/**
 * ENG-20 — OTONOMİ (ARAÇ ONAYI) BEYANI.
 *
 * NİÇİN AYRI BİR ALAN: "bu pane onay sorusu sorar mı?" sorusunun cevabı bugüne
 * kadar `defaultArgs` dizisinin İÇİNE gömülüydü ve yalnız YORUM satırında
 * yaşıyordu. Eren'in "codex'te bu özellik yok sanırım" şüphesi haklı çıktı
 * (ENG-20: codex defaultArgs BOŞTU → motor kendi `workspace-write` +
 * escalation-request varsayılanına düşüyordu) ve bunu kimse fark etmemişti,
 * çünkü ölçülebilir bir BEYAN yoktu. Artık her motor otonomi seviyesini
 * SÖYLEMEK zorunda ve `flags` alanı `defaultArgs` ile MAKİNE tarafından
 * karşılaştırılıyor → beyan ile gerçek argv arasında sapma YAPISAL olarak
 * imkânsız (yorum yalan söyleyebilir, bu kapı söyleyemez).
 *
 *   • `full`    — claude paritesi: TÜM araçlar otomatik onaylı, onay sorusu YOK.
 *   • `partial` — sınırlı otonomi (bilinçli ürün kararı; `why` ZORUNLU).
 *   • `unknown` — ÖLÇÜLMEDİ. Tahmin yasak (ENG-09 sözleşmesi): "bilmiyorum"
 *                 dürüst cevaptır, uydurulmuş bir `full` değildir.
 */
const AUTONOMY_LEVELS = Object.freeze(['full', 'partial', 'unknown']);
/** Otonomi hangi kapıdan uygulanıyor: argv bayrağı, pane env'i, config dosyası. */
const AUTONOMY_CHANNELS = Object.freeze(['argv', 'env', 'config', null]);

/** Üç kapının izin verilen değerleri (ENG-R2 §9-2). */
// ENG-ENABLE-01 — 'flag-dir': bayrak bir DOSYA değil bir DİZİN alır ve motor kimliği
// o dizindeki KENDİ DAYATTIĞI adlı dosyadan okur (cursor/antigravity: `--add-dir <dizin>`
// + `AGENTS.md`). `flag` yazmak metni/yolu bayrağa gönderirdi; ikisi de motoru öldürür.
const IDENTITY_KINDS = Object.freeze(['flag', 'flag-dir', 'env-file', 'project-file', 'positional', 'none']);
// ENG-13 — 'cli-command': değer bir config dosyası ya da anahtar/değer override'ı DEĞİL,
// TEK BİR KOMUT DİZESİdir (goose `--with-extension "ENV=1 node '/yol/x.cjs'"`, ölçüldü).
// ENG-16 — 'env-config': araç kaydı ne bayrak ne KALICI dosya; TEK BİR ENV
// DEĞİŞKENİNİN İÇİNDEKİ JSON belgesi (opencode `OPENCODE_CONFIG_CONTENT`, ölçüldü:
// `opencode mcp list` → "eng16 connected"). Pane BAŞINA farklı araç seti verilebilir
// ve diske hiçbir şey yazılmaz → eşzamanlı pane'lerde config-dosyası YARIŞI YOKTUR.
// ENG-17 — 'env-config-dir': araç kaydı ne bayrak ne ENV İÇİNDEKİ belge; ENV bir
// DİZİN adı taşır ve motor o dizindeki SABİT ADLI config dosyasını okur
// (kimi `KIMI_CODE_HOME`/mcp.json · crush `CRUSH_GLOBAL_CONFIG`/crush.json — ikisi de
// ÖLÇÜLDÜ: kanıt MCP sunucusu spawn+initialize+tools/list+tools/call yaptı). 'env-config'ten
// farkı belgenin DİSKTE olmasıdır; 'config-only'dan farkı dizinin PANE BAŞINA ayrılabilmesidir
// → kullanıcının repo'suna/ev config'ine yazılmaz, eşzamanlı pane'lerde YARIŞ YOKTUR.
// CODEX-ARGV-01 — `config-profile`: tablo motorun ev dizinindeki bir OTURUM PROFİLİ
// dosyasına yazılır, argv'ye yalnız `<flag> <profil-adı>` girer. `config-file`den farkı,
// dosyanın argv'de YOLLA değil ADLA anılması ve motorun kendi config'inin ÜSTÜNE
// katmanlanmasıdır (additive). Bkz. codex kaydı + codexMcpProfile.cjs.
const MCP_KINDS = Object.freeze([
  'config-file',
  'config-profile',
  'cli-overrides',
  'cli-command',
  // AGY-01 — 9. TAŞIYICI: ÇALIŞMA-ALANI PLUGIN DEMETİ (antigravity 1.2.2).
  // Sunucular argv'ye ya da kullanıcının config'ine DEĞİL, pane başına üretilen
  // bir KÖKÜN altındaki `.agents/plugins/<ad>/mcp_config.json` demetine yazılır;
  // kök motora `--add-dir` ile verilir ve keşif AJAN ÇALIŞMA ZAMANINDA olur.
  // ⇒ PER-LAUNCH'tır (pane başına ayrılabilir) ve kullanıcının `~/.gemini/config/`
  //   dosyalarına TEK BİT yazmaz (AGY-01 ölçümü: 4 dosyanın sha256'sı AYNI).
  // 🪤 `agy mcp list` bu kaydı GÖSTERMEZ — liste komutu yalnız config dosyalarını
  //   okur; listenin BOŞ kalması arıza değil, global kirlenmenin YOK olduğunun kanıtı.
  'workspace-plugin',
  'config-only',
  'env-config',
  'env-config-dir',
  'none',
]);

// ENG-13/16 — `env-file` taşıyıcısında ENV DEĞİŞKENİ NEYİ TAŞIR?
//   • 'dir'         — kimlik dosyalarının DİZİNİ taranır (copilot) → ADDITIVE birleşir
//   • 'file'        — TEK dosya yolu (goose) → birleştirilemez, kullanıcı değeri EZİLİR
//   • 'json-config' — ENG-16: değer bir yol DEĞİL, motorun TÜM config belgesi (JSON).
//     Kimlik dosyasının yolu belgenin içindeki bir alana yazılır (`identity.configPath`).
//     Ölçüm (opencode 1.18.18): `instructions:["<yol>"]` GÖMÜLÜ prompt'u KORUYARAK ekler
//     (8.164 → 8.248 jeton), `agent.<ad>.prompt` ise gömülü prompt'un YERİNE geçer
//     (8.164 → 6.399) — aynı motorda biri ADDITIVE, öteki REPLACE.
//   • 'json-config-dir' — ENG-17: env bir DİZİN yolu; belge o dizinde `configFileName`
//     adıyla yaşar ve kimlik dosyasının yolu belgenin `configPath` alanına yazılır
//     (crush `CRUSH_GLOBAL_CONFIG`/crush.json → `options.context_paths[]`, ÖLÇÜLDÜ:
//     canlı turda ajan kimlik kod kelimesini yazdı ve araçlarını KORUDU → ADDITIVE).
const IDENTITY_ENV_TARGETS = Object.freeze(['dir', 'file', 'json-config', 'json-config-dir']);
const OUTPUT_KINDS = Object.freeze(['json', 'jsonl', 'text']);
// C4 — headless çocuğun stdin kipi: 'ignore' (opencode: PIPE kalırsa hiç başlamaz) | 'pipe'.
const OUTPUT_STDIN_MODES = Object.freeze(['ignore', 'pipe']);

// CDX-F1 — EFOR TAŞIYICI BİÇİMLERİ (ÖLÇÜLDÜ, gerçek ikililer):
//   • 'flag'         — ayrı bir bayrak (`claude --effort high`; `claude --help` 2.1.246:
//                      "--effort <level>  Effort level for the current session
//                      (low, medium, high, xhigh, max)")
//   • 'cli-override' — motorun config anahtarını PER-LAUNCH ezen tek bir `-c key="value"`
//                      (codex `-c model_reasoning_effort="high"`; ADP-580 sağlayıcı
//                      grameriyle AYNI kanal → kullanıcının config.toml'u YENİDEN YAZILMAZ)
const EFFORT_KINDS = Object.freeze(['flag', 'cli-override']);

// ENG-14 — 🔴 REPLACE TAŞIYICISININ KURTARMA REÇETESİ.
//
// Bazı motorlarda kimlik taşıyıcısı gömülü sistem prompt'unu EKLEMEZ, YERİNE GEÇER
// (gemini `GEMINI_SYSTEM_MD`; ölçüldü: efektif prompt 25.073 → 2.126 karakter).
// Böyle bir taşıyıcıyı reçetesiz kullanmak ENG-04'ün kapattığı sessiz yetenek
// kaybının en pahalı hâlidir: pane kimliğini alır, güvenlik kurallarını kaybeder.
// Bu yüzden `identity.replacesSystemPrompt === true` bir REÇETE BEYANI ZORUNLU kılar
// (şema testi zorlar — yorum satırı denetlenemez).
//   • `self-dump` — motor KENDİ efektif prompt'unu bir env ile dosyaya yazar
//     (gemini `GEMINI_WRITE_SYSTEM_MD`). Taban, sentinel ÇIKARMASIYLA bulunur.
//   • `ledger-dump` — ENG-17: motor efektif prompt'unu KENDİ oturum defterine yazar
//     (kimi `profile.bind.systemPrompt`) ve bunu MODEL ÇAĞRISI BAŞARISIZ OLSA BİLE yazar
//     → taban, kimliksiz bir PROBE koşusundan JETON HARCAMADAN okunur (ölçüldü: geçersiz
//     anahtarla koşu 400 aldı, taban 22.101 karakter olarak defterde duruyordu).
const BASE_PROMPT_KINDS = Object.freeze(['self-dump', 'ledger-dump']);
/** `basePrompt` reçetesi düşerse ne olur? Sessiz REPLACE ASLA kabul edilmez. */
const BASE_PROMPT_FAILURE_MODES = Object.freeze(['skip-identity']);

// ─────────────────────────────────────────────────────────────────────────────
// ENG-08 — 4. KAPI: HESAP AÇMA (`auth.flow`)
//
// ENG-R2 §5.6 auth otomasyonunu ÜÇ desene böldü; ENG-R3 §9.3 bunu bir enum'a
// çevirdi ve `api-key`i BİRİNCİ SINIF şekil yaptı (bugün BYOK ayrı bir yolda:
// providers.cjs). ENG-08 o enum'u ürüne sokar.
//
//   • `oauth-code`     — CLI URL basar, tarayıcı bir KOD verir, kod stdin'e akar
//                        (claude, amp — ENG-R2 §2.5 ölçümü)
//   • `oauth-callback` — CLI localhost dinler, tarayıcı dönüşü CLI'a ULAŞIR (codex)
//   • `api-key`        — abonelik yolu YOK/kapalı: anahtar `credentialVault`ta yaşar
//                        ve env ile verilir; ASLA argv'ye (agentRunner.js:1520-1525)
//   • `external`       — giriş CrewPane DIŞINDA yapılır (IDE/hesap paneli); ürün
//                        yalnız durumu OKUR, akış başlatmaz
//
// 🔴 EREN KURALI (2026-08-17): abonelik BİRİNCİ SINIF. `api-key` bir motorda
// abonelik yolu VARKEN tek yol olarak sunulamaz → `flow` her zaman BİRİNCİL yoldur,
// `apiKey` bloğu YEDEKtir. Abonelik yolu OLMAYAN motorda `flow:'api-key'` dürüstçe
// beyan edilir; olmayan bir abonelik yolu UYDURULMAZ.
// ENG-17 — 5. ŞEKİL: `device-code`. CLI bir KOD GÖSTERİR, kullanıcı tarayıcıda onaylar,
// CLI YOKLAR (kimi: "Authenticate with Kimi Code CLI via the device-code flow").
// `oauth-code`tan farkı KRİTİK: stdin'e HİÇBİR ŞEY yazılmaz → kod KUTUSU çizilmemeli
// (çizilirse kullanıcı boş bir kutuya bakar ve akışın kilitlendiğini sanır).
const AUTH_FLOWS = Object.freeze(['oauth-code', 'oauth-callback', 'api-key', 'external', 'device-code']);

/** Durum komutu çıktısının okuma şekli (engineAuth tek parser hunisi). */
// ENG-ENABLE-01 — 'exit-code': hesap DURUMU komutu OLMAYAN ama girişe BAĞLI ucuz bir
// komutu olan motorlar (antigravity `agy models`). Otorite ÇIKIŞ KODU; metin yalnız
// "ölçemedim"i "hayır"dan ayırmak için okunur (`auth.signedOutPattern` ZORUNLU).
const STATUS_PARSERS = Object.freeze(['json', 'text', 'exit-code']);

/**
 * ENG-09 — DÖRDÜNCÜ KAPI: jeton kullanımını NEREDEN okuduğumuz (ENG-R3 §10.2 "B").
 *   • `session-ledger` — bizim BASTIĞIMIZ oturum kimliğiyle KESİN eşleşen defter (claude)
 *   • `time-window`    — cwd + pane açılış zamanı ile best-effort eşleşen defter (codex)
 *   • `cli-report`     — motorun KENDİ `usage`/`stats` komutu (amp/crush sınıfı)
 *   • `run-envelope`   — AGY-04: defter YOK, sayaç KOŞUNUN KENDİ ÇIKTI ZARFINDA
 *                        (antigravity `--output-format json|stream-json` → `usage{…}`).
 *                        `cli-report`tan farkı: ayrı bir rapor komutu YOKTUR ve
 *                        olmamalıdır — zarfı üretmek için ikinci bir koşu açmak
 *                        MODEL TURU HARCARDI. Zarf, işi zaten koşturan taraf
 *                        (süpervizör) tarafından ENJEKTE edilir (`opts.runEnvelope`).
 *   • `none`           — ölçülemez → kart "bilinmiyor" der, TAHMİN ETMEZ
 * `USAGE_LEVELS` bu sınıfların kullanıcıya GÖSTERİLEN güven seviyesidir (bugünkü
 * `measured` bayrağının genelleşmiş hâli): ölçüm seviyesi ekranda yazmazsa
 * "yaklaşık" bir rakam "kesin" diye okunur — ADP-887'nin şikâyetinin ta kendisi.
 */
const USAGE_KINDS = Object.freeze(['session-ledger', 'time-window', 'cli-report', 'run-envelope', 'none']);
const USAGE_LEVELS = Object.freeze(['exact', 'approx', 'reported', 'none']);
// ENG-14 — ÜÇÜNCÜ BOYUT: defterin İÇERİĞİ. ENG-13 kuralı `kind`e `format`i ekledi
// (goose sqlite → transcript yok). ÖLÇÜM üçüncü bir sapma gösterdi: qwen'in defteri
// JSONL, oturum kimliğiyle KESİN eşleşiyor — ama satırlar MESAJ değil SAYAÇ
// (usage_record.jsonl: models{inputTokens,outputTokens…}, tools{count}). Biçime
// bakan bir kural ona "transcript var" der ve teslim probu var olmayan mesaj
// gövdelerini arardı. Bu yüzden içerik BEYAN edilir, çıkarsanmaz.
//   • 'transcript' — satırlar konuşma/araç OLAYLARIdır (claude/copilot)
//   • 'counters'   — satırlar yalnız SAYAÇtır (qwen): jeton kartına yeter,
//                    teslim doğrulamasına YETMEZ
const USAGE_CONTENTS = Object.freeze(['transcript', 'counters']);

// ─────────────────────────────────────────────────────────────────────────────
// ENG-16 — FATURA KİPİNİN 4. DEĞERİ: `vendor-hosted` (EREN KARARI 2026-08-18)
//
// ÖLÇÜM (ENG-R2 §2.4, ENG-16'da yeniden üretildi): opencode kimlik defteri BOŞken
// ("0 credentials", `~/.local/share/opencode/auth.json` dosyası hiç YOK) yine de
// cevap veriyor — `llm.provider=opencode llm.model=big-pickle`, `"cost":0`. Ne
// kullanıcının anahtarı, ne aboneliği, ne bizim anahtarımız: SATICININ KENDİ
// BEDAVA KAPISI. Üç eski değer bunu SÖYLEYEMEZ ve üçü de YALAN olurdu:
//   • 'api'          → kullanıcının anahtarı kullanılmadı
//   • 'subscription' → kullanıcının aboneliği yok
//   • 'unknown'      → biliyoruz; susmak dürüstlük değil
// Asıl mesele fiyat değil GİZLİLİK: kod ve dosya içerikleri üçüncü tarafın
// sunucusuna gidiyor. Ürün bunu kullanıcıya AÇIKÇA söylemek zorundadır.
//
// KARAR: motor ürüne `vendor-hosted` ROZETİYLE girer (bedava kapı KAPATILMAZ),
// rozet cümlesi pane/hesap kartında görünür. İleride "yalnız kendi anahtarım"
// KİLİDİ eklenecek — bugünkü karşılığı `vendorHosted.policy` ayarıdır
// ('allow' = varsayılan · 'block' = bedava kapı kapalı, sağlayıcı şart).
const BILLING_MODES = Object.freeze(['subscription', 'api', 'vendor-hosted', 'unknown']);
/** Bedava satıcı kapısının ÜRÜN politikası (tek satır config ile değişir). */
const VENDOR_GATE_POLICIES = Object.freeze(['allow', 'block']);
/** Satıcı kapısının NASIL tespit edildiği (tahmin değil ÖLÇÜM kuralı). */
const VENDOR_HOSTED_DETECTORS = Object.freeze(['credentials-file']);

/**
 * ENG-16 — PANE İZOLASYONU: motorun ORTAK yerel deposu eşzamanlı pane'lerde çakışıyorsa
 * pane başına ayrı bir depo verilmesi ZORUNLUDUR ve bu bir BEYAN'dır, sessiz bir yama değil.
 * ÖLÇÜLDÜ (opencode 1.18.18): aynı anda koşan iki `opencode run` ortak sqlite defterinde
 * çarpıştı → biri `Error: Unexpected error / database is locked` ile ÖLDÜ. `OPENCODE_DB`
 * pane başına ayrıldığında İKİSİ de geçti (her biri kendi kimliğiyle).
 */
const ISOLATION_KINDS = Object.freeze(['pane-file', 'pane-dir']);

// ─────────────────────────────────────────────────────────────────────────────
// KAYITLAR — bugünkü 8 defterin AYNASI (her alanın kaynağı `verification`'da).
// ─────────────────────────────────────────────────────────────────────────────

/** @type {Readonly<Record<string, object>>} */
const ENGINE_REGISTRY = Object.freeze({
  claude: Object.freeze({
    id: 'claude',
    label: 'Claude Code', // R1: src/app/lib/engines.ts:25-28 ENGINE_LABELS
    bin: 'claude', // R2: electron/agentRunner.js:106-110 ALLOWED_COMMANDS
    defaultArgs: Object.freeze(['--dangerously-skip-permissions']), // R3: agentRunner.js:116-119

    // ENG-20 — otonomi beyanı (paritenin ÖLÇÜTÜ; diğer motorlar buna göre denetlendi).
    autonomy: Object.freeze({
      level: 'full',
      via: 'argv',
      flags: Object.freeze(['--dangerously-skip-permissions']),
      measured: 'claude TUI pane\'inde "bypass permissions" kipi banner\'da görünür (ENG-07 pty kanıtı, scripts/eng07PtyProof.cjs composerReached ölçümü); ürünün otopilot sözleşmesi bu bayrağın üstüne kurulu',
      why: 'ADR-004: pane gözetimsiz koşar; onay sorusu otopilot akışını keser (Eren kararı, ürünün ilk gününden beri)',
    }),

    // 1. KAPI — kimlik: bayrak (satır-içi) VEYA dosya taşıyıcısı (AD-WIN-01/02).
    identity: Object.freeze({
      kind: 'flag',
      flag: '--append-system-prompt',
      fileFlag: '--append-system-prompt-file', // spawnPromptFile.cjs:40 PROMPT_FILE_FLAG
      position: 'append',
      // Tavan TAŞIYICIYA göre: satır-içi CLI_MAX (8.000), dosya FILE_MAX.
      cap: Object.freeze({ cli: 'CLI_MAX', file: 'FILE_MAX' }),
      // ENG-07 (ENG-R3 §6.2 `resumeReinject`) — RESUME'da davranış kuralı YENİDEN
      // verilebilir mi? Bayrak taşıyıcısı konuşmaya GÖRÜNMEZ, o yüzden ADP-276'nın
      // yazma-disiplini enjeksiyonu claude'da güvenle tekrarlanır. Pozisyonel
      // taşıyıcıda aynı şey KULLANICIYA MESAJ olarak düşerdi (bkz. codex kaydı).
      resumeReinject: true,
      // ENG-17 — kapı `flag` taşıyıcılarına da açıldı (kimi `--agent-file` bir BAYRAK
      // olduğu hâlde gömülü prompt'u SİLİYOR). claude'un bayrağı adında EKLEDİĞİNİ
      // söylüyor (`--append-system-prompt`) ve ürün onunla iki yıldır kimlik +
      // motorun kendi kuralları BİR ARADA koşuyor → ADDITIVE.
      replacesSystemPrompt: false,
    }),

    model: Object.freeze({
      kind: 'flag',
      flag: '--model',
      position: 'append',
      // ENG-09 — MODEL TESPİTİ (electron/modelDetect.cjs:116-139) bildirimsel:
      // `claude config get model` ile AYNI kaynak sırası, süreç spawn'lamadan.
      detect: Object.freeze({
        kind: 'json-settings',
        env: 'ANTHROPIC_MODEL',
        field: 'model',
        files: Object.freeze([
          Object.freeze({ scope: 'cwd', segments: Object.freeze(['.claude', 'settings.local.json']) }),
          Object.freeze({ scope: 'cwd', segments: Object.freeze(['.claude', 'settings.json']) }),
          Object.freeze({ scope: 'home', segments: Object.freeze(['.claude', 'settings.json']) }),
        ]),
      }),
      // K2 canlı teyit (pty çıktısı) — desen ailesi BEYAN EDİLİR; beyan etmeyen
      // motorda sniffer HİÇ koşmaz (bilinmeyen motorun banner'ı claude sanılmaz).
      sniff: 'claude-gpt',
      // AGENT-MODEL-01 — "HANGİ modeller" listesinin adresi. `provider.grammar`ın
      // aynı deseni: gramer burada, LİSTE kendi modülünde. Liste buraya KOPYALANMAZ.
      // claude'da kaynak STATİK ALIAS'tır — ölçüldü (2.1.270 `--help`): model
      // LİSTELEYEN bir alt-komut YOK, `--model` yardımı yalnız alias ÖRNEĞİ veriyor.
      catalog: 'electron/modelCatalog.cjs',
    }),

    // CDX-F1 — claude'un efor kolu GERÇEKTEN VAR (ölçüldü, claude 2.1.246 `--help`):
    //   `--effort <level>   Effort level for the current session (low, medium, high, xhigh, max)`
    // 🪤 BEYAN ≠ POLİTİKA: taşıyıcının VAR olduğunu yazmak, ürünün onu ÇEKTİĞİ anlamına
    // GELMEZ. CDX-F1'de politika merdiveni yalnız codex'e açıldı (modelPolicy
    // `EFFORT_POLICY_ENGINES`), yani claude argv'si bu görevde BİT-BİT aynı kalır.
    // Burada `null` yazmak ÖLÇÜMLE ÇELİŞİRDİ (bayrak var) — kaydın işi gerçeği söylemek,
    // ürün kararını taşımak değil.
    effort: Object.freeze({
      kind: 'flag',
      flag: '--effort',
      values: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
      position: 'append',
    }),

    // Görsel: claude'da CLI bayrağı YOK → çağıran metne gömer (composePromptWithImages).
    images: null,

    // Sağlayıcı (Groq/DeepSeek/Kimi) override'ı yalnız codex'te var.
    provider: null,

    session: Object.freeze({
      mint: 'uuid', // ADP-087: oturum kimliğini BİZ basarız → jeton/resume kesinleşir
      flag: '--session-id',
      killSwitchEnv: 'CREWPANE_DISABLE_SESSION_ID',
      resume: Object.freeze({
        form: 'append', // `<argv…> --resume <uuid>`
        flag: '--resume',
        idShape: 'uuid',
        lastFallback: null, // claude'da "sonuncu" dengi kullanılmıyor
      }),
    }),

    subagentBlock: Object.freeze({
      args: Object.freeze(['--disallowedTools', 'Task']),
      position: 'append',
      dedupeToken: '--disallowedTools', // lider yolu zaten eklediyse tekrar EKLENMEZ
    }),

    // TOKEN-BUDGET-01 — BAĞLAM KAPSAMI. Motorun KENDİ enjekte ettiği iki belge
    // (proje talimatı zinciri + kalıcı hafıza indeksi) ÇALIŞMA ALANI SINIRI
    // TANIMAZ: keşif cwd'den `/`'a kadar yürür ve indeks TAM BOY gider.
    //
    // ÖLÇÜLDÜ (bu makine, claude 2.1.265, gerçek worker pane'i, haiku kolu):
    //   proje talimatı zinciri            6.824 jeton  (bunun 4.892'si ÇALIŞMA
    //                                     ALANININ ÜSTÜNDEKİ alakasız bir
    //                                     CLAUDE.md — e-ticaret ajan şeması)
    //   kalıcı hafıza indeksi (403 kayıt) 7.227 jeton  (seçilmeden, tamamı)
    // Toplam 14.051 jeton = o pane'in HER isteğinin %34'ü.
    //
    // 🪤 `disableEnv` İKİSİNİ BİRDEN düşürür (ölçüldü: tek tek −10.185 ve −14.051,
    //    birlikte −17.009 ⇒ 7.227'lik örtüşme). Bu yüzden onu kuran taraf İKİ
    //    belgeyi de yerine koymak zorundadır — bkz. paneContextScope.cjs'in
    //    HEPSİ-YA-HİÇ kuralı. Yalnız birini koyup env'i set etmek, ajanın hafıza
    //    indeksini SESSİZCE yok eder.
    contextScope: Object.freeze({
      disableEnv: Object.freeze({ CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' }),
      // Keşfedilen proje talimatı dosyasının adı (cwd'den yukarı yürünür).
      projectDocName: 'CLAUDE.md',
      // `@yol` içe aktarımları: motor bunları çözer, biz de bir kademe çözeriz —
      // yoksa yeniden enjekte edilen metin `@AGENTS.md` satırını ÇÖZÜLMEMİŞ taşır.
      importPrefix: '@',
      // Kalıcı hafıza indeksinin yeri: <home>/.claude/projects/<cwd-slug>/memory/MEMORY.md
      // 🪤 slug'da YALNIZ '/' değil, ALFANÜMERİK OLMAYAN HER karakter tireye döner
      //    ("CrewPane Apps" → "CrewPane-Apps"); yalnız slash çeviren bir slug dizini
      //    BULAMAZ ve kalem sessizce sıfır görünür (ilk ölçümde tam olarak bu oldu).
      memoryIndex: Object.freeze({
        scope: 'home',
        segments: Object.freeze(['.claude', 'projects', '<cwd-slug>', 'memory', 'MEMORY.md']),
        slug: 'non-alnum-dash',
      }),
    }),

    trust: Object.freeze({
      kind: 'json',
      file: '~/.claude.json',
      pointer: 'projects[<cwd>].hasTrustDialogAccepted',
      write: 'merge', // claudeTrustPatch — üzerine yazmaz, birleştirir
      canonicalizeCwd: true, // ADP-283: /var/… → /private/var/…
      // ENG-07 L2 — güven dosyası KULLANICI ev dizininde: hesap profilinden (ADP-936)
      // BAĞIMSIZ. Yani yazımı buildSpawn'ın env çözümüne bağlı değildir; çağıran
      // (main) pty'yi doğurmadan hemen önce yazar. Bkz. `homeScope:'engine-home'`.
      homeScope: 'user-home',
      homeEnv: null,
    }),

    reset: '/clear', // electron/main.js:9798-9802 resetCommandFor

    tui: Object.freeze({
      // Regex'lerin KENDİSİ renderer'da tek kaynakta yaşar; burada yalnız "ölçüldü mü"
      // beyanı var (ENG-R3 §14-R5: kopya regex = ikinci gerçek = sapma).
      signalsModule: 'src/app/lib/paneReadiness.ts',
      composerHints: true,
      blockers: Object.freeze(['picker', 'trust']),
      measuredVersion: 'claude 2.1.220 (ADP-705 canlı pty kaydı)',
    }),

    // 2. KAPI — araç bağlama: JSON config dosyası + strict kapısı.
    mcp: Object.freeze({
      kind: 'config-file',
      flag: '--mcp-config',
      strictFlag: '--strict-mcp-config',
      envInheritance: true, // MCP çocukları pane env'ini MİRAS ALIR (sır argv'ye yazılmaz)
      position: 'append',
    }),

    hooks: Object.freeze({
      userPromptSubmit: Object.freeze({ flag: '--settings', additive: true }), // ADP-692 kanal A
      // KILL-GUARD-01 — araç-ÖNCESİ kapı. AYNI `--settings` dosyasına yazılır
      // (claude yalnız BİR settings dosyası alır); `matcher: 'Bash'` ile yalnız
      // kabuk yüzeyinin önünde durur. Bu yeteneği OLMAYAN motorlarda kapı
      // PATH sarmalayıcısına (killGuardShim) düşer — kayıp `unsupported`ta beyanlı.
      preToolUse: Object.freeze({ flag: '--settings', additive: true, matcherKey: 'matcher' }),
    }),

    extraRoots: Object.freeze({ flag: '--add-dir', repeat: 'variadic' }), // ADP-237 hafıza dizinleri

    skillsDir: Object.freeze({ scope: 'workspace', segments: Object.freeze(['.claude', 'skills']) }),

    identityEnv: 'CLAUDE_SECURESTORAGE_CONFIG_DIR', // R5: engineProfiles.cjs:60-63

    auth: Object.freeze({
      // R4: engineAuth.cjs:54-75 + statusArgv (engineAuth.cjs:230)
      label: 'Claude Code',
      accountHint: 'Claude Pro veya Max aboneliğin',
      signupUrl: 'https://claude.com/pricing',
      // ENG-08 — 4. KAPI: akış ŞEKLİ. `needsCode` artık bunun AYNASIDIR (şema testi
      // eşitliği zorlar) — iki alan ayrışırsa UI kod kutusunu yanlış yerde çizer.
      flow: 'oauth-code', // tarayıcı dönüşünde CLI stdin'den kod bekler (ADP-597 §4)
      needsCode: true,
      statusArgv: Object.freeze(['auth', 'status', '--json']),
      statusParse: 'json', // `--json` daima bir JSON nesnesi basar (engineAuth.parseJsonStatus)
      loginArgv: Object.freeze(['auth', 'login']),
      logoutArgv: Object.freeze(['auth', 'logout']),
      // ENG-08 — API anahtarı YEDEĞİ (ENG-UX-T9, 2026-08-19).
      // `ANTHROPIC_API_KEY` CLI tarafında çalışır; Ayarlar'dan AÇILIYOR.
      // Fatura uyarısı: abonelik yolu varken anahtar kutusu açılırsa fatura
      // kaynağı değişir (veri-engine-key-billing, T5'te UI çizildi).
      apiKey: Object.freeze({
        env: 'ANTHROPIC_API_KEY', // env ile gider — ARGV'ye ASLA
        vaultService: 'crewpane-claude-api-key',
        keyUrl: 'https://console.anthropic.com/account/keys',
        keyLabel: 'Anthropic API anahtarı',
        note:
          'Abonelik BİRİNCİL yoldur (`auth login`); jeton YEDEKtir. Eren kararı (2026-08-18): abonelik yolu VARKEN anahtar kutusu açılırsa, fatura kaynağı kullanıcının API hesabına düşer — rozet ve ürün bunu "fatura uyarısı" ile kullanıcıya söyler (data-engine-key-billing).',
      }),
    }),

    usage: Object.freeze({
      // electron/tokenUsage.cjs:5-12
      // ENG-09 — 4. KAPI: oturum kimliğini BİZ bastığımız için defter KESİN bilinir.
      kind: 'session-ledger',
      level: 'exact',
      reader: 'claude-jsonl', // tokenUsage.LEDGER_READERS anahtarı (satır ayrıştırıcı)
      format: 'jsonl', // ENG-13 — defterin DOSYA BİÇİMİ (teslim doğrulaması bunu okur)
      content: 'transcript', // ENG-14 — satırlar KONUŞMA/ARAÇ olayları (teslim buradan doğrulanır)
      root: '~/.claude/projects/<munged-cwd>',
      rootEnv: 'CREWPANE_CLAUDE_HOME',
      file: '<sessionId>.jsonl',
      sessionKey: 'minted-uuid', // withSessionId bastığı için oturum dosyası KESİN bilinir
      accumulation: 'per-line',
      dedupeBy: 'requestId', // 🪤 tekilleştirilmezse maliyet katlanarak yanlış çıkar
      cost: 'usd',
      // ENG-09 — FATURA KİPİ kaynağı da bildirimsel: motor adına göre `if` YOK.
      // Bilinmeyen/okunamayan kaynak → `unknown` (dolar UYDURULMAZ, tokenUsage.cjs).
      billing: Object.freeze({
        apiKeyEnv: 'ANTHROPIC_API_KEY', // ortamda varsa faturayı O öder (CLI'nin çözüm sırası)
        configFile: '~/.claude.json',
        field: 'oauthAccount.billingType',
        planField: 'oauthAccount.organizationType',
        subscriptionWhen: 'contains:subscription',
        sourceLabel: '~/.claude.json oauthAccount.billingType',
        overrideOpt: 'claudeConfig', // test/çağıran yolu ezebilsin (tokenUsage opts)
      }),
    }),

    // 3. KAPI — süpervizör okuma (headless).
    output: Object.freeze({
      kind: 'json',
      flag: '--output-format',
      values: Object.freeze(['json', 'stream-json']),
    }),

    install: Object.freeze({
      // R7: engineInstall.cjs:94-101 · checkHint R6: engineCheck.cjs:36-39
      label: 'Claude Code',
      command: 'curl -fsSL https://claude.ai/install.sh | bash',
      win32Command: 'powershell -ExecutionPolicy ByPass -c "irm https://claude.ai/install.ps1 | iex"',
      docsUrl: 'https://docs.claude.com/en/docs/claude-code/setup',
      checkHint: 'https://docs.claude.com/claude-code',
      // ENG-08 (ENG-R2 §5.7 TEDARİK ZİNCİRİ KAPISI) — kurulumdan sonra ikiliyi
      // KOŞTURUP kimliğini doğrula. Paket adına güvenmek yeterli değil: `npm i -g
      // kimi-code` Moonshot'ın CLI'ı DEĞİL, Groq'a proxy açan üçüncü-taraf sarmalayıcı.
      // Kalıp dize olarak tutulur (RegExp donmuş kayıtta taşınmaz); engineInstall derler.
      verifyArgv: Object.freeze(['--version']),
      verifyPattern: 'claude\\s*code', // ÖLÇÜLDÜ 2026-08-17: "2.1.233 (Claude Code)"
      // WIN-FIRSTRUN-01 (K1) — WINDOWS KABUK KAPISI BEYANI. claude 2.1.276 ikilisi
      // Windows'ta açılışta Git Bash (CLAUDE_CODE_GIT_BASH_PATH → C:\Program Files\Git
      // → (x86) → PATH'teki git) YA DA PowerShell (pwsh → bilinen yollar → powershell
      // → System32 5.1) bulamazsa tek satır hata basıp `process.exit(1)` yapar
      // (`strings`, RESEARCH-WIN-01 §4.5 H1 + platform/winShellPrereq.cjs başlığı).
      // Ürün spawn'dan ÖNCE aynı aramayı yapar; bulamazsa motoru başlatmaz, rehber
      // pane açar. Kapı bu BEYANA bakar, motor ADINA değil (beyansız motor = kapı yok).
      win32Shell: Object.freeze({
        kind: 'claude-shell-gate',
        docsUrl: 'https://git-scm.com/downloads/win',
        measured: 'claude 2.1.276 ikilisi: init → !gitBash && findPowerShell()===null → console.error + exit(1) (2026-09-18)',
      }),
    }),

    /** `null` yetenekler — GEREKÇE ZORUNLU (şema testi zorlar). */
    unsupported: Object.freeze({
      images:
        'claude CLI görsel bayrağı almaz; çağıran görselleri prompt METNİNE gömer (composePromptWithImages) — ENG-IMG-01 ölçümü',
      provider:
        'özel sağlayıcı (Groq/DeepSeek/Kimi) seçimi codex `-c model_provider` grameriyle yapılır; claude tarafında dengi YOK (agentRunner.js:392-397)',
    }),

    /** Yarım yetenekler — VAR ama sınırlı; rozet bunu "eksik" değil "kısmi" gösterir. */
    partial: Object.freeze({}),

    verification: Object.freeze({
      contextScope: Object.freeze({ channel: 'measured', source: "TOKEN-BUDGET-01 — CLAUDE_CODE_DISABLE_CLAUDE_MDS ile ölçüldü: proje talimatı zinciri 6.824 + hafıza indeksi 7.227 jeton düşer; kesim sonrası gerçek pane 38.622 → 27.214 (docs/agent-results/TOKEN-BUDGET-01-prowl.md)" }),
      identity: Object.freeze({ channel: 'source', source: 'electron/agentRunner.js:435-462' }),
      model: Object.freeze({ channel: 'source', source: 'electron/agentRunner.js:372-377' }),
      effort: Object.freeze({ channel: 'measured', source: 'CDX-F1 ölçümü — `claude --help` (2.1.246): "--effort <level>  Effort level for the current session (low, medium, high, xhigh, max)"' }),
      images: Object.freeze({ channel: 'source', source: 'electron/agentRunner.js:405-417' }),
      provider: Object.freeze({ channel: 'source', source: 'electron/agentRunner.js:392-398' }),
      session: Object.freeze({ channel: 'measured', source: 'ADP-087 POC (claude >=2.1.183) + agentRunner.js:1673-1680' }),
      subagentBlock: Object.freeze({ channel: 'source', source: 'electron/agentRunner.js:1614-1626' }),
      trust: Object.freeze({ channel: 'measured', source: 'ADP-048/283 probe + agentRunner.js:178-226' }),
      reset: Object.freeze({ channel: 'source', source: 'electron/main.js:9798-9802' }),
      tui: Object.freeze({ channel: 'measured', source: 'ADP-705 canlı pty + src/app/lib/paneReadiness.ts:41-57' }),
      mcp: Object.freeze({ channel: 'source', source: 'electron/agentRunner.js:1051-1053,1191-1193' }),
      hooks: Object.freeze({ channel: 'source', source: 'electron/agentRunner.js:1339-1424' }),
      extraRoots: Object.freeze({ channel: 'source', source: 'electron/agentRunner.js:803-826' }),
      skillsDir: Object.freeze({ channel: 'source', source: 'electron/skillEngineView.cjs:46-53' }),
      identityEnv: Object.freeze({ channel: 'source', source: 'electron/engineProfiles.cjs:60-63' }),
      auth: Object.freeze({ channel: 'source', source: 'electron/engineAuth.cjs:54-75,230' }),
      usage: Object.freeze({ channel: 'measured', source: 'ADP-887 defter ölçümü + electron/tokenUsage.cjs:5-12' }),
      output: Object.freeze({ channel: 'measured', source: 'ENG-R2-inferno.md §2.2 (claude 2.1.233 gerçek koşu)' }),
      install: Object.freeze({ channel: 'source', source: 'electron/engineInstall.cjs:94-101' }),
    }),
  }),

  codex: Object.freeze({
    id: 'codex',
    label: 'Codex', // R1: src/app/lib/engines.ts:25-28 (kurulum katalogunda etiket 'Codex CLI')
    bin: 'codex', // R2: electron/agentRunner.js:106-110
    // ─── ENG-20 — TAM-OTOMATİK ONAY (Eren kararı 2026-08-18) ────────────────
    // 🔴 DENETİM SONUCU: Eren "codex'te bu özellik yok sanırım" dedi — ÖLÇÜM onu
    // DOĞRULADI, ama sebep "motorda bayrak yok" DEĞİL, "bizim argv'mizde bayrak
    // yoktu"du. ENG-20 öncesi codex defaultArgs BOŞTU ve motor KENDİ varsayılanına
    // düşüyordu. Bu varsayılan motorun KENDİ ağzından ölçüldü
    // (`codex debug prompt-input`, jeton harcamayan resmi döküm ucu):
    //   "`sandbox_mode` is `workspace-write`: … Editing files in other directories
    //    requires approval. Network access is restricted." + koca bir
    //   "# Escalation Requests" bölümü (model KULLANICIYA onay sorusu sorar).
    // → codex pane'i tam-otomatik DEĞİLDİ: cwd dışına yazım, ağ ve tırmanma
    //   gerektiren her komut otopilotu ONAY SORUSUYLA kesiyordu.
    // ÇÖZÜM = claude'un `--dangerously-skip-permissions` DENGİ tek bayrak
    // (`codex --help` 0.147.0: "Skip all confirmation prompts and execute commands
    // without sandboxing"). Aynı ucun bayrak-denkleri (`-c approval_policy="never"
    // -c sandbox_mode="danger-full-access"`) ile ölçülen SONUÇ metni:
    //   "`sandbox_mode` is `danger-full-access`: No filesystem sandboxing …
    //    Approval policy is currently never."
    // 🪤 NEDEN İKİ AYRI BAYRAK (`-a never -s danger-full-access`) DEĞİL: ikisi de
    // argv'yi geçiyor (ölçüldü) ama iki bayrak İKİ ayrı kapı demek — biri elden
    // kayarsa pane SESSİZCE yarı-otomatiğe düşer. Tek bayrak, adında ne yaptığını
    // söylüyor (rozet/log dürüstlüğü) ve claude satırıyla BİREBİR aynı sınıf.
    // Güvenlik: bu bayrak KUM HAVUZUNU DA kapatır (claude satırında da öyle) —
    // karar Eren'indir (otopilotta onay sorusu akışı kırıyor), ürün varsayılanı.
    defaultArgs: Object.freeze(['--dangerously-bypass-approvals-and-sandbox']), // R3: agentRunner.js:116-119

    autonomy: Object.freeze({
      level: 'full',
      via: 'argv',
      flags: Object.freeze(['--dangerously-bypass-approvals-and-sandbox']),
      measured: 'ENG-20 (codex-cli 0.147.0): bayraksız `codex debug prompt-input` → "`sandbox_mode` is `workspace-write` … requires approval" + "# Escalation Requests"; bayrak denkleriyle (`-c approval_policy="never" -c sandbox_mode="danger-full-access"`) → "No filesystem sandboxing … Approval policy is currently never". Bayrağın argv\'yi geçtiği ayrıca ölçüldü (`codex --dangerously-bypass-approvals-and-sandbox completion bash` exit 0; kontrol: bilinmeyen bayrak exit 2)',
      why: 'Eren kararı 2026-08-18 — claude paritesi. ENG-20 öncesi codex pane\'i YARI-otomatikti (cwd dışı yazım/ağ/tırmanma onay soruyordu) ve bu ürün içinde HİÇBİR yerde beyan edilmiyordu',
    }),

    // 1. KAPI — kimlik: sistem-prompt bayrağı YOK → ilk POZİSYONEL prompt.
    // ⚠️ Sıralama kısıtı: kimlik argv'nin SON elemanı olmak zorunda; bu yüzden tüm
    // `-c` override'ları ve `-i` bayrakları PREPEND edilir.
    identity: Object.freeze({
      kind: 'positional',
      flag: null,
      fileFlag: null,
      position: 'last',
      cap: Object.freeze({ cli: 'CLI_MAX', file: null }), // dosya taşıyıcısı yok → 8.000 duvarı
      // ENG-07 — RESUME'da yeniden enjeksiyon YOK: `codex resume`'a verilen pozisyonel
      // metin konuşmaya GÖRÜNÜR BİR MESAJ olarak düşer (agentRunner.resumeMemoryPrompt
      // gerekçesi) → boşluktan kötüdür. Bu bir kayıptır ve `partial.identity`de beyanlı.
      resumeReinject: false,
    }),

    model: Object.freeze({
      kind: 'flag',
      flag: '--model',
      position: 'append',
      // ENG-09 — modelDetect.cjs:130-138: yalnız İLK [section]'dan ÖNCEKİ top-level
      // `model = "…"` okunur (alt bölümdeki profil modelleri aktif model DEĞİLDİR).
      detect: Object.freeze({
        kind: 'toml-config',
        env: null,
        field: 'model',
        homeEnv: 'CODEX_HOME',
        homeFallback: Object.freeze(['.codex']),
        file: 'config.toml',
      }),
      sniff: 'claude-gpt',
      // AGENT-MODEL-01 — codex'te liste ELLE YAZILMAZ: CLI'ın KENDİSİ kataloğu
      // diske yazıyor (`~/.codex/models_cache.json` — ölçüldü 0.154.0: slug /
      // display_name / description / visibility / supported_reasoning_levels).
      // Modül o dosyayı okur; registry yalnız adresi beyan eder.
      catalog: 'electron/modelCatalog.cjs',
    }),

    // CDX-F1 (H1) — KALİTE KOLU. ÖLÇÜLDÜ (codex-cli 0.147.0, gerçek ikili):
    //   bayraksız      → başlıkta `reasoning effort: low`   (kullanıcının config.toml'u)
    //   `-c model_reasoning_effort="high"` → `reasoning effort: high`
    // 🪤 KULLANICININ CONFIG'İ ASLA YENİDEN YAZILMAZ: bu bir PER-LAUNCH override'dır
    // (ADP-580 sağlayıcı grameriyle aynı `-c` kanalı), yani bare `codex` kullanımı
    // etkilenmez. `position:'prepend'` ZORUNLU — codex'in pozisyonel kimlik prompt'u
    // argv'nin SON elemanı kalmalı (identity.position:'last').
    // 🪤 WHITELIST NEDEN ŞART (ölçüldü): codex değeri DOĞRULAMAZ, olduğu gibi başlığa
    // basar ve isteği yollar → `minimal`/`bogus` API'den ERROR ile döner, yani kusurlu
    // bir değer pane'i ÖLDÜRÜR. `none`/`xhigh` da geçti ama politika merdiveninde yok;
    // ürünün beyan ettiği küme bilerek DAR tutuldu.
    // AGENT-MODEL-01 — KÜME GENİŞLETİLDİ (ölçüldü, codex-cli 0.154.0 GERÇEK koşu):
    //   codex exec -c model_reasoning_effort="ultra" -m gpt-5.3-codex-spark "…"
    //   → başlık `reasoning effort: ultra`, tur TAMAMLANDI (10.085 jeton).
    // CDX-F1'de küme BİLEREK dardı çünkü tek tüketici POLİTİKA MERDİVENİYDİ
    // (üç sınıf → üç değer). Artık kullanıcı ajan başına AÇIKÇA seçiyor, yani
    // taşıyıcının beyanı motorun gerçek kabul kümesi olmak ZORUNDA: dar bırakmak
    // kullanıcının seçtiği `xhigh`i sanitizeEffort'ta SESSİZCE düşürürdü.
    //
    // 🪤 BEYAZ LİSTE HÂLÂ ŞART (CDX-F1 ölçümü geçerli): codex değeri DOĞRULAMAZ,
    // başlığa basıp isteği yollar → `minimal`/`bogus` turu API ERROR'u ile ÖLDÜRÜR.
    // 🪤 MODEL BAŞINA KISIT BURADA DEĞİL: ölçüldü ki codex `ultra`yı kataloğunda
    // `ultra` YAZMAYAN bir modelde (gpt-5.3-codex-spark) de kabul ediyor — yani
    // motor per-model doğrulama YAPMIYOR. O kesişim modelCatalog.effortChoices'ta
    // yapılır (katalog `supported_reasoning_levels` ∩ bu küme) ki UI uygulanmayacak
    // bir seçenek sunmasın.
    effort: Object.freeze({
      kind: 'cli-override',
      flag: '-c',
      key: 'model_reasoning_effort',
      values: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
      position: 'prepend',
    }),

    images: Object.freeze({
      kind: 'flag',
      flag: '-i',
      aliases: Object.freeze(['--image']), // aynı bayrağın uzun yazımı (argv taramasında sayılır)
      repeat: 'per-item', // her görsel AYRI bayrak (`-i a -i b`), variadic tek bayrak DEĞİL
      position: 'prepend',
      // 🪤 ENG-03 ÖLÇÜMÜ (codex-cli 0.147): `-i` VARIADIC'tir → kendisinden sonraki TÜM
      // konumsal sözcükleri yutar; kimlik prompt'u ikinci bir görsel yolu sanılır ve hiç
      // ulaşmaz. Liste bu yüzden `--` ile KAPATILIR (agentRunner.terminateImageList).
      variadic: true,
      terminator: '--',
    }),

    provider: Object.freeze({
      kind: 'cli-overrides',
      flag: '-c',
      keyPrefix: 'model_provider',
      position: 'prepend',
      grammar: 'electron/providers.cjs', // base_url/env_key/wire_api tek kaynağı
    }),

    session: Object.freeze({
      mint: null, // codex'te oturum kimliği basılamaz (doğrulanmış denk bayrak YOK)
      flag: null,
      killSwitchEnv: null,
      resume: Object.freeze({
        form: 'subcommand', // `resume <id> <argv…>` — argv'nin BAŞINA
        subcommand: 'resume',
        idShape: 'sanitized-token', // [^A-Za-z0-9_-] temizlenir
        lastFallback: Object.freeze(['resume', '--last']),
      }),
    }),

    // TOKEN-BUDGET-01 — BAĞLAM KAPSAMI: bu motorun kendi belge enjeksiyonunu
    // (proje talimatı zinciri + kalıcı hafıza indeksi) ÇALIŞMA ALANIYLA sınırlayan
    // bir taşıyıcı ÖLÇÜLMEDİ. `null` = bugünkü davranış aynen sürer; kesim yalnız
    // beyan eden motorda uygulanır (paneContextScope HEPSİ-YA-HİÇ kuralı).
    contextScope: null,
    subagentBlock: Object.freeze({
      args: Object.freeze(['--disable', 'multi_agent']), // CODEX_SUBAGENT_BLOCK_ARGS
      position: 'prepend',
      dedupeToken: 'multi_agent',
    }),

    trust: Object.freeze({
      kind: 'toml-append',
      file: '$CODEX_HOME/config.toml',
      pointer: '[projects."<cwd>"] trust_level = "trusted"',
      write: 'append-only', // kullanıcının config'i ASLA yeniden yazılmaz/sıralanmaz
      canonicalizeCwd: true,
      // ENG-07 L2 — güven dosyası MOTORUN EV DİZİNİNDE ($CODEX_HOME): hesap profili
      // (ADP-936) bu değişkeni EZER, yani yazımın hangi dizine düştüğü spawn env'inin
      // çözülmesinden SONRA bilinir → buildSpawn içinde uygulanmak ZORUNDA (profil
      // kendi CODEX_HOME'una yazılmalı, kanonik ~/.codex'e değil).
      homeScope: 'engine-home',
      homeEnv: 'CODEX_HOME',
      // 🪤 ÖLÇÜLDÜ (codex 0.144): per-launch `-c projects…trust_level` diyaloğu KAPATMAZ —
      // güven kapısı `-c` katmanından ÖNCE değerlendiriliyor → kalıcı yazmak ZORUNLU.
    }),

    reset: '/new', // electron/main.js:9798-9802

    // TUI hazır-sinyali ÖLÇÜLMEDİ: paneReadiness dizeleri claude TUI'sine ait.
    tui: null,

    // 2. KAPI — araç bağlama: OTURUM PROFİLİ DOSYASI (`-p <ad>` → `$CODEX_HOME/<ad>.config.toml`).
    //
    // CODEX-ARGV-01 — ÖNCESİ `kind:'cli-overrides'` idi: her sunucu `-c mcp_servers.<ad>.
    // env={…}` ile ARGV'den kaydediliyordu. ÖLÇÜLDÜ: 3 sunucu × ~1.315 karakterlik env
    // tablosu = 4.508 karakter, komut satırının %56,3'ü → Windows'un 8.191 duvarında
    // müşteri pane'i "too long" ile ÖLÜYORDU. Tablo artık dosyaya yazılır (codexMcpProfile.cjs),
    // argv'ye yalnız `-p crewpane-<özet>` girer (≈30 karakter).
    //
    // ÖLÇÜLDÜ (codex-cli 0.147.0, gerçek ikili): katmanlama ADDITIVE — profil sunucuları
    // VE kullanıcının kendi `mcp_servers` kayıtları birlikte görünür (`codex -p <ad> mcp list`),
    // yani bugünkü `-c` semantiği bit-bit korunur. Bonus: codex bu yoldan gelen env
    // değerlerini maskeler; `-c` yolu ise köprü jetonunu `ps` çıktısına açık yazıyordu.
    //
    // 🪤 `minVersion` GERÇEK BİR KAPI: `-p` ESKİ codex'te de var ama config.toml içindeki
    // `[profiles.<ad>]` tablosunu arar ve BULAMAZSA ÖLÜR (ölçüldü, 0.133.0:
    // "Error: config profile '…' not found"). 0.134.0'dan itibaren dosya katmanı.
    // Eşiğin ALTINDA (ya da sürüm ölçülemediğinde) `fallback` devreye girer ve davranış
    // bugünküyle BİT-BİT aynı kalır.
    mcp: Object.freeze({
      kind: 'config-profile',
      flag: '-p',
      filePrefix: 'crewpane-',
      fileSuffix: '.config.toml',
      homeScope: 'engine-home', // dosya MOTORUN ev dizininde ($CODEX_HOME) — trust ile aynı kural
      homeEnv: 'CODEX_HOME',
      keyPrefix: 'mcp_servers',
      strictFlag: null, // `--strict-mcp-config` dengi YOK → kayıt ADDITIVE
      envInheritance: false, // 🪤 codex MCP çocukları pane env'ini ALMAZ → env profil dosyasında verilir
      position: 'prepend', // pozisyonel kimlik SON kalmalı
      minVersion: '0.134.0', // ÖLÇÜLDÜ: 0.133.0 legacy profil (ölür) / 0.134.0 dosya katmanı
      fallback: Object.freeze({
        kind: 'cli-overrides',
        flag: '-c',
        keyPrefix: 'mcp_servers',
        strictFlag: null,
        envInheritance: false,
        position: 'prepend',
      }),
    }),

    hooks: null,

    extraRoots: null,

    skillsDir: Object.freeze({
      scope: 'engine-home',
      homeEnv: 'CODEX_HOME',
      homeFallback: '~/.codex',
      segments: Object.freeze(['skills']),
      // 🪤 ENG-R3 §14-R7: OpenAI dokümanı `.agents/skills` diyor, İKİLİ `.codex/skills`
      // kullanıyor. Ölçüm kazanır (skillEngineView.cjs:9-12).
    }),

    identityEnv: 'CODEX_HOME', // R5: engineProfiles.cjs:60-63

    auth: Object.freeze({
      label: 'Codex',
      accountHint: 'ChatGPT Plus veya Pro aboneliğin',
      signupUrl: 'https://openai.com/chatgpt/pricing',
      // ENG-08 — localhost:1455 callback sunucusu; tarayıcı dönüşü CLI'a KENDİ ulaşır
      // → kod adımı YOK (ADP-597 §4 ölçümü).
      flow: 'oauth-callback',
      needsCode: false,
      statusArgv: Object.freeze(['login', 'status']),
      // Metin + ÇIKIŞ KODU: exit 1 + "Not logged in" bir CEVAPTIR, hata değil
      // (engineAuth.parseTextStatus + statusUnmeasured'ın kalbi — ADP-893).
      statusParse: 'text',
      loginArgv: Object.freeze(['login']),
      logoutArgv: Object.freeze(['logout']),
      apiKey: Object.freeze({
        env: 'OPENAI_API_KEY', // env ile gider — ARGV'ye ASLA
        vaultService: 'crewpane-codex-api-key',
        keyUrl: 'https://platform.openai.com/account/api-keys',
        keyLabel: 'OpenAI API anahtarı',
        note:
          'Abonelik BİRİNCİL yoldur (`login`); jeton YEDEKtir. Eren kararı (2026-08-18): abonelik yolu VARKEN anahtar kutusu açılırsa, fatura kaynağı kullanıcının API hesabına düşer — rozet ve ürün bunu "fatura uyarısı" ile kullanıcıya söyler (data-engine-key-billing). BYOK yolu providers.cjs/`-c model_provider` grameriyle paralel yaşıyor.',
      }),
    }),

    usage: Object.freeze({
      // electron/tokenUsage.cjs:13-19
      // ENG-09 — 4. KAPI: oturum kimliği YOK → eşleme cwd + pane açılış zamanı
      // penceresiyle yapılır; bu yüzden seviye 'approx' ve kart bunu YAZAR.
      kind: 'time-window',
      level: 'approx',
      content: 'transcript', // ENG-14 — rollout satırları KONUŞMA olayları (ENG-02 teslim probu bunları okur)
      reader: 'codex-rollout',
      format: 'jsonl',
      root: '~/.codex/sessions/YYYY/MM/DD',
      rootEnv: null,
      file: 'rollout-*.jsonl',
      sessionKey: 'cwd-heuristic', // pane-başına oturum kimliği yok → cwd + açılış zamanı (best-effort)
      accumulation: 'cumulative-last-wins', // 🪤 satırlar TOPLANMAZ, SONUNCUSU alınır
      dedupeBy: null,
      cost: 'tokens-only', // USD yok (ENG-R2 §3 sütun 7)
      billing: Object.freeze({
        apiKeyEnv: 'OPENAI_API_KEY',
        configFile: '$CODEX_HOME/auth.json',
        field: 'auth_mode',
        planField: null, // codex auth.json planı söylemez; plan defterden (rate_limits) gelir
        subscriptionWhen: 'equals:chatgpt',
        sourceLabel: '~/.codex/auth.json auth_mode',
        overrideOpt: 'codexAuth',
      }),
    }),

    // 3. KAPI — süpervizör okuma.
    output: Object.freeze({
      kind: 'jsonl',
      flag: '--json',
      values: Object.freeze(['jsonl']),
    }),

    install: Object.freeze({
      // R7: engineInstall.cjs:102-108 · checkHint R6: engineCheck.cjs:36-39
      label: 'Codex CLI',
      command: 'npm install -g --prefix ~/.local @openai/codex',
      win32Command: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
      docsUrl: 'https://developers.openai.com/codex/cli',
      checkHint: 'https://developers.openai.com/codex/cli',
      verifyArgv: Object.freeze(['--version']),
      verifyPattern: 'codex', // ÖLÇÜLDÜ 2026-08-17: "codex-cli 0.147.0"
    }),

    unsupported: Object.freeze({
      contextScope:
        'bu motorun kendi belge enjeksiyonunu (proje talimatı zinciri + kalıcı hafıza indeksi) çalışma alanıyla sınırlayan bir taşıyıcı ÖLÇÜLMEDİ — kesim yalnız beyan eden motorda koşar, burada bugünkü davranış aynen sürer (TOKEN-BUDGET-01)',
      tui:
        'codex TUI hazır/blocker dizeleri ÖLÇÜLMEDİ; paneReadiness kalıpları claude TUI metnine ait → çağıran sabit boot bütçesiyle devam eder (engineReadyRunner.ts:41-61)',
      hooks:
        'codex\'te hook yüzeyi YOK → tur-başı brifing (ADP-692 kanal A) kurulamaz; supervisor sertleştirilmiş enjeksiyon kanalını kullanır (agentRunner.js:1344). KILL-GUARD-01: araç-öncesi kapı da kurulamaz → codex pane\'i YALNIZ PATH sarmalayıcısıyla (killGuardShim.cjs, `<instanceHome>/bin/{killall,pkill}`) korunur; sarmalayıcı `/bin/kill` gibi doğrudan çağrılarla aşılabilir (kaza duvarı, güvenlik duvarı değil)',
      extraRoots:
        '🪤 ÖLÇÜLDÜ (codex-cli 0.147.0, 2026-08-18): `--add-dir <DIR>` codex\'te MEVCUTTUR (`codex --add-dir` → "a value is required"), yani bu bir motor EKSİĞİ değil ÜRÜN KARARIdır: bu üründe hafıza dizinleri codex argv\'sine EKLENMİYOR (agentRunner.js withMemoryDirs zaten claude\'da da uygulanmıyor — buildSpawn onu çağırmıyor). Açmak bir DAVRANIŞ değişikliğidir, ENG-07 refactor kapsamı dışıdır → ayrı görev',
    }),

    partial: Object.freeze({
      mcp:
        'kayıt ADDITIVE: `--strict-mcp-config` dengi yok → yalnız bizim server\'ımızı bırakma garantisi YOK (ENG-R3 §14-R4, agentRunner.js:1578-1583)',
      session:
        'oturum kimliği BİZ basamayız (mint yok) → resume best-effort, jeton eşlemesi cwd+zaman sezgisi (ENG-R3 §2.2-2)',
      identity:
        'kimlik pozisyonel prompt: dosya taşıyıcısı yok → 8.000 karakter CLI duvarı geçerli, ilk kırpılan şey hafıza bloğu (agentRunner.js:2160-2172)',
    }),

    verification: Object.freeze({
      contextScope: Object.freeze({ channel: 'unverified', source: 'TOKEN-BUDGET-01 — bu motorda belge-enjeksiyonunu kapatan bir bayrak ARANMADI/ÖLÇÜLMEDİ; kesim yalnız beyan eden motorda koşar' }),
      identity: Object.freeze({ channel: 'measured', source: 'ENG-R2 §2.3 (codex 0.147 gerçek koşu: sistem-prompt bayrağı YOK) + agentRunner.js:459' }),
      model: Object.freeze({ channel: 'source', source: 'electron/agentRunner.js:372-377' }),
      effort: Object.freeze({ channel: 'measured', source: 'CDX-F1 G2 (codex-cli 0.147.0): bayraksız başlık `reasoning effort: low` ↔ `-c model_reasoning_effort="high"` → `high` · AGENT-MODEL-01 (0.154.0): `ultra` da gerçek turda kabul edildi (başlık `reasoning effort: ultra`, tur tamamlandı) → küme xhigh/max/ultra ile genişletildi' }),
      images: Object.freeze({ channel: 'source', source: 'electron/agentRunner.js:405-417 (ENG-IMG-01)' }),
      provider: Object.freeze({ channel: 'source', source: 'electron/agentRunner.js:392-398 + providers.cjs' }),
      session: Object.freeze({ channel: 'source', source: 'electron/agentRunner.js:1669,1734-1739' }),
      subagentBlock: Object.freeze({ channel: 'source', source: 'electron/agentRunner.js:1094-1095,1621-1624' }),
      trust: Object.freeze({ channel: 'measured', source: 'ADP-283 probe (codex-cli 0.144, gerçek pty) + agentRunner.js:243-296' }),
      reset: Object.freeze({ channel: 'source', source: 'electron/main.js:9798-9802' }),
      tui: Object.freeze({ channel: 'unverified', source: 'ölçüm YOK — ENG-R3 §2.1 "Codex vb. için sinyal yoksa bütçe tavanı"' }),
      mcp: Object.freeze({ channel: 'source', source: 'electron/agentRunner.js:1054-1061,1137-1149' }),
      hooks: Object.freeze({ channel: 'source', source: 'electron/agentRunner.js:1344 (dengi yok, yorumda beyan)' }),
      extraRoots: Object.freeze({ channel: 'source', source: 'electron/agentRunner.js:803-804' }),
      skillsDir: Object.freeze({ channel: 'measured', source: 'SK-01 Ö4/Ö5 ikili ölçümü + skillEngineView.cjs:46-53' }),
      identityEnv: Object.freeze({ channel: 'source', source: 'electron/engineProfiles.cjs:60-63' }),
      auth: Object.freeze({ channel: 'source', source: 'electron/engineAuth.cjs:65-75,230' }),
      usage: Object.freeze({ channel: 'measured', source: 'ADP-887 defter ölçümü + electron/tokenUsage.cjs:13-19' }),
      output: Object.freeze({ channel: 'measured', source: 'ENG-R2-inferno.md §2.3 (codex 0.147 gerçek koşu, JSONL)' }),
      install: Object.freeze({ channel: 'source', source: 'electron/engineInstall.cjs:102-108' }),
    }),
  }),

  // ───────────────────────────────────────────────────────────────────────────
  // ENG-12 — GitHub Copilot CLI: descriptor zincirinin İLK gerçek sınavı.
  //
  // Bu kayıt ÜÇÜNCÜ motoru getiriyor ve iddiası şu: yeni motor = TEK descriptor
  // kaydı + ölçüm, kod dalı DEĞİL. Her alanın kaynağı `verification` bloğunda;
  // ölçümler `docs/agent-results/ENG-12-olcum-inferno.md` (Faz 1, 4 kapı) ve
  // `ENG-12-evidence-kablolama/` (Faz 2, kablolama ölçümleri).
  //
  // Kaydın açtığı İKİ yeni yol (ikisi de şemada VARDI, kod tarafında YOKTU —
  // ENG-07 geri bildirimi, rapor §6):
  //   1. `identity.kind:'env-file'` — kimlik argv'de değil, bir DİZİN + ENV ile
  //      taşınır (agentRunner.applyIdentityEnvFile).
  //   2. `mcp.valuePrefix` — config dosyasının yolu bayrağa `@` önekiyle girer
  //      (copilot değeri `json|@dosya` diye ayrıştırır; öneksiz yol JSON sanılır).
  // ───────────────────────────────────────────────────────────────────────────
  copilot: Object.freeze({
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    bin: 'copilot',

    // ADR-004 dengi: claude'un `--dangerously-skip-permissions` karşılığı ARAÇ onayını
    // kapatan bayraktır; YOL doğrulamasını kapatan `--allow-all-paths`/`--yolo` BİLEREK
    // alınmadı (copilot varsayılanı: cwd + tempdir dışına dosya erişimi yok — bu bizim
    // lehimize bir sınır, gönüllü olarak bırakılmaz).
    // `--no-remote-export` BİLİNÇLİ bir ÜRÜN kararıdır (ENG-12 risk 4): copilot oturumu
    // GitHub web/mobil'e aktarabiliyor; müşteri kodu taşıyan bir pane'in bunu SESSİZ
    // varsayılanla yapması kabul edilemez. Bayrak uzaktan kontrolü de kapatır (help:
    // "also disables remote control"). Açmak isteyen bilinçli açar.
    defaultArgs: Object.freeze(['--allow-all-tools', '--no-remote-export']),

    // ENG-20 — ONAY yüzeyi tam otomatik; YOL sınırı ayrı bir kapıdır (onay değil, ERİŞİM).
    autonomy: Object.freeze({
      level: 'full',
      via: 'argv',
      flags: Object.freeze(['--allow-all-tools']),
      measured: 'ENG-12 ölçümü: `--allow-all-tools` araç onay sorusunu kapatan bayraktır (copilot help + gerçek pane turu)',
      why: 'Araç onayı claude paritesinde AÇIK. `--allow-all-paths`/`--yolo` BİLEREK alınmadı: o bayrak onay sorusunu değil cwd+tempdir YOL SINIRINI kaldırır — sınır dışı erişim onay SORMAZ, reddedilir; otopilot akışını kesmez (ENG-12 kararı korunuyor)',
    }),

    // ─── 1. KAPI — KİMLİK: ENV + DOSYA taşıyıcısı ────────────────────────────
    // ÖLÇÜLDÜ: `COPILOT_CUSTOM_INSTRUCTIONS_DIRS=<dizin>` → o dizindeki
    // `*.instructions.md` dosyaları sistem talimatlarına EKLENİR (değiştirmez).
    // Dosya adı serbest, yalnız uzantı şart; YAML frontmatter GEREKMİYOR.
    // 🔑 AYNI ÇALIŞMA DİZİNİNDE İKİ FARKLI KİMLİK ÖLÇÜLDÜ (10-identity-proof.txt) →
    // ENG-R2 §5.1'in "proje dosyası ⇒ aynı dizinde iki kimlik imkânsız" sınırı
    // ÇÜRÜTÜLDÜ. Kimlik pane-başına env ile taşınır, repo'ya hiçbir şey yazılmaz.
    identity: Object.freeze({
      kind: 'env-file',
      env: 'COPILOT_CUSTOM_INSTRUCTIONS_DIRS',
      // ENG-14 — EKLER mi YERİNE Mİ geçer? ÖLÇÜLDÜ (ENG-12 §2.3): dosyalar sistem
      // talimatlarına EKLENİR, gömülü prompt KORUNUR (gemini'nin REPLACE riski YOK).
      replacesSystemPrompt: false,
      envSeparator: ',', // help environment: "comma-separated list of additional directories"
      fileSuffix: '.instructions.md', // ÖLÇÜLDÜ: `AGENTS.md` adıyla aynı dizinde GÖRÜLMEZ
      position: 'append', // ADDITIVE: gömülü sistem prompt'u KORUNUR (gemini'nin REPLACE riski YOK)
      cap: Object.freeze({ cli: null, file: 'FILE_MAX' }), // taşıyıcı dosya → 8.000 karakter CLI duvarı YOK
      // Kimlik konuşmaya GÖRÜNMEZ (sistem talimatı) ama RESUME'da dizinin yeniden
      // okunup okunmadığı ÖLÇÜLMEDİ → claude/codex ile aynı ihtiyat: resume'da
      // yeniden enjekte ETME (restore edilen bağlam kimliği zaten taşır varsayımı,
      // ADP-192). Ölçülürse `true`ya çekilebilir; ölçmeden açmak sessiz yalan olurdu.
      resumeReinject: false,
      // Ölçülmüş İKİNCİ yol (yedek): `--agent <ad>` + `$COPILOT_HOME/agents/<ad>.md`.
      // Bayrak seçer, metin dosyada yaşar. ⚠️ Bu yolun gömülü sistem prompt'unu
      // EKLEYİP mi DEĞİŞTİRDİĞİ ÖLÇÜLMEDİ → birincil yol olarak seçilmedi
      // (gemini `GEMINI_SYSTEM_MD` dersi: sessiz yetenek kaybı).
      alt: Object.freeze({
        kind: 'flag',
        flag: '--agent',
        defDir: Object.freeze({ scope: 'engine-home', homeEnv: 'COPILOT_HOME', segments: Object.freeze(['agents']) }),
        projectDir: '.github/agents',
        replacesSystemPrompt: null, // ÖLÇÜLMEDİ
      }),
    }),

    model: Object.freeze({
      kind: 'flag',
      flag: '--model',
      position: 'append',
      detect: Object.freeze({
        kind: 'json-settings',
        env: 'COPILOT_MODEL', // help environment: `--model` bunu EZER
        field: 'model', // help config: "`model`: AI model to use for Copilot CLI"
        files: Object.freeze([
          Object.freeze({ scope: 'engine-home', homeEnv: 'COPILOT_HOME', segments: Object.freeze(['settings.json']) }),
        ]),
      }),
      // 🪤 `--model auto` varsayılan: yönlendirici modeli KOŞU ANINDA seçer (ölçüldü:
      // `session.auto_mode_resolved` → gpt-5-mini). Ayardaki değer GERÇEK modeli
      // söylemeyebilir; kart bunu okumalı. Sniffer YOK: copilot TUI banner'ı ölçülmedi
      // ve claude/gpt kalıplarını başka bir ekrana uygulamak yanlış model YAZDIRIRDI.
      runtimeEvent: 'session.auto_mode_resolved',
    }),

    images: Object.freeze({
      kind: 'flag',
      flag: '--attachment',
      repeat: 'per-item',
      position: 'append',
    }),

    // BYOK yüzeyi ENV ile: COPILOT_PROVIDER_BASE_URL/_TYPE/_API_KEY/_WIRE_API/…
    // ADP-594 adapter deseninin doğal eşleniği: `wire_api` ayrımı burada da var.
    provider: Object.freeze({
      kind: 'env-overrides',
      envPrefix: 'COPILOT_PROVIDER_',
      baseUrlEnv: 'COPILOT_PROVIDER_BASE_URL',
      apiKeyEnv: 'COPILOT_PROVIDER_API_KEY',
      wireApiEnv: 'COPILOT_PROVIDER_WIRE_API',
      wireApis: Object.freeze(['completions', 'responses']),
      types: Object.freeze(['openai', 'azure', 'anthropic']),
    }),

    // OTURUM — claude paritesi (ÖLÇÜLDÜ): oturum kimliğini BİZ basıyoruz.
    session: Object.freeze({
      mint: 'uuid',
      flag: '--session-id',
      killSwitchEnv: null,
      resume: Object.freeze({
        form: 'append',
        flag: '--resume',
        idShape: 'uuid-or-prefix-or-name', // help: "session ID, task ID, ID prefix, or name"
        lastFallback: Object.freeze(['--continue']),
      }),
    }),

    // 🔴 GÜVENLİK BEYANI: copilot alt-ajan yüzeyi özellik bayrağı arkasında; açık
    // oturumda alt-ajan aracının ADI GÖRÜLMEDİ → `--deny-tool <ad>` yazılamaz.
    // Uydurma ad yazmak, bloğu var sanıp koşmaktır.
    // TOKEN-BUDGET-01 — BAĞLAM KAPSAMI: bu motorun kendi belge enjeksiyonunu
    // (proje talimatı zinciri + kalıcı hafıza indeksi) ÇALIŞMA ALANIYLA sınırlayan
    // bir taşıyıcı ÖLÇÜLMEDİ. `null` = bugünkü davranış aynen sürer; kesim yalnız
    // beyan eden motorda uygulanır (paneContextScope HEPSİ-YA-HİÇ kuralı).
    contextScope: null,
    subagentBlock: null,

    trust: Object.freeze({
      kind: 'json-settings',
      file: '$COPILOT_HOME/settings.json',
      pointer: 'trustedFolders[]',
      write: 'merge',
      bypassEnv: 'COPILOT_ALLOW_ALL',
      bypassFlag: '--allow-all-tools',
      // Güven yazımı MOTORUN ev dizinine düşer ($COPILOT_HOME) → hesap profili bu
      // değişkeni ezebilir, yani yazım spawn env'i çözüldükten SONRA anlamlıdır
      // (codex'le aynı sınıf; bugün planEngineTrust yalnız beyanı okur).
      homeScope: 'engine-home',
      homeEnv: 'COPILOT_HOME',
    }),

    reset: '/clear', // help commands: "/clear — Abandon this session and start fresh"

    // TUI hazır/blocker dizeleri ÖLÇÜLMEDİ (canlı pty kaydı yok).
    tui: null,

    // ─── 2. KAPI — ARAÇ BAĞLAMA (ÖLÇÜLDÜ, uçtan uca) ─────────────────────────
    mcp: Object.freeze({
      kind: 'config-file',
      flag: '--additional-mcp-config',
      // 🪤 ÖLÇÜLDÜ (ENG-12 kablolama Ö1): değer `json|@dosya` diye ayrıştırılır.
      // Öneksiz yol JSON sanılır ve kayıt SESSİZCE düşerdi → dosya yolu `@` ile gider.
      valuePrefix: '@',
      // ÖLÇÜLDÜ (aynı koşu): config ZARFI claude ile AYNI (`{mcpServers:{…}}`);
      // düz harita "mcpServers: Required" ile REDDEDİLİYOR → ortak yazıcı
      // (agentRunner.ensureTaskMcpConfig) değişmeden kullanılabilir.
      strictFlag: null, // `--strict-mcp-config` dengi YOK → kayıt ADDITIVE
      disableBuiltinFlag: '--disable-builtin-mcps', // gömülü github-mcp-server'ı kapatır
      disableServerFlag: '--disable-mcp-server',
      envInheritance: true, // ÖLÇÜLDÜ: MCP çocuğu pane env'ini ALIYOR (claude gibi)
      secretStripFlag: '--secret-env-vars', // env'den sır silme kaldıracı (copilot'a özgü)
      toolNaming: '<serverName>-<toolName>', // ölçüldü: "eng12probe-probe_ping"
      position: 'append',
    }),

    // Hook yüzeyi VAR ama AYAR DOSYASINDA yaşıyor (per-launch bayrak YOK) → bugünkü
    // ADP-692 kanalı (`--settings <dosya>`) copilot'ta kurulamaz. `hooks` alanı
    // beyandır; çağıran (withTurnBriefing) yalnız `flag` taşıyan yüzeyi uygular.
    hooks: Object.freeze({
      kind: 'config-file',
      file: '$COPILOT_HOME/settings.json',
      key: 'hooks',
      projectDir: '.github/hooks',
      events: Object.freeze(['sessionStart', 'userPromptSubmit', 'preToolUse']),
    }),

    extraRoots: Object.freeze({ flag: '--add-dir', repeat: 'variadic' }),

    // ÖLÇÜLDÜ (`copilot skill list`): copilot `.claude/skills` dizinini KENDİLİĞİNDEN
    // tarıyor — dizin eşlemesi bedava geliyor (ayrıştırıcı katılığı `partial`de).
    skillsDir: Object.freeze({ scope: 'workspace', segments: Object.freeze(['.claude', 'skills']) }),

    // Profil ayrımı: COPILOT_HOME pane başına verilebiliyor (ayar + oturum defteri
    // orada oluşur). ⚠️ HESABI ayırmaz (jeton anahtar zincirinde) — `partial`de beyanlı.
    identityEnv: 'COPILOT_HOME',

    auth: Object.freeze({
      label: 'GitHub Copilot CLI',
      accountHint: 'GitHub Copilot aboneliğin (Pro / Business / Enterprise)',
      signupUrl: 'https://github.com/features/copilot/plans',
      // Yerel masaüstünde varsayılan: tarayıcı + loopback callback → kod adımı YOK
      // (uzak/headless ortamda `--device-code`; ürün pane'i yerel bir pty).
      flow: 'oauth-callback',
      needsCode: false,
      loginArgv: Object.freeze(['login']),
      // 🔴 ÖLÇÜLDÜ: copilot'ta DURUM komutu YOK (ENG-12 §2.7).
      statusArgv: null,
      statusParse: null,
      logoutArgv: null,
      statusNote:
        'copilot 1.0.80\'de hesap DURUMU komutu YOK: kabuk-tamamlama betiği tam komut listesini veriyor (completion|help|init|login|mcp|plugin|plugins|skill|update|version) — ne `auth status` ne `logout` var (ENG-12-evidence/05-completion.txt). Uydurma argv yazmak yerine rozet ÜÇÜNCÜ durumu gösterir: BİLİNMİYOR (giriş yapıldı DEMEZ, yapılmadı da DEMEZ)',
      apiKey: null,
      apiKeyNote:
        'copilot abonelik yolunu birinci sınıf tutar; anahtar yolu VAR ama iki ayrı şekilde: (a) COPILOT_GITHUB_TOKEN/GH_TOKEN/GITHUB_TOKEN ile GitHub jetonu, (b) COPILOT_PROVIDER_* ile BYOK. Bu turda (a) DOĞRULANAMADI: makinede kayıtlı kimlik varken sahte jeton konulan koşu yine BAŞARILI oldu → Ayarlar\'a anahtar kutusu koymadan önce temiz makinede ölçülmeli',
    }),

    // ─── 4. KAPI — KULLANIM (ÖLÇÜLDÜ; claude sınıfı: KESİN eşleşme) ──────────
    usage: Object.freeze({
      kind: 'session-ledger', // oturum kimliğini BİZ bastığımız için defter kesin bilinir
      level: 'exact',
      content: 'transcript', // ENG-14 — events.jsonl satırları OLAYdır (ENG-12 ölçümü)
      reader: 'copilot-events-jsonl', // tokenUsage.LEDGER_READERS'ta HENÜZ YOK (ENG-09 takibi)
      format: 'jsonl',
      root: '$COPILOT_HOME/session-state/<sessionId>',
      rootEnv: 'COPILOT_HOME',
      file: 'events.jsonl',
      sessionKey: 'minted-uuid',
      accumulation: 'cumulative-last-wins', // `session.usage_checkpoint.totalNanoAiu` KÜMÜLATİF
      dedupeBy: null,
      // 🪤 Birim TOKEN da USD de DEĞİL: "nano AI credit" (1e-9 kredi). Token kırılımı
      // AYNI home'daki sqlite defterinde: session-store.db → assistant_usage_events.
      cost: 'nano-aiu',
      altLedger: Object.freeze({
        kind: 'sqlite',
        file: '$COPILOT_HOME/session-store.db',
        table: 'assistant_usage_events',
        key: 'session_id',
      }),
      billing: Object.freeze({
        apiKeyEnv: 'COPILOT_PROVIDER_API_KEY', // doluysa fatura BYOK sağlayıcısına gider
        configFile: null,
        field: null,
        planField: null,
        subscriptionWhen: 'always', // GitHub Copilot planı; API-anahtarı kipi yok
        sourceLabel: 'session.usage_checkpoint.totalNanoAiu (AI credits)',
        overrideOpt: 'copilotHome',
      }),
    }),

    // ─── 3. KAPI — SÜPERVİZÖR OKUMA (ÖLÇÜLDÜ) ────────────────────────────────
    output: Object.freeze({
      kind: 'jsonl', // değerin ADI 'json', ŞEKLİ satır-satır JSON (help + ölçüm)
      flag: '--output-format',
      values: Object.freeze(['json']),
      resultEvent: 'result', // {sessionId, exitCode, usage{…}} — tamamlanma tespiti
      silentFlag: '-s',
    }),

    install: Object.freeze({
      label: 'GitHub Copilot CLI',
      command: 'npm install -g --prefix ~/.local @github/copilot',
      win32Command: 'npm install -g @github/copilot',
      docsUrl: 'https://docs.github.com/copilot/how-tos/copilot-cli',
      checkHint: 'https://docs.github.com/copilot/how-tos/copilot-cli',
      verifyArgv: Object.freeze(['--version']),
      verifyPattern: 'github\\s+copilot', // ÖLÇÜLDÜ: "GitHub Copilot CLI 1.0.80."
    }),

    // CDX-F1 — efor kolu bu motorda BEYAN EDİLMEDİ (gerekçe: unsupported.effort).
    effort: null,

    unsupported: Object.freeze({
      contextScope:
        'bu motorun kendi belge enjeksiyonunu (proje talimatı zinciri + kalıcı hafıza indeksi) çalışma alanıyla sınırlayan bir taşıyıcı ÖLÇÜLMEDİ — kesim yalnız beyan eden motorda koşar, burada bugünkü davranış aynen sürer (TOKEN-BUDGET-01)',
      effort:
        'efor/akıl-yürütme seviyesi taşıyıcısı BU MOTORDA ÖLÇÜLMEDİ — CDX-F1 kapsamı bilerek codex (+claude beyanı) ile sınırlı tutuldu; beyan edilene kadar per-launch efor override\'ı YOKTUR ve motor kendi varsayılanıyla koşar (sessiz kayıp değil, ölçülmemiş kol)',
      subagentBlock:
        'copilot alt-ajan yüzeyi özellik-bayrağı arkasında (ikilide copilot_cli_*_subagent bayrakları var); açık oturumda alt-ajan aracının ADI ölçülemedi → `--deny-tool <ad>` yazılamaz. Uydurma ad = var sanılan blok. Ölçülene kadar YOK beyan edilir; geçici sertleştirme `--available-tools` beyaz listesiyle yapılabilir',
      tui:
        'copilot TUI hazır/blocker dizeleri ÖLÇÜLMEDİ (ENG-12 headless ölçüm turuydu; canlı pty kaydı yapılmadı) → çağıran sabit boot bütçesiyle devam etmeli, claude kalıpları copilot ekranına UYGULANMAMALI',
    }),

    partial: Object.freeze({
      identity:
        'kimlik dosyası `.instructions.md` ile BİTMEK ZORUNDA (ölçüldü: `AGENTS.md` adıyla aynı dizinde GÖRÜLMEDİ) ve dizin PANE BAŞINA ayrılmalı — aynı dizine iki kimlik yazmak iki kişiliği ÜST ÜSTE bindirir. RESUME\'da dizinin yeniden okunup okunmadığı ÖLÇÜLMEDİ → resumeReinject:false (ihtiyat)',
      identityEnv:
        'COPILOT_HOME pane başına AYARLARI ve OTURUM DEFTERİNİ ayırır ama HESABI ayırmaz: jeton sistem anahtar zincirinde yaşıyor (ölçüldü — taze home aynı hesapla koştu). İki ayrı GitHub hesabı isteniyorsa jeton env yolu (COPILOT_GITHUB_TOKEN) gerekir ve o yol bu turda doğrulanamadı',
      mcp:
        'kayıt ADDITIVE: `--strict-mcp-config` dengi YOK → yalnız bizim server\'ımızı bırakma garantisi YOK; ayrıca gömülü github-mcp-server varsayılan olarak AÇIK (her pane kullanıcının GitHub jetonuyla konuşabilen bir araç setiyle açılır) — daraltmak için `--disable-builtin-mcps` açıkça verilmeli (ENG-R3 §14-R4 ile aynı sınıf risk)',
      skillsDir:
        '.claude/skills taranıyor AMA copilot\'un YAML ayrıştırıcısı claude\'dan KATI: description alanındaki tırnaksız iki nokta yüzünden bazı CrewPane skill\'leri "mapping values are not allowed" ile DÜŞÜYOR (ENG-12-evidence/09-skill-list.txt). Düzeltilene kadar o skill\'ler copilot pane\'inde YOK sayılmalı',
      images:
        '`--attachment` yalnız NON-INTERACTIVE kipte geçerli (help: "only valid in non-interactive mode") → TUI pane\'inde görsel bayrakla verilemez; interaktif pane için görselin yolu metne gömülmeli (claude\'daki composePromptWithImages deseni)',
      hooks:
        'hook yüzeyi AYAR DOSYASINDA yaşıyor (per-launch bayrak YOK) → ADP-692 tur-başı brifingi copilot lideri için KURULAMAZ; pane başına hook ancak pane başına COPILOT_HOME ile mümkün ve bu turda hook GERÇEKTEN KOŞTURULMADI (yalnız olay adları + ayar anahtarı ikiliden okundu)',
      provider:
        'BYOK env yüzeyi ikiliden okundu (COPILOT_PROVIDER_*) ama GERÇEK bir BYOK koşusu YAPILMADI (anahtar yok) → wire_api/responses davranışı ADP-594 adapterıyla eşleştirilmeden önce ölçülmeli',
      trust:
        'güven kapısının varlığı ikili kaynağından okundu ve `--allow-all-tools` ile kısa devre olduğu ölçüldü; ancak GÜVENİLMEYEN bir dizinde İNTERAKTİF TUI\'nin diyalog çıkarıp çıkarmadığı ölçülmedi (canlı pty turu gerek)',
      usage:
        'defter ŞEKLİ ölçüldü (events.jsonl + sqlite, nano-AIU) ama `copilot-events-jsonl` okuyucusu tokenUsage.LEDGER_READERS\'ta HENÜZ YOK → jeton kartı bugün copilot pane\'i için "ölçülemedi" der (ENG-09 takip kalemi). Birim USD DEĞİL kredi: dolar UYDURULMAMALI',
      model:
        'model bayrağı + ayar zinciri ölçüldü, ama `--model auto` varsayılanı gerçek modeli KOŞU ANINDA seçiyor (session.auto_mode_resolved) ve TUI banner deseni ölçülmediği için `sniff` beyan EDİLMEDİ → kart "seçili model"i ayardan okur, canlı teyit YOK',
    }),

    verification: Object.freeze({
      contextScope: Object.freeze({ channel: 'unverified', source: 'TOKEN-BUDGET-01 — bu motorda belge-enjeksiyonunu kapatan bir bayrak ARANMADI/ÖLÇÜLMEDİ; kesim yalnız beyan eden motorda koşar' }),
      effort: Object.freeze({ channel: 'unverified', source: 'CDX-F1: bu motorda efor bayrağı ARANMADI/ölçülmedi (kapsam: codex + claude)' }),
      identity: Object.freeze({ channel: 'measured', source: 'ENG-12-evidence/10-identity-proof.txt — aynı cwd, iki env dizini, iki farklı kimlik (copilot 1.0.80 gerçek koşu) + ENG-12-evidence-kablolama/02-identity-e2e.txt (buildSpawn argv/env ile gerçek koşu)' }),
      model: Object.freeze({ channel: 'measured', source: 'copilot --help (--model) + `copilot help config|environment` — ENG-12-evidence/02-help.txt, 03-help-topics.txt' }),
      images: Object.freeze({ channel: 'measured', source: 'copilot --help: --attachment <path> "only valid in non-interactive mode" — ENG-12-evidence/02-help.txt' }),
      provider: Object.freeze({ channel: 'measured', source: '`copilot help environment` COPILOT_PROVIDER_* bloğu — ENG-12-evidence/03-help-topics.txt (koşu YOK, bkz. partial)' }),
      session: Object.freeze({ channel: 'measured', source: 'ENG-12-evidence/08-usage-ledger.txt — `--session-id <uuid>` ile açılan oturumun defter dizini aynı uuid' }),
      subagentBlock: Object.freeze({ channel: 'unverified', source: 'ölçüm YOK — alt-ajan aracının adı görülmedi (null yetenek; unsupported gerekçesi yazıldı)' }),
      trust: Object.freeze({ channel: 'measured', source: 'ikili kaynağı (folderTrustIsTrusted/trustedFolders) + COPILOT_ALLOW_ALL kısa devresi + /tmp koşularında diyalog çıkmaması' }),
      reset: Object.freeze({ channel: 'measured', source: '`copilot help commands` → "/clear Abandon this session and start fresh" — ENG-12-evidence/03-help-topics.txt' }),
      tui: Object.freeze({ channel: 'unverified', source: 'canlı pty kaydı YOK — ENG-12 headless ölçüm turudur' }),
      mcp: Object.freeze({ channel: 'measured', source: 'ENG-12-evidence/06-mcp-tool-call.jsonl (stdio sunucu bağlandı, araç ÇAĞRILDI) + ENG-12-evidence-kablolama/01-mcp-config-shape.txt (zarf: mcpServers ZORUNLU, değer öneki @) + 03-board-mcp-e2e.txt (CrewPane board MCP\'si gerçek pane argv\'siyle çağrıldı)' }),
      hooks: Object.freeze({ channel: 'measured', source: '`copilot help config` → `hooks` anahtarı; ikilide sessionStart/userPromptSubmit/preToolUse olay adları (koşu YOK, bkz. partial)' }),
      extraRoots: Object.freeze({ channel: 'measured', source: 'copilot --help → --add-dir <directory> (can be used multiple times) — ENG-12-evidence/02-help.txt' }),
      skillsDir: Object.freeze({ channel: 'measured', source: 'ENG-12-evidence/09-skill-list.txt — workspace kökünde `copilot skill list` .claude/skills dosyalarını buldu' }),
      identityEnv: Object.freeze({ channel: 'measured', source: 'taze COPILOT_HOME ile koşu: session-state/ + session-store.db orada oluştu, giriş İSTENMEDİ (jeton anahtar zincirinde)' }),
      auth: Object.freeze({ channel: 'measured', source: '`copilot login --help` (loopback/web varsayılan, --device-code) + ENG-12-evidence/05-completion.txt (durum/logout komutu YOK)' }),
      usage: Object.freeze({ channel: 'measured', source: 'ENG-12-evidence/08-usage-ledger.txt — assistant_usage_events satırı + events.jsonl session.usage_checkpoint.totalNanoAiu' }),
      output: Object.freeze({ channel: 'measured', source: 'ENG-12-evidence/06-mcp-tool-call.jsonl — --output-format json satır-satır JSON; son satır `result{sessionId,exitCode,usage}`' }),
      install: Object.freeze({ channel: 'measured', source: 'ENG-12-evidence/01-version.txt — ~/.local/lib/node_modules/@github/copilot, `copilot --version` → "GitHub Copilot CLI 1.0.80."' }),
    }),
  }),

  // ───────────────────────────────────────────────────────────────────────────
  // ENG-13 — DÖRDÜNCÜ MOTOR: goose 1.46.0 (block/aaif-goose, Rust CLI).
  //
  // 🔴 KENDİ ÖLÇÜMÜMÜN DÜZELTMESİ (ENG-13-olcum-ironhide.md §2 satır 3): Faz 1
  // kimliği `goose run --system <TEXT>` ile ÖLÇTÜ ve "kimlik bayrağı VAR" dedi.
  // Bu HEADLESS yol için doğru, PANE için YANLIŞ: `--system` yalnız `run`
  // alt-komutunda var (`goose session --help` tam seçenek listesinde YOK) ve
  // `goose run` girdisiz KOŞMUYOR ("Must provide either --instructions (-i),
  // --text (-t), or --recipe" — ölçüldü) → interaktif pane `goose session`tır ve
  // orada `--system` YOKTUR. Pane kimliği bu yüzden ENV+DOSYA taşıyıcısıyla
  // gider: `GOOSE_SYSTEM_PROMPT_FILE_PATH` (GERÇEK PTY'de ölçüldü — kimlik
  // interaktif oturumda okundu). Doküman değil İKİLİ otoritedir; burada
  // yanılan doküman değil, kendi Faz-1 ölçümümün KAPSAMIYDI.
  goose: Object.freeze({
    id: 'goose',
    label: 'Goose',
    bin: 'goose',

    // Pane = İNTERAKTİF oturum. `goose` çıplak koşunca yalnız yardım basar (ölçüldü),
    // `goose run` girdi ister → tek doğru pane komutu `session`.
    // ⚠️ ADR-004 dengi bir "izinleri atla" bayrağı goose'ta YOK: araç onayı
    // GOOSE_MODE ile ayarlanır (config/env), argv'de değil. Bu yüzden defaultArgs
    // yalnız alt-komuttur — uydurma bayrak EKLENMEZ.
    defaultArgs: Object.freeze(['session']),

    // ENG-20 — TEK "unknown" SATIR. goose'ta onay kipi argv'de DEĞİL `GOOSE_MODE`
    // config/env'indedir; ölçülen tek şey CLI yardımıdır ve orada bu kip HİÇ geçmiyor
    // (`goose --help` + `goose session --help` tam liste tarandı: "mode" yok; `goose info`
    // config.yaml'ı "missing" diyor → yerel kullanıcıda yazılı bir kip DE yok). Değerin
    // adını dokümandan KOPYALAMAK bu defterin yasakladığı şeydir (ENG-09 "tahmin yok"):
    // yanlış bir env adı pane'i SESSİZCE yarı-otomatik bırakır ve beyan "full" der.
    // Doğru cevap bugün "ÖLÇMEDİM"; ölçüm gerçek bir goose turu ister → ayrı görev.
    autonomy: Object.freeze({
      level: 'unknown',
      via: null,
      flags: Object.freeze([]),
      measured: null,
      why: 'goose\'ta ADR-004 dengi argv bayrağı YOK (ölçüldü: yardım listesinde onay/kip seçeneği geçmiyor); kip `GOOSE_MODE` config/env kapısındadır ve DEĞERİ ölçülmedi → beyan "unknown" kalır, uydurulmuş bir env yazılmaz. Takip: gerçek goose turunda kip ölçülüp env `trust`/otonomi kapısına bağlanacak',
    }),

    // ─── 1. KAPI — KİMLİK: ENV → DOSYA (copilot sınıfı, ama env bir DOSYA yolu) ──
    // ÖLÇÜLDÜ (gerçek pty, `goose session`): `GOOSE_SYSTEM_PROMPT_FILE_PATH=<dosya>`
    // → dosyadaki metin sistem talimatlarına EKLENİR; ajan kod kelimesini cevapladı
    // ve AYNI koşuda araçlarını kullanmaya devam etti (REPLACE değil APPEND —
    // gemini `GEMINI_SYSTEM_MD` riski burada YOK).
    // 🔑 copilot'tan FARK: env bir DİZİN değil TEK DOSYA yolu taşır (`envTarget:'file'`)
    // → değer VİRGÜLLE BİRLEŞTİRİLEMEZ; ikinci bir yol yazmak dosyayı bulunamaz yapar.
    identity: Object.freeze({
      kind: 'env-file',
      env: 'GOOSE_SYSTEM_PROMPT_FILE_PATH',
      // ENG-14 — EKLER mi YERİNE Mİ geçer? ÖLÇÜLDÜ (ENG-13 §2.2): kimlik okundu VE
      // ajan aynı koşuda araçlarını kullanmayı SÜRDÜRDÜ → APPEND (REPLACE değil).
      replacesSystemPrompt: false,
      envTarget: 'file', // env DOSYAYI gösterir (varsayılan/copilot: 'dir')
      envSeparator: null, // tek yol → ADDITIVE birleştirme YOK (bkz. partial.identity)
      fileSuffix: '.md',
      fileName: 'crewpane-system.md',
      position: 'append',
      cap: Object.freeze({ cli: null, file: 'FILE_MAX' }),
      // RESUME'da dosyanın yeniden okunup okunmadığı ÖLÇÜLMEDİ → claude/codex/copilot
      // ile aynı ihtiyat. Ölçülürse `true`ya çekilebilir.
      resumeReinject: false,
      // Ölçülmüş İKİNCİ yol (yalnız HEADLESS): `goose run --system <TEXT>`.
      // Pane'de kullanılamaz (yukarıdaki düzeltme) — burada BEYAN olarak yaşar ki
      // ileride headless süpervizör turu bunu kullanabilsin.
      alt: Object.freeze({ kind: 'flag', flag: '--system', subcommand: 'run', replacesSystemPrompt: false }),
    }),

    model: Object.freeze({
      kind: 'flag',
      flag: '--model', // `goose session --model` VE `goose run --model` (ikisi de help'te)
      position: 'append',
      // ENG-09 — model kaynağı: env → $XDG_CONFIG_HOME/goose/config.yaml `GOOSE_MODEL`.
      // goose'un config anahtarları ile env adları AYNIDIR (ölçüldü: telemetri onayı
      // config.yaml'a `GOOSE_TELEMETRY_ENABLED: false` diye yazıldı).
      detect: Object.freeze({
        kind: 'yaml-config',
        env: 'GOOSE_MODEL',
        field: 'GOOSE_MODEL',
        homeEnv: 'XDG_CONFIG_HOME',
        homeSegments: Object.freeze(['goose']), // XDG kökü goose'un EV DİZİNİ DEĞİL, ÜSTÜDÜR
        homeFallback: Object.freeze(['.config', 'goose']),
        file: 'config.yaml',
      }),
      // TUI banner'ı modeli YAZIYOR ("● new session · claude-code claude-haiku-…")
      // ama claude/gpt cümle kalıplarına UYMUYOR → sniffer beyan EDİLMEZ (yanlış
      // model yazdırmaktansa hiç yazdırmamak).
    }),

    images: null,
    provider: null,

    // OTURUM — 🔑 kimliği BİZ basarız: `--name <uuid>`. ÖLÇÜLDÜ (sqlite):
    // `sessions.name = <verdiğimiz ad>` + `user_set_name = 1` → jeton defteri
    // pane'e KESİN eşlenir. (Oturum ID'sini goose kendi basar: `20260817_5`.)
    session: Object.freeze({
      mint: 'uuid',
      flag: '--name',
      killSwitchEnv: 'CREWPANE_DISABLE_SESSION_ID',
      resume: Object.freeze({
        form: 'append',
        flag: '--resume',
        // 🪤 goose'ta resume ADI İKİNCİ bir bayrakla verilir: `--resume --name <ad>`
        // (help: "When used with --resume, will resume this specific session").
        // Tek bayrak yazan bir kayıt SESSİZCE "son oturumu" resume ederdi.
        idFlag: '--name',
        idShape: 'uuid',
        lastFallback: Object.freeze(['--resume']),
      }),
    }),

    // TOKEN-BUDGET-01 — BAĞLAM KAPSAMI: bu motorun kendi belge enjeksiyonunu
    // (proje talimatı zinciri + kalıcı hafıza indeksi) ÇALIŞMA ALANIYLA sınırlayan
    // bir taşıyıcı ÖLÇÜLMEDİ. `null` = bugünkü davranış aynen sürer; kesim yalnız
    // beyan eden motorda uygulanır (paneContextScope HEPSİ-YA-HİÇ kuralı).
    contextScope: null,
    subagentBlock: null,

    // "Güven" kapısının goose'taki KARŞILIĞI: İLK KOŞU ONAYI. ÖLÇÜLDÜ (gerçek pty,
    // taze config dizini): oturum açılırken "Share anonymous usage data?" diyaloğu
    // çıkıyor ve KULLANICININ İLK YAZDIĞI HARFLERİ YUTUYOR (ölçümde "Adin " uçtu,
    // pane'e "ne? Kod kelimesini yaz." kaldı) — ADP-283'ün claude/codex'te kapattığı
    // arızanın ta kendisi. Kapatma yolu dosya yazmak DEĞİL, ENV: `GOOSE_TELEMETRY_
    // ENABLED=false` verilince taze dizinde diyalog HİÇ çıkmadı ve "goose is ready"
    // doğrudan geldi (ölçüldü).
    // Aynı mekanizma SAĞLAYICI için de gerekli: config.yaml yoksa goose "No provider
    // configured" ile durur → ölçülmüş ANAHTARSIZ yol (`claude-code`) YEDEK olarak
    // verilir. `preferUser: true` = kullanıcının kendi ayarı VARSA dokunulmaz.
    trust: Object.freeze({
      kind: 'env-consent',
      write: 'env-only', // kullanıcının config.yaml'ı ASLA yazılmaz
      homeScope: 'engine-home', // buildSpawn içinde uygulanır (env çözüldükten sonra)
      homeEnv: 'XDG_CONFIG_HOME',
      homeFallback: Object.freeze(['.config', 'goose']),
      homeSegments: Object.freeze(['goose']),
      configFile: 'config.yaml',
      pointer: 'GOOSE_TELEMETRY_ENABLED / GOOSE_PROVIDER / GOOSE_MODEL',
      canonicalizeCwd: false,
      preferUser: true, // env ya da config.yaml'da değer VARSA dokunma
      entries: Object.freeze([
        Object.freeze({
          env: 'GOOSE_TELEMETRY_ENABLED',
          value: 'false',
          why: 'ilk koşu onay diyaloğu ilk prompt\'u YUTUYOR (ölçüldü); varsayılanı KAPALI seçmek gizlilik lehine',
        }),
        Object.freeze({
          env: 'GOOSE_PROVIDER',
          value: 'claude-code',
          why: 'ölçülmüş ANAHTARSIZ yol: yerel `claude` CLI kimliğini kullanır, yeni anahtar/hesap istemez',
        }),
        Object.freeze({
          env: 'GOOSE_MODEL',
          value: 'claude-sonnet-5',
          why: 'claude-code sağlayıcısıyla GERÇEK koşuda doğrulandı; model verilmezse goose "No model configured" ile durur',
        }),
      ]),
    }),

    reset: '/clear', // ikili: "/clear — Clear the conversation history"

    tui: null,

    // ─── 2. KAPI — ARAÇ BAĞLAMA: per-launch KOMUT DİZESİ ────────────────────
    // ÖLÇÜLDÜ (gerçek koşu): `--with-extension "node '<boşluklu yol>'"` ile dış stdio
    // MCP sunucusu bağlandı, ajan aracı ÇAĞIRDI ve sunucu pane env'ini GÖRDÜ
    // (ENG12_SECRET cevaba döndü) → tırnaklama destekleniyor + env MİRAS ALINIYOR.
    // claude/copilot'tan FARK: değer bir JSON dosyası değil, TEK BİR KOMUT DİZESİ.
    mcp: Object.freeze({
      kind: 'cli-command',
      flag: '--with-extension',
      // 'ENV1=val1 ENV2=val2 command args...' (help grameri, ölçüldü)
      envPrefixInValue: true,
      quote: 'single', // boşluklu yollar tek tırnakla kapatılır (ölçüldü)
      strictFlag: null, // kullanıcının kendi uzantılarını BIRAKMA garantisi yok
      disableProfileFlag: '--no-profile', // TÜM varsayılan uzantıları kapatır (developer dahil!)
      envInheritance: true, // ÖLÇÜLDÜ: MCP çocuğu pane env'ini ALIYOR → sır argv'ye YAZILMAZ
      position: 'append',
    }),

    hooks: null,
    extraRoots: null,

    // ÖLÇÜLDÜ (`goose skills list`, workspace kökünde): goose `.claude/skills`
    // dizinini KENDİLİĞİNDEN tarıyor (claude/copilot ile AYNI dizin) ve
    // CrewPane skill'lerinin HEPSİ yüklendi (copilot'taki katı-YAML düşüşü YOK).
    skillsDir: Object.freeze({ scope: 'workspace', segments: Object.freeze(['.claude', 'skills']) }),

    // Profil ayrımı: XDG_CONFIG_HOME (ölçüldü — `goose info` üç yolu da taşıdı).
    identityEnv: 'XDG_CONFIG_HOME',

    auth: Object.freeze({
      label: 'Goose',
      accountHint: 'goose kendi hesabını AÇMAZ: bir sağlayıcı seçersin (ölçülen anahtarsız yol: yerel Claude Code aboneliğin)',
      signupUrl: 'https://block.github.io/goose/docs/getting-started/providers',
      // ENG-08 enum: giriş CrewPane DIŞINDA yapılır (`goose configure` sihirbazı ya
      // da sağlayıcının kendi CLI'ı) → ürün akış BAŞLATMAZ, yalnız beyan eder.
      flow: 'external',
      needsCode: false,
      loginArgv: null,
      logoutArgv: null,
      // 🔴 ÖLÇÜLDÜ ve TEHLİKELİ: goose'ta durum komutu YOK. `goose info` yalnız YOL
      // basar (hesap/sağlayıcı bilgisi yok); `goose doctor` ise bir DURUM KOMUTU
      // DEĞİL — AJANI KOŞTURUYOR (ölçüldü: oturum açtı, model turu harcadı). Onu
      // statusArgv yapmak her rozet tazelemesinde PARA HARCARDI.
      statusArgv: null,
      statusParse: null,
      statusNote:
        'goose 1.46.0\'da hesap DURUMU komutu YOK: `goose info` yalnız yol/sürüm basar, `goose doctor` ise durum sormaz AJANI KOŞTURUR (ölçüldü: model turu harcadı, maliyet çıkardı) → rozet ÜÇÜNCÜ durumu gösterir: BİLİNMİYOR. Sağlayıcı yapılandırması yoksa pane açılışta "No provider configured" der; ürün bunu `trust.entries` ile ölçülmüş anahtarsız yola (claude-code) düşürür',
      apiKey: null,
      apiKeyNote:
        'goose BYOK\'u SAĞLAYICI BAŞINA yapar (GOOSE_PROVIDER + o sağlayıcının kendi anahtar değişkeni: OPENAI_API_KEY, ANTHROPIC_API_KEY…) → tek bir "goose anahtarı" YOKTUR, Ayarlar\'a tek kutu koymak yanlış olurdu. Ürünün ölçülmüş varsayılanı ANAHTARSIZDIR (claude-code sağlayıcısı yerel claude kimliğini kullanır); sağlayıcı seçimi açılırsa ENG-13 §sonraki-adım kalemidir',
      noApiKeyNote:
        'goose\'ta anahtar kutusu yok — sağlayıcı anahtarı ortam değişkeniyle verilir (OPENAI_API_KEY, ANTHROPIC_API_KEY…). Hangi sağlayıcıyı seçtiğine bağlı olarak adı değişir ve CrewPane tek bir kutu için tek bir env adı gösteremez. Giriş: terminalden `goose configure` sihirbazı ile sağlayıcı seçimini yap; CrewPane yalnız durumunu okur.',
    }),

    // ─── 4. KAPI — KULLANIM: sqlite oturum defteri (KESİN eşleşme) ───────────
    // ÖLÇÜLDÜ (sqlite şeması): sessions(name, user_set_name, accumulated_*_tokens)
    // + usage_ledger(session_id, model, input/output/total/cache_*, cost REAL,
    // cost_source). Adı BİZ bastığımız için satır KESİN bulunur.
    usage: Object.freeze({
      kind: 'session-ledger',
      level: 'exact',
      content: 'counters', // ENG-14 — usage_ledger satırları SAYAÇ (mesaj gövdesi yok; biçim de sqlite)
      reader: 'goose-sessions-sqlite', // tokenUsage.LEDGER_READERS'ta HENÜZ YOK (ENG-09 takibi)
      // 🔑 BİÇİM JSONL DEĞİL SQLITE → teslim doğrulaması (transcript probu) bu motorda
      // satır-satır okuyamaz; completionChannels bu yüzden kanıt DOSYASINI zorunlu kılar.
      format: 'sqlite',
      root: '$XDG_DATA_HOME/goose/sessions',
      rootEnv: 'XDG_DATA_HOME',
      file: 'sessions.db',
      sessionKey: 'minted-name', // `--name <uuid>` → sessions.name (user_set_name=1)
      accumulation: 'cumulative-last-wins', // accumulated_* kolonları KÜMÜLATİF
      dedupeBy: null,
      cost: 'usd', // usage_ledger.cost REAL + cost_source; headless JSON'da `cost_usd` ölçüldü
      billing: Object.freeze({
        // Fatura KANALI sağlayıcıya bağlıdır: ölçülen varsayılan yol (claude-code)
        // kullanıcının claude ABONELİĞİNİ harcar; başka sağlayıcıda o sağlayıcının
        // anahtarı öder. Tek bir env "faturayı bu öder" diyemez → beyan böyle.
        apiKeyEnv: null,
        configFile: '$XDG_CONFIG_HOME/goose/config.yaml',
        field: 'GOOSE_PROVIDER',
        planField: null,
        subscriptionWhen: 'equals:claude-code',
        sourceLabel: 'usage_ledger.cost (goose sessions.db) · sağlayıcı = GOOSE_PROVIDER',
        overrideOpt: 'gooseDataHome',
      }),
    }),

    // ─── 3. KAPI — SÜPERVİZÖR OKUMA (headless `run`) ─────────────────────────
    output: Object.freeze({
      kind: 'json',
      flag: '--output-format',
      values: Object.freeze(['json', 'stream-json']),
      subcommand: 'run',
      // 🪤 ÖLÇÜLDÜ: `-q` YOKSA stdout'a ASCII banner basılıyor → `JSON.parse` PATLAR.
      quietFlag: '-q',
      requiresQuiet: true,
    }),

    install: Object.freeze({
      label: 'Goose',
      // ⚠️ ÖLÇÜLDÜ (kurulum script'i okundu, ENG-13 §5): varsayılan `CONFIGURE=true`
      // sonunda `goose configure`u /dev/tty'den İNTERAKTİF koşturur → otomasyonda
      // ASILIR; ayrıca PATH satırı için ~/.zshrc'yi değiştirmeyi TEKLİF eder.
      // `CONFIGURE=false` ikisini de kapatır (rc'ye dokunmaz, sihirbaz açılmaz).
      command:
        'curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | CONFIGURE=false GOOSE_BIN_DIR="$HOME/.local/bin" bash',
      win32Command: null,
      docsUrl: 'https://block.github.io/goose/docs/getting-started/installation',
      checkHint: 'https://block.github.io/goose/docs/getting-started/installation',
      // 🪤 `goose --version` YALNIZ sürüm numarası basar (" 1.46.0") → ürün KİMLİĞİNİ
      // kanıtlamaz. Kimlik `--help`ten okunur ("An AI agent / Usage: goose [COMMAND]").
      verifyArgv: Object.freeze(['--help']),
      verifyPattern: 'usage:\\s*goose',
    }),

    // CDX-F1 — efor kolu bu motorda BEYAN EDİLMEDİ (gerekçe: unsupported.effort).
    effort: null,

    unsupported: Object.freeze({
      contextScope:
        'bu motorun kendi belge enjeksiyonunu (proje talimatı zinciri + kalıcı hafıza indeksi) çalışma alanıyla sınırlayan bir taşıyıcı ÖLÇÜLMEDİ — kesim yalnız beyan eden motorda koşar, burada bugünkü davranış aynen sürer (TOKEN-BUDGET-01)',
      effort:
        'efor/akıl-yürütme seviyesi taşıyıcısı BU MOTORDA ÖLÇÜLMEDİ — CDX-F1 kapsamı bilerek codex (+claude beyanı) ile sınırlı tutuldu; beyan edilene kadar per-launch efor override\'ı YOKTUR ve motor kendi varsayılanıyla koşar (sessiz kayıp değil, ölçülmemiş kol)',
      images:
        'goose CLI\'da görsel bayrağı YOK (`goose run/session --help` tam seçenek listesinde yok; `-i` INSTRUCTIONS DOSYASIDIR, görsel değil) → görsel yolu claude\'daki gibi prompt METNİNE gömülmeli',
      provider:
        'goose `--provider`ı KENDİ sağlayıcı defterinden seçer (openai/anthropic/claude-code/ollama…); ürünün BYOK grameri (providers.cjs `-c model_provider` + base_url/env_key) codex\'e özgüdür ve goose\'ta dengi ÖLÇÜLMEDİ. Ölçülen anahtarsız yol `auth`/`trust` bloklarında beyanlı',
      subagentBlock:
        'goose\'un alt-ajan yüzeyi `summon` PLATFORM uzantısıdır (ikili: crates/goose/src/agents/platform_extensions/summon.rs — "launches a subagent and returns its result"); per-launch KAPATMA bayrağı YOK — `--no-profile` hepsini (developer dahil) kapatır ve pane\'i işe yaramaz hâle getirir. SERT katman kurulamaz → goose pane\'ine LİDER rolü verilmemeli (ENG-19 ile aynı çizgi)',
      tui:
        'goose TUI hazır/blocker dizeleri GERÇEK PTY\'de ölçüldü ("goose is ready", "Enter to send · Ctrl+J newline", blocker: telemetri onayı) ama regex\'ler tek kaynakta (src/app/lib/paneReadiness.ts) HENÜZ yok; buraya `signalsModule` yazmak var-olmayan sinyalleri VAR göstermek olurdu → ölçüm ENG-13 raporunda, alan null (ENG-10 takip kalemi)',
      hooks:
        'goose hook yüzeyi plugin/ayar dosyasında yaşıyor (ikili: hooks.json + GOOSE_STATUS_HOOK/GOOSE_STOP_HOOK_BLOCK_CAP); per-launch bayrak YOK → ADP-692 tur-başı brifingi goose için KURULAMAZ. Olay adları ölçülmedi, uydurulmaz',
      extraRoots:
        'goose\'ta `--add-dir` dengi YOK (`run`/`session` help tam listesi); ek kökler ancak cwd ya da uzantı üzerinden gelir → ADP-237 hafıza dizini enjeksiyonu bu motorda yapılamaz',
    }),

    partial: Object.freeze({
      identity:
        'env TEK DOSYA yolu taşır (`envTarget:\'file\'`) → copilot\'taki ADDITIVE birleştirme burada YAPILAMAZ: kullanıcı GOOSE_SYSTEM_PROMPT_FILE_PATH\'i kendi doldurmuşsa ürün onu EZER (log\'a yazılır, sessiz değil). RESUME\'da dosyanın yeniden okunduğu ölçülmedi → resumeReinject:false',
      mcp:
        'kayıt ADDITIVE ve per-launch: kullanıcının kendi uzantılarını dışarıda bırakma garantisi YOK (`--strict-mcp-config` dengi yok). Değer bir KOMUT DİZESİDİR → boşluklu yollar tırnaklanmak ZORUNDA (ölçüldü: tırnaksız yol iki argümana bölünür, `droid mcp add` aynı hatayı KENDİ yapıyor)',
      trust:
        'goose\'ta DİZİN güveni kapısı ölçülmedi (yabancı dizinlerde diyalog çıkmadı); bu alan goose\'ta İLK KOŞU kapısını (telemetri onayı) ve sağlayıcı yedeğini taşır. Kullanıcının kendi ayarı varsa dokunulmaz (`preferUser`), ama config.yaml OKUNMADAN yalnız env\'e bakılırsa kullanıcı tercihinin ezilme riski kalır — okuyucu config dosyasını da kontrol eder',
      usage:
        'defter ŞEKLİ ölçüldü (sqlite: sessions + usage_ledger, cost REAL) ama `goose-sessions-sqlite` okuyucusu tokenUsage.LEDGER_READERS\'ta HENÜZ YOK → jeton kartı bugün goose pane\'i için "ölçülemedi" der (ENG-09 takip kalemi)',
      session:
        'oturum ID\'sini goose kendi basar (20260817_5 biçimi); biz ADI basıyoruz (`--name <uuid>`, sqlite\'ta user_set_name=1 ile ölçüldü). Resume ADLA yapılır (`--resume --name <ad>`) ve bu KOMBİNASYON canlı pty\'de ölçülmedi (tek koşuluk oturumda test edilemedi)',
      output:
        '`--output-format` yalnız `goose run` (headless) alt-komutunda geçerlidir; interaktif pane\'de süpervizör JSON okuyamaz. Ayrıca `-q` ŞART: quiet olmadan stdout\'a ASCII banner basılıyor ve JSON.parse patlıyor (ölçüldü)',
      model:
        'model bayrağı ölçüldü (`session --model`) ama ürünün varsayılan sağlayıcı yedeği (claude-code) modeli `trust.entries` üzerinden veriyor; kullanıcının config.yaml\'daki tercihi ile bu yedeğin çakışması yalnız config OKUNARAK çözülür (preferUser)',
      identityEnv:
        'XDG_CONFIG_HOME pane/profil başına AYARLARI ayırır ama sağlayıcı SIRLARI sistem anahtar zincirinde yaşayabilir (GOOSE_DISABLE_KEYRING=1 ile dosyaya düşer) → iki ayrı sağlayıcı hesabı isteniyorsa keyring davranışı ayrıca ölçülmeli',
    }),

    verification: Object.freeze({
      contextScope: Object.freeze({ channel: 'unverified', source: 'TOKEN-BUDGET-01 — bu motorda belge-enjeksiyonunu kapatan bir bayrak ARANMADI/ÖLÇÜLMEDİ; kesim yalnız beyan eden motorda koşar' }),
      effort: Object.freeze({ channel: 'unverified', source: 'CDX-F1: bu motorda efor bayrağı ARANMADI/ölçülmedi (kapsam: codex + claude)' }),
      identity: Object.freeze({ channel: 'measured', source: 'ENG-13-evidence-kablolama/goose-session-pty.txt — GERÇEK pty\'de `goose session`, GOOSE_SYSTEM_PROMPT_FILE_PATH ile kimlik okundu (kod kelimesi cevapta) + sysprompt-probe.json (araçlar korundu → APPEND)' }),
      model: Object.freeze({ channel: 'measured', source: '`goose run/session --help` → --model/--provider; config.yaml anahtar adı = env adı (telemetri onayı config.yaml\'a GOOSE_TELEMETRY_ENABLED diye yazıldı)' }),
      images: Object.freeze({ channel: 'measured', source: '`goose run --help` + `goose session --help` tam seçenek listesi — görsel bayrağı YOK' }),
      provider: Object.freeze({ channel: 'measured', source: '`goose run --help` --provider (kendi sağlayıcı defteri) — ürünün providers.cjs grameriyle eşleşmiyor' }),
      session: Object.freeze({ channel: 'measured', source: 'sessions.db sqlite: `--name eng13ptyprobe` → sessions.name + user_set_name=1 (ENG-13-evidence-kablolama/goose-sqlite-schema.txt)' }),
      subagentBlock: Object.freeze({ channel: 'measured', source: 'ikili dizeleri: platform_extensions/summon.rs "launches a subagent and returns its result" + GOOSE_SUBAGENT_MODEL/PROVIDER/MAX_TURNS — kapatma bayrağı YOK' }),
      trust: Object.freeze({ channel: 'measured', source: 'ENG-13-evidence-kablolama/goose-telemetry-pre.txt — taze config dizininde GOOSE_TELEMETRY_ENABLED=false ile diyalog HİÇ çıkmadı; öncesinde (goose-session-pty.txt) diyalog ilk harfleri YUTTU' }),
      reset: Object.freeze({ channel: 'measured', source: 'ikili dizesi: "/clear" → "Clear the conversation history"' }),
      tui: Object.freeze({ channel: 'unverified', source: 'dizeler gerçek pty\'de görüldü ama paneReadiness.ts\'te regex YOK → alan null (ENG-10 takip)' }),
      mcp: Object.freeze({ channel: 'measured', source: 'ENG-13-evidence-kablolama/goose-ext-space.json — `--with-extension "node \'<boşluklu yol>\'"` ile stdio sunucu bağlandı, araç ÇAĞRILDI, pane env\'i sunucuya MİRAS geçti (ENG12_SECRET cevapta)' }),
      hooks: Object.freeze({ channel: 'unverified', source: 'ikilide hooks.json/GOOSE_STATUS_HOOK dizeleri var ama per-launch yüzey ölçülmedi → null' }),
      extraRoots: Object.freeze({ channel: 'measured', source: '`goose run/session --help` — `--add-dir` dengi YOK' }),
      skillsDir: Object.freeze({ channel: 'measured', source: 'ENG-13-evidence-kablolama/goose-skills-list.txt — workspace kökünde `goose skills list` .claude/skills dosyalarını buldu' }),
      identityEnv: Object.freeze({ channel: 'measured', source: 'ENG-13 Faz 1: `goose info` XDG_CONFIG_HOME/XDG_DATA_HOME/XDG_STATE_HOME ile üç yolu da taşıdı (izole koşu)' }),
      auth: Object.freeze({ channel: 'measured', source: 'ENG-13-evidence-kablolama/goose-doctor-runs-agent.txt — `goose doctor` DURUM sormaz, ajanı koşturur (maliyet); `goose info` yalnız yol basar; giriş komutu YOK' }),
      usage: Object.freeze({ channel: 'measured', source: 'ENG-13-evidence-kablolama/goose-sqlite-schema.txt — sessions(accumulated_*) + usage_ledger(cost REAL, cost_source)' }),
      output: Object.freeze({ channel: 'measured', source: 'ENG-13 Faz 1 goose-mcp.json — `-q --output-format json` SAF JSON; `-q` yokken banner (ölçüldü)' }),
      install: Object.freeze({ channel: 'measured', source: 'ENG-13-evidence/goose-install.sh (440 satır, okundu: CONFIGURE=true interaktif sihirbaz + rc teklifi) + `goose --version` → " 1.46.0" (kimlik YOK → --help kalıbı)' }),
    }),
  }),

  // ───────────────────────────────────────────────────────────────────────────
  // ENG-13 — BEŞİNCİ MOTOR: droid 0.197.0 (Factory AI, Node bundle).
  //
  // 🔴 EREN KARARI (2026-08-18): `FACTORY_API_KEY` GELMEYECEK (Factory $20/ay
  // abonelik istiyor, ödenmeyecek). Bu kayıt bu yüzden "kapılar ÖLÇÜLDÜ, canlı
  // doğrulama ANAHTAR BEKLİYOR" durumundadır ve bunu SESSİZ bırakmaz:
  //   • anahtarsız ölçülebilen her şey ÖLÇÜLDÜ (`--help`, `exec --list-tools`
  //     GERÇEKTEN koştu, `mcp add/list` gerçek dosya yazdı/okudu, auth kapısı
  //     4 ms'de temiz hata verdi),
  //   • ölçülemeyen her şey `partial`/`unsupported` ile ADIYLA beyanlıdır →
  //     rozet "yapabilir" DEMEZ.
  // Bir motoru yarım ölçüp tam yetenekli göstermek, ENG-04'ün kapattığı sessiz
  // yetenek kaybının ta kendisi olurdu.
  droid: Object.freeze({
    id: 'droid',
    label: 'Droid (Factory)',
    bin: 'droid',

    // 🔑 GÜVENLİK KARARI: claude'un `--dangerously-skip-permissions` dengi burada
    // `--skip-permissions-unsafe`tir ve BİLEREK ALINMADI (yardım metni: "Bypass all
    // checks - DANGEROUS", `--auto` ile birleştirilemez). droid'in VARSAYILANI
    // READ-ONLY olduğu için bayraksız pane hiçbir dosya yazamaz → işe yaramaz.
    // Seçilen orta yol `--auto medium`: dosya yazma + paket kurma + YEREL git
    // (commit/checkout) açık; `git push`, `sudo`, prod işlemleri KAPALI (yardım
    // metnindeki tanım). Bu, claude pane'inden DAHA DAR bir yetki yüzeyidir.
    defaultArgs: Object.freeze(['--auto', 'medium']),

    // ENG-20 — BİLİNÇLİ olarak claude paritesinin ALTINDA (yukarıdaki güvenlik kararı).
    autonomy: Object.freeze({
      level: 'partial',
      via: 'argv',
      flags: Object.freeze(['--auto', 'medium']),
      measured: 'ENG-13 ölçümü (droid help): varsayılan READ-ONLY; `--auto low|medium|high` otonomi seviyesi; `--skip-permissions-unsafe` ("Bypass all checks - DANGEROUS") `--auto` ile BİRLEŞTİRİLEMEZ',
      why: 'Tam parite `--skip-permissions-unsafe` demek ve o bayrak `--auto` ile birlikte kullanılamıyor → seçim ikili: ya "hiç kontrol yok" ya da dereceli otonomi. `medium` seçildi: dosya yazma + paket kurma + yerel git AÇIK, `git push`/`sudo`/prod KAPALI. ENG-20 bu kararı DEĞİŞTİRMEZ, yalnız BEYAN eder — droid pane\'i onay sorabilir',
    }),

    // ─── 1. KAPI — KİMLİK: claude PARİTESİ (satır-içi bayrak + dosya taşıyıcısı) ──
    // ÖLÇÜLDÜ (ikili + help): `--append-system-prompt <text>` ve
    // `--append-system-prompt-file <path>` HEM top-level (interaktif pane) HEM
    // `exec` altında var; ikili ikisini bir diziye toplayıp `join` ediyor →
    // saf APPEND, ikisi birlikte kullanılabilir (gemini REPLACE riski YOK).
    // ⚠️ Canlı tur ANAHTAR-BLOKLU: metnin modele ULAŞTIĞI ölçülemedi (bkz. partial).
    identity: Object.freeze({
      kind: 'flag',
      flag: '--append-system-prompt',
      fileFlag: '--append-system-prompt-file',
      position: 'append',
      cap: Object.freeze({ cli: 'CLI_MAX', file: 'FILE_MAX' }),
      resumeReinject: false, // resume'da append'in tekrar uygulandığı ÖLÇÜLMEDİ
      // ENG-17 — kapı `flag` taşıyıcılarına açıldı. droid'in bayrağı ADINDA
      // eklediğini söylüyor (`--append-system-prompt[-file]`) ve ikili iki değeri
      // bir diziye toplayıp `join` ediyor (ENG-13 ölçümü) → ADDITIVE.
      // ⚠️ Metnin MODELE ulaştığı hâlâ ölçülmedi (anahtar duvarı, `partial.identity`).
      replacesSystemPrompt: false,
    }),

    model: null,
    images: null,
    provider: null,

    // OTURUM — oturum kimliğini BİZ BASAMAYIZ: interaktif `droid`de `--session-id`
    // YOK (yalnız `droid exec -s <id>`). Resume VAR: `-r/--resume [sessionId]`
    // (id verilmezse en son değişen oturum) + `--fork <id>`.
    session: Object.freeze({
      mint: null,
      flag: null,
      killSwitchEnv: null,
      resume: Object.freeze({
        form: 'append',
        flag: '--resume',
        idShape: 'sanitized-token',
        lastFallback: Object.freeze(['--resume']),
      }),
    }),

    // TOKEN-BUDGET-01 — BAĞLAM KAPSAMI: bu motorun kendi belge enjeksiyonunu
    // (proje talimatı zinciri + kalıcı hafıza indeksi) ÇALIŞMA ALANIYLA sınırlayan
    // bir taşıyıcı ÖLÇÜLMEDİ. `null` = bugünkü davranış aynen sürer; kesim yalnız
    // beyan eden motorda uygulanır (paneContextScope HEPSİ-YA-HİÇ kuralı).
    contextScope: null,
    subagentBlock: null,
    trust: null,
    reset: null,
    tui: null,

    // ─── 2. KAPI — ARAÇ BAĞLAMA: yalnız KALICI DOSYA (per-launch bayrak YOK) ──
    // ÖLÇÜLDÜ: `droid mcp add` `$FACTORY_HOME/.factory/mcp.json` dosyasına yazıyor
    // (`{mcpServers:{<ad>:{type,command,args,disabled}}}`) ve `droid mcp list` o
    // dosyadan okuyup GERÇEKTEN bağlanmayı deniyor (probe sunucusu "failed" satırı
    // ile listelendi → okuma+bağlanma yolu kanıtlı).
    // 🪤 ÖLÇÜLDÜ: `droid mcp add <ad> node "<boşluklu yol>"` yolu BOŞLUKTAN BÖLÜYOR
    // (args: [".../probe", "mcp.cjs"]) → CrewPane yolları ("CrewPane Apps") bu
    // komutla kaydedilemez; dosya ÜRÜN tarafından yazılmalıdır.
    // 🔴 Bu bir 'config-only' kayıttır: pane-BAŞINA enjeksiyon YOK. Board/delegate
    // MCP'sini kullanıcı düzeyinde yazmak, o server'ı kullanıcının TÜM droid
    // oturumlarına sızdırırdı (delegate = yalnız LİDER yeteneği) → yapılmaz.
    // droid pane'i araçlara ENG-06 köprüsüyle (crewpaneCli) erişir: Tier B.
    mcp: Object.freeze({
      kind: 'config-only',
      flag: null,
      configFile: '$FACTORY_HOME/.factory/mcp.json',
      homeEnv: 'FACTORY_HOME_OVERRIDE',
      envelope: 'mcpServers',
      entryShape: Object.freeze({ type: 'stdio', command: 'command', args: 'args', env: 'env', disabled: 'disabled' }),
      scopes: Object.freeze(['user', 'project']), // `mcp list` çıktısı kapsamı yazıyor ("[user]")
      strictFlag: null,
      envInheritance: null, // ölçülemedi (canlı oturum anahtar-bloklu)
      runtimeSettingsFlag: '--settings', // ŞEMADA mcpServers var; runtime\'da KAYIT ETTİĞİ ölçülmedi
      position: 'append',
    }),

    hooks: null,
    extraRoots: null,

    // ÖLÇÜLDÜ (ikili dizeleri): droid kendi skill dizinini `$FACTORY_HOME/.factory/
    // skills` altında tutar; `--disable-builtin-skills` yalnız Factory'nin GÖMÜLÜ
    // skill'lerini kapatır. `.claude/skills` okuduğu ÖLÇÜLMEDİ (varsayılmaz).
    skillsDir: Object.freeze({
      scope: 'engine-home',
      homeEnv: 'FACTORY_HOME_OVERRIDE',
      homeFallback: '~/',
      segments: Object.freeze(['.factory', 'skills']),
    }),

    // ÖLÇÜLDÜ (Faz 1): `FACTORY_HOME_OVERRIDE` ile izole `.factory` ağacı sıfırdan
    // oluştu → hesap/profil ayrımı bu değişkenle yapılır.
    identityEnv: 'FACTORY_HOME_OVERRIDE',

    auth: Object.freeze({
      label: 'Droid (Factory)',
      accountHint: 'Factory hesabı — ücretli abonelik; API anahtarı app.factory.ai → Settings → API Keys',
      signupUrl: 'https://app.factory.ai/settings/api-keys',
      // ENG-08 enum: CLI\'da giriş ALT-KOMUTU YOK (ölçüldü: komut listesi
      // exec|daemon|search|update|mcp|plugin|computer|help). Abonelik girişi yalnız
      // interaktif TUI içindeki `/login` slash komutuyla yapılır → ürünün
      // BAŞLATABİLECEĞİ tek yol anahtardır. Olmayan bir CLI giriş akışı UYDURULMAZ.
      flow: 'api-key',
      needsCode: false,
      loginArgv: null,
      logoutArgv: null,
      statusArgv: null,
      statusParse: null,
      statusNote:
        'droid 0.197.0\'da hesap DURUMU komutu YOK (komut listesi ölçüldü: exec|daemon|search|update|mcp|plugin|computer|help); giriş/çıkış yalnız interaktif TUI içindeki /login ve /logout slash komutlarıyla yapılır → rozet anahtarın KAYITLI olup olmadığını söyler, motorun onu KABUL ETTİĞİNİ söyleyemez (verified:false). EREN KARARI 2026-08-18: anahtar alınmayacak → canlı doğrulama BEKLEMEDE',
      apiKey: Object.freeze({
        env: 'FACTORY_API_KEY', // ENV ile gider — ARGV\'ye ASLA (ENG-R3 §9.3)
        vaultService: 'droid',
        keyUrl: 'https://app.factory.ai/settings/api-keys',
        keyLabel: 'Factory API anahtarı',
      }),
    }),

    // ─── 4. KAPI — KULLANIM: ŞEKLİ ölçüldü, DEFTERİ ölçülemedi ───────────────
    // `droid exec -o json` çıktısı (auth hatası turunda bile) `usage{input_tokens,
    // output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
    // factory_credits}` taşıyor → birim USD DEĞİL, SATICI KREDİSİ. Pane defterinin
    // ($FACTORY_HOME/.factory/sessions) şekli anahtarsız oluşturulamadığı için
    // ÖLÇÜLMEDİ → kart "bilinmiyor" der, TAHMİN ETMEZ.
    usage: Object.freeze({
      kind: 'none',
      level: 'none',
      reader: null,
      root: '$FACTORY_HOME/.factory/sessions',
      rootEnv: 'FACTORY_HOME_OVERRIDE',
      file: null,
      sessionKey: null,
      accumulation: null,
      dedupeBy: null,
      cost: 'vendor-credits', // `factory_credits` — dolar UYDURULMAZ
      billing: Object.freeze({
        apiKeyEnv: 'FACTORY_API_KEY',
        configFile: null,
        field: null,
        planField: null,
        subscriptionWhen: 'never', // ürünün başlatabildiği tek yol anahtar
        sourceLabel: 'droid exec -o json → usage.factory_credits (birim: satıcı kredisi)',
        overrideOpt: 'factoryHome',
      }),
    }),

    // ─── 3. KAPI — SÜPERVİZÖR OKUMA (headless `exec`) ───────────────────────
    output: Object.freeze({
      kind: 'json',
      flag: '-o',
      // 🔺 DOKÜMAN FARKI (ENG-13 Faz 1): doküman 3 değer diyordu, ikilinin enum\'u 7.
      values: Object.freeze(['text', 'json', 'stream-json', 'stream-jsonrpc', 'acp', 'acp-daemon', 'debug']),
      subcommand: 'exec',
      resultEvent: 'result', // {type:'result', subtype, is_error, session_id, usage{…}}
    }),

    install: Object.freeze({
      label: 'Droid (Factory)',
      // ÖLÇÜLDÜ (script okundu, ENG-13 §5): sürüm SABİTLİ (VER="0.197.0"), sha256
      // doğrular, ~/.local/bin\'e kurar, shell rc\'ye DOKUNMAZ.
      // 🔴 YAN ETKİ: script `pkill -KILL -x droid` çalıştırır → koşan TÜM droid
      // pane\'leri uyarısız ölür. Kurulum kapısı önce koşan süreçleri saymalı.
      command: 'curl -fsSL https://app.factory.ai/cli | sh',
      win32Command: null,
      docsUrl: 'https://docs.factory.ai/cli/getting-started/overview',
      checkHint: 'https://docs.factory.ai/cli/getting-started/overview',
      // 🪤 `droid --version` yalnız "0.197.0" basar (kimlik YOK) → kimlik `--help`
      // başlığından okunur: "Droid - Factory\'s AI coding agent in your terminal".
      verifyArgv: Object.freeze(['--help']),
      verifyPattern: 'factory',
    }),

    // CDX-F1 — efor kolu bu motorda BEYAN EDİLMEDİ (gerekçe: unsupported.effort).
    effort: null,

    unsupported: Object.freeze({
      contextScope:
        'bu motorun kendi belge enjeksiyonunu (proje talimatı zinciri + kalıcı hafıza indeksi) çalışma alanıyla sınırlayan bir taşıyıcı ÖLÇÜLMEDİ — kesim yalnız beyan eden motorda koşar, burada bugünkü davranış aynen sürer (TOKEN-BUDGET-01)',
      effort:
        'efor/akıl-yürütme seviyesi taşıyıcısı BU MOTORDA ÖLÇÜLMEDİ — CDX-F1 kapsamı bilerek codex (+claude beyanı) ile sınırlı tutuldu; beyan edilene kadar per-launch efor override\'ı YOKTUR ve motor kendi varsayılanıyla koşar (sessiz kayıp değil, ölçülmemiş kol)',
      model:
        'interaktif `droid` komutunda MODEL bayrağı YOK (ölçüldü: top-level help; `-m/--model` yalnız `droid exec`te) → pane\'de görev-başına model seçilemez. `--settings` dosyasındaki `model` anahtarı ikilinin şemasında VAR ama runtime\'da uygulandığı ÖLÇÜLMEDİ (anahtar-bloklu) → uydurulmaz',
      images:
        'droid CLI\'da görsel/ek bayrağı YOK (top-level ve `exec` help tam listesi ölçüldü) → görsel yolu metne gömülmeli (claude deseni)',
      provider:
        'droid modelleri Factory\'nin kendi kataloğundan gelir (`--model custom:<ad>` + settings.customModels); ürünün BYOK grameri (providers.cjs base_url/env_key) ile eşleşmiyor ve custom model yolu anahtarsız ÖLÇÜLEMEDİ',
      subagentBlock:
        'alt-ajan aracının ADI ÖLÇÜLDÜ: `task-cli` ("Launch a subagent for a bounded multi-step task" — `droid exec --list-tools` ANAHTARSIZ koştu, 23 araç döndü; ayrıca propose-mission/start-mission-run). AMA interaktif `droid` komutunda `--disabled-tools`/`--restrict-tools` YOK (yalnız `exec`te) → pane\'de SERT blok kurulamaz. `--settings`teki `disabledTools` anahtarı şemada var, runtime etkisi ölçülmedi → droid pane\'ine LİDER rolü VERİLMEMELİ',
      trust:
        'droid\'de dizin-güveni diyaloğunun varlığı interaktif TUI\'de ÖLÇÜLEMEDİ (canlı tur anahtar-bloklu). Ölçülen kapı OTONOMİ seviyesidir: varsayılan READ-ONLY, `--auto low|medium|high`, `--skip-permissions-unsafe` (ürün varsayılanı `--auto medium`, defaultArgs\'ta gerekçeli)',
      reset:
        'droid TUI\'sinde konuşmayı sıfırlayan slash komutu ÖLÇÜLEMEDİ (ikilide yalnız /login, /logout, /help dizeleri bulundu; canlı TUI turu anahtar-bloklu) → pane geri dönüşümünde reset komutu GÖNDERİLMEZ, pane yeniden açılır',
      tui:
        'droid TUI hazır/blocker dizeleri ÖLÇÜLMEDİ (canlı oturum anahtar-bloklu) → çağıran sabit boot bütçesiyle devam etmeli; claude/goose kalıpları droid ekranına UYGULANMAMALI',
      hooks:
        'droid hook yüzeyi ayar dosyasında yaşıyor (ikili: `.factory/hooks` + settings `hooks` anahtarı); per-launch bayrak YOK ve olay adları ölçülmedi → ADP-692 tur-başı brifingi droid için kurulamaz',
      extraRoots:
        'droid\'de `--add-dir` dengi YOK (top-level help tam listesi: yalnız `--cwd` ve `-w/--worktree`) → ADP-237 hafıza dizini enjeksiyonu bu motorda yapılamaz',
    }),

    partial: Object.freeze({
      identity:
        'bayraklar İKİLİDEN ölçüldü (ikisi de var, join ile saf APPEND) ama metnin modele ULAŞTIĞI CANLI olarak doğrulanmadı: `droid exec` anahtar kapısında 4 ms\'de duruyor (FACTORY_API_KEY yok — Eren kararı: alınmayacak). Kimlik turu anahtar gelirse 5 dakikada tamamlanır',
      session:
        'oturum kimliğini BASAMAYIZ (interaktif komutta `--session-id` yok) → resume ve jeton eşlemesi best-effort: `--resume` id\'siz en son oturumu açar. Bir pane\'in kendi oturumunu KESİN bulması ancak `droid exec -s` yolunda mümkün',
      mcp:
        'kayıt yalnız KALICI dosyaya yapılabilir (`$FACTORY_HOME/.factory/mcp.json`) → pane-başına araç enjeksiyonu YOK. Kullanıcı düzeyine yazmak delegate/board server\'ını TÜM droid oturumlarına sızdırırdı; bu yüzden droid pane\'i araçlara ENG-06 köprüsüyle (crewpaneCli) erişir. `--settings` dosyası OKUNUYOR (bozuk JSON\'da "Ignoring malformed settings file" uyarısı ölçüldü) ama mcpServers\'ı runtime\'a kaydettiği doğrulanamadı',
      skillsDir:
        'dizin ikilinin kendi dizelerinden türetildi (`.factory/skills`); GERÇEK bir `skills list` koşusu anahtar-bloklu olduğu için dizinin taranma davranışı (ve `.claude/skills`i okuyup okumadığı) ölçülmedi',
      auth:
        'anahtar KAPISI ölçüldü (geçersiz anahtarla `exec` 4 ms\'de temiz hata verdi, tarayıcı AÇMADI) ama GEÇERLİ anahtarla kabul turu YAPILMADI → rozet "anahtar kayıtlı" der, "motor kabul etti" DEMEZ (verified:false). EREN KARARI: abonelik ödenmeyecek, canlı doğrulama BEKLEMEDE',
      output:
        'çıktı enum\'u ikiliden ölçüldü ve auth-hatası turunda GERÇEK bir `result` zarfı alındı; ama BAŞARILI bir turun olay akışı (stream-json satır şekli, tool olayları) ölçülmedi → süpervizör ayrıştırıcısı yazılmadan önce bir canlı tur gerekir',
      usage:
        '`usage` alanları hata çıktısında bile geldiği için ŞEKLİ kesin (factory_credits dahil) ama pane defteri ölçülemedi → kart "ölçülemedi" der. Birim USD DEĞİL kredi: dolar UYDURULMAMALI',
    }),

    verification: Object.freeze({
      contextScope: Object.freeze({ channel: 'unverified', source: 'TOKEN-BUDGET-01 — bu motorda belge-enjeksiyonunu kapatan bir bayrak ARANMADI/ÖLÇÜLMEDİ; kesim yalnız beyan eden motorda koşar' }),
      effort: Object.freeze({ channel: 'unverified', source: 'CDX-F1: bu motorda efor bayrağı ARANMADI/ölçülmedi (kapsam: codex + claude)' }),
      identity: Object.freeze({ channel: 'measured', source: 'ENG-13-evidence/droid-help.txt + droid-exec-help.txt — --append-system-prompt(-file) hem top-level hem exec; ikili ikisini join ediyor (Faz 1 §2-3)' }),
      model: Object.freeze({ channel: 'measured', source: 'ENG-13-evidence/droid-help.txt — top-level seçenek listesinde model bayrağı YOK (yalnız exec: -m/--model)' }),
      images: Object.freeze({ channel: 'measured', source: 'ENG-13-evidence/droid-help.txt + droid-exec-help.txt — görsel/ek bayrağı YOK' }),
      provider: Object.freeze({ channel: 'measured', source: 'ENG-13-evidence/droid-exec-help.txt — Available Models listesi + `--model custom:<ad>` (Factory kataloğu)' }),
      session: Object.freeze({ channel: 'measured', source: 'ENG-13-evidence/droid-help.txt — -r/--resume [sessionId], --fork; interaktif komutta --session-id YOK' }),
      subagentBlock: Object.freeze({ channel: 'measured', source: 'ENG-13-evidence-kablolama/droid-list-tools.json — `droid exec --list-tools -o json` ANAHTARSIZ koştu: task-cli "Launch a subagent…" (+ propose-mission, start-mission-run)' }),
      trust: Object.freeze({ channel: 'measured', source: 'ENG-13-evidence/droid-exec-help.txt Autonomy Levels bloğu (varsayılan read-only) — dizin güveni diyaloğu ölçülemedi (anahtar-bloklu)' }),
      reset: Object.freeze({ channel: 'unverified', source: 'ikilide yalnız /login,/logout,/help dizeleri; TUI turu anahtar-bloklu → null' }),
      tui: Object.freeze({ channel: 'unverified', source: 'canlı TUI turu YOK (FACTORY_API_KEY alınmayacak — Eren kararı)' }),
      mcp: Object.freeze({ channel: 'measured', source: 'ENG-13-evidence-kablolama/droid-mcp-store.txt — `mcp add` $FACTORY_HOME/.factory/mcp.json yazdı (mcpServers zarfı), `mcp list` okudu ve bağlanmayı DENEDİ; boşluklu yol `mcp add` tarafından BÖLÜNDÜ' }),
      hooks: Object.freeze({ channel: 'unverified', source: 'ikilide .factory/hooks + settings.hooks anahtarı var; per-launch yüzey ve olay adları ölçülmedi → null' }),
      extraRoots: Object.freeze({ channel: 'measured', source: 'ENG-13-evidence/droid-help.txt — --add-dir dengi YOK' }),
      skillsDir: Object.freeze({ channel: 'measured', source: 'ikili dizeleri: `.factory/skills` (+ --disable-builtin-skills bayrağı help\'te)' }),
      identityEnv: Object.freeze({ channel: 'measured', source: 'ENG-13 Faz 1: FACTORY_HOME_OVERRIDE ile izole .factory ağacı sıfırdan oluştu' }),
      auth: Object.freeze({ channel: 'measured', source: 'ENG-13-evidence/droid-e2e.json — geçersiz anahtarla `exec` exit=1, 4 ms, "Authentication failed…"; komut listesinde login/logout YOK (droid-help.txt)' }),
      usage: Object.freeze({ channel: 'measured', source: 'ENG-13-evidence/droid-e2e.json — usage{input,output,cache_read,cache_creation,factory_credits} (hata turunda bile)' }),
      output: Object.freeze({ channel: 'measured', source: 'ENG-13-evidence/droid-exec-help.txt -o enum (7 değer) + droid-e2e.json gerçek `result` zarfı' }),
      install: Object.freeze({ channel: 'measured', source: 'ENG-13-evidence/droid-install.sh (151 satır, sha256 + VER="0.197.0" + `pkill -KILL -x droid`) + `droid --help` başlığı "Droid - Factory\'s AI coding agent"' }),
    }),
  }),

  // ───────────────────────────────────────────────────────────────────────────
  // ENG-14 — ALTINCI MOTOR: gemini 0.55.1 (Google, npm bundle).
  //
  // 🔴 BU KAYIT BİR TUZAĞIN ÜSTÜNE KURULU: gemini'nin pane-başına kimlik taşıyıcısı
  // `GEMINI_SYSTEM_MD` env'idir ve semantiği **REPLACE**'tir — dosya, motorun GÖMÜLÜ
  // sistem prompt'unun YERİNE geçer (kaynak: promptProvider.getCoreSystemPrompt →
  // `basePrompt = fs.readFileSync(systemMdPath)`). ÖLÇÜLDÜ: yalnız kimlik yazılan bir
  // dosyayla efektif prompt 25.073 → 2.126 karaktere düştü (%91,6 KAYIP: Core Mandates,
  // Security and Safety Rules, Tool Usage, Primary Workflows, alt-ajan/skill blokları).
  // claude'daki `--append-system-prompt` DENGİ YOKTUR (yargs seçenek listesi ölçüldü:
  // 38 seçenek, `append-system-prompt`/`system-prompt` YOK) → kimliği eklemenin BAŞKA
  // yolu yok. Bu yüzden descriptor iki yeni BEYAN taşır:
  //   • `identity.replacesSystemPrompt: true` — "bu taşıyıcı gömülü promptu SİLER"
  //   • `identity.basePrompt` — gömülü promptu GERİ KAZANMA reçetesi (aşağıda)
  // Reçetesiz bir REPLACE taşıyıcısı, ENG-04'ün kapattığı "sessiz yetenek kaybı"nın
  // en pahalı hâli olurdu: pane kimliğini alır, güvenlik kurallarını kaybeder.
  gemini: Object.freeze({
    id: 'gemini',
    label: 'Gemini CLI',
    bin: 'gemini',

    // ADR-004 dengi: claude `--dangerously-skip-permissions`, copilot `--allow-all-tools`,
    // gemini `--approval-mode yolo` (help: "yolo (auto-approve all tools)"). `-y` kısayolu
    // AYNI şey; uzun biçim seçildi çünkü değeri argv'de OKUNUR (rozet/log dürüstlüğü).
    // 🪤 `--sandbox` BİLEREK ALINMADI: gemini sandbox'ı Docker/Podman ya da macOS seatbelt
    // ister; yokken pane HİÇ açılmaz. Güven kapısı `trust` bloğunda (env), argv'de değil.
    defaultArgs: Object.freeze(['--approval-mode', 'yolo']),

    // ─── ENG-20 — GEMİNİ TAM-OTOMATİK: KARAR + KANIT ─────────────────────────
    // Eren kararı (2026-08-18): otopilotta onay sorusu akışı kesiyor → gemini de
    // claude paritesinde tam-otomatik. `yolo` ENG-14'te yazılmıştı ama o zaman AÇIK
    // BİR SORU olarak raporlanmıştı (ENG-14 §7-2: "onaylanıyor mu?") — ENG-20 o soruyu
    // KAPATIR: karar ONAYLANDI, alternatif `auto_edit` (yalnız düzenleme otomatik)
    // REDDEDİLDİ (araç çağrısında yine sorardı → aynı kesinti).
    // Kanıt: `gemini --help` → "--approval-mode … yolo (auto-approve all tools)";
    // gerçek pty turunda pane onay diyaloğu ÇIKARMADI (ENG-20 §2).
    // GÜVEN KAPISI (`GEMINI_CLI_TRUST_WORKSPACE=true`, `trust` bloğu) bu kararın
    // AYRILMAZ parçasıdır: güvenilmeyen dizinde gemini headless'ta exit 55 ile DURUR,
    // interaktifte proje agents/hooks/skills'i SESSİZCE düşürür → yolo tek başına
    // tam-otomatik pane vermez. Eren'e açıklandı, KALIYOR.
    autonomy: Object.freeze({
      level: 'full',
      via: 'argv',
      flags: Object.freeze(['--approval-mode', 'yolo']),
      measured: 'gemini 0.55.1 help: "yolo (auto-approve all tools)"; ENG-20 gerçek pty turu: onay/güven diyaloğu YOK, TUI komposere ulaştı',
      why: 'Eren kararı 2026-08-18 (claude paritesi). `--sandbox` alınmadı: Docker/Podman ya da seatbelt ister, yokken pane HİÇ açılmaz. Güven kapısı env\'de (GEMINI_CLI_TRUST_WORKSPACE) — yolo\'nun tamamlayıcısı',
    }),

    // ─── 1. KAPI — KİMLİK: ENV → TEK DOSYA, ama REPLACE ─────────────────────
    identity: Object.freeze({
      kind: 'env-file',
      env: 'GEMINI_SYSTEM_MD',
      envTarget: 'file', // goose sınıfı: env TEK dosya yolu taşır (birleştirme YOK)
      envSeparator: null,
      fileSuffix: '.md',
      fileName: 'crewpane-system.md',
      position: 'append', // kimlik metni TABAN PROMPTUN SONUNA eklenir (aşağıdaki reçete)
      cap: Object.freeze({ cli: null, file: 'FILE_MAX' }),
      resumeReinject: false, // resume'da dosyanın yeniden okunduğu ÖLÇÜLMEDİ
      // 🔴 REPLACE BEYANI — bu bayrak olmadan taşıyıcı sessizce prompt siler.
      replacesSystemPrompt: true,
      // ─── GÖMÜLÜ PROMPTU GERİ KAZANMA REÇETESİ (ÖLÇÜLDÜ, JETON MALİYETİ SIFIR) ───
      // Adımlar (engineBasePrompt.cjs uygular; motor adı geçmez, hepsi BU beyandan):
      //   1. `dumpEnv` ile motoru KENDİ efektif prompt'unu dosyaya YAZDIR.
      //   2. Aynı komutu bir kez de `readEnv=<sentinel>` ile koştur → çıktı
      //      "sentinel + CANLI KUYRUK"tur. Kuyruk = çıktı − sentinel (BAYT ÇIKARMA).
      //   3. TABAN = tam döküm − kuyruk (suffix çıkarma; sezgisel metin kesme YOK).
      //   4. Dosyaya TABAN + "\n\n" + KİMLİK yaz.
      // NEDEN 2. ADIM: `maybeWriteSystemMd(sanitizedPrompt…)` NİHAİ prompt'u yazar ve
      // nihai prompt CLI'ın canlı eklediği kuyruğu (GEMINI.md bağlamı + hook bölümleri)
      // İÇERİR. Ham dökümü geri beslemek onu İKİ KEZ basar ve BAYATLATIR (ölçüldü:
      // "# Contextual Instructions" 2 kez, 25.087 → 27.192). Kuyruk çıkarılınca 1 kez.
      basePrompt: Object.freeze({
        kind: 'self-dump',
        dumpEnv: 'GEMINI_WRITE_SYSTEM_MD',
        readEnv: 'GEMINI_SYSTEM_MD', // sentinel bu env ile verilir (kimlikle AYNI kapı)
        // Prompt İNŞA edilince yazılır; model çağrısından ÖNCE. Kimlik doğrulaması
        // BİLEREK düşürülür (`neutralizeEnv`) → istek modele HİÇ ulaşmaz, JETON YOK.
        probeArgv: Object.freeze(['-p', 'x', '-o', 'text']),
        neutralizeEnv: Object.freeze({ GEMINI_API_KEY: 'crewpane-base-prompt-probe-invalid', GEMINI_DEFAULT_AUTH_TYPE: 'gemini-api-key' }),
        cost: 'auth-rejected', // ÖLÇÜLDÜ: exit 1, döküm YAZILDI, model turu YOK
        timeoutMs: 90000,
        cacheBy: Object.freeze(['version', 'cwd']), // döküm cwd'ye BAĞLI (skills/GEMINI.md)
        // Reçete DÜŞERSE kimlik YAZILMAZ (fail-closed): kimliksiz ama TAM yetenekli bir
        // pane, kimlikli ama güvenlik kurallarını kaybetmiş bir pane'den iyidir. Log'a
        // düşer — sessiz değil.
        onFailure: 'skip-identity',
      }),
    }),

    model: Object.freeze({
      kind: 'flag',
      flag: '--model',
      position: 'append',
      // Model kaynağı: settings.json (`model.name`) — ev dizini GEMINI_CLI_HOME ile
      // taşınır (paths.js: `homedir() = GEMINI_CLI_HOME ?? os.homedir()`, GEMINI_DIR='.gemini').
      detect: Object.freeze({
        kind: 'json-settings',
        env: 'GEMINI_MODEL',
        field: 'model.name',
        files: Object.freeze([
          Object.freeze({ scope: 'engine-home', homeEnv: 'GEMINI_CLI_HOME', segments: Object.freeze(['.gemini', 'settings.json']) }),
          Object.freeze({ scope: 'home', segments: Object.freeze(['.gemini', 'settings.json']) }),
        ]),
      }),
      // TUI banner'ı ölçülmedi → sniffer BEYAN EDİLMEZ (yanlış model yazdırmaktansa hiç).
    }),

    images: null,
    provider: null,

    // OTURUM — kimliği BİZ basarız (`--session-id`, help: "manually provided UUID";
    // yargs `coerce` UUID'yi DOĞRULUYOR → uydurma id reddedilir).
    session: Object.freeze({
      mint: 'uuid',
      flag: '--session-id',
      killSwitchEnv: 'CREWPANE_DISABLE_SESSION_ID',
      resume: Object.freeze({
        form: 'append',
        flag: '--resume',
        // 🪤 ÖLÇÜLDÜ (help): `--resume` "latest" ya da SIRA NUMARASI alır — bizim
        // bastığımız UUID DEĞİL. Yani mint ettiğimiz kimlik resume'da KULLANILAMAZ.
        idShape: 'index-or-latest',
        lastFallback: Object.freeze(['--resume', 'latest']),
      }),
    }),

    // TOKEN-BUDGET-01 — BAĞLAM KAPSAMI: bu motorun kendi belge enjeksiyonunu
    // (proje talimatı zinciri + kalıcı hafıza indeksi) ÇALIŞMA ALANIYLA sınırlayan
    // bir taşıyıcı ÖLÇÜLMEDİ. `null` = bugünkü davranış aynen sürer; kesim yalnız
    // beyan eden motorda uygulanır (paneContextScope HEPSİ-YA-HİÇ kuralı).
    contextScope: null,
    subagentBlock: null,

    // "Güven" kapısı gemini'de SERT: güvenilmeyen dizinde headless koşu exit 55 ile
    // DURUYOR ("not running in a trusted directory"), interaktifte ise proje
    // agents/hooks/skills'i SESSİZCE düşüyor ("Skipping project agents due to
    // untrusted folder" — ölçüldü). Kapatma yolu env: `GEMINI_CLI_TRUST_WORKSPACE=true`
    // (`--skip-trust` bayrağı da var; env seçildi ki argv temiz kalsın ve kullanıcının
    // kendi değeri KAZANSIN).
    trust: Object.freeze({
      kind: 'env-consent',
      write: 'env-only',
      homeScope: 'engine-home',
      homeEnv: 'GEMINI_CLI_HOME',
      homeFallback: Object.freeze(['.gemini']),
      homeSegments: Object.freeze(['.gemini']),
      configFile: null, // güven defteri JSON (trustedFolders.json) — YAML okuyucu ona bakmaz
      pointer: 'GEMINI_CLI_TRUST_WORKSPACE',
      canonicalizeCwd: false,
      preferUser: true,
      entries: Object.freeze([
        Object.freeze({
          env: 'GEMINI_CLI_TRUST_WORKSPACE',
          value: 'true',
          why: 'güvenilmeyen dizinde headless koşu exit 55 ile durur, interaktifte proje agents/hooks/skills SESSİZCE düşer (ikisi de ölçüldü) — claude/codex güven yazımının dengi',
        }),
      ]),
    }),

    reset: '/clear',

    tui: null,

    // ─── 2. KAPI — ARAÇ BAĞLAMA: yalnız CONFIG DOSYASI ──────────────────────
    // ÖLÇÜLDÜ: yargs seçenek listesinde `--mcp-config` dengi YOK; sunucular
    // `<home>/.gemini/settings.json` içindeki `mcpServers` haritasından okunur
    // (kullanıcının gerçek dosyası okundu: aynı şema claude ile birebir).
    // Pane-başına ayrım `GEMINI_CLI_HOME` ile mümkündür ama bugün ÜRÜN YAZMIYOR →
    // `config-only` (droid ile aynı sınıf): rozet board/browser'ı VAR göstermez.
    mcp: Object.freeze({
      kind: 'config-only',
      file: '$GEMINI_CLI_HOME/.gemini/settings.json',
      field: 'mcpServers',
      allowFlag: '--allowed-mcp-server-names', // ölçüldü (help): SEÇER, EKLEMEZ
      envInheritance: true,
      position: null,
    }),

    hooks: null,

    extraRoots: Object.freeze({ flag: '--include-directories', repeat: 'variadic' }),

    skillsDir: Object.freeze({ scope: 'workspace', segments: Object.freeze(['.gemini', 'skills']) }),

    identityEnv: 'GEMINI_CLI_HOME',

    // ─── 4. KAPI — HESAP: 🔴 ENG-22 (2026-08-18) HESAPLA GİRİŞ YOLU UPSTREAM'DE ÖLDÜ
    //
    // VAKA (Eren, ekran görüntülü): `gemini` TUI'da "Sign in with Google" →
    //   "This client is no longer supported for Gemini Code Assist for individuals…
    //    migrate to the Antigravity suite: https://antigravity.google"
    // Mesaj İKİLİDE YOK — SUNUCUDAN gelir (bundle'da o cümle aranıp bulunamadı) ⇒
    // karar Google'ın backend'inde, sürüm yükseltmesiyle geri gelmez.
    //
    // ÜÇ BAĞIMSIZ KANIT (ENG-22-evidence/01-gemini-account-death.md):
    //   ① Diskte: `~/.gemini/google_accounts.json` → {"active":null,"old":["…@gmail.com"]}
    //      (mtime 2026-08-18 21:10) ve `oauth_creds.json` HİÇ OLUŞMADI ⇒ giriş denendi,
    //      kimlik bilgisi ÜRETİLMEDİ.
    //   ② İkilinin KENDİSİ göçü sürüyor: 0.55.1 bundle'ında `antigravityUtils.ts` var
    //      (`ANTIGRAVITY_SH_INSTALL = "curl -fsSL https://antigravity.google/cli/install.sh | bash"`)
    //      ve banner sayacı Antigravity metinli banner'ı KAP DIŞI tutup altına kurulum
    //      komutunu EKLİYOR — yani upstream bu banner'ı sürekli göstermeyi tasarlamış.
    //   ③ Canlı koşu: izole GEMINI_CLI_HOME + `GOOGLE_GENAI_USE_GCA=true` → akış
    //      İNTERAKTİF tarayıcıya gidiyor (`createCodeAssistContentGenerator` →
    //      `initOauthClient`), headless'ta tamamlanamıyor.
    //
    // ⇒ Bugün BİREYSEL kullanıcı için çalışan yol İKİ tane: (a) API anahtarı (aşağıdaki
    // `apiKey` bloğu — Ayarlar'daki kutu), (b) Vertex AI / Google Cloud (Workspace ya da
    // kurumsal hesap; ürün bu yolu SÜRMEZ, kullanıcı env ile kurar). Bu yüzden `flow`
    // 'external'dan 'api-key'e çekildi: 'external' "giriş ürünün DIŞINDA yapılır" der ve
    // kullanıcıyı hâlâ var olan bir hesap yoluna işaret eder — ARTIK YOK. 'api-key' UI'da
    // "Bu motorun abonelikle giriş yolu yok — yalnız kendi API anahtarınla çalışır"
    // cümlesini çizer (EngineAccountsSection, `supportsSubscription===false` dalı).
    // 🔁 GERİ ALINABİLİR: Google bireysel girişi geri açarsa flow 'external'a döner ve
    //    bu blok kanıtıyla birlikte tarihe düşer (ENG-10 disiplini: gerekçesiz rozet yok).
    auth: Object.freeze({
      label: 'Gemini CLI',
      // 🪤 ESKİ METİN "Google hesabınla ücretsiz katman ya da bir Gemini API anahtarı"
      // diyordu — 2026-08-18'den beri YALAN. Yeni metin qwen kaydının desenini izler
      // (kapanan bedava katmanı TARİHİYLE söyler, uydurma bir yol önermez).
      // 🪤 SIRA ÖNEMLİ: kartın meta satırı TEK SATIRA kırpılıyor (ekran görüntüsüyle
      // ölçüldü, ENG-22-screenshots/card-gemini.png) → asıl haber BAŞA yazılır,
      // ayrıntı sona. Uzun cümlenin sonuna gömülen bir "KAPATILDI" kullanıcıya
      // HİÇ görünmezdi.
      accountHint:
        '🔴 "Google hesabıyla giriş" 2026-08-18\'de KAPANDI (Google, Antigravity\'ye taşıdı) — bu motor artık yalnız senin Gemini API anahtarınla çalışır (Google AI Studio). Kurumsal/Workspace hesabı Vertex AI yolunu kullanabilir; ürün o akışı başlatmaz',
      signupUrl: 'https://aistudio.google.com/apikey',
      // ENG-22 — ölçülen tek çalışır bireysel yol: anahtar. Abonelik yolu UYDURULMAZ
      // (schema kuralı: `flow:'api-key'` + `loginArgv:null` ⇒ UI giriş düğmesi çizmez).
      flow: 'api-key',
      needsCode: false,
      loginArgv: null,
      logoutArgv: null,
      statusArgv: null,
      statusParse: null,
      statusNote:
        'gemini 0.55.1\'de hesap DURUMU komutu YOK (komut listesi: mcp/extensions/skills/hooks/gemma — auth/login/logout hiçbiri yok, ölçüldü) → rozet ÜÇÜNCÜ durumu gösterir: BİLİNMİYOR. Anahtar kayıtlıysa "kayıtlı" der, "motor kabul etti" DEMEZ. ENG-22: hesapla giriş yolu upstream\'de kapandığı için bu not artık YALNIZ anahtar durumu içindir',
      apiKey: Object.freeze({
        env: 'GEMINI_API_KEY', // ENV ile gider — ARGV'ye ASLA (ENG-R3 §9.3)
        vaultService: 'crewpane-gemini-api-key',
        keyUrl: 'https://aistudio.google.com/apikey',
        keyLabel: 'Gemini API anahtarı (Google AI Studio)',
        // ENG-20 — bu cümle ARTIK KULLANICI-GÖRÜNÜRDÜR (engineAuth.readStatus →
        // apiKeyNote → Ayarlar'daki anahtar kutusu). Bu yüzden dili geliştirici
        // notundan kullanıcı cümlesine çevrildi; ÖLÇÜM ve motorun kendi İngilizce
        // cümlesi KORUNDU (kanıt gösterilmeden uyarı verilmez).
        note: 'Ücretsiz katmanda GÜNLÜK KOTA var: kota dolunca motor turun ortasında durur ve pane iş yapamaz (motorun kendi cümlesi: "You have exhausted your daily quota on this model", HTTP 429). Ücretli plan ya da Vertex bu sınırı kaldırır. Ölçüm: 2026-08-18.',
      }),
    }),

    // ─── 4. KAPI — KULLANIM ─────────────────────────────────────────────────
    usage: null,

    // ─── 3. KAPI — SÜPERVİZÖR OKUMA (headless) ──────────────────────────────
    output: Object.freeze({
      kind: 'json',
      flag: '--output-format',
      values: Object.freeze(['text', 'json', 'stream-json']),
      quietFlag: null,
      requiresQuiet: false, // ÖLÇÜLDÜ: `-o text` stdout'u TEMİZ (uyarılar stderr'de)
    }),

    install: Object.freeze({
      label: 'Gemini CLI',
      // AYNA: engineInstall.npmUserGlobal('@google/gemini-cli') — ~/.local/bin
      // augmentedPath'te olduğu için `--prefix ~/.local` ŞART (aksi hâlde kurulan
      // ikili PATH'te GÖRÜNMEZ; ENG-12/13 ile aynı kural).
      command: 'npm install -g --prefix ~/.local @google/gemini-cli',
      win32Command: 'npm install -g @google/gemini-cli',
      docsUrl: 'https://geminicli.com/docs/',
      checkHint: 'https://geminicli.com/docs/',
      installsTo: 'npm-global',
      // 🪤 `gemini --version` YALNIZ "0.55.1" basar → ürün KİMLİĞİNİ kanıtlamaz
      // (claude'daki `kimi-code` tuzağının aynısı). Kimlik `--help` başlığından okunur.
      verifyArgv: Object.freeze(['--help']),
      verifyPattern: 'usage:\\s*gemini',
    }),

    // CDX-F1 — efor kolu bu motorda BEYAN EDİLMEDİ (gerekçe: unsupported.effort).
    effort: null,

    unsupported: Object.freeze({
      contextScope:
        'bu motorun kendi belge enjeksiyonunu (proje talimatı zinciri + kalıcı hafıza indeksi) çalışma alanıyla sınırlayan bir taşıyıcı ÖLÇÜLMEDİ — kesim yalnız beyan eden motorda koşar, burada bugünkü davranış aynen sürer (TOKEN-BUDGET-01)',
      effort:
        'efor/akıl-yürütme seviyesi taşıyıcısı BU MOTORDA ÖLÇÜLMEDİ — CDX-F1 kapsamı bilerek codex (+claude beyanı) ile sınırlı tutuldu; beyan edilene kadar per-launch efor override\'ı YOKTUR ve motor kendi varsayılanıyla koşar (sessiz kayıp değil, ölçülmemiş kol)',
      images:
        'gemini CLI\'da görsel bayrağı YOK (yargs seçenek listesi ölçüldü: 38 seçenek, attachment/image/-i görsel dengi yok; `-i` PROMPT-INTERACTIVE\'dir) → görsel yolu claude\'daki gibi prompt METNİNE gömülmeli',
      provider:
        'gemini yalnız Google sağlayıcılarına bağlanır (gemini-api-key / oauth-personal / vertex-ai); ürünün BYOK grameri (providers.cjs `-c model_provider` + base_url/env_key) codex\'e özgüdür ve gemini\'de dengi YOKTUR (GOOGLE_GEMINI_BASE_URL yalnız uç nokta değiştirir, sağlayıcı DEĞİL)',
      subagentBlock:
        'gemini\'nin alt-ajan aracı ÖLÇÜLDÜ (`invoke_agent`, gömülü prompt "# Available Sub-Agents" bölümü: codebase_investigator/cli_help/generalist) ama per-launch KAPATMA yolu ölçülemedi: `--allowed-tools` DEPRECATED, yerine gelen `--policy` motorunun DENY grameri ikilide doğrulanamadı. Uydurma bir politika dosyası yazmak, olmayan bir engeli VAR sanmaktır → gemini pane\'ine LİDER rolü verilmemeli (ENG-19 çizgisi)',
      tui:
        'gemini TUI hazır/blocker dizeleri GERÇEK pane\'de ölçülmedi (bu görevin canlı turları headless `-p` ile koştu); src/app/lib/paneReadiness.ts\'te regex YOK. Var olmayan sinyalleri VAR göstermemek için alan null (ENG-10 takip kalemi)',
      hooks:
        'gemini hook yüzeyi VAR ve ÇALIŞIYOR (kullanıcının settings.json\'undaki SessionStart/BeforeTool kancaları her koşuda stderr\'e düştü — ölçüldü) ama per-launch BAYRAK yok: kancalar yalnız settings.json\'dan gelir → ADP-692 tur-başı brifingi bu motorda argv ile KURULAMAZ',
      usage:
        'gemini headless koşuda jeton defteri YAZMIYOR (ölçüldü: ~/.gemini/history/<proje> dizinleri koşulardan sonra BOŞ kaldı, sessions dosyası oluşmadı) ve `-o json` zarfının stats alanı canlı ölçülemedi (günlük kota tükendi) → kart "ölçülemedi" der, TAHMİN ETMEZ',
    }),

    partial: Object.freeze({
      identity:
        'taşıyıcı REPLACE\'tir: gömülü prompt reçeteyle GERİ KAZANILIYOR (ölçüldü, jeton maliyeti sıfır) ama reçete motorun kendi dökümüne bağlıdır — CLI sürümü döküm biçimini değiştirirse taban yeniden hesaplanır (cache anahtarı `version`+`cwd`). Ayrıca kullanıcı GEMINI_SYSTEM_MD\'yi kendi doldurmuşsa ürün onu EZER (log\'a yazılır) ve resume\'da dosyanın yeniden okunduğu ölçülmedi',
      mcp:
        'sunucular yalnız settings.json\'dan okunur; pane-başına ENJEKSİYON bugün ÜRÜN TARAFINDAN YAPILMIYOR (config-only) → board/browser/integrations araçları gemini pane\'inde YOK sayılır. `--allowed-mcp-server-names` var olan sunucuları SEÇER, yeni sunucu EKLEMEZ (ölçüldü)',
      session:
        'oturum kimliğini BİZ basabiliyoruz (`--session-id <uuid>`, yargs UUID doğruluyor) ama `--resume` UUID KABUL ETMİYOR: "latest" ya da SIRA NUMARASI (ölçüldü) → bastığımız kimlikle resume EDİLEMEZ, yalnız `--resume latest` yedeği çalışır',
      trust:
        'güven env ile veriliyor (`GEMINI_CLI_TRUST_WORKSPACE=true`, ölçüldü); kullanıcının kendi ENV değeri kazanır ama kullanıcının trustedFolders.json defteri OKUNMUYOR (JSON; bugünkü env-consent okuyucusu YAML anahtarı arar) → kullanıcı dizini zaten güvenilir işaretlediyse ürün gereksiz yere env yazar (zararsız, ama beyanlı)',
      output:
        '`--output-format` ölçülmüş seçenek listesinden okundu ve `-o text` gerçek koşuda TEMİZ stdout verdi; `json`/`stream-json` zarfının ŞEKLİ canlı doğrulanamadı (günlük kota tükendi) → süpervizör okuyucusu bu motorda henüz yazılmamalı',
      model:
        'model bayrağı ölçüldü (`-m/--model`, gerçek koşuda `-m gemini-3.6-flash` kabul edildi) ama settings.json\'daki `model.name` alanı BOŞ bir kullanıcıda hiç yazılmıyor → tespit çoğu kurulumda "bilinmiyor"a düşer; ayrıca ölçüldü ki eski model adları 404 döner ("gemini-2.5-flash is no longer available to new users")',
      skillsDir:
        'gemini skill\'leri GÜVEN kapısına bağlı: güvenilmeyen dizinde `gemini skills list` "No skills discovered" dedi ve proje agents/hooks\'u da düştü (ölçüldü) → skill görünürlüğü trust bloğunun ÇALIŞMASINA bağımlıdır, bağımsız değil',
      identityEnv:
        'GEMINI_CLI_HOME ev dizinini komple taşır (paths.js `homedir()` ölçüldü) ama ikilinin İKİ farklı okuma yolu var: paths.js `<GEMINI_CLI_HOME>/.gemini`, gemini.js getMemoryNodeArgs ise `<GEMINI_CLI_HOME>` (\'.gemini\' EKLEMEDEN) → profil ayrımı çoğu yüzeyde çalışır, bellek ayarı okuması sapabilir (yukarı-akım tutarsızlığı, ölçüldü)',
      auth:
        'anahtar yolu ÖLÇÜLDÜ ve CANLI ÇALIŞTI (GEMINI_API_KEY ile gerçek turlar koştu); abonelik/OAuth yolu yalnız interaktif TUI\'de yaşıyor ve CrewPane onu SÜREMEZ → rozet "bilinmiyor" der. Ücretsiz katmanda GÜNLÜK KOTA ölçüldü (429)',
      extraRoots:
        '`--include-directories` yargs listesinde ölçüldü (dizi, virgülle ayrılabilir) ama ek kökün GÜVEN kapısından nasıl geçtiği ölçülmedi: güvenilmeyen ek kök sessizce düşebilir (trust ölçümüyle aynı sınıf)',
    }),

    verification: Object.freeze({
      contextScope: Object.freeze({ channel: 'unverified', source: 'TOKEN-BUDGET-01 — bu motorda belge-enjeksiyonunu kapatan bir bayrak ARANMADI/ÖLÇÜLMEDİ; kesim yalnız beyan eden motorda koşar' }),
      effort: Object.freeze({ channel: 'unverified', source: 'CDX-F1: bu motorda efor bayrağı ARANMADI/ölçülmedi (kapsam: codex + claude)' }),
      identity: Object.freeze({ channel: 'measured', source: 'ENG-14-evidence/gemini-effective-*.md — kimlik-yalnız dosya efektif prompt\'u 25.073→2.126 karaktere düşürdü (REPLACE); reçeteli dosyada "# Core Mandates" 1 kez + kimlik 1 kez + kod kelimesi CEVAPTA (gemini-recipe-live.txt) · kaynak: promptProvider.getCoreSystemPrompt basePrompt=readFileSync' }),
      model: Object.freeze({ channel: 'measured', source: 'gerçek koşu: `-m gemini-3.6-flash` kabul, `-m gemini-2.5-flash` 404 ("no longer available to new users"); settings.json şeması kullanıcının gerçek dosyasından okundu' }),
      images: Object.freeze({ channel: 'measured', source: 'yargs option listesi (gemini-LI2WNAGG.js, 38 seçenek) — görsel/attachment bayrağı YOK' }),
      provider: Object.freeze({ channel: 'measured', source: 'ikili: AuthType enum (gemini-api-key/oauth-personal/vertex-ai) + GOOGLE_GEMINI_BASE_URL yalnız uç nokta' }),
      session: Object.freeze({ channel: 'measured', source: '`gemini --help`: --session-id "manually provided UUID" (yargs coerce doğruluyor) · --resume "latest ya da index" → mint edilen UUID resume\'da kullanılamaz' }),
      subagentBlock: Object.freeze({ channel: 'measured', source: 'ENG-14-evidence/gemini-base-prompt.md "# Available Sub-Agents" (invoke_agent + 3 ajan) · --allowed-tools DEPRECATED, --policy deny grameri doğrulanamadı' }),
      trust: Object.freeze({ channel: 'measured', source: 'ENG-14-evidence/gemini-trust-gate.txt — güvenilmeyen dizinde exit 55 "not running in a trusted directory"; GEMINI_CLI_TRUST_WORKSPACE=true ile exit 0' }),
      reset: Object.freeze({ channel: 'measured', source: 'ikili dizesi: "/clear" → konuşma geçmişini temizler (claude/goose ile aynı)' }),
      tui: Object.freeze({ channel: 'unverified', source: 'gerçek pane\'de ölçülmedi (bu görev headless koştu) → alan null' }),
      mcp: Object.freeze({ channel: 'measured', source: 'kullanıcının ~/.gemini/settings.json dosyası okundu (mcpServers haritası, claude şemasıyla birebir) + yargs listesinde --mcp-config YOK + `gemini mcp list` gerçek sunucuyu "Connected" gösterdi' }),
      hooks: Object.freeze({ channel: 'measured', source: 'her koşuda stderr\'e düşen "Hook system message: …" satırları (kullanıcının settings.json SessionStart kancası) — per-launch bayrak YOK' }),
      extraRoots: Object.freeze({ channel: 'measured', source: '`gemini --help` → --include-directories (array, virgülle ayrılabilir)' }),
      skillsDir: Object.freeze({ channel: 'measured', source: 'ENG-14-evidence/gemini-skills-list.txt — güvenilmeyen dizinde "No skills discovered" + gömülü promptta <available_skills> yalnız BUILTIN iki skill' }),
      identityEnv: Object.freeze({ channel: 'measured', source: 'ikili paths.js: `function homedir() { const envHome = process.env["GEMINI_CLI_HOME"]; if (envHome) return envHome; return os.homedir(); }` + GEMINI_DIR=".gemini"' }),
      auth: Object.freeze({ channel: 'measured', source: 'GEMINI_API_KEY ile GERÇEK turlar koştu (gemini-recipe-live.txt); komut listesinde auth/login YOK; ücretsiz katmanda 429 "exhausted your daily quota" ölçüldü · ENG-22 (2026-08-18): hesapla giriş yolu KAPANDI — ENG-22-evidence/01-gemini-account-death.md (google_accounts.json active:null + oauth_creds.json yok · bundle antigravityUtils.ts göç banner\'ı · GOOGLE_GENAI_USE_GCA canlı koşu interaktif tarayıcıya düştü)' }),
      usage: Object.freeze({ channel: 'measured', source: 'headless koşulardan sonra ~/.gemini/history/<proje> dizinleri BOŞ (defter yazılmıyor) — ölçüldü' }),
      output: Object.freeze({ channel: 'measured', source: '`gemini --help` -o enum (text|json|stream-json) + `-o text` gerçek koşuda temiz stdout' }),
      install: Object.freeze({ channel: 'measured', source: 'kurulu paket: /Users/…/.local/lib/node_modules/@google/gemini-cli (npm global) · `gemini --version` → "0.55.1" (kimlik YOK) → --help kalıbı' }),
    }),
  }),

  // ───────────────────────────────────────────────────────────────────────────
  // ENG-14 — YEDİNCİ MOTOR: qwen 0.21.13 (Qwen Code, gemini-cli çatalı).
  //
  // 🔑 GÖREV VARSAYIMI ÖLÇÜMLE ÇÜRÜDÜ. Görev metni qwen'i gemini ile AYNI kefeye
  // koyuyordu ("QWEN_SYSTEM_MD REPLACE reçetesi"). Env GERÇEKTEN var (ikilide
  // QWEN_SYSTEM_MD + QWEN_WRITE_SYSTEM_MD ölçüldü) AMA qwen çatalı gemini'de
  // OLMAYAN bir bayrak taşıyor: `--append-system-prompt` (help: "Append instructions
  // to the main session system prompt for this run"). CANLI DOĞRULANDI: kimlik kod
  // kelimesi cevaba geldi VE ajan aynı turda dosyayı ARACIYLA okudu → gömülü prompt
  // KORUNUYOR. Yani qwen'de REPLACE tuzağına GİRMEYE GEREK YOK; taşıyıcı claude ile
  // aynı sınıf (`identity.kind:'flag'`). REPLACE yolu `identity.alt`ta beyanlı yaşar.
  //
  // 🔴 AUTH GERÇEĞİ (ikiliden, dokümandan DEĞİL): "Qwen OAuth free tier was
  // discontinued on 2026-04-15. Run /auth to switch to Coding Plan, OpenRouter,
  // Fireworks AI, or another provider." → bedava katman KAPALI; kullanıcıya
  // "abonelik/anahtar gerekiyor" DÜRÜSTÇE söylenir, olmayan bedava yol vaat edilmez.
  qwen: Object.freeze({
    id: 'qwen',
    label: 'Qwen Code',
    bin: 'qwen',

    // ADR-004 dengi: `--approval-mode yolo` (choices ölçüldü: plan|default|auto-edit|auto|yolo).
    // `-y/--yolo` AYNI şey; uzun biçim argv'de OKUNUR.
    // 🪤 `--auth-type` defaultArgs'a KOYULMADI: hesabı ÜRÜN seçmez. Non-interaktif
    // koşuda motor "No auth type is selected" ile durur (ölçüldü) — bu bir HATA değil,
    // kullanıcının hesap seçimini isteyen dürüst kapıdır (Ayarlar/auth bloğu taşır).
    defaultArgs: Object.freeze(['--approval-mode', 'yolo']),

    // ENG-20 — qwen gemini çatalıdır, aynı gramer (`--approval-mode yolo`); karar aynı.
    autonomy: Object.freeze({
      level: 'full',
      via: 'argv',
      flags: Object.freeze(['--approval-mode', 'yolo']),
      measured: 'qwen 0.21.13 (gemini çatalı) aynı `--approval-mode` gramerini taşır; ENG-14 canlı turu argv\'yi reddetmedi',
      why: 'Eren kararı 2026-08-18 — tüm motorlarda claude paritesi',
    }),

    // ─── 1. KAPI — KİMLİK: BAYRAK (APPEND) — claude paritesi ────────────────
    identity: Object.freeze({
      kind: 'flag',
      flag: '--append-system-prompt',
      position: 'append',
      cap: Object.freeze({ cli: 'CLI_MAX', file: null }),
      resumeReinject: false, // resume'da bayrağın yeniden verilip verilmediği ölçülmedi
      replacesSystemPrompt: false, // ÖLÇÜLDÜ: gömülü prompt KORUNUYOR (araç kullanımı sürdü)
      // Ölçülmüş İKİNCİ yol: `QWEN_SYSTEM_MD` (env→dosya) ve `--system-prompt` (argv).
      // İKİSİ DE REPLACE'tir (ikili: aynı promptProvider çatalı) → BİRİNCİL YOL DEĞİL.
      // Burada BEYAN olarak yaşar: bir gün append bayrağı kalkarsa reçete gemini'nin
      // `identity.basePrompt` bloğuyla BİREBİR aynı şekilde kurulur (qwen dökümünde
      // canlı kuyruk BOŞ ölçüldü → çıkarma no-op, algoritma aynı).
      alt: Object.freeze({
        kind: 'env-file',
        env: 'QWEN_SYSTEM_MD',
        envTarget: 'file',
        dumpEnv: 'QWEN_WRITE_SYSTEM_MD',
        replacesSystemPrompt: true,
        flag: '--system-prompt',
      }),
    }),

    model: Object.freeze({
      kind: 'flag',
      flag: '--model',
      position: 'append',
      detect: Object.freeze({
        kind: 'json-settings',
        env: 'QWEN_MODEL',
        field: 'model.name',
        files: Object.freeze([
          Object.freeze({ scope: 'engine-home', homeEnv: 'QWEN_HOME', segments: Object.freeze(['settings.json']) }),
          Object.freeze({ scope: 'home', segments: Object.freeze(['.qwen', 'settings.json']) }),
        ]),
      }),
    }),

    images: null,
    provider: null,

    // OTURUM — TAM parite: kimliği BİZ basarız VE resume AYNI kimlikle yapılır
    // (gemini'nin index tuzağı burada YOK).
    session: Object.freeze({
      mint: 'uuid',
      flag: '--session-id',
      killSwitchEnv: 'CREWPANE_DISABLE_SESSION_ID',
      resume: Object.freeze({
        form: 'append',
        flag: '--resume',
        idShape: 'uuid',
        lastFallback: Object.freeze(['--continue']),
      }),
    }),

    // 🔑 SERT ALT-AJAN BLOĞU VAR (goose/droid/copilot'ta YOKTU). ÖLÇÜLDÜ (canlı):
    // `--exclude-tools read_file,agent` → motor "Matching deny rule: read_file" dedi
    // ve "Tanımlı araçlarım arasında `agent` adlı bir araç bulunmuyor" cevabını verdi.
    // Aracın kanonik adı ikilide: `agent` ("Legacy aliases … renamed from task").
    // TOKEN-BUDGET-01 — BAĞLAM KAPSAMI: bu motorun kendi belge enjeksiyonunu
    // (proje talimatı zinciri + kalıcı hafıza indeksi) ÇALIŞMA ALANIYLA sınırlayan
    // bir taşıyıcı ÖLÇÜLMEDİ. `null` = bugünkü davranış aynen sürer; kesim yalnız
    // beyan eden motorda uygulanır (paneContextScope HEPSİ-YA-HİÇ kuralı).
    contextScope: null,
    subagentBlock: Object.freeze({
      args: Object.freeze(['--exclude-tools', 'agent']),
      position: 'append',
      dedupeToken: '--exclude-tools',
    }),

    trust: null,

    reset: '/clear',

    tui: null,

    // ─── 2. KAPI — ARAÇ BAĞLAMA: per-launch CONFIG (claude paritesi) ────────
    // ÖLÇÜLDÜ (yargs): `--mcp-config` "JSON string or file path … {"mcpServers": {...}}"
    // → claude'un `--mcp-config`i ile AYNI gramer. `--strict-mcp-config` dengi YOK
    // (kullanıcının kendi sunucuları dışarıda bırakılamaz) → partial.
    mcp: Object.freeze({
      kind: 'config-file',
      flag: '--mcp-config',
      strictFlag: null,
      allowFlag: '--allowed-mcp-server-names',
      envInheritance: true,
      position: 'append',
    }),

    hooks: null,

    extraRoots: Object.freeze({ flag: '--include-directories', repeat: 'variadic' }),

    skillsDir: Object.freeze({ scope: 'workspace', segments: Object.freeze(['.qwen', 'skills']) }),

    identityEnv: 'QWEN_HOME',

    auth: Object.freeze({
      label: 'Qwen Code',
      // 🔴 DÜRÜSTLÜK KAPISI: bedava yol KAPANDI, bunu kullanıcıya SÖYLE.
      accountHint: 'Qwen Coding Plan aboneliği ya da bir API anahtarı (OpenAI-uyumlu / DashScope / Anthropic / Gemini) — Qwen OAuth BEDAVA katmanı 2026-04-15\'te KAPANDI',
      signupUrl: 'https://bailian.console.aliyun.com/',
      flow: 'external', // hesap seçimi interaktif TUI'de (`/auth`); `qwen auth` komutu KALDIRILDI
      needsCode: false,
      loginArgv: null,
      logoutArgv: null,
      statusArgv: null,
      statusParse: null,
      statusNote:
        'qwen 0.21.13\'te hesap DURUMU komutu YOK: `qwen auth` alt-komutu "(removed)" diye duruyor ve yalnız telemetri bayraklarını taşıyor (ölçüldü) → rozet ÜÇÜNCÜ durumu gösterir: BİLİNMİYOR. Ayrıca ikilinin kendi uyarısı: "Qwen OAuth free tier was discontinued on 2026-04-15. Run /auth to switch to Coding Plan, OpenRouter, Fireworks AI, or another provider."',
      apiKey: Object.freeze({
        env: 'OPENAI_API_KEY', // ENV ile gider — ARGV'ye ASLA (ENG-R3 §9.3)
        vaultService: 'crewpane-qwen-api-key',
        keyUrl: 'https://bailian.console.aliyun.com/',
        keyLabel: 'OpenAI-uyumlu API anahtarı (Qwen/DashScope/OpenRouter…)',
        baseUrlEnv: 'OPENAI_BASE_URL',
        authTypeFlag: '--auth-type', // choices ÖLÇÜLDÜ: openai|anthropic|qwen-oauth|gemini|vertex-ai
        note: 'ÖLÇÜLDÜ: OpenAI-uyumlu uç nokta ile koşuyor (`--auth-type openai` + OPENAI_BASE_URL); ayrıca `--auth-type gemini` ile GEMINI_API_KEY üzerinden gerçek tur atıldı. 🪤 Groq bedava katmanı YETMEZ: qwen\'in tek turu ~25-31k jeton ister, Groq on-demand TPM sınırı 8.000 → 413',
      }),
    }),

    // ─── 4. KAPI — KULLANIM: JSONL oturum defteri (KESİN eşleşme) ───────────
    // ÖLÇÜLDÜ (gerçek dosya): ~/.qwen/usage_record.jsonl satırı
    // {version, sessionId, timestamp, project, durationMs, models:{<model>:{requests,
    //  inputTokens,outputTokens,cachedTokens,thoughtsTokens,totalTokens}}, tools:{…}}
    // Oturum kimliğini BİZ bastığımız için (`--session-id`) satır KESİN bulunur.
    usage: Object.freeze({
      kind: 'session-ledger',
      level: 'exact',
      content: 'counters', // 🔑 ENG-14 ÖLÇÜMÜ: JSONL + oturum eşleşmesi KESİN ama satırlar SAYAÇ (mesaj/araç GÖVDESİ yok) → teslim doğrulaması buradan yapılamaz
      reader: 'qwen-usage-jsonl', // tokenUsage.LEDGER_READERS'ta HENÜZ YOK (ENG-09 takibi)
      format: 'jsonl',
      root: '$QWEN_HOME',
      rootEnv: 'QWEN_HOME',
      file: 'usage_record.jsonl',
      sessionKey: 'minted-uuid',
      accumulation: 'per-line',
      dedupeBy: null,
      cost: null, // 🪤 defterde JETON var, DOLAR YOK → maliyet UYDURULMAZ
      billing: Object.freeze({
        apiKeyEnv: 'OPENAI_API_KEY',
        configFile: '$QWEN_HOME/settings.json',
        field: 'security.auth.selectedType',
        planField: null,
        subscriptionWhen: 'equals:qwen-oauth',
        sourceLabel: 'usage_record.jsonl (jeton) · sağlayıcı = --auth-type / settings.security.auth',
        overrideOpt: 'qwenHome',
      }),
    }),

    output: Object.freeze({
      kind: 'json',
      flag: '--output-format',
      values: Object.freeze(['text', 'json', 'stream-json']),
      quietFlag: null,
      requiresQuiet: false, // ÖLÇÜLDÜ: `-o text` stdout TEMİZ (uyarılar stderr\'de)
    }),

    install: Object.freeze({
      label: 'Qwen Code',
      // AYNA: engineInstall.npmUserGlobal('@qwen-code/qwen-code')
      command: 'npm install -g --prefix ~/.local @qwen-code/qwen-code',
      win32Command: 'npm install -g @qwen-code/qwen-code',
      docsUrl: 'https://github.com/QwenLM/qwen-code',
      checkHint: 'https://github.com/QwenLM/qwen-code',
      installsTo: 'npm-global',
      verifyArgv: Object.freeze(['--help']),
      verifyPattern: 'usage:\\s*qwen',
    }),

    // CDX-F1 — efor kolu bu motorda BEYAN EDİLMEDİ (gerekçe: unsupported.effort).
    effort: null,

    unsupported: Object.freeze({
      contextScope:
        'bu motorun kendi belge enjeksiyonunu (proje talimatı zinciri + kalıcı hafıza indeksi) çalışma alanıyla sınırlayan bir taşıyıcı ÖLÇÜLMEDİ — kesim yalnız beyan eden motorda koşar, burada bugünkü davranış aynen sürer (TOKEN-BUDGET-01)',
      effort:
        'efor/akıl-yürütme seviyesi taşıyıcısı BU MOTORDA ÖLÇÜLMEDİ — CDX-F1 kapsamı bilerek codex (+claude beyanı) ile sınırlı tutuldu; beyan edilene kadar per-launch efor override\'ı YOKTUR ve motor kendi varsayılanıyla koşar (sessiz kayıp değil, ölçülmemiş kol)',
      images:
        'qwen yargs seçenek listesinde (61 seçenek, ikiliden ölçüldü) görsel/attachment bayrağı YOK → görsel yolu claude\'daki gibi prompt METNİNE gömülmeli',
      provider:
        'qwen\'in sağlayıcı seçimi `--auth-type` + OPENAI_BASE_URL/OPENAI_API_KEY ile yapılır; ürünün BYOK grameri (providers.cjs `-c model_provider` + wire_api) codex\'e özgüdür ve qwen\'de dengi ÖLÇÜLMEDİ. Anahtar yolu `auth.apiKey` bloğunda beyanlı (bu görevde providers.cjs\'e DOKUNULMADI — paralel worker sahası)',
      trust:
        'qwen\'de dizin GÜVENİ kapısı ÖLÇÜLMEDİ: gemini\'nin "not running in a trusted directory" hatası (exit 55) qwen\'de taze dizinlerde HİÇ çıkmadı, koşular doğrudan başladı. Var olmayan bir kapıya yazıcı bağlamak, olmayan bir korumayı VAR sanmaktır → alan null',
      hooks:
        'qwen hook yüzeyi VAR (`qwen hooks` alt-komutu + --safe-mode açıklaması hook\'ları sayıyor) ama per-launch BAYRAK yok: kancalar settings.json\'dan gelir → ADP-692 tur-başı brifingi bu motorda argv ile KURULAMAZ',
      tui:
        'qwen TUI hazır/blocker dizeleri gerçek pane\'de ölçülmedi (bu görev headless `-p` ile koştu); paneReadiness.ts\'te regex YOK → alan null (ENG-10 takip kalemi)',
    }),

    partial: Object.freeze({
      identity:
        'append bayrağı CANLI doğrulandı (kod kelimesi cevapta + aynı turda araçla dosya okundu) ama metin ARGV\'den gider → CLI_MAX (8.000) duvarı geçerlidir ve dosya taşıyıcısı (claude\'un --append-system-prompt-file dengi) YOKTUR. Uzun kimlik+hafıza kompozisyonu bu motorda KIRPILIR',
      mcp:
        '`--mcp-config` per-launch ve claude grameriyle aynı (JSON dize ya da dosya yolu, yargs\'tan ölçüldü) ama `--strict-mcp-config` DENGİ YOK → kullanıcının kendi sunucuları dışarıda bırakılamaz (codex ile aynı ADDITIVE sınırı). Ayrıca gerçek bir stdio sunucusunun BAĞLANDIĞI bu görevde canlı doğrulanmadı',
      session:
        'mint + resume TAM parite (`--session-id <uuid>` / `--resume <id>` / `--continue`) ama resume turunda kimliğin geri gelip gelmediği ölçülmedi (`--append-system-prompt` PER-LAUNCH\'tır — ADP-276 sınıfı risk)',
      subagentBlock:
        'blok CANLI ölçüldü ama araç adıyla: `--exclude-tools agent` (ikilideki kanonik ad; "task"/"Task" alias\'ları buna çözülüyor). Alias tablosunun --exclude-tools yolunda da uygulandığı DOLAYLI ölçüldü (deny kuralı `read_file` için birebir çalıştı); alias\'la (task) yazılan bir engelin de tutacağı VARSAYIM DEĞİL, ölçülmedi → ürün KANONİK adı yazar',
      usage:
        'defter GERÇEK dosyadan ölçüldü (usage_record.jsonl: sessionId + models{} jeton kırılımı) ama `qwen-usage-jsonl` okuyucusu tokenUsage.LEDGER_READERS\'ta HENÜZ YOK → jeton kartı bugün qwen pane\'i için "ölçülemedi" der (ENG-09 takip kalemi). Defterde DOLAR alanı hiç yok → maliyet bu motorda gösterilemez',
      output:
        '`--output-format` yargs\'tan ölçüldü ve `-o text` gerçek koşuda temiz stdout verdi; `json`/`stream-json` zarfının ŞEKLİ ölçülmedi → süpervizör okuyucusu bu motorda henüz yazılmamalı',
      model:
        'model bayrağı CANLI çalıştı (`-m gemini-3.5-flash-lite` ile gerçek tur) ama VARSAYILAN model sağlayıcıya bağlı ve ölçüldü ki anahtar/sağlayıcı uyuşmazlığında motor kendi varsayılanını deniyor ("models/coder-model is not found" 404) → kart modeli ayardan okurken bu tuzağı bilmeli',
      auth:
        'anahtar yolu CANLI koştu (`--auth-type gemini` + GEMINI_API_KEY, ayrıca `--auth-type openai` + OPENAI_BASE_URL yolu ölçüldü) ama Qwen\'in KENDİ Coding Plan aboneliği ÖLÇÜLMEDİ (abonelik yok). Bedava OAuth katmanı ikilinin kendi mesajıyla KAPALI (2026-04-15) → ürün bunu Ayarlar\'da dürüstçe yazar',
      skillsDir:
        '`~/.qwen/skills` dizini gerçek kurulumda VAR (ölçüldü) ve `--safe-mode` açıklaması skill\'leri sayıyor; PROJE dizini (`.qwen/skills`) tarandığı ise ölçülmedi → skill görünürlüğü claude/goose\'daki gibi kanıtlanmış değil',
      identityEnv:
        'QWEN_HOME ikilide 30 yerde geçiyor ve gerçek ev dizini ~/.qwen ölçüldü (usage/skills/projects alt dizinleriyle) ama pane-başına AYRI profil koşusu bu görevde denenmedi → izolasyon beyanı kaynak seviyesinde',
      extraRoots:
        '`--include-directories` (alias `--add-dir`) yargs\'tan ölçüldü ama ek kökün gerçek koşuda okunduğu doğrulanmadı',
    }),

    verification: Object.freeze({
      contextScope: Object.freeze({ channel: 'unverified', source: 'TOKEN-BUDGET-01 — bu motorda belge-enjeksiyonunu kapatan bir bayrak ARANMADI/ÖLÇÜLMEDİ; kesim yalnız beyan eden motorda koşar' }),
      effort: Object.freeze({ channel: 'unverified', source: 'CDX-F1: bu motorda efor bayrağı ARANMADI/ölçülmedi (kapsam: codex + claude)' }),
      identity: Object.freeze({ channel: 'measured', source: 'ENG-14-evidence/qwen-append-live.txt — `--append-system-prompt` ile kod kelimesi CEVAPTA + AYNI turda read_file ile dosya okundu (gömülü prompt korunuyor) · REPLACE yolu: ikilide QWEN_SYSTEM_MD/QWEN_WRITE_SYSTEM_MD ölçüldü' }),
      model: Object.freeze({ channel: 'measured', source: 'gerçek koşu `-m gemini-3.5-flash-lite` (exit 0); varsayılan model uyuşmazlığı 404 "models/coder-model is not found" ile ölçüldü' }),
      images: Object.freeze({ channel: 'measured', source: 'ikiliden çıkarılan yargs option listesi (chunk-IGGGG5CX.js, 61 seçenek) — görsel bayrağı YOK' }),
      provider: Object.freeze({ channel: 'measured', source: 'yargs: --auth-type choices [openai|anthropic|qwen-oauth|gemini|vertex-ai] + --openai-base-url/--openai-api-key; codex `-c model_provider` grameri YOK' }),
      session: Object.freeze({ channel: 'measured', source: 'yargs: --session-id "Specify a session ID for this run" · --resume "<id>" · --continue · --fork-session' }),
      subagentBlock: Object.freeze({ channel: 'measured', source: 'ENG-14-evidence/qwen-exclude-tools-live.txt — "Matching deny rule: read_file" + "Tanımlı araçlarım arasında `agent` adlı bir araç bulunmuyor" (canlı) · kanonik ad ikilide: task/Task → "agent"' }),
      trust: Object.freeze({ channel: 'unverified', source: 'taze dizinlerde güven diyaloğu/hatası HİÇ görülmedi; kapının varlığı doğrulanamadı → alan null' }),
      reset: Object.freeze({ channel: 'measured', source: 'ikili dizesi "/clear" (gemini-cli çatalı, aynı slash komut seti)' }),
      tui: Object.freeze({ channel: 'unverified', source: 'gerçek pane\'de ölçülmedi → alan null' }),
      mcp: Object.freeze({ channel: 'measured', source: 'yargs: --mcp-config "JSON string or file path … {\\"mcpServers\\": {…}}" + `qwen mcp list/add/reconnect/approve` alt-komutları' }),
      hooks: Object.freeze({ channel: 'measured', source: '`qwen hooks` alt-komutu + --safe-mode açıklaması ("hooks, extensions, skills, MCP servers") — per-launch bayrak YOK' }),
      extraRoots: Object.freeze({ channel: 'measured', source: 'yargs: --include-directories (alias --add-dir, array)' }),
      skillsDir: Object.freeze({ channel: 'measured', source: 'gerçek kurulum: ~/.qwen/skills dizini mevcut (ls ile ölçüldü) + --safe-mode skill\'leri sayıyor' }),
      identityEnv: Object.freeze({ channel: 'measured', source: 'ikilide QWEN_HOME 30 kez + gerçek ~/.qwen ağacı (extensions/memories/projects/skills/usage) ölçüldü' }),
      auth: Object.freeze({ channel: 'measured', source: 'ikili dizesi: "Qwen OAuth free tier was discontinued on 2026-04-15. Run /auth to switch to Coding Plan, OpenRouter, Fireworks AI, or another provider." + `qwen auth --help` → "Configure authentication (removed)" + "No auth type is selected" hatası (ölçüldü)' }),
      usage: Object.freeze({ channel: 'measured', source: 'ENG-14-evidence/qwen-usage-record-line.json — gerçek ~/.qwen/usage_record.jsonl satırı (sessionId + models{inputTokens/outputTokens/cachedTokens/totalTokens} + tools{})' }),
      output: Object.freeze({ channel: 'measured', source: 'yargs -o enum (text|json|stream-json) + `-o text` gerçek koşuda temiz stdout' }),
      install: Object.freeze({ channel: 'measured', source: 'kurulu paket: /Users/…/.local/lib/node_modules/@qwen-code/qwen-code (npm global, cli-entry.js sembolik bağı) · `qwen --version` → "0.21.13" (kimlik YOK) → --help kalıbı' }),
    }),
  }),
  // ═══════════════════════════════════════════════════════════════════════════
  // ENG-16 — OPENCODE 1.18.18 (8. motor)
  //
  // 🔴 ÜRÜN KARARI (Eren, 2026-08-18): bu motor ürüne **`vendor-hosted` ROZETİYLE**
  // girer. Kimliksiz koşuda kod SATICININ sunucusuna gider (`opencode/big-pickle`,
  // `cost:0`) ve bu kullanıcıya AÇIKÇA yazılır. İleride "yalnız kendi anahtarım"
  // KİLİDİ eklenecek; bugünkü karşılığı `usage.billing.vendorHosted.policy`
  // ayarıdır ('allow' varsayılan · 'block' bedava kapıyı kapatır). Bkz. engineBilling.cjs.
  //
  // ÜÇ KAPI ÖZETİ (hepsi bu turda ÖLÇÜLDÜ, kanıt: docs/agent-results/ENG-16-evidence/):
  //   1. KİMLİK → `OPENCODE_CONFIG_CONTENT` içindeki JSON belgenin `instructions[]`
  //      alanı. ADDITIVE (8.164 → 8.248 jeton). Aynı motorun `agent.<ad>.prompt`
  //      alanı REPLACE'tir (8.164 → 6.399) → BİLEREK KULLANILMIYOR.
  //   2. ARAÇ → aynı belgenin `mcp` alanı (`opencode mcp list` → "connected", ölçüldü)
  //   3. SÜPERVİZÖR → `run --format json` olay akışı (`step_finish.tokens` + `cost`)
  opencode: Object.freeze({
    id: 'opencode',
    label: 'OpenCode',
    bin: 'opencode',

    // ADR-004 dengi: `--auto` ("auto-approve permissions that are not explicitly
    // denied (dangerous!)"). ÖLÇÜLDÜ: bayraksız koşuda dosya okuyan bir tur onay
    // beklerken ASILI KALDI (2 dakika, hiç çıktı yok) — otopilotta pane'i kilitler.
    defaultArgs: Object.freeze(['--auto']),

    autonomy: Object.freeze({
      level: 'full',
      via: 'argv',
      flags: Object.freeze(['--auto']),
      measured:
        'ENG-16: bayraksız `opencode run` dosya okuma turunda ONAY BEKLERKEN ASILI KALDI (120 sn, sıfır çıktı); `--auto` ile aynı tur exit 0 ve dosya araçla okundu (ENG-16-evidence/opencode-identity-live.txt)',
      why: 'Eren kararı 2026-08-18 — tüm motorlarda claude paritesi',
    }),

    // ─── 1. KAPI — KİMLİK: ENV İÇİNDEKİ JSON CONFIG BELGESİ ────────────────
    // 🔑 Neden dosya değil ENV: opencode config'i pane başına ayırmanın DİSKE
    // yazmayan yolu budur (`OPENCODE_CONFIG_CONTENT`). Diske yazan her yol (proje
    // `.opencode/`, `~/.config/opencode/opencode.jsonc`) İKİ pane arasında YARIŞ
    // demektir — ENG-R2 §6.2-5'in tam olarak sorduğu soru.
    identity: Object.freeze({
      kind: 'env-file',
      env: 'OPENCODE_CONFIG_CONTENT',
      envTarget: 'json-config',
      configPath: 'instructions[]', // kimlik DOSYASININ YOLU bu diziye eklenir
      // Belgenin TABANI: şema + SERT alt-ajan bloğu (aşağıdaki `subagentBlock`
      // alanının GERÇEK taşıyıcısı — argv'de böyle bir bayrak YOK).
      configBase: Object.freeze({
        $schema: 'https://opencode.ai/config.json',
        tools: Object.freeze({ task: false }),
      }),
      fileName: 'crewpane-identity.md',
      fileSuffix: '.md',
      position: 'append',
      cap: Object.freeze({ cli: null, file: 'FILE_MAX' }),
      resumeReinject: true, // taşıyıcı ENV'dir, konuşmaya GÖRÜNMEZ → her koşuda yeniden verilir
      // 🔑 ÖLÇÜLDÜ: `instructions[]` gömülü prompt'u KORUYARAK ekler (8.164→8.248).
      replacesSystemPrompt: false,
      // 🪤 ÖLÇÜLEN İKİNCİ YOL — `agent.<ad>.prompt` REPLACE'tir (8.164→6.399 jeton;
      // +3.081 karakterlik prompt +405 jeton getirdi ⇒ fark taban prompt'un
      // KAYBIdır). Kimlik oraya yazılsaydı motorun gömülü kuralları silinirdi.
      // Burada BEYAN olarak yaşar ki bir gün `instructions` kalkarsa reçete
      // gemini'nin `basePrompt` bloğuyla aynı disiplinle kurulsun.
      alt: Object.freeze({
        kind: 'env-file',
        env: 'OPENCODE_CONFIG_CONTENT',
        configPath: 'agent.crewpane.prompt',
        replacesSystemPrompt: true,
        flag: '--agent',
      }),
    }),

    model: Object.freeze({
      kind: 'flag',
      flag: '--model', // değer ŞEKLİ `provider/model` (ölçüldü: `opencode models` çıktısı)
      position: 'append',
      // Varsayılan model config'ten okunur ama config bizim ürettiğimiz ENV belgesidir
      // → ayrı bir dosya probu YANLIŞ cevap verirdi; tespit YOK, beyan var.
      // ENG-OPENCODE-PROVIDER-01 — DEĞER BİÇİMİ BEYANI. `sanitizeModel`in varsayılan
      // kuralı `/` ve `:` kabul etmez (claude/codex tek-token adları); bu motorda değer
      // `provider/model`dir ve model kısmı `:` taşıyabilir (`gx10/qwen3-coder:30b`,
      // Ollama etiketi). Beyan olmasaydı `--model` SESSİZCE düşer, motor VARSAYILAN
      // sağlayıcıya koşardı — tam da §6-B'nin kapattığı sınıf. Tek eğik çizgi, `..` yok.
      valuePattern: '^[A-Za-z0-9][A-Za-z0-9._-]*\\/[A-Za-z0-9][A-Za-z0-9._:-]*$',
    }),

    // ENG-OPENCODE-PROVIDER-01 (OC-DESIGN-0919 §5(f)-F1, §6-B kapı 1, §11 karar 1) —
    // MODEL ÖN-DOĞRULAMA KAPISI. Ajan modeli doluysa spawn'dan ÖNCE `opencode models`
    // listesinde doğrulanır; yoksa spawn YOK + pane'e dürüst satır. Sağlayıcının özel
    // adresi varsa karar 1 politikası (LAN http yalnız onayla, internet http sert ret)
    // ve 3 sn erişilebilirlik probu (sessiz 45 sn retry yerine duvar saati). Kapı
    // motor adına değil BU BEYANA bağlıdır (opencodeModelGate.cjs).
    modelGate: Object.freeze({
      listArgs: Object.freeze(['models']),
      configArgs: Object.freeze(['debug', 'config']), // çözülmüş config (yalnız provider.<id>.options.baseURL okunur)
      timeoutMs: 5000,
      cacheMs: 60_000,
      probeTimeoutMs: 3000,
      lanHttpAckSetting: 'engines.opencode.lanHttpAck', // Eren kararı 1: özel ağda http = kullanıcı BİLEREK onaylar
      guide: 'docs/design/guides/claudesuz-crewpane-kurulum.md', // "Kendi modelini bağla" rehberi (site URL'i: Eren)
      measured:
        'RESEARCH-OC-01-evidence/07-model-fallback.txt — `-m opencode/bu-model-yok` TUI\'de "Model … is not valid" + tur giriş yapılmış OpenAI hesabına GİTTİ (~8k jeton); KOL 3 `opencode models` listesi ön-doğrulama için yeterli · 06-remote-provider.txt B/C — bağlantı yok/5xx\'te stdout boş ≥45 sn sessiz retry',
    }),

    images: null,
    provider: null,

    // OTURUM — kimliği BİZ BASAMAYIZ. ÖLÇÜLDÜ: `-s <uuid>` → "Session not found"
    // (exit 1). Kimlik motorun kendi biçimidir (`ses_fed1cbbd3ffez7UNbqqBamlqTj`) ve
    // ancak ÇIKTIDAN okunup geri verilebilir (`-s <ölçülen id>` ile resume ÇALIŞTI).
    session: Object.freeze({
      mint: null,
      flag: null,
      killSwitchEnv: null,
      resume: Object.freeze({
        form: 'append',
        flag: '--session',
        idShape: 'engine-minted',
        lastFallback: Object.freeze(['--continue']),
      }),
    }),

    // 🔑 SERT ALT-AJAN BLOĞU VAR — ama ARGV'de değil, kimlik belgesinde.
    // ÖLÇÜLDÜ (model turu HARCAMADAN, `opencode debug agent build`):
    //   config `{"tools":{"task":false}}` → `tools.task = False`
    //   + üretilen kural: {"permission":"task","action":"deny","pattern":"*"}
    // TOKEN-BUDGET-01 — BAĞLAM KAPSAMI: bu motorun kendi belge enjeksiyonunu
    // (proje talimatı zinciri + kalıcı hafıza indeksi) ÇALIŞMA ALANIYLA sınırlayan
    // bir taşıyıcı ÖLÇÜLMEDİ. `null` = bugünkü davranış aynen sürer; kesim yalnız
    // beyan eden motorda uygulanır (paneContextScope HEPSİ-YA-HİÇ kuralı).
    contextScope: null,
    subagentBlock: Object.freeze({
      args: Object.freeze([]), // argv yolu YOK (bilerek boş — `via` bunu söyler)
      via: 'env-config',
      configPath: 'tools.task',
      value: false,
      position: 'append',
      dedupeToken: null,
      measured:
        '`opencode debug agent build` (yerel render, model turu YOK): tools:{task:false} → tools.task=False + {"permission":"task","action":"deny","pattern":"*"}',
    }),

    trust: null,
    reset: null,
    tui: null,

    // ─── 2. KAPI — ARAÇ BAĞLAMA: AYNI ENV BELGESİ (per-launch, sır taşır) ───
    // ENG-OPENCODE-MCP-01: ürünün sunucuları bu belgeye `agentRunner.mcpRegisterArgs`
    // env-config dalıyla BİRLEŞTİRİLİR (lider: delegate+browser+task+integrations;
    // worker: task+browser+integrations). `strictFlag:null` → kullanıcının global
    // sunucuları da birleşir (sert izolasyon bu motorda yok, ölçüldü RESEARCH-OC-01 §2.6).
    mcp: Object.freeze({
      kind: 'env-config',
      env: 'OPENCODE_CONFIG_CONTENT',
      configPath: 'mcp',
      strictFlag: null,
      // Server'ın kendi env'i belgede taşınır (`environment` alanı) → anahtar ARGV'ye
      // yazılmadan MCP çocuğuna ulaşır.
      envInheritance: true,
      serverEnvPath: 'environment',
      position: 'append',
    }),

    hooks: null,
    extraRoots: null,
    skillsDir: null,
    identityEnv: null,

    auth: Object.freeze({
      label: 'OpenCode',
      accountHint:
        'Kendi sağlayıcı hesabın (Anthropic/OpenAI/OpenRouter…) — GİRİŞ YAPMADAN da koşar, ama o zaman kodun OpenCode\'un kendi sunucusundaki ücretsiz modele gider',
      signupUrl: 'https://opencode.ai/docs/providers/',
      flow: 'external', // `opencode auth login` İNTERAKTİF seçicidir (sağlayıcı listesi + anahtar sorusu)
      needsCode: false,
      loginArgv: null,
      // ENG-HONEST-CARD-01 — kullanıcının TERMİNALDE yazacağı komut (ürün SÜRMEZ, yazar).
      // `loginArgv`ye konulsaydı `engineAuth.startLogin` interaktif TUI'yi pipe'ta
      // sürer ve 5 dk asılı kalırdı (crush dersi). Kart RESEARCH-OC-02 Y3'ü kapatır:
      // "kendi komutuyla bağlanırsın" der ama komutu yazmazdı.
      manualLoginArgv: Object.freeze(['auth', 'login']),
      logoutArgv: null,
      statusArgv: null,
      statusParse: null,
      statusNote:
        'opencode 1.18.18\'de makine-okunur bir hesap DURUMU komutu YOK: `opencode auth list` insan-okur bir kutu basar ("Credentials ~/.local/share/opencode/auth.json · 0 credentials") ve giriş akışı sağlayıcı seçtiren İNTERAKTİF bir TUI\'dir → rozet ÜÇÜNCÜ durumu (BİLİNMİYOR) gösterir. Fatura kipi ayrıca `vendor-hosted` olarak AYRI ve ölçülmüş bir kanaldan söylenir.',
      apiKey: null,
      apiKeyNote:
        'Anahtar kapısı ÜRÜNDEN yönetilmiyor: opencode anahtarları kendi defterine (`auth.json`) İNTERAKTİF `auth login` ile yazar ve tek bir "API anahtarı env değişkeni" yoktur (sağlayıcı başına ayrı ad). Anahtarı vault\'a alıp env ile vermek, motorun kendi çözüm sırasını sessizce eziyor olurdu → yol AÇILMADI (ENG-16 kapsam dışı).',
      noApiKeyNote:
        'opencode\'ta anahtar kutusu yok — anahtarlar kendi defterine (`~/.local/share/opencode/auth.json`) giriş yapıp sağlayıcı seçmek suretiyle kaydedilir. CrewPane bu defteri yönetemiyor. Giriş: terminalden `opencode auth login` sihirbazı ile giriş yap; CrewPane yalnız durumunu okur.',
    }),

    // ─── 4. KAPI — KULLANIM: motorun KENDİ raporu (`opencode stats`) ────────
    usage: Object.freeze({
      kind: 'cli-report',
      level: 'reported',
      content: 'counters',
      reader: null,
      format: 'text',
      report: Object.freeze({ argv: Object.freeze(['stats', '--days', '1']) }),
      root: null,
      rootEnv: null,
      file: null,
      sessionKey: null,
      accumulation: null,
      dedupeBy: null,
      cost: null, // rapor "$0.00" der ama bu SATICI KAPISININ bedavalığıdır, ölçülmüş bir fiyat değil
      billing: Object.freeze({
        apiKeyEnv: 'OPENCODE_API_KEY',
        configFile: null,
        field: null,
        planField: null,
        subscriptionWhen: null,
        sourceLabel: 'opencode auth.json (kimlik defteri) · fatura kipi ölçümü',
        overrideOpt: 'opencodeAuthFile',
        // 🔴 ENG-16 — 4. FATURA DEĞERİ (ölçülmüş).
        vendorHosted: Object.freeze({
          detect: 'credentials-file',
          credentialsFile: '~/.local/share/opencode/auth.json',
          vendorLabel: 'OpenCode',
          modelPrefix: 'opencode/',
          disclosure:
            'Bu motor giriş yapılmadan koşarken isteklerin OpenCode\'un KENDİ sunucusundaki ücretsiz modele gider (opencode/big-pickle) — yani pane\'e verdiğin kod ve dosya içerikleri üçüncü bir tarafın sunucusundan geçer, ücret 0 görünür. Kendi sağlayıcı hesabını bağlarsan istekler doğrudan seninkiyle gider.',
          blockedHint:
            'Bedava satıcı kapısı ürün ayarıyla KAPALI. Bu motoru kullanmak için `opencode auth login` ile kendi sağlayıcı hesabını bağla (ya da ayarı "allow" yap).',
          policySetting: 'engines.opencode.vendorHosted',
          defaultPolicy: 'allow',
          futureLock:
            'PLANLANAN (bu görevde DEĞİL): hesap genelinde "yalnız kendi anahtarım" kilidi — açıkken vendor-hosted koşan HER motor bloklanır.',
        }),
      }),
    }),

    output: Object.freeze({
      kind: 'jsonl',
      flag: '--format',
      values: Object.freeze(['default', 'json']),
      quietFlag: null,
      requiresQuiet: false,
      subcommand: 'run',
      // ENG-OPENCODE-DB-01 (C4, OC-DESIGN-0919 §5(d)) — HEADLESS HİJYEN SÖZLEŞMESİ.
      // Ürün bugün `opencode run` çağıran bir süpervizör yolu TAŞIMIYOR; bu üç alan
      // gelecek okuyucu içindir ve ÖLÇÜLMÜŞTÜR (RESEARCH-OC-01 §4 satır 0 + bu kartın
      // 04-concurrency-2x3.cjs koşumu, argv/env buradan türetildi):
      //   • stdin 'ignore' — PIPE kalırsa `run` mesajı stdin'den de bekler ve HİÇ
      //     başlamaz (17/17, 120 sn SIGKILL; 04-concurrency-stdin-trap.txt).
      //   • OPENCODE_DISABLE_AUTOUPDATE=1 — daemon turunda güncelleme indirmesin.
      //   • --print-logs --log-level ERROR — bağlantı hatası (`AI_APICallError`,
      //     `Cannot connect to API`) aksi hâlde HİÇBİR kanalda görünmez (sessiz retry).
      // `--auto` BURAYA YAZILMAZ: otonomi `autonomy.flags`ten gelir (tek kaynak).
      // Okuyucu reçetesi: [subcommand, ...autonomy.flags, flag, 'json', ...headlessArgs].
      stdin: 'ignore',
      headlessEnv: Object.freeze({ OPENCODE_DISABLE_AUTOUPDATE: '1' }),
      headlessArgs: Object.freeze(['--print-logs', '--log-level', 'ERROR']),
    }),

    install: Object.freeze({
      label: 'OpenCode',
      command: 'npm install -g --prefix ~/.local opencode-ai',
      win32Command: 'npm install -g opencode-ai',
      docsUrl: 'https://opencode.ai/docs/',
      checkHint: 'https://opencode.ai/docs/',
      installsTo: 'npm-global',
      verifyArgv: Object.freeze(['--help']),
      verifyPattern: 'opencode\\s+completion',
    }),

    // CDX-F1 — efor kolu bu motorda BEYAN EDİLMEDİ (gerekçe: unsupported.effort).
    effort: null,

    unsupported: Object.freeze({
      contextScope:
        'bu motorun kendi belge enjeksiyonunu (proje talimatı zinciri + kalıcı hafıza indeksi) çalışma alanıyla sınırlayan bir taşıyıcı ÖLÇÜLMEDİ — kesim yalnız beyan eden motorda koşar, burada bugünkü davranış aynen sürer (TOKEN-BUDGET-01)',
      effort:
        'efor/akıl-yürütme seviyesi taşıyıcısı BU MOTORDA ÖLÇÜLMEDİ — CDX-F1 kapsamı bilerek codex (+claude beyanı) ile sınırlı tutuldu; beyan edilene kadar per-launch efor override\'ı YOKTUR ve motor kendi varsayılanıyla koşar (sessiz kayıp değil, ölçülmemiş kol)',
      images:
        '`opencode run` mesaja DOSYA ekleyebiliyor (`-f/--file`) ama bunun GÖRSEL olarak modele gittiği ölçülmedi ve TUI pane\'inde per-launch bir görsel bayrağı yok → görsel yolu claude\'daki gibi prompt METNİNE gömülmeli',
      provider:
        'sağlayıcı seçimi `-m provider/model` + `opencode auth login` ile yapılır; ürünün BYOK grameri (providers.cjs `-c model_provider` + wire_api) codex\'e özgüdür ve opencode\'da dengi ÖLÇÜLMEDİ. Kendi modelini bağlamak bugün kullanıcının `opencode.json`u + rehberle olur (docs/design/guides/claudesuz-crewpane-kurulum.md); ürün içi sihirbaz C8 kartında (ENG-OPENCODE-PROVIDER-UI-01, 0.2.49 sonrası, Eren kararı 1\'e bağlı)',
      trust:
        'opencode\'da dizin GÜVENİ kapısı ÖLÇÜLMEDİ: taze bir tmp dizininde koşular doğrudan başladı, gemini\'deki "not running in a trusted directory" (exit 55) sınıfından bir duvar HİÇ çıkmadı. Var olmayan bir kapıya yazıcı bağlamak, olmayan bir korumayı VAR sanmaktır',
      reset:
        'pane RESET slash komutu GERÇEK bir TUI oturumunda ölçülmedi (bu görev headless `run` ile koştu). Var olmayan bir komutu göndermek pane\'e sessizce metin yazar ve kullanıcı "temizlendi" sanır → alan null (ENG-10 takip kalemi)',
      tui:
        'TUI hazır/blocker dizeleri gerçek pane\'de ölçülmedi; paneReadiness.ts\'te regex YOK → alan null (ENG-10 takip kalemi)',
      hooks:
        'opencode eklenti (plugin) yüzeyi VAR (`opencode plugin`, `--pure` bayrağı eklentileri kapatıyor) ama TUR BAŞI brifing enjekte eden per-launch bir kanca bayrağı ÖLÇÜLMEDİ → ADP-692 brifingi bu motorda argv ile KURULAMAZ',
      extraRoots:
        'ek çalışma kökü bayrağı YOK: `--dir` TEK bir çalışma dizini seçer (ek kök EKLEMEZ, mevcut olanı DEĞİŞTİRİR) → hafıza/çoklu-repo kökü bu motorda verilemez',
      skillsDir:
        'yetenek (skill) dizini kavramı ikilide GEÇİYOR (`opencode debug skill`, agent izinlerinde "skill") ama ürünün skill kitaplığını okuyacağı per-pane bir DİZİN yolu ÖLÇÜLMEDİ → uydurma bir yol yazmak skill\'leri sessizce görünmez yapardı',
      identityEnv:
        'ÇOKLU HESAP AÇILMADI: `OPENCODE_CONFIG_DIR` yalnız CONFIG dizinini taşır, kimlik defteri (auth.json) VERİ dizinindedir (`~/.local/share/opencode`) ve onu ayıran bir env ölçülmedi → iki hesabı izole ettiğimizi söylemek YALAN olurdu',
    }),

    partial: Object.freeze({
      identity:
        'kimlik ADDITIVE ve CANLI doğrulandı (kod kelimesi cevapta + AYNI turda dosya araçla okundu) ama taşıyıcı `instructions[]`tir: motor bu dosyaları "proje talimatı" bağlamında okur, claude\'un system-prompt katmanı DEĞİL. Ayrıca aynı belgede REPLACE yapan bir alan (`agent.<ad>.prompt`) var → yazıcı yanlış alana yazarsa gömülü prompt SESSİZCE silinir (bu yüzden alan `configPath` ile beyanlı)',
      session:
        'oturum kimliği MOTORUNDUR: `-s <uuid>` "Session not found" ile REDDEDİLDİ, resume ancak ÇIKTIDAN okunan `ses_…` kimliğiyle çalıştı (ölçüldü). Yani restart-resume bu motorda kimliği ÖNCE yakalamayı gerektirir — bugünkü ADP-192 yolu (bizim bastığımız uuid) burada KOŞMAZ',
      model:
        '`-m provider/model` bayrağı ölçüldü; seçilebilir küme `opencode models` çıktısıdır (kimliksiz koşuda yalnız satıcının ücretsiz `opencode/*` listesi; kullanıcı `~/.config/opencode/opencode.json`a sağlayıcı yazınca `<sağlayıcı>/<model>` satırları eklenir). 🔴 ÖLÇÜLDÜ (RESEARCH-OC-01 §2.7): listede OLMAYAN bir ad verilirse motor turu giriş yapılmış herhangi bir BULUT sağlayıcıya sessizce düşürür → ürün spawn ÖNCESİ listede doğrular (`modelGate`), yoksa pane açılmaz; sağlayıcı bağlama sihirbazı C8 kartında (ENG-OPENCODE-PROVIDER-UI-01)',
      subagentBlock:
        'blok GERÇEK ve makine-doğrulanabilir (`debug agent build` → tools.task=False + deny kuralı) ama ARGV\'de değil KİMLİK BELGESİNDE taşınır: belge yazılamazsa (IO hatası) blok da düşer. Bu yüzden yazıcı fail-closed\'dır ve düşüş log\'a yazılır',
      usage:
        'motorun kendi raporu (`opencode stats`) GERÇEK sayılar veriyor ama ASCII TABLO basıyor (makine-okunur değil) ve pane/oturum kırılımı yok. Olay akışında (`--format json`) `step_finish.tokens` + `cost` KESİN geliyor — jeton kartı bunu okuyabilir; okuyucu bu görevde YAZILMADI (ENG-09 takip kalemi)',
      auth:
        'giriş akışı İNTERAKTİF bir TUI seçicisidir; ürün onu Ayarlar\'dan süremiyor (claude/codex\'teki gizli-çocuk deseni burada KOŞMAZ). Rozet bugün "bilinmiyor" der ve fatura kipini AYRI ölçer',
      output:
        '`run --format json` satır-satır olay akışı ölçüldü (step_start/text/tool/step_finish) ve şekli STABİL; ama bu bir ALT KOMUT bayrağıdır (`run`), TUI pane\'inin çıktısı DEĞİL → süpervizör okuyucusu ancak headless `run` yolunda kullanılabilir',
    }),

    // 🔑 ENG-16 — PANE İZOLASYONU ZORUNLU (ölçülmüş çakışma).
    isolation: Object.freeze({
      kind: 'pane-file',
      env: 'OPENCODE_DB',
      fileName: 'pane.db',
      measured:
        'aynı cwd\'de EŞZAMANLI iki `opencode run`: biri exit 1 + "Error: Unexpected error / database is locked" ile ÖLDÜ (ortak sqlite: ~/.local/share/opencode/opencode.db). Pane başına ayrı OPENCODE_DB ile ikisi de exit 0 ve HER BİRİ KENDİ kimliğini söyledi (ENG16-INSTR-7742 ≠ ENG16-JAZZ-4141). '
        + 'RESEARCH-OC-01 §2.4 (04-concurrency.txt): pane başına DB 3×3 ×2 tekrar TEMİZ (0 kilit, kimlik 15/15); ortak DB\'de "database is locked" 7 koşumda 0 (WAL) ama TAZE ortak DB\'yi iki süreç aynı anda göç ettirince biri `Failed query: CREATE TABLE workspace` ile exit 1 → ikiz-spawn (aynı ajan anahtarı) bu yarışa düşer, kapısı C4 (`taskClaim.decideIsolationTwin`). XDG_DATA_HOME ile ayırmak REDDEDİLDİ: auth.json da taşınır, kullanıcının sağlayıcı girişi kaybolur; snapshot deposu proje başına ortak kalır (3× temiz, ağır dosya yazımında ÖLÇÜLMEDİ). '
        + 'ENG-OPENCODE-DB-01 (04-concurrency-2x3.txt): env/argv descriptor\'dan türetilerek 2×3 pane başına DB → 6/6 exit 0, 0 kilit, 0 Failed query, kimlik 6/6; ikiz kapısı AÇIK (aynı ajan ×2, ikinci --2 deposu) → 2/2 exit 0, kimlik 2/2; kontrol kolu kapı KAPALI (aynı taze dosya ×2) → 1/2 exit 1 `Failed query: CREATE TABLE workspace` (411 ms) — kapı sökülünce arıza GERİ GELDİ, sahte-yeşil değil',
    }),

    verification: Object.freeze({
      contextScope: Object.freeze({ channel: 'unverified', source: 'TOKEN-BUDGET-01 — bu motorda belge-enjeksiyonunu kapatan bir bayrak ARANMADI/ÖLÇÜLMEDİ; kesim yalnız beyan eden motorda koşar' }),
      effort: Object.freeze({ channel: 'unverified', source: 'CDX-F1: bu motorda efor bayrağı ARANMADI/ölçülmedi (kapsam: codex + claude)' }),
      identity: Object.freeze({ channel: 'measured', source: 'ENG-16-evidence/opencode-identity-live.txt + opencode-prompt-arithmetic.txt — instructions[] ADDITIVE (8164→8248), agent.prompt REPLACE (8164→6399); canlı tur: kod kelimesi + araçla dosya okuma AYNI turda' }),
      model: Object.freeze({ channel: 'measured', source: '`opencode run --help` yargs: `-m, --model  model to use in the format of provider/model` + `opencode models` çıktısı' }),
      images: Object.freeze({ channel: 'measured', source: '`opencode run --help`: `-f, --file  file(s) to attach to message` — GÖRSEL semantiği yok, TUI kökünde bayrak yok' }),
      provider: Object.freeze({ channel: 'measured', source: '`opencode auth --help` (login/logout/list) + `-m provider/model`; codex\'in `-c model_provider` grameri YOK' }),
      session: Object.freeze({ channel: 'measured', source: 'ENG-16-evidence/opencode-session.txt — `-s <uuid>` → exit 1 "Session not found"; `-s ses_fed1cbbd3ffez7UNbqqBamlqTj` → aynı oturum (exit 0)' }),
      subagentBlock: Object.freeze({ channel: 'measured', source: 'ENG-16-evidence/opencode-subagent-block.txt — `opencode debug agent build` ile tools.task=False + {"permission":"task","action":"deny"}' }),
      trust: Object.freeze({ channel: 'unverified', source: 'taze tmp dizinlerinde güven diyaloğu/hatası HİÇ görülmedi; kapının varlığı doğrulanamadı → alan null' }),
      reset: Object.freeze({ channel: 'unverified', source: 'gerçek TUI oturumunda slash komut ölçülmedi → alan null' }),
      tui: Object.freeze({ channel: 'unverified', source: 'gerçek pane\'de ölçülmedi → alan null' }),
      mcp: Object.freeze({ channel: 'measured', source: 'ENG-16-evidence/opencode-mcp-inline.txt — OPENCODE_CONFIG_CONTENT içindeki `mcp` bloğuyla `opencode mcp list` → "● ✓ eng16 connected" · RESEARCH-OC-01-evidence/01-summary.txt — ürünün 3 gerçek sunucusu (delegate/task/browser) aynı belgeden 3/3 connected + `crewpane_delegation_status` araç çağrısı sahte köprüye jetonla ulaştı (ENG-OPENCODE-MCP-01: besleyen zincir `agentRunner.mcpRegisterArgs` env-config dalı)' }),
      hooks: Object.freeze({ channel: 'measured', source: '`opencode --help`: `plugin` alt-komutu + `--pure` ("run without external plugins") — per-launch KANCA bayrağı yok' }),
      extraRoots: Object.freeze({ channel: 'measured', source: '`opencode run --help`: `--dir  directory to run in` (TEK dizin; ek kök ekleyen bayrak listede YOK)' }),
      skillsDir: Object.freeze({ channel: 'measured', source: '`opencode debug --help` → `debug skill` (list all available skills); per-pane skill DİZİNİ bayrağı/env\'i yok' }),
      identityEnv: Object.freeze({ channel: 'measured', source: '`opencode debug paths` → config=~/.config/opencode, data=~/.local/share/opencode; ikilide OPENCODE_CONFIG_DIR var, VERİ dizinini ayıran env yok' }),
      auth: Object.freeze({ channel: 'measured', source: 'ENG-16-evidence/opencode-auth-paths-stats.txt — `opencode auth list` → "Credentials ~/.local/share/opencode/auth.json · 0 credentials"; `auth --help` → list|login|logout' }),
      usage: Object.freeze({ channel: 'measured', source: 'ENG-16-evidence/opencode-auth-paths-stats.txt — `opencode stats --days 1` ASCII tablo (Total Cost $0.00, Input 50.9K); olay akışında step_finish.tokens + cost:0' }),
      output: Object.freeze({ channel: 'measured', source: 'ENG-16-evidence/opencode-run-events.jsonl — `run --format json` satırları: step_start / text / step_finish{tokens,cost}' }),
      install: Object.freeze({ channel: 'measured', source: 'kurulu paket: ~/.local/lib/node_modules/opencode-ai/bin/opencode.exe (npm global) · `opencode --version` → "1.18.18" (kimlik YOK) → `--help` kalıbı "opencode completion"' }),
    }),
  }),
  // ═══════════════════════════════════════════════════════════════════════════
  // ENG-16 — AMP 0.0.1786968161-gdd03ae (9. motor)
  //
  // 🔴 BU KAYIT BİLEREK "LİDER OLAMAZ" DURUMUNDA GİRİYOR (board maddesi 3).
  // Gerekçe UYDURULMADI, ÖLÇÜLDÜ ve iki parçalı:
  //   (a) KİMLİK TAŞIYICISI YOK — amp kimliği yalnız PROJE DOSYASINDAN okur
  //       (AGENTS.md / AGENT.md / CLAUDE.md, ikilide üçü de geçiyor). Aynı dizinde
  //       İKİ AYRI kimlik İMKÂNSIZ ve o dosyayı kullanıcının repo'suna yazmak hem
  //       commit'e sızar hem başka pane'in kimliğini ezer → `identity: null`.
  //       Sonuç MAKİNE tarafından uygulanır: `engineLeadership` kimliksiz motora
  //       `never` der → delegasyon zinciri bu pane'e iş VEREMEZ.
  //   (b) İZİN KAPISI HENÜZ ÜRÜNDE DEĞİL (aşağıda ölçüm + reçete).
  //
  // 🪤 BOARD METNİNİN VARSAYIMI KISMEN ÇÜRÜDÜ. ENG-R2 amp için "varsayılan onay YOK"
  // diyordu. ÖLÇÜM (model turu HARCAMADAN, `amp permissions test <araç> --json`):
  //     Bash        → action "ask"    (source: built-in)   ← onay İSTİYOR
  //     Task        → action "allow"  (source: built-in)   ← ASIL RİSK: görünmez alt-ajan
  //     Read/edit_file/create_file → "allow" (built-in)
  // Yani tehlike "her şey serbest" değil, TERSİ bir çift: otopilotta Bash onayı
  // pane'i KESER, alt-ajan ise SESSİZCE açılır (ADR-004'ün tam olarak yasakladığı şey).
  amp: Object.freeze({
    id: 'amp',
    label: 'Amp',
    bin: 'amp',

    // Onay bayrağı YOK: amp'te otonomi ARGV'den değil AYARLAR DOSYASINDAN gelir
    // (`amp.dangerouslyAllowAll` / `amp.permissions`). Ürün o dosyayı henüz pane
    // başına yazmıyor → argv boş ve bu BİLİNÇLİ (aşağıdaki `autonomy.why`).
    defaultArgs: Object.freeze([]),

    autonomy: Object.freeze({
      level: 'partial',
      via: 'config',
      flags: Object.freeze([]),
      measured:
        '`amp permissions test --json` (yerel değerlendirme, model turu YOK): Bash→"ask" (built-in), Task→"allow" (built-in). Pane başına yazılan bir ayar dosyasıyla (`--settings-file`) aynı prob Bash→"allow", Task→"reject" verdi (source: user) → kapı ÇALIŞIYOR, ürüne BAĞLANMADI',
      why:
        'ENG-16 board kuralı: "sandbox/izin kapısını BİZ kurmadan delegasyona açma". Kapı ölçüldü ve reçetesi rapora yazıldı; pane-başına ayar dosyası YAZICISI bu görevde KURULMADI → motor tam-otomatik SAYILMAZ ve lider olamaz (kimlik taşıyıcısı da yok)',
    }),

    // ─── 1. KAPI — KİMLİK: TAŞIYICI YOK (ölçülmüş, uydurulmadı) ────────────
    identity: null,

    model: null,
    images: null,
    provider: null,

    // OTURUM — konu "thread". Kimliği BİZ basamayız; devam alt-komutla yapılır.
    session: Object.freeze({
      mint: null,
      flag: null,
      killSwitchEnv: null,
      resume: Object.freeze({
        form: 'subcommand',
        argv: Object.freeze(['threads', 'continue']),
        idShape: 'engine-minted',
        lastFallback: Object.freeze(['last']),
      }),
    }),

    // TOKEN-BUDGET-01 — BAĞLAM KAPSAMI: bu motorun kendi belge enjeksiyonunu
    // (proje talimatı zinciri + kalıcı hafıza indeksi) ÇALIŞMA ALANIYLA sınırlayan
    // bir taşıyıcı ÖLÇÜLMEDİ. `null` = bugünkü davranış aynen sürer; kesim yalnız
    // beyan eden motorda uygulanır (paneContextScope HEPSİ-YA-HİÇ kuralı).
    contextScope: null,
    subagentBlock: null,
    trust: null,
    reset: null,
    tui: null,

    // ─── 2. KAPI — ARAÇ BAĞLAMA: per-launch config (claude grameriyle aynı) ──
    mcp: Object.freeze({
      kind: 'config-file',
      flag: '--mcp-config',
      strictFlag: null, // "merge with existing settings" — kullanıcının server'ları DIŞARIDA bırakılamaz
      envInheritance: false, // MCP çocuğunun pane env'ini miras aldığı ÖLÇÜLMEDİ → sır taşıma AÇILMADI
      // 🔑 ENG-21 (G6) — BELGE GÖVDESİ DÜZ HARİTA. ÖLÇÜLDÜ (amp 0.0.1786968161,
      // ENG-15 §2.4-G6; ENG-21'de yeniden koşuldu): claude'un `{"mcpServers":{…}}`
      // sarmalayıcısı amp'in doğrulayıcısında DÜŞÜYOR ("Invalid MCP server
      // configuration: mcpServers: Invalid input") ve pane HİÇ açılmıyor; aynı
      // harita sarmalayıcısız verildiğinde şema GEÇİYOR (sonraki duvar hesap).
      // `null` = sarmalayıcı YOK. Gramer claude'la aynı sınıf, GÖVDE farklı.
      envelope: null,
      position: 'append',
    }),

    hooks: null,
    extraRoots: null,

    // 🔑 amp CLAUDE'UN skill dizinlerini okuyor (kendi ayarında yazıyor:
    // `amp.skills.disableClaudeCodeSkills` → ".claude/skills/, ~/.claude/skills/").
    skillsDir: Object.freeze({ scope: 'workspace', segments: Object.freeze(['.claude', 'skills']), shared: 'claude' }),

    identityEnv: null,

    auth: Object.freeze({
      label: 'Amp',
      accountHint: 'Amp hesabı (ampcode.com) — kredi bakiyeli abonelik',
      signupUrl: 'https://ampcode.com/settings',
      flow: 'oauth-code', // ÖLÇÜLDÜ: URL basar, tarayıcıdaki KODU stdin\'den ister
      needsCode: true,
      loginArgv: Object.freeze(['login']),
      logoutArgv: Object.freeze(['logout']),
      statusArgv: null,
      statusParse: null,
      statusNote:
        'amp\'te makine-okunur bir hesap DURUMU komutu YOK (komut listesinde `auth status` dengi bulunmuyor; `amp usage` ve `amp threads list` AĞA çıkar ve girişsizken doğrudan GİRİŞ AKIŞINI başlatır — durum sorgusu değildir) → rozet ÜÇÜNCÜ durumu (BİLİNMİYOR) gösterir. Ölçülen giriş duvarı: "No API key found. Starting login flow… When prompted, paste your code here:"',
      apiKey: Object.freeze({
        env: 'AMP_API_KEY', // ENV ile gider — ARGV\'ye ASLA
        vaultService: 'crewpane-amp-api-key',
        keyUrl: 'https://ampcode.com/settings/security#access-token',
        keyLabel: 'Amp erişim jetonu (access token)',
        note:
          'Abonelik BİRİNCİL yoldur (`amp login`); jeton YEDEKtir. ÖLÇÜLDÜ: jeton/oturum yokken HER komut (ve `-x` koşusu) giriş akışına düşer ve kod bekler — yani anahtarsız bir amp pane\'i iş YAPMAZ, kod isteyen bir istemde ASILI KALIR.',
      }),
    }),

    // ─── 4. KAPI — KULLANIM: motorun KENDİ raporu ──────────────────────────
    usage: Object.freeze({
      kind: 'cli-report',
      level: 'reported',
      content: 'counters',
      reader: null,
      format: 'text',
      report: Object.freeze({ argv: Object.freeze(['threads', 'usage']) }),
      root: null,
      rootEnv: null,
      file: null,
      sessionKey: null,
      accumulation: null,
      dedupeBy: null,
      cost: null, // `amp.showCosts` ayarı var ama ÇIKTININ ŞEKLİ ölçülmedi (giriş duvarı)
      billing: Object.freeze({
        apiKeyEnv: 'AMP_API_KEY',
        configFile: null,
        field: null,
        planField: null,
        subscriptionWhen: null,
        sourceLabel: 'AMP_API_KEY (jeton) · abonelik durumu ölçülemiyor (durum komutu yok)',
        overrideOpt: null,
      }),
    }),

    // 🔑 SÜPERVİZÖR: "Claude Code-compatible stream JSON" (motorun KENDİ cümlesi).
    output: Object.freeze({
      kind: 'jsonl',
      flag: '--stream-json',
      values: null,
      quietFlag: null,
      requiresQuiet: false,
      requiresFlag: '--execute',
      claudeCompatible: true,
    }),

    install: Object.freeze({
      label: 'Amp',
      command: 'npm install -g --prefix ~/.local @ampcode/cli',
      win32Command: 'npm install -g @ampcode/cli',
      docsUrl: 'https://ampcode.com/manual',
      checkHint: 'https://ampcode.com/manual',
      installsTo: 'npm-global',
      verifyArgv: Object.freeze(['--help']),
      verifyPattern: 'Amp\\s+CLI',
    }),

    // CDX-F1 — efor kolu bu motorda BEYAN EDİLMEDİ (gerekçe: unsupported.effort).
    effort: null,

    unsupported: Object.freeze({
      contextScope:
        'bu motorun kendi belge enjeksiyonunu (proje talimatı zinciri + kalıcı hafıza indeksi) çalışma alanıyla sınırlayan bir taşıyıcı ÖLÇÜLMEDİ — kesim yalnız beyan eden motorda koşar, burada bugünkü davranış aynen sürer (TOKEN-BUDGET-01)',
      effort:
        'ölçülmedi. amp\'ın `-m, --mode <low|medium|high|ultra>` bayrağı efor kolunun muadili OLABİLİR (ENG-16-evidence/amp-help.txt) ama CDX-F1\'de gerçek ikiliyle DOĞRULANMADI — doğrulanmamış bir bayrağı defterlemek beyanı hükme çevirirdi',
      identity:
        '🔴 GÜVENLİK/ÜRÜN: amp kimliği YALNIZ proje dosyasından okur (ikilide AGENTS.md · AGENT.md · CLAUDE.md). Dosya TEKtir → aynı dizinde iki pane iki AYRI kimlik alamaz; üstelik kullanıcının repo\'suna yazmak commit\'e sızar ve mevcut dosyayı ezer. Per-pane bir sistem-prompt bayrağı/env\'i YOK (tam seçenek listesi ölçüldü) → kimlik taşıyıcısı YOK. Sonuç MAKİNEYLE uygulanır: engineLeadership bu motora "never" der',
      model:
        '🪤 TUZAK: amp\'te `-m` MODEL DEĞİL MODE\'dur ("low, medium, high, ultra — controls the model, system prompt, and tool selection"). Ürünün `--model` yazıcısı buraya bağlanırsa kullanıcının seçtiği model adı bir MOD adı sanılır ve motor reddeder → model bayrağı BEYAN EDİLMEDİ',
      images:
        'seçenek listesinde görsel/attachment bayrağı YOK (tam `--help` çıktısı ölçüldü) → görsel yolu prompt METNİNE gömülmeli; per-launch bir ek yok',
      provider:
        'sağlayıcı anahtarları `amp config model-providers` ile YÖNETİLİYOR ama per-launch seçim bayrağı yok ve ürünün BYOK grameri (providers.cjs) codex\'e özgü → dengi ÖLÇÜLMEDİ',
      subagentBlock:
        '🔴 ÖLÇÜLDÜ ve AÇIK: alt-ajan aracı (`Task`) varsayılanda "allow" (built-in kural). SERT blok MÜMKÜN ama ARGV\'de değil AYAR DOSYASINDA (`amp.permissions` → {tool:"Task",action:"reject"} ya da `amp.tools.disable`) ve ürün o dosyayı pane başına HENÜZ YAZMIYOR → bugün blok YOK. Blok varmış gibi beyan etmek, olmayan bir korumayı VAR sanmaktır',
      trust:
        'dizin GÜVENİ kapısı ölçülmedi: `amp mcpTrustedWorkspaces`/`mcp approve` yalnız MCP sunucusu onayına bakıyor, ÇALIŞMA DİZİNİ güveni için bir kapı görülmedi',
      reset:
        'pane RESET slash komutu gerçek TUI oturumunda ölçülmedi (giriş duvarı nedeniyle TUI hiç açılmadı) → var olmayan bir komut göndermek pane\'e sessizce metin yazardı',
      tui:
        'TUI hazır/blocker dizeleri ölçülmedi (girişsiz makinede TUI açılmıyor, giriş akışına düşüyor) → paneReadiness regex\'i YOK',
      hooks:
        'eklenti yüzeyi VAR (`amp plugins`, agent.start/agent.end lifecycle kancaları) ama TUR BAŞI brifing enjekte eden per-launch bir bayrak yok; eklenti kurmak kullanıcı hesabına kalıcı yazmak demektir → ADP-692 brifingi bu motorda argv ile KURULAMAZ',
      extraRoots:
        'ek çalışma kökü bayrağı seçenek listesinde YOK → hafıza/çoklu-repo kökü bu motorda verilemez',
      identityEnv:
        'ÇOKLU HESAP AÇILMADI: `AMP_SETTINGS_FILE` yalnız AYAR DOSYASINI taşır (kimlik/jeton değil); ikilide `AMP_HOME` geçiyor ama jetonu da izole edip etmediği ÖLÇÜLMEDİ → iki hesabı ayırdığımızı söylemek yalan olurdu',
    }),

    partial: Object.freeze({
      session:
        'devam yolu VAR (`amp threads continue <id>`, `amp last`) ama thread kimliği MOTORUNDUR (biz basamayız) ve girişsiz makinede hiçbiri ölçülemedi → restart-resume bu motorda bugün KURULAMAZ',
      mcp:
        '`--mcp-config <JSON ya da dosya yolu>` per-launch ve claude grameriyle aynı sınıf (motorun kendi cümlesi: "merge with existing settings"), ama (a) `--strict-mcp-config` DENGİ YOK → kullanıcının kendi sunucuları dışarıda bırakılamaz, (b) gerçek bir stdio sunucusunun BAĞLANDIĞI ölçülemedi (giriş duvarı) → sır taşıma kapalı bırakıldı',
      skillsDir:
        'amp KENDİ ayar açıklamasında claude\'un skill dizinlerini saydığını yazıyor (".claude/skills/, ~/.claude/skills/, ~/.claude/plugins/cache/") ve kapatma anahtarı var (`amp.skills.disableClaudeCodeSkills`) — yani dizin PAYLAŞIMLI; ürünün skill kitaplığı bu motorda claude ile AYNI dosyalardan okunur. Gerçek bir koşuda skill\'in yüklendiği ölçülmedi (giriş duvarı)',
      auth:
        'giriş duvarı CANLI ölçüldü (kod-yapıştırma akışı başladı) ama girişin KENDİSİ yapılmadı: amp ücretli kredi ister ve bu Eren\'in kararıdır → hesap durumu, kullanım raporu, stream-json zarfının GERÇEK gövdesi ve canlı tur bu görevde ÖLÇÜLEMEDİ',
      usage:
        '`amp threads usage` ve `amp usage` komutları VAR (yardım metninden ölçüldü) ama çıktı ŞEKLİ görülemedi (giriş duvarı) → jeton kartı bu motorda bugün "bilinmiyor" der ve TAHMİN ETMEZ',
      output:
        '"Claude Code-compatible stream JSON" motorun KENDİ cümlesidir ve iki uçlu bir sözleşme beyan eder (`--stream-json-input` ile JSONL kullanıcı mesajı da OKUR). GERÇEK gövde ölçülemedi (giriş duvarı) → okuyucu paylaşımı BEYAN, kanıt değil; bu yüzden süpervizör okuyucusu bu motora BAĞLANMADI',
    }),

    verification: Object.freeze({
      contextScope: Object.freeze({ channel: 'unverified', source: 'TOKEN-BUDGET-01 — bu motorda belge-enjeksiyonunu kapatan bir bayrak ARANMADI/ÖLÇÜLMEDİ; kesim yalnız beyan eden motorda koşar' }),
      effort: Object.freeze({ channel: 'unverified', source: 'ENG-16-evidence/amp-help.txt — `-m/--mode` GÖRÜLDÜ ama efor semantiği CDX-F1\'de ölçülmedi' }),
      identity: Object.freeze({ channel: 'measured', source: 'tam `amp --help` seçenek listesi (ENG-16-evidence/amp-help.txt): sistem-prompt bayrağı YOK · ikili dizeleri: AGENTS.md (5), AGENT.md (3), CLAUDE.md (3)' }),
      model: Object.freeze({ channel: 'measured', source: 'ENG-16-evidence/amp-help.txt — `-m, --mode <value>  Set the agent mode (low, medium, high, ultra)`; `--model` diye bir seçenek YOK' }),
      images: Object.freeze({ channel: 'measured', source: 'ENG-16-evidence/amp-help.txt — tam seçenek listesinde görsel/attachment bayrağı yok' }),
      provider: Object.freeze({ channel: 'measured', source: '`amp config model-providers` alt-komut ağacı (list/activate/deactivate/add-router) — per-launch seçim bayrağı yok' }),
      session: Object.freeze({ channel: 'measured', source: '`amp --help`: `threads continue`, `last` [alias: l] "Continue the last thread"' }),
      subagentBlock: Object.freeze({ channel: 'measured', source: 'ENG-16-evidence/amp-permissions.txt — `amp permissions test Task --json` → {"action":"allow","source":"built-in"}; ayar dosyasıyla aynı prob → {"action":"reject","source":"user"}' }),
      trust: Object.freeze({ channel: 'unverified', source: 'çalışma dizini güven kapısı görülmedi → alan null' }),
      reset: Object.freeze({ channel: 'unverified', source: 'TUI açılamadı (giriş duvarı) → alan null' }),
      tui: Object.freeze({ channel: 'unverified', source: 'TUI açılamadı (giriş duvarı) → alan null' }),
      mcp: Object.freeze({ channel: 'measured', source: 'ENG-16-evidence/amp-help.txt — `--mcp-config <value>  JSON configuration or file path for MCP servers to merge with existing settings` + `amp mcp add/list/doctor/approve`' }),
      hooks: Object.freeze({ channel: 'measured', source: '`amp plugins` ağacı + `--plugin-ready-timeout` açıklaması ("plugin lifecycle hooks (agent.start/agent.end)") — per-launch kanca bayrağı yok' }),
      extraRoots: Object.freeze({ channel: 'measured', source: 'tam seçenek listesinde ek-kök bayrağı yok' }),
      skillsDir: Object.freeze({ channel: 'measured', source: 'ayar referansı (ikilinin kendi çıktısı): `amp.skills.disableClaudeCodeSkills` → "Disable skills from .claude/skills/, ~/.claude/skills/, and ~/.claude/plugins/cache/" + `amp.skills.path`' }),
      identityEnv: Object.freeze({ channel: 'measured', source: '`amp --help` env bölümü: AMP_API_KEY / AMP_URL / AMP_LOG_* / AMP_SETTINGS_FILE (ev dizini env\'i BELGELENMEMİŞ; ikilide AMP_HOME dizesi var ama davranışı ölçülmedi)' }),
      auth: Object.freeze({ channel: 'measured', source: 'ENG-16-evidence/amp-login-wall.txt — gerçek koşu: "No API key found. Starting login flow… When prompted, paste your code here:" (jeton MASKELENDİ)' }),
      usage: Object.freeze({ channel: 'measured', source: '`amp --help`: `threads usage  Show usage information for a thread` + `usage  Show your current Amp usage and credit balance`' }),
      output: Object.freeze({ channel: 'measured', source: '`amp --help`: `--stream-json  … output in Claude Code-compatible stream JSON format` (+ `--stream-json-input`, `--stream-json-thinking`)' }),
      install: Object.freeze({ channel: 'measured', source: 'kurulu paket: ~/.local/lib/node_modules/@ampcode/cli/bin/amp.exe (npm global) · `amp --version` → "0.0.1786968161-gdd03ae …" (ürün adı YOK) → `--help` kalıbı "Amp CLI"' }),
    }),
  }),
  // ───────────────────────────────────────────────────────────────────────────
  // ENG-17 — CURSOR CLI (`cursor-agent`). ENG-R2 §3 satır 11 (D) idi; bu tur KURULDU
  // ve ÖLÇÜLDÜ (2026.08.11-e8db854). Ölçüm iki yeri düzeltti: (a) matriste "usage
  // doğrulanmadı" yazıyordu — motorun `about --format json` uçları VAR ama jeton
  // vermiyor; (b) MCP "editörün mcp.json'ını AYNEN okur" doğru ama SONUCU yanlış
  // anlaşılıyordu: dosya PROJEDE (`.cursor/mcp.json`) ve `CURSOR_DATA_DIR` onu
  // TAŞIMIYOR (ölçüldü) → pane BAŞINA farklı araç seti YOK.
  //
  // 🔴 BU MOTOR ÜRÜNDE KAPALI: hesap duvarı (bu makinede Cursor hesabı yok) →
  // canlı tur, jeton kartı ve gerçek MCP+model turu ÖLÇÜLEMEDİ. Argv yüzeyi ise
  // ölçüldü (aşağıdaki `autonomy.measured` iki yönlü prob).
  cursor: Object.freeze({
    id: 'cursor',
    label: 'Cursor CLI',
    // 🪤 İKİLİ ADI: kurulum ~/.local/bin'e İKİ sembolik bağ atar — `agent` (satıcının
    // "primary"si) ve `cursor-agent` (legacy). ÜRÜN `cursor-agent`i kullanır: `agent`
    // JENERİK bir addır ve kullanıcının PATH'inde başka bir programa ait olabilir;
    // kurulum script'i onu SORMADAN siler (`rm -f ~/.local/bin/agent`). Kimlik
    // doğrulaması da bu yüzden ada değil `--help` GÖVDESİNE bakar.
    bin: 'cursor-agent',

    // ADR-004 dengi: `-f/--force` ("Force allow commands unless explicitly denied";
    // `--yolo` onun ALIAS'ı). Kum havuzu AYRI bir kapı (`--sandbox enabled|disabled`)
    // ve güven AYRI (`--trust`) → claude paritesi için ÜÇÜ birden gerekiyor.
    // `--approve-mcps` dördüncüsü: MCP sunucuları varsayılanda ONAY BEKLİYOR
    // (ölçüldü: `mcp list` → "eng17: not loaded (needs approval)").
    defaultArgs: Object.freeze(['--force', '--sandbox', 'disabled', '--trust', '--approve-mcps']),

    autonomy: Object.freeze({
      level: 'full',
      via: 'argv',
      flags: Object.freeze(['--force', '--sandbox', 'disabled', '--trust', '--approve-mcps']),
      measured:
        'ENG-17 İKİ YÖNLÜ ARGV PROBU (hesapsız, model turu YOK): dört bayrağın hepsi parse\'ı GEÇTİ ve koşu HESAP duvarına düştü ("Authentication required. Please run \'agent login\'…"); KONTROL olarak uydurma bir bayrak aynı yolda "error: unknown option \'--eng17-yok-bayrak\'" ile REDDEDİLDİ → bayraklar GERÇEK. Onay davranışının KENDİSİ (pane onay sorar mı) hesap duvarı nedeniyle canlı ölçülemedi',
      why:
        'Eren kararı 2026-08-18 (ENG-20 tam-onay paritesi): yeni motorlar da tam-otomatik girer. Bu motor bugün DB\'de KAPALI olduğu için bayraklar hiçbir pane\'e gitmiyor; hesap bağlanınca parite hazır',
    }),

    // ─── 1. KAPI — KİMLİK: BAYRAK → DİZİN → MOTORUN DAYATTIĞI DOSYA ADI ────
    //
    // ENG-17'nin hükmü ("per-launch sistem-prompt bayrağı YOK ⇒ aynı dizinde iki
    // pane iki AYRI kimlik ALAMAZ") ENG-ENABLE-01'de CANLI ÇÜRÜDÜ. Ölçüm
    // (cursor-agent 2026.09.02, `docs/agent-results/ENG-ENABLE-01-evidence/`):
    //   • AYNI cwd, iki ayrı `--add-dir <dizin>` (her birinde `AGENTS.md`) →
    //     birinci koşu "ALFA7", ikinci koşu "BETA9" ⇒ pane BAŞINA kimlik ÇALIŞIYOR.
    //   • cwd'de de bir proje `AGENTS.md`i varken ajan İKİSİNİ birden saydı
    //     ("GAMMA3, BETA9") ⇒ taşıyıcı ADDITIVE: motorun kendi kuralları ve
    //     kullanıcının repo kuralları KORUNUR (gemini/kimi REPLACE tuzağı YOK).
    //     Bu yüzden `replacesSystemPrompt` YAZILMADI ve `basePrompt` reçetesi
    //     GEREKMİYOR.
    //   • Aynı koşuda araç kullanımı da doğrulandı (ajan `proof.txt` yazdı).
    //
    // 🪤 GİZLİ `--system-prompt <file>` BAYRAĞI VAR AMA KULLANILMAZ: ikilinin
    // yardımından GİZLENMİŞ (`hideHelp()`) ve kendi açıklaması "Replace system
    // prompt with contents of file (Anysphere/OpenAI team only)" diyor — hem
    // REPLACE hem SATICI-KISITLI. Motorun sistem prompt'u SUNUCUDA olduğu için
    // taban geri kazanma reçetesi de yazılamaz ⇒ bilerek seçilmedi.
    identity: Object.freeze({
      kind: 'flag-dir',
      flag: '--add-dir',
      position: 'append',
      fileName: 'AGENTS.md', // ad MOTORUN dayatması (bundle: {"AGENTS.md","CLAUDE.md","CLAUDE.local.md"})
      fileSuffix: '.md',
      cap: Object.freeze({ cli: null, file: 'FILE_MAX' }),
      resumeReinject: false, // `--resume` kimliği yeniden vermez; dizin yine bayrakla gider
      replacesSystemPrompt: false,
      cwdFirst: false, // ölçüldü: cursor'da araçların cwd'si `--add-dir`den ETKİLENMEDİ
    }),

    model: Object.freeze({ kind: 'flag', flag: '--model', position: 'append' }),
    images: null,
    provider: null,

    // OTURUM — 🔑 KİMLİĞİ BİZ BASAMAYIZ ama motor BASTIRABİLİR: `create-chat`
    // ("Create a new empty chat and return its ID") boş bir sohbet açıp id DÖNER →
    // `--resume <chatId>` ile o id'ye bağlanılır. Yani ADP-192'nin restart-resume
    // yolu bu motorda "iki adımlı mint" olarak MÜMKÜN; ölçüm hesap duvarında kaldı.
    session: Object.freeze({
      mint: null,
      flag: null,
      killSwitchEnv: null,
      resume: Object.freeze({
        form: 'append',
        flag: '--resume',
        idShape: 'engine-minted',
        mintArgv: Object.freeze(['create-chat']),
        lastFallback: Object.freeze(['--continue']),
      }),
    }),

    // TOKEN-BUDGET-01 — BAĞLAM KAPSAMI: bu motorun kendi belge enjeksiyonunu
    // (proje talimatı zinciri + kalıcı hafıza indeksi) ÇALIŞMA ALANIYLA sınırlayan
    // bir taşıyıcı ÖLÇÜLMEDİ. `null` = bugünkü davranış aynen sürer; kesim yalnız
    // beyan eden motorda uygulanır (paneContextScope HEPSİ-YA-HİÇ kuralı).
    contextScope: null,
    subagentBlock: null,
    trust: Object.freeze({ kind: 'flag', flag: '--trust', position: 'append' }),
    reset: null,
    tui: null,

    // ─── 2. KAPI — ARAÇ BAĞLAMA: YALNIZ KALICI CONFIG DOSYASI ──────────────
    mcp: Object.freeze({
      kind: 'config-only',
      configFile: '.cursor/mcp.json (proje) · ~/.cursor/mcp.json (genel)',
      flag: null,
      strictFlag: null,
      approveFlag: '--approve-mcps',
      envInheritance: false, // 🔑 ÖLÇÜLDÜ (aşağıda) — sır MCP çocuğuna env ile GEÇMEZ
      position: null,
    }),

    hooks: null,
    extraRoots: Object.freeze({ kind: 'flag', flag: '--add-dir', repeat: true, position: 'append' }),
    skillsDir: null,
    identityEnv: null,

    auth: Object.freeze({
      label: 'Cursor',
      accountHint: 'Cursor hesabı — EDİTÖRLE PAYLAŞIMLI oturum: Cursor uygulamasından çıkış yaparsan bu ajan da durur',
      signupUrl: 'https://cursor.com/dashboard',
      // 🔴 `external`: giriş CrewPane DIŞINDA yapılır. `cursor-agent login` TARAYICI
      // açar (NO_OPEN_BROWSER ile kapanır ama akış yine tarayıcıdadır) ve jeton
      // editörle AYNI depoya yazılır → ürün yalnız DURUMU okur, akışı sürmez.
      flow: 'external',
      needsCode: false,
      loginArgv: Object.freeze(['login']),
      logoutArgv: Object.freeze(['logout']),
      // 🔑 MAKİNE-OKUNUR DURUM: rozet üçüncü duruma ("bilinmiyor") düşmek zorunda değil.
      statusArgv: Object.freeze(['status', '--format', 'json']),
      statusParse: 'json',
      // ENG-CURSOR-APIKEY-01 — bu alan defterde ENG-17'den beri vardı ama engineAuth
      // onu hiç OKUMUYORDU (parseJsonStatus yalnız `loggedIn`e bakıyordu) → tarayıcıdan
      // girişli kullanıcı bile rozette "bağlı değil" görüyordu (18.09 ölçümü: gerçek
      // oturumlu makinede `{"isAuthenticated":true}` → loggedIn:false). Artık okunur.
      statusField: 'isAuthenticated',
      // 🔑 ANAHTAR DOĞRULAMA KOMUTU (ENG-CURSOR-APIKEY-01, ölçüldü 18.09, 2026.09.15-d2fe57e):
      // `status` da `about` da CURSOR_API_KEY'i HİÇ OKUMAZ — ikisi de yalnız kayıtlı
      // oturum jetonuna bakar (3442.index.js / 5211.index.js: getAccessToken &&
      // getRefreshToken). Anahtarı okuyan TEK yol sohbet başlangıcındaki auth kapısı
      // (1730.index.js loginWithApiKey). `--list-models` o kapıdan geçer ama MODEL
      // ÇAĞRISI YAPMAZ: geçersiz anahtar → çıkış 1 + "⚠ Warning: The provided API key
      // is invalid." (oturum varken bile gölgelenmez); geçerli → çıkış 0 + "Available
      // models" listesi. Yan etki (satıcı tasarımı): geçerli anahtar jetona çevrilip
      // editörle paylaşımlı depoya yazılır → sonrasında `status` da yeşil döner.
      apiKeyVerifyArgv: Object.freeze(['--list-models']),
      // 🔴 `external` akışında giriş komutu BEYAN edilir ama ÜRÜN SÜRMEZ:
      externalNote:
        'ÖLÇÜLDÜ: `cursor-agent login` TARAYICI açar (NO_OPEN_BROWSER ile açmaz ama akış yine tarayıcıdadır) ve jetonu EDİTÖRLE PAYLAŞILAN depoya yazar. Ürün bu akışı süremez ve sürmemelidir: kullanıcı Cursor uygulamasından çıkış yaptığında ajan da DURUR — bağımlılık BİZİM kontrolümüz DIŞINDADIR. Rozet bunu SÖYLER, düğme "Cursor\'da giriş yap" der',
      apiKey: Object.freeze({
        env: 'CURSOR_API_KEY',
        vaultService: 'crewpane-cursor-api-key',
        keyUrl: 'https://cursor.com/dashboard?tab=integrations',
        keyLabel: 'Cursor API anahtarı',
        // 🪤 Bu metin Ayarlar'da anahtar kutusunun yanında OLDUĞU GİBİ çizilir (ENG-20):
        // kullanıcı cümlesi olmalı, ölçüm defteri değil. Ölçümler (18.09): anahtarsız +
        // oturumsuz koşu "Authentication required. Please run 'agent login' first, or set
        // CURSOR_API_KEY environment variable." ile hemen ölür (boş pane değil); doğrulama
        // `--list-models` ile (model çağrısı yok); kabul edilen anahtarı Cursor jetona
        // çevirip editörle paylaşılan depoya yazar.
        note:
          'Abonelik birincil yoldur (terminalde cursor-agent login). Anahtar yedek yoldur: kaydedilmeden önce Cursor\'un kendi komutuyla denenir, model çağrısı yapılmaz. Kabul edilen anahtarı Cursor bir oturuma çevirir ve Cursor uygulamasıyla paylaşılan hesap kaydına yazar; Cursor\'dan çıkış yaparsan bu ajan da durur',
      }),
    }),

    // 4. KAPI — KULLANIM: defter de rapor da YOK (ölçüldü) → alan `null`, gerekçe
    // `unsupported.usage`ta. Boş bir `kind:'none'` kaydı yazmak "ölçtük, sonuç sıfır"
    // ile "hiç yok"u aynı şeye çevirirdi.
    usage: null,

    // 3. KAPI — SÜPERVİZÖR: JSON + akış (hesap duvarı nedeniyle GÖVDE ölçülemedi).
    output: Object.freeze({
      kind: 'json',
      flag: '--output-format',
      values: Object.freeze(['text', 'json', 'stream-json']),
      quietFlag: null,
      requiresQuiet: false,
      requiresFlag: '--print',
      claudeCompatible: false,
    }),

    install: Object.freeze({
      label: 'Cursor CLI',
      command: 'curl -fsSL https://cursor.com/install | bash',
      // WIN-PARITY-01 — ölçüldü (09.09): satıcının belgelenmiş Windows komutu.
      // Gerekçe + elenen iki aday: engineInstall.cjs `cursor` kaydı.
      win32Command: 'powershell -ExecutionPolicy ByPass -c "irm \'https://cursor.com/install?win32=true\' | iex"',
      docsUrl: 'https://cursor.com/docs/cli/overview',
      checkHint: 'https://cursor.com/docs/cli/overview',
      installsTo: '~/.local/bin',
      verifyArgv: Object.freeze(['--help']), // `--version` yalnız "2026.08.11-e8db854" basar
      verifyPattern: 'Start\\s+the\\s+Cursor\\s+Agent',
    }),

    // CDX-F1 — efor kolu bu motorda BEYAN EDİLMEDİ (gerekçe: unsupported.effort).
    effort: null,

    unsupported: Object.freeze({
      contextScope:
        'bu motorun kendi belge enjeksiyonunu (proje talimatı zinciri + kalıcı hafıza indeksi) çalışma alanıyla sınırlayan bir taşıyıcı ÖLÇÜLMEDİ — kesim yalnız beyan eden motorda koşar, burada bugünkü davranış aynen sürer (TOKEN-BUDGET-01)',
      effort:
        'efor/akıl-yürütme seviyesi taşıyıcısı BU MOTORDA ÖLÇÜLMEDİ — CDX-F1 kapsamı bilerek codex (+claude beyanı) ile sınırlı tutuldu; beyan edilene kadar per-launch efor override\'ı YOKTUR ve motor kendi varsayılanıyla koşar (sessiz kayıp değil, ölçülmemiş kol)',
      images:
        'tam seçenek listesinde görsel/attachment bayrağı YOK → görsel yolu prompt METNİNE gömülmeli; per-launch bir ek yok',
      provider:
        'sağlayıcı seçimi ürünün BYOK grameriyle (providers.cjs, codex `-c` override\'ı) uyuşmuyor: burada yalnız `--endpoint`/`bedrock` var ve ikisi de ÖLÇÜLMEDİ',
      subagentBlock:
        '🔴 ALT-AJAN KAPISI ÖLÇÜLEMEDİ: `cli-config.json` içinde `exploreSubagentModel` alanı VAR (yani alt-ajan yüzeyi var) ama onu KAPATAN bir bayrak/ayar anahtarı bulunamadı ve hesap duvarı nedeniyle canlı denenemedi → blok VAR gibi beyan etmek, olmayan bir korumayı VAR sanmaktır',
      hooks:
        'tur-başı brifing enjekte eden per-launch kanca yüzeyi yok; `--plugin-dir` bir EKLENTİ yükler ve içeriğinin prompt\'a ne kattığı ÖLÇÜLMEDİ → ADP-692 brifingi bu motorda argv ile KURULAMAZ',
      skillsDir:
        'skill dizini bayrağı/ayarı seçenek listesinde YOK ve `--plugin-dir` bir skill dizini DEĞİLDİR → ürünün skill kitaplığı bu pane\'e taşınamaz',
      identityEnv:
        '🔑 `CURSOR_DATA_DIR` ÖLÇÜLDÜ ve DURUM dizinini taşıyor (MCP onayları `<DATA_DIR>/projects/<slug>/mcp-approvals.json`e yazıldı, `~/.cursor` DEĞİŞMEDİ) — ama KİMLİK/JETON deposunu da taşıyıp taşımadığı hesapsız makinede AYIRT EDİLEMEDİ. Ölçülmemiş bir izolasyona "çoklu hesap" demek, iki profili aynı jetona bağlayıp kullanıcıya ayrı sanmasını söylemek olurdu → alan null',
      usage:
        '🔑 ÖLÇÜLDÜ ve YOK: motorun `about --format json` çıktısı jeton/maliyet ALANI TAŞIMIYOR (cliVersion/model/subscriptionTier/osPlatform/userEmail/lastRequestId) ve headless koşuda jeton basan bir uç görülmedi → jeton kartı bu motorda "bilinmiyor" der, TAHMİN ETMEZ',
      reset:
        'pane RESET slash komutu gerçek TUI oturumunda ölçülmedi (hesapsız makinede TUI giriş ekranına düşüyor) → var olmayan bir komut göndermek pane\'e sessizce metin yazardı',
      tui:
        'TUI hazır/blocker dizeleri ölçülmedi (hesap duvarı) → paneReadiness regex\'i YOK',
    }),

    partial: Object.freeze({
      mcp:
        '🪤 ÖLÇÜLDÜ — ARAÇ YÜZEYİ ÇALIŞIYOR ama PANE BAŞINA DEĞİL: `.cursor/mcp.json` (cwd) okundu, `cursor-agent mcp enable eng17` sonrası sunucu GERÇEKTEN başlatıldı ve initialize→tools/list konuştu. Ancak (a) config yolu SABİT: `CURSOR_DATA_DIR` yalnız ONAY defterini taşıyor (ölçüldü: onay `<DATA_DIR>/projects/<slug>/mcp-approvals.json`e yazıldı, `mcp.json` yine `.cursor/`den okundu — boş cwd\'de "No MCP servers configured (expected in .cursor/mcp.json or ~/.cursor/mcp.json)"), (b) MCP çocuğu pane env\'ini MİRAS ALMIYOR (ölçüldü: pane\'de ENG17_TAG=cursor-export iken çocuk "notag" yazdı; AYNI probda kimi "kimi-export" yazdı) → aynı cwd\'deki iki pane\'e AYRI araç seti verilemez ve dosya kullanıcının repo\'suna yazılır',
      session:
        'devam yolu VAR (`--resume [chatId]`, `--continue`, `ls`) ve `create-chat` id ÜRETİYOR (iki adımlı mint yolu) ama hiçbiri hesap duvarı nedeniyle KOŞTURULAMADI → restart-resume bu motorda bugün KURULAMAZ',
      model:
        'ENG-ENABLE-01 — liste artık ÖLÇÜLDÜ (`--list-models`, 200+ model). 🔴 AMA PLANA BAĞLI: ücretsiz planda ADLI model REDDEDİLİYOR ("Named models unavailable Free plans can only use Auto") ve bu, kullanıcının `~/.cursor/cli-config.json` içinde KAYITLI adlı modeli varsa BAYRAKSIZ headless koşuyu da düşürür. İnteraktif pane bu tuzağa DÜŞMEZ (ölçüldü: pane "Auto" ile açıldı) → ürün model SEÇMEZ, motorun kendi varsayılanını bırakır',
      trust:
        'ENG-ENABLE-01 — KAPI GERÇEK VE ÖLDÜRÜCÜ (ölçüldü): bayraksız koşu "⚠ Workspace Trust Required … Pass --trust, --yolo, or -f" ile DURDU. `--trust` zaten `defaultArgs`ta olduğu için ürünün pane\'i bu kapıya takılmıyor; kolu çekip bayrağı kaldıran biri ESKİ arızayı geri getirir',
      extraRoots:
        'ENG-ENABLE-01 — ek kökün OKUNDUĞU canlı doğrulandı (`--add-dir <dizin>`/AGENTS.md kimliği modele ulaştı). 🪤 AYNI bayrak kimlik taşıyıcısıdır: `identity.kind:\'flag-dir\'` ile ADP-237 hafıza kökü aynı bayrağı paylaşır — ikisi de append, çakışma yok, ama bayrağı değiştiren biri İKİSİNİ birden kırar',
      output:
        '`--output-format text|json|stream-json` (+`--stream-partial-output`) seçenek listesinde VAR ve yalnız `--print` ile çalışır; GERÇEK gövde hesap duvarı nedeniyle ölçülemedi → süpervizör okuyucusu bu motora BAĞLANMADI',
      auth:
        'ENG-ENABLE-01 — GİRİŞ YAPILDI ve ölçüldü (`cursor-agent status` → "✓ Logged in as <hesap>"); jetonlar sistem anahtar zincirinde (`cursor-access-token`/`cursor-refresh-token`). 🔴 SINIR AYNEN DURUYOR: depo editörle PAYLAŞIMLI — kullanıcı Cursor\'dan çıkış yaparsa ajan DURUR ve bu bizim kontrolümüz DIŞINDADIR. 🪤 PLAN da bir kapıdır: ücretsiz planda yalnız "Auto" modeli koşar (bkz. partial.model)',
    }),

    verification: Object.freeze({
      contextScope: Object.freeze({ channel: 'unverified', source: 'TOKEN-BUDGET-01 — bu motorda belge-enjeksiyonunu kapatan bir bayrak ARANMADI/ÖLÇÜLMEDİ; kesim yalnız beyan eden motorda koşar' }),
      effort: Object.freeze({ channel: 'unverified', source: 'CDX-F1: bu motorda efor bayrağı ARANMADI/ölçülmedi (kapsam: codex + claude)' }),
      identity: Object.freeze({ channel: 'measured', source: 'ENG-ENABLE-01-evidence/cursor-identity.txt — AYNI cwd\'de iki `--add-dir` dizini iki AYRI kod kelimesi verdi (ALFA7 / BETA9) ve cwd\'deki proje AGENTS.md\'i KORUNDU (ajan "GAMMA3, BETA9" saydı) → per-pane kimlik + ADDITIVE. ENG-17\'nin "taşıyıcı yok" hükmü çürüdü' }),
      model: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/cursor-help.txt — `--model <model>  Model to use (e.g., gpt-5, sonnet-4-thinking)`' }),
      images: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/cursor-help.txt — tam seçenek listesinde görsel bayrağı yok' }),
      provider: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/cursor-help.txt — `-e/--endpoint`, `bedrock` alt-komutu; providers.cjs grameriyle eşleşmiyor' }),
      session: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/cursor-subhelp.txt — `create-chat  Create a new empty chat and return its ID` + `--resume [chatId]` + `--continue`' }),
      subagentBlock: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/cursor-cli-config.json — `exploreSubagentModel` alanı VAR; kapatan anahtar/bayrak seçenek listesinde ve config\'te YOK' }),
      trust: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/cursor-argv-probe.txt — `--trust` argv parse\'ını geçti (hesap duvarına düştü), uydurma bayrak REDDEDİLDİ' }),
      reset: Object.freeze({ channel: 'unverified', source: 'TUI açılamadı (hesap duvarı) → alan null' }),
      tui: Object.freeze({ channel: 'unverified', source: 'TUI açılamadı (hesap duvarı) → alan null' }),
      mcp: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/cursor-mcp.txt — `mcp list` → "eng17: not loaded (needs approval)" → `mcp enable eng17` → "eng17: ready" + kanıt sunucusu GERÇEKTEN başladı (initialize/tools-list); CURSOR_DATA_DIR yalnız onayı taşıdı' }),
      hooks: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/cursor-help.txt — `--plugin-dir <path>`; tur-başı kanca bayrağı yok' }),
      extraRoots: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/cursor-help.txt — `--add-dir <path>  Add an additional workspace root directory (can be specified multiple times)`' }),
      skillsDir: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/cursor-help.txt — tam seçenek listesinde skill dizini yok' }),
      identityEnv: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/cursor-mcp.txt — CURSOR_DATA_DIR=/tmp/eng17/cdata ile onay `<DATA_DIR>/projects/private-tmp-eng17-ctour/mcp-approvals.json`e yazıldı; `~/.cursor/projects` DEĞİŞMEDİ' }),
      auth: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/cursor-status.txt — `status --format json` gerçek çıktı + `-p` koşusunun hesap duvarı mesajı' }),
      usage: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/cursor-status.txt — `about --format json` tam çıktı: jeton/maliyet alanı YOK' }),
      output: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/cursor-help.txt — `--output-format <format>  Output format (only works with --print): text | json | stream-json`' }),
      install: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/cursor-install.sh (script OKUNDU) + gerçek kurulum: ~/.local/bin/cursor-agent → versions/2026.08.11-e8db854; `--version` → "2026.08.11-e8db854" (ürün adı YOK) → kalıp `--help` gövdesinden' }),
    }),
  }),

  // ───────────────────────────────────────────────────────────────────────────
  // ENG-17 — KİMİ CODE CLI (`kimi`, 0.36.1). ENG-R2 §3 satır 12 (D) idi ve ÜÇ
  // varsayımı ölçüm ÇÜRÜTTÜ:
  //   ① "sistem-prompt bayrağı YOK" → VAR: `--agent-file <md>` (ve REPLACE!)
  //   ② "MCP yalnız /mcp-config KONUŞARAK, otomasyon riski" → `$KIMI_CODE_HOME/mcp.json`
  //      pane BAŞINA çalışıyor (kanıt sunucusu spawn+initialize+tools/list+tools/call)
  //   ③ "kurulum resmî installer script'i" → npm paketi VAR ve resmîdir
  //      (`@moonshot-ai/kimi-code`, satıcının KENDİ script'i musl dalında öneriyor)
  //
  // 🪤 ÜÇ AYRI TEDARİK-ZİNCİRİ TUZAĞI (üçü de ÖLÇÜLDÜ — `engineInstall` kapısı):
  //   • `npm i -g kimi-code` → ÜÇÜNCÜ TARAF ("A CLI tool that starts anthropic-proxy
  //     with Kimi model and runs claude-code", github.com/whitesmith)
  //   • `curl … code.kimi.com/install.sh` → ESKİ Python `kimi-cli` (script'in KENDİ
  //     başlığı: "Legacy kimi-cli (Python) installer - DEPRECATED") ve BORU İÇİNDE
  //     (yani ürünün göstereceği hâlde) SORU SORMADAN eskisini kurar
  //   • Doğru satıcı script'i `code.kimi.com/kimi-code/install.sh`tir ama ~/.kimi-code'a
  //     kurar + KABUK RC DOSYASINI DEĞİŞTİRİR + PATH'teki eski `kimi`yi TAŞIR/SİLER
  //   → katalog npm yolunu kullanır: sudo yok, rc'ye dokunmaz, ~/.local/bin'e kurar.
  //
  // 🔴 BU MOTOR ÜRÜNDE KAPALI: kimlik taşıyıcısı REPLACE (aşağıdaki reçete ölçüldü
  // ama ürüne BAĞLANMADI) ve Moonshot hesabı yok. Aşağıdaki her alan ÖLÇÜMDÜR.
  kimi: Object.freeze({
    id: 'kimi',
    // 🔑 ETİKET AYRIMI (ENG-R2 §6-S2): `moonshot` = codex-ALTI sağlayıcı modeli
    // (providers.cjs, "Kimi (Moonshot) — model"), `kimi` = BAĞIMSIZ MOTOR. İkisi
    // UI'da yan yana görünür; etiketler bilerek AYRIŞTIRILDI.
    label: 'Kimi Code (motor)',
    bin: 'kimi',

    // 🔴 ENG-ENABLE-01 — ENG-17'NİN OTONOMİ HÜKMÜ YANLIŞ KAPSAMDAYDI (ENG-13 v5 dersi:
    // "kapıyı ALT-KOMUT başına ölç — pane hangi komutu açıyor?").
    // ENG-17 otonomiyi HEADLESS (`-p`) kipte ölçmüştü ve orada gerçekten tam otonom:
    // motorun kendi defteri `permission.set_mode: auto` yazıyor. AMA ÜRÜN PANE'İ
    // İNTERAKTİF AÇIYOR ve orada durum BAŞKA: gerçek pane'de ajan `Write` aracına
    // gelince "▶ Write this file? 1. Approve once / 2. Approve for this session /
    // 3. Reject" diyaloğu açtı ve İŞ ORADA DURDU (transkript:
    // ENG-ENABLE-01-evidence/kimi-pane-live.txt). Yani `defaultArgs: []` ENG-20
    // tam-onay paritesini bu motorda SESSİZCE UYGULAMIYORDU.
    // `--auto` ("fully autonomous, the agent will not ask questions") yalnız
    // `--prompt` ile birleşemiyor; ürün pane'de `--prompt` KULLANMIYOR (headless
    // yolu bugün hiçbir yerde kurulmuyor — `output.requiresFlag` yalnız BEYAN).
    defaultArgs: Object.freeze(['--auto']),

    autonomy: Object.freeze({
      level: 'full',
      via: 'argv',
      flags: Object.freeze(['--auto']),
      measured:
        'ENG-ENABLE-01 İKİ YÖNLÜ, GERÇEK PANE: (a) bayraksız pane\'de `Write` aracı ONAY DİYALOĞU açtı ve tur orada durdu (kimi-pane-live.txt); (b) `--auto` ile AYNI görev onaysız tamamlandı ve dosya diske yazıldı. ENG-17\'nin (headless) ölçümü de geçerliliğini koruyor: `-p` kipinde defter zaten `permission.set_mode: auto` yazıyor ve `-p` + `--auto` motor tarafından REDDEDİLİYOR',
      why:
        'Eren kararı 2026-08-18 (ENG-20 tam-onay paritesi) pane\'de de uygulanmalı. `--yolo` yerine `--auto` seçildi: `--yolo` yalnız "regular tool calls"u onaylıyor ve motorun kendi metniyle "the agent may still ask questions" diyor — yani akış yine kesilebilirdi',
    }),

    // ─── 1. KAPI — KİMLİK: PER-LAUNCH BAYRAK, ama 🔴 REPLACE ────────────────
    // ÖLÇÜLDÜ (motorun KENDİ defterinden, `profile.bind.systemPrompt` uzunluğu):
    //   kimliksiz koşu → 20.910 karakter (motorun gömülü prompt'u)
    //   `--agent-file` → 93 karakter (= yalnız BİZİM dosyamızın gövdesi)
    // Yani bayrak ADI "agent file" olsa da davranış gemini `GEMINI_SYSTEM_MD` ile
    // AYNI SINIF: gömülü kurallar SİLİNİR. ENG-14 disiplini burada da geçerli.
    identity: Object.freeze({
      kind: 'flag',
      flag: '--agent-file',
      position: 'append',
      fileName: 'crewpane-identity.md',
      fileSuffix: '.md',
      // Dosya YAML frontmatter taşır; `name` profil adı olur (defterde `profileName`),
      // `disallowedTools` ise SERT alt-ajan bloğunun taşıyıcısıdır (aşağıya bak).
      frontmatterFields: Object.freeze(['name', 'description', 'tools', 'disallowedTools', 'subagents']),
      cap: Object.freeze({ cli: null, file: 'FILE_MAX' }),
      resumeReinject: false, // 🪤 ÖLÇÜLDÜ: bayrak `--session`/`--continue` ile BİRLEŞEMİYOR
      replacesSystemPrompt: true,
      // ─── GÖMÜLÜ PROMPTU GERİ KAZANMA REÇETESİ (ÖLÇÜLDÜ, JETON MALİYETİ SIFIR) ───
      // Motor HER koşuda efektif sistem prompt'unu KENDİ oturum defterine yazar
      // (`<home>/sessions/<wd>/<sessionId>/agents/main/wire.jsonl`, satır
      // `{"type":"profile.bind","systemPrompt":"…"}`) — ve bunu MODEL ÇAĞRISI
      // BAŞARISIZ OLSA BİLE yazar. Reçete: geçersiz anahtarlı bir PROBE ev diziniyle
      // bir kez koş → sağlayıcı 400 döner ("API key not valid"), taban prompt defterde.
      basePrompt: Object.freeze({
        kind: 'ledger-dump',
        homeEnv: 'KIMI_CODE_HOME',
        ledgerGlob: 'sessions/*/session_*/agents/main/wire.jsonl',
        recordType: 'profile.bind',
        field: 'systemPrompt',
        probeArgv: Object.freeze(['-p', 'x', '--output-format', 'text']),
        // ENG-ENABLE-01 — REÇETE ÜRÜNE BAĞLANDI (engineBasePrompt `ledger-dump`).
        // Anahtar env'de DEĞİL config.toml'da yaşıyor → prob evine ULAŞILAMAZ bir
        // sağlayıcı yazılır: model turu OLMAZ, AĞA ÇIKILMAZ (127.0.0.1'de kapalı
        // port) ve defter yine de yazılır. 🪤 `default_model` TABLOLARDAN ÖNCE
        // gelmeli — dosyanın sonuna eklenen satır son `[models."…"]` tablosunun
        // İÇİNE düşüyor ve motor "No model configured" diyor (ölçüldü) → şablon
        // TEK PARÇA yazılır, mevcut bir dosyaya eklenmez.
        probeConfig: Object.freeze({
          file: 'config.toml',
          template: [
            'default_model = "crewpane-probe/model"',
            '',
            '[providers.crewpane-probe]',
            'base_url = "http://127.0.0.1:9/v1"',
            'type = "openai"',
            'api_key = "crewpane-base-prompt-probe-invalid"',
            '',
            '[models."crewpane-probe/model"]',
            'provider = "crewpane-probe"',
            'model = "probe"',
            'max_context_size = 8192',
            'max_output_size = 1024',
            '',
          ].join('\n'),
        }),
        cost: 'auth-rejected', // ÖLÇÜLDÜ: model turu YOK (401/bağlantı reddi), defter YAZILDI
        timeoutMs: 45000,
        cacheBy: Object.freeze(['version', 'cwd']), // taban cwd'ye BAĞLI (araç seti + tarih)
        onFailure: 'skip-identity', // reçete düşerse kimlik YAZILMAZ (fail-closed)
        measured:
          'ENG-ENABLE-01 (2026-09-09, kimi 0.36.1): prob evinde ulaşılamaz sağlayıcı → `profile.bind.systemPrompt` 21.003 karakter; gerçek anahtar duvarında (401) da AYNI kayıt yazıldı. Kanıt: ENG-ENABLE-01-evidence/kimi-baseprompt.txt',
      }),
    }),

    model: Object.freeze({
      kind: 'flag',
      flag: '--model',
      position: 'append',
      // Değer ŞEKLİ `provider/model` (ölçüldü: `kimi provider list --json` anahtarları,
      // ör. "google/gemini-flash-latest", "groq/openai/gpt-oss-120b").
      detect: Object.freeze({ kind: 'toml-config', field: 'default_model', files: Object.freeze(['<KIMI_CODE_HOME>/config.toml']) }),
    }),

    images: null,
    provider: Object.freeze({
      kind: 'cli-command',
      argv: Object.freeze(['provider', 'catalog', 'add']),
      keyFlag: '--api-key',
      baseUrlFlag: '--base-url',
      defaultModelFlag: '--default-model',
      listArgv: Object.freeze(['provider', 'list', '--json']),
    }),

    // OTURUM — kimliği MOTOR basar ama ÇIKTIDA SÖYLER (claude'un mint'i kadar iyi
    // değil, opencode'unkinden İYİ): stream-json son satırı
    // {"type":"session.resume_hint","session_id":"session_<uuid>","command":"kimi -r <id>"}
    session: Object.freeze({
      mint: null,
      flag: null,
      killSwitchEnv: null,
      resume: Object.freeze({
        form: 'append',
        flag: '--session',
        idShape: 'engine-minted',
        idFrom: 'output', // 🔑 id ÇIKTIDA yayınlanıyor → süpervizör eşlemesi KESİN olabilir
        idField: 'session.resume_hint.session_id',
        lastFallback: Object.freeze(['--continue']),
      }),
    }),

    // 🔑 SERT ALT-AJAN BLOĞU VAR — argv'de değil, KİMLİK DOSYASININ FRONTMATTER'ında.
    // ÖLÇÜLDÜ (motorun KENDİ defteri): frontmatter `disallowedTools: Agent, AgentSwarm`
    // → `profile.bind.disallowedTools:["Agent","AgentSwarm"]` ve MODELE GİDEN araç
    // listesinde (`llm.tools_snapshot`) `Agent`/`AgentSwarm` YOK (MCP aracı VAR).
    // TOKEN-BUDGET-01 — BAĞLAM KAPSAMI: bu motorun kendi belge enjeksiyonunu
    // (proje talimatı zinciri + kalıcı hafıza indeksi) ÇALIŞMA ALANIYLA sınırlayan
    // bir taşıyıcı ÖLÇÜLMEDİ. `null` = bugünkü davranış aynen sürer; kesim yalnız
    // beyan eden motorda uygulanır (paneContextScope HEPSİ-YA-HİÇ kuralı).
    contextScope: null,
    subagentBlock: Object.freeze({
      args: Object.freeze([]),
      via: 'identity-frontmatter',
      configPath: 'disallowedTools',
      value: Object.freeze(['Agent', 'AgentSwarm']),
      position: 'append',
      dedupeToken: null,
      measured:
        'ENG-17: frontmatter `disallowedTools: Agent, AgentSwarm` → defterde profile.bind.disallowedTools=["Agent","AgentSwarm"] ve llm.tools_snapshot (modele giden liste) 24 araç içeriyor, Agent/AgentSwarm HİÇBİRİ yok; kontrol koşusunda (bloksuz) aynı listede ikisi de VARDI',
    }),

    // ─── AÇILIŞ KAPISI — GÜVEN DİYALOĞU (ENG-ENABLE-01'de ÖLÇÜLDÜ) ─────────
    // ENG-17 "güven kapısı görülmedi" demişti; GERÇEK PANE açılınca görüldü:
    // taze bir cwd'de "Trust this folder?" diyaloğu çıkıyor ve imleç VARSAYILAN
    // olarak "Don't trust — Exit Kimi Code"ta duruyor → ürünün yazdığı ilk metin
    // diyaloğa gidiyor, Enter ÇIKIŞI seçiyor, pane "Bye!" deyip ÖLÜYOR.
    // Bayrak YOK (tam seçenek listesi ölçüldü); karar yalnız dosyada yaşıyor:
    //   `<home>/workspace-trust/wd_<slug(basename)>_<sha256(mutlak yol)[0:12]>`
    // Anahtar şekli ikilinin KENDİ kodundan okundu (workdir-key.ts: prefix `wd_`,
    // hash 12, slug 40 karakter) ve gerçek dosyayla doğrulandı.
    trust: Object.freeze({
      kind: 'state-file',
      homeScope: 'engine-home', // dizini KIMI_CODE_HOME (hesap profili) belirler
      homeEnv: 'KIMI_CODE_HOME',
      homeFallback: Object.freeze(['.kimi-code']),
      dir: 'workspace-trust',
      keyPrefix: 'wd_',
      measured:
        'ENG-ENABLE-01: gerçek pty transkripti (ENG-ENABLE-01-evidence/kimi-pane.txt) diyaloğu ve "Bye!" ile ölümü gösteriyor; elle "Trust this folder" seçilince `~/.kimi-code/workspace-trust/wd_kimi_180a05f5b591` dosyası oluştu ve gövdesi {"root":…,"trustedAt":…} çıktı — hash sha256(mutlak yol)[0:12] ile birebir',
    }),
    reset: null,
    tui: null,

    // ─── 2. KAPI — ARAÇ BAĞLAMA: PANE EVİNİN İÇİNDEKİ mcp.json ─────────────
    // 🔑 ÖLÇÜLDÜ (kanıt sunucusu diske işaret bırakıyor): KIMI_CODE_HOME pane başına
    // ayrıldığında `<home>/mcp.json` okunuyor, sunucu BAŞLATILIYOR ve tam MCP el
    // sıkışması oluyor (initialize → notifications/initialized → tools/list →
    // tools/call). Araçlar modele `mcp__<server>__<tool>` adıyla gidiyor (claude grameri).
    mcp: Object.freeze({
      kind: 'env-config-dir',
      env: 'KIMI_CODE_HOME',
      configFileName: 'mcp.json',
      configPath: 'mcpServers',
      serverEnvPath: 'env',
      strictFlag: null,
      envInheritance: true, // 🔑 ÖLÇÜLDÜ: pane env'i MCP çocuğuna GEÇTİ (ENG17_TAG çocukta okundu)
      position: 'append',
    }),

    hooks: null,
    extraRoots: Object.freeze({ kind: 'flag', flag: '--add-dir', repeat: true, position: 'append' }),
    skillsDir: null,
    identityEnv: 'KIMI_CODE_HOME',

    auth: Object.freeze({
      label: 'Kimi Code',
      accountHint: 'Moonshot / Kimi hesabı (code.kimi.com) — ya da kendi sağlayıcı anahtarın (`kimi provider catalog add`)',
      signupUrl: 'https://code.kimi.com/',
      // 🔑 5. AKIŞ ŞEKLİ: CİHAZ-KODU. CLI bir kod GÖSTERİR, kullanıcı tarayıcıda
      // onaylar, CLI YOKLAR. claude'un "kodu YAPIŞTIR"ından farklıdır: stdin'e
      // hiçbir şey yazılmaz → kod kutusu ÇİZİLMEMELİ.
      flow: 'device-code',
      needsCode: false,
      loginArgv: Object.freeze(['login']),
      logoutArgv: null,
      statusArgv: null,
      statusParse: null,
      statusNote:
        'ÖLÇÜLDÜ: komut listesinde makine-okunur bir hesap DURUMU komutu YOK (`doctor` yalnız config dosyalarını doğrular; `provider list` sağlayıcıları sayar, OTURUMU değil) → rozet ÜÇÜNCÜ durumu (BİLİNMİYOR) gösterir. Girişsiz koşunun ölçülen cümlesi: "No model configured. Run `kimi` and use /login to sign in, then retry; or set default_model in config.toml."',
      apiKey: Object.freeze({
        env: 'MOONSHOT_API_KEY',
        vaultService: 'crewpane-kimi-api-key',
        keyUrl: 'https://platform.moonshot.ai/console/api-keys',
        keyLabel: 'Moonshot API anahtarı',
        note:
          'Abonelik/cihaz-kodu BİRİNCİL yoldur; anahtar YEDEKtir. 🔴 GÜVENLİK ÖLÇÜMÜ: `kimi provider catalog add … --api-key` anahtarı `<KIMI_CODE_HOME>/config.toml` içine DÜZ METİN yazar (dosya modu 0600 ölçüldü) → ürün anahtarı credentialVault\'ta tutmalı ve config\'i pane evinde üretmelidir',
      }),
    }),

    // 4. KAPI — KULLANIM: motorun KENDİ oturum defteri (KESİN eşleşme mümkün).
    usage: Object.freeze({
      kind: 'session-ledger',
      level: 'exact',
      content: 'transcript',
      reader: 'kimi-wire-jsonl',
      format: 'jsonl',
      report: null,
      root: '<KIMI_CODE_HOME>/sessions/<wd-slug>/<sessionId>',
      rootEnv: 'KIMI_CODE_HOME',
      file: 'agents/main/wire.jsonl',
      sessionKey: 'emitted-in-output', // id stream-json'da yayınlanıyor → eşleme KESİN
      accumulation: 'per-line',
      dedupeBy: null,
      cost: null, // defterde jeton VAR, DOLAR yok (uydurulmaz)
      billing: Object.freeze({
        apiKeyEnv: 'MOONSHOT_API_KEY',
        configFile: '<KIMI_CODE_HOME>/config.toml',
        field: 'providers.*.api_key',
        planField: null,
        subscriptionWhen: null,
        sourceLabel: 'config.toml sağlayıcı anahtarı · abonelik durumu ölçülemiyor (durum komutu yok)',
        overrideOpt: null,
      }),
    }),

    // 3. KAPI — SÜPERVİZÖR: JSONL var ama claude-uyumlu DEĞİL (ölçüldü).
    output: Object.freeze({
      kind: 'jsonl',
      flag: '--output-format',
      values: Object.freeze(['text', 'stream-json']),
      quietFlag: null,
      requiresQuiet: false,
      requiresFlag: '--prompt',
      claudeCompatible: false,
    }),

    install: Object.freeze({
      label: 'Kimi Code',
      command: 'npm install -g --prefix ~/.local @moonshot-ai/kimi-code',
      win32Command: 'npm install -g @moonshot-ai/kimi-code',
      docsUrl: 'https://moonshotai.github.io/kimi-code/',
      checkHint: 'https://moonshotai.github.io/kimi-code/',
      installsTo: 'npm-global',
      verifyArgv: Object.freeze(['--help']), // `--version` yalnız "0.36.1" basar
      // 🪤 KALIP ÜÇÜNCÜ-TARAF PAKETİ ELEMELİ: `kimi-code` (whitesmith) claude-code
      // sarmalayıcısıdır ve bu satırı üretemez — resmî ikilinin `--help` başlığı:
      // "Usage: kimi [options] [command]" + "The Starting Point for Next-Gen Agents".
      verifyPattern: 'Usage:\\s*kimi\\s+\\[options\\]',
    }),

    // CDX-F1 — efor kolu bu motorda BEYAN EDİLMEDİ (gerekçe: unsupported.effort).
    effort: null,

    unsupported: Object.freeze({
      contextScope:
        'bu motorun kendi belge enjeksiyonunu (proje talimatı zinciri + kalıcı hafıza indeksi) çalışma alanıyla sınırlayan bir taşıyıcı ÖLÇÜLMEDİ — kesim yalnız beyan eden motorda koşar, burada bugünkü davranış aynen sürer (TOKEN-BUDGET-01)',
      effort:
        'efor/akıl-yürütme seviyesi taşıyıcısı BU MOTORDA ÖLÇÜLMEDİ — CDX-F1 kapsamı bilerek codex (+claude beyanı) ile sınırlı tutuldu; beyan edilene kadar per-launch efor override\'ı YOKTUR ve motor kendi varsayılanıyla koşar (sessiz kayıp değil, ölçülmemiş kol)',
      images:
        'tam `--help` seçenek listesinde görsel/attachment bayrağı YOK (`ReadMediaFile` bir ARAÇtır, per-launch ek değil) → görsel yolu prompt METNİNE gömülmeli',
      hooks:
        'eklenti yüzeyi VAR (KIMI_PLUGIN_ROOT/plugin.json, defterde `plugin.session_start` olayı ölçüldü) ama TUR BAŞI brifing enjekte eden per-launch bir bayrak yok → ADP-692 brifingi bu motorda argv ile KURULAMAZ',
      skillsDir:
        '🔑 PER-LAUNCH BAYRAK VAR (`--skills-dir <dir>`, tekrarlanabilir, "instead of auto-discovered user and project directories") ve modele giden araç listesinde `Skill` ölçüldü — ama ürünün skill kitaplığı bir DİZİN eşlemesi ister ve motorun OTOMATİK keşfettiği dizinler ölçülmedi (bundle\'da `.kimi-code/skills/` dizesi geçiyor, gerçek koşuda doğrulanmadı). Uydurma bir yol skill\'leri sessizce görünmez yapardı → alan null, bayrak takip kalemi',
      reset:
        'pane RESET slash komutu gerçek TUI oturumunda ölçülmedi (hesap yok → TUI /login ekranına düşüyor) → var olmayan bir komut göndermek pane\'e sessizce metin yazardı',
      tui:
        'TUI hazır/blocker dizeleri ölçülmedi (hesap duvarı) → paneReadiness regex\'i YOK',
    }),

    partial: Object.freeze({
      identity:
        '🔴 BİR SINIR KALDI: (a) taşıyıcı REPLACE ama reçete ARTIK BAĞLI (ENG-ENABLE-01 — engineBasePrompt `ledger-dump`; taban 21.003 karakter, jeton maliyeti sıfır); (b) 🪤 `--agent-file` `--session`/`--continue` ile BİRLEŞEMİYOR ("Cannot be combined with --session/--continue") → RESUME edilen bir pane kimliğini KAYBEDER; restart-resume ile kimlik bu motorda BUGÜN bir arada olamaz',
      session:
        'devam yolu VAR ve id ÇIKTIDA yayınlanıyor (`session.resume_hint`), ama id\'yi BİZ basamayız ve resume kimliği düşürüyor (yukarı) → ADP-192 restart-resume yolu bu motorda YARIM',
      subagentBlock:
        'blok ÖLÇÜLDÜ ve ÇALIŞIYOR, ama taşıyıcı KİMLİK DOSYASIDIR → kimlik yazılmayan bir pane\'de (reçete düşerse `skip-identity`) blok da YAZILMAZ. İki koruma aynı dosyaya bağlı; ayrı bir global `[tools] disabled` yolu da var ama pane BAŞINA değil',
      usage:
        'defter ÖLÇÜLDÜ ve KESİN (`usage.record` → {inputOther, output, inputCacheRead, inputCacheCreation} + model adı; `turn.ended` süre) ama ürünün satır ayrıştırıcısı (`kimi-wire-jsonl`) HENÜZ YAZILMADI → jeton kartı bugün "bilinmiyor" der',
      output:
        '🪤 ÖLÇÜLDÜ ve claude-UYUMLU DEĞİL: `-p --output-format stream-json` yalnız ÜÇ satır basıyor (system.version · {"role":"assistant","content":…} · session.resume_hint) — jeton, araç olayı, maliyet, bitiş nedeni YOK. Ayrıca her koşu stdout\'a "kimi version 0.36.1" BANNER\'ı yazıyor (JSON değil) → okuyucu bu satırı atlamak zorunda',
      provider:
        'sağlayıcı içe aktarma NON-İNTERAKTİF çalışıyor (ölçüldü: `kimi provider catalog add google --api-key … --default-model …` → "Imported Google (google) with 29 models"), ama üçüncü-taraf sağlayıcılarda GERÇEK tur iki ayrı uyumsuzlukla düştü: google-genai yolunda "Function call is missing a thought_signature", openai yolunda Groq "property \'prompt_cache_key\' is unsupported" → motorun KENDİ sağlayıcısı (Moonshot) dışında canlı tur GARANTİ DEĞİL',
      model:
        '`-m/--model` ölçüldü ve çalışıyor; varsayılan model `config.toml` `default_model` alanından okunuyor ama ürünün model tespiti (modelDetect) bu TOML yolunu HENÜZ tanımıyor',
      extraRoots:
        '`--add-dir <dir>` (tekrarlanabilir) seçenek listesinde VAR; gerçek bir koşuda ek kökün okunduğu ÖLÇÜLMEDİ',
      mcp:
        'per-pane araç kaydı TAM ölçüldü (spawn+initialize+tools/list+tools/call, pane env\'i mirasıyla) — ama ürünün delegate/board/browser sunucularını bu belgeye BESLEYEN zincir yazılmadı → bugün bu pane araçsız açılır',
      auth:
        'giriş yolu BEYAN edildi (`kimi login`, cihaz-kodu) ama giriş YAPILMADI: Moonshot hesabı yok. Ölçümlerin tamamı ya yerel (defter/config/argv) ya da BİZİM kendi sağlayıcı anahtarımızla yapıldı',
    }),

    verification: Object.freeze({
      contextScope: Object.freeze({ channel: 'unverified', source: 'TOKEN-BUDGET-01 — bu motorda belge-enjeksiyonunu kapatan bir bayrak ARANMADI/ÖLÇÜLMEDİ; kesim yalnız beyan eden motorda koşar' }),
      effort: Object.freeze({ channel: 'unverified', source: 'CDX-F1: bu motorda efor bayrağı ARANMADI/ölçülmedi (kapsam: codex + claude)' }),
      identity: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/kimi-identity-pair.txt — `--agent-file` ile kod kelimesi ENG17-KIMLIK-8842 geldi, KONTROL koşusunda motor "no code word in my system prompt" dedi; REPLACE kanıtı: profile.bind.systemPrompt 20910 → 93 karakter' }),
      model: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/kimi-help.txt — `-m, --model <model>  LLM model alias … Defaults to default_model in config.toml`' }),
      images: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/kimi-help.txt — tam seçenek listesinde görsel bayrağı yok' }),
      provider: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/kimi-provider.txt — `provider catalog add <id> --api-key --base-url --default-model` gerçek koşu + `provider list` çıktısı' }),
      session: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/kimi-streamjson.txt — {"role":"meta","type":"session.resume_hint","session_id":"session_9324b033-…","command":"kimi -r session_…"}' }),
      subagentBlock: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/kimi-subagent-block.txt — profile.bind.disallowedTools + llm.tools_snapshot (Agent/AgentSwarm YOK) vs kontrol koşusu (VAR)' }),
      trust: Object.freeze({ channel: 'measured', source: 'ENG-ENABLE-01-evidence/kimi-pane.txt — gerçek pty\'de "Trust this folder?" diyaloğu + varsayılan "Don\'t trust" → "Bye!" (exit 0, 21 sn); elle güvenince ~/.kimi-code/workspace-trust/wd_kimi_180a05f5b591 yazıldı ({"root":…,"trustedAt":…}) ve anahtar sha256(yol)[0:12] ile eşleşti' }),
      reset: Object.freeze({ channel: 'unverified', source: 'TUI açılamadı (hesap duvarı) → alan null' }),
      tui: Object.freeze({ channel: 'unverified', source: 'TUI açılamadı (hesap duvarı) → alan null' }),
      mcp: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/kimi-mcp.txt — kanıt sunucusu spawn log\'u: initialize → notifications/initialized → tools/list → tools/call; defterde `mcp.tools_discovered` + araç adı `mcp__eng17__eng17_ping`' }),
      hooks: Object.freeze({ channel: 'measured', source: 'defter satırı `plugin.session_start` + bundle env\'leri KIMI_PLUGIN_ROOT/KIMI_PLUGIN_DIR_PATH; per-launch kanca bayrağı `--help`te yok' }),
      extraRoots: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/kimi-help.txt — `--add-dir <dir>  Add an additional workspace directory for this session. Can be repeated.`' }),
      skillsDir: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/kimi-help.txt — `--skills-dir <dir>  Load skills from this directory instead of auto-discovered … Can be repeated.`' }),
      identityEnv: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/kimi-home-env.txt — `KIMI_CODE_HOME=/tmp/eng17/kimihome kimi doctor` → "SKIP config.toml /tmp/eng17/kimihome/config.toml"; oturum/mcp/log hepsi o eve yazıldı' }),
      auth: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/kimi-help.txt — `login  Authenticate with Kimi Code CLI via the device-code flow.` + girişsiz koşunun gerçek hata cümlesi' }),
      usage: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/kimi-ledger.txt — usage.record {"inputOther":4852,"output":1,"inputCacheRead":16276,"inputCacheCreation":0} + turn.ended durationMs' }),
      output: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/kimi-streamjson.txt — iki koşunun TAM stream-json çıktısı (3 satır, jeton/araç olayı YOK)' }),
      install: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/kimi-supply-chain.txt — npm view @moonshot-ai/kimi-code (MoonshotAI/kimi-code) vs npm view kimi-code (whitesmith, anthropic-proxy sarmalayıcısı) + satıcı install.sh başlığı; gerçek kurulum ~/.local/bin/kimi → 0.36.1' }),
    }),
  }),

  // ───────────────────────────────────────────────────────────────────────────
  // ENG-17 — CRUSH v0.89.0: "İNTERAKTİF EŞLİK MOTORU" (SINIRLI VATANDAŞ).
  //
  // KARAR (board): crush pane'de KOŞAR, ama DELEGASYON WORKER'I OLAMAZ. Bu karar
  // elle bir bayrakla DEĞİL, ÖLÇÜLMÜŞ bir eksikle uygulanır (ENG-16 dersi):
  // `output: null` → `engineDelegation` bu motora "hayır" der ve rozeti bunu SÖYLER.
  //
  // ÖLÇÜM ENG-R2 §5.3'ün İKİ İDDİASINI DA DÜZELTTİ (ikisi de fazla karamsardı):
  //   ① "MCP yalnız config dosyasından ⇒ eşzamanlı pane'lerde YARIŞ" → YANLIŞ:
  //      `CRUSH_GLOBAL_CONFIG` bir DİZİN alıyor ve pane başına ayrılabiliyor
  //      (ölçüldü: o dizindeki crush.json'dan MCP sunucusu başlatıldı, kullanıcının
  //      repo'suna hiçbir şey yazılmadı). Kimlik de aynı belgeden gidiyor
  //      (`options.context_paths`) → pane başına AYRI kimlik MÜMKÜN.
  //   ② "Yapılandırılmış çıktı YOK ⇒ hiçbir makine cevabı yok" → YARIM DOĞRU:
  //      KOŞUNUN kendisi yapılandırılmış çıktı vermiyor (`crush run --json` →
  //      "Unknown flag: --json"), ama OTURUM DEFTERİ tam JSON: `crush session
  //      show|last --json` jeton + USD MALİYET + tam transcript veriyor.
  //      Yani süpervizör TUR SIRASINDA kör, tur BİTİNCE görüyor → delegasyon
  //      taşıyıcısı olamaz (ilerleme/asılma görülemez), jeton kartı ise ÇALIŞIR.
  //
  // 🔴 KUM HAVUZU YOK: ÖLÇÜLDÜ — headless `crush run` `view`/`write`/`bash`
  // araçlarını ONAY SORMADAN koşturuyor ve `--yolo` bayrağı `run` alt-komutunda
  // REDDEDİLİYOR (kök komuta özgü). Yani otonomi bizim bir bayrağımızdan değil,
  // motorun headless varsayılanından geliyor ve KAPATILAMIYOR.
  crush: Object.freeze({
    id: 'crush',
    label: 'Crush',
    bin: 'crush',

    // 🪤 `--yolo` BİLEREK YOK: `crush run -y …` → "Unknown shorthand flag: 'y' in -y"
    // (ölçüldü, iki sırayla da). Bayrak yalnız İNTERAKTİF kök komutta yaşıyor.
    defaultArgs: Object.freeze([]),

    autonomy: Object.freeze({
      level: 'full',
      via: null,
      flags: Object.freeze([]),
      measured:
        'ENG-17 CANLI: headless `crush run` (hiçbir onay bayrağı YOK) `view` ile dosya okudu, `write` ile sonuc.txt yazdı (TOPLAM=49) ve `bash` ile `echo … > bash-kanit.txt` komutunu KOŞTURDU — üçü de ONAY SORUSU OLMADAN. Kontrol: `crush run -y` ve `crush -y run` → "Unknown shorthand flag: \'y\' in -y" (bayrak yalnız interaktif kökte)',
      why:
        'Bayrak eklemek İMKÂNSIZ (`run` reddediyor). Otonomi motorun headless varsayılanıdır; ürün onu ne açabilir ne kapatabilir → `via:null`. Kısıtlama isteyen `permissions.allowed_tools`/`options.disabled_tools` ile config\'ten daraltmalı',
    }),

    // ─── 1. KAPI — KİMLİK: PANE CONFIG DİZİNİNDEKİ BELGE (ADDITIVE) ────────
    // 🔑 ÖLÇÜLDÜ: CRUSH_GLOBAL_CONFIG=<pane dizini> + o dizindeki crush.json'da
    // `options.context_paths:["…/identity.md"]` → canlı turda ajan kod kelimesini
    // yazdı (ENG17-CRUSH-KIMLIK-7710) ve AYNI turda araçlarını kullanmaya devam etti.
    identity: Object.freeze({
      kind: 'env-file',
      env: 'CRUSH_GLOBAL_CONFIG',
      envTarget: 'json-config-dir', // env DİZİN adı; belge o dizinde `configFileName` olarak yaşar
      configFileName: 'crush.json',
      configPath: 'options.context_paths[]',
      // Belgenin TABANI — ürünün KARARLARI burada yaşıyor:
      //   • $schema  → motor kendi doğrulamasını yapabilsin
      //   • disabled_tools → SERT alt-ajan bloğu (aşağıdaki `subagentBlock`)
      //   • disable_metrics → 🔒 ÜRÜN KARARI: crush varsayılanda telemetri gönderir
      //     (ikilide PostHog istemcisi ölçüldü); müşteri kodu koşan bir pane'de bu
      //     KAPALI açılır. Kullanıcı kendi config'inde geri açabilir.
      configBase: Object.freeze({
        $schema: 'https://charm.land/crush.json',
        options: Object.freeze({
          disabled_tools: Object.freeze(['agent']),
          disable_metrics: true,
        }),
      }),
      fileName: 'crewpane-identity.md',
      fileSuffix: '.md',
      position: 'append',
      cap: Object.freeze({ cli: null, file: 'FILE_MAX' }),
      resumeReinject: true, // taşıyıcı config belgesidir, konuşmaya GÖRÜNMEZ → her koşuda verilir
      // ÖLÇÜLDÜ: ADDITIVE. Kimlikli turda motorun kendi araç seti ve davranışı
      // KORUNDU (view/write/bash + MCP aracı aynı turda çalıştı) ve defterdeki
      // `prompt_tokens` kimliksiz turlara göre ARTTI (11.450 → 19.579), azalmadı.
      replacesSystemPrompt: false,
      alt: Object.freeze({
        kind: 'config-field',
        configPath: 'providers.<id>.system_prompt_prefix',
        replacesSystemPrompt: false,
        note: 'sağlayıcı-başına ÖN EK (şema: "Custom prefix to add to system prompts for this provider") — ama sağlayıcı kaydının TAMAMINI bizim yazmamızı ister (BYOK yolu); ürün bu yüzden `context_paths`i kullanır',
      }),
    }),

    model: Object.freeze({
      kind: 'flag',
      flag: '--model',
      position: 'append',
      // Değer ŞEKLİ `provider/model` (ölçüldü: `crush models` çıktısı, ör. "gemini/gemini-3.5-flash").
      detect: Object.freeze({ kind: 'json-config', field: 'models.large.model', files: Object.freeze(['<CRUSH_GLOBAL_CONFIG>/crush.json']) }),
    }),

    images: null,
    provider: Object.freeze({
      kind: 'config-field',
      configPath: 'providers',
      listArgv: Object.freeze(['models']),
      note: 'sağlayıcı kaydı belgeye yazılır (type/base_url/api_key/models); `crush models` bilinen tüm sağlayıcıların modellerini listeler',
    }),

    // OTURUM — 🪤 KİMLİĞİ BİZ BASAMIYORUZ (ölçüldü) ve motor ÇIKTIDA da SÖYLEMİYOR.
    // `CRUSH_SESSION_ID` env'i ikilide VAR ama ÖLÇÜM: değer YOK SAYILDI — koşu
    // kendi id'sini üretti (`3c3629f720d6ad02`), verdiğimiz `eng17mint0001` DEĞİL.
    session: Object.freeze({
      mint: null,
      flag: null,
      killSwitchEnv: null,
      resume: Object.freeze({
        form: 'append',
        flag: '--session',
        idShape: 'engine-minted',
        idFrom: 'ledger', // id yalnız `session list|last --json` defterinden okunabilir
        lastFallback: Object.freeze(['--continue']),
      }),
    }),

    // 🔑 SERT ALT-AJAN BLOĞU — pane config belgesinde, CANLI DOĞRULANDI.
    // TOKEN-BUDGET-01 — BAĞLAM KAPSAMI: bu motorun kendi belge enjeksiyonunu
    // (proje talimatı zinciri + kalıcı hafıza indeksi) ÇALIŞMA ALANIYLA sınırlayan
    // bir taşıyıcı ÖLÇÜLMEDİ. `null` = bugünkü davranış aynen sürer; kesim yalnız
    // beyan eden motorda uygulanır (paneContextScope HEPSİ-YA-HİÇ kuralı).
    contextScope: null,
    subagentBlock: Object.freeze({
      args: Object.freeze([]),
      via: 'env-config-dir',
      configPath: 'options.disabled_tools',
      value: Object.freeze(['agent']),
      position: 'append',
      dedupeToken: null,
      measured:
        'ENG-17 CANLI: pane config\'inde `options.disabled_tools:["agent"]` iken ajana "\'agent\' adli bir aracin VAR MI" diye soruldu → cevap "YOK". Şema doğrulaması: options.disabled_tools = "List of built-in tools to disable and hide from the agent" (charm.land/crush.json)',
    }),

    trust: null,
    reset: null,
    tui: null,

    // ─── 2. KAPI — ARAÇ BAĞLAMA: AYNI PANE BELGESİ (per-launch, sır taşır) ──
    mcp: Object.freeze({
      kind: 'env-config-dir',
      env: 'CRUSH_GLOBAL_CONFIG',
      configFileName: 'crush.json',
      configPath: 'mcp',
      serverEnvPath: 'env',
      strictFlag: null,
      envInheritance: true, // 🔑 ÖLÇÜLDÜ: pane env'i MCP çocuğuna GEÇTİ (ENG17_TAG çocukta okundu)
      position: 'append',
    }),

    hooks: Object.freeze({ kind: 'config-field', configPath: 'hooks', events: Object.freeze(['PreToolUse']) }),
    extraRoots: null,
    skillsDir: null,
    identityEnv: 'CRUSH_GLOBAL_CONFIG',

    auth: Object.freeze({
      label: 'Crush',
      accountHint: 'Kendi sağlayıcı anahtarın (ortam değişkeni) — ya da abonelik: `crush login hyper` / `crush login copilot`',
      signupUrl: 'https://charm.land/',
      // Giriş CrewPane DIŞINDA olur: ya kullanıcının sağlayıcı anahtarı ortamdadır,
      // ya da `crush login <platform>` tarayıcı akışını sürer. Ürün yalnız DURUMU okur.
      flow: 'external',
      needsCode: false,
      // ENG-FIX-B1/F3 — 🔑 `null`, ÇÜNKÜ DESCRIPTOR'IN KENDİSİ "ürün bu komutu SÜRMEZ"
      // diyor (altta `externalNote`). Komut BEYAN edilince `engineAuth.startLogin`
      // onu gerçekten süren tek dala düşüyordu: `crush login` interaktif bir
      // seçici açıyor, pipe stdio'da hiçbir şey basmıyor ve 5 dakikalık zaman
      // aşımına kadar asılı bir çocuk süreç bırakıyordu (ENG-LOGIN-R1 §2.4).
      // Beyan ile davranış artık AYNI şeyi söylüyor.
      loginArgv: null,
      externalNote:
        'ÖLÇÜLDÜ: `crush login [hyper|copilot]` VAR ama iki platforma özgüdür ve tarayıcı akışıdır; CrewPane\'in birincil yolu SAĞLAYICI ANAHTARIDIR (ortam değişkeni). Ürün bu komutu SÜRMEZ — kullanıcı terminalden koşar, biz yalnız sonucu okuruz',
      logoutArgv: Object.freeze(['logout']),
      statusArgv: null,
      statusParse: null,
      statusNote:
        'ÖLÇÜLDÜ: makine-okunur hesap DURUMU komutu YOK (komut listesinde `auth status` dengi yok; `models` yalnız katalog listeler). Girişsiz makinenin ölçülen cümlesi: "No providers configured - please run \'crush\' to set up a provider interactively." → rozet ÜÇÜNCÜ durumu (BİLİNMİYOR) gösterir',
      apiKey: null,
      apiKeyNote:
        '🔑 ÖLÇÜM ENG-R2 §5.6\'yı ÇÜRÜTTÜ: "interaktif sihirbaz ŞART" DEĞİL — ortamda YALNIZCA bir sağlayıcı anahtarı (bu turda GEMINI_API_KEY) varken `crush run` canlı koştu, araç kullandı, dosya yazdı. Ama anahtar env\'inin ADI SAĞLAYICIYA GÖRE DEĞİŞİR (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / GROQ_API_KEY …) → TEK bir `env` adı beyan etmek yalan olurdu; ürün anahtarı sağlayıcı kaydıyla birlikte pane config belgesine yazmalı',
      noApiKeyNote:
        'crush\'ta anahtar kutusu yok — sağlayıcı anahtarı pane config belgesinde (`CRUSH_GLOBAL_CONFIG`/crush.json) ve/veya ortam değişkeninde taşınır. Hangi sağlayıcıyı seçtiğine bağlı olarak env adı değişir (ANTHROPIC_API_KEY, OPENAI_API_KEY…) ve CrewPane tek bir kutu için tek bir env adı gösteremez. Giriş: terminalden `crush` sihirbazı ile sağlayıcı seçimini yap; CrewPane yalnız durumunu okur.',
    }),

    // 4. KAPI — KULLANIM: motorun KENDİ raporu, ama İÇERİĞİ TAM (jeton + USD + transcript).
    usage: Object.freeze({
      kind: 'cli-report',
      level: 'exact',
      content: 'transcript',
      reader: null,
      format: 'json',
      report: Object.freeze({ argv: Object.freeze(['session', 'last', '--json']) }),
      root: null,
      rootEnv: 'CRUSH_GLOBAL_DATA',
      file: null,
      sessionKey: null,
      accumulation: null,
      dedupeBy: null,
      cost: 'usd', // 🔑 claude'dan sonra USD MALİYET veren İKİNCİ motor (ölçüldü)
      billing: Object.freeze({
        apiKeyEnv: null,
        configFile: '<CRUSH_GLOBAL_CONFIG>/crush.json',
        field: 'providers.*.api_key',
        planField: null,
        subscriptionWhen: null,
        sourceLabel: 'sağlayıcı anahtarı (ortam ya da pane config belgesi) · abonelik: `crush login hyper|copilot`',
        overrideOpt: null,
      }),
    }),

    // 3. KAPI — SÜPERVİZÖR: 🔴 YOK. Sınırlı vatandaşlığın MAKİNE karşılığı budur.
    output: null,

    install: Object.freeze({
      label: 'Crush',
      command: 'npm install -g --prefix ~/.local @charmland/crush',
      win32Command: 'npm install -g @charmland/crush',
      docsUrl: 'https://github.com/charmbracelet/crush',
      checkHint: 'https://github.com/charmbracelet/crush',
      installsTo: 'npm-global',
      verifyArgv: Object.freeze(['--version']), // ÖLÇÜLDÜ: "crush version v0.89.0" — ürün adı VAR
      verifyPattern: 'crush\\s+version',
    }),

    // CDX-F1 — efor kolu bu motorda BEYAN EDİLMEDİ (gerekçe: unsupported.effort).
    effort: null,

    unsupported: Object.freeze({
      contextScope:
        'bu motorun kendi belge enjeksiyonunu (proje talimatı zinciri + kalıcı hafıza indeksi) çalışma alanıyla sınırlayan bir taşıyıcı ÖLÇÜLMEDİ — kesim yalnız beyan eden motorda koşar, burada bugünkü davranış aynen sürer (TOKEN-BUDGET-01)',
      effort:
        'efor/akıl-yürütme seviyesi taşıyıcısı BU MOTORDA ÖLÇÜLMEDİ — CDX-F1 kapsamı bilerek codex (+claude beyanı) ile sınırlı tutuldu; beyan edilene kadar per-launch efor override\'ı YOKTUR ve motor kendi varsayılanıyla koşar (sessiz kayıp değil, ölçülmemiş kol)',
      output:
        '🔴 SINIRLI VATANDAŞLIĞIN SEBEBİ: KOŞUNUN yapılandırılmış çıktısı YOK — ölçüldü: `crush run --json` → "Unknown flag: --json" ve `crush run --help` bayrak listesinde çıktı biçimi HİÇ YOK. Süpervizör tur SIRASINDA hiçbir şey göremez: ilerleme, araç çağrısı, asılma, bitiş nedeni, oturum kimliği — hiçbiri akmıyor. Delegasyon worker\'ı ilerlemesi ÖLÇÜLEMEYEN bir süreç olamaz → bu motor pane\'de İNSAN EŞLİĞİNDE koşar, delegasyona AÇILMAZ. (Tur BİTİNCE defter okunabiliyor: `usage` alanına bak.)',
      images:
        'tam bayrak listesinde görsel/attachment bayrağı YOK → görsel yolu prompt METNİNE gömülmeli',
      extraRoots:
        'ek çalışma kökü bayrağı YOK (`-c/--cwd` KÖKÜ DEĞİŞTİRİR, EKLEMEZ) → liderin hafıza dizini bu pane\'in erişim kökünde OLMAYABİLİR',
      trust:
        'çalışma dizini GÜVEN kapısı yok (motor cwd\'yi sorgusuz kabul ediyor) — bu bir EKSİK değil, güven kapısının HİÇ OLMAMASIDIR ve ADR sınırı olarak beyan edilir',
      skillsDir:
        '`options.skills_paths` şemada VAR ("Paths to directories containing Agent Skills") ve `CRUSH_SKILLS_DIR` env\'i ikilide geçiyor — ama ürünün skill kitaplığı bir DİZİN eşlemesi ister ve motorun OTOMATİK keşif dizinleri ölçülmedi; uydurma bir yol skill\'leri sessizce görünmez yapardı → alan null, config yolu takip kalemi',
      reset:
        'pane RESET slash komutu gerçek TUI oturumunda ölçülmedi → var olmayan bir komut göndermek pane\'e sessizce metin yazardı',
      tui:
        'TUI hazır/blocker dizeleri ölçülmedi (bu turun tamamı headless koştu) → paneReadiness regex\'i YOK',
    }),

    partial: Object.freeze({
      session:
        '🪤 ÖLÇÜLDÜ: `CRUSH_SESSION_ID` ikilide VAR ama koşuda YOK SAYILDI — verdiğimiz "eng17mint0001" yerine motor kendi id\'sini üretti ("3c3629f720d6ad02"). Üstelik id ÇIKTIYA da basılmıyor → ancak `session last --json` ile (zaman penceresiyle) eşlenebilir. ADP-192 restart-resume bu motorda KESİN eşleme veremez',
      usage:
        'defter ÖLÇÜLDÜ ve TAM (`session last --json` → meta{cost, prompt_tokens, completion_tokens, total_tokens} + tam transcript: tool_call/tool_result/finish) ama ürünün `cli-report` okuyucusu bu şekli HENÜZ ayrıştırmıyor → jeton kartı bugün "bilinmiyor" der',
      mcp:
        'per-pane araç kaydı TAM ölçüldü (pane config dizininden sunucu başlatıldı, tools/call\'a kadar gitti, pane env\'i miras alındı) — ama ürünün delegate/board/browser sunucuları bu belgeye HENÜZ beslenmiyor → bugün bu pane araçsız açılır',
      identity:
        'kimlik CANLI doğrulandı ve ADDITIVE; sınır: taşıyıcı pane CONFIG BELGESİDİR → belgeyi yazamadığımız bir kurulumda (kullanıcı kendi CRUSH_GLOBAL_CONFIG\'ini pinlemişse) kimlik de araç da düşer',
      hooks:
        'config şemasında `hooks` VAR ("User-defined shell commands that fire on hook events (e.g. PreToolUse)") ama TUR BAŞI brifing enjekte eden bir olay ÖLÇÜLMEDİ → ADP-692 brifingi bu motorda GARANTİ DEĞİL',
      provider:
        'özel sağlayıcı kaydı CANLI çalıştı (Groq için `providers.eng17groq` yazıldı, istek gerçekten Groq\'a gitti) ama motorun GÖMÜLÜ sağlayıcı kataloğu BAYAT: `crush models` Groq için iki model listeliyor, hesabın GERÇEK kataloğunda o ikisi YOK (404) — `update-providers` sonrası da aynı (PROV-01 ile aynı sınıf)',
      model:
        '`-m/--model` ölçüldü ve çalışıyor (`provider/model`); ürünün model tespiti (modelDetect) bu belge yolunu HENÜZ tanımıyor',
      auth:
        'giriş yolları BEYAN edildi; `crush login` KOŞTURULMADI (Charm Hyper / Copilot hesabı bu turun kapsamı değil). Canlı turlar kendi sağlayıcı anahtarımızla yapıldı',
      identityEnv:
        '🔑 `CRUSH_GLOBAL_CONFIG` ÖLÇÜLDÜ: sağlayıcı anahtarını taşıyan belge (`<dizin>/crush.json`) oradan okunuyor → BYOK yolunda çoklu hesap ÇALIŞIR. 🪤 SINIR: `crush login hyper|copilot` ile alınan PLATFORM jetonu ayrı bir DATA dizininde yaşıyor (`CRUSH_GLOBAL_DATA`/`--data-dir`, izolasyonu ayrıca ölçüldü ve çalışıyor) → iki profil aynı data dizinini paylaşırsa PLATFORM oturumu da paylaşılır; ürün ikisini BİRLİKTE ayırmalı',
      subagentBlock:
        'blok CANLI doğrulandı; sınır: taşıyıcı pane config belgesidir → belge yazılamazsa blok da yazılamaz (kimlikle AYNI dosyaya bağlı)',
    }),

    verification: Object.freeze({
      contextScope: Object.freeze({ channel: 'unverified', source: 'TOKEN-BUDGET-01 — bu motorda belge-enjeksiyonunu kapatan bir bayrak ARANMADI/ÖLÇÜLMEDİ; kesim yalnız beyan eden motorda koşar' }),
      effort: Object.freeze({ channel: 'unverified', source: 'CDX-F1: bu motorda efor bayrağı ARANMADI/ölçülmedi (kapsam: codex + claude)' }),
      identity: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/crush-live-identity.txt — CRUSH_GLOBAL_CONFIG=<pane dizini> + options.context_paths → canlı turda "1) ENG17-CRUSH-KIMLIK-7710"' }),
      model: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/crush-help.txt — `-m --model  Model to use. Accepts \'model\' or \'provider/model\'` + gerçek koşularda `-m gemini/gemini-3.5-flash`' }),
      images: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/crush-help.txt — tam bayrak listesinde görsel bayrağı yok' }),
      provider: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/crush-live-identity.txt + crush-schema-keys.txt — `providers` şema bloğu ve gerçek Groq isteği (404 model hatası SAĞLAYICIYA ULAŞTIĞINI kanıtlıyor)' }),
      session: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/crush-session-mint.txt — CRUSH_SESSION_ID=eng17mint0001 verildi, defterde id "3c3629f720d6ad02" oluştu' }),
      subagentBlock: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/crush-live-identity.txt — disabled_tools:["agent"] iken ajanın cevabı "3) YOK"' }),
      trust: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/crush-help.txt — güven/onay kapısı bayrağı YOK (`-c/--cwd` kök değiştirir)' }),
      reset: Object.freeze({ channel: 'unverified', source: 'TUI açılmadı (bu tur headless) → alan null' }),
      tui: Object.freeze({ channel: 'unverified', source: 'TUI açılmadı (bu tur headless) → alan null' }),
      mcp: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/crush-mcp.txt — CRUSH_GLOBAL_CONFIG dizinindeki crush.json\'dan sunucu başlatıldı: server/discover → initialize → tools/list → tools/call (canlı turda ENG17-MCP-OK)' }),
      hooks: Object.freeze({ channel: 'doc', source: 'charm.land/crush.json şeması — `hooks: User-defined shell commands that fire on hook events (e.g. PreToolUse)`; gerçek bir kanca koşturulmadı' }),
      extraRoots: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/crush-help.txt — ek-kök bayrağı yok' }),
      skillsDir: Object.freeze({ channel: 'measured', source: 'charm.land/crush.json → options.skills_paths + ikili dizesi CRUSH_SKILLS_DIR' }),
      identityEnv: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/crush-mcp.txt — CRUSH_GLOBAL_CONFIG bir DİZİN bekliyor (dosya verilince hata: "Failed to load config from paths […/pane-config.json/crush.json"), dizin verilince belge okundu' }),
      auth: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/auth-help.txt — `crush login [hyper|copilot]` + girişsiz makinede "No providers configured" cümlesi + YALNIZ GEMINI_API_KEY ile canlı koşu' }),
      usage: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/crush-session-json.txt — meta{"cost":0.0437…,"prompt_tokens":19579,"completion_tokens":82,"total_tokens":19661} + tam transcript' }),
      output: Object.freeze({ channel: 'measured', source: 'ENG-17-evidence/crush-json-probe.txt — `crush run --json` → "Unknown flag: --json."; `crush run --help` bayrak listesinde çıktı biçimi yok' }),
      install: Object.freeze({ channel: 'measured', source: 'kurulu paket ~/.local/lib/node_modules/@charmland/crush (npm global) · `crush --version` → "crush version v0.89.0" (ürün adı VAR)' }),
    }),
  }),

  // ───────────────────────────────────────────────────────────────────────────
  // ENG-22 — ON ÜÇÜNCÜ MOTOR: antigravity 1.1.14 (Google, Go ikilisi).
  //
  // 🔴 BU KAYIT BİR GÖÇÜN SONUCU: Google, gemini CLI'ın BİREYSEL hesap girişini
  // 2026-08-18'de kapattı ve kullanıcıyı buraya yönlendiriyor (gemini kaydının
  // `auth` başlığındaki üç kanıt). Yani bu motor "bir tane daha" değil, gemini'nin
  // hesap yolunun DEVAMI. ENG-18 (ironhide) 1.1.13'ü ölçmüş ve iki YAPISAL engel
  // saymıştı: (1) API-anahtarlı headless auth yolu YOK, (2) MCP CLI yüzeyi YOK.
  // ENG-22 ikisini de GERÇEK KOŞUYLA yeniden ölçtü:
  //   ① (1) ÇÜRÜDÜ — ikilinin KENDİ changelog'u (1.1.13) diyor ki: "Added support
  //      for `GEMINI_API_KEY`, so the CLI can run against the Gemini API directly
  //      without signing in. Set `modelProvider: "gemini"` in settings.json…".
  //      ÖLÇÜLDÜ: settings.json + env ile tarayıcı duvarı YOK, tur SUCCESS.
  //   ② (2) KISMEN ÇÜRÜDÜ — CLI alt-komutu gerçekten yok ama `~/.gemini/config/
  //      mcp_config.json` OKUNUYOR (probe sunucumuz SPAWN oldu, motor log'unda
  //      `mcp/eng22probe` adıyla göründü) → sınıf 'config-only' (gemini/droid ile aynı).
  //
  // 🪤 ÜÇ TUZAK — üçü de ürün kodunu ilgilendiriyor (ENG-22-evidence):
  //   (a) ANAHTAR TEK BAŞINA YETMEZ: yalnız `GEMINI_API_KEY` ile koşu YİNE OAuth
  //       duvarına düştü ve 60 sn asıldı. Anahtar yolu `$HOME/.gemini/antigravity-cli/
  //       settings.json` içinde `{"modelProvider":"gemini"}` İSTİYOR — yani auth
  //       ENV + DOSYA. Dosyanın yolu HOME'a çivili ve taşıyan env YOK (aşağıda).
  //   (b) ARAÇLARIN ÇALIŞMA DİZİNİ SÜREÇ cwd'si DEĞİL: bayraksız koşuda `pwd`
  //       `$HOME/.gemini/antigravity-cli/scratch` dedi. Dizin `--add-dir` ile
  //       verilir ve İLK `--add-dir` kazanır (iki bayraklı iki koşuyla ölçüldü).
  //   (c) KİMLİK de aynı bayrakla taşınır (dizindeki `AGENTS.md`/`GEMINI.md`) →
  //       tek bayrak İKİ işi birden yapıyor ve SIRA önemli: önce çalışma kökü,
  //       sonra kimlik dizini (ters sırada ajan kimliği alır ama YANLIŞ dizinde koşar).
  //
  // HÜKÜM: kayıt AÇIK, ÇALIŞTIRMA KAPALI (`public.engines.enabled=false`, cursor/kimi
  // deseni). Sebep tek cümleyle: kimlik reçetesi ÖLÇÜLDÜ ama ürün grameri onu
  // ÜRETEMİYOR (`identity.kind` şemasında "bayrak → DİZİN → sabit adlı dosya" şekli
  // yok) ve pane başına izolasyon yolu YOK (her şey HOME'a çivili). Bağlanmadan
  // açmak, kimliksiz ve birbirinin config'ini ezen pane'ler demekti (ENG-16 amp çizgisi).
  antigravity: Object.freeze({
    id: 'antigravity',
    label: 'Antigravity CLI',
    // 🪤 SİTE KİMLİĞİ ≠ İKİLİ ADI (ENG-18 D2): kurucu ikiliyi `~/.local/bin/agy`
    // adıyla koyar (arşivdeki dosya adı `antigravity`). ALLOWED_COMMANDS anahtarı
    // İKİLİNİN adı olmak zorunda — yoksa spawn "disallowed command" ile ölür.
    bin: 'agy',

    // ENG-20 paritesi: onay sorusu akışı keser. ÖLÇÜLDÜ (aşağıda) — bayraksız
    // headless koşu aracı OTO-REDDEDİYOR (asılmıyor, sessizce de geçmiyor).
    defaultArgs: Object.freeze(['--dangerously-skip-permissions']),

    autonomy: Object.freeze({
      level: 'full',
      via: 'argv',
      flags: Object.freeze(['--dangerously-skip-permissions']),
      measured:
        'ENG-22 CANLI, İKİ YÖNLÜ: (a) bayraksız `-p "dosya oluştur"` → motorun KENDİ cümlesi "a tool required the \'command\' permission that headless mode cannot prompt for, so it was auto-denied … re-run with --dangerously-skip-permissions", dosya OLUŞMADI ve zarf `status:SUCCESS` + BOŞ response döndü (süpervizör tuzağı: başarı gibi görünür). (b) bayrakla AYNI istek → `write_to_file` koştu, dosya diskte, içerik "YOLO-OK"; stream-json init olayı `"permission_mode":"always-proceed"` yazdı',
      why:
        'Eren kararı 2026-08-18 (claude paritesi). AGY-02 İZİN MERDİVENİNİ ÖLÇTÜ (ANTIGRAVITY-R1 §7-R5 bu kartı açmıştı) ve DAHA DAR ÇALIŞAN BİR ARGV KİPİ BULUNMADI — bayrak SPEKÜLASYONLA değil ölçümle duruyor. Altı kol, aynı demet/model, tek değişken izin bayrağı (kanıt: AGY-02-evidence/02): bayraksız · `--mode accept-edits` · `--mode plan` · `--sandbox` (tek başına) → DÖRDÜNDE de MCP aracı çağrılmadan OTO-REDDEDİLDİ (motorun cümlesi: "a tool required the \'mcp\' permission that headless mode cannot prompt for"), yani pane araçsız = işe yaramaz. `--dangerously-skip-permissions` → araç çağrıldı. `--dangerously-skip-permissions --sandbox` → araç yine çağrıldı AMA `--sandbox` ÖLÇÜLEBİLİR HİÇBİR ŞEYİ DARALTMADI: sandbox\'lı kolda da kabuk komutu koştu, çalışma alanı içine VE dışına (`/private/tmp/…`) dosya yazıldı. Sahte bir güvenlik iddiası doğuracağı için alınmadı. Motorun işaret ettiği GERÇEKTEN dar yol (`permissions.allow: ["mcp(…)"]`) PANE BAŞINA KURULAMIYOR: `settings.json` çalışma alanından okunmuyor (üç yerleşim denendi — `<ws>/.agents/`, `<ws>/`, plugin kökü `.agents/` → üçünde de RED) ve motorun kendi changelog\'una göre yalnız `~/.gemini/antigravity-cli/settings.json` + `~/.gemini/config/projects/` okunuyor; oraya yazmak AGY-01\'in tam da reddettiği KULLANICI CONFIG\'İ KİRLENMESİ olurdu (iki pane tek belgeye yazar). ⇒ Bugünkü tek kol doğru koldur; daraltma AGY-03\'ün hook kapısına düşer (yerleşik araç ADLARI hook\'ta matcher ile kapatılabilir — MCP araçları `call_mcp_tool` altında olduğu için DEĞİL, R1 §2.2)',
    }),

    // ─── 1. KAPI — KİMLİK: BAYRAK → DİZİN → MOTORUN DAYATTIĞI DOSYA ADI ────
    //
    // ENG-22 reçeteyi ÖLÇMÜŞ ama "bu şekil `identity.kind` enum'unda YOK" diyerek
    // alanı `null` bırakmıştı (fail-closed, doğru karardı). ENG-ENABLE-01 eksik
    // olan grameri EKLEDİ (`kind:'flag-dir'`, agentRunner.withIdentity) ve reçeteyi
    // agy 1.1.28'de YENİDEN ölçtü (hüküm bir tarihtir, bkz. hafıza notu):
    //   • `--add-dir <dizin>`/`AGENTS.md` → kimlik modele ULAŞTI (kod kelimesi DELTA5)
    //     ve motor ABONELİKLE koştu (anahtar YOK — `antigravity-oauth-token` var).
    //   • 🪤 TEK BAYRAKLA ARAÇLARIN cwd'Sİ KİMLİK DİZİNİNE KAYDI: ajanın `pwd`
    //     çıktısı kimlik dizini oldu — yani ajan doğru kimlikle YANLIŞ dizinde koşar.
    //   • DÜZELTME ÖLÇÜLDÜ: iş dizini ÖNCE verilince (`--add-dir <cwd> --add-dir
    //     <kimlik>`) `pwd` = iş dizini VE kimlik hâlâ okundu.
    // `cwdFirst` bu ölçülmüş sırayı BEYAN eder; ürün sırayı uydurmaz.
    identity: Object.freeze({
      kind: 'flag-dir',
      flag: '--add-dir',
      position: 'append',
      fileName: 'AGENTS.md', // ad MOTORUN dayatması: `crewpane-identity.md` OKUNMADI (ENG-22)
      fileSuffix: '.md',
      cap: Object.freeze({ cli: null, file: 'FILE_MAX' }),
      resumeReinject: false,
      replacesSystemPrompt: false, // ENG-22: taban KORUNDU (11.512 → 11.824 jeton) ⇒ ADDITIVE
      cwdFirst: true, // 🔴 ZORUNLU: ilk `--add-dir` araçların cwd'sini belirliyor
    }),

    model: Object.freeze({
      kind: 'flag',
      flag: '--model',
      position: 'append',
      // ENG-22 (agy 1.1.14) ölçümü: `agy models` → gemini-3.1-pro-preview |
      // gemini-3.5-flash | gemini-3.6-flash | gemini-3.7-flash.
      // AGY-05 (agy 1.2.2, 2026-09-14) TEKRAR ÖLÇTÜ — liste 14 SATIR ve BAŞKA:
      // gemini-3.8/3.7/3.6-flash-{high,medium,low} · gemini-3.1-pro-{high,low} ·
      // claude-sonnet-4-6 · claude-opus-4-6-thinking · gpt-oss-120b-medium.
      // (R1 §3.1 "15 satır" der; ölçülen 15 STDOUT satırının biri "Fetching
      // available models..." başlığıdır → MODEL satırı 14.)
      // 🪤 Varsayılan model ücretsiz katmanda KOŞMUYOR: gemini-3.1-pro için kota
      // "limit: 0" (429) → model SEÇİLMEDEN anahtar yolu ilk turda ölür.
      detect: null,
      // AGY-05 — "HANGİ modeller" listesinin adresi (claude/codex ile AYNI desen).
      // 🪤 Liste `agy models`ten CANLI okunMAZ: çıktı SONEKLİ ad verir (efor ada
      // gömülü) ve o adla efor birleşince pane ölür; katalog ÇIPLAK aile adı tutar.
      catalog: 'electron/modelCatalog.cjs',
    }),

    images: null,
    provider: null,

    // OTURUM — kimliği MOTOR basar ama HER ZARFTA SÖYLER: `-o json` sonucu ve
    // stream-json'un init/step/result olaylarının hepsinde `conversation_id`.
    session: Object.freeze({
      mint: null,
      flag: null,
      killSwitchEnv: null,
      resume: Object.freeze({
        form: 'append',
        flag: '--conversation',
        idShape: 'engine-minted',
        idFrom: 'output', // 🔑 id ÇIKTIDA yayınlanıyor → süpervizör eşlemesi KESİN olabilir
        idField: 'conversation_id',
        lastFallback: Object.freeze(['--continue']),
      }),
    }),

    // TOKEN-BUDGET-01 — BAĞLAM KAPSAMI: bu motorun kendi belge enjeksiyonunu
    // (proje talimatı zinciri + kalıcı hafıza indeksi) ÇALIŞMA ALANIYLA sınırlayan
    // bir taşıyıcı ÖLÇÜLMEDİ. `null` = bugünkü davranış aynen sürer; kesim yalnız
    // beyan eden motorda uygulanır (paneContextScope HEPSİ-YA-HİÇ kuralı).
    contextScope: null,

    // ─── ADR-004 SERT KATMANI — ARGV'DE DEĞİL, HOOK'TA ───────────────────────────
    //
    // ⏪ ESKİ HÜKÜM (ENG-22): `null` — "alt-ajan araçları VAR ama kapatma yolu
    //    ÖLÇÜLMEDİ; ölçülmemiş blok, olmayan bir korumayı VAR sanmaktır" → bu motora
    //    LİDER rolü verilemezdi.
    //
    // 🟢 YENİ HÜKÜM (AGY-03, agy 1.2.2 — GERÇEK turda, KONTROL KOLLU):
    //    `hooks.json` → `PreToolUse` → `{"decision":"deny"}` kapısı ÇALIŞIYOR.
    //      • hook AÇIK  : `invoke_subagent` adımı `state:"ERROR"` oldu ve modelin
    //                     cevabına BİZİM gerekçemiz düştü ("tool call denied by
    //                     pre-tool hook: CrewPane: …").
    //      • hook KAPALI (`enabled:false`, tek değişken): alt-ajan AÇILDI
    //                     (`ALTAJAN=BASARILI`) — yani blok gerçekten BİZİM.
    //    Kanıt: AGY-03-evidence/{01-run-hooks-on,02-run-control-arm}.
    //
    // 🪤 TAŞIYICI ARGV DEĞİL: claude'da blok bir bayraktır (`--disallowedTools Task`)
    //    ve `subagentBlockArgs` onu argv'ye basar. Burada argv dengi YOKTUR; blok
    //    demetin `hooks.json`una yazılır. `via` bunu SÖYLER ki `subagentBlockArgs`
    //    boş dönsün ve kimse "bayrak nerede" diye aramasın (kimi motorunun
    //    `identity-frontmatter` yolundaki AYNI desen).
    subagentBlock: Object.freeze({
      via: 'workspace-plugin-hook',
      event: 'PreToolUse',
      decision: 'deny',
      // Blok edilen YERLEŞİK araçlar + dolaylı yolun tek adı; regex `matcher` ve
      // gövde süzgeci `electron/agyHooks.cjs`te (ikinci bir liste = ikinci gerçek).
      toolsModule: 'electron/agyHooks.cjs',
      measuredVersion: '1.2.2',
    }),

    trust: null,
    reset: null,
    tui: null,

    // ─── 2. KAPI — ARAÇ BAĞLAMA: ÇALIŞMA-ALANI PLUGIN DEMETİ (PANE BAŞINA) ────
    //
    // ⏪ ESKİ HÜKÜM (ENG-22, agy 1.1.14): `kind:'config-only'` —
    //    `$HOME/.gemini/config/mcp_config.json` tek ve PAYLAŞIMLI dosya, pane
    //    başına kayıt YOK, kullanıcının config'i kirlenir. Bu yüzden antigravity
    //    LİDER olamıyordu (`leaderDelegationStatus` gerekçesi birebir buydu).
    //
    // 🟢 YENİ HÜKÜM (AGY-01, agy 1.2.2 — ANTIGRAVITY-R1 §0-3 + bu kartın ölçümü):
    //    sınır KALKTI. Motor artık çalışma alanında `.agents/plugins/<ad>/`
    //    demetlerini keşfediyor ve demet KENDİ `mcp_config.json`unu taşıyor.
    //    Ürün demeti pane başına ÜRETİR (`electron/agyWorkspacePlugin.cjs`) ve
    //    kökü `--add-dir` ile verir.
    //
    // ── ÖLÇÜM (2026-09-14, agy 1.2.2; kanıt: AGY-01-evidence/) — ÜÇ KOL ────────
    //   • Kol C (R1 tabanı) `.agents/` cwd'nin İÇİNDE  → sunucu SPAWN + araç ÇAĞRILDI
    //   • Kol A (KARAR)     `.agents/` cwd'nin DIŞINDA, 2. `--add-dir` kökünde
    //                        → sunucu SPAWN + araç ÇAĞRILDI **ve `pwd` İŞ KÖKÜ kaldı**
    //   • Kol B (KONTROL)   aynı cwd, plugin kökü VERİLMEDİ → sunucu spawn OLMADI
    //   ⇒ keşif `--add-dir` KÖKÜNE bağlı ⇒ kullanıcının reposuna dosya bırakılmaz
    //     (R8 kapandı: repo içi `.agents/` + `.git/info/exclude` yolu GEREKMİYOR).
    //
    // 🪤 ÜÇ TUZAK — üçü de ölçüldü:
    //   (a) `agy mcp list` / `agy plugin list` bu kaydı GÖSTERMEZ: liste komutları
    //       yalnız config dosyalarını okur, keşif AJAN ÇALIŞMA ZAMANINDA olur.
    //       Listenin BOŞ kalması ARIZA DEĞİL, global kirlenmenin YOK kanıtıdır.
    //   (b) Sunucunun cwd'si PLUGIN DİZİNİDİR (süreç cwd'si değil) → sunucu yolları
    //       MUTLAK yazılır; göreli yol plugin dizinine çözülürdü.
    //   (c) Araçlar modele TEK TEK görünmüyor; hepsi jenerik `call_mcp_tool`
    //       üzerinden gidiyor ⇒ araç ADINA dayalı ince taneli kapı KURULAMAZ (AGY-03).
    mcp: Object.freeze({
      kind: 'workspace-plugin',
      // Motorun DAYATTIĞI demet yolu ve dosya adları (agy-customizations/docs/plugins.md).
      pluginPath: '.agents/plugins',
      pluginName: 'crewpane',
      files: Object.freeze({ manifest: 'plugin.json', mcpConfig: 'mcp_config.json', hooks: 'hooks.json' }),
      field: 'mcpServers',
      // Kök motora BU bayrakla verilir — kimlik taşıyıcısıyla AYNI bayrak (`--add-dir`),
      // ama AYRI bir dizin: her kapı kendi sink'ini yazar (kimlik `engine-identity/`,
      // demet `engine-plugins/`), böylece biri düşerse öteki ayakta kalır.
      rootFlag: '--add-dir',
      allowFlag: null, // ölçüldü: seçme/filtreleme bayrağı YOK
      // ⏪ AGY-01 (fail-closed TAHMİN): "config'in KENDİ `env` bloğu çocuğa GEÇTİ
      //    (ölçüldü); pane env MİRASI ÖLÇÜLMEDİ ⇒ `false`". Ölçülmemişi `false`
      //    saymak doğru karardı — ama bir HÜKÜM değil, bir TARİHTİ.
      //
      // 🟢 AGY-02 ÖLÇTÜ (agy 1.2.2; kanıt: AGY-02-evidence/01) — MİRAS VAR:
      //    sonda MCP sunucusunun `mcp_config.json` env bloğunda YALNIZ `CFG` işareti
      //    varken, süreç ebeveynin env'indeki `PANE` işaretini de GÖRDÜ
      //    (`PANE=PANE-yolo CFG=CFG-yolo … ENVCOUNT=63`) ve demete HİÇ yazılmamış
      //    `CREWPANE_ACCOUNT` / `CREWPANE_BRIDGE_*` değerleri de ulaştı.
      //    ⇒ Antigravity bu yönden claude gibidir, codex gibi DEĞİL.
      //
      // 🪤 BU BAYRAK TEK BAŞINA ENTEGRASYON KAPISINI AÇMAZ — ve açmamalı.
      //    `mcpCanCarrySecrets` taşıyıcının `config-file` olmasını DA ister; bu kayıt
      //    `workspace-plugin`. Kapıyı yalnız bu bayrakla açmak, sırrı pane env'ine
      //    yazıp ARDINDAN hiçbir sunucu kaydetmemek olurdu (`withIntegrationsMcp`
      //    hazır bir config DOSYASI yolu verir, bu taşıyıcı onu ifade edemez →
      //    katkı BOŞ döner): rozet "entegrasyon var" derken pane'de araç OLMAZDI.
      //    Yalan rozet, olmayan rozetten kötüdür ⇒ kapı KAPALI, gerekçe DÜRÜST
      //    (paneCapabilityMatrix.refineIntegrations `workspace-plugin` dalı).
      // 🔒 Dosya 0600 ve `<crewpaneHome>` altında — argv'ye/ps çıktısına SIR yazılmaz.
      envInheritance: true,
      position: null,
      // Bu kaydın ölçüldüğü motor sürümü — AGY-06 sürüm kapısının damgası (R1 §6-1).
      measuredVersion: '1.2.2',
    }),

    // ─── HOOK YÜZEYİ — PER-LAUNCH BAYRAK YOK, TAŞIYICI DEMETTİR ─────────────────
    //
    // ⏪ ESKİ HÜKÜM (ENG-22): `null` — "(a) per-launch BAYRAK yok, (b) `hooks.json`un
    //    yeri ÇALIŞMA KÖKÜ → ADP-692 tur brifingi bu motorda argv ile KURULAMAZ".
    //    (a) hâlâ doğru; (b) YANLIŞ ÇIKTI: `hooks.json` demetin İÇİNDE de okunuyor
    //    (`plugins/<ad>/hooks.json`, motorun kendi belgesi + AGY-03 gerçek turu) ⇒
    //    kullanıcının repo'suna yazmak GEREKMİYOR, kök zaten `--add-dir` ile veriliyor.
    //
    // Yani bayrak yokluğu brifingi engellemiyor: taşıyıcı AGY-01 demetidir.
    // `carrier` alanı bunu SÖYLER — `withTurnBriefing` (claude yolu, `flag` arar)
    // bu motorda NO-OP kalır, `withAgyHooks` devralır.
    hooks: Object.freeze({
      carrier: 'workspace-plugin',
      file: 'hooks.json',
      hookName: 'crewpane',
      // 🪤 ÖLÇÜLDÜ: `PreInvocation` TUR başına değil MODEL ÇAĞRISI başına ateşler
      // (tek `-p` turunda invocationNum 0,1,2). claude `UserPromptSubmit` tur başına
      // BİR kez ateşler — birebir port brifingi 3 kez bağlama sokardı. Ürün ilk
      // çağrıya kapar (`agyHooks.isFirstInvocation`); alan o kuralın BEYANIDIR.
      preInvocation: Object.freeze({ event: 'PreInvocation', firesPerModelCall: true, shape: 'flat' }),
      // 🪤 ŞEKİL FARKI: `PreToolUse` GRUPLU (matcher + hooks sarmalı), `PreInvocation`
      // DÜZ. Karıştırılırsa kapı sessizce hiç kurulmaz (motor hata vermez).
      preToolUse: Object.freeze({ event: 'PreToolUse', shape: 'grouped', matcherKey: 'matcher' }),
      // 🪤 MCP ÇAĞRISI TEK ADA DÜŞER: hook `call_mcp_tool` görür, gerçek araç adını
      // DEĞİL (R1 §2.2 tahmindi, AGY-03 ÖLÇTÜ). Hedef ad gövdededir:
      // `args.ToolName` / `args.ServerName` ⇒ ince taneli MCP kapısı `matcher` ile
      // DEĞİL, gövdeye bakan hook ile kurulur.
      mcpToolName: 'call_mcp_tool',
      mcpArgFields: Object.freeze({ tool: 'ToolName', server: 'ServerName' }),
      measuredVersion: '1.2.2',
    }),

    // 🔑 ÜÇ İŞİ BİRDEN YAPAN BAYRAK (ölçüldü): (1) ek çalışma kökü, (2) araçların
    // ÇALIŞMA DİZİNİ, (3) kimlik dosyasının okunduğu dizin. Sıra önemli — ayrıntı
    // `partial.extraRoots`te.
    extraRoots: Object.freeze({ flag: '--add-dir', repeat: 'variadic' }),

    skillsDir: null,
    identityEnv: null,

    auth: Object.freeze({
      label: 'Antigravity CLI',
      // ENG-ENABLE-01 (2026-09-09, agy 1.1.28) — ABONELİK YOLU GERÇEK VE ÇALIŞIYOR.
      // Müşteri KaptanZorba'nın cümlesi ("antigravity cli de api key soruyor, cli
      // zaten kurulu, onu görmüyor") bu kaydın ESKİ hâlinin doğrudan sonucuydu:
      // ENG-22 anahtarı BİRİNCİL yol ilan etmişti (o gün ürün OAuth'u SÜREMİYORDU).
      // Bugün ölçüldü: makinede `~/.gemini/antigravity-cli/antigravity-oauth-token`
      // VAR ve motor HİÇBİR anahtar olmadan tam bir tur koştu (kimlik + araç + cevap).
      // 1.1.28 changelog'u da bunu söylüyor: "reading your signed-in identity from
      // the stored credential … the displayed plan tier".
      accountHint:
        'Google hesabıyla giriş (Antigravity aboneliği) — BİRİNCİL yol. Giriş TERMİNALDE yapılır: pane\'de argümansız `agy` çalıştır, tarayıcıda onayla; oturum `~/.gemini/antigravity-cli/` altında saklanır ve CrewPane onu OLDUĞU GİBİ kullanır. Gemini API anahtarı YEDEKtir',
      signupUrl: 'https://antigravity.google/',
      // 🔑 `external`: giriş CrewPane DIŞINDA (ya da pane\'in kendi terminalinde)
      // yapılır — cursor emsali. Ürün akışı SÜRMEZ, yalnız DURUMU okur.
      flow: 'external',
      needsCode: false,
      loginArgv: null, // motorda ayrı bir `login` alt-komutu YOK: argümansız `agy` giriş ekranı açar
      logoutArgv: null,
      externalNote:
        'ÖLÇÜLDÜ (1.1.28): alt-komut listesinde `login`/`logout`/`auth` YOK (agent/agents/changelog/help/install/mcp/mic-serve/models/plugin/plugins/remote-control/update). Giriş, argümansız `agy` çalıştırılınca açılan ekrandan tarayıcıya gidiyor → ürün bu akışı SÜRMEZ; düğme "pane\'de `agy` çalıştır ve giriş yap" der. Oturum HOME\'a çivili olduğu için CrewPane pane\'i kullanıcının mevcut girişini AYNEN görür',
      // 🔑 DURUM KOMUTU YOK ama GİRİŞE BAĞLI, UCUZ ve MODEL TURU HARCAMAYAN bir
      // komut var. İKİ YÖNLÜ ölçüldü (ENG-ENABLE-01-evidence/agy-models-*.txt).
      statusArgv: Object.freeze(['models']),
      statusParse: 'exit-code',
      signedOutPattern: 'please sign in to view available models',
      statusMethodLabel: 'Antigravity (Google hesabı)',
      apiKey: Object.freeze({
        env: 'GEMINI_API_KEY', // ENV ile gider — ARGV'ye ASLA (ENG-R3 §9.3)
        // 🔑 gemini ile AYNI anahtar ama AYRI kasa girdisi: tek kasa girdisi
        // paylaşmak, bir karttan "Anahtarı kaldır" denince ÖTEKİ motorun da
        // sessizce düşmesi demekti (kullanıcı bunu bekleyemez).
        vaultService: 'crewpane-antigravity-api-key',
        keyUrl: 'https://aistudio.google.com/apikey',
        keyLabel: 'Gemini API anahtarı (Google AI Studio)',
        note: '🪤 ANAHTAR TEK BAŞINA YETMEZ (ölçüldü): motor `$HOME/.gemini/antigravity-cli/settings.json` içinde `{"modelProvider":"gemini"}` görmezse anahtarı YOK SAYAR ve tarayıcı girişine düşüp 60 sn asılır. Ayrıca ücretsiz katman kotası MODEL BAŞINA: gemini-3.5-flash için ölçülen sınır günde 20 istek + dakikada 5 (429 "GenerateRequestsPerDayPerProjectPerModel-FreeTier"), gemini-3.1-pro için "limit: 0" (yani ücretsiz katmanda hiç koşmaz). Ölçüm: 2026-08-18.',
      }),
    }),

    // ─── 4. KAPI — KULLANIM: SAYAÇ DEFTERDE DEĞİL, KOŞU ZARFINDA ────────────────
    //
    // ⏪ ESKİ HÜKÜM (ENG-22): `kind:'none'` — "jetonlar ÇIKTIDA TAM ama ürünün defter
    //    okuyucusu 'koşu zarfının içindeki sayaç' şeklini TANIMIYOR". Doğru bir
    //    tarihti: eksik olan motor değil, ÜRÜNÜN GRAMERİYDİ.
    //
    // 🟢 YENİ HÜKÜM (AGY-04, agy 1.2.2): gramer eklendi (`kind:'run-envelope'`,
    //    okuyucu `electron/agyStreamReader.cjs`, adaptör `tokenUsage` içinde).
    //    Sayacı ÜRETEN taraf onu ENJEKTE eder (`opts.runEnvelope`); `tokenUsage`
    //    bu motor için süreç ÇALIŞTIRMAZ — zarfı üretmenin tek yolu bir MODEL TURU
    //    koşturmaktır ve jeton ölçmek için jeton yakmak saçmadır.
    //
    // ── 🔴 KAPSAM SINIRI — ÖLÇÜLDÜ, TAHMİN DEĞİL ────────────────────────────────
    // `--output-format` satıcının KENDİ yardım metninde "Output format for PRINT
    // MODE" diye yazılı (AGY-05-evidence/03-help.txt satır 17) ⇒ zarf YALNIZ
    // headless (`-p`) koşuda vardır. İNTERAKTİF bir pane'de bu motorun jetonu
    // BUGÜN ÖLÇÜLEMEZ ve üç aday kaynağın ÜÇÜ DE ölçülüp ELENDİ (AGY-04):
    //   • hook gövdesindeki `transcriptPath` → `brain/<id>/…/transcript_full.jsonl`:
    //     45 dosyanın hiçbirinde `usage`/`*_tokens` alanı YOK (satır anahtarları:
    //     content · created_at · source · status · step_index · thinking · tool_calls · type)
    //   • `conversations/<id>.db` (sqlite): sayaç varsa BELGESİZ protobuf blob'un
    //     içinde — 5 günde 4 sürüm çıkaran bir ikilide blob ayrıştırmak kırılgan
    //   • `~/.gemini/antigravity-cli/log/cli-*.log`: "token" geçen 39 satırın hepsi
    //     OAuth jetonu, kullanım sayacı YOK
    // ⇒ Rozet interaktif pane'de "bilinmiyor" DEMEYE DEVAM EDER (gerekçe:
    //    'envelope-not-recorded'). Uydurmak yerine susmak bu dosyanın sözleşmesidir.
    usage: Object.freeze({
      kind: 'run-envelope',
      level: 'exact', // sayaç MOTORUN KENDİSİNİN; tahmin/pencere eşlemesi yok
      reader: 'agy-envelope',
      readerModule: 'electron/agyStreamReader.cjs',
      // Zarfın ÖLÇÜLEN alan adları — okuyucu bunları kopyalamaz, BURADAN doğrular.
      envelope: Object.freeze({
        input: 'input_tokens',
        output: 'output_tokens',
        // 🪤 ÖLÇÜLDÜ: `thinking_tokens` ⊂ `output_tokens` (input+output = total,
        // üç zarfta da) ⇒ AYRI KALEM DEĞİL; toplarsak maliyet şişer.
        thinkingSubsetOfOutput: true,
        cacheRead: 'cache_read_tokens',
        total: 'total_tokens',
        cacheWrite: null, // zarfta YOK — 0 yazmak ölçüm değil, alanın yokluğudur
        // 🪤 ÖLÇÜLDÜ: `result.usage` ADIM usage'larının TOPLAMIDIR (13.918+14.285
        // = 28.203) ⇒ ikisi TOPLANMAZ; `result` geldiğinde turun sayacı DEĞİŞİR.
        accumulation: 'result-replaces-steps',
      }),
      // ENG-14 — İÇERİK BEYANI, FAIL-CLOSED: zarfın `usage{}` bloğu SAYAÇtır.
      // Akışın `step_update` olayları konuşma/araç olayı TAŞIR (önizleme oradan
      // geliyor) ama bu DİSKTE PROBLANABİLİR bir defter DEĞİL — yalnız koşarken
      // akar ve hiçbir yere yazılmaz. Teslim doğrulaması (transcriptProbe) bu
      // motorda bir dosya bulamaz ⇒ 'transcript' demek olmayan bir kaynağı VAR
      // saymak olurdu.
      content: 'counters',
      root: '$HOME/.gemini/antigravity-cli/conversations',
      rootEnv: null, // 🔴 defterin yerini taşıyan env YOK — yalnız HOME
      file: null,
      sessionKey: 'conversation_id', // her zarfta (init/step_update/result) VAR
      accumulation: null,
      dedupeBy: 'step_index',
      cost: null, // USD YOK: zarf yalnız jeton sayar (uydurulmaz)
      // AGY-06 sürüm kapısının damgası (R1 §6-1).
      measuredVersion: '1.2.2',
      billing: Object.freeze({
        apiKeyEnv: 'GEMINI_API_KEY',
        configFile: '$HOME/.gemini/antigravity-cli/settings.json',
        field: 'modelProvider',
        planField: null,
        // ENG-ENABLE-01 — kural DEĞİŞMEDİ ama GEREKÇESİ düzeltildi: `modelProvider`
        // YAZILIYSA fatura anahtardadır (hiçbir değer aboneliğe eşlenmez → 'never').
        // Alan HİÇ YOKSA (abonelikle koşan makinenin ölçülen hâli) çözümleyici
        // 'unknown' der — bu doğru ve dürüst cevaptır: abonelik kanalı motorun
        // jeton zarfında GÖRÜNMEZ, plan uydurulmaz.
        subscriptionWhen: 'never',
        sourceLabel: 'agy -p … -o json → usage{input_tokens,output_tokens,thinking_tokens,cache_read_tokens,total_tokens}',
        overrideOpt: null,
      }),
    }),

    // ─── 3. KAPI — SÜPERVİZÖR OKUMA: TAM. Bu motorun EN GÜÇLÜ yanı.
    // ÖLÇÜLDÜ (stream-json, NDJSON): `init` (model + cwd + 56 araçlık liste +
    // permission_mode) · adım başına `step_update` (step_type, tool_name,
    // tool_info.parameters, duration_seconds, usage) · kapanışta `result`
    // (status + response + num_turns + toplam usage).
    output: Object.freeze({
      kind: 'json',
      flag: '--output-format',
      values: Object.freeze(['text', 'json', 'stream-json']),
      quietFlag: null,
      requiresQuiet: false, // ÖLÇÜLDÜ: JSON stdout'ta TEK BAŞINA (loglar stderr'de)
      // 🔴 AGY-04 — KAPSAM SINIRI, SATICININ KENDİ CÜMLESİYLE: `--output-format
      // Output format for PRINT MODE (text, json, stream-json) (default text)`
      // (AGY-05-evidence/03-help.txt:17). İnteraktif pane bu zarfı BASMAZ ⇒
      // süpervizör okuması ve jeton rozeti YALNIZ headless (`-p`) koşuda çalışır.
      // Bu alan yazılı DEĞİLKEN "pane'de de okuruz" varsayımı iki kez yapıldı;
      // beyan o varsayımı YAPISAL olarak imkânsız kılar.
      printModeOnly: true,
      // Okuyucu: `electron/agyStreamReader.cjs` (NDJSON + tek-nesne `json` kolu).
      reader: 'electron/agyStreamReader.cjs',
      // ÖLÇÜLDÜ: `status` İKİ YÖNDE DE YALAN SÖYLER (R1 §7-R1 · AGY-02 §5-R3) ⇒
      // bitiş hükmünün otoritesi `response` + çıkış kodudur.
      verdictAuthority: 'response+exit',
      measuredVersion: '1.2.2',
    }),

    install: Object.freeze({
      label: 'Antigravity CLI',
      // Satıcı script'i OKUNDU (239 satır, ENG-18 §5.2 ile aynı sürüm):
      // manifest → sha512 DOĞRULAMA → `~/.local/bin/agy` → son adımda `agy install`.
      // 🟠 SON ADIMIN ÖLÇÜLEN YAN ETKİSİ: hem `~/.bashrc` hem `~/.zshrc` sonuna
      // `# Added by Antigravity CLI installer` + PATH satırı EKLİYOR (izole HOME'da
      // yeniden üretildi). Ürün için gereksiz (`~/.local/bin` zaten augmentedPath'te)
      // ama kullanıcıya satıcının KENDİ komutunu göstermek doğru olan; yan etki
      // burada BEYAN edilir. `agy install --skip-path --skip-aliases` bunu kapatır
      // ama kurucu script'ten geçirilemiyor (bayrak yolu yok).
      command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
      // Windows komutu gemini CLI'ın KENDİ göç yardımcısından okundu
      // (packages/cli/src/ui/utils/antigravityUtils.ts, bundle'da).
      win32Command: 'powershell -ExecutionPolicy ByPass -c "irm https://antigravity.google/cli/install.ps1 | iex"',
      docsUrl: 'https://antigravity.google/docs/cli/overview',
      checkHint: 'https://antigravity.google/docs/cli/overview',
      installsTo: '~/.local/bin', // script'te sabit: TARGET_DIR="$HOME/.local/bin"
      // 🪤 İKİ KATMANLI TUZAK (ölçüldü):
      //   ① `--version` YALNIZ "1.1.14" basar → ürün kimliğini kanıtlamaz.
      //   ② `--help`in ilk satırı ürün adını taşımıyor, `basename $0`'ı taşıyor:
      //      arşivden `./antigravity --help` "Usage of antigravity:" derken kurulu
      //      hâli `agy --help` "Usage of agy:" diyor. Ada bakan kalıp DOĞRU ürünü
      //      reddediyordu (verifyInstall → error:"wrong-product", head:"Usage of agy:").
      // → kalıp motorun KENDİ seçenek AÇIKLAMASINA bağlandı (ada bağımsız).
      verifyArgv: Object.freeze(['--help']),
      verifyPattern: 'Timeout\\s+for\\s+print\\s+mode\\s+wait',
    }),

    // ─── AGY-05 — EFOR KOLU: BEYAN EDİLDİ (agy 1.2.2'de ÖLÇÜLDÜ) ──────────────
    //
    // CDX-F1 bu alanı `unverified` bırakmıştı ("aranmadı"); ANTIGRAVITY-R1 §3.2 aradı
    // ve AGY-05 aynı dört kuralı agy 1.2.2'de TEKRAR ölçtü. `agy --help`:
    //   `--effort  Reasoning effort for the current CLI session (low|medium|high)`
    //
    // 🔴 codex'İN TAM TERSİ BİR DÜNYA — ve tasarımı bu belirliyor: codex değeri
    // DOĞRULAMAZ (beyaz liste BİZİM korumamızdı); antigravity DOĞRULAR ve geçersiz
    // birleşimde turu HİÇ başlatmadan `exit 1` ile ölür. Yani burada hatalı argv
    // "kötü bir tur" değil, ÖLÜ BİR PANE demektir (R1 §7-R2, 🔴 yüksek).
    //
    // Ölçülen dört kural (gerçek koşu, MODEL TURU HARCANMADI — doğrulama API
    // çağrısından önce düşüyor; kanıt: AGY-05-evidence/02-negatives.txt):
    //   1. ÇIPLAK aile adı + `--effort`  → doğru gramer (`gemini-3.8-flash` + medium ✅)
    //   2. SONEKLİ ad + ÇELİŞEN efor     → `--model gemini-3.8-flash-low conflicts with --effort=high`
    //      (🪤 AGY-05 inceltmesi: değerler AYNIYSA motor KABUL EDİYOR — `…-high --effort high`
    //       turu başlattı. Ürün yine de basmaz: birleşim gereksiz ve "eşitse geçer" kuralı
    //       satıcı yazımı değiştiğinde sessizce ölümcül argv üretirdi.)
    //   3. Değerler MODEL BAŞINA         → `gemini-3.1-pro has no "medium" effort (available: low, high)`
    //   4. claude-* ailelerinde efor YOK → `--effort is not supported for model "claude-sonnet-4-6"`
    //
    // 🔑 MODEL BAŞINA KISIT NEDEN BURADA DEĞİL: `values` bu motorun TAŞIYICI kümesidir
    // (help'in beyanı). Model-kapsamlı kesişim bir LİSTE işidir ve listeler kendi
    // modülünde yaşar (`model.catalog` deseni) → `catalog` + `modelScoped` alanları
    // argv üreticisini modelCatalog.effortValuesFor'a yönlendirir. Motor adına göre
    // `if` YAZILMADI (agentRunner.js 669. satırın kuralı): karar VERİDEN çıkar.
    effort: Object.freeze({
      kind: 'flag',
      flag: '--effort',
      values: Object.freeze(['low', 'medium', 'high']),
      position: 'append',
      // AGY-05 — model-kapsamlı kesişimin adresi (liste KOPYALANMAZ).
      catalog: 'electron/modelCatalog.cjs',
      // 🔴 FAIL-CLOSED ANAHTARI: bu motorda bir efor değeri, SEÇİLİ MODEL onu kabul
      // ettiği KANITLANMADIKÇA argv'ye basılmaz (model yok/sonekli/katalog dışı → NO-OP).
      modelScoped: true,
      // §6-1 — ölçümün SÜRÜM DAMGASI: `guard:agy:contract` bunu canlı `agy --version`
      // ile karşılaştırır; ikili kendini güncelleyince bayatlık GÖRÜNÜR olur.
      measuredVersion: '1.2.2',
    }),

    unsupported: Object.freeze({
      contextScope:
        'bu motorun kendi belge enjeksiyonunu (proje talimatı zinciri + kalıcı hafıza indeksi) çalışma alanıyla sınırlayan bir taşıyıcı ÖLÇÜLMEDİ — kesim yalnız beyan eden motorda koşar, burada bugünkü davranış aynen sürer (TOKEN-BUDGET-01)',
      images:
        'girdi-görsel bayrağı YOK (tam `--help` seçenek listesi ölçüldü: 22 seçenek, attachment/image dengi yok) → görsel yolu prompt METNİNE gömülmeli. NOT: araç listesinde `generate_image` VAR ama o ÜRETİM aracıdır, girdi yolu değil',
      provider:
        'BYOK grameri YOK: motor yalnız Google uçlarına bağlanır. Ölçülen tek "sağlayıcı" anahtarı settings.json\'daki `modelProvider:"gemini"` (Gemini API) — ikilide `GOOGLE_GEMINI_BASE_URL` dizesi geçiyor ama uç DEĞİŞTİRİR, sağlayıcı DEĞİL (gemini kaydıyla aynı sınır)',
      trust:
        'çalışma dizini GÜVEN kapısı yok: motor `--add-dir` ile verilen kökü sorgusuz kabul etti (gemini\'nin exit 55 ile duran `GEMINI_CLI_TRUST_WORKSPACE` kapısının dengi ÖLÇÜLMEDİ, bayrak listesinde yok)',
      reset:
        'pane RESET slash komutu gerçek TUI oturumunda ölçülmedi (bu turun tamamı headless koştu) → var olmayan bir komut göndermek pane\'e sessizce metin yazardı',
      tui:
        'TUI hazır/blocker dizeleri GERÇEK pane\'de ölçülmedi → paneReadiness regex\'i YOK (gemini kaydıyla aynı takip kalemi)',
      skillsDir:
        'ikili dizelerinde `.agents/skills/` ve `.agents/skills.json` geçiyor ama keşif dizini GERÇEK koşuda doğrulanmadı → uydurma bir yol skill\'leri sessizce görünmez yapardı',
      identityEnv:
        '🔴 KAYDIN ÇALIŞTIRMAYA KAPALI OLMASININ İKİNCİ SEBEBİ: motor ev dizinini taşıyan env YOK. ÖLÇÜLDÜ — `ANTIGRAVITY_EXECUTABLE_DATA_DIR`, `GEMINI_CLI_HOME` ve `AGY_HOME` üçü de denendi, ÜÇÜNDE DE durum ağacı yine `$HOME/.gemini/…` altında oluştu (alternatif dizin BOŞ kaldı). Yani auth ayarı, MCP kaydı, konuşma defteri ve güncelleyici HOME\'a çivili → iki pane\'e iki farklı hesap/araç seti verilemez ve HOME\'u ezmek (git/ssh/kabuk config\'i taşıdığı için) ürün açısından kabul edilemez',
    }),

    partial: Object.freeze({
      effort:
        'AGY-05 — TAŞIYICI ÖLÇÜLDÜ (agy 1.2.2) ve dört kuralı da gerçek koşuyla doğrulandı, ama İKİ SINIR beyanlı kalıyor: (a) model-kapsamlı küme STATİK bir katalogdan geliyor (`modelCatalog.ANTIGRAVITY_MODELS`) çünkü `agy models` çıktısı SONEKLİ ad veriyor (ham kullanımı argv\'de ölümcül) ve her çağrısı ağa çıkıp girişsiz makinede 60 sn OAuth duvarına asılıyor → katalog motor sürüm atladığında BAYATLAR, tazeliği `guard:agy:contract` ölçer; (b) `--model` VERİLMEDEN yalnız `--effort` geçmenin kabul edilip edilmediği ÖLÇÜLMEDİ (ölçmek bir model turu harcardı) → ürün o durumda bayrağı ÜRETMEZ (fail-closed), yani motor kendi varsayılanıyla koşar',
      identity:
        'ENG-ENABLE-01 — TAŞIYICI BAĞLANDI (`kind:\'flag-dir\'`) ve 1.1.28\'de YENİDEN ölçüldü; İKİ SINIR beyanlı kalıyor: (a) 🔴 SIRA ZORUNLU — kimlik dizini İLK verilirse araçların cwd\'si oraya kayar (ölçüldü: ajanın `pwd`\'si kimlik dizini çıktı); ürün bu yüzden `cwdFirst` ile önce iş dizinini yazar, bayrağın sırasını bozan bir değişiklik ajanı YANLIŞ DİZİNDE koşturur. (b) dosya adı MOTORUN dayatması (`AGENTS.md`) → kullanıcının kendi `AGENTS.md`i ile aynı ad; pane kimliği AYRI bir dizinde tutulur, kullanıcının repo\'suna HİÇBİR ŞEY yazılmaz',
      extraRoots:
        '🔑 BAYRAK ÜÇ İŞ YAPIYOR ve SIRA ÖNEMLİ (ölçüldü): `--add-dir` yalnız ek kök EKLEMİYOR, araçların ÇALIŞMA DİZİNİNİ de belirliyor. Bayraksız koşuda ajanın `pwd` çıktısı `$HOME/.gemini/antigravity-cli/scratch` oldu (sürecin cwd\'si DEĞİL) ve bayraksız bir "dosya oluştur" isteği dosyayı çalışma kökünün DIŞINA yazdı. Tek bayrakla cwd doğru geldi. İKİ bayrakta İLK olan kazanıyor: `--add-dir <kimlik> --add-dir <kök>` → pwd KİMLİK dizini; ters sırada → pwd KÖK ve kimlik yine okundu. Ürün bağlarken sıra ZORUNLU: önce çalışma kökü, sonra kimlik dizini',
      usage:
        'jeton defteri ÇIKTIDA TAM ve adım başına ayrışıyor (`usage{input_tokens,output_tokens,thinking_tokens,cache_read_tokens,total_tokens}`; canlı turda 11.526/338/328/0/11.864 ölçüldü) ama (a) USD YOK, (b) ürünün `session-ledger`/`cli-report` okuyucuları "koşu zarfının içindeki sayaç" şeklini tanımıyor → jeton kartı bugün "bilinmiyor" der. Konuşma başına SQLite defteri de var (`conversations/<id>.db`, protobuf blob) ama ayrıştırıcısı YOK',
      session:
        '`conversation_id` HER zarfta yayınlanıyor (kesin eşleme mümkün) ve `--conversation <id>` / `-c` bayrakları help\'te ölçüldü — ama GERÇEK bir devam turu (resume) koşulmadı: kimliğin resume\'da yeniden okunup okunmadığı ÖLÇÜLMEDİ',
      auth:
        'anahtar yolu CANLI doğrulandı (SUCCESS + tam jeton zarfı) ama OAuth/abonelik yolu ölçülemedi: akış tarayıcı ister ve `antigravity.google/oauth-callback` dönüşünden kod yapıştırmayı bekler. 🟠 İSTENEN KAPSAM GENİŞ: `…/auth/cloud-platform` (kullanıcının TÜM GCP\'si) + `aicode` + `cclog` + `experimentsandconfigs` — bir kod asistanı için geniştir, ENG-18 §5.6 ile aynı uyarı',
      install:
        'kurulum kanıtlanabilir ve GÜVENLİ (manifest sha512 doğrulandı: darwin_arm64 1.1.14, indirilen 49 MB paketin sağlaması BİREBİR tuttu) ama 🟠 motor ARKA PLANDA KENDİNİ GÜNCELLİYOR: kurucu script\'in kendi cümlesi "The Antigravity CLI automatically self-updates in the background during regular runs" ve ilk koşuda `updater/update_status.json` yazıldı. Sonuç: ölçülen sürüm (1.1.14) sabitlenemez — ENG-18 1.1.13 ölçmüştü, bir gün sonra 1.1.14. Her spawn öncesi `--version` kaydı bu yüzden takip kalemi',
      output:
        'stream-json TAM ölçüldü; `--json-schema` ile yapılandırılmış çıktı ZORLAMA yolu help\'te VAR ama gerçek bir şemayla ÖLÇÜLMEDİ',
    }),

    verification: Object.freeze({
      contextScope: Object.freeze({ channel: 'unverified', source: 'TOKEN-BUDGET-01 — bu motorda belge-enjeksiyonunu kapatan bir bayrak ARANMADI/ÖLÇÜLMEDİ; kesim yalnız beyan eden motorda koşar' }),
      effort: Object.freeze({ channel: 'measured', source: 'AGY-05-evidence/02-negatives.txt + 03-help.txt (agy 1.2.2 GERÇEK koşu, 2026-09-14): `agy --help` → `--effort  Reasoning effort for the current CLI session (low|medium|high)`; dört kural da gerçek çıktıyla doğrulandı — `gemini-3.1-pro`+medium → "has no \"medium\" effort (available: low, high)", `claude-sonnet-4-6`+high → "--effort is not supported", `gemini-3.8-flash-low`+high → "conflicts with --effort=high" (exit 1, MODEL TURU HARCANMADI). Kabul edilen birleşim (`gemini-3.8-flash`+medium) ANTIGRAVITY-R1 §3.2\'de ölçüldü; AGY-05 onu TEKRAR koşmadı (kabul = tur başlar = jeton harcar)' }),
      identity: Object.freeze({ channel: 'measured', source: 'ENG-22-evidence/04-antigravity-identity.md (aynı cwd, iki `--add-dir` dizini, iki kod kelimesi; taban KORUNDU 11.512→11.824 jeton) + ENG-ENABLE-01-evidence/agy-identity.txt (agy 1.1.28 tekrar ölçümü: kimlik DELTA5 geldi; tek bayrakta `pwd` KİMLİK dizini, iş dizini ÖNCE verilince `pwd` doğru VE kimlik yine okundu)' }),
      model: Object.freeze({ channel: 'measured', source: 'ENG-22-evidence/02-antigravity-argv.md — `agy --help` → `--model  Model for the current CLI session` + `agy models` çıktısı (4 model) + `--model gemini-3.5-flash` ile canlı SUCCESS turu' }),
      images: Object.freeze({ channel: 'measured', source: 'ENG-22-evidence/02-antigravity-argv.md — tam seçenek listesinde görsel bayrağı yok; init olayının araç listesinde yalnız `generate_image` (üretim) var' }),
      provider: Object.freeze({ channel: 'measured', source: 'ikilinin gömülü changelog\'u (1.1.13): modelProvider "gemini" + GEMINI_API_KEY + GOOGLE_GEMINI_BASE_URL — üçü de GOOGLE uçları; BYOK grameri yok' }),
      session: Object.freeze({ channel: 'measured', source: 'ENG-22-evidence/06-antigravity-delegation.md — her zarf `conversation_id` taşıyor (init/step_update/result) + `agy --help` → `--conversation`, `-c/--continue`' }),
      subagentBlock: Object.freeze({ channel: 'measured', source: 'AGY-03 (2026-09-15, agy 1.2.2, GERÇEK tur + KONTROL KOLU): demetin hooks.json\'undaki PreToolUse deny kapısı ÇALIŞTI — invoke_subagent adımı state:"ERROR" oldu ve modelin cevabına BİZİM gerekçemiz düştü; hook enabled:false yapılınca (tek değişken) alt-ajan AÇILDI (ALTAJAN=BASARILI). Kanıt: AGY-03-evidence/01-run-hooks-on.md + 02-run-control-arm.md' }),
      trust: Object.freeze({ channel: 'measured', source: 'ENG-22-evidence/02-antigravity-argv.md — tam bayrak listesinde güven kapısı yok; `--add-dir` verilen kök sorgusuz kabul edildi' }),
      reset: Object.freeze({ channel: 'unverified', source: 'TUI açılmadı (bu tur headless) → alan null' }),
      tui: Object.freeze({ channel: 'unverified', source: 'TUI açılmadı (bu tur headless) → alan null' }),
      mcp: Object.freeze({ channel: 'measured', source: 'ENG-22-evidence/07-antigravity-mcp.md — `$HOME/.gemini/config/mcp_config.json` yazıldı → probe sunucusu SPAWN oldu (kendi log dosyasına yazdı) ve motor log\'u `mcp/eng22probe` adını bastı; init araç listesinde jenerik `call_mcp_tool`' }),
      hooks: Object.freeze({ channel: 'measured', source: 'AGY-03 (2026-09-15, agy 1.2.2): demet içi plugins/<ad>/hooks.json GERÇEK turda okundu — PreInvocation brifingi modelin cevabına geçti (BRIEF kodu) ve PreToolUse deny kapısı aracı durdurdu. ÖLÇÜLEN İKİ ŞEKİL FARKI: PreInvocation MODEL ÇAĞRISI başına ateşliyor (tek -p turunda invocationNum 0,1,2) ve MCP çağrısı hook\'a call_mcp_tool adıyla geliyor (hedef ad args.ToolName/args.ServerName gövdesinde). Kanıt: AGY-03-evidence/03-pretooluse-names.md' }),
      extraRoots: Object.freeze({ channel: 'measured', source: 'ENG-22-evidence/05-antigravity-autonomy-cwd.md — bayraksız `pwd` → `$HOME/.gemini/antigravity-cli/scratch`; `--add-dir <kök>` → kök; iki bayrakta İLK olan kazandı (iki koşu, iki sıra)' }),
      skillsDir: Object.freeze({ channel: 'doc', source: 'ikili dizeleri: `.agents/skills/` (2), `.agents/skills.json` (2) — gerçek keşif ölçülmedi' }),
      identityEnv: Object.freeze({ channel: 'measured', source: 'ENG-22-evidence/03-antigravity-auth.md — ANTIGRAVITY_EXECUTABLE_DATA_DIR / GEMINI_CLI_HOME / AGY_HOME üçü de denendi; durum ağacı her seferinde $HOME/.gemini altında oluştu, alternatif dizin BOŞ kaldı' }),
      auth: Object.freeze({ channel: 'measured', source: 'ENG-22-evidence/03-antigravity-auth.md — (a) settings.json YOK + anahtar VAR → OAuth duvarı + 60 sn asılma; (b) settings.json `{"modelProvider":"gemini"}` + anahtar → duvar YOK, canlı tur SUCCESS ("ENG22-BASELINE-OK"); OAuth URL kapsamı ham hâliyle arşivde' }),
      usage: Object.freeze({ channel: 'measured', source: 'ENG-22-evidence/06-antigravity-delegation.md — `-o json` zarfı ve step_update olayları usage{input,output,thinking,cache_read,total} taşıyor; USD alanı YOK' }),
      output: Object.freeze({ channel: 'measured', source: 'ENG-22-evidence/06-antigravity-delegation.md — gerçek NDJSON akışı: init(model,cwd,56 araç,permission_mode) → step_update(step_type,tool_name,tool_info.parameters,usage) → result(status,response,num_turns,usage)' }),
      install: Object.freeze({ channel: 'measured', source: 'ENG-22-evidence/02-antigravity-argv.md — manifest darwin_arm64 (1.1.14) + sha512 BİREBİR eşleşti + izole HOME\'da `agy install` .bashrc/.zshrc\'ye PATH satırı ekledi (yeniden üretildi) + `--help` başlığı "Usage of antigravity:"' }),
    }),
  }),

  // ENGINE-MUSE-02 (ratchet) — ON DÖRDÜNCÜ MOTOR: Meta Muse Code (`muse` 1.0.3-R2198.1).
  //
  // NİÇİN GİRİYOR: ENGINE-MUSE-01 Eren'in sorusunu ölçtü — "abonelikle CLI erişimi
  // var mı?" → EVET (resmî abonelik belgesi: "your subscription only works through the
  // Muse Code CLI while signed in with your Meta Model API account"). Yani motor
  // "yalnız ücretli Model API" sınıfında DEĞİL; kataloğa girmeye aday.
  //
  // 🔑 BU KAYIT NEYE DAYANIYOR — HESAPSIZ ÖLÇÜM (ENGINE-MUSE-02 turu, 2026-09-05):
  // Kurulum İZOLE HOME'da GERÇEKTEN yapıldı (Eren'in makinesine/PATH'ine dokunulmadı:
  // `MUSE_INSTALL_DIR` + `MUSE_NO_MODIFY_PATH=1`) ve ikili KOŞTURULDU. Ölçülenler
  // `docs/agent-results/ENGINE-MUSE-02-evidence/` altında:
  //   ① `muse --version` → "Muse Code 1.0.3 (1.0.3-R2198.1)" — ürün adı VAR (03-…)
  //   ② `muse --help` + 10 alt-komut yardımı — tam bayrak yüzeyi (01-…, 02-…)
  //   ③ `muse exec --provider echo --json` → GERÇEK 13 satırlık JSONL olay akışı,
  //      HESAPSIZ (04-…/05-…): motorun `echo` sağlayıcısı ücretli uca hiç gitmiyor
  //   ④ ikilinin ayar şeması (strings) — `settings.mcp_servers.<id>`,
  //      `settings.run.system_prompt`, `agent_definitions` (06-…)
  //
  // 🔴 `enabled=false` (public.engines) — ve bu bir iyimserlik değil, ÖLÇÜMÜN SONUCU:
  //   (1) KİMLİK ÜRÜN GRAMERİNDE YOK. Taşıyıcı adayları VAR (`--agents <JSON>`
  //       ephemeral agent-definition overlay + `settings.run.system_prompt`) ama
  //       ADDITIVE mi REPLACE mi olduğu ÖLÇÜLEMEDİ: `echo` sağlayıcısı sistem
  //       prompt'unu yayınlamıyor, gerçek model turu ise HESAP istiyor. Ölçülmemiş
  //       bir kimlik taşıyıcısını açmak, gemini'nin ENG-14'te ölçülen REPLACE
  //       tuzağını körlemesine tekrarlamaktır → fail-closed.
  //   (2) ALT-AJAN BLOĞU ÖLÇÜLMEDİ: ikilide `subagent_delegation_mode` ayarı ve
  //       `--subagent-worktree-isolation` (yalnız İZOLASYON) var; SERT kapatma yolu
  //       koşturulmadı. CrewPane'te alt-ajan ürün kuralıyla yasak (ADR-004) →
  //       ölçülmemiş blok, olmayan bir korumayı VAR sanmaktır (ENG-19 lider kapısı
  //       bu yüzden de kapalı kalır).
  //   (3) HESAP DUVARI: ücretsiz katman YOK; `meta` sağlayıcısı ödeme yöntemi
  //       eklenmeden çalışmıyor (ENGINE-MUSE-01 §1). Canlı tur "EREN GİRİŞİ
  //       BEKLİYOR" — kart ENGINE-MUSE-03.
  //
  // ⚠️ WINDOWS YOK: kurucu `bash` script'i (POSIX; `install.ps1` dengi YOK) →
  //    `install.win32Command: null` (engineInstall win32'de komut UYDURMAZ, dokümana
  //    yönlendirir — ENG-13 kuralı).
  muse: Object.freeze({
    id: 'muse',
    label: 'Muse Code',
    // Site kimliği ile ikili adı bu motorda AYNI (`muse`) — cursor/antigravity
    // tuzağı burada YOK (kurucu script: `command_name="muse"`, 04-…/install.sh).
    bin: 'muse',

    // BOŞ ve BİLİNÇLİ: `--yolo` / `--disable-approval` ölçülen yardım metninde VAR
    // ama alınmadı (gerekçe `autonomy.why`). Motor zaten çalıştırmaya kapalı.
    defaultArgs: Object.freeze([]),

    autonomy: Object.freeze({
      level: 'partial',
      via: null,
      flags: Object.freeze([]),
      why:
        'ÖLÇÜLDÜ (01-muse-help.txt): "Safety (approval and the sandbox are ON by default)" — varsayılan `--approval-mode on-request`. Tam parite `--yolo` (onay + sandbox + workspace güveni HEPSİNİ kapatır) ya da `--disable-approval` demek; ikisi de GERÇEK bir onay turunda ölçülmedi (hesapsız `echo` sağlayıcısı araç çağırmıyor) ve bu motorun kimlik/alt-ajan kapıları da kapalı → bayrak ALINMADI. claude paritesi ENGINE-MUSE-03\'ün (canlı tur) kararıdır, bu kartın değil',
    }),

    // ─── 1. KAPI — KİMLİK: taşıyıcı ADAYLARI ölçüldü, SEMANTİĞİ ölçülmedi → null.
    identity: null,

    // ÖLÇÜLDÜ (01-muse-help.txt): `--model <MODEL>  Model id for non-echo providers`
    // hem kökte hem `exec` altında. Model ADLARI ölçülemedi (katalog hesap ister) →
    // `detect` yok: ürün model listesi UYDURMAZ.
    model: Object.freeze({
      kind: 'flag',
      flag: '--model',
      position: 'append',
      detect: null,
    }),

    // CDX-F1 — EFOR KOLU: bu motorda AYRI bir bayrak ve enum ikilinin kendi yardım
    // metninde YAZILI (01-muse-help.txt): `--reasoning-effort <EFFORT>  Meta reasoning
    // effort: none|minimal|low|medium|high|xhigh|max|ultra (default: high)`.
    // Beyaz liste burada ZORUNLU (şema kuralı): geçersiz değer turu ERROR ile öldürür.
    effort: Object.freeze({
      kind: 'flag',
      flag: '--reasoning-effort',
      values: Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
    }),

    images: null,
    provider: null,
    session: null,
    // TOKEN-BUDGET-01 — BAĞLAM KAPSAMI: bu motorun kendi belge enjeksiyonunu
    // (proje talimatı zinciri + kalıcı hafıza indeksi) ÇALIŞMA ALANIYLA sınırlayan
    // bir taşıyıcı ÖLÇÜLMEDİ. `null` = bugünkü davranış aynen sürer; kesim yalnız
    // beyan eden motorda uygulanır (paneContextScope HEPSİ-YA-HİÇ kuralı).
    contextScope: null,
    subagentBlock: null,
    trust: null,
    reset: null,
    tui: null,
    mcp: null,
    hooks: null,
    extraRoots: null,
    skillsDir: null,
    identityEnv: null,

    // ─── 4. KAPI — HESAP: ABONELİK BİRİNCİL, ürün akışı SÜREMİYOR ────────────
    // ÖLÇÜLDÜ (02-muse-subcommand-help.txt): `muse login` → "Log in with your Meta
    // account: approve a code in your browser. META_API_KEY always takes priority
    // over the account login." · `muse logout` → "Remove the saved Meta credential".
    // Durum/whoami komutu YOK (komut listesi: resume|exec|config|export|trace|skills|
    // sandbox|schema|serve|session-message|auth|login|logout|init).
    //
    // 🔴 `flow:'external'` ve `loginArgv:null` — NİÇİN: giriş tarayıcıda bir KOD
    // onayı ile bitiyor ve ürün o akışı SÜRMÜYOR (kod kutusu çizip kullanıcıyı
    // sürülemeyen bir akışa göndermek ENG-08\'in kapattığı yalan). `muse login`
    // GERÇEK bir komut ama akışın şekli (kod stdin\'e mi akıyor, callback mı)
    // ölçülmedi → uydurulmaz; kullanıcı komutu `accountHint`te GÖRÜR.
    auth: Object.freeze({
      label: 'Muse Code',
      accountHint:
        'Meta Model API hesabı + ödeme yöntemi ZORUNLU (ücretsiz katman YOK). Abonelik BİRİNCİL yol: Everyday $5/ay · High $15 · Power $50 — abonelik Muse Code CLI için geçerli, jeton faturası çıkmaz. Kurulum: `curl -fsSL https://dev.meta.ai/install.sh | sh`, sonra terminalde `muse login` (tarayıcıda kod onayı). MMA (Meta Managed Account) hesaplarında tarayıcı girişi ÇALIŞMAZ, anahtar zorunludur',
      signupUrl: 'https://dev.meta.ai/docs/muse-code/subscriptions/',
      flow: 'external',
      needsCode: false,
      loginArgv: null,
      logoutArgv: null,
      statusArgv: null,
      statusParse: null,
      statusNote:
        'muse 1.0.3\'te hesap DURUMU/whoami komutu YOK (tam komut listesi ölçüldü: resume|exec|config|export|trace|skills|sandbox|schema|serve|session-message|auth|login|logout|init — 01-muse-help.txt) → rozet ÜÇÜNCÜ durumu gösterir: BİLİNMİYOR. `muse config status` yalnız KURUMSAL yapılandırma düzlemlerini basar (defaults/policy), hesabı DEĞİL (ölçüldü: dört kaynak da state=absent)',
      apiKey: null,
      // 🔑 `noApiKeyNote` — Ayarlar → Hesaplar kartında "Neden API anahtarı kutusu
      // yok?" sorusunun cevabı. EREN KURALI (2026-08-17): abonelik BİRİNCİ SINIF.
      apiKeyNote:
        'Bu motorda anahtar kutusu BİLEREK açılmadı: Eren\'in kararı abonelik yolu ($5 Everyday, ENGINE-MUSE-01) ve abonelik CLI\'ın KENDİSİNİ kapsıyor — anahtar yolu ise jeton-başına faturalanır ($1,25/M girdi · $4,25/M çıktı) ve ürün onu ÖLÇMEDİ. Motorda anahtar yolu GERÇEKTEN var (`META_API_KEY` env — motorun kendi cümlesi: "META_API_KEY always takes priority over the account login" — ve `muse auth set --api-key-stdin`, anahtar argv\'ye ASLA girmiyor). Kutu yalnız iki durumda açılır: (a) hesap bir Meta Managed Account ise (tarayıcı girişi orada çalışmıyor), (b) Eren jeton-başına ödemeyi açıkça seçerse. İkisi de ENGINE-MUSE-03\'ün kararı',
    }),

    usage: null,

    // ─── 3. KAPI — SÜPERVİZÖR OKUMA: TAM ve HESAPSIZ ÖLÇÜLDÜ ────────────────
    // `muse exec --json` → satır-satır JSON (05-echo-exec-json.jsonl, 13 satır):
    // her satırda `schema_version`, `stream{kind:'session',id}`, `sequence`,
    // `record_type` (event|status|reconciliation), `payload_type`
    // (runtime.command.accepted · session.run.linked · turn.input.user ·
    // run.lifecycle.started · task.lifecycle.{proposed,accepted,scheduled,
    // side_effect_intent,started,completed} · run.output.delta ·
    // run.terminal.completed) ve `payload`. Kapanış olayı `run.terminal.completed`
    // → `{terminal:'completed'|…, text, reason}`.
    output: Object.freeze({
      kind: 'jsonl',
      flag: '--json',
      values: null, // bayrak DEĞER ALMIYOR (boolean) — ölçüldü
      quietFlag: null,
      requiresQuiet: false,
      subcommand: 'exec', // `--json` YALNIZ `muse exec` altında (kök help\'te yok)
      resultEvent: 'run.terminal.completed',
    }),

    install: Object.freeze({
      label: 'Muse Code',
      // ÖLÇÜLDÜ: resmî kurucu (314 satır) OKUNDU ve İZOLE HOME\'da KOŞTURULDU.
      //   ✅ `command_name="muse"` · `install_dir="${MUSE_INSTALL_DIR:-$HOME/.local/bin}"`
      //      → ürünün `augmentedPath`inde ZATEN olan dizin (ADP-707 kuralı).
      //   ✅ launcher `x-content-sha256` başlığıyla DOĞRULANIYOR (varsa) + `bash -n`
      //      söz dizimi kontrolü; indirme `--proto '=https'` ile TLS\'e kilitli.
      //   🟠 YAN ETKİ: PATH satırını `~/.zshrc`/`~/.bashrc`/`~/.profile`/fish conf\'a
      //      EKLİYOR (`MUSE_NO_MODIFY_PATH=1` kapatır — ölçüm turunda kullanıldı).
      //   🟠 İkili İKİ PARÇA: `~/.local/bin/muse` (33 KB launcher) + yanına inen
      //      `muse-bin-<sürüm>` (242 MB) → launcher kendini güncelleyebilir.
      command: 'curl -fsSL https://dev.meta.ai/install.sh | sh',
      // POSIX-only: kurucu `#!/usr/bin/env bash` ve `install.ps1` dengi YOK.
      win32Command: null,
      docsUrl: 'https://dev.meta.ai/docs/muse-code/',
      checkHint: 'https://dev.meta.ai/docs/muse-code/',
      installsTo: '~/.local/bin',
      // 🔑 Bu motorda `--version` ÜRÜN ADINI TAŞIYOR (ölçüldü, 03-muse-version.txt):
      // "Muse Code 1.0.3 (1.0.3-R2198.1)" → gemini/opencode\'daki `--help` dolambacı
      // GEREKMİYOR. Kalıp sürümden bağımsız.
      verifyArgv: Object.freeze(['--version']),
      verifyPattern: 'Muse\\s+Code\\s+\\d',
    }),

    unsupported: Object.freeze({
      contextScope:
        'bu motorun kendi belge enjeksiyonunu (proje talimatı zinciri + kalıcı hafıza indeksi) çalışma alanıyla sınırlayan bir taşıyıcı ÖLÇÜLMEDİ — kesim yalnız beyan eden motorda koşar, burada bugünkü davranış aynen sürer (TOKEN-BUDGET-01)',
      identity:
        '🔴 KAYDIN ÇALIŞTIRMAYA KAPALI OLMASININ BİRİNCİ SEBEBİ. İKİ taşıyıcı ADAYI ölçüldü ama İKİSİNİN DE semantiği ölçülemedi: (a) `--agents <JSON>` — "Supply one ephemeral agent-definition overlay"; ikilinin şemasında ajan tanımı alanları da okundu (name/description/prompt/tools/disallowed_tools/model/effort/permission_mode/max_turns/background/isolation/skills/mcp_servers/hooks/memory) → pane BAŞINA argv ile kimlik VERİLEBİLİR görünüyor; (b) `settings.run.system_prompt` + `settings.run.developer_prompt` ayar anahtarları. Hiçbiri EKLİYOR mu (ADDITIVE) YERİNE Mİ geçiyor (REPLACE) sorusunu cevaplamıyor: `--provider echo` turu sistem prompt\'unu yayınlamıyor, `meta` sağlayıcısı ise ödeme yöntemi olmadan koşmuyor. Ölçülmemiş bir REPLACE taşıyıcısını açmak gemini\'nin ENG-14\'te ölçülen felaketidir (efektif prompt 25.073 → 2.126 karakter) → alan null, fail-closed. Ölçüm ENGINE-MUSE-03: "Eren girişi bekliyor"',
      images:
        'bayrak GERÇEKTEN var (`--image <PATH>` kökte, `exec` altında "repeatable") ama tek bir görsel turu bile koşulmadı (hesap duvarı) → ürün "bu pane\'e görsel gönderilebilir" DEMEZ; `imageAttach` tarafında da kapalı. Ölçülünce açılır',
      provider:
        'BYOK grameri bu motorda ürünün `providers.cjs` sözleşmesiyle EŞLEŞMİYOR: `--provider <MODE>` yalnız İKİ değer alıyor (`echo` | `meta`, ölçüldü) — yani üçüncü-taraf uç seçimi değil, motorun kendi sağlayıcı kipi. `--base-url` ile Meta ucu değiştirilebiliyor ama bu SAĞLAYICI değil UÇ değişimidir (gemini/antigravity ile aynı sınır). İkilide ANTHROPIC_/OPENAI_/OPENROUTER_ anahtar adları geçiyor ama hangi yolda kullanıldığı ÖLÇÜLMEDİ → uydurulmaz',
      session:
        'oturum yüzeyi ZENGİN ve ölçüldü (`muse exec --session-id <UUID>` · `muse resume [--last|<uuid>]` · JSONL akışının HER satırında `stream{kind:"session",id}`) ama GERÇEK bir devam (resume) turu koşulmadı: kimliğin/araçların resume\'da yeniden okunup okunmadığı bilinmiyor. Ürün oturum kimliğini BASACAKSA bunu ölçmeden yapamaz (ENG-02 dersi) → alan null, kanal beyanı `partial` değil `unsupported`',
      subagentBlock:
        '🔴 KAYDIN ÇALIŞTIRMAYA KAPALI OLMASININ İKİNCİ SEBEBİ. Motor alt-ajan mimarisi TAŞIYOR (ikili şemasında `subagent_delegation_mode`, `agents.execution_capacity`, `max_child_steps`, `main_session_selection`; yardım metninde `--subagent-worktree-isolation` ve `muse session-message` — oturumlar arası mesajlaşma) ama SERT kapatma yolu ölçülmedi: ölçülen tek bayrak İZOLASYON, kapatma DEĞİL. CrewPane\'te alt-ajan ürün kuralıyla yasaktır (ADR-004: her iş görünür bir pane\'de) → ölçülmemiş blok, olmayan bir korumayı VAR sanmaktır. Bu alan null kaldığı sürece motora ENG-19 LİDER rolü de verilemez',
      trust:
        'çalışma dizini GÜVEN kapısı VAR gibi görünüyor (`--trust-workspace  Trust this workspace for this run (load its skills and rules); does not save trust` + `--yolo` içinde güven) ama ürünün beklediği şey bunun TERSİ: güvenilmeyen kökte motorun DURMASI. Kapının varsayılan davranışı (güvensiz kökte ne oluyor?) koşturulmadı → beyan edilemez',
      reset:
        'pane RESET slash komutu gerçek TUI oturumunda ölçülmedi (bu tur tamamen headless koştu; TUI ilk koşuda hesap duvarına çıkıyor) → var olmayan bir komut göndermek pane\'e sessizce metin yazardı',
      tui:
        'TUI hazır/blocker dizeleri GERÇEK pane\'de ölçülmedi (interaktif ilk koşu giriş/ödeme duvarına çıkıyor) → `paneReadiness` regex\'i YOK; motor açıldığında sabit boot bütçesiyle beklenir',
      mcp:
        'ARAÇ BAĞLAMA YÜZEYİ VAR ama GRAMERİ ÖLÇÜLMEDİ: ikilinin ayar şemasında `mcpServers`/`mcp_servers` anahtarı ve sunucu alanları (transport/command/env/framing/url/headers) okundu, ayrıca `settings.mcp_servers.<id>` yolu ve proje düzeyinde `.mcp.json` dizesi var (06-settings-keys.txt). Ama (a) ayar belgesinin DİSKTEKİ yolu, (b) pane BAŞINA ayrılabilir olup olmadığı (XDG_CONFIG_HOME/XDG_DATA_HOME ikilide geçiyor, ama muse ağacını GERÇEKTEN taşıdığı ölçülmedi), (c) sunucunun bağlandığının kanıtı — üçü de yok. Yanlış yere yazılan bir belge pane\'i ARAÇSIZ açar ve kimse sebebini bilmez (ENG-17 dersi)',
      hooks:
        'hook yüzeyi ikilinin şemasında VAR (`hooks`, `managed_hooks_path`, `managed_hooks_env_vars`, `max_consecutive_stop_hook_continuations`, `session_start`/`user_prompt_submit` olay adları) ama per-launch BAYRAK yok ve gerçek bir kanca koşturulmadı → ADP-692 tur-başı brifingi bu motorda argv ile KURULAMAZ',
      extraRoots:
        'ek çalışma kökü bayrağı YOK: ölçülen tam seçenek listesinde `--add-dir` dengi bulunmuyor; `--workspace <PATH>` TEK bir kök belirliyor (ek kök değil, kökün KENDİSİ) ve `-w/--worktree` git worktree açıyor — ikisi de "birden çok kök" anlamına gelmez',
      skillsDir:
        'skill YÜZEYİ zengin (`muse skills list|install|import --from claude|codex` — kaynak sınıfları user|project|built-in|plugin) ama keşif DİZİNİ ölçülmedi: kurulum ağacında `~/.local/share/muse/skills` oluştu, ancak ürünün skill\'lerini oraya yazması pane BAŞINA izolasyon gerektirir ve o env (madde: identityEnv) yok. Uydurma bir yol skill\'leri sessizce görünmez yapardı',
      identityEnv:
        '🔴 PANE BAŞINA HESAP/PROFİL AYRIMI ÖLÇÜLMEDİ: motorun ev dizinini taşıyan ÖZEL bir env (FACTORY_HOME_OVERRIDE / CODEX_HOME dengi) ikili dizelerinde BULUNAMADI. Ölçülen tek adaylar genel `XDG_CONFIG_HOME`/`XDG_DATA_HOME`; kimlik defterinin (`muse login` sonrası) GERÇEKTEN oraya taşındığı doğrulanmadı — doğrulanmadan iki pane\'e iki hesap verilemez ve verilmiş SAYILAMAZ',
      usage:
        'jeton/maliyet defteri ÖLÇÜLMEDİ: `--no-session-log` bayrağı ve `MUSE_SESSIONS`/`MUSE_CURRENT_SESSION_LOG` env adları defterin VARLIĞINI gösteriyor, `muse export` de tam bir oturum belgesi üretiyor (export_schema_version 1) — ama gerçek bir MODEL turu koşulmadığı için defterde jeton alanı olup olmadığı bilinmiyor. `echo` sağlayıcısı jeton harcamıyor → sayaç UYDURULAMAZ; kart "bilinmiyor" der',
    }),

    partial: Object.freeze({
      model:
        'bayrak ölçüldü (`--model <MODEL>`, kök + `exec`) ama MODEL ADLARI bilinmiyor: motorun model kataloğu hesap ister (`muse` model listesi komutu yok; katalog satırları `ConfigCatalogRow` ile SUNUCUDAN geliyor) → ürün seçici bu motorda serbest metin gösterir, liste GÖSTEREMEZ',
      effort:
        'enum ikilinin KENDİ yardım metninden alındı (8 değer + varsayılan `high`) ama hiçbir değer GERÇEK bir turda denenmedi (hesap duvarı) → geçersiz değerin turu nasıl öldürdüğü codex\'teki gibi ÖLÇÜLMÜŞ değil; beyaz liste yine de ZORUNLU (şema kuralı)',
      output:
        'akış TAM ölçüldü ama `--provider echo` ile: gerçek bir MODEL turunda ek olay tipleri (araç çağrısı, onay, jeton) çıkabilir. Ölçülen 13 satırın şekli (`schema_version`+`stream`+`sequence`+`record_type`+`payload_type`+`payload`) sağlayıcıdan bağımsız zarf olduğu için süpervizör ayrıştırıcısı bunun üstüne yazılabilir; kapanış olayı `run.terminal.completed` doğrulandı',
      install:
        'kurulum GERÇEKTEN yapıldı ve ürün kimliği `--version` ile kanıtlandı; ama iki takip kalemi var: (a) launcher kendini güncelleyebiliyor → ölçülen sürüm (1.0.3-R2198.1) sabitlenemez, (b) kurucu kabuk profil dosyalarına PATH satırı ekliyor (ürün için gereksiz; `MUSE_NO_MODIFY_PATH=1` ile kapatılabilir ama satıcının KENDİ komutunu göstermek doğru olan)',
      auth:
        'giriş/çıkış komutları ve anahtar önceliği motorun KENDİ yardım metninden ölçüldü, ama hiçbiri KOŞTURULMADI: `muse login` tarayıcı açıyor ve ödeme yöntemi olmayan hesapta duvara çıkıyor (ENGINE-MUSE-01 §1) → "Eren girişi bekliyor". Ürün bu yüzden akışı SÜRMÜYOR (`flow:"external"`), yalnız komutu ve adımları METİN olarak gösteriyor',
    }),

    verification: Object.freeze({
      contextScope: Object.freeze({ channel: 'unverified', source: 'TOKEN-BUDGET-01 — bu motorda belge-enjeksiyonunu kapatan bir bayrak ARANMADI/ÖLÇÜLMEDİ; kesim yalnız beyan eden motorda koşar' }),
      identity: Object.freeze({ channel: 'unverified', source: 'ENGINE-MUSE-02-evidence/01-muse-help.txt + 06-settings-keys.txt — taşıyıcı ADAYLARI (`--agents <JSON>`, settings.run.system_prompt) görüldü; ADDITIVE/REPLACE semantiği ÖLÇÜLEMEDİ (hesap duvarı) → alan null' }),
      model: Object.freeze({ channel: 'measured', source: 'ENGINE-MUSE-02-evidence/01-muse-help.txt + 02-muse-subcommand-help.txt — `--model <MODEL>  Model id for non-echo providers` (kök) ve `--model <ID>` (exec)' }),
      effort: Object.freeze({ channel: 'measured', source: 'ENGINE-MUSE-02-evidence/01-muse-help.txt — `--reasoning-effort <EFFORT>  Meta reasoning effort: none|minimal|low|medium|high|xhigh|max|ultra (default: high)`' }),
      images: Object.freeze({ channel: 'unverified', source: '`--image <PATH>` yardım metninde VAR ama tek bir görsel turu koşulmadı (01-muse-help.txt) → alan null' }),
      provider: Object.freeze({ channel: 'measured', source: 'ENGINE-MUSE-02-evidence/01-muse-help.txt — `--provider <MODE>  Startup provider: echo or meta (default: meta)`: ürünün BYOK grameriyle eşleşmiyor' }),
      session: Object.freeze({ channel: 'unverified', source: 'yüzey ölçüldü (`--session-id`, `muse resume --last|<uuid>`, JSONL `stream.id`) ama GERÇEK resume turu koşulmadı → alan null' }),
      subagentBlock: Object.freeze({ channel: 'unverified', source: '06-settings-keys.txt — `subagent_delegation_mode`/`agents.execution_capacity` VAR, SERT kapatma yolu koşturulmadı → alan null (ENG-19 lider kapısı kapalı)' }),
      trust: Object.freeze({ channel: 'unverified', source: '`--trust-workspace` bayrağı görüldü; güvensiz kökte motorun DURUP durmadığı ölçülmedi' }),
      reset: Object.freeze({ channel: 'unverified', source: 'TUI açılmadı (tur headless; interaktif ilk koşu hesap duvarına çıkıyor)' }),
      tui: Object.freeze({ channel: 'unverified', source: 'TUI açılmadı → paneReadiness sinyali ölçülmedi' }),
      mcp: Object.freeze({ channel: 'unverified', source: '06-settings-keys.txt — `settings.mcp_servers.<id>` + `mcpServers` + sunucu alanları (transport/command/env/framing/url/headers) okundu; belgenin YOLU ve pane-başına ayrılabilirliği ölçülmedi → alan null' }),
      hooks: Object.freeze({ channel: 'unverified', source: 'ikili şemasında `hooks`/`managed_hooks_path`/`session_start` var; per-launch bayrak yok, kanca koşturulmadı' }),
      extraRoots: Object.freeze({ channel: 'measured', source: 'ENGINE-MUSE-02-evidence/01-muse-help.txt — tam seçenek listesinde `--add-dir` dengi YOK; `--workspace <PATH>` TEK kök belirliyor' }),
      skillsDir: Object.freeze({ channel: 'unverified', source: '`muse skills --help` (02-…) kaynak sınıflarını veriyor; keşif DİZİNİ ve pane-başına yazılabilirlik ölçülmedi' }),
      identityEnv: Object.freeze({ channel: 'measured', source: 'ikili dizelerinde MUSE_* env envanteri tarandı: ev-dizini/config taşıyan ÖZEL env YOK (yalnız MUSE_SESSIONS/MUSE_CURRENT_SESSION_LOG/MUSE_MODEL + genel XDG_CONFIG_HOME/XDG_DATA_HOME); muse ağacının XDG ile GERÇEKTEN taşındığı doğrulanmadı → alan null' }),
      auth: Object.freeze({ channel: 'measured', source: 'ENGINE-MUSE-02-evidence/02-muse-subcommand-help.txt — `muse login` ("approve a code in your browser", "META_API_KEY always takes priority"), `muse logout`, `muse auth set --api-key-stdin` ("never taken as a command-line argument"); durum/whoami komutu komut listesinde YOK. Abonelik kanıtı: ENGINE-MUSE-01 §4 K1/K2 (resmî belge, kanal doc)' }),
      usage: Object.freeze({ channel: 'unverified', source: 'defterin VARLIĞI görüldü (`--no-session-log`, MUSE_SESSIONS, `muse export`) ama jeton alanı gerçek turda ölçülmedi → alan null' }),
      output: Object.freeze({ channel: 'measured', source: 'ENGINE-MUSE-02-evidence/05-echo-exec-json.jsonl — HESAPSIZ gerçek koşu (`muse exec --provider echo --json`), 13 satır JSONL; kapanış `run.terminal.completed` {terminal,text,reason}' }),
      install: Object.freeze({ channel: 'measured', source: 'resmî kurucu okundu (314 satır: MUSE_INSTALL_DIR/MUSE_NO_MODIFY_PATH, x-content-sha256 doğrulaması, `bash -n`) + İZOLE HOME\'da GERÇEKTEN kuruldu → `muse --version` = "Muse Code 1.0.3 (1.0.3-R2198.1)" (03-muse-version.txt, 04-muse-release-info.json)' }),
    }),
  }),


  // ─── JEV AI (AKILLI MODEL YÖNLENDİRİCİ & ORCHESTRATOR) ────────────────────
  jev: Object.freeze({
    id: 'jev',
    label: 'Jev AI (Orchestrator)',
    bin: 'jev',
    defaultArgs: Object.freeze([]),
    autonomy: Object.freeze({
      level: 'full',
      via: null,
      flags: Object.freeze([]),
      measured: 'Jev AI Akıllı Model Yönlendirici: Görevleri analiz ederek bağlı motorlar arasından en uygun AI modelini seçer',
      why: 'Maliyet tasarrufu, token optimizasyonu ve hız artışı sağlar'
    }),
    identity: null,
    model: Object.freeze({
      flag: '--model',
      default: 'auto',
      supported: Object.freeze(['auto', 'fast', 'smart', 'expert'])
    }),
    effort: null,
    images: null,
    provider: null,
    session: null,
    contextScope: null,
    subagentBlock: null,
    trust: null,
    reset: null,
    tui: null,
    mcp: null,
    hooks: null,
    extraRoots: null,
    skillsDir: null,
    identityEnv: null,
    auth: Object.freeze({
      label: 'Jev AI',
      accountHint: 'Jev AI Akıllı Model Yönlendirici — bağlı AI motorları arasından göreve göre en uygun modeli belirler',
      signupUrl: 'https://jev.ai/',
      flow: 'api-key',
      needsCode: false,
      loginArgv: null,
      logoutArgv: null,
      statusArgv: null,
      statusParse: null,
      statusNote: 'Jev AI akıllı model yönlendirme motoru olarak yapılandırılmıştır.',
      apiKey: Object.freeze({
        env: 'JEV_API_KEY',
        vaultService: 'jev',
        keyUrl: 'https://jev.ai/api-keys',
        keyLabel: 'Jev AI API anahtarı'
      })
    }),
    usage: null,
    output: null,
    install: null,
    unsupported: Object.freeze({
      identity: 'Jev AI bir model yönlendirici (orchestrator) motorudur; doğrudan pane çalıştırmaz, bağlı motorları yönlendirir.',
      effort: 'Jev AI bir model yönlendirici (orchestrator) motorudur; doğrudan pane çalıştırmaz, bağlı motorları yönlendirir.',
      images: 'Jev AI bir model yönlendirici (orchestrator) motorudur; doğrudan pane çalıştırmaz, bağlı motorları yönlendirir.',
      provider: 'Jev AI bir model yönlendirici (orchestrator) motorudur; doğrudan pane çalıştırmaz, bağlı motorları yönlendirir.',
      session: 'Jev AI bir model yönlendirici (orchestrator) motorudur; doğrudan pane çalıştırmaz, bağlı motorları yönlendirir.',
      subagentBlock: 'Jev AI bir model yönlendirici (orchestrator) motorudur; doğrudan pane çalıştırmaz, bağlı motorları yönlendirir.',
      contextScope: 'Jev AI bir model yönlendirici (orchestrator) motorudur; doğrudan pane çalıştırmaz, bağlı motorları yönlendirir.',
      trust: 'Jev AI bir model yönlendirici (orchestrator) motorudur; doğrudan pane çalıştırmaz, bağlı motorları yönlendirir.',
      reset: 'Jev AI bir model yönlendirici (orchestrator) motorudur; doğrudan pane çalıştırmaz, bağlı motorları yönlendirir.',
      tui: 'Jev AI bir model yönlendirici (orchestrator) motorudur; doğrudan pane çalıştırmaz, bağlı motorları yönlendirir.',
      mcp: 'Jev AI bir model yönlendirici (orchestrator) motorudur; doğrudan pane çalıştırmaz, bağlı motorları yönlendirir.',
      hooks: 'Jev AI bir model yönlendirici (orchestrator) motorudur; doğrudan pane çalıştırmaz, bağlı motorları yönlendirir.',
      extraRoots: 'Jev AI bir model yönlendirici (orchestrator) motorudur; doğrudan pane çalıştırmaz, bağlı motorları yönlendirir.',
      skillsDir: 'Jev AI bir model yönlendirici (orchestrator) motorudur; doğrudan pane çalıştırmaz, bağlı motorları yönlendirir.',
      identityEnv: 'Jev AI bir model yönlendirici (orchestrator) motorudur; doğrudan pane çalıştırmaz, bağlı motorları yönlendirir.',
      usage: 'Jev AI bir model yönlendirici (orchestrator) motorudur; doğrudan pane çalıştırmaz, bağlı motorları yönlendirir.',
      output: 'Jev AI bir model yönlendirici (orchestrator) motorudur; doğrudan pane çalıştırmaz, bağlı motorları yönlendirir.',
      install: 'Jev AI bir model yönlendirici (orchestrator) motorudur; doğrudan pane çalıştırmaz, bağlı motorları yönlendirir.'
    }),
    partial: Object.freeze({}),
    verification: Object.freeze({
      identity: { channel: 'source', source: 'Jev AI Akıllı Model Yönlendirici spesifikasyonu' },
      model: { channel: 'source', source: 'Jev AI Akıllı Model Yönlendirici spesifikasyonu' },
      effort: { channel: 'source', source: 'Jev AI Akıllı Model Yönlendirici spesifikasyonu' },
      images: { channel: 'source', source: 'Jev AI Akıllı Model Yönlendirici spesifikasyonu' },
      provider: { channel: 'source', source: 'Jev AI Akıllı Model Yönlendirici spesifikasyonu' },
      session: { channel: 'source', source: 'Jev AI Akıllı Model Yönlendirici spesifikasyonu' },
      subagentBlock: { channel: 'source', source: 'Jev AI Akıllı Model Yönlendirici spesifikasyonu' },
      contextScope: { channel: 'source', source: 'Jev AI Akıllı Model Yönlendirici spesifikasyonu' },
      trust: { channel: 'source', source: 'Jev AI Akıllı Model Yönlendirici spesifikasyonu' },
      reset: { channel: 'source', source: 'Jev AI Akıllı Model Yönlendirici spesifikasyonu' },
      tui: { channel: 'source', source: 'Jev AI Akıllı Model Yönlendirici spesifikasyonu' },
      mcp: { channel: 'source', source: 'Jev AI Akıllı Model Yönlendirici spesifikasyonu' },
      hooks: { channel: 'source', source: 'Jev AI Akıllı Model Yönlendirici spesifikasyonu' },
      extraRoots: { channel: 'source', source: 'Jev AI Akıllı Model Yönlendirici spesifikasyonu' },
      skillsDir: { channel: 'source', source: 'Jev AI Akıllı Model Yönlendirici spesifikasyonu' },
      identityEnv: { channel: 'source', source: 'Jev AI Akıllı Model Yönlendirici spesifikasyonu' },
      auth: { channel: 'source', source: 'Jev AI Akıllı Model Yönlendirici spesifikasyonu' },
      usage: { channel: 'source', source: 'Jev AI Akıllı Model Yönlendirici spesifikasyonu' },
      output: { channel: 'source', source: 'Jev AI Akıllı Model Yönlendirici spesifikasyonu' },
      install: { channel: 'source', source: 'Jev AI Akıllı Model Yönlendirici spesifikasyonu' }
    })
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// Okuma kapıları (saf)
//
// ENG-07 — okuma API'si bir FABRİKADAN üretilir (`createRegistry`). Sebep test
// değil MİMARİ: `agentRunner` artık motor adına göre dallanmıyor, DEFTERE bakıyor;
// "kayıtsız/eksik-yetenekli bir motor ne olur?" sorusunun ölçülebilmesi için
// defterin ENJEKTE EDİLEBİLİR olması gerekir (emsal: tokenUsage/modelDetect'in
// `opts.registry` dikişi). Modül seviyesindeki fonksiyonlar VARSAYILAN defterin
// bağlanmış hâlidir → dışa açık API bit-bit aynı kaldı.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verilen motor haritası üstünde okuma API'si üretir (saf; haritayı KOPYALAMAZ,
 * çağıranın donmuş nesnesine bakar).
 */
function createRegistry(engines) {
  const map = engines && typeof engines === 'object' ? engines : {};

  /** Kayıtlı motor kimlikleri (defter sırası). */
  const engineIds = () => Object.keys(map);

  /** Bu kimlik kayıtlı bir motor mu? */
  const isRegisteredEngine = (engineId) =>
    typeof engineId === 'string' && Object.prototype.hasOwnProperty.call(map, engineId);

  /** Kayıt (donmuş) — bilinmeyen motor → `null` (uydurma kayıt ÜRETİLMEZ). */
  const getEngine = (engineId) => (isRegisteredEngine(engineId) ? map[engineId] : null);

  /**
   * Bir yeteneğin bu motordaki değeri. Bilinmeyen motor/alan → `null`.
   * Çağıran `null`ı "yok" diye SESSİZCE geçmemeli: `unsupportedCapabilities()` ile
   * gerekçeyi alıp log'a/rozete düşürmeli (ENG-R3 §2.3 zorunlu kuralı).
   */
  const capability = (engineId, key) => {
    const d = getEngine(engineId);
    if (!d || !CAPABILITY_KEYS.includes(key)) return null;
    return d[key] === undefined ? null : d[key];
  };

  /**
   * ENG-07 L2 — TUI SİNYAL BEYANI. Dönen: `{ measured:true, signalsModule, composerHints,
   * blockers, measuredVersion }` ya da `null` (ölçülmemiş motor).
   *
   * ⚠️ REGEX'LERİN KENDİSİ BURADA TAŞINMAZ: tek kaynak `src/app/lib/paneReadiness.ts`
   * (kopya = ikinci gerçek = sapma; ENG-04 başlığındaki kural + ENG-R3 §14-R5'in claude
   * 2.1.220 vakası). Burada yaşayan şey KARARI belirleyen veridir: ölçülmüş sinyal var mı?
   * `null` → çağıran (engineReadyRunner) sabit boot BÜTÇE TAVANIYLA devam eder — bugünkü
   * davranış aynen; fark, "sinyal yok" bilgisinin artık BEYAN olması, varsayım olmaması.
   */
  const tuiSignals = (engineId) => {
    const d = capability(engineId, 'tui');
    if (!d) return null;
    return {
      measured: true,
      signalsModule: d.signalsModule || null,
      composerHints: d.composerHints === true,
      blockers: Array.isArray(d.blockers) ? [...d.blockers] : [],
      measuredVersion: d.measuredVersion || null,
    };
  };

  const unsupportedCapabilities = (engineId) => unsupportedCapabilitiesIn(getEngine(engineId), engineId);
  const unsupportedSummary = (engineId) => summarizeUnsupported(unsupportedCapabilities(engineId));

  /**
   * ENG-20 — "bu pane onay sorar mı?" TEK okuma ucu.
   *
   * KAYITSIZ motor → `{ level:'unknown' }`: tanımadığımız bir motor sessizce
   * tam-otomatik SAYILAMAZ (unsupportedCapabilities'teki aynı ihtiyat).
   */
  const engineAutonomy = (engineId) => {
    const d = getEngine(engineId);
    const a = d && d.autonomy;
    if (!a) return Object.freeze({ level: 'unknown', via: null, flags: Object.freeze([]), measured: null, why: null });
    return Object.freeze({
      level: a.level,
      via: a.via ?? null,
      flags: Object.freeze([...(a.flags || [])]),
      measured: a.measured || null,
      why: a.why || null,
    });
  };

  return {
    ENGINE_REGISTRY: map,
    engineIds,
    isRegisteredEngine,
    getEngine,
    capability,
    tuiSignals,
    engineAutonomy,
    unsupportedCapabilities,
    unsupportedSummary,
    validateRegistry: () => validateRegistry(map),
  };
}

/**
 * ENG-04/5 — bir pane'in YAPAMAYACAKLARI (ENG-10 rozet girdisi).
 *
 * Dönen: `[{ capability, state, reason, severity }]`
 *   • `state`: 'missing' (yetenek `null`) | 'partial' (var ama sınırlı)
 *   • `severity`: 'security' (SECURITY_CRITICAL_CAPABILITIES) | 'info'
 *
 * KAYITSIZ motor → HER yetenek 'missing' + "kayıt yok" gerekçesi. Bu bilinçli:
 * tanımadığımız bir motor sessizce tam-yetenekli sayılamaz (ENG-R3 §14-R1).
 * Sıralama deterministik (CAPABILITY_KEYS sırası) — rozet/log kararlı kalsın.
 */
function unsupportedCapabilitiesIn(d, engineId) {
  const out = [];
  if (!d) {
    const id = typeof engineId === 'string' && engineId.trim() ? engineId.trim() : '(boş)';
    for (const key of CAPABILITY_KEYS) {
      out.push({
        capability: key,
        state: 'missing',
        reason: `motor kayıtlı değil (engineRegistry'de '${id}' yok) → yetenek BEYAN EDİLMEMİŞ sayılır`,
        severity: SECURITY_CRITICAL_CAPABILITIES.includes(key) ? 'security' : 'info',
      });
    }
    return out;
  }
  for (const key of CAPABILITY_KEYS) {
    const severity = SECURITY_CRITICAL_CAPABILITIES.includes(key) ? 'security' : 'info';
    if (d[key] === null || d[key] === undefined) {
      out.push({
        capability: key,
        state: 'missing',
        reason: (d.unsupported && d.unsupported[key]) || 'gerekçe beyan edilmemiş',
        severity,
      });
    } else if (d.partial && d.partial[key]) {
      out.push({ capability: key, state: 'partial', reason: d.partial[key], severity });
    }
  }
  return out;
}

/** Tek satırlık özet (log/rozet ipucu). Eksik yoksa boş dize. */
function summarizeUnsupported(items) {
  if (!items.length) return '';
  const missing = items.filter((i) => i.state === 'missing').map((i) => i.capability);
  const partial = items.filter((i) => i.state === 'partial').map((i) => i.capability);
  const parts = [];
  if (missing.length) parts.push(`yok: ${missing.join(', ')}`);
  if (partial.length) parts.push(`kısmi: ${partial.join(', ')}`);
  return parts.join(' · ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Şema doğrulama (test + ileride açılış kapısı)
// ─────────────────────────────────────────────────────────────────────────────

function isNonEmptyString(v, min = 1) {
  return typeof v === 'string' && v.trim().length >= min;
}

/**
 * Bir kaydı şemaya karşı doğrular. Dönen: `{ ok, errors: string[] }`.
 * Kurallar (hepsi makine-denetimli — yorum satırına GÜVENİLMEZ):
 *   1. Zorunlu kimlik alanları dolu, `id` anahtarla aynı.
 *   2. Her yetenek alanı TANIMLI (değeri `null` olabilir ama alan atlanamaz).
 *   3. `null` yetenek → `unsupported[<alan>]` gerekçesi ZORUNLU (>=20 karakter).
 *   4. Dolu yetenek → `unsupported`ta OLAMAZ (çelişki).
 *   5. `partial[<alan>]` yalnız DOLU bir yetenek için verilebilir (>=20 karakter).
 *   6. Her yetenek için `verification` kanalı ZORUNLU; dolu yetenekte 'unverified' YASAK.
 *   7. Üç kapının değerleri enum içinde (`identity.kind`, `mcp.kind`, `output.kind`).
 */
function validateDescriptor(descriptor, expectedId) {
  const errors = [];
  const d = descriptor;
  if (!d || typeof d !== 'object') return { ok: false, errors: ['descriptor bir nesne değil'] };

  for (const key of REQUIRED_KEYS) {
    if (key === 'defaultArgs') {
      if (!Array.isArray(d.defaultArgs) || d.defaultArgs.some((a) => typeof a !== 'string')) {
        errors.push('defaultArgs: string dizisi olmalı');
      }
    } else if (!isNonEmptyString(d[key])) {
      errors.push(`${key}: boş olamaz`);
    }
  }
  if (expectedId && d.id !== expectedId) errors.push(`id ('${d.id}') defter anahtarıyla ('${expectedId}') aynı değil`);

  const unsupported = d.unsupported && typeof d.unsupported === 'object' ? d.unsupported : {};
  const partial = d.partial && typeof d.partial === 'object' ? d.partial : {};
  const verification = d.verification && typeof d.verification === 'object' ? d.verification : {};

  for (const key of CAPABILITY_KEYS) {
    const has = Object.prototype.hasOwnProperty.call(d, key);
    if (!has) {
      errors.push(`${key}: yetenek alanı ATLANMIŞ — sessiz boşluk yasak (yoksa açıkça null yaz)`);
      continue;
    }
    const value = d[key];
    const declared = isNonEmptyString(unsupported[key], 20);
    if (value === null || value === undefined) {
      if (!declared) errors.push(`${key}: null yetenek — unsupported['${key}'] gerekçesi ZORUNLU (>=20 karakter)`);
    } else if (unsupported[key] !== undefined) {
      errors.push(`${key}: hem DOLU hem unsupported — çelişki`);
    }
    if (partial[key] !== undefined) {
      if (value === null || value === undefined) errors.push(`${key}: null yetenek 'partial' olamaz (unsupported kullan)`);
      if (!isNonEmptyString(partial[key], 20)) errors.push(`${key}: partial gerekçesi >=20 karakter olmalı`);
    }
    const v = verification[key];
    if (!v || typeof v !== 'object') {
      errors.push(`${key}: verification kanalı beyan EDİLMEMİŞ`);
    } else {
      if (!VERIFICATION_CHANNELS.includes(v.channel)) {
        errors.push(`${key}: verification.channel geçersiz ('${v.channel}')`);
      } else if (v.channel === 'unverified' && value !== null && value !== undefined) {
        errors.push(`${key}: DOLU bir yetenek 'unverified' olamaz — ölç ya da null'a düşür`);
      }
      if (!isNonEmptyString(v.source, 5)) errors.push(`${key}: verification.source (dosya:satır / ölçüm) zorunlu`);
    }
  }

  // ENG-20 — OTONOMİ BEYANI + ARGV EŞLEŞMESİ (yorum yalan söyleyebilir, bu kapı söyleyemez).
  //   1. Alan ZORUNLU (atlanamaz — yeni motor otonomisini SÖYLEMEDEN defterlenemez).
  //   2. `level` enum içinde, `via` enum içinde.
  //   3. `flags` ⊆ `defaultArgs` — beyan edilen bayrak GERÇEKTEN argv'ye gidiyor mu?
  //      (codex'in ENG-20 öncesi hâli tam burada düşerdi: level 'full' + boş defaultArgs.)
  //   4. `level:'full'` → `measured` ZORUNLU (>=20 karakter). Ölçmediysen 'unknown' yaz.
  //   5. `level!=='full'` → `why` ZORUNLU: paritenin ALTINDA kalmak bir KARAR'dır, kaza değil.
  //   6. `via:'argv'` → `flags` boş OLAMAZ (çelişki: argv'den geliyor ama bayrak yok).
  const autonomy = d.autonomy;
  if (!autonomy || typeof autonomy !== 'object') {
    errors.push('autonomy: beyan ZORUNLU — pane onay sorar mı sorusu sessiz kalamaz (ENG-20)');
  } else {
    if (!AUTONOMY_LEVELS.includes(autonomy.level)) {
      errors.push(`autonomy.level geçersiz ('${autonomy.level}') — ${AUTONOMY_LEVELS.join('|')}`);
    }
    if (!AUTONOMY_CHANNELS.includes(autonomy.via === undefined ? null : autonomy.via)) {
      errors.push(`autonomy.via geçersiz ('${autonomy.via}') — argv|env|config|null`);
    }
    if (!Array.isArray(autonomy.flags) || autonomy.flags.some((f) => typeof f !== 'string')) {
      errors.push('autonomy.flags: string dizisi olmalı (boş olabilir)');
    } else if (Array.isArray(d.defaultArgs)) {
      const missing = autonomy.flags.filter((f) => !d.defaultArgs.includes(f));
      if (missing.length) {
        errors.push(
          `autonomy.flags ⊄ defaultArgs — beyan edilen bayrak argv'ye GİTMİYOR: ${missing.join(', ')}`,
        );
      }
    }
    if (autonomy.level === 'full' && !isNonEmptyString(autonomy.measured, 20)) {
      errors.push('autonomy.measured: level "full" ÖLÇÜM ister (>=20 karakter) — ölçmediysen "unknown" yaz');
    }
    if (autonomy.level !== 'full' && !isNonEmptyString(autonomy.why, 20)) {
      errors.push('autonomy.why: claude paritesinin ALTINDA kalmak bir KARAR\'dır, gerekçesi ZORUNLU (>=20 karakter)');
    }
    if (autonomy.via === 'argv' && Array.isArray(autonomy.flags) && autonomy.flags.length === 0) {
      errors.push('autonomy: via="argv" ama flags BOŞ — çelişki');
    }
  }

  // Bilinmeyen unsupported/partial anahtarı = yazım hatası; sessiz geçemez.
  for (const key of Object.keys(unsupported)) {
    if (!CAPABILITY_KEYS.includes(key)) errors.push(`unsupported['${key}']: böyle bir yetenek alanı yok`);
  }
  for (const key of Object.keys(partial)) {
    if (!CAPABILITY_KEYS.includes(key)) errors.push(`partial['${key}']: böyle bir yetenek alanı yok`);
  }

  // Üç kapı (ENG-R2 §9-2).
  // CDX-F1 — EFOR KAPISI. Bir efor taşıyıcısı beyan edildiyse UYGULANABİLİR olmalı:
  //   1. `kind` enum içinde ('flag' | 'cli-override').
  //   2. `flag` dolu (argv'ye basılacak şey).
  //   3. `kind:'cli-override'` → `key` ZORUNLU (`-c <key>="<değer>"` grameri).
  //   4. `values` BOŞ OLMAYAN string dizisi. Bu bir konfor değil GÜVENLİK/DAYANIKLILIK
  //      kuralı: ÖLÇÜLDÜ (codex 0.147) — motor değeri doğrulamaz, olduğu gibi API'ye
  //      yollar ve geçersiz bir değer turu ERROR ile öldürür. Beyaz liste YOKSA
  //      `withEffort` neyi düşüreceğini bilemez.
  if (d.effort) {
    const e = d.effort;
    if (!EFFORT_KINDS.includes(e.kind)) {
      errors.push(`effort.kind geçersiz ('${e.kind}') — ${EFFORT_KINDS.join('|')}`);
    }
    if (!isNonEmptyString(e.flag)) errors.push('effort.flag: argv\'ye basılacak bayrak zorunlu');
    if (e.kind === 'cli-override' && !isNonEmptyString(e.key)) {
      errors.push('effort.key: `cli-override` taşıyıcısında ezilecek config anahtarı zorunlu');
    }
    if (!Array.isArray(e.values) || !e.values.length || e.values.some((v) => !isNonEmptyString(v))) {
      errors.push('effort.values: boş olmayan string dizisi zorunlu — beyaz liste olmadan kusurlu değer pane\'i öldürür');
    }
  }

  if (d.identity && !IDENTITY_KINDS.includes(d.identity.kind)) {
    errors.push(`identity.kind geçersiz ('${d.identity.kind}') — ${IDENTITY_KINDS.join('|')}`);
  }
  // ENG-14 — REPLACE taşıyıcısı REÇETESİZ olamaz (yukarıdaki BASE_PROMPT_KINDS gerekçesi).
  if (d.identity && d.identity.replacesSystemPrompt === true) {
    const bp = d.identity.basePrompt;
    if (!bp || typeof bp !== 'object') {
      errors.push(
        'identity.basePrompt: `replacesSystemPrompt:true` bir taşıyıcı gömülü sistem prompt\'unu SİLER — ' +
          'geri kazanma reçetesi ZORUNLU (sessiz yetenek kaybı yasağı, ENG-14)',
      );
    } else {
      if (!BASE_PROMPT_KINDS.includes(bp.kind)) {
        errors.push(`identity.basePrompt.kind geçersiz ('${bp.kind}') — ${BASE_PROMPT_KINDS.join('|')}`);
      }
      if (!BASE_PROMPT_FAILURE_MODES.includes(bp.onFailure)) {
        errors.push(
          `identity.basePrompt.onFailure geçersiz ('${bp.onFailure}') — ${BASE_PROMPT_FAILURE_MODES.join('|')}; ` +
            'reçete düşerse kimlik YAZILMAZ (fail-closed), sessizce REPLACE yapılmaz',
        );
      }
      if (bp.kind === 'self-dump') {
        if (!isNonEmptyString(bp.dumpEnv)) errors.push('identity.basePrompt.dumpEnv: dökümü tetikleyen env adı zorunlu');
        if (!isNonEmptyString(bp.readEnv)) errors.push('identity.basePrompt.readEnv: sentinel enjeksiyonu için okuma env adı zorunlu');
        if (!Array.isArray(bp.probeArgv) || !bp.probeArgv.length) {
          errors.push('identity.basePrompt.probeArgv: dökümü üreten argv zorunlu');
        }
      }
      // ENG-17 — `ledger-dump`: döküm bir ENV ile TETİKLENMEZ, motorun KENDİ oturum
      // defterinden OKUNUR. O yüzden ev dizini env'i (defterin NEREDE olduğu),
      // defter deseni, okunacak KAYIT TİPİ ve ALAN adı zorunludur: dördünden biri
      // eksikse okuyucu "taban bulunamadı"ya düşer ve `onFailure` sessizce her
      // koşuda tetiklenir — yani kimlik hiç yazılmaz ve kimse sebebini bilmez.
      if (bp.kind === 'ledger-dump') {
        if (!isNonEmptyString(bp.homeEnv)) errors.push('identity.basePrompt.homeEnv: defterin yaşadığı ev dizini env adı zorunlu');
        if (!isNonEmptyString(bp.ledgerGlob)) errors.push('identity.basePrompt.ledgerGlob: defter dosyası deseni zorunlu');
        if (!isNonEmptyString(bp.recordType)) errors.push('identity.basePrompt.recordType: taban prompt\'u taşıyan kayıt tipi zorunlu');
        if (!isNonEmptyString(bp.field)) errors.push('identity.basePrompt.field: taban prompt\'un okunacağı alan adı zorunlu');
        if (!Array.isArray(bp.probeArgv) || !bp.probeArgv.length) {
          errors.push('identity.basePrompt.probeArgv: dökümü üreten argv zorunlu');
        }
      }
    }
  }
  // `replacesSystemPrompt` beyanı OLMAYAN bir env-file taşıyıcısı, sessizce REPLACE
  // yapan bir motorda felaket olurdu → alan her `env-file` kaydında AÇIKÇA yazılmalı.
  //
  // 🔴 ENG-17 — KAPI `flag` TAŞIYICILARINA DA AÇILDI. Eskiden örtük varsayım şuydu:
  // "bayrak taşıyıcısı EKLER, yalnız env taşıyıcısı SİLEBİLİR" (adı `--append-…`
  // olanlara bakarak). Kimi bunu ÇÜRÜTTÜ: `--agent-file <md>` bir BAYRAKtır ve
  // motorun gömülü prompt'unu SİLİYOR (ölçüm: motorun kendi defterinde
  // profile.bind.systemPrompt 20.910 → 93 karakter). Varsayım ölçülene kadar
  // bayrak taşıyıcısı da "ölçmedik ama iyimseriz" bırakılamaz.
  if (d.identity && (d.identity.kind === 'env-file' || d.identity.kind === 'flag' || d.identity.kind === 'flag-dir')
      && typeof d.identity.replacesSystemPrompt !== 'boolean') {
    errors.push(
      'identity.replacesSystemPrompt: `env-file`/`flag` taşıyıcısı EKLİYOR mu YERİNE Mİ geçiyor — ' +
        'ölçülüp AÇIKÇA (true/false) yazılmalı; boş bırakmak "ölçmedik ama iyimseriz" demektir',
    );
  }
  // ENG-16 — `env-file` taşıyıcısının ENV DEĞERİ NE? Beyan edilmezse 'dir' varsayılır
  // (copilot'un bugünkü hâli); beyan edilirse enum içinde olmak ZORUNDA. 'json-config'
  // ek olarak belgenin ŞEKLİNİ de ister: kimlik yolunun YAZILACAĞI alan (`configPath`)
  // ve belgenin TABANI (`configBase`). İkisi olmadan yazıcı, motorun config'ini
  // sessizce BOŞ bir belgeyle ezerdi (araçlar + otonomi + izolasyon o belgede yaşıyor).
  if (d.identity && d.identity.kind === 'env-file' && d.identity.envTarget !== undefined) {
    if (!IDENTITY_ENV_TARGETS.includes(d.identity.envTarget)) {
      errors.push(`identity.envTarget geçersiz ('${d.identity.envTarget}') — ${IDENTITY_ENV_TARGETS.join('|')}`);
    } else if (d.identity.envTarget === 'json-config' || d.identity.envTarget === 'json-config-dir') {
      if (!isNonEmptyString(d.identity.configPath)) {
        errors.push("identity.configPath: kimlik YOLUNUN yazılacağı belge alanı beyan edilmeli (ör. 'instructions[]')");
      }
      if (!d.identity.configBase || typeof d.identity.configBase !== 'object') {
        errors.push("identity.configBase: belgenin TABANI zorunlu — boş belge motorun kendi config'ini EZER");
      }
      // ENG-17 — DİZİN yolunda belgenin ADI da beyan edilmeli: env yalnız dizini
      // söyler, dosya adını motor DAYATIR (crush: `<dir>/crush.json`). Ad yanlışsa
      // motor belgeyi HİÇ okumaz ve kimlik/araç/blok sessizce düşer (ölçüldü:
      // env'e dosya yolu verilince motor "…/pane-config.json/crush.json" aradı).
      if (d.identity.envTarget === 'json-config-dir' && !isNonEmptyString(d.identity.configFileName)) {
        errors.push("identity.configFileName: 'json-config-dir' belgenin SABİT dosya adını beyan etmeli (env yalnız DİZİNİ taşır)");
      }
    }
  }

  // ENG-16 — PANE İZOLASYONU (opsiyonel alan; VARSA tam beyanlı olmak zorunda).
  // Ölçülmüş bir çakışma olmadan bu alan yazılmaz; yazıldıysa hangi env'in pane
  // başına ayrıldığı + ÖLÇÜM cümlesi zorunludur (uydurma izolasyon = sahte güven).
  if (d.isolation !== undefined && d.isolation !== null) {
    const iso = d.isolation;
    if (!iso || typeof iso !== 'object') {
      errors.push('isolation: nesne olmalı (ya da hiç yazılmamalı)');
    } else {
      if (!ISOLATION_KINDS.includes(iso.kind)) {
        errors.push(`isolation.kind geçersiz ('${iso.kind}') — ${ISOLATION_KINDS.join('|')}`);
      }
      if (!isNonEmptyString(iso.env)) errors.push('isolation.env: pane başına ayrılacak env değişkeninin adı zorunlu');
      if (!isNonEmptyString(iso.fileName)) errors.push('isolation.fileName: pane başına üretilecek dosya/dizin adı zorunlu');
      if (!isNonEmptyString(iso.measured, 20)) {
        errors.push('isolation.measured: ÇAKIŞMANIN ölçümü zorunlu (>=20 karakter) — ölçülmemiş izolasyon sahte güvendir');
      }
    }
  }

  // ENG-16 — ALT-AJAN BLOĞU ARGV'DE DEĞİLSE NEREDE? Bir kayıt `subagentBlock` beyan
  // edip `args`ı BOŞ bırakabilir (opencode: blok kimlik config belgesinde, argv'de
  // bayrak yok). O zaman TAŞIYICI ve ÖLÇÜM zorunludur — yoksa `subagentBlockArgs`
  // sessizce [] döndürür ve ADR-004'ün SERT katmanı VAR sanılırken YOK olur.
  if (d.subagentBlock && Array.isArray(d.subagentBlock.args) && d.subagentBlock.args.length === 0) {
    if (!isNonEmptyString(d.subagentBlock.via)) {
      errors.push('subagentBlock.via: argv bayrağı YOKKEN bloğun TAŞIYICISI beyan edilmeli (boş `args` sessizce "blok yok" demektir)');
    }
    if (!isNonEmptyString(d.subagentBlock.measured, 20)) {
      errors.push('subagentBlock.measured: argv-dışı blok ÖLÇÜLMÜŞ olmalı (>=20 karakter) — ölçülmemiş blok, olmayan bir korumayı VAR sanmaktır');
    }
  }

  if (d.mcp && !MCP_KINDS.includes(d.mcp.kind)) {
    errors.push(`mcp.kind geçersiz ('${d.mcp.kind}') — ${MCP_KINDS.join('|')}`);
  }
  // ENG-OPENCODE-PROVIDER-01 — MODEL ÖN-DOĞRULAMA KAPISI (opsiyonel; VARSA tam beyanlı).
  // Kapı motor adına değil bu beyana bağlıdır (opencodeModelGate.cjs): liste komutu,
  // zaman aşımı ve ÖLÇÜM cümlesi olmadan yazılamaz — ölçülmemiş kapı, olmayan bir
  // korumayı VAR sanmaktır (§6-B: sessiz bulut düşüşü).
  if (d.modelGate !== undefined && d.modelGate !== null) {
    const g = d.modelGate;
    if (!g || typeof g !== 'object') {
      errors.push('modelGate: nesne olmalı (ya da hiç yazılmamalı)');
    } else {
      if (!Array.isArray(g.listArgs) || !g.listArgs.length || g.listArgs.some((a) => typeof a !== 'string')) {
        errors.push('modelGate.listArgs: model listesini basan alt komut (string dizisi) zorunlu');
      }
      if (g.configArgs !== undefined && g.configArgs !== null && (!Array.isArray(g.configArgs) || g.configArgs.some((a) => typeof a !== 'string'))) {
        errors.push('modelGate.configArgs: string dizisi olmalı (ya da hiç yazılmamalı)');
      }
      for (const k of ['timeoutMs', 'cacheMs', 'probeTimeoutMs']) {
        if (typeof g[k] !== 'number' || !(g[k] > 0)) errors.push(`modelGate.${k}: pozitif sayı zorunlu`);
      }
      if (!isNonEmptyString(g.measured, 20)) {
        errors.push('modelGate.measured: kapının kapattığı arıza ÖLÇÜLMÜŞ olmalı (>=20 karakter, kanıt dosyası adıyla)');
      }
      if (g.lanHttpAckSetting !== undefined && g.lanHttpAckSetting !== null && !isNonEmptyString(g.lanHttpAckSetting)) {
        errors.push('modelGate.lanHttpAckSetting: onay bayrağını taşıyan ayar anahtarı (dotted) — boş olamaz');
      }
    }
    // Kapı `provider/model` kabul eden bir değer biçimi olmadan anlamsızdır: model
    // sanitizer'da düşerse `--model` hiç basılmaz ve kapı BOŞ modele bakar.
    if (!d.model || typeof d.model.valuePattern !== 'string' || !d.model.valuePattern.trim()) {
      errors.push('modelGate: `model.valuePattern` beyanı zorunlu — sanitizer `provider/model` biçimini düşürürse kapı hiç koşmaz');
    }
  }
  if (d.model && d.model.valuePattern !== undefined) {
    try {
      new RegExp(d.model.valuePattern); // eslint-disable-line no-new
    } catch {
      errors.push('model.valuePattern: geçerli bir RegExp kaynağı olmalı');
    }
  }
  // ENG-17 — 'env-config-dir': env DİZİNİ + SABİT dosya adı + server bloğunun yolu.
  // Üçü de olmadan yazıcı belgeyi motorun OKUMAYACAĞI bir yere/şekle yazar ve
  // "araç bağlandı" sanılırken pane ARAÇSIZ açılır (sessiz yetenek kaybı).
  // AGY-01 — 'workspace-plugin': demetin YOLU, ADI, sunucu haritasının alanı ve kökü
  // motora veren BAYRAK. Dördü de olmadan yazıcı demeti motorun OKUMAYACAĞI bir
  // yere/şekle yazar ve "araç bağlandı" sanılırken pane ARAÇSIZ açılır — bu motorda
  // hata bile vermez (keşif sessizdir), yani sessiz yetenek kaybının tam tanımı.
  if (d.mcp && d.mcp.kind === 'workspace-plugin') {
    if (!isNonEmptyString(d.mcp.pluginPath)) errors.push("mcp.pluginPath: 'workspace-plugin' demet dizininin motorun DAYATTIĞI yolunu beyan etmeli");
    if (!isNonEmptyString(d.mcp.pluginName)) errors.push("mcp.pluginName: 'workspace-plugin' demet ADINI beyan etmeli");
    if (!isNonEmptyString(d.mcp.field)) errors.push("mcp.field: sunucu haritasının yazılacağı belge alanı zorunlu");
    if (!isNonEmptyString(d.mcp.rootFlag)) errors.push("mcp.rootFlag: kökü motora veren bayrak zorunlu (yoksa demet YAZILIR ama motora GÖSTERİLMEZ)");
  }
  if (d.mcp && d.mcp.kind === 'env-config-dir') {
    if (!isNonEmptyString(d.mcp.env)) errors.push("mcp.env: 'env-config-dir' config DİZİNİNİ taşıyan env adını beyan etmeli");
    if (!isNonEmptyString(d.mcp.configFileName)) errors.push("mcp.configFileName: 'env-config-dir' motorun DAYATTIĞI dosya adını beyan etmeli");
    if (!isNonEmptyString(d.mcp.configPath)) errors.push("mcp.configPath: sunucu kayıtlarının yazılacağı belge alanı zorunlu");
  }
  if (d.output && !OUTPUT_KINDS.includes(d.output.kind)) {
    errors.push(`output.kind geçersiz ('${d.output.kind}') — ${OUTPUT_KINDS.join('|')}`);
  }
  // C4 — headless hijyen alanları OPSİYONEL; VARSA şekilli: env dize→dize, args dize
  // dizisi, stdin kapalı küme. Uydurma tip sessizce geçerse gelecek okuyucu `spawn`a
  // sayı/iç içe nesne verir ve motor ya hiç başlamaz ya da hijyen sessizce düşer.
  if (d.output) {
    const o = d.output;
    if (o.stdin !== undefined && !OUTPUT_STDIN_MODES.includes(o.stdin)) {
      errors.push(`output.stdin geçersiz ('${o.stdin}') — ${OUTPUT_STDIN_MODES.join('|')}`);
    }
    if (o.headlessEnv !== undefined) {
      if (!o.headlessEnv || typeof o.headlessEnv !== 'object' || Array.isArray(o.headlessEnv)) {
        errors.push('output.headlessEnv: nesne olmalı (env adı → dize değer)');
      } else {
        for (const [k, v] of Object.entries(o.headlessEnv)) {
          if (!isNonEmptyString(k) || typeof v !== 'string') errors.push(`output.headlessEnv.${k}: değer DİZE olmalı (env dize taşır)`);
        }
      }
    }
    if (o.headlessArgs !== undefined && (!Array.isArray(o.headlessArgs) || o.headlessArgs.some((a) => !isNonEmptyString(a)))) {
      errors.push('output.headlessArgs: boş olmayan dize DİZİSİ olmalı');
    }
  }

  // ENG-09 — 4. KAPI: kullanım adaptörü. `kind`/`level` beyan edilmemişse kart
  // hangi güven seviyesini yazacağını BİLEMEZ → sessizce "kesin" gibi görünür.
  if (d.usage) {
    if (!USAGE_KINDS.includes(d.usage.kind)) {
      errors.push(`usage.kind geçersiz ('${d.usage.kind}') — ${USAGE_KINDS.join('|')}`);
    }
    if (!USAGE_LEVELS.includes(d.usage.level)) {
      errors.push(`usage.level geçersiz ('${d.usage.level}') — ${USAGE_LEVELS.join('|')}`);
    }
    // Defter okuyan iki sınıf bir AYRIŞTIRICI adı beyan etmek zorunda: adı olmayan
    // defter tokenUsage'da sessizce "ölçülemedi"ye düşerdi (ve sebebi görünmezdi).
    if (
      (d.usage.kind === 'session-ledger' || d.usage.kind === 'time-window' || d.usage.kind === 'run-envelope') &&
      !isNonEmptyString(d.usage.reader)
    ) {
      errors.push(`usage.reader: '${d.usage.kind}' bir satır ayrıştırıcı adı beyan etmeli`);
    }
    // AGY-04 — `run-envelope`ın zarfı BİR KOŞUNUN ÇIKTISIDIR: onu üretmek MODEL
    // TURU harcar. Bir rapor komutu beyan etmek, jeton ölçmek için jeton yakan bir
    // yol açardı — sınıfın tanımı gereği YASAK.
    if (d.usage.kind === 'run-envelope' && d.usage.report) {
      errors.push("usage.report: 'run-envelope' ayrı bir rapor komutu ÇALIŞTIRMAZ (zarf koşunun kendisinden gelir)");
    }
    // ENG-14 — defter beyan eden kayıt İÇERİĞİNİ de söylemeli: 'jsonl' biçimi tek
    // başına "okunabilir transcript" DEMEK DEĞİLDİR (qwen ölçümü).
    if (d.usage.kind !== 'none' && !USAGE_CONTENTS.includes(d.usage.content)) {
      errors.push(
        `usage.content geçersiz ('${d.usage.content}') — ${USAGE_CONTENTS.join('|')}; ` +
          'satırlar MESAJ mı SAYAÇ mı, ölçülüp yazılmalı (teslim doğrulaması buna bakar)',
      );
    }
    if (d.usage.kind === 'cli-report' && !(d.usage.report && Array.isArray(d.usage.report.argv))) {
      errors.push("usage.report.argv: 'cli-report' motorun kendi komutunu beyan etmeli");
    }
    // ENG-16 — SATICI-BARINDIRILAN BEDAVA KAPI (4. fatura değeri). Beyan edilirse
    // kullanıcıya GÖSTERİLECEK cümle + TESPİT kuralı + politika ZORUNLUdur: "kodun
    // üçüncü tarafın sunucusuna gidiyor" bilgisini eksik/yumuşak yazmak, ürünün
    // BYOK sözünü sessizce bozmaktır.
    const vh = d.usage.billing && d.usage.billing.vendorHosted;
    if (vh !== undefined && vh !== null) {
      if (!vh || typeof vh !== 'object') {
        errors.push('usage.billing.vendorHosted: nesne olmalı (ya da hiç yazılmamalı)');
      } else {
        if (!VENDOR_HOSTED_DETECTORS.includes(vh.detect)) {
          errors.push(`usage.billing.vendorHosted.detect geçersiz ('${vh.detect}') — ${VENDOR_HOSTED_DETECTORS.join('|')}`);
        }
        if (vh.detect === 'credentials-file' && !isNonEmptyString(vh.credentialsFile)) {
          errors.push('usage.billing.vendorHosted.credentialsFile: kimlik defterinin yolu zorunlu (var/yok ÖLÇÜLÜR, tahmin edilmez)');
        }
        if (!isNonEmptyString(vh.vendorLabel)) errors.push('usage.billing.vendorHosted.vendorLabel: satıcının adı zorunlu');
        if (!isNonEmptyString(vh.disclosure, 60)) {
          errors.push(
            'usage.billing.vendorHosted.disclosure: kullanıcıya gösterilecek AÇIK cümle zorunlu (>=60 karakter) — ' +
              'kodun NEREYE gittiği yazılmadan bu kapı ürüne giremez',
          );
        }
        if (!VENDOR_GATE_POLICIES.includes(vh.defaultPolicy)) {
          errors.push(`usage.billing.vendorHosted.defaultPolicy geçersiz ('${vh.defaultPolicy}') — ${VENDOR_GATE_POLICIES.join('|')}`);
        }
        if (!isNonEmptyString(vh.policySetting)) {
          errors.push('usage.billing.vendorHosted.policySetting: politikayı taşıyan ayar anahtarı zorunlu (tek satır config ile değişmeli)');
        }
        if (!isNonEmptyString(vh.blockedHint, 20)) {
          errors.push('usage.billing.vendorHosted.blockedHint: kapı KAPALIYKEN kullanıcının ne yapacağı yazılmalı (>=20 karakter)');
        }
      }
    }
  }

  // ENG-08 — 4. KAPI: hesap açma. Buradaki her kural bir ÜRÜN yalanını kapatır.
  if (d.auth) errors.push(...validateAuth(d.auth));

  // ENG-08 (ENG-R2 §5.7) — kurulum kataloğunun KİMLİK DOĞRULAMA kapısı: komut
  // beyan eden bir kayıt, kurulanın DOĞRU ürün olduğunu ölçecek argv+kalıbı da
  // beyan etmek zorunda. Kalıp derlenebilir olmalı; bozuk regex sessizce "hiç
  // eşleşmez"e döner ve her kurulumu "yanlış ürün" diye reddederdi.
  if (d.install) {
    if (isNonEmptyString(d.install.command)) {
      if (!Array.isArray(d.install.verifyArgv) || !d.install.verifyArgv.length) {
        errors.push('install.verifyArgv: kurulum komutu beyan eden kayıt sürüm/kimlik argv\'si de beyan etmeli (ENG-R2 §5.7)');
      }
      if (!isNonEmptyString(d.install.verifyPattern)) {
        errors.push('install.verifyPattern: kurulanın DOĞRU ürün olduğunu ölçen kalıp zorunlu (paket adı garanti değil)');
      } else {
        try { new RegExp(d.install.verifyPattern, 'i'); } catch {
          errors.push(`install.verifyPattern derlenemiyor ('${d.install.verifyPattern}')`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * ENG-08 — `auth` bloğunun kapıları. Saf → `{string[]}` hata listesi.
 *
 * Her kural bir ÜRÜN yalanını kapatıyor:
 *   • `flow` enum dışıysa UI hangi düğmeyi çizeceğini bilemez ve sessizce
 *     "Aboneliğimle giriş yap" varsayardı — abonelik yolu OLMAYAN motorda bu
 *     kullanıcıyı çalışmayan bir butona gönderir (Eren kuralı: dürüst rozet).
 *   • `needsCode` ile `flow` ayrışırsa kod kutusu yanlış akışta çizilir/çizilmez.
 *   • `flow:'api-key'` bir `apiKey` bloğu olmadan ANLAMSIZDIR (anahtar nereye?).
 *   • `apiKey:null` bir BEYAN olmalı, sessiz boşluk değil → `apiKeyNote` zorunlu
 *     (yetenek `null`'larında `unsupported[...]` neyse burada bu odur).
 *   • `api-key` yolunda `env` ZORUNLU: anahtar env ile gider, ASLA argv'ye
 *     (ENG-R3 §9.3 güvenlik çizgisi, emsal agentRunner.js:1520-1525).
 */
function validateAuth(a) {
  const errors = [];
  if (!AUTH_FLOWS.includes(a.flow)) {
    errors.push(`auth.flow geçersiz ('${a.flow}') — ${AUTH_FLOWS.join('|')}`);
    return errors; // gerisi flow'a dayanıyor; yanlış flow'da ikinci hata gürültüdür
  }
  if (a.needsCode !== (a.flow === 'oauth-code')) {
    errors.push(`auth.needsCode ('${a.needsCode}') flow ('${a.flow}') ile AYNI şeyi söylemiyor`);
  }
  const hasLogin = Array.isArray(a.loginArgv) && a.loginArgv.length > 0;
  if (a.flow === 'oauth-code' || a.flow === 'oauth-callback' || a.flow === 'device-code') {
    if (!hasLogin) errors.push(`auth.loginArgv: '${a.flow}' bir giriş komutu beyan etmeli`);
  } else if (hasLogin) {
    // 🔴 ENG-17 — `external` İÇİN İSTİSNA (ölçümle açıldı). Eski kural "external ⇒
    // giriş komutu OLAMAZ" diyordu; gerekçesi doğruydu (olmayan bir abonelik yolunu
    // uydurma), ama cursor/crush onu çürüttü: giriş komutu GERÇEKTEN VAR
    // (`cursor-agent login`, `crush login hyper|copilot`) ve yine de akış ürünün
    // DIŞINDA tamamlanır (tarayıcı · editörle paylaşımlı depo · üçüncü platform).
    // Komutu gizlemek kullanıcıya yalan, "biz süreriz" demek daha büyük yalan
    // olurdu → komut BEYAN edilebilir, ama NEDEN sürülmediği YAZILMAK ZORUNDA.
    if (a.flow === 'external') {
      if (!isNonEmptyString(a.externalNote, 20)) {
        errors.push(
          "auth.externalNote: 'external' akışında giriş komutu BEYAN edilebilir ama ürünün onu NEDEN " +
            'sürmediği yazılmalı (>=20 karakter) — yoksa UI "Giriş yap" düğmesi çizip kullanıcıyı ' +
            'sürülemeyen bir akışa gönderir',
        );
      }
    } else {
      errors.push(`auth.loginArgv: '${a.flow}' akışında giriş komutu OLAMAZ (abonelik yolu uydurulmaz)`);
    }
  }
  if (a.statusArgv !== null && a.statusArgv !== undefined) {
    if (!Array.isArray(a.statusArgv) || !a.statusArgv.length) errors.push('auth.statusArgv: dolu bir argv dizisi olmalı');
    if (!STATUS_PARSERS.includes(a.statusParse)) {
      errors.push(`auth.statusParse geçersiz ('${a.statusParse}') — ${STATUS_PARSERS.join('|')}`);
    }
  } else if (a.flow !== 'api-key') {
    // ENG-12 — ÜÇÜNCÜ DURUM: "BİLİNMİYOR".
    //
    // Eski kural durum komutu olmayan her OAuth motorunu REDDEDİYORDU (gerekçe
    // yerindeydi: "biz giriş başlattık" iyimserliği = [[ref_whatsapp_status_column_lies]]).
    // Ama ÖLÇÜM bir motorun o komuta sahip OLMAYABİLECEĞİNİ gösterdi: copilot 1.0.80'in
    // komut listesinde (kabuk-tamamlama betiği, ENG-12 §2.7) ne `auth status` ne `logout`
    // var. Kaydı REDDETMEK motoru desteklenemez yapardı; sessizce kabul etmek rozeti
    // yalancı yapardı. Doğru cevap üçüncü durumu BEYAN ZORUNLU kılmak:
    //   • `statusArgv: null` + `statusNote` (>=20 karakter gerekçe) → rozet "bilinmiyor"
    //     der (engineAuth: `loggedIn:null` + `statusUnknown:true`), "bağlı" DEMEZ.
    // Motor-adı kontrolü YOK: kural yeteneğin BEYANINA bakar (feedback_no_hardcoded_brand_cases).
    if (!isNonEmptyString(a.statusNote, 20)) {
      errors.push(
        `auth.statusArgv: '${a.flow}' akışı rozetini motorun KENDİ durum komutundan almak zorunda — ` +
          'komut GERÇEKTEN yoksa `auth.statusNote` ile (>=20 karakter, ÖLÇÜMLE) beyan et',
      );
    }
  }
  // ENG-ENABLE-01 — 'exit-code' şeklinde girişsizlik cümlesi ZORUNLU: onsuz her
  // sıfır-dışı çıkış (komut yok, ağ hatası, bozuk kurulum) "giriş yapılmamış" diye
  // boyanırdı — ADP-893'ün tam olarak kapattığı sınıf.
  if (a.statusParse === 'exit-code' && !isNonEmptyString(a.signedOutPattern, 10)) {
    errors.push(
      "auth.signedOutPattern: 'exit-code' ayrıştırması motorun ÖLÇÜLMÜŞ girişsizlik cümlesini ister " +
        '(>=10 karakter) — yoksa "ölçemedim" ile "hayır" ayırt edilemez',
    );
  }
  // Çelişki: durum komutu VARKEN "komut yok" gerekçesi yazılamaz (biri bayat demektir).
  if (a.statusArgv && isNonEmptyString(a.statusNote)) {
    errors.push('auth: hem statusArgv DOLU hem statusNote — çelişki (gerekçe yalnız komut YOKKEN yazılır)');
  }
  // ENG-CURSOR-APIKEY-01 — `statusField` yalnız JSON şeklinde anlamlıdır: metin/çıkış-kodu
  // ayrıştırıcısı alan okumaz; oraya yazılan ad SESSİZCE yok sayılırdı (bu kartın kök nedeni
  // tam olarak "beyan var, okuyan yok" idi — aynı sınıfı şemada kapatıyoruz).
  if (a.statusField !== undefined && a.statusField !== null) {
    if (!isNonEmptyString(a.statusField)) errors.push('auth.statusField: dolu bir alan adı olmalı');
    if (a.statusParse !== 'json') errors.push("auth.statusField: yalnız statusParse:'json' ile anlamlı — başka şekilde OKUNMAZ");
  }
  // ENG-CURSOR-APIKEY-01 — anahtar DOĞRULAMA komutu: durum komutu anahtarı OKUMAYAN
  // motorda (cursor: `status` yalnız oturum jetonuna bakar) ayrı bir komut beyan edilir.
  // Anahtar bloğu olmayan motorda anlamsızdır; boş dizi "beyan var, komut yok" yalanıdır.
  if (a.apiKeyVerifyArgv !== undefined && a.apiKeyVerifyArgv !== null) {
    if (!Array.isArray(a.apiKeyVerifyArgv) || !a.apiKeyVerifyArgv.length || !a.apiKeyVerifyArgv.every((s) => isNonEmptyString(s))) {
      errors.push('auth.apiKeyVerifyArgv: dolu bir argv dizisi olmalı (yalnız dizgeler)');
    }
    if (a.apiKey === null || a.apiKey === undefined) {
      errors.push('auth.apiKeyVerifyArgv: anahtar bloğu (apiKey) olmayan motorda doğrulama komutu anlamsız');
    }
  }
  if (a.apiKey === null || a.apiKey === undefined) {
    if (a.flow === 'api-key') errors.push("auth.apiKey: 'api-key' akışı bir anahtar bloğu olmadan anlamsız");
    if (!isNonEmptyString(a.apiKeyNote, 20)) {
      errors.push('auth.apiKeyNote: apiKey null ise GEREKÇE zorunlu (>=20 karakter) — sessiz boşluk yasak');
    }
  } else {
    if (a.apiKeyNote !== undefined) errors.push('auth: hem apiKey DOLU hem apiKeyNote — çelişki');
    if (!isNonEmptyString(a.apiKey.env)) {
      errors.push('auth.apiKey.env: anahtar ENV ile gider (argv YASAK) → değişken adı zorunlu');
    }
    if (!isNonEmptyString(a.apiKey.vaultService)) {
      errors.push('auth.apiKey.vaultService: anahtar credentialVault kaydının servis adı zorunlu');
    }
  }
  return errors;
}

/** Tüm defteri doğrular: `{ ok, errors: { <engineId>: string[] } }`. */
function validateRegistry(registry) {
  const reg = registry || ENGINE_REGISTRY;
  const errors = {};
  let ok = true;
  for (const [id, descriptor] of Object.entries(reg)) {
    const res = validateDescriptor(descriptor, id);
    if (!res.ok) {
      ok = false;
      errors[id] = res.errors;
    }
  }
  return { ok, errors };
}

/**
 * VARSAYILAN defter örneği. Modülün dışa açık okuma fonksiyonları bunun bağlanmış
 * hâlidir → ENG-04'ten beri var olan API bit-bit korunur.
 */
const defaultRegistry = createRegistry(ENGINE_REGISTRY);
const {
  engineIds,
  isRegisteredEngine,
  getEngine,
  capability,
  tuiSignals,
  engineAutonomy,
  unsupportedCapabilities,
  unsupportedSummary,
} = defaultRegistry;

module.exports = {
  ENGINE_REGISTRY,
  CAPABILITY_KEYS,
  REQUIRED_KEYS,
  SECURITY_CRITICAL_CAPABILITIES,
  VERIFICATION_CHANNELS,
  AUTONOMY_LEVELS,
  AUTONOMY_CHANNELS,
  IDENTITY_KINDS,
  MCP_KINDS,
  OUTPUT_KINDS,
  OUTPUT_STDIN_MODES,
  USAGE_KINDS,
  USAGE_LEVELS,
  USAGE_CONTENTS,
  BILLING_MODES, // ENG-16 — 4. değer: 'vendor-hosted'
  VENDOR_GATE_POLICIES,
  VENDOR_HOSTED_DETECTORS,
  IDENTITY_ENV_TARGETS,
  ISOLATION_KINDS,
  AUTH_FLOWS,
  STATUS_PARSERS,
  validateAuth,
  createRegistry, // ENG-07 — enjekte edilebilir defter (kayıtsız/eksik motoru ÖLÇMEK için)
  engineIds,
  isRegisteredEngine,
  getEngine,
  capability,
  tuiSignals, // ENG-07 L2 — TUI sinyal BEYANI (regex'ler renderer'da tek kaynakta kalır)
  engineAutonomy, // ENG-20 — "bu pane onay sorar mı?" tek okuma ucu
  unsupportedCapabilities,
  unsupportedSummary,
  validateDescriptor,
  validateRegistry,
};
