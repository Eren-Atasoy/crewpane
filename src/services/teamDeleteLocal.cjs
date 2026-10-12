// AgentSpace — TEAM-DELETE-01: takım silmenin MAKİNEYE ÖZGÜ yarısı (Electron ana süreç).
//
// Sunucu (`delete_team` RPC) takımı, çalışan masalarını, görevleri ve bulut hafızasını tek işlemde
// halleder. Bu modül yalnız bu bilgisayardaki dosyalara dokunur:
//   • ajan hafıza klasörü   <workspace>/.agentspace/memory/agents/<ajan>/   (agentMemory.agentMemoryDir)
//   • sonuç raporları       <rapor-dizini>/<KOD>-<ajan>[-N].md (+ aynı adlı .html sayfası)
//   • yedek zip             seçilen görevler (renderer'dan gelir) + hafıza + raporlar
// Ortak hafıza (`memory/shared/`) ve başka ajanın dosyası hiçbir yolda seçilmez. Başka cihazdaki kopyalar
// silinmez; pencere bunu söyler.
//
// SİLME GÜVENLİĞİ (hafıza: writer-that-deletes-needs-stricter-key):
//   1. Ajan kimliği KANONİK olmalı (`memoryKey`): agentMemory.safeSlug kimliği süzer ve tanımadığını
//      'unknown'a çevirir — süzgeçten geçmiş kimlik BAŞKA bir klasörü gösterebilir. Süzgeç kimliği
//      değiştiriyorsa ya da kimlik yalnız noktadan oluşuyorsa o ajan atlanır.
//   2. Her hedef `resolveInside(taban, hedef)` ile ÇÖZÜMLENİR ve tabanın kesin altında olmalıdır
//      (tabanın kendisi değil). Windows'ta harf duyarsız; başka sürücü / UNC reddedilir.
//   3. Sembolik bağlantı izlenmez: hedef ya da hafıza kökü bağlantıysa atlanır (gerçek yolu tabanın
//      dışına çıkabilir).
// Rapor arşivi = aynı rapor dizininde `arsiv/takim-<takım>-<gün>/` alt klasörüne TAŞIMA. Raporlar sekmesi
// yalnız dizinin üst seviyesindeki .md'leri listeler → arşivdekiler listeden çıkar, dosya kaybolmaz; geri
// getirmek elle taşımaktır. Rapor dosyaları git'teyse taşıma/silme çalışma ağacında değişiklik olarak
// görünür, commit edilmez (geçmiş commit'lerde kalır).
//
// Saf-ish: node builtins + agentMemory + reportAgentId; `pathMod` dikişi Windows yollarını test eder.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createWriteStream } = require('node:fs');
const agentMemory = require('../memory/agentMemory.cjs');
// REL-0340-INTEGRATE-13 — reportAgentId.cjs pakette asar'da DEĞİL (PKG-FIX-24, extraResources →
// Resources/electron/). reportWrittenEvent.cjs'teki sıranın aynısı: önce `./` (kaynak, test), yoksa
// `../electron/`. Yedek yol sabit metin: verify_asar_requires onu extraResources haritasıyla ölçer.
function loadReportAgentId() {
  try {
    return require('./reportAgentId.cjs');
  } catch (e) {
    if (!e || e.code !== 'MODULE_NOT_FOUND') throw e;
  }
  return require('./reportAgentId.cjs');
}
const { resolveReportAgent } = loadReportAgentId();

const ARCHIVE_DIR = 'arsiv';

/**
 * `target` çözümlendiğinde `base`in KESİN altındaysa çözümlenmiş yolu, değilse null döner.
 * Göreli hedef, NUL baytı, tabanın kendisi, `..` ile çıkış, önek benzerliği (`agents-evil`),
 * Windows'ta başka sürücü ve UNC reddedilir; Windows'ta harf farkı aynı yol sayılır.
 */
function resolveInside(base, target, pathMod = path) {
  if (typeof base !== 'string' || typeof target !== 'string' || !base || !target) return null;
  if (base.includes('\0') || target.includes('\0')) return null;
  if (!pathMod.isAbsolute(base) || !pathMod.isAbsolute(target)) return null;
  const t = pathMod.resolve(target);
  // path.win32.relative sürücü/klasör adlarını harf duyarsız karşılaştırır; başka sürücü/UNC mutlak döner.
  const rel = pathMod.relative(pathMod.resolve(base), t);
  if (!rel || pathMod.isAbsolute(rel)) return null;
  if (rel === '..' || rel.startsWith(`..${pathMod.sep}`)) return null;
  return t;
}

/** Ajan kimliği hafıza klasörü adıyla BİREBİR aynıysa kimliği, değilse null döner (bkz. başlık 1). */
function memoryKey(agentId) {
  if (typeof agentId !== 'string') return null;
  // İlk karakter harf/rakam: '.', '..', '-x' buradan geçemez.
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(agentId)) return null;
  return agentMemory.safeSlug(agentId) === agentId ? agentId : null;
}

function lstatOrNull(p) {
  try { return fs.lstatSync(p); } catch { return null; }
}

/** Hafıza kökü gerçek bir dizin mi (bağlantı değil)? Bağlantıysa hiçbir hafıza klasörü seçilmez. */
function agentsRootOf(workspaceRoot) {
  const sample = agentMemory.agentMemoryDir(workspaceRoot, 'x');
  if (!sample) return null;
  const root = path.dirname(sample);
  const st = lstatOrNull(root);
  if (!st || !st.isDirectory() || st.isSymbolicLink()) return null;
  const memRoot = path.dirname(root);
  const mst = lstatOrNull(memRoot);
  if (!mst || mst.isSymbolicLink()) return null;
  return root;
}

function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else n++;
    }
  };
  try { walk(dir); } catch { /* okunamayan klasör: sayı eksik kalır */ }
  return n;
}

function listFiles(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) out.push(...listFiles(dir, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

/**
 * Takımın bu makinedeki yerel verisi. Hiçbir şey yazmaz.
 * @returns {{memory:{agentId:string,dir:string,files:number}[], skipped:{agentId:unknown,reason:string}[],
 *            reports:{dir:string,file:string,full:string,agentId:string}[], reportCount:number}}
 */
function planLocal({ workspaceRoot, reportDirs = [], agentIds = [], roster = [] }) {
  const memory = [];
  const skipped = [];
  const ids = [];
  for (const raw of agentIds) {
    const key = memoryKey(raw);
    if (!key) { skipped.push({ agentId: raw, reason: 'kimlik' }); continue; }
    ids.push(key);
  }
  const agentsRoot = workspaceRoot ? agentsRootOf(workspaceRoot) : null;
  if (agentsRoot) {
    for (const id of ids) {
      const dir = resolveInside(agentsRoot, path.join(agentsRoot, id));
      if (!dir || path.dirname(dir) !== agentsRoot) { skipped.push({ agentId: id, reason: 'yol' }); continue; }
      const st = lstatOrNull(dir);
      if (!st) continue;
      if (st.isSymbolicLink()) { skipped.push({ agentId: id, reason: 'symlink' }); continue; }
      if (!st.isDirectory()) continue;
      memory.push({ agentId: id, dir, files: countFiles(dir) });
    }
  }

  const team = new Set(ids);
  const reports = [];
  let reportCount = 0;
  const seenDirs = new Set();
  for (const d of reportDirs) {
    if (typeof d !== 'string' || !path.isAbsolute(d)) continue;
    const dir = path.resolve(d);
    if (seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name); } catch { continue; }
    const set = new Set(names);
    for (const name of names) {
      if (!/\.md$/i.test(name)) continue;
      const who = resolveReportAgent(name, roster).agentId;
      if (!who || !team.has(who)) continue;
      reportCount++;
      const base = name.replace(/\.md$/i, '');
      for (const f of [name, `${base}.html`]) {
        if (!set.has(f)) continue;
        const full = resolveInside(dir, path.join(dir, f));
        if (full) reports.push({ dir, file: f, full, agentId: who });
      }
    }
  }
  return { memory, skipped, reports, reportCount };
}

function dayStamp(now) {
  return (now instanceof Date ? now : new Date()).toISOString().slice(0, 10);
}

function fileSlug(s) {
  const v = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return v || 'takim';
}

/**
 * Seçilenleri uygular. `memory` true → hafıza klasörleri silinir; `reports` 'archive' | 'delete' | 'keep'.
 * Hiçbir zaman throw etmez: dosya başına hata `errors`a düşer (sunucu tarafı zaten tamamlanmıştır,
 * yarım kalan yerel iş makbuzda görünür).
 */
function applyLocal({ workspaceRoot, reportDirs = [], agentIds = [], roster = [], memory = false, reports = 'keep', teamSlug = '', now }) {
  const plan = planLocal({ workspaceRoot, reportDirs, agentIds, roster });
  const out = {
    memory: { removed: [], skipped: plan.skipped.slice(), files: 0 },
    reports: { archived: 0, deleted: 0, dest: [], files: 0 },
    errors: [],
  };
  if (memory) {
    const agentsRoot = workspaceRoot ? agentsRootOf(workspaceRoot) : null;
    for (const m of plan.memory) {
      // Planla uygulama arasında klasör bağlantıya çevrilmiş olabilir: yeniden ölç.
      const dir = agentsRoot && resolveInside(agentsRoot, m.dir);
      const st = dir && lstatOrNull(dir);
      if (!dir || !st || st.isSymbolicLink() || !st.isDirectory() || path.dirname(dir) !== agentsRoot) {
        out.memory.skipped.push({ agentId: m.agentId, reason: st && st.isSymbolicLink() ? 'symlink' : 'yol' });
        continue;
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        out.memory.removed.push(m.agentId);
        out.memory.files += m.files;
      } catch (e) {
        out.errors.push(`hafıza ${m.agentId}: ${e.message}`);
      }
    }
  }
  if (reports === 'archive' || reports === 'delete') {
    const sub = `takim-${fileSlug(teamSlug)}-${dayStamp(now)}`;
    const md = new Set();
    for (const r of plan.reports) {
      const src = resolveInside(r.dir, r.full);
      const st = src && lstatOrNull(src);
      if (!src || !st || !st.isFile()) continue;
      try {
        if (reports === 'delete') {
          fs.unlinkSync(src);
        } else {
          const destDir = resolveInside(r.dir, path.join(r.dir, ARCHIVE_DIR, sub));
          const dest = destDir && resolveInside(destDir, path.join(destDir, r.file));
          if (!dest) { out.errors.push(`rapor ${r.file}: hedef yol`); continue; }
          fs.mkdirSync(destDir, { recursive: true });
          if (fs.existsSync(dest)) { out.errors.push(`rapor ${r.file}: arşivde aynı adlı dosya var`); continue; }
          fs.renameSync(src, dest);
          if (!out.reports.dest.includes(destDir)) out.reports.dest.push(destDir);
        }
        out.reports.files++;
        if (/\.md$/i.test(r.file)) md.add(r.full);
      } catch (e) {
        out.errors.push(`rapor ${r.file}: ${e.message}`);
      }
    }
    if (reports === 'delete') out.reports.deleted = md.size;
    else out.reports.archived = md.size;
  }
  return out;
}

/**
 * Yedek zip: `gorevler.json` (renderer'ın verdiği görev satırları) + seçilen hafıza klasörleri +
 * seçilen raporlar + BENIOKU.txt. `outDir` içine `<takım>-yedek-<gün>[-N].zip` yazar; var olanı ezmez.
 * Yarım zip diskte bırakılmaz.
 */
async function writeBackup({ workspaceRoot, reportDirs = [], agentIds = [], roster = [], include = {}, tasks = [], team = {}, outDir, now }) {
  if (typeof outDir !== 'string' || !path.isAbsolute(outDir)) throw new Error('yedek klasörü mutlak yol olmalı');
  fs.mkdirSync(outDir, { recursive: true });
  const stem = `${fileSlug(team.slug || team.name)}-yedek-${dayStamp(now)}`;
  let zipPath = path.join(outDir, `${stem}.zip`);
  for (let n = 2; fs.existsSync(zipPath); n++) zipPath = path.join(outDir, `${stem}-${n}.zip`);
  if (!resolveInside(outDir, zipPath)) throw new Error('yedek yolu klasörün dışında');

  const plan = planLocal({ workspaceRoot, reportDirs, agentIds, roster });
  const counts = { tasks: Array.isArray(tasks) ? tasks.length : 0, memoryFiles: 0, reports: 0 };
  const archiver = require('archiver');
  try {
    const output = createWriteStream(zipPath, { flags: 'wx' });
    const archive = archiver('zip', { zlib: { level: 9 } });
    await new Promise((resolve, reject) => {
      output.on('close', resolve);
      output.on('error', reject);
      archive.on('error', reject);
      archive.pipe(output);
      archive.append(JSON.stringify({ team, tasks: Array.isArray(tasks) ? tasks : [] }, null, 2), { name: 'gorevler.json' });
      if (include.memory) {
        for (const m of plan.memory) {
          for (const rel of listFiles(m.dir)) {
            const full = resolveInside(m.dir, path.join(m.dir, rel));
            if (!full) continue;
            archive.file(full, { name: `hafiza/${m.agentId}/${rel.split(path.sep).join('/')}` });
            counts.memoryFiles++;
          }
        }
      }
      if (include.reports) {
        for (const r of plan.reports) {
          const proj = path.basename(path.dirname(path.dirname(r.dir))) || 'raporlar';
          archive.file(r.full, { name: `raporlar/${proj}/${r.file}` });
          if (/\.md$/i.test(r.file)) counts.reports++;
        }
      }
      archive.append(
        [
          `${team.name || 'Takım'} takımının yedeği (${dayStamp(now)}).`,
          'gorevler.json: takımın görevleri (başlık, açıklama, durum, sprint, proje).',
          'hafiza/: çalışanların hafıza notları (her ajan bir klasör).',
          'raporlar/: çalışanların sonuç raporları (proje klasörüyle).',
          '',
        ].join('\n'),
        { name: 'BENIOKU.txt' },
      );
      archive.finalize();
    });
    return { path: zipPath, bytes: fs.statSync(zipPath).size, counts };
  } catch (e) {
    try { fs.rmSync(zipPath, { force: true }); } catch { /* best-effort */ }
    throw e;
  }
}

module.exports = { resolveInside, memoryKey, planLocal, applyLocal, writeBackup, ARCHIVE_DIR };
