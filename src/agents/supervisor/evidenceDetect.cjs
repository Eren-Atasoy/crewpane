'use strict';

const { SETTLE_SOURCES } = require('./constants.cjs');
const { composerState } = require('../leaderComposer.cjs');
const { countDoneMarkers } = require('../../services/markerSafe.cjs');

/**
 * ADP-735 — bir kaydın bakılacak TÜM kanıt yolları. Birincil `evidencePath`, ardından
 * `evidenceAlt` (main'in `evidencePath.cjs` ile ürettiği alternatif kökler).
 */
function evidencePaths(rec) {
  const list = [];
  if (rec.evidencePath) list.push(rec.evidencePath);
  if (Array.isArray(rec.evidenceAlt)) {
    for (const p of rec.evidenceAlt) if (typeof p === 'string' && p && !list.includes(p)) list.push(p);
  }
  return list;
}

/**
 * RES-IDX-01 — kanıt BİRİNCİL yolda değil bir ALTERNATİF kökte bulunduysa hüküm
 * cümlesine bunu yaz.
 */
function foundElsewhereNote(rec, foundPath) {
  if (!rec || !rec.evidencePath || !foundPath || foundPath === rec.evidencePath) return '';
  return ` (⚠ BAŞKA KÖKTE bulundu — beklenen: ${rec.evidencePath})`;
}

/** Bir aday yolun dispatch anındaki parmak izi (yol-başına defter, yoksa birincil). */
function baselineFor(rec, p) {
  const map = rec.evidenceBaselines;
  if (map && typeof map === 'object' && Object.prototype.hasOwnProperty.call(map, p)) return map[p];
  return p === rec.evidencePath ? rec.evidenceBaseline : null;
}

/** Kanıt dosyası dispatch-baseline'ından FARKLI mı? (ADP-279 semantiği, çok-adaylı) */
function evidenceChanged(rec, io) {
  for (const p of evidencePaths(rec)) {
    let cur = null;
    try { cur = io.fingerprint(p); } catch { continue; }
    if (cur === null) continue; // bu adayda dosya yok → sıradaki
    const base = baselineFor(rec, p);
    if (base === undefined) return true; // baseline alınamadı → varlık yeter
    if (cur !== base) return true;
  }
  return false;
}

/**
 * ADP-735 — "BOŞA DÜŞEN WORKER'DA ÖNCE DOSYA SİSTEMİNE BAK". Beklenen çıktı adaylardan
 * birinde VAR mı ve dispatch'ten SONRA mı yazıldı?
 *
 * @returns {{path:string, mtimeMs:number}|false|null} bulundu | bakıldı-yok | bakılamadı
 */
function evidenceFresh(rec, io) {
  const paths = evidencePaths(rec);
  if (!paths.length) return null;
  let looked = false;
  for (const p of paths) {
    let st = null;
    try { st = io.evidenceStat(p); } catch { st = null; }
    if (!st || typeof st !== 'object') continue; // bu sonda bağlı değil (eski wiring)
    looked = true;
    if (!st.exists) continue;
    // ">=" bilerek: dispatch ile yazım aynı milisaniyeye düşebilir (hızlı alt-görev).
    if (typeof st.mtimeMs === 'number' && st.mtimeMs >= (rec.dispatchedAt || 0)) {
      return { path: p, mtimeMs: st.mtimeMs };
    }
  }
  return looked ? false : null;
}

/** Kanıt HERHANGİ bir kanalda var mı? (mtime sondası → içerik-hash sondası) */
function evidenceSeen(rec, io) {
  const fresh = evidenceFresh(rec, io);
  if (fresh) return fresh;
  return evidenceChanged(rec, io) ? { path: rec.evidencePath, mtimeMs: 0 } : null;
}

/**
 * ADP-761 — marker SAYACI (varlık değil ADET).
 */
function markerCount(rec, buffer) {
  if (!buffer || !rec.subtaskId) return 0;
  return countDoneMarkers(buffer, rec.subtaskId, { promptPayload: rec.promptPayload });
}

/**
 * Pane çıktısında worker'ın KENDİ DONE marker'ı var mı — DISPATCH'TEN SONRA?
 */
function markerSeen(rec, buffer) {
  const count = markerCount(rec, buffer);
  if (count === 0) return false;
  const baseAt = typeof rec.markerBaseline === 'number' ? rec.markerBaseline : 0;
  if (baseAt === 0) return true;
  const lenAt = typeof rec.markerBufferLen === 'number' ? rec.markerBufferLen : 0;
  const base = buffer.length < lenAt ? 0 : baseAt; // tampon budandı → taban güvenilmez
  return count > base;
}

/**
 * Uçuştaki tek kayda çoklu-sinyal tespiti uygula.
 * @returns {{status:string, by:string, reason:string|null}|null}
 */
function detect(rec, pane, t, ctx) {
  const { io, cfg, touch, touchSoft, safeBuffer, log } = ctx;

  // (1) KANIT — en güçlü sinyal; pane canlı olsa bile geçerli (ADP-565 hali).
  if (evidenceChanged(rec, io)) return { status: 'done', by: SETTLE_SOURCES.EVIDENCE, reason: null };

  const buffer = pane ? safeBuffer(rec.paneId) : '';
  // (2) MARKER — worker "bitti" dedi; kanıt bekleniyorsa kanıt da şart.
  if (markerSeen(rec, buffer)) {
    if (rec.evidencePath) {
      if (!rec.markerSeenAt) {
        rec.markerSeenAt = t;
        touch();
        log(
          `supervisor: ${rec.key} worker BİTTİ dedi (marker) ama beklenen çıktı henüz yok — ` +
            `hüküm YOK, kanıt yoklanmaya devam ediyor: ${evidencePaths(rec).join(' | ')}`,
        );
      }
    } else {
      return { status: 'done', by: SETTLE_SOURCES.MARKER, reason: null };
    }
  }

  // (3) PANE EXIT — pty öldü. Kanıtın diske düşmesi için kısa bir tolerans tanı.
  if (!pane) {
    if (!rec.paneGoneAt) { rec.paneGoneAt = t; touch(); return null; }
    if (t - rec.paneGoneAt < cfg.paneGoneGraceMs) return null;
    const freshOnExit = evidenceFresh(rec, io);
    if (freshOnExit) {
      return {
        status: 'done',
        by: SETTLE_SOURCES.EVIDENCE,
        reason: `pane kapandı ama beklenen çıktı yazılmış: ${freshOnExit.path}${foundElsewhereNote(rec, freshOnExit.path)}`,
      };
    }
    return {
      status: 'failed',
      by: SETTLE_SOURCES.PANE_EXIT,
      reason: rec.evidencePath
        ? `pane kapandı ve beklenen çıktı hiçbir adayda yok: ${evidencePaths(rec).join(' | ')}`
        : 'pane kapandı, tamamlanma sinyali yok',
    };
  }
  if (rec.paneGoneAt) { rec.paneGoneAt = 0; touch(); } // pane geri geldi (restore)

  // (4) SESSİZ + PROMPT'TA BEKLİYOR (ADP-672'nin ana düzeltmesi)
  const bytes = typeof pane.bytes === 'number' ? pane.bytes : buffer.length;
  if (!rec.paneSeen || rec.paneSeen.bytes !== bytes) {
    rec.paneSeen = { bytes, at: t };
    touchSoft(); // PERF-BG-01 — canlılık sayacı; 210 KB'lık defteri tek başına yazdırmaz
    return null;
  }
  if (!cfg.idleMs || t - rec.paneSeen.at < cfg.idleMs) return null;
  let cs = 'unknown';
  try { cs = composerState(buffer); } catch { cs = 'unknown'; }
  if (cs !== 'empty') return null; // meşgul/bilinmiyor → EMİN DEĞİLİZ → bekle

  const fresh = evidenceFresh(rec, io);
  if (fresh) {
    return {
      status: 'done',
      by: SETTLE_SOURCES.EVIDENCE,
      reason: `worker prompt'a döndü ve beklenen çıktı dispatch'ten SONRA yazılmış: ${fresh.path}${foundElsewhereNote(rec, fresh.path)}`,
    };
  }

  const quietMs = t - rec.paneSeen.at;
  const quietText = quietMs < 60_000 ? `${Math.round(quietMs / 1000)} saniyedir` : `${Math.round(quietMs / 60_000)} dakikadır`;

  const failAfter = Math.max(cfg.idleFailMs || 0, cfg.idleMs);
  if (quietMs < failAfter) {
    if (!rec.idleSince) {
      rec.idleSince = t;
      touch();
      log(
        `supervisor: ${rec.key} SESSİZ (${quietText}) + kanıt yok — henüz hüküm YOK, ` +
          `${Math.round(failAfter / 60_000)} dk dolmadan başarısız SAYILMAZ`,
      );
    }
    return null;
  }
  return {
    status: 'failed',
    by: SETTLE_SOURCES.IDLE,
    reason:
      (rec.markerSeenAt ? 'worker BİTTİ dedi ama çıktı hiç oluşmadı; ' : '') +
      `worker ${quietText} sessiz ve boş prompt'ta bekliyor — alt-görev KOŞMUYOR` +
      (rec.evidencePath
        ? `, beklenen çıktı hiçbir adayda yok: ${evidencePaths(rec).join(' | ')}`
        : ', tamamlanma sinyali yok'),
  };
}

module.exports = {
  evidencePaths,
  foundElsewhereNote,
  baselineFor,
  evidenceChanged,
  evidenceFresh,
  evidenceSeen,
  markerCount,
  markerSeen,
  detect,
};
