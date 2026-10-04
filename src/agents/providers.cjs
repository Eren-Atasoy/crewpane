// ADP-580 — codex custom AI PROVIDERS (Groq / DeepSeek / Kimi) as a per-launch
// `model_provider` override. PURE + LEAF (no Electron, no value imports) so
// `node --test` loads it directly.
//
// Engine ≠ model ≠ provider (ADP-536): engine = the spawned CLI (codex), model =
// the LLM id, provider = the service that hosts it. Groq/DeepSeek/Kimi are
// PROVIDER-MODELS, not engines — the cheapest integration is codex's custom
// `model_provider` (OpenAI-shaped endpoint) rather than a whole new engine.
//
// ⚠️⚠️ PROV-01 GÜNCELLEMESİ (2026-08-18, codex-cli 0.147.0, GERÇEK anahtarla ölçüldü):
//   Aşağıdaki "Groq → works DIRECTLY (needsShim:false)" tespiti codex 0.144'te
//   DOĞRUYDU, 0.147'de ARTIK DEĞİL. codex'in /responses gövdesi Groq'un şemasından
//   BEŞ noktada sapıyor ve Groq 400 döndürüyor:
//     reasoning.summary · include · client_metadata · tools[type=namespace] · tools[type=web_search]
//   Son iki madde alan adı vermeyen jenerik "invalid JSON body" üretir (teşhis ancak
//   gövdeyi EKLEYEREK daraltmakla çıktı). codex'in kendi ayarları farkı KAPATMAZ.
//   ⇒ Groq artık tel üstünde TEMİZLİK ister: electron/groqResponsesShim.cjs.
//   `needsShim` BİLEREK false bırakıldı: o bayrak adapter.cjs'in DeepSeek/Kimi için
//   yaptığı Responses→ChatCompletions ÇEVİRİSİNİ tetikler; Groq'un ihtiyacı çeviri
//   değil KISMA. İkisini aynı bayrağa bindirmek Groq'u yanlış adaptöre sokardı.
//   Kablolama durumu + kalan iş: docs/agent-results/PROV-01-blaster.md
//
// ⚠️ WIRE-API GOTCHA (proven, codex-cli 0.144, real run + mock):
//   codex DROPPED `wire_api = "chat"` (discussion openai/codex#7782). Every custom
//   provider MUST now use `wire_api = "responses"` — i.e. the endpoint has to speak
//   the OpenAI *Responses* API, not Chat Completions. Consequence for THIS wave:
//     • Groq       → ships a native Responses endpoint at /openai/v1/responses →
//                    works DIRECTLY (needsShim:false). This is the real Dalga-0 win.
//     • DeepSeek   → Chat-Completions ONLY (no /responses) → codex 404s against it
//     • Kimi/Moon. → Chat-Completions ONLY → codex 404s
//   The two `needsShim:true` providers need a local responses→chat TRANSLATION adapter
//   (a follow-up subsystem; not wired here). The registry keeps them so the UI can
//   show them as "requires adapter" and a later wave flips needsShim off.
//
// BYOK: the user supplies their own key. It rides in as an ENV VAR (envKey) that
// codex reads (per the provider's `env_key`); the key itself lives in
// settings.apiKeys[settingsKey] (a SECRET — settings:get never returns apiKeys) and
// is injected main-side, never round-tripped through the renderer. Permanent home is
// the SPRINT-AD-55 Integration Hub vault; this is the minimal seam it plugs into.

'use strict';

/**
 * @typedef {{id:string,label:string}} ProviderModel
 * @typedef {{id:string,label:string,settingsKey:string,baseUrl:string,envKey:string,
 *            wireApi:'responses',needsShim:boolean,models:ProviderModel[]}} Provider
 */

/**
 * Resolve needsShim:true provider's baseUrl at runtime.
 * __ADAPTER_PORT__ placeholder is replaced with the actual port from env.
 */
function effectiveBaseUrl(p, env) {
  const e = env || process.env;
  if (p.shimPortEnv && e[p.shimPortEnv]) {
    return p.shimBaseUrl.replace('__SHIM_PORT__', String(e[p.shimPortEnv]));
  }
  return p.needsShim ? upstreamBaseUrl(p.baseUrl) : p.baseUrl;
}

function upstreamBaseUrl(baseUrlTemplate) {
  const adapterPort = process.env.CREWPANE_ADAPTER_PORT || '';
  if (!adapterPort) {
    // Adapter not running yet; return template (caller must retry after adapter starts).
    return baseUrlTemplate;
  }
  return baseUrlTemplate.replace('__ADAPTER_PORT__', adapterPort);
}

/** Registry of codex-compatible providers. Keyed by provider id. @type {Record<string,Provider>} */
const PROVIDERS = Object.freeze({
  groq: {
    id: 'groq',
    label: 'Groq',
    settingsKey: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    envKey: 'GROQ_API_KEY',
    wireApi: 'responses', // Groq exposes a native Responses API — direct.
    needsShim: false,
    // PROV-01 — codex 0.147 gövdesi Groq şemasından sapıyor (yukarıdaki ölçüm) ⇒ istek
    // yerel bir SANITIZE eden geçişten (groqResponsesShim.cjs) akmalı. Port yalnız shim
    // GERÇEKTEN dinliyorsa env'e yazılır; yazılmamışsa `baseUrl` aynen kullanılır, yani
    // shim başlatılamasa bile davranış BUGÜNKÜNÜN AYNISI kalır (sessiz kırılma yok).
    shimPortEnv: 'CREWPANE_GROQ_SHIM_PORT',
    shimBaseUrl: 'http://127.0.0.1:__SHIM_PORT__/openai/v1',
    // PROV-01 (2026-08-18) — liste GERÇEK anahtarla /openai/v1/models'a karşı ölçüldü.
    // Eski dört kaydın ÜÇÜ Groq'ta ARTIK YOK ve 404 veriyordu (llama-3.3-70b-versatile,
    // moonshotai/kimi-k2-instruct, deepseek-r1-distill-llama-70b) — yani kullanıcı
    // seçicide adını gördüğü modeli seçtiğinde pane 404 ile ölüyordu. Kalanlar
    // /responses + function-tool çağrısıyla TEK TEK denendi; yalnız 200 alanlar burada.
    // Kasten DIŞARIDA: groq/compound(-mini) ve allam-2-7b ("tool calling is not
    // supported with this model"), whisper/orpheus (ses), prompt-guard + gpt-oss-safeguard
    // (sınıflandırıcı) — hiçbiri kodlama ajanı süremez.
    models: [
      { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B' },
      { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B' },
      { id: 'qwen/qwen3.6-27b', label: 'Qwen3.6 27B' },
    ],
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    settingsKey: 'deepseek',
    baseUrl: 'http://127.0.0.1:__ADAPTER_PORT__/openai/v1', // dynamically resolved by upstreamBaseUrl()
    envKey: 'DEEPSEEK_API_KEY',
    wireApi: 'responses',
    needsShim: true, // Chat-Completions only → needs responses→chat adapter (codex 0.144).
    models: [
      { id: 'deepseek-chat', label: 'DeepSeek V3' },
      { id: 'deepseek-reasoner', label: 'DeepSeek R1' },
    ],
  },
  // 🔑 ENG-17 — KİMİ İKİ KEZ GEÇİYOR VE İKİSİ AYRI ŞEY (ENG-R2 §6-S2).
  //   • BURASI  → `moonshot` bir SAĞLAYICI-MODELdir: codex'in ALTINDA, `-c
  //     model_provider` override'ıyla koşar; kendi CLI'ı, kendi oturumu, kendi
  //     araç yüzeyi YOKTUR. Kullanıcı için "Codex'i Kimi modeliyle koştur" demektir.
  //   • ÖTEKİ   → `kimi` motoru (engineRegistry): Moonshot'ın KENDİ CLI'ı
  //     (`@moonshot-ai/kimi-code`, ölçüldü 0.36.1). Kendi kimliği, MCP'si, alt-ajan
  //     bloğu ve jeton defteri var; pane'de BAĞIMSIZ bir motor olarak koşar.
  // İki kayıt UI'da yan yana görünüyor → etiketler BİLEREK ayrıştırıldı ve
  // ikisi de hangi sınıfa ait olduğunu ADINDA söylüyor ("model" ⇄ "motor").
  // Nöbetçi: `electron/eng17KimiMoonshot.test.cjs` (çakışma + belirsizlik kapısı).
  moonshot: {
    id: 'moonshot',
    label: 'Kimi K2/K3 (Moonshot — model)',
    kindNote:
      'Sağlayıcı-model: Codex motorunun altında koşar (kendi CLI\'ı yoktur). Kimi\'nin BAĞIMSIZ motorunu arıyorsan ajan motoru olarak "Kimi Code (motor)" seç.',
    settingsKey: 'moonshot',
    baseUrl: 'http://127.0.0.1:__ADAPTER_PORT__/openai/v1', // dynamically resolved by upstreamBaseUrl()
    envKey: 'MOONSHOT_API_KEY',
    wireApi: 'responses',
    needsShim: true, // Chat-Completions only → needs adapter.
    models: [
      { id: 'kimi-k2.6', label: 'Kimi K2.6' },
      { id: 'kimi-k3', label: 'Kimi K3' },
    ],
  },
});

// ── ENG-OPENAI-COMPAT-01 — KULLANICININ KENDİ UCU ───────────────────────────
// Defter artık SABİT + (isteğe bağlı) BİR KULLANICI SATIRI. Satır AYARLARDAN
// gelir ve `electron/customProvider.cjs` kapısından geçmiş olmak ZORUNDADIR
// (kimlik/envKey orada sabitlenir, URL orada doğrulanır).
//
// 🔑 SÖZLEŞME: `custom` parametresi HER FONKSİYONDA İSTEĞE BAĞLIDIR ve
// verilmediğinde davranış BİREBİR bugünküdür — böylece bu dosyayı okuyan
// onlarca çağrı yerinin hiçbiri değişmek zorunda kalmaz ve kullanıcı satırı
// yalnız onu BİLEREK geçiren yollarda (spawn + Ayarlar yansıması) görünür.
//
// Kullanıcı satırı ÜRÜNÜN satırlarını EZEMEZ: `custom.id` sabit 'custom'dur ve
// defterde öyle bir anahtar yoktur. Yine de savunma amaçlı, birleştirmede
// ÜRÜNÜN defteri sonra yazılır.

/** Kapıdan geçmiş kullanıcı satırı mı (şekil kontrolü — kapı ayrı dosyada). */
function isCustomRow(custom) {
  return !!custom && typeof custom === 'object' && custom.custom === true && typeof custom.id === 'string';
}

/** Efektif defter: ürünün satırları + (varsa) kullanıcının satırı. */
function registryWith(custom) {
  if (!isCustomRow(custom)) return PROVIDERS;
  return { [custom.id]: custom, ...PROVIDERS };
}

/** True for a known provider id. */
function isProvider(id, custom) {
  const reg = registryWith(custom);
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(reg, id);
}

/** The provider record for `id`, or null. */
function getProvider(id, custom) {
  return isProvider(id, custom) ? registryWith(custom)[id] : null;
}

/** All providers (array), stable order. Kullanıcı satırı SONA eklenir. */
function allProviders(custom) {
  const base = Object.values(PROVIDERS);
  return isCustomRow(custom) ? [...base, custom] : base;
}

// A TOML string literal for a `-c key=value` override. The `-c` value is parsed as
// TOML (codex --help), so a string value must be double-quoted; we also escape `"`
// and `\` so a crafted registry value can never break out of the literal. Our own
// registry is trusted, but the escape keeps this correct if models ever come from
// settings.
function tomlString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The codex `-c` argv overrides that register + SELECT provider `id` for this launch.
 * PER-LAUNCH (never persisted into ~/.codex/config.toml — same discipline as the
 * ADP-227 MCP overrides). Returns [] for an unknown provider (→ caller no-op → codex
 * default provider, backward compatible).
 *
 *   -c model_providers.<id>.name="<label>"
 *   -c model_providers.<id>.base_url="<baseUrl>"
 *   -c model_providers.<id>.env_key="<envKey>"
 *   -c model_providers.<id>.wire_api="responses"
 *   -c model_provider="<id>"
 *
 * The MODEL itself is NOT set here — the app passes it via `--model` (withModel), so
 * per-task model selection and provider selection stay independent layers.
 */
function codexProviderArgs(id, custom) {
  const p = getProvider(id, custom);
  if (!p) return [];
  const base = `model_providers.${p.id}`;
  // needsShim:true → adapter portu; shimPortEnv dolu → sanitize eden geçiş; yoksa doğrudan.
  const baseUrl = effectiveBaseUrl(p);
  return [
    '-c', `${base}.name=${tomlString(p.label)}`,
    '-c', `${base}.base_url=${tomlString(baseUrl)}`,
    '-c', `${base}.env_key=${tomlString(p.envKey)}`,
    '-c', `${base}.wire_api=${tomlString(p.wireApi)}`,
    '-c', `model_provider=${tomlString(p.id)}`,
  ];
}

/**
 * The env var (name→key) codex reads for provider `id`'s API key, or null when the
 * provider is unknown / no key given. Injected into the codex pane env main-side.
 */
function providerKeyEnv(id, key, custom) {
  const p = getProvider(id, custom);
  if (!p) return null;
  const k = typeof key === 'string' ? key.trim() : '';
  if (!k) return null;
  return { [p.envKey]: k };
}

/**
 * Human chip label for (provider, modelId): "Groq · Llama 3.3 70B". Falls back to the
 * raw model id when the model isn't in the registry, and to just the provider label
 * when no model is given. null for an unknown provider (→ caller uses its default
 * model labeller — modelDetect.labelForModelId).
 */
function providerModelLabel(id, modelId, custom) {
  const p = getProvider(id, custom);
  if (!p) return null;
  const m = typeof modelId === 'string' ? modelId.trim() : '';
  if (!m) return p.label;
  const known = p.models.find((x) => x.id === m);
  return `${p.label} · ${known ? known.label : m}`;
}

module.exports = {
  PROVIDERS,
  isCustomRow,
  isProvider,
  getProvider,
  allProviders,
  codexProviderArgs,
  providerKeyEnv,
  providerModelLabel,
  upstreamBaseUrl,
  effectiveBaseUrl,
};
