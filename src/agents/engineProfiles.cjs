// ADP-936 (ADR-MULTI-ACCOUNT-SWITCH Faz 1) — AI MOTORU HESAP PROFİLLERİ.
//
// NİYET: kullanıcının BİRDEN ÇOK kendi aboneliği olabilir (iki Claude hesabı) ve
// biri limite takılınca ötekiyle devam edebilmeli. Bu modül o hesapların
// DEFTERİdir — jetonun kendisi burada YOK.
//
// ── ADP-934 SPİKE'İNİN ÖLÇÜLMÜŞ KALDIRACI ─────────────────────────────────
// `claude` 2.1.223 kimlik deposunun Keychain kayıt ADINI config dizininden
// TÜRETİYOR: `Claude Code-credentials-<sha256(dizin)[0:8]>`. Yani izolasyon bir
// kaza değil, CLI'ın tasarım gereği desteklediği bir şey. İki değişken var ve
// BAĞIMSIZ ölçüldüler:
//   • CLAUDE_CONFIG_DIR              → kimlik + `projects/` (transkript!) + ayarlar
//   • CLAUDE_SECURESTORAGE_CONFIG_DIR → YALNIZ kimlik
// İKİNCİSİ seçildi: transkriptler kanonik `~/.claude/projects`ta paylaşımlı kalır
// ⇒ "A limitte, B ile DEVAM ET" (`--resume`) kutudan çıktığı gibi çalışır ve
// `~/.claude/projects`i sabit yazan 6 tüketici (resumeTmux, resumePaneRegistry,
// mobileTranscript, paneSessionsJournal, modelDetect, firstRunDoctor) HİÇ
// değişmez → sıfır regresyon yüzeyi. (ADR §4-§5)
// codex tarafında kaldıraç `CODEX_HOME` (agentRunner zaten OKUYOR, set etmiyordu).
//
// ── GÜVENLİK ÇİZGİLERİ ────────────────────────────────────────────────────
//  • Jeton BİZDE DEĞİL: her profil CLI'ın KENDİ deposunda (macOS Keychain /
//    düz dosya) ayrı bir yuva alır. ADP-584 vault'una kopyalanmaz, env ile
//    enjekte EDİLMEZ (CLAUDE_CODE_OAUTH_TOKEN yolu ADR §5-C'de REDDEDİLDİ:
//    "üçüncü-parti harness'ta OAuth jetonu" Anthropic'in askı deseni + o yolda
//    refreshToken null olduğu için oturum kendini yenileyemiyor).
//    Bizim tuttuğumuz tek şey İŞARETÇİ: profileId → dizin.
//  • Renderer YOL SEÇEMEZ: dışarı yalnız `profileId` çıkar; dizini bu modül
//    çözer, `PROFILE_ID_RE` ile doğrular ve sonucun crewpane home'unun ALTINDA
//    kaldığını ölçer (symlink/`..` kaçışı yok). `trusted` deseni: main-only.
//  • VARSAYILAN PROFİL = env HİÇ SET EDİLMEZ. Bugünkü tek-hesap kullanıcı için
//    davranış bit-bit aynı kalır; göç yok, geri dönüş yok.
//
// Saf-ish: bütün IO best-effort + korumalı; bozuk/eksik dosya → VARSAYILAN
// (asla fırlatmaz), çünkü bir defter hatası uygulamayı açılmaz yapamaz.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteFileSync } = require('../../platform/atomicWrite.cjs');

/** Profil deposunun kök klasör adı: `<crewpaneHome>/engines/<motor>/<profil>/`. */
const PROFILES_DIRNAME = 'engines';
/** Defter dosyası (yalnız İŞARETÇİ + tercih; sır YOK). */
const REGISTRY_FILE = 'engine-profiles.json';
/** Kanonik profil: env HİÇ set edilmez → bugünkü davranış. */
const DEFAULT_PROFILE_ID = 'default';
/** Renderer'dan gelebilecek tek tanımlayıcı — dizin adı olarak da güvenli. */
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Kullanıcı etiketi için üst sınır (UI'da tek satır). */
const MAX_LABEL_LEN = 40;
/** Bir motorda tutulabilecek profil sayısı (varsayılan dahil) — kazara şişmeyi keser. */
const MAX_PROFILES_PER_ENGINE = 8;
/** ACCT-FIX-01 — kimlik damgası alanlarının üst uzunluğu (defter şişmesin, UI tek satır). */
const MAX_IDENTITY_FIELD_LEN = 120;
/** ACCT-FIX-01 — damganın nereden geldiği: giriş akışı mı, tek-girişli geriye doldurma mı. */
const IDENTITY_SOURCES = Object.freeze(['login', 'backfill']);

/**
 * Hangi motor hangi env değişkeniyle KİMLİĞİ ayrıştırır.
 *
 * ENG-08 — bu harita artık DEFTERDEN türer (`engineRegistry.identityEnv`); eskiden
 * elle yazılıydı ve ENG-R3 §1.3'ün saydığı "8 elle-senkron defter"den biriydi.
 * `identityEnv: null` beyan eden motor buraya HİÇ GİRMEZ: kimliği izole edilemeyen
 * bir motorda ikinci hesap birincinin yuvasını EZER (veri kaybı) — o yüzden
 * `isEngine()` orada `false` döner ve UI "Hesap ekle"yi hiç göstermez.
 */
const ENGINE_IDENTITY_ENV = Object.freeze(Object.fromEntries(
  require('./engineRegistry.cjs')
    .engineIds()
    .map((id) => [id, require('./engineRegistry.cjs').capability(id, 'identityEnv')])
    .filter(([, env]) => typeof env === 'string' && env.length > 0),
));

const ENGINES = Object.freeze(Object.keys(ENGINE_IDENTITY_ENV));

// ── Saf yardımcılar ─────────────────────────────────────────────────────────

/** Geçerli bir profil kimliği mi? (dizin adı olarak da kullanılır) */
function isProfileId(id) {
  return typeof id === 'string' && PROFILE_ID_RE.test(id);
}

/** Desteklenen motor mu? */
function isEngine(engine) {
  return typeof engine === 'string' && Object.prototype.hasOwnProperty.call(ENGINE_IDENTITY_ENV, engine);
}

/** Motorun kimlik-izolasyon env anahtarı (bilinmeyen motor → null). */
function identityEnvKey(engine) {
  return isEngine(engine) ? ENGINE_IDENTITY_ENV[engine] : null;
}

/** Kullanıcı etiketini normalize eder (boş → null). */
function sanitizeLabel(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_LEN);
  return t || null;
}

/**
 * E-postayı LOG için maskeler. UI e-postayı AÇIK gösterir (kullanıcı iki hesabını
 * ayırt edebilmeli; e-posta bir sır değil) — ama log/transcript kalıcıdır ve
 * paylaşılır, orada kısaltılmış hâli yeter (ADR §7.4). Saf.
 */
function maskAccount(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) return '';
  const at = s.lastIndexOf('@');
  if (at <= 0) return `${s.slice(0, 2)}…`;
  const user = s.slice(0, at);
  const domain = s.slice(at);
  return `${user.slice(0, 2)}…${domain}`;
}

/** Bir sonraki serbest profil kimliği (`profile-2`, `profile-3`, …). Saf. */
function nextProfileId(existingIds) {
  const taken = new Set(Array.isArray(existingIds) ? existingIds : []);
  for (let n = 2; n < 2 + MAX_PROFILES_PER_ENGINE + 1; n++) {
    const id = `profile-${n}`;
    if (!taken.has(id)) return id;
  }
  return null;
}

/**
 * ACCT-FIX-01 — KİMLİK DAMGASI (RESEARCH-ACCT-01 §3.2-3.3 ölçümü).
 *
 * `claude auth status --json`ın `email/orgId/orgName` alanları PAYLAŞIMLI
 * `~/.claude.json`dan gelir (yalnız `CLAUDE_CONFIG_DIR` ile ayrışır — biz onu
 * BİLEREK set etmiyoruz, transkript paylaşımlı kalsın diye). Yani iki profil
 * de her okumada SON giriş yapan hesabın e-postasını döner: iki farklı hesap
 * "aynı" görünür, kopya uyarısı yanlış yanar, etiket zamanla değişir.
 *
 * Çözüm: kimlik GİRİŞ ANINDA (o an dosyayı yazan profil kendisidir) bir kez
 * okunur ve DEFTERE yazılır; Ayarlar/rozet/kopya uyarısı bundan sonra bu damgayı
 * gösterir, durum komutu yalnız `loggedIn` için okunur. Damga sır DEĞİLDİR
 * (e-posta + org adı/uuid + plan) — jeton taşımaz.
 *
 * Aşağıdakiler SAF: normalize (defter okuma/yazma) ve durum → damga türetimi.
 */
function sanitizeIdentityField(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(/[\r\n\t]+/g, ' ').trim().slice(0, MAX_IDENTITY_FIELD_LEN);
  return t || null;
}

/** Ham damgayı normalize eder; e-posta VE orgId ikisi de yoksa `null` (boş damga yazılmaz). */
function normalizeIdentity(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const email = sanitizeIdentityField(raw.email);
  const orgId = sanitizeIdentityField(raw.orgId);
  if (!email && !orgId) return null;
  return {
    email,
    orgId,
    orgName: sanitizeIdentityField(raw.orgName),
    plan: sanitizeIdentityField(raw.plan),
    capturedAt: typeof raw.capturedAt === 'number' && Number.isFinite(raw.capturedAt) ? raw.capturedAt : null,
    source: IDENTITY_SOURCES.includes(raw.source) ? raw.source : 'login',
  };
}

/**
 * engineAuth.readStatus çıktısından damga türetir. `loggedIn` değilse `null`:
 * girişsiz bir okumanın e-postası (paylaşımlı dosyanın artığı) KİMLİK DEĞİLDİR.
 */
function identityFromStatus(status, { now = Date.now(), source = 'login' } = {}) {
  const s = status && typeof status === 'object' ? status : null;
  if (!s || s.loggedIn !== true) return null;
  return normalizeIdentity({
    email: s.account,
    orgId: s.orgId,
    orgName: s.org,
    plan: s.plan,
    capturedAt: now,
    source,
  });
}

/**
 * ACCT-FIX-01 — GERİYE DOLDURMA KURALI (saf). Bu özellikten ÖNCE giriş yapmış kutular
 * damgasızdır. Motorun bu kurulumda TAM OLARAK BİR girişli profili varsa paylaşımlı
 * dosyadaki e-posta/org ancak o profile ait olabilir → o profilin indeksi döner.
 * İki girişli profil varsa (hangisinin olduğu ölçülemez) ya da tek girişli zaten
 * damgalıysa `-1`: TAHMİN YOK.
 * @param {Array<{identity?:object|null}>} list  defter sırası
 * @param {Array<{loggedIn?:boolean}|null>} statuses  aynı sırayla durumlar
 */
function backfillIndex(list, statuses) {
  const rows = Array.isArray(list) ? list : [];
  const st = Array.isArray(statuses) ? statuses : [];
  const loggedIn = rows.map((_, i) => (st[i] && st[i].loggedIn === true ? i : -1)).filter((i) => i >= 0);
  if (loggedIn.length !== 1) return -1;
  const i = loggedIn[0];
  return rows[i] && rows[i].identity ? -1 : i;
}

/**
 * ACCT-FIX-01 — ANLIK-GÖRÜNTÜ SATIRI (saf). Renderer'a giden profil satırı; kimlik
 * alanları (account/org/orgId/plan) DAMGADAN gelir (varsa), `loggedIn` ve öteki
 * alanlar motorun durum komutundan. main.js `engineAccountsSnapshot` ve tarayıcı
 * harness'ı AYNI fonksiyonu çağırır → ekranın gördüğü satır burada üretilir.
 * @param {object} p       listProfiles satırı ({id,label,isDefault,identity})
 * @param {object|null} s  engineAuth.readStatus çıktısı (null = prob başarısız)
 * @param {string} active  motorun aktif profil kimliği
 */
function profileRow(p, s, active) {
  const idn = p && p.identity && typeof p.identity === 'object' ? p.identity : null;
  return {
    id: p.id,
    label: p.label,
    isDefault: p.isDefault === true || p.id === DEFAULT_PROFILE_ID,
    active: p.id === active,
    /** damga meta'sı (alanların kaynağı); null = damga yok, alanlar durum komutundan */
    identity: idn ? { capturedAt: idn.capturedAt, source: idn.source } : null,
    // 🔑 Rozet DURUM KOMUTUNDAN türer (ENG-UX-B2/T2: `null` = ölçülemedi, `false` değil).
    loggedIn: s ? (s.loggedIn === undefined ? null : s.loggedIn) : null,
    account: idn ? idn.email : (s && typeof s.account === 'string' ? s.account : null),
    plan: idn && idn.plan ? idn.plan : (s && typeof s.plan === 'string' ? s.plan : null),
    method: s && typeof s.method === 'string' ? s.method : null,
    org: idn ? idn.orgName : (s && typeof s.org === 'string' ? s.org : null),
    orgId: idn ? idn.orgId : (s && typeof s.orgId === 'string' ? s.orgId : null),
    statusUnknown: s ? s.statusUnknown === true : false,
    verified: s && s.verified !== undefined ? s.verified : null,
    loginRecorded: s ? s.loginRecorded === true : false,
    authKind: s && typeof s.authKind === 'string' ? s.authKind : null,
    apiKeySaved: s ? s.apiKeySaved === true : false,
    statusNote: s && typeof s.statusNote === 'string' ? s.statusNote : null,
    error: s ? s.error || null : 'probe-failed',
  };
}

/**
 * HATA-13 — BİR HESABIN KİMLİĞİ. E-POSTA TEK BAŞINA KİMLİK DEĞİLDİR.
 *
 * Ölçüldü (Discord bildirimi 04.09, canlı yayın izleyicisi): aynı e-posta hem bir
 * TEAM organizasyonunun koltuğu hem de KİŞİSEL bir pro aboneliği olabilir. `claude
 * auth status` bunu `orgId`/`orgName` ile ayırır; ürün o alanları atıyordu ve
 * Ayarlar'da iki ÖZDEŞ satır çiziyordu ("hangisi aktif anlayamıyorum").
 *
 * Kimlik = hesap + organizasyon. Organizasyon ölçülemediyse (codex ailesi) plan'a
 * düşülür; hiçbiri yoksa `null` döner — ÖLÇEMEDİĞİMİZ şeye "aynı hesap" DEMEYİZ.
 * Saf.
 */
function accountIdentityKey(status) {
  const s = status && typeof status === 'object' ? status : {};
  const acct = typeof s.account === 'string' ? s.account.trim().toLowerCase() : '';
  const org = typeof s.orgId === 'string' && s.orgId.trim()
    ? s.orgId.trim().toLowerCase()
    : (typeof s.org === 'string' ? s.org.trim().toLowerCase() : '');
  const plan = typeof s.plan === 'string' ? s.plan.trim().toLowerCase() : '';
  const tail = org || plan;
  if (!acct && !tail) return null;
  return `${acct}|${tail}`;
}

/**
 * HATA-13 — AYNI KİMLİĞE İKİNCİ KUTU. Kimlik ancak GİRİŞTEN SONRA ölçülebildiği
 * için "ekle" anında engellenemez; ölçüldüğü anda SÖYLENİR: ikinci satır ilkine
 * işaret eder (`duplicateOf`) ve UI "bu hesap zaten ekli" der. Sessizce iki özdeş
 * satır bırakmak, kullanıcıyı tam olarak bildirimdeki yere düşürüyordu.
 *
 * Girdi sırası defter sırasıdır → İLK kutu "asıl", sonrakiler kopya. Saf.
 */
function markDuplicateAccounts(rows) {
  const seen = new Map();
  return (Array.isArray(rows) ? rows : []).map((r) => {
    const key = accountIdentityKey(r);
    if (!key) return { ...r, duplicateOf: null };
    if (seen.has(key)) return { ...r, duplicateOf: seen.get(key) };
    seen.set(key, r && r.id);
    return { ...r, duplicateOf: null };
  });
}

/**
 * HATA-13 — BOŞ KUTUYU YENİDEN KULLAN. "Hesap ekle" her tıklamada yeni bir dizin
 * açıyordu; giriş yarıda kalınca kullanıcıda hiç girilmemiş `profile-3`, `profile-4`
 * kutuları birikiyor ve liste anlaşılmaz hâle geliyordu. Varsayılan DIŞI, girişi
 * OLMAYAN ilk kutu varsa yenisi açılmaz — o kutuya giriş akışı sürülür. Saf.
 */
function firstEmptyProfileId(rows) {
  const r = (Array.isArray(rows) ? rows : []).find(
    (x) => x && x.id && x.id !== DEFAULT_PROFILE_ID && x.loggedIn !== true,
  );
  return r ? r.id : null;
}

// ── Yol çözümü (containment kapısı) ─────────────────────────────────────────

/** `<home>/engines` — profil dizinlerinin kökü. */
function profilesRoot(home) {
  return path.join(String(home || ''), PROFILES_DIRNAME);
}

/**
 * Bir profilin kimlik dizini. VARSAYILAN profil için `null` döner — çünkü onun
 * için env HİÇ set edilmez (kanonik `~/.claude` / `~/.codex`).
 *
 * 🔒 Çözülen yol home'un ALTINDA olmak ZORUNDA: `profileId` renderer'dan gelebilir
 * ve `PROFILE_ID_RE` `..`/`/` kabul etmese bile ikinci kapı ucuzdur. Kaçış varsa
 * `null` (çağıran "profil yok" gibi davranır → varsayılan yuva).
 */
function profileDir(home, engine, profileId) {
  if (!home || !isEngine(engine)) return null;
  if (profileId === DEFAULT_PROFILE_ID || !isProfileId(profileId)) return null;
  const root = path.resolve(profilesRoot(home));
  const dir = path.resolve(path.join(root, engine, profileId));
  if (dir !== root && !dir.startsWith(root + path.sep)) return null;
  return dir;
}

/** Dizini 0700 ile oluşturur (best-effort). Başarılıysa yolu, değilse null döner. */
function ensureProfileDir(home, engine, profileId) {
  const dir = profileDir(home, engine, profileId);
  if (!dir) return null;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  } catch {
    return null;
  }
}

// ── Defter (registry) ───────────────────────────────────────────────────────

function registryPath(home) {
  return path.join(String(home || ''), REGISTRY_FILE);
}

/** Boş defter — varsayılan profil HER ZAMAN örtük olarak vardır. */
function emptyRegistry() {
  return { version: 1, autoSwitchOnLimit: false, engines: {} };
}

/**
 * Ham defteri normalize eder: bilinmeyen motor/profil düşer, varsayılan profil
 * her motorun listesinde İLK sırada garanti edilir, `active` listede yoksa
 * varsayılana düşer. Saf (IO yok) → test edilebilir.
 */
function normalizeRegistry(raw) {
  const out = emptyRegistry();
  // 🪤 Eksik/bozuk girdide ERKEN DÖNMEK yasak: `engines` boş kalırdı ve her
  // okuyucu `reg.engines[motor].profiles` üzerinde patlardı. Normalize edilmiş
  // defter HER motor için her zaman bir kayıt taşır (varsayılan profil örtük).
  const src0 = raw && typeof raw === 'object' ? raw : {};
  out.autoSwitchOnLimit = src0.autoSwitchOnLimit === true;
  const engines = src0.engines && typeof src0.engines === 'object' ? src0.engines : {};
  for (const engine of ENGINES) {
    const src = engines[engine] && typeof engines[engine] === 'object' ? engines[engine] : {};
    const seen = new Set([DEFAULT_PROFILE_ID]);
    // ACCT-FIX-01 — varsayılan profilin de damgası olabilir (ana hesap girişi de
    // CrewPane'ten yapılır); `default` satırı ham listede geçiyorsa yalnız damgası okunur.
    const rawDefault = (Array.isArray(src.profiles) ? src.profiles : []).find((p) => p && p.id === DEFAULT_PROFILE_ID);
    const profiles = [{
      id: DEFAULT_PROFILE_ID,
      label: null,
      createdAt: null,
      identity: normalizeIdentity(rawDefault && rawDefault.identity),
    }];
    const rawList = Array.isArray(src.profiles) ? src.profiles : [];
    for (const p of rawList) {
      if (!p || typeof p !== 'object') continue;
      const id = p.id;
      if (!isProfileId(id) || id === DEFAULT_PROFILE_ID || seen.has(id)) continue;
      if (profiles.length >= MAX_PROFILES_PER_ENGINE) break;
      seen.add(id);
      profiles.push({
        id,
        label: sanitizeLabel(p.label),
        createdAt: typeof p.createdAt === 'number' && Number.isFinite(p.createdAt) ? p.createdAt : null,
        // ACCT-FIX-01 — giriş anında okunan kimlik damgası (yoksa null; sır yok).
        identity: normalizeIdentity(p.identity),
      });
    }
    const active = isProfileId(src.active) && seen.has(src.active) ? src.active : DEFAULT_PROFILE_ID;
    out.engines[engine] = { active, profiles };
  }
  return out;
}

/** Defteri okur. Eksik/bozuk dosya → normalize edilmiş BOŞ defter (asla fırlatmaz). */
function readRegistry(home) {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(registryPath(home), 'utf8'));
  } catch {
    raw = null;
  }
  return normalizeRegistry(raw);
}

/**
 * Defteri yazar (atomik, 0600). Yalnız İŞARETÇİ taşır — sır yazılmaz, o yüzden
 * ayrı bir kripto katmanı YOK (ADP-584: "en güvenli sır, hiç sahip olmadığın sır").
 */
function writeRegistry(home, reg) {
  const clean = normalizeRegistry(reg);
  try {
    atomicWriteFileSync(registryPath(home), `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

// ── Okuma yüzeyi ────────────────────────────────────────────────────────────

/** Motorun profil listesi (varsayılan dahil, her zaman en az 1 kayıt). */
function listProfiles(home, engine) {
  if (!isEngine(engine)) return [];
  return readRegistry(home).engines[engine].profiles.map((p) => ({ ...p, isDefault: p.id === DEFAULT_PROFILE_ID }));
}

/** Motorun AKTİF profil kimliği (hiç yazılmamışsa `default`). */
function activeProfileId(home, engine) {
  if (!isEngine(engine)) return DEFAULT_PROFILE_ID;
  return readRegistry(home).engines[engine].active;
}

/** "Limitte otomatik geç" tercihi (varsayılan: KAPALI — ADR §11/1). */
function autoSwitchOnLimit(home) {
  return readRegistry(home).autoSwitchOnLimit === true;
}

// ── Env enjeksiyonu — TEK BOĞAZ ─────────────────────────────────────────────

/**
 * Bir profilin env KATKISI. Varsayılan profil → `{}` (env'e HİÇ dokunulmaz).
 * Bilinmeyen motor/profil ya da containment kapısına takılan yol → `{}`.
 *
 * 🔑 Varsayılanın `{}` olması bilinçli: bugünkü kullanıcıda bu modül devreye
 * girse bile childEnv BİT-BİT aynı kalır. Ayrıca `CODEX_HOME`u varsayılanda
 * SİLMİYORUZ — agentRunner'ın açıkça koruduğu test/izole-home dikişi (buildSpawn
 * yorumu: "childEnv carries any CODEX_HOME override") kırılırdı.
 */
function envForProfile(home, engine, profileId) {
  const key = identityEnvKey(engine);
  if (!key) return {};
  const dir = profileDir(home, engine, profileId);
  if (!dir) return {};
  return { [key]: dir };
}

/**
 * Bir taban env'in ÜSTÜNE profil env'ini uygular ve YENİ nesne döndürür (girdi
 * mutasyona uğramaz). Varsayılan profilde taban aynen kopyalanır.
 *
 * Kullanım: engineAuth prob/giriş/çıkış çağrıları (`deps.env`) + main'in spawn
 * boğazı. Aynı fonksiyonun iki yerde kullanılması, "rozet A hesabını okurken
 * pane B hesabıyla koşuyor" ayrışmasını yapısal olarak imkânsız kılar.
 */
function applyProfileEnv(baseEnv, home, engine, profileId) {
  const base = { ...(baseEnv || {}) };
  return { ...base, ...envForProfile(home, engine, profileId) };
}

/**
 * main.js'in `trusted.engineProfiles` olarak buildSpawn'a geçirdiği ÇÖZÜCÜ.
 * Renderer bir `profileId` İSTEYEBİLİR (pane başına hesap), ama:
 *   • kimlik defterde KAYITLI olmalı — uydurulan bir id sessizce aktife düşer,
 *   • dizin her hâlükârda burada çözülür (renderer yol göremez/veremez).
 */
function createResolver(home) {
  /** İstenen kimlik defterde KAYITLIYSA o, değilse aktif. Saf-ish (defter okur). */
  const resolveId = (engine, requestedProfileId) => {
    if (!isEngine(engine)) return DEFAULT_PROFILE_ID;
    const reg = readRegistry(home);
    const known = new Set(reg.engines[engine].profiles.map((p) => p.id));
    return isProfileId(requestedProfileId) && known.has(requestedProfileId)
      ? requestedProfileId
      : reg.engines[engine].active;
  };
  return {
    /** @returns {{[k:string]: string}} childEnv'e Object.assign edilecek katkı. */
    envFor(engine, requestedProfileId) {
      if (!isEngine(engine)) return {};
      return envForProfile(home, engine, resolveId(engine, requestedProfileId));
    },
    /**
     * ACCT-FIX-01 — bu spawn HANGİ profille koşacak (pane kaydına yazılır, §3.4).
     * `envFor` ile AYNI çözümden geçer: kayıt ile env'in ayrışması yapısal olarak imkânsız.
     */
    resolveId,
    /** Rozet/log için: bu spawn hangi profille koşuyor. */
    activeFor(engine) {
      return isEngine(engine) ? readRegistry(home).engines[engine].active : DEFAULT_PROFILE_ID;
    },
  };
}

// ── Yazma yüzeyi ────────────────────────────────────────────────────────────

/**
 * Yeni bir profil açar (dizin 0700 + defter kaydı). Giriş akışını BAŞLATMAZ —
 * onu çağıran yapar (engineAuth.startLogin, profil env'iyle).
 * @returns {{ok:boolean, profileId?:string, dir?:string, error?:string}}
 */
function addProfile(home, engine, opts = {}) {
  if (!isEngine(engine)) return { ok: false, error: 'unsupported-engine' };
  const reg = readRegistry(home);
  const list = reg.engines[engine].profiles;
  if (list.length >= MAX_PROFILES_PER_ENGINE) return { ok: false, error: 'profile-limit' };
  const id = nextProfileId(list.map((p) => p.id));
  if (!id) return { ok: false, error: 'profile-limit' };
  const dir = ensureProfileDir(home, engine, id);
  if (!dir) return { ok: false, error: 'dir-failed' };
  list.push({
    id,
    label: sanitizeLabel(opts.label),
    createdAt: typeof opts.now === 'number' ? opts.now : Date.now(),
  });
  if (!writeRegistry(home, reg)) return { ok: false, error: 'write-failed' };
  return { ok: true, profileId: id, dir };
}

/** Aktif profili değiştirir. Bilinmeyen kimlik reddedilir (sessiz düşme yok). */
function setActiveProfile(home, engine, profileId) {
  if (!isEngine(engine)) return { ok: false, error: 'unsupported-engine' };
  const reg = readRegistry(home);
  const known = reg.engines[engine].profiles.some((p) => p.id === profileId);
  if (!known) return { ok: false, error: 'unknown-profile' };
  reg.engines[engine].active = profileId;
  if (!writeRegistry(home, reg)) return { ok: false, error: 'write-failed' };
  return { ok: true, active: profileId };
}

/** Profil etiketini değiştirir (kullanıcının "iş hesabı" gibi kendi adı). */
function setProfileLabel(home, engine, profileId, label) {
  if (!isEngine(engine)) return { ok: false, error: 'unsupported-engine' };
  const reg = readRegistry(home);
  const p = reg.engines[engine].profiles.find((x) => x.id === profileId);
  if (!p) return { ok: false, error: 'unknown-profile' };
  p.label = sanitizeLabel(label);
  if (!writeRegistry(home, reg)) return { ok: false, error: 'write-failed' };
  return { ok: true };
}

/**
 * Profili defterden düşürür ve KİMLİK DİZİNİNİ siler.
 *
 * ⚠️ Dizini silmek macOS'ta Keychain kaydını silmez (yuva adı dizin yolundan
 * TÜRER, kayıt orada kalır) — bu yüzden çağıranın ÖNCE `claude auth logout`u
 * o profilin env'iyle koşturması gerekir. Sıralama main.js'te (IPC) yazılı;
 * burada dizin silme yine de yapılır ki artık bir işaretçi kalmasın.
 * Varsayılan profil SİLİNEMEZ.
 */
function removeProfile(home, engine, profileId) {
  if (!isEngine(engine)) return { ok: false, error: 'unsupported-engine' };
  if (profileId === DEFAULT_PROFILE_ID) return { ok: false, error: 'default-immutable' };
  const reg = readRegistry(home);
  const idx = reg.engines[engine].profiles.findIndex((p) => p.id === profileId);
  if (idx < 0) return { ok: false, error: 'unknown-profile' };
  const dir = profileDir(home, engine, profileId); // containment kapısı burada
  reg.engines[engine].profiles.splice(idx, 1);
  if (reg.engines[engine].active === profileId) reg.engines[engine].active = DEFAULT_PROFILE_ID;
  if (!writeRegistry(home, reg)) return { ok: false, error: 'write-failed' };
  if (dir) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* defter zaten temiz; artık dizin yalnız yer kaplar */
    }
  }
  return { ok: true, active: reg.engines[engine].active };
}

/**
 * ACCT-FIX-01 — profilin kimlik damgasını yazar (giriş bitince / geriye doldurma).
 * Boş/geçersiz damga yazılmaz (`invalid-identity`). Sır taşımaz.
 */
function setProfileIdentity(home, engine, profileId, identity) {
  if (!isEngine(engine)) return { ok: false, error: 'unsupported-engine' };
  const clean = normalizeIdentity(identity);
  if (!clean) return { ok: false, error: 'invalid-identity' };
  const reg = readRegistry(home);
  const p = reg.engines[engine].profiles.find((x) => x.id === profileId);
  if (!p) return { ok: false, error: 'unknown-profile' };
  p.identity = clean;
  if (!writeRegistry(home, reg)) return { ok: false, error: 'write-failed' };
  return { ok: true, identity: clean };
}

/** ACCT-FIX-01 — damgayı düşürür (çıkış yapıldı: eski hesabın adı ekranda kalmasın). */
function clearProfileIdentity(home, engine, profileId) {
  if (!isEngine(engine)) return { ok: false, error: 'unsupported-engine' };
  const reg = readRegistry(home);
  const p = reg.engines[engine].profiles.find((x) => x.id === profileId);
  if (!p) return { ok: false, error: 'unknown-profile' };
  if (!p.identity) return { ok: true, cleared: false };
  p.identity = null;
  if (!writeRegistry(home, reg)) return { ok: false, error: 'write-failed' };
  return { ok: true, cleared: true };
}

/** "Limitte otomatik geç" tercihini yazar. */
function setAutoSwitchOnLimit(home, enabled) {
  const reg = readRegistry(home);
  reg.autoSwitchOnLimit = enabled === true;
  if (!writeRegistry(home, reg)) return { ok: false, error: 'write-failed' };
  return { ok: true, autoSwitchOnLimit: reg.autoSwitchOnLimit };
}

module.exports = {
  DEFAULT_PROFILE_ID,
  ENGINES,
  ENGINE_IDENTITY_ENV,
  MAX_PROFILES_PER_ENGINE,
  PROFILE_ID_RE,
  PROFILES_DIRNAME,
  REGISTRY_FILE,
  // saf
  isEngine,
  isProfileId,
  identityEnvKey,
  sanitizeLabel,
  maskAccount,
  nextProfileId,
  accountIdentityKey,
  markDuplicateAccounts,
  // ACCT-FIX-01 — kimlik damgası
  IDENTITY_SOURCES,
  normalizeIdentity,
  identityFromStatus,
  backfillIndex,
  profileRow,
  firstEmptyProfileId,
  normalizeRegistry,
  // yollar
  profilesRoot,
  profileDir,
  ensureProfileDir,
  registryPath,
  // defter
  readRegistry,
  writeRegistry,
  listProfiles,
  activeProfileId,
  autoSwitchOnLimit,
  // env
  envForProfile,
  applyProfileEnv,
  createResolver,
  // yazma
  addProfile,
  setActiveProfile,
  setProfileLabel,
  removeProfile,
  setAutoSwitchOnLimit,
  setProfileIdentity,
  clearProfileIdentity,
};
