// ADP-715 — KULLANIM ÖLÇÜMÜ (minimum, gizlilik-dostu).
//
// AMAÇ: yalnız "kaç kişi GERÇEKTEN kullanıyor" sorusunu cevaplayacak kadar veri —
// fazlası DEĞİL. Toplanan: uygulama açıldı, hangi sürüm, hangi OS, hangi kanal,
// oturum süresi, ÖZELLİK kullanımı (KABA SAYAÇ — yalnız özellik ADI + adet, İÇERİK
// YOK). Prompt/ses metni/kod/dosya/anahtar ASLA girmez.
//
// ⚠️ İKİNCİ TELEMETRİ SİSTEMİ DEĞİL: bu modül yalnız içerik-free olayı ÜRETİR;
// nereye yazılacağı `sink` ile enjekte edilir ve VARSAYILAN HEDEF ADP-714
// (Bumblebee) paylaşılan Supabase heartbeat şemasıdır. Ayrı bir tablo/servis
// KURULMAZ — sink ADP-714 landing'inde ona bağlanır.
//
// Opt-out ve DSN kapıları telemetry.cjs ile aynı config'ten gelir; kapalıysa
// snapshot üretilir ama sink çağrılmaz (flush no-op).

'use strict';

// Sayaç anahtarı beyaz-listesi DEĞİL: özellik adları ÇAĞIRAN tarafça verilir, ama
// yalnız kısa, içerik-free etiketler olmalı (ör. 'capture', 'annotate', 'settings').
// Güvenlik: adı normalleştir — yalnız [a-z0-9_.-], 40 char cap (içerik sızmasın).
function normFeature(name) {
  return String(name || 'unknown').toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 40) || 'unknown';
}

function createUsage({ app, version, os, channel, now = Date.now } = {}) {
  const startedAt = now();
  const features = Object.create(null);
  let opened = false;

  return {
    /** Uygulama açıldı (oturum başı) — bir kez. */
    appOpened() { opened = true; },

    /** Bir özellik kullanıldı — yalnız adı sayılır, içerik ALINMAZ. */
    feature(name) {
      const k = normFeature(name);
      features[k] = (features[k] || 0) + 1;
    },

    /** İçerik-free anlık görüntü — sink'e giden TAM yük budur. */
    snapshot() {
      return {
        app,
        version,
        os,
        channel,
        opened,
        session_seconds: Math.max(0, Math.round((now() - startedAt) / 1000)),
        // Yalnız {özellik_adı: adet} — hiçbir değer içerik değil.
        features: { ...features },
      };
    },
  };
}

/**
 * Snapshot'ı hedefe yaz. `enabled` false ise (opt-out) HİÇBİR ŞEY göndermez.
 * `sink` ADP-714 heartbeat'ine bağlanır (varsayılan: no-op + log niyeti).
 * @returns {boolean} gönderildi mi
 */
async function flushUsage(usage, { enabled, sink } = {}) {
  if (!enabled) return false;               // opt-out kapısı — sink çağrılmaz
  if (typeof sink !== 'function') return false; // ADP-714 sink henüz bağlı değil
  await sink(usage.snapshot());
  return true;
}

module.exports = { createUsage, flushUsage, normFeature };
