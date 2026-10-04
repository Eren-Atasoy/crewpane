// ADP-265 — Jarvis input simülasyonu ÇEKİRDEĞİ (saf, node --test'lenebilir).
//
// EREN KARARI (ADR-016 §"yasak" + board): Faz 1 = YALNIZ app penceresi içi,
// Electron `webContents.sendInputEvent` ile. OS-genel fare/klavye (CGEvent /
// AppleScript System Events / robotjs-sınıfı native modül) YAPILMAZ — Developer
// ID + notarization sonrasına ertelendi (keşif özeti ADP-265 raporunda: native
// modül prebuild/asarUnpack kırılganlığı + Accessibility izin akışı maliyeti).
//
// YAPISAL GÜVENLİK SINIRI: sendInputEvent olayı YALNIZ kendi webContents'imize
// enjekte eder — başka uygulamaya/pencereye ulaşması API gereği İMKÂNSIZ. Bu
// modül üstüne üç kapı daha koyar:
//   1. Şema doğrulaması — op ∈ {click, type, scroll}; bilinmeyen alan/şekil ret.
//   2. Pencere-içi koordinat sınırı — content bounds dışı click/scroll ret
//      (clamp DEĞİL: "görünmez yere tıkladım sanma" sınıfı sessiz sürprizi keser).
//   3. Rate-limit — ardışık eylem tavanı (varsayılan 10 eylem / 10 sn).
// Onay katmanı (İzin ver/Reddet kartı) RENDERER'dadır (actionBus onay-gerekli
// sınıfı, ADP-264 deseni) — bu modül onaydan geçmiş isteğin SON kapısıdır.

'use strict';

/** Tek seferde yazılabilecek metin tavanı (input.type). */
const MAX_TYPE_LEN = 500;
/** Scroll delta tavanı (tek eylemde). */
const MAX_SCROLL_DELTA = 2000;
/** Rate-limit varsayılanları: pencere başına en çok N eylem. */
const RATE_MAX = 10;
const RATE_WINDOW_MS = 10_000;

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Ham isteği doğrula + normalize et. Dönen action DIŞINDAKİ hiçbir alan main'e
 * geçmez (şema-dışı alan taşıma yok).
 * @returns {{ok:true, action:object}|{ok:false, error:string}}
 */
function validateInputAction(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const op = r.op;
  if (op === 'click') {
    if (!isFiniteNum(r.x) || !isFiniteNum(r.y) || r.x < 0 || r.y < 0) {
      return { ok: false, error: 'click için geçerli x,y gerekli' };
    }
    const button = r.button === 'right' ? 'right' : 'left';
    return { ok: true, action: { op: 'click', x: Math.round(r.x), y: Math.round(r.y), button } };
  }
  if (op === 'type') {
    if (typeof r.text !== 'string' || r.text.length === 0) {
      return { ok: false, error: 'type için boş olmayan text gerekli' };
    }
    if (r.text.length > MAX_TYPE_LEN) {
      return { ok: false, error: `text çok uzun (${r.text.length} > ${MAX_TYPE_LEN})` };
    }
    return { ok: true, action: { op: 'type', text: r.text } };
  }
  if (op === 'scroll') {
    const dx = isFiniteNum(r.dx) ? r.dx : 0;
    const dy = isFiniteNum(r.dy) ? r.dy : 0;
    if (dx === 0 && dy === 0) return { ok: false, error: 'scroll için dx veya dy gerekli' };
    const clamp = (v) => Math.max(-MAX_SCROLL_DELTA, Math.min(MAX_SCROLL_DELTA, v));
    // Konum opsiyonel — verilmezse main pencere merkezini kullanır.
    const pos = isFiniteNum(r.x) && isFiniteNum(r.y) ? { x: Math.round(r.x), y: Math.round(r.y) } : null;
    return { ok: true, action: { op: 'scroll', dx: clamp(dx), dy: clamp(dy), ...(pos ?? {}) } };
  }
  return { ok: false, error: `bilinmeyen op: ${String(op)}` };
}

/**
 * Koordinatlı eylem pencere content bounds İÇİNDE mi? (Yapısal app-içi sınırın
 * ikinci katmanı — sendInputEvent zaten dışarı çıkamaz; bu, saçma koordinatın
 * "sessizce hiçbir yere" gitmesini de keser.)
 */
function withinBounds(action, bounds) {
  const w = bounds && isFiniteNum(bounds.width) ? bounds.width : 0;
  const h = bounds && isFiniteNum(bounds.height) ? bounds.height : 0;
  if (action.op === 'type') return true; // odaklı elemana gider, koordinatsız
  if (!isFiniteNum(action.x) || !isFiniteNum(action.y)) return action.op === 'scroll'; // merkez fallback
  return action.x >= 0 && action.y >= 0 && action.x < w && action.y < h;
}

/** Kayan-pencere rate limiter (enjekte edilebilir saat). */
function makeRateLimiter({ max = RATE_MAX, windowMs = RATE_WINDOW_MS, now = Date.now } = {}) {
  const stamps = [];
  return {
    /** true → izinli (ve sayıldı); false → tavan aşıldı. */
    allow() {
      const t = now();
      while (stamps.length && t - stamps[0] > windowMs) stamps.shift();
      if (stamps.length >= max) return false;
      stamps.push(t);
      return true;
    },
    size: () => stamps.length,
  };
}

/**
 * Doğrulanmış action → sendInputEvent payload dizisi.
 *   click  → mouseMove + mouseDown + mouseUp (clickCount 1)
 *   type   → karakter başına `char`; '\n'/'\r' → Enter keyDown/keyUp çifti
 *   scroll → mouseWheel (deltaY yukarı-pozitif Electron sözleşmesi: kullanıcının
 *            "aşağı kaydır"ı dy>0 → deltaY NEGATİF çevrilir)
 * Merkez koordinat gerektiren scroll'da çağıran (main) x/y'yi doldurmuş olmalı.
 */
function toInputEvents(action) {
  if (action.op === 'click') {
    const base = { x: action.x, y: action.y, button: action.button };
    return [
      { type: 'mouseMove', x: action.x, y: action.y },
      { type: 'mouseDown', ...base, clickCount: 1 },
      { type: 'mouseUp', ...base, clickCount: 1 },
    ];
  }
  if (action.op === 'type') {
    const events = [];
    for (const ch of action.text) {
      if (ch === '\n' || ch === '\r') {
        events.push({ type: 'keyDown', keyCode: 'Return' }, { type: 'keyUp', keyCode: 'Return' });
      } else {
        events.push({ type: 'char', keyCode: ch });
      }
    }
    return events;
  }
  if (action.op === 'scroll') {
    const dx = action.dx ?? 0;
    const dy = action.dy ?? 0;
    return [
      // Önce imleci konuma taşı — Chromium wheel yönlendirmesi macOS'ta konumlu
      // mouseMove olmadan overlay/scroller'ı ıskalayabiliyor (e2e bulgusu).
      { type: 'mouseMove', x: action.x, y: action.y },
      {
        type: 'mouseWheel',
        x: action.x,
        y: action.y,
        // Kullanıcı sözleşmesi dy>0 = "aşağı kaydır" (scrollTop artar). macOS
        // precise-delta sözleşmesinde AŞAĞI kaydırma NEGATİF deltaY'dir (doğal
        // kaydırma yönü) — e2e canlı pencerede iki işaret de denenerek pinlendi.
        deltaX: -dx,
        deltaY: -dy,
        wheelTicksX: dx ? -Math.sign(dx) : 0,
        wheelTicksY: dy ? -Math.sign(dy) : 0,
        hasPreciseScrollingDeltas: true,
        canScroll: true,
      },
    ];
  }
  return [];
}

module.exports = {
  MAX_TYPE_LEN,
  MAX_SCROLL_DELTA,
  RATE_MAX,
  RATE_WINDOW_MS,
  validateInputAction,
  withinBounds,
  makeRateLimiter,
  toInputEvents,
};
