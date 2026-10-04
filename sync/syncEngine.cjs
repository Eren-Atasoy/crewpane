// SYNC-F1-3 (Wheeljack) — ORKESTRASYON: push · pull · mutabakat · bootstrap · defter.
//                         Tasarım: SYNC-F1-TASARIM.md §2.3 · §2.4 · §2.5 · §2.6 · §3.2 · §5.4
//
// ═══════════════════════════════════════════════════════════════════════════════
// DEFTER (`ledger`) — bu motorun ÇEKİRDEK VERİSİ
// ═══════════════════════════════════════════════════════════════════════════════
//   remote[key] = { id, class, relPath, sha256, rev, updated_at }
// "En son senkronladığımızda bu yolun BULUTTAKİ hâli buydu." Üç ayrı soruya aynı
// anda cevap verir ve üçü de defter olmadan CEVAPSIZDIR:
//   1. EKO (§2.4): yerel sha == defterdeki sha ⇒ bu yazımı BİZ yaptık, geri itme.
//   2. ÇAKIŞMA (§3.2): yerel sha != defterdeki sha ⇒ yerel, son senkrondan SONRA
//      değişmiş; uzak satır da değiştiyse iki taraf ayrışmıştır.
//   3. SİLME (§2.5): defterde VAR, sunucu manifestinde YOK ⇒ uzakta silinmiş.
//      Defter olmasaydı "yerelde var, sunucuda yok" ifadesi "yeni yazıldı" ile
//      "uzakta silindi" arasında ayrım yapamaz, senkron da yeni dosyaları silerdi.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 SİLME KANALI DELTA DEĞİL, MUTABAKATTIR — ölçülmüş sapma (§2.5)
// ─────────────────────────────────────────────────────────────────────────────
// `crewpane_files_no_tombstones` RESTRICTIVE perdesi silinmiş satırı SELECT'ten
// tamamen kaldırıyor (2026-08-24 ölçümü: RPC tombstone -> 200 true; ardından
// `GET …select=id,rel_path,deleted_at` -> `[]`). Yani delta sorgusu bir silmeyi
// ASLA göremez. Silme şu iki yoldan öğrenilir:
//   · `countVisible()` UCUZ SONDASI — görünür satır sayısı defterden azsa,
//   · ve ardından `listManifest()` MUTABAKATI — hangi yolun düştüğü.
// `applyRemoteRow()` yine de `deleted_at` dalını TAŞIR: perdesiz bir yetkide
// (service_role / `app` ikizi) satır delta'ya düşebilir.
//
// ─────────────────────────────────────────────────────────────────────────────
// KURAL S-1 — DİZİN SİLİNMEZ
// ─────────────────────────────────────────────────────────────────────────────
// Tombstone uygulanırken DOSYA silinir, DİZİN bırakılır. Boş dizin zararsızdır;
// silinen dizin izleyiciyi öldürür (reportsWatcher.cjs:91-95'in ölçülmüş dersi) ve
// bir daha geri gelmez. Bu dosyada `rmdirSync`/`rm -r` YOKTUR ve olmayacaktır.
//
// Saf değil ama TAM DI: `client`/`queue`/`scanner`/`objectStore`/`fs`/`now` enjekte
// edilir -> `node --test` ağsız ve (sahte fs ile) disksiz koşar.

'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { atomicWriteFileSync } = require('../platform/atomicWrite.cjs');
const C = require('./syncClasses.cjs');
const P = require('./syncPaths.cjs');
const D = require('./syncDecide.cjs');
const { keyOf: scanKeyOf } = require('./syncScanner.cjs');
const Delta = require('./deltaCore.cjs');
const { createSyncPlanGate } = require('./syncPlanGate.cjs');

const STATE_VERSION = 1;

/** Mutabakat sıklığı (§2.5: "günde bir" + sapma sinyali). */
const RECONCILE_EVERY_MS = 24 * 60 * 60 * 1000;

/** Yedek poll (§2.5): realtime KANITLIYKEN 60 sn, kanıtsızken 5 sn (OFS-01). */
const POLL_FAST_MS = 5000;
const POLL_SLOW_MS = 60000;

function keyOf(classId, relPath) {
  return `${classId}|${relPath}`;
}

function emptyState(workspaceKey) {
  return {
    version: STATE_VERSION,
    workspaceKey: workspaceKey || null,
    cursor: null,
    remote: Object.create(null),
    secretAllow: [],
    heldPlatform: [],
    lastReconcileAt: 0,
    lastPullAt: 0,
    lastPushAt: 0,
  };
}

/**
 * @param {{roots:object, client:object, queue:object, scanner:object, objectStore:object,
 *          stateFile:string, scanCacheFile?:string, fs?:object, path?:object, now?:Function,
 *          transformIncoming?:Function,
 *          log?:Function, platform?:string, deviceId?:string, workspaceKey:string,
 *          onStatus?:Function, deriveIndexes?:Function, writeAtomic?:Function}} deps
 */
function createSyncEngine(deps = {}) {
  const fs = deps.fs || nodeFs;
  const path = deps.path || nodePath;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const platform = deps.platform || process.platform;
  const roots = deps.roots || {};
  const client = deps.client;
  const queue = deps.queue;
  const scanner = deps.scanner;
  const objectStore = deps.objectStore;
  const stateFile = deps.stateFile;
  const scanCacheFile = deps.scanCacheFile || null;
  const deviceId = deps.deviceId || null;
  const workspaceKey = deps.workspaceKey;
  const onStatus = typeof deps.onStatus === 'function' ? deps.onStatus : () => {};
  const writeAtomic = typeof deps.writeAtomic === 'function' ? deps.writeAtomic : atomicWriteFileSync;
  // F1-4'ün `memoryIndexDerive`i. Verilmezse NO-OP: MEMORY.md türetimi F1-4'ün işi,
  // burada TAKLİT EDİLMEZ (yarım bir türetici, indeksi bozardı).
  const deriveIndexes = typeof deps.deriveIndexes === 'function' ? deps.deriveIndexes : null;
  // SYNC-F1-7 — GELEN BAYT KANCASI. Verilmezse NO-OP (motorun davranışı bit-bit
  // eskisi). Verilirse `applyBytes` uzak baytı DİSKE YAZMADAN ÖNCE kancadan
  // geçirir ve dönen baytı yazar.
  //
  // 🔴 NEDEN "YAZDIKTAN SONRA DÜZELT" DEĞİL: tercih dokümanı ANAHTAR-SEVİYESİ
  // LWW ister (§5.5.2). Uzak baytı önce yazıp sonra birleştirseydik, iki yazım
  // arasında (a) izleyici uyanır, (b) çökme olursa yerel anahtarlar KAYBOLMUŞ
  // kalırdı. Kanca yazımdan ÖNCE olduğu için kayıp penceresi YOKTUR.
  //
  // Defter (`state.remote`) UZAK sha'yı taşımaya devam eder — kasıtlı: birleşim
  // uzaktan farklıysa bir sonraki tarama yerel sha'yı defterden FARKLI görür ve
  // birleşimi yükler. Kancanın çıktısını deftere yazsaydık birleşim asla
  // yükselmez, karşı cihaz kendi kaybettiği anahtarı bir daha görmezdi.
  const transformIncoming = typeof deps.transformIncoming === 'function' ? deps.transformIncoming : null;

  // ── TIER-SYNC-01 — PLAN KAPISI ──────────────────────────────────────────────
  //
  // `getPlanSnapshot` **ZORUNLU** bir bağımlılıktır, opsiyonel bir kolaylık değil.
  // Sebebi tek cümle: *"kapıyı bağlamayı unutmak" ile "özelliği bağlamayı unutmak"
  // aynı hata olmalı.* Opsiyonel olsaydı motoru bağlayan taraf (F1-6) bu satırı
  // yazmayı atlayınca senkron SESSİZCE herkese açılırdı — BL-02'nin dekoratif cap'i,
  // bu sefer ters yönden. Zorunlu olduğu için o hâl derleme anında imkânsız.
  //
  // Değeri `null` DÖNDÜREBİLİR ve bu meşrudur: `null` = zorlama yok (planLimits
  // KURAL 3, geliştirici kopyası/e2e/birim testi). Ayrım kritik: "kapı yok" ile
  // "kapı var, bu kurulumda kapalı" iki farklı şeydir; ilki hata, ikincisi karar.
  const planGate = createSyncPlanGate(
    typeof deps.getPlanSnapshot === 'function' ? deps.getPlanSnapshot : null,
  );
  // Reddin SESSİZ kalmaması için (main.js → pushPlanLimit → `plan:limit` kanalı).
  // Kısma (throttle) tüketicinin işidir: main zaten yetenek başına 60 sn frenler.
  const onPlanDenied = typeof deps.onPlanDenied === 'function' ? deps.onPlanDenied : () => {};

  for (const [name, v] of [['client', client], ['queue', queue], ['scanner', scanner], ['objectStore', objectStore]]) {
    if (!v) throw new Error(`syncEngine: ${name} zorunlu (DI)`);
  }
  if (!stateFile) throw new Error('syncEngine: stateFile zorunlu');
  if (!workspaceKey) throw new Error('syncEngine: workspaceKey zorunlu');

  let state = emptyState(workspaceKey);
  let scanCache = {};
  let realtimeSubscribed = false;
  let realtimeEvents = 0;
  let phase = 'idle';         // idle | pushing | pulling | reconciling | bootstrapping | offline | error
  let lastError = null;
  let conflictsOpen = 0;
  let running = false;        // tek uçuş nöbeti
  const counters = { pushed: 0, pulled: 0, deleted: 0, conflicts: 0, held: 0, echoSkips: 0 };

  // ── DURUM / KALICILIK ───────────────────────────────────────────────────────

  function setPhase(next, err) {
    phase = next;
    lastError = err ? String((err && err.message) || err).slice(0, 500) : (next === 'error' ? lastError : null);
    try { onStatus(getStatus()); } catch { /* dinleyici hatası motoru durdurmaz */ }
  }

  function loadState() {
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { raw = null; }
    if (!raw || raw.version !== STATE_VERSION) {
      // Bozuk/eski defter = BOŞ defter. Bedeli bir mutabakat turudur (her yol
      // yeniden öğrenilir), alternatifi açılışta ölen bir motordur.
      state = emptyState(workspaceKey);
    } else {
      state = {
        ...emptyState(workspaceKey),
        ...raw,
        remote: Object.assign(Object.create(null), raw.remote || {}),
        secretAllow: Array.isArray(raw.secretAllow) ? raw.secretAllow : [],
        heldPlatform: Array.isArray(raw.heldPlatform) ? raw.heldPlatform : [],
      };
      // Defter BAŞKA bir workspace'e aitse KULLANILMAZ: yolları karşı ağaca
      // uygulamak, senkronun en pahalı hata sınıfıdır (§1.2 sessiz birleşme).
      if (state.workspaceKey && state.workspaceKey !== workspaceKey) {
        log(`[sync] defter başka workspace'e ait (${state.workspaceKey} != ${workspaceKey}) — SIFIRLANDI`);
        state = emptyState(workspaceKey);
      }
      state.workspaceKey = workspaceKey;
    }
    if (scanCacheFile) scanCache = scanner.readCacheFile(scanCacheFile);
    queue.load();
    return state;
  }

  function saveState() {
    try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); } catch { /* var */ }
    writeAtomic(stateFile, JSON.stringify(state), { fs });
    queue.flushIfDirty();
  }

  function getStatus() {
    const q = queue.status();
    // TIER-SYNC-01 — ROZET YALAN SÖYLEMEZ. Plan kapalıyken durum `idle` olamaz:
    // "boşta" rozeti kullanıcıya "her şey eşitlendi" der, oysa hiç eşitlenmiyor.
    // Kilit HER ŞEYİN ÖNÜNDE okunur — kuyruk durmuş ya da ağ yokmuş, senkron zaten
    // bu pakette çalışmıyor; ikinci bir sebep göstermek teşhisi bulandırır.
    const planNow = planGate.check();
    return {
      enabled: true,
      // SYNC-CLOUD-01 — "bulut hazır değil" AYRI bir hâldir. `offline` demek
      // kullanıcıya "ağın yok" der ve yanlış yere baktırır: ağ çalışıyor, arka uç
      // bu şemayı sunmuyor. Rozet ancak ayrımı görürse doğru cümleyi kurabilir.
      state: !planNow.allowed
        ? 'plan_limit'
        : (q.disabled
          ? 'error'
          : (q.halted
            ? (q.halted.reason === 'cloud-not-ready' ? 'cloud_not_ready' : 'offline')
            : phase)),
      workspaceKey,
      queued: q.queued,
      halted: q.halted,
      disabled: q.disabled,
      cursor: state.cursor,
      lastPullAt: state.lastPullAt || null,
      lastPushAt: state.lastPushAt || null,
      lastReconcileAt: state.lastReconcileAt || null,
      files: Object.keys(state.remote).length,
      conflictsOpen,
      // OFS-01: kanal DURUMU değil, KANIT. `false` iken rozet "yedek modda" der (§2.8).
      realtimeProven: Delta.realtimeProven(realtimeSubscribed, realtimeEvents),
      pollMs: Delta.backupPollMs(Delta.realtimeProven(realtimeSubscribed, realtimeEvents), POLL_FAST_MS, POLL_SLOW_MS),
      counters: { ...counters },
      lastError,
      // TIER-SYNC-01 — KİLİT GÖSTERİLİR, GİZLENMEZ. Rozet/Ayarlar bu bloktan
      // "senkron neden kapalı + hangi pakette açılır + üst pakette kaç cihaz"
      // cümlesini kurar; kendi katman kontrolünü YAPMAZ (isim kontrolü yok).
      plan: (() => {
        const v = planNow;
        return {
          allowed: v.allowed,
          enforced: v.enforced,
          tier: v.tier,
          tierLabel: v.tierLabel,
          requiredTierLabel: v.requiredTierLabel,
          // Ultra avantajı: aynı anda kaç cihaz aynı hafızayı paylaşır (mevcut kadran).
          deviceSlots: v.deviceSlots,
          title: v.denial ? v.denial.title : null,
          message: v.denial ? v.denial.message : null,
        };
      })(),
    };
  }

  function noteRealtime({ subscribed, event } = {}) {
    if (typeof subscribed === 'boolean') realtimeSubscribed = subscribed;
    if (event) realtimeEvents += 1;
    return getStatus();
  }

  // ── YARDIMCILAR ─────────────────────────────────────────────────────────────

  /**
   * Ağacı tara ve manifesti MOTORUN ANAHTAR UZAYINA çevir.
   *
   * 🔴 İKİ AYRI ANAHTAR BİÇİMİ VAR ve karıştırmak SESSİZ BİR YIKIMDIR:
   * `syncScanner.keyOf` sınıf ile yolu bir NUL baytıyla birleştirir (kendi önbellek
   * dosyasının biçimi), motorun defteri ise `|` kullanır. Motor `scan.byKey`e kendi
   * anahtarıyla sorsaydı HİÇBİR eşleşme bulamaz, her turda (a) her dosyayı yeniden
   * yükler ve (b) defterdeki her yolu "yerelde yok" sanıp SİLERDİ. Ölçüldü: dönüşüm
   * eklenmeden önce ikinci `pushOnce()` turu defteri boşaltıyor ve bir tombstone
   * kuyruğa koyuyordu. Dönüşüm TEK yerde, burada yapılır.
   */
  function scanNow() {
    const res = scanner.scan({ cache: scanCache });
    scanCache = res.byKey;
    res.byKey = Object.create(null);
    for (const f of res.files) {
      res.byKey[keyOf(f.class, f.relPath)] = scanCache[scanKeyOf(f.class, f.relPath)];
    }
    if (scanCacheFile) {
      try { fs.mkdirSync(path.dirname(scanCacheFile), { recursive: true }); } catch { /* var */ }
      try { scanner.writeCacheFile(scanCacheFile, res.byKey, writeAtomic); } catch (err) { log(`[sync] tarama önbelleği yazılamadı: ${err.message}`); }
    }
    return res;
  }

  /**
   * SİLME NÖBETİ — "taramada yok" ne zaman "silinmiş" demektir?
   *
   * Bir sınıfın kökü hiç yoksa (accountRoot verilmemiş, workspace taşınmış, disk
   * bağlanmamış) o sınıfın TÜM dosyaları taramada görünmez. Nöbet olmasaydı senkron
   * bunu "kullanıcı hepsini sildi" diye okur ve buluttaki hafızayı tombstone'lardı.
   * Bu, geri alınabilir ama pahalı bir yıkımdır; kapı ucuzdur.
   */
  function deletableClasses() {
    const okClasses = [];
    for (const classId of C.fileBackedClasses()) {
      const dirs = C.classRoots(classId, roots, { platform });
      if (!dirs.length) continue;
      let anyExists = false;
      for (const { dir } of dirs) {
        try { if (fs.statSync(dir).isDirectory()) { anyExists = true; break; } } catch { /* yok */ }
      }
      if (anyExists) okClasses.push(classId);
    }
    return okClasses;
  }

  function readLocal(classId, relPath) {
    const r = P.resolveRelPath(classId, relPath, roots, { platform });
    if (!r.ok) return { ok: false, reason: r.reason };
    let buf;
    try { buf = fs.readFileSync(r.abs); } catch (err) {
      if (err && err.code === 'ENOENT') return { ok: false, reason: 'missing', abs: r.abs };
      return { ok: false, reason: 'unreadable', abs: r.abs, detail: String(err.message) };
    }
    return { ok: true, abs: r.abs, buf, sha256: D.sha256Of(buf), size: buf.length };
  }

  /**
   * 🔴 SYNC-ONB-01 — PUSH UZAKTAKİNİ ASLA KÜÇÜLTMEZ.
   *
   * ÖLÇÜLEN ARIZA (gerçek Postgres, `syncf17-prefs-two-device` T8): TAZE bir ikinci
   * cihaz açılışta kendi projeksiyonunu üretir ve İLK TURDA PUSH eder. Satır zaten
   * varsa yol şudur: INSERT → 23505 → `getByRelPath` (güncel rev ÖĞRENİLİR) →
   * KOŞULLU PATCH → **başarılı**. Koşullu PATCH burada hiçbir şeyi korumaz: revi
   * az önce öğrendik. Sonuç DB'den okundu:
   *
   *     D-push-öncesi : body'de `onboarding.progress` VAR   (position 597)
   *     D-push-sonrası: body'de `onboarding.progress` YOK   (position 0)
   *
   * Birinci cihazın kaydı BULUTTAN SİLİNDİ ve geri gelmedi — `mergeIncoming` yalnız
   * İNEN baytı birleştirdiği için. Dosya-seviyesi LWW'de "kaybeden" kurtarılabilir
   * (çakışma defteri); burada kaybeden bir DOSYA değil, kazanan dosyanın İÇİNDEKİ
   * anahtarlardır ve defter bunu göremez.
   *
   * ─── NEDEN "BİRLEŞTİRİP GÖNDER" DEĞİL, "ERTELE" ────────────────────────────
   * İki alternatif ÖLÇÜLDÜ ve İKİSİ DE regresyon verdi (`syncEngine.test.cjs`
   * SYNC-F1-7/2 kırmızı):
   *   (a) birleşimi gönder, diske YAZMA → defter "birleşimi gönderdim" der ama
   *       yerel dosya geride kalır; sonraki tur ESKİ dokümanı geri iter.
   *   (b) birleşimi gönder VE diske yaz → yerel doküman `settings.json`ın ÖNÜNE
   *       geçer; hemen ardından koşan `projectSettings()` taze değeri BAYAT ayarla
   *       yeniden damgalayıp geri alır.
   * Doğru olan üçüncüsü: bu turda HİÇ PUSH ETME. Uzak doküman zaten bizden
   * zengin; bir sonraki PULL onu İNEN yoldan getirir — orada hem birleştirme hem
   * `applyToSettings` sırası doğrudur. Girdi `stale` sayılır (hata değil, ölçüm):
   * kuyruk temizlenir, dosya hâlâ defterden farklı olduğu için sonraki tarama
   * BİRLEŞİMİ yükler. İki cihaz yine aynı dokümanda buluşur, kimse anahtar
   * kaybetmez.
   *
   * Yalnız kancası olan sınıf (bugün `prefs`) etkilenir; kanca yoksa `false` döner
   * ve davranış BİT-BİT eskisidir (geri alma: kancayı bağlama).
   *
   * @returns {boolean} `true` = bu tur push ERTELENMELİ (uzak bizden zengin)
   */
  function remoteWouldShrink(classId, relPath, remoteRow, localBuf) {
    if (!transformIncoming || !remoteRow || !localBuf) return false;
    const dec = D.decodeBody(remoteRow);
    if (!dec.ok) return false;
    const r = P.resolveRelPath(classId, relPath, roots, { platform });
    if (!r.ok) return false;
    let merged;
    try {
      const t = transformIncoming({ class: classId, relPath, buf: dec.buf, abs: r.abs });
      if (!t || !Buffer.isBuffer(t.buf)) return false;
      merged = t.buf;
    } catch (err) {
      // Fail-open: birleştirme hatası dosya taşımayı DURDURMAZ (inen yöndeki kural).
      log(`[sync] push koruma kancası hata verdi (${classId}/${relPath}): ${err.message}`);
      return false;
    }
    if (localBuf.equals(merged)) return false;   // yerel zaten birleşim — push serbest
    log(`[sync] push ERTELENDİ, uzak doküman daha zengin: ${classId}/${relPath}`);
    return true;
  }

  /**
   * Uzak baytı diske uygula.
   *
   * ⚠️ SIRA ÖNEMLİ (§2.4): defter YAZMADAN ÖNCE güncellenir. Yazım izleyiciyi
   * tetiklediğinde hesaplanan sha zaten defterdekiyle eşleşir ve push kapısı
   * sessizce eler. Ters sırada yazsaydık, kendi yazımımızı "yerel değişiklik"
   * sanıp buluta geri iterdik: iki cihaz arasında sonsuz döngü.
   */
  function applyBytes(classId, relPath, buf, remoteMeta) {
    const r = P.resolveRelPath(classId, relPath, roots, { platform });
    if (!r.ok) return { ok: false, reason: r.reason };
    const key = keyOf(classId, relPath);
    state.remote[key] = {
      id: remoteMeta.id,
      class: classId,
      relPath,
      sha256: remoteMeta.sha256,
      rev: Number.isFinite(remoteMeta.rev) ? remoteMeta.rev : 0,
      updated_at: remoteMeta.updated_at || null,
    };
    let outBuf = buf;
    if (transformIncoming) {
      try {
        const t = transformIncoming({ class: classId, relPath, buf, abs: r.abs });
        if (t && Buffer.isBuffer(t.buf)) outBuf = t.buf;
      } catch (err) {
        // Kanca patlarsa UZAK BAYT YAZILIR (fail-open): tercih birleştirmesinin
        // bir hatası senkronun dosya taşımasını durduramaz.
        log(`[sync] gelen bayt kancası hata verdi (${classId}/${relPath}): ${err.message}`);
      }
    }
    try { fs.mkdirSync(path.dirname(r.abs), { recursive: true }); } catch { /* var */ }
    try { writeAtomic(r.abs, outBuf, { fs }); } catch (err) {
      return { ok: false, reason: 'write-failed', detail: String(err.message) };
    }
    // Önbellek TARAYICININ anahtar uzayındadır (NUL ayraç) — motorunkiyle karıştırma.
    // Kanca baytı DEĞİŞTİRDİYSE önbellek DİSKTEKİ gerçeği söylemek zorundadır;
    // uzak sha'yı yazsaydık tarayıcı dosyayı "değişmemiş" sanıp birleşimi hiç
    // yüklemezdi (mtime/size eşleşirse yeniden hash'lemez).
    const sameBytes = outBuf === buf || outBuf.equals(buf);
    scanCache[scanKeyOf(classId, relPath)] = sameBytes
      ? { sha256: remoteMeta.sha256, size: buf.length, mtimeMs: 0, encoding: remoteMeta.body_encoding || 'utf8' }
      : { sha256: D.sha256Of(outBuf), size: outBuf.length, mtimeMs: 0, encoding: remoteMeta.body_encoding || 'utf8' };
    return { ok: true, abs: r.abs, transformed: !sameBytes };
  }

  /** Tombstone uygula: DOSYA silinir, DİZİN BIRAKILIR (KURAL S-1). */
  function applyLocalDelete(classId, relPath) {
    const r = P.resolveRelPath(classId, relPath, roots, { platform });
    const key = keyOf(classId, relPath);
    delete state.remote[key];
    delete scanCache[scanKeyOf(classId, relPath)];
    if (!r.ok) return { ok: false, reason: r.reason };
    try { fs.unlinkSync(r.abs); } catch (err) {
      if (err && err.code === 'ENOENT') return { ok: true, alreadyGone: true };
      return { ok: false, reason: 'unlink-failed', detail: String(err.message) };
    }
    counters.deleted += 1;
    return { ok: true, abs: r.abs };
  }

  /**
   * SYNC-CLOUD-01 — arka uç bu şemayı sunmuyor: DUR ve SÖYLE (düşürme).
   * Tek log satırı burada basılır; duruş zaten kalıcıdır, her turda tekrarlanmaz.
   */
  function noteCloudNotReady(detail) {
    const r = queue.halt('cloud-not-ready', detail);
    if (r && !r.already) log(`[sync] bulut hazır değil — senkron DURDU (dosya kaybı yok): ${String(detail || '').slice(0, 200)}`);
    return r;
  }

  /** Duruşun sebebi kalktıysa (ilk başarılı istek) kuyruğu kendi sürdür. */
  function clearCloudNotReady() {
    const q = queue.status();
    if (!q.halted || q.halted.reason !== 'cloud-not-ready') return false;
    queue.resume();
    log('[sync] bulut hazır — duruş kalktı, bekleyen dosyalar yeniden denenecek');
    return true;
  }

  async function writeConflict(c) {
    // SYNC-CLOUD-01 — KUYRUK DURMUŞKEN DEFTERE YAZMAYA ÇALIŞMA. Bu satır yokken
    // ölçülen davranış şuydu: her dosya için bir çakışma yazımı denenip 404 alınıyor
    // ve bir log satırı basılıyordu (FB-1003 alıntısında 116 satır, teşhis değeri 0).
    // Duruş zaten "arka uç cevap vermiyor" demektir; ikinci bir kanıt aramak
    // yalnız gürültü üretir. Sayaç da artmaz: olmayan bir çakışma sayılmaz.
    if (queue.isHalted() || queue.isDisabled()) {
      return { ok: false, kind: 'halted', error: 'kuyruk durdu — çakışma defteri yazılmadı' };
    }
    counters.conflicts += 1;
    const r = await client.insertConflict({ ...c, workspaceKey: C.workspaceKeyFor(c.class, workspaceKey), loserDevice: c.loserDevice || deviceId });
    if (!r.ok) log(`[sync] çakışma defteri yazılamadı (${c.kind}/${c.relPath}): ${r.error}`);
    else conflictsOpen += 1;
    return r;
  }

  // ── PUSH (§2.3) ─────────────────────────────────────────────────────────────

  /**
   * Yerel ağacı tara, defterle karşılaştır, kuyruğa koy, kuyruğu boşalt.
   * @param {{skipDrain?:boolean}} [opts]
   */
  async function pushOnce(opts = {}) {
    setPhase('pushing');
    const scan = scanNow();
    const held = [];
    let enqueued = 0;

    for (const f of scan.files) {
      const key = keyOf(f.class, f.relPath);
      const led = state.remote[key];
      if (led && led.sha256 === f.sha256) { counters.echoSkips += 1; continue; } // EKO / DEĞİŞMEMİŞ

      // SIR KAPISI (§5.4) — BEKLET, BLOKLAMA. Onaylanmış sha'lar listede.
      if (!state.secretAllow.includes(f.sha256) && f.encoding === 'utf8') {
        const local = readLocal(f.class, f.relPath);
        if (local.ok) {
          const hits = D.scanSecrets(local.buf.toString('utf8'));
          if (hits.length) {
            held.push({ relPath: f.relPath, class: f.class, hits });
            counters.held += 1;
            await writeConflict({
              class: f.class, relPath: f.relPath, kind: 'secret-hold',
              loserSha: f.sha256, loserBody: null,
              detail: `sır benzeri dize: ${hits.map((h) => `${h.pattern}@${h.line}`).join(', ')}`,
            });
            continue;
          }
        }
      }
      if (queue.enqueue({ class: f.class, relPath: f.relPath, sha256: f.sha256, op: 'upsert' }).ok) enqueued += 1;
    }

    // SİLMELER — yalnız kökü GERÇEKTEN taranmış sınıflar için (nöbet yukarıda).
    const okClasses = deletableClasses();
    let deletionsSkipped = 0;
    if (!scan.stats.truncated) {
      for (const key of Object.keys(state.remote)) {
        if (scan.byKey[key]) continue;
        const led = state.remote[key];
        if (!led || !okClasses.includes(led.class)) { deletionsSkipped += 1; continue; }
        if (queue.enqueue({ class: led.class, relPath: led.relPath, sha256: led.sha256, op: 'delete' }).ok) enqueued += 1;
      }
    } else {
      log('[sync] tarama KISMİ (tavan aşıldı) — silme turu ATLANDI');
    }

    const drained = opts.skipDrain ? null : await drain();
    state.lastPushAt = now();
    saveState();
    setPhase('idle');
    return { scanned: scan.files.length, enqueued, held, deletionsSkipped, drained, skipped: scan.skipped, warnings: scan.warnings };
  }

  /** Kuyruğu boşalt. Her girdi kendi hatasıyla ilerler; biri diğerini bloklamaz. */
  async function drain() {
    // TIER-SYNC-01 — alan adı `ok` DEĞİL `pushed`. Sebep: api sınırında `ok:false`
    // artık "izin verilmedi" (plan reddi) demek; aynı nesnede `ok`in "kaç dosya
    // yüklendi" anlamına gelmesi iki gerçek olurdu (`ok:0` hem "sıfır dosya" hem
    // "reddedildi" diye okunabilirdi). Sayaç ADIYLA sayaç kalır.
    const out = { pushed: 0, stale: 0, failed: 0, halted: false, dropped: 0 };
    // Durmuş kuyruk `ready()`den zaten boş liste döner; bunu AÇIKÇA söylemek
    // çağıranın "0 dosya vardı" ile "duruyoruz" hâllerini ayırmasını sağlar.
    if (queue.isHalted() || queue.isDisabled()) return { ...out, halted: true };
    for (const entry of queue.ready(now())) {
      if (queue.isHalted() || queue.isDisabled()) { out.halted = true; break; }
      const res = entry.op === 'delete'
        ? await pushDelete(entry)
        : await pushUpsert(entry);
      if (res.ok) { out.pushed += 1; queue.markSuccess(entry.class, entry.relPath); continue; }
      if (res.stale) { out.stale += 1; queue.markSuccess(entry.class, entry.relPath); continue; }
      const m = queue.markFailure(entry.class, entry.relPath, { kind: res.kind, error: res.error });
      if (m.halted) { out.halted = true; break; }
      if (m.dropped) {
        out.dropped += 1;
        await writeConflict({
          class: entry.class, relPath: entry.relPath, kind: 'decode',
          loserSha: entry.sha256, detail: `kalıcı yükleme hatası: ${res.error}`,
        });
      }
      out.failed += 1;
    }
    queue.flushIfDirty();
    return out;
  }

  async function pushUpsert(entry) {
    // TAZE OKU: kuyruktaki sha bir ANLIK GÖRÜNTÜdür; dosya o zamandan beri yeniden
    // değişmiş olabilir. Eski baytı yüklemek, bir sonraki turda "yerel değişmiş"
    // sanılıp yeniden yüklenen bir zıplama üretirdi.
    const local = readLocal(entry.class, entry.relPath);
    if (!local.ok) {
      // Dosya gitmiş: silme turu zaten yakalar; bu girdi düşer.
      if (local.reason === 'missing') return { ok: true, vanished: true };
      return { ok: false, kind: 'permanent', error: `okunamadı: ${local.reason}` };
    }
    const encoding = local.buf.includes(0) ? 'base64' : 'utf8';
    const enc = D.encodeBody(local.buf, encoding);
    if (enc.tooLarge) {
      await writeConflict({
        class: entry.class, relPath: entry.relPath, kind: 'oversize',
        loserSha: local.sha256, detail: `gövde ${local.size} bayt — satır içi tavan ${D.INLINE_BODY_MAX}`,
      });
      return { ok: true, oversize: true };
    }
    const file = {
      class: entry.class, relPath: entry.relPath, sha256: local.sha256, size: local.size,
      body: enc.body, encoding: enc.encoding, workspaceKey: C.workspaceKeyFor(entry.class, workspaceKey),
    };
    const key = keyOf(entry.class, entry.relPath);
    let led = state.remote[key];

    if (!led) {
      const ins = await client.insertFile(file);
      if (ins.ok) {
        state.remote[key] = { id: ins.row.id, class: entry.class, relPath: entry.relPath, sha256: ins.row.sha256, rev: ins.row.rev, updated_at: ins.row.updated_at };
        counters.pushed += 1;
        return { ok: true, inserted: true };
      }
      if (ins.kind !== 'duplicate') return { ok: false, kind: ins.kind, error: ins.error };
      // 23505 -> satır BAŞKA bir cihazdan gelmiş; defteri ondan öğren, PATCH'e geç.
      const got = await client.getByRelPath(entry.relPath, { workspaceKey: file.workspaceKey });
      if (!got.ok) return { ok: false, kind: got.kind, error: got.error };
      if (!got.row) return { ok: false, kind: 'transient', error: '23505 ama satır görünmüyor (tombstone perdesi?)' };
      // 🔴 SYNC-ONB-01 — revi AZ ÖNCE öğrendik; koşullu PATCH bizi korumaz.
      //
      // ⚠️ DEFTERE DOKUNMADAN çık. `state.remote[key]` uzak sha ile doldurulsaydı
      // hemen ardından koşan PULL bu satırı "yerel dosyam son senkrondan sonra
      // değişti" diye ÇAKIŞMA sayar ve uzak gövdeyi UYGULAMAZ (ölçüldü: D ikinci
      // cihazda kaydı yine alamıyordu). Defter boş kalınca pull DÜZ UYGULAMA
      // yolundan gider, `transformIncoming` birleşimi yazar ve söz tutulur.
      if (remoteWouldShrink(entry.class, entry.relPath, got.row, local.buf)) {
        return { ok: true, stale: true, deferred: true };
      }
      led = { id: got.row.id, class: entry.class, relPath: entry.relPath, sha256: got.row.sha256, rev: got.row.rev, updated_at: got.row.updated_at };
      state.remote[key] = led;
      if (led.sha256 === local.sha256) { counters.echoSkips += 1; return { ok: true, sameBytes: true }; }
    }

    const pat = await client.patchFile(led.id, led.rev, file);
    if (!pat.ok) return { ok: false, kind: pat.kind, error: pat.error };
    if (!pat.stale) {
      state.remote[key] = { id: pat.row.id, class: entry.class, relPath: entry.relPath, sha256: pat.row.sha256, rev: pat.row.rev, updated_at: pat.row.updated_at };
      counters.pushed += 1;
      return { ok: true, patched: true };
    }
    // 0 SATIR = ÇAKIŞMA (§2.3c). Bu bir hata değil, bir ÖLÇÜMdür.
    return resolvePushConflict(entry, local, file, led);
  }

  /**
   * PUSH ÇAKIŞMASI (§3.2, "Push" satırı).
   *
   * Kaybeden bayt HER İKİ durumda da `sync_conflicts.loser_body`ye ve yerel nesne
   * deposuna KONUR — kurtarma yalnız kaybeden cihazın diskine bağlı kalırsa o cihaz
   * gittiğinde içerik de gider (§3.2 kurtarma notu).
   */
  async function resolvePushConflict(entry, local, file, led) {
    const key = keyOf(entry.class, entry.relPath);
    const got = await client.getByRelPath(entry.relPath, { workspaceKey: file.workspaceKey });
    if (!got.ok) return { ok: false, kind: got.kind, error: got.error };
    if (!got.row) {
      // Satır kaybolmuş (tombstone) — yerel yazım kazanır, defteri temizle ve
      // sonraki turda INSERT olarak dene.
      delete state.remote[key];
      return { ok: false, kind: 'transient', error: 'satır tombstone perdesinde — sonraki turda INSERT' };
    }
    const theirs = got.row;
    // 🔴 SYNC-ONB-01 — kancası olan sınıfta (prefs) çakışma bir KAYBEDEN üretmez:
    // iki doküman anahtar bazında birleşir ve birleşim yüklenir. Kanca yoksa
    // aşağıdaki dosya-seviyesi LWW yolu BİT-BİT eskisi gibi koşar.
    if (remoteWouldShrink(entry.class, entry.relPath, theirs, local.buf)) {
      return { ok: true, stale: true, deferred: true };
    }
    if (theirs.sha256 === local.sha256) {
      // Aynı baytlar, farklı yol: iki cihaz aynı içeriği yazmış. ÇAKIŞMA DEĞİL.
      state.remote[key] = { id: theirs.id, class: entry.class, relPath: entry.relPath, sha256: theirs.sha256, rev: theirs.rev, updated_at: theirs.updated_at };
      counters.echoSkips += 1;
      return { ok: true, sameBytes: true };
    }

    const mine = { sha256: local.sha256, rev: null, updated_at: new Date(now()).toISOString() };
    const winner = D.decideWinner(mine, { sha256: theirs.sha256, rev: theirs.rev, updated_at: theirs.updated_at });

    // Uzak baytı HER İKİ dalda da nesne deposuna koy: kaybetse de kaybetmese de
    // kurtarılabilir olmalı ve gövde elimizdeyken bedeli sıfır.
    const dec = D.decodeBody(theirs);
    if (dec.ok) { try { objectStore.put(dec.buf); } catch { /* depo dolu/yazılamaz — kurtarma defterde de var */ } }
    try { objectStore.put(local.buf); } catch { /* aynı */ }

    if (winner === 'a') {
      // YEREL KAZANDI -> güncel `rev` ile yeniden PATCH; uzak bayt KAYBEDEN.
      const re = await client.patchFile(theirs.id, theirs.rev, file);
      if (!re.ok) return { ok: false, kind: re.kind, error: re.error };
      if (re.stale) return { ok: false, kind: 'transient', error: 'rev yine ilerledi — sonraki turda' };
      state.remote[key] = { id: re.row.id, class: entry.class, relPath: entry.relPath, sha256: re.row.sha256, rev: re.row.rev, updated_at: re.row.updated_at };
      await writeConflict({
        class: entry.class, relPath: entry.relPath, kind: 'lww',
        winnerSha: local.sha256, winnerRev: re.row.rev, winnerDevice: deviceId,
        loserSha: theirs.sha256, loserRev: theirs.rev, loserDevice: theirs.origin_device || null,
        loserBody: dec.ok ? D.loserBodyFor(dec.buf) : null,
        detail: 'push çakışması — yerel yazım kazandı (LWW)',
      });
      counters.pushed += 1;
      return { ok: true, wonLocal: true };
    }

    // UZAK KAZANDI -> yerel bayt kaybeden; uzak içerik diske uygulanır.
    await writeConflict({
      class: entry.class, relPath: entry.relPath, kind: 'lww',
      winnerSha: theirs.sha256, winnerRev: theirs.rev, winnerDevice: theirs.origin_device || null,
      loserSha: local.sha256, loserRev: led ? led.rev : null, loserDevice: deviceId,
      loserBody: D.loserBodyFor(local.buf),
      detail: 'push çakışması — uzak satır kazandı (LWW)',
    });
    if (dec.ok) applyBytes(entry.class, entry.relPath, dec.buf, theirs);
    return { ok: true, wonRemote: true };
  }

  async function pushDelete(entry) {
    const key = keyOf(entry.class, entry.relPath);
    const led = state.remote[key];
    if (!led) return { ok: true, noRow: true };
    const r = await client.deleteFile(led.id);
    if (!r.ok) return { ok: false, kind: r.kind, error: r.error };
    // `hit=false` = satır yok ya da KİRACI NÖBETİ reddetti. İkisi de "bizim
    // defterimiz bayat" demek; defterden düşür, sessizce başarı sayma.
    delete state.remote[key];
    delete scanCache[scanKeyOf(entry.class, entry.relPath)];
    if (!r.hit) log(`[sync] tombstone 0 satır: ${entry.relPath} (bayat defter ya da kiracı nöbeti)`);
    counters.deleted += 1;
    return { ok: true, tombstoned: r.hit };
  }

  // ── PULL (§2.5) ─────────────────────────────────────────────────────────────

  async function pullOnce(opts = {}) {
    setPhase('pulling');
    const maxPages = Number.isFinite(opts.maxPages) ? opts.maxPages : 50;
    const touched = new Set();
    let applied = 0; let skipped = 0; let conflicts = 0; let pages = 0;
    // 🔴 ÖRTÜŞME PAYI YALNIZ TURUN İLK İSTEĞİNE AİTTİR — SYNC-F1-5/S6 ÖLÇTÜ.
    // `cursorFloor` cursor'dan 5 sn geri gider (iki cihazın saat sapması için, §2.5).
    // O pay SAYFALAMA DÖNGÜSÜNÜN İÇİNDE de uygulanınca ilerleme YAPISAL OLARAK
    // imkânsızlaşıyordu: 5 sn'den kısa sürede yazılmış 259 satırda 2. sayfa yine
    // 1. sayfanın satırlarını getiriyor, hepsi eko diye eleniyor, cursor kımıldamıyor.
    // ÖLÇÜLEN HÂL (düzeltmeden önce): applied 200/259 · pages 50 (tavan) · skipped 9.800
    // — yani "7 gün çevrimdışı kaldım" senaryosunda son 59 dosya HİÇ İNMİYORDU.
    // Sayfa içi ilerleme bu yüzden TAM damgadan (`gt.`) devam eder.
    let from = Delta.cursorFloor(state.cursor);
    let pagedFrom = state.cursor;

    for (;;) {
      const r = await client.listDelta(from);
      if (!r.ok) {
        // SYNC-CLOUD-01 — çekme yolunda kuyruk girdisi YOKTUR, bu yüzden durdurma
        // `markFailure` üzerinden gelemez; kuyruğu AÇIKÇA durdururuz. Aksi hâlde
        // yükleme tarafı durmuş görünürken çekme tarafı her turda aynı 404'ü yer.
        if (r.kind === 'cloud_not_ready') noteCloudNotReady(r.error);
        setPhase(r.kind === 'transient' ? 'offline' : 'error', r.error);
        return { ok: false, kind: r.kind, error: r.error, applied, skipped, conflicts };
      }
      // Arka uç CEVAP VERDİ: "hazır değil" duruşunun sebebi ortadan kalktı. Bunu
      // kullanıcıya tıklatmak (401'deki gibi) yanlış olurdu — 401 kullanıcının
      // yeniden girmesini gerektirir, bu ise sunucu tarafında KENDİ düzelir.
      clearCloudNotReady();
      pages += 1;
      const rows = r.rows;
      if (!rows.length) break;

      // PLATFORM KAPISI (§4.3) — çakışan grupta HİÇBİRİ uygulanmaz.
      const gate = P.planPlatformGate(rows.map((x) => x.rel_path), { platform });
      const holdSet = new Set(gate.hold.map((h) => h.relPath));
      for (const h of gate.hold) {
        if (state.heldPlatform.includes(h.relPath)) continue;
        state.heldPlatform.push(h.relPath);
        const row = rows.find((x) => x.rel_path === h.relPath);
        await writeConflict({
          class: row ? row.class : 'memory', relPath: h.relPath, kind: 'platform-collision',
          winnerSha: null, loserSha: row ? row.sha256 : null, detail: h.detail,
        });
      }

      for (const row of rows) {
        if (holdSet.has(row.rel_path)) { skipped += 1; continue; }
        const res = await applyRemoteRow(row);
        if (res.applied) { applied += 1; touched.add(path.dirname(row.rel_path)); }
        else if (res.conflict) { conflicts += 1; touched.add(path.dirname(row.rel_path)); }
        else skipped += 1;
      }

      // CURSOR SAYFA BİTTİKTEN SONRA ilerler (§2.5): yarım uygulanan bir sayfada
      // cursor'ı ilerletmek, uygulanmayan satırları SONSUZA DEK kaçırmak demektir.
      state.cursor = Delta.maxStamp(rows.map((x) => x.updated_at), state.cursor);
      if (!r.hasMore) break;
      // Sayfa içi ilerleme: pay YOK. Damga ilerlemediyse (bir sayfa dolusu satır
      // AYNI damgayı taşıyor — tek işlemde yazılmış toplu bir yükleme) `gt.` ile
      // ilerlemek imkânsızdır; sonsuz döngü yerine turu KISMİ bitiririz, kalanı
      // mutabakat kapatır.
      if (!state.cursor || state.cursor === pagedFrom) {
        log('[sync] delta cursor ilerlemedi (aynı damgada bir sayfa dolusu satır) — tur KISMİ, mutabakata bırakıldı');
        break;
      }
      pagedFrom = state.cursor;
      from = state.cursor;
      if (pages >= maxPages) { log(`[sync] delta sayfa tavanı (${maxPages}) — tur KISMİ`); break; }
    }

    state.lastPullAt = now();
    saveState();
    if (deriveIndexes && touched.size) {
      try { deriveIndexes([...touched]); } catch (err) { log(`[sync] indeks türetimi hatası: ${err.message}`); }
    }
    setPhase('idle');
    counters.pulled += applied;
    return { ok: true, applied, skipped, conflicts, pages, cursor: state.cursor };
  }

  /**
   * Tek uzak satırı uygula.
   * @returns {{applied?:boolean, conflict?:boolean, skipped?:string}}
   */
  async function applyRemoteRow(row) {
    const key = keyOf(row.class, row.rel_path);

    // TOMBSTONE dalı — perdesiz bir yetkide (service_role / `app` ikizi) buraya düşer.
    if (row.deleted_at) {
      const local = readLocal(row.class, row.rel_path);
      if (local.ok) { try { objectStore.put(local.buf); } catch { /* depo hatası silmeyi engellemez */ } }
      applyLocalDelete(row.class, row.rel_path);
      return { applied: true, deleted: true };
    }

    const resolved = P.resolveRelPath(row.class, row.rel_path, roots, { platform });
    if (!resolved.ok) {
      log(`[sync] uzak satır uygulanamadı (${resolved.reason}): ${row.class}/${row.rel_path}`);
      return { skipped: resolved.reason };
    }

    const dec = D.decodeBody(row);
    if (!dec.ok) {
      if (dec.reason === 'null-body' || dec.reason === 'storage-body-phase2') return { skipped: dec.reason };
      await writeConflict({
        class: row.class, relPath: row.rel_path, kind: 'decode',
        winnerSha: null, loserSha: row.sha256, detail: `${dec.reason}: ${dec.detail || ''}`,
      });
      return { conflict: true };
    }

    const local = readLocal(row.class, row.rel_path);
    const led = state.remote[key];

    // EKO (§2.4): baytlar zaten aynı — yazma, defteri tazele, sus.
    if (local.ok && local.sha256 === row.sha256) {
      state.remote[key] = { id: row.id, class: row.class, relPath: row.rel_path, sha256: row.sha256, rev: row.rev, updated_at: row.updated_at };
      counters.echoSkips += 1;
      return { skipped: 'echo' };
    }

    // ÇAKIŞMA (§3.2, "Pull" satırı): yerel dosya son senkrondan SONRA değişmiş.
    if (local.ok && led && local.sha256 !== led.sha256) {
      const mine = { sha256: local.sha256, rev: null, updated_at: new Date(now()).toISOString() };
      const winner = D.decideWinner(mine, { sha256: row.sha256, rev: row.rev, updated_at: row.updated_at });
      try { objectStore.put(local.buf); } catch { /* kurtarma defterde de var */ }
      try { objectStore.put(dec.buf); } catch { /* aynı */ }

      if (winner === 'a') {
        // YEREL KAZANDI: uzak satır kaybeden; yerel içerik push turunda yükselecek.
        await writeConflict({
          class: row.class, relPath: row.rel_path, kind: 'lww',
          winnerSha: local.sha256, winnerDevice: deviceId,
          loserSha: row.sha256, loserRev: row.rev, loserDevice: row.origin_device || null,
          loserBody: D.loserBodyFor(dec.buf),
          detail: 'pull çakışması — yerel dosya kazandı (LWW)',
        });
        // Defterin `rev`ini TAZELE ki push turu koşullu PATCH'i doğru temelle yapsın.
        state.remote[key] = { id: row.id, class: row.class, relPath: row.rel_path, sha256: row.sha256, rev: row.rev, updated_at: row.updated_at };
        queue.enqueue({ class: row.class, relPath: row.rel_path, sha256: local.sha256, op: 'upsert' });
        return { conflict: true, wonLocal: true };
      }
      await writeConflict({
        class: row.class, relPath: row.rel_path, kind: 'lww',
        winnerSha: row.sha256, winnerRev: row.rev, winnerDevice: row.origin_device || null,
        loserSha: local.sha256, loserRev: led.rev, loserDevice: deviceId,
        loserBody: D.loserBodyFor(local.buf),
        detail: 'pull çakışması — uzak satır kazandı (LWW)',
      });
      const w = applyBytes(row.class, row.rel_path, dec.buf, row);
      return w.ok ? { conflict: true, wonRemote: true } : { skipped: w.reason };
    }

    try { objectStore.put(dec.buf); } catch (err) { log(`[sync] nesne deposu yazılamadı: ${err.message}`); }
    const w = applyBytes(row.class, row.rel_path, dec.buf, row);
    return w.ok ? { applied: true } : { skipped: w.reason };
  }

  // ── SİLME SONDASI + MUTABAKAT (§2.5) ────────────────────────────────────────

  /**
   * UCUZ SİLME SONDASI: `count=exact` gövdesiz sorgusu.
   * Delta silmeyi göremediği için (perde) tek ucuz sinyal SAYIdır.
   */
  async function probeDeletions() {
    const r = await client.countVisible();
    if (!r.ok) return { ok: false, kind: r.kind, error: r.error };
    const known = Object.keys(state.remote).length;
    const diverged = r.count !== known;
    return { ok: true, count: r.count, known, diverged };
  }

  /** ZEMİN MUTABAKATI — manifest ile defteri hizala (§2.5). */
  async function reconcileOnce() {
    setPhase('reconciling');
    const man = await client.listManifest();
    if (!man.ok) { setPhase(man.kind === 'transient' ? 'offline' : 'error', man.error); return { ok: false, kind: man.kind, error: man.error }; }
    const scan = scanNow();
    const plan = D.planFileReconcile({ ledger: state.remote, manifest: man.rows, localByKey: scan.byKey, keyOf });

    // 1) EKSİK/SAPMIŞ gövdeler
    let pulled = 0;
    if (plan.pull.length) {
      const bodies = await client.fetchBodies(plan.pull.map((p) => p.relPath));
      if (!bodies.ok) { setPhase('error', bodies.error); return { ok: false, kind: bodies.kind, error: bodies.error }; }
      for (const row of bodies.rows) {
        const res = await applyRemoteRow(row);
        if (res.applied || res.conflict) pulled += 1;
      }
    }

    // 2) UZAKTA SİLİNMİŞ — nöbet: kökü taranmamış sınıfa DOKUNMA.
    const okClasses = deletableClasses();
    let deleted = 0; let deleteSkipped = 0;
    for (const d of plan.deleteLocal) {
      if (!okClasses.includes(d.class) || scan.stats.truncated) { deleteSkipped += 1; continue; }
      const local = readLocal(d.class, d.relPath);
      if (local.ok) { try { objectStore.put(local.buf); } catch { /* kurtarılabilirlik best-effort */ } }
      applyLocalDelete(d.class, d.relPath);
      deleted += 1;
    }

    // 3) HİÇ YÜKLENMEMİŞ / yerel-yazım-uzak-silmeden-sonra
    for (const p of plan.push) queue.enqueue({ class: p.class, relPath: p.relPath, sha256: p.sha256, op: 'upsert' });

    // 4) İki tarafta da olmayan defter satırları
    for (const key of plan.ledgerDrop) delete state.remote[key];

    // Manifestteki en büyük damga cursor'ı ileri taşıyabilir (geri ASLA).
    state.cursor = Delta.maxStamp(man.rows.map((r) => r.updated_at), state.cursor);
    state.lastReconcileAt = now();
    saveState();
    setPhase('idle');
    return { ok: true, manifest: man.rows.length, pulled, deleted, deleteSkipped, pushQueued: plan.push.length, ledgerDropped: plan.ledgerDrop.length };
  }

  function reconcileDue() {
    return Delta.shouldReconcile(state.lastReconcileAt, now(), RECONCILE_EVERY_MS);
  }

  // ── BOOTSTRAP (§2.6) ────────────────────────────────────────────────────────

  /**
   * Yeni cihazın ilk indirmesi.
   * Kazanç `objectStore.has(sha)`de: FAZ 0 elle taşımadan ya da kısmi bir kurulumdan
   * sonra gelen cihaz, elinde OLAN baytı bir kez daha indirmez.
   */
  async function bootstrap() {
    setPhase('bootstrapping');
    const man = await client.listManifest();
    if (!man.ok) { setPhase(man.kind === 'transient' ? 'offline' : 'error', man.error); return { ok: false, kind: man.kind, error: man.error }; }
    const scan = scanNow();

    const need = [];
    let fromStore = 0; let alreadyLocal = 0;
    for (const row of man.rows) {
      const key = keyOf(row.class, row.rel_path);
      const local = scan.byKey[key];
      if (local && local.sha256 === row.sha256) {
        state.remote[key] = { id: row.id, class: row.class, relPath: row.rel_path, sha256: row.sha256, rev: row.rev, updated_at: row.updated_at };
        alreadyLocal += 1;
        continue;
      }
      let buf = null;
      try { buf = objectStore.has(row.sha256) ? objectStore.get(row.sha256) : null; } catch { buf = null; }
      if (buf && D.sha256Of(buf) === row.sha256) {
        const w = applyBytes(row.class, row.rel_path, buf, row);
        if (w.ok) { fromStore += 1; continue; }
      }
      need.push(row.rel_path);
    }

    let downloaded = 0; let requests = 0;
    if (need.length) {
      const bodies = await client.fetchBodies(need);
      requests = Math.ceil(need.length / 200);
      if (!bodies.ok) { setPhase('error', bodies.error); return { ok: false, kind: bodies.kind, error: bodies.error }; }
      for (const row of bodies.rows) {
        const dec = D.decodeBody(row);
        if (!dec.ok) {
          await writeConflict({ class: row.class, relPath: row.rel_path, kind: 'decode', loserSha: row.sha256, detail: dec.reason });
          continue;
        }
        try { objectStore.put(dec.buf); } catch { /* depo hatası yazımı engellemez */ }
        if (applyBytes(row.class, row.rel_path, dec.buf, row).ok) downloaded += 1;
      }
    }

    state.cursor = Delta.maxStamp(man.rows.map((r) => r.updated_at), state.cursor);
    state.lastReconcileAt = now();
    saveState();
    // MEMORY.md İNDİRİLMEZ, TÜRETİLİR (§2.6/5) — türetici F1-4'ün.
    if (deriveIndexes) {
      try { deriveIndexes(null); } catch (err) { log(`[sync] bootstrap indeks türetimi: ${err.message}`); }
    }
    setPhase('idle');
    return { ok: true, manifest: man.rows.length, alreadyLocal, fromStore, downloaded, requests, cursor: state.cursor };
  }

  // ── KULLANICI EYLEMLERİ ─────────────────────────────────────────────────────

  /** Sır kapısı onayı (§5.4): bu SHA bir daha bekletilmez. */
  function approveSecret(sha256) {
    if (!/^[0-9a-f]{64}$/.test(String(sha256 || ''))) return { ok: false, reason: 'invalid-sha' };
    if (!state.secretAllow.includes(sha256)) state.secretAllow.push(sha256);
    saveState();
    return { ok: true, count: state.secretAllow.length };
  }

  /**
   * "Kaybedeni yanına yaz" (§3.2). ÜZERİNE YAZMAZ: `<ad>.conflict-<sha8>.<uzantı>`.
   * Otomatik birleştirme FAZ 1'de YOK — birleştiren kullanıcıdır.
   */
  async function restoreLoser(conflictId) {
    const got = await client.getConflictBody(conflictId);
    if (!got.ok) return { ok: false, kind: got.kind, error: got.error };
    const row = got.row;
    if (!row) return { ok: false, reason: 'not-found' };

    let buf = null;
    if (row.loser_body != null) buf = Buffer.from(String(row.loser_body), 'utf8');
    else if (row.loser_sha256) { try { buf = objectStore.get(row.loser_sha256); } catch { buf = null; } }
    if (!buf) return { ok: false, reason: 'loser-bytes-unavailable' };

    const resolved = P.resolveRelPath(row.class, row.rel_path, roots, { platform });
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    const ext = path.extname(resolved.abs);
    const base = resolved.abs.slice(0, resolved.abs.length - ext.length);
    const abs = `${base}.conflict-${String(row.loser_sha256 || '').slice(0, 8)}${ext}`;
    try { fs.mkdirSync(path.dirname(abs), { recursive: true }); } catch { /* var */ }
    try { writeAtomic(abs, buf, { fs }); } catch (err) { return { ok: false, reason: 'write-failed', detail: String(err.message) }; }
    const res = await client.resolveConflict(conflictId, 'restored-loser');
    if (res.ok && conflictsOpen > 0) conflictsOpen -= 1;
    return { ok: true, abs, resolved: res.ok };
  }

  /** Kullanıcı kararı deftere işlenir ("kazananı tuttum" / "elle birleştirdim"). */
  async function resolveConflict(conflictId, resolution) {
    const r = await client.resolveConflict(conflictId, resolution);
    if (!r.ok) return { ok: false, kind: r.kind, error: r.error };
    if (conflictsOpen > 0) conflictsOpen -= 1;
    try { onStatus(getStatus()); } catch { /* dinleyici hatası motoru durdurmaz */ }
    return { ok: true, row: r.row };
  }

  /**
   * Yeniden girişten sonra durmuş kuyruğu sürdür (§2.7).
   * Otomatik DEĞİL: 401 gördüğümüzde jeton ölmüştür; onu tazeleyen kullanıcı ya da
   * oturum katmanıdır, motor değil.
   */
  function resumeQueue() {
    const r = queue.resume();
    saveState();
    setPhase('idle');
    return r;
  }

  async function refreshConflicts() {
    const r = await client.listConflicts({ openOnly: true });
    if (!r.ok) return { ok: false, kind: r.kind, error: r.error };
    conflictsOpen = r.rows.length;
    try { onStatus(getStatus()); } catch { /* dinleyici hatası motoru durdurmaz */ }
    return { ok: true, rows: r.rows };
  }

  /**
   * TEK TUR: pull -> (gerekiyorsa) mutabakat -> push. TEK UÇUŞ nöbetli.
   * Sıra kasıtlı: uzak değişikliği önce indirmek, aynı dosyayı yerelden iterken
   * çakışma üretme olasılığını düşürür.
   */
  async function tick(opts = {}) {
    if (running) return { ok: false, reason: 'already-running' };
    running = true;
    try {
      const out = { pull: null, reconcile: null, push: null };
      out.pull = await pullOnce();
      if (opts.reconcile === true || reconcileDue()) {
        out.reconcile = await reconcileOnce();
      } else if (opts.probe !== false) {
        const probe = await probeDeletions();
        if (probe.ok && probe.diverged) out.reconcile = await reconcileOnce();
        out.probe = probe;
      }
      out.push = await pushOnce();
      return { ok: true, ...out };
    } finally {
      running = false;
    }
  }

  const api = {
    loadState, saveState, getStatus, noteRealtime,
    scanNow, pushOnce, drain, pullOnce, reconcileOnce, reconcileDue, probeDeletions,
    bootstrap, approveSecret, restoreLoser, resolveConflict, resumeQueue, refreshConflicts, tick,
    applyRemoteRow, applyBytes, applyLocalDelete, readLocal, deletableClasses,
    keyOf,
    planCheck: () => planGate.check(),
    ledger: () => state.remote,
    stateRef: () => state,
  };

  // ── TIER-SYNC-01 — KAPI, TEK YERDE VE VERİDEN ───────────────────────────────
  //
  // Kapı tek tek fonksiyonların İÇİNE serpilmedi; API yüzeyi kurulurken BİR KEZ
  // sarılıyor. Sebep TIER-DESIGN-01'in ölçtüğü kaçak sınıfı: kapı N ayrı çağrı
  // yerine yazılırsa N+1'inci çağrı yeri onu unutur. Burada listede OLMAYAN bir
  // yöntem eklemek de sessiz kalmaz — `syncEngine.test.cjs` her yöntemi reddedilen
  // bir plan altında ÇAĞIRIR ve sahte istemcinin çağrı sayacının SIFIR kaldığını
  // ölçer; ağa dokunan yeni bir yöntem gateli değilse o ölçüm kırmızı verir.
  //
  // NE GATELENİR: buluta dokunan her şey. NE GATELENMEZ ve neden:
  //   • `getStatus`/`planCheck`  → yüzeyin "senkron kapalı, işte sebebi" diyebilmesi
  //     için ÇALIŞMAK ZORUNDA. Kilidi GÖSTERMEK gizlemekten daha dürüst.
  //   • `scanNow`/`readLocal`/`apply*`/`loadState`/`saveState` → yereldir, ağ yok.
  //     Bir plan reddi kullanıcının kendi diskindeki dosyasına erişimini ASLA
  //     kesmez (BL-02 sözleşmesi: reddedilen eylem kalıcı durumu ne siler ne bozar).
  //   • `reconcileDue`/`keyOf`/`ledger`/`stateRef` → saf okuma.
  const GATED = Object.freeze([
    'pushOnce', 'drain', 'pullOnce', 'reconcileOnce', 'probeDeletions', 'bootstrap',
    'restoreLoser', 'resolveConflict', 'refreshConflicts', 'resumeQueue', 'tick',
  ]);

  /** Ret nesnesi — IPC sınırından geçtiği gibi renderer'a gidebilir (gövde yok). */
  function planRefusal(denial, method) {
    log(`[sync] plan tavanı: ${method} çalıştırılmadı (katman=${denial.tier}); yerel dosyalar KORUNUYOR`);
    return {
      ok: false,
      reason: 'plan_limit',
      feature: denial.feature,
      error: denial.message,
      denial,
      requiredTierLabel: denial.requiredTierLabel || null,
    };
  }

  for (const name of GATED) {
    const inner = api[name];
    api[name] = function gated(...args) {
      const verdict = planGate.check();
      if (verdict.allowed) return inner.apply(null, args);
      try { onPlanDenied(verdict.denial); } catch { /* bildirim hatası reddi bozmaz */ }
      const refusal = planRefusal(verdict.denial, name);
      // Eş imza: async bir yöntem async, senkron olan senkron cevap versin —
      // çağıran taraf `await` etsin etmesin aynı nesneyi görür.
      return inner.constructor.name === 'AsyncFunction' ? Promise.resolve(refusal) : refusal;
    };
  }

  return api;
}

module.exports = {
  createSyncEngine,
  keyOf,
  STATE_VERSION,
  RECONCILE_EVERY_MS,
  POLL_FAST_MS,
  POLL_SLOW_MS,
};
