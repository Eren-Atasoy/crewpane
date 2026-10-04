// CODEINDEX-PROOF-01 — KOD İNDEKSİNİN SAĞLIK SATIRI (ölçülen gerçek, beyan değil).
//
// ═══════════════════════════════════════════════════════════════════════════════
// NEDEN BU DOSYA VAR — "NASIL ANLAYACAĞIZ?" SORUSUNUN KALICI CEVABI
// ═══════════════════════════════════════════════════════════════════════════════
// CIDX-1 anahtarı kurdu ama ekran indeksin DURUMUNU kendi defterinden okuyordu:
// `settings.codeIndex[slug].indexedSha`. O defter, indekslemeyi BİZ başlattığımızda
// yazılır — ve bir daha hiç doğrulanmaz. Yani ürün "indekslendi" derken aracın
// elinde hiçbir şey olmayabilir ve ekran bunu SÖYLEYEMEZ.
//
// Bu varsayımsal bir risk değil, 09.09'da ÖLÇÜLDÜ. Görev sırasında crewpane
// indeksi (91.080 düğüm / 239 MB) çalışma ortasında KAYBOLDU:
//
//   $ ls ~/.cache/codebase-memory-mcp/
//   Users-...-crewpane.db.corrupt      159 MB   09.09 05:04   ← .db → .db.corrupt
//   Users-...-chatflow.db.corrupt        82 MB   08.09 00:49   ← aynı sınıf, 2. vaka
//
//   $ tail -1 ~/.cache/codebase-memory-mcp/logs/.worker-26124.log
//   level=warn msg=parent.exited reason=ppid_changed
//
// İki ayrı bozulma yolu ölçüldü: (1) indeksleyici işçi, EBEVEYNİ ölünce yazımın
// ortasında öksüz kalıp iniyor; (2) aynı depoyu AYNI ANDA indeksleyen birden çok
// işçi (08.09: 3 işçi, aynı repo) birbirinin yazımını eziyor. İkisinde de sonuç
// aynı: veritabanı `.db.corrupt` diye yeniden adlandırılıyor, proje `list_projects`
// çıktısından SESSİZCE düşüyor — ne hata, ne bildirim, ne günlük satırı kullanıcıya
// ulaşıyor. Ürünün ekranı ise defterine bakıp "taze" demeye devam ediyordu.
//
// Bu yüzden sağlık ARACIN KENDİSİNDEN sorulur (`cli list_projects`) ve deftere
// karşı ÇAPRAZ KONTROL edilir. İki kaynak ayrışıyorsa ekran bunu SÖYLER.
//
// ═══════════════════════════════════════════════════════════════════════════════
// "TAZE" DEMENİN BEDELİ VAR — BU YÜZDEN DURUM YUVARLANMAZ
// ═══════════════════════════════════════════════════════════════════════════════
// CIDX-0 ölçtü: bayat indeks hata VERMEZ, sessizce YANLIŞ kaynak döndürür. Aynı
// disiplin burada da geçerli ve iki durum EKLENİR:
//
//   missing  — defter "indeksledim" diyor, araçta o proje YOK  (kayıp)
//   corrupt  — diskte o projeye ait bir `.db.corrupt` dosyası var (bozuldu)
//
// `missing` ile `not-indexed` AYRI ŞEYDİR ve karıştırılırsa kullanıcı yalan bilgi
// alır: "hiç indekslenmedi" bir DAVET, "indeksin kayboldu" bir ARIZA raporudur.
//
// ═══════════════════════════════════════════════════════════════════════════════
// EŞLEŞTİRME NEDEN `root_path` ÜZERİNDEN
// ═══════════════════════════════════════════════════════════════════════════════
// Aracın proje ADI iki ayrı gramerden gelebiliyor: yoldan türetilmiş
// (`Users-...-crewpane`) ya da `--name` ile elle verilmiş (`todo-app`,
// `ytg-r3-skool` — ikisi de bu makinede MEVCUT). Ada göre eşleştiren bir kod, elle
// adlandırılmış her projeyi "indekslenmemiş" gösterirdi. `root_path` tek
// belirsizliksiz anahtardır. Ad yalnız `.db.corrupt` avında kullanılır — çünkü
// kayıp bir projenin ARTIK root_path'i yoktur; bu, kabul edilmiş bir SINIR
// (`--name`li bir projenin bozulması ada göre yakalanamaz) ve `corruptNameKnown`
// alanı bunu ekranda iddia etmemek için taşınır.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Aracın yoldan türettiği proje adı: `/a/b c/d` → `a-b-c-d`. */
function derivedProjectName(repoPath) {
  if (typeof repoPath !== 'string' || !repoPath.trim()) return null;
  const stripped = repoPath.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!stripped) return null;
  return stripped.replace(/[^A-Za-z0-9_.]+/g, '-');
}

/** Yol karşılaştırması tek yerde: sondaki `/` ve büyük/küçük fark yaratmasın. */
function canonPath(p) {
  if (typeof p !== 'string' || !p.trim()) return null;
  return p.trim().replace(/\/+$/, '');
}

/**
 * `cli list_projects` çıktısını ayrıştır. Bozuk/boş çıktı `null` döner — BOŞ DİZİ
 * DEĞİL. Fark önemli: boş dizi "araçta hiç proje yok" (bir İDDİA), `null`
 * "soramadım" (iddia YOK). Bu ikisi karışırsa ekran, aracı hiç çalıştıramadığı bir
 * makinede bütün projeleri "kayıp" ilan eder.
 * @returns {Array<{name:string,rootPath:string|null,nodes:number,edges:number,headSha:string|null}>|null}
 */
function parseProjects(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) return null;
  let doc;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return null;
  }
  const list = (doc && Array.isArray(doc.projects)) ? doc.projects
    : (doc && doc.result && Array.isArray(doc.result.projects)) ? doc.result.projects
      : null;
  if (!Array.isArray(list)) return null;
  return list
    .filter((p) => p && typeof p.name === 'string' && p.name)
    .map((p) => ({
      name: p.name,
      rootPath: canonPath(p.root_path),
      nodes: Number.isFinite(p.nodes) ? p.nodes : 0,
      edges: Number.isFinite(p.edges) ? p.edges : 0,
      headSha: (p.git && typeof p.git.head_sha === 'string' && p.git.head_sha) ? p.git.head_sha : null,
    }));
}

/**
 * Önbellek dizinindeki `.db.corrupt` dosyalarının proje adları.
 * Dizin okunamıyorsa `null` (iddia YOK) — boş dizi "bozuk dosya yok" DEMEKTİR.
 * @returns {string[]|null}
 */
function corruptNames(cacheDir, deps) {
  const io = (deps && deps.fs) || fs;
  try {
    return io.readdirSync(cacheDir)
      .filter((f) => f.endsWith('.db.corrupt'))
      .map((f) => f.slice(0, -'.db.corrupt'.length));
  } catch {
    return null;
  }
}

/**
 * Aracın önbellek dizini.
 *
 * WIN-PARITY-01 — satıcının BELGELENMİŞ sözleşmesi okundu (README "Environment"
 * tablosu): varsayılan üç platformda da `~/.cache/codebase-memory-mcp`, ve
 * `CBM_CACHE_DIR` bunu EZER. Eskiden yalnız varsayılan biliniyordu; kullanıcı
 * önbelleği taşıdıysa `corruptNames` boş dizin okuyup `null` ("ölçemedim") dönüyordu
 * — hatalı bir iddia değil ama gereksiz bir körlük. Artık önce env sorulur.
 *
 * 🟠 BEYAN: Windows varsayılanı yalnız satıcı BELGESİNDEN alındı; gerçek bir
 * Windows kurulumunda ÖLÇÜLMEDİ (WIN-PARITY-01 §açık sorular).
 */
function defaultCacheDir(homedir, env) {
  const e = env || process.env;
  const override = typeof e.CBM_CACHE_DIR === 'string' ? e.CBM_CACHE_DIR.trim() : '';
  if (override) return override;
  const home = (typeof homedir === 'string' && homedir) ? homedir : require('node:os').homedir();
  return path.join(home, '.cache', 'codebase-memory-mcp');
}

/**
 * TEK PROJENİN SAĞLIĞI — defter (`ledger`) ile aracın gerçeği (`tool`) yan yana.
 *
 * `tool === null` "soramadım" demektir ve bu hâlde ASLA `missing` denmez: aracı
 * çalıştıramadığımız için kullanıcının indeksini kayıp ilan etmek, düzeltilecek
 * bir arıza uydurmaktır. O hâlde defterin durumu (fresh/stale/unknown) korunur ve
 * `toolAsked:false` ile ekrana "doğrulanmadı" olarak taşınır.
 *
 * @param {{repoPath:string|null, ledger:{indexedSha:string|null,lastIndexedAt:number|null,enabled:boolean},
 *          ledgerState:'not-indexed'|'fresh'|'stale'|'unknown',
 *          tool:Array|null, corrupt:string[]|null}} o
 */
function healthFor({ repoPath, ledger, ledgerState, tool, corrupt } = {}) {
  const led = ledger || {};
  const root = canonPath(repoPath);
  const name = derivedProjectName(root);

  const base = {
    state: ledgerState || 'not-indexed',
    symbols: null,
    edges: null,
    lastIndexedAt: Number.isFinite(led.lastIndexedAt) ? led.lastIndexedAt : null,
    enabled: led.enabled === true,
    toolAsked: Array.isArray(tool),
    toolName: null,
    corruptNameKnown: !!name,
  };

  // Araca soramadıysak defterin dediğiyle yetin — ve bunu SAKLAMA.
  if (!Array.isArray(tool)) return base;

  const hit = root ? tool.find((p) => p.rootPath && p.rootPath === root) : null;
  if (hit) {
    return { ...base, symbols: hit.nodes, edges: hit.edges, toolName: hit.name };
  }

  // Araçta YOK. İki ayrı gerçek — ve bunlar aynı cümleyle anlatılamaz.
  const isCorrupt = Array.isArray(corrupt) && name ? corrupt.includes(name) : false;
  if (isCorrupt) return { ...base, state: 'corrupt' };

  // Defter "indeksledim" diyorsa ve araçta yoksa: KAYIP. Defter de boşsa, bu
  // yalnızca "hiç indekslenmedi"dir — arıza değil, davet.
  if (led.indexedSha) return { ...base, state: 'missing' };
  return { ...base, state: 'not-indexed' };
}

module.exports = {
  derivedProjectName,
  canonPath,
  parseProjects,
  corruptNames,
  defaultCacheDir,
  healthFor,
};
