// AXP-04 — IŞIK GEOMETRİSİ (saf; Electron yok, IO yok).
// Tasarım: docs/design/AXP-01-DESIGN.md §5 · kapı: docs/agent-results/AXP-04-evidence/beam-geometry-check.mjs
//
// NEDEN VAR: Işık Agent X'in GERÇEK ekran konumundan kalkar (Eren 18.09). Agent X dört
// yerde olabilir (widget ana pencerede · pop-out ana pencerenin üstünde · pop-out ana
// pencerenin dışında aynı ekranda · pop-out başka ekranda); dördü de aynı ana-pencere
// CSS px koordinatına çevrilir ki renderer overlay'i tek yoldan çizsin.
//
// SÖZLEŞME (Electron): BrowserWindow.getContentBounds() ve screen.getDisplayMatching()
// her platformda DIP döner. Renderer CSS px ↔ DIP: DIP = css × zoomFactor. DPR ÇARPAN
// DEĞİLDİR (agimen AX-24 ile aynı kabul; AXP-00 fixture 6-7 birebir çapraz doğrulandı).
//
// AXP-00'daki `beam-geometry-check.mjs` bu fonksiyonların İLK kopyasıydı; ürün modülü
// budur, kapı artık BUNU koşturur ([[gate-must-run-the-shipped-artifact]]).

'use strict';

/** Bir ekran-DIP noktasını ana pencerenin CSS px'ine çevir. */
function screenToMainCss(pt, mainContent, mainZoom = 1) {
  return { x: (pt.x - mainContent.x) / mainZoom, y: (pt.y - mainContent.y) / mainZoom };
}

/** Bir pencerenin CSS px dikdörtgen merkezini ekran-DIP'e çevir. */
function cssRectCenterToScreen(rect, winContent, zoom = 1) {
  return { x: winContent.x + (rect.x + rect.width / 2) * zoom, y: winContent.y + (rect.y + rect.height / 2) * zoom };
}

/** Noktayı dikdörtgenin (CSS px) kenarına kelepçele — pencere dışındaki kaynak için "yön" korunur. */
function clampToRectEdge(pt, w, h, inset = 8) {
  return { x: Math.min(Math.max(pt.x, inset), w - inset), y: Math.min(Math.max(pt.y, inset), h - inset) };
}

const rectOK = (r) => !!r && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(r[k])) && r.width > 0 && r.height > 0;

/**
 * Kaynak nokta kararı (AXP-01-DESIGN §5.1 — dört kip).
 * @param {object} p
 * @param {{x,y,width,height}} p.mainContent   ana pencere içerik alanı (DIP, ekran koordinatı)
 * @param {number} [p.mainZoom]                 ana pencere webContents.getZoomFactor()
 * @param {{x,y,width,height}|null} p.popoutContent  Agent X pop-out penceresi (yoksa null → widget ana penceredeki DOM'da)
 * @param {number} [p.popoutZoom]
 * @param {{x,y,width,height}} p.orbCss        orb dikdörtgeni, KENDİ penceresinin CSS px'inde
 * @param {(b:object)=>string} p.displayIdOf   screen.getDisplayMatching(bounds).id sarmalayıcısı
 * @returns {{mode:'dom'|'popout-inside'|'popout-outside'|'popout-other-display', origin:{x,y}, drawOrigin:{x,y}, overlay:null|{x,y,width,height}}}
 *   origin     = gerçek kaynak, ana pencere CSS px'inde (pencere dışında / negatif olabilir)
 *   drawOrigin = ana pencere DOM katmanının çizime başlayacağı nokta (dışarıdaysa kenara kelepçeli)
 *   overlay    = pencere DIŞINDA kalan parça için saydam, tıklama-geçirgen masaüstü katmanının
 *                ekran-DIP sınırları (yalnız aynı ekranda; başka ekranda null)
 */
function beamSource(p) {
  const { mainContent, mainZoom = 1, popoutContent, popoutZoom = 1, orbCss, displayIdOf } = p;
  const W = mainContent.width / mainZoom;
  const H = mainContent.height / mainZoom;
  if (!popoutContent) {
    const origin = { x: orbCss.x + orbCss.width / 2, y: orbCss.y + orbCss.height / 2 };
    return { mode: 'dom', origin, drawOrigin: origin, overlay: null };
  }
  const screenPt = cssRectCenterToScreen(orbCss, popoutContent, popoutZoom);
  const origin = screenToMainCss(screenPt, mainContent, mainZoom);
  const inside = origin.x >= 0 && origin.y >= 0 && origin.x <= W && origin.y <= H;
  if (inside) return { mode: 'popout-inside', origin, drawOrigin: origin, overlay: null };
  const drawOrigin = clampToRectEdge(origin, W, H);
  const sameDisplay = displayIdOf(popoutContent) === displayIdOf(mainContent);
  if (!sameDisplay) return { mode: 'popout-other-display', origin, drawOrigin, overlay: null };
  // Dış parça: kaynak noktası ile ana pencere kenar noktasını kapsayan kutu (+24 DIP pay).
  const edgeScreen = { x: mainContent.x + drawOrigin.x * mainZoom, y: mainContent.y + drawOrigin.y * mainZoom };
  const overlay = {
    x: Math.floor(Math.min(screenPt.x, edgeScreen.x) - 24),
    y: Math.floor(Math.min(screenPt.y, edgeScreen.y) - 24),
    width: Math.ceil(Math.abs(screenPt.x - edgeScreen.x) + 48),
    height: Math.ceil(Math.abs(screenPt.y - edgeScreen.y) + 48),
  };
  return { mode: 'popout-outside', origin, drawOrigin, overlay };
}

/**
 * Kavisli yol: kuadratik Bézier, kontrol noktası yolun ortasında ve yukarıda ("taş
 * fırlatma": hızlı yükselir, hedefe düşer). `lift` yol uzunluğunun oranı; taban 48 px.
 */
function arcPath(from, to, lift = 0.35, opts = {}) {
  const mx = (from.x + to.x) / 2;
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  // Tepe iki ucun da ÜSTÜNDE olsun (uçlar farklı yükseklikteyken ortalamadan kaldırmak
  // tepeyi yüksekteki ucun altında bırakıyordu → "fırlatma" hissi kayboluyordu).
  let cy = Math.min(from.y, to.y) - Math.max(48, d * lift);
  // Tepe pencerenin ÜSTÜNDEN taşmasın (ölçüldü: 1050 px'lik atışta tepe −250 px'e çıkıyor,
  // taş ekranın dışında uçuyordu). Tepe (t=0.5) = (from.y + 2·c.y + to.y)/4 ≥ minApexY.
  if (Number.isFinite(opts.minApexY)) {
    const cMin = 2 * opts.minApexY - (from.y + to.y) / 2;
    if (cy < cMin) cy = Math.min(cMin, Math.min(from.y, to.y) - 12);
  }
  const c = { x: mx, y: cy };
  return { d: `M ${from.x} ${from.y} Q ${c.x} ${c.y} ${to.x} ${to.y}`, control: c, length: d };
}

/** Kuadratik Bézier üstünde t∈[0,1] noktası. */
function arcPoint(from, control, to, t) {
  const u = 1 - t;
  return {
    x: u * u * from.x + 2 * u * t * control.x + t * t * to.x,
    y: u * u * from.y + 2 * u * t * control.y + t * t * to.y,
  };
}

/** "Taş fırlatma" zamanlaması: ilk %40 yavaş kalkış, sonra düşüş (ease-in-out). */
function easeThrow(t) {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}

/**
 * Uçuş süresi (ms): mesafeye göre 600–900 ms; reduced-motion 140 ms (yol çizilmez,
 * yalnız halka solar — AXP-01-DESIGN §5.3).
 */
function flightDuration(distancePx, reducedMotion = false) {
  if (reducedMotion) return 140;
  const d = Number.isFinite(distancePx) ? Math.max(0, distancePx) : 0;
  return Math.round(Math.min(900, Math.max(600, 600 + d * 0.25)));
}

/**
 * Yolun ana pencere DIŞINDAN İÇİNE girdiği t (kaynak dışarıdaysa). Yol içerde başlıyorsa 0.
 * Masaüstü katmanı [0, t*] parçasını, ana overlay [t*, 1] parçasını çizer.
 * @param {{x,y}} from  gerçek kaynak (CSS px, pencere dışında olabilir)
 * @param {{x,y}} control
 * @param {{x,y}} to
 * @param {{width:number,height:number}} win  ana pencere CSS ölçüsü
 */
function splitAtRect(from, control, to, win, steps = 200) {
  const inside = (pt) => pt.x >= 0 && pt.y >= 0 && pt.x <= win.width && pt.y <= win.height;
  if (inside(from)) return 0;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (inside(arcPoint(from, control, to, t))) return t;
  }
  return 1;
}

/** Yol uzunluğu (örnekleyerek) — SMIL keyPoints kesri için. */
function arcLength(from, control, to, steps = 64) {
  let len = 0;
  let prev = from;
  for (let i = 1; i <= steps; i++) {
    const pt = arcPoint(from, control, to, i / steps);
    len += Math.hypot(pt.x - prev.x, pt.y - prev.y);
    prev = pt;
  }
  return len;
}

/** t (parametre) → yol-uzunluğu kesri (SMIL animateMotion keyPoints bunu ister). */
function lengthFractionAt(from, control, to, t, steps = 128) {
  let total = 0;
  let upto = 0;
  let prev = from;
  for (let i = 1; i <= steps; i++) {
    const ti = i / steps;
    const pt = arcPoint(from, control, to, ti);
    const seg = Math.hypot(pt.x - prev.x, pt.y - prev.y);
    total += seg;
    if (ti <= t + 1e-9) upto += seg;
    prev = pt;
  }
  return total === 0 ? 0 : Math.min(1, upto / total);
}

/**
 * Masaüstü katmanı için ekran-DIP geometrisi: aynı yol (ana CSS) → overlay-yerel DIP.
 * @returns {{from,control,to, tSplit, keyPointEnd}|null}
 */
function desktopSegment({ from, control, to, mainContent, mainZoom = 1, overlay, win }) {
  if (!rectOK(overlay)) return null;
  const toLocal = (pt) => ({ x: mainContent.x + pt.x * mainZoom - overlay.x, y: mainContent.y + pt.y * mainZoom - overlay.y });
  const tSplit = splitAtRect(from, control, to, win);
  return {
    from: toLocal(from),
    control: toLocal(control),
    to: toLocal(to),
    tSplit,
    keyPointEnd: lengthFractionAt(from, control, to, tSplit),
  };
}

module.exports = {
  screenToMainCss,
  cssRectCenterToScreen,
  clampToRectEdge,
  beamSource,
  arcPath,
  arcPoint,
  easeThrow,
  flightDuration,
  splitAtRect,
  arcLength,
  lengthFractionAt,
  desktopSegment,
  rectOK,
};
