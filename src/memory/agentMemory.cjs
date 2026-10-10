// CrewPane — ADP-235 (ADR-014 Karar 2) agent memory storage.
//
// File-based, human-inspectable memory following Claude Code's proven auto-memory
// pattern (a concise MEMORY.md INDEX loaded at spawn + one-fact-per-file topic files
// read on demand). Three scopes:
//   • per-agent  <workspace>/.crewpane/memory/agents/<agentId>/  — an agent's OWN memory
//   • shared     <workspace>/.crewpane/memory/shared/            — team/project memory
//   • global     ~/.crewpane[-dev]/memory/                        — user-level, all workspaces
//
// RESTART-RECALL (the core need): relaunch agent "wheeljack" → its
// agents/wheeljack/MEMORY.md is read back and injected at spawn (ADP-237), so it
// recalls who it is and its past work. Backend-agnostic: claude uses the native
// memory tool (ADP-236) mapped onto agentMemoryDir(); codex uses file injection
// (ADP-239) against the SAME dirs.
//
// Only the first INDEX_MAX_LINES / INDEX_MAX_BYTES of an index is injected (Claude
// Code parity), keeping the always-loaded budget small; topic files stay on-demand.
// Pure-ish: node builtins only, `homedir`/`workspaceRoot` seams for tests, no Electron.
// (The ~/.crewpane name migrates to ~/.crewpane under ADP-244; kept via instancePaths.)

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const instancePaths = require('../config/instancePaths.cjs');
// ADP-874 (790 K1 · ADR-W10 Kural 2) — HAFIZA YAZIMI DA PLATFORM BOĞAZINDAN GEÇER.
// ADP-835 `atomicWrite`ı kurdu ve 26 rename çağrısını oraya taşıdı, ama hafıza
// yazma yolu (ürünün EN ÇOK yazan yüzeyi: her ajan her turda yazabiliyor) hiç
// taşınmamıştı — düz `writeFileSync` hedefin ÜZERİNE yazar, yani süreç yazımın
// ortasında ölürse (Windows'ta Defender'ın dosyayı kilitlemesi + kullanıcının
// uygulamayı kapatması) geriye YARIM bir hafıza dosyası kalır. `atomicWriteFileSync`
// tmp'ye yazıp rename eder ve win32'de rename'i yeniden dener.
// darwin DAVRANIŞI: tek atış rename, hata AYNEN fırlatılır → gözlemlenebilir fark yok.
const { atomicWriteFileSync } = require('../../platform/atomicWrite.cjs');
// SYNC-F1-4 — İNDEKS ARTIK TÜRETİLİR (docs/design/SYNC-F1-TASARIM.md §3.3-§3.4).
// `memoryIndexDerive` bu modülü REQUIRE ETMEZ (döngü yok): tek yön buradan oraya.
const memoryIndexDerive = require('./memoryIndexDerive.cjs');

const WORKSPACE_MEMORY_SUBPATH = Object.freeze(['.crewpane', 'memory']);
const INDEX_FILE = 'MEMORY.md';
const INDEX_MAX_BYTES = 25 * 1024; // Claude Code parity: first 25KB of the index loads at startup
const INDEX_MAX_LINES = 200; // …or 200 lines, whichever comes first

/** Safe dir/file slug for an agent id or fact name (defensive: no path traversal). */
function safeSlug(id) {
  const s = typeof id === 'string' ? id.trim().toLowerCase() : '';
  return s.replace(/[^a-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^[.-]+|[.-]+$/g, '') || 'unknown';
}

/** Global (user-level) memory dir: ~/.crewpane[-dev]/memory (instance-scoped). */
function globalMemoryDir(homedir) {
  return path.join(instancePaths.crewpaneHome(homedir), 'memory');
}

/** Workspace memory root: <workspaceRoot>/.crewpane/memory. Null when no workspaceRoot. */
function workspaceMemoryRoot(workspaceRoot) {
  if (typeof workspaceRoot !== 'string' || !workspaceRoot) return null;
  return path.join(workspaceRoot, ...WORKSPACE_MEMORY_SUBPATH);
}

/** Shared (team) memory dir. Null when no workspaceRoot. */
function sharedMemoryDir(workspaceRoot) {
  const root = workspaceMemoryRoot(workspaceRoot);
  return root ? path.join(root, 'shared') : null;
}

/** Per-agent memory dir (identity-scoped). Null when no workspaceRoot. */
function agentMemoryDir(workspaceRoot, agentId) {
  const root = workspaceMemoryRoot(workspaceRoot);
  return root ? path.join(root, 'agents', safeSlug(agentId)) : null;
}

/** Ensure a memory dir exists with a MEMORY.md index header. Returns the index path. */
function ensureMemoryScaffold(dir, title, deps = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const idx = path.join(dir, INDEX_FILE);
  if (!fs.existsSync(idx)) {
    atomicWriteFileSync(
      idx,
      `# ${title || 'Memory Index'}\n\n` +
        `<!-- Bir satır per hafıza: - [Başlık](dosya.md) — kısa kanca. İçerik ayrı dosyada. -->\n`,
      { encoding: 'utf8', ...deps },
    );
  }
  return idx;
}

/** Cap raw index text to the first INDEX_MAX_LINES lines / INDEX_MAX_BYTES bytes. Pure. */
function capIndex(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.length > INDEX_MAX_BYTES ? raw.slice(0, INDEX_MAX_BYTES) : raw;
  const lines = s.split('\n');
  if (lines.length > INDEX_MAX_LINES) s = lines.slice(0, INDEX_MAX_LINES).join('\n');
  return s;
}

/** Read a dir's MEMORY.md index (capped, Claude Code parity). '' when absent. */
function readIndex(dir) {
  if (!dir) return '';
  try {
    return capIndex(fs.readFileSync(path.join(dir, INDEX_FILE), 'utf8'));
  } catch {
    return '';
  }
}

/** Compose one fact file (frontmatter + body). Pure. Returns { slug, content }. */
function composeFact({ name, description, type, body, supersededBy, validUntil } = {}) {
  const slug = safeSlug(name);
  const lines = [
    '---',
    `name: ${slug}`,
    `description: ${String(description || '').replace(/\s+/g, ' ').trim()}`,
  ];
  if (supersededBy) {
    lines.push(`supersededBy: ${safeSlug(supersededBy)}`);
  }
  if (validUntil) {
    lines.push(`validUntil: ${typeof validUntil === 'number' ? validUntil : String(validUntil).trim()}`);
  }
  lines.push('metadata:');
  lines.push(`  type: ${type || 'reference'}`);
  lines.push('  version: 1');
  lines.push('---');
  lines.push('');
  lines.push(String(body || '').trim());
  lines.push('');
  return { slug, content: lines.join('\n') };
}

/**
 * Bir kapsamın MEMORY.md indeksini fact dosyalarından TÜRET (slug'a göre idempotent).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SYNC-F1-4 — APPEND → TÜRETME GÖÇÜ (imza AYNEN korundu, çağıranlar kırılmaz)
 * ═══════════════════════════════════════════════════════════════════════════
 * ESKİ DAVRANIŞ: slug indekste yoksa TEK satır `appendFileSync`. Gerekçesi (ADP-874)
 * doğruydu ama TEK MAKİNE içindi: "oku → tamamını yeniden yaz" deseni, iki ajan aynı
 * anda pointer eklediğinde birinin satırını sessizce yutar. İKİ MAKİNEDE append
 * yarışının çözümü YOK — `shared/MEMORY.md` (360 KB) her ajanın her yazımında
 * dokunduğu TEK dosya, yani senkronun tek gerçek çakışma yüzeyi (SYNC-R1 §1.2).
 *
 * YENİ DAVRANIŞ: indeks fact frontmatter'ından türetilir. Türetme KÜMEYİ sahiplenir,
 * METNİ değil — var olan her pointer satırı BAYT BAYT korunur; yalnız fact'i olmayan
 * pointer düşer, pointer'ı olmayan fact eklenir, kopya slug tekilleşir.
 * Yarış kaybı da artık KALICI DEĞİL: yutulan bir pointer bir sonraki türetmede fact
 * dosyasından yeniden doğar (fact dosyası tek gerçektir).
 *
 * 🔴 AÇIK KALAN SINIR (dürüstçe): aynı anda eklenen bir SERBEST satır (pointer
 * olmayan not) hâlâ yutulabilir — o satırın arkasında yeniden üretilebileceği bir
 * fact dosyası yoktur. Ölçülen serbest satır sayısı 296/1.776.
 *
 * GERİ DÖNÜŞ: `CREWPANE_MEMORY_INDEX_LEGACY=1` → eski append davranışı.
 */
function addIndexPointer(dir, { name, hook, slug } = {}, deps = {}) {
  const idx = ensureMemoryScaffold(dir, undefined, deps);
  const s = slug || safeSlug(name);
  const fsx = deps.fs || fs;

  // Türetme yalnız DİSKTEKİ fact'lerden satır üretebilir. Çağıran ortada bir fact
  // dosyası yokken "şu pointer'ı ekle" diyorsa (writeFact dışı bir yol) türetme onu
  // ÜRETEMEZ; o durumda eski append korunur — yoksa çağıranın istediği satır
  // sessizce hiç yazılmazdı.
  const factExists = (() => {
    try {
      return fsx.existsSync(path.join(dir, `${s}.md`));
    } catch {
      return false;
    }
  })();

  if (!factExists || process.env.CREWPANE_MEMORY_INDEX_LEGACY === '1') return legacyAppendPointer(idx, s, name, hook);

  memoryIndexDerive.deriveScope(dir, {
    write: true,
    fs: fsx,
    // İnsan başlığı ÇAĞIRANDA: frontmatter `name:` alanı slug'dur (composeFact).
    // Yalnız YENİ satırın metnini belirler; var olan satır zaten korunur.
    titleHints: { [s]: name || s },
    hookHints: { [s]: hook || '' },
    writeAtomic: (file, text, o) => atomicWriteFileSync(file, text, { ...o, ...deps }),
  });
}

/** SYNC-F1-4 öncesi davranış — kill-switch ve fact'siz çağrı için korunur. */
function legacyAppendPointer(idx, s, name, hook) {
  let cur = '';
  try {
    cur = fs.readFileSync(idx, 'utf8');
  } catch {
    /* fresh (scaffold just made it) */
  }
  const esc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`\\(${esc}\\.md\\)`).test(cur)) return; // already indexed
  const line = `- [${name}](${s}.md) — ${String(hook || '').replace(/\s+/g, ' ').trim()}`;
  fs.appendFileSync(idx, (cur.endsWith('\n') ? '' : '\n') + line + '\n', 'utf8');
}

/** Write a fact file into a memory dir + add its index pointer. Returns the fact path. */
function writeFact(dir, fact, deps = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const { slug, content } = composeFact(fact);
  const file = path.join(dir, `${slug}.md`);
  // ADP-874 — atomik: yarım yazılmış bir hafıza dosyası, olmayan hafızadan kötüdür
  // (ajan onu okuyup KESİK bir gerçeği doğru sanır). win32'de rename yeniden denenir.
  atomicWriteFileSync(file, content, { encoding: 'utf8', ...deps });
  addIndexPointer(dir, { name: fact && fact.name, hook: (fact && (fact.hook || fact.description)) || '', slug }, deps);
  return file;
}

// MEM-01 — HAFIZA YAZILABİLİR Mİ? (sessiz başarısızlığın panzehiri)
//
// Bugüne kadar hafıza yazımının ÖNÜNDEKİ engeller (kök seçilmemiş · dizin
// oluşturulamıyor · disk salt-okunur/izin yok) hiçbir yerde İSİMLENDİRİLMİYORDU:
// harita "Henüz hafıza yok" diyordu, oysa doğru cümle "yazamıyorum" olmalıydı.
// Bu fonksiyon o kararı TEK yerde verir; hem spawn (agentRunner) hem harita
// (memoryGraph) aynı gerekçe kodunu okur → ekranda ve log'da aynı gerçek.
//
// GERÇEKTEN YAZARAK ölçer (statSync/W_OK Windows'ta yalan söyler: ACL/Defender
// kilidi yalnız gerçek yazımda görünür). Sonda dosyası her koşulda silinir.
// ASLA fırlatmaz — çağıran bir karar objesi alır, istisna değil.
const WRITE_PROBE_FILE = '.write-probe';

/**
 * `create:false` (harita/okuma yolu) hafıza kökünü OLUŞTURMAZ: henüz yoksa, var olan
 * EN DERİN üst dizine sonda atar — "burada bir hafıza kökü açılabilir mi?" sorusunun
 * yan etkisiz karşılığı. `create:true` (spawn yolu) kökü gerçekten açar, çünkü ajana
 * birazdan o yolu göstereceğiz.
 * @returns {{ok:boolean, reason:'ok'|'no_workspace'|'not_writable', root:string|null, detail:string|null}}
 */
function checkMemoryWritable(workspaceRoot, opts = {}) {
  const fsx = opts.fs || fs;
  const create = opts.create !== false;
  const root = workspaceMemoryRoot(workspaceRoot);
  if (!root) return { ok: false, reason: 'no_workspace', root: null, detail: null };
  let target = root;
  if (!create) {
    // var olan en derin üst dizini bul (kök yoksa yukarı yürü); hiçbiri yoksa `not_writable`
    while (target && !fsx.existsSync(target)) {
      const up = path.dirname(target);
      if (!up || up === target) return { ok: false, reason: 'not_writable', root, detail: 'üst dizin yok' };
      target = up;
    }
  }
  const probe = path.join(target, WRITE_PROBE_FILE);
  try {
    if (create) fsx.mkdirSync(root, { recursive: true });
    fsx.writeFileSync(probe, 'ok', 'utf8');
    return { ok: true, reason: 'ok', root, detail: null };
  } catch (err) {
    return { ok: false, reason: 'not_writable', root, detail: (err && err.message) || String(err) };
  } finally {
    try {
      fsx.unlinkSync(probe);
    } catch {
      /* sonda zaten yoksa/silinemiyorsa kararı değiştirmez */
    }
  }
}

// ADP-277 (ADR-017 G5, Optimus onaylı) — collectStartupMemory SİLİNDİ: hiçbir çağıranı
// yoktu (ADP-239 codex dosya-enjeksiyon seam'i hiç bağlanmadı; withRecalledMemory'nin
// index-YOLU işaretçisi her iki engine'de de onun yerini aldı). Ölü seam yanıltıcıydı.

module.exports = {
  globalMemoryDir,
  workspaceMemoryRoot,
  sharedMemoryDir,
  agentMemoryDir,
  ensureMemoryScaffold,
  capIndex,
  readIndex,
  composeFact,
  addIndexPointer,
  writeFact,
  deriveIndex: memoryIndexDerive.deriveScope,
  deriveAllIndexes: memoryIndexDerive.deriveAll,
  checkMemoryWritable,
  safeSlug,
  INDEX_MAX_BYTES,
  INDEX_MAX_LINES,
  INDEX_FILE,
  WORKSPACE_MEMORY_SUBPATH,
};
