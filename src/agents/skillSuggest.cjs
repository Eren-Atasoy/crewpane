// CrewPane — SK-06 (ADR-SKILL-CENTER Karar 5) AJANIN YAZMA UCU: bir görevden çıkan
// TEKRARLANABİLİR YÖNTEM → `skill-drafts/` altına bir ÖNERİ.
//
// Bu modül depo mantığını YENİDEN YAZMAZ; SK-05'in (`skillAuthor.cjs`) kardeşidir ve
// tek bir fiili çağırır:
//
//   skillStore.writeDraft   → lint + kanonik SKILL.md + atomik yazım   (TEK yazma yolu)
//
// 🔑 NEDEN AYRI BİR MODÜL (SK-05 zaten taslak yazıyorken): yazan KİM olduğu bu ürünün
// güvenlik modelinin merkezinde. Kullanıcının yazdığı taslak bir NİYETTİR; bir ajanın
// yazdığı taslak bir ÖNERİDİR ve ajan her gün dış içerik okur (web, log, müşteri metni,
// issue). Dolaylı bir prompt enjeksiyonu bir ajanı zehirlerse, o ajanın yazdığı skill
// zehri KALICILAŞTIRIR ve ekibe yayar (ADR §7.2 T1). Bu yüzden ajan yazımı:
//   • yalnız TASLAĞA iner — `skills/`e yazan bir API burada da AÇILMAZ,
//   • PROVENANS ZORUNLUDUR (hangi görev + hangi gerekçe) — kaynağı olmayan bir öneri
//     incelenemez; incelenemeyen bir öneri onaylanamaz,
//   • damgası `crewpane.origin: ai` — SK-03'ün paneli bunu "AI önerisi" rozetiyle
//     ayırır, insan neye baktığını bilerek onaylar.
//
// ⛔ BU MODÜL YAYIN YAPMAZ. `publishDraft` / `reconcileEngineViews` burada ÇAĞRILMAZ ve
// require EDİLMEZ; kaynak nöbetçisi (skillSuggest.test.cjs) bunu ölçer. Yayın tek bir
// yerden geçer: SK-04'ün insan onay kartı (`skillApprove.cjs`, `skills:publish`).
//
// fs'e doğrudan dokunmaz (çağrılan modüller üzerinden) — unit test tmp dizinle koşar.

'use strict';

const F = require('./skillFormat.cjs');
const skillStore = require('./skillStore.cjs');
const skillAuthor = require('./skillAuthor.cjs'); // SK-08 (a) — TEK yazma boğazı

// ADR §6.1'in tetik kademeleri.
//
// T-C ("ölçülen tekrar") SK-07'de AÇILDI. SK-06 onu bilerek kapalı bırakmıştı: eşiğinin
// yanlış-pozitif oranı ölçülmeden sevk edilirse gürültülü öneriler kullanıcının tüm
// skill sistemine güvenini yakar. O ölçüm SK-07'de gerçek külliyatta yapıldı (975 fakt
// → 29 aday, %3,0; duyarlılık tablosu `docs/agent-results/SK-07-inferno.md`) ve kapı
// aşağıda İKİ ayakla açıldı: (1) eşik `skillMemoryRepeat.cjs`de ölçülü, (2) T-C için
// `sourceMemory` ZORUNLU — kaynağı gösterilmeyen bir "tekrar" iddiası denetlenemez.
const TRIGGERS = Object.freeze({
  'T-A': 'kullanıcı/lider açıkça istedi',
  'T-B': 'görev kapanışında tekrarlanabilir yöntem çıktı (açık işaretli)',
  'T-C': 'hafızada ölçülen tekrar (SK-07 — kaynak hafıza ZORUNLU)',
});

/** Kabul edilen tetik mi? Bilinmeyen/boş/T-C → false (sessiz kabul YOK). */
function isKnownTrigger(trigger) {
  return typeof trigger === 'string' && Object.prototype.hasOwnProperty.call(TRIGGERS, trigger.trim().toUpperCase());
}

function normTrigger(trigger) {
  return String(trigger || '').trim().toUpperCase();
}

function oneLine(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function err(code, message, extra) {
  return { ok: false, errors: [{ code, message, ...(extra || {}) }], warnings: [] };
}

/**
 * Öneri gövdesi — "ne zaman / nasıl / kaynak" iskeleti. Saf.
 *
 * 🔑 NEDEN ŞABLON: bir skill "hatırlatmaz, YAPTIRIR" (ADR T5). Serbest metin bırakılırsa
 * ajanlar bir ÖZET yazar ("şunu öğrendim") — o bir hafıza faktıdır, skill değil. Şablon
 * soruyu değiştirir: *ne zaman* devreye girer + *hangi adımlarla* uygulanır. `whenToUse`
 * ve en az bir adım YOKSA gövde üretilmez (aşağıda hata) — yarım bir yordam, yanlış bir
 * yordamdır.
 *
 * `sourceTask`/`rationale` gövdeye de yazılır: frontmatter'daki damga UI içindir, gövdedeki
 * "Kaynak" bölümü ajanın BAĞLAMINA girer — skilli okuyan ajan nereden geldiğini görür.
 */
function composeSuggestionBody({ title, whenToUse, steps, rationale, sourceTask, sourceTaskTitle, evidence } = {}) {
  const head = oneLine(title);
  const when = String(whenToUse == null ? '' : whenToUse).trim();
  const list = Array.isArray(steps) ? steps.map((s) => String(s == null ? '' : s).trim()).filter(Boolean) : [];
  const out = [];
  if (head) out.push(`# ${head}`, '');
  out.push('## Ne zaman kullan', '', when, '');
  out.push('## Nasıl', '');
  list.forEach((s, i) => out.push(`${i + 1}. ${s}`));
  out.push('');
  const ev = String(evidence == null ? '' : evidence).trim();
  if (ev) out.push('## Kanıt / ölçüm', '', ev, '');
  out.push('## Kaynak', '');
  out.push(`Bu yordam **${oneLine(sourceTask)}** görevinde çıktı${sourceTaskTitle ? ` (${oneLine(sourceTaskTitle)})` : ''}.`);
  const why = oneLine(rationale);
  if (why) out.push('', `**Neden skill:** ${why}`);
  out.push('');
  return out.join('\n');
}

/**
 * AJAN ÖNERİSİ YAZ — bu modülün TEK yazma fiili ve tek çıkışı `skill-drafts/`.
 *
 * @param {object}   o
 * @param {string}   o.workspaceRoot
 * @param {string}   o.name            slug (dizin adı = frontmatter `name`)
 * @param {string}   o.description     bir satır — motor skilli BUNA bakarak seçer
 * @param {string}   o.agent           ÖNEREN ajan (provenans; boş olamaz)
 * @param {'T-A'|'T-B'} o.trigger      hangi tetik kademesi (bilinmeyen → red)
 * @param {string}   o.sourceTask      HANGİ GÖREVDEN çıktı (board kodu) — ZORUNLU
 * @param {string}   o.rationale       NEDEN skill olmalı (bir cümle) — ZORUNLU
 * @param {string}  [o.sourceTaskTitle]
 * @param {string}  [o.whenToUse]      gövde şablonu için (body verilmediyse ZORUNLU)
 * @param {string[]}[o.steps]          gövde şablonu için (body verilmediyse ≥1 ZORUNLU)
 * @param {string}  [o.evidence]
 * @param {string}  [o.body]           hazır gövde (şablonu atlar)
 * @param {string}  [o.sourceMemory]   memory→skill terfisinde kaynak fakt (ADR §6.2)
 * @param {string}  [o.now]            ISO damga (test enjekte eder)
 * @returns {{ok:boolean, name?:string, dir?:string, file?:string, scope?:'draft',
 *            trigger?:string, pendingApproval?:true, errors:Array, warnings:Array}}
 *
 * `pendingApproval: true` cevabın parçasıdır ve BİLEREK sabittir: bu fonksiyonun
 * "yayınlandı" diyebileceği bir yol yoktur. Çağıran (CLI/ajan) bunu okuyup kullanıcıya
 * "onay bekliyor" der — "skill eklendi" DEMEZ.
 */
function suggestDraft({
  workspaceRoot,
  name,
  description,
  agent,
  trigger,
  sourceTask,
  sourceTaskTitle,
  rationale,
  whenToUse,
  steps,
  evidence,
  body,
  sourceMemory,
  now,
} = {}) {
  if (!skillStore.draftsRoot(workspaceRoot)) {
    return err('no-workspace', 'workspaceRoot yok/geçersiz — taslak nereye yazılacağı bilinmiyor');
  }

  // — TETİK KAPISI: v1'de yalnız AÇIK işaret. Bilinmeyen/boş tetik sessizce "olsun"
  //   diye geçmez; T-C açıkça reddedilir ve NEDENİ söylenir (SK-08'e işaret).
  const tr = normTrigger(trigger);
  if (!isKnownTrigger(tr)) {
    const known = Object.keys(TRIGGERS).join(' | ');
    return err('bad-trigger', `Bilinmeyen tetik: ${trigger || '(boş)'} — kabul edilenler: ${known}`);
  }
  // — SK-07 KAYNAK KAPISI: T-C'nin iddiası "bu yordam hafızada TEKRARLANDI"dır. O iddia
  //   yalnız kaynağı gösterilirse denetlenebilir; damgasız bir T-C, insanın doğrulayamadığı
  //   bir "ölçtüm" beyanı olurdu. T-A/T-B'de kaynak hafıza opsiyonel kalır (onların iddiası
  //   hafıza değil, açık işarettir).
  if (tr === 'T-C' && !oneLine(sourceMemory)) {
    return err('source-memory-missing', 'T-C (ölçülen tekrar) için kaynak hafıza ZORUNLU — hangi faktten türedi?');
  }

  // — PROVENANS KAPISI: kaynağı olmayan öneri incelenemez. Bu alanlar UI'da
  //   gösterilir; boş bırakılabilseydi rozet "AI önerisi" der, insan neyi
  //   onayladığını bilmezdi.
  const who = oneLine(agent);
  if (!who) return err('agent-missing', 'ÖNEREN ajan zorunlu (provenans damgası)');
  const task = oneLine(sourceTask);
  if (!task) return err('source-task-missing', 'Kaynak görev zorunlu — bu yordam HANGİ görevden çıktı?');
  const why = oneLine(rationale);
  if (!why) return err('rationale-missing', 'Gerekçe zorunlu — NEDEN skill olmalı (bir cümle)?');

  const slug = F.safeName(name);
  if (!oneLine(name) || slug === 'unnamed-skill') {
    // 🪤 SK-05'in dersi: `safeName` boş girdide 'unnamed-skill' üretir — kütüphane için
    // doğru varsayılan, yazma ucu için tuzak. Sessiz slug YOK.
    return err('name-invalid', 'Ad zorunlu ve slug olmalı (küçük harf/rakam/tire)');
  }

  // — ÇAKIŞMA: sessizce üzerine yazmak, incelenmemiş bir öneriyi incelenmiş bir
  //   önerinin yerine koyardı. Aynı adla yayında bir skill varsa da red: ajan
  //   yayındakini "güncelleyemez" (bu bir düzenleme kararıdır, insanın işi).
  if (skillStore.readSkill(workspaceRoot, slug, 'draft')) {
    return err('draft-exists', `Bu adla bir taslak zaten var: ${slug}`, { scope: 'draft' });
  }
  if (skillStore.readSkill(workspaceRoot, slug, 'published')) {
    return err('already-published', `Bu adla YAYINDA bir skill var: ${slug} — güncelleme insanın kararıdır`, {
      scope: 'published',
    });
  }

  let text = String(body == null ? '' : body).trim();
  if (!text) {
    const when = String(whenToUse == null ? '' : whenToUse).trim();
    const list = Array.isArray(steps) ? steps.map((s) => String(s == null ? '' : s).trim()).filter(Boolean) : [];
    if (!when) return err('when-missing', '`whenToUse` zorunlu — skill NE ZAMAN devreye girer?');
    if (!list.length) return err('steps-missing', 'En az bir adım zorunlu — skill NASIL uygulanır?');
    text = composeSuggestionBody({
      title: slug,
      whenToUse: when,
      steps: list,
      rationale: why,
      sourceTask: task,
      sourceTaskTitle,
      evidence,
    });
  }

  const metadata = {
    'crewpane.origin': 'ai', // → SK-03 paneli "AI önerisi" rozetini BUNA bakarak seçer
    'crewpane.author': who,
    'crewpane.task': task,
    'crewpane.trigger': tr,
    'crewpane.rationale': why,
    'crewpane.suggestedAt': oneLine(now) || new Date().toISOString(),
  };
  if (oneLine(sourceMemory)) metadata['crewpane.sourceMemory'] = oneLine(sourceMemory);

  // ── SK-08 (a) — TEK YAZMA BOĞAZI: `skillAuthor.saveDraft` ──────────────────
  // Eskiden burada `skillStore.writeDraft` DOĞRUDAN çağrılıyordu. Yanlış değildi
  // (doğru dizine yazıyordu) ama boğazı ikiye bölüyordu: SK-08'in sır taraması gibi
  // "her yazımda çalışmalı" bir kural, iki ayrı yere konmayı ve birini unutmayı
  // mümkün kılıyordu. Artık AI yolu da kullanıcı yolunun geçtiği kapıdan geçer →
  // damga süzme + statü çivileme + sır taraması BEDAVA gelir (nöbetçi: skillGuard).
  //
  // Ad çakışması yukarıda ZATEN kontrol edildi (bu modülün kendi hata kodlarıyla);
  // `mode:'create'` oradaki kararı tekrar eder, değiştirmez.
  const res = skillAuthor.saveDraft({
    workspaceRoot,
    name: slug,
    description,
    body: text,
    mode: 'create',
    origin: 'ai',
    metadata,
  });
  if (!res.ok) return { ok: false, errors: res.errors || [], warnings: res.warnings || [] };

  return {
    ok: true,
    name: res.name,
    dir: res.dir,
    file: res.file,
    scope: 'draft',
    trigger: tr,
    pendingApproval: true, // sabit: bu modülün "yayınlandı" diyebileceği yol YOK
    errors: [],
    warnings: res.warnings || [],
  };
}

module.exports = { TRIGGERS, isKnownTrigger, composeSuggestionBody, suggestDraft };
