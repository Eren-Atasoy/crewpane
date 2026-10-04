// ADP-833 (ADR-W7 · ADR-W10 Kural 2) — İKİLİ ÇÖZÜMÜ: PATH + PATHEXT + ayırıcı farkındalığı.
//
// NEDEN VAR (790 M3 ölçtü). `engineInstall.resolveBinary` bugün iki POSIX varsayımı
// taşıyor ve Windows'ta İKİSİ de yanlış:
//   1. "yol içeriyor mu" testi `raw.includes('/')` — Windows ayırıcısı `\` hiç
//      düşünülmemiş: `C:\Users\X\bin\claude.exe` PATH'te ARANIR (execvp semantiği
//      yanlış uygulanır) ve elbette bulunamaz.
//   2. PATHEXT yok: aranan ad çıplak `claude`. Windows'ta çalıştırılabilir dosya
//      `claude.exe` / `claude.cmd`'dir; uzantısız dosya CreateProcess ile
//      ÇALIŞTIRILAMAZ. Yani motor kurulu olsa bile "kurulu değil" denir.
//
// ÜÇ-DURUMLU SÖZLEŞME (ADR-W7 · ADR-W10 Kural 3). Bugünkü kod "bulamadım" ile
// "ÖLÇEMEDİM"i aynı `null`'a katlıyor. Burada ayrılıyorlar:
//   { state:'present', path }        → ölçtüm, var
//   { state:'absent' }               → ölçtüm, yok
//   { state:'unknown', reason }      → ölçemedim (beklenmedik fs hatası, PATH yok)
// `resolveBinary` (string|null) geriye-uyum için KORUNUYOR — çağıranların imzası
// değişmiyor (ADR-W10 Kural 2); üç-durumu isteyen `resolveBinaryState`i çağırır.
//
// macOS DAVRANIŞI BİT-BİT AYNI: darwin dalı bugünkü algoritmanın kendisidir
// (`/` testi, PATH taraması, statSync+X_OK). PATHEXT/`\`/tırnak mantığı YALNIZ
// win32 dalında yaşar; birim testleri iki dalı da platform enjeksiyonuyla koşturur.
'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { getPathVar } = require('./envPath.cjs');

/** Windows'ta PATHEXT tanımsızsa CreateProcess/cmd'nin varsayılanı. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** Node `spawn`'ın win32'de kabuk OLMADAN çalıştıramadığı uzantılar (batch dosyaları). */
const BATCH_EXTS = Object.freeze(['.cmd', '.bat']);

/** `PATHEXT` → normalize edilmiş uzantı listesi (küçük harf, noktalı, tekil). */
function pathExtList(env) {
  const raw = env && typeof env.PATHEXT === 'string' && env.PATHEXT.trim() ? env.PATHEXT : DEFAULT_PATHEXT;
  const out = [];
  const seen = new Set();
  for (const part of raw.split(';')) {
    const ext = part.trim().toLowerCase();
    if (!ext) continue;
    const dotted = ext.startsWith('.') ? ext : `.${ext}`;
    if (seen.has(dotted)) continue;
    seen.add(dotted);
    out.push(dotted);
  }
  return out.length ? out : DEFAULT_PATHEXT.split(';').map((e) => e.toLowerCase());
}

/**
 * Windows PATH girdileri ve komut hedefleri tırnaklı gelebilir (registry'den okunan
 * PATH'te `"C:\Program Files\Git\bin"` yaygındır). Tırnak dosya adının parçası değil.
 */
function stripQuotes(value) {
  const s = String(value == null ? '' : value).trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).trim();
  return s;
}

/** win32'de hem `/` hem `\` ayırıcıdır; darwin'de yalnız `/`. */
function hasPathSeparator(raw, platform) {
  return platform === 'win32' ? /[\\/]/.test(raw) : raw.includes('/');
}

/**
 * Bir hedef için denenecek somut dosya adları (win32 PATHEXT genişletmesi).
 * • Ad zaten PATHEXT'teki bir uzantıyı taşıyorsa: yalnız kendisi.
 * • Taşımıyorsa: her uzantı SIRAYLA eklenir (cmd.exe'nin davranışı).
 *   Çıplak ad BİLEREK denenmez — uzantısız dosya Windows'ta çalıştırılamaz;
 *   onu "bulundu" saymak bugünkü sessiz kırılmanın Windows'a taşınması olurdu.
 */
function candidatesFor(raw, exts, platform) {
  if (platform !== 'win32') return [raw];
  const lower = raw.toLowerCase();
  if (exts.some((ext) => lower.endsWith(ext))) return [raw];
  return exts.map((ext) => raw + ext);
}

/**
 * Tek bir somut yolun çalıştırılabilir bir DOSYA olup olmadığı.
 * → true | false | 'unknown' (beklenmedik fs hatası: ölçemedim)
 *
 * ENOENT/ENOTDIR/EACCES/EPERM/ELOOP = ölçüm sonucu "yok/erişemiyorum" → false.
 * Başka bir kod (EIO, EBUSY, EMFILE…) ölçümün KENDİSİNİN başarısız olması → 'unknown'.
 */
function probeFile(fs, p, platform) {
  const X_OK = (fs.constants && fs.constants.X_OK) || 1;
  const F_OK = (fs.constants && fs.constants.F_OK) || 0;
  try {
    if (!fs.statSync(p).isFile()) return false; // dizin de X_OK geçer — dosya şart
    // Windows'ta X_OK anlamsızdır (Node dokümanı: F_OK'a eşdeğer) ve dosya
    // uzantısı zaten çalıştırılabilirliği belirler → orada F_OK sorulur.
    fs.accessSync(p, platform === 'win32' ? F_OK : X_OK);
    return true;
  } catch (e) {
    const code = e && e.code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM' || code === 'ELOOP' || code === 'ENAMETOOLONG') {
      return false;
    }
    return 'unknown';
  }
}

/**
 * `file`'ı bu env'in PATH'inde çalıştırılabilir bir dosya olarak çözer.
 * → { state:'present', path } | { state:'absent' } | { state:'unknown', reason }
 *
 * `deps.fs` ve `deps.platform` enjekte edilebilir (Windows dalı macOS'ta koşturulur).
 */
function resolveBinaryState(file, env, deps = {}) {
  const fs = deps.fs || nodeFs;
  const platform = deps.platform || process.platform;
  // Yol birleştirme/ayırıcı PLATFORMDAN gelir, koşan makineden değil: gerçek
  // Windows'ta `nodePath` zaten win32'dir, macOS'ta ise enjekte edilen win32 dalının
  // GERÇEKTEN Windows semantiğiyle koşmasını (ters-bölü + `;`) bu sağlar.
  const P = platform === 'win32' ? nodePath.win32 : nodePath.posix;
  const raw = platform === 'win32' ? stripQuotes(file) : (typeof file === 'string' ? file.trim() : '');
  if (!raw) return { state: 'absent' };

  const exts = platform === 'win32' ? pathExtList(env) : [];
  let sawUnknown = false;
  const check = (p) => {
    const r = probeFile(fs, p, platform);
    if (r === 'unknown') sawUnknown = true;
    return r === true;
  };

  // Yol içeren bir hedef (mutlak ya da göreli) PATH'te ARANMAZ — execvp semantiği.
  // win32'de yol-nitelikli ada da PATHEXT uygulanır (cmd.exe aynısını yapar).
  if (hasPathSeparator(raw, platform)) {
    for (const cand of candidatesFor(raw, exts, platform)) {
      if (check(cand)) return { state: 'present', path: cand };
    }
    return sawUnknown ? { state: 'unknown', reason: 'fs-error' } : { state: 'absent' };
  }

  const inheritedPath = platform === 'win32' ? getPathVar(env) : env && env.PATH;
  const pathVar = typeof inheritedPath === 'string' ? inheritedPath : '';
  if (!pathVar) {
    // PATH hiç yoksa arama YAPILAMADI — "yok" demek yalan olurdu (ADR-W7).
    return { state: 'unknown', reason: 'no-path-var' };
  }
  for (const entry of pathVar.split(P.delimiter)) {
    const dir = platform === 'win32' ? stripQuotes(entry) : entry;
    if (!dir) continue;
    for (const cand of candidatesFor(raw, exts, platform)) {
      // P.join Windows'ta ters-bölü üretir; POSIX'te bugünkü davranışın aynısı.
      const full = P.join(dir, cand);
      if (check(full)) return { state: 'present', path: full };
    }
  }
  return sawUnknown ? { state: 'unknown', reason: 'fs-error' } : { state: 'absent' };
}

/**
 * Geriye-uyumlu sarmalayıcı: çözülen mutlak yol, yoksa null.
 * `unknown` da null döner — bugünkü çağıranlar (spawn ön-kontrolü) için "çalıştırma"
 * kararı değişmez; üç-durumu ISTEYEN çağıran `resolveBinaryState` kullanır.
 */
function resolveBinary(file, env, deps = {}) {
  const r = resolveBinaryState(file, env, deps);
  return r.state === 'present' ? r.path : null;
}

/**
 * Çözülmüş bir ikiliyi ÇALIŞTIRMAK için gereken (file, argv) çifti.
 *
 * NEDEN VAR (Windows'a özgü, macOS'ta karşılığı YOK): `claude.cmd` / `codex.cmd`
 * (npm ile kurulan yol) bir BATCH dosyasıdır — CreateProcess onu doğrudan
 * çalıştıramaz, Node `child_process.spawn` da kabuk olmadan reddeder. Yorumlayıcı
 * `cmd.exe`dir. Native installer `.exe` kurduğu için bu yalnız npm yolunu kurtarır,
 * ama o yolu KATALOĞUMUZ öneriyor (gemini/opencode) → sessiz bırakılamaz.
 *
 * ── ADP-893 (P0 canlı müşteri) — ÖNCEKİ SARMALAYICI ÜÇ YERDEN BOZUKTU ───────
 * Eski hâli `argv: ['/d','/s','/c', '"file" "a" "b"']` döndürüyordu. Üç ayrı kırılma:
 *
 *  (a) NODE DİZEYİ TEKRAR KAÇIŞLAR. `argv[3]` boşluk+tırnak içerdiği için libuv'un
 *      `quote_cmd_arg`'ı onu ters-bölü ile kaçışlar → cmd.exe'ye
 *      `/d /s /c "\"codex.cmd\" \"login\""` gider. cmd.exe `\"` diye bir kaçış
 *      TANIMAZ → komut adı `\"codex.cmd\"` olur, çalıştırılamaz. Çözüm:
 *      `windowsVerbatimArguments` — komut satırını BİZ kuruyoruz, Node dokunmuyor.
 *
 *  (b) `/s` ZATEN DIŞ ÇİFT İSTİYOR. `cmd /?`: `/s` verildiğinde "ilk ve son tırnak
 *      karakteri kaldırılır". `"file" "a"` biçiminde bir dizede bu, `file" "a`
 *      bırakır. Doğru deyim komutun TAMAMINI fazladan bir dış çiftle sarmaktır:
 *      `/d /s /c ""file" "a""`.
 *
 *  (c) CMD KOMUT SATIRI SATIR SONUNDA KESİLİR. Yukarıdaki "argümanlar sabit ürün
 *      değerleri" varsayımı `engineAuth` için doğru ama PANE yolu (`main.js`) için
 *      YANLIŞ: oraya codex'in ÇOK SATIRLI pozisyonel kimlik prompt'u giriyor
 *      (ölçüldü: 13 argv elemanının 1'inde CR/LF, 7'sinde tırnak). Bir CR/LF komutu
 *      ortasından böler → codex bozuk argv ile ölür → pane açılıp kapanır.
 *      Çözüm: batch dalında CR/LF boşluğa indirgenir (içerik korunur, komut yaşar).
 *
 * TIRNAK İKİLEME (`"` → `""`) BİLEREK KORUNDU (ters-bölü kaçışına geçilmedi): cmd'nin
 * tırnak PARİTESİ böyle bozulmaz, dolayısıyla `&`/`|`/`>` gibi metakarakterler cmd'nin
 * gözünde tırnak İÇİNDE kalır. Hedef program tarafında `CommandLineToArgvW` (ve onu
 * uygulayan Rust std — codex Rust'tır) tırnak içindeki `""`yi tek `"` olarak çözer.
 * BİLİNEN SINIR: `%VAR%` genişlemesi cmd'de tırnaktan bağımsızdır; tanımsız değişken
 * aynen kalır, tanımlı olan genişler.
 *
 * win32 DIŞINDA ve batch OLMAYAN hedeflerde: girdi aynen döner (macOS bit-bit aynı).
 *
 * → { file, argv, windowsVerbatimArguments?, commandLine? }
 *   `windowsVerbatimArguments` DÖNDÜĞÜNDE çağıran onu spawn/execFile seçeneklerine
 *   GEÇİRMEK ZORUNDADIR (yoksa (a) geri gelir). `commandLine` node-pty'nin string-args
 *   ("pre-escaped CommandLine") yolu içindir.
 */

/**
 * cmd.exe komut satırı ilk CR/LF'te KESİLİR — batch yolunda satır sonları tek boşluğa
 * indirgenir. Yalnız win32-batch dalında çağrılır; kimlik/prompt metni anlamını korur. Saf.
 */
function flattenNewlines(value) {
  return String(value == null ? '' : value).replace(/\r\n|\r|\n/g, ' ');
}

function execArgs(file, argv = [], deps = {}) {
  const platform = deps.platform || process.platform;
  const list = Array.isArray(argv) ? argv : [];
  if (platform !== 'win32') return { file, argv: list };
  const lower = String(file || '').toLowerCase();
  if (!BATCH_EXTS.some((ext) => lower.endsWith(ext))) return { file, argv: list };
  const env = deps.env || process.env;
  const comSpec = (env && typeof env.ComSpec === 'string' && env.ComSpec.trim()) || 'cmd.exe';
  const inner = [file, ...list]
    .map((a) => `"${flattenNewlines(a).replace(/"/g, '""')}"`)
    .join(' ');
  // (b) — komutun TAMAMI fazladan bir dış çiftle sarılır; `/s` tam olarak onu soyar.
  const wrapped = `"${inner}"`;
  return {
    file: comSpec,
    argv: ['/d', '/s', '/c', wrapped],
    // (a) — Node/libuv bu diziye DOKUNMASIN.
    windowsVerbatimArguments: true,
    // node-pty string-args yolu: `argsToCommandLine(file, []) + ' ' + <bu dize>`.
    commandLine: `/d /s /c ${wrapped}`,
  };
}

module.exports = {
  DEFAULT_PATHEXT,
  BATCH_EXTS,
  pathExtList,
  stripQuotes,
  hasPathSeparator,
  candidatesFor,
  resolveBinary,
  resolveBinaryState,
  execArgs,
  flattenNewlines,
};
