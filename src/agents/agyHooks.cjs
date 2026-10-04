// AGY-03 — ANTIGRAVITY `hooks.json` İÇERİĞİ: TUR BRİFİNGİ + ALT-AJAN BLOĞU.
//
// AGY-01 demeti (`agyWorkspacePlugin.cjs`) `hooks.json`u `enabled:false` bir İSKELET
// olarak yazıyordu: yer tutuyordu ama TEK BİR komut bile koşmuyordu. Bu dosya o
// iskeletin İÇİNİ doldurur — ve yalnız İÇERİĞİ üretir: SAF, IO'SUZ, argv'ye basmaz
// ([[leaf-module-node-test]] → `node --test` doğrudan koşar).
//
// ── İKİ DEĞİŞMEZ, TEK DOSYA ──────────────────────────────────────────────────────
//   1. TUR BRİFİNGİ (ADP-692 kanal A) — `PreInvocation`. claude'da bu iş
//      `UserPromptSubmit` kancasıyla yapılıyor; Antigravity'de dengi `PreInvocation`.
//   2. ALT-AJAN BLOĞU (ADR-004 sert katman) — `PreToolUse` → `{"decision":"deny"}`.
//      claude'da bu iş bir ARGV bayrağı (`--disallowedTools Task`); Antigravity'de
//      argv dengi YOK, taşıyıcı bu dosyadır.
//
// ── 🪤 ÖLÇÜLEN ÜÇ TUZAK (2026-09-15, agy 1.2.2 — hepsi GERÇEK turda) ──────────────
//
// (A) `PreInvocation` TUR BAŞINA DEĞİL, MODEL ÇAĞRISI BAŞINA ATEŞLER.
//     Ölçüldü: tek bir `-p` turunda hook ÜÇ kez koştu (`invocationNum` 0, 1, 2 —
//     model her araç turundan sonra yeniden çağrıldı). claude'un `UserPromptSubmit`
//     kancası tur başına BİR kez ateşler; birebir port edilseydi brifing metni aynı
//     turda 3 kez bağlama girerdi (bağlam israfı + lider aynı bitişi 3 kez okur).
//     ⇒ Brifing YALNIZ `invocationNum === 0`da verilir (`isFirstInvocation`).
//     Bu, "kısa + bütçeli" şartının ÖLÇÜLMÜŞ karşılığıdır.
//
// (B) MCP ÇAĞRISINDA HOOK'UN GÖRDÜĞÜ AD `call_mcp_tool`DUR — GERÇEK ARAÇ ADI DEĞİL.
//     ANTIGRAVITY-R1 §2.2 bunu TAHMİN etmişti; burada ÖLÇÜLDÜ (gerçek tur, ham
//     `PreToolUse` gövdesi):
//         {"name":"call_mcp_tool","args":{"ServerName":"crewpane_crewpane-task",
//                                         "ToolName":"crewpane_board_ping", ...}}
//     ⇒ Araç ADINA dayanan `matcher` bizim köprü araçlarımızda ÇALIŞMAZ (hepsi tek
//        ada düşer). AMA R1'in "gerekirse `args` gövdesine bakan hook" önerisi artık
//        ÖLÇÜLMÜŞ ALAN ADLARIYLA mümkün: `args.ToolName` + `args.ServerName`.
//        İnce taneli MCP kapısı bu dosyada `matcher` ile DEĞİL, çalışma zamanında
//        `agyHookRunner.cjs` içinde gövdeye bakarak kurulur.
//     🪤 NÜANS (AGY-01 §0-4 ile çelişmez, KATMAN farkı): model araç adlarımızı
//        BİLİYOR — şemayı `view_file` ile `~/.gemini/antigravity-cli/mcp/<sunucu>/
//        <araç>.json`dan okuyor. Modelin bildiği ad ile HOOK'un gördüğü ad AYRI
//        katmanlardır; ikisi de doğru ölçülmüş.
//
// (C) 🔴 `decision` ZORUNLUDUR — BOŞ `{}` ARACI DÜŞÜRÜR (ölçüldü, ilk sürüm BURADA
//     KIRILDI). İlk tasarım izinli dalda `{}` basıyordu ("karar basma, motor kendi
//     bilsin"). Gerçek turda MCP çağrısı `state:"ERROR"` oldu ve transcript'e tool
//     result HİÇ düşmedi — yani motor, kararsız bir hook cevabını "geç" diye DEĞİL
//     "düştü" diye okuyor. Belge de `decision`ı (required) diyor; biz "yok sayılır"
//     varsaymıştık.
//     ⇒ Kapı bir araca BAKIYORSA ona BİR CEVAP BORÇLUDUR. Bu, `"*"` matcher'ını
//        büsbütün yasaklar (her aracın izin kararını biz vermiş olurduk) ve izinli
//        dalın cevabını bir TASARIM KARARI hâline getirir:
//
//        • `allow` ancak pane'in otonomisi ZATEN `full` ise basılır — o pane
//          `--dangerously-skip-permissions` ile koşuyor ve motor `always-proceed`
//          diyor (registry `autonomy.level`, ENG-22 ölçümü). Orada `allow` yeni bir
//          izin VERMEZ, pane'in BEYAN EDİLMİŞ hâlini tekrarlar.
//        • Otonomi `full` DEĞİLSE `call_mcp_tool` matcher'a HİÇ GİRMEZ: kapı yerleşik
//          adlara iner ve dolaylı hat KAYBOLUR — ama bu kayıp BEYANLIDIR, kullanıcının
//          onay sorusunu sessizce cevaplamaktan iyidir.
//     Karar VERİDEN çıkar (`permissive` bayrağı), motor adına göre `if` yazılmaz.

'use strict';

/** Demet içindeki hook kaydının adı (motor birleştirmeyi BU adla yapar). */
const HOOK_NAME = 'crewpane';

/**
 * Motorun YERLEŞİK alt-ajan araçları (ölçüldü: stream-json `init` olayının araç
 * listesi — ENG-22-evidence/06 + ANTIGRAVITY-R1 §0-5).
 *
 * `browser_subagent` de buradadır: görünmez bir alt-ajan, tarayıcıyı sürüyor diye
 * görünür olmaz — ADR-004'ün yasakladığı şey "patronun izleyemediği ikinci bir
 * ajan"dır, aracın ne yaptığı değil.
 */
const SUBAGENT_TOOLS = Object.freeze([
  'invoke_subagent',
  'define_subagent',
  'manage_subagents',
  'browser_subagent',
]);

/**
 * Dolaylı yol: MCP araçlarının HEPSİ bu tek adla gelir (tuzak B). Kapının `matcher`ı
 * bu adı DA kapsar ki gövdeye bakan ikinci hat çalışabilsin.
 */
const MCP_TOOL_NAME = 'call_mcp_tool';

/** `call_mcp_tool` gövdesindeki hedef araç/sunucu alanları (ÖLÇÜLDÜ, camelCase değil). */
const MCP_ARG_TOOL_FIELD = 'ToolName';
const MCP_ARG_SERVER_FIELD = 'ServerName';

/**
 * Dolaylı yolda "bu bir alt-ajan mı" süzgeci. Gövdedeki hedef araç ADINA bakar.
 * Bizim dört köprümüz (delegate · task · browser · integrations) bu desene UYMAZ —
 * `crewpane_delegate` GERÇEK, izlenebilir bir pane açar; ADR-004'ün yasakladığı
 * şey o değil, tam tersine ONUN YERİNE geçen görünmez alt-ajandır.
 * Desen kullanıcının BAĞLADIĞI (bizim yazmadığımız) bir MCP sunucusu alt-ajan aracı
 * sunarsa diye vardır: kapı o gün sessizce açık kalmasın.
 */
// 🪤 AYIRAÇ İÇERİDE DE OLABİLİR: `run-sub-agent` deseni ilk yazımda KAÇTI (birim
// testi yakaladı). `sub` ile `agent` arasındaki ayıraç opsiyoneldir.
const MCP_SUBAGENT_PATTERN = /(^|[_.\- ])sub[_.\- ]?agents?([_.\- ]|$)/i;

/**
 * `matcher` REGEX'tir (motorun belgesi: `"run_command\|view_file"`, `"browser_.*"`).
 * Adları `|` ile birleştiririz; `"*"` KULLANILMAZ (tuzak C).
 */
function subagentMatcher(opts) {
  // `includeMcp` YALNIZ izinli (otonomisi `full`) pane'de açılır — tuzak C.
  const names = opts && opts.includeMcp ? [...SUBAGENT_TOOLS, MCP_TOOL_NAME] : [...SUBAGENT_TOOLS];
  return names.join('|');
}

/** Hedef araç adı alt-ajan mı (dolaylı `call_mcp_tool` yolu). */
function isSubagentMcpTool(toolName) {
  return MCP_SUBAGENT_PATTERN.test(String(toolName || ''));
}

/** Doğrudan (yerleşik) araç adı alt-ajan mı. */
function isSubagentTool(name) {
  return SUBAGENT_TOOLS.includes(String(name || ''));
}

/**
 * BLOK GEREKÇESİ — modele ve kullanıcıya GİDEN metin (motor onu `reason` olarak
 * araç hatasının içine koyar; ölçüldü: cevapta AYNEN göründü).
 *
 * İKİ DİLLİ: pane'in dili kullanıcıya göre değişir, kapı değişmez. Metin ayrıca
 * YAPILACAK ŞEYİ söyler ("delege et") — yalnız "yasak" diyen bir gerekçe modeli
 * çaresiz bırakır ve başka bir kaçış yolu aramaya iter.
 */
const DENY_REASON =
  'CrewPane: alt-ajan açmak bu rolde YASAK (ADR-004 değişmezi) — görünmez bir ikinci '
  + 'ajan patronun izleyemediği iş yapar. İşi devretmen gerekiyorsa `crewpane_delegate` '
  + 'aracını kullan: o GERÇEK, ofiste izlenebilen bir pane açar. · EN: opening a subagent '
  + 'is FORBIDDEN in this role; delegate with `crewpane_delegate`, which opens a real, '
  + 'watchable pane.';

/** Hook komutlarının saniye cinsinden tavanı. */
const BRIEFING_TIMEOUT_SEC = 10; // claude kancasıyla AYNI (küçük bir JSON okuması)
const GUARD_TIMEOUT_SEC = 5; // claude kill-guard kapısıyla AYNI (araç ÖNÜNDE durur)

/**
 * `hooks.json` gövdesi.
 *
 * İKİ KOMUT DA YOKSA AGY-01 İSKELETİNİN BİT-BİT AYNISI döner (`enabled:false`,
 * iki boş dizi). Bu kasıtlıdır: hook kurulamayan bir pane (yol çözülemedi, kapı
 * kapatıldı) YARIM bir kapı bırakmaz — ya tam kurulur ya hiç.
 *
 * @param {{briefingCommand?: string|null, guardCommand?: string|null}} [spec]
 */
function buildHooks(spec) {
  const briefing = spec && typeof spec.briefingCommand === 'string' ? spec.briefingCommand.trim() : '';
  const guard = spec && typeof spec.guardCommand === 'string' ? spec.guardCommand.trim() : '';
  const includeMcp = !!(spec && spec.permissive); // tuzak C — dolaylı hat izinli pane'de
  const entry = {
    enabled: !!(briefing || guard),
    PreInvocation: briefing
      ? [{ type: 'command', command: briefing, timeout: BRIEFING_TIMEOUT_SEC }]
      : [],
    // 🪤 ŞEKİL FARKI (motorun belgesi): `PreToolUse` GRUPLU (matcher + hooks sarmalı),
    // `PreInvocation` DÜZ (doğrudan handler listesi). Karıştırılırsa kapı SESSİZCE
    // hiç kurulmaz — motor hata vermez, yalnız hook koşmaz.
    PreToolUse: guard
      ? [{
        matcher: subagentMatcher({ includeMcp }),
        hooks: [{ type: 'command', command: guard, timeout: GUARD_TIMEOUT_SEC }],
      }]
      : [],
  };
  return { [HOOK_NAME]: entry };
}

/** `hooks.json` metni (idempotanlık içerik karşılaştırmasına dayanır → deterministik). */
function hooksText(spec) {
  return `${JSON.stringify(buildHooks(spec), null, 2)}\n`;
}

/**
 * `PreToolUse` KARARI — saf.
 *   • `{decision:'deny'}`  — alt-ajan (doğrudan ad ya da MCP gövdesindeki hedef ad)
 *   • `{decision:'allow'}` — YALNIZ `opts.permissive` (pane otonomisi `full`) iken,
 *                            ve yalnız `call_mcp_tool` dalında
 *   • `null`               — bu araç için karar YOK; çağıran `{}` basar. Buraya
 *                            yalnız matcher'ın kapsamadığı bir ad düşerse gelinir
 *                            (savunma amaçlı dal — normalde ulaşılmaz).
 *
 * @param {object} payload hook'un stdin'den okuduğu gövde
 * @param {{permissive?: boolean}} [opts]
 */
function preToolUseDecision(payload, opts) {
  const call = (payload && payload.toolCall) || {};
  const name = String(call.name || '');
  if (isSubagentTool(name)) return { decision: 'deny', reason: DENY_REASON };
  if (name === MCP_TOOL_NAME) {
    const args = call.args || {};
    if (isSubagentMcpTool(args[MCP_ARG_TOOL_FIELD]) || isSubagentMcpTool(args[MCP_ARG_SERVER_FIELD])) {
      return { decision: 'deny', reason: DENY_REASON };
    }
    // 🔴 BOŞ CEVAP ARACI DÜŞÜRÜR (tuzak C). Bu dala YALNIZ otonomisi `full` olan
    // pane'de gelinir — matcher `call_mcp_tool`u başka türlü zaten kapsamaz.
    if (opts && opts.permissive) return { decision: 'allow' };
  }
  return null;
}

/**
 * Brifing bu model çağrısında verilsin mi (tuzak A). `invocationNum` YOKSA `true`:
 * alanı okuyamadığımız bir sürümde brifingi tümden susturmaktansa bir kez fazla
 * vermek daha az zararlıdır (kayıp > israf).
 */
function isFirstInvocation(payload) {
  const n = payload && payload.invocationNum;
  return typeof n === 'number' ? n === 0 : true;
}

/** `PreInvocation` çıktısı — boş metin → `{}` (boş brifing basma). */
function injectStepsPayload(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) return {};
  return { injectSteps: [{ ephemeralMessage: t }] };
}

module.exports = {
  HOOK_NAME,
  SUBAGENT_TOOLS,
  MCP_TOOL_NAME,
  MCP_ARG_TOOL_FIELD,
  MCP_ARG_SERVER_FIELD,
  DENY_REASON,
  BRIEFING_TIMEOUT_SEC,
  GUARD_TIMEOUT_SEC,
  subagentMatcher,
  isSubagentTool,
  isSubagentMcpTool,
  buildHooks,
  hooksText,
  preToolUseDecision,
  isFirstInvocation,
  injectStepsPayload,
};
