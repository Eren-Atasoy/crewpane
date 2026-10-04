// SYNC-F1-2 (Wheeljack) — YOL SÖZLEŞMESİ: `rel_path` doğrulaması, TERS YÖN ve
//                         PLATFORM KAPISI. Tasarım: SYNC-F1-TASARIM.md §2.1 · §4.1 · §4.3
//
// ═══════════════════════════════════════════════════════════════════════════════
// SINIF KAYDI TEK KAYNAK KALIR — burada İKİNCİ BİR YOL LİSTESİ YOKTUR
// ═══════════════════════════════════════════════════════════════════════════════
// SYNC-F1-1 §14.2'nin ikinci borcu aynen şuydu: "syncPaths ters yönü + Windows
// ayrılmış adlarını + lower(rel_path) çakışmasını taşır; syncClasses kaydı TEK
// kaynak kalır (ikinci bir yol listesi doğmaz)". Bu yüzden bu modül hangi dizinin
// hangi sınıfa ait olduğunu BİLMEZ: `syncClasses.classRoots()`e sorar. Kayıt
// değişirse (yeni alt ağaç, yeni uzantı) burası kendiliğinden takip eder.
//
// TERS YÖNÜN NÖBETİ — round-trip: `(class, rel_path) → abs` ürettikten sonra o
// mutlak yol TEKRAR `classify()`den geçirilir ve AYNI `(class, rel_path)` çıkmak
// zorundadır. Böylece "uzak satır bize dosya yazdırıyor" yolunda kendi kayıt
// kapımızı ikinci kez zorlarız: bulutta bir şekilde `../` ya da `skills/x.exe`
// içeren bir satır belirse bile diske yazılacak yol ÜRETİLEMEZ.
//
// ⚠️ SAF MODÜL — fs YOK. Bir yolun gerçekte SEMBOLİK BAĞ olup olmadığı buradan
//    görünmez; o `syncScanner`ın (realpath + yeniden classify) işidir.

'use strict';

const nodePath = require('node:path');
const C = require('./syncClasses.cjs');

/** DB CHECK'iyle AYNI tavan (`length(rel_path) BETWEEN 1 AND 400`). */
const REL_PATH_MAX = C.REL_PATH_MAX;

// ─────────────────────────────────────────────────────────────────────────────
// DB CHECK AYNASI — bu dört regex migration'daki `rel_path` CHECK'inin BİREBİR
// karşılığıdır (`20260821090000_syncf1_crewpane_files.sql`). Parite testi iki
// tarafı bağlar: burası gevşerse istemci DB'nin reddedeceği bir satır üretir ve
// kullanıcı OPAK bir 400 görür (§12.9'da ölçülen "istemci ↔ DB sapması" sınıfı).
// ─────────────────────────────────────────────────────────────────────────────
const RE_LEADING_SEP = /^[/\\]/;              // mutlak yol / UNC yok
const RE_DRIVE_LETTER = /^[A-Za-z]:/;         // 'C:' sürücü harfi yok
const RE_TRAVERSAL = /(^|\/)\.\.(\/|$)/;      // `v1..v2.md` MEŞRUDUR — yalnız gezme biçimi yasak
const RE_MEMORY_INDEX = /(^|\/)MEMORY\.md$/;  // indeks senkronlanmaz, TÜRETİLİR (§3)

/**
 * Windows'un YARATAMAYACAĞI adlar (§4.3). Uzantıdan ÖNCEKİ gövde de sayılır:
 * `CON.md` Windows'ta ayrılmıştır, `CONFIG.md` değildir.
 */
const WIN_RESERVED = Object.freeze([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/** Windows dosya adında YASAK karakterler (`:` dahil — mac'te meşrudur). */
const RE_WIN_ILLEGAL_CHAR = /[<>:"|?*]/;
const RE_CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

/**
 * Büyük/küçük harf DUYARSIZ dosya sistemleri.
 *
 * 🔴 TASARIMDAN AYRILAN NOKTA (§4.3 yalnız "Windows" diyor): macOS'un VARSAYILAN
 * APFS birimi de duyarsızdır — `Foo.md` ve `foo.md` bulutta iki satır, mac'te TEK
 * dosyadır ve biri diğerini SESSİZCE ezer. Kapıyı yalnız win32'ye bağlamak,
 * ölçülen zararı bugünkü geliştirme cihazında AÇIK bırakırdı. Duyarlı bir birimde
 * (case-sensitive APFS/HFSX) bedel yalnız iki dosyanın BEKLETİLMESİdir — sessiz
 * kayıp değil, görünür bir çakışma satırı. Takas bilinçli: doğruluk > kolaylık.
 */
function isCaseInsensitivePlatform(platform) {
  return platform === 'win32' || platform === 'darwin';
}

function pathFor(platform) {
  return platform === 'win32' ? nodePath.win32 : nodePath.posix;
}

/** `rel_path`i sözleşmeye çevirir: NFC + daima `/`. Doğrulamaz — sadece normalize eder. */
function normalizeRelPath(relPath) {
  if (typeof relPath !== 'string') return '';
  return relPath.normalize('NFC').replace(/\\/g, '/');
}

/**
 * `rel_path` DB CHECK'ini GEÇER Mİ? — istemci tarafındaki aynası.
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
function validateRelPath(relPath) {
  if (typeof relPath !== 'string' || !relPath) return { ok: false, reason: 'empty' };
  if (relPath.includes('\0')) return { ok: false, reason: 'nul-byte' };
  // NFC KARŞILAŞTIRMASI (§4.2): NFD gelen bir ad DB'de ikinci bir satır açar.
  if (relPath.normalize('NFC') !== relPath) return { ok: false, reason: 'not-nfc' };
  if (relPath.length > REL_PATH_MAX) return { ok: false, reason: 'too-long' };
  if (RE_LEADING_SEP.test(relPath)) return { ok: false, reason: 'absolute' };
  if (RE_DRIVE_LETTER.test(relPath)) return { ok: false, reason: 'drive-letter' };
  if (relPath.includes('\\')) return { ok: false, reason: 'backslash' };
  if (RE_TRAVERSAL.test(relPath)) return { ok: false, reason: 'traversal' };
  if (RE_MEMORY_INDEX.test(relPath)) return { ok: false, reason: 'memory-index' };
  if (relPath.endsWith('/') || relPath.includes('//')) return { ok: false, reason: 'bad-separator' };
  return { ok: true };
}

/**
 * Bu `rel_path` Windows'ta DOSYA OLARAK YARATILABİLİR Mİ?
 *
 * Bilerek `validateRelPath`ten AYRI: mac'te `CON.md` ya da `x .md` MEŞRU bir
 * dosyadır ve YÜKLENİR (kaynağı susturmak sessiz kayıptır). Kapı, satırı diske
 * UYGULAYAN Windows cihazında kapanır ve `kind='platform-collision'` yazılır —
 * kullanıcı neyin neden gelmediğini görür.
 *
 * 🔎 Tasarım §4.3 örnek olarak `x .md` veriyor; BU AD WINDOWS'TA MEŞRUDUR ve
 * burada bekletilmez. Win32 kuralı adın SONUNDAKİ nokta/boşluğu kırpar (`x.md ` →
 * `x.md`, yani var olan bir dosyayla ÇAKIŞIR); ortadaki boşluk kırpılmaz. Kapıyı
 * gerçek kurala göre kurmak, yanlış-pozitif bekletmeleri (kullanıcının hiç
 * gelmeyen dosyası) önler.
 *
 * @returns {null|{reason:string, segment:string}}
 */
function windowsUnsafe(relPath) {
  if (typeof relPath !== 'string' || !relPath) return null;
  for (const seg of relPath.split('/')) {
    if (!seg) continue;
    if (RE_CONTROL_CHAR.test(seg)) return { reason: 'control-char', segment: seg };
    if (RE_WIN_ILLEGAL_CHAR.test(seg)) return { reason: 'illegal-char', segment: seg };
    if (seg.endsWith('.') || seg.endsWith(' ')) return { reason: 'trailing-dot-space', segment: seg };
    const stem = seg.includes('.') ? seg.slice(0, seg.indexOf('.')) : seg;
    if (WIN_RESERVED.includes(stem.toUpperCase())) return { reason: 'reserved-name', segment: seg };
  }
  return null;
}

/**
 * MUTLAK YOL → `{ok:true, class, relPath, …}` · uymuyorsa GEREKÇELİ ret.
 *
 * `classify()`in üstüne yalnız İKİ şey ekler: DB aynası doğrulaması ve gerekçe.
 * `classify()`in `null`ü "kayıtta yok" demektir ve bu SESSİZ atılacak normal
 * durumdur (MEMORY.md, nokta-dosya, `.tmp-`); doğrulamanın düşmesi ise ANORMALdir
 * ve çağıran ikisini ayırmak zorundadır.
 */
function classifyForSync(absPath, roots = {}, opts = {}) {
  const hit = C.classify(absPath, roots, opts);
  if (!hit) return { ok: false, reason: 'not-in-registry' };
  const v = validateRelPath(hit.relPath);
  if (!v.ok) return { ok: false, reason: `invalid-rel-path:${v.reason}`, relPath: hit.relPath };
  return { ok: true, class: hit.class, relPath: hit.relPath, scope: hit.scope, subtree: hit.subtree };
}

/** Çözülen yol kökün ALTINDA mı? (attachmentStore `withinStore` deseni.) */
function withinRoot(abs, rootDir, platform) {
  const p = pathFor(platform || process.platform);
  const base = p.normalize(rootDir);
  const target = p.normalize(abs);
  return target === base || target.startsWith(base.endsWith(p.sep) ? base : base + p.sep);
}

/**
 * TERS YÖN — `(class, rel_path)` → MUTLAK YOL. Uzak satırı diske yazmadan önceki
 * TEK yol üreticisi.
 *
 * @returns {{ok:true, abs:string, subtree:string}|{ok:false, reason:string}}
 */
function resolveRelPath(classId, relPath, roots = {}, opts = {}) {
  const spec = C.classById(classId);
  if (!spec) return { ok: false, reason: 'unknown-class' };
  // SYNC-F1-7 — MÜHÜRLÜ YOL: projeksiyon sınıfının (bugün `prefs`) tek meşru
  // `rel_path`i vardır. Başka bir ad için yol ÜRETİLMEZ; `classify()` de aynı
  // hükmü verir (round-trip nöbeti aşağıda zaten ikinci kez sınar), ama gerekçe
  // burada ADIYLA döner ki log "unknown-subtree" gibi yanıltıcı olmasın.
  if (spec.fixedRelPath && String(relPath || '').normalize('NFC') !== spec.fixedRelPath) {
    return { ok: false, reason: 'fixed-rel-path-mismatch' };
  }

  // ⚠️ Burada `normalizeRelPath` KULLANILMAZ (ters bölüyü `/`ye çevirmez).
  // Gelen satır DB sözleşmesini ZATEN sağlamak zorundadır; `memory\x.md` gibi bir
  // değer o sözleşmeyi ihlal eder, yani satır BAYAT ya da ŞÜPHELİdir. Sessizce
  // düzeltmek onu meşrulaştırırdı (attachmentStore `resolveRel` duruşu: "DB'de
  // mutlak yol olmamalı, olan bir satır bayattır"). NFC ise ihlal değil TEMSİLdir —
  // yalnız o normalize edilir.
  const norm = typeof relPath === 'string' ? relPath.normalize('NFC') : '';
  const v = validateRelPath(norm);
  if (!v.ok) return { ok: false, reason: `invalid-rel-path:${v.reason}` };

  const platform = opts.platform || process.platform;
  const p = pathFor(platform);
  const segments = norm.split('/');
  const prefix = segments[0];
  const rest = segments.slice(1);
  if (rest.length === 0) return { ok: false, reason: 'no-leaf' };

  const subtrees = C.classRoots(classId, roots, { platform });
  if (subtrees.length === 0) return { ok: false, reason: 'root-unavailable' };
  const sub = subtrees.find((r) => r.prefix === prefix);
  if (!sub) return { ok: false, reason: 'unknown-subtree' };

  const ext = p.extname(rest[rest.length - 1]).toLowerCase();
  if (!spec.extensions.includes(ext)) return { ok: false, reason: 'extension-not-allowed' };

  const abs = p.join(sub.dir, ...rest);
  if (!withinRoot(abs, sub.dir, platform)) return { ok: false, reason: 'escapes-root' };

  // ROUND-TRIP NÖBETİ — kayıt kapısı ikinci kez, bu kez ÜRETİLEN yol üzerinden.
  const back = C.classify(abs, roots, { platform });
  if (!back || back.class !== classId || back.relPath !== norm) {
    return { ok: false, reason: 'round-trip-mismatch' };
  }
  return { ok: true, abs, subtree: prefix };
}

/**
 * `lower(rel_path)` çakışması: duyarsız bir dosya sisteminde AYNI dosyaya düşen
 * iki (veya daha fazla) satır.
 *
 * @returns {Array<{lower:string, relPaths:string[]}>} yalnız çakışan GRUPLAR
 */
function findCaseCollisions(relPaths) {
  const groups = new Map();
  for (const rp of relPaths || []) {
    if (typeof rp !== 'string' || !rp) continue;
    const key = normalizeRelPath(rp).toLowerCase();
    const list = groups.get(key);
    if (list) { if (!list.includes(rp)) list.push(rp); } else groups.set(key, [rp]);
  }
  const out = [];
  for (const [lower, members] of groups) {
    if (members.length > 1) out.push({ lower, relPaths: members.slice().sort() });
  }
  return out.sort((a, b) => (a.lower < b.lower ? -1 : a.lower > b.lower ? 1 : 0));
}

/**
 * UYGULAMA KAPISI (§4.3) — bu platformda hangi `rel_path`ler diske yazılabilir?
 *
 * Çakışan grupta **HİÇBİRİ** uygulanmaz. "İlkini uygula" demek, iki cihazın
 * sırasına göre farklı dosyayı kazandırmak ve farkı SESSİZ bırakmaktır; bekletmek
 * ise `sync_conflicts(kind='platform-collision')` satırıyla GÖRÜNÜRdür.
 *
 * @returns {{apply:string[], hold:Array<{relPath:string, kind:string, reason:string, detail?:string}>}}
 */
function planPlatformGate(relPaths, opts = {}) {
  const platform = opts.platform || process.platform;
  const list = (relPaths || []).filter((rp) => typeof rp === 'string' && rp);
  const held = new Map();

  if (isCaseInsensitivePlatform(platform)) {
    for (const group of findCaseCollisions(list)) {
      for (const rp of group.relPaths) {
        held.set(rp, {
          relPath: rp,
          kind: 'platform-collision',
          reason: 'case-collision',
          detail: `yalnız büyük/küçük harfle ayrışıyor: ${group.relPaths.join(' · ')}`,
        });
      }
    }
  }
  if (platform === 'win32') {
    for (const rp of list) {
      if (held.has(rp)) continue;
      const bad = windowsUnsafe(rp);
      if (bad) {
        held.set(rp, {
          relPath: rp,
          kind: 'platform-collision',
          reason: bad.reason,
          detail: `Windows bu adı yaratamaz: "${bad.segment}"`,
        });
      }
    }
  }
  return {
    apply: list.filter((rp) => !held.has(rp)),
    hold: [...held.values()],
  };
}

module.exports = {
  REL_PATH_MAX,
  WIN_RESERVED,
  RE_LEADING_SEP,
  RE_DRIVE_LETTER,
  RE_TRAVERSAL,
  RE_MEMORY_INDEX,
  isCaseInsensitivePlatform,
  normalizeRelPath,
  validateRelPath,
  windowsUnsafe,
  classifyForSync,
  withinRoot,
  resolveRelPath,
  findCaseCollisions,
  planPlatformGate,
};
