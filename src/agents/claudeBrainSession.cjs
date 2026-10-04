'use strict';

// ADP-815 (SPRINT-AGENTX-VOICE · Faz 3) — İKİ KATMANLI BEYNİN 2. KATMANI:
// KALICI `claude` oturumu (stream-json giriş/çıkış).
//
// NEDEN KALICI: bu koşuda ölçüldü (spike-shape, 6 komut, aynı makine/dakika) —
//   her turda YENİ oturum (soğuk yol):  p50 13031 ms · p95 16618 ms
//   kalıcı oturum (aynı prompt şekli):  p50  2511 ms · p95  3886 ms
// Yani maliyetin ~%80'i `claude` açılışıdır, modelin kendisi değil.
//
// İKİ TASARIM KARARI DA ÖLÇÜLDÜ (804 §3.4 riskini bu ikisi çözüyor):
//  1. Talimat `--system-prompt` ile OTURUM SEVİYESİNDE verilir, her mesajda
//     TEKRARLANMAZ. 804 §11.4 `--append-system-prompt` ile 4/4 turda JSON
//     tutturamamıştı; `--system-prompt` (varsayılanı DEĞİŞTİRİR, ekleme değil)
//     ile bu koşuda 6/6 + 8/8 tuttu. Ayrıca talimatı her mesaja gömmek bağlamı
//     tur başına ~6k jeton büyütüyordu (cacheRead 27899→46286, ÖLÇÜLDÜ) —
//     oturum seviyesinde bu DÜZ kalıyor (23607→23992, 6 tur).
//  2. "Yalnız null OLMAYAN alanları yaz" kuralı çıktıyı 148–177 → 30–59 jetona
//     düşürdü ve turu 3985 → 2511 ms yaptı (ÖLÇÜLDÜ). Şema 25 alanlı; boş
//     alanları yazdırmak saf çözme (decode) maliyetidir.
//
// ÇÖKME KISITI (Eren, bu makine — whisperLocal.cjs ile AYNI disiplin):
//   • TEK oturum (singleton), aynı anda TEK istek (ikincisi 'busy' → soğuk yol)
//   • bellek gözetimi: her turdan sonra RSS ölçülür, tavanı aşarsa oturum kapanır
//   • boşta kapanma: 10 dk komut yoksa oturum kapanır (RAM geri verilir)
//   • çökme gözcüsü: süreç ölürse İSTEK BEKLEMEZ — bu tur soğuk yola düşer,
//     oturum arka planda yeniden kurulur (pencere içinde 3 restart, sonra soğuma)
//
// SÖZLEŞME: bu modül KARAR ÜRETMEZ, ham JSON metnini döndürür. Ayrıştırma ve
// normalizasyon jarvisVoice'ta kalır (tek kaynak) — bu modül yalnız TAŞIYICIDIR.

const { spawn } = require('node:child_process');
const { execFile } = require('node:child_process');
const { augmentedPath } = require('./agentRunner.js');
// WIN-FIX-01 (W1 · yan bulgu) — RSS ölçümü ARTIK PLATFORM BOĞAZINDAN geçiyor.
// Eskiden burada çıplak `/bin/ps` vardı: Windows'ta o dosya YOKTUR → `err` →
// `resolve(null)` → MAX_RSS_MB tavanı HİÇ TETİKLENMEZ (sessiz devre-dışı kalma).
const procRss = require('../../platform/procRss.cjs');

// ── sabitler ───────────────────────────────────────────────────────────────
const BOOT_TIMEOUT_MS = 60000;      // ilk (ısıtma) turu: `claude` açılışı + ilk API turu
const TURN_TIMEOUT_MS = 30000;      // ısınmış tur (ölçülen p95 3886 ms → bol pay)
const IDLE_STOP_MS = 10 * 60 * 1000;
const MAX_RSS_MB = 1500;            // oturum tek süreç; ölçülen ~300–500 MB
const RESTART_WINDOW_MS = 60000;
const MAX_RESTARTS_IN_WINDOW = 3;
const COOLDOWN_MS = 5 * 60 * 1000;

/**
 * `claude` argümanları. Bayraklar ölçülerek seçildi:
 *  --strict-mcp-config + boş --mcp-config : beyin MCP sunucusu KULLANMAZ; yüklemek
 *      hem açılışı hem bağlamı büyütür (boot 7302 → 4182 ms, ÖLÇÜLDÜ).
 *  --setting-sources ''                   : kullanıcı/proje ayarları beynin kararını
 *      etkilemesin (aynı komut her kurulumda aynı JSON'u versin).
 *  --max-turns 1                          : model araç çağırmaya kalkarsa tur BİTER
 *      (sonsuz araç döngüsü yok) → ayrıştırma başarısız → soğuk yola düşülür.
 *  --include-partial-messages             : ilk-jeton ölçümü (ttft) için; kararı
 *      etkilemez, yalnız gözlemlenebilirlik.
 * NOT: `--effort low` ve `--model sonnet` ÖLÇÜLDÜ ve YARDIM ETMEDİ (3951/3528 ms
 * vs 3599 ms) — eklenmedi.
 */
function buildSessionArgs({ systemPrompt, model = null }) {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', '',
    '--max-turns', '1',
    '--system-prompt', String(systemPrompt || ''),
  ];
  if (model) args.push('--model', String(model));
  return args;
}

/** stream-json giriş satırı — `claude` her kullanıcı turunu tek satır JSON bekler. */
function buildUserLine(text) {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: String(text) }] },
  })}\n`;
}

/**
 * Bir stream-json olayından tur sonucunu çıkar. SAF (test edilebilir).
 * Döner: {kind:'text', text} | {kind:'result', text, usage} | null
 */
function readEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    let text = '';
    for (const c of ev.message.content) if (c && c.type === 'text' && typeof c.text === 'string') text += c.text;
    return text ? { kind: 'text', text } : null;
  }
  if (ev.type === 'result') {
    const text = typeof ev.result === 'string' ? ev.result : '';
    return { kind: 'result', text, usage: ev.usage || null };
  }
  return null;
}

/** İlk jeton işareti (yalnız ölçüm). */
function isFirstTokenEvent(ev) {
  return !!(ev && ev.type === 'stream_event' && ev.event && ev.event.type === 'content_block_delta');
}

// ── durum tutan kısım ──────────────────────────────────────────────────────

function createSession(deps = {}) {
  const spawnImpl = deps.spawnImpl || spawn;
  const execFileImpl = deps.execFileImpl || execFile;
  const now = deps.now || (() => Date.now());
  const log = deps.log || (() => {});
  const claudeBin = deps.claudeBin || 'claude';
  // PIPE-03 — RSS ÖLÇÜM DALI ENJEKTE EDİLEBİLİR. `rssCommand`/`parseRssKb` zaten
  // platform parametresi taşıyor ama buradan geçirilmiyordu: `execFileImpl` sahte
  // olduğu hâlde ÇIKTI BİÇİMİ host'a bağlı kalıyor ve Windows'ta posix sayısı
  // tasklist CSV'si sanılıp 0 okunuyordu (nightly 33083077733, not ok 721).
  const platform = deps.platform || process.platform;

  let child = null;
  let ready = false;          // ısıtma turu bitti mi (ilk tur boot bedelini öder)
  let busy = false;
  let pending = null;         // { resolve, t0, ttft, acc, timer }
  let stdoutBuf = '';
  let idleTimer = null;
  const restarts = [];        // zaman damgaları (pencere içi sayım)
  let cooldownUntil = 0;
  let lastExit = null;        // { code, signal, at }
  const stats = { starts: 0, turns: 0, crashes: 0, coldFallbacks: 0, rssMb: null, lastTurnMs: null, lastTtftMs: null };

  function clearIdle() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }
  function armIdle() {
    clearIdle();
    idleTimer = setTimeout(() => {
      log('[brain] boşta 10 dk → oturum kapatılıyor');
      stop('idle');
    }, IDLE_STOP_MS);
    if (idleTimer.unref) idleTimer.unref();
  }

  /** Bekleyen turu SONUÇSUZ bırakma: süreç ölürse çağıran anında soğuk yola düşsün. */
  function failPending(reason, detail) {
    const p = pending;
    pending = null;
    busy = false;
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    p.resolve({ ok: false, reason, detail: detail || null });
  }

  function onLine(line) {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (!pending) return;
    if (isFirstTokenEvent(ev) && pending.ttft === null) pending.ttft = now() - pending.t0;
    const r = readEvent(ev);
    if (!r) return;
    if (r.kind === 'text') { pending.acc += r.text; return; }
    // result → tur bitti
    const p = pending;
    pending = null;
    busy = false;
    if (p.timer) clearTimeout(p.timer);
    const raw = r.text || p.acc;
    stats.turns += 1;
    stats.lastTurnMs = now() - p.t0;
    stats.lastTtftMs = p.ttft;
    armIdle();
    void measureRss();
    p.resolve({ ok: true, raw, ms: stats.lastTurnMs, ttftMs: p.ttft, usage: r.usage });
  }

  function attach(proc) {
    proc.stdout && proc.stdout.on('data', (d) => {
      stdoutBuf += d;
      let i;
      while ((i = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, i).trim();
        stdoutBuf = stdoutBuf.slice(i + 1);
        if (line) onLine(line);
      }
    });
    proc.stderr && proc.stderr.on('data', (d) => log(`[brain:stderr] ${String(d).slice(0, 300)}`));
    // ÇÖKME GÖZCÜSÜ — süreç ölünce beklemeyen kalmasın; oturum kapalı işaretlenir.
    proc.on('exit', (code, signal) => {
      if (child !== proc) return;         // eski süreç (restart sonrası) — yok say
      lastExit = { code, signal, at: now() };
      child = null;
      ready = false;
      stdoutBuf = '';
      clearIdle();
      if (pending) stats.crashes += 1;
      log(`[brain] oturum bitti code=${code} signal=${signal}`);
      failPending('session-died', `code=${code} signal=${signal}`);
    });
    proc.on('error', (e) => {
      if (child !== proc) return;
      log(`[brain] süreç hatası: ${(e && e.message) || e}`);
      child = null;
      ready = false;
      failPending('proc-error', String((e && e.message) || e));
    });
  }

  function inCooldown() {
    return now() < cooldownUntil;
  }

  function noteRestart() {
    const t = now();
    restarts.push(t);
    while (restarts.length && t - restarts[0] > RESTART_WINDOW_MS) restarts.shift();
    if (restarts.length > MAX_RESTARTS_IN_WINDOW) {
      cooldownUntil = t + COOLDOWN_MS;
      restarts.length = 0;
      log('[brain] çok sık yeniden başlatma → 5 dk soğuma (yalnız soğuk yol)');
      return false;
    }
    return true;
  }

  /** Süreci başlat (ısıtma turu ÇAĞIRANIN işi — `warmup()`). */
  function start({ systemPrompt, model = null }) {
    if (child) return { ok: true, already: true };
    if (inCooldown()) return { ok: false, reason: 'cooldown' };
    if (!noteRestart()) return { ok: false, reason: 'cooldown' };
    let proc;
    try {
      proc = spawnImpl(claudeBin, buildSessionArgs({ systemPrompt, model }), {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PATH: augmentedPath(process.env.PATH) },
      });
    } catch (e) {
      return { ok: false, reason: 'spawn-failed', detail: String((e && e.message) || e) };
    }
    child = proc;
    ready = false;
    stats.starts += 1;
    attach(proc);
    armIdle();
    return { ok: true, pid: proc.pid };
  }

  function stop(why = 'stop') {
    clearIdle();
    const proc = child;
    child = null;
    ready = false;
    failPending('stopped', why);
    if (!proc) return false;
    try { proc.stdin && proc.stdin.end(); } catch { /* zaten kapalı */ }
    try { proc.kill('SIGTERM'); } catch { /* zaten öldü */ }
    return true;
  }

  /** KASITLI ÖLDÜRME — çökme gözcüsünün gerçek testi (e2e/ölçüm kaçış kapısı). */
  function killForTest(signal = 'SIGKILL') {
    const proc = child;
    if (!proc) return false;
    try { proc.kill(signal); } catch { return false; }
    return true;
  }

  function measureRss() {
    return new Promise((resolve) => {
      const proc = child;
      if (!proc || !proc.pid) { resolve(null); return; }
      // WIN-FIX-01 — posix: `/bin/ps`, win32: `tasklist.exe` (ADP-874'ün ÖLÇÜLMÜŞ
      // komutu; ikinci bir kopya yazılmaz). macOS'ta üretilen komut bit-bit aynı.
      const cmd = procRss.rssCommand(proc.pid, { platform });
      execFileImpl(cmd.file, cmd.argv, (err, stdout) => {
        if (err) { resolve(null); return; }
        const kb = procRss.parseRssKb(stdout, platform);
        if (!Number.isFinite(kb) || kb <= 0) { resolve(null); return; }
        const mb = Math.round(kb / 1024);
        stats.rssMb = mb;
        if (mb > MAX_RSS_MB) {
          log(`[brain] RSS ${mb} MB > ${MAX_RSS_MB} MB tavanı → oturum kapatılıyor`);
          stop('rss-ceiling');
        }
        resolve(mb);
      });
    });
  }

  /**
   * Tek tur. Oturum yoksa/ölüyse KURMAZ ve BEKLEMEZ — {ok:false} döner, çağıran
   * soğuk yola düşer (algılanan gecikme bir çökmede iki kat olmasın). Oturumu
   * yeniden kurmak `warmup()`'ın işi; çağıran onu ARKA PLANDA tetikler.
   */
  function ask(text, { timeoutMs = TURN_TIMEOUT_MS } = {}) {
    return new Promise((resolve) => {
      if (!child) { stats.coldFallbacks += 1; resolve({ ok: false, reason: 'no-session' }); return; }
      if (busy) { stats.coldFallbacks += 1; resolve({ ok: false, reason: 'busy' }); return; }
      busy = true;
      clearIdle();
      const t0 = now();
      const timer = setTimeout(() => failPending('timeout'), timeoutMs);
      if (timer.unref) timer.unref();
      pending = { resolve, t0, ttft: null, acc: '', timer };
      try {
        child.stdin.write(buildUserLine(text));
      } catch (e) {
        failPending('write-failed', String((e && e.message) || e));
      }
    });
  }

  /**
   * Oturumu kur + İLK TURU ÖDE. 804/815 ölçümü: ilk tur 4–13 s, ısınmış tur
   * 2–4 s. Isıtma tetiği ADP-813'ün dersiyle aynı: BOOT değil NİYET
   * (kayıt başlangıcı) — böylece hiç konuşmayan kullanıcı bedel ödemez.
   */
  async function warmup({ systemPrompt, model = null, text = 'ısıtma', timeoutMs = BOOT_TIMEOUT_MS } = {}) {
    if (ready && child) return { ok: true, already: true };
    if (busy) return { ok: false, reason: 'busy' };
    const s = start({ systemPrompt, model });
    if (!s.ok) return s;
    const r = await ask(text, { timeoutMs });
    if (r.ok) ready = true;
    return r;
  }

  return {
    start, stop, ask, warmup, killForTest, measureRss,
    isAlive: () => !!child,
    isReady: () => ready && !!child,
    isBusy: () => busy,
    lastExitInfo: () => lastExit,
    stats: () => ({ ...stats, alive: !!child, ready, busy, cooldown: inCooldown() }),
    _resetForTest: () => { restarts.length = 0; cooldownUntil = 0; },
  };
}

module.exports = {
  createSession,
  buildSessionArgs,
  buildUserLine,
  readEvent,
  isFirstTokenEvent,
  BOOT_TIMEOUT_MS,
  TURN_TIMEOUT_MS,
  IDLE_STOP_MS,
  MAX_RSS_MB,
  MAX_RESTARTS_IN_WINDOW,
};
