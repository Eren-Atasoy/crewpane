'use strict';

const { action } = require('./constants.cjs');

const scrollMethods = {
  /** Elin HAM konumunu el-boyu birimine çevirir. null = ölçülemez. */
  _scrollUnits(f) {
    if (f.rawX === null || f.rawX === undefined || f.rawY === null || f.rawY === undefined) return null;
    const s = f.scale || 0.0;
    if (s < this.cfg.scrollMinScale) return null;
    return [f.rawX / s, f.rawY / s];
  },

  /** GÖRELİ scroll: miktar elin KAT ETTİĞİ YOLdan (trackpad gibi). */
  _scroll(f, acts) {
    const cfg = this.cfg;
    const raw = this._scrollUnits(f);
    if (raw === null) return acts;
    this._scrRaw = raw;
    let u = raw;
    if (cfg.scrollFilter) {
      u = [this._scrFx.filter(u[0], f.t), this._scrFy.filter(u[1], f.t)];
    }
    if (this._scrPrev === null) {
      this._scrPrev = [f.t, u[0], u[1]];
      return acts;
    }
    const [pt, px, py] = this._scrPrev;
    const dt = f.t - pt;
    if (dt <= 0) return acts;
    let dux = u[0] - px;
    let duy = u[1] - py;
    this._scrPrev = [f.t, u[0], u[1]];

    // Savurma hızı: kısa pencere (gürültü yönsüz, pencerede birbirini götürür).
    this._scrVel.push([f.t, u[0], u[1]]);
    while (this._scrVel.length && f.t - this._scrVel[0][0] > cfg.scrollVelWindowS) this._scrVel.shift();

    if (Math.abs(dux) < cfg.scrollDeadzoneUnits) dux = 0.0;
    if (Math.abs(duy) < cfg.scrollDeadzoneUnits) duy = 0.0;
    if (!cfg.scrollHorizontal) dux = 0.0;
    // Kare başı tavan: tek bozuk landmark karesi sayfayı uçurmasın.
    const m = cfg.scrollMaxStepUnits;
    if (m > 0) {
      dux = Math.max(-m, Math.min(m, dux));
      duy = Math.max(-m, Math.min(m, duy));
    }
    return this._emitScroll(f.t, dux, duy, acts, 'hand');
  },

  /** Süzgecin GERİDE bıraktığı yolu jest biterken gönder (scroll yer değiştirme
   *  entegre eder — gecikmiş kısım teslim edilmezse KAYBOLUR; ölçülen %10). */
  _flushResidual(t) {
    const cfg = this.cfg;
    if (!(cfg.scrollFilter && cfg.scrollFlushResidual)) return [];
    if (this._scrRaw === null || this._scrPrev === null) return [];
    let rx = this._scrRaw[0] - this._scrPrev[1];
    let ry = this._scrRaw[1] - this._scrPrev[2];
    const m = cfg.scrollFlushMaxUnits;
    rx = Math.max(-m, Math.min(m, rx));
    ry = Math.max(-m, Math.min(m, ry));
    if (!cfg.scrollHorizontal) rx = 0.0;
    return this._emitScroll(t, rx, ry, [], 'flush');
  },

  /** El-boyu hareketini ekran pikseline çevirip biriktirir (kesirli birikim
   *  ŞART: 30 fps'te yavaş kaydırmada kare başına px < 1 — yuvarlayıp atmak
   *  yavaş kaydırmayı tamamen yutar). */
  _emitScroll(t, dux, duy, acts, reason) {
    const cfg = this.cfg;
    // Görüntü y'si aşağı büyür; varsayılan el YUKARI → yukarı scroll.
    const sy = duy * cfg.scrollGainPx * (cfg.scrollInvert ? 1.0 : -1.0);
    const sx = dux * cfg.scrollGainPx * (cfg.scrollInvertX ? -1.0 : 1.0);
    this._scrAccX += sx;
    this._scrAccY += sy;
    const ex = Math.trunc(this._scrAccX);
    const ey = Math.trunc(this._scrAccY);
    if (ex === 0 && ey === 0) return acts;
    this._scrAccX -= ex;
    this._scrAccY -= ey;
    this._lastScroll = t;
    this.scrollTravel += ey;
    const direction = ey ? (ey > 0 ? 'up' : 'down') : (ex > 0 ? 'right' : 'left');
    acts.push(action('scroll', 0.0, 0.0, { direction, reason, dx: ex, dy: ey }));
    return acts;
  },

  /** Jest biterken biriken hızı momentuma devret ("flick"). */
  _releaseMomentum(t) {
    const cfg = this.cfg;
    this._scrPrev = null;
    if (!cfg.scrollMomentum || this._scrVel.length < 3) {
      this._scrVel.length = 0;
      return;
    }
    const [t0, x0, y0] = this._scrVel[0];
    const [t1, x1, y1] = this._scrVel[this._scrVel.length - 1];
    this._scrVel.length = 0;
    const dt = t1 - t0;
    if (dt <= 1e-3) return;
    let vx = (x1 - x0) / dt;
    let vy = (y1 - y0) / dt;
    const v = Math.hypot(vx, vy);
    if (v < cfg.scrollFlickMinUnitsS) return; // yavaş bırakış savurma değildir
    const reach = v * cfg.scrollGainPx * cfg.scrollDecayTauS;
    if (cfg.scrollFlickMaxPx > 0 && reach > cfg.scrollFlickMaxPx) {
      const k = cfg.scrollFlickMaxPx / reach;
      vx *= k;
      vy *= k;
    }
    this._momVx = vx;
    this._momVy = vy;
    this._momT = t;
  },

  _killMomentum() {
    this._momVx = this._momVy = 0.0;
  },

  /** Sönen savurmayı ilerlet — her karede, el yokken bile. */
  _tickMomentum(t) {
    const cfg = this.cfg;
    if (this._momVx === 0.0 && this._momVy === 0.0) return [];
    const dt = t - this._momT;
    this._momT = t;
    if (dt <= 0 || dt > 0.5) return []; // kare atladıysa ileri sarma
    const k = Math.exp(-dt / Math.max(cfg.scrollDecayTauS, 1e-3));
    this._momVx *= k;
    this._momVy *= k;
    if (Math.hypot(this._momVx, this._momVy) * cfg.scrollGainPx < cfg.scrollStopPxS) {
      this._killMomentum();
      return [];
    }
    return this._emitScroll(t, this._momVx * dt, this._momVy * dt, [], 'momentum');
  },
};

module.exports = scrollMethods;
