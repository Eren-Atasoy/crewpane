// ADP-463-B — engine/CLI availability probe (setup wizard step 5, WARN-ONLY).
//
// The wizard's "engine check" step tells the user whether the `claude` / `codex`
// CLIs are installed. It NEVER blocks — a missing engine is a ⚠️ hint with an
// install link, not a gate (engines can be installed later; ADP-463 SPEC §5b).
//
// PATH gotcha ([[gui-app-missing-locale]]): a Finder/Dock-launched Electron inherits
// a stripped PATH, so a bare `which claude` reports "not found" even when it IS
// installed. We resolve through the user's LOGIN shell (`$SHELL -lc 'command -v …'`)
// so the probe sees the same PATH the pty workers get. `command -v` is POSIX and
// resolves builtins/functions/aliases the way the shell actually would.
//
// ── ADP-833 (ADR-W7) — WINDOWS: KABUK ÇATALLANMAZ ───────────────────────────
// Yukarıdaki login-shell hunisi macOS'ta DOĞRU, Windows'ta ANLAMSIZDIR ve bugün
// ÜÇ bağımsız hata üretir (790 M1): `SHELL` tanımsız → `/bin/sh` yok → `-lc`
// PowerShell'de geçersiz. Üçü de `catch`'e düşer ve motor KURULU OLSA BİLE
// "kurulu değil" denir.
//
// Windows'ta login-shell'in taklidi (`powershell -l`) YANLIŞ ÇEVİRİDİR: orada
// "kırpılmış PATH" problemi yapısal olarak yoktur — PATH registry'de yaşar ve her
// süreç birleşimini alır (792 §3.1). Doğru tercüme üç katmandır (ADR-W7):
//   1. sabit aday dizin listesi  → platform/envPath.extraPathDirs
//   2. registry'den TAZE PATH    → platform/envPath.readRegistryPath
//   3. PATHEXT genişletmesi      → platform/binResolve (790 M3)
// …ve sonuç ÜÇ-DURUMLUDUR: present / absent / unknown. "Ölçemedim"i "yok" diye
// göstermek, Windows'ta kullanıcıyı sonsuz "ben kurdum ama yok" döngüsüne sokar.
// `found` alanı GERİYE-UYUM için aynen korunur (macOS davranışı bit-bit aynı).

const { execFile } = require('node:child_process')
const engineInstall = require('./engineInstall.cjs') // ADP-694 — kurulum komutu/doküman/etiket TEK kaynağı
const engineRegistry = require('./engineRegistry.cjs') // ENG-04/08 — motor defteri TEK kaynağı
const binResolve = require('../../platform/binResolve.cjs') // ADP-833 — PATHEXT/`\` farkındalığı
const envPath = require('../../platform/envPath.cjs') // ADP-833 — sabit dizinler + registry taze PATH

// ENG-08 — İKİSİ DE DEFTERDEN TÜRER (elle liste YOK). Eskiden burada `['claude',
// 'codex']` ve iki satırlık bir ipucu haritası elle yazılıydı; defter değişip bu
// dosya değişmediğinde sihirbaz motoru SESSİZCE hiç sormuyordu (ENG-R3 §1.3'ün
// "8 elle-senkron defter" sorununun bu yüzeydeki payı).
const DEFAULT_ENGINES = engineRegistry.engineIds()

// Install hints shown next to a missing engine (product copy, not per-user data).
const INSTALL_HINTS = Object.fromEntries(
  DEFAULT_ENGINES.map((id) => [id, (engineRegistry.capability(id, 'install') || {}).checkHint || null]),
)

/**
 * ENG-21 (G1) — MOTOR KİMLİĞİ ≠ İKİLİ ADI.
 *
 * ÖLÇÜLDÜ (ENG-15 §2.4-G1): prob motorun KİMLİĞİNİ komut adı sanıyordu. Adı
 * ikilisinden farklı olan tek motorda (`cursor` → `cursor-agent`) bu şu üç yalanı
 * üretiyordu: (a) KURULU motor "kurulu değil" görünüyor, (b) hesap durumu
 * ölçülemiyor ("missing"), (c) kullanıcıya var olmayan bir komut adı gösteriliyor.
 *
 * Çözüm defterden: descriptor `bin` alanı. Kayıtlı olmayan bir dize (doğrudan komut
 * probu — testler, `shell`) AYNEN geçer; `bin === id` olan 11 motorda çıktı bit-bit
 * bugünküdür.
 */
function binFor(cmd) {
  if (typeof cmd !== 'string' || !cmd) return cmd;
  try {
    if (!engineRegistry.isRegisteredEngine(cmd)) return cmd;
    const d = engineRegistry.getEngine(cmd);
    return (d && d.bin) || cmd;
  } catch {
    return cmd; // defter okunamadıysa prob yine de koşar (warn-only yüzey)
  }
}

/** Üç-durumlu probe sonucunu bugünkü iki alanlı sözleşmeye genişletir (ADR-W7). */
function withCompat(state) {
  return {
    found: state.state === 'present',
    path: state.state === 'present' ? state.path : null,
    state: state.state,
    reason: state.reason || null,
  }
}

/**
 * WINDOWS DALI — senkron, kabuksuz, enjeksiyon yüzeyi sıfır.
 * `deps.freshPath` enjekte edilebilir (registry okumasını testte taklit etmek için).
 */
function probeWin32(cmd, deps = {}) {
  const env = deps.env || process.env
  const fresh = (deps.freshPath || envPath.freshPath)({ ...deps, platform: 'win32', env })
  const probeEnv = { ...env }
  envPath.setPathVar(probeEnv, fresh.path)
  const r = binResolve.resolveBinaryState(cmd, probeEnv, { ...deps, platform: 'win32' })
  if (r.state === 'present') return withCompat(r)
  // Registry OKUNAMADIYSA "yok" diyemeyiz: aradığımız PATH eksik olabilir (ADR-W7).
  if (fresh.registry && fresh.registry.state === 'unknown') {
    return withCompat({ state: 'unknown', reason: `registry:${fresh.registry.reason || 'unreadable'}` })
  }
  return withCompat(r)
}

/**
 * Resolve one command through the login shell. Resolves to
 * `{ found, path|null, state, reason }` — never rejects (probe failure = warn-only).
 * `deps.execFile` / `deps.platform` are injectable for tests.
 */
function probeOne(rawCmd, deps = {}) {
  const platform = deps.platform || process.platform
  // ENG-21 (G1) — çağıranlar (checkEngines, engineAuth.resolveBin) MOTOR KİMLİĞİ
  // geçiyor; aranacak şey ise İKİLİDİR. Çeviri tek yerde, defterden.
  const cmd = binFor(rawCmd)
  if (platform === 'win32') return Promise.resolve(probeWin32(cmd, deps))

  const exec = deps.execFile || execFile
  const env = deps.env || process.env
  const shell = deps.shell || env.SHELL || '/bin/sh'
  // ENG-ACC-P1 — PROBUN PATH'i: uygulamanınki DEĞİL, zenginleştirilmiş olan.
  // `zsh -l` login AMA İNTERAKTİF DEĞİLDİR → `.zprofile` okunur, `.zshrc` OKUNMAZ.
  // `~/.local/bin` (claude native installer'ın resmî hedefi) yalnız `.zshrc`'de
  // olduğu için Finder-launch'ta prob KURULU motoru "yok" sanıyordu (P0 §2.3).
  // Zenginleştirilmiş PATH'i kabuğa GİRDİ olarak veriyoruz: macOS `path_helper`
  // mevcut girdileri korur (siler değil), profil yine normal koşar.
  // PIPE-03 — `home` dikişi İLERİ TAŞINIR (envPath.extraPathDirs zaten anlıyor).
  // Enjekte edilen platform ile HOST'un ev dizini karışınca liste tutarsız oluyor
  // (Windows CI'da darwin dalı 'C:\Users\x/.local/bin' üretiyordu); testin
  // platformu enjekte edip evi enjekte EDEMEMESİ o tutarsızlığı ölçülemez kılıyordu.
  const probeEnv = envPath.withAugmentedPath(env, { platform, home: deps.home })
  // `-l` (login) loads the user's profile PATH; `-c` runs the probe. `command -v`
  // prints the resolved path and exits non-zero when absent.
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    // Hard timeout so a hung shell can never wedge the wizard step. Bu bir ÖLÇÜM
    // BAŞARISIZLIĞIDIR (ADR-W7) — `found:false` bugünküyle aynı kalır, ama durum
    // 'unknown' olur: asılı bir kabuk "motor yok" anlamına gelmez.
    const timer = setTimeout(() => done(withCompat({ state: 'unknown', reason: 'timeout' })), deps.timeoutMs || 4000)
    try {
      exec(shell, ['-lc', `command -v ${cmd}`], { timeout: deps.timeoutMs || 4000, env: probeEnv }, (err, stdout) => {
        clearTimeout(timer)
        const path = String(stdout || '').trim().split('\n')[0].trim()
        if (!err && path) return done(withCompat({ state: 'present', path }))
        // Kabuğun KENDİSİ çalıştırılamadıysa (ENOENT) ya da öldürüldüyse ölçüm
        // yapılamamıştır; `command -v`'nin sıfır-dışı çıkışı ise gerçek bir CEVAPTIR.
        const code = err && (err.code || err.errno)
        const unmeasured = err && (code === 'ENOENT' || code === 'EACCES' || err.killed === true || err.signal)
        done(withCompat(unmeasured ? { state: 'unknown', reason: String(code || err.signal) } : { state: 'absent' }))
      })
    } catch (e) {
      clearTimeout(timer)
      done(withCompat({ state: 'unknown', reason: (e && e.code) || 'spawn-failed' }))
    }
  })
}

/**
 * Probe every engine. Resolves to
 * `{ engines: [{ id, name, found, state, path, installUrl }], anyFound, anyUnknown }`.
 * Always resolves (warn-only) — the UI decides how to render ✅/⚠️/❔.
 */
async function checkEngines(deps = {}) {
  const ids = deps.engines || DEFAULT_ENGINES
  const platform = deps.platform || process.platform
  const engines = await Promise.all(
    ids.map(async (id) => {
      const r = await probeOne(id, deps)
      // ADP-694 — link TEK BAŞINA yetmiyordu ("indirmesini mi sağlayacağız?"): eksik
      // motorun yanına kopyalanabilir kurulum KOMUTU + insan-okur adı da geliyor.
      // Katalog tek kaynak (engineInstall.cjs) — burada metin tekrarlanmaz.
      // ADP-833 — komut PLATFORMA GÖRE gelir (Windows'ta POSIX komutu göstermek,
      // ADP-707'nin kapattığı "ekrandaki komut çalışmıyor" hatasının tekrarıydı).
      const guide = engineInstall.installInfo(id, { platform })
      return {
        id,
        // ENG-21 (G1) — UI bu alanı KOMUT sanıyor ve mono gösteriyor; o yüzden burada
        // motorun kimliği değil GERÇEK İKİLİ ADI durur (`cursor` → `cursor-agent`).
        // Kullanıcıya çalıştırılamayacak bir komut adı göstermek, motoru "yok" diye
        // göstermekle aynı sınıf yalandır.
        name: binFor(id),
        label: (guide && guide.label) || id, // insan-okur ürün adı ("Claude Code")
        found: r.found,
        // ADP-833 (ADR-W7) — 'present' | 'absent' | 'unknown'. `found` ile ÇELİŞMEZ:
        // found === (state === 'present'). Eski renderer bu alanı görmezden gelir.
        state: r.state,
        reason: r.reason,
        path: r.path,
        installUrl: (guide && guide.docsUrl) || INSTALL_HINTS[id] || null,
        installCommand: (guide && guide.command) || null,
      }
    }),
  )
  return {
    engines,
    anyFound: engines.some((e) => e.found),
    anyUnknown: engines.some((e) => e.state === 'unknown'),
  }
}

module.exports = { checkEngines, probeOne, binFor, DEFAULT_ENGINES, INSTALL_HINTS }
