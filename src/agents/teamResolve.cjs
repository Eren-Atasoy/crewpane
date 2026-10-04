// TEAM-CASE-01 — TAKIM ADI ÇÖZÜMLEMESİ: bir insanın/ajanın yazdığı `department`
// metnini O TAKIMIN kanonik kapsam anahtarına (`teams.wing_slug || teams.slug`,
// ADP-482) çeviren TEK yer.
//
// MÜŞTERİ ARIZASI (12.09, Instagram): kullanıcı takımına GÖRÜNEN AD veriyor
// ("Ornek Takim" gibi baş harfi büyük bir ad). Lider `crewpane_delegate(
// department: "<Görünen Ad>")` diyor. Aşağıdaki yol o metni hiçbir yerde takıma
// ÇEVİRMİYORDU:
//
//   delegationRunner.loadTeamWorkers(department)
//     → supabase.from('agents').eq('department', department)   ← SQL EŞİTLİĞİ
//
// Postgres `=` büyük/küçük harfe DUYARLIDIR ve `agents.department` her zaman
// slug'dır (useOrgAdmin.slugify → yalnız [a-z0-9-]). Yani:
//
//   "ornekTakim" → 0 satır → roster [] → `no-workers` → "0 uygun worker"
//   "ornektakim" → n satır → çalışır
//
// Lider "takım yok" DEĞİL "worker yok" cevabı alıyordu; yani hata mesajı da
// yanlış yeri gösteriyordu (kullanıcı ajanlarını silinmiş sanıyor).
//
// TASARIM SINIRLARI (kasıtlı):
//   • SAF: IO yok, Electron yok, Supabase yok → `node --test` doğrudan koşar ve
//     renderer de `.cjs` uzantılı import ile AYNI dosyayı kullanır (leaderRole.cjs,
//     uiSurfaces.cjs, handoffBlock.cjs ile aynı desen).
//   • İSİM HARDCODE YOK: tek bir takım adı geçmez. Karar VERİDEN (`teams`) çıkar →
//     yeni takım hiçbir listeye dokunmadan doğru davranır (birim testi ölçer).
//   • YETKİ KARARI DEĞİŞMEZ. Bu modül "hangi takım" sorusunu çözer; "bu takıma
//     iznim var mı" sorusu teamScope.cjs'te kalır. teamScope zaten iki tarafı da
//     `normalizeScope` (trim+lowercase) ile karşılaştırdığı için kanonik slug
//     beslemek kararı AYNEN bırakır (teamResolve.test.cjs bunu ölçer).
//   • SESSİZ DÜŞME YOK: çözülemeyen ad `{ ok: false }` + KULLANILABİLİR TAKIM
//     LİSTESİ döner. Çağıran bunu lidere aynen gösterir.
//
// TÜRKÇE HARF TUZAĞI (card §2): `"İSTANBUL".toLowerCase()` → "i̇stanbul"
// (i + U+0307 birleşik nokta), `"ISPARTA".toLocaleLowerCase('tr')` → "ısparta".
// İkisi de SLUG'A EŞİT DEĞİL. Bu yüzden katlama locale'e SORMAZ: Türkçe harfler
// önce ASCII karşılığına eşlenir, sonra birleşik işaretler atılır. Katlama
// `src/app/lib/officePack.ts::slugifyAscii` ile BİLEREK aynıdır — takım slug'ını
// üreten yol ile onu ARAYAN yol aynı fonksiyonu konuşmalı.

'use strict';

/** Türkçe → ASCII eşlemesi (locale-bağımsız; `toLocaleLowerCase` KULLANILMAZ). */
const TR_ASCII = Object.freeze({
  ç: 'c', Ç: 'c', ğ: 'g', Ğ: 'g', ı: 'i', İ: 'i', I: 'i',
  ö: 'o', Ö: 'o', ş: 's', Ş: 's', ü: 'u', Ü: 'u',
});

/**
 * Karşılaştırma anahtarı: Türkçe-güvenli, büyük/küçük ve ayırıcı duyarsız.
 * "Ornek Takim" / "ORNEK-TAKIM" / " ornek_takim " → hepsi "ornek-takim".
 * Boş/geçersiz girdi → ''.
 * @param {unknown} value
 * @returns {string}
 */
function foldTeamKey(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[çÇğĞıİIöÖşŞüÜ]/g, (c) => TR_ASCII[c] ?? c)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // birleşik işaretler (i + U+0307) düşer
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * AYIRICISIZ anahtar: katlanmış anahtardan tireleri de atar. Yalnız EN SON
 * kademede kullanılır — kullanıcı görünen adı "Synq Flow" diye BOŞLUKLU yazarken
 * takımın slug'ı "synqflow" (bitişik) olabilir; slugify boşluğu tireye çevirdiği
 * için bu iki biçim `foldTeamKey` altında EŞİT DEĞİLDİR. Gevşek olduğu için en
 * sona konur ve tekillik şartı burada da geçerlidir.
 * @param {unknown} value
 * @returns {string}
 */
function foldTeamKeyTight(value) {
  return foldTeamKey(value).replace(/-/g, '');
}

/**
 * ADP-482 — bir takımın KAPSAM ANAHTARI: `wing_slug || slug`. teamScope,
 * agents.department ve pane kayıtları bu değeri taşır.
 * @param {{ wing_slug?: string|null, wingSlug?: string|null, slug?: string|null }} team
 * @returns {string}
 */
function teamScopeOf(team) {
  if (!team || typeof team !== 'object') return '';
  const wing = team.wing_slug ?? team.wingSlug ?? null;
  const w = typeof wing === 'string' ? wing.trim() : '';
  if (w) return w;
  return typeof team.slug === 'string' ? team.slug.trim() : '';
}

/** Çöp satırları eleyip tek şekle indirger. */
function normalizeTeams(teams) {
  if (!Array.isArray(teams)) return [];
  const out = [];
  for (const t of teams) {
    if (!t || typeof t !== 'object') continue;
    const scope = teamScopeOf(t);
    if (!scope) continue;
    out.push({
      id: typeof t.id === 'string' ? t.id : null,
      name: typeof t.name === 'string' ? t.name.trim() : '',
      slug: typeof t.slug === 'string' ? t.slug.trim() : '',
      wingSlug: typeof (t.wing_slug ?? t.wingSlug) === 'string' ? String(t.wing_slug ?? t.wingSlug).trim() : '',
      scope,
    });
  }
  return out;
}

/** Lidere gösterilecek takım listesi: `slug (Görünen Ad)`, tekilleştirilmiş. */
function describeTeams(list) {
  const seen = new Set();
  const parts = [];
  for (const t of list) {
    if (seen.has(t.scope)) continue;
    seen.add(t.scope);
    parts.push(t.name && t.name !== t.scope ? `${t.scope} ("${t.name}")` : t.scope);
  }
  return parts.join(', ');
}

/**
 * KADEMELER. Sıra card §2'nin sırası: slug tam → slug küçük harf → wing_slug →
 * görünen ad. Her kademe KENDİ İÇİNDE tekil olmalı; değilse (iki takım aynı
 * anahtara katlanıyorsa) karar VERİLMEZ, hata döner — yanlış takıma iş vermek
 * "bulamadım" demekten çok daha pahalıdır.
 *
 * Tam eşleşme önce gelir: slug'ları "Ops" ve "ops" olan iki takım varken girdi
 * "Ops" ise tam eşleşme tekildir ve kazanır; girdi "OPS" ise hiçbir kademe tekil
 * değildir → `ambiguous`.
 */
const TIERS = Object.freeze([
  { id: 'slug-exact', key: (t) => t.slug, norm: (v) => (typeof v === 'string' ? v : '') },
  { id: 'wing-exact', key: (t) => t.wingSlug, norm: (v) => (typeof v === 'string' ? v : '') },
  { id: 'slug-fold', key: (t) => t.slug, norm: foldTeamKey },
  { id: 'wing-fold', key: (t) => t.wingSlug, norm: foldTeamKey },
  { id: 'name-fold', key: (t) => t.name, norm: foldTeamKey },
  { id: 'slug-tight', key: (t) => t.slug, norm: foldTeamKeyTight },
  { id: 'wing-tight', key: (t) => t.wingSlug, norm: foldTeamKeyTight },
  { id: 'name-tight', key: (t) => t.name, norm: foldTeamKeyTight },
]);

function messages(kind, ctx) {
  if (kind === 'empty') {
    return {
      tr: 'takım (department) belirtilmedi — `department` alanına takımının slug\'ını ya da görünen adını yaz.',
      en: 'department missing — pass the team slug or display name in `department`.',
    };
  }
  if (kind === 'ambiguous') {
    return {
      tr: `"${ctx.input}" birden fazla takıma uyuyor (${ctx.candidates.join(', ')}) — iş VERİLMEDİ. `
        + 'Hangisini kastettiğini slug ile yaz.',
      en: `"${ctx.input}" matches more than one team (${ctx.candidates.join(', ')}) — nothing was dispatched. `
        + 'Use the exact team slug.',
    };
  }
  return {
    tr: `"${ctx.input}" adında bir takım bulunamadı — iş VERİLMEDİ. Mevcut takımlar: ${ctx.available || '(yok)'}.`,
    en: `No team named "${ctx.input}" — nothing was dispatched. Available teams: ${ctx.available || '(none)'}.`,
  };
}

/**
 * Serbest metni kanonik takım kapsamına çevir.
 *
 * @param {unknown} input   liderin/kullanıcının yazdığı `department`
 * @param {Array<{id?:string,name?:string,slug?:string,wing_slug?:string|null}>} teams
 *        `teams` tablosunun satırları (boş/okunamaz olabilir)
 * @returns {{ ok:true, scope:string, team:object|null, matchedBy:string }
 *          | { ok:false, reason:'empty'|'not-found'|'ambiguous', input:string,
 *              candidates:string[], available:string, message:string, messageEn:string }}
 *
 * FAIL-OPEN (tek istisna, bilinçli): `teams` BOŞ gelirse karar verilemez ama
 * delegasyon öldürülmez — girdi `normalizeScope` ile AYNI şekilde (trim+lowercase)
 * kanonikleştirilip `ok:true, team:null` döner. Gerekçe teamMembership.ts ile aynı:
 * Supabase erişilemediğinde ağ arızası bir YETKİ/VARLIK kararına dönüşmemeli.
 * Bu hâlde davranış bugünkünden KÖTÜ olamaz (bugün de ham metin gidiyor).
 */
function resolveDepartment(input, teams) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) {
    const m = messages('empty', {});
    return { ok: false, reason: 'empty', input: '', candidates: [], available: '', message: m.tr, messageEn: m.en };
  }
  const list = normalizeTeams(teams);
  if (list.length === 0) {
    return { ok: true, scope: raw.toLowerCase(), team: null, matchedBy: 'no-team-data' };
  }

  for (const tier of TIERS) {
    const want = tier.norm(raw);
    if (!want) continue; // katlama boş çıktıysa (ör. yalnız noktalama) o kademe atlanır
    const hits = [];
    for (const t of list) {
      const k = tier.key(t);
      if (!k) continue;
      if (tier.norm(k) === want) hits.push(t);
    }
    if (hits.length === 0) continue;
    // Aynı takımın iki alanı (slug == wing_slug) ya da aynı kapsamı paylaşan
    // satırlar çakışma DEĞİLDİR — kapsam tekse karar tektir.
    const scopes = [...new Set(hits.map((t) => t.scope))];
    if (scopes.length === 1) return { ok: true, scope: scopes[0], team: hits[0], matchedBy: tier.id };
    const m = messages('ambiguous', { input: raw, candidates: scopes });
    return {
      ok: false, reason: 'ambiguous', input: raw, candidates: scopes,
      available: describeTeams(list), message: m.tr, messageEn: m.en,
    };
  }

  const available = describeTeams(list);
  const m = messages('not-found', { input: raw, available });
  return { ok: false, reason: 'not-found', input: raw, candidates: [], available, message: m.tr, messageEn: m.en };
}

/**
 * Takım listesi ELDE YOKKEN kullanılan zayıf kanonikleştirme (spawn sink'leri:
 * agentRunner env/cwd/task-kimliği). teamScope.normalizeScope ile BİREBİR aynı
 * kural — `dirForDepartment` ve `windowForDepartment` zaten bunu uyguluyordu,
 * agentRunner ise yalnız `.trim()` yapıyordu ve bu SAPMA bir worker'ın env'ine
 * "Karma Harfli" bir departman yazıp o worker'ın SONRAKİ delegasyonuna
 * taşıyordu. Slug'lar zaten [a-z0-9-] olduğu için gerçek veride no-op'tur.
 * @param {unknown} value
 * @returns {string}
 */
function normalizeDepartment(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

module.exports = {
  foldTeamKey,
  foldTeamKeyTight,
  teamScopeOf,
  normalizeDepartment,
  resolveDepartment,
  describeTeams,
  TIERS,
};
