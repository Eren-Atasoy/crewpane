// ADP-364 — MOBİL RAPORLAR: gateway'in okuduğu ajan sonuç raporları (main sürecinde).
//
// TEK GERÇEK: `docs/agent-results/INDEX.md` (ADP-301 üreticisi `scripts/resultsIndex.cjs`).
// Bu modül INDEX.md'yi PARSE eder — dizini elle taramaz (yeni rapor eklendiğinde
// `npm run results:index` INDEX.md'yi tazeler; gateway hep onu okur). Tek rapor içeriği
// için yalnızca INDEX.md'nin İŞARET ETTİĞİ dosya okunur (tarama değil, tek dosya).
//
// /m/office (ADP-334) gibi MAIN'de derlenir → uygulama penceresi kapalıyken de telefon
// raporları görür. Renderer'a/Supabase'e HİÇ sorulmaz: raporlar diskteki dosyalardır.
//
// Kapsam `read`: raporlar salt-okunur veri. Yazma yolu YOK.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_RESULTS_DIR = path.join(__dirname, '..', 'docs', 'agent-results');
const INDEX_NAME = 'INDEX.md';

const LIMIT_DEFAULT = 30;
const LIMIT_MAX = 100;
// Tek sayfa markdown bütçesi: telefon büyük raporu tek seferde çekmesin (ADR-023 K3 —
// hücresel veride tam-dosya kabul edilmez). ~18 KB okunur bir ekran dolusudur.
const PAGE_BYTES = 18 * 1024;
const PAGE_BYTES_MAX = 64 * 1024;

/** INDEX.md tablo hücresini normalize et (kaçışları çöz, boşları '' yap). */
function uncell(s) {
  const t = String(s || '').trim();
  if (!t || t === '—') return '';
  return t.replace(/\\\|/g, '|').trim();
}

/**
 * INDEX.md'nin tablo satırlarını ayrıştır. Kolonlar (ADP-364 sonrası):
 *   Görev ID | Başlık | Ajan | Takım | Sprint | Tarih | Commit | Durum
 * Görev ID hücresi `[ADP-321](ADP-321-wheeljack.md)` → { taskId, file }.
 * Durum hücresi "⚠️ **KANIT YOK**" → hasEvidence:false; aksi halde status metni. Pure.
 */
function parseIndex(indexMd) {
  const rows = [];
  const lines = String(indexMd || '').split('\n');
  for (const line of lines) {
    if (!/^\|/.test(line)) continue;
    // KAÇIŞ FARKINDA böl: `\|` (üretici hücre içi boru işaretini böyle kaçırır) ayraç DEĞİL.
    const cells = line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
    if (cells.length < 8) continue;
    const idCell = cells[0];
    // Başlık ayracını/hizalama satırını atla.
    if (/^Görev ID$/i.test(idCell) || /^:?-{2,}:?$/.test(idCell)) continue;
    const m = /^\[([^\]]+)\]\(([^)]+)\)/.exec(idCell);
    if (!m) continue;
    const taskId = m[1].replace(/\\\|/g, '|').trim();
    let file = m[2].trim();
    try {
      file = decodeURI(file);
    } catch {
      /* zaten çözülmüş */
    }
    const statusCell = cells[7];
    const hasEvidence = !/KANIT YOK/i.test(statusCell);
    rows.push({
      taskId,
      file,
      title: uncell(cells[1]),
      agent: uncell(cells[2]) || null,
      team: uncell(cells[3]) || null,
      sprint: uncell(cells[4]) || null,
      date: uncell(cells[5]) || null,
      commit: uncell(cells[6]) || null,
      status: hasEvidence ? uncell(statusCell) : 'KANIT YOK',
      hasEvidence,
    });
  }
  return rows;
}

function readIndex(resultsDir) {
  try {
    return fs.readFileSync(path.join(resultsDir, INDEX_NAME), 'utf8');
  } catch {
    return '';
  }
}

function trimStr(v, max) {
  const s = String(v == null ? '' : v).trim();
  return s ? s.slice(0, max) : '';
}

/**
 * GET /m/reports — arama + süzgeç + sayfalama. Filtre değerleri gateway'de süzülüp gelir.
 * Facets (teams/agents/sprints) TÜM raporlardan üretilir (yalnız sayfadan değil) → süzgeç
 * menüsü eksiksiz. Sıralama: tarih DESC (INDEX.md zaten öyle sıralı; koruruz).
 */
function listReports(opts = {}) {
  const resultsDir = opts.resultsDir || DEFAULT_RESULTS_DIR;
  const indexMd = opts.indexMd != null ? opts.indexMd : readIndex(resultsDir);
  const all = parseIndex(indexMd);
  const p = opts.params || {};

  const facets = {
    teams: [...new Set(all.map((r) => r.team).filter(Boolean))].sort(),
    agents: [...new Set(all.map((r) => r.agent).filter(Boolean))].sort(),
    sprints: [...new Set(all.map((r) => r.sprint).filter(Boolean))].sort(),
  };

  const q = trimStr(p.q, 80).toLowerCase();
  const team = trimStr(p.team, 40);
  const agent = trimStr(p.agent, 40).toLowerCase();
  const sprint = trimStr(p.sprint, 40);
  // evidence: 'yes' → yalnız kanıtlı, 'no' → yalnız KANIT YOK, '' → hepsi.
  const evidence = trimStr(p.evidence, 4);

  let filtered = all;
  if (q) filtered = filtered.filter((r) => `${r.taskId} ${r.title} ${r.agent || ''}`.toLowerCase().includes(q));
  if (team) filtered = filtered.filter((r) => r.team === team);
  if (agent) filtered = filtered.filter((r) => (r.agent || '').toLowerCase() === agent);
  if (sprint) filtered = filtered.filter((r) => r.sprint === sprint);
  if (evidence === 'yes') filtered = filtered.filter((r) => r.hasEvidence);
  else if (evidence === 'no') filtered = filtered.filter((r) => !r.hasEvidence);

  const total = filtered.length;
  const rawLimit = Number(p.limit);
  const rawOffset = Number(p.offset);
  const limit = Number.isFinite(rawLimit) ? Math.min(LIMIT_MAX, Math.max(1, Math.trunc(rawLimit))) : LIMIT_DEFAULT;
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0;
  const reports = filtered.slice(offset, offset + limit);

  return { reports, total, limit, offset, facets };
}

/** Görev id'sinden güvenli dosya adı? id INDEX.md'de VAR mı diye bakılır (uydurma yol yok). */
function rowForId(all, reportId) {
  const id = String(reportId || '').trim();
  return all.find((r) => r.taskId === id) || null;
}

/**
 * Markdown'ı sayfalara böl — fence FARKINDA: bir ```kod bloğunun ORTASINDAN bölmez
 * (yoksa telefonun render'ı yarım fence görür). Satır bütçesi PAGE_BYTES; bir tek satır
 * bütçeyi aşsa bile o satır kesilmez (kod satırı bölünmez). Pure.
 */
function paginateMarkdown(md, page, pageBytes) {
  const budget = Math.min(PAGE_BYTES_MAX, Math.max(4096, Number(pageBytes) || PAGE_BYTES));
  const lines = String(md || '').split('\n');
  const pages = [];
  let cur = [];
  let curBytes = 0;
  let inFence = false;
  for (const line of lines) {
    const isFence = /^\s*```/.test(line);
    const b = Buffer.byteLength(line, 'utf8') + 1;
    if (curBytes + b > budget && cur.length && !inFence) {
      pages.push(cur.join('\n'));
      cur = [];
      curBytes = 0;
    }
    cur.push(line);
    curBytes += b;
    if (isFence) inFence = !inFence;
  }
  if (cur.length || !pages.length) pages.push(cur.join('\n'));
  const totalPages = pages.length;
  const pg = Number.isFinite(Number(page)) ? Math.min(totalPages - 1, Math.max(0, Math.trunc(Number(page)))) : 0;
  return { markdown: pages[pg] ?? '', page: pg, totalPages };
}

/**
 * GET /m/reports/:reportId — tek raporun içeriği (markdown, sayfalı). INDEX.md'nin işaret
 * ettiği dosya okunur (dizin gezme YOK: reportId INDEX.md'de yoksa null). Büyük dosya
 * sayfalanır; okunamayan dosya null (gateway 404'e çevirir).
 */
function readReport(opts = {}) {
  const resultsDir = opts.resultsDir || DEFAULT_RESULTS_DIR;
  const indexMd = opts.indexMd != null ? opts.indexMd : readIndex(resultsDir);
  const all = parseIndex(indexMd);
  const row = rowForId(all, opts.reportId);
  if (!row) return null;
  // Güvenlik: dosya adı INDEX.md'den gelir ama yine de resultsDir dışına çıkmasın.
  const abs = path.resolve(resultsDir, row.file);
  if (!abs.startsWith(path.resolve(resultsDir) + path.sep)) return null;
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
  const bytes = Buffer.byteLength(raw, 'utf8');
  const { markdown, page, totalPages } = paginateMarkdown(raw, opts.page, opts.pageBytes);
  return {
    ...row,
    markdown,
    page,
    totalPages,
    bytes,
    truncated: totalPages > 1,
  };
}

module.exports = {
  DEFAULT_RESULTS_DIR,
  LIMIT_DEFAULT,
  LIMIT_MAX,
  PAGE_BYTES,
  uncell,
  parseIndex,
  listReports,
  paginateMarkdown,
  readReport,
};
