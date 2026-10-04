// OBS-02 — TEK HATA YOLU (main · renderer · worker pane → Sentry).
//
// ─── TASARIM KURALI: KÖPRÜ KUR, PARALEL SİSTEM KURMA ─────────────────────────
// Uygulamada zaten çalışan bir hata yolu var: `reportModuleFault` (ADP-335) →
// log satırı + bildirim merkezi. Bu modül O YOLA TAKILAN BİR MUSLUKTUR, ikinci bir
// yakalama ağı değil. Yani:
//   • Yeni bir `process.on('uncaughtException')` EKLENMEZ — mevcut stdioGuard
//     onFatal'ı zaten `reportModuleFault`a düşürüyor.
//   • Renderer için yeni IPC kanalı AÇILMAZ — mevcut `module:reportRenderer`
//     (ADP-901) kullanılır.
//   • Worker pane'i için yeni gözcü YAZILMAZ — mevcut `child.onExit` kullanılır.
// Sonuç: bildirim merkezinde görünen HER hata Sentry'de de görünür; Sentry'de
// görünüp uygulamada görünmeyen bir hata sınıfı OLUŞMAZ.
//
// ─── KAPALI = SIFIR İSTEK ────────────────────────────────────────────────────
// `enabled()` HER olayda CANLI okunur (açılışta bir kez değil): kullanıcı Ayarlar →
// Gizlilik'ten kapattığı an, uygulamayı yeniden başlatmadan, sonraki olay
// gönderilmez. Ağ çağrısı bu dosyada TEK yerde (`deliver`) yapılır ve kapıdan
// SONRA gelir — "kapalıyken sıfır istek" iddiası tek satırda denetlenebilir.
//
// ─── GÜRÜLTÜ KONTROLÜ ────────────────────────────────────────────────────────
// Çöken bir render döngüsü saniyede yüzlerce aynı hatayı üretir. İki kapak:
// aynı parmak izi `dedupeWindowMs` içinde bir kez gider; toplam hız
// `maxPerMinute` ile sınırlıdır. Bastırılanlar SAYILIR (`stats()`), sessizce
// yutulmaz — bir sonraki gönderimde `suppressed` etiketiyle taşınır.
//
// Saf + DI: electron bağı yok → `node --test`.

'use strict';

const { scrubString, scrubPath } = require('./scrub.cjs');
const wire = require('./sentryWire.cjs');

const DEFAULT_DEDUPE_MS = 60_000;
const DEFAULT_MAX_PER_MINUTE = 20;
const MAX_MESSAGE = 500;

/**
 * Hata kaydının SEVİYESİ (görev gereksinimi 4: uyarı ile hata ayrı).
 *
 *   fatal   — süreç ölüyor / ölmek üzere (uncaughtException).
 *   error   — bir modül DURDU: özellik artık çalışmıyor (degrade).
 *   warning — bir şey ters gitti ama yüzey ayakta (worker pane sıfırdan farklı
 *             kodla çıktı, geçici çökme yakalandı ve toparlandı).
 *
 * Bu ayrım Sentry tarafında alarm kuralını mümkün kılar: `level:error` → e-posta,
 * `level:warning` → yalnız panoda birikir. Hepsi "error" olsaydı alarm ya sürekli
 * çalar (kimse bakmaz) ya da kapatılırdı.
 */
function deriveLevel(fault) {
  if (fault.level && wire.LEVELS.has(fault.level)) return fault.level;
  if (fault.fatal) return 'fatal';
  if (fault.stopped) return 'error';
  if (fault.surface === 'worker') return 'warning';
  return 'error';
}

/** `location` alanı ('electron/paneScreen.cjs:87') → sentetik tek frame. */
function frameFromLocation(location, maskPath) {
  if (typeof location !== 'string' || !location) return [];
  const m = location.match(/^(.*?):(\d+)(?::(\d+))?$/);
  if (!m) return [];
  return [{
    filename: maskPath(m[1]),
    function: '?',
    lineno: Number(m[2]),
    colno: m[3] ? Number(m[3]) : 0,
    in_app: true,
  }];
}

/**
 * @param {object} opts
 * @param {string|null} opts.dsn
 * @param {()=>boolean} opts.enabled       CANLI opt-out okuması
 * @param {string} opts.appVersion
 * @param {string} opts.channel            prod|dev|test
 * @param {string} [opts.app]              'crewpane'
 * @param {string} [opts.appRoot]          yığın izi yolları buna göreli yazılır
 * @param {string} [opts.homeDir]
 * @param {object} [opts.osInfo]           { platform, arch, release }
 * @param {(e:object)=>Promise<object>} [opts.send]  DI taşıyıcı (varsayılan: gerçek HTTPS)
 * @param {(line:string)=>void} [opts.log]
 * @param {()=>number} [opts.now]
 */
function createErrorReporter(opts = {}) {
  const app = opts.app || 'crewpane';
  const dsn = opts.dsn || null;
  const enabled = typeof opts.enabled === 'function' ? opts.enabled : () => true;
  const log = opts.log || (() => {});
  const now = opts.now || (() => Date.now());
  const osInfo = opts.osInfo || {};
  const dedupeMs = opts.dedupeWindowMs || DEFAULT_DEDUPE_MS;
  const maxPerMinute = opts.maxPerMinute || DEFAULT_MAX_PER_MINUTE;
  const maskPath = (p) => scrubPath(p, { appRoot: opts.appRoot, homeDir: opts.homeDir });

  const lastSeen = new Map();   // fingerprint → ts
  let windowStart = now();
  let windowCount = 0;
  const stats = { attempted: 0, sent: 0, dropped: 0, suppressedDuplicate: 0, rateLimited: 0, failed: 0 };

  // ── SÜRÜM + PLATFORM DAMGASI (görev gereksinimi 2) ────────────────────────
  // "0.2.31'de düzelmişti" tartışmasını bitiren alan budur. Her olayda, istisnasız.
  const baseTags = {
    app,
    channel: opts.channel,
    app_version: opts.appVersion,
    platform: osInfo.platform || process.platform,   // darwin | win32 | linux
    arch: osInfo.arch || process.arch,               // arm64 | x64
    os_release: osInfo.release || '',
  };
  const contexts = {
    os: { name: baseTags.platform, version: baseTags.os_release },
    device: { arch: baseTags.arch },
    app: { app_version: baseTags.app_version, app_name: app },
  };

  function fingerprintOf(f, level) {
    return [
      f.surface || 'main',
      f.module || '-',
      f.label || '-',
      level,
      String(f.message || '').slice(0, 120),
    ].join('|');
  }

  function rateOk() {
    const t = now();
    if (t - windowStart >= 60_000) { windowStart = t; windowCount = 0; }
    if (windowCount >= maxPerMinute) return false;
    windowCount += 1;
    return true;
  }

  /**
   * Bir hatayı bildir. ASLA throw etmez — hata takibi hata üretemez.
   * @returns {{sent:boolean, reason?:string, event?:object}}
   */
  function capture(fault) {
    try {
      const f = fault && typeof fault === 'object' ? fault : {};
      stats.attempted += 1;

      // 1) KAPI — opt-out / DSN yok. Ağ katmanına HİÇ inilmez.
      if (!dsn) { stats.dropped += 1; return { sent: false, reason: 'no-dsn' }; }
      if (!enabled()) { stats.dropped += 1; return { sent: false, reason: 'opt-out' }; }

      const level = deriveLevel(f);
      const fp = fingerprintOf(f, level);

      // 2) Tekilleştirme
      const t = now();
      const prev = lastSeen.get(fp);
      if (prev != null && t - prev < dedupeMs) {
        stats.suppressedDuplicate += 1;
        return { sent: false, reason: 'duplicate' };
      }
      // 3) Hız sınırı
      if (!rateOk()) { stats.rateLimited += 1; return { sent: false, reason: 'rate-limited' }; }
      lastSeen.set(fp, t);
      if (lastSeen.size > 200) lastSeen.delete(lastSeen.keys().next().value);

      // 4) İÇERİK TEMİZLİĞİ — mesaj metni her zaman süzgeçten geçer.
      const message = scrubString(String(f.message == null ? '' : f.message)).slice(0, MAX_MESSAGE);

      // 5) Yığın izi: gerçek stack varsa ondan, yoksa `location` alanından.
      let frames = [];
      if (typeof f.stack === 'string' && f.stack) frames = wire.framesFromStack(f.stack, maskPath);
      if (!frames.length) frames = frameFromLocation(f.location, maskPath);

      const surface = f.surface || 'main';
      const event = wire.buildEvent({
        type: String(f.label || f.type || 'ModuleFault').slice(0, 120),
        value: message || 'bilinmeyen hata',
        frames,
        level,
        release: `${app}@${opts.appVersion}`,
        environment: opts.channel,
        platform: surface === 'renderer' ? 'javascript' : 'node',
        logger: `${app}.${surface}`,
        tags: {
          ...baseTags,
          surface,                                  // main | renderer | worker
          module: String(f.module || surface).slice(0, 60),
          // SEN-F1 — KURTARMA AŞAMASI ETİKETLERİ. Değerleri main'de KAPALI KÜMEDEN
          // geçmiş olarak gelir (bkz. `module:reportRenderer`); burada yalnız
          // varsa taşınır. Sentry'de "hangi basamak düştü / hangi çizim yolu
          // denendi / kaçıncı deneme" artık MESAJ METNİ okunmadan filtrelenebilir —
          // PROD-6/7/B/D/E kümesinde teşhisi kör bırakan eksik buydu.
          ...(f.stage ? { recovery_stage: String(f.stage).slice(0, 32) } : {}),
          ...(f.renderer ? { renderer_mode: String(f.renderer).slice(0, 16) } : {}),
          ...(f.attempt != null ? { recovery_attempt: String(f.attempt).slice(0, 4) } : {}),
          // WIN-FIRSTRUN-01 (K5) — PANE ÇIKIŞI ETİKETLERİ. RESEARCH-WIN-01'de "motor ilk
          // çıktıdan ÖNCE mi öldü" sorusu yalnız PROD-48 yarışının tesadüfüyle
          // cevaplanabildi. Artık sayı: `exit_ms_since_spawn` (spawn→exit ms) ve
          // `exit_first_data_bytes` (0 = tek bayt basmadan öldü). Motor kimliği de
          // etikettir (mesajda zaten var; etiket filtrelenebilir). Değerler main'de
          // kapalı kümeden/sayıdan gelir; burada yalnız uzunluk sınırı uygulanır.
          ...(f.engine ? { pane_engine: String(f.engine).slice(0, 24) } : {}),
          ...(Number.isFinite(Number(f.msSinceSpawn)) && Number(f.msSinceSpawn) >= 0
            ? { exit_ms_since_spawn: String(Math.round(Number(f.msSinceSpawn))).slice(0, 12) }
            : {}),
          ...(Number.isFinite(Number(f.firstDataBytes)) && Number(f.firstDataBytes) >= 0
            ? { exit_first_data_bytes: String(Math.round(Number(f.firstDataBytes))).slice(0, 12) }
            : {}),
          // SEC-W1-C1 — KURCALAMA ETİKETİ. Değeri yoktur: bayrak ya VARDIR ya
          // yoktur, `tamper:true` geçilen olay Sentry'de `tamper=true` ile
          // filtrelenir. Kurcalama sinyali PostHog'da bir olay olarak sayılır;
          // Sentry tarafında ise o kopyadan gelen HATA kayıtlarını ayırt etmek
          // için etiket gerekir — "bu çökme kurcalanmış bir kopyadan mı" sorusu
          // yoksa panoda ölçüm arızası ile saldırı aynı kutuya düşer.
          ...(f.tamper ? { tamper: 'true' } : {}),
          ...(stats.suppressedDuplicate ? { suppressed: String(stats.suppressedDuplicate) } : {}),
        },
        contexts,
        fingerprint: [surface, String(f.module || '-'), String(f.label || '-'), message.slice(0, 80)],
        timestamp: Math.floor(t / 1000),
      });

      // 6) TEK AĞ ÇAĞRISI. Beklenmez (fire-and-forget) — hata takibi UI'ı bloklamaz.
      stats.sent += 1;
      deliver(event);
      return { sent: true, event };
    } catch (e) {
      stats.failed += 1;
      try { log(`obs: capture hatası (yutuldu): ${e && e.message}`); } catch { /* son çare */ }
      return { sent: false, reason: 'internal' };
    }
  }

  function deliver(event) {
    const send = opts.send || ((ev) => wire.sendEnvelope({ dsn, event: ev }));
    let p;
    try { p = send(event); } catch (e) { stats.failed += 1; log(`obs: gönderim hatası: ${e && e.message}`); return; }
    if (p && typeof p.then === 'function') {
      p.then(
        (res) => { if (res && res.ok === false) { stats.failed += 1; log(`obs: ingest reddetti (${res.status || res.error})`); } },
        (e) => { stats.failed += 1; log(`obs: gönderim hatası: ${e && e.message}`); },
      );
    }
  }

  return {
    capture,
    stats: () => ({ ...stats }),
    enabledNow: () => !!dsn && enabled(),
    /** test/kanıt görünürlüğü */
    _maskPath: maskPath,
  };
}

module.exports = { createErrorReporter, deriveLevel, frameFromLocation, DEFAULT_MAX_PER_MINUTE };
