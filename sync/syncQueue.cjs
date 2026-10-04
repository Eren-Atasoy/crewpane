// SYNC-F1-3 (Wheeljack) — OFFLINE KUYRUK: yerel değişiklik diske yazılır, ağa değil.
//                         Tasarım: SYNC-F1-TASARIM.md §2.7 · §6 (kill-switch)
//
// ═══════════════════════════════════════════════════════════════════════════════
// NEDEN DİSKTE BİR KUYRUK — bellekte bir dizi neden YETMEZ
// ═══════════════════════════════════════════════════════════════════════════════
// Uçak modunda yazılan bir hafıza dosyası, uygulama kapanınca bellekteki kuyrukla
// birlikte gider. Bir sonraki açılışta tarayıcı onu yine görür (mtime/sha değişmiş)
// — YANİ kayıp değil, GECİKME. Ama tek bir durumda gerçek kayıp olur: dosya
// yazıldı, senkron olmadı, KULLANICI dosyayı sildi. Diskteki kuyruk o pencereyi
// kapatır ve "beklemede N" sayısını dürüst kılar.
//
// ─────────────────────────────────────────────────────────────────────────────
// GİRDİ YOL BAŞINA TEKİLDİR (§2.7)
// ─────────────────────────────────────────────────────────────────────────────
// Aynı dosya 10 kez değişse kuyrukta 1 girdi kalır — SON hâli. Bir ajan tek turda
// bir hafıza dosyasına 30 kez `appendFileSync` yapabilir; her birini ayrı bir
// yükleme yapmak 30 gereksiz istek + 30 gereksiz `rev` artışı demektir.
// Birleştirme sırasında geri-çekilme takvimi KORUNUR: yeni içerik, süren bir
// cezayı sıfırlamaz (sunucu 500 veriyorsa dosyanın değişmesi bunu düzeltmez).
//
// ─────────────────────────────────────────────────────────────────────────────
// 401/403 ⇒ DUR, YENİDEN DENEME (§2.7)
// ─────────────────────────────────────────────────────────────────────────────
// Yetki hatası bir "geçici arıza" değildir: jeton ölmüştür, yeniden giriş gerekir.
// `transient` sayılsaydı istemci her 2-5 dakikada bir 403 yiyen sonsuz bir döngüye
// girerdi. `halt()` kuyruğu DURDURUR, sebebi saklar ve durumu IPC'ye taşır.
//
// Saf değil ama TAM DI: `fs`/`now`/`atomicWrite` enjekte edilebilir.

'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { atomicWriteFileSync } = require('../platform/atomicWrite.cjs');

const VERSION = 1;

/** Geri-çekilme merdiveni (§2.7): 2s -> 4s -> ... -> 5 dk tavan. */
const BACKOFF_MS = [2000, 4000, 8000, 16000, 32000, 64000, 128000, 300000];

/** Kuyruk tavanı (§2.7/§6): aşılırsa senkron KENDİNİ KAPATIR, sessizce yemez. */
const MAX_ENTRIES = 5000;

/** Bir girdinin kalıcı hata sayılmadan önce denenme sayısı. */
const MAX_ATTEMPTS = 12;

function keyOf(classId, relPath) {
  return `${classId}|${relPath}`;
}

function backoffFor(attempts) {
  const i = Math.min(Math.max(attempts - 1, 0), BACKOFF_MS.length - 1);
  return BACKOFF_MS[i];
}

/**
 * @param {{file:string, fs?:object, path?:object, now?:Function, log?:Function,
 *          maxEntries?:number, maxAttempts?:number, writeAtomic?:Function}} deps
 */
function createSyncQueue(deps = {}) {
  const fs = deps.fs || nodeFs;
  const path = deps.path || nodePath;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const maxEntries = Number.isFinite(deps.maxEntries) ? deps.maxEntries : MAX_ENTRIES;
  const maxAttempts = Number.isFinite(deps.maxAttempts) ? deps.maxAttempts : MAX_ATTEMPTS;
  const writeAtomic = typeof deps.writeAtomic === 'function' ? deps.writeAtomic : atomicWriteFileSync;
  const file = deps.file;
  if (!file) throw new Error('syncQueue: file zorunlu');

  /** @type {Map<string, object>} — ekleme sırası KORUNUR (Map bunu garanti eder). */
  let entries = new Map();
  let halted = null;   // {reason, at, detail} | null
  let disabled = null; // kill-switch: {reason, at, detail}
  let dirty = false;

  /**
   * Diskten oku. BOZUK DOSYA = BOŞ KUYRUK (hata değil).
   * Gerekçe: yarım bir JSON yüzünden açılmayan bir senkron, senkronsuz bir
   * senkrondur. Bedeli bir turluk yeniden tarama (tarayıcı zaten tüm ağacı
   * görüyor); alternatifi ise açılışta ölen bir motor.
   */
  function load() {
    entries = new Map();
    halted = null;
    disabled = null;
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { loaded: false }; }
    if (!raw || raw.version !== VERSION || !Array.isArray(raw.entries)) return { loaded: false };
    for (const e of raw.entries) {
      if (!e || typeof e.class !== 'string' || typeof e.relPath !== 'string') continue;
      entries.set(keyOf(e.class, e.relPath), {
        class: e.class,
        relPath: e.relPath,
        op: e.op === 'delete' ? 'delete' : 'upsert',
        sha256: typeof e.sha256 === 'string' ? e.sha256 : null,
        enqueuedAt: Number.isFinite(e.enqueuedAt) ? e.enqueuedAt : now(),
        attempts: Number.isFinite(e.attempts) ? e.attempts : 0,
        nextAttemptAt: Number.isFinite(e.nextAttemptAt) ? e.nextAttemptAt : 0,
        lastError: typeof e.lastError === 'string' ? e.lastError : null,
      });
    }
    halted = raw.halted && typeof raw.halted === 'object' ? raw.halted : null;
    disabled = raw.disabled && typeof raw.disabled === 'object' ? raw.disabled : null;
    return { loaded: true, size: entries.size };
  }

  function save() {
    const payload = JSON.stringify({
      version: VERSION,
      halted,
      disabled,
      entries: [...entries.values()],
    });
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch { /* dizin zaten var ya da yazılamaz — write hatası zaten görünür olur */ }
    writeAtomic(file, payload, { fs });
    dirty = false;
    return { bytes: Buffer.byteLength(payload) };
  }

  function flushIfDirty() {
    if (dirty) save();
  }

  /**
   * Girdi ekle/birleştir.
   * @param {{class:string, relPath:string, op?:'upsert'|'delete', sha256?:string}} item
   */
  function enqueue(item) {
    if (disabled) return { ok: false, reason: 'disabled' };
    if (!item || typeof item.class !== 'string' || typeof item.relPath !== 'string') {
      return { ok: false, reason: 'invalid' };
    }
    const key = keyOf(item.class, item.relPath);
    const prev = entries.get(key);
    if (!prev && entries.size >= maxEntries) {
      // KILL-SWITCH (§6): sessizce kaynak yeme, SÖYLE ve dur.
      disabled = { reason: 'queue-overflow', at: now(), detail: `kuyruk ${maxEntries} girdiyi aştı` };
      log(`[sync-queue] kuyruk tavanı (${maxEntries}) aşıldı — senkron KENDİNİ KAPATTI`);
      dirty = true; save();
      return { ok: false, reason: 'overflow' };
    }
    const op = item.op === 'delete' ? 'delete' : 'upsert';
    entries.set(key, {
      class: item.class,
      relPath: item.relPath,
      op,
      sha256: typeof item.sha256 === 'string' ? item.sha256 : null,
      enqueuedAt: prev ? prev.enqueuedAt : now(),
      // Geri-çekilme takvimi KORUNUR: içeriğin değişmesi sunucu arızasını çözmez.
      attempts: prev ? prev.attempts : 0,
      nextAttemptAt: prev ? prev.nextAttemptAt : 0,
      lastError: prev ? prev.lastError : null,
    });
    dirty = true;
    return { ok: true, coalesced: Boolean(prev), size: entries.size };
  }

  /** Şimdi denenebilecek girdiler (ekleme sırasıyla). */
  function ready(at = now()) {
    if (halted || disabled) return [];
    const out = [];
    for (const e of entries.values()) if (e.nextAttemptAt <= at) out.push(e);
    return out;
  }

  function markSuccess(classId, relPath) {
    const removed = entries.delete(keyOf(classId, relPath));
    if (removed) dirty = true;
    return removed;
  }

  /**
   * SYNC-CLOUD-01 — DURDURMANIN AÇIK KAPISI.
   *
   * `markFailure` yalnız kuyruktaki BİR GİRDİ hakkında konuşabilir; oysa "bulut
   * hazır değil" bilgisi çekme (pull) yolundan da gelebilir ve orada kuyruk girdisi
   * YOKTUR. O yol da durdurabilsin diye durdurma ayrı bir yöntem oldu.
   *
   * İLK SEBEP KORUNUR: ikinci bir durdurma çağrısı sebebi ezmez. Sebep bir teşhistir
   * ("neden durduk"); üzerine yazmak, kullanıcıya arızanın ikinci belirtisini asıl
   * nedenmiş gibi gösterirdi.
   */
  function halt(reason, detail) {
    if (halted) return { ok: true, halted: true, already: true };
    halted = { reason: String(reason || 'unknown'), at: now(), detail: detail == null ? null : String(detail).slice(0, 500) };
    dirty = true;
    save();
    return { ok: true, halted: true };
  }

  /**
   * Başarısızlık.
   * @param {{kind?:string, error?:string}} info — `kind:'auth'` ya da
   *   `kind:'cloud_not_ready'` ise kuyruk DURUR (girdi KUYRUKTA KALIR).
   */
  function markFailure(classId, relPath, info = {}) {
    const key = keyOf(classId, relPath);
    const e = entries.get(key);
    if (!e) return { ok: false, reason: 'not-found' };
    e.lastError = String(info.error || info.kind || 'unknown').slice(0, 500);

    // SEC-W3-B1b-S — ABONELİK DURUŞU. 'auth' ile AYNI kovaya konsaydı ayarlar
    // ekranı yine "Yeniden giriş yap" derdi ve kullanıcı çözümü olmayan bir
    // döngüye girerdi (ölçüldü: PAY-3D-CHECK-01 §3). Duruşun DAVRANIŞI 'auth'
    // ile aynıdır (dur, dosyayı KORU, tekrar deneme); ayrılan tek şey SEBEP —
    // ve sebep tek başına doğru cümlenin ön koşuludur.
    if (info.kind === 'subscription') {
      halted = { reason: 'subscription', at: now(), detail: e.lastError };
      log('[sync-queue] abonelik kapalı — kuyruk DURDU, dosya KORUNDU');
      dirty = true;
      return { ok: true, halted: true };
    }
    if (info.kind === 'auth') {
      halted = { reason: 'auth', at: now(), detail: e.lastError };
      log('[sync-queue] 401/403 — kuyruk DURDU, yeniden giriş gerekiyor');
      dirty = true;
      return { ok: true, halted: true };
    }
    // SYNC-CLOUD-01 — arka uç bu şemayı sunmuyor (PGRST205/PGRST106). Bu DOSYANIN
    // hatası değil ARKA UCUN durumudur: girdiyi düşürmek (eski davranış) dosyayı
    // ikinci cihaza hiç göndermeden sessizce kaybetmekti. Denemeyi de artırmayız —
    // 12 deneme sayacı bu duruşta anlamsız, arka uç hazır olunca ilk tur yeter.
    if (info.kind === 'cloud_not_ready') {
      halted = { reason: 'cloud-not-ready', at: now(), detail: e.lastError };
      log('[sync-queue] bulut hazır değil (tablo/şema yok) — kuyruk DURDU, dosya KORUNDU');
      dirty = true;
      return { ok: true, halted: true };
    }
    e.attempts += 1;
    if (info.kind === 'permanent' || e.attempts >= maxAttempts) {
      // Kalıcı hata: girdi kuyruktan ÇIKAR ama sessizce değil — çağıran
      // `sync_conflicts` satırı yazar (§2.7). Kuyrukta tutmak, her turda aynı
      // 400'ü yeniden yiyen bir zombi üretirdi.
      entries.delete(key);
      dirty = true;
      return { ok: true, dropped: true, permanent: true, attempts: e.attempts, error: e.lastError };
    }
    e.nextAttemptAt = now() + backoffFor(e.attempts);
    dirty = true;
    return { ok: true, retryAt: e.nextAttemptAt, attempts: e.attempts };
  }

  /** Yeniden giriş (ya da arka ucun hazırlanması) sonrası: durmayı kaldır, takvimi sıfırla. */
  function resume() {
    if (!halted) return { ok: true, resumed: false };
    halted = null;
    for (const e of entries.values()) { e.nextAttemptAt = 0; e.attempts = 0; }
    dirty = true;
    return { ok: true, resumed: true, size: entries.size };
  }

  /** Kill-switch'i kaldır (kullanıcının AÇIK eylemi — otomatik DEĞİL). */
  function reset() {
    entries = new Map();
    halted = null;
    disabled = null;
    dirty = true;
    save();
    return { ok: true };
  }

  function status() {
    return {
      queued: entries.size,
      halted: halted ? { ...halted } : null,
      disabled: disabled ? { ...disabled } : null,
      oldestAt: entries.size ? Math.min(...[...entries.values()].map((e) => e.enqueuedAt)) : null,
    };
  }

  return {
    load, save, flushIfDirty, enqueue, ready, markSuccess, markFailure,
    halt, resume, reset, status,
    size: () => entries.size,
    isHalted: () => Boolean(halted),
    isDisabled: () => Boolean(disabled),
    snapshot: () => [...entries.values()].map((e) => ({ ...e })),
    file,
  };
}

module.exports = { createSyncQueue, keyOf, backoffFor, BACKOFF_MS, MAX_ENTRIES, MAX_ATTEMPTS, VERSION };
