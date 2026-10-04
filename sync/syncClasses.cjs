// SYNC-F1-1 (Wheeljack) — SENKRON SINIF KAYDI: neyin senkronlanabileceğinin TEK kaynağı.
//                         Tasarım: docs/design/SYNC-F1-TASARIM.md §0.5.3 · §2.1 · §4
//                         Kapsam kararı: docs/design/SYNC-KAPSAM-KARARLARI.md (KİLİTLİ, ilke 2)
//
// ═══════════════════════════════════════════════════════════════════════════════
// NEDEN SINIF, NEDEN YOL DEĞİL
// ═══════════════════════════════════════════════════════════════════════════════
// Kapsam kararı ilke 2 aynen şöyle diyor: "yol tabanlı değil, SINIF tabanlı allowlist".
// Yol tabanlı bir kara liste ("settings.json'ı yükleme") her yeni sır dosyasında
// güncellenmek zorundadır ve bir kez unutulduğunda sır buluta gider — geri alınamaz.
// Burada tersi kurulur: KAYITTA OLMAYAN BİR DOSYA İÇİN ÇAĞRILACAK YOL YOKTUR.
// `classify()` varsayılan olarak `null` döner; senkron boru hattının tamamı bu dönüşe
// bakar. Yani `settings.json`, `vault.bin`, `auth/`, `device.json`, `bridge.json`,
// `live-panes.json` için "unutulan bir kural" diye bir şey yoktur: hiçbiri hiçbir
// sınıfın alt ağacında değildir (test: `syncClasses.test.cjs` → "kök izolasyonu").
//
// Bu, savunmanın YALNIZ ilk katmanıdır. Diğer ikisi:
//   2) DB CHECK'i  — `class IN ('memory','memory-global','skill','prefs')` (migration
//                    20260821090000_syncf1_crewpane_files.sql). İstemci hatası bile
//                    `settings` sınıfı uyduramaz. Parity testi bu iki listeyi bağlar.
//   3) Kök izolasyonu — sır taşıyan hiçbir dosya bir sınıf alt ağacında DEĞİL.
//
// ═══════════════════════════════════════════════════════════════════════════════
// SAF MODÜL — fs YOK, Electron YOK
// ═══════════════════════════════════════════════════════════════════════════════
// Yalnız `node:path` kullanır; platform (`darwin`/`win32`) ENJEKTE edilir, böylece
// Windows yol davranışı mac'te `node --test` ile sınanır (ADP-874 dersinin tersi:
// platform farkını gerçek platformda beklemek = arızayı kullanıcıda öğrenmek).
//
// ⚠️ BU MODÜLÜN YAPMADIĞI — çağıranın (F1-2) borcu:
//   · SEMBOLİK BAĞ ÇÖZÜMÜ. `.crewpane/memory/x.md` → `~/.crewpane/settings.json`
//     bağlantısı buradaki metin denetiminden GEÇER (yol sınıf ağacındadır). Bağı
//     çözmek fs işidir: `syncScanner` her adayı `realpath`leyip sonucu TEKRAR
//     `classify()`den geçirmek zorundadır (fail-closed).
//   · Windows ayrılmış adları (`CON.md`, `aux/`, sondaki nokta/boşluk) ve
//     büyük/küçük harf çakışması → `syncPaths` (§4.3, F1-2).
//   · Ters yön (`(class, rel_path) → mutlak yol`) → `syncPaths` (§2.1).

'use strict';

const path = require('node:path');

/** DB `class` CHECK'inin AYNISI — parity testi bu listeyi migration dosyasına bağlar. */
const DB_CLASSES = Object.freeze(['memory', 'memory-global', 'skill', 'prefs']);

/** Hesap kapsamlı sınıfların workspace anahtarı (DB: `crewpane_files_class_scope`). */
const GLOBAL_WORKSPACE_KEY = 'global';

/** `prefs` sınıfının şemada mühürlü TEK yolu (DB: `crewpane_files_prefs_path`). */
const PREFS_REL_PATH = 'prefs/app-prefs.json';

/** `rel_path` tavanı — DB CHECK'iyle aynı (Windows MAX_PATH payı, §4.1). */
const REL_PATH_MAX = 400;

/**
 * SINIF KAYDI (tasarım §2.1: `{id, kökÇözücü, altAğaç, uzantılar, hariç}`).
 *
 * `rootKind` kökü ADLANDIRIR, çözmez: çözüm çağıranın verdiği `roots` nesnesinden
 * gelir (`workspaceRoot` / `accountRoot`) — bu modül `instancePaths`i require etmez,
 * yoksa saflık ve DI biterdi.
 *
 * `subtrees[].prefix` DB'ye yazılan `rel_path`in ilk parçasıdır: yol sözleşmesi
 * `.crewpane/` kökünden SONRASINI taşır (§4.1), hesap kapsamlı sınıfta ise hesap
 * kökünden sonrasını. İki farklı kapsam aynı prefix'i kullanabilir (`memory/…`)
 * çünkü satır kimliği `(company_id, workspace_key, rel_path)`tir ve `workspace_key`
 * ikisini ayırır ('global' vs 'ws-…').
 */
const CLASS_REGISTRY = Object.freeze([
  Object.freeze({
    id: 'memory',
    scope: 'workspace',
    rootKind: 'workspaceRoot',
    subtrees: Object.freeze([
      Object.freeze({ prefix: 'memory', segments: Object.freeze(['.crewpane', 'memory']) }),
    ]),
    // ÖLÇÜLDÜ (tasarım §4.4): hafıza ağacında `.md` dışında 2 çöp dosya var
    // (`agents/optimus/supabase/.temp/linked-project.json`, `.../cli-latest`).
    // "memory/ altındaki her şeyi yükle" tasarımı bunları da buluta taşırdı.
    extensions: Object.freeze(['.md']),
  }),
  Object.freeze({
    id: 'memory-global',
    scope: 'account',
    rootKind: 'accountRoot',
    // ⚠️ `<accountRoot>/memory` — hesap kökünün KENDİSİ DEĞİL. Hesap kökünde
    // `settings.json`, `auth/`, `vault.bin` yaşıyor (accountScope.cjs); alt ağacı
    // bir seviye daraltmak bu üçünü yapısal olarak dışarıda bırakır.
    subtrees: Object.freeze([
      Object.freeze({ prefix: 'memory', segments: Object.freeze(['memory']) }),
    ]),
    extensions: Object.freeze(['.md']),
  }),
  Object.freeze({
    id: 'skill',
    scope: 'workspace',
    rootKind: 'workspaceRoot',
    // Üç alt ağaç TEK sınıfta: yayın/taslak/geçmiş ayrımı `rel_path` prefix'inde
    // durur. Hiçbiri motor yoluna kopyalanmaz (skillStore/skillVersions: kapı
    // DİZİNDİR) — yani senkron, onay kapısını taşımaz, yalnız dosyaları taşır.
    subtrees: Object.freeze([
      Object.freeze({ prefix: 'skills', segments: Object.freeze(['.crewpane', 'skills']) }),
      Object.freeze({ prefix: 'skill-drafts', segments: Object.freeze(['.crewpane', 'skill-drafts']) }),
      Object.freeze({ prefix: 'skill-history', segments: Object.freeze(['.crewpane', 'skill-history']) }),
    ]),
    extensions: Object.freeze(['.md', '.json']),
  }),
  Object.freeze({
    id: 'prefs',
    scope: 'account',
    // 🔴 TÜRETİLMİŞ SINIF — kaynağı kullanıcının elle yazdığı bir dosya DEĞİL,
    // projektörün (SYNC-F1-7) ürettiği bir PROJEKSİYONdur (tasarım §5.5).
    // `settings.json` senkronlanmaz; beyaz listeli anahtarların projeksiyonu
    // senkronlanır.
    //
    // ⚠️ SYNC-F1-7 SAPMASI — F1-1'de bu sınıf `rootKind: null` ile SENTETİK
    // kurulmuştu: "tarayıcı onu üretemesin, yalnız projektör üretsin". Ölçüldü ki
    // o hâl projektörü de imkânsız kılıyor: `syncPaths.resolveRelPath` sentetik
    // sınıfa yol ÜRETMEYİ reddediyor (`synthetic-class`), yani gelen satır diske
    // YAZILAMIYOR ve giden satır için okunacak bayt YOK. Amaç korundu, mekanizma
    // değişti: kök `<accountRoot>/prefs` (hesap kökünün KENDİSİ değil — orada
    // `settings.json`/`auth/`/`vault.bin` yaşıyor) ve `fixedRelPath` yüzünden o
    // ağaçta YALNIZ TEK BİR AD sınıflanabilir. Yani tarayıcı `prefs/` altına
    // düşen başka hiçbir dosyayı (bir yedeği, bir artığı) buluta taşıyamaz —
    // eski `rootKind:null` ile aynı güvenlik hükmü, çalışan hâli.
    rootKind: 'accountRoot',
    subtrees: Object.freeze([
      Object.freeze({ prefix: 'prefs', segments: Object.freeze(['prefs']) }),
    ]),
    extensions: Object.freeze(['.json']),
    projected: true,
    fixedRelPath: PREFS_REL_PATH,
  }),
]);

/**
 * HER SINIFTA hariç tutulanlar. Kara liste DEĞİL — beyaz listenin İÇİNDEKİ istisnalar.
 * Bir dosya buraya takılmasa bile uzantı + alt ağaç kapısından geçmek zorundadır.
 */
const EXCLUDE_RULES = Object.freeze({
  // İNDEKS SENKRONLANMAZ, TÜRETİLİR (tasarım §3 · DB CHECK `rel_path !~ MEMORY\.md$`).
  // İki cihaz aynı indeksi ayrı ayrı üretir; senkronlanırsa LWW her turda birinin
  // pointer'ını siler ve kayıp SESSİZ olur.
  fileNames: Object.freeze(['MEMORY.md']),
  // Gizli dosya/dizin: `.DS_Store`, `.temp/`, `.git/` … Hiçbiri hafıza/skill içeriği
  // değil ve `.temp/` altında ÖLÇÜLEN artıklar var (§4.4).
  dotSegments: true,
  // `atomicWrite.cjs` yazım-ortası artığı: yükleyip sonra silmek eko + çakışma üretir.
  tmpPrefixes: Object.freeze(['.tmp-', '~$']),
});

/**
 * Sınıf alt ağaçlarında ASLA bulunmaması gereken adlar. Bu liste bir SÜZGEÇ DEĞİL —
 * `syncClasses.test.cjs`in nöbetidir: biri yarın `memory` kökünü `.crewpane`e ya da
 * `accountRoot`a genişletirse test kırmızı yanar. Süzgeç olarak kullanılsaydı,
 * "listeye eklemeyi unuttuk" sınıfı hatayı geri davet ederdik.
 */
const SECRET_BEARING_ENTRIES = Object.freeze([
  'settings.json', 'vault.bin', 'auth', 'device.json', 'credentials',
  'bridge.json', 'live-panes.json', 'account.json', 'keys.env',
]);

function pathFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function classById(id) {
  return CLASS_REGISTRY.find((c) => c.id === id) || null;
}

/** Bu sınıf id'si senkron kaydında mı? (varsayılan: hayır) */
function isSyncClass(id) {
  return !!classById(id);
}

/** Diskte gerçek bir ağacı olan sınıflar — tarayıcının (`syncScanner`) gezeceği küme. */
function fileBackedClasses() {
  return CLASS_REGISTRY.filter((c) => c.rootKind).map((c) => c.id);
}

/**
 * Bir sınıfın alt ağaçlarının MUTLAK kökleri. Kök verilmemişse (ör. workspace açık
 * değil) boş dizi — çağıran "kök yok" ile "her şey uygun" arasını karıştıramaz.
 */
function classRoots(classId, roots = {}, opts = {}) {
  const spec = classById(classId);
  if (!spec || !spec.rootKind) return [];
  const base = roots[spec.rootKind];
  if (typeof base !== 'string' || !base.trim()) return [];
  const p = pathFor(opts.platform || process.platform);
  return spec.subtrees.map((sub) => ({
    prefix: sub.prefix,
    dir: p.join(p.normalize(base), ...sub.segments),
  }));
}

/** `workspace_key` üretilirken sınıfın hangi kapsama düştüğü (DB class_scope CHECK'i). */
function workspaceKeyFor(classId, workspaceKey) {
  const spec = classById(classId);
  if (!spec) return null;
  if (spec.scope === 'account') return GLOBAL_WORKSPACE_KEY;
  if (typeof workspaceKey !== 'string' || !/^ws-[0-9a-f]{16}$/.test(workspaceKey)) return null;
  return workspaceKey;
}

function relSegmentsRejected(segments) {
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') return true;
    if (seg.includes('\0')) return true;
    if (EXCLUDE_RULES.dotSegments && seg.startsWith('.')) return true;
    for (const pre of EXCLUDE_RULES.tmpPrefixes) if (seg.startsWith(pre)) return true;
  }
  const leaf = segments[segments.length - 1];
  if (EXCLUDE_RULES.fileNames.includes(leaf)) return true;
  return false;
}

/**
 * MUTLAK YOL → `{ class, relPath, scope, subtree }` · uymuyorsa **null** (VARSAYILAN REDDET).
 *
 * Yol sözleşmesi (§4.1) burada ZORLANIR, sonra DB CHECK'i aynısını bir kez daha
 * zorlar: daima göreli · daima `/` · daima NFC · `..` yok · sürücü harfi yok ·
 * `MEMORY.md` yok · ≤400 karakter.
 *
 * @param {string} absPath  platformun kendi biçiminde mutlak yol
 * @param {{workspaceRoot?:string, accountRoot?:string}} roots
 * @param {{platform?:string}} [opts]  platform ENJEKTE edilebilir (test)
 */
function classify(absPath, roots = {}, opts = {}) {
  if (typeof absPath !== 'string' || !absPath.trim()) return null;
  if (absPath.includes('\0')) return null;

  const platform = opts.platform || process.platform;
  const p = pathFor(platform);
  // NFC ÖNCE (§4.2): macOS ad baytlarını NFD'ye yakın döndürebilir; kök ile aday
  // farklı biçimdeyse containment testi sessizce ıskalar.
  const abs = p.normalize(absPath.normalize('NFC'));
  if (!p.isAbsolute(abs)) return null;

  for (const spec of CLASS_REGISTRY) {
    for (const { prefix, dir } of classRoots(spec.id, roots, { platform })) {
      const rel = p.relative(dir, abs);
      // Kök nöbeti (attachmentStore `withinStore` deseni): boş = kökün kendisi,
      // `..` = dışarı sıçrama, mutlak = başka sürücü/UNC.
      if (!rel || rel.startsWith('..') || p.isAbsolute(rel)) continue;

      const segments = rel.split(/[\\/]/);
      if (relSegmentsRejected(segments)) return null;

      const ext = p.extname(segments[segments.length - 1]).toLowerCase();
      if (!spec.extensions.includes(ext)) return null;

      const relPath = [prefix, ...segments].join('/');
      if (relPath.length > REL_PATH_MAX) return null;
      // MÜHÜRLÜ YOL — sınıfın tek meşru `rel_path`i varsa (projeksiyon sınıfları)
      // o ağaçtaki BAŞKA hiçbir ad sınıflanamaz. DB CHECK'i aynısını sunucu
      // tarafında bir kez daha zorlar; bu satır aynı hükmü İSTEMCİDE kurar, yani
      // `prefs/` altına düşen bir yedek/artık yükleme kuyruğuna HİÇ girmez.
      if (spec.fixedRelPath && relPath !== spec.fixedRelPath) return null;

      return Object.freeze({
        class: spec.id,
        relPath,
        scope: spec.scope,
        subtree: prefix,
      });
    }
  }
  return null; // ⛔ VARSAYILAN REDDET — kayıtta olmayan dosya için yükleme yolu YOKTUR.
}

module.exports = {
  DB_CLASSES,
  CLASS_REGISTRY,
  EXCLUDE_RULES,
  SECRET_BEARING_ENTRIES,
  GLOBAL_WORKSPACE_KEY,
  PREFS_REL_PATH,
  REL_PATH_MAX,
  classById,
  isSyncClass,
  fileBackedClasses,
  classRoots,
  workspaceKeyFor,
  classify,
};
