'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mobileBridge', {
  /** main'in veri sorularını dinle. cb: ({ requestId, kind }) => void */
  onQuery: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('mobile:query', l);
    return () => ipcRenderer.removeListener('mobile:query', l);
  },
  /** Cevap: { requestId, data }. */
  queryResult: (res) => ipcRenderer.send('mobile:query:result', res),
  /** Canlı olay (MobileEvent) → SSE. */
  event: (event) => ipcRenderer.send('mobile:event', event),
  /**
   * ADP-296 — YAZMA komutları (prompt/delegate/tasks/jarvis/approve/stop). Renderer
   * MEVCUT motorları çağırır; gateway yalnız taşır. cb: ({ requestId, kind, payload }).
   */
  onCommand: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('mobile:command', l);
    return () => ipcRenderer.removeListener('mobile:command', l);
  },
  /** Cevap: { requestId, result }. */
  commandResult: (res) => ipcRenderer.send('mobile:command:result', res),
});

// ADP-293 — masaüstü "Mobil erişim" yönetimi (ADP-294 UI'ı kullanır): aç/kapa
// (kill-switch), QR eşleşme kodu üret, cihaz iptal et, durum oku.

contextBridge.exposeInMainWorld('mobileAdmin', {
  status: () => ipcRenderer.invoke('mobile:status'),
  enable: () => ipcRenderer.invoke('mobile:enable'),
  disable: () => ipcRenderer.invoke('mobile:disable'),
  createPairing: () => ipcRenderer.invoke('mobile:pair'),
  // MOB-UX-M1 (M1-b) — sihirbazın ölçümü: { tailnet:{state,address?,dnsName?},
  // gateway:{running,…}, peers:{available,phones?} }. Gateway KAPALIYKEN de çalışır.
  probe: () => ipcRenderer.invoke('mobile:probe'),
  revoke: (deviceId) => ipcRenderer.invoke('mobile:revoke', deviceId),
  // ADP-308 — cihaz yetkisi read ⇄ command (yalnız masaüstünden; telefonun kendini
  // yükseltebileceği bir rota YOK — ADP-293 §4 kapsam kuralı).
  setScope: (deviceId, scope) => ipcRenderer.invoke('mobile:scope', deviceId, scope),
});

// ADP-586 (Entegrasyon Merkezi / Dalga 0) — "Bağlı Hesaplar" köprüsü.
//
// KIRMIZI ÇİZGİ: bu köprüden DÜZ-METİN ANAHTAR GEÇMEZ. `add` sırrı MAIN'e YOLLAR
// (tek yön; oradan şifreli vault'a girer), ama hiçbir çağrı sırrı GERİ getirmez —
// `list`/`add` dönüşündeki kayıtta yalnız `meta.masked` ("sbp••••4f2a") vardır.
// crewpaneApi (jeton main'de kalır) ve settingsApi (`hasOpenAiKey` bayrağı) ile aynı
// duruş. Girdi doğrulama main'de (integrationIpc.cjs) — renderer'a güvenilmez.
