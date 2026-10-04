'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('popoutApi', {
  /** Pane'i ayrı pencereye çıkar. `{ paneId, title?, agentId? }` → { ok, paneId } | { ok:false, error }. */
  open: (payload) => ipcRenderer.invoke('popout:open', payload),
  /** Pop-out penceresini kapat = pane eski hücresine döner. → { ok } | { ok:false, error }. */
  close: (paneId) => ipcRenderer.invoke('popout:close', paneId),
  /** Şu an dışarıda olan paneId'ler (reload sonrası durum hidrasyonu). → string[]. */
  list: () => ipcRenderer.invoke('popout:list'),
  /** Pop-out penceresi kapandı (kullanıcı ⌘W/kırmızı düğme/"Geri koy"). cb gets { paneId }. Returns unsubscribe. */
  onClosed: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('popout:closed', listener);
    return () => ipcRenderer.removeListener('popout:closed', listener);
  },
  /** ADP-712 — pencereyi büyüt/eski boyutuna getir (ızgaradaki "zoom"un karşılığı). */
  toggleMaximize: (paneId) => ipcRenderer.invoke('popout:toggleMaximize', paneId),
  /** ADP-712 — pencerenin şu anki durumu → { paneId, maximized } | null. */
  state: (paneId) => ipcRenderer.invoke('popout:state', paneId),
  /** ADP-712 — pencere native düğmeyle büyütüldü/küçültüldü. cb gets { paneId, maximized }. */
  onState: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('popout:state', listener);
    return () => ipcRenderer.removeListener('popout:state', listener);
  },
});

// AUID-KABLO — TASARIM TURU PENCERESİ köprüsü. `popoutApi` ile aynı desen ama
// pane/pty BAĞI YOK: tasarım penceresi kendi başına bir yüzeydir (`/design`).
// Tekillik kararı MAIN'de: ikinci `openWindow()` yeni pencere doğurmaz, var olanı
// öne getirir ve `reused:true` döner — renderer bunu tahmin etmez, ÖLÇER.
// DEMO-04 — TANITIM TURUNUN ÖRNEK SİTESİ. Sayfa kurulumla gelir ve `file:`
// şemasıyla gömülü tarayıcıda açılır; adresi YALNIZ main bilir (paketli yol
// `process.resourcesPath` altındadır, renderer'da böyle bir bilgi yok).
// Salt-okunur bir SORU: renderer yol vermez, yalnız dil seçer.

contextBridge.exposeInMainWorld('feedbackApi', {
  /** → { ok, text, lines } | { ok:false, reason:'no-log'|'unreadable' } */
  logExcerpt: (opts) => ipcRenderer.invoke('feedback:logExcerpt', opts || {}),
  /** → { ok, shots:[{name, at, bytes, thumbDataUrl}] } | { ok:false, reason:'no-dir' } */
  recentShots: (opts) => ipcRenderer.invoke('feedback:recentShots', opts || {}),
  /** → { ok, name, dataUrl, sha256, width, height } | { ok:false, reason } */
  shotPreview: (opts) => ipcRenderer.invoke('feedback:shotPreview', opts || {}),
});

// ADP-736 — YEREL sprite kütüphanesi köprüsü. Pakete tek/güvenli set girer; kişisel
// (telifli olabilen) avatarlar `~/.crewpane/sprites/<key>/48x48.png`ten OKUNUR —
// uygulama silinip yeniden kurulsa bile kalırlar ve DMG'ye hiç girmezler.
// Salt-okunur tek kanal: main tarafı key'i doğrular, PNG imzasını kontrol eder ve
// data-URI döner (renderer'a fs açılmaz).

contextBridge.exposeInMainWorld('localSpriteApi', {
  /** → { ok, dir, sprites:[{key,url48,url16,bytes}] } */
  list: () => ipcRenderer.invoke('sprites:listLocal'),

  /**
   * AVATAR-PACK-01 — Yüklü PAKETLER (manifest + lisans + karakterler + eksikler).
   * `list` ile aynı diski okur ama başka soruyu yanıtlar: `list` "hangi sprite
   * anahtarları çizilebilir", bu ise "hangi paket kurulu ve neyi vaat ediyor".
   * → { ok, dir, packages:[{key,manifest,characters,missing}], skipped }
   */
  listPackages: () => ipcRenderer.invoke('sprites:listPackages'),

  /** ADP-737 — Paket yükle (zip dosyası). → { ok, key?, manifest?, warnings?, error? } */
  installPackage: (zipPath) => ipcRenderer.invoke('sprites:installPackage', zipPath),

  /** ADP-737 — Paketi kaldır (key). → { ok, error? } */
  removePackage: (key) => ipcRenderer.invoke('sprites:removePackage', key),

  /** ADP-737 — Paketi dışa aktar (karakterleri zip'le). → { ok, path?, error? } */
  exportPackage: (keys) => ipcRenderer.invoke('sprites:exportPackage', keys),
});

// STARTER-OFFICE-01 — OFİS PAKETİ köprüsü (.crewpane-office.zip).
// İki uç, ikisi de DAR: `exportPack` renderer'ın ÜRETTİĞİ+TEMİZLEDİĞİ paket
// nesnesini diske yazar; `readPack` bir zip'i açıp manifest + skill gövdelerini
// döner. Kurulum bu köprüden GEÇMEZ — o iş renderer'da `installPreset`indir
// (kurulum sözleşmesinin ikinci bir kopyası doğmasın).

contextBridge.exposeInMainWorld('feedbackSeenApi', {
  get: () => ipcRenderer.sendSync('feedback:seen:get'),
  set: (state) => ipcRenderer.invoke('feedback:seen:set', state),
});

// ADP-206 — editor code-intelligence: git diff (committed vs working tree) + workspace
// file list (⌘P quick-open) + content grep (⌘⇧F). Read-only; main shells out to `git`.

contextBridge.exposeInMainWorld('resourceApi', {
  /** → { ok, state } — state: { level, freePct, reasons, waiting[], settings, … }. */
  state: () => ipcRenderer.invoke('resource:state'),
  /** "Yine de aç": kullanıcı HER ZAMAN açabilir. Onay süre-kutulu (ms; boş → varsayılan). */
  allowAnyway: (ms) => ipcRenderer.invoke('resource:allowAnyway', ms),
  /** Ayarlar: { enabled?, warnFreePct?, criticalFreePct? } → { ok, state }. Diske yazılır. */
  configure: (patch) => ipcRenderer.invoke('resource:configure', patch),
  /** Bitmiş (terminal + >15 dk sessiz) pane'ler. `department` verilirse yalnız o takım. */
  finishedPanes: (opts) => ipcRenderer.invoke('resource:finishedPanes', opts || {}),
  /** ONAYLI kapatma — main her paneId'yi yeniden ölçer (canlanan pane öldürülmez). */
  closeFinished: (paneIds) => ipcRenderer.invoke('resource:closeFinished', { paneIds }),
  /** Baskı seviyesi ya da bekleme kuyruğu değişince push. Dönen fonksiyon aboneliği bırakır. */
  onPressure: (cb) => {
    const l = (_e, state) => cb(state);
    ipcRenderer.on('resource:pressure', l);
    return () => ipcRenderer.removeListener('resource:pressure', l);
  },
});

// ADP-298 — Raporlar canlı yenileme: main rapor dizinlerini izler, değişince olay atar.
// Renderer poll ETMEZ; olayı yalnız sekme görünürken listeye çevirir (ADP-284 disiplini).

contextBridge.exposeInMainWorld('reportsApi', {
  /** cb: ({ at }) => void — abonelikten çıkmak için dönen fonksiyonu çağır. */
  onChanged: (cb) => {
    const l = (_e, payload) => cb(payload || { at: Date.now() });
    ipcRenderer.on('reports:changed', l);
    return () => ipcRenderer.removeListener('reports:changed', l);
  },
});

// ADP-844 — bildirimler yalnız ekranda (zil + toast) ve mobil uygulamada yaşar;
// renderer'a dış mesajlaşma servisi açan HİÇBİR köprü yoktur.

// ADP-242 — uzun-sprint kalıcılığı: run durumu her transition'da main'e iner
// (sprintStore atomik yazar); rehydrate list+load ile başlar. Path'i main kurar.
// QUEUE-PERSIST — meşgul-kuyruğu + paused-delegasyon kalıcılığı (delegationRunner
// her kuyruk/pause değişiminde durumu main'e indirir; rehydrate boot'ta load eder).
