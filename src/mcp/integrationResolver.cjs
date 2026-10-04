// ADP-585 (Entegrasyon Merkezi / Dalga 0) — SPAWN RESOLVER: vault → (katalog) → pane.
//
// Bu dosya "hangi pane hangi anahtarı alır" POLİTİKASIDIR. Depolama (ADP-584
// credentialVault) ile argv/env yazımı (agentRunner withIntegrations) arasında durur;
// ikisi de bunu bilmez, böylece politika tek yerde denetlenir.
//
// Neden SENKRON: `agentRunner.buildSpawn` senkrondur (main.js + delegasyon + resume
// yolları). Vault'un `resolveSync`/`servicesSync`'i tam bu yüzden var (gerekçe:
// credentialVault.cjs readDocSync). Burada async yok → spawn yolunda beklemek yok.
//
// GÜVENLİK DURUŞU (tasarım §3.4 · ADP-584 spike hükmü):
//   • Kural 2 — pane'e YALNIZ o pane için çözümlenen kayıtların secret'ı girer.
//     Vault'ta 8 servis olsa da, kapsamı (proje/ortam) tutmayan HİÇBİRİ enjekte
//     edilmez; MCP config'e de yazılmaz.
//   • `env` VARSAYILANI 'dev'. 'prod' YALNIZ açık işaretle gelir (no-prod-direct):
//     yanlış/eksik bağlamda prod anahtarı bir pane'e ASLA düşmez.
//   • Katalogda olmayan servis atlanır — vault'a elle yazılmış bir kayıt, bilinmeyen
//     bir komutu MCP server olarak başlatamaz (RCE yüzeyi yok; komut/argümanlar
//     DAİMA katalogdan gelir, kayıttan değil).
//   • `oauth` kayıtları (Katman A) burada YOK: onların jetonu CLI'nın kendi deposunda.
'use strict';

const catalog = require('./integrationCatalog.cjs');
const { missingRequiredUserFields } = require('../security/credentialVault.cjs');

/** Bilinen ortamlar; bilinmeyen/eksik = 'dev' (prod açık işaret ister). */
function normalizeEnvName(env) {
  return env === 'prod' ? 'prod' : 'dev';
}

/**
 * Spawn bağlamını normalize et. Girdi renderer'dan (opts) gelebilir → burada
 * daraltılır: yalnız string projectId, yalnız bilinen ortam, yalnız string servis
 * adları. `services` yoksa null (= "vault'ta ne varsa onu dene").
 */
function normalizeContext(ctx = {}) {
  const projectId =
    typeof ctx.projectId === 'string' && ctx.projectId.trim() ? ctx.projectId.trim() : null;
  const services = Array.isArray(ctx.services)
    ? ctx.services.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim())
    : null;
  return { projectId, env: normalizeEnvName(ctx.env), services };
}

/**
 * @param {object} opts
 * @param {{resolveSync:Function, servicesSync:Function, isAvailable?:Function,
 *          markUsed?:Function}} opts.vault - ADP-584 credential vault
 * @param {(line:string)=>void} [opts.log]
 */
function createIntegrationResolver(opts = {}) {
  const { vault } = opts;
  const log = opts.log || (() => {});

  return {
    /**
     * Bu pane'in alacağı entegrasyonlar.
     * @param {{projectId?:string|null, env?:'dev'|'prod', services?:string[]|null}} rawCtx
     * @returns {Array<{id:string, service:string, envVar:string, secret:string, entry:object}>}
     *   `envVar` = vault'un opaque adı (CREWPANE_SECRET_<id>); `entry.envVar` = MCP
     *   server'ın okuduğu gerçek ad (SUPABASE_ACCESS_TOKEN vb.).
     */
    resolve(rawCtx) {
      if (!vault || typeof vault.resolveSync !== 'function') return [];
      const ctx = normalizeContext(rawCtx);
      try {
        // Şifreleme yoksa vault AÇILMAZ — spawn'ı patlatma, sessizce entegrasyonsuz
        // devam et (pane'in kendisi hiçbir zaman bu yüzden ölmemeli).
        if (typeof vault.isAvailable === 'function' && !vault.isAvailable()) return [];
        const candidates = ctx.services || vault.servicesSync();
        const out = [];
        const seen = new Set();
        for (const service of candidates) {
          if (seen.has(service)) continue;
          seen.add(service);
          const entry = catalog.get(service);
          // Katalogda yok / OAuth (Katman A) / env adı ya da MCP tanımı eksik → atla.
          // INT-0-E — `dsn` de sır taşır (bağlantı dizesi) → api_key ile AYNI yoldan çözülür.
          if (!entry || !catalog.carriesSecret(entry.authKind) || !entry.envVar || !entry.mcpServer) continue;
          const hit = vault.resolveSync(service, { projectId: ctx.projectId, env: ctx.env });
          if (!hit || typeof hit.secret !== 'string' || !hit.secret) continue;
          // INT-0-A — ANAHTAR TEK BAŞINA YETMEYEBİLİR. Coolify self-hosted: adres
          // (`COOLIFY_BASE_URL`) yoksa server localhost:3000'e gidip HER çağrıda
          // "fetch failed" der. Böyle bir kaydı pane'e vermek, kullanıcıya BAĞLI
          // görünen ama HİÇBİR ZAMAN çalışmayan bir araç seti vermektir; sessiz
          // kusur, yokluktan beterdir → servis HİÇ kurulmaz, eksiklik
          // `missingUserFields` ile ADIYLA rapor edilir (ajan/UI oradan konuşur).
          const userFields = hit.userFields && typeof hit.userFields === 'object' ? hit.userFields : {};
          if (missingRequiredUserFields(service, userFields).length) continue;
          out.push({ id: hit.id, service, envVar: hit.envVar, secret: hit.secret, entry, userFields });
        }
        return out;
      } catch (err) {
        // Vault okuması hiçbir koşulda spawn'ı bloklamaz (delegate MCP yolu kutsal).
        log(`integrations resolve failed: ${err && err.message}`);
        return [];
      }
    },

    /**
     * INT-0-A — bu bağlamda KAYDI OLAN ama ZORUNLU ayarı eksik olan servisler.
     * `resolve()` onları bilerek düşürür; bu, düşürme GEREKÇESİNİ dışarı veren
     * ikinci kapıdır. Çağıran (durum cevabı / UI rozeti) "bağlı" demek yerine
     * "eksik ayar: <alan>" diyebilsin diye ALAN ADIYLA döner — kullanıcı neyi
     * dolduracağını bilmeden "çalışmıyor" cümlesi işe yaramaz.
     * @returns {Array<{service:string, missing:string[]}>}
     */
    missingUserFields(rawCtx) {
      if (!vault || typeof vault.resolveSync !== 'function') return [];
      const ctx = normalizeContext(rawCtx);
      try {
        if (typeof vault.isAvailable === 'function' && !vault.isAvailable()) return [];
        const candidates = ctx.services || vault.servicesSync();
        const out = [];
        const seen = new Set();
        for (const service of candidates) {
          if (seen.has(service)) continue;
          seen.add(service);
          const entry = catalog.get(service);
          // INT-0-E — `dsn` de sır taşır (bağlantı dizesi) → api_key ile AYNI yoldan çözülür.
          if (!entry || !catalog.carriesSecret(entry.authKind) || !entry.envVar || !entry.mcpServer) continue;
          const hit = vault.resolveSync(service, { projectId: ctx.projectId, env: ctx.env });
          if (!hit || typeof hit.secret !== 'string' || !hit.secret) continue;
          const missing = missingRequiredUserFields(service, hit.userFields || {});
          if (missing.length) out.push({ service, missing });
        }
        return out;
      } catch (err) {
        log(`integrations missingUserFields failed: ${err && err.message}`);
        return [];
      }
    },

    /**
     * `lastUsedAt` damgası — kullanıcı "bu anahtar hâlâ kullanılıyor mu?" sorusunu
     * UI'da yanıtlayabilsin diye (ADP-587). Ateşle-unut: async vault yazımı spawn'ı
     * BEKLETMEZ ve hatası spawn'ı etkilemez.
     */
    markUsed(ids) {
      if (!vault || typeof vault.markUsed !== 'function') return;
      for (const id of Array.isArray(ids) ? ids : [ids]) {
        if (typeof id !== 'string' || !id) continue;
        try {
          Promise.resolve(vault.markUsed(id)).catch((err) => {
            log(`integrations markUsed failed id=${id}: ${err && err.message}`);
          });
        } catch (err) {
          log(`integrations markUsed threw id=${id}: ${err && err.message}`);
        }
      }
    },
  };
}

module.exports = { createIntegrationResolver, normalizeContext, normalizeEnvName };
