// CrewPane — ADP-894/ENT-F1: PTY'YE METİN YAZMANIN TEK SATIR-SONU SÖZLEŞMESİ (main).
//
// ADP-894 bu sözleşmeyi `src/app/lib/pastePayload.ts`e yazdı ve renderer'ın iki
// teslim yolunu (delegasyon dispatch'i + kullanıcı yazımı) onarmıştı. ENT-F1
// ölçtü ki ANA SÜREÇ de pane'e prompt yazıyor (supervisor yeniden gönderimi,
// lider uyandırma, devir özeti, `/clear`) ve o yollar HAM yazıyordu.
//
// Bu dosya artık sözleşmenin TEK uygulamasıdır; TS tarafı buradan RE-EXPORT eder
// (`src/app/lib/pastePayload.ts`). İkinci bir kopya yazmak, ADP-894'ün "iki yol da
// aynı fonksiyondan geçer" kararını sessizce bozardı.
//
// Leaf-modül disiplini: runtime kardeş-import YOK → `node --test` doğrudan yükler.

'use strict';

/** Bracketed-paste işaretçileri (DEC 2004) — uyumlu TUI bloğu TEK yapıştırma sayar. */
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

/**
 * Satır sonlarını LF'e indirger: `\r\n` → `\n`, yalnız `\r` → `\n`.
 * NEDEN LF (CR değil): üretimde kanıtlanmış davranış budur; buradaki tek amaç
 * CR'ı YOK ETMEK — ham `\r` raw-mode TTY'de ENTER demektir (erken gönderim).
 * @param {string} text
 */
function normalizeEol(text) {
  return String(text).replace(/\r\n?/g, '\n');
}

/** Sondaki tüm CR/LF'leri at — gönderen Enter'ı AYRI keystroke olarak yazar. */
function stripTrailingEol(text) {
  return String(text).replace(/[\r\n]+$/, '');
}

/** Çok satırlı metni bracketed-paste ile sar; tek satırlıyı OLDUĞU GİBİ bırak. */
function bracketIfMultiline(text) {
  const t = String(text);
  return /\n/.test(t) ? `${BRACKETED_PASTE_START}${t}${BRACKETED_PASTE_END}` : t;
}

/**
 * Pty'ye YAZILACAK yükün kanonik hâli: satır sonları normalize + sondaki Enter
 * kırpılmış + çok satırlıysa bracketed-paste.
 * @param {string} text
 * @param {{bracketed?:boolean}} [opts] `bracketed:false` → yalnız normalize (kabuk pane'i).
 */
function pastePayload(text, opts = {}) {
  const normalized = stripTrailingEol(normalizeEol(text));
  return opts && opts.bracketed === false ? normalized : bracketIfMultiline(normalized);
}

module.exports = {
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END,
  normalizeEol,
  stripTrailingEol,
  bracketIfMultiline,
  pastePayload,
};
