// STAT-D1 — MARKER TESPİTİNİN TEK SAF ÇEKİRDEĞİ (docs/design/STATUS-SYNC.md §1, KN-1).
//
// ─────────────────────────────────────────────────────────────────────────────
// NEDEN VAR — "fix bir katmana uygulandı, ikizine uygulanmadı"
// ─────────────────────────────────────────────────────────────────────────────
// TASK-MQSE75BXC4MW3 (2026-07) worker'ın bitiş marker'ını dispatch ettiğimiz
// prompt'un ECHO'sundan ayırmayı çözdü — ama YALNIZ renderer'da
// (`src/app/lib/delegation.ts` → `parseMarkers`). Main sürecin supervisor'ı KENDİ
// bağımsız taramasını yapıyordu ve echo-güvenli DEĞİLDİ.
//
// STAT-R1 bunun bedelini ölçtü (2026-08-18):
//   • 27 delegasyonun 19'u `settledBy=marker` + `failed`; 12'si dispatch'ten
//     sonraki 20 SANİYE içinde (3, 3, 3, 3, 4, 4, 5, 8, 10, 13, 18, 19 sn).
//   • ENG-17/pane-70: tespit anında pane'in TOPLAM çıktısı ≤2721 bayt = banner +
//     1559 karakterlik prompt echo'su. Worker TEK KARAKTER iş üretmemişti.
//     `inferno` o damgadan sonra 49 DAKİKA daha çalıştı.
//   • Sonda (`05-marker-echo-probe.out`): 4 gerçek `promptPayload`ın DÖRDÜNDE de
//     sarmasız eşleşme 0, ama 42/63/125/126 kolonda sarıldığında EŞLEŞME VAR.
//
// Bu dosya o taramayı TEK yere indirir. Kurallar renderer'ın `parseMarkers`
// kurallarının BİREBİR aynısıdır (kopya değil — orası tip-import kısıtı yüzünden
// bu CJS'i çağıramaz, ama kurallar burada TANIMLI ve testi ikisini de kilitler):
//
//   (a) Bir satırda ≥2 marker token varsa (sözleşme echo'su DONE+FAIL aynı satırda)
//       satır TÜMÜYLE atlanır.
//   (b) Marker satırın BAŞINDA olmalı (önünde bir KELİME varsa düzyazı/echo'dur).
//   (c) YENİ — SÖZLEŞME KUYRUĞU BOŞLUK-ESNEK OLARAK SİLİNİR. (a) ve (b) sarmanın
//       çoğu genişliğini yakalar ama HEPSİNİ değil: sarma tam `DONE:stX` ile
//       `FAIL:stX` ARASINA düşerse satırda tek token kalır ve marker satır başına
//       gelir ⇒ (a) ve (b) İKİSİ de geçer. Bu yüzden tarama ÖNCESİNDE, dispatch
//       edilen prompt'un sözleşme kuyruğu tampondan silinir; sarma yalnız BOŞLUK
//       eklediği için boşluk-esnek desen onu her genişlikte yakalar.
//
// SAF: fs/ipc/electron yok → `node --test electron/markerSafe.test.cjs` doğrudan koşar.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// ADP-938/953 — tam ECMA-48 final aralığı (0x40–0x7e). limitDetect.cjs'teki
// uygulama TEK kaynaktır; burada YENİDEN YAZILMAZ, çağrılır.
const { stripAnsiRobust } = require('../terminal/limitDetect.cjs');

/** Bir satırdaki marker TOKEN'ları (kural a'nın sayacı). */
const MARKER_TOKEN = /\b(?:STARTED|DONE|FAIL|TIMEOUT):[A-Za-z0-9_.:-]+/g;
/** Marker'dan ÖNCE yok sayılabilecek terminal süsü. Bir KELİME asla silinmez (kural b). */
const LEAD_DECOR = /^[\s>⏺●○◦▪▫■□◆◇│┃|║*•·.…–—=+~`#-]+/u;

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * (c) — Dispatch edilen prompt'un SÖZLEŞME KUYRUĞUNU tampondan sil.
 *
 * Kuyruk = payload'daki İLK marker token'ından sonuna kadar olan parça, ör.
 *   `DONE:st1  · hata olursa: FAIL:st1 <sebep>]`
 * Terminal sarması bu metnin İÇİNE yalnız BOŞLUK (CR/LF/indent) ve olası çerçeve
 * çizgisi ekler; harfleri değiştirmez. Bu yüzden her boşluk-koşusu boşluk-esnek
 * bir sınıfa çevrilir ve desen HER sarma genişliğinde tutar.
 *
 * `promptPayload` yoksa metin AYNEN döner (geri uyum: eski kayıtlarda alan yok).
 */
function stripPromptEcho(text, promptPayload) {
  const payload = typeof promptPayload === 'string' ? stripAnsiRobust(promptPayload) : '';
  if (!text || !payload) return text || '';
  MARKER_TOKEN.lastIndex = 0;
  const first = MARKER_TOKEN.exec(payload);
  MARKER_TOKEN.lastIndex = 0;
  if (!first) return text;
  const tail = payload.slice(first.index).trim();
  if (tail.length < 8) return text; // anlamsız kısa kuyruk → deseni kurma
  // Her boşluk koşusu → sarmanın eklediği her şeyi yiyen esnek sınıf.
  const flexible = tail
    .split(/\s+/)
    .map(escapeRe)
    .join('[\\s\\u2500-\\u257f>·|]*');
  let re;
  try {
    re = new RegExp(flexible, 'g');
  } catch {
    return text; // desen kurulamadıysa (aşırı uzun) taramayı bozmayız
  }
  return text.replace(re, ' ');
}

/**
 * `DONE:<subtaskId>` marker'ının GERÇEK adedi (echo'lar sayılmadan).
 *
 * @param {string} buffer            HAM pty tamponu (ANSI burada süzülür)
 * @param {string} subtaskId         'st1' gibi delegasyon-içi kimlik
 * @param {{promptPayload?:string}} [opts]  dispatch edilen prompt (kural c)
 * @returns {number}
 */
function countDoneMarkers(buffer, subtaskId, opts) {
  const id = typeof subtaskId === 'string' ? subtaskId.trim() : '';
  if (!buffer || !id) return 0;
  let text = stripAnsiRobust(buffer);
  text = stripPromptEcho(text, opts && opts.promptPayload);
  const line = new RegExp(`^DONE:[ \\t]*${escapeRe(id)}\\b`);
  let n = 0;
  // ÇIPLAK \r DE SATIR SINIRIDIR. ConPTY/TUI ekranı yeniden çizerken `\r` + EL
  // (CSI 2K) ile satır başına döner ve LF BASMAZ: `…\rDONE:st1` tek "satır" gibi
  // görünürdü ve gerçek marker KAÇARDI (ADP-953/ENG-01 nöbetleri bunu kilitliyor).
  for (const rawLine of text.split(/\r\n|[\r\n]/)) {
    // (a) sözleşme echo'su: aynı satırda birden çok marker token
    const tokens = rawLine.match(MARKER_TOKEN);
    if (tokens && tokens.length > 1) continue;
    // (b) marker satırın BAŞINDA olmalı
    if (line.test(rawLine.replace(LEAD_DECOR, ''))) n += 1;
  }
  return n;
}

module.exports = { countDoneMarkers, stripPromptEcho, MARKER_TOKEN, LEAD_DECOR };
