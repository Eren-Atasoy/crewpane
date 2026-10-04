#!/usr/bin/env node
// MEM-SCOPE-01 — MOTORUN KALICI HAFIZASINDA ARAMA (ajanların kullandığı uç).
//
//     node electron/engineMemorySearchCli.cjs "release paketi bayat mı"
//
// ─────────────────────────────────────────────────────────────────────────────
// NEDEN AYRI BİR KOMUT VAR
//
// `memoryRecallCli.cjs` ÜRÜNÜN kendi hafızasını (`<çalışma alanı>/.crewpane/
// memory/**`) arar. Bu komut MOTORUN kalıcı hafızasını arar
// (`~/.claude/projects/<cwd-slug>/memory/**`) — iki ayrı depo, iki ayrı yol.
// MEM-SCOPE-01 motorun İNDEKSİNİ kestiği için, kesilen kayıtlara giden bir yol
// AÇILMAK ZORUNDAYDI; kartın 3. maddesi ("geri kalan ARANABİLİR kalır") bu dosyadır.
//
// 🔑 ÖLÇÜLDÜ (09.09): bu depoda 402 kayıt var, `MEMORY.md` yalnız 143'ünü
//    listeliyor. Yani 259 kayıt kesimden ÖNCE de hiçbir pane'e girmiyordu ve
//    onlara ulaşan bir komut YOKTU. Bu komut dizinin TAMAMINI tarar — indeksin
//    göremediği 259 kaydı da bulur. Kesim erişilebilirliği düşürmez, ARTIRIR.
//
// ─────────────────────────────────────────────────────────────────────────────
// PUANLAMA — SATIR SEVİYESİNDE, DOSYA SEVİYESİNDE DEĞİL
//
// `memoryRecall.scoreLines` — ürünün hafıza aramasıyla AYNI çekirdek (idf +
// uzunluk cezası). İkinci bir sıralama mantığı yazılmaz.
//
// 🪤 ÖLÇÜLDÜ (bu kartın ilk sürümü, 10 gerçek görev): dosyanın TAMAMINI tek bir
//    "satır" gibi puanlamak aramayı ÇALIŞMAZ hâle getiriyordu — 10 görevin
//    yalnız 1'inde doğru kayıt ilk 5'e giriyordu. Sebep uzunluk cezası:
//    `1 + ln(1 + len/400)`. 8.000 karakterlik ayrıntılı bir kayıt 4,0× ceza
//    yerken 500 karakterlik bir not 1,2× yiyor; yani arama sistematik olarak
//    KISA kayıtları seçiyordu ve aranan şey hep uzun olanlardı. Ceza eğrisi
//    yanlış değil, uygulandığı BİRİM yanlıştı: o eğri İNDEKS SATIRI için
//    kalibre edilmiş. Ürünün kendi araması da bu yüzden dosyayı değil PARÇAYI
//    (chunk) puanlar. Burada da öyle: her kayıt satırlarına bölünür, puan
//    satır bazında hesaplanır, kayıt EN İYİ SATIRININ puanıyla temsil edilir.
//    Ölçüm sonrası: 1/10 → aşağıdaki tabloya bak (rapor §bulma oranı).
//
// Bulunamazsa `memoryRecall.NOT_FOUND` basılır — UYDURMA YOK.
// Çıkış kodları: 0 = koştu (bulundu ya da dürüstçe bulunamadı) · 2 = ÖLÇEMEDİM
// (dizin yok / okunamadı) — "sonuç yok" ile karıştırılmasın.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const memoryRecall = require('../memory/memoryRecall.cjs');
const memoryGraph = require('../memory/memoryGraph.cjs');

/** cwd → motorun hafıza dizini slug'ı. paneContextScope.cwdSlug ile AYNI kural. */
const { cwdSlug } = require('../terminal/paneContextScope.cjs');

function parseArgs(argv) {
  const out = { query: [], k: 5, json: false, dir: null, cwd: null, home: null, full: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--full') out.full = true;
    else if (a === '--k') out.k = Math.max(1, Number(argv[++i]) || 5);
    else if (a === '--dir') out.dir = argv[++i] || null;
    else if (a === '--cwd') out.cwd = argv[++i] || null;
    else if (a === '--home') out.home = argv[++i] || null;
    else if (a === '--help' || a === '-h') out.help = true;
    else out.query.push(a);
  }
  return { ...out, query: out.query.join(' ').trim() };
}

/** Aranacak dizin: açık `--dir` > `<home>/.claude/projects/<cwd-slug>/memory`. */
function resolveDir(args) {
  if (args.dir) return path.resolve(args.dir);
  const home = args.home || os.homedir();
  const cwd = args.cwd || process.cwd();
  return path.join(home, '.claude', 'projects', cwdSlug(cwd), 'memory');
}

/** Bir kaydın gövdesinden puanlanabilir SATIRLAR. Boş satır ve tek başına
 *  başlık işareti elenir; çok uzun satır (yapıştırılmış log) 600 karakterlik
 *  parçalara bölünür — yoksa uzunluk cezası o kaydı yine gömerdi. */
function bodyLines(raw, meta) {
  const body = raw.replace(/^---[\s\S]*?\n---\n/, '');
  const out = [];
  const push = (t) => {
    const v = t.replace(/\s+/g, ' ').trim();
    if (v.length >= 12) out.push(v);
  };
  // `description` kaydın ÖZETİDİR ve tek başına bir satır kadar değerlidir.
  if (meta.description) push(meta.description);
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t || /^[#>*\-=_`]{1,3}$/.test(t)) continue;
    if (t.length <= 600) push(t);
    else for (let i = 0; i < t.length; i += 600) push(t.slice(i, i + 600));
  }
  return out;
}

/**
 * Dizindeki kayıtları SATIRLARINA böl. Puanlama birimi satırdır (bkz. başlıktaki
 * uzunluk-cezası tuzağı); kayıt en iyi satırının puanıyla temsil edilir.
 *
 * @returns {{lines:Array, records:Map}} `lines` scoreLines'a verilir, `records`
 *   slug → künye (tür, yol) eşlemesidir.
 */
function loadRecords(dir) {
  const lines = [];
  const records = new Map();
  for (const f of memoryGraph.listFactFiles(dir)) {
    let raw = '';
    try {
      raw = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    const slug = f.replace(/\.md$/i, '');
    const meta = memoryGraph.parseFact(raw);
    records.set(slug, { slug, type: meta.type, path: path.join(dir, f), file: f, description: meta.description });
    const head = `- [${slug}](${f}) — `;
    for (const t of bodyLines(raw, meta)) {
      lines.push({ raw: `${head}${t}`, head, hook: t, slug });
    }
  }
  return { lines, records };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.query) {
    process.stdout.write(
      'Kullanım: node electron/engineMemorySearchCli.cjs "<konu>" [--k 5] [--json] [--full] [--dir <yol>] [--cwd <yol>]\n' +
        '  Motorun kalıcı hafızasını (indeks + indekste OLMAYAN kayıtlar) tarar.\n',
    );
    return args.help ? 0 : 2;
  }
  const dir = resolveDir(args);
  let loaded;
  try {
    if (!fs.statSync(dir).isDirectory()) throw new Error('dizin değil');
    loaded = loadRecords(dir);
  } catch (err) {
    process.stderr.write(`ÖLÇEMEDİM: hafıza dizini okunamadı (${dir}): ${err.message}\n`);
    return 2;
  }
  const { lines, records } = loaded;
  if (!records.size) {
    process.stderr.write(`ÖLÇEMEDİM: ${dir} içinde kayıt yok.\n`);
    return 2;
  }

  // Kayıt = EN İYİ SATIRININ puanı. (Satır puanlarını TOPLAMAK uzun kaydı yine
  // öne alırdı — düzeltilen tuzağın aynısını arka kapıdan geri getirirdi.)
  const best = new Map();
  for (const s of memoryRecall.scoreLines(lines, args.query)) {
    if (s.score <= 0) continue;
    const slug = lines[s.index].slug;
    const cur = best.get(slug);
    if (!cur || s.score > cur.score) best.set(slug, { score: s.score, hits: s.hits, quote: lines[s.index].hook });
  }
  const hits = [...best.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, args.k)
    .map(([slug, v]) => ({
      slug,
      type: records.get(slug).type,
      path: records.get(slug).path,
      score: Number(v.score.toFixed(3)),
      quote: memoryRecall.clipHook(v.quote, v.hits, args.full ? 4000 : 320),
    }));

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({ dir, scanned: records.size, lines: lines.length, query: args.query, hits }, null, 2)}\n`,
    );
    return 0;
  }
  if (!hits.length) {
    process.stdout.write(`${memoryRecall.NOT_FOUND}\n(${records.size} kayıt tarandı: ${dir})\n`);
    return 0;
  }
  process.stdout.write(`${records.size} kayıt / ${lines.length} satır tarandı: ${dir}\n\n`);
  for (const h of hits) {
    process.stdout.write(`▸ ${h.slug} [${h.type}] · ${h.path}\n  ${h.quote}\n\n`);
  }
  process.stdout.write('Tamamını okumak için dosyayı aç (yol yukarıda) ya da --full ekle.\n');
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

module.exports = { parseArgs, resolveDir, bodyLines, loadRecords };
