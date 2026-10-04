'use strict';

// E2E-MUTE-01 — TTS SUSTURMA KAPISI (yalnız test koşuları için).
//
// SORUN (Eren, 2026-08-20 gece · iki kez yaşandı): GATE regresyon koşusu
// sırasında AgentX Eren'in HOPARLÖRÜNDEN konuşuyor ("3 terminali kapatacağım,
// izin veriyor musun?"). Sesli spec'ler (adp812/818/857/859B/903/908/916/919…)
// GERÇEK app'i açar; bulut TTS anahtarı reddedilince ürün TASARIM GEREĞİ ücretsiz
// yerel sese (macOS `say -v Yelda`) düşer — "ses hiç çıkmaması bir seçenek değil"
// (jarvisVoice.speakWithSettings). Yani ses, bir arıza değil ÜRÜN DAVRANIŞIDIR;
// susturulacak yer ÇIKIŞ ucudur, motor değil.
//
// KARAR — SENTEZ KALIR, ÇIKIŞ GİDER:
//   • main tarafı: hoparlöre giden İKİ süreç (`say` doğrudan-oynatma ve `afplay`)
//     hiç açılmaz. `say` bunun yerine DOSYAYA sentezler (`say -o …aiff`) → kanıt
//     baytı korunur, ses çıkmaz.
//   • renderer tarafı: mp3 GERÇEKTEN çalınır ama `<audio>.muted = true` ile.
//     Zamanlama kanıtı (playing/ended olayları, ilk-ses ms'si, barge-in) AYNEN
//     kalır; hoparlöre hiçbir örnek gitmez. `[[volm 0.0]]` gömülü `say` komutu
//     DENENDİ ve REDDEDİLDİ: üretilen .aiff bayt-bayt AYNI çıkıyor (ölçüldü),
//     yani komut yutuluyor — canlı oynatmada susturacağının kanıtı YOK.
//
// 🔴 AKUSTİK AYAKLAR MUAF: bazı spec'ler ürünün KENDİ sesinin gerçek mikrofona
// dönmesini ölçer (yankı düşürme). O ayaklar ELLE ve açık bayrakla açılır; bayrak
// açıksa susturma KENDİLİĞİNDEN devre dışı kalır, yoksa test ölçtüğünü sanıp
// hiçbir şey ölçmez.
//
// 🪤 Bu kapı YALNIZ test env'i ile açılır. Müşteri build'inde bayrak yoktur →
// `isTtsMuted()` false → ürün yolu BİREBİR eskisi gibi.

/** Susturmayı açan bayrak. */
const MUTE_FLAG = 'CREWPANE_E2E_MUTE_TTS';

/**
 * Ürünün KENDİ sesinin hoparlörden çıkması ÖLÇÜMÜN KENDİSİ olan ayaklar.
 * Bunlardan biri açıkken susturma uygulanmaz (aksi halde spec sessizce yeşile
 * boyanır / "yankı yok" der ve hiçbir şey kanıtlamaz).
 */
const ACOUSTIC_FLAGS = ['ADP903_ACOUSTIC', 'ADP919_ACOUSTIC'];

const truthy = (v) => v === '1' || v === 'true' || v === 'yes' || v === 'on';

/**
 * Bu koşuda TTS çıkışı susturulmalı mı?
 * @param {Record<string,string|undefined>} [env] varsayılan `process.env`
 */
function isTtsMuted(env = process.env) {
  const e = env || {};
  if (!truthy(e[MUTE_FLAG])) return false;          // bayrak yok/kapalı → ürün yolu
  for (const f of ACOUSTIC_FLAGS) if (truthy(e[f])) return false; // akustik ayak muaf
  return true;
}

// ---------------------------------------------------------------------------
// ÇIKIŞ SAYACI — "ses çıkmadı" iddiasının makine cevabı.
// ---------------------------------------------------------------------------
// `audible` = hoparlöre GERÇEKTEN giden çıkış (say doğrudan-oynatma / afplay).
// `suppressed` = susturma yüzünden açılmayan çıkış. Kapalı koşuda audible>0 ve
// suppressed=0 beklenir; bayraklı koşuda audible=0 olmak ZORUNDADIR.
const _counts = { audible: 0, suppressed: 0, synthesized: 0 };

/** Hoparlöre giden bir çıkış açıldı (say-direct | afplay). */
function noteAudibleOutput(kind) {
  _counts.audible += 1;
  _counts.lastAudible = kind || null;
}

/** Susturma yüzünden AÇILMAYAN bir çıkış. */
function noteSuppressedOutput(kind) {
  _counts.suppressed += 1;
  _counts.lastSuppressed = kind || null;
}

/** Ses BAYTI üretildi (kanıt: sentez zinciri hâlâ koşuyor). */
function noteSynthesized(bytes) {
  _counts.synthesized += 1;
  _counts.bytes = (_counts.bytes || 0) + (Number(bytes) || 0);
}

function audioOutputStats() {
  return { ...(_counts) };
}

function resetAudioOutputStats() {
  _counts.audible = 0;
  _counts.suppressed = 0;
  _counts.synthesized = 0;
  _counts.bytes = 0;
  delete _counts.lastAudible;
  delete _counts.lastSuppressed;
}

module.exports = {
  MUTE_FLAG,
  ACOUSTIC_FLAGS,
  isTtsMuted,
  noteAudibleOutput,
  noteSuppressedOutput,
  noteSynthesized,
  audioOutputStats,
  resetAudioOutputStats,
};
