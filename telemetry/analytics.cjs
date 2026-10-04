// OBS-01 — ÜRÜN ANALİTİĞİ: TEK GÖNDERİM YOLU (aktivasyon hunisi · panel kullanımı
// · plan limiti redleri → PostHog).
//
// ─── TASARIM KURALI: KÖPRÜ KUR, PARALEL SİSTEM KURMA ─────────────────────────
// Bu modül OBS-02'nin `errorReporter.cjs`'inin analitik ikizidir ve aynı iskeleti
// bilerek paylaşır (canlı kapı · damga · hız sınırı · tek ağ boğazı · asla throw
// etmez). İkinci bir altyapı KURULMADI:
//   • Gizlilik sözleşmesi TEK: `analyticsSchema` + `scrub.cjs` (aynı süzgeç).
//   • Kanal/anahtar çözümü TEK: `channel.cjs` (Sentry DSN'i ile aynı dosya, aynı
//     güvenlik kilidi — dev kanal prod projesine yazamaz).
//   • Kapatma anahtarı TEK: `settings.telemetryEnabled` (Ayarlar → Gizlilik).
//     İkinci bir "analitiği kapat" anahtarı YOK (görev gereksinimi 4).
//   • Ölçüm noktaları TEK: main.js'te ZATEN var olan `telemetryBump` musluğu ve
//     `pushPlanLimit`. Bu dosya yeni bir kanca AÇMAZ.
//
// ─── KAPALI = SIFIR İSTEK ────────────────────────────────────────────────────
// `enabled()` HER olayda CANLI okunur. Ayrıca kuyruk da kapıdan SONRA doldurulur:
// kapalıyken olay tampona bile GİRMEZ — yoksa kullanıcı kapatır, sonra açar ve
// kapalıyken biriken olaylar geriye dönük giderdi. Ağ çağrısı tek yerde
// (`flush` → `wire.sendBatch`) ve o da kapının arkasında.
//
// ─── NEDEN TAMPON (BATCH) ────────────────────────────────────────────────────
// Panel sekmesi tıklamaları saniyede birkaç olay üretebilir. Her olay için ayrı
// HTTPS bağlantısı hem pil hem ağ israfıdır. Olaylar `flushIntervalMs` boyunca
// (ya da `maxBatch` dolana kadar) bellekte bekler, sonra TEK istekte gider.
// Tampon DİSKE YAZILMAZ: uygulama çökerse son birkaç olay kaybolur — kabul.
// Analitik bir yan etkidir; kalıcılık için ikinci bir depo açmak, gizlilik
// yüzeyini (diskte bekleyen olay dosyası) bedavaya büyütürdü.
//
// Saf + DI: electron bağı yok → `node --test`.

'use strict';

const schema = require('./analyticsSchema.cjs');
const wire = require('./posthogWire.cjs');

const DEFAULT_FLUSH_MS = 15_000;
const DEFAULT_MAX_BATCH = 20;
/** Kaçak bir döngü panoyu (ve faturayı) doldurmasın. */
const DEFAULT_MAX_PER_MINUTE = 120;
/** Tampon taşarsa EN ESKİ olay düşer — bellek sınırsız büyümez. */
const MAX_QUEUE = 200;

/**
 * @param {object} opts
 * @param {string|null} opts.apiKey        PostHog proje anahtarı (yoksa sessiz)
 * @param {string} [opts.host]             ingest hostu (varsayılan AB bulutu)
 * @param {()=>boolean} opts.enabled       CANLI opt-out okuması
 * @param {()=>string|null} opts.distinctId kurulum kimliği (uuid)
 * @param {()=>object} [opts.base]         ortak damga üreteci (sürüm/platform/tier…)
 * @param {(events:Array)=>Promise<object>} [opts.send] DI taşıyıcı
 * @param {(line:string)=>void} [opts.log]
 * @param {()=>number} [opts.now]
 * @param {(fn:Function,ms:number)=>any} [opts.setInterval]
 */
function createAnalytics(opts = {}) {
  const apiKey = (typeof opts.apiKey === 'string' && opts.apiKey.trim()) || null;
  const host = opts.host || undefined;
  const enabled = typeof opts.enabled === 'function' ? opts.enabled : () => true;
  const distinctIdOf = typeof opts.distinctId === 'function' ? opts.distinctId : () => null;
  const baseOf = typeof opts.base === 'function' ? opts.base : () => ({});
  const log = opts.log || (() => {});
  const now = opts.now || (() => Date.now());
  const flushMs = opts.flushIntervalMs || DEFAULT_FLUSH_MS;
  const maxBatch = opts.maxBatch || DEFAULT_MAX_BATCH;
  const maxPerMinute = opts.maxPerMinute || DEFAULT_MAX_PER_MINUTE;

  const queue = [];
  let windowStart = now();
  let windowCount = 0;
  let timer = null;
  const stats = {
    attempted: 0, queued: 0, dropped: 0, rateLimited: 0,
    unknownEvent: 0, droppedProps: 0, batches: 0, failed: 0,
  };

  function rateOk() {
    const t = now();
    if (t - windowStart >= 60_000) { windowStart = t; windowCount = 0; }
    if (windowCount >= maxPerMinute) return false;
    windowCount += 1;
    return true;
  }

  /**
   * Bir olayı kaydet. ASLA throw etmez — analitik hata üretemez.
   * @param {string} name  `analyticsSchema.EVENTS` içinde OLMAK ZORUNDA
   * @param {object} [props]
   * @returns {{sent:boolean, reason?:string, event?:object}}
   *   `sent` = "kuyruğa alındı" demektir (gerçek gönderim toplu ve asenkron).
   */
  function track(name, props) {
    try {
      stats.attempted += 1;

      // 1) KAPI — anahtar yok / opt-out. Kuyruğa BİLE girmez, ağ katmanına hiç inilmez.
      if (!apiKey) { stats.dropped += 1; return { sent: false, reason: 'no-key' }; }
      if (!enabled()) { stats.dropped += 1; return { sent: false, reason: 'opt-out' }; }
      const distinctId = distinctIdOf();
      if (!schema.isDistinctId(distinctId)) { stats.dropped += 1; return { sent: false, reason: 'no-identity' }; }

      // 2) ŞEMA — bilinmeyen olay REDDEDİLİR, bilinmeyen alan DÜŞER.
      const clean = schema.sanitize(name, { ...baseOf(), ...(props || {}) });
      if (!clean.ok) {
        stats.unknownEvent += 1;
        log(`analytics: bilinmeyen olay reddedildi (${name})`);
        return { sent: false, reason: clean.reason };
      }
      if (clean.dropped.length) {
        stats.droppedProps += clean.dropped.length;
        log(`analytics: şema dışı alan düştü (${name}: ${clean.dropped.join(', ')})`);
      }

      // 3) Hız sınırı
      if (!rateOk()) { stats.rateLimited += 1; return { sent: false, reason: 'rate-limited' }; }

      const event = { name: clean.name, properties: clean.properties, timestamp: now() };
      queue.push(event);
      stats.queued += 1;
      if (queue.length > MAX_QUEUE) { queue.shift(); stats.dropped += 1; }
      if (queue.length >= maxBatch) flush('full');
      else armTimer();
      return { sent: true, event };
    } catch (e) {
      stats.failed += 1;
      try { log(`analytics: track hatası (yutuldu): ${e && e.message}`); } catch { /* son çare */ }
      return { sent: false, reason: 'internal' };
    }
  }

  function armTimer() {
    if (timer || typeof setTimeout !== 'function') return;
    timer = setTimeout(() => { timer = null; flush('timer'); }, flushMs);
    if (timer && typeof timer.unref === 'function') timer.unref(); // çıkışı geciktirme
  }

  /**
   * Kuyruğu TEK istekte gönder. Kapı BURADA DA var: kullanıcı olayları
   * kuyruğa aldıktan sonra telemetriyi kapattıysa kuyruk ATILIR, gönderilmez.
   * @param {string} [why]
   */
  function flush(why) {
    try {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!queue.length) return { sent: false, reason: 'empty' };
      if (!apiKey) { queue.length = 0; return { sent: false, reason: 'no-key' }; }
      if (!enabled()) {
        // Kapatma ANINDA etkili: bekleyen olaylar da gitmez.
        const n = queue.length;
        queue.length = 0;
        stats.dropped += n;
        return { sent: false, reason: 'opt-out' };
      }
      const distinctId = distinctIdOf();
      if (!schema.isDistinctId(distinctId)) { queue.length = 0; return { sent: false, reason: 'no-identity' }; }

      const events = queue.splice(0, queue.length);
      stats.batches += 1;
      const send = opts.send || ((evs) => wire.sendBatch({ apiKey, host, distinctId, events: evs }));
      let p;
      try { p = send(events, { distinctId, apiKey, host }); }
      catch (e) { stats.failed += 1; log(`analytics: gönderim hatası: ${e && e.message}`); return { sent: false, reason: 'send-threw' }; }
      if (p && typeof p.then === 'function') {
        p.then(
          (res) => { if (res && res.ok === false) { stats.failed += 1; log(`analytics: ingest reddetti (${res.status || res.error})`); } },
          (e) => { stats.failed += 1; log(`analytics: gönderim hatası: ${e && e.message}`); },
        );
      }
      return { sent: true, count: events.length, why: why || 'manual' };
    } catch (e) {
      stats.failed += 1;
      try { log(`analytics: flush hatası (yutuldu): ${e && e.message}`); } catch { /* son çare */ }
      return { sent: false, reason: 'internal' };
    }
  }

  return {
    track,
    flush,
    stats: () => ({ ...stats }),
    /** Kuyruk derinliği — yalnız test/kanıt görünürlüğü. */
    pending: () => queue.length,
    /** "Bugün tek bir istek çıkar mı?" sorusunun tek satırlık cevabı. */
    enabledNow: () => !!apiKey && enabled() && schema.isDistinctId(distinctIdOf()),
  };
}

module.exports = { createAnalytics, DEFAULT_MAX_PER_MINUTE, MAX_QUEUE };
