// CrewPane — ADP-692: TUR-BAŞI BRİFİNG (liderin bekleyen bitişleri KENDİ okuması).
//
// ─────────────────────────────────────────────────────────────────────────────
// NEDEN (Eren'in P0 UX şikâyeti — İKİNCİ KEZ)
// ─────────────────────────────────────────────────────────────────────────────
// "Kullanıcı prompt yazarken diğer ajanın bitiş bildirimi geliyor, YARIM PROMPT'un
//  devamına ekleniyor ve ENTER'a basılıyor — yarım prompt gönderiliyor."
//
// ADP-667 bunu bir NÖBETÇİ ile çözmeye çalıştı: yazmadan önce composer'a bak, doluysa
// ertele. Nöbetçi çoğu zaman doğru erteliyor (672 logunda "lider MEŞGUL — uyandırma
// ertelendi") AMA yapısal olarak MİKRO YARIŞA açık: nöbetçi t=0'da "boş" der, kullanıcı
// t=0.1'de yazmaya başlar, t=0.2'de mesaj kutuya düşer. Nöbetçiyi ne kadar sıkılaştırsan
// da yarış KAPANMAZ, çünkü ekranı okuyan her sinyal insanın parmağının GERİSİNDEDİR.
//
// ─────────────────────────────────────────────────────────────────────────────
// MİMARİ DEĞİŞİKLİK: İKİ KANAL (yama değil)
// ─────────────────────────────────────────────────────────────────────────────
//   KANAL A (bu modül) — LİDER KULLANICIYLA KONUŞUYORSA hiç enjekte etme; lider
//     bekleyen bitişleri HER TURUN BAŞINDA KENDİ OKUSUN. Mekanizma: claude'un
//     `UserPromptSubmit` hook'u (`--settings <dosya>` ile kurulur). Hook, kullanıcı
//     ENTER'a BASTIKTAN SONRA çalışır ve çıktısını `additionalContext` olarak turun
//     bağlamına ekler — composer'a bir bayt bile YAZMAZ, hiçbir tuş simüle edilmez.
//     Kullanıcının metni yapısal olarak DOKUNULAMAZ hâle gelir.
//     (ÖLÇÜLDÜ — bkz. sonuç raporu: hook çalıştı ve model additionalContext'teki
//      görev kodunu aynen okudu.)
//   KANAL B (delegationSupervisor.wakeLeaders) — lider BOŞTA ve kullanıcı etkileşimi
//     YOKSA (otopilot) enjeksiyon sürer: kimseyi kesmiyor ve otopilotun ilerlemesi
//     buna bağlı (hook yalnız kullanıcı bir prompt gönderdiğinde ateşler).
//
// Bu dosya iki uçtan da çağrılır:
//   • `leaderBriefingHook.cjs` (hook süreci) — defteri okur, metni basar, MAKBUZ yazar.
//   • `delegationSupervisor.cjs` (main) — makbuzu tüketir: "lider bunu zaten gördü" →
//     kayıt ack'lenir, enjeksiyon kanalı o bitiş için bir daha denenmez (çift anlatım yok).
//
// SAF + IO'SUZ (fs yok) → `node --test` doğrudan koşar ([[leaf-module-node-test]]).

'use strict';

/** Makbuz dosyasının adı (instance-scoped `~/.crewpane[-dev|-test]/` altında). */
const RECEIPT_FILE = 'leader-briefing-receipts.json';

/** Bir makbuz kaydının defterde tutulma süresi (sonra budanır). */
const RECEIPT_TTL_MS = 6 * 60 * 60 * 1000;

/** Tek brifingde anlatılacak en fazla bitiş (bağlam şişmesin). */
const MAX_ITEMS = 12;

/** Terminal (bitmiş) statüler — delegationSupervisor.isTerminalStatus ile aynı küme. */
const TERMINAL = Object.freeze(['done', 'failed', 'timeout', 'undelivered']);

/** Kullanıcıya/lidere gösterilecek statü metni. */
const STATUS_TR = Object.freeze({
  done: 'BİTTİ',
  failed: 'BAŞARISIZ',
  timeout: 'ZAMAN AŞIMI',
  undelivered: 'TESLİM EDİLEMEDİ',
});

function isTerminal(status) {
  return TERMINAL.includes(String(status || ''));
}

/**
 * Bu lider için BEKLEYEN bitişler: terminal + bu liderin + henüz lidere ULAŞMAMIŞ.
 *
 * "Ulaşmış" iki şekilde olur ve İKİSİ DE burada elenir:
 *   • `wake.ackedAt` — kanal B mesajı liderin bağlamına girdi (supervisor doğruladı),
 *   • `wake.briefedAt` — kanal A bu bitişi bir tur başında zaten anlattı.
 * Aksi hâlde lider aynı bitişi iki kanaldan iki kez okurdu (ADP-667'nin çözdüğü
 * "aynı bitiş 2-3 kez" şikâyetinin yeni bir kaynağı olurdu).
 */
function pendingFor(state, leaderId, o) {
  const opts = o || {};
  const id = String(leaderId || '').trim();
  if (!id) return [];
  const records = (state && state.records) || {};
  const out = [];
  for (const rec of Object.values(records)) {
    if (!rec || String(rec.leaderId || '') !== id) continue;
    if (!isTerminal(rec.status)) continue;
    const wake = rec.wake || {};
    if (wake.ackedAt || wake.briefedAt) continue;
    out.push(rec);
  }
  out.sort((a, b) => (a.settledAt || 0) - (b.settledAt || 0));
  const max = typeof opts.max === 'number' ? opts.max : MAX_ITEMS;
  return out.slice(0, max);
}

/** Bir kaydın tek satırlık özeti. */
function lineFor(rec) {
  const who = rec.agentId || '?';
  const what = rec.taskCode || rec.title || rec.subtaskId || '?';
  const st = STATUS_TR[rec.status] || String(rec.status || '?').toUpperCase();
  const ev = rec.evidencePath ? ` · kanıt: ${rec.evidencePath}` : '';
  const why = rec.reason ? ` · ${String(rec.reason).replace(/\s+/g, ' ').slice(0, 120)}` : '';
  return `- ${who}: ${what} → ${st}${ev}${why}`;
}

/**
 * Tur-başı bağlam metni. Boş liste → `''` (hook HİÇBİR ŞEY basmaz; boş bir brifing
 * her turda bağlam israfıdır ve lideri "yeni bir şey var" diye yanıltır).
 */
function briefingText(records) {
  const list = Array.isArray(records) ? records.filter(Boolean) : [];
  if (list.length === 0) return '';
  const head = `[CrewPane] Son turundan beri ${list.length} delegasyon bitti:`;
  return [
    head,
    ...list.map(lineFor),
    'Kuyruk otomatik ilerletildi. Bu bilgi ekrana yazılmadı — tur başında sana verildi;',
    'kullanıcının mesajını cevaplarken bunları da hesaba kat (gerekiyorsa çıktıları incele).',
  ].join('\n');
}

/**
 * Hook'un basacağı JSON. claude `UserPromptSubmit` sözleşmesi: stdout'a bu obje
 * yazılırsa `additionalContext` turun bağlamına eklenir (ölçüldü, bkz. rapor).
 */
function hookPayload(text) {
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: String(text || ''),
    },
  };
}

/**
 * MAKBUZ — hook yazar, main tüketir. AYRI dosya olması ŞART: hook AYRI BİR SÜREÇTİR ve
 * `delegation-supervisor.json`'a yazsaydı main'in oku-değiştir-yaz döngüsüyle yarışıp
 * uçuştaki kayıtları SİLEBİLİRDİ (atomik rename yalnız yarım dosyayı önler, kayıp
 * güncellemeyi DEĞİL). Tek yönlü akış: hook append-only makbuz → main tüketir.
 */
function mergeReceipt(prev, entry, o) {
  const opts = o || {};
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const ttl = typeof opts.ttlMs === 'number' ? opts.ttlMs : RECEIPT_TTL_MS;
  const base = prev && typeof prev === 'object' && prev.entries && typeof prev.entries === 'object'
    ? prev
    : { version: 1, entries: {} };
  const out = { version: 1, entries: {} };
  for (const [k, v] of Object.entries(base.entries)) {
    if (!v || typeof v !== 'object') continue;
    if (now - (v.at || 0) >= ttl) continue; // budama
    out.entries[k] = v;
  }
  if (entry && entry.key) out.entries[String(entry.key)] = { at: now, leaderId: entry.leaderId || null };
  return out;
}

/** Makbuz defterinden BU tick'te tüketilecek anahtarlar (main tarafı). */
function receiptKeys(receipt) {
  const entries = (receipt && receipt.entries) || {};
  return Object.keys(entries);
}

module.exports = {
  RECEIPT_FILE,
  RECEIPT_TTL_MS,
  MAX_ITEMS,
  STATUS_TR,
  isTerminal,
  pendingFor,
  lineFor,
  briefingText,
  hookPayload,
  mergeReceipt,
  receiptKeys,
};
