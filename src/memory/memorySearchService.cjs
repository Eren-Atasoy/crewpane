// CrewPane — ADP-871 (Faz 3) HAFIZA ARAMA SERVİSİ (main taraf).
//
// İŞ BÖLÜMÜ — nerede ne koşar ve NEDEN:
//   • KELİME katmanı (FTS5/BM25) → MAIN. Saf SQLite, ölçüldü ~5 ms, model gerekmez.
//   • ANLAM katmanı vektör taraması → MAIN. 4 440 parça × 1024 boyut kaba kuvvet,
//     ölçüldü ~30 ms (≈2 kare). Kullanıcının BAŞLATTIĞI tek bir arama için kabul.
//   • SORGU GÖMME → ÇOCUK SÜREÇ. Tek bloklayan iş budur (model yükü 543 MB, ilk
//     yükleme ONLARCA saniye). ADP-870 §4c bunun main'de ne yaptığını ölçtü.
//
// SICAK OLMAYAN İLK SORGU CEVAPSIZ KALMAZ: model henüz yüklenirken (ya da hiç kurulu
// değilken) arama YALNIZ kelime katmanıyla döner ve sonuç `degraded:true` ile
// işaretlenir. "Model hazır olana kadar bekle" tasarımı, kullanıcıya boş ekranda
// onlarca saniye baktırırdı; elimizdeki cevabı vermek her zaman daha iyidir.

'use strict';

const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');

const store = require('./memoryIndexStore.cjs');
const hybrid = require('./memoryHybrid.cjs');
const qvecCache = require('./memoryQueryVectorCache.cjs');
const { indexDbPath } = require('./memoryIndexService.cjs');

/** Boşta bu kadar süre sonra gömme çocuğu kapatılır (≈1.6 GB RAM geri verilir). */
const IDLE_MS = 5 * 60 * 1000;

// ── ONNX-CRASH-02 · YENİDEN DOĞURMA FRENİ ────────────────────────────────────
// ÖLÇÜLDÜ (05.09.2026, 20:58–21:22): gömme çocuğu 18 kez arka arkaya çöktü ve her
// düşüşte ANINDA yenisi doğdu. Fren yoktu: `child.on('exit')` → `settleReady()` →
// `warmQuery` döngüsü uyanır → `ensureChild()` → yeni fork. Çocuk ~1,2 sn'de öldüğü
// için 120 saniyelik tavan boyunca onlarca 543 MB'lık model yüklemesi denenir; her
// biri macOS'ta AYRI bir çökme raporu (ve müşteride ayrı bir sistem diyaloğu) demek.
//
// İki fren: (1) ardışık çöküşte ÜSTEL geri çekilme, (2) N'inci çöküşte DEVRE KESİCİ —
// katman kapanır, sebep kullanıcıya SÖYLENİR (sessiz ölüm yasak). Kesici `reset()`
// ile açılır: model yeniden kurulunca / kullanıcı katmanı tekrar açınca main çağırır.
const SPAWN_BACKOFF_BASE_MS = 500;
const SPAWN_BACKOFF_MAX_MS = 30000;
const MAX_CONSECUTIVE_CRASHES = 5;

/** Ardışık `n`. çöküşten sonra beklenecek süre (üstel, tavanlı). */
function backoffMs(n, { base = SPAWN_BACKOFF_BASE_MS, max = SPAWN_BACKOFF_MAX_MS } = {}) {
  if (n <= 0) return 0;
  return Math.min(max, base * 2 ** (n - 1));
}

function createSearchService({
  homedir = undefined, // SMOKE-ISO-01 — CREWPANE_HOME'u gölgeleme
  repoRoot = null,
  workerPath = path.join(__dirname, 'memoryEmbedWorker.cjs'),
  execPath = process.execPath,
  spawnImpl = null,
  idleMs = IDLE_MS,
  logLine = () => {},
  // ADP-900 — KULLANICI KATMANI KAPATABİLİR. Model diskte dursa bile "şimdi kullanma"
  // demek geçerli bir tercihtir (1,6 GB RAM). Predicate HER ÇAĞRIDA sorulur, açılışta
  // bir kez değil: kullanıcı Ayarlar'dan kapatınca etkisi ANINDA olsun (yeniden
  // başlatma yok) — kapatma o an koşan çocuğu da düşürür.
  semanticEnabled = () => true,
  // WIN-W6A — ÇOCUĞA SIR KÖPRÜSÜ. Gömme çocuğu `fork` ile doğar ve orada
  // `require('electron')` YOKTUR → `safeStorage` KASASI okunamaz. Kasadaki anahtarı
  // yalnız ANA süreç çözebilir; bu seam onu çocuğun ortamına koyar. Anahtar yoksa
  // `{}` döner ve çocuk kapıyı kendisi dener (Ayarlar / keys.env kaynakları oradan
  // da görünür). Sır loglanmaz, IPC'de dolaşmaz — yalnız kendi çocuğumuzun env'i.
  //
  // 🪤 Varsayılan BOŞ ve bu modül kapıyı REQUIRE ETMEZ — gerekçe
  // memoryIndexService.cjs'teki aynı seam'in notunda (paketleme kapanışı).
  hostedKeyEnv = () => ({}),
  // ONNX-CRASH-02 — fren ayarları (testte küçültülür).
  maxCrashes = MAX_CONSECUTIVE_CRASHES,
  backoffBaseMs = SPAWN_BACKOFF_BASE_MS,
  backoffMaxMs = SPAWN_BACKOFF_MAX_MS,
  now = () => Date.now(),
} = {}) {
  let child = null;
  let ready = false;
  let unavailable = null; // { reason, message } — çocuk motoru bulamadı
  let engineInfo = null; // WIN-W6A — hangi dal koşuyor (yerel / barındırılan + sağlayıcı)
  let seq = 0;
  const pending = new Map(); // id -> {resolve, timer}
  let idleTimer = null;
  const dbs = new Map(); // dbFile -> { db, lexReady }
  const warming = new Map(); // qvec dosyası -> uçuştaki warmQuery sözü (stampede önleme)
  // ONNX-CRASH-02 — fren durumu
  let crashes = 0; // ardışık, HAZIR OLMADAN ölen çocuk sayısı (ready gelince sıfırlanır)
  let nextSpawnAt = 0; // bu ana kadar yeni çocuk doğurulmaz
  let backoffTimer = null;
  let lastCrash = null; // { code, signal, stderr } — sebebi kullanıcıya taşımak için
  let lastFatal = null; // çocuğun bildirdiği son yakalanmamış istisna mesajı

  // ADP-872 — "model hazır oldu / olamayacak" olayını bekleyenler. Yoklama yerine
  // uyandırma: bekleyen taraf durum DEĞİŞİR DEĞİŞMEZ öğrenir (bkz. warmQuery notu).
  const readyWaiters = new Set();
  function settleReady() {
    for (const w of [...readyWaiters]) w();
    readyWaiters.clear();
  }

  /** `ready`/`unavailable` değişene ya da tavan dolana kadar bekle. Asla fırlatmaz. */
  function waitForReady(timeoutMs) {
    if (ready || unavailable) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        readyWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(1, timeoutMs));
      readyWaiters.add(done);
    });
  }

  function touchIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stopChild(), idleMs);
    idleTimer.unref?.();
  }

  function stopChild() {
    if (!child) return;
    const c = child;
    // ONNX-CRASH-02 — KASITLI kapanış (boşta kalma / 'bye' / dispose) ÇÖKÜŞ DEĞİLDİR:
    // sayacı işaretsiz bırakmak, normal boşta-kapanmaları da "çöktü" sayıp devre
    // kesiciyi yanlışlıkla attırırdı.
    c.__crewpaneStopping = true;
    child = null;
    ready = false;
    // 🪤 ÖLÇÜLDÜ (kanıt betiği yakaladı): kopmuş bir kanala `send` senkron HATA
    // FIRLATMAZ — asenkron bir 'error' olayı (EPIPE) yayar. try/catch onu tutamaz;
    // dinleyicisi olmayan 'error' olayı Node'da SÜRECİ ÖLDÜRÜR. Bu kod main'de
    // koştuğu için bedeli "uygulama kapanır" olurdu. İki savunma: bağlantı kontrolü
    // ve (aşağıda ensureChild'da) kalıcı bir 'error' dinleyicisi.
    try {
      if (c.connected) c.send({ type: 'bye' });
    } catch {
      /* yarışta koptu — zaten kapanıyor */
    }
    try {
      if (c.connected) c.disconnect?.();
    } catch {
      /* yok say */
    }
  }

  /** Katman kullanıcı tarafından kapalıysa true (model kurulu olsa bile). */
  function disabled() {
    try {
      return semanticEnabled() === false;
    } catch {
      return false; // predicate patlarsa özelliği kapatmayız, açık kalır
    }
  }

  function ensureChild() {
    // Kapalıyken çocuk HİÇ doğmaz → 1,6 GB RAM ayrılmaz. (Zaten koşuyorsa düşürülür.)
    if (disabled()) {
      if (child) stopChild();
      return;
    }
    if (child || unavailable) return;
    // ONNX-CRASH-02 — geri çekilme penceresi: dolmadan yeni çocuk DOĞURULMAZ.
    // Pencere dolunca kendiliğinden bir deneme yapılır ve bekleyenler uyandırılır
    // (yoksa `warmQuery` döngüsü tavanı boşuna beklerdi).
    const wait = nextSpawnAt - now();
    if (wait > 0) {
      if (!backoffTimer) {
        backoffTimer = setTimeout(() => {
          backoffTimer = null;
          ensureChild();
          settleReady();
        }, wait);
        backoffTimer.unref?.();
      }
      return;
    }
    const spawn = spawnImpl || ((mod, argv, opts) => fork(mod, argv, opts));
    const args = repoRoot ? ['--repo', repoRoot] : [];
    try {
      child = spawn(workerPath, args, {
        execPath,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...hostedKeyEnv() },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
    } catch (err) {
      unavailable = { reason: err.message };
      return;
    }
    // 🪤 ONNX-CRASH-02 — çocuk referansı DOĞUŞTA yakalanır. `stopChild` (boşta kapanma)
    // `child`i null'a çeker ve exit ONDAN SONRA gelir: dinleyici `child`i okusaydı
    // null görür, kasıtlı kapanışı ÇÖKÜŞ sayar ve devre kesici haksız yere atardı
    // (bu satır olmadan `boşta kapanma çöküş sayılmaz` testi KIRMIZI).
    const proc = child;
    // Dinleyicisiz 'error' olayı süreci öldürür (yukarıdaki not) — kanal hatası
    // bizim için yalnız "çocuk gitti" demek; arama kelime katmanıyla sürer.
    child.on('error', (err) => {
      logLine(`memorySearch: gömme kanalı hatası (${err.code || err.message}) — kelime katmanına düşülüyor`);
      stopChild();
    });
    child.on('message', (msg) => {
      if (!msg) return;
      if (msg.type === 'ready') {
        ready = true;
        // ONNX-CRASH-02 — sağlıklı bir yükleme geçmişi TEMİZLER (aksi halde günler
        // içinde biriken tekil düşüşler kesiciyi haksız yere attırırdı).
        crashes = 0;
        nextSpawnAt = 0;
        lastCrash = null;
        proc.__crewpaneReady = true;
        settleReady(); // ADP-872 — warmQuery bekliyorsa ANINDA uyansın
        engineInfo = { kind: msg.kind || 'local', provider: msg.provider || null, model: msg.model, dtype: msg.dtype, dim: msg.dim };
        logLine(
          `memorySearch: gömme hazır (${msg.kind === 'hosted' ? `barındırılan · ${msg.provider}` : 'yerel'} · ${msg.model} ${msg.dtype}, ${msg.loadMs} ms${msg.maxTokens ? `, tavan ${msg.maxTokens} jeton` : ''})`,
        );
        return;
      }
      if (msg.type === 'unavailable') {
        // WIN-W6A — `message` kullanıcıya GÖSTERİLECEK cümledir (ör. "anahtar
        // gerekli"); `reason` makine kodudur. İkisi ayrı taşınır, biri diğerinin
        // yerine geçmez.
        unavailable = { reason: msg.reason, message: msg.message || null, settingsTarget: msg.settingsTarget || null };
        settleReady(); // ADP-872 — "olmayacak" da bir cevaptır; bekleyen tavanı beklemesin
        logLine(`memorySearch: gömme yok (${msg.reason}) — yalnız kelime katmanı`);
        stopChild();
        return;
      }
      // ONNX-CRASH-02 — çocuğun YAKALANMAMIŞ istisnası artık mesaj olarak geliyor
      // (childIpcSafe.installChildGuards). Eskiden böyle bir mesaj yoktu ve sebep
      // yalnız macOS çökme raporunda kalıyordu; şimdi log'da duruyor.
      if (msg.type === 'error' && msg.fatal) {
        lastFatal = String(msg.reason || '').slice(0, 400);
        logLine(`memorySearch: gömme çocuğunda ÖLÜMCÜL hata (${msg.kind}): ${lastFatal}`);
        return;
      }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg.type === 'vector' ? Float32Array.from(msg.vec) : null);
    });
    let lastStderr = '';
    child.stderr?.on('data', (b) => {
      const line = String(b).trim();
      if (line) lastStderr = line.split('\n').slice(-3).join(' | ').slice(0, 400);
      logLine(`memorySearch[stderr] ${line}`);
    });
    child.on('exit', (code, signal) => {
      const c = proc;
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.resolve(null);
      }
      pending.clear();
      child = null;
      ready = false;
      // ── ONNX-CRASH-02 — FREN ────────────────────────────────────────────────
      // "Çöküş" = KASITSIZ ve HAZIR OLMADAN ölüm. Boşta kapanma (`stopChild`) ve
      // motoru bulamayıp `unavailable` diyen dürüst çıkış çöküş SAYILMAZ.
      const stopping = Boolean(c && c.__crewpaneStopping);
      const wasReady = Boolean(c && c.__crewpaneReady);
      const crashed = !stopping && !wasReady && !unavailable;
      if (crashed) {
        crashes += 1;
        lastCrash = { code, signal: signal || null, stderr: lastStderr || null, fatal: lastFatal };
        const how = signal ? `sinyal ${signal}` : `çıkış ${code}`;
        if (crashes >= maxCrashes) {
          // DEVRE KESİCİ. Katman kapanır; sebep kullanıcıya GÖSTERİLİR (arama
          // `message` alanıyla döner). `reset()` çağrılana kadar çocuk doğmaz.
          unavailable = {
            reason: 'embedder_crash_loop',
            message:
              `Anlam araması kapatıldı: gömme süreci ${crashes} kez üst üste çöktü (${how}` +
              `${lastStderr ? `; son hata: ${lastStderr}` : ''}). Arama yalnız kelime katmanıyla sürüyor.`,
            settingsTarget: null,
            lastCrash,
          };
          logLine(`memorySearch: DEVRE KESİCİ attı — gömme çocuğu ${crashes} kez üst üste çöktü (${how})`);
        } else {
          const wait = backoffMs(crashes, { base: backoffBaseMs, max: backoffMaxMs });
          nextSpawnAt = now() + wait;
          logLine(`memorySearch: gömme çocuğu çöktü (${how}) — ${crashes}/${maxCrashes}, ${wait} ms sonra yeniden denenecek`);
        }
      }
      settleReady(); // ADP-872 — çocuk öldü: bekleyen yeniden denesin, tavanı beklemesin
    });
  }

  /**
   * Sorgu vektörü. Motor HAZIR DEĞİLSE beklemez, null döner (arama kelime katmanıyla
   * sürer) — ama çocuğu ısınmaya başlatır, böylece sıradaki arama tam hibrit olur.
   */
  function embedQuery(text, timeoutMs) {
    ensureChild();
    touchIdle();
    if (!child || !ready) return Promise.resolve(null);
    const id = ++seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(null); // yavaş gömme aramayı KİLİTLEMEZ, küçültür
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, timer });
      try {
        child.send({ type: 'embed', id, text, at: Date.now() });
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        resolve(null);
      }
    });
  }

  function openDb(workspaceRoot) {
    const file = indexDbPath({ workspaceRoot, homedir });
    let entry = dbs.get(file);
    if (entry) return { ...entry, file };
    const opened = store.openIndexForSearch({ file });
    if (!opened) return { db: null, file };
    // Faz 2'de kurulmuş bir indekste kelime tablosu YOKTUR; gömme gerektirmeden,
    // saniyeler içinde chunks'tan doldurulur (ADP-871 §4a: 4 440 parça / 0.5 sn).
    let lex = null;
    try {
      lex = store.ensureLexIndex(opened.db);
    } catch (err) {
      logLine(`memorySearch: leksik geri-doldurma başarısız: ${err.message}`);
    }
    entry = { db: opened.db, lex };
    dbs.set(file, entry);
    return { ...entry, file };
  }

  /**
   * HİBRİT ARAMA.
   * @returns {Promise<{ok:boolean, results?:Array, text?:string, degraded?:boolean, reason?:string}>}
   */
  async function search({ workspaceRoot, query, k = 5, embedTimeoutMs = 2000 } = {}) {
    const q = String(query || '').trim();
    if (!q) return { ok: false, reason: 'empty_query' };

    const { db, file } = openDb(workspaceRoot);
    if (!db) return { ok: false, reason: 'index_not_built', dbFile: file };

    const queryVec = await embedQuery(q, embedTimeoutMs);
    const { results, sources } = hybrid.searchHybrid(db, { queryText: q, queryVec, k });
    return {
      ok: true,
      results,
      text: hybrid.formatResults(results, { max: k }),
      // Anlam katmanı bu sorguya katılamadıysa çağıran BİLMELİ — sessizce yarım
      // cevap vermek, ölçülen kaliteyi (%76.7) vaat edip %50 teslim etmektir.
      degraded: !queryVec,
      reason: queryVec ? undefined : disabled() ? 'semantic_disabled' : unavailable?.reason || 'embedder_warming',
      // WIN-W6A — "neden yarım cevap" sorusunun KULLANICI cevabı. Yalnız gerçekten
      // bir cümlemiz varsa dolar; yoksa `undefined` (uydurma metin YOK).
      message: queryVec ? undefined : unavailable?.message || undefined,
      settingsTarget: queryVec ? undefined : unavailable?.settingsTarget || undefined,
      sources,
      lexical: store.hasLexIndex(db),
    };
  }

  /**
   * ADP-872 — SPAWN sorgusunun vektörünü ÖNBELLEĞE al.
   *
   * Spawn yolu senkrondur ve gömme modelini bekleyemez (543 MB, onlarca saniye).
   * Bu yüzden spawn kelime katmanıyla koşar ve BURAYI ateşler; vektör diske
   * yazılınca SONRAKİ spawn tam hibrit olur (bkz. memoryQueryVectorCache.cjs).
   *
   * Aynı sorgu için tek uçuş: N pane aynı anda açılırsa modeli N kez ısıtmayız.
   * @returns {Promise<{ok:boolean, cached?:boolean, dims?:number, reason?:string}>}
   */
  async function warmQuery({ workspaceRoot, query, timeoutMs = 120000, cache = qvecCache } = {}) {
    const q = String(query || '').trim();
    if (!q) return { ok: false, reason: 'empty_query' };
    // ADP-900 — kapalıyken BEKLEME: aşağıdaki döngü `ready` olmayacağı için
    // 120 saniye boyunca boşuna dönerdi (ve spawn ısıtması hiç sonuçlanmazdı).
    if (disabled()) return { ok: false, reason: 'semantic_disabled' };
    let file;
    try {
      file = cache.vectorPath({ workspaceRoot, homedir, query: q });
      if (cache.readVector({ file })) return { ok: true, cached: true };
    } catch (err) {
      return { ok: false, reason: `cache_path_failed: ${err.message}` };
    }
    if (warming.has(file)) return warming.get(file);

    const run = (async () => {
      ensureChild();
      touchIdle();
      const deadline = Date.now() + timeoutMs;
      // Model yüklenene kadar bekle — SPAWN'ı değil, yalnız bu arka-plan işini.
      //
      // 🪤 Bekleme OLAY-GÜDÜMLÜdür, YOKLAMA (polling) DEĞİL. İlk sürüm 250 ms'de bir
      // yokluyordu ve kapı iki ayrı kusur gösterdi: (1) yoklama timer'ı `unref()`li
      // olduğu için gömme çocuğu kapanınca süreç await'in ORTASINDA çıkıyor ve söz HİÇ
      // sonuçlanmıyordu (gerçek koşuda görüldü); (2) `ready` iki yoklama ARASINDA
      // boşta-kapatma sayacına yem oluyor, `ensureChild` yenisini doğuruyor ve 543 MB'lık
      // model tekrar tekrar yükleniyordu (tek warmQuery, 10+ spawn — ölçüldü).
      // `touchIdle()` her turda çağrılır: model yüklenirken geçen süre "boşta" değildir.
      while (Date.now() < deadline) {
        ensureChild();
        touchIdle();
        if (unavailable) break;
        if (ready) break;
        await waitForReady(Math.max(50, deadline - Date.now()));
      }
      if (unavailable) return { ok: false, reason: unavailable.reason };
      if (!ready) return { ok: false, reason: 'embedder_timeout' };
      const vec = await embedQuery(q, Math.max(1000, deadline - Date.now()));
      if (!vec) return { ok: false, reason: 'embed_failed' };
      const written = cache.writeVector({ file, vec });
      logLine(`memorySearch: spawn sorgu vektörü önbelleğe ${written ? 'yazıldı' : 'YAZILAMADI'} (${vec.length} boyut)`);
      return { ok: written, cached: false, dims: vec.length };
    })().finally(() => warming.delete(file));

    warming.set(file, run);
    return run;
  }

  function status() {
    return {
      embedderReady: ready,
      embedderRunning: Boolean(child),
      unavailable: unavailable?.reason || null,
      unavailableMessage: unavailable?.message || null,
      // ONNX-CRASH-02 — fren durumu görünür: "neden hâlâ kelime katmanı" sorusunun
      // cevabı panelde de okunabilsin.
      crashes,
      crashLoop: unavailable?.reason === 'embedder_crash_loop',
      lastCrash,
      retryInMs: nextSpawnAt > now() ? nextSpawnAt - now() : 0,
      // WIN-W6A — panel "yerel mi, barındırılan mı" ayrımını GÖRSÜN (aynı ikon
      // altında iki farklı gerçeklik göstermeyelim).
      engine: engineInfo,
      semanticEnabled: !disabled(), // ADP-900 — "kapalı katman" ile "eksik özellik" farkı
      openIndexes: [...dbs.keys()],
    };
  }

  /**
   * ADP-900 — motor durumunu SIFIRLA. Kullanıcı modeli yeni indirdiğinde (ya da
   * sildiğinde) bu servis eski kararını hatırlıyordu: bir kez `model_not_downloaded`
   * görülmüşse `unavailable` kalıcıydı ve UYGULAMA YENİDEN BAŞLATILMADAN anlam katmanı
   * açılmıyordu. Kurulum bitince main burayı çağırır.
   */
  function reset() {
    unavailable = null;
    engineInfo = null;
    // ONNX-CRASH-02 — devre kesiciyi de aç: kullanıcı modeli yeniden kurduğunda /
    // katmanı tekrar açtığında eski çöküş geçmişi yeni denemeyi engellememeli.
    crashes = 0;
    nextSpawnAt = 0;
    lastCrash = null;
    clearTimeout(backoffTimer);
    backoffTimer = null;
    stopChild();
    settleReady();
  }

  function dispose() {
    clearTimeout(idleTimer);
    clearTimeout(backoffTimer);
    backoffTimer = null;
    stopChild();
    for (const [, e] of dbs) {
      try {
        e.db.close();
      } catch {
        /* zaten kapalı */
      }
    }
    dbs.clear();
  }

  return { search, warmQuery, status, reset, dispose };
}

module.exports = { IDLE_MS, MAX_CONSECUTIVE_CRASHES, SPAWN_BACKOFF_BASE_MS, SPAWN_BACKOFF_MAX_MS, backoffMs, createSearchService };
