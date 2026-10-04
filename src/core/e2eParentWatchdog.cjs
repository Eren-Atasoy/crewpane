// ORPHAN-ELECTRON-01 — EBEVEYN-ÖLÜMÜ NÖBETÇİSİ (yalnız OTOMASYON açılışlarında).
//
// ÖLÇÜLEN ARIZA (07.09 01:12, Eren canlı yayındayken): e2e/proof koşan worker
// SIGKILL'le ölünce (limit / lider kapatması / OOM) hiçbir SÜREÇ-İÇİ kanca koşamaz
// — ne Playwright'ınki ne bizimki — ve Electron ağacı yaşamaya devam eder: 6 yetim,
// %28-91 CPU, loadavg 133 (14 çekirdek).
//
// ÖLÇÜM (e2e/orphan-electron-01-control-arm.cjs): SIGTERM / SIGHUP / SIGINT'te
// sızıntı YOKTUR — Playwright'ın kendi kancaları bunları zaten kapatıyor. Açık kalan
// TEK delik SIGKILL'dir ve o delik ancak DIŞARIDAN, ÇOCUĞUN KENDİSİ tarafından
// kapatılabilir. MEMIDX-LEAK-01'in indeks/gömme/arama çocukları için yaptığının
// aynısı: çocuk ebeveynini yoklar, ebeveyn gidince KENDİ ÇIKAR.
//
// KAPI: yalnız `CREWPANE_E2E=1` (e2e/schemeSafeLaunch.cjs#automatedLaunchEnv) VE
// bir ebeveyn pid'i verilmişse kurulur → TESLİM EDİLEN üründe hiçbir zaman çalışmaz,
// insanın `electron:dev`/`electron:prod` instance'ı etkilenmez.
//
// Çalıştır: node --test electron/e2eParentWatchdog.test.cjs

'use strict';

/**
 * @param {object} [deps] hepsi test için enjekte edilir
 * @param {NodeJS.ProcessEnv} [deps.env]
 * @param {(pid:number, sig:number)=>void} [deps.kill] `process.kill` (sinyal 0 = yoklama)
 * @param {()=>void} [deps.quit] `app.quit()`
 * @param {(code:number)=>void} [deps.exit] `process.exit`
 * @param {Function} [deps.setInterval] / [deps.clearInterval] / [deps.setTimeout]
 * @param {(m:string)=>void} [deps.log]
 * @returns {{timer:any, parentPid:number}|null} null = nöbetçi KURULMADI (kapı kapalı)
 */
function armE2EParentWatchdog(deps = {}) {
  const env = deps.env || process.env;
  const kill = deps.kill || process.kill.bind(process);
  const setI = deps.setInterval || setInterval;
  const clearI = deps.clearInterval || clearInterval;
  const setT = deps.setTimeout || setTimeout;
  const log = deps.log || console.log;

  if (env.CREWPANE_E2E !== '1') return null; // otomasyon değil → ASLA
  const parentPid = Number(env.CREWPANE_E2E_PARENT_PID || 0);
  if (!parentPid || parentPid <= 1) return null; // ebeveyn bilinmiyor → dokunma
  const everyMs = Number(env.CREWPANE_E2E_PARENT_POLL_MS || 3000);

  const timer = setI(() => {
    let parentAlive = true;
    try {
      kill(parentPid, 0); // sinyal göndermez — yalnız "var mı" sorar
    } catch (e) {
      // ESRCH = ebeveyn gitti → çık. EPERM = var ama bizim değil → DOKUNMA (yaşat):
      // "ölçemedik → dokunma" kuralı, yanlış kapanma sızıntıdan pahalıdır.
      parentAlive = !!(e && e.code === 'EPERM');
    }
    if (parentAlive) return;
    clearI(timer);
    log(`[orphan-guard] e2e ebeveyni (pid ${parentPid}) gitti → çıkılıyor`);
    try { deps.quit ? deps.quit() : null; } catch { /* quit engellenirse exit kapatır */ }
    const t = setT(() => (deps.exit || process.exit)(0), 2000);
    t && t.unref && t.unref();
  }, everyMs);
  timer && timer.unref && timer.unref(); // nöbetçi TEK BAŞINA süreci ayakta TUTMAZ
  return { timer, parentPid };
}

module.exports = { armE2EParentWatchdog };
