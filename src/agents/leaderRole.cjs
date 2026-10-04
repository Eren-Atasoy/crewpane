'use strict';

// LDR-F1 — LİDER ROL SLUG'LARININ TEK KAYNAĞI (saf leaf, sıfır bağımlılık).
//
// ── NEDEN BU DOSYA VAR ──────────────────────────────────────────────────────
// Aynı liste bugüne kadar BEŞ yerde yaşıyordu:
//   electron/agentRunner.js        (spawn kablolaması — `--disallowedTools Task`)
//   src/app/lib/agentIdentity.ts   (kimlik metni + rozet)
//   src/app/lib/workersForSpawn.ts (delegasyonda lideri worker kümesinden düşür)
//   src/app/lib/jarvisVoice.ts     (ses yönlendirmesi)
//   src/app/components/PixelOfficeInner.tsx (Phaser sahnesi)
// Beşi de aynı dört slug'ı sayıyordu ve her biri "diğerleriyle senkron tut" diye
// yorum taşıyordu. LDR-F1 lider pane'ine OTOMATİK YAZAN bir yol açıyor: bu kararın
// kaynağı bir kopyada kayarsa ürün, lider OLMAYAN bir pane'in oturumunu silebilir
// ya da gerçek liderde hiç tetiklenmez. Karar tek yerde yaşar; kopyalar (Phaser
// leaf'i + ses leaf'i) `leaderRole.test.cjs` DRIFT KİLİDİ ile bu dosyaya bağlıdır.
//
// SÖZLEŞME:
//   • Karar ROLE bakar, İSME değil (ADP-630/707: "Fury" bir isimdir, `lead` bir roldür).
//   • Saf: IO yok, Date yok, global yok → hem main (CJS) hem renderer (TS import)
//     hem `node --test` doğrudan yükler.
//   • Bu dosya template çözümü YAPMAZ. `agentIdentity.isLeaderRole` ham slug'a EK
//     olarak `roleToTemplateSlug(...) === 'ceo'` dalını da uygular (katalogda
//     karşılığı olmayan miras rolleri için) — o dal TS tarafında kalır, çünkü
//     katalog da orada yaşar.

/**
 * Ekibe iş dağıtan roller. Departmandan BAĞIMSIZ: bir kanadın lideri hangi
 * departmanda olursa olsun bu slug'lardan birini taşır.
 * ADP-133/ADP-053 kümesi — sıra anlamlı değil, içerik anlamlı.
 */
const LEADER_SLUGS = Object.freeze(['lead', 'skool-lead', 'ceo', 'orchestrator', 'team-lead', 'team lead', 'teamlead']);

const LEADER_SLUG_SET = new Set(LEADER_SLUGS);

/**
 * Ham rol slug'ı bir LİDER rolü mü? (Template çözümü YOK — bkz. başlıktaki not.)
 * @param {string|null|undefined} role
 * @returns {boolean}
 */
function isLeaderRoleSlug(role) {
  if (typeof role !== 'string') return false;
  const key = role.trim().toLowerCase();
  return key ? LEADER_SLUG_SET.has(key) : false;
}

/**
 * DRIFT-GUARD tablosu — bu dosyanın hükmü ile kopyaların hükmü AYNI olmalı.
 * `leaderComposer.IDLE_FIXTURES` ile aynı desen: fikstür veridir, test onu koşar.
 * Her giriş: [ad, girdi, beklenen].
 */
const LEADER_ROLE_FIXTURES = Object.freeze([
  ['lead lider', 'lead', true],
  ['skool-lead lider', 'skool-lead', true],
  ['ceo lider', 'ceo', true],
  ['orchestrator lider', 'orchestrator', true],
  ['büyük harf + boşluk kırpılır', '  LEAD  ', true],
  ['frontend worker', 'frontend', false],
  ['backend worker', 'backend', false],
  ['qa worker', 'qa', false],
  ['boş dize lider DEĞİL', '', false],
  ['null lider DEĞİL', null, false],
  ['undefined lider DEĞİL', undefined, false],
  ['sayı lider DEĞİL (tip körü olma)', 1, false],
  ['isim rol değildir — "fury" lider DEĞİL', 'fury', false],
]);

module.exports = {
  LEADER_SLUGS,
  LEADER_SLUG_SET,
  isLeaderRoleSlug,
  LEADER_ROLE_FIXTURES,
};
