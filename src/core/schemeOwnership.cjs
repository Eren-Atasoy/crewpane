'use strict';
/**
 * ADP-719 — Giriş dönüşü (`<şema>://auth/callback`) DOĞRU uygulamaya mı geliyor?
 *
 * ## Ölçülmüş kök nedenler (Eren'in makinesi, 2026-07-28)
 *
 * 1. **Dev koşusu şemayı kalıcı olarak ÇALIYOR.** Paketsiz Electron'da
 *    `app.setAsDefaultProtocolClient(scheme, process.execPath, …)` çağrılırsa
 *    LaunchServices'e ÇIPLAK Electron ikilisi (`com.github.Electron`) default
 *    handler olarak yazılır — ve bu kayıt dev süreci ölünce SİLİNMEZ. Ölçüm:
 *
 *      $ plutil -p ~/Library/Preferences/com.apple.LaunchServices/…secure.plist
 *        LSHandlerURLScheme = "crewpane"; LSHandlerRoleAll = "com.github.electron"
 *        LSHandlerURLScheme = "agentshot";  LSHandlerRoleAll = "com.github.electron"
 *
 *    Yani kurulu ürün yerine bir Electron ikilisi giriş dönüşünü alıyordu.
 *
 * 2. **Aynı şemayı ilan eden ikinci bir paket URL'yi kapabilir.** Eski adla
 *    kurulmuş bir sürüm, DMG kopyası ya da `dist/` çıktısı da aday olur; hangi
 *    aday default eşlemesindeyse URL ORAYA gider (AgentVoice'ta kanıtlandı:
 *    ikinci paket giriş kodunu aldı, ÇALIŞAN doğru app hiçbir şey almadı).
 *
 * ## Tasarım
 *
 * * Mutlu yol UCUZ: `app.isDefaultProtocolClient()` tek çağrı. Pahalı teşhis
 *   (`lsregister -dump`, ~200k satır) YALNIZ sahiplik BİZDE DEĞİLKEN koşar.
 * * Davranış İSİMDEN değil DURUMDAN türer: "başka bir paket aynı şemayı
 *   açabiliyor mu" sorulur; hiçbir ürün adı/bundle id sabiti yoktur.
 * * Saf ayrıştırma/sınıflandırma (`parseClaimants`, `classify`) dışarı açılır —
 *   testler gerçek `lsregister` çıktısı biçimiyle koşar, sistem durumu
 *   değiştirmeden.
 *
 * ## ADP-954 — WINDOWS DALI
 *
 * Yukarıdaki teşhis (`lsregister`) macOS'a AİTTİR ve Windows'ta ÖLÇÜM YOKTU:
 * `ownsDefault=false` çıksa bile `claimants` boş dönüyor, kullanıcı "giriş
 * dönüşü başka bir uygulamaya gidiyor" yazısını sebepsiz görüyor ve "Onar"
 * düğmesi aynı etkisiz talebi tekrarlıyordu. Üstelik Windows'ta kaydın HİÇ
 * OLMAMASI mümkün: kurulum onu yazmıyor (gerekçe + ölçüm:
 * `platform/winScheme.cjs` başlığı). Bu dosya artık platforma göre farklı
 * ÖLÇER ama AYNI sözleşmeyi (`severity`/`conflicts`/`reason`) döndürür — UI
 * (CrewPaneLoginGate) hiç değişmeden Windows'ta da doğru kutuyu çizer.
 *
 * macOS yolu BİT BİT korunuyor: `platform !== 'win32'` iken tek satır bile
 * yeni kod çalışmaz.
 *
 * ## LX-SCHEME-01 — LINUX DALI (P0: ödeme yapmış Ubuntu müşterisi giriş yapamadı)
 *
 * Linux'ta durum Windows'takinden DAHA KÖTÜYDÜ: bu dosya `platform !== 'win32'`
 * dalına düşüp macOS ölçümünü koşuyordu, yani `lsregister` bulunamadığı için
 * `claimants=[]` dönüyor ve kullanıcı "giriş dönüşü BAŞKA bir uygulamaya
 * gidiyor" cümlesini görüyordu — oysa ölçüm (HATA-11 §3) HİÇBİR uygulamanın
 * kayıtlı OLMADIĞINI söylüyordu (`çakışan=0`). Üstelik "Onar" düğmesi Linux'ta
 * her zaman etkisizdi: `setAsDefaultProtocolClient()` kayıt olmadığı için
 * `false` dönüyordu ve düğme aynı çağrıyı tekrarlıyordu.
 *
 * Artık Linux dalı (a) `.desktop` girdisini KENDİ KURAR (`platform/linuxScheme.cjs`),
 * (b) sonucu SİSTEMDEN geri okur (`xdg-mime query`), (c) aynı sözleşmeyi
 * (`severity`/`conflicts`) döndürür ve (d) ek olarak bir SÖZLÜK ANAHTARI
 * (`reasonKey`) taşır: uyarı cümlesi artık ham VERİ olarak taşınmadığı için
 * İngilizce arayüzde Türkçe görünmez (ölçülmüş kusur HATA-11 D5).
 */

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const winScheme = require('../../platform/winScheme.cjs'); // ADP-954 — win32 ölçümü
const linuxScheme = require('../../platform/linuxScheme.cjs'); // LX-SCHEME-01 — linux ölçümü

const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/'
  + 'LaunchServices.framework/Support/lsregister';

/**
 * `lsregister -dump` çıktısından verilen şemayı sahiplenen .app yolları.
 * Saf fonksiyon — test gerçek çıktı biçimiyle besler.
 */
function parseClaimants(dump, scheme) {
  const out = [];
  let current = null;
  for (const raw of String(dump || '').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('path:')) {
      current = line.slice('path:'.length).trim();
      const idx = current.lastIndexOf(' (0x');
      if (idx > 0 && current.endsWith(')')) current = current.slice(0, idx);
    } else if (line.startsWith('claimed schemes:') && current) {
      const schemes = line.slice('claimed schemes:'.length)
        .split(',').map((s) => s.trim().replace(/:$/, ''));
      if (schemes.includes(scheme) && !out.includes(current)) out.push(current);
    }
  }
  return out;
}

function bundleIdOf(appPath) {
  try {
    // Info.plist ikili (bplist) olabilir → plutil ile JSON'a çevirmek yerine
    // ucuz yol: `defaults read` yerine doğrudan metin araması yapmıyoruz.
    // execFileSync burada YOK (açılışı bloklamamak için çağıran async sarar).
    const plist = path.join(appPath, 'Contents', 'Info.plist');
    const text = fs.readFileSync(plist, 'utf8');
    const m = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(text);
    return m ? m[1] : null;
  } catch {
    return null; // ikili plist ya da okunamıyor — kimlik bilinmiyor, yol yeter
  }
}

function displayNameOf(appPath) {
  return path.basename(appPath).replace(/\.app$/, '');
}

function normalize(p) {
  if (!p) return null;
  try { return fs.realpathSync(String(p).replace(/\/+$/, '')); } catch { return String(p).replace(/\/+$/, ''); }
}

/**
 * Ham durumdan kullanıcıya gösterilecek karar.
 *
 * `ownsDefault` false ise giriş dönüşü BAŞKA bir uygulamaya gidiyor demektir —
 * kullanıcı giriş yapamaz, sebebini de göremez. Saf fonksiyon.
 */
function classify({ scheme, ownsDefault, ownAppPath, claimants = [], packaged = true }) {
  const own = normalize(ownAppPath);
  const conflicts = claimants
    .map(normalize)
    .filter((p) => p && p !== own)
    .map((p) => ({ path: p, bundleId: bundleIdOf(p), name: displayNameOf(p) }));
  if (ownsDefault && conflicts.length === 0) {
    return { severity: null, conflicts, reason: `${scheme}:// sahibi biziz` };
  }
  if (!ownsDefault) {
    return {
      severity: 'blocking',
      conflicts,
      reason: `Giriş dönüşü (${scheme}://) başka bir uygulamaya gidiyor — giriş bu `
        + 'uygulamada tamamlanmaz.',
    };
  }
  return {
    severity: packaged ? 'warn' : null,
    conflicts,
    reason: `Aynı giriş bağlantısını sahiplenen ${conflicts.length} başka kurulum var — `
      + 'giriş her an yanlış uygulamaya düşebilir.',
  };
}

/**
 * ADP-954 — Windows ölçümünü (winScheme.probe hükmü) BU dosyanın sözleşmesine
 * çevir. Saf fonksiyon: `probe()` çıktısı girer, `{severity, conflicts, reason}`
 * çıkar — yani UI tarafı platformu hiç bilmez.
 *
 * `conflicts` burada da İSİMDEN değil DURUMDAN türer: "efektif komut bizim
 * .exe'miz değil" ise o yol bir çakışandır; hiçbir ürün adı sabiti yoktur.
 */
function classifyWindows(probeResult = {}, { scheme = '?', ourExe = null } = {}) {
  const st = probeResult.state;
  const other = probeResult.effectiveExe && !winScheme.samePath(probeResult.effectiveExe, ourExe)
    ? [{
      path: probeResult.effectiveExe,
      bundleId: null,
      name: String(probeResult.effectiveExe).split(/[\\/]/).pop() || probeResult.effectiveExe,
    }]
    : [];
  if (st === 'ok') {
    return { severity: null, conflicts: [], reason: `${scheme}:// sahibi biziz` };
  }
  if (st === 'shadowed') {
    return { severity: 'warn', conflicts: other, reason: probeResult.detail };
  }
  // missing / stale / foreign / hijacked → giriş dönüşü BU pencereye ulaşmaz.
  return { severity: 'blocking', conflicts: other, reason: probeResult.detail };
}

/**
 * LX-SCHEME-01 — Linux ölçümünü (linuxScheme.probe hükmü) BU dosyanın
 * sözleşmesine çevir. SAF fonksiyon.
 *
 * İki fark Windows dalından:
 *   • `reasonKey` — renderer'ın ÇEVİRECEĞİ sözlük anahtarı. `reason` alanı
 *     yalnız LOG içindir; ekranda ham veri gösterilmesi HATA-11 D5'ti.
 *   • `conflicts` yalnız GERÇEKTEN başka bir girdi kayıtlıysa dolar. Müşterinin
 *     hâli (`missing`) çakışan ÜRETMEZ — "başkası kapmış" demek YANLIŞ olurdu.
 */
function classifyLinux(probeResult = {}, { scheme = '?' } = {}) {
  const st = probeResult.state;
  const shared = {
    reasonKey: probeResult.reasonKey || null,
    reasonPath: probeResult.reasonPath || null,
  };
  if (st === 'ok') {
    return { severity: null, conflicts: [], reason: `${scheme}:// sahibi biziz`, ...shared };
  }
  if (st === 'foreign') {
    const other = probeResult.effectiveDesktop;
    return {
      severity: 'blocking',
      conflicts: other ? [{ path: other, bundleId: null, name: other }] : [],
      reason: `${scheme}:// başka bir masaüstü girdisine kayıtlı (${other}) — `
        + 'giriş dönüşü bu pencereye ulaşmaz.',
      ...shared,
    };
  }
  if (st === 'stale') {
    return {
      severity: 'blocking',
      conflicts: [],
      reason: `${scheme}:// kaydı bu kopyayı göstermiyor `
        + `(${probeResult.installedExec || 'bilinmiyor'}) — tıklanan bağlantı `
        + 'yanlış dosyayı açar ya da hiçbir şey açmaz.',
      ...shared,
    };
  }
  // missing (ve bilinmeyen her durum) → dönüş hiçbir yere teslim edilemez.
  return {
    severity: 'blocking',
    conflicts: [],
    reason: `${scheme}:// için sistemde masaüstü kaydı YOK — tarayıcı giriş `
      + 'bağlantısını hiçbir uygulamaya teslim edemez.',
    ...shared,
  };
}

/**
 * LX-SCHEME-01 — Linux ölçüm/kurulum bağlamı: `app` + env'den TÜREYEN veriler.
 *
 * Ayrı bir fonksiyon çünkü `claimAndVerify` bunu İKİ KEZ ister (talepten ÖNCE
 * kurulum, talepten SONRA ölçüm) ve iki çağrının AYNI dosya adına bakması
 * zorunludur — iki ad = iki gerçek.
 */
function linuxDeskContext({ app, env = {}, exists } = {}) {
  let execPath = null;
  try { execPath = app && typeof app.getPath === 'function' ? app.getPath('exe') : null; } catch { execPath = null; }
  if (!execPath) execPath = process.execPath;
  let appName = null;
  try { appName = app && typeof app.getName === 'function' ? app.getName() : null; } catch { appName = null; }
  if (!appName) appName = path.basename(String(execPath || '')) || null;
  const launcher = linuxScheme.launcherPath({
    appImage: env.APPIMAGE, appDir: env.APPDIR, execPath, exists,
  });
  return {
    execPath,
    launcher,
    appName,
    // WM_CLASS'ı Chromium `app.getName()`ten türetir → görev çubuğu girdisi
    // pencereyle eşleşsin diye AYNI değeri yazıyoruz (ADR §8.3: üç kimlik tek yerden).
    wmClass: appName,
    // İkon ADI: çalıştırılabilir adı (electron-builder deb/pacman ikonunu bu adla
    // kurar). AppImage'da tema ikonu yoktur — `$APPDIR` yolu YAZMIYORUZ, çünkü o
    // dizin (`/tmp/.mount_XXXX`) süreç ölünce KAYBOLUR ve girdi kırık ikon gösterir.
    icon: path.basename(String(execPath || '')) || null,
    desktopFileName: linuxScheme.desktopFileName({
      execPath, chromeDesktop: env.CHROME_DESKTOP,
    }),
  };
}

function runLsregisterDump(exec = execFile) {
  return new Promise((resolve) => {
    try {
      exec(LSREGISTER, ['-dump'], { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
        (err, stdout) => resolve(err ? '' : String(stdout || '')));
    } catch { resolve(''); }
  });
}

/**
 * Şemayı SAHİPLEN + sahipliğin gerçekten geçtiğini DOĞRULA + gerekirse teşhis et.
 *
 * ⚠️ Paketsiz (dev) koşuda şema TALEP EDİLMEZ. Sebep yukarıda §1: dev'de
 * kaydedilen kimlik çıplak Electron'dur ve kurulu üründen şemayı KALICI olarak
 * çalar. Dev'de deep-link'i gerçekten denemek isteyen `<ENV>=1` ile açar; bunun
 * makineyi kirlettiği loga yazılır.
 *
 * → {claimed, ownsDefault, severity, conflicts, reason}
 */
async function claimAndVerify({ app, scheme, log = () => {}, exec = execFile,
  allowDevClaimEnv = 'ALLOW_DEV_PROTOCOL_CLAIM', automated = false,
  automatedReason = null,
  // ADP-954 — Windows ölçüm dikişleri (macOS'ta HİÇBİRİ okunmaz).
  platform = process.platform, winExec = undefined, exists = undefined,
  // LX-SCHEME-01 — Linux dikişleri (macOS/Windows'ta HİÇBİRİ okunmaz).
  // `linuxEnv`/`homeDir` ENJEKTE EDİLEBİLİR: test gerçek `$HOME`a yazmaz.
  linuxEnv = undefined, homeDir = undefined, linuxExec = undefined } = {}) {
  const packaged = Boolean(app.isPackaged);
  const allowDev = process.env[allowDevClaimEnv] === '1';

  // ── LX-SCHEME-01 — LINUX: TALEPTEN ÖNCE KAYDI KUR ────────────────────────
  // SIRA ÖLÇÜLMÜŞ BİR KARARDIR. `app.setAsDefaultProtocolClient()` Linux'ta
  // `xdg-settings set default-url-scheme-handler <şema> <ad>.desktop` koşar ve
  // o dosya sistemde YOKSA çağrı `false` döner (ölçüm: HATA-11 §3.3, çıkış 2).
  // Yani kurulum SONRA yapılırsa Electron'un talebi HER AÇILIŞTA başarısız olur.
  // Ayrıca `CHROME_DESKTOP` bizim dosya adımıza bağlanır: Chromium bu env'i
  // okuyarak masaüstü girdisinin adını bulur — env yoksa BAŞKA bir ad arayabilir
  // ve iki taraf farklı dosyaya bakardı.
  let linuxCtx = null;
  const lxEnv = platform === 'linux' ? (linuxEnv || process.env) : null;
  if (platform === 'linux') {
    linuxCtx = linuxDeskContext({ app, env: lxEnv, exists });
    if (packaged && !automated) {
      if (linuxCtx.desktopFileName && !lxEnv.CHROME_DESKTOP) {
        lxEnv.CHROME_DESKTOP = linuxCtx.desktopFileName;
      }
      try {
        const reg = await linuxScheme.ensureRegistered({
          platform, scheme, ...linuxCtx, env: lxEnv, homeDir, exec: linuxExec,
        });
        log(`${scheme}:// Linux masaüstü kaydı: önce=${reg.before && reg.before.state} `
          + `yazıldı=${Boolean(reg.install && reg.install.wrote)} `
          + `sonra=${reg.after && reg.after.state}`
          + (reg.install && reg.install.steps && reg.install.steps.length
            ? ` [${reg.install.steps.join(' · ')}]` : ''));
      } catch (e) {
        log(`${scheme}:// Linux masaüstü kaydı hatası: ${e && e.message}`);
      }
    } else {
      log(`${scheme}:// Linux masaüstü kaydı YAZILMADI `
        + `(packaged=${packaged} automated=${Boolean(automated)}) — `
        + 'paketsiz/otomasyon kopyası kullanıcının kaydını sahiplenmez.');
    }
  }

  let claimed = false;
  if (automated) {
    // ADP-801 — OTOMASYON OTURUMU ŞEMA TALEP ETMEZ. Paketli e2e kopyası (aynı
    // bundle id, geçici home) `crewpane-dev://`i sahiplenince Eren'in giriş
    // dönüşü headless test sürecine düşebiliyor ve PKCE verifier orada olmadığı
    // için kayboluyordu. Talep etmemek tek başına YETMEZ (aynı bundle'ın her
    // süreci adaydır) — asıl kapı `e2e/schemeSafeLaunch.cjs`: koşum insan
    // kanalının paketini hiç açmaz. Bu satır o kapının ikinci katmanı ve
    // LaunchServices varsayılanının bir koşu yüzünden KAYMASINI da engeller.
    log(`${scheme}:// OTOMASYON oturumunda talep EDİLMEDİ (${automatedReason || 'automated'}) `
      + '— ADP-801: test süreci kullanıcının giriş dönüşünü sahiplenemez.');
  } else if (packaged) {
    try { claimed = app.setAsDefaultProtocolClient(scheme); } catch (e) {
      log(`setAsDefaultProtocolClient error: ${e && e.message}`);
    }
  } else if (allowDev) {
    try {
      claimed = app.setAsDefaultProtocolClient(
        scheme, process.execPath, [path.resolve(process.argv[1] || __dirname)]);
    } catch (e) { log(`setAsDefaultProtocolClient error: ${e && e.message}`); }
    log(`⚠️ ${scheme}:// dev koşusuna kaydedildi (${allowDevClaimEnv}=1) — bu kayıt `
      + 'çıplak Electron ikilisini işaret eder ve KURULU üründen şemayı çalar. '
      + `Geri almak için kurulu uygulamayı bir kez açman yeterli.`);
  } else {
    log(`${scheme}:// dev koşusunda TALEP EDİLMEDİ (ADP-719: dev kaydı `
      + `com.github.Electron'u default yapar ve kurulu üründen şemayı çalar). `
      + `Gerçekten gerekiyorsa ${allowDevClaimEnv}=1.`);
  }

  let ownsDefault = false;
  try { ownsDefault = app.isDefaultProtocolClient(scheme); } catch { ownsDefault = false; }

  // ── ADP-954 — WINDOWS: GERÇEĞİ REGISTRY'DEN OKU, GEREKİRSE ONAR ────────────
  // `isDefaultProtocolClient` Windows'ta `setAsDefaultProtocolClient`in yazdığı
  // ANAHTARIN AYNISINI okur → "tarayıcı bu app'i açabilir mi" sorusunu
  // cevaplamaz (UserChoice / bayat komut / gölgeleme üçüne de kör). Ölçüm
  // ucuzdur (3 `reg query`, ms mertebesi) ve MUTLU YOLDA DA koşar: kaydı
  // yazan başka hiçbir adım yok (kurulum yazmıyor), yani her açılışta
  // doğrulamak tek güvencemiz.
  if (platform === 'win32') {
    const ourExe = (() => { try { return app.getPath('exe'); } catch { return null; } })();
    let result = await winScheme.probe({
      scheme, execPath: ourExe, platform, exec: winExec, exists,
    });
    // Onarılabilir bir bozukluk varsa BİR KEZ yaz ve YENİDEN ÖLÇ. "Yazdım"
    // demiyoruz — yazımdan sonraki ölçüm ne diyorsa o rapor ediliyor.
    if (result.repairable && packaged && !automated) {
      const rep = await winScheme.repair({
        scheme, execPath: ourExe, platform, exec: winExec,
      });
      log(`${scheme}:// Windows kaydı onarımı: durum=${result.state} yazıldı=${rep.ok}`
        + (rep.reason ? ` (${rep.reason})` : ''));
      if (rep.ok) {
        result = await winScheme.probe({
          scheme, execPath: ourExe, platform, exec: winExec, exists,
        });
      }
    }
    const verdict = classifyWindows(result, { scheme, ourExe });
    log(`${scheme}:// sahiplik(win): packaged=${packaged} claimed=${claimed} `
      + `automated=${Boolean(automated)} ownsDefault=${ownsDefault} `
      + `registry=${result.state} severity=${verdict.severity} `
      + `çakışan=${verdict.conflicts.length}`
      + verdict.conflicts.map((c) => ` | ${c.path}`).join(''));
    return {
      claimed, ownsDefault, packaged, automated: Boolean(automated),
      registryState: result.state, ...verdict,
    };
  }

  // ── LX-SCHEME-01 — LINUX: GERÇEĞİ SİSTEMDEN OKU ──────────────────────────
  // `isDefaultProtocolClient` Linux'ta `xdg-settings check …` koşar; kayıt
  // hiç yoksa "false" der ama SEBEBİNİ söylemez ve macOS dalına düşen eski kod
  // `lsregister` arayıp `claimants=[]` döndürüyordu → kullanıcı "başka bir
  // uygulamaya gidiyor" cümlesini SEBEPSİZ görüyordu (HATA-11 D2/D3).
  if (platform === 'linux') {
    let result;
    try {
      result = await linuxScheme.probe({
        platform, scheme, ...(linuxCtx || {}), env: lxEnv, homeDir, exec: linuxExec, exists,
      });
    } catch (e) {
      log(`${scheme}:// Linux ölçüm hatası: ${e && e.message}`);
      result = { state: 'missing', reasonKey: 'login.gate.schemeLinuxMissing' };
    }
    const verdict = classifyLinux(result, { scheme });
    log(`${scheme}:// sahiplik(linux): packaged=${packaged} claimed=${claimed} `
      + `automated=${Boolean(automated)} ownsDefault=${ownsDefault} `
      + `xdg=${result.state} işleyici=${result.effectiveDesktop || '(yok)'} `
      + `kaynak=${result.handlerSource || '?'} exec=${result.installedExec || '(yok)'} `
      + `severity=${verdict.severity} çakışan=${verdict.conflicts.length}`);
    return {
      claimed, ownsDefault, packaged, automated: Boolean(automated),
      xdgState: result.state, desktopFile: result.ourDesktopFile || null, ...verdict,
    };
  }

  // Pahalı teşhis YALNIZ sorun varken: mutlu yolda açılış maliyeti ~0.
  let claimants = [];
  if (packaged && !ownsDefault) {
    claimants = parseClaimants(await runLsregisterDump(exec), scheme);
  }
  const verdict = classify({
    scheme, ownsDefault, ownAppPath: appBundlePath(app), claimants, packaged,
  });
  log(`${scheme}:// sahiplik: packaged=${packaged} claimed=${claimed} `
    + `automated=${Boolean(automated)} `
    + `ownsDefault=${ownsDefault} severity=${verdict.severity} `
    + `çakışan=${verdict.conflicts.length}`
    + verdict.conflicts.map((c) => ` | ${c.bundleId} @ ${c.path}`).join(''));
  return { claimed, ownsDefault, packaged, automated: Boolean(automated), ...verdict };
}

/** Bu sürecin .app bundle yolu (paketsizse null). */
function appBundlePath(app) {
  try {
    const exe = app.getPath('exe');
    const idx = exe.indexOf('.app/');
    return idx > 0 ? exe.slice(0, idx + 4) : null;
  } catch { return null; }
}

module.exports = {
  parseClaimants, classify, classifyWindows, classifyLinux, linuxDeskContext,
  claimAndVerify, appBundlePath, normalize, LSREGISTER,
};
