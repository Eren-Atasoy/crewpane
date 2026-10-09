'use strict';

module.exports = Object.freeze({
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
});
