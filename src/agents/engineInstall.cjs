// ADP-694 — MOTOR CLI KURULUM REHBERİ (P0 lansman blokeri).
//
// KÖK NEDEN (ölçüldü, ADP-694 §Kanıt): `pty.spawn('claude')` motor CLI'ı PATH'te
// yokken node-pty içinde exec BAŞARISIZ olur ve çocuk **exit code 1 + SIFIR bayt**
// ile ölür. Zincirin geri kalanı bunu sessizce yutar:
//   pty.spawn → child.onExit(code=1) → 'pty:exit' → Terminal.applyExit →
//   TerminalPanel.onExit → closeCell()  →  hücre yok olur.
// Kullanıcının gördüğü: ajana tıkladı, HİÇBİR ŞEY olmadı. Sekme yok, hata yok.
// engineCheck.cjs "kurulu değil"i BİLİYORDU ama spawn yolunda hiç sorulmuyordu.
//
// KARAR (Optimus, ADP-694): OTOMATİK KURMA YOK. claude/codex üçüncü-parti CLI'lar;
// kendi hesap/aboneliklerini isterler ve kullanıcının makinesine sessizce global
// paket kurmak güven + lisans açısından yanlış. Doğru davranış: TESPİT ET →
// YÖNLENDİR → DOĞRULA.
//
// Bu modül o üçlünün TEK GERÇEK KAYNAĞIDIR ve saf tutulur (Electron/fs enjekte
// edilebilir) → `node --test electron/engineInstall.test.cjs`.
//   • ENGINE_INSTALL — motor → { label, command, docsUrl } kataloğu (ürün metni)
//   • resolveBinary  — spawn ÖNCESİ senkron PATH çözümü (spawn'ın kendi env'iyle)
//   • missingEngineBanner — pane'e basılan net mesaj (kurulum komutu dahil)
//   • guidanceHolderArgv  — mesajı basıp CANLI kalan, girdiyi ÇALIŞTIRMAYAN tutucu
//
// GÜVENLİK NOTU (tutucu neden kabuk DEĞİL): tutucu bir `sh -c` ile başlatılır ama
// gövdesi SABİT üründür (kullanıcı/renderer verisi TEK bir yerden, tek-tırnak
// kaçışıyla geçer) ve son adımı `while :; do sleep …; done`'dur. Böylece pane'e
// yazılan hiçbir bayt KOMUT OLARAK ÇALIŞMAZ — delegasyon motoru bu pane'e görev
// metni yazsa bile shell enjeksiyonu yapısal olarak imkânsızdır.

'use strict';

// ADP-833 (ADR-W10 Kural 2) — platforma bağlı üç yetenek platform/ altındaki yaprak
// modüllere taşındı; buradaki imzalar DEĞİŞMEDİ (çağıranlar aynen çalışır):
//   • binResolve  → PATH/PATHEXT/`\` farkındalığı (790 M3)
//   • holderShell → rehber pane'ini ayakta tutan süreç (790 M4/S8)
const binResolve = require('../../platform/binResolve.cjs');
const holderShell = require('../../platform/holderShell.cjs');

/**
 * ADP-707 — KOMUTLAR NEDEN DEĞİŞTİ (P0 lansman blokeri, ADP-702 §2.7 ölçtü):
 * eski katalog `npm install -g <paket>` öneriyordu. Yeni bir macOS kullanıcısında
 * npm'in global prefix'i `/opt/homebrew`; `lib/node_modules` BAŞKA bir kullanıcıya
 * ait ve grup-yazması kapalı (`drwxr-xr-x crewpane-dev:admin`) → komut **EACCES**
 * ile ölür (izole ortamda yeniden üretildi: `npm error code: 'EACCES', syscall: 'mkdir'`).
 * Yani ürünün ekranda gösterdiği komut, hedef kitlesinde ÇALIŞMIYORDU.
 *
 * TEK KURAL — HER MOTOR `~/.local/bin`'e KURULUR:
 *   • Yönetici/`sudo` gerekmez, Homebrew gerekmez, sistem dizini yazılmaz.
 *   • `agentRunner.augmentedPath` bu dizini ZATEN PATH'e ekliyor → kurulumdan hemen
 *     sonra "Tekrar dene" gerçekten yeşile döner (uygulamayı yeniden başlatmadan).
 *   • Claude Code'un RESMİ native installer'ı da tam oraya kurar; npm tabanlı
 *     motorlarda aynı sonucu `--prefix ~/.local` verir.
 *
 * ÖLÇÜLDÜ (izole HOME, Eren'in kurulumuna dokunulmadan — ADP-707 raporu §2):
 *   claude → `curl -fsSL https://claude.ai/install.sh | bash` → ~/.local/bin/claude
 *            → `claude --version` = 2.1.220 ✅
 *   codex  → `npm install -g --prefix ~/.local @openai/codex` → ~/.local/bin/codex
 *            → `codex --version` = codex-cli 0.145.0 ✅
 *
 * Bu katalog kurulum komutunun TEK KAYNAĞIDIR: pane banner'ı (missingEngineBanner),
 * ajan kaplaması (EngineMissingOverlay) ve Ayarlar → AI Motorları (engineAuth) hepsi
 * buradan okur. Komut tek yerde değişir.
 */

/** Kullanıcı-yerel kurulum kökü. Tek satırda geçen tek "yol bilgisi" — augmentedPath ile aynı. */
const USER_LOCAL_PREFIX = '~/.local';

/** npm tabanlı motorlar için sudo'suz, kullanıcı-yerel global kurulum komutu. */
function npmUserGlobal(pkg) {
  return `npm install -g --prefix ${USER_LOCAL_PREFIX} ${pkg}`;
}

/**
 * ADP-833 (790 M7) — WINDOWS KOMUTLARI. Yukarıdaki POSIX komutlarının HİÇBİRİ
 * Windows'ta çalışmaz: `curl … | bash` (bash yok, boru POSIX), `--prefix ~/.local`
 * (npm'in global prefix'i orada `%APPDATA%\npm`; `~` genişlemez). Kullanıcıya
 * çalışmayan komut göstermek ADP-707'nin çözdüğü hatanın Windows'ta aynen tekrarıdır.
 *
 * Kaynak: resmi kurulum dokümanları (792 §1.1/§1.2 — installer'ların kendisinden
 * okundu). `powershell -ExecutionPolicy ByPass -c "…"` sarmalayıcısı bilerek:
 * kullanıcı komutu cmd.exe'ye de PowerShell'e de yapıştırsa aynen çalışır.
 *
 * npm yolunda `--prefix` YOK: `%APPDATA%\npm` zaten kullanıcıya ait (yönetici
 * gerekmez, EACCES kök nedeni Windows'ta oluşmaz) ve `envPath.extraPathDirs`
 * win32 listesinde → kurulumdan hemen sonra "Tekrar dene" yeşile döner.
 */
function npmGlobalWin32(pkg) {
  return `npm install -g ${pkg}`;
}
function powershellInstaller(url, opts = {}) {
  // WIN-PARITY-01 — SORGU DİZELİ URL'ler TIRNAK İSTER: `irm https://x/y?a=b | iex`
  // yazılışında PowerShell `?`/`=` taşıyan çıplak token'ı güvenilir biçimde tek
  // parça saymaz. Satıcı belgesi de tek tırnakla yazıyor (cursor: `irm 'https://
  // cursor.com/install?win32=true' | iex`) — komut satıcının YAZDIĞI gibi kurulur.
  const u = opts.quote ? `'${url}'` : url;
  return `powershell -ExecutionPolicy ByPass -c "irm ${u} | iex"`;
}

/**
 * ENG-08 (ENG-R2 §5.7) — TEDARİK ZİNCİRİ KAPISI: kurulan ürün DOĞRU ürün mü?
 *
 * KÖK NEDEN (ENG-R2 ölçümü): npm paket ADI motoru garanti ETMİYOR. `npm i -g
 * kimi-code` Moonshot'ın CLI'ı değil — Groq'a proxy açıp claude-code koşturan bir
 * ÜÇÜNCÜ-TARAF sarmalayıcı, üstelik API anahtarını Keychain'e yazıyor. Katalogdaki
 * her komut, kurulumdan sonra İKİLİYİ KOŞTURUP kimliğini kanıtlamak zorunda; yoksa
 * ürünün ekranda gösterdiği komut müşteri makinesine YANLIŞ program kurar.
 *
 * ⚠️ KALIP MOTOR BAŞINA ÖLÇÜLDÜ — `--version` her motorda kimlik VERMİYOR
 * (2026-08-17, bu makinede gerçek koşu):
 *   claude   --version → "2.1.233 (Claude Code)"  → ürün adı VAR
 *   codex    --version → "codex-cli 0.147.0"      → ürün adı VAR
 *   gemini   --version → "0.55.1"                 → SADECE SÜRÜM → `--help` gerekir
 *   opencode --version → "1.18.18"                → SADECE SÜRÜM → `--help` gerekir
 *   gemini   --help    → "Usage: gemini …" + "Gemini CLI - Defaults to interactive…"
 *   opencode --help    → "Commands:\n  opencode completion …"
 * Bu yüzden `verifyArgv` sabit DEĞİL, kayıt başına veridir.
 */
const ENGINE_INSTALL = Object.freeze({
  claude: Object.freeze({
    id: 'claude',
    label: 'Claude Code',
    // Resmi native installer (npm gerektirmez, ~/.local/bin'e kurar).
    command: 'curl -fsSL https://claude.ai/install.sh | bash',
    // Windows resmi native installer — %USERPROFILE%\.local\bin'e kurar (792 §1.1).
    win32Command: powershellInstaller('https://claude.ai/install.ps1'),
    docsUrl: 'https://docs.claude.com/en/docs/claude-code/setup',
    verifyArgv: Object.freeze(['--version']),
    verifyPattern: 'claude\\s*code',
  }),
  codex: Object.freeze({
    id: 'codex',
    label: 'Codex CLI',
    command: npmUserGlobal('@openai/codex'),
    // %LOCALAPPDATA%\Programs\OpenAI\Codex\bin + registry PATH güncellemesi (792 §1.2).
    win32Command: powershellInstaller('https://chatgpt.com/codex/install.ps1'),
    docsUrl: 'https://developers.openai.com/codex/cli',
    verifyArgv: Object.freeze(['--version']),
    verifyPattern: 'codex',
  }),
  // ENG-12 — GitHub Copilot CLI. `--version` çıktısı ÜRÜN ADINI basıyor
  // ("GitHub Copilot CLI 1.0.80.") → tedarik-zinciri kapısı `--help`e düşmeden ölçer.
  copilot: Object.freeze({
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    command: npmUserGlobal('@github/copilot'),
    win32Command: npmGlobalWin32('@github/copilot'),
    docsUrl: 'https://docs.github.com/copilot/how-tos/copilot-cli',
    verifyArgv: Object.freeze(['--version']),
    verifyPattern: 'github\\s+copilot',
  }),
  // ENG-13 — Goose. `--version` yalnız " 1.46.0" basar (ürün adı YOK) → kimlik
  // `--help` başlığından ("Usage: goose [COMMAND]") ölçülür.
  // 🔴 `CONFIGURE=false` ŞART: varsayılan installer sonunda `goose configure`u
  // /dev/tty'den İNTERAKTİF koşturur (otomasyonda ASILIR) ve PATH için ~/.zshrc'yi
  // değiştirmeyi teklif eder. Bu değişkenle ikisi de kapanır (script okundu, ENG-13 §5).
  goose: Object.freeze({
    id: 'goose',
    label: 'Goose',
    // `GOOSE_BIN_DIR` açıkça PİNLENİR: script'in varsayılanı zaten ~/.local/bin ama
    // varsayılana güvenmek yerine yazmak, ikilinin augmentedPath'te göründüğünü GARANTİ eder.
    command:
      'curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | CONFIGURE=false GOOSE_BIN_DIR="$HOME/.local/bin" bash',
    win32Command: null, // resmi Windows kurulumu Desktop uygulaması üzerinden; CLI script'i POSIX
    docsUrl: 'https://block.github.io/goose/docs/getting-started/installation',
    installsTo: '~/.local/bin', // script okundu: GOOSE_BIN_DIR varsayılanı
    verifyArgv: Object.freeze(['--help']),
    verifyPattern: 'usage:\\s*goose',
  }),
  // ENG-13 — Droid (Factory). Kurulum script'i sürümü SABİTLER + sha256 doğrular +
  // shell rc'ye DOKUNMAZ (okundu). 🔴 YAN ETKİ: `pkill -KILL -x droid` — koşan tüm
  // droid pane'leri uyarısız ölür; "motoru güncelle" düğmesi önce süreçleri saymalı.
  droid: Object.freeze({
    id: 'droid',
    label: 'Droid (Factory)',
    command: 'curl -fsSL https://app.factory.ai/cli | sh',
    win32Command: null, // satıcı script'i POSIX (sh); Windows yolu ölçülmedi
    docsUrl: 'https://docs.factory.ai/cli/getting-started/overview',
    // Script'te SABİT: `DST="$HOME/.local/bin"` (satır 106) — env ile değiştirilemez,
    // o yüzden komut dizesinde görünmez; hedef BEYAN olarak taşınır.
    installsTo: '~/.local/bin',
    verifyArgv: Object.freeze(['--help']), // `--version` yalnız "0.197.0" basar
    verifyPattern: 'factory',
  }),
  // İleride eklenecek motorlar — bugün ALLOWED_COMMANDS'ta YOKLAR, ama katalog
  // hazır: motor eklendiğinde rehber kendiliğinden doğru komutu gösterir.
  // ENG-14 — ÖLÇÜLDÜ (kurulu 0.55.1): `gemini --help` ilk satırı "Usage: gemini
  // [options] [command]"; "Gemini CLI" ibaresi İKİNCİ satırda ve sürüme bağlı →
  // kalıp KOMUT ADINA bağlandı (daha kararlı, aynı tedarik-zinciri güvencesi:
  // `npm i -g gemini` gibi bir taklit paket bu kalıbı üretemez).
  gemini: Object.freeze({
    id: 'gemini',
    label: 'Gemini CLI',
    command: npmUserGlobal('@google/gemini-cli'),
    win32Command: npmGlobalWin32('@google/gemini-cli'),
    docsUrl: 'https://geminicli.com/docs/',
    verifyArgv: Object.freeze(['--help']), // `--version` yalnız "0.55.1" basar
    verifyPattern: 'usage:\\s*gemini',
  }),
  // ENG-14 — Qwen Code (gemini-cli çatalı). `qwen --version` → "0.21.13" (kimlik YOK).
  qwen: Object.freeze({
    id: 'qwen',
    label: 'Qwen Code',
    command: npmUserGlobal('@qwen-code/qwen-code'),
    win32Command: npmGlobalWin32('@qwen-code/qwen-code'),
    docsUrl: 'https://github.com/QwenLM/qwen-code',
    verifyArgv: Object.freeze(['--help']),
    verifyPattern: 'usage:\\s*qwen',
  }),
  opencode: Object.freeze({
    id: 'opencode',
    label: 'OpenCode',
    // Resmi `curl … | bash` installer'ı ~/.opencode/bin'e kurar — o dizin
    // augmentedPath'te YOK. npm yolu ~/.local/bin'e kurduğu için tercih edilir.
    command: npmUserGlobal('opencode-ai'),
    win32Command: npmGlobalWin32('opencode-ai'),
    docsUrl: 'https://opencode.ai/docs/',
    // ENG-16 — kalıp DARALTILDI: çıplak 'opencode' kelimesi banner/hata metninde de
    // geçebilir (paket adı, yol) → kimlik kanıtı olmaz. `--help` çıktısının KENDİ
    // komut listesi ölçüldü: "opencode completion  generate shell completion script".
    verifyArgv: Object.freeze(['--help']), // `--version` yalnız "1.18.18" basar
    verifyPattern: 'opencode\\s+completion',
  }),
  // ENG-16 — amp: `--version` ürün adı TAŞIMIYOR ("0.0.1786968161-gdd03ae (released …)")
  // → kimlik `--help` başlığından ölçülür ("Amp CLI").
  amp: Object.freeze({
    id: 'amp',
    label: 'Amp',
    command: npmUserGlobal('@ampcode/cli'),
    win32Command: npmGlobalWin32('@ampcode/cli'),
    docsUrl: 'https://ampcode.com/manual',
    verifyArgv: Object.freeze(['--help']),
    verifyPattern: 'Amp\\s+CLI',
  }),

  // ENG-17 — Cursor CLI. Satıcı script'i OKUNDU (ENG-17 §kanıt): ~/.local/bin'e
  // İKİ sembolik bağ atıyor (`agent` + `cursor-agent`), kabuk rc'sine DOKUNMUYOR
  // (yalnız PATH önerisi basıyor), ama 🟠 sha256 DOĞRULAMASI YOK ve sürüm script'in
  // İÇİNE gömülü (2026.08.11-e8db854) — yani "en son" değil, script'in bildiği sürüm.
  // 🪤 `rm -f ~/.local/bin/agent`: JENERİK adı sormadan siliyor (ürün o adı kullanmaz).
  cursor: Object.freeze({
    id: 'cursor',
    label: 'Cursor CLI',
    command: 'curl -fsSL https://cursor.com/install | bash',
    // WIN-PARITY-01 — WINDOWS YOLU ARTIK ÖLÇÜLDÜ (09.09). Üç aday denendi:
    //   ❌ `cursor.com/install.ps1`  → HTTP **200** ama gövde satıcının Next.js
    //      PAZARLAMA SAYFASI (HTML, 33 KB). SPA catch-all'u her yola 200 döner;
    //      "200 geldi ⇒ dosya var" varsayımı buraya ÇALIŞMAYAN bir komut yazardı.
    //   ❌ npm `cursor-agent`        → ÜÇÜNCÜ TARAF (zalab-inc/cursor_agent),
    //      Cursor DEĞİL. kimi-code sınıfının aynısı (ENG-17 §tedarik zinciri).
    //   ✅ `cursor.com/install?win32=true` → GERÇEK PowerShell script'i (83 satır,
    //      ASCII): mimariyi WMI ile ölçer (WOW64 yanıltmasına karşı), satıcının
    //      `downloads.cursor.com/lab/<sürüm>/windows/<arch>/agent-cli-package.zip`
    //      paketini indirir, `%LOCALAPPDATA%\cursor-agent` altına açar ve o dizini
    //      kullanıcı PATH'ine ekler. Komut satıcının BELGESİNDEN birebir alındı
    //      (cursor.com/docs/cli/installation → "Windows (native)").
    // 🪤 Kurulum dizini POSIX'tekinden BAŞKA (`~/.local/bin` değil) → envPath'in
    //    Windows listesine de eklendi; yoksa motor kurulur ama pane onu göremezdi.
    win32Command: powershellInstaller('https://cursor.com/install?win32=true', { quote: true }),
    docsUrl: 'https://cursor.com/docs/cli/overview',
    installsTo: '~/.local/bin',
    // Windows'ta HEDEF BAŞKA (script'ten okundu): `%LOCALAPPDATA%\cursor-agent`.
    // Beyan platforma göre çözülmezse ekran Windows'ta YANLIŞ dizin gösterirdi.
    win32InstallsTo: '%LOCALAPPDATA%\\cursor-agent',
    // `--version` yalnız "2026.08.11-e8db854" basar (ürün adı YOK) → `--help` gövdesi.
    // 🪤 Kalıp "cursor-agent" ARAMAZ: motorun kendi kullanım satırı `Usage: agent …`
    // diyor (ikili `basename $0`'a bakıyor) — ada bakan bir kalıp doğru ürünü REDDEDERDİ.
    verifyArgv: Object.freeze(['--help']),
    verifyPattern: 'Start\\s+the\\s+Cursor\\s+Agent',
  }),
  // ENG-17 — 🪤 ÜÇ TUZAKLI TEDARİK ZİNCİRİ (hepsi ÖLÇÜLDÜ, ayrıntı ENG-17 raporu):
  //   ① `npm i -g kimi-code` → ÜÇÜNCÜ TARAF (whitesmith/kimi-code): "A CLI tool that
  //      starts anthropic-proxy with Kimi model and runs claude-code" — Moonshot DEĞİL.
  //   ② `curl … code.kimi.com/install.sh` → script'in KENDİ başlığı:
  //      "Legacy kimi-cli (Python) installer - DEPRECATED". Boru içinde (tty YOK — yani
  //      ürünün göstereceği hâlde) SORU SORMADAN eski Python paketini kurar.
  //   ③ Doğru satıcı script'i `code.kimi.com/kimi-code/install.sh`tir; sha256 doğruluyor
  //      ama ~/.kimi-code'a kuruyor, KABUK RC DOSYASINI değiştiriyor ve PATH'teki eski
  //      `kimi`yi TAŞIYOR/SİLİYOR.
  // → Katalog satıcının KENDİ önerdiği npm yolunu kullanır (script'in musl dalında
  //   birebir bu satır geçiyor): sudo yok, rc'ye dokunmaz, ~/.local/bin'e kurar.
  kimi: Object.freeze({
    id: 'kimi',
    label: 'Kimi Code',
    command: npmUserGlobal('@moonshot-ai/kimi-code'),
    win32Command: npmGlobalWin32('@moonshot-ai/kimi-code'),
    docsUrl: 'https://moonshotai.github.io/kimi-code/',
    installsTo: 'npm-global',
    verifyArgv: Object.freeze(['--help']), // `--version` yalnız "0.36.1" basar
    // Üçüncü-taraf sarmalayıcı claude-code koşturur ve BU satırı üretemez.
    // 🪤 ÖLÇÜLDÜ — `\\b` YETMİYOR: `kimi\\b` kalıbı "Usage: kimi-code [options]"
    // metniyle de EŞLEŞİR (tire bir sözcük sınırıdır) → üçüncü-taraf paket kapıdan
    // GEÇERDİ. Kalıp bu yüzden ARGÜMAN JOKERİNE kadar bağlanır.
    verifyPattern: 'Usage:\\s*kimi\\s+\\[options\\]',
  }),
  // ENG-17 — Crush. `--version` ÜRÜN ADINI basıyor ("crush version v0.89.0") →
  // kimlik kapısı `--help`e düşmeden ölçer.
  crush: Object.freeze({
    id: 'crush',
    label: 'Crush',
    command: npmUserGlobal('@charmland/crush'),
    win32Command: npmGlobalWin32('@charmland/crush'),
    docsUrl: 'https://github.com/charmbracelet/crush',
    installsTo: 'npm-global',
    verifyArgv: Object.freeze(['--version']),
    verifyPattern: 'crush\\s+version',
  }),
  // ENG-22 — Antigravity CLI. Satıcı script'i (239 satır) OKUNDU ve ölçüldü:
  //   ✅ manifest → sha512 DOĞRULAMA → `$HOME/.local/bin/agy` (TARGET_DIR sabit,
  //      augmentedPath'te ZATEN var) → macOS'ta karantina niteliği temizleniyor.
  //   🟠 SON ADIM `agy install`: hem ~/.bashrc hem ~/.zshrc sonuna PATH satırı
  //      EKLİYOR (izole HOME'da yeniden üretildi). Ürün için gereksiz ama satıcının
  //      KENDİ komutunu göstermek doğru olan; yan etki engineRegistry'de beyanlı.
  //      (`agy install --skip-path --skip-aliases` kapatır ama kurucudan geçirilemiyor.)
  //   🟠 Motor ARKA PLANDA kendini günceller → sürüm sabitlenemez (ölçüldü: ENG-18
  //      1.1.13, bir gün sonra 1.1.14).
  // Windows komutu gemini CLI'ın KENDİ göç yardımcısından okundu (antigravityUtils.ts).
  // 🪤 `--version` yalnız "1.1.14" basar → kimlik `--help` başlığından: "Usage of antigravity:".
  antigravity: Object.freeze({
    id: 'antigravity',
    label: 'Antigravity CLI',
    command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    win32Command: powershellInstaller('https://antigravity.google/cli/install.ps1'),
    docsUrl: 'https://antigravity.google/docs/cli/overview',
    installsTo: '~/.local/bin',
    // 🪤 ÖLÇÜLEN TUZAK (cursor'unkinin AYNISI, ENG-17): ikili kullanım satırını
    // `basename $0`'dan üretiyor → `~/.local/bin/agy --help` "Usage of agy:" der,
    // "antigravity" GEÇMEZ. Ada bakan bir kalıp DOĞRU ürünü reddederdi (ölçüldü:
    // verifyInstall → {"ok":false,"error":"wrong-product","head":"Usage of agy:"}).
    // Kalıp bu yüzden motorun KENDİ seçeneğinin AÇIKLAMASINA bağlandı: `--print-timeout
    //   Timeout for print mode wait (default 5m0s)` — ada bağımsız, 1.1.13/1.1.14'te aynı.
    verifyArgv: Object.freeze(['--help']),
    verifyPattern: 'Timeout\\s+for\\s+print\\s+mode\\s+wait',
  }),
  // ENGINE-MUSE-02 — Meta Muse Code. Resmî kurucu (314 satır) OKUNDU ve İZOLE
  // HOME'da GERÇEKTEN koşturuldu (Eren'in PATH'ine dokunulmadan):
  //   ✅ `install_dir="${MUSE_INSTALL_DIR:-$HOME/.local/bin}"` → ürünün
  //      augmentedPath'inde ZATEN olan dizin (ADP-707 kuralı; sudo/Homebrew yok).
  //   ✅ launcher `x-content-sha256` başlığıyla doğrulanıyor (varsa) + `bash -n`;
  //      indirme `--proto '=https'` ile TLS'e kilitli.
  //   🟠 YAN ETKİ: kurucu PATH satırını ~/.zshrc / ~/.bashrc / ~/.profile / fish
  //      conf'a EKLİYOR (`MUSE_NO_MODIFY_PATH=1` kapatır) — ürün için gereksiz ama
  //      satıcının KENDİ komutunu göstermek doğru olan; yan etki burada BEYANLI.
  //   🟠 İkili İKİ PARÇA: `muse` (33 KB launcher) + `muse-bin-<sürüm>` (242 MB);
  //      launcher kendini güncelleyebilir → ölçülen sürüm sabitlenemez.
  // POSIX-only: `install.ps1` dengi YOK → win32Command null (engineInstall Windows'ta
  // komut UYDURMAZ, dokümana yönlendirir — ENG-13 kuralı).
  // 🔑 Bu motorda `--version` ÜRÜN ADINI taşıyor (ölçüldü: "Muse Code 1.0.3
  // (1.0.3-R2198.1)") → gemini/opencode'daki `--help` dolambacı GEREKMİYOR.
  muse: Object.freeze({
    id: 'muse',
    label: 'Muse Code',
    command: 'curl -fsSL https://dev.meta.ai/install.sh | sh',
    win32Command: null,
    docsUrl: 'https://dev.meta.ai/docs/muse-code/',
    installsTo: '~/.local/bin',
    verifyArgv: Object.freeze(['--version']),
    verifyPattern: 'Muse\\s+Code\\s+\\d',
  }),
});

/**
 * Bir motorun kurulum bilgisi (KOPYA döner — çağıran katalogu mutasyona uğratamaz).
 * Bilinmeyen motor → null DEĞİL, en azından id/label taşıyan asgari kayıt: rehber
 * "bu komut bulunamadı" diyebilsin, sessiz kalmasın.
 *
 * `command` PLATFORMA GÖRE çözülür (ADP-833/M7); dönen nesnenin ŞEKLİ değişmez —
 * çağıranlar (pane banner'ı, sihirbaz, Ayarlar rozeti) tek bir `command` görür.
 * `opts.platform` enjekte edilebilir (win32 dalı macOS'ta test edilir).
 */
function installInfo(engineId, opts = {}) {
  const id = typeof engineId === 'string' ? engineId.trim() : '';
  if (!id) return null;
  const platform = opts.platform || process.platform;
  const hit = ENGINE_INSTALL[id];
  if (hit) {
    const { win32Command, win32InstallsTo, ...rest } = hit;
    // WIN-PARITY-01 — hedef dizin de platforma göre çözülür; beyan etmeyen motorda
    // bugünkü değer AYNEN kalır (additive).
    if (platform === 'win32' && win32InstallsTo) rest.installsTo = win32InstallsTo;
    // ENG-13 — WINDOWS'TA POSIX SATIRI GÖSTERMEK YASAK. Eskiden win32 komutu olmayan
    // kayıt sessizce POSIX komutuna düşüyordu; goose/droid satıcı script'leri `sh`
    // gerektirdiği için bu, Windows kullanıcısına ÇALIŞMAYACAK bir komut göstermek
    // demekti (ADP-707'nin kapattığı "ekrandaki komut yanlış" sınıfı). Doğru cevap
    // komutu UYDURMAK değil, YOK demek: rehber dokümana yönlendirir.
    if (platform === 'win32' && !win32Command) {
      return { ...rest, command: null, win32Unsupported: true };
    }
    return { ...rest, command: (platform === 'win32' && win32Command) || rest.command };
  }
  return { id, label: id, command: null, docsUrl: null };
}

/**
 * ENG-08 — KURULUM SONRASI KİMLİK DOĞRULAMASI (ENG-R2 §5.7 kapısı).
 *
 * `<bin> <verifyArgv…>` koşar ve çıktının `verifyPattern`e uymasını ARAR.
 * Dönen: `{ ok, version, output, error }` — ASLA fırlatmaz (bu bir rozet girdisi).
 *   • `ok:true`                       → doğru ürün; `version` çıkarılabilirse dolu
 *   • `error:'wrong-product'`         → ikili KOŞTU ama kimliğini kanıtlamadı
 *                                       (kimi-code sınıfı: paket adı yalan söyledi)
 *   • `error:'verify-failed'`         → komut hiç koşmadı / zaman aşımı → ÖLÇEMEDİK,
 *                                       "yanlış ürün" DEMEK YALAN olurdu (ADR-W7 üç-durum)
 *   • `error:'no-verify-contract'`    → katalog bu motor için kalıp beyan etmemiş
 *
 * ⚠️ `wrong-product` ile `verify-failed` AYRI: birincisi bir CEVAP, ikincisi ölçüm
 * başarısızlığı. İkisini birleştirmek, motoru düzgün kurmuş kullanıcıya "yanlış
 * program kurdun" demek olurdu ([[ref_whatsapp_status_column_lies]] sınıfı hata).
 *
 * `deps.execFile` / `deps.platform` / `deps.timeoutMs` enjekte edilebilir.
 */
function verifyInstall(engineId, binPath, deps = {}) {
  const info = installInfo(engineId, deps);
  const argv = info && Array.isArray(info.verifyArgv) ? [...info.verifyArgv] : null;
  const patternSrc = info && typeof info.verifyPattern === 'string' ? info.verifyPattern : null;
  if (!argv || !argv.length || !patternSrc) {
    return Promise.resolve({ ok: false, version: null, output: '', error: 'no-verify-contract' });
  }
  let pattern;
  try { pattern = new RegExp(patternSrc, 'i'); } catch {
    return Promise.resolve({ ok: false, version: null, output: '', error: 'no-verify-contract' });
  }
  const exec = deps.execFile || require('node:child_process').execFile;
  const timeoutMs = deps.timeoutMs || 8000;
  // Windows'ta `.cmd` sarmalayıcısı kabuksuz koşamaz → aynı `execArgs` hunisi.
  const target = binResolve.execArgs(binPath, argv, {
    platform: deps.platform || process.platform,
    env: deps.env || process.env,
  });
  const opts = target.windowsVerbatimArguments === true
    ? { timeout: timeoutMs, env: deps.env || process.env, windowsVerbatimArguments: true }
    : { timeout: timeoutMs, env: deps.env || process.env };
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => done({ ok: false, version: null, output: '', error: 'verify-failed' }), timeoutMs);
    try {
      exec(target.file, target.argv, opts, (err, stdout, stderr) => {
        clearTimeout(timer);
        // Kimlik satırı stderr'e de basılabilir (birçok CLI `--help`i oraya yazar).
        const output = `${stdout || ''}${stderr || ''}`;
        // Komut HİÇ çıktı vermediyse ve hata aldıysak: ölçemedik.
        if (err && !output.trim()) return done({ ok: false, version: null, output: '', error: 'verify-failed' });
        if (!pattern.test(output)) {
          return done({ ok: false, version: null, output: output.slice(0, 400), error: 'wrong-product' });
        }
        // Sürüm YALNIZ bir sürüm komutundan okunur. `--help` çıktısındaki ilk
        // "x.y.z" bir sürüm olmayabilir — ölçüldü: `opencode --help` metninde
        // "127.0.0.1" geçiyor ve onu "sürüm" diye göstermek uydurma olurdu.
        const isVersionCmd = argv.some((a) => /^-{1,2}(v|version)$/i.test(a));
        const m = isVersionCmd ? output.match(/\b(\d+\.\d+\.\d+[\w.-]*)/) : null;
        done({ ok: true, version: m ? m[1] : null, output: output.slice(0, 400), error: null });
      });
    } catch {
      clearTimeout(timer);
      done({ ok: false, version: null, output: '', error: 'verify-failed' });
    }
  });
}

/** Katalogda gerçekten tanımlı mı (asgari kayıt üretilmeden). */
function isKnownEngine(engineId) {
  return typeof engineId === 'string' && Object.prototype.hasOwnProperty.call(ENGINE_INSTALL, engineId.trim());
}

/**
 * `file` bu env'in PATH'inde ÇALIŞTIRILABİLİR bir dosya olarak çözülüyor mu?
 * Çözülen mutlak yolu, yoksa null döner.
 *
 * NEDEN engineCheck.probeOne DEĞİL: probeOne login shell'i fork'lar (async, ~50-4000 ms)
 * ve KULLANICININ shell PATH'ini kullanır. Spawn ön-kontrolü tam olarak node-pty'nin
 * kullanacağı env'e (plan.env — buildSpawn'ın PATH+locale huninisinden geçmiş) bakmak
 * ZORUNDA: aksi hâlde probe "var" derken exec yine başarısız olabilirdi. Ayrıca spawn
 * yolu senkron olmalı (spawnPty senkron bir IPC handler'ından çağrılıyor).
 *
 * `deps.fs` enjekte edilebilir (test).
 */
function resolveBinary(file, env, deps = {}) {
  return binResolve.resolveBinary(file, env, deps);
}

/**
 * ADP-833 (ADR-W7) — aynı çözüm, ÜÇ-DURUMLU: `{state:'present'|'absent'|'unknown'}`.
 * "Bulamadım" ile "ÖLÇEMEDİM" ayrı şeylerdir; rozet/sihirbaz bu ikisini farklı
 * göstermek zorunda (motoru kurulu olan kullanıcıya "kurulu değil" demek yalandır).
 */
function resolveBinaryState(file, env, deps = {}) {
  return binResolve.resolveBinaryState(file, env, deps);
}

// ── Pane'e basılan mesaj ─────────────────────────────────────────────────────

const ESC = '\x1b';
const bold = (s) => `${ESC}[1m${s}${ESC}[0m`;
const warn = (s) => `${ESC}[33m${s}${ESC}[0m`;
const cyan = (s) => `${ESC}[36m${s}${ESC}[0m`;
const dim = (s) => `${ESC}[2m${s}${ESC}[0m`;

/**
 * Motor kurulu değilken pane'e basılan rehber. Ham pty akışı olduğu için satır
 * sonu `\r\n` (yalnız `\n` merdiven yapar). Türkçe/emoji güvenli: buildSpawn her
 * çocuk env'ine UTF-8 locale enjekte ediyor (ADP-310).
 *
 * Bu metin UI kaplamasının YERİNE geçmez, ONUN YEDEĞİDİR: kaplama kapatılsa,
 * pane pop-out edilse, ekran görüntüsü alınsa ya da mobil defterden okunsa bile
 * kullanıcı ne olduğunu ve ne yapacağını görür.
 */
function missingEngineBanner(engineId, opts = {}) {
  const info = installInfo(engineId, opts) || { id: String(engineId), label: String(engineId), command: null, docsUrl: null };
  const lines = [
    '',
    warn(`⚠  ${info.label} kurulu değil`),
    '',
    `Bu ajan ${bold(info.label)} motoruyla çalışıyor, ama bu bilgisayarda`,
    `${bold(info.id)} komutu bulunamadı — bu yüzden ajan başlatılamadı.`,
    dim('(Uygulamanın geri kalanı çalışmaya devam eder.)'),
    '',
  ];
  if (info.command) {
    lines.push('Kurmak için bu komutu bir terminalde çalıştır:', '', `    ${cyan(info.command)}`, '');
  } else {
    lines.push('Bu motor için kurulum komutu tanımlı değil.', '');
  }
  if (info.docsUrl) lines.push(dim(`Kurulum adımları: ${info.docsUrl}`), '');
  lines.push(dim('Kurulum bitince bu pencerede "Tekrar dene" düğmesine bas.'), '');
  return lines.join('\r\n') + '\r\n';
}

// ── "Mesajı bas ve canlı kal" tutucu süreci ──────────────────────────────────
// ADP-833: gövde `platform/holderShell.cjs`e taşındı (posix dalı BİT-BİT aynı,
// win32 dalı PowerShell). Aşağıdaki iki dışa-aktarım geriye-uyum için köprüdür.

/** Tek-tırnaklı POSIX sh sözcüğü (`'` → `'\''`). Saf. */
const shSingleQuote = holderShell.shSingleQuote;

/** Tutucunun uyanma aralığı — süreç uykuda, ölçülebilir CPU maliyeti yok. */
const HOLDER_SLEEP_SECONDS = holderShell.HOLDER_SLEEP_SECONDS;

/**
 * Rehber pane'ini ayakta tutan sürecin `{ file, argv }`'si.
 *
 * TASARIM KARARI — neden interaktif kabuk DEĞİL: interaktif bir kabuk pane'e YAZILAN
 * her şeyi ÇALIŞTIRIRDI. Delegasyon motoru (dispatchAll) canlı bir ajan pane'i sanıp
 * görev metnini yazabilir; o metnin kabukta komut olarak koşması kabul edilemez.
 * `printf` + sonsuz `sleep` döngüsü: mesaj basılır, pane canlı kalır, tty tuşları
 * yankılar ama HİÇBİR ŞEY çalıştırılmaz.
 *
 * Kabuk gövdesi sabittir; tek değişken (banner) tek-tırnak kaçışıyla ARGÜMAN olarak
 * geçer (`printf '%s' <banner>` — banner format dizesi DEĞİL, dolayısıyla içindeki
 * `%` de zararsız). Windows karşılığı (base64 + `-EncodedCommand`) aynı değişmezleri
 * korur — ayrıntı `platform/holderShell.cjs`.
 */
function guidanceHolderArgv(banner, deps = {}) {
  return holderShell.guidanceHolderArgv(banner, deps);
}

module.exports = {
  ENGINE_INSTALL,
  installInfo,
  verifyInstall, // ENG-08 — kurulum sonrası ürün-kimliği kapısı (ENG-R2 §5.7)
  isKnownEngine,
  resolveBinary,
  resolveBinaryState,
  execArgs: binResolve.execArgs,
  missingEngineBanner,
  guidanceHolderArgv,
  shSingleQuote,
  HOLDER_SLEEP_SECONDS,
};
