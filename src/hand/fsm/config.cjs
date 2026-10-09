'use strict';

/** Eşikler EL BOYU birimindedir (F1 normalizasyonu). Değerler jarvis config
 *  varsayılanlarının aynısı — from_config eşleniği handControlCore kurar. */
function defaultConfig() {
  return {
    enter: 0.14,
    release: 0.28,
    approachMult: 1.7,
    rightEnter: 0.14,
    rightRelease: 0.28,
    confirmFrames: 3,
    tapMaxS: 0.30,
    dragSlopPx: 55.0,
    dragSnapPx: 28.0,
    pressHold: true,
    dragHoldS: 0.35,
    dragScaleNorm: false,
    dragScaleRef: 0.17,
    dragRelease: 0.42,
    dragReleaseFrames: 3,
    lostGraceS: 0.15,
    anchorStillPx: 25.0,
    parkEnabled: false,
    parkLatch: true,
    pinkyRole: 'precision', // 'none' | 'precision' | 'park'
    pinkyEnter: 0.16,
    pinkyRelease: 0.30,
    precisionGain: 0.35,
    armTimeoutS: 1.2,
    prerollS: 0.25,
    prerollGuardS: 0.05,
    cooloffS: 0.20,
    leftCooldownS: 0.12,
    rightCooldownS: 0.40,
    doubleWindowS: 0.45,
    doubleSlopPx: 60.0,
    parkFrames: 3,
    scrollFrames: 2,
    scrollCooldownS: 0.05,
    scrollGainPx: 550.0,
    scrollFilter: true,
    scrollMinCutoff: 3.0,
    scrollBeta: 0.002,
    scrollDcutoff: 1.0,
    scrollDeadzoneUnits: 0.0005,
    scrollFlushResidual: true,
    scrollFlushMaxUnits: 0.30,
    scrollMaxStepUnits: 0.5,
    scrollMinScale: 0.05,
    scrollHorizontal: true,
    scrollInvert: false,
    scrollInvertX: false,
    scrollMomentum: true,
    scrollFlickMinUnitsS: 3.0,
    scrollFlickMaxPx: 4000.0,
    scrollDecayTauS: 0.45,
    scrollStopPxS: 40.0,
    scrollVelWindowS: 0.12,
    dwellEnabled: false,
    dwellS: 1.2,
    dwellRadiusPx: 12.0,
    // ---- HAND-G1 pinch-zoom (tasarım §4.1/§4.2; eşikler 890 gerçek karede
    // ölçüldü — kanyon 1,30–1,60 bandı karelerin yalnız %2,13'ü).
    zoomEnabled: true,
    zoomBackMax: 1.35, // backMean bunun ALTINDA → zoom kanalı
    zoomBackMin: 1.55, // backMean bunun ÜSTÜNDE → tık kanalı; arası ölü bant
    zoomFrames: 3,
    zoomReleaseFrames: 3,
    zoomK: 1.0,
    zoomLnDead: 0.05, // ±%5 — ölçülen %1,19 p90 gürültüsü asla çıkmaz
    zoomMin: 0.125,
    zoomMax: 8.0,
    zoomMinCutoff: 1.0,
    zoomBeta: 0.007,
    zoomDcutoff: 1.0,
    zoomRatchetS: 0.4,
    zoomEdgeLo: 0.10, // açıklık uçları — cırcır yalnız burada devreye girer
    zoomEdgeHi: 1.10,
    // ---- HAND-G9 tık kapısı sağlamlaştırma (tasarım §2.3 A4/A5) ----
    speedAwareRelease: true,
    dragFastSpeedPx: 2200.0, // px/sn (ekran DIP; balistik kazanç SONRASI)
    dragReleaseFast: 0.70, // hızlıyken bırakma çıtası (yavaşta 0.42 kalır)
    dragSpeedWindowS: 0.12, // hız penceresi (scrollVelWindowS ile aynı disiplin)
    pinchProbation: true,
    probationS: 0.40,
    probationBadFrames: 4,
    clickBackMin: 1.55,
  };
}

function approachOf(cfg) {
  return Math.min(cfg.enter * cfg.approachMult, cfg.release);
}

function rightApproachOf(cfg) {
  return Math.min(cfg.rightEnter * cfg.approachMult, cfg.rightRelease);
}

module.exports = {
  defaultConfig,
  approachOf,
  rightApproachOf,
};
