// ADP-854 (Wheeljack) — VARLIK ÇÖZÜMLEME: konuşulan hedef → GERÇEK ajan / rol / rapor.
//
// Kök sorun (görev §4-§6): kural yolu hedefi "kim" diye HİÇ sormuyordu.
//   • "Reis'e söyle …"           → ad yakalanmıyordu; cümle DELEGATE_RE'ye ("söyle")
//     takılıp TAKIMA gidiyordu → iş BAŞKA ajana düşüyordu ya da "böyle ajan yok".
//   • "frontendçi bir ajana ver" → rol diye bir kavram YOKTU (aliases'ta `role` alanı
//     bile taşınmıyordu).
//   • "854 raporunu aç"          → id deseni `ADP-` öneki ŞART koşuyordu; çıplak numara
//     hiç yakalanmıyor, karar "en son rapor"a düşüyordu (sessizce YANLIŞ rapor).
//
// KURALLAR (görev §4)
//   1. Çözümleme KULLANICININ GERÇEK ÇALIŞAN LİSTESİNDEN yapılır (context.aliases) —
//      kodda sabit ajan adı YOK ([[feedback_no_hardcoded_brand_cases]] disiplini).
//   2. Yakın eşleşme KABUL (STT harf düşürür: "wheeljak" → wheeljack).
//   3. BULAMAZSA UYDURUP BAŞKASINA VERME: `unresolvedName` / `unresolvedRole` döner,
//      çağıran SORAR. Sessizce başka ajana yönlendirmek bu görevin ana şikâyetiydi.
//
// Saf + bağımlılıksız (yalnız turkishMorph) → `node --test` ile doğrudan koşar.
//
// ADP-885/st1 — i18n-exempt: intent-token. Buradaki Türkçe desenler ARAYÜZ METNİ
// DEĞİLDİR (kullanıcının söylediği hedef ifadesi). Kelimeler `intentLexicon.cjs`te.

'use strict';

const morph = require('../voice/turkishMorph.cjs');
const { ROLE_LEXICON, NOT_A_NAME_WORDS, TARGETING_VERB_STEMS } = require('../agents/intentLexicon.cjs');

// ── Rol sözlüğü ─────────────────────────────────────────────────────────────
//
// Konuşulan rol kelimesi → `agents.role` slug'ı (globalRoleCatalog + agentIdentity
// ROLE_LABELS ile aynı evren). Tek kelimelik girdiler İSİM ÇEKİMİYLE eşleşir
// (hasNoun); boşluklu girdiler ("test mühendisi") düz alt-dize ile — çok kelimeli
// öbek zaten yeterince ayırt edici.
// ADP-885/st1: kelime kümesinin kendisi `intentLexicon.cjs::ROLE_LEXICON`ta.

/**
 * Cümlede geçen rol slug'ı (yoksa null). İLK eşleşen kazanır; çok kelimeli öbekler
 * ÖNCE denenir ("takım lideri" → 'lead', tek başına "lider"den daha spesifik).
 */
function detectRoleSlug(text) {
  const low = morph.trLower(text);
  const toks = morph.tokens(low);
  for (const r of ROLE_LEXICON) {
    for (const p of r.phrases || []) {
      if (p && low.includes(p)) return r.slug;
    }
  }
  for (const r of ROLE_LEXICON) {
    if ((r.words || []).length && morph.hasNoun(toks, r.words)) return r.slug;
  }
  return null;
}

/** Aynı slug ailesine düşen ham roller ('skool-lead' → lead gibi). */
function roleMatches(agentRole, slug) {
  const raw = morph.trLower(agentRole || '').trim();
  if (!raw) return false;
  if (raw === slug) return true;
  if (slug === 'lead') return raw === 'ceo' || raw === 'orchestrator' || raw.endsWith('-lead');
  if (slug === 'qa') return raw === 'code-review';
  if (slug === 'frontend') return raw === 'storebuilder-frontend';
  if (slug === 'rnd') return raw === 'explorer' && false; // rnd ≠ explorer — ayrı roller
  return false;
}

// ── Ad çözümleme ────────────────────────────────────────────────────────────

/**
 * Kesme işaretli YÖNELME hâli — "Reis'e", "Jazz'a", "Zorbotron'a".
 * YALNIZ yönelme (-e/-a/-ye/-ya/-na/-ne): "branch'teki" (bulunma) ya da "ADP-854'ün"
 * (tamlayan) ajan adı DEĞİLDİR ve bunları hedef sanmak yanlış soru sordururdu.
 */
const DATIVE_NAME_RE = /([a-zçğıöşüA-ZÇĞİÖŞÜ]{3,})['’](?:y?[ae]|n[ae])(?=\s|$|[,.!?;:])/gu;

/** Ajan adı OLMADIĞI kesin olan, kesme işaretiyle çekimlenen sık kelimeler. */
const NOT_A_NAME = new Set(NOT_A_NAME_WORDS);

/**
 * Konuşulan hedefi çöz.
 *
 * @param {string} text
 * @param {{aliases?:Array<{match?:string,id?:string,department?:string,role?:string}>}} context
 * @returns {{
 *   id: string|null,
 *   department: string|null,
 *   via: 'id'|'name'|'fuzzy'|'role'|null,
 *   unresolvedName: string|null,
 *   unresolvedRole: string|null,
 * }}
 *
 * Sıra: TAM ad/id → YAKIN ad (mesafe ≤1) → ROL → çözülemeyen ad adayı.
 */
function resolveAgent(text, context = {}) {
  const aliases = Array.isArray(context.aliases) ? context.aliases : [];
  const toks = morph.tokens(text);
  const tokSet = new Set(toks);
  const none = { id: null, department: null, via: null, unresolvedName: null, unresolvedRole: null };

  const hit = (a, via) => ({
    id: a.id || a.match,
    department: a.department || null,
    via,
    unresolvedName: null,
    unresolvedRole: null,
  });

  // 1) TAM eşleşme — ad ya da id, jeton düzeyinde (kesme işareti zaten ayırıcı).
  for (const a of aliases) {
    if (!a) continue;
    const name = morph.trLower(a.match || '');
    const id = morph.trLower(a.id || '');
    if (name.length > 2 && tokSet.has(name)) return hit(a, 'name');
    if (id.length > 2 && tokSet.has(id)) return hit(a, 'id');
    // Çok kelimeli görünen ad ("black widow") — öbek olarak ara.
    if (name.includes(' ') && morph.trLower(text).includes(name)) return hit(a, 'name');
  }

  // 2) YAKIN eşleşme — STT bir harf düşürür/karıştırır ("wheeljak", "bamblbi").
  //    Kısa adlarda kapatılır (4 harf altı ad ≠ 1 mesafe: "jazz"/"jass" ayırt edilemez
  //    ama "reis"/"leis" gibi başka bir ajanla çakışma riski doğar → uzunluk kapısı).
  let best = null;
  for (const a of aliases) {
    if (!a) continue;
    const name = morph.trLower(a.match || '');
    if (name.length < 5 || name.includes(' ')) continue;
    for (const t of toks) {
      if (t.length < 4) continue;
      const d = morph.editDistance(t, name, 1);
      if (d <= 1 && (!best || d < best.d)) best = { a, d };
    }
  }
  if (best) return hit(best.a, 'fuzzy');

  // 3) ROL — "frontendçi bir ajana ver". Rosterde o rolde biri var mı?
  const slug = detectRoleSlug(text);
  if (slug) {
    const inRole = aliases.filter((a) => a && roleMatches(a.role, slug));
    if (inRole.length) {
      // Aynı roldeki birden çok ajan: aktif departman önceliklidir (kullanıcı
      // baktığı takımı kasteder), yoksa ilk sıradaki.
      const dep = context.defaultDepartment || null;
      const preferred = inRole.find((a) => a.department === dep) || inRole[0];
      return hit(preferred, 'role');
    }
    return { ...none, unresolvedRole: slug };
  }

  // 4) Ad gibi duran ama rosterde OLMAYAN bir hedef var mı? (UYDURMA — SOR.)
  //    Yalnız YÖNELME hâli + hedefleme fiili birlikteyse: "Zorbotron'a söyle …".
  if (morph.hasVerb(toks, TARGETING_VERB_STEMS)) {
    const low = morph.trLower(text);
    DATIVE_NAME_RE.lastIndex = 0;
    let m;
    while ((m = DATIVE_NAME_RE.exec(low)) !== null) {
      const cand = morph.trLower(m[1]);
      if (NOT_A_NAME.has(cand)) continue;
      if (/^\d+$/.test(cand)) continue;
      return { ...none, unresolvedName: cand };
    }
  }

  return none;
}

// ── Rapor / görev id çözümleme ──────────────────────────────────────────────

/** Tam biçimli id: "ADP-854", "TASK-MSBRR4ZK5SXI2", "CF-007". */
const FULL_ID_RE = /\b((?:TASK|ADP|CF|AD)-[A-Z0-9]+(?:-[A-Z0-9]+)*)\b/i;
/** Çıplak numara: "854 raporunu aç" — YALNIZ rapor/görev bağlamında sorulur. */
const BARE_NUM_RE = /\b(\d{2,6})\b/;

/**
 * Konuşulan görev/rapor referansı. `allowBare` YALNIZ cümlede rapor/görev ipucu
 * varken açılır — aksi hâlde "5 codex aç" cümlesindeki 5'i id sanardık.
 *
 * @returns {string|null}  ham referans (ÖNEK olabilir: "ADP-85", "854")
 */
function parseTaskRef(text, { allowBare = false } = {}) {
  const raw = String(text || '');
  const full = raw.match(FULL_ID_RE);
  if (full) return full[1].toUpperCase();
  if (allowBare) {
    const bare = raw.match(BARE_NUM_RE);
    if (bare) return bare[1];
  }
  return null;
}

/**
 * Dosya listesinden referansa uyan raporları seç (ÖNEK/KISMİ eşleşme — görev §6).
 *
 * Sıra: (1) tam id eşleşmesi · (2) id-parçası olarak ÖNEK · (3) düz alt-dize.
 * Dönen dizi 1'den uzunsa çağıran ADAYLARI LİSTELER — sessizce ilkini açmak
 * "yanlış raporu açtı" şikâyetinin ta kendisiydi.
 *
 * @param {Array<{name:string, path?:string}>} files
 * @param {string|null} ref
 * @returns {Array<{name:string, path?:string}>}
 */
function matchReports(files, ref) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  if (!ref) return list;
  const needle = morph.trLower(ref);
  // Dosya adındaki id parçalarını çıkar: "ADP-854-wheeljack.md" → ['adp','854','wheeljack','md']
  const partsOf = (name) => morph.trLower(name).split(/[^a-zçğıöşü0-9]+/).filter(Boolean);
  const needleParts = needle.split(/[^a-zçğıöşü0-9]+/).filter(Boolean);

  const exact = list.filter((f) => {
    const p = partsOf(f.name);
    return needleParts.every((np, i) => p[i] === np);
  });
  if (exact.length) return exact;

  const prefixed = list.filter((f) => {
    const p = partsOf(f.name);
    return needleParts.every((np, i) => (p[i] || '').startsWith(np));
  });
  if (prefixed.length) return prefixed;

  return list.filter((f) => morph.trLower(f.name).includes(needle));
}

module.exports = {
  ROLE_LEXICON,
  detectRoleSlug,
  roleMatches,
  resolveAgent,
  parseTaskRef,
  matchReports,
  FULL_ID_RE,
  BARE_NUM_RE,
  NOT_A_NAME,
  TARGETING_VERB_STEMS,
};
