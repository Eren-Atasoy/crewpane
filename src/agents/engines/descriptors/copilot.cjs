'use strict';

module.exports = Object.freeze({
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
});
