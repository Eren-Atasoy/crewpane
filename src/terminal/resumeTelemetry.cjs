// CrewPane — RES-08: limit-sonrası "devam" TELEMETRİSİ (yapılandırılmış olay günlüğü).
//
// NEDEN VAR (D12, RES-01 §5): devam başarı oranı ÖLÇÜLEMİYORDU. RES-01 denetimi tek
// bir soruyu ("devam etti mi?") cevaplamak için ÜÇ ayrı kaynağı ELLE birleştirmek
// zorunda kaldı — `docs/.agent-notifications` (serbest Türkçe nesir), `crewpane.log`
// (kalp atışı satırları) ve `~/.claude/projects/**/*.jsonl` (transkript). Sonuç:
// 12/12 gönderim "başarılı" görünüyordu ve gerçekte HEPSİ limite çarpmıştı; bu ÜÇ GÜN
// fark edilmedi. Serbest metin bir ölçüm yüzeyi değildir.
//
// Bu modül tek satırlık JSON kayıtları biriktirir (JSONL): her satır BİR olay, her
// alan makine-okur. `resume-stats` (scripts/resume-stats.mjs) bu dosyadan RES-01'in
// §3 tablosunu TEK KOMUTLA üretir.
//
// Sözleşme:
//   • append ASLA fırlatmaz — telemetri bir İYİLEŞTİRMEdir, resume hattının ön koşulu
//     değil. Disk dolu / izin yok → olay düşer, daemon koşmaya devam eder.
//   • Alan sırası SABİT (aşağıdaki `FIELDS`) → `head -1` ile okunan satır insan için
//     de okunur, diff'te gürültü yapmaz.
//   • Dosya döner (rotate): MAX_BYTES'ı aşınca `.1` olur (tek kuşak). Sınırsız büyüyen
//     bir günlük, ölçmek için yazdığımız şeyin kendisini soruna çevirir.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const resumeQueue = require('./resumeQueue.cjs');

/** Olay türleri (RES-08 DoD §1). Bunların dışındaki bir ad `other`'a düşer. */
// LIMIT-RESUME-02 — `native` (motorun kendi devamı görüldü/bekleniyor), `external`
// (kayıt daemon YAZMADAN kapandı: motor/kullanıcı devam etti — ya da nöbetçi
// dokunuşundan sonra), `sentinel` (nöbetçinin tek dokunuşu: enter/continue/menu-select).
const EVENTS = Object.freeze(['detect', 'schedule', 'probe', 'send', 'verify', 'retry', 'fail', 'native', 'external', 'sentinel']);

/**
 * `resetAt` hangi kaynaktan geldi?
 *   clock        — ekranda YAZAN duvar saati, zaman dilimi tanındı
 *   clock-local  — saat yazıyordu ama zaman dilimi tanınmadı → OS saatiyle çözüldü
 *                  (limitDetect'in `clock-local-fallback`'i; DÜŞÜK güven)
 *   rel          — "resets in 2h 15m" biçimi
 *   reread       — ilk okumada yoktu; ekrandan/motorun reddinden YENİDEN okundu
 *   unknown      — hiç okunamadı (RES-03 hedefi: bu oran ≤ %10)
 */
// LIMIT-RESUME-02 — `cli-band`: saati CLI'ın KENDİ bandı söyledi ("continuing
// automatically at …"); `date`: yılsız ay-gün ("resets Sep 20 at 7pm", haftalık limit).
const RESET_SOURCES = Object.freeze(['clock', 'clock-local', 'rel', 'abs', 'date', 'cli-band', 'reread', 'unknown']);

/** Kayıt alanları — SIRA SABİT (bkz. dosya başlığı). */
const FIELDS = Object.freeze([
  'ts',
  'agentId',
  'paneRef',
  'runtime',
  'event',
  'resetAtSource',
  'resetAt',
  'delayMs',
  'attempt',
  'outcome',
  'evidenceSrc',
]);

/** Günlük bu boyutu aşınca `.1`'e döner (tek kuşak saklanır). */
const MAX_BYTES = 2 * 1024 * 1024;

/** `~/.crewpane[-dev]/accounts/<hesap>/resume-events.jsonl` (kuyruk dosyasının yanı). */
function eventsPath(homedir) {
  return path.join(resumeQueue.crewpaneDir(homedir), 'resume-events.jsonl');
}

function num(v) {
  return Number.isFinite(v) ? v : null;
}

function str(v) {
  return typeof v === 'string' && v ? v : null;
}

/**
 * Ham olayı kayıt şekline indir. Bilinmeyen alanlar DÜŞER (günlük sözleşmesi dar
 * kalsın), bilinmeyen bir `event` adı `other` olur — sessizce yanlış ada yazmaktansa
 * görünür bir "other" satırı yeğdir.
 */
function normalize(evt, now) {
  const e = evt && typeof evt === 'object' ? evt : {};
  const src = str(e.resetAtSource);
  return {
    ts: Number.isFinite(e.ts) ? e.ts : Number.isFinite(now) ? now : Date.now(),
    agentId: str(e.agentId),
    paneRef: str(e.paneRef),
    runtime: str(e.runtime),
    event: EVENTS.includes(e.event) ? e.event : 'other',
    resetAtSource: src && RESET_SOURCES.includes(src) ? src : src ? 'unknown' : null,
    resetAt: num(e.resetAt),
    delayMs: num(e.delayMs),
    attempt: Number.isInteger(e.attempt) ? e.attempt : null,
    outcome: str(e.outcome),
    evidenceSrc: str(e.evidenceSrc),
  };
}

/** Kayıt → tek satır JSON (alan sırası SABİT). */
function serialize(rec) {
  const ordered = {};
  for (const k of FIELDS) ordered[k] = rec[k];
  return `${JSON.stringify(ordered)}\n`;
}

/** MAX_BYTES aşıldıysa `.1`'e döndür. Best-effort — dönemezse yazmaya devam edilir. */
function rotateIfNeeded(file, maxBytes) {
  try {
    if (fs.statSync(file).size < maxBytes) return false;
    fs.renameSync(file, `${file}.1`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Bir olayı günlüğe ekle. ASLA fırlatmaz; yazıldıysa true döner.
 * @param {string} file
 * @param {object} evt
 * @param {{now?:number, maxBytes?:number}} [opts]
 */
function append(file, evt, opts = {}) {
  try {
    const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : MAX_BYTES;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateIfNeeded(file, maxBytes);
    fs.appendFileSync(file, serialize(normalize(evt, opts.now)));
    return true;
  } catch {
    return false;
  }
}

/**
 * Daemon'a enjekte edilecek yazıcı: `(evt) => void`. `file` verilmezse hesap
 * kapsamlı varsayılan yol kullanılır.
 */
function createWriter(cfg = {}) {
  const file = cfg.file || eventsPath(cfg.homedir);
  const maxBytes = Number.isFinite(cfg.maxBytes) ? cfg.maxBytes : MAX_BYTES;
  const writer = (evt) => {
    append(file, evt, { maxBytes });
  };
  writer.file = file;
  return writer;
}

/** Günlüğü oku (bozuk satırlar ATLANIR — yarım yazılmış son satır normaldir). */
function readEvents(file, opts = {}) {
  const files = [file];
  if (opts.includeRotated !== false) files.unshift(`${file}.1`);
  const out = [];
  for (const f of files) {
    let raw;
    try {
      raw = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === 'object' && Number.isFinite(obj.ts)) out.push(obj);
      } catch {
        /* yarım satır */
      }
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  if (Number.isFinite(opts.sinceMs)) return out.filter((e) => e.ts >= opts.sinceMs);
  return out;
}

/**
 * RES-08 DoD §2/§3 — son N günün özeti.
 *
 * `successRate` = doğrulanmış devam / GÖNDERİM. Payda bilerek `send`: bir devam
 * denemesi "yapıldı ve tuttu mu" sorusunun paydası gönderimdir. RES-01'in 12/12
 * sahte başarısı tam da bu iki sayı ayrı tutulmadığı için görünmemişti.
 *
 * `avgSkewMs` = gönderim anı − ekranda yazan reset anı (yalnız resetAt bilinen
 * gönderimlerde). Pay politikası (RES-06) bu sayıyla ayarlanacak.
 */
function summarize(events, opts = {}) {
  const list = Array.isArray(events) ? events : [];
  const sends = list.filter((e) => e.event === 'send' && e.outcome !== 'failed');
  const verifies = list.filter((e) => e.event === 'verify');
  const resumed = verifies.filter((e) => e.outcome === 'resumed');
  const probes = list.filter((e) => e.event === 'probe');
  const probeBlocked = probes.filter((e) => e.outcome === 'limited');
  const probeUnknown = probes.filter((e) => e.outcome === 'unknown');
  const retries = list.filter((e) => e.event === 'retry');
  const fails = list.filter((e) => e.event === 'fail');
  const detects = list.filter((e) => e.event === 'detect');
  // LIMIT-RESUME-02 — daemon YAZMADAN biten devamlar ve nöbetçi dokunuşları.
  const externals = list.filter((e) => e.event === 'external' && e.outcome === 'resumed-externally');
  const afterSentinel = list.filter((e) => e.event === 'external' && e.outcome === 'resumed-after-sentinel');
  const sentinels = list.filter((e) => e.event === 'sentinel' && e.outcome && !/-failed$/.test(e.outcome));
  const interrupted = list.filter((e) => e.event === 'external' && e.outcome === 'interrupted');

  const skews = sends
    .filter((e) => Number.isFinite(e.resetAt))
    .map((e) => e.ts - e.resetAt);

  const bySource = {};
  for (const s of RESET_SOURCES) bySource[s] = 0;
  for (const e of detects) {
    const k = RESET_SOURCES.includes(e.resetAtSource) ? e.resetAtSource : 'unknown';
    bySource[k] += 1;
  }

  const agents = new Map();
  for (const e of list) {
    if (!e.agentId) continue;
    const a = agents.get(e.agentId) || { agentId: e.agentId, sends: 0, resumed: 0, fails: 0 };
    if (e.event === 'send' && e.outcome !== 'failed') a.sends += 1;
    if (e.event === 'verify' && e.outcome === 'resumed') a.resumed += 1;
    if (e.event === 'fail') a.fails += 1;
    agents.set(e.agentId, a);
  }

  const known = detects.length - bySource.unknown;
  return {
    from: list.length ? list[0].ts : null,
    to: list.length ? list[list.length - 1].ts : null,
    days: Number.isFinite(opts.days) ? opts.days : null,
    events: list.length,
    detects: detects.length,
    sends: sends.length,
    verified: resumed.length,
    // Payda 0 iken oran YOK (0 değil) — "hiç denemedik" ile "hep başarısız" farkı.
    successRate: sends.length ? resumed.length / sends.length : null,
    // LIMIT-RESUME-02 — DEVAM ORANI: bir limit bölümü ya bizim gönderimimizle ya
    // nöbetçi dokunuşuyla ya da hiç dokunmadan (motor/kullanıcı) bitti. Pay =
    // doğrulanmış devamların hepsi; payda = dokunuşlar + dokunuşsuz devamlar. RES-01'in
    // %21'i (15/72) bu formülle de aynı çıkar (external=0, sentinel=0 iken).
    externalResumed: externals.length,
    resumedAfterSentinel: afterSentinel.length,
    sentinels: sentinels.length,
    interrupted: interrupted.length,
    continueRate:
      sends.length + sentinels.length + externals.length
        ? (resumed.length + afterSentinel.length + externals.length) /
          (sends.length + sentinels.length + externals.length)
        : null,
    retries: retries.length,
    fails: fails.length,
    probes: probes.length,
    probeBlocked: probeBlocked.length,
    probeUnknown: probeUnknown.length,
    avgSkewMs: skews.length ? Math.round(skews.reduce((a, b) => a + b, 0) / skews.length) : null,
    minSkewMs: skews.length ? Math.min(...skews) : null,
    maxSkewMs: skews.length ? Math.max(...skews) : null,
    resetAtSource: bySource,
    resetKnownRate: detects.length ? known / detects.length : null,
    byAgent: [...agents.values()].sort((a, b) => b.sends - a.sends),
  };
}

function pct(v) {
  return v == null ? '—' : `${Math.round(v * 1000) / 10}%`;
}

function secs(ms) {
  return ms == null ? '—' : `${Math.round(ms / 1000)}s`;
}

/** Özet → insan-okur rapor (resume-stats CLI'ın çıktısı). */
function formatReport(s, file) {
  const lines = [];
  lines.push(`resume telemetri — ${file}`);
  if (s.days) lines.push(`pencere: son ${s.days} gün`);
  lines.push(
    `aralık: ${s.from ? new Date(s.from).toISOString() : '—'} → ${s.to ? new Date(s.to).toISOString() : '—'} (${s.events} olay)`,
  );
  lines.push('');
  lines.push(`algılama (detect)        : ${s.detects}`);
  lines.push(`gönderim (send)          : ${s.sends}`);
  lines.push(`doğrulanmış devam        : ${s.verified}`);
  lines.push(`BAŞARI ORANI             : ${pct(s.successRate)}   (verified / send)`);
  lines.push(
    `nöbetçi dokunuşu         : ${s.sentinels}  · sonrasında devam: ${s.resumedAfterSentinel} · dokunmadan devam (motor/kullanıcı): ${s.externalResumed} · kesme görüldü: ${s.interrupted}`,
  );
  lines.push(
    `DEVAM ORANI (LR-02)      : ${pct(s.continueRate)}   ((verified + nöbetçi-sonrası + dokunmadan) / (send + nöbetçi + dokunmadan))`,
  );
  lines.push(`yeniden deneme (retry)   : ${s.retries}`);
  lines.push(`vazgeçme (fail)          : ${s.fails}`);
  lines.push(
    `ön-yoklama (probe)       : ${s.probes}  · ENGELLENEN erken devam: ${s.probeBlocked} · sonuçsuz: ${s.probeUnknown}`,
  );
  lines.push(
    `sapma (tetik − reset)    : ort ${secs(s.avgSkewMs)} · min ${secs(s.minSkewMs)} · maks ${secs(s.maxSkewMs)}`,
  );
  lines.push(`resetAt okunabildi       : ${pct(s.resetKnownRate)}  (RES-03 hedefi ≥ %90)`);
  lines.push(
    `resetAt kaynağı          : ${RESET_SOURCES.map((k) => `${k}=${s.resetAtSource[k]}`).join(' ')}`,
  );
  if (s.byAgent.length) {
    lines.push('');
    lines.push('ajan bazında  gönderim/doğrulanmış/vazgeçme');
    for (const a of s.byAgent) lines.push(`  ${a.agentId.padEnd(24)} ${a.sends}/${a.resumed}/${a.fails}`);
  }
  return lines.join('\n');
}

module.exports = {
  EVENTS,
  RESET_SOURCES,
  FIELDS,
  MAX_BYTES,
  eventsPath,
  normalize,
  serialize,
  append,
  createWriter,
  readEvents,
  summarize,
  formatReport,
};
