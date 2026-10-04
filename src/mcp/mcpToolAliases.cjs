#!/usr/bin/env node
// ADP-244 Faz 2 (ADR-019 §3) — MCP tool ADI alias'ları: crewpane_* → crewpane_*.
//
// İsim migrasyonunun EN GÖRÜNÜR dilimi ajanlar için araç adlarıdır. Big-bang rename
// yasak (ADR-019 §1): çalışan lider oturumlarının prompt'ları ve spawn edilmiş pane'lerin
// system prompt'ları hâlâ `crewpane_delegate` diyor. Bu yüzden dual-register:
//
//   • KANONİK ad  = `crewpane_*`  (yeni; dokümanlar/prompt'lar buraya taşınacak)
//   • LEGACY ad   = `crewpane_*`   (deprecated AMA çalışır — AYNI handler'a bağlı)
//
// Her iki ad da tools/list'te görünür (keşfedilebilirlik: eski prompt'lu bir lider
// legacy adı listede görür ve çağırabilir; yeni prompt'lu lider kanonik adı görür).
// Legacy girdinin description'ı "DEPRECATED — use X" ile başlar ki model kanonik adı
// tercih etsin.
//
// KAPSAM DIŞI (bilinçli — ADR-019): MCP *server* KEY'leri (`crewpane-task`,
// `crewpane-delegate`, `crewpane-browser` → `mcp__crewpane-task__*` tool referansları)
// SABİT kalır; onlar dış oturumların MCP config'lerinde ve lider allow-list'lerinde geçer,
// Faz 4'te tek pencerede değişir. Dosya adları da sabit (agentRunner path'leri).

'use strict';

const LEGACY_PREFIX = 'crewpane_';
const CANONICAL_PREFIX = 'crewpane_';

/** `crewpane_delegate` → `crewpane_delegate` (kanonik olmayan ad verilirse null). */
function legacyNameFor(canonicalName) {
  if (typeof canonicalName !== 'string' || !canonicalName.startsWith(CANONICAL_PREFIX)) return null;
  return LEGACY_PREFIX + canonicalName.slice(CANONICAL_PREFIX.length);
}

/**
 * CDX-F1 (CDX-R1 H4) — LEGACY İKİZİN KAPISI.
 *
 * ÖLÇÜLDÜ (CDX-R1 §3-F, gerçek stdio `tools/list`): bir LİDER pane'inin bağlamına
 * 20 araç / 25.675 bayt şema giriyordu ve bunun **7 aracı / 9.174 baytı (%36,
 * ≈2.294 jeton)** yalnızca bu alias katmanıydı — aynı handler'a bağlı KOPYA araçlar.
 * Her pane, her oturumda o bedeli ödüyordu; üstelik iki eşdeğer ad model için bir
 * SEÇİM SORUSU (araç belirsizliği) yaratıyor.
 *
 * Varsayılan hâlâ AÇIK (`1`): ADR-019 §1'in big-bang rename yasağı sürüyor — dışarıda
 * koşan, eski prompt'lu bir oturum `crewpane_delegate` diyebilir. Değişen şey şu:
 * CrewPane'in KENDİ doğurduğu pane'ler artık `CREWPANE_MCP_LEGACY_ALIASES=0` ile
 * açılır (agentRunner spawn env'i) → yeni pane'ler kanonik-only, kill-switch (env'i
 * `1` yapmak / hiç vermemek) ikizleri geri getirir.
 *
 * @param {Array} tools kanonik araç listesi
 * @param {{enabled?: boolean, env?: object}} [opts] `enabled` verilmezse env'den okunur
 */
function legacyAliasesEnabled(env) {
  const src = env && typeof env === 'object' ? env : (typeof process !== 'undefined' ? process.env : {});
  return String(src.CREWPANE_MCP_LEGACY_ALIASES ?? '1') !== '0';
}

function withLegacyAliases(tools, opts) {
  const enabled = opts && typeof opts.enabled === 'boolean'
    ? opts.enabled
    : legacyAliasesEnabled(opts && opts.env);
  if (!enabled) return [...tools]; // kanonik-only: ikiz HİÇ üretilmez (bağlam ucuzlar)
  const aliases = [];
  for (const tool of tools) {
    const legacyName = legacyNameFor(tool.name);
    if (!legacyName) continue; // zaten nötr adlı araç (ör. task MCP'deki create_task) → alias yok
    aliases.push({
      ...tool,
      name: legacyName,
      description: `DEPRECATED — use \`${tool.name}\` instead (same tool, new name). ${tool.description}`,
      deprecated: true,
      aliasOf: tool.name,
    });
  }
  return [...tools, ...aliases];
}

module.exports = { withLegacyAliases, legacyAliasesEnabled, legacyNameFor, LEGACY_PREFIX, CANONICAL_PREFIX };
