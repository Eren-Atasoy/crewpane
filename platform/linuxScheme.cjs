'use strict';
/**
 * LX-SCHEME-01 — LINUX URL-ŞEMASI: KAYDI KUR, ÖLÇ, ONAR.
 *
 * ## Neden bu modül var (ÖLÇÜLDÜ — sevk edilen 0.2.42 AppImage, iki tezgâh)
 *
 * Ödeme yapmış bir Ubuntu müşterisi giriş yapamadı. Kök neden HATA-11 §3 /
 * LX-LOGIN-01 §2.4'te kontrol koluyla ölçüldü:
 *
 *   1. AppImage kendini masaüstüne ENTEGRE ETMEZ (AppImageLauncher/appimaged
 *      yoksa). Yani `~/.local/share/applications/` dizini bakir kullanıcıda
 *      HİÇ YOKTUR ve paketin İÇİNDEKİ `.desktop` (`MimeType=x-scheme-handler/…`
 *      satırı ZATEN doğru) sisteme hiç kurulmaz.
 *        $ xdg-mime query default x-scheme-handler/crewpane   → ''  (boş)
 *        $ ls ~/.local/share/applications                       → dizin yok
 *   2. Kayıt olmadığı için `xdg-settings set default-url-scheme-handler` de
 *      DÜŞER (elle koşuldu: çıkış 2) ⇒ Electron'un
 *      `app.setAsDefaultProtocolClient()` çağrısı `false` döner.
 *   3. Tarayıcının yaptığı şey:
 *        $ xdg-open 'crewpane://auth/callback?code=…'
 *          → xdg-open: no method available for opening …   (çıkış 3)
 *      ⇒ PKCE dönüşü uygulamaya HİÇ ULAŞMAZ, giriş tamamlanamaz.
 *   4. KONTROL KOLU: aynı `.desktop` `~/.local/share/applications/` altına
 *      kurulup `update-desktop-database` koşulunca dönüş ULAŞTI
 *      (`deep-link (cold-start-argv): …` satırı, 2 kez). Yani eksik olan şey
 *      `MimeType` satırı DEĞİL, dosyanın SİSTEME KURULMASIDIR.
 *
 * ⇒ Bu modül o kurulumu ÜRÜNÜN KENDİSİNE yaptırır: her açılışta idempotent
 *   olarak `.desktop`ı yazar, veritabanını tazeler, varsayılan şema
 *   işleyicisini ayarlar ve sonucu SİSTEMDEN geri okuyarak ölçer.
 *
 * ## Tasarım (winScheme.cjs deseninin ikizi — icat değil, tekrar kullanım)
 *
 *   * **linux dışında HİÇBİR ŞEY yapmaz** — `probe()`/`ensureRegistered()` ilk
 *     satırda `{state:'not-linux'}` döner: ne `xdg-*`, ne fs, ne child_process.
 *   * Ayrıştırma/üretme/sınıflandırma SAF ve DIŞARI AÇIK (`desktopEntry`,
 *     `parseDesktopExec`, `parseMimeappsDefault`, `upsertMimeappsDefault`,
 *     `launcherPath`, `classify`) → `node --test` ile macOS'ta koşar, hiçbir
 *     sistem durumu değiştirmeden.
 *   * `platform` PARAMETRE olarak geçer; `process.platform` yalnız SON çare
 *     varsayılandır (ölçülmüş ders: PIPE-03 — fallback'e güvenen kod yanlış
 *     platformda sessizce koşar).
 *   * Davranış İSİMDEN değil DURUMDAN türer: modülde hiçbir ürün adı, şema ya
 *     da yol sabiti YOKTUR — şema, ad, ikon ve çalıştırıcı ÇAĞIRANDAN gelir.
 *   * `AppRun`ın kum-havuzu kurtarması KORUNUR: Exec satırı `--no-sandbox`
 *     YAZMAZ (ADR-CREWPANE-LINUX §8.4 bunu açıkça reddetti) ve mümkün olan
 *     her yerde AppImage/`AppRun` çalıştırıcısını gösterir — çıplak `crewpane`
 *     ikilisi S20 duvarına çarpıp ölür (HATA-11 §2).
 *   * `XDG_*` dizinleri ENJEKTE EDİLEBİLİR (`env`) → test gerçek `$HOME`a
 *     dokunmaz (no-real-home-writes kapısı).
 */

const { execFile } = require('node:child_process');
const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const path = require('node:path');

/** `xdg-*` çağrılarının üst sınırı — asılı bir yardımcı açılışı kilitlemesin. */
const XDG_TIMEOUT_MS = 5000;

/**
 * Bizim yazdığımız kaydı, dağıtım paketinin (deb/pacman) kurduğu kayıttan
 * ayıran işaret. Ürün adı İÇERMEZ — anahtar jeneriktir, değer sabittir.
 */
const MANAGED_KEY = 'X-URL-Scheme-Managed';

/** Şemanın MIME tipi — xdg dünyasında şema işleyicisi bir mimetype'tır. */
function schemeMimeType(scheme) {
  return `x-scheme-handler/${scheme}`;
}

/**
 * Ev dizini — ENJEKTE EDİLEBİLİR, ama BOŞ BIRAKILAMAZ.
 *
 * 🔴 Yakalanan hata (bu modülün ilk hâli): `homeDir` verilmezse `dataHome`
 * `path.join('', '.local', 'share')` → **`.local/share`** üretiyordu; yani
 * `.desktop` dosyası kullanıcının evine değil SÜRECİN ÇALIŞMA DİZİNİNE
 * yazılırdı — kayıt hiç oluşmaz, kimse de fark etmezdi (yazım "başarılı" döner).
 * Varsayılan artık gerçek ev dizinidir; test kendi geçici dizinini AÇIKÇA geçer
 * (ve geçmezse `no-real-home-writes` kapısı yakalar).
 */
function resolveHome(homeDir) {
  const h = String(homeDir || '').trim();
  if (h) return h;
  try { return nodeOs.homedir(); } catch { return ''; }
}

/** XDG veri kökü (uygulama girdileri burada yaşar). */
function dataHome(env = {}, homeDir = '') {
  const explicit = env.XDG_DATA_HOME;
  if (explicit && path.isAbsolute(explicit)) return explicit;
  return path.join(resolveHome(homeDir), '.local', 'share');
}

/** XDG yapılandırma kökü (`mimeapps.list` burada yaşar). */
function configHome(env = {}, homeDir = '') {
  const explicit = env.XDG_CONFIG_HOME;
  if (explicit && path.isAbsolute(explicit)) return explicit;
  return path.join(resolveHome(homeDir), '.config');
}

function applicationsDir(env = {}, homeDir = '') {
  return path.join(dataHome(env, homeDir), 'applications');
}

function mimeappsListPath(env = {}, homeDir = '') {
  return path.join(configHome(env, homeDir), 'mimeapps.list');
}

/**
 * Bu kopyanın `.desktop` DOSYA ADI.
 *
 * 🔑 Ad ÇALIŞTIRILABİLİR ADINDAN türer (`executableName`, ölçüldü: `crewpane`)
 * çünkü Electron/Chromium de Linux'ta varsayılan işleyiciyi AYNI adla arar.
 * `CHROME_DESKTOP` env'i verilmişse O KAZANIR — çağıran bu env'i bizim adımıza
 * ayarlayarak Electron'un kendi `setAsDefaultProtocolClient()` çağrısını da
 * aynı dosyaya bağlar (iki farklı ad = iki farklı gerçek).
 *
 * @param {{execPath?:string, chromeDesktop?:string}} opts
 * @returns {string|null}
 */
function desktopFileName({ execPath, chromeDesktop } = {}) {
  const fromEnv = String(chromeDesktop || '').trim();
  if (fromEnv) return fromEnv.endsWith('.desktop') ? fromEnv : `${fromEnv}.desktop`;
  const base = path.basename(String(execPath || '')).trim();
  if (!base) return null;
  return `${base}.desktop`;
}

/**
 * Kullanıcının GERÇEKTEN çalıştırdığı dosya.
 *
 * Sıra ÖLÇÜLMÜŞ bir karardır:
 *   1. `APPIMAGE` — AppImage çalışma-anı bunu KENDİ yolu ile ayarlar. Kayıt
 *      buna bağlanmalı: kullanıcının sakladığı dosya budur.
 *   2. `<APPDIR>/AppRun` — çıkarılmış (`squashfs-root`) ya da AppImageLauncher
 *      ile kurulmuş koşu.
 *   3. `<execPath'in yanındaki>/AppRun` — 🔴 BU SATIR BİR ÖLÇÜMDEN DOĞDU
 *      (LX-SCHEME-01 K2 koşumu, 03.09): electron-builder'ın `AppRun` betiği
 *      `APPDIR`ı **atar ama EXPORT ETMEZ** (`APPDIR="$path"`, `export` yok) —
 *      yalnız gerçek AppImage'ta değeri çalışma-anı ortamdan verir. Yani
 *      ÇIKARILMIŞ koşuda çocuk süreç `APPDIR` GÖRMEZ ve 2. sıra sessizce
 *      atlanırdı; ölçülen sonuç `exec=/…/squashfs-root/crewpane` idi, yani
 *      kayıt ÇIPLAK İKİLİYİ gösteriyordu.
 *   4. `execPath` — son çare (deb/pacman kurulumu; orada kum-havuzu kurtarması
 *      paketin `after-install` adımındadır, `AppRun` YOKTUR).
 *
 * ⚠️ `AppRun` ATLANAMAZ: `unshare -Ur` yoklayıp gerekiyorsa `--no-sandbox`
 * ekleyen kurtarma betiği ODUR. Çıplak ikili Ubuntu 24.04'te (AppArmor userns
 * kısıtı, S20) `The SUID sandbox helper binary … is not configured correctly`
 * ile ÖLÜR (HATA-11 §2) ⇒ kayıt "var" görünür, tıklanan bağlantı hiçbir şey
 * açmaz. Docker tezgâhında S20 YOK, o yüzden bu hata orada GÖRÜNMEZ.
 *
 * ⚠️ Mount edilmiş AppImage'ın AppDir'i `/tmp/.mount_XXXX`tır ve süreç ölünce
 * KAYBOLUR → bu yüzden 1. sıra hepsinden ÖNCE gelir. `APPIMAGE` yokken bir
 * mount içindeysek her iki aday da geçicidir; o hâlde kayıt bir sonraki
 * açılışta `stale` ölçülür ve KENDİLİĞİNDEN tazelenir (kalıcı arıza değil).
 */
function launcherPath({ appImage, appDir, execPath, exists } = {}) {
  const ex = typeof exists === 'function' ? exists : (p) => {
    try { return nodeFs.existsSync(p); } catch { return false; }
  };
  const img = String(appImage || '').trim();
  if (img && path.isAbsolute(img) && ex(img)) return img;
  const exe = String(execPath || '').trim();
  const candidates = [];
  const dir = String(appDir || '').trim();
  if (dir) candidates.push(path.join(dir, 'AppRun'));
  if (exe) candidates.push(path.join(path.dirname(exe), 'AppRun'));
  for (const c of candidates) if (ex(c)) return c;
  return exe || null;
}

/**
 * `Exec=` alıntılaması (Desktop Entry Spec §Exec variables). Boşluk ya da
 * ayraç taşıyan yol tırnaklanır; tırnak ve ters bölü kaçırılır.
 */
function execQuote(target) {
  const raw = String(target || '');
  if (!raw) return '';
  if (!/[\s"'\\$`]/.test(raw)) return raw;
  return `"${raw.replace(/(["\\$`])/g, '\\$1')}"`;
}

/**
 * `.desktop` gövdesi — SAF. Ürün adı/şema/ikon ÇAĞIRANDAN gelir.
 *
 * `%u` ZORUNLU: onsuz masaüstü ortamı URL'i uygulamaya GEÇİRMEZ (girdi
 * çalıştırılır ama argüman düşer → şema kayıtlı görünür, dönüş yine gelmez).
 */
function desktopEntry({
  launcher, appName, scheme, wmClass = null, icon = null, categories = 'Development',
} = {}) {
  if (!launcher || !appName || !scheme) return null;
  const lines = [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${appName}`,
    `Exec=${execQuote(launcher)} %u`,
    'Terminal=false',
  ];
  // İkon ADI çalıştırıcının DOSYA ADI DEĞİLDİR: AppImage'da o ad
  // `Uygulama-0.2.43-x86_64.AppImage` olurdu ve hiçbir ikon temasında yok.
  // Çağıran gerçek bir ikon (tema adı ya da tam yol) verirse yazılır, yoksa
  // satır HİÇ yazılmaz — geçersiz bir Icon değeri, eksik ikondan kötüdür.
  if (icon) lines.push(`Icon=${icon}`);
  if (wmClass) lines.push(`StartupWMClass=${wmClass}`);
  lines.push(
    `MimeType=${schemeMimeType(scheme)};`,
    `Categories=${categories};`,
    `${MANAGED_KEY}=true`,
    '',
  );
  return lines.join('\n');
}

/** `.desktop` içeriğinden `Exec=` hedefi (argümanlar/`%u` ayıklanır). SAF. */
function parseDesktopExec(text) {
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!/^Exec\s*=/.test(line)) continue;
    let value = line.replace(/^Exec\s*=/, '').trim();
    if (!value) return null;
    if (value.startsWith('"')) {
      const end = value.indexOf('"', 1);
      if (end > 1) return value.slice(1, end).replace(/\\(["\\$`])/g, '$1');
      return null;
    }
    value = value.replace(/\s+%[a-zA-Z].*$/, '').trim();
    const firstArg = value.search(/\s+-/);
    if (firstArg > 0) value = value.slice(0, firstArg).trim();
    return value || null;
  }
  return null;
}

/** `mimeapps.list` içinden bir mimetype'ın varsayılanı. SAF. */
function parseMimeappsDefault(text, mimetype) {
  let inDefaults = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) { inDefaults = line === '[Default Applications]'; continue; }
    if (!inDefaults || !line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    if (line.slice(0, eq).trim() !== mimetype) continue;
    // Spec: birden çok girdi `;` ile ayrılır, İLKİ kazanır.
    const first = line.slice(eq + 1).split(';').map((s) => s.trim()).filter(Boolean)[0];
    return first || null;
  }
  return null;
}

/**
 * `mimeapps.list` içine varsayılanı YAZ — SAF, İDEMPOTENT, KORUYUCU.
 *
 * Kullanıcının dosyasının geri kalanına DOKUNMAZ: yalnız
 * `[Default Applications]` bölümündeki BİZİM mimetype satırımız değişir.
 * Bölüm yoksa dosyanın SONUNA eklenir (başa eklemek mevcut bölümsüz
 * satırları başka bir bölümün içine sürükler).
 */
function upsertMimeappsDefault(text, mimetype, desktopFile) {
  if (!mimetype || !desktopFile) return String(text || '');
  const src = String(text || '');
  const target = `${mimetype}=${desktopFile}`;
  const lines = src.length ? src.split(/\r?\n/) : [];
  let sectionStart = -1;
  let sectionEnd = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith('[')) continue;
    if (sectionStart < 0 && line === '[Default Applications]') { sectionStart = i; continue; }
    if (sectionStart >= 0) { sectionEnd = i; break; }
  }
  if (sectionStart < 0) {
    const out = lines.slice();
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    if (out.length) out.push('');
    out.push('[Default Applications]', target, '');
    return out.join('\n');
  }
  for (let i = sectionStart + 1; i < sectionEnd; i += 1) {
    const line = lines[i];
    const eq = line.indexOf('=');
    if (eq < 0 || line.trim().startsWith('#')) continue;
    if (line.slice(0, eq).trim() !== mimetype) continue;
    if (line === target) return src; // İDEMPOTENT: aynıysa dosya hiç değişmez.
    const next = lines.slice();
    next[i] = target;
    return next.join('\n');
  }
  const next = lines.slice();
  next.splice(sectionEnd, 0, target);
  return next.join('\n');
}

/**
 * Ham ölçümden HÜKÜM. SAF fonksiyon — testler gerçek `xdg-mime` çıktısını besler.
 *
 * `reasonKey` bir SÖZLÜK ANAHTARIdır, cümle DEĞİL: ölçülmüş kusur (HATA-11 D5)
 * uyarı metninin ham VERİ olarak taşınıp İngilizce arayüzde Türkçe görünmesiydi.
 * Metin renderer'da çevrilir; buradan yalnız anahtar + veri (`reasonPath`) geçer.
 *
 * @returns {{state:'ok'|'missing'|'stale'|'foreign', effectiveDesktop:string|null,
 *            reasonKey:string|null, reasonPath:string|null, repairable:boolean}}
 */
function classify(raw = {}) {
  const ourDesktop = raw.ourDesktopFile || null;
  const registered = raw.registeredDesktopFile || null;
  const installedExec = raw.installedExec || null;
  const launcher = raw.launcher || null;

  // 1) Sistemde hiçbir şey kayıtlı değil → tarayıcı dönüşü hiçbir yere teslim
  //    edemez. Müşterinin bugünkü hâli (ölçüldü: `xdg-mime query` boş).
  if (!registered) {
    return {
      state: 'missing',
      effectiveDesktop: null,
      reasonKey: 'login.gate.schemeLinuxMissing',
      reasonPath: null,
      repairable: true,
    };
  }

  // 2) Kayıt BAŞKA bir masaüstü girdisini gösteriyor → dönüş o uygulamaya gider.
  if (!ourDesktop || registered !== ourDesktop) {
    return {
      state: 'foreign',
      effectiveDesktop: registered,
      reasonKey: 'login.gate.schemeLinuxForeign',
      reasonPath: registered,
      repairable: true,
    };
  }

  // 3) Kayıt BİZİM girdimiz ama girdinin `Exec`i artık bu kopyayı göstermiyor
  //    (AppImage taşındı/yeniden adlandırıldı, ya da başka bir kopya yazdı) →
  //    tıklanan bağlantı hiçbir şey açmaz veya YANLIŞ kopyayı açar.
  if (launcher && installedExec !== launcher) {
    return {
      state: 'stale',
      effectiveDesktop: registered,
      reasonKey: 'login.gate.schemeLinuxStale',
      reasonPath: installedExec || registered,
      repairable: true,
    };
  }

  return {
    state: 'ok',
    effectiveDesktop: registered,
    reasonKey: null,
    reasonPath: null,
    repairable: false,
  };
}

/** Tek `xdg-*` çağrısı — hata "ölçemedim" demektir (`null`), ATMAZ. */
function xdgRun({ bin, args, exec = execFile } = {}) {
  return new Promise((resolve) => {
    try {
      exec(bin, args, { timeout: XDG_TIMEOUT_MS }, (err, stdout) => {
        if (err) return resolve({ ok: false, stdout: String(stdout || '') });
        return resolve({ ok: true, stdout: String(stdout || '') });
      });
    } catch {
      resolve({ ok: false, stdout: '' }); // yardımcı yok/çalıştırılamıyor
    }
  });
}

/**
 * Şemanın SİSTEMDEKİ varsayılan işleyicisi.
 *
 * Önce `xdg-mime query` (kanonik çözümleyici); yardımcı yoksa/düşerse
 * `mimeapps.list` ELDEN okunur — "ölçemedim" ile "kayıt yok" birbirine
 * karışmasın diye ikinci kaynak var.
 */
async function queryDefaultHandler({
  scheme, exec = execFile, env = {}, homeDir = '', fs = nodeFs,
} = {}) {
  const mime = schemeMimeType(scheme);
  const res = await xdgRun({ bin: 'xdg-mime', args: ['query', 'default', mime], exec });
  if (res.ok) {
    const first = res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    return { handler: first || null, source: 'xdg-mime' };
  }
  try {
    const text = fs.readFileSync(mimeappsListPath(env, homeDir), 'utf8');
    return { handler: parseMimeappsDefault(text, mime), source: 'mimeapps.list' };
  } catch {
    return { handler: null, source: 'none' };
  }
}

/**
 * `.desktop` girdisini KUR + varsayılanı AYARLA. İDEMPOTENT.
 *
 * İdempotency sözleşmesi (iki kez koşmak güvenlidir):
 *   • Dosya içeriği AYNIYSA yazım YAPILMAZ (`wrote:false`) ve
 *     `update-desktop-database` çağrılmaz — her açılış mtime'ı kirletmez.
 *   • `xdg-settings set` zaten bizi gösteriyorsa yeniden yazmak da zararsızdır
 *     ama gereksizdir; çağıran (`probe`) hükmü okuyup karar verir.
 *   • `mimeapps.list` yazımı yalnız `xdg-settings` DÜŞERSE devreye girer ve
 *     kullanıcının dosyasının geri kalanına dokunmaz.
 *
 * linux dışında HİÇBİR ŞEY yapmaz.
 */
async function install(opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform !== 'linux') return { ok: false, wrote: false, reason: 'not-linux', steps: [] };
  const {
    scheme, appName, launcher, wmClass = null, icon = null,
    env = {}, homeDir = '', exec = execFile, fs = nodeFs,
  } = opts;
  // 🔑 DOSYA ADI ile EXEC HEDEFİ AYRI: ad `execPath`ten (Electron da o adı arar:
  // `crewpane.desktop`), hedef `launcher`dan (AppImage/AppRun) türer. Adı
  // launcher'dan türetmek `…-x86_64.AppImage.desktop` üretirdi ve Electron'un
  // kendi `setAsDefaultProtocolClient()` çağrısı BAŞKA bir dosyayı arardı.
  const file = opts.desktopFileName
    || desktopFileName({ execPath: opts.execPath || launcher, chromeDesktop: env.CHROME_DESKTOP });
  if (!scheme || !appName || !launcher || !file) {
    return { ok: false, wrote: false, reason: 'bad-args', steps: [] };
  }
  const body = desktopEntry({ launcher, appName, scheme, wmClass, icon });
  const dir = applicationsDir(env, homeDir);
  const target = path.join(dir, file);
  const steps = [];
  let wrote = false;
  try {
    let current = null;
    try { current = fs.readFileSync(target, 'utf8'); } catch { current = null; }
    if (current !== body) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(target, body, { mode: 0o644 });
      wrote = true;
      steps.push(`wrote:${target}`);
    } else {
      steps.push('desktop:unchanged');
    }
  } catch (e) {
    return { ok: false, wrote: false, reason: `write-failed: ${e && e.message}`, steps, desktopPath: target, desktopFile: file };
  }
  if (wrote) {
    const udd = await xdgRun({ bin: 'update-desktop-database', args: [dir], exec });
    steps.push(`update-desktop-database:${udd.ok ? 'ok' : 'skipped'}`);
  }
  const set = await xdgRun({
    bin: 'xdg-settings', args: ['set', 'default-url-scheme-handler', scheme, file], exec,
  });
  steps.push(`xdg-settings:${set.ok ? 'ok' : 'failed'}`);
  if (!set.ok) {
    // `xdg-settings` yok ya da düştü — varsayılanı KENDİMİZ yazalım. Bu, o
    // aracın da yaptığı şeydir (mimeapps.list `[Default Applications]`).
    try {
      const listPath = mimeappsListPath(env, homeDir);
      let text = '';
      try { text = fs.readFileSync(listPath, 'utf8'); } catch { text = ''; }
      const next = upsertMimeappsDefault(text, schemeMimeType(scheme), file);
      if (next !== text) {
        fs.mkdirSync(path.dirname(listPath), { recursive: true });
        fs.writeFileSync(listPath, next, { mode: 0o644 });
        steps.push(`mimeapps.list:wrote`);
      } else {
        steps.push('mimeapps.list:unchanged');
      }
    } catch (e) {
      steps.push(`mimeapps.list:failed(${e && e.message})`);
    }
  }
  return { ok: true, wrote, steps, desktopPath: target, desktopFile: file };
}

/**
 * Linux'ta şemanın GERÇEK durumu — SİSTEMDEN geri okunur.
 *
 * "Yazdım" demiyoruz: yazımdan sonraki ölçüm ne diyorsa o rapor edilir
 * (winScheme.cjs ile aynı sözleşme).
 *
 * linux DIŞINDA hiçbir şey çalıştırmaz.
 */
async function probe(opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform !== 'linux') {
    return {
      state: 'not-linux', effectiveDesktop: null, reasonKey: null, reasonPath: null,
      repairable: false,
    };
  }
  const {
    scheme, env = {}, homeDir = '', exec = execFile, fs = nodeFs, exists,
  } = opts;
  const launcher = opts.launcher || launcherPath({
    appImage: env.APPIMAGE, appDir: env.APPDIR, execPath: opts.execPath, exists,
  });
  const file = opts.desktopFileName
    || desktopFileName({ execPath: opts.execPath || launcher, chromeDesktop: env.CHROME_DESKTOP });
  const dir = applicationsDir(env, homeDir);
  const desktopPath = file ? path.join(dir, file) : null;
  let installedExec = null;
  if (desktopPath) {
    try { installedExec = parseDesktopExec(fs.readFileSync(desktopPath, 'utf8')); } catch { installedExec = null; }
  }
  const { handler, source } = await queryDefaultHandler({ scheme, exec, env, homeDir, fs });
  const verdict = classify({
    ourDesktopFile: file, registeredDesktopFile: handler, installedExec, launcher,
  });
  return {
    ...verdict,
    ourDesktopFile: file,
    desktopPath,
    installedExec,
    launcher,
    handlerSource: source,
  };
}

/**
 * ÖLÇ → gerekiyorsa KUR → YENİDEN ÖLÇ. Açılışta ve "Onar" düğmesinde AYNI yol.
 *
 * Neden ölçmeden kurmuyoruz: kurulum ucuz ama `update-desktop-database` her
 * açılışta koşarsa masaüstü önbelleğini boşuna kirletir. `install()` içerik
 * aynıysa dosyaya dokunmadığı için bu çağrı zaten idempotenttir; buradaki
 * ön-ölçüm yalnız "değişiklik yaptık mı" cevabını dürüst tutar.
 */
async function ensureRegistered(opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform !== 'linux') {
    return { before: { state: 'not-linux' }, install: null, after: { state: 'not-linux' } };
  }
  const before = await probe(opts);
  if (before.state === 'ok') return { before, install: null, after: before };
  const res = await install({
    ...opts,
    launcher: before.launcher,
    desktopFileName: before.ourDesktopFile,
  });
  const after = await probe(opts);
  return { before, install: res, after };
}

module.exports = {
  XDG_TIMEOUT_MS,
  resolveHome,
  MANAGED_KEY,
  schemeMimeType,
  dataHome,
  configHome,
  applicationsDir,
  mimeappsListPath,
  desktopFileName,
  launcherPath,
  execQuote,
  desktopEntry,
  parseDesktopExec,
  parseMimeappsDefault,
  upsertMimeappsDefault,
  classify,
  queryDefaultHandler,
  install,
  probe,
  ensureRegistered,
};
