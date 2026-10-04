#!/usr/bin/env node
// ADP-244 Faz 3 (ADR-019 §3) — env ikizleri: CREWPANE_X ⇄ CREWPANE_X.
//
// SÖZLEŞME (tek türetme noktası):
//   • dual-write  — yazıcı merkezleri her değeri İKİ adla da yazar (aynı değer, aynı anda).
//   • dual-read   — okuyucular `readEnv(base)` ile okur: önce CREWPANE_X, yoksa CREWPANE_X.
//   • Legacy ad ≥1 sürüm daha çalışır; kill-date yalnız Eren onayıyla.
//
// ⛔ SPLIT-BRAIN YASAĞI — bu modülün ASIL işi:
// Bir adı ikizlersen, o adın GEÇTİĞİ HER LİSTEYİ de ikizlemek ZORUNDASIN — özellikle
// agentRunner'ın scrub listesi (PANE_SCOPED_ENV_KEYS). Aksi hâlde: app bir ajan pane'inden
// açıldığında dış pane'in CREWPANE_LEADER_ID'si scrub EDİLMEZ, iç pane'lere sızar ve
// yeni-ad-öncelikli okuyucu onu tercih eder → worker'lar DIŞ liderin kimliğiyle atfedilir
// (ADP-251'in çözdüğü hatanın ikiz-ad üzerinden geri gelmesi). `bothNames()` bu yüzden var:
// listeler tek tek elle yazılmaz, buradan türetilir.
//
// ⛔ PINNED (ikiz-OKUMA YASAK, yalnız pin noktasında ikiz-YAZIM):
//   CREWPANE_INSTANCE — config dizinini (~/.crewpane[-dev|-test]) ve tmux oturumunu türetir.
//   CREWPANE_HOME     — o dizinin taban yolu (e2e relocation seam).
//   CREWPANE_ENV      — ENV-01: hangi BACKEND HATTI (local|dev|prod). İki ad ayrışırsa
//                        süreç "lokaldeyim" sanıp PROD kimlik sunucusuna kayıt açar —
//                        INSTANCE ayrışmasının bire bir aynısı. Okuma tek yerden:
//                        envProfile.readEnvName(); yazma pin noktasında dualWrite.
// Bunlar `instancePaths.cjs`'in çözünürlük girdileri. İkiz-okuma açılırsa iki ad ayrışabilir
// ve süreç PROD dizinini TEST sanabilir (2026-07-10 incident sınıfı: prod live-panes.json
// silinmesi). Bu yüzden readEnv() bu adlarda ATAR — okuyucu tarafı Faz 4'te (Eren onay
// kapısı, config dizini taşınırken) TEK SEFERDE döner. Pin noktası ikiz yazar ki Faz 4
// saf bir okuyucu-swap'i olsun.

'use strict';

const CREWPANE_PREFIX = 'CREWPANE_';
const LEGACY_PREFIX = 'CREWPANE_';
const CANONICAL_PREFIX = 'CREWPANE_';

/** Config-dizini/instance çözünürlük girdileri — ikiz-OKUMA yasak (yukarıdaki gerekçe).
 *  ADP-703: ACCOUNT da aynı sınıfta — veri kökünü (`accounts/<key>`) türetir. İki ad
 *  ayrışırsa süreç YANLIŞ HESABIN deposuna yazar (A'nın pane defteri B'ye düşer);
 *  INSTANCE ayrışmasıyla aynı ciddiyette. Okuma tek yerden: instancePaths.accountKey(). */
const PINNED_BASES = Object.freeze(['INSTANCE', 'HOME', 'ACCOUNT', 'ENV']);

/** ['CREWPANE_X', 'CREWPANE_X', 'CREWPANE_X'] — scrub/inherit listeleri BUNDAN türetilir, elle yazılmaz. */
function bothNames(base) {
  return [CREWPANE_PREFIX + base, LEGACY_PREFIX + base, CANONICAL_PREFIX + base];
}

/** Birden çok base için düz ikiz-ad listesi (Object.freeze'li listelerde kullanılır). */
function bothNamesAll(bases) {
  return bases.flatMap(bothNames);
}

function readEnv(base, env) {
  if (PINNED_BASES.includes(base)) {
    throw new Error(
      `crewpaneEnv.readEnv('${base}'): PINNED — ikiz-okuma yasak (config dizini/instance ayrışması). ` +
        `instancePaths.cjs üzerinden oku; ad göçü Faz 4'te tek seferde yapılır.`,
    );
  }
  const e = env || process.env;
  const crewpane = e[CREWPANE_PREFIX + base];
  if (typeof crewpane === 'string' && crewpane) return crewpane;
  const legacy = e[LEGACY_PREFIX + base];
  if (typeof legacy === 'string' && legacy) return legacy;
  const canonical = e[CANONICAL_PREFIX + base];
  if (typeof canonical === 'string' && canonical) return canonical;
  return undefined;
}

/**
 * Dual-write: değeri tüm adlarla hedef env objesine yazar (aynı değer → ayrışamaz).
 * Boş/undefined değer hiçbir adı yazmaz (mevcut "yalnız varsa set et" davranışı).
 * Pin noktası bu fonksiyonu PINNED base'ler için de kullanır — yazım serbest, okuma yasak.
 */
function dualWrite(target, base, value) {
  if (!target || typeof target !== 'object') return target;
  if (typeof value !== 'string' || !value) return target;
  target[CREWPANE_PREFIX + base] = value;
  target[LEGACY_PREFIX + base] = value;
  target[CANONICAL_PREFIX + base] = value;
  return target;
}

/**
 * PINNED bir base'in env'de MEVCUT olan tüm yazılışlarının değerleri.
 * SADECE scrub/drop kararları için.
 */
function pinnedValuesPresent(base, env) {
  const e = env || process.env;
  return [e[CREWPANE_PREFIX + base], e[LEGACY_PREFIX + base], e[CANONICAL_PREFIX + base]].filter((v) => typeof v === 'string' && v);
}

/** Tüm adları siler (scrub/drop noktaları için). */
function dualDelete(target, base) {
  if (!target || typeof target !== 'object') return target;
  delete target[CREWPANE_PREFIX + base];
  delete target[LEGACY_PREFIX + base];
  delete target[CANONICAL_PREFIX + base];
  return target;
}

module.exports = {
  LEGACY_PREFIX,
  CANONICAL_PREFIX,
  PINNED_BASES,
  bothNames,
  bothNamesAll,
  readEnv,
  pinnedValuesPresent,
  dualWrite,
  dualDelete,
};
