// CrewPane — SK-05 (ADR-SKILL-CENTER Karar 2) KULLANICININ YAZMA UCU: yeni skill
// oluştur + mevcut skilli düzenle. Her iki fiil de TASLAĞA yazar.
//
// Bu modül SK-02'nin depo mantığını YENİDEN YAZMAZ; SK-04'ün (skillApprove.cjs)
// deseninin yazma-tarafı kardeşidir — sırayı kurar, kararı SK-02'ye verir:
//
//   skillStore.readSkill   → ad boşta mı / düzenlenen kayıt ne diyor
//   skillStore.writeDraft  → lint + kanonik SKILL.md + atomik yazım  (TEK yazma yolu)
//
// 🔑 NEDEN "HER ŞEY TASLAĞA": onay kapısı DİZİNDİR (ADR §3) — `skills/`e yazan bir API
// yok ve SK-05 de bir tane AÇMAZ. Kullanıcı yayındaki bir skilli düzenlediğinde bile
// sonuç bir TASLAKTIR; yayındaki metin, SK-04'ün onay kartından geçilene kadar diskte
// AYNEN durur ve motorlar eskisini görmeye devam eder. Bu bilerek böyle: "düzenle →
// anında canlı" olsaydı, bir yazım hatası bütün ajanların bağlamına onaysız inerdi.
//
// 🪤 SESSİZ SLUG YOK: `skillFormat.safeName('')` → 'unnamed-skill' döner (kütüphane
// için doğru bir varsayılan, kullanıcı formu için TUZAK — boş ad "unnamed-skill" adlı
// bir skill doğururdu). Bu yüzden ad BURADA açıkça doğrulanır ve boş/geçersizse hata
// döner; düzeltme önerisi (`suggestion`) cevaba konur ki hata bir çıkmaz olmasın.
//
// fs'e doğrudan dokunmaz (çağrılan modüller üzerinden) — unit test tmp dizinle koşar.

// ── SK-08 — BU MODÜL ARTIK **TEK YAZMA BOĞAZI** ──────────────────────────────
//
// SK-06 ölçüldü: `skillStore.writeDraft`in İKİ çağıranı vardı — bu modül (kullanıcı)
// ve `skillSuggest.cjs` (AI/hafıza). İkisi de doğru dizine yazıyordu, yani bu bir
// güvenlik açığı DEĞİLDİ; ama "her yazımda çalışması gereken" bir kural eklendiğinde
// (SK-08'de sır taraması) o kuralı İKİ yere koymak gerekiyordu ve ikincisini unutmak
// sessizce mümkündü. Bir kapı iki kapıdan güvenlidir: `skillSuggest` artık buradan
// geçer, `writeDraft`in tek çağıranı bu dosyadır (nöbetçi: skillGuard.scanWritePaths).
//
// 🔴 BOĞAZIN UYGULADIĞI DEĞİŞMEZLER (çağıran kim olursa olsun):
//   1. Yayın damgaları (`reviewedBy`/`reviewedAt`) HER ZAMAN düşürülür — bir taslak
//      kendini "onaylanmış" ilan edemez.
//   2. `crewpane.status` taslağa çivilenir (`writeDraft` de ayrıca çiviler).
//   3. SIR TARAMASI — bulgu varsa DİSKE HİÇ YAZILMAZ (SK-08 (b)/(c)).
// Değişmezler burada olduğu için AI yolu, kullanıcı yolu ve içe aktarım yolu üçü de
// aynı güvenceyi alır; yeni bir yazma ucu eklemek onları atlamayı GEREKTİRMEZ.

'use strict';

const F = require('./skillFormat.cjs');
const skillStore = require('./skillStore.cjs');
const secretScan = require('./skillSecretScan.cjs');

// Bir taslağa TAŞINAMAYAN damgalar: bunlar YAYIN kayıtlarıdır ("şu insan, şu tarihte
// onayladı"). Düzenlenmiş bir metne kopyalanırlarsa taslak, hiç incelenmemiş bir
// içerik için onaylanmış görünürdü — damga kanıttır, kopyalanamaz.
const REVIEW_STAMPS = Object.freeze(['crewpane.reviewedBy', 'crewpane.reviewedAt']);

/** Taslak metadata'sının ASLA taşıyamayacağı anahtarlar (damgalar + statü iddiası). */
const FORBIDDEN_META = Object.freeze([...REVIEW_STAMPS, 'crewpane.status']);

/**
 * Kullanıcının yazdığı adı doğrula. Slug'lamayı SESSİZCE yapmaz: girdi zaten geçerli
 * bir slug değilse hata + öneri döner.
 * @returns {{ok:true, slug:string} | {ok:false, code:string, message:string, suggestion?:string}}
 */
function validateName(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return { ok: false, code: 'name-empty', message: 'Ad zorunlu' };
  const slug = F.safeName(s);
  if (s.toLowerCase() !== slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)) {
    return {
      ok: false,
      code: 'name-invalid',
      message: `Ad yalnız küçük harf, rakam ve tire içerebilir (önerilen: ${slug})`,
      suggestion: slug,
    };
  }
  if (s.length > F.LIMITS.NAME_MAX) {
    return { ok: false, code: 'name-too-long', message: `Ad ≤ ${F.LIMITS.NAME_MAX} karakter olmalı`, suggestion: slug };
  }
  return { ok: true, slug };
}

function err(code, message, extra) {
  return { ok: false, errors: [{ code, message, ...(extra || {}) }], warnings: [] };
}

/** Var olan bir kaydın metadata'sı → taslağa taşınabilir hâli (yayın damgaları düşer). */
function carryMetadata(rec) {
  const src = (rec && rec.frontmatter && typeof rec.frontmatter.metadata === 'object' && rec.frontmatter.metadata) || {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (REVIEW_STAMPS.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * TASLAK KAYDET — "Yeni Skill" formunun ve "Düzenle"nin tek ucu.
 *
 * @param {object}  o
 * @param {string}  o.workspaceRoot
 * @param {string}  o.name          kullanıcının yazdığı ad (slug olmak ZORUNDA)
 * @param {string}  o.description   bir satır — motor skilli BUNA bakarak seçer
 * @param {string}  o.body          SKILL.md gövdesi (markdown)
 * @param {'create'|'update'} o.mode
 * @param {string} [o.author]       YAZAN — çağıran süreçte ölçülür (renderer'a güvenilmez)
 * @returns {{ok:boolean, name?:string, file?:string, dir?:string, scope?:'draft',
 *            forkedFromPublished?:boolean, errors:Array, warnings:Array}}
 *
 * @param {object} [o.metadata]     SK-08 — çağıranın taşımak istediği metadata (AI yolu
 *                                 origin/task/trigger/rationale/sourceMemory yazar).
 *                                 Yasaklı anahtarlar (damgalar + statü) SÜZÜLÜR.
 * @param {string} [o.origin]      'user' | 'ai' | 'imported' — provenans (yalnız YOKSA yazılır)
 *
 * mode='create' → ad İKİ kapsamda da boş olmalı (aynı ada iki skill = motor tarafında
 *                 hangisinin yükleneceği belirsiz; sessiz üzerine yazma YOK).
 * mode='update' → taslak varsa üzerine yazılır (düzenleme budur); taslak yok ama YAYIN
 *                 varsa yayından bir TASLAK çatallanır (yayındaki dosyaya DOKUNULMAZ);
 *                 ikisi de yoksa hata.
 */
function saveDraft({ workspaceRoot, name, description, body, mode = 'create', author, metadata: extraMeta, origin } = {}) {
  if (!skillStore.draftsRoot(workspaceRoot)) {
    return err('no-workspace', 'Çalışma alanı seçili değil');
  }
  if (mode !== 'create' && mode !== 'update') {
    return err('bad-mode', `Bilinmeyen kip: ${mode}`);
  }

  const v = validateName(name);
  if (!v.ok) return err(v.code, v.message, v.suggestion ? { suggestion: v.suggestion } : null);
  const slug = v.slug;

  const draft = skillStore.readSkill(workspaceRoot, slug, 'draft');
  const published = skillStore.readSkill(workspaceRoot, slug, 'published');

  let base = null; // metadata'sı devralınacak kayıt
  let forkedFromPublished = false;

  if (mode === 'create') {
    if (draft) return err('name-taken', `Bu adla bir taslak zaten var: ${slug}`, { scope: 'draft' });
    if (published) return err('name-taken', `Bu adla yayında bir skill zaten var: ${slug}`, { scope: 'published' });
  } else {
    if (draft) base = draft;
    else if (published) {
      base = published;
      forkedFromPublished = true;
    } else {
      return err('skill-missing', `Düzenlenecek skill yok: ${slug}`);
    }
  }

  const metadata = carryMetadata(base);
  // SK-08 — çağıranın metadata'sı: yasaklı anahtarlar SÜZÜLEREK girer. Bir ajan
  // `crewpane.status: published` ya da sahte bir `reviewedBy` yazmayı denerse burada
  // sessizce düşer (hata değil — taslak yine yazılır, yalnız YALAN yazılmaz).
  if (extraMeta && typeof extraMeta === 'object') {
    for (const [k, v] of Object.entries(extraMeta)) {
      if (FORBIDDEN_META.includes(k)) continue;
      if (v === undefined || v === null || v === '') continue;
      metadata[k] = v;
    }
  }
  // Köken/yazan: yalnız YOKSA yazılır. Bir ajanın yazdığı taslağı kullanıcı düzenlese
  // bile "bunu AI yazdı" provenansı silinmez (rozet bir tarih kaydıdır, sahiplik değil).
  if (!metadata['crewpane.origin']) metadata['crewpane.origin'] = origin || 'user';
  if (!metadata['crewpane.author'] && author) metadata['crewpane.author'] = String(author);

  // ── SK-08 (b)/(c) — SIR TARAMASI, YAZMADAN ÖNCE ────────────────────────────
  // Neden taslakta da (yalnız yayında değil): SK-07'nin terfi yolu bir hafıza faktını
  // OKUYUP skille KOPYALAR. Kopya diske indiği an sızıntı gerçekleşmiştir — yayın
  // kapısını beklemek "bir jetonu bir dosyaya yazdık ama henüz yayınlamadık" demektir.
  // `sourceMemory` dahil TÜM metadata alanları taranır (SK-07 takip maddesi (c)).
  const scan = secretScan.scanSkillRecord({
    description,
    license: (base && base.frontmatter && base.frontmatter.license) || undefined,
    metadata,
    body,
  });
  if (!scan.ok) return { ok: false, errors: secretScan.toErrors(scan), warnings: [] };

  const res = skillStore.writeDraft(workspaceRoot, {
    name: slug,
    description,
    body,
    license: (base && base.frontmatter && base.frontmatter.license) || undefined,
    metadata,
  });
  if (!res.ok) return { ok: false, errors: res.errors || [], warnings: res.warnings || [] };

  const warnings = (res.warnings || []).slice();
  // 🪤 SK-02'nin `writeDraft`i `compatibility` alanını almıyor → çatallanan bir kayıtta
  // o alan DÜŞER. Sessiz veri kaybı olmasın diye SÖYLENİR (SK-02'ye dokunmadan).
  if (base && base.frontmatter && base.frontmatter.compatibility) {
    warnings.push({
      code: 'compatibility-dropped',
      message: '`compatibility` alanı taslağa taşınmadı — gerekiyorsa SKILL.md üzerinde elle ekle',
    });
  }

  return {
    ok: true,
    name: res.name,
    dir: res.dir,
    file: res.file,
    scope: 'draft',
    forkedFromPublished,
    errors: [],
    warnings,
  };
}

module.exports = { REVIEW_STAMPS, FORBIDDEN_META, validateName, carryMetadata, saveDraft };
