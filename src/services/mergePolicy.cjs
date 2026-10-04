// CrewPane — B-01 Faz D: MERGE DURUM MAKİNESİ + ONAY POLİTİKASI (GIT-BACKBONE-SPEC §2.6/§2.7).
//
// TAMAMEN SAF. Neden önemli: "otopilotta kim onaylar" sorusu bir GÜVENLİK kararıdır
// (R-7: otomatik merge kötü kodu `dev`'e sokar). Saf olduğu için karar matrisinin
// HER hücresi `node --test` ile ölçülebilir — kapının gerçekten düştüğünü iddia
// etmek yerine GÖSTERİYORUZ.
//
// ─────────────────────────────────────────────────────────────────────────────
// KİLİTLİ KARARLAR (Eren — K5, K6, §2.7)
// ─────────────────────────────────────────────────────────────────────────────
//   • Hedef varsayılan `dev`. `main` ASLA varsayılan değil.
//   • `main` hedefi HER DURUMDA patron onayı ister — otopilot bile otomatikleştiremez.
//   • Onay KARMA: normal mod → patron; otopilot → ayara göre lider/otomatik.
//   • Otopilot tanımı İKİ koşullu: ayar öyle diyor VE o an otopilot koşuyor.
//   • Gate (test/typecheck) ya da sır taraması KIRMIZI ise otomatik/lider onayı
//     DÜŞER → patrona sorulur. Sessiz merge YOK (H-12).

'use strict';

/** Görev merge durumları (`tasks.merge_state`). */
const STATES = Object.freeze([
  'none',       // izolasyon yok / henüz başlamadı
  'isolated',   // worktree + branch var, ajan çalışıyor
  'review',     // "işim bitti" — inceleme kartı
  'approved',   // onaylandı, merge bekliyor
  'merged',     // hedefe indi
  'conflict',   // merge-tree ön-uçuşu çakışma buldu
  'abandoned',  // iptal
]);

/**
 * İZİNLİ GEÇİŞLER. Buraya yazılmayan her geçiş REDDEDİLİR — `update_task` ile
 * board'dan gelen keyfi bir `merge_state` değeri durumu geriye/ileriye zıplatamaz
 * (ör. `none → merged`: hiç ölçülmemiş bir dalı "merge edilmiş" ilan etmek).
 */
const TRANSITIONS = Object.freeze({
  none: ['isolated', 'abandoned'],
  isolated: ['review', 'abandoned', 'isolated'],
  review: ['approved', 'isolated', 'conflict', 'abandoned'],
  approved: ['merged', 'conflict', 'review', 'abandoned'],
  conflict: ['review', 'isolated', 'abandoned'],
  merged: [],           // uç durum; geri alma REVERT'tir, durum değişimi değil
  abandoned: ['isolated'],
});

/** Geçiş geçerli mi? (SAF) */
function canTransition(from, to) {
  if (!STATES.includes(from) || !STATES.includes(to)) return false;
  return (TRANSITIONS[from] || []).includes(to);
}

/**
 * @returns {{ok:true, state:string} | {ok:false, why:string}}
 */
function transition(from, to) {
  const f = STATES.includes(from) ? from : 'none';
  if (!STATES.includes(to)) return { ok: false, why: `bilinmeyen durum: ${JSON.stringify(to)}` };
  if (!canTransition(f, to)) return { ok: false, why: `geçersiz geçiş: ${f} → ${to}` };
  return { ok: true, state: to };
}

/** Onay makamları. */
const APPROVERS = Object.freeze(['boss', 'leader', 'auto']);

/**
 * ONAY KARARI (§2.7 matrisi) — SAF.
 *
 * @param {{
 *   target?:string,            // merge hedefi ('dev' | 'main' | …)
 *   setting?:string,           // projects.merge_approval: 'boss'|'leader'|'auto'
 *   autopilot?:boolean,        // O AN otopilot koşuyor mu (main ölçer)
 *   gate?:{ok:boolean, why?:string}|null,        // proje gate komutu sonucu
 *   secretScan?:{ok:boolean, findings?:Array}|null, // merge diff'i sır taraması
 *   conflict?:boolean,         // merge-tree ön-uçuşu çakışma buldu mu
 * }} ctx
 * @returns {{approver:'boss'|'leader'|'auto', auto:boolean, blocked:boolean, reasons:string[], why:string}}
 *   `auto:true` → insan onayı beklenmeden merge edilir.
 *   `blocked:true` → merge HİÇ teklif edilmez (çakışma/sır) — onaydan bağımsız.
 */
function decideApproval(ctx = {}) {
  const reasons = [];
  const target = typeof ctx.target === 'string' && ctx.target ? ctx.target : 'dev';
  const setting = APPROVERS.includes(ctx.setting) ? ctx.setting : 'boss';
  const autopilot = ctx.autopilot === true;

  // 1) BLOKE eden koşullar — onaydan ÖNCE gelir (kimse onaylayamaz).
  let blocked = false;
  if (ctx.conflict === true) {
    blocked = true;
    reasons.push('merge-tree ön-uçuşu ÇAKIŞMA buldu → hedef ağaca dokunulmaz (H-1)');
  }
  const secretBad = ctx.secretScan && ctx.secretScan.ok === false;
  if (secretBad) {
    blocked = true;
    const n = Array.isArray(ctx.secretScan.findings) ? ctx.secretScan.findings.length : 0;
    reasons.push(`sır taraması BULGU verdi (${n} alan) → merge BLOKE (G-4)`);
  }

  // 2) Onay makamı.
  let approver = setting;
  if (target === 'main') {
    approver = 'boss';
    reasons.push("hedef 'main' → her durumda patron onayı (K5/G-7); otopilot otomatikleştiremez");
  } else if (!autopilot && setting !== 'boss') {
    approver = 'boss';
    reasons.push(`ayar '${setting}' ama otopilot KOŞMUYOR → normal modda patron onayı (§2.7 iki koşul)`);
  }

  // 3) Gate kırmızıysa otomatik/lider onayı DÜŞER (H-12).
  const gateBad = ctx.gate && ctx.gate.ok === false;
  if (gateBad && approver !== 'boss') {
    reasons.push(`gate KIRMIZI (${ctx.gate.why || 'sebep bildirilmedi'}) → otomatik/lider onayı DÜŞTÜ, patrona sorulur`);
    approver = 'boss';
  } else if (gateBad) {
    reasons.push(`gate KIRMIZI (${ctx.gate.why || 'sebep bildirilmedi'}) — patron onayında bu bilgi kartta gösterilir`);
  }

  const auto = !blocked && (approver === 'auto' || approver === 'leader');
  if (auto) reasons.push(`otopilot + ayar '${setting}' → ${approver} otomatik onaylar`);
  else if (!blocked) reasons.push('patron onay kartı çıkar');

  return { approver, auto, blocked, reasons, why: reasons.join(' · ') };
}

/**
 * Merge ÖN KOŞULLARI (§2.8 adım 3) — SAF ölçüm değerlendirmesi.
 * Hedefi tutan BİRİNCİL ağaç temiz mi, beklenen commit'te mi, orada ajan pane'i var mı.
 */
function checkPreconditions(m = {}) {
  const problems = [];
  if (m.targetDirty === true) problems.push('H-8: hedef ağaç KİRLİ — önce commit/stash gerekir');
  if (m.agentPaneInPrimary === true) problems.push('K7 ihlali: birincil ağaçta canlı ajan pane\'i var');
  if (m.targetBranchMismatch === true) problems.push('hedef branch beklenen commit\'te değil');
  if (m.commitCount === 0) problems.push('dalda commit YOK — merge edilecek iş yok (§2.6)');
  if (m.lockHeld === true) problems.push('proje merge kilidi başka bir yazarda (§2.8 adım 2)');
  return { ok: problems.length === 0, problems, why: problems.join(' · ') };
}

module.exports = {
  STATES,
  TRANSITIONS,
  APPROVERS,
  canTransition,
  transition,
  decideApproval,
  checkPreconditions,
};
