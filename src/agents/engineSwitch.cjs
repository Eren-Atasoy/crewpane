// ADP-938 (ADR-MULTI-ACCOUNT-SWITCH Faz 3) — LİMİTTE OTOMATİK HESAP GEÇİŞİ.
//
// NİYET: kullanıcının kendi ikinci aboneliği varsa, aktif hesap limite girdiğinde
// ajan 5 saat park etmek yerine ÖTEKİ hesapla KALDIĞI YERDEN devam etsin.
// ADP-936 profil deposunu (engineProfiles.cjs) YENİDEN YAZMAZ — ÇAĞIRIR.
//
// ── NEDEN AYRI MODÜL ──────────────────────────────────────────────────────
// Tetik `limitDetect` → `resumeDaemonCore.observe()` yolunda. O yol bir P0
// hattıdır (ADP-428/938 erken-devam olayları oradan çıktı), o yüzden çekirdeğe
// yalnız TEK bir çağrı eklendi; KARARIN tamamı burada, saf ve tek başına test
// edilebilir hâlde durur.
//
// ── DÖNGÜ KORUMASI (bu modülün asıl işi) ─────────────────────────────────
// Yanlış profile geçip orada da limit yemek, "sonsuz geçiş" üretir ve kullanıcının
// İKİNCİ aboneliğini de yakar. Dört bağımsız kapı var, hepsi ölçülebilir:
//   1. AYNI profile üst üste geçilmez  — `tried` zinciri (aktif profil de sayılır)
//   2. `attempts` tavanı               — zincir başına en çok MAX_SWITCH_ATTEMPTS
//   3. cooldown                        — aynı ajan SWITCH_COOLDOWN_MS içinde 2 kez geçmez
//   4. defter                          — limitli bilinen profil ADAY OLAMAZ
// Hepsi limitliyse GEÇİŞ YOK: kullanıcıya BİR KEZ söylenir ve iş bugünkü
// davranışa (resumeQueue + resetAt'te devam) bırakılır. Zincir, ajan limitsiz
// çalışmaya döndüğü an sıfırlanır (`noteClear`) — yani tavan "hayat boyu" değil,
// "arka arkaya limit" penceresi içindir.
//
// ── GÜVENLİK ─────────────────────────────────────────────────────────────
//  • VARSAYILAN KAPALI. `enabled()` false iken bu modül HİÇBİR ŞEY yazmaz
//    (defter dosyası bile oluşmaz) → bugünkü davranış bit-bit korunur.
//  • Sır YOK: defter yalnız `profileId → {limitedAt, resetAt}` tutar. Log'a
//    profil KİMLİĞİ ve (varsa) maskelenmiş etiket girer; jeton/dizin ASLA.
//  • Karar İSİMDEN değil DURUMDAN türer — hiçbir yerde profil adı/e-posta
//    karşılaştırması yok, yalnız "limitli mi / denendi mi" durumu.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteFileSync } = require('../../platform/atomicWrite.cjs');
const engineProfiles = require('./engineProfiles.cjs');

/** Limit defteri: hangi profil ne zaman limite girdi (sır YOK, yalnız damga). */
const LEDGER_FILE = 'engine-limit-ledger.json';
/** Bir zincirde en çok kaç kez hesap değiştirilir (döngü koruması #2). */
const MAX_SWITCH_ATTEMPTS = 3;
/** Aynı ajan için iki geçiş arası asgari süre (döngü koruması #3). */
const SWITCH_COOLDOWN_MS = 60_000;
/**
 * `resetAt` okunamadıysa profilin ne kadar limitli SAYILACAĞI. Claude'un oturum
 * penceresi 5 saat; bu bir TAHMİN defteridir (ADR §6.2: kota sorulamıyor), yanılırsa
 * bedeli yalnız "bir tur daha bekledik" olur — yanlış yöne geçmekten ucuz.
 */
const ASSUMED_LIMIT_MS = 5 * 60 * 60_000;
/** Bu yaştan eski kayıtlar defterden düşer (dosya sınırsız büyümesin). */
const MAX_LEDGER_AGE_MS = 7 * 24 * 60 * 60_000;

// ── Saf yardımcılar ─────────────────────────────────────────────────────────

/**
 * Bu profil ŞU AN limitli sayılır mı? `resetAt` biliniyorsa ona, bilinmiyorsa
 * ASSUMED_LIMIT_MS penceresine bakar. Saf.
 */
function isLimited(rec, now) {
  if (!rec || typeof rec !== 'object') return false;
  const at = Number.isFinite(rec.resetAt) ? rec.resetAt : null;
  if (at !== null) return now < at;
  return Number.isFinite(rec.limitedAt) ? now - rec.limitedAt < ASSUMED_LIMIT_MS : false;
}

/**
 * Geçilecek profili seçer. SAF — IO yok, `Date.now` yok; kararın tamamı girdiden
 * türer, bu yüzden döngü koruması testte doğrudan ölçülebilir.
 *
 * @param {object}   a
 * @param {Array}    a.profiles  engineProfiles.listProfiles() çıktısı ([{id,label}])
 * @param {string}   a.activeId  şu anda limite giren profil
 * @param {object}   a.limits    profileId → {limitedAt,resetAt}
 * @param {number}   a.now
 * @param {string[]} a.tried     bu zincirde ZATEN denenmiş profiller
 * @returns {{ok:true, profileId:string} | {ok:false, reason:string}}
 */
function chooseTarget({ profiles, activeId, limits, now, tried }) {
  const list = Array.isArray(profiles) ? profiles.filter((p) => p && typeof p.id === 'string') : [];
  if (list.length < 2) return { ok: false, reason: 'single-account' };
  const seen = new Set([activeId, ...(Array.isArray(tried) ? tried : [])]);
  // Döngü koruması #1: aktif profil ve bu zincirde denenmiş her profil ELENİR.
  const pool = list.filter((p) => !seen.has(p.id));
  if (!pool.length) return { reason: 'no-candidate', ok: false };
  // ACCT-FIX-01 (RESEARCH-ACCT-01 §6.2/2) — aday YALNIZ kimlik damgası olan (giriş
  // yapılmış) profildir. Girişsiz bir kutuya geçmek, pane'i "giriş yap" ekranında
  // bırakır ve limitli hesabı boşuna terk ederdi (K6). Damgasız profiller elenir ve
  // ADIYLA söylenir (`skipped`) — sessiz eleme yok.
  const eligible = pool.filter((p) => p.identity && typeof p.identity === 'object');
  if (!eligible.length) {
    return { ok: false, reason: 'not-logged-in', skipped: pool.map((p) => p.id) };
  }
  const map = limits && typeof limits === 'object' ? limits : {};
  // Döngü koruması #4: limitli bilinen profil aday DEĞİLDİR.
  const free = eligible.filter((p) => !isLimited(map[p.id], now));
  if (!free.length) return { ok: false, reason: 'all-limited' };
  // Hiç limit görmemiş profil önce; sonra limiti en erken biten. Determinist
  // (aynı girdi → aynı çıktı), çünkü kapı testi bunu doğrudan ölçüyor.
  const rank = (id) => {
    const rec = map[id];
    if (!rec) return -1;
    if (Number.isFinite(rec.resetAt)) return rec.resetAt;
    return Number.isFinite(rec.limitedAt) ? rec.limitedAt : -1;
  };
  free.sort((a, b) => rank(a.id) - rank(b.id));
  return { ok: true, profileId: free[0].id };
}

/**
 * ACCT-FIX-01 (§3.4/§5.4 KOL D) — LİMİTE GİREN PROFİL PANE'İNKİDİR, DEFTERDEKİ AKTİF
 * DEĞİL. Pane kaydı `engineProfileId` taşıyorsa (spawn anında çözülen, main.js
 * ptys.set) o kullanılır; taşımıyorsa (eski pane/eski kayıt) defterdeki aktife
 * düşülür — bugünkü davranış. Saf.
 */
function limitedProfileOf(entry, activeId) {
  const id = entry && typeof entry.engineProfileId === 'string' ? entry.engineProfileId : null;
  return id && engineProfiles.isProfileId(id) ? id : activeId;
}

/**
 * ACCT-FIX-01 (§6.2/1) — "BU HESABA GEÇ" SONRASI BAYAT PANE LİSTESİ (saf).
 * Bu motorla koşan ve HEDEF profilde OLMAYAN canlı AJAN pane'leri. Sır yok: pane
 * kimliği + ajan + etiket + profil kimliği + limitte mi. `limited` = ekranda limit
 * metni var (`screenLimited(entry)` — resume daemon'la aynı algılayıcı, enjekte)
 * YA DA pane'in profili limit defterinde hâlâ limitli.
 *
 * @param {Iterable<[string, object]>} panes   ptys Map girdileri
 * @param {object} a
 * @param {string} a.engine
 * @param {string} a.targetProfileId
 * @param {object} [a.limits]          readLedger(...).engines[engine]
 * @param {number} a.now
 * @param {Function} [a.screenLimited] (entry) => boolean
 */
function stalePanesFor(panes, { engine, targetProfileId, limits, now, screenLimited }) {
  const map = limits && typeof limits === 'object' ? limits : {};
  const out = [];
  for (const [paneId, e] of panes || []) {
    if (!e || e.command !== engine) continue;
    // Ajan pane'i: motor GERÇEKTEN koştu (rehber pane'leri ve kabuk dışarıda).
    if (typeof e.agentId !== 'string' || !e.agentId || e.engineMissing || e.workspaceMissing) continue;
    const profileId = typeof e.engineProfileId === 'string' ? e.engineProfileId : null;
    if (profileId === targetProfileId) continue;
    let onScreen = false;
    if (typeof screenLimited === 'function') {
      try { onScreen = screenLimited(e) === true; } catch { onScreen = false; }
    }
    out.push({
      paneId,
      agentId: e.agentId,
      label: e.label || null,
      role: e.role || null,
      profileId,
      limited: onScreen || isLimited(map[profileId || engineProfiles.DEFAULT_PROFILE_ID], now),
      // `--resume` ile açılabilir mi (oturum kimliği var) — yoksa TEMİZ açılır, söylenir.
      resumable: typeof e.sessionId === 'string' && !!e.sessionId,
    });
  }
  return out;
}

/**
 * Kullanıcıya gösterilecek profil adı. Etiket e-posta ise MASKELENİR (log kalıcıdır
 * ve paylaşılır — ADR §7.4). Etiket yoksa kimliğin kendisi yazılır. Saf.
 */
function displayName(profile) {
  if (!profile || typeof profile !== 'object') return '?';
  const label = typeof profile.label === 'string' ? profile.label.trim() : '';
  if (!label) return profile.id;
  const shown = label.includes('@') ? engineProfiles.maskAccount(label) : label;
  return `${shown} (${profile.id})`;
}

// ── Defter (yalnız damga; sır YOK) ──────────────────────────────────────────

function ledgerPath(home) {
  return path.join(String(home || ''), LEDGER_FILE);
}

/** Ham defteri normalize eder: bilinmeyen motor/kimlik ve BAYAT kayıt düşer. Saf. */
function normalizeLedger(raw, now) {
  const out = { version: 1, engines: {} };
  const src = raw && typeof raw === 'object' && raw.engines && typeof raw.engines === 'object' ? raw.engines : {};
  for (const engine of engineProfiles.ENGINES) {
    const recs = src[engine] && typeof src[engine] === 'object' ? src[engine] : {};
    const kept = {};
    for (const [id, rec] of Object.entries(recs)) {
      if (!engineProfiles.isProfileId(id) || !rec || typeof rec !== 'object') continue;
      const limitedAt = Number.isFinite(rec.limitedAt) ? rec.limitedAt : null;
      if (limitedAt === null) continue;
      if (Number.isFinite(now) && now - limitedAt > MAX_LEDGER_AGE_MS) continue;
      kept[id] = { limitedAt, resetAt: Number.isFinite(rec.resetAt) ? rec.resetAt : null };
    }
    out.engines[engine] = kept;
  }
  return out;
}

/** Defteri okur. Eksik/bozuk dosya → boş defter (asla fırlatmaz). */
function readLedger(home, now = Date.now()) {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(ledgerPath(home), 'utf8'));
  } catch {
    raw = null;
  }
  return normalizeLedger(raw, now);
}

/** Defteri yazar (atomik, 0600). Başarısızlık sessizdir — defter bir ipucudur, otorite değil. */
function writeLedger(home, ledger, now = Date.now()) {
  const clean = normalizeLedger(ledger, now);
  try {
    atomicWriteFileSync(ledgerPath(home), `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Bir profili limitli işaretler. `resetAt` bilinmiyorsa null yazılır (tahmin penceresi devreye girer). */
function markLimited(home, engine, profileId, { resetAt = null, now = Date.now() } = {}) {
  if (!engineProfiles.isEngine(engine) || !engineProfiles.isProfileId(profileId)) return false;
  const led = readLedger(home, now);
  led.engines[engine][profileId] = {
    limitedAt: now,
    resetAt: Number.isFinite(resetAt) ? resetAt : null,
  };
  return writeLedger(home, led, now);
}

/** Bir profilin limit kaydını siler (o hesapla çalışıldığı KANITLANDIĞINDA). */
function clearLimit(home, engine, profileId, now = Date.now()) {
  if (!engineProfiles.isEngine(engine) || !engineProfiles.isProfileId(profileId)) return false;
  const led = readLedger(home, now);
  if (!led.engines[engine][profileId]) return false;
  delete led.engines[engine][profileId];
  return writeLedger(home, led, now);
}

// ── Motor ───────────────────────────────────────────────────────────────────

/**
 * Limitte otomatik hesap geçişi. Her dış etki ENJEKTE edilir, böylece tüm durum
 * makinesi sahte saat + sahte depo ile test edilir (resumeDaemonCore deseni).
 *
 * @param {object}   cfg
 * @param {string}   cfg.home          crewpane home (defterin yeri)
 * @param {Function} cfg.enabled       () => boolean — AYAR (varsayılan KAPALI)
 * @param {Function} cfg.listProfiles  (engine) => [{id,label}]
 * @param {Function} cfg.activeProfile (engine) => profileId
 * @param {Function} cfg.setActive     (engine, profileId) => {ok:boolean}
 * @param {Function} cfg.switchPane    (entry, profileId) => {ok:boolean, paneId?:string}
 * @param {number}   [cfg.maxAttempts]
 * @param {number}   [cfg.cooldownMs]
 * @param {Function} [cfg.log]
 */
class AutoAccountSwitcher {
  constructor(cfg = {}) {
    this.home = cfg.home;
    this.enabled = typeof cfg.enabled === 'function' ? cfg.enabled : () => false;
    this.listProfiles = typeof cfg.listProfiles === 'function' ? cfg.listProfiles : () => [];
    this.activeProfile =
      typeof cfg.activeProfile === 'function' ? cfg.activeProfile : () => engineProfiles.DEFAULT_PROFILE_ID;
    this.setActive = typeof cfg.setActive === 'function' ? cfg.setActive : () => ({ ok: false });
    this.switchPane = typeof cfg.switchPane === 'function' ? cfg.switchPane : null;
    this.maxAttempts =
      Number.isInteger(cfg.maxAttempts) && cfg.maxAttempts >= 1 ? cfg.maxAttempts : MAX_SWITCH_ATTEMPTS;
    this.cooldownMs = Number.isFinite(cfg.cooldownMs) ? cfg.cooldownMs : SWITCH_COOLDOWN_MS;
    this.log = typeof cfg.log === 'function' ? cfg.log : () => {};
    /** agentId/paneRef → { tried:string[], count:number, lastAt:number, told:Set<string> } */
    this._chains = new Map();
  }

  _chainKey(entry) {
    return (entry && (entry.agentId || entry.paneRef)) || '?';
  }

  _chain(entry) {
    const key = this._chainKey(entry);
    let c = this._chains.get(key);
    if (!c) {
      c = { tried: [], count: 0, lastAt: 0, told: new Set() };
      this._chains.set(key, c);
    }
    return c;
  }

  /**
   * Ajan limitsiz çalışıyor → zincir SIFIRLANIR. Bu, tavanın "hayat boyu" değil
   * "arka arkaya limit" penceresi olmasını sağlar; ayrıca o an koşan profilin
   * limit kaydı defterden düşer (o hesapla çalışabildiğimizin KANITI ekranda).
   */
  noteClear(entry, now = Date.now()) {
    const key = this._chainKey(entry);
    const chain = this._chains.get(key);
    if (chain) this._chains.delete(key);
    if (!chain || !chain.count) return;
    if (!this.enabled()) return;
    const engine = entry && entry.engine;
    if (!engineProfiles.isEngine(engine)) return;
    try {
      // 🪤 `now` ENJEKTE edilir: duvar saatiyle okunan defter, bayat-kayıt süzgeci
      // yüzünden silinecek kaydı zaten düşürmüş olur ve silme sessizce no-op'a
      // döner (bu testte yakalandı).
      clearLimit(this.home, engine, limitedProfileOf(entry, this.activeProfile(engine)), now);
    } catch {
      /* defter best-effort */
    }
  }

  /**
   * ADP-089 dry-run: NE YAPACAĞINI söyler, HİÇBİR ŞEY değiştirmez — defter
   * yazılmaz, aktif profil değişmez, pane'e dokunulmaz. Kapıyı canlıya almadan
   * önce gerçek fikstürlerle satırları okumak için.
   */
  previewSwitch(entry, now) {
    if (!this.enabled()) return { switched: false, reason: 'disabled', message: null };
    const engine = entry && entry.engine;
    if (!engineProfiles.isEngine(engine)) {
      return { switched: false, reason: 'unsupported-engine', message: null };
    }
    const active = limitedProfileOf(entry, this.activeProfile(engine));
    const profiles = this.listProfiles(engine);
    const limits = readLedger(this.home, now).engines[engine] || {};
    const chain = this._chains.get(this._chainKey(entry)) || { tried: [] };
    const pick = chooseTarget({ profiles, activeId: active, limits, now, tried: chain.tried });
    const byId = new Map(profiles.map((p) => [p.id, p]));
    const from = displayName(byId.get(active) || { id: active });
    if (!pick.ok) {
      return { switched: false, reason: pick.reason, message: `${from} limitte → geçiş YAPILAMAZDI (${pick.reason})` };
    }
    const to = displayName(byId.get(pick.profileId) || { id: pick.profileId });
    return { switched: false, reason: 'dryrun', to: pick.profileId, message: `${from} limitte → ${to} hesabına geçilecekti` };
  }

  /**
   * Limit görüldü → geçilebilir mi? Tek karar noktası.
   *
   * @param {object} entry  { engine, agentId, paneRef, resetAt?, raw? }
   * @param {number} now
   * @returns {{switched:boolean, reason:string, from?:string, to?:string, paneId?:string, message:?string}}
   *          `message` null değilse ÇAĞIRAN onu kullanıcıya BASMAK ZORUNDADIR
   *          (sessiz geçiş yasak — ADR §9). Aynı zincirde aynı sebep iki kez
   *          mesaj üretmez (log spam'i yok, bilgi kaybı da yok).
   */
  trySwitch(entry, now) {
    // Ayar KAPALI → motor hiç uyanmaz. Defter dosyası bile oluşmaz.
    if (!this.enabled()) return { switched: false, reason: 'disabled', message: null };
    if (!this.switchPane) return { switched: false, reason: 'no-switch-io', message: null };
    const engine = entry && entry.engine;
    if (!engineProfiles.isEngine(engine)) {
      return { switched: false, reason: 'unsupported-engine', message: null };
    }

    const chain = this._chain(entry);
    const say = (reason, text) => {
      if (chain.told.has(reason)) return null;
      chain.told.add(reason);
      return text;
    };

    // Döngü koruması #3 — aynı ajan için art arda geçiş yok. Geçiş bir RE-SPAWN'dır;
    // yeni pane'in açılıp limitini basması saniyeler sürebilir, o pencerede ikinci
    // bir geçiş kararı vermek zincirin tamamını saniyeler içinde tüketirdi.
    if (chain.lastAt && now - chain.lastAt < this.cooldownMs) {
      return { switched: false, reason: 'cooldown', message: null };
    }

    // ACCT-FIX-01 — limite giren hesap PANE'İN hesabıdır (§5.4 KOL D kapanır): defter
    // A'ya çevrilmişken B ile koşan pane limit yerse "A limitli" yazılmaz, B yazılır.
    const registryActive = this.activeProfile(engine);
    const active = limitedProfileOf(entry, registryActive);
    // Limite GİREN profil deftere işlenir — bu, "müsait" tanımının tek kaynağı.
    try {
      markLimited(this.home, engine, active, { resetAt: entry && entry.resetAt, now });
    } catch {
      /* defter yazılamasa da karar verilebilir (aşağıdaki okuma boş defterle çalışır) */
    }

    // Döngü koruması #2 — tavan. Tavana varınca DURULUR ve söylenir.
    if (chain.count >= this.maxAttempts) {
      return {
        switched: false,
        reason: 'attempts-exhausted',
        message: say(
          'attempts-exhausted',
          `otomatik hesap geçişi DURDURULDU — ${chain.count} geçişten sonra limit yine geldi ` +
            `(tavan ${this.maxAttempts}). İş bekletiliyor, limit yenilenince devam edilecek.`,
        ),
      };
    }

    const profiles = this.listProfiles(engine);
    const limits = readLedger(this.home, now).engines[engine] || {};
    const pick = chooseTarget({ profiles, activeId: active, limits, now, tried: chain.tried });
    if (!pick.ok) {
      const byId = new Map(profiles.map((p) => [p.id, p]));
      const fromName = displayName(byId.get(active) || { id: active });
      // ACCT-FIX-01 (K6) — girişi kayıtlı olmayan kutular ADIYLA söylenir.
      const skippedNames = Array.isArray(pick.skipped)
        ? pick.skipped.map((id) => displayName(byId.get(id) || { id })).join(', ')
        : '';
      const messages = {
        'single-account': null, // tek hesaplı kullanıcı: söylenecek bir şey yok
        'no-candidate': `otomatik hesap geçişi DURDURULDU — ${fromName} limitte ve bu turda denenmemiş başka hesap kalmadı. İş bekletiliyor.`,
        'all-limited': `otomatik hesap geçişi DURDURULDU — TÜM hesaplar limitte (${fromName} dahil). İş bekletiliyor, ilk yenilenen hesapla devam edilecek.`,
        'not-logged-in': `otomatik hesap geçişi YAPILAMADI — ${fromName} limitte; ${skippedNames} için giriş kaydı yok (Ayarlar → Hesaplar'dan giriş yapın). İş bekletiliyor.`,
      };
      const text = messages[pick.reason];
      return {
        switched: false,
        reason: pick.reason,
        message: text ? say(pick.reason, text) : null,
      };
    }

    const byId = new Map(profiles.map((p) => [p.id, p]));
    const fromName = displayName(byId.get(active) || { id: active });
    const toName = displayName(byId.get(pick.profileId) || { id: pick.profileId });

    const set = this.setActive(engine, pick.profileId);
    if (!set || set.ok !== true) {
      return {
        switched: false,
        reason: 'set-active-failed',
        message: say('set-active-failed', `hesap geçişi yapılamadı — ${toName} aktif edilemedi. İş bekletiliyor.`),
      };
    }

    let res = null;
    try {
      res = this.switchPane(entry, pick.profileId);
    } catch {
      res = null;
    }
    if (!res || res.ok !== true) {
      // Geri al: denenmemiş bir hesabı "aktif" bırakıp sonraki pane'i oraya
      // göndermek, ölçülmemiş bir hesapla sessizce çalışmak olurdu. Geri alınan
      // DEFTERİN aktifidir (pane'in profili değil — ikisi ayrışmış olabilir).
      try {
        this.setActive(engine, registryActive);
      } catch {
        /* geri alma best-effort */
      }
      return {
        switched: false,
        reason: 'respawn-failed',
        message: say(
          'respawn-failed',
          `hesap geçişi yapılamadı — ${toName} ile pane yeniden açılamadı, ${fromName} aktif kaldı. İş bekletiliyor.`,
        ),
      };
    }

    chain.tried.push(active);
    chain.count += 1;
    chain.lastAt = now;
    chain.told.clear(); // yeni durum → yeni sebepler yeniden söylenebilir
    this.log(
      `engine auto-switch: engine=${engine} from=${active} to=${pick.profileId} agent=${entry.agentId || '-'}`,
    );
    return {
      switched: true,
      reason: 'switched',
      from: active,
      to: pick.profileId,
      paneId: res.paneId || null,
      // Sessiz geçiş YASAK: hangi hesaptan hangisine ve NEDEN — tek satırda.
      message:
        `hesap limitte → OTOMATİK GEÇİŞ: ${fromName} → ${toName} ` +
        `(${chain.count}/${this.maxAttempts}) — oturum korunarak devam ediliyor`,
    };
  }
}

module.exports = {
  LEDGER_FILE,
  MAX_SWITCH_ATTEMPTS,
  SWITCH_COOLDOWN_MS,
  ASSUMED_LIMIT_MS,
  MAX_LEDGER_AGE_MS,
  // saf
  isLimited,
  chooseTarget,
  displayName,
  limitedProfileOf,
  stalePanesFor,
  normalizeLedger,
  // defter
  ledgerPath,
  readLedger,
  writeLedger,
  markLimited,
  clearLimit,
  // motor
  AutoAccountSwitcher,
};
