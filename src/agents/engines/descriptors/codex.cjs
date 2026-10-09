'use strict';

module.exports = Object.freeze({
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
});
