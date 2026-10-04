'use strict';

// ADP-786 — GÖNDERİLMEMİŞ PROMPT TASLAĞI — pencereler/mod arası TEK GERÇEK.
//
// Eren: "pop-out'ta okunabilir moddayken prompt yazıp, enterlamadan terminali
// yerine geri koyduğumda yazdığım bütün metin sıfırlanıyor."
//
// ÖLÇÜLEN KÖK NEDEN: taslak, okuyucu bileşeninin YEREL React state'iydi
// (`PaneReader` içinde `useState('')`). O state iki yerde birden ölür:
//   • pencere değişimi — pop-out AYRI bir renderer'dır, React ağacı paylaşılmaz;
//   • mod değişimi     — okuyucu `{readable && <PaneReader/>}` ile koşullu mount.
// Karşılaştırma kanıtı: TERMİNAL modunda yazılan metin aynı hareketleri ATLATIYOR,
// çünkü o metin kabuğun satır tamponunda, yani main tarafında yaşıyor.
//
// Bu modül taslağın main-süreç defteridir — [[paneViewState.cjs]]'in kardeşi ve
// aynı disiplinde: saf, Electron'suz (leaf-modül → `node --test` doğrudan yükler),
// main yalnız IPC + yayın ekler. Renderer'daki kutu bir KOPYA DEĞİL, bu defterin
// yazdırılmış hâlidir: her tuşta buraya yazılır, her mount'ta buradan okunur.
//
// KALICILIK SINIRI (bilinçli): defter BELLEKTE. Uygulama yeniden başlayınca pty'ler
// de ölür ve pane kimlikleri yeniden üretilir — taslağı diske yazmak, sahibi
// kalmamış bir metni geri getirmek olurdu. Kapsam: oturum içi pencere/mod değişimi.

/** paneId → taslak metin (string). Boş string = taslak yok. */
const drafts = new Map();

/** Taslak metni (bilinmiyorsa boş string — asla null/undefined dönmez). */
function getPaneDraft(paneId) {
  if (typeof paneId !== 'string' || !paneId) return '';
  const cur = drafts.get(paneId);
  return typeof cur === 'string' ? cur : '';
}

/**
 * Taslağı yaz. → { ok, paneId, text, changed }
 * `changed` false ise çağıran YAYIN YAPMAZ (her tuşta boşuna IPC dolaşmasın:
 * aynı metin tekrar gelirse pencerelere gitmez).
 *
 * Metin KIRPILMAZ: bu kullanıcının yazdığı veridir ve sessiz kırpma, düzeltmeye
 * çalıştığımız kaybın küçük bir kopyası olurdu. Boş string kaydı SİLER (hayalet yok).
 */
function setPaneDraft(paneId, text) {
  if (typeof paneId !== 'string' || !paneId) return { ok: false, error: 'paneId yok' };
  const next = typeof text === 'string' ? text : '';
  const prev = getPaneDraft(paneId);
  const changed = prev !== next;
  if (next) drafts.set(paneId, next);
  else drafts.delete(paneId);
  return { ok: true, paneId, text: next, changed };
}

/** Pane öldü/kapandı → taslağı da düşür (sahipsiz metin birikmesin). */
function clearPaneDraft(paneId) {
  return drafts.delete(paneId);
}

/** Şu an taslağı OLAN pane'ler (teşhis/test). */
function listPaneDrafts() {
  return [...drafts.entries()].map(([paneId, text]) => ({ paneId, length: text.length }));
}

/** Test yardımcısı — defteri boşalt. */
function resetPaneDrafts() {
  drafts.clear();
}

module.exports = { getPaneDraft, setPaneDraft, clearPaneDraft, listPaneDrafts, resetPaneDrafts };
