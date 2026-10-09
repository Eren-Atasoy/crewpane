'use strict';

module.exports = Object.freeze({
    id: 'goose',
    label: 'Goose',
    bin: 'goose',

    // Pane = İNTERAKTİF oturum. `goose` çıplak koşunca yalnız yardım basar (ölçüldü),
    // `goose run` girdi ister → tek doğru pane komutu `session`.
    // ⚠️ ADR-004 dengi bir "izinleri atla" bayrağı goose'ta YOK: araç onayı
    // GOOSE_MODE ile ayarlanır (config/env), argv'de değil. Bu yüzden defaultArgs
    // yalnız alt-komuttur — uydurma bayrak EKLENMEZ.
    defaultArgs: Object.freeze(['session']),

    // ENG-20 — TEK "unknown" SATIR. goose'ta onay kipi argv'de DEĞİL `GOOSE_MODE`
    // config/env'indedir; ölçülen tek şey CLI yardımıdır ve orada bu kip HİÇ geçmiyor
    // (`goose --help` + `goose session --help` tam liste tarandı: "mode" yok; `goose info`
    // config.yaml'ı "missing" diyor → yerel kullanıcıda yazılı bir kip DE yok). Değerin
    // adını dokümandan KOPYALAMAK bu defterin yasakladığı şeydir (ENG-09 "tahmin yok"):
    // yanlış bir env adı pane'i SESSİZCE yarı-otomatik bırakır ve beyan "full" der.
    // Doğru cevap bugün "ÖLÇMEDİM"; ölçüm gerçek bir goose turu ister → ayrı görev.
    autonomy: Object.freeze({
      level: 'unknown',
      via: null,
      flags: Object.freeze([]),
      measured: null,
      why: 'goose\'ta ADR-004 dengi argv bayrağı YOK (ölçüldü: yardım listesinde onay/kip seçeneği geçmiyor); kip `GOOSE_MODE` config/env kapısındadır ve DEĞERİ ölçülmedi → beyan "unknown" kalır, uydurulmuş bir env yazılmaz. Takip: gerçek goose turunda kip ölçülüp env `trust`/otonomi kapısına bağlanacak',
    }),

    // ─── 1. KAPI — KİMLİK: ENV → DOSYA (copilot sınıfı, ama env bir DOSYA yolu) ──
    // ÖLÇÜLDÜ (gerçek pty, `goose session`): `GOOSE_SYSTEM_PROMPT_FILE_PATH=<dosya>`
    // → dosyadaki metin sistem talimatlarına EKLENİR; ajan kod kelimesini cevapladı
    // ve AYNI koşuda araçlarını kullanmaya devam etti (REPLACE değil APPEND —
    // gemini `GEMINI_SYSTEM_MD` riski burada YOK).
    // 🔑 copilot'tan FARK: env bir DİZİN değil TEK DOSYA yolu taşır (`envTarget:'file'`)
    // → değer VİRGÜLLE BİRLEŞTİRİLEMEZ; ikinci bir yol yazmak dosyayı bulunamaz yapar.
    identity: Object.freeze({
      kind: 'env-file',
      env: 'GOOSE_SYSTEM_PROMPT_FILE_PATH',
      // ENG-14 — EKLER mi YERİNE Mİ geçer? ÖLÇÜLDÜ (ENG-13 §2.2): kimlik okundu VE
      // ajan aynı koşuda araçlarını kullanmayı SÜRDÜRDÜ → APPEND (REPLACE değil).
      replacesSystemPrompt: false,
      envTarget: 'file', // env DOSYAYI gösterir (varsayılan/copilot: 'dir')
      envSeparator: null, // tek yol → ADDITIVE birleştirme YOK (bkz. partial.identity)
      fileSuffix: '.md',
      fileName: 'crewpane-system.md',
      position: 'append',
      cap: Object.freeze({ cli: null, file: 'FILE_MAX' }),
      // RESUME'da dosyanın yeniden okunup okunmadığı ÖLÇÜLMEDİ → claude/codex/copilot
      // ile aynı ihtiyat. Ölçülürse `true`ya çekilebilir.
      resumeReinject: false,
      // Ölçülmüş İKİNCİ yol (yalnız HEADLESS): `goose run --system <TEXT>`.
      // Pane'de kullanılamaz (yukarıdaki düzeltme) — burada BEYAN olarak yaşar ki
      // ileride headless süpervizör turu bunu kullanabilsin.
      alt: Object.freeze({ kind: 'flag', flag: '--system', subcommand: 'run', replacesSystemPrompt: false }),
    }),

    model: Object.freeze({
      kind: 'flag',
      flag: '--model', // `goose session --model` VE `goose run --model` (ikisi de help'te)
      position: 'append',
      // ENG-09 — model kaynağı: env → $XDG_CONFIG_HOME/goose/config.yaml `GOOSE_MODEL`.
      // goose'un config anahtarları ile env adları AYNIDIR (ölçüldü: telemetri onayı
      // config.yaml'a `GOOSE_TELEMETRY_ENABLED: false` diye yazıldı).
      detect: Object.freeze({
        kind: 'yaml-config',
        env: 'GOOSE_MODEL',
        field: 'GOOSE_MODEL',
        homeEnv: 'XDG_CONFIG_HOME',
        homeSegments: Object.freeze(['goose']), // XDG kökü goose'un EV DİZİNİ DEĞİL, ÜSTÜDÜR
        homeFallback: Object.freeze(['.config', 'goose']),
        file: 'config.yaml',
      }),
      // TUI banner'ı modeli YAZIYOR ("● new session · claude-code claude-haiku-…")
      // ama claude/gpt cümle kalıplarına UYMUYOR → sniffer beyan EDİLMEZ (yanlış
      // model yazdırmaktansa hiç yazdırmamak).
    }),

    images: null,
    provider: null,

    // OTURUM — 🔑 kimliği BİZ basarız: `--name <uuid>`. ÖLÇÜLDÜ (sqlite):
    // `sessions.name = <verdiğimiz ad>` + `user_set_name = 1` → jeton defteri
    // pane'e KESİN eşlenir. (Oturum ID'sini goose kendi basar: `20260817_5`.)
    session: Object.freeze({
      mint: 'uuid',
      flag: '--name',
      killSwitchEnv: 'CREWPANE_DISABLE_SESSION_ID',
      resume: Object.freeze({
        form: 'append',
        flag: '--resume',
        // 🪤 goose'ta resume ADI İKİNCİ bir bayrakla verilir: `--resume --name <ad>`
        // (help: "When used with --resume, will resume this specific session").
        // Tek bayrak yazan bir kayıt SESSİZCE "son oturumu" resume ederdi.
        idFlag: '--name',
        idShape: 'uuid',
        lastFallback: Object.freeze(['--resume']),
      }),
    }),

    // TOKEN-BUDGET-01 — BAĞLAM KAPSAMI: bu motorun kendi belge enjeksiyonunu
    // (proje talimatı zinciri + kalıcı hafıza indeksi) ÇALIŞMA ALANIYLA sınırlayan
    // bir taşıyıcı ÖLÇÜLMEDİ. `null` = bugünkü davranış aynen sürer; kesim yalnız
    // beyan eden motorda uygulanır (paneContextScope HEPSİ-YA-HİÇ kuralı).
    contextScope: null,
    subagentBlock: null,

    // "Güven" kapısının goose'taki KARŞILIĞI: İLK KOŞU ONAYI. ÖLÇÜLDÜ (gerçek pty,
    // taze config dizini): oturum açılırken "Share anonymous usage data?" diyaloğu
    // çıkıyor ve KULLANICININ İLK YAZDIĞI HARFLERİ YUTUYOR (ölçümde "Adin " uçtu,
    // pane'e "ne? Kod kelimesini yaz." kaldı) — ADP-283'ün claude/codex'te kapattığı
    // arızanın ta kendisi. Kapatma yolu dosya yazmak DEĞİL, ENV: `GOOSE_TELEMETRY_
    // ENABLED=false` verilince taze dizinde diyalog HİÇ çıkmadı ve "goose is ready"
    // doğrudan geldi (ölçüldü).
    // Aynı mekanizma SAĞLAYICI için de gerekli: config.yaml yoksa goose "No provider
    // configured" ile durur → ölçülmüş ANAHTARSIZ yol (`claude-code`) YEDEK olarak
    // verilir. `preferUser: true` = kullanıcının kendi ayarı VARSA dokunulmaz.
    trust: Object.freeze({
      kind: 'env-consent',
      write: 'env-only', // kullanıcının config.yaml'ı ASLA yazılmaz
      homeScope: 'engine-home', // buildSpawn içinde uygulanır (env çözüldükten sonra)
      homeEnv: 'XDG_CONFIG_HOME',
      homeFallback: Object.freeze(['.config', 'goose']),
      homeSegments: Object.freeze(['goose']),
      configFile: 'config.yaml',
      pointer: 'GOOSE_TELEMETRY_ENABLED / GOOSE_PROVIDER / GOOSE_MODEL',
      canonicalizeCwd: false,
      preferUser: true, // env ya da config.yaml'da değer VARSA dokunma
      entries: Object.freeze([
        Object.freeze({
          env: 'GOOSE_TELEMETRY_ENABLED',
          value: 'false',
          why: 'ilk koşu onay diyaloğu ilk prompt\'u YUTUYOR (ölçüldü); varsayılanı KAPALI seçmek gizlilik lehine',
        }),
        Object.freeze({
          env: 'GOOSE_PROVIDER',
          value: 'claude-code',
          why: 'ölçülmüş ANAHTARSIZ yol: yerel `claude` CLI kimliğini kullanır, yeni anahtar/hesap istemez',
        }),
        Object.freeze({
          env: 'GOOSE_MODEL',
          value: 'claude-sonnet-5',
          why: 'claude-code sağlayıcısıyla GERÇEK koşuda doğrulandı; model verilmezse goose "No model configured" ile durur',
        }),
      ]),
    }),

    reset: '/clear', // ikili: "/clear — Clear the conversation history"

    tui: null,

    // ─── 2. KAPI — ARAÇ BAĞLAMA: per-launch KOMUT DİZESİ ────────────────────
    // ÖLÇÜLDÜ (gerçek koşu): `--with-extension "node '<boşluklu yol>'"` ile dış stdio
    // MCP sunucusu bağlandı, ajan aracı ÇAĞIRDI ve sunucu pane env'ini GÖRDÜ
    // (ENG12_SECRET cevaba döndü) → tırnaklama destekleniyor + env MİRAS ALINIYOR.
    // claude/copilot'tan FARK: değer bir JSON dosyası değil, TEK BİR KOMUT DİZESİ.
    mcp: Object.freeze({
      kind: 'cli-command',
      flag: '--with-extension',
      // 'ENV1=val1 ENV2=val2 command args...' (help grameri, ölçüldü)
      envPrefixInValue: true,
      quote: 'single', // boşluklu yollar tek tırnakla kapatılır (ölçüldü)
      strictFlag: null, // kullanıcının kendi uzantılarını BIRAKMA garantisi yok
      disableProfileFlag: '--no-profile', // TÜM varsayılan uzantıları kapatır (developer dahil!)
      envInheritance: true, // ÖLÇÜLDÜ: MCP çocuğu pane env'ini ALIYOR → sır argv'ye YAZILMAZ
      position: 'append',
    }),

    hooks: null,
    extraRoots: null,

    // ÖLÇÜLDÜ (`goose skills list`, workspace kökünde): goose `.claude/skills`
    // dizinini KENDİLİĞİNDEN tarıyor (claude/copilot ile AYNI dizin) ve
    // CrewPane skill'lerinin HEPSİ yüklendi (copilot'taki katı-YAML düşüşü YOK).
    skillsDir: Object.freeze({ scope: 'workspace', segments: Object.freeze(['.claude', 'skills']) }),

    // Profil ayrımı: XDG_CONFIG_HOME (ölçüldü — `goose info` üç yolu da taşıdı).
    identityEnv: 'XDG_CONFIG_HOME',

    auth: Object.freeze({
      label: 'Goose',
      accountHint: 'goose kendi hesabını AÇMAZ: bir sağlayıcı seçersin (ölçülen anahtarsız yol: yerel Claude Code aboneliğin)',
      signupUrl: 'https://block.github.io/goose/docs/getting-started/providers',
      // ENG-08 enum: giriş CrewPane DIŞINDA yapılır (`goose configure` sihirbazı ya
      // da sağlayıcının kendi CLI'ı) → ürün akış BAŞLATMAZ, yalnız beyan eder.
      flow: 'external',
      needsCode: false,
      loginArgv: null,
      logoutArgv: null,
      // 🔴 ÖLÇÜLDÜ ve TEHLİKELİ: goose'ta durum komutu YOK. `goose info` yalnız YOL
      // basar (hesap/sağlayıcı bilgisi yok); `goose doctor` ise bir DURUM KOMUTU
      // DEĞİL — AJANI KOŞTURUYOR (ölçüldü: oturum açtı, model turu harcadı). Onu
      // statusArgv yapmak her rozet tazelemesinde PARA HARCARDI.
      statusArgv: null,
      statusParse: null,
      statusNote:
        'goose 1.46.0\'da hesap DURUMU komutu YOK: `goose info` yalnız yol/sürüm basar, `goose doctor` ise durum sormaz AJANI KOŞTURUR (ölçüldü: model turu harcadı, maliyet çıkardı) → rozet ÜÇÜNCÜ durumu gösterir: BİLİNMİYOR. Sağlayıcı yapılandırması yoksa pane açılışta "No provider configured" der; ürün bunu `trust.entries` ile ölçülmüş anahtarsız yola (claude-code) düşürür',
      apiKey: null,
      apiKeyNote:
        'goose BYOK\'u SAĞLAYICI BAŞINA yapar (GOOSE_PROVIDER + o sağlayıcının kendi anahtar değişkeni: OPENAI_API_KEY, ANTHROPIC_API_KEY…) → tek bir "goose anahtarı" YOKTUR, Ayarlar\'a tek kutu koymak yanlış olurdu. Ürünün ölçülmüş varsayılanı ANAHTARSIZDIR (claude-code sağlayıcısı yerel claude kimliğini kullanır); sağlayıcı seçimi açılırsa ENG-13 §sonraki-adım kalemidir',
      noApiKeyNote:
        'goose\'ta anahtar kutusu yok — sağlayıcı anahtarı ortam değişkeniyle verilir (OPENAI_API_KEY, ANTHROPIC_API_KEY…). Hangi sağlayıcıyı seçtiğine bağlı olarak adı değişir ve CrewPane tek bir kutu için tek bir env adı gösteremez. Giriş: terminalden `goose configure` sihirbazı ile sağlayıcı seçimini yap; CrewPane yalnız durumunu okur.',
    }),

    // ─── 4. KAPI — KULLANIM: sqlite oturum defteri (KESİN eşleşme) ───────────
    // ÖLÇÜLDÜ (sqlite şeması): sessions(name, user_set_name, accumulated_*_tokens)
    // + usage_ledger(session_id, model, input/output/total/cache_*, cost REAL,
    // cost_source). Adı BİZ bastığımız için satır KESİN bulunur.
    usage: Object.freeze({
      kind: 'session-ledger',
      level: 'exact',
      content: 'counters', // ENG-14 — usage_ledger satırları SAYAÇ (mesaj gövdesi yok; biçim de sqlite)
      reader: 'goose-sessions-sqlite', // tokenUsage.LEDGER_READERS'ta HENÜZ YOK (ENG-09 takibi)
      // 🔑 BİÇİM JSONL DEĞİL SQLITE → teslim doğrulaması (transcript probu) bu motorda
      // satır-satır okuyamaz; completionChannels bu yüzden kanıt DOSYASINI zorunlu kılar.
      format: 'sqlite',
      root: '$XDG_DATA_HOME/goose/sessions',
      rootEnv: 'XDG_DATA_HOME',
      file: 'sessions.db',
      sessionKey: 'minted-name', // `--name <uuid>` → sessions.name (user_set_name=1)
      accumulation: 'cumulative-last-wins', // accumulated_* kolonları KÜMÜLATİF
      dedupeBy: null,
      cost: 'usd', // usage_ledger.cost REAL + cost_source; headless JSON'da `cost_usd` ölçüldü
      billing: Object.freeze({
        // Fatura KANALI sağlayıcıya bağlıdır: ölçülen varsayılan yol (claude-code)
        // kullanıcının claude ABONELİĞİNİ harcar; başka sağlayıcıda o sağlayıcının
        // anahtarı öder. Tek bir env "faturayı bu öder" diyemez → beyan böyle.
        apiKeyEnv: null,
        configFile: '$XDG_CONFIG_HOME/goose/config.yaml',
        field: 'GOOSE_PROVIDER',
        planField: null,
        subscriptionWhen: 'equals:claude-code',
        sourceLabel: 'usage_ledger.cost (goose sessions.db) · sağlayıcı = GOOSE_PROVIDER',
        overrideOpt: 'gooseDataHome',
      }),
    }),

    // ─── 3. KAPI — SÜPERVİZÖR OKUMA (headless `run`) ─────────────────────────
    output: Object.freeze({
      kind: 'json',
      flag: '--output-format',
      values: Object.freeze(['json', 'stream-json']),
      subcommand: 'run',
      // 🪤 ÖLÇÜLDÜ: `-q` YOKSA stdout'a ASCII banner basılıyor → `JSON.parse` PATLAR.
      quietFlag: '-q',
      requiresQuiet: true,
    }),

    install: Object.freeze({
      label: 'Goose',
      // ⚠️ ÖLÇÜLDÜ (kurulum script'i okundu, ENG-13 §5): varsayılan `CONFIGURE=true`
      // sonunda `goose configure`u /dev/tty'den İNTERAKTİF koşturur → otomasyonda
      // ASILIR; ayrıca PATH satırı için ~/.zshrc'yi değiştirmeyi TEKLİF eder.
      // `CONFIGURE=false` ikisini de kapatır (rc'ye dokunmaz, sihirbaz açılmaz).
      command:
        'curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | CONFIGURE=false GOOSE_BIN_DIR="$HOME/.local/bin" bash',
      win32Command: null,
      docsUrl: 'https://block.github.io/goose/docs/getting-started/installation',
      checkHint: 'https://block.github.io/goose/docs/getting-started/installation',
      // 🪤 `goose --version` YALNIZ sürüm numarası basar (" 1.46.0") → ürün KİMLİĞİNİ
      // kanıtlamaz. Kimlik `--help`ten okunur ("An AI agent / Usage: goose [COMMAND]").
      verifyArgv: Object.freeze(['--help']),
      verifyPattern: 'usage:\\s*goose',
    }),

    // CDX-F1 — efor kolu bu motorda BEYAN EDİLMEDİ (gerekçe: unsupported.effort).
    effort: null,

    unsupported: Object.freeze({
      contextScope:
        'bu motorun kendi belge enjeksiyonunu (proje talimatı zinciri + kalıcı hafıza indeksi) çalışma alanıyla sınırlayan bir taşıyıcı ÖLÇÜLMEDİ — kesim yalnız beyan eden motorda koşar, burada bugünkü davranış aynen sürer (TOKEN-BUDGET-01)',
      effort:
        'efor/akıl-yürütme seviyesi taşıyıcısı BU MOTORDA ÖLÇÜLMEDİ — CDX-F1 kapsamı bilerek codex (+claude beyanı) ile sınırlı tutuldu; beyan edilene kadar per-launch efor override\'ı YOKTUR ve motor kendi varsayılanıyla koşar (sessiz kayıp değil, ölçülmemiş kol)',
      images:
        'goose CLI\'da görsel bayrağı YOK (`goose run/session --help` tam seçenek listesinde yok; `-i` INSTRUCTIONS DOSYASIDIR, görsel değil) → görsel yolu claude\'daki gibi prompt METNİNE gömülmeli',
      provider:
        'goose `--provider`ı KENDİ sağlayıcı defterinden seçer (openai/anthropic/claude-code/ollama…); ürünün BYOK grameri (providers.cjs `-c model_provider` + base_url/env_key) codex\'e özgüdür ve goose\'ta dengi ÖLÇÜLMEDİ. Ölçülen anahtarsız yol `auth`/`trust` bloklarında beyanlı',
      subagentBlock:
        'goose\'un alt-ajan yüzeyi `summon` PLATFORM uzantısıdır (ikili: crates/goose/src/agents/platform_extensions/summon.rs — "launches a subagent and returns its result"); per-launch KAPATMA bayrağı YOK — `--no-profile` hepsini (developer dahil) kapatır ve pane\'i işe yaramaz hâle getirir. SERT katman kurulamaz → goose pane\'ine LİDER rolü verilmemeli (ENG-19 ile aynı çizgi)',
      tui:
        'goose TUI hazır/blocker dizeleri GERÇEK PTY\'de ölçüldü ("goose is ready", "Enter to send · Ctrl+J newline", blocker: telemetri onayı) ama regex\'ler tek kaynakta (src/app/lib/paneReadiness.ts) HENÜZ yok; buraya `signalsModule` yazmak var-olmayan sinyalleri VAR göstermek olurdu → ölçüm ENG-13 raporunda, alan null (ENG-10 takip kalemi)',
      hooks:
        'goose hook yüzeyi plugin/ayar dosyasında yaşıyor (ikili: hooks.json + GOOSE_STATUS_HOOK/GOOSE_STOP_HOOK_BLOCK_CAP); per-launch bayrak YOK → ADP-692 tur-başı brifingi goose için KURULAMAZ. Olay adları ölçülmedi, uydurulmaz',
      extraRoots:
        'goose\'ta `--add-dir` dengi YOK (`run`/`session` help tam listesi); ek kökler ancak cwd ya da uzantı üzerinden gelir → ADP-237 hafıza dizini enjeksiyonu bu motorda yapılamaz',
    }),

    partial: Object.freeze({
      identity:
        'env TEK DOSYA yolu taşır (`envTarget:\'file\'`) → copilot\'taki ADDITIVE birleştirme burada YAPILAMAZ: kullanıcı GOOSE_SYSTEM_PROMPT_FILE_PATH\'i kendi doldurmuşsa ürün onu EZER (log\'a yazılır, sessiz değil). RESUME\'da dosyanın yeniden okunduğu ölçülmedi → resumeReinject:false',
      mcp:
        'kayıt ADDITIVE ve per-launch: kullanıcının kendi uzantılarını dışarıda bırakma garantisi YOK (`--strict-mcp-config` dengi yok). Değer bir KOMUT DİZESİDİR → boşluklu yollar tırnaklanmak ZORUNDA (ölçüldü: tırnaksız yol iki argümana bölünür, `droid mcp add` aynı hatayı KENDİ yapıyor)',
      trust:
        'goose\'ta DİZİN güveni kapısı ölçülmedi (yabancı dizinlerde diyalog çıkmadı); bu alan goose\'ta İLK KOŞU kapısını (telemetri onayı) ve sağlayıcı yedeğini taşır. Kullanıcının kendi ayarı varsa dokunulmaz (`preferUser`), ama config.yaml OKUNMADAN yalnız env\'e bakılırsa kullanıcı tercihinin ezilme riski kalır — okuyucu config dosyasını da kontrol eder',
      usage:
        'defter ŞEKLİ ölçüldü (sqlite: sessions + usage_ledger, cost REAL) ama `goose-sessions-sqlite` okuyucusu tokenUsage.LEDGER_READERS\'ta HENÜZ YOK → jeton kartı bugün goose pane\'i için "ölçülemedi" der (ENG-09 takip kalemi)',
      session:
        'oturum ID\'sini goose kendi basar (20260817_5 biçimi); biz ADI basıyoruz (`--name <uuid>`, sqlite\'ta user_set_name=1 ile ölçüldü). Resume ADLA yapılır (`--resume --name <ad>`) ve bu KOMBİNASYON canlı pty\'de ölçülmedi (tek koşuluk oturumda test edilemedi)',
      output:
        '`--output-format` yalnız `goose run` (headless) alt-komutunda geçerlidir; interaktif pane\'de süpervizör JSON okuyamaz. Ayrıca `-q` ŞART: quiet olmadan stdout\'a ASCII banner basılıyor ve JSON.parse patlıyor (ölçüldü)',
      model:
        'model bayrağı ölçüldü (`session --model`) ama ürünün varsayılan sağlayıcı yedeği (claude-code) modeli `trust.entries` üzerinden veriyor; kullanıcının config.yaml\'daki tercihi ile bu yedeğin çakışması yalnız config OKUNARAK çözülür (preferUser)',
      identityEnv:
        'XDG_CONFIG_HOME pane/profil başına AYARLARI ayırır ama sağlayıcı SIRLARI sistem anahtar zincirinde yaşayabilir (GOOSE_DISABLE_KEYRING=1 ile dosyaya düşer) → iki ayrı sağlayıcı hesabı isteniyorsa keyring davranışı ayrıca ölçülmeli',
    }),

    verification: Object.freeze({
      contextScope: Object.freeze({ channel: 'unverified', source: 'TOKEN-BUDGET-01 — bu motorda belge-enjeksiyonunu kapatan bir bayrak ARANMADI/ÖLÇÜLMEDİ; kesim yalnız beyan eden motorda koşar' }),
      effort: Object.freeze({ channel: 'unverified', source: 'CDX-F1: bu motorda efor bayrağı ARANMADI/ölçülmedi (kapsam: codex + claude)' }),
      identity: Object.freeze({ channel: 'measured', source: 'ENG-13-evidence-kablolama/goose-session-pty.txt — GERÇEK pty\'de `goose session`, GOOSE_SYSTEM_PROMPT_FILE_PATH ile kimlik okundu (kod kelimesi cevapta) + sysprompt-probe.json (araçlar korundu → APPEND)' }),
      model: Object.freeze({ channel: 'measured', source: '`goose run/session --help` → --model/--provider; config.yaml anahtar adı = env adı (telemetri onayı config.yaml\'a GOOSE_TELEMETRY_ENABLED diye yazıldı)' }),
      images: Object.freeze({ channel: 'measured', source: '`goose run --help` + `goose session --help` tam seçenek listesi — görsel bayrağı YOK' }),
      provider: Object.freeze({ channel: 'measured', source: '`goose run --help` --provider (kendi sağlayıcı defteri) — ürünün providers.cjs grameriyle eşleşmiyor' }),
      session: Object.freeze({ channel: 'measured', source: 'sessions.db sqlite: `--name eng13ptyprobe` → sessions.name + user_set_name=1 (ENG-13-evidence-kablolama/goose-sqlite-schema.txt)' }),
      subagentBlock: Object.freeze({ channel: 'measured', source: 'ikili dizeleri: platform_extensions/summon.rs "launches a subagent and returns its result" + GOOSE_SUBAGENT_MODEL/PROVIDER/MAX_TURNS — kapatma bayrağı YOK' }),
      trust: Object.freeze({ channel: 'measured', source: 'ENG-13-evidence-kablolama/goose-telemetry-pre.txt — taze config dizininde GOOSE_TELEMETRY_ENABLED=false ile diyalog HİÇ çıkmadı; öncesinde (goose-session-pty.txt) diyalog ilk harfleri YUTTU' }),
      reset: Object.freeze({ channel: 'measured', source: 'ikili dizesi: "/clear" → "Clear the conversation history"' }),
      tui: Object.freeze({ channel: 'unverified', source: 'dizeler gerçek pty\'de görüldü ama paneReadiness.ts\'te regex YOK → alan null (ENG-10 takip)' }),
      mcp: Object.freeze({ channel: 'measured', source: 'ENG-13-evidence-kablolama/goose-ext-space.json — `--with-extension "node \'<boşluklu yol>\'"` ile stdio sunucu bağlandı, araç ÇAĞRILDI, pane env\'i sunucuya MİRAS geçti (ENG12_SECRET cevapta)' }),
      hooks: Object.freeze({ channel: 'unverified', source: 'ikilide hooks.json/GOOSE_STATUS_HOOK dizeleri var ama per-launch yüzey ölçülmedi → null' }),
      extraRoots: Object.freeze({ channel: 'measured', source: '`goose run/session --help` — `--add-dir` dengi YOK' }),
      skillsDir: Object.freeze({ channel: 'measured', source: 'ENG-13-evidence-kablolama/goose-skills-list.txt — workspace kökünde `goose skills list` .claude/skills dosyalarını buldu' }),
      identityEnv: Object.freeze({ channel: 'measured', source: 'ENG-13 Faz 1: `goose info` XDG_CONFIG_HOME/XDG_DATA_HOME/XDG_STATE_HOME ile üç yolu da taşıdı (izole koşu)' }),
      auth: Object.freeze({ channel: 'measured', source: 'ENG-13-evidence-kablolama/goose-doctor-runs-agent.txt — `goose doctor` DURUM sormaz, ajanı koşturur (maliyet); `goose info` yalnız yol basar; giriş komutu YOK' }),
      usage: Object.freeze({ channel: 'measured', source: 'ENG-13-evidence-kablolama/goose-sqlite-schema.txt — sessions(accumulated_*) + usage_ledger(cost REAL, cost_source)' }),
      output: Object.freeze({ channel: 'measured', source: 'ENG-13 Faz 1 goose-mcp.json — `-q --output-format json` SAF JSON; `-q` yokken banner (ölçüldü)' }),
      install: Object.freeze({ channel: 'measured', source: 'ENG-13-evidence/goose-install.sh (440 satır, okundu: CONFIGURE=true interaktif sihirbaz + rc teklifi) + `goose --version` → " 1.46.0" (kimlik YOK → --help kalıbı)' }),
    }),
});
