// electron/handControlCore.cjs — HAND-A2: El kontrolü ÇEKİRDEĞİ (saf, DI'lı).
// D mimarisi: gizli BrowserWindow'daki MediaPipe döngüsü 21 landmark'ı buraya
// (main) iter; ekrana eşleme + 1€/balistik filtre + tıklama FSM'i + imleç
// olayı + overlay beslemesi BURADA birleşir. Kamera karesi bu katmana ASLA
// gelmez — yalnız sayılar (landmark x,y), OTOPILOT §5 / R1 §5.4 gizlilik sınırı.
//
// jarvis hand_control.py'nin _process_hand + _update_cursor akışının portu;
// eşik/margin varsayılanları jarvis config.py ile birebir (parite).

'use strict';

const { PointerPipeline, BallisticGain } = require('./handPointerFilter.cjs');
const { HandScaleEstimator, LANDMARK } = require('./handScale.cjs');
const { ClickFSM, ARMED, DRAG } = require('./handClickFsm.cjs');
const { TwoHandZoom } = require('./handTwoHandZoom.cjs');

const L = LANDMARK;

/** jarvis config.py varsayılanları — tek yerde (Q: ayar ekranı HAND-A3'ün işi). */
function defaultTuning() {
  return {
    marginX: 0.18, // yatay aktif bölge 0.18→0.82
    marginY: 0.28, // dikey dar: el bel hizasına inmesin
    mirror: true, // kamera aynalı kullanım (jarvis cv2.flip paritesi)
    scaleNormalize: true,
    clickDistScaled: 0.14,
    releaseDistScaled: 0.28,
    scaleMin: 0.05,
    oneEuro: { minCutoff: 0.3, beta: 0.002, dCutoff: 1.0 },
    gain: { gMin: 0.10, gMax: 1.6, vRef: 250.0, power: 2.0 },
    maxOffsetPx: 140.0,
    speedWindowS: 0.15,
  };
}

/** Landmark dizisinden parmak durumu (jarvis _finger_state paritesi).
 *  landmarks: [{x,y}×21], görüntüye normalize; y=0 üstte. */
function fingerState(lm) {
  const up = (tip, pip) => lm[tip].y < lm[pip].y;
  const d = (a, b) => Math.hypot(lm[a].x - lm[b].x, lm[a].y - lm[b].y);
  // HAND-G1 / tasarım §4.1 — PARMAK KAVİS ORANI: fN = |tip−bilek| / |mcp−bilek|.
  // `up` bayrakları y ekseninde ölçtüğü için el yatınca çöker; kavis oranı
  // bileğe göre ÖLÇEKSİZ ve dönmeye dayanıklı — zoom/tık kanal ayrımının
  // taşıyıcısı bu. Payda 0'a inemez (mcp bileğin üstünde), yine de korunur.
  const arch = (tip, mcp) => d(tip, L.WRIST) / Math.max(d(mcp, L.WRIST), 1e-9);
  return {
    indexUp: up(L.INDEX_TIP, L.INDEX_PIP),
    middleUp: up(L.MIDDLE_TIP, L.MIDDLE_PIP),
    ringUp: up(L.RING_TIP, L.RING_PIP),
    pinkyUp: up(L.PINKY_TIP, L.PINKY_PIP),
    thumbIndexDist: d(L.THUMB_TIP, L.INDEX_TIP),
    thumbMiddleDist: d(L.THUMB_TIP, L.MIDDLE_TIP),
    thumbPinkyDist: d(L.THUMB_TIP, L.PINKY_TIP),
    // Arka ÜÇ parmağın ortalaması: tek parmağın gürültüsü kanalı çeviremesin.
    // Kanyon (890 gerçek kare): KAPALI medyan 0,719 · AÇIK medyan 1,793.
    backMean: (arch(L.MIDDLE_TIP, L.MIDDLE_MCP) + arch(L.RING_TIP, L.RING_MCP) + arch(L.PINKY_TIP, L.PINKY_MCP)) / 3,
    indexArch: arch(L.INDEX_TIP, L.INDEX_MCP),
  };
}

/** İmleç çapası: rigid_palm — WRIST+INDEX_MCP+PINKY_MCP ortalaması (parmak
 *  kıvrılırken neredeyse kıpırdamaz → pinch'te çapa kayması %15-26 az). */
function cursorPoint(lm) {
  return [
    (lm[L.WRIST].x + lm[L.INDEX_MCP].x + lm[L.PINKY_MCP].x) / 3.0,
    (lm[L.WRIST].y + lm[L.INDEX_MCP].y + lm[L.PINKY_MCP].y) / 3.0,
  ];
}

/** HAND-G7 / tasarım §2.3-A2 — AKIL SAĞLIĞI SINIRI (hayalet el kalkanı).
 *  aspect = avuç UZUNLUĞU (WRIST→MIDDLE_MCP) / avuç GENİŞLİĞİ (INDEX_MCP→
 *  PINKY_MCP). MediaPipe kalabalık arka planda el-olmayan bir şeyi el sanınca
 *  ürettiği iskelet İMKÂNSIZ orandadır; gerçek el pozlarının hiçbiri bu değeri
 *  aşmıyor (bizim spike ölçümümüz 1,32–2,54; barehands'in iki günlük korpusu
 *  1,5–5,5). Eşik 6 = ölçülen tavanın üstünde ilk güvenli sayı — TEORİDEN
 *  oynatılmaz, tutmazsa tasarım §7 kanyon protokolüyle yeniden fit edilir. */
const ASPECT_SANE_MAX = 6.0;

/** @returns {number} aspect; avuç genişliği dejenere (0) ise Infinity — sıfıra
 *  bölme yerine "imkânsız" hükmü (dejenere iskelet zaten hayalettir). */
function handAspect(lm) {
  const span = Math.hypot(lm[L.WRIST].x - lm[L.MIDDLE_MCP].x, lm[L.WRIST].y - lm[L.MIDDLE_MCP].y);
  const palmW = Math.hypot(lm[L.INDEX_MCP].x - lm[L.PINKY_MCP].x, lm[L.INDEX_MCP].y - lm[L.PINKY_MCP].y);
  if (!(palmW > 0)) return Infinity;
  return span / palmW;
}

/**
 * El kontrol motoru — kare girer, {applied, overlayEvents, moved} çıkar.
 * `cursor`: HandCursor arayüzü (apply/releaseAll) — testte sahte verilir.
 * `target`: {x,y,width,height} DIP ekran dikdörtgeni (main `screen`den verir).
 */
class HandControlEngine {
  constructor({ cursor, target, tuning = null, fsmConfig = null, twoHandConfig = null, now = null } = {}) {
    this.cursor = cursor;
    this.target = target || { x: 0, y: 0, width: 1440, height: 900 };
    this.tuning = { ...defaultTuning(), ...(tuning || {}) };
    const t = this.tuning;
    this.scaleEst = new HandScaleEstimator();
    this.pipe = new PointerPipeline({
      mode: 'oneeuro',
      minCutoff: t.oneEuro.minCutoff,
      beta: t.oneEuro.beta,
      dCutoff: t.oneEuro.dCutoff,
      gain: new BallisticGain(t.gain.gMin, t.gain.gMax, t.gain.vRef, t.gain.power),
      maxOffsetPx: t.maxOffsetPx,
      speedWindowS: t.speedWindowS,
    });
    // TEK-EL zoom VARSAYILAN KAPALI (Eren kararı 05.09: "zoom iki elle").
    // Ölçüldü (Z1): yumruk pozu iki-el jestiyle aynı el şeklini kullandığı için
    // tek-el kanalı da açılıyor ve jest KAPALIYKEN 634 zoom aksiyonu sızıyordu.
    // Yetenek SİLİNMEDİ — ayardan (`zoom.oneHand`) açılabilir.
    this.fsm = new ClickFSM({ zoomEnabled: false, ...(fsmConfig || {}) });
    // HAND-G1 (Eren düzeltmesi 05.09) — ZOOM İKİ ELLE yapılır: iki el de
    // "tutma" pozundayken (başparmak+işaret kapalı) eller birbirinden
    // uzaklaşınca büyüt, yaklaşınca küçült. Ayrı modül: ClickFSM jarvis
    // paritesiyle kilitli ve tek el görüyor.
    this.twoHand = new TwoHandZoom(twoHandConfig || {});
    this._now = now || (() => Date.now() / 1000);
    // Sağlık/telemetri
    this.frames = 0;
    this.handFrames = 0;
    // HAND-G7 — akıl sağlığı sınırından DÖNEN kare sayısı. "El kontrolü tuhaf
    // davranıyor" şikâyetinde ilk bakılacak sayı: yüksekse izleyici hayalet
    // üretiyor (ışık/arka plan), düşükse arıza başka yerde.
    this.garbageFrames = 0;
    this.lastAspect = null;
    this.lastFrameT = null;
    this.lastState = 'IDLE';
    this._fpsWin = [];
    // HAND-BUG-03 — kenar vuruşu nöbeti (handDisplayRouter) İMLECİN son
    // konumunu ister: kullanıcı kenarı GÖRDÜĞÜ imleçle vurur, ham eşlemeyle
    // değil (filtre/hassas mod ikisini ayırır).
    this.lastCursor = null; // [x, y] DIP — el varken son sürülen nokta
    this.handPresent = false;
  }

  /** HAND-BUG-03 — hedef ekran ARTIK DEĞİŞEBİLİR (kenar geçişi / gerçek fare /
   *  ekran takımı değişimi). Hedef GERÇEKTEN değiştiyse imleç boru hattı
   *  SIFIRLANIR: 1€ filtresi + balistik kazanç bir önceki ekranın koordinatını
   *  taşıyor olurdu ve imleç iki ekran arasında bir kare boyunca "sünerdi"
   *  (maxOffsetPx=140 sınırı ekranlar arası 2000+ px sıçramayı zaten
   *  karşılayamaz). @returns {boolean} hedef değişti mi */
  setTarget(target) {
    if (!target || !Number.isFinite(target.width)) return false;
    const t = this.target;
    const same = t && t.x === target.x && t.y === target.y
      && t.width === target.width && t.height === target.height;
    this.target = { x: target.x, y: target.y, width: target.width, height: target.height };
    if (same) return false;
    this.pipe.reset();
    return true;
  }

  get fps() {
    if (this._fpsWin.length < 2) return 0;
    const span = this._fpsWin[this._fpsWin.length - 1] - this._fpsWin[0];
    return span > 0 ? Math.round(((this._fpsWin.length - 1) / span) * 10) / 10 : 0;
  }

  /** Görüntü-normalize mesafeyi FSM'in EL BOYU birimine çevir (jarvis _fsm_dist). */
  _fsmDist(raw, scale) {
    const t = this.tuning;
    if (!t.scaleNormalize) return raw;
    if (!scale || scale < t.scaleMin) {
      // Ölçek güvenilmez: sabit oranla ölçekle — FSM tek birimde kalır.
      return raw * (t.clickDistScaled / Math.max(0.04, 1e-9)); // HAND_CLICK_DIST=0.04 (jarvis)
    }
    return raw / scale;
  }

  /**
   * HAND-BUG-03 — İMLEÇ HEDEF EKRANIN DIŞINA ÇIKAMAZ.
   *
   * `mapToScreen` zaten kelepçeliyor, AMA balistik kazanç imleci ham noktadan
   * `maxOffsetPx` (140) kadar ötelemekte serbest. Tek ekranda bu görünmezdi:
   * OS taşan noktayı ekrana kırpıyordu. İKİ ekranda taşma KOMŞU EKRANA düşer —
   * ÖLÇÜLDÜ: laptop'un üst kenarında imleç y=-131,7'ye gidiyor ve bu, üstteki
   * harici monitörün alt şeridinin TAM İÇİ. Yani jest olmadan imleç öbür ekrana
   * sızıp geri dönerdi. Eşleme "el → BİR ekran" olduğu için çıktı da o ekranda
   * kalmalı; ekran değişimi YALNIZ hedef değişince olur (kenar vuruşu / gerçek
   * fare / pencere taşınması).
   */
  clampToTarget(x, y) {
    const t = this.target;
    return [
      Math.max(t.x, Math.min(t.x + t.width - 1, x)),
      Math.max(t.y, Math.min(t.y + t.height - 1, y)),
    ];
  }

  /** Normalize el konumu → hedef ekranda global DIP piksel (margin + ayna). */
  mapToScreen(nx, ny) {
    const t = this.tuning;
    const hx = t.mirror ? 1.0 - nx : nx;
    const rx = (hx - t.marginX) / (1.0 - 2.0 * t.marginX);
    const ry = (ny - t.marginY) / (1.0 - 2.0 * t.marginY);
    const cx = Math.max(0.0, Math.min(1.0, rx));
    const cy = Math.max(0.0, Math.min(1.0, ry));
    return [this.target.x + cx * this.target.width, this.target.y + cy * this.target.height];
  }

  /**
   * Bir tespit karesi işle.
   * @param {object} p { t?, hand, landmarks? } — landmarks: [{x,y}×21]
   * @returns {{applied:number, overlayEvents:object[], state:string}}
   */
  onFrame(p) {
    const t = Number.isFinite(p.t) ? p.t : this._now();
    this.frames += 1;
    this.lastFrameT = t;
    this._fpsWin.push(t);
    while (this._fpsWin.length && t - this._fpsWin[0] > 2.0) this._fpsWin.shift();

    // ---- HAND-G1: İKİ ELLE ZOOM, tek-el kanallarından ÖNCE ----------------
    // `hands` yeni alan (numHands:2); eski `landmarks` tek-el yolu bozulmaz.
    const hands = Array.isArray(p.hands) && p.hands.length
      ? p.hands
      : (Array.isArray(p.landmarks) ? [p.landmarks] : []);
    const two = this.twoHand.update({ t, hands: p.hand === false ? [] : hands });
    if (two.actions.length || this.twoHand.active) {
      // Jest ETKİNKEN tek-el kanalları susar: FSM'e "el yok" verilir — basılı
      // buton varsa BIRAKILIR (asılı mouse-down en kötü arıza sınıfı) ve
      // imleç/tık üretilmez. Eller görünür ama TUTMUYORSA buraya girilmez,
      // yani imleç normal çalışmaya devam eder.
      const quiet = this.fsm.update({ t, hand: false });
      let applied2 = 0;
      let overlay2 = [];
      for (const act of quiet) {
        if (this.cursor && this.cursor.apply(act)) applied2 += 1;
      }
      for (const a of two.actions) {
        const [zx, zy] = this.clampToTarget(...this.mapToScreen(a.nx, a.ny));
        const act = { kind: 'zoom', x: zx, y: zy, scale: a.scale, delta: a.delta, reason: a.reason, direction: '', clicks: 1, dx: 0, dy: 0 };
        if (this.cursor && this.cursor.apply(act)) applied2 += 1;
        overlay2.push({ type: 'zoom', t: t * 1000, x: zx, y: zy, scale: a.scale, phase: a.reason });
      }
      this.handPresent = hands.length > 0;
      this.lastState = 'ZOOM2';
      return { applied: applied2, overlayEvents: overlay2, state: 'ZOOM2', actions: two.actions };
    }

    let frame;
    let overlay = [];
    // HAND-G7 — hayalet el kalkanı: iskelet GEÇERLİ görünse bile geometrisi
    // imkânsızsa kare EL YOK sayılır (aşağıdaki hand:false yolu; FSM'in
    // lostGraceS mekanizması gerisini zaten hallediyor).
    // Tek-el yolu: `landmarks` yoksa `hands[0]` kullanılır (numHands:2 akışı).
    const lm0 = Array.isArray(p.landmarks) && p.landmarks.length >= 21 ? p.landmarks : (hands[0] || null);
    const lmOk = Boolean(p.hand) && Array.isArray(lm0) && lm0.length >= 21;
    let insane = false;
    if (lmOk) {
      const aspect = handAspect(lm0);
      this.lastAspect = Number.isFinite(aspect) ? Math.round(aspect * 100) / 100 : null;
      if (!(aspect <= ASPECT_SANE_MAX)) { // NaN de reddedilir
        insane = true;
        this.garbageFrames += 1;
      }
    }
    if (!lmOk || insane) {
      frame = { t, hand: false, x: 0, y: 0 };
      if (this.lastState !== 'IDLE') overlay.push({ type: 'hand', t: t * 1000, present: false });
    } else {
      this.handFrames += 1;
      const lm = lm0;
      const st = fingerState(lm);
      // Payda: buton basılıyken tabanlı (HND-B3 hold_floor).
      const hold = this.fsm.state === ARMED || this.fsm.state === DRAG;
      const scale = this.scaleEst.update(lm, t, hold);
      const [rawX, rawY] = cursorPoint(lm);
      const [sx, sy] = this.mapToScreen(rawX, rawY);
      // Hassas mod kazancı boru hattına eşlemeden ÖNCE (bir kare gecikirse
      // kip açıldığı anda imleç sıçrar — jarvis notu).
      this.pipe.precision = this.fsm.precision ? this.fsm.cfg.precisionGain : 1.0;
      const [cx, cy] = this.clampToTarget(...this.pipe.update(sx, sy, t));
      frame = {
        t,
        hand: true,
        x: cx,
        y: cy,
        pinchIndex: this._fsmDist(st.thumbIndexDist, scale),
        pinchMiddle: this._fsmDist(st.thumbMiddleDist, scale),
        park: false, // HND-B2: poz-tabanlı PARK yok; parkEnabled zaten kapalı
        twoFingers: st.indexUp && st.middleUp && !st.ringUp && !st.pinkyUp,
        scale,
        pinky: this._fsmDist(st.thumbPinkyDist, scale),
        // HAND-G1 — zoom/tık kanal kapısı. ÖLÇEKSİZ oran: `_fsmDist`ten
        // GEÇMEZ (el boyuna bölmek anlamsız, zaten oran).
        backMean: st.backMean,
        indexArch: st.indexArch,
        rawX,
        rawY,
      };
    }

    // Son kare — HUD/teşhis okur (kamera verisi DEĞİL, yalnız türetilmiş sayılar).
    this.lastFrameDbg = frame;
    this.handPresent = frame.hand === true;
    if (frame.hand) this.lastCursor = [frame.x, frame.y];

    const precisionBefore = this.fsm.precision;
    const actions = this.fsm.update(frame);
    this.lastState = this.fsm.state;

    let applied = 0;
    for (const act of actions) {
      // İmleç DONUKKEN (ARMED/PARK) FSM zaten move üretmez; buradaki her
      // aksiyon OS'a gitmelidir. Uygulanamayanlar sayılır (sağlık).
      if (this.cursor && this.cursor.apply(act)) applied += 1;
      overlay = overlay.concat(this._toOverlay(act, frame, t));
    }
    if (frame.hand && this.fsm.precision !== precisionBefore) {
      overlay.push({ type: 'precision', t: t * 1000, on: this.fsm.precision, x: frame.x, y: frame.y });
    }
    if (frame.hand && this.frames > 0 && this.handFrames === 1) {
      overlay.push({ type: 'hand', t: t * 1000, present: true, x: frame.x, y: frame.y });
    }
    return { applied, overlayEvents: overlay, state: this.fsm.state, actions };
  }

  /** FSM aksiyonu → HAND-A1 overlay sözleşme olay(lar)ı. */
  _toOverlay(act, frame, t) {
    const ms = t * 1000;
    switch (act.kind) {
      case 'move':
        if (act.reason === 'drag' || act.reason === 'drag_commit') {
          return [{ type: 'drag', t: ms, phase: act.reason === 'drag_commit' ? 'start' : 'move', x: act.x, y: act.y, ax: this.fsm._anchor[0], ay: this.fsm._anchor[1] }];
        }
        return [{ type: 'move', t: ms, x: act.x, y: act.y, speed: this.pipe.lastSpeed }];
      case 'anchor':
        return [{ type: 'armed', t: ms, x: act.x, y: act.y, pressed: false }];
      case 'left_down':
        return [{ type: 'drag', t: ms, phase: 'hold', x: act.x, y: act.y, ax: act.x, ay: act.y }];
      case 'left_up':
        if (act.reason === 'hold_click' || act.reason === 'snap') {
          return [{ type: 'click', t: ms, x: act.x, y: act.y, button: 'left', clicks: act.clicks }];
        }
        return [{ type: 'drag', t: ms, phase: 'end', x: act.x, y: act.y }];
      case 'left_click':
        return [{ type: 'click', t: ms, x: act.x, y: act.y, button: 'left', clicks: act.clicks }];
      case 'right_click':
        return [{ type: 'click', t: ms, x: act.x, y: act.y, button: 'right', clicks: 1 }];
      case 'zoom':
        // HAND-G1 — imleç ZOOM'da donuk; halka jestin BAŞLADIĞI noktada durur
        // (aksiyon zaten o çapayı taşıyor).
        return [{ type: 'zoom', t: ms, x: act.x, y: act.y, scale: act.scale, phase: act.reason || 'move' }];
      case 'scroll': {
        const pos = this.pipe.position ? this.clampToTarget(...this.pipe.position) : [frame.x, frame.y];
        return [{
          type: 'scroll',
          t: ms,
          x: pos[0],
          y: pos[1],
          dir: act.direction || 'down',
          speed: Math.abs(act.dy || act.dx || 0),
          flick: act.reason === 'momentum',
        }];
      }
      default:
        return [];
    }
  }

  /** Acil durdurma / stop: basılı butonu bırak, filtre durumunu sıfırla. */
  halt() {
    this.twoHand.reset();
    if (this.cursor) this.cursor.releaseAll();
    this.pipe.reset();
    this.scaleEst.reset();
    this.lastCursor = null;
    this.handPresent = false;
  }
}

module.exports = { HandControlEngine, defaultTuning, fingerState, cursorPoint, handAspect, ASPECT_SANE_MAX };
