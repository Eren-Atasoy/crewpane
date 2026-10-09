'use strict';

module.exports = Object.freeze({
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
});
