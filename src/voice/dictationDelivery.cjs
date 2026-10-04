// VOICE-TRUNC-02 — DİKTE TESLİMİ (AgentVoice → köprü → odaklı yüzey).
//
// ─────────────────────────────────────────────────────────────────────────────
// NEDEN VAR — VOICE-TRUNC-01'İN ÖLÇÜMÜ
// ─────────────────────────────────────────────────────────────────────────────
// AgentVoice dikteyi 20'şer UTF-16-birimlik AYRI CGEvent'ler olarak basıyordu
// (5.087 karakter = 255 OS olayı) ve alıcının ana süreci ≥ ~600 ms yanıt
// vermediği anda macOS kuyruktaki sentetik olayları SESSİZCE atıyordu (oturum
// tap'i 255/255 gördü, uygulamaya 7 keydown ulaştı — VOICE-TRUNC-01 §B).
// Bu modül o sınıfı yapısal olarak öldürür: metin OS olay kuyruğuna hiç girmez,
// köprüden TEK parça gelir ve `webContents.insertText` ile odaklı yüzeye iner.
//
// ─────────────────────────────────────────────────────────────────────────────
// NEDEN insertText — ÖLÇÜLDÜ (spike, Electron 42.4.1 + xterm 6.0.0, 31.08)
// ─────────────────────────────────────────────────────────────────────────────
// `webContents.insertText(text)` odaklı öğeye TEK `beforeinput`+`input` çifti
// üretir (`inputType:'insertText'`, data = metnin tamamı; 5.084 kr birebir):
//   • okunabilir kutu (PaneReader textarea) → React onChange — dikte CGEvent'inin
//     BUGÜN izlediği yolun aynısı, 255 olay yerine 1 çağrı;
//   • terminal (xterm helper textarea) → `bulkTextInputGuard` (AV-REPEAT-02)
//     olayı TAM 1 KEZ yakalayıp pty'ye TEK yazımla indirir (spike: handled=1,
//     exact=true; xterm'in IME yedek yolu hiç açılmaz).
// Yani alıcı taraftaki İKİ yüzey de bugün kanıtlanmış (VOICE-TRUNC-01 P1/P2
// "olaylar ulaştığında birebir") boru hattını kullanmaya devam eder — değişen
// yalnız taşıma: kayıplı OS kuyruğu yerine doğrulanabilir HTTP + Chromium IPC.
//
// ─────────────────────────────────────────────────────────────────────────────
// SÖZLEŞME — ENT-F1 ruhu: METİN EN FAZLA BİR KEZ, ENTER HİÇ
// ─────────────────────────────────────────────────────────────────────────────
// Dikte bir GÖNDERİM değildir: kullanıcı composer'da biriktirir, Enter'a kendi
// basar (VOICE-TRUNC-01 A.3: 9 dikte birikip tek mesaj olarak gitti). Bu yüzden
// burada `\r` YOKTUR ve yeniden deneme de YOKTUR — metin ya bir kez iner ya da
// dürüstçe `ok:false` döner (AgentVoice pano-yapıştırma fallback'ine geçer).
// Doğrulama İLERİYE dönüktür (insert'ten sonra yüzey ölçülür), tekrar yazma yok.
//
// TÜM IO ENJEKTE (electron require'ı YOK) → `node --test` doğrudan koşar.

'use strict';

// Dikte metni köprünün gövde sınırından (256KB) küçük kalmalı; 64K karakter
// ~15 dakikalık kesintisiz konuşmadır — üstü büyük olasılıkla arızadır.
const MAX_TEXT_CHARS = 64 * 1024;

// insertText Chromium IPC'si asenkron işler; doğrulama ölçümüne yüzeyin
// (React state / guard sayacı) oturması için kısa, artan beklemeler.
const VERIFY_DELAYS_MS = [50, 150, 300];

/**
 * Renderer'da ÇALIŞACAK odak sondası. Tek kaynak: hem teslimden önce (yüzey
 * var mı?) hem sonra (metin indi mi?) AYNI kod koşar — iki ayrı tanım olmaz.
 *
 * Yüzeyler:
 *   • reader   — PaneReader'ın prompt kutusu (`data-reader-prompt`, ADP-663).
 *                `len` = kutunun o anki değeri (doğrulama: len artışı).
 *   • terminal — xterm'in helper textarea'sı (`[data-pane-key]` içinde).
 *                `bulk` = o pane'in bulkTextInputGuard sayacı (`__bulkHandled`
 *                seam'i, Terminal.tsx). Doğrulama: sayaç artışı = metin pty'ye
 *                TEK yazımla indi.
 *   • field    — CrewPane içindeki DİĞER yazılabilir öğeler (board formu,
 *                görev açıklaması, ayarlar…): input/textarea/contenteditable.
 *                Kayıp sınıfı yalnız pane'de değil, uygulamanın her yerinde
 *                ölsün — dikte bugün de o alanlara CGEvent'le yazıyordu.
 *   • none/other — dikte edilecek yüzey yok → teslim REDDEDİLİR (çağıran
 *                fallback'e geçer). Sessizce yanlış yere yazmak YASAK.
 */
const FOCUS_PROBE_JS = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return { surface: 'none' };
  if (el.hasAttribute && el.hasAttribute('data-reader-prompt')) {
    return {
      surface: 'reader',
      paneId: el.getAttribute('data-reader-prompt') || '',
      len: typeof el.value === 'string' ? el.value.length : 0,
    };
  }
  const paneEl = el.closest ? el.closest('[data-pane-key]') : null;
  if (paneEl && el.classList && el.classList.contains('xterm-helper-textarea')) {
    const host = el.closest('.xterm') ? el.closest('.xterm').parentElement : null;
    const bulk = host && typeof host.__bulkHandled === 'function' ? host.__bulkHandled() : null;
    return {
      surface: 'terminal',
      paneKey: paneEl.getAttribute('data-pane-key') || '',
      bulk,
    };
  }
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'textarea' || (tag === 'input' && !el.readOnly && !el.disabled)) {
    return { surface: 'field', tag, len: typeof el.value === 'string' ? el.value.length : 0 };
  }
  if (el.isContentEditable) {
    return { surface: 'field', tag, len: (el.textContent || '').length };
  }
  return { surface: 'other', tag };
})()`;

/** Gövde doğrulaması — köprü route'u ve testler aynı kuraldan geçer. */
function validateDictationPayload(parsed) {
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'invalid payload' };
  const text = parsed.text;
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: false, error: 'text (non-empty string) is required' };
  }
  if (text.length > MAX_TEXT_CHARS) {
    return { ok: false, error: `text too long (${text.length} > ${MAX_TEXT_CHARS})` };
  }
  return { ok: true, text };
}

/**
 * @typedef {Object} DictationIO
 * @property {()=>Promise<object>} probe        odak sondası (FOCUS_PROBE_JS'i koşturur)
 * @property {(text:string)=>Promise<void>} insertText  odaklı yüzeye ekle (webContents.insertText)
 * @property {(ms:number)=>Promise<void>} sleep
 * @property {(line:string)=>void} [log]
 */

/**
 * Dikte metnini odaklı yüzeye TEK SEFERDE teslim et ve teslimi ÖLÇ.
 *
 * Dönüş: { ok, surface, paneId?, paneKey?, verified, code?, error? }
 *   ok:false + code:'no-focus'  → dikte edilecek yüzey yok (çağıran fallback'e geçer)
 *   ok:true  + verified:false   → insert kabul edildi ama yüzey ölçümü artış
 *                                 göstermedi (ör. 1 karakterlik metin terminalde
 *                                 guard'a takılmaz) — dürüstçe söylenir.
 * @param {string} text
 * @param {DictationIO} io
 */
async function deliverDictation(text, io) {
  const log = typeof io.log === 'function' ? io.log : () => {};
  const INSERTABLE = new Set(['reader', 'terminal', 'field']);
  const before = await io.probe();
  if (!before || !INSERTABLE.has(before.surface)) {
    const surface = before && before.surface ? before.surface : 'none';
    log(`[dictation] reddedildi: odaklı yüzey yok (surface=${surface})`);
    return { ok: false, code: 'no-focus', surface, error: 'no focused dictation surface' };
  }

  await io.insertText(text);

  // Doğrulama İLERİYE dönük ölçümdür, tekrar yazım DEĞİL (metin en fazla bir kez).
  let verified = false;
  let after = null;
  for (const delay of VERIFY_DELAYS_MS) {
    await io.sleep(delay);
    after = await io.probe();
    if (!after || after.surface !== before.surface) continue;
    if (before.surface === 'reader' || before.surface === 'field') {
      // Değer en az metin kadar BÜYÜDÜ mü? (imleç ortadaysa da geçerli —
      // ekleme uzunluğu ölçülür, konumu değil.)
      if (typeof after.len === 'number' && after.len >= (before.len || 0) + text.length) {
        verified = true;
        break;
      }
    } else if (before.surface === 'terminal') {
      // Guard sayacı arttı = metin pty'ye TEK yazımla indi (AV-REPEAT-02 yolu).
      if (typeof after.bulk === 'number' && typeof before.bulk === 'number' && after.bulk > before.bulk) {
        verified = true;
        break;
      }
    }
  }

  const where = before.surface === 'reader'
    ? `reader pane=${before.paneId || '?'}`
    : before.surface === 'terminal'
      ? `terminal pane=${before.paneKey || '?'}`
      : `field tag=${before.tag || '?'}`;
  log(`[dictation] ${where} chars=${text.length} verified=${verified}`);
  return {
    ok: true,
    surface: before.surface,
    ...(before.surface === 'reader' ? { paneId: before.paneId } : {}),
    ...(before.surface === 'terminal' ? { paneKey: before.paneKey } : {}),
    verified,
  };
}

module.exports = {
  deliverDictation,
  validateDictationPayload,
  FOCUS_PROBE_JS,
  MAX_TEXT_CHARS,
  VERIFY_DELAYS_MS,
};
