'use strict';

module.exports = Object.freeze({
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
});
