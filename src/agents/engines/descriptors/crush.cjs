'use strict';

module.exports = Object.freeze({
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
});
