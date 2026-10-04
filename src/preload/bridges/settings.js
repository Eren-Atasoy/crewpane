'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('projectConfigApi', {
  /** → { ok, workspaceRoot, projects:[{slug, isolation, defaultBranch, repoPath, repoSource}] } */
  get: (slugs) => ipcRenderer.invoke('project:config:get', { slugs }),
  /** { slug, isolation:'worktree'|'off', defaultBranch? } → { ok, persisted, branchSaved, repoPath, why } */
  set: (input) => ipcRenderer.invoke('project:config:set', input),
});

// CIDX-1 — KOD İNDEKSİ (proje başına aç/kapa, VARSAYILAN KAPALI).
//
// Bu köprüden SIR GEÇMEZ ve geçmesi de gerekmez: `codebase-memory-mcp` %100 yereldir,
// bulut/API anahtarı istemez (CODE-INDEX-R1 §6) → integrationsApi'nin "kasa" yarısı
// burada YOKTUR, yalnız enjeksiyon yarısı vardır. Renderer bir YOL da dayatamaz (G-1):
// yalnız proje slug'ı gider; ikilinin ve deponun yolunu main çözer ve GÖSTERMEK için
// döndürür. Anahtar bir sonraki pane'den itibaren geçerlidir (MCP argv spawn anında
// bağlanır) — `set` bunu `restartHint` ile SÖYLER, sessizce bırakmaz.

contextBridge.exposeInMainWorld('settingsApi', {
  /** → { ok, workspaceRoot, resolvedWorkspaceRoot, repoRoot, firstRunRequired, defaultWorkspaceDir, pushToTalkKey, pushToTalkKeys, wakeModelPath, hasOpenAiKey, mcpServers, theme }. */
  get: () => ipcRenderer.invoke('settings:get'),
  /** Merge-patch + persist. patch = { workspaceRoot?, apiKeys?:{openai?,…}, pushToTalkKey?, wakeModelPath?, mcpServers?, theme?, notifications?, engines?:{<id>:{vendorHosted:'allow'|'block'}} }. */
  set: (patch) => ipcRenderer.invoke('settings:set', patch),
  /**
   * SKL-B3 — ürünün KENDİ API anahtarını (bugün: gemini) GERÇEKTEN sağlayıcıya sorar.
   * Renderer yalnız SERVİS ADINI verir; anahtar bu köprüden hiçbir yönde geçmez.
   * → { ok:true, source, status, count } | { ok:false, reason:'no-key'|'rejected'|
   *    'unreachable'|'unsupported', … }
   */
  verifyAppKey: (service) => ipcRenderer.invoke('appkey:verify', service),
  /**
   * ADP-232-C — ilk-açılış "çalışma alanı seç": { mode:'create'|'pick' }.
   * 'create' önerilen ~/CrewPane'i oluşturur; 'pick' OS klasör dialog'u açar
   * (yol renderer'dan asla gelmez). → { ok, root, restartRequired } | { ok:false, reason }.
   */
  provisionWorkspace: (req) => ipcRenderer.invoke('workspace:provision', req),
  /**
   * ADP-232-B — CANLI çalışma alanı geçişi (yeniden başlatmadan). req:
   *   { mode:'pick' }    → OS klasör dialog'u (yol renderer'dan gelmez),
   *   { mode:'current' } → Ayarlar'ın settings.workspaceRoot'a yazdığı kökü canlı uygula,
   *   { root:'…' }       → doğrudan yol (Ayarlar input'u; settings:set ile aynı güven sınırı).
   * → { ok, root, previous, changed, grandfathered[] } | { ok:false, reason }.
   * Açık pane'ler/çalışan işler ESKİ kökte kalır; yeni işler yeni kökte açılır.
   */
  switchWorkspace: (req) => ipcRenderer.invoke('workspace:switch', req),
  /**
   * ADP-737 — TAKIM KAPSAMI KAPISI (renderer ucu). Delegasyon yolunda her worker'ın
   * KENDİ takımı için sorulur: hedef takım liderin takımı değilse main sahibe onay
   * kartı çıkarır ve cevabı bekler. Karar renderer'da ASLA verilmez — burada yalnız
   * sorulur (`{action:'delegate'|'manage', leaderId, targetScope}` → `{ok, code?, reason?}`).
   */
  authorizeTeamScope: (req) => ipcRenderer.invoke('teamScope:authorize', req),
  /**
   * ADP-888 — ARAYÜZ DİLİ canlı değişince main push eder: cb({ locale, preference }).
   * Route değişmez, ağaç yeniden render olur → açık pane/terminal durumu KORUNUR.
   * Returns unsubscribe.
   */
  onLocaleChanged: (cb) => {
    const l = (_e, payload) => cb(payload || {});
    ipcRenderer.on('app:locale-changed', l);
    return () => ipcRenderer.removeListener('app:locale-changed', l);
  },
  /** ADP-232-B — kök CANLI değişince main push eder: cb({ root, previous, grandfathered[], at }). Returns unsubscribe. */
  onWorkspaceChanged: (cb) => {
    const l = (_e, payload) => cb(payload || {});
    ipcRenderer.on('workspace:changed', l);
    return () => ipcRenderer.removeListener('workspace:changed', l);
  },
});

// ADP-533/ADP-553 — güncelleme köprüsü. İndirme URL'i/parametresi renderer'dan ASLA
// gelmez (capability modeli). İki mod: 'updater' (imzalı build — uygulama içinde
// indir + kullanıcı onayıyla kur) ve 'notify' (Faz 1 fallback — tarayıcıda indir).

contextBridge.exposeInMainWorld('updateApi', {
  /** → { checked, updateAvailable, latestVersion, currentVersion, lastCheckedAt, autoCheck, dismissed, downloadUrl, mode, phase, progressPercent }. */
  get: () => ipcRenderer.invoke('update:get'),
  /** Manuel kontrol (Ayarlar "Şimdi kontrol et"; toggle'dan bağımsız koşar). → aynı durum nesnesi. */
  checkNow: () => ipcRenderer.invoke('update:checkNow'),
  /** updater modu: uygulama içinde indir (progress push'ları gelir); notify modu: tarayıcıda SABİT DMG URL'i. */
  download: () => ipcRenderer.invoke('update:download'),
  /** ADP-553 — İNDİRİLMİŞ güncellemeyi kullanıcı onayıyla kur (yeniden başlatır). phase!=='downloaded' → no-op. */
  install: () => ipcRenderer.invoke('update:install'),
  /** "Bu sürüm için sonra" — sürüm-bazlı kalıcı dismiss (settings.json). → durum. */
  dismiss: () => ipcRenderer.invoke('update:dismiss'),
  /** Main durum push'u (kontrol sonucu/dismiss) → rozet CANLI güncellenir. Returns unsubscribe. */
  onState: (cb) => {
    const l = (_e, s) => cb(s);
    ipcRenderer.on('update:state', l);
    return () => ipcRenderer.removeListener('update:state', l);
  },
});

// ADP-675 — uygulama-içi DUYURU köprüsü. Renderer yalnız duyuru ID'si gönderir;
// aksiyonun adresini MAIN kendi normalize kopyasından çözer ve https'i doğrular
// (updateApi ile aynı capability modeli — ele geçmiş renderer site açtıramaz).

contextBridge.exposeInMainWorld('announceApi', {
  /** → { checked, fromCache, lastCheckedAt, currentVersion, items:[{id,level,title,body,action,read,hidden,…}] }. */
  get: () => ipcRenderer.invoke('announce:get'),
  /** Feed'i şimdi çek (Ayarlar/geliştirici tetiği). → aynı durum nesnesi. */
  checkNow: () => ipcRenderer.invoke('announce:checkNow'),
  /** "Okudum" — KALICI (settings.json); bir daha şerit çıkmaz. → durum. */
  markRead: (id) => ipcRenderer.invoke('announce:markRead', id),
  /** Şeridin ✕'i — OTURUMLUK gizleme (diske yazılmaz, yeniden açılışta geri gelir). */
  hide: (id) => ipcRenderer.invoke('announce:hide', id),
  /** Aksiyon düğmesi: adresi MAIN çözer + https doğrular + shell.openExternal. */
  openAction: (id) => ipcRenderer.invoke('announce:openAction', id),
  /** Gövde içi link: main adresin O duyurunun gövdesinde GERÇEKTEN geçtiğini doğrular. */
  openLink: (id, url) => ipcRenderer.invoke('announce:openLink', id, url),
  /** Main durum push'u (yeni feed / okundu) → UI CANLI güncellenir. Returns unsubscribe. */
  onState: (cb) => {
    const l = (_e, s) => cb(s);
    ipcRenderer.on('announce:state', l);
    return () => ipcRenderer.removeListener('announce:state', l);
  },
});

// A-10 — uygulama-içi "Yenilikler" (changelog) köprüsü. Salt-okunur: renderer'dan
// main'e hiçbir ID/adres gitmez (announceApi'nin aksine aksiyon linki yok).

contextBridge.exposeInMainWorld('changelogApi', {
  /** → { checked, fromCache, lastCheckedAt, recentCount, recentWindowDays, items:[{date,category,version,product,url,tr,en}] }. */
  get: () => ipcRenderer.invoke('changelog:get'),
  /** Feed'i şimdi çek (geliştirici tetiği). → aynı durum nesnesi. */
  checkNow: () => ipcRenderer.invoke('changelog:checkNow'),
  /** Sürüm notu linki: main renderer'ın gönderdiği adresi KENDİ kayıt listesiyle doğrular. */
  openUrl: (url) => ipcRenderer.invoke('changelog:openUrl', url),
  /** Main durum push'u (periyodik tazeleme) → UI CANLI güncellenir. Returns unsubscribe. */
  onState: (cb) => {
    const l = (_e, s) => cb(s);
    ipcRenderer.on('changelog:state', l);
    return () => ipcRenderer.removeListener('changelog:state', l);
  },
});

// ADP-390 (ADR-027 / G9) — CrewPane hesabı köprüsü (Ayarlar → Hesap).
// Bu köprüden SIR GEÇMEZ: access/refresh token ve lisans jetonu MAIN'de (safeStorage)
// kalır; renderer yalnız DURUMU görür (e-posta, lisans, seat, aktif ürünler). Giriş
// sistem tarayıcısında açılır — uygulama içinde gömülü login webview'i YASAK (RFC 8252).
const authBridgeObj = {
  /** → { ok, signedIn, email, licenseStatus:'none'|'fresh'|'grace'|'expired'|'invalid', seat, products[], requireSeat }. */
  get: () => ipcRenderer.invoke('crewpane:get'),
  /** Sistem tarayıcısında PKCE girişini başlat → { ok, url }. */
  signIn: () => ipcRenderer.invoke('crewpane:signIn'),
  /**
   * Hesaptan çık (sunucuda revoke + yerel oturum & lisans jetonu silinir).
   *
   * ADP-863 — SEÇENEKLER ARTIK KABLODA TAŞINIR (eskiden hiç iletilmiyordu, bu yüzden
   * `force` yolu arayüzden ERİŞİLEMEZDİ → çalışan pane varken çıkış SESSİZCE reddedilirdi):
   *   `{ probe:true }` → çıkmadan "ne kapanacak" sayıları + onay metni
   *   `{ force:true }` → kullanıcı onay diyaloğunu onayladı, çalışan pane'lere rağmen çık
   */
  signOut: (opts) => ipcRenderer.invoke('crewpane:signOut', opts),
  /** Lisans jetonunu yeniden çek (ağ hatasında cached jeton KORUNUR — offline ≠ kilit). */
  refresh: () => ipcRenderer.invoke('crewpane:refresh'),
  /**
   * SEC-01 — hesaba bağlı cihazlar → { ok, devices:[…], currentDeviceId }.
   * `currentDeviceId` listede "bu cihaz"ı işaretlemek için: kullanıcı oturduğu
   * makineyi yanlışlıkla çıkarmasın.
   */
  devices: () => ipcRenderer.invoke('crewpane:devices'),
  /**
   * SEC-01 — cihazı hesaptan çıkar → { ok, device } | { ok:false, reason }.
   * Cihazdaki hiçbir veri silinmez; yalnız o kurulum yeni lisans jetonu alamaz.
   * Başarıda main lisansı kendiliğinden tazeler (ret çözüldüyse hemen düşsün).
   */
  revokeDevice: (deviceId) => ipcRenderer.invoke('crewpane:deviceRevoke', deviceId),
  /**
   * SEC-02 — DİĞER CİHAZLARI BIRAK → { ok, released } | { ok:false, reason }.
   * `revokeDevice`ten AYRI: koltuğu boşaltır, cihazı hesapta BIRAKIR. Uyuyan ya
   * da çöken bir makine kirasını bırakamadığında kullanıcının kaçış kapısıdır.
   * Başarıda main lisansı kendiliğinden tazeler (ret çözüldüyse hemen düşsün).
   */
  releaseOtherDevices: () => ipcRenderer.invoke('crewpane:deviceReleaseOthers'),
  /** ADP-646 — "Paket al": faturalandırma sayfasını SİSTEM TARAYICISINDA aç → { ok, url }. */
  openBilling: () => ipcRenderer.invoke('crewpane:openBilling'),
  /**
   * ADP-719 — giriş dönüşü (crewpane://) DOĞRU uygulamaya mı geliyor?
   * → { ok, severity:'blocking'|'warn'|null, ownsDefault, conflicts:[{path,bundleId,name}], reason }
   * `{ repair:true }` şema sahipliğini bu uygulamaya geri alır (kullanıcı tıkı).
   */
  schemeHealth: (opts) => ipcRenderer.invoke('crewpane:schemeHealth', opts),
  /**
   * LX-SAFESTORAGE-01 — bu makinede oturum SAKLANABİLİR Mİ?
   * → { ok, measured, available, backend, plaintext, canStore, reasonKey }
   * `canStore:false` ise giriş duvarı kullanıcıya SEBEBİNİ söyler (her açılışta
   * yeniden giriş isteneceğini). SIR TAŞIMAZ: yalnız arka ucun adı + hüküm.
   * `canStore:null` = ölçülemedi ("kapalı" DEĞİL — ADP-721).
   */
  secretBackend: () => ipcRenderer.invoke('crewpane:secretBackend'),
  /**
   * ADP-719 — İKİNCİ GİRİŞ YOLU: deep-link dönmediyse tarayıcının adres
   * çubuğundaki dönüş bağlantısı elle verilir; deep-link ile AYNI yoldan işlenir.
   */
  pasteCallback: (url) => ipcRenderer.invoke('crewpane:pasteCallback', url),
  /** Main durum değişince push eder (giriş/çıkış/jeton) → Ayarlar CANLI güncellenir. */
  onState: (cb) => {
    const l = (_e, s) => cb(s);
    ipcRenderer.on('crewpane:state', l);
    return () => ipcRenderer.removeListener('crewpane:state', l);
  },

  // ── RESET-03 — KURULUMU SIFIRLA ───────────────────────────────────────────
  //
  // 🔴 BEYAZ LİSTE KAPIDIR ([[ref_preload_whitelist_is_a_gate]]) — ve KAPININ
  // İKİ KATI VAR. İlk yazımda bu iki metot AYRI bir `window.resetApi` globaline
  // konmuştu: kanal adları doğruydu, main handler'ı vardı, kanal kapısı YEŞİLDİ
  // — ama RESET-02 köprüyü `window.crewpaneApi` ÜZERİNDE arıyor
  // (`resetFlow.resetApiFrom(crewpaneApi())`) ve bulamayınca "Gelişmiş" bölümünü
  // HİÇ ÇİZMİYOR. Yani özellik sessizce ölüyordu. Kanalın VAR olması yetmez;
  // KARŞI TARAFIN BAKTIĞI YERDE olması gerekir.
  //
  // KARAR BURADA VERİLMEZ. Onay sözcüğünü MAIN karşılaştırır (dil main'de
  // bilinir, renderer'a güvenilmez); bu köprü yalnız kullanıcının yazdığı metni
  // taşır. Yol/hedef alanları main'de DÜŞER (resetGate.sanitizeRequest).
  /**
   * KURU KOŞUM — hiçbir şey silinmez. `{ level }`
   * → { ok, level, bytesTotal:number|null, targets:[{kind,bytes,entries}],
   *     keeps:[{label}], warnings:[string], confirmWord, panes, terminals, agents }
   * `bytesTotal:null` = "hesaplanamadı" (0 DEĞİL).
   */
  resetPlan: (opts) => ipcRenderer.invoke('reset:plan', opts),
  /**
   * SIFIRLAMA İSTEĞİ — { level:'session'|'full', confirmText, keepLogs }.
   * → { ok:true, restarting:true } | { ok:false, reason:'bad_confirm'|'bad_level'|… }
   * Çalışan süreçte hiçbir kullanıcı dosyası silinmez: main işaretçi yazar ve
   * uygulama yeniden başlar; silme yeni sürecin EN BAŞINDA olur (Windows kilidi).
   */
  resetRequest: (req) => ipcRenderer.invoke('reset:request', req),
};
contextBridge.exposeInMainWorld('crewpaneApi', authBridgeObj);


contextBridge.exposeInMainWorld('prefsApi', {
  /** Bu cihazın localStorage tercihlerini projeksiyona bildir. → { ok, changed, dropped } */
  publish: (values) => ipcRenderer.invoke('prefs:publish', { values }),
  /** Projeksiyondaki renderer tercihleri + beyaz liste. → { ok, values, keys, status } */
  pull: () => ipcRenderer.invoke('prefs:pull'),
  /** Ayarlar → Senkron satırının gerçeği. → { ok, exists, keyCount, lastApplied, file } */
  status: () => ipcRenderer.invoke('prefs:status'),
  /**
   * Uzak tercihler UYGULANDI. `applied` = settings.json'a yazılan anahtarlar;
   * renderer ekseni için `pull()` çağrılır (gövde sinyalle taşınmaz — ADP-712).
   */
  onChanged: (cb) => {
    const h = (_e, payload) => { try { cb(payload); } catch { /* dinleyici hatası köprüyü düşürmez */ } };
    ipcRenderer.on('prefs:changed', h);
    return () => ipcRenderer.removeListener('prefs:changed', h);
  },
});

// ADP-243 (ADR-014 Karar 5) — the in-app "Hafıza" (Memory) view reads the file-based
// memory as a node-link graph. Read-only.
// SEARCH-2 (bumblebee) — GENEL ARAMA İNDEKSİ. `memoryApi.search` ile KARIŞTIRMA:
// o hibrit (anlam+kelime) ve yalnız HAFIZAYA bakar; bu salt kelime (FTS5) ama DÖRT
// kaynağa bakar (rapor gövdesi · hafıza · görev · ajan CLI oturumları).
//
// 🔴 BU BEYAZ LİSTE BİR KAPIDIR: burada unutulan bir metot, renderer'da sessizce
// `undefined` olur ve özellik hiçbir hata vermeden ölür (ref: preload beyaz listesi).
