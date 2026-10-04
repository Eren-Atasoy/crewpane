'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ptyApi', {
  /**
   * Ask main to spawn a pty. ADP-013: opts may carry an agent-aware shape
   * `{ cols, rows, command: 'shell'|'claude'|'codex', args, cwd, env, agentId,
   * department, label }`. With no `command` it stays the ADP-003 login shell.
   * A disallowed `command` REJECTS the promise (main-side RCE guard).
   * Resolves to `{ paneId, pid, command, shell, agentId, department }`.
   */
  spawn: (opts) => ipcRenderer.invoke('pty:spawn', opts),

  /**
   * ADP-028 — attach to an existing pane (instead of spawning). Resolves to
   * `{ ok, buffer, seq, agentId, department, command, label }` so the renderer
   * can replay recent output and dedupe live events. `{ ok:false }` if the pane
   * is gone (caller falls back to a fresh spawn).
   */
  attach: (paneId) => ipcRenderer.invoke('pty:attach', paneId),

  /**
   * TERM-BLANK-01 — pane'in AKIŞ DEFTERİ: `{ ok, bytes, lastDataAt }`.
   * Nöbetçi "pty üretti ama bu renderer hiç almadı" hükmünü buradan kurar
   * (renderer kendi ALMADIĞINI ölçemez). Salt-okunur; pane yoksa `{ ok:false }`.
   */
  streamStat: (paneId) => ipcRenderer.invoke('pty:streamStat', paneId),

  /**
   * ADP-280 — teslim-doğrulama: pane'in claude transcript'inde `needle` geçiyor mu?
   * → { found, checked, file }. checked=false = transcript henüz yok/bakılamadı
   * (yanlış 'undelivered' üretme). Pane→sessionId/cwd çözümü main'de.
   */
  transcriptContains: (paneId, needle) => ipcRenderer.invoke('pty:transcriptContains', paneId, needle),

  /**
   * ADP-306 — pane'in claude transcript'indeki SON asistan mesajı
   * → { checked, text, file, engine }. checked=false = transcript yok/bakılamadı
   * (motor claude değil ya da henüz yazmadı) → çağıran buffer-parse'a düşer.
   */
  lastTranscriptMessage: (paneId) => ipcRenderer.invoke('pty:lastTranscriptMessage', paneId),

  /**
   * ADP-401 — masaüstü OKUMA MODU sayfası: pane'in claude oturum defterinden
   * yapılandırılmış sohbet öğeleri (mobil transcript ile aynı çekirdek).
   * `opts = { limit?, before? }` (before = bayt imleci, geriye sayfalama).
   * → { supported, items, firstOff, hasMore, file } · null = pane yok.
   * supported:false → çağıran ham VT görünümüne düşer (codex/shell).
   */
  transcriptPage: (paneId, opts) => ipcRenderer.invoke('pty:transcriptPage', paneId, opts),

  /**
   * ADP-887 — pane'in JETON/MALİYET künyesi (başlıktaki 'i' kartı).
   * → { engine, engineLabel, billing, measured, session:{tokens,usd,models},
   *     total:{…}, priceSource, plan, match } · null = pane yok.
   * 🔴 `usd: null` HATA DEĞİLDİR (abonelik / fiyatsız motor / ölçülemedi) —
   * çağıran sayı yerine gerekçeyi yazar; 0$ basmak YASAK.
   */
  tokenUsage: (paneId) => ipcRenderer.invoke('pty:tokenUsage', paneId),
  // TOK-C — pane bütçesi: oku / kur / "devam et". Karar MAIN'de verilir; renderer
  // yalnız gösterir ve düğmeye basar (eşik hesabı renderer'da KOPYALANMAZ).
  budget: (payload) => ipcRenderer.invoke('pty:budget', payload),

  /* TOK-B (D-03) — DAĞITIM POLİTİKASI: yeni iş gelince "aynı pane'de sürdür" mü
     "taze oturum" mu. Karar MAIN'de, ÖLÇÜMLE verilir (bağlam/boşta/istek/ilişki);
     renderer yalnız uygular. Eşikler `modelPricing.contextEconomics.dispatch`. */
  /** Plan al: `{action:'continue'|'refresh'|'unmeasured', handoff, code, reasons…}` · null = pane yok. */
  dispatchPlan: (payload) => ipcRenderer.invoke('pty:dispatchPlan', payload),
  /** Kararı UYGULA: (varsa) tek istekle devir özeti + `/clear`. Kararı main yeniden ölçer. */
  dispatchRefresh: (payload) => ipcRenderer.invoke('pty:dispatchRefresh', payload),
  /** İş pane'e YAZILDI — bir sonraki ilişki ölçümünün kıyas tabanı (fire-and-forget). */
  dispatchRecord: (paneId, text) => ipcRenderer.send('pty:dispatchRecord', { paneId, text }),

  /* DELEG-DELIVER-01 — HAZIR-KAPI KARARI MAIN LOG'A. Bu yolun (taze pane'e prompt
     yazımı) üretimde TEK BİR log satırı yoktu: `engineReadyRunner` `console.info`
     basıyor, o da main log'a düşmüyor ([renderer console] köprüsü yalnız AUTOTEST'te
     bağlanır) → 06.09'un 6 teslim düşüşünde yazımın NE ZAMAN ve pane HANGİ durumdayken
     yapıldığı görülemedi. Tek yön, ateşle-unut; hiçbir şey döndürmez. */
  /** `{paneId, verdict, waitedMs, tailLen, sawBytes, blockers}` → main log satırı. */
  deliveryTrace: (payload) => ipcRenderer.send('pty:deliveryTrace', payload),

  /* D-07 (SPRINT-TOK-01) — AŞAMA B: HAFIZA SEÇKİSİ GÖREV METNİYLE.
     Spawn'da seçki YAPILMAZ (görev metni o an yok — D-04'ün ölçtüğü kök neden);
     iş dağıtılmadan hemen önce burası çağrılır ve seçki İŞİN KENDİSİYLE yapılır.
     Eşiği geçen kayıt yoksa `text:''` döner → prompt'a hiçbir şey eklenmez. */
  /** → `{ ok, text, slugs, stats:{kept, considered, threshold, reason, chars} }` */
  memoryTaskBlock: (payload) => ipcRenderer.invoke('memory:taskBlock', payload),

  /**
   * ADP-013 — list live panes for this window, optionally filtered by
   * department (team→pane-set for ADP-012). Resolves to an array of
   * `{ paneId, agentId, department, command, label, pid, startedAt, status }`.
   */
  list: (department) => ipcRenderer.invoke('pty:list', department),

  /**
   * ORPHAN-ELECTRON-01 — YETİM Electron biçme (süpervizör yolu).
   * `{op:'baseline'}` → `{ok, pids, scanned}` (dispatch anındaki taban)
   * `{op:'reap', excludePids, olderThanMs}` → `{ok, reaped:[{pid, how, …}], scanned}`
   * Karar MAIN'de verilir (süreç ölçümü orada); renderer yalnız sorar.
   */
  reapOrphanElectrons: (payload) => ipcRenderer.invoke('pty:reapOrphanElectrons', payload),

  /** ADP-013 — (re)bind a live pane to an agent/department/label after spawn. */
  bind: (paneId, binding) =>
    ipcRenderer.send('pty:bind', { paneId, ...(binding || {}) }),

  /**
   * Keyboard / paste input from xterm → pty (routed by paneId).
   *
   * TOK-C (D-02 v2) — `opts.origin:'system'` bu yazımın İNSAN TUŞU DEĞİL otomasyon
   * olduğunu beyan eder (görev dağıtımı: taskAssignment → sendCommand). Main o
   * beyanı görürse bütçe frenini uygular. Beyan YOKSA yazım insan sayılır ve
   * geçer — güvenli taraf budur (yanlış tarafa düşmenin bedeli, kullanıcının
   * tuşunun sessizce yutulmasıdır).
   */
  write: (paneId, data, opts) =>
    ipcRenderer.send('pty:input', {
      paneId,
      data,
      origin: opts && opts.origin === 'system' ? 'system' : undefined,
    }),

  /**
   * ADP-692 — KORUMALI yazım: "kendiliğinden" gönderilen her metin (lider uyandırması)
   * bu yoldan geçer. Kapı (insan yazıyor mu / composer boş mu) ile yazım main'de AYNI
   * senkron blokta koşar → kullanıcının yarım prompt'unun ardına ASLA eklenemez.
   * `seenBuffer` = çağıranın son gördüğü buffer (CAS); değiştiyse yazım reddedilir.
   */
  writeGuarded: (paneId, text, opts) =>
    ipcRenderer.invoke('pty:writeGuarded', {
      paneId,
      text,
      seenBuffer: opts && typeof opts.seenBuffer === 'string' ? opts.seenBuffer : undefined,
      submit: !(opts && opts.submit === false),
    }),

  /** xterm fit → pty resize (routed by paneId). */
  resize: (paneId, size) =>
    ipcRenderer.send('pty:resize', { paneId, cols: size.cols, rows: size.rows }),

  /** Kill a single pty by paneId (terminal closed in the UI). */
  kill: (paneId) => ipcRenderer.send('pty:kill', paneId),

  /** Subscribe to pty output for ALL panes. cb gets { paneId, data }. Returns unsubscribe. */
  onData: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('pty:data', listener);
    return () => ipcRenderer.removeListener('pty:data', listener);
  },

  /** Subscribe to pty exit for ALL panes. cb gets { paneId, code }. Returns unsubscribe. */
  onExit: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('pty:exit', listener);
    return () => ipcRenderer.removeListener('pty:exit', listener);
  },

  /**
   * ADP-303 — main asked for a pane to be brought to the front (the leader's
   * `crewpane_pane focus` → bridge → main). cb gets { paneId }. Returns unsubscribe.
   */
  onFocusRequest: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('pane:focus', listener);
    return () => ipcRenderer.removeListener('pane:focus', listener);
  },

  /**
   * ADP-192 — restart-resume notice: fired once on launch after main re-spawns the
   * agents that were running before shutdown. cb gets { count, agents:[{ agentId,
   * department, paneId, engine, resumed }] }. Returns unsubscribe.
   */
  onPanesRestored: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('panes:restored', listener);
    return () => ipcRenderer.removeListener('panes:restored', listener);
  },

  /**
   * ADP-734 Kapı 2 — KURTARILABİLİR PANE TEKLİFİ. Açılışta bulunan bayat bir kayıt
   * ya da defterin sessizce boşalması: main pane AÇMAZ, bunu yollar. cb gets
   * { count, reason, source, agents:[{agentId, department, engine, sessionId}] }.
   * Kabul → `restoreRecoverablePanes()`. Returns unsubscribe.
   */
  onPanesRecoverable: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('panes:recoverable', listener);
    return () => ipcRenderer.removeListener('panes:recoverable', listener);
  },

  /** ADP-734 — teklifi uygula: bekleyen pane'leri gerçekten aç. */
  restoreRecoverablePanes: () => ipcRenderer.invoke('panes:restoreRecoverable'),

  /**
   * ADP-335 — MODÜL HATASI. main'deki bir modül (VT harvest, gateway, store…)
   * kod hatası verdi: uygulama YAŞIYOR, o özellik degrade. cb gets
   * { module, label, message, location:'electron/paneScreen.cjs:87', stopped, at }.
   * Bildirim merkezinde dürüst tek satır olarak görünür; tıklanınca log açılır.
   */
  onModuleFault: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('module:fault', listener);
    return () => ipcRenderer.removeListener('module:fault', listener);
  },
  /** Bildirime tıklanınca: hata log'unu aç (dosya:satır zaten bildirimde). */
  openFaultLog: () => ipcRenderer.invoke('module:openLog'),
  /** Açılışta kaçırılan hatalar (son 20). */
  moduleFaults: () => ipcRenderer.invoke('module:faults'),

  /**
   * ADP-428 — limit auto-resume yaşam döngüsü olayları (main pty daemon).
   * cb gets { kind: 'continue'|'respawn'|'select'|'fail', paneId, agentId, detail }.
   * 'fail' = daemon gönderim bütçesini tüketti → UI yapışkan uyarı göstermeli
   * (ajan İNSAN "devam et"i bekliyor). Returns unsubscribe.
   */
  onResumeEvent: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('resume:event', listener);
    return () => ipcRenderer.removeListener('resume:event', listener);
  },

  /**
   * TOK-C (D-02 v2) — BÜTÇE OLAYLARI (main → renderer).
   * cb gets { kind:'blocked', source, paneId, agentId, budget }.
   *
   * Neden olay, neden yalnız ölçüm turu değil: ölçüm turu 90 saniyede bir koşar;
   * duraklatmanın GERÇEKTEN olduğu an ise sistemin o pane'e yazmaya çalıştığı
   * andır. Ofis balonu o anda çıkmazsa kullanıcı, durmuş bir ajanın sprite'ında
   * bir buçuk dakika boyunca "çalışıyor" okur. Returns unsubscribe.
   */
  onBudgetEvent: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('pty:budget-event', listener);
    return () => ipcRenderer.removeListener('pty:budget-event', listener);
  },
});

// ADP-593 — pane POP-OUT köprüsü: bir terminal pane'ini ayrı bir macOS penceresine
// çıkar / geri koy. YALNIZ PENCERE yönetir — pty spawn/kill YOK, dolayısıyla dışarı
// çıkarma da geri koyma da koşan ajanın oturumunu ASLA öldürmez (ADP-593 §2).
