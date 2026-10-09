'use strict';

const STORE_VERSION = 1;

// ── Varsayılan zamanlamalar (testler override eder) ─────────────────────────
const DEFAULTS = Object.freeze({
  tickMs: 15_000,
  /** Dispatch'ten sonra teslimatın transcript'te aranmaya başlanacağı an.
   *  ADP-561 dersi: engineReadyRunner'ın 9sn boot bütçesini AŞMALI. */
  deliveryCheckMs: 14_000,
  /** Teslim edilmemiş prompt için yeniden gönderim üst sınırı. */
  deliveryResendMax: 2,
  /** Pane kaybolduktan sonra kanıtın diske düşmesi için tanınan süre. */
  paneGoneGraceMs: 8_000,
  /** Settle → hayalet reap arası bekleme: bu pencerede pane sıradaki işe REUSE
   *  edilirse hiç dokunulmaz (ADP-561 yazım yarışını yapısal olarak imkânsız kılar). */
  reapGraceMs: 25_000,
  /**
   * ADP-672 — SESSİZLİK EŞİĞİ. Pane buffer'ı bu kadar süre HİÇ değişmediyse VE worker
   * boş composer'da bekliyorsa (composerState==='empty') alt-görev KOŞMUYOR demektir.
   */
  idleMs: 120_000,
  /**
   * ADP-735 — SESSİZ ≠ BAŞARISIZ. `idleMs` bir GÖZLEM eşiğidir ("worker prompt'a döndü");
   * TERMİNAL hüküm için yetmez.
   */
  idleFailMs: 15 * 60_000,
  /** Lider uyandırma backoff'u (ms). Son değer sonrasında son değer tekrarlanır.
   *  YALNIZ yazım BAŞARISIZ olduğunda uygulanır (ADP-667: "meşguldü" başarısızlık değil). */
  wakeBackoffMs: Object.freeze([0, 20_000, 60_000, 180_000, 600_000]),
  /** ADP-667 — lider MEŞGULken (composer dolu / tur koşuyor) yeniden bakma aralığı. */
  wakeRetryBusyMs: 5_000,
  /**
   * ADP-667 — TOPLAMA penceresi: bir kayıt settle olduktan sonra bu kadar süre
   * uyandırma BEKLETİLİR ki aynı anda biten diğer işler de aynı mesaja girsin
   * ("3 görev bitti: X, Y, Z").
   */
  wakeCoalesceMs: 10_000,
  /**
   * ADP-667 — idle-guard'ın iki buffer okuması ARASINDAKİ gerçek gecikme.
   */
  wakeSampleGapMs: 400,
  /** ADP-667 — son TUŞ BASIMINDAN beri beklenecek sessizlik (leaderComposer.cjs). */
  wakeInputQuietMs: 2_000,
  /**
   * ADP-692 — TASLAK KİLİDİ süresi. Son ENTER'dan beri tuş basılmışsa kullanıcı prompt
   * YAZIYOR demektir ve enjeksiyon HİÇ denenmez.
   */
  wakeDraftGraceMs: 30_000,
  /** Bir nudge yazıldıktan sonra ack için beklenen süre; gelmezse tekrar denenir. */
  wakeAckWindowMs: 90_000,
  /**
   * ADP-672 — YAZIM ≠ TESLİMAT. `writePane` yalnız "baytlar pty'ye gitti" der; mesajın
   * liderin KONUŞMASINA girdiğini KANITLAMAZ.
   */
  wakeVerifyMs: 20_000,
  /** Yutulan uyandırma için pane kanalı üst sınırı; sonrası notify-log'a bırakılır. */
  wakeLostMax: 3,
  /** GERÇEK yazım denemesi üst sınırı (ERTELEME bu bütçeyi HARCAMAZ — ADP-672). */
  wakeAttemptsMax: 8,
  /** Terminal kayıtların defterde tutulma süresi (sonra budanır). */
  retentionMs: 24 * 60 * 60 * 1000,
  /** ADP-667 — lider-pane uyandırmasının TEK sahibi supervisor mı? false → renderer
   *  kendi nudge'ını yazar (ADP-667 öncesi davranış; kill-switch). */
  ownLeaderWake: true,
});

/** ADP-692 — enjeksiyon kapısının reddetme sebebi → log metni. */
const GATE_REASON_TR = Object.freeze({
  draft: 'KULLANICI PROMPT YAZIYOR (son ENTER\'dan beri tuş var)',
  quiet: 'az önce tuş basıldı (sessizlik penceresi dolmadı)',
  composer: 'MEŞGUL/composer dolu',
});

/** Kanıt olarak sayılan tamamlanma sinyalleri (kayıtta `settledBy`). */
const SETTLE_SOURCES = Object.freeze({
  RENDERER: 'renderer',        // normal yol — motor kendi settle etti
  EVIDENCE: 'evidence',        // kanıt dosyası dispatch-baseline'ından farklı
  MARKER: 'marker',            // pane çıktısında DONE:<subtaskId>
  PANE_EXIT: 'pane-exit',      // pane öldü (kanıt varsa done, yoksa failed)
  IDLE: 'idle',                // uzun sessizlik + kanıt
  REPAIR: 'repair',            // restart onarımı
  EXTERNAL_KILL: 'external-kill', // uygulama DIŞARIDAN kapatıldı
});

const isTerminalStatus = (s) => s === 'done' || s === 'failed' || s === 'undelivered';

module.exports = {
  STORE_VERSION,
  DEFAULTS,
  GATE_REASON_TR,
  SETTLE_SOURCES,
  isTerminalStatus,
};
