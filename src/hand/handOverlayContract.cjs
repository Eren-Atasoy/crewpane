// HAND-A1 — EKRAN ÜSTÜ EL-KONTROL GÖRSELLEŞTİRMESİ: saf sözleşme + karar katmanı.
//
// Pencere YOK, çizim YOK — yalnız test edilebilir kararlar. Ekran tarafı iki
// parçadır: main.js (pencere yönetimi, ADP-816 kalıbı) ve
// src/app/components/HandOverlayCanvas.tsx (Canvas2D çizimi). İkisi de
// SAYILARINI buradan alır.
//
// ⚠️ TEK KAYNAK KURALI: aşağıdaki her sayı `docs/design/HAND-UX/contract.md`
// (HAND-R2) STATES tablosundan ve "Jarvis sabitleri" bloğundan BİREBİR alınmıştır.
// Gözle ayar YASAK — bir süre/eşik değişecekse önce contract.md (üreticisi
// docs/design/hand-ux-gen.cjs) değişir, sonra burası ona eşitlenir.
//
//   • EVENTS / normalizeEvent() — tespit döngüsünden (D mimarisi: gizli
//     BrowserWindow → IPC; ileride HAND-A2 köprüsü) gelen telemetri olayının
//     şekil nöbeti. Kirli/dev girdi bir pencereye ulaşmadan burada ölür.
//   • planWindows() — çoklu ekran stratejisi: ekran başına BİR pencere
//     (HAND-R1 §5.2 kararı; tek kapsayıcı pencere reddedildi — ölü alan).
//   • feedVerdict() — kare akışı nöbeti: akış koparsa katman KENDİNİ kapatır
//     (görev kartı madde 4). İmleci biz tutmuyoruz; kapanınca OS imleci zaten
//     normaldir.
//   • sanitizeHandControl() — `handControl.overlay.enabled` (varsayılan AÇIK,
//     Eren kararı 31.08) + `.density` + `handControl.camera` (HAND-BUG-01
//     kullanıcı kamera seçimi) ayarlarının kapalı-liste nöbeti.

'use strict';

// ---------------------------------------------------------------------------
// contract.md "Jarvis sabitleri" — UI bunlara bağlanır, elle yazılmaz.
// ---------------------------------------------------------------------------
const J = Object.freeze({
  preroll_s: 0.25,
  confirm_frames: 3,
  drag_hold_s: 0.35,
  drag_slop_px: 55,
  lost_grace_s: 0.15,
  arm_timeout_s: 1.2,
  left_cooldown_s: 0.12,
  right_cooldown_s: 0.4,
  double_window_s: 0.45,
  double_slop_px: 60,
  precision_gain: 0.35,
  scroll_decay_tau_s: 0.45,
  scroll_flick_min: 3,
  edge_band: 0.02, // HAND-BUG-03: kenar bandı ekran boyutunun oranı (TESPİT bandı;
  //                  VISUAL.edgeBandPx=24 ÇİZİM bandıdır, ikisi ayrı sayı)
  edge_tap_window_s: 1.2,
  edge_tap_retreat: 0.25,
  edge_tap_frames: 2, // kaç vuruşta ekran değişir (contract.md durum 19: "1/2")
  telemetry_hz: 30,
});

// contract.md STATES tablosu + "Ortak" satırı — şekil/süre sözlüğü.
// Süre merdiveni --dur-fast/base/slow ile AYNI sayılar (globals.css).
const VISUAL = Object.freeze({
  ringDiameter: 28, // halka Ø28 (2px)
  ringDiameterPrecision: 20, // hassas mod Ø20
  ringStroke: 2,
  ringStrokeArmed: 3, // ARMED: 2→3px
  armedDotMax: 4, // 3 kare onay boyunca iç nokta 0→4px
  haloStroke: 1, // hale 1px --surface-0 iç+dış
  burstFrom: 16, // patlama 16→44 (çift tıkta ikincisi 52)
  burstTo: 44,
  burstToDouble: 52,
  burstSquareRadius: 4, // sağ tık: KARE patlama, radius 4 = --radius-control
  trailWindowMs: 250, // son 250 ms yol (= preroll_s)
  trailSegments: 8, // 8 segment, 3→1px, opaklık .55→0
  trailMaxPx: 120, // iz ≤120px
  trailMinSpeed: 100, // iz yalnız hız >100 px/sn iken
  scrollSpeedTiers: Object.freeze([300, 900]), // <300 → 1 şevron · 300–900 → 2 · >900 → 3
  chevronGap: 10, // halkanın sağında 10 px boşluk
  precisionNotch: 6, // dört dışa çentik 6px
  dragAnchorSize: 6, // 6px KARE çapa
  dragLineStroke: 1,
  edgeBandPx: 24, // kenarda 24px bant
  chipHeight: 24, // çip 24px yüksek (DS-K35 tabanı)
  chipMaxChars: 34,
  durFast: 140, // --dur-fast · giriş --ease-out
  durBase: 220, // --dur-base · çıkış --ease-in
  durSlow: 420, // --dur-slow
  chipHoldMs: 1200, // durum 16/18/19 çip süresi (= arm_timeout_s)
  doubleChipMs: 420, // "2×" çipi
  lostDimDelayMs: 420, // el kayboldu: 420 ms'de --text-3 %40
  lostChipDelayMs: 2000, // 2000 ms sonra çip + kamera yönü oku
  lostFadeMs: 10000, // 10 s sonra halka söner
  lostReturnFrom: 20, // dönüşte halka 20→28 140 ms
  edgeSwitchRingFrom: 12, // yeni ekranda halka 12→28 220 ms
});

// ---------------------------------------------------------------------------
// Telemetri olayları — tespit kaynağı (D döngüsü / dev besleyici) → main → overlay.
// ---------------------------------------------------------------------------
const EVENT_TYPES = Object.freeze([
  'move', // { x, y, speed? }               → durum 10 (iz)
  'armed', // { x, y, pressed? }            → durum 11/14 ön hali
  'click', // { x, y, button, clicks }      → durum 11/12/13
  'drag', // { phase, x, y, ax?, ay? }      → durum 14
  'scroll', // { x, y, dir, speed, flick? } → durum 15
  'zoom', // { x, y, scale, phase }          → HAND-G1 (halka + yüzde rozeti)
  'blocked', // { x, y, reason }            → durum 16
  'hand', // { present, x?, y? }            → durum 17 (ve dönüş)
  'precision', // { on, x, y }              → durum 18
  'edge', // { edge, count, total, phase }  → durum 19
]);

const CLICK_BUTTONS = Object.freeze(['left', 'right']);
const DRAG_PHASES = Object.freeze(['hold', 'start', 'move', 'end']);
const SCROLL_DIRS = Object.freeze(['up', 'down', 'left', 'right']);
const ZOOM_PHASES = Object.freeze(['start', 'move', 'end']);
// HAND-G1 — FSM kelepçesiyle AYNI sayılar (handClickFsm zoomMin/zoomMax).
// Sözleşme kelepçenin dışını kabul etmez: bozuk ölçek HUD'a halka çizdirmesin.
const ZOOM_MIN = 0.125;
const ZOOM_MAX = 8.0;
const BLOCKED_REASONS = Object.freeze(['timeout', 'blocked']);
const EDGES = Object.freeze(['left', 'right', 'top', 'bottom']);
const EDGE_PHASES = Object.freeze(['tap', 'retreat', 'switch', 'expire']);

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Tespit kaynağından gelen HAM olayın şekil nöbeti. Geçersiz → null (sessiz
 * düşer; overlay bir konsol değildir, kirli girdiyi çizmeyi denemez).
 * Koordinatlar GLOBAL DIP uzayındadır (macOS global point = Electron DIP,
 * HAND-R1 §5.2 DPI notu) — pencereye dağıtımı renderer kendi display
 * sınırlarıyla yapar.
 */
function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object' || !EVENT_TYPES.includes(raw.type)) return null;
  const t = finite(raw.t) ? raw.t : Date.now();
  const base = { type: raw.type, t };
  switch (raw.type) {
    case 'move': {
      if (!finite(raw.x) || !finite(raw.y)) return null;
      return { ...base, x: raw.x, y: raw.y, speed: finite(raw.speed) ? Math.max(0, raw.speed) : 0 };
    }
    case 'armed': {
      if (!finite(raw.x) || !finite(raw.y)) return null;
      return { ...base, x: raw.x, y: raw.y, pressed: raw.pressed === true };
    }
    case 'click': {
      if (!finite(raw.x) || !finite(raw.y) || !CLICK_BUTTONS.includes(raw.button)) return null;
      const clicks = raw.clicks === 2 ? 2 : 1;
      return { ...base, x: raw.x, y: raw.y, button: raw.button, clicks };
    }
    case 'drag': {
      if (!finite(raw.x) || !finite(raw.y) || !DRAG_PHASES.includes(raw.phase)) return null;
      const out = { ...base, phase: raw.phase, x: raw.x, y: raw.y };
      if (finite(raw.ax) && finite(raw.ay)) { out.ax = raw.ax; out.ay = raw.ay; }
      return out;
    }
    case 'scroll': {
      if (!finite(raw.x) || !finite(raw.y) || !SCROLL_DIRS.includes(raw.dir)) return null;
      return { ...base, x: raw.x, y: raw.y, dir: raw.dir, speed: finite(raw.speed) ? Math.max(0, raw.speed) : 0, flick: raw.flick === true };
    }
    case 'zoom': {
      if (!finite(raw.x) || !finite(raw.y) || !ZOOM_PHASES.includes(raw.phase)) return null;
      if (!finite(raw.scale) || raw.scale < ZOOM_MIN || raw.scale > ZOOM_MAX) return null;
      return { ...base, x: raw.x, y: raw.y, scale: raw.scale, phase: raw.phase };
    }
    case 'blocked': {
      if (!finite(raw.x) || !finite(raw.y)) return null;
      return { ...base, x: raw.x, y: raw.y, reason: BLOCKED_REASONS.includes(raw.reason) ? raw.reason : 'timeout' };
    }
    case 'hand': {
      const out = { ...base, present: raw.present === true };
      if (finite(raw.x) && finite(raw.y)) { out.x = raw.x; out.y = raw.y; }
      return out;
    }
    case 'precision': {
      if (!finite(raw.x) || !finite(raw.y)) return null;
      return { ...base, on: raw.on === true, x: raw.x, y: raw.y };
    }
    case 'edge': {
      if (!EDGES.includes(raw.edge) || !EDGE_PHASES.includes(raw.phase)) return null;
      const count = finite(raw.count) ? Math.max(0, Math.floor(raw.count)) : 0;
      // Geçersiz/eksik total → sözleşme varsayılanı (edge_tap_frames=2).
      const total = finite(raw.total) && raw.total >= 1 ? Math.floor(raw.total) : 2;
      const out = { ...base, edge: raw.edge, phase: raw.phase, count, total };
      if (typeof raw.display === 'string' && raw.display.trim()) out.display = raw.display.trim().slice(0, 32);
      // HAND-BUG-03 — `display` ROTALAMA kimliğidir (hangi overlay penceresi giriş
      // animasyonunu oynar); çipte yazılan SIRA ondan ayrıdır: OS ekran kimlikleri
      // (macOS'ta 1, 3, …) kullanıcı için anlamsızdır, "→ Ekran 2" 1-tabanlı sıradır.
      if (finite(raw.displayIndex) && raw.displayIndex >= 1) out.displayIndex = Math.floor(raw.displayIndex);
      return out;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Çoklu ekran — HAND-R1 §5.2: ekran başına BİR pencere.
// ---------------------------------------------------------------------------
/**
 * screen.getAllDisplays() → pencere planı. Pencere bounds = display.bounds
 * (workArea DEĞİL: overlay menü çubuğu/dock üstünde de çizer — kenar bandı
 * durum 19'un kenarı ekranın GERÇEK kenarıdır).
 */
function planWindows(displays) {
  if (!Array.isArray(displays)) return [];
  const out = [];
  for (const d of displays) {
    if (!d || !d.bounds) continue;
    const { x, y, width, height } = d.bounds;
    if (!finite(x) || !finite(y) || !finite(width) || !finite(height) || width <= 0 || height <= 0) continue;
    out.push({
      displayId: String(d.id),
      bounds: { x, y, width, height },
      scaleFactor: finite(d.scaleFactor) && d.scaleFactor > 0 ? d.scaleFactor : 1,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Kare akışı nöbeti — görev kartı madde 4: akış koparsa katman kendini kapatır.
// ---------------------------------------------------------------------------
// Eşik sözleşmesi: telemetry_hz=30 → sağlıklı akışta kareler ~33 ms arayla
// gelir; el kadrajda olmasa bile kaynak `hand present:false` kalp atışı yollar.
// lost_grace_s (150 ms) EL kaybı içindir, AKIŞ kaybı değil — akış için tavan
// 2000 ms = lostChipDelayMs ile aynı sabır (o eşikte kullanıcıya zaten "El
// görünmüyor" denmiş olurdu; kaynak da öldüyse katmanın ekranda işi kalmaz).
const FEED_TIMEOUT_MS = 2000;
const WATCHDOG_TICK_MS = 500;

/**
 * { action: 'keep' | 'close' } — main'in bekçi zamanlayıcısı her tikte sorar.
 * lastFeedAt=null → hiç kare gelmedi; pencere zaten feed ile açılır, close döner.
 */
function feedVerdict(lastFeedAt, now) {
  if (!finite(lastFeedAt) || !finite(now)) return { action: 'close', reason: 'no-feed' };
  if (now - lastFeedAt > FEED_TIMEOUT_MS) return { action: 'close', reason: 'feed-timeout' };
  return { action: 'keep' };
}

// ---------------------------------------------------------------------------
// Ayarlar — bu anahtarların SAHİBİ HAND-A1 kartıdır.
// ---------------------------------------------------------------------------
// Yoğunluk: R2 §1.3 "üç yoğunluk (hafif/normal/yoğun)" — anahtar İngilizce,
// etiket sözlükte (i18n). STATES.density dizilimiyle sıra birebir: 0=light,
// 1=normal, 2=dense.
const DENSITIES = Object.freeze(['light', 'normal', 'dense']);
const DEFAULT_HAND_CONTROL = Object.freeze({
  overlay: Object.freeze({
    enabled: true, // Eren kararı 31.08: overlay varsayılan AÇIK
    density: 'normal',
  }),
  // HAND-BUG-01 — KAMERA CİHAZI. Varsayılan null = "sen seç" (politika karar
  // verir: electron/handCameraPolicy.cjs). Dolu olması kullanıcının AÇIK
  // seçimidir ve politikayı EZER. `label` de saklanır çünkü Chromium'un
  // deviceId'si köken/tuz değişince yeniden üretilir — o gün seçim etiketten
  // kurtarılır, yoksa kullanıcı sessizce varsayılana geri düşerdi.
  camera: Object.freeze({ deviceId: null, label: null }),
  // HAND-G1 — pinch-zoom. `modifier`: ⌘ (varsayılan, tarayıcı/editör/Önizleme
  // zoom'u) ya da ⌃ (macOS Erişilebilirlik → Yakınlaştırma, SİSTEM GENELİ —
  // kullanıcının o ayarı açmış olması gerekir; tasarım §4.3 yol C).
  // `twoHand`: Eren'in istediği jest — iki el de "tutma" pozunda, eller
  // uzaklaşınca büyüt/yaklaşınca küçült (trackpad pinch'inin iki-el karşılığı).
  // `oneHand`: tek elle yumruk+açıklık zoom'u — KAPALI, çünkü iki-el jestiyle
  // aynı el şeklini kullanıyor ve yanlış tetikliyor (Z1 ölçümü).
  zoom: Object.freeze({ enabled: true, modifier: 'command', twoHand: true, oneHand: false }),
  // HAND-G4 — AYAR KLİNİĞİ EŞİKLERİ. Değerler `handClickFsm.defaultConfig()` ile
  // BİREBİR aynı: `null` = "kullanıcı dokunmadı, motorun kendi varsayılanı
  // geçerli" demektir; buradaki sayılar yalnız arayüzün gösterdiği TABANDIR.
  // Kullanıcı bir eşiği değiştirdiğinde motor onu alır (ayar kazanır), "Varsayılana
  // dön" o alanı tekrar null yapar — iki gerçek olmasın diye sayı KOPYALANMAZ.
  //
  // NEDEN BU DÖRT ALAN: ikisi kanal kapısı (zoomBackMax/Min — hangi poz zoom
  // hangi poz tık), ikisi pinch histerezisi (enter/release). "Benim elimde
  // çalışmıyor" şikâyetlerinin ölçülen kaynağı bunlar (tasarım §7).
  tuning: Object.freeze({ zoomBackMax: null, zoomBackMin: null, enter: null, release: null }),
});

/** HAND-G4 — eşiklerin KABUL ARALIĞI. Aralık dışı değer sessizce kırpılmaz,
 *  REDDEDİLİR (null'a düşer): kullanıcı ne yazdığını görsün, motor çöp almasın. */
const TUNING_RANGE = Object.freeze({
  zoomBackMax: [0.5, 2.5],
  zoomBackMin: [0.5, 2.5],
  enter: [0.02, 0.5],
  release: [0.05, 0.9],
});

const ZOOM_MODIFIER_NAMES = Object.freeze(['command', 'control']);

const MAX_DEVICE_ID = 256; // Chromium deviceId 64 hex; tavan kirli girdi içindir
const MAX_DEVICE_LABEL = 200;

/** Serbest metni ayara almadan önce buda: tip + uzunluk + boşluk. */
function cleanDeviceField(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, max);
}

/** Kapalı-liste nöbeti: bilinmeyen alan/değer → varsayılan. Asla fırlatmaz. */
function sanitizeHandControl(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const ov = src.overlay && typeof src.overlay === 'object' ? src.overlay : {};
  const cam = src.camera && typeof src.camera === 'object' ? src.camera : {};
  const zm = src.zoom && typeof src.zoom === 'object' ? src.zoom : {};
  return {
    overlay: {
      enabled: typeof ov.enabled === 'boolean' ? ov.enabled : DEFAULT_HAND_CONTROL.overlay.enabled,
      density: DENSITIES.includes(ov.density) ? ov.density : DEFAULT_HAND_CONTROL.overlay.density,
    },
    camera: {
      deviceId: cleanDeviceField(cam.deviceId, MAX_DEVICE_ID),
      label: cleanDeviceField(cam.label, MAX_DEVICE_LABEL),
    },
    zoom: {
      enabled: typeof zm.enabled === 'boolean' ? zm.enabled : DEFAULT_HAND_CONTROL.zoom.enabled,
      modifier: ZOOM_MODIFIER_NAMES.includes(zm.modifier) ? zm.modifier : DEFAULT_HAND_CONTROL.zoom.modifier,
      twoHand: typeof zm.twoHand === 'boolean' ? zm.twoHand : DEFAULT_HAND_CONTROL.zoom.twoHand,
      oneHand: typeof zm.oneHand === 'boolean' ? zm.oneHand : DEFAULT_HAND_CONTROL.zoom.oneHand,
    },
    tuning: sanitizeTuning(src.tuning),
  };
}

/** Eşik bloğu: sayı + aralık nöbeti. Geçersiz/eksik → null ("motorun kendi
 *  varsayılanı"). Tutarlılık kapısı: `zoomBackMax` `zoomBackMin`i GEÇEMEZ,
 *  `enter` `release`i geçemez — geçerse İKİSİ de null'a döner (yarım uygulanan
 *  bir eşik çifti, hiç uygulanmamış olmasından daha kötüdür: ölü bant ters döner). */
function sanitizeTuning(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { zoomBackMax: null, zoomBackMin: null, enter: null, release: null };
  for (const key of Object.keys(out)) {
    const v = src[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const [lo, hi] = TUNING_RANGE[key];
    if (v < lo || v > hi) continue;
    out[key] = v;
  }
  if (out.zoomBackMax !== null && out.zoomBackMin !== null && out.zoomBackMax >= out.zoomBackMin) {
    out.zoomBackMax = null;
    out.zoomBackMin = null;
  }
  if (out.enter !== null && out.release !== null && out.enter >= out.release) {
    out.enter = null;
    out.release = null;
  }
  return out;
}

module.exports = {
  J,
  VISUAL,
  EVENT_TYPES,
  CLICK_BUTTONS,
  DRAG_PHASES,
  SCROLL_DIRS,
  EDGES,
  EDGE_PHASES,
  DENSITIES,
  TUNING_RANGE,
  ZOOM_PHASES,
  ZOOM_MODIFIER_NAMES,
  DEFAULT_HAND_CONTROL,
  FEED_TIMEOUT_MS,
  WATCHDOG_TICK_MS,
  normalizeEvent,
  planWindows,
  feedVerdict,
  sanitizeHandControl,
};
