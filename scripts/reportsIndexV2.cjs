// REPORTS-V2-A1 — YEREL rapor indeks katmanı (dört alan: tip · sahip · görev bağı · görünürlük).
//
// NE YAPAR. `docs/agent-results/*.md` korpusunu OKUR ve her rapor için bir kayıt türetir:
// tip (hata · araştırma · yayın · ölçüm · karar · rehber · diğer), sahip (takım + ajan),
// görev bağı (board kodları, çoklu) ve görünürlük (varsayılan `özel`). Çıktı TEK dosyadır:
// `<results-dir>/REPORTS-INDEX.json`.
//
// NE YAPMAZ — ve bu bir kapıdır, üslup değil: **hiçbir `.md` dosyasına YAZMAZ.** Bu dosyada
// `.md` yazan tek bir çağrı yoktur (kapı: `npm run test:reports-index-v2` içindeki
// "yazma yüzeyi" testi). Rapor metni ajanların tek gerçeğidir (ADR §2.7: düz metin,
// grep'lenebilir, motor bağımsız); v2 katmanı onun YANINA durur, ÜSTÜNE değil.
//
// NEDEN AYRI DOSYA, METNE ÖN-BİLGİ EKLEMEK DEĞİL. ADR §7.2 Faz 2 "ön-bilgi ekle" diyordu;
// Murat'ın 21.09 kararı (kart TASK-MUAU2RC3CIGUR) bunu daralttı: "mevcut raporların
// metnine dokunulmaz". Sapma BİLEREKtir ve kartın doğrulama maddesi onu şart koşuyor
// ("Metin dosyalarına yazım 0"). Kazanç: göç geri alması `git revert` değil tek dosya
// silmektir (`--revert`), ve 1 899 dosyanın hiçbirinin sha256'sı değişmez.
//
//   node scripts/reportsIndexV2.cjs --dry-run     → yazmaz; ölçüm tablosunu basar
//   node scripts/reportsIndexV2.cjs               → REPORTS-INDEX.json yazar
//   node scripts/reportsIndexV2.cjs --revert      → indeksi SİLER (dosyalar bit-bit aynı)
//   node scripts/reportsIndexV2.cjs --board-ids <dosya>  → bayat görev kodu tespiti
//
// `--root <dir>` / `RESULTS_INDEX_ROOT` kökü çözer — `resultsIndex.cjs` ile AYNI
// fonksiyon (RES-IDX-01 deseni yeniden kullanıldı, ikinci bir uygulama yazılmadı).
//
// PAYLAŞIMLI AĞAÇ. Üretim saf türetimdir (`readdirSync` → diskte NE VARSA o): komşuların
// commit'lenmemiş raporları da indekse girer, hiçbiri silinmez. `--commit` jesti
// TREE-CLOBBER-01 kuralına uyar (yalnız indeks dosyasının yolu, `git add -A` yok).

const fs = require('node:fs');
const path = require('node:path');
const {
  parseFileName,
  extractTitle,
  extractSprint,
  hasEvidence,
  teamOf,
  resolveRepoRoot,
  AGENTS,
} = require('./resultsIndex.cjs');
// REPORT-GATE-01 — KANIT KAPISI. A1 kapıyı YAZMAZ, ÇAĞIRIR: hüküm sınıfı, dört kanıt
// kategorisi ve yarım-şablon tespiti tek dosyada (`reportEvidenceGate.cjs`) durur ve
// aynı dosyayı `electron/delegationSupervisor.cjs` de çağırır. İki tüketici, TEK gerçek.
const { gateReport, gateEnabled, KOVALAR } = require('./reportEvidenceGate.cjs');
// RPT5-07a — HTML raporun sayfası + ek klasörü kapıya verilir (sözleşme v3 §6.8).
const { gatePageInput } = require('../electron/reportHtmlText.cjs');

const INDEX_NAME = 'REPORTS-INDEX.json';
const RESULTS_REL = path.join('docs', 'agent-results');
const SCHEMA_VERSION = 2;

/** Kartın tip sözlüğü. `diğer` = sınıflandırılamadı (uydurma yok). */
const TYPES = Object.freeze(['hata', 'araştırma', 'yayın', 'ölçüm', 'karar', 'rehber', 'diğer']);

/** Görünürlük — varsayılan `özel`; göç HİÇBİR raporu başka değere taşımaz (Murat 21.09). */
const DEFAULT_VISIBILITY = 'özel';

// ─── saf çıkarıcılar ──────────────────────────────────────────────────────────

/** Raporun ZORUNLU altı başlığından kaçı var? Rapor-yapısı sinyali (rehber ayrımı). Pure. */
function reportStructureScore(md) {
  const text = md || '';
  const marks = [
    /^#{1,4}\s*\d*[.)]?\s*(ne yapıldı|what was done)/im,
    /^#{1,4}\s*\d*[.)]?\s*(kanıt|kanit|evidence)/im,
    /^#{1,4}\s*\d*[.)]?\s*(değişen dosyalar|degisen dosyalar|changed files)/im,
    /^#{1,4}\s*\d*[.)]?\s*(riskler|risks)/im,
    /^#{1,4}\s*\d*[.)]?\s*(açık sorular|acik sorular|open questions)/im,
    /^#{1,4}\s*\d*[.)]?\s*(sonraki adım|sonraki adim|next step)/im,
  ];
  return marks.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
}

/** 2. tekil emir kipi adım yoğunluğu (rehber sinyali: "aç", "tıkla", "gir"…). Pure. */
function imperativeStepScore(md) {
  const text = md || '';
  const numbered = (text.match(/^\s{0,3}\d+[.)]\s+\S/gm) || []).length;
  const imper = (
    text.match(
      /(^|[\s(])(aç|açın|tıkla|tıklayın|gir|girin|yaz|yazın|kur|kurun|indir|indirin|kopyala|kopyalayın|çalıştır|çalıştırın|seç|seçin|kaydet|kaydedin|bekle|bekleyin)\b/gim,
    ) || []
  ).length;
  return { numbered, imper };
}

/** Başlık/dosya adında rehber anahtar kelimesi var mı? Pure. */
const GUIDE_WORD = /(rehber|kılavuz|kilavuz|talimat|playbook|runbook|kurulum|nasıl yapılır|nasil yapilir|how\s?to|step[- ]by[- ]step|guide)/i;

/**
 * GÖREV RAPORU iskeleti sinyalleri. Altı zorunlu başlık yalnız raporların %54'ünde var
 * (ADR §2.2), yani "başlık yok → rehberdir" YANLIŞ bir çıkarım olurdu; ölçtük: yalnız
 * başlık sayısına bakan ilk sürüm 57 rapordan 42'sini yanlış sınıfladı (QA incelemesi,
 * tasarım raporu, e-posta tetikleyici raporu…). Bu yüzden ikinci bir negatif kapı var:
 * görev raporunun ETRAFINDAKİ meta (kart kodu, ajan, sprint, platform beyanı, kanıt
 * bölümü). Rehberde bunlar YOKTUR — rehber okura yazılır, panoya değil. Pure.
 */
function reportSignalScore(md) {
  const text = md || '';
  const sig = [
    /\*\*(Kart|Board|Görev|Gorev|Task):?\*\*/i,
    /\*\*(Ajan|Agent):?\*\*/i,
    /\*\*Sprint:?\*\*/i,
    /PLATFORM BEYANI/i,
    /^#{1,4}\s*\d*[.)]?\s*(kanıt|kanit|evidence|doğrulama|dogrulama)/im,
    /^#{1,4}\s*\d*[.)]?\s*(değişen dosyalar|degisen dosyalar|riskler|açık sorular|acik sorular|sonraki adım|sonraki adim|ne yapıldı)/im,
  ];
  return sig.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
}

/**
 * Rehber mi? — kart §3. ANAHTAR KELİME TEK BAŞINA YETMEZ: bu depoda "rehber" kelimesi
 * ÜRÜNÜN KENDİ ÖZELLİĞİNİN adıdır ("rehberli tur", TOUR-*), yani `rehber` geçen raporların
 * çoğu rehber DEĞİL, rehber ÖZELLİĞİ HAKKINDA hata/ölçüm raporudur. Ayrımı YAPI yapar:
 * gerçek rehber okura adım anlatır ve görev-raporu iskeletini (kart · ajan · sprint ·
 * kanıt · platform beyanı) TAŞIMAZ.
 *
 * KASITLI TERCİH — kesinlik > kapsam: "anahtar kelimesiz ama adım yoğun" kolu ÖLÇÜLDÜ ve
 * KALDIRILDI (42 yanlış-pozitif / 42). Bedeli: başlığında hiçbir rehber kelimesi olmayan
 * bir rehber kaçar. Kazancı: `rehber` kovası güvenilir. Ölçüm raporda. Pure.
 */
function isGuide(md, filename) {
  const title = firstHeading(md);
  const hay = `${filename || ''} ${title}`;
  const wordHit = GUIDE_WORD.test(hay);
  const reportSig = reportSignalScore(md);
  const structure = reportStructureScore(md);
  const { numbered, imper } = imperativeStepScore(md);
  // Dosya ADI türü beyan eden ayrı bir sinyaldir (kart §3: `docs/design/*PROMPT*`):
  // `…-PROMPT.md`, `…-TALIMAT.md`, `REHBER-…md`. Rapor iskeleti varsa yine reddedilir.
  const nameDeclares = /(^|[-_])(prompt|brief|talimat|rehberi?|guide|kilavuz|kılavuz|playbook|runbook)([-_.]|$)/i.test(
    String(filename || ''),
  );
  if (!wordHit && !nameDeclares) return { guide: false, reason: 'kelime-yok' };
  if (reportSig >= 2) return { guide: false, reason: `görev-raporu(${reportSig})` };
  if (nameDeclares && structure === 0 && reportSig <= 1) return { guide: true, reason: 'dosya-adı-beyanı' };
  if (structure >= 2) return { guide: false, reason: `rapor-iskeleti(${structure})` };
  if (numbered >= 3 && imper >= 3) return { guide: true, reason: 'başlık+adım+emir' };
  if (imper >= 6) return { guide: true, reason: 'başlık+emir-yoğun' };
  return { guide: false, reason: `kelime-var-yapı-yok(${numbered}/${imper})` };
}

/** İlk `# ` başlığı (ham). Pure. */
function firstHeading(md) {
  const m = /^#\s+(.+)$/m.exec(md || '');
  return m ? m[1].trim() : '';
}

/**
 * Ön-bilgi bloğu (`---` … `---`) → düz anahtar/değer. Sözleşme v2 alanları BURADAN okunur;
 * ajan beyan ettiyse hiçbir şey tahmin edilmez. `reports.ts splitFrontmatter` ile aynı
 * tolerans (tek satırlık değerler; blok skaler desteklenmez). Pure.
 */
function frontmatter(md) {
  const out = {};
  const m = /^\uFEFF?---\s*\n([\s\S]*?)\n---\s*(\n|$)/.exec(md || ''); // BOM: MEM-CRLF-01 (reportSchema ile aynı)
  if (!m) return out;
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-zÇĞİÖŞÜçğıöşü0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) out[kv[1].toLowerCase()] = kv[2].trim();
  }
  return out;
}

/**
 * PLATFORM BEYANI — protokolde ZORUNLU ama ölçüldü: raporların %10'unda var (ADR §2.2).
 * Alan olarak taşınınca EKSİKLİĞİ ölçülebilir hale gelir. Ön-bilgi → gövdedeki
 * "PLATFORM BEYANI …" satırı → yok. Pure.
 */
function extractPlatform(md, fm) {
  const declared = (fm && (fm['platform'] || fm['platformlar'])) || '';
  if (declared) return { platform: oneSentence(declared), kaynak: 'ön-bilgi' };
  const m = /\*{0,2}PLATFORM BEYANI\*{0,2}\s*[:—-]?\s*([^\n]{4,240})/i.exec(md || '');
  if (m) return { platform: oneSentence(m[1]), kaynak: 'gövde' };
  return { platform: null, kaynak: 'yok' };
}

/** Rapor meta satırındaki `**Tip:** …` BEYANI (yoksa ''). Pure. */
function declaredType(md) {
  const m = /\*\*Tip:?\*\*\s*([^·|\n*]{1,40})/.exec(md || '');
  return m ? m[1].trim().toLowerCase().replace(/\s+/g, ' ') : '';
}

/** Beyan edilen tip → kart sözlüğü. Eşlenemeyen beyan '' döner (sessiz düşürme yok). Pure. */
function mapDeclaredType(decl) {
  if (!decl) return '';
  const d = decl.split(/[\/,(]/)[0].trim();
  if (/^(bug|bugfix|hata|fix|regres|crash|çök|incident|inc)\b/.test(d)) return 'hata';
  if (/^(spike|araştırma|arastirma|araştirma|research|keşif|kesif|inceleme)\b/.test(d)) return 'araştırma';
  if (/^(release|yayın|yayin|sürüm|surum|rc|hotfix)\b/.test(d)) return 'yayın';
  if (/^(ölçüm|olcum|olçum|measure|benchmark|denetim|audit|sayım|envanter|qa|test)\b/.test(d)) return 'ölçüm';
  if (/^(karar|decision|adr|tasarım|tasarim|design|mimari)\b/.test(d)) return 'karar';
  if (/^(rehber|kılavuz|guide|playbook|runbook|talimat)\b/.test(d)) return 'rehber';
  return '';
}

/**
 * Tip sınıflandırıcı. Sıra: (1) rehber yapı kapısı, (2) BEYAN (`**Tip:**`), (3) içerik
 * kalıpları, (4) `diğer`. Kaynağı da döner — "nereden bildin" raporda ölçülebilsin. Pure.
 */
function classifyType(md, filename) {
  // Sözleşme v2 beyanı HER ŞEYDEN önce gelir — ajan tipi yazdıysa tahmin edilmez.
  const fmTip = mapDeclaredType(String(frontmatter(md).tip || frontmatter(md).type || '').toLowerCase());
  if (fmTip) return { tip: fmTip, kaynak: 'ön-bilgi' };

  const g = isGuide(md, filename);
  if (g.guide) return { tip: 'rehber', kaynak: `yapı:${g.reason}` };

  const decl = mapDeclaredType(declaredType(md));
  if (decl) return { tip: decl, kaynak: 'beyan' };

  const title = firstHeading(md);
  const name = filename || '';
  const head = (md || '').slice(0, 4000);
  const hay = `${name} ${title}`;

  if (/^(REL-|RELEASE-|HOTFIX-)/i.test(name) || /\b(yayın|yayin|release|sürüm|surum|notarize|dmg|installer|updater)\b/i.test(title))
    return { tip: 'yayın', kaynak: 'içerik:yayın' };
  if (/\b(bug|hata|çök|cok|crash|kırık|kirik|regres|düzelt|duzelt|fix|kök neden|kok neden|incident|kesinti)\b/i.test(hay) || /kök neden/i.test(head))
    return { tip: 'hata', kaynak: 'içerik:hata' };
  if (/\b(ölçüm|olcum|ölçül|ölçt|measure|benchmark|profil|envanter|sayım|sayim|metrik|latency|fps|denetim|audit|tarama)\b/i.test(hay))
    return { tip: 'ölçüm', kaynak: 'içerik:ölçüm' };
  if (/\b(adr|karar|decision|seçenek|secenek|1-3-1|öneri|oneri|mimari|tasarım|tasarim|strateji)\b/i.test(hay))
    return { tip: 'karar', kaynak: 'içerik:karar' };
  if (/\b(araştır|arastir|research|spike|keşif|kesif|inceleme|analiz|fizibilite)\b/i.test(hay))
    return { tip: 'araştırma', kaynak: 'içerik:araştırma' };
  return { tip: 'diğer', kaynak: 'yok' };
}

/**
 * Tek cümlelik hüküm. YALNIZ AÇIK sinyalden alınır (`**Hüküm:**`, `> **Tek cümlelik
 * hüküm:**`, `**Durum:**`, `**Kısa özet:**`). Bulunamazsa null — ADR §7.2: uydurma yok.
 * `kaynak` alanı hangi sinyalden geldiğini söyler; "ilk-paragraf" ikinci sınıf bir
 * türetimdir ve raporda AYRI sayılır. Pure.
 */
function extractVerdict(md) {
  const text = md || '';
  const fm = frontmatter(text);
  const fmH = fm['hüküm'] || fm['hukum'] || fm['verdict'];
  if (fmH) {
    const one = oneSentence(fmH);
    if (one) return { hukum: one, kaynak: 'ön-bilgi' };
  }
  const label = /^[>\s]*\**\s*(tek cümlelik hüküm|hüküm|hukum|kısa özet|kisa ozet|tl;dr|özet|ozet|durum)\b[^:]{0,40}:?\**\s*(.*)$/im;
  const m = label.exec(text);
  if (m) {
    let rest = m[2].trim();
    if (!rest) {
      // Etiket satırı boşsa bir sonraki dolu satır gövdedir.
      const lines = text.split('\n');
      const i = lines.findIndex((l) => label.test(l));
      for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
        const cand = lines[j].replace(/^[>\s*]+/, '').trim();
        if (cand) { rest = cand; break; }
      }
    }
    const one = oneSentence(rest);
    if (one) return { hukum: one, kaynak: `beyan:${m[1].toLowerCase()}` };
  }
  // İkinci sınıf: H1'den sonraki ilk gerçek paragraf — AMA meta satırı değil.
  //
  // ÖLÇÜLDÜ (6 örneklik el kontrolü): ilk sürüm `**` işaretlerini SÖKÜP sonra "meta mı"
  // diye baktığı için `**Ajan:** Bumblebee · **Board:** …` satırını hüküm sanıyordu —
  // 6 örnekten 5'i meta satırıydı. Kalın işaretleri sökmeden ÖNCE bakılır; ayrıca
  // `·` ile ayrılmış iki anahtarlı satır (meta şeridi) tümden reddedilir.
  const META_KEY = /(Kart|Ajan|Agent|Sprint|Tarih|Date|Board|Dal|Branch|Taban|Sürüm|Surum|Commit|Tip|Tür|Tur|Durum|Görev|Gorev|Proje|Project|Kod|Hedef|Platform|Worktree)\s*:/i;
  const afterH1 = text.split(/^#\s+.+$/m)[1] || '';
  for (const para of afterH1.split(/\n\s*\n/)) {
    const raw = para.replace(/^[>\s]+/, '').replace(/^[-–*]\s+/, '').trim();
    if (!raw) continue;
    if (/^\*{0,2}\s*/.test(raw) && META_KEY.test(raw.slice(0, 40))) continue; // meta ile BAŞLIYOR
    if ((raw.match(META_KEY) || []).length && raw.includes('·')) continue; // meta şeridi
    const p = raw.replace(/^[*_`]+/, '');
    if (/^[|#`]/.test(p) || /^-{3,}$/.test(p)) continue;
    const one = oneSentence(p);
    if (one && one.length >= 25 && !META_KEY.test(one.slice(0, 30))) {
      return { hukum: one, kaynak: 'ilk-paragraf' };
    }
  }
  return { hukum: null, kaynak: 'yok' };
}

/** Markdown gürültüsünü temizleyip İLK cümleyi döndür (≤240 karakter). Pure. */
function oneSentence(raw) {
  const clean = (raw || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // RPT4-12 (RPT4-02 B3) — alt çizgi YALNIZ vurgu işaretiyse düşer: "rapor_yaz"
    // gibi tanımlayıcının İÇİNDEKİ alt çizgi korunur ("raporyaz" görünüyordu).
    .replace(/[*`>]/g, '')
    .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return null;
  const cut = /(.+?[.!?])(\s|$)/.exec(clean);
  const s = (cut ? cut[1] : clean).trim();
  return s.length > 240 ? s.slice(0, 237).trimEnd() + '…' : s;
}

/** Board görev kodu deseni: `TASK-XXXX`, `ADP-123`, `REPORTS-V2-A1` gibi. Pure. */
const TASK_CODE = /\b(TASK-[A-Z0-9]{6,}|ADP-\d+[A-Za-z]?|[A-Z][A-Z0-9]{1,}(?:-[A-Z0-9]{1,}){1,4}-\d+[A-Za-z]?|[A-Z][A-Z0-9]{2,}-\d+[A-Za-z]?)\b/g;

/**
 * Raporun bağlı olduğu görev kodları — ÇOKLU. Kaynak sırası: dosya adı (kanonik
 * `<KOD>-<ajan>.md`), `**Kart:**` / `**Board:**` meta satırı, ön-bilgi `task_id`.
 * Gövdenin tamamı taranMAZ: bir rapor onlarca komşu kodu anar, hepsi "bağ" değildir. Pure.
 */
function extractTaskCodes(md, filename) {
  const out = new Map(); // kod → kaynak
  const add = (code, src) => {
    const c = String(code).toUpperCase();
    if (!out.has(c)) out.set(c, src);
  };
  const { taskId } = parseFileName(filename || '');
  if (taskId) {
    add(taskId, 'dosya-adı');
    // Dosya adı KANONİK OLMAYAN bir kuyruk taşıyabilir: `TASK-MQQ2I4FBV9R2-ST1-LEADER-…`
    // (alt-görev eki) ya da `ADP-285-264` (iki kart tek raporda). Ölçüldü: bu kuyruk
    // yüzünden 9 `TASK-…` kodu board'da "yok" görünüyordu. Önek AYRI bir bağ olarak
    // eklenir (tam kod atılmaz — hangisinin doğru olduğuna okuyucu karar verir).
    const head = canonicalPrefix(taskId);
    if (head && head !== taskId) add(head, 'dosya-adı-önek');
  }

  const head = (md || '').slice(0, 3000);
  const fm = /^\uFEFF?---\s*\n([\s\S]*?)\n---/.exec(md || '');
  if (fm) {
    const t = /^\s*(?:task_id|task|görev|gorev)\s*:\s*(.+)$/im.exec(fm[1]);
    if (t) for (const c of String(t[1]).match(TASK_CODE) || []) add(c, 'ön-bilgi');
  }
  for (const re of [/\*\*(?:Kart|Board|Görev|Gorev|Task):?\*\*\s*([^\n]{0,160})/gi]) {
    let m;
    while ((m = re.exec(head))) for (const c of m[1].match(TASK_CODE) || []) add(c, 'meta-satırı');
  }
  return [...out.entries()].map(([kod, kaynak]) => ({ kod, kaynak }));
}

/**
 * Bir görev kodunun KANONİK öneki: `TASK-XXXXXX-ST2` → `TASK-XXXXXX`, `ADP-285-264` →
 * `ADP-285`, `A-01A-DIRECTOR` → `A-01A`. Board kimliklerinin biçimi budur; kuyruk
 * ajanın kendi alt-iş etiketidir. Eşleşme yoksa null. Pure.
 */
function canonicalPrefix(code) {
  const c = String(code || '').toUpperCase();
  let m = /^(TASK-[A-Z0-9]{6,})/.exec(c);
  if (m) return m[1];
  m = /^([A-Z]+-\d+[A-Z]?)/.exec(c);
  if (m) return m[1];
  return null;
}

/**
 * Kanıt klasörü eşlemesi. Rapor adı `<KOD>-<ajan>.md`, klasör `<KOD>-screenshots` →
 * BİREBİR eşleşme yok (ölçüm: 0, ADR §2.6). Bu yüzden görev koduyla + 12 son-ekle
 * denenir. `dirNames` = aynı dizindeki klasör adları (I/O çağıran verir). Pure.
 */
const EVIDENCE_SUFFIXES = ['screenshots', 'evidence', 'media', 'scripts', 'proof', 'kanit', 'kanıt', 'assets', 'video', 'verify', 'shots', 'out'];
function matchEvidenceDirs(filename, taskCodes, dirNames) {
  const base = String(filename || '').replace(/\.md$/i, '');
  const hits = new Set();
  const codes = new Set([base, ...taskCodes.map((t) => t.kod)]);
  for (const d of dirNames) {
    const lower = d.toLowerCase();
    for (const code of codes) {
      const c = String(code).toLowerCase();
      if (!c) continue;
      if (lower === c) { hits.add(d); continue; }
      for (const suf of EVIDENCE_SUFFIXES) {
        if (lower === `${c}-${suf}`) hits.add(d);
      }
    }
  }
  return [...hits].sort();
}

/** Tek raporun kaydı. Pure (I/O yapan çağıran). */
function buildRecord({ file, md, stat, dirNames, relDir, roster, gateOn, page }) {
  const { taskId, agent } = parseFileName(file, roster);
  const fm = frontmatter(md);
  const codes = extractTaskCodes(md, file);
  const { tip, kaynak: tipKaynak } = classifyType(md, file);
  const { hukum, kaynak: hukumKaynak } = extractVerdict(md);
  const { platform, kaynak: platformKaynak } = extractPlatform(md, fm);
  // Görünürlük v1'de TEK değerlidir. Ajan başka bir değer yazdıysa SESSİZCE düşürülmez:
  // istek ayrı alanda görünür kalır, etkin değer `özel` olur (dış erişim REPORTS-V2-B1).
  const istek = (fm['görünürlük'] || fm['gorunurluk'] || fm['visibility'] || '').toLowerCase();
  return {
    id: path.posix.join(relDir, file),
    baslik: extractTitle(md, taskId) || firstHeading(md) || '',
    tip,
    tip_kaynak: tipKaynak,
    sahip: { takim: teamOf(agent) || '', ajan: agent || '', ajan_eslesti: Boolean(agent) },
    gorev: codes,
    gorunurluk: DEFAULT_VISIBILITY,
    gorunurluk_istegi: istek && istek !== DEFAULT_VISIBILITY ? istek : null,
    platform,
    platform_kaynak: platformKaynak,
    tarih: new Date(stat.mtimeMs).toISOString().slice(0, 10),
    sprint: extractSprint(md) || '',
    kanit_yolu: matchEvidenceDirs(file, codes, dirNames).map((d) => path.posix.join(relDir, d)),
    kanit_var: hasEvidence(md),
    hukum,
    hukum_kaynak: hukumKaynak,
    // REPORT-GATE-01 — kapının hükmü kaydın KENDİ alanıdır: "bitti" iddiası kanıtla
    // birlikte mi geldi, rapor yarım şablon mu, sözleşmenin dört alanı beyan edilmiş mi.
    // Kapı reddetse bile rapor indeksten DÜŞMEZ — yalnız kovası değişir (sessiz eleme yok).
    kapi: (() => {
      const g = gateReport(
        {
          md,
          filename: file,
          hukum,
          hukumKaynak,
          alanlar: { tip, gorevSayisi: codes.length, hukum, platform },
          ...(page || {}),
        },
        { enabled: gateOn !== false },
      );
      return {
        gecti: g.gecti,
        bloke: g.bloke,
        kova: g.kova,
        acik: g.acik,
        nedenler: g.nedenler,
        hukum_sinifi: g.hukum_sinifi,
        hukum_guven: g.hukum_guven,
        kanit_puani: g.kanit.puan,
        kanit_bulunan: g.kanit.bulunan,
        kanit_eksik: g.kanit.eksik,
        delikler: g.delikler.slice(0, 10),
      };
    })(),
    okundu: false,
    boyut: stat.size,
  };
}

/** Kayıtlardan ters harita (görev → raporlar) + bayat kod listesi. Pure. */
function buildTaskLinks(records, boardIds) {
  const forward = new Map();
  for (const r of records) {
    for (const g of r.gorev) {
      if (!forward.has(g.kod)) forward.set(g.kod, []);
      forward.get(g.kod).push(r.id);
    }
  }
  const gorev_index = {};
  for (const [kod, ids] of [...forward.entries()].sort()) gorev_index[kod] = ids.sort();
  const known = boardIds ? new Set(boardIds.map((s) => String(s).toUpperCase())) : null;
  const bayat_gorevler = known
    ? Object.keys(gorev_index).filter((k) => !known.has(k)).sort()
    : null;
  return { gorev_index, bayat_gorevler };
}

// ─── I/O katmanı ──────────────────────────────────────────────────────────────

function readBoardIds(file) {
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (raw.startsWith('[') || raw.startsWith('{')) {
    const j = JSON.parse(raw);
    const arr = Array.isArray(j) ? j : j.ids || j.tasks || [];
    return arr.map((x) => (typeof x === 'string' ? x : x.id)).filter(Boolean);
  }
  return raw.split('\n').map((s) => s.trim()).filter(Boolean);
}

function collect(resultsDir, relDir, gateOn) {
  const entries = fs.readdirSync(resultsDir, { withFileTypes: true });
  const dirNames = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  const files = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md') && e.name.toLowerCase() !== 'index.md')
    .map((e) => e.name)
    .sort();
  // Ajan sözlüğü: sabit roster (resultsIndex TEAM_OF) — ikinci bir liste türetilmez.
  const records = files.map((file) => {
    const abs = path.join(resultsDir, file);
    const md = fs.readFileSync(abs, 'utf8');
    const stat = fs.statSync(abs);
    const page = gatePageInput(md, abs, {
      readText: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } },
      exists: (p) => fs.existsSync(p),
      readDir: (p) => { try { return fs.readdirSync(p); } catch { return null; } },
    });
    return buildRecord({ file, md, stat, dirNames, relDir, roster: AGENTS, gateOn, page });
  });
  return { records, dirNames };
}

/** Ölçüm tablosu (kuru koşum çıktısı). Pure. */
function renderDryRun(records, links, extra = {}) {
  const byType = {};
  for (const t of TYPES) byType[t] = 0;
  const bySource = {};
  let withTask = 0, withVerdict = 0, verdictDeclared = 0, withEvidenceDir = 0, agentUnmatched = 0, teamless = 0;
  for (const r of records) {
    byType[r.tip] = (byType[r.tip] || 0) + 1;
    bySource[r.tip_kaynak.split(':')[0]] = (bySource[r.tip_kaynak.split(':')[0]] || 0) + 1;
    if (r.gorev.length) withTask++;
    if (r.hukum) withVerdict++;
    if (r.hukum && r.hukum_kaynak.startsWith('beyan')) verdictDeclared++;
    if (r.kanit_yolu.length) withEvidenceDir++;
    if (!r.sahip.ajan_eslesti) agentUnmatched++;
    if (!r.sahip.takim) teamless++;
  }
  const L = [];
  L.push(`rapor: ${records.length}`);
  L.push('');
  L.push('TİP DAĞILIMI');
  for (const t of TYPES) L.push(`  ${t.padEnd(10)} ${String(byType[t]).padStart(5)}  (%${((byType[t] / records.length) * 100).toFixed(1)})`);
  L.push('');
  L.push('TİP KAYNAĞI');
  for (const [k, v] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) L.push(`  ${k.padEnd(10)} ${String(v).padStart(5)}`);
  L.push('');
  L.push('GÖREV BAĞI');
  L.push(`  bağ bulunan          ${String(withTask).padStart(5)}  (%${((withTask / records.length) * 100).toFixed(1)})`);
  L.push(`  bağ bulunamayan      ${String(records.length - withTask).padStart(5)}`);
  L.push(`  — BEYAN edilmiş bağ (meta/ön-bilgi) ${String(extra.declaredLink ?? 0).padStart(5)}`);
  L.push(`  — YALNIZ dosya adından türemiş     ${String(extra.filenameOnlyLink ?? 0).padStart(5)}  ← zayıf bağ: kod board'da olmayabilir`);
  L.push(`  benzersiz görev kodu ${String(Object.keys(links.gorev_index).length).padStart(5)}`);
  L.push(`  bayat kod (board dışı) ${links.bayat_gorevler === null ? '  ölçülmedi (--board-ids verilmedi)' : String(links.bayat_gorevler.length).padStart(3)}`);
  L.push('');
  L.push('SAHİP');
  L.push(`  ajan eşleşmedi       ${String(agentUnmatched).padStart(5)}`);
  L.push(`  takımsız             ${String(teamless).padStart(5)}`);
  L.push('');
  L.push('HÜKÜM / KANIT');
  L.push(`  hüküm bulundu        ${String(withVerdict).padStart(5)}  (beyan: ${verdictDeclared} · ilk-paragraf: ${withVerdict - verdictDeclared})`);
  L.push(`  hüküm bulunamadı     ${String(records.length - withVerdict).padStart(5)}  ← alan yazılmaz (uydurma yok)`);
  L.push(`  kanıt klasörü eşleşti${String(withEvidenceDir).padStart(5)}  (%${((withEvidenceDir / records.length) * 100).toFixed(1)})`);
  L.push('');
  L.push('PLATFORM BEYANI');
  {
    const withP = records.filter((r) => r.platform).length;
    const fmP = records.filter((r) => r.platform_kaynak === 'ön-bilgi').length;
    L.push(`  beyanı olan          ${String(withP).padStart(5)}  (%${((withP / records.length) * 100).toFixed(1)}) — ön-bilgi: ${fmP} · gövde: ${withP - fmP}`);
    L.push(`  beyansız             ${String(records.length - withP).padStart(5)}  ← protokolde ZORUNLU`);
    L.push('');
  }
  L.push('KANIT KAPISI (REPORT-GATE-01)');
  {
    const acik = records.length ? records[0].kapi.acik : true;
    const byKova = {};
    for (const k of KOVALAR) byKova[k] = 0;
    let bloke = 0;
    for (const r of records) {
      byKova[r.kapi.kova] = (byKova[r.kapi.kova] || 0) + 1;
      if (r.kapi.bloke) bloke++;
    }
    L.push(`  kapı ${acik ? 'AÇIK' : 'KAPALI (kontrol kolu — hiçbir ret üretilmez)'}`);
    for (const k of KOVALAR) {
      const mark = k === 'tam' ? ' ' : (['yarım-şablon', 'kanıtsız-bitti'].includes(k) ? '⛔' : '·');
      L.push(`  ${mark} ${k.padEnd(16)} ${String(byKova[k]).padStart(5)}  (%${((byKova[k] / records.length) * 100).toFixed(1)})`);
    }
    L.push(`  BLOKE EDİLEN (done sayılmaz) ${String(bloke).padStart(5)}  ← yarım-şablon + kanıtsız-bitti`);
    L.push('');
  }
  L.push('GÖRÜNÜRLÜK');
  L.push(`  özel                 ${String(records.filter((r) => r.gorunurluk === 'özel').length).padStart(5)}  ← varsayılan, göç hiçbirini değiştirmez`);
  if (extra.note) { L.push(''); L.push(extra.note); }
  return L.join('\n');
}

/** Kapı sayaçları — kuru koşum tablosu ve indeks `kapi_ozet` AYNI fonksiyondan besleniyor. Pure. */
function gateSummary(records) {
  const kovalar = {};
  for (const k of KOVALAR) kovalar[k] = 0;
  let bloke = 0;
  for (const r of records) {
    kovalar[r.kapi.kova] = (kovalar[r.kapi.kova] || 0) + 1;
    if (r.kapi.bloke) bloke++;
  }
  return {
    acik: records.length ? records[0].kapi.acik : true,
    kovalar,
    bloke,
    gecen: kovalar.tam || 0,
  };
}

function generate(opts = {}) {
  const argv = opts.argv || [];
  const root = opts.root || resolveRepoRoot(argv);
  const resultsDir = opts.resultsDir || path.join(root, RESULTS_REL);
  const relDir = path.posix.join('docs', 'agent-results');
  const indexPath = path.join(resultsDir, INDEX_NAME);
  const dryRun = argv.includes('--dry-run');
  const revert = argv.includes('--revert');
  // REPORT-GATE-01 — KONTROL KOLU. `--no-gate` (ya da AGENTSPACE_REPORT_GATE=0) kapıyı
  // kapatır: her rapor `tam` kovasına düşer. Kapının GERÇEKTEN ayırdığının kanıtı,
  // açık/kapalı iki koşumun sayılarının FARKLI olmasıdır.
  const gateOn = opts.gateOn !== undefined
    ? opts.gateOn
    : (!argv.includes('--no-gate') && gateEnabled(opts.env));

  if (revert) {
    if (fs.existsSync(indexPath)) {
      fs.unlinkSync(indexPath);
      console.log(`reports-index-v2 --revert: silindi → ${indexPath}`);
    } else {
      console.log(`reports-index-v2 --revert: indeks zaten yok → ${indexPath}`);
    }
    return { reverted: true, indexPath };
  }

  let dirOk = false;
  try { dirOk = fs.statSync(resultsDir).isDirectory(); } catch { dirOk = false; }
  if (!dirOk) {
    console.error(`reports-index-v2: rapor dizini yok → ${resultsDir}`);
    return { ok: false, indexPath };
  }

  const boardFile = argValue(argv, '--board-ids');
  const boardIds = boardFile ? readBoardIds(boardFile) : null;
  const { records } = collect(resultsDir, relDir, gateOn);
  const links = buildTaskLinks(records, boardIds);

  if (dryRun) {
    console.log(
      renderDryRun(records, links, {
        note: 'KURU KOŞUM — hiçbir dosya yazılmadı/değiştirilmedi.',
        declaredLink: records.filter((r) => r.gorev.some((g) => g.kaynak !== 'dosya-adı')).length,
        filenameOnlyLink: records.filter((r) => r.gorev.length && r.gorev.every((g) => g.kaynak === 'dosya-adı')).length,
      }),
    );
    return { ok: true, dryRun: true, records, links, indexPath };
  }

  const doc = {
    _: 'OTOMATİK ÜRETİLİR — REPORTS-V2-A1 (scripts/reportsIndexV2.cjs). Elle düzenleme üzerine yazılır.',
    surum: SCHEMA_VERSION,
    uretim: new Date().toISOString(),
    kok: relDir,
    tipler: TYPES,
    sayim: {
      rapor: records.length,
      gorev_bagi_olan: records.filter((r) => r.gorev.length).length,
      hukum_olan: records.filter((r) => r.hukum).length,
      kanit_klasoru_olan: records.filter((r) => r.kanit_yolu.length).length,
    },
    // REPORT-GATE-01 — kapının ÖZETİ + REDDETTİĞİ HER RAPOR NEDENİYLE. Kapı sessizce
    // geçmez: `kapi_red` indeksin kendi defteridir, `kapi_ozet` de ekranın sayacı.
    kapi_ozet: gateSummary(records),
    kapi_red: records
      .filter((r) => !r.kapi.gecti)
      .map((r) => ({
        id: r.id,
        kova: r.kapi.kova,
        bloke: r.kapi.bloke,
        nedenler: r.kapi.nedenler,
        hukum_sinifi: r.kapi.hukum_sinifi,
        kanit_puani: r.kapi.kanit_puani,
        kanit_eksik: r.kapi.kanit_eksik,
        delikler: r.kapi.delikler,
      })),
    gorev_index: links.gorev_index,
    bayat_gorevler: links.bayat_gorevler,
    raporlar: records,
  };
  fs.writeFileSync(indexPath, JSON.stringify(doc, null, 1) + '\n', 'utf8');
  console.log(
    `REPORTS-INDEX.json yazıldı → ${records.length} rapor, ${Object.keys(links.gorev_index).length} görev kodu [${resultsDir}]`,
  );
  return { ok: true, records, links, indexPath };
}

function argValue(argv, name) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && argv[i + 1]) return argv[i + 1];
    if (typeof argv[i] === 'string' && argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1);
  }
  return null;
}

module.exports = {
  INDEX_NAME,
  gateSummary,
  TYPES,
  DEFAULT_VISIBILITY,
  SCHEMA_VERSION,
  reportStructureScore,
  reportSignalScore,
  imperativeStepScore,
  isGuide,
  firstHeading,
  frontmatter,
  extractPlatform,
  declaredType,
  mapDeclaredType,
  classifyType,
  extractVerdict,
  oneSentence,
  extractTaskCodes,
  canonicalPrefix,
  matchEvidenceDirs,
  EVIDENCE_SUFFIXES,
  buildRecord,
  buildTaskLinks,
  renderDryRun,
  generate,
  argValue,
};

if (require.main === module) generate({ argv: process.argv.slice(2) });
