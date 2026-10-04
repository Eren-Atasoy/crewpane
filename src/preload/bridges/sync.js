'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('integrationsApi', {
  /** → { ok, available, records:[{id,service,scope,env,authKind,envVar,meta}], catalog:[…] }. */
  list: () => ipcRenderer.invoke('integ:list'),
  /**
   * Yeni bağlantı: { service, secret, scope?, env?, keyLabel?, scopeHint?, userFields? }
   * → { ok, record } (record MASKELİ) | { ok:false, reason, error }.
   */
  add: (input) => ipcRenderer.invoke('integ:add', input),
  /** Bağlantıyı kes: cred_… → { ok, removed, restartHint } (açık pane'ler yeniden başlatılmalı). */
  remove: (id) => ipcRenderer.invoke('integ:remove', id),

  // ── MCP-COST-01 — MALIYET GORUNURLUGU + OTOMATIK ACILMA ISARETI ───────────
  // Ikisi de SIR TASIMAZ. `mcpStats` yalniz sayar (surec/RSS), `autostart`
  // yalniz bir sonraki pane acilisini etkiler — baglantiyi KOPARMAZ.
  /**
   * Su anki MCP maliyeti →
   * { ok, measured, paneCount, totalMb, services:{ <servis>:{panes,procs,wrappers,rssMb,orphans} } }
   * `measured:false` = `ps` okunamadi (UI sifir yazmamali, "olculemedi" demeli).
   */
  mcpStats: () => ipcRenderer.invoke('integ:mcpStats'),
  /**
   * Otomatik acilma isareti.
   *   ()                                        → { ok, map }
   *   ({ op:'set', service, enabled:false })     → { ok, map, restartHint }
   * Yazili olmayan servis ACIKTIR (varsayilan degismedi).
   */
  autostart: (payload) => ipcRenderer.invoke('integ:autostart', payload),
  /**
   * Gerçek MCP handshake ile dene: { service, env?, scope?, secret?, userFields? }
   * → { ok, tools, serverName, durationMs, reason?, error? }. `secret` verilirse
   * KAYDETMEDEN test edilir. `npx` paketi indirebileceği için uzun sürebilir.
   */
  test: (input) => ipcRenderer.invoke('integ:test', input),

  // ── INT-OBS-01 — TELEMETRİ OTOMATİK KURULUMU ──────────────────────────────
  // 🔴 Bu üç çağrının HİÇBİRİ jeton TAŞIMAZ — ne içeri ne dışarı. Jeton zaten
  // kasadadır; main onu kendi çözer. Renderer yalnız "hangi servis" der ve
  // maskeli bir SONUÇ alır. `add`ten farkı budur (o, sırrı bir kez içeri yollar).
  /**
   * Kurulumu çalıştır: { service:'sentry'|'posthog', orgSlug?, teamSlug? }
   * → { ok, org, channels, notes } | { ok:false, code:'choose-org', orgs:[…] }
   *   | { ok:false, code, message }  (message KULLANICI CÜMLESİDİR, hata kodu değil)
   */
  provision: (input) => ipcRenderer.invoke('telemetry:provision', input),
  /**
   * Doğrulama olayı gönder + panoda göründüğünü OKU:
   * → { ok, channel, sent, confirmed, method, message }.
   * `confirmed:false` "gönderildi ama göremedim" demektir — sahte yeşil YOK.
   */
  verifyTelemetry: (input) => ipcRenderer.invoke('telemetry:verify', input),
  /** Durum yüzeyi → { ok, channel, services:[{service, connected, org, channels:[{channel,project,masked}], lastVerify}] }. */
  provisionStatus: () => ipcRenderer.invoke('telemetry:provisionStatus'),
});


contextBridge.exposeInMainWorld('syncApi', {
  /** Rozet + kuruluş görüntüsü. → { ok, enabled, state, queued, conflictsOpen, realtimeProven, plan, setup } */
  status: () => ipcRenderer.invoke('sync:status'),
  /** "Şimdi eşitle" — gerçek tur (jeton tazelenir, yedek tur yeniden planlanır). */
  now: (opts) => ipcRenderer.invoke('sync:now', opts || {}),
  /** Açık çakışmalar (GÖVDESİZ). → { ok, rows:[{id,relPath,class,kind,winnerSha,loserSha,recoverable,…}], count } */
  conflicts: (opts) => ipcRenderer.invoke('sync:conflicts', opts || {}),
  /** "Kaybedeni yanına yaz" — üzerine YAZMAZ, `<ad>.conflict-<8hex>.<uzantı>` açar. → { ok, path } */
  restoreLoser: (id) => ipcRenderer.invoke('sync:restoreLoser', { id }),
  /** Kullanıcı kararını deftere yaz: 'kept-winner' | 'restored-loser' | 'merged-manual'. */
  resolveConflict: (id, resolution) => ipcRenderer.invoke('sync:resolveConflict', { id, resolution }),
  /** §5.4 sır kapısı: "bu dosyada sır yok, yükle" (sha256 ile). */
  approveSecret: (sha256) => ipcRenderer.invoke('sync:approveSecret', { sha256 }),
  /** Yeniden girişten sonra DURMUŞ kuyruğu sürdür. */
  resumeQueue: () => ipcRenderer.invoke('sync:resumeQueue'),
  /** Tercih kaydedildikten sonra motoru yeniden çöz (kapatma ANINDA söker). */
  refresh: (opts) => ipcRenderer.invoke('sync:refresh', opts || {}),
});

// ═══════════════════════════════════════════════════════════════════════════════
// SYNC-F1-7 — TAŞINABİLİR TERCİH köprüsü (renderer ekseni: `localStorage`)
// ═══════════════════════════════════════════════════════════════════════════════
// Renderer'ın `localStorage`ı main'den okunamaz; düzen/sekme tercihleri bu ince
// köprüden geçer. Sınır DAR ve TEK YÖNLÜ GÜVENLİDİR: `publish` main tarafında
// `publishRenderer` süzgecinden geçer ve YALNIZ beyaz listede `renderer` kaynaklı
// anahtarları kabul eder. Yani bu köprüden `locale`, `workspaceRoot` ya da bir
// sır projeksiyona SOKULAMAZ — bir XSS yüzeyi bile listeyi genişletemez.

contextBridge.exposeInMainWorld('memoryApi', {
  /** → { nodes:[{slug,name,type,scope,desc}], edges:[{from,to}], counts, scopes }. */
  graph: () => ipcRenderer.invoke('memory:graph'),
  /** ADP-277 — one fact's full body: (scope, slug) → { slug, scope, name, description, type, body } | null. */
  fact: (scope, slug) => ipcRenderer.invoke('memory:fact', scope, slug),

  // ADP-870 (Faz 2) — hafıza RAG indeksi. İndeksleme AYRI SÜREÇTE koşar; buradaki
  // çağrılar yalnız onu başlatır/durdurur ve ilerlemesini dinler (UI donmaz).
  /** → { running, phase, startedAt, lastEvent, lastResult, reason, dbFile }. */
  indexStatus: () => ipcRenderer.invoke('memoryIndex:status'),
  /** Arka plan indekslemeyi başlat → { ok, dbFile } | { ok:false, reason }. */
  indexStart: () => ipcRenderer.invoke('memoryIndex:start'),
  /** Nazik durdur (dosya sınırında) → { ok } | { ok:false, reason:'not_running' }. */
  indexStop: () => ipcRenderer.invoke('memoryIndex:stop'),
  /**
   * İlerleme akışı. cb gets { phase, done?, total?, chunks?, file?, rssMb?, reason? }.
   * phase: scanned|planned|indexing|done|exit|stopped|unavailable|error. Returns unsubscribe.
   */
  onIndexEvent: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('memoryIndex:event', listener);
    return () => ipcRenderer.removeListener('memoryIndex:event', listener);
  },

  // ADP-871 (Faz 3) — hibrit arama (kelime + anlam). ADP-854'ün dosya-adı eşleşmesi
  // yerinde DURUYOR; bu onun yanına gelen ikinci bir yüzey.
  /**
   * → { ok:true, results:[{ name, docPath, headingPath, lineStart, lineEnd, excerpt,
   *     matchedBy:['anlam'|'kelime'], score }], text, degraded, sources }
   *   | { ok:false, reason:'index_not_built'|'empty_query'|… }
   * `degraded:true` = anlam katmanı bu sorguya katılamadı (model ısınıyor ya da kurulu
   * değil) → sonuçlar yalnız kelime katmanından. `text` doğrudan gösterilebilir; sonuç
   * yoksa "Hafızada bunu bulamadım." der (uydurma yok).
   */
  search: (query, k) => ipcRenderer.invoke('memoryIndex:search', query, k),
  /** → { embedderReady, embedderRunning, unavailable, semanticEnabled, openIndexes }. */
  searchStatus: () => ipcRenderer.invoke('memoryIndex:searchStatus'),

  // ── ADP-900 — ANLAM KATMANI: ONAYLI İNDİRME ───────────────────────────────
  // Kural: onay verilmeden TEK BAYT inmez ve kapı MAIN tarafındadır (renderer'a
  // güvenilmez). `embedPlan` yalnız BOYUT sorar (HEAD; gövde inmez, disk yazılmaz).
  /** → { ok, prefs:{semanticEnabled,autoIndex,consent}, available, reason, model, ramMb, diskBytes, install, search }. */
  embedState: () => ipcRenderer.invoke('memoryEmbed:state'),
  /** Sunucudan ÖLÇÜLEN plan → { ok, model:{files,totalBytes,…}, runtime, totalBytes, remainingBytes, ramMb, ready, consentKey }. */
  embedPlan: () => ipcRenderer.invoke('memoryEmbed:plan'),
  /** Kullanıcının kararını damgala (granted=false → kapalı kalır, hiçbir şey inmez). */
  embedConsent: (granted, key) => ipcRenderer.invoke('memoryEmbed:consent', granted, key),
  /** İndirmeyi başlat (damga plana uymuyorsa `consent_required` döner). */
  embedInstall: () => ipcRenderer.invoke('memoryEmbed:install'),
  /** İptal — yarım dosya KALIR, sonraki deneme kaldığı yerden sürer. */
  embedCancel: () => ipcRenderer.invoke('memoryEmbed:cancel'),
  /** Model + çalışma zamanını sil → { ok, freedBytes }. */
  embedRemove: () => ipcRenderer.invoke('memoryEmbed:remove'),
  /** { semanticEnabled?, autoIndex? } → { ok, prefs }. */
  embedSetPrefs: (patch) => ipcRenderer.invoke('memoryEmbed:setPrefs', patch),
  /** Kurulum ilerlemesi: { phase, file, receivedBytes, totalBytes, reason, message }. Aboneliği bırakır. */
  onEmbedEvent: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('memoryEmbed:event', listener);
    return () => ipcRenderer.removeListener('memoryEmbed:event', listener);
  },

  // ADP-862 (st1) — ÜRÜN UCU. `search`in ham çıktısının üstünde üç GARANTİ verir:
  // her sonuçta kaynak (dosya+satır) + alıntı · sonuç yoksa "Hafızada bunu
  // bulamadım." (uydurma yok) · gösterilen metin sır maskesinden geçmiş.
  /**
   * → { ok, found, query, results:[{ source, name, scope, heading, lineStart,
   *     lineEnd, excerpt, matchedBy, score }], text, degraded, masked, reason? }
   */
  recall: (query, k) => ipcRenderer.invoke('memory:recall', query, k),
});

// ADP-095 (ADR-006 — headed automation) — browser-control bridge renderer side.
// Main asks the renderer to APPROVE a click/type before driving the internal
// browser via CDP, and pushes an activity feed for the in-panel log. Whitelisted
// channels only; the guest <webview> cannot see any of this (app-window context).
