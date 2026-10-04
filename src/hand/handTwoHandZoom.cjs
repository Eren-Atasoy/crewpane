// electron/handTwoHandZoom.cjs — HAND-G1: İKİ ELLE PINCH-ZOOM.
//
// Eren'in tarifi (05.09): "trackpad'de iki parmakla bir şeyi iki ucundan tutup
// çekmek gibi — iki elim yumrukken başparmak+işaret KAPALI, ellerimi
// birbirinden uzaklaştırınca zoom in, yaklaştırınca zoom out."
//
// Neden AYRI modül: `handClickFsm.cjs` jarvis paritesiyle kilitli ve TEK el
// görüyor (kare girer → aksiyon çıkar). İki el ayrı bir sözleşme; oraya
// sokmak pariteyi riske atardı. Bu modül saf: landmark girer, zoom aksiyonu
// çıkar; durum yalnız kendi içinde.
//
// TEK-EL ÇAKIŞMASI YOK: iki el görüldüğü anda tek-el kanalları susturulur
// (kararı `handControlCore` verir) — jest ayrımı el SAYISIYLA yapılır, eşikle
// değil.

'use strict';

const { OneEuroFilter } = require('./handPointerFilter.cjs');
const { LANDMARK } = require('./handScale.cjs');

const L = LANDMARK;

/** Eşikler EL BOYU birimindedir (avuç uzunluğu = |WRIST−MIDDLE_MCP|).
 *  `pinchEnter`/`pinchRelease` tık kanalıyla AYNI sayılar (jarvis 0.14/0.28):
 *  "parmaklar değdi" ölçüsü iki jestte de aynı olmalı. */
function defaultTwoHandConfig() {
  return {
    enabled: true,
    pinchEnter: 0.14,
    pinchRelease: 0.28,
    enterFrames: 3,
    releaseFrames: 3,
    k: 1.0,
    lnDead: 0.05, // ±%5 ölü bant — sabit ellerde ölçek kaymaz
    min: 0.125,
    max: 8.0,
    minCutoff: 1.0,
    beta: 0.007,
    dCutoff: 1.0,
    minSpan: 0.02, // iki el bu kadar yakınsa mesafe güvenilmez (çapa kurulmaz)
  };
}

/** Avuç uzunluğu — el boyunun ÖLÇEKSİZ payda adayı. `handScale`in çok-kemikli
 *  kestiricisi burada KULLANILMAZ: o durumludur ve el başına bir kopya ister;
 *  iki el için tek kemik yeter (pinch oranı zaten kaba bir eşikle okunuyor). */
function palmSpan(lm) {
  return Math.hypot(lm[L.WRIST].x - lm[L.MIDDLE_MCP].x, lm[L.WRIST].y - lm[L.MIDDLE_MCP].y);
}

/** İmleç çapası — tek-el yoluyla AYNI tanım (rigid_palm): parmak kıvrılırken
 *  neredeyse kıpırdamaz, yani "tutma" pozunda mesafe ölçüsü kaymaz. */
function anchorOf(lm) {
  return [
    (lm[L.WRIST].x + lm[L.INDEX_MCP].x + lm[L.PINKY_MCP].x) / 3,
    (lm[L.WRIST].y + lm[L.INDEX_MCP].y + lm[L.PINKY_MCP].y) / 3,
  ];
}

/** Başparmak↔işaret açıklığı, el boyuna ORANLA. */
function pinchRatio(lm) {
  const span = palmSpan(lm);
  if (!(span > 1e-6)) return Infinity;
  return Math.hypot(lm[L.THUMB_TIP].x - lm[L.INDEX_TIP].x, lm[L.THUMB_TIP].y - lm[L.INDEX_TIP].y) / span;
}

function valid(lm) {
  return Array.isArray(lm) && lm.length >= 21;
}

class TwoHandZoom {
  constructor(cfg = null) {
    this.cfg = { ...defaultTwoHandConfig(), ...(cfg || {}) };
    this.active = false;
    this.scale = 1.0;
    this._holding = [false, false]; // el başına pinch MANDALI (histerezis)
    this._enterFrames = 0;
    this._relFrames = 0;
    this._ref = 0; // çapa mesafesi (görüntüye normalize)
    this._base = 1.0;
    this._mid = [0.5, 0.5];
    this._f = new OneEuroFilter(this.cfg.minCutoff, this.cfg.beta, this.cfg.dCutoff);
  }

  /** Histerezisli tutma mandalı: `pinchEnter`in ALTINDA kapanır,
   *  `pinchRelease`in ÜSTÜNDE açılır; arada son hâl korunur (titremede jest
   *  ortasında kopmasın). */
  _grip(i, lm) {
    const r = pinchRatio(lm);
    if (r < this.cfg.pinchEnter) this._holding[i] = true;
    else if (r > this.cfg.pinchRelease) this._holding[i] = false;
    return this._holding[i];
  }

  _end(t) {
    this.active = false;
    this._enterFrames = 0;
    this._relFrames = 0;
    this._f.reset();
    return { kind: 'zoom', reason: 'end', scale: this.scale, delta: 1.0, nx: this._mid[0], ny: this._mid[1] };
  }

  /**
   * @param {object} p { t, hands: [landmarks…] }
   * @returns {{active:boolean, actions:object[]}}
   *   actions: { kind:'zoom', reason:'start'|'move'|'end', scale, delta, nx, ny }
   *   nx/ny GÖRÜNTÜYE normalize orta nokta — ekrana eşleme çağıranın işi.
   */
  update(p) {
    const cfg = this.cfg;
    const acts = [];
    const t = Number(p && p.t) || 0;
    const hands = Array.isArray(p && p.hands) ? p.hands.filter(valid) : [];

    if (!cfg.enabled || hands.length < 2) {
      this._holding = [false, false];
      this._enterFrames = 0;
      if (this.active) acts.push(this._end(t));
      return { active: this.active, actions: acts };
    }

    const a = hands[0];
    const b = hands[1];
    const grip = this._grip(0, a) && this._grip(1, b);
    const [ax, ay] = anchorOf(a);
    const [bx, by] = anchorOf(b);
    const d = Math.hypot(ax - bx, ay - by);
    this._mid = [(ax + bx) / 2, (ay + by) / 2];

    if (!this.active) {
      this._enterFrames = grip ? this._enterFrames + 1 : 0;
      if (this._enterFrames >= cfg.enterFrames && d >= cfg.minSpan) {
        this.active = true;
        this._relFrames = 0;
        this._ref = d;
        this._base = 1.0;
        this.scale = 1.0;
        this._f.reset();
        acts.push({ kind: 'zoom', reason: 'start', scale: 1.0, delta: 1.0, nx: this._mid[0], ny: this._mid[1] });
      }
      return { active: this.active, actions: acts };
    }

    // --- etkin jest ---
    this._relFrames = grip ? 0 : this._relFrames + 1;
    if (this._relFrames >= cfg.releaseFrames) {
      acts.push(this._end(t));
      return { active: this.active, actions: acts };
    }
    if (!(d > 1e-6) || !(this._ref > 1e-6)) return { active: this.active, actions: acts };

    // LOG ALANI: 2× büyütmek ile 2× küçültmek simetrik olsun; tek filtre sabiti
    // ikisine de yeter (tek-el yoluyla aynı disiplin).
    const uf = this._f.filter(Math.log(d), t);
    const lnR = uf - Math.log(this._ref);
    if (Math.abs(lnR) < cfg.lnDead) return { active: this.active, actions: acts };
    const raw = this._base * Math.exp(cfg.k * lnR);
    const scale = Math.max(cfg.min, Math.min(cfg.max, raw));
    const delta = scale / (this.scale || 1);
    this.scale = scale;
    acts.push({ kind: 'zoom', reason: 'move', scale, delta, nx: this._mid[0], ny: this._mid[1] });
    return { active: this.active, actions: acts };
  }

  /** Acil durdurma: jest varsa kapat (aksiyon üretmeden). */
  reset() {
    this.active = false;
    this.scale = 1.0;
    this._holding = [false, false];
    this._enterFrames = this._relFrames = 0;
    this._f.reset();
  }
}

module.exports = { TwoHandZoom, defaultTwoHandConfig, palmSpan, anchorOf, pinchRatio };
