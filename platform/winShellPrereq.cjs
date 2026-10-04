// WIN-FIRSTRUN-01 (K1) — WINDOWS'TA MOTORUN KABUK ÖN KOŞULU (spawn ÖNCESİ, senkron).
//
// ─── NEDEN ───────────────────────────────────────────────────────────────────
// RESEARCH-WIN-01 §3: yeni Windows müşterisi ilk 90 dakikada 70 pane açtı, claude
// ~35 kez 1 sn içinde `exit 1` ile öldü ve hücre anında kaybolduğu için HİÇBİR hata
// metni göremedi. En güçlü aday: claude ikilisinin KENDİ açılış kapısı — Windows'ta
// bir kabuk bulamazsa tek satır hata basıp `process.exit(1)` yapar.
//
// ─── ÖLÇÜLDÜ (claude 2.1.276 ikilisi, `strings`, RESEARCH-WIN-01 + bu kart) ────
// Açılış kapısı (init, `vYn` sabiti çevresinde):
//   if (platform==="windows" && !gitBashFound()) {
//     if (!powershellToolEnabled()) { console.error("…requires a shell tool. Git Bash
//        was not found and the PowerShell tool is disabled (CLAUDE_CODE_USE_POWERSHELL_TOOL=0)…");
//        process.exit(1) }
//     if (await findPowerShell()===null) { console.error("…requires either Git for
//        Windows (for bash) or PowerShell…"); process.exit(1) }
//   }
// gitBashFound() (`de()`), SIRAYLA:
//   1. CLAUDE_CODE_GIT_BASH_PATH — taban adı bash.exe|sh.exe|bash|sh ise VE dosya varsa
//   2. C:\Program Files\Git\bin\bash.exe  ·  C:\Program Files (x86)\Git\bin\bash.exe (SABİT yol,
//      %ProgramFiles% değil)
//   3. PATH'teki `git` → <git>\..\..\bin\bash.exe (ör. Git\cmd\git.exe → Git\bin\bash.exe)
// findPowerShell() (`lgo()`), SIRAYLA:
//   1. PATH'te `pwsh`
//   2. %ProgramFiles%\PowerShell\7\pwsh.exe · %LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe ·
//      %USERPROFILE%\.dotnet\tools\pwsh.exe
//   3. PATH'te `powershell`
//   4. %SYSTEMROOT%(yoksa C:\Windows)\System32\WindowsPowerShell\v1.0\powershell.exe  ← 5.1
// powershellToolEnabled() (`f0()`): env CLAUDE_CODE_USE_POWERSHELL_TOOL verilmişse o;
//   verilmemişse Git Bash yokken TRUE.
//
// ⚠ BU ÖLÇÜM KARTIN K1 METNİNİ DÜZELTİR: kart "Git Bash → pwsh ara, yoksa başlatma"
// diyordu. İkili Windows PowerShell 5.1'e de düşüyor (`fell_back_to_powershell_5`) ve
// 5.1 her Windows 10/11'de vardır → kartın literal hâli, claude'un ÇALIŞACAĞI bir
// makinede rehber pane açıp ajanı başlatmazdı (yanlış pozitif). Burada kapı satıcının
// kapısıyla BİREBİR aynalanır: yalnız claude'un kendisinin `exit 1` vereceği durumda
// motor başlatılmaz. Eski claude sürümlerinin (yalnız Git Bash isteyen) kapısı bu
// modülde MODELLENMEZ — sürümü spawn öncesi bilmiyoruz; o vaka K2 (erken ölüm çıktısı
// ekranda kalır) ile görünür olur.
//
// ─── TASARIM ─────────────────────────────────────────────────────────────────
// • Saf + enjekte edilebilir (`deps.fs`, `deps.platform`) → Windows dalı macOS'ta
//   `node --test` altında koşar (lesson_windows_platform_testing).
// • Hangi motorun bu kapıya tabi olduğu ADLA değil BEYANLA seçilir: descriptor
//   `install.win32Shell.kind === 'claude-shell-gate'` (engineRegistry). Beyanı olmayan
//   motor için hüküm HER ZAMAN `blocked:false` (fail-open).
// • Kontrol kolu: `CREWPANE_WIN_SHELL_PRECHECK=0` → kapı hiç bakmaz (blocked:false,
//   reason 'precheck-disabled'). Yanlış pozitif şüphesinde tek env ile kapatılır.
// • Ölçüm yapılamıyorsa (PATH yok, fs hatası) kapı AÇIK kalır: bir ölçüm hatası
//   kullanıcıyı çalışan bir motordan etmemeli (ADR-W7 ile aynı ilke).

'use strict';

const nodeFs = require('fs');
const nodePath = require('path');
const binResolve = require('./binResolve.cjs');

/** Descriptor beyanı: `install.win32Shell.kind` bu değerse kapı uygulanır. */
const CLAUDE_SHELL_GATE = 'claude-shell-gate';

/** Kontrol kolu env'i (crewpaneEnv.readEnv tabanı): `CREWPANE_WIN_SHELL_PRECHECK=0`. */
const PRECHECK_ENV_BASE = 'WIN_SHELL_PRECHECK';

/** `de()` kabul ettiği taban adları. */
const GIT_BASH_BASENAMES = Object.freeze(['bash.exe', 'sh.exe', 'bash', 'sh']);

/** `de()` sabit yolları (ikili %ProgramFiles% okumaz — SABİT). */
const GIT_BASH_FIXED_PATHS = Object.freeze([
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
]);

/** Kullanıcıya gösterilen tek kurulum bağlantısı (ikilinin kendi mesajındaki adres). */
const GIT_FOR_WINDOWS_URL = 'https://git-scm.com/downloads/win';

function envGet(env, name) {
  if (!env) return undefined;
  if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
  // Windows env anahtarları büyük/küçük harf duyarsızdır (ProgramFiles / PROGRAMFILES).
  const upper = String(name).toUpperCase();
  for (const k of Object.keys(env)) if (k.toUpperCase() === upper) return env[k];
  return undefined;
}

/** `probeFile` benzeri: dosya var mı? Hata → 'unknown' (kapı açık kalır). */
function fileExists(fs, p) {
  try {
    return fs.statSync(p).isFile();
  } catch (e) {
    const code = e && e.code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM' || code === 'ELOOP' || code === 'ENAMETOOLONG') return false;
    return 'unknown';
  }
}

/**
 * `f0()` — PowerShell aracı açık mı? Env verilmemişse (Git Bash yokken) AÇIK.
 * İkili değeri boolean'a çevirir; kapalı sayılan dizgiler: 0 / false / no / off.
 */
function powershellToolEnabled(env) {
  const raw = envGet(env, 'CLAUDE_CODE_USE_POWERSHELL_TOOL');
  if (raw === undefined || raw === null || String(raw).trim() === '') return true;
  return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

/**
 * `de()` — Git Bash'i ikilinin sırasıyla ara.
 * → { path } | null | 'unknown'
 */
function findGitBash(env, deps = {}) {
  const fs = deps.fs || nodeFs;
  const P = nodePath.win32;
  let sawUnknown = false;
  const probe = (p) => {
    const r = fileExists(fs, p);
    if (r === 'unknown') sawUnknown = true;
    return r === true;
  };

  const pinned = envGet(env, 'CLAUDE_CODE_GIT_BASH_PATH');
  if (typeof pinned === 'string' && pinned.trim()) {
    const base = P.basename(pinned.trim()).toLowerCase();
    if (GIT_BASH_BASENAMES.includes(base) && probe(pinned.trim())) return { path: pinned.trim(), via: 'env' };
    // ikili burada uyarı basıp OTOMATİK TESPİTE düşer — biz de düşeriz.
  }
  for (const p of GIT_BASH_FIXED_PATHS) if (probe(p)) return { path: p, via: 'fixed' };

  const git = binResolve.resolveBinaryState('git', env, { fs, platform: 'win32' });
  if (git.state === 'unknown') sawUnknown = true;
  if (git.state === 'present' && git.path) {
    // İkili `path.join(<git.exe TAM yolu>, '..', '..', 'bin', 'bash.exe')` yapar —
    // dosya adından bir üst, oradan bir üst: Git\cmd\git.exe → Git\bin\bash.exe.
    const cand = P.join(git.path, '..', '..', 'bin', 'bash.exe');
    if (probe(cand)) return { path: cand, via: 'git-on-path' };
  }
  return sawUnknown ? 'unknown' : null;
}

/**
 * `lgo()` — PowerShell'i ikilinin sırasıyla ara (5.1 dahil).
 * → { path, kind:'pwsh'|'powershell-5' } | null | 'unknown'
 */
function findPowerShell(env, deps = {}) {
  const fs = deps.fs || nodeFs;
  const P = nodePath.win32;
  let sawUnknown = false;
  const probe = (p) => {
    const r = fileExists(fs, p);
    if (r === 'unknown') sawUnknown = true;
    return r === true;
  };
  const onPath = (name) => {
    const r = binResolve.resolveBinaryState(name, env, { fs, platform: 'win32' });
    if (r.state === 'unknown') sawUnknown = true;
    return r.state === 'present' ? r.path : null;
  };

  const pwsh = onPath('pwsh');
  if (pwsh) return { path: pwsh, kind: 'pwsh', via: 'path' };

  const programFiles = envGet(env, 'ProgramFiles');
  const localAppData = envGet(env, 'LOCALAPPDATA');
  const userProfile = envGet(env, 'USERPROFILE');
  const fallbacks = [
    programFiles ? P.join(programFiles, 'PowerShell', '7', 'pwsh.exe') : null,
    localAppData ? P.join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe') : null,
    userProfile ? P.join(userProfile, '.dotnet', 'tools', 'pwsh.exe') : null,
  ].filter(Boolean);
  for (const p of fallbacks) if (probe(p)) return { path: p, kind: 'pwsh', via: 'fallback-path' };

  const ps5 = onPath('powershell');
  if (ps5) return { path: ps5, kind: 'powershell-5', via: 'path' };
  const systemRoot = envGet(env, 'SYSTEMROOT') || 'C:\\Windows';
  const ps5Fixed = P.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (probe(ps5Fixed)) return { path: ps5Fixed, kind: 'powershell-5', via: 'system32' };

  return sawUnknown ? 'unknown' : null;
}

/**
 * claude'un Windows kabuk kapısının AYNASI.
 * → { blocked:false, reason, shell? } | { blocked:true, reason:'no-shell'|'powershell-tool-disabled' }
 */
function claudeShellVerdict(env, deps = {}) {
  const gitBash = findGitBash(env, deps);
  if (gitBash && gitBash !== 'unknown') return { blocked: false, reason: 'git-bash', shell: { kind: 'git-bash', ...gitBash } };
  if (gitBash === 'unknown') return { blocked: false, reason: 'unmeasurable:git-bash' };
  if (!powershellToolEnabled(env)) return { blocked: true, reason: 'powershell-tool-disabled' };
  const ps = findPowerShell(env, deps);
  if (ps && ps !== 'unknown') return { blocked: false, reason: ps.kind, shell: ps };
  if (ps === 'unknown') return { blocked: false, reason: 'unmeasurable:powershell' };
  return { blocked: true, reason: 'no-shell' };
}

/**
 * Spawn yolunun sorduğu TEK soru: bu motoru bu env'de başlatırsam açılışta ölür mü?
 *
 * @param {object} o
 * @param {string} o.engineId            spawn planındaki motor anahtarı
 * @param {object} [o.env]               node-pty'ye gidecek env (PATH hunisinden geçmiş)
 * @param {string} [o.platform]          varsayılan process.platform
 * @param {boolean} [o.enabled]          kontrol kolu (CREWPANE_WIN_SHELL_PRECHECK !== '0')
 * @param {object} [o.descriptor]        engineRegistry.getEngine(engineId) (enjekte edilebilir)
 * @param {object} [o.deps]              { fs }
 * @returns {{blocked:false, reason:string} | {blocked:true, reason:string, engineId:string, docsUrl:string}}
 */
function shellPrereqVerdict(o = {}) {
  const platform = o.platform || process.platform;
  if (platform !== 'win32') return { blocked: false, reason: 'not-win32' };
  if (o.enabled === false) return { blocked: false, reason: 'precheck-disabled' };
  const install = o.descriptor && o.descriptor.install;
  const kind = install && install.win32Shell && install.win32Shell.kind;
  if (kind !== CLAUDE_SHELL_GATE) return { blocked: false, reason: 'no-declaration' };
  const v = claudeShellVerdict(o.env || {}, o.deps || {});
  if (!v.blocked) return v;
  return {
    blocked: true,
    reason: v.reason,
    engineId: String(o.engineId || (o.descriptor && o.descriptor.id) || '?'),
    docsUrl: (install.win32Shell && install.win32Shell.docsUrl) || GIT_FOR_WINDOWS_URL,
  };
}

const ESC = '\x1b';
const warn = (s) => `${ESC}[33m${s}${ESC}[0m`;
const cyan = (s) => `${ESC}[36m${s}${ESC}[0m`;
const dim = (s) => `${ESC}[2m${s}${ESC}[0m`;

/**
 * Rehber pane'ine basılan metin — İKİ DİLDE (ilk blok etkin arayüz dili, ikinci blok
 * diğeri). Neden iki dil: bu ilk-gün pane'idir, dil ayarı henüz kullanıcının
 * seçtiği dil olmayabilir; yanlış dilde tek bir blok "hiç metin yok" kadar kötüdür.
 * Metin İÇ MEKANİZMA taşımaz (pty/exit kodu/env adı YOK — feedback_ui_copy_no_internals).
 *
 * @param {object} verdict shellPrereqVerdict'in blocked:true sonucu
 * @param {object} o { t:(key, params, locale)=>string, locale:'tr'|'en', label:string }
 */
function missingShellBanner(verdict, o = {}) {
  const t = typeof o.t === 'function' ? o.t : () => '';
  const first = o.locale === 'en' ? 'en' : 'tr';
  const second = first === 'tr' ? 'en' : 'tr';
  const label = o.label || 'Claude Code';
  const url = (verdict && verdict.docsUrl) || GIT_FOR_WINDOWS_URL;
  const block = (loc) => [
    warn(`⚠  ${t('main.pane.shellMissing.title', { label }, loc)}`),
    '',
    t('main.pane.shellMissing.body', { label }, loc),
    '',
    `    ${cyan(url)}`,
    '',
    dim(t('main.pane.shellMissing.after', {}, loc)),
  ];
  const lines = ['', ...block(first), '', dim('────────'), '', ...block(second), ''];
  return lines.join('\r\n') + '\r\n';
}

module.exports = {
  CLAUDE_SHELL_GATE,
  PRECHECK_ENV_BASE,
  GIT_BASH_BASENAMES,
  GIT_BASH_FIXED_PATHS,
  GIT_FOR_WINDOWS_URL,
  powershellToolEnabled,
  findGitBash,
  findPowerShell,
  claudeShellVerdict,
  shellPrereqVerdict,
  missingShellBanner,
};
