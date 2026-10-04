// CRASH-R1 — GÜNLÜK HEDEFİ: İZOLE KOPYA KENDİ DOSYASINA YAZSIN.
//
// NEDEN VAR (ölçülmüş, 16.09 01:39): canlı uygulama (pid 61189) ile yayın
// hattının açılış duman testi (`scripts/smoke_boot.sh`, pid 20907) AYNI günlük
// dosyasına yazıyordu. Duman testi CREWPANE_HOME'u da `--user-data-dir`i de
// yalıtıyor ama günlük yolu `app.getPath('logs')`tan gelir ve o yol yalnız
// uygulama ADINA ('crewpane-shell') bağlıdır — ADP-592 adı kanaldan BAĞIMSIZ
// pinler. Sonuç iki ayrı arıza:
//
//   1. KARIŞMA — `logLine` her satırı `fs.appendFileSync(LOG_PATH)` ile yazar ve
//      LOG_PATH bir YOL dizesidir. Duman kopyası açılışta `initLog()` rotasyonunu
//      koşturup dosyayı yeniden adlandırınca canlı uygulama AYNI YOLA yazmaya
//      devam eder — yani duman kopyasının YENİ dosyasına. İki sürecin satırları
//      tek dosyada iç içe geçer.
//   2. KANIT KAYBI — rotasyon HER açılışta koşar (5 kuşak). 16.09 gecesi yayın
//      zinciri 4 kez açılış yaptı; canlı uygulamanın ölüm anını taşıyan dosya
//      iki saat içinde .2'den .5'e indi. Bir kuşak daha = kanıt silinirdi.
//
// KÖK NEDEN ÖLÇÜMÜNÜ DOĞRUDAN ENGELLEDİ: ölüm anındaki dosyada iki sürümün
// satırları yan yana duruyor ve YALNIZ 'kapanış hunisi' dizgesi 0.2.45 ile
// 0.2.46'yı ayırt ediyor (ölçüldü: 0.2.45 asar'ında 0, 0.2.46'da 3). Geri kalan
// satırlar ('killing next server', 'next server exited', …) İKİ sürümde de
// birebir aynı → hangi satır hangi sürece ait, dosyadan ÇIKARILAMIYOR.
//
// KARAR: yalıtım işaretlerinden BİRİ bile varsa günlük ayrı bir dosyaya gider.
// Canlı uygulamada hiçbiri yoktur → dosya adı BİREBİR eskisi (`crewpane-shell.log`),
// rotasyon zinciri ve mevcut destek/QA yolları aynen korunur.
//
// PLATFORM: saf yol/dize işi — darwin/win32/linux'ta aynı. Ayırıcı `path` ile
// gelir; dosya adı üretimi ayırıcıdan bağımsızdır.

'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

const BASE = 'crewpane-shell';
const EXT = '.log';

/** Dosya adına GÜVENLE girebilen kısa etiket. Boşsa null (çağıran hash'e düşer). */
function slugify(raw, max = 24) {
  const s = String(raw || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, max)
    .replace(/[-.]+$/g, '');
  return s || null;
}

/** Yolun kısa, çakışması pratikte imkânsız parmak izi. */
function fingerprint(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 6);
}

/**
 * Yalıtım işaretlerini ÖLÇ (tahmin etme). Hepsi çağıran tarafından enjekte edilir
 * ki birim testi gerçek env/argv'ye dokunmasın.
 *
 * @param {object} o
 * @param {string|null} o.homeEnv         CREWPANE_HOME (yoksa null)
 * @param {string}      o.osHome          os.homedir()
 * @param {string[]}    o.argv            process.argv
 * @param {boolean}     o.e2e             CREWPANE_E2E / AUTOTEST
 * @returns {{isolated:boolean, source:string|null, value:string|null}}
 */
function detectIsolation({ homeEnv = null, osHome = '', argv = [], e2e = false } = {}) {
  // 1) CREWPANE_HOME — duman testinin ve e2e'nin BİRİNCİ yalıtımı.
  //    `os.homedir()` ile aynıysa yalıtım YOKTUR (env sadece açıkça set edilmiş).
  if (homeEnv && String(homeEnv) !== String(osHome)) {
    return { isolated: true, source: 'CREWPANE_HOME', value: String(homeEnv) };
  }
  // 2) --user-data-dir — Chromium profili yalıtımı (MAC-X64-01 FAZ B).
  const udd = (Array.isArray(argv) ? argv : []).find((a) => String(a).startsWith('--user-data-dir='));
  if (udd) {
    return { isolated: true, source: 'user-data-dir', value: String(udd).slice('--user-data-dir='.length) };
  }
  // 3) e2e/autotest — kendi filosunu canlı günlükten uzak tutar.
  if (e2e) return { isolated: true, source: 'e2e', value: 'e2e' };
  return { isolated: false, source: null, value: null };
}

/**
 * Günlük dosyasının TAM yolu.
 *
 * Yalıtım yoksa → `<logsDir>/crewpane-shell.log` (BİREBİR eski davranış).
 * Yalıtım varsa → `<logsDir>/crewpane-shell.<etiket>-<parmakizi>.log`
 *
 * Etiket yalıtan yolun son parçasından türer (insan okuyabilsin: destek klasöre
 * bakınca hangi dosyanın duman/e2e olduğunu görür), parmak izi çakışmayı keser.
 * Kuşak zinciri (`initLog`) `path.parse` ile çalıştığı için üretilen ad
 * `crewpane-shell.smoke-home-a1b2c3.1.log` şeklinde döner — canlı uygulamanın
 * `crewpane-shell.1.log` zinciriyle ÇAKIŞMAZ.
 */
function resolveLogFile(opts = {}) {
  const logsDir = opts.logsDir || '';
  const base = opts.base || BASE;
  const ext = opts.ext || EXT;
  const iso = detectIsolation(opts);
  if (!iso.isolated) {
    return { file: path.join(logsDir, `${base}${ext}`), isolated: false, source: null, tag: null };
  }
  const tag = `${slugify(path.basename(iso.value)) || 'iso'}-${fingerprint(iso.value)}`;
  return {
    file: path.join(logsDir, `${base}.${tag}${ext}`),
    isolated: true,
    source: iso.source,
    tag,
  };
}

module.exports = { resolveLogFile, detectIsolation, slugify, fingerprint, BASE, EXT };
