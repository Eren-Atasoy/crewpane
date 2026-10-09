'use strict';

const morph = require('../turkishMorph.cjs');
const {
  ACTION_VERB_STEMS: STEMS,
  SCROLL_EN,
  STOP_VERB_STEMS,
  THEME_BASE_WORDS,
} = require('../../agents/intentLexicon.cjs');
const promptRouter = require('../../agents/promptRouter.cjs');

/** OLUMLU bir fiil eşleşmesi var mı? ("kapatma" burada FALSE döner.) */
function hasV(toks, key) {
  return morph.hasVerb(toks, STEMS[key]);
}

/** Kök OLUMSUZ biçimde mi geçiyor? ("kapatma", "başlatma", "özetleme") */
function negV(toks, key) {
  return morph.hasNegatedVerb(toks, STEMS[key]);
}

const STATUS_RE =
  /(ne durum|durum ne|durumday|durumda m|ne yap[ıi]yor|neler oluyor|kim çal[ıi]ş|çal[ıi]ş[ae]n|rapor ver|durum raporu|nas[ıi]l gidiyor)/i;
const DELEGATE_RE =
  /(görev ver|görevi ver|delege|delegasyon|atayal|ata\b|başlat|söyle|takım[ıi]na|ekibine|worker|çal[ıi]şt[ıi]r|yapt[ıi]r|hallet)/i;
const THEME_RE = /(tema|theme)/i;
const THEME_CHANGE_CUE_RE = /(yap|değiştir|degistir|çevir|cevir|geç|gec\b|olsun|al\b|ayarla|aç)/;
const THEME_NEG_RE = /(^|\s)(değiştirme|degistirme|yapma|çevirme|cevirme|alma|ayarlama)(\s|$|[.,!?…])/;
const THEME_BASE_PRESET = Object.freeze({ dark: 'kutup', light: 'kagit' });

/** Taban sözcüklerini SÖZCÜK BAŞINDAN arar (ek serbest: "koyuya", "karanlığa"). */
function themeBaseRe(words) {
  const alt = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`(^|[^\\p{L}\\p{N}])(${alt})`, 'u');
}

const THEME_BASE_RES = Object.freeze({
  dark: themeBaseRe(THEME_BASE_WORDS.dark),
  light: themeBaseRe(THEME_BASE_WORDS.light),
});

/**
 * Cümlede geçen tema TABANI ('dark'|'light'|null).
 * İkisi de geçiyorsa SONRAKİ kazanır: "koyu temadan açığa geç" → açık (hedef sonda).
 */
function detectThemeBase(low, lowEn) {
  const ara = (s) => {
    const d = s.search(THEME_BASE_RES.dark);
    const l = s.search(THEME_BASE_RES.light);
    if (d < 0 && l < 0) return null;
    if (d < 0) return 'light';
    if (l < 0) return 'dark';
    return l > d ? 'light' : 'dark';
  };
  return ara(low) ?? (lowEn && lowEn !== low ? ara(lowEn) : null);
}

const SPRINT_START_RE = /sprint[^]*?(başlat|baslat|aç\b|start)/i;
const SPRINT_STATUS_RE = /sprint[^]*?(durum|status|nerede|ne oldu)/i;
const BOARD_NEW_RE = /(yeni )?(görev|gorev|task)[^]*?(aç|ac\b|oluştur|olustur|ekle)/i;
const BOARD_LIST_RE = /(görev|gorev|task|backlog|panoda|board)[^]*?(liste|listele|ne var|neler var|göster)/i;
const BOARD_STATUS_RE = /\b(backlog|todo|in[_ ]?progress|review|done|bitti|tamam(landı)?)\b/i;
const REPORT_RE = /(rapor|report)/i;
const MEMORY_WHAT_RE = /(ne öğrendi|ne ogrendi|neler öğrendi|hafızasında ne|hafizasinda ne)/i;
const MEMORY_PROMOTE_RE = /(kurala (yükselt|yukselt|çevir|cevir)|kural(a| olarak) (ekle|kaydet)|terfi et)/i;
const AGENT_LAST_RE = /(son mesaj|son cevab|son cevap|son yanıt|son yanit|ne dedi|ne diyor|ne demiş|ne demis|son raporu ne|en son ne)/i;
const TASK_ID_RE = /\b((?:TASK|ADP|CF|AD)-[A-Z0-9-]+)\b/i;

const TERMINAL_RE = /(terminal|pane|konsol|shell|oturum)/i;
const TERM_FOCUS_RE = /(odakla|odaklan|focus|öne al|öne getir|göster\b)/i;
const ALL_RE = /(tüm[üu]?|bütün|hepsi|hepsin|herkes)/i;
const BROWSER_BACK_RE = /(geri (git|dön|al|gel|dönelim)|önceki sayfa)/i;
const BROWSER_CLICK_RE = /(tıkla|tıkl[ae]\b|tıklay)/i;
const BROWSER_READ_RE = /((sayfa|içerik|metin|metni|yazı|bunu|şunu|burayı)[^]*?(oku|özetle|özet)|sayfayı (oku|özetle))/i;
const BROWSER_SEARCH_RE = /(\bara\b|\barat\b|arasana|arama yap|aratır mısın|arar mısın|diye ara|internette? ?ar|google['’]?(da|de|den)? ?ar|web['’]?de ?ar)/i;
const BROWSER_OPEN_RE = /(aç\b|açar m|aç[ıi]ver|git\b|gir\b|göster\b|getir\b|ziyaret et)/i;
const BROWSER_CUE_RE = /(site|sayfa|tarayıc|web sayfa|web site|internet|google|link|bağlant|url|https?:\/\/)/i;
const BROWSER_TASK_RE = /(sepete (ekle|at|koy)|sepete\b|satın al|satin al|sipariş ver|siparis ver|satın alma|ürün bul|urun bul|ürünü bul|trendyol|hepsiburada|amazon|aliexpress|alışveriş|alisveris|siteye (gir|gidip)|sitesine (gir|gidip)|tarayıcıda (gez|dolaş|gezin|bul|alışveriş)|web sitesinde (gez|bul|ara))/i;
const HOST_RE = /\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?)\b/i;

const SCROLL_CUE_RE =
  /(^|\s)(aşağ[ıi](?!daki|dakini)|yukar[ıi](?!daki|dakini)|dibe|en (alt|üst|başa|sona)|sayfan[ıi]n (sonu|sonuna|dibi|dibine|başı|başına|altı|altına|üstü|üstüne)|başa dön|sona git)/i;
const SCROLL_TOP_RE = /(yukar[ıi]|başa|üste|üstüne|başı|başına|üstü)/i;
const SCROLL_END_RE = /(sayfan[ıi]n (sonu|sonuna|dibi|dibine|alt[ıi]|alt[ıi]na)|en (alta|sona)|dibe|sona git|en alt)/i;
const SCROLL_START_RE = /(sayfan[ıi]n (baş[ıi]|baş[ıi]na|üst[üu]|üst[üu]ne)|en (üste|başa)|başa dön|en üst)/i;
const SCROLL_SMALL_RE = /(biraz|az[ıi]c[ıi]k|hafif|bir tık|yavaş)/i;
const SCROLL_BIG_RE = /(çok|iyice|epey|bayağ[ıi])/i;
const SCROLL_STEP_DEFAULT = 600;
const SCROLL_STEP_SMALL = 300;
const SCROLL_STEP_BIG = 1200;

const escRe = (w) => String(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const anyOf = (words) => words.map(escRe).join('|');

const EN_SCROLL_CUE_RE = new RegExp(
  `\\b(?:${anyOf(SCROLL_EN.verbs)})\\b` +
    `|\\bpage\\s+(?:${anyOf([...SCROLL_EN.down, ...SCROLL_EN.up])})\\b` +
    `|\\b(?:go|jump|take me|move)\\s+(?:to\\s+)?(?:the\\s+)?(?:${anyOf([...SCROLL_EN.bottom, ...SCROLL_EN.top])})\\b`,
  'i',
);
const EN_SCROLL_DOWN_RE = new RegExp(`\\b(?:${anyOf(SCROLL_EN.down)})\\b`, 'i');
const EN_SCROLL_UP_RE = new RegExp(`\\b(?:${anyOf(SCROLL_EN.up)})\\b`, 'i');
const EN_SCROLL_BOTTOM_RE = new RegExp(`\\b(?:${anyOf(SCROLL_EN.bottom)})\\b`, 'i');
const EN_SCROLL_TOP_RE = new RegExp(`\\b(?:${anyOf(SCROLL_EN.top)})\\b`, 'i');
const EN_SCROLL_SMALL_RE = new RegExp(`\\b(?:${anyOf(SCROLL_EN.small)})\\b`, 'i');
const EN_SCROLL_BIG_RE = new RegExp(`\\b(?:${anyOf(SCROLL_EN.big)})\\b`, 'i');
const EN_NEG_RE = new RegExp(`(?:\\bdo\\s*n['’]?t\\b|\\b(?:${anyOf(SCROLL_EN.negation)})\\b)`, 'i');
const EN_BARE_SCROLL_RE = new RegExp(
  `^(?:(?:hey|ok|okay|please|jarvis|agent\\s*x)[\\s,]+)*(?:${anyOf(SCROLL_EN.verbs)})(?:[\\s,]+(?:please|now|a\\s*bit))?[.!?]*$`,
  'i',
);

const SCROLL_GERUND_RE = new RegExp(`\\b(?:${anyOf(STEMS.scroll)})m[ae][a-zçğıöşü]*\\b`, 'i');
function isStoppedScroll(low, toks) {
  return SCROLL_GERUND_RE.test(low) && morph.hasVerb(toks, STOP_VERB_STEMS);
}

const CLICK_BY_TEXT_RE =
  /(?:^|\s)([\p{L}\p{N} .,'’-]{2,60}?)\s*(?:adl[ıi]|isimli|yaz[ıi]l[ıi])?\s*(düğme|dugme|buton|button|bağlant|baglant|link|sekme|kutu|alan)[\p{L}]*\s*(?:tıkla|tikla|bas|seç|sec)/iu;
const TYPE_INTO_RE =
  /(?:^|\s)([\p{L}\p{N} -]{2,40}?)\s*(?:kutusuna|kutucuğuna|alan[ıi]na|kutusu|alan[ıi]|input(?:una)?)\s+([\s\S]{1,200}?)\s*(?:yaz|gir|doldur)[a-zçğıöşü]*\s*$/iu;
const TYPE_PLAIN_RE = /(?:^|\s)(?:şunu|sunu|bunu)?\s*["'“”]?([\s\S]{1,200}?)["'“”]?\s*(?:yaz|gir|doldur)[a-zçğıöşü]*\s*$/iu;
const HEADINGS_RE = /(başl[ıi]k|baslik|heading)/i;
const HEADINGS_SELECTOR = 'h1, h2, h3';
const BROWSER_FORWARD_RE = /(ileri (git|gel|al)|sonraki sayfa|ileriye git)/i;
const BROWSER_RELOAD_RE = /(yenile|tazele|refresh|f5)/i;
const SCREEN_NOUN_RE = /(ekran|panel|sayfas[ıi]|pencere|bölüm|sekme|ayar)/i;

const BOARD_STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'done'];

function detectAgentName(low, context = {}) {
  const aliases = Array.isArray(context.aliases) ? context.aliases : [];
  for (const a of aliases) {
    if (!a) continue;
    const name = String(a.match || '').toLocaleLowerCase('tr');
    const id = String(a.id || '').toLocaleLowerCase('tr');
    if (name && name.length > 2 && low.includes(name)) return a.id || name;
    if (id && id.length > 2 && low.includes(id)) return a.id;
  }
  return null;
}

function normalizeBoardStatusWord(word) {
  const w = String(word || '').toLocaleLowerCase('tr').replace(/\s+/g, '_');
  if (w === 'bitti' || w === 'tamam' || w === 'tamamlandı' || w === 'done') return 'done';
  if (w === 'inprogress' || w === 'in_progress') return 'in_progress';
  return BOARD_STATUSES.includes(w) ? w : null;
}

function detectDepartment(low, context = {}) {
  const aliases = Array.isArray(context.aliases) ? context.aliases : [];
  for (const a of aliases) {
    if (a && a.match && low.includes(String(a.match).toLocaleLowerCase('tr'))) return a.department;
  }
  const depts = Array.isArray(context.departments) ? context.departments : [];
  for (const d of depts) {
    if (!d) continue;
    if (d.id && low.includes(String(d.id).toLocaleLowerCase('tr'))) return d.id;
    if (d.label && low.includes(String(d.label).toLocaleLowerCase('tr'))) return d.id;
    if (d.shortLabel && low.includes(String(d.shortLabel).toLocaleLowerCase('tr'))) return d.id;
    const label = String(d.label || '').toLocaleLowerCase('tr');
    for (const tok of label.split(/\s+/)) {
      if (tok.length > 3 && tok !== 'crewpane' && tok !== 'takım' && low.includes(tok)) return d.id;
    }
  }
  return null;
}

function departmentLabel(id, context = {}) {
  const depts = Array.isArray(context.departments) ? context.departments : [];
  const hit = depts.find((d) => d && d.id === id);
  return (hit && hit.label) || id;
}

module.exports = {
  hasV,
  negV,
  STATUS_RE,
  DELEGATE_RE,
  THEME_RE,
  THEME_CHANGE_CUE_RE,
  THEME_NEG_RE,
  THEME_BASE_PRESET,
  themeBaseRe,
  THEME_BASE_RES,
  detectThemeBase,
  SPRINT_START_RE,
  SPRINT_STATUS_RE,
  BOARD_NEW_RE,
  BOARD_LIST_RE,
  BOARD_STATUS_RE,
  REPORT_RE,
  MEMORY_WHAT_RE,
  MEMORY_PROMOTE_RE,
  AGENT_LAST_RE,
  TASK_ID_RE,
  TERMINAL_RE,
  TERM_FOCUS_RE,
  ALL_RE,
  BROWSER_BACK_RE,
  BROWSER_CLICK_RE,
  BROWSER_READ_RE,
  BROWSER_SEARCH_RE,
  BROWSER_OPEN_RE,
  BROWSER_CUE_RE,
  BROWSER_TASK_RE,
  HOST_RE,
  SCROLL_CUE_RE,
  SCROLL_TOP_RE,
  SCROLL_END_RE,
  SCROLL_START_RE,
  SCROLL_SMALL_RE,
  SCROLL_BIG_RE,
  SCROLL_STEP_DEFAULT,
  SCROLL_STEP_SMALL,
  SCROLL_STEP_BIG,
  EN_SCROLL_CUE_RE,
  EN_SCROLL_DOWN_RE,
  EN_SCROLL_UP_RE,
  EN_SCROLL_BOTTOM_RE,
  EN_SCROLL_TOP_RE,
  EN_SCROLL_SMALL_RE,
  EN_SCROLL_BIG_RE,
  EN_NEG_RE,
  EN_BARE_SCROLL_RE,
  isStoppedScroll,
  CLICK_BY_TEXT_RE,
  TYPE_INTO_RE,
  TYPE_PLAIN_RE,
  HEADINGS_RE,
  HEADINGS_SELECTOR,
  BROWSER_FORWARD_RE,
  BROWSER_RELOAD_RE,
  SCREEN_NOUN_RE,
  BOARD_STATUSES,
  detectAgentName,
  normalizeBoardStatusWord,
  detectDepartment,
  departmentLabel,
};
