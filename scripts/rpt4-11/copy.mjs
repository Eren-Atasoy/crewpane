// RPT4-11 + RPT-INBOX-01 — kaynak sayfa → rapor sayfası kopyası (ortak; göç betiği ve eşitleyici).
//
// Kipler (öncelik sırası):
//   düz     kaynağın kendisi + kit 0 satırı (eski sayfanın görünümü ve betiği bozulmaz)
//   gömülü  göreli yan görseller `data:` olarak sayfaya gömülür (≤ 2 MB), kit 0
//   kanıt   görseller + gömülü `<img>` kareleri `<KOD>-evidence/`'a, `kanit:` adıyla; kit 1
//   paket   (RPT-INBOX-01) sayfa 2 MB sınırını aşıyor ve veri betik içinde (bölünemez): sayfanın
//           TAMAMI tek bir kanıt karesine (PNG, piksel = sayfanın baytları) konur; rapor sayfası
//           küçük bir açıcıdır. Açıcı kareyi kitten alır, baytları geri okur, sağlamasını denetler
//           ve sayfayı kafesin içinde kurar. Sınır YÜKSELTİLMEDİ: rapor sayfası ~6 KB, kare
//           kanıt kapısının kendi sınırı altında (20 MB).
//
// Her kip geri kurulabilir: `rebuild(kopya) === kaynak` (bayt bayt) — göçün kontrol kolu.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  insertKitOff, removeKitOff, splitImages, joinImages, rewriteImgSrc, invert, imageMime, relImageRefs, EVIDENCE_NAME_RE, kitLine,
} from './lib.mjs'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
// RPT-SYNC-LIVE-01 — paketli uygulamada (Resources/scripts/rpt4-11) eşitleyiciyle AYNI kaynak: unpacked.
const S = require(path.join([path.join(ROOT, 'electron'), path.join(ROOT, 'app.asar.unpacked')]
  .find((d) => fs.existsSync(path.join(d, 'reportLedger.cjs'))) || path.join(ROOT, 'electron'), 'reportSchema.cjs'))

export const PAKET_AD = 'sayfa-paketi.png'
const MAGIC = Buffer.from('ASPK')
const HEADER = 16
const PX_W = 2048

const isFile = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
export const dataUri = (dosya) => `data:${imageMime(dosya)};base64,${fs.readFileSync(dosya).toString('base64')}`

// ─── paket: bayt ↔ PNG ─────────────────────────────────────────────────────────

/** FNV-1a 32 — açıcıdaki (tarayıcı) sağlamanın AYNISI. */
export function fnv1a(buf) {
  let h = 0x811c9dc5
  for (let i = 0; i < buf.length; i++) { h ^= buf[i]; h = Math.imul(h, 0x01000193) >>> 0 }
  return h >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(td) >>> 0)
  return Buffer.concat([len, td, crc])
}

/**
 * Baytları RGB PNG'nin piksellerine yaz (renk profili yok → tarayıcı renk dönüştürmez; alfa yok →
 * önçarpım kaybı yok). Başlık: `ASPK` · sürüm 1 · 3 bayt boş · uzunluk (u32) · FNV-1a (u32).
 */
export function encodePaket(buf, { sagla = fnv1a(buf) } = {}) {
  const head = Buffer.alloc(HEADER)
  MAGIC.copy(head, 0)
  head[4] = 1
  head.writeUInt32BE(buf.length, 8)
  // `sagla` yalnız kontrol kolunda değişir (yanlış sağlama → açıcı sayfayı KURMAMALI).
  head.writeUInt32BE(sagla >>> 0, 12)
  const payload = Buffer.concat([head, buf])
  const row = PX_W * 3
  const h = Math.max(1, Math.ceil(payload.length / row))
  const raw = Buffer.alloc(h * (row + 1))
  for (let y = 0; y < h; y++) {
    raw[y * (row + 1)] = 0
    payload.copy(raw, y * (row + 1) + 1, y * row, Math.min(payload.length, (y + 1) * row))
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(PX_W, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit derinliği
  ihdr[9] = 2 // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** `encodePaket`in tersi (kontrol kolu). Sağlama tutmazsa null. */
export function decodePaket(png) {
  if (!Buffer.isBuffer(png) || png.length < 8) return null
  let off = 8
  let w = 0
  let h = 0
  const idat = []
  while (off + 8 <= png.length) {
    const len = png.readUInt32BE(off)
    const type = png.toString('latin1', off + 4, off + 8)
    const data = png.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); if (data[8] !== 8 || data[9] !== 2) return null }
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (!w || !h) return null
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const row = w * 3
  const out = Buffer.alloc(row * h)
  for (let y = 0; y < h; y++) {
    if (raw[y * (row + 1)] !== 0) return null
    raw.copy(out, y * row, y * (row + 1) + 1, (y + 1) * (row + 1))
  }
  if (!out.subarray(0, 4).equals(MAGIC) || out[4] !== 1) return null
  const n = out.readUInt32BE(8)
  const body = out.subarray(HEADER, HEADER + n)
  return body.length === n && fnv1a(body) === out.readUInt32BE(12) ? Buffer.from(body) : null
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Açıcı betik — kafeste çalışır (ES5 + createImageBitmap/TextDecoder/DOMParser; ağ YOK).
// Sayfanın betikleri ve `DOMContentLoaded`/`load` dinleyicileri sayfa kurulduktan SONRA, belge
// sırasıyla çalıştırılır. Kitin sayfaya kattığı iki stil sökülür: eski sayfa kendi görünümüyle açılır.
const OPENER_JS = `(function(){"use strict";
var AD=${JSON.stringify(PAKET_AD)},D=document,du=D.getElementById("as-paket");
function yaz(d,m){du.setAttribute("data-paket",d);var t=D.getElementById("as-paket-metin");if(t)t.textContent=m}
function img(){return D.querySelector('img[data-kanit="'+AD+'"]')}
function bekle(n){var im=img();if(!im)return yaz("hata","Paket karesi yok.");
 if(im.classList.contains("kanit-yok"))return yaz("hata","Paket karesi okunamadı (kanıt klasöründe yok).");
 if(im.classList.contains("kanit-hazir")&&im.complete&&im.naturalWidth)return coz(im);
 if(n>1200)return yaz("hata","Paket karesi gelmedi (zaman aşımı).");setTimeout(function(){bekle(n+1)},50)}
function fnv(b){var h=0x811c9dc5;for(var i=0;i<b.length;i++){h^=b[i];h=Math.imul(h,0x01000193)>>>0}return h>>>0}
function coz(im){var p=typeof createImageBitmap==="function"?createImageBitmap(im,{colorSpaceConversion:"none",premultiplyAlpha:"none"}):Promise.resolve(im);
 p.then(function(bm){var w=bm.width,h=bm.height,c=D.createElement("canvas");c.width=w;c.height=h;var x=c.getContext("2d",{willReadFrequently:true});x.drawImage(bm,0,0);
  var px=x.getImageData(0,0,w,h).data,n=w*h,b=new Uint8Array(n*3);for(var i=0,j=0;i<n;i++,j+=4){b[i*3]=px[j];b[i*3+1]=px[j+1];b[i*3+2]=px[j+2]}
  if(b[0]!==65||b[1]!==83||b[2]!==80||b[3]!==75||b[4]!==1)return yaz("hata","Paket başlığı tanınmadı.");
  var len=((b[8]<<24)>>>0)+(b[9]<<16)+(b[10]<<8)+b[11],sum=((b[12]<<24)>>>0)+(b[13]<<16)+(b[14]<<8)+b[15],body=b.subarray(16,16+len);
  if(body.length!==len||fnv(body)!==sum)return yaz("hata","Paket sağlaması tutmadı; sayfa kurulmadı.");
  kur(new TextDecoder("utf-8").decode(body))}).catch(function(e){yaz("hata","Paket açılamadı: "+(e&&e.message))})}
function yeniBetik(s){var n=D.createElement("script");for(var i=0;i<s.attributes.length;i++){var a=s.attributes[i];if(a.name!=="src")n.setAttribute(a.name,a.value)}n.text=s.text;return n}
function kur(html){var doc=new DOMParser().parseFromString(html,"text/html"),H=D.documentElement;
 ["agentspace-kit","agentspace-kit-tema"].forEach(function(id){var e=D.getElementById(id);if(e)e.remove()});H.removeAttribute("data-theme");
 for(var i=0;i<doc.documentElement.attributes.length;i++){var a=doc.documentElement.attributes[i];H.setAttribute(a.name,a.value)}
 D.body.innerHTML="";for(i=0;i<doc.body.attributes.length;i++){a=doc.body.attributes[i];D.body.setAttribute(a.name,a.value)}
 if(doc.title)D.title=doc.title;
 var betikler=[];function al(n){var k=D.importNode(n,true);if(k.nodeType===1){if(/^script$/i.test(k.tagName))betikler.push(k);else Array.prototype.push.apply(betikler,k.querySelectorAll("script"))}return k}
 Array.prototype.slice.call(doc.head.childNodes).forEach(function(n){if(n.nodeType===1&&/^meta$/i.test(n.tagName)&&(n.getAttribute("http-equiv")||n.hasAttribute("charset")))return;D.head.appendChild(al(n))});
 Array.prototype.slice.call(doc.body.childNodes).forEach(function(n){D.body.appendChild(al(n))});
 // Kafes belgesi srcdoc'tur: location.href = "about:srcdoc" ve \`new URL("/x.png", location.href)\` atar.
 // Eski sayfaların varlık yamaları (ör. ofis prototiplerinin __DENEME_ASSETS eşlemesi) bu tabana
 // dayanıyor; taban yalnız "about:srcdoc" iken belgenin taban adresine çevrilir. Ağ yine kapalı (CSP).
 (function(){var U=window.URL;if(!U||U.__asSrcdoc)return;function PU(u,b){if(b!==undefined&&String(b)==="about:srcdoc")b=D.baseURI;return b===undefined?new U(u):new U(u,b)}
  PU.prototype=U.prototype;["createObjectURL","revokeObjectURL","canParse","parse"].forEach(function(k){if(typeof U[k]==="function")PU[k]=U[k].bind(U)});PU.__asSrcdoc=1;window.URL=PU})();
 // srcdoc'un adresi değiştirilemez: history.replaceState/pushState(…, url) atar ve sayfayı çökertir
 // (ölçüldü: ofis-premium-yon gezintisi durumunu adrese yazıyor). Adres yazılamazsa durum yine saklanır.
 ["replaceState","pushState"].forEach(function(k){var o=history[k];if(typeof o!=="function"||o.__asSrcdoc)return;var w=function(st,t,u){try{return o.call(history,st,t,u)}catch(e){return o.call(history,st,t)}};w.__asSrcdoc=1;history[k]=w});
 var bekleyen=[],eW=window.addEventListener,eD=D.addEventListener;
 function yakala(hedef,asil){return function(t,f,o){if((t==="DOMContentLoaded"||t==="load")&&typeof f==="function"){bekleyen.push([t,hedef,f]);return}return asil.call(this,t,f,o)}}
 window.addEventListener=yakala(window,eW);D.addEventListener=yakala(D,eD);
 // Yalnız SAYFANIN betikleri yeniden çalışır (kafesin köprüsü ve kit başta zaten çalıştı).
 try{betikler.forEach(function(s){if(s.parentNode)s.parentNode.replaceChild(yeniBetik(s),s)})}
 finally{window.addEventListener=eW;D.addEventListener=eD}
 ["DOMContentLoaded","load"].forEach(function(t){bekleyen.forEach(function(b){if(b[0]!==t)return;try{b[2].call(b[1],new Event(t))}catch(e){setTimeout(function(){throw e})}})});
 if(typeof window.onload==="function")try{window.onload(new Event("load"))}catch(e){setTimeout(function(){throw e})}
 H.setAttribute("data-paket-kuruldu","1")}
if(D.readyState==="loading")D.addEventListener("DOMContentLoaded",function(){bekle(0)});else bekle(0);
})();`

/** Paket kipinin rapor sayfası: kit v3 (kanıt karesini kit çözer, kit stili kapsamlı) + açıcı. */
export function paketHtml({ baslik, bayt, sha256 }) {
  const kb = Math.ceil(bayt / 1024)
  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8">${kitLine(KANIT_KIT)}
<title>${esc(baslik)}</title>
<style>#as-paket{font:14px/1.5 system-ui,sans-serif;margin:24px;padding:16px 18px;border:1px solid #8884;border-radius:12px}#as-paket[data-paket=hata]{border-color:#d33}#as-paket img{display:none}</style>
</head><body>
<div id="as-paket" data-paket="yukleniyor" data-paket-sha256="${sha256}" data-paket-bayt="${bayt}">
<h1>${esc(baslik)}</h1>
<p id="as-paket-metin">Büyük sayfa açılıyor (${kb} KB). Sayfa tek bir kareye paketlendi; birkaç saniye sürebilir.</p>
<img data-kanit="${PAKET_AD}" alt="">
</div>
<script id="as-paket-acici">${OPENER_JS}</script>
</body></html>
`
}

// ─── kip seçimi + kopya + geri kurulum ─────────────────────────────────────────

/**
 * Sayfanın göreli yan görselleri (`<img src>`). Kafeste dosya okunmaz: taşınmazsa görsel kırık açılır.
 * Proje içinde kalan üst dizin yolu (`../agent-results/X-evidence/k.png`) `ust/<projeye göreli>` adıyla
 * alınır; proje dışına çıkan yol alınmaz (eksik sayılır). `~/.agentshot` ASLA alınmaz (Murat'ın kareleri).
 */
export function sideImages(html, pageFile, projectRoot, { sha256, agentshotRoot } = {}) {
  const baseDir = path.dirname(pageFile)
  const tumRef = relImageRefs(html)
  const shot = agentshotRoot ? path.resolve(agentshotRoot) : null
  const gorseller = tumRef.map((rel) => {
    let dec = rel.replace(/[?#].*$/, '')
    try { dec = decodeURIComponent(dec) } catch { /* ham kalsın */ }
    const dosya = path.resolve(baseDir, dec)
    if (shot && (dosya === shot || dosya.startsWith(shot + path.sep))) return { rel, dosya, kanitAd: null }
    const ic = dosya.startsWith(baseDir + path.sep)
    const kanitAd = ic ? path.relative(baseDir, dosya).split(path.sep).join('/') : dosya.startsWith(projectRoot + path.sep) ? `ust/${path.relative(projectRoot, dosya).split(path.sep).join('/')}` : null
    return { rel, dosya, kanitAd }
  }).filter((g) => g.kanitAd && EVIDENCE_NAME_RE.test(g.kanitAd) && imageMime(g.dosya) && isFile(g.dosya))
    .map((g) => { const b = fs.readFileSync(g.dosya); return { ...g, sha256: sha256 ? sha256(b) : null, bayt: b.length } })
  // RPT-CAGE-FULL-01 — betik dizesindeki göreli görseller (`img.src = 'x.jpg'`, şablon `tarayici/${…}`):
  // sayfa metni DEĞİŞMEZ (köprü çalışma anında `kanit:` adına çevirir), yalnız dosyalar taşınır.
  // Aynı görsel `<img>`de de geçiyorsa yine listede: betik onu çalışma anında `kanit:` adıyla ister.
  const imgAdlari = new Set()
  const betikGorseller = []
  const kok = path.basename(pageFile).replace(/\.html?$/i, '')
  for (const rel of scriptImageRefs(html)) {
    for (const aday of [rel, `${kok}/${rel}`]) {
      const dosya = path.resolve(baseDir, aday)
      if (!dosya.startsWith(baseDir + path.sep) || (shot && dosya.startsWith(shot + path.sep))) continue
      const kanitAd = path.relative(baseDir, dosya).split(path.sep).join('/')
      if (imgAdlari.has(kanitAd) || !EVIDENCE_NAME_RE.test(kanitAd) || !imageMime(dosya) || !isFile(dosya)) continue
      imgAdlari.add(kanitAd)
      betikGorseller.push({ kanitAd, dosya })
      break
    }
  }
  return { gorseller, eksikGorsel: tumRef.length - gorseller.length, betikGorseller }
}

/** `<script>` içindeki göreli görsel dizeleri (şema/kök yolu yok, `..` yok), sırayla tekil. Pure. */
export function scriptImageRefs(html) {
  const out = []
  for (const m of String(html ?? '').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const r of m[1].matchAll(/["'`]([A-Za-z0-9._\/-]{1,200}\.(?:png|jpe?g|webp|gif|svg|avif))["'`]/gi)) {
      const v = r[1].replace(/^(?:\.\/)+/, '')
      if (/^(?:\/|[a-z][a-z0-9+.-]*:)/i.test(v) || v.includes('..') || out.includes(v)) continue
      out.push(v)
    }
  }
  return out
}

const fits = (h) => h != null && Buffer.byteLength(h) + 64 <= S.HTML_PAGE_MAX_BYTES

/**
 * Kip: düz → gömülü → kanıt → paket. `p.gorseller` = sideImages çıktısı. `kanitTavani`: kit sayfa
 * başına en çok 40 kare çözer (reportKit EVIDENCE_MAX_COUNT); eşitleyici fazlasını pakete gönderir
 * (RPT4-11 göçü tavansız seçmişti — onun planı değişmesin diye varsayılan sınırsız).
 */
export function pickMode(p, html, { kanitTavani = Infinity } = {}) {
  // RPT-CAGE-FULL-01 — betik görseli olan sayfa kanıt kipi ister (gömülü/düz kipte kanıt klasörü yok).
  const betik = (p.betikGorseller || []).length
  if (!p.gorseller.length && !betik && fits(html)) return 'düz'
  if (p.gorseller.length && !betik) {
    const g = rewriteImgSrc(html, Object.fromEntries(p.gorseller.map((x) => [x.rel, dataUri(x.dosya)])))
    if (fits(g)) return 'gömülü'
  }
  const sp = splitImages(html)
  if (!sp.kareler.some((k) => p.gorseller.some((x) => x.kanitAd === k.ad))) {
    const k = rewriteImgSrc(sp.html, Object.fromEntries(p.gorseller.map((x) => [x.rel, `kanit:${x.kanitAd}`])))
    if (fits(k) && (sp.kareler.length || p.gorseller.length || betik) && sp.kareler.length + p.gorseller.length <= kanitTavani) return 'kanıt'
  }
  return 'paket'
}

// RPT-CAGE-FULL-01 — kanıt/paket kipi kit v3 (kapsamlı: kit stili sayfanın kendi sınıflarına dokunmaz).
export const KANIT_KIT = 3
export const kitOf = (kip) => (kip === 'kanıt' || kip === 'paket' ? KANIT_KIT : 0)
const betikDosyalari = (p, var_ = []) => {
  const ad = new Set(var_.map((x) => x.kanitAd))
  return (p.betikGorseller || []).filter((x) => !ad.has(x.kanitAd)).map((x) => ({ ad: x.kanitAd, buf: fs.readFileSync(x.dosya) }))
}

/** Rapora gidecek sayfa + `<KOD>-evidence/` dosyaları (kipine göre). */
export function buildCopy(p, src) {
  if (p.kip === 'gömülü') {
    const h = rewriteImgSrc(src, Object.fromEntries(p.gorseller.map((x) => [x.rel, dataUri(x.dosya)])))
    return { html: insertKitOff(h, 0).html, dosyalar: [] }
  }
  if (p.kip === 'kanıt') {
    const sp = splitImages(src)
    const h = rewriteImgSrc(sp.html, Object.fromEntries(p.gorseller.map((x) => [x.rel, `kanit:${x.kanitAd}`])))
    return {
      html: insertKitOff(h, KANIT_KIT).html,
      dosyalar: [...sp.kareler.map((k) => ({ ad: k.ad, buf: Buffer.from(k.b64, 'base64') })), ...p.gorseller.map((x) => ({ ad: x.kanitAd, buf: fs.readFileSync(x.dosya) })), ...betikDosyalari(p, p.gorseller)],
    }
  }
  if (p.kip === 'paket') {
    const buf = paketGovdesi(p, src)
    return { html: paketHtml({ baslik: p.baslik || 'Sayfa', bayt: buf.length, sha256: p.sha256 }), dosyalar: [{ ad: PAKET_AD, buf: encodePaket(buf) }, ...betikDosyalari(p)] }
  }
  return { html: insertKitOff(src, 0).html, dosyalar: [] }
}

/** Paketin taşıdığı gövde: yan görseller içine gömülür (paket kendi başına eksiksiz olsun). */
function paketGovdesi(p, src) {
  const g = p.gorseller.length ? rewriteImgSrc(src, Object.fromEntries(p.gorseller.map((x) => [x.rel, dataUri(x.dosya)]))) : src
  return Buffer.from(g == null ? src : g, 'utf8')
}

/** Paket kipinin rapor sayfası (açıcı) — kareyi ÜRETMEDEN; "açıcı eskidi mi" denetimi için ucuz yol. */
export function paketSayfasi(p, src) {
  return paketHtml({ baslik: p.baslik || 'Sayfa', bayt: paketGovdesi(p, src).length, sha256: p.sha256 })
}

/** Kontrol kolu: yazılmış sayfadan kaynağı geri kur (kit satırını sök, görsel değerlerini geri yaz). */
export function rebuild(p, txt, evDir) {
  if (p.kip === 'gömülü') {
    const s = removeKitOff(txt, 0)
    return rewriteImgSrc(s, invert(Object.fromEntries(p.gorseller.map((x) => [x.rel, dataUri(x.dosya)]))))
  }
  if (p.kip === 'kanıt') {
    const s = rewriteImgSrc(removeKitOff(txt, KANIT_KIT), invert(Object.fromEntries(p.gorseller.map((x) => [x.rel, `kanit:${x.kanitAd}`]))))
    if (s == null) return null
    const kareler = []
    for (const m of s.matchAll(/kanit:(gomulu-\d+\.([a-z]+))/g)) {
      let b64
      try { b64 = fs.readFileSync(path.join(evDir, m[1])).toString('base64') } catch { return null }
      kareler.push({ ad: m[1], mime: m[2] === 'svg' ? 'svg+xml' : m[2], b64 })
    }
    return joinImages(s, kareler)
  }
  if (p.kip === 'paket') {
    let png
    try { png = fs.readFileSync(path.join(evDir, PAKET_AD)) } catch { return null }
    const body = decodePaket(png)
    if (!body) return null
    const s = body.toString('utf8')
    return p.gorseller.length ? rewriteImgSrc(s, invert(Object.fromEntries(p.gorseller.map((x) => [x.rel, dataUri(x.dosya)])))) : s
  }
  return removeKitOff(txt, 0)
}
