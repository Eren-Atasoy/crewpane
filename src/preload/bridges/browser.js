'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('browserControlBridge', {
  /** Subscribe to approval requests. cb gets { requestId, action, selector?, text?, agentId? }. */
  onApproval: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('browser:approval', l);
    return () => ipcRenderer.removeListener('browser:approval', l);
  },
  /**
   * Reply to an approval request: { requestId, approved, scope? }.
   * ADP-341 — `scope:'session'` = "bu görev boyunca izin ver" (yalnız kapı `scope:'session'`
   * teklif ettiyse geçerlidir; TTL 30dk + eylem tavanı, diske YAZILMAZ). Yoksa tek eylemlik.
   */
  approvalResult: (res) => ipcRenderer.send('browser:approval:result', res),
  /**
   * ADP-341 (ADR-026 §3.3) — DURDUR: tüm görev-başı izinleri iptal eder ve bekleyen onay
   * varsa onu da geçersiz kılar. → { revoked, epoch }
   */
  stop: () => ipcRenderer.invoke('browser:stop'),
  /**
   * ADP-343 (ADR-026 §2.5) — OTOMASYON MODU: süre sınırlı "bu oturumda sorma" (Ayarlar → Güven).
   * `minutes` null/0 → kapat. Oturumluk: diske yazılmaz, DURDUR kapatır, hassas hedef ve yasak
   * origin bundan ETKİLENMEZ. → { active, until, remainingMs, minutes:[…] }
   */
  setAutomation: (minutes) => ipcRenderer.invoke('browser:trust:automation', { minutes }),
  /** ADP-343 — otomasyon modunun canlı durumu (geri sayım). */
  automationStatus: () => ipcRenderer.invoke('browser:trust:status'),
  /** Subscribe to the agent's browser activity feed. cb gets { action, selector?, agentId?, at }. */
  onActivity: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('browser:activity', l);
    return () => ipcRenderer.removeListener('browser:activity', l);
  },
  /**
   * ADP-135 — run a browser action (navigate/click/type/read/readPage/screenshot/
   * back) against the live internal-browser guest. Used by Jarvis voice
   * (jarvisVoice.executeBrowser). Resolves { ok, result? } | { ok:false, error }.
   */
  run: (value) => ipcRenderer.invoke('browser:action', value),
  /**
   * ADP-150 (multi-tab) — main asks the renderer to open a new IN-APP browser tab
   * when a guest does target=_blank / window.open (instead of the OS browser). cb
   * gets { url }. Returns an unsubscribe fn.
   */
  onNewTab: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('browser:new-tab', l);
    return () => ipcRenderer.removeListener('browser:new-tab', l);
  },
  /**
   * ADP-150 (multi-tab) — tell main which <webview> guest (by webContents id) is the
   * active tab, so headed automation (ADP-095) drives the visible tab. Main only
   * accepts an id it tracked at attach time (never the app renderer).
   */
  setActiveGuest: (id) => ipcRenderer.send('browser:setActiveGuest', id),
  /**
   * ADP-333 — main, bir AJANA ait sekme açılmasını ister (ajan kendi sekmesine kilitli;
   * kullanıcının sekmesine asla girmez). cb { agentId, url } alır. Sekme ARKA PLANDA
   * açılır: patronun baktığı sayfa değişmez.
   */
  onAgentTab: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('browser:agent-tab', l);
    return () => ipcRenderer.removeListener('browser:agent-tab', l);
  },
  /** ADP-333 — bu sekmenin SAHİBİ şu ajan: { guestId, agentId }. */
  setTabOwner: (payload) => ipcRenderer.send('browser:setTabOwner', payload),
  /**
   * ADP-394 — HAYALET MOD: main, bir guest'in KOMPOZE EDİLMESİNİ ister (otomasyon koşarken).
   * cb { guestId, on } alır. `display:none` bir <webview> kare üretmez → tıklama inmez
   * (ADP-392). Renderer o sekmeyi görünmez ama çizilen bir katmana çevirir; boşta kapatır.
   */
  onComposite: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('browser:composite', l);
    return () => ipcRenderer.removeListener('browser:composite', l);
  },
});

// ADP-121 (ADR-009 Faz 120a) — Jarvis voice core bridge. The renderer widget
// captures mic audio + runs the state machine; main owns the API key (Whisper),
// the Claude brain (`claude -p`), and macOS `say` TTS. Whitelisted channels only;
// the OpenAI key never crosses to the renderer (only a boolean `hasOpenAiKey`).
// B-06 — ONBOARDING ŞABLON ÖNERİSİ: TEK dar kanal (presets:recommend). Genel
// amaçlı "modele sor" köprüsü DEĞİL — istek yalnız serbest metin + şablon
// kataloğu taşır, cevap yalnız o kataloğun içinden bir id olabilir (main tarafı
// doğrular). Köprü yoksa (web/dev-next) renderer YEREL eşleştirmeye düşer.
