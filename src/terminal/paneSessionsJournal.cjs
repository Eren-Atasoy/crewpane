// ADP-734 (Kapı 3) — SİLİNMEYEN OTURUM DEFTERİ (append-only journal).
//
// SORUN (ADP-732'de ölçüldü): `live-panes.json` bir CANLI KÜMEdir — meşru olarak
// boşalır (`clearAll` her açılışta, `removePane` her kapanışta). Yani TARİH TUTMAZ.
// 2026-07-29'da 7 ajanın oturumu ekrandan silindiğinde "hangi ajan hangi sessionId
// ile koşuyordu" sorusunun cevabı hiçbir yerde YOKTU: kurtarma 30 yedek dosyasını
// taramayı + `~/.claude/projects` altındaki 1552 transkripti indekslemeyi gerektirdi.
//
// ÇÖZÜM: pane defterinin YANINDA, asla temizlenmeyen, yalnız-ekleme bir JSONL.
// Her `recordPane` / `setSessionId` / `removePane` bir satır yazar. `clearAll` bu
// dosyaya DOKUNMAZ. Kurtarma tek `recoverSessions()` çağrısıdır.
//
// DİSİPLİNLER (livePaneRegistry ile aynı):
//   • `homedir` dikişi → birim testleri tmp dizinde koşar.
//   • Okuma ASLA atmaz (eksik/bozuk satır atlanır).
//   • Yazma best-effort: journal bir TEŞHİS defteridir, bir yazma hatası ajan
//     açmayı ASLA engellememelidir.
//   • Boyut sınırlıdır: dosya MAX_BYTES'ı aşınca kuşaklara döner (.1, .2 …) —
//     `clearAll` gibi bir "hepsini sil" yolu yoktur.
//
// KOPYALANIR-TAŞINMAZ: accountScope göçünde bu dosya REGISTRY_CLASS'tadır
// (ADP-734 Kapı 1) — eski sürüme geri dönen kullanıcı da defteri bulur.

'use strict';

const fs = require('node:fs');
// ADP-835 (790 K1) — atomik yazımın rename adımı platform boğazından geçer:
// Windows'ta Defender/Search hedefi açık tutunca EPERM/EBUSY gelir ve bu çağrıların
// çoğu best-effort catch içinde OLDUĞU İÇİN kayıt SESSİZCE kaybolurdu.
const { renameWithRetrySync } = require('../../platform/atomicWrite.cjs');
const path = require('node:path');
const instancePaths = require('../config/instancePaths.cjs');
const engineCoerce = require('../agents/engineCoerce.cjs'); // ENG-05 — motor değeri kapısı

const JOURNAL_FILE = 'pane-sessions.jsonl';

/** Dosya bu boyutu aşınca kuşak kaydırılır (~2 MB ≈ on binlerce satır). */
const MAX_BYTES = 2 * 1024 * 1024;

/** Kaç kuşak saklanır (`.1` … `.N`). Toplam tavan ≈ (N+1) × MAX_BYTES. */
const MAX_GENERATIONS = 3;

/** Kurtarma okumasında taranacak azami satır (bellek tavanı). */
const MAX_SCAN_LINES = 20000;

function journalDir(homedir) {
  return instancePaths.crewpaneHome(homedir);
}

/** Aktif journal dosyasının mutlak yolu. */
function journalPath(homedir) {
  return path.join(journalDir(homedir), JOURNAL_FILE);
}

/** `.1` … `.N` kuşakları dahil, YENİDEN ESKİYE tüm journal dosyaları. */
function journalGenerations(homedir) {
  const base = journalPath(homedir);
  const out = [base];
  for (let i = 1; i <= MAX_GENERATIONS; i += 1) out.push(`${base}.${i}`);
  return out;
}

/**
 * Kuşak kaydırma: `.2`→`.3`, `.1`→`.2`, dosya→`.1`. En eski kuşak DÜŞER (tavan
 * bilinçli — sonsuz büyüyen bir teşhis dosyası diskin kendisi bir arızadır).
 */
function rotate(homedir) {
  const base = journalPath(homedir);
  try {
    if (fs.statSync(base).size < MAX_BYTES) return false;
  } catch {
    return false; // dosya yok → dönecek bir şey de yok
  }
  for (let i = MAX_GENERATIONS - 1; i >= 1; i -= 1) {
    try { renameWithRetrySync(`${base}.${i}`, `${base}.${i + 1}`); } catch { /* yoksa geç */ }
  }
  try { renameWithRetrySync(base, `${base}.1`); return true; } catch { return false; }
}

/**
 * Tek olay ekle. `event`: 'spawn' | 'session' | 'close' | 'restore' (serbest metin
 * kabul edilir — defter bir teşhis kaydıdır, bir durum makinesi değil).
 * @returns {boolean} satır yazıldı mı (best-effort)
 */
function appendEvent(event, info, homedir, now) {
  const i = info && typeof info === 'object' ? info : {};
  const line = {
    ts: Number.isFinite(now) ? now : Date.now(),
    event: typeof event === 'string' && event ? event : 'unknown',
    paneId: typeof i.paneId === 'string' ? i.paneId : null,
    agentId: typeof i.agentId === 'string' ? i.agentId : null,
    department: typeof i.department === 'string' ? i.department : null,
    sessionId: typeof i.sessionId === 'string' ? i.sessionId : null,
    // ENG-05 — bilinmeyen motor `null` (claude DEĞİL). Defter bir TEŞHİS kaydıdır:
    // kurtarma sırasında "hangi motorla koşuyordu" sorusuna UYDURMA cevap vermek,
    // "bilmiyorum" demekten kötüdür — yanlış motorla resume edilir.
    engine: engineCoerce.coerceEngine(i.engine, {
      where: 'paneSessionsJournal.appendEvent',
      agentId: typeof i.agentId === 'string' ? i.agentId : null,
      paneId: typeof i.paneId === 'string' ? i.paneId : null,
    }),
    cwd: typeof i.cwd === 'string' ? i.cwd : null,
  };
  try {
    fs.mkdirSync(journalDir(homedir), { recursive: true });
    rotate(homedir);
    fs.appendFileSync(journalPath(homedir), `${JSON.stringify(line)}\n`);
    return true;
  } catch {
    return false; // teşhis defteri ajan açmayı ASLA bloklamaz
  }
}

/** Tüm kuşaklardan olayları YENİDEN ESKİYE oku. Bozuk satırlar atlanır, asla atmaz. */
function readEvents(homedir, opts = {}) {
  const limit = Number.isFinite(opts.limit) ? opts.limit : MAX_SCAN_LINES;
  const out = [];
  for (const file of journalGenerations(homedir)) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const s = lines[i].trim();
      if (!s) continue;
      let rec;
      try { rec = JSON.parse(s); } catch { continue; }
      if (!rec || typeof rec !== 'object') continue;
      out.push(rec);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * KURTARMA — her ajan için EN SON bilinen (agentId, sessionId) çifti.
 * Kapatma olayları ('close') ajanı listeden DÜŞÜRMEZ: bu defterin amacı
 * "neyi kaybettik" sorusunu cevaplamaktır, "şu an ne açık" değil (onu
 * `live-panes.json` söyler). `event` alanı dönen kayıtta korunur ki çağıran
 * "bilerek kapatılmış" ile "koşarken kayboldu" ayrımını yapabilsin.
 * @returns {Array<{agentId,sessionId,department,engine,cwd,paneId,ts,event}>}
 */
function recoverSessions(homedir, opts = {}) {
  const events = readEvents(homedir, opts);
  const seen = new Set();
  const out = [];
  for (const e of events) {
    if (!e.agentId || !e.sessionId) continue;
    if (seen.has(e.agentId)) continue;
    seen.add(e.agentId);
    out.push({
      agentId: e.agentId,
      sessionId: e.sessionId,
      department: e.department || null,
      // ENG-05 — DİSKTEN okunan eski/yabancı satır da claude'a düşürülmez.
      engine: engineCoerce.coerceEngine(e.engine, {
        where: 'paneSessionsJournal.recoverSessions',
        agentId: typeof e.agentId === 'string' ? e.agentId : null,
        paneId: typeof e.paneId === 'string' ? e.paneId : null,
      }),
      cwd: e.cwd || null,
      paneId: e.paneId || null,
      ts: Number.isFinite(e.ts) ? e.ts : 0,
      event: typeof e.event === 'string' ? e.event : 'unknown',
    });
  }
  return out;
}

module.exports = {
  JOURNAL_FILE,
  MAX_BYTES,
  MAX_GENERATIONS,
  journalDir,
  journalPath,
  journalGenerations,
  rotate,
  appendEvent,
  readEvents,
  recoverSessions,
};
