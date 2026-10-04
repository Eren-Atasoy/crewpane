'use strict';

// ADP-712 — PANE GÖRÜNÜM DURUMU (okunabilir mod) — pencereler arası TEK GERÇEK.
//
// Bir pane'in İKİ görünümü olabilir (ADP-593: ızgara hücresi + ayrı pencere) ama
// pty TEKTİR. Görünüm tercihi (ADP-640 okunabilir mod) renderer'da tutulursa iki
// pencere birbirini görmez: kullanıcı ayrı pencerede okunabilir moda geçer, pane'i
// geri koyar ve terminal görünümüne "geri düşer" — sebebini de göremez.
//
// Bu modül o tercihin main-süreç defteridir. Saf ve Electron'suz (leaf-modül
// disiplini): `node --test` doğrudan yükler, main yalnız IPC + yayın ekler.

/** paneId → { readable } */
const views = new Map();

const DEFAULT_VIEW = Object.freeze({ readable: false });

/** Yalnız BİLİNEN alanları al; tip dışı değerler yok sayılır (renderer'a güvenme). */
function sanitize(patch) {
  const out = {};
  if (patch && typeof patch === 'object' && typeof patch.readable === 'boolean') {
    out.readable = patch.readable;
  }
  return out;
}

/** Pane'in görünüm durumu (bilinmiyorsa varsayılan — asla null dönmez). */
function getPaneView(paneId) {
  if (typeof paneId !== 'string' || !paneId) return { ...DEFAULT_VIEW };
  const cur = views.get(paneId);
  return cur ? { ...cur } : { ...DEFAULT_VIEW };
}

/**
 * Durumu güncelle. → { ok, paneId, readable, changed }
 * `changed` false ise çağıran YAYIN YAPMAZ (boşta IPC trafiği yok).
 */
function setPaneView(paneId, patch) {
  if (typeof paneId !== 'string' || !paneId) return { ok: false, error: 'paneId yok' };
  const next = { ...getPaneView(paneId), ...sanitize(patch) };
  const prev = views.get(paneId);
  const changed = !prev || prev.readable !== next.readable;
  views.set(paneId, next);
  return { ok: true, paneId, readable: next.readable, changed };
}

/** Pane öldü → defteri de düşür (hayalet kayıt bırakma). */
function clearPaneView(paneId) {
  return views.delete(paneId);
}

/** Şu an varsayılandan FARKLI olan pane'ler (teşhis/test). */
function listPaneViews() {
  return [...views.entries()].map(([paneId, v]) => ({ paneId, readable: v.readable }));
}

/** Test yardımcısı — defteri boşalt. */
function resetPaneViews() {
  views.clear();
}

module.exports = { getPaneView, setPaneView, clearPaneView, listPaneViews, resetPaneViews, DEFAULT_VIEW };
