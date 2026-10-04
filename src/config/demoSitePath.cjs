// CrewPane — DEMO-04: TANITIM TURUNUN ÖRNEK SİTESİNİN yol boğazı (tek yardımcı).
//
// 🔑 NEDEN AYRI BİR MODÜL (emsal: `builtinSkillsPath.cjs`): örnek site gömülü
// tarayıcıda `file:` şemasıyla açılır. `file:` isteğini yapan Chromium'dur,
// Electron'un yamalı `fs`'i DEĞİL — asar sanal dosya sistemi orada güvenilir
// biçimde görünmez. Bu yüzden dosya `build.files` ile DEĞİL, `build.extraResources`
// ile paketlenir (emsal: `standalone`, `mobile-web`, `builtin-skills`) ve
// Resources altına GERÇEK bir dosya olarak iner.
//
// Yol hesabı tek yerde durur: ana süreç (IPC), paket kapısı ve birim testi AYNI
// kuralı okusun. İki ayrı yol hesabı = ikinci gerçek = sapma.
//
// Electron'a bağımlı DEĞİL: `app.isPackaged` yerine DURUMDAN türetir (hangi aday
// diskte var), böylece çıplak node çocuklarında ve tmp dizinli birim testinde de
// aynı sonucu verir.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// DİKİŞ — turun `browser.step` değeri (1..5) sayfadaki beş bölüme birebir denk
// gelir: `#s1` … `#s5` (`[data-step="1..5"]`). Bir adımı göstermek isteyen çağıran
// adrese çapa ekler; sayfa ayrıca `?lang=en` ile İngilizce açılır.

/** Paketteki dizin adı (`extraResources[].to`). */
const DIR_NAME = 'demo-site';
/** Kaynak ağacındaki dizin (`extraResources[].from` — repo kökünden). */
const SOURCE_REL = path.join('resources', DIR_NAME);
const ENTRY_FILE = 'index.html';

// Paketli app'te bu dosya `Resources/app.asar` (ya da `…asar.unpacked`) altındadır
// → bir üst dizin HER İKİ durumda da `Resources`. Kaynaktan koşarken `electron/` →
// bir üst dizin repo kökü.
const MODULE_PARENT = path.join(__dirname, '..');

/** Bir yol asar arşivinin İÇİNDE mi? (`app.asar.unpacked` İÇİNDE DEĞİLDİR.) */
function isInsideAsar(p) {
  return String(p)
    .split(path.sep)
    .some((seg) => seg.toLowerCase().endsWith('.asar'));
}

/**
 * Aday site dosyaları — sırayla denenir.
 *   1) `<Resources>/demo-site/index.html`        → paketli app
 *   2) `<repo kökü>/resources/demo-site/index.html` → kaynaktan koşum
 * `resourcesPath` çıplak node çocuklarında undefined'dır (Electron enjekte eder);
 * o durumda liste tek adaya düşer.
 */
function demoSiteCandidates({ resourcesPath = process.resourcesPath, moduleParent = MODULE_PARENT } = {}) {
  const out = [];
  if (typeof resourcesPath === 'string' && resourcesPath) {
    out.push(path.join(resourcesPath, DIR_NAME, ENTRY_FILE));
  }
  if (typeof moduleParent === 'string' && moduleParent) {
    out.push(path.join(moduleParent, SOURCE_REL, ENTRY_FILE));
  }
  out.push(path.join(__dirname, DIR_NAME, ENTRY_FILE));
  return out.filter((p, i) => !isInsideAsar(p) && out.indexOf(p) === i);
}

/** Bir aday GEÇERLİ site dosyası mı: asar dışı + gerçek, boş olmayan dosya. */
function isSiteFile(file, { statSync = fs.statSync } = {}) {
  if (!file || isInsideAsar(file)) return false;
  try {
    const st = statSync(file);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

/**
 * Örnek sitenin dosya yolu — YOKSA `null` (uydurma yol döndürmez: çağıran
 * "site yok" ile "site bozuk"u ayırt edebilsin). DEMO-08'in "eksik site dosyası"
 * kapısı bu fonksiyonun `null`'ını ölçer.
 */
function demoSiteFile(opts = {}) {
  return demoSiteCandidates(opts).find((f) => isSiteFile(f, opts)) || null;
}

/**
 * Gömülü tarayıcıya verilecek adres — `file:///…/demo-site/index.html`, yoksa `null`.
 * `pathToFileURL` ŞART: kurulum yolunda boşluk ve ASCII dışı karakter olabiliyor
 * ("CrewPane Apps", Türkçe kullanıcı adı) — elle `'file://' + p` birleştirmesi
 * o yollarda sessizce kırılır.
 *
 * @param {{ lang?: 'tr'|'en' }} [opts] Sayfa kendi dilini adresten okur (`?lang=en`).
 */
function demoSiteUrl(opts = {}) {
  const file = demoSiteFile(opts);
  if (!file) return null;
  const url = pathToFileURL(file);
  if (opts.lang === 'en') url.search = 'lang=en';
  return url.href;
}

module.exports = {
  DIR_NAME,
  SOURCE_REL,
  ENTRY_FILE,
  isInsideAsar,
  isSiteFile,
  demoSiteCandidates,
  demoSiteFile,
  demoSiteUrl,
};
