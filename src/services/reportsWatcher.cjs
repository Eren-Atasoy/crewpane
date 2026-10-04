#!/usr/bin/env node
// ADP-298 — Raporlar sekmesi canlı yenilensin: dosya-sistemi watcher (MAIN) → IPC olayı.
//
// KÖK NEDEN (Eren yazdığım raporu göremedi): `ReportsPanel` listeyi YALNIZ mount'ta
// bir kez `fetch('/api/reports')` ile çekiyordu (boş dep dizisi). API doğru çalışıyordu;
// UI yeni dosyadan HABERSİZDİ. Poll eklemek yerine (ADP-284 boşta-CPU disiplini) olayı
// kaynağından duyuruyoruz: main dizinleri izler, değişince renderer'a tek bir olay atar.
//
// İZLENEN DİZİNLER: `src/lib/reports.ts` → `reportsDirs()` ile AYNI kurallar
// (kanonik `<root>/.crewpane/results` + donmuş legacy `docs/agent-results` nesli +
// REPORTS-ROOT-01: supervisor'ın proje-kökü kuralı `resultRoot.reportResultDirs` —
// `<root>/<proje>/docs/agent-results` + eşlenmiş repolar; REPORTS_DIR env'i tek dizine
// sabitler). Yol listesi tek kaynaktan (crewpanePaths.cjs + resultRoot.cjs) türetilir
// ki okuyucu, izleyici ve supervisor ayrışmasın.
//
// REPORTS-ROOT-01 (FB-1007, M4/Windows) — SONRADAN DOĞAN DİZİN. Çok projeli çalışma
// alanında bir projenin `docs/agent-results` dizini ilk rapor yazılırken `mkdir -p` ile
// doğar. ESKİDEN adaylar yalnız AÇILIŞTA `existsSync` süzgecinden geçiyordu: sonradan
// doğan dizin bir daha izlenmiyor, sekme uygulama yeniden başlatılana kadar boş kalıyordu.
// ŞİMDİ: var olmayan adayın EN YAKIN VAR OLAN atası ("doğum" izleyicisi, yine fs.watch,
// poll yok) izlenir; orada bir olay olunca aday listesi yeniden taranır, yeni doğan dizin
// bağlanır ve tek bir `onChange` atılır (sekme dolar).
//
// CPU: fs.watch işletim sisteminin olay mekanizmasıdır (poll değil) — boşta maliyeti ~0.
// Bir kayıt fırtınası (bir ajan 5 dosya yazar) tek olaya indirgenir (debounce).

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const crewpanePaths = require('../config/crewpanePaths.cjs');
const crewpaneEnv = require('../config/crewpaneEnv.cjs'); // ADP-244 Faz 3 — RESULTS_DIR dual-read
const resultRoot = require('./resultRoot.cjs'); // REPORTS-ROOT-01 — supervisor ile AYNI proje-kökü kuralı

/**
 * İzlenecek rapor dizinleri — reports.ts'teki reportsDirs() ile aynı sıra/kurallar.
 *
 * REPORTS-ROOT-01 (FB-1007) — `~/Downloads/CrewPane Apps/{chatflow,crewpane}` SABİT
 * YOLLARI ÜRÜNDEN ÇIKTI (ADP-835'in "yalnız win32'de ekleme" yarım çözümü yerine tam
 * çözüm): o çift Eren'in geliştirme makinesinin klasör adıydı ve paketle her müşteriye
 * gidiyordu (M4 paketin kaynağını okuyup fark etti). Geliştirme makinesinde aynı dizinler
 * artık supervisor kuralıyla (`<root>/<proje>/docs/agent-results`, root = "CrewPane Apps")
 * görülür; kök dışındaki ek dizin gerekirse `CREWPANE_EXTRA_REPORT_DIRS` (path.delimiter
 * ile ayrılmış liste; legacy adı CREWPANE_…) verilir. `deps.platform` imza uyumu için
 * kabul edilir, artık dal ayırmaz (aynı liste her platformda).
 *
 * @param {string|null|undefined} workspaceRoot
 * @param {NodeJS.ProcessEnv|object} [env]
 * @param {{platform?:string, worktreePaths?:string[], projectRoots?:string[]}} [deps]
 *   `projectRoots` = resultRoot.mappedProjectRoots çıktısı (main verir; kök dışı repolar).
 */
function reportsDirs(workspaceRoot, env = process.env, deps = {}) {
  if (env.REPORTS_DIR) return [env.REPORTS_DIR];
  const dirs = [];
  // Bridge'in yazdığı yer (main'in resolveResultsDir'i ile aynı env) önce gelsin.
  const envDir = crewpaneEnv.readEnv('RESULTS_DIR', env);
  if (envDir) dirs.push(envDir);
  if (workspaceRoot && fs.existsSync(workspaceRoot)) {
    const canonical = crewpanePaths.resultsDir(workspaceRoot);
    if (canonical) dirs.push(canonical);
    dirs.push(...crewpanePaths.legacyResultsDirs(workspaceRoot));
    // REPORTS-ROOT-01 — supervisor'ın proje-kökü kuralı (tek kaynak: resultRoot.cjs).
    dirs.push(...resultRoot.reportResultDirs(workspaceRoot, { extraRoots: deps.projectRoots }));
  }
  // B-01 (bulgu F-7) — AKTİF İZOLE AĞAÇLAR. Bir görev kendi worktree'sinde koşarken
  // raporunu O ağaca yazar: `<worktree>/.crewpane/results` ve `<worktree>/docs/
  // agent-results`. Bu satır olmadan Raporlar sekmesi izole görevlerin raporlarını
  // HİÇ göremez (dosya diske düşer, UI habersiz kalır — ADP-298'in kapattığı deliğin
  // izolasyon sürümü). Yol listesi MAIN'den (yerel defter) gelir; `deps` dikişi
  // testin gerçek dosya sistemine bağımlı kalmamasını sağlar.
  for (const wt of Array.isArray(deps.worktreePaths) ? deps.worktreePaths : []) {
    if (typeof wt !== 'string' || !wt) continue;
    const canonical = crewpanePaths.resultsDir(wt);
    if (canonical) dirs.push(canonical);
    dirs.push(path.join(wt, 'docs', 'agent-results'));
  }
  dirs.push(...resultRoot.splitPathList(crewpaneEnv.readEnv('EXTRA_REPORT_DIRS', env)));
  const seen = new Set();
  return dirs.filter((d) => {
    const key = path.resolve(d);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** REPORTS-ROOT-01 — doğum izleyicisi tavanı ve ata derinliği (`agent-results`→`docs`→`<proje>`→`<root>`). */
const MAX_BIRTH_WATCHERS = 64;
const BIRTH_ANCESTOR_DEPTH = 3;

/** Rapor dosyası mı? (Liste yalnız .md gösterir — geçici/gizli dosyalar olay üretmesin.) */
function isReportFile(name) {
  return typeof name === 'string' && /\.md$/i.test(name) && !name.startsWith('.');
}

/**
 * Var olan rapor dizinlerini izle; değişimde (debounce'lu) `onChange()` çağır.
 * Dönen `close()` tüm watcher'ları kapatır.
 *
 * REPORTS-ROOT-01 — OLMAYAN DİZİN ARTIK SESSİZCE ATLANMAZ. ESKİDEN: "yaratılırsa bir
 * üst dizini izlemek aşırı olurdu; app yeniden başlayınca izlenir" — FB-1007 tam bu
 * varsayımın müşteri bildirimi (çok projeli kökte sekme boş, yeniden başlatma gerekiyor).
 * ŞİMDİ: var olmayan adayın en yakın VAR OLAN atası (`<proje>/docs` → `<proje>` → `<root>`)
 * "doğum" izleyicisiyle (fs.watch, poll yok) izlenir; orada olay olunca `rescan()` aday
 * listesini yeniden değerlendirir, yeni doğan dizini bağlar ve TEK `onChange` atar.
 * Atalar tekildir (10 proje aynı `<root>`u paylaşır → 1 izleyici) ve tavanlıdır
 * (MAX_BIRTH_WATCHERS; aşılırsa bir kez loglanır — sessiz değil). `refresh()` aynı
 * taramayı elle tetikler.
 *
 * ADP-835 (790 K3) — ÖNCEDEN: bir dizin SİLİNİP YENİDEN YARATILIRSA (`rmdir` + `mkdir`,
 * ör. workspace klasörünün Finder/Explorer'da taşınıp geri getirilmesi ya da bir
 * senkron aracın "sil, yeniden indir" desenini kullanması) `fs.watch` sessizce ölür
 * — `w.on('error', ()=>{})` app'i çökmekten korur ama izleme bir daha GERİ GELMEZ ve
 * Raporlar sekmesi yeni dosyalardan bir daha haberdar OLMAZ. macOS'ta da olur, ama
 * Windows'ta (kanıtlanmamış, 790'ın notu) daha sık gözlenmiş bir davranış.
 * ŞİMDİ: hata/kapanış olayında dizin HÂLÂ VARSA kısa bir gecikmeyle yeniden bağlanır
 * (üstel geri-çekilme, üst sınır var — sonsuz sıkı döngü YOK) ve `log()`'a düşer
 * (sessiz değil). Yeniden bağlanamıyorsa (dizin gerçekten gitti) sessizce durur —
 * bu YENİ bir sessizlik değil, bugünkü "olmayan dizin izlenmez" kuralının aynısı.
 */
function createReportsWatcher({
  workspaceRoot, onChange, debounceMs = 300, env = process.env,
  fs: fsMod = fs, setTimer = setTimeout, log = () => {}, platform = process.platform,
  worktreePaths = [], // B-01 F-7 — aktif izole ağaçlar (main: worktreeStore defteri)
  projectRoots = [], // REPORTS-ROOT-01 — eşlenmiş repo kökleri (main: resultRoot.mappedProjectRoots)
  maxBirthWatchers = MAX_BIRTH_WATCHERS,
} = {}) {
  const watchers = new Map(); // dir → { watcher, rearmAttempts }
  const birthWatchers = new Map(); // ata dizin → watcher (sonradan doğacak adayı bekler)
  let timer = null;
  let rescanTimer = null;
  let closed = false;
  let birthCapLogged = false;
  const MAX_REARM_DELAY_MS = 30_000;

  const fire = () => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!closed) onChange();
    }, debounceMs);
    timer.unref?.();
  };

  const attach = (dir, rearmAttempts = 0) => {
    if (closed) return;
    try {
      const w = fsMod.watch(dir, { persistent: false }, (_event, filename) => {
        // filename bazı platformlarda null gelebilir → o zaman temkinli davran (yenile).
        if (filename == null || isReportFile(filename)) fire();
      });
      watchers.set(dir, { watcher: w, rearmAttempts: 0 });
      const onLost = (reason) => {
        if (closed) return;
        // ADP-835 (790 K3) — sessiz ölüm yerine: logla + dizin hâlâ varsa yeniden bağlan.
        log(`reportsWatcher: "${dir}" izlemesi düştü (${reason}) — yeniden bağlanmayı deniyorum`);
        const attempt = (watchers.get(dir)?.rearmAttempts ?? rearmAttempts) + 1;
        const delay = Math.min(1000 * 2 ** (attempt - 1), MAX_REARM_DELAY_MS);
        const t = setTimer(() => {
          if (closed) return;
          if (!fsMod.existsSync(dir)) {
            log(`reportsWatcher: "${dir}" artık yok — yeniden bağlanma denemesi durdu`);
            watchers.delete(dir);
            // Dizin gitti ama yeniden DOĞABİLİR (rmdir+mkdir'in yavaş hâli): ata izlemesine düş.
            scheduleRescan();
            return;
          }
          attach(dir, attempt);
          fire(); // dizin geri geldiyse muhtemelen içerik değişti — tek seferlik tazeleme
        }, delay);
        t.unref?.();
      };
      w.on('error', (err) => onLost(err && err.code ? err.code : String(err)));
      w.on('close', () => { if (watchers.get(dir)?.watcher === w) onLost('close'); });
    } catch (err) {
      log(`reportsWatcher: "${dir}" izlenemedi (${err && err.code ? err.code : err})`);
      /* izlenemeyen dizin → atla */
    }
  };

  // ── REPORTS-ROOT-01 — doğum izleyicileri ────────────────────────────────────
  /** Var olmayan `dir` için izlenecek en yakın VAR OLAN ata (en fazla `depth` seviye). */
  const nearestExistingAncestor = (dir, depth = BIRTH_ANCESTOR_DEPTH) => {
    let cur = dir;
    for (let i = 0; i < depth; i++) {
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      if (fsMod.existsSync(parent)) return parent;
      cur = parent;
    }
    return null;
  };

  const scheduleRescan = () => {
    if (closed) return;
    if (rescanTimer) clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => {
      rescanTimer = null;
      if (!closed) rescan();
    }, debounceMs);
    rescanTimer.unref?.();
  };

  const attachBirth = (ancestor) => {
    if (closed || birthWatchers.has(ancestor)) return;
    if (birthWatchers.size >= maxBirthWatchers) {
      if (!birthCapLogged) {
        birthCapLogged = true;
        log(`reportsWatcher: doğum izleyicisi tavanı (${maxBirthWatchers}) doldu — "${ancestor}" ve sonrası izlenmiyor; "Yenile" ile elle taranır`);
      }
      return;
    }
    try {
      // Ata dizinde HERHANGİ bir dizin girişi (yeni alt klasör) → aday listesini yeniden tara.
      const w = fsMod.watch(ancestor, { persistent: false }, () => scheduleRescan());
      w.on('error', () => { birthWatchers.delete(ancestor); scheduleRescan(); });
      birthWatchers.set(ancestor, w);
    } catch (err) {
      log(`reportsWatcher: ata "${ancestor}" izlenemedi (${err && err.code ? err.code : err})`);
    }
  };

  /**
   * Aday listesini yeniden değerlendir: yeni var olan dizinleri bağla (ve TEK onChange at),
   * hâlâ olmayanlar için ata izleyicilerini kur, artık gereksiz ata izleyicilerini kapat.
   * Dönen değer: yeni bağlanan dizin sayısı. `initial=true` (kuruluş taraması) onChange
   * ATMAZ: renderer mount'ta zaten yükler; sahte bir "yeni rapor" rozeti/olayı üretilmez.
   */
  const rescan = (initial = false) => {
    if (closed) return 0;
    const candidates = reportsDirs(workspaceRoot, env, { platform, worktreePaths, projectRoots });
    let grew = 0;
    const neededAncestors = new Set();
    for (const dir of candidates) {
      if (watchers.has(dir)) continue;
      if (fsMod.existsSync(dir)) {
        attach(dir);
        if (watchers.has(dir)) grew++;
        continue;
      }
      const anc = nearestExistingAncestor(dir);
      if (anc) neededAncestors.add(anc);
    }
    for (const [anc, w] of birthWatchers) {
      if (neededAncestors.has(anc)) continue;
      try { w.close(); } catch { /* zaten kapalı */ }
      birthWatchers.delete(anc);
    }
    for (const anc of neededAncestors) attachBirth(anc);
    if (grew > 0 && !initial) {
      log(`reportsWatcher: ${grew} yeni rapor dizini doğdu → izleniyor (toplam ${watchers.size})`);
      fire();
    }
    return grew;
  };

  rescan(true);

  return {
    /** İzlenen (var olan) dizinler — canlı görünüm (sonradan doğanlar da eklenir). */
    get dirs() { return [...watchers.keys()]; },
    /** Bekleyen (henüz doğmamış) adayların izlenen ataları — teşhis/test için. */
    get pendingAncestors() { return [...birthWatchers.keys()]; },
    refresh: () => rescan(false),
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      if (rescanTimer) clearTimeout(rescanTimer);
      for (const { watcher } of watchers.values()) {
        try { watcher.close(); } catch { /* zaten kapalı */ }
      }
      watchers.clear();
      for (const w of birthWatchers.values()) {
        try { w.close(); } catch { /* zaten kapalı */ }
      }
      birthWatchers.clear();
    },
  };
}

module.exports = { createReportsWatcher, reportsDirs, isReportFile };
