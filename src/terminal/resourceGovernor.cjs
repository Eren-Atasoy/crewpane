// PANE-CAP-01 — KAYNAK BEKÇİSİ (ResourceGovernor).
//
// ─────────────────────────────────────────────────────────────────────────────
// NEDEN VAR: sabit sayı yanlış araçtı
// ─────────────────────────────────────────────────────────────────────────────
// ADP-264 canlı-pane sayısına sabit bir tavan (24) koydu, ADP-444 tek komuta bir
// başka sabit tavan (16). Sabit sayı iki yönde de YANLIŞ ölçer:
//   • 36 GB'lık makinede 24 hafif pane hiçbir baskı yaratmaz ama tavan REDDEDER —
//     02.09'da tam bu oldu: `pty:spawn rejected: pane-limit: 24 canlı pane var`
//     10 kez basıldı ve sprint-1788372649141 0/10 düştü (hiçbir iş yapılmadı).
//   • 8 GB'lık makinede 12 AĞIR pane makineyi swap'e boğar ama tavan İZİN VERİR.
// Kullanıcıyı koruyan şey SAYI değil ÖLÇÜLEN KAYNAKTIR. Bu modül sayıyı atar,
// ölçümü koyar.
//
// ─────────────────────────────────────────────────────────────────────────────
// SÖZLEŞME: BEKÇİ ASLA SESSİZCE ENGELLEMEZ (Eren 02.09: "hiçbir limit olmamalı")
// ─────────────────────────────────────────────────────────────────────────────
//   1. `admit()` bir RET değil bir GÖRÜŞTÜR. `false` döndüğünde çağıran işi
//      düşürmez — bekleme bileti alır ve kullanıcı TEK kart görür:
//      "yine de aç / bitmiş pane'leri kapat / bekle".
//   2. "Yine de aç" her zaman vardır ve süre-kutuludur (`allowAnyway`): bir kez
//      onaylayan kullanıcı sonraki her spawn'da yeniden sorgulanmaz, ama onay da
//      sonsuza kadar yaşamaz.
//   3. Bekçi tamamen KAPATILABİLİR (`enabled:false`) — o zaman hiçbir eşik yoktur,
//      yalnız bilgi rozeti kalır. Kapalı bekçi `admit()`ten HER ZAMAN true döner.
//   4. Eşikleri OKUYAMAZSAK izin veririz (fail-open). Bir ölçüm arızası kullanıcıyı
//      kendi makinesinde çalışmaktan edemez.
//
// ─────────────────────────────────────────────────────────────────────────────
// ÖLÇÜLEN GERÇEK (PANE-CAP-01 Faz 0, 02.09 · M3 Max 38,7 GB · Electron 42.4.1)
// ─────────────────────────────────────────────────────────────────────────────
//   • pty MALİYETİ ~SIFIR: 64 canlı node-pty = ana süreçte +3,5 MB RSS, pty başına
//     4 fd, spawn 4 ms. Yani "kaç pane" pty yüzünden sınırlı DEĞİL.
//   • fd DARBOĞAZ DEĞİL: çalışan uygulama o an 427 fd tutuyordu (soft limit 256
//     olsaydı çoktan ölürdü); kern.maxfilesperproc = 138.240.
//   • ASIL MALİYET AJAN SÜREÇLERİNDE: 28 claude süreci × ~119 MB RSS.
//   → Bu yüzden bekçinin birincil ölçüsü PANE SAYISI değil BELLEKTİR.
//
// Saf çekirdek (Electron'suz, `node --test` ile koşar) — `spawnSpec.cjs` emsali.
'use strict';

const os = require('os');
const { execFileSync } = require('child_process');

/** Varsayılan eşikler ve örnekleme aralığı (Ayarlar'dan değiştirilebilir). */
const DEFAULTS = Object.freeze({
  /** Bekçi açık mı? Kapalıysa hiçbir eşik yok — yalnız bilgi rozeti. */
  enabled: false,
  /** Uyarı eşiği: kullanılabilir bellek yüzdesi bunun ALTINDA → 'warn' (engel YOK). */
  warnFreePct: 1,
  /** Dur-ve-sor eşiği: bunun ALTINDA → 'critical' (kart çıkar, kullanıcı karar verir). */
  criticalFreePct: 0,
  /** Örnekleme aralığı (ms). */
  sampleMs: 5000,
  /** "Yine de aç" onayının ömrü (ms) — süre-kutulu, sonsuz değil. */
  overrideMs: 10 * 60 * 1000,
  // ── PERF-FLEET-01 (08.09 kernel panic) ────────────────────────────────────
  /**
   * İŞLETİM SİSTEMİNİN KENDİ HÜKMÜ KAPI OLSUN MU?
   *
   * 🔴 ÖLÇÜLDÜ (panic-full-2026-09-08-015910, `memoryStatus`): panic anında GERÇEK
   * boş bellek 14,2 MB'tı ve çekirdek istediği 3.091 sayfanın 62'sini geri
   * kazanabiliyordu (%2). Ama bizim formülümüz o an ne diyordu:
   *     hardUsed = (wired 350.939 + active 404.325 + compressor 1.137.852) × 16 KB
   *              = 28,9 GB  →  kullanılabilir 7,1 GB  →  %19,8  →  seviye 'warn'
   * Yani makine watchdog panic'ine giderken BEKÇİ YEŞİLE YAKINDI ve yeni pane
   * açmaya devam ediyordu. Sebep: `inactive` (6,2 GB) "kullanılabilir" sayılıyor —
   * takas gidip-gelmesi altında o sayfalar FİİLEN geri kazanılamıyor.
   *
   * macOS'un kendi ölçüsü (`kern.memorystatus_vm_pressure_level` = 4) o anda
   * KRİTİK diyordu ve kod bunu zaten OKUYORDU — ama bilinçli olarak yalnız
   * "destekleyici gerekçe" sayıp seviyeyi yükseltmiyordu. Tek gerçek sinyal
   * dipnota düşürülmüştü. Bu bayrak onu KAPIYA bağlar.
   * `false` → PANE-CAP-01'in ilk günkü davranışı (KONTROL KOLU).
   */
  osPressureGate: true,
  /**
   * EŞZAMANLI PANE TAVANI AÇIK MI? Kapalı = eski sınırsız davranış (KONTROL KOLU).
   * Tavan bir RET DEĞİLDİR: dolunca iş `admit:false` + BİLET alır, yani KUYRUĞA
   * girer (delegation.ts capacityWait) — "failed" olmaz, sessizce paralel de açılmaz.
   */
  paneCapEnabled: true,
  /**
   * Eşzamanlı pane tavanı. `0` = OTOMATİK (makinenin RAM'inden türetilir,
   * bkz. derivePaneCap); `n>0` = kullanıcının elle verdiği sayı.
   */
  maxPanes: 0,
  /**
   * Ana süreç durması (`main-stall`) kaç ms'yi geçerse seviye KRİTİĞE çekilir.
   * ÖLÇÜLDÜ (crewpane-shell.4.log, panic 1'e giden 2 dakika): 1.030 → 1.345 →
   * 1.940 → 18.333 → 23.398 → 29.673 ms. Bu tırmanma kullanıcının ekranına HİÇ
   * çıkmadı. 5 sn eşiği ilk üç satırı gürültü sayar, 18 sn'yi yakalar.
   */
  stallCriticalMs: 5000,
  /**
   * Damga eşiği: monitör 250 ms'den itibaren günlüğe yazar (VOICE-TRUNC-01) ama
   * KULLANICIYA her yarım saniyelik takılmayı göstermek gürültüdür. 1 sn, ölçülen
   * tırmanmanın İLK satırıdır (1.030 ms) — yani gerçek olayı baştan yakalar,
   * gündelik takılmaları yutar.
   */
  stallWarnMs: 1000,
  /** Durma damgasının ömrü: bu kadar süre yeni durma gelmezse damga düşer. */
  stallWindowMs: 60 * 1000,
  // ── RG-CAP-01 (12.09 müşteri bildirimi) ───────────────────────────────────
  /**
   * BEKLEME BİLETİNİN ÖMRÜ (ms).
   *
   * 🔴 ÖLÇÜLDÜ: `release()` ürün kodunda HİÇBİR YERDEN çağrılmıyor (yalnız burada
   * tanımlı). Bilet açan tek yol `admit()`, kapatan yol ise pratikte yalnız
   * `allowAnyway()`/`configure()`. Delegasyon ise reddi `capacity-wait` sayıp
   * 10/20/40/80/120 sn'lik geri çekilmeyle YENİDEN spawn dener — her deneme YENİ
   * bir bilet açar. Sonuç iki kusur:
   *   1. Kartın başlığı ("%X boş — N pane bekliyor") N'i REDDEDİLEN DENEME SAYISI
   *      olarak gösterir; ölçümde 11 dakikada 1 bekleyen alt-görev "12 pane
   *      bekliyor" diye yazıldı.
   *   2. Kartın açılma koşulundaki `waiting > 0` bir kez doğru olduktan sonra
   *      KALICI olarak doğru kalır — ilk kritik anından sonra kart her kısa
   *      kritik dalgalanmada anında geri gelir.
   * Bilet "bu çağıran hâlâ bekliyor" demektir; geri dönmeyen bir çağıranın bileti
   * bir olgu değil bir sızıntıdır. Tavan geri-çekilmenin EN UZUN adımının (120 sn)
   * iki katı: hâlâ deneyen bir çağıranın bileti asla erken düşmez.
   */
  ticketTtlMs: 4 * 60 * 1000,
});

/**
 * PANE MALİYETİ — ÖLÇÜLDÜ, tahmin değil (PERF-FLEET-01, 08.09 canlı `ps` + panic
 * stackshot):
 *   • Canlı ölçüm: 9 ajan pane'i → 119 süreç / 7,50 GB  (pane başına 13 süreç,
 *     ~0,83 GB). Bir pane = claude + 3 CrewPane MCP + 4 npx MCP + npm sarmalayıcıları.
 *   • Panic anı: coalition 833 (lider pid 736 = CrewPane) → 380 süreç / 69,35 GB,
 *     içinde 20 `2.1.263` (= 20 claude pane'i) ve 263 node.
 * Tavan bu yüzden bir "his" değil ARİTMETİK: makineye kaç pane SIĞIYOR.
 */
const PANE_COST_BYTES = 1024 * 1024 * 1024; // 1 GB/pane (ölçülen 0,83 + pay)
/** İşletim sistemine ve kullanıcının kendi uygulamalarına bırakılan pay. */
const FLEET_BUDGET_RATIO = 0.75;
/** Tavan bunun altına ASLA inmez: 4 pane açamayan bir ofis kullanılamaz. */
const MIN_PANE_CAP = 4;

/**
 * Makinenin RAM'inden eşzamanlı pane tavanı. SAF fonksiyon.
 * Eren'in makinesi 36 GiB (38,65 GB) → floor(36 × 0,75) = 27 pane. (Panic gecesi
 * 22 prod + 17 dev = 39 pane vardı; bu tavan son 12'sini KUYRUĞA alırdı, düşürmezdi.)
 */
function derivePaneCap(totalBytes) {
  const total = Number(totalBytes);
  if (!Number.isFinite(total) || total <= 0) return 0; // ölçemedik → tavan YOK (fail-open)
  return Math.max(MIN_PANE_CAP, Math.floor((total * FLEET_BUDGET_RATIO) / PANE_COST_BYTES));
}

/** Yürürlükteki tavan: kapalıysa 0 (=sınırsız), 0 ise türetilmiş, değilse verilen. */
function effectivePaneCap(settings, totalBytes) {
  const t = settings || {};
  if (t.paneCapEnabled === false) return 0;
  const n = Number(t.maxPanes);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return derivePaneCap(totalBytes);
}

/**
 * Faz 0 ölçümü (webgl-cap-step.txt): Chromium/Electron 42 SAYFA BAŞINA TAM 16 canlı
 * WebGL bağlamı tutar; 17.'yi yaratmak EN ESKİSİNİ düşürür (FIFO — ölçülen tahliye
 * sırası 0,1,2,…). xterm WebglAddon pane başına bir bağlam alır, dolayısıyla 17+
 * pane AYNI ANDA görünürse ilk açılanlar `webglcontextlost` yer.
 *
 * Ürün bu kayıptan kurtulur (Terminal.tsx recoverTerminal → DOM renderer) ama
 * kurtarma GÜRÜLTÜLÜDÜR. Bütçe 15 (16 değil): bir yuva iç tarayıcı <webview>'i ve
 * diğer GL kullanıcıları için ayrılır. Tahliyeyi Chromium'a zorla yaptırmak yerine
 * BİZ sessizce yaparız (detachWebgl → DOM), çünkü kendi tahliyemiz bir olay fırtınası
 * ve kurtarma merdiveni tetiklemez.
 */
const WEBGL_CONTEXT_CAP = 16;
const VISIBLE_WEBGL_BUDGET = 15;

/** Bir baskı seviyesi diğerinden ağır mı? */
const LEVEL_RANK = { ok: 0, warn: 1, critical: 2 };

/**
 * macOS `vm_stat` çıktısını kullanılabilir belleğe çevirir.
 *
 * DİKKAT — "boş bellek" macOS'ta NAİF ölçülemez: `os.freemem()` yalnız GERÇEKTEN
 * boş sayfaları sayar (ölçüldü: sağlıklı makinede %2) ve her makineyi sürekli
 * kritik gösterirdi. Activity Monitor'ün "kullanılan bellek" tanımını kullanıyoruz:
 * geri alınamayan = wired + active + sıkıştırıcının tuttuğu. Kalanı kullanılabilir.
 * @param {string} raw - `vm_stat` ham çıktısı
 * @returns {{availableBytes:number,totalBytes:number,freePct:number}|null}
 */
function parseVmStat(raw, totalBytes) {
  const text = String(raw || '');
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] || 0);
  if (!pageSize || !totalBytes) return null;
  const pages = (label) => {
    const m = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s+(\\d+)').exec(text);
    return m ? Number(m[1]) : null;
  };
  const wired = pages('Pages wired down');
  const active = pages('Pages active');
  const compressor = pages('Pages occupied by compressor');
  if (wired == null || active == null || compressor == null) return null;
  const hardUsed = (wired + active + compressor) * pageSize;
  const availableBytes = Math.max(0, totalBytes - hardUsed);
  return { availableBytes, totalBytes, freePct: +((availableBytes / totalBytes) * 100).toFixed(1) };
}

/**
 * Linux `/proc/meminfo` → MemAvailable (çekirdeğin KENDİ tahmini; free'den çok daha
 * doğru — sayfa önbelleği geri alınabilir).
 */
function parseMemInfo(raw, totalBytesFallback) {
  const text = String(raw || '');
  const kb = (label) => {
    const m = new RegExp('^' + label + ':\\s+(\\d+) kB', 'm').exec(text);
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = kb('MemTotal') ?? totalBytesFallback;
  const avail = kb('MemAvailable');
  if (!total || avail == null) return null;
  return { availableBytes: avail, totalBytes: total, freePct: +((avail / total) * 100).toFixed(1) };
}

/**
 * Platformdan bağımsız bellek okuması. Okunamazsa `null` — çağıran FAIL-OPEN eder
 * (ölçemediğimiz için kimseyi bekletmeyiz).
 * @param {{platform?:string, exec?:Function, totalmem?:Function}} [io] - test enjeksiyonu
 */
function readMemory(io = {}) {
  const platform = io.platform || process.platform;
  const totalmem = io.totalmem || os.totalmem;
  const exec = io.exec || ((file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 2000 }));
  const totalBytes = totalmem();
  try {
    if (platform === 'darwin') return parseVmStat(exec('/usr/bin/vm_stat', []), totalBytes);
    if (platform === 'linux') return parseMemInfo(exec('/bin/cat', ['/proc/meminfo']), totalBytes);
    // win32 ve bilinmeyen: os.freemem() Windows'ta GlobalMemoryStatusEx'in
    // ullAvailPhys'idir — orada "kullanılabilir" anlamı zaten doğrudur.
    const free = (io.freemem || os.freemem)();
    if (!totalBytes) return null;
    return { availableBytes: free, totalBytes, freePct: +((free / totalBytes) * 100).toFixed(1) };
  } catch {
    return null; // ölçemedik → fail-open
  }
}

/**
 * macOS'un KENDİ bellek-baskısı hükmü (1 normal / 2 uyarı / 4 kritik). Eşiğimizi
 * DEĞİŞTİRMEZ — karta koyulacak destekleyici gerekçedir ("işletim sistemi de
 * uyarıda"). Okunamazsa null.
 */
function readOsPressure(io = {}) {
  const platform = io.platform || process.platform;
  if (platform !== 'darwin') return null;
  const exec = io.exec || ((file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 2000 }));
  try {
    const out = exec('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']);
    const n = Number(String(out).trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Kullanılan swap (MB). Okunamazsa null (Windows'ta ölçmüyoruz). */
function readSwapMB(io = {}) {
  const platform = io.platform || process.platform;
  const exec = io.exec || ((file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 2000 }));
  try {
    if (platform === 'darwin') {
      const m = /used = ([\d.]+)M/.exec(exec('/usr/sbin/sysctl', ['-n', 'vm.swapusage']));
      return m ? Math.round(Number(m[1])) : null;
    }
    if (platform === 'linux') {
      const t = exec('/bin/cat', ['/proc/meminfo']);
      const total = Number(/^SwapTotal:\s+(\d+) kB/m.exec(t)?.[1] || 0);
      const free = Number(/^SwapFree:\s+(\d+) kB/m.exec(t)?.[1] || 0);
      return total ? Math.round((total - free) / 1024) : null;
    }
  } catch { /* ölçemedik */ }
  return null;
}

/**
 * Ölçümü SEVİYEYE çevir. SAF fonksiyon — test edilebilir, yan etkisiz.
 *
 * @param {{freePct:number|null, swapUsedMB?:number|null, osPressure?:number|null}} sample
 * @param {{enabled:boolean, warnFreePct:number, criticalFreePct:number}} thresholds
 * @returns {{level:'ok'|'warn'|'critical', reasons:string[], measured:boolean}}
 */
function computeLevel(sample, thresholds) {
  const t = { ...DEFAULTS, ...(thresholds || {}) };
  // Bekçi kapalı → hiçbir eşik yok. Ölçüm yine gösterilir (bilgi rozeti) ama
  // seviye ASLA 'ok' dışına çıkmaz: kapalı bir bekçi kimseyi bekletemez.
  if (!t.enabled) return { level: 'ok', reasons: [], measured: sample?.freePct != null, disabled: true };
  const freePct = sample && Number.isFinite(sample.freePct) ? sample.freePct : null;
  if (freePct == null) {
    // FAIL-OPEN — ölçemediysek "kaynak yok" demek YALAN olurdu.
    return { level: 'ok', reasons: ['ölçülemedi'], measured: false };
  }
  const reasons = [];
  let level = 'ok';
  if (freePct < t.criticalFreePct) {
    level = 'critical';
    reasons.push(`kullanılabilir bellek %${freePct} (dur-ve-sor eşiği %${t.criticalFreePct})`);
  } else if (freePct < t.warnFreePct) {
    level = 'warn';
    reasons.push(`kullanılabilir bellek %${freePct} (uyarı eşiği %${t.warnFreePct})`);
  }
  // PERF-FLEET-01 — İŞLETİM SİSTEMİNİN HÜKMÜ ARTIK BİR KAPI (bayrakla).
  // Eskiden bu satırlar yalnız `reasons`a yazılırdı; 08.09 panic'inde formülümüz
  // %19,8 ("warn") derken macOS 4 (KRİTİK) diyordu ve haklı olan macOS'tu
  // (14,2 MB boş, 62/3.091 sayfa geri kazanımı). Bayrak kapalıyken (kontrol kolu)
  // davranış birebir eskisi: yalnız gerekçe, seviye değişmez.
  if (Number.isFinite(sample.osPressure) && sample.osPressure >= 4) {
    reasons.push('işletim sistemi bellek baskısı: KRİTİK');
    if (t.osPressureGate) level = 'critical';
  } else if (Number.isFinite(sample.osPressure) && sample.osPressure >= 2) {
    reasons.push('işletim sistemi bellek baskısı: uyarı');
    if (t.osPressureGate && level === 'ok') level = 'warn';
  }
  // PERF-FLEET-01 — ANA SÜREÇ DURMASI GÖRÜNÜR OLSUN. `main-stall` satırları panic
  // gecesi 1 sn → 30 sn'ye tırmandı ve YALNIZ günlüğe yazıldı; kullanıcı hiçbir şey
  // görmedi. Durma bir SONUÇTUR (makine zaten doymuş) — bu yüzden kendi başına
  // yeterli bir kritiklik ölçüsüdür ve seviyeyi yükseltir.
  const stallWarn = Number.isFinite(t.stallWarnMs) ? t.stallWarnMs : DEFAULTS.stallWarnMs;
  if (Number.isFinite(sample.stallMs) && sample.stallMs >= stallWarn) {
    const stallGate = Number.isFinite(t.stallCriticalMs) ? t.stallCriticalMs : DEFAULTS.stallCriticalMs;
    reasons.push(`ana süreç ${(sample.stallMs / 1000).toFixed(1)} sn yanıt vermedi`);
    if (sample.stallMs >= stallGate) level = 'critical';
    else if (level === 'ok') level = 'warn';
  }
  if (Number.isFinite(sample.swapUsedMB) && sample.swapUsedMB > 0 && level !== 'ok') {
    reasons.push(`swap kullanımı ${(sample.swapUsedMB / 1024).toFixed(1)} GB`);
  }
  return { level, reasons, measured: true };
}

/** Seviye a, b'den ağır mı? */
function heavierThan(a, b) { return (LEVEL_RANK[a] ?? 0) > (LEVEL_RANK[b] ?? 0); }

/**
 * "Bitmiş" worker pane'i: son çıktısının üstünden `idleMs`'den fazla geçmiş VE
 * durumu terminal (done/failed/idle). Başka takımın pane'i ASLA sayılmaz —
 * `teamId` verilmişse yalnız o takım. SAF fonksiyon.
 *
 * @param {Array<{paneId:string, agentId?:string, teamId?:string|null, status?:string, lastOutputAt?:number}>} panes
 * @param {{now:number, idleMs?:number, teamId?:string|null}} opts
 */
function finishedPanes(panes, { now, idleMs = 15 * 60 * 1000, teamId = null } = {}) {
  const TERMINAL = new Set(['done', 'idle', 'failed', 'completed', 'reported']);
  return (Array.isArray(panes) ? panes : []).filter((p) => {
    if (!p || !p.paneId) return false;
    if (teamId != null && p.teamId !== teamId) return false; // başka takıma DOKUNMA
    if (!TERMINAL.has(String(p.status || '').toLowerCase())) return false;
    const last = Number(p.lastOutputAt);
    if (!Number.isFinite(last)) return false;
    return now - last >= idleMs;
  });
}

/**
 * Bekçi örneği. Main süreçte TEK tane; `sample()` zamanlayıcıdan çağrılır.
 *
 * @param {{now?:Function, io?:object, settings?:object, log?:Function, onChange?:Function}} deps
 */
function createGovernor(deps = {}) {
  const now = deps.now || (() => Date.now());
  const io = deps.io || {};
  const log = deps.log || (() => {});
  const onChange = deps.onChange || (() => {});
  let settings = { ...DEFAULTS, ...(deps.settings || {}) };
  let last = { level: 'ok', reasons: [], measured: false, freePct: null, swapUsedMB: null, osPressure: null, at: 0 };
  let overrideUntil = 0;
  /** Bekleyen kapasite biletleri: ticketId → {id, agentId, reason, at} */
  const tickets = new Map();
  let seq = 0;
  /** PERF-FLEET-01 — son `main-stall` damgası: {driftMs, at}. Penceresi dolunca düşer. */
  let stall = null;
  /** Son bilinen canlı pane sayısı (admit çağıranı verir; rozet için saklanır). */
  let liveCountSeen = 0;

  /**
   * RG-CAP-01 — süresi dolmuş biletleri AT ve kalanı döndür. Tek yerde: hem
   * `state()` (kartın gördüğü sayı) hem `openTicket` bunu kullanır, böylece
   * "ekranda gösterilen sayı" ile "bellekte duran küme" ayrışamaz.
   */
  function liveTickets() {
    const ttl = Number.isFinite(settings.ticketTtlMs) ? settings.ticketTtlMs : DEFAULTS.ticketTtlMs;
    if (ttl > 0) {
      const cutoff = now() - ttl;
      for (const [id, t] of tickets) if (!(t.at > cutoff)) tickets.delete(id);
    }
    return [...tickets.values()];
  }

  /** Damga hâlâ geçerli mi? Değilse null döner (SAF okuma, yan etkisiz). */
  function currentStallMs() {
    if (!stall) return null;
    const windowMs = Number.isFinite(settings.stallWindowMs) ? settings.stallWindowMs : DEFAULTS.stallWindowMs;
    if (now() - stall.at > windowMs) return null;
    return stall.driftMs;
  }

  function sample() {
    const mem = readMemory(io);
    const swapUsedMB = readSwapMB(io);
    const osPressure = readOsPressure(io);
    const s = { freePct: mem ? mem.freePct : null, swapUsedMB, osPressure, stallMs: currentStallMs() };
    const verdict = computeLevel(s, settings);
    const next = {
      ...verdict,
      stallMs: s.stallMs,
      freePct: s.freePct,
      availableBytes: mem ? mem.availableBytes : null,
      totalBytes: mem ? mem.totalBytes : null,
      swapUsedMB,
      osPressure,
      at: now(),
    };
    const changed = next.level !== last.level;
    last = next;
    if (changed) {
      log(`resourceGovernor: seviye ${next.level} (${next.reasons.join(' · ') || 'baskı yok'})`);
      onChange(state());
    }
    return next;
  }

  /**
   * Yeni bir pane açılsın mı? DÖNÜŞ BİR RET DEĞİL BİR GÖRÜŞTÜR:
   *   { admit:true }                     → aç
   *   { admit:false, ticket, state }     → kullanıcıya SOR (kart), işi DÜŞÜRME
   * Bekçi kapalıysa / ölçemediysek / "yine de aç" onayı canlıysa HER ZAMAN true.
   */
  function admit({ agentId = null, reason = null, liveCount = null } = {}) {
    if (Number.isFinite(liveCount)) liveCountSeen = liveCount;
    if (!settings.enabled || settings.criticalFreePct === 0) return { admit: true, why: 'bekçi kapalı' };
    if (now() < overrideUntil) return { admit: true, why: 'kullanıcı onayı canlı' };
    // PERF-FLEET-01 — EŞZAMANLI PANE TAVANI. Bellek freninden ÖNCE bakılır çünkü
    // tavan İLERİYE dönük (bir sonraki pane makineye sığar mı), fren ise GERİYE
    // dönük (makine zaten doldu mu). Panic gecesi fren hiç kırmızıya dönmedi
    // (%19,8 = 'warn') ama 39 pane açıktı — tavanı olan tek şey buydu.
    // Tavan dolu = RET DEĞİL, BİLET: çağıran kuyruğa alır (delegation.ts capacityWait).
    const cap = paneCap();
    if (cap > 0 && Number.isFinite(liveCount) && liveCount >= cap) {
      return openTicket({ agentId, reason, why: `pane tavanı ${liveCount}/${cap}` });
    }
    if (!last.measured) return { admit: true, why: 'ölçülemedi (fail-open)' };
    if (last.level !== 'critical') return { admit: true, why: last.level };
    return openTicket({ agentId, reason, why: `kullanılabilir bellek %${last.freePct}` });
  }

  /** Bilet açma — tavan ve fren yolları AYNI kuyruğa girsin diye tek yerde. */
  function openTicket({ agentId, reason, why }) {
    // RG-CAP-01 — AYNI ÇAĞIRAN İKİ BİLET ALMAZ. Geri çekilmeli tekrar (10/20/40/…)
    // aynı alt-görevi yeniden dener; her denemeye yeni bir bilet yazmak "kaç pane
    // bekliyor" sayısını denemeler kadar ŞİŞİRİR. Kimliği olan çağıranın bileti
    // TAZELENİR (ömrü uzar), kimliksiz çağıran (elle spawn) yeni bilet alır.
    const existing = agentId ? liveTickets().find((t) => t.agentId === agentId) : null;
    if (existing) {
      existing.at = now();
      existing.why = why;
      existing.reason = reason;
      onChange(state());
      return { admit: false, ticket: existing, state: state() };
    }
    const id = `cap-${++seq}-${now().toString(36)}`;
    const ticket = { id, agentId, reason, why, at: now() };
    tickets.set(id, ticket);
    log(`resourceGovernor: kapasite bileti ${id} (ajan=${agentId || '?'} sebep=${why})`);
    onChange(state());
    return { admit: false, ticket, state: state() };
  }

  /** Yürürlükteki eşzamanlı pane tavanı (0 = sınırsız). */
  function paneCap() {
    return effectivePaneCap(settings, last.totalBytes || (io.totalmem || os.totalmem)());
  }

  /**
   * PERF-FLEET-01 — main.js'in `mainStallMonitor.onStall`'undan çağrılır.
   * Damgayı ALIR ve seviyeyi HEMEN yeniden yargılar: 30 saniyelik bir durmanın
   * 5 saniyelik örnekleme turunu beklemesi, tam da kullanıcının hiçbir şey
   * görmediği o iki dakikayı geri getirirdi.
   */
  function noteStall(ev) {
    const driftMs = Number(ev && ev.driftMs);
    const floor = Number.isFinite(settings.stallWarnMs) ? settings.stallWarnMs : DEFAULTS.stallWarnMs;
    // Eşiğin ALTINDA hiç damga koyma: monitör 250 ms'den yazar, kullanıcı kartı
    // saniyede birkaç kez yanıp sönmemeli.
    if (!Number.isFinite(driftMs) || driftMs < floor) return state();
    // Yalnız DAHA KÖTÜSÜ damgayı tazeler; pencere içindeki en ağır durma kalır.
    if (!stall || now() - stall.at > (settings.stallWindowMs ?? DEFAULTS.stallWindowMs) || driftMs > stall.driftMs) {
      stall = { driftMs, at: now() };
    }
    const verdict = computeLevel(
      { freePct: last.freePct, swapUsedMB: last.swapUsedMB, osPressure: last.osPressure, stallMs: currentStallMs() },
      settings,
    );
    const changed = verdict.level !== last.level;
    last = { ...last, ...verdict, stallMs: currentStallMs() };
    if (changed) {
      log(`resourceGovernor: seviye ${verdict.level} (${verdict.reasons.join(' · ')})`);
      onChange(state());
    }
    return state();
  }

  /** Bileti kapat (spawn sonunda başarı ya da vazgeçme). */
  function release(ticketId) {
    if (ticketId && tickets.delete(ticketId)) onChange(state());
  }

  /** "Yine de aç" — süre-kutulu onay; bekleyen tüm biletler serbest. */
  function allowAnyway(ms) {
    const span = Number.isFinite(ms) && ms > 0 ? ms : settings.overrideMs;
    overrideUntil = now() + span;
    const freed = tickets.size;
    tickets.clear();
    log(`resourceGovernor: "yine de aç" — ${Math.round(span / 1000)} sn boyunca eşik yok (${freed} bilet serbest)`);
    onChange(state());
    return { ok: true, until: overrideUntil, freed };
  }

  /** Ayarları güncelle (Ayarlar ekranı). Bilinmeyen alanlar yok sayılır. */
  function configure(patch) {
    const next = { ...settings };
    if (patch && typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
    // PERF-FLEET-01 kontrol kolları — ikisi de KAPATILABİLİR (eski davranış geri gelir).
    if (patch && typeof patch.osPressureGate === 'boolean') next.osPressureGate = patch.osPressureGate;
    if (patch && typeof patch.paneCapEnabled === 'boolean') next.paneCapEnabled = patch.paneCapEnabled;
    for (const k of ['warnFreePct', 'criticalFreePct', 'sampleMs', 'overrideMs', 'maxPanes', 'stallCriticalMs', 'stallWarnMs', 'stallWindowMs', 'ticketTtlMs']) {
      const v = Number(patch && patch[k]);
      if (Number.isFinite(v) && v >= 0) next[k] = v;
    }
    // Tutarlılık: kritik eşik uyarı eşiğini geçemez (geçseydi 'warn' hiç görünmezdi).
    if (next.criticalFreePct > next.warnFreePct) next.criticalFreePct = next.warnFreePct;
    settings = next;
    log(`resourceGovernor: ayar açık=${settings.enabled} uyarı=%${settings.warnFreePct} kritik=%${settings.criticalFreePct}`);
    // Eşik değişti → mevcut ölçümü YENİ eşiklerle yeniden yargıla (bekleyen
    // kullanıcı "kapattım ama hâlâ bekliyor" görmesin).
    const verdict = computeLevel(
      { freePct: last.freePct, swapUsedMB: last.swapUsedMB, osPressure: last.osPressure, stallMs: currentStallMs() },
      settings,
    );
    last = { ...last, ...verdict };
    if (!settings.enabled || last.level !== 'critical') tickets.clear();
    onChange(state());
    return state();
  }

  function state() {
    return {
      level: last.level,
      reasons: last.reasons,
      measured: last.measured,
      freePct: last.freePct,
      availableBytes: last.availableBytes ?? null,
      totalBytes: last.totalBytes ?? null,
      swapUsedMB: last.swapUsedMB ?? null,
      osPressure: last.osPressure ?? null,
      at: last.at,
      settings: { ...settings },
      overrideUntil,
      overrideActive: now() < overrideUntil,
      waiting: liveTickets(), // RG-CAP-01 — süresi dolmuş bilet sayılmaz
      webglCap: WEBGL_CONTEXT_CAP,
      visibleWebglBudget: VISIBLE_WEBGL_BUDGET,
      // PERF-FLEET-01 — rozet/kart bunları OLDUĞU GİBİ gösterir; renderer'da
      // ikinci bir "tavan doldu mu" hesabı YOKTUR (karar main'de).
      paneCap: paneCap(),
      liveCount: liveCountSeen,
      stallMs: currentStallMs(),
    };
  }

  return { sample, admit, release, allowAnyway, configure, state, noteStall, paneCap };
}

module.exports = {
  DEFAULTS,
  PANE_COST_BYTES,
  FLEET_BUDGET_RATIO,
  MIN_PANE_CAP,
  derivePaneCap,
  effectivePaneCap,
  WEBGL_CONTEXT_CAP,
  VISIBLE_WEBGL_BUDGET,
  parseVmStat,
  parseMemInfo,
  readMemory,
  readOsPressure,
  readSwapMB,
  computeLevel,
  heavierThan,
  finishedPanes,
  createGovernor,
};
