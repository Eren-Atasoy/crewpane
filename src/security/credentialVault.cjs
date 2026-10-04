// ADP-584 (Entegrasyon Merkezi / Dalga 0) — credential vault ÇEKİRDEĞİ.
//
// Kullanıcının entegrasyon anahtarları (Supabase PAT, GitHub fine-grained PAT, …)
// TEK şifreli blob'da yaşar: <crewpaneHome>/credentials/vault.bin.
//
// KRİTİK KARAR — elle kripto YOK. Şifreleme seatGate.cjs:51/56 ile AYNI sarımdır
// (@crewpane/auth · createSafeStorageTokenStore → Electron safeStorage; macOS'ta
// master key Keychain'de). İkinci bir kripto yolu yazmak, ilk gün doğru olsa bile,
// bakımı ayrışan İKİNCİ bir saldırı yüzeyi demektir. safeStorage kullanılamıyorsa
// (isEncryptionAvailable()===false) vault AÇILMAZ ve her işlem açık hata döner —
// düz-metin fallback ASLA (ADR-027/G2, Kural 1).
//
// Neden AYRI blob (auth/session.bin + auth/license.bin yanına credentials/vault.bin):
// seatGate'in oturum dokümanı handleCallback'te KOMPLE değiştirilir; aynı dokümana
// yazılan bir şey sessizce yok olur (ADP-389'da Keychain'de yaşandı). Anahtarların
// oturum yaşam döngüsünden bağımsız olması gerekir (çıkış yapmak entegrasyonları
// silmemeli).
//
// Saf + DI: Electron'a doğrudan require-bağı YOK (safeStorage enjekte edilir) →
// `node --test` ile gerçek dosya sistemi + sahte safeStorage üstünde koşar.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const instancePaths = require('../config/instancePaths.cjs');
const catalog = require('../mcp/integrationCatalog.cjs');
function findPackageDir(pkgName) {
  const candidates = [
    path.join(__dirname, 'packages', pkgName),
    path.join(__dirname, '..', 'packages', pkgName),
    path.join(__dirname, '..', '..', 'packages', pkgName),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[1];
}

const CREWPANE_AUTH_DIR = findPackageDir('crewpane-auth');
const { createSafeStorageTokenStore } = require(
  path.join(CREWPANE_AUTH_DIR, 'index.cjs'),
);

const VAULT_VERSION = 1;
const ENV_PREFIX = 'CREWPANE_SECRET_';
const ENVS = ['dev', 'prod'];
const DEFAULT_ENV = 'dev';

class VaultUnavailableError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'VaultUnavailableError';
    this.code = 'ERR_VAULT_UNAVAILABLE';
  }
}

/** Kaydın env değişkeni: id `cred_a1b2` → `CREWPANE_SECRET_a1b2` (tasarım §3.3). */
function envVarName(id) {
  const suffix = String(id || '').replace(/^cred_/, '').replace(/[^A-Za-z0-9_]/g, '');
  if (!suffix) throw new Error('envVarName: geçersiz id');
  return ENV_PREFIX + suffix;
}

/** Yeni opaque id. Servis adı/anahtar İÇERMEZ — id log'a/config'e düşer. */
function newId(randomBytes = crypto.randomBytes) {
  return `cred_${randomBytes(4).toString('hex')}`;
}

function normalizeEnv(env) {
  if (env === null || env === undefined || env === '') return null; // "her ortam"
  if (!ENVS.includes(env)) throw new Error(`geçersiz env: ${env} (dev|prod|null)`);
  return env;
}

function normalizeScope(scope) {
  if (!scope || scope.type === 'workspace') return { type: 'workspace' };
  if (scope.type === 'project') {
    const projectId = typeof scope.projectId === 'string' ? scope.projectId.trim() : '';
    if (!projectId) throw new Error('scope.type=project için projectId zorunlu');
    return { type: 'project', projectId };
  }
  throw new Error(`geçersiz scope.type: ${scope.type}`);
}

/**
 * INT-0-A — ANAHTAR DIŞI, GİZLİ OLMAYAN kullanıcı alanları (Coolify sunucu adresi,
 * Supabase proje ref'i, self-hosted Sentry host'u). Sır DEĞİLDİR: `meta`'da yaşar,
 * `toMeta` ile UI'a döner ve MCP config'e DÜZ DEĞER olarak yazılır.
 *
 * Neden burada da SÜZÜLÜYOR (integrationIpc zaten allowlist uyguluyorken): kasa
 * dosyası diskte durur ve elle düzenlenebilir. Katalogda BEYAN EDİLMEYEN bir ad
 * buradan geçerse `ensureIntegrationsMcpConfig` onu bir MCP child'ının ortamına
 * yazardı (PATH ezme yüzeyi). Yetki TEK yerde: katalog. IPC'nin doğrulaması
 * KULLANICI girdisini, buradaki DİSK girdisini kapatır — ikisi de gerekli.
 */
function normalizeUserFields(raw, service) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const allowed = new Set(catalog.userFields(service).map((f) => f.envVar));
  for (const [k, v] of Object.entries(raw)) {
    if (!allowed.has(k) || typeof v !== 'string') continue;
    const val = v.trim();
    if (val) out[k] = val;
  }
  return out;
}

/** Katalogda `required:true` olup kayıtta DOLU OLMAYAN alan adları. */
function missingRequiredUserFields(service, userFields) {
  const have = userFields && typeof userFields === 'object' ? userFields : {};
  return catalog
    .userFields(service)
    .filter((f) => f.required === true && !(typeof have[f.envVar] === 'string' && have[f.envVar].trim()))
    .map((f) => f.envVar);
}

/** Diske/UI'a giden güvenli görünüm — `secret` ASLA yok. */
function toMeta(rec) {
  return {
    id: rec.id,
    service: rec.service,
    scope: rec.scope,
    env: rec.env,
    authKind: rec.authKind,
    // INT-0-E — env adı SIR TAŞIYAN her sınıfa verilir (api_key + dsn); hüküm
    // katalogda tek evde (`carriesSecret`) — burada bir kopya kalsaydı yeni bir
    // sınıf eklendiğinde kayıt sessizce env'siz doğar ve MCP server hiç kurulmazdı.
    envVar: catalog.carriesSecret(rec.authKind) ? envVarName(rec.id) : null,
    // INT-0-A — `userFields` DERİN kopyalanır: `{...rec.meta}` sığdır ve nesne
    // referansı paylaşılsaydı çağıranın (UI/IPC) mutasyonu bellekteki kaydı sessizce
    // bozardı — bir sonraki `writeDoc` onu diske yazardı.
    meta: { ...rec.meta, userFields: { ...((rec.meta && rec.meta.userFields) || {}) } },
  };
}

/**
 * `resolve` sıralaması — EN SPESİFİK KAZANIR (tasarım §2):
 *   proje+ortam (4) → proje (3) → workspace+ortam (2) → workspace (1) → eşleşme yok.
 * `env` verilmezse varsayılan `dev` (prod açık işaret ister — no-prod-direct ilkesi).
 */
function specificity(rec, { projectId, env }) {
  if (rec.scope.type === 'project') {
    if (!projectId || rec.scope.projectId !== projectId) return 0; // yanlış proje = ASLA
    if (rec.env === env) return 4;
    if (rec.env === null) return 3;
    return 0; // başka ortamın anahtarı sızmasın (prod anahtarı dev pane'e DÜŞMEZ)
  }
  if (rec.env === env) return 2;
  if (rec.env === null) return 1;
  return 0;
}

/**
 * Servis için EN SPESİFİK kaydı seç (politika TEK yerde: hem async `resolve` hem
 * ADP-585'in `resolveSync`'i bunu çağırır — iki kopya = sessiz drift).
 * @returns {object|null} ham kayıt (secret İÇERİR — çağıran yalnız childEnv'e koyar)
 */
function pickBest(records, service, ctx = {}) {
  const env = normalizeEnv(ctx.env === undefined ? DEFAULT_ENV : ctx.env);
  const projectId = ctx.projectId || null;
  let best = null;
  let bestScore = 0;
  for (const rec of records) {
    if (rec.service !== service || !catalog.carriesSecret(rec.authKind)) continue;
    const score = specificity(rec, { projectId, env });
    // `>` (>= DEĞİL): eşit spesifiklikte İLK kayıt kazanır → deterministik.
    if (score > bestScore) { best = rec; bestScore = score; }
  }
  return best;
}

/** Çözümlenmiş kayıt görünümü — `secret` YALNIZ childEnv için; diske ASLA. */
function toResolved(rec) {
  return {
    id: rec.id,
    service: rec.service,
    envVar: envVarName(rec.id),
    secret: rec.secret,
    // INT-0-A — spawn yolunun okuduğu alan. SIR DEĞİL (bu yüzden `secret`in yanında
    // değil, ondan AYRI bir alan): config'e düz değer olarak yazılacak.
    userFields: { ...((rec.meta && rec.meta.userFields) || {}) },
    record: toMeta(rec),
  };
}

/**
 * @param {object} opts
 * @param {{isEncryptionAvailable:()=>boolean, encryptString:(s:string)=>Buffer,
 *          decryptString:(b:Buffer)=>string}} opts.safeStorage - Electron safeStorage (veya test ikizi)
 * @param {string} [opts.homeDir] - <crewpaneHome> (verilmezse instance-aware çözülür:
 *   PROD ~/.crewpane, DEV ~/.crewpane-dev — instancePaths tek kaynak)
 * @param {(line:string)=>void} [opts.log]
 * @param {()=>Buffer} [opts.randomBytes] - test seam (deterministik id)
 * @param {()=>string} [opts.now] - test seam (ISO zaman damgası)
 */
function createCredentialVault(opts = {}) {
  const { safeStorage } = opts;
  const homeDir = opts.homeDir || instancePaths.crewpaneHome();
  const log = opts.log || (() => {});
  const randomBytes = opts.randomBytes || crypto.randomBytes;
  const now = opts.now || (() => new Date().toISOString());
  const filePath = path.join(homeDir, 'credentials', 'vault.bin');

  const store = createSafeStorageTokenStore({ safeStorage, filePath });

  function isAvailable() {
    try { return safeStorage.isEncryptionAvailable() === true; } catch { return false; }
  }

  /** Her işlemin başında: şifreleme yoksa vault AÇILMAZ (düz-metin yolu YOK). */
  function assertAvailable() {
    if (!isAvailable()) {
      throw new VaultUnavailableError(
        'safeStorage şifrelemesi kullanılamıyor — credential vault AÇILMAZ, '
        + 'anahtar düz dosyaya YAZILMAZ/OKUNMAZ (ADR-027/G2 · Kural 1)');
    }
  }

  async function readDoc() {
    const doc = await store.load();
    if (!doc || !Array.isArray(doc.records)) return { version: VAULT_VERSION, records: [] };
    return { version: doc.version || VAULT_VERSION, records: doc.records };
  }

  async function writeDoc(doc) {
    await store.save({ version: VAULT_VERSION, records: doc.records });
  }

  // ADP-585 — SENKRON okuma. `buildSpawn` sözleşme gereği senkrondur (main.js dahil
  // ~20 çağrı yeri, delegasyon/resume yolları); onu async'e çevirmek, entegrasyon
  // anahtarı okumaktan KAT KAT büyük bir regresyon riskidir. safeStorageStore.load()
  // zaten İÇTEN SENKRON (readFileSync + decryptString) ama async imzalıdır; yukarı
  // paket (packages/crewpane-auth) crewpane-id ile paylaşılan KANONİK kopyanın aynası
  // olduğu için burada değiştirilmez (bkz. ADP-517 kuralı) → aynı üç satır burada
  // senkron tekrarlanır. Kripto YİNE store'un anahtarıdır (safeStorage), elle kripto YOK.
  function readDocSync() {
    const empty = { version: VAULT_VERSION, records: [] };
    let raw;
    try { raw = fs.readFileSync(filePath); } catch { return empty; } // dosya yok = kayıt yok
    try {
      const doc = JSON.parse(safeStorage.decryptString(raw));
      if (!doc || !Array.isArray(doc.records)) return empty;
      return { version: doc.version || VAULT_VERSION, records: doc.records };
    } catch {
      return empty; // çözülemeyen/bozuk blob = kayıt yok (fail-closed, store.load ile aynı duruş)
    }
  }

  return {
    filePath,
    isAvailable,

    /**
     * Yeni kayıt. `authKind:'oauth'` → secret vault'a GİRMEZ (Katman A: /mcp login
     * jetonu CLI'nın kendi deposunda yaşar; burada yalnız "bağlı" kaydı tutulur).
     * @returns {Promise<object>} meta (secret İÇERMEZ)
     */
    async add(input = {}) {
      assertAvailable();
      const service = typeof input.service === 'string' ? input.service.trim() : '';
      if (!service) throw new Error('add: service zorunlu');
      const authKind = input.authKind || 'api_key';
      if (!catalog.carriesSecret(authKind) && authKind !== 'oauth') {
        throw new Error(`add: geçersiz authKind: ${authKind} (api_key|dsn|oauth)`);
      }
      const secret = input.secret;
      if (catalog.carriesSecret(authKind)) {
        if (typeof secret !== 'string' || secret.length === 0) {
          throw new Error('add: api_key için secret zorunlu');
        }
      } else if (secret) {
        throw new Error('add: oauth kaydı secret TAŞIMAZ (Katman A vault dışıdır)');
      }

      const rec = {
        id: newId(randomBytes),
        service,
        scope: normalizeScope(input.scope),
        env: normalizeEnv(input.env),
        authKind,
        secret: catalog.carriesSecret(authKind) ? secret : null,
        meta: {
          keyLabel: typeof input.keyLabel === 'string' ? input.keyLabel : '',
          masked: catalog.carriesSecret(authKind) ? catalog.maskSecret(secret, service) : '',
          scopeHint: typeof input.scopeHint === 'string' ? input.scopeHint : '',
          addedAt: now(),
          lastUsedAt: null,
          // BR-01 (ADR-INT-BRIDGE §2.4) — SON ÇALIŞIR-DOĞRULAMA. `lastUsedAt` yalnız
          // "spawn'da enjekte edildi" der; anahtarın ÇALIŞTIĞINI kanıtlamaz (silinmiş
          // bir jeton da enjekte edilir). Bu alan YALNIZ gerçek bir el sıkışmadan sonra
          // damgalanır (integ:test başarısı / telemetri verify) → ajan "bağlı ama hiç
          // doğrulanmamış" ile "dün çalıştı"yı ayırabilir. null = hiç doğrulanmadı.
          lastVerifiedAt: null,
          // INT-0-D — ÜÇÜNCÜ HÂL. `lastVerifiedAt: null` iki AYRI gerçeği aynı
          // gösteriyordu: "hiç denenmedi" ile "denendi ve OLMADI". Ajan bu ikisini
          // ayırmadan konuşamaz (birine "test et", diğerine "anahtarı yenile" denir).
          // 🔴 Damga NEDEN söylemez: probe ağ hatasıyla da düşer; "reddedildi"
          // demek ÖLÇÜLMEMİŞ bir teşhis olurdu (ADR §3 "plan/limit ≠ izin" dersi).
          lastVerifyFailedAt: null,
          // INT-0-A — anahtar DIŞI zorunlu/opsiyonel ayarlar. `secret`in YANINA
          // değil `meta`ya yazılır: gizli değiller, UI'a ve MCP config'e düz değer
          // olarak dönerler. Katalog beyanı dışındaki adlar burada düşer.
          userFields: normalizeUserFields(input.userFields, service),
        },
      };

      const doc = await readDoc();
      doc.records.push(rec);
      await writeDoc(doc);
      log(`vault add id=${rec.id} service=${service} scope=${rec.scope.type} env=${rec.env ?? '*'}`);
      return toMeta(rec);
    },

    /** UI/IPC listesi — secret ASLA dönmez (Kural 4 görünürlüğü maskeyle sağlanır). */
    async list() {
      assertAvailable();
      const doc = await readDoc();
      return doc.records.map(toMeta);
    },

    /** @returns {Promise<boolean>} silindi mi */
    async remove(id) {
      assertAvailable();
      const doc = await readDoc();
      const before = doc.records.length;
      doc.records = doc.records.filter((r) => r.id !== id);
      if (doc.records.length === before) return false;
      await writeDoc(doc);
      log(`vault remove id=${id}`);
      return true;
    },

    /**
     * Spawn-anı çözümleme (ADP-585 buradan okur). Secret DÖNER — çağıran onu yalnız
     * childEnv'e koyar, ASLA diske yazmaz (config'te sadece ${envVar} referansı durur).
     * @returns {Promise<{id,service,envVar,secret,record}|null>}
     */
    async resolve(service, ctx = {}) {
      assertAvailable();
      const doc = await readDoc();
      const best = pickBest(doc.records, service, ctx);
      return best ? toResolved(best) : null;
    },

    /**
     * ADP-585 — `resolve`'un SENKRON ikizi (buildSpawn senkron; gerekçe readDocSync'te).
     * AYNI politika (pickBest) → spesifiklik merdiveni tek yerde. Secret DÖNER.
     */
    resolveSync(service, ctx = {}) {
      assertAvailable();
      const best = pickBest(readDocSync().records, service, ctx);
      return best ? toResolved(best) : null;
    },

    /**
     * ADP-585 — vault'ta api_key kaydı BULUNAN servisler (senkron, secret'sız).
     * Spawn resolver'ı bunu "bu pane hangi servisleri deneyecek" aday listesi olarak
     * kullanır: hiç kaydı olmayan servis için MCP server bile yazılmaz (Kural 2'nin
     * pratik karşılığı — pane yalnız gerçekten bağlı olanı görür).
     */
    servicesSync() {
      assertAvailable();
      const out = new Set();
      for (const rec of readDocSync().records) {
        if (catalog.carriesSecret(rec.authKind) && typeof rec.service === 'string') out.add(rec.service);
      }
      return [...out].sort();
    },

    /**
     * `lastUsedAt` damgası. resolve() bunu KENDİ ÇAĞIRMAZ: her spawn'da tüm
     * secret'ları yeniden şifreleyip diske yazmak gereksiz risk + I/O'dur; çağıran
     * (585) istediğinde işaretler.
     */
    async markUsed(id) {
      assertAvailable();
      const doc = await readDoc();
      const rec = doc.records.find((r) => r.id === id);
      if (!rec) return false;
      rec.meta.lastUsedAt = now();
      await writeDoc(doc);
      return true;
    },

    /**
     * BR-01 — bir bağlamda hangi KAYDIN geçerli olduğu, secret'a HİÇ DOKUNMADAN.
     * `resolve` bunun için kullanılamazdı: damga atmak uğruna sırrı belleğe çıkarmak
     * gereksiz bir maruziyettir. Politika yine tek kaynak (pickBest).
     * @returns {Promise<string|null>} kayıt id'si
     */
    async resolveId(service, ctx = {}) {
      assertAvailable();
      const best = pickBest((await readDoc()).records, service, ctx);
      return best ? best.id : null;
    },

    /**
     * BR-01 (ADR §2.4) — "bu anahtar en son ne zaman GERÇEKTEN çalıştı" damgası.
     * `markUsed`ten AYRI tutulur çünkü ikisi farklı iddialardır: kullanım enjeksiyonun,
     * doğrulama el sıkışmanın kanıtıdır. Yalnız BAŞARILI bir probe/verify çağırır.
     */
    async markVerified(id) {
      assertAvailable();
      const doc = await readDoc();
      const rec = doc.records.find((r) => r.id === id);
      if (!rec) return false;
      rec.meta.lastVerifiedAt = now();
      // INT-0-D — çalışan bir anahtar hâlâ "başarısız" görünemez: bayat kırmızı,
      // ajanı olmayan bir sorunu kullanıcıya bildirmeye iter.
      rec.meta.lastVerifyFailedAt = null;
      await writeDoc(doc);
      return true;
    },

    /**
     * INT-0-D — "en son ne zaman DENENDİ ve BAŞARISIZ oldu". `markVerified`in
     * ikizi ama SİMETRİK DEĞİL: başarı `lastVerifyFailedAt`i temizler, başarısızlık
     * `lastVerifiedAt`e DOKUNMAZ. Gerekçe: dün çalıştığı ÖLÇÜLMÜŞ bir anahtarın o
     * kanıtı, bugünkü bir ağ hatasıyla silinmemeli — iki alan iki farklı olayı
     * anlatır, biri diğerinin yokluğu değildir.
     */
    async markVerifyFailed(id) {
      assertAvailable();
      const doc = await readDoc();
      const rec = doc.records.find((r) => r.id === id);
      if (!rec) return false;
      rec.meta.lastVerifyFailedAt = now();
      await writeDoc(doc);
      return true;
    },
  };
}

module.exports = {
  createCredentialVault,
  VaultUnavailableError,
  envVarName,
  specificity,
  pickBest, // ADP-585 — resolve/resolveSync ortak politikası (tek kaynak)
  normalizeUserFields, // INT-0-A — katalog allowlist'i (disk girdisine karşı)
  missingRequiredUserFields, // INT-0-A — "eksik ayar" hükmü TEK yerde
  ENV_PREFIX,
  VAULT_VERSION,
  DEFAULT_ENV,
};
