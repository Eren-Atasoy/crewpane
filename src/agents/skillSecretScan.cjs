// CrewPane — SK-08 (ADR-SKILL-CENTER §7.2 T3) YAYIN KAPISINDA SIR TARAMASI.
//
// Bu modül yeni bir dedektör YAZMAZ: ADP-862'nin `memorySecretMask.cjs`ini yeniden
// kullanır (aynı desen kümesi, aynı yanlış-pozitif dengesi). SK-08'in eklediği tek şey
// **NEREYE bakıldığıdır** — ve orası SK-06/SK-07'nin bıraktığı iki takip maddesidir:
//
//   (b) SK-06 → yayın kapısına sır taraması eklensin.
//   (c) SK-07 → `crewpane.sourceMemory` de kapsama girsin: bir hafıza faktı sır
//       taşıyorsa terfi onu skille KOPYALAMASIN.
//
// 🔑 NEDEN GÖVDE TARAMASI TEK BAŞINA YETMİYOR: SK-07'nin terfi yolu bir hafıza faktını
// okuyup gövdeye indiriyor; oradaki bir jeton gövde taramasıyla yakalanır. Ama aynı yol
// faktın ADINI/YOLUNU `metadata.crewpane.sourceMemory` alanına da yazıyor ve ajanlar
// `rationale`/`description` alanlarına serbest metin koyabiliyor. Frontmatter, gövdeden
// daha az göze batan ama AYNI dosyada duran bir yüzeydir — skill git'e girer ve paylaşılır
// (SK-08 dışa aktarım). Bu yüzden tarama ALAN ALAN yapılır ve bulgu alanın ADIYLA döner:
// "sır var" demek yetmez, insan NEREDE olduğunu görmeden düzeltemez.
//
// ⚠️ İKİ YANLIŞ EŞİT MALİYETLİ DEĞİL (memorySecretMask'in kurduğu denge burada da geçerli):
// bir jetonu yayınlamak KALICI bir sızıntıdır (skill tüm ajanların bağlamına girer ve
// dosya paylaşılır); sıradan bir dizeyi "sır" sanmak yalnız bir yayını geciktirir ve
// insan bunu bir tıkla görüp düzeltir. Bu yüzden kapı SERT: bulgu varsa yayın YOK.
//
// SAF: fs YOK, Electron YOK → `node --test` ile koşar; main, CLI ve terfi yolu aynı fiili çağırır.

'use strict';

const F = require('./skillFormat.cjs');
const mask = require('../memory/memorySecretMask.cjs');

/** Taranan alanların insan-okur adları (bulgu mesajı bunu taşır). */
const FIELD_LABELS = Object.freeze({
  description: 'description',
  body: 'gövde',
  license: 'license',
  compatibility: 'compatibility',
});

/**
 * Tek bir alanı tara. Saf.
 * @returns {{field:string, kinds:string[], count:number, counts:Object<string,number>}|null}
 *   temizse null. `counts` = sınıf bazında adet (SEC-W2-A4 paket kapısı bunu toplar).
 */
function scanField(field, value) {
  if (typeof value !== 'string' || !value) return null;
  const r = mask.maskSecretsDetailed(value);
  if (!r.masked) return null;
  return { field, label: FIELD_LABELS[field] || field, kinds: r.kinds, count: r.masked, counts: r.counts };
}

/**
 * Bir skill KAYDINI tara (dosyaya bakmadan — çağıran metni/alanları verir).
 *
 * Taranan yüzeyler:
 *   • description        — motorun skilli seçerken okuduğu satır
 *   • license / compatibility — serbest metin alanları
 *   • metadata.*         — TÜM değerler; `crewpane.sourceMemory` dahil (SK-07 takip maddesi)
 *   • body               — yordamın kendisi
 *
 * @returns {{ok:boolean, findings:Array, total:number, fields:string[]}}
 *   `ok:false` → yayın/terfi YAPILMAZ. Bulgular DEĞERİ taşımaz (yalnız alan + tür + adet):
 *   sızıntıyı raporlayan bir raporun kendisi sızıntı olamaz.
 */
function scanSkillRecord({ description, license, compatibility, metadata, body } = {}) {
  const findings = [];
  for (const [field, value] of [
    ['description', description],
    ['license', license],
    ['compatibility', compatibility],
  ]) {
    const f = scanField(field, value);
    if (f) findings.push(f);
  }

  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  for (const [k, v] of Object.entries(meta)) {
    // Alan adı bulguya AYNEN girer → "sourceMemory'de sır var" cümlesi kurulabilsin.
    const f = scanField(`metadata.${k}`, typeof v === 'string' ? v : v == null ? '' : String(v));
    if (f) findings.push(f);
  }

  const f = scanField('body', body);
  if (f) findings.push(f);

  return {
    ok: findings.length === 0,
    findings,
    total: findings.reduce((n, x) => n + x.count, 0),
    fields: findings.map((x) => x.field),
  };
}

/**
 * Ham SKILL.md metnini tara (dosyadan okunmuş hâli).
 * Ayrıştırma kırıksa bile TARAMA YAPILIR: bozuk frontmatter, sızıntıyı görmezden gelmenin
 * gerekçesi olamaz — metnin tamamı gövde sayılıp taranır (sessiz geçiş YOK).
 */
function scanSkillText(text) {
  const parsed = F.parseSkillMd(typeof text === 'string' ? text : '');
  const fm = parsed.frontmatter || {};
  if (!parsed.ok && !Object.keys(fm).length) {
    const f = scanField('body', String(text || ''));
    return { ok: !f, findings: f ? [f] : [], total: f ? f.count : 0, fields: f ? ['body'] : [] };
  }
  return scanSkillRecord({
    description: fm.description,
    license: fm.license,
    compatibility: fm.compatibility,
    metadata: fm.metadata,
    body: parsed.body,
  });
}

/** Bulguları kapı hatasına çevir (skillStore'un `errors` sözleşmesiyle aynı şekil). */
function toErrors(scan) {
  if (!scan || scan.ok) return [];
  return scan.findings.map((f) => ({
    code: 'secret-detected',
    field: f.field,
    kinds: f.kinds,
    count: f.count,
    message: `Sır benzeri değer: \`${f.label}\` (${f.kinds.join(', ')}, ${f.count} adet) — yayın/terfi durduruldu, önce kaldır`,
  }));
}

module.exports = { FIELD_LABELS, scanField, scanSkillRecord, scanSkillText, toErrors };
