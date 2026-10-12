// EDITOR-HIFI-F2c (HIFI-03 M5 · K3) — kod editörünün "Belgeyi biçimlendir" komutu:
// projenin KENDİ Prettier'ı, projenin kendi ayarıyla, ANA süreçte çalışır. Renderer'a
// biçimlendirici yüklenmez (0 MB); Monaco yalnız sonucu uygular.
//
//   • Çözümleme: dosyanın klasöründen yukarı yürünür, ilk `node_modules/prettier`
//     bulunan klasör PROJE KÖKÜDÜR. Yürüyüş üç yerde durur: açık köklerin (editörün
//     sandbox'ı) dışı, git deposunun kökü (monorepo kökündeki Prettier bulunur, üstü
//     değil) ve ev dizini (~/node_modules'taki bir Prettier "projenin" değildir).
//   • Proje Prettier'ı yoksa başka biçimlendirici DENENMEZ: `not-found` döner, kullanıcı
//     sade bir cümle görür.
//   • Windows tuzağı: `node_modules/.bin/prettier.cmd` bir kabuk betiğidir; execFile onu
//     kabuksuz çalıştıramaz (EINVAL/ENOENT), kabukla çalıştırmak da tırnak/boşluk riskidir.
//     Bu yüzden `.bin/` HİÇ kullanılmaz: prettier paketinin `bin` alanındaki JS dosyası
//     uygulamanın kendi node'uyla koşar (`process.execPath` + ELECTRON_RUN_AS_NODE=1) —
//     her platformda aynı yol, sistemde Node kurulu olması gerekmez.
//   • İçerik stdin'den gider (dosya diske yazılmaz), sonuç stdout'tan gelir; 5 sn zaman aşımı.
//   • Güven: projenin Prettier ayarı eklenti yükleyebilir, yani proje kodu çalışır. Renderer
//     ilk kullanımda bunu bir kez söyler (bkz. src/app/lib/editorFormat.ts).

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TIMEOUT_MS = 5000;
const MAX_CONTENT = 4 * 1024 * 1024; // editörün açtığı dosya tavanının üstü — daha büyüğü biçimlendirilmez
const MAX_BUF = 16 * 1024 * 1024;

const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

function readJson(fsImpl, file) {
  try {
    return JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function exists(fsImpl, p) {
  try {
    fsImpl.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Projenin Prettier'ını bul. `inside(dir)` yürüyüşün sınırıdır (açık köklerin içinde mi);
 * `platform` + `fsImpl` + `home` birim testi için (Windows yolu bu makinede de sınanır).
 * → { ok:true, projectRoot, binJs, version } | { ok:false, reason:'not-found' }
 */
function findPrettier(filePath, { inside = () => true, platform = process.platform, fsImpl = fs, home = os.homedir() } = {}) {
  const P = pathFor(platform);
  if (typeof filePath !== 'string' || !P.isAbsolute(filePath)) return { ok: false, reason: 'not-found' };
  const homeDir = home ? P.resolve(home) : null;
  let dir = P.dirname(filePath);
  while (inside(dir) && dir !== homeDir) {
    const pkgDir = P.join(dir, 'node_modules', 'prettier');
    const pkg = readJson(fsImpl, P.join(pkgDir, 'package.json'));
    if (pkg) {
      // `bin` dize ("./bin/prettier.cjs", v3) ya da nesne ({ prettier: "./bin-prettier.js" }, v2).
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && typeof pkg.bin.prettier === 'string' ? pkg.bin.prettier : null;
      const binJs = bin ? P.join(pkgDir, bin) : null;
      if (binJs && exists(fsImpl, binJs)) {
        return { ok: true, projectRoot: dir, binJs, version: typeof pkg.version === 'string' ? pkg.version : null };
      }
    }
    if (exists(fsImpl, P.join(dir, '.git'))) break; // depo kökü proje sınırıdır (.git klasör ya da worktree dosyası)
    const parent = P.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { ok: false, reason: 'not-found' };
}

/** Komut satırı: ikili HER ZAMAN uygulamanın node'u, ilk argüman prettier'ın JS dosyası. */
function prettierCommand(found, filePath, { execPath = process.execPath, env = process.env, timeoutMs = TIMEOUT_MS } = {}) {
  return {
    file: execPath,
    args: [found.binJs, '--stdin-filepath', filePath],
    options: {
      cwd: found.projectRoot, // .prettierrc / .prettierignore projeye göre çözülür
      env: { ...env, ELECTRON_RUN_AS_NODE: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
      timeout: timeoutMs,
      maxBuffer: MAX_BUF,
      windowsHide: true,
    },
  };
}

const ANSI = /\u001b\[[0-9;]*m/g;

/** Prettier'ın hata çıktısını kullanıcıya söylenebilir bir nedene indirger. */
function classifyFailure(err, stderr) {
  const text = String(stderr || '').replace(ANSI, '');
  if (err && (err.killed || err.signal === 'SIGTERM') && !text.trim()) return { reason: 'timeout' };
  if (/No parser could be inferred|No parser and no file path/i.test(text)) return { reason: 'unsupported' };
  const syntax = text.match(/SyntaxError:?\s*([^\n]*)/);
  if (syntax) return { reason: 'syntax', detail: syntax[1].trim().slice(0, 200) };
  return { reason: 'failed', detail: text.split('\n').find((l) => l.trim())?.replace(/^\[error\]\s*/, '').trim().slice(0, 200) || null };
}

/** Bu dosya için biçimlendirici var mı (menünün gri/açık durumu). */
function formatStatus(filePath, opts = {}) {
  const found = findPrettier(filePath, opts);
  return found.ok ? { ok: true, available: true, version: found.version } : { ok: true, available: false };
}

/**
 * İçeriği projenin Prettier'ıyla biçimlendir. Dosyaya YAZMAZ — sonucu editör uygular,
 * kullanıcı kaydedene dek disk değişmez.
 * → { ok:true, text, changed } | { ok:false, reason:'not-found'|'too-large'|'timeout'|'unsupported'|'syntax'|'failed', detail? }
 */
function formatText({ filePath, content, inside, platform, fsImpl, home, execPath, timeoutMs, run = execFile } = {}) {
  if (typeof content !== 'string') return Promise.resolve({ ok: false, reason: 'failed', detail: null });
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT) return Promise.resolve({ ok: false, reason: 'too-large' });
  const found = findPrettier(filePath, { inside, platform, fsImpl, home });
  if (!found.ok) return Promise.resolve(found);
  const cmd = prettierCommand(found, filePath, { execPath, timeoutMs });
  return new Promise((resolve) => {
    let child;
    try {
      child = run(cmd.file, cmd.args, cmd.options, (err, stdout, stderr) => {
        if (err) return resolve({ ok: false, ...classifyFailure(err, stderr) });
        const text = String(stdout);
        resolve({ ok: true, text, changed: text !== content });
      });
    } catch (e) {
      return resolve({ ok: false, reason: 'failed', detail: String((e && e.message) || e).slice(0, 200) });
    }
    child.stdin?.on('error', () => {}); // süreç erken öldüyse EPIPE geri çağrıya düşer, burada yutulur
    child.stdin?.end(content);
  });
}

module.exports = { findPrettier, prettierCommand, classifyFailure, formatStatus, formatText, TIMEOUT_MS };
