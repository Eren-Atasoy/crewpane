// electron/handZoomRouter.cjs — HAND-G2: ZOOM YÖNLENDİRİCİ (tek karar noktası).
//
// HAND-G1 zoom'u OS'a ⌘/⌃+tekerlek olarak indiriyor: her uygulamada çalışır
// ama kaba (uygulama başına adım farklı, ara değer yok). CrewPane kendi
// penceresi ÖNDEYSE çok daha iyisini yapabiliriz — doğrudan IPC ile ofis
// tuvalinin ölçeği / terminalin yazı boyu. "Trackpad hissi" burada doğar.
//
// KARAR NEREDE: burada, TEK yerde. `handCursor` içinde "acaba bizim pencere mi"
// dallanması YOK — o katman OS olayı basmakla yükümlü, odak bilgisi onun işi
// değil. Motor (`handControlCore`) da saf kalır: ona `cursor` yerine BU sarmalayıcı
// verilir, aynı `apply/releaseAll` sözleşmesi.
//
// ROTA JEST BAŞINDA KİLİTLENİR ("latch"). Neden: kullanıcı zoom yaparken
// ⌘Tab'lasa ya da sekme değiştirse kanal ORTADA değişirdi — ofis tuvali yarım
// büyümüş kalır, kalan hareket öndeki yabancı uygulamaya ⌘+tekerlek olarak
// iner. Rota jestin BAŞINDA seçilir, `end`e (ya da acil durdurmaya) kadar
// korunur; kapanış her zaman jestin BAŞLADIĞI kanala gider.
//
// Yüzeyi RENDERER bildirir (main hangi sekmenin önde olduğunu bilemez): sekme
// değiştikçe `handControl:zoomSurface` ile 'office'|'terminal'|null
// gelir, main son değeri tutar. null = "bu sekmede zoom'lanacak bir şey yok"
// → OS yolu (kullanıcı yine de zoom yapabilsin, sessizce ölmesin).

'use strict';

/** Uygulama içi zoom'u OLAN yüzeyler. Renderer bu adlardan birini bildirir;
 *  başka her şey (Kanban, ayarlar, rapor…) "yüzey yok" sayılır.
 *  'design' KATALOGDA YOK — ÖLÇÜLDÜ (05.09): dock'taki "Tasarım" sekmesi kendi
 *  tuvalini çizmiyor, ayrı bir PENCERE açıyor (WorkspaceView `onActivate:
 *  openDesignWindow`) ve o pencerede zoom/scale kontrolü hiç yok. Olmayan bir
 *  yüzeye ad açmak, hiçbir şeyin üretmediği ölü bir kanal demek olurdu; kart
 *  zaten "varsa" diyor. Tasarım tuvaline zoom eklendiğinde adı BURAYA girer. */
const ZOOM_SURFACES = Object.freeze(['office', 'terminal']);

/** Kapalı liste nöbeti: katalog dışı/çöp değer → null (çağıran OS yoluna düşer). */
function normalizeZoomSurface(raw) {
  return typeof raw === 'string' && ZOOM_SURFACES.includes(raw) ? raw : null;
}

class ZoomRouter {
  /**
   * @param {object}   o
   * @param {object}   o.cursor         HandCursor (OS yolu) — yoksa router de yok.
   * @param {Function} o.focusedSurface () => 'office'|'terminal'|null
   *                                    — CrewPane ÖNDE değilse null döner.
   * @param {Function} o.sendZoom       (payload) => boolean; renderer'a IPC.
   */
  constructor({ cursor = null, focusedSurface = null, sendZoom = null } = {}) {
    this.cursor = cursor;
    this.focusedSurface = typeof focusedSurface === 'function' ? focusedSurface : () => null;
    this.sendZoom = typeof sendZoom === 'function' ? sendZoom : () => false;
    /** Kilitli rota: null (jest yok) | { surface } (uygulama içi) | { surface: null } (OS). */
    this._route = null;
    /** Sağlık/telemetri: kaç jest hangi kanala gitti + kaç zoom aksiyonu geldi.
     *  `seen` sıfırsa arıza yönlendiricinin ÖNÜNDEDİR (jest hiç üretilmemiş);
     *  `seen` doluyken `app`+`os` sıfır kalamaz — ayrım teşhisi ikiye böler. */
    this.routed = { app: 0, os: 0, seen: 0 };
  }

  // HandCursor sözleşmesinin taşıyıcı alanları — motor bunlara bakar.
  get available() { return this.cursor ? this.cursor.available : false; }
  get info() { return this.cursor ? this.cursor.info : { platform: process.platform, verified: false, error: 'imleç arka ucu yok' }; }
  get posted() { return this.cursor ? this.cursor.posted : 0; }

  apply(act) {
    if (!act) return false;
    if (act.kind !== 'zoom') return this.cursor ? this.cursor.apply(act) : false;
    if (!this.cursor) return false;

    const reason = act.reason || 'move';
    this.routed.seen += 1;
    if (!this._route) {
      // Jestin ilk zoom aksiyonu: rotayı SEÇ ve kilitle. (`start` kaçsa bile
      // ilk `move` karar verdirir — kanal sessizce ölmesin.)
      const surface = normalizeZoomSurface(this.focusedSurface());
      this._route = { surface };
      this.routed[surface ? 'app' : 'os'] += 1;
    }
    const { surface } = this._route;
    if (reason === 'end') this._route = null; // jest bitti, kilit düşer

    if (!surface) return this.cursor.apply(act); // HAND-G1 yolu (OS)
    return Boolean(this.sendZoom({
      phase: reason,
      surface,
      scale: Number(act.scale) || 1.0,
      delta: Number(act.delta) || 1.0,
      x: act.x,
      y: act.y,
    }));
  }

  /** Acil durdurma / kapanış. Yarım kalan uygulama içi jest için KAPANIŞ
   *  gönderilir — yoksa tuval/terminal ara ölçekte asılı kalır (Y4). */
  releaseAll() {
    if (this._route && this._route.surface) {
      try { this.sendZoom({ phase: 'end', surface: this._route.surface, scale: 1.0, delta: 1.0, x: 0, y: 0 }); }
      catch { /* pencere kapanıyorsa zaten ölçek de yok */ }
    }
    this._route = null;
    if (this.cursor) this.cursor.releaseAll();
  }
}

module.exports = { ZoomRouter, normalizeZoomSurface, ZOOM_SURFACES };
