#!/usr/bin/env node
// CrewPane — KILL-GUARD-01: MOTOR-BAĞIMSIZ ikinci kapı (KAPI 2).
//
// KAPI 1 (killGuardHook.cjs) claude'un `PreToolUse` yüzeyine bağlıdır ve YALNIZ
// claude'da vardır. codex/goose/droid/opencode'da per-launch kanca bayrağı YOKTUR
// (engineRegistry: `hooks: null` — ölçülmüş, uydurulmamış), düz `shell` pane'inde
// zaten hiçbir motor yoktur. Bu dosya o boşluğu kapatır: pane'in PATH'inin BAŞINA
// `killall` / `pkill` sarmalayıcıları konur; sarmalayıcı kararı KAPI 1 ile AYNI
// çekirdekten (killGuard.cjs) alır — iki uygulayıcı, tek desen listesi.
//
// İki mod:
//   • Kütüphane — `shimFiles(...)` sarmalayıcı dosyalarının İÇERİĞİNİ üretir (saf).
//   • CLI       — `node killGuardShim.cjs --check --verb killall -- <argv…>`
//                 exit 0 = geçer · exit 3 = REDDEDİLDİ (gerekçe stderr'de).
//
// WIN-PARITY-01 — bu dosya artık ÜÇ PLATFORMDA da sarmalayıcı üretir: POSIX'te
// `killall`/`pkill` (sh), Windows'ta `taskkill`/`wmic`/`tskill` (.cmd). Windows'ta
// sarmalanamayan üç yazılış (`Stop-Process`, `kill`, `spps` — PowerShell cmdlet'i
// ve takma adları) SHIMMED_WIN32'nin başlığında AÇIKÇA beyanlıdır.
//
// ⚠️ FAIL-CLOSED (hook'un tersine, BİLİNÇLİ): burada karar verilemezse komut
// ÇALIŞTIRILMAZ. Gerekçe — bu sarmalayıcı yalnız `killall`/`pkill`i etkiler; onlar
// engellendiğinde ajanın işi durmaz (pid ile öldürme yolu açık kalır), oysa sessiz
// bir bypass 08.09'da üç worker'ın işini sildi. Hook fail-OPEN'dır çünkü o HER araç
// çağrısının önünde durur; oradaki bir arıza bütün ajanları çalışamaz hâle getirirdi.

'use strict';

const guard = require('./killGuard.cjs');

/** POSIX'te sarmalanan komutlar. */
const SHIMMED = Object.freeze(['killall', 'pkill']);

/**
 * WIN-PARITY-01 — WINDOWS'TA SARMALANAN KOMUTLAR.
 *
 * Eskiden bu dosya win32'de `[]` döndürüyordu ("killall/pkill yok → sarmalanacak
 * bir şey yok"). Doğru olan yarısıydı: o iki ikilik gerçekten yok, ama Windows'un
 * KENDİ yıkım komutları var ve hiçbiri sarmalanmıyordu → Windows'ta KAPI 2 hiç
 * yoktu (ölçüm: XPLAT-01 §2, 0/5).
 *
 * ⚠️ NEDEN YALNIZ ÜÇÜ — ve `Stop-Process` NEDEN YOK (beyanlı sınır):
 * PATH sarmalayıcısı yalnız DOSYA olarak çözülen komutları gölgeleyebilir.
 *   • `taskkill` · `wmic` · `tskill` → gerçek `.exe` (System32) → PATH'ten çözülür
 *     ⇒ `<instanceHome>\\bin\\taskkill.cmd` PATH'in başındayken KAZANIR (dizin
 *     sırası PATHEXT sırasından önce gelir).
 *   • `Stop-Process` · `kill` · `spps` → PowerShell CMDLET'i ve TAKMA ADLARI.
 *     PowerShell komut çözümünde alias/cmdlet, harici komuttan ÖNCE gelir; hiçbir
 *     PATH dosyası onları gölgeleyemez. Onları YALNIZ KAPI 1 (araç-öncesi kanca)
 *     yakalar — karar çekirdeği R7 ile ısırır, ama kancasız motorda (codex/goose)
 *     PowerShell pane'inde bu üç yazılış AÇIK KALIR.
 * Bu asimetri gizlenmez: kapı bir KAZA duvarıdır, güvenlik duvarı değil.
 */
const SHIMMED_WIN32 = Object.freeze(['taskkill', 'wmic', 'tskill']);

/** Bu platformda sarmalanacak komutlar (çağıran gerçek ikilikleri buna göre arar). */
function shimmedFor(platform) {
  return (platform || process.platform) === 'win32' ? SHIMMED_WIN32 : SHIMMED;
}

/** sh içinde tek-tırnaklı güvenli değer. */
function shq(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Batch (`.cmd`) içinde güvenli değer. `%` ÇİFTLENİR (batch'te `%X%` genişletmedir)
 * ve gömülü çift tırnak düşer — yollar `set "K=V"` biçiminde yazıldığı için
 * tırnak, değerin kendisinde DEĞİL kabuk sözdiziminde yaşar.
 */
function bq(value) {
  return String(value == null ? '' : value).replace(/%/g, '%%').replace(/"/g, '');
}

/**
 * WINDOWS sarmalayıcı gövdesi (`.cmd`). POSIX kardeşiyle AYNI üç davranış:
 *   1. kill-switch (`CREWPANE_KILL_GUARD=0`) → doğrudan gerçek ikiliye,
 *   2. karar çekirdeğine sor (`--check --verb <v> -- %*`),
 *   3. exit 0 → GERÇEK ikiliye devret · aksi hâlde çalıştırma, çıkış 1.
 *
 * 🪤 `%*` bilerek: batch'te argümanları TEK TEK yeniden tırnaklamak
 * (`%1 %2 …`) `taskkill /FI "WINDOWTITLE eq x"` gibi boşluklu filtreleri bozardı.
 * `%*` ham kuyruğu olduğu gibi taşır — hem karara hem gerçek ikiliye.
 * 🪤 `if not errorlevel 1` = "errorlevel < 1", yani YALNIZ 0. Karar 3 dönerse
 * (ret) ya da sonda çökerse (≠0) komut çalışmaz — POSIX kardeşiyle aynı
 * FAIL-CLOSED duruşu.
 */
function winShimBody({ verb, real, nodeCall, envLines }) {
  return [
    '@echo off',
    `rem CrewPane kill-guard (KILL-GUARD-01 / WIN-PARITY-01) — ${verb} sarmalayicisi.`,
    'rem Bu dosya HER pane spawn\'inda yeniden yazilir; elle duzenleme kalici degildir.',
    'setlocal EnableExtensions',
    `set "REAL=${bq(real)}"`,
    'if "%CREWPANE_KILL_GUARD%"=="0" goto passthru',
    'if "%CREWPANE_KILL_GUARD%"=="0" goto passthru',
    ...envLines,
    `${nodeCall} --check --verb ${verb} -- %*`,
    'if not errorlevel 1 goto passthru',
    'exit /b 1',
    ':passthru',
    '"%REAL%" %*',
    'exit /b %errorlevel%',
  ].join('\r\n') + '\r\n';
}

/**
 * Sarmalayıcı dosyalarının içerikleri.
 *
 * @param {object} o
 * @param {string} o.cliPath   Bu dosyanın MUTLAK yolu (asar DIŞI — düz node çocuğu okur).
 * @param {{command:string, env?:object}} o.launcher  mcpNode.resolveMcpNode() çıktısı.
 * @param {Record<string,string>} o.realBins  { killall: '/usr/bin/killall', … } — çözülemeyen
 *   komut için sarmalayıcı YAZILMAZ (gerçek ikiliyi bilmeden devretmek komutu tamamen kırardı).
 * @param {string} [o.platform]
 * @returns {Array<{name:string, contents:string, mode:number}>}
 */
function shimFiles({ cliPath, launcher, realBins, platform } = {}) {
  const plat = platform || process.platform;
  if (!cliPath || !launcher || !launcher.command) return [];

  // ── WINDOWS dalı (WIN-PARITY-01) ──────────────────────────────────────────
  if (plat === 'win32') {
    const envLines = launcher.env
      ? Object.entries(launcher.env).map(([k, v]) => `set "${k}=${bq(v)}"`)
      : [];
    const nodeCall = `"${bq(launcher.command)}" "${bq(cliPath)}"`;
    const out = [];
    for (const verb of SHIMMED_WIN32) {
      const real = realBins && realBins[verb];
      if (!real) continue; // gerçek ikiliyi bilmeden devretmek komutu YOK ederdi
      out.push({
        // 🪤 Uzantı ŞART: uzantısız bir dosya Windows'ta çalıştırılabilir değildir.
        // `.cmd` seçildi (`.bat` değil): `cmd /c` altında `exit /b` davranışı ve
        // `errorlevel` yayılımı `.cmd`de tutarlıdır.
        name: `${verb}.cmd`,
        mode: 0o755, // Windows'ta anlamsız; çağıran chmod'u zaten yutuyor
        contents: winShimBody({ verb, real, nodeCall, envLines }),
      });
    }
    return out;
  }

  const envPrefix = launcher.env
    ? `${Object.entries(launcher.env).map(([k, v]) => `${k}=${shq(v)}`).join(' ')} `
    : '';
  const nodeCall = `${envPrefix}${shq(launcher.command)} ${shq(cliPath)}`;

  const out = [];
  for (const verb of SHIMMED) {
    const real = realBins && realBins[verb];
    if (!real) continue;
    out.push({
      name: verb,
      mode: 0o755,
      contents: [
        '#!/bin/sh',
        `# CrewPane kill-guard (KILL-GUARD-01) — ${verb} sarmalayıcısı.`,
        '# Bu dosya HER pane spawn\'ında yeniden yazılır; elle düzenleme kalıcı değildir.',
        `REAL=${shq(real)}`,
        '# KILL-SWITCH: kapıyı kapatmak tek env ile mümkün (kontrol kolu buradan çekilir).',
        'if [ "${CREWPANE_KILL_GUARD:-}" = "0" ] || [ "${CREWPANE_KILL_GUARD:-}" = "0" ]; then',
        '  exec "$REAL" "$@"',
        'fi',
        `GUARD_MSG=$(${nodeCall} --check --verb ${shq(verb)} -- "$@" 2>&1)`,
        'GUARD_RC=$?',
        'if [ "$GUARD_RC" -eq 0 ]; then',
        '  exec "$REAL" "$@"',
        'fi',
        'printf %s\\\\n "$GUARD_MSG" >&2',
        'exit 1',
      ].join('\n') + '\n',
    });
  }
  return out;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function runCli(argv, env) {
  const i = argv.indexOf('--');
  const head = i >= 0 ? argv.slice(0, i) : argv;
  const tail = i >= 0 ? argv.slice(i + 1) : [];
  const vIdx = head.indexOf('--verb');
  const verb = vIdx >= 0 && vIdx + 1 < head.length ? head[vIdx + 1] : '';
  if (!verb) return { code: 3, message: 'kill-guard: --verb verilmedi (karar verilemedi → komut çalıştırılmadı)' };

  if (!guard.isEnabled(env)) return { code: 0, message: '' };

  // Argümanlar TEK BİR kabuk satırı gibi birleştirilir: karar çekirdeği dize üzerinde
  // çalışır ve token'ları yeniden ayırır. Boşluk içeren bir argüman burada tırnaksız
  // birleşir — bu KAPININ LEHİNE bir sapmadır (daha çok şey desen içinde görünür).
  const line = [verb, ...tail].join(' ');
  const ctx = guard.contextFromEnv(env);
  // R8 — sarmalayıcı yalnız `killall`/`pkill`i (win32'de taskkill/wmic/tskill) görür;
  // bir AÇILIŞ komutu buraya HİÇ uğramaz. Satır yine de aynı çekirdekten geçirilir ki
  // kural iki yerde ıraksamasın (ölçülen kapsam sınırı raporda beyanlı).
  if (!ctx.allowLive && guard.hasLaunchIntent(line)) {
    ctx.installedAppAlive = guard.installedAppAlive({ env });
  }
  const verdict = guard.inspectCommand(line, ctx);
  if (verdict.allowed) return { code: 0, message: '' };
  return { code: 3, message: guard.denyMessage(verdict) };
}

if (require.main === module) {
  let res;
  try {
    res = runCli(process.argv.slice(2), process.env);
  } catch (e) {
    // FAIL-CLOSED: karar veremediysek komut geçmez, ama SEBEBİ görünür olur.
    res = { code: 3, message: `kill-guard: karar verilemedi (${e && e.message}) → komut çalıştırılmadı. ${guard.RECIPE}` };
  }
  if (res.message) process.stderr.write(`${res.message}\n`);
  process.exit(res.code);
}

module.exports = { SHIMMED, SHIMMED_WIN32, shimmedFor, shimFiles, runCli };
