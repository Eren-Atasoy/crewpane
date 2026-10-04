// ADP-586 (Entegrasyon Merkezi / Dalga 0) — IPC ÇEKİRDEĞİ (vault ↔ renderer sınırı).
//
// main.js'teki `integ:list|add|remove|test` handler'ları BURAYI çağırır; main tarafında
// yalnız üç satırlık ipcMain.handle kalır. Neden ayrı dosya: bu sınır ürünün EN
// hassas yeridir (renderer'dan gelen girdi + düz-metin anahtar) ve `node --test` ile
// gerçek dosya sistemi + gerçek şifreleme ikizi üstünde koşturulabilmelidir; main.js
// Electron'suz require EDİLEMEZ.
//
// KIRMIZI ÇİZGİ — RENDERER'A DÜZ-METİN SIR ASLA DÖNMEZ:
// Dönüş tipleri yalnız `vault.toMeta()` görünümüdür (`meta.masked` = "sk-••••4f2a").
// `list` sırrı zaten okumaz; `add` girdi olarak alır ama ÇIKTIDA yalnız maskeyi verir;
// `test` sırrı child env'ine koyar, sonucunda taşımaz. Hata mesajları da maskeden
// geçer (bir MCP server jetonu stderr'ine echo'layabilir).
//
// GİRDİ DOĞRULAMA (enjeksiyon duruşu): renderer'dan gelen HER alan burada daraltılır.
//   • service → yalnız KATALOGDA olan bir ad (bilinmeyen servis = ret). Komut/argüman
//     katalogdan geldiği için bu tek başına keyfi-komut yüzeyini kapatır.
//   • secret  → string, 8..8192, satır sonu/NUL YASAK (env değişkenine ve MCP config'e
//     giden bir değerde satır sonu = enjeksiyon vektörü).
//   • id      → `cred_<hex>` deseni (dosya/JSON'a giden opak kimlik).
//   • projectId/keyLabel/scopeHint → dar karakter kümesi + uzunluk tavanı.
//   • userFields → yalnız KATALOĞUN beyan ettiği env adları (gizli DEĞİL, ör.
//     COOLIFY_BASE_URL); serbest env yazımı YOK.
//
// Saf + DI (vault/catalog/redactor/probe enjekte) → Electron bağı yok.

'use strict';

const ID_RE = /^cred_[a-f0-9]{2,32}$/;
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SECRET_MIN = 8;
const SECRET_MAX = 8192;
const LABEL_MAX = 200;
const USER_FIELD_MAX = 500;
const ENVS = ['dev', 'prod'];

/** Kontrol karakteri / satır sonu taşıyor mu (env + JSON config'e giden değerler için). */
function hasControlChars(s) {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001F\u007F]/.test(s);
}

function bad(error, reason = 'invalid-input') {
  return { ok: false, reason, error };
}

/** Tek satırlık serbest metin alanı (etiket/ipucu) — kırp, kontrol karakterlerini at. */
function cleanLabel(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, LABEL_MAX); // eslint-disable-line no-control-regex
}

/** `add`/`test` ortak alanları: service + scope + env. */
function validateCommon(raw, catalog) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const service = typeof input.service === 'string' ? input.service.trim() : '';
  if (!service) return bad('service zorunlu');
  if (!catalog.has(service)) return bad(`bilinmeyen servis: ${service}`, 'unknown-service');
  // 🔴 TEK GERÇEK KAPISI (ADP-848-B): anahtarı başka bir yüzey yöneten servis
  // vault'a YAZILAMAZ/vault'tan test EDİLEMEZ. Yazılabilseydi aynı anahtarın iki
  // kopyası olur, `resolveCredential` sırası (vault → ayarlar) yüzünden kullanıcı
  // Ayarlar'dan güncellediği anahtarın neden işe yaramadığını asla anlayamazdı.
  if (typeof catalog.isExternallyManaged === 'function' && catalog.isExternallyManaged(service)) {
    const entry = catalog.get(service);
    return bad(
      `${entry.label} anahtarı burada tutulmaz — ${entry.managedLabel || 'Ayarlar'} altından yönetilir.`,
      'externally-managed',
    );
  }

  let env = null;
  if (input.env !== undefined && input.env !== null && input.env !== '') {
    if (!ENVS.includes(input.env)) return bad(`geçersiz ortam: ${String(input.env)}`);
    env = input.env;
  }

  const rawScope = input.scope && typeof input.scope === 'object' ? input.scope : { type: 'workspace' };
  let scope;
  if (rawScope.type === 'project') {
    const projectId = typeof rawScope.projectId === 'string' ? rawScope.projectId.trim() : '';
    if (!PROJECT_ID_RE.test(projectId)) return bad('geçersiz projectId (harf/rakam/._- , en fazla 64)');
    scope = { type: 'project', projectId };
  } else if (!rawScope.type || rawScope.type === 'workspace') {
    scope = { type: 'workspace' };
  } else {
    return bad(`geçersiz scope.type: ${String(rawScope.type)}`);
  }

  return { ok: true, value: { service, env, scope } };
}

/** Anahtar DIŞI, gizli OLMAYAN kullanıcı alanları — yalnız katalogdaki env adları. */
function validateUserFields(raw, service, catalog) {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) return bad('userFields nesne olmalı');
  const allowed = new Set(catalog.userFields(service).map((f) => f.envVar));
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!allowed.has(k)) return bad(`bu servis için bilinmeyen alan: ${k}`);
    if (typeof v !== 'string') return bad(`${k} metin olmalı`);
    const val = v.trim();
    if (!val) continue;
    if (val.length > USER_FIELD_MAX || hasControlChars(val)) return bad(`${k} geçersiz`);
    out[k] = val;
  }
  return { ok: true, value: out };
}

/** `add` girdisi (SIR İÇERİR — dönüşünde asla taşınmaz). */
function validateAdd(raw, catalog) {
  const common = validateCommon(raw, catalog);
  if (!common.ok) return common;
  const input = raw && typeof raw === 'object' ? raw : {};
  const entry = catalog.get(common.value.service);

  // INT-0-E — istenen sınıf KATALOĞUN beyanından gelir (renderer'ın iddiasından
  // değil): bir `dsn` servisine "api_key" diyerek bağlanılamaz, tersi de olmaz.
  const authKind = input.authKind === 'oauth' ? 'oauth' : entry.authKind;
  if (catalog.carriesSecret(authKind) && !catalog.carriesSecret(entry.authKind)) {
    return bad(`${entry.label} bu dalgada anahtarla bağlanmıyor`, 'unsupported-auth');
  }

  let secret = null;
  if (catalog.carriesSecret(authKind)) {
    if (typeof input.secret !== 'string') return bad('anahtar zorunlu');
    secret = input.secret.trim();
    if (secret.length < SECRET_MIN) return bad(`anahtar çok kısa (en az ${SECRET_MIN} karakter)`);
    if (secret.length > SECRET_MAX) return bad('anahtar çok uzun');
    if (hasControlChars(secret)) return bad('anahtar satır sonu/kontrol karakteri içeremez');
  } else if (input.secret) {
    return bad('oauth kaydı anahtar taşımaz');
  }

  const uf = validateUserFields(input.userFields, common.value.service, catalog);
  if (!uf.ok) return uf;

  return {
    ok: true,
    value: {
      ...common.value,
      authKind,
      secret,
      keyLabel: cleanLabel(input.keyLabel),
      scopeHint: cleanLabel(input.scopeHint),
      userFields: uf.value,
    },
  };
}

function validateId(raw) {
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!ID_RE.test(id)) return bad('geçersiz kayıt kimliği');
  return { ok: true, value: id };
}

/**
 * Katalog girişinin UI'a giden görünümü (mcpServer komutu UI'ı ilgilendirmez).
 *
 * BR-04 (ADR §6) — `vendor` bayrağı İKİ alanı birden belirler:
 *   • `keyGuidance` → müşteri metni mi, vendor genişletmesi mi (`guidanceFor`),
 *   • `provision`   → telemetri kurulumu VENDOR-İÇİ bir iştir; müşteri görünümünde
 *     alan HİÇ dönmez, dolayısıyla UI o bölümü çizemez ("alan varsa çiz" sözleşmesi
 *     zaten kurulu — ikinci bir bayrak icat etmeye gerek yok).
 *
 * @param {object} entry
 * @param {object} catalog  - guidanceFor'un kaynağı (DI: modül saf kalsın)
 * @param {boolean} vendor
 */
function catalogView(entry, catalog, vendor) {
  return {
    id: entry.id,
    label: entry.label,
    authKind: entry.authKind,
    envVar: entry.envVar,
    keyGuidance: catalog && typeof catalog.guidanceFor === 'function'
      ? catalog.guidanceFor(entry, { vendor: vendor === true })
      : entry.keyGuidance,
    docsUrl: entry.docsUrl || null,
    userFields: Array.isArray(entry.userFields) ? entry.userFields : [],
    // INT-0-D — kullanıcının BEYAN edebileceği izinlerin seçilebilir listesi
    // (katalogdaki `needsScopes`tan türer; granüler izni olmayan serviste BOŞ →
    // UI o bölümü hiç çizmez, uydurma bir izin adı kullanıcıya sunulmaz).
    scopeOptions: catalog && typeof catalog.scopeOptions === 'function' ? catalog.scopeOptions(entry.id) : [],
    // ── ADP-848-B — anahtarı BAŞKA bir yüzey yönetiyorsa söyle ───────────────
    // 'settings' → anahtar vault'ta DEĞİL, Ayarlar'daki kendi alanında yaşar.
    // UI bu girişte "Bağla" formu AÇMAZ; kullanıcıyı `managedAt`e yollar.
    // İKİNCİ BİR DEPO AÇMAMANIN UI tarafındaki karşılığı budur.
    keyStore: entry.keyStore || 'vault',
    managedAt: entry.managedAt || null,
    managedLabel: entry.managedLabel || null,
    // INT-OBS-01 — "bağlandıktan sonra kendi kendini kurabilir" beyanı. UI bu alan
    // VARSA kurulum bölümünü çizer; yoksa kart eskisi gibi davranır (yeni desen
    // icat edilmedi, mevcut kartın içine bir bölüm eklendi).
    // 🔴 BR-04: müşteri görünümünde bu alan DAİMA null — telemetri kurulumu bizim
    // iç ihtiyacımız (crewpane-prod/crewpane-dev/crewpane-com projeleri).
    provision: vendor ? (entry.provision || null) : null,
  };
}

/**
 * @param {object} opts
 * @param {object} opts.vault      - ADP-584 credentialVault örneği
 * @param {object} opts.catalog    - integrationCatalog
 * @param {object} [opts.redactor] - ADP-586 secretRedactor (maskeleme defteri)
 * @param {(o:object)=>Promise<object>} [opts.probe] - mcpProbe.probeMcpServer
 * @param {Record<string,string>} [opts.baseEnv] - probe child'ının taban env'i
 * @param {() => boolean} [opts.isVendorSurface] - BR-04: vendor yüzeyi mi (verilmezse MÜŞTERİ)
 * @param {(line:string)=>void} [opts.log]
 */
function createIntegrationIpc(opts = {}) {
  const { vault, catalog } = opts;
  const redactor = opts.redactor || null;
  /**
   * ADP-848-B — anahtarı BAŞKA bir yüzeyin yönettiği servislerin durumu.
   * `(service) => { connected:boolean, masked:string }` — SIR DÖNMEZ (yalnız maske).
   * Enjekte edilir çünkü kaynağı `requireCredential` (Electron/dosya sistemi bağlı);
   * bu modül saf kalmalı. Verilmezse o servisler "bağlı mı" bilgisi olmadan listelenir.
   */
  const externalStatus = typeof opts.externalStatus === 'function' ? opts.externalStatus : null;
  /**
   * BR-04 (ADR §6) — "bu kopya VENDOR yüzeyi mi?" Kaynak `buildChannel.isCustomerBuild()`
   * ama bu modül Electron'suz koşmalı → FONKSİYON olarak enjekte edilir (değer değil:
   * karar her çağrıda taze alınsın, kurulum sırası bir yalan üretmesin).
   * 🔴 Verilmezse MÜŞTERİ varsayılır — unutulan bir wiring, vendor akışını müşteriye
   * AÇAMAZ; en fazla bize eksik gösterir (fail-closed yön).
   */
  const isVendorSurface = typeof opts.isVendorSurface === 'function'
    ? () => opts.isVendorSurface() === true
    : () => false;
  const probe = opts.probe || null;
  const log = opts.log || (() => {});
  const baseEnv = opts.baseEnv || {};

  /** Hata metnini dışarı vermeden önce maskeden geçir (server stderr'i sızdırabilir). */
  function safe(text) {
    const s = String(text == null ? '' : text);
    return redactor ? redactor.redact(s) : s;
  }

  function vaultUnavailable(extra = {}) {
    return {
      ok: false,
      reason: 'vault-unavailable',
      error: 'Sistem anahtar deposu (Keychain) kullanılamıyor — anahtarlar açılamıyor.',
      ...extra,
    };
  }

  // `test` GERÇEK bir süreç başlatır (npx + MCP server). Tek seferde bir tane:
  // düğmeye üst üste basmak (ya da bozuk/kötü niyetli bir renderer döngüsü) onlarca
  // `npx` süreci doğurmasın. inputSim rate-limit'iyle aynı savunma refleksi.
  let probeBusy = false;

  /** Probe için TAM child env'i: taban env − diğer sırlar + bu servisin anahtarı. */
  function probeEnv(entry, secret, userFields) {
    const env = {};
    for (const [k, v] of Object.entries(baseEnv)) {
      // Kural 2 — başka bir entegrasyonun anahtarı bu probe child'ına GİRMEZ.
      if (k.startsWith('CREWPANE_SECRET_')) continue;
      if (typeof v === 'string') env[k] = v;
    }
    for (const [k, v] of Object.entries(userFields || {})) env[k] = v;
    env[entry.envVar] = secret;
    return env;
  }

  return {
    /**
     * Bağlı hesaplar + servis kataloğu (UI tek çağrıda kurar).
     * @returns {Promise<{ok:boolean, available:boolean, records:object[], catalog:object[]}>}
     */
    async list() {
      const cat = catalog.list().map((e) => catalogView(e, catalog, isVendorSurface())).map((entry) => {
        // Katalog AYNAYI tutar: değerin kendisi Ayarlar'da yaşar, burada yalnız
        // "bağlı mı + maskesi ne" gösterilir. İkinci bir kayıt YARATILMAZ.
        if (entry.keyStore !== 'vault' && externalStatus) {
          let st = null;
          try { st = externalStatus(entry.id); } catch { st = null; }
          return { ...entry, connected: !!(st && st.connected), masked: (st && st.masked) || null };
        }
        return entry;
      });
      if (!vault.isAvailable()) return { ...vaultUnavailable(), available: false, records: [], catalog: cat };
      try {
        const records = await vault.list(); // secret İÇERMEZ (toMeta)
        return { ok: true, available: true, records, catalog: cat };
      } catch (err) {
        log(`integ:list error: ${safe(err && err.message)}`);
        return { ok: false, reason: 'error', error: safe(err && err.message), available: true, records: [], catalog: cat };
      }
    },

    /**
     * Yeni bağlantı. Sır girdi olarak gelir, çıkışta YALNIZ maske döner.
     * @returns {Promise<{ok:boolean, record?:object, reason?:string, error?:string}>}
     */
    async add(raw) {
      const v = validateAdd(raw, catalog);
      if (!v.ok) return v;
      if (!vault.isAvailable()) return vaultUnavailable();
      try {
        const record = await vault.add({
          service: v.value.service,
          scope: v.value.scope,
          env: v.value.env,
          authKind: v.value.authKind,
          secret: v.value.secret,
          keyLabel: v.value.keyLabel,
          scopeHint: v.value.scopeHint,
          // INT-0-A — DOĞRULANMIŞ userFields'ı KASAYA TAŞI. Buradaki eksiklik
          // zincirin İLK kopuk halkasıydı: `validateAdd` alanı doğruluyor ve
          // `integ:test` probe'unda KULLANIYOR, ama kayda hiç yazmıyordu → servis
          // "BAĞLI" görünüp her araç çağrısında düşüyordu (Coolify, ölçüldü).
          userFields: v.value.userFields,
        });
        // Maskeleme defterine AL: bu andan sonra sır log'a/ekrana/notify'a düşerse
        // maskelenir (uygulama yeniden başlarsa defter ilk spawn'da yeniden dolar).
        if (redactor && v.value.secret) redactor.register(v.value.secret, v.value.service);
        log(`integ:add service=${v.value.service} id=${record.id} scope=${record.scope.type} env=${record.env ?? '*'}`);
        return { ok: true, record };
      } catch (err) {
        log(`integ:add error service=${v.value.service}: ${safe(err && err.message)}`);
        return { ok: false, reason: 'error', error: safe(err && err.message) };
      }
    },

    /** Bağlantıyı kes (Kural 4). Bir sonraki spawn'da config + env'den düşer. */
    async remove(rawId) {
      const v = validateId(rawId);
      if (!v.ok) return v;
      if (!vault.isAvailable()) return vaultUnavailable();
      try {
        const removed = await vault.remove(v.value);
        log(`integ:remove id=${v.value} removed=${removed}`);
        // UYARI (tasarım §3.4 açık riski): AÇIK pane'lerin env'inde değer KALIR.
        // Kullanıcıya "bu ajanları yeniden başlat" demek UI'ın işi (ADP-587).
        return { ok: true, removed, restartHint: removed };
      } catch (err) {
        log(`integ:remove error: ${safe(err && err.message)}`);
        return { ok: false, reason: 'error', error: safe(err && err.message) };
      }
    },

    /**
     * Bağlantıyı GERÇEKTEN dene: katalogdaki MCP server'ı anahtarla ayağa kaldır ve
     * araç listesini iste. `secret` verilirse o denenir (kaydetmeden test); verilmezse
     * vault'tan bu bağlam için çözümlenen kayıt kullanılır.
     * @returns {Promise<{ok:boolean, tools?:number, serverName?:string, reason?:string, error?:string}>}
     */
    async test(raw) {
      const common = validateCommon(raw, catalog);
      if (!common.ok) return common;
      const input = raw && typeof raw === 'object' ? raw : {};
      const entry = catalog.get(common.value.service);
      if (!entry || !catalog.carriesSecret(entry.authKind) || !entry.envVar || !entry.mcpServer) {
        return { ok: false, reason: 'unsupported-auth', error: 'bu servis bu dalgada test edilemiyor' };
      }
      if (!probe) return { ok: false, reason: 'unavailable', error: 'test motoru yok' };

      const uf = validateUserFields(input.userFields, common.value.service, catalog);
      if (!uf.ok) return uf;

      let secret = null;
      // BR-01 — hangi KAYIT test edildi? Yalnız vault'tan çözülen yolda bilinir; ham
      // secret'la yapılan "kaydetmeden dene" testinde ortada damgalanacak kayıt yoktur.
      let verifiedRecordId = null;
      if (typeof input.secret === 'string' && input.secret.trim()) {
        const v = validateAdd({ ...input, keyLabel: '', scopeHint: '' }, catalog);
        if (!v.ok) return v;
        secret = v.value.secret;
      } else {
        if (!vault.isAvailable()) return vaultUnavailable();
        let hit = null;
        try {
          hit = await vault.resolve(common.value.service, {
            projectId: common.value.scope.type === 'project' ? common.value.scope.projectId : null,
            env: common.value.env === null ? undefined : common.value.env,
          });
        } catch (err) {
          return { ok: false, reason: 'error', error: safe(err && err.message) };
        }
        if (!hit) return { ok: false, reason: 'not-connected', error: 'bu bağlam için kayıtlı anahtar yok' };
        secret = hit.secret;
        verifiedRecordId = hit.id;
        // INT-0-A — KAYITLI kaydı test ederken form BOŞ olabilir ("Bağlantıyı sına"
        // düğmesi anahtarı yeniden yazdırmaz). userFields artık kayıtta yaşadığına
        // göre probe da oradan okumalı; okumazsa Coolify testi kaydedilmiş bir
        // adrese rağmen localhost'a gidip düşer — yani test, ÜRÜNÜN davranışını
        // değil kendi eksiğini ölçerdi.
        if (!Object.keys(uf.value).length && hit.userFields && typeof hit.userFields === 'object') {
          uf.value = { ...hit.userFields };
        }
      }

      if (redactor && secret) redactor.register(secret, common.value.service);

      if (probeBusy) {
        return { ok: false, reason: 'busy', error: 'başka bir bağlantı testi sürüyor — bitmesini bekle' };
      }
      probeBusy = true;
      let res;
      try {
        res = await probe({
          command: entry.mcpServer.command,
          args: entry.mcpServer.args,
          env: probeEnv(entry, secret, uf.value),
          timeoutMs: Number.isFinite(input.timeoutMs) ? input.timeoutMs : undefined,
        });
      } finally {
        probeBusy = false;
      }
      // BR-01 (ADR §2.4) — BAŞARILI el sıkışma = "bu anahtar ÇALIŞTI" kanıtı; keşif
      // cevabındaki `lastVerifiedAt` yalnız buradan ve telemetri verify'ından damgalanır.
      // Başarısız test damgalamaz (yoksa alan "en son ne zaman DENEDİK"e döner ve ajan
      // ölü bir anahtarı doğrulanmış sanardı). Damga testin sonucunu ETKİLEMEZ.
      if (res.ok && verifiedRecordId && typeof vault.markVerified === 'function') {
        try {
          await vault.markVerified(verifiedRecordId);
        } catch (err) {
          log(`integ:test markVerified failed id=${verifiedRecordId}: ${safe(err && err.message)}`);
        }
      }
      // INT-0-D — BAŞARISIZ deneme de KAYDEDİLİR (ayrı alana). Yoksa "hiç denenmedi"
      // ile "denendi, olmadı" ajanın gözünde AYNI görünür ve ikisi TAMAMEN farklı
      // tavsiye gerektirir. Yalnız probe'un GERÇEKTEN koştuğu yolda damgalanır:
      // `not-connected`/`unsupported-auth`/`busy` cevapları el sıkışma DENEMESİ
      // değildir, onlar kaydı kirletemez (yukarıdaki erken dönüşler buraya gelmez).
      if (!res.ok && verifiedRecordId && typeof vault.markVerifyFailed === 'function') {
        try {
          await vault.markVerifyFailed(verifiedRecordId);
        } catch (err) {
          log(`integ:test markVerifyFailed failed id=${verifiedRecordId}: ${safe(err && err.message)}`);
        }
      }
      log(`integ:test service=${common.value.service} ok=${res.ok} tools=${res.tools ?? '-'} reason=${res.reason ?? '-'} ${res.durationMs}ms`);
      return {
        ok: !!res.ok,
        tools: res.tools ?? null,
        serverName: res.serverName ?? null,
        durationMs: res.durationMs,
        reason: res.reason || null,
        error: res.detail ? safe(res.detail).slice(0, 600) : null,
      };
    },
  };
}

module.exports = {
  createIntegrationIpc,
  validateAdd,
  validateCommon,
  validateId,
  validateUserFields,
  catalogView,
  ID_RE,
  SECRET_MIN,
  SECRET_MAX,
};
