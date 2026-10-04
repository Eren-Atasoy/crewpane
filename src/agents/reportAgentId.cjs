'use strict';

// REPORTS-AGENT-ID-01 (FB-1016) — RAPOR DOSYA ADINDAN AJAN KİMLİĞİ: TEK KAYNAK (saf leaf).
//
// ── NEDEN BU DOSYA VAR ──────────────────────────────────────────────────────
// Aynı soru üç yerde üç farklı cevapla yaşıyordu:
//   src/lib/reports.ts        parseFilename  → son segment ajandır (korpus sözlüğüyle)
//   scripts/resultsIndex.cjs  parseFileName  → son segment sabit listedeyse ajandır
//   src/components/ReportsView.tsx            → agent_name'i takıma eşler (çözmez)
// Üçü de `split('-')` ile TEK segment arıyordu. Ürün rapor adını `<GÖREV>-<agent_id>.md`
// yazar (delegationBridge → reportFileName) ve müşterinin agent_id'si TİRELİ olabilir
// (`takim-qa`, `backend-engineer-123456`): son segment `qa` / `123456` çıkıyor, hiçbir
// takıma düşmüyor, sayaçlar 0 (FB-1016). `-2`/`-3` kopya eki de aynı yoldan kırıyordu.
//
// SÖZLEŞME:
//   • Ajan kimliği ROSTER ile çözülür (dosya adından tahmin edilmez). Roster çağıranın
//     verdiği kimlik kümesidir: ReportsView → canlı employees.agent_id; reports.ts →
//     korpustan türeyen sözlük; resultsIndex.cjs → kendi listesi. Kimsenin adı burada yok.
//   • EN UZUN eşleşme kazanır (`codex-i` ve `codex-i-abla` ikisi de rosterdaysa
//     `X-codex-i-abla.md` → `codex-i-abla`).
//   • `<görev>-<ajan>-<N>.md` (N = 1-2 hane) kopya ekidir → `copy: N`, görev kodu ve
//     ajan eki taşımaz.
//   • Ajan sonda değilse (`ADP-630-jazz-v2.md`) en SAĞDAKİ roster koşusu alınır,
//     kalan `tail` olur (reports.ts'in eski "sondan tara" davranışının korunması).
//   • Eşleşme yoksa `matched:false, agentId:null` — SESSİZ DÜŞÜRME YOK; çağıran
//     "takımsız" kovasına koyar ve sayar.
//   • Saf: IO yok, global yok → main (CJS), renderer/Next (TS import), script ve
//     `node --test` aynı dosyayı yükler.

const COPY_SUFFIX = /^(.+)-(\d{1,2})$/;
// Ad-benzeri kimlik: harfle başlar; harf/rakam/alt çizgi/tire. Salt sayı (`2`) ve boş
// değer roster'a giremez (kopya ekiyle karışırdı).
const ID_SHAPE = /^[a-z][a-z0-9_-]*$/;

/**
 * Roster'ı normalize et: küçük harf, kırpılmış, ad-benzeri, tekrarsız, UZUNDAN KISAYA
 * sıralı (en uzun eşleşme için tarama sırası). Girdi Iterable<string> ya da boş.
 * @param {Iterable<unknown>|null|undefined} roster
 * @returns {string[]}
 */
function normalizeRoster(roster) {
  const seen = new Set();
  if (roster) {
    for (const raw of roster) {
      if (typeof raw !== 'string') continue;
      const id = raw.trim().toLowerCase();
      if (id && ID_SHAPE.test(id)) seen.add(id);
    }
  }
  return [...seen].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * `<görev>-<ajan>[-N].md` → { taskId, agentId, copy, tail, matched }.
 * @param {string} filename  Çıplak dosya adı (`.md` uzantısı isteğe bağlı).
 * @param {Iterable<unknown>|null|undefined} roster  Bilinen ajan kimlikleri.
 */
function resolveReportAgent(filename, roster) {
  const base = String(filename || '').replace(/\.md$/i, '');
  const lower = base.toLowerCase();
  // ASCII-dışı küçültme uzunluk değiştirebilir (İ → i̇); o zaman dilimleri lower'dan al.
  const src = lower.length === base.length ? base : lower;
  const none = { taskId: base, agentId: null, copy: null, tail: '', matched: false };
  const ids = normalizeRoster(roster);
  if (!ids.length || !lower) return none;

  const cm = COPY_SUFFIX.exec(lower);
  const stem = cm ? cm[1] : null;
  const copyN = cm ? Number(cm[2]) : null;

  // 1) Sonda: `-<id>` ya da `-<id>-<N>` (uzundan kısaya → en uzun kazanır).
  for (const id of ids) {
    if (endsWithSeg(lower, id)) {
      return { taskId: src.slice(0, lower.length - id.length - 1), agentId: id, copy: null, tail: '', matched: true };
    }
    if (stem && endsWithSeg(stem, id)) {
      return { taskId: src.slice(0, stem.length - id.length - 1), agentId: id, copy: copyN, tail: '', matched: true };
    }
  }

  // 2) Ortada: en SAĞDAKİ `-<id>-` koşusu; kalan kuyruk `tail`.
  let best = null;
  for (const id of ids) {
    const idx = lower.lastIndexOf(`-${id}-`);
    if (idx <= 0) continue; // 0 = ajan ilk segment olurdu (görev kodu boş) → değil
    if (!best || idx > best.idx || (idx === best.idx && id.length > best.id.length)) best = { idx, id };
  }
  if (best) {
    const after = best.idx + best.id.length + 2;
    return { taskId: src.slice(0, best.idx), agentId: best.id, copy: null, tail: src.slice(after), matched: true };
  }
  return none;
}

/** `s` `-<id>` ile bitiyor ve önünde en az bir segment var mı? */
function endsWithSeg(s, id) {
  return s.length > id.length + 1 && s.endsWith(`-${id}`);
}

module.exports = { resolveReportAgent, normalizeRoster };
