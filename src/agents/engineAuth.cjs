// ADP-597 — ABONELİKLE GİRİŞ: AI motorlarının (claude / codex) hesap oturumunu
// Ayarlar'dan yönet. Kullanıcı TERMİNALE HİÇ DOKUNMAZ.
//
// NEDEN: CrewPane'in ana motorları abonelikle çalışıyor (Claude Pro/Max,
// ChatGPT Plus) ve girişleri TERMİNALDE yapılıyor. Terminal bilmeyen kullanıcı
// için bu bir duvar — ürünün "hiç bilmeyen" personası buraya çarpıp duruyor.
// BYOK (electron/providers.cjs) bu duvarı kaldırmıyor: o UZMAN yolu, ayrı bir
// ödeme modeli. Bu modül ABONELİK yolunu açar; ikisi YAN YANA yaşar.
//
// ── SPIKE HÜKMÜ (ADP-597 Aşama A — hepsi GERÇEK koşuyla ölçüldü) ───────────
//  1) claude kimliği HOME-KAPSAMLI. `HOME=<boş dizin> claude auth status` →
//     {"loggedIn":false}, gerçek `~/.claude.json` kopyalansa BİLE false. Token
//     macOS Keychain'de ("Claude Code-credentials"), ama farklı HOME'dan
//     ERİŞİLMİYOR. → Pane'ler kullanıcının GERÇEK HOME'unu paylaştığı sürece
//     (agentRunner.sanitizeEnv HOME'u scrub ETMİYOR) oturumu devralırlar.
//  2) codex kimliği düz dosya: `$CODEX_HOME|~/.codex/auth.json` (0600,
//     {auth_mode, tokens{...}}). crewpane CODEX_HOME'u hiç SET etmiyor (yalnız
//     okuyor) → pane'ler ~/.codex'i paylaşır, devralma aynı.
//  3) İKİ motor da TTY İSTEMİYOR: düz `child_process.spawn` + pipe ile giriş
//     akışı sürülebiliyor, URL stdout'tan yakalanıyor (ölçüldü). Bu yüzden
//     giriş GÖRÜNÜR BİR PANE'DE değil, main-process'in yönettiği GİZLİ bir
//     çocukta koşar — kullanıcı terminal görmez.
//  4) Akış farkı (ürün açısından kritik):
//     • claude → `claude auth login` URL basar, tarayıcıda onaydan sonra sayfada
//       bir KOD verir, CLI stdin'den "Paste code here" ile onu bekler → UI'da
//       kod alanı ŞART.
//     • codex  → `codex login` localhost:1455 callback sunucusu açar; tarayıcı
//       dönüşü CLI'a kendiliğinden ulaşır → kod adımı YOK.
//  5) Durum sinyalleri GÜVENİLİR ve ucuz:
//     • `claude auth status` → JSON {loggedIn, authMethod, email, subscriptionType}
//     • `codex login status`  → çıkış 0 + "Logged in using ChatGPT" / çıkış 1 + "Not logged in"
//     Rozet HER ZAMAN bu komutlardan türer — asla "biz giriş başlattık" gibi bir
//     yerel bayraktan. [[ref_whatsapp_status_column_lies]] dersi: durum kolonu
//     yalan söylerse ekran da yalan söyler.
//
// ── GÜVENLİK ÇİZGİLERİ ────────────────────────────────────────────────────
//  • Kullanıcının PAROLASI hiçbir zaman istenmez/saklanmaz — yalnız resmî OAuth.
//  • Token'lar CLI'ın KENDİ deposunda kalır (Keychain / ~/.codex/auth.json).
//    ADP-584 vault'una KOPYALANMAZ (o vault üçüncü-parti servis anahtarları için).
//  • Bu modül hiçbir sır DÖNDÜRMEZ: dışarı çıkan tek şey durum + bir OAuth
//    authorize URL'i. Kullanıcının yapıştırdığı kod tek yön akar (stdin'e) ve
//    hiçbir yere yazılmaz. Log'a giden her satır maskSecrets()'ten geçer.

// ── ENG-08 (SPRINT-ENGINE-03) — DESCRIPTOR-GÜDÜMLÜ TEK AKIŞ MOTORU ─────────
//
// Bu modül ADP-597'de İKİ motorun elle yazılmış dallarıydı (`engine === 'claude'
// ? … : …`, 5 yerde). ENG-08 o dalları `engineRegistry.auth` descriptor'ına taşır:
// akış şekli bir ENUM (`flow`), argv'ler ve ayrıştırma şekli veridir. Yeni motor
// eklemek artık bu dosyayı DEĞİL, defteri değiştirmek demek.
//
// 🔴 EREN KARARI (2026-08-17) — ABONELİK BİRİNCİ SINIF:
//  1) Kullanıcı CLI'da ZATEN girişliyse hiçbir şey İSTENMEZ: `readStatus` motorun
//     KENDİ durum komutunu koşar ve oturumu tanır (bugünkü claude/codex davranışı
//     descriptor'lı her motora genelleşti). Ayarlara girmeden pane açılıp çalışır.
//  2) Girişli değilse abonelik akışı BİRİNCİL yoldur (`oauth-code`/`oauth-callback`).
//  3) API anahtarı YEDEKtir (`auth.apiKey`), asla tek yol olarak sunulmaz; anahtar
//     `credentialVault`ta yaşar ve env ile verilir — ARGV'YE ASLA (ENG-R3 §9.3).
//  4) Abonelik yolu OLMAYAN motorda rozet dürüstçe "bu motor anahtar ister" der;
//     olmayan bir abonelik yolu UYDURULMAZ (`flow:'api-key'` bunu beyan eder).

'use strict';

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const engineCheck = require('./engineCheck.cjs');
const engineInstall = require('./engineInstall.cjs'); // ADP-694 — kurulum komutu/doküman TEK kaynağı
const engineRegistry = require('./engineRegistry.cjs'); // ENG-04/08 — motor descriptor'ı TEK kaynağı
const engineBilling = require('./engineBilling.cjs'); // ENG-16 — satıcı-barındırılan bedava kapı (fatura şeffaflığı)
// ADP-835 (790 P4) — Windows'ta `child.kill()` TORUNLARI BIRAKIR (giriş CLI'ı
// tarayıcı açıcı/yardımcı doğurabiliyor) ve sinyal semantiği zaten yok. Boğaz
// posix'te bugünkü satırı, win32'de `taskkill /T /F` ağacını çalıştırır.
const { terminateTree } = require('../../platform/procProbe.cjs');
const envPath = require('../../platform/envPath.cjs'); // ENG-ACC-P1 — motor hunilerinin ortak PATH'i (TEK kaynak)

// ── Descriptor hunisi (ENG-08) ──────────────────────────────────────────────

/**
 * E2E/test DİKİŞİ — defterde OLMAYAN bir motorun auth descriptor'ı.
 * Ambient env TEK BAŞINA yetmez: açık opt-in bayrağı şart ([[e2e-instance-guard-f1]]
 * deseni, `CREWPANE_FAKE_ENGINE_BIN` ile aynı disiplin) — yoksa bir pane'den koşan
 * e2e'nin ortamı prod app'e sahte motor sokabilirdi.
 *
 * Gelen her descriptor `engineRegistry.validateAuth`tan GEÇMEK ZORUNDA: geçersiz
 * kayıt sessizce yarım bir akış üretmek yerine hiç yüklenmez (fail-closed).
 */
function envDescriptors(env) {
  if (!env || env.CREWPANE_FAKE_ENGINE_DESCRIPTORS !== '1') return null;
  let raw = null;
  try { raw = JSON.parse(String(env.CREWPANE_FAKE_ENGINE_DESCRIPTORS_JSON || '{}')); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const [id, d] of Object.entries(raw)) {
    if (!d || typeof d !== 'object' || !d.auth) continue;
    if (engineRegistry.validateAuth(d.auth).length) continue; // şemadan geçmeyen kayıt YÜKLENMEZ
    out[id] = d;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Bir motorun AUTH descriptor'ı (defter → çözülmüş, çağırana hazır görünüm).
 * `deps.descriptors` doğrudan enjekte edilebilir (birim testi); yoksa env dikişi;
 * yoksa `engineRegistry`. Bilinmeyen motor → `null` (uydurma kayıt ÜRETİLMEZ).
 */
function authDescriptor(engine, deps = {}) {
  const extra = deps.descriptors || envDescriptors(deps.env || process.env);
  const src = extra && Object.prototype.hasOwnProperty.call(extra, engine)
    ? extra[engine]
    : engineRegistry.getEngine(engine);
  if (!src || !src.auth) return null;
  const a = src.auth;
  return {
    engine,
    label: a.label || src.label || engine,
    accountHint: a.accountHint || null,
    signupUrl: a.signupUrl || null,
    flow: a.flow,
    needsCode: a.needsCode === true,
    statusArgv: a.statusArgv || null,
    statusParse: a.statusParse || null,
    // ENG-CURSOR-APIKEY-01 — JSON durum çıktısında "girişli" alanının ADI. Defter bunu
    // ENG-17'den beri beyan ediyordu (cursor: `isAuthenticated`) ama huni taşımıyordu →
    // ayrıştırıcı hep `loggedIn` okuyup tarayıcı-girişli kullanıcıya "bağlı değil" diyordu.
    statusField: typeof a.statusField === 'string' && a.statusField.trim() ? a.statusField.trim() : null,
    // ENG-CURSOR-APIKEY-01 — anahtarı GERÇEKTEN okuyan doğrulama komutu (motor başına).
    // `null` = bugünkü davranış: doğrulama `statusArgv` ile yapılır.
    apiKeyVerifyArgv: Array.isArray(a.apiKeyVerifyArgv) && a.apiKeyVerifyArgv.length ? [...a.apiKeyVerifyArgv] : null,
    // `external` akışta kullanıcıya GÖSTERİLECEK giriş komutunun ikili adı (ürün sürmez, yazar).
    binName: typeof src.bin === 'string' && src.bin.trim() ? src.bin.trim() : engine,
    // ENG-ENABLE-01 — `statusParse:'exit-code'` şeklinin iki yardımcı beyanı:
    // motorun ÖLÇÜLMÜŞ girişsizlik cümlesi (ADP-893 üç-durum ayrımı için) ve
    // girişliyken rozette gösterilecek yöntem etiketi.
    signedOutPattern: typeof a.signedOutPattern === 'string' && a.signedOutPattern.trim() ? a.signedOutPattern : null,
    statusMethodLabel: typeof a.statusMethodLabel === 'string' && a.statusMethodLabel.trim() ? a.statusMethodLabel : null,
    // ENG-12 — durum komutu OLMAYAN abonelik motorunun BEYANI (şema zorunlu kılar).
    // Rozetin "bilinmiyor" diyebilmesi için gerekçe buraya kadar taşınır.
    statusNote: typeof a.statusNote === 'string' && a.statusNote.trim() ? a.statusNote : null,
    // ENG-17 — `external` akışında giriş komutu BEYAN edilebilir (cursor/crush'ta
    // GERÇEKTEN var) ama ürün onu SÜRMEZ; UI'ın "Giriş yap" düğmesini yanlış yere
    // bağlamaması için NEDENİ buraya kadar taşınır (şema >=20 karakter zorunlu kılar).
    externalNote: typeof a.externalNote === 'string' && a.externalNote.trim() ? a.externalNote : null,
    // ENG-17 — anahtar bloğu OLMAYAN motorun BEYANI. Şema `apiKey:null` için gerekçe
    // zorunlu kılıyordu ama gerekçe sözleşmede YOKTU → kullanıcı "anahtar nereye?"
    // sorusunun cevabını hiç görmüyordu (crush: env adı SAĞLAYICIYA göre değişiyor).
    apiKeyNote: typeof a.apiKeyNote === 'string' && a.apiKeyNote.trim() ? a.apiKeyNote : null,
    loginArgv: a.loginArgv || null,
    // ENG-HONEST-CARD-01 — `external` akışta ürünün SÜRMEDİĞİ ama kullanıcının
    // terminalde yazacağı giriş komutu (opencode: interaktif sağlayıcı seçici).
    // `loginArgv`den AYRI tutulur: `loginArgv` dolu olsaydı `startLogin` onu gerçekten
    // sürer ve TUI pipe'ta asılı kalırdı (crush dersi, ENG-LOGIN-R1 §2.4). Bu alan
    // yalnız YAZILIR, koşturulmaz.
    manualLoginArgv: Array.isArray(a.manualLoginArgv) && a.manualLoginArgv.length ? [...a.manualLoginArgv] : null,
    logoutArgv: a.logoutArgv || null,
    apiKey: a.apiKey || null,
    // ADP-936 — çoklu hesap yalnız kimliği İZOLE EDİLEBİLEN motorda açılır.
    // `null` motorda iki hesap AYNI yuvayı ezerdi = VERİ KAYBI (ENG-R3 §9.3).
    identityEnv: src.identityEnv || null,
  };
}

/** Auth descriptor'ı olan motorların kimlikleri (env/test dikişi dahil). */
function authEngines(deps = {}) {
  const extra = deps.descriptors || envDescriptors(deps.env || process.env);
  const ids = engineRegistry.engineIds().filter((id) => !!engineRegistry.capability(id, 'auth'));
  for (const id of Object.keys(extra || {})) if (!ids.includes(id)) ids.push(id);
  return ids;
}

/**
 * Oturum yönetimi desteklenen motorlar — DEFTERDEN türer (elle liste YOK).
 * Not: bu SABİT yalnız kayıtlı motorları taşır; e2e/test dikişiyle gelen ek
 * motorlar için `authEngines(deps)` kullanılır (çağıran env'i bilir, bu sabit bilmez).
 */
const AUTH_ENGINES = Object.freeze(authEngines({ descriptors: null, env: {} }));

/**
 * Motor başına ürün metni + akış şekli (UI bunu tüketir; isim-bazlı if YOK).
 * ENG-08: artık defterin AYNASI — burada ikinci bir gerçek YAZILMAZ.
 */
const ENGINE_AUTH_META = Object.freeze(Object.fromEntries(AUTH_ENGINES.map((id) => {
  const d = authDescriptor(id, { env: {} });
  return [id, Object.freeze({
    id,
    label: d.label,
    accountHint: d.accountHint,
    signupUrl: d.signupUrl,
    /** Tarayıcı dönüşünde CLI stdin'den kod bekler mi? (`flow === 'oauth-code'`) */
    needsCode: d.needsCode,
    flow: d.flow,
  })];
})));

/** Giriş oturumu için üst sınır — asılı kalan bir akış sonsuza dek yaşamasın. */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** Durum probu için üst sınır (engineCheck ile aynı bütçe). */
const STATUS_TIMEOUT_MS = 8000;

// ── Maskeleme ───────────────────────────────────────────────────────────────

/**
 * Log'a/olaya çıkacak metinden sır-benzeri her şeyi siler. Kapsam KASITLI olarak
 * geniş: OAuth URL'i tek-kullanımlık PKCE state/challenge taşır ve kullanıcının
 * yapıştırdığı kod da kısa ömürlü olsa BİR yetkidir — ikisi de transcript'e
 * düşmemeli (T5 grep'i bunu kanıtlar).
 */
function maskSecrets(text) {
  if (typeof text !== 'string' || !text) return '';
  return text
    // Tam URL → yalnız host kalsın (query'de state/code_challenge var).
    .replace(/(https?:\/\/[^\s/]+)\/\S*/g, '$1/…')
    // `code=…`, `token=…`, `key=…` biçimli her atama.
    .replace(/\b(code|token|access_token|refresh_token|id_token|api[-_]?key|secret|state)\s*[=:]\s*\S+/gi, '$1=«gizlendi»')
    // sk-… / oauth token benzeri uzun opak diziler.
    .replace(/\b(sk|pk|rt|at)-[A-Za-z0-9_-]{12,}/g, '«gizlendi»')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '«gizlendi»');
}

// ── Binary çözümleme ────────────────────────────────────────────────────────

/**
 * Motorun ikilisini KULLANICININ LOGIN SHELL'i üzerinden çözer (engineCheck ile
 * aynı huni). Neden shell: Finder/Dock'tan açılan Electron kırpılmış PATH miras
 * alır ve çıplak `claude` "bulunamadı" der ([[gui-app-missing-locale]]).
 *
 * E2E DİKİŞİ: sahte CLI enjekte etmek için `CREWPANE_FAKE_ENGINE_BIN=1` +
 * `CREWPANE_ENGINE_BIN_<MOTOR>=<yol>`. Ortam-değişkeni TEK BAŞINA yetmez —
 * açık opt-in bayrağı şart ([[e2e-instance-guard-f1]] deseni: ambient env reddi),
 * yoksa bir pane'den koşan e2e'nin ortamı prod app'in motorunu kaçırabilirdi.
 */
function resolveBin(engine, deps = {}) {
  const env = deps.env || process.env;
  if (env.CREWPANE_FAKE_ENGINE_BIN === '1') {
    const override = env[`CREWPANE_ENGINE_BIN_${String(engine).toUpperCase()}`];
    if (typeof override === 'string' && override.trim()) {
      return Promise.resolve({ found: true, path: override.trim(), state: 'present' });
    }
  }
  if (deps.resolveBin) return Promise.resolve(deps.resolveBin(engine));
  return engineCheck.probeOne(engine, deps);
}

/**
 * ENG-ACC-P1 — MOTOR KOMUTLARININ KOŞACAĞI ENV (status · login · logout AYNI kapıdan).
 *
 * ÖLÇÜLDÜ (ENG-ACC-P0 §2.4): motorların çoğu `#!/usr/bin/env node` script'idir.
 * Finder/Dock'tan açılan app'in çıplak PATH'i ile çalıştırılınca
 * `env: node: No such file or directory` (rc=127) döner, stdout BOŞ kalır ve rozet
 * "Durum okunamadı" olur — motor kurulu VE girişli olduğu hâlde. İkiliyi BULMAK
 * (probeOne) tek başına yetmez; onu ÇALIŞTIRIRKEN de aynı PATH gerekir.
 *
 * Liste burada TEKRARLANMAZ: tek kaynak `platform/envPath.cjs`.
 */
function execEnv(deps = {}) {
  // PIPE-03 — `home` dikişi de iletilir (bkz. engineCheck.probeOne): platform
  // enjekte edilebiliyorsa ev dizini de edilebilmeli, yoksa enjekte edilen dal
  // host'un ev yoluyla karışır ve testler platformu gerçekten ölçemez.
  return envPath.withAugmentedPath(deps.env || process.env, {
    platform: deps.platform || process.platform,
    home: deps.home,
  });
}

/**
 * ADP-833 (ADR-W7) — probe sonucu ÜÇ-DURUMLU: "yok" ile "ölçemedim" ayrı hatalardır.
 * Windows'ta registry okunamadığında kullanıcıya "kurulu değil" demek yalandır ve
 * onu bitmeyen bir "ben kurdum ama görmüyor" döngüsüne sokar.
 */
function binErrorFor(bin) {
  return bin && bin.state === 'unknown' ? 'check-failed' : 'not-installed';
}

/**
 * Çözülmüş ikiliyi çalıştırmak için (file, argv). Windows'ta npm ile kurulan motor
 * `claude.cmd`dir — batch dosyası; ne CreateProcess ne Node `spawn` onu kabuksuz
 * çalıştırabilir → `cmd.exe /d /s /c` ile sarılır. macOS'ta girdi AYNEN döner.
 */
function execTarget(bin, argv, deps = {}) {
  return engineInstall.execArgs(bin.path, argv, { platform: deps.platform || process.platform, env: deps.env || process.env });
}

/**
 * ADP-893 — `execArgs` win32-batch dalında komut satırını KENDİSİ kuruyor; bayrağı
 * spawn/execFile seçeneklerine geçirmezsek libuv onu TEKRAR kaçışlar ve cmd.exe
 * `\"codex.cmd\"` adında bir komut arar (bulamaz → sıfır-dışı çıkış). Üç canlı
 * semptomun (pane kapanması · "bağlı değil" · login exit 1) ortak kökü buydu.
 * macOS'ta `execArgs` bu alanı hiç döndürmez → seçenekler bit-bit aynı kalır.
 */
function withVerbatim(target, opts) {
  return target && target.windowsVerbatimArguments === true
    ? { ...opts, windowsVerbatimArguments: true }
    : opts;
}

/**
 * Motorun tarayıcıyı KENDİSİNİN açmasını engelleyen no-op `BROWSER` değeri.
 * POSIX'te `/usr/bin/true`. Windows'ta böyle bir dosya YOK ve uydurulmuş bir yol
 * CLI'ı hataya düşürebilirdi → orada değişken HİÇ SET EDİLMEZ (null): en kötü
 * ihtimalle fazladan bir sekme açılır (kozmetik), giriş akışı bloke olmaz.
 * Windows'ta gerçek davranış ÖLÇÜLMEDİ (792 A2) — P0 doğrulama listesinde.
 */
function noopBrowserFor(deps = {}) {
  if (deps.noopBrowser !== undefined) return deps.noopBrowser;
  return (deps.platform || process.platform) === 'win32' ? null : '/usr/bin/true';
}

// ── Durum okuma ─────────────────────────────────────────────────────────────

/**
 * JSON durum çıktısını normalize eder (`statusParse: 'json'` — claude ailesi).
 * ENG-08: motor adına değil ŞEKLE bağlı → aynı şekli basan her motor buradan okur.
 */
function parseJsonStatus(stdout, loggedInField = 'loggedIn') {
  let json = null;
  try {
    // CLI bazen JSON'dan önce uyarı satırı basar (ör. eksik config uyarısı) —
    // ilk '{' ile son '}' arasını al. Ham metne asla güvenme.
    const s = String(stdout || '');
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) json = JSON.parse(s.slice(a, b + 1));
  } catch { json = null; }
  if (!json || typeof json !== 'object') return { loggedIn: false, method: null, account: null, plan: null, org: null, orgId: null, authKind: null };
  // ENG-CURSOR-APIKEY-01 — "girişli" alanının adı DEFTERDEN (`statusField`): claude
  // `loggedIn`, cursor `isAuthenticated` basar. Ad ne olursa olsun ölçüt KESİN `true`.
  const field = typeof loggedInField === 'string' && loggedInField ? loggedInField : 'loggedIn';
  const loggedIn = json[field] === true;
  const method = typeof json.authMethod === 'string' && json.authMethod !== 'none' ? json.authMethod : null;
  // "max" | "pro" | … → abonelik seviyesi; BYOK/console girişinde yok.
  const plan = typeof json.subscriptionType === 'string' ? json.subscriptionType : null;
  return {
    loggedIn,
    method,
    account: typeof json.email === 'string' ? json.email : null,
    plan,
    // HATA-13 — ORGANİZASYON: aynı E-POSTA birden çok organizasyona ait olabilir
    // (bir team koltuğu + kişisel abonelik). O durumda `email` İKİ hesapta da
    // AYNIDIR ve tek başına kimlik DEĞİLDİR: kullanıcı Ayarlar'da iki özdeş satır
    // görür ve hangisinin aktif olduğunu ayırt edemez (Discord bildirimi 04.09).
    // `orgId`/`orgName` durum çıktısında ZATEN vardı; buraya kadar taşınmıyordu.
    org: typeof json.orgName === 'string' && json.orgName.trim() ? json.orgName.trim() : null,
    orgId: typeof json.orgId === 'string' && json.orgId.trim() ? json.orgId.trim() : null,
    // ENG-08 — hangi FATURA kanalıyla girişli. Bilinmiyorsa `null` kalır ve UI
    // "Girişli" der; olmayan bir abonelik İDDİA EDİLMEZ (Eren kuralı-4).
    authKind: loggedIn ? authKindOf(method, plan) : null,
  };
}

/**
 * Metin durum çıktısını normalize eder (`statusParse: 'text'` — codex ailesi).
 * ⚠️ Otorite ÇIKIŞ KODUDUR; metin yalnız yöntem/hesap etiketi için okunur.
 */
function parseTextStatus(stdout, exitCode) {
  const s = String(stdout || '').trim();
  const loggedIn = exitCode === 0 && /logged\s+in/i.test(s) && !/not\s+logged\s+in/i.test(s);
  if (!loggedIn) return { loggedIn: false, method: null, account: null, plan: null, org: null, orgId: null, authKind: null };
  const m = s.match(/logged\s+in\s+using\s+(.+?)\s*$/im);
  const method = m ? m[1].trim() : null;
  // "Logged in using ChatGPT" → abonelik; "…using an API key" → BYOK.
  const isApiKey = /api\s*key/i.test(method || '');
  const account = (s.match(/\(([^)]*@[^)]*)\)/) || [])[1] || null;
  const plan = isApiKey ? null : method;
  // codex durum metninde organizasyon YOK — uydurulmaz, `null` kalır.
  return { loggedIn: true, method, account, plan, org: null, orgId: null, authKind: authKindOf(method, plan) };
}

/**
 * ENG-08 — girişin FATURA KANALI: 'subscription' | 'api-key' | null.
 * `null` = ölçemedik; UI o zaman yalnız "Girişli" der. Saf.
 */
function authKindOf(method, plan) {
  if (/api\s*key|console|billing/i.test(String(method || ''))) return 'api-key';
  if (plan) return 'subscription';
  return null;
}

/**
 * ENG-ENABLE-01 — ÜÇÜNCÜ ŞEKİL: `statusParse: 'exit-code'`.
 *
 * Bazı motorlarda hesap DURUMU komutu YOKTUR ama girişe BAĞLI, ucuz ve model turu
 * HARCAMAYAN bir komut vardır. Otorite ÇIKIŞ KODUDUR; metin yalnız "ölçemedim" ile
 * "hayır"ı ayırmak için okunur (`signedOutPattern`).
 *
 * ÖLÇÜLDÜ (antigravity 1.1.28, İKİ YÖNLÜ — ENG-ENABLE-01-evidence/agy-models-*.txt):
 *   girişli  → exit 0 + model listesi
 *   girişsiz → exit 1 + "Please sign in to view available models. Launch the CLI
 *              without arguments to sign in."
 * Model turu YOK (yalnız katalog isteği). Hesap/plan bu yoldan ÖLÇÜLEMEZ → `null`
 * kalır ve UI yalnız "Girişli" der (Eren kuralı-4: olmayan bir plan uydurulmaz).
 */
function parseExitCodeStatus(desc, stdout, exitCode) {
  if (exitCode !== 0) return { loggedIn: false, method: null, account: null, plan: null, org: null, orgId: null, authKind: null };
  return {
    loggedIn: true,
    method: (desc && desc.statusMethodLabel) || null,
    account: null,
    plan: null,
    org: null,
    orgId: null,
    authKind: null,
  };
}

/** ENG-08 geriye-uyum köprüleri (ADP-597 adları). Yeni kod ŞEKİL adlarını kullanır. */
const parseClaudeStatus = parseJsonStatus;
const parseCodexStatus = parseTextStatus;

/** Descriptor'a göre doğru ayrıştırıcı. Bilinmeyen şekil → "girişsiz" (fail-closed). */
function parseStatus(desc, stdout, exitCode) {
  if (desc && desc.statusParse === 'json') return parseJsonStatus(stdout, desc.statusField || 'loggedIn');
  if (desc && desc.statusParse === 'text') return parseTextStatus(stdout, exitCode);
  if (desc && desc.statusParse === 'exit-code') return parseExitCodeStatus(desc, stdout, exitCode);
  return { loggedIn: false, method: null, account: null, plan: null, org: null, orgId: null, authKind: null };
}

/**
 * ADP-893 — "ÖLÇEMEDİM" ile "HAYIR"ı ayırır (ADR-W7 üç-durum disiplininin durum
 * komutuna uygulanması). Bugüne dek durum komutunun ÇALIŞAMAMASI (komut bulunamadı,
 * bozuk sarmalayıcı, kabuk hatası) sessizce "bağlı değil" diye boyanıyordu — bu tam
 * olarak modülün başlığındaki [[ref_whatsapp_status_column_lies]] hatası. Abonelik
 * sahibi müşteriye "login yapılmadı" demek, onu çözümü olmayan bir döngüye sokar.
 *
 * ENG-08 — ölçüt artık motor ADINA değil AYRIŞTIRMA ŞEKLİNE bağlı:
 * • `text` → gerçek bir CEVAP her zaman "logged in" / "not logged in" içerir
 *            (çıkış 1 + "Not logged in" MEŞRU bir cevaptır, hata değil). Sıfır-dışı
 *            çıkışta bu kelimelerin HİÇBİRİ yoksa komut hiç koşmamıştır.
 * • `json` → gerçek bir cevap daima bir JSON nesnesi basar; hiç yoksa ve çıkış
 *            sıfır-dışıysa ölçüm yapılamamıştır.
 * Saf → test edilebilir. Geriye-uyum: `engineOrDesc` bir motor kimliği de olabilir.
 */
function statusUnmeasured(engineOrDesc, stdout, exitCode) {
  if (exitCode === 0) return false; // koştu ve cevap verdi
  const desc = typeof engineOrDesc === 'string' ? authDescriptor(engineOrDesc, { env: {} }) : engineOrDesc;
  const s = String(stdout || '');
  if (desc && desc.statusParse === 'text') return !/logged\s+in/i.test(s);
  // 'exit-code': sıfır-dışı çıkış MEŞRU bir "hayır" olabilir — ama yalnız motorun
  // KENDİ ölçülmüş girişsizlik cümlesi görülürse. Başka bir hata (komut yok, ağ)
  // "ölçemedim"dir ve rozet üçüncü durumu gösterir (ADP-893).
  if (desc && desc.statusParse === 'exit-code') {
    const rx = desc.signedOutPattern ? new RegExp(desc.signedOutPattern, 'i') : null;
    return !(rx && rx.test(s));
  }
  const a = s.indexOf('{');
  return !(a >= 0 && s.lastIndexOf('}') > a);
}

/** Motorun durum komutu (argv) — DEFTERDEN. Bilinmeyen motor/komutsuz akış → `null`. */
function statusArgv(engine, deps = {}) {
  const d = authDescriptor(engine, deps);
  return d && d.statusArgv ? [...d.statusArgv] : null;
}

/** Motorun giriş komutu (argv). Abonelik yolu olmayan akışta `null`. */
function loginArgv(engine, deps = {}) {
  const d = authDescriptor(engine, deps);
  return d && d.loginArgv ? [...d.loginArgv] : null;
}

/** Motorun çıkış komutu (argv). */
function logoutArgv(engine, deps = {}) {
  const d = authDescriptor(engine, deps);
  return d && d.logoutArgv ? [...d.logoutArgv] : null;
}

// ── API anahtarı deposu (ENG-08) ────────────────────────────────────────────

/**
 * `credentialVault` (ADP-584) üzerine ince bir motor-anahtarı görünümü.
 *
 * 🔒 İKİ ÇİZGİ, İKİSİ DE ENG-R3 §9.3'ten:
 *   • Anahtar VAULT'ta yaşar (safeStorage şifreli blob) — düz dosya YOK.
 *   • Anahtar yalnız ENV ile taşınır; hiçbir yolda argv'ye girmez (emsal
 *     agentRunner.js:1520-1525 — argv `ps` çıktısında herkese görünür).
 *
 * Vault kullanılamıyorsa (safeStorage kapalı) fonksiyonlar SESSİZ BAŞARI dönmez:
 * `{ok:false, error:'vault-unavailable'}` → UI dürüstçe "anahtar kaydedilemedi" der.
 */
function createVaultApiKeyStore(vault) {
  const guard = () => vault && typeof vault.isAvailable === 'function' && vault.isAvailable();
  return {
    hasKey(service) {
      try { return guard() ? vault.servicesSync().includes(service) : false; } catch { return false; }
    },
    readKey(service) {
      try {
        if (!guard()) return null;
        const r = vault.resolveSync(service, { env: null });
        return r && typeof r.secret === 'string' ? r.secret : null;
      } catch { return null; }
    },
    async saveKey(service, secret, opts = {}) {
      if (!guard()) return { ok: false, error: 'vault-unavailable' };
      try {
        // Tek anahtar: aynı servisin eski kayıtları düşer (iki kayıt = hangisi
        // koşuyor belirsizliği; `pickBest` sessizce ilkini seçerdi).
        for (const rec of await vault.list()) {
          if (rec.service === service) await vault.remove(rec.id);
        }
        await vault.add({ service, secret, authKind: 'api_key', env: null, keyLabel: opts.keyLabel || '' });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: maskSecrets(String((e && e.message) || 'vault-write-failed')) };
      }
    },
    async clearKey(service) {
      if (!guard()) return { ok: false, error: 'vault-unavailable' };
      try {
        let removed = false;
        for (const rec of await vault.list()) {
          if (rec.service === service) removed = (await vault.remove(rec.id)) || removed;
        }
        return { ok: true, removed };
      } catch (e) {
        return { ok: false, error: maskSecrets(String((e && e.message) || 'vault-write-failed')) };
      }
    },
  };
}

/** Bu çağrı için anahtar deposu (yoksa `null` — api-key yolu kapalı demektir). */
function apiKeyStoreOf(deps = {}) {
  if (deps.apiKeyStore) return deps.apiKeyStore;
  if (deps.vault) return createVaultApiKeyStore(deps.vault);
  return null;
}

/**
 * ENG-F4-01 — "burada giriş yapıldı" DEFTERİ dikişi (`electron/engineLoginLedger.cjs`).
 *
 * Dikiş bilerek üç fonksiyonluk küçük bir nesnedir (`has`/`record`/`clear`) ve
 * motor+profile ZATEN BAĞLIDIR: bu modüle ne `crewpaneHome` yolu ne `fs` sızar
 * (aynı desen `apiKeyStore` dikişinde de var). Dikiş VERİLMEZSE davranış
 * bugünküyle bit-bit aynıdır — defter bir KOLAYLIK, bir bağımlılık değil.
 */
function loginLedgerOf(deps = {}) {
  const l = deps.loginLedger;
  return l && typeof l.has === 'function' ? l : null;
}

/** Kayıtlı giriş var mı? Defter yoksa/patlarsa "yok" — kayıt akışı kıramaz. */
function hasLoginRecord(deps = {}) {
  const ledger = loginLedgerOf(deps);
  if (!ledger) return false;
  try { return ledger.has() === true; } catch { return false; }
}

/**
 * ENG-08 — bir motorun API anahtarının ENV KATKISI (spawn boğazı bunu kullanır).
 * Anahtarı olmayan/`apiKey` beyan etmeyen motorda `{}` → bugünkü davranış bit-bit aynı.
 * Dönen nesne SIR TAŞIR: yalnız childEnv'e konur, log'a/diske ASLA.
 */
function apiKeyEnvFor(engine, deps = {}) {
  const d = authDescriptor(engine, deps);
  if (!d || !d.apiKey) return {};
  const store = apiKeyStoreOf(deps);
  if (!store) return {};
  const secret = store.readKey(d.apiKey.vaultService);
  return secret ? { [d.apiKey.env]: secret } : {};
}

/**
 * Bir motorun oturum durumunu OKUR. ASLA reddetmez — hata = "bilinmiyor", çünkü
 * bu bir rozet; Ayarlar'ı bir probe hatası rehin alamaz.
 * → { engine, installed, loggedIn, method, account, plan, authKind, flow, …, error }
 */
async function readStatus(engine, deps = {}) {
  const desc = authDescriptor(engine, deps);
  const store = apiKeyStoreOf(deps);
  const base = {
    engine,
    label: desc ? desc.label : engine,
    accountHint: desc ? desc.accountHint : null,
    signupUrl: desc ? desc.signupUrl : null,
    needsCode: desc ? desc.needsCode : false,
    // ── ENG-08 yeni sözleşme alanları (UI `flow` enum'una göre çizer) ────────
    flow: desc ? desc.flow : null,
    /**
     * Abonelikle giriş MÜMKÜN mü? (`false` → rozet dürüstçe "anahtar ister" der)
     * ENG-17 — `device-code` de bir ABONELİK yoludur (kimi: CLI kodu GÖSTERİR,
     * kullanıcı tarayıcıda onaylar, CLI yoklar). Dışarıda bırakmak, abonelik yolu
     * OLAN bir motoru "yalnız anahtarla çalışır" diye göstermek olurdu.
     */
    supportsSubscription:
      !!desc && (desc.flow === 'oauth-code' || desc.flow === 'oauth-callback' || desc.flow === 'device-code'),
    /**
     * ENG-17 — kod STDIN'e mi yazılır, EKRANDA mı gösterilir? İkisi AYNI şey değil:
     * `oauth-code`ta UI bir kod KUTUSU çizmeli, `device-code`ta çizMEMELİ (kullanıcı
     * hiçbir şey yapıştırmaz; boş bir kutu akışın kilitlendiği izlenimi verir).
     */
    codeDisplayOnly: !!desc && desc.flow === 'device-code',
    /** ENG-17 — `external` akışında giriş komutunun NEDEN sürülmediği (descriptor beyanı). */
    externalNote: desc ? desc.externalNote || null : null,
    /**
     * ENG-CURSOR-APIKEY-01 — `external` akışta kullanıcının TERMİNALDE yazacağı giriş
     * komutu (ör. `cursor-agent login`). Kart özeti "motorun kendi komutuyla bağlanırsın"
     * diyordu ama komutu hiç GÖSTERMİYORDU; müşteri (Windows, 17.09) anahtar yolunda
     * kilitlenince elinde hiçbir ikinci yol kalmıyordu. Ürün bu komutu SÜRMEZ, YAZAR.
     */
    externalLoginCommand:
      desc && desc.flow === 'external' && Array.isArray(desc.loginArgv) && desc.loginArgv.length
        ? [desc.binName, ...desc.loginArgv].join(' ')
        : desc && desc.flow === 'external' && Array.isArray(desc.manualLoginArgv) && desc.manualLoginArgv.length
          ? [desc.binName, ...desc.manualLoginArgv].join(' ') // ENG-HONEST-CARD-01 — yazılır, sürülmez
          : null,
    /** API anahtarı YEDEĞİ var mı? (abonelik varken bile ikinci yol olabilir) */
    supportsApiKey: !!(desc && desc.apiKey),
    apiKeyEnv: desc && desc.apiKey ? desc.apiKey.env : null,
    apiKeyUrl: desc && desc.apiKey ? desc.apiKey.keyUrl || null : null,
    apiKeyLabel: desc && desc.apiKey ? desc.apiKey.keyLabel || null : null,
    /**
     * ENG-20 — ANAHTARIN GERÇEĞİ (kota/plan sınırı). Descriptor bu cümleyi ENG-14'ten
     * beri taşıyordu ama SÖZLEŞMEDE YOKTU → kullanıcı hiç görmüyordu. Ölçülen sonuç:
     * gemini ücretsiz katman anahtarı günlük kotaya takılıyor ve pane turu ORTASINDA
     * kesiliyor; kullanıcı bunu ancak terminaldeki İngilizce yığın izinden anlıyordu.
     * Rozet artık anahtar kutusunda bunu ÖNCEDEN söyler (ENG-09 "tahmin yok" değil,
     * ÖLÇÜLENİ söyle sözleşmesi).
     */
    apiKeyNote: desc && desc.apiKey ? desc.apiKey.note || null : null,
    /**
     * ENG-17 — ANAHTAR YOLU OLMAYAN MOTORUN BEYANI. `apiKeyNote` ile BİLEREK
     * karıştırılmadı: o alan anahtar KUTUSUNUN yanında çizilen uyarıdır ve kutu
     * yoksa anlamsızdır. Buradaki cümle "neden kutu yok"un cevabıdır (şema
     * `apiKey:null` için zaten gerekçe istiyordu — eksik olan onu SÖYLEMEKti).
     * Ölçülen örnek: crush'ta anahtar env'inin ADI SAĞLAYICIYA göre değişiyor
     * (ANTHROPIC_API_KEY / GEMINI_API_KEY / …) → tek kutu koymak yanlış olurdu.
     */
    noApiKeyNote: desc && !desc.apiKey ? desc.apiKeyNote || null : null,
    /**
     * ENG-16 — SATICI-BARINDIRILAN BEDAVA KAPI (Eren kararı 2026-08-18).
     * Bir motor GİRİŞSİZ de koşabiliyorsa (opencode ölçümü) rozet "bağlı değil"
     * demekle yetinemez: kullanıcının kodu O ANDA üçüncü tarafın sunucusundan
     * geçiyor olabilir. Üç alan da ÖLÇÜMDÜR, iyimserlik değil:
     *   • `vendorHosted` — true/false/**null (ölçülemedi)**
     *   • `vendorDisclosure` — kullanıcıya gösterilecek AÇIK cümle (descriptor'dan)
     *   • `vendorPolicy` — 'allow' (rozetle koşar) | 'block' (pane açılmaz)
     */
    vendorHosted: null,
    vendorLabel: null,
    vendorDisclosure: null,
    vendorPolicy: null,
    vendorBlockedHint: null,
    /**
     * ENG-HONEST-CARD-01 — bu motor satıcı-barındırılan kapı BEYAN EDİYOR mu?
     * `vendorHosted:null` iki şey olabiliyordu: "kapı yok" (claude) ve "kapı var,
     * ölçülemedi" (opencode, defter okunamadı). Rozet ikisine farklı cümle kurar;
     * ayrım bu bayrakla taşınır. Beyan etmeyen motorda `false`.
     */
    vendorGate: false,
    /** Anahtar KAYITLI mı (sır DEĞİL, yalnız bayrak). */
    apiKeySaved: false,
    /** ADP-936 — çoklu hesap yalnız kimliği izole edilebilen motorda AÇIK. */
    multiAccount: !!(desc && desc.identityEnv),
    installed: false,
    loggedIn: false,
    method: null,
    account: null,
    plan: null,
    /**
     * HATA-13 — hesabın ORGANİZASYONU. Aynı e-postayla iki abonelik (team koltuğu +
     * kişisel pro) mümkün; ayırt eden alan budur, e-posta DEĞİL. Ölçülemeyen motorda
     * `null` kalır ve UI hiçbir iddiada bulunmaz.
     */
    org: null,
    orgId: null,
    /** 'subscription' | 'api-key' | null (ölçemedik) */
    authKind: null,
    error: null,
  };
  if (!desc) return { ...base, error: 'unsupported-engine' };
  if (desc.apiKey && store) base.apiKeySaved = store.hasKey(desc.apiKey.vaultService);

  // ENG-16 — kapı beyan ETMEYEN motorda bu blok NO-OP (alanlar `null` kalır ve UI
  // hiçbir iddiada bulunmaz); beyan edenlerde durum defterden + diskten ÖLÇÜLÜR.
  if (engineBilling.vendorSpecOf(engine)) {
    base.vendorGate = true;
    const vh = engineBilling.vendorHostedState(engine, {
      env: deps.env || process.env,
      homedir: deps.homedir,
      settings: deps.settings,
      credentialsFile: deps.credentialsFile,
    });
    base.vendorHosted = vh.vendorHosted;
    base.vendorLabel = vh.vendorLabel;
    base.vendorDisclosure = vh.disclosure;
    base.vendorPolicy = vh.policy;
    base.vendorBlockedHint = vh.blockedHint;
  }

  const bin = await resolveBin(engine, deps);
  if (!bin || !bin.found) {
    // ADP-694 — "Kurulu değil" rozeti artık ÇIKMAZ SOKAK değil: yanına tek satır
    // kurulum komutu koyuyoruz (kopyalanabilir). Katalog TEK kaynak (engineInstall.cjs);
    // burada komut metni YENİDEN YAZILMAZ, yoksa iki yer sessizce ayrışır.
    // ADP-833 — komut PLATFORMA göre; ve "ölçemedim" ayrı bir hata (installed=null →
    // UI kurulum bloğunu göstermez, çünkü motor kurulu OLABİLİR).
    const unknown = bin && bin.state === 'unknown';
    const guide = engineInstall.installInfo(engine, { platform: deps.platform || process.platform });
    return {
      ...base,
      installed: unknown ? null : false,
      error: binErrorFor(bin),
      reason: (bin && bin.reason) || null,
      installUrl: (guide && guide.docsUrl) || engineCheck.INSTALL_HINTS[engine] || null,
      installCommand: (guide && guide.command) || null,
    };
  }

  // ENG-08 — ANAHTAR ENV'İ: `api-key` yolunda motorun durum komutu anahtarı
  // görmeden koşarsa "girişsiz" der. Anahtar ENV ile verilir, argv'ye ASLA.
  const statusEnv = { ...execEnv(deps), ...apiKeyEnvFor(engine, deps) };

  // Durum komutu OLMAYAN akış — İKİ AYRI durum, tek dal değil:
  //
  //   (a) `api-key`  → rozet KAYDA dayanır (anahtar vault'ta var mı) ama bunu
  //       SAKLAMAZ: `verified:false`, sahte yeşil YOK.
  //   (b) ENG-12 — abonelik akışı (oauth-*) ama motorun durum komutu GERÇEKTEN yok
  //       (copilot 1.0.80: `auth status` da `logout` da yok, ölçüldü). Burada
  //       `loggedIn:false` yazmak YALAN olurdu: giriş yapmış bir kullanıcıya
  //       "bağlı değil" demek [[ref_whatsapp_status_column_lies]] hatasının ta
  //       kendisi. Cevap ÜÇÜNCÜ durumdur: `loggedIn:null` + `statusUnknown:true`
  //       + descriptor'ın BEYANI (`statusNote`). Motor adına göre dal YOK —
  //       karar `flow` + `statusNote` verisinden çıkar.
  if (!desc.statusArgv) {
    if (desc.flow !== 'api-key') {
      return {
        ...base,
        installed: true,
        loggedIn: null, // BİLİNMİYOR — ne "bağlı" ne "bağlı değil"
        statusUnknown: true,
        statusNote: desc.statusNote,
        authKind: null,
        method: null,
        verified: false, // motorun kendi komutu YOK → çalıştığı ÖLÇÜLMEDİ
        // ENG-F4-01 — ÜÇÜNCÜ DURUMUN İKİNCİ YARISI. "Durum okunamıyor" tek başına
        // eksikti: ürünün KENDİ koşturduğu ve sıfır çıkışla biten giriş akışının
        // hafızası yoktu, o yüzden Eren copilot'ta OAuth'u bitirdikten SONRA da
        // (restart dahil) aynı cümleyi görüyordu. Bu bayrak bir HÜKÜM DEĞİL, bir
        // KAYITTIR: "giriş akışını burada koşturduk". Rozet buna "Bağlı" demez,
        // "Burada giriş yapıldı · doğrulanamadı" der — çünkü doğrulayacak komut yok.
        loginRecorded: hasLoginRecord(deps),
      };
    }
    return {
      ...base,
      installed: true,
      loggedIn: base.apiKeySaved,
      authKind: base.apiKeySaved ? 'api-key' : null,
      method: base.apiKeySaved ? 'API anahtarı' : null,
      verified: false, // motorun kendi komutu YOK → çalıştığı ÖLÇÜLMEDİ
    };
  }

  const exec = deps.execFile || execFile;
  const statusTarget = execTarget(bin, [...desc.statusArgv], deps);
  const result = await new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => done({ err: new Error('timeout'), stdout: '', code: null }), deps.timeoutMs || STATUS_TIMEOUT_MS);
    try {
      exec(statusTarget.file, statusTarget.argv,
        withVerbatim(statusTarget, { timeout: deps.timeoutMs || STATUS_TIMEOUT_MS, env: statusEnv }),
        (err, stdout, stderr) => {
          clearTimeout(timer);
          // codex "Not logged in" ÇIKIŞ 1 döner — bu bir hata değil, bir CEVAP.
          done({ err, stdout: `${stdout || ''}${stderr || ''}`, code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0) });
        });
    } catch (e) {
      clearTimeout(timer);
      done({ err: e, stdout: '', code: null });
    }
  });

  if (result.code === null) return { ...base, installed: true, error: 'probe-failed' };
  // ADP-893 semptom 2 — durum komutu KOŞAMADIYSA cevabı "bağlı değil" diye boyama.
  // Bozuk cmd.exe sarmalayıcısı yüzünden `codex login status` hiç çalışmıyordu; çıkış
  // sıfır-dışıydı ve metin ayrıştırıcı onu "Not logged in" CEVABI sanıyordu → abonesi
  // olan müşteriye rozet "bağlı değil" diyordu. Ölçememek bir cevap değildir.
  if (statusUnmeasured(desc, result.stdout, result.code)) {
    return { ...base, installed: true, error: 'probe-failed' };
  }
  const parsed = parseStatus(desc, result.stdout, result.code);
  return { ...base, installed: true, verified: true, ...parsed };
}

/** Tüm motorların durumu. Paralel, hiçbiri diğerini bloklamaz. */
async function readAllStatus(deps = {}) {
  const ids = deps.engines || authEngines(deps);
  const engines = await Promise.all(ids.map((id) => readStatus(id, deps)));
  return { engines };
}

// ── Giriş oturumu ───────────────────────────────────────────────────────────

/** stdout içinden ilk http(s) URL'ini çeker (giriş akışının authorize adresi). */
function extractUrl(text) {
  const m = String(text || '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').match(/https?:\/\/[^\s"'<>]+/);
  return m ? m[0] : null;
}

/** CLI "kodu yapıştır" istemini bastı mı? (claude akışı) */
function wantsCode(text) {
  return /paste\s+code|enter\s+(the\s+)?code|authorization\s+code/i.test(String(text || ''));
}

/**
 * Yönetilen giriş oturumu. main.js bunu tutar; renderer yalnız anlık-görüntü
 * (snapshot) görür — child handle'ı ASLA renderer'a geçmez.
 *
 * Durum makinesi:
 *   starting → awaiting-browser → [awaiting-code] → verifying → done
 *                              ↘ error / cancelled
 *
 * `onUpdate(snapshot)` her geçişte çağrılır (main → renderer push).
 */
function startLogin(engine, deps = {}) {
  const meta = authDescriptor(engine, deps);
  if (!meta) throw new Error(`unsupported engine: ${engine}`);
  // ENG-08 (Eren kuralı-4) — ABONELİK YOLU OLMAYAN motorda giriş akışı BAŞLATILMAZ.
  // Olmayan bir akışı "başlattık" gibi göstermek, kullanıcıyı hiç bitmeyecek bir
  // bekleyişe sokardı; UI bunun yerine anahtar formunu çizer (`supportsSubscription`).
  if (!meta.loginArgv) throw new Error(`engine has no subscription login flow: ${engine}`);

  const session = {
    id: deps.sessionId || `login-${engine}-${(deps.now ? deps.now() : Date.now())}`,
    engine,
    state: 'starting',
    url: null,
    needsCode: meta.needsCode,
    error: null,
    status: null,
  };

  const log = deps.log || (() => {});
  const listeners = [];
  const onUpdate = (fn) => { listeners.push(fn); };
  if (typeof deps.onUpdate === 'function') listeners.push(deps.onUpdate);

  /** Renderer'a giden TEK yüzey. Sır taşımaz: url dışında ham CLI çıktısı YOK. */
  const snapshot = () => ({
    id: session.id,
    engine: session.engine,
    state: session.state,
    url: session.url,
    needsCode: session.needsCode,
    error: session.error,
    status: session.status,
    // ENG-F4-01 — 🪤 BU ALAN YÜZEYDE YOKTU. `finish()` `unverified:true` YAZIYORDU
    // (aşağıda, ENG-12 dalı) ama snapshot onu taşımıyordu → renderer akışın
    // "doğrulanamadı" ile bittiğini HİÇ öğrenemiyordu ve kart, doğrulanmış bir
    // girişten ayırt edilemeyen sessiz bir 'done' gösteriyordu. Sinyal main'de
    // üretilip sınırda düşüyordu; taşımak tek satır.
    unverified: session.unverified === true,
  });

  let settled = false;
  const emit = () => { const s = snapshot(); for (const fn of listeners) { try { fn(s); } catch { /* dinleyici hatası akışı bozamaz */ } } };
  const transition = (state, patch = {}) => {
    if (settled) return;
    Object.assign(session, patch, { state });
    if (state === 'done' || state === 'error' || state === 'cancelled') settled = true;
    log(`engineAuth ${engine} → ${state}${session.error ? ` (${maskSecrets(session.error)})` : ''}`);
    emit();
  };

  let child = null;
  let timer = null;
  const spawnFn = deps.spawn || spawn;

  const finish = async (code) => {
    if (settled) return;
    clearTimeout(timer);
    // ⚠️ ÇIKIŞ KODUNA TEK BAŞINA GÜVENME: rozet gerçeği söylemek zorunda, o yüzden
    // her zaman motorun KENDİ durum komutuyla doğrula (T3'ün kalbi).
    transition('verifying');
    let status = null;
    try { status = await readStatus(engine, deps); } catch { status = null; }
    if (status && status.loggedIn) transition('done', { status });
    // ENG-12 — DURUM KOMUTU OLMAYAN motor (copilot): doğrulayacak bir komut YOK.
    // Burada 'error' demek, giriş GERÇEKTEN başarılıyken kullanıcıya "olmadı"
    // demektir — T3'ün kapattığı yalanın simetriği. Çıkış kodu 0 ise akış BİTTİ
    // sayılır ama `verified:false` ile: rozet "doğrulanamadı" der, "bağlı" demez.
    else if (status && status.statusUnknown && code === 0) {
      // ENG-F4-01 — AKIŞI KAYDA GEÇİR. Buraya gelindiyse giriş komutunu BİZ
      // koşturduk ve sıfır çıkışla bitti; motorun bunu teyit edecek bir durum
      // komutu YOK. Kayıt, ürünün bu olguyu bir sonraki açılışta da hatırlaması
      // içindir ("restart de düzeltmiyor" şikâyetinin kökü). Hüküm DEĞİL: rozet
      // yine "doğrulanamadı" der.
      const ledger = loginLedgerOf(deps);
      if (ledger && typeof ledger.record === 'function') {
        try { ledger.record(); } catch { /* defter bir kolaylık — akışı kıramaz */ }
      }
      transition('done', { status: { ...status, loginRecorded: true }, unverified: true });
    } else transition('error', { status, error: code === 0 ? 'giriş doğrulanamadı' : `giriş tamamlanmadı (çıkış ${code})` });
  };

  (async () => {
    const bin = await resolveBin(engine, deps);
    if (!bin || !bin.found) { transition('error', { error: binErrorFor(bin) }); return; }

    // ENG-08 — giriş komutu DEFTERDEN: `oauth-code` (URL + kod) ve `oauth-callback`
    // (localhost dinleyicisi) aynı kodu koşar; fark yalnız `needsCode` alanındadır.
    const argv = [...meta.loginArgv];
    const env = execEnv(deps);
    // Tarayıcıyı BİZ açacağız (shell.openExternal) — CLI'ın kendi açması iki sekme
    // demek olurdu. BROWSER'ı no-op'a çekmek ölçüldü: claude/codex ikisi de saygı
    // gösteriyor ve URL'i yine stdout'a basıyor. (ADP-833: Windows'ta POSIX yolu
    // yok → orada set EDİLMEZ, bkz. noopBrowserFor.)
    const noopBrowser = noopBrowserFor(deps);
    if (noopBrowser) env.BROWSER = noopBrowser;

    const target = execTarget(bin, argv, deps);
    try {
      child = spawnFn(target.file, target.argv, withVerbatim(target, { env, stdio: ['pipe', 'pipe', 'pipe'] }));
    } catch (e) {
      transition('error', { error: `başlatılamadı: ${e && e.message}` });
      return;
    }

    let buf = '';
    const onData = (d) => {
      buf += String(d);
      if (!session.url) {
        const url = extractUrl(buf);
        if (url) transition('awaiting-browser', { url });
      }
      // claude: URL'den SONRA kod istemi gelir. codex'te bu hiç basılmaz.
      if (session.url && meta.needsCode && wantsCode(buf) && session.state === 'awaiting-browser') {
        transition('awaiting-code');
      }
    };
    if (child.stdout) child.stdout.on('data', onData);
    if (child.stderr) child.stderr.on('data', onData);
    child.on('error', (e) => transition('error', { error: `çalıştırılamadı: ${e && e.message}` }));
    child.on('exit', (code) => { void finish(typeof code === 'number' ? code : -1); });

    timer = setTimeout(() => {
      if (settled) return;
      // PIPE-03 — platform dikişi İLETİLİR: `terminateTree` aksi hâlde host'a bakar
      // ve enjekte edilen POSIX dalı Windows'ta taskkill'e sapar (test sahte
      // çocuğunun `kill`i hiç çağrılmaz — nightly 33085246277, not ok 1171).
      terminateTree(child, { platform: deps.platform }); // ADP-835: win32'de ağaç
      transition('error', { error: 'zaman aşımı — giriş tamamlanmadı' });
    }, deps.loginTimeoutMs || LOGIN_TIMEOUT_MS);
  })().catch((e) => transition('error', { error: `beklenmeyen: ${e && e.message}` }));

  return {
    get id() { return session.id; },
    get engine() { return session.engine; },
    snapshot,
    onUpdate,
    /**
     * Tarayıcıdaki sayfanın verdiği KODU CLI'a iletir (yalnız claude akışı).
     * Kod hiçbir yere YAZILMAZ — doğrudan child stdin'ine akar ve unutulur.
     */
    submitCode(code) {
      if (settled || !child || !child.stdin) return { ok: false, error: 'oturum aktif değil' };
      const clean = String(code || '').trim();
      if (!clean) return { ok: false, error: 'kod boş' };
      try {
        child.stdin.write(`${clean}\n`);
        transition('completing');
        return { ok: true };
      } catch (e) {
        return { ok: false, error: `iletilemedi: ${e && e.message}` };
      }
    },
    cancel() {
      if (settled) return { ok: true };
      clearTimeout(timer);
      if (child) terminateTree(child, { platform: deps.platform }); // ADP-835: win32'de ağaç
      transition('cancelled');
      return { ok: true };
    },
  };
}

// ── Çıkış ───────────────────────────────────────────────────────────────────

/**
 * Oturumu kapatır ve SONUCU DOĞRULAR. Dönen `status` her zaman motorun kendi
 * komutundan okunur — "çıkış yaptık" varsayımıyla rozet boyanmaz.
 */
async function logout(engine, deps = {}) {
  const meta = authDescriptor(engine, deps);
  if (!meta) return { ok: false, error: 'unsupported-engine', status: null };
  // ENG-F4-01 — ÇIKIŞ KAYDI DA SİLER. "Burada giriş yapıldı" bir KAYITTIR; çıkış
  // yapıldıktan sonra ayakta kalması, rozeti bugün doğru olan tek şeyde
  // (dürüstlük) yanıltıcı yapardı. Sıra ÖNEMLİ: kayıt, aşağıdaki `readStatus`
  // çağrılarından ÖNCE silinir — yoksa dönen durum eski kaydı taşırdı.
  const ledger = loginLedgerOf(deps);
  if (ledger && typeof ledger.clear === 'function') {
    try { ledger.clear(); } catch { /* defter bir kolaylık — çıkışı kıramaz */ }
  }
  // ENG-08 — `api-key` akışında "çıkış" = ANAHTARI SİLMEK. Motorun çıkış komutu
  // yoktur; anahtar bizim vault'umuzda olduğu için oradan düşer, sonra DOĞRULANIR.
  if (!meta.logoutArgv) {
    if (meta.apiKey) {
      const store = apiKeyStoreOf(deps);
      const r = store ? await store.clearKey(meta.apiKey.vaultService) : { ok: false, error: 'vault-unavailable' };
      const status = await readStatus(engine, deps);
      return { ok: r.ok && !status.loggedIn, error: r.ok ? null : r.error, status };
    }
    return { ok: false, error: 'no-logout-flow', status: await readStatus(engine, deps) };
  }
  const bin = await resolveBin(engine, deps);
  if (!bin || !bin.found) return { ok: false, error: binErrorFor(bin), status: null };
  const exec = deps.execFile || execFile;
  const argv = [...meta.logoutArgv];
  const target = execTarget(bin, argv, deps);
  await new Promise((resolve) => {
    let settledOut = false;
    const done = () => { if (!settledOut) { settledOut = true; resolve(); } };
    const timer = setTimeout(done, deps.timeoutMs || STATUS_TIMEOUT_MS);
    try {
      exec(target.file, target.argv,
        withVerbatim(target, { timeout: deps.timeoutMs || STATUS_TIMEOUT_MS, env: execEnv(deps) }),
        () => { clearTimeout(timer); done(); });
    } catch { clearTimeout(timer); done(); }
  });
  const status = await readStatus(engine, deps);
  return { ok: !status.loggedIn, status };
}

// ── API anahtarı akışı (ENG-08 — YEDEK yol, asla tek yol) ───────────────────

/**
 * Motorun API anahtarını KAYDEDER ve SONUCU DOĞRULAR.
 *
 * Akış: doğrula → vault'a yaz → motorun KENDİ durum komutunu anahtar ENV'iyle koş.
 * Doğrulama başarısızsa anahtar GERİ ALINIR — yoksa Ayarlar "kayıtlı" derken motor
 * çalışmaz ve kullanıcı çözümü olmayan bir döngüye girer ([[ref_whatsapp_status_column_lies]]).
 *
 * 🔒 Anahtar: vault'a yazılır, ENV ile probe'a verilir. argv'ye ASLA girmez ve
 * dönen hiçbir alanda taşınmaz (`maskSecrets` log yolunu da kapatır).
 */
/**
 * ENG-CURSOR-APIKEY-01 — motorun KENDİ ret cümlesini kullanıcıya taşınabilir hâle getirir.
 * Saf. ANSI renk kodları, öncü uyarı simgeleri (⚠ ✗ ✓) ve "Warning:/Error:" etiketi
 * atılır; ilk dolu satır alınır; 160 karakterde kesilir. Sır süzgeci ÇAĞIRANDA
 * (`maskSecrets`) — çıktıya anahtarın kendisi düşmüş olsa bile UI'a sızmaz.
 */
function engineMessageOf(output) {
  const lines = String(output || '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s⚠✗✓×!•·-]+/u, '').replace(/^(warning|error)\s*:\s*/i, '').trim())
    .filter(Boolean);
  if (!lines.length) return null;
  const first = lines[0];
  return first.length > 160 ? `${first.slice(0, 157)}…` : first;
}

/**
 * ENG-CURSOR-APIKEY-01 — anahtarı motorun `apiKeyVerifyArgv` komutuyla DOĞRULAR.
 * Ölçüt çıkış kodu: 0 = kabul, sıfır-dışı = ret (+ motorun cümlesi), koşamadı = null.
 * Anahtar ENV ile gider (argv'ye ASLA). Descriptor komut beyan etmiyorsa `null` döner
 * ve çağıran eski yola (`readStatus`) düşer — diğer motorlarda davranış bit-bit aynı.
 * → { ok, code, message } | null
 */
async function verifyApiKey(engine, deps = {}) {
  const desc = authDescriptor(engine, deps);
  if (!desc || !desc.apiKey || !desc.apiKeyVerifyArgv) return null;
  const bin = await resolveBin(engine, deps);
  if (!bin || !bin.found) return { ok: false, code: null, message: null, error: binErrorFor(bin) };
  const exec = deps.execFile || execFile;
  const target = execTarget(bin, [...desc.apiKeyVerifyArgv], deps);
  const env = { ...execEnv(deps), ...apiKeyEnvFor(engine, deps) };
  const timeoutMs = deps.verifyTimeoutMs || deps.timeoutMs || STATUS_TIMEOUT_MS;
  const result = await new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => done({ err: new Error('timeout'), stdout: '', code: null }), timeoutMs);
    try {
      exec(target.file, target.argv, withVerbatim(target, { timeout: timeoutMs, env }), (err, stdout, stderr) => {
        clearTimeout(timer);
        done({ err, stdout: `${stdout || ''}${stderr || ''}`, code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0) });
      });
    } catch (e) {
      clearTimeout(timer);
      done({ err: e, stdout: '', code: null });
    }
  });
  if (result.code === null) return { ok: false, code: null, message: null, error: 'probe-failed' };
  const message = result.code === 0 ? null : maskSecrets(engineMessageOf(result.stdout) || '') || null;
  return { ok: result.code === 0, code: result.code, message, error: result.code === 0 ? null : 'key-rejected' };
}

async function setApiKey(engine, key, deps = {}) {
  const desc = authDescriptor(engine, deps);
  const log = deps.log || (() => {});
  if (!desc) return { ok: false, error: 'unsupported-engine', status: null };
  if (!desc.apiKey) return { ok: false, error: 'no-api-key-flow', status: null };
  const clean = typeof key === 'string' ? key.trim() : '';
  if (!clean) return { ok: false, error: 'empty-key', status: null };
  const store = apiKeyStoreOf(deps);
  if (!store) return { ok: false, error: 'vault-unavailable', status: null };

  const service = desc.apiKey.vaultService;
  const previous = store.readKey(service); // geri alma için (sır bellekte kalır, diske değil)
  const saved = await store.saveKey(service, clean, { keyLabel: desc.apiKey.keyLabel || desc.label });
  if (!saved.ok) return { ok: false, error: saved.error || 'vault-write-failed', status: null };

  // ENG-CURSOR-APIKEY-01 — motor anahtarı okuyan AYRI bir doğrulama komutu beyan
  // ediyorsa hüküm ORADAN gelir; `readStatus` yalnız dönen rozeti tazeler. (cursor:
  // `status` anahtarı hiç okumuyordu → geçerli anahtar da her seferinde reddediliyordu.)
  const verify = await verifyApiKey(engine, deps);
  if (verify && !verify.ok) {
    if (previous) await store.saveKey(service, previous, { keyLabel: desc.apiKey.keyLabel || desc.label });
    else await store.clearKey(service);
    log(maskSecrets(`engineAuth ${engine} api-key DOĞRULANAMADI (${verify.error}, rc=${verify.code}) → geri alındı`));
    return { ok: false, error: verify.error, engineMessage: verify.message, status: await readStatus(engine, deps) };
  }

  const status = await readStatus(engine, deps);
  if (status.loggedIn || (verify && verify.ok)) {
    // Log'a yalnız SONUÇ girer; anahtarın kendisi hiçbir satıra düşmez.
    log(maskSecrets(`engineAuth ${engine} api-key kaydedildi ve doğrulandı (env=${desc.apiKey.env})`));

    // F8: Antigravity — settings.json'a modelProvider yazması gerekli
    if (engine === 'antigravity') {
      const home = process.env.HOME || process.env.USERPROFILE || '';
      const configDir = path.join(home, '.gemini', 'antigravity-cli');
      const configFile = path.join(configDir, 'settings.json');
      try {
        await fs.mkdir(configDir, { recursive: true });
        const settings = { modelProvider: 'gemini' };
        await fs.writeFile(configFile, JSON.stringify(settings, null, 2), 'utf8');
        log(`antigravity settings.json yazıldı: ${configFile}`);
      } catch (e) {
        log(`antigravity settings.json yazma hatası: ${e.message}`);
      }
    }

    return { ok: true, status };
  }
  // Doğrulanmadı → eski hâle dön (yoksa "kayıtlı ama çalışmıyor" sessiz yalanı kalır).
  if (previous) await store.saveKey(service, previous, { keyLabel: desc.apiKey.keyLabel || desc.label });
  else await store.clearKey(service);
  log(maskSecrets(`engineAuth ${engine} api-key DOĞRULANAMADI → geri alındı`));
  return { ok: false, error: status.error || 'key-rejected', engineMessage: null, status: await readStatus(engine, deps) };
}

/** Kayıtlı API anahtarını siler ve sonucu motorun durum komutuyla DOĞRULAR. */
async function clearApiKey(engine, deps = {}) {
  const desc = authDescriptor(engine, deps);
  if (!desc) return { ok: false, error: 'unsupported-engine', status: null };
  if (!desc.apiKey) return { ok: false, error: 'no-api-key-flow', status: null };
  const store = apiKeyStoreOf(deps);
  if (!store) return { ok: false, error: 'vault-unavailable', status: null };
  const r = await store.clearKey(desc.apiKey.vaultService);
  const status = await readStatus(engine, deps);
  return { ok: r.ok, error: r.ok ? null : r.error, status };
}

module.exports = {
  AUTH_ENGINES,
  ENGINE_AUTH_META,
  LOGIN_TIMEOUT_MS,
  STATUS_TIMEOUT_MS,
  maskSecrets,
  // ENG-08 — descriptor hunisi
  authDescriptor,
  authEngines,
  envDescriptors,
  parseJsonStatus,
  parseTextStatus,
  parseStatus,
  authKindOf,
  // ADP-597 adları (geriye-uyum köprüsü)
  parseClaudeStatus,
  parseCodexStatus,
  statusArgv,
  loginArgv,
  logoutArgv,
  statusUnmeasured,
  extractUrl,
  wantsCode,
  readStatus,
  readAllStatus,
  startLogin,
  logout,
  // ENG-08 — api-key yolu
  createVaultApiKeyStore,
  apiKeyEnvFor,
  // ENG-CURSOR-APIKEY-01
  engineMessageOf,
  verifyApiKey,
  setApiKey,
  clearApiKey,
};
