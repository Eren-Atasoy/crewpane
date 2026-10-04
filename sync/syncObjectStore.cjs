// SYNC-F1-2 (Wheeljack) — İÇERİK-ADRESLİ YEREL BAYT DEPOSU.
//                         Tasarım: SYNC-F1-TASARIM.md §2.1 · §2.5 · §2.6 · §3.2
//
// ═══════════════════════════════════════════════════════════════════════════════
// NE İŞE YARAR — üç ayrı yerde AYNI depo
// ═══════════════════════════════════════════════════════════════════════════════
//   1) BOOTSTRAP (§2.6/3): yeni cihaz manifesti çeker; `has(sha)` diyebildiği her
//      bayt HİÇ İNDİRİLMEZ. FAZ 0'da elle kopyalanmış bir ağacın üstüne kurulan
//      cihazda kazanç doğrudan ölçülür (5,5 MB → 0).
//   2) ÇAKIŞMA (§3.2): LWW'de KAYBEDEN bayt üzerine yazılmadan ÖNCE buraya konur.
//      Defterdeki `loser_body` 64 KB'la sınırlı; 64 KB'ı aşan kaybeden içeriğin
//      TEK tam kopyası burasıdır. TTL olsaydı kurtarma penceresi sessizce kapanırdı.
//   3) TOMBSTONE (§2.5): uzak silme yerelde dosyayı siler ama BAYTI BIRAKIR —
//      "yanlışlıkla sildim" geri alınabilir kalır.
//
// ═══════════════════════════════════════════════════════════════════════════════
// ⛔ TTL YOK — WIN-IMG-01 DERSİ (attachmentStore ile AYNI duruş)
// ═══════════════════════════════════════════════════════════════════════════════
// Süreli silme dosyayı kullanıcının altından çeker ve bunu SESSİZCE yapar. Bu
// depoda baytlar yalnız AÇIK bir eylemle gider: `remove(sha)` ya da `gc({keep})`.
// `gc` çağıranın verdiği KORUMA KÜMESİNİ ister; "kimse referans vermiyorsa sil"
// diye bir sezgi yoktur — referans bilgisi bu modülde YOKTUR ve uydurulmaz.
//
// ═══════════════════════════════════════════════════════════════════════════════
// KİMLİK = İÇERİK — ve bu bir İDDİA değil, DOĞRULANIR
// ═══════════════════════════════════════════════════════════════════════════════
// `put` yazdıktan sonra, `get` okuduktan sonra hash YENİDEN hesaplanır (dosyalar
// ≤1 MB — DB `size_bytes` CHECK'i; maliyet mikrosaniye). Sessizce bozulmuş bir
// nesne, adı doğru olduğu için "doğru bayt" sanılır ve senkron onu KARŞI CİHAZA
// TAŞIRDI. Doğrulama bu zinciri kırar: bozuk nesne `null` döner, çağıran yeniden
// indirir.
//
// Saf + DI: `fs`/`path`/`crypto`/`log` enjekte edilebilir (attachmentStore kalıbı).

'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const nodeCrypto = require('node:crypto');
const { atomicWriteFileSync } = require('../platform/atomicWrite.cjs');

/** Hesap kökü altındaki depo dizini. */
const STORE_DIR = 'sync-objects';

/** Tek nesne tavanı — DB `size_bytes` CHECK'iyle AYNI sayı (1 MiB). */
const MAX_BYTES = 1048576;

const RE_SHA256 = /^[0-9a-f]{64}$/;

function isSha(sha) {
  return typeof sha === 'string' && RE_SHA256.test(sha);
}

/**
 * @param {{root:string, fs?:object, path?:object, crypto?:object, log?:Function,
 *          maxBytes?:number, atomicWrite?:Function}} deps
 *   `root` = HESAP KÖKÜ (`<accountRoot>`); depo onun altında `sync-objects/`.
 */
function createObjectStore(deps = {}) {
  const fs = deps.fs || nodeFs;
  const path = deps.path || nodePath;
  const crypto = deps.crypto || nodeCrypto;
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const maxBytes = Number.isFinite(deps.maxBytes) ? deps.maxBytes : MAX_BYTES;
  const writeAtomic = typeof deps.atomicWrite === 'function' ? deps.atomicWrite : atomicWriteFileSync;

  if (!deps.root || typeof deps.root !== 'string') {
    throw new Error('syncObjectStore: `root` (hesap kökü) zorunlu');
  }
  const storeRoot = path.join(deps.root, STORE_DIR);

  function sha256Of(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
  }

  /** Çözülen yol depo kökünün ALTINDA mı? (traversal nöbeti — tek boğaz.) */
  function withinStore(abs) {
    const base = path.resolve(storeRoot);
    const p = path.resolve(abs);
    return p === base || p.startsWith(base + path.sep);
  }

  /**
   * `sha` → mutlak yol. İki seviyeli yayma (`<sha[0:2]>/<sha>`): tek dizinde 1.420+
   * girdi Windows'ta dizin listelemeyi yavaşlatır; 256 kova bunu düzler.
   * Geçersiz sha için `null` — depo yolu ÜRETİLEMEZ.
   */
  function pathFor(sha) {
    if (!isSha(sha)) return null;
    const abs = path.join(storeRoot, sha.slice(0, 2), sha);
    return withinStore(abs) ? abs : null;
  }

  /** Bu bayt kümesi zaten depoda mı? (bootstrap'ın "indirme" kararı.) */
  function has(sha) {
    const abs = pathFor(sha);
    if (!abs) return false;
    try {
      return fs.statSync(abs).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Baytları depoya al.
   * @param {Buffer} data
   * @param {{expectSha?:string}} [opts] beklenen hash — uzaktan gelen satırın
   *        `sha256`ı. Uyuşmazsa YAZILMAZ: bozuk indirme diske girmez.
   * @returns {{ok:true, sha256:string, bytes:number, reused:boolean, path:string}|{ok:false, reason:string, detail?:string}}
   */
  function put(data, opts = {}) {
    if (!Buffer.isBuffer(data)) return { ok: false, reason: 'bad-data' };
    if (data.length > maxBytes) {
      return { ok: false, reason: 'too-large', detail: `${data.length} bayt (tavan ${maxBytes})` };
    }
    const sha = sha256Of(data);
    if (opts.expectSha && opts.expectSha !== sha) {
      // Uzak satırın beyanı ile gelen baytlar AYRIŞTI. Sessizce yazmak, yanlış
      // içeriği doğru adla mühürlemek olurdu.
      return { ok: false, reason: 'sha-mismatch', detail: `beklenen ${opts.expectSha}, gelen ${sha}` };
    }
    const abs = pathFor(sha);
    if (!abs) return { ok: false, reason: 'bad-sha' };

    if (has(sha)) return { ok: true, sha256: sha, bytes: data.length, reused: true, path: abs };

    try {
      // ATOMİK: yarım yazılmış bir nesne, adı geçerli olduğu için `has()`e
      // "var" dedirtir ve bir daha ASLA yeniden indirilmezdi (kalıcı bozulma).
      writeAtomic(abs, data, { fs });
    } catch (err) {
      return { ok: false, reason: 'write-failed', detail: String((err && err.message) || err) };
    }
    log(`[sync-objects] yazıldı ${sha.slice(0, 12)}… (${data.length} bayt)`);
    return { ok: true, sha256: sha, bytes: data.length, reused: false, path: abs };
  }

  /**
   * Baytları oku. Bozuk (hash tutmayan) nesne `null` döner ve gerekçe log'a düşer —
   * çağıran onu "yok" sayıp yeniden indirir, ki doğru davranış budur.
   * @param {string} sha
   * @param {{verify?:boolean}} [opts] `verify:false` yalnız ölçüm/GC yolları için.
   */
  function get(sha, opts = {}) {
    const abs = pathFor(sha);
    if (!abs) return null;
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      return null;
    }
    if (opts.verify === false) return buf;
    const actual = sha256Of(buf);
    if (actual !== sha) {
      log(`[sync-objects] ⚠ BOZUK nesne ${sha.slice(0, 12)}… (diskteki hash ${actual.slice(0, 12)}…) — yok sayıldı`);
      return null;
    }
    return buf;
  }

  /** Tek nesneyi diskten sil — YALNIZ açık eylem (TTL yok). */
  function remove(sha) {
    const abs = pathFor(sha);
    if (!abs) return { ok: false, reason: 'bad-sha' };
    try {
      fs.unlinkSync(abs);
      return { ok: true, removed: true };
    } catch (err) {
      if (err && err.code === 'ENOENT') return { ok: true, removed: false };
      return { ok: false, reason: 'unlink-failed', detail: String(err && err.message) };
    }
  }

  /** Depodaki tüm sha'lar (kova dizinlerini gezerek). Ad biçimi tutmayan dosya ATLANIR. */
  function list() {
    const out = [];
    let buckets;
    try {
      buckets = fs.readdirSync(storeRoot, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const b of buckets) {
      if (!b.isDirectory() || !/^[0-9a-f]{2}$/.test(b.name)) continue;
      let entries;
      try {
        entries = fs.readdirSync(path.join(storeRoot, b.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isFile() || !isSha(e.name) || !e.name.startsWith(b.name)) continue;
        out.push(e.name);
      }
    }
    return out.sort();
  }

  /**
   * AÇIK ÇÖP TOPLAMA — `keep` dışındaki her nesneyi siler.
   *
   * ⚠️ `keep` ZORUNLUDUR ve boş küme VERİLEMEZ: "koruma listesi boş" ile "koruma
   * listesini hesaplamayı unuttum" ayırt edilemez ve ikincisi TÜM depoyu siler.
   * Gerçekten her şeyi silmek isteyen `{ force:true }` demek zorundadır.
   */
  function gc(opts = {}) {
    const keep = opts.keep instanceof Set ? opts.keep : new Set(Array.isArray(opts.keep) ? opts.keep : []);
    if (keep.size === 0 && opts.force !== true) {
      return { ok: false, reason: 'empty-keep-set' };
    }
    const all = list();
    const removed = [];
    let freed = 0;
    for (const sha of all) {
      if (keep.has(sha)) continue;
      const abs = pathFor(sha);
      let size = 0;
      try { size = fs.statSync(abs).size; } catch { /* ölçemedik: sayı 0 kalır */ }
      const r = remove(sha);
      if (r.ok && r.removed) { removed.push(sha); freed += size; }
    }
    log(`[sync-objects] gc: ${removed.length}/${all.length} nesne silindi (${freed} bayt)`);
    return { ok: true, scanned: all.length, removed: removed.length, freedBytes: freed, removedShas: removed };
  }

  /** Depo ölçüsü — kill-switch/teşhis için (§6). */
  function stats() {
    const all = list();
    let bytes = 0;
    for (const sha of all) {
      try { bytes += fs.statSync(pathFor(sha)).size; } catch { /* yok sayılır */ }
    }
    return { count: all.length, bytes, root: storeRoot };
  }

  return { root: storeRoot, pathFor, has, put, get, remove, list, gc, stats, withinStore };
}

module.exports = { createObjectStore, STORE_DIR, MAX_BYTES, isSha };
