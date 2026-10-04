// ADP-341 (ADR-026 §2/§4) — TARAYICI GÜVEN KAPISI: browserTrust'ın SAF kararını
// gerçek kapıya bağlayan katman (karar + oturum izinleri + audit + DURDUR).
//
// Bölüşüm (bilerek):
//   browserTrust.cjs → KARAR (saf: origin × hedef × eylem × mod). IO yok.
//   browserGate.cjs  → KARARIN YAŞADIĞI YER: ayarları okur, oturum izinlerini tutar,
//                      her eylemi (onaysız koşanlar DAHİL) maskeli audit'e yazar,
//                      DURDUR düğmesini uygular.
//   delegationBridge → taşıma (HTTP + onay round-trip'i). Karar KOPYALANMAZ, çağrılır.
//
// Karar MAIN'de kalır: origin `guest.getURL()`'den (ajanın payload'ından DEĞİL), hedef
// eleman CDP ile EYLEMDEN ÖNCE ölçülür. Sayfanın metni ya da ajanın uydurduğu bir alan
// kararı değiştiremez (prompt-injection savunması).

'use strict';

const fs = require('fs');
const path = require('path');
const instancePaths = require('../config/instancePaths.cjs'); // ADP-206 — instance-scoped home
const trust = require('./browserTrust.cjs'); // ADP-340 — saf karar çekirdeği

const AUDIT_FILE = 'browser-audit.jsonl';

// ADP-343 — otomasyon modu ("bu oturumda sorma") süre seçenekleri (dakika). Kalıcı DEĞİL:
// oturumluk, bellekte durur — uygulama kapanınca (ve DURDUR'a basılınca) yok olur.
const AUTOMATION_MINUTES = Object.freeze([15, 30, 60]);
const DEFAULT_AUTOMATION_MINUTES = 30;
const MAX_AUTOMATION_MINUTES = 120;

/**
 * Ayarların güven bölümü — ADP-343'te `agentSettings` şemasına girdi (browserTrust), ama
 * kapı yine DOSYADAN okur, bilerek: `agentSettings.readSettings()` süreç içi cache tutar,
 * kapı ise HER kararda taze değer ister (mod değişikliği canlı etkili olmalı; adp344-S6
 * bunu diske yazıp kanıtlar). Şema aynı dosyayı yazdığı için tek gerçek korunur.
 */
function readTrustSettingsFromDisk(homeDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(homeDir, 'settings.json'), 'utf8'));
    return raw && typeof raw === 'object' && raw.browserTrust ? { browserTrust: raw.browserTrust } : {};
  } catch {
    return {}; // dosya yok / bozuk JSON → varsayılan (normal mod)
  }
}

/**
 * @param {object} [opts]
 * @param {() => object} [opts.resolveSettings]  { browserTrust: {mode,trustedOrigins,blockedOrigins} }
 * @param {string} [opts.auditPath]              jsonl yolu (test seam — GERÇEK ev dizinine yazma!)
 * @param {() => number} [opts.now]              saat (saf test)
 * @param {(m:string)=>void} [opts.log]
 */
function createBrowserGate(opts = {}) {
  const home = instancePaths.crewpaneHome();
  const auditPath = opts.auditPath || path.join(home, AUDIT_FILE);
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const resolveSettings =
    typeof opts.resolveSettings === 'function' ? opts.resolveSettings : () => readTrustSettingsFromDisk(home);

  const grants = trust.createGrantStore();
  // DURDUR sayacı: her basışta artar. Onay round-trip'i BAŞLAMADAN önce okunur, dönünce
  // karşılaştırılır → kullanıcı beklerken DURDUR'a bastıysa gelen "izin ver" YOK sayılır.
  let stopEpoch = 0;
  // ADP-343 — otomasyon modu penceresinin BİTİŞ anı (ms). 0 = kapalı. Diske YAZILMAZ:
  // kalıcı güven yalnız Ayarlar listesinden verilir; bu, süresi dolunca kendiliğinden
  // kapanan geçici bir anahtardır (ve DURDUR onu da kapatır).
  let automationUntil = 0;
  const automationActive = () => automationUntil > now();

  /** Oturum izni anahtarı: görev (delegasyon) varsa o, yoksa ajan (ADR-026 §2.4). */
  const grantKey = (value) =>
    (value && (value.delegationId || value.agentId) ? String(value.delegationId || value.agentId).trim() : '') || '';

  return {
    /**
     * Bir eylemin kaderini belirle. `probe` = main'in CDP ile ölçtüğü gerçek bağlam
     * ({url, elementInfo}); okuma eylemlerinde gerekmez (okuma her zaman serbest).
     * @returns {{decision:'allow'|'ask'|'ask-session'|'deny', reason:string, level:string,
     *            sensitive:boolean, origin:string|null, mode:string, scope?:string, key:string}}
     */
    decide(value, probe = {}, source = 'agent') {
      const key = grantKey(value);
      const d = trust.decide({
        action: value.action,
        url: probe.url, // main'den — ajanın payload'ından DEĞİL
        elementInfo: probe.elementInfo || null,
        text: value.text,
        settings: resolveSettings(),
        grants,
        key,
        now: now(),
        source,
        automation: automationActive(), // ADP-343 — süre sınırlı "bu oturumda sorma"
      });
      return { ...d, key };
    },

    /**
     * ADP-343 (ADR-026 §2.5) — otomasyon modu: "şimdi izleyeceğim, sorma". Süre sınırlı,
     * oturumluk. Hassas hedef ve YASAK origin bundan ETKİLENMEZ (kart yine çıkar / eylem
     * yine reddedilir) — bu bir "her şeye izin" anahtarı değil, gürültü kısma anahtarıdır.
     * @param {number|null} minutes  dakika (null/0 → kapat; tavan MAX_AUTOMATION_MINUTES)
     */
    setAutomation(minutes) {
      const m = Number(minutes);
      if (!Number.isFinite(m) || m <= 0) {
        automationUntil = 0;
        log('browser trust: otomasyon modu KAPATILDI');
        return this.automation();
      }
      const capped = Math.min(Math.max(1, Math.round(m)), MAX_AUTOMATION_MINUTES);
      automationUntil = now() + capped * 60_000;
      log(`browser trust: otomasyon modu ${capped} dk açıldı`);
      return this.automation();
    },
    /** Otomasyon modunun canlı durumu (UI geri sayımı buradan besleniyor). */
    automation() {
      const active = automationActive();
      return {
        active,
        until: active ? automationUntil : 0,
        remainingMs: active ? automationUntil - now() : 0,
        minutes: AUTOMATION_MINUTES,
      };
    },

    /** Görev boyunca izin (kart: "bu görev boyunca izin ver"). Diske YAZILMAZ. */
    grantSession(key, origin) {
      const ok = grants.grant(key, origin, { now: now() });
      if (ok) log(`browser trust: oturum izni verildi (${key} → ${origin})`);
      return ok;
    },
    /** Ret de bir karardır: bu görev boyunca o origin bir daha SORULMAZ, reddedilir. */
    denySession(key, origin) {
      const ok = grants.deny(key, origin);
      if (ok) log(`browser trust: oturum reddi (${key} → ${origin})`);
      return ok;
    },
    /** İzinli origin'de koşan eylem izin bütçesinden düşer (TTL + eylem tavanı). */
    consume(key, origin) {
      return grants.consume(key, origin, now());
    },

    /**
     * DURDUR (ADR-026 §3.3): tüm oturum izinleri iptal + bekleyen onaylar geçersiz.
     * ADP-343 — otomasyon modu da KAPANIR: "durdur" dedikten sonra hâlâ sessizce koşan
     * bir pencere bırakmak, düğmeyi yalancı yapardı.
     */
    stopAll() {
      const revoked = grants.revokeAll();
      const wasAutomation = automationActive();
      automationUntil = 0;
      stopEpoch += 1;
      log(`browser trust: DURDUR — ${revoked} oturum izni iptal edildi${wasAutomation ? ' + otomasyon modu kapatıldı' : ''}`);
      return { revoked, epoch: stopEpoch, automationStopped: wasAutomation };
    },
    epoch() {
      return stopEpoch;
    },

    /**
     * ADR-026 §4 — audit: her eylem, ONAYSIZ KOŞANLAR DAHİL. Hassas metin ASLA ham
     * yazılmaz (`•••(n)`). Yazma best-effort: audit yazılamıyor diye eylem düşmez.
     */
    audit(entry) {
      const rec = {
        at: new Date(now()).toISOString(),
        agentId: entry.agentId || null,
        delegationId: entry.delegationId || null,
        origin: entry.origin || null,
        action: entry.action || null,
        selector: entry.selector || null,
        textPreview: trust.maskPreview(entry.text, entry.sensitive),
        decision: entry.decision || null,
        reason: entry.reason || null,
        level: entry.level || null,
        sensitive: !!entry.sensitive,
        mode: entry.mode || null,
        source: entry.source || 'agent',
        ok: entry.ok === true,
      };
      try {
        fs.mkdirSync(path.dirname(auditPath), { recursive: true });
        fs.appendFileSync(auditPath, JSON.stringify(rec) + '\n');
      } catch (err) {
        log(`browser audit yazılamadı: ${err.message}`);
      }
      return rec;
    },

    /** Onay kartına/loga giden metin: sır ASLA ham gösterilmez (`•••(n)`). */
    preview(text, sensitive) {
      return trust.maskPreview(text, sensitive);
    },

    auditPath: () => auditPath,
  };
}

// Tek örnek (main + bridge aynı izin defterini ve DURDUR sayacını paylaşmalı).
let singleton = null;
function getBrowserGate(opts) {
  if (!singleton) singleton = createBrowserGate(opts);
  return singleton;
}

module.exports = {
  createBrowserGate,
  getBrowserGate,
  readTrustSettingsFromDisk,
  AUDIT_FILE,
  AUTOMATION_MINUTES, // ADP-343
  DEFAULT_AUTOMATION_MINUTES,
};
