// ENG-16 (SPRINT-ENGINE-03) — SATICI-BARINDIRILAN BEDAVA KAPI: ÖLÇ, SÖYLE, GEREKİRSE KAPAT.
//
// ── NEDEN VAR ───────────────────────────────────────────────────────────────
// ENG-R2 §2.4 bir motorun (opencode) HİÇBİR kimlik olmadan cevap verdiğini ölçtü:
// `opencode auth list` → "0 credentials", ama `run` çalışıyor ve log şunu diyor:
// `llm.provider=opencode llm.model=big-pickle`, `"cost":0`. Yani ne kullanıcının
// anahtarı, ne aboneliği, ne bizim anahtarımız kullanılıyor — SATICININ KENDİ
// bedava kapısı. `tokenUsage.billingFor` üç kip biliyordu (subscription|api|unknown)
// ve ÜÇÜ DE bu durumda YALAN söylerdi.
//
// Asıl mesele fiyat değil GİZLİLİK: o pane'e verilen kod ve dosya içerikleri
// üçüncü bir tarafın sunucusundan geçiyor. ADP-628'in ürün sözü ("bizim
// anahtarımız ASLA kullanılmaz") teknik olarak bozulmuyor ama kullanıcının
// duyduğu söz — "kodum benim seçtiğim sağlayıcıya gider" — sessizce bozuluyordu.
//
// ── EREN KARARI (2026-08-18) ───────────────────────────────────────────────
// Motor ürüne GİRER, ama `vendor-hosted` ROZETİYLE: kullanıcı bu cümleyi pane/hesap
// kartında GÖRÜR. Bedava kapıyı tamamen kapatmak da TEK SATIR ayarla mümkün olsun
// (`engines.<motor>.vendorHosted` = 'allow' | 'block'); ileride hesap genelinde
// "yalnız kendi anahtarım" kilidi gelecek (bu görevde DEĞİL — descriptor'daki
// `futureLock` alanı o kararı taşıyor).
//
// ── MOTOR ADI DALI YOK ──────────────────────────────────────────────────────
// Bu modül `id === 'opencode'` DEMEZ. Her şey descriptor'ın
// `usage.billing.vendorHosted` beyanından okunur; beyan etmeyen motorda TÜM
// fonksiyonlar no-op döner (bugünkü davranış bit-bit aynı). Yeni bir motorun
// bedava kapısı çıkarsa değişecek yer DEFTERDİR, bu dosya değil
// ([[feedback_no_hardcoded_brand_cases]]).

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const engineRegistry = require('./engineRegistry.cjs');

/** Varsayılan politika, descriptor beyan etmezse (fail-open: bugünkü davranış). */
const DEFAULT_POLICY = 'allow';

/** Bir motorun `vendorHosted` beyanı (yoksa `null` — beyan etmeyen motor NO-OP). */
function vendorSpecOf(engine, opts = {}) {
  const reg = opts.registry || engineRegistry;
  const usage = typeof engine === 'string' && engine ? reg.capability(engine, 'usage') : null;
  const spec = usage && usage.billing && usage.billing.vendorHosted ? usage.billing.vendorHosted : null;
  return spec || null;
}

/**
 * Beyan edilen kimlik defteri yolunu çözer. YALNIZ tanınan kökler (`~`, mutlak yol);
 * tanınmayan kök UYDURULMAZ → `null` (durum 'unknown' kalır, "bedava" DENMEZ).
 */
function resolveCredentialsFile(spec, opts = {}) {
  const raw = spec && typeof spec.credentialsFile === 'string' ? spec.credentialsFile : '';
  if (!raw) return null;
  if (opts.credentialsFile) return opts.credentialsFile; // test/çağıran dikişi
  const home = opts.homedir || os.homedir();
  if (raw.startsWith('~/')) return path.join(home, ...raw.slice(2).split('/'));
  if (path.isAbsolute(raw)) return raw;
  return null;
}

/**
 * Kimlik defterinde GERÇEKTEN kayıt var mı?
 * @returns {true|false|null} `null` = ÖLÇÜLEMEDİ (bozuk JSON) — "yok" ile aynı şey DEĞİL.
 */
function hasCredentials(file) {
  if (!file) return null;
  let raw = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // Dosyanın YOKLUĞU bir ölçümdür ("0 credentials"); okuma izni hatası DEĞİLDİR.
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return false;
    return null;
  }
  try {
    const json = JSON.parse(raw);
    if (!json || typeof json !== 'object') return false;
    return Object.keys(json).length > 0;
  } catch {
    return null; // bozuk defter → ölçemedik
  }
}

/**
 * Bu motor ŞU AN satıcı kapısından mı koşuyor?
 *
 * @returns {{ vendorHosted: boolean|null, vendorLabel: string|null, disclosure: string|null,
 *             reason: string, policy: string, blockedHint: string|null, futureLock: string|null }}
 *   `vendorHosted:null` → ölçülemedi; ekran bir İDDİADA BULUNMAZ.
 *   Beyan etmeyen motor → `vendorHosted:false` + reason 'beyan yok'.
 */
function vendorHostedState(engine, opts = {}) {
  const spec = vendorSpecOf(engine, opts);
  const policy = resolvePolicy(engine, opts);
  const base = { vendorHosted: false, vendorLabel: null, disclosure: null, blockedHint: null, futureLock: null, policy };
  if (!spec) return { ...base, reason: 'bu motorda satıcı-barındırılan bedava kapı BEYAN EDİLMEMİŞ' };

  const shared = {
    vendorLabel: spec.vendorLabel || null,
    disclosure: spec.disclosure || null,
    blockedHint: spec.blockedHint || null,
    futureLock: spec.futureLock || null,
    policy,
  };

  // ENV anahtarı varsa fatura KULLANICININDIR — kapı devrede değil.
  const env = opts.env || process.env;
  const usage = (opts.registry || engineRegistry).capability(engine, 'usage');
  const apiKeyEnv = usage && usage.billing ? usage.billing.apiKeyEnv : null;
  if (apiKeyEnv && env[apiKeyEnv]) {
    return { ...shared, vendorHosted: false, reason: `${apiKeyEnv} ortamda: istekler kullanıcının anahtarıyla gider` };
  }

  const file = resolveCredentialsFile(spec, opts);
  const has = hasCredentials(file);
  if (has === null) {
    return { ...shared, vendorHosted: null, reason: `kimlik defteri okunamadı (${file || 'yol çözülemedi'}) → ölçülemedi` };
  }
  if (has) {
    return { ...shared, vendorHosted: false, reason: `kimlik defterinde kayıt var (${file}) → istekler kullanıcının sağlayıcısına gider` };
  }
  return {
    ...shared,
    vendorHosted: true,
    reason: `kimlik defteri BOŞ/YOK (${file}) → istekler ${spec.vendorLabel || 'satıcının'} kendi sunucusundan geçiyor`,
  };
}

/**
 * Bu motorun bedava kapı POLİTİKASI. Ayar yolunu descriptor SÖYLER
 * (`policySetting`, ör. 'engines.opencode.vendorHosted') → ürün ayarları
 * `opts.settings` ile verilir. Tanınmayan değer varsayılana düşer (sessizce
 * "block" olmaz: kullanıcıyı yazım hatası yüzünden pane'siz bırakmak yanlış olurdu).
 */
function resolvePolicy(engine, opts = {}) {
  const spec = vendorSpecOf(engine, opts);
  if (!spec) return DEFAULT_POLICY;
  const fallback = engineRegistry.VENDOR_GATE_POLICIES.includes(spec.defaultPolicy) ? spec.defaultPolicy : DEFAULT_POLICY;
  if (opts.policy && engineRegistry.VENDOR_GATE_POLICIES.includes(opts.policy)) return opts.policy;
  const raw = pickSetting(opts.settings, spec.policySetting);
  return engineRegistry.VENDOR_GATE_POLICIES.includes(raw) ? raw : fallback;
}

/** `a.b.c` yol okuması (ara düğüm yoksa undefined — throw ETMEZ). */
function pickSetting(obj, dotted) {
  if (!obj || typeof obj !== 'object' || typeof dotted !== 'string' || !dotted) return undefined;
  let cur = obj;
  for (const seg of dotted.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * SPAWN KAPISI — pane açılmalı mı?
 *
 * İKİ DAVRANIŞ (board DoD'u: "iki davranışı da testle"):
 *   • policy 'allow'  → `{ blocked: false }` + rozet cümlesi (kullanıcı GÖRÜR ve koşar)
 *   • policy 'block'  → `{ blocked: true, banner }` YALNIZ gerçekten satıcı kapısındaysa;
 *     kullanıcı kendi sağlayıcısını bağlamışsa aynı ayarla pane NORMAL açılır.
 *
 * 🔒 FAIL-OPEN, BİLEREK: ölçüm yapılamadıysa (`vendorHosted === null`) pane
 * ENGELLENMEZ. Ölçemediğimiz bir şey yüzünden kullanıcıyı çalışan bir motordan
 * etmek, ADP-833'ün "yok" ile "ölçemedim"i ayıran disiplininin ta kendisidir.
 */
function vendorGateVerdict(engine, opts = {}) {
  const state = vendorHostedState(engine, opts);
  if (state.policy !== 'block' || state.vendorHosted !== true) {
    return { blocked: false, policy: state.policy, vendorHosted: state.vendorHosted, reason: state.reason, banner: null, state };
  }
  return {
    blocked: true,
    policy: state.policy,
    vendorHosted: true,
    reason: state.reason,
    banner: blockedBanner(engine, state),
    state,
  };
}

/** Kapı KAPALIYKEN pane'e basılan metin (engineInstall rehber pane'i ile aynı kalıp). */
function blockedBanner(engine, state) {
  const label = state.vendorLabel || engine;
  return [
    '',
    `  ⛔  Bu motor (${engine}) ŞU AN ${label} sunucusundan koşacaktı — ürün ayarı buna İZİN VERMİYOR.`,
    '',
    `  ${state.disclosure || ''}`,
    '',
    `  Ne yapmalı: ${state.blockedHint || 'kendi sağlayıcı hesabını bağla.'}`,
    '',
  ].join('\n');
}

module.exports = {
  DEFAULT_POLICY,
  vendorSpecOf,
  vendorHostedState,
  resolvePolicy,
  vendorGateVerdict,
  blockedBanner,
  hasCredentials,
  resolveCredentialsFile,
};
