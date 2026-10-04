// CrewPane — ENT-F1: TESLİM-DOĞRULAMALI PROMPT GÖNDERİMİ (ana süreç primitifi).
//
// ─────────────────────────────────────────────────────────────────────────────
// NEDEN VAR — ENT-R1'İN ÖLÇÜMÜ
// ─────────────────────────────────────────────────────────────────────────────
// Ana süreçte pane'e prompt yazan DÖRT yol vardı ve HİÇBİRİ teslimi doğrulamıyordu:
//
//   P0 supervisor yeniden gönderimi  → `write(prompt)` ve HEPSİ BU: **ENTER YOK**
//   P1 lider uyandırma               → `write(text)` + `write('\r')`, 0 ms boşluk
//   P2 devir özeti (writePromptToPane) → text → 400 ms → `\r`, doğrulama yok
//   P3 `/clear` dizisi               → ESC → cmd → 400 ms → `\r`, doğrulama yok
//
// P0 gerçek claude 2.1.246 + gerçek node-pty ile TEKRAR ÜRETİLDİ (ENT-R1 §5b):
// boşta bir pane'e bile yazıldığında 25 sn sonra ekranda `paste again to expand`
// çipi asılı kalıyor ve worker'ın oturum defteri HİÇ OLUŞMUYOR. P3'ün imzası
// canlı log'da: 22 sıfırlamanın 4'ü "TUTMAMIŞ".
//
// ─────────────────────────────────────────────────────────────────────────────
// SÖZLEŞME — "METİN EN FAZLA BİR KEZ, ENTER SERBESTÇE"
// ─────────────────────────────────────────────────────────────────────────────
// Çift-gönderimin kaynağı metnin TEKRAR YAZILMASIDIR (ENT-R1 §5a/A3: iki yeniden
// gönderim satır editöründe YAN YANA birikti; biri Enter'a bastığı an motor işi
// İKİ KEZ alırdı). Bu yüzden:
//
//   • bir kayıt için `text` pane'e EN FAZLA BİR KEZ yazılır (`textWrittenAt` damgası),
//   • her yeniden deneme YALNIZ `\r`'dir.
//
// Bu neden güvenli: boş composer'da `\r` no-op'tur; dolu composer'da bekleyen metni
// gönderir — tam istediğimiz şey. Riskli tek yer MENÜ/SEÇİM ekranıdır ve ADP-920'nin
// güvenlik sınırı aynen korunur: 'menu' · 'unknown' → HİÇBİR ŞEY YAZILMAZ.
//
// TÜM IO ENJEKTE (fs/electron/pty require'ı YOK) → `node --test` doğrudan koşar
// ([[leaf-module-node-test]]). Bağımlılıklar saf leaf: submitOutcome + pastePayload.

'use strict';

const {
  submitOutcome,
  unsentPasteChip,
  verifyAndRetrySubmit,
  submitGapForLoad,
  DEFAULT_SUBMIT_GAP_MS,
} = require('./submitOutcome.cjs');
const { composerScan } = require('./leaderComposer.cjs');
const { pastePayload } = require('../services/pastePayload.cjs');

/**
 * Bekleyen (gönderilmemiş) bir yapıştırma ekranda duruyor mu? İki imza:
 *   • çip  — çok satırlı yapıştırma `[Pasted text #N]` olarak toplanmış,
 *   • düz  — tek satırlık yapıştırma composer'da METİN olarak duruyor.
 * `ignoreRunning`: ekrandaki `esc to interrupt` ESKİ turun kanıtıdır (AD-DELEG-01).
 * @param {string} buffer
 */
function pendingTextOnScreen(buffer) {
  if (typeof buffer !== 'string' || !buffer) return false;
  return unsentPasteChip(buffer) || composerScan(buffer, { ignoreRunning: true }) === 'text';
}

/**
 * Enter basmak GÜVENLİ mi? Yalnız "bekleyen metin var" ölçüldüğünde evet.
 * 'menu' (açık seçim) ve 'unknown' (okunamayan ekran) → HAYIR: orada `\r` bir
 * SEÇİM yapar ya da kabukta komut çalıştırır.
 * @param {string} buffer
 * @returns {{safe:boolean, reason:'pending'|'empty'|'menu'|'unknown'}}
 */
function enterSafety(buffer) {
  if (pendingTextOnScreen(buffer)) return { safe: true, reason: 'pending' };
  const scan = composerScan(buffer, { ignoreRunning: true });
  if (scan === 'empty') return { safe: false, reason: 'empty' };
  if (scan === 'menu') return { safe: false, reason: 'menu' };
  return { safe: false, reason: 'unknown' };
}

/**
 * @typedef {Object} DeliverIO
 * @property {(paneId:string)=>string} readPaneBuffer  pane'in ham çıktısı
 * @property {(paneId:string,data:string)=>boolean} writePane  pty'ye yaz
 * @property {(ms:number)=>Promise<void>} sleep
 * @property {()=>number} [now]
 * @property {()=>number} [livePaneCount]  yük vekili (submit boşluğu için)
 * @property {(line:string)=>void} [log]
 */

/**
 * @typedef {Object} DeliverResult
 * @property {'submitted'|'pending'|'unknown'} outcome  SON hüküm ('unknown' asla 'submitted' sayılmaz)
 * @property {boolean} delivered  outcome === 'submitted'
 * @property {boolean} wroteText  bu çağrıda METİN yazıldı mı (en fazla bir kez!)
 * @property {number} enters  toplam kaç `\r` yazıldı (ilk gönderim + tekrarlar)
 * @property {number} retries  doğrulama döngüsünün EK Enter'ları
 * @property {string[]} observations
 * @property {number} gapMs  metin ↔ Enter arasındaki yük-farkında boşluk
 * @property {number|null} textWrittenAt  metnin yazıldığı an (çağıran DAMGALAR ve geri verir)
 * @property {string} reason
 */

/**
 * ENT-R1 §6.2'nin altı adımı. Metin en fazla bir kez yazılır; tekrar yalnız `\r`.
 *
 * ÜÇ MOD:
 *   'auto'        — (varsayılan) metni yaz → boşluk → `\r` → doğrula/tekrarla.
 *                   Metin bir kez yazılmış ve HÂLÂ ekranda asılıysa yeniden YAZMAZ.
 *   'enter-only'  — YENİDEN DENEME: metne DOKUNMAZ. İlk `\r` de ADP-920 güvenlik
 *                   sınırından geçer ('menu'/'unknown' → hiçbir şey yazılmaz).
 *   'submit-only' — ÇAĞIRAN metni AZ ÖNCE KENDİ yazdı (ADP-692'nin compare-and-swap
 *                   yolu: kontrol ile yazım arasında `await` OLAMAZ, o yüzden metin
 *                   yazımı çağırandadır). Burada yalnız boşluk + `\r` + doğrulama
 *                   koşar; ekran ölçümü ARANMAZ çünkü metin daha yeni yazıldı ve TUI
 *                   henüz çizmemiş olabilir — o an 'empty' okumak yanlış bir iptal
 *                   üretirdi.
 *
 * @param {string} paneId
 * @param {string} text  gönderilecek prompt (ham; yük şekillendirmesi burada yapılır)
 * @param {{mode?:'auto'|'enter-only'|'submit-only', textWrittenAt?:number|null,
 *          submitGapMs?:number, delaysMs?:readonly number[], bracketed?:boolean,
 *          label?:string}} [opts]
 * @param {DeliverIO} io
 * @returns {Promise<DeliverResult>}
 */
async function deliverPrompt(paneId, text, opts, io) {
  const o = opts || {};
  const now = io.now || (() => Date.now());
  const log = io.log || (() => {});
  const label = o.label ? `${o.label} ` : '';
  const read = (id) => {
    try { return io.readPaneBuffer(id) || ''; } catch { return ''; }
  };
  const write = (id, data) => {
    try { return io.writePane(id, data) !== false; } catch { return false; }
  };
  /** @type {DeliverResult} */
  const out = {
    outcome: 'unknown',
    delivered: false,
    wroteText: false,
    enters: 0,
    retries: 0,
    observations: [],
    gapMs: 0,
    textWrittenAt: typeof o.textWrittenAt === 'number' ? o.textWrittenAt : null,
    reason: 'ok',
  };

  const mode = o.mode === 'enter-only' || o.mode === 'submit-only' ? o.mode : 'auto';

  // ── (1) TAMPONU OKU → hüküm ────────────────────────────────────────────────
  // 'submit-only'de ekran OKUNMAZ: metin bu milisaniyede yazıldı, TUI henüz
  // çizmemiş olabilir ve boş bir kare yanlış iptal üretirdi.
  const before = mode === 'submit-only' ? '' : read(paneId);

  // ── (2) BEKLEYEN METNİMİZ VAR MI? Varsa METNİ YAZMA, doğrudan Enter'a geç ──
  // Mod çağıranın KARARIDIR (supervisor: `attempts > 1` → 'enter-only'); ekran
  // ölçümü ise İKİNCİ KEMERDİR — metni bir kez yazdıysak ve hâlâ ekranda asılıysa
  // İKİNCİ KEZ YAZMAK üst üste iki kopya bırakır (ENT-R1 §5a/A3'ün pty'de
  // fotoğrafladığı çift-gönderim riski).
  const alreadyWritten = out.textWrittenAt !== null && out.textWrittenAt > 0;
  const skipWrite = mode !== 'auto' || (alreadyWritten && pendingTextOnScreen(before));

  if (!skipWrite) {
    if (typeof text !== 'string' || text.trim() === '') {
      out.reason = 'no-text';
      log(`ENT-F1 teslim ${label}pane=${paneId} METİN YOK — hiçbir şey yazılmadı`);
      return out;
    }
    // ── DELEG-DELIVER-01 — YENİDEN-YAZIMIN GÜVENLİK SINIRI ────────────────────
    // Metni İKİNCİ kez yazmak yalnız tek bir hâlde meşrudur: ilk yazım pane'e HİÇ
    // varmamıştır (06.09 vakası — motor tek bayt basmadan yazıldı). Bunu ölçen tek
    // sinyal composer'ın MEASURABLY BOŞ olmasıdır. 'menu' (açık seçim) ya da
    // 'unknown' (okunamayan ekran) → yazmak bir SEÇİMİ yazıya döker ya da yarım bir
    // ekranın üstüne biner; ADP-920'nin güvenlik sınırı burada da geçerlidir.
    // İLK yazım bu kapıdan GEÇMEZ (taze pane'in ekranı zaten okunamaz olabilir).
    if (alreadyWritten) {
      const safety = enterSafety(before);
      if (safety.reason !== 'empty') {
        out.outcome = 'unknown';
        out.reason = `guard:rewrite-${safety.reason}`;
        log(
          `ENT-F1 teslim ${label}pane=${paneId} YENİDEN-YAZIM iptal (${out.reason}) — ` +
            `composer ölçülebilir BOŞ değil, metin ikinci kez YAZILMADI`,
        );
        return out;
      }
    }
    // ── (3) METNİ YAZ (kanonik yük: normalize + kırp + bracketed-paste) ──────
    const payload = pastePayload(text, { bracketed: o.bracketed !== false });
    if (!write(paneId, payload)) {
      out.reason = 'write-failed';
      log(`ENT-F1 teslim ${label}pane=${paneId} metin YAZILAMADI`);
      return out;
    }
    out.wroteText = true;
    out.textWrittenAt = now();
  } else if (mode !== 'submit-only') {
    // ENTER-ONLY: ADP-920 güvenlik sınırı ilk `\r` için de geçerlidir. Menü/okunamayan
    // ekranda Enter basmak bir SEÇİM yapar; boş composer'da gönderilecek bir şey yoktur.
    const safety = enterSafety(before);
    if (!safety.safe) {
      out.outcome = safety.reason === 'empty' ? 'submitted' : 'unknown';
      out.delivered = out.outcome === 'submitted';
      out.reason = safety.reason === 'empty' ? 'already-empty' : `guard:${safety.reason}`;
      log(
        `ENT-F1 teslim ${label}pane=${paneId} ENTER-ONLY iptal (${out.reason}) — ` +
          `metin TEKRAR YAZILMADI, Enter da basılmadı`,
      );
      return out;
    }
  }

  // ── (4) YÜK-FARKINDA BOŞLUK → `\r` ────────────────────────────────────────
  const baseGap = typeof o.submitGapMs === 'number' ? o.submitGapMs : DEFAULT_SUBMIT_GAP_MS;
  let paneCount = 0;
  try { paneCount = io.livePaneCount ? io.livePaneCount() : 0; } catch { paneCount = 0; }
  out.gapMs = submitGapForLoad(paneCount, baseGap);
  if (out.gapMs > 0) {
    try { await io.sleep(out.gapMs); } catch { /* uyku patlarsa yine de Enter'ı dene */ }
  }
  if (!write(paneId, '\r')) {
    out.reason = 'enter-failed';
    log(`ENT-F1 teslim ${label}pane=${paneId} ENTER yazılamadı`);
    return out;
  }
  out.enters += 1;

  // ── (5) DOĞRULA + ARTAN GECİKMEYLE ENTER TEKRARI (ASLA yeni metin) ────────
  const report = await verifyAndRetrySubmit(paneId, {
    readPane: async (id) => read(id),
    write: (id, data) => write(id, data),
    sleep: io.sleep,
    delaysMs: o.delaysMs,
  });

  // ── (6) HÜKÜM — 'unknown' ASLA 'submitted' SAYILMAZ ───────────────────────
  out.outcome = report.outcome;
  out.retries = report.retries;
  out.enters += report.retries;
  out.observations = report.observations;
  out.delivered = report.outcome === 'submitted';
  out.reason = out.delivered ? 'ok' : `not-delivered:${report.outcome}`;
  log(
    `ENT-F1 teslim ${label}pane=${paneId} ${out.delivered ? 'DOĞRULANDI' : 'DOĞRULANAMADI'} ` +
      `(mod=${mode} metin=${out.wroteText ? 'yazıldı' : 'YAZILMADI'} boşluk=${out.gapMs}ms ` +
      `enter=${out.enters} hüküm=${out.outcome} gözlemler=[${out.observations.join(',')}])`,
  );
  return out;
}

/** Enjekte IO'yu bir kez bağla; çağıranlar `deliver(paneId, text, opts)` kullanır. */
function createDeliverPrompt(io) {
  return (paneId, text, opts) => deliverPrompt(paneId, text, opts, io);
}

module.exports = { deliverPrompt, createDeliverPrompt, pendingTextOnScreen, enterSafety };
