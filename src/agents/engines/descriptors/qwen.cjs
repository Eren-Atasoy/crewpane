'use strict';

module.exports = Object.freeze({
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
});
