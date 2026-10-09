'use strict';

module.exports = Object.freeze({
    id: 'antigravity',
    label: 'Antigravity CLI',
    // 🪤 SİTE KİMLİĞİ ≠ İKİLİ ADI (ENG-18 D2): kurucu ikiliyi `~/.local/bin/agy`
    // adıyla koyar (arşivdeki dosya adı `antigravity`). ALLOWED_COMMANDS anahtarı
    // İKİLİNİN adı olmak zorunda — yoksa spawn "disallowed command" ile ölür.
    bin: 'agy',

    // ENG-20 paritesi: onay sorusu akışı keser. ÖLÇÜLDÜ (aşağıda) — bayraksız
    // headless koşu aracı OTO-REDDEDİYOR (asılmıyor, sessizce de geçmiyor).
    defaultArgs: Object.freeze(['--dangerously-skip-permissions']),

    autonomy: Object.freeze({
      level: 'full',
      via: 'argv',
      flags: Object.freeze(['--dangerously-skip-permissions']),
      measured:
        'ENG-22 CANLI, İKİ YÖNLÜ: (a) bayraksız `-p "dosya oluştur"` → motorun KENDİ cümlesi "a tool required the \'command\' permission that headless mode cannot prompt for, so it was auto-denied … re-run with --dangerously-skip-permissions", dosya OLUŞMADI ve zarf `status:SUCCESS` + BOŞ response döndü (süpervizör tuzağı: başarı gibi görünür). (b) bayrakla AYNI istek → `write_to_file` koştu, dosya diskte, içerik "YOLO-OK"; stream-json init olayı `"permission_mode":"always-proceed"` yazdı',
      why:
        'Eren kararı 2026-08-18 (claude paritesi). AGY-02 İZİN MERDİVENİNİ ÖLÇTÜ (ANTIGRAVITY-R1 §7-R5 bu kartı açmıştı) ve DAHA DAR ÇALIŞAN BİR ARGV KİPİ BULUNMADI — bayrak SPEKÜLASYONLA değil ölçümle duruyor. Altı kol, aynı demet/model, tek değişken izin bayrağı (kanıt: AGY-02-evidence/02): bayraksız · `--mode accept-edits` · `--mode plan` · `--sandbox` (tek başına) → DÖRDÜNDE de MCP aracı çağrılmadan OTO-REDDEDİLDİ (motorun cümlesi: "a tool required the \'mcp\' permission that headless mode cannot prompt for"), yani pane araçsız = işe yaramaz. `--dangerously-skip-permissions` → araç çağrıldı. `--dangerously-skip-permissions --sandbox` → araç yine çağrıldı AMA `--sandbox` ÖLÇÜLEBİLİR HİÇBİR ŞEYİ DARALTMADI: sandbox\'lı kolda da kabuk komutu koştu, çalışma alanı içine VE dışına (`/private/tmp/…`) dosya yazıldı. Sahte bir güvenlik iddiası doğuracağı için alınmadı. Motorun işaret ettiği GERÇEKTEN dar yol (`permissions.allow: ["mcp(…)"]`) PANE BAŞINA KURULAMIYOR: `settings.json` çalışma alanından okunmuyor (üç yerleşim denendi — `<ws>/.agents/`, `<ws>/`, plugin kökü `.agents/` → üçünde de RED) ve motorun kendi changelog\'una göre yalnız `~/.gemini/antigravity-cli/settings.json` + `~/.gemini/config/projects/` okunuyor; oraya yazmak AGY-01\'in tam da reddettiği KULLANICI CONFIG\'İ KİRLENMESİ olurdu (iki pane tek belgeye yazar). ⇒ Bugünkü tek kol doğru koldur; daraltma AGY-03\'ün hook kapısına düşer (yerleşik araç ADLARI hook\'ta matcher ile kapatılabilir — MCP araçları `call_mcp_tool` altında olduğu için DEĞİL, R1 §2.2)',
    }),

    // ─── 1. KAPI — KİMLİK: BAYRAK → DİZİN → MOTORUN DAYATTIĞI DOSYA ADI ────
    //
    // ENG-22 reçeteyi ÖLÇMÜŞ ama "bu şekil `identity.kind` enum'unda YOK" diyerek
    // alanı `null` bırakmıştı (fail-closed, doğru karardı). ENG-ENABLE-01 eksik
    // olan grameri EKLEDİ (`kind:'flag-dir'`, agentRunner.withIdentity) ve reçeteyi
    // agy 1.1.28'de YENİDEN ölçtü (hüküm bir tarihtir, bkz. hafıza notu):
    //   • `--add-dir <dizin>`/`AGENTS.md` → kimlik modele ULAŞTI (kod kelimesi DELTA5)
    //     ve motor ABONELİKLE koştu (anahtar YOK — `antigravity-oauth-token` var).
    //   • 🪤 TEK BAYRAKLA ARAÇLARIN cwd'Sİ KİMLİK DİZİNİNE KAYDI: ajanın `pwd`
    //     çıktısı kimlik dizini oldu — yani ajan doğru kimlikle YANLIŞ dizinde koşar.
    //   • DÜZELTME ÖLÇÜLDÜ: iş dizini ÖNCE verilince (`--add-dir <cwd> --add-dir
    //     <kimlik>`) `pwd` = iş dizini VE kimlik hâlâ okundu.
    // `cwdFirst` bu ölçülmüş sırayı BEYAN eder; ürün sırayı uydurmaz.
    identity: Object.freeze({
      kind: 'flag-dir',
      flag: '--add-dir',
      position: 'append',
      fileName: 'AGENTS.md', // ad MOTORUN dayatması: `crewpane-identity.md` OKUNMADI (ENG-22)
      fileSuffix: '.md',
      cap: Object.freeze({ cli: null, file: 'FILE_MAX' }),
      resumeReinject: false,
      replacesSystemPrompt: false, // ENG-22: taban KORUNDU (11.512 → 11.824 jeton) ⇒ ADDITIVE
      cwdFirst: true, // 🔴 ZORUNLU: ilk `--add-dir` araçların cwd'sini belirliyor
    }),

    model: Object.freeze({
      kind: 'flag',
      flag: '--model',
      position: 'append',
      // ENG-22 (agy 1.1.14) ölçümü: `agy models` → gemini-3.1-pro-preview |
      // gemini-3.5-flash | gemini-3.6-flash | gemini-3.7-flash.
      // AGY-05 (agy 1.2.2, 2026-09-14) TEKRAR ÖLÇTÜ — liste 14 SATIR ve BAŞKA:
      // gemini-3.8/3.7/3.6-flash-{high,medium,low} · gemini-3.1-pro-{high,low} ·
      // claude-sonnet-4-6 · claude-opus-4-6-thinking · gpt-oss-120b-medium.
      // (R1 §3.1 "15 satır" der; ölçülen 15 STDOUT satırının biri "Fetching
      // available models..." başlığıdır → MODEL satırı 14.)
      // 🪤 Varsayılan model ücretsiz katmanda KOŞMUYOR: gemini-3.1-pro için kota
      // "limit: 0" (429) → model SEÇİLMEDEN anahtar yolu ilk turda ölür.
      detect: null,
      // AGY-05 — "HANGİ modeller" listesinin adresi (claude/codex ile AYNI desen).
      // 🪤 Liste `agy models`ten CANLI okunMAZ: çıktı SONEKLİ ad verir (efor ada
      // gömülü) ve o adla efor birleşince pane ölür; katalog ÇIPLAK aile adı tutar.
      catalog: 'electron/modelCatalog.cjs',
    }),

    images: null,
    provider: null,

    // OTURUM — kimliği MOTOR basar ama HER ZARFTA SÖYLER: `-o json` sonucu ve
    // stream-json'un init/step/result olaylarının hepsinde `conversation_id`.
    session: Object.freeze({
      mint: null,
      flag: null,
      killSwitchEnv: null,
      resume: Object.freeze({
        form: 'append',
        flag: '--conversation',
        idShape: 'engine-minted',
        idFrom: 'output', // 🔑 id ÇIKTIDA yayınlanıyor → süpervizör eşlemesi KESİN olabilir
        idField: 'conversation_id',
        lastFallback: Object.freeze(['--continue']),
      }),
    }),

    // TOKEN-BUDGET-01 — BAĞLAM KAPSAMI: bu motorun kendi belge enjeksiyonunu
    // (proje talimatı zinciri + kalıcı hafıza indeksi) ÇALIŞMA ALANIYLA sınırlayan
    // bir taşıyıcı ÖLÇÜLMEDİ. `null` = bugünkü davranış aynen sürer; kesim yalnız
    // beyan eden motorda uygulanır (paneContextScope HEPSİ-YA-HİÇ kuralı).
    contextScope: null,

    // ─── ADR-004 SERT KATMANI — ARGV'DE DEĞİL, HOOK'TA ───────────────────────────
    //
    // ⏪ ESKİ HÜKÜM (ENG-22): `null` — "alt-ajan araçları VAR ama kapatma yolu
    //    ÖLÇÜLMEDİ; ölçülmemiş blok, olmayan bir korumayı VAR sanmaktır" → bu motora
    //    LİDER rolü verilemezdi.
    //
    // 🟢 YENİ HÜKÜM (AGY-03, agy 1.2.2 — GERÇEK turda, KONTROL KOLLU):
    //    `hooks.json` → `PreToolUse` → `{"decision":"deny"}` kapısı ÇALIŞIYOR.
    //      • hook AÇIK  : `invoke_subagent` adımı `state:"ERROR"` oldu ve modelin
    //                     cevabına BİZİM gerekçemiz düştü ("tool call denied by
    //                     pre-tool hook: CrewPane: …").
    //      • hook KAPALI (`enabled:false`, tek değişken): alt-ajan AÇILDI
    //                     (`ALTAJAN=BASARILI`) — yani blok gerçekten BİZİM.
    //    Kanıt: AGY-03-evidence/{01-run-hooks-on,02-run-control-arm}.
    //
    // 🪤 TAŞIYICI ARGV DEĞİL: claude'da blok bir bayraktır (`--disallowedTools Task`)
    //    ve `subagentBlockArgs` onu argv'ye basar. Burada argv dengi YOKTUR; blok
    //    demetin `hooks.json`una yazılır. `via` bunu SÖYLER ki `subagentBlockArgs`
    //    boş dönsün ve kimse "bayrak nerede" diye aramasın (kimi motorunun
    //    `identity-frontmatter` yolundaki AYNI desen).
    subagentBlock: Object.freeze({
      via: 'workspace-plugin-hook',
      event: 'PreToolUse',
      decision: 'deny',
      // Blok edilen YERLEŞİK araçlar + dolaylı yolun tek adı; regex `matcher` ve
      // gövde süzgeci `electron/agyHooks.cjs`te (ikinci bir liste = ikinci gerçek).
      toolsModule: 'electron/agyHooks.cjs',
      measuredVersion: '1.2.2',
    }),

    trust: null,
    reset: null,
    tui: null,

    // ─── 2. KAPI — ARAÇ BAĞLAMA: ÇALIŞMA-ALANI PLUGIN DEMETİ (PANE BAŞINA) ────
    //
    // ⏪ ESKİ HÜKÜM (ENG-22, agy 1.1.14): `kind:'config-only'` —
    //    `$HOME/.gemini/config/mcp_config.json` tek ve PAYLAŞIMLI dosya, pane
    //    başına kayıt YOK, kullanıcının config'i kirlenir. Bu yüzden antigravity
    //    LİDER olamıyordu (`leaderDelegationStatus` gerekçesi birebir buydu).
    //
    // 🟢 YENİ HÜKÜM (AGY-01, agy 1.2.2 — ANTIGRAVITY-R1 §0-3 + bu kartın ölçümü):
    //    sınır KALKTI. Motor artık çalışma alanında `.agents/plugins/<ad>/`
    //    demetlerini keşfediyor ve demet KENDİ `mcp_config.json`unu taşıyor.
    //    Ürün demeti pane başına ÜRETİR (`electron/agyWorkspacePlugin.cjs`) ve
    //    kökü `--add-dir` ile verir.
    //
    // ── ÖLÇÜM (2026-09-14, agy 1.2.2; kanıt: AGY-01-evidence/) — ÜÇ KOL ────────
    //   • Kol C (R1 tabanı) `.agents/` cwd'nin İÇİNDE  → sunucu SPAWN + araç ÇAĞRILDI
    //   • Kol A (KARAR)     `.agents/` cwd'nin DIŞINDA, 2. `--add-dir` kökünde
    //                        → sunucu SPAWN + araç ÇAĞRILDI **ve `pwd` İŞ KÖKÜ kaldı**
    //   • Kol B (KONTROL)   aynı cwd, plugin kökü VERİLMEDİ → sunucu spawn OLMADI
    //   ⇒ keşif `--add-dir` KÖKÜNE bağlı ⇒ kullanıcının reposuna dosya bırakılmaz
    //     (R8 kapandı: repo içi `.agents/` + `.git/info/exclude` yolu GEREKMİYOR).
    //
    // 🪤 ÜÇ TUZAK — üçü de ölçüldü:
    //   (a) `agy mcp list` / `agy plugin list` bu kaydı GÖSTERMEZ: liste komutları
    //       yalnız config dosyalarını okur, keşif AJAN ÇALIŞMA ZAMANINDA olur.
    //       Listenin BOŞ kalması ARIZA DEĞİL, global kirlenmenin YOK kanıtıdır.
    //   (b) Sunucunun cwd'si PLUGIN DİZİNİDİR (süreç cwd'si değil) → sunucu yolları
    //       MUTLAK yazılır; göreli yol plugin dizinine çözülürdü.
    //   (c) Araçlar modele TEK TEK görünmüyor; hepsi jenerik `call_mcp_tool`
    //       üzerinden gidiyor ⇒ araç ADINA dayalı ince taneli kapı KURULAMAZ (AGY-03).
    mcp: Object.freeze({
      kind: 'workspace-plugin',
      // Motorun DAYATTIĞI demet yolu ve dosya adları (agy-customizations/docs/plugins.md).
      pluginPath: '.agents/plugins',
      pluginName: 'crewpane',
      files: Object.freeze({ manifest: 'plugin.json', mcpConfig: 'mcp_config.json', hooks: 'hooks.json' }),
      field: 'mcpServers',
      // Kök motora BU bayrakla verilir — kimlik taşıyıcısıyla AYNI bayrak (`--add-dir`),
      // ama AYRI bir dizin: her kapı kendi sink'ini yazar (kimlik `engine-identity/`,
      // demet `engine-plugins/`), böylece biri düşerse öteki ayakta kalır.
      rootFlag: '--add-dir',
      allowFlag: null, // ölçüldü: seçme/filtreleme bayrağı YOK
      // ⏪ AGY-01 (fail-closed TAHMİN): "config'in KENDİ `env` bloğu çocuğa GEÇTİ
      //    (ölçüldü); pane env MİRASI ÖLÇÜLMEDİ ⇒ `false`". Ölçülmemişi `false`
      //    saymak doğru karardı — ama bir HÜKÜM değil, bir TARİHTİ.
      //
      // 🟢 AGY-02 ÖLÇTÜ (agy 1.2.2; kanıt: AGY-02-evidence/01) — MİRAS VAR:
      //    sonda MCP sunucusunun `mcp_config.json` env bloğunda YALNIZ `CFG` işareti
      //    varken, süreç ebeveynin env'indeki `PANE` işaretini de GÖRDÜ
      //    (`PANE=PANE-yolo CFG=CFG-yolo … ENVCOUNT=63`) ve demete HİÇ yazılmamış
      //    `CREWPANE_ACCOUNT` / `CREWPANE_BRIDGE_*` değerleri de ulaştı.
      //    ⇒ Antigravity bu yönden claude gibidir, codex gibi DEĞİL.
      //
      // 🪤 BU BAYRAK TEK BAŞINA ENTEGRASYON KAPISINI AÇMAZ — ve açmamalı.
      //    `mcpCanCarrySecrets` taşıyıcının `config-file` olmasını DA ister; bu kayıt
      //    `workspace-plugin`. Kapıyı yalnız bu bayrakla açmak, sırrı pane env'ine
      //    yazıp ARDINDAN hiçbir sunucu kaydetmemek olurdu (`withIntegrationsMcp`
      //    hazır bir config DOSYASI yolu verir, bu taşıyıcı onu ifade edemez →
      //    katkı BOŞ döner): rozet "entegrasyon var" derken pane'de araç OLMAZDI.
      //    Yalan rozet, olmayan rozetten kötüdür ⇒ kapı KAPALI, gerekçe DÜRÜST
      //    (paneCapabilityMatrix.refineIntegrations `workspace-plugin` dalı).
      // 🔒 Dosya 0600 ve `<crewpaneHome>` altında — argv'ye/ps çıktısına SIR yazılmaz.
      envInheritance: true,
      position: null,
      // Bu kaydın ölçüldüğü motor sürümü — AGY-06 sürüm kapısının damgası (R1 §6-1).
      measuredVersion: '1.2.2',
    }),

    // ─── HOOK YÜZEYİ — PER-LAUNCH BAYRAK YOK, TAŞIYICI DEMETTİR ─────────────────
    //
    // ⏪ ESKİ HÜKÜM (ENG-22): `null` — "(a) per-launch BAYRAK yok, (b) `hooks.json`un
    //    yeri ÇALIŞMA KÖKÜ → ADP-692 tur brifingi bu motorda argv ile KURULAMAZ".
    //    (a) hâlâ doğru; (b) YANLIŞ ÇIKTI: `hooks.json` demetin İÇİNDE de okunuyor
    //    (`plugins/<ad>/hooks.json`, motorun kendi belgesi + AGY-03 gerçek turu) ⇒
    //    kullanıcının repo'suna yazmak GEREKMİYOR, kök zaten `--add-dir` ile veriliyor.
    //
    // Yani bayrak yokluğu brifingi engellemiyor: taşıyıcı AGY-01 demetidir.
    // `carrier` alanı bunu SÖYLER — `withTurnBriefing` (claude yolu, `flag` arar)
    // bu motorda NO-OP kalır, `withAgyHooks` devralır.
    hooks: Object.freeze({
      carrier: 'workspace-plugin',
      file: 'hooks.json',
      hookName: 'crewpane',
      // 🪤 ÖLÇÜLDÜ: `PreInvocation` TUR başına değil MODEL ÇAĞRISI başına ateşler
      // (tek `-p` turunda invocationNum 0,1,2). claude `UserPromptSubmit` tur başına
      // BİR kez ateşler — birebir port brifingi 3 kez bağlama sokardı. Ürün ilk
      // çağrıya kapar (`agyHooks.isFirstInvocation`); alan o kuralın BEYANIDIR.
      preInvocation: Object.freeze({ event: 'PreInvocation', firesPerModelCall: true, shape: 'flat' }),
      // 🪤 ŞEKİL FARKI: `PreToolUse` GRUPLU (matcher + hooks sarmalı), `PreInvocation`
      // DÜZ. Karıştırılırsa kapı sessizce hiç kurulmaz (motor hata vermez).
      preToolUse: Object.freeze({ event: 'PreToolUse', shape: 'grouped', matcherKey: 'matcher' }),
      // 🪤 MCP ÇAĞRISI TEK ADA DÜŞER: hook `call_mcp_tool` görür, gerçek araç adını
      // DEĞİL (R1 §2.2 tahmindi, AGY-03 ÖLÇTÜ). Hedef ad gövdededir:
      // `args.ToolName` / `args.ServerName` ⇒ ince taneli MCP kapısı `matcher` ile
      // DEĞİL, gövdeye bakan hook ile kurulur.
      mcpToolName: 'call_mcp_tool',
      mcpArgFields: Object.freeze({ tool: 'ToolName', server: 'ServerName' }),
      measuredVersion: '1.2.2',
    }),

    // 🔑 ÜÇ İŞİ BİRDEN YAPAN BAYRAK (ölçüldü): (1) ek çalışma kökü, (2) araçların
    // ÇALIŞMA DİZİNİ, (3) kimlik dosyasının okunduğu dizin. Sıra önemli — ayrıntı
    // `partial.extraRoots`te.
    extraRoots: Object.freeze({ flag: '--add-dir', repeat: 'variadic' }),

    skillsDir: null,
    identityEnv: null,

    auth: Object.freeze({
      label: 'Antigravity CLI',
      // ENG-ENABLE-01 (2026-09-09, agy 1.1.28) — ABONELİK YOLU GERÇEK VE ÇALIŞIYOR.
      // Müşteri KaptanZorba'nın cümlesi ("antigravity cli de api key soruyor, cli
      // zaten kurulu, onu görmüyor") bu kaydın ESKİ hâlinin doğrudan sonucuydu:
      // ENG-22 anahtarı BİRİNCİL yol ilan etmişti (o gün ürün OAuth'u SÜREMİYORDU).
      // Bugün ölçüldü: makinede `~/.gemini/antigravity-cli/antigravity-oauth-token`
      // VAR ve motor HİÇBİR anahtar olmadan tam bir tur koştu (kimlik + araç + cevap).
      // 1.1.28 changelog'u da bunu söylüyor: "reading your signed-in identity from
      // the stored credential … the displayed plan tier".
      accountHint:
        'Google hesabıyla giriş (Antigravity aboneliği) — BİRİNCİL yol. Giriş TERMİNALDE yapılır: pane\'de argümansız `agy` çalıştır, tarayıcıda onayla; oturum `~/.gemini/antigravity-cli/` altında saklanır ve CrewPane onu OLDUĞU GİBİ kullanır. Gemini API anahtarı YEDEKtir',
      signupUrl: 'https://antigravity.google/',
      // 🔑 `external`: giriş CrewPane DIŞINDA (ya da pane\'in kendi terminalinde)
      // yapılır — cursor emsali. Ürün akışı SÜRMEZ, yalnız DURUMU okur.
      flow: 'external',
      needsCode: false,
      loginArgv: null, // motorda ayrı bir `login` alt-komutu YOK: argümansız `agy` giriş ekranı açar
      logoutArgv: null,
      externalNote:
        'ÖLÇÜLDÜ (1.1.28): alt-komut listesinde `login`/`logout`/`auth` YOK (agent/agents/changelog/help/install/mcp/mic-serve/models/plugin/plugins/remote-control/update). Giriş, argümansız `agy` çalıştırılınca açılan ekrandan tarayıcıya gidiyor → ürün bu akışı SÜRMEZ; düğme "pane\'de `agy` çalıştır ve giriş yap" der. Oturum HOME\'a çivili olduğu için CrewPane pane\'i kullanıcının mevcut girişini AYNEN görür',
      // 🔑 DURUM KOMUTU YOK ama GİRİŞE BAĞLI, UCUZ ve MODEL TURU HARCAMAYAN bir
      // komut var. İKİ YÖNLÜ ölçüldü (ENG-ENABLE-01-evidence/agy-models-*.txt).
      statusArgv: Object.freeze(['models']),
      statusParse: 'exit-code',
      signedOutPattern: 'please sign in to view available models',
      statusMethodLabel: 'Antigravity (Google hesabı)',
      apiKey: Object.freeze({
        env: 'GEMINI_API_KEY', // ENV ile gider — ARGV'ye ASLA (ENG-R3 §9.3)
        // 🔑 gemini ile AYNI anahtar ama AYRI kasa girdisi: tek kasa girdisi
        // paylaşmak, bir karttan "Anahtarı kaldır" denince ÖTEKİ motorun da
        // sessizce düşmesi demekti (kullanıcı bunu bekleyemez).
        vaultService: 'crewpane-antigravity-api-key',
        keyUrl: 'https://aistudio.google.com/apikey',
        keyLabel: 'Gemini API anahtarı (Google AI Studio)',
        note: '🪤 ANAHTAR TEK BAŞINA YETMEZ (ölçüldü): motor `$HOME/.gemini/antigravity-cli/settings.json` içinde `{"modelProvider":"gemini"}` görmezse anahtarı YOK SAYAR ve tarayıcı girişine düşüp 60 sn asılır. Ayrıca ücretsiz katman kotası MODEL BAŞINA: gemini-3.5-flash için ölçülen sınır günde 20 istek + dakikada 5 (429 "GenerateRequestsPerDayPerProjectPerModel-FreeTier"), gemini-3.1-pro için "limit: 0" (yani ücretsiz katmanda hiç koşmaz). Ölçüm: 2026-08-18.',
      }),
    }),

    // ─── 4. KAPI — KULLANIM: SAYAÇ DEFTERDE DEĞİL, KOŞU ZARFINDA ────────────────
    //
    // ⏪ ESKİ HÜKÜM (ENG-22): `kind:'none'` — "jetonlar ÇIKTIDA TAM ama ürünün defter
    //    okuyucusu 'koşu zarfının içindeki sayaç' şeklini TANIMIYOR". Doğru bir
    //    tarihti: eksik olan motor değil, ÜRÜNÜN GRAMERİYDİ.
    //
    // 🟢 YENİ HÜKÜM (AGY-04, agy 1.2.2): gramer eklendi (`kind:'run-envelope'`,
    //    okuyucu `electron/agyStreamReader.cjs`, adaptör `tokenUsage` içinde).
    //    Sayacı ÜRETEN taraf onu ENJEKTE eder (`opts.runEnvelope`); `tokenUsage`
    //    bu motor için süreç ÇALIŞTIRMAZ — zarfı üretmenin tek yolu bir MODEL TURU
    //    koşturmaktır ve jeton ölçmek için jeton yakmak saçmadır.
    //
    // ── 🔴 KAPSAM SINIRI — ÖLÇÜLDÜ, TAHMİN DEĞİL ────────────────────────────────
    // `--output-format` satıcının KENDİ yardım metninde "Output format for PRINT
    // MODE" diye yazılı (AGY-05-evidence/03-help.txt satır 17) ⇒ zarf YALNIZ
    // headless (`-p`) koşuda vardır. İNTERAKTİF bir pane'de bu motorun jetonu
    // BUGÜN ÖLÇÜLEMEZ ve üç aday kaynağın ÜÇÜ DE ölçülüp ELENDİ (AGY-04):
    //   • hook gövdesindeki `transcriptPath` → `brain/<id>/…/transcript_full.jsonl`:
    //     45 dosyanın hiçbirinde `usage`/`*_tokens` alanı YOK (satır anahtarları:
    //     content · created_at · source · status · step_index · thinking · tool_calls · type)
    //   • `conversations/<id>.db` (sqlite): sayaç varsa BELGESİZ protobuf blob'un
    //     içinde — 5 günde 4 sürüm çıkaran bir ikilide blob ayrıştırmak kırılgan
    //   • `~/.gemini/antigravity-cli/log/cli-*.log`: "token" geçen 39 satırın hepsi
    //     OAuth jetonu, kullanım sayacı YOK
    // ⇒ Rozet interaktif pane'de "bilinmiyor" DEMEYE DEVAM EDER (gerekçe:
    //    'envelope-not-recorded'). Uydurmak yerine susmak bu dosyanın sözleşmesidir.
    usage: Object.freeze({
      kind: 'run-envelope',
      level: 'exact', // sayaç MOTORUN KENDİSİNİN; tahmin/pencere eşlemesi yok
      reader: 'agy-envelope',
      readerModule: 'electron/agyStreamReader.cjs',
      // Zarfın ÖLÇÜLEN alan adları — okuyucu bunları kopyalamaz, BURADAN doğrular.
      envelope: Object.freeze({
        input: 'input_tokens',
        output: 'output_tokens',
        // 🪤 ÖLÇÜLDÜ: `thinking_tokens` ⊂ `output_tokens` (input+output = total,
        // üç zarfta da) ⇒ AYRI KALEM DEĞİL; toplarsak maliyet şişer.
        thinkingSubsetOfOutput: true,
        cacheRead: 'cache_read_tokens',
        total: 'total_tokens',
        cacheWrite: null, // zarfta YOK — 0 yazmak ölçüm değil, alanın yokluğudur
        // 🪤 ÖLÇÜLDÜ: `result.usage` ADIM usage'larının TOPLAMIDIR (13.918+14.285
        // = 28.203) ⇒ ikisi TOPLANMAZ; `result` geldiğinde turun sayacı DEĞİŞİR.
        accumulation: 'result-replaces-steps',
      }),
      // ENG-14 — İÇERİK BEYANI, FAIL-CLOSED: zarfın `usage{}` bloğu SAYAÇtır.
      // Akışın `step_update` olayları konuşma/araç olayı TAŞIR (önizleme oradan
      // geliyor) ama bu DİSKTE PROBLANABİLİR bir defter DEĞİL — yalnız koşarken
      // akar ve hiçbir yere yazılmaz. Teslim doğrulaması (transcriptProbe) bu
      // motorda bir dosya bulamaz ⇒ 'transcript' demek olmayan bir kaynağı VAR
      // saymak olurdu.
      content: 'counters',
      root: '$HOME/.gemini/antigravity-cli/conversations',
      rootEnv: null, // 🔴 defterin yerini taşıyan env YOK — yalnız HOME
      file: null,
      sessionKey: 'conversation_id', // her zarfta (init/step_update/result) VAR
      accumulation: null,
      dedupeBy: 'step_index',
      cost: null, // USD YOK: zarf yalnız jeton sayar (uydurulmaz)
      // AGY-06 sürüm kapısının damgası (R1 §6-1).
      measuredVersion: '1.2.2',
      billing: Object.freeze({
        apiKeyEnv: 'GEMINI_API_KEY',
        configFile: '$HOME/.gemini/antigravity-cli/settings.json',
        field: 'modelProvider',
        planField: null,
        // ENG-ENABLE-01 — kural DEĞİŞMEDİ ama GEREKÇESİ düzeltildi: `modelProvider`
        // YAZILIYSA fatura anahtardadır (hiçbir değer aboneliğe eşlenmez → 'never').
        // Alan HİÇ YOKSA (abonelikle koşan makinenin ölçülen hâli) çözümleyici
        // 'unknown' der — bu doğru ve dürüst cevaptır: abonelik kanalı motorun
        // jeton zarfında GÖRÜNMEZ, plan uydurulmaz.
        subscriptionWhen: 'never',
        sourceLabel: 'agy -p … -o json → usage{input_tokens,output_tokens,thinking_tokens,cache_read_tokens,total_tokens}',
        overrideOpt: null,
      }),
    }),

    // ─── 3. KAPI — SÜPERVİZÖR OKUMA: TAM. Bu motorun EN GÜÇLÜ yanı.
    // ÖLÇÜLDÜ (stream-json, NDJSON): `init` (model + cwd + 56 araçlık liste +
    // permission_mode) · adım başına `step_update` (step_type, tool_name,
    // tool_info.parameters, duration_seconds, usage) · kapanışta `result`
    // (status + response + num_turns + toplam usage).
    output: Object.freeze({
      kind: 'json',
      flag: '--output-format',
      values: Object.freeze(['text', 'json', 'stream-json']),
      quietFlag: null,
      requiresQuiet: false, // ÖLÇÜLDÜ: JSON stdout'ta TEK BAŞINA (loglar stderr'de)
      // 🔴 AGY-04 — KAPSAM SINIRI, SATICININ KENDİ CÜMLESİYLE: `--output-format
      // Output format for PRINT MODE (text, json, stream-json) (default text)`
      // (AGY-05-evidence/03-help.txt:17). İnteraktif pane bu zarfı BASMAZ ⇒
      // süpervizör okuması ve jeton rozeti YALNIZ headless (`-p`) koşuda çalışır.
      // Bu alan yazılı DEĞİLKEN "pane'de de okuruz" varsayımı iki kez yapıldı;
      // beyan o varsayımı YAPISAL olarak imkânsız kılar.
      printModeOnly: true,
      // Okuyucu: `electron/agyStreamReader.cjs` (NDJSON + tek-nesne `json` kolu).
      reader: 'electron/agyStreamReader.cjs',
      // ÖLÇÜLDÜ: `status` İKİ YÖNDE DE YALAN SÖYLER (R1 §7-R1 · AGY-02 §5-R3) ⇒
      // bitiş hükmünün otoritesi `response` + çıkış kodudur.
      verdictAuthority: 'response+exit',
      measuredVersion: '1.2.2',
    }),

    install: Object.freeze({
      label: 'Antigravity CLI',
      // Satıcı script'i OKUNDU (239 satır, ENG-18 §5.2 ile aynı sürüm):
      // manifest → sha512 DOĞRULAMA → `~/.local/bin/agy` → son adımda `agy install`.
      // 🟠 SON ADIMIN ÖLÇÜLEN YAN ETKİSİ: hem `~/.bashrc` hem `~/.zshrc` sonuna
      // `# Added by Antigravity CLI installer` + PATH satırı EKLİYOR (izole HOME'da
      // yeniden üretildi). Ürün için gereksiz (`~/.local/bin` zaten augmentedPath'te)
      // ama kullanıcıya satıcının KENDİ komutunu göstermek doğru olan; yan etki
      // burada BEYAN edilir. `agy install --skip-path --skip-aliases` bunu kapatır
      // ama kurucu script'ten geçirilemiyor (bayrak yolu yok).
      command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
      // Windows komutu gemini CLI'ın KENDİ göç yardımcısından okundu
      // (packages/cli/src/ui/utils/antigravityUtils.ts, bundle'da).
      win32Command: 'powershell -ExecutionPolicy ByPass -c "irm https://antigravity.google/cli/install.ps1 | iex"',
      docsUrl: 'https://antigravity.google/docs/cli/overview',
      checkHint: 'https://antigravity.google/docs/cli/overview',
      installsTo: '~/.local/bin', // script'te sabit: TARGET_DIR="$HOME/.local/bin"
      // 🪤 İKİ KATMANLI TUZAK (ölçüldü):
      //   ① `--version` YALNIZ "1.1.14" basar → ürün kimliğini kanıtlamaz.
      //   ② `--help`in ilk satırı ürün adını taşımıyor, `basename $0`'ı taşıyor:
      //      arşivden `./antigravity --help` "Usage of antigravity:" derken kurulu
      //      hâli `agy --help` "Usage of agy:" diyor. Ada bakan kalıp DOĞRU ürünü
      //      reddediyordu (verifyInstall → error:"wrong-product", head:"Usage of agy:").
      // → kalıp motorun KENDİ seçenek AÇIKLAMASINA bağlandı (ada bağımsız).
      verifyArgv: Object.freeze(['--help']),
      verifyPattern: 'Timeout\\s+for\\s+print\\s+mode\\s+wait',
    }),

    // ─── AGY-05 — EFOR KOLU: BEYAN EDİLDİ (agy 1.2.2'de ÖLÇÜLDÜ) ──────────────
    //
    // CDX-F1 bu alanı `unverified` bırakmıştı ("aranmadı"); ANTIGRAVITY-R1 §3.2 aradı
    // ve AGY-05 aynı dört kuralı agy 1.2.2'de TEKRAR ölçtü. `agy --help`:
    //   `--effort  Reasoning effort for the current CLI session (low|medium|high)`
    //
    // 🔴 codex'İN TAM TERSİ BİR DÜNYA — ve tasarımı bu belirliyor: codex değeri
    // DOĞRULAMAZ (beyaz liste BİZİM korumamızdı); antigravity DOĞRULAR ve geçersiz
    // birleşimde turu HİÇ başlatmadan `exit 1` ile ölür. Yani burada hatalı argv
    // "kötü bir tur" değil, ÖLÜ BİR PANE demektir (R1 §7-R2, 🔴 yüksek).
    //
    // Ölçülen dört kural (gerçek koşu, MODEL TURU HARCANMADI — doğrulama API
    // çağrısından önce düşüyor; kanıt: AGY-05-evidence/02-negatives.txt):
    //   1. ÇIPLAK aile adı + `--effort`  → doğru gramer (`gemini-3.8-flash` + medium ✅)
    //   2. SONEKLİ ad + ÇELİŞEN efor     → `--model gemini-3.8-flash-low conflicts with --effort=high`
    //      (🪤 AGY-05 inceltmesi: değerler AYNIYSA motor KABUL EDİYOR — `…-high --effort high`
    //       turu başlattı. Ürün yine de basmaz: birleşim gereksiz ve "eşitse geçer" kuralı
    //       satıcı yazımı değiştiğinde sessizce ölümcül argv üretirdi.)
    //   3. Değerler MODEL BAŞINA         → `gemini-3.1-pro has no "medium" effort (available: low, high)`
    //   4. claude-* ailelerinde efor YOK → `--effort is not supported for model "claude-sonnet-4-6"`
    //
    // 🔑 MODEL BAŞINA KISIT NEDEN BURADA DEĞİL: `values` bu motorun TAŞIYICI kümesidir
    // (help'in beyanı). Model-kapsamlı kesişim bir LİSTE işidir ve listeler kendi
    // modülünde yaşar (`model.catalog` deseni) → `catalog` + `modelScoped` alanları
    // argv üreticisini modelCatalog.effortValuesFor'a yönlendirir. Motor adına göre
    // `if` YAZILMADI (agentRunner.js 669. satırın kuralı): karar VERİDEN çıkar.
    effort: Object.freeze({
      kind: 'flag',
      flag: '--effort',
      values: Object.freeze(['low', 'medium', 'high']),
      position: 'append',
      // AGY-05 — model-kapsamlı kesişimin adresi (liste KOPYALANMAZ).
      catalog: 'electron/modelCatalog.cjs',
      // 🔴 FAIL-CLOSED ANAHTARI: bu motorda bir efor değeri, SEÇİLİ MODEL onu kabul
      // ettiği KANITLANMADIKÇA argv'ye basılmaz (model yok/sonekli/katalog dışı → NO-OP).
      modelScoped: true,
      // §6-1 — ölçümün SÜRÜM DAMGASI: `guard:agy:contract` bunu canlı `agy --version`
      // ile karşılaştırır; ikili kendini güncelleyince bayatlık GÖRÜNÜR olur.
      measuredVersion: '1.2.2',
    }),

    unsupported: Object.freeze({
      contextScope:
        'bu motorun kendi belge enjeksiyonunu (proje talimatı zinciri + kalıcı hafıza indeksi) çalışma alanıyla sınırlayan bir taşıyıcı ÖLÇÜLMEDİ — kesim yalnız beyan eden motorda koşar, burada bugünkü davranış aynen sürer (TOKEN-BUDGET-01)',
      images:
        'girdi-görsel bayrağı YOK (tam `--help` seçenek listesi ölçüldü: 22 seçenek, attachment/image dengi yok) → görsel yolu prompt METNİNE gömülmeli. NOT: araç listesinde `generate_image` VAR ama o ÜRETİM aracıdır, girdi yolu değil',
      provider:
        'BYOK grameri YOK: motor yalnız Google uçlarına bağlanır. Ölçülen tek "sağlayıcı" anahtarı settings.json\'daki `modelProvider:"gemini"` (Gemini API) — ikilide `GOOGLE_GEMINI_BASE_URL` dizesi geçiyor ama uç DEĞİŞTİRİR, sağlayıcı DEĞİL (gemini kaydıyla aynı sınır)',
      trust:
        'çalışma dizini GÜVEN kapısı yok: motor `--add-dir` ile verilen kökü sorgusuz kabul etti (gemini\'nin exit 55 ile duran `GEMINI_CLI_TRUST_WORKSPACE` kapısının dengi ÖLÇÜLMEDİ, bayrak listesinde yok)',
      reset:
        'pane RESET slash komutu gerçek TUI oturumunda ölçülmedi (bu turun tamamı headless koştu) → var olmayan bir komut göndermek pane\'e sessizce metin yazardı',
      tui:
        'TUI hazır/blocker dizeleri GERÇEK pane\'de ölçülmedi → paneReadiness regex\'i YOK (gemini kaydıyla aynı takip kalemi)',
      skillsDir:
        'ikili dizelerinde `.agents/skills/` ve `.agents/skills.json` geçiyor ama keşif dizini GERÇEK koşuda doğrulanmadı → uydurma bir yol skill\'leri sessizce görünmez yapardı',
      identityEnv:
        '🔴 KAYDIN ÇALIŞTIRMAYA KAPALI OLMASININ İKİNCİ SEBEBİ: motor ev dizinini taşıyan env YOK. ÖLÇÜLDÜ — `ANTIGRAVITY_EXECUTABLE_DATA_DIR`, `GEMINI_CLI_HOME` ve `AGY_HOME` üçü de denendi, ÜÇÜNDE DE durum ağacı yine `$HOME/.gemini/…` altında oluştu (alternatif dizin BOŞ kaldı). Yani auth ayarı, MCP kaydı, konuşma defteri ve güncelleyici HOME\'a çivili → iki pane\'e iki farklı hesap/araç seti verilemez ve HOME\'u ezmek (git/ssh/kabuk config\'i taşıdığı için) ürün açısından kabul edilemez',
    }),

    partial: Object.freeze({
      effort:
        'AGY-05 — TAŞIYICI ÖLÇÜLDÜ (agy 1.2.2) ve dört kuralı da gerçek koşuyla doğrulandı, ama İKİ SINIR beyanlı kalıyor: (a) model-kapsamlı küme STATİK bir katalogdan geliyor (`modelCatalog.ANTIGRAVITY_MODELS`) çünkü `agy models` çıktısı SONEKLİ ad veriyor (ham kullanımı argv\'de ölümcül) ve her çağrısı ağa çıkıp girişsiz makinede 60 sn OAuth duvarına asılıyor → katalog motor sürüm atladığında BAYATLAR, tazeliği `guard:agy:contract` ölçer; (b) `--model` VERİLMEDEN yalnız `--effort` geçmenin kabul edilip edilmediği ÖLÇÜLMEDİ (ölçmek bir model turu harcardı) → ürün o durumda bayrağı ÜRETMEZ (fail-closed), yani motor kendi varsayılanıyla koşar',
      identity:
        'ENG-ENABLE-01 — TAŞIYICI BAĞLANDI (`kind:\'flag-dir\'`) ve 1.1.28\'de YENİDEN ölçüldü; İKİ SINIR beyanlı kalıyor: (a) 🔴 SIRA ZORUNLU — kimlik dizini İLK verilirse araçların cwd\'si oraya kayar (ölçüldü: ajanın `pwd`\'si kimlik dizini çıktı); ürün bu yüzden `cwdFirst` ile önce iş dizinini yazar, bayrağın sırasını bozan bir değişiklik ajanı YANLIŞ DİZİNDE koşturur. (b) dosya adı MOTORUN dayatması (`AGENTS.md`) → kullanıcının kendi `AGENTS.md`i ile aynı ad; pane kimliği AYRI bir dizinde tutulur, kullanıcının repo\'suna HİÇBİR ŞEY yazılmaz',
      extraRoots:
        '🔑 BAYRAK ÜÇ İŞ YAPIYOR ve SIRA ÖNEMLİ (ölçüldü): `--add-dir` yalnız ek kök EKLEMİYOR, araçların ÇALIŞMA DİZİNİNİ de belirliyor. Bayraksız koşuda ajanın `pwd` çıktısı `$HOME/.gemini/antigravity-cli/scratch` oldu (sürecin cwd\'si DEĞİL) ve bayraksız bir "dosya oluştur" isteği dosyayı çalışma kökünün DIŞINA yazdı. Tek bayrakla cwd doğru geldi. İKİ bayrakta İLK olan kazanıyor: `--add-dir <kimlik> --add-dir <kök>` → pwd KİMLİK dizini; ters sırada → pwd KÖK ve kimlik yine okundu. Ürün bağlarken sıra ZORUNLU: önce çalışma kökü, sonra kimlik dizini',
      usage:
        'jeton defteri ÇIKTIDA TAM ve adım başına ayrışıyor (`usage{input_tokens,output_tokens,thinking_tokens,cache_read_tokens,total_tokens}`; canlı turda 11.526/338/328/0/11.864 ölçüldü) ama (a) USD YOK, (b) ürünün `session-ledger`/`cli-report` okuyucuları "koşu zarfının içindeki sayaç" şeklini tanımıyor → jeton kartı bugün "bilinmiyor" der. Konuşma başına SQLite defteri de var (`conversations/<id>.db`, protobuf blob) ama ayrıştırıcısı YOK',
      session:
        '`conversation_id` HER zarfta yayınlanıyor (kesin eşleme mümkün) ve `--conversation <id>` / `-c` bayrakları help\'te ölçüldü — ama GERÇEK bir devam turu (resume) koşulmadı: kimliğin resume\'da yeniden okunup okunmadığı ÖLÇÜLMEDİ',
      auth:
        'anahtar yolu CANLI doğrulandı (SUCCESS + tam jeton zarfı) ama OAuth/abonelik yolu ölçülemedi: akış tarayıcı ister ve `antigravity.google/oauth-callback` dönüşünden kod yapıştırmayı bekler. 🟠 İSTENEN KAPSAM GENİŞ: `…/auth/cloud-platform` (kullanıcının TÜM GCP\'si) + `aicode` + `cclog` + `experimentsandconfigs` — bir kod asistanı için geniştir, ENG-18 §5.6 ile aynı uyarı',
      install:
        'kurulum kanıtlanabilir ve GÜVENLİ (manifest sha512 doğrulandı: darwin_arm64 1.1.14, indirilen 49 MB paketin sağlaması BİREBİR tuttu) ama 🟠 motor ARKA PLANDA KENDİNİ GÜNCELLİYOR: kurucu script\'in kendi cümlesi "The Antigravity CLI automatically self-updates in the background during regular runs" ve ilk koşuda `updater/update_status.json` yazıldı. Sonuç: ölçülen sürüm (1.1.14) sabitlenemez — ENG-18 1.1.13 ölçmüştü, bir gün sonra 1.1.14. Her spawn öncesi `--version` kaydı bu yüzden takip kalemi',
      output:
        'stream-json TAM ölçüldü; `--json-schema` ile yapılandırılmış çıktı ZORLAMA yolu help\'te VAR ama gerçek bir şemayla ÖLÇÜLMEDİ',
    }),

    verification: Object.freeze({
      contextScope: Object.freeze({ channel: 'unverified', source: 'TOKEN-BUDGET-01 — bu motorda belge-enjeksiyonunu kapatan bir bayrak ARANMADI/ÖLÇÜLMEDİ; kesim yalnız beyan eden motorda koşar' }),
      effort: Object.freeze({ channel: 'measured', source: 'AGY-05-evidence/02-negatives.txt + 03-help.txt (agy 1.2.2 GERÇEK koşu, 2026-09-14): `agy --help` → `--effort  Reasoning effort for the current CLI session (low|medium|high)`; dört kural da gerçek çıktıyla doğrulandı — `gemini-3.1-pro`+medium → "has no \"medium\" effort (available: low, high)", `claude-sonnet-4-6`+high → "--effort is not supported", `gemini-3.8-flash-low`+high → "conflicts with --effort=high" (exit 1, MODEL TURU HARCANMADI). Kabul edilen birleşim (`gemini-3.8-flash`+medium) ANTIGRAVITY-R1 §3.2\'de ölçüldü; AGY-05 onu TEKRAR koşmadı (kabul = tur başlar = jeton harcar)' }),
      identity: Object.freeze({ channel: 'measured', source: 'ENG-22-evidence/04-antigravity-identity.md (aynı cwd, iki `--add-dir` dizini, iki kod kelimesi; taban KORUNDU 11.512→11.824 jeton) + ENG-ENABLE-01-evidence/agy-identity.txt (agy 1.1.28 tekrar ölçümü: kimlik DELTA5 geldi; tek bayrakta `pwd` KİMLİK dizini, iş dizini ÖNCE verilince `pwd` doğru VE kimlik yine okundu)' }),
      model: Object.freeze({ channel: 'measured', source: 'ENG-22-evidence/02-antigravity-argv.md — `agy --help` → `--model  Model for the current CLI session` + `agy models` çıktısı (4 model) + `--model gemini-3.5-flash` ile canlı SUCCESS turu' }),
      images: Object.freeze({ channel: 'measured', source: 'ENG-22-evidence/02-antigravity-argv.md — tam seçenek listesinde görsel bayrağı yok; init olayının araç listesinde yalnız `generate_image` (üretim) var' }),
      provider: Object.freeze({ channel: 'measured', source: 'ikilinin gömülü changelog\'u (1.1.13): modelProvider "gemini" + GEMINI_API_KEY + GOOGLE_GEMINI_BASE_URL — üçü de GOOGLE uçları; BYOK grameri yok' }),
      session: Object.freeze({ channel: 'measured', source: 'ENG-22-evidence/06-antigravity-delegation.md — her zarf `conversation_id` taşıyor (init/step_update/result) + `agy --help` → `--conversation`, `-c/--continue`' }),
      subagentBlock: Object.freeze({ channel: 'measured', source: 'AGY-03 (2026-09-15, agy 1.2.2, GERÇEK tur + KONTROL KOLU): demetin hooks.json\'undaki PreToolUse deny kapısı ÇALIŞTI — invoke_subagent adımı state:"ERROR" oldu ve modelin cevabına BİZİM gerekçemiz düştü; hook enabled:false yapılınca (tek değişken) alt-ajan AÇILDI (ALTAJAN=BASARILI). Kanıt: AGY-03-evidence/01-run-hooks-on.md + 02-run-control-arm.md' }),
      trust: Object.freeze({ channel: 'measured', source: 'ENG-22-evidence/02-antigravity-argv.md — tam bayrak listesinde güven kapısı yok; `--add-dir` verilen kök sorgusuz kabul edildi' }),
      reset: Object.freeze({ channel: 'unverified', source: 'TUI açılmadı (bu tur headless) → alan null' }),
      tui: Object.freeze({ channel: 'unverified', source: 'TUI açılmadı (bu tur headless) → alan null' }),
      mcp: Object.freeze({ channel: 'measured', source: 'ENG-22-evidence/07-antigravity-mcp.md — `$HOME/.gemini/config/mcp_config.json` yazıldı → probe sunucusu SPAWN oldu (kendi log dosyasına yazdı) ve motor log\'u `mcp/eng22probe` adını bastı; init araç listesinde jenerik `call_mcp_tool`' }),
      hooks: Object.freeze({ channel: 'measured', source: 'AGY-03 (2026-09-15, agy 1.2.2): demet içi plugins/<ad>/hooks.json GERÇEK turda okundu — PreInvocation brifingi modelin cevabına geçti (BRIEF kodu) ve PreToolUse deny kapısı aracı durdurdu. ÖLÇÜLEN İKİ ŞEKİL FARKI: PreInvocation MODEL ÇAĞRISI başına ateşliyor (tek -p turunda invocationNum 0,1,2) ve MCP çağrısı hook\'a call_mcp_tool adıyla geliyor (hedef ad args.ToolName/args.ServerName gövdesinde). Kanıt: AGY-03-evidence/03-pretooluse-names.md' }),
      extraRoots: Object.freeze({ channel: 'measured', source: 'ENG-22-evidence/05-antigravity-autonomy-cwd.md — bayraksız `pwd` → `$HOME/.gemini/antigravity-cli/scratch`; `--add-dir <kök>` → kök; iki bayrakta İLK olan kazandı (iki koşu, iki sıra)' }),
      skillsDir: Object.freeze({ channel: 'doc', source: 'ikili dizeleri: `.agents/skills/` (2), `.agents/skills.json` (2) — gerçek keşif ölçülmedi' }),
      identityEnv: Object.freeze({ channel: 'measured', source: 'ENG-22-evidence/03-antigravity-auth.md — ANTIGRAVITY_EXECUTABLE_DATA_DIR / GEMINI_CLI_HOME / AGY_HOME üçü de denendi; durum ağacı her seferinde $HOME/.gemini altında oluştu, alternatif dizin BOŞ kaldı' }),
      auth: Object.freeze({ channel: 'measured', source: 'ENG-22-evidence/03-antigravity-auth.md — (a) settings.json YOK + anahtar VAR → OAuth duvarı + 60 sn asılma; (b) settings.json `{"modelProvider":"gemini"}` + anahtar → duvar YOK, canlı tur SUCCESS ("ENG22-BASELINE-OK"); OAuth URL kapsamı ham hâliyle arşivde' }),
      usage: Object.freeze({ channel: 'measured', source: 'ENG-22-evidence/06-antigravity-delegation.md — `-o json` zarfı ve step_update olayları usage{input,output,thinking,cache_read,total} taşıyor; USD alanı YOK' }),
      output: Object.freeze({ channel: 'measured', source: 'ENG-22-evidence/06-antigravity-delegation.md — gerçek NDJSON akışı: init(model,cwd,56 araç,permission_mode) → step_update(step_type,tool_name,tool_info.parameters,usage) → result(status,response,num_turns,usage)' }),
      install: Object.freeze({ channel: 'measured', source: 'ENG-22-evidence/02-antigravity-argv.md — manifest darwin_arm64 (1.1.14) + sha512 BİREBİR eşleşti + izole HOME\'da `agy install` .bashrc/.zshrc\'ye PATH satırı ekledi (yeniden üretildi) + `--help` başlığı "Usage of antigravity:"' }),
    }),
});
