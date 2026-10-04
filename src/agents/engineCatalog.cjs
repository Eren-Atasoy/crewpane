// ADP-915 (SPRINT-FIRST-CUSTOMER) — "Motorlar & Maliyet": ürünün HANGİ motoru
// kullandığı ve PARANIN NEREDEN gittiği sorusunun TEK makine-okur cevabı.
//
// ── NEDEN VAR ────────────────────────────────────────────────────────────────
// Eren müşteriyle konuşurken "neyle karşılaşacak, fatura kime çıkar" sorusunun
// cevabını üründe GÖSTEREMİYORDU. Cevap koda dağılmış hâlde ZATEN vardı:
//   • beyin  → jarvisVoice (`claude -p` + deterministik yerel yedek)
//   • STT    → jarvisVoice.resolveSttEngine ('local' whisper.cpp | 'openai')
//   • TTS    → ttsProviders.ttsConfig (say/openai/elevenlabs/azure + fiyat)
//   • kapı   → requireCredential.SERVICES (ADP-628 BYO-key / FATURA KORUMASI)
// Bu modül onları TEKRAR YAZMAZ; okur ve tek bir anlık-görüntüde toplar.
//
// ── 🔴 TEK KURAL: ELLE METİN YOK, TÜRETME VAR ───────────────────────────────
// Ayarlar ekranı bu payload'ı çizer. Yarın `ttsProviders.TTS_PROVIDERS`'a bir
// motor eklendiğinde ya da STT'ye üçüncü bir motor geldiğinde ekran KENDİLİĞİNDEN
// doğru kalır — çünkü liste burada da elle yazılmaz, kaynak modülden gelir.
// Bunun bedeli: STT ve beyin motorlarının kaydı ARTIK BURADA yaşar ve
// `jarvisVoice` onu buradan okur (eskiden `DEFAULT_STT_ENGINE` ile iki satırlık
// bir `if` idi; ikinci kopya olmasın diye taşındı).
//
// ── DİL ──────────────────────────────────────────────────────────────────────
// Bu payload İNSAN CÜMLESİ TAŞIMAZ (ADP-899 kapısı): yalnız makine alanları
// (tier/kind/credential/hasKey/cost) + ÜRÜN ADLARI (özel isim; çevrilmez).
// Cümleleri renderer sözlükten kurar. `label: null` = ürün adı yok, o motorun
// adını renderer çevirir (yerel whisper, yerel yedek çözümleyici).
//
// Saf + DI: `electron` require'ı YOK, tüm dış dünya ctx'ten enjekte edilebilir
// → `node --test` ile koşar.

'use strict';

const ttsProviders = require('../voice/ttsProviders.cjs');
const credentialGate = require('../security/requireCredential.cjs');
const engineAuth = require('./engineAuth.cjs');

// ── Yetenek kimlikleri ───────────────────────────────────────────────────────
/** Ekranda bu SIRAYLA çizilir: önce düşünen, sonra duyan, sonra konuşan. */
const CAPABILITIES = Object.freeze(['brain', 'stt', 'tts']);

// ── BEYİN (komut anlama / görev çağırma) ─────────────────────────────────────
/**
 * `claude -p` ile konuşulan CLI. Bu bir API anahtarı DEĞİL: kullanıcının kendi
 * Claude oturumu (abonelik ya da kendi API anahtarı) üstünden çalışır, yani
 * `requireCredential` kaydı YOKTUR ve fatura doğrudan ona işlenir.
 * `bin` alanı jarvisVoice'un varsayılan `claudeBin`'idir — ikinci kopya yok.
 */
const BRAIN_CLI = 'claude';
const BRAIN_ENGINES = Object.freeze([
  Object.freeze({
    id: BRAIN_CLI,
    bin: BRAIN_CLI,
    // Ürün adı — motor kaydının TEK sahibi engineAuth (Ayarlar'daki giriş kartı
    // da aynı etiketi gösterir; iki yerde iki ad yazsaydı sessizce ayrışırlardı).
    label: (engineAuth.ENGINE_AUTH_META[BRAIN_CLI] || {}).label || BRAIN_CLI,
    tier: 'subscription',
    kind: 'cli',
    credential: null,
    primary: true,
  }),
  Object.freeze({
    // Deterministik Türkçe çözümleyici (jarvisVoice.parseIntent). Claude yoksa
    // temel komutlar YİNE çalışır — ürün "anahtar yok" diye susmaz.
    id: 'local-parser',
    bin: null,
    label: null, // ürün adı yok → renderer çevirir
    tier: 'free',
    kind: 'local',
    credential: null,
    primary: false,
  }),
  Object.freeze({
    id: 'jev',
    bin: 'jev',
    label: (engineAuth.ENGINE_AUTH_META['jev'] || {}).label || 'Jev AI (Orchestrator)',
    tier: 'free',
    kind: 'cli',
    credential: null,
    primary: false,
  }),
]);

// ── STT (ses → metin) ────────────────────────────────────────────────────────
/**
 * ADP-813'ün yönlendiricisi: önce YEREL (ücretsiz), gerekirse bulut.
 * 🔴 Bu liste `jarvisVoice.resolveSttEngine`'in de tek kaynağıdır: buraya bir
 * motor eklemek hem yönlendiriciyi hem bu ekranı aynı anda doğru tutar.
 */
const STT_ENGINES = Object.freeze([
  Object.freeze({
    id: 'local',
    label: null, // "whisper.cpp" bir dosya adı; kullanıcıya gösterilen ad çevrilir
    tier: 'free',
    kind: 'local',
    credential: null,
  }),
  Object.freeze({
    id: 'openai',
    label: (credentialGate.SERVICES.openai || {}).label || 'OpenAI',
    tier: 'paid',
    kind: 'cloud',
    credential: 'openai',
  }),
]);
const STT_ENGINE_IDS = Object.freeze(STT_ENGINES.map((e) => e.id));
/** Varsayılan ÜCRETSİZ ve yereldir (ADP-813 ölçümü: bulut 944–1472 ms, yerel 446–592 ms ve $0). */
const DEFAULT_STT_ENGINE = 'local';

/** Ayarlardaki STT motoru → geçerli id (bozuk/bilinmeyen değer ücretsiz varsayılana düşer). */
function resolveSttEngine(settings) {
  const raw = settings && settings.jarvis && settings.jarvis.sttEngine;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return STT_ENGINE_IDS.includes(v) ? v : DEFAULT_STT_ENGINE;
}

// ── Ortak alan üretimi ───────────────────────────────────────────────────────
/**
 * Anahtar kapısının bu motor için söylediği her şey TEK yerden türer:
 *   hasKey         — anahtar GERÇEKTEN var mı (`null` = bu motorun anahtarı yok)
 *   credentialLabel— hangi sağlayıcının anahtarı (ör. "OpenAI")
 *   settingsTarget — "anahtarı gir" düğmesinin GİDECEĞİ yer (ADP-749 makine hedefi)
 * Not: `hasKey` için kapıya sorulur; kapı sırrı DÖNDÜRMEZ, yalnız var/yok.
 */
function credentialFacts(credential, ctx) {
  if (!credential) return { credential: null, credentialLabel: null, hasKey: null, settingsTarget: null };
  const gate = ctx.gate || credentialGate;
  // Kayıt defteri STATİK (SERVICES) — enjekte edilen kapı yalnız "anahtar var mı"
  // sorusunu cevaplar. İkisini karıştırmak, testte sahte kapı verildiğinde
  // etiketleri de kaybetmek demekti.
  const spec = credentialGate.SERVICES[credential] || null;
  return {
    credential,
    credentialLabel: spec ? spec.label : credential,
    hasKey: gate.hasCredential(credential, ctx) === true,
    settingsTarget: credentialGate.settingsTarget(spec),
  };
}

/**
 * ADP-628'in kullanıcıya görünen hâli: her motor için "fatura kime çıkar".
 *   'none'         — hiç fatura yok (cihazda çalışır)
 *   'subscription' — kullanıcının kendi aboneliği (Claude/ChatGPT)
 *   'own-key'      — kullanıcının kendi API anahtarı, kullandıkça öde
 * Bizim anahtarımızla açılan bir yol YOKTUR; bu yüzden dördüncü bir değer de yok.
 */
function billingFor(engine) {
  if (engine.tier === 'free') return 'none';
  if (engine.tier === 'subscription') return 'subscription';
  return 'own-key';
}

function decorate(engine, { active, ctx, extra }) {
  return {
    id: engine.id,
    label: engine.label || null,
    tier: engine.tier,
    kind: engine.kind,
    active: active === engine.id,
    billing: billingFor(engine),
    ...credentialFacts(engine.credential, ctx),
    cost: engine.cost || null,
    ...(extra || {}),
  };
}

// ── Anlık görüntü ────────────────────────────────────────────────────────────
/**
 * Ayarlar'ın "Motorlar & Maliyet" kartlarının TEK girdisi.
 *
 * @param {object} settings  agentSettings.readSettings() çıktısı
 * @param {object} ctx       { rootDir, platform, gate, sttStatus }
 *   • `sttStatus` — whisperLocal.status() anlık görüntüsü (opsiyonel). Verilirse
 *     ücretsiz yerel motorun GERÇEKTEN kurulu olup olmadığı da gösterilir;
 *     verilmezse alan `null` kalır ve ekran bir iddiada BULUNMAZ.
 */
function engineCostSummary(settings, ctx = {}) {
  const platform = ctx.platform || process.platform;
  const tts = ttsProviders.ttsConfig(settings, { ...ctx, platform });

  const brainActive = BRAIN_ENGINES[0].id;
  const sttActive = resolveSttEngine(settings);
  const sttStatus = ctx.sttStatus || null;

  return {
    ok: true,
    // 🔴 ADP-628 — ürünün sözü: bizim anahtarımız ASLA kullanılmaz. Renderer bunu
    // bir bayrak olarak okur; cümleyi sözlükten kurar.
    byoKey: true,
    capabilities: [
      {
        id: 'brain',
        activeEngineId: brainActive,
        freeEngineId: 'local-parser',
        engines: BRAIN_ENGINES.map((e) => decorate(e, { active: brainActive, ctx })),
      },
      {
        id: 'stt',
        activeEngineId: sttActive,
        freeEngineId: DEFAULT_STT_ENGINE,
        engines: STT_ENGINES.map((e) =>
          decorate(e, {
            active: sttActive,
            ctx,
            // Yalnız yerel motor için "kurulu mu" sorusu anlamlı.
            extra: e.id === 'local' ? { installed: sttStatus ? sttStatus.available === true : null } : {},
          }),
        ),
      },
      {
        id: 'tts',
        activeEngineId: tts.engine,
        // ADP-874 — bu platformda ücretsiz yerel ses OLMAYABİLİR; `null` o gerçeği taşır.
        freeEngineId: tts.freeEngine,
        engines: tts.engines.map((e) =>
          decorate(
            { id: e.id, label: e.label, tier: e.tier, kind: e.credential ? 'cloud' : 'local', credential: e.credential, cost: e.cost },
            { active: tts.engine, ctx },
          ),
        ),
      },
    ],
    // Fiyat tahminlerinin dayandığı kullanım varsayımı (tek kaynak: ttsProviders).
    costAssumptions: tts.costAssumptions,
  };
}

module.exports = {
  CAPABILITIES,
  BRAIN_CLI,
  BRAIN_ENGINES,
  STT_ENGINES,
  STT_ENGINE_IDS,
  DEFAULT_STT_ENGINE,
  resolveSttEngine,
  billingFor,
  engineCostSummary,
};
