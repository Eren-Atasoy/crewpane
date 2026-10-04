// MCP-COST-01 — MCP ÇOCUK SÜREÇLERİ: envanter, sahiplik, yetim biçme.
//
// ARIZA (09.09 ölçüldü, 14 pane açık): bağlı 4 entegrasyonun MCP'si HER pane'de
// doğuyor — worker o servise hiç dokunmasa bile ayakta duruyor ve bellek tutuyor.
// Canlı sayım: 97 entegrasyon süreci / 3.187 MB; bunun 48 süreci / 1.779 MB'ı hiçbir
// iş yapmayan `npm exec` SARMALAYICISI (npx her sunucu için bir tane bırakıyor).
//
// 🔴 KARTIN İKİNCİ TEŞHİSİ ÖLÇÜMLE ÇÜRÜDÜ (bkz. MCP-COST-01-wheeljack.md §2):
// "24 kopya ama 11 pane → yetimler var" hükmü bir SAYIM HATASIDIR. Servis başına
// süreç sayısı pane sayısının İKİ KATIDIR çünkü her pane iki süreç doğurur
// (`npm exec <paket>` + gerçek `node .../<bin>`). 24 = 12 pane × 2, yetim değil.
// Bu modül yine de yazıldı: yetimlik ölçülmediği sürece "yok" da bir İDDİADIR,
// ve mekanizma gerçek (pane SIGKILL edilirse claude kapanış yolu hiç koşmaz).
//
// TASARIM — ORPHAN-ELECTRON-01'in ÇEKİRDEĞİ ÇAĞRILIR, YENİDEN YAZILMAZ:
//   • `snapshot`/`treeRootOf` — yetimlik `ppid`'ye DEĞİL ata zincirinin KÖKÜNE bakar
//     (npm sarmalayıcısı tam da bu yüzden araya girer ve `ppid 1` şeklini bozar),
//   • `treeOf` + `reapOrphanElectrons` — TERM → 5 sn → KILL merdiveni tek yerde.
//
// "ÖLÇEMEZSEK DOKUNMA": `ps` okunamazsa liste BOŞ döner ve hiçbir şey öldürülmez.
// Aday kümesi ayrıca BEYAZ LİSTEDİR (aşağıdaki desenler) — deseni tutmayan hiçbir
// süreç biçme yoluna giremez.
//
// Çalıştır: node --test electron/mcpProcess.test.cjs

'use strict';

const orphan = require('../core/orphanElectron.cjs');

/**
 * TANINAN MCP SUNUCULARI — beyaz liste. Bir süreç bu desenlerden birini tutmuyorsa
 * bu modül onu ne sayar ne de biçer. Desen hem `npx`/`npm exec` SARMALAYICISINI hem
 * çözülmüş `node …/.bin/<ad>` biçimini kapsar; ikisi de aynı servise yazılır.
 */
const MCP_SERVERS = [
  { service: 'posthog', kind: 'integration', re: /mcp[.-]posthog\.com|(^|[/\s])mcp-remote(@|\s|$)|[/\\]\.bin[/\\]mcp-remote(\s|$)/ },
  { service: 'sentry', kind: 'integration', re: /@sentry[/\\]mcp-server|[/\\]\.bin[/\\]sentry-mcp(\s|$)/ },
  { service: 'vercel', kind: 'integration', re: /@mistertk[/\\]vercel-mcp|[/\\]\.bin[/\\]vercel-mcp(\s|$)/ },
  { service: 'coolify', kind: 'integration', re: /@masonator[/\\]coolify-mcp|[/\\]\.bin[/\\]coolify-mcp(\s|$)/ },
  { service: 'supabase', kind: 'integration', re: /@supabase[/\\]mcp-server-supabase|[/\\]\.bin[/\\]mcp-server-supabase(\s|$)/ },
  { service: 'github', kind: 'integration', re: /github-mcp-server|@modelcontextprotocol[/\\]server-github/ },
  { service: 'stripe', kind: 'integration', re: /@stripe[/\\]mcp|[/\\]\.bin[/\\]stripe-mcp(\s|$)/ },
  // Ürünün KENDİ MCP'leri — sayılır (görünürlük için) ama entegrasyon değildir.
  { service: 'crewpane-task', kind: 'own', re: /crewpane-task-mcp\.cjs/ },
  { service: 'crewpane-browser', kind: 'own', re: /crewpane-browser-mcp\.cjs/ },
  { service: 'crewpane-integrations', kind: 'own', re: /crewpane-integrations-mcp\.cjs/ },
  // MCP-LAZY-01 — cogullayici vekil. `own` sayilir: entegrasyon DEGIL, urunun kendi
  // sureci. Kendi cocuklari (gercek MCP server'lari) zaten kendi satirlarinda sayilir
  // ve sahiplik zinciri vekilin uzerinden motora ulasir → yetim GORUNMEZLER.
  { service: 'crewpane-mcp-lazy', kind: 'own', re: /mcpLazyProxy\.cjs/ },
  { service: 'crewpane-delegate', kind: 'own', re: /crewpane-delegate-mcp\.cjs/ },
  { service: 'code-index', kind: 'own', re: /codebase-memory-mcp|codebase_memory/ },
];

/** `npm exec …` / `npx …` / `npm-cli.js` — İŞ YAPMAYAN sarmalayıcı süreç. */
const WRAPPER_RE = /^(?:\S*[/\\])?(?:npm|npx)(?:-cli\.js)?\s+(?:exec|x)\s|[/\\]npx-cli\.js(\s|$)|[/\\]npm-cli\.js\s+exec(\s|$)/;

/** Bir pane'in MOTOR süreci (MCP çocuklarının sahibi). Kabuk pane'i MCP açmaz. */
const ENGINE_RE = /(^|[/\\])(claude|codex|opencode|goose|crush|droid|amp|aider)(\s|$)/;

/**
 * KORUMA — kurulu ofisin kendisi asla aday değildir. `orphanElectron.PROTECTED_RE`
 * aynen ödünç alınır: iki modülün "dokunulmaz" tanımı ayrışırsa biri eskir.
 */
const PROTECTED_RE = orphan.PROTECTED_RE;

/**
 * YENİ DOĞANLARI KORU. Bir MCP çocuğu, sahibi motor süreci `execve` ile kendini
 * değiştirirken kısa bir an sahipsiz GÖRÜNEBİLİR. Bu pencereden genç hiçbir süreç
 * biçilmez — yanlış öldürme, sızıntıdan pahalıdır (ADP-246 dersi).
 */
const DEFAULT_MIN_AGE_MS = 60 * 1000;

function classify(command) {
  for (const s of MCP_SERVERS) if (s.re.test(command)) return s;
  return null;
}

/** Sarmalayıcı mı (npm/npx), gerçek sunucu mu? */
function isWrapper(command) {
  return WRAPPER_RE.test(String(command || '').trim());
}

/**
 * Bu sürecin SAHİBİ olan canlı motor pid'i — ata zincirinde yukarı yürüyerek.
 * Bulunamazsa `null` (= yetim adayı). Zincir kökü CrewPane'in kendisi olsa bile
 * araya bir motor girmiyorsa sahipsizdir: MCP'yi doğuran motordur, uygulama değil.
 */
function ownerEnginePid(pid, snap) {
  let cur = snap.get(pid);
  const seen = new Set();
  while (cur && !seen.has(cur.pid)) {
    seen.add(cur.pid);
    if (ENGINE_RE.test(cur.command)) return cur.pid;
    if (PROTECTED_RE.test(cur.command)) return null; // uygulamaya vardık, motor yoktu
    if (cur.ppid <= 1) return null;
    const parent = snap.get(cur.ppid);
    if (!parent) return null; // ata ölmüş → sahipsiz
    cur = parent;
  }
  return null;
}

/** `ps -Ao rss=` ile pid → RSS(KB). Ayrı çağrı: orphanElectron'un formatı rss taşımaz. */
function rssMap(exec) {
  const out = {};
  if (process.platform === 'win32') return out;
  let text = '';
  try {
    text = String(exec('ps -Ao pid=,rss=') || '');
  } catch {
    return out; // ölçemedik → RSS'siz devam (sayım yine doğru)
  }
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) out[Number(m[1])] = Number(m[2]);
  }
  return out;
}

/**
 * LAUNCH-GUARD-01 — ATA ZİNCİRİNİN KÖKÜ KURULU APP OLABİLİR, VE BU SATIR ONU BİÇTİ.
 *
 * ÖLÇÜLDÜ (16.09 18:51): pane'lerin içinden doğan her süreç — MCP'ler dahil —
 * tanımı gereği kurulu app'in ALTINDADIR (pane'leri app doğurur). `treeRootOf`
 * o yüzden `rootPid`i CANLI APP olarak döndürüyordu; satırın kendisi
 * `PROTECTED_RE`den geçmişti ama biçme `rootPid`ten başlıyor →
 * `treeOf(canlı-app)` = bütün ofis. Bu makinede taze ölçüm: 8 MCP satırının
 * 8'inin de `rootPid`i canlı app, `treeOf` = 81 süreç.
 *
 * `listOrphanElectrons` bu tuzağı `rootIsOwn` kapısıyla zaten kapatıyordu
 * (kök bizim değilse SAHİBİ VAR → dokunma); MCP yolunda o kapı YOKTU. Burada
 * aynı kural uygulanır: kök KORUNAN bir süreçse satır (1) kendi pid'ine
 * çapalanır, (2) `protectedBy` ile işaretlenir → `selectReapable` onu ELER.
 */
function rootOf(row, snap) {
  const root = orphan.treeRootOf(row.pid, snap) || row;
  if (root.pid !== row.pid && PROTECTED_RE.test(String(root.command || ''))) {
    return { rootPid: row.pid, protectedBy: 'canli-app-agaci' };
  }
  return { rootPid: root.pid, protectedBy: null };
}

/**
 * TÜM MCP süreçlerinin envanteri. SAF ölçüm — hiçbir şey öldürmez.
 * @returns {{rows:Array, panes:number[]}} `rows`: {pid, ppid, service, kind, wrapper,
 *   rssKb, ageMs, etime, command, ownerPid|null, orphan:boolean}
 */
function listMcpProcesses(opts = {}) {
  const run = opts.exec || defaultExec();
  const snap = orphan.snapshot(run);
  if (!snap) return { rows: [], panes: [] }; // ölçemedik → HİÇBİR ŞEY iddia edilmez
  const rss = rssMap(run);
  const panes = [];
  for (const r of snap.values()) if (ENGINE_RE.test(r.command)) panes.push(r.pid);
  const rows = [];
  for (const r of snap.values()) {
    if (PROTECTED_RE.test(r.command)) continue; // kurulu ofis — aday değil
    const hit = classify(r.command);
    if (!hit) continue;
    const ownerPid = ownerEnginePid(r.pid, snap);
    rows.push({
      pid: r.pid,
      ppid: r.ppid,
      service: hit.service,
      kind: hit.kind,
      wrapper: isWrapper(r.command),
      rssKb: rss[r.pid] || 0,
      ageMs: orphan.etimeToMs(r.etime),
      etime: r.etime,
      command: r.command,
      ownerPid,
      orphan: ownerPid === null,
      ...rootOf(r, snap),
    });
  }
  return { rows, panes: panes.sort((a, b) => a - b) };
}

/**
 * SERVİS BAŞINA ÖZET — Ayarlar'daki "şu an N pane'de açık · ~M MB" satırının verisi.
 * Kullanıcı göremediği şeyi kapatamaz; bu fonksiyon o görünürlüğün tek kaynağıdır.
 * @returns {{services:Object<string,{panes:number,procs:number,wrappers:number,rssMb:number,orphans:number}>,
 *            paneCount:number, totalMb:number, measured:boolean}}
 */
function summarizeByService(opts = {}) {
  const { rows, panes } = listMcpProcesses(opts);
  const services = {};
  for (const r of rows) {
    const s = (services[r.service] ||= { panes: 0, procs: 0, wrappers: 0, rssKb: 0, orphans: 0, _owners: new Set() });
    s.procs += 1;
    if (r.wrapper) s.wrappers += 1;
    s.rssKb += r.rssKb;
    if (r.orphan) s.orphans += 1;
    if (r.ownerPid !== null) s._owners.add(r.ownerPid);
  }
  let totalKb = 0;
  for (const s of Object.values(services)) {
    s.panes = s._owners.size;
    delete s._owners;
    s.rssMb = Math.round(s.rssKb / 1024);
    delete s.rssKb;
    totalKb += s.rssMb * 1024;
  }
  return {
    services,
    paneCount: panes.length,
    totalMb: Math.round(totalKb / 1024),
    measured: rows.length > 0 || panes.length > 0,
  };
}

/**
 * YETİM MCP süreçleri — sahibi motor süreci ÖLMÜŞ olanlar.
 *
 * Üç kapı (hepsi testle kilitli):
 *   1. beyaz liste — tanınmayan hiçbir süreç aday değil,
 *   2. `PROTECTED_RE` — kurulu ofis ASLA,
 *   3. yaş kapısı — `minAgeMs`'ten genç olan korunur (spawn yarışı).
 * `ps` okunamazsa boş liste → biçme de yok.
 */
function listOrphanMcp(opts = {}) {
  const minAgeMs = opts.minAgeMs ?? DEFAULT_MIN_AGE_MS;
  const { rows } = listMcpProcesses(opts);
  return rows
    .filter((r) => r.orphan && r.ageMs >= minAgeMs)
    .map((r) => ({
      pid: r.pid,
      rootPid: r.rootPid,
      service: r.service,
      etime: r.etime,
      cpu: 0,
      ageMs: r.ageMs,
      automated: true,
      // LAUNCH-GUARD-01: kökü canlı app olan satır burada işaretli gelir ve
      // `selectReapable` onu eler (eskiden burada sabit `null` yazıyordu).
      protectedBy: r.protectedBy || null,
      command: r.command,
      rssKb: r.rssKb,
    }));
}

/**
 * Yetimleri kes — ORPHAN-ELECTRON-01'in TERM→bekle→KILL merdivenini ÇAĞIRIR.
 * `olderThanMs` burada 0'dır: yaş kapısı zaten `listOrphanMcp`te uygulandı ve
 * sahibi ölmüş bir MCP'yi 30 dk beklemenin anlamı yok.
 */
function reapOrphanMcp(opts = {}) {
  const rows = opts.rows || listOrphanMcp(opts);
  return orphan.reapOrphanElectrons({ ...opts, rows, olderThanMs: 0 });
}

/**
 * PANE KAPANIŞ YOLU — bu motor pid'inin altındaki MCP ağacını kapat.
 * Normal kapanışta motor kendi MCP çocuklarını zaten indirir; bu, o yolun
 * KOŞMADIĞI hâl içindir (SIGKILL, çökme, quit yarışı). Zaten ölmüşse no-op.
 * @returns {number} sinyal gönderilen süreç sayısı
 */
function killMcpChildrenOf(enginePid, opts = {}) {
  const run = opts.exec || defaultExec();
  const snap = orphan.snapshot(run);
  if (!snap || !Number.isInteger(enginePid)) return 0;
  const signal = opts.signal || defaultSignal();
  const doomed = [];
  for (const r of snap.values()) {
    if (PROTECTED_RE.test(r.command)) continue;
    if (!classify(r.command)) continue;
    if (ownerEnginePid(r.pid, snap) !== enginePid) continue;
    doomed.push(r.pid);
  }
  let hit = 0;
  // En derin önce: sarmalayıcıyı önce öldürmek gerçek sunucuyu yetim bırakır.
  for (const pid of doomed.sort((a, b) => b - a)) if (signal(pid, 'SIGTERM')) hit += 1;
  return hit;
}

function defaultExec() {
  const { execSync } = require('node:child_process');
  return (cmd) => execSync(cmd, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
}

function defaultSignal() {
  return (pid, sig) => {
    try {
      process.kill(pid, sig);
      return true;
    } catch {
      return false;
    }
  };
}

module.exports = {
  MCP_SERVERS,
  WRAPPER_RE,
  ENGINE_RE,
  DEFAULT_MIN_AGE_MS,
  classify,
  isWrapper,
  ownerEnginePid,
  listMcpProcesses,
  summarizeByService,
  rootOf,
  listOrphanMcp,
  reapOrphanMcp,
  killMcpChildrenOf,
};
