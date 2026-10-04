// CrewPane — ADP-243 (ADR-014 Karar 5) memory graph provider.
//
// Scans the file-based memory (ADP-235) and returns a node-link graph for the in-app
// "Hafıza" (Memory) view: one NODE per fact file, one EDGE per `[[link]]`. Read-only,
// main-side (the renderer is sandboxed) — exposed over IPC (`memory:graph`) + preload.
// Scopes scanned:
//   • per-agent  <workspace>/.crewpane/memory/agents/<id>/*.md   (scope=<id>)
//   • shared     <workspace>/.crewpane/memory/shared/*.md        (scope="shared")
//   • global     ~/.crewpane[-dev]/memory/*.md                    (scope="global")
// MEMORY.md itself is the index, not a fact → skipped as a node. Pure-ish: node builtins
// + agentMemory seams; `workspaceRoot`/`homedir` injectable for tests. Never throws (a
// missing dir just contributes nothing) so the view degrades to an empty graph, not an error.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const agentMemory = require('./agentMemory.cjs');

const KNOWN_TYPES = ['project', 'feedback', 'reference', 'user'];

/**
 * KABUL-FIX-01 (DT-10) — `metadata.always: true` = BU KAYIT HER PANE'E GİRER.
 *
 * Neden gerekti (ÖLÇÜLDÜ, docs/agent-results/KABUL-FIX-01-*): spawn çekirdeği
 * (memoryTargeting.behavioralCore) kayıtları KAPSAM YAKINLIĞINA göre sıralıyordu
 * (own > global > shared) ve ilk 3'te kesiyordu. Her ajanın en az 3 own/global
 * davranışsal kaydı olduğu için TAKIM (`shared`) kapsamı çekirdeğe yapısal olarak
 * HİÇ giremiyordu — 39 ajanın 39'unda. Eren'in "yük testi YASAK" kuralı orada
 * yaşıyor, yani kural hiçbir pane'e ulaşmıyordu.
 *
 * Bayrak KAYDIN KENDİ DURUMUDUR (kimlik değil): aynı kod her ajanda aynı kaydı
 * sabitler, ajan adına özel dal yoktur. Sayısı `CORE_DEFAULTS.maxAlways` ile
 * SINIRLIDIR — "her şeyi sabitle" çekirdeği doldurmaya dönüşemesin.
 */
/** Parse a fact file's frontmatter (name/description/type/always) + its [[link]] slugs. Pure. */
function parseFact(raw) {
  const name = (raw.match(/^name:\s*(.+)$/m) || [])[1];
  const description = (raw.match(/^description:\s*(.+)$/m) || [])[1] || '';
  // metadata.type — a line "  type: X" (NOT "node_type: X")
  const typeM = raw.match(/^[ \t]+type:\s*(\w+)/m);
  const type = typeM && KNOWN_TYPES.includes(typeM[1]) ? typeM[1] : 'reference';
  // metadata.always — girintili "  always: true". Yalnız AÇIKÇA `true` yazılırsa
  // sabitlenir; yazılmayan/bozuk değer `false` (sessizce ayrıcalık verilmez).
  const always = /^[ \t]+always:\s*true\s*$/m.test(raw);
  const links = [...raw.matchAll(/\[\[([a-z0-9._-]+)\]\]/g)].map((m) => m[1]);
  return { name: (name || '').trim(), description: description.trim(), type, always, links };
}

/** List *.md fact files (excluding MEMORY.md) in a dir. [] when the dir is absent. */
function listFactFiles(dir) {
  if (!dir) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((f) => f.endsWith('.md') && f !== agentMemory.INDEX_FILE);
}

/** Collect nodes+edges from one dir at a given scope. Mutates nodes[]/edges[]/bySlug. */
function collectDir(dir, scope, acc) {
  for (const f of listFactFiles(dir)) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    const slug = f.replace(/\.md$/, '');
    if (acc.bySlug.has(slug)) continue; // first scope wins (agent > shared > global order)
    const meta = parseFact(raw);
    acc.bySlug.set(slug, true);
    acc.nodes.push({
      slug,
      name: meta.name || slug,
      type: meta.type,
      scope,
      desc: meta.description.slice(0, 140),
      links: meta.links,
    });
  }
}

/**
 * Build the memory graph for a workspace. Returns { nodes, edges, scopes, counts }.
 * nodes: {slug,name,type,scope,desc}. edges: {from,to} (slug→slug), only when BOTH ends
 * are real nodes (dangling [[link]]s are dropped). `counts` is per-type totals for the legend.
 */
function buildMemoryGraph({ workspaceRoot, homedir } = {}) {
  const acc = { nodes: [], edges: [], bySlug: new Map() };
  // agents first (identity memory), then shared, then global — first scope wins on slug clash.
  const memRoot = agentMemory.workspaceMemoryRoot(workspaceRoot);
  if (memRoot) {
    const agentsDir = path.join(memRoot, 'agents');
    let agentDirs = [];
    try {
      agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      /* no agents yet */
    }
    for (const a of agentDirs) collectDir(path.join(agentsDir, a), a, acc);
    collectDir(agentMemory.sharedMemoryDir(workspaceRoot), 'shared', acc);
  }
  collectDir(agentMemory.globalMemoryDir(homedir), 'global', acc);

  // edges: resolve [[link]] slugs to existing nodes only
  const present = new Set(acc.nodes.map((n) => n.slug));
  for (const n of acc.nodes) {
    for (const to of n.links || []) {
      if (to !== n.slug && present.has(to)) acc.edges.push({ from: n.slug, to });
    }
    delete n.links; // don't ship the raw link list to the renderer
  }
  // de-dup edges (undirected)
  const seen = new Set();
  acc.edges = acc.edges.filter((e) => {
    const k = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const counts = {};
  for (const n of acc.nodes) counts[n.type] = (counts[n.type] || 0) + 1;
  const scopes = {};
  for (const n of acc.nodes) scopes[n.scope] = (scopes[n.scope] || 0) + 1;
  // MEM-01 — BOŞ GRAFİN GEREKÇESİ. Eskiden boş grafik tek bir cümleye çıkıyordu
  // ("Henüz hafıza yok — ajanlar çalıştıkça yazacak"), yani ÜÇ ayrı durum aynı
  // görünüyordu: (a) her şey yolunda, henüz kimse yazmadı · (b) çalışma alanı hiç
  // seçilmemiş → yazılacak bir yer YOK · (c) dizin var ama YAZILAMIYOR (izin/kilit).
  // (b) ve (c) bir VAAT değil bir ARIZADIR; ekran onları "henüz yok" diye anlatınca
  // ödeyen müşteri ürünün ana vaadini haftalarca çalışıyor sanıyor. `health` bu
  // kararı grafiğin yanında taşır (aynı IPC, ek kanal yok).
  // `create:false` — bu yol SALT OKUNUR kalır (Hafıza sekmesini açmak kullanıcının
  // çalışma alanına dizin AÇMAZ); yalnız "açılabilir miydi?" ölçülür.
  const health = agentMemory.checkMemoryWritable(workspaceRoot, { create: false });
  return { nodes: acc.nodes, edges: acc.edges, counts, scopes, health };
}

// ADP-277 (ADR-015) — read ONE fact file's full body by (scope, slug). The single
// read seam both "tek yüzey" (show a fact's content next to the graph) and the
// human-approved promotion dialog need — a graph node only carries a 140-char desc.
// scope = an agent id | 'shared' | 'global' (the same scope strings graph nodes carry).
// Path-safe: slug goes through agentMemory.safeSlug (no traversal) and the resolved
// file must stay inside the scope dir; MEMORY.md (the index) is never served as a fact.
// Returns { slug, scope, name, description, type, body } or null (missing/invalid).
const FACT_MAX_BYTES = 64 * 1024; // defensive cap — fact files are small by discipline

function readFact({ workspaceRoot, homedir, scope, slug } = {}) {
  const s = typeof scope === 'string' ? scope.trim() : '';
  const cleanSlug = agentMemory.safeSlug(slug);
  if (!s || !cleanSlug || cleanSlug === 'unknown') return null;
  let dir = null;
  if (s === 'global') dir = agentMemory.globalMemoryDir(homedir);
  else if (s === 'shared') dir = agentMemory.sharedMemoryDir(workspaceRoot);
  else dir = agentMemory.agentMemoryDir(workspaceRoot, s);
  if (!dir) return null;
  // The index is not a fact. Case-insensitive compare: macOS's default APFS is
  // case-insensitive, so reading "memory.md" would otherwise open MEMORY.md.
  if (`${cleanSlug}.md` === agentMemory.INDEX_FILE.toLowerCase()) return null;
  const file = path.join(dir, `${cleanSlug}.md`);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  if (raw.length > FACT_MAX_BYTES) raw = raw.slice(0, FACT_MAX_BYTES);
  const meta = parseFact(raw);
  return {
    slug: cleanSlug,
    scope: s,
    name: meta.name || cleanSlug,
    description: meta.description,
    type: meta.type,
    body: raw,
  };
}

module.exports = { buildMemoryGraph, parseFact, listFactFiles, readFact, KNOWN_TYPES, FACT_MAX_BYTES };
