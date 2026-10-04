// ADP-716 — CrewPane'in duyuru ADAPTÖRÜ. Mantık BURADA DEĞİL.
//
// ADP-675'te bu dosya duyuru mantığının tamamını taşıyordu. ADP-716 duyuruyu üç
// ürüne (CrewPane · AgentShot · AgentVoice) açtı; mantık kopyalanmadı, ORTAK
// pakete taşındı:
//
//     packages/announce-core/index.cjs      ← tek gerçek (JS)
//     packages/announce-core/conformance/   ← sözleşmenin çalıştırılabilir tanımı
//     packages/announce-core-py/            ← AgentVoice'un (Python) ikizi
//
// Burada kalan TEK şey uygulamaya özel olan: bu istemcinin feed'deki kimliği.
// Dışa açılan yüzey ADP-675 ile AYNI (main.js / scripts / testler değişmedi).
//
// Yol iki dünyada farklı (crewpane-auth ve shot-core ile AYNI desen): dev'de repo
// kökündeki packages/, paketli app'te asar içine kopyalanan ./packages/.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

function findPackageDir(pkgName) {
  const candidates = [
    path.join(__dirname, 'packages', pkgName),
    path.join(__dirname, '..', 'packages', pkgName),
    path.join(__dirname, '..', '..', 'packages', pkgName),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[1];
}

const CORE_DIR = findPackageDir('announce-core');
const core = require(path.join(CORE_DIR, 'index.cjs'));

/** Bu uygulamanın feed'deki kimliği — `target.apps` bununla eşleşir. */
const APP_ID = 'crewpane';

module.exports = { ...core, APP_ID };
