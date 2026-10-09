'use strict';

const { OneEuroFilter } = require('../handPointerFilter.cjs');
const {
  IDLE,
  MOVE,
  ARMED,
  CLICK,
  DRAG,
  SCROLL,
  ZOOM,
  PARK,
  INF,
  action,
} = require('./constants.cjs');
const { defaultConfig, approachOf, rightApproachOf } = require('./config.cjs');
const scrollMethods = require('./scrollEngine.cjs');
const zoomMethods = require('./zoomEngine.cjs');
const gestureMethods = require('./gestureEngine.cjs');

/**
 * Frame (girdi): { t, hand, x, y, pinchIndex, pinchMiddle, park, twoFingers,
 *   scale, pinky, rawX, rawY } — landmark DEĞİL, ondan türetilmiş sayılar.
 * Action (çıktı): { kind, x, y, direction, clicks, reason, dx, dy }
 *   kind ∈ move | anchor | left_click | left_down | left_up | right_click | scroll | zoom
 */
class ClickFSM {
  constructor(cfg = null) {
    this.cfg = { ...defaultConfig(), ...(cfg || {}) };
    this.state = IDLE;
    this._buf = []; // pre-roll halka tamponu [t, x, y]
    this._cooloffUntil = 0.0;
    this._parkFrames = 0;
    this._parkReady = true;
    this._lostSince = null;
    this._dragRelFrames = 0;
    this._scrollFrames = 0;
    this._lastScroll = -INF;
    this._scrPrev = null; // [t, ux, uy]
    this._scrRaw = null; // süzülmemiş son konum [ux, uy]
    this._scrFx = new OneEuroFilter(this.cfg.scrollMinCutoff, this.cfg.scrollBeta, this.cfg.scrollDcutoff);
    this._scrFy = new OneEuroFilter(this.cfg.scrollMinCutoff, this.cfg.scrollBeta, this.cfg.scrollDcutoff);
    this._scrAccX = 0.0;
    this._scrAccY = 0.0;
    this._scrVel = []; // [t, ux, uy]
    this._momVx = 0.0;
    this._momVy = 0.0;
    this._momT = 0.0;
    this._pinkyReady = true;
    this._pinkyOn = false;
    // ---- HAND-G9 ----
    this._spdWin = []; // [t, x, y] — hız penceresi (A4)
    this.lastHandSpeed = 0.0; // px/sn (HUD/telemetri de okur)
    this._probFrom = null; // taze pinch'in probation başlangıcı (A5)
    this._probBad = 0;
    // ---- HAND-G1 zoom ----
    // Kanal MANDALI: histerezis bandında (1.35–1.55) DEĞİŞMEZ; başlangıç tık.
    this._zoomChannel = false;
    this._zoomFrames = 0;
    this._zoomRelFrames = 0;
    this._zoomRef = 1.0; // çapa açıklık (el-boyu birimi)
    this._zoomBase = 1.0; // cırcır sonrası korunan birikmiş ölçek
    this._zoomScale = 1.0;
    this._zoomAnchor = [0.0, 0.0];
    this._zoomEdgeDir = 0;
    this._zoomEdgeSince = null;
    this._zoomEdgeExtreme = 0.0; // uçta görülen en ileri açıklık (geri dönüş nöbeti)
    this._zoomF = new OneEuroFilter(this.cfg.zoomMinCutoff, this.cfg.zoomBeta, this.cfg.zoomDcutoff);
    this.precision = false;
    this._lastLeft = -INF;
    this._lastRight = -INF;
    this._lastClickT = -INF;
    this._lastClickPos = [0.0, 0.0];
    this._btn = 'left';
    this._anchor = [0.0, 0.0];
    this._press = [0.0, 0.0]; // sürükleme ölçüm referansı: parmakların KAPANDIĞI an
    this._armedAt = 0.0;
    this._confirm = 0;
    this._confirmedAt = null;
    this._fired = false;
    this._pressed = false; // HND-B4 askıda basış
    this._pressClicks = 1;
    this.pressed = false; // HUD/telemetri okur
    this._blocked = new Set();
    this._dwellFrom = null;
    this._dwellPos = [0.0, 0.0];
    this._lastPos = [0.0, 0.0];
    // Telemetri / HUD
    this.lastAnchor = null;
    this.lastAnchorShift = 0.0;
    this.lastAnchorGated = false;
    this.lastPrerollSpread = 0.0;
    this.lastDragSlop = 0.0;
    this.dragTravel = 0.0;
    this.scrollTravel = 0.0;
  }

  get frozen() {
    return this.state === ARMED || this.state === CLICK || this.state === PARK
      || this.state === SCROLL || this.state === ZOOM;
  }

  static _d(v) {
    return v === null || v === undefined ? INF : Number(v);
  }

  _trim(t) {
    const w = this.cfg.prerollS + 0.30;
    while (this._buf.length && t - this._buf[0][0] > w) this._buf.shift();
  }

  /** Jest BAŞLAMADAN önceki kararlı konum — pencere MEDYANI (tek sıçrayan kare
   *  çapayı çekmesin); son ~50 ms dışarıda (el orada zaten pinch'e gidiyor). */
  _prerollAnchor(t, fallback) {
    const lo = t - this.cfg.prerollS;
    const hi = t - this.cfg.prerollGuardS;
    const win = this._buf.filter((p) => p[0] >= lo && p[0] <= hi);
    if (win.length < 3) {
      this.lastPrerollSpread = 0.0;
      return fallback;
    }
    const xs = win.map((p) => p[1]).sort((a, b) => a - b);
    const ys = win.map((p) => p[2]).sort((a, b) => a - b);
    const m = xs.length >> 1;
    let ax;
    let ay;
    if (xs.length % 2) {
      ax = xs[m];
      ay = ys[m];
    } else {
      ax = (xs[m - 1] + xs[m]) / 2.0;
      ay = (ys[m - 1] + ys[m]) / 2.0;
    }
    // Pencere YAYILIMI = "el bu pencerede oturmuş muydu" (çapanın geçerlilik
    // koşulu; büyükse medyan nişan noktası değil, yolun ortasıdır).
    const d = win.map((p) => Math.hypot(p[1] - ax, p[2] - ay)).sort((a, b) => a - b);
    this.lastPrerollSpread = d[Math.max(0, Math.trunc(0.95 * d.length) - 1)];
    return [ax, ay];
  }

  /** HAND-G9/A4 — EL HIZI (px/sn), FSM'in KENDİ penceresinden. Boru hattının
   *  `lastSpeed`i alınmıyor: FSM saf kalmalı (kare girer → aksiyon çıkar) ve
   *  testte sentetik kareyle sürülebilmeli. */
  _updateSpeed(f) {
    const w = this.cfg.dragSpeedWindowS;
    this._spdWin.push([f.t, f.x, f.y]);
    while (this._spdWin.length > 1 && f.t - this._spdWin[0][0] > w) this._spdWin.shift();
    if (this._spdWin.length < 2) { this.lastHandSpeed = 0.0; return; }
    const [t0, x0, y0] = this._spdWin[0];
    const dt = f.t - t0;
    this.lastHandSpeed = dt > 0 ? Math.hypot(f.x - x0, f.y - y0) / dt : 0.0;
  }

  /** A4 — hızlıyken bırakma çıtası yükselir. Yavaşta eşik AYNEN kalır
   *  (jarvis paritesi: bayrak kapalıyken de aynen). */
  _dragReleaseNow() {
    const cfg = this.cfg;
    if (!cfg.speedAwareRelease) return cfg.dragRelease;
    return this.lastHandSpeed > cfg.dragFastSpeedPx ? cfg.dragReleaseFast : cfg.dragRelease;
  }

  /** A5 — TAZE pinch'in tık imzası: arka parmaklar AÇIK olmalı. `backMean`
   *  yoksa (eski kare / sentetik fikstür) probation ÇALIŞMAZ → parite korunur.
   *  @returns {boolean} bu kare probation'ı DÜŞÜRDÜ mü */
  _probationFails(f) {
    const cfg = this.cfg;
    if (!cfg.pinchProbation || this._probFrom === null) return false;
    // KUSUR (kendi ölçümümüz yakaladı): basış COMMIT olduktan sonra düşürmek
    // `left_up` göndermeden durumu bırakırdı → OS'ta buton BASILI kalırdı
    // (asılı mouse-down, en kötü arıza sınıfı). Probation yalnız HENÜZ
    // BASILMAMIŞ taze pinch içindir; sonrası DRAG çıkışının işi.
    if (this._pressed || this.state === DRAG) { this._probFrom = null; this._probBad = 0; return false; }
    if (f.t - this._probFrom > cfg.probationS) { this._probFrom = null; this._probBad = 0; return false; }
    const back = ClickFSM._d(f.backMean);
    if (!Number.isFinite(back)) return false; // imza ölçülemiyor → hüküm YOK
    // Hızlı elde bulanıklık imzayı bozar; o kareleri saymayız (yanlış düşüş olmasın).
    if (this.lastHandSpeed > cfg.dragFastSpeedPx) return false;
    this._probBad = back <= cfg.clickBackMin ? this._probBad + 1 : 0;
    return this._probBad >= cfg.probationBadFrames;
  }

  _endGesture(t) {
    this._cooloffUntil = t + this.cfg.cooloffS;
    this._dragRelFrames = 0;
    this._confirm = 0;
    this._confirmedAt = null;
    this._fired = false;
    this._pressed = this.pressed = false;
    this._pressClicks = 1;
    this._dwellFrom = null;
  }

  /** Cool-off — AMA aynı butonun çift-tık penceresi içindeki tekrarı serbest
   *  (0.20 s cool-off insanın ~0.15 s aralıklı ikinci pinch'ini yutuyordu). */
  _cooling(t, btn = '') {
    if (t >= this._cooloffUntil) return false;
    if (btn === 'left' && this._lastClickT > -INF && t - this._lastClickT <= this.cfg.doubleWindowS) {
      return false;
    }
    return true;
  }

  /** Başparmak+serçe: TEK jest, işini pinkyRole seçer; mandallı (bir kez → aç,
   *  tekrar → kapat) — basılı tutulurken işaretle pinch yapılamaz. */
  _pinkyLatch(f) {
    const cfg = this.cfg;
    if (cfg.pinkyRole !== 'precision') return;
    // HAND-G1 — ZOOM pozunda serçe KIVRIK olduğu için `thumbPinkyDist` kaçınılmaz
    // olarak pinkyEnter'ın altına düşer ve hassas kip kendiliğinden açılırdı.
    // Mandal ASKIYA alınır; `_pinkyReady = false` ile çıkışta da tek seferlik
    // sahte tetik olmaz (önce serçe gerçekten AÇILMALI).
    if (this._zoomChannel || this.state === ZOOM) {
      this._pinkyReady = false;
      return;
    }
    const d = ClickFSM._d(f.pinky);
    if (d > cfg.pinkyRelease) {
      this._pinkyReady = true;
      return;
    }
    if (d < cfg.pinkyEnter && this._pinkyReady) {
      this._pinkyReady = false;
      this._pinkyOn = !this._pinkyOn;
      this.precision = this._pinkyOn;
    }
  }

  // ------------------------------------------------------------- ana giriş
  update(f) {
    const cfg = this.cfg;
    let acts = [];

    // CLICK tek karelik; sonraki karede MOVE'a düşer.
    if (this.state === CLICK) this.state = MOVE;

    // Momentum her karede akar (el yokken bile; PARK'ta kesilir).
    acts = acts.concat(this._tickMomentum(f.t));

    // ---- el kayboldu --------------------------------------------------
    if (!f.hand) {
      // Tek karelik dedektör göz kırpması sürüklemeyi öldürmesin (ölçüldü:
      // kopmaların yarısı ≤0.07 sn; gerçek "el çekildi" ≥0.18 sn).
      if (this._lostSince === null) this._lostSince = f.t;
      if (f.t - this._lostSince <= cfg.lostGraceS) return acts; // durum korunur
      if (this.state === DRAG || this._pressed) {
        // El gerçekten gittiyse butonu BIRAK — yoksa fare basılı kalır.
        const [rx, ry] = this._releasePos();
        acts.push(action('left_up', rx, ry, { clicks: this._pressClicks, reason: 'hand_lost' }));
      }
      if (this.state === SCROLL) {
        acts = acts.concat(this._flushResidual(f.t));
        this._releaseMomentum(f.t);
      }
      if (this.state === ZOOM) acts.push(this._zoomEnd(f.t));
      this.state = IDLE;
      this._buf.length = 0;
      this._parkFrames = this._scrollFrames = 0;
      this._zoomFrames = this._zoomRelFrames = 0;
      this._zoomChannel = false;
      this._dragRelFrames = 0;
      this._endGesture(f.t);
      return acts;
    }
    this._lostSince = null;

    this._buf.push([f.t, f.x, f.y]);
    this._lastPos = [f.x, f.y];
    this._trim(f.t);
    this._updateSpeed(f);

    const di = ClickFSM._d(f.pinchIndex);
    const dm = ClickFSM._d(f.pinchMiddle);
    const pinching = di < cfg.release || dm < cfg.rightRelease;

    // ---- HAND-G1: ZOOM/TIK KANAL MANDALI (poz kapısı, mesafe DEĞİL) --------
    // Kanal yalnız eşiklerin DIŞINDA değişir; 1.35–1.55 ölü bandında son mandal
    // korunur. `backMean` yoksa (eski kare / sentetik fikstür) kanal HİÇ zoom
    // olmaz — jarvis paritesi bu yüzden bozulmaz.
    if (cfg.zoomEnabled) {
      const back = ClickFSM._d(f.backMean); // yoksa Infinity → tık kanalı
      if (back < cfg.zoomBackMax) this._zoomChannel = true;
      else if (back > cfg.zoomBackMin) this._zoomChannel = false;
    } else {
      this._zoomChannel = false;
    }

    // ---- PARK — kontrol askıda (poz DEĞİL; varsayılan kapalı) ---------
    const park = Boolean(f.park) && cfg.parkEnabled;
    this._parkFrames = park ? this._parkFrames + 1 : 0;
    if (!park) {
      this._parkReady = true;
    } else if (this._parkFrames >= cfg.parkFrames && this._parkReady) {
      this._parkReady = false; // mandal: tek tetik
      if (this.state === PARK) {
        this.state = MOVE;
        this._endGesture(f.t);
        return acts;
      }
      if (this.state === DRAG || this._pressed) {
        const [rx, ry] = this._releasePos();
        acts.push(action('left_up', rx, ry, { clicks: this._pressClicks, reason: 'park' }));
      }
      this.state = PARK;
      this._killMomentum();
      this._endGesture(f.t);
      return acts;
    }
    if (this.state === PARK) {
      if (!cfg.parkLatch && !park) {
        this.state = MOVE;
        this._endGesture(f.t);
      }
      return acts; // PARK'ta imleç de tık da yok
    }

    // ---- 🤙 başparmak+serçe: mandallı tek jest ------------------------
    this._pinkyLatch(f);

    // ---- HAND-G1: POZ, YÜRÜYEN TIK JESTİNİ EZER ------------------------
    if (cfg.zoomEnabled && this._zoomChannel) {
      if (this.state === DRAG || this._pressed) {
        const [rx, ry] = this._releasePos();
        acts.push(action('left_up', rx, ry, { clicks: this._pressClicks, reason: 'zoom_pose' }));
        this.state = MOVE;
        this._endGesture(f.t);
      } else if (this.state === ARMED) {
        this._blocked.add(this._btn);
        this.state = MOVE;
        this._confirm = 0;
        this._confirmedAt = null;
        this._fired = false;
        this._dwellFrom = null;
      }
    }

    // ---- DRAG (buton basılı, imleç serbest) ---------------------------
    if (this.state === DRAG) {
      this.dragTravel = Math.hypot(f.x - this._press[0], f.y - this._press[1]);
      if (di > this._dragReleaseNow()) this._dragRelFrames += 1;
      else this._dragRelFrames = 0;
      if (this._dragRelFrames >= cfg.dragReleaseFrames) {
        this._dragRelFrames = 0;
        const back = Math.hypot(f.x - this._press[0], f.y - this._press[1]);
        if (back <= cfg.dragSnapPx) {
          acts.push(action('left_up', this._anchor[0], this._anchor[1], { clicks: this._pressClicks, reason: 'snap' }));
        } else {
          acts.push(action('left_up', f.x, f.y, { clicks: this._pressClicks }));
        }
        this.state = MOVE;
        this.dragTravel = 0.0;
        this._endGesture(f.t);
      } else {
        acts.push(action('move', f.x, f.y, { reason: 'drag' }));
      }
      return acts;
    }

    // ---- ARMED (dondurulmuş; tık/sürükle kararı burada) ---------------
    if (this.state === ARMED) return this._armed(f, di, dm, acts);

    // ---- SCROLL (✌️) ---------------------------------------------------
    this._scrollFrames = f.twoFingers ? this._scrollFrames + 1 : 0;
    if (this.state === SCROLL) {
      if (!f.twoFingers) {
        acts = acts.concat(this._flushResidual(f.t));
        this._releaseMomentum(f.t);
        this.state = MOVE;
        this._endGesture(f.t);
        return acts;
      }
      return this._scroll(f, acts);
    }
    if (this._scrollFrames >= cfg.scrollFrames && !pinching) {
      this.state = SCROLL;
      this._killMomentum(); // yeni jest akan momentumu keser (trackpad'e parmak koymak)
      this._scrPrev = null;
      this._scrVel.length = 0;
      this._scrFx.reset();
      this._scrFy.reset();
      this.scrollTravel = 0.0;
      return this._scroll(f, acts);
    }

    // ---- ZOOM (yumruk + açıklık) — SCROLL'ün kardeşi -------------------
    if (this.state === ZOOM) {
      this._zoomRelFrames = this._zoomChannel ? 0 : this._zoomRelFrames + 1;
      if (this._zoomRelFrames >= cfg.zoomReleaseFrames) {
        this._zoomRelFrames = 0;
        acts.push(this._zoomEnd(f.t));
        this.state = MOVE;
        this._endGesture(f.t);
        return acts;
      }
      return this._zoom(f, di, acts);
    }
    this._zoomFrames = this._zoomChannel ? this._zoomFrames + 1 : 0;
    if (cfg.zoomEnabled && this._zoomFrames >= cfg.zoomFrames && !pinching) {
      this.state = ZOOM;
      this._killMomentum();
      this._zoomRef = Math.max(di, 1e-6);
      this._zoomBase = 1.0;
      this._zoomScale = 1.0;
      this._zoomAnchor = [f.x, f.y];
      this._zoomEdgeDir = 0;
      this._zoomEdgeSince = null;
      this._zoomEdgeExtreme = 0.0;
      this._zoomRelFrames = 0;
      this._zoomF.reset();
      this._blocked.add('left');
      this._blocked.add('right');
      acts.push(action('zoom', f.x, f.y, { reason: 'start', scale: 1.0, delta: 1.0 }));
      return acts;
    }

    // ---- MOVE / IDLE: jest tetikleyicileri ----------------------------
    if (this._blocked.has('left') && di > cfg.release) this._blocked.delete('left');
    if (this._blocked.has('right') && dm > cfg.rightRelease) this._blocked.delete('right');

    const ri = di / Math.max(cfg.enter, 1e-9);
    const rm = dm / Math.max(cfg.rightEnter, 1e-9);
    if (dm < rightApproachOf(cfg) && rm <= ri && !this._blocked.has('right') && !this._cooling(f.t, 'right')) {
      acts = acts.concat(this._arm(f, 'right'));
    } else if (di < approachOf(cfg) && ri < rm && !this._blocked.has('left') && !this._cooling(f.t, 'left')) {
      acts = acts.concat(this._arm(f, 'left'));
    } else {
      acts = acts.concat(this._moveAndDwell(f, !this._cooling(f.t)));
    }
    return acts;
  }
}

// Prototype mixin attaching gesture, scroll, and zoom engines
Object.assign(ClickFSM.prototype, scrollMethods, zoomMethods, gestureMethods);

module.exports = {
  ClickFSM,
};
