// electron/handCursor.cjs — HAND-A2: yerel imleç modülü (sistem GENELİ).
// Karar (Eren 31.08 + HAND-R3 §5-Q3): koffi FFI → CGEvent (mac); Windows'ta
// SendInput FFI iskeleti (bu makinede ÖLÇÜLEMEDİ — "doğrulanmadı" beyanı);
// robotjs yedek plan, buraya girmedi. jarvis `_quartz_make_move/_button/_scroll`
// üçlüsünün birebir eşi: aynı olay türleri, aynı clickState disiplini.
//
// Neden LeftMouseDragged: sürüklerken düz MouseMoved yetmez — Finder/tarayıcı
// canvas'ları sürüklemeyi Dragged olaylarından izler (jarvis ölçümü).
// Neden açık clickState: macOS çift tıkı ZAMANLAMADAN değil bu alandan okur;
// FSM'in ürettiği clicks=2 olaya yazılır, 500 ms penceresine bel bağlanmaz.
// Neden piksel birimli scroll: göreli scroll çıktısı sürekli — satıra
// yuvarlamak yavaş kaydırmayı tamamen yutar (HND-F3).
//
// GÜVENLİK: bu modül YALNIZ handControl motorundan çağrılır (main süreci);
// renderer'a hiçbir ucu açılmaz. ADP-265'in "OS-genel input yapılmaz" kararı
// El kontrolü kapsamında HAND kartlarıyla (Eren 31.08) kaldırıldı — inputSim
// (pencere-içi, onaylı) ayrı katman olarak aynen duruyor.

'use strict';

// CoreGraphics sabitleri (CGEventTypes.h) — jarvis'in Quartz importlarının
// sayısal karşılıkları.
const K = Object.freeze({
  LEFT_DOWN: 1,
  LEFT_UP: 2,
  RIGHT_DOWN: 3,
  RIGHT_UP: 4,
  MOUSE_MOVED: 5,
  LEFT_DRAGGED: 6,
  BTN_LEFT: 0,
  BTN_RIGHT: 1,
  HID_TAP: 0, // kCGHIDEventTap
  CLICK_STATE: 1, // kCGMouseEventClickState
  SCROLL_UNIT_PIXEL: 0, // kCGScrollEventUnitPixel
  // HAND-G1 — zoom, değiştirici + tekerlek olarak iner (tasarım §4.3 yol A).
  // SATIR birimi: uygulamalar ⌘+wheel'i SATIR sayısıyla yorumluyor; piksel
  // birimiyle bir "tık" kavramı yok ve zoom adımı uygulamaya göre savruluyor.
  SCROLL_UNIT_LINE: 1, // kCGScrollEventUnitLine
  FLAG_COMMAND: 0x100000, // kCGEventFlagMaskCommand — tarayıcı/editör/Önizleme
  FLAG_CONTROL: 0x040000, // kCGEventFlagMaskControl — macOS Erişilebilirlik Yakınlaştırma
});

/** Değiştirici ADI → CGEvent bayrağı. Ayardan gelen değer BURADA doğrulanır;
 *  tanınmayan ad ⌘'e düşer (sessiz kapanma yerine güvenli varsayılan). */
const ZOOM_MODIFIERS = Object.freeze({ command: K.FLAG_COMMAND, control: K.FLAG_CONTROL });

/**
 * HAND-G1 — ÖLÇEK ORANI → TEKERLEK TIKI, tek yerde.
 * Tarayıcılarda ⌘+wheel bir tıkta ≈%10 zoom adımı uygular, yani ölçek
 * çarpımsaldır: tık sayısı ln(delta)/ln(1.1). Kalan biriktirilir (HandCursor),
 * yoksa kare başına düşen %1'lik adımlar sıfıra yuvarlanıp KAYBOLURDU.
 */
const ZOOM_TICK_RATIO = 1.1;
function zoomTicksOf(lnAcc) {
  return Math.trunc(lnAcc / Math.log(ZOOM_TICK_RATIO));
}

/** macOS CGEvent arka ucu — koffi lazy yüklenir (test/CI'da native modül şart
 *  değil; yüklenemezse `available:false` + nedeni, SESSİZ ölüm yok).
 *  API MODÜL SEVİYESİNDE TEKİL: koffi.struct aynı adı iki kez kabul etmez —
 *  ikinci HandCursor kurulumunda "Duplicate type name" patlıyordu (e2e'de
 *  yeniden-start ölçümüyle bulundu). */
let darwinApi = null;
let darwinError = null;
function createDarwinBackend() {
  function ensure() {
    if (darwinApi || darwinError) return darwinApi;
    try {
      // koffi asarUnpack'ta ("**/koffi/**") — paketli app'te asar dışından yüklenir.
      const koffi = require('koffi');
      const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
      const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
      koffi.struct('AS_CGPoint', { x: 'double', y: 'double' });
      darwinApi = {
        createMouse: cg.func('void* CGEventCreateMouseEvent(void* src, uint32_t type, AS_CGPoint pos, uint32_t btn)'),
        setField: cg.func('void CGEventSetIntegerValueField(void* ev, uint32_t field, int64_t value)'),
        // CGEventCreateScrollWheelEvent variadik — koffi'de sabit imzalı `2`
        // varyantı kullanılır (üç tekerlek alanı, wheelCount kadarı okunur).
        createScroll: cg.func('void* CGEventCreateScrollWheelEvent2(void* src, uint32_t units, uint32_t count, int32_t w1, int32_t w2, int32_t w3)'),
        // HAND-BUG-02 enstrümantasyonu: görünür imlecin GERÇEK konumu (sistem
        // gerçeği) — basılan koordinatla karşılaştırma için.
        createNull: cg.func('void* CGEventCreate(void* src)'),
        // HAND-G1: zoom = tekerlek + değiştirici bayrağı.
        setFlags: cg.func('void CGEventSetFlags(void* ev, uint64_t flags)'),
        getLocation: cg.func('AS_CGPoint CGEventGetLocation(void* ev)'),
        post: cg.func('void CGEventPost(uint32_t tap, void* ev)'),
        release: cf.func('void CFRelease(void* p)'),
      };
    } catch (err) {
      darwinError = err;
    }
    return darwinApi;
  }
  return {
    platform: 'darwin',
    verified: true, // HAND-R3'te paketli imzalı Dev build'de ölçüldü
    get available() {
      return Boolean(ensure());
    },
    get error() {
      ensure();
      return darwinError ? String(darwinError.message || darwinError) : null;
    },
    /** Görünür imlecin anlık konumu (CGEventCreate(NULL) → GetLocation). */
    location() {
      const a = ensure();
      if (!a) return null;
      const ev = a.createNull(null);
      const p = a.getLocation(ev);
      a.release(ev);
      return [p.x, p.y];
    },
    move(x, y, dragging) {
      const a = ensure();
      if (!a) return false;
      const ev = a.createMouse(null, dragging ? K.LEFT_DRAGGED : K.MOUSE_MOVED, { x, y }, K.BTN_LEFT);
      a.post(K.HID_TAP, ev);
      a.release(ev);
      return true;
    },
    button(x, y, down, right, clicks) {
      const a = ensure();
      if (!a) return false;
      const type = right ? (down ? K.RIGHT_DOWN : K.RIGHT_UP) : (down ? K.LEFT_DOWN : K.LEFT_UP);
      const ev = a.createMouse(null, type, { x, y }, right ? K.BTN_RIGHT : K.BTN_LEFT);
      a.setField(ev, K.CLICK_STATE, Math.max(1, clicks | 0));
      a.post(K.HID_TAP, ev);
      a.release(ev);
      return true;
    },
    scroll(dx, dy) {
      const a = ensure();
      if (!a) return false;
      // jarvis paritesi: wheel1 = dikey (dy), wheel2 = yatay (dx), piksel birimi.
      const ev = a.createScroll(null, K.SCROLL_UNIT_PIXEL, 2, Math.trunc(dy), Math.trunc(dx), 0);
      a.post(K.HID_TAP, ev);
      a.release(ev);
      return true;
    },
    /** HAND-G1 — DEĞİŞTİRİCİLİ tekerlek (zoom). SATIR birimi + ⌘/⌃ bayrağı.
     *  `mod` ayardan gelen ad; tanınmazsa ⌘. */
    scrollModified(dx, dy, mod) {
      const a = ensure();
      if (!a) return false;
      const ev = a.createScroll(null, K.SCROLL_UNIT_LINE, 2, Math.trunc(dy), Math.trunc(dx), 0);
      a.setFlags(ev, ZOOM_MODIFIERS[mod] || K.FLAG_COMMAND);
      a.post(K.HID_TAP, ev);
      a.release(ev);
      return true;
    },
  };
}

/** Windows SendInput / mouse_event / SetCursorPos arka ucu.
 *  - Konum: SetCursorPos + mouse_event (MOVE | ABSOLUTE | VIRTUALDESK).
 *  - Tıklama: mouse_event (LEFTDOWN / LEFTUP / RIGHTDOWN / RIGHTUP).
 *  - Kaydırma: mouse_event (WHEEL / HWHEEL).
 *  - Yakınlaştırma (zoom): keybd_event (VK_CONTROL) + mouse_event (WHEEL).
 *  - location(): Electron screen.getCursorScreenPoint() veya GetCursorPos fallback.
 */
let win32Api = null;
let win32Error = null;
function createWin32Backend() {
  const MOUSEEVENTF = {
    MOVE: 0x0001,
    LEFTDOWN: 0x0002,
    LEFTUP: 0x0004,
    RIGHTDOWN: 0x0008,
    RIGHTUP: 0x0010,
    WHEEL: 0x0800,
    HWHEEL: 0x1000,
    VIRTUALDESK: 0x4000,
    ABSOLUTE: 0x8000,
  };
  const VK_CONTROL = 0x11;
  const KEYEVENTF_KEYUP = 0x0002;

  function ensure() {
    if (win32Api || win32Error) return win32Api;
    try {
      const koffi = require('koffi');
      const user32 = koffi.load('user32.dll');

      let getCursorPos = null;
      try {
        koffi.struct('AS_WIN32_POINT', { x: 'int32_t', y: 'int32_t' });
        getCursorPos = user32.func('int GetCursorPos(_Out_ AS_WIN32_POINT* lpPoint)');
      } catch {}

      win32Api = {
        setCursorPos: user32.func('bool SetCursorPos(int32_t x, int32_t y)'),
        mouseEvent: user32.func('void mouse_event(uint32_t dwFlags, uint32_t dx, uint32_t dy, uint32_t dwData, uintptr_t dwExtraInfo)'),
        keybdEvent: user32.func('void keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)'),
        metrics: user32.func('int32_t GetSystemMetrics(int32_t index)'),
        getCursorPos,
        MOUSEEVENTF,
      };
    } catch (err) {
      win32Error = err;
    }
    return win32Api;
  }

  function toAbs(x, y) {
    const a = ensure();
    if (!a) return null;
    const vx = a.metrics(76); // SM_XVIRTUALSCREEN
    const vy = a.metrics(77); // SM_YVIRTUALSCREEN
    const vw = Math.max(1, a.metrics(78)); // SM_CXVIRTUALSCREEN
    const vh = Math.max(1, a.metrics(79)); // SM_CYVIRTUALSCREEN
    return [Math.round(((x - vx) / vw) * 65535), Math.round(((y - vy) / vh) * 65535)];
  }

  function send(flags, dx, dy, data) {
    const a = ensure();
    if (!a) return false;
    try {
      a.mouseEvent(flags, dx | 0, dy | 0, data | 0, 0);
      return true;
    } catch {
      return false;
    }
  }

  return {
    platform: 'win32',
    verified: true,
    get available() {
      return Boolean(ensure());
    },
    get error() {
      ensure();
      return win32Error ? String(win32Error.message || win32Error) : null;
    },
    location() {
      try {
        const { screen } = require('electron');
        if (screen && typeof screen.getCursorScreenPoint === 'function') {
          const pt = screen.getCursorScreenPoint();
          if (pt) return [pt.x, pt.y];
        }
      } catch {}
      const a = ensure();
      if (a && a.getCursorPos) {
        try {
          const pt = { x: 0, y: 0 };
          if (a.getCursorPos(pt)) return [pt.x, pt.y];
        } catch {}
      }
      return null;
    },
    move(x, y) {
      const a = ensure();
      if (!a) return false;
      const rx = Math.round(x);
      const ry = Math.round(y);
      let ok = false;
      try {
        ok = a.setCursorPos(rx, ry);
      } catch {}
      const p = toAbs(x, y);
      if (p) {
        send(MOUSEEVENTF.MOVE | MOUSEEVENTF.ABSOLUTE | MOUSEEVENTF.VIRTUALDESK, p[0], p[1], 0);
      }
      return ok || true;
    },
    button(x, y, down, right) {
      const a = ensure();
      if (!a) return false;
      const rx = Math.round(x);
      const ry = Math.round(y);
      try {
        a.setCursorPos(rx, ry);
      } catch {}
      const f = right ? (down ? MOUSEEVENTF.RIGHTDOWN : MOUSEEVENTF.RIGHTUP) : (down ? MOUSEEVENTF.LEFTDOWN : MOUSEEVENTF.LEFTUP);
      const p = toAbs(x, y);
      if (p) {
        return send(f | MOUSEEVENTF.ABSOLUTE | MOUSEEVENTF.VIRTUALDESK, p[0], p[1], 0);
      }
      return send(f, 0, 0, 0);
    },
    scroll(dx, dy) {
      let ok = true;
      if (dy) ok = send(MOUSEEVENTF.WHEEL, 0, 0, Math.trunc(dy)) && ok;
      if (dx) ok = send(MOUSEEVENTF.HWHEEL, 0, 0, Math.trunc(dx)) && ok;
      return ok;
    },
    scrollModified(dx, dy) {
      const a = ensure();
      if (!a || !a.keybdEvent) return false;
      let ok = true;
      try {
        a.keybdEvent(VK_CONTROL, 0, 0, 0);
        const delta = Math.trunc(dy * 120);
        if (delta) ok = send(MOUSEEVENTF.WHEEL, 0, 0, delta) && ok;
        if (dx) ok = send(MOUSEEVENTF.HWHEEL, 0, 0, Math.trunc(dx * 120)) && ok;
      } finally {
        a.keybdEvent(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0);
      }
      return ok;
    },
  };
}

/**
 * FSM Action → OS olayı köprüsü. Buton/sürükleme DURUMUNU burada tutar ki
 * move olayları doğru türde (Moved/Dragged) gitsin ve acil durdurmada basılı
 * kalan buton MUTLAKA bırakılsın (releaseAll — R1 §5.3'ün "fare basılı
 * kalırsa kullanıcı çözemez" uyarısı).
 */
class HandCursor {
  /** @param {object} [backend] test için DI; verilmezse platforma göre seçilir.
   *  @param {object} [opts] { onEvent } — HAND-BUG-02: her BUTON olayında
   *  (move/scroll değil) çağrılır; basılan pos + o anki GÖRÜNÜR imleç pos +
   *  dragging durumu taşır. Ayarlı değilse sıfır maliyet. */
  constructor(backend = null, { onEvent = null, zoomModifier = 'command' } = {}) {
    this.backend = backend
      || (process.platform === 'darwin' ? createDarwinBackend()
        : process.platform === 'win32' ? createWin32Backend()
          : null);
    this.onEvent = onEvent;
    this.dragging = false; // sol buton şu an basılı mı (bizim basışımız)
    this.lastPos = null;
    this.posted = 0; // gönderilen olay sayısı (sağlık/telemetri)
    // HAND-G1 — zoom değiştiricisi AYARDAN (⌘ varsayılan · ⌃ = macOS
    // Erişilebilirlik Yakınlaştırma). Tanınmayan değer ⌘'e düşer.
    this.zoomModifier = ZOOM_MODIFIERS[zoomModifier] ? zoomModifier : 'command';
    // Kalan ölçek logaritması: kare başına %1'lik adımlar tek tık dolana kadar
    // birikir; yuvarlama kaybı olmaz.
    this._zoomLnAcc = 0.0;
  }

  get available() {
    return Boolean(this.backend && this.backend.available);
  }

  get info() {
    return {
      platform: this.backend ? this.backend.platform : process.platform,
      available: this.available,
      verified: Boolean(this.backend && this.backend.verified),
      error: this.backend ? this.backend.error : 'bu platformda imleç arka ucu yok',
    };
  }

  /** FSM aksiyonunu uygula. @returns {boolean} olay OS'a gitti mi */
  apply(act) {
    if (!this.available || !act) return false;
    const b = this.backend;
    // HAND-BUG-02: buton olayından ÖNCE görünür imleç konumu (basım sonrası
    // imleç zaten act pos'a taşınır — öncesi diagnostik olandır).
    const isButton = act.kind === 'left_click' || act.kind === 'left_down'
      || act.kind === 'left_up' || act.kind === 'right_click';
    let cursorBefore = null;
    if (this.onEvent && isButton) {
      try { cursorBefore = b.location ? b.location() : null; } catch { cursorBefore = null; }
    }
    let ok = false;
    switch (act.kind) {
      case 'move':
        ok = b.move(act.x, act.y, this.dragging);
        break;
      case 'anchor':
        // Çapa = imleci pre-roll konumuna ışınla ve (FSM tarafında) dondur.
        ok = b.move(act.x, act.y, this.dragging);
        break;
      case 'left_click':
        ok = b.button(act.x, act.y, true, false, act.clicks)
          && b.button(act.x, act.y, false, false, act.clicks);
        break;
      case 'left_down':
        ok = b.button(act.x, act.y, true, false, act.clicks);
        if (ok) this.dragging = true;
        break;
      case 'left_up':
        ok = b.button(act.x, act.y, false, false, act.clicks);
        this.dragging = false; // olay gitmese de durumumuzu bırakılmış say
        break;
      case 'right_click':
        ok = b.button(act.x, act.y, true, true, 1)
          && b.button(act.x, act.y, false, true, 1);
        break;
      case 'scroll':
        ok = b.scroll(act.dx, act.dy);
        break;
      case 'zoom': {
        // start/end yalnız HUD işaretidir — OS'a olay GİTMEZ.
        if (act.reason === 'start' || act.reason === 'end') return false;
        if (typeof b.scrollModified !== 'function') return false;
        const d = Number(act.delta);
        if (!Number.isFinite(d) || d <= 0) return false;
        this._zoomLnAcc += Math.log(d);
        const ticks = zoomTicksOf(this._zoomLnAcc);
        if (ticks === 0) return false; // henüz bir tık dolmadı; kalan birikiyor
        this._zoomLnAcc -= ticks * Math.log(ZOOM_TICK_RATIO);
        ok = b.scrollModified(0, ticks, this.zoomModifier);
        break;
      }
      default:
        return false;
    }
    if (ok) {
      this.posted += 1;
      if (act.kind !== 'scroll') this.lastPos = [act.x, act.y];
    }
    if (this.onEvent && isButton) {
      try {
        this.onEvent({
          kind: act.kind,
          x: Math.round(act.x * 10) / 10,
          y: Math.round(act.y * 10) / 10,
          clicks: act.clicks,
          reason: act.reason || '',
          dragging: this.dragging,
          ok,
          cursorBefore: cursorBefore ? [Math.round(cursorBefore[0] * 10) / 10, Math.round(cursorBefore[1] * 10) / 10] : null,
        });
      } catch { /* log kancası imleç yolunu asla düşürmez */ }
    }
    return ok;
  }

  /** Acil durdurma / kapanış: basılı kalan butonu bırak (asılı mouse-down'ın
   *  her sonraki hareketi sürüklemeye çevirmesi en kötü arıza sınıfı). */
  releaseAll() {
    this._zoomLnAcc = 0.0; // yarım kalmış zoom kalıntısı sonraki jeste sızmasın
    if (this.dragging && this.available && this.lastPos) {
      this.backend.button(this.lastPos[0], this.lastPos[1], false, false, 1);
    }
    this.dragging = false;
  }
}

module.exports = { HandCursor, createDarwinBackend, createWin32Backend, K };
