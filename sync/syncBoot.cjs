// SYNC-F1-6 (Blaster) — SENKRON MOTORUNUN AÇILIŞA BAĞLANDIĞI TEK YER.
//                       Tasarım: SYNC-F1-TASARIM.md §2.6b · §5.3 · §16.7 · §18
//
// ═══════════════════════════════════════════════════════════════════════════════
// NEDEN `main.js`'TE DEĞİL
// ═══════════════════════════════════════════════════════════════════════════════
// F1-3 motoru BİLEREK açılışa bağlamadı (§16.7): senkron opt-in'dir ve onu açan
// ekran F1-6'nındır. O ekran geldiğine göre bağlama da geldi — ama `main.js`
// Electron olmadan `require` EDİLEMEZ, yani orada yaşayan bir kuruluş `node --test`
// ile sınanamaz. Kuruluş burada; `main.js`'te yalnız üç satır kalır
// (`createSyncRuntime` + `createSyncIpc` + `ipcMain.handle` döngüsü).
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 VARSAYILAN KAPALI — VE "KAPALI" MOTOR KURULMAMAK DEMEKTİR
// ─────────────────────────────────────────────────────────────────────────────
// §5.3'ün duruşu: hafıza bulutta ŞİFRELENMEMİŞ durur, bu yüzden senkron opt-in'dir.
// Burada bunun yapısal karşılığı şu: tercih kapalıyken motor NESNESİ HİÇ DOĞMAZ.
// "Kurup sonra tick'i atlamak" ile "kurmamak" aynı şey değildir — ilkinde bir
// zamanlayıcı, bir kuyruk dosyası ve bir HTTP istemcisi kullanıcı istemeden ayakta
// durur. `getEngine()` `null` döner, `syncIpc` bunu `{ok:false,reason:'sync-disabled'}`
// diye söyler ve ekran o cevabı OLDUĞU GİBİ gösterir.
//
// ─────────────────────────────────────────────────────────────────────────────
// KİMLİK: `<workspaceRoot>/.crewpane/workspace.json` (§1.2)
// ─────────────────────────────────────────────────────────────────────────────
// `workspace_key` YOLDAN TÜRETİLMEZ. Klasör adının hash'i aynı kiracıdaki iki ayrı
// `Projects` klasörünü SESSİZCE birleştirirdi ve birleşme geri alınamaz (§1.2'nin
// reddettiği yol). Bu cihaz opak bir `ws-<16hex>` üretir ve diske bırakır; başka
// bir cihazın MEVCUT bir bulut alanına bağlanması §1.2'nin eşleştirme ekranıdır ve
// F1-6'nın kapsamında DEĞİLDİR — bu yüzden ekran bunu açıkça söyler, tahmin etmez.
//
// SAF + DI: Electron bağı YOK, `fs`/`crypto`/`fetch` enjekte edilebilir.

'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const nodeCrypto = require('node:crypto');

const { schemaHeaders } = require('../src/config/appDbIdentity.cjs');
const { createSyncClient } = require('./syncClient.cjs');
const { createSyncEngine } = require('./syncEngine.cjs');
const { createSyncQueue } = require('./syncQueue.cjs');
const { createScanner } = require('./syncScanner.cjs');
const { createObjectStore } = require('./syncObjectStore.cjs');
const { createSyncPlanGate } = require('./syncPlanGate.cjs');

/** `crewpane_workspaces.workspace_key` CHECK'inin BİREBİR aynası (§1.3). */
const WS_KEY_RE = /^ws-[0-9a-f]{16}$/;
const IDENTITY_FILE = 'workspace.json';

/**
 * Bu klasörün bulut kimliği — OKU, yoksa ÜRET.
 *
 * `create:false` ile çağrıldığında dosya yoksa hiçbir şey YAZMAZ: senkron kapalıyken
 * ekranın "bu klasörün kimliği var mı" sorusunu sorması, o kimliği yaratmasına sebep
 * olmamalı (kapalı bir özellik diske iz bırakmaz).
 *
 * @returns {{ok:boolean, workspaceKey:string|null, displayName:string|null,
 *            created:boolean, file:string, reason?:string}}
 */
function ensureWorkspaceIdentity(workspaceRoot, opts = {}) {
  const fs = opts.fs || nodeFs;
  const path = opts.path || nodePath;
  const crypto = opts.crypto || nodeCrypto;
  const create = opts.create !== false;
  if (!workspaceRoot || typeof workspaceRoot !== 'string') {
    return { ok: false, workspaceKey: null, displayName: null, created: false, file: '', reason: 'no-workspace-root' };
  }
  const dir = path.join(workspaceRoot, '.crewpane');
  const file = path.join(dir, IDENTITY_FILE);
  let raw = null;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { /* yok = üretilecek (ya da üretilmeyecek) */ }
  if (raw != null) {
    try {
      const parsed = JSON.parse(raw);
      const key = typeof parsed.workspaceKey === 'string' ? parsed.workspaceKey.trim() : '';
      if (WS_KEY_RE.test(key)) {
        return {
          ok: true,
          workspaceKey: key,
          displayName: typeof parsed.displayName === 'string' && parsed.displayName ? parsed.displayName : path.basename(workspaceRoot),
          created: false,
          file,
        };
      }
      // BOZUK DOSYAYI EZMEYİZ. İçinde ne olduğunu bilmiyoruz ve üzerine yeni bir
      // kimlik yazmak, o klasörün bulut geçmişini erişilemez kılardı.
      return { ok: false, workspaceKey: null, displayName: null, created: false, file, reason: 'invalid-identity' };
    } catch {
      return { ok: false, workspaceKey: null, displayName: null, created: false, file, reason: 'invalid-identity' };
    }
  }
  if (!create) {
    return { ok: false, workspaceKey: null, displayName: null, created: false, file, reason: 'not-paired' };
  }
  const key = `ws-${crypto.randomBytes(8).toString('hex')}`;
  const displayName = path.basename(workspaceRoot) || 'workspace';
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ workspaceKey: key, displayName, createdAt: new Date().toISOString() }, null, 2)}\n`);
  } catch (err) {
    return { ok: false, workspaceKey: null, displayName: null, created: false, file, reason: `write-failed: ${err.message}` };
  }
  return { ok: true, workspaceKey: key, displayName, created: true, file };
}

/**
 * Motorun YAŞAM DÖNGÜSÜ: tercih açıldığında kurulur, kapandığında SÖKÜLÜR.
 *
 * @param {{
 *   getEnabled:Function, getRoots:Function, getTarget:Function,
 *   getPlanSnapshot:Function, getDeviceId?:Function, getToken?:Function,
 *   deriveIndexes?:Function, transformIncoming?:Function, onPlanDenied?:Function, onStatus?:Function,
 *   log?:Function, fs?:object, path?:object, crypto?:object, fetch?:Function,
 *   setInterval?:Function, clearInterval?:Function
 * }} deps
 */
function createSyncRuntime(deps = {}) {
  const fs = deps.fs || nodeFs;
  const path = deps.path || nodePath;
  const crypto = deps.crypto || nodeCrypto;
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const setTimer = typeof deps.setInterval === 'function' ? deps.setInterval : setInterval;
  const clearTimer = typeof deps.clearInterval === 'function' ? deps.clearInterval : clearInterval;

  if (typeof deps.getEnabled !== 'function') throw new Error('syncBoot: getEnabled zorunlu (DI)');
  if (typeof deps.getRoots !== 'function') throw new Error('syncBoot: getRoots zorunlu (DI)');
  if (typeof deps.getTarget !== 'function') throw new Error('syncBoot: getTarget zorunlu (DI)');
  // §18.1(3) ile AYNI gerekçe: kapıyı bağlamayı unutmak, özelliği bağlamayı unutmakla
  // aynı hata olsun. Motor zaten zorunlu kılıyor; burada da zorunlu ki eksiklik
  // ÇALIŞMA ZAMANINDA değil KURULUŞTA patlasın.
  if (typeof deps.getPlanSnapshot !== 'function') throw new Error('syncBoot: getPlanSnapshot zorunlu (DI)');

  // 🔴 PLAN KAPISI MOTORDAN BAĞIMSIZ OKUNUR. Motor yalnız tercih AÇIKKEN kurulur;
  // kapı ise tercih KAPALIYKEN de cevap vermek zorundadır. Aksi hâlde paketinde
  // senkron olmayan bir kullanıcı "Senkron kapalı" + çalışan görünen bir "Aç"
  // düğmesi görürdü — açtığında hiçbir şey olmayan bir düğme. Kilit GİZLENMEZ:
  // yüzey daha tercih açılmadan "bu paket bunu içermiyor" diyebilmeli.
  // (SYNC-F1-6 e2e G ayağının ölçüp kırmızı verdiği durum tam olarak buydu.)
  const planGate = createSyncPlanGate(deps.getPlanSnapshot);

  let engine = null;
  let timer = null;
  /** Son kuruluş denemesinin insan-okur sonucu — ekran bunu gösterir, tahmin etmez. */
  let setup = { ok: false, reason: 'disabled', workspaceKey: null, displayName: null, identityFile: null, created: false };
  let token = null;
  /** SYNC-CLOUD-01 — çözülmüş kiracı (kutu deseni; jetonla aynı ömür). */
  let companyId = null;
  /** Kiracı çözülemedi uyarısı TUR BAŞINA DEĞİL bir kez yazılır (log spam kuralı). */
  let companyLogged = false;

  function currentRoots() {
    const r = deps.getRoots() || {};
    return { workspaceRoot: r.workspaceRoot || null, accountRoot: r.accountRoot || null };
  }

  function teardown(reason) {
    if (timer) { clearTimer(timer); timer = null; }
    engine = null;
    // Hesap/hedef değişmiş olabilir: çözülmüş kiracı BİR SONRAKİ kuruluşa taşınmaz.
    companyId = null;
    companyLogged = false;
    setup = { ok: false, reason, workspaceKey: null, displayName: null, identityFile: null, created: false };
  }

  function build() {
    const roots = currentRoots();
    if (!roots.workspaceRoot || !roots.accountRoot) {
      setup = { ok: false, reason: 'no-roots', workspaceKey: null, displayName: null, identityFile: null, created: false };
      return null;
    }
    const target = deps.getTarget() || {};
    if (!target.url || !target.key) {
      setup = { ok: false, reason: 'no-backend', workspaceKey: null, displayName: null, identityFile: null, created: false };
      return null;
    }
    const id = ensureWorkspaceIdentity(roots.workspaceRoot, { fs, path, crypto, create: true });
    if (!id.ok) {
      setup = { ok: false, reason: id.reason || 'no-identity', workspaceKey: null, displayName: null, identityFile: id.file || null, created: false };
      return null;
    }
    const deviceId = typeof deps.getDeviceId === 'function' ? (deps.getDeviceId() || null) : null;
    const syncDir = path.join(roots.accountRoot, 'sync');
    try {
      const built = createSyncEngine({
        roots,
        client: createSyncClient({
          url: target.url,
          key: target.key,
          // SYNC-CLOUD-01 — ŞEMA HEDEFLE BİRLİKTE SEYAHAT EDER (ADP-621 kuralı).
          // Bulut projede tablolar `public`te değil `app`te; profil başlığı
          // gitmezse PostgREST `public`e bakar ve PGRST205 döner. Bu satır olmadan
          // `syncClient`in başlık üretimi ölü koddur.
          schema: target.schema || null,
          workspaceKey: id.workspaceKey,
          // SYNC-CLOUD-01 — kiracı CANLI okunur: hedef söylüyorsa o, söylemiyorsa
          // `resolveCompanyId()`in çözdüğü (bkz. aşağısı). Kuruluş anında null olması
          // NORMALDİR; ilk turda dolar ve istemci onu o turdan itibaren kullanır.
          getCompanyId: () => (deps.getTarget() || {}).companyId || companyId,
          deviceId,
          fetch: deps.fetch,
          // Oturum jetonu ASENKRON tazelenir (appDbTokenFor), istemci ise SENKRON
          // okur. Kutu deseni: son bilinen jeton verilir, yoksa anon anahtara düşülür
          // (yerel `public` şeması anon'a açıktır — §1.4).
          getToken: () => token,
          log,
        }),
        queue: createSyncQueue({ file: path.join(syncDir, 'queue.json'), log }),
        scanner: createScanner({ roots, log }),
        objectStore: createObjectStore({ root: roots.accountRoot, log }),
        stateFile: path.join(syncDir, 'state.json'),
        scanCacheFile: path.join(syncDir, 'scan-cache.json'),
        workspaceKey: id.workspaceKey,
        deviceId,
        getPlanSnapshot: deps.getPlanSnapshot,
        deriveIndexes: typeof deps.deriveIndexes === 'function' ? deps.deriveIndexes : undefined,
        // SYNC-F1-7 — tercih dokümanı için anahtar-seviyesi LWW kancası. Verilmezse
        // motor NO-OP'a düşer ve `prefs/app-prefs.json` bayt-LWW ile taşınır (yani
        // bir cihazın anahtarı kaybolabilir) — bu yüzden wiring aynı commit'te.
        transformIncoming: typeof deps.transformIncoming === 'function' ? deps.transformIncoming : undefined,
        onPlanDenied: typeof deps.onPlanDenied === 'function' ? deps.onPlanDenied : undefined,
        onStatus: typeof deps.onStatus === 'function' ? deps.onStatus : undefined,
        log,
      });
      built.loadState();
      setup = {
        ok: true, reason: null,
        workspaceKey: id.workspaceKey, displayName: id.displayName,
        identityFile: id.file, created: id.created,
      };
      return built;
    } catch (err) {
      log(`[sync-boot] motor kurulamadı: ${err.message}`);
      setup = { ok: false, reason: `engine-error: ${err.message}`, workspaceKey: null, displayName: null, identityFile: null, created: false };
      return null;
    }
  }

  async function refreshToken() {
    if (typeof deps.getToken !== 'function') return;
    try {
      const t = await deps.getToken();
      token = t && typeof t === 'object' ? (t.ok ? t.token || null : null) : (t || null);
    } catch { token = null; }
  }

  /**
   * SYNC-CLOUD-01 — KİRACIYI ÇÖZ (bir kez).
   *
   * NEDEN BURADA: `account.json`daki `companyId` alanını dolduran `account:setCompany`
   * IPC'sini ÇAĞIRAN yok — alan her kurulumda `null`. Bulutta ise `company_id` NOT NULL
   * ve trigger tarafından doldurulur; istemci `company_id=is.null` süzerse yazdığı
   * satırı bile GERİ OKUYAMAZ (ikinci cihaz sonsuza dek boş kalır).
   *
   * KURAL UYDURULMADI — uygulamanın kendi kuralı (TASKDB-RLS-01 / src/lib/auth.ts
   * resolveOwnCompany): `companies`, `created_at` artan, İLK satır. Satırları zaten
   * RLS süzer, yani sonuç her zaman kullanıcının üyesi OLDUĞU bir şirkettir.
   *
   * KİMLİK YOKSA HİÇ SORULMAZ: yerel 54321 / e2e anon yollarında `company_id` NULL'dur
   * ve bugünkü davranış bit-bit korunur.
   */
  async function resolveCompanyId() {
    if (companyId) return companyId;
    if (!token) return null;                       // kimliksiz yol — bugünkü davranış
    const target = deps.getTarget() || {};
    if (target.companyId) { companyId = String(target.companyId); return companyId; }
    if (!target.url || !target.key) return null;
    const doFetch = typeof deps.fetch === 'function' ? deps.fetch : globalThis.fetch;
    if (typeof doFetch !== 'function') return null;
    const url = `${String(target.url).replace(/\/+$/, '')}/rest/v1/companies?select=id&order=created_at.asc&limit=1`;
    try {
      const res = await doFetch(url, {
        headers: {
          apikey: target.key,
          Authorization: `Bearer ${token}`,
          ...schemaHeaders(target.schema || null, 'GET'),
        },
      });
      const text = await res.text();
      const rows = text ? JSON.parse(text) : null;
      const id = Array.isArray(rows) && rows[0] && rows[0].id ? String(rows[0].id) : null;
      // TEK SATIR: duruş kalıcı olabilir (arka uç hazır değil) ve her tur bunu
      // yeniden yazmak K-3'ün ölçtüğü spam sınıfını yeniden üretirdi.
      if (!id) { if (!companyLogged) { companyLogged = true; log(`[sync-boot] kiracı çözülemedi (http ${res.status}) — company_id'siz devam`); } return null; }
      companyId = id;
      log('[sync-boot] kiracı çözüldü — senkron satırları şirkete bağlanacak');
      return companyId;
    } catch (err) {
      if (!companyLogged) { companyLogged = true; log(`[sync-boot] kiracı çözülemedi (${err.message}) — company_id'siz devam`); }
      return null;
    }
  }

  /** Yedek tur — motorun KENDİ söylediği aralıkta (realtime kanıtı yoksa sık, varsa seyrek). */
  function schedule() {
    if (timer) { clearTimer(timer); timer = null; }
    if (!engine) return;
    const st = engine.getStatus();
    const ms = Number.isFinite(st.pollMs) && st.pollMs > 0 ? st.pollMs : 60000;
    timer = setTimer(() => { void tick(); }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  async function tick(opts = {}) {
    if (!engine) return { ok: false, reason: 'sync-disabled' };
    await refreshToken();
    // Jetondan SONRA: kiracı sorgusu o jetonla yapılır (RLS onu süzer).
    await resolveCompanyId();
    try {
      return await engine.tick(opts);
    } catch (err) {
      log(`[sync-boot] tur hatası: ${err.message}`);
      return { ok: false, reason: 'tick-error', error: err.message };
    } finally {
      schedule();
    }
  }

  /**
   * Tercih/kök/hedef değişmiş olabilir → motoru YENİDEN ÇÖZ.
   * Ayarlar kaydedildiğinde ve açılışta çağrılır. Kapatma ANINDA söker.
   */
  function refresh({ tickNow = false } = {}) {
    const wanted = deps.getEnabled() === true;
    if (!wanted) {
      if (engine) log('[sync-boot] senkron kapatıldı — motor söküldü');
      teardown('disabled');
      return { enabled: false, setup };
    }
    if (!engine) {
      engine = build();
      if (engine) {
        log(`[sync-boot] senkron AÇIK — workspace=${setup.workspaceKey}${setup.created ? ' (yeni kimlik üretildi)' : ''}`);
        void refreshToken();
        schedule();
        if (tickNow) void tick({ reconcile: false });
      }
    }
    return { enabled: Boolean(engine), setup };
  }

  return {
    getEngine: () => engine,
    /** Ekranın "neden kapalı / hangi klasör / hangi kimlik" sorusunun tek cevabı. */
    describe: () => ({
      enabled: Boolean(engine),
      wanted: deps.getEnabled() === true,
      roots: currentRoots(),
      setup: { ...setup },
      // Kapı CANLIDIR (§18.2): her çağrıda yeniden okunur, kuruluşta ölçülmez.
      plan: (() => { try { return planGate.check(); } catch { return null; } })(),
    }),
    refresh,
    tick,
    stop: () => teardown('stopped'),
  };
}

module.exports = { createSyncRuntime, ensureWorkspaceIdentity, WS_KEY_RE, IDENTITY_FILE };
