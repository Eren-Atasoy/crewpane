// electron/handScale.cjs — HAND-A2: el ölçeği (pinch eşiklerinin PAYDASI).
// jarvis/core/hand_scale.py'nin (HND-B3) portu. Varlık sebebi ölçülmüş bir
// arıza: izdüşüm bir doğru parçasını yalnız KISALTABİLİR — avuç kameraya
// yatınca tek-kemik payda çöker, pinch oranı şişer, sürükleme düşer
// ("tık sorun değil, basılı tutmada sıkıntı"). Çözüm: birden çok kemiğin ima
// ettiği el boyları arasında en BÜYÜĞÜ gerçeğe en yakın olandır.
// `landmark.z` bilinçli olarak KULLANILMAZ (ölçeksiz/gürültülü kestirim).

'use strict';

// MediaPipe Hands landmark indeksleri (tek kaynak: handLandmarks sabitleri).
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const INDEX_PIP = 6;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const MIDDLE_PIP = 10;
const MIDDLE_TIP = 12;
const RING_MCP = 13;
const RING_PIP = 14;
const RING_TIP = 16;
const PINKY_MCP = 17;
const PINKY_PIP = 18;
const PINKY_TIP = 20;

// Payda adayları: [a, b, varsayılan oran] — referans WRIST→MIDDLE_MCP = 1.0.
// Neden bu dördü: hepsi UZUN; kısa kemik landmark gürültüsünü 3× büyütür.
const DEFAULT_BONES = Object.freeze([
  [WRIST, MIDDLE_MCP, 1.0],
  [INDEX_MCP, PINKY_MCP, 0.83], // avuç genişliği — referansa DİK, pitch'te ayakta
  [WRIST, INDEX_MCP, 1.014],
  [WRIST, PINKY_MCP, 0.968],
]);

/** landmarks: [{x,y}, …] (21 nokta, görüntüye normalize). */
function dist2(L, a, b) {
  return Math.hypot(L[a].x - L[b].x, L[a].y - L[b].y);
}

function median(arr) {
  const s = [...arr].sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Kare kare el ölçeği — dönmeye dayanıklı, 5 katman (hepsi ayrı kapatılabilir):
 * oran kalibrasyonu (kayan medyan) · kare içi max · medyan-3 sıçrama yutucu ·
 * tek yönlü hız sınırı (yükseliş serbest, düşüş sınırlı) · tutuş tabanı
 * (buton basılıyken payda basıldığı anın altına inemez).
 */
class HandScaleEstimator {
  constructor({
    bones = DEFAULT_BONES,
    multiBone = true,
    calibrate = true,
    calibFrames = 300,
    calibMin = 45,
    calibTolerance = 0.30,
    spikeMedian = 3,
    dropRate = 1.0,
    holdFloor = true,
    minScale = 1e-4,
  } = {}) {
    this.bones = bones;
    this.multiBone = multiBone;
    this.calibrate = calibrate;
    this.calibFrames = Math.max(1, calibFrames | 0);
    this.calibMin = calibMin | 0;
    this.calibTolerance = Number(calibTolerance);
    this.spikeMedian = Math.max(1, spikeMedian | 0);
    this.dropRate = Number(dropRate);
    this.holdFloor = holdFloor;
    this.minScale = Number(minScale);
    this._ratioBuf = this.bones.map(() => []);
    this.reset();
  }

  /** El kaybolunca çağrılır. Kalibrasyon KORUNUR (el aynı el). */
  reset() {
    this._spike = [];
    this._out = null;
    this._t = null;
    this._holdFrom = null;
    this.legacy = 0.0; // eski tek-kemik değeri (HUD + A/B)
    this.raw = 0.0;
  }

  _ratio(i, def) {
    if (!this.calibrate || i === 0) return def;
    const buf = this._ratioBuf[i];
    if (buf.length < this.calibMin) return def;
    const med = median(buf);
    const lo = def * (1.0 - this.calibTolerance);
    const hi = def * (1.0 + this.calibTolerance);
    return Math.max(lo, Math.min(hi, med));
  }

  get ratios() {
    return this.bones.map(([, , def], i) => this._ratio(i, def));
  }

  /** Bu karenin paydası. `hold` = buton BASILI (ARMED/DRAG). */
  update(landmarks, t, hold = false) {
    const L = landmarks;
    const lens = this.bones.map(([a, b]) => dist2(L, a, b));
    this.legacy = lens[0];

    // 1) Oran kalibrasyonu — yalnız referans güvenilirken örnek topla.
    if (this.calibrate && lens[0] > this.minScale) {
      for (let i = 1; i < this.bones.length; i++) {
        if (lens[i] > this.minScale) {
          const buf = this._ratioBuf[i];
          buf.push(lens[i] / lens[0]);
          if (buf.length > this.calibFrames) buf.shift();
        }
      }
    }

    // 2) Kare içi bileşik: en BÜYÜK el-boyu tahmini kazanır.
    const ratios = this.ratios;
    const est = lens.map((len, i) => (ratios[i] > 1e-9 ? len / ratios[i] : 0.0));
    const raw = this.multiBone ? Math.max(...est) : lens[0];
    this.raw = raw;

    // 3) Medyan-3: tek karelik landmark sıçraması.
    this._spike.push(raw);
    if (this._spike.length > this.spikeMedian) this._spike.shift();
    const val = median(this._spike);

    // 4) Tek yönlü hız sınırı.
    const dt = this._t === null ? 0.0 : Math.max(0.0, t - this._t);
    this._t = t;
    if (this._out === null) {
      this._out = val;
    } else if (val >= this._out) {
      this._out = val;
    } else if (this.dropRate > 0.0) {
      const floor = this._out * Math.exp(-this.dropRate * dt);
      this._out = Math.max(val, floor);
    } else {
      this._out = val;
    }

    // 5) Tutuş tabanı.
    if (this.holdFloor && hold) {
      if (this._holdFrom === null) this._holdFrom = this._out;
      this._out = Math.max(this._out, this._holdFrom);
    } else {
      this._holdFrom = null;
    }

    return this._out;
  }

  get value() {
    return this._out === null ? 0.0 : this._out;
  }
}

module.exports = {
  HandScaleEstimator,
  DEFAULT_BONES,
  LANDMARK: {
    WRIST, THUMB_TIP, INDEX_MCP, INDEX_PIP, INDEX_TIP, MIDDLE_MCP, MIDDLE_PIP,
    MIDDLE_TIP, RING_MCP, RING_PIP, RING_TIP, PINKY_MCP, PINKY_PIP, PINKY_TIP,
  },
};
