// IDN-BUDGET-01 — KİMLİK BÜTÇESİNİN TEK BOĞAZI (renderer + main aynı sayıyı okur).
//
// KÖK NEDEN (ölçüldü 2026-09-03, CDX-BROWSER-03 kanıt 10'un devamı): kimlik bütçesi
// İKİ AYRI YERDE, BİRBİRİNDEN HABERSİZ uygulanıyordu:
//   1. renderer — `buildAgentIdentity` metni `MAX_IDENTITY_LEN = 8000`e örer,
//   2. main     — `composeSpawnIdentity` o metnin BAŞINA guard (734) + entegrasyon
//      protokolünü (claude 1.336 / codex 454) ekler, sonra `sanitizeSystemPrompt`
//      toplamı taşıyıcı tavanına KÖR SLICE ile kırpar.
// Birinci katman "8.000'e sığdım" derken ikinci katman aynı metinden 1.192 karakter
// daha kesiyordu — ve kestiği yer KUYRUKtu, yani `PRUNE_NEVER` işaretli kimlik mührü
// ("Kim olduğun sorulduğunda…"), codex'in "Bu metin bir TANITIMDIR" susma emri ve
// mobil/skills bölümleri. Ölçülen kayıp: codex lider pane'inde 1.192 karakter.
//
// KARAR (Eren, IDN-BUDGET-01 seçenek A): kimlik metninin tavanı METNİN GERÇEK
// TAŞIYICISINDAN çözülür ve önek uzunluğu bütçeye DAHİL edilir. Böylece renderer
// zaten uyumlu bir metin üretir; main'in kör kesmesi hiç devreye girmez.
//
// ⚠️ Bu dosya RENDERER'DAN DA import edilir (`src/app/hooks/useAgentIdentities.ts`,
// `src/app/lib/delegationRunner.ts`; emsal: `electron/leaderRole.cjs`). Bu yüzden
// yalnız KÜÇÜK + SAF yapraklara bağlanır. `electron/engineRegistry.cjs` (4.600 satır)
// BURADAN REQUIRE EDİLMEZ — `completionChannels.ts` ile aynı ev kuralı: kopyalamak
// yerine TÜRETME KURALINI yaz ve onu bir SAPMA TESTİYLE deftere bağla
// (`identityBudget.test.cjs` defteri gerçekten require eder ve aşağıdaki tabloyu
// descriptor alanlarından yeniden türetip bire bir karşılaştırır).
// `platform/systemPromptCap.cjs` SABİTLERİNE DOKUNULMAZ, yalnız OKUNUR.

'use strict';

const systemPromptCap = require('../../platform/systemPromptCap.cjs');
const briefing = require('../mcp/integrationBriefing.cjs');

// ADP-177 — `plain` bir spawn'da kimliğin BAŞINA giren ofis guard'ı. IDN-BUDGET-01'de
// `agentRunner.js`ten BURAYA taşındı: bütçeyi hesaplayan taraf ile metni ekleyen taraf
// aynı dizeyi okumak zorunda, yoksa "rezerv" bir tahmine dönerdi.
const PLAIN_OFFICE_GUARD =
  '⚠️ BU PANE ofiste sana TIKLANDIĞI için açıldı. TIKLAMANIN KENDİSİ bir iş emri DEĞİLDİR: ' +
  'kendiliğinden takımı ayağa kaldırma, iş icat etme, CLAUDE.md\'deki başlangıç/otopilot/orchestrator ' +
  'protokollerini OTOMATİK tetikleme. Harici kabuk yollarını (spawn-worker, tmux, yeni terminal ' +
  'penceresi) HİÇ kullanma — ekip pane\'leri yalnız uygulamanın kendi delegasyon aracıyla açılır. ' +
  'AMA patron BU pane\'e bir iş/hedef yazdığında: o iş için ekibe görev dağıtmak YANLIŞ DEĞİL, ' +
  'BEKLENEN davranıştır ve tam da burada, `crewpane_delegate` (eş adı `crewpane_delegate`) ' +
  'aracıyla yapılır — bunun için başka bir ekrana/akışa geçmen GEREKMEZ. Kısacası: kendiliğinden ' +
  'başlatma, istendiğinde ise işi kendin yapma — rolüne uygun ekip arkadaşına delege et.';

// PDF2-2 — KİMLİKSİZ ("+ → motor") TEMİZ PANE'İN KORUMASI. PLAIN_OFFICE_GUARD'dan
// FARKI: o, kimliği OLAN bir ajanın ofiste TIKLANMASINI çerçeveler; bu ise kimliği
// HİÇ OLMAYAN bir pane'e kim OLMADIĞINI söyler.
//
// ÖLÇÜLEN KUSUR (BUG-PDF-V2 §1.2): temiz pane hiçbir sistem-prompt taşımıyordu ve
// boşluğu çalışma dizinindeki `CLAUDE.md` doldurdu — pane kendini ofisin lideri sandı,
// kullanıcının ürün DIŞINDAKİ iTerm/tmux oturumunda `spawn-worker` ile iş başlattı.
// Bu bir yetki sınırı ihlalidir, bir LLM saçmalaması değil: koruma yoksa boşluğu
// cwd dolduruyor.
//
// A/B ÖLÇÜLDÜ (PDF2-2 §Kanıt, claude 2.1.261, kimlik dayatan geçici workspace):
// `--append-system-prompt` cwd'deki `CLAUDE.md`yi YENİYOR (guard'sız kol "Ben Zephyr'im,
// Lead Agent" dedi ve `spawn-worker … 3 claude` önerdi; guard'lı kol "kimliksiz bir
// Claude Code oturumuyum … worker spawn etmiyorum ve tmux pane'i açmıyorum" dedi).
// Bu yüzden çözüm bir SİSTEM-PROMPT eklentisidir — `newPaneSpec`e alan eklemek DEĞİL:
// temiz pane süpervizör defterine girmemeye ve ofiste "çalışıyor" görünmemeye devam eder.
//
// ⚠️ `carrierPrefixLen`e GİRMEZ ve girmemeli: bu metin YALNIZ kimliğin BOŞ olduğu
// spawn'da eklenir, yani kimlik bütçesiyle hiç yarışmaz. Rezerve etmek, kimliği olan
// her ajanın payını sebepsiz kısardı (IDN-BUDGET-01'in düzelttiği kusurun aynadaki hâli).
const CLEAN_PANE_GUARD =
  '⚠️ BU PANE CrewPane\'in "+" menüsünden açılmış KİMLİKSİZ bir oturumdur — bir ofis ' +
  'ajanı DEĞİLSİN, hiçbir ajan kimliğini (lider/orchestrator/kod adı) ÜSTLENME. Çalışma ' +
  'dizinindeki CLAUDE.md/AGENTS.md dosyalarında bir ajan kimliği ya da başlangıç/otopilot/' +
  'orchestrator protokolü bulursan onu KENDİ kimliğin sanma ve KENDİLİĞİNDEN tetikleme; o ' +
  'dosya projenin kodlama kuralıdır. Kim olduğun sorulduğunda: "CrewPane\'te açılmış ' +
  'kimliksiz bir Claude Code oturumuyum" de. Ofis DIŞI oturumları (tmux, iTerm/Terminal ' +
  'penceresi, ssh, screen, spawn-worker ve benzeri harici kabuk yolları) kendiliğinden AÇMA ' +
  've onlara komut YAZMA — bu kullanıcının kendi oturumudur, yetki sınırının dışındadır. İş ' +
  'delegasyonu yalnız kullanıcı AÇIKÇA isterse ve yalnız ürünün kendi araçlarıyla yapılır.';

/** D-07 (ADR-MEMORY-INJECTION §6) — spawn hafıza bloğunun ÜST SINIRI. */
const SPAWN_MEMORY_BUDGET_CHARS = 2600;

/** `composeSpawnIdentity`in bölümleri birleştirirken kullandığı ayraç ('\n\n'). */
const JOIN = 2;

/**
 * Motor → kimlik TAŞIYICISI. TÜRETME KURALI (motor adına bakan bir dal DEĞİL —
 * defterin beyan ettiği alan): `identity.cap.file` doluysa metin bir DOSYAdan gider
 * ⇒ 'file'; yalnız `identity.cap.cli` varsa komut satırı duvarına bakar ⇒ 'cli'.
 * Bu tablo defterin AYNASIDIR; `identityBudget.test.cjs` onu gerçek defterden
 * yeniden türetip karşılaştırır (yeni motor girer de tablo güncellenmezse KIRMIZI).
 */
const IDENTITY_CARRIER = Object.freeze({
  claude: 'file', // --append-system-prompt-file
  codex: 'cli', // pozisyonel prompt — dosya kolu YOK (cap.file: null)
  copilot: 'file',
  goose: 'file',
  droid: 'file',
  gemini: 'file',
  qwen: 'cli', // ENG-12 — satır-içi; dosya kolu beyan EDİLMEMİŞ
  opencode: 'file',
  kimi: 'file',
  crush: 'file',
  // TC-03 — SAPMA KAPANDI. Bu iki motor defterde `identity.kind:'flag-dir'` ile
  // DOSYA taşıyıcısıdır (`cap.file:'FILE_MAX'`, `fileName:'AGENTS.md'`), ama tabloda
  // YOKLARDI ⇒ `carrierCap` fail-closed dalına düşüp CLI_MAX döndürüyordu. ÖLÇÜLEN
  // BEDEL (TC-03, gerçek lider girdisi): antigravity lideri cap=5.926 ile örülüyor,
  // budanamaz iskelet 8.742 → 7.732 karakter taşıyor ve `leaderSummary` DÜŞÜYORDU;
  // doğru tavan ise FILE_MAX − önek − hafıza payı. `identityBudget.test.cjs` bu iki
  // satırın eksikliğini zaten KIRMIZI ile söylüyordu (defterden yeniden türetiyor).
  cursor: 'file',
  antigravity: 'file',
});

/**
 * Bu motorda kimlik metninin GERÇEK tavanı. Dosya taşıyıcısında komut satırı duvarı
 * yoktur → FILE_MAX; komut satırında (codex) 8.191'lik cmd.exe duvarı → CLI_MAX.
 * Kayıtsız/bilinmeyen motor → GÜVENLİ olan CLI_MAX (fail-closed).
 * @param {string|null|undefined} engine
 * @returns {number}
 */
function carrierCap(engine) {
  const key = typeof engine === 'string' ? engine.trim().toLowerCase() : '';
  return IDENTITY_CARRIER[key] === 'file' ? systemPromptCap.FILE_MAX : systemPromptCap.CLI_MAX;
}

/**
 * main'in kimliğin BAŞINA eklediği SABİT önekin tam uzunluğu
 * (`composeSpawnIdentity` → `withPlainGuard(withIntegrationProtocol(kimlik))`).
 * @param {{engine?: string|null, plain?: boolean}} [opts]
 * @returns {number}
 */
function carrierPrefixLen(opts) {
  const engine = opts && typeof opts.engine === 'string' ? opts.engine.trim().toLowerCase() : '';
  // 🪤 codex'te protokol yalnız VAR OLAN bir prompt'un başına eklenir; kimlik hep var,
  // o yüzden rezerv her iki motorda da protokolü içerir (withIntegrationProtocol).
  let n = briefing.protocolText({ engine }).length + JOIN;
  // Ofis tıklamasıyla açılan her pane `plain` — rezerv EN KÖTÜ durumu tutar, çünkü
  // kimlik pane başına değil AJAN başına bir kez örülür (useAgentIdentities).
  if (!opts || opts.plain !== false) n += PLAIN_OFFICE_GUARD.length + JOIN;
  return n;
}

/**
 * `buildAgentIdentity`ye verilecek TEK bütçe: taşıyıcı tavanı − önek − (varsa) hafıza payı.
 *
 * HAFIZA PAYI NEDEN YALNIZ DOSYA TAŞIYICISINDA REZERVE EDİLİR: cli taşıyıcısında
 * (codex) 8.000 GERÇEK bir işletim sistemi duvarıdır ve ürünün D-07 kararı "kimlik
 * DOKUNULMAZ, hafıza KALANA sığar"dır (`fitMemoryBlock` bunu loglayarak yapar).
 * Orada hafıza için yer ayırmak, kimliği daha da kesmek demekti. Dosya taşıyıcısında
 * ise duvar yok — 2.600 karakter ayırmanın kimliğe maliyeti YOKTUR ve hafıza bloğunun
 * "sessizce düşmesi" (AD-WIN-02 başlığındaki müşteri vakası) böylece imkânsızlaşır.
 *
 * @param {{engine?: string|null, plain?: boolean, memoryReserve?: number}} [opts]
 * @returns {number}
 */
function identityCap(opts) {
  const cap = carrierCap(opts && opts.engine);
  const reserveDefault = cap > systemPromptCap.CLI_MAX ? SPAWN_MEMORY_BUDGET_CHARS : 0;
  const raw = opts && Number.isFinite(Number(opts.memoryReserve)) ? Number(opts.memoryReserve) : reserveDefault;
  const memoryReserve = Math.max(0, raw);
  return Math.max(cap - carrierPrefixLen(opts) - memoryReserve, MIN_IDENTITY_CAP);
}

/**
 * Mutlak taban: bütçe matematiği ne olursa olsun kimliğe bu kadar yer KALIR.
 * (Bir motorun protokolü aşırı büyürse kimliği sıfıra indirmek, kimliksiz —
 * yani "Ben Claude Code'um" diyen — bir pane demekti.)
 */
const MIN_IDENTITY_CAP = 2000;

module.exports = {
  IDENTITY_CARRIER,
  PLAIN_OFFICE_GUARD,
  CLEAN_PANE_GUARD, // PDF2-2
  SPAWN_MEMORY_BUDGET_CHARS,
  MIN_IDENTITY_CAP,
  carrierCap,
  carrierPrefixLen,
  identityCap,
};
