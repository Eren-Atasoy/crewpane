// electron/handPointerFilter.cjs — HAND-A2: imleç sinyal katmanı.
// jarvis/core/pointer_filter.py'nin (HND-F1) BİREBİR portu — Python zinciri
// emekli (Eren kararı 31.08), matematiğin TEK kaynağı artık bu dosya.
// Parite fikstürleri (aynı girdi → aynı çıktı) handClickFsm.parity.test.cjs'te;
// bu dosyada davranış "iyileştirilmez": her sapma pariteyi kırar.
//
// İçerik:
//   OneEuroFilter   — 1€ filtre (Casiez et al., CHI 2012), tek boyut
//   BallisticGain   — hız-uyarlamalı kazanç eğrisi
//   PointerPipeline — mutlak eşlenmiş ekran konumu → yumuşatma → kazanç → imleç
//
// Neden 1€ + balistik kazanç: sabit-α filtre ölçülen gecikmenin %87'sini tek
// başına üretiyordu; durağan sapma (insan titremesi + sürüklenme) alçak
// frekanslı olduğundan hiçbir alçak-geçiren bastıramıyor — alt-birim kazanç
// yer değiştirmeyi doğrudan böler. Ölçümler jarvis HND-F0a/F1 raporlarında.

'use strict';

function alphaFromCutoff(cutoffHz, dt) {
  const tau = 1.0 / (2.0 * Math.PI * Math.max(cutoffHz, 1e-6));
  return 1.0 / (1.0 + tau / Math.max(dt, 1e-6));
}

/** Sabit α'nın hangi kesme frekansına denk geldiği (A/B kıyası için). */
function expAlphaCutoffHz(alpha, fps) {
  const a = Math.min(Math.max(alpha, 1e-6), 0.999999);
  const dt = 1.0 / Math.max(fps, 1e-6);
  const tau = (dt * (1.0 - a)) / a;
  return 1.0 / (2.0 * Math.PI * Math.max(tau, 1e-9));
}

class OneEuroFilter {
  constructor(minCutoff = 1.0, beta = 0.0, dCutoff = 1.0) {
    this.minCutoff = Number(minCutoff);
    this.beta = Number(beta);
    this.dCutoff = Number(dCutoff);
    this._xPrev = null;
    this._dxPrev = 0.0;
    this._tPrev = null;
    this.lastCutoff = this.minCutoff;
  }

  reset(x = null, t = null) {
    this._xPrev = x;
    this._dxPrev = 0.0;
    this._tPrev = t;
  }

  /**
   * Bir örneği süz. `velocity` verilirse kesme frekansını süren hız olarak O
   * kullanılır: klasik 1€'nun kendi türevi GÜRÜLTÜYLE de büyür — dışarıdan
   * verilen "tutarlı hız" (pencere içi yer değiştirme) filtrenin tam
   * bastırması gereken anda açılmasını engeller (HND-F1 ölçümü).
   */
  filter(x, t, velocity = null) {
    if (this._xPrev === null || this._tPrev === null) {
      this._xPrev = x;
      this._tPrev = t;
      this._dxPrev = 0.0;
      this.lastCutoff = this.minCutoff;
      return x;
    }
    const dt = t - this._tPrev;
    if (dt <= 0.0) return this._xPrev; // geriye giden zaman: durumu bozma
    const dx = (x - this._xPrev) / dt;
    const aD = alphaFromCutoff(this.dCutoff, dt);
    const dxHat = aD * dx + (1.0 - aD) * this._dxPrev;
    const drive = velocity === null ? Math.abs(dxHat) : Math.abs(velocity);
    const cutoff = this.minCutoff + this.beta * drive;
    const a = alphaFromCutoff(cutoff, dt);
    const xHat = a * x + (1.0 - a) * this._xPrev;
    this._xPrev = xHat;
    this._dxPrev = dxHat;
    this._tPrev = t;
    this.lastCutoff = cutoff;
    return xHat;
  }
}

/** g(v) = gMin + (gMax−gMin)·vᵖ/(vᵖ + vRefᵖ) — OS imleç ivmesiyle aynı mantık,
 *  farkı alt ucun 1'in ALTINDA olması (mid-air'de asıl sorun hassasiyet). */
class BallisticGain {
  constructor(gMin = 0.25, gMax = 1.5, vRef = 300.0, power = 1.6) {
    this.gMin = Number(gMin);
    this.gMax = Number(gMax);
    this.vRef = Math.max(Number(vRef), 1e-6);
    this.power = Number(power);
  }

  gain(speedPxS) {
    const v = Math.max(Number(speedPxS), 0.0);
    const r = (v / this.vRef) ** this.power;
    return this.gMin + (this.gMax - this.gMin) * (r / (1.0 + r));
  }
}

/**
 * Mutlak eşlenmiş ekran konumunu imleç konumuna çevirir.
 * mode: "oneeuro" (varsayılan) · "exp" (eski sabit-α, A/B) · "raw" (ölçüm).
 * Balistik kazanç filtrenin ÇIKIŞINA uygulanır; sapma `maxOffsetPx` ile
 * sınırlanır ve gerçek harekette (g>1) kendiliğinden kapanır.
 */
class PointerPipeline {
  constructor({
    mode = 'oneeuro',
    minCutoff = 1.0,
    beta = 0.0,
    dCutoff = 1.0,
    alpha = 0.45,
    gain = null,
    maxOffsetPx = 160.0,
    speedWindowS = 0.15,
  } = {}) {
    this.mode = mode;
    this.alpha = Number(alpha);
    this.gain = gain; // BallisticGain ya da null
    this.maxOffsetPx = Number(maxOffsetPx);
    this.speedWindowS = Number(speedWindowS);
    this._hist = []; // [t, x, y]
    this._fx = new OneEuroFilter(minCutoff, beta, dCutoff);
    this._fy = new OneEuroFilter(minCutoff, beta, dCutoff);
    this._sx = null; // filtre çıkışı
    this._sy = null;
    this._cx = null; // imleç (kazanç sonrası)
    this._cy = null;
    this._tPrev = null;
    this.lastGain = 1.0;
    this.lastSpeed = 0.0;
    // HND-F3 — hassas mod çarpanı (1.0 = kapalı); kullanıcının açtığı KİP,
    // boru hattının kendi durumu değil.
    this.precision = 1.0;
  }

  get position() {
    if (this._cx === null || this._cy === null) return null;
    return [this._cx, this._cy];
  }

  /** Filtreyi ve imleci verilen konuma ışınla (ekran geçişi, ilk kare). */
  reset(x = null, y = null, t = null) {
    this._fx.reset(x, t);
    this._fy.reset(y, t);
    this._sx = x;
    this._sy = y;
    this._cx = x;
    this._cy = y;
    this._tPrev = t;
    this._hist.length = 0;
    if (x !== null && y !== null && t !== null) this._hist.push([t, x, y]);
  }

  /**
   * Pencere içi YER DEĞİŞTİRME hızı — gürültüyü gerçek hareketten ayırır.
   * Anlık |Δ|/dt kullanılamaz: karanlık+uzak koşulda gürültünün ürettiği hız
   * gerçek hareketi AŞIYOR; ~150 ms pencerede gürültü birbirini götürür,
   * hareket birikir (HND-F1). Hem 1€'yu hem kazancı BU hız sürer.
   */
  coherentSpeed(t, x, y, fallback = 0.0) {
    const w = this.speedWindowS;
    if (w <= 0) return fallback;
    this._hist.push([t, x, y]);
    while (this._hist.length > 1 && t - this._hist[0][0] > w) this._hist.shift();
    const [t0, x0, y0] = this._hist[0];
    const span = t - t0;
    if (span <= 1e-6) return fallback;
    return Math.hypot(x - x0, y - y0) / span;
  }

  /** Mutlak ekran konumu (px) + zaman damgası → imleç konumu (px). */
  update(x, y, t) {
    if (this._sx === null || this._tPrev === null) {
      this.reset(x, y, t);
      return [x, y];
    }
    const dt = t - this._tPrev;
    if (dt <= 0.0) return [this._cx, this._cy];

    // Tutarlı hız HAM girdiden (filtreden önce) — tek kaynak.
    const inst = Math.hypot(x - this._sx, y - this._sy) / dt;
    const speed = this.coherentSpeed(t, x, y, inst);

    let fx;
    let fy;
    if (this.mode === 'oneeuro') {
      fx = this._fx.filter(x, t, speed);
      fy = this._fy.filter(y, t, speed);
    } else if (this.mode === 'exp') {
      const a = this.alpha;
      fx = a * x + (1.0 - a) * this._sx;
      fy = a * y + (1.0 - a) * this._sy;
    } else {
      fx = x;
      fy = y;
    }

    const pfx = this._sx; // bir önceki FİLTRE çıkışı
    const pfy = this._sy;
    const dx = fx - pfx;
    const dy = fy - pfy;
    this._sx = fx;
    this._sy = fy;
    this._tPrev = t;

    if (this.gain === null) {
      this._cx = fx;
      this._cy = fy;
      this.lastGain = 1.0;
      this.lastSpeed = speed;
      return [fx, fy];
    }

    // Hassas mod kazancı doğrudan böler (HND-F3: balistik "yavaşken zaten
    // hassas" YETMİYOR — pinch öncesi 300 ms'de kazanç medyan 0.873 ölçüldü).
    const g = this.gain.gain(speed) * this.precision;
    // Kazanç "birikmiş sapma" olarak tutulur: imleç = filtre çıkışı + sapma.
    // Durağanken g<1 → sapma titremeyi soğurur; g>1 bölgesinde geri kapanır.
    // (Sapmayı hızla eritmek DENENDİ, ÇALIŞMADI — pointer_filter.py'deki not.)
    let ox = (this._cx !== null ? this._cx : pfx) - pfx + (g - 1.0) * dx;
    let oy = (this._cy !== null ? this._cy : pfy) - pfy + (g - 1.0) * dy;

    const off = Math.hypot(ox, oy);
    if (off > this.maxOffsetPx && this.maxOffsetPx > 0) {
      const k = this.maxOffsetPx / off;
      ox *= k;
      oy *= k;
    }

    const cx = fx + ox;
    const cy = fy + oy;
    this._cx = cx;
    this._cy = cy;
    this.lastGain = g;
    this.lastSpeed = speed;
    return [cx, cy];
  }
}

module.exports = {
  alphaFromCutoff,
  expAlphaCutoffHz,
  OneEuroFilter,
  BallisticGain,
  PointerPipeline,
};
