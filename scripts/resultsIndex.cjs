// ADP-301 — docs/agent-results/INDEX.md üreticisi + KANIT denetçisi.
//
// Neden script (dosya izleyici DEĞİL): indeks, uygulama AÇIK olmasa da (worker pane'i,
// CI, temiz checkout) yeniden üretilebilir olmalı. Bir Electron file-watcher yalnız app
// koşarken çalışır, headless worker'ın commit'ini kaçırır ve deterministik değildir.
// Bu script her yerden koşar, çıktısı girdiden saf türetilir (aynı ağaç → aynı INDEX.md).
// Ajan kimliğine gömülü rapor kuralı (agentIdentity.RESULT_REPORT_BASELINE) worker'a
// raporu yazdıktan sonra `npm run results:index` çalıştırmasını söyler → tek kaynak.
//
//   npm run results:index          → INDEX.md üret (yaz)
//   npm run results:index -- --check  → yazmaz; KANIT YOK varsa exit 1 (sahte "bitti" avı)
//
// RES-IDX-01 — PAYLAŞIMLI ARAÇ: script artık bu repoya çivili DEĞİL. Kök şu sırayla
// çözülür: `--root <dir>` → `RESULTS_INDEX_ROOT` env → cwd'den yukarı ilk
// `docs/agent-results/` sahibi → bu script'in kendi reposu. Kardeş repolar
// (skool, muratify-com, agentshot …) package.json'larında
//   "results:index": "node ../agentdesk/scripts/resultsIndex.cjs --root ."
// ile AYNI davranışı/çıktıyı alır (BUG-R3 #8: skool/kökte "Missing script" → FAIL).
//
// Saf fonksiyonlar (parseFileName/extractTitle/hasEvidence/renderIndex) test edilebilir:
//   node --test scripts/resultsIndex.test.cjs

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { resolveReportAgent } = require('../electron/reportAgentId.cjs');

const SCRIPT_REPO_ROOT = path.resolve(__dirname, '..');
const INDEX_NAME = 'INDEX.md';
const RESULTS_REL = path.join('docs', 'agent-results');

/** `--root <dir>` / `--root=<dir>` argümanı (yoksa null). Pure. */
function rootArg(argv) {
  const a = argv || [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--root' && a[i + 1]) return a[i + 1];
    if (typeof a[i] === 'string' && a[i].startsWith('--root=')) return a[i].slice('--root='.length);
  }
  return null;
}

/** cwd'den yukarı çıkarak `docs/agent-results/` dizini olan İLK ata (yoksa null). */
function findResultsOwner(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  for (let i = 0; i < 12; i++) {
    try {
      if (fs.statSync(path.join(dir, RESULTS_REL)).isDirectory()) return dir;
    } catch {
      /* bu seviyede yok — yukarı */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Repo kökü çözümü (bkz. başlık). `explicit` verildiyse doğrulanır, yoksa hata. */
function resolveRepoRoot(argv, env = process.env, cwd = process.cwd()) {
  const explicit = rootArg(argv) || (env && env.RESULTS_INDEX_ROOT) || null;
  if (explicit) return path.resolve(cwd, explicit);
  return findResultsOwner(cwd) || SCRIPT_REPO_ROOT;
}

// Geriye dönük: modül sabitleri (mobileReports/test tüketicileri) script reposunu gösterir;
// CLI koşusu `main()` içinde kökü YENİDEN çözer (aşağıda).
let REPO_ROOT = SCRIPT_REPO_ROOT;
let RESULTS_DIR = path.join(REPO_ROOT, RESULTS_REL);

// ─── OFİS ROSTERI (VERİ) ──────────────────────────────────────────────────────
// ⚠️ YENİ AJAN GELİNCE BURAYA EKLE (RESULTS-INDEX-ROSTER-01): kaynak board `employees`
// tablosu (agent_id → teams.name). Listede olmayan ajanın raporu INDEX.md'de "ajan yok /
// takım yok" satırı olur ve mobil Raporlar takım süzgecine düşmez (ADP-364). Bayatlama
// SESSİZ DEĞİL: `results:index` roster dışı kalan sık sonekleri uyarı olarak basar
// (aşağıda `rosterDriftHints`). Ölçüm 2026-09-19: 60 çalışan, 6 takım.
//
// Çözümleyici BURADA DEĞİL: `electron/reportAgentId.cjs` (REPORTS-AGENT-ID-01) — Raporlar
// sekmesi (reports.ts + ReportsView) ile AYNI fonksiyon; tireli kimlik + `-N` kopya eki.
const TEAM_OF = Object.freeze({
  // agentdesk kanadı
  optimus: 'Transformers',
  bumblebee: 'Transformers',
  wheeljack: 'Transformers',
  ratchet: 'Transformers',
  jazz: 'Transformers',
  inferno: 'Transformers',
  prowl: 'Transformers',
  blaster: 'Transformers',
  ironhide: 'Transformers',
  perceptor: 'Transformers',
  grapple: 'Transformers',
  'codex-i-abla': 'Transformers',
  // chatflow kanadı
  fury: 'Marvel',
  stark: 'Marvel',
  vision: 'Marvel',
  parker: 'Marvel',
  cap: 'Marvel',
  wanda: 'Marvel',
  barton: 'Marvel',
  romanoff: 'Marvel',
  falcon: 'Marvel',
  hulk: 'Marvel',
  kamil: 'Marvel',
  loki: 'Marvel',
  thor: 'Marvel',
  test: 'Marvel',
  // education kanadı
  arrow: 'DC',
  batman: 'DC',
  flash: 'DC',
  joker: 'DC',
  'codex-i': 'DC',
  wonder_woman: 'DC',
  'ra-s-al-ghul': 'DC',
  // kanatsız takımlar
  apollo: 'AGIMEN',
  atlas: 'AGIMEN',
  ameca: 'AGIMEN',
  digit: 'AGIMEN',
  figure: 'AGIMEN',
  g1: 'AGIMEN',
  helix: 'AGIMEN',
  moxi: 'AGIMEN',
  neo: 'AGIMEN',
  nex: 'AGIMEN',
  phoenix: 'AGIMEN',
  robo: 'AGIMEN',
  spot: 'AGIMEN',
  stretch: 'AGIMEN',
  blader: 'AILeague',
  dagger: 'AILeague',
  hawkeye: 'AILeague',
  katana: 'AILeague',
  plasma: 'AILeague',
  puppy: 'AILeague',
  taser: 'AILeague',
  // pazarlama kanadı (insan çalışanlar)
  damla: 'HUMAN',
  enzo: 'HUMAN',
  ines: 'HUMAN',
  sami: 'HUMAN',
  'yagmur-a00000': 'HUMAN',
  'zeki-a00000': 'HUMAN',
});

// Roster = TEAM_OF anahtarları (tek liste; ajan listesi ile takım eşlemesi ayrışıp bayatlamasın).
const AGENTS = new Set(Object.keys(TEAM_OF));

// Dosya adı sonekinde sık görülen ama ajan OLMAYAN jetonlar (kopya/kanıt türevleri) —
// bayatlama uyarısında gürültü olmasın diye. Ajan adı DEĞİL; buraya ajan ekleme.
const NOT_AGENT_SUFFIXES = new Set(['verify', 'scene', 'probe', 'release', 'design', 'report']);

/** Ajan adından takımı. Bilinmeyen ajan → ''. Pure. */
function teamOf(agent) {
  return (agent && TEAM_OF[String(agent).toLowerCase()]) || '';
}

/**
 * `ADP-320-jazz.md` → { taskId: 'ADP-320', agent: 'jazz' }. Ajan yoksa agent=null. Pure.
 * REPORTS-AGENT-ID-01 — ortak çözümleyici: tireli kimlik (`codex-i-abla`), `-N` kopya eki
 * (`ADP-320-jazz-2.md` → taskId ADP-320, agent jazz; eskiden taskId'ye yapışıyordu).
 * Ajan sonda değilse (`ADP-630-jazz-v2.md`) yine jazz; kuyruk taskId'ye GİRMEZ.
 */
function parseFileName(file, roster = AGENTS) {
  const hit = resolveReportAgent(file, roster);
  if (!hit.matched) return { taskId: hit.taskId, agent: null };
  return { taskId: hit.taskId, agent: hit.agentId };
}

/**
 * Roster bayatlama ipuçları: rosterda OLMAYAN, ad-benzeri ve ≥ `min` raporda son segment
 * olarak görülen jetonlar (sayılarıyla). Uyarıdır, kapı değil. Pure.
 */
function rosterDriftHints(files, roster = AGENTS, min = 5) {
  const counts = new Map();
  for (const f of files) {
    const base = String(f).replace(/\.md$/i, '');
    if (resolveReportAgent(f, roster).matched) continue;
    const last = base.split('-').pop().toLowerCase();
    if (!/^[a-z][a-z0-9_]{1,}$/.test(last) || NOT_AGENT_SUFFIXES.has(last)) continue;
    counts.set(last, (counts.get(last) || 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n >= min).sort((a, b) => b[1] - a[1]);
}

/** İlk `# ` başlığından raporun başlığı (görev id'si baştan düşürülür). Pure. */
function extractTitle(md, taskId) {
  const m = /^#\s+(.+)$/m.exec(md || '');
  if (!m) return '';
  let t = m[1].trim();
  if (taskId) {
    const esc = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`^${esc}\\s*[—–:-]\\s*`), '').trim();
  }
  return t.replace(/\s+/g, ' ');
}

/**
 * KANIT var mı? (ADP-301 §5 — sahte "bitti" yakalayıcı.) Kanıt = raporun kanıt/doğrulama
 * bölümünün ALTINDA gerçek bir iz: kod bloğu (komut çıktısı), ekran görüntüsü linki, ya da
 * en az bir dolu satır. Sadece "Kanıt:" başlığı atıp boş bırakmak KANIT değildir. Pure.
 */
function hasEvidence(md) {
  const text = (md || '').trim();
  if (!text) return false;
  const lines = text.split('\n');

  // Bir satırın kanıt ETİKETİ mi olduğu: başlık (`## Kanıt`, `## 3) Doğrulama`),
  // kalın etiket (`**Kanıt:** …`) ya da tablo satırı (`| **Kanıt** | … |`).
  const labelOf = (l) =>
    (l || '')
      .replace(/^\s*[|>\s-]*/, '') // tablo/alıntı/liste öneki
      .replace(/^#{1,6}\s*/, '') // başlık işareti
      .replace(/^\**/, '') // kalın açılışı
      .replace(/^\s*\d+\s*[.)]?\s*/, '') // "3) " / "1. " sıra numarası
      .replace(/^\**/, '');
  const EVIDENCE = /^(kanıt|kanit|evidence|doğrulama|dogrulama|proof)\b/i;
  const isEvidenceLabel = (l) => EVIDENCE.test(labelOf(l));
  const isTableRow = (l) => /^\s*\|/.test(l);
  const isHeading = (l) => /^#{1,6}\s+/.test(l);
  // İçi boşaltılmış bölüm ("—", "yok", "TBD") kanıt DEĞİLDİR.
  const meaningful = (s) => {
    const t = s.replace(/[*_`|\-—–:\s]/g, '');
    return t.length > 0 && !/^(yok|na|tbd|todo)$/i.test(t);
  };

  for (let i = 0; i < lines.length; i++) {
    if (!isEvidenceLabel(lines[i])) continue;
    let blob;
    if (isTableRow(lines[i])) {
      // `| **Kanıt** | e2e yeşil (12/12) |` → etiket hücresinden SONRAKİ hücreler.
      const cells = lines[i].split('|').map((c) => c.trim());
      blob = cells.filter(Boolean).slice(1).join(' ');
    } else {
      // Etiket satırında iki nokta varsa sonrası gövdedir; ayrıca bir sonraki
      // başlığa kadarki satırlar da gövdedir.
      const colon = lines[i].indexOf(':');
      const inline = colon >= 0 ? lines[i].slice(colon + 1) : '';
      const body = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (isHeading(lines[j]) || isEvidenceLabel(lines[j])) break;
        body.push(lines[j]);
      }
      blob = [inline, ...body].join('\n');
    }
    if (meaningful(blob)) return true;
  }
  // Kanıt başlığı yok ama gerçek çıktı izi varsa (kod bloğu / görsel) — kanıt say.
  if (/```[\s\S]*?\S[\s\S]*?```/.test(text)) return true;
  if (/!\[[^\]]*\]\([^)]+\)/.test(text)) return true;
  return false;
}

/** `**Durum:** …` satırından kısa durum (yoksa ''). Pure. */
function extractStatus(md) {
  const m = /^\*\*Durum:?\*\*\s*(.+)$/m.exec(md || '');
  if (!m) return '';
  return m[1].trim().replace(/\s+/g, ' ').slice(0, 60);
}

/**
 * ADP-364 — `**Sprint:** SPRINT-AD-37` satırından sprint kodu (yoksa ''). Rapor başlığındaki
 * meta satırında (`**Ajan:** … · **Board:** … · **Sprint:** … · **Tarih:** …`) yaşar. Pure.
 */
function extractSprint(md) {
  const m = /\*\*Sprint:?\*\*\s*([A-Za-z0-9._-]+)/.exec(md || '');
  return m ? m[1].trim().slice(0, 40) : '';
}

/** Bir markdown hücresini güvenli hale getir (tablo bozulmasın). Pure. */
function cell(s) {
  return (s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim() || '—';
}

/** Satırlardan INDEX.md metnini ör (tarih DESC; kanıtsızlar üstte işaretli). Pure. */
function renderIndex(rows, opts = {}) {
  const missing = rows.filter((r) => !r.evidence);
  const sorted = rows.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.taskId.localeCompare(b.taskId));
  const head = [
    '<!-- ADP-301 — OTOMATİK ÜRETİLİR: `npm run results:index`. ELLE DÜZENLEME (üzerine yazılır). -->',
    '',
    '# Ajan Sonuç Raporları — İndeks',
    '',
    `**Rapor:** ${rows.length} · **KANIT YOK:** ${missing.length}${opts.generatedAt ? ` · **Üretim:** ${opts.generatedAt}` : ''}`,
    '',
    'Kural (ajan kimliğine gömülü): her görevin sonunda `docs/agent-results/<GÖREV-ID>-<ajanadı>.md`',
    'yazılır (ne yapıldı · kanıt · değişen dosyalar · riskler · açık sorular · sonraki adım).',
    '**KANIT YOK** = raporun kanıt bölümü boş ya da hiç yok → görev "done" sayılmaz.',
    '',
    '| Görev ID | Başlık | Ajan | Takım | Sprint | Tarih | Commit | Durum |',
    '|---|---|---|---|---|---|---|---|',
  ];
  const body = sorted.map((r) => {
    const status = r.evidence ? cell(r.status || 'rapor var') : '⚠️ **KANIT YOK**';
    const team = cell(r.team || teamOf(r.agent));
    return `| [${cell(r.taskId)}](${encodeURI(r.file)}) | ${cell(r.title)} | ${cell(r.agent)} | ${team} | ${cell(r.sprint)} | ${cell(r.date)} | ${cell(r.commit)} | ${status} |`;
  });
  return head.concat(body, ['']).join('\n');
}

// ── I/O katmanı (saf olmayan) ──────────────────────────────────────────────────

function gitInfo(file) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%h|%ad', '--date=short', '--', file], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) {
      const [commit, date] = out.split('|');
      return { commit, date };
    }
  } catch {
    /* git yoksa / dosya commit'lenmemişse → mtime'a düş */
  }
  return { commit: '', date: '' };
}

function collectRows() {
  const files = fs
    .readdirSync(RESULTS_DIR)
    .filter((f) => f.toLowerCase().endsWith('.md') && f.toLowerCase() !== INDEX_NAME.toLowerCase())
    .sort();
  return files.map((f) => {
    const abs = path.join(RESULTS_DIR, f);
    const md = fs.readFileSync(abs, 'utf8');
    const { taskId, agent } = parseFileName(f);
    const rel = path.posix.join('docs', 'agent-results', f);
    const git = gitInfo(rel);
    const date = git.date || fs.statSync(abs).mtime.toISOString().slice(0, 10);
    return {
      file: f,
      taskId,
      agent,
      team: teamOf(agent), // ADP-364 — mobil Raporlar takım süzgeci
      sprint: extractSprint(md), // ADP-364 — rapordan tek kez çıkarılır (INDEX.md tek gerçek)
      title: extractTitle(md, taskId),
      date,
      commit: git.commit || 'uncommitted',
      status: extractStatus(md),
      evidence: hasEvidence(md),
    };
  });
}

function main(argv) {
  const check = argv.includes('--check');
  // RES-IDX-01 — kök: --root / env / cwd-ata / script reposu. Rapor dizini yoksa
  // AÇIK hata (sessizce boş INDEX üretmek "indeks tazelendi" yalanı olurdu).
  REPO_ROOT = resolveRepoRoot(argv);
  RESULTS_DIR = path.join(REPO_ROOT, RESULTS_REL);
  let dirOk = false;
  try { dirOk = fs.statSync(RESULTS_DIR).isDirectory(); } catch { dirOk = false; }
  if (!dirOk) {
    console.error(`results:index: rapor dizini yok → ${RESULTS_DIR} (kök: ${REPO_ROOT}; --root <dir> ile belirt)`);
    process.exit(2);
  }
  const rows = collectRows();
  const missing = rows.filter((r) => !r.evidence);
  // RESULTS-INDEX-ROSTER-01 — roster bayatlaması sessiz kalmasın (uyarı; kapı değil).
  const drift = rosterDriftHints(rows.map((r) => r.file));
  if (drift.length) {
    console.error(
      `results:index UYARI — roster dışı olası ajan sonekleri (TEAM_OF'a ekle?): ${drift.map(([t, n]) => `${t}(${n})`).join(' ')}`,
    );
  }
  if (check) {
    for (const r of missing) console.error(`KANIT YOK: docs/agent-results/${r.file}`);
    console.log(`results:index --check → ${rows.length} rapor, ${missing.length} KANIT YOK [kök: ${REPO_ROOT}]`);
    process.exit(missing.length > 0 ? 1 : 0);
  }
  const out = renderIndex(rows, { generatedAt: new Date().toISOString().slice(0, 10) });
  fs.writeFileSync(path.join(RESULTS_DIR, INDEX_NAME), out, 'utf8');
  console.log(`INDEX.md yazıldı → ${rows.length} rapor, ${missing.length} KANIT YOK [kök: ${REPO_ROOT}]`);
  // REPORTS-V2-A1 — v2 indeksi AYNI koşumda tazelenir (SARMA, yerine geçme DEĞİL).
  // Neden sarma: INDEX.md'nin canlı tüketicileri var (mobil Raporlar takım süzgeci
  // ADP-364, ajan kimliğine gömülü `npm run results:index` talimatı, kardeş repolar).
  // Yerine geçmek 60 ajanın sözleşmesini sessizce bozardı. Sarma ile TEK giriş noktası
  // kalır ve `--commit` iki yolu birden dar pathspec'le commit'ler.
  if (!argv.includes('--no-v2')) {
    try {
      require('./reportsIndexV2.cjs').generate({ argv, root: REPO_ROOT });
    } catch (err) {
      // v2 katmanı INDEX.md üretimini ASLA düşürmez (eski kapı korunur); sessiz de kalmaz.
      console.error(`reports-index-v2 atlandı: ${(err && err.message) || err}`);
    }
  }
  if (argv.includes('--commit')) commitIndexOnly();
}

/**
 * TREE-CLOBBER-01 — `--commit`: indeksi tazeledikten HEMEN SONRA, YALNIZ INDEX.md'yi
 * commit'ler.
 *
 * NEDEN. Ölçüm (scripts/clobberScan.cjs, 24 saat) INDEX.md'nin İÇERİĞİNİN kavga
 * çıkarmadığını gösterdi: üreteç `readdirSync` ile saf türetim yapar, yani hangi worker
 * koşarsa koşsun komşuların o an diskte olan raporlarını da kapsar — 24 saatte GERÇEK
 * satır kaybı sıfır çıktı (görünen kayıplar uçucu alanlardı: sayaç başlığı, commit sütunu).
 *
 * Kavgayı çıkaran şey indeksin kendisi değil, ETRAFINDAKİ JESTTİ: worker `results:index`
 * koşup ardından `git add docs/agent-results` gibi GENİŞ bir jestle commit'liyor ve
 * niyet etmediği dosyaları — komşunun raporunu, paylaşımlı indekste bekleyen bayat bir
 * blob'u — beraberinde götürüyor. Ölçülen örnek: 687cd604 mesajı "results:index tazelendi"
 * der ama TEK dokunduğu dosya ONNX-CRASH-02 raporudur ve ondan 49 satır SİLER.
 *
 * Bu yüzden seçilen çözüm "worker'lar dokunmasın" (lider darboğazı) ya da "üreteç
 * birleştirici olsun" (zaten saf türetim, gereksiz) değil: JESTİ DARALTMAK. Pathspec'li
 * `git commit -- <yol>` paylaşımlı indeksi ATLAR, yalnız verilen yolun çalışma ağacı
 * sürümünü commit'ler; üretimle commit arasındaki yarış penceresi ~0'a iner.
 */
function commitIndexOnly() {
  // REPORTS-V2-A1 — iki türetilmiş dosya, hâlâ DAR pathspec (TREE-CLOBBER-01 korunur).
  const rels = [
    path.posix.join('docs', 'agent-results', INDEX_NAME),
    path.posix.join('docs', 'agent-results', 'REPORTS-INDEX.json'),
  ].filter((r) => fs.existsSync(path.join(REPO_ROOT, r)));
  const rel = rels.join(' + ');
  const run = (args, opts = {}) =>
    execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', opts.loud ? 'inherit' : 'pipe'],
    });
  try {
    // Değişiklik yoksa boş commit üretme (paylaşımlı ağaçta gürültü = başka worker'ın işi).
    execFileSync('git', ['diff', '--quiet', 'HEAD', '--', ...rels], { cwd: REPO_ROOT, stdio: 'ignore' });
    console.log('results:index --commit: INDEX.md HEAD ile aynı, commit gerekmedi.');
    return;
  } catch {
    /* fark var — commit'e devam */
  }
  try {
    run(['commit', '-q', '-m', 'docs(results): INDEX.md tazelendi (results:index --commit)', '--', ...rels], {
      loud: true,
    });
    const sha = run(['rev-parse', '--short', 'HEAD']).trim();
    console.log(`results:index --commit: ${sha} — YALNIZ ${rel}`);
  } catch (err) {
    // Kapı (pre-commit) reddettiyse ya da commit edilemediyse SESSİZ KALMA: worker
    // "indeks commit'lendi" sanmasın.
    console.error(`results:index --commit BAŞARISIZ: ${(err && err.message) || err}`);
    process.exitCode = 1;
  }
}

module.exports = {
  parseFileName,
  rosterDriftHints,
  AGENTS,
  extractTitle,
  hasEvidence,
  extractStatus,
  extractSprint,
  teamOf,
  renderIndex,
  collectRows,
  rootArg,
  findResultsOwner,
  resolveRepoRoot,
  RESULTS_DIR,
};

if (require.main === module) main(process.argv.slice(2));
