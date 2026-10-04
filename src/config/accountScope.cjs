// ADP-703 — HESAP-KAPSAMLI YEREL DEPO (tasarım: docs/design/ACCOUNT-SCOPED-STORE.md).
//
// SORUN (ölçüldü, varsayılmadı): bulut tarafı hesap-izole (ADP-623 RLS + ADP-624 company
// trigger) ama masaüstü istemcinin YEREL verisi tek bir kökte (`~/.crewpane[-dev|-test]`)
// duruyordu. `seatGate.signOut()` yalnız `auth/session.bin` + `auth/license.bin` siliyor;
// ayarlar, hafıza, pane defteri, delegasyon defteri, sprint kayıtları, ofis düzeni
// olduğu yerde kalıyor ve BİR SONRAKİ HESABA AYNEN görünüyordu.
//
// ÇÖZÜM: veri kökü hesaba göre ayrışır —
//     <instanceRoot>/accounts/<accountKey>/…
// `accountKey` oturumdan TÜRETİLİR (kimliğe göre hardcode YOK):
//     giriş var → 'u-' + userId (CrewPane ID)      giriş yok → 'local'
//
// NEDEN userId, companyId DEĞİL: kök main sürecinde, PENCERE AÇILMADAN, AĞSIZ çözülmek
// zorunda. companyId yalnız renderer'da bir Supabase sorgusuyla çözülür ve o sorgu
// HATA VERİRSE `CREWPANE_COMPANY_ID` kalkanına düşer (ADP-702 §1.3 / P1-3) — yani ağ
// hatası yerel kökü Eren'in kiracısına düşürürdü. userId oturum blob'unda, offline,
// deterministik. companyId yine `account.json`'a YAZILIR (ADP-704 bulut eşlemesi onu
// kullanır) ama YOL ona bağlı değildir.
//
// SAF MODÜL: Electron bağı yok, `instancePaths` bağı yok (döngü olmasın — instancePaths
// BUNU require eder), tüm I/O `opts.fs` dikişiyle değiştirilebilir. `node --test` ile koşar:
//     node --test electron/accountScope.test.cjs

'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
// ADP-835 (790 K1) — atomik yazımın rename adımı platform boğazından geçer:
// Windows'ta Defender/Search hedefi açık tutunca EPERM/EBUSY gelir ve bu çağrıların
// çoğu best-effort catch içinde OLDUĞU İÇİN kayıt SESSİZCE kaybolurdu.
const { renameWithRetrySync } = require('../../platform/atomicWrite.cjs');
// ADP-835 (790 I1) — hesap kökünün 0700 iddiası platforma göre DEĞİŞİR: POSIX'te
// ölçülebilir, Windows'ta izin bitleri anlamsız ve ACL'i ölçmedik. Boğaz bunu SÖYLER.
const { restrictDir } = require('../../platform/restrictPath.cjs');

/** Giriş YAPILMAMIŞ durumun deterministik kökü (dev kopyası, e2e, müşteride login öncesi). */
const ANON_ACCOUNT_KEY = 'local';

/** `<instanceRoot>/accounts` — tüm hesap köklerinin kabı. */
const ACCOUNTS_DIR = 'accounts';

/** Hesap kökünün meta dosyası (ADP-704 senkron alanları burada). */
const ACCOUNT_META_FILE = 'account.json';

/** Instance kökünde: hangi hesap bağlı (AÇILIŞTA senkron okunur — sır İÇERMEZ). */
const ACTIVE_ACCOUNT_FILE = 'active-account.json';

/** Instance kökünde: bu makinenin kimliği (ADP-704 çatışma çözümü). */
const DEVICE_FILE = 'device.json';

/** Eski (kapsamsız) verinin hangi hesaba taşındığının kaydı — idempotency + geri alma. */
const CLAIM_MANIFEST_FILE = '.claim-manifest.json';

const SCHEMA_VERSION = 1;

/**
 * CİHAZA ait olduğu için hesap köküne TAŞINMAYAN girdiler (docs/design/ACCOUNT-SCOPED-STORE.md §2).
 * Bu liste TEK GERÇEKTİR: burada adı geçmeyen her yeni dosya HESABA aittir (fail-closed —
 * unuttuğumuz bir dosya sızıntı değil, yalnız hesap başına kopya üretir).
 */
const DEVICE_ENTRIES = Object.freeze([
  // ── önyükleme / sır ────────────────────────────────────────────────────────
  'auth',                       // session.bin + license.bin + .keychain-scope: hesabı BUNLAR belirler → hesap kökünde olamaz (döngü)
  // ── çalışma-anı plumbing ───────────────────────────────────────────────────
  'bridge.json',                // her açılışta yeniden yazılır (port + token)
  'keep-awake.pid',
  // ── makine kurulumu / global önbellek ──────────────────────────────────────
  'crewpane-public-env.json',
  'announcements-cache.json',   // GLOBAL duyuruların çevrimdışı kopyası (kullanıcıya özel değil)
  'screenshots-moved-notice.json',
  'shots',
  // ── log / yedek / artık ────────────────────────────────────────────────────
  'crewpane-shell.log',
  'spike-log.txt',
  'spike-log.prev.txt',
  'backups',
  'RECOVERY-NOTES.md',
  '.DS_Store',
  // ── bu modülün kendi dosyaları ─────────────────────────────────────────────
  ACCOUNTS_DIR,
  ACTIVE_ACCOUNT_FILE,
  DEVICE_FILE,
]);

/**
 * Instance kökünden hesap köküne TAŞINACAK tam adlar (§2'nin "A" satırları).
 * Tam-ad listesi + tek bir desen (`briefing-settings-*.json`) kullanılır; joker tarama
 * YOKTUR — `live-panes.pre-027-install.json` gibi elle alınmış yedekler yerinde kalmalı.
 */
const ACCOUNT_ENTRIES = Object.freeze([
  'settings.json',
  'memory',
  'sprint-runs',
  'jarvis-conversation.json',
  'delegation-queue.json',
  'delegation-supervisor.json',
  'resume-queue.json',
  'resume-notifications.log',
  'live-panes.json',
  'live-panes.quit-snapshot.json',
  'pane-sessions.json',
  'pane-sessions.jsonl', // ADP-734 Kapı 3 — silinmeyen oturum journal'ı
  'popout-bounds.json',
  'credentials',
  'browser-audit.jsonl',
  'mobile-devices.json',
  'mobile-audit.log',
  'mobile-audit.log.1',
  'mobile-uploads',
  // BOARD-IMG-2 — görev kartı ekleri (içerik-adresli görseller). Hesap-kapsamlı:
  // `mobile-uploads` / `memory` / `credentials` ile aynı raf. TTL YOK, silme
  // MANTIKSALDIR (attachmentStore.cjs başlığı) → bu klasör kullanıcı verisidir.
  'task-attachments',
  'delegate-mcp.json',
  'browser-mcp.json',
  'task-mcp.json',
  'integrations-mcp.json',
]);

/** Ek desen: her ajanın brifing tercihi (`briefing-settings-<agent>.json`). */
const ACCOUNT_ENTRY_PATTERNS = Object.freeze([/^briefing-settings-[A-Za-z0-9._-]+\.json$/]);

/**
 * ADP-734 Kapı 1(a) — GÖÇTE TAŞINMAZ, **KOPYALANIR**.
 *
 * KÖK NEDEN (ADP-732): bu göç `live-panes.json`'ı hesap köküne TAŞIDI. Kullanıcı
 * (yeni sürümde bir sorun çıktığı için) 0.2.20'ye GERİ DÖNDÜ; o sürüm `accounts/`
 * kavramını bilmediğinden kök yolu okudu, dosyayı bulamadı ve `loadRegistry`
 * SESSİZCE boş defter verdi → 7 canlı ajan oturumu ekrandan silindi.
 *
 * Göç ileriye test edilir, GERİ DÖNÜŞ test edilmez — ama kullanıcı yeni sürüm
 * bozuksa hep geri döner. Bu yüzden "kurtarma sınıfı" dosyalar için göç TEK YÖNLÜ
 * BİR KAPI OLAMAZ: kaynakta bir KOPYA bırakılır. Bedeli birkaç KB bayat veri;
 * karşılığı, eski sürümün de canlı oturumları bulabilmesi.
 *
 * Bu listeye yalnız (a) kaybı geri alınamaz ve (b) çoğaltılması zararsız olan
 * dosyalar girer. Ayarlar/hafıza gibi ÇİFT-YAZILAN dosyalar buraya GİRMEZ —
 * onlarda iki kopya "hangisi doğru" sorusunu doğurur.
 */
const COPY_ENTRIES = Object.freeze([
  'live-panes.json',
  'live-panes.quit-snapshot.json',
  'pane-sessions.jsonl',
]);

/** Kökte bırakılan işaret taşı: "bu verinin kanonik kopyası artık şurada". */
const MIGRATED_POINTER_FILE = 'live-panes.migrated.json';

/**
 * Dizin adı olarak GÜVENLİ hesap anahtarı.
 * `CREWPANE_ACCOUNT` env'i kullanıcı/child tarafından set edilebildiği için burada
 * path-traversal ('..', '/', boş) YAPISAL olarak imkânsız kılınır.
 * @returns {string|null} kullanılamaz değer → null (asla "geçerli" demez)
 */
function normalizeAccountKey(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  const cleaned = s.replace(/[^a-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^[.-]+|[.-]+$/g, '');
  if (!cleaned || cleaned === '.' || cleaned === '..') return null;
  return cleaned.slice(0, 80);
}

/**
 * Oturumdan hesap anahtarı. KİMLİĞE GÖRE HARDCODE YOK: karar yalnız "userId var mı"
 * durumundan türer (isim/marka/e-posta kontrolü yoktur).
 * @param {{signedIn?: boolean, userId?: string|null}|null} session
 */
function accountKeyForSession(session) {
  const signedIn = !!(session && session.signedIn);
  const userId = session && typeof session.userId === 'string' ? session.userId : '';
  if (!signedIn || !userId.trim()) return ANON_ACCOUNT_KEY;
  const key = normalizeAccountKey(`u-${userId}`);
  return key || ANON_ACCOUNT_KEY;
}

/** `<instanceRoot>/accounts` */
function accountsDir(instanceRoot) {
  return path.join(instanceRoot, ACCOUNTS_DIR);
}

/** `<instanceRoot>/accounts/<key>` — anahtar geçersizse null (çağıran kapsamsız köke düşer). */
function accountRoot(instanceRoot, key) {
  const k = normalizeAccountKey(key);
  return k ? path.join(accountsDir(instanceRoot), k) : null;
}

function activeAccountPath(instanceRoot) { return path.join(instanceRoot, ACTIVE_ACCOUNT_FILE); }
function devicePath(instanceRoot) { return path.join(instanceRoot, DEVICE_FILE); }
function claimManifestPath(instanceRoot) { return path.join(accountsDir(instanceRoot), CLAIM_MANIFEST_FILE); }
function accountMetaPath(root) { return path.join(root, ACCOUNT_META_FILE); }

/** Best-effort JSON okuma — bozuk/eksik dosya → null (asla atmaz). */
function readJson(fsMod, file) {
  try {
    const parsed = JSON.parse(fsMod.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

/** Atomik yazım (tmp + rename): yarım yazılmış bir meta dosyası hesabı kaybettirmesin. */
function writeJson(fsMod, file, value) {
  const tmp = `${file}.tmp`;
  fsMod.mkdirSync(path.dirname(file), { recursive: true });
  fsMod.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameWithRetrySync(tmp, file, { fs: fsMod });
  return file;
}

/**
 * Bu makinenin kimliği. ADP-704'te çatışma çözümü ("son yazan hangi cihaz") bunu kullanır.
 * Bir kez üretilir, sonra sabittir. Kişisel veri İÇERMEZ (rastgele).
 */
function ensureDeviceId(instanceRoot, opts = {}) {
  const fsMod = opts.fs || require('node:fs');
  const file = devicePath(instanceRoot);
  const existing = readJson(fsMod, file);
  if (existing && typeof existing.deviceId === 'string' && existing.deviceId) return existing.deviceId;
  const deviceId = `d-${(opts.randomId || (() => crypto.randomBytes(8).toString('hex')))()}`;
  try {
    writeJson(fsMod, file, {
      schemaVersion: SCHEMA_VERSION,
      deviceId,
      createdAt: new Date(opts.now || Date.now()).toISOString(),
    });
  } catch { /* best-effort: kimlik yazılamasa da uygulama çalışmalı */ }
  return deviceId;
}

/** Bağlı hesap kaydı (AÇILIŞTA senkron okunur). Sır İÇERMEZ — yalnız işaretçi. */
function readActiveAccount(instanceRoot, opts = {}) {
  const fsMod = opts.fs || require('node:fs');
  const rec = readJson(fsMod, activeAccountPath(instanceRoot));
  if (!rec) return null;
  const key = normalizeAccountKey(rec.accountKey);
  return key ? { ...rec, accountKey: key } : null;
}

function writeActiveAccount(instanceRoot, rec, opts = {}) {
  const fsMod = opts.fs || require('node:fs');
  const key = normalizeAccountKey(rec && rec.accountKey);
  if (!key) throw new Error('writeActiveAccount: geçersiz accountKey');
  return writeJson(fsMod, activeAccountPath(instanceRoot), {
    schemaVersion: SCHEMA_VERSION,
    accountKey: key,
    userId: (rec && rec.userId) || null,
    email: (rec && rec.email) || null,
    boundAt: new Date((opts.now) || Date.now()).toISOString(),
  });
}

/** Hesap kökünün meta'sı (§3.4). Yoksa null. */
function readAccountMeta(root, opts = {}) {
  const fsMod = opts.fs || require('node:fs');
  return readJson(fsMod, accountMetaPath(root));
}

/**
 * `account.json`'u OLUŞTUR/GÜNCELLE. `createdAt` bir kez yazılır, `updatedAt` her
 * çağrıda tazelenir (ADP-704 senkron karşılaştırması bu alanı okur).
 * Bilinmeyen alanlar KORUNUR (ileri sürüm uyumu).
 */
function upsertAccountMeta(root, patch, opts = {}) {
  const fsMod = opts.fs || require('node:fs');
  const nowIso = new Date(opts.now || Date.now()).toISOString();
  const prev = readAccountMeta(root, { fs: fsMod }) || {};
  const next = {
    lastSyncedAt: null, // ADP-704 — son başarılı bulut yüklemesi
    syncCursor: null,   // ADP-704 — sunucu tarafı delta imleci
    companyId: null,    // renderer çözünce doldurulur (yol buna BAĞLI DEĞİL — §3.1)
    ...prev,
    ...(patch || {}),
    schemaVersion: SCHEMA_VERSION,
    createdAt: prev.createdAt || nowIso,
    updatedAt: nowIso,
  };
  writeJson(fsMod, accountMetaPath(root), next);
  return next;
}

/** Hesap kökü + meta iskelesi. İdempotent. */
function ensureAccountRoot(instanceRoot, key, meta = {}, opts = {}) {
  const fsMod = opts.fs || require('node:fs');
  const root = accountRoot(instanceRoot, key);
  if (!root) throw new Error(`ensureAccountRoot: geçersiz accountKey "${key}"`);
  fsMod.mkdirSync(root, { recursive: true, mode: 0o700 });
  restrictDir(root, { fs: fsMod }); // ADP-835 (790 I1) — win32'de durumu dürüstçe raporlar
  upsertAccountMeta(root, { accountKey: normalizeAccountKey(key), ...meta }, { fs: fsMod, now: opts.now });
  return root;
}

/** Bir instance-kökü girdisi hesap kökene taşınmalı mı? */
function isAccountEntry(name) {
  if (typeof name !== 'string' || !name) return false;
  if (DEVICE_ENTRIES.includes(name)) return false;
  if (ACCOUNT_ENTRIES.includes(name)) return true;
  return ACCOUNT_ENTRY_PATTERNS.some((re) => re.test(name));
}

/**
 * Taşınacak girdileri LİSTELE (yan etkisiz — "önce göster, sonra yap").
 * @returns {{alreadyClaimed:boolean, claimedBy:string|null, entries:string[]}}
 */
function planLegacyClaim(instanceRoot, opts = {}) {
  const fsMod = opts.fs || require('node:fs');
  const manifest = readJson(fsMod, claimManifestPath(instanceRoot));
  if (manifest) {
    return { alreadyClaimed: true, claimedBy: manifest.claimedBy || null, entries: [] };
  }
  let names = [];
  try { names = fsMod.readdirSync(instanceRoot); } catch { names = []; }
  return { alreadyClaimed: false, claimedBy: null, entries: names.filter(isAccountEntry).sort() };
}

/**
 * ESKİ (kapsamsız) VERİYİ İLK BAĞLANAN HESABA TAŞI — Eren'in bugünkü verisi kaybolmasın.
 *
 * • İDEMPOTENT: manifest varsa hiçbir şey yapmaz (iki kez koşmak güvenli).
 * • KAYIPSIZ: yalnız `rename` kullanır — hiçbir adımda silme/üzerine yazma YOKTUR.
 *   Hedefte aynı adlı bir şey varsa o girdi ATLANIR (yeni hesabın verisi ezilmez).
 * • GERİ ALINABİLİR: her taşıma manifest'e yazılır; `scripts/accountScopeRollback.cjs`
 *   manifest'i ters uygular.
 *
 * @returns {{claimed:boolean, alreadyClaimed:boolean, moved:Array<{name:string,from:string,to:string}>, skipped:string[]}}
 */
function claimLegacyData(instanceRoot, key, opts = {}) {
  const fsMod = opts.fs || require('node:fs');
  const log = opts.log || (() => {});
  const plan = planLegacyClaim(instanceRoot, { fs: fsMod });
  if (plan.alreadyClaimed) return { claimed: false, alreadyClaimed: true, moved: [], skipped: [] };

  const root = accountRoot(instanceRoot, key);
  if (!root) throw new Error(`claimLegacyData: geçersiz accountKey "${key}"`);
  fsMod.mkdirSync(root, { recursive: true, mode: 0o700 });
  restrictDir(root, { fs: fsMod }); // ADP-835 (790 I1) — win32'de durumu dürüstçe raporlar

  const moved = [];
  const copied = [];
  const skipped = [];
  for (const name of plan.entries) {
    const from = path.join(instanceRoot, name);
    const to = path.join(root, name);
    let occupied = false;
    try { fsMod.statSync(to); occupied = true; } catch { occupied = false; }
    if (occupied) { skipped.push(name); continue; } // hedefte veri VAR → ASLA ezme
    // ADP-734 Kapı 1(a) — kurtarma sınıfı: KOPYALA, kaynağı yerinde BIRAK.
    if (COPY_ENTRIES.includes(name)) {
      try {
        fsMod.copyFileSync(from, to);
        copied.push({ name, from, to, mode: 'copy' });
        continue;
      } catch (e) {
        // Kopyalanamıyorsa (ör. dizin) taşımaya DÜŞME — veri kökte kalsın, log'a düşsün.
        skipped.push(name);
        log(`[account] "${name}" kopyalanamadı (kökte bırakıldı): ${e.message}`);
        continue;
      }
    }
    try {
      renameWithRetrySync(from, to, { fs: fsMod });
      moved.push({ name, from, to });
    } catch (e) {
      skipped.push(name);
      log(`[account] "${name}" taşınamadı: ${e.message}`);
    }
  }

  // İşaret taşı: eski sürüm/insan "veri nereye gitti" sorusunu dosya sisteminden
  // cevaplayabilsin (ADP-732'de bu soru 30 yedek dosyası taramayı gerektirmişti).
  if (copied.length || moved.length) {
    try {
      writeJson(fsMod, path.join(instanceRoot, MIGRATED_POINTER_FILE), {
        schemaVersion: SCHEMA_VERSION,
        note: 'ADP-703 hesap-kapsamlı depo. Kanonik kopya accountRoot altındadır; buradaki kopyalar geri-dönüş güvenliği içindir.',
        accountKey: normalizeAccountKey(key),
        accountRoot: root,
        copied: copied.map((c) => c.name),
        moved: moved.map((m) => m.name),
        at: new Date(opts.now || Date.now()).toISOString(),
      });
    } catch { /* işaret taşı best-effort */ }
  }

  // Manifest, taşınacak bir şey OLMASA DA yazılır: "bu depo hesap-kapsamlıya geçti"
  // işareti odur; yoksa her açılışta yeniden tarama yapılırdı.
  writeJson(fsMod, claimManifestPath(instanceRoot), {
    schemaVersion: SCHEMA_VERSION,
    claimedBy: normalizeAccountKey(key),
    claimedAt: new Date(opts.now || Date.now()).toISOString(),
    moved,
    copied, // ADP-734 — kaynağı yerinde bırakılan kurtarma-sınıfı dosyalar
    skipped,
  });
  if (moved.length) {
    log(`[account] eski yerel veri "${key}" hesabına taşındı (${moved.length} girdi): ${moved.map((m) => m.name).join(', ')}`);
  }
  if (copied.length) {
    log(`[account] kurtarma-sınıfı ${copied.length} dosya KOPYALANDI (kökte de duruyor): ${copied.map((c) => c.name).join(', ')}`);
  }
  return { claimed: true, alreadyClaimed: false, moved, copied, skipped };
}

/**
 * Migration'ı GERİ AL (manifest'i ters uygula). `scripts/accountScopeRollback.cjs` kullanır.
 * @returns {{restored:string[], missing:string[], blocked:string[]}}
 */
function rollbackLegacyClaim(instanceRoot, opts = {}) {
  const fsMod = opts.fs || require('node:fs');
  const file = claimManifestPath(instanceRoot);
  const manifest = readJson(fsMod, file);
  if (!manifest || !Array.isArray(manifest.moved)) {
    return { restored: [], missing: [], blocked: [], reason: 'no_manifest' };
  }
  // ADP-734 — `copied` girdilerinde kaynak HİÇ TAŞINMADI: geri alınacak bir şey yok.
  // Hesap kökündeki kopya o hesabın canlı verisidir; silinmez.
  const copies = Array.isArray(manifest.copied) ? manifest.copied.map((c) => c && c.name).filter(Boolean) : [];
  const restored = [];
  const missing = [];
  const blocked = [];
  for (const entry of manifest.moved) {
    if (!entry || typeof entry.from !== 'string' || typeof entry.to !== 'string') continue;
    try { fsMod.statSync(entry.to); } catch { missing.push(entry.name); continue; }
    let occupied = false;
    try { fsMod.statSync(entry.from); occupied = true; } catch { occupied = false; }
    if (occupied) { blocked.push(entry.name); continue; } // kaynakta yeni veri var → ezme
    try {
      renameWithRetrySync(entry.to, entry.from, { fs: fsMod });
      restored.push(entry.name);
    } catch { blocked.push(entry.name); }
  }
  if (!blocked.length) {
    try { fsMod.unlinkSync(file); } catch { /* best-effort */ }
  }
  return { restored, missing, blocked };
}

/**
 * SIZINTI NÖBETİ yardımcısı (test + teşhis): iki hesap kökü birbirinden tamamen ayrı mı?
 * "Ayrı" = ne aynı dizin, ne biri diğerinin altında.
 */
function rootsAreIsolated(rootA, rootB) {
  if (typeof rootA !== 'string' || typeof rootB !== 'string' || !rootA || !rootB) return false;
  const a = path.resolve(rootA);
  const b = path.resolve(rootB);
  if (a === b) return false;
  return !a.startsWith(b + path.sep) && !b.startsWith(a + path.sep);
}

module.exports = {
  ANON_ACCOUNT_KEY,
  ACCOUNTS_DIR,
  ACCOUNT_META_FILE,
  ACTIVE_ACCOUNT_FILE,
  DEVICE_FILE,
  CLAIM_MANIFEST_FILE,
  SCHEMA_VERSION,
  DEVICE_ENTRIES,
  ACCOUNT_ENTRIES,
  normalizeAccountKey,
  accountKeyForSession,
  accountsDir,
  accountRoot,
  activeAccountPath,
  devicePath,
  claimManifestPath,
  accountMetaPath,
  ensureDeviceId,
  readActiveAccount,
  writeActiveAccount,
  readAccountMeta,
  upsertAccountMeta,
  ensureAccountRoot,
  isAccountEntry,
  planLegacyClaim,
  claimLegacyData,
  rollbackLegacyClaim,
  rootsAreIsolated,
};
