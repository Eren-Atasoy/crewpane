'use strict';

const { action } = require('./constants.cjs');

const zoomMethods = {
  /** ZOOM biterken tek "end" aksiyonu — overlay halkasını kapatır; imleç
   *  kanalı serbest kalır. `delta` 1: OS'a tekerlek gitmez. */
  _zoomEnd(t) {
    this._zoomEdgeDir = 0;
    this._zoomEdgeSince = null;
    return action('zoom', this._zoomAnchor[0], this._zoomAnchor[1], {
      reason: 'end', scale: this._zoomScale, delta: 1.0,
    });
  },

  /**
   * Açıklık → ölçek. LOG ALANINDA çalışır: sinyal çarpımsaldır (2× büyütmek ile
   * 2× küçültmek simetrik olmalı), log'da tek filtre sabiti ikisine de yeter.
   * Ölü bant ±%5 — ölçülen %1,19 p90 açıklık gürültüsü asla aksiyon doğurmaz.
   */
  _zoom(f, di, acts) {
    const cfg = this.cfg;
    if (!Number.isFinite(di) || di <= 0) return acts;
    const uf = this._zoomF.filter(Math.log(di), f.t);
    const lnR = uf - Math.log(this._zoomRef);

    // Cırcır: açıklık uçta ve kullanıcı aynı yönde bastırmayı sürdürüyorsa
    // çapa YENİLENİR; biriken ölçek `_zoomBase`te korunur (trackpad'de
    // parmakları kaldırıp yeniden koymanın karşılığı).
    // "Bastırma" = uçta DURMAK değil, aynı yönde İLERLEMEYE devam etmek. Yalnız
    // uca bakmak yetmiyordu: kullanıcı büyütüp geri kapatırken açıklık bir süre
    // üst uçta kalıyor ve çapa inişte de yenileniyordu — ölçek bir daha 1'in
    // altına inemiyordu (test yakaladı). Geri dönüş sayacı SIFIRLAR.
    const dir = di <= cfg.zoomEdgeLo ? -1 : (di >= cfg.zoomEdgeHi ? 1 : 0);
    const reversed = this._zoomEdgeDir === 1 ? di < this._zoomEdgeExtreme * 0.98
      : (this._zoomEdgeDir === -1 ? di > this._zoomEdgeExtreme * 1.02 : false);
    if (dir === 0 || reversed) {
      this._zoomEdgeDir = dir;
      this._zoomEdgeSince = dir === 0 ? null : f.t;
      this._zoomEdgeExtreme = di;
    } else if (this._zoomEdgeDir !== dir) {
      this._zoomEdgeDir = dir;
      this._zoomEdgeSince = f.t;
      this._zoomEdgeExtreme = di;
    } else if (this._zoomEdgeSince !== null && f.t - this._zoomEdgeSince >= cfg.zoomRatchetS) {
      this._zoomBase = this._zoomScale;
      this._zoomRef = di;
      this._zoomF.reset();
      this._zoomEdgeSince = f.t;
      this._zoomEdgeExtreme = di;
      return acts; // yeniden çapalama karesinde aksiyon YOK (sıçrama olmasın)
    } else if (dir === 1 ? di > this._zoomEdgeExtreme : di < this._zoomEdgeExtreme) {
      this._zoomEdgeExtreme = di; // aynı yönde ilerliyor: uç noktayı ilerlet
    }

    if (Math.abs(lnR) < cfg.zoomLnDead) return acts;
    const raw = this._zoomBase * Math.exp(cfg.zoomK * lnR);
    const scale = Math.max(cfg.zoomMin, Math.min(cfg.zoomMax, raw));
    const delta = scale / (this._zoomScale || 1.0);
    this._zoomScale = scale;
    acts.push(action('zoom', this._zoomAnchor[0], this._zoomAnchor[1], {
      reason: 'move', scale, delta,
    }));
    return acts;
  },
};

module.exports = zoomMethods;
