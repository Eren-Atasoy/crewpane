// RENDERER-STATE-01 — renderer'ın KÜÇÜK kişisel durumu için adlı kalıcı depo.
//
// SORUN (KRR-DRAFT-PERSIST-01 §0, ölçüldü): gömülü Next sunucusu her açılışta rastgele porta
// bağlanır (`getFreePort()` → `listen(0)`), renderer origin'i değişir ve localStorage her
// açılışta BOŞ gelir. 18 kullanıcı tercihi ("Sessiz 30 dk", rapor "yeni" işareti, Agent X
// konumu/kipi, pano sekmesi, Görünüm seçenekleri…) bu yüzden her açılışta sıfırlanıyordu.
// Sabit port çözüm değil: iki kopyanın çakışmaması için var (SMOKE-ISO-01).
//
// ÇÖZÜM: hesap kökünde `renderer-state/<ad>.json`. Ad main'de beyaz listededir (renderer
// rastgele dosya adı yazamaz). Dosya gövdesi `{ entries: { <anahtar>: { v: <ham dize>,
// at: <ms> } }, migrated?: true }`: localStorage'ın dize sözleşmesi korunur, `at` SYNC-F1-7
// tercih köprüsüyle anahtar bazında "son yazan kazanır" için tutulur. Atomik yazım (tmp +
// rename), SYNC get (açılış önbelleği), async set. `null` = dosyayı sil.
//
// Neden ofis köprüsü (`office-state.json`) değil: o blob her yazımda bütünüyle gider ve
// ofis geçişi içindeki her anahtarı yedekler; kişisel bildirim/rapor durumu oraya girmemeli.
//
// SAF MODÜL: Electron bağı yok; `node --test electron/rendererState.test.cjs`.

'use strict';

const path = require('node:path');
const { atomicWriteFileSync } = require('../../platform/atomicWrite.cjs');

/** Hesap kökündeki dizin adı (accountUserData.USERDATA_ACCOUNT_ENTRIES'te TEK girdi). */
const RENDERER_STATE_DIR = 'renderer-state';

/**
 * Beyaz liste. Bir ad = bir dosya = bir özellik grubu. Hangi localStorage anahtarının hangi
 * ada düştüğünü renderer (`src/app/lib/rendererState.ts`) bilir; main yalnız adı kabul eder.
 */
const RENDERER_STATE_NAMES = Object.freeze([
  'notifications', // sessiz 30 dk, zil geçmişi
  'reports', // ajan raporu "yeni" filigranı, raporlar görünümü, okuma tercihleri
  'agentx', // Agent X konumu/kipi, yerel STT bildirimi, uyandırma dürtmesi
  'taskboard', // sekme durumu, görülen sprintler
  'voice', // sesli istem: otomatik gönder, basılı tut
  'office-view', // Tek Ofis, ızgara, kaydırmalı geçiş, birleşik çizim
  'search', // arama paleti son kullanılanlar
  'layout', // yanıt akışı yüksekliği, tasarım denetçisi, tema preset hafızası
  'session', // son bilinen kiracı, varlık istemci kimliği
]);

const NAME_SET = new Set(RENDERER_STATE_NAMES);
/** Dosya başına tavan (arama son 20 + zil 30 + rapor filigranı rahat sığar). */
const MAX_BYTES = 512 * 1024;
const MAX_KEY_LEN = 200;

function isName(name) {
  return typeof name === 'string' && NAME_SET.has(name);
}

/** Gelen gövdeyi süz: yalnız `{v: string, at: sayı}` girdiler kalır. */
function sanitize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const src = value.entries;
  if (!src || typeof src !== 'object' || Array.isArray(src)) return null;
  const entries = {};
  for (const key of Object.keys(src)) {
    if (!key || key.length > MAX_KEY_LEN) continue;
    const e = src[key];
    if (!e || typeof e !== 'object' || typeof e.v !== 'string') continue;
    entries[key] = { v: e.v, at: Number.isFinite(e.at) ? e.at : 0 };
  }
  const out = { entries };
  if (value.migrated === true) out.migrated = true;
  return out;
}

/**
 * @param {{ dir: () => string, fs?: typeof import('node:fs') }} opts
 *   `dir` her çağrıda çözülür (hesap kökü açılışta bağlanır; hesap değişimi süreci yeniden başlatır).
 */
function createRendererStateStore({ dir, fs: fsOpt } = {}) {
  const fsMod = fsOpt || require('node:fs');
  const cache = new Map(); // tam yol → gövde | null

  function fileFor(name) {
    if (!isName(name)) throw new Error(`rendererState: listede olmayan ad "${name}"`);
    return path.join(dir(), `${name}.json`);
  }

  function get(name) {
    let file;
    try { file = fileFor(name); } catch { return null; }
    if (cache.has(file)) return cache.get(file);
    let v = null;
    try { v = sanitize(JSON.parse(fsMod.readFileSync(file, 'utf8'))); } catch { v = null; } // yok/bozuk → boş
    cache.set(file, v);
    return v;
  }

  function set(name, value) {
    let file;
    try { file = fileFor(name); } catch (err) { return { ok: false, error: err.message }; }
    try {
      if (value == null) {
        try { fsMod.unlinkSync(file); } catch { /* zaten yok */ }
        cache.set(file, null);
        return { ok: true };
      }
      const clean = sanitize(value);
      if (!clean) return { ok: false, error: 'invalid' };
      const json = JSON.stringify(clean);
      if (Buffer.byteLength(json, 'utf8') > MAX_BYTES) return { ok: false, error: 'too-large' };
      atomicWriteFileSync(file, json, { fs: fsMod, encoding: 'utf8', mode: 0o600 });
      cache.set(file, clean);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  return { get, set, fileFor };
}

module.exports = {
  RENDERER_STATE_DIR,
  RENDERER_STATE_NAMES,
  MAX_BYTES,
  isName,
  sanitize,
  createRendererStateStore,
};
