// electron/handDisplayRouter.cjs — HAND-BUG-03: EL İMLECİNİN HEDEF EKRANI (saf).
//
// Kusur (Eren 03.09 canlı yayın, "fareyi 2. harici monitöre geçiremiyorum"):
// motor hedefi `screen.getPrimaryDisplay().bounds` ile BİR KEZ sabitliyordu
// (main.js). Ana ekran laptop olduğu için el imleci harici monitöre HİÇ
// çıkamıyordu — kod yazılmamıştı, arıza değil EKSİKTİ.
//
// Bu modülde Electron YOK: yalnız dikdörtgen geometrisi + kenar vuruşu FSM'i.
// main.js `screen`den okur, buraya SAYI verir; testler sahte düzenle koşar.
//
// ⚠️ TEK EKRANA EŞLEME KALIR (hassasiyet kararı, HAND-A2): el, hedef ekranın
// TAMAMINA eşlenir. Değişen tek şey HEDEFİN SEÇİLMESİ:
//   1. Başlangıç — CrewPane penceresinin bulunduğu ekran (ana ekran DEĞİL).
//   2. Kenar vuruşu — contract.md durum 19: kenar → GERİ ÇEKİL → kenar (çift
//      vuruş). O yöndeki komşuya geçer, N ekranda zincirlenir.
//   3. Gerçek fare — kullanıcı fiziksel fareyi başka ekrana götürürse hedef
//      o ekran olur (bizim ürettiğimiz imleç hareketleri SAYILMAZ).
//
// Sayılar contract.md'den (J): edge_band, edge_tap_window_s, edge_tap_retreat,
// edge_tap_frames. Gözle ayar YASAK — önce contract.md değişir.

'use strict';

const { J, EDGES } = require('./handOverlayContract.cjs');

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** Ekranların yan yana mı olduğu kararında pay: macOS düzeninde komşu ekranlar
 *  tam bitişiktir, ama ölçekleme/yuvarlama 1 px kaydırabilir. */
const ADJACENCY_TOL = 1;

/** Gerçek fare takibinde "bu bizim imlecimiz" toleransı (DIP px). CGEvent'e
 *  ondalık basıyoruz, OS tam sayıya yuvarlıyor (ölçüldü: 864 → 864). */
const OWN_CURSOR_TOL_PX = 3;

/**
 * Electron Display[] → düz {id,x,y,width,height,scaleFactor} listesi.
 * Bozuk/eksik girdi SESSİZCE atılır (planWindows ile aynı disiplin).
 */
function normalizeDisplays(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const d of list) {
    if (!d || !d.bounds) continue;
    const { x, y, width, height } = d.bounds;
    if (!finite(x) || !finite(y) || !finite(width) || !finite(height) || width <= 0 || height <= 0) continue;
    out.push({
      id: String(d.id),
      x, y, width, height,
      scaleFactor: finite(d.scaleFactor) && d.scaleFactor > 0 ? d.scaleFactor : 1,
      internal: d.internal === true,
      label: typeof d.label === 'string' ? d.label : '',
      // Motorun beklediği DIP dikdörtgeni (HandControlEngine.setTarget).
      bounds: { x, y, width, height },
    });
  }
  return out;
}

function displayById(displays, id) {
  if (!Array.isArray(displays) || id === null || id === undefined) return null;
  const key = String(id);
  return displays.find((d) => d.id === key) || null;
}

/** 1-tabanlı sıra — kullanıcıya gösterilen "Ekran N" (OS id'si değil). 0 = yok. */
function displayOrdinal(displays, id) {
  if (!Array.isArray(displays)) return 0;
  const i = displays.findIndex((d) => d.id === String(id));
  return i < 0 ? 0 : i + 1;
}

const contains = (d, p) => p.x >= d.x && p.x < d.x + d.width && p.y >= d.y && p.y < d.y + d.height;

function centerDist(d, p) {
  return Math.hypot((d.x + d.width / 2) - p.x, (d.y + d.height / 2) - p.y);
}

/** Noktayı içeren ekran; hiçbiri içermiyorsa merkeze EN YAKIN olan. */
function displayForPoint(displays, point) {
  if (!Array.isArray(displays) || !displays.length || !point || !finite(point.x) || !finite(point.y)) return null;
  for (const d of displays) if (contains(d, point)) return d;
  let best = displays[0];
  let bestD = centerDist(best, point);
  for (const d of displays.slice(1)) {
    const dist = centerDist(d, point);
    if (dist < bestD) { best = d; bestD = dist; }
  }
  return best;
}

function intersectArea(d, b) {
  const w = Math.min(d.x + d.width, b.x + b.width) - Math.max(d.x, b.x);
  const h = Math.min(d.y + d.height, b.y + b.height) - Math.max(d.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Pencere dikdörtgeni → ekran (Electron `screen.getDisplayMatching` eşi, ama SAF
 * ve test edilebilir). En büyük kesişim; kesişim yoksa merkeze en yakın.
 */
function displayForBounds(displays, bounds) {
  if (!Array.isArray(displays) || !displays.length) return null;
  if (!bounds || !finite(bounds.x) || !finite(bounds.width)) return displays[0];
  let best = null;
  let bestArea = 0;
  for (const d of displays) {
    const a = intersectArea(d, bounds);
    if (a > bestArea) { best = d; bestArea = a; }
  }
  if (best) return best;
  return displayForPoint(displays, { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
}

/**
 * `edge` yönündeki komşu ekran (OS düzen geometrisinden) — yoksa null.
 *
 * ŞART: dik eksende GERÇEKTEN örtüşmek. Bu, OS'un fareyi ekranlar arasında
 * geçirme kuralının ta kendisidir: iki ekran yalnız DEĞDİKLERİ kenardan
 * geçilir. L düzeninde a'nın altındaki köşegen ekran "alt komşu" SAYILMAZ —
 * saysaydı el imleci fiziksel fareyle aynı yerden geçmezdi ve kullanıcı
 * "aşağı gittim, yan ekrana düştüm" derdi. (Yalnız köşeden değen ekran bu
 * kuralla el jestiyle erişilemez kalır; oraya GERÇEK fareyle geçilir —
 * followRealCursor hedefi oraya taşır.)
 *
 * Sıralama: (1) o yöndeki boşluk küçük olan, (2) dik eksende merkezi yakın
 * olan, (3) id (belirlenimcilik).
 */
function neighborOf(displays, id, edge) {
  const cur = displayById(displays, id);
  if (!cur || !EDGES.includes(edge)) return null;
  const horiz = edge === 'left' || edge === 'right';
  const cands = [];
  for (const d of displays) {
    if (d.id === cur.id) continue;
    let gap;
    if (edge === 'right') gap = d.x - (cur.x + cur.width);
    else if (edge === 'left') gap = cur.x - (d.x + d.width);
    else if (edge === 'bottom') gap = d.y - (cur.y + cur.height);
    else gap = cur.y - (d.y + d.height);
    if (gap < -ADJACENCY_TOL) continue; // o yönde DEĞİL (eksende örtüşüyor)
    const overlap = horiz
      ? Math.min(cur.y + cur.height, d.y + d.height) - Math.max(cur.y, d.y)
      : Math.min(cur.x + cur.width, d.x + d.width) - Math.max(cur.x, d.x);
    if (overlap <= 0) continue; // yalnız köşeden değiyor → o kenardan geçilmez
    const perpDist = horiz
      ? Math.abs((d.y + d.height / 2) - (cur.y + cur.height / 2))
      : Math.abs((d.x + d.width / 2) - (cur.x + cur.width / 2));
    cands.push({ d, gap: Math.max(0, gap), perpDist });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => a.gap - b.gap || a.perpDist - b.perpDist || a.d.id.localeCompare(b.d.id));
  return cands[0].d;
}

/** Noktanın ekran içindeki her kenara NORMALİZE uzaklığı (0 = kenarın üstünde). */
function edgeDistances(point, display) {
  const x = Math.min(Math.max(point.x, display.x), display.x + display.width);
  const y = Math.min(Math.max(point.y, display.y), display.y + display.height);
  return {
    left: (x - display.x) / display.width,
    right: (display.x + display.width - x) / display.width,
    top: (y - display.y) / display.height,
    bottom: (display.y + display.height - y) / display.height,
  };
}

/** Nokta hangi kenarın bandında? Köşede DAHA DERİN (normalize uzaklığı küçük)
 *  kenar kazanır; eşitlikte EDGES sırası (belirlenimci). Bantta değilse null. */
function edgeOf(point, display, band = J.edge_band) {
  if (!display || !point || !finite(point.x) || !finite(point.y)) return null;
  const dist = edgeDistances(point, display);
  let best = null;
  for (const e of EDGES) {
    if (dist[e] > band) continue;
    if (best === null || dist[e] < dist[best]) best = e;
  }
  return best;
}

/** Kenardan YETERİNCE geri çekildi mi (contract.md edge_tap_retreat=0.25)? */
function retreatedFrom(point, display, edge, retreat = J.edge_tap_retreat) {
  if (!display || !EDGES.includes(edge) || !point) return false;
  return edgeDistances(point, display)[edge] > retreat;
}

/**
 * Durum 19 FSM'i: kenar → GERİ ÇEKİL → kenar = ekran değiştir.
 *
 * NEDEN çift vuruş ve neden geri çekilme ŞART: imleç ekran kenarında zaten
 * sürekli dolaşır (kapatma düğmesi, menü çubuğu, dock). "Kenara değince geç"
 * ya da "kenarda bekleyince geç" kuralları her gerçek tıklamada ekran
 * değiştirirdi. Geri çekilme (%25) jesti KASITLI yapar. Sayılar contract.md
 * durum 19'dan; overlay çizimi (bant + "1/2 · sağ" çipi + ilerleme çubuğu)
 * ZATEN yazılmıştı (HandOverlayCanvas.tsx) — eksik olan bu üreteçti.
 */
class EdgeSwitchTracker {
  constructor({ frames = J.edge_tap_frames, windowMs = J.edge_tap_window_s * 1000, band = J.edge_band, retreat = J.edge_tap_retreat } = {}) {
    this.frames = Math.max(1, Math.floor(frames));
    this.windowMs = windowMs;
    this.band = band;
    this.retreat = retreat;
    this.reset();
  }

  reset() {
    this.state = null; // { edge, count, firstAt, retreated }
    this.prevEdge = null; // önceki karede hangi bandın içindeydi (giriş KENARI için)
  }

  _event(phase, extra = {}) {
    return {
      type: 'edge',
      edge: this.state ? this.state.edge : extra.edge,
      phase,
      count: this.state ? this.state.count : 0,
      total: this.frames,
      ...extra,
    };
  }

  /**
   * @param {object} p { point, display, displays, now, handPresent }
   * @returns {{events: object[], switchTo: string|null}}
   */
  update({ point, display, displays, now, handPresent = true }) {
    const events = [];
    // El kayboldu → sayaç düşer, overlay'de asılı çip kalmaz.
    if (!handPresent || !point || !display) {
      if (this.state) {
        events.push({ ...this._event('expire'), display: display ? display.id : undefined });
        this.state = null;
      }
      this.prevEdge = null;
      return { events, switchTo: null };
    }

    const e = edgeOf(point, display, this.band);
    const entering = Boolean(e) && e !== this.prevEdge;
    let switchTo = null;

    // 1) Pencere doldu mu (edge_tap_window_s)?
    if (this.state && now - this.state.firstAt > this.windowMs) {
      events.push({ ...this._event('expire'), display: display.id });
      this.state = null;
    }

    if (this.state) {
      if (e === this.state.edge) {
        if (entering && this.state.retreated) {
          this.state.count += 1;
          if (this.state.count >= this.frames) {
            const nb = neighborOf(displays, display.id, this.state.edge);
            if (nb) {
              events.push({
                type: 'edge',
                edge: this.state.edge,
                phase: 'switch',
                count: this.state.count,
                total: this.frames,
                display: nb.id, // ROTALAMA: giriş animasyonunu hedef pencere oynar
                displayIndex: displayOrdinal(displays, nb.id),
              });
              switchTo = nb.id;
            }
            this.state = null;
            this.prevEdge = e;
            return { events, switchTo };
          }
          events.push({ ...this._event('tap'), display: display.id });
        }
      } else if (e) {
        // BAŞKA kenara geçildi: eski jest düşer, yenisi (komşusu varsa) başlar.
        events.push({ ...this._event('expire'), display: display.id });
        this.state = null;
        if (neighborOf(displays, display.id, e)) {
          this.state = { edge: e, count: 1, firstAt: now, retreated: false };
          events.push({ ...this._event('tap'), display: display.id });
        }
      } else if (!this.state.retreated && retreatedFrom(point, display, this.state.edge, this.retreat)) {
        this.state.retreated = true;
        events.push({ ...this._event('retreat'), display: display.id });
      }
    } else if (entering && neighborOf(displays, display.id, e)) {
      // Komşusu OLMAYAN kenar sayaç bile başlatmaz: "1/2 · sağ" çipi gösterip
      // sonra hiçbir yere gitmemek yanıltıcı olurdu (kart: "kenar sadece durur").
      this.state = { edge: e, count: 1, firstAt: now, retreated: false };
      events.push({ ...this._event('tap'), display: display.id });
    }

    this.prevEdge = e;
    return { events, switchTo };
  }
}

/**
 * Kart maddesi C — GERÇEK fare başka ekrana gittiyse hedef o ekran olur.
 * `lastApplied` bizim OS'a bastığımız son nokta: imleç oradaysa hareket
 * BİZDEN gelmiştir ve hedefi değiştirmez (yoksa el imleci kendi kendini
 * kovalayıp hedefi titretirdi).
 * @returns {string|null} yeni hedef display id (değişiklik yoksa null)
 */
function followRealCursor({ point, lastApplied, displays, currentId, tolerancePx = OWN_CURSOR_TOL_PX }) {
  if (!point || !finite(point.x) || !finite(point.y)) return null;
  if (Array.isArray(lastApplied) && lastApplied.length === 2
      && Math.abs(point.x - lastApplied[0]) <= tolerancePx
      && Math.abs(point.y - lastApplied[1]) <= tolerancePx) {
    return null; // bizim imlecimiz
  }
  const d = displayForPoint(displays, point);
  if (!d || d.id === String(currentId)) return null;
  return d.id;
}

/**
 * Ekran takımı değiştiğinde hedefi yeniden çöz: mevcut hedef HÂLÂ VARSA korunur
 * (kullanıcının kenar geçişi ezilmez), yoksa pencerenin ekranına düşülür.
 */
function resolveTarget(displays, { currentId = null, windowBounds = null } = {}) {
  if (!Array.isArray(displays) || !displays.length) return null;
  const cur = displayById(displays, currentId);
  if (cur) return cur;
  return displayForBounds(displays, windowBounds) || displays[0];
}

module.exports = {
  normalizeDisplays,
  displayById,
  displayOrdinal,
  displayForPoint,
  displayForBounds,
  neighborOf,
  edgeOf,
  edgeDistances,
  retreatedFrom,
  EdgeSwitchTracker,
  followRealCursor,
  resolveTarget,
  ADJACENCY_TOL,
  OWN_CURSOR_TOL_PX,
};
