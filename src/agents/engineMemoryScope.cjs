// MEM-SCOPE-01 — MOTORUN KALICI HAFIZA İNDEKSİNİN KESİMİ.
//
// ─────────────────────────────────────────────────────────────────────────────
// KRİTİK AYRIM — ÖNCE BUNU OKU
//
// Ajan bugün de hafıza kayıtlarının GÖVDESİNİ taşımıyor. Taşıdığı şey, kayıt
// başına TEK SATIRLIK bir başlık listesi (`MEMORY.md`); ilgisini çeken satırın
// dosyasını kendisi açıyor. Bu dosya o BAŞLIK LİSTESİNİ daraltır.
//
//   ⇒ hatırlama YETENEĞİ değişmez (dosyalar yerinde, hepsi okunabilir),
//   ⇒ kendiliğinden AKLINA GELENLER azalır.
//
// Kartın bütün riski bu cümlededir ve bu yüzden kesim, "bulma oranı"yla
// ölçülmeden kabul edilmez (bkz. electron/mem-scope-recall.cjs).
//
// ─────────────────────────────────────────────────────────────────────────────
// ÖLÇÜLEN KUSUR (TOKEN-BUDGET-01 §2, gerçek worker pane'i)
//
// Bir pane'in HER isteğindeki 40.950 jetonun 10.185'i (%24,9) motorun kalıcı
// hafızası: talimat bloğu + indeksin TAMAMI, seçilmeden.
//
// 🔑 ÖLÇÜLEN İKİNCİ KUSUR (bu kart, 09.09): indeks zaten KAYIPLIYDI ve bunu
//    kimse söylemiyordu. Bu makinede hafıza dizininde **402 kayıt** var,
//    `MEMORY.md` bunların yalnız **143'ünü** listeliyor. Yani "indeksin tamamını
//    taşıyoruz" cümlesi bile doğru değildi: kayıtların %64'ü zaten hiçbir pane'e
//    girmiyordu ve ARANABİLİR de değildi (motorun kendi hafıza aracı yalnız
//    indeksten okur). Bu dosyanın eklediği ARAMA yolu (engineMemorySearchCli)
//    402 kaydın tamamını tarar — yani kesim, erişilebilirliği DÜŞÜRMEZ, ARTIRIR.
//
// ─────────────────────────────────────────────────────────────────────────────
// EREN'IN ONAYLADIĞI DÖRT MADDE (09.09) — hepsi bu dosyada karşılığını bulur
//
//   1. KURALLAR HER ZAMAN GİDER. `metadata.type` alanı davranışsal olan kayıtlar
//      (`feedback` = bize verilmiş çalışma kuralı, `user` = kullanıcının kim
//      olduğu/tercihleri) seçime BIRAKILMAZ. Sınıf listesi burada YENİDEN
//      TANIMLANMAZ; `memoryTargeting.BEHAVIORAL_TYPES`ten gelir — iki yerde iki
//      tanım, sessizce ayrışan iki davranış demektir.
//      🔴 Kurallar İNDEKSTEN DEĞİL DOSYALARDAN toplanır: 55 kural kaydının yalnız
//         34'ü indekste. İndeksten toplasak, kartın "kurallar düşmesin" şartını
//         21 kural için ZATEN ihlal etmiş olurduk (ölçüldü).
//   2. İŞE İLGİLİ OLANLAR SEÇİLİR. Seçim `memoryTargeting.selectTargeted` ile
//      yapılır — ürünün kendi hafızasında 400 gerçek oturumda kalibre edilmiş
//      eşik (0,16) ve saf çekirdek. İkinci bir sıralama mantığı YAZILMAZ.
//   3. GERİ KALAN ARANABİLİR KALIR. Blok, arama komutunu ve indeksin tam yolunu
//      kendisi yazar; kayıplılığını gizlemez.
//   4. BULMA ORANI ÖLÇÜLÜR. Bu dosya ölçüm yapmaz, ÖLÇÜLEBİLİR olur: seçkinin
//      hangi slug'ları taşıdığı `stats.slugs`ta döner.
//
// ─────────────────────────────────────────────────────────────────────────────
// İKİ AŞAMA (D-07 ile aynı sözleşme — orada ölçülmüş bir kök nedeni tekrar etmemek için)
//
//   AŞAMA A — spawn. Görev metni HENÜZ YOK. Burada göreve-göre seçki YAPILMAZ;
//     D-04'ün ölçtüğü kök neden tam olarak "görevi bilmeyen sorguyla seçmek"ti
//     (isabet %6,2, blok varyansı ±42 ch = seçki değil DOLDURMA). Taşınan:
//     kurallar + EN SON GÜNCELLENEN N kayıt + arama duyurusu.
//   AŞAMA B — dağıtım. İş metni geldiğinde `selectTargeted` GÖREV sorgusuyla
//     koşar (main.js `memory:taskBlock`). Bu blok her isteğe değil, o TEK mesaja
//     girer — yani sabit yükü artırmaz.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 ÖLÇÜM KESİMİ REDDETTİ — VARSAYILAN KAYIPSIZ (bunu okumadan bu dosyayı değiştirme)
//
// Kartın kabul ölçütü "bulma oranı düşmesin"di. 10 gerçek board kartıyla ölçüldü
// (electron/mem-scope-recall.cjs · docs/agent-results/MEM-SCOPE-01-evidence/):
//
//   A indeksin TAMAMI (bugünkü sevk edilen)     10/10   17.302 ch
//   B kör baş-kırpma (TOKEN-BUDGET-01, dev'de)   0/10    1.576 ch
//   C kural + göreve-göre seçki (bu kartın kesimi) 7/10  10.500 ch
//
// C, A'nın ALTINA düştü ⇒ kesim kabul EDİLMEDİ. Sebep de ölçüldü ve tasarımsal:
//   1. Bu indeks ZATEN sıkıştırılmış. 143 satır / 17.302 karakter = satır başına
//      121 karakter ve bunun çoğu BAŞLIK+DOSYA ADI. Kancaları 50 karaktere
//      kırpmak bile yalnız −%8 kazandırıyor (17.302 → 15.817): kesilecek yağ yok,
//      kesilecek olan KAYITTIR.
//   2. Kayıt düşürmenin bedeli ölçüldü: kelime-tabanlı seçicinin tavanı bu
//      korpusta 7/10. Kalan 3'ünde kartın metni ile kaydın satırı arasında ORTAK
//      KELİME yok (bağ anlamsal) — eşik/k ayarıyla kapanmıyor, anlam katmanı ister.
//   3. Kazanç zaten küçüktü: en iyi kesim ~2.800 jeton/istek. 3/10 hatırlama
//      kaybına değmez.
//
// ⇒ VARSAYILAN `full`: indeksin TAMAMI taşınır, HİÇBİR kayıt düşmez. Kesimden
//   vazgeçildi ama kartın geri kalan üç maddesi KAZANÇ olarak kaldı:
//     • kurallar: indekste OLMAYAN 21 davranış kaydı da eklenir (eskiden hiçbir
//       pane'e girmiyorlardı — kartın 1. maddesi burada gerçekten kazandırdı),
//     • ilgi: göreve-göre seçki AŞAMA B'ye taşındı (dağıtılan mesaja girer, HER
//       İSTEĞE değil) → sabit yükü artırmadan ilgi eklenir,
//     • aranabilirlik: 402 kaydın 259'u indekste HİÇ yoktu; arama komutu onları
//       da tarar (erişilebilirlik DÜŞMEDİ, ARTTI).
//
// KONTROL KOLU — ÜÇ KONUM (`CREWPANE_MEMORY_SCOPE`):
//   (boş)/`full` → VARSAYILAN. Tam indeks + indekste olmayan kurallar + arama.
//   `trim`       → ölçülen kesim (kurallar + seçki). Kazanç ~2.800 jeton, bedeli
//                  ÖLÇÜLMÜŞ 3/10 hatırlama kaybı. Bilerek açılır.
//   `off`        → motorun bugün enjekte ettiği HAM indeks, eklemesiz. Ölçümün
//                  "ÖNCE" kolu; eski rakam birebir geri gelir.
//
// Saf-ish: node builtin + repo modülleri. `deps` ile dosya okuması enjekte
// edilebilir → `node --test` diskten bağımsız koşar.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const memoryGraph = require('../memory/memoryGraph.cjs');
const memoryRecall = require('../memory/memoryRecall.cjs');
const targeting = require('../memory/memoryTargeting.cjs');

/** Kontrol kolu — `off` verilirse kesim yapılmaz, indeksin TAMAMI taşınır. */
const OFF_ENV = 'CREWPANE_MEMORY_SCOPE';

const DEFAULTS = Object.freeze({
  /** Bir kural satırının KANCASINDAN gösterilecek azami metin. `CORE_DEFAULTS.lineChars`
   *  (180) emsali; kurallar kısaltılabilir ama DÜŞÜRÜLEMEZ. Başlık+dosya adı (`head`)
   *  bu tavana TABİ DEĞİLDİR — kırpma ajanın derinleşme yolunu asla yutmaz
   *  (memoryRecall.clipHook ile aynı tasarım kuralı). */
  ruleLineChars: 130,
  /** Kural bölümünün karakter tavanı. AŞILIRSA kesim İPTAL edilir (kural düşürmek
   *  YASAK — kazanç uğruna kural kesmek kartın açık yasağı). */
  rulesMaxChars: 9000,
  /** Göreve-göre seçkinin karakter tavanı (TOKEN-BUDGET-01'in 1.600'ü korunur). */
  selectionChars: 1600,
  /** Aşama A'da görev metni yokken taşınan "en son güncellenen" kayıt sayısı. */
  recentN: 8,
  /** Göreve-göre seçkide azami kayıt. */
  maxK: 5,
  /**
   * Seçkinin SORGUSU olarak görev metninin İLK bu kadar karakteri kullanılır.
   *
   * 🪤 ÖLÇÜLDÜ (10 gerçek board kartı, ortalama 2.500 karakterlik açıklama):
   *    metnin TAMAMINI sorgu yapmak isabeti DÜŞÜRÜYOR. `memoryTargeting`in
   *    "ideal satır" paydası sorgunun GENİŞLİĞİYLE ölçeklenir (uzun-sorgu tuzağına
   *    karşı bilinçli bir tasarım) — ama bir kart açıklaması o ölçeğin çok üstünde
   *    ve her satırın oranını eşiğin altına itiyor. Süpürme (isabet/10):
   *      sorgu 200 ch → 6 · 400 → 7 · 600 → 7 · 1.200 → 6 · tamamı → 5
   *    Kartın başı (kod + başlık + teşhis cümlesi) zaten en ayırt edici kısımdır.
   */
  queryChars: 600,
  /**
   * `idealMax`: paydaya giren terim tavanı. Aynı süpürmede 8 ≫ 12 ≫ 40
   * (600 ch sorguda 7/10 · 6/10 · 4/10) — bu korpusun satırları kısa olduğu için
   * geniş bir "ideal" hiçbir satırın erişemeyeceği bir çıta koyuyor.
   */
  idealMax: 8,
});

/**
 * Bir kaydın satırı: BAŞLIK+DOSYA korunur, yalnız KANCA kırpılır.
 *
 * 🪤 İlk sürüm satırın TAMAMINI kırpıyordu; başlığı uzun bir kayıtta bu, dosya adını
 *    (ajanın derinleşme yolunu) yutuyordu. memoryRecall.clipHook'un tasarım kuralı
 *    burada da geçerli: kaynak kırpılamaz, kanca kırpılır.
 */
function renderLine(head, hook, lineChars) {
  const h = String(head || '').replace(/\s+/g, ' ').trim();
  const flat = String(hook || '').replace(/\s+/g, ' ').trim();
  const clipped = flat.length <= lineChars ? flat : `${flat.slice(0, lineChars).trim()}…`;
  if (!h) return `- ${clipped}`;
  return `${h}${clipped ? ` ${clipped}` : ''}`.trim();
}

/** Bir kaydın dosya adından slug. */
function slugOfFile(file) {
  if (!file) return null;
  const base = String(file).split(/[\\/]/).pop() || '';
  return base.replace(/\.md$/i, '') || null;
}

/**
 * Motorun hafıza dizinini oku: indeks satırları + KAYIT DOSYALARININ künyesi.
 *
 * 🪤 İki ayrı kaynak vardır ve ÖRTÜŞMEZLER: `MEMORY.md` (indeks) ile dizindeki
 *    `*.md` kayıtları. Yalnız birine bakan her ölçüm yanlış çıkar — bu makinede
 *    402 kayıt / 143 indeks satırı.
 *
 * @param {string} indexPath `<...>/memory/MEMORY.md`
 * @param {{readFile?:Function, readDir?:Function, stat?:Function}} deps
 * @returns {{dir:string, indexPath:string, indexRaw:string, indexLines:Array,
 *            records:Map<string,{type:string,description:string,mtimeMs:number}>,
 *            total:number, indexed:number}|null}
 */
function readEngineMemory(indexPath, deps = {}) {
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const readDir = deps.readDir || ((p) => fs.readdirSync(p));
  const stat = deps.stat || ((p) => fs.statSync(p));
  if (!indexPath) return null;
  const dir = path.dirname(indexPath);

  let indexRaw = '';
  try {
    indexRaw = readFile(indexPath);
  } catch {
    indexRaw = ''; // indeks YOKSA da kayıtlar olabilir — dizin taraması sürer
  }

  const records = new Map();
  let files = [];
  try {
    files = readDir(dir).filter((f) => /\.md$/i.test(f) && f !== path.basename(indexPath));
  } catch {
    files = [];
  }
  for (const f of files) {
    const slug = f.replace(/\.md$/i, '');
    let raw = '';
    try {
      raw = readFile(path.join(dir, f));
    } catch {
      continue; // okunamayan kayıt sessizce yok sayılır (hafıza arızası spawn'ı düşüremez)
    }
    const meta = memoryGraph.parseFact(raw);
    let mtimeMs = 0;
    try {
      mtimeMs = stat(path.join(dir, f)).mtimeMs || 0;
    } catch {
      mtimeMs = 0;
    }
    records.set(slug, { type: meta.type, description: meta.description || '', mtimeMs });
  }

  const indexLines = memoryRecall.parseIndexLines(indexRaw).map((l) => ({ ...l, slug: slugOfFile(l.file) }));
  return {
    dir,
    indexPath,
    indexRaw,
    indexLines,
    records,
    total: records.size,
    // `indexed` = AJANIN GÖRDÜĞÜ İNDEKS SATIRI SAYISI — başka bir şey değil.
    // 🪤 İlk sürüm "dosyası GERÇEKTEN var olan satır" sayıyordu. İki sessiz hata:
    //    (a) dosyası silinmiş/adı değişmiş bir işaretçi ajanın gördüğü bir satırdır
    //        ve sayıdan düşürülünce o kusur GİZLENİR;
    //    (b) `[başlık](dosya.md)` biçiminde OLMAYAN düz bir indeks satırı (başka
    //        araçların ürettiği indeksler böyle) sıfır sayılıyordu → "402 kayıttan
    //        0'ı indekste" gibi apaçık yanlış bir cümle.
    indexed: indexLines.length,
  };
}

/**
 * Kural satırları — DOSYALARDAN, indeksten değil.
 *
 * Kaydın indekste bir satırı varsa O satır kullanılır (insan eliyle yazılmış kanca
 * daha bilgilidir); yoksa frontmatter `description`'ından bir satır üretilir.
 * Sıra deterministiktir (slug) — aynı durum → aynı blok, spawn'lar kıyaslanabilsin.
 *
 * @returns {{lines:string[], slugs:string[], chars:number, missingDescription:number}}
 */
function ruleLines(mem, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const byLine = new Map();
  for (const l of mem.indexLines) if (l.slug && !byLine.has(l.slug)) byLine.set(l.slug, l);

  const slugs = [...mem.records.keys()]
    .filter((s) => targeting.BEHAVIORAL_TYPES.includes(mem.records.get(s).type))
    .sort((a, b) => a.localeCompare(b));

  const lines = [];
  let chars = 0;
  let missingDescription = 0;
  for (const slug of slugs) {
    const rec = mem.records.get(slug);
    const fromIndex = byLine.get(slug);
    const desc = String(rec.description || '').replace(/\s+/g, ' ').trim();
    if (!fromIndex && !desc) missingDescription += 1;
    const head = fromIndex && fromIndex.head ? fromIndex.head : `- [${slug}](${slug}.md) — `;
    const hook = fromIndex && fromIndex.head ? fromIndex.hook : desc || '(açıklama yok — dosyayı aç)';
    const text = renderLine(head, hook, cfg.ruleLineChars);
    lines.push(text);
    chars += text.length + 1;
  }
  return { lines, slugs, chars, missingDescription };
}

/** Aşama A telafisi: en son güncellenen N kayıt (görev metni yokken). */
function recentLines(mem, exclude, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const byLine = new Map();
  for (const l of mem.indexLines) if (l.slug && !byLine.has(l.slug)) byLine.set(l.slug, l);
  const skip = exclude instanceof Set ? exclude : new Set(exclude || []);
  const picked = [...mem.records.entries()]
    .filter(([slug]) => !skip.has(slug))
    .sort((a, b) => b[1].mtimeMs - a[1].mtimeMs || a[0].localeCompare(b[0]))
    .slice(0, cfg.recentN);
  const lines = [];
  const slugs = [];
  let chars = 0;
  for (const [slug, rec] of picked) {
    const desc = String(rec.description || '').replace(/\s+/g, ' ').trim();
    const l = byLine.get(slug);
    const head = l && l.head ? l.head : `- [${slug}](${slug}.md) — `;
    const hook = l && l.head ? l.hook : desc;
    const text = renderLine(head, hook, cfg.ruleLineChars);
    if (chars + text.length + 1 > cfg.selectionChars) continue;
    lines.push(text);
    slugs.push(slug);
    chars += text.length + 1;
  }
  return { lines, slugs, chars };
}

/**
 * Göreve-göre seçki — `memoryTargeting.selectTargeted`e DEVREDİLİR.
 * Aday havuzu: indeks satırları EKSİ kurallar (kurallar zaten koşulsuz gidiyor;
 * ikinci kez seçilirlerse hem yer israfı hem yanıltıcı bir "isabet" olur).
 */
function targetedLines(mem, query, ruleSlugs, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const skip = new Set(ruleSlugs || []);
  const candidates = [];
  for (const l of mem.indexLines) {
    if (!l.slug || skip.has(l.slug)) continue;
    const rec = mem.records.get(l.slug);
    candidates.push({
      slug: l.slug,
      scope: 'engine',
      label: 'motor',
      file: l.file,
      head: l.head,
      hook: l.hook,
      raw: l.raw,
      type: rec ? rec.type : 'reference',
      description: rec ? rec.description : '',
    });
  }
  // Sorgu KIRPILIR — gerekçesi ve süpürme tablosu DEFAULTS.queryChars'ta.
  const q = String(query || '').slice(0, cfg.queryChars);
  return targeting.selectTargeted(candidates, q, {}, {
    maxK: cfg.maxK,
    maxChars: cfg.selectionChars,
    idealMax: cfg.idealMax,
    ...(opts.targeting || {}),
  });
}

/** Arama duyurusu — kayıt SAYILARIYLA birlikte (kayıplılık gizlenmez). */
function searchNotice(mem, carried, cliPath) {
  const cmd = cliPath
    ? `\`node "${cliPath}" "<konu>"\``
    : '`grep -ril "<konu>" "' + mem.dir + '"`';
  const gap =
    mem.total > mem.indexed
      ? ` İNDEKSİN KENDİSİ DE KAYIPLI: ${mem.total} kaydın yalnız ${mem.indexed}'i indekste listeli — ` +
        `arama ${mem.total} kaydın TAMAMINI tarar, indeksin göremediklerini de bulur.`
      : '';
  return (
    `⚠ Bu liste KAYIPLIDIR ve gizlenmiyor: ${mem.total} kayıttan ${carried} tanesi burada. ` +
    `Hiçbir kayıt erişilemez değildir — indekste GÖRMEDİĞİN bir konu için ARA: ${cmd} ` +
    `(dosya + satır + alıntı döner; yoksa "${memoryRecall.NOT_FOUND}" der, uydurmaz).${gap}\n` +
    `İndeksin tamamı: ${mem.indexPath} · kayıt dosyaları: ${mem.dir}\n` +
    `Hafıza YAZMA yolun DEĞİŞMEDİ: aynı dizine yazmaya devam et.`
  );
}

/**
 * MOTORUN hafızasına YAZMA disiplini.
 *
 * 🪤 SESSİZ YETENEK KAYBI (TOKEN-BUDGET-01'in kesiminde doğdu, burada kapatılıyor):
 *    `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` motorun kendi hafıza TALİMAT BLOĞUNU da
 *    düşürür — yani "şu dizine, şu frontmatter'la yaz, indekse satır ekle" kuralını.
 *    Ürünün kendi hafıza bloğu BAŞKA bir dizini (.crewpane) anlatır; onu bunun
 *    yerine saymak, ajanın motor hafızasına yazmayı sessizce bırakması demekti.
 */
function writeDiscipline(mem) {
  return (
    `YAZMA: gelecekte faydalı kalıcı bir şey öğrendiysen ${mem.dir} altına TEK GERÇEK TEK DOSYA yaz ` +
    `(frontmatter: name/description/metadata.type = user|feedback|project|reference) ve ` +
    `${path.basename(mem.indexPath)} dosyasına tek satırlık işaretçi ekle. Var olanı GÜNCELLE, kopyalama.`
  );
}

/** Aşama B'nin tek satırlık duyurusu (uzun uyarı spawn'da zaten verildi). */
function shortNotice(mem, cliPath) {
  const cmd = cliPath ? `\`node "${cliPath}" "<konu>"\`` : `\`grep -ril "<konu>" "${mem.dir}"\``;
  return `Seçki kayıplıdır; ${mem.total} kaydın tamamında ara: ${cmd}`;
}

/**
 * Bu spawn/dağıtım için hafıza indeksi bloğu.
 *
 * @param {object} o
 * @param {string} o.indexPath motorun `MEMORY.md` yolu
 * @param {string} [o.query] GÖREV METNİ (Aşama B). Yoksa Aşama A (kurallar + en son N).
 * @param {number} [o.budgetChars] blok için ayrılan karakter (Infinity = sınırsız)
 * @param {object} [o.env] kontrol kolu okunacak ortam
 * @param {string|null} [o.cliPath] arama komutunun mutlak yolu
 * @param {object} [o.deps] dosya okuma dikişleri (test)
 * @param {object} [o.opts] DEFAULTS'u ezer
 * @returns {{text:string, stats:object}|null} `null` ⇒ taşınacak hafıza YOK
 */
function planMemoryIndex(o = {}) {
  const { indexPath, query = '', budgetChars = Infinity, env = process.env, cliPath = null, deps = {}, opts = {} } = o;
  const cfg = { ...DEFAULTS, ...opts };
  const mem = readEngineMemory(indexPath, deps);
  if (!mem) return null;
  if (!mem.indexRaw.trim() && !mem.records.size) return null;

  const lever = `${(env && env[OFF_ENV]) || ''}`.trim().toLowerCase();
  const mode0 = cfg.skipRules ? 'task' : lever === 'off' ? 'off' : lever === 'trim' ? 'trim' : 'full';

  // ── `off` — MOTORUN BUGÜNKÜ HÂLİ, eklemesiz (ölçümün ÖNCE kolu) ────────────
  if (mode0 === 'off') {
    const body = mem.indexRaw.trim();
    if (!body) return null;
    const text =
      `\n\n## Kalıcı hafıza indeksi — HAM (${mem.indexed} satır; ${OFF_ENV}=off)\n${body}\nTAMAMI: ${mem.indexPath}`;
    return {
      text,
      stats: {
        mode: 'off',
        total: mem.total,
        indexed: mem.indexed,
        carried: mem.indexed,
        rules: 0,
        selected: 0,
        chars: text.length,
        slugs: mem.indexLines.map((l) => l.slug).filter(Boolean),
      },
    };
  }

  // ── `full` — VARSAYILAN: HİÇBİR KAYIT DÜŞMEZ ──────────────────────────────
  //
  // İndeksin tamamı + indekste OLMAYAN davranış kayıtları + yazma disiplini +
  // arama. Ölçüm (10 gerçek görev) kesimi reddettiği için varsayılan budur;
  // gerekçesi dosya başlığında rakamlarıyla yazılı.
  if (mode0 === 'full') {
    const body = mem.indexRaw.trim();
    if (!body && !mem.records.size) return null;
    const inIndex = new Set(mem.indexLines.map((l) => l.slug).filter(Boolean));
    // 🔑 KARTIN 1. MADDESİNİN ASIL KAZANCI. Bu makinede 55 davranış kaydının 21'i
    //    indekste HİÇ listeli değil — yani "kurallar her zaman gider" şartı, kesim
    //    olmadan da ihlal ediliyordu ve kimse bunu ölçmemişti. Onlar burada eklenir.
    const orphanRules = [...mem.records.keys()]
      .filter((slug) => !inIndex.has(slug) && targeting.BEHAVIORAL_TYPES.includes(mem.records.get(slug).type))
      .sort((a, b) => a.localeCompare(b))
      // `- [x](x.md)` yerine `- x.md`: indekste karşılığı olmayan kayıtta başlık ile
      // dosya adı AYNI şeydir, iki kez yazmak 21 satırda ~630 karakter israftır.
      // Dosya adı (derinleşme yolu) korunur.
      .map((slug) => renderLine(`- ${slug}.md — `, mem.records.get(slug).description, cfg.ruleLineChars));
    const parts = [
      `\n\n## Kalıcı hafıza indeksi — TAMAMI (${mem.indexed} satır · dizinde ${mem.total} kayıt)`,
      body,
    ];
    if (orphanRules.length) {
      parts.push(
        `### İndekste LİSTELİ OLMAYAN davranış kuralları (${orphanRules.length}) — bunlar da HER İŞTE geçerli\n` +
          orphanRules.join('\n'),
      );
    }
    parts.push(writeDiscipline(mem));
    parts.push(searchNotice(mem, mem.indexed + orphanRules.length, cliPath));
    const text = parts.join('\n');
    if (text.length > budgetChars) {
      return { text: '', stats: { mode: 'abort', reason: 'over-budget', total: mem.total, chars: text.length, budgetChars } };
    }
    return {
      text,
      stats: {
        mode: 'full',
        total: mem.total,
        indexed: mem.indexed,
        carried: mem.indexed + orphanRules.length,
        rules: orphanRules.length,
        selected: 0,
        chars: text.length,
        slugs: [...inIndex],
      },
    };
  }

  // ── 1) KURALLAR — koşulsuz ────────────────────────────────────────────────
  // 🔴 `skipRules` YALNIZ AŞAMA B İÇİNDİR (dağıtım). Orada kurallar spawn'da ZATEN
  //    gitti; ikinci kez göndermek hem yer israfı hem yanıltıcı bir "isabet"tir.
  //    Aşama A'da (spawn) bu bayrak ASLA kullanılmaz — kullanılırsa kartın birinci
  //    maddesi ("kurallar her zaman gider") sessizce ihlal edilmiş olur.
  const rules = cfg.skipRules ? { lines: [], slugs: [], chars: 0, missingDescription: 0 } : ruleLines(mem, cfg);
  if (rules.chars > cfg.rulesMaxChars) {
    // Kural bölümü tavanı aştı. Kural DÜŞÜRMEK yasak (kartın açık kuralı), o yüzden
    // kesimi İPTAL ederiz: çağıran motorun kendi tam-boy enjeksiyonunu korur.
    return { text: '', stats: { mode: 'abort', reason: 'rules-over-budget', total: mem.total, rules: rules.slugs.length, chars: rules.chars } };
  }

  // ── 2) İLGİLİ OLANLAR ─────────────────────────────────────────────────────
  const q = String(query || '').trim();
  let picked = { lines: [], slugs: [], chars: 0 };
  let mode = 'recent';
  let selStats = null;
  if (q) {
    // Kural slug'ları her hâlükârda havuzdan ÇIKAR: `skipRules` kipinde de onlar
    // spawn'da gitti, yeniden seçilirlerse aynı satır iki kez taşınır.
    const excluded = cfg.skipRules
      ? [...mem.records.keys()].filter((k) => targeting.BEHAVIORAL_TYPES.includes(mem.records.get(k).type))
      : rules.slugs;
    const sel = targetedLines(mem, q, excluded, cfg);
    selStats = { considered: sel.considered, aboveThreshold: sel.aboveThreshold, threshold: sel.threshold, reason: sel.reason };
    if (sel.picks.length) {
      mode = 'targeted';
      picked = { lines: sel.picks.map((p) => p.text), slugs: sel.picks.map((p) => p.slug), chars: sel.chars };
    } else {
      // Eşiği geçen YOK. DOLDURMA YASAĞI (memoryTargeting sözleşmesi): burada
      // "en son N"e düşmek, eşiğin elediği yeri alakasız kayıtla doldurmak olurdu.
      mode = 'targeted-empty';
    }
  } else if (!cfg.skipRules) {
    picked = recentLines(mem, new Set(rules.slugs), cfg);
  }

  // ── 3) BLOĞU ÖR ───────────────────────────────────────────────────────────
  const carried = rules.slugs.length + picked.slugs.length;
  const parts = [];
  parts.push(
    cfg.skipRules
      ? `<motor-hafızası · BU GÖREVE göre seçildi (${mem.total} kayıttan ${carried}; kurallar spawn'da zaten gitti)>`
      : `\n\n## Kalıcı hafıza indeksi — KESİLMİŞ (${OFF_ENV}=trim · ${mem.total} kayıt · taşınan ${carried})\n` +
        `⚠ Bu kip ÖLÇÜLMÜŞ bir hatırlama kaybı taşır (10 gerçek görevde 10/10 → 7/10). Bilerek açıldı.`,
  );
  if (rules.lines.length) {
    parts.push(
      `### Davranış kuralları (${rules.lines.length}) — HER İŞTE GEÇERLİ, seçime bırakılmaz\n` + rules.lines.join('\n'),
    );
  }
  if (picked.lines.length) {
    const head =
      mode === 'targeted'
        ? `### Bu göreve göre seçilenler (${picked.lines.length}/${selStats.considered}, eşik=${selStats.threshold})`
        : `### En son güncellenen ${picked.lines.length} kayıt (görev metni spawn anında henüz yok — göreve özel seçki iş metniyle birlikte gelir)`;
    parts.push(`${head}\n${picked.lines.join('\n')}`);
  } else if (mode === 'targeted-empty') {
    parts.push('### Bu göreve uyan hafıza kaydı YOK (eşiği geçen olmadı — bütçe doldurulmadı)');
  }
  parts.push(cfg.skipRules ? shortNotice(mem, cliPath) : searchNotice(mem, carried, cliPath));

  let text = parts.join('\n');
  if (cfg.skipRules) text = `${text}\n</motor-hafızası>`;
  if (text.length > budgetChars) {
    // Bütçe yetmedi. KURALLARI KESMEYİZ: önce seçki bölümü düşer, yine sığmazsa
    // kesim iptal edilir ve motorun kendi enjeksiyonu korunur.
    const lean = [parts[0], rules.lines.length ? parts[1] : null, searchNotice(mem, rules.slugs.length, cliPath)]
      .filter(Boolean)
      .join('\n');
    if (lean.length > budgetChars) {
      return { text: '', stats: { mode: 'abort', reason: 'over-budget', total: mem.total, chars: text.length, budgetChars } };
    }
    text = lean;
    mode = `${mode}+trimmed`;
    picked = { lines: [], slugs: [], chars: 0 };
  }

  return {
    text,
    stats: {
      mode,
      total: mem.total,
      indexed: mem.indexed,
      carried: rules.slugs.length + picked.slugs.length,
      rules: rules.slugs.length,
      selected: picked.slugs.length,
      missingDescription: rules.missingDescription,
      chars: text.length,
      slugs: [...rules.slugs, ...picked.slugs],
      selection: selStats,
    },
  };
}

module.exports = {
  OFF_ENV,
  DEFAULTS,
  renderLine,
  slugOfFile,
  readEngineMemory,
  ruleLines,
  recentLines,
  targetedLines,
  searchNotice,
  shortNotice,
  writeDiscipline,
  planMemoryIndex,
};
