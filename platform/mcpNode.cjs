// ADP-891 (ADR-W7 · ADR-W10 Kural 2) — MCP SERVER'LARINI KOŞTURAN YORUMLAYICININ TEK BOĞAZI.
//
// NEDEN VAR (ölçüldü, hipotez değil). `agentRunner` üç built-in MCP server'ını
// (`crewpane-delegate` / `-browser` / `-task`) claude'un MCP config'ine
// `{ command: 'node', args: [<mutlak .cjs yolu>] }` diye yazıyordu. `node` ÇIPLAK bir
// addır: claude onu spawn ederken KENDİ PATH'inde arar. Yani sistemde bir Node.js
// kurulumu OLDUĞU varsayılıyordu.
//
// BU VARSAYIM WINDOWS'TA YANLIŞ — hem de tam bizim yüzümüzden. `engineInstall.cjs`
// Windows'ta claude'u RESMİ NATIVE INSTALLER ile kurduruyor
// (`powershell -c "irm https://claude.ai/install.ps1 | iex"`) ve o installer kendi
// kendine yeten tek bir `claude.exe` bırakır — **Node.js KURMAZ**. Kullanıcı bizim
// gösterdiğimiz komutu uygular, claude çalışır, ama makinede `node.exe` YOKTUR.
// Sonuç: claude üç server'ı da spawn edemez ve `/mcp` ekranında ÜÇÜ BİRDEN
// `× failed` olur (ADP-891 belirtisi birebir budur).
//
// macOS'ta gizlenmesinin sebebi tesadüf: geliştirici makinelerinde Homebrew/nvm
// zaten bir `node` bırakmış oluyor. Kırılma platforma değil, "makinede Node var mı"ya
// bağlı — yani Node'suz bir Mac müşterisinde de aynen olur. Bu yüzden düzeltme
// win32'ye özel bir DAL değil, PLATFORM-NÖTR bir boğazdır.
//
// ── ÇÖZÜM: ÇIPLAK AD YOK, İKİ AŞAMALI ÇÖZÜMLEME ────────────────────────────
//   1. Sistemde gerçekten bir `node` varsa MUTLAK yolu yazılır (`binResolve`,
//      PATHEXT + `\` farkındalıklı). macOS'ta bugünkü yorumlayıcının TA KENDİSİ
//      seçilir — davranış değişmez, yalnız "PATH'e bağımlı" olmaktan çıkar
//      (claude'un spawn anındaki PATH'i bizimkinden farklı olabilir).
//   2. Hiç `node` yoksa → **Electron'un kendisi node olarak koşturulur**:
//      `process.execPath` + `ELECTRON_RUN_AS_NODE=1`. Bu ikili uygulamayla BİRLİKTE
//      gelir, dolayısıyla HER platformda ve HER müşteride garantidir.
//
// ÖLÇÜLDÜ (ADP-891 raporu §2, gerçek `claude` 2.1.221 ile):
//   • `node` PATH'te yokken çıplak ad → üç server da
//     `✘ Failed to connect — ENOENT: Executable not found in $PATH: "node"`
//   • aynı koşulda Electron-as-node → `✔ Connected` (Electron 42 içindeki node 24.16)
//   • claude, MCP config'indeki `env`i MİRAS env'in ÜZERİNE ekler (SİLMEZ) —
//     yani `ELECTRON_RUN_AS_NODE` yazmak `CREWPANE_BRIDGE_*` env'ini kaybettirmez
//     (env dökümüyle kanıtlandı: 48 anahtar, miras işaretçi + config anahtarı bir arada).
//
// ÜÇ-DURUMLU SÖZLEŞME (ADR-W7): `probe` alanı `binResolve`ın ham cevabını taşır
// (`present` / `absent` / `unknown`). "Node'u ölçemedim" ile "Node yok" aynı şey
// değildir; ikisinde de Electron'a düşeriz (davranış aynı) ama KAYIT farklıdır.
'use strict';

const nodePath = require('node:path');
const binResolve = require('./binResolve.cjs');
const envPath = require('./envPath.cjs');

/** Electron ikilisini düz node gibi koşturan env anahtarı. */
const RUN_AS_NODE_ENV = 'ELECTRON_RUN_AS_NODE';

/**
 * MCP server'larını koşturacak yorumlayıcı.
 *
 * → `{ command, env?, source, probe }`
 *   • `source: 'system-node'`     → makinedeki gerçek node (MUTLAK yol)
 *   • `source: 'electron-as-node'`→ uygulamanın kendi ikilisi (+ `env`)
 *
 * `deps`: { platform, env, execPath, fs, home, searchPath } — hepsi enjekte
 * edilebilir (win32 dalı macOS'ta koşturulur).
 */
function resolveMcpNode(deps = {}) {
  const platform = deps.platform || process.platform;
  const baseEnv = deps.env || process.env;
  // Arama PATH'i pane'e verdiğimizin AYNISI olmalı: motorların gerçek kurulum
  // yerleri (win32'de `%APPDATA%\npm`, `~/.local/bin`…) oradan geliyor.
  const searchPath =
    deps.searchPath !== undefined
      ? deps.searchPath
      : envPath.augment(platform === 'win32' ? envPath.getPathVar(baseEnv) : baseEnv.PATH,
        { platform, env: baseEnv, home: deps.home, readRegistry: false });
  const searchEnv = { ...baseEnv };
  if (platform === 'win32') {
    for (const key of Object.keys(searchEnv)) if (key.toUpperCase() === 'PATH') delete searchEnv[key];
  }
  searchEnv.PATH = searchPath;
  const state = binResolve.resolveBinaryState('node', searchEnv, { platform, fs: deps.fs });
  if (state.state === 'present') {
    return { command: state.path, source: 'system-node', probe: state.state };
  }
  return {
    command: deps.execPath || process.execPath,
    env: { [RUN_AS_NODE_ENV]: '1' },
    source: 'electron-as-node',
    probe: state.state,
  };
}

/**
 * claude MCP config'inin bir `mcpServers.<ad>` girdisi. `env` YALNIZ gerektiğinde
 * yazılır — bugünkü config'lerin şekli (command+args) Node bulunan makinelerde
 * bit-bit aynı kalsın diye.
 */
function mcpServerEntry(scriptPath, launcher) {
  const l = launcher && launcher.command ? launcher : resolveMcpNode();
  const entry = { command: l.command, args: [scriptPath] };
  if (l.env && Object.keys(l.env).length) entry.env = { ...l.env };
  return entry;
}

// ── ADP-906: HOOK KABUĞU cmd.exe DEĞİL, BASH ───────────────────────────────
//
// ADP-891 hook komutunu "Windows ⇒ cmd.exe" varsayımıyla yazdı. O VARSAYIM YANLIŞ ve
// bedeli, düzeltmenin kendisinin Windows'ta kırık sevk edilmesi oldu (0.2.29).
//
// ÖLÇÜLDÜ (claude 2.1.221 ikilisinin KENDİ hata metinleri, `strings`):
//   • "Hook \"…\" requires bash but Git Bash was not found. Install Git for Windows
//      (…), or add \"shell\": \"powershell\" to this hook's config."
//   • "Hook \"…\" has shell: 'powershell' but no PowerShell executable … remove
//      \"shell\": \"powershell\" to use bash."
//   • Windows'ta Git Bash arama sırası ikilinin içinde sabit:
//     `CLAUDE_CODE_GIT_BASH_PATH` → `C:\Program Files\Git\bin\bash.exe` →
//     `C:\Program Files (x86)\Git\bin\bash.exe`.
//   ⇒ hook komutu VARSAYILAN OLARAK BASH ile koşar; cmd.exe hiç devreye girmez.
//   (Müşteri hata satırının `/usr/bin/bash: line 1:` ile başlaması da bunu doğrular:
//    `line 1:` tam olarak `bash -c` hata biçimidir.)
//
// ÖLÇÜLDÜ (gerçek bash 3.2.57, sevk edilen 0.2.29-dev.1 baytıyla üretilen komut):
//   $ bash -c 'set "ELECTRON_RUN_AS_NODE=1" && "<exec>" "<script>"'
//   → RUN_AS_NODE=[]        (env HİÇ atanmıyor)  ·  EXIT 0  (sessiz)
//   Çünkü `set` bash'te env değil KONUMSAL PARAMETRE atar: `set "X=1"` yalnızca
//   `$1="X=1"` yapar. Hata da vermez — `&&` sağ tarafı yorumlayıcı bayrağı OLMADAN
//   çalışır. Node'u olmayan bir Windows müşterisinde (bizim kurulum komutumuzun
//   ürettiği varsayılan durum, bkz. yukarısı) bu, `CrewPane.exe`i node olarak
//   değil DÜZ UYGULAMA olarak başlatmak demektir: hook hiç koşmaz, lider bekleyen
//   bitişleri hiç öğrenmez ve kimse bir hata görmez.
//   POSIX biçimi (`K=V cmd`) aynı bash'te env'i ATAR — ölçüldü.
//
// ⇒ KARAR (ADP-906; TIRNAK KISMI AD-WIN-02'DE REVİZE EDİLDİ — bkz. bir alttaki blok):
//   hook komutu HER platformda bash sözdizimiyle üretilir. Platform yalnızca
//   YORUMLAYICIYI seçmek için kullanılır (`resolveMcpNode`), sözdizimini değil.
//   `mcpServerEntry` bundan ETKİLENMEZ: MCP yolu argv tabanlıdır (command+args+env
//   nesnesi, kabuk yok) ve ADP-891'deki hâliyle doğrudur — kabuk sözdizimi oraya
//   hiç girmez.

// ── AD-WIN-02: ADP-906'NIN KARARI DARALTILDI — KABUK ARTIK BİR VARSAYIM DEĞİL ──
//
// ADP-906'nın ÖLÇÜMÜ (yukarıdaki blok) GEÇERLİ: claude ikilisinin kendi hata metinleri
// Windows'ta hook için Git Bash aradığını söylüyor. YANLIŞ OLAN, o ölçümden çıkarılan
// "⇒ öyleyse kabuk HER Windows makinesinde bash'tir" GENELLEMESİDİR.
//
// ÇÜRÜTEN GÖZLEM (müşteri Cihan, Windows 11, 0.2.37 — DOĞRULANMIŞ DÜZELTME, tahmin
// değil): `briefing-settings-<ajan>.json` içindeki komutun TIRNAKLARINI elle çift
// tırnağa çevirince lider ajan ANINDA canlandı. Tek tırnak bash'te ZATEN doğrudur —
// yani o makinede komutu ayrıştıran şey bash DEĞİLDİ. cmd.exe (ve `CreateProcess`
// → `CommandLineToArgvW`) tek tırnağı bir tırnak karakteri saymaz, sıradan bir bayt
// sayar: `'C:\Program` ilk boşlukta kırılır, hook `code=1` ile ölür, pane sakat doğar.
//
// ⇒ YENİ KARAR: hangi kabuğun koştuğunu TAHMİN ETMEK YERİNE, İKİSİNDE DE aynı anlama
//   gelen tırnaklamayı üret. Bu bir "hangisi doğru" tartışması değil, tartışmayı
//   GEREKSİZ KILAN bir seçimdir.
//
// ── NEDEN ÇİFT TIRNAK İKİSİNDE DE ÇALIŞIR ──────────────────────────────────
//   • bash: çift tırnak İÇİNDE ters-bölü yalnız `$`, `` ` ``, `"`, `\` ve satır sonu
//     ÖNÜNDE kaçış sayılır (POSIX 2.2.3). Windows yollarında bu beşlisi geçmez:
//     `"C:\Program Files\nodejs\node.exe"` → bayt bayt aynen geçer. (ÖLÇÜLDÜ, §test)
//   • cmd.exe / CommandLineToArgvW: çift tırnak TEK tırnaklama biçimidir; ters-bölü
//     yalnız `\"` dizisinde özeldir. Aynı dize orada da tek argüman kalır.
//
// ── AÇIK KAPI (dual-güvenli OLMAYAN dize) ──────────────────────────────────
//   Yolda `$`, `` ` ``, `"`, satır sonu, ARDIŞIK `\\` (UNC: `\\sunucu\pay`) ya da
//   sondaki `\` varsa iki kabuk için ORTAK bir kaçış YOKTUR (bash'in kaçırdığını cmd
//   harfiyen geçirir). O durumda ölçülmüş varsayılana — bash'e — düşülür ve bu
//   `isDualSafe` ile DIŞARIDAN sorulabilir (sessiz kalmasın diye export edildi).
//   Bugünkü üretimde bu yollar yok: crewpaneHome `%APPDATA%\crewpane*`, hook yolu
//   kurulum dizinidir.
//
// ── NEDEN PLATFORM DALI YOK (bilerek) ──────────────────────────────────────
//   "win32'de çift, macOS'ta tek tırnak" yazmak cazip ama ADP-891 ve ADP-906'nın
//   İKİSİ DE tam olarak böyle kırıldı: geliştirme makinesinde HİÇ KOŞMAYAN bir dal
//   sevk edildi. Çift tırnak macOS/bash'te de doğrudur (dual-güvenli olmayan dizede
//   zaten tek tırnağa düşülür) → tek bir yol her gün, her makinede koşar. macOS'ta
//   değişen TEK şey komut METNİNİN tırnak karakteridir; çözülen argümanlar aynıdır
//   (testte gerçek bash'te ölçülüyor).

/**
 * Hook komutlarının tırnaklama biçimi. `'dual'` = "hem bash hem cmd.exe'de aynı
 * anlama gelen tırnaklama". Bu bir KABUK ADI DEĞİL, bir HEDEF KÜME adıdır —
 * ADP-906'daki `'bash'` değeri tam olarak "kabuğu biliyoruz" iddiasıydı ve
 * AD-WIN-02'de çürütüldü.
 */
const HOOK_SHELL = 'dual';

/** Hook komutunun çözülebilmesi GEREKEN kabuklar (rapor/test için tek kaynak). */
const HOOK_SHELL_TARGETS = Object.freeze(['bash', 'cmd']);

/**
 * Bu dize ÇİFT TIRNAK içinde iki kabukta da AYNI baytlara çözülür mü?
 *
 * Reddedilenler ve NEDENİ (hepsi bash'in çift tırnak kuralı; cmd tarafı zaten sorunsuz):
 *   `"`         → tırnağı kapatır (iki kabukta da farklı kaçış ister)
 *   `$` `` ` `` → bash GENİŞLETİR (cmd harfiyen geçirir) — ortak kaçış yok
 *   satır sonu  → komut metnini böler
 *   `\\`        → bash tek `\`e indirger (UNC yolları), cmd ikisini de korur
 *   sonda `\`   → bash kapanış tırnağını KAÇIRIR
 */
function isDualSafe(value) {
  const s = String(value == null ? '' : value);
  if (/["$`\n\r]/.test(s)) return false;
  if (s.includes('\\\\')) return false;
  return !s.endsWith('\\');
}

/**
 * Kabuk tırnaklama. İkinci parametre PLATFORM DEĞİL, HEDEF KABUK/KÜME'dir:
 *   'dual' → çift tırnak; bash + cmd.exe'de AYNI (AD-WIN-02 varsayılanı)
 *   'cmd'  → cmd.exe'nin `""` kaçışı (gerçekten yalnız cmd'ye yazan bir çağıran için)
 *   diğer  → POSIX/bash tek tırnağı (dual-güvenli olmayan dizede AÇIK KAPI)
 */
function shellQuote(value, shell) {
  const s = String(value == null ? '' : value);
  if (shell === 'cmd') return `"${s.replace(/"/g, '""')}"`;
  if (shell === 'dual' && isDualSafe(s)) return `"${s}"`;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** `--flag` biçimindeki çıplak bayraklar tırnaklanmaz (bugünkü komut metni korunur). */
function isBareFlag(token) {
  return /^--?[A-Za-z0-9][\w-]*$/.test(String(token));
}

/**
 * Bir .cjs'i KABUK ÜZERİNDEN koşturan komut metni (claude'un `hooks[].command`ı
 * bir kabuk komutudur — MCP gibi argv dizisi değil).
 *
 * Tırnaklama HER platformda `dual`dir (AD-WIN-02): çift tırnak bash'te de cmd.exe'de
 * de aynı baytlara çözülür. `platform` yalnız yorumlayıcıyı seçmek için taşınır:
 *   node var  : `"<node>" "<script>" --home "<dir>" …`
 *   node yok  : `ELECTRON_RUN_AS_NODE="1" "<exec>" "<script>" …`
 *
 * ⚠️ AD-WIN-02'nin KALAN SINIRI ARTIK KAPALI (WIN-FIX-01 · W1) — bkz. bir alttaki
 * `nodeLauncherFiles` bloğu. `deps.launcherDir` VERİLDİĞİNDE ve yorumlayıcı
 * Electron-as-node dalına düştüğünde env ÖN-EKİ HİÇ üretilmez; onun yerine
 * kabuktan bağımsız bir FIRLATICI çağrılır. `launcherDir` verilmezse (bugünkü
 * çağıranların hepsi, macOS dahil) çıkan metin BİT-BİT bugünküdür.
 */
function nodeShellCommand(argv, deps = {}) {
  const platform = deps.platform || process.platform;
  const launcher = deps.launcher || resolveMcpNode({ ...deps, platform });
  const q = (v) => shellQuote(v, HOOK_SHELL);
  const args = argv.map((a) => (isBareFlag(a) ? String(a) : q(a)));
  // WIN-FIX-01 — FIRLATICI DALI (yalnız win32 + Electron-as-node + dizin verilmiş).
  const launcherPath = nodeLauncherPath(launcher, { platform, dir: deps.launcherDir });
  if (launcherPath) return [q(launcherPath), ...args].join(' ');
  const cmd = [q(launcher.command), ...args].join(' ');
  if (!launcher.env) return cmd;
  // POSIX ön-ek ataması: `K=V cmd` — env'i YALNIZ bu komut için atar. bash'in
  // `set` builtin'i env DEĞİL konumsal parametre atar (ADP-906 kırılması).
  const assigns = Object.entries(launcher.env).map(([k, v]) => `${k}=${shellQuote(v, HOOK_SHELL)}`);
  return `${assigns.join(' ')} ${cmd}`;
}

// ── WIN-FIX-01 (W1) · KABUK-BAĞIMSIZ FIRLATICI — "env'i kabuktan çıkar" ────────
//
// AD-WIN-02 bu boşluğu KENDİ İÇİNDE, açıkça bıraktı: hook komutu bir KABUK
// komutudur ve env ataması için bash (`K=V cmd`) ile cmd.exe (`set K=V && cmd`)
// arasında ORTAK sözdizimi YOKTUR. Yani "makinede Node YOK + kabuk cmd.exe"
// bileşiminde hook `ELECTRON_RUN_AS_NODE` OLMADAN koşar: `CrewPane.exe` düz
// UYGULAMA olarak açılır, hook hiç çalışmaz, lider bekleyen bitişleri HİÇ öğrenmez.
//
// Bu bileşim Miraç'ın makinesinin TA KENDİSİDİR: `engineInstall` Windows'ta claude'u
// resmî native installer ile kurdurur (`irm https://claude.ai/install.ps1 | iex`),
// o installer Node KURMAZ (bkz. bu dosyanın başındaki ADP-891 bloğu) ⇒ yorumlayıcı
// HER ZAMAN Electron-as-node dalına düşer.
//
// ÇÖZÜM: tartışmayı kabuktan ÇIKAR. env'i bir kabuk ön-ekiyle değil, DİSKTEKİ BİR
// FIRLATICIYLA ata; hook komutu yalnızca o firlaticiyi çağırsın (hiçbir kabuk
// sözdizimi kalmaz, yalnız zaten dual-güvenli olan tırnaklama kalır).
//
// ── UZANTISIZ AD, İKİ DOSYA: neden iki kabukta da DOĞRU dosya seçilir ──────────
//   Komuta yazılan yol UZANTISIZDIR: `…\bin\crewpane-node`
//   • cmd.exe / CreateProcess: uzantısız bir ada `%PATHEXT%` (…;.BAT;.CMD;…)
//     uzantılarını SIRAYLA ekleyerek arar; uzantısız dosyayı ÇALIŞTIRMAZ
//     ⇒ `crewpane-node.cmd` seçilir.
//   • bash (Git Bash/MSYS): PATHEXT diye bir kuralı YOKTUR, adı AYNEN açar
//     ⇒ uzantısız `crewpane-node` (shebang'li sh betiği) seçilir.
//   İki kabuk da kendi dosyasını bulur; "hangi kabuk koşuyor" sorusunu SORMAYIZ.
//   (AD-WIN-02'nin dersi: tahmin etme, tartışmayı gereksiz kıl.)
//
// ⚠️ SINIR (dürüstçe): bu bir KAĞIT ÜZERİNDE kapatmadır — üretilen METİN ve DOSYA
// İÇERİKLERİ burada birim testiyle kilitlenir, ama "cmd.exe gerçekten .cmd'yi
// seçti" ancak GERÇEK Windows'ta ölçülür (Eren'in test listesi, WIN-FIX-01 §M2).
// Yol dual-güvenli değilse (tırnak/`$`/UNC/sondaki `\`) firlatici ÜRETİLMEZ ve
// bugünkü davranışa düşülür — sessizce yanlış bir komut yazmaktansa bilinen
// eksik davranış yeğdir.

/** Firlatici dosyalarının ORTAK adı (uzantı KOMUTA yazılmaz — bkz. blok). */
const NODE_LAUNCHER_BASENAME = 'crewpane-node';

/** win32 batch dosyaları CRLF ister; sh betiği LF. Tek yerde, karışmasın. */
const CRLF = '\r\n';

/**
 * Bu yorumlayıcı için firlatici GEREKİYOR mu? Yalnız win32 + `env` taşıyan
 * (Electron-as-node) dalda. macOS'ta HER ZAMAN `false` → o yol hiç değişmez.
 */
function needsLauncher(launcher, platform) {
  return (
    platform === 'win32' &&
    !!launcher &&
    !!launcher.env &&
    Object.keys(launcher.env).length > 0
  );
}

/**
 * Komuta yazılacak UZANTISIZ firlatici yolu, ya da `null` (= firlatici yok,
 * bugünkü davranış). SAF.
 */
function nodeLauncherPath(launcher, { platform, dir } = {}) {
  const plat = platform || process.platform;
  if (!dir || !needsLauncher(launcher, plat)) return null;
  // `path.win32.join` — ayracı ELLE eklemek sondaki `\`i çiftler ve `isDualSafe`
  // o yolu (haklı olarak) güvensiz sayardı; birleştirme kararı tek yerde kalsın.
  const file = nodePath.win32.join(String(dir), NODE_LAUNCHER_BASENAME);
  // Dual-güvenli DEĞİLSE komuta yazamayız (ortak kaçış yok) → bugünkü dala düş.
  if (!isDualSafe(file) || !isDualSafe(launcher.command)) return null;
  return file;
}

/**
 * Diske yazılacak firlatici dosyaları — SAF (I/O YOK, çağıran yazar).
 * `[]` dönerse firlatici gerekmiyor demektir (macOS, ya da Node kurulu makine).
 *
 * @returns {Array<{name:string, contents:string, mode:number}>}
 */
function nodeLauncherFiles(launcher, { platform, dir } = {}) {
  const plat = platform || process.platform;
  if (!nodeLauncherPath(launcher, { platform: plat, dir })) return [];
  const env = launcher.env || {};
  const exe = launcher.command;
  // cmd.exe dalı — `setlocal` env'i BU betikle sınırlar; çıkış kodu korunur
  // (claude hook'un exit code'una bakar: 0 dışı = hook başarısız sayılır).
  const cmdLines = [
    '@echo off',
    'setlocal',
    ...Object.entries(env).map(([k, v]) => `set "${k}=${v}"`),
    `"${exe}" %*`,
    'exit /b %ERRORLEVEL%',
  ];
  // bash/sh dalı — POSIX ön-ek ataması burada DOĞRUDUR (ADP-906 ölçümü) ve
  // `exec` süreci devralır, böylece çıkış kodu aracısız geçer.
  const shLines = [
    '#!/bin/sh',
    '# WIN-FIX-01 — CrewPane hook firlaticisi (Node kurulu OLMAYAN makineler).',
    `${Object.entries(env).map(([k, v]) => `${k}='${String(v).replace(/'/g, `'\\''`)}'`).join(' ')} exec "${exe}" "$@"`,
  ];
  return [
    { name: `${NODE_LAUNCHER_BASENAME}.cmd`, contents: cmdLines.join(CRLF) + CRLF, mode: 0o700 },
    { name: NODE_LAUNCHER_BASENAME, contents: shLines.join('\n') + '\n', mode: 0o700 },
  ];
}

module.exports = {
  RUN_AS_NODE_ENV,
  HOOK_SHELL,
  HOOK_SHELL_TARGETS,
  NODE_LAUNCHER_BASENAME,
  resolveMcpNode,
  mcpServerEntry,
  shellQuote,
  isDualSafe,
  isBareFlag,
  nodeShellCommand,
  needsLauncher,
  nodeLauncherPath,
  nodeLauncherFiles,
};
