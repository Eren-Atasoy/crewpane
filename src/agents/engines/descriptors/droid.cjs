'use strict';

module.exports = Object.freeze({
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
});
