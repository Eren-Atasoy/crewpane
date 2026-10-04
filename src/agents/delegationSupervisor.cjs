// CrewPane — ADP-659: DELEGASYON SUPERVISOR (otopilot sürekliliğinin omurgası).
//
// ─────────────────────────────────────────────────────────────────────────────
// NEDEN 30 FIX TUTMADI (arkeoloji hükmü)
// ─────────────────────────────────────────────────────────────────────────────
// ADP-538 (notify-log kaynağı), 545 (packaged notify yolu), 561 (dispatch teslimi),
// 563 (yaşam döngüsü/statü yalanı), 575 (settle-sweep + lider pane-nudge) — hepsi
// DOĞRU fix'lerdi ve hepsi AYNI KATMANDA yaşıyor:
//
//   • `src/app/lib/delegation*.ts` → RENDERER süreci. Uçuştaki her nöbet
//     (armTimeout/armIdle/armSettleSweep/armLateHeal/verifyDelivery) bir
//     `setTimeout` KAPANIŞIDIR ve `startTeamDelegation`'ın in-memory Map'lerinde
//     yaşar. Renderer reload'u (crashWatchdog `win.reload()` — ADP-475, dev HMR,
//     navigasyon, OOM) bunların HEPSİNİ buharlaştırır.
//   • Diske YALNIZ `queued` + `paused` yazılır (delegationQueueStore). UÇUŞTAKİ
//     (`dispatched`/`working`/`review`) alt-görevler HİÇBİR YERDE kalıcı DEĞİL →
//     reload sonrası o iş sonsuza dek öksüz: ajan "meşgul" kalır, pane "working"
//     hayaleti olur, kuyruk ilerlemez, ekran boş bekler.
//   • Liderin completion'ı görmesi ise liderin KENDİ Claude oturumunda ELLE
//     kurduğu Monitor tail'ine bağlı; oturum restart / MCP kopması → kimse yeniden
//     kurmuyor. ADP-575 pane-nudge'ı bunu kapatmaya çalıştı ama fire-and-forget:
//     lider 20sn (LEADER_NUDGE_MAX_WAIT_MS) meşgulse SESSİZCE vazgeçiyor — bir LLM
//     lider neredeyse HER ZAMAN 20sn'den uzun meşgul. Kalıcılık/retry/backoff/ack YOK.
//
// KÖK NEDEN: takip mantığı YANLIŞ KATMANDA — efemer (renderer + lider oturumu).
// KALICI ÇÖZÜM: takip CrewPane'in KENDİSİNDE, MAIN sürecinde, DİSKTE defterli.
//
// ─────────────────────────────────────────────────────────────────────────────
// BU MODÜL
// ─────────────────────────────────────────────────────────────────────────────
// Renderer her dispatch'i buraya KAYDEDER (`record`) ve normal yolda settle edince
// haber verir (`settle`). Supervisor bağımsız bir tick'te:
//
//   1. ÇOKLU-SİNYAL tamamlanma tespiti (renderer'a HİÇ güvenmeden):
//      kanıt-dosyası değişimi · pane buffer'ında `DONE:<id>` marker'ı · pane exit ·
//      sessizlik(idle)+kanıt. Main pty defterinin ve dosya sisteminin SAHİBİ, o
//      yüzden hepsini renderer olmadan ölçebilir.
//   2. TESLİMAT DOĞRULAMA: dispatch worker'ın transcript'ine/pane'ine gerçekten
//      ulaştı mı? (resume-picker yutması) → ulaşmadıysa KENDİ yeniden gönderir.
//   3. HAYALET PANE REAP: settle olmuş kaydın pane'i hâlâ meşgul duruyorsa otomatik
//      geri kazanılır (elle kapatma GEREKMEZ).
//   4. KUYRUK İLERLETME: settle olur olmaz renderer'a "ilerle" push'u; renderer yoksa
//      her tick yeniden denenir (renderer dönünce ilerler).
//   5. LİDER UYANDIRMA: backoff + ÇOKLU KANAL (kalıcı notify-log + idle-guard'lı
//      lider-pane yazımı) + ACK bekleme; ack gelmezse TEKRAR dener. Lider pane'i yoksa
//      birikir ve lider geri gelince "sen yokken" özeti olarak teslim edilir.
//   6. RESTART ONARIMI: app yeniden başlarken defter diskten okunur; pane'i kaybolmuş
//      uçuştaki kayıtlar kanıta bakılarak dürüstçe kapatılır ve lider bilgilendirilir.
//
// TÜM IO ENJEKTE (fs/electron require'ı YOK) → `node --test` doğrudan koşar
// ([[leaf-module-node-test]]). Tek bağımlılık: leaderComposer.cjs (saf, leaf).

'use strict';

const { injectionGate, humanPresence, composerState } = require('./leaderComposer.cjs');
// ADP-838 — board faz adları TEK KAYNAKTAN (boardTaskSync.cjs saf leaf: yalnız
// appDbIdentity'ye bağlı, o da bağımsız). Sabiti burada kopyalamak iki yüzeyi
// sessizce ayırırdı.
const { PHASES: BOARD_PHASES } = require('./boardTaskSync.cjs');
// ADP-953 — ConPTY-dayanıklı ANSI süzgeci. ADP-938'de ölçülüp yazıldı (tam ECMA-48
// final aralığı 0x40–0x7e); `limitDetect.cjs` bağımlılığı SIFIR olan saf bir leaf —
// enjekte-IO sözleşmesi bozulmaz. Kopyalamak iki süzgeci sessizce ayırırdı.
const { stripAnsiRobust } = require('../terminal/limitDetect.cjs');
// ENT-F1 — TESLİM-DOĞRULAMALI GÖNDERİM. Supervisor'ın pane'e prompt yazan İKİ yolu
// (yeniden gönderim + lider uyandırma) bugüne dek HAM `writePane` idi: yeniden
// gönderim ENTER'I HİÇ BASMIYORDU (ENT-R1 §5b: gerçek claude'da `paste again to
// expand` çipi + oturum defteri BOŞ), uyandırma ise metin ve `\r`'yi 0 ms arayla
// yazıyordu. Primitif saf leaf ve IO'sunu BU MODÜLÜN zaten enjekte edilmiş
// io'sundan alır → yeni bir bağımlılık/dikiş eklenmez, mevcut testler çalışmaya
// devam eder.
const { createDeliverPrompt, pendingTextOnScreen } = require('./deliverPrompt.cjs');
// STAT-D1 (KN-1) — marker tespitinin TEK saf çekirdeği. Renderer'ın `parseMarkers`
// kurallarıyla aynı; supervisor ARTIK kendi taramasını yazmaz, bunu ÇAĞIRIR.
const { countDoneMarkers } = require('../services/markerSafe.cjs');

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
   *
   * 🔴 ADP-659'da bu sabit tanımlıydı ama HİÇBİR YERDE KULLANILMIYORDU: `detect()`'in
   * (4) numaralı dalı yalnız bayt sayacını tazeleyip `null` dönüyordu, `SETTLE_SOURCES.IDLE`
   * hiç üretilemiyordu (ULAŞILAMAZ kod). Sonuç, Eren'in canlı Fury→Stark vakası: worker
   * turunu bitirip prompt'a döndü, kanıt dosyası YAZILMADI, `DONE:` marker'ı basılmadı,
   * pane de ölmedi → HİÇBİR sinyal ateşlenmedi, kayıt 48 dakika "uçuşta" kaldı ve lider
   * "stark:working" okumaya devam etti ("hâlâ çalışıyor" cevabının ta kendisi).
   */
  idleMs: 120_000,
  /**
   * ADP-735 — SESSİZ ≠ BAŞARISIZ. `idleMs` bir GÖZLEM eşiğidir ("worker prompt'a döndü");
   * TERMİNAL hüküm için yetmez. 2026-07-29 canlı vakasında üç worker raporunu yazıp
   * commit'lemişti ve gözetmen üçüne de "2 dakikadır sessiz · BAŞARISIZ" dedi — 2 dakika
   * bir LLM worker'ın düşünme/araç molası kadar bile değil.
   *
   * Artık iki kademe: `idleMs` dolunca kanıt SORULUR (dosya sistemi) ve sessizlik saati
   * defterlenir; TERMİNAL 'failed' YALNIZ `idleFailMs` dolduğunda ve kanıt HÂLÂ yokken
   * verilir. Üst sınır şart: ADP-672'nin "48 dakika uçuşta kaldı" bug'ı geri gelmesin.
   */
  idleFailMs: 15 * 60_000,
  /** Lider uyandırma backoff'u (ms). Son değer sonrasında son değer tekrarlanır.
   *  YALNIZ yazım BAŞARISIZ olduğunda uygulanır (ADP-667: "meşguldü" başarısızlık değil). */
  wakeBackoffMs: Object.freeze([0, 20_000, 60_000, 180_000, 600_000]),
  /** ADP-667 — lider MEŞGULken (composer dolu / tur koşuyor) yeniden bakma aralığı.
   *  Erteleme bir HATA değil "henüz uygun an değil"dir; backoff'a düşürmek liderin
   *  idle'a dönmesinden dakikalar sonra teslim demekti (575'in "ulaşmıyor" şikâyeti). */
  wakeRetryBusyMs: 5_000,
  /**
   * ADP-667 — TOPLAMA penceresi: bir kayıt settle olduktan sonra bu kadar süre
   * uyandırma BEKLETİLİR ki aynı anda biten diğer işler de aynı mesaja girsin
   * ("3 görev bitti: X, Y, Z"). Eren'in istediği 10-20sn bandı.
   */
  wakeCoalesceMs: 10_000,
  /**
   * ADP-667 — idle-guard'ın iki buffer okuması ARASINDAKİ gerçek gecikme. Sıfır
   * gecikmeyle alınan iki okuma her zaman eşittir → "stabil" hükmü VAKUM olur
   * (guard'ın pratikte kesmesinin ikinci sebebi).
   */
  wakeSampleGapMs: 400,
  /** ADP-667 — son TUŞ BASIMINDAN beri beklenecek sessizlik (leaderComposer.cjs). */
  wakeInputQuietMs: 2_000,
  /**
   * ADP-692 — TASLAK KİLİDİ süresi. Son ENTER'dan beri tuş basılmışsa kullanıcı prompt
   * YAZIYOR demektir ve enjeksiyon HİÇ denenmez (ekranı beklemez → ADP-667 mikro yarışı
   * yapısal olarak kapanır). Kilit süresiz olamaz: yarım bir şey yazıp giden kullanıcı
   * otopilotu sonsuza dek durdurmasın. Süre dolunca composer sinyali yine koşar.
   */
  wakeDraftGraceMs: 30_000,
  /** Bir nudge yazıldıktan sonra ack için beklenen süre; gelmezse tekrar denenir. */
  wakeAckWindowMs: 90_000,
  /**
   * ADP-672 — YAZIM ≠ TESLİMAT. `writePane` yalnız "baytlar pty'ye gitti" der; mesajın
   * liderin KONUŞMASINA girdiğini KANITLAMAZ. Canlı Fury vakasında log "lider uyandırıldı
   * fury (deneme 1)" yazdı ama liderin claude oturum defterinde o mesaj HİÇ YOK
   * (ölçüldü: 0 eşleşme) — tur ortasına yazılan metin yutuldu. ADP-667 "teslim = ack"
   * dediği için kayıt o anda KAPANDI ve lider bir daha hiç uyandırılmadı.
   * Artık: yazımdan bu kadar süre sonra liderin transcript'inde ARANIR; yoksa YENİDEN yazılır.
   * ENG-02 — bu doğrulama artık codex liderinde de KOŞAR: codex'in kendi rollout defteri
   * (`~/.codex/sessions/YYYY/MM/DD/rollout-<id>.jsonl`) okunur. Eşleme belirsizse (aynı cwd'de
   * ayırt edilemeyen iki oturum) prob `null` döner ve eski davranış korunur: teslim=ack.
   * Defteri hiç olmayan motor (shell/diğer) yine `null` → eski davranış.
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
  // KILL-GUARD-01 — uygulama DIŞARIDAN kapatıldı (SIGTERM/SIGHUP: `killall`, bir
  // installer, oturum kapanması). `repair`den AYRI bir kaynak olması ŞART: ikisi de
  // "pane kayboldu" der ama sebepleri farklıdır ve lidere söylenecek cümle farklıdır
  // ("uygulama yeniden başladı" ≠ "biri uygulamayı kapattı, işin YARIM kaldı").
  EXTERNAL_KILL: 'external-kill',
});

const isTerminalStatus = (s) => s === 'done' || s === 'failed' || s === 'undelivered';

/** Kayıt anahtarı — delegasyon+alt-görev tekildir. */
function recordKey(delegationId, subtaskId) {
  return `${delegationId}:${subtaskId}`;
}

/** Şekil toleransı: defter her zaman { version, records:{} }. */
function normalizeState(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const src = s.records && typeof s.records === 'object' ? s.records : {};
  const records = {};
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && typeof v.delegationId === 'string' && typeof v.subtaskId === 'string') {
      records[k] = v;
    }
  }
  return { version: STORE_VERSION, records };
}

/**
 * TESLİM HÜKMÜ MERDİVENİ (saf). Transcript birincil kanıt; pane tamponu İKİNCİL ve
 * yalnız POZİTİF yönde geçerli. claude alt-ekranda (`?1049h`) koşar ve prompt'u ekrana
 * echo ETMEZ ([[claude-cli-altscreen-no-history]]) → tamponda GÖRMEMEK teslim
 * edilmediğini KANITLAMAZ. Yokluk-kanıtı zayıf, varlık-kanıtı güçlü: yalnız null→true
 * yükseltmesi yapılır, null→false ASLA (yoksa her cold pane'e gereksiz yeniden gönderim
 * gider ve ADP-561'in çözdüğü merge yarışı geri gelir).
 *
 * @param {{transcript:boolean|null, buffer?:string, signature?:string|null}} ev
 * @returns {boolean|null} true=teslim kanıtlı · false=defter baktı, YOK · null=bakılamadı
 */
function deliveryVerdict(ev) {
  const transcript = ev && (ev.transcript === true || ev.transcript === false) ? ev.transcript : null;
  if (transcript !== null) return transcript;
  const sig = ev && typeof ev.signature === 'string' ? ev.signature : '';
  const buf = ev && typeof ev.buffer === 'string' ? ev.buffer : '';
  if (sig && buf && buf.includes(sig)) return true;
  return null;
}

/**
 * Bir uyandırma denemesinin ZAMANI geldi mi? Saf — backoff tablosu + son deneme anı.
 * @returns {boolean}
 */
function wakeDue(wake, now, backoff, ackWindowMs, busyRetryMs) {
  if (!wake || wake.ackedAt) return false;
  const attempts = wake.attempts || 0;
  const last = wake.lastAt || 0;
  // ADP-667 — son deneme "lider MEŞGULDÜ" diye ertelendiyse bu bir HATA değil:
  // kısa aralıkla tekrar bak (lider idle'a döner dönmez teslim edilsin). Yazım
  // BAŞARILI olduysa ack penceresi; gerçekten yazılamadıysa backoff adımı.
  //
  // ADP-672 — ERTELEME KONTROLÜ `attempts === 0` KISA-DEVRESİNDEN ÖNCE gelmeli:
  // erteleme artık deneme SAYMADIĞI için (bkz. `stamp`) attempts 0'da kalır ve eski
  // sıralama her tick'i "hemen bak"a çevirirdi — `wakeRetryBusyMs` ölü ayar olurdu.
  if (wake.busyAt && wake.busyAt === last) {
    return now - last >= (typeof busyRetryMs === 'number' ? busyRetryMs : 5_000);
  }
  if (attempts === 0) return true;
  let waitMs;
  if (wake.deliveredAt === last) waitMs = ackWindowMs;
  else waitMs = backoff[Math.min(attempts, backoff.length - 1)];
  return now - last >= waitMs;
}

/**
 * "Sen yokken" özeti — lider pane'ine yazılacak tek satırlık uyandırma metni.
 * Saf: kayıt listesinden metin üretir (IO yok).
 */
function wakeTextFor(records) {
  // ADP-667 — AYNI GÖREVİ (aynı ADP kodunu) taşıyan birden çok kayıt lidere TEK
  // kez anlatılır: retry/sprint-dalgası/respawn yeni delegationId+subtaskId üretir
  // ama iş aynıdır ("çoklu delegationId aynı ADP'yi raporlamasın").
  // 🪤 YALNIZ görev koduna bakmak YANLIŞ: aynı ADP altında ARDIŞIK/PARALEL farklı
  // işler koşar (aynı objective kodu, farklı kanıt dosyası) ve hepsi tek satıra
  // çökerdi — lider 3 bitişten yalnız birini görürdü (ADP-667 e2e S2'de ölçüldü).
  // Kimlik = kanıt dosyası; yoksa alt-görev kimliği.
  const seen = new Set();
  const uniq = [];
  for (const r of records) {
    const key = `${r.status}|${r.taskCode || ''}|${r.evidencePath || r.subtaskId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(r);
  }
  const done = uniq.filter((r) => r.status === 'done');
  const bad = uniq.filter((r) => r.status && r.status !== 'done');
  const parts = [];
  if (done.length) {
    parts.push(
      `${done.length} alt-görev BİTTİ (${done
        .map((r) => `${r.taskCode || r.subtaskId}${r.evidencePath ? ` → ${r.evidencePath}` : ''}`)
        .join(', ')})`,
    );
  }
  if (bad.length) {
    parts.push(
      `${bad.length} alt-görev sorunlu (${bad.map((r) => `${r.taskCode || r.subtaskId}: ${r.status}`).join(', ')})`,
    );
  }
  const detected = uniq.some((r) => r.settledBy && r.settledBy !== SETTLE_SOURCES.RENDERER);
  // Motorun kendi zengin özeti (worker çıktısı/kanıt satırı) varsa taşı — ADP-667'de
  // lider-pane yazımının TEK sahibi supervisor oldu, o bilgi kaybolmasın.
  const notes = uniq.map((r) => (r.note ? String(r.note).replace(/\s+/g, ' ').trim() : '')).filter(Boolean);
  return (
    `[CrewPane supervisor] ${parts.join(' · ')}. ` +
    (detected ? 'Bunu supervisor tespit etti (motor sinyali gelmedi). ' : '') +
    (notes.length ? `${notes.join(' | ').slice(0, 600)} ` : '') +
    'Kuyruk otomatik ilerletildi. Çıktıları incele ve patrona raporla.'
  );
}

/**
 * Supervisor'ı yarat. Tüm IO `deps` ile enjekte edilir.
 *
 * deps:
 *   loadState()                        → ham defter (throw etmemeli)
 *   saveState(state)                   → atomik yazım
 *   listPanes()                        → [{paneId, agentId, alive, command, bytes, disallowSubagent}]
 *   readPaneBuffer(paneId)             → string ('' = yok)
 *   writePane(paneId, text)            → boolean (yazabildi mi)
 *   reapPane(paneId, why)              → boolean
 *   fingerprint(absPath)               → string|null (null = dosya yok)
 *   transcriptHas(rec)                 → boolean|null (null = bakılamadı → ASLA undelivered)
 *                                        ENG-02: claude oturum defteri + codex rollout defteri;
 *                                        eşleme güveni düşükse motor fark etmeksizin null.
 *   notify(evt)                        → void (notifyLog.cjs sözleşmesi)
 *   pushRenderer(channel, payload)     → Promise<boolean> (false/throw = renderer yok)
 *   now()                              → epoch ms
 *   log(line)                          → void
 *   opts                               → DEFAULTS override
 */
function createDelegationSupervisor(deps) {
  const d = deps || {};
  const cfg = { ...DEFAULTS, ...(d.opts || {}) };
  const now = d.now || (() => Date.now());
  const log = d.log || (() => {});
  const noop = () => {};
  const io = {
    loadState: d.loadState || (() => ({})),
    saveState: d.saveState || noop,
    listPanes: d.listPanes || (() => []),
    readPaneBuffer: d.readPaneBuffer || (() => ''),
    writePane: d.writePane || (() => false),
    reapPane: d.reapPane || (() => false),
    fingerprint: d.fingerprint || (() => null),
    // ADP-735 — kanıt dosyasının VARLIK + YAŞ sondası: {exists, mtimeMs, size}.
    // `fingerprint` yalnız "içerik baseline'dan farklı mı" der ve baseline yanlış/bayat
    // alınmışsa sessizce yalan söyler. Bu sonda ondan BAĞIMSIZ ikinci kanaldır:
    // "dosya var mı ve dispatch'ten SONRA mı yazıldı". null döndüren çağıran (eski
    // wiring) için davranış ADP-672 ile birebir aynı kalır.
    evidenceStat: d.evidenceStat || (() => null),
    transcriptHas: d.transcriptHas || (() => null),
    notify: d.notify || noop,
    pushRenderer: d.pushRenderer || (async () => false),
    // ADP-667 — idle-guard'ın ÜÇÜNCÜ sinyali: bu pane'e en son ne zaman TUŞ basıldı
    // (main `pty:input`'ta damgalar). null = bilgi yok → yalnız buffer sinyali koşar.
    lastInputAt: d.lastInputAt || (() => null),
    // ADP-692 — DÖRDÜNCÜ sinyal: bu pane'e en son ne zaman ENTER (CR/LF) basıldı.
    // `lastInputAt > lastSubmitAt` ⇒ son gönderimden beri tuş var ⇒ UÇUŞTA TASLAK →
    // enjeksiyon HİÇ denenmez. null = bilgi yok (eski çağıranlar) → tuş varsa taslak sayılır.
    lastSubmitAt: d.lastSubmitAt || (() => null),
    // ADP-838 — BOARD STATÜ SENKRONU. Defter bitişi görüyordu ama Task Board'a
    // yazan adım YOKTU (lider 27 statüyü elle düzeltti). Karar/HTTP `boardTaskSync.cjs`
    // içinde; supervisor yalnız NE ZAMAN ve HANGİ kanıtla çağrılacağının sahibi.
    // Varsayılan no-op → enjekte etmeyen çağıran (eski wiring/testler) ADP-761
    // davranışını AYNEN görür.
    boardSync: d.boardSync || (async () => ({ ok: false, action: 'not-wired' })),
    // ADP-692 — KANAL A makbuzu: liderin `UserPromptSubmit` hook'u hangi kayıtları
    // tur başında ANLATTI? Bunlar ack'lenir → aynı bitiş bir de pane'e yazılmaz.
    readBriefingReceipts: d.readBriefingReceipts || (() => null),
    consumeBriefingReceipts: d.consumeBriefingReceipts || (() => {}),
    // ADP-672 — uyandırma TESLİMAT doğrulaması. `wakeVerifiable(paneId)` bu lider
    // pane'inin defteri okunabilir mi der; `leaderTranscriptHas` mesajın gerçekten
    // liderin konuşmasına girip girmediğini söyler (null = bakılamadı).
    // ENG-02 — "okunabilir" artık MOTOR BAŞINA: claude → sessionId + cwd,
    // codex → cwd + pane açılış zamanı (rollout defteri eşlemesi), diğer → false.
    // Varsayılanlar KAPALI → enjekte etmeyen çağıran ADP-667 davranışını aynen görür.
    wakeVerifiable: d.wakeVerifiable || (() => false),
    leaderTranscriptHas: d.leaderTranscriptHas || (() => null),
    sleep: d.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
  };

  let state = normalizeState(io.loadState());
  let dirty = false;
  let softDirty = false; // PERF-BG-01 — yalnız canlılık sayacı kirli (bkz. persist)
  const lastDeferLog = new Map(); // Erteleme log kirliliğini önlemek için son log kaydı
  let timer = null;
  let sweeping = false;

  // PERF-BG-01 — DEFTER YAZIMI: KARAR ile CANLILIK SAYACINI AYIR.
  //
  // ÖLÇÜLDÜ (Eren'in çalışan kurulumu, 08.09): `delegation-supervisor.json` 210 KB
  // ve 60 saniyede 51 KEZ TAM OLARAK yeniden yazılıyordu = 178 KB/sn kalıcı disk
  // yazımı. İki ardışık sürümün farkı alındığında 1.952 alanın YALNIZ 2'si
  // değişiyordu: akan pane'in `paneSeen.at` / `paneSeen.bytes` canlılık sayacı.
  // Yani iki sayı için saniyede bir 210 KB. Bedel dosya BÜYÜDÜKÇE artıyor
  // (Temmuz'da 119 KB, Eylül'de 210 KB) — kimsenin bakmadığı, zamanla ağırlaşan
  // bir arka plan yükü.
  //
  // AYRIM: `touch()` bir KARARDIR (settle, uyandırma, kuyruk, budama) → çökme
  // hâlinde kaybı gerçek bir davranış farkı yaratır, ESKİSİ GİBİ HEMEN yazılır.
  // `touchSoft()` yalnız canlılık sayacıdır → çökmede kaybı zararsızdır, çünkü
  // sayaç bir sonraki tick'te CANLI pane'den yeniden okunur. Bu yüzden ilk gerçek
  // yazıma binerek gider; hiçbiri gelmezse sweep sonundaki `persist({ includeSoft })`
  // onu tick başına bir kez (15 sn) diske indirir.
  //
  // KONTROL KOLU: CREWPANE_SUPERVISOR_EAGER_PERSIST=1 → `touchSoft` = `touch`,
  // yani eski (her değişimde yaz) davranışı ve eski rakam geri gelir.
  const EAGER_PERSIST = process.env.CREWPANE_SUPERVISOR_EAGER_PERSIST === '1';

  // Yumuşak (canlılık) durumunun diske inmesi için EN AZ bu kadar geçmeli. Sweep
  // üretimde tick'ten çok daha sık koşuyor (uyandırma takibi ~1/sn — ölçüldü: 60
  // saniyede 51 yazım), dolayısıyla "tick sonunda yaz" tek başına yetmez; zaman
  // tabanı şart. 30 sn'lik bayatlık zararsızdır: sayaç yeniden başlatmada CANLI
  // pane'den yeniden okunur, `idleMs` eşiği dakikalar mertebesindedir.
  const SOFT_PERSIST_MIN_MS = 30_000;
  let lastSoftPersistAt = 0;

  const persist = (opts) => {
    const t = now();
    const softDue = !!(opts && opts.includeSoft) && softDirty
      && (t - lastSoftPersistAt >= SOFT_PERSIST_MIN_MS);
    if (!dirty && !softDue) return;
    try {
      io.saveState(state);
      dirty = false;
      softDirty = false;
      lastSoftPersistAt = t;
    } catch (err) {
      log(`supervisor: defter yazılamadı: ${(err && err.message) || err}`);
    }
  };

  const touch = () => { dirty = true; };
  /** Yalnız canlılık sayacı değişti — bir sonraki gerçek yazıma binsin. */
  const touchSoft = () => { if (EAGER_PERSIST) dirty = true; else softDirty = true; };

  /** Pane haritası — tek listPanes çağrısı tüm tick'e yeter. */
  function paneIndex() {
    const map = new Map();
    let panes = [];
    try { panes = io.listPanes() || []; } catch { panes = []; }
    for (const p of panes) if (p && p.paneId) map.set(p.paneId, p);
    return map;
  }

  /**
   * ADP-761 — PANE KİMLİĞİ: bir kayıt `pane-2`'yi DEĞİL "prowl'un o anki pane'ini"
   * işaret eder. paneId bir ADRES, kimlik değil ve app yeniden başlayınca adresler
   * BAŞTAN dağıtılır (restore pane-1..N'i restore SIRASINA göre mintler). Ölçülen
   * canlı vaka (2026-07-30 defteri): kayıt `{agentId:'prowl', paneId:'pane-2'}`,
   * restore sonrası `pane-2` = **ratchet** → aynı paneId üstünden
   *   • `writePane` prowl'un prompt'unu RATCHET'in terminaline yazar (yanlış ajana
   *     düşen alt-görev),
   *   • `transcriptHas` ratchet'in defterini okuyup "teslim edilmedi" der,
   *   • `reapPane` ÇALIŞAN ratchet pane'ini "hayalet" diye kapatır.
   *
   * Bu yüzden her tick'in BAŞINDA defter ile canlı pane'ler kimlik üzerinden
   * uzlaştırılır: adres başkasına geçmişse pane BAĞI KESİLİR (kayıt silinmez).
   * Bundan sonra kayıt "pane'i kaybolmuş" muamelesi görür — kanıt-önce sıralaması
   * (detect §3) onu dürüstçe kapatır. Pane'in agentId'si BİLİNMİYORSA (eski wiring /
   * çıplak shell pane) karar verilmez: yalnız BİLİNEN iki kimlik ÇELİŞİRSE bağ kesilir.
   */
  function reconcilePaneIdentity(panes) {
    let cut = 0;
    for (const rec of Object.values(state.records)) {
      if (isTerminalStatus(rec.status) || !rec.paneId || !rec.agentId) continue;
      const p = panes.get(rec.paneId);
      if (!p || !p.agentId || p.agentId === rec.agentId) continue;
      log(
        `supervisor: pane KİMLİK uyuşmazlığı ${rec.key} — ${rec.paneId} artık ` +
          `${p.agentId} (kayıt ${rec.agentId}) → pane bağı kesildi (yanlış ajana yazım/reap YOK)`,
      );
      rec.paneLostFrom = rec.paneId;
      rec.paneId = null;
      cut += 1;
      touch();
    }
    if (cut) persist();
    return cut;
  }

  // ── Kayıt yüzeyi (renderer → supervisor) ─────────────────────────────────

  /**
   * Renderer bir alt-görevi dispatch etti. İDEMPOTENT: aynı anahtar tekrar gelirse
   * canlı alanlar (paneId/prompt) tazelenir ama tamamlanma durumu KORUNUR.
   */
  function record(input) {
    if (!input || !input.delegationId || !input.subtaskId) return null;
    const key = recordKey(input.delegationId, input.subtaskId);
    const prev = state.records[key];
    if (prev && isTerminalStatus(prev.status)) return prev; // bitmiş işi diriltme
    const rec = {
      key,
      delegationId: String(input.delegationId),
      subtaskId: String(input.subtaskId),
      agentId: input.agentId || null,
      leaderId: input.leaderId || null,
      department: input.department || null,
      title: input.title || null,
      taskCode: input.taskCode || null,
      // SUP-UI-01 — "kim/ne başlattı" (lider delegasyonu / kullanıcı / sprint dalgası /
      // limit-devam). Defterde yoksa kuyruk paneli o satıra AÇIKÇA "bilinmiyor" yazar.
      origin: input.origin || null,
      paneId: input.paneId || null,
      evidencePath: input.evidencePath || null,
      evidenceBaseline: input.evidenceBaseline === undefined ? null : input.evidenceBaseline,
      // ADP-735 — alternatif kökler + yol-başına baseline (main `evidencePath.cjs` doldurur).
      evidenceAlt: Array.isArray(input.evidenceAlt) ? input.evidenceAlt.filter((p) => typeof p === 'string' && p) : [],
      evidenceBaselines:
        input.evidenceBaselines && typeof input.evidenceBaselines === 'object' ? input.evidenceBaselines : null,
      promptPayload: input.promptPayload || null,
      promptSignature: input.promptSignature || null,
      transcriptPath: input.transcriptPath || null,
      dispatchedAt: (prev && prev.dispatchedAt) || now(),
      status: null,                 // null = uçuşta
      settledAt: null,
      settledBy: null,
      reason: null,
      // ENT-F1 — `textWrittenAt`: prompt metninin pane'e YAZILDIĞI an. "Metin en
      // fazla BİR KEZ yazılır, tekrar yalnız `\r`'dir" sözleşmesinin defteri;
      // damga varsa sonraki denemeler ENTER-ONLY koşar (çift-gönderim üretmez).
      delivery: (prev && prev.delivery) || {
        verified: null, attempts: 0, lastAt: 0, textWrittenAt: 0, deliveredAt: 0,
      },
      wake: (prev && prev.wake) || {
        attempts: 0, lastAt: 0, deliveredAt: 0, ackedAt: 0, enterOnlyNext: false,
      },
      note: (prev && prev.note) || null, // ADP-667 — motorun zengin özeti (uyandırma metnine girer)
      notifiedAt: (prev && prev.notifiedAt) || 0,
      advancedAt: (prev && prev.advancedAt) || 0,
      reapedAt: (prev && prev.reapedAt) || 0,
      paneSeen: (prev && prev.paneSeen) || { bytes: -1, at: now() },
      paneGoneAt: 0,
      // ADP-838 — board senkron defteri. Her faz EN FAZLA BİR KEZ yazılır; damga
      // diskte durur, yani app restart'ı aynı geçişi TEKRAR denemez.
      board: (prev && prev.board) || { dispatchAt: 0, dispatchAction: null, reviewAt: 0, reviewAction: null },
    };
    // ADP-761 — BAYAT MARKER TABANI: bu pane'in tamponunda `DONE:<subtaskId>` ŞU AN
    // kaç kez geçiyor? (Reuse edilen/restore edilen pane'de önceki delegasyonun aynı
    // adlı marker'ı hazır durur.) Bitiş yalnız bu sayı ARTARSA gerçek sayılır.
    // Tamponun O ANKİ uzunluğu da saklanır: rolling pencere budarsa taban düşer.
    {
      const buf = rec.paneId ? safeBuffer(rec.paneId) : '';
      rec.markerBaseline = markerCount(rec, buf);
      rec.markerBufferLen = buf.length;
      if (rec.markerBaseline > 0) {
        log(`supervisor: bayat marker tabanı ${key} — tamponda ${rec.markerBaseline} adet DONE:${rec.subtaskId} zaten var`);
      }
    }
    state.records[key] = rec;
    touch();
    persist();
    log(`supervisor: kayıt açıldı ${key} agent=${rec.agentId} pane=${rec.paneId} kanıt=${rec.evidencePath || '-'}`);
    // ADP-838 — DISPATCH ANINDA board görevi `in_progress`. Ateşle-unut: board
    // senkronu bir YAN ETKİdir, dispatch'i ASLA geciktirmez/düşürmez.
    void runBoardSync(rec, BOARD_PHASES.DISPATCH);
    return rec;
  }

  // ── ADP-838 — Board statü senkronu ───────────────────────────────────────
  /** Aynı fazın iki eşzamanlı isteği olmasın (damga YANIT geldikten sonra düşer). */
  const boardInFlight = new Set();

  /**
   * Bir kaydın board görevini ilgili faza taşı. HER FAZ EN FAZLA BİR KEZ.
   * Sonuç ne olursa olsun (`updated` / `not-found` / `no-forward-move` …) damgalanır:
   * board satırı çözülemeyen bir kayıt her tick'te yeniden sorgulanmaz.
   */
  async function runBoardSync(rec, phase) {
    if (!rec || !rec.board) return null;
    const stampAt = phase === BOARD_PHASES.DISPATCH ? 'dispatchAt' : 'reviewAt';
    const stampAction = phase === BOARD_PHASES.DISPATCH ? 'dispatchAction' : 'reviewAction';
    if (rec.board[stampAt]) return null;
    const guard = `${rec.key}|${phase}`;
    if (boardInFlight.has(guard)) return null;
    boardInFlight.add(guard);
    let res = null;
    try {
      res = await io.boardSync({
        phase,
        key: rec.key,
        taskCode: rec.taskCode || null,
        department: rec.department || null,
        agentId: rec.agentId || null,
        evidencePath: rec.evidencePath || null,
      });
    } catch (err) {
      res = { ok: false, action: `error:${(err && err.message) || err}` };
    } finally {
      boardInFlight.delete(guard);
    }
    // `not-wired` = bu çağıran board senkronunu hiç bağlamamış → damgalama,
    // yoksa wiring sonradan gelirse kayıt sonsuza dek atlanır.
    if (res && res.action === 'not-wired') return res;
    rec.board[stampAt] = now();
    rec.board[stampAction] = (res && res.action) || 'unknown';
    if (res && res.taskId) rec.board.taskId = res.taskId;
    touch();
    persist();
    return res;
  }

  /**
   * Renderer normal yolda settle etti — supervisor defteri hizalar (çift-iş yok).
   *
   * ADP-667 — TEK YAZAR KURALI: `notify` + `kuyruk` hâlâ renderer'ın (o zaten yaptı),
   * ama LİDER-PANE UYANDIRMASI artık HER İKİ yolda da supervisor'ındır. Eskiden
   * burada `wake.ackedAt` damgalanıp supervisor susturuluyordu ve renderer kendi
   * nudge'ını yazıyordu → aynı pane'e iki bağımsız yazar (biri toplama/backoff/
   * sertleştirilmiş guard'sız) = "aynı bitiş 2-3 kez" + yarım-prompt riski.
   * `outcome.note` = motorun zengin özeti; uyandırma metnine taşınır.
   */
  function settle(delegationId, subtaskId, outcome) {
    const key = recordKey(delegationId, subtaskId);
    const rec = state.records[key];
    if (!rec || isTerminalStatus(rec.status)) return false;
    let status = (outcome && outcome.status) || 'done';
    let by = SETTLE_SOURCES.RENDERER;
    let reason = (outcome && outcome.reason) || null;

    // ─────────────────────────────────────────────────────────────────────────
    // ADP-735 — RENDERER'IN 'BAŞARISIZ' HÜKMÜ SORGUSUZ KABUL EDİLMEZ. Motor kendi
    // (tek-kök) kanıt sondasıyla karar verir ve o sonda canlı vakada iki kaydı
    // ("pane exited (code 129) ve beklenen çıktı yok") rapor DİSKTE dururken
    // başarısız damgaladı. Supervisor bu defterin SAHİBİ ve liderin okuduğu tek
    // kaynak; elinde çok-adaylı + mtime tabanlı sonda varken yalanı taşımamalı.
    // Ters yön ASLA yapılmaz: 'done' hükmü kanıt yok diye 'failed'a ÇEVRİLMEZ
    // (marker-only meşru alt-görevler var — ADP-158 mirası).
    // ─────────────────────────────────────────────────────────────────────────
    if (status !== 'done') {
      const seen = evidenceSeen(rec);
      if (seen) {
        log(`supervisor: motor '${status}' dedi ama KANIT DİSKTE (${seen.path}) → hüküm DONE'a düzeltildi (${key})`);
        reason = `motor '${status}' dedi (${reason || 'sebep yok'}); supervisor beklenen çıktıyı diskte buldu: ${seen.path}`;
        status = 'done';
        by = SETTLE_SOURCES.EVIDENCE;
      }
    }
    const corrected = by !== SETTLE_SOURCES.RENDERER;
    markSettled(rec, status, by, reason);
    // Pane geri kazanımı DÜZELTMEDE de renderer'ındır (paneRecycler ADP-561 yazım
    // kuyruğunun İÇİNDE; supervisor dışarıdan yazar) — bu bayrak reapGhostPane'i tutar.
    rec.settleOrigin = 'renderer';
    // Düzeltme yaptıysak bildirim + kuyruk YENİDEN yürümeli: renderer FAIL satırını
    // yazıp 'failed' ile ilerletti, lider DOĞRU sonucu bizden öğrenecek.
    rec.notifiedAt = corrected ? 0 : now();
    rec.advancedAt = corrected ? 0 : now();
    if (outcome && outcome.note) rec.note = String(outcome.note).slice(0, 400);
    if (!cfg.ownLeaderWake) rec.wake.ackedAt = now(); // kill-switch: ADP-667 öncesi davranış
    touch();
    persist();
    return true;
  }

  /** Lider gerçekten baktı (MCP status okuması) → bekleyen uyandırmalar kapanır. */
  function ack(leaderId) {
    let n = 0;
    const t = now();
    for (const rec of Object.values(state.records)) {
      if (rec.leaderId === leaderId && rec.wake && !rec.wake.ackedAt && isTerminalStatus(rec.status)) {
        rec.wake.ackedAt = t;
        n++;
      }
    }
    if (n) { touch(); persist(); log(`supervisor: lider ack (${leaderId}) — ${n} kayıt kapandı`); }
    return n;
  }

  function markSettled(rec, status, by, reason) {
    rec.status = status;
    rec.settledBy = by;
    rec.settledAt = now();
    rec.reason = reason || null;
    // Hayalet-reap KAPI 3'ünün baseline'ı: settle anındaki pane bayt sayacı.
    rec.settleBytes = rec.paneSeen ? rec.paneSeen.bytes : null;
    touch();
  }

  // ── Tespit (renderer'a güvenmeden) ───────────────────────────────────────

  /**
   * ADP-735 — bir kaydın bakılacak TÜM kanıt yolları. Birincil `evidencePath`, ardından
   * `evidenceAlt` (main'in `evidencePath.cjs` ile ürettiği alternatif kökler).
   *
   * NEDEN ÇOKLU: kurulu makinede pane cwd'si workspace PARENT'ıdır ("CrewPane Apps") ama
   * worker raporunu ALT-PROJEYE yazar (`<ws>/crewpane/docs/agent-results/…`). Tek köke
   * çözülen yol `<ws>/docs/agent-results/…` oluyordu — o dizin makinede HİÇ YOKTU →
   * 2026-07-29'da defterdeki 9 kaydın 9'unda da kanıt kapısı ateşlenemedi.
   */
  function evidencePaths(rec) {
    const list = [];
    if (rec.evidencePath) list.push(rec.evidencePath);
    if (Array.isArray(rec.evidenceAlt)) {
      for (const p of rec.evidenceAlt) if (typeof p === 'string' && p && !list.includes(p)) list.push(p);
    }
    return list;
  }

  /**
   * RES-IDX-01 — kanıt BİRİNCİL yolda değil bir ALTERNATİF kökte bulunduysa hüküm
   * cümlesine bunu yaz. "done" hükmü doğru ama rapor yanlış repoya düşmüş demektir;
   * lider/Eren bunu görmezse taşıma da düzeltme de olmaz (aynı sprintte üç yer).
   */
  function foundElsewhereNote(rec, foundPath) {
    if (!rec || !rec.evidencePath || !foundPath || foundPath === rec.evidencePath) return '';
    return ` (⚠ BAŞKA KÖKTE bulundu — beklenen: ${rec.evidencePath})`;
  }

  /** Bir aday yolun dispatch anındaki parmak izi (yol-başına defter, yoksa birincil). */
  function baselineFor(rec, p) {
    const map = rec.evidenceBaselines;
    if (map && typeof map === 'object' && Object.prototype.hasOwnProperty.call(map, p)) return map[p];
    return p === rec.evidencePath ? rec.evidenceBaseline : null;
  }

  /** Kanıt dosyası dispatch-baseline'ından FARKLI mı? (ADP-279 semantiği, çok-adaylı) */
  function evidenceChanged(rec) {
    for (const p of evidencePaths(rec)) {
      let cur = null;
      try { cur = io.fingerprint(p); } catch { continue; }
      if (cur === null) continue;                 // bu adayda dosya yok → sıradaki
      const base = baselineFor(rec, p);
      if (base === undefined) return true;        // baseline alınamadı → varlık yeter
      if (cur !== base) return true;
    }
    return false;
  }

  /**
   * ADP-735 — "BOŞA DÜŞEN WORKER'DA ÖNCE DOSYA SİSTEMİNE BAK". Beklenen çıktı adaylardan
   * birinde VAR mı ve dispatch'ten SONRA mı yazıldı?
   *
   * `evidenceChanged`'den BAĞIMSIZ ikinci kanal: o, dispatch anında alınan baseline'a
   * güvenir; baseline yanlış kökten alınmışsa (canlı vaka) ya da hash okuması ıskalarsa
   * sessizce "kanıt yok" der. Bu sonda yalnız mtime'a bakar — yalan söyleyecek baseline'ı
   * yoktur.
   *
   * @returns {{path:string, mtimeMs:number}|false|null} bulundu | bakıldı-yok | bakılamadı
   */
  function evidenceFresh(rec) {
    const paths = evidencePaths(rec);
    if (!paths.length) return null;
    let looked = false;
    for (const p of paths) {
      let st = null;
      try { st = io.evidenceStat(p); } catch { st = null; }
      if (!st || typeof st !== 'object') continue; // bu sonda bağlı değil (eski wiring)
      looked = true;
      if (!st.exists) continue;
      // ">=" bilerek: dispatch ile yazım aynı milisaniyeye düşebilir (hızlı alt-görev).
      if (typeof st.mtimeMs === 'number' && st.mtimeMs >= (rec.dispatchedAt || 0)) {
        return { path: p, mtimeMs: st.mtimeMs };
      }
    }
    return looked ? false : null;
  }

  /** Kanıt HERHANGİ bir kanalda var mı? (mtime sondası → içerik-hash sondası) */
  function evidenceSeen(rec) {
    const fresh = evidenceFresh(rec);
    if (fresh) return fresh;
    return evidenceChanged(rec) ? { path: rec.evidencePath, mtimeMs: 0 } : null;
  }

  /**
   * ADP-761 — marker SAYACI (varlık değil ADET). subtaskId delegasyon-içi ('st1',
   * 'st2'…) yani GLOBAL DEĞİL: aynı pane'e düşen bir SONRAKİ delegasyonun st1'i,
   * ÖNCEKİ delegasyonun `DONE:st1` satırıyla birebir aynı görünür. Pane tamponu
   * (256 KB) ve `--resume` redraw'ı o satırı taşıdığı için "var mı?" sorusu bayat
   * bir bitişi CANLI sanıyordu. Doğru soru: "dispatch'ten SONRA yeni bir tane geldi mi?"
   */
  function markerCount(rec, buffer) {
    if (!buffer || !rec.subtaskId) return 0;
    // STAT-D1 §KN-1 — BURADA ARTIK DESEN YOK, ÇAĞRI VAR.
    //
    // Eski satır-içi regex `(^|[\r\n])\s*DONE:<id>\b` ANSI'yi süzüyordu ama
    // dispatch ettiğimiz prompt'un TUI ECHO'sunu worker'ın bitişinden ayıramıyordu:
    // `\s*` yalnız boşluk yer, sözleşme satırı sarıldığında `DONE:stX` bir satırın
    // BAŞINA düşer ve desen tutar. STAT-R1 §KN-1 bunu 4 GERÇEK promptPayload'da
    // ölçtü (42/63/125/126 kolonda eşleşme) ve bedelini saydı: 27 delegasyonun
    // 19'u `marker`+`failed`, 12'si ilk 20 saniyede.
    //
    // `markerSafe.countDoneMarkers` renderer'ın (TASK-MQSE75BXC4MW3) echo-güvenli
    // kurallarını uygular VE dispatch edilen sözleşme kuyruğunu tampondan boşluk-
    // esnek olarak siler → sarma HİÇBİR genişlikte marker üretemez (ölçüldü:
    // docs/agent-results/STAT-D1-evidence/01-marker-echo-before-after.txt, 4/4 → 0).
    return countDoneMarkers(buffer, rec.subtaskId, { promptPayload: rec.promptPayload });
  }

  /**
   * Pane çıktısında worker'ın KENDİ DONE marker'ı var mı — DISPATCH'TEN SONRA?
   *
   * Ölçülen canlı vaka (2026-07-30 kabuk log'u): restore edilmiş bir pane'e açılan
   * kayıt 4 satır sonra `TESPİT … → failed (marker)` aldı. Worker o an hiçbir şey
   * basmamıştı; eşleşen `DONE:st2` ÖNCEKİ oturumun ekran kuyruğundan geliyordu.
   * Yanlış-bitiş → lider işi YENİDEN delege eder → ajana İKİNCİ pane açılır
   * (ADP-761'in "aynı ajana 2 pane" ayağının en sık tetikleyicisi).
   *
   * Kural (ADP-279'un kanıt-baseline disiplininin aynısı): kayıt açılırken tampondaki
   * marker ADEDİ taban alınır; bitiş yalnız ADET ARTARSA gerçektir. Tampon KISALDIYSA
   * (256 KB rolling pencere eski satırı attı) taban geçersizdir → 0'a düşürülür,
   * yoksa gerçek bir bitiş sonsuza dek görülmez (yokluk-kanıtı zayıf, ADP-280 kuralı).
   */
  function markerSeen(rec, buffer) {
    const count = markerCount(rec, buffer);
    if (count === 0) return false;
    const baseAt = typeof rec.markerBaseline === 'number' ? rec.markerBaseline : 0;
    if (baseAt === 0) return true;
    const lenAt = typeof rec.markerBufferLen === 'number' ? rec.markerBufferLen : 0;
    const base = buffer.length < lenAt ? 0 : baseAt; // tampon budandı → taban güvenilmez
    return count > base;
  }

  /**
   * Uçuştaki tek kayda çoklu-sinyal tespiti uygula.
   * @returns {{status:string, by:string, reason:string|null}|null}
   */
  function detect(rec, pane, t) {
    // (1) KANIT — en güçlü sinyal; pane canlı olsa bile geçerli (ADP-565 hali).
    if (evidenceChanged(rec)) return { status: 'done', by: SETTLE_SOURCES.EVIDENCE, reason: null };

    const buffer = pane ? safeBuffer(rec.paneId) : '';
    // (2) MARKER — worker "bitti" dedi; kanıt bekleniyorsa kanıt da şart.
    if (markerSeen(rec, buffer)) {
      if (rec.evidencePath) {
        // ── STAT-D1 §KN-7 — MARKER DALINDA TOLERANS ────────────────────────────
        // ESKİDEN: marker görüldüğü MİKROSANİYEDE kanıt dosyası yoksa TERMİNAL
        // 'failed'. Ne bir grace, ne yeniden sorma — oysa pane-exit dalının
        // `paneGoneGraceMs=8000` toleransı, idle dalının İKİ kademesi var.
        // ÖLÇÜLDÜ (STAT-R1 §4.5): sahte-FAIL alan işlerin ÇOĞU raporunu SONRADAN
        // gerçekten yazdı — pane-65 FAIL 07:16 → rapor 07:39 (23 dk),
        // pane-71 FAIL 08:27 → rapor 08:41 (14 dk). Yani 'anında hüküm' yalnız
        // yanlış değil, SİSTEMATİK olarak yanlıştı.
        //
        // ARTIK: marker + kanıt hedefi ⇒ TERMİNAL HÜKÜM YOK. Kayıt uçuşta kalır,
        // kanıt her tick'te (1) numaralı dalda YENİDEN sorulur ve iş ya
        // `evidence done` ile DOĞRU kapanır ya da idle kademesine (`idleFailMs`,
        // 15 dk sessizlik + boş composer + kanıt yok) düşer. Bugünkü 19 sahte-FAIL
        // bu tek kararla önlenirdi (STAT-R1 §9'un acil hafifletme önerisi).
        if (!rec.markerSeenAt) {
          rec.markerSeenAt = t;
          touch();
          log(
            `supervisor: ${rec.key} worker BİTTİ dedi (marker) ama beklenen çıktı henüz yok — ` +
              `hüküm YOK, kanıt yoklanmaya devam ediyor: ${evidencePaths(rec).join(' | ')}`,
          );
        }
        // ⚠️ ERKEN `return null` YOK — kayıt burada DURMAZ, aşağıdaki dallara DEVAM
        // eder. Aksi hâlde marker'ı basıp susan bir worker sonsuza dek uçuşta kalırdı
        // ("terminal hüküm yok" ≠ "hiç hüküm yok"): pane-exit ve idle kademeleri
        // (15 dk sessizlik + boş composer + kanıt yok) yine karar verebilmeli.
      } else {
        return { status: 'done', by: SETTLE_SOURCES.MARKER, reason: null };
      }
    }

    // (3) PANE EXIT — pty öldü. Kanıtın diske düşmesi için kısa bir tolerans tanı.
    if (!pane) {
      if (!rec.paneGoneAt) { rec.paneGoneAt = t; touch(); return null; }
      if (t - rec.paneGoneAt < cfg.paneGoneGraceMs) return null;
      // ADP-735 — ölüm ilanından ÖNCE dosya sistemine bak. Canlı vakada iki kayıt
      // ("pane exited (code 129) ve beklenen çıktı yok") raporu DİSKTE dururken
      // başarısız damgalandı: pane'in nasıl kapandığı, işin bitip bitmediğini söylemez.
      const freshOnExit = evidenceFresh(rec);
      if (freshOnExit) {
        return {
          status: 'done',
          by: SETTLE_SOURCES.EVIDENCE,
          reason: `pane kapandı ama beklenen çıktı yazılmış: ${freshOnExit.path}${foundElsewhereNote(rec, freshOnExit.path)}`,
        };
      }
      return {
        status: 'failed',
        by: SETTLE_SOURCES.PANE_EXIT,
        // STAT-D1 §KN-6 — mesajda BİRİNCİL yol değil TÜM adaylar. Ölçüldü: kurulu
        // makinede pane cwd'si workspace PARENT'ı, worker ise raporunu
        // `<root>/crewpane/docs/agent-results/` altına yazıyor; doğru yol
        // `evidenceAlt[0]`da KAYITLI olduğu hâlde kullanıcıya var olmayan bir yol
        // gösteriliyordu (bugün `docs/.agent-notifications`'ta 4 örnek).
        reason: rec.evidencePath
          ? `pane kapandı ve beklenen çıktı hiçbir adayda yok: ${evidencePaths(rec).join(' | ')}`
          : 'pane kapandı, tamamlanma sinyali yok',
      };
    }
    if (rec.paneGoneAt) { rec.paneGoneAt = 0; touch(); } // pane geri geldi (restore)

    // ── (4) SESSİZ + PROMPT'TA BEKLİYOR (ADP-672'nin ana düzeltmesi) ──────────
    // Kanıt (1)'de, marker (2)'de, ölü pane (3)'te yakalanır. Geriye Eren'in canlı
    // vakasındaki DÖRDÜNCÜ hal kalıyordu ve HİÇBİR sinyali yoktu: worker turunu
    // bitirdi, prompt'a döndü, sonuç dosyasını YAZMADI, `DONE:` de basmadı, pane de
    // ayakta. ADP-659 burada yalnız bayt sayacını tazeleyip `null` dönüyordu →
    // "uçuşta" sonsuza dek sürüyor, lider `working` okuyor, patrona "hâlâ çalışıyor"
    // diyor. Artık bu hâl DÜRÜSTÇE kapatılır.
    //
    // İKİ sinyal birden şart (yanlış-pozitif önlemi — uzun bir tool çağrısı "sessiz"
    // sanılmasın): (a) buffer `idleMs` boyunca TEK BAYT değişmedi, (b) worker BOŞ
    // composer'da bekliyor. Koşan tur ("esc to interrupt"), açık menü, yarım yazılmış
    // metin veya okunamayan çerçeve → `composerState` 'busy'/'unknown' döner ve
    // settle ETMEYİZ. Sessizlik saati her yeni baytta sıfırlanır.
    const bytes = typeof pane.bytes === 'number' ? pane.bytes : buffer.length;
    if (!rec.paneSeen || rec.paneSeen.bytes !== bytes) {
      rec.paneSeen = { bytes, at: t };
      touchSoft(); // PERF-BG-01 — canlılık sayacı; 210 KB'lık defteri tek başına yazdırmaz
      return null;
    }
    if (!cfg.idleMs || t - rec.paneSeen.at < cfg.idleMs) return null;
    let cs = 'unknown';
    try { cs = composerState(buffer); } catch { cs = 'unknown'; }
    if (cs !== 'empty') return null; // meşgul/bilinmiyor → EMİN DEĞİLİZ → bekle

    // ─────────────────────────────────────────────────────────────────────────
    // ADP-735 — HÜKÜMDEN ÖNCE DOSYA SİSTEMİ. Buraya kadar yalnız pty'ye bakılmıştı;
    // 2026-07-29'da tam da bu yüzden raporunu yazmış üç worker "BAŞARISIZ" damgalandı.
    // Boşa düşmüş bir worker'da SORULACAK İLK SORU "beklenen çıktı var mı ve
    // dispatch'ten yeni mi", pty'nin ne kadar sustuğu DEĞİL.
    // ─────────────────────────────────────────────────────────────────────────
    const fresh = evidenceFresh(rec);
    if (fresh) {
      return {
        status: 'done',
        by: SETTLE_SOURCES.EVIDENCE,
        reason: `worker prompt'a döndü ve beklenen çıktı dispatch'ten SONRA yazılmış: ${fresh.path}${foundElsewhereNote(rec, fresh.path)}`,
      };
    }

    // Süre insan-okur olmalı: `Math.round(ms/60000)` kısa pencerede "0 dakikadır
    // sessiz" gibi anlamsız bir cümle üretiyordu (e2e çıktısında yakalandı).
    const quietMs = t - rec.paneSeen.at;
    const quietText = quietMs < 60_000 ? `${Math.round(quietMs / 1000)} saniyedir` : `${Math.round(quietMs / 60_000)} dakikadır`;

    // ADP-735 — SESSİZ ≠ BAŞARISIZ. Kanıt yok + sessiz, ölüm ilanı için YETMEZ; bu hâl
    // defterlenir ve `idleFailMs` dolana kadar beklenir (worker düşünüyor / uzun bir araç
    // çağrısında / kullanıcı cevabını bekliyor olabilir).
    const failAfter = Math.max(cfg.idleFailMs || 0, cfg.idleMs);
    if (quietMs < failAfter) {
      if (!rec.idleSince) {
        rec.idleSince = t;
        touch();
        log(
          `supervisor: ${rec.key} SESSİZ (${quietText}) + kanıt yok — henüz hüküm YOK, ` +
            `${Math.round(failAfter / 60_000)} dk dolmadan başarısız SAYILMAZ`,
        );
      }
      return null;
    }
    return {
      status: 'failed',
      by: SETTLE_SOURCES.IDLE,
      reason:
        (rec.markerSeenAt ? "worker BİTTİ dedi ama çıktı hiç oluşmadı; " : '') +
        `worker ${quietText} sessiz ve boş prompt'ta bekliyor — alt-görev KOŞMUYOR` +
        (rec.evidencePath
          ? `, beklenen çıktı hiçbir adayda yok: ${evidencePaths(rec).join(' | ')}`
          : ', tamamlanma sinyali yok'),
    };
  }

  function safeBuffer(paneId) {
    try { return io.readPaneBuffer(paneId) || ''; } catch { return ''; }
  }

  // ── ENT-F1 — teslim primitifi (supervisor'ın KENDİ io'suna bağlı) ─────────
  //
  // Yük vekili: son sweep'te sayılan canlı pane sayısı (submit boşluğu buna göre
  // büyür — ADP-920'nin yük-farkında boşluğu ana süreçte de koşsun diye).
  let lastPaneCount = 0;
  const deliver = createDeliverPrompt({
    readPaneBuffer: (id) => safeBuffer(id),
    writePane: (id, data) => {
      try { return io.writePane(id, data) === true; } catch { return false; }
    },
    sleep: (ms) => io.sleep(ms),
    now,
    livePaneCount: () => lastPaneCount,
    log,
  });

  // ── Teslimat doğrulama (resume-picker yutması) ───────────────────────────

  /**
   * Dispatch worker'a GERÇEKTEN ulaştı mı? Ulaşmadıysa supervisor KENDİ yeniden
   * gönderir; yeniden gönderim de tutmazsa dürüstçe 'undelivered' damgalar.
   *
   * ENT-F1 — `async`: yeniden gönderim artık TESLİM DOĞRULAR (metin → yük-farkında
   * boşluk → `\r` → composer ölçümü → gerekirse artan gecikmeyle Enter tekrarı).
   * Bunun bir süresi vardır ve sweep onu BEKLEMEK ZORUNDA: "yazıldı" hükmünü
   * ölçmeden vermek tam olarak ENT-R1'in bulduğu yalandı.
   * @returns {Promise<boolean>} kayıt bu tick'te terminal oldu mu
   */
  async function verifyDelivery(rec, pane, t) {
    const del = rec.delivery;
    if (del.verified === true) return false;
    if (!rec.promptPayload && !rec.promptSignature) return false; // doğrulanacak imza yok
    if (t - rec.dispatchedAt < cfg.deliveryCheckMs) return false;
    if (del.lastAt && t - del.lastAt < cfg.deliveryCheckMs) return false;

    let transcript = null;
    try { transcript = io.transcriptHas(rec); } catch { transcript = null; }
    // AXP-03 — merdiven SAF fonksiyona çıkarıldı (`deliveryVerdict`): Agent X teslim
    // yolu (agentxDeliver.cjs) AYNI hükmü buradan alır, ikinci bir kopya yazmaz.
    const verdict = deliveryVerdict({
      transcript,
      buffer: pane && rec.promptSignature ? safeBuffer(rec.paneId) : '',
      signature: rec.promptSignature,
    });
    del.lastAt = t;
    touch();

    if (verdict === null) return false;   // bakılamadı → ASLA undelivered (ADP-280 kuralı)
    if (verdict === true) { del.verified = true; log(`supervisor: teslim doğrulandı ${rec.key}`); return false; }

    // TESLİM EDİLMEMİŞ — resume-picker/boot yutması. Kendi yeniden gönder.
    //
    // ─────────────────────────────────────────────────────────────────────────
    // ENT-F1 — P0: BURASI ENTER'I HİÇ BASMIYORDU
    // ─────────────────────────────────────────────────────────────────────────
    // Eski hâl `io.writePane(paneId, promptPayload)` idi ve HEPSİ BUYDU: ne boşluk,
    // ne bracketed-paste, ne `\r`, ne doğrulama. `rec.promptPayload` = ham prompt
    // (CR'ı `dispatchPayload` ekler, supervisor kaydı ham metni tutar) → yeniden
    // gönderim TANIM GEREĞİ hiçbir koşulda Enter basmazdı. Log "yazıldı" diyordu;
    // "yazıldı" burada "teslim edildi" DEĞİL, "baytlar pty'ye gitti" demekti.
    // Gerçek claude 2.1.246 + gerçek node-pty ile tekrar üretildi (ENT-R1 §5b):
    // boşta bir pane'de bile 25 sn sonra `paste again to expand` çipi asılı, worker'ın
    // oturum defteri HİÇ oluşmamış.
    //
    // İKİNCİ DENEME **ENTER-ONLY**: metin ekranda ZATEN asılıdır; ikinci kez yazmak
    // onu üst üste bindirir ve biri Enter'a bastığında motor işi İKİ KEZ alır
    // (ENT-R1 §5a/A3 bu birikmeyi pty'de fotoğrafladı). `textWrittenAt` damgası
    // "metin en fazla BİR KEZ" sözleşmesinin defteridir.
    //
    // ── DELEG-DELIVER-01 — "ENTER-ONLY" KOŞULU ARTIK ÖLÇÜLÜYOR ────────────────
    // Yukarıdaki gerekçe metin EKRANDA ASILIYKEN doğrudur. Ama 06.09'un vakası
    // BAŞKA: prompt, motor tek bayt basmadan yazıldı → metin composer'a HİÇ
    // VARMADI. O hâlde Enter boş satır gönderir ve telafi yapısı gereği tutmaz
    // (canlı log: `yeniden-gönderim#2 … ENTER-ONLY iptal (guard:menu) — metin
    // TEKRAR YAZILMADI, Enter da basılmadı`). Karar artık `attempts` SAYACINDAN
    // değil EKRAN ÖLÇÜMÜNDEN türer: metin gerçekten asılıysa Enter-only (çift
    // gönderim koruması aynen korunur), asılı DEĞİLSE 'auto' → metin bir kez
    // daha yazılır. 'auto'nun kendi ikinci kemeri de var: `pendingTextOnScreen`
    // görürse yine yazmaz, ayrıca yeniden-yazım yalnız composer ÖLÇÜLEBİLİR
    // BOŞKEN yapılır (menü/okunamaz ekranda hiçbir şey yazılmaz).
    if (del.attempts < cfg.deliveryResendMax && rec.paneId && rec.promptPayload) {
      del.attempts += 1;
      const pendingNow = pendingTextOnScreen(safeBuffer(rec.paneId));
      const enterOnly = del.attempts > 1 && !!del.textWrittenAt && pendingNow;
      const res = await deliver(rec.paneId, rec.promptPayload, {
        mode: enterOnly ? 'enter-only' : 'auto',
        textWrittenAt: del.textWrittenAt || null,
        label: `yeniden-gönderim#${del.attempts} ${rec.key}`,
      });
      if (res.wroteText && res.textWrittenAt) del.textWrittenAt = res.textWrittenAt;
      if (res.delivered) {
        // Composer boşaldı = BİZİM Enter'ımız işledi. Transcript hükmü bir sonraki
        // turda gelir; burada yalnız teslimin ÖLÇÜLDÜĞÜNÜ defterleriz.
        del.deliveredAt = t;
      }
      log(
        `supervisor: teslim YOK ${rec.key} → yeniden gönderim #${del.attempts} ` +
          `(${res.delivered ? 'teslim doğrulandı' : `teslim DOĞRULANAMADI: ${res.reason}`}, ` +
          `ekrandaBekleyenMetin=${pendingNow}, mod=${enterOnly ? 'enter-only' : 'auto'}, ` +
          `metin=${res.wroteText ? 'yazıldı' : 'yazılmadı'}, enter=${res.enters})`,
      );
      touch();
      return false;
    }
    // ADP-705 — SESSİZ KALMA YASAK + hatalı koşulu tekrarlama. Supervisor pane AÇAMAZ
    // (renderer'ın işi), ama bu kaydı dürüstçe kapatınca hayalet-reap o pane'i geri
    // kazanır ve ajanın SIRADAKİ işi TAZE bir pane'e düşer — liderin elle yaptığı
    // "kapat + yeniden delege et" hareketinin supervisor tarafındaki karşılığı.
    markSettled(
      rec,
      'undelivered',
      SETTLE_SOURCES.PANE_EXIT,
      `prompt worker'ın oturum defterine (transcript) hiç düşmedi — ${del.attempts} yeniden-gönderim de teslim edemedi; ` +
        `pane geri kazanılıyor, işi TAZE bir pane'e yeniden delege et`,
    );
    return true;
  }

  // ── ENT-F1 §6.4 — ASILI PROMPT KURTARMA TARAMASI (yalnız `\r`) ───────────
  //
  // NEDEN AYRI BİR TARAMA: `verifyDelivery` yalnız TRANSKRİPT hükmü 'false' geldiğinde
  // devreye girer. Ama teslim edilememiş bir prompt'un EN GÖRÜNÜR imzası ekrandadır:
  // composer'ın dibinde `[Pasted text #N] · paste again to expand` çipi asılıdır.
  // Transkript sondası bakılamaz durumdaysa (null → ADP-280 kuralı gereği ASLA
  // undelivered) bugün hiç kimse o çipi görmüyor ve prompt sonsuza dek orada kalıyor.
  //
  // BU TARAMA ASLA METİN YAZMAZ — yalnız `\r`. Boş composer'da `\r` no-op'tur, dolu
  // composer'da bekleyeni gönderir. Üç kilit:
  //   (1) yalnız AÇIK bir dispatch kaydı olan ve `delivery.verified !== true` pane,
  //   (2) ekranda GERÇEKTEN bekleyen metin ölçülmüş olmalı ('menu'/'unknown' → dur),
  //   (3) İNSAN KORUMASI ZORUNLU: `injectionGate` (lastInputAt/lastSubmitAt/draftGrace)
  //       — insanın yarım taslağı ASLA gönderilmez. Kapı iki ARDIŞIK okuma ister ve
  //       aralarında gerçek gecikme bırakırız (aynı anda alınan iki okuma "stabil"
  //       der ama hiçbir şey kanıtlamaz — ADP-667 dersi).
  //
  // HÜKÜM SAHİPLİĞİ DEĞİŞMEZ: bu tarama yalnız KURTARIR. 'undelivered' damgası
  // `verifyDelivery`nin merdiveninde kalır (iki yerden hüküm vermek, ADP-705'in
  // çözdüğü "hatalı koşulu tekrarlama" sorununu geri getirirdi).
  async function recoverHangingPrompts(panes, t) {
    for (const rec of Object.values(state.records)) {
      if (isTerminalStatus(rec.status)) continue;
      const del = rec.delivery;
      if (!del || del.verified === true) continue;
      if (!rec.paneId || !panes.has(rec.paneId)) continue;
      // Renderer'ın KENDİ doğrulaması (~2,7 sn) bitmeden karışma; sonra da kayıt
      // başına en fazla bir deneme / `deliveryCheckMs`.
      if (t - rec.dispatchedAt < cfg.deliveryCheckMs) continue;
      if (del.recoverAt && t - del.recoverAt < cfg.deliveryCheckMs) continue;

      const a = safeBuffer(rec.paneId);
      if (!pendingTextOnScreen(a)) continue; // (2) ekranda bekleyen metin YOK → dokunma
      await io.sleep(cfg.wakeSampleGapMs);
      const b = safeBuffer(rec.paneId);
      let lastInputAt = null;
      let lastSubmitAt = null;
      try { lastInputAt = io.lastInputAt(rec.paneId); } catch { lastInputAt = null; }
      try { lastSubmitAt = io.lastSubmitAt(rec.paneId); } catch { lastSubmitAt = null; }
      // (3) injectionGate'in composer sinyali BOŞ composer ister — bizim durumumuzda
      // composer DOLU (asılı prompt), o yüzden kapıyı İNSAN VARLIĞI için kullanırız:
      // taslak uçuşta / az önce tuşlandı → DOKUNMA.
      const presence = humanPresence({
        lastInputAt,
        lastSubmitAt,
        now: now(),
        quietMs: cfg.wakeInputQuietMs,
        draftGraceMs: cfg.wakeDraftGraceMs,
      });
      if (presence.present) {
        del.recoverAt = t;
        touch();
        log(
          `supervisor: ${rec.key} composer'ında asılı prompt VAR ama İNSAN etkileşimde ` +
            `(${GATE_REASON_TR[presence.reason] || presence.reason}) — ENTER BASILMADI`,
        );
        continue;
      }
      // Ekran iki okuma arasında DEĞİŞTİYSE TUI hâlâ çiziyor ya da biri yazıyor → ertele.
      if (a !== b) { del.recoverAt = t; touch(); continue; }

      del.recoverAt = t;
      del.recovered = (del.recovered || 0) + 1;
      touch();
      const res = await deliver(rec.paneId, rec.promptPayload || '', {
        mode: 'enter-only',
        label: `kurtarma#${del.recovered} ${rec.key}`,
      });
      log(
        `supervisor: ASILI PROMPT kurtarma ${rec.key} → ` +
          `${res.delivered ? 'teslim doğrulandı' : `hâlâ ${res.outcome} (${res.reason})`} ` +
          `(enter=${res.enters}, metin=YAZILMADI)`,
      );
    }
  }

  // ── Settle sonrası: notify · kuyruk · reap · lider uyandırma ─────────────

  function notifyOnce(rec) {
    if (rec.notifiedAt) return;
    const kind = rec.status === 'done' ? 'done' : rec.status === 'undelivered' ? 'fail' : 'fail';
    try {
      // ADP-667 — main'deki bildirim KAPISI (notifyGate) tekilleştirir + toplar.
      // `delegationId` kapının aynı delegasyonun gereksiz REPORT satırını düşürmesi
      // için gerekli. `duplicate` dönerse bu bitişi başka bir kanal zaten yazmış —
      // satır atlanır ama LİDER UYANDIRMASI yine de bu kayıttan yürür (ayrı kanal:
      // notify-log kalıcı iz, uyandırma liderin bağlamı).
      const res = io.notify({
        kind,
        task: rec.taskCode || rec.subtaskId,
        detail: rec.status === 'done'
          ? `${rec.agentId ? `${rec.agentId}: ` : ''}${rec.evidencePath || rec.title || ''}`.trim() || undefined
          : rec.reason || undefined,
        department: rec.department || undefined,
        delegationId: rec.delegationId,
        // ADP-667 — "aynı bitiş" kimliği: kanıt dosyası (yoksa alt-görev kimliği).
        subtaskId: rec.subtaskId,
        evidence: rec.evidencePath || undefined,
      });
      if (res && res.duplicate) log(`supervisor: bildirim zaten yazılmış, tekrarlanmadı (${rec.key})`);
      rec.notifiedAt = now();
      touch();
    } catch { /* notify best-effort */ }
  }

  /** Kuyruğu ilerlet: renderer'a "bu iş bitti, defterini hizala + kuyruğu boşalt" push'u. */
  async function advanceQueue(rec) {
    if (rec.advancedAt) return;
    let ok = false;
    try {
      ok = await io.pushRenderer('dlgsup:advance', {
        delegationId: rec.delegationId,
        subtaskId: rec.subtaskId,
        agentId: rec.agentId,
        status: rec.status,
        reason: rec.reason,
        settledBy: rec.settledBy,
        evidencePath: rec.evidencePath,
      });
    } catch { ok = false; }
    if (ok) {
      rec.advancedAt = now();
      touch();
      log(`supervisor: kuyruk ilerletildi ${rec.key} (${rec.settledBy})`);
    }
    // ok=false → renderer yok/yanıtsız; bir sonraki tick yeniden dener (kayıt diskte).
  }

  /**
   * HAYALET PANE REAP — settle olmuş kaydın execution pane'i hâlâ ayakta duruyorsa
   * geri kazan. Aynı pane'i kullanan BAŞKA uçuştaki kayıt varsa dokunma.
   */
  function reapGhostPane(rec, panes, t) {
    if (rec.reapedAt || !rec.paneId) return;
    const pane = panes.get(rec.paneId);
    if (!pane) { rec.reapedAt = now(); touch(); return; } // zaten yok
    if (pane.disallowSubagent !== true) { rec.reapedAt = now(); touch(); return; } // lider/insan pane'i — ASLA
    // KAPI 1 — motor kendi settle ettiyse geri kazanım RENDERER'ın paneRecycler'ınındır
    // (o, ADP-561 per-pane yazım kuyruğunun İÇİNDEDİR; supervisor dışarıdan yazar).
    // ADP-735 — `settleOrigin` de sayılır: supervisor motorun hükmünü DÜZELTTİĞİNDE
    // settledBy 'evidence' olur ama pane'i yine renderer geri kazanır (yazım yarışı yok).
    if (rec.settledBy === SETTLE_SOURCES.RENDERER || rec.settleOrigin === 'renderer') { rec.reapedAt = now(); touch(); return; }
    // KAPI 2 — REUSE penceresi: biten pane çoğu zaman sıradaki alt-göreve verilir;
    // o kaydın açılmasına zaman tanı, yoksa `/clear` yeni dispatch'le yarışır.
    if (t - (rec.settledAt || 0) < cfg.reapGraceMs) return;
    for (const other of Object.values(state.records)) {
      if (other.key !== rec.key && other.paneId === rec.paneId && !isTerminalStatus(other.status)) return;
    }
    // KAPI 3 — pane SUSMUŞ olmalı. (Dikkat: "settle'dan beri HİÇ bayt üretmemiş"
    // demek YANLIŞ olurdu: tek bir redraw/echo bile pane'i sonsuza dek reap edilemez
    // yapardı. Doğru soru "şu an kullanılıyor mu": son bayt değişiminden bu yana
    // reapGraceMs geçmiş mi?)
    const bytesNow = typeof pane.bytes === 'number' ? pane.bytes : null;
    if (bytesNow !== null) {
      if (rec.postSettle == null || rec.postSettle.bytes !== bytesNow) {
        rec.postSettle = { bytes: bytesNow, at: t };
        touch();
        return; // yeni çıktı → sessizlik saati sıfırlandı
      }
      if (t - rec.postSettle.at < cfg.reapGraceMs) return;
    }
    let done = false;
    try { done = io.reapPane(rec.paneId, `supervisor ${rec.settledBy}`); } catch { done = false; }
    if (done) {
      rec.reapedAt = now();
      touch();
      log(`supervisor: hayalet pane reap edildi ${rec.paneId} (${rec.key})`);
    }
  }

  /**
   * LİDER UYANDIRMA — kalıcı, backoff'lu, ack'e kadar tekrarlı.
   * Kanal 1 (notify-log) her settle'da zaten yazıldı; burası kanal 2: liderin
   * KENDİ pane'ine idle-guard'lı yazım. Lider pane'i yoksa kayıt bekler ve lider
   * geri gelince "sen yokken" özeti olarak teslim edilir.
   */
  /** Liderin KENDİ pane'i = ajan kimliği lider olan, delegasyon EXECUTION pane'i OLMAYAN. */
  function findLeaderPane(panes, leaderId) {
    for (const p of panes.values()) {
      if (p.agentId === leaderId && p.disallowSubagent !== true) return p;
    }
    return null;
  }

  function canVerifyWake(paneId) {
    try { return io.wakeVerifiable(paneId) === true; } catch { return false; }
  }

  /**
   * ADP-672 — YAZILDI mı, ULAŞTI mı? Yazımdan `wakeVerifyMs` sonra liderin oturum
   * defterinde mesaj aranır:
   *   • bulundu  → ack (iş görüldü, tekrar yok)
   *   • YOK      → yazım YUTULMUŞ (tur ortası) → teslim izi silinir, backoff'la YENİDEN yazılır
   *   • null     → bakılamadı → eski davranış (teslim = ack), yanlış-tekrar üretme
   * Canlı Fury vakasının doğrudan kapısı: log "uyandırıldı" derken liderin defterinde
   * o mesajın 0 eşleşmesi vardı ve kayıt sonsuza dek kapalı kalmıştı.
   */
  function verifyWakes(panes, t) {
    for (const rec of Object.values(state.records)) {
      const wake = rec.wake;
      if (!wake || wake.ackedAt || !wake.deliveredAt || !wake.needle) continue;
      if (t - wake.deliveredAt < cfg.wakeVerifyMs) continue;
      const pane = findLeaderPane(panes, rec.leaderId);
      let seen = null;
      try { seen = pane ? io.leaderTranscriptHas(pane.paneId, wake.needle) : null; } catch { seen = null; }
      if (seen === true) {
        wake.ackedAt = t;
        wake.verified = true;
        touch();
        log(`supervisor: uyandırma liderin defterinde DOĞRULANDI (${rec.key})`);
        continue;
      }
      if (seen === false) {
        wake.lost = (wake.lost || 0) + 1;
        wake.deliveredAt = 0;
        // ENT-F1 — KAYIP DALI ÖNCE ENTER-ONLY DENER. "Liderin defterine girmemiş"in
        // en olası sebebi mesajın composer'da ASILI kalmasıdır (Enter yutuldu), ve o
        // hâlde metni YENİDEN YAZMAK aynı mesajın İKİNCİ kopyasını üst üste bindirir
        // (ENT-R1 §5a/A3). Bayrak bir sonraki `wakeLeaders` turunda okunur: enjeksiyon
        // kapısı (injectionGate + compare-and-swap) orada ZATEN koşuyor — burada ikinci
        // bir yazım noktası AÇMIYORUZ, var olanın modunu değiştiriyoruz.
        wake.enterOnlyNext = !!wake.needle;
        wake.needle = null;
        touch();
        if (wake.lost >= cfg.wakeLostMax) {
          wake.ackedAt = t; // pane kanalı bu kayıt için tükendi — notify-log kalıcı iz taşıyor
          log(`supervisor: uyandırma ${wake.lost} kez YUTULDU (${rec.key}) — pane kanalı bırakıldı, notify-log'da duruyor`);
        } else {
          log(`supervisor: uyandırma liderin defterine GİRMEMİŞ (${rec.key}) — yutuldu, yeniden yazılacak (${wake.lost}. kez)`);
        }
        continue;
      }
      // Bakılamadı → ADP-667 davranışı: yazıldıysa görülmüş say (yanlış tekrar üretme).
      wake.ackedAt = t;
      touch();
    }
  }

  /**
   * ADP-692 — KANAL A MAKBUZUNU TÜKET. Liderin `UserPromptSubmit` hook'u bir bitişi tur
   * başında anlattıysa lider ONU ZATEN BİLİYOR: kayıt ack'lenir ve pane'e ASLA yazılmaz.
   *
   * Bu, iki kanalın çakışmasını önleyen tek noktadır — aksi hâlde lider aynı bitişi hem
   * bağlamında okur hem de composer'ında görür (ADP-667'nin çözdüğü "aynı bitiş 2-3 kez"
   * israfının yeni bir kaynağı olurdu).
   *
   * ZAMANLAMA (kanal A ↔ kanal B yarışı neden yok): kullanıcı ENTER'a bastığı ANDA
   * `lastSubmitAt` damgalanır ve `wakeInputQuietMs` (2sn) boyunca enjeksiyon kapalıdır;
   * hook ise milisaniyeler içinde makbuzu yazar ve bu fonksiyon her sweep'te uyandırmadan
   * ÖNCE koşar. Hook gecikirse de sorun yok: lider o sırada bir TUR KOŞUYOR ("esc to
   * interrupt") ve composer hükmü zaten enjeksiyonu erteler.
   */
  function consumeBriefings(t) {
    let receipt = null;
    try { receipt = io.readBriefingReceipts(); } catch { receipt = null; }
    const entries = (receipt && receipt.entries) || null;
    if (!entries) return 0;
    let acked = 0;
    for (const [key, meta] of Object.entries(entries)) {
      const rec = state.records[key];
      if (!rec || !rec.wake) continue;
      if (rec.wake.briefedAt) continue;
      rec.wake.briefedAt = (meta && meta.at) || t;
      rec.wake.ackedAt = rec.wake.ackedAt || rec.wake.briefedAt;
      rec.wake.channel = 'briefing';
      touch();
      acked++;
    }
    if (acked) {
      log(`supervisor: ${acked} bitişi lider TUR BAŞINDA okudu (kanal A) — pane'e enjeksiyon YOK`);
      persist();
    }
    return acked;
  }

  async function wakeLeaders(panes, t) {
    const byLeader = new Map();
    for (const rec of Object.values(state.records)) {
      if (!isTerminalStatus(rec.status) || !rec.leaderId) continue;
      // ADP-667 TOPLAMA — settle'dan hemen sonra yazma: pencerede biten diğer işler de
      // AYNI mesaja girsin. (İlk deneme sonrası bu kapı geçilmiş sayılır; erteleme
      // döngüsü kaydı sonsuza dek bekletmez.)
      if ((rec.wake.attempts || 0) === 0 && t - (rec.settledAt || 0) < cfg.wakeCoalesceMs) continue;
      if (!wakeDue(rec.wake, t, cfg.wakeBackoffMs, cfg.wakeAckWindowMs, cfg.wakeRetryBusyMs)) continue;
      if ((rec.wake.attempts || 0) >= cfg.wakeAttemptsMax) continue;
      const list = byLeader.get(rec.leaderId) || [];
      list.push(rec);
      byLeader.set(rec.leaderId, list);
    }
    for (const [leaderId, recs] of byLeader) {
      const leaderPane = findLeaderPane(panes, leaderId);
      // ADP-672 — 🔴 ERTELEME DENEME SAYMAZ. Eskiden "lider meşgul" dalı da
      // `attempts`'ı artırıyordu ve `wakeAttemptsMax=8` bu bütçeyi tüketiyordu:
      // `wakeRetryBusyMs=5sn` ile MEŞGUL bir lider 40 SANİYEDE bütçeyi bitirir,
      // kayıt bir daha HİÇ ele alınmaz ("attempts >= max → continue") ve lider
      // bitişi ÖĞRENEMEZ. Bir LLM lider neredeyse her zaman meşguldür → bu, tüm
      // takımlarda sessiz kayıp üretiyordu. Bütçe artık YALNIZ gerçek yazım
      // denemelerini sayar; erteleme ayrı bir sayaçta (`defers`) izlenir.
      const stamp = (busy) => {
        for (const r of recs) {
          if (busy) {
            r.wake.defers = (r.wake.defers || 0) + 1;
            r.wake.busyAt = t;
          } else {
            r.wake.attempts = (r.wake.attempts || 0) + 1;
            r.wake.busyAt = 0;
          }
          r.wake.lastAt = t;
        }
        touch();
      };
      if (!leaderPane) {
        // Lider oturumu yok (öldürüldü/yeniden başlıyor) → deneme SAYMA, birikmeye devam.
        // Lider geri gelince aynı kayıtlar "sen yokken" özetiyle teslim edilir.
        continue;
      }
      // ADP-667 — iki okuma ARASINDA gerçek gecikme şart: aynı anda alınan iki okuma
      // her zaman eşittir ve "stabil" hükmünü VAKUM yapardı (guard'ın pratikte
      // kesmesinin ikinci sebebi). Üçüncü sinyal: son tuş basımından beri sessizlik.
      // ADP-692 — ÖRNEKLEME BAŞLADI teşhis satırı. Bir clobber şikâyetinde "kapı ne
      // zaman baktı, kullanıcı ne zaman yazdı" sorusu ancak bu damgayla cevaplanır;
      // e2e yarış senaryosu da tam bu satırı görüp 100ms sonra tuşa basar.
      const prevLog = lastDeferLog.get(leaderId) || { at: 0, reason: null, count: 0 };
      if (t - prevLog.at >= 30_000) {
        log(`supervisor: lider ${leaderId} composer örneklemesi başladı (gap=${cfg.wakeSampleGapMs}ms)`);
      }
      const a = safeBuffer(leaderPane.paneId);
      await io.sleep(cfg.wakeSampleGapMs);
      const b = safeBuffer(leaderPane.paneId);
      const inputOpts = () => {
        let lastInputAt = null;
        let lastSubmitAt = null;
        try { lastInputAt = io.lastInputAt(leaderPane.paneId); } catch { lastInputAt = null; }
        try { lastSubmitAt = io.lastSubmitAt(leaderPane.paneId); } catch { lastSubmitAt = null; }
        return {
          lastInputAt,
          lastSubmitAt,
          now: now(),
          quietMs: cfg.wakeInputQuietMs,
          draftGraceMs: cfg.wakeDraftGraceMs,
        };
      };
      const gate = injectionGate(a, b, inputOpts());
      if (!gate.safe) {
        stamp(true);
        const curDefers = recs[0].wake.defers || 0;
        const reasonChanged = gate.reason !== prevLog.reason;
        const timePassed = (t - prevLog.at >= 30_000);
        if (curDefers === 1 || reasonChanged || timePassed) {
          lastDeferLog.set(leaderId, { at: t, reason: gate.reason, count: curDefers });
          log(
            `supervisor: lider ${leaderId} ${GATE_REASON_TR[gate.reason] || gate.reason} — enjeksiyon YAPILMADI ` +
              `(erteleme ${curDefers}, yazım denemesi ${recs[0].wake.attempts || 0} — bütçe HARCANMADI; ` +
              `bitişler defterde duruyor, lider tur başında OKUYACAK)`,
          );
        }
        continue; // kısa aralıkla TEKRAR denenir — VAZGEÇME yok
      }
      lastDeferLog.delete(leaderId);
      const text = wakeTextFor(recs);
      // ─────────────────────────────────────────────────────────────────────
      // ADP-692 — SON AN KONTROLÜ (compare-and-swap). Yukarıdaki `b` okuması ile
      // yazım arasında bir insan tuşu araya girebilir; ADP-667'nin mikro yarışı tam
      // buydu. Buradan `io.writePane`'e kadar HİÇBİR `await` YOKTUR: main tek iş
      // parçacıklıdır, dolayısıyla `pty:input` IPC handler'ı bu blok bitmeden
      // ÇALIŞAMAZ → kontrol ile yazım ATOMİKTİR. Bir tuş ya kontrolden ÖNCE
      // damgalanır (burada iptal ederiz) ya da yazımdan SONRA gelir.
      // ─────────────────────────────────────────────────────────────────────
      const c = safeBuffer(leaderPane.paneId);
      const finalGate = injectionGate(b, c, inputOpts());
      if (!finalGate.safe) {
        stamp(true);
        log(
          `supervisor: lider ${leaderId} — SON AN kontrolünde ${GATE_REASON_TR[finalGate.reason] || finalGate.reason}, ` +
            `enjeksiyon İPTAL (yarım prompt riski önlendi)`,
        );
        continue;
      }
      // Teşhis: guard'ın "yazmak güvenli" derken NE GÖRDÜĞÜ. Bir clobber şikâyetinde
      // ilk bakılacak yer burasıdır (ADP-667'de e2e'yi bununla kırmızıdan çıkardık).
      log(`supervisor: guard OK ${leaderId} — son satır: ${JSON.stringify(c.replace(/\s+/g, ' ').slice(-80))}`);
      // ─────────────────────────────────────────────────────────────────────
      // ENT-F1 — P1: metin ve `\r` ARKA ARKAYA yazılıyordu (0 ms boşluk) ve
      // hiçbir şey doğrulanmıyordu. ADP-048'in ölçtüğü yutulma penceresi tam
      // burasıydı; ADP-672'nin "yazıldı ≠ ulaştı" bulgusu da bunun sonucu.
      //
      // METİN YAZIMI BURADA KALIR (yukarıdaki compare-and-swap sözleşmesi):
      // `finalGate` ile `writePane` arasında `await` OLAMAZ. Primitif bu yüzden
      // 'submit-only' modunda çağrılır — metni o yazmaz, yalnız yük-farkında
      // boşluğu bekler, `\r`'yi basar ve composer'dan ÖLÇEREK gerekirse Enter'ı
      // artan gecikmeyle TEKRARLAR. Metin İKİNCİ KEZ hiçbir dalda yazılmaz.
      //
      // ENT-F1 — KAYIP UYANDIRMANIN İLK DENEMESİ: metin ekranda hâlâ asılıysa
      // (`verifyWakes` "defterine girmemiş" dedi ve composer bunu doğruluyor)
      // METİN YAZILMAZ, yalnız `\r` basılır. Bu, ENT-R1 §6.1'in "metin en fazla
      // bir kez" sözleşmesinin lider tarafındaki karşılığıdır.
      const wantEnterOnly = recs.some((r) => r.wake && r.wake.enterOnlyNext);
      const enterOnlyNow = wantEnterOnly && pendingTextOnScreen(c);
      let wrote = false;
      if (enterOnlyNow) {
        log(`supervisor: lider ${leaderId} — mesaj composer'da ASILI, metin TEKRAR YAZILMIYOR (yalnız ENTER)`);
        wrote = true;
      } else {
        try { wrote = io.writePane(leaderPane.paneId, text) === true; } catch { wrote = false; }
      }
      let delivery = null;
      if (wrote) {
        delivery = await deliver(leaderPane.paneId, text, {
          mode: enterOnlyNow ? 'enter-only' : 'submit-only',
          label: `lider-uyandırma ${leaderId}`,
        });
        if (!delivery.enters) wrote = false; // `\r` hiç yazılamadıysa teslim iddiası YOK
      }
      stamp(false);
      if (wrote) {
        for (const r of recs) {
          r.wake.deliveredAt = t;
          // ADP-667 — TESLİM = ACK. Eskiden ack YALNIZ liderin MCP status okumasıyla
          // gelirdi; okumayan lider (çoğu) 90sn sonra AYNI mesajı tekrar alıyordu →
          // Eren'in "aynı bitiş iki-üç kez" şikâyetinin üçüncü kaynağı. Mesaj liderin
          // bağlamına girdiyse iş görülmüştür; tekrarı token israfıdır.
          //
          // ADP-672 — AMA "yazıldı" ≠ "bağlamına girdi". Fury vakasında pty yazımı
          // başarılıydı, liderin oturum defterinde mesaj YOKTU (tur ortasında yutuldu)
          // ve "teslim=ack" kaydı kapattığı için lider bir daha uyandırılmadı. Artık
          // ack, doğrulama yapılabiliyorsa `verifyWakes`'e bırakılır; yapılamıyorsa
          // (codex/shell pane → transcript yok) eski davranış AYNEN korunur.
          r.wake.needle = String(text).slice(0, 160);
          // ENG-11 (ENG-R3 §3.3-C) — DÜŞÜŞ ARTIK SESSİZ DEĞİL. Defteri olmayan
          // motorda "teslim=ack" bir ÖLÇÜM değil VARSAYIMDIR; kayıt bunu işaretler
          // (`ackAssumed`) ve log tek satırda söyler. Zamanlama/davranış AYNI kalır —
          // değişen tek şey, gevşemenin görünür olması: ADP-672'de kimsenin fark
          // etmemesinin sebebi tam olarak bu satırın sessizliğiydi.
          // ENT-F1 — composer ÖLÇÜMÜNÜN hükmü de deftere düşer: transkript sondası
          // olmayan motorda (`ackAssumed`) bu, elimizdeki TEK teslim kanıtıdır.
          r.wake.submitOutcome = delivery ? delivery.outcome : null;
          r.wake.textWrittenAt = t;
          r.wake.enterOnlyNext = false; // denendi — bir sonraki tur normal yola döner
          if (!canVerifyWake(leaderPane.paneId)) {
            r.wake.ackedAt = t;
            r.wake.ackAssumed = true;
          }
        }
        touch();
        const assumed = recs.some((r) => r.wake && r.wake.ackAssumed);
        log(
          `supervisor: lider uyandırıldı ${leaderId} (${recs.length} kayıt TEK mesajda, deneme ${recs[0].wake.attempts})`
          + (assumed ? ' — ⚠️ TESLİM DOĞRULANAMIYOR (bu pane\'de oturum defteri yok): ack VARSAYILDI' : ''),
        );
      }
    }
    persist();
  }

  // ── Restart onarımı ──────────────────────────────────────────────────────

  /**
   * App yeniden başladı: defterde uçuşta görünen kayıtların pane'i artık yok →
   * kanıta bakarak dürüstçe kapat. Renderer'ın in-memory motoru zaten öldüğü için
   * bu kayıtları başka hiçbir şey kapatamaz (30 fix'in kör noktası).
   */
  /**
   * KILL-GUARD-01 (madde 5) — DIŞ KAPANIŞ DAMGASI.
   *
   * Uygulama dışarıdan bir sinyalle kapanırken çağrılır. Kayıtları burada SETTLE
   * ETMEYİZ, yalnız DAMGALARIZ: kapanış anında pane'ler hâlâ canlı olabilir ve
   * "failed" demek erken olurdu; asıl karar bir sonraki açılışta `repairAfterRestart`
   * pane'in GERÇEKTEN kaybolduğunu görünce verilir. Damga o kararın GEREKÇESİNİ
   * taşır — 08.09'da bu bilgi yalnız süpervizör defterini elle okuyarak çıkarılabildi.
   *
   * Senkron ve best-effort: `before-quit` içinde koşar, çıkışı geciktiremez.
   */
  function markExternalShutdown(signal) {
    const t = now();
    const hit = [];
    for (const rec of Object.values(state.records)) {
      if (isTerminalStatus(rec.status)) continue;
      rec.externalShutdown = { signal: String(signal || 'signal'), at: t };
      hit.push({
        taskCode: rec.taskCode || null,
        agentId: rec.agentId || null,
        title: rec.title || null,
        subtaskId: rec.subtaskId || null,
      });
    }
    if (hit.length) {
      touch();
      persist(); // ÇIKIŞ ANINDA: bir sonraki tick gelmeyecek, şimdi yazılmazsa kaybolur
      log(`supervisor: dış kapanış (${signal}) — ${hit.length} uçuştaki delegasyon damgalandı`);
    }
    return hit;
  }

  /** Dış kapanış damgasından tek satırlık devir notu (yoksa null). */
  function externalShutdownNote(hits) {
    if (!hits || !hits.length) return null;
    const names = hits
      .map((h) => h.taskCode || h.title || h.agentId || h.subtaskId)
      .filter(Boolean)
      .slice(0, 6);
    return (
      `⚠️ DEVİR — ${hits.length} worker dış kapanışla kesildi (uygulama dışarıdan kapatıldı): ` +
      `${names.join(', ')}${hits.length > names.length ? ' …' : ''}. İşleri YARIM; yeniden dağıtman gerekebilir.`
    );
  }

  function repairAfterRestart() {
    const t = now();
    const panes = paneIndex();
    // ADP-761 — ÖNCE kimlik uzlaştırması: restart'ta paneId'ler yeniden dağıtıldığı
    // için "pane restore edildi" kararı YALNIZ adrese bakılarak verilemez.
    reconcilePaneIdentity(panes);
    let repaired = 0;
    const externallyKilled = [];
    for (const rec of Object.values(state.records)) {
      if (isTerminalStatus(rec.status)) continue;
      if (rec.paneId && panes.has(rec.paneId)) continue; // pane restore edildi → normal takip
      // KILL-GUARD-01 — kapanış anında damgalandıysa SEBEP bilinir. Kanıt yazılmışsa
      // yine `done` (dış kapanış işin bittiğini geçersiz kılmaz); yazılmamışsa
      // "yeniden başladı" değil "biri kapattı" denir.
      const ext = rec.externalShutdown;
      if (evidenceChanged(rec)) {
        markSettled(rec, 'done', SETTLE_SOURCES.REPAIR, null);
      } else if (ext) {
        markSettled(
          rec,
          'failed',
          SETTLE_SOURCES.EXTERNAL_KILL,
          `uygulama DIŞARIDAN kapatıldı (${ext.signal}) — pane öldü, iş yarım kaldı, kanıt yok`,
        );
        externallyKilled.push({
          taskCode: rec.taskCode || null,
          agentId: rec.agentId || null,
          title: rec.title || null,
          subtaskId: rec.subtaskId || null,
        });
      } else {
        markSettled(rec, 'failed', SETTLE_SOURCES.REPAIR, 'uygulama yeniden başladı, pane kayboldu ve kanıt yok');
      }
      // Lider bunu MUTLAKA öğrensin: ack sıfırlanır, uyandırma yeniden kurulur.
      rec.wake = { attempts: 0, lastAt: 0, deliveredAt: 0, ackedAt: 0 };
      repaired++;
    }
    if (repaired) {
      log(`supervisor: restart onarımı — ${repaired} öksüz kayıt dürüstçe kapatıldı`);
      // TEK SATIRLIK DEVİR NOTU — liderin açılışta göreceği cümle. Bugüne kadar bu
      // bilgi yalnız defteri elle okuyarak çıkarılabiliyordu.
      const note = externalShutdownNote(externallyKilled);
      if (note) log(`supervisor: ${note}`);
      persist();
    }
    return repaired;
  }

  /**
   * Terminal + ack'lenmiş eski kayıtları buda (defter sınırsız büyümesin).
   *
   * 🪤 DELEG-COMMS-01 — PANE YAŞARKEN KAYDINI BUDAMAK YALAN ÜRETİR. `leaderStatus`
   * "izlenmeyen" derken defterin HİÇ görmediği pane'i arar (`claimedPanes`); budanan
   * kayıt da tam olarak "hiç görülmemiş" gibi davranır. Sonuç, 09.09'da kendi
   * ofisimizde ÖLÇÜLEN hâl: 24 saatten eski bir delegasyonun pane'i hâlâ açıktı ve
   * ürün lidere "⚠ İZLENMEYEN 1 worker pane … supervisor tamamlanmasını TESPİT
   * EDEMEZ, kendin kontrol et" dedi — oysa o pane'i izlemiş, tespit etmiş ve
   * raporlamıştı. Lider hayalet kovalar.
   *
   * Bu yüzden CANLI her pane için EN YENİ kaydı tutuyoruz. Defter sınırsız büyümez:
   * üst sınır canlı pane sayısıdır (pane kapanınca kayıt bir sonraki tick'te düşer).
   */
  function prune(t, panes) {
    const keepByPane = new Map();
    if (panes && typeof panes.has === 'function') {
      for (const rec of Object.values(state.records)) {
        if (!rec.paneId || !panes.has(rec.paneId)) continue;
        const cur = keepByPane.get(rec.paneId);
        if (!cur || (rec.settledAt || 0) > (cur.settledAt || 0)) keepByPane.set(rec.paneId, rec);
      }
    }
    for (const [key, rec] of Object.entries(state.records)) {
      if (!isTerminalStatus(rec.status)) continue;
      if (t - (rec.settledAt || 0) < cfg.retentionMs) continue;
      if (rec.paneId && keepByPane.get(rec.paneId) === rec) continue; // pane HÂLÂ açık — defterde kalsın
      delete state.records[key];
      touch();
    }
  }

  /**
   * ADP-667 — bekleyen bir uyandırmanın vadesi bir sonraki tick'ten ÖNCE doluyorsa
   * tek-atışlık ek sweep planla. (Toplama penceresi 10sn, tick 15sn: aksi hâlde
   * lider bir bitişi 25sn sonra öğrenirdi.) `unref` → uygulama çıkışını tutmaz.
   */
  let followUpTimer = null;
  function scheduleWakeFollowUp(t) {
    let nextAt = Infinity;
    for (const rec of Object.values(state.records)) {
      if (!isTerminalStatus(rec.status) || !rec.leaderId) continue;
      const wake = rec.wake || {};
      if (wake.ackedAt || (wake.attempts || 0) >= cfg.wakeAttemptsMax) continue;
      const due =
        (wake.attempts || 0) === 0
          ? (rec.settledAt || t) + cfg.wakeCoalesceMs
          : (wake.lastAt || t) + (wake.busyAt === wake.lastAt ? cfg.wakeRetryBusyMs : 0);
      if (due < nextAt) nextAt = due;
    }
    if (!Number.isFinite(nextAt)) return;
    const delay = Math.max(250, nextAt - t + 100);
    if (delay >= cfg.tickMs) return; // normal tick zaten yetişir
    if (followUpTimer) return;
    followUpTimer = setTimeout(() => {
      followUpTimer = null;
      void sweep();
    }, delay);
    if (followUpTimer && typeof followUpTimer.unref === 'function') followUpTimer.unref();
  }

  // ── Tick ─────────────────────────────────────────────────────────────────

  /** Tek tur. Testler doğrudan çağırır (timer'a bağlı kalmadan). */
  async function sweep() {
    if (sweeping) return;
    sweeping = true;
    try {
      const t = now();
      const panes = paneIndex();
      lastPaneCount = panes.size; // ENT-F1 — yük vekili (submit boşluğu buna göre büyür)
      // ADP-761 — her tick'in İLK işi: kaydın paneId'si HÂLÂ kendi ajanına mı ait?
      // (restart/pane-geri-dönüşümü adresi başkasına vermiş olabilir.)
      reconcilePaneIdentity(panes);

      // 1) Uçuştaki kayıtlar: teslimat doğrulama + çoklu-sinyal tespiti
      for (const rec of Object.values(state.records)) {
        if (isTerminalStatus(rec.status)) continue;
        const pane = rec.paneId ? panes.get(rec.paneId) : null;
        if (await verifyDelivery(rec, pane, t)) continue; // undelivered damgalandı
        const verdict = detect(rec, pane, t);
        if (verdict) {
          // Hayalet-reap KAPI 3'ü için settle ANINDAKİ bayt sayacını sabitle.
          if (pane && typeof pane.bytes === 'number') rec.paneSeen = { bytes: pane.bytes, at: t };
          markSettled(rec, verdict.status, verdict.by, verdict.reason);
          log(`supervisor: TESPİT ${rec.key} → ${verdict.status} (${verdict.by})`);
        }
      }

      // 2) Terminal kayıtlar: notify → kuyruk ilerlet → hayalet pane reap
      for (const rec of Object.values(state.records)) {
        if (!isTerminalStatus(rec.status)) continue;
        // Renderer kendi settle ettiyse notify/nudge/kuyruk zaten onun işi (çift-iş yok).
        if (rec.settledBy !== SETTLE_SOURCES.RENDERER) {
          notifyOnce(rec);
          await advanceQueue(rec);
        }
        // ADP-838 — BOARD → `review` (ASLA `done`: insan onayı kalır).
        // İKİ ŞART birden: hüküm `done` VE kanıt GERÇEKTEN diskte. `settledBy`ye
        // BAKMAZ (renderer'ın settle'ı da board'a yansımalı — 27 elle düzeltmenin
        // çoğu oradan geliyordu), ama motorun "bitti" SÖZÜNE de güvenmez: kanıtı
        // supervisor'ın kendi sondasıyla ölçer. Kanıt yoksa board'a dokunulmaz.
        if (rec.status === 'done' && rec.board && !rec.board.reviewAt) {
          if (evidenceSeen(rec)) {
            void runBoardSync(rec, BOARD_PHASES.DONE);
          } else if (!rec.boardNoEvidenceLogged) {
            rec.boardNoEvidenceLogged = true;
            touch();
            log(`supervisor: ${rec.key} 'done' ama KANIT diskte yok → board statüsü DEĞİŞTİRİLMEDİ`);
          }
        }
        reapGhostPane(rec, panes, t);
      }

      // 2.5) ENT-F1 — ekranda ASILI kalmış prompt'ları kurtar (yalnız `\r`,
      //      injectionGate korumasıyla). Transkript sondası bakılamıyorsa bu
      //      taramanın gördüğü çip, teslimin başarısız olduğunun TEK kanıtıdır.
      await recoverHangingPrompts(panes, t);

      // 3) ADP-692 KANAL A — liderin tur-başı brifingi neyi anlattıysa onu ack'le
      //    (uyandırmadan ÖNCE: pane'e gereksiz yazım hiç denenmesin).
      consumeBriefings(t);
      // 4) Uyandırma TESLİMAT doğrulaması (ADP-672) → sonra lider uyandırma
      //    (toplama penceresi + idle-guard + backoff/ack)
      verifyWakes(panes, t);
      await wakeLeaders(panes, t);

      prune(t, panes);
      // PERF-BG-01 — tick sonunda canlılık sayacı da diske iner (tick başına EN FAZLA
      // bir kez), böylece uygulama beklenmedik biçimde ölürse defter en çok bir tick
      // eski olur.
      persist({ includeSoft: true });
      // ADP-667 — TOPLAMA penceresi tick'ten (15sn) kısa: bekleyen uyandırma varsa
      // bir sonraki tick'i bekleme, penceresi dolar dolmaz tek-atışlık sweep planla.
      scheduleWakeFollowUp(t);
    } catch (err) {
      log(`supervisor: sweep hatası: ${(err && err.message) || err}`);
    } finally {
      sweeping = false;
    }
  }

  function start() {
    repairAfterRestart();
    if (timer) return;
    timer = setInterval(() => { void sweep(); }, cfg.tickMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    log(`supervisor: başladı (tick=${cfg.tickMs}ms, ${Object.keys(state.records).length} kayıt)`);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (followUpTimer) { clearTimeout(followUpTimer); followUpTimer = null; }
    lastSoftPersistAt = 0; // kapanışta zaman tabanı ATLANIR: son durum diske insin
    persist({ includeSoft: true });
  }

  /**
   * ADP-672 — ÇEKME (pull) YÜZEYİ: "durum ne?" sorusunun KALICI cevabı.
   *
   * Push kanalları (notify-log + lider-pane uyandırma) tek başına yetmiyor: patron
   * lidere sorduğunda lider KENDİ hafızasından cevap veriyor ("Stark hâlâ çalışıyor").
   * Statü aracının bugünkü kaynağı renderer defteriydi; renderer reload/app restart
   * sonrası o defter BOŞ olur ve lider "aktif delegasyon yok" ya da bayat "working"
   * okur. Bu yüzey main'in DİSKTEKİ defterinden okur — renderer'dan bağımsız.
   *
   * `untracked`: defterde KAYDI OLMAYAN ama açık duran execution pane'leri. Eski-yol
   * (tmux/spawn-worker, elle açılmış pane) delegasyonlar burada DÜRÜSTÇE raporlanır —
   * sessizce "her şey yolunda" denmez.
   */
  function leaderStatus(leaderId) {
    const t = now();
    const panes = paneIndex();
    const wanted = String(leaderId || '').trim();
    const all = Object.values(state.records);
    // 🪤 e2e çıktısında yakalandı: burası önce YALNIZ uçuştaki kayıtların pane'lerini
    // sayıyordu → işi BİTMİŞ bir worker'ın pane'i "İZLENMEYEN" diye raporlanıyordu.
    // Bu yalan lideri hayalet kovalamaya gönderir: o pane izlendi, tespit edildi ve
    // raporlandı; kapatılması reap'in işi. "İzlenmeyen" YALNIZ defterin HİÇ görmediği
    // pane demektir (eski-yol/elle açılmış).
    const claimedPanes = new Set(all.filter((r) => r.paneId).map((r) => r.paneId));
    const records = all
      .filter((r) => !wanted || r.leaderId === wanted)
      .sort((a, b) => (a.dispatchedAt || 0) - (b.dispatchedAt || 0))
      .map((r) => ({
        delegationId: r.delegationId,
        subtaskId: r.subtaskId,
        agentId: r.agentId,
        leaderId: r.leaderId,
        department: r.department,
        taskCode: r.taskCode,
        title: r.title,
        paneId: r.paneId,
        evidencePath: r.evidencePath,
        // null = uçuşta; supervisor'ın GÖRDÜĞÜ hâl (renderer'ın değil).
        status: r.status || 'in-flight',
        settledBy: r.settledBy,
        reason: r.reason,
        note: r.note,
        dispatchedAt: r.dispatchedAt || 0,
        settledAt: r.settledAt || 0,
        ageMs: t - (r.dispatchedAt || t),
        paneAlive: r.paneId ? panes.has(r.paneId) : false,
        leaderNotified: !!(r.wake && (r.wake.deliveredAt || r.wake.ackedAt)),
        // ADP-838 — "board'a yansıdı mı?" sorusunun kalıcı cevabı. Lider bunu
        // okuyabildiği için statüyü elle kovalamak zorunda kalmaz.
        board: r.board || null,
      }));
    const untracked = [...panes.values()]
      .filter((p) => p.disallowSubagent === true && !claimedPanes.has(p.paneId))
      .map((p) => ({ paneId: p.paneId, agentId: p.agentId || null, command: p.command || null }));
    return { at: t, records, untracked };
  }

  return {
    record,
    settle,
    ack,
    sweep,
    leaderStatus,
    start,
    stop,
    repairAfterRestart,
    /** KILL-GUARD-01 — dış kapanışta uçuştaki kayıtları damgala (before-quit'ten). */
    markExternalShutdown,
    /** KILL-GUARD-01 — damgalanan kayıtlardan tek satırlık devir notu (test/e2e dikişi). */
    externalShutdownNote,
    /** ADP-692 — kanal A makbuzunu tüket (test/e2e dikişi; sweep zaten çağırır). */
    consumeBriefings: (t) => consumeBriefings(typeof t === 'number' ? t : now()),
    /** Test/e2e gözlem yüzeyi (kopya döner). */
    snapshot: () => JSON.parse(JSON.stringify(state)),
    config: () => ({ ...cfg }),
  };
}

module.exports = {
  STORE_VERSION,
  DEFAULTS,
  SETTLE_SOURCES,
  recordKey,
  normalizeState,
  wakeDue,
  wakeTextFor,
  deliveryVerdict,
  createDelegationSupervisor,
};
