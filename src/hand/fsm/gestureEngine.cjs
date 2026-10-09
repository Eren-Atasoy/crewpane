'use strict';

const { MOVE, ARMED, CLICK, DRAG, INF, action } = require('./constants.cjs');

const gestureMethods = {
  _moveAndDwell(f, dwell = true) {
    const acts = [action('move', f.x, f.y)];
    if (this.state !== MOVE) this.state = MOVE;
    const cfg = this.cfg;
    if (!(dwell && cfg.dwellEnabled)) {
      this._dwellFrom = null;
      return acts;
    }
    if (
      this._dwellFrom === null
      || Math.hypot(f.x - this._dwellPos[0], f.y - this._dwellPos[1]) > cfg.dwellRadiusPx
    ) {
      this._dwellFrom = f.t;
      this._dwellPos = [f.x, f.y];
      return acts;
    }
    if (f.t - this._dwellFrom >= cfg.dwellS) {
      const fired = this._fireLeft(f.t, this._dwellPos, 'dwell');
      for (const a of fired) acts.push(a);
      this._dwellFrom = null;
      this._endGesture(f.t);
    }
    return acts;
  },

  /** DONDUR + PRE-ROLL ÇAPA — çapa KOŞULLU: el o pencerede OTURDUYSA nişan
   *  noktasıdır; yol alıyorsa bayat konumdur ve imleci gözle görülür sıçratır
   *  (ölçüldü: durgun 2.4 px, >500 px/sn'de 138 px). Ölçüt: pencere yayılımı. */
  _arm(f, btn) {
    this._killMomentum(); // tıklamaya giden el akan sayfayı durdurur
    this._probFrom = f.t; // A5 — taze pinch: imza denetimi başlar
    this._probBad = 0;
    const [ax0, ay0] = this._prerollAnchor(f.t, [f.x, f.y]);
    let ax = ax0;
    let ay = ay0;
    this.lastAnchorGated = this.lastPrerollSpread > this.cfg.anchorStillPx;
    if (this.lastAnchorGated) {
      ax = f.x;
      ay = f.y; // el yolda: düzeltme YOK, sıçrama YOK
    }
    this._anchor = [ax, ay];
    this.lastAnchor = [ax, ay];
    this.lastAnchorShift = Math.hypot(f.x - ax, f.y - ay);
    this._btn = btn;
    this._armedAt = f.t;
    this._confirm = 0;
    this._confirmedAt = null;
    this._fired = false;
    this.state = ARMED;
    return [action('anchor', ax, ay, { reason: btn })];
  },

  _armed(f, di, dm, acts) {
    const cfg = this.cfg;
    // A5 — SESSİZ DÜŞÜŞ: taze pinch tık imzasını koruyamadı (el yumruğa
    // kapanıyor). Aksiyon YOK, cool-off YOK — kullanıcı tıklamayı denemedi ki
    // cezalandıralım; hemen sonraki GERÇEK tık gecikmesin.
    if (this._probationFails(f)) {
      // Düşen pinch BLOKLANIR: yoksa sonraki kare yeniden kollar ve imza
      // bozuk kaldığı sürece her karede bir `anchor` üretilir — imleç ardarda
      // çapaya ışınlanırdı (ölçüldü: 5 karede 5 anchor). Blok, parmaklar
      // `release` eşiğinin üstüne açılınca kendiliğinden kalkar (mevcut yol).
      this._blocked.add(this._btn);
      this.state = MOVE;
      this._probFrom = null;
      this._probBad = 0;
      this._confirm = 0;
      this._confirmedAt = null;
      this._fired = false;
      return acts;
    }
    const left = this._btn === 'left';
    const d = left ? di : dm;
    const other = left ? dm : di;
    const enter = left ? cfg.enter : cfg.rightEnter;
    const release = left ? cfg.release : cfg.rightRelease;
    const oEnter = left ? cfg.rightEnter : cfg.enter;

    if (this._confirmedAt === null) {
      // Henüz "değdi" demedik. İki jest de yaklaşıyorsa ORANI küçük olan
      // kazanır — el yolda fikir değiştirebilir, çapa korunur.
      if (other / Math.max(oEnter, 1e-9) < d / Math.max(enter, 1e-9) - 0.15) {
        this._btn = left ? 'right' : 'left';
        this._confirm = 0;
        return acts;
      }
      if (d < enter) {
        this._confirm += 1;
        if (this._confirm >= cfg.confirmFrames) {
          this._confirmedAt = f.t;
          // Sürükleme ölçümünün SIFIR noktası: parmakların kapandığı an.
          this._press = [f.x, f.y];
          this.dragTravel = 0.0;
          if (!left) {
            // SAĞ TIK: anında, tek atış — öncesinde SOL TIK YOK.
            acts = acts.concat(this._fireRight(f.t, this._anchor));
            this._fired = true;
          }
        }
      } else if (d > release) {
        // Yaklaştı ama dokunmadı → iptal, tık YOK, imleç serbest.
        this.state = MOVE;
        this._endGesture(f.t);
      } else {
        this._confirm = 0;
        if (f.t - this._armedAt > cfg.armTimeoutS) {
          // Yarı kapalı el eşik bandında asılı kaldı — süresiz donma olmasın.
          this._blocked.add(this._btn);
          this.state = MOVE;
          this._endGesture(f.t);
        }
      }
      return acts;
    }

    // --- onaylandı ---
    if (d > release) {
      // BIRAKILDI. Sürükleme başlamadıysa bu bir TIKtır — tutuş süresi ne
      // olursa olsun (insan doğal teması ~1 sn; süre tek ölçüt olamaz).
      if (left && this._pressed) {
        // HND-B4: buton zaten ÇAPADA basılı, arada hiç hareket gitmedi →
        // bırakışı aynı noktaya yaz: down(x,y)…up(x,y) = OS için tık tanımı.
        acts.push(action('left_up', this._anchor[0], this._anchor[1], { clicks: this._pressClicks, reason: 'hold_click' }));
      } else if (left && !this._fired) {
        acts = acts.concat(this._fireLeft(f.t, this._anchor, 'tap'));
      }
      this.state = acts.length ? CLICK : MOVE;
      this._endGesture(f.t);
      return acts;
    }
    // SÜRÜKLE = yeterince UZUN tutuş VE yeterince BÜYÜK hareket (ölçüldü:
    // yalnız süre 22/22 dokunuşu sürükleme sayıyordu; yalnız hareket de olmaz).
    if (!left || this._fired) return acts;

    // ① ASKIDA BASIŞ (HND-B4) — hareket şartı YOK, yalnız tutuş: buton çapada
    //    basılır, imleç donuk kalır, commit'e kadar tek hareket olayı gitmez.
    if (cfg.pressHold && !this._pressed && f.t - this._confirmedAt >= cfg.dragHoldS) {
      this._pressed = this.pressed = true;
      // Çift tık ZİNCİRİ korunur: basılı-tutmaya dönen dokunuş da çift olabilir.
      this._pressClicks = this._noteClick(f.t, this._anchor);
      this._lastLeft = f.t;
      acts.push(action('left_down', this._anchor[0], this._anchor[1], { clicks: this._pressClicks, reason: 'hold' }));
    }

    // ② KARAR — gerçekten SÜRÜKLEME mi? (süre VE hareket)
    if (f.t - this._confirmedAt >= cfg.tapMaxS) {
      const moved = Math.hypot(f.x - this._press[0], f.y - this._press[1]);
      this.dragTravel = moved;
      const slop = this._slop(f);
      if (moved > slop) {
        // Buton ÇAPADA basılır (nişan noktası), hareket kapanma anından ölçülür.
        this._fired = true;
        this.state = DRAG;
        this._probFrom = null; // sürükleme başladı: imza denetimi kapanır
        this._probBad = 0;
        if (!this._pressed) {
          this._pressed = this.pressed = true;
          this._pressClicks = this._noteClick(f.t, this._anchor);
          this._lastLeft = f.t;
          acts.push(action('left_down', this._anchor[0], this._anchor[1], { clicks: this._pressClicks, reason: 'drag_start' }));
        }
        // Askıdaki basış sürüklemeye DÖNÜŞÜYOR: imleç donuktan serbeste geçiş.
        acts.push(action('move', f.x, f.y, { reason: 'drag_commit' }));
      }
    }
    return acts;
  },

  /** O karede geçerli sürükleme GİRİŞ eşiği (px). dragScaleNorm varsayılan
   *  KAPALI (ölçüm plandaki öneriyle çelişti — gerekçe FsmConfig'te). */
  _slop(f) {
    const cfg = this.cfg;
    const base = cfg.dragSlopPx;
    this.lastDragSlop = base;
    if (!cfg.dragScaleNorm || !f.scale || cfg.dragScaleRef <= 0) return base;
    const k = Math.max(0.6, Math.min(1.6, f.scale / cfg.dragScaleRef));
    this.lastDragSlop = base * k;
    return this.lastDragSlop;
  },

  /** Butonu NEREDE bırakmalı: askıdaki basış çapada yapıldı ve hiç hareket
   *  gitmedi → bırakış da çapaya; sürüklemede imleç zaten serbest. */
  _releasePos() {
    return this._pressed && this.state !== DRAG ? this._anchor : this._lastPos;
  },

  /** Çift tık defteri — hem left_click hem HND-B4 down/up çifti buradan geçer
   *  (ayrı yazılsalar basılı-tutmaya dönen dokunuş zinciri koparırdı). */
  _noteClick(t, pos) {
    let clicks;
    if (
      t - this._lastClickT <= this.cfg.doubleWindowS
      && Math.hypot(pos[0] - this._lastClickPos[0], pos[1] - this._lastClickPos[1]) <= this.cfg.doubleSlopPx
    ) {
      clicks = 2;
      this._lastClickT = -INF; // üçlü tıka zincirlenmesin
    } else {
      clicks = 1;
      this._lastClickT = t;
    }
    this._lastClickPos = [pos[0], pos[1]];
    return clicks;
  },

  _fireLeft(t, pos, reason = '') {
    if (t - this._lastLeft < this.cfg.leftCooldownS) return [];
    const clicks = this._noteClick(t, pos);
    this._lastLeft = t;
    this.state = CLICK;
    return [action('left_click', pos[0], pos[1], { clicks, reason })];
  },

  _fireRight(t, pos) {
    if (t - this._lastRight < this.cfg.rightCooldownS) return [];
    this._lastRight = t;
    this.state = CLICK;
    return [action('right_click', pos[0], pos[1])];
  },
};

module.exports = gestureMethods;
