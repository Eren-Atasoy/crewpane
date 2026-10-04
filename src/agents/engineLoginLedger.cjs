// ENG-F4-01 — "BURADA GİRİŞ YAPILDI" DEFTERİ (ENG-LOGIN-R1 §6 F4'ün ikinci yarısı).
//
// KAPATILAN SINIF. Yedi motorun hesap DURUMU komutu YOK (ölçüldü: copilot · goose ·
// qwen · opencode · amp · kimi · crush). Onlarda `readStatus` dürüstçe
// `loggedIn:null` + `statusUnknown:true` döner ve rozet "Durum okunamıyor" der —
// bu ENG-UX-B2'de sevk edildi ve DOĞRU. Ama tek başına EKSİK: Eren copilot'ta
// OAuth'u BİTİRDİ (tarayıcı "Authorization received" dedi) ve ürün hâlâ aynı
// cümleyi kuruyordu. "Restart de düzeltmez" şikâyetinin sebebi buydu — ürünün
// kendi BAŞLATTIĞI ve SIFIR ÇIKIŞLA biten giriş akışının hafızası YOKTU:
// `engineAuth.startLogin` `unverified:true` üretiyor, o alan session snapshot'ına
// bile girmeden düşüyordu (ENG-F4-01 ölçümü).
//
// Bu defter tam olarak ŞU TEK OLGUYU yazar: "bu kurulumda, bu motor+profil için
// giriş akışını BİZ koşturduk ve sıfır çıkışla bitti (t anında)". Hüküm DEĞİL:
// motorun bugün gerçekten bağlı olduğunu SÖYLEMEZ (söyleyemez — komut yok).
// Rozet bu yüzden "Bağlı" değil, "Burada giriş yapıldı · doğrulanamadı" der.
//
// ⚠️ SIR YOK. Dosyada yalnız motor kimliği + profil kimliği + zaman damgası var;
// jeton, e-posta, yol, hiçbiri yazılmaz ([[ADP-584]] "en güvenli sır, hiç sahip
// olmadığın sır"). Dosya yine de 0600 yazılır — kimin hangi motora girdiği bile
// gereksiz yere paylaşılacak bir bilgi değildir.
//
// ⚠️ MOTOR ADI DALI YOK. Defter hangi motorun durum komutu olduğunu BİLMEZ; onu
// çağıran (engineAuth) descriptor'dan bilir. Buraya 14. motor eklendiğinde tek
// satır değişmez.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteFileSync } = require('../../platform/atomicWrite.cjs');

/** Defter dosyası — `engine-profiles.json`ın kardeşi, aynı kök. */
const LEDGER_FILE = 'engine-logins.json';

/** Motor/profil kimliği için tek güvenli desen (dosya adı değil, ANAHTAR parçası). */
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** Varsayılan profil — `engineProfiles.DEFAULT_PROFILE_ID` ile aynı değer. */
const DEFAULT_PROFILE_ID = 'default';

// ── Saf yardımcılar (IO yok → test edilebilir) ──────────────────────────────

function isId(value) {
  return typeof value === 'string' && ID_RE.test(value);
}

/** `<motor>:<profil>` — profil verilmezse varsayılan. Geçersiz girdi → null. */
function keyOf(engine, profileId) {
  if (!isId(engine)) return null;
  const profile = isId(profileId) ? profileId : DEFAULT_PROFILE_ID;
  return `${engine}:${profile}`;
}

function emptyLedger() {
  return { version: 1, records: {} };
}

/**
 * Ham defteri normalize eder: bozuk anahtar/kayıt düşer, zaman damgası sayı
 * değilse kayıt YİNE tutulur (`at:null`) — "ne zaman" bilinmemesi "olmadı"
 * demek değildir. Saf.
 */
function normalize(raw) {
  const out = emptyLedger();
  const src = raw && typeof raw === 'object' ? raw : {};
  const records = src.records && typeof src.records === 'object' ? src.records : {};
  for (const [key, value] of Object.entries(records)) {
    const [engine, profile] = String(key).split(':');
    const clean = keyOf(engine, profile);
    if (!clean || clean !== key) continue;
    if (!value || typeof value !== 'object') continue;
    const at = typeof value.at === 'number' && Number.isFinite(value.at) ? value.at : null;
    out.records[key] = { at };
  }
  return out;
}

// ── IO (asla fırlatmaz: defter bir KOLAYLIKTIR, akışı kıramaz) ──────────────

function ledgerPath(home) {
  return path.join(home, LEDGER_FILE);
}

function read(home) {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(ledgerPath(home), 'utf8'));
  } catch {
    raw = null;
  }
  return normalize(raw);
}

function write(home, ledger) {
  try {
    atomicWriteFileSync(ledgerPath(home), `${JSON.stringify(normalize(ledger), null, 2)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Bu motor+profil için kayıtlı bir giriş var mı? */
function hasLogin(home, engine, profileId) {
  const key = keyOf(engine, profileId);
  if (!key) return false;
  return Object.prototype.hasOwnProperty.call(read(home).records, key);
}

/** Girişi KAYDET (idempotent — aynı anahtar üzerine yazılır). */
function recordLogin(home, engine, profileId, at = Date.now()) {
  const key = keyOf(engine, profileId);
  if (!key) return false;
  const ledger = read(home);
  ledger.records[key] = { at: typeof at === 'number' && Number.isFinite(at) ? at : null };
  return write(home, ledger);
}

/**
 * Kaydı SİL — çıkış yapıldığında çağrılır. Kayıt yoksa da `true` döner:
 * "artık kayıt yok" hedefine ulaşılmıştır (idempotent).
 */
function clearLogin(home, engine, profileId) {
  const key = keyOf(engine, profileId);
  if (!key) return false;
  const ledger = read(home);
  if (!Object.prototype.hasOwnProperty.call(ledger.records, key)) return true;
  delete ledger.records[key];
  return write(home, ledger);
}

/**
 * engineAuth'un beklediği dikiş: motor+profile BAĞLANMIŞ üç fonksiyon.
 * engineAuth'a yol/`fs` sızmaz — o yalnız "var mı / yaz / sil" bilir.
 */
function bindLedger(home, engine, profileId) {
  return {
    has: () => hasLogin(home, engine, profileId),
    record: () => recordLogin(home, engine, profileId),
    clear: () => clearLogin(home, engine, profileId),
  };
}

module.exports = {
  LEDGER_FILE,
  DEFAULT_PROFILE_ID,
  // saf
  isId,
  keyOf,
  normalize,
  // yollar
  ledgerPath,
  // IO
  read,
  write,
  hasLogin,
  recordLogin,
  clearLogin,
  bindLedger,
};
