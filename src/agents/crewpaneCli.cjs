#!/usr/bin/env node
// ENG-06 (SPRINT-ENGINE-03) — CrewPane ARAÇ KÖPRÜSÜ (Tier B omurgası).
//
// SORU: MCP'si olmayan (ya da MCP'si kısıtlı) bir motorun pane'i CrewPane'in araç
// yüzeyine nasıl erişir? ENG-R3 §12 üç kademe tanımladı:
//   Tier A — native MCP (claude `--mcp-config`, codex `-c mcp_servers.*`)
//   Tier B — **CLI köprüsü**: motorun SHELL aracı varsa tek bir komut yeter  ← burası
//   Tier C — dosya-düşürme protokolü (senkron cevap yok) → şimdilik YAPILMIYOR
//
// Bu dosya Tier B'nin TEK dağıtım birimidir:
//     node <unpacked>/crewpaneCli.cjs <grup> <eylem> [--bayrak değer]
// stdout'a TEK bir JSON nesnesi basar (senkron sözleşme), insan-okur satırlar stderr'e.
//
// ── NEDEN "ÇAĞIRAN" BİR KÖPRÜ, "YENİDEN YAZAN" DEĞİL ────────────────────────────
// Board yazma yolu (PostgREST + kimlik + schema + merge geçişleri) `crewpane-task-mcp.cjs`
// içinde YAŞIYOR ve orada ölçülmüş. Buraya ikinci bir kopya yazmak "geçerli görev nedir"
// sorusunun İKİ farklı cevabını üretirdi (mergePolicy'nin kendi başlığındaki ders). Bu
// yüzden köprü, MCP araçlarının FİİLLERİNİ çağırır; kendi ürettiği tek şey argüman
// ayrıştırma + JSON sözleşmesi + çıkış kodudur.
//
// ── DEĞİŞMEZ GÜVENLİK KURALI: JETON ARGV'DE OLMAZ ──────────────────────────────
// Köprü hiçbir sırrı argümandan OKUMAZ. Bridge kimliği yalnız pane env'inden gelir
// (`CREWPANE_BRIDGE_TOKEN`/`CREWPANE_BRIDGE_TOKEN` → agentRunner spawn env'i) ve o
// okuma da delegate MCP'nin ADP-286 damgalı keşfinden miras alınır. Sebep: argv `ps`
// çıktısında, shell geçmişinde ve motorun KENDİ transkriptinde görünür — yani jetonu
// argv'ye koymak onu ajanın konuşmasına yazmakla eşdeğerdir. Bu kural bir yorum değil,
// KAPI: sır-benzeri her bayrak adı (token/secret/key/password) reddedilir (bkz.
// SECRETISH_FLAG) ve crewpaneCli.test.cjs bunu hem davranışta hem kaynakta ölçer.
//
// ── ÇIKIŞ KODLARI ──────────────────────────────────────────────────────────────
//   0 — koştu ve sonuç üretti (boş sonuç da dürüst bir sonuçtur)
//   1 — işlem BAŞARISIZ (board reddetti, ağ yok, doğrulama hatası)
//   2 — ÖLÇEMEDİM / kullanım hatası (bilinmeyen komut, eksik argüman, indeks yok)
// "sonuç yok" ile "ölçemedim"i ayırmak memoryRecallCli'ın kanıtlı sözleşmesidir; köprü
// onu tüm gruplara yayar.
//
// ── GENİŞLEME (ENG-11) ─────────────────────────────────────────────────────────
// `browser|delegate|integrations|skill` grupları BU GÖREVDE YOK. İskelet onları S
// yapacak şekilde kurgulandı: GROUPS kaydına bir giriş + bir `run` fiili. O güne kadar
// PLANNED tablosu SESSİZ KALMAZ — "bilinmeyen komut" yerine "henüz yok (ENG-11)" der.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ── argüman ayrıştırma ────────────────────────────────────────────────────────

// Sır-benzeri bayrak adları. Köprü bunları DESTEKLEMEZ; birisi (ya da bir ajan)
// `--token …` yazmayı denerse sessizce yok saymak yerine yüksek sesle reddederiz —
// sessiz yok sayma, "jetonu argv'de geçirdim ve çalıştı" yanılsaması üretirdi.
const SECRETISH_FLAG = /(token|secret|password|passwd|apikey|api-key|_key|^key$)/i;

// 🪤 ÖLÇÜLDÜ (bu dosyanın ilk testinde): değer ALMAYAN bayraklar BEYAN EDİLMEZSE
// ayrıştırıcı `--text "konu"` yazımında SORGUYU yutar (`text='konu'`, pozisyonel boş) →
// `memory recall --text "ansi"` sessizce "sorgu boş" der. Bu yüzden boolean bayraklar
// kapalı bir listedir; geri kalan her bayrak bir sonraki jetonu değer olarak alır.
const BOOLEAN_FLAGS = new Set(['json', 'text', 'help', 'h']);

/**
 * `--ad değer`, `--ad=değer`, `--bayrak` (boolean) ve pozisyoneller.
 * Dönüş: { group, action, positional, flags, error }
 * Bilinmeyen BİÇİM (tek tireli kısa bayrak vs.) hata değildir — pozisyonel sayılmaz,
 * bilinmeyen bayrak olarak raporlanır; komut yüzeyi dar kalsın.
 */
function parseArgv(argv) {
  const flags = Object.create(null);
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i]);
    if (a === '--') {
      positional.push(...argv.slice(i + 1).map(String));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = (eq >= 0 ? a.slice(2, eq) : a.slice(2)).trim();
      if (!name) return { error: `geçersiz bayrak: "${a}"` };
      if (SECRETISH_FLAG.test(name)) {
        return {
          error:
            `"--${name}" kabul edilmez — köprü hiçbir sırrı argümandan okumaz. ` +
            'Bridge kimliği YALNIZ pane env\'inden gelir (CREWPANE_BRIDGE_TOKEN); ' +
            'argv `ps` çıktısında ve motorun transkriptinde görünür.',
        };
      }
      if (eq >= 0) flags[name] = a.slice(eq + 1);
      else if (BOOLEAN_FLAGS.has(name)) flags[name] = true;
      else if (i + 1 < argv.length && !String(argv[i + 1]).startsWith('--')) flags[name] = String(argv[++i]);
      else flags[name] = true;
      continue;
    }
    if (a.startsWith('-') && a.length > 1 && a !== '-') return { error: `bilinmeyen bayrak: "${a}" (yalnız --uzun-ad desteklenir)` };
    positional.push(a);
  }
  return { group: positional[0] || '', action: positional[1] || '', positional: positional.slice(2), flags };
}

/** `--merge-state` → `merge_state` (board alan adları snake_case). */
function flagKey(name) {
  return name.replace(/-/g, '_');
}

/**
 * Bilinen bayrakları board argümanlarına çevirir; TANINMAYAN bayrak HATADIR.
 * Sessizce yok saymak, yazım hatası yapan ajana "yaptım" demek olurdu (board'da
 * filtre uygulanmamış bir liste, atanmamış bir görev…).
 */
function collectFlags(flags, allowed, common) {
  const out = {};
  const unknown = [];
  for (const [name, value] of Object.entries(flags)) {
    const key = flagKey(name);
    if (common.includes(key)) continue;
    if (!allowed.includes(key)) {
      unknown.push(`--${name}`);
      continue;
    }
    out[key] = value === true ? '' : value;
  }
  return { args: out, unknown };
}

const COMMON_FLAGS = ['json', 'text', 'help', 'h'];

// ── memory recall (ADP-862'nin çekirdeği — buraya TAŞINDI) ────────────────────
//
// `memoryRecallCli.cjs` artık bu fiilin GERİYE-UYUM ALIAS'IdIR (çıktısı ve çıkış
// kodları birebir korunur; kanıt: ENG-06 raporu §2 diff'i). Mantığın iki kopyası
// olmasın diye tek yön seçildi: alias → köprü.

/**
 * Workspace kökü: açık argüman → uygulamanın env'i → cwd'den YUKARI doğru
 * `.crewpane/memory` arayışı. Üçüncüsü, ajan pane'i alt bir repoda (crewpane/)
 * koştuğu için gerekli: hafıza kökü ÜST dizindedir.
 */
function resolveWorkspace(explicit, deps = {}) {
  if (explicit) return explicit;
  const env = process.env.CREWPANE_WORKSPACE_ROOT;
  if (env) return env;
  // 🪤 ÖLÇÜLDÜ: bir ajan `crewpane/` içinde koşar ve O DİZİNDE DE `.crewpane/memory`
  // vardır → ilk eşleşmeyi almak YANLIŞ (indekssiz) kökü seçiyor ve komut "indeks
  // kurulu değil" diyor. Bu yüzden yukarı doğru TÜM adaylar toplanır ve indeksi
  // GERÇEKTEN kurulu olan tercih edilir; hiçbirinde yoksa en yakın aday döner
  // (hata mesajı o zaman doğru yolu gösterir).
  const hasIndex = deps.hasIndex || ((root) => {
    try {
      const { indexDbPath } = require('../memory/memoryIndexService.cjs');
      return fs.existsSync(indexDbPath({ workspaceRoot: root }));
    } catch {
      return false;
    }
  });
  const candidates = [];
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, '.crewpane', 'memory'))) candidates.push(dir);
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  if (!candidates.length) return null;
  return candidates.find(hasIndex) || candidates[0];
}

/**
 * İndeksi arama için aç. FTS5'in GERÇEKTEN çalıştığı gerçek bir sorguyla ölçülür —
 * `hasLexIndex` bu ortamda YANLIŞ-POZİTİF verir (bkz. memoryLexicalScan.cjs başlığı).
 */
function openIndex({ workspaceRoot }) {
  const { indexDbPath } = require('../memory/memoryIndexService.cjs');
  const store = require('../memory/memoryIndexStore.cjs');
  const scan = require('../memory/memoryLexicalScan.cjs');
  const file = indexDbPath({ workspaceRoot });
  const opened = store.openIndexForSearch({ file });
  if (!opened) return { db: null, file, fts: false };
  let fts = scan.ftsUsable(opened.db);
  if (fts) {
    try {
      store.ensureLexIndex(opened.db);
    } catch {
      fts = false; // geri-doldurma yapılamadıysa taramaya düş
    }
  }
  return { db: opened.db, file, fts };
}

/**
 * Hafıza araması. Dönüş: { ok:true, res } | { ok:false, unmeasurable:true, reason }
 * `reason` ÖLÇEMEDİM önekini TAŞIMAZ — o öneki basan taraf (alias ya da köprü) karar
 * verir; böylece aynı cümle iki farklı sözleşmede (metin/JSON) kullanılabilir.
 *
 * NEDEN CLI'DA YALNIZ KELİME KATMANI: anlam katmanı 543 MB'lık bge-m3'ü yüklüyor;
 * ilk yükleme ONLARCA saniye (ADP-870 §4c). Bir CLI çağrısında bunu ödemek "hızlı bak"
 * davranışını yok ederdi → kelime katmanı (FTS5/BM25, ~5 ms) + çıktıda `degraded` BEYANI.
 */
async function memoryRecall({ query, k = 5, workspace = null } = {}) {
  const q = String(query == null ? '' : query).trim();
  if (!q) return { ok: false, unmeasurable: true, reason: 'sorgu boş — aranacak bir konu verin.' };

  const workspaceRoot = resolveWorkspace(workspace);
  if (!workspaceRoot) {
    return { ok: false, unmeasurable: true, reason: 'workspace kökü bulunamadı (.crewpane/memory yok) — --workspace ile verin.' };
  }

  let db = null;
  let dbFile = null;
  let fts = false;
  try {
    const opened = openIndex({ workspaceRoot });
    db = opened.db;
    dbFile = opened.file;
    fts = opened.fts;
  } catch (err) {
    return { ok: false, unmeasurable: true, reason: `indeks açılamadı (${err.message})` };
  }
  if (!db) {
    return {
      ok: false,
      unmeasurable: true,
      reason: `arama indeksi kurulu değil (${dbFile}). Uygulamada Hafıza sekmesinden indekslemeyi başlatın.`,
    };
  }

  const { recall } = require('../memory/memoryRecall.cjs');
  const hybrid = require('../memory/memoryHybrid.cjs');
  const res = await recall({
    workspaceRoot,
    query: q,
    k,
    search: ({ query: text, k: kk }) => {
      if (fts) {
        const out = hybrid.searchHybrid(db, { queryText: text, queryVec: null, k: kk });
        return { ok: true, results: out.results, degraded: true, reason: 'cli_lexical_only' };
      }
      // FTS5 yok → saf JS BM25 taraması. ALAKA TABANI burada da uygulanır: anlam
      // katmanı olmadığı için tek kanıtımız "sorguda korpusta geçen AYIRT EDİCİ bir
      // tam terim var mı"dır. Yoksa BM25 her sorguya bir cevap üretir ("nasıl",
      // "var" gibi sık kelimelerden) — istenen dürüstlüğün tam tersi.
      const scan = require('../memory/memoryLexicalScan.cjs');
      const rows = scan.readChunkRows(db);
      if (!scan.hasExactTermEvidenceScan(rows, text)) {
        return { ok: true, results: [], degraded: true, reason: 'cli_scan_below_floor' };
      }
      return { ok: true, results: scan.scanLexical(rows, text, kk), degraded: true, reason: 'cli_scan_lexical_only' };
    },
  });
  return { ok: true, res };
}

/**
 * İnsan-okur hafıza çıktısı. memoryRecallCli'ın BUGÜNKÜ iki console.log'unun birebir
 * karşılığı (`res.text` + koşullu degrade dipnotu) — alias'ın bayt-eş çıktısı buna bağlı.
 */
function renderRecallText(res) {
  const tail = res && res.found && res.degraded
    ? '\n\n(yalnız kelime katmanı — anlam katmanı CLI\'da koşmaz; uygulama içi arama daha güçlüdür)'
    : '';
  return `${res && res.text != null ? res.text : ''}${tail}`;
}

// ── task grubu (board) ────────────────────────────────────────────────────────
//
// Arka uç `crewpane-task-mcp.cjs`in TA KENDİSİ: aynı PostgREST yolu, aynı kimlik
// (bridge `GET /app-db/token`, alamazsa anon → task MCP'nin ölçülmüş düşüşü, sebep
// stderr'e yazılır), aynı sprint normalizasyonu, aynı merge geçiş kuralları.

const TASK_ACTIONS = {
  list: {
    fn: 'runList',
    flags: ['status', 'sprint', 'project', 'assignee', 'limit'],
    usage: 'task list [--status …] [--sprint …] [--project …] [--assignee …] [--limit N]',
  },
  create: {
    fn: 'runCreate',
    flags: ['title', 'description', 'assignee', 'project', 'sprint', 'status', 'priority'],
    usage: 'task create --title "…" [--description …] [--assignee …] [--project …] [--sprint …] [--status …] [--priority N]',
  },
  update: {
    fn: 'runUpdate',
    flags: ['id', 'status', 'assignee', 'title', 'description', 'sprint', 'project', 'priority', 'merge_state', 'branch'],
    usage: 'task update --id TASK-… [--status …] [--assignee …] [--title …] [--description …] [--sprint …] [--merge-state …] [--branch task/…]',
  },
  project: {
    fn: 'runCreateProject',
    flags: ['name', 'slug', 'description'],
    usage: 'task project --name "…" [--slug …] [--description …]',
  },
  sprint: {
    fn: 'runCreateSprint',
    flags: ['name', 'slug', 'description', 'status'],
    usage: 'task sprint --name "…" [--slug …] [--description …] [--status …]',
  },
};

/** MCP araç sonucunu ({content:[{text}], isError}) köprü sözleşmesine çevirir. */
function fromToolResult(result) {
  const text = ((result && result.content) || [])
    .map((c) => (c && typeof c.text === 'string' ? c.text : ''))
    .join('\n')
    .trim();
  if (result && result.isError) return { ok: false, code: 1, error: text || 'araç hata döndürdü' };
  // `text` HEM data'da HEM üst düzeyde: JSON tüketicisi `data.text` okur, `--text`
  // modundaki insan/ajan ise düz listeyi görür (yoksa --text JSON basardı — ölçüldü).
  return { ok: true, data: { text }, text };
}

async function runTask(action, flags, deps = {}) {
  const spec = TASK_ACTIONS[action];
  if (!spec) {
    return {
      ok: false,
      code: 2,
      error: `bilinmeyen task eylemi: "${action || '(yok)'}" — şunlardan biri: ${Object.keys(TASK_ACTIONS).join(', ')}`,
    };
  }
  const { args, unknown } = collectFlags(flags, spec.flags, COMMON_FLAGS);
  if (unknown.length) {
    return { ok: false, code: 2, error: `bilinmeyen bayrak: ${unknown.join(', ')} — kullanım: ${spec.usage}` };
  }
  const mcp = deps.taskMcp || require('../mcp/crewpane-task-mcp.cjs');
  const fn = mcp[spec.fn];
  if (typeof fn !== 'function') return { ok: false, code: 2, error: `board arka ucu "${spec.fn}" fiilini sunmuyor` };
  return fromToolResult(await fn(args));
}

// ── browser grubu (ENG-11 · ENG-R3 §8.2) ──────────────────────────────────────
//
// Arka uç `crewpane-browser-mcp.cjs`in KENDİ fiili (`runBrowser`): aynı köprü
// (POST /browser), aynı atıf (kimlik pane env'inden), aynı 130sn onay penceresi.
//
// 🔑 ONAY KAPISI BURADA DEĞİL, KÖPRÜDE: `click`/`type` kararı main tarafında
// `browserGate.decide` ile verilir ve gerekirse kullanıcıya kart çıkar (ADR-026).
// Köprü fiili çağrıldığı için CLI yolu o kapıyı ATLAYAMAZ — bu bir yorum değil,
// yapısal bir sonuç: karar HTTP ucunun arkasında yaşıyor. (eng11BrowserCli.test.cjs
// bunu gerçek köprüye karşı ölçer: CLI'dan gelen tıklama onay kartı çıkarır.)
const BROWSER_ACTIONS = Object.freeze(['navigate', 'read', 'readPage', 'click', 'type', 'screenshot']);

async function runBrowserGroup(action, parsed, deps = {}) {
  if (!BROWSER_ACTIONS.includes(action)) {
    return {
      ok: false,
      code: 2,
      error: `bilinmeyen browser eylemi: "${action || '(yok)'}" — şunlardan biri: ${BROWSER_ACTIONS.join(', ')}`,
    };
  }
  // 🪤 `--text` BU KÖPRÜDE ÇIKTI BİÇİMİ bayrağıdır (COMMON_FLAGS, boolean). Yazılacak
  // METİN için `--value` kullanılır; yoksa `type --text "merhaba"` sessizce "insan-okur
  // çıktı" isteğine dönüşür ve yazılacak metin KAYBOLURDU (ölçüldü — memory recall'daki
  // aynı tuzağın kardeşi). Çakışma sessizce çözülmez: aşağıda AÇIKÇA anlatılır.
  const { args, unknown } = collectFlags(parsed.flags, ['url', 'selector', 'value'], COMMON_FLAGS);
  if (unknown.length) {
    return {
      ok: false,
      code: 2,
      error:
        `bilinmeyen bayrak: ${unknown.join(', ')} — kullanım: `
        + 'browser navigate --url … | read --selector … | readPage | click --selector … | type --selector … --value "…" | screenshot',
    };
  }
  // Pozisyonel kolaylık: `browser navigate example.com` = `--url example.com`.
  const positional = parsed.positional.join(' ').trim();
  if (positional && !args.url && (action === 'navigate')) args.url = positional;
  if (positional && !args.selector && (action === 'read' || action === 'click')) args.selector = positional;
  if (positional && !args.value && action === 'type') args.value = positional;

  if (action === 'navigate' && !args.url) return { ok: false, code: 2, error: 'browser navigate --url <adres> gerekir' };
  if ((action === 'click' || action === 'type' || action === 'read') && !args.selector) {
    return { ok: false, code: 2, error: `browser ${action} --selector <css> gerekir` };
  }
  if (action === 'type' && !args.value) {
    return {
      ok: false,
      code: 2,
      error:
        'browser type --value "<metin>" gerekir — dikkat: `--text` bu köprüde ÇIKTI BİÇİMİ '
        + 'bayrağıdır (JSON yerine insan-okur), yazılacak metin DEĞİL.',
    };
  }

  const mcp = deps.browserMcp || require('../mcp/crewpane-browser-mcp.cjs');
  if (typeof mcp.runBrowser !== 'function') return { ok: false, code: 2, error: 'tarayıcı arka ucu bu sürümde yok' };
  // Köprü sözleşmesinde alan adı `text`tir (MCP ile birebir aynı payload).
  const payload = { action };
  if (args.url) payload.url = args.url;
  if (args.selector) payload.selector = args.selector;
  if (args.value !== undefined) payload.text = args.value;
  const res = fromToolResult(await mcp.runBrowser(payload));
  // Kullanıcı REDDİ bir hata değil bir KARARDIR: çıkış kodu 1 (işlem başarısız) ama
  // metin bunu açıkça söyler — ajan "köprü bozuk" sanıp tekrar tekrar denemesin.
  return res;
}

// ── integrations grubu (BR-01 köprüsünün CLI yüzü) ────────────────────────────
async function runIntegrationsGroup(action, parsed, deps = {}) {
  if (action !== 'status') {
    return { ok: false, code: 2, error: `bilinmeyen integrations eylemi: "${action || '(yok)'}" — yalnız: status` };
  }
  const { args, unknown } = collectFlags(parsed.flags, ['service'], COMMON_FLAGS);
  if (unknown.length) {
    return { ok: false, code: 2, error: `bilinmeyen bayrak: ${unknown.join(', ')} — kullanım: integrations status [--service sentry]` };
  }
  const service = args.service || parsed.positional.join(' ').trim();
  const mcp = deps.integrationsMcp || require('../mcp/crewpane-integrations-mcp.cjs');
  if (typeof mcp.runIntegrations !== 'function') return { ok: false, code: 2, error: 'entegrasyon arka ucu bu sürümde yok' };
  return fromToolResult(await mcp.runIntegrations(service ? { service } : {}));
}

// ── skill grubu (ENG-R3 §7.3 — native skill dizini OLMAYAN motorun tek yolu) ───
//
// Kayıp DÜRÜSTÇE beyan edilir: native dizinde skill'ler OTOMATİK tetiklenir; burada
// tetiklenmez — ajan `skill list` ile görür, `skill show <ad>` ile GÖVDEYİ bağlamına
// alır. Depo TEK: `.crewpane/skills` (skillStore) — ikinci bir okuyucu yazılmaz.
const SKILL_SCOPES = Object.freeze(['published', 'draft', 'all']);

function skillSummary(d) {
  return { name: d.name, scope: d.scope, description: d.description || '', ok: d.ok !== false, dir: d.dir };
}

async function runSkillGroup(action, parsed, deps = {}) {
  if (action !== 'list' && action !== 'show') {
    return { ok: false, code: 2, error: `bilinmeyen skill eylemi: "${action || '(yok)'}" — şunlardan biri: list, show` };
  }
  const { args, unknown } = collectFlags(parsed.flags, ['scope', 'workspace'], COMMON_FLAGS);
  if (unknown.length) {
    return { ok: false, code: 2, error: `bilinmeyen bayrak: ${unknown.join(', ')} — kullanım: skill list [--scope published|draft|all] · skill show <ad>` };
  }
  const scope = args.scope || (action === 'list' ? 'published' : 'published');
  if (!SKILL_SCOPES.includes(scope)) {
    return { ok: false, code: 2, error: `geçersiz --scope "${scope}" — şunlardan biri: ${SKILL_SCOPES.join(', ')}` };
  }
  const workspaceRoot = resolveWorkspace(args.workspace || null);
  if (!workspaceRoot) {
    return { ok: false, code: 2, error: 'ÖLÇEMEDİM: workspace kökü bulunamadı (.crewpane yok) — --workspace ile verin.' };
  }
  const store = deps.skillStore || require('./skillStore.cjs');

  if (action === 'list') {
    const items = store.listSkills(workspaceRoot, { scope }).map(skillSummary);
    const text = items.length
      ? [
          `${items.length} skill (${scope}):`,
          ...items.map((s) => `  • ${s.name} — ${s.description || '(açıklama yok)'}`),
          '',
          'Gövdeyi bağlamına almak için: skill show <ad>  (bu motorda skill\'ler OTOMATİK tetiklenmez)',
        ].join('\n')
      : `bu workspace'te yayında skill yok (${workspaceRoot}).`;
    return { ok: true, data: { workspaceRoot, scope, skills: items }, text };
  }

  const name = parsed.positional.join(' ').trim();
  if (!name) return { ok: false, code: 2, error: 'skill show <ad> — hangi skill?' };
  const found = scope === 'all'
    ? store.readSkill(workspaceRoot, name, 'published') || store.readSkill(workspaceRoot, name, 'draft')
    : store.readSkill(workspaceRoot, name, scope);
  if (!found || found.exists === false) {
    return { ok: false, code: 1, error: `"${name}" adlı skill bulunamadı (${scope}) — mevcutlar için: skill list` };
  }
  return {
    ok: true,
    data: { ...skillSummary(found), body: found.body || '', file: found.file },
    text: found.text || found.body || '',
  };
}

// ── video grubu (SKL-B1 — düşük-token video araştırması) ──────────────────────
//
// Diğer gruplardan TEK farkı: bu grubun bir "eylemi" yok, bir ARGÜMANI var.
// `video <url>` yazımında ayrıştırıcı URL'i `action` yuvasına koyar (positional[1]);
// bunu eylem sanıp "bilinmeyen eylem" demek kullanıcıya YALAN olurdu.
//
// Makine `videoResearch.cjs`te yaşar; burada yalnız bayrak sözleşmesi var. Ajanın
// bağlamına dönen şey ~300 token'lık ÖZET'tir — ham transcript/kare/ses ASLA.
async function runVideoGroup(action, parsed, deps = {}) {
  const { args, unknown } = collectFlags(parsed.flags, ['depth', 'budget', 'url', 'question'], COMMON_FLAGS);
  if (unknown.length) {
    return {
      ok: false,
      code: 2,
      error: `bilinmeyen bayrak: ${unknown.join(', ')} — kullanım: video <youtube-url> [--depth auto|none|sparse|full] [--budget 60000] [--question "..."]`,
    };
  }
  const url = args.url || (action && !action.startsWith('--') ? action : '') || parsed.positional[0] || '';
  if (!url) {
    return { ok: false, code: 2, error: 'video <youtube-url> — hangi video? (v1 yalnız YouTube)' };
  }
  const research = deps.videoResearch || require('../services/videoResearch.cjs');
  return research.researchVideo(
    { url, depth: args.depth, budget: args.budget, question: args.question },
    deps,
  );
}

// ── grup kaydı ────────────────────────────────────────────────────────────────

const GROUPS = {
  task: {
    summary: 'ofis görev panosu (board)',
    actions: Object.keys(TASK_ACTIONS),
    run: (action, parsed, deps) => runTask(action, parsed.flags, deps),
  },
  memory: {
    summary: 'kalıcı hafıza (recall)',
    actions: ['recall'],
    run: async (action, parsed, deps) => {
      if (action !== 'recall') {
        return { ok: false, code: 2, error: `bilinmeyen memory eylemi: "${action || '(yok)'}" — yalnız: recall` };
      }
      const { args, unknown } = collectFlags(parsed.flags, ['k', 'workspace'], COMMON_FLAGS);
      if (unknown.length) {
        return { ok: false, code: 2, error: `bilinmeyen bayrak: ${unknown.join(', ')} — kullanım: memory recall "<sorgu>" [--k 5] [--workspace <yol>]` };
      }
      const query = parsed.positional.join(' ').trim();
      const recallFn = deps.memoryRecall || memoryRecall;
      const out = await recallFn({ query, k: Number(args.k) || 5, workspace: args.workspace || null });
      if (!out.ok) return { ok: false, code: 2, error: `ÖLÇEMEDİM: ${out.reason}` };
      return { ok: true, data: out.res, text: renderRecallText(out.res) };
    },
  },
  browser: {
    summary: 'görünür dahili tarayıcı (click/type ONAYA takılır)',
    actions: BROWSER_ACTIONS.slice(),
    run: (action, parsed, deps) => runBrowserGroup(action, parsed, deps),
  },
  integrations: {
    summary: 'bağlı dış servisler (Sentry/GitHub/…) — TAHMİN ETME, SOR',
    actions: ['status'],
    run: (action, parsed, deps) => runIntegrationsGroup(action, parsed, deps),
  },
  skill: {
    summary: 'yayındaki skill\'ler (bu motorda otomatik tetiklenmez)',
    actions: ['list', 'show'],
    run: (action, parsed, deps) => runSkillGroup(action, parsed, deps),
  },
  video: {
    summary: 'YouTube videosunu ARAŞTIR — özet ajana, ham medya ASLA (~300 tok)',
    actions: ['<youtube-url>'],
    run: (action, parsed, deps) => runVideoGroup(action, parsed, deps),
  },
};

// Henüz AÇILMAYAN gruplar. "Bilinmeyen komut" demek YANLIŞ olurdu: komut doğru,
// yalnız kablolanmadı — ajanın bunu bilmesi, olmayan bir şeyi denemesinden iyidir.
//
// 🔴 `delegate` BİLİNÇLİ OLARAK AÇILMADI (ENG-11 kararı): bir alt-komut olarak
// açmak, ADR-004'ün "worker alt-delegasyon YAPAMAZ" kuralını her kabuğu olan pane'e
// açık hâle getirirdi. Köprü tarafındaki yetki kapısı (delegationBridge
// `authorizeDelegateCaller`) bu görevde kuruldu; grubu açmak AYRI bir karardır ve
// açılırsa istek `x-crewpane-agent-id`/`-leader-id` başlıklarını (env'den, ARGV'den
// DEĞİL) taşımak zorundadır — yoksa kapının worker tespiti dilsiz kalır.
const PLANNED = {
  delegate: 'bilinçli KAPALI — alt-delegasyon yetkisi köprüde (ENG-11 §8.2); açılırsa kimlik başlıkları ZORUNLU',
};

function usageText() {
  const lines = Object.entries(GROUPS).map(([name, g]) => `  ${name} ${g.actions.join('|')}  — ${g.summary}`);
  const planned = Object.entries(PLANNED).map(([name, why]) => `  ${name} … — henüz yok: ${why}`);
  return [
    'CrewPane araç köprüsü — stdout\'a TEK JSON nesnesi basar ({ok, data|error}).',
    '',
    'Kullanım: node crewpaneCli.cjs <grup> <eylem> [--bayrak değer]',
    '',
    'Gruplar:',
    ...lines,
    '',
    'Planlanan:',
    ...planned,
    '',
    'Ortak bayraklar: --text (JSON yerine insan-okur çıktı) · --json (varsayılan) · --help',
    'Çıkış kodları: 0 koştu · 1 işlem başarısız · 2 ölçemedim/kullanım hatası',
    'Jeton ARGV\'den alınmaz — kimlik yalnız pane env\'inden (CREWPANE_BRIDGE_TOKEN).',
  ].join('\n');
}

/**
 * Tek giriş noktası. Dönüş: { ok, code, data?, text?, error? } — YAZDIRMAZ.
 * (Yazdırmayı `main` yapar; böylece testler süreç kurmadan sözleşmeyi ölçebilir.)
 */
async function runCli(argv, deps = {}) {
  const parsed = parseArgv(argv);
  if (parsed.error) return { ok: false, code: 2, error: parsed.error };
  const wantsHelp = parsed.flags.help || parsed.flags.h || parsed.group === 'help' || !parsed.group;
  if (wantsHelp) return { ok: true, code: 0, data: { usage: usageText() }, text: usageText() };

  const group = GROUPS[parsed.group];
  if (!group) {
    if (PLANNED[parsed.group]) {
      return { ok: false, code: 2, error: `"${parsed.group}" alt-komutu henüz yok — ${PLANNED[parsed.group]}` };
    }
    return { ok: false, code: 2, error: `bilinmeyen grup: "${parsed.group}" — şunlardan biri: ${Object.keys(GROUPS).join(', ')}` };
  }
  const out = await group.run(parsed.action, parsed, deps);
  return { code: out.ok ? 0 : (out.code || 1), ...out };
}

// ── spawn kimliğine giren KEŞİF paragrafı (ENG-07 kablolayacak) ───────────────

/**
 * Köprünün ÇALIŞTIRILABİLİR yolu, yoksa null.
 *
 * 🪤 PAKETTE `__dirname` app.asar'ın İÇİDİR ve harici bir `node` süreci asar'ın
 * içinden dosya çalıştıramaz (asar okuma yaması yalnız Electron'un içinde geçerli).
 * Bu yüzden pakette `app.asar.unpacked` karşılığına bakılır (electron/package.json
 * `asarUnpack`). Bulunmazsa null → keşif paragrafı HİÇ yazılmaz: çalışmayan bir komut
 * vaat etmek, hiç vaat etmemekten kötüdür (`runnableRecallCli` ile aynı kural).
 */
function runnableCliPath(baseDir = __dirname, deps = {}) {
  const exists = deps.exists || fs.existsSync;
  try {
    const local = path.join(baseDir, 'crewpaneCli.cjs');
    if (!local.includes(`app.asar${path.sep}`)) return exists(local) ? local : null;
    const unpacked = local.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    return exists(unpacked) ? unpacked : null;
  } catch {
    return null;
  }
}

/**
 * ENG-11 (ENG-R3 §7.3) — bu motorda skill'ler OTOMATİK tetikleniyor mu?
 * Karar motor ADINDAN değil DEFTERDEN gelir: `skillsDir` yeteneği `null` olan motorda
 * bizim bağladığımız bir skill dizini YOKTUR → keşif ancak CLI ile olur ve bu bir
 * YETENEK DÜŞÜŞÜDÜR, dürüstçe yazılır. Defter okunamazsa (paketleme/kırpma) `null`
 * döner ve cümle HİÇ yazılmaz: yanlış bir yetenek vaadi, sessizlikten kötüdür.
 */
function skillsAutoTrigger(engine, deps = {}) {
  if (!engine) return null;
  try {
    const registry = deps.engineRegistry || require('./engineRegistry.cjs');
    if (!registry.isRegisteredEngine(engine)) return null;
    return registry.capability(engine, 'skillsDir') ? true : false;
  } catch {
    return null;
  }
}

/**
 * MCP'siz motorun kimliğine eklenecek TEK paragraf: "elinde şu komut var".
 * Hafıza için bugün yapılanın (focusedRecallCue) araç yüzeyine genellenmiş hâli.
 * `cliPath` yoksa null döner — çağıran hiçbir şey enjekte etmez.
 * `engine` verilirse skill tetiklenmesi hakkında DÜRÜST bir cümle eklenir (§7.3).
 */
function discoveryParagraph({ cliPath, workspaceRoot, engine } = {}) {
  if (!cliPath) return null;
  const ws = workspaceRoot ? ` --workspace "${workspaceRoot}"` : '';
  const groups = Object.entries(GROUPS).map(([name, g]) => `${name} ${g.actions.join('|')}`).join(' · ');
  return (
    '🧰 ARAÇ KÖPRÜN VAR (bu motorda MCP araçları yok, ama shell'
    + ` var): \`node "${cliPath}" <grup> <eylem>\` komutu CrewPane'in araçlarını açar.`
    + ` Gruplar: ${groups}.`
    + ` Örnek: \`node "${cliPath}" task list --status in_progress\` ·`
    + ` \`node "${cliPath}" memory recall "<konu>"${ws}\`.`
    + ' Komut stdout\'a TEK bir JSON nesnesi basar (`{ok, data|error}`); çıkış kodu 0 koştu,'
    + ' 1 işlem başarısız, 2 ölçemedim. İnsan-okur çıktı için `--text` ekle.'
    + ' Görev durumunu board\'da GÜNCELLE (`task update --id … --status …`) — panoyu sen tutuyorsun.'
    + (skillsAutoTrigger(engine) === false
      ? ' ⚠️ Bu motorda skill\'ler OTOMATİK TETİKLENMEZ (bağlanacak bir skill dizini yok):'
        + ` elindekileri \`node "${cliPath}" skill list\` ile gör, gerekince \`skill show <ad>\` ile AÇ.`
      : '')
  );
}

// ── süreç girişi ──────────────────────────────────────────────────────────────

async function main(argv = process.argv.slice(2)) {
  let out;
  try {
    out = await runCli(argv);
  } catch (err) {
    // Sözleşmeye TEK SATIR girer (ham yığın izi bir cevap değildir); ayrıntı stderr'e
    // düşer — ADP-226 sınıfı "unpack edilmemiş modül" hatasında require yığını teşhisin
    // ta kendisidir ve kaybolmamalı.
    const full = err && err.message ? String(err.message) : String(err);
    out = { ok: false, code: 2, error: `ÖLÇEMEDİM: ${full.split('\n')[0]}` };
    if (full.includes('\n')) console.error(full);
  }
  const asText = out.ok
    ? (out.text != null ? out.text : JSON.stringify(out.data == null ? {} : out.data, null, 2))
    : out.error;
  if (process.env.CREWPANE_CLI_TEXT === '1' || argvHasText(argv)) {
    if (out.ok) console.log(asText);
    else console.error(asText);
  } else {
    const payload = out.ok ? { ok: true, data: out.data == null ? {} : out.data } : { ok: false, error: out.error };
    console.log(JSON.stringify(payload));
    // İnsan-okur satır stderr'e: JSON'u parse etmeyen bir gözle bakan (ajan, log)
    // hatanın NE olduğunu görsün — stdout sözleşmesi bozulmadan.
    if (!out.ok) console.error(out.error);
  }
  process.exitCode = out.code || 0;
}

function argvHasText(argv) {
  return argv.some((a) => a === '--text' || a === '--text=true');
}

module.exports = {
  BOOLEAN_FLAGS,
  parseArgv,
  collectFlags,
  runCli,
  runTask,
  memoryRecall,
  renderRecallText,
  resolveWorkspace,
  openIndex,
  runnableCliPath,
  discoveryParagraph,
  skillsAutoTrigger, // ENG-11 (§7.3) — skill tetiklemesi defterden
  runBrowserGroup,
  runIntegrationsGroup,
  runSkillGroup,
  runVideoGroup,
  BROWSER_ACTIONS,
  SKILL_SCOPES,
  usageText,
  fromToolResult,
  GROUPS,
  PLANNED,
  TASK_ACTIONS,
  SECRETISH_FLAG,
  main,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`ÖLÇEMEDİM: ${err && err.message ? err.message : String(err)}`);
    process.exitCode = 2;
  });
}
