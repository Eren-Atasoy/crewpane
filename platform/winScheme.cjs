'use strict';
/**
 * ADP-954 — WINDOWS URL-ŞEMASI: ÖLÇ, TEŞHİS ET, ONAR.
 *
 * ## Neden bu modül var (ÖLÇÜLDÜ, kaynak: sevk edilen paket)
 *
 * macOS'ta `crewpane://` şeması pakete BUILD ANINDA yazılır (Info.plist
 * CFBundleURLTypes) ve `lsregister` sahipliği sorgulanabilir. Windows'ta
 * **ÖYLE BİR ŞEY YOK** ve kurulum da yazmıyor:
 *
 *   1. `electron/package.json build.protocols` electron-builder'da **yalnız
 *      macOS**tur. Ölçüm (app-builder-lib 26.15.3):
 *        • `out/options/PlatformSpecificBuildOptions.d.ts:220`
 *          → "URL Protocol Schemes. Protocols to associate the app with. **macOS only.**"
 *        • `protocols` alanını okuyan ÜÇ üretici var — `electron/electronMac.js`
 *          (Info.plist), `targets/LinuxTargetHelper.js` (.desktop),
 *          `targets/AppxTarget.js` (AppX). `out/targets/nsis/**` içinde
 *          "protocol" kelimesi **SIFIR** kez geçiyor.
 *      ⇒ NSIS kurulumu `HKCU\Software\Classes\<şema>` anahtarını **HİÇ YAZMAZ**.
 *
 *   2. Geriye tek yazıcı olarak çalışma anındaki
 *      `app.setAsDefaultProtocolClient()` kalıyor. O çağrı HKCU'ya yazar, ama
 *      `app.isDefaultProtocolClient()` de AYNI anahtarı okur: yani ölçüm
 *      "tarayıcı bu app'i açabilir mi" sorusunu CEVAPLAMIYOR. Windows'ta
 *      kaydı ETKİSİZ bırakan üç durum var ve üçü de Electron'un iki
 *      fonksiyonuna GÖRÜNMEZ:
 *        • **UserChoice** — `…\Explorer\UrlAssociations\<şema>\UserChoice`
 *          varsa Windows `Software\Classes`i YOKSAYAR ve ProgId'nin işaret
 *          ettiği uygulamayı açar (şemayı başka bir kurulum kapmışsa buradadır).
 *        • **bayat komut** — eski/taşınmış kurulumdan kalan `…\command` artık
 *          var olmayan bir .exe'yi gösterir → tarayıcı hiçbir şey açmaz.
 *        • **gölgeleme** — HKCR birleşik görünümü HKCU'dakinden FARKLI bir
 *          komut veriyorsa efektif sahip biz değiliz.
 *
 * ⇒ Kullanıcının gördüğü: "maile gelen giriş linki uygulamayla eşleşmiyor".
 *   Uygulamanın gördüğü: hiçbir şey — ne log, ne teşhis, ne onarım yolu.
 *
 * ## Tasarım
 *
 *   * **win32 dışında HİÇBİR ŞEY yapmaz** — `probe()` ilk satırda
 *     `{state:'not-win32'}` döner: ne `reg.exe`, ne fs, ne child_process
 *     (ADR-W5'in "platform dalı macOS'ta İLK SATIRDA döner" disiplini).
 *   * Ayrıştırma/sınıflandırma SAF ve DIŞARI AÇIK (`parseRegValue`,
 *     `commandExe`, `samePath`, `classify`) → `node --test` ile macOS'ta koşar,
 *     hiçbir sistem durumu değiştirmeden.
 *   * Değer adı LOCALE'e bağlı DEĞİL: `reg query /ve` çıktısında Türkçe
 *     Windows `(Varsayılan)` yazar. Ayrıştırıcı `(Default)` ARAMAZ, `REG_SZ`
 *     ayracından sonrasını alır.
 *   * Davranış İSİMDEN değil DURUMDAN türer: modülde hiçbir ürün adı/şema
 *     sabiti yoktur; şema ve exe yolu ÇAĞIRANDAN gelir.
 *   * UserChoice **onarılmaz** ve onarılmış gibi de yapılmaz: Windows o kaydı
 *     kullanıcı-hash'i ile korur, program yazamaz. Doğru davranış onu ÖLÇÜP
 *     kullanıcıya söylemektir (sessiz başarısızlık yerine anlaşılır sebep).
 */

const { execFile } = require('node:child_process');
const nodeFs = require('node:fs');

/** `reg query` çağrılarının üst sınırı — asılı bir reg.exe açılışı kilitlemesin. */
const REG_TIMEOUT_MS = 5000;

/** Şemanın komut anahtarı (HKCU tarafı — yazılabilir olan hive budur). */
function classesCommandKey(scheme, hive = 'HKCU') {
  return hive === 'HKCR'
    ? `HKCR\\${scheme}\\shell\\open\\command`
    : `HKCU\\Software\\Classes\\${scheme}\\shell\\open\\command`;
}

/** Şemanın kök anahtarı (`URL Protocol` işaretçisi burada yaşar). */
function classesRootKey(scheme, hive = 'HKCU') {
  return hive === 'HKCR' ? `HKCR\\${scheme}` : `HKCU\\Software\\Classes\\${scheme}`;
}

/** Windows'un "kullanıcı bu şema için şunu seçti" kaydı — Classes'i EZER. */
function userChoiceKey(scheme) {
  return `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\`
    + `UrlAssociations\\${scheme}\\UserChoice`;
}

/**
 * `reg query` çıktısından bir değeri çıkar.
 *
 * Gerçek biçim (satır başı boşluklu, alanlar 4+ boşlukla ayrılmış):
 *
 *     HKEY_CURRENT_USER\Software\Classes\crewpane\shell\open\command
 *         (Default)    REG_SZ    "C:\…\CrewPane.exe" "%1"
 *
 * 🔑 `(Default)` ARANMAZ: Türkçe Windows'ta `(Varsayılan)` yazar ve bu modül
 * TR makinelerde ölçüm yapamaz hâle gelirdi. Ayraç TİP adıdır (REG_SZ /
 * REG_EXPAND_SZ) — o locale'den bağımsızdır.
 *
 * @param {string} stdout
 * @param {string} [name] belirli bir değer adı aranıyorsa (ör. 'ProgId')
 * @returns {string|null}
 */
function parseRegValue(stdout, name) {
  const lines = String(stdout || '').split(/\r?\n/);
  for (const line of lines) {
    const m = /\s(REG_SZ|REG_EXPAND_SZ|REG_MULTI_SZ)\s+(.*)$/.exec(line);
    if (!m) continue;
    if (name) {
      // Değer adı tip adından ÖNCE gelir; adı verildiyse o satır olmalı.
      const before = line.slice(0, m.index).trim();
      if (before.toLowerCase() !== String(name).toLowerCase()) continue;
    }
    const value = m[2].trim();
    return value.length ? value : null;
  }
  return null;
}

/**
 * `"C:\…\CrewPane.exe" "%1"` → `C:\…\CrewPane.exe`
 * Tırnaksız biçim (`C:\…\App.exe %1`) de desteklenir: ilk `.exe`ye kadar.
 * @param {string} command
 * @returns {string|null}
 */
function commandExe(command) {
  const raw = String(command || '').trim();
  if (!raw) return null;
  if (raw.startsWith('"')) {
    const end = raw.indexOf('"', 1);
    return end > 1 ? raw.slice(1, end) : null;
  }
  const m = /^(.*?\.exe)(\s|$)/i.exec(raw);
  return m ? m[1] : null;
}

/** Windows yol karşılaştırması: ayraç ve harf-durumu FARKI anlamsızdır. */
function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => String(p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Ham ölçümden HÜKÜM. Saf fonksiyon — testler gerçek `reg query` biçimini besler.
 *
 * @param {object} raw
 * @param {string} raw.scheme
 * @param {string} raw.ourExe            bu sürecin .exe yolu (app.getPath('exe'))
 * @param {string|null} raw.hkcuCommand  HKCU\Software\Classes\…\command
 * @param {string|null} raw.hkcrCommand  HKCR\…\command (efektif birleşik görünüm)
 * @param {string|null} raw.userChoice   UserChoice ProgId (varsa Classes'i EZER)
 * @param {Function} [raw.exists]        (path)=>boolean — bayat komut tespiti
 * @returns {{state:'ok'|'missing'|'stale'|'foreign'|'hijacked'|'shadowed',
 *            effectiveExe:string|null, detail:string, repairable:boolean}}
 */
function classify(raw = {}) {
  const exists = typeof raw.exists === 'function' ? raw.exists : (p) => {
    try { return nodeFs.existsSync(p); } catch { return false; }
  };
  const scheme = raw.scheme || '?';
  const hkcuExe = commandExe(raw.hkcuCommand);
  const hkcrExe = commandExe(raw.hkcrCommand);
  const effectiveExe = hkcrExe || hkcuExe;

  // 1) UserChoice VARSA Windows Classes'e hiç bakmaz. Bizim ProgId'miz şema
  //    anahtarının kendisidir (Electron o adla yazar); başka bir ProgId =
  //    şemayı başka bir kurulum kapmış demektir ve BİZ DÜZELTEMEYİZ.
  if (raw.userChoice && String(raw.userChoice).toLowerCase() !== String(scheme).toLowerCase()) {
    return {
      state: 'hijacked',
      effectiveExe,
      repairable: false,
      detail: `Windows bu şema için başka bir uygulamayı seçmiş `
        + `(UserChoice ProgId="${raw.userChoice}"). Ayarlar → Uygulamalar → `
        + `"Varsayılan uygulamalar" üzerinden değiştirilmeli; kayıt program `
        + 'tarafından değiştirilemez.',
    };
  }

  // 2) Hiç kayıt yok → tarayıcı bağlantıyı hiçbir yere teslim edemez.
  if (!hkcuExe && !hkcrExe) {
    return {
      state: 'missing',
      effectiveExe: null,
      repairable: true,
      detail: `${scheme}:// için Windows kaydı YOK — tarayıcı giriş bağlantısını `
        + 'hiçbir uygulamaya teslim edemez.',
    };
  }

  // 3) Kayıt var ama gösterdiği .exe diskte yok (eski/taşınmış kurulum artığı).
  if (effectiveExe && !exists(effectiveExe)) {
    return {
      state: 'stale',
      effectiveExe,
      repairable: true,
      detail: `${scheme}:// kaydı artık var olmayan bir dosyayı gösteriyor `
        + `(${effectiveExe}) — tıklanan bağlantı hiçbir şey açmaz.`,
    };
  }

  // 4) HKCU BİZİZ ama birleşik görünüm (HKCR) başkasını veriyor → gölgeleme.
  //    ⚠️ SIRA ÖNEMLİ: bu kontrol "yabancı"dan ÖNCE gelmeli. `effectiveExe`
  //    HKCR'yi tercih ettiği için, aksi hâlde kendi kaydımız dururken durum
  //    `foreign` diye raporlanır ve ONARILABİLİR sanılıp aynı kayıt boşuna
  //    tekrar yazılırdı (HKCU zaten doğruydu — sorun HKLM tarafında).
  if (hkcuExe && hkcrExe && !samePath(hkcuExe, hkcrExe) && samePath(hkcuExe, raw.ourExe)) {
    return {
      state: 'shadowed',
      effectiveExe: hkcrExe,
      repairable: false,
      detail: `${scheme}:// kaydımız var ama sistem genelindeki kayıt onu `
        + `gölgeliyor (${hkcrExe}).`,
    };
  }

  // 5) Efektif komut BİZ DEĞİLİZ → dönüş başka bir uygulamaya gidiyor.
  if (effectiveExe && !samePath(effectiveExe, raw.ourExe)) {
    return {
      state: 'foreign',
      effectiveExe,
      repairable: true,
      detail: `${scheme}:// başka bir uygulamaya kayıtlı (${effectiveExe}) — `
        + 'giriş dönüşü bu pencereye ulaşmaz.',
    };
  }

  return {
    state: 'ok',
    effectiveExe,
    repairable: false,
    detail: `${scheme}:// bu uygulamaya kayıtlı.`,
  };
}

/**
 * Tek bir `reg query` — hata (anahtar yok) `null` demektir, ATMAZ.
 * @returns {Promise<string|null>}
 */
function regQuery({ key, valueName, exec = execFile } = {}) {
  const args = ['query', key];
  if (valueName) args.push('/v', valueName);
  else args.push('/ve');
  return new Promise((resolve) => {
    try {
      exec('reg.exe', args, { timeout: REG_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => resolve(err ? null : parseRegValue(String(stdout || ''), valueName)));
    } catch {
      resolve(null); // reg.exe yok/çalıştırılamıyor → "ölçemedim" = null
    }
  });
}

/**
 * Windows'ta şemanın GERÇEK durumu.
 *
 * win32 DIŞINDA hiçbir şey çalıştırmaz.
 *
 * @param {object} opts
 * @param {string} opts.scheme
 * @param {string} opts.execPath  bu sürecin .exe yolu
 * @param {string} [opts.platform]
 * @param {Function} [opts.exec]  execFile dikişi (test)
 * @param {Function} [opts.exists]
 * @returns {Promise<object>} classify() hükmü + ham ölçümler
 */
async function probe(opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform !== 'win32') {
    return { state: 'not-win32', effectiveExe: null, repairable: false, detail: '' };
  }
  const { scheme } = opts;
  const exec = opts.exec || execFile;
  const [hkcuCommand, hkcrCommand, userChoice] = await Promise.all([
    regQuery({ key: classesCommandKey(scheme, 'HKCU'), exec }),
    regQuery({ key: classesCommandKey(scheme, 'HKCR'), exec }),
    regQuery({ key: userChoiceKey(scheme), valueName: 'ProgId', exec }),
  ]);
  const verdict = classify({
    scheme, ourExe: opts.execPath, hkcuCommand, hkcrCommand, userChoice, exists: opts.exists,
  });
  return { ...verdict, hkcuCommand, hkcrCommand, userChoice };
}

/** `reg add` — tek yazım; hata çıkış kodu `false` döner (ATMAZ). */
function regAdd({ key, valueName, type = 'REG_SZ', data = '', exec = execFile } = {}) {
  const args = ['add', key, valueName ? '/v' : '/ve'];
  if (valueName) args.push(valueName);
  args.push('/t', type, '/d', data, '/f');
  return new Promise((resolve) => {
    try {
      exec('reg.exe', args, { timeout: REG_TIMEOUT_MS, windowsHide: true },
        (err) => resolve(!err));
    } catch {
      resolve(false);
    }
  });
}

/**
 * HKCU kaydını yaz/onar — `app.setAsDefaultProtocolClient()` tutmadığında.
 *
 * Yalnız HKCU'ya yazar (yönetici hakkı istemez, kullanıcı-başına kurulumla
 * aynı kapsam). UserChoice hijack'ini ÇÖZMEZ ve çözdüğünü de iddia etmez —
 * `classify()` o durumu `repairable:false` işaretler ve çağıran yazmayı hiç
 * denemez.
 *
 * @returns {Promise<{ok:boolean, wrote:string[], reason?:string}>}
 */
async function repair(opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform !== 'win32') return { ok: false, wrote: [], reason: 'not-win32' };
  const { scheme, execPath } = opts;
  if (!scheme || !execPath) return { ok: false, wrote: [], reason: 'bad-args' };
  const exec = opts.exec || execFile;
  const label = opts.label || scheme;
  const root = classesRootKey(scheme, 'HKCU');
  const wrote = [];
  const steps = [
    { key: root, valueName: null, data: `URL:${label}` },
    { key: root, valueName: 'URL Protocol', data: '' },
    { key: `${root}\\shell\\open\\command`, valueName: null, data: `"${execPath}" "%1"` },
  ];
  for (const step of steps) {
    // eslint-disable-next-line no-await-in-loop -- sıra ÖNEMLİ: kök anahtar önce.
    const ok = await regAdd({ ...step, exec });
    if (!ok) return { ok: false, wrote, reason: `write-failed: ${step.key}` };
    wrote.push(step.valueName ? `${step.key}\\${step.valueName}` : step.key);
  }
  return { ok: true, wrote };
}

module.exports = {
  REG_TIMEOUT_MS,
  classesCommandKey,
  classesRootKey,
  userChoiceKey,
  parseRegValue,
  commandExe,
  samePath,
  classify,
  probe,
  repair,
};
