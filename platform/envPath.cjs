// ADP-833 (ADR-W7 · ADR-W10 Kural 2) — PATH ZENGİNLEŞTİRME + TAZE PATH OKUMA.
//
// KATMAN 1 — SABİT DİZİNLER (790 M5 · 792 §3.2).
// `agentRunner.augmentedPath` bugün yalnız POSIX dizinleri ekliyor
// (`/opt/homebrew/bin`, `~/.local/bin`…). Windows'ta bunların HİÇBİRİ yok; motorların
// gerçek kurulum yerleri (installer'lardan okundu, 792 §1.1-1.3) tamamen başka.
// macOS listesi burada BİT-BİT korunur; win32 listesi yanına eklenir.
//
// KATMAN 2 — REGISTRY'DEN TAZE PATH (792 §3.2'nin ölçtüğü GERÇEK sessiz kırılma).
// macOS'ta problem "GUI app kırpılmış PATH miras alır"dı ve çözümü login shell'e
// sormaktı. Windows'ta bu problem YAPISAL OLARAK YOK: PATH bir kabuk profilinde
// değil, registry'de yaşar ve her süreç birleşimi alır. Ama Windows'un KENDİ tuzağı
// var: installer registry'yi günceller + `WM_SETTINGCHANGE` yayınlar — ÇALIŞAN
// Electron süreci bunu asla görmez. Kullanıcı motoru kurar, "Tekrar dene"ye basar,
// biz hâlâ "kurulu değil" deriz. Doğru tercüme kabuk çatallamak DEĞİL, registry'yi
// TAZE okumaktır (ADR-W7).
//
// KABUK ÇATALLANMAZ: `reg.exe` `execFileSync` ile, argüman dizisiyle, kabuksuz
// çağrılır (enjeksiyon yüzeyi sıfır) ve kısa timeout taşır.
//
// ÜÇ-DURUMLU SÖZLEŞME (ADR-W10 Kural 3): `readRegistryPath` "okudum/yok/OKUYAMADIM"
// ayrımını korur — okuyamadığımızda PATH'i sessizce eski hâliyle bırakıp
// "motor kurulu değil" demek, tam olarak kapatmaya çalıştığımız yalandır.
'use strict';

const nodeOs = require('node:os');
const nodePath = require('node:path');
const nodeChildProcess = require('node:child_process');

/** Registry'de PATH'i tutan iki anahtar (sistem + kullanıcı). Windows ikisini birleştirir. */
const HKCU_ENV_KEY = 'HKCU\\Environment';
const HKLM_ENV_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';

/** `reg query` bir anahtar için 2 sn'den uzun sürmez; asılırsa ölçüm YAPILAMAMIŞ sayılır. */
const REG_TIMEOUT_MS = 2000;

/**
 * PATH'e eklenecek sabit dizinler. macOS listesi ADP-694'ten beri değişmedi —
 * `~/.local/bin` kurulum komutlarımızın hedefi olduğu için LOAD-BEARING.
 *
 * win32 listesi 792 §3.2'nin ölçtüğü gerçek kurulum yerleri + sistem dizinleri:
 * PATH bozuk/kırpılmış bir profilde bile `powershell.exe`/`cmd.exe` bulunabilmeli
 * (rehber pane'i ve batch sarmalayıcı onlara dayanıyor) — macOS listesinin
 * `/usr/bin`, `/bin` maddelerinin karşılığı.
 */
function extraPathDirs(opts = {}) {
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const home = opts.home || (env.USERPROFILE && platform === 'win32' ? env.USERPROFILE : nodeOs.homedir());

  if (platform !== 'win32') {
    return [
      '/opt/homebrew/bin',
      '/usr/local/bin',
      nodePath.posix.join(home, '.local', 'bin'),
      nodePath.posix.join(home, 'bin'),
      nodePath.posix.join(home, '.npm-global', 'bin'),
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ];
  }

  const join = nodePath.win32.join;
  const appData = env.APPDATA || join(home, 'AppData', 'Roaming');
  const localAppData = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  const systemRoot = env.SystemRoot || env.windir || 'C:\\Windows';
  return [
    join(home, '.local', 'bin'), // claude — resmi native installer (792 §1.1)
    join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin'), // codex — resmi installer (792 §1.2)
    join(localAppData, 'cursor-agent'), // cursor — satıcının win32 installer'ı (WIN-PARITY-01)
    join(appData, 'npm'), // npm -g (kataloğun gemini/opencode yolu)
    join(localAppData, 'Microsoft', 'WinGet', 'Links'), // winget shim'leri
    join(programFiles, 'Git', 'bin'), // Git for Windows (claude'un Bash aracı)
    join(systemRoot, 'System32'),
    systemRoot,
    join(systemRoot, 'System32', 'Wbem'),
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
  ];
}

/**
 * `basePath`'e sabit dizinleri EKLER (sona — mevcut girdilerin önceliği korunur;
 * e2e'nin sahte-CLI ön-ek deseni buna dayanıyor). Idempotent: tekrar çağırmak
 * hiçbir şey değiştirmez.
 */
function augment(basePath, opts = {}) {
  const platform = opts.platform || process.platform;
  const delimiter = platform === 'win32' ? nodePath.win32.delimiter : nodePath.posix.delimiter;
  const cur = String(basePath || '').split(delimiter).filter(Boolean);
  // Windows yolları harf-duyarsızdır: `C:\Windows\System32` ile `c:\windows\system32`
  // aynı dizindir → tekrar üretmemek için karşılaştırma orada küçük harfle yapılır.
  const norm = (d) => (platform === 'win32' ? d.toLowerCase() : d);
  const seen = new Set(cur.map(norm));
  for (const dir of extraPathDirs({ ...opts, platform })) {
    if (!seen.has(norm(dir))) {
      cur.push(dir);
      seen.add(norm(dir));
    }
  }
  return cur.join(delimiter);
}

/**
 * ENG-ACC-P1 — MOTOR HUNİLERİNİN ORTAK ENV'İ (üç huni, TEK yardımcı).
 *
 * ÖLÇÜLDÜ (ENG-ACC-P0 §2.2-2.6): Dock/Finder'dan açılan app launchd'nin çıplak
 * PATH'ini (`/usr/bin:/bin:/usr/sbin:/sbin`) miras alır. Motor tespiti bunu telafi
 * etmediği için KURULU + GİRİŞLİ motorlar ekranda "Motor kurulu değil" /
 * "Durum okunamadı" görünüyordu — 13 motorun 12'si YANLIŞ. İki ayrı mekanizma,
 * tek kök neden:
 *   1) `$SHELL -lc` probu: `zsh -l` login AMA İNTERAKTİF DEĞİL → `.zshrc` OKUNMAZ
 *      → `~/.local/bin` (claude native installer'ın RESMÎ hedefi) PATH'e hiç girmez.
 *   2) durum/giriş komutları: motorların çoğu `#!/usr/bin/env node` script'i →
 *      çıplak PATH'te `node` bulunamaz → `env: node: No such file or directory`,
 *      rc=127, stdout boş → rozet "Durum okunamadı"da kalır.
 *
 * Bu yüzden PATH düzeltmesi ARAMAYA da ÇALIŞTIRMAYA da uygulanmak zorundadır;
 * yalnız birini düzeltmek yalanın yarısını bırakır.
 *
 * Sözleşme: `augment` idempotent ve EKLEMELİ (mevcut girdilerin önceliği korunur)
 * → e2e'nin sahte-CLI ön-ek deseni bozulmaz, tekrar çağırmak hiçbir şeyi değiştirmez.
 * `readRegistry:false` — bu yol her motor için sıcak çağrılır; senkron `reg.exe`
 * çatallamak burada bedeldir. Windows'ta PATH zaten kırpılmaz (yapısal), taze
 * registry okuması motor ÇÖZÜMLEME yolunda (`freshPath`) kalır.
 *
 * @returns {object} `env`'in SIĞ KOPYASI — girdi nesnesi ASLA mutasyona uğramaz
 *          (çağıranların çoğu `process.env` geçiyor).
 */
function withAugmentedPath(env, opts = {}) {
  const platform = opts.platform || process.platform;
  const src = env || process.env;
  const out = { ...src };
  if (platform === 'win32') {
    // Windows env adları HARF-DUYARSIZDIR: `{...process.env}` çoğunlukla `Path`
    // anahtarını taşır; yanına bir de `PATH` yazmak çocuk sürece İKİ girdi
    // gönderirdi ve hangisinin kazandığı libuv'un sıralamasına kalırdı. Tek
    // anahtar bırakılır.
    for (const k of Object.keys(out)) if (k.toUpperCase() === 'PATH') delete out[k];
  }
  out.PATH = augment(platform === 'win32' ? getPathVar(src) : src.PATH, { ...opts, platform, env: src, readRegistry: false });
  return out;
}

/** `%VAR%` referanslarını env'den genişletir (REG_EXPAND_SZ değerleri için). Saf. */
function expandEnvStrings(value, env) {
  const e = env || {};
  return String(value == null ? '' : value).replace(/%([^%]+)%/g, (whole, name) => {
    const hit = Object.keys(e).find((k) => k.toLowerCase() === String(name).toLowerCase());
    return hit && typeof e[hit] === 'string' ? e[hit] : whole; // çözülemeyen referans AYNEN kalır
  });
}

/** `reg query … /v Path` çıktısından değeri ayıklar. Saf. → string | null */
function parseRegQueryPath(stdout) {
  const m = /^[ \t]*Path[ \t]+REG_(?:EXPAND_)?SZ[ \t]+(.*)$/im.exec(String(stdout || ''));
  return m ? m[1].trim() : null;
}

/**
 * TEK bir registry anahtarından PATH okur (kabuksuz, argüman dizisiyle).
 * → { state:'present', path } | { state:'absent' } | { state:'unknown', reason }
 */
function readRegistryKeyPath(key, deps = {}) {
  const execFileSync = deps.execFileSync || nodeChildProcess.execFileSync;
  const env = deps.env || process.env;
  const systemRoot = (env && (env.SystemRoot || env.windir)) || 'C:\\Windows';
  // reg.exe MUTLAK yolla çağrılır: PATH bayat/bozuk olabilir — onu ölçmeye
  // çalışırken yine PATH'e güvenmek dairesel olurdu.
  const regExe = deps.regExe || nodePath.win32.join(systemRoot, 'System32', 'reg.exe');
  try {
    const out = execFileSync(regExe, ['query', key, '/v', 'Path'], {
      encoding: 'utf8',
      timeout: deps.timeoutMs || REG_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const value = parseRegQueryPath(out);
    if (!value) return { state: 'absent' };
    return { state: 'present', path: expandEnvStrings(value, env) };
  } catch (e) {
    // reg.exe "değer/anahtar bulunamadı" için ÇIKIŞ 1 döner — bu bir ölçüm sonucudur
    // (kullanıcı PATH'i tanımlı olmayabilir), hata değil. Başka her şey ölçememektir.
    if (e && e.status === 1) return { state: 'absent' };
    return { state: 'unknown', reason: e && e.code ? String(e.code) : 'reg-failed' };
  }
}

/**
 * Registry'deki GÜNCEL PATH (sistem + kullanıcı, Windows'un birleştirme sırasıyla).
 * → { state, path?, reason?, system, user }
 *
 * win32 dışında: `{ state:'absent', reason:'not-win32' }` — orada registry YOKTUR,
 * bu bir ölçüm başarısızlığı değil, doğru cevaptır (macOS'ta çağıran hiçbir şey yapmaz).
 */
function readRegistryPath(deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform !== 'win32') return { state: 'absent', reason: 'not-win32', system: null, user: null };
  const system = readRegistryKeyPath(deps.systemKey || HKLM_ENV_KEY, deps);
  const user = readRegistryKeyPath(deps.userKey || HKCU_ENV_KEY, deps);
  const parts = [];
  if (system.state === 'present') parts.push(system.path);
  if (user.state === 'present') parts.push(user.path);
  if (parts.length) return { state: 'present', path: parts.join(';'), system, user };
  if (system.state === 'unknown' || user.state === 'unknown') {
    return { state: 'unknown', reason: (system.reason || user.reason || 'reg-failed'), system, user };
  }
  return { state: 'absent', system, user };
}

/**
 * Motor keşfi için EN İYİ PATH: süreç PATH'i + (win32) registry'den TAZE okunan
 * PATH + sabit dizinler. Sıra kasıtlı: süreç PATH'i ÖNCE gelir (e2e'nin sahte-CLI
 * ön-eki kazanmaya devam etsin), taze/registry ve sabitler SONA eklenir.
 *
 * → { path, registry } — `registry` üç-durumlu okuma sonucudur; çağıran
 *   "ölçemedim"i kullanıcıya farklı gösterebilsin diye AYNEN taşınır.
 */
function freshPath(opts = {}) {
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const base = opts.basePath !== undefined ? opts.basePath : (platform === 'win32' ? getPathVar(env) : env.PATH);
  const registry = platform === 'win32' && opts.readRegistry !== false
    ? readRegistryPath({ ...opts, platform, env })
    : { state: 'absent', reason: platform === 'win32' ? 'skipped' : 'not-win32', system: null, user: null };
  const delimiter = platform === 'win32' ? nodePath.win32.delimiter : nodePath.posix.delimiter;
  const merged = registry.state === 'present' ? [base, registry.path].filter(Boolean).join(delimiter) : base;
  return { path: augment(merged, { ...opts, platform, env }), registry };
}

/**
 * WIN-PARITY-01 — PATH'İ, ORTAMIN ZATEN KULLANDIĞI HARFLE YAZ.
 *
 * 🔴 GERÇEK WINDOWS'TA ÖLÇÜLDÜ (CI koşumu 34370550221): Windows ortam değişkenini
 * **`Path`** diye bildirir. Kod düz nesneye `env.PATH = …` yazınca ortamda İKİ
 * anahtar doğar: önce `Path` (orijinal), sonra `PATH` (zenginleştirilmiş).
 *
 * `node-pty` bunları AYIKLAMAZ — `terminal.js:_parseEnv` `Object.keys`i olduğu gibi
 * `k=v` çiftlerine çevirir (Node'un kendi `child_process`i Windows'ta yinelenenleri
 * eler, node-pty ELEMEZ). Windows süreç ortam bloğunda arama İLK eşleşmeyi bulur ve
 * `Path` blokta önce geldiği için **zenginleştirilmiş PATH hiç okunmaz.**
 *
 * Sessiz ve iki yönlü sonuç: (a) `augment()`in eklediği motor dizinleri pane'de
 * görünmez, (b) KILL-GUARD-01'in KAPI 2 sarmalayıcı dizini PATH'in başına konmuş
 * SAYILIR ama etkili olmaz. Bu iki yardımcı değeri ortamın ZATEN taşıdığı anahtara
 * yazar/okur ve ikinci bir anahtar DOĞURMAZ.
 *
 * (Bu modülde durmalarının sebebi: `agentRunner` node-pty çeker, bu dosya hiçbir şey
 * çekmez → platform sondası `npm ci`den ÖNCE de nöbetçilik edebiliyor.)
 *
 * @param {Record<string,string>} env yerinde değiştirilir
 * @returns {string} yazılan anahtarın adı
 */
function setPathVar(env, value) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  env[key] = value;
  return key;
}

/** Ortamın PATH değeri — anahtarın harfi ne olursa olsun. */
function getPathVar(env) {
  const key = Object.keys(env || {}).find((k) => k.toUpperCase() === 'PATH');
  return key ? env[key] : undefined;
}

module.exports = {
  setPathVar,
  getPathVar,
  HKCU_ENV_KEY,
  HKLM_ENV_KEY,
  REG_TIMEOUT_MS,
  extraPathDirs,
  augment,
  withAugmentedPath,
  expandEnvStrings,
  parseRegQueryPath,
  readRegistryKeyPath,
  readRegistryPath,
  freshPath,
};
