// ORPHAN-ELECTRON-01 — YETİM (ebeveynsiz) bare-run Electron envanteri + biçme.
//
// ARIZA (07.09 01:12, Eren canlı yayındayken ölçüldü): worker'ların e2e/proof
// koşuları (`launchApp`, `delegDeliverProbe`, ONNX repro…) bare-run Electron açar;
// worker pane'i ölünce (limit/timeout/undelivered/lider kapatması) Node ebeveyn
// gider ama Electron ağacı `ppid 1`'e düşüp ÇALIŞMAYA DEVAM EDER — canvas/WebGL
// döngüsü CPU yer. 6 yetim × %28-91 CPU → loadavg 133 (14 çekirdek).
//
// Bu modül İKİ tüketicinin TEK çekirdeğidir (kural iki yerde yaşarsa biri eskir):
//   • `scripts/orphanElectron.cjs`  — liderin elle koştuğu CLI (--list / --reap)
//   • main'in `pty:reapOrphanElectrons`'u — süpervizörün terminal-hata yolu
//
// TASARIM İLKESİ — "ölçemezsek DOKUNMA" (reapUndeliveredPanes'in `paneRunning`
// catch'iyle aynı kural): şüpheli her satır KORUNUR. Yanlış öldürme (Eren'in
// açık dev instance'ı) sızıntıdan çok daha pahalıdır — ADP-246 bunu bir kez
// ödedi ("dev sürekli düşüyor").
//
// Çalıştır: node --test electron/orphanElectron.test.cjs

'use strict';

const { execSync } = require('node:child_process');

/**
 * BİÇİLEBİLİR yol: yalnız checkout içindeki `node_modules/electron/dist…`
 * (macOS `dist/Electron.app/…`, Linux `dist/electron`, Windows `dist\electron.exe`;
 * `dist-dev` gibi varyantlar da kapsanır). PAKETLENMİŞ ürün bu yola ASLA düşmez —
 * kurulu `/Applications/CrewPane.app` kendi Frameworks ağacından koşar.
 */
const BARE_RUN_RE = /node_modules[/\\]electron[/\\]dist[^/\\]*[/\\]/;

/**
 * MUTLAK KORUMA — eşleşen satır hiçbir koşulda listeye/biçmeye girmez. `BARE_RUN_RE`
 * bunları zaten dışarıda bırakıyor; bu ikinci kilit KASITLI: kurulu ofisi öldürmek
 * geri alınamaz bir hatadır ve tek bir regex'e güvenilmez (kanıt: adı geçen testler).
 */
const PROTECTED_RE = /(^|[/\\])Applications[/\\]|\.app[/\\]Contents[/\\]MacOS[/\\]CrewPane|CrewPane\.app|Contents[/\\]Frameworks[/\\]/;

/** Chromium YARDIMCI süreçleri (renderer/gpu/utility/zygote) — ana süreç DEĞİL. */
const HELPER_RE = /--type=|chrome_crashpad_handler|crashpad_handler/;

/**
 * NPM SHIM'i: `electron/node_modules/.bin/electron` (= `electron/cli.js`), DÜZ BİR
 * NODE SÜRECİ. Playwright bunu açar, GERÇEK Electron ikilisi onun ÇOCUĞUDUR.
 *
 * 🔴 ÖLÇÜLDÜ (07.09, `e2e/_sigprobe` deseni): worker SIGKILL'le ölünce shim de
 * yetim kalır ve YAŞAMAYA DEVAM EDER → gerçek Electron'un ppid'i 1 DEĞİL, SHIM olur.
 * Kartın "ppid 1 olanları listele" tarifi bu şekli KAÇIRIR. Bu yüzden yetimlik
 * ppid'e değil ATA ZİNCİRİNİN KÖKÜNE bakılarak kararlaştırılır (bkz. treeRootOf).
 */
const SHIM_RE = /node_modules[/\\]\.bin[/\\]electron(\s|$)|node_modules[/\\]electron[/\\]cli\.js/;

/**
 * ADP-246 DERSİ — İNSANIN açık dev/prod instance'ı korunur. Launcher (`npm run
 * electron:dev`) çıkınca Electron launchd'ye reparent olur ve `ppid 1` görünür;
 * ata zinciri yürümek işaretçiyi kaybeder, o yüzden sürecin KENDİ miras aldığı
 * env'ine bakılır (`ps eww`) — env sürecin üstünde yaşar, yetim kalmakla silinmez.
 */
const HUMAN_ENV_RE = /CREWPANE_MODE=(prod|dev)\b|CREWPANE_INSTANCE=(prod|dev)\b|electron:(prod|dev)\b/;

/**
 * OTOMASYON İŞARETİ — `e2e/schemeSafeLaunch.cjs#automatedLaunchEnv()` her
 * `launchApp`/`launchAppExternal` açılışına koyar.
 *
 * 🔴 BU SATIR BİR KUSURU KAPATIR: `scripts/electron-reaper.mjs` (mevcut daemon)
 * yalnız `HUMAN_ENV_RE`ye bakıyor — ama `e2e/electronHelper.cjs` her açılışa
 * `CREWPANE_MODE: 'prod'` yazar, dolayısıyla daemon HER e2e Electron'unu
 * "korunmuş" sayıp hiçbirini biçmez. Yetimlerin daemon'a rağmen birikmesinin
 * sebebi budur. Otomasyon işareti insan işaretini EZER: e2e açılışı tanımı gereği
 * sarf malzemesidir.
 */
const AUTOMATION_ENV_RE = /CREWPANE_E2E=1\b|CREWPANE_APP_PROBE=1\b|CREWPANE_INSTANCE=test\b/;

/**
 * PERF-FLEET-01 — PLAYWRIGHT TARAYICISI (Chrome for Testing / headless shell).
 *
 * 🔴 ÖLÇÜLDÜ (panic-full-2026-09-08-015910, stackshot 702 süreç): makineyi dize
 * getiren TEK EN BÜYÜK kalem buydu — 1 tarayıcı ana süreci + 11 yardımcı = 37,81 GB,
 * yardımcıların beşi tek başına 5,2 / 6,8 / 8,0 / 8,0 / 8,1 GB. Hepsi jetsam
 * coalition 833'te, yani lideri pid 736 = CrewPane olan ağacın içinde.
 *
 * YOL ŞARTI KASITLI DAR: yalnız Playwright'ın indirdiği tarayıcı önbelleği
 * (`~/Library/Caches/ms-playwright/…`, Linux `~/.cache/ms-playwright/…`,
 * Windows `…\ms-playwright\…`). Kullanıcının KENDİ Chrome/Chromium/Opera'sı bu
 * yola ASLA düşmez — koruma regex'e değil DOSYA SİSTEMİ yerleşimine dayanır.
 */
const PLAYWRIGHT_BROWSER_RE = /ms-playwright[/\\][^/\\]*(chromium|firefox|webkit)[^/\\]*[/\\]/i;

const DEFAULT_OLDER_THAN_MS = 30 * 60 * 1000; // kart: --older-than 30m
const DEFAULT_TERM_GRACE_MS = 5000; // kart: önce TERM, 5 sn sonra KILL

/** `ps` alanlarını ayıran tek boşluk-öbeği; `command` daima SON alan (boşluk içerir). */
function parsePsLine(line) {
  const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/.exec(line);
  if (!m) return null;
  return { pid: Number(m[1]), ppid: Number(m[2]), cpu: Number(m[3]), etime: m[4], command: m[5] };
}

/**
 * macOS `ps -o etime=` → `[[DD-]HH:]MM:SS` → ms. (Linux'un `etimes`i macOS'te YOK,
 * o yüzden taşınabilir olan `etime` ayrıştırılır.)
 */
function etimeToMs(etime) {
  if (typeof etime !== 'string' || !etime.trim()) return 0;
  let days = 0;
  let rest = etime.trim();
  if (rest.includes('-')) {
    const [d, r] = rest.split('-');
    days = Number(d) || 0;
    rest = r;
  }
  const parts = rest.split(':').map((n) => Number(n) || 0);
  let sec = 0;
  if (parts.length === 3) sec = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else if (parts.length === 2) sec = parts[0] * 60 + parts[1];
  else sec = parts[0] || 0;
  return (days * 86400 + sec) * 1000;
}

/** `30m` / `5s` / `2h` / `90` (saniye varsayılan) → ms. Geçersiz → null (çağıran ATAR). */
function parseDuration(text) {
  if (typeof text === 'number' && Number.isFinite(text)) return text * 1000;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] || 's';
  const mult = { ms: 1, s: 1000, m: 60000, h: 3600000 }[unit];
  return n * mult;
}

/**
 * Bir sürecin KENDİ env'i (`ps eww`). Ölçülemezse '' döner — çağıran bunu
 * "bilinmiyor" okur ve KORUR (fail-safe: bilinmeyeni öldürme).
 */
function readProcEnv(pid, exec) {
  if (process.platform === 'win32') return '';
  try {
    return String(exec(`ps eww -o command= -p ${pid}`) || '');
  } catch {
    return '';
  }
}

/** ps anlık görüntüsü → pid → {ppid, cpu, etime, command} haritası. */
function snapshot(exec) {
  if (process.platform === 'win32') return null;
  const map = new Map();
  let out = '';
  try {
    out = String(exec('ps -Ao pid=,ppid=,pcpu=,etime=,command=') || '');
  } catch {
    return null; // ölçemedik → çağıran HİÇBİR ŞEY iddia etmez
  }
  for (const line of out.split('\n')) {
    const row = parsePsLine(line);
    if (row) map.set(row.pid, row);
  }
  return map;
}

/**
 * Ata zincirinin KÖKÜ: `ppid === 1` olana kadar yukarı yürü, o süreci döndür.
 * Döngü/kayıp ata durumunda son bilinen düğüm döner (asla sonsuza gitmez).
 */
function treeRootOf(pid, snap) {
  let cur = snap.get(pid);
  const seen = new Set();
  while (cur && cur.ppid !== 1 && !seen.has(cur.pid)) {
    seen.add(cur.pid);
    const parent = snap.get(cur.ppid);
    if (!parent) return cur; // ata ölmüş (görünmez) → bu düğüm fiilen köktür
    cur = parent;
  }
  return cur || null;
}

/**
 * YETİM bare-run Electron ANA süreçleri.
 *
 * YETİMLİK ÖLÇÜTÜ (kartın "ppid 1" tarifinin ÖLÇÜLMÜŞ düzeltmesi): Electron'un
 * ata zincirinin KÖKÜ ya kendisi ya da onun npm SHIM'i olmalı. Kök bunlardan biri
 * değilse (canlı bir kabuk, koşan bir `node …spec.cjs`, npm, tmux…) o Electron'un
 * SAHİBİ VARDIR — koşan bir teste ait olabilir, DOKUNULMAZ.
 *
 * @param {object} [deps]
 * @param {(cmd:string)=>string} [deps.exec] test için enjekte edilir
 * @returns {{pid:number, ppid:number, cpu:number, etime:string, ageMs:number,
 *            command:string, rootPid:number, protectedBy:string|null, automated:boolean}[]}
 */
function listOrphanElectrons({ exec = defaultExec } = {}) {
  const snap = snapshot(exec);
  if (!snap) return []; // ölçemedik → boş liste, biçme de yok
  const rows = [];
  for (const row of snap.values()) {
    if (!BARE_RUN_RE.test(row.command)) continue; // checkout dışı Electron
    if (PROTECTED_RE.test(row.command)) continue; // kurulu ofis — ASLA
    if (HELPER_RE.test(row.command)) continue; // yardımcı süreç, ana değil
    if (SHIM_RE.test(row.command)) continue; // shim kendisi Electron ANA süreci değil
    const root = treeRootOf(row.pid, snap);
    if (!root) continue;
    const rootIsOwn = root.pid === row.pid || SHIM_RE.test(root.command) || BARE_RUN_RE.test(root.command);
    if (!rootIsOwn) continue; // SAHİBİ VAR (canlı koşu / kabuk) → dokunma
    const env = readProcEnv(row.pid, exec);
    const automated = AUTOMATION_ENV_RE.test(env);
    // Otomasyon işareti insan işaretini EZER (bkz. AUTOMATION_ENV_RE).
    const human = !automated && HUMAN_ENV_RE.test(env);
    rows.push({
      ...row,
      ageMs: etimeToMs(row.etime),
      rootPid: root.pid, // biçme KÖKTEN başlar → shim geride kalmaz
      automated,
      protectedBy: human ? 'human-instance' : null,
    });
  }
  return rows.sort((a, b) => b.cpu - a.cpu);
}

/**
 * YETİM Playwright TARAYICILARI. `listOrphanElectrons` ile AYNI çekirdeği kullanır
 * (`snapshot` + `treeRootOf`) — kural iki yerde yaşamasın diye kopya YOK, yalnız
 * eşleşme yolu farklı.
 *
 * YETİMLİK ÖLÇÜTÜ AYNI: ata zincirinin KÖKÜ ya tarayıcının kendisi olacak (koşum
 * öldü, tarayıcı `launchd`'ye devroldu) ya da yine bir Playwright tarayıcısı.
 * Kök CANLI bir `node …spec.cjs` / kabuk / npm ise KOŞUM SÜRÜYOR demektir —
 * DOKUNULMAZ. Bu tam da "ölçemezsek dokunma" kuralının aynısıdır.
 *
 * @returns {{pid:number, ppid:number, cpu:number, etime:string, ageMs:number,
 *            command:string, rootPid:number, protectedBy:null, automated:true,
 *            kind:'playwright-browser'}[]}
 */
function listOrphanBrowsers({ exec = defaultExec, snap: given = null } = {}) {
  const snap = given || snapshot(exec);
  if (!snap) return [];
  const rows = [];
  for (const row of snap.values()) {
    if (!PLAYWRIGHT_BROWSER_RE.test(row.command)) continue; // kullanıcının tarayıcısı DEĞİL
    if (PROTECTED_RE.test(row.command)) continue;
    if (HELPER_RE.test(row.command)) continue; // yardımcı süreç: kökten biçilince zaten gider
    const root = treeRootOf(row.pid, snap);
    if (!root) continue;
    const rootIsOwn = root.pid === row.pid || PLAYWRIGHT_BROWSER_RE.test(root.command);
    if (!rootIsOwn) continue; // koşum yaşıyor → SAHİBİ VAR
    rows.push({
      ...row,
      ageMs: etimeToMs(row.etime),
      rootPid: root.pid,
      automated: true, // Playwright önbelleğinden koşan tarayıcı tanımı gereği sarf malzemesi
      protectedBy: null,
      kind: 'playwright-browser',
    });
  }
  return rows.sort((a, b) => b.cpu - a.cpu);
}

/**
 * FİLONUN TAMAMI: yetim bare-run Electron'lar + yetim Playwright tarayıcıları.
 * TEK `ps` anlık görüntüsü (iki ayrı tarama makineyi iki kez yormasın).
 */
function listOrphanFleet({ exec = defaultExec } = {}) {
  const snap = snapshot(exec);
  if (!snap) return [];
  const electrons = listOrphanElectrons({ exec }).map((r) => ({ kind: 'electron', ...r }));
  return electrons.concat(listOrphanBrowsers({ exec, snap }));
}

/**
 * Biçmenin filo sürümü — `reapOrphanElectrons`ı ÇAĞIRIR (yeniden yazmaz): seçim,
 * TERM→bekle→KILL merdiveni ve ağaç yürüyüşü hepsi orada, tek yerde.
 */
function reapOrphanFleet(opts = {}) {
  const exec = opts.exec || defaultExec;
  const rows = opts.rows || listOrphanFleet({ exec });
  return reapOrphanElectrons({ ...opts, exec, rows });
}

/**
 * Biçilecekleri seç. SAF (süreç dokunmaz) → kural testte doğrudan ölçülür.
 *
 * @param {ReturnType<typeof listOrphanElectrons>} rows
 * @param {{olderThanMs?:number, pids?:number[], selfPid?:number}} opts
 *   `pids` verilirse (süpervizör yolu: alt-görevin spawn anında defterlenen
 *   ağacı) yaş kapısı UYGULANMAZ — sahibi ölmüş, beklemenin anlamı yok.
 */
function selectReapable(rows, opts = {}) {
  const olderThanMs = opts.olderThanMs ?? DEFAULT_OLDER_THAN_MS;
  const only = Array.isArray(opts.pids) && opts.pids.length ? new Set(opts.pids.map(Number)) : null;
  const selfPid = opts.selfPid ?? process.pid;
  return rows.filter((r) => {
    if (r.pid === selfPid) return false;
    if (r.protectedBy) return false; // insanın açık instance'ı — ADP-246
    if (only) return only.has(r.pid);
    return r.ageMs >= olderThanMs;
  });
}

/**
 * Seçilenleri kapat: ÖNCE TERM, `graceMs` sonra hâlâ yaşayana KILL.
 * Ne kapattığını döner — "kapattım" iddiası değil, pid başına ÖLÇÜM.
 */
async function reapOrphanElectrons(opts = {}) {
  const exec = opts.exec || defaultExec;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const graceMs = opts.termGraceMs ?? DEFAULT_TERM_GRACE_MS;
  const rows = opts.rows || listOrphanElectrons({ exec });
  const targets = selectReapable(rows, opts);
  if (!targets.length) return { reaped: [], scanned: rows.length };
  const signal = opts.signal || defaultSignal(exec);
  // Ağacın KÖKÜNDEN biç: yalnız Electron'u öldürmek yetim SHIM'i geride bırakır
  // (ölçüldü — shim yaşarken Electron'un ppid'i 1 değil shim olur).
  for (const t of targets) {
    t.tree = treeOf(t.rootPid ?? t.pid, exec, opts.selfPid ?? process.pid);
    t.termed = t.tree.map((pid) => signal(pid, 'SIGTERM')).some(Boolean);
  }
  if (targets.some((t) => t.termed)) await sleep(graceMs);
  for (const t of targets) {
    // Hâlâ yaşıyor mu? (signal 0 = "var mı" sorusu, sinyal göndermez)
    t.survived = t.tree.some((pid) => signal(pid, 0));
    if (t.survived) t.killed = t.tree.map((pid) => signal(pid, 'SIGKILL')).some(Boolean);
  }
  return {
    scanned: rows.length,
    reaped: targets.map((t) => ({
      pid: t.pid,
      rootPid: t.rootPid ?? t.pid,
      treePids: t.tree,
      etime: t.etime,
      cpu: t.cpu,
      ageMs: t.ageMs,
      automated: t.automated,
      how: t.killed ? 'SIGKILL' : t.termed ? 'SIGTERM' : 'gone',
      command: t.command,
    })),
  };
}

/**
 * Kök pid'in TÜM alt ağacı, en derin önce (tek ps anlık görüntüsü).
 *
 * ── LAUNCH-GUARD-01 · 16.09 18:51 KÖK NEDENİ (ÖLÇÜLDÜ) ──────────────────────
 * launchd kaydı: `application.com.crewpane.crewpane… [23689] exited due to
 * SIGTERM | sent by Electron[81688]` — 81688, bir worker'ın izole worktree'sinden
 * açılmış bare-run Electron'du ve açılışından 5,9 sn sonra (main.js'teki 5000 ms
 * `reapOrphanMcp()` açılış süpürgesi) Eren'in 16 saatlik oturumunu biçti.
 *
 * MEKANİZMA: aday satırlar `PROTECTED_RE`den geçiyordu ama `treeOf` KÖKTEN
 * yürüyor ve **ağacın üyelerini bir daha kontrol etmiyordu**. Bir pane'in içinden
 * doğan süreçlerin ata zinciri tanımı gereği KURULU APP'TE biter (pane'leri o
 * doğurur) → `treeRootOf` canlı app'i "kök" diye döndürdü, `treeOf(canlı-app)`
 * bütün ofisi kapsadı. (Bu makinede ölçüldü: `treeOf(<canlı pid>)` = 81 süreç.)
 *
 * DÜZELTME İKİ SATIR: (a) KORUNAN düğümde DUR — kurulu app ne biçilir ne de
 * ÜZERİNDEN geçilir; (b) `ps` okunamazsa BOŞ liste — doğrulayamadığımız bir kökü
 * biçmek bu arızanın ta kendisiydi ("ölçemezsek DOKUNMA", dosya başlığı).
 */
function treeOf(rootPid, exec, selfPid) {
  const snap = snapshot(exec);
  if (!snap) return []; // (b) ölçemedik → hiçbir sinyal
  const kids = new Map();
  for (const r of snap.values()) {
    if (!kids.has(r.ppid)) kids.set(r.ppid, []);
    kids.get(r.ppid).push(r.pid);
  }
  const order = [];
  const seen = new Set();
  const walk = (p) => {
    if (seen.has(p) || p <= 1 || p === selfPid) return; // launchd ve KENDİMİZ asla
    const row = snap.get(p);
    // (a) KORUNAN DÜĞÜM = MUTLAK DUVAR: kurulu app ne biçilir ne de üzerinden geçilir.
    if (row && PROTECTED_RE.test(row.command)) return;
    seen.add(p);
    order.push(p);
    // Anlık görüntüde OLMAYAN bir pid (ölmüş ya da yarış): sinyal zaten ESRCH olur,
    // ama ÇOCUKLARINI göremediğimiz için ağaçta AŞAĞI İNMEYİZ — göremediğimiz bir
    // alt ağacı biçmek tam olarak bu kartın arızasıdır.
    if (!row) return;
    for (const c of kids.get(p) || []) walk(c);
  };
  walk(rootPid);
  return order.reverse();
}

function defaultExec(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
}

/** `process.kill` sarmalayıcısı → true = sinyal ulaştı / süreç var. */
function defaultSignal() {
  return (pid, sig) => {
    try {
      process.kill(pid, sig);
      return true;
    } catch {
      return false; // ESRCH (çoktan öldü) veya EPERM — ikisi de "benim işim bitti"
    }
  };
}

module.exports = {
  BARE_RUN_RE,
  PLAYWRIGHT_BROWSER_RE,
  PROTECTED_RE,
  HELPER_RE,
  HUMAN_ENV_RE,
  AUTOMATION_ENV_RE,
  DEFAULT_OLDER_THAN_MS,
  DEFAULT_TERM_GRACE_MS,
  SHIM_RE,
  parsePsLine,
  snapshot,
  treeRootOf,
  treeOf,
  etimeToMs,
  parseDuration,
  listOrphanElectrons,
  listOrphanBrowsers,
  listOrphanFleet,
  reapOrphanFleet,
  selectReapable,
  reapOrphanElectrons,
};
