'use strict';

// RPT5-07a — HTML RAPORUN DÜZ METNİ (saf leaf; sözleşme v3 §6.4).
//
// Rapor gövdesi artık bir HTML sayfası olabiliyor (Murat 25.09: "kesinlikle markdown
// olmamalı"). Ajanlar (`rapor_oku`), REPORT-GATE ve arama sayfayı DEĞİL bu metni okur:
// işaretleme, betik ve gömülü görsel jeton yakmasın. Çıktı markdown'a benzer (başlıklar
// `#`, tablo satırları `|`, `<pre>` çitli blok) ki bugünkü okuma kodu (`headings`,
// `evidenceKinds`) değişmeden çalışsın.
//
// NE YAPMAZ: IO yok, DOM yok (main, MCP süreci ve script aynı dosyayı yükler). HTML'i
// DOĞRULAMAZ — o `reportSchema.validateHtmlPage`in işi (`kanit:` toplayıcısı da oradan gelir). Tam bir HTML ayrıştırıcısı değil:
// etiket akışını tarar; bozuk HTML'de metin kaybolmaz, en kötü satır sonları kayar.

const path = require('node:path');
const { evidenceRefs, htmlPageOf, frontmatter } = require('./reportSchema.cjs');

/** İçeriği bütünüyle atılan öğeler (ham metin ya da görünmeyen). */
const DROP = new Set(['script', 'style', 'svg', 'noscript', 'template', 'head', 'math', 'canvas', 'iframe', 'object']);
/** Satır sonu üreten blok öğeleri. */
const BLOCK = new Set([
  'p', 'div', 'section', 'article', 'main', 'header', 'footer', 'nav', 'aside', 'figure', 'figcaption',
  'blockquote', 'ul', 'ol', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'form', 'fieldset',
  'details', 'summary', 'hr', 'address', 'body', 'html', 'label', 'legend', 'caption',
]);

const NAMED = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  laquo: '«', raquo: '»', middot: '·', bull: '•', rarr: '→', larr: '←', uarr: '↑', darr: '↓', times: '×',
  copy: '©', reg: '®', deg: '°', euro: '€', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', check: '✓',
});

/** HTML varlıklarını çöz (`&amp;`, `&#231;`, `&#x131;`). Bilinmeyen ad olduğu gibi kalır. Pure. */
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    const v = NAMED[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/** Etiketin nitelikleri (küçük harf ad → çözülmüş değer). Pure. */
function attrsOf(raw) {
  const out = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const m of String(raw || '').matchAll(re)) {
    out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

/**
 * `</tag` kapanışının indeksi (büyük/küçük harf duyarsız). `src.toLowerCase().indexOf`
 * KULLANILMAZ: `İ` küçültülünce iki kod birimi olur ve Türkçe metinde bütün indeksler kayar.
 */
function closeIndex(src, tag, from) {
  const re = new RegExp(`</${tag}(?=[\\s>/])`, 'gi');
  re.lastIndex = from;
  const m = re.exec(src);
  return m ? m.index : -1;
}

const clean = (s) => decodeEntities(s).replace(/[\s ]+/g, ' ');

/**
 * HTML → okunur düz metin. Pure.
 * @param {string} html
 * @returns {{metin:string, baslik:string, basliklar:Array<{seviye:number, metin:string}>,
 *            kanitlar:string[], gorsel:number, bayt:number}}
 */
function htmlToText(html) {
  const src = String(html == null ? '' : html);
  const bayt = Buffer.byteLength(src);
  const lines = [];
  let cur = '';
  let title = '';
  const basliklar = [];
  let gorsel = 0;
  // Tablo: satır içindeki hücreler biriktirilir, </tr>'de ` | ` ile tek satır olur.
  let row = null;
  let cell = null;
  let heading = null; // {seviye, parca}
  let listDepth = 0;

  const flush = () => {
    // Baştaki girinti (iç içe liste) korunur; geri kalan boşluk teklenir.
    const body = cur.replace(/[\s]+/g, ' ').trim();
    const t = body.startsWith('- ') ? `${(/^ */.exec(cur) || [''])[0]}${body}` : body;
    if (t) lines.push(t);
    cur = '';
  };
  const blank = () => {
    flush();
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
  };
  const emit = (text) => {
    if (!text) return;
    if (heading) heading.parca += text;
    else if (cell !== null) cell += text;
    else cur += text;
  };

  const re = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<!doctype[^>]*>|<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) emit(clean(src.slice(last, m.index)));
    last = re.lastIndex;
    const tag = m[1] ? m[1].toLowerCase() : null;
    if (!tag) continue; // yorum, CDATA, doctype
    const closing = m[0][1] === '/';
    const attrs = closing ? {} : attrsOf(m[2]);

    if (!closing && tag === 'title') {
      const end = closeIndex(src, 'title', last);
      const stop = end < 0 ? src.length : end;
      if (!title) title = clean(src.slice(last, stop)).trim();
      re.lastIndex = last = stop;
      continue;
    }
    if (!closing && DROP.has(tag)) {
      // Ham içerik: kapanış etiketine kadar atla (içindeki `</div>` vb. sayılmaz). `<head>`
      // içindeki başlık yukarıda ayrıca alınır.
      if (tag === 'head') {
        const hend = closeIndex(src, 'head', last);
        const stop = hend < 0 ? last : hend;
        const t = /<title[^>]*>([\s\S]*?)<\/title/i.exec(src.slice(last, stop));
        if (t && !title) title = clean(t[1]).trim();
        re.lastIndex = last = stop;
        continue;
      }
      if (m[0].endsWith('/>')) continue;
      const end = closeIndex(src, tag, last);
      const stop = end < 0 ? src.length : end;
      const gt = src.indexOf('>', stop);
      re.lastIndex = last = end < 0 ? src.length : (gt < 0 ? src.length : gt + 1);
      continue;
    }

    if (tag === 'pre' && !closing) {
      const end = closeIndex(src, 'pre', last);
      const stop = end < 0 ? src.length : end;
      const body = decodeEntities(src.slice(last, stop).replace(/<[^>]*>/g, '')).replace(/\r\n?/g, '\n').replace(/^\n+|\s+$/g, '');
      blank();
      if (body) lines.push('```', ...body.split('\n'), '```', '');
      const gt = src.indexOf('>', stop);
      re.lastIndex = last = end < 0 ? src.length : (gt < 0 ? src.length : gt + 1);
      continue;
    }

    const h = /^h([1-6])$/.exec(tag);
    if (h) {
      if (!closing) {
        blank();
        heading = { seviye: Number(h[1]), parca: '' };
      } else if (heading) {
        const t = heading.parca.replace(/\s+/g, ' ').trim();
        if (t) {
          lines.push(`${'#'.repeat(heading.seviye)} ${t}`, '');
          basliklar.push({ seviye: heading.seviye, metin: t });
        }
        heading = null;
      }
      continue;
    }

    switch (tag) {
      case 'br':
        if (cell !== null) cell += ' ';
        else flush();
        continue;
      case 'tr':
        if (!closing) { flush(); row = []; } else if (row) {
          if (cell !== null) { row.push(cell.trim()); cell = null; }
          if (row.some(Boolean)) lines.push(row.join(' | '));
          row = null;
        }
        continue;
      case 'td': case 'th':
        if (!closing) { if (row && cell !== null) row.push(cell.trim()); cell = ''; } else if (row && cell !== null) { row.push(cell.replace(/\s+/g, ' ').trim()); cell = null; }
        continue;
      case 'li':
        if (!closing) { flush(); cur = `${'  '.repeat(Math.max(0, listDepth - 1))}- `; } else flush();
        continue;
      case 'ul': case 'ol':
        // İç liste maddeleri arasına boş satır girmez; en dıştaki liste paragraf gibi ayrılır.
        listDepth = Math.max(0, listDepth + (closing ? -1 : 1));
        if (listDepth > (closing ? 0 : 1)) flush(); else blank();
        continue;
      case 'img': {
        gorsel += 1;
        const s = attrs.src || '';
        const where = /^data:/i.test(s) ? 'gömülü' : s;
        emit(` [görsel${attrs.alt ? `: ${attrs.alt.trim()}` : ''}${where ? ` · ${where}` : ''}] `);
        continue;
      }
      case 'input':
        if (/^(button|submit)$/i.test(attrs.type || '') && attrs.value) emit(` [${attrs.value}] `);
        continue;
      case 'button':
        emit(closing ? '] ' : ' [');
        continue;
      case 'option':
        emit(closing ? ' ' : ' · ');
        continue;
      default:
        if (BLOCK.has(tag)) {
          if (tag === 'hr') { blank(); lines.push('---', ''); continue; }
          if (row && cell !== null) { cell += ' '; continue; }
          blank();
        }
        // Satır içi öğeler (span, a, strong, code …): yalnız metinleri kalır.
    }
  }
  if (last < src.length) emit(clean(src.slice(last)));
  if (heading) { const t = heading.parca.trim(); if (t) { lines.push(`${'#'.repeat(heading.seviye)} ${t}`); basliklar.push({ seviye: heading.seviye, metin: t }); } }
  if (row && row.length) lines.push(row.join(' | '));
  flush();
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  while (lines.length && lines[0] === '') lines.shift();
  // Ardışık boş satırları teke indir; butonlardaki "[ ]" boşluklarını düzelt.
  const metin = lines
    .filter((l, i) => !(l === '' && lines[i - 1] === ''))
    .map((l) => (l.startsWith('```') ? l : l.replace(/\[\s+/g, '[').replace(/\s+\]/g, ']').replace(/(\S) {2,}/g, '$1 ')))
    .join('\n');
  const h1 = basliklar.find((b) => b.seviye === 1);
  return {
    metin,
    // Görünen başlık önce: ajanın `<title>`ı çoğu zaman kısa ya da şablondan kalma.
    baslik: h1 ? h1.metin : title,
    basliklar,
    kanitlar: evidenceRefs(src),
    gorsel,
    bayt,
  };
}

/**
 * Özet: ilk bölüm başlığına kadar olan düz paragraflar (başlık, tablo, çit, görsel satırı
 * değil; ilk paragrafı bir alt başlığın altında olan sayfada ilk bölümün paragrafları),
 * en çok `satir` satır / `karakter` karakter. Ajan `ozet` vermediğinde künyenin altına
 * yazılır (sözleşme §6.2). Pure.
 */
function autoSummary(metin, { satir = 6, karakter = 600 } = {}) {
  const out = [];
  let n = 0;
  let fence = false;
  for (const l of String(metin || '').split('\n')) {
    if (l.startsWith('```')) { fence = !fence; continue; }
    if (/^#{2,6}\s/.test(l) && out.length) break; // özet ilk bölümde biter
    if (fence || !l.trim() || /^#{1,6}\s/.test(l) || l.includes(' | ') || /^\[görsel/.test(l) || l === '---') continue;
    const t = l.replace(/^- /, '').trim();
    if (t.length < 3) continue;
    const room = karakter - n;
    if (room <= 0) break;
    out.push(t.length > room ? `${t.slice(0, Math.max(0, room - 1)).trimEnd()}…` : t);
    n += t.length;
    if (out.length >= satir) break;
  }
  return out.join('\n');
}

/**
 * REPORT-GATE girdisi (sözleşme v3 §6.8): künyesi `biçim: html` olan raporun sayfası ve
 * `<KOD>-evidence/` dosya adları. IO ENJEKTE edilir (süpervizör kendi `io`sunu, indeks
 * `fs`i verir) — bu modül saf kalır. Markdown raporda ya da sayfaya BAKILAMADIĞINDA `{}`
 * döner: kapı eski davranışla çalışır (okunamayan şey yüzünden sahte ret yok).
 * @param {string} md
 * @param {string} mdPath
 * @param {{readText:(p:string)=>string|null, exists?:(p:string)=>boolean|null, readDir?:(p:string)=>string[]|null}} io
 * @returns {{sayfa?:{durum:'var'|'yok', metin?:string}, kanitDosyalari?:string[]}}
 */
function gatePageInput(md, mdPath, io) {
  const hp = htmlPageOf(md, path.basename(String(mdPath || '')));
  if (!hp) return {};
  const dir = path.dirname(mdPath);
  const pagePath = path.join(dir, hp.sayfa);
  let html = null;
  try { html = io.readText(pagePath); } catch { html = null; }
  let sayfa;
  if (typeof html === 'string') sayfa = { durum: 'var', metin: htmlToText(html).metin };
  else if (io.exists && io.exists(pagePath) === false) sayfa = { durum: 'yok' };
  else return {};
  const fm = frontmatter(md);
  const base = hp.sayfa.replace(/\.html?$/i, '');
  const ajan = fm.ajan || fm.agent || '';
  const kod = fm.kod || (ajan && base.endsWith(`-${ajan}`) ? base.slice(0, -(ajan.length + 1)) : base);
  let kanitDosyalari = [];
  try { kanitDosyalari = (io.readDir && io.readDir(path.join(dir, `${kod}-evidence`))) || []; } catch { kanitDosyalari = []; }
  return { sayfa, kanitDosyalari };
}

module.exports = { htmlToText, autoSummary, evidenceRefs, decodeEntities, attrsOf, gatePageInput };
