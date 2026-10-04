// ADP-444 (Wheeljack) — PROMPT'SUZ toplu terminal açma: deterministik sayı/motor parse'ı
// + onay politikası. SAF ÇEKİRDEK (Electron'suz, node --test ile koşar — fanoutPolicy.cjs
// emsali).
//
// İLKE (ADP-322 / executor-policy): LLM yalnız NİYETİ sınıflandırır ("bu bir spawn
// isteği"); SAYILAR ve MOTORLAR buradaki regex/token yürüyüşünden çıkar ve beynin
// çıktısının ÜSTÜNE yazılır (applyExecutorPolicy). Beyin 5'i 3 duysa bile kullanıcının
// söylediği sayı kazanır. Prompt bir kapı değildir — kural kodla zorlanır.
//
// Onay politikası (ADP-444 §4): kullanıcı sayıyı AÇIKÇA söylediyse ("5 codex") açık
// talimat = onay, ek kart YOK. Kart yalnız (a) sayı söylenmemiş çoklu spawn'da
// (belirsizlik) ve (b) makul üst sınır aşımında (>12 pane) kalır.
//
// PANE-CAP-01 — MUTLAK TAVAN (SPAWN_HARD_CAP = 16) KALDIRILDI. Sabit sayı yanlış
// araçtı: "20 claude aç" diyen kullanıcının komutunu SESSİZCE 16'ya kırpmak, hem
// istediğini vermiyor hem de neden vermediğini söylemiyordu. Artık kırpma YOK —
// 12'yi aşan her sayı ONAY KARTINA gider (soru, ret değil) ve onaylanırsa TAM
// istenen sayı açılır. Kaynak tarafını main'deki `resourceGovernor` ölçümle korur;
// sayıyı sayıyla sınırlayan hiçbir sabit kalmadı.

'use strict';

/**
 * Tek komutta onay KARTSIZ açılabilecek en çok pane (aşımı = KART, ret değil).
 * PANE-CAP-01 sonrası bu tek "sayı"dır ve bir TAVAN DEĞİL bir SORU EŞİĞİDİR:
 * üstünde kullanıcıya sorulur, onay gelirse istenen sayı olduğu gibi açılır.
 */
const SPAWN_APPROVAL_FREE_MAX = 12;
/**
 * BL-01 — ADP-242 sprint dalgasının VARSAYILAN genişliği (lider `maxConcurrent`
 * vermezse). Sayı buraya taşındı çünkü artık İKİ taraf okuyor: renderer
 * (sprintOrchestrator.DEFAULT_MAX_CONCURRENT) ve main (paket dalga tavanını
 * uygularken "aslında kaç worker istendi"yi bilmek zorunda). İki kopya olsaydı
 * biri değişince tavan sessizce yanlış sayıyı kısıtlardı.
 */
const SPRINT_DEFAULT_WAVE = 4;

// Türkçe sayı kelimeleri (STT rakam yerine yazıyla dökebilir: "beş codex").
// Bileşik onluk: "on iki" → 12 (token yürüyüşünde 'on' + birlik birleştirilir).
const NUM_WORDS = {
  bir: 1, iki: 2, 'üç': 3, uc: 3, 'dört': 4, dort: 4, 'beş': 5, bes: 5,
  'altı': 6, alti: 6, yedi: 7, sekiz: 8, dokuz: 9, on: 10,
};

// Motor takma adları (STT varyantları): klod → claude. "cloud" bilerek YOK (gerçek
// kelimeyle çakışır → yanlış-pozitif spawn).
const ENGINE_ALIASES = { claude: 'claude', klod: 'claude', codex: 'codex', kodeks: 'codex' };

// Sayı ile motor arasında sayılabilir dolgu kelimeleri ("5 tane yeni codex").
const FILLER = new Set(['tane', 'adet', 'yeni', 'ayrı', 'ayri', 'boş', 'bos', 'daha']);

// Motor adı geçmeden "5 terminal aç" diyen komutlar için sözde-motor kelimeleri
// (varsayılan motor claude). Yalnız HİÇ gerçek motor geçmediyse kullanılır — yoksa
// "3 claude terminali" cümlesindeki "terminali" ikinci batch üretirdi.
const TERMINALISH = new Set(['terminal', 'terminali', 'terminalleri', 'pane', 'cli', 'oturum', 'pencere']);

/** Token'ı sayıya çevir (rakam veya Türkçe kelime); değilse null. */
function tokenNumber(tok, nextTok) {
  if (/^\d+$/.test(tok)) return { value: Number(tok), consumedNext: false };
  const base = NUM_WORDS[tok];
  if (base == null) return null;
  if (base === 10 && nextTok != null) {
    const unit = NUM_WORDS[nextTok];
    if (unit != null && unit >= 1 && unit <= 9) return { value: 10 + unit, consumedNext: true };
  }
  return { value: base, consumedNext: false };
}

/**
 * Deterministik parse: transkriptten motor başına pane sayıları.
 *
 * Dönen: { batches: [{engine:'claude'|'codex', count}], total, explicit }
 *   • "5 tane codex terminali aç"  → [{codex,5}], explicit=true
 *   • "3 claude 2 codex aç"        → [{claude,3},{codex,2}], explicit=true (karışık)
 *   • "beş codex"                  → [{codex,5}] (STT yazıyla — NUM_WORDS)
 *   • "codex terminali aç"         → [{codex,1}], explicit=false (sayı söylenmedi)
 *   • "5 terminal aç"              → [{claude,5}] (motor söylenmedi → varsayılan)
 *   • spawn niyeti yoksa           → batches boş (karar LLM'de kalır)
 *
 * explicit = kullanıcı EN AZ BİR sayıyı açıkça söyledi (onay-kartsız yol, §4).
 * Aynı motor iki kez geçerse sayılar toplanır. PANE-CAP-01: SAYI KIRPILMAZ —
 * kullanıcı ne dediyse o döner; 12 üstü `spawnApprovalNeeded` ile karta gider.
 */
function parseSpawnBatches(text) {
  const low = String(text || '').toLocaleLowerCase('tr');
  const tokens = low.split(/[^a-zçğıöşü0-9]+/).filter(Boolean);

  /** @type {Array<{engine:string, count:number, explicit:boolean}>} */
  const found = [];
  let pending = null; // { value, explicit } — motora bağlanmayı bekleyen sayı
  let firstLooseNumber = null; // motorsuz "5 terminal" eşleşmesi için

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const num = tokenNumber(tok, tokens[i + 1]);
    if (num) {
      pending = { value: num.value, explicit: true };
      if (num.consumedNext) i++;
      continue;
    }
    const engine = ENGINE_ALIASES[tok];
    if (engine) {
      found.push({ engine, count: pending ? pending.value : 1, explicit: !!pending });
      pending = null;
      continue;
    }
    if (TERMINALISH.has(tok)) {
      // Motorsuz "5 terminal" çifti — yalnız gerçek motor hiç çıkmazsa kullanılır.
      if (pending && firstLooseNumber == null) firstLooseNumber = pending.value;
      pending = null;
      continue;
    }
    if (!FILLER.has(tok)) pending = null; // alakasız kelime sayı-motor bağını koparır
  }

  let batches = found;
  if (batches.length === 0 && firstLooseNumber != null) {
    batches = [{ engine: 'claude', count: firstLooseNumber, explicit: true }];
  }

  // Aynı motoru birleştir (sıra: ilk görülme).
  const merged = [];
  for (const b of batches) {
    const prev = merged.find((m) => m.engine === b.engine);
    if (prev) {
      prev.count += b.count;
      prev.explicit = prev.explicit || b.explicit;
    } else {
      merged.push({ ...b });
    }
  }

  // PANE-CAP-01 — KIRPMA YOK. Yalnız şekil zorlanır (en az 1, tam sayı): kullanıcının
  // söylediği sayı olduğu gibi taşınır ve kararı onay kartı verir.
  let total = 0;
  const normalized = [];
  for (const b of merged) {
    const count = Math.max(1, Math.round(b.count));
    total += count;
    normalized.push({ engine: b.engine, count });
  }

  return {
    batches: normalized,
    total,
    explicit: merged.some((b) => b.explicit),
  };
}

/**
 * Onay kartı gerekiyor mu? (ADP-444 §4 — deterministik politika, LLM'e sorulmaz)
 *   • açık sayı + toplam ≤ 12  → HAYIR (açık talimat = onay; ADP-322 kartı
 *     yalnız belirsiz/limitsiz durumların kapısı olarak kalır)
 *   • toplam > 12              → EVET (SORU — onaylanırsa tam o sayı açılır; kırpma yok)
 *   • sayı söylenmemiş ve ≥ 2  → EVET (belirsiz çoklu — eski ADP-264 kapısı)
 *   • tek pane                 → HAYIR (ofis-tık ile eşdeğer risk)
 */
function spawnApprovalNeeded(total, explicit) {
  const n = Number(total) || 0;
  if (n <= 0) return false;
  if (n > SPAWN_APPROVAL_FREE_MAX) return true;
  if (!explicit && n >= 2) return true;
  return false;
}

module.exports = {
  SPAWN_APPROVAL_FREE_MAX,
  SPRINT_DEFAULT_WAVE,
  parseSpawnBatches,
  spawnApprovalNeeded,
};
