'use strict';

module.exports = Object.freeze({
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
});
