'use strict';

module.exports = Object.freeze({
    id: 'muse',
    label: 'Muse Code',
    // Site kimliği ile ikili adı bu motorda AYNI (`muse`) — cursor/antigravity
    // tuzağı burada YOK (kurucu script: `command_name="muse"`, 04-…/install.sh).
    bin: 'muse',

    // BOŞ ve BİLİNÇLİ: `--yolo` / `--disable-approval` ölçülen yardım metninde VAR
    // ama alınmadı (gerekçe `autonomy.why`). Motor zaten çalıştırmaya kapalı.
    defaultArgs: Object.freeze([]),

    autonomy: Object.freeze({
      level: 'partial',
      via: null,
      flags: Object.freeze([]),
      why:
        'ÖLÇÜLDÜ (01-muse-help.txt): "Safety (approval and the sandbox are ON by default)" — varsayılan `--approval-mode on-request`. Tam parite `--yolo` (onay + sandbox + workspace güveni HEPSİNİ kapatır) ya da `--disable-approval` demek; ikisi de GERÇEK bir onay turunda ölçülmedi (hesapsız `echo` sağlayıcısı araç çağırmıyor) ve bu motorun kimlik/alt-ajan kapıları da kapalı → bayrak ALINMADI. claude paritesi ENGINE-MUSE-03\'ün (canlı tur) kararıdır, bu kartın değil',
    }),

    // ─── 1. KAPI — KİMLİK: taşıyıcı ADAYLARI ölçüldü, SEMANTİĞİ ölçülmedi → null.
    identity: null,

    // ÖLÇÜLDÜ (01-muse-help.txt): `--model <MODEL>  Model id for non-echo providers`
    // hem kökte hem `exec` altında. Model ADLARI ölçülemedi (katalog hesap ister) →
    // `detect` yok: ürün model listesi UYDURMAZ.
    model: Object.freeze({
      kind: 'flag',
      flag: '--model',
      position: 'append',
      detect: null,
    }),

    // CDX-F1 — EFOR KOLU: bu motorda AYRI bir bayrak ve enum ikilinin kendi yardım
    // metninde YAZILI (01-muse-help.txt): `--reasoning-effort <EFFORT>  Meta reasoning
    // effort: none|minimal|low|medium|high|xhigh|max|ultra (default: high)`.
    // Beyaz liste burada ZORUNLU (şema kuralı): geçersiz değer turu ERROR ile öldürür.
    effort: Object.freeze({
      kind: 'flag',
      flag: '--reasoning-effort',
      values: Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
    }),

    images: null,
    provider: null,
    session: null,
    // TOKEN-BUDGET-01 — BAĞLAM KAPSAMI: bu motorun kendi belge enjeksiyonunu
    // (proje talimatı zinciri + kalıcı hafıza indeksi) ÇALIŞMA ALANIYLA sınırlayan
    // bir taşıyıcı ÖLÇÜLMEDİ. `null` = bugünkü davranış aynen sürer; kesim yalnız
    // beyan eden motorda uygulanır (paneContextScope HEPSİ-YA-HİÇ kuralı).
    contextScope: null,
    subagentBlock: null,
    trust: null,
    reset: null,
    tui: null,
    mcp: null,
    hooks: null,
    extraRoots: null,
    skillsDir: null,
    identityEnv: null,

    // ─── 4. KAPI — HESAP: ABONELİK BİRİNCİL, ürün akışı SÜREMİYOR ────────────
    // ÖLÇÜLDÜ (02-muse-subcommand-help.txt): `muse login` → "Log in with your Meta
    // account: approve a code in your browser. META_API_KEY always takes priority
    // over the account login." · `muse logout` → "Remove the saved Meta credential".
    // Durum/whoami komutu YOK (komut listesi: resume|exec|config|export|trace|skills|
    // sandbox|schema|serve|session-message|auth|login|logout|init).
    //
    // 🔴 `flow:'external'` ve `loginArgv:null` — NİÇİN: giriş tarayıcıda bir KOD
    // onayı ile bitiyor ve ürün o akışı SÜRMÜYOR (kod kutusu çizip kullanıcıyı
    // sürülemeyen bir akışa göndermek ENG-08\'in kapattığı yalan). `muse login`
    // GERÇEK bir komut ama akışın şekli (kod stdin\'e mi akıyor, callback mı)
    // ölçülmedi → uydurulmaz; kullanıcı komutu `accountHint`te GÖRÜR.
    auth: Object.freeze({
      label: 'Muse Code',
      accountHint:
        'Meta Model API hesabı + ödeme yöntemi ZORUNLU (ücretsiz katman YOK). Abonelik BİRİNCİL yol: Everyday $5/ay · High $15 · Power $50 — abonelik Muse Code CLI için geçerli, jeton faturası çıkmaz. Kurulum: `curl -fsSL https://dev.meta.ai/install.sh | sh`, sonra terminalde `muse login` (tarayıcıda kod onayı). MMA (Meta Managed Account) hesaplarında tarayıcı girişi ÇALIŞMAZ, anahtar zorunludur',
      signupUrl: 'https://dev.meta.ai/docs/muse-code/subscriptions/',
      flow: 'external',
      needsCode: false,
      loginArgv: null,
      logoutArgv: null,
      statusArgv: null,
      statusParse: null,
      statusNote:
        'muse 1.0.3\'te hesap DURUMU/whoami komutu YOK (tam komut listesi ölçüldü: resume|exec|config|export|trace|skills|sandbox|schema|serve|session-message|auth|login|logout|init — 01-muse-help.txt) → rozet ÜÇÜNCÜ durumu gösterir: BİLİNMİYOR. `muse config status` yalnız KURUMSAL yapılandırma düzlemlerini basar (defaults/policy), hesabı DEĞİL (ölçüldü: dört kaynak da state=absent)',
      apiKey: null,
      // 🔑 `noApiKeyNote` — Ayarlar → Hesaplar kartında "Neden API anahtarı kutusu
      // yok?" sorusunun cevabı. EREN KURALI (2026-08-17): abonelik BİRİNCİ SINIF.
      apiKeyNote:
        'Bu motorda anahtar kutusu BİLEREK açılmadı: Eren\'in kararı abonelik yolu ($5 Everyday, ENGINE-MUSE-01) ve abonelik CLI\'ın KENDİSİNİ kapsıyor — anahtar yolu ise jeton-başına faturalanır ($1,25/M girdi · $4,25/M çıktı) ve ürün onu ÖLÇMEDİ. Motorda anahtar yolu GERÇEKTEN var (`META_API_KEY` env — motorun kendi cümlesi: "META_API_KEY always takes priority over the account login" — ve `muse auth set --api-key-stdin`, anahtar argv\'ye ASLA girmiyor). Kutu yalnız iki durumda açılır: (a) hesap bir Meta Managed Account ise (tarayıcı girişi orada çalışmıyor), (b) Eren jeton-başına ödemeyi açıkça seçerse. İkisi de ENGINE-MUSE-03\'ün kararı',
    }),

    usage: null,

    // ─── 3. KAPI — SÜPERVİZÖR OKUMA: TAM ve HESAPSIZ ÖLÇÜLDÜ ────────────────
    // `muse exec --json` → satır-satır JSON (05-echo-exec-json.jsonl, 13 satır):
    // her satırda `schema_version`, `stream{kind:'session',id}`, `sequence`,
    // `record_type` (event|status|reconciliation), `payload_type`
    // (runtime.command.accepted · session.run.linked · turn.input.user ·
    // run.lifecycle.started · task.lifecycle.{proposed,accepted,scheduled,
    // side_effect_intent,started,completed} · run.output.delta ·
    // run.terminal.completed) ve `payload`. Kapanış olayı `run.terminal.completed`
    // → `{terminal:'completed'|…, text, reason}`.
    output: Object.freeze({
      kind: 'jsonl',
      flag: '--json',
      values: null, // bayrak DEĞER ALMIYOR (boolean) — ölçüldü
      quietFlag: null,
      requiresQuiet: false,
      subcommand: 'exec', // `--json` YALNIZ `muse exec` altında (kök help\'te yok)
      resultEvent: 'run.terminal.completed',
    }),

    install: Object.freeze({
      label: 'Muse Code',
      // ÖLÇÜLDÜ: resmî kurucu (314 satır) OKUNDU ve İZOLE HOME\'da KOŞTURULDU.
      //   ✅ `command_name="muse"` · `install_dir="${MUSE_INSTALL_DIR:-$HOME/.local/bin}"`
      //      → ürünün `augmentedPath`inde ZATEN olan dizin (ADP-707 kuralı).
      //   ✅ launcher `x-content-sha256` başlığıyla DOĞRULANIYOR (varsa) + `bash -n`
      //      söz dizimi kontrolü; indirme `--proto '=https'` ile TLS\'e kilitli.
      //   🟠 YAN ETKİ: PATH satırını `~/.zshrc`/`~/.bashrc`/`~/.profile`/fish conf\'a
      //      EKLİYOR (`MUSE_NO_MODIFY_PATH=1` kapatır — ölçüm turunda kullanıldı).
      //   🟠 İkili İKİ PARÇA: `~/.local/bin/muse` (33 KB launcher) + yanına inen
      //      `muse-bin-<sürüm>` (242 MB) → launcher kendini güncelleyebilir.
      command: 'curl -fsSL https://dev.meta.ai/install.sh | sh',
      // POSIX-only: kurucu `#!/usr/bin/env bash` ve `install.ps1` dengi YOK.
      win32Command: null,
      docsUrl: 'https://dev.meta.ai/docs/muse-code/',
      checkHint: 'https://dev.meta.ai/docs/muse-code/',
      installsTo: '~/.local/bin',
      // 🔑 Bu motorda `--version` ÜRÜN ADINI TAŞIYOR (ölçüldü, 03-muse-version.txt):
      // "Muse Code 1.0.3 (1.0.3-R2198.1)" → gemini/opencode\'daki `--help` dolambacı
      // GEREKMİYOR. Kalıp sürümden bağımsız.
      verifyArgv: Object.freeze(['--version']),
      verifyPattern: 'Muse\\s+Code\\s+\\d',
    }),

    unsupported: Object.freeze({
      contextScope:
        'bu motorun kendi belge enjeksiyonunu (proje talimatı zinciri + kalıcı hafıza indeksi) çalışma alanıyla sınırlayan bir taşıyıcı ÖLÇÜLMEDİ — kesim yalnız beyan eden motorda koşar, burada bugünkü davranış aynen sürer (TOKEN-BUDGET-01)',
      identity:
        '🔴 KAYDIN ÇALIŞTIRMAYA KAPALI OLMASININ BİRİNCİ SEBEBİ. İKİ taşıyıcı ADAYI ölçüldü ama İKİSİNİN DE semantiği ölçülemedi: (a) `--agents <JSON>` — "Supply one ephemeral agent-definition overlay"; ikilinin şemasında ajan tanımı alanları da okundu (name/description/prompt/tools/disallowed_tools/model/effort/permission_mode/max_turns/background/isolation/skills/mcp_servers/hooks/memory) → pane BAŞINA argv ile kimlik VERİLEBİLİR görünüyor; (b) `settings.run.system_prompt` + `settings.run.developer_prompt` ayar anahtarları. Hiçbiri EKLİYOR mu (ADDITIVE) YERİNE Mİ geçiyor (REPLACE) sorusunu cevaplamıyor: `--provider echo` turu sistem prompt\'unu yayınlamıyor, `meta` sağlayıcısı ise ödeme yöntemi olmadan koşmuyor. Ölçülmemiş bir REPLACE taşıyıcısını açmak gemini\'nin ENG-14\'te ölçülen felaketidir (efektif prompt 25.073 → 2.126 karakter) → alan null, fail-closed. Ölçüm ENGINE-MUSE-03: "Eren girişi bekliyor"',
      images:
        'bayrak GERÇEKTEN var (`--image <PATH>` kökte, `exec` altında "repeatable") ama tek bir görsel turu bile koşulmadı (hesap duvarı) → ürün "bu pane\'e görsel gönderilebilir" DEMEZ; `imageAttach` tarafında da kapalı. Ölçülünce açılır',
      provider:
        'BYOK grameri bu motorda ürünün `providers.cjs` sözleşmesiyle EŞLEŞMİYOR: `--provider <MODE>` yalnız İKİ değer alıyor (`echo` | `meta`, ölçüldü) — yani üçüncü-taraf uç seçimi değil, motorun kendi sağlayıcı kipi. `--base-url` ile Meta ucu değiştirilebiliyor ama bu SAĞLAYICI değil UÇ değişimidir (gemini/antigravity ile aynı sınır). İkilide ANTHROPIC_/OPENAI_/OPENROUTER_ anahtar adları geçiyor ama hangi yolda kullanıldığı ÖLÇÜLMEDİ → uydurulmaz',
      session:
        'oturum yüzeyi ZENGİN ve ölçüldü (`muse exec --session-id <UUID>` · `muse resume [--last|<uuid>]` · JSONL akışının HER satırında `stream{kind:"session",id}`) ama GERÇEK bir devam (resume) turu koşulmadı: kimliğin/araçların resume\'da yeniden okunup okunmadığı bilinmiyor. Ürün oturum kimliğini BASACAKSA bunu ölçmeden yapamaz (ENG-02 dersi) → alan null, kanal beyanı `partial` değil `unsupported`',
      subagentBlock:
        '🔴 KAYDIN ÇALIŞTIRMAYA KAPALI OLMASININ İKİNCİ SEBEBİ. Motor alt-ajan mimarisi TAŞIYOR (ikili şemasında `subagent_delegation_mode`, `agents.execution_capacity`, `max_child_steps`, `main_session_selection`; yardım metninde `--subagent-worktree-isolation` ve `muse session-message` — oturumlar arası mesajlaşma) ama SERT kapatma yolu ölçülmedi: ölçülen tek bayrak İZOLASYON, kapatma DEĞİL. CrewPane\'te alt-ajan ürün kuralıyla yasaktır (ADR-004: her iş görünür bir pane\'de) → ölçülmemiş blok, olmayan bir korumayı VAR sanmaktır. Bu alan null kaldığı sürece motora ENG-19 LİDER rolü de verilemez',
      trust:
        'çalışma dizini GÜVEN kapısı VAR gibi görünüyor (`--trust-workspace  Trust this workspace for this run (load its skills and rules); does not save trust` + `--yolo` içinde güven) ama ürünün beklediği şey bunun TERSİ: güvenilmeyen kökte motorun DURMASI. Kapının varsayılan davranışı (güvensiz kökte ne oluyor?) koşturulmadı → beyan edilemez',
      reset:
        'pane RESET slash komutu gerçek TUI oturumunda ölçülmedi (bu tur tamamen headless koştu; TUI ilk koşuda hesap duvarına çıkıyor) → var olmayan bir komut göndermek pane\'e sessizce metin yazardı',
      tui:
        'TUI hazır/blocker dizeleri GERÇEK pane\'de ölçülmedi (interaktif ilk koşu giriş/ödeme duvarına çıkıyor) → `paneReadiness` regex\'i YOK; motor açıldığında sabit boot bütçesiyle beklenir',
      mcp:
        'ARAÇ BAĞLAMA YÜZEYİ VAR ama GRAMERİ ÖLÇÜLMEDİ: ikilinin ayar şemasında `mcpServers`/`mcp_servers` anahtarı ve sunucu alanları (transport/command/env/framing/url/headers) okundu, ayrıca `settings.mcp_servers.<id>` yolu ve proje düzeyinde `.mcp.json` dizesi var (06-settings-keys.txt). Ama (a) ayar belgesinin DİSKTEKİ yolu, (b) pane BAŞINA ayrılabilir olup olmadığı (XDG_CONFIG_HOME/XDG_DATA_HOME ikilide geçiyor, ama muse ağacını GERÇEKTEN taşıdığı ölçülmedi), (c) sunucunun bağlandığının kanıtı — üçü de yok. Yanlış yere yazılan bir belge pane\'i ARAÇSIZ açar ve kimse sebebini bilmez (ENG-17 dersi)',
      hooks:
        'hook yüzeyi ikilinin şemasında VAR (`hooks`, `managed_hooks_path`, `managed_hooks_env_vars`, `max_consecutive_stop_hook_continuations`, `session_start`/`user_prompt_submit` olay adları) ama per-launch BAYRAK yok ve gerçek bir kanca koşturulmadı → ADP-692 tur-başı brifingi bu motorda argv ile KURULAMAZ',
      extraRoots:
        'ek çalışma kökü bayrağı YOK: ölçülen tam seçenek listesinde `--add-dir` dengi bulunmuyor; `--workspace <PATH>` TEK bir kök belirliyor (ek kök değil, kökün KENDİSİ) ve `-w/--worktree` git worktree açıyor — ikisi de "birden çok kök" anlamına gelmez',
      skillsDir:
        'skill YÜZEYİ zengin (`muse skills list|install|import --from claude|codex` — kaynak sınıfları user|project|built-in|plugin) ama keşif DİZİNİ ölçülmedi: kurulum ağacında `~/.local/share/muse/skills` oluştu, ancak ürünün skill\'lerini oraya yazması pane BAŞINA izolasyon gerektirir ve o env (madde: identityEnv) yok. Uydurma bir yol skill\'leri sessizce görünmez yapardı',
      identityEnv:
        '🔴 PANE BAŞINA HESAP/PROFİL AYRIMI ÖLÇÜLMEDİ: motorun ev dizinini taşıyan ÖZEL bir env (FACTORY_HOME_OVERRIDE / CODEX_HOME dengi) ikili dizelerinde BULUNAMADI. Ölçülen tek adaylar genel `XDG_CONFIG_HOME`/`XDG_DATA_HOME`; kimlik defterinin (`muse login` sonrası) GERÇEKTEN oraya taşındığı doğrulanmadı — doğrulanmadan iki pane\'e iki hesap verilemez ve verilmiş SAYILAMAZ',
      usage:
        'jeton/maliyet defteri ÖLÇÜLMEDİ: `--no-session-log` bayrağı ve `MUSE_SESSIONS`/`MUSE_CURRENT_SESSION_LOG` env adları defterin VARLIĞINI gösteriyor, `muse export` de tam bir oturum belgesi üretiyor (export_schema_version 1) — ama gerçek bir MODEL turu koşulmadığı için defterde jeton alanı olup olmadığı bilinmiyor. `echo` sağlayıcısı jeton harcamıyor → sayaç UYDURULAMAZ; kart "bilinmiyor" der',
    }),

    partial: Object.freeze({
      model:
        'bayrak ölçüldü (`--model <MODEL>`, kök + `exec`) ama MODEL ADLARI bilinmiyor: motorun model kataloğu hesap ister (`muse` model listesi komutu yok; katalog satırları `ConfigCatalogRow` ile SUNUCUDAN geliyor) → ürün seçici bu motorda serbest metin gösterir, liste GÖSTEREMEZ',
      effort:
        'enum ikilinin KENDİ yardım metninden alındı (8 değer + varsayılan `high`) ama hiçbir değer GERÇEK bir turda denenmedi (hesap duvarı) → geçersiz değerin turu nasıl öldürdüğü codex\'teki gibi ÖLÇÜLMÜŞ değil; beyaz liste yine de ZORUNLU (şema kuralı)',
      output:
        'akış TAM ölçüldü ama `--provider echo` ile: gerçek bir MODEL turunda ek olay tipleri (araç çağrısı, onay, jeton) çıkabilir. Ölçülen 13 satırın şekli (`schema_version`+`stream`+`sequence`+`record_type`+`payload_type`+`payload`) sağlayıcıdan bağımsız zarf olduğu için süpervizör ayrıştırıcısı bunun üstüne yazılabilir; kapanış olayı `run.terminal.completed` doğrulandı',
      install:
        'kurulum GERÇEKTEN yapıldı ve ürün kimliği `--version` ile kanıtlandı; ama iki takip kalemi var: (a) launcher kendini güncelleyebiliyor → ölçülen sürüm (1.0.3-R2198.1) sabitlenemez, (b) kurucu kabuk profil dosyalarına PATH satırı ekliyor (ürün için gereksiz; `MUSE_NO_MODIFY_PATH=1` ile kapatılabilir ama satıcının KENDİ komutunu göstermek doğru olan)',
      auth:
        'giriş/çıkış komutları ve anahtar önceliği motorun KENDİ yardım metninden ölçüldü, ama hiçbiri KOŞTURULMADI: `muse login` tarayıcı açıyor ve ödeme yöntemi olmayan hesapta duvara çıkıyor (ENGINE-MUSE-01 §1) → "Eren girişi bekliyor". Ürün bu yüzden akışı SÜRMÜYOR (`flow:"external"`), yalnız komutu ve adımları METİN olarak gösteriyor',
    }),

    verification: Object.freeze({
      contextScope: Object.freeze({ channel: 'unverified', source: 'TOKEN-BUDGET-01 — bu motorda belge-enjeksiyonunu kapatan bir bayrak ARANMADI/ÖLÇÜLMEDİ; kesim yalnız beyan eden motorda koşar' }),
      identity: Object.freeze({ channel: 'unverified', source: 'ENGINE-MUSE-02-evidence/01-muse-help.txt + 06-settings-keys.txt — taşıyıcı ADAYLARI (`--agents <JSON>`, settings.run.system_prompt) görüldü; ADDITIVE/REPLACE semantiği ÖLÇÜLEMEDİ (hesap duvarı) → alan null' }),
      model: Object.freeze({ channel: 'measured', source: 'ENGINE-MUSE-02-evidence/01-muse-help.txt + 02-muse-subcommand-help.txt — `--model <MODEL>  Model id for non-echo providers` (kök) ve `--model <ID>` (exec)' }),
      effort: Object.freeze({ channel: 'measured', source: 'ENGINE-MUSE-02-evidence/01-muse-help.txt — `--reasoning-effort <EFFORT>  Meta reasoning effort: none|minimal|low|medium|high|xhigh|max|ultra (default: high)`' }),
      images: Object.freeze({ channel: 'unverified', source: '`--image <PATH>` yardım metninde VAR ama tek bir görsel turu koşulmadı (01-muse-help.txt) → alan null' }),
      provider: Object.freeze({ channel: 'measured', source: 'ENGINE-MUSE-02-evidence/01-muse-help.txt — `--provider <MODE>  Startup provider: echo or meta (default: meta)`: ürünün BYOK grameriyle eşleşmiyor' }),
      session: Object.freeze({ channel: 'unverified', source: 'yüzey ölçüldü (`--session-id`, `muse resume --last|<uuid>`, JSONL `stream.id`) ama GERÇEK resume turu koşulmadı → alan null' }),
      subagentBlock: Object.freeze({ channel: 'unverified', source: '06-settings-keys.txt — `subagent_delegation_mode`/`agents.execution_capacity` VAR, SERT kapatma yolu koşturulmadı → alan null (ENG-19 lider kapısı kapalı)' }),
      trust: Object.freeze({ channel: 'unverified', source: '`--trust-workspace` bayrağı görüldü; güvensiz kökte motorun DURUP durmadığı ölçülmedi' }),
      reset: Object.freeze({ channel: 'unverified', source: 'TUI açılmadı (tur headless; interaktif ilk koşu hesap duvarına çıkıyor)' }),
      tui: Object.freeze({ channel: 'unverified', source: 'TUI açılmadı → paneReadiness sinyali ölçülmedi' }),
      mcp: Object.freeze({ channel: 'unverified', source: '06-settings-keys.txt — `settings.mcp_servers.<id>` + `mcpServers` + sunucu alanları (transport/command/env/framing/url/headers) okundu; belgenin YOLU ve pane-başına ayrılabilirliği ölçülmedi → alan null' }),
      hooks: Object.freeze({ channel: 'unverified', source: 'ikili şemasında `hooks`/`managed_hooks_path`/`session_start` var; per-launch bayrak yok, kanca koşturulmadı' }),
      extraRoots: Object.freeze({ channel: 'measured', source: 'ENGINE-MUSE-02-evidence/01-muse-help.txt — tam seçenek listesinde `--add-dir` dengi YOK; `--workspace <PATH>` TEK kök belirliyor' }),
      skillsDir: Object.freeze({ channel: 'unverified', source: '`muse skills --help` (02-…) kaynak sınıflarını veriyor; keşif DİZİNİ ve pane-başına yazılabilirlik ölçülmedi' }),
      identityEnv: Object.freeze({ channel: 'measured', source: 'ikili dizelerinde MUSE_* env envanteri tarandı: ev-dizini/config taşıyan ÖZEL env YOK (yalnız MUSE_SESSIONS/MUSE_CURRENT_SESSION_LOG/MUSE_MODEL + genel XDG_CONFIG_HOME/XDG_DATA_HOME); muse ağacının XDG ile GERÇEKTEN taşındığı doğrulanmadı → alan null' }),
      auth: Object.freeze({ channel: 'measured', source: 'ENGINE-MUSE-02-evidence/02-muse-subcommand-help.txt — `muse login` ("approve a code in your browser", "META_API_KEY always takes priority"), `muse logout`, `muse auth set --api-key-stdin` ("never taken as a command-line argument"); durum/whoami komutu komut listesinde YOK. Abonelik kanıtı: ENGINE-MUSE-01 §4 K1/K2 (resmî belge, kanal doc)' }),
      usage: Object.freeze({ channel: 'unverified', source: 'defterin VARLIĞI görüldü (`--no-session-log`, MUSE_SESSIONS, `muse export`) ama jeton alanı gerçek turda ölçülmedi → alan null' }),
      output: Object.freeze({ channel: 'measured', source: 'ENGINE-MUSE-02-evidence/05-echo-exec-json.jsonl — HESAPSIZ gerçek koşu (`muse exec --provider echo --json`), 13 satır JSONL; kapanış `run.terminal.completed` {terminal,text,reason}' }),
      install: Object.freeze({ channel: 'measured', source: 'resmî kurucu okundu (314 satır: MUSE_INSTALL_DIR/MUSE_NO_MODIFY_PATH, x-content-sha256 doğrulaması, `bash -n`) + İZOLE HOME\'da GERÇEKTEN kuruldu → `muse --version` = "Muse Code 1.0.3 (1.0.3-R2198.1)" (03-muse-version.txt, 04-muse-release-info.json)' }),
    }),
});
