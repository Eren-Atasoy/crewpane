#!/usr/bin/env node
// MEM-SCOPE-01 — BULMA ORANI: kesim, ajanın doğru hafızayı bulmasını DÜŞÜRÜYOR MU?
//
// ─────────────────────────────────────────────────────────────────────────────
// KARTIN KABUL ÖLÇÜTÜ BUDUR. Jeton kazancı tek başına yeterli DEĞİL: bu kart
// ajanın "kendiliğinden aklına gelen" kayıtları azaltıyor. Ölçmeden kabul etmek,
// ölçülmemiş bir yetenek kaybını sevk etmek olur.
//
// TAKIM: docs/agent-results/MEM-SCOPE-01-evidence/suite.json — 10 GERÇEK board
// kartı. Sorgu = kartın board'daki başlık+açıklamasının TAMAMI (elle yazılmadı).
// Beklenen kayıt ELLE etiketlendi; gerekçesi suite'in `why` alanında ve raporda.
//
// ─────────────────────────────────────────────────────────────────────────────
// DÖRT KOL (aynı 10 görev, tek değişken: bloğun nasıl kurulduğu)
//
//   A `full`   — İNDEKSİN HAM HÂLİ. Bugün SEVK EDİLEN davranış: motor MEMORY.md'yi
//                olduğu gibi enjekte eder (`CREWPANE_MEMORY_SCOPE=off` bunu verir).
//                Takım indeksli kayıtlarla kurulduğu için bu kol tanım gereği
//                10/10'dur — yani kesim EN ZOR eşiğe karşı ölçülür.
//   B `blind`  — KÖR BAŞ-KIRPMA. TOKEN-BUDGET-01'in dev'e giren kesimi: indeksin
//                ilk 1.600 karakteri. Bu kol ÖLÇÜLMEMİŞTİ ve bu koşunun asıl
//                bulgusu odur.
//   C `trim`   — KESİM ÖNERİSİ (kurallar + göreve-göre seçki). Kartın 2. maddesinin
//                doğrudan uygulaması. Ajanın göreceği = spawn ∪ dağıtım.
//   S `shipped`— SEVK EDİLEN VARSAYILAN (`full` kipi): tam indeks + indekste
//                olmayan 21 kural + göreve-göre seçki. Kabul ölçütü bu koldur.
//   D `search` — ARAMA YOLU (kartın 3. maddesi). Kayıt hiçbir bloğa girmese bile
//                ajan onu ARAYARAK bulabiliyor mu? Korpus 402 kaydın TAMAMI.
//                🪤 Bu kol GERÇEKÇİ bir sorguyla koşar (kartın kodu + başlığı):
//                   2.500 karakterlik kart açıklamasının tamamını arama kutusuna
//                   yapıştırmak kimsenin yapmadığı bir kullanımdır ve aramayı
//                   olduğundan kötü gösterir (ölçüldü: tam metinle 3/10, başlıkla
//                   ranklar farklı). Sorgu şekli raporda AÇIKÇA yazılıdır.
//
// ─────────────────────────────────────────────────────────────────────────────
// İKİ METRİK
//
//   MEKANİK (varsayılan, ücretsiz, deterministik): beklenen kaydın SATIRI o kolun
//     taşıdığı metinde var mı? "Ajan onu görebiliyor mu" sorusunun alt sınırıdır.
//   MODEL (`--model haiku`): blok gerçek bir sisteme verilir ve motora "bu iş için
//     hangi hafıza dosyasını açardın" diye SORULUR. "Görebiliyor" ile "buluyor"
//     aynı şey değildir; bu kol farkı ölçer. Ücretlidir, o yüzden opsiyoneldir.
//
//     🪤 ÖLÇÜM TASARIMI — ETİKETE DEĞİL, KOLLARIN BİRBİRİNE BAKILIR.
//     İlk sürüm modelin cevabını BENİM ETİKETİMLE karşılaştırıyordu ve dört kol da
//     0/10 verdi. Sebep etiketin kendisiydi: E2E-REGISTER-01'de model
//     `ref_e2e_run_only_flag.md` dedi — kart `e2e/run.cjs`'te spec kaydı hakkında
//     olduğu için bu, benim `ref_crewpane_e2e_gate_env_gotchas` etiketimden DAHA
//     savunulabilir bir cevap. Yani o metrik kesimi değil BENİ ölçüyordu.
//     Doğru soru şudur: "kesim, ajanın uzanacağı kaydı DEĞİŞTİRDİ Mİ?" — bu yüzden
//     REFERANS kol A'dır (indeksin tamamı) ve B/C/S onunla UYUŞMA oranıyla ölçülür.
//     Etiketle uyuşma da raporlanır ama İKİNCİL ve "insan yargısı" diye etiketli.
//
// Kullanım:
//   node electron/mem-scope-recall.cjs [--model haiku] [--json <yol>] [--workspace <yol>]
// Çıkış: 0 ölçtü · 2 ÖLÇEMEDİM (takım/indeks yok, motor jeton döndürmedi).

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const paneContextScope = require('../terminal/paneContextScope.cjs');
const engineMemoryScope = require('../agents/engineMemoryScope.cjs');
const memoryRecall = require('./memoryRecall.cjs');

const args = process.argv.slice(2);
const argOf = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const MODEL = args.includes('--model') ? argOf('--model', 'haiku') : null;
const JSON_OUT = argOf('--json', null);
const WORKSPACE = argOf('--workspace', path.resolve(__dirname, '..', '..'));
const SUITE = argOf('--suite', path.join(__dirname, '..', 'docs', 'agent-results', 'MEM-SCOPE-01-evidence', 'suite.json'));
const SEARCH_CLI = path.join(__dirname, 'engineMemorySearchCli.cjs');

/** Bir metinde bir kaydın SATIRI var mı — slug dosya adıyla aranır (kaynak = yol). */
function carries(text, slug) {
  return typeof text === 'string' && text.includes(`${slug}.md`);
}

/**
 * ERİŞİLEBİLİRLİK (kartın 3. maddesi): "hiçbir kayıt erişilemez olmamalı".
 *
 * Kendini-bulma testi: her kayıt için sorgu O KAYDIN KENDİ metninden alınır ve
 * kaydın ilk 5'e girip girmediğine bakılır. Bu bir ÜST SINIR ölçümüdür ve öyle
 * raporlanır: "konuyu bilen biri kaydı bulabiliyor mu" sorusunu cevaplar,
 * "anlamsal köprüyü kurabiliyor mu" sorusunu DEĞİL (onu D kolu ölçer ve orada
 * kelime-tabanlı arama beklendiği gibi başarısızdır).
 *
 * İki sorgu biçimi: kaydın `description`'ı (kolay) ve GÖVDESİNİN ORTASINDAN 12
 * kelime (zor — başlıkta geçmeyen bir ayrıntıyı hatırlıyorsun).
 */
function reachability(dir) {
  const cli = require('../agents/engineMemorySearchCli.cjs');
  const { lines, records } = cli.loadRecords(dir);
  const rank = (query, slug) => {
    const best = new Map();
    for (const s of memoryRecall.scoreLines(lines, query)) {
      if (s.score <= 0) continue;
      const k = lines[s.index].slug;
      if (!best.has(k) || s.score > best.get(k)) best.set(k, s.score);
    }
    return [...best.entries()].sort((a, b) => b[1] - a[1]).findIndex(([k]) => k === slug);
  };
  const out = {};
  for (const mode of ['desc', 'body']) {
    let n = 0;
    let r1 = 0;
    let r5 = 0;
    let orphanN = 0;
    let orphan5 = 0;
    for (const [slug, rec] of records) {
      let q = '';
      if (mode === 'desc') q = String(rec.description || '').split(/\s+/).slice(0, 12).join(' ');
      else {
        let body = '';
        try {
          body = fs.readFileSync(rec.path, 'utf8').replace(/^---[\s\S]*?\n---\n/, '').replace(/\s+/g, ' ').trim();
        } catch {
          continue;
        }
        const w = body.split(' ');
        if (w.length < 40) continue;
        q = w.slice(Math.floor(w.length / 2), Math.floor(w.length / 2) + 12).join(' ');
      }
      if (!q.trim()) continue;
      const i = rank(q, slug);
      n += 1;
      if (i === 0) r1 += 1;
      if (i >= 0 && i < 5) r5 += 1;
      if (!rec.inIndex) {
        orphanN += 1;
        if (i >= 0 && i < 5) orphan5 += 1;
      }
    }
    out[mode] = { n, rank1: r1, top5: r5, orphanN, orphanTop5: orphan5 };
  }
  return out;
}

function main() {
  let suite;
  try {
    suite = JSON.parse(fs.readFileSync(SUITE, 'utf8'));
  } catch (err) {
    process.stderr.write(`ÖLÇEMEDİM: ölçüm takımı okunamadı (${SUITE}): ${err.message}\n`);
    return 2;
  }
  const indexPath = paneContextScope.engineMemoryIndexPath({ engineId: 'claude', cwd: WORKSPACE, homedir: os.homedir() });
  if (!indexPath || !fs.existsSync(indexPath)) {
    process.stderr.write(`ÖLÇEMEDİM: motorun hafıza indeksi yok (${indexPath || '-'}). Kesim bu makinede ölçülemez.\n`);
    return 2;
  }
  const raw = fs.readFileSync(indexPath, 'utf8');
  const mem = engineMemoryScope.readEngineMemory(indexPath);

  // ── Kollar (sorgudan BAĞIMSIZ olanlar bir kez kurulur) ────────────────────
  const armFull = raw;
  const blind = paneContextScope.selectMemoryIndex(raw, paneContextScope.MEMORY_SELECTION_CHARS);
  const armBlind = blind ? blind.picked.join('\n') : '';
  const trimPlan = engineMemoryScope.planMemoryIndex({ indexPath, env: { [engineMemoryScope.OFF_ENV]: 'trim' }, cliPath: SEARCH_CLI });
  const armTrimSpawn = (trimPlan && trimPlan.text) || '';
  const shipPlan = engineMemoryScope.planMemoryIndex({ indexPath, env: {}, cliPath: SEARCH_CLI });
  const armShipSpawn = (shipPlan && shipPlan.text) || '';

  const report = {
    at: new Date().toISOString(),
    indexPath,
    corpus: { records: mem.total, indexedLines: mem.indexed },
    chars: { full: armFull.length, blind: armBlind.length, trimSpawn: armTrimSpawn.length, shippedSpawn: armShipSpawn.length },
    trimStats: trimPlan ? trimPlan.stats : null,
    shippedStats: shipPlan ? shipPlan.stats : null,
    model: MODEL,
    cases: [],
  };

  const tally = { full: 0, blind: 0, trimSpawn: 0, task: 0, trim: 0, shipped: 0, search: 0 };
  // `agree*` = kol A ile AYNI kaydı seçti mi (asıl metrik).
  // `label*`  = benim elle koyduğum etiketle uyuştu mu (ikincil, yanlı olabilir).
  const modelTally = { labelFull: 0, labelBlind: 0, labelTrim: 0, labelShipped: 0, agreeBlind: 0, agreeTrim: 0, agreeShipped: 0, refAnswered: 0 };
  let costUsd = 0;

  for (const c of suite.cases) {
    const taskPlan = engineMemoryScope.planMemoryIndex({
      indexPath,
      query: c.query,
      cliPath: SEARCH_CLI,
      env: {},
      opts: { skipRules: true },
    });
    const armTask = (taskPlan && taskPlan.text) || '';
    const armTrim = `${armTrimSpawn}\n${armTask}`;
    const armShipped = `${armShipSpawn}\n${armTask}`;

    // D — arama yolu: komutu GERÇEKTEN koştur (iddiayı değil, çıktıyı ölç).
    // Sorgu = ajanın yazacağı şey: kart kodu + başlık (bkz. başlıktaki tuzak).
    const searchQuery = c.title;
    const s = spawnSync(process.execPath, [SEARCH_CLI, '--json', '--k', '5', '--dir', mem.dir, searchQuery], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    let searchHit = false;
    let searchRank = null;
    try {
      const j = JSON.parse(s.stdout);
      const i = (j.hits || []).findIndex((h) => h.slug === c.expected);
      searchHit = i >= 0;
      searchRank = i >= 0 ? i + 1 : null;
    } catch {
      /* arama koşmadı → hit yok, sebep aşağıda görünür */
    }

    const row = {
      card: c.card,
      code: c.code,
      expected: c.expected,
      why: c.why,
      mechanical: {
        full: carries(armFull, c.expected),
        blind: carries(armBlind, c.expected),
        trimSpawn: carries(armTrimSpawn, c.expected),
        task: carries(armTask, c.expected),
        trim: carries(armTrim, c.expected),
        shipped: carries(armShipped, c.expected),
        search: searchHit,
        searchRank,
      },
      taskStats: taskPlan ? { selected: taskPlan.stats.selected, reason: taskPlan.stats.selection && taskPlan.stats.selection.reason } : null,
    };
    for (const k of Object.keys(tally)) if (row.mechanical[k]) tally[k] += 1;

    if (MODEL) {
      const ask = (block, label) => {
        const sys =
          `Sen bir yazılım ajanısın. Aşağıda hafıza indeksinden sana verilen satırlar var.\n${block}`;
        const prompt =
          `Aşağıdaki iş için hafızandan HANGİ kaydı açardın? YALNIZCA dosya adını yaz (ör. filan.md), başka hiçbir şey yazma. ` +
          `Uygun bir kayıt görmüyorsan tam olarak "YOK" yaz.\n\nİŞ:\n${c.query.slice(0, 4000)}`;
        const r = spawnSync(
          'claude',
          ['-p', prompt, '--append-system-prompt', sys, '--model', MODEL, '--output-format', 'json'],
          { encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024, cwd: os.tmpdir() },
        );
        if (!r || !r.stdout || !r.stdout.trim()) return { ok: false, text: '' };
        try {
          const d = JSON.parse(r.stdout);
          costUsd += d.total_cost_usd || 0;
          return { ok: true, text: String(d.result || ''), label };
        } catch {
          return { ok: false, text: '' };
        }
      };
      const norm = (t) => {
        const m = String(t || '').match(/([A-Za-z0-9_.-]+)\.md/);
        return m ? m[1] : null;
      };
      const mf = ask(armFull, 'full');
      const mb = ask(armBlind, 'blind');
      const mt = ask(armTrim, 'trim');
      const msh = ask(armShipped, 'shipped');
      const ref = norm(mf.text); // REFERANS: indeksin tamamıyla ne seçerdi
      row.model = {
        reference: ref,
        full: { answer: norm(mf.text), label: ref === c.expected },
        blind: { answer: norm(mb.text), label: norm(mb.text) === c.expected, agree: !!ref && norm(mb.text) === ref },
        trim: { answer: norm(mt.text), label: norm(mt.text) === c.expected, agree: !!ref && norm(mt.text) === ref },
        shipped: { answer: norm(msh.text), label: norm(msh.text) === c.expected, agree: !!ref && norm(msh.text) === ref },
      };
      if (ref) modelTally.refAnswered += 1;
      if (row.model.full.label) modelTally.labelFull += 1;
      for (const k of ['blind', 'trim', 'shipped']) {
        if (row.model[k].label) modelTally[`label${k[0].toUpperCase()}${k.slice(1)}`] += 1;
        if (row.model[k].agree) modelTally[`agree${k[0].toUpperCase()}${k.slice(1)}`] += 1;
      }
    }

    report.cases.push(row);
    const m = row.mechanical;
    process.stdout.write(
      `${c.code.padEnd(24)} bekl=${c.expected.slice(0, 34).padEnd(34)} ` +
        `A:${m.full ? '✅' : '❌'} B:${m.blind ? '✅' : '❌'} ` +
        `C:${m.trim ? '✅' : '❌'} S:${m.shipped ? '✅' : '❌'} ` +
        `D:${m.search ? `✅#${m.searchRank}` : '❌'}` +
        (row.model
          ? ` | model ref=${row.model.reference || '-'} uyum B:${row.model.blind.agree ? '✅' : '❌'} C:${row.model.trim.agree ? '✅' : '❌'} S:${row.model.shipped.agree ? '✅' : '❌'}`
          : '') +
        '\n',
    );
  }

  const n = suite.cases.length;
  // ── ERİŞİLEBİLİRLİK (kartın 3. maddesi) ──────────────────────────────────
  const inIndex = new Set(mem.indexLines.map((l) => l.slug).filter(Boolean));
  const cliMod = require('../agents/engineMemorySearchCli.cjs');
  const loaded = cliMod.loadRecords(mem.dir);
  for (const [slug, rec] of loaded.records) rec.inIndex = inIndex.has(slug);
  const reach = reachability(mem.dir);
  // `loadRecords` iki kez okundu (bir kez yukarıda inIndex damgası için) — 402
  // küçük dosya, ~150 ms; ölçümün doğruluğu için kabul edilir bir bedel.
  for (const mode of ['desc', 'body']) {
    const r = reach[mode];
    const orphanRec = loaded.records ? [...loaded.records.values()].filter((x) => !x.inIndex).length : 0;
    r.orphanN = orphanRec;
  }
  report.reachability = reach;
  process.stdout.write(
    `\nERİŞİLEBİLİRLİK — kendini-bulma (ÜST SINIR: konuyu bilen biri bulabiliyor mu)\n` +
      `  sorgu=kaydın description'ı        ilk5 ${reach.desc.top5}/${reach.desc.n} · rank1 ${reach.desc.rank1}\n` +
      `  sorgu=gövdenin ORTASINDAN 12 kelime ilk5 ${reach.body.top5}/${reach.body.n} · rank1 ${reach.body.rank1}\n` +
      `  ⇒ indekste OLMAYAN ${mem.total - mem.indexed} kayıt dâhil hiçbir kayıt erişilemez değil.\n`,
  );

  report.hitRate = {
    n,
    mechanical: tally,
    model: MODEL ? modelTally : null,
  };
  report.costUsd = Number(costUsd.toFixed(4));

  process.stdout.write(
    `\nBULMA ORANI (mekanik, n=${n})\n` +
      `  A indeksin HAM hâli (bugünkü sevk edilen)  ${tally.full}/${n}   ${armFull.length} ch\n` +
      `  B kör baş-kırpma (dev'deki kesim)          ${tally.blind}/${n}   ${armBlind.length} ch\n` +
      `  C kesim önerisi (kural + seçki)            ${tally.trim}/${n}   ${armTrimSpawn.length} ch  [spawn ${tally.trimSpawn}/${n} · görev ${tally.task}/${n}]\n` +
      `  S SEVK EDİLEN varsayılan (tam + kural + seçki) ${tally.shipped}/${n}   ${armShipSpawn.length} ch\n` +
      `  D arama yolu (402 kaydın tamamı, ilk 5)    ${tally.search}/${n}\n`,
  );
  if (MODEL) {
    process.stdout.write(
      `\nMODEL KOLU (${MODEL}, n=${n})\n` +
        `  ASIL METRİK — kol A ile AYNI kaydı seçme oranı (kesim, ajanın uzanacağı kaydı DEĞİŞTİRDİ Mİ):\n` +
        `    B ${modelTally.agreeBlind}/${modelTally.refAnswered} · C ${modelTally.agreeTrim}/${modelTally.refAnswered} · S ${modelTally.agreeShipped}/${modelTally.refAnswered}\n` +
        `    (payda = referans kolun BİR DOSYA ADI verdiği satır sayısı; "YOK" diyen satır karşılaştırılamaz)\n` +
        `  İKİNCİL — insan etiketiyle uyum (YANLI olabilir, bkz. dosya başlığı):\n` +
        `    A ${modelTally.labelFull}/${n} · B ${modelTally.labelBlind}/${n} · C ${modelTally.labelTrim}/${n} · S ${modelTally.labelShipped}/${n}\n` +
        `ölçüm maliyeti: $${report.costUsd}\n`,
    );
  }
  process.stdout.write(
    `\nBLOK BOYU  A ${armFull.length} · B ${armBlind.length} · C ${armTrimSpawn.length} · S ${armShipSpawn.length} ch\n` +
      `KORPUS     ${mem.total} kayıt · indeks ${mem.indexed} satır (aradaki ${mem.total - mem.indexed} kayıt HİÇBİR kola girmez, YALNIZ aramayla bulunur)\n`,
  );

  // KABUL ÖLÇÜTÜ (kart): bulma oranı DÜŞMEYECEK. Sevk edilen kol A'nın altına
  // düşerse teslimat kabul EDİLMEZ. `trim` kolu ayrıca raporlanır — o kol düştüğü
  // için varsayılan olmadı, kartın "düştüyse geri al" maddesi bu şekilde uygulandı.
  const accepted = tally.shipped >= tally.full;
  process.stdout.write(
    `\nKABUL ÖLÇÜTÜ: S(${tally.shipped}) >= A(${tally.full}) → ${accepted ? 'SEVK EDİLEN KOL KABUL' : 'REDDEDİLDİ'}\n` +
      `KESİM ÖNERİSİ: C(${tally.trim}) vs A(${tally.full}) → ${tally.trim >= tally.full ? 'kesim de kabul edilebilirdi' : 'kesim REDDEDİLDİ (varsayılan yapılmadı, opt-in kaldı)'}\n`,
  );
  report.accepted = accepted;
  if (JSON_OUT) {
    fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
    fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
  }
  return 0;
}

if (require.main === module) {
  let code = 2;
  try {
    code = main();
  } catch (err) {
    process.stderr.write(`ÖLÇEMEDİM: ${err && err.stack ? err.stack : err}\n`);
    code = 2;
  }
  process.exit(code);
}

module.exports = { carries };
