// ENG-05 (TASK-MSXJ37Y3MR1WV) — KALICI VERİYE YAZILACAK MOTOR DEĞERİNİN KAPISI.
//
// KÖK NEDEN (ENG-R3 §11.1 + §14/R2'de ölçüldü): pane defteri ve oturum defteri motoru
//   `engine: i.engine === 'codex' ? 'codex' : 'claude'`
// diye kaydediyordu. Bu bir "varsayılan" değil, bir VERİ UYDURMASIdır: tanınmayan her
// değer — yazım hatası, bozuk kayıt ya da YARIN eklenecek üçüncü motor — diske
// `claude` olarak düşer. Sonra o yalanı okuyan herkes yanlış davranır:
//   • `tokenUsage.usageForPane` claude fiyatlandırmasıyla maliyet ÜRETİR (ölçmediği
//     bir motor için uydurma para),
//   • restart-resume pane'i `claude --resume <id>` ile açmaya çalışır (yanlış ikili),
//   • rozet/başlık kullanıcıya yanlış motoru gösterir.
// Bunların hiçbiri hata vermez — sessizce yanlış olur. Üçüncü motor eklendiği GÜN
// üretilecek bu hatayı, motor eklenmeden ÖNCE kapatmak bu modülün tek işidir.
//
// SÖZLEŞME: tanınmayan motor `null` olur — `claude` DEĞİL. `null` tüketiciler için
// zaten var olan DÜRÜST yoldur (`tokenUsage.cjs:501` → `note:'engine-not-measurable'`,
// `integrationStatus.cjs:86` → `toolsLive=false`). Yani bu düzeltme yeni bir dal
// açmaz, mevcut "ölçemiyorum" yoluna doğru veriyi akıtır.
//
// ÜYELİK SORUSU BURADA CEVAPLANMAZ: "bu bir motor mu?" sorusunun tek sahibi ENG-04'ün
// `engineRegistry.cjs` descriptor defteridir (ve onun drift testleri listeyi
// `engines.ts` + `ALLOWED_COMMANDS` ile karşılaştırır). Bu modül orayı SORAR; kendi
// kopya listesini TUTMAZ — ikinci bir liste, kapatmaya çalıştığımız sessiz-sapma
// sınıfının ta kendisi olurdu. Buranın katkısı iki şey: (1) tanınmayanı `null`a
// çevirmek, (2) bunu GÖRÜNÜR kılmak (rapor/log).

'use strict';

const engineRegistry = require('./engineRegistry.cjs'); // ENG-04 — motor descriptor defteri (tek üyelik kaynağı)

/** Tanınan bir motor kimliği mi? (Kayıt defterine sorar — kopya liste yok.) */
function isEngineId(value) {
  return engineRegistry.isRegisteredEngine(value);
}

/** Bugün tanınan motor kimlikleri (descriptor defterinden türetilir). */
function engineIds() {
  return engineRegistry.engineIds();
}

// ── Bilinmeyen motor raporu ────────────────────────────────────────────────
// Saf modül IPC/log bilmez: main.js gözlemciyi takar (→ `crewpane-shell.log`),
// testler ölçer. Gözlemci yoksa son çare `console.warn` — sessiz kalmak YASAK,
// zaten bu görevin tamamı "sessizce yanlış"ı "gürültülü doğru"ya çevirmektir.
let unknownObserver = null;
/** Aynı (yer, değer) çifti için tek satır — 5 sn'lik polling'lerde log seli olmasın. */
const reported = new Set();
const MAX_REPORTED = 200;

/**
 * @param {null|((info:{value:unknown,where:string,agentId:string|null,paneId:string|null,message:string})=>void)} fn
 */
function setUnknownEngineObserver(fn) {
  unknownObserver = typeof fn === 'function' ? fn : null;
}

/** Tekrar-bastırma defterini sıfırla (testler + uzun oturumlarda tavan). */
function resetUnknownEngineReports() {
  reported.clear();
}

function reportUnknown(info) {
  const key = `${info.where}::${String(info.value).slice(0, 64)}`;
  if (reported.has(key)) return;
  if (reported.size >= MAX_REPORTED) reported.clear(); // tavan: defter belleği yemesin
  reported.add(key);
  const message =
    `motor TANINMADI: ${JSON.stringify(String(info.value).slice(0, 64))} (${info.where}` +
    `${info.agentId ? ` agent=${info.agentId}` : ''}${info.paneId ? ` pane=${info.paneId}` : ''}) ` +
    `→ engine=null kaydedildi (claude'a DÜŞÜRÜLMEDİ)`;
  if (unknownObserver) {
    try { unknownObserver({ ...info, message }); return; } catch { /* gözlemci hatası akışı bozmaz */ }
  }
  try { console.warn(`[engine] ${message}`); } catch { /* stdout kapalı olabilir */ }
}

/**
 * Serbest bir değeri motor kimliğine ÇÖZ — tanınmıyorsa `null` (asla `claude`).
 *
 * Ayrım bilinçli:
 *   • yok/boş (`null`, `undefined`, `''`) → sessizce `null`. "Motor söylenmedi" bir
 *     hata değildir (eski kayıtlar, shell pane'leri); her satırda uyarmak gürültüdür.
 *   • dolu ama tanınmayan (`'gemini'`, `'python'`, `42`) → `null` + RAPOR. Burası
 *     gerçek veri bütünlüğü olayıdır: biri var olmayan bir motor yazmış.
 *
 * @param {unknown} value
 * @param {{where?:string, agentId?:string|null, paneId?:string|null}} [ctx]
 * @returns {string|null} kayıtlı motor kimliği ya da null
 */
function coerceEngine(value, ctx = {}) {
  if (isEngineId(value)) return value;
  if (value === null || value === undefined || value === '') return null;
  reportUnknown({
    value,
    where: typeof ctx.where === 'string' && ctx.where ? ctx.where : 'unknown',
    agentId: typeof ctx.agentId === 'string' ? ctx.agentId : null,
    paneId: typeof ctx.paneId === 'string' ? ctx.paneId : null,
  });
  return null;
}

module.exports = {
  engineIds,
  isEngineId,
  coerceEngine,
  setUnknownEngineObserver,
  resetUnknownEngineReports,
};
