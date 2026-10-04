'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('demoSiteApi', {
  /** Örnek sitenin adresi. → { ok:true, url } | { ok:false } (dosya pakette yoksa). */
  url: (lang) => ipcRenderer.invoke('demo:siteUrl', { lang }),
});


contextBridge.exposeInMainWorld('workerNotifyApi', {
  emit: (evt) => ipcRenderer.invoke('notify:workerEvent', evt),
});


contextBridge.exposeInMainWorld('windowApi', {
  /** Switch the tmux session's active window to the team that owns `department`. */
  selectForDepartment: (department) => ipcRenderer.invoke('tmux:selectWindow', department),
});

// ADP-139 (DOGFOOD Engel #2) — self-host dev affordances. `info()` lets the
// renderer show the right control (HMR badge in dev vs a one-click Rebuild button
// in prod-from-source). `rebuildRelaunch()` runs the FIXED build script in main and
// relaunches the app; `onRebuildProgress` streams its log lines for a spinner.

contextBridge.exposeInMainWorld('appApi', {
  /** → { mode:'dev'|'prod'|'spike', packaged, rebuildSupported }. */
  info: () => ipcRenderer.invoke('app:info'),
  /** One-click rebuild (electron:build:prep) + relaunch. → { ok, started } | { ok:false, reason }. */
  rebuildRelaunch: () => ipcRenderer.invoke('app:rebuildRelaunch'),
  /** ADP-232 — plain relaunch (NO rebuild) to apply restart-gated settings (workspaceRoot). → { ok }. */
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  /** Subscribe to rebuild progress. cb gets { phase:'start'|'log'|'done'|'error', line }. Returns unsubscribe. */
  onRebuildProgress: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('app:rebuild:progress', l);
    return () => ipcRenderer.removeListener('app:rebuild:progress', l);
  },
  /** ADP-284 — pencere görünürlüğü (minimize/hide → false). Canvas render kapıları için; returns unsubscribe. */
  onWindowVisible: (cb) => {
    const l = (_e, visible) => cb(!!visible);
    ipcRenderer.on('app:window-visible', l);
    return () => ipcRenderer.removeListener('app:window-visible', l);
  },
  /**
   * ADP-901 — RENDERER MODÜL HATASI → uygulama günlüğü + bildirim merkezi.
   * ADP-335 sınırı yalnız MAIN'deki modülleri kapsıyordu; ofis tuvali öldüğünde
   * (GL bağlam kaybı) uygulamanın gününde TEK BİR İZ kalmıyordu — teşhis, olayın
   * kendisinden değil ekran görüntüsünden başlamak zorunda kaldı. Artık renderer
   * de aynı deftere yazar. `{ label, message, location?, stopped? }`.
   */
  reportFault: (fault) => ipcRenderer.invoke('module:reportRenderer', fault),
  /**
   * OBS-01 — ÜRÜN ANALİTİĞİ: "hangi panel/sekme kullanılıyor".
   * Gövde `{ event:'panel_view', panel:'<dock sekme kimliği>' }` ile SINIRLI —
   * main tarafı olay adını ve panel kimliğini kapalı kümeye indirir, ortak damgayı
   * (sürüm/platform/katman) kendisi ekler. Serbest metin taşıyan bir alan YOK.
   */
  track: (payload) => ipcRenderer.invoke('analytics:track', payload),
  // HATA-06 — kurtarma merdiveninin KABUK basamakları (sayfa-içi yol yetmediğinde).
  // Renderer PARAMETRE GEÇİREMEZ: yalnız kapalı bir eylem adı gönderir; hangi
  // pencerenin yenileneceğine/yaratılacağına main karar verir (capability modeli).
  officeRecover: (action) => ipcRenderer.invoke('office:recover', { action }),
});

// TOUR-02-A — "İlk 10 Dakika" görev günlüğünün KALICILIĞI.
// Köprü İKİ ham kaydı verir (yerel dosya + taşınabilir tercih projeksiyonu) ve
// birleşmiş kaydı geri alır: LWW kuralı renderer'da TEK yerde yaşar
// (src/app/lib/onboardingQuests.ts `mergeProgress`, birim testli). Burada
// taşınacak bir SIR yok — gövde yalnız madde numaraları, damgalar ve üç boolean.

contextBridge.exposeInMainWorld('onboardingApi', {
  /** → { ok, local: kayıt|null, portable: kayıt|null } */
  load: () => ipcRenderer.invoke('onboarding:load'),
  /** → { ok, local, portable, error } */
  save: (progress) => ipcRenderer.invoke('onboarding:save', progress),
  // TOUR-02-C — bağlamsal ipuçları AYNI köprüde, AYRI kayıt: "hangi ipucu
  // gösterildi" ile "hangi görev bitti" iki farklı şemadır ve tek dosyada
  // birleştirilseydi biri diğerinin bilinmeyen alanını düşürürdü.
  /** → { ok, local: kayıt|null, portable: kayıt|null } */
  loadTips: () => ipcRenderer.invoke('onboarding:tips:load'),
  /** → { ok, local, portable, error } */
  saveTips: (tips) => ipcRenderer.invoke('onboarding:tips:save', tips),
});

// B-01 (GIT-BACKBONE-SPEC §2.10) — GÖREV ↔ BRANCH ↔ MERGE yüzeyi. B-02/B-03'ün
// kart UI'sı bunu tüketir. Renderer YALNIZ görev kimliği ve onay verir; branch adı,
// worktree yolu ve merge hedefi main'de görev kaydından türer (G-1) — bu köprüde
// bilerek "yol ver / dal ver" parametresi YOKTUR.

contextBridge.exposeInMainWorld('presetAdvisorApi', {
  recommend: (payload) => ipcRenderer.invoke('presets:recommend', payload),
});
