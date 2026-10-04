// AGENT-MODEL-01 — MOTOR BAŞINA MODEL KATALOĞU (tek doğruluk kaynağı).
//
// ─────────────────────────────────────────────────────────────────────────────
// NEDEN AYRI BİR MODÜL (ve neden CAPABILITY_KEYS'e yeni bir alan DEĞİL)
// ─────────────────────────────────────────────────────────────────────────────
// engineRegistry `model` yeteneğinin GRAMERİNİ taşır (`--model` bayrağı, konumu,
// K1 tespiti). "Hangi modeller var" ise bir LİSTEDİR ve bu üründe listeler kendi
// modüllerinde yaşar: `provider.grammar = 'electron/providers.cjs'` aynen bu
// deseni kurmuştu. Bu modül o desenin model muadilidir; registry ona
// `model.catalog` alanıyla İŞARET EDER, listeyi KOPYALAMAZ.
//
// ─────────────────────────────────────────────────────────────────────────────
// KAYNAK KARARI — ÖLÇÜLDÜ (2026-09-14, macOS 14.6)
// ─────────────────────────────────────────────────────────────────────────────
// Kartın sorduğu üç aday alternatif DEĞİL; ikisi ölçümle ELENDİ:
//
//  (a) "CLI'dan canlı sor"  → ELENDİ. Ne claude ne codex model LİSTELEYEN bir
//      alt-komut sunuyor:
//        claude 2.1.270  `--help` → agents/attach/auth/auto-mode/doctor/gateway/
//                        import/install/logs/mcp/plugin/project/respawn/rm … YOK
//        codex-cli 0.154 `--help` → agents/exec/review/login/…/unarchive … YOK
//      `--model`ın YARDIM METNİ üç alias sayıyor ama bu bir liste değil bir örnek.
//
//  (b) "bulut app.engines.models" → ELENDİ. app.engines şeması BUGÜN
//      (id,label,command,enabled,sort_order,created_at) — models kolonu YOK.
//      Eklenseydi de yanlış yerde olurdu: bulut satırı KULLANICININ MAKİNESİNDEKİ
//      CLI sürümünü bilemez, oysa geçerli model kümesi tam olarak ona bağlıdır.
//
//  (c) STATİK KATALOG → seçildi, AMA tek gramerle DEĞİL. Ölçüm sırasında üçüncü
//      bir gerçek çıktı: codex CLI'ın KENDİSİ bir model kataloğunu diske yazıyor —
//      `~/.codex/models_cache.json` (fetched_at + client_version + models[]), her
//      model için `slug` · `display_name` · `description` · `visibility` ·
//      `default_reasoning_level` · `supported_reasoning_levels[{effort,description}]`.
//      Bu, elle yazılacak her listeden TAZE ve DAHA ZENGİNDİR.
//
// ⇒ TEK KAYNAK = BU MODÜL; modül her motor için listenin NEREDEN geldiğini BEYAN
//   eder (registry'nin `model.detect` alanının zaten yaptığı şey):
//     • kind:'static'     — modülün kendi beyanı (claude: sürüm-dayanıklı ALIAS'lar)
//     • kind:'cache-json' — motorun KENDİ yazdığı katalog dosyası (codex)
//   Motor adına göre DAL YOK: `catalogFor()` yalnız descriptor'ın `kind`ine bakar,
//   yeni bir motor açmak = bu tabloya bir SATIR eklemek.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🪤 NEDEN claude'da ALIAS, codex'te SLUG
// ─────────────────────────────────────────────────────────────────────────────
// claude `--model` yardımı (2.1.270, ölçüldü):
//   "Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a
//    model's full name (e.g. 'claude-fable-5')."
// Alias, "en yeni" olana çözülür → yeni sürüm çıkınca liste BAYATLAMAZ. Sabit id
// yazmak (claude-opus-5) tam da ADP-565'in kaçındığı drift'tir. codex'te tersi:
// katalog zaten CLI tarafından tazelenir, slug'lar oradan OKUNUR — biz yazmayız.
//
// PURE + LEAF: `fs`in dışında değer importu yok → `node --test` doğrudan yükler.
// Dosya okuması tek bir enjekte edilebilir dikişte (`deps.readFile`) toplanır ki
// saf katman testte diske hiç dokunmasın.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * @typedef {{id:string,label:string,description?:string|null,
 *            efforts?:string[]|null,defaultEffort?:string|null}} CatalogModel
 */

// ─────────────────────────────────────────────────────────────────────────────
// KATALOG BEYANLARI (motor id → nereden okunur)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * claude'un model alias'ları. ÖLÇÜM: `claude --help` (2.1.270) `--model` girdisi
 * 'fable' / 'opus' / 'sonnet' alias'larını ADIYLA sayıyor; 'haiku' ürünün ADP-565
 * politikasında `cheap` basamağı olarak zaten kullanılıyor (DEFAULT_MODEL_POLICY).
 *
 * `efforts` BURADA YAZILMAZ: claude'da efor MODELDEN BAĞIMSIZ tek bir bayrak
 * kümesidir (`--effort <low|medium|high|xhigh|max>`) ve o kümenin tek kaynağı
 * engineRegistry'nin `effort.values`ıdır. İkinci bir liste tutmak drift üretirdi;
 * `efforts:null` = "bu modelin kendi kısıtı yok, motorun kümesi geçerli".
 */
// 🪤 AÇIKLAMA METNİ: `descriptionKey` mi `description` mi?
// ADP-889 disiplini — ÜRÜNÜN KENDİ metni SÖZLÜKTEN gelir, dil canlı değişince o da
// değişsin. Ama codex satırlarının açıklaması MOTORUN KENDİ metnidir (katalogdaki
// `description`, İngilizce) ve onu çeviremeyiz/çevirmemeliyiz — kaynağın söylediğini
// değiştirmek olurdu. Bu yüzden iki alan:
//   • descriptionKey — bizim yazdığımız metin (renderer sözlükten çevirir)
//   • description    — motorun kendi metni (aynen geçer)
// Form önce key'e bakar. Karıştırmamak, ekranda yarı-Türkçe yarı-İngilizce bir liste
// çıkmasını engeller (ölçüldü: ilk turda tam olarak bu oldu).
const CLAUDE_MODELS = Object.freeze([
  Object.freeze({ id: 'opus', label: 'Opus', descriptionKey: 'setup.employee.modelDescOpus', description: null, efforts: null, defaultEffort: null }),
  Object.freeze({ id: 'fable', label: 'Fable', descriptionKey: 'setup.employee.modelDescFable', description: null, efforts: null, defaultEffort: null }),
  Object.freeze({ id: 'sonnet', label: 'Sonnet', descriptionKey: 'setup.employee.modelDescSonnet', description: null, efforts: null, defaultEffort: null }),
  Object.freeze({ id: 'haiku', label: 'Haiku', descriptionKey: 'setup.employee.modelDescHaiku', description: null, efforts: null, defaultEffort: null }),
]);

// ─────────────────────────────────────────────────────────────────────────────
// AGY-05 — ANTIGRAVITY: KATALOG **ÇIPLAK AİLE ADI** TUTAR (fail-closed kuralı)
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 ÖLÇÜLDÜ (agy 1.2.2, 2026-09-14 — ANTIGRAVITY-R1 §3.2 + AGY-05 tekrar ölçümü):
// motor model/efor birleşimini KENDİ DOĞRULAR ve geçersiz birleşimde turu HİÇ
// başlatmadan `exit 1` ile ölür. codex'in tersi bir dünya: orada motor değeri
// doğrulamaz (bu yüzden beyaz liste bizim güvenliğimizdi), burada motor doğrular
// ve YANLIŞ ARGV = ÖLÜ PANE.
//
//   $ agy -p x --model gemini-3.1-pro      --effort medium → gemini-3.1-pro has no "medium" effort (available: low, high)
//   $ agy -p x --model claude-sonnet-4-6   --effort high   → --effort is not supported for model "claude-sonnet-4-6"
//   $ agy -p x --model gemini-3.8-flash-low --effort high  → --model gemini-3.8-flash-low conflicts with --effort=high
//   $ agy -p x --model gemini-3.8-flash    --effort medium → KABUL
//
// 🪤 AGY-05 İNCELTMESİ (R1'in ÖLÇMEDİĞİ hâl — bu görevde yanlışlıkla ölçüldü, bkz. rapor):
// sonekli ad `--effort` ile HER ZAMAN çakışmıyor; değerler AYNIYSA motor KABUL ediyor
//   `--model gemini-3.8-flash-high --effort high` → KABUL (tur başladı)
//   `--model gemini-3.8-flash-high --effort low`  → conflicts (exit 1)
// ÜRÜN YİNE DE BASMIYOR: (a) o birleşim zaten GEREKSİZ (efor adın içinde), (b) ürünün
// "eşitse geçer" gibi bir kural taşıması, satıcı yazımı değiştirdiği gün SESSİZCE
// ölümcül argv üretmesi demektir. Sonekli ad ⇒ efor kolu her hâlükârda NO-OP.
//
// 🪤 TUZAK — `agy models` ÇIKTISI DOĞRUDAN KATALOG OLARAK KULLANILAMAZ: liste
// **sonekli** adlar veriyor (`gemini-3.8-flash-low`), yani efor ADA GÖMÜLÜ. Kullanıcı
// o adı seçip ayrıca efor seçerse argv `--model gemini-3.8-flash-low --effort high`
// olur ve pane tek tur atmadan ölür (R1 §7-R2, 🔴 yüksek). Bu yüzden SEÇİLEBİLİR
// liste ÇIPLAK aile adlarıdır; sonekli adlar ayrı bir tabloda "efor KABUL ETMEZ"
// damgasıyla durur ki geriye-uyum (kullanıcının kayıtlı sonekli modeli) sessiz
// ölüme değil, efor kolunun NO-OP olmasına düşsün.
//
// `efforts` semantiği (⚠️ `null` ile `[]` AYNI ŞEY DEĞİL):
//   • `null` → modelin kendi kısıtı yok; motorun `effort.values` kümesi geçerli
//              (claude satırlarının bugünkü anlamı — davranış birebir korunur).
//   • `[]`   → bu modelde efor HİÇ YOK; bayrak ASLA üretilmemeli.

/** `agy models` 14 model satırı → 7 ÇIPLAK aile (seçilebilir liste). */
const ANTIGRAVITY_MODELS = Object.freeze([
  Object.freeze({ id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', descriptionKey: null, description: 'Gemini 3.8 Flash (low | medium | high)', efforts: Object.freeze(['low', 'medium', 'high']), defaultEffort: null }),
  Object.freeze({ id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', descriptionKey: null, description: 'Gemini 3.7 Flash (low | medium | high)', efforts: Object.freeze(['low', 'medium', 'high']), defaultEffort: null }),
  Object.freeze({ id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', descriptionKey: null, description: 'Gemini 3.6 Flash (low | medium | high)', efforts: Object.freeze(['low', 'medium', 'high']), defaultEffort: null }),
  // 🪤 MEDIUM YOK — motorun kendi cümlesi: `available: low, high`.
  Object.freeze({ id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', descriptionKey: null, description: 'Gemini 3.1 Pro (low | high — medium YOK)', efforts: Object.freeze(['low', 'high']), defaultEffort: null }),
  // Claude aileleri: `--effort is not supported for model "…"` → küme BOŞ (null DEĞİL).
  Object.freeze({ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)', descriptionKey: null, description: 'Claude Sonnet 4.6 — efor bayrağı desteklenmiyor', efforts: Object.freeze([]), defaultEffort: null }),
  Object.freeze({ id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)', descriptionKey: null, description: 'Claude Opus 4.6 — efor bayrağı desteklenmiyor', efforts: Object.freeze([]), defaultEffort: null }),
  // gpt-oss: efor ADA GÖMÜLÜ (`…-medium`) → motor `conflicts with --effort=…` diyor.
  Object.freeze({ id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)', descriptionKey: null, description: 'GPT-OSS 120B — efor ada gömülü, ayrıca seçilemez', efforts: Object.freeze([]), defaultEffort: 'medium' }),
]);

/**
 * `agy models` çıktısındaki SONEKLİ adlar (efor ada gömülü). Seçilebilir listede
 * DEĞİLLER — burada durmalarının tek sebebi ARGV ÜRETİCİSİNİN onları tanıyıp efor
 * kolunu NO-OP yapması (yoksa `--model …-low --effort high` = ölü pane).
 */
const ANTIGRAVITY_SUFFIXED = Object.freeze([
  'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
  'gemini-3.7-flash-high', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-low',
  'gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-low',
  'gemini-3.1-pro-high', 'gemini-3.1-pro-low',
  'gpt-oss-120b-medium',
]);

/**
 * Motor id → katalog kaynağı. VERİ, motor-adı `if`'i DEĞİL (ENG-07 deseni):
 * bir motoru açmak = buraya bir satır eklemek.
 *
 * Listede OLMAYAN motor → `catalogFor()` boş liste + `source:'none'` döner;
 * form model açılır listesini HİÇ çizmez (bugünkü davranış, sessiz hata yok).
 */
const CATALOG_SOURCES = Object.freeze({
  claude: Object.freeze({
    kind: 'static',
    models: CLAUDE_MODELS,
    why: "claude model LİSTELEYEN bir alt-komut sunmuyor (ölçüldü 2.1.270); `--help` alias örnekleri + ADP-565 politika basamakları beyan edilir",
  }),
  // AGY-05 — antigravity: STATİK ama `modelScoped` (motor per-model DOĞRULUYOR).
  // `agy models` var, AMA çıktısı sonekli adlar verdiği için ham kaynak olarak
  // KULLANILAMAZ (yukarıdaki tuzak) + her çağrı ağa çıkar ve girişsiz makinede
  // 60 sn OAuth duvarına asılır → spawn yolunda canlı sorgulanamaz.
  antigravity: Object.freeze({
    kind: 'static',
    models: ANTIGRAVITY_MODELS,
    suffixed: ANTIGRAVITY_SUFFIXED,
    // 🔑 BU BAYRAK ARGV ÜRETİCİSİNİ FAIL-CLOSED YAPAR: bilinmeyen/boş model +
    // efor → bayrak ÜRETİLMEZ (motor doğruladığı için "denemek" pane'i öldürür).
    modelScoped: true,
    measuredVersion: '1.2.2',
    why: 'agy 1.2.2 `models` çıktısı SONEKLİ ad veriyor (efor ada gömülü) → ham liste argv\'de ölümcül; katalog ÇIPLAK aile adı tutar (ANTIGRAVITY-R1 §3.1/§3.2, AGY-05 tekrar ölçümü)',
  }),
  codex: Object.freeze({
    kind: 'cache-json',
    // codex'in KENDİ yazdığı katalog. `CODEX_HOME` codex'in resmî ev değişkeni
    // (engineRegistry codex `model.detect.homeEnv` ile AYNI kaynak sırası).
    homeEnv: 'CODEX_HOME',
    homeFallback: Object.freeze(['.codex']),
    file: 'models_cache.json',
    why: 'codex-cli 0.154.0 `~/.codex/models_cache.json` yazıyor (fetched_at/client_version/models[]) — elle yazılacak her listeden taze',
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// SAF KATMAN — dosya içeriği → katalog
// ─────────────────────────────────────────────────────────────────────────────

/** Boş-olmayan dize mi (yalnız boşluk YOK sayılır). */
function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * codex `models_cache.json` gövdesini katalog satırlarına çevir. SAF.
 *
 * 🪤 `visibility:'hide'` OLAN ATLANIR — ölçüldü: katalogda `gpt-reserve` ve
 * `codex-auto-review` bu işaretle geliyor; ikisi de kullanıcının seçeceği bir
 * model DEĞİL (biri yedek kapasite, öteki codex'in kendi inceleme modeli).
 * Onları listelemek kullanıcıya çalışmayacak bir seçenek sunmak olurdu.
 *
 * Gövde beklenen şekilde değilse (eski/yeni sürüm, bozuk dosya) BOŞ liste döner —
 * uydurma satır üretmez.
 */
function parseCodexCatalog(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.models)) return [];
  const out = [];
  for (const m of raw.models) {
    if (!m || typeof m !== 'object') continue;
    const id = str(m.slug);
    if (!id) continue;
    if (str(m.visibility) === 'hide') continue;
    const levels = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [];
    const efforts = levels.map((l) => (l && typeof l === 'object' ? str(l.effort) : str(l))).filter(Boolean);
    out.push({
      id,
      label: str(m.display_name) || id,
      // Motorun KENDİ metni — çevrilmez, aynen geçer (descriptionKey YOK).
      descriptionKey: null,
      description: str(m.description),
      efforts: efforts.length ? efforts : null,
      defaultEffort: str(m.default_reasoning_level),
    });
  }
  return out;
}

/** Katalog dosyasının yolu (descriptor + env + home'dan). SAF. */
function catalogPath(descriptor, env, homedir) {
  const home = str(env && descriptor.homeEnv ? env[descriptor.homeEnv] : null)
    || path.join(homedir, ...descriptor.homeFallback);
  return path.join(home, descriptor.file);
}

// ─────────────────────────────────────────────────────────────────────────────
// OKUMA KATMANI
// ─────────────────────────────────────────────────────────────────────────────

/** Varsayılan dosya okuyucu — yoksa/okunamazsa `null` (ASLA throw etmez). */
function defaultReadFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Bir motorun model kataloğu.
 *
 * @returns {{models:CatalogModel[], source:'static'|'cache-json'|'none', path:string|null, stale:boolean}}
 *
 * `source` DÜRÜSTLÜK İÇİN döner: UI "bu liste nereden geldi" diyebilsin ve bir
 * cache okuması BOŞ döndüğünde bunu "model yok" sanmayalım. Katalog dosyası
 * yoksa (codex hiç koşmamış) `models:[]` + `stale:true` → çağıran modeli SERBEST
 * METİN olarak sorabilir; sessizce "seçenek yok" demeyiz.
 */
function catalogFor(engineId, deps = {}) {
  const d = CATALOG_SOURCES[str(engineId) || ''];
  if (!d) return { models: [], source: 'none', path: null, stale: false };
  if (d.kind === 'static') {
    return { models: d.models.map((m) => ({ ...m })), source: 'static', path: null, stale: false };
  }
  // kind:'cache-json'
  const readFile = typeof deps.readFile === 'function' ? deps.readFile : defaultReadFile;
  const env = deps.env || process.env;
  const homedir = deps.homedir || os.homedir();
  const p = catalogPath(d, env, homedir);
  const text = readFile(p);
  if (!text) return { models: [], source: 'cache-json', path: p, stale: true };
  let raw = null;
  try {
    raw = JSON.parse(text);
  } catch {
    return { models: [], source: 'cache-json', path: p, stale: true };
  }
  const models = parseCodexCatalog(raw);
  return { models, source: 'cache-json', path: p, stale: models.length === 0 };
}

/**
 * Bir motor+model için SEÇİLEBİLİR efor değerleri.
 *
 * İKİ KISIT KESİŞİMİ — ve sıra önemli:
 *   1. motorun TAŞIYICISI (engineRegistry `effort.values`) — bayrak bunu kabul eder;
 *      dışındaki değer `agentRunner.sanitizeEffort`ta SESSİZCE DÜŞER.
 *   2. MODELİN kendi desteği (codex kataloğu `supported_reasoning_levels`).
 * Kesişim boşsa BOŞ dizi → UI efor seçicisini HİÇ çizmez (sunulup uygulanmayan
 * bir kontrol, bu kod tabanının yasakladığı sessiz başarısızlığın ta kendisi).
 *
 * `engineEffortValues` ÇAĞIRANDAN gelir (registry'yi burada import etmek iki
 * modülü birbirine bağlardı; kaynak hâlâ TEK: registry).
 */
function effortChoices(engineEffortValues, model) {
  const engine = Array.isArray(engineEffortValues) ? engineEffortValues.filter((v) => str(v)) : [];
  if (!engine.length) return [];
  // AGY-05 — 🪤 `null` ≠ `[]`. Eskiden ikisi de "motorun kümesi" demekti; antigravity
  // ölçümü bu eşitliği KIRDI: claude-sonnet-4-6 satırının efor kümesi BOŞ olmalı
  // (motor `--effort is not supported` deyip pane'i öldürüyor), "kısıtı yok" değil.
  //   • alan YOK / `null` → modelin kendi kısıtı yok → motorun kümesi (claude satırları:
  //     davranış BİT-BİT aynı; codex'te parseCodexCatalog zaten boşu `null`a çeviriyor)
  //   • `[]`             → bu modelde efor HİÇ YOK → boş küme (UI seçiciyi çizmez)
  if (!model || !Array.isArray(model.efforts)) return [...engine];
  const own = model.efforts.filter((v) => str(v));
  if (!own.length) return [];
  const lower = new Set(own.map((v) => v.toLowerCase()));
  return engine.filter((v) => lower.has(v.toLowerCase()));
}

/**
 * AGY-05 — ARGV ÜRETİCİSİNİN SORDUĞU TEK SORU: *bu motorda, bu model için* hangi efor
 * değerleri argv'ye BASILABİLİR?
 *
 * Neden `effortChoices` yetmedi: o fonksiyon elinde KATALOG SATIRI olanı (UI) hedefler.
 * Spawn yolunda elde yalnız bir model **DİZESİ** var — ve o dize kataloğa hiç girmemiş
 * bir SONEKLİ ad olabilir (`gemini-3.8-flash-low`), ki tam olarak pane'i öldüren şey bu.
 *
 * İki dünya, tek fonksiyon (motor adına göre `if` YOK — karar `modelScoped` VERİSİNDEN):
 *   • `modelScoped` YOK (claude/codex/…) → motorun kümesi aynen döner. Model bilinmiyorsa
 *     da döner: ölçüldü ki codex per-model doğrulama YAPMIYOR, yani bugünkü davranış.
 *   • `modelScoped:true` (antigravity) → FAIL-CLOSED: model yoksa, sonekliyse ya da
 *     katalogda yoksa BOŞ küme. "Belki çalışır" diye bayrak basmak burada pane'i öldürür.
 *
 * @returns {string[]} argv'ye basılabilir efor değerleri (motorun yazımıyla).
 */
function effortValuesFor(engineId, modelId, engineEffortValues, deps = {}) {
  const engine = Array.isArray(engineEffortValues) ? engineEffortValues.filter((v) => str(v)) : [];
  if (!engine.length) return [];
  const d = CATALOG_SOURCES[str(engineId) || ''];
  if (!d || d.modelScoped !== true) return [...engine];
  const id = str(modelId);
  if (!id) return []; // model seçilmemiş + doğrulayan motor → bayrak ÜRETME (ölçülmedi ⇒ fail-closed)
  const suffixed = Array.isArray(d.suffixed) ? d.suffixed : [];
  if (suffixed.some((v) => v.toLowerCase() === id.toLowerCase())) return []; // efor ADA GÖMÜLÜ
  const model = findModel(catalogFor(engineId, deps).models, id);
  if (!model) return []; // katalogda yok → kuralını bilmiyoruz ⇒ fail-closed
  return effortChoices(engine, model);
}

/** id → katalog satırı (bilinmeyen → null). */
function findModel(models, id) {
  const key = str(id);
  if (!key || !Array.isArray(models)) return null;
  return models.find((m) => m && m.id === key) || null;
}

module.exports = {
  CATALOG_SOURCES,
  CLAUDE_MODELS,
  ANTIGRAVITY_MODELS, // AGY-05 — çıplak aile adları (seçilebilir)
  ANTIGRAVITY_SUFFIXED, // AGY-05 — efor ADA GÖMÜLÜ adlar (efor kolu NO-OP)
  catalogFor,
  catalogPath,
  parseCodexCatalog,
  effortChoices,
  effortValuesFor, // AGY-05 — spawn yolunun model-kapsamlı efor kümesi
  findModel,
};
