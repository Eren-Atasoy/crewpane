'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWriteFileSync } = require('../../../platform/atomicWrite.cjs');
const { restrictFile } = require('../../../platform/restrictPath.cjs');

/**
 * Atomik JSON/metin yazımı + win32 son-çare yerinde-yazım. `tmp` adı bugünküyle
 * BİREBİR aynı tutulur (gizli `.ad.json.<pid>.<rand>.tmp`) — dizin dinleyen hiçbir
 * şey yeni bir dosya deseni görmez. Hata bugünkü gibi FIRLAR (çağıranın catch'i aynı).
 */
function winSafeAtomicWrite(targetPath, data, opts = {}) {
  const dir = path.dirname(targetPath);
  const tmp = path.join(
    dir,
    `.${path.basename(targetPath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  const r = atomicWriteFileSync(targetPath, data, {
    tmp,
    mode: 0o600,
    inPlaceFallback: true, // WIN-FIX-01 — yalnız win32'de etkili (modül içinde guard'lı)
    onInPlace: ({ file, code }) => {
      // Sessiz kalmak YASAK: "atomik yazamadım ama YAZDIM" ayrı bir durumdur.
      const line =
        `[agentRunner] win32 atomik yazım düştü (${code}) → YERİNDE yazıldı (atomik DEĞİL): ${file}`;
      try { (opts.log || console.error)(line); } catch { /* log yazımı yazmayı bloklamaz */ }
    },
  });
  restrictFile(targetPath); // ADP-835 (790 I3) — win32'de durumu dürüstçe raporlar
  return r;
}

/**
 * Atomic JSON write for MCP and other configs.
 */
function writeJsonAtomic(targetPath, obj) {
  return winSafeAtomicWrite(targetPath, JSON.stringify(obj, null, 2), { what: path.basename(targetPath) });
}

module.exports = {
  winSafeAtomicWrite,
  writeJsonAtomic,
};
