'use strict';
// SEC-W2-A2 — AÇILIŞTA BÜTÜNLÜK DENETİMİ (yanlış-pozitif kalkanı + rapor)
//
// Bu modül İKİ soruyu ayırır ve ikisini de KARAR DİYE SUNMAZ:
//   1) "Bu denetim burada koşmalı mı?"  → `shouldRun()` — YANLIŞ-POZİTİF KALKANI
//   2) "Ne ölçtüm?"                     → `run()` — SUNUCUYA GİDECEK RAPOR
// "Bulut kapansın mı" kararı burada YOKTUR; onu crewpane-id verir. İstemcinin
// ölçtüğü şey yalnız (a) sunucuya taşınacak kanıt, (b) telemetri satırıdır.
//
// ── YANLIŞ-POZİTİF KALKANI: NEREDE KOŞMAZ ───────────────────────────────────
// Hafıza `ref_crewpane_bare_run_limits` + `ref_gate_green_on_wrong_target`:
// bir kapının yanlış hedefte yeşil olması kadar, doğru hedefte YANLIŞ KIRMIZI
// olması da onu öldürür — kapı kapatılır ve özellik sessizce ölür.
//
//   · kaynaktan bare-run / `node --test` / CI  → `packagedBuild()` null   → KOŞMAZ
//   · dev & test DMG'leri                      → `bakedBuildType()` dolu → KOŞMAZ
//   · izole worktree / agimen kopyası          → ikisi birden null       → KOŞMAZ
//   · manifestsiz paket (0.2.46 ve öncesi)     → manifest yok            → KOŞMAZ
//   · `isCustomerBuild()` false                → KOŞMAZ (o hâlin sinyali
//     zaten SEC-W1-C1'in `build_flag_mismatch`i; iki sinyal aynı olayı iki kez
//     saymaz)
//
// Saf + DI: her girdi enjekte edilebilir → `node --test` altında doğrudan koşar.

const integrity = require('./integrity.cjs');

/** `run()`in dönebileceği durumlar — kapalı küme. */
const STATUS = Object.freeze({
  /** Denetim koştu, paket manifestle BİREBİR. */
  OK: 'ok',
  /** Denetim koştu, ayrışma VAR. */
  MISMATCH: 'mismatch',
  /** Denetim koşmadı (kalkan) — bu bir BULGU DEĞİLDİR. */
  SKIPPED: 'skipped',
});

/** `SKIPPED` sebepleri — kapalı küme; telemetriye/rapora bu adlarla girer. */
const SKIP = Object.freeze({
  NOT_PACKAGED: 'not_packaged',
  INTERNAL_BUILD: 'internal_build',
  NOT_CUSTOMER: 'not_customer',
  NO_MANIFEST: 'no_manifest',
  NO_RESOURCES: 'no_resources',
});

/**
 * Denetim BURADA koşmalı mı?
 *
 * @param {object} deps
 * @param {true|null}   deps.packagedBaked  `instancePaths.packagedBuild()`
 * @param {string|null} deps.bakedBuild     `instancePaths.bakedBuildType()`
 * @param {boolean}     deps.customerBuild  `buildChannel.isCustomerBuild()`
 * @param {string|null} deps.resources      paketin Resources dizini
 * @returns {{run:true}|{run:false, reason:string}}
 */
function shouldRun(deps) {
  const d = deps || {};
  if (d.packagedBaked !== true) return { run: false, reason: SKIP.NOT_PACKAGED };
  if (d.bakedBuild !== null && d.bakedBuild !== undefined) {
    return { run: false, reason: SKIP.INTERNAL_BUILD };
  }
  if (d.customerBuild !== true) return { run: false, reason: SKIP.NOT_CUSTOMER };
  if (typeof d.resources !== 'string' || !d.resources) {
    return { run: false, reason: SKIP.NO_RESOURCES };
  }
  return { run: true };
}

/**
 * Ölç ve SUNUCUYA GİDECEK raporu üret.
 *
 * `files` alanı BİLEREK yalnız TABAN AD taşır ve BİLEREK sunucuya gitmez —
 * telemetri içindir (`analyticsSchema` zaten eğik çizgi kabul etmez). Sunucu
 * yalnız `jws` + `root` görür: dosya listesi bir karar girdisi değildir ve
 * müşterinin diskindeki yol adları bize lazım değildir.
 *
 * @param {object} deps `shouldRun` girdileri + `readManifest`/`measure` dikişi
 * @returns {{status:string, reason:string|null, jws:string|null, root:string|null,
 *            buildId:string|null, changed:string[], missing:string[], added:string[],
 *            durationMs:number}}
 */
function run(deps) {
  const d = deps || {};
  const gate = shouldRun(d);
  const empty = {
    status: STATUS.SKIPPED, reason: null, jws: null, root: null, buildId: null,
    changed: [], missing: [], added: [], durationMs: 0,
  };
  if (!gate.run) return { ...empty, reason: gate.reason };

  const readManifest = d.readManifest || integrity.readManifest;
  const measure = d.measure || integrity.measure;

  const started = typeof d.now === 'function' ? d.now() : Date.now();
  const manifest = readManifest(d.resources);
  // Manifestsiz paket bir KURCALAMA SİNYALİ DEĞİLDİR: 0.2.46 ve öncesi hiç
  // manifest taşımıyor ve müşteriler günlerce eski sürümde kalır. Manifestin
  // yokluğunu "kurcalandı" saymak, ödeyen müşterileri kesmek olurdu.
  if (!manifest) return { ...empty, reason: SKIP.NO_MANIFEST };

  const measured = measure(d.resources);
  const cmp = integrity.compare(measured, manifest);
  const durationMs = (typeof d.now === 'function' ? d.now() : Date.now()) - started;

  return {
    status: cmp.ok ? STATUS.OK : STATUS.MISMATCH,
    reason: null,
    // Sunucunun doğrulayacağı İKİ değer. `jws` build'in imzası (istemci
    // üretemez), `root` istemcinin ÖLÇTÜĞÜ kök. İkisi ayrışırsa sunucu bilir.
    jws: typeof manifest.jws === 'string' ? manifest.jws : null,
    root: cmp.root,
    buildId: typeof manifest.buildId === 'string' ? manifest.buildId : null,
    changed: cmp.changed,
    missing: cmp.missing,
    added: cmp.added,
    durationMs,
  };
}

/**
 * Telemetri için TEK dosya adı seç (şema tek alan taşır).
 * Öncelik `changed` → `missing` → `added`: "içeriği değişti" en bilgilendirici
 * hâldir; "eklendi" en gürültülüsü.
 */
function primaryFile(report) {
  const r = report || {};
  const pick = (r.changed || [])[0] || (r.missing || [])[0] || (r.added || [])[0] || null;
  if (!pick) return null;
  const parts = String(pick).split('/');
  return parts[parts.length - 1] || null;
}

module.exports = { STATUS, SKIP, shouldRun, run, primaryFile };
