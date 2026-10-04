// CrewPane — SK-08 (ADR-SKILL-CENTER §7.2 T6 + SK-08 (a)) ONAY KAPISININ NÖBETÇİSİ.
//
// Onay kapısı DİZİN seviyesindedir (ADR §3): `skill-drafts/` hiçbir motor yoluna bağlı
// değil, `skills/` bağlı. Bu kapının iki atlatma yolu vardır ve İKİSİ DE SESSİZDİR:
//
//   Yol 1 (çalışma zamanı, T6) — bir ajan dosyayı DOĞRUDAN `skills/`e ya da doğrudan
//     `~/.claude/skills/<ad>/`e yazar. Lint çalışmaz, onay damgası basılmaz, kimse
//     bir şey görmez; skill bir sonraki oturumda tüm ajanların bağlamındadır.
//   Yol 2 (kaynak zamanı, (a)) — yeni bir modül `skillStore.writeDraft`i doğrudan
//     çağırır ve boğazın değişmezlerini (damga süzme, sır taraması) ATLAR.
//
// Bu modül ikisini de ÖLÇÜLEBİLİR yapar: biri diski, diğeri kaynağı denetler.
//
// 🔑 "ONAYLANMIŞ"IN TANIMI BİR DAMGADIR: `publishDraft` her yayında `reviewedBy` +
// `reviewedAt` basar. Yayındaki bir skill bu damgayı TAŞIMIYORSA oraya `approveDraft`
// ile gelmemiştir — elle kopyalanmıştır. Damga taklit edilebilir mi? Evet, ama taklit
// için dosyayı elle düzenlemek gerekir ve o da bu denetimin ikinci ayağına (motor
// görünümü gerçekten kanonik depoya mı bakıyor) yakalanır. Amaç kriptografik kanıt
// değil, SESSİZLİĞİ BİTİRMEK: her atlatma en az bir yerde GÖRÜNÜR olsun.
//
// SAF tarafı saf: kaynak taraması yalnız verilen metinler üzerinde çalışır.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const skillStore = require('./skillStore.cjs');

/** Yayında olmak için TAŞINMASI ZORUNLU damgalar (publishDraft basar). */
const REQUIRED_PUBLISH_STAMPS = Object.freeze(['crewpane.reviewedBy', 'crewpane.reviewedAt']);

/**
 * SK-08 (a) KAYNAK NÖBETÇİSİ — ayrıcalıklı fiilleri kimin çağırdığı.
 *
 * `skillStore.writeDraft` yalnız `skillAuthor.cjs`ten, `publishDraft` yalnız
 * `skillApprove.cjs`ten çağrılabilir. Yeni bir çağıran = ikinci boğaz = atlanabilir kural.
 *
 * 🪤 BU NÖBETÇİ DAHA ÖNCE KENDİ YORUMUNU YAKALADI (ADP: source-sentinel-matches-own-
 * justification): "neden yasak" diye anlatan yorum satırı, yasaklı jetonu İÇERİR ve
 * sahte kırmızı verir. Bu yüzden tarama YORUMLARI SÖKER ve yalnız KULLANIM sözdizimini
 * (`skillStore.writeDraft(`) arar — düz kelime eşleşmesi değil.
 *
 * 🪤 VE İKİNCİ KEZ YAKALADI — bu sefer AŞAĞIDAKİ TABLONUN KENDİSİNİ: kural tablosu
 * yasaklı jetonu bir DİZE LİTERALİ olarak taşımak zorundadır ve yorum sökmek onu
 * temizlemez. Kusur ancak dosya COMMIT'LENİNCE göründü (kapı `git ls-files` ile
 * sınırlı → takipsizken kendi kaynağını hiç ölçmüyordu): "yamalı ağaçta yeşil ≠
 * commit'te yeşil". Çözüm dosyayı kapsam dışı bırakmak DEĞİL (o zaman nöbetçi tek
 * denetlenmeyen dosya olurdu) — DİZE İÇERİKLERİNİ boşaltmak: gerçek bir çağrı asla
 * tırnak içinde olamaz, dolayısıyla dişi kaybetmeden yanlış-pozitif ölür.
 */
const PRIVILEGED = Object.freeze([
  { call: 'skillStore.writeDraft(', allow: ['skillAuthor.cjs'], why: 'taslak yazımı TEK boğazdan (damga süzme + sır taraması)' },
  { call: 'skillStore.publishDraft(', allow: ['skillApprove.cjs'], why: 'yayın TEK onay fiilinden (sır taraması + geçmiş kaydı)' },
]);

/** Blok ve satır yorumlarını söker (dize içindeki `//` korunur — kaba ama yeterli). */
function stripComments(src) {
  let out = String(src == null ? '' : src).replace(/\/\*[\s\S]*?\*\//g, '');
  out = out
    .split('\n')
    .map((line) => {
      let inS = null;
      for (let i = 0; i < line.length; i += 1) {
        const c = line[i];
        if (inS) {
          if (c === '\\') i += 1;
          else if (c === inS) inS = null;
        } else if (c === '"' || c === "'" || c === '`') inS = c;
        else if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
  return out;
}

/**
 * Tek/çift tırnaklı dize literallerinin İÇERİĞİNİ boşaltır (tırnaklar kalır).
 *
 * Şablon literali (`) KASTEN dokunulmaz: içinde `${...}` ile GERÇEK kod yaşayabilir
 * ve onu boşaltmak nöbetçinin dişini körletirdi. Kural tablosu ve mesaj metinleri
 * tek tırnak kullandığı için bu kadarı yeter.
 */
function stripStringLiterals(src) {
  return String(src == null ? '' : src).replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, (m) => m[0] + m[0]);
}

/**
 * Kaynak dosyalarını tara.
 * @param {Array<{file:string, text:string}>} files — çağıran `git ls-files` ile SINIRLAR
 *        (commit'lenmemiş komşu dosyası ürün değildir — crewpane-test-gate-blindspots v14)
 * @returns {{ok:boolean, violations:Array}}
 */
function scanWritePaths(files) {
  const violations = [];
  for (const f of Array.isArray(files) ? files : []) {
    const base = path.basename(f.file || '');
    if (base.includes('.test.')) continue; // testler kasten doğrudan çağırır (birim kapsamı)
    const code = stripStringLiterals(stripComments(f.text));
    for (const rule of PRIVILEGED) {
      if (!code.includes(rule.call)) continue;
      if (rule.allow.includes(base)) continue;
      violations.push({
        file: f.file,
        call: rule.call.replace(/\($/, ''),
        allowed: rule.allow,
        message: `${f.file} → \`${rule.call.replace(/\($/, '')}\` doğrudan çağrılıyor; izinli tek çağıran: ${rule.allow.join(', ')} (${rule.why})`,
      });
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * ÇALIŞMA ZAMANI DENETİMİ (T6) — yayındaki her skill onay kapısından mı geçmiş?
 *
 * @returns {{ok:boolean, checked:number, findings:Array}}
 *   finding.kind: 'unapproved-published' → damgasız yayın (elle kopyalanmış)
 *                 'invalid-published'    → yayındaki dosya lint'ten geçmiyor
 */
function auditPublished(workspaceRoot) {
  const findings = [];
  const list = skillStore.listSkills(workspaceRoot, { scope: 'published' });
  for (const rec of list) {
    const meta = (rec.frontmatter && rec.frontmatter.metadata) || {};
    const missing = REQUIRED_PUBLISH_STAMPS.filter((k) => !meta[k]);
    if (missing.length) {
      findings.push({
        kind: 'unapproved-published',
        name: rec.name,
        file: rec.file,
        missing,
        message: `\`${rec.name}\` yayında ama onay damgası yok (${missing.join(', ')}) — onay kapısından geçmemiş olabilir`,
      });
    }
    if (!rec.ok) {
      findings.push({
        kind: 'invalid-published',
        name: rec.name,
        file: rec.file,
        message: `\`${rec.name}\` yayında ama SKILL.md lint'ten geçmiyor — elle düzenlenmiş olabilir`,
      });
    }
  }
  return { ok: findings.length === 0, checked: list.length, findings };
}

// ⛔ MOTOR DİZİNİ DENETİMİ BURADA YOK — VE BU BİLİNÇLİ.
//
// SK-08'de bu modüle bir `auditEngineDir` yazıldı, sonra ÖLÇÜLDÜ ve SİLİNDİ:
// `skillEngineView.auditEngineViews` (SK-03, ADR R8+T6) aynı işi ZATEN yapıyor ve
// DAHA İYİ yapıyor — çünkü ad-farkındalı: motor dizinindeki yabancı ama bizim
// depomuzla ÇAKIŞMAYAN girdileri (codex'in `.system`i gibi) ihlal saymaz. Benim
// yazdığım sürüm "sembolik bağ değilse ihlal" diyordu ve o dizinlere yanlış alarm
// basardı. İkinci bir kapı, birincisinden zayıfsa güvenlik EKLEMEZ — gürültü ekler
// ve gürültü kapıyı kapattırır.
//
// ⇒ Motor dizini sorusu: `skillEngineView.auditEngineViews({ workspaceRoot })`.
//    Bu modülün sorusu: "yayındaki dosya onay DAMGASI taşıyor mu" (orada karşılığı yok).

module.exports = {
  REQUIRED_PUBLISH_STAMPS,
  PRIVILEGED,
  stripComments,
  stripStringLiterals,
  scanWritePaths,
  auditPublished,
};
