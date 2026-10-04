// SYNC-F1-2 (Wheeljack) — YEREL AĞAÇ TARAYICISI: sınıf ağaçları → yerel manifest.
//                         Tasarım: SYNC-F1-TASARIM.md §2.1 · §2.3 · §2.6 · §4.4
//
// ═══════════════════════════════════════════════════════════════════════════════
// ÇIKTI: `{class, relPath, sha256, size, mtimeMs, encoding}` — senkronun TEMELİ
// ═══════════════════════════════════════════════════════════════════════════════
// Bu manifest üç yerde aynı anda kullanılır:
//   · PUSH eko kapısı (§2.3/§2.4): "hesaplanan sha manifest'tekiyle aynı ⇒ HİÇBİR
//     ŞEY YAPMA". Kararın hash'e bağlı olması ŞART — iki cihazın saati farklıdır,
//     kopyalanan dosyanın mtime'ı tazedir, yani mtime YALAN SÖYLER.
//   · BOOTSTRAP (§2.6/3): `objectStore.has(sha)` ile birlikte "neyi indirmeyeceğiz".
//   · MUTABAKAT (§2.5): yerelde ELLE silinmiş dosyayı ancak tarama görür.
//
// ⚠️ `mtime` YALNIZ ÖNBELLEK ANAHTARIDIR, karar değil: (size, mtimeMs) değişmediyse
//    dosya YENİDEN HASH'LENMEZ. Ölçülen ağaç 1.420 dosya / 5,5 MB; her tarama
//    turunda tümünü hash'lemek gereksiz disk okumasıdır. Şüphe hâlinde (önbellek
//    yoksa/uyuşmuyorsa) DAİMA yeniden hash'lenir — önbellek hızdır, doğruluk değil.
//
// ═══════════════════════════════════════════════════════════════════════════════
// 🔴 SEMBOLİK BAĞ NÖBETİ — SYNC-F1-1 §14.2'nin BİRİNCİ borcu, burada kapanıyor
// ═══════════════════════════════════════════════════════════════════════════════
// `syncClasses.classify()` SAF ve fs'sizdir: metin olarak `.crewpane/memory/x.md`
// gördüğünde kayda uyduğu için KABUL eder. Ama o dosya `~/.crewpane/settings.json`e
// bir SEMBOLİK BAĞ olabilir — o zaman sınıf-tabanlı allowlist'in tek iddiası ("sır
// yapısal olarak giremez") kâğıt üstünde kalırdı: sırrın kendisi memory ağacının
// İÇİNDEN görünürdü.
//
// Kapı burada, ÜÇ ADIMDA (fail-closed):
//   1) Kökler taramadan ÖNCE bir kez `realpath`lenir (mac'te /var → /private/var
//      gibi meşru dolaylamalar tek yerde çözülsün, her dosyada değil).
//   2) Sembolik bağ olan DİZİNLERE hiç girilmez — bir ağaç dışı dizini içeri
//      bağlamak, tüm alt ağacı kapsama sokmanın en kolay yoludur.
//   3) Her aday dosya `realpath`lenir ve sonuç TEKRAR `classify()`den geçirilir.
//      Sınıf/rel_path değişirse ya da `null` dönerse dosya ATILIR ve gerekçe
//      GÖRÜNÜR (`skipped[]` + log) — sessiz atma yok.
//
// Saf değil ama TAM DI: `fs`/`path`/`crypto`/`platform` enjekte edilebilir →
// `node --test` gerçek disk ve Electron olmadan koşar.

'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const nodeCrypto = require('node:crypto');
const { atomicWriteFileSync } = require('../platform/atomicWrite.cjs');
const C = require('./syncClasses.cjs');
const P = require('./syncPaths.cjs');

/** Tek dosya tavanı — DB `size_bytes` CHECK'iyle AYNI (1 MiB). */
const MAX_FILE_BYTES = 1048576;

/** Dizin derinliği tavanı — ölçülen ağaç 4 seviye; 24 bir kaçak nöbeti, sınır değil. */
const MAX_DEPTH = 24;

/** Tarama başına dosya tavanı — kill-switch (§6): yanlış bir kök tüm diski gezmesin. */
const MAX_FILES = 20000;

/** Önbellek dosyasının biçim sürümü — alan eklenirse eskisi sessizce YOK SAYILIR. */
const CACHE_VERSION = 1;

/** Önbellek/manifest anahtarı: sınıf + rel_path (aynı rel_path iki sınıfta olabilir). */
function keyOf(classId, relPath) {
  return `${classId}\u0000${relPath}`;
}

/**
 * Gövde UTF-8 mi? DB `body` kolonu `text`tir: NUL taşıyamaz, geçersiz UTF-8 kabul
 * etmez. İkisinden biri varsa satır `body_encoding='base64'` ile gider (§4.4).
 * Ölçüm: bugünkü 1.420 dosyanın tamamı geçerli UTF-8 — guard bedava sigorta.
 */
function encodingOf(buf) {
  if (buf.includes(0)) return 'base64';
  // TAM TUR KONTROLÜ: geçersiz dizi çözülürken U+FFFD'ye döner ve yeniden
  // kodlandığında ORİJİNAL baytları vermez. "U+FFFD var mı" diye bakmak, o
  // karakteri MEŞRU olarak içeren bir dosyayı gereksiz yere base64'e düşürürdü.
  return Buffer.from(buf.toString('utf8'), 'utf8').equals(buf) ? 'utf8' : 'base64';
}

/**
 * @param {{roots:{workspaceRoot?:string, accountRoot?:string}, fs?:object, path?:object,
 *          crypto?:object, platform?:string, log?:Function, maxFileBytes?:number,
 *          maxDepth?:number, maxFiles?:number}} deps
 */
function createScanner(deps = {}) {
  const fs = deps.fs || nodeFs;
  const path = deps.path || nodePath;
  const crypto = deps.crypto || nodeCrypto;
  const platform = deps.platform || process.platform;
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const maxFileBytes = Number.isFinite(deps.maxFileBytes) ? deps.maxFileBytes : MAX_FILE_BYTES;
  const maxDepth = Number.isFinite(deps.maxDepth) ? deps.maxDepth : MAX_DEPTH;
  const maxFiles = Number.isFinite(deps.maxFiles) ? deps.maxFiles : MAX_FILES;
  const rawRoots = deps.roots || {};

  /**
   * ADIM 1 — kökleri BİR KEZ realpath'le.
   *
   * Neden her dosyada değil: mac'te `os.tmpdir()` → `/var/…` → `/private/var/…`
   * meşru bir dolaylamadır. Dosya bazında `realpath(abs) !== abs` kontrolü bunu
   * SEMBOLİK KAÇAK sanıp bütün ağacı reddederdi (yanlış-pozitif). Kökü bir kez
   * çözünce, kök ALTINDAKİ her sapma gerçek bir kaçaktır.
   */
  function resolvedRoots() {
    const out = {};
    for (const kind of ['workspaceRoot', 'accountRoot']) {
      const v = rawRoots[kind];
      if (typeof v !== 'string' || !v.trim()) continue;
      try {
        out[kind] = fs.realpathSync(v);
      } catch {
        out[kind] = v; // kök yoksa: `classRoots` zaten boş dizi döner, tarama atlar
      }
    }
    return out;
  }

  function sha256Of(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
  }

  /**
   * Ağacı tara.
   *
   * @param {{cache?:object, classes?:string[]}} [opts]
   *   `cache` — önceki turun manifesti (`{key: {sha256,size,mtimeMs,encoding}}`).
   * @returns {{files:Array, byKey:Object, skipped:Array, warnings:Array, stats:object}}
   */
  function scan(opts = {}) {
    const roots = resolvedRoots();
    const cache = (opts.cache && typeof opts.cache === 'object') ? opts.cache : {};
    const wanted = Array.isArray(opts.classes) && opts.classes.length
      ? opts.classes.filter((id) => C.fileBackedClasses().includes(id))
      : C.fileBackedClasses();

    const files = [];
    const skipped = [];
    const warnings = [];
    const stats = { dirs: 0, candidates: 0, hashed: 0, reused: 0, bytes: 0, truncated: false };
    const seenDirs = new Set();

    const skip = (abs, reason, detail) => {
      skipped.push(detail ? { abs, reason, detail } : { abs, reason });
    };

    function walk(dir, depth) {
      if (depth > maxDepth) { skip(dir, 'too-deep'); return; }
      if (files.length >= maxFiles) { stats.truncated = true; return; }
      // Dizin döngüsü nöbeti: sembolik dizinlere girmiyoruz, ama sabit bağlar ve
      // yeniden bağlanan kökler için ucuz bir sigorta.
      let realDir;
      try {
        realDir = fs.realpathSync(dir);
      } catch (err) {
        // Var olmayan alt ağaç NORMALdir (hiç skill yazılmamış workspace) — gürültü
        // üretmez; okunamayan bir dizin ise gerçek bir arızadır ve GÖRÜNÜR olmalı.
        if (!err || err.code !== 'ENOENT') skip(dir, 'unreadable-dir', String(err && err.message));
        return;
      }
      if (seenDirs.has(realDir)) return;
      seenDirs.add(realDir);

      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        // Dizin YOK olması normaldir (ör. hiç skill yazılmamış workspace).
        if (!err || err.code !== 'ENOENT') skip(dir, 'readdir-failed', String(err && err.message));
        return;
      }
      stats.dirs += 1;

      for (const ent of entries) {
        if (files.length >= maxFiles) { stats.truncated = true; return; }
        const name = ent.name;
        // Nokta-dizin/dosya ve atomik-yazım artıkları: `classify()` de eler, ama
        // `.git/` içine GİRMEMEK ölçülebilir bir tasarruftur.
        if (name.startsWith('.') || name.startsWith('.tmp-') || name.startsWith('~$')) continue;
        const abs = path.join(dir, name);

        if (ent.isSymbolicLink()) {
          let st;
          try { st = fs.statSync(abs); } catch { skip(abs, 'broken-symlink'); continue; }
          if (st.isDirectory()) {
            // ADIM 2 — bağlı dizine GİRME. İçerideki her şey ağaç dışıdır ve
            // dosya-bazlı nöbeti ölçek olarak aşmanın en kolay yolu budur.
            skip(abs, 'symlink-dir');
            continue;
          }
          if (!st.isFile()) { skip(abs, 'not-a-file'); continue; }
          visitFile(abs);
          continue;
        }
        if (ent.isDirectory()) { walk(abs, depth + 1); continue; }
        if (!ent.isFile()) { skip(abs, 'not-a-file'); continue; }
        visitFile(abs);
      }
    }

    function visitFile(abs) {
      const first = P.classifyForSync(abs, roots, { platform });
      if (!first.ok) {
        // "Kayıtta yok" NORMALdir (MEMORY.md, .json çöp, uzantı dışı) — sessiz atılır,
        // yalnız sayılır. Doğrulama düşüşü ANORMALdir ve görünür olmalı.
        if (first.reason !== 'not-in-registry') skip(abs, first.reason, first.relPath);
        return;
      }
      stats.candidates += 1;

      // ADIM 3 — SEMBOLİK BAĞ NÖBETİ (F1-1 §14.2 borç 1).
      let real;
      try { real = fs.realpathSync(abs); } catch { skip(abs, 'unreadable'); return; }
      if (real !== abs) {
        const second = P.classifyForSync(real, roots, { platform });
        if (!second.ok || second.class !== first.class || second.relPath !== first.relPath) {
          log(`[sync-scan] ⚠ sembolik kaçak: ${first.relPath} → ${real} (atlandı)`);
          skip(abs, 'symlink-escape', real);
          return;
        }
      }

      let st;
      try { st = fs.statSync(abs); } catch { skip(abs, 'unreadable'); return; }
      if (!st.isFile()) { skip(abs, 'not-a-file'); return; }
      if (st.size > maxFileBytes) {
        // DB CHECK'i (size_bytes ≤ 1 MiB) zaten reddederdi; burada durdurmak
        // kullanıcıya opak bir 400 yerine gerekçeli bir satır verir.
        skip(abs, 'too-large', `${st.size} bayt`);
        return;
      }

      // Windows'ta YARATILAMAYACAK ad: burada ELEMEYİZ (mac'te meşru dosya,
      // susturmak sessiz kayıp olurdu) — uyarı olarak taşınır; kapı, satırı
      // uygulayan Windows cihazında kapanır (§4.3, syncPaths.planPlatformGate).
      const unsafe = P.windowsUnsafe(first.relPath);
      if (unsafe) warnings.push({ relPath: first.relPath, kind: 'windows-unsafe-name', reason: unsafe.reason });

      const key = keyOf(first.class, first.relPath);
      const prev = cache[key];
      let sha256; let encoding;
      if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs
          && typeof prev.sha256 === 'string' && typeof prev.encoding === 'string') {
        sha256 = prev.sha256;
        encoding = prev.encoding;
        stats.reused += 1;
      } else {
        let buf;
        try { buf = fs.readFileSync(abs); } catch { skip(abs, 'unreadable'); return; }
        sha256 = sha256Of(buf);       // HAM BAYTLAR — CRLF/LF farkı hash'i değiştirir (§4.4)
        encoding = encodingOf(buf);
        stats.hashed += 1;
      }
      stats.bytes += st.size;

      files.push({
        class: first.class,
        scope: first.scope,
        subtree: first.subtree,
        relPath: first.relPath,
        abs,
        sha256,
        size: st.size,
        mtimeMs: st.mtimeMs,
        encoding,
      });
    }

    for (const classId of wanted) {
      for (const { dir } of C.classRoots(classId, roots, { platform })) walk(dir, 0);
    }

    files.sort((a, b) => (a.class === b.class
      ? (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0)
      : (a.class < b.class ? -1 : 1)));

    const byKey = Object.create(null);
    for (const f of files) {
      byKey[keyOf(f.class, f.relPath)] = {
        sha256: f.sha256, size: f.size, mtimeMs: f.mtimeMs, encoding: f.encoding,
      };
    }
    if (stats.truncated) log(`[sync-scan] ⚠ dosya tavanı (${maxFiles}) aşıldı — tarama KISMİ`);
    return { files, byKey, skipped, warnings, stats, roots };
  }

  /**
   * Önbelleği diskten oku. Bozuk/eski sürüm ⇒ BOŞ önbellek (hata değil): bedeli
   * bir turluk yeniden hash'lemedir, alternatifi ise yanlış sha ile senkronlamaktır.
   */
  function readCacheFile(file) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!raw || raw.version !== CACHE_VERSION || !raw.entries || typeof raw.entries !== 'object') return {};
      return raw.entries;
    } catch {
      return {};
    }
  }

  /** Önbelleği ATOMİK yaz (yarım JSON = bir sonraki turda boş önbellek, sessiz değil). */
  function writeCacheFile(file, entries, writeAtomic) {
    const payload = JSON.stringify({ version: CACHE_VERSION, entries }, null, 0);
    const write = typeof writeAtomic === 'function' ? writeAtomic : atomicWriteFileSync;
    write(file, payload, { fs });
    return { file, bytes: Buffer.byteLength(payload) };
  }

  return { scan, readCacheFile, writeCacheFile };
}

module.exports = {
  createScanner,
  keyOf,
  encodingOf,
  MAX_FILE_BYTES,
  MAX_DEPTH,
  MAX_FILES,
  CACHE_VERSION,
};
