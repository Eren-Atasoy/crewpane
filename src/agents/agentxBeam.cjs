// AXP-04 — IŞIĞIN ANA SÜREÇ UCU: kaynak ölçümü (pop-out kipleri) + MASAÜSTÜ KATMANI.
// Tasarım: docs/design/AXP-01-DESIGN.md §5.1 (dört kip), §9 (platform).
//
// NE YAPAR
//   • `source({orbCss})`: Agent X pop-out penceresi açıksa ışığın kaynağı o pencerenin
//     GERÇEK ekran konumudur → pop-out renderer'ından gösterge dikdörtgeni ölçülür
//     (≤250 ms; gelmezse başlık noktasının sabit yeri), `beamSource` ile ana pencere
//     CSS px'ine çevrilir. Pop-out yoksa `dom` kipi: renderer kendi orb'unu kullanır.
//   • `show(seg)`: `popout-outside` kipinde pencere DIŞINDA kalan parça için saydam,
//     tıklama-geçirgen, odak almayan üçüncü bir BrowserWindow (agimen AX-24 kalıbı).
//     Yol SMIL `animateMotion` ile çizilir (script yok, CSP `default-src 'none'`).
//     YALNIZ macOS: Windows'ta DWM kapalıysa saydamlık düşer, Linux/X11'de bileşik
//     yönetici yoksa siyah çizilir (§9) → o platformlarda KODDAN `popout-other-display`
//     davranışına düşülür (ışık ana pencerenin kenarından doğar), pencere AÇILMAZ.
//
// TÜM IO ENJEKTE (BrowserWindow/screen/pencere erişimi parametre) → node --test.

'use strict';

const geometry = require('./agentxBeamGeometry.cjs');

/** Pop-out başlığındaki gösterge noktası (JarvisVoiceWindow: px-3 py-2, h-2.5 w-2.5). Ölçüm gelmezse. */
const POPOUT_INDICATOR_FALLBACK = Object.freeze({ x: 12, y: 9, width: 10, height: 10 });
const MEASURE_TIMEOUT_MS = 250;
const BEAM_COLOR = '#3b82f6';

const live = (w) => !!w && !w.isDestroyed() && w.isVisible() && !(typeof w.isMinimized === 'function' && w.isMinimized());

/**
 * @param {object} d
 * @param {any} d.BrowserWindow
 * @param {{getDisplayMatching:(b:object)=>{id:any}}} d.screen
 * @param {() => any} d.getHost        ana pencere
 * @param {() => any} d.getPopout      Agent X pop-out penceresi (yoksa null)
 * @param {(win:any, measurementId:string) => Promise<object|null>} [d.measurePopout]  gösterge dikdörtgeni (CSS px)
 * @param {string} [d.platform]
 * @param {(s:string)=>void} [d.log]
 */
function createAgentxBeam(d) {
  const { BrowserWindow, screen, getHost, getPopout, measurePopout, platform = process.platform, log = () => {} } = d;
  let current = null;
  let seq = 0;

  const displayIdOf = (b) => {
    try { return String(screen.getDisplayMatching(b).id); } catch { return 'unknown'; }
  };

  /**
   * Kaynak ölçümü. Renderer kendi orb dikdörtgenini (`orbCss`, ana pencere CSS px) verir;
   * pop-out yoksa aynen `dom` döner. Pop-out açıksa gerçek pencere konumu ölçülür.
   */
  async function source({ orbCss } = {}) {
    const host = getHost();
    const popout = getPopout();
    if (!host || host.isDestroyed()) return { ok: false, reason: 'no-host' };
    const mainContent = host.getContentBounds();
    const mainZoom = host.webContents.getZoomFactor();
    if (!live(popout)) {
      const orb = geometry.rectOK(orbCss) ? orbCss : null;
      if (!orb) return { ok: false, reason: 'no-orb' };
      return { ok: true, ...geometry.beamSource({ mainContent, mainZoom, popoutContent: null, orbCss: orb, displayIdOf }), mainContent, mainZoom };
    }
    let indicator = null;
    if (typeof measurePopout === 'function') {
      const id = `m${++seq}`;
      try {
        indicator = await Promise.race([
          measurePopout(popout, id),
          new Promise((resolve) => setTimeout(() => resolve(null), MEASURE_TIMEOUT_MS)),
        ]);
      } catch { indicator = null; }
    }
    const orb = geometry.rectOK(indicator) ? indicator : POPOUT_INDICATOR_FALLBACK;
    const res = geometry.beamSource({
      mainContent,
      mainZoom,
      popoutContent: popout.getContentBounds(),
      popoutZoom: popout.webContents.getZoomFactor(),
      orbCss: orb,
      displayIdOf,
    });
    // Platform kapısı: saydam masaüstü katmanı yalnız macOS'ta güvenilir (§9).
    if (res.mode === 'popout-outside' && platform !== 'darwin') {
      return { ok: true, ...res, mode: 'popout-other-display', overlay: null, fallback: 'platform', mainContent, mainZoom, measured: indicator != null };
    }
    return { ok: true, ...res, mainContent, mainZoom, measured: indicator != null };
  }

  function clear() {
    const op = current;
    if (!op) return;
    current = null;
    clearTimeout(op.timer);
    for (const [owner, name, fn] of op.listeners) { try { owner.removeListener(name, fn); } catch { /* yok */ } }
    if (op.win && !op.win.isDestroyed()) { try { op.win.destroy(); } catch { /* yok */ } }
  }

  /**
   * Masaüstü katmanı SVG'si: yolun [0, keyPointEnd] parçası boyunca uçan kuyruklu daire.
   * AXP-10 — ana overlay ile AYNI kalınlık (çekirdek r=11, `src/app/lib/agentxBeam.ts::BEAM_VISUAL`):
   * iz = aynı yolda 60–400 ms GERİDEN gelen küçülen/solan daireler (SMIL `begin` gecikmesi = zaman
   * tabanlı iz). Dış glow burada YOK: şerit 48 px yüksek, r=26 hale kırpılırdı. Geometri DEĞİŞMEDİ.
   */
  function html(seg, bounds, durationMs) {
    const d = `M ${seg.from.x} ${seg.from.y} Q ${seg.control.x} ${seg.control.y} ${seg.to.x} ${seg.to.y}`;
    const kp = Math.max(0.001, Math.min(1, seg.keyPointEnd));
    const dur = Math.max(1, Math.round(durationMs * kp));
    const dot = (r, op, delayMs) =>
      `<circle r="${r}" fill="${BEAM_COLOR}" fill-opacity="${op}"><animateMotion dur="${dur}ms" begin="${delayMs}ms" fill="freeze" calcMode="linear" keyPoints="0;${kp.toFixed(4)}" keyTimes="0;1" path="${d}"/></circle>`;
    const shape =
      `<path d="${d}" fill="none" stroke="${BEAM_COLOR}" stroke-opacity=".22" stroke-width="3"/>` +
      dot(3, 0.1, 400) + dot(5, 0.2, 300) + dot(7, 0.35, 200) + dot(9, 0.55, 120) + dot(10, 0.75, 60) + dot(11, 1, 0);
    return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{margin:0;background:transparent;overflow:hidden}</style><svg xmlns="http://www.w3.org/2000/svg" width="${bounds.width}" height="${bounds.height}">${shape}</svg>`;
  }

  /**
   * Pencere dışı parçayı çiz. `seg` renderer'ın uçuş geometrisi (ana CSS px) + kaynak ölçümünün
   * `overlay`/`mainContent`/`mainZoom`'u. Döner: {shown, reason?, tSplit?}. Süre dolunca kendini yıkar.
   */
  async function show(seg) {
    const host = getHost();
    const popout = getPopout();
    if (platform !== 'darwin') return { shown: false, reason: 'platform-fallback' };
    if (!seg || seg.mode !== 'popout-outside' || !geometry.rectOK(seg.overlay)) return { shown: false, reason: 'not-outside' };
    if (!live(host) || !live(popout)) return { shown: false, reason: 'window-unavailable' };
    const local = geometry.desktopSegment({
      from: seg.from, control: seg.control, to: seg.to,
      mainContent: seg.mainContent, mainZoom: seg.mainZoom, overlay: seg.overlay,
      win: { width: seg.mainContent.width / (seg.mainZoom || 1), height: seg.mainContent.height / (seg.mainZoom || 1) },
    });
    if (!local || local.tSplit <= 0) return { shown: false, reason: 'no-outside-segment' };
    clear();
    const durationMs = Math.max(1, Number(seg.durationMs) || 650);
    const win = new BrowserWindow({
      ...seg.overlay,
      frame: false, transparent: true, backgroundColor: '#00000000', focusable: false, show: false,
      alwaysOnTop: true, skipTaskbar: true, hasShadow: false, resizable: false,
      ...(platform === 'darwin' ? { type: 'panel' } : {}),
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    try { win.setIgnoreMouseEvents(true); } catch { /* yok */ }
    const op = { win, timer: null, listeners: [] };
    current = op;
    const listen = (owner, name) => { if (!owner || typeof owner.once !== 'function') return; owner.once(name, clear); op.listeners.push([owner, name, clear]); };
    for (const owner of [host, popout]) for (const name of ['move', 'resize', 'hide', 'closed']) listen(owner, name);
    listen(screen, 'display-metrics-changed');
    op.timer = setTimeout(clear, durationMs + 400);
    op.timer.unref?.();
    const shownAt = new Promise((resolve) => {
      win.webContents.once('did-finish-load', () => {
        if (current !== op || win.isDestroyed()) return resolve(false);
        try { win.showInactive(); } catch { /* yok */ }
        resolve(true);
      });
    });
    try {
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html(local, seg.overlay, durationMs))}`);
    } catch (e) { log(`agentx beam: masaüstü katmanı yüklenemedi: ${e && e.message}`); clear(); return { shown: false, reason: 'load-failed' }; }
    const shown = await Promise.race([shownAt, new Promise((r) => setTimeout(() => r(false), 400))]);
    if (!shown) { clear(); return { shown: false, reason: 'not-shown' }; }
    return { shown: true, tSplit: local.tSplit, keyPointEnd: local.keyPointEnd, bounds: seg.overlay };
  }

  return { source, show, clear, get active() { return !!current; } };
}

module.exports = { createAgentxBeam, POPOUT_INDICATOR_FALLBACK, MEASURE_TIMEOUT_MS };
