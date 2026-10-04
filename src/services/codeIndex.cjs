// CIDX-1 — "KOD İNDEKSİ" AYARI (proje başına aç/kapa, VARSAYILAN KAPALI).
// Bkz: docs/agent-results/CODE-INDEX-R1-blaster.md §5 §8 · docs/design/ADR-INT-BRIDGE.md §1
//
// ═══════════════════════════════════════════════════════════════════════════════
// NEDEN VARSAYILAN KAPALI — GEREKÇE 09.09'DA DEĞİŞTİ (eski gerekçe ÇÜRÜDÜ)
// ═══════════════════════════════════════════════════════════════════════════════
// ESKİ GEREKÇE (bu başlıkta 05.09'dan 09.09'a kadar yazılıydı): "MCP araç şemaları
// sistem promptunda durur ve her turda yeniden faturalanır → 15 araç ≈ 5.300
// jeton/tur; 494 worker oturumunun yalnız %29'unda amorti eder."
// İki sayı da ÖLÇÜLMEMİŞTİ: 5.300, 6 aracın şema BOYUTUNDAN ölçeklenmiş bir
// tahmindi (CODE-INDEX-R1 §11.4) ve dayandığı varsayım bugünkü motorda geçersiz.
//
// ÖLÇÜLDÜ (CODEINDEX-PROOF-01 §4, üç kollu, gerçek istek farkı):
//   taban (MCP yok) .............................. 18.579 jeton
//   kod indeksi açık (14 araç) ................... 18.795 jeton  → +216
//   KONTROL: 14 araç + ~78.000 jetonluk ŞEMA ..... 18.795 jeton  → +216 (AYNI)
// Kontrol kolu belirleyici: şema 360 kat büyürken maliyet DEĞİŞMEDİ → bağlama
// giren şey şemalar değil yalnız araç ADLARIDIR. Gerçek yük 216 jeton/tur; bir
// pane'in 42.236 jetonluk sabit yükünün binde 5'i. "%29 amorti" hükmü, dayandığı
// sabit yük 24 kat küçülünce geçersiz kaldı ve KALDIRILDI.
//
// BUGÜNKÜ GEREKÇE — DEĞER, jeton değil (CODEINDEX-PROOF-01 §2, A/B):
//   · indeks açıkken ajan araçları KENDİLİĞİNDEN çağırmadı (4 sorunun 3'ünde 0
//     çağrı; her seferinde grep'e gitti) — modele yalnız araç ADI ulaşıyor,
//     ne yaptığını anlatan açıklama bağlamda yok;
//   · cevapların doğruluğu açık/kapalı AYNI kaldı (4/4);
//   · zorla kullandırıldığında doğru ama PAHALI: aynı üç soruda 2,2× para,
//     3,5× süre, 2,9× jeton (CODEINDEX-TEXT-01 §3, eşler-için-eş yeniden hesap;
//     PROOF-01'in raporundaki 1,6×/2,4× farklı sayıda soruyu karşılaştırıyordu).
// Yani özellik bugünkü hâliyle ölçülebilir bir değer üretmiyor → varsayılan kapalı
// kalır ve ekran bunu "deneysel · ölçülen faydası yok" diye SÖYLER (CODEINDEX-TEXT-01).
//
// Kapsam kuralı değişmedi: PROJE BAŞINA. Çalışma alanı geneli tek anahtar YOKTUR.
//
// ═══════════════════════════════════════════════════════════════════════════════
// SIR YOK — ENTEGRASYON DESENİNİN YALNIZ *ENJEKSİYON* YARISI
// ═══════════════════════════════════════════════════════════════════════════════
// Bu MCP %100 yereldir, bulut/API anahtarı istemez (§6). Dolayısıyla `credentialVault`
// yoluna HİÇ girmez: `serverEntry` yalnız {command,args} üretir, `env` bloğu YOKTUR.
// ADP-585'in "Kural 1: diske düz-metin secret ASLA" disiplini burada boşta durur —
// taşınacak bir sır yok. Enjeksiyon ise MEVCUT zincirden geçer (agentRunner
// `mcpRegisterArgs` → additive `--mcp-config`); yeni bir yol icat EDİLMEZ.
//
// ═══════════════════════════════════════════════════════════════════════════════
// ÜRÜN İKİLİYİ GÖMMEZ
// ═══════════════════════════════════════════════════════════════════════════════
// İkili 262 MB; uygulamanın kendisi 365 MB (§6). Dört platforma gömmek DMG'yi ~%72
// şişirirdi (§12.1 önerisi: HAYIR). Bu yüzden `findBinary` bir KEŞİF fonksiyonudur:
// kullanıcının makinesinde varsa özellik açılabilir, yoksa ayar satırı "kurulu değil"
// der ve anahtar pasif kalır. Bulunamayan ikili bir HATA değildir.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Kullanıcının kurduğu ikilinin adı (github.com/DeusData/codebase-memory-mcp, MIT). */
const BIN_NAME = 'codebase-memory-mcp';

/**
 * MCP belgesinde bu sunucunun adı.
 *
 * 🪤 ÖLÇÜLDÜ (CIDX-1 sürüşü, 05.09): ad ÖNCE `codebase-memory` idi ve bu YANLIŞTI.
 * Kullanıcının KENDİ `~/.claude.json`'ında zaten bir `codebase-memory-mcp` kaydı
 * vardı ("User MCPs · ✔connected · 14 tools"). İki kayıt additive `--mcp-config`
 * zincirinde yan yana durur; adlar birbirine bu kadar yakınken (a) hangi kaydın
 * ürünün enjeksiyonu olduğu `/mcp` ekranında AYIRT EDİLEMİYOR — yani özelliğin
 * çalıştığı da çalışmadığı da kanıtlanamıyor — ve (b) kullanıcı bir gün kaydını
 * tam olarak `codebase-memory` adlandırırsa biri diğerini SESSİZCE ezer.
 * Ad artık ürünün kendi ön ekini taşır: kimin koyduğu ekranda okunur.
 */
const SERVER_NAME = 'crewpane-code-index';

/** Kurulum yolu — UI "kurulu değil" hâlinde bunu gösterir (tek kaynak). */
const INSTALL_URL = 'https://github.com/DeusData/codebase-memory-mcp';

/**
 * WIN-PARITY-01 — PLATFORMA GÖRE KURULUM KOMUTU (ÖLÇÜLDÜ, uydurulmadı).
 *
 * Satıcının 09.09'daki sürümü (v0.10.8) ÜÇ platformu da yayınlıyor:
 *   darwin-{arm64,amd64} · linux-{arm64,amd64}(+portable) · windows-amd64 (.zip)
 * — yani "Windows'ta yok" demek YALAN olurdu. Ama kurulum YOLU farklı:
 *   POSIX  : `install.sh`  → `$HOME/.local/bin/codebase-memory-mcp`
 *   Windows: `install.ps1` → `%LOCALAPPDATA%\Programs\codebase-memory-mcp\
 *            codebase-memory-mcp.exe`  (script satır 15-16'dan birebir okundu)
 * Ekranda tek bir `curl … | bash` satırı göstermek, Windows kullanıcısına
 * ÇALIŞMAYACAK bir komut vermekti (engineInstall'un ENG-13'te kapattığı sınıfın
 * ta kendisi). Bu tablo o boşluğu kapatır.
 */
const INSTALL_HINT = Object.freeze({
  darwin: 'curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash',
  linux: 'curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash',
  win32: 'irm https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.ps1 -OutFile install.ps1; Unblock-File .\\install.ps1; .\\install.ps1',
});

/** Bu platformda kurulum komutu (bilinmeyen platform → `null`, komut UYDURULMAZ). */
function installHint(platform) {
  return INSTALL_HINT[platform || process.platform] || null;
}

/** Git sha: kısa (7) ya da tam (40) onaltılık. Başka hiçbir şey kabul edilmez. */
const SHA_RE = /^[0-9a-f]{7,40}$/;

/** Proje anahtarı: settings.json'daki slug ile AYNI gramer (projectIsolation emsali). */
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;

/**
 * Proje kimliğini kanonik hâle getir. `null` = kullanılamaz anahtar.
 * Yol ayracı taşıyan bir "slug" (`a/../b`) DÜŞER: ayar haritasının anahtarı bir gün
 * dosya adına dönüşürse dizin dışına çıkamasın.
 */
function projectKey(raw) {
  if (typeof raw !== 'string') return null;
  const k = raw.trim().toLowerCase();
  if (!k || !SLUG_RE.test(k)) return null;
  return k;
}

/**
 * `settings.codeIndex` şeması:
 *   { "<projectId>": { enabled:boolean, indexedSha:string|null, lastIndexedAt:number|null } }
 *
 * Diskteki değere GÜVENİLMEZ. `enabled` YALNIZ gerçek boolean'dır — `"true"`, `1`
 * ya da `{}` bir projeyi AÇAMAZ. Gerekçe ölçülü: bu anahtar her turda jeton yakan
 * bir yükü devreye alıyor; "yanlışlıkla açık" hâli kullanıcıya doğrudan para
 * ödetir, dolayısıyla açılmanın tek yolu bilinçli bir `true` olmalıdır.
 * Kayıt kalmazsa `null` döner (ADP-675 beyaz-liste disiplini: boş harita ≠ kayıt).
 */
function sanitizeCodeIndex(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = projectKey(k);
    if (!key) continue;
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const sha = typeof v.indexedSha === 'string' && SHA_RE.test(v.indexedSha.trim().toLowerCase())
      ? v.indexedSha.trim().toLowerCase()
      : null;
    out[key] = {
      enabled: v.enabled === true,
      indexedSha: sha,
      lastIndexedAt: Number.isFinite(v.lastIndexedAt) && v.lastIndexedAt > 0 ? v.lastIndexedAt : null,
    };
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Bu proje için indeks AÇIK mı? Kayıt yoksa KAPALI — ve bu "henüz karar verilmedi"
 * değil, kararın KENDİSİdir (§5). Proje kimliği taşımayan pane de kapalıdır:
 * hangi projenin indeksi olduğu bilinmeyen bir yerde araç açmanın anlamı yok.
 */
function isEnabled(map, projectId) {
  const key = projectKey(projectId);
  if (!key || !map || typeof map !== 'object') return false;
  const rec = map[key];
  return !!(rec && rec.enabled === true);
}

/**
 * Bu yol ÇALIŞTIRILABİLİR bir dosya mı? (kurulu görünüp spawn'da patlamasın)
 *
 * 🪤 WIN-PARITY-01 — `X_OK` WINDOWS'TA ANLAMSIZDIR: Node belgelenmiş biçimde onu
 * `F_OK` gibi işler, yani "çalıştırılabilir mi" sorusuna Windows'ta HER ZAMAN evet
 * der. Orada cevabı veren şey UZANTIDIR (PATHEXT) ve o kontrol `executableNames`te
 * yapılır. Burada win32'de bilerek `F_OK` sorulur — var olmayan bir semantiği
 * sorup "ölçtüm" demek, ölçmemekten daha kötüdür.
 */
function isExecutableFile(p, deps, platform) {
  const io = deps || fs;
  const plat = platform || process.platform;
  try {
    if (!io.statSync(p).isFile()) return false;
    io.accessSync(p, plat === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** PATHEXT yoksa Windows'un kendi varsayılanı (cmd.exe `set PATHEXT` çıktısı). */
const PATHEXT_DEFAULT = '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.WSF;.MSC';

/**
 * Bu platformda ikilinin taşıyabileceği dosya ADLARI.
 *
 * ARIZA (ölçüldü 09.09, XPLAT-01 §2 satır 3): kod PATH'te DÜZ `codebase-memory-mcp`
 * arıyordu. Windows'ta çalıştırılabilirler uzantı taşır (satıcının install.ps1'i
 * `codebase-memory-mcp.exe` bırakıyor — script satır 16) ve uzantısız ad HİÇBİR
 * ZAMAN bulunmaz → özellik sessizce "kurulu değil" kalıyordu. Sessiz ölüm.
 */
function executableNames(base, { platform, env } = {}) {
  const plat = platform || process.platform;
  if (plat !== 'win32') return [base];
  const e = env || process.env;
  const exts = String(e.PATHEXT || PATHEXT_DEFAULT)
    .split(';')
    .map((x) => x.trim().toLowerCase())
    .filter((x) => x.startsWith('.'));
  // Uzantılı adlar ÖNCE: Windows'ta uzantısız bir dosya çalıştırılamaz, dolayısıyla
  // uzantısız eşleşme yalnız son çare (WSL/Git-Bash yerleşimi) olarak denenir.
  return [...exts.map((x) => `${base}${x}`), base];
}

/**
 * Satıcının KENDİ varsayılan kurulum dizin(ler)i — her ikisi de kurulum
 * script'lerinden BİREBİR okundu, tahmin edilmedi:
 *   install.sh :15  `$HOME/.local/bin`
 *   install.ps1:15  `$env:LOCALAPPDATA\Programs\codebase-memory-mcp`
 */
function vendorInstallDirs({ homedir, env, platform } = {}) {
  const home = homedir || require('node:os').homedir();
  const e = env || process.env;
  const plat = platform || process.platform;
  if (plat !== 'win32') return [path.join(home, '.local', 'bin')];
  const dirs = [];
  if (e.LOCALAPPDATA) dirs.push(path.join(e.LOCALAPPDATA, 'Programs', BIN_NAME));
  dirs.push(path.join(home, 'AppData', 'Local', 'Programs', BIN_NAME));
  // Git-Bash/WSL'den gelen POSIX yerleşimi — SON sırada, ama sessizce atlanmaz.
  dirs.push(path.join(home, '.local', 'bin'));
  return [...new Set(dirs)];
}

/**
 * İkiliyi bul: önce satıcının kurulum dizini, sonra PATH.
 * Bulunamaması bir HATA DEĞİLDİR — ürün ikiliyi dağıtmaz (§12.1), "kurulu değil"
 * ürünün normal bir hâlidir ve UI bunu ANLATIR (ölü bir özellik gibi görünmesin).
 *
 * 🪤 Kurulum dizini PATH'ten ÖNCE denenir ve bu Windows'ta AYRICA önemlidir:
 * `install.ps1` kullanıcı PATH'ini KALICI olarak günceller, ama ZATEN ÇALIŞAN bir
 * sürecin PATH'i değişmez — yani kurulumdan hemen sonra ikili yalnız kurulum
 * dizininden görünür.
 *
 * @returns {{path:string, source:'local-bin'|'path'}|null}
 */
function findBinary({ homedir, env, fsDeps, platform } = {}) {
  const home = typeof homedir === 'string' && homedir ? homedir : (require('node:os').homedir());
  const plat = platform || process.platform;
  const names = executableNames(BIN_NAME, { platform: plat, env });
  for (const dir of vendorInstallDirs({ homedir: home, env, platform: plat })) {
    for (const n of names) {
      const cand = path.join(dir, n);
      if (isExecutableFile(cand, fsDeps, plat)) return { path: cand, source: 'local-bin' };
    }
  }
  const rawPath = (env && typeof env.PATH === 'string') ? env.PATH : '';
  const delimiter = plat === 'win32' ? ';' : ':';
  for (const dir of rawPath.split(delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const cand = path.join(dir, n);
      if (isExecutableFile(cand, fsDeps, plat)) return { path: cand, source: 'path' };
    }
  }
  return null;
}

/**
 * KULLANICININ KENDİ KAYDI — ölçülmesi ŞART, çünkü bu anahtarın SINIRINI belirler.
 *
 * ÖLÇÜLDÜ (CIDX-1 sürüşü): bu makinenin `~/.claude.json`'ında zaten bir
 * `codebase-memory-mcp` kaydı var ve pane açıldığında araçlar ORADAN da geliyor.
 * Yani ürünün anahtarı KAPALIYKEN bile araç görünebilir. Bu bir arıza değil, bir
 * KAPSAM gerçeğidir: anahtar "CrewPane'in ENJEKTE ETTİĞİNİ" yönetir, kullanıcının
 * kendi yapılandırmasını değil. Ekran bunu SÖYLEMEZSE, kapalı anahtarın yanında
 * duran araç listesi "ayar çalışmıyor" gibi okunur.
 *
 * @returns {string[]} kod-indeksi benzeri sunucu adları (yoksa boş dizi)
 */
function userRegisteredServers({ homedir, readFile } = {}) {
  const home = typeof homedir === 'string' && homedir ? homedir : require('node:os').homedir();
  const read = typeof readFile === 'function' ? readFile : ((f) => fs.readFileSync(f, 'utf8'));
  try {
    const doc = JSON.parse(read(path.join(home, '.claude.json')));
    const servers = doc && doc.mcpServers && typeof doc.mcpServers === 'object' ? doc.mcpServers : {};
    return Object.keys(servers).filter((k) => /codebase[-_ ]?memory|code[-_ ]?index/i.test(k) && k !== SERVER_NAME);
  } catch {
    return []; // dosya yok/bozuk → iddia YOK (boş liste "yok" demek değil, "ölçemedim")
  }
}

/**
 * MCP belgesine yazılacak sunucu girdisi. SIR YOK: `env` alanı hiç üretilmez —
 * bu, entegrasyon deseninin kasa yarısının burada KULLANILMADIĞININ kod içindeki
 * kanıtıdır (bir gün buraya `env` eklenirse `credentialVault` tartışması geri gelir).
 */
function serverEntry(binPath) {
  return { command: binPath, args: [] };
}

/**
 * Spawn anındaki karar tek yerde. `main` bunu kurar (ayar okuması main-only —
 * `opts` renderer-kontrollüdür, ADP-580 providerKeys emsali) ve `trusted` ile
 * `buildSpawn`a geçirir; agentRunner yalnız SONUCU görür.
 *
 * Her `resolve` çağrısında ayar TAZE okunur: Ayarlar'dan anahtarı açmak uygulamayı
 * yeniden başlatmadan BİR SONRAKİ pane'e uygulanır (integrations/engineProfiles ile
 * aynı sözleşme). Okuma patlarsa `null` — spawn ASLA bloklanmaz.
 */
/**
 * CODEINDEX-PROOF-01 — BU OTURUMDA KAÇ PANE'E VERİLDİ.
 *
 * Sayacın adı DİKKATLE seçildi: bu "kaç kez KULLANILDI" DEĞİL, "kaç pane'e
 * VERİLDİ"dir. Aradaki fark ölçüldü ve büyük çıktı (09.09 A/B): indeks açıkken
 * üç kod-grafi sorusunun üçünde de ajan araçlardan HİÇBİRİNİ çağırmadı, grep'e
 * gitti. Yani "verildi" ile "kullanıldı" aynı sayı değil ve ekranın ikisini
 * karıştırması, çalışmayan bir özelliği çalışıyor göstermek olurdu.
 *
 * Gerçek çağrı sayısı ürün tarafından ÖLÇÜLEMİYOR: MCP sunucusu claude'un
 * çocuğudur, araç çağrıları ürünün göremediği bir kanaldan geçer ve ikilinin
 * kendi günlükleri yalnız indeksleme işçilerini yazar (285 dosya tarandı, çağrı
 * defteri yok). Ölçemediğimiz şeyi ekranda İDDİA ETMİYORUZ.
 */
const injectionCounts = new Map();

function noteInjection(projectId) {
  const key = projectKey(projectId);
  if (!key) return;
  injectionCounts.set(key, (injectionCounts.get(key) || 0) + 1);
}

/** @returns {Record<string, number>} slug → bu oturumda enjekte edilen pane sayısı */
function injectionsThisSession() {
  return Object.fromEntries(injectionCounts);
}

function createResolver({ readSettings, findBinary: find, env, homedir, log } = {}) {
  const finder = typeof find === 'function' ? find : () => findBinary({ homedir, env });
  return {
    resolve(projectId) {
      const key = projectKey(projectId);
      if (!key) return null;
      let map = null;
      try {
        map = (typeof readSettings === 'function' ? readSettings() : null || {}).codeIndex || null; // eslint-disable-line no-constant-binary-expression -- known precedence bug, see docs/refactor-findings.md F-001
      } catch (e) {
        if (typeof log === 'function') log(`kod indeksi: ayar okunamadı (${(e && e.message) || e}) → kapalı sayıldı`);
        return null;
      }
      if (!isEnabled(map, key)) return null;
      const bin = finder();
      if (!bin || !bin.path) {
        if (typeof log === 'function') log(`kod indeksi: ${key} için açık ama ${BIN_NAME} kurulu değil → enjekte edilmedi`);
        return null;
      }
      noteInjection(key);
      return { projectId: key, binPath: bin.path, server: serverEntry(bin.path) };
    },
  };
}

/**
 * TAZELİK — "ready" TEK BAŞINA KANIT DEĞİLDİR (§4b, CIDX-0'ın P0'ı).
 *
 * Bayat indeks sessizce YANLIŞ kaynak döndürüyor: araç saklı gövde vermiyor,
 * indeksteki satır aralığıyla BUGÜNKÜ dosyayı dilimliyor. İndeks sha'sı kaydıysa
 * dilim kayar ve hata da uyarı da çıkmaz. O yüzden durum üç değerlidir ve
 * "bilinmiyor" hâli "taze" diye YUVARLANMAZ.
 *
 * @param {{indexedSha:string|null, headSha:string|null, changedFiles:string[]|null}} o
 * @returns {{state:'not-indexed'|'fresh'|'stale'|'unknown', staleFiles:number|null, sha:string|null}}
 */
function freshness({ indexedSha, headSha, changedFiles } = {}) {
  const sha = typeof indexedSha === 'string' && indexedSha ? indexedSha : null;
  if (!sha) return { state: 'not-indexed', staleFiles: null, sha: null };
  if (typeof headSha !== 'string' || !headSha || !Array.isArray(changedFiles)) {
    return { state: 'unknown', staleFiles: null, sha };
  }
  const n = changedFiles.filter((f) => typeof f === 'string' && f.trim()).length;
  return { state: n > 0 ? 'stale' : 'fresh', staleFiles: n, sha };
}

module.exports = {
  BIN_NAME,
  SERVER_NAME,
  INSTALL_URL,
  INSTALL_HINT,
  installHint,
  executableNames,
  vendorInstallDirs,
  projectKey,
  sanitizeCodeIndex,
  isEnabled,
  findBinary,
  serverEntry,
  userRegisteredServers,
  createResolver,
  freshness,
  noteInjection,
  injectionsThisSession,
};
