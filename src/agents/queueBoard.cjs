// CrewPane — SUP-UI-01: KUYRUK PANELİNİN SAF ÇEKİRDEĞİ.
//
// KAPATILAN SINIF: kuyruk tamamen SESSİZ çalışıyordu. Eren'in şikâyeti ("bazen bi
// iş başlıyo komut veriyo, ne nerden geldi niye geldi anlaşılmıyor; limit bittikten
// sonra yenilenince birden geliyo") iki kez ÖLÇÜLDÜ:
//   (a) RES-01 denetimi — 62.668 pane-verdict'inin tamamı `clean`, kullanıcıya
//       görünen tek iz iyimser "✓"; Eren 5 pane'e ELLE "devam et" yazmak zorunda kaldı.
//   (b) 2026-08-10 — `crewpane_delegate` "KUYRUĞA ALINDI (sıra 1)" dedi, iş HİÇ
//       başlamadı: kuyruk yalnız pane ÇIKIŞINDA ilerliyor, işini bitirip prompt'ta
//       bekleyen worker arkasındaki HER ŞEYİ sonsuza bloklar. İki görev saatlerce
//       çürüdü ve kimse görmedi.
//
// Bu modül YENİ DEFTER İCAT ETMEZ. Diskte ZATEN duran üç defteri tek tabloya çevirir:
//   • `delegation-queue.json`      (renderer'ın meşgul-kuyruğu + paused kayıtlar)
//   • `delegation-supervisor.json` (main'in uçuş defteri — ADP-659)
//   • `resume-queue.json`          (limit-sonrası devam kuyruğu — ADP-087)
// Dördüncü girdi canlı pane listesidir (main'in `ptys` defteri) — TIKANMA ancak
// "kuyruk bekliyor + önündeki pane BOŞTA" çakıştırmasıyla görülebilir.
//
// SAF: fs/electron YOK, `Date.now()` YOK (çağıran `now` geçirir) → node --test ile
// doğrudan koşar (queueBoard.test.cjs). METİN de YOK: satırlar KOD döndürür
// (`origin.code`, `warning.code`), Türkçe/İngilizce cümleyi renderer i18n'den kurar
// — main'e gömülü metin yazmak çeviri kapısının (check-i18n) kapattığı sınıftır.
//
// 🔴 DÜRÜSTLÜK KURALI (SUP-UI-01 §2): kaynağı BİLİNMEYEN kayıt sessiz boşluk değil,
// AÇIKÇA `unknown` döner (`origin.known === false`). Panel onu "bilinmiyor" yazar.
// Tahmin edilen kaynak da `known:false` ile işaretlenir — panelde uydurma yok.

'use strict';

// Planlanan başlangıç saatleri UYDURULMAZ: limit kuyruğunun zamanlaması
// resumeScheduler'ın KENDİ sabitlerinden okunur (aynı tampon, aynı 15sn aralık),
// böylece panelin yazdığı saat daemon'ın gerçekten ateşleyeceği andır.
const { RESET_BUFFER_MS, STAGGER_MS, firstDelayMs } = require('../terminal/resumeScheduler.cjs');

/** Bir pane bu kadar süredir TEK BAYT üretmediyse "boşta" sayılır (tıkanma sondası). */
const DEFAULT_IDLE_MS = 120_000;
/** Panelde gösterilen "biten iş" sayısı (defter binlerce kayıt tutabilir). */
const DEFAULT_DONE_LIMIT = 12;

/**
 * KAYNAK KODLARI — "kim/ne başlattı" sorusunun makine-okur cevabı.
 * `unknown` bilinçli olarak LİSTEDEDİR: bilinmeyen kaynak da bir cevaptır.
 */
const ORIGIN_CODES = Object.freeze([
  'leader-delegation', // lider (MCP `crewpane_delegate` / köprü) verdi
  'user', // insan doğrudan başlattı (Jarvis sesi / panel düğmesi)
  'sprint-wave', // uzun sprint dalgası
  'auto-queue', // hedef meşguldü → busy-guard kuyruğa aldı
  'limit-resume', // limit yenilenmesi → otomatik devam
  'restart-rehydrate', // uygulama yeniden başladı → kuyruk diskten dirildi
  'unknown', // kaydın kaynağı defterde YOK (açıkça söylenir)
]);
const ORIGIN_SET = new Set(ORIGIN_CODES);

const WARNING_CODES = Object.freeze([
  'blocked-idle-pane', // kuyruk bekliyor, önündeki pane BOŞTA → kapat, kuyruk ilerlesin
  'blocked-missing-pane', // kuyruk bekliyor, uçuştaki kaydın pane'i ARTIK YOK → defteri hizala
]);

function str(v) {
  return typeof v === 'string' && v ? v : null;
}
function num(v) {
  return Number.isFinite(v) ? v : null;
}
function obj(v) {
  return v && typeof v === 'object' ? v : {};
}
function arr(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * Görev kodu: önce klasik "ADP-659 / SUP-UI-01" biçimi, sonra board kimliği
 * ("TASK-MSM5UKTEUIC2H"). Bulunamazsa null — panel kodu yoksa başlığı gösterir.
 */
function taskCodeOf(...texts) {
  for (const text of texts) {
    if (typeof text !== 'string' || !text) continue;
    const board = /\bTASK-[A-Z0-9]{6,}\b/.exec(text);
    if (board) return board[0];
    const classic = /\b([A-Z]{2,}(?:-[A-Z]{2,})?-\d+[A-Za-z]?)\b/.exec(text);
    if (classic) return classic[1];
  }
  return null;
}

/** Bilinen kaynak kodu mu? (Bilinmeyen değer sessizce geçmez — null döner.) */
function normalizeOrigin(value) {
  return typeof value === 'string' && ORIGIN_SET.has(value) && value !== 'unknown' ? value : null;
}

/**
 * Kaydın kaynağı. Sıra: (1) kaydın KENDİ `origin` alanı (dispatch anında yazılır),
 * (2) YAPISAL kesinlik — paused/limit kuyruğundaki bir iş tanım gereği limit-devamıdır,
 * (3) restart-devam prompt öneki, (4) `unknown`.
 *
 * `known:false` yalnız (4) için döner; panel o satırda "bilinmiyor" yazar ve varsa
 * defterdeki lider kimliğini İPUCU olarak gösterir (tahmini kaynak diye SUNMAZ).
 */
function originOf(raw, lane) {
  const src = obj(raw);
  const leaderId = str(src.leaderId);
  const explicit = normalizeOrigin(src.origin);
  if (explicit) return { code: explicit, known: true, leaderId };
  const objective = str(src.objective) || '';
  if (objective.startsWith('[restart-devam]')) return { code: 'restart-rehydrate', known: true, leaderId };
  if (lane === 'paused' || lane === 'limit-resume') return { code: 'limit-resume', known: true, leaderId };
  return { code: 'unknown', known: false, leaderId };
}

/**
 * Kuyruk kaydının KİMLİĞİ — renderer'ın `queueKeyOf`u ile BİREBİR aynı dize olmak
 * ZORUNDA (iptal/öne alma o anahtarla eşleşir). `queuedAt` kimliğin PARÇASI DEĞİLDİR:
 * aynı iş iki kez kuyruklanmasın diye idempotent karşılaştırma yapılır, damga onu bozardı.
 * (Diskteki kayıt `{...sanitizeQueueInput(input), queuedAt}` sırasıyla yazılır; spread
 * anahtar sırasını korur, `delete` yeniden sıralamaz → dize birebir tutar.)
 */
function identityKey(entry) {
  const clone = { ...obj(entry) };
  delete clone.queuedAt;
  return JSON.stringify(clone);
}

/** Kuyruktaki işin HEDEF ajanları (hazır-bölünmüş plan varsa alt-görevlerden). */
function targetAgents(entry) {
  const e = obj(entry);
  const subs = arr(e.subtasks)
    .map((s) => str(obj(s).workerAgentId))
    .filter(Boolean);
  if (subs.length) return [...new Set(subs)];
  return [...new Set(arr(e.workers).map((w) => str(obj(w).agentId)).filter(Boolean))];
}

/** Pane kaç ms'dir tek bayt üretmedi? Damga yoksa null = "bilinmiyor" (uyarı ÜRETMEZ). */
function idleForMs(pane, now) {
  const last = num(obj(pane).lastDataAt);
  if (!last) return null;
  return Math.max(0, now - last);
}

/** `delegation-queue.json` → bekleyen satırlar (busy-guard kuyruğu). */
function queuedRows(queueState, now) {
  return arr(obj(queueState).queued).map((q, i) => ({
    id: `queued:${i}`,
    delegationId: null,
    subtaskId: null,
    kind: 'waiting',
    lane: 'queued',
    position: i + 1,
    actionKey: identityKey(q),
    title: str(obj(q).objective),
    taskCode: taskCodeOf(obj(q).objective, ...arr(obj(q).subtasks).map((s) => obj(s).title)),
    agents: targetAgents(q),
    agentId: targetAgents(q)[0] ?? null,
    leaderId: str(obj(q).leaderId),
    department: str(obj(q).department),
    origin: originOf(q, 'queued'),
    arrivedAt: num(obj(q).queuedAt),
    startsAt: null,
    // Başlangıç anı TAHMİN EDİLEMEZ: uçuştaki iş bitince başlar. Uydurma saat yazmak
    // yerine panel "önündeki iş bitince" der — ve tıkanma uyarısı bunun NEDENİNİ verir.
    startsAtKind: 'after-inflight',
    status: 'waiting-busy',
    paneId: null,
    blockedBy: [],
    settledAt: null,
    reason: null,
  }));
}

/** `delegation-queue.json` → limitte duraklamış (devam saati BELLİ) satırlar. */
function pausedRows(queueState) {
  return arr(obj(queueState).paused).map((p) => ({
    id: `paused:${str(obj(p).key) || str(obj(p).subtaskId) || 'x'}`,
    delegationId: null,
    subtaskId: null,
    kind: 'waiting',
    lane: 'paused',
    position: null,
    actionKey: null,
    title: str(obj(p).title) || str(obj(p).objective),
    taskCode: taskCodeOf(obj(p).title, obj(p).objective),
    agents: [str(obj(p).agentId)].filter(Boolean),
    agentId: str(obj(p).agentId),
    leaderId: str(obj(p).leaderId),
    department: str(obj(p).department),
    origin: originOf(p, 'paused'),
    arrivedAt: num(obj(p).pausedAt),
    startsAt: num(obj(p).resumeAt),
    startsAtKind: num(obj(p).resumeAt) ? 'reset' : 'unknown',
    status: 'waiting-limit',
    paneId: null,
    blockedBy: [],
    settledAt: null,
    reason: null,
  }));
}

/**
 * `resume-queue.json` → limit-devam satırları + TOPLU BOŞALMA planı (SUP-UI-01 §4).
 *
 * Saatler resumeScheduler'ın kendi kuralıyla hesaplanır: `resetAt + 90sn tampon`,
 * ve aynı ana düşen kayıtlar 15sn ARALIKLA yayılır (daemon'ın `rescheduleAll`
 * stagger'ı ile aynı sabit). Panel böylece "hepsi aynı anda patlayacak" korkusunun
 * yerine gerçek başlangıç saatlerini gösterir.
 */
function resumeRows(resumeQueue, now) {
  const active = arr(obj(resumeQueue).entries).filter((e) => {
    const s = obj(e).status;
    return s === 'scheduled' || s === 'resuming' || s === 'verifying';
  });
  const withBase = active.map((e) => ({ e, base: now + firstDelayMs(e, now, RESET_BUFFER_MS) }));
  withBase.sort((a, b) => a.base - b.base);
  let prevPlanned = 0;
  return withBase.map(({ e, base }) => {
    const planned = prevPlanned ? Math.max(base, prevPlanned + STAGGER_MS) : base;
    prevPlanned = planned;
    const entry = obj(e);
    return {
      id: `resume:${str(entry.id) || str(entry.agentId) || 'x'}`,
      delegationId: null,
      subtaskId: null,
      kind: 'waiting',
      lane: 'limit-resume',
      position: null,
      actionKey: null,
      title: null,
      taskCode: str(entry.taskId),
      agents: [str(entry.agentId)].filter(Boolean),
      agentId: str(entry.agentId),
      leaderId: null,
      department: null,
      origin: originOf(entry, 'limit-resume'),
      arrivedAt: num(entry.detectedAt),
      startsAt: planned,
      // `reset` = limitin bittiği saat okunabildi · `estimate` = okunamadı, daemon
      // kör denemeye geçti (RES-08 `resetSource` alanının panele düşen hâli).
      startsAtKind: num(entry.resetAt) ? 'reset' : 'estimate',
      status: obj(e).status === 'scheduled' ? 'waiting-limit' : 'resuming',
      paneId: str(entry.paneRef),
      blockedBy: [],
      settledAt: null,
      reason: null,
      attempts: Number.isInteger(entry.attempts) ? entry.attempts : 0,
    };
  });
}

/** `delegation-supervisor.json` → uçuştaki (status=null) ve biten kayıtlar. */
function supervisorRows(supervisor, doneLimit, outcomeLedger = null) {
  const records = Object.values(obj(obj(supervisor).records)).filter((r) => r && typeof r === 'object');
  const inflight = [];
  const done = [];
  for (const rec of records) {
    const outcomeEntry =
      outcomeLedger && typeof outcomeLedger.getEntry === 'function'
        ? outcomeLedger.getEntry(rec.delegationId, rec.subtaskId)
        : null;

    const row = {
      id: `sup:${str(rec.key) || `${rec.delegationId}:${rec.subtaskId}`}`,
      // DELEG-COMMS-01 — UÇUŞTAKİ İŞİ DURDURMANIN ANAHTARI. Satır kimliği (`sup:…`)
      // panelin kendi anahtarıdır; motorun iptal yüzeyi (`cancelDelegationById`)
      // DELEGASYON id'si ister. Bu alan olmadan panel uçuştaki işi durduramaz —
      // ölçüldü: masaüstünde uçuştaki 3 işin 3'ü de iptal edilemiyordu.
      delegationId: str(rec.delegationId),
      subtaskId: str(rec.subtaskId),
      kind: rec.status ? 'done' : 'inflight',
      lane: rec.status ? 'settled' : 'inflight',
      position: null,
      actionKey: null,
      title: str(rec.title),
      // Görev kodu ÖNCE başlıktan türetilir: defterdeki `taskCode` renderer'ın eski
      // dar kalıbıyla yazılır ve "SUP-UI-01"i "UI-01" diye kırpar (panelde yanlış kod
      // = yanlış iş sanılır). Başlıktan okunamıyorsa defterdekine düşülür.
      taskCode: taskCodeOf(rec.title, rec.evidencePath) || str(rec.taskCode),
      agents: [str(rec.agentId)].filter(Boolean),
      agentId: str(rec.agentId),
      leaderId: str(rec.leaderId),
      department: str(rec.department),
      origin: originOf(rec, rec.status ? 'settled' : 'inflight'),
      arrivedAt: num(rec.dispatchedAt),
      startsAt: num(rec.dispatchedAt),
      startsAtKind: 'started',
      status: rec.status ? String(rec.status) : 'inflight',
      paneId: str(rec.paneId),
      blockedBy: [],
      settledAt: num(rec.settledAt),
      reason: str(rec.reason),
      // Faz 1: Maliyet, tur, tekrar ve sonuç göstergeleri (kod döner, metin değil)
      costUsd: num(rec.costUsd) ?? (outcomeEntry ? num(outcomeEntry.costUsd) : null),
      turns: Number.isInteger(rec.turns)
        ? rec.turns
        : (outcomeEntry && Number.isInteger(outcomeEntry.turns) ? outcomeEntry.turns : (rec.status ? 1 : null)),
      retries: Number.isInteger(rec.retries)
        ? rec.retries
        : (outcomeEntry && Number.isInteger(outcomeEntry.retries) ? outcomeEntry.retries : 0),
      outcome:
        str(rec.outcome) ||
        (outcomeEntry ? str(outcomeEntry.outcome) : (rec.status ? (rec.status === 'done' ? 'passed' : 'failed') : null)),
      goal: rec.goalState ? {
        defined: true,
        round: rec.goalState.rounds ? rec.goalState.rounds.length : 0,
        maxRounds: (rec.goal && Number(rec.goal.maxRounds)) || 5,
        status: str(rec.goalState.status) || 'initial',
        code: str(rec.goalState.code) || 'goal.initial',
        summary: str(rec.goalState.summary) || null,
      } : null,
    };
    (rec.status ? done : inflight).push(row);
  }
  inflight.sort((a, b) => (a.arrivedAt || 0) - (b.arrivedAt || 0));
  done.sort((a, b) => (b.settledAt || 0) - (a.settledAt || 0));
  return { inflight, done: done.slice(0, doneLimit) };
}

/**
 * TIKANMA SONDASI (SUP-UI-01 §3 — vaka (b)'nin kalıcı çözümü).
 *
 * Kuyruktaki iş X ajanını bekliyor; X'in uçuştaki kaydının pane'i BOŞTA (idleMs
 * boyunca tek bayt yok) ya da HİÇ YOK. İki hâlde de kuyruk kendiliğinden asla
 * ilerlemez — çünkü ilerlemenin tek tetiği pane çıkışıdır. Uyarı bu çakışmayı
 * görünür kılar ve panele TEK TIKLIK eylemi taşır.
 *
 * Yanlış-pozitif kapısı: `lastDataAt` damgası yoksa (pane hiç çıktı üretmemiş /
 * defterde damga yok) uyarı ÜRETİLMEZ — "bilinmiyor" bir suçlama değildir.
 */
function blockageWarnings(waiting, inflight, panes, now, idleMs) {
  const paneById = new Map(arr(panes).map((p) => [str(obj(p).paneId), obj(p)]));
  const inflightByAgent = new Map();
  for (const row of inflight) {
    if (row.agentId && !inflightByAgent.has(row.agentId)) inflightByAgent.set(row.agentId, row);
  }
  /** @type {Map<string, any>} */
  const warnings = new Map();
  for (const row of waiting) {
    if (row.lane !== 'queued') continue; // limit kuyruğu pane'e değil SAATE bağlıdır
    for (const agentId of row.agents) {
      const holder = inflightByAgent.get(agentId);
      if (!holder) continue;
      if (!row.blockedBy.includes(agentId)) row.blockedBy.push(agentId);
      const pane = holder.paneId ? paneById.get(holder.paneId) : null;
      const idleFor = pane ? idleForMs(pane, now) : null;
      let code = null;
      if (holder.paneId && !pane) code = 'blocked-missing-pane';
      else if (pane && idleFor !== null && idleFor >= idleMs) code = 'blocked-idle-pane';
      if (!code) continue;
      const key = `${code}:${holder.paneId || agentId}`;
      const prev = warnings.get(key);
      if (prev) {
        if (!prev.waitingRowIds.includes(row.id)) prev.waitingRowIds.push(row.id);
        continue;
      }
      warnings.set(key, {
        code,
        paneId: holder.paneId,
        agentId,
        // Eylem: `close-pane` → pane'i kapat + meşguliyet defterini hizala + kuyruğu sür.
        action: code === 'blocked-idle-pane' ? 'close-pane' : 'reconcile',
        idleForMs: idleFor,
        holderRowId: holder.id,
        holderTaskCode: holder.taskCode,
        waitingRowIds: [row.id],
        waitingTaskCode: row.taskCode,
      });
    }
  }
  return [...warnings.values()];
}

/**
 * ÜÇ DEFTER + CANLI PANE LİSTESİ → TEK TABLO.
 *
 * @param {object} input
 * @param {object} [input.supervisor]   delegation-supervisor.json içeriği
 * @param {object} [input.queueState]   delegation-queue.json içeriği ({queued,paused})
 * @param {object} [input.resumeQueue]  resume-queue.json içeriği ({entries})
 * @param {Array}  [input.panes]        canlı pane'ler ({paneId, agentId, lastDataAt, …})
 * @param {number} input.now            çağıranın saati (modül `Date.now` ÇAĞIRMAZ)
 * @param {number} [input.idleMs]       "pane boşta" eşiği
 * @param {number} [input.doneLimit]    gösterilecek biten iş sayısı
 */
function buildQueueBoard(input) {
  const i = obj(input);
  const now = num(i.now) ?? 0;
  const idleMs = num(i.idleMs) ?? DEFAULT_IDLE_MS;
  const doneLimit = num(i.doneLimit) ?? DEFAULT_DONE_LIMIT;

  const waiting = [...queuedRows(i.queueState, now), ...pausedRows(i.queueState), ...resumeRows(i.resumeQueue, now)];
  const { inflight, done } = supervisorRows(i.supervisor, doneLimit, i.outcomeLedger || null);
  const warnings = blockageWarnings(waiting, inflight, i.panes, now, idleMs);

  return {
    generatedAt: now,
    idleMs,
    staggerMs: STAGGER_MS,
    waiting,
    inflight,
    done,
    warnings,
    counts: {
      waiting: waiting.length,
      inflight: inflight.length,
      done: done.length,
      warnings: warnings.length,
      unknownOrigin: [...waiting, ...inflight].filter((r) => !r.origin.known).length,
    },
  };
}

module.exports = {
  DEFAULT_IDLE_MS,
  DEFAULT_DONE_LIMIT,
  ORIGIN_CODES,
  WARNING_CODES,
  taskCodeOf,
  normalizeOrigin,
  originOf,
  identityKey,
  targetAgents,
  idleForMs,
  queuedRows,
  pausedRows,
  resumeRows,
  supervisorRows,
  blockageWarnings,
  buildQueueBoard,
};
