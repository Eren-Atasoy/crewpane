'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentxDraftApi', {
  /** → DraftSnapshot { state, text, units, target, revision, pending, notice, … } */
  get: () => ipcRenderer.invoke('agentxDraft:get'),
  /** RouteDecision (cls:'prompt') → taslağı aç / gövdeyi ekle. */
  open: (route, at) => ipcRenderer.invoke('agentxDraft:open', { route, at }),
  /** Sonlandırılmış cümle. `startedAt` = KAYDIN başladığı an (spokenAt kapısı buna bakar). */
  hear: (text, opts) => ipcRenderer.invoke('agentxDraft:hear', { text, ...(opts || {}) }),
  /** Klavye: metnin tamamı (ses ve klavye AYNI defter). */
  edit: (text) => ipcRenderer.invoke('agentxDraft:edit', { text }),
  setTarget: (target) => ipcRenderer.invoke('agentxDraft:setTarget', { target }),
  /** Sessizlik: taslak DURAKSAR — asla göndermez. */
  pause: (at) => ipcRenderer.invoke('agentxDraft:pause', { at }),
  noSpeech: (at) => ipcRenderer.invoke('agentxDraft:noSpeech', { at }),
  /** Gönder düğmesi / kapanış sözü → hedef sorusu ya da teyit. */
  finish: (at) => ipcRenderer.invoke('agentxDraft:finish', { at }),
  /** TTS özeti BİTTİ: bundan önce başlayan kayıt cevap sayılmaz. */
  spoken: (id, at) => ipcRenderer.invoke('agentxDraft:spoken', { id, at }),
  /** Düğme: 'send' | 'edit' | 'cancel'. */
  resolve: (id, choice, at) => ipcRenderer.invoke('agentxDraft:resolve', { id, choice, at }),
  cancel: (at) => ipcRenderer.invoke('agentxDraft:cancel', { at }),
  undo: (at) => ipcRenderer.invoke('agentxDraft:undo', { at }),
  tick: (at) => ipcRenderer.invoke('agentxDraft:tick', { at }),
  /** Fotoğraf değişti (her yüzey). cb: DraftSnapshot */
  onChanged: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('agentxDraft:changed', listener);
    return () => ipcRenderer.removeListener('agentxDraft:changed', listener);
  },
  /** "evet" dendi → draft:confirmed { id, revision, digest, target, text }. AXP-03 tüketir. */
  onConfirmed: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('agentxDraft:confirmed', listener);
    return () => ipcRenderer.removeListener('agentxDraft:confirmed', listener);
  },
});

// ADP-035 — multimodal prompt image bridge. saveTemp writes a renderer-supplied
// image blob to a temp file (main-side fs) and resolves to `{ ok, path, bytes }`
// (or `{ ok:false, reason }`). The prompt box injects the returned PATH into the
// prompt for the claude CLI (path injection, not base64 — UX-UI-V2 §5).
// WIN-IMG-01 — `verify` EKLENDİ: gönderimden hemen önce "bu görseller hâlâ diskte
// mi?" sorusu. Sessiz başarısızlık yasağı (ajanın "erişemiyorum" deyip kendi
// yorumunu yaptığı, kullanıcının sebebi bilmediği durum). Main YALNIZ kendi görsel
// köküne bakar → renderer'a genel bir dosya varlık-oracle'ı açılmaz.

// ADP-597 — AI MOTORU HESABI: kurulu mu (ADP-463-B) + oturum açık mı, ve oturumu
// Ayarlar'dan aç/kapat. Kullanıcı terminale hiç dokunmaz.
//
// ⚠️ `check()` köprüsü ADP-463-F'den beri EKSİKTİ: main'de `engine:check` handler'ı
// vardı ama preload onu hiç expose etmemişti, dolayısıyla sihirbazın motor-kontrol
// adımı her zaman "atlandı" (unavailable) çiziyordu — sessiz ölü köprü. Aynı alan
// olduğu için burada birlikte bağlanıyor.
//
// GÜVENLİK: bu köprüden hiçbir SIR geçmez. Dışarı çıkanlar: durum alanları + bir
// OAuth authorize URL'i. `submitCode` TEK YÖNDÜR — kullanıcının tarayıcıdan aldığı
// kodu main'e iletir, karşılığında yalnız {ok} döner; kod hiçbir yere yazılmaz.

contextBridge.exposeInMainWorld('engineApi', {
  /**
   * ADP-463-B — CLI kurulu mu → { engines:[{id,name,found,state,path,installUrl}], anyFound, anyUnknown }.
   * ADP-833 (ADR-W7): `state` üç-durumlu ('present'|'absent'|'unknown'); 'unknown' =
   * ölçemedik (UI onu "kurulu değil" diye GÖSTERMEZ).
   */
  check: () => ipcRenderer.invoke('engine:check'),
  /**
   * ENG-10 — motor YETENEK MATRİSİ: { ok, engines: { <id>: { engine, label, matrix } } }.
   * Ayarlar motor kartı ve entegrasyon hub'ı rozetlerini bundan çizer (pane açmadan).
   * Sır/dosya yolu DÖNMEZ — yalnız hüküm + motorun kendi beyan metni.
   */
  capabilityMatrix: () => ipcRenderer.invoke('engine:capabilityMatrix'),
  /**
   * ENG-19 — LİDER-UYGUNLUK + otomatik öneri:
   * { ok, engines:{<id>:{class:'full'|'fallback'|'never', auth, eligible, gaps, blockers, requirements}},
   *   order, recommended, recommendedClass, warning }
   * Hüküm descriptor'dan TÜRETİLİR (motor adına bakılmaz); giriş motorun KENDİ
   * durum komutundan okunur. Sır DÖNMEZ.
   */
  leadership: () => ipcRenderer.invoke('engine:leadership'),
  /**
   * ENG-21 — SUNULABİLİRLİK + DELEGASYON VATANDAŞLIĞI:
   * { ok, engines:{<id>:{offered, delegation:{class,capable,badge,blockers,warnings}}} }
   * `offered` = ENG-05 `engines.enabled` hükmünün ürünle gelen aynası (renderer
   * tabloyu okuyabilirse üstüne yazar). `delegation` = ENG-17 hükmü. Sır DÖNMEZ.
   */
  availability: () => ipcRenderer.invoke('engine:availability'),
  /** → { engines:[{engine,label,installed,loggedIn,method,account,plan,needsCode,error}] }. */
  authStatus: () => ipcRenderer.invoke('engineAuth:status'),
  /** Yönetilen giriş akışını başlatır (tarayıcıyı main açar) → { ok, session }. */
  login: (engine, profileId) => ipcRenderer.invoke('engineAuth:login', { engine, profileId }),
  /** Tarayıcı sayfasının verdiği kodu iletir (yalnız claude akışı) → { ok }. */
  submitCode: (code) => ipcRenderer.invoke('engineAuth:submitCode', { code }),
  /** Devam eden giriş akışını iptal eder → { ok }. */
  cancelLogin: () => ipcRenderer.invoke('engineAuth:cancel'),
  /** Oturumu kapatır; sonuç motorun kendi durum komutuyla DOĞRULANIR → { ok, status }. */
  logout: (engine, profileId) => ipcRenderer.invoke('engineAuth:logout', { engine, profileId }),

  // ── JEV AI — AKILLI MODEL YÖNLENDİRİCİ (Faz 3) ──────────────────────────────
  /** Görev zorluğuna ve bağlı motorlara göre optimal model önerisi alır. */
  routeTask: (params) => ipcRenderer.invoke('jev:route-task', params),
  /** Jev karar geçmişini listeler. */
  decisionLog: (params) => ipcRenderer.invoke('jev:decision-log', params),

  // ── ENG-08 — API ANAHTARI YEDEĞİ (abonelik birinci sınıf, bu YEDEK yol) ────
  // Anahtar TEK YÖN akar: renderer → main → vault. Geri dönen yüzeyde sır YOKTUR
  // (yalnız `{ ok, error, status }`); `status.apiKeySaved` bir BAYRAKtır, değer değil.
  /** Motorun API anahtarını kaydeder ve motorun KENDİ komutuyla doğrular → { ok, error, status }. */
  setApiKey: (engine, key, profileId) => ipcRenderer.invoke('engineAuth:setApiKey', { engine, key, profileId }),
  /** Kayıtlı anahtarı siler → { ok, status }. */
  clearApiKey: (engine, profileId) => ipcRenderer.invoke('engineAuth:clearApiKey', { engine, profileId }),
  /** Akış ilerledikçe main'in ittiği anlık-görüntü. Dönen fn dinleyiciyi kaldırır. */
  onChanged: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('engineAuth:changed', handler);
    return () => ipcRenderer.removeListener('engineAuth:changed', handler);
  },

  // ── ADP-936 — HESAPLAR (çok-hesap geçişi) ──────────────────────────────────
  // Renderer YALNIZ profil KİMLİĞİ konuşur. Dizin yolu, Keychain yuvası ve jeton
  // bu köprüden HİÇ geçmez — çözüm main'de (electron/engineProfiles.cjs).
  /** → { ok, autoSwitchOnLimit, engines:[{engine,label,active,profiles:[…]}] }. */
  accounts: () => ipcRenderer.invoke('engineProfiles:list'),
  /** Yeni hesap kutusu açar → { ok, profileId }. Girişi çağıran `login` ile başlatır. */
  accountAdd: (engine, label) => ipcRenderer.invoke('engineProfiles:add', { engine, label }),
  /**
   * Aktif hesabı değiştirir → { ok, active, stalePanes }. Canlı pane'ler etkilenmez
   * (env başlangıçta okunur); ACCT-FIX-01 — `stalePanes` eski hesapla koşmaya devam
   * eden ajan pane'lerinin listesidir (paneId · agentId · label · profileId · limited).
   */
  accountSwitch: (engine, profileId) => ipcRenderer.invoke('engineProfiles:switch', { engine, profileId }),
  /**
   * ACCT-FIX-01 — seçilen pane'leri KAPATIP hedef hesapla, aynı oturumdan (`--resume`)
   * yeniden açar → { ok, results:[{paneId, ok, newPaneId, resumed}] }. Kullanıcı onayı
   * renderer'da alınır; bu köprü yol/dizin taşımaz, yalnız kimlikler.
   */
  accountRespawnPanes: (engine, profileId, paneIds) =>
    ipcRenderer.invoke('engineProfiles:respawnPanes', { engine, profileId, paneIds }),
  /** Hesabın kullanıcı etiketini yazar → { ok }. */
  accountLabel: (engine, profileId, label) => ipcRenderer.invoke('engineProfiles:setLabel', { engine, profileId, label }),
  /** Hesabı kaldırır (önce o profilde çıkış, sonra defter+dizin) → { ok, active }. */
  accountRemove: (engine, profileId) => ipcRenderer.invoke('engineProfiles:remove', { engine, profileId }),
  /** "Limitte otomatik geç" tercihi → { ok, autoSwitchOnLimit }. */
  setAutoSwitch: (enabled) => ipcRenderer.invoke('engineProfiles:setAutoSwitch', { enabled }),
  // ── HATA-12 — AJANLARIN GÜNCEL MOTOR AYNASI ────────────────────────────────
  // Renderer `employees.engine`'i canlı okur; harita DEĞİŞTİĞİNDE main'e iter. Main
  // onu geri-yükleme defterinin yanına yazar ve bir sonraki açılışta pane'i ESKİ
  // motorla diriltmez (HATA-12'nin "yeniden başlatmak da kurtarmıyor" yarısı).
  /** `{agentId: motor}` → { ok, count }. Yalnız KAYITLI motorlar diske iner. */
  syncAgentEngines: (map) => ipcRenderer.invoke('agentEngines:sync', map),

  /** Hesap defteri değişince main iter (liste kendiliğinden tazelensin). */
  onAccountsChanged: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('engineProfiles:changed', handler);
    return () => ipcRenderer.removeListener('engineProfiles:changed', handler);
  },
});

// ADP-437 — office layout/floor/custom-asset persistence. Stored in userData
// main-side because the embedded server's RANDOM per-launch port makes the renderer
// origin (and thus localStorage) change on every restart — Edit-mode furniture saved
// to localStorage silently vanished on relaunch. SYNC get (read during mount, no
// async flash) + async set, same shape as fileApi's editorState pair.

contextBridge.exposeInMainWorld('delegationBridge', {
  /** Subscribe to delegate requests from main. cb gets { requestId, objective, leaderId, department, workers? }. */
  onStart: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('delegation:start', l);
    return () => ipcRenderer.removeListener('delegation:start', l);
  },
  /** Reply to a delegate request: { requestId, ok, delegationId?, error? }. */
  startResult: (res) => ipcRenderer.send('delegation:start:result', res),
  /** Subscribe to status requests from main. cb gets { requestId, id? }. */
  onStatus: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('delegation:status', l);
    return () => ipcRenderer.removeListener('delegation:status', l);
  },
  /** Reply to a status request: { requestId, ok, snapshot }. */
  statusResult: (res) => ipcRenderer.send('delegation:status:result', res),
  // ADP-242 — sprint kanalları (MCP crewpane_sprint → bridge → renderer orkestratörü).
  /** Subscribe to sprint-start requests. cb gets { requestId, objective, leaderId, department, tasks, maxConcurrent? }. */
  onSprintStart: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('sprint:start', l);
    return () => ipcRenderer.removeListener('sprint:start', l);
  },
  /** Reply: { requestId, ok, sprintId?, error? }. */
  sprintStartResult: (res) => ipcRenderer.send('sprint:start:result', res),
  /** Subscribe to sprint-status requests. cb gets { requestId, id? }. */
  onSprintStatus: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('sprint:status', l);
    return () => ipcRenderer.removeListener('sprint:status', l);
  },
  /** Reply: { requestId, ok, status }. */
  sprintStatusResult: (res) => ipcRenderer.send('sprint:status:result', res),
  // DF-03 — sprint durdurma kanalı (crewpane_sprint action:"stop").
  /** Subscribe to sprint-stop requests. cb gets { requestId, id?, reason? }. */
  onSprintStop: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('sprint:stop', l);
    return () => ipcRenderer.removeListener('sprint:stop', l);
  },
  /** Reply: { requestId, ok, sprintId?, summary?, wasLive?, error? }. */
  sprintStopResult: (res) => ipcRenderer.send('sprint:stop:result', res),
});

// ── TC-01 — TAKIM KURUCU KÖPRÜSÜ ────────────────────────────────────────────
// Sözleşme: docs/design/TEAM-COMPOSER-R1/IPC-CONTRACT.md §3
//
// 🔴 BEYAZ LİSTE KAPIDIR. Aşağıdaki satırlar olmadan özellik SESSİZCE ÖLÜR:
// main kanala yazar, renderer hiçbir şey duymaz, kullanıcı hata da GÖREMEZ
// ([[ref_preload_whitelist_is_a_gate]]). Kanal adları sözleşmede donmuştur.

contextBridge.exposeInMainWorld('delegationQueueApi', {
  /** { queued:[], paused:[] } → { ok, file?, error? }. */
  save: (state) => ipcRenderer.invoke('dlgqueue:save', state),
  /** → { ok, state: { queued:[], paused:[] } }. */
  load: () => ipcRenderer.invoke('dlgqueue:load'),
});

// SUP-UI-01 — KUYRUK PANELİ (salt-okur). Üç defter + canlı pane damgaları tek
// tabloda. Köprü YALNIZ okur: kuyruğun canlı sahibi renderer'daki delegationRunner
// olduğu için iptal/öne alma/duraklat oradadır — iki yazar = iki gerçek.

contextBridge.exposeInMainWorld('delegationSupervisorApi', {
  /** Dispatch anında: alt-görevi main defterine yaz (kanıt yolu + prompt imzası dahil). */
  record: (input) => ipcRenderer.invoke('dlgsup:record', input),
  /** Motor kendi settle etti → defteri hizala (supervisor çift notify/nudge yapmasın). */
  settle: (p) => ipcRenderer.invoke('dlgsup:settle', p),
  /** Lider durumu okudu → bekleyen uyandırmalar kapanır. */
  ack: (leaderId) => ipcRenderer.invoke('dlgsup:ack', leaderId),
  /** e2e/teşhis: defteri oku, tick'i elle sür. */
  debug: (action) => ipcRenderer.invoke('dlgsup:debug', action),
  /**
   * main → renderer: "şu alt-görev bitti (supervisor tespit etti), defterini hizala
   * ve kuyruğu ilerlet". Renderer İŞLEDİKTEN SONRA cevap verir; cevap gelmezse main
   * bir sonraki tick'te yeniden dener (iş asla sessizce düşmez).
   */
  onAdvance: (cb) => {
    const handler = (_e, msg) => {
      Promise.resolve()
        .then(() => cb(msg))
        .then((ok) => ipcRenderer.send('dlgsup:advance:result', { requestId: msg && msg.requestId, ok: ok !== false }))
        .catch(() => ipcRenderer.send('dlgsup:advance:result', { requestId: msg && msg.requestId, ok: false }));
    };
    ipcRenderer.on('dlgsup:advance', handler);
    return () => ipcRenderer.removeListener('dlgsup:advance', handler);
  },
});

// ADP-293 — MOBİL GATEWAY köprüsü (iki yön):
//   (a) main → renderer SORU ('office' | 'delegations' | 'tasks') → cevap requestId ile,
//   (b) renderer → main CANLI OLAY (delegasyon/limit/onay) → gateway SSE'sine yayılır.
// Gateway'in kendisi main'de yaşar; renderer'ın ona doğrudan erişimi YOKTUR (yüzey
// ayrımı: mobil token'ı ve cihaz defteri renderer'a asla sızmaz).
