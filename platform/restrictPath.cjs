// ADP-835 (790 I1/I2/I3 · ADR-W10 Kural 2) — DOSYA/DİZİN KISITLAMASININ TEK BOĞAZI.
//
// NEDEN VAR (790 I1-I3 ölçtü). Ağaç, sırların diskteki korumasını POSIX izin
// bitlerine bağlıyor: `auth/` ve `credentials/` `0o700`, oturum/lisans blob'ları,
// mobil eşleştirme jetonları, MCP config ve lider makbuzu `0o600`.
//
// WINDOWS'TA BU BİTLER SESSİZCE ANLAMSIZ. Node'un `fs.chmodSync`i Windows'ta
// SALT-OKUNUR bayrağından başka HİÇBİR ŞEY yapmaz; `mkdirSync(..., {mode})` ve
// `writeFileSync(..., {mode})` izin bitlerini TAMAMEN yok sayar. Dosya, üst
// dizinden MİRAS ALINAN ACL ile oluşur — tipik bir kullanıcı profilinde bu ACL
// yerel Administrators'ı ve çoğu kurulumda `Users` grubunu içerir.
//
// SESSİZLİK BURADA: kod `chmodSync(file, 0o600)` çağırır, hata FIRLATMAZ, log'a
// hiçbir şey düşmez — yani sistem "sırrı kısıtladım" der ve bu YALANDIR (790'ın
// 🔇 işareti). ADP-771 dersinin izin hâli: doğru görünen kod, kullanıcıda olmayan
// koruma.
//
// KAPSAMIN DÜRÜST SINIRI (790 I2). `safeStorage` Windows'ta DPAPI'dir ve DPAPI
// kullanıcı-kapsamlıdır → blob'un İÇERİĞİ başka bir yerel kullanıcı tarafından
// ÇÖZÜLEMEZ. Yani kaybolan şey birincil kontrol değil, DERİNLEMESİNE SAVUNMA
// katmanıdır. Bu ayrım kararı belirliyor (aşağıda).
//
// ── KARAR: NEDEN win32'de VARSAYILAN OLARAK ACL YAZMIYORUZ ──────────────────
// 793 §C-P5 çıkış kapısı "restrictPath Windows'ta NE YAPTIĞINI SÖYLÜYOR (ACL
// uygulandı / uygulanamadı)" diyor — yani şart olan DÜRÜSTLÜK, mutasyon değil.
// `icacls /inheritance:r` bir DİZİNİN miras ACL'ini SİLER. Bu işlem yanlış giderse
// (SID çözülemezse, /grant kısmı düşerse) geriye DACL'i boşalmış bir `auth/`
// dizini kalır: kullanıcı KENDİ oturum dosyasını okuyamaz → uygulamaya giremez.
// Bu, tuğlalaştırma sınıfı bir arıza ve HİÇBİR Windows makinesinde ölçemedim
// (bu görevde Windows koşusu yok — bkz. rapor R-listesi).
//
// Dolayısıyla:
//   • VARSAYILAN (win32): mutasyon YOK. Durum `inherited` olarak DÜRÜSTÇE
//     raporlanır ve bir kez loglanır. Sessiz başarı iddiası ortadan kalkar.
//   • OPT-IN (`CREWPANE_WIN_ACL=1` ya da `deps.applyAcl`): icacls İKİ FAZLI
//     çalışır — ÖNCE `/grant:r` (erişim garanti altına alınır), ancak o başarılı
//     olursa `/inheritance:r` (miras kaldırılır). Ters sıra tam olarak yukarıdaki
//     kilitlenmeyi üretirdi. Bu yol P0/P6'da gerçek bir Windows makinesinde
//     ölçülmek üzere HAZIR duruyor; ölçülmeden varsayılan yapılmayacak.
//   • Komut satırı `winAclCommands()` SAF fonksiyonundan gelir → exec olmadan
//     birim testiyle ölçülür (macOS'ta bugün koşuyor).
//
// macOS DAVRANIŞI BİT-BİT AYNI: darwin dalı bugünkü `chmodSync`/`{mode}`'un ta
// kendisi; tek fark, sonucun artık bir kayıt olarak DÖNMESİ (çağıran isterse
// yok sayar — ADR-W10 Kural 2, imza değişmiyor).
'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');

/** Sır taşıyan DİZİN modu (POSIX). */
const DIR_MODE = 0o700;
/** Sır taşıyan DOSYA modu (POSIX). */
const FILE_MODE = 0o600;

/** Windows'ta `Get-Acl`/icacls için sabit, YERELLEŞTİRİLMEYEN SID'ler. */
const SID_SYSTEM = 'S-1-5-18';
const SID_ADMINISTRATORS = 'S-1-5-32-544';
/** `%CURRENTUSER%` yerine kullanılan icacls sözde-adı: oturumdaki kullanıcı. */
const CURRENT_USER_TOKEN = '%USERNAME%';

/**
 * ÜÇ-DURUMLU SÖZLEŞMENİN KISITLAMA HÂLİ (ADR-W7 · ADR-W10 Kural 3).
 *   applied    → mekanizma koştu ve BAŞARDI (korumanın var olduğunu biliyoruz)
 *   inherited  → bilerek nesne-başına işlem yapılmadı; koruma üst dizinin
 *                ACL'inden geliyor (win32 varsayılanı). Bu bir BAŞARI İDDİASI
 *                DEĞİL, bir kapsam beyanıdır.
 *   failed     → mekanizma koştu ve DÜŞTÜ (korumanın YOK olduğunu biliyoruz)
 *   unknown    → ölçemedik (beklenmedik hata / tanımadığımız platform)
 */
const STATES = Object.freeze({ APPLIED: 'applied', INHERITED: 'inherited', FAILED: 'failed', UNKNOWN: 'unknown' });

/** Windows System32 altındaki mutlak araç yolu — PATH bayat/bozuk olabilir. */
function system32(env, exe) {
  const root = (env && (env.SystemRoot || env.windir)) || 'C:\\Windows';
  return nodePath.win32.join(root, 'System32', exe);
}

/**
 * icacls İKİ FAZLI komut listesi. SAF fonksiyon — exec yok, test edilebilir.
 *
 * Faz 1 `/grant:r` — sahip + SYSTEM (+ istenirse Administrators) tam yetki alır.
 * Faz 2 `/inheritance:r` — miras ACE'leri KALDIRILIR. Faz 1 başarısızsa faz 2
 * ÇALIŞTIRILMAZ; aksi hâlde erişimi olmayan bir dizin kalırdı.
 *
 * `(OI)(CI)` yalnız dizinlerde anlamlıdır (object/container inherit) — dosyada
 * kullanılırsa icacls hata verir, o yüzden `recurse` ile ayrılıyor.
 */
function winAclCommands(target, opts = {}) {
  const env = opts.env || process.env;
  const exe = opts.icacls || system32(env, 'icacls.exe');
  const isDir = opts.isDir !== false;
  const inh = isDir ? '(OI)(CI)' : '';
  const principals = [`${opts.user || CURRENT_USER_TOKEN}:${inh}(F)`, `*${SID_SYSTEM}:${inh}(F)`];
  if (opts.keepAdministrators !== false) principals.push(`*${SID_ADMINISTRATORS}:${inh}(F)`);
  return [
    { phase: 'grant', file: exe, argv: [target, '/grant:r', ...principals, '/c', '/q'] },
    { phase: 'inheritance', file: exe, argv: [target, '/inheritance:r', '/c', '/q'] },
  ];
}

/** Ortak sonuç kaydı. */
function record(state, extra) {
  return { state, ...extra };
}

/**
 * İç ortak yol: dizin ya da dosyayı kısıtla.
 * `deps`: { platform, fs, env, applyAcl, execFile, log, isDir }
 */
function restrict(target, mode, deps = {}) {
  const platform = deps.platform || process.platform;
  const fs = deps.fs || nodeFs;
  const isDir = !!deps.isDir;

  if (platform !== 'win32') {
    // darwin/linux — BUGÜNKÜ DAVRANIŞ. Tek fark sonucun raporlanması.
    try {
      fs.chmodSync(target, mode);
      return record(STATES.APPLIED, { mechanism: 'chmod', target, mode });
    } catch (err) {
      return record(STATES.FAILED, { mechanism: 'chmod', target, mode, code: err.code || 'ERR', message: err.message });
    }
  }

  // ── win32 ────────────────────────────────────────────────────────────────
  // chmod BURADA HİÇ ÇAĞRILMAZ: Node'da yalnız salt-okunur bayrağını kıpırdatır,
  // gizliliğe hiçbir katkısı yok, ama `0o600`'de dosyayı YAZILAMAZ yapma riski var.
  const env = deps.env || process.env;
  const optIn = deps.applyAcl !== undefined ? !!deps.applyAcl : env.CREWPANE_WIN_ACL === '1';
  const log = typeof deps.log === 'function' ? deps.log : null;

  if (!optIn) {
    const r = record(STATES.INHERITED, {
      mechanism: 'none',
      target,
      posixModeIgnored: mode,
      why: 'win32-acl-inherited',
      advisory: 'POSIX izin bitleri Windows\'ta etkisiz; koruma üst dizinin miras ACL\'inden geliyor. İçerik koruması safeStorage/DPAPI ile sürüyor.',
    });
    if (log) { try { log(r); } catch { /* ölçüm yazımı işi bloklamaz */ } }
    return r;
  }

  const execFile = deps.execFile;
  if (typeof execFile !== 'function') {
    return record(STATES.UNKNOWN, { mechanism: 'icacls', target, reason: 'no-exec-injected' });
  }
  const cmds = winAclCommands(target, { env, isDir, user: deps.user, icacls: deps.icacls });
  const ran = [];
  for (const c of cmds) {
    try {
      execFile(c.file, c.argv);
      ran.push(c.phase);
    } catch (err) {
      // Faz 1 düşerse faz 2 HİÇ koşmaz → miras ACL yerinde kalır, kilitlenme yok.
      return record(STATES.FAILED, { mechanism: 'icacls', target, phase: c.phase, ran, code: err.code || 'ERR', message: err.message });
    }
  }
  const ok = record(STATES.APPLIED, { mechanism: 'icacls', target, ran });
  if (log) { try { log(ok); } catch { /* yut */ } }
  return ok;
}

/** Sır taşıyan DİZİN (auth/, credentials/, …). */
function restrictDir(dir, deps = {}) {
  return restrict(dir, deps.mode === undefined ? DIR_MODE : deps.mode, { ...deps, isDir: true });
}

/** Sır taşıyan DOSYA (oturum blob'u, jeton, MCP config, makbuz). */
function restrictFile(file, deps = {}) {
  return restrict(file, deps.mode === undefined ? FILE_MODE : deps.mode, { ...deps, isDir: false });
}

/**
 * `mkdirSync`/`writeFileSync`e verilecek `mode` seçeneği.
 * win32'de `undefined` döner: seçeneği hiç geçirmemek, geçirip yok saydırmaktan
 * DÜRÜSTTÜR (kodu okuyan "bu dizin 0700" sanmasın).
 */
function modeOption(mode, platform = process.platform) {
  return platform === 'win32' ? undefined : mode;
}

/**
 * DENETİM — "bu yol gerçekten kısıtlı mı?" Testlerin (790 I5) platformdan
 * bağımsız sorabileceği tek soru budur.
 *   posix : stat().mode & 0o777 karşılaştırması → applied | failed
 *   win32 : `unknown` — ACL'i ölçmeden "korunuyor" DEMİYORUZ. (Windows CI'da
 *           izin testleri bu yüzden kırmızı vermez, ama YEŞİLE DE BOYANMAZ:
 *           test "ölçemedim"i açıkça görür.)
 */
function auditRestriction(target, deps = {}) {
  const platform = deps.platform || process.platform;
  const fs = deps.fs || nodeFs;
  const expected = deps.mode === undefined ? FILE_MODE : deps.mode;
  if (platform === 'win32') {
    return record(STATES.UNKNOWN, { mechanism: 'acl', target, reason: 'acl-not-measured' });
  }
  try {
    const actual = fs.statSync(target).mode & 0o777;
    return actual === expected
      ? record(STATES.APPLIED, { mechanism: 'chmod', target, mode: actual })
      : record(STATES.FAILED, { mechanism: 'chmod', target, mode: actual, expected });
  } catch (err) {
    return record(STATES.UNKNOWN, { mechanism: 'chmod', target, reason: err.code || 'stat-failed' });
  }
}

module.exports = {
  DIR_MODE,
  FILE_MODE,
  STATES,
  SID_SYSTEM,
  SID_ADMINISTRATORS,
  CURRENT_USER_TOKEN,
  system32,
  winAclCommands,
  restrictDir,
  restrictFile,
  modeOption,
  auditRestriction,
};
