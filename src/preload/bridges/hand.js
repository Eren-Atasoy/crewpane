'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('handOverlayApi', {
  /** Tespit kaynağı → main: telemetri olay(lar)ı. Katman kapalıysa (ayar açıkken) açar. */
  feed: (events) => ipcRenderer.invoke('handOverlay:feed', events),
  /** OVERLAY penceresi mount'ta: hangi ekran, hangi yoğunluk. */
  init: () => ipcRenderer.invoke('handOverlay:init'),
  isOpen: () => ipcRenderer.invoke('handOverlay:isOpen'),
  close: () => ipcRenderer.invoke('handOverlay:close'),
  /** OVERLAY penceresi → main: çizim bedeli (ms/kare) — log + rapor için. */
  cost: (payload) => ipcRenderer.invoke('handOverlay:cost', payload),
  /** e2e/kanıt: pencerelerin gerçek bayrakları (alwaysOnTop/bounds/görünürlük). */
  debug: () => ipcRenderer.invoke('handOverlay:debug'),
  /** OVERLAY penceresi: telemetri olayları geldi. Returns unsubscribe. */
  onEvents: (cb) => {
    const l = (_e, events) => cb(events);
    ipcRenderer.on('handOverlay:events', l);
    return () => ipcRenderer.removeListener('handOverlay:events', l);
  },
  /** OVERLAY penceresi: ayar (yoğunluk) canlı değişti. Returns unsubscribe. */
  onConfig: (cb) => {
    const l = (_e, overlay) => cb(overlay);
    ipcRenderer.on('handOverlay:config', l);
    return () => ipcRenderer.removeListener('handOverlay:config', l);
  },
});

// HAND-A2 — EL KONTROLÜ köprüleri. İki ayrı yüzey:
// (1) handDetectApi — YALNIZ gizli tespit penceresi kullanır (main sender'ı
//     doğrular; başka pencereden gelen kare işlenmez). Kamera KARESİ geçmez,
//     yalnız 21 landmark sayısı + zaman damgası.
// (2) handControlApi — arayüz pencereleri: başlat/durdur/rozet durumu.

contextBridge.exposeInMainWorld('handDetectApi', {
  /** Sayfa ısınmayı bitirdi (kamerasız): { ms, delegate }. */
  ready: (info) => ipcRenderer.invoke('handDetect:ready', info),
  /** 30 Hz tespit karesi: { t, hand, landmarks:[{x,y}×21], hands:[[{x,y}×21]×n] }
   *  — fire-and-forget. `hands` HAND-G1 iki-el zoom girdisi; `landmarks` tek-el
   *  yolu için KALIR. Yük BÜTÜN olarak geçer (alan beyaz listesi YOK) — yeni
   *  alan burada düşmez, şekil nöbeti main'de (handControlCore/onFrame). */
  frame: (payload) => ipcRenderer.send('handDetect:frame', payload),
  /** HAND-BUG-01 — cihaz seçim planı: sayfa enumerateDevices() sonucunu (+ varsa
   *  ölçtüğü kare istatistiklerini) verir, main SIRALI aday listesini döndürür.
   *  Karar main'de (handCameraPolicy) — sayfa yalnız uygular. */
  plan: (payload) => ipcRenderer.invoke('handDetect:plan', payload),
  /** Kamera yaşam döngüsü: { status: 'started'|'stopped'|'blank'|'error',
   *  label?, deviceId?, kind?, dead?, deadReason?, stats?, error? }. */
  camera: (info) => ipcRenderer.invoke('handDetect:camera', info),
  /** main → sayfa komutları: { cmd: 'start-camera'|'stop-camera' }. */
  onCommand: (cb) => {
    const l = (_e, msg) => cb(msg);
    ipcRenderer.on('handDetect:command', l);
    return () => ipcRenderer.removeListener('handDetect:command', l);
  },
});


contextBridge.exposeInMainWorld('handControlApi', {
  start: () => ipcRenderer.invoke('handControl:start'),
  stop: () => ipcRenderer.invoke('handControl:stop'),
  status: () => ipcRenderer.invoke('handControl:status'),
  /** HAND-BUG-01 — rozetteki cihaz seçici. { deviceId, label } ya da null
   *  (null = otomatik seçime dön). Seçim KALICI ayara yazılır. */
  selectCamera: (sel) => ipcRenderer.invoke('handControl:selectCamera', sel),
  /** Rozet canlı durumu (her faz değişiminde yayınlanır). Returns unsubscribe. */
  onStatus: (cb) => {
    const l = (_e, st) => cb(st);
    ipcRenderer.on('handControl:status', l);
    return () => ipcRenderer.removeListener('handControl:status', l);
  },
  // ── HAND-G4 — AYAR KLİNİĞİ (poz örnekleyici + kanyon) ─────────────────────
  /** `{ms?, label?}` → süre dolunca `{ok, frames, fps, metrics:{ad:{min,med,max,n}}}`.
   *  Kamera karesi ya da landmark DÖNMEZ — yalnız kapı metriklerinin özeti. */
  samplePose: (opts) => ipcRenderer.invoke('handControl:samplePose', opts || {}),
  /** İki özet → metrik metrik bantlar + kanyonlar + önerilen kesim. */
  compareSamples: (a, b) => ipcRenderer.invoke('handControl:compareSamples', { a, b }),

  // ── HAND-G2 — UYGULAMA İÇİ ZOOM ────────────────────────────────────────────
  // Beyaz liste KAPIDIR: bu iki satır olmadan zoom sessizce ölür ve kullanıcı
  // hatayı göremez ([[preload-whitelist-is-a-gate]]).
  /** Öndeki sekmenin zoom yüzeyi: 'office' | 'terminal' | null (yüzey yok).
   *  main hangi sekmenin önde olduğunu bilemez — pencere kendi bildirir. */
  reportZoomSurface: (surface) => ipcRenderer.invoke('handControl:zoomSurface', surface),
  /** main → pencere zoom yükü: { phase, surface, scale, delta, x, y }.
   *  Yalnız CrewPane ÖNDEYKEN gelir; değilken zoom OS'a iner (HAND-G1). */
  onZoom: (cb) => {
    const l = (_e, payload) => cb(payload);
    ipcRenderer.on('handControl:zoom', l);
    return () => ipcRenderer.removeListener('handControl:zoom', l);
  },
});
