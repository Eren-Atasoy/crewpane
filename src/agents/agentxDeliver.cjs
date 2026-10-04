// AXP-03 — AGENT X'TEN AJANA PROMPT TESLİMİ + MAKBUZ (ana süreç).
// Tasarım: docs/design/AXP-01-DESIGN.md §4 (hedef çözümü, teslim doğrulaması, makbuz).
//
// ─────────────────────────────────────────────────────────────────────────────
// NEDEN VAR — BUGÜNKÜ KIRIK DİKİŞ
// ─────────────────────────────────────────────────────────────────────────────
// Agent X'in "Parker'a söyle …" yolu renderer'da `sendCommandToAgent`e iniyor ve
// orada biten şey "gönderim DENENDİ"dir; "alındı" hiç ölçülmüyor (AGENTX-APP-01 §2.4).
// Makbuzun %70'i dev'de ZATEN var: `deliverPrompt` (metin bir kez + Enter tekrarı +
// composer ölçümü, ENT-F1) ve `delegationSupervisor.deliveryVerdict` (transcript
// birincil, pane tamponu ikincil ve yalnız pozitif). Bu dosya o ikisini YENİDEN
// YAZMAZ; Agent X yolunu onlara DİKER ve üstüne makbuzu koyar.
//
// SÖZLEŞME (AXP-01-DESIGN §4.2–4.3)
//   • Makbuz `düştü` YALNIZ `deliverPrompt` hükmü `submitted` iken. `pending`/`unknown`
//     → `doğrulanamadı` (ışık yanmaz). "Yazıldı" ≠ "teslim edildi".
//   • Metin EN FAZLA BİR KEZ yazılır; kuyruk yeniden denemesi ekranda asılı metin
//     görürse yalnız Enter'dır ([[ref_delivery_write_once_enter_free]]).
//   • Taze pane kapısı: tek bayt basmamış / composer'ı ölçülebilir BOŞ olmayan pane'e
//     YAZILMAZ ([[fresh-pane-write-before-first-byte]]). Hazır olmazsa KUYRUK.
//   • Hedef yok ya da meşgul → dürüst cümle + KUYRUK (Eren kararı, 18.09).
//   • Menüde/okunamaz pane → yazılmaz; `doğrulanamadı: terminal menüde`.
//   • Yetki kapısı (AX-06 = `teamScope.authorize`in Agent X ucu) TESLİMDEN ÖNCE.
//   • Makbuz main'de üretilir, `emit` ile yayınlanır (renderer `agentx:receipt`);
//     bir makbuz bir kez ışık yakar (digest eşleşmesi AXP-04'ün işi).
//   • Kalıcılık YOK: oturum içi "Son işlemler" defteri (paneId'ler yeniden üretilir).
//
// TÜM IO ENJEKTE (fs/electron/pty require'ı yok) → `node --test electron/agentxDeliver.test.cjs`.

'use strict';

const crypto = require('node:crypto');
const { composerScan, composerDiag } = require('./leaderComposer.cjs');
const { pendingTextOnScreen } = require('./deliverPrompt.cjs');
const { deliveryVerdict } = require('./delegationSupervisor.cjs');
const { resolveTarget, PANE_STATE } = require('./agentxTarget.cjs');

/** Makbuz durumları — AXP-04 ışığı `LANDED` dışında hiçbir durumda yanmaz. */
const RECEIPT_STATE = Object.freeze({
  SENDING: 'gönderiliyor',
  LANDED: 'düştü',
  QUEUED: 'kuyrukta',
  UNVERIFIED: 'doğrulanamadı',
  CANCELLED: 'iptal',
});

/** Ekranda kullanıcıya SADE dille söylenecek nedenler (anahtar; metin i18n'de). */
const REASON = Object.freeze({
  NO_PANE: 'no-pane',
  BUSY: 'busy',
  NOT_READY: 'not-ready',
  MENU: 'menu',
  PENDING_TEXT: 'pending-text',
  NO_RESPONSE: 'no-response',
  WRITE_FAILED: 'write-failed',
  TRANSCRIPT_MISSING: 'transcript-missing',
  PANE_GONE: 'pane-gone',
  USER_CANCEL: 'user-cancel',
});

/**
 * AXP-14 — uçuş-öncesi yoklama hâlleri (`probe`). Işık YALNIZ `IDLE` hedefe uçar; gerisi
 * "uçmadan teslim dene" (kuyruk + dürüst makbuz). `PANE_STATE`in üstüne menü/asılı-metin/
 * pane-yok ayrımı gelir — makbuz nedeniyle aynı aile (`REASON.MENU`, `PENDING_TEXT`, `NO_PANE`).
 */
const PROBE_STATE = Object.freeze({
  IDLE: 'idle',
  BUSY: 'busy',
  MENU: 'menu',
  FRESH: 'fresh',
  TEXT: 'text',
  NONE: 'none',
});

const DEFAULTS = Object.freeze({
  freshCapMs: 9_000, // taze pane'in composer'ı ölçülebilir BOŞ olana kadar bekleme tavanı
  freshPollMs: 300,
  verifyMs: 14_000, // transcript hükmü için bütçe (ADP-561: 9 sn boot bütçesini aşmalı)
  verifyPollMs: 1_500,
  queueTickMs: 3_000,
  ledgerMax: 50,
});

/** sha256(gövde) — ışık/halka makbuzu ancak bu özetle kabul eder (AX-24 receiptOK kalıbı). */
function digestOf(text) {
  return crypto.createHash('sha256').update(String(text == null ? '' : text), 'utf8').digest('hex');
}

/** Kısa, okunur iş no ("7K2Q"): karışan harfler (0/O, 1/I) yok. */
function shortJobId(rand = crypto.randomBytes) {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = rand(4);
  let out = '';
  for (let i = 0; i < 4; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/**
 * Teslim iğnesi — `src/app/lib/paneReadiness.ts::deliveryNeedle`in main ikizi
 * (pastePayload.cjs/.ts çifti gibi). Tek satır, `"`/`\` içermez → transcript ve
 * rollout defterlerinde JSON kaçışına takılmadan aranır.
 */
function deliveryNeedle(prompt) {
  const parts = String(prompt == null ? '' : prompt)
    .split(/[\r\n"\\]+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 12);
  if (!parts.length) return null;
  const longest = parts.reduce((a, b) => (b.length > a.length ? b : a));
  return longest.slice(0, 60);
}

/**
 * Pane hâli — ham pty kaydından (bytes + tampon) tek ölçüm. `composerScan` main'in
 * TEK composer okuyucusudur (üçüncü kopya yok).
 * @param {{bytes?:number, buffer?:string}} entry
 */
function paneStateOf(entry) {
  if (!entry) return PANE_STATE.UNKNOWN;
  if (!entry.bytes) return PANE_STATE.FRESH;
  const scan = composerScan(entry.buffer || '');
  if (scan === 'running') return PANE_STATE.BUSY;
  if (scan === 'empty') return PANE_STATE.IDLE;
  return PANE_STATE.UNKNOWN;
}

/** `deliverPrompt` neden alanını kullanıcıya söylenecek anahtara çevir. */
function reasonFromDeliver(res) {
  const r = String((res && res.reason) || '');
  if (r.startsWith('guard:menu') || r.startsWith('guard:rewrite-menu')) return REASON.MENU;
  if (r === 'write-failed' || r === 'enter-failed') return REASON.WRITE_FAILED;
  return REASON.NO_RESPONSE;
}

/**
 * AXP-12 — TEŞHİS İZİ SIR MASKESİ. Makbuz `verdictTrail`i renderer'a IPC ile gider
 * (ekrana çıkmaz ama defter/log'a düşebilir): uzun jeton, `key=…`, Bearer, e-posta
 * maskelenir. Pane tamponu main'de zaten `secretRedactor`dan geçmiştir; bu ikinci
 * kemerdir ve KISA tutulur (satır ≤ `SCREEN_LINE_MAX`).
 */
const SCREEN_TAIL_MAX = 16;
const SCREEN_LINE_MAX = 80;
const CULPRIT_MAX = 40;
function maskLine(line) {
  return String(line == null ? '' : line)
    // ekran metninde kalan kaçış dizileri / kontrol baytları (ör. `CSI ? u` kitty sorgusu) iz'e girmez
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/([\w-]*(?:api[_-]?key|key|secret|token|passw(?:or)?d|bearer|authorization|cookie)[\w-]*\s*[=:]\s*)\S+/gi, '$1«…»')
    .replace(/\bBearer\s+\S+/gi, 'Bearer «…»')
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '«e-posta»')
    .replace(/[A-Za-z0-9_\-.]{24,}/g, '«…»');
}

/**
 * AXP-12 — "menü/okunamadı" hükmünün KANITI: hangi satır, hangi dal, ekran kuyruğu.
 * #YHL8/#6QG5'te ham satır saklanmadığı için hüküm çelişkiyle çürütülmek zorunda kaldı;
 * artık makbuz ve log ham satırı (maskeli, ≤40 kr) + ekranın son ≤16 satırını taşır.
 * @returns {string[]} verdictTrail satırları
 */
function screenTrail(phase, buffer, opts) {
  const d = composerDiag(buffer, opts);
  const culprit = maskLine(d.row).slice(0, CULPRIT_MAX);
  const lines = [`scan:${phase}=${d.verdict} dal=${d.branch} len=${d.row.length} satır="${culprit}"`];
  const rows = d.rows.slice(-SCREEN_TAIL_MAX);
  rows.forEach((r, i) => lines.push(`screen[${i}]:${maskLine(r).slice(0, SCREEN_LINE_MAX)}`));
  return lines;
}

/**
 * @typedef {Object} DeliverIO
 * @property {()=>Array<{paneId:string, agentId?:string|null, department?:string|null, bytes?:number, buffer?:string, exited?:boolean}>} listPanes
 * @property {(paneId:string)=>string} readPaneBuffer
 * @property {(paneId:string, text:string, opts?:object)=>Promise<object>} deliver  ENT-F1 primitifi (`createDeliverPrompt` çıktısı)
 * @property {(paneId:string, needle:string)=>boolean|null} transcriptHas  true/false/null (bakılamadı)
 * @property {(receipt:object)=>void} emit  `agentx:receipt` yayını
 * @property {(input:{actor:object, target:object})=>{ok:boolean, reason?:string, via?:string}} [authorize]  AX-06 ucu
 * @property {(ms:number)=>Promise<void>} sleep
 * @property {()=>number} [now]
 * @property {(line:string)=>void} [log]
 */

/**
 * @param {DeliverIO} io
 * @param {Partial<typeof DEFAULTS>} [opts]
 */
function createAgentxDeliver(io, opts = {}) {
  const cfg = { ...DEFAULTS, ...(opts || {}) };
  const now = io.now || (() => Date.now());
  const log = io.log || (() => {});
  const sleep = (ms) => (io.sleep ? io.sleep(ms) : new Promise((r) => setTimeout(r, ms)));
  const idGen = opts.idGen || shortJobId;

  /** Oturum içi "Son işlemler" (en yeni önde). */
  const ledger = [];
  /** Kuyruk: makbuz id → { text, agentId, textWrittenAt } */
  const queue = new Map();
  let queueTimer = null;

  const snapshotPanes = () => {
    let list = [];
    try { list = io.listPanes() || []; } catch { list = []; }
    return list
      .filter((p) => p && p.paneId && !p.exited)
      .map((p) => ({ paneId: p.paneId, agentId: p.agentId || null, department: p.department || null, state: paneStateOf(p) }));
  };

  const publish = (rec) => {
    rec.updatedAt = new Date(now()).toISOString();
    const copy = JSON.parse(JSON.stringify(rec));
    try { io.emit(copy); } catch { /* yayın best-effort */ }
    return copy;
  };

  const find = (id) => ledger.find((r) => r.id === id) || null;

  const setState = (rec, state, reason) => {
    rec.state = state;
    if (reason) rec.reason = reason; else delete rec.reason;
    rec.verdictTrail.push(state);
    log(`agentx teslim iş#${rec.id} → ${state}${reason ? ` (${reason})` : ''} hedef=${rec.to.agentId} pane=${rec.to.paneKey || '-'}`);
    return publish(rec);
  };

  /**
   * Taze/okunamayan pane'in composer'ı ölçülebilir BOŞ olana kadar bekle.
   * AXP-12: `rec` yalnız teşhis izi için (menü hükmünün ham satırı makbuza).
   * @returns {Promise<'idle'|'busy'|'menu'|'text'|'gone'|'timeout'>}
   */
  async function waitReady(rec, paneId) {
    const deadline = now() + cfg.freshCapMs;
    let menuSeen = false;
    for (;;) {
      const p = (snapshotPanes().find((x) => x.paneId === paneId)) || null;
      if (!p) return 'gone';
      if (p.state === PANE_STATE.IDLE) return 'idle';
      if (p.state === PANE_STATE.BUSY) return 'busy';
      let buf = '';
      try { buf = io.readPaneBuffer(paneId) || ''; } catch { buf = ''; }
      const scan = composerScan(buf, { ignoreRunning: true });
      // AXP-12 — 'menu' TEK KAREDE hüküm değildir: TUI yeniden çizerken ara kare menü gibi
      // okunabilir. İki ARDIŞIK okuma (aralarında gerçek gecikme) menü derse menüdür; o an
      // hükmü veren satır + ekran kuyruğu makbuza yazılır (gerçek izin menüsü kanıtlı kalır).
      if (scan === 'menu') {
        if (menuSeen) { rec.verdictTrail.push(...screenTrail('waitReady', buf, { ignoreRunning: true })); return 'menu'; }
        menuSeen = true;
      } else {
        menuSeen = false;
      }
      if (scan === 'text') return 'text';
      if (scan === 'empty') return 'idle'; // composer ölçülebilir BOŞ (koşu kısa-devresi yukarıda BUSY'yi zaten yakaladı)
      if (now() >= deadline) return 'timeout';
      await sleep(cfg.freshPollMs);
    }
  }

  /** Kuyruğa koy (dürüst neden + tick'i kur). */
  function enqueue(rec, reason) {
    queue.set(rec.id, { agentId: rec.to.agentId, text: rec._text, textWrittenAt: rec._textWrittenAt || null });
    armQueue();
    return setState(rec, RECEIPT_STATE.QUEUED, reason);
  }

  /**
   * Gerçek teslim: ENT-F1 primitifi + hüküm. `düştü` YALNIZ `submitted`.
   * Ardından transcript doğrulaması (supervisor merdiveni) makbuza `verified` yazar.
   */
  async function attempt(rec, paneId) {
    rec.to.paneKey = paneId;
    setState(rec, RECEIPT_STATE.SENDING, null);
    const pendingNow = (() => { try { return pendingTextOnScreen(io.readPaneBuffer(paneId) || ''); } catch { return false; } })();
    const enterOnly = !!rec._textWrittenAt && pendingNow;
    const res = await io.deliver(paneId, rec._text, {
      mode: enterOnly ? 'enter-only' : 'auto',
      textWrittenAt: rec._textWrittenAt || null,
      label: `agentx iş#${rec.id}`,
    });
    if (res && res.wroteText && res.textWrittenAt) rec._textWrittenAt = res.textWrittenAt;
    if (Array.isArray(res && res.observations)) rec.verdictTrail.push(...res.observations.map((o) => `enter:${o}`));
    if (!(res && res.outcome === 'submitted' && res.delivered === true)) {
      // "yazıldı" ≠ "teslim edildi": pending/unknown → doğrulanamadı, ışık YANMAZ.
      //
      // AXP-12 — 'unknown' "gönderilmedi" DEĞİL "ekranı okuyamadım"dır (#DV48: prompt
      // Kamil Amca'nın oturumuna düşmüştü, ekran 4 kez unknown okundu, makbuz "iletemedim"
      // dedi). Ekran okunamadıysa ve gerçekten bir şey GÖNDERİLDİYSE (metin yazıldı ya da
      // Enter basıldı) hükmü TRANSKRİPT verir — süpervizörün merdiveni (`deliveryVerdict`)
      // yeniden yazılmaz, buraya dikilir. 'pending' (metin ekranda ASILI) transkriptte
      // olamaz → sorulmaz; hiçbir şey yazılmadıysa (guard) aranacak bir şey yoktur.
      let reason = reasonFromDeliver(res);
      let screenBuf = '';
      try { screenBuf = io.readPaneBuffer(paneId) || ''; } catch { screenBuf = ''; }
      rec.verdictTrail.push(...screenTrail('attempt', screenBuf, { ignoreRunning: true }));
      const sentSomething = !!(res && (res.wroteText || (res.enters | 0) > 0));
      if (res && res.outcome === 'unknown' && sentSomething) {
        const ladder = await transcriptLadder(rec, paneId);
        rec.verdictTrail.push(`transcript:${ladder === null ? 'bakılamadı' : ladder ? 'VAR' : 'YOK'}`);
        if (ladder === true) {
          rec.deliveredAt = new Date(now()).toISOString();
          rec.verified = 'transcript';
          log(`agentx teslim iş#${rec.id} ekran okunamadı (unknown) ama transkriptte iğne VAR → düştü (verified:transcript)`);
          return setState(rec, RECEIPT_STATE.LANDED, null);
        }
        if (ladder === false) reason = REASON.TRANSCRIPT_MISSING;
      }
      log(`agentx teslim iş#${rec.id} ${rec.verdictTrail.find((l) => l.startsWith('scan:attempt')) || ''}`);
      return setState(rec, RECEIPT_STATE.UNVERIFIED, reason);
    }
    rec.deliveredAt = new Date(now()).toISOString();
    const out = setState(rec, RECEIPT_STATE.LANDED, null);
    // Transcript doğrulaması ARKADA koşar: makbuz zaten düştü (ışık t0), hüküm gelince
    // `verified` güncellenir; defter "bakti, YOK" derse dürüstçe doğrulanamadı'ya döner.
    verifyLater(rec, paneId).catch(() => {});
    return out;
  }

  /**
   * AXP-12 — TRANSKRİPT MERDİVENİ (yalnız defter, ekran YOK). `verifyLater`in aksine
   * ekran-pozitif kabul edilmez: ekran zaten okunamamıştır ve iğne composer'da ASILI
   * metnin kendisi olabilir — "ekranda gördüm" burada yanlış "düştü" üretirdi. Bu yüzden
   * `deliveryVerdict` boş tamponla çağrılır (= transcript hükmü; ikinci kopya yok).
   * @returns {Promise<boolean|null>} true=defterde var · false=baktı yok · null=bakılamadı
   */
  async function transcriptLadder(rec, paneId) {
    const needle = deliveryNeedle(rec._text);
    if (!needle) return null;
    const deadline = now() + cfg.verifyMs;
    let verdict = null;
    for (;;) {
      let transcript = null;
      try { transcript = io.transcriptHas(paneId, needle); } catch { transcript = null; }
      verdict = deliveryVerdict({ transcript, buffer: '', signature: needle });
      if (verdict === true) return true;
      if (now() >= deadline) return verdict;
      await sleep(cfg.verifyPollMs);
    }
  }

  async function verifyLater(rec, paneId) {
    const needle = deliveryNeedle(rec._text);
    if (!needle) { rec.verified = 'unchecked'; publish(rec); return; }
    const deadline = now() + cfg.verifyMs;
    let verdict = null;
    let via = null;
    for (;;) {
      let transcript = null;
      try { transcript = io.transcriptHas(paneId, needle); } catch { transcript = null; }
      let buffer = '';
      try { buffer = io.readPaneBuffer(paneId) || ''; } catch { buffer = ''; }
      verdict = deliveryVerdict({ transcript, buffer, signature: needle });
      if (verdict === true) { via = transcript === true ? 'transcript' : 'screen'; break; }
      if (now() >= deadline) break;
      await sleep(cfg.verifyPollMs);
    }
    if (verdict === true) { rec.verified = via; publish(rec); return; }
    if (verdict === false) { setState(rec, RECEIPT_STATE.UNVERIFIED, REASON.TRANSCRIPT_MISSING); return; }
    rec.verified = 'unchecked';
    publish(rec);
  }

  /** Pane hâline göre: teslim et / kuyruğa yaz / dürüstçe doğrulanamadı. */
  async function route(rec, pane) {
    if (!pane) return enqueue(rec, REASON.NO_PANE);
    if (pane.state === PANE_STATE.BUSY) return enqueue(rec, REASON.BUSY);
    // Ekrandaki asılı metin BİZİM daha önce yazdığımız metinse (yeniden deneme):
    // hazırlık kapısı aranmaz, `attempt` yalnız Enter basar (metin ikinci kez YAZILMAZ).
    const ours = !!rec._textWrittenAt && (() => { try { return pendingTextOnScreen(io.readPaneBuffer(pane.paneId) || ''); } catch { return false; } })();
    if (pane.state !== PANE_STATE.IDLE && !ours) {
      const ready = await waitReady(rec, pane.paneId);
      // AXP-14 (AXP-09 §6 b) — gerçek menü de KUYRUĞA girer: menü kapanınca composer boş
      // okunur → `drainQueue` aynı kuyruktan teslim eder (makbuz `düştü`, ışık o an yanar).
      // Kullanıcı bekletildiğini bilir: makbuz `kuyrukta (menu)` + "Terminale git".
      if (ready === 'menu') return enqueue(rec, REASON.MENU);
      if (ready === 'gone') return enqueue(rec, REASON.NO_PANE);
      if (ready === 'busy') return enqueue(rec, REASON.BUSY);
      if (ready === 'text') return enqueue(rec, REASON.PENDING_TEXT);
      if (ready === 'timeout') return enqueue(rec, REASON.NOT_READY);
    }
    return attempt(rec, pane.paneId);
  }

  /**
   * AXP-02 `draft:confirmed` tüketicisi.
   * @param {{
   *   from:{userId?:string, surface?:'widget'|'popout', kind?:'user'|'agent', agentId?:string, teamId?:string},
   *   target:{agentId?:string, role?:string, teamId?:string, text?:string},
   *   text:string, digest?:string, revision?:number,
   *   ctx:{aliases?:Array, departments?:Array, activeDepartment?:string|null},
   * }} req
   * @returns {Promise<{ok:true, receipt:object} | {ok:false, kind:'no-text'|'digest-mismatch'|'ambiguous'|'unknown'|'denied', [k:string]:any}>}
   */
  async function deliverConfirmed(req) {
    const r = req && typeof req === 'object' ? req : {};
    const text = typeof r.text === 'string' ? r.text : '';
    if (!text.trim()) return { ok: false, kind: 'no-text' };
    const digest = digestOf(text);
    if (r.digest && r.digest !== digest) return { ok: false, kind: 'digest-mismatch' };

    const ctx = r.ctx && typeof r.ctx === 'object' ? r.ctx : {};
    const resolved = resolveTarget(r.target || {}, { ...ctx, panes: snapshotPanes() });
    if (resolved.kind === 'ambiguous') return { ok: false, kind: 'ambiguous', options: resolved.options };
    if (resolved.kind === 'unknown') return { ok: false, kind: 'unknown', reason: resolved.reason, said: resolved.said, suggestions: resolved.suggestions };

    // AX-06 — yetki kapısı EYLEM SINIRINDA, teslimden önce. Karar deterministik kodda.
    const actor = r.from && typeof r.from === 'object' ? r.from : {};
    let auth = { ok: true, via: 'default' };
    if (typeof io.authorize === 'function') {
      try { auth = io.authorize({ actor, target: resolved }) || { ok: false, reason: 'authorize-null' }; } catch (e) { auth = { ok: false, reason: `authorize-threw:${e && e.message}` }; }
    }
    if (!auth.ok) {
      log(`agentx teslim RED (yetki): hedef=${resolved.agentId} neden=${auth.reason || auth.code || '-'}`);
      return { ok: false, kind: 'denied', reason: auth.reason || auth.code || 'denied', target: { agentId: resolved.agentId, agentLabel: resolved.agentLabel, teamId: resolved.teamId, teamLabel: resolved.teamLabel } };
    }

    const rec = {
      id: idGen(),
      from: { userId: actor.userId || null, surface: actor.surface === 'popout' ? 'popout' : 'widget' },
      to: { agentId: resolved.agentId, agentLabel: resolved.agentLabel, teamId: resolved.teamId, teamLabel: resolved.teamLabel, paneKey: resolved.pane ? resolved.pane.paneId : null },
      at: new Date(now()).toISOString(),
      textDigest: digest,
      revision: typeof r.revision === 'number' ? r.revision : null,
      state: RECEIPT_STATE.SENDING,
      verified: null,
      verdictTrail: [],
      resolvedVia: resolved.via,
    };
    // Gövde makbuzda TAŞINMAZ (renderer'a digest gider); yalnız kuyruk/yeniden deneme için
    // bellekte tutulur. Sayılamaz (non-enumerable) alan → JSON kopyalarına ve yayına girmez.
    Object.defineProperty(rec, '_text', { value: text, enumerable: false, writable: true });
    Object.defineProperty(rec, '_textWrittenAt', { value: null, enumerable: false, writable: true });
    ledger.unshift(rec);
    if (ledger.length > cfg.ledgerMax) ledger.length = cfg.ledgerMax;

    const receipt = await route(rec, resolved.pane);
    return { ok: true, receipt };
  }

  /** Kuyruk tick'i: hedefin pane'i boşa düştüyse dene. */
  async function drainQueue() {
    if (!queue.size) { disarmQueue(); return; }
    const panes = snapshotPanes();
    for (const [id, q] of [...queue.entries()]) {
      const rec = find(id);
      if (!rec || rec.state !== RECEIPT_STATE.QUEUED) { queue.delete(id); continue; }
      const live = panes.filter((p) => p.agentId === q.agentId);
      const idle = live.find((p) => p.state === PANE_STATE.IDLE);
      if (!idle) continue;
      queue.delete(id);
      await attempt(rec, idle.paneId);
    }
    if (!queue.size) disarmQueue();
  }
  function armQueue() {
    if (queueTimer || cfg.queueTickMs <= 0) return;
    queueTimer = setInterval(() => { drainQueue().catch(() => {}); }, cfg.queueTickMs);
    if (typeof queueTimer.unref === 'function') queueTimer.unref();
  }
  function disarmQueue() {
    if (queueTimer) { clearInterval(queueTimer); queueTimer = null; }
  }

  /** Kullanıcı vazgeçti (yalnız kuyruktaki ya da gönderilmekte olan iş). */
  function cancel(id) {
    const rec = find(id);
    if (!rec) return { ok: false, reason: 'not-found' };
    if (rec.state === RECEIPT_STATE.LANDED) return { ok: false, reason: 'already-landed' };
    queue.delete(id);
    return { ok: true, receipt: setState(rec, RECEIPT_STATE.CANCELLED, REASON.USER_CANCEL) };
  }

  /**
   * "Tekrar dene" (İLETİLEMEDİ kartı): aynı makbuz, güncel pane hâliyle yeniden yönlendirilir.
   * Metin daha önce yazıldıysa `_textWrittenAt` korunur → ekranda asılıysa yalnız Enter.
   */
  async function retry(id) {
    // AXP-15 — GÖRÜNÜR deneme. AXP-09 §5: aynı `menu` sonucu sessizce yeniden yayınlanıyordu
    // (piksel aynı, ses yok) ve kullanıcı düğmeyi bozuk sanıyordu. Şimdi her basış (1) sayaç +
    // damga, (2) `route()`tan ÖNCE `deneniyor` ara durumu (düğme kapanır, spinner döner),
    // (3) `retryFrom` = önceki sonuç → renderer "hâlâ: menü açık" satırını ve "Yine iletemedim"
    // cümlesini buradan türetir; karar yeniden türetilmez. `deneniyor` uçuştayken ikinci basış
    // `not-retryable` (çift tık sayaç artırmaz). Durum sabiti RECEIPT_STATE'e AXP-14 ile
    // çakışmamak için (dosyanın yalnız bu fonksiyonu bu kartın alanı) BURADA tanımlı; merge
    // sonrası RECEIPT_STATE.RETRYING'e taşınır (rapor §5).
    const RETRYING = 'deneniyor';
    const rec = find(id);
    if (!rec) return { ok: false, reason: 'not-found' };
    if (rec.state === RECEIPT_STATE.LANDED || rec.state === RECEIPT_STATE.SENDING || rec.state === RETRYING) return { ok: false, reason: 'not-retryable' };
    queue.delete(id);
    rec.attempts = (rec.attempts | 0) + 1;
    rec.lastTriedAt = new Date(now()).toISOString();
    rec.retryFrom = { state: rec.state, reason: rec.reason || null };
    setState(rec, RETRYING, rec.reason || null); // önceki neden korunur: kart bağlamını kaybetmez
    const panes = snapshotPanes();
    const same = rec.to.paneKey ? panes.find((p) => p.paneId === rec.to.paneKey && p.agentId === rec.to.agentId) : null;
    const pane = same || panes.filter((p) => p.agentId === rec.to.agentId).sort((a, b) => (a.state === PANE_STATE.IDLE ? -1 : 1) - (b.state === PANE_STATE.IDLE ? -1 : 1))[0] || null;
    const receipt = await route(rec, pane);
    return { ok: true, receipt };
  }

  /** "Son işlemler" — kopya, en yeni önde. */
  function list() {
    return ledger.map((r) => JSON.parse(JSON.stringify(r)));
  }

  /** Renderer'ın HEDEF SORUSU için: çözümü teslimsiz sor. */
  function resolve(target, ctx) {
    return resolveTarget(target || {}, { ...(ctx || {}), panes: snapshotPanes() });
  }

  /**
   * AXP-14 — UÇUŞ-ÖNCESİ YOKLAMA (yazmaz, makbuz üretmez, kuyruğa koymaz). Işık yalnız
   * `idle` hedefe uçar; bu ölçüm `waitReady`nin TEK TUR okumasıdır (kopya değil, aynı
   * `snapshotPanes` + `composerScan` kuralı): pane hâli IDLE/BUSY ise doğrudan; FRESH/
   * UNKNOWN ise composer ölçülür — 'menu' TEK KAREDE hüküm değildir (AXP-12): ikinci okuma
   * `freshPollMs` sonra; ikisi de menü derse menüdür, yoksa 'fresh' (= hazır değil, uçma).
   * @returns {Promise<{resolved:object, pane:{paneId:string,state:string}|null, state:string}>}
   */
  async function probe(target, ctx) {
    const resolved = resolveTarget(target || {}, { ...(ctx || {}), panes: snapshotPanes() });
    if (resolved.kind !== 'resolved' || !resolved.pane) return { resolved, pane: null, state: PROBE_STATE.NONE };
    const paneId = resolved.pane.paneId;
    const p = snapshotPanes().find((x) => x.paneId === paneId) || null;
    if (!p) return { resolved, pane: null, state: PROBE_STATE.NONE };
    const pane = { paneId, state: p.state };
    if (p.state === PANE_STATE.IDLE) return { resolved, pane, state: PROBE_STATE.IDLE };
    if (p.state === PANE_STATE.BUSY) return { resolved, pane, state: PROBE_STATE.BUSY };
    const read = () => {
      let buf = '';
      try { buf = io.readPaneBuffer(paneId) || ''; } catch { buf = ''; }
      return composerScan(buf, { ignoreRunning: true });
    };
    let scan = read();
    if (scan === 'menu') {
      await sleep(cfg.freshPollMs);
      scan = read();
      if (scan === 'menu') return { resolved, pane, state: PROBE_STATE.MENU };
    }
    if (scan === 'empty') return { resolved, pane, state: PROBE_STATE.IDLE };
    if (scan === 'text') return { resolved, pane, state: PROBE_STATE.TEXT };
    return { resolved, pane, state: PROBE_STATE.FRESH };
  }

  return {
    deliverConfirmed,
    drainQueue,
    cancel,
    retry,
    list,
    resolve,
    probe,
    stop: disarmQueue,
    /** test/e2e: kuyruk boyu */
    queued: () => queue.size,
  };
}

module.exports = {
  RECEIPT_STATE,
  REASON,
  PROBE_STATE,
  DEFAULTS,
  digestOf,
  shortJobId,
  deliveryNeedle,
  paneStateOf,
  reasonFromDeliver,
  maskLine,
  screenTrail,
  createAgentxDeliver,
};
