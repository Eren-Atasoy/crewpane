// SYNC-F1-7 (Prowl) — TERCİH DOKÜMANI: şekil, DETERMİNİSTİK seri hâle getirme ve
//                     ANAHTAR-SEVİYESİ LWW birleştirmesi.
//                     Tasarım: SYNC-F1-TASARIM.md §5.5.2 · §3.1
//
// ═══════════════════════════════════════════════════════════════════════════════
// NEDEN DOKÜMAN-SEVİYESİ LWW YETMEZ (§5.5.2)
// ═══════════════════════════════════════════════════════════════════════════════
// Senkron motoru dosyaları BAYT olarak taşır ve çakışmayı dosya bazında çözer.
// Bu doküman için o YETMEZ: mac'te temayı, Windows'ta dili değiştirdiysen bayt
// bazlı LWW birini KAYBEDER. Hafızada kayıp kurtarılabilir (çakışma defteri +
// nesne deposu); tercihte kullanıcı yalnız "ayarım geri geldi" görür ve ürüne
// güvenmez.
//
// Bu yüzden doküman kendi içinde bir LWW-REGISTER MAP'tir: her anahtar kendi
// damgasını (`at`) ve yazan cihazını (`dev`) taşır. Motor hangi baytı indirirse
// indirsin, `merge()` iki tarafın anahtarlarını AYRI AYRI karşılaştırır ve
// birleşimi üretir. Birleşim her iki taraftan da farklı olabilir — o zaman bir
// sonraki push turu onu yükler ve iki cihaz AYNI dokümanda buluşur.
//
// ⚠️ BU BİR CRDT DEĞİLDİR: kütüphane yok, geçmiş yok, tek seviye. SYNC-R1'in
// elediği şey BELGE İÇİ METİN birleştirmesiydi; 40 anahtarlık bir sözlükte
// LWW-register map doğru araçtır.
//
// ─────────────────────────────────────────────────────────────────────────────
// DETERMİNİSTİK SERİLEŞTİRME — NEDEN ZORUNLU
// ─────────────────────────────────────────────────────────────────────────────
// Senkronun eko kapısı SHA-256 karşılaştırmasıdır. Aynı içerik iki cihazda farklı
// anahtar sırasıyla yazılırsa sha'lar ayrışır ve iki cihaz birbirine SONSUZA DEK
// aynı içeriği iter (ping-pong). `serialize()` anahtarları leksikografik sıralar
// (iç içe nesneler dâhil) ve sabit girinti kullanır: aynı içerik ⇒ aynı bayt.
//
// SAF MODÜL — fs YOK, Electron YOK, `Date.now()` YOK (damga ENJEKTE edilir).

'use strict';

const W = require('./prefsWhitelist.cjs');

const SCHEMA_VERSION = 1;

/** Doküman tavanı — DB satır içi gövde tavanının (256 KB) çok altında. */
const MAX_DOC_BYTES = 128 * 1024;

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Boş doküman. */
function emptyDoc() {
  return { schemaVersion: SCHEMA_VERSION, keys: {} };
}

/**
 * Anahtarları sıralayarak JSON'a çevir — nesnelerin İÇİ de sıralanır.
 * `JSON.stringify(v, replacerYok, 2)` sırayı ekleme sırasından alır; bu fonksiyon
 * onu içerikten alır.
 */
function sortValue(v) {
  if (Array.isArray(v)) return v.map(sortValue); // dizide SIRA VERİDİR, dokunulmaz
  if (isObj(v)) {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortValue(v[k]);
    return out;
  }
  return v;
}

/** Doküman → DETERMİNİSTİK utf8 metin (sonda tek `\n`). */
function serialize(doc) {
  const keys = isObj(doc && doc.keys) ? doc.keys : {};
  const out = { schemaVersion: SCHEMA_VERSION, keys: {} };
  for (const k of Object.keys(keys).sort()) {
    const e = keys[k];
    if (!isObj(e)) continue;
    // Alan sırası da SABİT: v → at → dev.
    const rec = { v: sortValue(e.v === undefined ? null : e.v), at: String(e.at || '') };
    if (e.dev) rec.dev = String(e.dev);
    out.keys[k] = rec;
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** ISO damgası geçerli mi? (bozuk damga = "en eski" sayılır, atılmaz) */
function stampMs(at) {
  const t = Date.parse(String(at || ''));
  return Number.isFinite(t) ? t : 0;
}

/**
 * HAM metin/nesne → doküman. ASLA FIRLATMAZ.
 *
 * İki biçimi kabul eder:
 *   1. v1 damgalı  — `{schemaVersion:1, keys:{k:{v,at,dev}}}`
 *   2. DÜZ ESKİ    — `{"onboarding.progress": {...}}` (TOUR-02-A/C'nin yazdığı ilk
 *      biçim; SYNC-F1-7'den ÖNCE diskte olabilir). Damgasız geldiği için `at`
 *      EPOCH kabul edilir: damgalı HER yazım onu yener, yani göç kimseyi ezmez.
 *
 * Beyaz liste DIŞI anahtarlar burada DÜŞÜRÜLÜR — uzaktan gelen bir doküman
 * tanımadığımız bir anahtarla settings.json'a dokunamaz.
 *
 * @returns {{doc:object, dropped:string[], legacy:boolean}}
 */
function parse(raw) {
  let obj = raw;
  if (typeof raw === 'string' || Buffer.isBuffer(raw)) {
    try { obj = JSON.parse(String(raw)); } catch { return { doc: emptyDoc(), dropped: [], legacy: false }; }
  }
  if (!isObj(obj)) return { doc: emptyDoc(), dropped: [], legacy: false };

  const dropped = [];
  const doc = emptyDoc();

  const put = (key, value, at, dev) => {
    const verdict = W.admit(key, value);
    if (!verdict.ok) { dropped.push(`${key}:${verdict.reason}`); return; }
    doc.keys[key] = { v: value, at: at || new Date(0).toISOString(), dev: dev || null };
  };

  if (isObj(obj.keys) && Number(obj.schemaVersion) === SCHEMA_VERSION) {
    for (const key of Object.keys(obj.keys)) {
      const e = obj.keys[key];
      if (!isObj(e)) { dropped.push(`${key}:bad-entry`); continue; }
      put(key, e.v, typeof e.at === 'string' ? e.at : null, typeof e.dev === 'string' ? e.dev : null);
    }
    return { doc, dropped, legacy: false };
  }

  // DÜZ ESKİ biçim.
  for (const key of Object.keys(obj)) {
    if (key === 'schemaVersion' || key === 'keys') continue;
    put(key, obj[key], new Date(0).toISOString(), null);
  }
  return { doc, dropped, legacy: true };
}

/**
 * ANAHTAR-SEVİYESİ LWW — iki dokümanı birleştir.
 *
 * Determinizm (§3.1 ile AYNI ölçüt zinciri): geç damga kazanır → eşitse `dev`
 * leksikografik BÜYÜK olan → o da eşitse serileşmiş değer leksikografik büyük
 * olan. Üçüncü ölçüt olmadan `dev`i null olan iki kayıt (eski biçimden göç)
 * cihaza göre farklı sonuç verirdi.
 *
 * KOMÜTATİF + İDEMPOTENT: merge(a,b) ≡ merge(b,a) ve merge(a,a) ≡ a.
 *
 * @returns {{doc:object, changed:string[]}} `changed` = `a`ya göre değişen anahtarlar
 */
function merge(a, b) {
  const ka = isObj(a && a.keys) ? a.keys : {};
  const kb = isObj(b && b.keys) ? b.keys : {};
  const out = emptyDoc();
  const changed = [];
  for (const key of new Set([...Object.keys(ka), ...Object.keys(kb)])) {
    const ea = ka[key];
    const eb = kb[key];
    let win;
    if (!ea) win = eb;
    else if (!eb) win = ea;
    else {
      const ta = stampMs(ea.at);
      const tb = stampMs(eb.at);
      if (ta !== tb) win = ta > tb ? ea : eb;
      else {
        const da = String(ea.dev || '');
        const db = String(eb.dev || '');
        if (da !== db) win = da > db ? ea : eb;
        else {
          const va = JSON.stringify(sortValue(ea.v));
          const vb = JSON.stringify(sortValue(eb.v));
          win = va >= vb ? ea : eb;
        }
      }
    }
    out.keys[key] = { v: win.v, at: win.at, dev: win.dev || null };
    if (!ea || JSON.stringify(sortValue(ea.v)) !== JSON.stringify(sortValue(win.v))) changed.push(key);
  }
  changed.sort();
  return { doc: out, changed };
}

/**
 * Yerel değerleri dokümana DAMGALA.
 *
 * Yalnız DEĞERİ DEĞİŞEN anahtar yeni damga alır — değişmeyene dokunulmazsa
 * projeksiyon İDEMPOTENT olur (aynı ayarla ikinci çağrı aynı baytı üretir).
 * Aksi hâlde her açılış tüm anahtarları "şimdi" damgalar ve iki cihaz arasında
 * anlamsız bir damga yarışı başlardı — üstelik uzaktan gelen TAZE bir değeri
 * yerel BAYAT değer ezerdi.
 *
 * @param {object} doc      mevcut doküman (mutasyona uğramaz)
 * @param {object} values   `{anahtar: değer}` — beyaz liste dışı olanlar düşer
 * @param {{at:string, dev?:string|null, absent?:string[]}} opts
 *   `absent` — kaynakta ARTIK OLMAYAN anahtarlar (silme değil: dokunulmaz;
 *   bkz. aşağıdaki not).
 * @returns {{doc:object, changed:string[], dropped:string[]}}
 */
function stamp(doc, values, opts = {}) {
  const base = parse(doc).doc;
  const at = String(opts.at || new Date(0).toISOString());
  const dev = opts.dev || null;
  const changed = [];
  const dropped = [];
  for (const key of Object.keys(values || {})) {
    const value = values[key];
    const verdict = W.admit(key, value);
    if (!verdict.ok) { dropped.push(`${key}:${verdict.reason}`); continue; }
    const cur = base.keys[key];
    if (cur && JSON.stringify(sortValue(cur.v)) === JSON.stringify(sortValue(value))) continue;
    base.keys[key] = { v: value, at, dev };
    changed.push(key);
  }
  // NOT — SİLME YOK. Bir tercih "kaynakta yok" ise bu çoğu zaman "varsayılana
  // döndü" değil "bu cihaz o özelliği hiç açmadı" demektir (ör. renderer henüz
  // yüklenmedi ⇒ localStorage anahtarları BOŞ gelir). Silme kanalı açsaydık, bir
  // cihazın açılış anındaki eksik durumu diğer cihazın tercihlerini SİLERDİ.
  changed.sort();
  return { doc: base, changed, dropped };
}

/** Doküman → `{anahtar: değer}` düz görünüm (uygulama tarafı bunu okur). */
function values(doc) {
  const keys = isObj(doc && doc.keys) ? doc.keys : {};
  const out = {};
  for (const k of Object.keys(keys).sort()) out[k] = keys[k].v;
  return out;
}

module.exports = {
  SCHEMA_VERSION,
  MAX_DOC_BYTES,
  emptyDoc,
  serialize,
  parse,
  merge,
  stamp,
  values,
  sortValue,
  stampMs,
};
