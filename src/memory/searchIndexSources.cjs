// CrewPane — SEARCH-2 (bumblebee) İNDEKS KAYNAKLARI.
//
// Her kaynak AYNI belge şeklini döndürür — `searchIndexStore.upsertDoc`in beklediği
// şekil: {type,key,title,path,meta,mtime,size,chunks:[{line,text}]}. Yeni bir kaynak
// eklemek = buraya bir fonksiyon; depo, işçi ve sorgu DEĞİŞMEZ.
//
// ── PARÇALAMA: SATIR NUMARASI KUTSALDIR ────────────────────────────────────
// Bir arama sonucu "hangi rapor" demekle yetinemez, "hangi SATIR" demeli — yoksa
// kullanıcı 17,7 MB'lık bir rapor yığınında elle arar. Parçalayıcı boş satırla
// ayrılmış paragrafları ~900 karaktere kadar birleştirir ve her parçanın BAŞLADIĞI
// satırı taşır (SEARCH-R1 prototipiyle aynı; ölçüm oradan geliyor).
//
// ── GÖREVLER NEDEN BURADA DA VAR ───────────────────────────────────────────
// SEARCH-1 board'daki kartları ZATEN bellekte arıyor (başlık + açıklama, 0-0,4 ms).
// Burada indekslenmelerinin sebebi kapsam değil DAYANIKLILIK: board yüklenmemişken
// (açılışın ilk saniyeleri, çevrimdışı) arama yine cevap verir. Renderer aynı kartı
// iki kez çizmemek için `task:<id>` anahtarıyla tekilleştirir — CANLI satır kazanır.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Parça boyu — transcriptReader ile AYNI (tek bir gramer). */
const MAX_CHUNK = 900;

/** Dizin ağacını gez (node_modules/.git atlanır, derinlik sınırlı). */
function walk(dir, pred, { fsImpl = fs, depth = 0, max = 8, out = [] } = {}) {
  if (depth > max) return out;
  let ents = [];
  try {
    ents = fsImpl.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.git')) continue;
      walk(p, pred, { fsImpl, depth: depth + 1, max, out });
    } else if (pred(p)) out.push(p);
  }
  return out;
}

/**
 * Gövde → parçalar. Saf.
 * Boş satır bir SINIRdır ama her boş satırda kesmez: parça yeterince doluysa keser,
 * değilse boş satırı içeride tutar (tek cümlelik parçalar bm25'i gürültüye boğar).
 */
function chunkBody(body) {
  const lines = String(body || '').split('\n');
  const out = [];
  let buf = [];
  let start = 1;
  let len = 0;
  const flush = () => {
    if (len) out.push({ line: start, text: buf.join('\n') });
    buf = [];
    len = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) {
      if (len > MAX_CHUNK * 0.6) flush();
      else if (len) buf.push('');
      continue;
    }
    if (!len) start = i + 1;
    if (len + l.length > MAX_CHUNK && len) {
      flush();
      start = i + 1;
    }
    if (l.length > MAX_CHUNK) {
      // Tek satır parçadan uzunsa (yapıştırılmış base64, uzun tablo) böl.
      flush();
      for (let j = 0; j < l.length; j += MAX_CHUNK) out.push({ line: i + 1, text: l.slice(j, j + MAX_CHUNK) });
      continue;
    }
    buf.push(l);
    len += l.length + 1;
  }
  flush();
  return out;
}

/** İlk H1 başlığı (yoksa yedek). */
function firstH1(body, fallback) {
  const m = String(body || '').match(/^#\s+(.+)$/m);
  return String(m ? m[1] : fallback).trim().slice(0, 200);
}

/** Basit frontmatter okuyucu (hafıza dosyaları: name/description). */
function frontmatter(body) {
  const m = String(body || '').match(/^---\n([\s\S]*?)\n---/);
  const fm = {};
  if (!m) return fm;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return fm;
}

/**
 * RAPORLAR — `<repo>/docs/agent-results/*.md`.
 * `key` mutlak yol; `path` depoya göreli (raporda mutlak yol durmaz).
 */
function collectReports({ repoRoot, fsImpl = fs } = {}) {
  const dir = path.join(repoRoot, 'docs', 'agent-results');
  let names = [];
  try {
    names = fsImpl.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.md') || name === 'INDEX.md') continue;
    const file = path.join(dir, name);
    let body;
    let st;
    try {
      body = fsImpl.readFileSync(file, 'utf8');
      st = fsImpl.statSync(file);
    } catch {
      continue;
    }
    const agent = (name.match(/-([a-z0-9_]+)\.md$/) || [])[1] || '';
    const taskId = (name.match(/^([A-Z0-9][A-Z0-9-]*?)(?:-[a-z0-9_]+)?\.md$/) || [])[1] || name.replace(/\.md$/, '');
    out.push({
      type: 'report',
      key: file,
      title: firstH1(body, taskId),
      path: path.join('docs', 'agent-results', name),
      meta: { agent, taskId },
      mtime: st.mtimeMs,
      size: st.size,
      chunks: chunkBody(body),
    });
  }
  return out;
}

/**
 * HAFIZA — `<workspace>/.crewpane/memory/**\/*.md`.
 * `scope` = `shared` ya da ajan adı; `@ajan` daraltması buradan çalışır.
 */
function collectMemory({ workspaceRoot, fsImpl = fs } = {}) {
  const root = path.join(workspaceRoot, '.crewpane', 'memory');
  const files = walk(root, (p) => p.endsWith('.md'), { fsImpl });
  const out = [];
  for (const file of files) {
    if (path.basename(file) === 'MEMORY.md') continue; // türetilmiş indeks — kaynak değil
    let body;
    let st;
    try {
      body = fsImpl.readFileSync(file, 'utf8');
      st = fsImpl.statSync(file);
    } catch {
      continue;
    }
    const fm = frontmatter(body);
    const scope = file.includes(`${path.sep}shared${path.sep}`)
      ? 'shared'
      : (file.split(`${path.sep}agents${path.sep}`)[1] || '').split(path.sep)[0] || '';
    out.push({
      type: 'memory',
      key: file,
      title: fm.name || firstH1(body, path.basename(file, '.md')),
      path: path.relative(workspaceRoot, file),
      meta: { scope, description: String(fm.description || '').slice(0, 200), agent: scope },
      mtime: st.mtimeMs,
      size: st.size,
      chunks: chunkBody(body),
    });
  }
  return out;
}

/**
 * GÖREVLER — board anlık görüntüsü (satırlar renderer'dan gelir; bu süreç
 * Supabase'e BAĞLANMAZ — yeni bir ağ yolu icat etmemek kasıtlı).
 */
function collectTasks(rows) {
  const out = [];
  for (const t of rows || []) {
    if (!t || !t.id) continue;
    const body = [t.description || '', t.project || '', t.sprint || ''].filter(Boolean).join('\n');
    out.push({
      type: 'task',
      key: `task:${t.id}`,
      title: String(t.title || t.id).slice(0, 300),
      path: `board/${t.id}`,
      meta: { status: t.status || '', sprint: t.sprint || '', project: t.project || '', agent: t.assigned_agent_id || '' },
      mtime: Date.parse(t.updated_at || t.created_at || '') || 0,
      size: body.length,
      chunks: chunkBody(`${t.id}\n${body}`),
    });
  }
  return out;
}

module.exports = {
  MAX_CHUNK,
  walk,
  chunkBody,
  firstH1,
  frontmatter,
  collectReports,
  collectMemory,
  collectTasks,
};
