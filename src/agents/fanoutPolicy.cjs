// ADP-322 — FAN-OUT POLİTİKASI (saf, deterministik; ADR-022 / ADP-321 kararı).
//
// Kök neden (ADP-321): Jarvis'te fan-out bir KARAR değil VARSAYILANDI. Beyin yalnız
// {action:'delegate', objective} döndürüyor, genişliği `defaultPlanner` belirliyordu:
// madde sayısı × roster boyutu → N pane. "Kaç ajan gerekir?" diye soran kod yoktu ve
// "sen kendin yap" ifadesinin ineceği bir slot da yoktu → Eren'in 2 dakikalık tek
// oturumlu tarayıcı işi 4 ajana bölündü.
//
// Bu modül üç soruyu SAF kodla cevaplar (LLM'in iyi niyetine bırakılmaz):
//   1. Kullanıcı yürütücüyü AÇIKÇA söyledi mi?  → detectDirective()  (MUTLAK: hep kazanır)
//   2. İş sıralı mı, gerçekten paralel mi?       → isSequential/hasParallelSignal
//   3. Kaç ajan?                                 → decideWidth()      (varsayılan 1)
//
// Tasarım kuralları:
//   • Fail-safe: şüphe varsa TEK ajan. Az ajan geri alınabilir, çok ajan geri alınamaz
//     (token yanar, paylaşımlı worktree'de ajanlar birbirinin işini yer).
//   • Direktif > sezgi. Hiçbir sezgisel kural kullanıcının açık sözünü ezemez.
//   • Saf + bağımlılıksız → `node --test` ile doğrudan koşar (leaf-module kuralı).

'use strict';

/** Fan-out tavanı: roster boyutu TAVAN DEĞİLDİR (ADP-321 §2, Kural 4). */
const MAX_FANOUT = 4;

/**
 * DELEG-PAR-01 — BÖLÜNEMEYEN işte (tek madde) açık "paralel/takıma ver" direktifi
 * varken açılacak pane tavanı: 1 uygulayıcı + 1 tamamlayıcı (inceleme/test).
 */
const UNSPLIT_TEAM_WIDTH = 2;

// ── 1. Kullanıcı direktifi (MUTLAK — ilk eşleşen kazanır) ────────────────────
//
// Sıra önemli: SELF, DELEGATE_RE'nin ("delege", "böl", "yaptır") tetiklediği her şeyi
// kısa devre yapar. "delege etme" cümlesi delege regex'ine TAM uyar — olumsuzlama
// görülmediği için ADP-321'de kural-tabanlı yedek yol da yanlış cevabı veriyordu.

/** "sen yap / kendin hallet / ajan açma / delege etme" → Jarvis'in KENDİSİ yapar. */
const SELF_RE =
  /(sen\s+(kendin\s+)?(yap|hallet|bak|çöz|coz)|kendin(iz)?\s+(yap|hallet|bak|çöz|coz)|kendi(n|niz)?\s+araçlar|ajan\s*(açma|acma)|pane\s*(açma|acma)|delege\s*(etme|etmeden)|delegasyon\s*yapma|takım[ıa]?\s*verme|takima\s*verme|ekibe\s*verme|(işi|isi)?\s*bölme\b|bolme\b)/i;

/** "tek ajan / tek kişi / sadece Wheeljack yapsın" → TAM 1 ajan. */
const SINGLE_RE =
  /(tek\s+(bir\s+)?(ajan|kişi|kisi|worker|pane|eleman)|bir\s+(ajan|kişi|kisi)(a|ya)?\s*(ver|baksın|baksin|yapsın|yapsin)|yalnız(ca)?\s+bir|sadece\s+bir\s+(ajan|kişi|kisi)|(sadece|yalnız|yalniz)\s+\S+\s+(yapsın|yapsin|baksın|baksin))/i;

/** "takıma dağıt / paralel çalışsın / böl" → fan-out serbest (yine de onay kartı). */
const TEAM_RE =
  /(takım[ıi]?n?a\s*(ver|dağıt|dagit)|takima\s*(ver|dağıt|dagit)|ekibe\s*(ver|dağıt|dagit)|(işi|isi)?\s*(böl|bol)(üştür|ustur)?\b|paralel|aynı\s*anda|ayni\s*anda|eş\s*zamanlı|hepsi\s+çalış|herkes\s+çalış|fan\s*-?\s*out)/i;

/**
 * Kullanıcı yürütücüyü açıkça söyledi mi? 'self' | 'single' | 'team' | null.
 * İLK EŞLEŞEN KAZANIR — SELF her zaman önce bakılır ("delege etme" cümlesi hem SELF'e
 * hem TEAM'e uyar; olumsuzlama olan yorum doğrudur).
 */
function detectDirective(text) {
  const t = String(text || '');
  if (!t.trim()) return null;
  if (SELF_RE.test(t)) return 'self';
  if (SINGLE_RE.test(t)) return 'single';
  if (TEAM_RE.test(t)) return 'team';
  return null;
}

// ── 2. Sıralı mı, paralel mi? ────────────────────────────────────────────────

/** Adımlar birbirinin çıktısına bağlı → ASLA bölünmez (tek yürütücüde kalır). */
const SEQUENTIAL_RE =
  /(\bönce\b|\bonce\b|\bsonra\b|ardından|ardindan|daha\s+sonra|bitince|bittikten|sonrasında|akabinde|peşinden|pesinden|en\s+son)/i;

/** Parçalar birbirinden bağımsız → fan-out ADAYI (yine de onay + tavan). */
const PARALLEL_RE =
  /(paralel|aynı\s*anda|ayni\s*anda|eş\s*zamanlı|es\s*zamanli|ayrı\s*ayrı|ayri\s*ayri|her\s*biri(ni)?\s*(ayrı|ayri|farklı|farkli)?|bölüştür|bolustur|dağıt|dagit)/i;

function isSequential(objective) {
  return SEQUENTIAL_RE.test(String(objective || ''));
}

function hasParallelSignal(objective) {
  return PARALLEL_RE.test(String(objective || ''));
}

// ── 3. Yürütücü sınıfı: KİM yapacak? ─────────────────────────────────────────

/**
 * Yürütücü SINIFI. Beyinden bağımsız, saf, deterministik. Dönen:
 *   { executor, directive, reason }
 *     executor='self'   → HİÇ delegasyon yok; Jarvis kendi araçlarıyla yapar
 *     executor='single' → TAM 1 ajan, 1 pane (onay kartı ÇIKMAZ — güvenli varsayılan)
 *     executor='team'   → fan-out ADAYI (çağıran ONAY KARTI göstermek ZORUNDA)
 *
 * Varsayılan 'single'. 'team' yalnız şu HEPSİ doğruysa: açık paralel sinyal VAR **ve**
 * iş sıralı DEĞİL. Şüphe → 'single' (fail-safe: az ajan geri alınabilir, çok ajan hayır).
 *
 * `transcript` = kullanıcının ham cümlesi (direktif orada aranır), `objective` = işin
 * tarifi (sıralılık/paralellik sinyali orada aranır). Genelde ikisi aynı metindir.
 */
function decideExecutor({ transcript = '', objective = '' } = {}) {
  const said = String(transcript || objective || '');
  const work = String(objective || transcript || '');
  const directive = detectDirective(said);

  if (directive === 'self') {
    return { executor: 'self', directive, reason: 'kullanıcı "sen kendin yap" dedi — delegasyon yok' };
  }
  if (directive === 'single') {
    return { executor: 'single', directive, reason: 'kullanıcı tek ajan istedi' };
  }

  const sequential = isSequential(work);
  const parallel = hasParallelSignal(work);

  if (directive === 'team') {
    // Açık "takıma dağıt/paralel" direktifi: fan-out serbest — ama SIRALI bir iş yine de
    // bölünmez (bölmek işi BOZAR; kullanıcı hızlanmak istiyor, kırılmak değil).
    if (sequential && !parallel) {
      return { executor: 'single', directive, reason: 'takıma verildi ama adımlar sıralı (önce/sonra) — bölmek işi bozar, tek ajan' };
    }
    return { executor: 'team', directive, reason: 'kullanıcı takıma dağıtmayı istedi' };
  }

  // Direktif yok → SEZGİ. Varsayılan TEK ajan; fan-out DAR KAPI.
  if (sequential) {
    return { executor: 'single', directive: null, reason: 'adımlar sıralı (önce/sonra) — tek ajan sırayla yapar' };
  }
  if (!parallel) {
    return { executor: 'single', directive: null, reason: 'açık paralel sinyali yok — tek ajan (güvenli varsayılan)' };
  }
  return { executor: 'team', directive: null, reason: 'parçalar bağımsız ("ayrı ayrı"/"paralel" dendi)' };
}

// ── 4. Kaç ajan? (aritmetik — gerçek madde sayısı + gerçek roster ile) ───────

/**
 * Sınıf → pane sayısı. Yürütücü tarafında ÇAĞRILIR (gerçek plan bölümü + gerçek roster
 * orada bilinir). Roster boyutu TAVAN DEĞİLDİR: fan-out MAX_FANOUT ile de sınırlanır.
 */
function planWidth({ executor = 'single', itemCount = 1, rosterSize = 0 } = {}) {
  const items = Math.max(1, Number(itemCount) || 1);
  const roster = Math.max(0, Number(rosterSize) || 0);
  if (executor === 'self') return 0;
  if (roster === 0) return 0; // işçi yok → açacak pane de yok
  if (executor !== 'team') return 1;
  // DELEG-PAR-01 — TEK PARÇALI İŞ ARTIK "TEK AJAN" DEMEK DEĞİL. Eski satır `return 1`di:
  // kullanıcı takıma iki geliştirici ekleyip "paralel yapın" dese bile düz metin hedef
  // tek maddeye çözüldüğü için İKİNCİ AJAN HİÇ SEÇİLMİYORDU (gerçek müşteri geri
  // bildirimi 2026-08-23; kanıt: docs/agent-results/DELEG-PAR-01-evidence/repro-before.txt).
  // Kullanıcı niyeti kazanır (docs/rules/parallel-distribution.md §2): açık paralel
  // direktifi varsa bölme DENENİR. Bölünemeyen işte tavan İKİ ajandır — bir uygulayıcı +
  // bir tamamlayıcı (bağımsız doğrulama/test, defaultPlanner'ın verdiği rol). Üçüncü bir
  // ajan işi ikizler, token yakar (ADR-022: "çok ajan geri alınamaz").
  if (items < 2) return Math.min(roster, UNSPLIT_TEAM_WIDTH);
  return Math.max(1, Math.min(items, MAX_FANOUT, roster));
}

module.exports = {
  MAX_FANOUT,
  UNSPLIT_TEAM_WIDTH,
  SELF_RE,
  SINGLE_RE,
  TEAM_RE,
  detectDirective,
  isSequential,
  hasParallelSignal,
  decideExecutor,
  planWidth,
};
