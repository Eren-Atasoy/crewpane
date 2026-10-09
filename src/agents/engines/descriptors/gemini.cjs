'use strict';

module.exports = Object.freeze({
    id: 'gemini',
    label: 'Gemini CLI',
    bin: 'gemini',

    // ADR-004 dengi: claude `--dangerously-skip-permissions`, copilot `--allow-all-tools`,
    // gemini `--approval-mode yolo` (help: "yolo (auto-approve all tools)"). `-y` kısayolu
    // AYNI şey; uzun biçim seçildi çünkü değeri argv'de OKUNUR (rozet/log dürüstlüğü).
    // 🪤 `--sandbox` BİLEREK ALINMADI: gemini sandbox'ı Docker/Podman ya da macOS seatbelt
    // ister; yokken pane HİÇ açılmaz. Güven kapısı `trust` bloğunda (env), argv'de değil.
    defaultArgs: Object.freeze(['--approval-mode', 'yolo']),

    // ─── ENG-20 — GEMİNİ TAM-OTOMATİK: KARAR + KANIT ─────────────────────────
    // Eren kararı (2026-08-18): otopilotta onay sorusu akışı kesiyor → gemini de
    // claude paritesinde tam-otomatik. `yolo` ENG-14'te yazılmıştı ama o zaman AÇIK
    // BİR SORU olarak raporlanmıştı (ENG-14 §7-2: "onaylanıyor mu?") — ENG-20 o soruyu
    // KAPATIR: karar ONAYLANDI, alternatif `auto_edit` (yalnız düzenleme otomatik)
    // REDDEDİLDİ (araç çağrısında yine sorardı → aynı kesinti).
    // Kanıt: `gemini --help` → "--approval-mode … yolo (auto-approve all tools)";
    // gerçek pty turunda pane onay diyaloğu ÇIKARMADI (ENG-20 §2).
    // GÜVEN KAPISI (`GEMINI_CLI_TRUST_WORKSPACE=true`, `trust` bloğu) bu kararın
    // AYRILMAZ parçasıdır: güvenilmeyen dizinde gemini headless'ta exit 55 ile DURUR,
    // interaktifte proje agents/hooks/skills'i SESSİZCE düşürür → yolo tek başına
    // tam-otomatik pane vermez. Eren'e açıklandı, KALIYOR.
    autonomy: Object.freeze({
      level: 'full',
      via: 'argv',
      flags: Object.freeze(['--approval-mode', 'yolo']),
      measured: 'gemini 0.55.1 help: "yolo (auto-approve all tools)"; ENG-20 gerçek pty turu: onay/güven diyaloğu YOK, TUI komposere ulaştı',
      why: 'Eren kararı 2026-08-18 (claude paritesi). `--sandbox` alınmadı: Docker/Podman ya da seatbelt ister, yokken pane HİÇ açılmaz. Güven kapısı env\'de (GEMINI_CLI_TRUST_WORKSPACE) — yolo\'nun tamamlayıcısı',
    }),

    // ─── 1. KAPI — KİMLİK: ENV → TEK DOSYA, ama REPLACE ─────────────────────
    identity: Object.freeze({
      kind: 'env-file',
      env: 'GEMINI_SYSTEM_MD',
      envTarget: 'file', // goose sınıfı: env TEK dosya yolu taşır (birleştirme YOK)
      envSeparator: null,
      fileSuffix: '.md',
      fileName: 'crewpane-system.md',
      position: 'append', // kimlik metni TABAN PROMPTUN SONUNA eklenir (aşağıdaki reçete)
      cap: Object.freeze({ cli: null, file: 'FILE_MAX' }),
      resumeReinject: false, // resume'da dosyanın yeniden okunduğu ÖLÇÜLMEDİ
      // 🔴 REPLACE BEYANI — bu bayrak olmadan taşıyıcı sessizce prompt siler.
      replacesSystemPrompt: true,
      // ─── GÖMÜLÜ PROMPTU GERİ KAZANMA REÇETESİ (ÖLÇÜLDÜ, JETON MALİYETİ SIFIR) ───
      // Adımlar (engineBasePrompt.cjs uygular; motor adı geçmez, hepsi BU beyandan):
      //   1. `dumpEnv` ile motoru KENDİ efektif prompt'unu dosyaya YAZDIR.
      //   2. Aynı komutu bir kez de `readEnv=<sentinel>` ile koştur → çıktı
      //      "sentinel + CANLI KUYRUK"tur. Kuyruk = çıktı − sentinel (BAYT ÇIKARMA).
      //   3. TABAN = tam döküm − kuyruk (suffix çıkarma; sezgisel metin kesme YOK).
      //   4. Dosyaya TABAN + "\n\n" + KİMLİK yaz.
      // NEDEN 2. ADIM: `maybeWriteSystemMd(sanitizedPrompt…)` NİHAİ prompt'u yazar ve
      // nihai prompt CLI'ın canlı eklediği kuyruğu (GEMINI.md bağlamı + hook bölümleri)
      // İÇERİR. Ham dökümü geri beslemek onu İKİ KEZ basar ve BAYATLATIR (ölçüldü:
      // "# Contextual Instructions" 2 kez, 25.087 → 27.192). Kuyruk çıkarılınca 1 kez.
      basePrompt: Object.freeze({
        kind: 'self-dump',
        dumpEnv: 'GEMINI_WRITE_SYSTEM_MD',
        readEnv: 'GEMINI_SYSTEM_MD', // sentinel bu env ile verilir (kimlikle AYNI kapı)
        // Prompt İNŞA edilince yazılır; model çağrısından ÖNCE. Kimlik doğrulaması
        // BİLEREK düşürülür (`neutralizeEnv`) → istek modele HİÇ ulaşmaz, JETON YOK.
        probeArgv: Object.freeze(['-p', 'x', '-o', 'text']),
        neutralizeEnv: Object.freeze({ GEMINI_API_KEY: 'crewpane-base-prompt-probe-invalid', GEMINI_DEFAULT_AUTH_TYPE: 'gemini-api-key' }),
        cost: 'auth-rejected', // ÖLÇÜLDÜ: exit 1, döküm YAZILDI, model turu YOK
        timeoutMs: 90000,
        cacheBy: Object.freeze(['version', 'cwd']), // döküm cwd'ye BAĞLI (skills/GEMINI.md)
        // Reçete DÜŞERSE kimlik YAZILMAZ (fail-closed): kimliksiz ama TAM yetenekli bir
        // pane, kimlikli ama güvenlik kurallarını kaybetmiş bir pane'den iyidir. Log'a
        // düşer — sessiz değil.
        onFailure: 'skip-identity',
      }),
    }),

    model: Object.freeze({
      kind: 'flag',
      flag: '--model',
      position: 'append',
      // Model kaynağı: settings.json (`model.name`) — ev dizini GEMINI_CLI_HOME ile
      // taşınır (paths.js: `homedir() = GEMINI_CLI_HOME ?? os.homedir()`, GEMINI_DIR='.gemini').
      detect: Object.freeze({
        kind: 'json-settings',
        env: 'GEMINI_MODEL',
        field: 'model.name',
        files: Object.freeze([
          Object.freeze({ scope: 'engine-home', homeEnv: 'GEMINI_CLI_HOME', segments: Object.freeze(['.gemini', 'settings.json']) }),
          Object.freeze({ scope: 'home', segments: Object.freeze(['.gemini', 'settings.json']) }),
        ]),
      }),
      // TUI banner'ı ölçülmedi → sniffer BEYAN EDİLMEZ (yanlış model yazdırmaktansa hiç).
    }),

    images: null,
    provider: null,

    // OTURUM — kimliği BİZ basarız (`--session-id`, help: "manually provided UUID";
    // yargs `coerce` UUID'yi DOĞRULUYOR → uydurma id reddedilir).
    session: Object.freeze({
      mint: 'uuid',
      flag: '--session-id',
      killSwitchEnv: 'CREWPANE_DISABLE_SESSION_ID',
      resume: Object.freeze({
        form: 'append',
        flag: '--resume',
        // 🪤 ÖLÇÜLDÜ (help): `--resume` "latest" ya da SIRA NUMARASI alır — bizim
        // bastığımız UUID DEĞİL. Yani mint ettiğimiz kimlik resume'da KULLANILAMAZ.
        idShape: 'index-or-latest',
        lastFallback: Object.freeze(['--resume', 'latest']),
      }),
    }),

    // TOKEN-BUDGET-01 — BAĞLAM KAPSAMI: bu motorun kendi belge enjeksiyonunu
    // (proje talimatı zinciri + kalıcı hafıza indeksi) ÇALIŞMA ALANIYLA sınırlayan
    // bir taşıyıcı ÖLÇÜLMEDİ. `null` = bugünkü davranış aynen sürer; kesim yalnız
    // beyan eden motorda uygulanır (paneContextScope HEPSİ-YA-HİÇ kuralı).
    contextScope: null,
    subagentBlock: null,

    // "Güven" kapısı gemini'de SERT: güvenilmeyen dizinde headless koşu exit 55 ile
    // DURUYOR ("not running in a trusted directory"), interaktifte ise proje
    // agents/hooks/skills'i SESSİZCE düşüyor ("Skipping project agents due to
    // untrusted folder" — ölçüldü). Kapatma yolu env: `GEMINI_CLI_TRUST_WORKSPACE=true`
    // (`--skip-trust` bayrağı da var; env seçildi ki argv temiz kalsın ve kullanıcının
    // kendi değeri KAZANSIN).
    trust: Object.freeze({
      kind: 'env-consent',
      write: 'env-only',
      homeScope: 'engine-home',
      homeEnv: 'GEMINI_CLI_HOME',
      homeFallback: Object.freeze(['.gemini']),
      homeSegments: Object.freeze(['.gemini']),
      configFile: null, // güven defteri JSON (trustedFolders.json) — YAML okuyucu ona bakmaz
      pointer: 'GEMINI_CLI_TRUST_WORKSPACE',
      canonicalizeCwd: false,
      preferUser: true,
      entries: Object.freeze([
        Object.freeze({
          env: 'GEMINI_CLI_TRUST_WORKSPACE',
          value: 'true',
          why: 'güvenilmeyen dizinde headless koşu exit 55 ile durur, interaktifte proje agents/hooks/skills SESSİZCE düşer (ikisi de ölçüldü) — claude/codex güven yazımının dengi',
        }),
      ]),
    }),

    reset: '/clear',

    tui: null,

    // ─── 2. KAPI — ARAÇ BAĞLAMA: yalnız CONFIG DOSYASI ──────────────────────
    // ÖLÇÜLDÜ: yargs seçenek listesinde `--mcp-config` dengi YOK; sunucular
    // `<home>/.gemini/settings.json` içindeki `mcpServers` haritasından okunur
    // (kullanıcının gerçek dosyası okundu: aynı şema claude ile birebir).
    // Pane-başına ayrım `GEMINI_CLI_HOME` ile mümkündür ama bugün ÜRÜN YAZMIYOR →
    // `config-only` (droid ile aynı sınıf): rozet board/browser'ı VAR göstermez.
    mcp: Object.freeze({
      kind: 'config-only',
      file: '$GEMINI_CLI_HOME/.gemini/settings.json',
      field: 'mcpServers',
      allowFlag: '--allowed-mcp-server-names', // ölçüldü (help): SEÇER, EKLEMEZ
      envInheritance: true,
      position: null,
    }),

    hooks: null,

    extraRoots: Object.freeze({ flag: '--include-directories', repeat: 'variadic' }),

    skillsDir: Object.freeze({ scope: 'workspace', segments: Object.freeze(['.gemini', 'skills']) }),

    identityEnv: 'GEMINI_CLI_HOME',

    // ─── 4. KAPI — HESAP: 🔴 ENG-22 (2026-08-18) HESAPLA GİRİŞ YOLU UPSTREAM'DE ÖLDÜ
    //
    // VAKA (Eren, ekran görüntülü): `gemini` TUI'da "Sign in with Google" →
    //   "This client is no longer supported for Gemini Code Assist for individuals…
    //    migrate to the Antigravity suite: https://antigravity.google"
    // Mesaj İKİLİDE YOK — SUNUCUDAN gelir (bundle'da o cümle aranıp bulunamadı) ⇒
    // karar Google'ın backend'inde, sürüm yükseltmesiyle geri gelmez.
    //
    // ÜÇ BAĞIMSIZ KANIT (ENG-22-evidence/01-gemini-account-death.md):
    //   ① Diskte: `~/.gemini/google_accounts.json` → {"active":null,"old":["…@gmail.com"]}
    //      (mtime 2026-08-18 21:10) ve `oauth_creds.json` HİÇ OLUŞMADI ⇒ giriş denendi,
    //      kimlik bilgisi ÜRETİLMEDİ.
    //   ② İkilinin KENDİSİ göçü sürüyor: 0.55.1 bundle'ında `antigravityUtils.ts` var
    //      (`ANTIGRAVITY_SH_INSTALL = "curl -fsSL https://antigravity.google/cli/install.sh | bash"`)
    //      ve banner sayacı Antigravity metinli banner'ı KAP DIŞI tutup altına kurulum
    //      komutunu EKLİYOR — yani upstream bu banner'ı sürekli göstermeyi tasarlamış.
    //   ③ Canlı koşu: izole GEMINI_CLI_HOME + `GOOGLE_GENAI_USE_GCA=true` → akış
    //      İNTERAKTİF tarayıcıya gidiyor (`createCodeAssistContentGenerator` →
    //      `initOauthClient`), headless'ta tamamlanamıyor.
    //
    // ⇒ Bugün BİREYSEL kullanıcı için çalışan yol İKİ tane: (a) API anahtarı (aşağıdaki
    // `apiKey` bloğu — Ayarlar'daki kutu), (b) Vertex AI / Google Cloud (Workspace ya da
    // kurumsal hesap; ürün bu yolu SÜRMEZ, kullanıcı env ile kurar). Bu yüzden `flow`
    // 'external'dan 'api-key'e çekildi: 'external' "giriş ürünün DIŞINDA yapılır" der ve
    // kullanıcıyı hâlâ var olan bir hesap yoluna işaret eder — ARTIK YOK. 'api-key' UI'da
    // "Bu motorun abonelikle giriş yolu yok — yalnız kendi API anahtarınla çalışır"
    // cümlesini çizer (EngineAccountsSection, `supportsSubscription===false` dalı).
    // 🔁 GERİ ALINABİLİR: Google bireysel girişi geri açarsa flow 'external'a döner ve
    //    bu blok kanıtıyla birlikte tarihe düşer (ENG-10 disiplini: gerekçesiz rozet yok).
    auth: Object.freeze({
      label: 'Gemini CLI',
      // 🪤 ESKİ METİN "Google hesabınla ücretsiz katman ya da bir Gemini API anahtarı"
      // diyordu — 2026-08-18'den beri YALAN. Yeni metin qwen kaydının desenini izler
      // (kapanan bedava katmanı TARİHİYLE söyler, uydurma bir yol önermez).
      // 🪤 SIRA ÖNEMLİ: kartın meta satırı TEK SATIRA kırpılıyor (ekran görüntüsüyle
      // ölçüldü, ENG-22-screenshots/card-gemini.png) → asıl haber BAŞA yazılır,
      // ayrıntı sona. Uzun cümlenin sonuna gömülen bir "KAPATILDI" kullanıcıya
      // HİÇ görünmezdi.
      accountHint:
        '🔴 "Google hesabıyla giriş" 2026-08-18\'de KAPANDI (Google, Antigravity\'ye taşıdı) — bu motor artık yalnız senin Gemini API anahtarınla çalışır (Google AI Studio). Kurumsal/Workspace hesabı Vertex AI yolunu kullanabilir; ürün o akışı başlatmaz',
      signupUrl: 'https://aistudio.google.com/apikey',
      // ENG-22 — ölçülen tek çalışır bireysel yol: anahtar. Abonelik yolu UYDURULMAZ
      // (schema kuralı: `flow:'api-key'` + `loginArgv:null` ⇒ UI giriş düğmesi çizmez).
      flow: 'api-key',
      needsCode: false,
      loginArgv: null,
      logoutArgv: null,
      statusArgv: null,
      statusParse: null,
      statusNote:
        'gemini 0.55.1\'de hesap DURUMU komutu YOK (komut listesi: mcp/extensions/skills/hooks/gemma — auth/login/logout hiçbiri yok, ölçüldü) → rozet ÜÇÜNCÜ durumu gösterir: BİLİNMİYOR. Anahtar kayıtlıysa "kayıtlı" der, "motor kabul etti" DEMEZ. ENG-22: hesapla giriş yolu upstream\'de kapandığı için bu not artık YALNIZ anahtar durumu içindir',
      apiKey: Object.freeze({
        env: 'GEMINI_API_KEY', // ENV ile gider — ARGV'ye ASLA (ENG-R3 §9.3)
        vaultService: 'crewpane-gemini-api-key',
        keyUrl: 'https://aistudio.google.com/apikey',
        keyLabel: 'Gemini API anahtarı (Google AI Studio)',
        // ENG-20 — bu cümle ARTIK KULLANICI-GÖRÜNÜRDÜR (engineAuth.readStatus →
        // apiKeyNote → Ayarlar'daki anahtar kutusu). Bu yüzden dili geliştirici
        // notundan kullanıcı cümlesine çevrildi; ÖLÇÜM ve motorun kendi İngilizce
        // cümlesi KORUNDU (kanıt gösterilmeden uyarı verilmez).
        note: 'Ücretsiz katmanda GÜNLÜK KOTA var: kota dolunca motor turun ortasında durur ve pane iş yapamaz (motorun kendi cümlesi: "You have exhausted your daily quota on this model", HTTP 429). Ücretli plan ya da Vertex bu sınırı kaldırır. Ölçüm: 2026-08-18.',
      }),
    }),

    // ─── 4. KAPI — KULLANIM ─────────────────────────────────────────────────
    usage: null,

    // ─── 3. KAPI — SÜPERVİZÖR OKUMA (headless) ──────────────────────────────
    output: Object.freeze({
      kind: 'json',
      flag: '--output-format',
      values: Object.freeze(['text', 'json', 'stream-json']),
      quietFlag: null,
      requiresQuiet: false, // ÖLÇÜLDÜ: `-o text` stdout'u TEMİZ (uyarılar stderr'de)
    }),

    install: Object.freeze({
      label: 'Gemini CLI',
      // AYNA: engineInstall.npmUserGlobal('@google/gemini-cli') — ~/.local/bin
      // augmentedPath'te olduğu için `--prefix ~/.local` ŞART (aksi hâlde kurulan
      // ikili PATH'te GÖRÜNMEZ; ENG-12/13 ile aynı kural).
      command: 'npm install -g --prefix ~/.local @google/gemini-cli',
      win32Command: 'npm install -g @google/gemini-cli',
      docsUrl: 'https://geminicli.com/docs/',
      checkHint: 'https://geminicli.com/docs/',
      installsTo: 'npm-global',
      // 🪤 `gemini --version` YALNIZ "0.55.1" basar → ürün KİMLİĞİNİ kanıtlamaz
      // (claude'daki `kimi-code` tuzağının aynısı). Kimlik `--help` başlığından okunur.
      verifyArgv: Object.freeze(['--help']),
      verifyPattern: 'usage:\\s*gemini',
    }),

    // CDX-F1 — efor kolu bu motorda BEYAN EDİLMEDİ (gerekçe: unsupported.effort).
    effort: null,

    unsupported: Object.freeze({
      contextScope:
        'bu motorun kendi belge enjeksiyonunu (proje talimatı zinciri + kalıcı hafıza indeksi) çalışma alanıyla sınırlayan bir taşıyıcı ÖLÇÜLMEDİ — kesim yalnız beyan eden motorda koşar, burada bugünkü davranış aynen sürer (TOKEN-BUDGET-01)',
      effort:
        'efor/akıl-yürütme seviyesi taşıyıcısı BU MOTORDA ÖLÇÜLMEDİ — CDX-F1 kapsamı bilerek codex (+claude beyanı) ile sınırlı tutuldu; beyan edilene kadar per-launch efor override\'ı YOKTUR ve motor kendi varsayılanıyla koşar (sessiz kayıp değil, ölçülmemiş kol)',
      images:
        'gemini CLI\'da görsel bayrağı YOK (yargs seçenek listesi ölçüldü: 38 seçenek, attachment/image/-i görsel dengi yok; `-i` PROMPT-INTERACTIVE\'dir) → görsel yolu claude\'daki gibi prompt METNİNE gömülmeli',
      provider:
        'gemini yalnız Google sağlayıcılarına bağlanır (gemini-api-key / oauth-personal / vertex-ai); ürünün BYOK grameri (providers.cjs `-c model_provider` + base_url/env_key) codex\'e özgüdür ve gemini\'de dengi YOKTUR (GOOGLE_GEMINI_BASE_URL yalnız uç nokta değiştirir, sağlayıcı DEĞİL)',
      subagentBlock:
        'gemini\'nin alt-ajan aracı ÖLÇÜLDÜ (`invoke_agent`, gömülü prompt "# Available Sub-Agents" bölümü: codebase_investigator/cli_help/generalist) ama per-launch KAPATMA yolu ölçülemedi: `--allowed-tools` DEPRECATED, yerine gelen `--policy` motorunun DENY grameri ikilide doğrulanamadı. Uydurma bir politika dosyası yazmak, olmayan bir engeli VAR sanmaktır → gemini pane\'ine LİDER rolü verilmemeli (ENG-19 çizgisi)',
      tui:
        'gemini TUI hazır/blocker dizeleri GERÇEK pane\'de ölçülmedi (bu görevin canlı turları headless `-p` ile koştu); src/app/lib/paneReadiness.ts\'te regex YOK. Var olmayan sinyalleri VAR göstermemek için alan null (ENG-10 takip kalemi)',
      hooks:
        'gemini hook yüzeyi VAR ve ÇALIŞIYOR (kullanıcının settings.json\'undaki SessionStart/BeforeTool kancaları her koşuda stderr\'e düştü — ölçüldü) ama per-launch BAYRAK yok: kancalar yalnız settings.json\'dan gelir → ADP-692 tur-başı brifingi bu motorda argv ile KURULAMAZ',
      usage:
        'gemini headless koşuda jeton defteri YAZMIYOR (ölçüldü: ~/.gemini/history/<proje> dizinleri koşulardan sonra BOŞ kaldı, sessions dosyası oluşmadı) ve `-o json` zarfının stats alanı canlı ölçülemedi (günlük kota tükendi) → kart "ölçülemedi" der, TAHMİN ETMEZ',
    }),

    partial: Object.freeze({
      identity:
        'taşıyıcı REPLACE\'tir: gömülü prompt reçeteyle GERİ KAZANILIYOR (ölçüldü, jeton maliyeti sıfır) ama reçete motorun kendi dökümüne bağlıdır — CLI sürümü döküm biçimini değiştirirse taban yeniden hesaplanır (cache anahtarı `version`+`cwd`). Ayrıca kullanıcı GEMINI_SYSTEM_MD\'yi kendi doldurmuşsa ürün onu EZER (log\'a yazılır) ve resume\'da dosyanın yeniden okunduğu ölçülmedi',
      mcp:
        'sunucular yalnız settings.json\'dan okunur; pane-başına ENJEKSİYON bugün ÜRÜN TARAFINDAN YAPILMIYOR (config-only) → board/browser/integrations araçları gemini pane\'inde YOK sayılır. `--allowed-mcp-server-names` var olan sunucuları SEÇER, yeni sunucu EKLEMEZ (ölçüldü)',
      session:
        'oturum kimliğini BİZ basabiliyoruz (`--session-id <uuid>`, yargs UUID doğruluyor) ama `--resume` UUID KABUL ETMİYOR: "latest" ya da SIRA NUMARASI (ölçüldü) → bastığımız kimlikle resume EDİLEMEZ, yalnız `--resume latest` yedeği çalışır',
      trust:
        'güven env ile veriliyor (`GEMINI_CLI_TRUST_WORKSPACE=true`, ölçüldü); kullanıcının kendi ENV değeri kazanır ama kullanıcının trustedFolders.json defteri OKUNMUYOR (JSON; bugünkü env-consent okuyucusu YAML anahtarı arar) → kullanıcı dizini zaten güvenilir işaretlediyse ürün gereksiz yere env yazar (zararsız, ama beyanlı)',
      output:
        '`--output-format` ölçülmüş seçenek listesinden okundu ve `-o text` gerçek koşuda TEMİZ stdout verdi; `json`/`stream-json` zarfının ŞEKLİ canlı doğrulanamadı (günlük kota tükendi) → süpervizör okuyucusu bu motorda henüz yazılmamalı',
      model:
        'model bayrağı ölçüldü (`-m/--model`, gerçek koşuda `-m gemini-3.6-flash` kabul edildi) ama settings.json\'daki `model.name` alanı BOŞ bir kullanıcıda hiç yazılmıyor → tespit çoğu kurulumda "bilinmiyor"a düşer; ayrıca ölçüldü ki eski model adları 404 döner ("gemini-2.5-flash is no longer available to new users")',
      skillsDir:
        'gemini skill\'leri GÜVEN kapısına bağlı: güvenilmeyen dizinde `gemini skills list` "No skills discovered" dedi ve proje agents/hooks\'u da düştü (ölçüldü) → skill görünürlüğü trust bloğunun ÇALIŞMASINA bağımlıdır, bağımsız değil',
      identityEnv:
        'GEMINI_CLI_HOME ev dizinini komple taşır (paths.js `homedir()` ölçüldü) ama ikilinin İKİ farklı okuma yolu var: paths.js `<GEMINI_CLI_HOME>/.gemini`, gemini.js getMemoryNodeArgs ise `<GEMINI_CLI_HOME>` (\'.gemini\' EKLEMEDEN) → profil ayrımı çoğu yüzeyde çalışır, bellek ayarı okuması sapabilir (yukarı-akım tutarsızlığı, ölçüldü)',
      auth:
        'anahtar yolu ÖLÇÜLDÜ ve CANLI ÇALIŞTI (GEMINI_API_KEY ile gerçek turlar koştu); abonelik/OAuth yolu yalnız interaktif TUI\'de yaşıyor ve CrewPane onu SÜREMEZ → rozet "bilinmiyor" der. Ücretsiz katmanda GÜNLÜK KOTA ölçüldü (429)',
      extraRoots:
        '`--include-directories` yargs listesinde ölçüldü (dizi, virgülle ayrılabilir) ama ek kökün GÜVEN kapısından nasıl geçtiği ölçülmedi: güvenilmeyen ek kök sessizce düşebilir (trust ölçümüyle aynı sınıf)',
    }),

    verification: Object.freeze({
      contextScope: Object.freeze({ channel: 'unverified', source: 'TOKEN-BUDGET-01 — bu motorda belge-enjeksiyonunu kapatan bir bayrak ARANMADI/ÖLÇÜLMEDİ; kesim yalnız beyan eden motorda koşar' }),
      effort: Object.freeze({ channel: 'unverified', source: 'CDX-F1: bu motorda efor bayrağı ARANMADI/ölçülmedi (kapsam: codex + claude)' }),
      identity: Object.freeze({ channel: 'measured', source: 'ENG-14-evidence/gemini-effective-*.md — kimlik-yalnız dosya efektif prompt\'u 25.073→2.126 karaktere düşürdü (REPLACE); reçeteli dosyada "# Core Mandates" 1 kez + kimlik 1 kez + kod kelimesi CEVAPTA (gemini-recipe-live.txt) · kaynak: promptProvider.getCoreSystemPrompt basePrompt=readFileSync' }),
      model: Object.freeze({ channel: 'measured', source: 'gerçek koşu: `-m gemini-3.6-flash` kabul, `-m gemini-2.5-flash` 404 ("no longer available to new users"); settings.json şeması kullanıcının gerçek dosyasından okundu' }),
      images: Object.freeze({ channel: 'measured', source: 'yargs option listesi (gemini-LI2WNAGG.js, 38 seçenek) — görsel/attachment bayrağı YOK' }),
      provider: Object.freeze({ channel: 'measured', source: 'ikili: AuthType enum (gemini-api-key/oauth-personal/vertex-ai) + GOOGLE_GEMINI_BASE_URL yalnız uç nokta' }),
      session: Object.freeze({ channel: 'measured', source: '`gemini --help`: --session-id "manually provided UUID" (yargs coerce doğruluyor) · --resume "latest ya da index" → mint edilen UUID resume\'da kullanılamaz' }),
      subagentBlock: Object.freeze({ channel: 'measured', source: 'ENG-14-evidence/gemini-base-prompt.md "# Available Sub-Agents" (invoke_agent + 3 ajan) · --allowed-tools DEPRECATED, --policy deny grameri doğrulanamadı' }),
      trust: Object.freeze({ channel: 'measured', source: 'ENG-14-evidence/gemini-trust-gate.txt — güvenilmeyen dizinde exit 55 "not running in a trusted directory"; GEMINI_CLI_TRUST_WORKSPACE=true ile exit 0' }),
      reset: Object.freeze({ channel: 'measured', source: 'ikili dizesi: "/clear" → konuşma geçmişini temizler (claude/goose ile aynı)' }),
      tui: Object.freeze({ channel: 'unverified', source: 'gerçek pane\'de ölçülmedi (bu görev headless koştu) → alan null' }),
      mcp: Object.freeze({ channel: 'measured', source: 'kullanıcının ~/.gemini/settings.json dosyası okundu (mcpServers haritası, claude şemasıyla birebir) + yargs listesinde --mcp-config YOK + `gemini mcp list` gerçek sunucuyu "Connected" gösterdi' }),
      hooks: Object.freeze({ channel: 'measured', source: 'her koşuda stderr\'e düşen "Hook system message: …" satırları (kullanıcının settings.json SessionStart kancası) — per-launch bayrak YOK' }),
      extraRoots: Object.freeze({ channel: 'measured', source: '`gemini --help` → --include-directories (array, virgülle ayrılabilir)' }),
      skillsDir: Object.freeze({ channel: 'measured', source: 'ENG-14-evidence/gemini-skills-list.txt — güvenilmeyen dizinde "No skills discovered" + gömülü promptta <available_skills> yalnız BUILTIN iki skill' }),
      identityEnv: Object.freeze({ channel: 'measured', source: 'ikili paths.js: `function homedir() { const envHome = process.env["GEMINI_CLI_HOME"]; if (envHome) return envHome; return os.homedir(); }` + GEMINI_DIR=".gemini"' }),
      auth: Object.freeze({ channel: 'measured', source: 'GEMINI_API_KEY ile GERÇEK turlar koştu (gemini-recipe-live.txt); komut listesinde auth/login YOK; ücretsiz katmanda 429 "exhausted your daily quota" ölçüldü · ENG-22 (2026-08-18): hesapla giriş yolu KAPANDI — ENG-22-evidence/01-gemini-account-death.md (google_accounts.json active:null + oauth_creds.json yok · bundle antigravityUtils.ts göç banner\'ı · GOOGLE_GENAI_USE_GCA canlı koşu interaktif tarayıcıya düştü)' }),
      usage: Object.freeze({ channel: 'measured', source: 'headless koşulardan sonra ~/.gemini/history/<proje> dizinleri BOŞ (defter yazılmıyor) — ölçüldü' }),
      output: Object.freeze({ channel: 'measured', source: '`gemini --help` -o enum (text|json|stream-json) + `-o text` gerçek koşuda temiz stdout' }),
      install: Object.freeze({ channel: 'measured', source: 'kurulu paket: /Users/…/.local/lib/node_modules/@google/gemini-cli (npm global) · `gemini --version` → "0.55.1" (kimlik YOK) → --help kalıbı' }),
    }),
});
