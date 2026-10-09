'use strict';

module.exports = Object.freeze({
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
});
