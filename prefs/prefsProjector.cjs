// SYNC-F1-7 (Prowl) — PROJEKTÖR + UYGULAYICI: `settings.json` ⇄ `prefs/app-prefs.json`.
//                     Tasarım: SYNC-F1-TASARIM.md §5.5.1 · §5.5.3
//
// ═══════════════════════════════════════════════════════════════════════════════
// TEK CÜMLE
// ═══════════════════════════════════════════════════════════════════════════════
// `settings.json` SENKRONLANMAZ; beyaz listeli anahtarların PROJEKSİYONU
// senkronlanır. Sır dosyasına hiç dokunulmaz — bu yüzden tercih senkronu SEC-B2
// (vault göçü) beklemez.
//
//   settings.json ─┐                     ┌─ localStorage (renderer, IPC ile)
//                  ▼                     ▼
//              projectSettings()   publishRenderer()
//                  └──────────┬──────────┘
//                             ▼
//               prefs/app-prefs.json   (class='prefs', senkron motoru taşır)
//                             │
//                   mergeIncoming()  ← uzak bayt indi (anahtar-seviyesi LWW)
//                             ▼
//                applyToSettings() + rendererValues()
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 ÜÇ YAPISAL ENGEL (§5.5.3) — HEPSİ BU DOSYADAN GEÇER
// ─────────────────────────────────────────────────────────────────────────────
// 1. Beyaz liste: `settings.json`ın anahtarları HİÇ DOLAŞILMAZ. Kod yalnız
//    `prefsWhitelist.SETTINGS_KEYS` yollarını OKUR. Yarın oraya bir sır eklenirse
//    projeksiyona KENDİLİĞİNDEN giremez.
// 2. Çıktı kapısı: üretilen doküman yayınlanmadan önce anahtar ADI + değer
//    ŞEKLİ taranır (`prefsWhitelist.admit`). Beyaz liste zaten engelliyor; bu
//    ikinci kilit KOD HATASINA karşıdır.
// 3. Şema kilidi (DB): `class='prefs'` yalnız `rel_path='prefs/app-prefs.json'`
//    ile yazılabilir ve `settings` diye bir sınıf YOKTUR.
//
// ─────────────────────────────────────────────────────────────────────────────
// GERİ ALMA (DevOps kuralı — değişiklikten ÖNCE yazılır)
// ─────────────────────────────────────────────────────────────────────────────
// Bu özellik TEK ANAHTARLA geri alınır: `settings.json` içinde
// `prefsSyncEnabled: false`. O hâlde projektör hiç yazmaz, uygulayıcı hiç
// uygulamaz; senkron motoru dokümanı (varsa) taşımaya devam eder ama YEREL
// DURUMA DOKUNMAZ. Dosya da silinebilir: `rm ~/.crewpane/accounts/<k>/prefs/
// app-prefs.json` — bir sonraki tur onu yeniden ÜRETİR, ayar KAYBOLMAZ (kaynak
// settings.json'dır, doküman türevdir).
//
// DI: `fs`/`now`/`readSettings`/`writeSettings` enjekte edilir → `node --test`.

'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { atomicWriteFileSync } = require('../platform/atomicWrite.cjs');
const W = require('./prefsWhitelist.cjs');
const Doc = require('./prefsDoc.cjs');

/** `syncClasses.PREFS_REL_PATH` ile AYNI yol — parite testi ikisini bağlar. */
const PREFS_REL_PARTS = Object.freeze(['prefs', 'app-prefs.json']);

/**
 * @param {{dir:string, fs?:object, path?:object, now?:Function, deviceId?:string|null,
 *          readSettings:Function, writeSettings:Function, getEnabled?:Function,
 *          log?:Function, writeAtomic?:Function}} deps
 *   `dir` — HESAP KÖKÜ (`accountRoot`). `prefs/` onun altındadır; hesap kökünün
 *   KENDİSİ değil (orada `settings.json`, `auth/`, `vault.bin` yaşıyor).
 */
function createPrefsProjector(deps = {}) {
  const fs = deps.fs || nodeFs;
  const path = deps.path || nodePath;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const writeAtomic = typeof deps.writeAtomic === 'function' ? deps.writeAtomic : atomicWriteFileSync;
  const deviceId = deps.deviceId || null;
  const readSettings = deps.readSettings;
  const writeSettings = deps.writeSettings;
  // Geri alma anahtarı. Verilmezse AÇIK (özellik kendi kapısını taşır, çağıran
  // "bağlamayı unutunca sessizce kapalı" olmaz — SYNC-F1-6'nın plan kapısı dersi).
  const getEnabled = typeof deps.getEnabled === 'function' ? deps.getEnabled : () => true;

  if (typeof readSettings !== 'function') throw new Error('prefsProjector: readSettings zorunlu (DI)');
  if (typeof writeSettings !== 'function') throw new Error('prefsProjector: writeSettings zorunlu (DI)');
  if (!deps.dir || typeof deps.dir !== 'string') throw new Error('prefsProjector: dir zorunlu (hesap kökü)');

  const baseDir = deps.dir;
  /** Renderer'ın SON bildirdiği localStorage değerleri (bu süreç ömrü boyunca). */
  let rendererCache = Object.create(null);
  /** Son eşitleme olgusu — Ayarlar → Senkron satırı bunu gösterir (tahmin etmez). */
  let lastApplied = { at: null, keys: [], source: null };

  function docPath() {
    return path.join(baseDir, ...PREFS_REL_PARTS);
  }

  function nowIso() {
    return new Date(now()).toISOString();
  }

  /** Dokümanı OKU — yoksa/bozuksa BOŞ (asla fırlatmaz). */
  function readDoc() {
    let raw = null;
    try { raw = fs.readFileSync(docPath(), 'utf8'); } catch { return { doc: Doc.emptyDoc(), dropped: [], legacy: false, existed: false }; }
    const parsed = Doc.parse(raw);
    return { ...parsed, existed: true };
  }

  /** Dokümanı YAZ — deterministik bayt, atomik. */
  function writeDoc(doc) {
    const text = Doc.serialize(doc);
    if (Buffer.byteLength(text, 'utf8') > Doc.MAX_DOC_BYTES) {
      return { ok: false, reason: 'too-large', bytes: Buffer.byteLength(text, 'utf8') };
    }
    const file = docPath();
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* var */ }
    // EKO KAPISI: bayt aynıysa YAZMA. Dosyaya dokunmak izleyiciyi uyandırır ve
    // motoru boş bir tur koşturur; içerik aynıyken bu saf gürültüdür.
    try {
      if (fs.readFileSync(file, 'utf8') === text) return { ok: true, bytes: Buffer.byteLength(text, 'utf8'), unchanged: true, file };
    } catch { /* yok — yazılacak */ }
    try {
      writeAtomic(file, text, { fs, inPlaceFallback: true });
    } catch (err) {
      log(`[prefs] projeksiyon yazılamadı: ${(err && err.message) || err}`);
      return { ok: false, reason: (err && err.code) || 'write-failed', file };
    }
    return { ok: true, bytes: Buffer.byteLength(text, 'utf8'), file };
  }

  /**
   * `settings.json` → beyaz listeli DEĞERLER. Anahtarlar DOLAŞILMAZ, tek tek
   * OKUNUR (engel #1). Dosyada olmayan anahtar `undefined` döner ve düşer.
   */
  function settingsValues() {
    let s;
    try { s = readSettings() || {}; } catch { return {}; }
    const out = {};
    for (const key of W.SETTINGS_KEYS) {
      const v = W.getPath(s, key);
      if (v === undefined) continue;
      out[key] = v;
    }
    return out;
  }

  /** settings.json → doküman (damgalı). İDEMPOTENT: değişmeyen anahtar damga almaz. */
  function projectSettings() {
    if (!getEnabled()) return { ok: false, reason: 'prefs-sync-disabled' };
    const cur = readDoc().doc;
    const st = Doc.stamp(cur, settingsValues(), { at: nowIso(), dev: deviceId });
    if (st.dropped.length) log(`[prefs] projeksiyon dışı bırakıldı: ${st.dropped.join(', ')}`);
    if (!st.changed.length && readDoc().existed) return { ok: true, changed: [], dropped: st.dropped, unchanged: true };
    const w = writeDoc(st.doc);
    return { ok: w.ok, changed: st.changed, dropped: st.dropped, reason: w.reason, file: w.file };
  }

  /**
   * Renderer'ın bildirdiği `localStorage` değerleri → doküman.
   * @param {object} map `{projeksiyonAdı: değer}` — beyaz liste dışı olan düşer.
   */
  function publishRenderer(map) {
    if (!getEnabled()) return { ok: false, reason: 'prefs-sync-disabled' };
    const clean = {};
    for (const key of Object.keys(map || {})) {
      if (W.sourceOf(key) !== 'renderer') continue; // renderer YALNIZ kendi eksenini yazar
      clean[key] = map[key];
      rendererCache[key] = map[key];
    }
    const cur = readDoc().doc;
    const st = Doc.stamp(cur, clean, { at: nowIso(), dev: deviceId });
    if (!st.changed.length) return { ok: true, changed: [], dropped: st.dropped, unchanged: true };
    const w = writeDoc(st.doc);
    return { ok: w.ok, changed: st.changed, dropped: st.dropped, reason: w.reason };
  }

  /**
   * 🔴 MOTOR KANCASI — uzak bayt DİSKE YAZILMADAN ÖNCE birleştirilir.
   *
   * Bu kanca olmadan doküman-seviyesi LWW yerel anahtarları EZERDİ (§5.5.2).
   * Kanca ile: gelen doküman yereldekiyle anahtar bazında birleşir, sonuç diske
   * yazılır. Sonuç uzaktan FARKLIYSA defter uzak sha'yı taşımaya devam eder ⇒
   * bir sonraki push turu birleşimi yükler ⇒ iki cihaz aynı dokümanda buluşur.
   *
   * @returns {{buf:Buffer, changed:string[]}|null}  `null` = dokunma
   */
  function mergeIncoming(incomingBuf) {
    const local = readDoc().doc;
    const remote = Doc.parse(incomingBuf).doc;
    const m = Doc.merge(local, remote);
    const text = Doc.serialize(m.doc);
    return { buf: Buffer.from(text, 'utf8'), changed: m.changed };
  }

  /**
   * DOKÜMAN → `settings.json`. YALNIZ beyaz-listeli anahtarlar; bilinmeyen
   * anahtar zaten `parse()`te düşmüştür.
   *
   * Yazım YALNIZ gerçekten farklı olan anahtar varsa yapılır: aksi hâlde her
   * turda bir settings yazımı olur, o da bir projeksiyon turunu tetikler ve
   * döngü kapanmaz.
   */
  function applyToSettings() {
    if (!getEnabled()) return { ok: false, reason: 'prefs-sync-disabled', applied: [] };
    const doc = readDoc().doc;
    let cur;
    try { cur = readSettings() || {}; } catch { return { ok: false, reason: 'settings-unreadable', applied: [] }; }

    const patch = {};
    const applied = [];
    const seededTops = new Set();
    for (const key of W.SETTINGS_KEYS) {
      const entry = doc.keys[key];
      if (!entry) continue;
      const next = entry.v;
      const curVal = W.getPath(cur, key);
      if (JSON.stringify(Doc.sortValue(curVal)) === JSON.stringify(Doc.sortValue(next))) continue;
      const top = key.split('.')[0];
      // ⚠️ `theme`/`announcementsRead` gibi bazı üst anahtarlar `writeSettings`te
      // MERGE DEĞİL REPLACE semantiğindedir. Kısmi bir yama kardeş alanı silerdi;
      // bu yüzden dokunulan her üst anahtar MEVCUT değerinden TOHUMLANIR.
      if (!seededTops.has(top)) {
        seededTops.add(top);
        const cv = cur[top];
        if (cv && typeof cv === 'object' && !Array.isArray(cv)) patch[top] = JSON.parse(JSON.stringify(cv));
      }
      if (!W.setPath(patch, key, next)) continue;
      applied.push(key);
    }
    if (!applied.length) return { ok: true, applied: [], unchanged: true };
    try {
      writeSettings(patch);
    } catch (err) {
      log(`[prefs] ayar uygulanamadı: ${(err && err.message) || err}`);
      return { ok: false, reason: 'write-failed', applied: [] };
    }
    lastApplied = { at: nowIso(), keys: applied.slice(), source: 'sync' };
    log(`[prefs] uzak tercihler uygulandı (${applied.length}): ${applied.join(', ')}`);
    return { ok: true, applied };
  }

  /**
   * DOKÜMAN → renderer'ın uygulaması gereken `localStorage` değerleri.
   * Yalnız renderer eksenindeki anahtarlar; DEĞİŞENLER işaretlenir ki renderer
   * kendi yazdığı değeri geri yazıp döngü kurmasın.
   */
  function rendererValues() {
    const doc = readDoc().doc;
    const out = {};
    for (const e of W.RENDERER_KEYS) {
      const entry = doc.keys[e.key];
      if (!entry) continue;
      out[e.key] = { value: entry.v, storageKey: e.storageKey, subPath: e.subPath || null, at: entry.at, dev: entry.dev || null };
    }
    return out;
  }

  /** Ayarlar → Senkron satırının GERÇEĞİ (tahmin değil). */
  function status() {
    const r = readDoc();
    return {
      enabled: !!getEnabled(),
      file: docPath(),
      exists: r.existed,
      keyCount: Object.keys(r.doc.keys).length,
      legacy: r.legacy,
      lastApplied,
      deviceId,
    };
  }

  return {
    docPath,
    readDoc,
    writeDoc,
    settingsValues,
    projectSettings,
    publishRenderer,
    mergeIncoming,
    applyToSettings,
    rendererValues,
    status,
    /** test dikişi */
    _rendererCache: () => ({ ...rendererCache }),
  };
}

module.exports = { createPrefsProjector, PREFS_REL_PARTS };
