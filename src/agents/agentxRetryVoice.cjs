// AXP-15 — SESLİ "TEKRAR GÖNDER / YENİDEN DENE" SINIFLANDIRICISI (saf, bağımlılıksız).
//
// AXP-09 §5 kusuru: "Tekrar gönder." yönlendiricide `gönder` fiiline takılıp YENİ TASLAK
// açıyordu; kullanıcı İLETİLEMEDİ makbuzunu kastetmişti. Bu sınıf kontrol sınıfıdır
// (dur/sus/uyu emsali): renderer, beyin ve yönlendiriciden ÖNCE sorar; eşleşirse son
// `doğrulanamadı` makbuza `agentx.retry(id)` gider (hedef seçimi `agentxReceipts.ts::
// pickRetryTarget`). Kelimeler `intentLexicon.cjs::RETRY_DELIVERY_WORDS` (tek gerçek).
//
// Eşleşme TAM CÜMLEDİR (agentxDraft `wholeIs` disiplini): "Raporu tekrar gönder" bir iş
// gövdesidir, "Parker'a tekrar gönder" hedefli bir iletimdir — ikisi de bu kapıdan
// GEÇMEZ (yanlış pozitif = başkasının işini yeniden denemek). Hitap ("Jarvis, tekrar
// gönder") ve noktalama tolere edilir; olumsuz biçim ("tekrar gönderME") eşleşmez çünkü
// kümedeki hiçbir kalıp -me/-ma taşımaz ve eşleşme tam-dizedir.
//
// Renderer TS bunu uzantılı import eder (jarvisVoice.ts::spawnSpec.cjs emsali);
// `node --test` her iki yoldan da çözer.

'use strict';

const { RETRY_DELIVERY_WORDS } = require('./intentLexicon.cjs');
const { trLower } = require('../voice/turkishMorph.cjs');

const ALL = Object.freeze([...RETRY_DELIVERY_WORDS.tr, ...RETRY_DELIVERY_WORDS.en]);

/** Katla: küçük harf (TR kuralı), noktalama → boşluk, boşluk sıkıştır. */
function fold(text) {
  return trLower(String(text == null ? '' : text))
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} text  söylenen cümle
 * @param {{addressTokens?: readonly string[]}} [opts]  başta tolere edilen hitaplar ("jarvis")
 * @returns {{retry: boolean, matched: string|null}}
 */
function classifyRetryDelivery(text, opts = {}) {
  let flat = fold(text);
  if (!flat) return { retry: false, matched: null };
  for (const tok of opts.addressTokens || []) {
    const a = fold(tok);
    if (a && flat.startsWith(`${a} `)) { flat = flat.slice(a.length + 1); break; }
  }
  for (const w of ALL) {
    if (flat === fold(w)) return { retry: true, matched: w };
  }
  return { retry: false, matched: null };
}

module.exports = { classifyRetryDelivery };
