// ENV-01 (ENV-R1 §5) — TEK ANAHTARLI ORTAM SEÇİMİ: `CREWPANE_ENV=local|dev|prod`.
//
// ## Ne çözüyor (ölçüldü — ENV-R1 §0, S1)
// `npm run electron:dev` bugün dört katmanı ÜÇ ayrı hatta dağıtıyor:
//   URL şeması `crewpane-dev://` · app DB `127.0.0.1:54321` · kimlik **PROD bulut**
//   · giriş sayfası **accounts.crewpane.dev** (PROD).
// Yani geliştirici kopyası PROD kimlik sunucusunda GERÇEK kullanıcı satırı açıyor,
// sonra o hesapla yerel bir DB'ye `anon` bağlanıyor. Hiçbir yerde yazmıyor.
//
// ## Ne YAPMIYOR — kasıtlı (ENV-R1 §5.2 kuralı)
// Bu modül YENİ BİR ÇÖZÜMLEYİCİ DEĞİLDİR. `backendTarget.cjs` / `publicBackendEnv.cjs`
// / `crewpaneId.cjs` / `devChannel.cjs` boğazları AYNEN kalır — profil yalnız onların
// GİRDİSİNİ (`process.env`) üretir. `reuse > icat`: dotenv ayrıştırıcısı bile
// `publicBackendEnv.parseEnvFile`ten alınır, ikinci kez yazılmaz.
//
// ## Öncelik merdiveni (en zayıftan en güçlüye — ENV-R1 §5.2)
//   1 gömülü sabitler (PROD_CLOUD / devChannelTarget)
//   2 makine dosyası ~/.crewpane[-dev]/crewpane-public-env.json
//   3 <repo>/.env.local (yalnız 3 NEXT_PUBLIC_* anahtarı)
//   4 CREWPANE_ENV profili        ← BU MODÜL
//   5 kabuktaki AÇIK env           (profil onu EZMEZ → `overridden`e düşer)
//   6 baked damga (paketli dev)    (`backendTarget` dev dalı zaten öne alır)
//   7 isCustomerBuild() kilidi     (4 ve 5 tamamen yok sayılır)
//
// ENV-06: 4. kademe (profil) YALNIZ PAKETSİZ koşuda etkilidir. Paketli her kopyada
// (müşteri VE dev/test DMG) `CREWPANE_ENV` yok sayılır — hat 6. kademeden, yani baked
// damgadan gelir. Sebep: profil dosyaları pakete BİLEREK girmiyor (aşağıya bak), bu yüzden
// paketli kopyada "profil isteniyor ama dosya yok" hâli bir ARIZA değil, NORMAL hâldir.
//
// ## ⛔ NEDEN PAKETLENMEZ (ENV-R1 §7 uyarısı — biri "eksik" sanıp EKLEMESİN)
// `config/*.profile` dosyaları `electron/package.json:build.files` kalıplarına BİLEREK
// girmez. Bunlar bir GELİŞTİRİCİ aracıdır; müşteri DMG'sine bir hat-seçici sızarsa
// ürün, kullanıcının diskindeki bir dosyaya göre hangi buluta bağlanacağına karar
// eder. Müşteri tarafında zaten çift kilit var (`isCustomerBuild()` burada + ADP-723
// `ESCAPE_KEYS` `backendTarget`'ta), ama dosyanın pakete HİÇ girmemesi birinci savunma
// hattıdır — `envProfile.packagingGuardPatterns()` bunu testle kilitler.
// (Emsal: ADP-780-B'de `devChannelTarget.json` tam bu kalıplara uymadığı için asar'a
// girmedi ve dev DMG sessizce prod'a bağlandı. Aynı mekanizma, ters yönde kullanılıyor.)
//
// ## Beyaz liste (ENV-R1 §5.3 — kapsam kilidi)
// Profil YALNIZ 6 PUBLIC anahtarı yazar. `OPENAI_API_KEY` vb. ASLA: bu dosya bir sır
// taşıyıcısına dönüşürse ADP-628'in "ambient env asla taşıyıcı olamaz" kuralı çöker.
// Liste dışı bir anahtar profilde görülürse açılış KIRMIZI durur (sessizce atlanmaz).
//
// Saf + DI: I/O yok (dosya metni parametreyle gelir), `process.env` okumaz.
// Çalıştır: node --test electron/envProfile.test.cjs

'use strict';

const { parseEnvFile } = require('./publicBackendEnv.cjs');

/** Tanınan hatlar. Başka bir değer → açılış durur (sessiz `prod`a düşme YOK). */
const PROFILE_NAMES = Object.freeze(['local', 'dev', 'prod']);

/**
 * Profilin `process.env`e yazabildiği TEK anahtar kümesi (ENV-R1 §5.3).
 * Üçü `publicBackendEnv`in okuduğu PUBLIC çift + şema, üçü `crewpaneId.cjs:141-145`in
 * okuduğu kimlik hattı. Hepsi PUBLIC'tir (anon anahtarları RLS korur) — sır değil.
 */
const ALLOWED_KEYS = Object.freeze([
  'NEXT_PUBLIC_CREWPANE_SUPABASE_URL',
  'NEXT_PUBLIC_CREWPANE_SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_CREWPANE_SUPABASE_SCHEMA',
  'CREWPANE_ID_URL',
  'CREWPANE_ID_ANON_KEY',
  'CREWPANE_LOGIN_URL',
]);

/** `CREWPANE_ENV` / `CREWPANE_ENV` — ikiz ad çifti. */
const ENV_KEY_LEGACY = 'CREWPANE_ENV';
const ENV_KEY_CANONICAL = 'CREWPANE_ENV';

/** Profil dosyasının adı: `config/env.<ad>.profile`. Yol üretimi tek yerden. */
function profileFileName(name) {
  return `env.${name}.profile`;
}

function nonEmpty(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * `CREWPANE_ENV` / `CREWPANE_ENV` okuması.
 *
 * ⛔ `crewpaneEnv.readEnv('ENV')` KULLANILMAZ — `ENV` bir PINNED base'dir ve o çağrı
 * bilerek ATAR (split-brain yasağı, `crewpaneEnv.cjs:66`). Okuma TEK yerden, yani
 * buradan yapılır; ayrışan iki ad sessizce çözülmez, HATA olur: `CREWPANE_ENV=local`
 * + `CREWPANE_ENV=prod` verilirse süreç "lokaldeyim" sanıp prod'a bağlanırdı.
 *
 * @returns {{name: string|null, error: string|null}} name ham (normalize edilmiş) değer
 */
function readEnvName(env) {
  const e = env || {};
  const legacy = nonEmpty(e[ENV_KEY_LEGACY]);
  const canonical = nonEmpty(e[ENV_KEY_CANONICAL]);
  const lc = (v) => (v ? v.toLowerCase() : null);
  if (legacy && canonical && lc(legacy) !== lc(canonical)) {
    return {
      name: null,
      error:
        `${ENV_KEY_LEGACY}=${legacy} ile ${ENV_KEY_CANONICAL}=${canonical} AYRIŞIYOR. ` +
        'İkiz adlar aynı değeri taşımak zorundadır (biri lokal, diğeri prod derse süreç ' +
        'lokal sanıp prod\'a bağlanır). Birini sil ya da ikisini eşitle.',
    };
  }
  return { name: lc(legacy) || lc(canonical), error: null };
}

/**
 * Profili ÇÖZ (saf). Dosyayı okumaz — metni `opts.profileText` ile gelir.
 *
 * @param {object} env  process.env ya da fixture
 * @param {{profileText?: string|null, profilePath?: string|null}} [opts]
 * @returns {{name: string|null, values: object, overridden: string[], errors: string[],
 *           missing: string[]}}
 *   name       — null ⇒ anahtar verilmemiş ⇒ HİÇBİR yazım (bugünkü davranış birebir)
 *   values     — `process.env`e yazılacak anahtarlar (yalnız beyaz liste)
 *   overridden — kabukta ZATEN dolu olduğu için profilin YAZMADIĞI anahtarlar
 *   errors     — boş değilse açılış DURUR
 *   missing    — profilde hiç geçmeyen beyaz-liste anahtarları (bilgi; hata değil)
 */
function resolveEnvProfile(env, opts) {
  const o = opts || {};
  const e = env || {};
  const out = { name: null, values: {}, overridden: [], errors: [], missing: [] };

  const read = readEnvName(e);
  if (read.error) {
    out.errors.push(read.error);
    return out;
  }
  if (!read.name) return out; // anahtar yok → profil devre dışı

  if (!PROFILE_NAMES.includes(read.name)) {
    out.errors.push(
      `${ENV_KEY_LEGACY}=${read.name} TANINMIYOR. Geçerli değerler: ${PROFILE_NAMES.join(' | ')}. ` +
        'Yazım hatası sessizce prod hattına düşmesin diye açılış durduruldu.',
    );
    return out;
  }
  out.name = read.name;

  const text = o.profileText;
  if (typeof text !== 'string') {
    out.errors.push(
      `Profil dosyası okunamadı: ${o.profilePath || `config/${profileFileName(read.name)}`}. ` +
        'Depoda commit\'lidir; silinmiş ya da yol yanlışsa hat çözülemez.',
    );
    return out;
  }

  const parsed = parseEnvFile(text);
  const unknown = Object.keys(parsed).filter((k) => !ALLOWED_KEYS.includes(k));
  if (unknown.length) {
    out.errors.push(
      `Profil beyaz liste DIŞI anahtar taşıyor: ${unknown.join(', ')}. ` +
        `İzin verilenler: ${ALLOWED_KEYS.join(', ')}. ` +
        'Profil bir SIR TAŞIYICISI değildir (ENV-R1 §5.3) — açılış durduruldu.',
    );
    return out;
  }

  for (const key of ALLOWED_KEYS) {
    const fromProfile = nonEmpty(parsed[key]);
    if (fromProfile === null) {
      if (!(key in parsed)) out.missing.push(key);
      continue;
    }
    // Kabuktaki AÇIK env profilden GÜÇLÜ (5. kademe): en spesifik olan son sözü söyler.
    if (nonEmpty(e[key]) !== null) {
      out.overridden.push(key);
      continue;
    }
    out.values[key] = fromProfile;
  }
  return out;
}

/**
 * Profili UYGULA — tek yan etkili fonksiyon (`target`a yazar).
 *
 * `readFile` bir dikiştir: gerçek koşuda `fs.readFileSync`, testte fixture. Dosya
 * yoksa `null` döndürsün (throw etmesin) — hatayı `resolveEnvProfile` anlatır.
 *
 * @param {{target?: object, env?: object, configDir?: string, join?: Function,
 *          readFile?: (p: string) => string|null, customerBuild?: boolean,
 *          packaged?: boolean}} deps
 * @returns {{name, values, overridden, errors, missing, applied: string[],
 *            customerBuild: boolean, packaged: boolean,
 *            rejected: Array<{key:string, reason:string}>}}
 */
function applyEnvProfile(deps) {
  const d = deps || {};
  const target = d.target || {};
  const env = d.env || target;
  const join = d.join || ((...p) => p.join('/'));
  const customerBuild = d.customerBuild === true;
  const packaged = d.packaged === true;

  const read = readEnvName(env);
  const requested = read.error ? null : read.name;

  // ⛔ MÜŞTERİ KİLİDİ (ENV-R1 §4.4): müşteri kopyasında anahtar HİÇ uygulanmaz —
  // ne profil okunur ne bir şey yazılır. `backendTarget.ESCAPE_KEYS` bunu ikinci kez
  // (env kopyasından silerek) kilitler; buradaki iz destek için: "denendi, yok sayıldı".
  if (customerBuild) {
    const rejected = requested
      ? [{ key: `${ENV_KEY_LEGACY}=${requested}`, reason: 'env_escape_ignored_in_customer_build' }]
      : [];
    return {
      name: null, values: {}, overridden: [], errors: [], missing: [],
      applied: [], customerBuild: true, packaged, rejected,
    };
  }

  // ⛔ PAKET KAPISI (ENV-06 — ENV-04 §F4 BULGU-1). Profil bir KAYNAK-AĞACI aracıdır:
  // `config/*.profile` bilerek pakete girmez (bkz. dosya başlığı "NEDEN PAKETLENMEZ").
  // ENV-01 muafiyeti YALNIZ müşteri build'ineydi, oysa dosya dev/test DMG'sinde de YOK
  // → paketli dev kopya `CREWPANE_ENV` görür, dosyayı bulamaz ve aşağıdaki fail-closed
  // dalına düşerek HİÇ AÇILMAZ (showErrorBox + app.exit(1); ölçüm ENV-04 F4, 30 sn repro).
  // Kabuğunda `export CREWPANE_ENV=local` olan geliştiricinin ya da ADP-723 sınıfı bir
  // `launchctl setenv` kalıntısının açtığı HER paketli kopya tuğlalaşıyordu.
  //
  // Doğru davranış ENV-R1 §5.2'nin kendi öncelik merdiveninde zaten yazılı: 6. kademe
  // "baked damga" 4. kademe "profil"i EZER. Paketli kopyada hat baked'den gelir → anahtar
  // yok sayılır, süreç AÇILIR. Fail-closed (bozuk/eksik profil = kırmızı) YALNIZ paketsiz
  // koşuda kalır; orada dosya gerçekten commit'lidir, yokluğu GERÇEK bir arızadır.
  if (packaged) {
    const rejected = requested
      ? [{ key: `${ENV_KEY_LEGACY}=${requested}`, reason: 'env_profile_ignored_in_packaged_build' }]
      : [];
    return {
      name: null, values: {}, overridden: [], errors: [], missing: [],
      applied: [], customerBuild: false, packaged: true, rejected,
    };
  }

  let profileText = null;
  let profilePath = null;
  if (requested && PROFILE_NAMES.includes(requested)) {
    profilePath = join(d.configDir || 'config', profileFileName(requested));
    try {
      profileText = d.readFile ? d.readFile(profilePath) : null;
    } catch {
      profileText = null;
    }
  }

  const resolved = resolveEnvProfile(env, { profileText, profilePath });
  const applied = [];
  if (!resolved.errors.length && resolved.name) {
    for (const [k, v] of Object.entries(resolved.values)) {
      target[k] = v;
      applied.push(k);
    }
    // İkiz-YAZIM serbest, ikiz-OKUMA yasak (crewpaneEnv.cjs sözleşmesi): iki ad da
    // aynı değeri taşısın ki alt süreçler (pane pty'leri, MCP çocukları) ayrışmasın.
    target[ENV_KEY_LEGACY] = resolved.name;
    target[ENV_KEY_CANONICAL] = resolved.name;
  }
  return { ...resolved, applied, customerBuild: false, packaged: false, rejected: [] };
}

/**
 * `local` profilinde giden e-posta YOKTUR: tüm giriş/doğrulama postaları Mailpit'e
 * düşer (ENV-R2 §5.1 notu). Adres banner'da GÖSTERİLİR, çünkü yazılmazsa kullanıcı
 * "kod gelmedi" sanır ve akış orada ölür.
 *
 * ⚠️ Bu bir HEDEF DEĞİL, bir GÖRÜNTÜdür: hiçbir çözümleme bu değeri okumaz, bu yüzden
 * beyaz listede (profil dosyasında) yeri yoktur — 6 anahtarlık kapsam kilidi korunur.
 * Port, yerel crewpane-id stack'inin `supabase status` çıktısındaki Inbucket portudur.
 */
const LOCAL_MAILPIT_URL = 'http://127.0.0.1:56324';

/**
 * Açılış banner'ının METNİ (saf — ENV-R1 §8 Faz 2 madde 6).
 * Bugün YOK olan tek satır: kimlik hedefi hiçbir `logLine` çağrısında geçmiyordu
 * (grep: 0 sonuç) ve "neden fark edilmedi"nin cevabı buydu.
 *
 * ⛔ ANON ANAHTAR BASILMAZ — yalnız URL'ler ve şema. (`secretRedactor` ikinci hat.)
 */
function bootBannerLine(view) {
  const v = view || {};
  const or = (x) => (nonEmpty(x) || '-');
  const parts = [
    `profil=${or(v.profile) === '-' ? 'yok' : v.profile}`,
    `kanal=${or(v.channel)}`,
    `şema=${or(v.scheme)}://`,
    `appDB=${or(v.dbUrl)}/${or(v.dbSchema)}`,
    `kimlik=${or(v.authUrl)}`,
    `giriş=${or(v.loginUrl)}`,
  ];
  if (nonEmpty(v.mailUrl)) parts.push(`posta=${v.mailUrl}`);
  return `[env] ${parts.join(' ')}`;
}

/**
 * ⛔ PAKETLEME GUARD'I (ENV-R1 risk 3). `electron/package.json:build.files` içindeki
 * hiçbir kalıp `config/*.profile` dosyalarını YAKALAMAMALI. Testin ikinci kez kalıp
 * yazmaması için liste burada; kural tek yerde.
 * @returns {string[]} pakete girmemesi gereken yol örnekleri
 */
function packagingGuardPatterns() {
  return PROFILE_NAMES.map((n) => `config/${profileFileName(n)}`);
}

module.exports = {
  PROFILE_NAMES,
  LOCAL_MAILPIT_URL,
  ALLOWED_KEYS,
  ENV_KEY_LEGACY,
  ENV_KEY_CANONICAL,
  profileFileName,
  readEnvName,
  resolveEnvProfile,
  applyEnvProfile,
  bootBannerLine,
  packagingGuardPatterns,
};
