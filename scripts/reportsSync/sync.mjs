// RPT-INBOX-01 — ÇALIŞMA ALANININ HTML SAYFALARI → AgentSpace Raporlar (idempotent eşitleyici).
//
// Neden: Murat Chrome'da açık tuttuğu sayfaları (plan, önizleme, "nasıl denerim") Raporlar
// sekmesinde görmek istiyor ki tarayıcıyı kapatabilsin (26.09). İkinci bir rapor deposu YOK:
// her sayfa ürünün kendi yazıcısıyla (`reportLedger.writeReport` = `rapor_yaz bicim=html`) yazılır.
//
// KİMLİK = KAYNAK YOL (`<proje>/docs/artifacts/<göreli>`). Kimlik raporun KENDİ özet satırında
// durur: `Kaynak: <kimlik> · sha256 <16 hane>…` (RPT4-11 göç raporlarıyla aynı satır). Ayrı bir
// eşleme dosyası tutulmaz; rapor klasörü tek gerçektir.
//   · aynı yol, aynı içerik → "zaten" (hiçbir şey yazılmaz)
//   · aynı yol, yeni içerik → AYNI rapor yeni sürüm alır (defter `surumler/n.md + n.html`),
//     dosya zamanı sayfanın son yazımı olur → listede "güncellendi" saati
//   · yeni yol → yeni rapor `SAYFA-<ad>-<ajan>`
//   · içeriği başka bir raporla birebir aynı, kimliği yok → "kopya" (ikinci rapor açılmaz)
//
// Kaynaklar: çalışma alanındaki kanonik projelerin (`.git` klasörü olan) `docs/artifacts/**/*.html`
// dosyaları + aynı projenin worktree'lerinde olup ana ağaçta OLMAYAN sayfalar (build worktree'lerindeki
// `dev-0249-*-nasil-denerim` gibi). Git'in yok saydığı sayfa (`.gitignore`, `.git/info/exclude`)
// ALINMAZ: Murat onu bilerek yerelde tutuyor (sosyal kanıt raporu, kullanıcı adları).
//
// RPT-SYNC-LIVE-01 — eşitleyici artık ÜRÜNÜN İÇİNDE koşar (electron/reportsPageSync.cjs → işçi):
//   · kapsam `docs/artifacts/**` + `docs/design/**` (Tasarım sekmesinin `<KOD>/v<N>.html`
//     dosyaları hariç) + `docs/plan-*/**`; kimlik biçimi aynı: `<proje>/<checkout'a göreli yol>`
//   · sayfa olmayan dışlanır (`sayfaDegil`): `<meta name="agentspace-rapor" content="hayir">`,
//     `*.tpl.html`, `kaynak/` alt klasörü, 1,5 KB altı, `<title>` yok
//   · yeni rapor adı klasörü taşır: `hifi/geri-bildirim.html` → `SAYFA-hifi-geri-bildirim-…`
//     (var olan raporların adı DEĞİŞMEZ — kimlik özet satırında)
//   · ajan: commit konusundaki `(ad)` → sayfayı yazan pane'in ajanı → `bilinmiyor`
//   · git'in yok saydığı sayfa artık ATLANMAZ: kopyası `<ws>/.agentspace/results/`e (git dışı,
//     bu makine) yazılır; o dizin bir git ağacında ve yok sayılmıyorsa YAZILMAZ (asla git'e girmez)
//   · `worktree:false` → yalnız ana ağaçlar (açılış/izleyici); worktree taraması periyodik koşumda
// RPT-SCRATCH-RULE-01 — `docs/artifacts/kurtarilan/<ajan>/<tarih>/` (geçici klasörden kurtarılan sayfa): ajan yoldan,
//   ad `SAYFA-kurtarilan-<ad>-<ajan>`.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { slugOf, pageVerdict, shareClass, oneLine } from '../rpt4-11/lib.mjs'
import { pickMode, buildCopy, sideImages, kitOf, paketSayfasi } from '../rpt4-11/copy.mjs'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
// RPT-SYNC-LIVE-01 — paketli uygulamada betik `Resources/scripts/reportsSync/` altında (extraResources);
// `Resources/electron/`de yalnız birkaç kopya var (reportLedger zinciri YOK) → rapor modülleri
// `Resources/app.asar.unpacked/`ten (asarUnpack, task MCP'nin yüklediği yer) alınır.
const ELECTRON = [path.join(ROOT, 'electron'), path.join(ROOT, 'app.asar.unpacked')]
  .find((d) => fs.existsSync(path.join(d, 'reportLedger.cjs'))) || path.join(ROOT, 'electron')
const S = require(path.join(ELECTRON, 'reportSchema.cjs'))
const T = require(path.join(ELECTRON, 'reportHtmlText.cjs'))

export const CARD = 'TASK-MUJ2Q4XS961L6'
export const KOD_ONEKI = 'SAYFA'
/** Kimliği taşıyan özet satırı — RPT4-11 göç raporlarıyla AYNI biçim. */
export const KAYNAK_RE = /^.*Kaynak: (\S(?:.*?\S)?\.html?) · sha256 ([0-9a-f]{16})…/m
const SKIP_DIR = /(?:^|[\\/])(?:node_modules|\.git|\.next|dist|build|out)(?:[\\/]|$)/

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')
const isDir = (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } }
const isFile = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
const posix = (p) => p.split(path.sep).join('/')

function git(repo, argv, input) {
  try {
    return execFileSync('git', ['-C', repo, ...argv], { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'] })
  } catch (e) { return e && typeof e.stdout === 'string' ? e.stdout : '' }
}

/** RPT-SYNC-LIVE-01 — kapsam kökleri: `docs/artifacts`, `docs/design`, `docs/plan-*` (var olanlar, sıralı). */
export function scopeDirs(checkout) {
  let ents
  try { ents = fs.readdirSync(path.join(checkout, 'docs'), { withFileTypes: true }) } catch { return [] }
  return ents.filter((e) => e.isDirectory() && (e.name === 'artifacts' || e.name === 'design' || /^plan-/.test(e.name)))
    .map((e) => path.join(checkout, 'docs', e.name)).sort()
}

export const MIN_SAYFA_BAYT = 1536

/**
 * RPT-SYNC-LIVE-01 — sayfa DEĞİL mi? Nedeni döner (null = sayfa). `rel` checkout'a göreli posix yol
 * (`docs/...`); `buf` verilmezse yalnız yol kuralları bakılır (dosya okunmadan). Pure.
 */
export function sayfaDegil(rel, buf = null) {
  const segs = String(rel).split('/')
  const ad = segs[segs.length - 1]
  if (/\.tpl\.html?$/i.test(ad)) return 'şablon (*.tpl.html)'
  if (segs.slice(0, -1).includes('kaynak')) return 'kaynak/ klasörü'
  if (segs[1] === 'design' && segs.length === 4 && /^v\d+\.html$/i.test(ad)) return 'Tasarım sekmesinin sürüm dosyası'
  if (!buf) return null
  if (buf.length < MIN_SAYFA_BAYT) return '1,5 KB altı'
  const html = buf.toString('utf8')
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (/\bname\s*=\s*["']?agentspace-rapor\b/i.test(m[0]) && /\bcontent\s*=\s*["']?hay[iı]r\b/i.test(m[0])) return 'sayfa kendini dışladı (agentspace-rapor=hayir)'
  }
  if (!/<title\b[^>]*>\s*[^<\s]/i.test(html)) return 'başlık (<title>) yok'
  return null
}

/** RPT-SYNC-LIVE-01 — yeni rapor adına giren klasör: `docs/artifacts` kökündeki sayfada yok, gerisinde üst klasör. Pure. */
export function folderOf(kimlik) {
  const segs = String(kimlik).split('/')
  if (segs.length <= 4 && segs[2] === 'artifacts') return null
  // RPT-SCRATCH-RULE-01 — kurtarılan sayfa: ad kökeni söylesin (`SAYFA-kurtarilan-<ad>`), tarih klasörü değil.
  if (rescuedAgentOf(kimlik)) return 'kurtarilan'
  return segs[segs.length - 2] || null
}

/**
 * RPT-SCRATCH-RULE-01 — geçici klasörden kurtarılan sayfanın ajanı yolun kendisinde:
 * `<proje>/docs/artifacts/kurtarilan/<ajan>/<tarih>/<ad>.html` (electron/scratchRescue.cjs yazar). Pure.
 */
export function rescuedAgentOf(kimlik) {
  const segs = String(kimlik).split('/')
  if (segs.length !== 7 || segs[1] !== 'docs' || segs[2] !== 'artifacts' || segs[3] !== 'kurtarilan') return null
  return /^[a-z][a-z0-9_-]{0,47}$/.test(segs[4]) && segs[4] !== 'bilinmiyor' ? segs[4] : null
}

/**
 * RPT-SYNC-LIVE-01 — sayfayı yazan pane'in ajanı: dosyayı kapsayan EN DAR çalışma klasörü tek bir
 * ajana aitse ve pane sayfa yazılırken yaşıyorsa o ajan; belirsizse null. `paneler`: [{cwd, ajan, baslangic?}]. Pure.
 */
export function paneAgentOf(file, zaman, paneler) {
  let enDar = -1
  const ajanlar = new Set()
  for (const p of Array.isArray(paneler) ? paneler : []) {
    if (!p || typeof p.cwd !== 'string' || !p.cwd || typeof p.ajan !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/i.test(p.ajan)) continue
    if (Number.isFinite(p.baslangic) && Number.isFinite(zaman) && p.baslangic > zaman) continue
    const cwd = path.resolve(p.cwd)
    if (file !== cwd && !file.startsWith(cwd + path.sep)) continue
    if (cwd.length > enDar) { enDar = cwd.length; ajanlar.clear() }
    if (cwd.length === enDar) ajanlar.add(p.ajan.toLowerCase())
  }
  return ajanlar.size === 1 ? [...ajanlar][0] : null
}

function walkHtml(dir, out = []) {
  let ents
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    const p = path.join(dir, e.name)
    if (SKIP_DIR.test(p)) continue
    if (e.isDirectory()) walkHtml(p, out)
    else if (e.isFile() && /\.html?$/i.test(e.name)) out.push(p)
  }
  return out
}

/** Git'in yok saydığı yollar (`.gitignore` + `.git/info/exclude`) — tek çağrıda. */
function ignoredSet(checkout, files) {
  if (!files.length) return new Set()
  const out = git(checkout, ['check-ignore', '--stdin'], files.map((f) => path.relative(checkout, f)).join('\n') + '\n')
  return new Set(out.split('\n').filter(Boolean).map((r) => path.resolve(checkout, r)))
}

/** Dosyanın son yazımı: kirli/izlenmeyen dosyada dosya zamanı, temiz izlenen dosyada son commit (worktree'de dosya zamanı = checkout). */
function writtenAt(checkout, file, main) {
  const mt = fs.statSync(file).mtimeMs
  if (main) return mt
  const rel = path.relative(checkout, file)
  const dirty = git(checkout, ['status', '--porcelain', '--', rel]).trim()
  if (dirty) return mt
  const ct = Number(git(checkout, ['log', '-1', '--format=%ct', '--', rel]).trim())
  return ct ? ct * 1000 : mt
}

function addedBy(checkout, file) {
  const out = git(checkout, ['log', '--diff-filter=A', '--format=%s', '--', path.relative(checkout, file)]).trim()
  const first = out ? out.split('\n').pop() : ''
  const m = /\(([a-z][a-z0-9_-]{1,30})\)\s*$/.exec(first)
  return m ? m[1] : null
}

/**
 * Kaynak sayfalar. Kimlik başına tek sürüm: ana ağaçtaki dosya kazanır (ajanlar oraya yazar);
 * yalnız worktree'de olan sayfada en son yazılmış içerik.
 */
export function collectSources(ws, { agentshotRoot, worktree = true } = {}) {
  const out = new Map()
  const gizliOut = new Map()
  const gizli = []
  const dislanan = new Map()
  const projeler = []
  for (const e of fs.readdirSync(ws, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue
    const main = path.join(ws, e.name)
    if (!isDir(path.join(main, '.git'))) continue
    const checkouts = [{ dir: main, main: true }]
    for (const l of worktree ? git(main, ['worktree', 'list', '--porcelain']).split('\n') : []) {
      if (!l.startsWith('worktree ')) continue
      const d = l.slice(9)
      if (path.resolve(d) !== path.resolve(main) && isDir(d)) checkouts.push({ dir: d, main: false })
    }
    projeler.push({ ad: e.name, checkout: checkouts.length })
    for (const c of checkouts) {
      const files = scopeDirs(c.dir).flatMap((base) => walkHtml(base))
      const ign = ignoredSet(c.dir, files)
      for (const f of files) {
        const rel = posix(path.relative(c.dir, f))
        const kimlik = `${e.name}/${rel}`
        const yolNeden = sayfaDegil(rel)
        if (yolNeden) { dislanan.set(kimlik, yolNeden); continue }
        const gizliMi = ign.has(path.resolve(f))
        if (gizliMi && !gizli.some((g) => g.kimlik === kimlik)) gizli.push({ kimlik, neden: 'git yok sayıyor (yalnız bu bilgisayar)' })
        const hedefMap = gizliMi ? gizliOut : out
        const cur = hedefMap.get(kimlik)
        if (cur && cur.main) continue
        const buf = fs.readFileSync(f)
        const icNeden = sayfaDegil(rel, buf)
        if (icNeden) { if (!cur) dislanan.set(kimlik, icNeden); continue }
        const zaman = writtenAt(c.dir, f, c.main)
        if (cur && !c.main && cur.zaman >= zaman) continue
        dislanan.delete(kimlik)
        hedefMap.set(kimlik, { kimlik, proje: e.name, dosya: f, checkout: c.dir, projeKok: c.dir, main: c.main, zaman, buf, sha256: sha256(buf), gizli: gizliMi })
      }
    }
  }
  // Gizlilik kimlik düzeyindedir: bir checkout'ta yok sayılan sayfanın başka checkout'taki kopyası da
  // git'e giden rapora ALINMAZ; kopyası yalnız yerel dizine gider (gizliOut).
  for (const g of gizli) out.delete(g.kimlik)
  // Yan görseller yalnız GEREKİNCE okunur (yeni/güncellenen sayfa): boştaki koşum "zaten" sayfaların
  // görsellerini okumaz (ölçüldü: eager okuma boştaki koşumu ~4,3 sn / 225 MB yapıyordu).
  for (const s of [...out.values(), ...gizliOut.values()]) {
    let g = null
    Object.defineProperty(s, 'gorsel', { enumerable: true, get: () => (g ??= sideImages(s.buf.toString('utf8'), s.dosya, s.projeKok, { sha256, agentshotRoot })) })
  }
  const sirali = (m) => [...m.values()].sort((a, b) => a.kimlik.localeCompare(b.kimlik))
  return {
    kaynaklar: sirali(out), gizliKaynaklar: sirali(gizliOut), gizli, projeler,
    dislanan: [...dislanan].map(([kimlik, neden]) => ({ kimlik, neden })).sort((a, b) => a.kimlik.localeCompare(b.kimlik)),
  }
}

/** Rapor klasöründe kimliği (Kaynak satırı) olan raporlar: GOC-* (RPT4-11) + SAYFA-* (bu eşitleyici). */
export function loadIdentityReports(dir) {
  const byKimlik = new Map()
  const bySha = new Map()
  let names = []
  try { names = fs.readdirSync(dir) } catch { /* yok */ }
  for (const n of names) {
    if (!n.endsWith('.md') || !/^(?:GOC|SAYFA)-/.test(n)) continue
    let txt
    try { txt = fs.readFileSync(path.join(dir, n), 'utf8') } catch { continue }
    const m = KAYNAK_RE.exec(txt)
    if (!m) continue
    const fm = S.frontmatter(txt) || {}
    const r = { ad: n.replace(/\.md$/, ''), kimlik: m[1], sha16: m[2], kod: fm.kod || null, ajan: fm.ajan || null, gorev: fm['görev'] || null, tip: fm.tip || null }
    // Aynı kimlikte iki rapor (elle kopya) → en eski ad kazanır (kararlı; ikinci yazımda değişmez).
    const cur = byKimlik.get(r.kimlik)
    if (!cur || r.ad < cur.ad) byKimlik.set(r.kimlik, r)
    if (!bySha.has(r.sha16)) bySha.set(r.sha16, r)
  }
  return { byKimlik, bySha }
}

function guessTip(kimlik) {
  const b = path.basename(kimlik).toLowerCase()
  if (/nasil-denerim|rehber|kilavuz/.test(b)) return 'rehber'
  if (/plan|karar/.test(b)) return 'karar'
  return 'diğer'
}

/**
 * Hüküm: kart kapağı hükmün İLK cümlesini gösterir → sayfanın kendi cümlesi ÖNDE durur (her kartta
 * aynı "kopyalandı" cümlesi bilgi taşımaz). Açılışsız cümle olduğu gibi alınır; baştaki "Karar:" gibi
 * etiket düşer, "Bitti:" açılışı yalnız "sayfa yayında/kopyalandı" demektir (sınıf uydurulmaz).
 */
function verdictOf(html, metin, baslik) {
  const pv = pageVerdict(html, metin, S.verdictOpening)
  if (pv && pv.acilisli) return oneLine(pv.metin)
  if (pv) return `Bitti: ${oneLine(pv.metin.replace(/^(?:karar|öneri|sonuç|özet|durum)\s*[:：]\s*/i, ''), 220)} (sayfanın kendi cümlesi; Raporlar'a kopyalandı)`
  return `Bitti: "${oneLine(baslik, 90)}" sayfası Raporlar'a kopyalandı; ayrı bir hüküm yok, içerik sayfanın kendisinde.`
}

function summaryOf(s, metin, kip, bugun) {
  const sabit = [
    `Sayfa (çalışma alanı) · son yazım ${new Date(s.zaman).toISOString().slice(0, 16).replace('T', ' ')} · Raporlar'a eşitlendi ${bugun} (RPT-INBOX-01). Kaynak: ${s.kimlik} · sha256 ${s.sha256.slice(0, 16)}…`,
  ]
  // RPT-SYNC-LIVE-01 — git'in yok saydığı sayfa: rozet satırı en önde (kopya yalnız bu makinede).
  if (s.gizli) sabit.unshift('Kişisel veri içerir · yalnız bu bilgisayar: kaynak sayfa git dışında tutuluyor, bu kopya da git\'e ve buluta gitmez.')
  if (!s.main) sabit.push('Kaynak yalnız bir worktree\'de duruyor (ana ağaçta yok).')
  if (s.gorsel.gorseller.length || s.gorsel.eksikGorsel) {
    const nerede = kip === 'gömülü' ? 'sayfaya gömüldü' : kip === 'kanıt' ? 'kanıt klasöründe' : kip === 'paket' ? 'sayfa paketinin içinde' : ''
    sabit.push(`Yan görsel: ${s.gorsel.gorseller.length}${nerede ? ` (${nerede})` : ''}${s.gorsel.eksikGorsel ? ` · alınamayan: ${s.gorsel.eksikGorsel}` : ''}.`)
  }
  if (kip === 'paket') sabit.push(`Büyük sayfa (${Math.ceil(s.buf.length / 1024)} KB > ${S.HTML_PAGE_MAX_BYTES / 1024} KB): tamamı sayfa-paketi.png karesinde, okuyucuda açıcı kurar.`)
  const pay = shareClass({ ad: path.basename(s.kimlik), baslik: '', metin, html: s.buf.toString('utf8'), kisiselVeri: S.scanPersonalData(metin) })
  if (pay.durum === 'paylaşılamaz') sabit.push(`PAYLAŞILAMAZ: müşteri verisi (${pay.nedenler.join(', ')}).`)
  else if (pay.durum === 'incele') sabit.push(`Paylaşmadan önce incele: ${pay.nedenler.join(', ')}.`)
  const kalan = Math.max(0, 8 - sabit.length)
  const ozet = String(metin || '').split('\n').map((l) => l.trim())
    .filter((l) => l.length >= 40 && !/^(#|\||```|- )/.test(l)).slice(0, Math.min(2, kalan)).map((l) => oneLine(l, 320))
  return { metin: [...ozet, ...sabit].join('\n'), paylasim: pay.durum }
}

/**
 * Paket kipindeki rapor sayfası yalnız açıcıdır (copy.mjs): kaynak değişmese de açıcı yenilenmişse
 * (kafes uyum yaması) rapor güncellenir. Kare ÜRETİLMEZ (ucuz); yalnız açıcı taşıyan sayfada.
 */
function paketEski(dir, rapor, s) {
  let mevcut
  try { mevcut = fs.readFileSync(path.join(dir, `${rapor.ad}.html`), 'utf8') } catch { return false }
  if (!mevcut.includes('id="as-paket-acici"')) return false
  const html = s.buf.toString('utf8')
  const p = { gorseller: s.gorsel.gorseller, betikGorseller: s.gorsel.betikGorseller, baslik: oneLine(T.htmlToText(html).baslik || path.basename(s.kimlik), 160), sha256: s.sha256, kip: 'paket' }
  return mevcut !== paketSayfasi(p, html)
}

/**
 * RPT-CAGE-FULL-01 — kanıt/paket kipli eski kopya kit v1 beyanlıysa (kapsamsız kit sayfanın kendi
 * sınıflarını gizliyordu: `.view{display:none}`) kaynak değişmese de yeniden yazılır (kit v3).
 */
function kitEski(dir, rapor) {
  let mevcut
  try { mevcut = fs.readFileSync(path.join(dir, `${rapor.ad}.html`), 'utf8') } catch { return false }
  const m = /<meta\s+name="agentspace-kit"\s+content="(\d+)">/.exec(mevcut)
  return !!m && m[1] === '1'
}

/** Aynı anda iki eşitleme aynı raporu iki sürümle yazmasın: O_EXCL kilit (10 dk'dan eski kilit bayat sayılır). */
function lock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    const fd = fs.openSync(file, 'wx')
    fs.writeSync(fd, String(process.pid))
    fs.closeSync(fd)
    return () => { try { fs.unlinkSync(file) } catch { /* yok */ } }
  } catch {
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > 10 * 60 * 1000) { fs.unlinkSync(file); return lock(file) }
    } catch { /* yarış */ }
    return null
  }
}

/**
 * @param {object} o
 * @param {string} o.ws           çalışma alanı kökü
 * @param {string} o.hedef        raporların yazılacağı proje kökü (`docs/agent-results/`)
 * @param {string} [o.defterKoku] defter kökü (`.agentspace/reports`); varsayılan ws
 * @param {boolean} [o.yaz]       false → kuru koşum
 * @param {boolean} [o.kimlikKurali] false → KONTROL KOLU: kimlik okunmaz (çift rapor oluşmalı)
 * @param {string} [o.ajan]       yazarı bilinmeyen sayfanın ajanı (varsayılan `bilinmiyor`)
 * @param {Array<{cwd:string, ajan:string, baslangic?:number}>} [o.paneler] canlı pane'ler (yazan ajanı bulmak için)
 * @param {boolean} [o.worktree]  false → yalnız ana ağaçlar taranır (varsayılan true)
 * @param {boolean} [o.yerel]     false → git'in yok saydığı sayfa yerel dizine de YAZILMAZ (varsayılan true)
 * @param {string} [o.agentshotRoot] bu köke düşen görsel ASLA kopyalanmaz
 */
export function syncArtifacts(o) {
  const ws = path.resolve(o.ws)
  const hedef = path.resolve(o.hedef)
  const defterKoku = path.resolve(o.defterKoku || ws)
  const dir = path.join(hedef, 'docs', 'agent-results')
  const yaz = o.yaz !== false
  const kimlikKurali = o.kimlikKurali !== false
  const bugun = new Date().toISOString().slice(0, 10)
  const L = require(path.join(ELECTRON, 'reportLedger.cjs'))
  const yerelDir = path.join(ws, '.agentspace', 'results')

  const birak = yaz ? lock(path.join(defterKoku, '.agentspace', 'reports', '.sayfa-esitleme.lock')) : () => {}
  if (!birak) return { ok: false, hata: 'başka bir eşitleme sürüyor (kilit)', satirlar: [], say: {} }
  try {
    const { kaynaklar, gizliKaynaklar, gizli, dislanan, projeler } = collectSources(ws, { agentshotRoot: o.agentshotRoot, worktree: o.worktree !== false })
    const satirlar = []
    // RPT-SYNC-LIVE-01 — iki hedef: git'e giden rapor klasörü + git'in yok saydığı sayfalar için yerel dizin.
    // Defter kimliği = dosya adı → yerel kopya git'teki bir raporla aynı adı ALAMAZ (ad kümesi ortak).
    const adlar = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3)) : [])
    const kullanilan = new Set(adlar(dir))
    const anaHedef = { dir, idx: loadIdentityReports(dir), kullanilan }
    let yerelHedef = null
    const yerelListe = []
    if (o.yerel !== false && gizliKaynaklar.length) {
      const engel = yerelEngel(ws, yerelDir)
      if (engel) for (const s of gizliKaynaklar) satirlar.push({ kimlik: s.kimlik, kb: Math.ceil(s.buf.length / 1024), ana: s.main, rapor: null, islem: 'ret', kip: null, neden: engel, yerel: true })
      else {
        for (const n of adlar(yerelDir)) kullanilan.add(n)
        yerelHedef = { dir: yerelDir, idx: loadIdentityReports(yerelDir), kullanilan }
        yerelListe.push(...gizliKaynaklar)
      }
    }
    for (const s of [...kaynaklar, ...yerelListe]) {
      const { dir, idx } = s.gizli ? yerelHedef : anaHedef
      const sha16 = s.sha256.slice(0, 16)
      const var_ = kimlikKurali ? idx.byKimlik.get(s.kimlik) : null
      const row = { kimlik: s.kimlik, kb: Math.ceil(s.buf.length / 1024), ana: s.main, rapor: var_ ? var_.ad : null, islem: null, kip: null, neden: null }
      satirlar.push(row)
      if (var_ && var_.sha16 === sha16 && !paketEski(dir, var_, s) && !kitEski(dir, var_)) { row.islem = 'zaten'; continue }
      const kopya = idx.bySha.get(sha16)
      if (!var_ && kopya && kopya.kimlik !== s.kimlik) { row.islem = 'kopya'; row.rapor = kopya.ad; row.neden = `içerik ${kopya.kimlik} ile aynı`; continue }

      const html = s.buf.toString('utf8')
      const p = { gorseller: s.gorsel.gorseller, betikGorseller: s.gorsel.betikGorseller, baslik: null, sha256: s.sha256 }
      const t = T.htmlToText(html)
      p.baslik = oneLine(t.baslik || path.basename(s.kimlik), 160)
      // RPT-CAGE-FULL-01 — kanıt kareleri görünüme yaklaşınca istenir (köprü): 40 kare tavanı kalktı.
      p.kip = pickMode(p, html)
      row.kip = p.kip
      const kopyaSayfa = buildCopy(p, html)

      let ad
      let kod
      let ajan
      if (var_) {
        ad = var_.ad
        ajan = var_.ajan || ad.split('-').pop()
        kod = var_.kod || ad.slice(0, -(ajan.length + 1))
        row.islem = 'güncelle'
      } else {
        ajan = (addedBy(s.checkout, s.dosya) || rescuedAgentOf(s.kimlik) || paneAgentOf(s.dosya, s.zaman, o.paneler) || o.ajan || 'bilinmiyor').toLowerCase()
        const onek = `${KOD_ONEKI}-${s.proje !== path.basename(hedef) ? `${slugOf(s.proje)}-` : ''}`
        const klasor = folderOf(s.kimlik)
        const kok = `${onek}${klasor ? `${slugOf(klasor)}-` : ''}${slugOf(path.basename(s.kimlik))}`.slice(0, 60).replace(/-$/, '')
        kod = kok
        for (let n = 2; kullanilan.has(`${kod}-${ajan}`); n++) kod = `${kok}-${n}`
        ad = `${kod}-${ajan}`
        kullanilan.add(ad)
        row.islem = 'yeni'
      }
      row.rapor = ad
      if (s.gizli) row.yerel = true
      const ozet = summaryOf(s, t.metin, p.kip, bugun)
      row.paylasim = ozet.paylasim
      if (!yaz) continue

      const md = path.join(dir, `${ad}.md`)
      const evDir = path.join(dir, `${kod}-evidence`)
      for (const d of kopyaSayfa.dosyalar) {
        const to = path.join(evDir, d.ad)
        fs.mkdirSync(path.dirname(to), { recursive: true })
        fs.writeFileSync(to, d.buf)
      }
      const zaman = new Date(s.zaman)
      const r = L.writeReport({
        kod, ajan, hukum: verdictOf(html, t.metin, p.baslik),
        tip: var_ && var_.tip && S.TYPES.includes(var_.tip) ? var_.tip : guessTip(s.kimlik),
        okur: 'kullanıcı',
        platform: 'sayfa kopyası, platformdan bağımsız (RPT-INBOX-01 eşitleyici; kafeste açılır)',
        gorev: var_ && /^TASK-[A-Z0-9]+$/.test(var_.gorev || '') ? var_.gorev : CARD,
        bicim: 'html', sayfa: kopyaSayfa.html, ozet: ozet.metin, baslik: p.baslik, dosya: md,
      }, { cwd: s.gizli ? ws : hedef, workspaceRoot: defterKoku, dil: 'tr', now: () => zaman, yerelSonuc: !!s.gizli })
      if (!r.ok) { row.islem = 'ret'; row.neden = r.hatalar.map((h) => h.kod).join(','); continue }
      row.surum = r.surum
      row.kit = kitOf(p.kip)
      // Liste dosya zamanına göre sıralanır: rapor sayfanın SON YAZIMINDA durur ("güncellendi" saati).
      for (const f of [md, path.join(dir, `${ad}.html`)]) { try { fs.utimesSync(f, zaman, zaman) } catch { /* yok */ } }
      idx.byKimlik.set(s.kimlik, { ad, kimlik: s.kimlik, sha16, kod, ajan, gorev: null, tip: null })
      idx.bySha.set(sha16, idx.byKimlik.get(s.kimlik))
    }
    const say = satirlar.reduce((m, r) => ((m[r.islem] = (m[r.islem] || 0) + 1), m), { kaynak: kaynaklar.length, gizli: gizli.length })
    if (dislanan.length) say.dislanan = dislanan.length
    return { ok: true, say, satirlar, gizli, dislanan, projeler, yaz, kimlikKurali }
  } finally { birak() }
}

/**
 * RPT-SYNC-LIVE-01 — yerel dizin git'e gidebilir mi? Çalışma alanı bir git ağacının içindeyse ve
 * dizin YOK SAYILMIYORSA gizli sayfa YAZILMAZ (neden döner). null = güvenli.
 */
export function yerelEngel(ws, yerelDir) {
  if (git(ws, ['rev-parse', '--is-inside-work-tree']).trim() !== 'true') return null
  return ignoredSet(ws, [path.join(yerelDir, 'SAYFA-yoklama.md')]).size ? null : 'yerel dizin git ağacında ve yok sayılmıyor (gizli sayfa git\'e gidebilirdi)'
}

/** CLI varsayılanları: bu betik hangi checkout'tan koşulursa koşulsun ANA ağaç + çalışma alanı. */
export function defaultRoots(from = ROOT) {
  const common = git(from, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()
  const main = common ? path.dirname(common) : from
  return { hedef: main, ws: path.dirname(main), agentshotRoot: path.join(os.homedir(), '.agentshot') }
}
