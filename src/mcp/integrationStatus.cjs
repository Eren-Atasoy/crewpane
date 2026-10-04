// BR-01 / INT-BRIDGE-02 (ADR-INT-BRIDGE §2) — KEŞİF CEVABININ ÇEKİRDEĞİ.
//
// "Ajan tek soruyla öğrensin: hangi servisler bağlı, izin kapsamı ne, en son ne zaman
// doğrulandı." Bu dosya o cevabı ÜRETİR — ama hiçbir şeyi kendisi OKUMAZ: katalog,
// vault'un `toMeta` kayıtları, pane bağlamı ve "bu pane'e spawn anında hangi servisler
// enjekte edildi" listesi DIŞARIDAN gelir. Böylece saf kalır (`node --test`) ve
// "cevapta sır var mı" sorusu tek bir dosyada, tek bir testle kapatılabilir.
//
// 🔴 KIRMIZI ÇİZGİ (ADR §2.1): SIR — maskeli sır dahil — CEVABA GİRMEZ.
// `toMeta` kayıtları zaten `secret` taşımaz ama `meta.masked` taşır; buradaki inşa
// ALAN-ALAN yapılır (spread YOK) çünkü bir gün vault meta'sına eklenen yeni bir alan
// spread ile SESSİZCE ajana/transkripte akardı. Alan eklemek bilinçli bir karar olmalı.
//
// POLİTİKA TEK KAYNAK: "bu pane için hangi kayıt geçerli" sorusunun cevabı spawn
// yolundakiyle AYNI fiilden gelir (credentialVault.pickBest). İkinci bir kopya
// yazsaydık status "bağlı" derken spawn başka bir kaydı enjekte edebilirdi — ajanın
// gördüğü dünya ile pane'in gerçeği ayrışırdı.

'use strict';

const { pickBest, missingRequiredUserFields } = require('../security/credentialVault.cjs');
const { carriesSecret: catalogCarriesSecret } = require('./integrationCatalog.cjs');

/** ADR §2.2 — servis durumları (dördü de ajan için FARKLI bir cümle demektir). */
const STATES = Object.freeze({
  CONNECTED: 'connected',
  ELSEWHERE: 'connected-elsewhere',
  NOT_CONNECTED: 'not-connected',
  EXTERNAL: 'externally-managed',
});

/** ISO damgası → epoch ms (bozuk/boş → null). Vault meta'sı ISO yazar, sözleşme ms. */
function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/**
 * Pane bağlamını normalize et. `engine` claude/codex/shell olabilir; `env` VARSAYILANI
 * 'dev' (resolver ile aynı duruş: prod açık işaret ister — no-prod-direct).
 * `known:false` = köprü bu ajanı canlı pane defterinde BULAMADI; o zaman
 * `toolsLiveInThisPane` UYDURULMAZ, `null` döner (bilmiyorsak bilmiyoruz deriz).
 */
function normalizePane(pane = {}) {
  const engine = typeof pane.engine === 'string' && pane.engine.trim() ? pane.engine.trim() : null;
  return {
    engine,
    agentId: typeof pane.agentId === 'string' && pane.agentId.trim() ? pane.agentId.trim() : null,
    projectId: typeof pane.projectId === 'string' && pane.projectId.trim() ? pane.projectId.trim() : null,
    env: pane.env === 'prod' ? 'prod' : 'dev',
    known: pane.known === true,
    // ENG-21 (G4) — "BU MOTORUN MCP KANALI SIR TAŞIYABİLİR Mİ" HÜKMÜ, ÇAĞIRANDAN.
    // Buraya bir MOTOR ADI dalı yazmak (eskiden: "motor claude değilse araç yok") rozeti
    // davranıştan koparıyordu: anahtar copilot ve qwen pane'lerine GERÇEKTEN
    // enjekte ediliyor (ölçüldü — ENG-15 §2.4-G4) ama ajana "bu pane'de çalışmaz"
    // deniyordu. Hüküm tek evde yaşar (`agentRunner.integrationsInjectable` →
    // `paneCapabilityMatrix.mcpCanCarrySecrets`) ve buraya HAZIR gelir; bu dosya
    // saf kalır. `null` = ölçülmedi → uydurma yok.
    integrationsInjectable:
      pane.integrationsInjectable === true ? true : pane.integrationsInjectable === false ? false : null,
    integrationsReason:
      typeof pane.integrationsReason === 'string' && pane.integrationsReason.trim() ? pane.integrationsReason.trim() : null,
    // MCP-LAZY-01 — PROFIL KAPISI'nin bu pane'de KESTIKLERI. `[{service, source}]`;
    // source: 'role' | 'project' | 'global'. Bos dizi = kimse kesilmedi. Bunu
    // ayirmak sart: "bu pane acilirken henuz bagli degildin" ile "bagli ama bu
    // pane'in profilinde KAPALI" ajan icin FARKLI iki cumledir — ilkinde yeni bir
    // pane acmak coz{er, ikincisinde COZMEZ (kullanici isareti acmali).
    gated: Array.isArray(pane.gated)
      ? pane.gated.filter((g) => g && typeof g.service === 'string').map((g) => ({
          service: g.service,
          source: typeof g.source === 'string' ? g.source : 'global',
        }))
      : [],
  };
}

/**
 * Bir servisin ajanın gördüğü satırı.
 * @param {object} entry            - katalog girişi
 * @param {object[]} records        - vault.list() (toMeta — secret YOK)
 * @param {object} pane             - normalizePane çıktısı
 * @param {string[]|null} injected  - bu pane'e spawn anında enjekte edilen servisler
 *                                    (null = pane bilinmiyor → "bilmiyorum")
 * @param {(s:string)=>boolean} isExternallyManaged
 */
function serviceRow(entry, records, pane, injected, isExternallyManaged, guidanceFn) {
  // Doğrudan çağıranlar (testler) rehber çözücüsü vermeyebilir → katalogun kendi
  // müşteri metnine düş (vendor genişletmesi buradan ASLA dönmez).
  const guidance = typeof guidanceFn === 'function'
    ? guidanceFn
    : (e) => (typeof e.keyGuidance === 'string' ? e.keyGuidance : null);
  const service = entry.id;
  // INT-0-E — sır taşıyan HER sınıf (api_key + dsn) burada sayılır; kopya bir
  // koşul bırakılsaydı bir dsn kaydı spawn'a girer ama ajana "bağlı değil" denirdi.
  const mine = records.filter((r) => r && r.service === service && catalogCarriesSecret(r.authKind));
  const best = mine.length ? pickBest(mine, service, { projectId: pane.projectId, env: pane.env }) : null;

  let state;
  if (isExternallyManaged(service)) state = STATES.EXTERNAL;
  else if (best) state = STATES.CONNECTED;
  else if (mine.length) state = STATES.ELSEWHERE;
  else state = STATES.NOT_CONNECTED;

  // INT-0-A — "BAĞLI" ≠ "KULLANILABİLİR". Coolify self-hosted: anahtar kayıtlı ama
  // sunucu adresi boşsa kayıt VAR, her araç çağrısı DÜŞER (ölçüldü: "fetch failed").
  // `integrationResolver` böyle bir kaydı pane'e HİÇ vermez; burası o hükmün ajana
  // dönük yüzüdür. ALAN ADI döner, DEĞER dönmez: değer self-hosted host adı olabilir
  // (PII) ve bu cevap ajanın transkriptine düşer (dosya başlığındaki kırmızı çizgi).
  const missingUserFields = best ? missingRequiredUserFields(service, best.meta && best.meta.userFields) : [];

  // "Bu pane'de araç CANLI mı" — `connected` ile AYNI ŞEY DEĞİL (ADR §2.3): config
  // spawn anında yazılır, kullanıcı pane açıkken bağlarsa status 'connected' der ama
  // araç bu pane'de YOKTUR. Ayırmazsak ajan "bağlı ama tool bulamıyorum" diye çıldırır.
  let toolsLive;
  if (state !== STATES.CONNECTED) toolsLive = false;
  // Zorunlu ayarı eksik kayıt spawn'a HİÇ girmez → araç bu pane'de yoktur. Bunu
  // `injected` listesine bırakmıyoruz: o liste pane BİLİNMİYORSA `null` olur ve
  // "emin değilim" derdi; oysa burada emin OLABİLİRİZ (alan boş, çalışamaz).
  else if (missingUserFields.length) toolsLive = false;
  // ENG-21 (G4) — motor ADI değil, ENJEKSİYON HÜKMÜ. Kanal sır taşıyamıyorsa araç
  // bu pane'de yoktur (bugün: codex/gemini/goose… — kural descriptor'dan türer,
  // yarın bir motorun `envInheritance`i ölçülünce burada tek satır bile değişmez).
  else if (pane.integrationsInjectable === false) toolsLive = false;
  else if (!pane.known || injected === null) toolsLive = null; // bilinmiyor — uydurma yok
  else toolsLive = injected.includes(service);

  // Kayıt görünümü: ALAN-ALAN (spread YOK — dosya başlığındaki gerekçe).
  const rec = best || (mine.length ? mine[0] : null);
  const meta = (rec && rec.meta) || {};

  return {
    service,
    label: entry.label || service,
    state,
    // Hangi kayıt konuşuyor: `connected`ta çözümlenen kayıt, `connected-elsewhere`ta
    // ajanın "var ama bu bağlama değil" diyebilmesi için VAR OLAN kaydın kapsamı.
    scope: rec ? rec.scope : null,
    env: rec ? (rec.env === undefined ? null : rec.env) : null,
    // Kullanıcının bağlarken BEYAN ettiği izinler — kesin hüküm değil (ADR §4).
    scopeHint: typeof meta.scopeHint === 'string' && meta.scopeHint ? meta.scopeHint : null,
    keyLabel: typeof meta.keyLabel === 'string' && meta.keyLabel ? meta.keyLabel : null,
    lastUsedAt: toEpochMs(meta.lastUsedAt),
    // ADR §2.4 — "anahtar en son ne zaman GERÇEKTEN çalıştı". null = hiç doğrulanmamış;
    // ajan bunu "bağlı ama doğrulanmamış" diye söyler (sahte güven yok).
    lastVerifiedAt: toEpochMs(meta.lastVerifiedAt),
    // INT-0-D — ÜÇÜNCÜ HÂL. `lastVerifiedAt: null` tek başına "hiç denenmedi" ile
    // "denendi ve OLMADI"yı ayıramıyordu; ajan ikisine AYNI cümleyi kuruyordu.
    // Alan ne olduğunu söyler, NEDENİNİ değil (probe ağ hatasıyla da düşer).
    lastVerifyFailedAt: toEpochMs(meta.lastVerifyFailedAt),
    toolsLiveInThisPane: toolsLive,
    // MCP-LAZY-01 — araç neden bu pane'de YOK: 'profile-gate' ise yeni pane AÇMAK
    // ÇÖZMEZ. null = bilinen bir kapı yok (o zaman eski cümleler geçerli).
    notLiveReason: (() => {
      if (toolsLive !== false) return null;
      const hit = pane.gated.find((g) => g.service === service);
      return hit ? `profile-gate:${hit.source}` : null;
    })(),
    // INT-0-A — kullanıcının Ayarlar'da doldurması gereken, henüz BOŞ olan zorunlu
    // alanların ADLARI (boş dizi = eksik yok). Ajan "eksik ayar: <alan>" diyebilsin;
    // "çalışmıyor" cümlesi neyi dolduracağını söylemeden işe yaramaz.
    missingUserFields,
    // INT-BRIDGE-03'ün yazacağı yetenek kartları. Bugün katalogda YOK → boş dizi.
    // Uydurulmuş yetenek listesi, olmayan bir entegrasyondan daha zararlıdır.
    capabilities: Array.isArray(entry.capabilities) ? entry.capabilities : [],
    connectHint:
      state === STATES.EXTERNAL
        ? entry.managedLabel || 'Ayarlar'
        : `Ayarlar → Entegrasyonlar → ${entry.label || service}`,
    // Yetkisiz durumda "izni nereden alırım" yol tarifi (katalogun keyGuidance'ı).
    // 🔴 BR-04 (ADR §6): AJANA GİDEN metin MÜŞTERİ metnidir. Vendor genişletmesi
    // ("otomatik kurulum için project:write ver") ajanın ağzına girerse ajan
    // müşteriyi BİZİM telemetri akışımız için izin genişletmeye yönlendirir —
    // Eren'in "saçma" dediği sızıntının tam olarak ajan yüzeyindeki hâli.
    permissionHelp: guidance(entry),
    docsUrl: entry.docsUrl || null,
  };
}

/**
 * ADR §2.2 keşif cevabı.
 * @param {object} opts
 * @param {object} opts.catalog                  - integrationCatalog (list/isExternallyManaged)
 * @param {object[]} opts.records                - vault.list() sonucu (toMeta)
 * @param {object} [opts.pane]                   - { engine, agentId, projectId, env, known }
 * @param {string[]|null} [opts.injectedServices]- spawn anında bu pane'e yazılan servisler
 * @param {boolean} [opts.vaultAvailable=true]   - safeStorage yoksa kayıtlar okunamaz
 * @returns {{ok:boolean, pane:object, vaultAvailable:boolean, services:object[]}}
 */
function buildIntegrationsStatus(opts = {}) {
  const catalog = opts.catalog;
  const pane = normalizePane(opts.pane);
  const records = Array.isArray(opts.records) ? opts.records.filter(Boolean) : [];
  const injected = Array.isArray(opts.injectedServices) ? opts.injectedServices.filter((s) => typeof s === 'string') : null;
  const vaultAvailable = opts.vaultAvailable !== false;
  const isExternallyManaged =
    typeof catalog.isExternallyManaged === 'function' ? (s) => catalog.isExternallyManaged(s) : () => false;
  // BR-04 — ajana giden rehber DAİMA müşteri metnidir (vendor:false, sabit).
  // Bayrak PARAMETRE DEĞİL çünkü burada bir seçim YOK: keşif cevabı ajanın ağzına
  // girer, ajanın ağzı müşteriye bakar. Vendor genişletmesi yalnız Ayarlar UI'ında,
  // yalnız vendor build'inde görünür (integrationIpc.catalogView).
  const guidance = typeof catalog.guidanceFor === 'function'
    ? (entry) => catalog.guidanceFor(entry, { vendor: false })
    : (entry) => (typeof entry.keyGuidance === 'string' ? entry.keyGuidance : null);

  // LİSTE DAİMA TAM KATALOGDUR (ADR §2 kural 1): bağlı olmayanlar da döner, yoksa
  // "YOK → bağlarsan yaparım" cümlesi hiç kurulamaz (ajan "böyle bir şey yok" sanır).
  const services = catalog.list().map((entry) => serviceRow(entry, records, pane, injected, isExternallyManaged, guidance));

  return { ok: true, pane, vaultAvailable, services };
}

module.exports = { buildIntegrationsStatus, serviceRow, normalizePane, toEpochMs, STATES };
