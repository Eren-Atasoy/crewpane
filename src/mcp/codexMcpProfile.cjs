// CODEX-ARGV-01 — codex MCP KAYDI ARGV'DEN DOSYAYA.
//
// ÖNCESİ (agentRunner.codexMcpOverrideArgs): her CrewPane MCP sunucusu oturum-başı
// `-c mcp_servers.<ad>.command/args/env=<TOML>` ile ARGV'den kaydediliyordu. ÖLÇÜLDÜ
// (CODEX-ARGV-01): 3 sunucu × ~1.315 karakterlik env tablosu = 4.508 karakter, yani
// komut satırının %56,3'ü. Windows'un 8.191 duvarıyla birleşince müşteride pane
// "too long" ile ölüyordu.
//
// SONRASI: aynı tablo `$CODEX_HOME/crewpane-<özet>.config.toml` dosyasına yazılır ve
// argv'ye YALNIZ `-p crewpane-<özet>` (≈30 karakter) girer.
//
// ── ÖLÇÜLEN GERÇEKLER (codex-cli 0.147.0, gerçek ikili, izole CODEX_HOME) ──────────
//  1. `-p <ad>` → `$CODEX_HOME/<ad>.config.toml` OKUNUR. Kanıt: `--strict-config` ile
//     dosyaya tanınmayan bir anahtar konunca hata dosyayı TAM YOLUYLA adlandırdı
//     ("…/codexhome/probe.config.toml:1:1: unknown configuration field").
//  2. Katmanlama ADDITIVE — bugünkü `-c` semantiğinin AYNISI. Kanıt:
//     `codex -p crewpane-pane1 mcp list` çıktısında HEM profildeki `crewpane-task`
//     HEM kullanıcının kendi `kullanici-kendi-sunucusu` göründü.
//  3. BONUS güvenlik: codex bu yoldan gelen env değerlerini `*****` maskeliyor.
//     Bugünkü argv yolu ise CREWPANE_BRIDGE_TOKEN ve Supabase anon anahtarını
//     `ps` çıktısına açık yazıyordu (ADP-580 "anahtar argv'ye asla" çizgisinin ihlali).
//
// ── 🪤 SÜRÜM KAPISI (KÖR UYGULAMA PANE ÖLDÜRÜR) ───────────────────────────────────
//  `-p` bayrağı ESKİ codex'te de VAR ama BAŞKA ŞEY demek: config.toml içindeki
//  `[profiles.<ad>]` tablosu. ÖLÇÜLDÜ (gerçek ikililer indirilip koşturuldu):
//     0.133.0 → `-p, --profile <CONFIG_PROFILE>` … ve olmayan profille:
//               `Error: config profile 'crewpane-pane1' not found` → PANE ÖLÜR
//     0.134.0 → `-p, --profile <CONFIG_PROFILE_V2>` "Layer $CODEX_HOME/<name>.config.toml"
//  Yani eşik 0.134.0'dır. Altındaki sürümde profil yolu KULLANILMAZ, bugünkü `-c`
//  yoluna düşülür (davranış bit-bit korunur). Sürüm ÖLÇÜLEMEZSE de `-c`ye düşülür:
//  ölçmediğimiz bir şeye dayanıp pane öldürmektense bilinen davranışı sürdürmek yeğdir.
//
// ── DOSYA ADI NEDEN İÇERİK ÖZETİ ──────────────────────────────────────────────────
//  Pane kimliğiyle adlandırsaydık aynı anda açılan iki pane aynı dosyaya yarışırdı
//  (ikincisi, codex birincisini okumadan önce üzerine yazar). İçerik özeti bunu
//  yapısal olarak imkânsız kılar: aynı içerik = aynı dosya (yarış yok), farklı içerik
//  = farklı dosya (eziş yok).

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

/** Profil dosyası öneki — kullanıcının kendi profilleriyle çakışmaz, GC'de tanınır. */
const PROFILE_PREFIX = 'crewpane-';
const PROFILE_SUFFIX = '.config.toml';

/**
 * ÖLÇÜLDÜ: `$CODEX_HOME/<ad>.config.toml` katmanlaması bu sürümde geldi (bkz. başlık).
 * ⚠️ Bu YEDEKTİR, gerçek kaynak DEĞİL: eşiği motor descriptor'ı beyan eder
 * (`engineRegistry.codex.mcp.minVersion`) ve çağıran onu geçirir. Burada ikinci bir
 * sabit tutmak "beyan edildi ama okunmuyor" sınıfı sessiz bir kusur üretirdi —
 * descriptor'ı düzenleyen kişi hiçbir etki göremezdi. Yalnız çağıran eşik VERMEZSE
 * kullanılır.
 */
const MIN_PROFILE_VERSION = '0.134.0';

/** Kullanılmayan profil dosyaları bu süre sonra silinir (disk şişmesi kapısı). */
const GC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** `codex-cli 0.147.0` → [0,147,0]; okunamazsa null. */
function parseVersion(text) {
  const m = String(text || '').match(/\b(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** a >= b (üçlü sürüm karşılaştırması). */
function gte(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

/**
 * Sürüm dizesi profil-dosyası taşıyıcısını destekliyor mu?
 * Okunamayan sürüm VEYA okunamayan eşik → false (fail-closed: ölçmediğimiz bir şeye
 * dayanıp pane öldürmektense bilinen davranışı sürdürmek yeğdir).
 */
function versionSupportsProfileFile(text, minVersion) {
  const v = parseVersion(text);
  const min = parseVersion(minVersion || MIN_PROFILE_VERSION);
  return !!(v && min && gte(v, min));
}

// Sürüm sorgusu SÜREÇ ÖMRÜ boyunca önbelleklenir: `buildSpawn` her pane'de çağrılır ve
// alt-süreç maliyeti pane başına ödenmemeli. Anahtar ikili + PATH (aynı oturumda başka
// bir codex'e geçilirse yeniden ölçülür).
const versionCache = new Map();

/**
 * İkiliden sürümü SENKRON oku (memoize). Ölçemezse null. Asla throw etmez.
 *
 * `CREWPANE_CODEX_VERSION` TANI KALDIRACI: sürüm ölçümünü alt-süreç doğurmadan
 * sabitler. İki gerçek işi var — (a) birim testleri makinede kurulu codex'in sürümüne
 * göre yeşil/kırmızı olmasın (kapı "kimde koştuğuna" bağlı kalırsa test hiçbir şey
 * kanıtlamaz), (b) müşteri arızası incelenirken davranış elle sabitlenebilsin.
 * Yalnız sürüm DİZESİNİ verir; eşik kararı yine tek boğazdan geçer.
 */
function probeVersion(file, env, deps = {}) {
  const pinned = (env && env.CREWPANE_CODEX_VERSION) || process.env.CREWPANE_CODEX_VERSION;
  if (typeof pinned === 'string' && pinned.trim()) return pinned;
  const exec = deps.execFileSync || require('node:child_process').execFileSync;
  const key = `${file}|${(env && env.PATH) || ''}`;
  if (!deps.execFileSync && versionCache.has(key)) return versionCache.get(key);
  let out = null;
  try {
    out = String(
      exec(file, ['--version'], { env: env || process.env, timeout: 8000, encoding: 'utf8', windowsHide: true }),
    );
  } catch {
    out = null; // kurulu değil / koşmuyor → ölçemedik
  }
  if (!deps.execFileSync) versionCache.set(key, out);
  return out;
}

/**
 * Bu spawn profil-dosyası taşıyıcısını kullanabilir mi? (sürüm kapısı)
 * `minVersion` DESCRIPTOR'DAN gelir — eşiğin tek gerçek kaynağı odur.
 */
function supportsProfileFile(file, env, deps = {}, minVersion) {
  if (typeof deps.version === 'string') return versionSupportsProfileFile(deps.version, minVersion);
  return versionSupportsProfileFile(probeVersion(file, env, deps), minVersion);
}

/** TOML basit dizesi ("…") — kaçışlar agentRunner.tomlBasicString ile AYNI kural. */
function tomlBasicString(value) {
  let out = '"';
  for (const ch of String(value)) {
    const code = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

/**
 * CDX-PLUGIN-01 — codex'in KENDİ Browser eklentisi bu profil OTURUMUNDA kapatılır.
 * ÖLÇÜLDÜ (codex-cli 0.147.0, 2026-08-31, iki yönlü A/B):
 *   • Profilde `enabled=false` → o oturumun rollout'unda `<skills_instructions>`
 *     listesinden `browser:control-in-app-browser` DÜŞER (0 eşleşme); diğer eklentiler
 *     (computer-use, sites…) yerinde kalır — hedefli, katman ADDITIVE-üstü override.
 *   • Aynı dakika profilsiz kullanıcı oturumu: beceri listede DURUR (2 eşleşme) —
 *     kullanıcının kendi codex'ine dokunulmaz.
 *   • `crewpane_browser` MCP yolu etkilenmez (kontrol kolu: eklenti açıkken de
 *     kapalıyken de davranış bit-bit aynı).
 * Neden kapalı: eklentinin skill metni modeli `node_repl` tarayıcı runtime'ına itiyor;
 * CrewPane pane'inde ona bağlı tarayıcı YOK → "No browser is available" → sahte FAIL
 * (CDX-BROWSER-02 BEFORE koşusu, 5/5 worker). Gölgeleme burada KAYNAĞINDA biter.
 * Güvenlik: bilinmeyen eklenti kimliği pane ÖLDÜRMEZ (`codex -p … mcp list` exit 0;
 * `--strict-config` bile alan şeklini doğrular, kimliği değil) ve CrewPane spawn'ı
 * strict bayrağı hiç geçmez → eklentisiz/eski codex'te satır sessizce yok sayılır.
 */
const PLUGIN_OVERRIDE_LINES = [
  '',
  "# CDX-PLUGIN-01 — motorun kendi Browser eklentisi bu OTURUMDA kapalı: skill metni",
  "# modeli node_repl tarayıcısına itiyor, pane'de ona bağlı tarayıcı yok (sahte FAIL).",
  '[plugins."browser@openai-bundled"]',
  'enabled = false',
];

/**
 * Sunucu kümesi + env haritasından profil TOML gövdesi üret. SAF ve DETERMİNİSTİK —
 * dosya adı bunun özetinden türediği için anahtar sırası da sabitlenir.
 */
function buildProfileToml(servers, env, keyPrefix = 'mcp_servers') {
  const entries = Object.entries(env || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const lines = [
    '# CrewPane (CODEX-ARGV-01) — OTOMATİK ÜRETİLDİ, ELLE DÜZENLEMEYİN.',
    '# Bu dosya bir codex OTURUM PROFİLİDİR ve yalnız `-p <ad>` ile verildiğinde okunur;',
    '# kullanıcının kendi config.toml\'u DEĞİŞTİRİLMEZ (katmanlama additive).',
  ];
  for (const s of servers || []) {
    lines.push('', `[${keyPrefix}.${s.name}]`);
    lines.push('command = "node"');
    lines.push(`args = [${tomlBasicString(s.path)}]`);
    if (entries.length) {
      lines.push(`[${keyPrefix}.${s.name}.env]`);
      for (const [k, v] of entries) lines.push(`${tomlBasicString(k)} = ${tomlBasicString(v)}`);
    }
  }
  // CDX-PLUGIN-01 — SONA eklenir: bir sunucunun `.env` tablosunun ortasına düşerse
  // TOML tablo bağlamını bölerdi; sonda kendi `[plugins.…]` başlığıyla güvenlidir.
  lines.push(...PLUGIN_OVERRIDE_LINES);
  return `${lines.join('\n')}\n`;
}

/** `$CODEX_HOME` (yoksa `<homedir>/.codex`) — agentRunner.codexHomeDir ile aynı kural. */
function codexHomeDir(env, homedir) {
  const fromEnv = env && typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim();
  return fromEnv ? env.CODEX_HOME : path.join(homedir || os.homedir(), '.codex');
}

/**
 * Bayat profil dosyalarını sil. Best-effort ve SESSİZ (temizlik başarısızlığı bir
 * pane'i asla engellemez). Yalnız KENDİ önekimizi siler.
 */
function gcProfiles(dir, now, maxAgeMs = GC_MAX_AGE_MS) {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(PROFILE_PREFIX) || !name.endsWith(PROFILE_SUFFIX)) continue;
      const p = path.join(dir, name);
      try {
        if (now - fs.statSync(p).mtimeMs > maxAgeMs) fs.unlinkSync(p);
      } catch { /* tek dosya silinemedi → diğerlerine devam */ }
    }
  } catch { /* dizin okunamadı → temizlik yok, spawn etkilenmez */ }
}

/**
 * Profil dosyasını YAZ ve profil ADINI dön (argv'ye `-p <ad>` olarak girer).
 * Yazamazsa `null` → çağıran bugünkü `-c` yoluna düşer (nazik düşüş, sessiz değil:
 * çağıran log'a düşürür).
 *
 * İçerik aynıysa dosya YENİDEN YAZILMAZ — aynı anda açılan iki eş pane'in birbirinin
 * dosyasını yarıştırması yapısal olarak imkânsızdır (ad = içerik özeti).
 */
function writeProfile({ servers, env, keyPrefix, codexHome, now }, deps = {}) {
  const writeFileSync = deps.writeFileSync || fs.writeFileSync;
  try {
    const toml = buildProfileToml(servers, env, keyPrefix);
    const digest = crypto.createHash('sha256').update(toml).digest('hex').slice(0, 16);
    const name = `${PROFILE_PREFIX}${digest}`;
    const file = path.join(codexHome, `${name}${PROFILE_SUFFIX}`);
    (deps.mkdirSync || fs.mkdirSync)(codexHome, { recursive: true });
    let exists = false;
    try {
      exists = (deps.readFileSync || fs.readFileSync)(file, 'utf8') === toml;
    } catch { exists = false; }
    if (!exists) writeFileSync(file, toml, { mode: 0o600 });
    (deps.gc || gcProfiles)(codexHome, Number.isFinite(now) ? now : Date.now());
    return { name, file, bytes: toml.length };
  } catch {
    return null;
  }
}

module.exports = {
  PROFILE_PREFIX,
  PROFILE_SUFFIX,
  MIN_PROFILE_VERSION,
  GC_MAX_AGE_MS,
  parseVersion,
  versionSupportsProfileFile,
  supportsProfileFile,
  buildProfileToml,
  codexHomeDir,
  gcProfiles,
  writeProfile,
};
