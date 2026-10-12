// RPT4-11 — Göç: diskteki eski Claude sayfaları → AgentSpace HTML raporu. SAF yardımcılar
// (fs yok, git yok). IO `scripts/rpt4-11-goc.mjs`'te; testler `scripts/rpt4-11/lib.test.mjs`.
//
// İki değişmez:
//   1. Kaynak dosya DEĞİŞMEZ. Rapora giden sayfa, kaynağın baytlarına TEK satır eklenmiş hâlidir
//      (`KIT_OFF_LINE`: parça kiti kapalı → eski sayfanın kendi görünümü bozulmaz, sözleşme
//      RAPOR-KITI-V1 §8). `removeKitOff(insertKitOff(x)) === x` testle kilitli; doğrulama kolu
//      kopyadan bu satırı söküp kaynağın sha256'sına eşitler.
//   2. Uydurma yok. Hüküm sayfadan ya da sayfayı üreten rapordan KOPYALANIR; ikisi de yoksa
//      "elle" işaretlenir. Bağlantı → sayfa eşleşmesi kanıt sınıfıyla yazılır; kanıtsız bağlantı
//      "kayıp" listesine gider.

export const KIT_OFF_LINE = '<meta name="agentspace-kit" content="0">'

/** Claude sayfa bağlantısı: `claude.ai/artifact/<22>` ya da `claude.ai/code/artifact/<uuid>`. */
export const LINK_RE = /claude\.ai\/(?:code\/)?artifacts?\/([A-Za-z0-9_-]+)/g

/** Ortak hafızadaki müşteri markası listesi (feedback-no-customer-names-public). Değer rapora YAZILMAZ. */
export const BRAND_RE = /camgard|bonjuteri|derzjet|zippro/gi

/** Dosya adı/başlıkta müşteri verisi taşıma olasılığı yüksek konular (yalnız "incele" işareti). */
export const SENSITIVE_TOPIC_RE = /triage|geri[- ]?bildirim|feedback|itiraz|dispute|churn|m[uü][sş]teri|customer|destek|support|discord|iade|refund/i

/** Bağlantının kimlik biçimi: `uuid` (36), `kisa` (22 karakter), `kesik` (başka uzunluk: metinde kısaltılmış). */
export function linkKind(id) {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return 'uuid'
  if (/^[A-Za-z0-9]{22}$/.test(id)) return 'kisa'
  return 'kesik'
}

/** Metindeki bağlantı kimlikleri (sıralı, tekil). */
export function idsInText(text) {
  const out = new Set()
  for (const m of String(text ?? '').matchAll(LINK_RE)) out.add(m[1])
  return [...out]
}

/**
 * Bağlantının geçtiği satırdan insan etiketi: bağlantıdan ÖNCEKİ metin (madde işareti,
 * markdown süsü, "·", ":" atılır). Başlık eşleşmesinde kullanılır. Pure.
 */
export function contextLabel(line, id) {
  const s = String(line ?? '')
  const at = s.indexOf(id)
  if (at < 0) return ''
  let before = s.slice(0, at).replace(/https?:\/\/\S*$/, '').replace(/claude\.ai\/\S*$/, '')
  before = before.replace(/\[([^\]]*)\]\($/, '$1').replace(/[<(\[]+$/, '')
  before = before.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/[*_`#>|]/g, ' ')
  before = before.replace(/\s*(?:[·:—–\-=→]|link|bağlantı|artifact|url)\s*$/i, '')
  return before.replace(/\s+/g, ' ').trim().slice(-120)
}

/** Başlık karşılaştırması için katlama: Türkçe harfsiz, küçük, noktalama yok. Pure. */
export function normTitle(s) {
  return String(s ?? '')
    .replace(/ı/g, 'i').replace(/İ/g, 'i')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&amp;/g, '&')
    .replace(/[^a-z0-9&]+/g, ' ').trim()
}

/** Dosya adı → rapor kodu parçası: küçük ascii, `-` ile. Pure. */
export function slugOf(name) {
  const base = String(name ?? '').replace(/^.*[\\/]/, '').replace(/\.html?$/i, '')
  return normTitle(base).replace(/&/g, ' ').trim().replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 44).replace(/-$/, '') || 'sayfa'
}

/**
 * Kit kapatma satırını ekler: `<head…>` açılışından hemen sonra (yoksa `<html…>`'den sonra,
 * o da yoksa en başa) `\n` + satır. Sayfada zaten `agentspace-kit` beyanı varsa DOKUNMAZ
 * (sayfa kendi seçimini yapmış). Pure.
 * @returns {{html:string, eklendi:boolean}}
 */
export function insertKitOff(html, surum = 0) {
  const s = String(html ?? '')
  if (/<meta\s+[^>]*name\s*=\s*["']agentspace-kit["']/i.test(s)) return { html: s, eklendi: false }
  const m = /<head(?:\s[^>]*)?>/i.exec(s) || /<html(?:\s[^>]*)?>/i.exec(s)
  const at = m ? m.index + m[0].length : 0
  return { html: `${s.slice(0, at)}\n${kitLine(surum)}${s.slice(at)}`, eklendi: true }
}

/** `insertKitOff`'un tersi (doğrulama kolu): eklenen İLK satırı söker. Pure. */
export function removeKitOff(html, surum = 0) {
  const s = String(html ?? '')
  const line = kitLine(surum)
  const i = s.indexOf(`\n${line}`)
  return i < 0 ? s : s.slice(0, i) + s.slice(i + 1 + line.length)
}

/**
 * Sayfanın kendi hükmü: `class` adında verdict/hüküm geçen öğenin metni ya da düz metinde
 * "Hüküm:" / "Verdict:" ile başlayan satır. Açılış kelimesi (`verdictOpening`) tanınan aday
 * önce gelir (`acilisli: true`); yoksa ilk aday AÇILIŞSIZ döner — çağıran onu sınıflamaz,
 * olduğu gibi alıntılar (tanınmayan metni "Bitti:" diye sınıflamak uydurma olur). Pure.
 * @param {string} html
 * @param {string} metin  htmlToText(html).metin
 * @param {(h:string)=>object|null} verdictOpening  reportSchema.verdictOpening
 * @returns {{metin:string, nereden:string, acilisli:boolean}|null}
 */
export function pageVerdict(html, metin, verdictOpening) {
  const adaylar = []
  const re = /<([a-z][a-z0-9]*)\b[^>]*\bclass\s*=\s*["'][^"']*\b(?:verdict|h[uü]k[uü]m)\b[^"']*["'][^>]*>([\s\S]{0,1200}?)<\/\1>/gi
  for (const m of String(html ?? '').matchAll(re)) adaylar.push({ ham: m[2], nereden: 'sınıf' })
  for (const l of String(metin ?? '').split('\n')) {
    const m = /^\s*(?:[-*]\s*)?(?:\*\*)?(?:h[uü]k[uü]m|verdict)(?:\*\*)?\s*[:：]\s*(.+)$/i.exec(l)
    if (m) adaylar.push({ ham: m[1], nereden: 'satır' })
  }
  const temiz = adaylar.map((a) => ({
    nereden: a.nereden,
    metin: String(a.ham).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ').trim().replace(/^(?:h[uü]k[uü]m|verdict)(?:\s*[:：]\s*|\s+)/i, '').slice(0, 400),
  })).filter((a) => a.metin.length >= 8)
  const acilisli = temiz.find((a) => verdictOpening(a.metin))
  if (acilisli) return { ...acilisli, acilisli: true }
  return temiz[0] ? { ...temiz[0], acilisli: false } : null
}

/** `<img src="data:image/…">` karesi — sırayla `kanit:NN.<uzantı>` olur. */
const IMG_DATA_RE = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])data:image\/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)\2/gi
const EXT = { png: 'png', jpeg: 'jpeg', jpg: 'jpg', webp: 'webp', gif: 'gif', 'svg+xml': 'svg' }

/**
 * Büyük sayfanın gömülü karelerini ayır: her `<img src="data:image/X;base64,…">` →
 * `<img src="kanit:NN.ext">` + dosya. Yalnız `<img>` kareleri ayrılır (betik/CSS içindeki veri
 * ayrılamaz — o sayfa "büyük" kalır). `joinImages(splitImages(x)) === x` testle kilitli. Pure.
 * @returns {{html:string, kareler:Array<{ad:string, mime:string, b64:string}>}}
 */
export function splitImages(html) {
  const kareler = []
  const out = String(html ?? '').replace(IMG_DATA_RE, (_m, pre, q, mime, b64) => {
    const ext = EXT[mime.toLowerCase()]
    if (!ext) return _m
    const ad = `gomulu-${String(kareler.length + 1).padStart(2, '0')}.${ext}`
    kareler.push({ ad, mime, b64 })
    return `${pre}${q}kanit:${ad}${q}`
  })
  return { html: out, kareler }
}

/** `splitImages`'ın tersi (doğrulama kolu). Pure. */
export function joinImages(html, kareler) {
  let s = String(html ?? '')
  for (const k of kareler) s = s.split(`kanit:${k.ad}`).join(`data:image/${k.mime};base64,${k.b64}`)
  return s
}

/** `<img … src="X">` — yalnız img src değeri yeniden yazılır/geri kurulur. */
const IMG_SRC_RE = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"']*)\2/gi
/** Kitin kabul ettiği kanıt adı (reportKit EVIDENCE_NAME ile aynı kural). */
export const EVIDENCE_NAME_RE = /^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/

/** Sayfanın göreli `<img src>` değerleri (şema yok, `//` yok, `/` ile başlamaz), sırayla tekil. Pure. */
export function relImageRefs(html) {
  const out = []
  for (const m of String(html ?? '').matchAll(IMG_SRC_RE)) {
    const v = m[3]
    if (!v || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(v) || out.includes(v)) continue
    out.push(v)
  }
  return out
}

/**
 * Yalnız `<img src>` değerlerini haritaya göre değiştir (`eski → yeni`). Güvenlik: sayfada zaten
 * bir hedef değer varsa (geri kurulum belirsizleşir) `null` döner. Ters işlem aynı fonksiyonun
 * ters haritayla çağrılmasıdır; `rewriteImgSrc(rewriteImgSrc(x, h), ters(h)) === x` testle kilitli. Pure.
 */
export function rewriteImgSrc(html, harita) {
  const s = String(html ?? '')
  const yeniler = new Set(Object.values(harita))
  for (const m of s.matchAll(IMG_SRC_RE)) if (yeniler.has(m[3]) && !(m[3] in harita)) return null
  return s.replace(IMG_SRC_RE, (tam, pre, q, v) => (Object.prototype.hasOwnProperty.call(harita, v) ? `${pre}${q}${harita[v]}${q}` : tam))
}

export const invert = (h) => Object.fromEntries(Object.entries(h).map(([k, v]) => [v, k]))

const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', avif: 'image/avif' }
/** Görsel dosya adı → mime (bilinmiyorsa null). Pure. */
export function imageMime(ad) {
  const m = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(String(ad ?? ''))
  return m ? MIME_BY_EXT[m[1].toLowerCase()] || null : null
}

/** Kit beyanı satırı: 0 = kit yok (eski sayfanın kendi görünümü), 1 = kit v1 (kanıt kareleri için şart). */
export const kitLine = (surum) => `<meta name="agentspace-kit" content="${surum}">`

/**
 * Paylaşım işareti (Murat'ın kuralı: müşteri adı/görseli yayına çıkmaz). Değer DÖNMEZ, yalnız
 * kategori + sayı. `paylasilamaz`: marka adı ya da kişisel veri (e-posta/telefon) var, ya da
 * müşteri konulu sayfa gömülü görsel taşıyor. `incele`: yalnız konu işareti. Pure.
 * @param {{ad:string, baslik:string, metin:string, html:string, kisiselVeri:Record<string,number>}} p
 */
export function shareClass(p) {
  const nedenler = []
  const marka = (String(p.html ?? '').match(BRAND_RE) || []).length
  if (marka) nedenler.push(`müşteri markası ×${marka}`)
  for (const [k, n] of Object.entries(p.kisiselVeri || {})) if (n) nedenler.push(`${k} ×${n}`)
  const konu = SENSITIVE_TOPIC_RE.test(`${p.ad} ${p.baslik}`)
  const gorsel = (String(p.html ?? '').match(/<img\b[^>]*\bsrc\s*=\s*["']data:image\//gi) || []).length
  if (konu && gorsel) nedenler.push(`müşteri konulu sayfada gömülü görsel ×${gorsel}`)
  if (nedenler.length) return { durum: 'paylaşılamaz', nedenler }
  if (konu) return { durum: 'incele', nedenler: ['konu: müşteri/geri bildirim (ad ya da başlıkta)'] }
  return { durum: 'paylaşılabilir', nedenler: [] }
}

/** Sayfanın ağ bağımlılıkları (kafeste yüklenmez): dış yazı tipi + dış betik/stil. Pure. */
export function pageDeps(html) {
  const s = String(html ?? '')
  return {
    betik: (s.match(/<script\b/gi) || []).length,
    disFont: /fonts\.googleapis\.com|fonts\.gstatic\.com|@font-face[^}]*url\(\s*["']?https?:/i.test(s),
    disBetik: (s.match(/<script\b[^>]*\bsrc\s*=\s*["']?(?:https?:)?\/\//gi) || []).length,
    gomuluVeriBayt: [...s.matchAll(/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi)].reduce((a, m) => a + m[0].length, 0),
  }
}

/** Çalışma alanı yolunun Claude Code proje klasörü adı (`/a b/c` → `-a-b-c`). Pure. */
export function encodeProjectDir(p) {
  return String(p ?? '').replace(/[^A-Za-z0-9]/g, '-')
}

/**
 * Bir yolun hangi projeye ait olduğu (etiket). Çalışma alanı altında ilk klasör; Claude'un
 * geçici klasöründe (`/private/tmp/claude-501/<kodlanmış proje>/…`) kodlanmış adın ekinden.
 * Pure.
 */
export function projectLabel(abs, ws) {
  const a = String(abs ?? '')
  const w = String(ws ?? '').replace(/\/+$/, '')
  if (w && a.startsWith(`${w}/`)) {
    const first = a.slice(w.length + 1).split('/')[0]
    return first.startsWith('.') ? 'çalışma-alanı' : first
  }
  const enc = encodeProjectDir(w)
  const m = /\/(-[A-Za-z0-9-]+)\/[0-9a-f-]{36}\//.exec(a)
  if (m && enc && m[1].startsWith(enc)) {
    const rest = m[1].slice(enc.length).replace(/^-/, '')
    return rest || 'çalışma-alanı'
  }
  return 'çalışma-alanı-dışı'
}

/** Hükmü tek satıra indir, sınırla (künye 1 satır). Pure. */
export function oneLine(s, max = 280) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}
