'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('designApi', {
  /** Tasarım turunu ayrı pencerede aç (zaten açıksa öne getirir). → { ok, reused? } | { ok:false, error }. */
  openWindow: () => ipcRenderer.invoke('design:openWindow'),
  /** Tasarım penceresini kapat. → { ok } | { ok:false, error }. */
  closeWindow: () => ipcRenderer.invoke('design:closeWindow'),
  /** Pencere şu an açık mı → { open }. */
  isWindowOpen: () => ipcRenderer.invoke('design:isWindowOpen'),
  /** Pencere açıldı/kapandı (giriş düğmesi gerçeği yansıtsın). cb gets { open }. Returns unsubscribe. */
  onOpenState: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('design:openState', listener);
    return () => ipcRenderer.removeListener('design:openState', listener);
  },
  /**
   * AUID-M4A (ARIZA-1) — TÜM pencerelerdeki ajan-bağlı pane'ler. `ptyApi.list`
   * SAHİP PENCEREYE göre süzer ve tasarım penceresi hiçbir pty'nin sahibi
   * olmadığı için ona hep BOŞ dönüyordu. → { ok, panes }.
   */
  listAgents: () => ipcRenderer.invoke('design:listAgents'),
  /**
   * AUID-M4A — bir tasarım görevi klasörü aç (`docs/design/<görev>`). `fileApi`
   * mkdir yapamaz; demo tohumu ve üretim modu buna muhtaç. → { ok, created }.
   */
  ensureTaskDir: (rel) => ipcRenderer.invoke('design:ensureTaskDir', rel),
});

// ADP-712 — PANE GÖRÜNÜM DURUMU (okunabilir mod) köprüsü. Aynı pane'in ızgaradaki
// hücresi ile ayrı penceresi TEK tercihi paylaşır: durum main'de yaşar, her
// değişim tüm pencerelere yayınlanır ("pty tek, iki görünüm" — ADP-593 ilkesinin
// görünüm katmanındaki karşılığı). pty'ye DOKUNMAZ.

contextBridge.exposeInMainWorld('codeIntelApi', {
  /** Diff one file vs HEAD → { ok, tracked, relPath, committedText, added, modified, removed, summary }. */
  diff: (filePath) => ipcRenderer.invoke('git:diff', filePath),
  /** Files in the active workspace (scoped to its git repo) → { ok, files:[path…] }.
   *  `root` (TASK-MQTIVZSDYPNRH) = the editor's active file/folder; main scopes to it. */
  listFiles: (root) => ipcRenderer.invoke('workspace:listFiles', root),
  /** Literal case-insensitive content search in the active workspace → { ok, hits:[{file,
   *  line, text}], truncated }. `root` scopes the search (active file/folder). */
  grep: (query, root) => ipcRenderer.invoke('workspace:grep', { query, root }),
  /** ADP-402 — pane header git-branch rozeti: cwd → saran repo'nun branch'i
   *  ({ ok, branch: string|null }; git değilse/root dışıysa branch yok). */
  // B-02 — `opts.force` TTL cache'ini atlar: görev değişimi / attach / merge
  // sonrası rozet 5 saniye bayat kalmasın (poll YOK, yalnız olay).
  branch: (cwd, opts) => ipcRenderer.invoke('git:branch', cwd, opts),
});

// ADP-050 (ADR-004 §A1) — delegation bridge renderer side. Main forwards a
// loopback-HTTP delegate/status request here over IPC; the renderer handler
// (delegationBridgeClient) calls the EXISTING window.crewpaneDelegation engine
// and sends the result back, correlated by requestId. Whitelisted channels only.

contextBridge.exposeInMainWorld('worktreeApi', {
  /** → { ok, worktrees:[{taskId, project, code, branch, path, baseCommit, owner, state, livePaneId}] } */
  list: () => ipcRenderer.invoke('worktree:list'),
  /**
   * İnceleme kartının verisi — HİÇBİR ŞEYİ DEĞİŞTİRMEZ.
   * → { ok, branch, target, commitCount, commits, files, diffStat, conflict, conflictFiles,
   *     secretScan:{ok,findings}, approval:{approver,auto,blocked,why}, preconditions }
   * `secretScan.findings` yalnız DOSYA + TÜR taşır; sırrın DEĞERİ asla dönmez (G-4).
   */
  review: (input) => ipcRenderer.invoke('worktree:review', input),
  /** Merge et. Kapılar burada TEKRAR koşar; `approvedBy:true` patron onayıdır. */
  merge: (input) => ipcRenderer.invoke('worktree:merge', input),
  /** Merge sonrası ağacı kaldır. Kirli ağaç yalnız `force:true` ile (patron onayı, G-9). */
  release: (input) => ipcRenderer.invoke('worktree:release', input),
  /** Temizlik taraması: kayıp/bayat kayıtlar + defter DIŞI yönetilen ağaçlar. */
  reap: () => ipcRenderer.invoke('worktree:reap'),
});

// GIT-BB-CLOUD-01 — AYARLAR → PROJELER: izolasyonun YEREL yarısı.
// Buluttaki `projects` satırını ekran kendisi yazar (takımın gördüğü ayar); burası
// spawn anında main'in BAKTIĞI yerdir (settings.projectIsolation + worktrees.json).
// Renderer yol DAYATAMAZ — repoPath'i main çözer ve yalnız GÖSTERMEK için döner.

contextBridge.exposeInMainWorld('codeIndexApi', {
  /**
   * → { ok, installed, binPath, binName, installUrl,
   *     projects:[{slug, repoPath, enabled, indexedSha, lastIndexedAt,
   *                state:'not-indexed'|'fresh'|'stale'|'unknown', staleFiles, indexing}] }
   * `state:'unknown'` "ölçemedim" demektir ve "taze" diye YUVARLANMAZ (CIDX-0 §4b).
   */
  list: (slugs) => ipcRenderer.invoke('codeIndex:list', { slugs }),
  /** { slug, enabled } → { ok, enabled, persisted, restartHint }. */
  set: (slug, enabled) => ipcRenderer.invoke('codeIndex:set', { slug, enabled }),
  /** Arka planda indeksle → { ok, started, repoPath } | { ok:false, why }. */
  index: (slug) => ipcRenderer.invoke('codeIndex:index', { slug }),
  /** İlerleme/bitiş: { slug, running, ok?, exitCode?, tail? }. */
  onProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('codeIndex:progress', handler);
    return () => ipcRenderer.removeListener('codeIndex:progress', handler);
  },
});

// ADP-203 — user Settings (~/.crewpane/settings.json): workspace root, OpenAI key,
// push-to-talk key, wake-model path. `get` returns NO secret values (only hasOpenAiKey).

contextBridge.exposeInMainWorld('sprintApi', {
  /** run objesini kalıcıla → { ok, file? , error? }. */
  save: (run) => ipcRenderer.invoke('sprint:save', run),
  /** id → { ok, run|null }. */
  load: (id) => ipcRenderer.invoke('sprint:load', id),
  /** → { ok, runs: [{id, settled, updatedAt, objective, taskCount}] }. */
  list: () => ipcRenderer.invoke('sprint:list'),
  /**
   * DF-03 — ÇOK-ADAYLI kanıt sondası (supervisor'ın ADP-735 çözümünün aynısı).
   * { department?, items:[{taskId, evidencePath, agentId?, since?}] }
   *   → { ok, items:[{taskId, found, path?, mtimeMs?, stale?}] }
   * Renderer'ın tek-köklü `fileApi` sondası kurulu makinede YANLIŞ köke bakıyordu.
   */
  probeEvidence: (req) => ipcRenderer.invoke('sprint:evidence', req),
  /**
   * RES-IDX-01 — SONUÇ KÖKÜ görevin projesinden (main `resultRoot.cjs`; renderer tahmin
   * etmez). { project?, codes?:[…] } → { ok, root, source, fallback, existing:[…], hasIndexScript }.
   * Worker'a rapor yolu bu kökle MUTLAK + TEK yazılır; supervisor aynı kökü birincil
   * aday yapar (BUG-R3 #8: raporlar üç yere düşüyordu).
   */
  resultRoot: (req) => ipcRenderer.invoke('sprint:resultRoot', req),
});

// SK-03 (ADR-SKILL-CENTER §8) — SKİLL MERKEZİ. `memoryApi` ile aynı desen: dosya
// tabanlı skill deposunu OKUR; SK-04 ile onaya, SK-05 ile yazmaya açıldı.
//
// ⚠️ İKİ YAZMA UCU VAR VE İKİSİ DE KAPININ AYNI TARAFINDA: `saveDraft` YALNIZ
// `.crewpane/skill-drafts`e yazar (yayına yazan bir API yok), `publish` ise insanın
// onay kartındaki tıklamasıdır. Buraya "yayına doğrudan yaz" diyen bir uç eklemek
// ADR §3'ün kapısını renderer'dan delerdi.

contextBridge.exposeInMainWorld('searchApi', {
  /**
   * → { ok:true, groups:{ [type]: { total, hits:[{type,key,title,path,line,snippet,meta,mtime,score}] } },
   *     total, ms, fts } | { ok:false, reason:'index_not_built'|'fts_unavailable'|… }
   * `ok:false` "sonuç yok" DEĞİLDİR — indeks kurulmadıysa arayüz bunu söylemeli.
   */
  query: (payload) => ipcRenderer.invoke('searchIndex:query', payload),
  /** → { running, phase, sessionsEnabled, dbFile, dbBytes, stats, lastResult }. */
  status: () => ipcRenderer.invoke('searchIndex:status'),
  /** Arka plan kurulumunu başlat → { ok, dbFile } | { ok:false, reason }. */
  reindex: () => ipcRenderer.invoke('searchIndex:reindex'),
  /** Board anlık görüntüsü (işçi Supabase'e bağlanmaz) → { ok, rows }. */
  syncTasks: (rows) => ipcRenderer.invoke('searchIndex:syncTasks', rows),
  /** OPT-OUT: false → oturum belgeleri indeksten SİLİNİR (gizlenmez). */
  setSessionsEnabled: (enabled) => ipcRenderer.invoke('searchIndex:setSessionsEnabled', enabled),
  /** İlerleme akışı: { phase:'start'|'progress'|'done'|'error'|'exit', source?, … }. */
  onEvent: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('searchIndex:event', listener);
    return () => ipcRenderer.removeListener('searchIndex:event', listener);
  },
});
