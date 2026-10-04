// D-07 (SPRINT-TOK-01) — İKİ AŞAMALI HAFIZA ENJEKSİYONUNUN DOSYA KATMANI.
//
// memoryTargeting.cjs SAF çekirdektir (eşik, ceza, bütçe); burası onun okuduğu
// ADAYLARI diskten toplar ve iki yüzeyi üretir:
//
//   • `spawnCore(...)`  → AŞAMA A: spawn'da giden EN AZ hafıza (kimlik + yol +
//     arama komutu + en fazla 3 DAVRANIŞSAL kayıt). Görev metni burada HENÜZ YOK,
//     bu yüzden burada göreve-göre seçki YAPILMAZ — D-04'ün kök nedeni tam olarak
//     "görevi bilmeyen sorguyla 15 kayıt seçmek"ti.
//   • `taskBlock(...)`  → AŞAMA B: İLK GÖREV METNİ geldiğinde göreve-göre seçki.
//     Sorgu = işin kendisi. Eşiği geçen yoksa BOŞ döner.
//
// Kapsamlar (agentMemory ile aynı): own · shared · global. Her kapsamın MEMORY.md
// POINTER satırları aday havuzudur; kaydın SINIFI (`metadata.type`) ise kaydın
// kendi dosyasından okunur — davranışsal muafiyet (ADR §4) bir DURUM verisidir.
//
// Hiçbir yol atmaz: okunamayan dizin/dosya sessizce boş katkı yapar (hafıza
// arızası bir spawn'ı ya da bir dağıtımı ASLA düşüremez).

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const agentMemory = require('./agentMemory.cjs');
const memoryGraph = require('./memoryGraph.cjs');
const memoryRecall = require('./memoryRecall.cjs');
const targeting = require('./memoryTargeting.cjs');
const { maskSecrets } = require('./memorySecretMask.cjs');

/** Üç kapsamın dizinleri — tek yer (spawn + görev yolları aynısını kullanır). */
function scopeDirs(workspaceRoot, agentId, homedir) {
  return [
    { key: 'own', label: 'senin', dir: agentMemory.agentMemoryDir(workspaceRoot, agentId) },
    { key: 'shared', label: 'takım', dir: agentMemory.sharedMemoryDir(workspaceRoot) },
    { key: 'global', label: 'global', dir: agentMemory.globalMemoryDir(homedir) },
  ];
}

/** Bir kapsamdaki kayıt dosyalarının künyesi: slug → {type, description}. */
function factIndex(dir) {
  const out = new Map();
  for (const f of memoryGraph.listFactFiles(dir)) {
    const slug = f.replace(/\.md$/, '');
    let raw = '';
    try {
      raw = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    const meta = memoryGraph.parseFact(raw);
    // KABUL-FIX-01 (DT-10) — `always` künyeyle BİRLİKTE taşınır; çekirdek seçkisi
    // onu sıralamada ilk anahtar olarak kullanır (bkz. memoryTargeting.behavioralCore).
    out.set(slug, { type: meta.type, description: meta.description || '', always: meta.always === true });
  }
  return out;
}

/**
 * ADAY HAVUZU İÇİN TAM İNDEKS — `agentMemory.readIndex` DEĞİL.
 *
 * 🔑 D-07'de ÖLÇÜLEN İKİNCİ KÖK NEDEN: `readIndex` indeksi 25 KB / 200 satırda
 * KESER (Claude Code paritesi — enjekte edilen metnin sınırı). Ölçüm: takım indeksi
 * 302.750 karakter → seçiciye yalnız **34 satırı** (%8'i) görünüyordu; ajanın kendi
 * indeksi 97.369 karakter → 25 satır. Yani seçki, hafızanın %90'ından fazlasını
 * DEĞERLENDİRMEYE BİLE ALAMIYORDU; "bu göreve uyan kayıt yok" hükmü çoğu zaman
 * "o kayıt aday havuzuna hiç girmedi" demekti.
 *
 * Kesme kuralı ENJEKSİYON için doğru, SEÇİM için yanlıştır: enjeksiyonu zaten
 * `maxK` + `maxChars` sınırlıyor (k≤6, ≤2.200 ch). Aday okuması yerel bir dosya
 * okumasıdır ve jetona dönüşmez. Kendi tavanı (2 MB) yalnız patolojik dosyaya karşı.
 */
const CANDIDATE_MAX_BYTES = 2 * 1024 * 1024;
function readFullIndex(dir) {
  if (!dir) return '';
  try {
    const file = path.join(dir, agentMemory.INDEX_FILE);
    const size = fs.statSync(file).size;
    if (size <= CANDIDATE_MAX_BYTES) return fs.readFileSync(file, 'utf8');
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(CANDIDATE_MAX_BYTES);
      fs.readSync(fd, buf, 0, CANDIDATE_MAX_BYTES, 0);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** `…/shared/foo.md` · `foo.md` → `foo`. Dosya yoksa null (defter anahtarı olmaz). */
function slugOf(file) {
  if (!file) return null;
  const base = String(file).split(/[\\/]/).pop() || '';
  return base.replace(/\.md$/i, '') || null;
}

/**
 * Üç kapsamın POINTER satırlarını tek aday havuzunda topla; her adaya kendi
 * sınıfını (`type`) iliştir. Sınıfı okunamayan kayıt `reference` sayılır
 * (memoryGraph'ın varsayılanı) — yani muafiyet ancak AÇIKÇA beyan edilmişse verilir.
 */
function collectCandidates(workspaceRoot, agentId, homedir) {
  const candidates = [];
  const facts = [];
  for (const s of scopeDirs(workspaceRoot, agentId, homedir)) {
    if (!s.dir) continue;
    const index = readFullIndex(s.dir); // ⚠ readIndex DEĞİL — bkz. readFullIndex başlığı
    const classes = factIndex(s.dir);
    for (const [slug, meta] of classes) facts.push({ slug, scope: s.key, ...meta });
    if (!index || !index.trim()) continue;
    for (const line of memoryRecall.parseIndexLines(index)) {
      const slug = slugOf(line.file);
      if (!slug) continue; // dosyaya bağlanmayan satır: defterlenemez, seçkiye de girmez
      const meta = classes.get(slug) || null;
      candidates.push({
        slug,
        scope: s.key,
        label: s.label,
        file: line.file,
        head: line.head,
        hook: line.hook,
        raw: line.raw,
        type: meta ? meta.type : 'reference',
        description: meta ? meta.description : '',
      });
    }
  }
  return { candidates, facts };
}

/**
 * KÜÇÜK HAFIZA = KAYIPSIZ. ADP-862'nin sözü ("indeks bütçeye sığıyorsa hiçbir şey
 * atılmaz") D-07'de de geçerlidir ve bir DURUM kuralıdır, doldurma değil: hafızası
 * birkaç satırdan ibaret bir ajan için seçki yapmak yeni bir kayıp sınıfı yaratır,
 * hiçbir şey kazandırmaz. Eşiği aşan hafızalarda ise spawn'da seçki YAPILMAZ —
 * görev metni yokken "role ilgili" seçmek D-04'ün ölçtüğü kök nedendir.
 */
const SMALL_INDEX = Object.freeze({ maxLines: 12, maxChars: 1200 });

/**
 * AŞAMA A — spawn çekirdeği. Görev metni YOK, o yüzden göreve-göre seçki de yok:
 * yalnız erişim yolu + arama komutu + DAVRANIŞSAL çekirdek (en fazla 3, sınıfa göre)
 * — ya da hafıza yeterince küçükse indeksin TAMAMI (kayıpsız yol).
 *
 * @returns {{text:string, slugs:string[], stats:object}} `text:''` → hiç hafıza yok
 */
function spawnCore({ workspaceRoot, agentId, homedir, cliPath = null, ledger = null, opts = {} } = {}) {
  const facts = [];
  const paths = [];
  const indexLines = [];
  let indexChars = 0;
  try {
    for (const s of scopeDirs(workspaceRoot, agentId, homedir)) {
      if (!s.dir) continue;
      for (const [slug, meta] of factIndex(s.dir)) facts.push({ slug, scope: s.key, ...meta });
      const index = agentMemory.readIndex(s.dir);
      if (!index || !index.trim()) continue;
      paths.push(`"${path.join(s.dir, agentMemory.INDEX_FILE)}" (${s.label})`);
      for (const line of memoryRecall.parseIndexLines(index)) {
        indexLines.push({ scope: s.key, label: s.label, raw: line.raw });
        indexChars += line.raw.length + 1;
      }
    }
  } catch {
    /* okunamayan kapsam sessizce katkısız kalır */
  }
  if (!paths.length) return { text: '', slugs: [], stats: { core: 0, scopes: 0, mode: 'none' } };

  const small = { ...SMALL_INDEX, ...(opts.small || {}) };
  const lossless = indexLines.length > 0 && indexLines.length <= small.maxLines && indexChars <= small.maxChars;

  const lines = [];
  let slugs = [];
  let coreChars = 0;
  if (lossless) {
    lines.push(`HAFIZA — TAMAMI (${indexLines.length} kayıt) · indeksler: ${paths.join(' · ')}`);
    lines.push(...indexLines.map((l) => l.raw));
    coreChars = indexChars;
  } else {
    lines.push(
      `HAFIZA — indeksler: ${paths.join(' · ')}. Bu göreve ÖZEL seçki İŞ METNİYLE BİRLİKTE gelir ` +
        `(<hafıza> bloğu); gelmediyse ya da derinleşmen gerekiyorsa ARA.`,
    );
    const core = targeting.behavioralCore(
      facts,
      { stats: ledger ? (slug) => ledger.stats(slug) : null },
      opts.core || {},
    );
    if (core.lines.length) {
      lines.push(`▸ her işte geçerli davranış kayıtları (${core.lines.length}):`);
      lines.push(...core.lines);
    }
    slugs = core.slugs;
    coreChars = core.chars;
  }
  if (cliPath) {
    lines.push(
      `Arama: \`node "${cliPath}" --workspace "${workspaceRoot}" "<konu>"\` → kaynak + satır + alıntı; ` +
        `hafızada yoksa "${memoryRecall.NOT_FOUND}" der (uydurmaz).`,
    );
  }
  return {
    text: maskSecrets(lines.join('\n')),
    slugs,
    stats: { core: slugs.length, scopes: paths.length, chars: coreChars, mode: lossless ? 'full' : 'core' },
  };
}

/**
 * AŞAMA B — GÖREV METNİYLE seçki. Bu fonksiyonun sorgusu ajanın kimliği DEĞİL,
 * yapılacak İŞtir; D-07'nin bütün konusu budur.
 *
 * @param {{workspaceRoot:string, agentId:string, taskText:string, homedir?:string,
 *          cliPath?:string|null, ledger?:object|null, opts?:object}} o
 * @returns {{text:string, slugs:string[], stats:object}}
 */
function taskBlock({ workspaceRoot, agentId, taskText, homedir, cliPath = null, ledger = null, retrieve = null, opts = {} } = {}) {
  let collected = { candidates: [], facts: [] };
  try {
    collected = collectCandidates(workspaceRoot, agentId, homedir);
  } catch {
    return { text: '', slugs: [], stats: { reason: 'collect-failed', considered: 0 } };
  }
  const sel = targeting.selectTargeted(
    collected.candidates,
    taskText,
    { stats: ledger ? (slug) => ledger.stats(slug) : null },
    opts,
  );
  let text = targeting.renderTaskBlock(sel, { cliPath, workspaceRoot });
  // ADP-872'nin HİBRİT PARÇALARI — artık ROL değil GÖREV sorgusuyla. Ölçülen kök
  // neden buydu: aynı retrieval motoru, yanlış sorguyla besleniyordu. Parça bölümü
  // yalnız seçki BOŞ DEĞİLKEN eklenir: eşiği hiçbir kayıt geçmediyse "bu göreve uyan
  // hafıza yok" hükmünü bir RAG parçasıyla sessizce çürütmek doldurmanın ta kendisi olurdu.
  let chunks = { kept: 0, chars: 0 };
  if (text && typeof retrieve === 'function') {
    try {
      const r = retrieve(taskText) || {};
      const rendered = memoryRecall.renderChunks(r.hits, r.layers || {}, opts.chunks || { max: 2, maxChars: 800 });
      if (rendered.text) {
        chunks = { kept: rendered.kept, chars: rendered.chars };
        text = `${text}\n${rendered.text}`;
      }
    } catch {
      /* retrieval bir dağıtımı ASLA düşüremez */
    }
  }
  return {
    text: text ? maskSecrets(text) : '',
    slugs: sel.picks.map((p) => p.slug),
    stats: {
      chunks,
      considered: sel.considered,
      aboveThreshold: sel.aboveThreshold,
      kept: sel.picks.length,
      chars: sel.chars,
      threshold: sel.threshold,
      reason: sel.reason,
      // Ölçüm için: seçilenlerin skorları (kartın "isabet" iddiası bunlarla denetlenir)
      scores: sel.picks.map((p) => ({ slug: p.slug, relevance: Number(p.relevance.toFixed(3)), decay: Number(p.decay.toFixed(3)) })),
    },
  };
}

module.exports = { SMALL_INDEX, CANDIDATE_MAX_BYTES, readFullIndex, scopeDirs, factIndex, slugOf, collectCandidates, spawnCore, taskBlock };
