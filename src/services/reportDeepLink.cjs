'use strict';
// RPT5-04 (K1=A) — RAPORUN HİÇ ÖLMEYEN ADRESİ: `agentspace://rapor/<proje>/<kimlik>`.
//
// ## Neden bu modül var
//
// Murat 25.09: "raporlardan tarayıcıda erişebileceğimiz … bir URL'den çıktı veririz. Ama bunu
// sunucuya yüklemeyelim." İç sunucu her açılışta `getFreePort()` ile başka kapıdan kalkıyor;
// bugün verilen `http://127.0.0.1:<port>/…` adresi yarın ölü. Uygulamanın kendi şeması
// (`appScheme.cjs`: prod `agentspace`, dev `agentspace-dev`, test `agentspace-test`) ise
// kurulu kaldıkça yaşar: tıklanınca işletim sistemi uygulamayı açar, uygulama raporu gösterir.
//
// ## Kurallar
//
//   1. KİLİT: bağlantı YALNIZ aç-göster yapar. Yazma, silme, komut çalıştırma yok. Ayrıştırıcı
//      bir DÜZ tanımlayıcı çifti (proje, kimlik) döner; dosya yolu değil.
//   2. Beyaz liste: şema `agentspace(-dev|-test)`, yol TAM üç parça `rapor/<proje>/<kimlik>`
//      (RPT-OPEN-INAPP-01: isteğe bağlı dördüncü parça YALNIZ `sayfa`),
//      parçalar `[A-Za-z0-9._-]`. Sorgu (`?`), parça (`#`), yüzde kodlaması (`%` — `%2e%2e`
//      böyle gizlenir), ters bölü, boşluk/kontrol karakteri, `..`, 2 KB üstü → RED.
//   3. Kimlik → dosya çözümü `resolveReportFile`: aday dizinler ÇAĞIRANDAN gelir (main:
//      `reportsWatcher.reportsDirs` — Raporlar'ın okuduğu kurallar), çözülen gerçek yol
//      (sembolik bağ çözülmüş) o dizinin ALTINDA değilse RED. Hafıza:
//      writer-that-deletes-needs-stricter-key — beyaz liste tek başına yetmez, çözülen yolu ölç.
//   4. fs/electron'u ÜST DÜZEYDE require ETMEZ: renderer (terminal bağlantı sağlayıcısı,
//      "Bağlantıyı kopyala", sohbet çipi) aynı ayrıştırıcıyı içe aktarır. Dosya sistemi
//      gereken tek fonksiyon (`resolveReportFile`) `fs`/`path`'i parametre alır.
//
// Çalıştır: node --test electron/reportDeepLink.test.cjs

/** Şema adı `agentspace` ya da kanal eki (appScheme.cjs SCHEME_BY_BUILD ile aynı üç değer). */
const SCHEME_RE = /^agentspace(?:-dev|-test)?$/;
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const MAX_URL = 2048;
const MAX_SEGMENT = 128;
const KIND = 'rapor';
/** RPT-OPEN-INAPP-01 — `…/<kimlik>/sayfa`: iç tarayıcı sekmesi. */
const VIEW_PAGE = 'sayfa';

/**
 * @param {unknown} url
 * @param {{scheme?: string|null}} [opts] `scheme` verilirse YALNIZ o şema kabul edilir
 *   (main kendi kanalının şemasını verir; renderer üç kanalı da kabul eder).
 * @returns {{ok:true, scheme:string, project:string, id:string, filename:string}
 *          |{ok:false, reason:string}}
 */
function parseReportLink(url, opts = {}) {
  if (typeof url !== 'string' || !url) return { ok: false, reason: 'bos' };
  if (url.length > MAX_URL) return { ok: false, reason: 'uzun' };
  // Boşluk/kontrol karakteri: tarayıcının okuduğu ile bizim okuduğumuz aynı olmalı.
  if (/[\u0000- \u007f-￿]/.test(url)) return { ok: false, reason: 'karakter' };
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/.exec(url);
  if (!m) return { ok: false, reason: 'sema' };
  const scheme = m[1].toLowerCase();
  if (!SCHEME_RE.test(scheme)) return { ok: false, reason: 'sema' };
  if (opts.scheme && scheme !== String(opts.scheme).toLowerCase()) return { ok: false, reason: 'kanal' };
  let rest = m[2];
  if (rest.includes('?')) return { ok: false, reason: 'sorgu' };
  if (rest.includes('#')) return { ok: false, reason: 'parca' };
  if (rest.includes('%')) return { ok: false, reason: 'kodlama' };
  if (rest.includes('\\')) return { ok: false, reason: 'ters-bolu' };
  // Windows kabuğu / bazı tarayıcılar sona tek `/` ekler — yalnız BİR tanesi tolere edilir.
  if (rest.endsWith('/')) rest = rest.slice(0, -1);
  const parts = rest.split('/');
  // RPT-OPEN-INAPP-01 — isteğe bağlı 4. parça `sayfa`: rapor Raporlar'da değil, iç tarayıcı
  // sekmesinde (`agentspace-sayfa://`) açılır. Eklemeli: 3 parçalı eski bağlantılar aynen çalışır.
  let view = null;
  if (parts.length === 4 && parts[3].toLowerCase() === VIEW_PAGE) {
    view = VIEW_PAGE;
    parts.pop();
  }
  if (parts.length !== 3 || parts.some((p) => !p)) return { ok: false, reason: 'bicim' };
  const [kind, project, rawId] = parts;
  if (kind.toLowerCase() !== KIND) return { ok: false, reason: 'tur' };
  for (const seg of [project, rawId]) {
    if (seg.length > MAX_SEGMENT || !SEGMENT_RE.test(seg)) return { ok: false, reason: 'karakter' };
    if (seg.includes('..') || seg === '.') return { ok: false, reason: 'ust-dizin' };
  }
  // Kimlik = raporun gövde adı. Yapıştırılan `.md`/`.html` uzantısı tolere edilir.
  const id = rawId.replace(/\.(md|html)$/i, '');
  if (!id || id.startsWith('.')) return { ok: false, reason: 'kimlik' };
  // `view` YALNIZ sayfa bağlantısında: 3 parçalı bağlantının çıktısı birebir eskisi.
  return view ? { ok: true, scheme, project, id, filename: `${id}.md`, view } : { ok: true, scheme, project, id, filename: `${id}.md` };
}

/** Kolaylık: bu URL bir rapor bağlantısı mı (şema + `rapor/` yolu) — geçerlilik AYRI sorulur. */
function isReportLink(url) {
  return typeof url === 'string' && /^agentspace(?:-dev|-test)?:\/\/rapor\//i.test(url);
}

/**
 * Bağlantıyı üret. Rapor dosya adı (`X.md`) ya da kimlik verilir; sonuç ayrıştırıcıdan
 * geri geçmezse null (bozuk bağlantı üretmektense hiç üretmemek). `view: 'sayfa'` → iç tarayıcı.
 * @param {{scheme:string, project:string, id?:string|null, filename?:string|null, view?:'rapor'|'sayfa'}} p
 * @returns {string|null}
 */
function reportLink(p) {
  const o = p || {};
  const id = String(o.id || o.filename || '').replace(/\.(md|html)$/i, '');
  const tail = o.view === VIEW_PAGE ? `/${VIEW_PAGE}` : '';
  const url = `${String(o.scheme || '').toLowerCase()}://${KIND}/${o.project || ''}/${id}${tail}`;
  const back = parseReportLink(url);
  return back.ok ? url : null;
}

/**
 * Metindeki GEÇERLİ rapor bağlantıları (terminal bağlantı sağlayıcısı). Sondaki noktalama
 * (`.`, `,`, `)`) bağlantıya dahil edilmez — cümle sonundaki adres yine tıklanır.
 * @param {string} text
 * @returns {Array<{index:number, url:string}>}
 */
function findReportLinks(text) {
  const out = [];
  const re = /agentspace(?:-dev|-test)?:\/\/rapor\/[A-Za-z0-9._/-]+/gi;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const url = m[0].replace(/[.,;:)]+$/, '');
    if (parseReportLink(url).ok) out.push({ index: m.index, url });
  }
  return out;
}

/**
 * Bir rapor dizininin PROJE adı — `src/lib/reports.ts projectOf` ile AYNI kural (o fonksiyon
 * buna delege eder; bağlantıdaki proje Raporlar'ın "Proje" ekseniyle aynı ad olsun):
 * kök altındaysa kökten sonraki ilk dizin (kökün kendi `docs/`/`.agentspace/` dizinleri →
 * kökün adı), kök dışındaysa `<repo>/docs/agent-results` → `<repo>`.
 * @param {string} dir
 * @param {string|null|undefined} workspaceRoot
 * @param {typeof import('node:path')} pathMod
 */
function projectOfDir(dir, workspaceRoot, pathMod) {
  const abs = pathMod.resolve(dir);
  const root = workspaceRoot ? pathMod.resolve(workspaceRoot) : null;
  if (root && (abs === root || abs.startsWith(root + pathMod.sep))) {
    const first = pathMod.relative(root, abs).split(pathMod.sep)[0] || '';
    if (!first || first === 'docs' || first === '.agentspace') return pathMod.basename(root);
    return first;
  }
  return pathMod.basename(pathMod.resolve(abs, '..', '..')) || abs;
}

/**
 * Ayrıştırılmış bağlantı → diskteki rapor. İlk isabet kazanır (Raporlar'ın `locateReportFile`
 * sırası). Proje adı harf-duyarsız karşılaştırılır (macOS/Windows dosya sistemi de öyle).
 * @param {{project:string, filename:string}} link parseReportLink'in `ok` çıktısı
 * @param {{dirs:string[], workspaceRoot?:string|null, fs:typeof import('node:fs'), path:typeof import('node:path')}} deps
 * @returns {{file:string, dir:string, filename:string}|null}
 */
function resolveReportFile(link, deps) {
  const { fs, path: p } = deps;
  if (!link || !link.filename || !link.project || !SEGMENT_RE.test(link.filename)) return null;
  const want = String(link.project).toLowerCase();
  for (const dir of Array.isArray(deps.dirs) ? deps.dirs : []) {
    if (typeof dir !== 'string' || !dir) continue;
    if (projectOfDir(dir, deps.workspaceRoot, p).toLowerCase() !== want) continue;
    const base = p.resolve(dir);
    const candidate = p.resolve(base, link.filename);
    if (!candidate.startsWith(base + p.sep)) continue;
    let real;
    let realBase;
    try {
      real = fs.realpathSync(candidate);
      realBase = fs.realpathSync(base);
    } catch {
      continue; // bu dizinde yok → sıradaki
    }
    // Sembolik bağ rapor dizininin DIŞINA çıkıyorsa açılmaz.
    if (!real.startsWith(realBase + p.sep)) continue;
    try {
      if (!fs.statSync(real).isFile()) continue;
    } catch {
      continue;
    }
    return { file: real, dir: base, filename: link.filename };
  }
  return null;
}

module.exports = {
  parseReportLink,
  isReportLink,
  reportLink,
  findReportLinks,
  projectOfDir,
  resolveReportFile,
  MAX_URL,
  MAX_SEGMENT,
};
