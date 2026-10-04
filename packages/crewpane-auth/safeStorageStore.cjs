// ADP-382 (wheeljack) — Electron safeStorage destekli token deposu (ADR-027 §3 / G2)
//
// KURAL: token DÜZ DOSYAYA ASLA yazılmaz. Bu depo Electron safeStorage ile
// şifreler (macOS'ta anahtar Keychain'de: "Electron Safe Storage" girdisi);
// diskteki dosya yalnız şifreli blob'dur. safeStorage kullanılamıyorsa
// (isEncryptionAvailable() === false) save THROW eder — düz metin fallback YOK.
//
// Electron'a require-bağımlılığı YOKTUR: safeStorage enjekte edilir
// (main process'te: const { safeStorage } = require('electron')).

'use strict';

const fs = require('node:fs');
// ADP-835 (790 K1) — atomik yazımın rename adımı platform boğazından geçer:
// Windows'ta Defender/Search hedefi açık tutunca EPERM/EBUSY gelir ve bu çağrıların
// çoğu best-effort catch içinde OLDUĞU İÇİN kayıt SESSİZCE kaybolurdu.
// 🪤 İKİ DİZİLİM: kaynakta bu dosya `packages/crewpane-auth/` altında yaşar ve
// electron kodu `../../electron/` komşusudur; PAKETTE ise asar kökü electron'un
// kendisidir ve bu paket `/packages/crewpane-auth/` altına kopyalanır — yani doğru
// yol `../../platform/` olur. Tek sabit yol ikisinden birinde ÇÖKER (0.2.26 dev
// paketi açılışta böyle öldü). İkisini de dene; ikisi de yoksa gerçek hata yüzeye çıksın.
function requirePlatform(name) {
  try { return require('../../electron/platform/' + name); }  // kaynak dizilimi
  catch { return require('../../platform/' + name); }          // paket (asar) dizilimi
}
// ADP-943 (tur 2) — `atomicWriteFileSync` de aynı boğazdan: `save()` elle yazılmış
// bir tmp+rename kullanıyordu ve bu yazımın kendisi Windows'ta korumasızdı (§save).
const { atomicWriteFileSync } = requirePlatform('atomicWrite.cjs');
// ADP-835 (790 I2) — `{mode:0o600}` Windows'ta SESSİZCE etkisiz; boğaz ne
// yaptığını (chmod / miras-ACL / icacls) söyler.
const { restrictFile } = requirePlatform('restrictPath.cjs');
const path = require('node:path');

/** Kısıtlama sonucu yalnız BEKLENMEDİK durumlarda log'a düşer (gürültü yapma). */
function restrictLog(r) {
  if (r && (r.state === 'failed' || r.state === 'unknown')) {
    try { console.warn(`[restrictPath] ${r.state} ${r.target} (${r.mechanism})`); } catch { /* yut */ }
  }
}

/**
 * @param {object} opts
 * @param {{isEncryptionAvailable:()=>boolean, encryptString:(s:string)=>Buffer,
 *          decryptString:(b:Buffer)=>string}} opts.safeStorage - Electron safeStorage
 * @param {string} opts.filePath - şifreli blob'un yolu
 *   (öneri: path.join(app.getPath('userData'), 'crewpane-auth.bin'))
 * @param {(line:string)=>void} [opts.log] - ADP-943: `load()` SEBEBİNİ buraya yazar.
 * @param {string} [opts.label] - log'da hangi blob olduğunu söyler ('session'/'license').
 */
function createSafeStorageTokenStore(opts) {
  const { safeStorage, filePath } = opts || {};
  // ADP-943 — SESSİZ FAIL-CLOSED'IN SONU. Ölçüldü (scratchpad/proof-silent-load.cjs):
  // "blob YOK" ile "blob VAR ama ÇÖZÜLEMİYOR" ikisi de `null` dönüyordu ve HİÇBİR
  // satır loglanmıyordu. Windows'ta ikincisi gerçek ve sık bir olay (Chromium
  // OSCrypt master anahtarı `<userData>\Local State` içinde DPAPI ile korunur;
  // roaming profil / profil sıfırlama o anahtarı değiştirir) → kullanıcı her
  // açılışta giriş ekranına düşer ve NEDENİNİ göremez. Artık sebep loglanır ve
  // son sonuç `lastLoadOutcome()` ile SORULABİLİR (seatGate kullanıcıya söyler).
  const log = typeof (opts || {}).log === 'function' ? opts.log : () => {};
  const label = (opts || {}).label || path.basename(String(filePath || ''));
  // ADP-943 (tur 2) — test dikişleri: `migrateAuthBlobs`/`atomicWrite`/`restrictPath`in
  // ZATEN kabul ettiği `fs`/`platform` sözleşmesinin aynısı. Windows'a özgü yazım
  // yolu (kilit + yeniden deneme) macOS'ta böyle ÖLÇÜLÜR; üretimde varsayılanlar.
  const fsMod = (opts || {}).fs || fs;
  const platform = (opts || {}).platform || process.platform;
  let lastOutcome = { state: 'never_read' };
  if (!safeStorage || typeof safeStorage.encryptString !== 'function'
    || typeof safeStorage.decryptString !== 'function'
    || typeof safeStorage.isEncryptionAvailable !== 'function') {
    throw new Error('createSafeStorageTokenStore: safeStorage (Electron) zorunlu');
  }
  if (typeof filePath !== 'string' || !filePath) {
    throw new Error('createSafeStorageTokenStore: filePath zorunlu');
  }

  return {
    /**
     * ADP-943 — son `load()` çağrısının SEBEBİ. Davranış (fail-closed) değişmedi;
     * değişen tek şey, sebebin artık SORULABİLİR olması.
     *   absent      → dosya hiç yok (temiz kurulum / çıkış yapılmış) — NORMAL
     *   ok          → okundu ve çözüldü
     *   undecryptable → dosya VAR ama safeStorage çözemedi (anahtar değişmiş)
     *   corrupt     → çözüldü ama JSON değil
     *   unreadable  → okuma hatası (izin/kilit)
     */
    lastLoadOutcome() { return lastOutcome; },

    async load() {
      let raw;
      try {
        raw = fsMod.readFileSync(filePath);
      } catch (e) {
        if (e && e.code === 'ENOENT') {
          lastOutcome = { state: 'absent', file: filePath };
          return null; // dosya yok = oturum yok (beklenen hâl, log'a gürültü yapma)
        }
        lastOutcome = { state: 'unreadable', file: filePath, code: e && e.code };
        log(`[auth] ${label}: okunamadı (${(e && e.code) || 'ERR'}) — oturum yokmuş gibi davranılıyor`);
        return null;
      }
      let plain;
      try {
        plain = safeStorage.decryptString(raw);
      } catch (e) {
        lastOutcome = { state: 'undecryptable', file: filePath, bytes: raw.length };
        // ⚠️ SIR SIZDIRMA YOK: yalnız boyut + sebep. Blob/anahtar/jeton ASLA loglanmaz.
        log(`[auth] ${label}: blob DİSKTE VAR (${raw.length} bayt) ama safeStorage ÇÖZEMEDİ `
          + `(${(e && e.message) || 'decrypt error'}). Bu "çıkış yapılmış" DEĞİL, `
          + 'işletim sisteminin şifreleme anahtarı değişmiş demektir '
          + '(Windows: <userData>\\Local State / DPAPI · macOS: login keychain). '
          + 'Bir kez yeniden giriş yapmak gerekir.');
        return null; // fail-closed (davranış AYNI)
      }
      try {
        const doc = JSON.parse(plain);
        lastOutcome = { state: 'ok', file: filePath };
        return doc;
      } catch {
        lastOutcome = { state: 'corrupt', file: filePath };
        log(`[auth] ${label}: çözüldü ama içerik bozuk (JSON değil) — oturum yok sayılıyor`);
        return null;
      }
    },

    async save(doc) {
      if (!safeStorage.isEncryptionAvailable()) {
        // ADP-943 — DÜZ METİN FALLBACK YOK (ADR-027/G2) ama SESSİZLİK de yok:
        // bu hâlde oturum HİÇ kalıcı olmaz (her açılış giriş ekranı) ve eski kod
        // sebebi yalnız `throw`a gömüyordu. Windows'ta `isEncryptionAvailable()`
        // ready'den ÖNCE false döner; macOS'ta keychain kilitliyse.
        log(`[auth] ${label}: safeStorage şifrelemesi KULLANILAMIYOR — oturum diske `
          + 'YAZILAMADI (düz metin fallback YASAK). Oturum bu açılışla sınırlı kalır.');
        throw new Error(
          'safeStorage şifrelemesi kullanılamıyor — token düz dosyaya YAZILMAZ (ADR-027/G2)');
      }
      const blob = safeStorage.encryptString(JSON.stringify(doc));
      const dir = path.dirname(filePath);
      fsMod.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // ⛔ ADP-943 (tur 2) — YAZIMIN KENDİSİ DE BOĞAZDAN GEÇER.
      //
      // Eskiden burada elle yazılmış bir tmp+rename vardı:
      //     const tmp = filePath + '.tmp';          // SABİT isim
      //     fs.writeFileSync(tmp, blob, ...);       // yeniden deneme YOK
      //     renameWithRetrySync(tmp, filePath);
      //
      // Rename korunuyordu ama TMP YAZIMI korunmuyordu ve tmp adı SABİTTİ. Windows'ta
      // bu ikisi birleşince oturum HİÇ kalıcı olamıyordu: bir önceki yazım rename'de
      // kalıcı düştüyse (ya da süreç öldüyse) geride `session.bin.tmp` kalır; Defender/
      // Search onu açık tutarsa sabit isim yüzünden BİR SONRAKİ save de aynı dosyaya
      // yazmak zorundadır → EPERM → save throw → `seatGate.handleUrl` throw →
      // `main.js` `.catch(logLine)` → kullanıcı giriş ekranında kalır, HER SEFERİNDE.
      // Ölçüldü (scratchpad/proof-save-tmp-lock.cjs): 3/3 girişte oturum yazılmadı ve
      // save yolu TEK SATIR log üretmedi; üstelik `lastLoadOutcome()` bu hâli `absent`
      // (= "çıkış yapılmış, normal") diye YANLIŞ raporluyordu.
      //
      // `atomicWriteFileSync` üçünü birden getirir: HER YAZIMDA BENZERSİZ tmp adı
      // (`.<pid>.<rand>.tmp` → bayat/kilitli artık bir daha ASLA yolu tıkayamaz),
      // win32 rename yeniden-denemesi ve kalıcı düşüşte tmp temizliği.
      try {
        atomicWriteFileSync(filePath, blob, {
          fs: fsMod, platform, mode: 0o600, mkdir: false,
        });
      } catch (e) {
        // ⚠️ SIR SIZDIRMA YOK: yalnız sebep + boyut. Blob/jeton ASLA loglanmaz.
        // DÜZ METİN FALLBACK YOK (ADR-027/G2) — throw korunur, sessizlik kalkar.
        // `lastOutcome`a DOKUNMUYORUZ: o bir OKUMA göstergesi ve bir sonraki `load()`
        // zaten üzerine yazardı — yazım arızasını oraya sıkıştırmak yanıltıcı olurdu.
        // Görünürlüğü sağlayan şey aşağıdaki satır (ve throw'un kendisi).
        log(`[auth] ${label}: oturum diske YAZILAMADI (${(e && e.code) || 'ERR'}) — `
          + 'şifreleme çalışıyor, ARIZA DOSYA YAZIMINDA (Windows: Defender/Search '
          + 'kilidi ya da bayat .tmp artığı). Bu "çıkış yapılmış" DEĞİL: giriş '
          + 'başarılı olsa bile kalıcı olmaz ve her açılış giriş ekranı gelir '
          + '(ADP-943 sonsuz giriş döngüsü).');
        throw e;
      }
      // ADP-835 (790 I2) — POSIX izin bitleri Windows'ta ETKİSİZ. Boğaz darwin'de
      // bugünkü chmod'u yapar, win32'de "koruma miras ACL'den geliyor" der ve
      // BUNU SÖYLER (opt-in `CREWPANE_WIN_ACL=1` ile icacls yolu var). İçerik
      // koruması her hâlükârda safeStorage/DPAPI'de — kaybolan şey derinlemesine
      // savunma katmanı, birincil kontrol değil.
      //
      // ⚠️ YALNIZ DOSYA. `dir` burada çoğu zaman Electron `userData` KÖKÜDÜR;
      // onu 0700'e çekmek bugünkü `mkdirSync(...,{mode})`in HİÇ yapmadığı bir şey
      // olurdu (recursive mkdir VAR OLAN dizinin modunu değiştirmez) ve kapsamı
      // sessizce genişletirdi. Kapsam bilerek `{mode:0o600}`un hedefiyle aynı.
      restrictFile(filePath, { log: restrictLog });
    },

    async clear() {
      try { fsMod.unlinkSync(filePath); } catch { /* yoksa sorun değil */ }
    },
  };
}

module.exports = { createSafeStorageTokenStore };
