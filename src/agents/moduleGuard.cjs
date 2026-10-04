'use strict';
// ADP-335 — MODÜL HATA SINIRI (main süreci).
//
// EREN'IN VAKASI (2026-07-13): `paneScreen.cjs`'te sıradan bir ReferenceError
// (`totalScrolled is not defined`) xterm'in write callback'inde ATILDI → asenkron olduğu için
// çağrı yerindeki try/catch'e uğramadı → uncaughtException → "A JavaScript error occurred in
// the main process" diyaloğu → Eren'in ÇALIŞAN OFİSİ öldü. Yani bir ajanın yazdığı tek satır
// kötü kod, tüm uygulamayı (12 pane, gateway, ofis) yere seriyordu. Kabul edilemez: ajanlar
// geliştirirken patron çalışmaya devam edebilmeli.
//
// SÖZLEŞME (bu modül):
//   • Bir modülün her riskli çağrısı bir SINIR içinde koşar: patlarsa YALNIZ o çağrı ölür.
//   • Hata yutulmaz, RAPORLANIR (log + bildirim): "modül X hata verdi (dosya:satır)".
//   • N ARDIŞIK hata → modül kendini DURDURUR (degraded) → sonsuz hata/log döngüsü yok.
//     Durduktan sonra çağrılar sessiz no-op'tur; özellik kaybolur, UYGULAMA YAŞAR.
//   • Bir başarı sayacı sıfırlar (geçici hata modülü kalıcı öldürmez).
//   • Timer'lar `safeInterval` ile korunur: patlayan callback timer'ı ÖLDÜREMEZ.
//
// Saf (Electron'suz) → `node --test` ile iki dal da kanıtlanabilir.

const DEFAULT_MAX_ERRORS = 5;

/** Yığından ilk "bizim" kare: "electron/paneScreen.cjs:87" (tıklanabilir bildirim için). */
function faultLocation(err) {
  const stack = (err && err.stack) || '';
  for (const line of String(stack).split('\n').slice(1)) {
    // node_modules / internal kareleri atla — suçlu BİZİM dosyamızdır
    if (/node_modules|node:internal|node:electron/.test(line)) continue;
    const m = /\(?((?:[A-Za-z]:)?[^():\s]+\.(?:cjs|js|mjs|ts)):(\d+):(\d+)\)?/.exec(line);
    if (!m) continue;
    const file = m[1].split(/[/\\]/).slice(-2).join('/'); // .../electron/paneScreen.cjs → electron/paneScreen.cjs
    return `${file}:${m[2]}`;
  }
  return null;
}

/**
 * @param {object} opts
 *   name       — modül adı (bildirimde görünür: "vt-harvest", "gateway", "store"…)
 *   maxErrors  — kaç ARDIŞIK hatadan sonra modül durur (varsayılan 5)
 *   onFault    — ({module, label, message, location, count, stopped, at}) → log + bildirim
 *   log        — satır logger (opsiyonel)
 */
function createSupervisor({ name, maxErrors = DEFAULT_MAX_ERRORS, onFault = () => {}, log = () => {} } = {}) {
  let consecutive = 0;
  let total = 0;
  let stopped = false;
  let lastFault = null;

  function report(err, label) {
    total += 1;
    consecutive += 1;
    const justStopped = !stopped && consecutive >= maxErrors;
    if (justStopped) stopped = true;
    const fault = {
      module: name,
      label: label || null,
      message: String((err && err.message) || err),
      location: faultLocation(err),
      count: total,
      stopped,
      at: Date.now(),
    };
    lastFault = fault;
    log(`module-fault ${name}${label ? `/${label}` : ''}: ${fault.message} @ ${fault.location || '?'}${stopped ? ' — MODÜL DURDURULDU' : ''}`);
    log(`  stack: ${(err && err.stack) || '(yok)'}`);
    // Raporlayıcının kendisi ASLA yeni bir çökme üretemez.
    // OBS-02 — ikinci argüman HAM HATA: `fault` bildirim merkezine giden (sabit
    // şekilli) kayıttır, `err` ise yalnız hata takibinin okuduğu yığın izini taşır.
    // Stack `fault`a KONMAZ: o nesne IPC ile renderer'a gidiyor ve kartın sözleşmesi
    // genişlemesin. Eski çağıranlar tek argümanla çalışmaya devam eder.
    try { onFault(fault, err); } catch { /* yut */ }
    return fault;
  }

  /**
   * Senkron çağrıyı sınırla. Modül durmuşsa çağrı hiç koşmaz (no-op).
   * @returns fn'in dönüşü, ya da hata/durdurulmuş hâlde `fallback`.
   */
  function run(label, fn, fallback = undefined) {
    if (stopped) return fallback;
    try {
      const out = fn();
      consecutive = 0; // başarı → ardışık sayaç sıfırlanır (geçici hata kalıcı öldürmez)
      return out;
    } catch (err) {
      report(err, label);
      return fallback;
    }
  }

  /** Promise dönen çağrıyı sınırla (reject de yakalanır). */
  async function runAsync(label, fn, fallback = undefined) {
    if (stopped) return fallback;
    try {
      const out = await fn();
      consecutive = 0;
      return out;
    } catch (err) {
      report(err, label);
      return fallback;
    }
  }

  /** Fonksiyonu kalıcı olarak sınırla (callback/dinleyici geçerken). */
  const wrap = (label, fn, fallback) => (...args) => run(label, () => fn(...args), fallback);

  /**
   * TIMER KORUMASI: patlayan callback timer'ı öldürmez; modül durursa timer da temizlenir
   * (sonsuz hata döngüsü yok). Dönen değer normal timer handle'ı gibi clear edilebilir.
   */
  function safeInterval(label, fn, ms, { setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
    const handle = setIntervalFn(() => {
      run(label, fn);
      if (stopped) clearIntervalFn(handle); // modül öldü → tık tık etmeyi bırak
    }, ms);
    if (handle && typeof handle.unref === 'function') handle.unref();
    return handle;
  }

  return {
    run,
    runAsync,
    wrap,
    safeInterval,
    /** Testler/UI için durum. */
    state: () => ({ module: name, stopped, errors: total, consecutive, lastFault }),
    /** Modülü elle yeniden aç (kullanıcı "tekrar dene" derse). */
    reset: () => { stopped = false; consecutive = 0; },
    isStopped: () => stopped,
  };
}

module.exports = { createSupervisor, faultLocation, DEFAULT_MAX_ERRORS };
