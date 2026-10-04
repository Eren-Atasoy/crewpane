// electron/handClickFsm.cjs — HAND-A2: tıklama durum makinesi.
// jarvis/core/click_fsm.py'nin (HND-F2/B1/B2/B4, F3 scroll) BİREBİR portu.
// Python zinciri emekli — bu dosya artık FSM'in TEK kaynağı (R1 Q8 kararı).
// Her eşik ve her dal jarvis'te ÖLÇÜMLE seçildi; gerekçeler kaynak dosyanın
// docstring'lerinde. Parite: handClickFsm.parity.test.cjs — Python'ın ürettiği
// fikstürlerle aynı girdi → aynı çıktı; bu dosyada "iyileştirme" yapılmaz.
//
// Durumlar: IDLE · MOVE · ARMED · CLICK · DRAG · SCROLL · ZOOM · PARK
// Dört ilke: DONDUR (yaklaşınca imleç kilitlenir) · PRE-ROLL (tık jest öncesi
// kararlı konumdan) · BIRAKINCA (tık bırakışta; uzun tutuş = down…up) ·
// COOL-OFF (jestler arası ölü zaman). HND-B4: basış geciktirilemez — tutuş
// `dragHoldS`i geçince buton ÇAPADA basılır, karar sonraya taşınır.

'use strict';

const { OneEuroFilter } = require('./handPointerFilter.cjs');

const IDLE = 'IDLE';
const MOVE = 'MOVE';
const ARMED = 'ARMED';
const CLICK = 'CLICK';
const DRAG = 'DRAG';
const SCROLL = 'SCROLL';
const ZOOM = 'ZOOM';
const PARK = 'PARK';

const INF = Infinity;

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
    // A4 — SAHTE BIRAKMA: hızlı sürüklerken parmak bulanıklaşır ve `pinchIndex`
    // bir-iki kare `dragRelease`i aşar; kullanıcı bırakmadığı hâlde nesne düşer
    // ("fırlatma"). Hız eşiğin ÜSTÜNDEYSE bırakma çıtası yükselir: el GERÇEKTEN
    // açılmadan sürükleme düşmez.
    speedAwareRelease: true,
    // ÖLÇÜLDÜ (G3 normal kullanım vs G1 hızlı süpürme, DRAG karelerindeki hız):
    //   eşik  800 → normal %33,2 · hızlı %100    ← barehands'in sayısı; BİZDE
    //                normal sürüklemenin ÜÇTE BİRİNİ "hızlı" sayardı (gerçek
    //                bırakmayı geciktirirdi) — birimlerimiz farklı.
    //   eşik 1800 → normal  %1,9 · hızlı %64,3
    //   eşik 2200 → normal  %1,1 · hızlı %57,1   ← KANYON, seçilen
    //   eşik 2600 → normal  %0,0 · hızlı %57,1
    dragFastSpeedPx: 2200.0, // px/sn (ekran DIP; balistik kazanç SONRASI)
    dragReleaseFast: 0.70, // hızlıyken bırakma çıtası (yavaşta 0.42 kalır)
    dragSpeedWindowS: 0.12, // hız penceresi (scrollVelWindowS ile aynı disiplin)
    // A5 — SAHTE KAVRAMA: el yumruğa kapanırken LAWFUL bir OK-işaretinden geçer
    // (işaret başparmağa değer, arka parmaklar hâlâ kavisli) ve histerezis o
    // sahte kavramayı tutar. TAZE pinch ilk `probationS` boyunca TIK İMZASINI
    // (arka parmaklar açık) korumak zorundadır; `probationBadFrames` ardışık
    // imzasız kare → SESSİZ düşüş (aksiyon yok, cool-off yok).
    pinchProbation: true,
    probationS: 0.40,
    probationBadFrames: 4,
    // ÖLÇÜLDÜ: ARMED karelerinde backMean — gerçek tık (G3) p50 1,689 / p95 1,820;
    // yumruk (G1) p50 0,671. 1,35–1,55 arasında seçilen değer sonucu DEĞİŞTİRMİYOR
    // (kanyon geniş, arada kare yok); tık kanalının mandalıyla aynı sayı tutuldu.
    clickBackMin: 1.55,
  };
}

function approachOf(cfg) {
  return Math.min(cfg.enter * cfg.approachMult, cfg.release);
}
function rightApproachOf(cfg) {
  return Math.min(cfg.rightEnter * cfg.approachMult, cfg.rightRelease);
}

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
    // ÖLÇÜLDÜ (Y4 koşumu, 7 geçişin 4'ü 258–263 ms): yumruk yapılırken
    // başparmak+işaret bir kare yaklaşıyor → tık FSM'i ARMED'e geçiyor → arm
    // çözülünce `_endGesture` 200 ms cool-off kuruyor → ZOOM girişi tam
    // cool-off bitene kadar bekliyor. Kullanıcı tıklamak İSTEMEDİ; poz zaten
    // "zoom" diyor. Kaza-arm SESSİZCE iptal edilir (tık YOK, cool-off YOK).
    // Sürükleme sırasında poz değişirse buton MUTLAKA bırakılır — asılı
    // mouse-down en kötü arıza sınıfı (R1 §5.3).
    if (cfg.zoomEnabled && this._zoomChannel) {
      if (this.state === DRAG || this._pressed) {
        const [rx, ry] = this._releasePos();
        acts.push(action('left_up', rx, ry, { clicks: this._pressClicks, reason: 'zoom_pose' }));
        this.state = MOVE;
        this._endGesture(f.t);
      } else if (this.state === ARMED) {
        // İptal edilen jest BLOKLANIR. Yoksa: parmaklar kapalı + arka parmaklar
        // kıvrık iken (yumruk) her kare kolla→iptal et döngüsüne giriliyor ve
        // kare başına bir `anchor` üretiliyordu — imleç ardarda çapaya
        // ışınlanırdı (ölçüldü: 8 karede 8 anchor). ZOOM girişi de `pinching`
        // yüzünden açılamadığı için döngü kendiliğinden kırılmıyordu.
        // Blok, parmaklar `release` eşiğinin üstüne AÇILINCA kalkar.
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
      // ÇIKIŞ = daha UZAK eşik VE ardışık kareler (tek karelik gürültü nesneyi
      // ortada bırakmasın — "blık blık" salınımının ilacı).
      // A4: çıta hıza göre (yavaşta 0.42, hızlıda 0.70) — sahte fırlatma kesilir.
      if (di > this._dragReleaseNow()) this._dragRelFrames += 1;
      else this._dragRelFrames = 0;
      if (this._dragRelFrames >= cfg.dragReleaseFrames) {
        this._dragRelFrames = 0;
        // "Snap": el aslında gitmediyse butonu ÇAPADA bırak → OS temiz tık görür.
        // Ölçüm KAPANMA anından (çapadan değil): çapa↔kapanma arası 51-63 px
        // yaklaşma yolu "sürüklenmiş" sayılmasın (HND-B1'in kök nedeni).
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
    // Cool-off BİLEREK sorulmuyor: o pencere ardışık TIK jestlerini seyreltmek
    // içindir; poz değişimi açık bir kullanıcı niyetidir ve ZOOM'da tık kanalı
    // zaten bloklu. (Y4 kök nedeni — ölçüm rapordadır.)
    if (cfg.zoomEnabled && this._zoomFrames >= cfg.zoomFrames && !pinching) {
      this.state = ZOOM;
      this._killMomentum(); // yeni jest akan momentumu keser
      this._zoomRef = Math.max(di, 1e-6);
      this._zoomBase = 1.0;
      this._zoomScale = 1.0;
      this._zoomAnchor = [f.x, f.y];
      this._zoomEdgeDir = 0;
      this._zoomEdgeSince = null;
      this._zoomEdgeExtreme = 0.0;
      this._zoomRelFrames = 0;
      this._zoomF.reset();
      // Tık kanalı BLOKLU: çıkışta `release` eşiği aşılmadan tık üretilemez.
      this._blocked.add('left');
      this._blocked.add('right');
      acts.push(action('zoom', f.x, f.y, { reason: 'start', scale: 1.0, delta: 1.0 }));
      return acts;
    }

    // ---- MOVE / IDLE: jest tetikleyicileri ----------------------------
    if (this._blocked.has('left') && di > cfg.release) this._blocked.delete('left');
    if (this._blocked.has('right') && dm > cfg.rightRelease) this._blocked.delete('right');

    // Hangi buton? Eşiğine ORANLA yakın olan kazanır (başparmak ortaya giderken
    // işaretin yanından geçer; oran kıyası olmasa sağ jest önce solu tetiklerdi).
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

  // ------------------------------------------------------------- parçalar
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
  }

  // ---------------------------------------------------------- zoom (G1)
  /** ZOOM biterken tek "end" aksiyonu — overlay halkasını kapatır; imleç
   *  kanalı serbest kalır. `delta` 1: OS'a tekerlek gitmez. */
  _zoomEnd(t) {
    this._zoomEdgeDir = 0;
    this._zoomEdgeSince = null;
    return action('zoom', this._zoomAnchor[0], this._zoomAnchor[1], {
      reason: 'end', scale: this._zoomScale, delta: 1.0,
    });
  }

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
  }

  // -------------------------------------------------------- scroll (F3)
  /** Elin HAM konumunu el-boyu birimine çevirir. null = ölçülemez. */
  _scrollUnits(f) {
    if (f.rawX === null || f.rawX === undefined || f.rawY === null || f.rawY === undefined) return null;
    const s = f.scale || 0.0;
    if (s < this.cfg.scrollMinScale) return null;
    return [f.rawX / s, f.rawY / s];
  }

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
  }

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
  }

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
  }

  // ------------------------------------------------------------ momentum
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
  }

  _killMomentum() {
    this._momVx = this._momVy = 0.0;
  }

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
  }

  // ------------------------------------------------------------- 🤙 mandal
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
  }

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
  }

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
  }

  /** Butonu NEREDE bırakmalı: askıdaki basış çapada yapıldı ve hiç hareket
   *  gitmedi → bırakış da çapaya; sürüklemede imleç zaten serbest. */
  _releasePos() {
    return this._pressed && this.state !== DRAG ? this._anchor : this._lastPos;
  }

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
  }

  _fireLeft(t, pos, reason = '') {
    if (t - this._lastLeft < this.cfg.leftCooldownS) return [];
    const clicks = this._noteClick(t, pos);
    this._lastLeft = t;
    this.state = CLICK;
    return [action('left_click', pos[0], pos[1], { clicks, reason })];
  }

  _fireRight(t, pos) {
    if (t - this._lastRight < this.cfg.rightCooldownS) return [];
    this._lastRight = t;
    this.state = CLICK;
    return [action('right_click', pos[0], pos[1])];
  }
}

function action(kind, x = 0.0, y = 0.0, { direction = '', clicks = 1, reason = '', dx = 0.0, dy = 0.0, scale = 0.0, delta = 0.0 } = {}) {
  // `scale`/`delta` yalnız kind='zoom' için anlamlı (HAND-G1); diğer aksiyonlarda
  // 0 kalır — parite testi kind/x/y/direction/clicks/reason'a bakar, şekil bozulmaz.
  return { kind, x, y, direction, clicks, reason, dx, dy, scale, delta };
}

module.exports = {
  ClickFSM,
  defaultConfig,
  action,
  IDLE, MOVE, ARMED, CLICK, DRAG, SCROLL, ZOOM, PARK,
};
