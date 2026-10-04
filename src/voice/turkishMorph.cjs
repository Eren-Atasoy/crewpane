// ADP-854 (Wheeljack) — TÜRKÇE MORFOLOJİ EŞLEŞTİRİCİ (saf çekirdek, leaf modül).
//
// ── SINIF TANIMI (tek tek yama DEĞİL, kapatılan hata sınıfı) ────────────────
// Kural yolundaki niyet regex'leri fiil KÖKÜNÜ ÇIPLAK ALT-DİZE olarak arıyordu
// (`/kapat/`, `/aç/`, `/ara\b/`, `/başlat/`). Türkçe SONDAN EKLEMELİ bir dil olduğu
// için bu desen İKİ yönde birden yanlış eşleşir:
//
//   (a) OLUMSUZLAMA GÖRÜNMEZ:  "kapatma" ⊃ "kapat"  → kullanıcı "kapatma" derken
//       terminal ÖLÜYORDU. "başlatma" ⊃ "başlat" → 3 pane AÇILIYORDU.
//   (b) TÜREV ÇAKIŞMASI:       "açıklama"/"açık"/"açlık" ⊃ "aç" ·  "kurtar" ⊃ "kur" ·
//       "arasında"/"aralık" ⊃ "ara" · "kapak" ⊃ "kapa" · "atama" ⊃ "ata".
//
// ÇÖZÜM: alt-dize araması YOK. Metin JETONLARA ayrılır; bir jeton ancak kök ile
// BAŞLIYORSA **ve** kalan kısım İZİN LİSTESİNDEKİ bir çekim ekiyle TAM eşleşiyorsa
// eşleşme sayılır. Olumsuz ekler (-ma/-me…) ayrı sınıflanır ve çağırana `negated`
// olarak bildirilir — yani "kapat" ile "kapatma" artık AYNI ŞEY DEĞİL.
//
// TASARIM KURALLARI
//   • ÖNCE OLUMLU, SONRA OLUMSUZ denenir. ("açmak" olumlu mastardır; olumsuz
//     kuyruğu `[mnk]` içerdiği için sıralama ters olsaydı "mak" olumsuz sanılırdı.)
//   • Kişi/iyelik kuyruğu ancak bir ANA ek eşleştiyse serbesttir. Serbest bıraksaydım
//     "kapa"+"k" = "kapak" geçerli bir fiil sanılırdı (ölçüldü, teste dönüştü).
//   • Ses/çatı türevleri (kapa→kapat, ara→arat, odakla→odaklan) EK olarak değil
//       AYRI KÖK olarak listelenir: küçük regex + sıfır sürpriz.
//   • Şüphede EŞLEŞME YOK. Tanımadığı biçim `null` döner → kural yolu o dalı atlar
//     ve karar LLM'e kalır (görev §3: kural yolu yalnız yüksek güvenli desenlerde).
//
// Saf + bağımlılıksız → `node --test electron/turkishMorph.test.cjs` ile doğrudan koşar.
//
// ADP-885/st1 — i18n-exempt: speech-grammar. Buradaki Türkçe ekler/kökler DİLBİLGİSİ
// VERİSİDİR, arayüz metni değil: çeviri sözlüğüne taşınamaz. Motor SAF kalsın diye
// (memory/arama katmanı da bunu `tokens()` için kullanıyor) leksikona BAĞLANMADI —
// yerinde işaretlenir, kapı işareti zorunlu kılar (bkz. intentLexicon.cjs §7).

'use strict';

/** Türkçe locale küçültme (I/İ tuzağı: 'IŞIK'.toLowerCase() → 'ışık' DEĞİL 'ışık' için gerekli). */
function trLower(s) {
  return String(s == null ? '' : s).toLocaleLowerCase('tr');
}

/**
 * Kelime jetonları. Kesme işareti AYIRICIDIR: "Reis'e" → ['reis','e'],
 * "ADP-854'ü" → ['adp','854','ü']. Böylece ad/kök eşleşmesi eke takılmaz.
 * Türkçe harfler + rakam korunur; ASCII'ye ÇEVİRMEZ (ı/i ayrımı anlam taşır).
 */
function tokens(text) {
  return trLower(text).split(/[^a-zçğıöşü0-9]+/).filter(Boolean);
}

// ── Ek dilbilgisi ───────────────────────────────────────────────────────────

/**
 * Çatı ekleri (edilgen/ettirgen) — ana ekten ÖNCE gelebilir ama TEK BAŞINA
 * eşleşme SAYILMAZ (aşağıdaki POS_RE'de ana ek zorunlu). Tek başına serbest
 * bıraksaydım "kur"+"uş" = "kuruş", "kur"+"ul" = "kurul" fiil sanılırdı (ölçüldü).
 */
const VOICE = '(?:[ıiuü]l|d[ıiuü]r|t[ıiuü]r)';

/** Kişi/iyelik kuyruğu — YALNIZ bir ana ekten sonra (bkz. POS_RE yorumu). */
const PERSON = '(?:[ıiuü]m|s[ıiuü]n[ıiuü]z|s[ıiuü]n|[ıiuü]z|l[ae]r|n[ıiuü]z|[mnk])?';

/**
 * Ana çekim ekleri (OLUMLU). Sıra önemli: uzun biçimler önce
 * ("mak" `m[ae]k`, "malı"dan önce denenmezse sorun yok ama uzun-önce alışkanlığı
 * ileride eklenecek ekler için güvenli).
 */
const MAIN_POS = [
  'm[ae]kt[ae]',            // açmakta
  'm[ae]k',                 // açmak (mastar)  ← olumsuzdan ÖNCE denenmeli
  'm[ae]l[ıi]',             // açmalı
  '[aeıiuü]?bil[ıi]r',      // açabilir
  '[ıiuü]yor',              // açıyor
  '[aeıiuü]c[ae][kğ]',      // açacak / açacağ(ım)
  'm[ıiuü]ş',               // açmış
  '[dt][ıiuü]ğ[ıiuü]',      // açtığı(n)  ← EKRANDAKİ VAKA: "Açtığın"
  '[dt][ıiuü]',             // açtı / kapattı
  's[ae]n[ae]',             // açsana
  '[ae]l[ıi]m',             // açalım
  'y[ae]l[ıi]m',            // okuyalım
  '[ae]y[ıi]m',             // açayım
  'y[ae]y[ıi]m',            // okuyayım
  '[aeıiuü]r',              // açar / kapatır (geniş zaman)
  'r',                      // arar / kapar (ünlüyle biten kökte geniş zaman)
  's[ıiuü]n',               // açsın
  '[ıiuü]n',                // açın (2. çoğul emir)
  'y?[ıiuü]p',              // açıp / okuyup
  '[ae]r[ae]k',             // açarak
  '[ıiuü]nc[ae]',           // açınca
  '[ıiuü]ver',              // açıver
  's[ae]',                  // açsa (şart)
].join('|');

/** OLUMSUZ ana ekler (-ma/-me ailesi + olumsuz şimdiki zaman -mıyor). */
const MAIN_NEG = [
  'm[ae]z',                 // açmaz
  'm[ae]d[ıi]',             // açmadı
  'm[ae]m[ıi]ş',            // açmamış
  'm[ae]y[ae]c[ae][kğ]',    // açmayacak
  'm[ae]y[ıi]n',            // açmayın
  'm[ae]s[ıi]n',            // açmasın
  'm[ae]y[ae]l[ıi]m',       // açmayalım
  'm[ıiuü]yor',             // açmıyor
  'm[ae]',                  // açma  ← ÇIPLAK OLUMSUZ EMİR (en sık vaka)
].join('|');

// OLUMLU: ya kökün kendisi (boş kalan), ya da [çatı?] + ANA EK + [kişi?].
// Kişi kuyruğu ana eke BAĞLI: serbest bıraksaydım "kapa"+"k" = "kapak" geçerli bir
// fiil biçimi sanılırdı (ölçüldü → I8 tuzak vakası).
const POS_RE = new RegExp(`^(?:${VOICE}?(?:${MAIN_POS})${PERSON})?$`);
const NEG_RE = new RegExp(`^${VOICE}?(?:${MAIN_NEG})${PERSON}$`);

/** Türkçe ünlüler — ünlü düşmesi (ara+ıyor → arıyor) için. */
const VOWELS = 'aeıioöuü';

/**
 * "arama yap" / "tarama yapalım" gibi BİRLEŞİK FİİLLER: -ma/-me burada olumsuzluk
 * değil FİİLDEN İSİM ekidir. Ayırt edici sinyal bir sonraki jetonun yardımcı fiil
 * olması. (Bu ayrımı yapmasaydım "arama yap" = "arama!" sanılırdı — ADP-848-B dersi:
 * bir kural nüfusu AYIRMIYORSA faydasızdır; burada ayırıyor.)
 */
const LIGHT_VERB_STEMS = ['yap', 'et', 'başlat', 'baslat', 'gerçekleştir', 'gerceklestir', 'ver'];

function isLightVerbToken(tok) {
  if (!tok) return false;
  return LIGHT_VERB_STEMS.some((st) => {
    if (!tok.startsWith(st)) return false;
    const rest = tok.slice(st.length);
    return POS_RE.test(rest);
  });
}

/**
 * Tek jeton, tek kök: eşleşme sınıfı.
 * @returns {'positive'|'negative'|null}
 */
function classifyToken(tok, stem) {
  if (!tok || !stem) return null;
  if (tok.startsWith(stem)) {
    const rest = tok.slice(stem.length);
    if (POS_RE.test(rest)) return 'positive';
    if (NEG_RE.test(rest)) return 'negative';
  }
  // ÜNLÜ DÜŞMESİ: "ara"+"ıyor" → "arıyor", "oku"+"uyor" → "okuyor". Kök son ünlüsü
  // düşer, dolayısıyla düz ön-ek eşleşmesi TUTMAZ. Kırpılmış kökle tekrar dene ama
  // kalan mutlaka bir EK ÜNLÜSÜYLE başlasın — yoksa "ara"→"ar" kırpması "aralık"ı
  // ("alık") ya da "araba"yı ("aba") içeri alırdı.
  const last = stem[stem.length - 1];
  if (stem.length > 2 && VOWELS.includes(last)) {
    const short = stem.slice(0, -1);
    if (tok.startsWith(short)) {
      const rest2 = tok.slice(short.length);
      if (rest2 && 'ıiuü'.includes(rest2[0])) {
        if (POS_RE.test(rest2)) return 'positive';
        if (NEG_RE.test(rest2)) return 'negative';
      }
    }
  }
  return null;
}

/**
 * Metinde verilen köklerden biri geçiyor mu?
 *
 * @param {string} text  ham cümle (ya da küçültülmüş — fark etmez)
 * @param {readonly string[]} stems  fiil kökleri (çatı türevleri AYRI kök olarak
 *        verilir). `readonly`: leksikon dizileri donmuş ve markalı gelir (ADP-885/st1).
 * @returns {{ stem:string, token:string, index:number, negated:boolean } | null}
 *
 * CÜMLE SIRASINDA İLK eşleşen jeton kazanır — OLUMLU biçime öncelik VERİLMEZ.
 * Sebebi ölçüldü: "Sayfayı okuma, ben okurum" cümlesinde ikinci "okurum" olumludur
 * ama niyet olumsuzdur. Olumluyu tercih etmek kullanıcı "yapma" derken eylemi
 * KOŞTURUYORDU. Türkçede olumsuzlama fiilin kendisinde olduğu için ilk fiil niyeti
 * belirler.
 */
function verbHit(text, stems) {
  const toks = Array.isArray(text) ? text : tokens(text);
  for (let i = 0; i < toks.length; i++) {
    for (const stem of stems) {
      const cls = classifyToken(toks[i], stem);
      if (!cls) continue;
      if (cls === 'positive') return { stem, token: toks[i], index: i, negated: false };
      // -ma/-me + yardımcı fiil = BİRLEŞİK FİİL ("arama yap"), olumsuzluk DEĞİL.
      if (isLightVerbToken(toks[i + 1])) return { stem, token: toks[i], index: i, negated: false };
      return { stem, token: toks[i], index: i, negated: true };
    }
  }
  return null;
}

/** Kısayol: OLUMLU bir eşleşme var mı? (olumsuz biçim `false` döner). */
function hasVerb(text, stems) {
  const h = verbHit(text, stems);
  return !!h && !h.negated;
}

/** Kısayol: köklerden biri OLUMSUZ biçimde mi geçiyor? */
function hasNegatedVerb(text, stems) {
  const h = verbHit(text, stems);
  return !!h && h.negated;
}

// ── İsim çekimi ─────────────────────────────────────────────────────────────
//
// İsimler tuzak üretmiyor (korpustaki yemler fiil kökü çakışmaları) ama "terminal"
// ile "terminallerini" aynı ipucudur; çıplak `includes` burada YETERSİZ değil FAZLA
// GENİŞ ("terminalcilik" gibi türevleri de alır). Orta sıkılıkta bir izin listesi.
const NOUN_SUFFIX_RE = new RegExp(
  '^(?:l[ae]r)?(?:[ıiuü]m|[ıiuü]n|s[ıiuü]|[ıiuü]z)?(?:n)?(?:[ıiuü]|[ae]|d[ae]n?|t[ae]n?|l[ae]|y[ae]|y[ıiuü])?$',
);

/** Metinde bu isim köklerinden biri (çekimli hâlleriyle) geçiyor mu? */
function hasNoun(text, stems) {
  const toks = Array.isArray(text) ? text : tokens(text);
  for (const tok of toks) {
    for (const stem of stems) {
      if (!tok.startsWith(stem)) continue;
      if (NOUN_SUFFIX_RE.test(tok.slice(stem.length))) return true;
    }
  }
  return false;
}

// ── Ad çözümleme yardımcıları ───────────────────────────────────────────────

/**
 * Levenshtein mesafesi, ERKEN ÇIKIŞLI (max aşılırsa hemen `max+1`).
 * STT ad harflerini düşürür/karıştırır ("wheeljak", "bamblbi") — yakın eşleşme şart.
 */
function editDistance(a, b, max = 2) {
  const s = String(a || '');
  const t = String(b || '');
  if (Math.abs(s.length - t.length) > max) return max + 1;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[t.length];
}

module.exports = {
  trLower,
  tokens,
  classifyToken,
  verbHit,
  hasVerb,
  hasNegatedVerb,
  hasNoun,
  isLightVerbToken,
  editDistance,
  POS_RE,
  NEG_RE,
  NOUN_SUFFIX_RE,
};
