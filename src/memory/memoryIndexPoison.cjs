// CrewPane — ONNX-CRASH-01 · ZEHİRLİ BELGE DEFTERİ (crash-loop kırıcı).
//
// NEDEN AYRI DEFTER: indeksleme çocuğu ONNX'in C++ tarafında SIGTRAP ile ölürse
// JavaScript'te yakalanacak bir hata YOKTUR — süreç yok olur. Ölçüldü (24.08.2026
// 16:31): çocuk öldü, `phase:'exit'` hiç gelmedi, indeks yarım kaldı ve bir sonraki
// açılışta artımlı plan AYNI belgeyi yeniden sıraya koydu. Yani kusur kendini
// tekrarlayan bir döngüydü: her açılış = bir macOS çökme diyaloğu.
//
// Defter bu döngüyü kırar: bir belge üst üste STRIKE_LIMIT kez koşuyu düşürürse
// ZEHİRLİ işaretlenir ve BİR DAHA denenmez (atlanır + loglanır). Kalıcı ölüm değil:
// dosyanın içeriği değişirse (hash) çentikler sıfırlanır — düzelen belge geri gelir.
//
// İki tarafı da yazar:
//   • ÇOCUK — yakalanabilir hata (embed_failed) → yumuşak çentik, koşu sürer.
//   • EBEVEYN — çocuk anormal öldü (code≠0 / sinyal) → sert çentik, uçuştaki belgeye.
// Bu yüzden defter süreçler arası ve dosya tabanlıdır (bellek yetmez: çocuk ölüyor).

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Bu kadar üst üste düşüşten sonra belge zehirli sayılır. */
const STRIKE_LIMIT = 2;

/** Defter dosyası indeks veritabanının YANINDA durur (aynı yaşam döngüsü). */
function poisonPath(dbFile) {
  const dir = path.dirname(String(dbFile || '.'));
  const base = path.basename(String(dbFile || 'index.db')).replace(/\.db$/i, '');
  return path.join(dir, `${base}-poison.json`);
}

/** Defteri oku. Bozuk/eksikse BOŞ döner — defter bir indekslemeyi ASLA bloklamaz. */
function readLedger({ file, readImpl = fs.readFileSync } = {}) {
  try {
    const raw = JSON.parse(String(readImpl(file, 'utf8')));
    return raw && typeof raw.docs === 'object' && raw.docs ? { docs: raw.docs } : { docs: {} };
  } catch {
    return { docs: {} };
  }
}

function writeLedger({ file, ledger, writeImpl = null, mkdirImpl = null }) {
  try {
    (mkdirImpl || ((d) => fs.mkdirSync(d, { recursive: true })))(path.dirname(file));
    (writeImpl || ((f, s) => fs.writeFileSync(f, s)))(file, `${JSON.stringify(ledger, null, 2)}\n`);
    return true;
  } catch {
    return false; // defter yazılamıyorsa özellik ÇALIŞMAYA DEVAM eder, yalnız koruma zayıflar
  }
}

/**
 * Zehirli işaretli yolların kümesi.
 * @returns {Set<string>}
 */
function poisonedPaths({ file, readImpl = fs.readFileSync, limit = STRIKE_LIMIT } = {}) {
  const { docs } = readLedger({ file, readImpl });
  const out = new Set();
  for (const [p, e] of Object.entries(docs)) {
    if (e && Number(e.strikes) >= limit) out.add(p);
  }
  return out;
}

/**
 * Bir belgeye çentik at.
 * @param {object} o
 * @param {string} o.file defter yolu
 * @param {string} o.docPath çentik atılacak belge
 * @param {string} o.reason makine okur neden ('child_crash' / 'embed_failed' …)
 * @param {string|null} [o.hash] belgenin içerik damgası — DEĞİŞMİŞSE çentikler sıfırlanır
 * @returns {{strikes:number, poisoned:boolean}}
 */
function recordStrike({ file, docPath, reason, hash = null, limit = STRIKE_LIMIT, now = Date.now, ...io } = {}) {
  if (!file || !docPath) return { strikes: 0, poisoned: false };
  const ledger = readLedger({ file, ...io });
  const prev = ledger.docs[docPath] || null;
  // İçerik değiştiyse eski çentikler BAŞKA bir belgeye aittir — sıfırdan başla.
  const carry = prev && (!hash || !prev.hash || prev.hash === hash) ? Number(prev.strikes) || 0 : 0;
  const strikes = carry + 1;
  ledger.docs[docPath] = { strikes, reason, hash: hash || (prev && prev.hash) || null, at: now() };
  writeLedger({ file, ledger, ...io });
  return { strikes, poisoned: strikes >= limit };
}

/** Belge sağ salim indekslendi → çentikleri sil (geçici bir arıza kalıcı olmasın). */
function clearStrikes({ file, docPath, ...io } = {}) {
  if (!file || !docPath) return false;
  const ledger = readLedger({ file, ...io });
  if (!ledger.docs[docPath]) return false;
  delete ledger.docs[docPath];
  return writeLedger({ file, ledger, ...io });
}

module.exports = { STRIKE_LIMIT, poisonPath, readLedger, writeLedger, poisonedPaths, recordStrike, clearStrikes };
