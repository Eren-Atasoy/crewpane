// AGY-01 — ANTIGRAVITY PANE-BAŞINA ÇALIŞMA-ALANI PLUGIN YAZICISI.
//
// Antigravity'nin (agy) araç kaydı bu ürüne kadar `config-only` sınıfındaydı:
// `$HOME/.gemini/config/mcp_config.json` tek ve PAYLAŞIMLI bir dosya, yani pane
// başına sunucu kaydı YOK (eşzamanlı iki pane aynı belgeye yazar) ve kullanıcının
// kendi config'i kirlenir. ANTIGRAVITY-R1 (agy 1.2.2) bu sınırın kalktığını ölçtü:
// motor artık ÇALIŞMA ALANINDA `.agents/plugins/<ad>/` demetlerini keşfediyor ve
// demet kendi `mcp_config.json`unu taşıyor.
//
// ── R8 KARARI (bu kartın açık sorusu) — ÖLÇÜLDÜ, ÜÇ KOL ──────────────────────────
// Soru: plugin'i kullanıcının REPOSUNA mı (`<repo>/.agents/` + `.git/info/exclude`)
// yoksa repo DIŞI bir köke mi (`--add-dir <kök>`) yazalım?
//   • Kol C (taban, R1 deseni): `.agents/` cwd'nin İÇİNDE → keşfedildi.
//   • Kol A (KARAR): `.agents/` cwd'nin DIŞINDA, İKİNCİ `--add-dir` kökünde →
//     KEŞFEDİLDİ (sunucu spawn oldu, araç ÇAĞRILDI) ve `pwd` İŞ KÖKÜ kaldı.
//   • Kol B (kontrol kolu): aynı cwd, plugin kökü VERİLMEDİ → sunucu spawn OLMADI.
// Hüküm: keşif `--add-dir` köküne bağlı ⇒ kullanıcının reposuna DOSYA BIRAKMAYA
// gerek YOK. Kök `<crewpaneHome>/engine-plugins/<paneKey>` altında yaşar; pane
// başına izolasyon bedava gelir ve `.git/info/exclude` yazma ihtiyacı DÜŞER.
//
// ── 🪤 ÖLÇÜLEN TUZAKLAR ───────────────────────────────────────────────────────────
//  1. `agy mcp list` / `agy plugin list` BU KEŞFİ GÖSTERMEZ (R1 §1.4): liste
//     komutları yalnız config dosyalarını okur, keşif AJAN ÇALIŞMA ZAMANINDA olur.
//     Yani kabul kriterindeki "liste BOŞ" bir ARIZA değil, GLOBAL KİRLENME YOK
//     demenin kanıtıdır.
//  2. MCP sunucusunun cwd'si PLUGIN DİZİNİDİR (ölçüldü, iki kol). Sunucu yolları
//     bu yüzden MUTLAK yazılır; göreli yol plugin dizinine çözülürdü.
//  3. Motor araçları modele TEK TEK göstermiyor; hepsi jenerik `call_mcp_tool`
//     üzerinden gidiyor (R1 §0-5) → araç ADINA dayanan ince taneli kapı KURULAMAZ.
//     Bu AGY-03'ün tasarımını bağlar; burada yalnız beyan edilir.
//  4. `config.json` plugin'i DİZİN ADIYLA kapatabilir (`plugins.<dizin>.enabled`)
//     ve ürünün yazdığı her şeyi yener. Girdisi OLMAYAN plugin varsayılan AÇIK
//     (kol A'nın kanıtı: kullanıcının config.json'unda `plugins` anahtarı YOKTU).
//     Kullanıcı bir kez `agy plugin disable` derse pane SESSİZCE araçsız kalır →
//     AGY-06 sürüm kapısının yanına bir "kapalı mı" kolu düşer.
//
// Bu modül SAF-YAKINDIR: yalnız dosya sistemi yan etkisi vardır, argv'ye basmaz
// (argv katkısını `agentRunner.mcpRegisterArgs` üretir) ve asla throw etmez —
// yazamazsa `null` döner, çağıran nazikçe düşer ve LOG'A YAZAR (sessiz kayıp yasağı).

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const agyHooks = require('./agyHooks.cjs'); // AGY-03 — hooks.json İÇERİĞİ (saf)

/** Plugin DİZİN adı — `config.json`daki açık/kapalı kaydı da bu adla tutulur. */
const PLUGIN_NAME = 'crewpane';

/** Pane köklerinin evi: `<crewpaneHome>/engine-plugins/<paneKey>`. */
const ROOT_DIR_NAME = 'engine-plugins';

/** Motorun DAYATTIĞI demet yolu (descriptor beyan etmezse bu kullanılır). */
const DEFAULT_PLUGIN_PATH = '.agents/plugins';

/** Motorun DAYATTIĞI dosya adları (descriptor beyan etmezse bunlar kullanılır). */
const DEFAULT_FILES = Object.freeze({
  manifest: 'plugin.json',
  mcpConfig: 'mcp_config.json',
  hooks: 'hooks.json',
});

/**
 * Sahipsiz pane kökleri bu yaştan sonra süpürülür. Pane kapanışı normalde kendi
 * kökünü siler; uygulama ÇÖKERSE o adım hiç koşmaz. 14 gün, `integrations-*.json`
 * süpürgesiyle AYNI gerekçe: kimse 14 günden eski bir kökü okuyor olamaz (o pane'in
 * süreci çoktan öldü), dolayısıyla silmek CANLI bir pane'i bozamaz.
 */
const ROOT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Dizin adı olarak güvenli pane anahtarı — `agentRunner.identityPaneKey` süzgecinin
 * AYNISI, ARTI bir kapı: yalnız noktadan oluşan anahtar ('.', '..') REDDEDİLİR.
 *
 * 🔴 Neden ekstra kapı: `identityPaneKey`in süzgeci `.`yı GEÇİRİYOR, yani `..`
 * anahtarı `engine-plugins/..` = `<crewpaneHome>` demek olurdu. Kimlik yolunda bu
 * yalnız yanlış yere DOSYA yazardı; burada `cleanupPlugin` o kökü `rm -rf` ile
 * siliyor ⇒ aynı süzgeç bu modülde YIKICI olurdu. Kapı bu yüzden burada duruyor.
 */
function safePaneKey(key) {
  const filtered = String(key || 'pane').replace(/[^A-Za-z0-9_.-]/g, '_');
  if (!filtered || /^\.+$/.test(filtered)) return 'pane';
  return filtered;
}

/** Bu pane'in `--add-dir` KÖKÜ (plugin bunun ALTINDA yaşar). */
function pluginRootDir(crewpaneHomeDir, paneKey) {
  return path.join(crewpaneHomeDir, ROOT_DIR_NAME, safePaneKey(paneKey));
}

/** Demetin kendi dizini: `<kök>/.agents/plugins/crewpane`. */
function pluginDir(root, descriptor) {
  const rel = (descriptor && descriptor.pluginPath) || DEFAULT_PLUGIN_PATH;
  const name = (descriptor && descriptor.pluginName) || PLUGIN_NAME;
  return path.join(root, ...String(rel).split('/'), name);
}

function fileNames(descriptor) {
  const f = (descriptor && descriptor.files) || null;
  return {
    manifest: (f && f.manifest) || DEFAULT_FILES.manifest,
    mcpConfig: (f && f.mcpConfig) || DEFAULT_FILES.mcpConfig,
    hooks: (f && f.hooks) || DEFAULT_FILES.hooks,
  };
}

/** Manifest — `plugin.json`un TEK zorunlu işi dizini "plugin" diye işaretlemek. */
function buildManifest(descriptor) {
  return `${JSON.stringify(
    {
      name: (descriptor && descriptor.pluginName) || PLUGIN_NAME,
      description: 'CrewPane pane köprüsü — OTOMATİK ÜRETİLDİ, ELLE DÜZENLEMEYİN.',
    },
    null,
    2,
  )}\n`;
}

/**
 * `mcp_config.json` — sunucu haritası. SAF ve DETERMİNİSTİK (anahtar sırası sabit),
 * çünkü idempotanlık "aynı içerik → yeniden yazma YOK" karşılaştırmasına dayanıyor.
 *
 * `env` haritası HER SUNUCUYA yazılır. AGY-01'de gerekçe "pane env mirası ÖLÇÜLMEDİ,
 * ölçülmemiş mirasa güvenme" idi; AGY-02 mirası ÖLÇTÜ ve MİRAS VAR
 * (`mcp.envInheritance: true`, kanıt AGY-02-evidence/01). Yazım yine de SÜRÜYOR ve
 * gerekçesi değişti — artık "bilmiyoruz" değil, İKİ SOMUT sebep:
 *   1. Bu harita pane env'inin KOPYASI değil, SEÇİLMİŞ bir alt kümesidir (lider
 *      kimliği, takım, köprü ucu). Açık yazım köprüyü, çağıranın env'i ne olursa
 *      olsun, DETERMİNİSTİK kılar — miras bir gün daralırsa köprü kimliksiz kalmaz.
 *   2. Miras ile açık yazım ÇELİŞMEZ: aynı anahtar aynı değerle gelir. Kaldırmak
 *      hiçbir şey kazandırmaz, tek bir sessiz kırılma yolu açardı.
 * 🔒 Yazılan değerler SIR DEĞİLDİR (entegrasyon anahtarı bu yoldan GEÇMEZ —
 * `mcpCanCarrySecrets` kapalı, bkz. engineRegistry antigravity `mcp` notu).
 */
function buildMcpConfig(servers, env, descriptor) {
  const field = (descriptor && descriptor.field) || 'mcpServers';
  const entries = Object.entries(env || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const envBlock = entries.length ? Object.fromEntries(entries) : null;
  const map = {};
  for (const s of servers || []) {
    if (!s || !s.name || !s.path) continue;
    // 🪤 MUTLAK YOL ZORUNLU: sunucunun cwd'si PLUGIN DİZİNİ olur (ölçüldü).
    const entry = { command: 'node', args: [s.path] };
    if (envBlock) entry.env = envBlock;
    map[s.name] = entry;
  }
  return `${JSON.stringify({ [field]: map }, null, 2)}\n`;
}

/**
 * `hooks.json` gövdesi. İÇERİK `agyHooks.cjs`te (SAF): burası yalnız onu çağırır.
 *
 * ⏪ AGY-01'de bu fonksiyon SABİT bir iskelet basıyordu (`enabled:false`, iki boş
 * dizi) — yer tutuyordu ama tek bir komut bile koşmuyordu. AGY-03 iskeletin içini
 * doldurdu; komut VERİLMEDİĞİNDE dönen metin AGY-01'inkiyle BİT-BİT AYNIDIR
 * (fail-closed: yarım kapı yok, ya tam kurulur ya hiç).
 *
 * 🪤 Platform: hook komutları Unix'te `sh -c`, Windows'ta `cmd /c` ile koşar
 * (motorun belgesi). Bu yüzden komut `node <mutlak.cjs>` olarak üretilir
 * (`mcpNode.nodeShellCommand`) — kabuk betiği (`./x.sh`) Windows'ta ÇALIŞMAZ.
 */
function buildHooks(spec) {
  return agyHooks.hooksText(spec);
}

/** Aynı içerik zaten diskteyse yazma (idempotanlık + gereksiz IO yok). */
function writeIfChanged(file, text, deps) {
  const readFileSync = (deps && deps.readFileSync) || fs.readFileSync;
  const writeFileSync = (deps && deps.writeFileSync) || fs.writeFileSync;
  let same = false;
  try {
    same = readFileSync(file, 'utf8') === text;
  } catch {
    same = false;
  }
  if (!same) writeFileSync(file, text, { mode: 0o600 });
  return !same;
}

/**
 * Pane'in plugin demetini YAZ ve `--add-dir` KÖKÜNÜ dön (`null` = IO hatası).
 *
 * İDEMPOTENT: iki kez koşmak diski değiştirmez (ikinci koşuda `changed: []`).
 * Sunucu listesi BOŞSA demet yine de yazılır ama `mcp_config.json` boş haritayla
 * yazılır — kök yine verilebilir (kimlik/kural yolu açık kalır) ve motor "sunucu
 * yok" der; bu, dosyayı SİLİP kökü kırık bırakmaktan iyidir (INT-0-C dersi:
 * canlı pane'in gösterdiği dosyayı yok etme).
 */
function writePlugin({ servers, env, root, descriptor, hooks }, deps = {}) {
  const mkdirSync = deps.mkdirSync || fs.mkdirSync;
  try {
    if (typeof root !== 'string' || !root) return null;
    const dir = pluginDir(root, descriptor);
    const names = fileNames(descriptor);
    mkdirSync(dir, { recursive: true });
    const files = {
      manifest: path.join(dir, names.manifest),
      mcpConfig: path.join(dir, names.mcpConfig),
      hooks: path.join(dir, names.hooks),
    };
    const bodies = {
      manifest: buildManifest(descriptor),
      mcpConfig: buildMcpConfig(servers, env, descriptor),
      hooks: buildHooks(hooks),
    };
    const changed = [];
    for (const key of ['manifest', 'mcpConfig', 'hooks']) {
      if (writeIfChanged(files[key], bodies[key], deps)) changed.push(names[key]);
    }
    return {
      root,
      dir,
      files,
      changed,
      servers: (servers || []).filter((s) => s && s.name && s.path).length,
      bytes: bodies.manifest.length + bodies.mcpConfig.length + bodies.hooks.length,
    };
  } catch {
    return null; // çağıran kökü VERMEZ ve log'a yazar (sessiz kayıp yasağı)
  }
}

/**
 * AGY-03 — YALNIZ `hooks.json` (+ eksikse `plugin.json`) yaz; `mcp_config.json`a
 * DOKUNMA. `null` = IO hatası (çağıran kökü VERMEZ ve log'a yazar).
 *
 * 🔴 NEDEN AYRI BİR GİRİŞ, `writePlugin` DEĞİL — iki ölçülmüş sebep:
 *
 *  1. `writePlugin` ÜÇ dosyayı birden yazar. Hook adımı spawn zincirinde MCP
 *     adımından SONRA koşar; orada `writePlugin`i boş sunucu listesiyle çağırsaydık
 *     saniyeler önce yazılmış sunucu haritasının ÜSTÜNE BOŞ harita geçerdi ve pane
 *     sessizce ARAÇSIZ kalırdı (aynı gerekçe `mcpRegisterArgs`in "BOŞ KÜME YAZMA"
 *     kolunda da yazılı).
 *
 *  2. Kapı MCP'YE BAĞLI OLAMAZ. `mcpRegisterArgs` demeti yalnız sunucu LİSTESİ olan
 *     yollarda yazıyor; sunucusuz bir antigravity pane'inde demet HİÇ oluşmazdı ⇒
 *     alt-ajan bloğu da hiç kurulmazdı. Blok bir GÜVENLİK katmanıdır
 *     (`SECURITY_CRITICAL_CAPABILITIES`), araç kablolamasının yan ürünü değil.
 *
 * `plugin.json` burada da yazılır çünkü dizini "plugin" yapan MARKER odur: manifest
 * yoksa motor demeti hiç keşfetmez ve `hooks.json` okunmaz. İçerik `writePlugin`in
 * yazdığıyla AYNI (idempotent) → iki yol birbirinin dosyasını çalkalamaz.
 */
function writeHooks({ root, descriptor, hooks }, deps = {}) {
  const mkdirSync = deps.mkdirSync || fs.mkdirSync;
  try {
    if (typeof root !== 'string' || !root) return null;
    const dir = pluginDir(root, descriptor);
    const names = fileNames(descriptor);
    mkdirSync(dir, { recursive: true });
    const manifestFile = path.join(dir, names.manifest);
    const hooksFile = path.join(dir, names.hooks);
    const changed = [];
    if (writeIfChanged(manifestFile, buildManifest(descriptor), deps)) changed.push(names.manifest);
    if (writeIfChanged(hooksFile, buildHooks(hooks), deps)) changed.push(names.hooks);
    return { root, dir, file: hooksFile, changed };
  } catch {
    return null;
  }
}

/**
 * Pane kapanışında KENDİ kökünü sil. `true` = silindi, `false` = zaten yoktu ya da
 * silinemedi. Yalnız `<crewpaneHome>/engine-plugins/<güvenli anahtar>` altına
 * dokunur: anahtar dosya-adı-güvenli süzgeçten geçtiği için dizin dışına çıkamaz.
 */
function cleanupPlugin(crewpaneHomeDir, paneKey, deps = {}) {
  const rmSync = deps.rmSync || fs.rmSync;
  try {
    const root = pluginRootDir(crewpaneHomeDir, paneKey);
    const statSync = deps.statSync || fs.statSync;
    if (!statSync(root).isDirectory()) return false;
    rmSync(root, { recursive: true, force: true });
    return true;
  } catch {
    return false; // yoktu ya da silinemedi — pane kapanışı bundan ETKİLENMEZ
  }
}

/**
 * SAHİPSİZ kökleri süpür (uygulama çöktüğünde pane kapanışı hiç koşmaz).
 * Best-effort ve SESSİZ; silinen kök sayısını döner.
 */
function sweepStalePlugins(crewpaneHomeDir, now = Date.now(), maxAgeMs = ROOT_MAX_AGE_MS, deps = {}) {
  const readdirSync = deps.readdirSync || fs.readdirSync;
  const statSync = deps.statSync || fs.statSync;
  const rmSync = deps.rmSync || fs.rmSync;
  const home = path.join(crewpaneHomeDir, ROOT_DIR_NAME);
  let removed = 0;
  let names;
  try {
    names = readdirSync(home);
  } catch {
    return 0; // dizin yok — süpürecek bir şey de yok
  }
  for (const name of names) {
    const p = path.join(home, name);
    try {
      if (now - statSync(p).mtimeMs <= maxAgeMs) continue;
      rmSync(p, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* tek kök silinemedi → diğerlerine devam */
    }
  }
  return removed;
}

module.exports = {
  PLUGIN_NAME,
  ROOT_DIR_NAME,
  DEFAULT_PLUGIN_PATH,
  DEFAULT_FILES,
  ROOT_MAX_AGE_MS,
  safePaneKey,
  pluginRootDir,
  pluginDir,
  buildManifest,
  buildMcpConfig,
  buildHooks,
  writePlugin,
  writeHooks,
  cleanupPlugin,
  sweepStalePlugins,
};
