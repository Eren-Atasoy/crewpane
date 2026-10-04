// ADP-592 — safeStorage'ın KEYCHAIN KİMLİĞİ (macOS "… Safe Storage" öğesi).
//
// SORUN (ölçülmüş, tahmin değil): macOS'ta Electron safeStorage'ın master anahtarı
// login keychain'de `${app.getName()} Safe Storage` adlı bir generic-password
// öğesinde durur. Öğeyi hangi ikili YARATIRSA, macOS o ikiliyi öğenin ACL'ine
// "güvenilen uygulama" olarak yazar. Developer ID ile imzalı bir app yarattıysa
// kayıt KİMLİK+EKİP bazlıdır (`identifier "…" and … certificate leaf[subject.OU]
// = "<TEAMID>"`, partition `teamid:<TEAMID>`) → her güncellemede geçerli kalır ve
// kullanıcıya ASLA şifre sorulmaz (Chrome/Claude/Codex hepsi böyle).
// İMZASIZ dev Electron yarattıysa kayıt `cdhash H"…"` ile o TEK ikiliye çakılır;
// imzalı ürün app'i ACL'de olmadığı için macOS HER AÇILIŞTA "CrewPane wants to
// use confidential information…" diyaloğunu basar.
//
// CrewPane'te tam olarak bu oldu: `crewpane-shell Safe Storage` öğesini
// 2026-07-14'te `node_modules/electron/dist/Electron.app` (imzasız dev Electron)
// yarattı; /Applications/CrewPane.app o ACL'de yok → her açılışta sorgu.
// Üstelik safeStorage çağrısı SENKRON'dur: diyalog yanıtlanana kadar main thread
// bloke olur (ölçüm: 37 sn açılış donması).
//
// ÇÖZÜM: keychain kimliğini KANALA göre ayır. Ürün (paketli + PROD instance)
// "CrewPane" adını kullanır — kaynak/dev/test koşuları ASLA o öğeye dokunamaz,
// dolayısıyla imzasız bir ikili ürünün keychain öğesini bir daha kirletemez.
// Ad app.getName() üzerinden verilir (Electron'un tek dikişi), bu yüzden main.js
// adı değiştirdikten SONRA yol köklerini (userData/logs/…) eski değerlerine geri
// sabitler — hiçbir veri taşınmaz.
//
// Saf modül: Electron'a require-bağı YOK (isPackaged/instanceId enjekte edilir) →
// `node --test` ile koşar.

'use strict';

const path = require('node:path');
// ADP-835 (790 K1) — atomik yazımın rename adımı platform boğazından geçer:
// Windows'ta Defender/Search hedefi açık tutunca EPERM/EBUSY gelir ve bu çağrıların
// çoğu best-effort catch içinde OLDUĞU İÇİN kayıt SESSİZCE kaybolurdu.
// ADP-943 — MARKÖR YAZIMI DA aynı boğazdan geçiyor (aşağıdaki gerekçe).
const { renameWithRetrySync, atomicWriteFileSync } = require('../../platform/atomicWrite.cjs');
// ADP-835 (790 I1) — auth/ dizininin 0700 iddiası platforma göre DEĞİŞİR: POSIX'te
// ölçülebilir, Windows'ta izin bitleri anlamsız ve ACL'i ölçmedik. Boğaz bunu SÖYLER.
const { restrictDir, restrictFile } = require('../../platform/restrictPath.cjs');

const PROD = 'prod';
const DEV = 'dev';
const TEST = 'test';

/** Diskteki markör: blob'ların hangi keychain kapsamıyla yazıldığını söyler. */
const SCOPE_MARKER = '.keychain-scope';

/**
 * safeStorage için kullanılacak app adı (Keychain servis adı = `<ad> Safe Storage`).
 *
 * KURAL: ürün adını YALNIZ paketli + PROD instance alır. Kaynaktan koşan bir
 * Electron (imzasız, her `npm i electron`'da cdhash'i değişir) CREWPANE_INSTANCE=prod
 * ile zorlansa bile ürünün öğesini yaratamaz — bu, bu bug'ın tekrar etmesini
 * yapısal olarak imkânsız kılar.
 *
 * @param {{isPackaged?: boolean, instanceId?: string}} opts
 * @returns {string}
 */
function safeStorageAppName(opts = {}) {
  const isPackaged = opts.isPackaged === true;
  const instanceId = opts.instanceId === DEV || opts.instanceId === TEST
    ? opts.instanceId
    : PROD;
  if (instanceId === TEST) return 'CrewPane Test';
  if (instanceId === DEV) return 'CrewPane Dev';
  return isPackaged ? 'CrewPane' : 'CrewPane Dev';
}

/** İnsan/log için: macOS'ta gerçekten aranan keychain servis adı. */
function keychainServiceName(appName) {
  return `${appName} Safe Storage`;
}

/**
 * Kapsam markörünü KALICI olarak yaz ve GERİ OKUYARAK doğrula.
 *
 * ADP-943 — NEDEN AYRI + NEDEN atomicWrite BOĞAZI. Eski kod markörü çıplak
 * `fs.writeFileSync` ile yazıyordu. ADP-835'in ölçtüğü Windows gerçeği tam da
 * bunu vuruyor: Defender/Search yeni yazılan dosyayı açık tutunca yazım
 * `EPERM`/`EBUSY` ile düşer. Markör yazılamayınca `previous` sonsuza dek `null`
 * kalır ⇒ bir SONRAKİ açılışta kapsam yine "değişmiş" görünür (ölçüldü:
 * scratchpad/proof-marker-loop.cjs → 3 açılışın 3'ünde de oturum .bak'a alındı).
 *
 * Yazımı `atomicWriteFileSync`e taşımak iki şey birden getirir: win32'de
 * rename'in yeniden denenmesi ve yarım kalan `.tmp` artığının temizlenmesi.
 * Üstüne GERİ OKUMA koyuyoruz — "yazdım" iddiası değil, "diskte duruyor" ölçümü.
 *
 * @returns {{ok:true} | {ok:false, reason:string}}
 */
function persistScopeMarker(authDir, markerPath, scope, fsMod, platform) {
  try {
    fsMod.mkdirSync(authDir, { recursive: true, mode: 0o700 });
    atomicWriteFileSync(markerPath, `${scope}\n`, {
      fs: fsMod, mode: 0o600, mkdir: false, platform,
    });
    // ADP-835 (790 I1) — win32'de durumu dürüstçe raporlar (mutasyon değil, kapsam beyanı).
    restrictDir(authDir, { fs: fsMod, platform });
    restrictFile(markerPath, { fs: fsMod, platform });
  } catch (e) {
    return { ok: false, reason: `${e.code ? `${e.code}: ` : ''}${e.message}` };
  }
  // GERİ OKUMA: yazım sessizce boşa gitmiş olabilir (ağ sürücüsü, AV karantinası).
  let readBack = null;
  try { readBack = fsMod.readFileSync(markerPath, 'utf8').trim(); } catch (e) {
    return { ok: false, reason: `geri okunamadı (${e.code || e.message})` };
  }
  if (readBack !== scope) return { ok: false, reason: `geri okuma uyuşmuyor (${readBack || 'boş'})` };
  return { ok: true };
}

/**
 * Keychain kapsamı DEĞİŞTİĞİNDE eski blob'ları güvenli tarafa al.
 *
 * Ad değişince master anahtar da değişir → eski `session.bin`/`license.bin` artık
 * ÇÖZÜLEMEZ. Kod zaten fail-closed (çözülemeyen blob = çıkış yapılmış sayılır),
 * ama diskte sessizce çözülemeyen bir dosya bırakmak "neden çıkış yaptım?"
 * sorusunu cevapsız bırakır. Burada SİLMEK yerine `<ad>.pre-<kapsam>.bak`'a
 * TAŞIRIZ (geri dönülebilir) ve markörü yazarız.
 *
 * İDEMPOTENT: markör güncelse hiçbir şey yapmaz (iki kez koşmak güvenli).
 *
 * ⛔ ADP-943 — SIRA: ÖNCE KAYDET, SONRA YIK. Eski sıra (önce taşı, sonra markör)
 * Windows'ta SONSUZ LOGIN DÖNGÜSÜ üretiyordu: markör yazımı geçici bir dosya
 * kilidine takıldığında oturum blob'u ZATEN taşınmış oluyordu ve hiçbir kayıt
 * kalmadığı için aynı yıkım HER AÇILIŞTA tekrarlanıyordu. Artık markör kalıcı
 * olarak yazılıp GERİ OKUNMADAN hiçbir blob'a dokunulmaz.
 *
 * Ters sıranın maliyeti YOK: markör yazılıp taşıma düşerse geride yalnız
 * ÇÖZÜLEMEYEN bir blob kalır — `load()` onu zaten `null` sayar (fail-closed),
 * kullanıcı bir kez giriş yapar ve blob üzerine yazılır.
 *
 * @param {object} opts
 * @param {string} opts.homeDir  - <crewpaneHome> (~/.crewpane | -dev | -test)
 * @param {string} opts.scope    - safeStorageAppName() çıktısı
 * @param {object} [opts.fs]     - test dikişi (node:fs uyumlu)
 * @param {string} [opts.platform] - test dikişi; atomicWrite/restrictPath'in ZATEN
 *   kabul ettiği `deps.platform` ile aynı sözleşme. Verilmezse `process.platform`.
 *   Windows'a özgü yeniden-deneme yolu macOS'ta böyle ÖLÇÜLÜR.
 * @param {(line:string)=>void} [opts.log]
 * @returns {{migrated: string[], scope: string, changed: boolean,
 *           blocked?: boolean, reason?: string}}
 */
function migrateAuthBlobs(opts) {
  const fsMod = opts.fs || require('node:fs');
  const log = opts.log || (() => {});
  const platform = opts.platform || process.platform;
  const { homeDir, scope } = opts;
  const authDir = path.join(homeDir, 'auth');
  const markerPath = path.join(authDir, SCOPE_MARKER);

  let previous = null;
  try { previous = fsMod.readFileSync(markerPath, 'utf8').trim() || null; } catch { previous = null; }
  if (previous === scope) return { migrated: [], scope, changed: false };

  // 1) KAYDET. Kalıcı olarak yazılamıyorsa hiçbir şey YIKMA.
  const marker = persistScopeMarker(authDir, markerPath, scope, fsMod, platform);
  if (!marker.ok) {
    log(`⛔ keychain scope markörü KALICI yazılamadı (${marker.reason}) — `
      + 'oturum blob\'larına DOKUNULMADI. ADP-943: markörsüz taşıma her açılışta '
      + 'tekrarlanır ve kullanıcıyı sonsuz giriş döngüsüne sokar.');
    return { migrated: [], scope, changed: false, blocked: true, reason: marker.reason };
  }

  // 2) YIK (artık geri dönülebilir ve TEK SEFERLİK).
  const migrated = [];
  for (const name of ['session.bin', 'license.bin']) {
    const src = path.join(authDir, name);
    try { fsMod.statSync(src); } catch { continue; } // dosya yok → taşınacak bir şey yok
    // `previous` null ise blob ADP-592 ÖNCESİ kapsamdan ('crewpane-shell') gelir.
    const tag = (previous || 'crewpane-shell').replace(/[^A-Za-z0-9._-]/g, '_');
    const dest = `${src}.pre-${tag}.bak`;
    try {
      renameWithRetrySync(src, dest, { fs: fsMod, platform });
      migrated.push(name);
    } catch (e) {
      log(`keychain scope migration: ${name} taşınamadı (${e.message})`);
    }
  }

  if (migrated.length) {
    log(`keychain kapsamı değişti (${previous || 'crewpane-shell'} → ${scope}) — `
      + `eski oturum blob'ları .bak'a alındı: ${migrated.join(', ')} (bir kez yeniden giriş gerekir)`);
  }
  return { migrated, scope, changed: true };
}

/**
 * LX-SCHEME-01 (HATA-11 D6) — SIR SAKLAMANIN GERÇEK DURUMU, AÇILIŞTA ÖLÇÜLÜR.
 *
 * ## Neden bu fonksiyon var (ÖLÇÜLDÜ — LX-LOGIN-01 §2.3, 4 kollu A/B)
 *
 * Chromium'un sır arka ucunu seçen şey libsecret'ın KURULU OLMASI DEĞİL, masaüstü
 * ortamının TANINMASIDIR. `XDG_CURRENT_DESKTOP` beyan edilmemişse — anahtarlık
 * AYAKTA ve `secret-tool store/lookup` ÇALIŞIRKEN bile — Electron `basic_text`
 * seçer, `isEncryptionAvailable()` `false` döner ve `credentialVault` düz metni
 * REDDETTİĞİ için (ADR-027/G2) oturum SAKLANAMAZ: kullanıcı giriş yapar, her
 * açılışta yeniden sorulur.
 *
 * Ölçülen dört kol (hepsi AYNI paket, AYNI anahtarlık):
 *   a) dbus yok                                → false / basic_text        / THROW
 *   b) dbus var, keyring yok                   → false / basic_text        / THROW
 *   c) dbus + keyring AÇIK, XDG_CURRENT_DESKTOP YOK → false / basic_text   / THROW
 *   d) c + XDG_CURRENT_DESKTOP=GNOME           → true  / gnome_libsecret   / ✅
 *
 * ⚠️ AÇIK YARA: bugün ürün bunu HİÇBİR YERDE SÖYLEMİYORDU (yalnız keychain
 * kapsam adı loglanıyordu). Bir müşteride tetiklenirse hiçbir logda görünmez.
 * Bu fonksiyon ADR-CREWPANE-LINUX §9'un 1. maddesini (ölç + logla) kapatır.
 * 2. ve 3. maddeler (basic_text ise sır YAZMA + kullanıcıya SÖYLE, arka uç
 * enjekte edilebilir olsun) LX-SAFESTORAGE-01 kartının işidir — bu fonksiyon
 * hiçbir şeyi ENGELLEMEZ, yalnız ÖLÇER.
 *
 * `getSelectedStorageBackend()` Electron'da YALNIZ Linux'ta vardır; başka
 * platformda çağrılmaz (varsa da anlamı yoktur).
 *
 * @param {{safeStorage:object, platform?:string}} opts — `safeStorage` enjekte
 *   edilir (test gerçek Electron'a muhtaç olmasın diye).
 * @returns {{available:boolean|null, backend:string|null, plaintext:boolean}}
 *   `available:null` = ÖLÇEMEDİM (çağrı attı) — "false" ile karıştırılmamalı.
 */
function describeSecretBackend({ safeStorage, platform = process.platform } = {}) {
  let available = null;
  try {
    if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'function') {
      available = safeStorage.isEncryptionAvailable() === true;
    }
  } catch { available = null; }
  let backend = null;
  if (platform === 'linux' && safeStorage
    && typeof safeStorage.getSelectedStorageBackend === 'function') {
    try {
      const raw = safeStorage.getSelectedStorageBackend();
      backend = raw ? String(raw) : null;
    } catch { backend = null; }
  }
  return { available, backend, plaintext: backend === 'basic_text' };
}

/**
 * `describeSecretBackend` hükmünü TEK LOG SATIRINA çevir. SIR İÇERMEZ.
 * "ölçemedim" ile "kapalı" ayrı kelimelerle yazılır (ADP-721 dürüstlük kuralı).
 */
function secretBackendLogLine(report = {}) {
  const avail = report.available === null || report.available === undefined
    ? 'ölçülemedi' : String(report.available);
  const parts = [`kullanılabilir=${avail}`];
  if (report.backend) parts.push(`arka uç=${report.backend}`);
  if (report.plaintext) {
    parts.push('🔴 KORUMASIZ (basic_text: anahtar zinciri bulunamadı — oturum bu '
      + 'makinede saklanamaz, her açılışta giriş istenir)');
  }
  return `safeStorage: ${parts.join(' ')}`;
}

module.exports = {
  safeStorageAppName,
  describeSecretBackend,
  secretBackendLogLine,
  keychainServiceName,
  persistScopeMarker,
  migrateAuthBlobs,
  SCOPE_MARKER,
};
