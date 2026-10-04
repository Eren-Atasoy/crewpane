'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('paneViewApi', {
  /** → { readable } (bilinmeyen pane için varsayılan). */
  get: (paneId) => ipcRenderer.invoke('paneView:get', paneId),
  /** Durumu yaz + yayınla. `patch = { readable }` → { ok, paneId, readable, changed }. */
  set: (paneId, patch) => ipcRenderer.invoke('paneView:set', { paneId, ...(patch || {}) }),
  /** Başka bir pencere durumu değiştirdi. cb gets { paneId, readable }. Returns unsubscribe. */
  onChanged: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('paneView:changed', listener);
    return () => ipcRenderer.removeListener('paneView:changed', listener);
  },
});

// ADP-786 — GÖNDERİLMEMİŞ PROMPT TASLAĞI köprüsü. Okunabilir moddaki prompt
// kutusunun metni renderer'da YAŞAMAZ: pop-out ayrı bir renderer'dır ve mod
// değişimi okuyucuyu unmount eder — ikisi de kullanıcının yazdığını siler.
// Taslak main'deki deftere yazılır, her mount'ta oradan okunur. pty'ye DOKUNMAZ:
// bu metin HENÜZ GÖNDERİLMEMİŞTİR, gönderme kararı kullanıcınındır (ADP-155).

contextBridge.exposeInMainWorld('paneDraftApi', {
  /** → taslak metin (bilinmeyen pane için ''). */
  get: (paneId) => ipcRenderer.invoke('paneDraft:get', paneId),
  /** Taslağı yaz + (gerçekten değiştiyse) yayınla → { ok, paneId, text, changed }. */
  set: (paneId, text) => ipcRenderer.invoke('paneDraft:set', { paneId, text }),
  /** Aynı pane'i gösteren başka yüzey taslağı değiştirdi. cb: { paneId, text }. */
  onChanged: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('paneDraft:changed', listener);
    return () => ipcRenderer.removeListener('paneDraft:changed', listener);
  },
});

// ASK-CARD-01 — LİDERİN KARAR SORUSU köprüsü (paneDraftApi kardeşi). Defter main'de
// (electron/paneAsk.cjs); kart, pane rozeti, ofis işareti ve Yardımcı listesi AYNI
// anlık görüntüyü okur. Cevap BURADAN pane'e gitmez: main ENT-F1 primitifiyle yazar
// (metin bir kez), renderer yalnız seçimi taşır.
// 🔴 Yeni kanal = bu listeye satır; düşerse özellik SESSİZCE ölür
// ([[ref_preload_whitelist_is_a_gate]]).

contextBridge.exposeInMainWorld('paneAskApi', {
  /** → açık sorular (PaneAsk[]). */
  list: () => ipcRenderer.invoke('paneAsk:list'),
  /** Seçenek (choiceId) ya da serbest metin (text) → { ok, delivered?, reason?, ask? }. */
  answer: (payload) => ipcRenderer.invoke('paneAsk:answer', payload || {}),
  /** Kartı cevapsız kapat → { ok, reason? }. */
  dismiss: (askId) => ipcRenderer.invoke('paneAsk:dismiss', askId),
  /** Defter değişti (açıldı / hatırlatma / kapandı). cb: { type, ask }. Returns unsubscribe. */
  onChanged: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('paneAsk:changed', listener);
    return () => ipcRenderer.removeListener('paneAsk:changed', listener);
  },
});

// AXP-02 — AGENT X İŞ TASLAĞI köprüsü (paneDraftApi kardeşi). Taslak main'deki
// durum makinesinde yaşar (electron/agentxDraft.cjs); widget ses/klavye girdisini
// yazar, ana pencere ve pop-out aynası aynı fotoğrafı okur. Karar burada VERİLMEZ:
// bu köprü metni taşır, "ekle mi / teyit mi / gönder mi" cevabı main'den döner.
// 🔴 Yeni kanal = bu listeye satır; düşerse özellik SESSİZCE ölür
// ([[ref_preload_whitelist_is_a_gate]]); kablo taraması agentxDraft.test.cjs'te.

contextBridge.exposeInMainWorld('composeBridge', {
  // — main → renderer TURLARI (köprü: MCP aracı → main → burası) —
  /** Satır kurma isteği. cb: { requestId, objective, roles, mode, teamName, department, leaderId, maxEmployees, rejectedRoles }. */
  onPropose: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('team-compose:propose', l);
    return () => ipcRenderer.removeListener('team-compose:propose', l);
  },
  /** Cevap: { requestId, ok, teamName?, rows?, targetTeamId?, catalogSlugs?, error? }. */
  proposeResult: (res) => ipcRenderer.send('team-compose:propose:result', res),
  /** Kurulum isteği. cb: { requestId, proposalId, mode, teamName, rows, targetTeamId }. */
  onApply: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('team-compose:apply', l);
    return () => ipcRenderer.removeListener('team-compose:apply', l);
  },
  /** Cevap: { requestId, ok, teamId?, createdTeam?, employeeIds?, names?, … }. */
  applyResult: (res) => ipcRenderer.send('team-compose:apply:result', res),
  /** Geri alma isteği. cb: { requestId, teamId, createdTeam, employeeIds }. */
  onUndo: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('team-compose:undo', l);
    return () => ipcRenderer.removeListener('team-compose:undo', l);
  },
  /** Cevap: { requestId, ok, removedEmployees, removedTeam, error? }. */
  undoResult: (res) => ipcRenderer.send('team-compose:undo:result', res),

  // — KART YÜZEYİ (TC-02 bunları kullanır) —
  /** Onay kartı olayı. cb: { proposalId, mode, teamName, rows, expiresAt, planNote, source, autonomy }. */
  onProposal: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('team-compose:proposal', l);
    return () => ipcRenderer.removeListener('team-compose:proposal', l);
  },
  /** Kurulum sonrası şerit olayı. cb: { proposalId, teamName, names, wingSlug, undoExpiresAt }. */
  onApplied: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('team-compose:applied', l);
    return () => ipcRenderer.removeListener('team-compose:applied', l);
  },
  /**
   * Kullanıcının kararı → main. { proposalId, decision:'approve'|'reject', teamName?, rows?, mode?, catalogSlugs? }
   * Dönen `approvalToken` MAIN'de doğar; kart onu üretemez.
   */
  decide: (req) => ipcRenderer.invoke('team-compose:decision', req),
  /** Ayar kademesi (§9.7): { ok, autonomy:'ask'|'small-auto'|'auto' }. */
  autonomy: () => ipcRenderer.invoke('team-compose:autonomy'),
  /**
   * TC-02 — KULLANICININ şeritten geri alması. §3.6 bunu yalnız main→renderer
   * yönünde tanımlıyordu; şeridin düğmesi ters yönü ister. → { ok, error? }
   */
  undoRequest: (proposalId) => ipcRenderer.invoke('team-compose:undo-request', { proposalId }),
});

// ADP-136 — team window auto-switch. The delegate path asks main to bring the
// target team's tmux window forward so the operator SEES the work start. Returns a
// typed best-effort result ({ ok, target?, reason? }); never throws.

// TASK-CLEAN — Görev temizleme köprüsü (Seçili takım veya tüm takımlar)
contextBridge.exposeInMainWorld('taskApi', {
  /** Seçili takımın done olan görevlerini sil → { ok, project, deletedCount } */
  cleanTeamDone: (opts) => ipcRenderer.invoke('task:cleanTeamDone', opts),
  /** Tüm takımların bütün görevlerini kalıcı sil → { ok, deletedCount } */
  cleanAll: () => ipcRenderer.invoke('task:cleanAll'),
  /** Görev durum özeti → { ok, total, byProject, tasks } */
  listSummary: () => ipcRenderer.invoke('task:listSummary'),
});

// ADP-660 — PLAN LİMİTİ köprüsü (nudge + Ayarlar özeti).
// Karar burada VERİLMEZ: `onLimit` main'in ZATEN reddettiği bir eylemi ve onun
// kullanıcı metnini taşır (ikinci bir "limit aşıldı mı" mantığı = iki gerçek).
// Bu köprü hiçbir şeyi ZORLAMAZ — dişler main'de (pty:spawn / integ:add / supervisor).

contextBridge.exposeInMainWorld('planApi', {
  /** → { ok, enforced, tier, tierLabel, fallback, features{agents,integrations,autopilot}, billingUrl }. */
  get: () => ipcRenderer.invoke('plan:get'),
  /**
   * BL-03 — "yükselttim, hâlâ kilitli mi?" → jetonu TAZELE + reddin KENDİ ölçüsünü
   * yeniden karara sok. → { ok, refreshed, allowed, tier, tierLabel, requiredTierLabel }.
   * Karar yine main'dedir (planLimits.decide); burası yalnız reddin (feature,current)
   * çiftini geri taşır — renderer ikinci bir tavan mantığı KURMAZ.
   */
  recheck: (feature, current) => ipcRenderer.invoke('plan:recheck', { feature, current }),
  /** Main bir eylemi plan limiti yüzünden reddettiğinde push eder (kapatılabilir nudge). */
  onLimit: (cb) => {
    const l = (_e, d) => cb(d);
    ipcRenderer.on('plan:limit', l);
    return () => ipcRenderer.removeListener('plan:limit', l);
  },
});

// PANE-CAP-01 — KAYNAK BEKÇİSİ köprüsü. Sabit pane tavanı (24/16) KALKTI; yerine
// ölçülen bellek baskısı geldi. Bu köprü hiçbir şeye KARAR VERMEZ: durumu okur,
// kullanıcının kararını (yine de aç / eşik / kapat / bitmiş pane'leri kapat) main'e
// taşır. Renderer'da ikinci bir "yeterli kaynak var mı" mantığı YOKTUR.

contextBridge.exposeInMainWorld('queueBoardApi', {
  /** → { ok, board: {waiting, inflight, done, warnings, counts}, sources }. */
  get: () => ipcRenderer.invoke('queueboard:get'),
});

// ADP-659 — DELEGASYON SUPERVISOR köprüsü. Renderer'ın motoru efemerdir (reload =
// tüm nöbetler ölür); bu kanal her dispatch'i MAIN'in kalıcı defterine yazar ve
// main'in "bu iş bitti, kuyruğu ilerlet" push'unu geri taşır. Köprü YOKSA
// (eski preload) renderer sessizce eski davranışa düşer — supervisor opsiyoneldir,
// asla dispatch'i bloklamaz.
