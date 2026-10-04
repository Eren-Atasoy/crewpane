'use strict';

// VOICE-TRUNC-01 — ANA SÜREÇ DURMA MONİTÖRÜ (main-thread stall monitor).
//
// ÖLÇÜLEN kök neden (docs/agent-results/VOICE-TRUNC-01-bumblebee.md §B): AgentVoice
// dikteyi 20'şer karakterlik AYRI klavye olayları olarak basar (698 karakter = 35 olay,
// 5.087 karakter = 255 olay). Electron'un ANA süreci (browser main thread) burst
// sırasında ≥ ~600 ms yanıt vermezse macOS kuyruktaki sentetik tuş olaylarını
// DÜŞÜRÜR: 700 ms blokajda 255 olayın 45'i (bir turda 0'ı) sayfaya ulaştı; 150/300/500
// ms'de hepsi ulaştı; renderer'ın 700 ms blokajı ise HİÇ kayıp üretmedi (olaylar
// tarayıcı sürecinde kuyruklanır). Olay gecesi neyin durdurduğu bilinmiyor — ana
// günlükte durma izi YOK. Bu modül o izi bırakır: bir sonraki kayıpta "hangi saniyede,
// kaç ms" sorusu günlükten okunur.
//
// Saf çekirdek (Electron'suz, `node --test` doğrudan yükler): zamanlayıcının BEKLENEN
// ve GERÇEK uyanma anı arasındaki sapma = ana thread'in o aralıkta bloke kaldığı süre.
// main.js yalnız `setInterval` + `logLine` bağlar.

//
// RG-STALL-01 — İKİ SAAT + AKLA YATKINLIK TAVANI (RG-CAP-01 §3.2-3.3, §6(B)).
// ÖLÇÜLDÜ: zamanlayıcı uyku/askı boyunca hiç ateşlenmez; uyanışta tek tikte TÜM süre
// "ana süreç durması" sanılıyordu (45 dk uyku → driftMs 2.699.900 → `resourceGovernor`
// seviyesi CRITICAL, bellek %71,4 BOŞken → delegasyon dalgası tek worker'a iniyordu).
// Düzeltme İKİ kemerlidir, çünkü monotonik saat TEK BAŞINA yetmiyor (ölçüldü: süreç
// `SIGSTOP` ile 3 sn askıya alındığında Date.now ve hrtime AYNI sapmayı verir):
//   (1) sapma `process.hrtime.bigint()` ile ölçülür — sistem uykusunu saymaz;
//   (2) her iki saatten biri TAVANI (60 sn) aşarsa hüküm "durma" değil
//       "saat sıçraması / askıya alınma"dır: `[main-clock-jump]` satırı yazılır,
//       `onStall` ÇAĞRILMAZ (yani bekçi seviyesi yükselmez).
// Tavan ÖLÇÜLMÜŞ bir sayıdır, eşik gevşetmesi DEĞİL: görülen en ağır GERÇEK durma
// 29,673 sn'dir ve 60 sn'lik gerçek bir ana-süreç blokajı uygulamayı zaten
// kullanılamaz yapar — o sayıyı "durma" saymak ölçüm hatasıdır.

const DEFAULT_TICK_MS = 100;
/** Kayıp uçurumunun (≈600 ms) yarısı: uyarı erken düşsün, gürültü de olmasın. */
const DEFAULT_THRESHOLD_MS = 250;
/**
 * RG-STALL-01 — akla yatkınlık tavanı (ms). Bunun ÜSTÜNDEKİ sapma durma sayılmaz.
 * Gerekçe: en ağır ÖLÇÜLEN gerçek durma 29,673 sn; `resourceGovernor.stallWindowMs`
 * zaten 60 sn ⇒ tavan = gerçek en kötünün ~2 katı. 0 / sonsuz / geçersiz ⇒ tavan KAPALI.
 */
const DEFAULT_MAX_PLAUSIBLE_STALL_MS = 60 * 1000;

/** Monotonik saat (ms, kesirli). macOS'ta mach_absolute_time — sistem uykusunu saymaz. */
function monotonicNowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

/** Tavan etkin mi? (0, negatif, NaN, Infinity ⇒ KAPALI — kontrol kolu bunu kullanır.) */
function ceilingOf(value) {
  const v = value === undefined ? DEFAULT_MAX_PLAUSIBLE_STALL_MS : value;
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Bir tik için hüküm. → { stalled, driftMs }
 * `driftMs` = gerçek geçen süre − beklenen tik süresi (negatifse 0).
 */
function assessTick(prevAt, now, tickMs) {
  if (typeof prevAt !== 'number' || typeof now !== 'number') return { stalled: false, driftMs: 0 };
  const driftMs = Math.max(0, now - prevAt - tickMs);
  return { stalled: false, driftMs };
}

/** Tek satırlık günlük mesajı — grep'lenebilir sabit önek. */
function formatStall(driftMs, at) {
  return `[main-stall] ana süreç ~${Math.round(driftMs)} ms yanıt vermedi (at=${new Date(at).toISOString()})`;
}

/**
 * RG-STALL-01 — tavanı aşan sapmanın satırı. `[main-stall]` ile KARIŞMASIN diye ayrı
 * önek: bu satır bir sağlık uyarısı değil, "ölçüm durma değildi" itirafıdır.
 */
function formatClockJump(wallDriftMs, monoDriftMs, at) {
  return `[main-clock-jump] wall=${Math.round(wallDriftMs)} ms mono=${Math.round(monoDriftMs)} ms `
    + `— saat sıçraması/askıya alınma, durma SAYILMADI (at=${new Date(at).toISOString()})`;
}

/**
 * RG-STALL-01 — iki saatli hüküm. → { kind, driftMs, wallDriftMs, monoDriftMs }
 * `kind` ∈ {'ok','stall','clock-jump'} (kapalı küme).
 * `driftMs` (bekçiye giden sayı) MONOTONİK sapmadır; duvar saati yalnız sıçramayı yakalar.
 */
function classifyTick(prev, cur, opts) {
  const o = opts || {};
  const tickMs = o.tickMs || DEFAULT_TICK_MS;
  const thresholdMs = o.thresholdMs || DEFAULT_THRESHOLD_MS;
  const ceiling = ceilingOf(o.maxPlausibleStallMs);
  const wallDriftMs = assessTick(prev.wallAt, cur.wallAt, tickMs).driftMs;
  const monoDriftMs = assessTick(prev.monoAt, cur.monoAt, tickMs).driftMs;
  const out = { kind: 'ok', driftMs: monoDriftMs, wallDriftMs, monoDriftMs };
  // Tavanı HANGİ saat aşarsa aşsın sıçramadır: uyku duvar saatini, askıya alınma
  // (SIGSTOP/App Nap) İKİSİNİ birden şişirir — ikisi de "ana süreç bozuldu" değildir.
  if (ceiling !== null && (wallDriftMs > ceiling || monoDriftMs > ceiling)) {
    out.kind = 'clock-jump';
    return out;
  }
  if (monoDriftMs >= thresholdMs) out.kind = 'stall';
  return out;
}

/**
 * Monitörü kur. Enjekte edilebilir zamanlayıcı/saat → testte gerçek bekleme yok.
 * @param {object} deps
 * @param {(fn:Function, ms:number)=>any} deps.setInterval
 * @param {(t:any)=>void} deps.clearInterval
 * @param {()=>number} deps.now
 * @param {(line:string)=>void} deps.log
 * @param {()=>number} [deps.monotonicNow] RG-STALL-01 — monotonik saat (ms); vars. hrtime.
 * @param {number} [deps.tickMs]
 * @param {number} [deps.thresholdMs]
 * @param {number} [deps.maxPlausibleStallMs] RG-STALL-01 tavanı; 0/sonsuz ⇒ KAPALI.
 * @param {(ev:{driftMs:number, at:number})=>void} [deps.onStall]
 */
function createStallMonitor(deps) {
  const tickMs = deps.tickMs || DEFAULT_TICK_MS;
  const thresholdMs = deps.thresholdMs || DEFAULT_THRESHOLD_MS;
  const maxPlausibleStallMs = ceilingOf(deps.maxPlausibleStallMs);
  const monotonicNow = typeof deps.monotonicNow === 'function' ? deps.monotonicNow : monotonicNowMs;
  let timer = null;
  let prevAt = null;
  let prevMonoAt = null;
  // RG-STALL-01 — uyandıktan sonraki İLK tik hüküm vermez: o tik uykunun kendisini ölçer.
  let skipNextTick = false;
  let suspended = false;
  const stats = {
    ticks: 0, stalls: 0, worstMs: 0, lastStallAt: null,
    clockJumps: 0, lastClockJumpAt: null, skippedTicks: 0,
  };

  const reset = (wallAt, monoAt) => { prevAt = wallAt; prevMonoAt = monoAt; };

  const tick = () => {
    const now = deps.now();
    const monoNow = monotonicNow();
    // Askıdayken (powerMonitor 'suspend' ile 'resume' arası) hiçbir tik hüküm vermez.
    if (suspended) { reset(now, monoNow); return; }
    if (skipNextTick) {
      skipNextTick = false;
      stats.skippedTicks += 1;
      reset(now, monoNow);
      return;
    }
    if (prevAt !== null) {
      const v = classifyTick(
        { wallAt: prevAt, monoAt: prevMonoAt },
        { wallAt: now, monoAt: monoNow },
        { tickMs, thresholdMs, maxPlausibleStallMs },
      );
      if (v.kind === 'clock-jump') {
        stats.clockJumps += 1;
        stats.lastClockJumpAt = now;
        // Günlüğe YAZILIR ama `onStall` ÇAĞRILMAZ: bekçi seviyesi bundan yükselmez.
        try { deps.log(formatClockJump(v.wallDriftMs, v.monoDriftMs, now)); } catch { /* günlük asla monitörü düşürmez */ }
      } else if (v.kind === 'stall') {
        const driftMs = v.driftMs;
        stats.stalls += 1;
        stats.lastStallAt = now;
        if (driftMs > stats.worstMs) stats.worstMs = driftMs;
        try { deps.log(formatStall(driftMs, now)); } catch { /* günlük asla monitörü düşürmez */ }
        if (typeof deps.onStall === 'function') {
          try { deps.onStall({ driftMs, at: now }); } catch { /* aynı */ }
        }
      }
    }
    reset(now, monoNow);
    stats.ticks += 1;
  };

  return {
    start() {
      if (timer) return;
      reset(deps.now(), monotonicNow());
      timer = deps.setInterval(tick, tickMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      if (!timer) return;
      deps.clearInterval(timer);
      timer = null;
      reset(null, null);
    },
    /** RG-STALL-01 — `powerMonitor('suspend')`: askıda ölçüm yok. */
    suspend() { suspended = true; skipNextTick = true; },
    /** RG-STALL-01 — `powerMonitor('resume')`: monitör sıfırlanır, İLK tik atlanır. */
    resume() { suspended = false; skipNextTick = true; reset(null, null); },
    /** Test/teşhis: bir tiki elle işlet. */
    _tick: tick,
    stats: () => ({ ...stats }),
    tickMs,
    thresholdMs,
    maxPlausibleStallMs,
  };
}

module.exports = {
  DEFAULT_TICK_MS, DEFAULT_THRESHOLD_MS, DEFAULT_MAX_PLAUSIBLE_STALL_MS,
  monotonicNowMs, assessTick, classifyTick, formatStall, formatClockJump, createStallMonitor,
};
