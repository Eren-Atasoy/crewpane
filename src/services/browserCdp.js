// ADP-095 (ADR-006 — headed automation) — CDP action executor (Electron main side).
//
// The internal browser is an Electron <webview> (ADP-091). Its guest webContents
// is reachable ONLY in the MAIN process (via did-attach-webview → `guest`). This
// module drives that guest with the Chrome DevTools Protocol through the built-in
// `webContents.debugger` — navigate / click / type / read / screenshot — so an
// agent (through the loopback bridge + MCP tool, ADP-051 pattern) can run REAL,
// headed automation the user watches live.
//
// Security (ADR-006): CDP flows ONLY through main on the guest's own debugger; the
// guest is never granted CDP and never reaches the app bridge (ADP-091 guards
// preserved). click/type are approval-gated by the bridge before reaching here;
// navigate/read/screenshot are auto. Every action is logged by the caller.
//
// `runCdpAction(dbg, action, helpers)` takes a debugger-like object
// ({ isAttached(), attach(v), sendCommand(method, params): Promise }) so it is
// unit-testable with a fake debugger (no Electron needed).

'use strict';

// Actions that mutate the page on the user's behalf.
const APPROVAL_ACTIONS = new Set(['click', 'type']);
// Read-only / navigational actions.
// ADP-884 — 'scroll' EKLENDİ: sayfayı kaydırmak sayfayı DEĞİŞTİRMEZ (geri alınabilir,
// veri göndermez) → onay kapısına takılmaz; click/type ise DEĞİŞMEDEN onaylı kalır.
const AUTO_ACTIONS = new Set(['navigate', 'read', 'readPage', 'screenshot', 'scroll']);
const ALL_ACTIONS = new Set([...APPROVAL_ACTIONS, ...AUTO_ACTIONS]);

/**
 * ADP-341: ARTIK KAPI DEĞİL. Onay kararı bağlama bakar (origin × hedef × eylem × mod) ve
 * `browserTrust.decide()` üretir — bkz. browserGate.cjs. Bu yalnız "eylem sayfayı değiştirir
 * mi?" sorusuna cevap veren yardımcı olarak durur (mevcut çağıranlar/testler için).
 */
function requiresApproval(action) {
  return APPROVAL_ACTIONS.has(action);
}

/**
 * Normalize a raw address into a loadable URL (mirrors the renderer's
 * browserController.normalizeUrl so agent-supplied bare hosts/searches work).
 */
function normalizeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^(https?|about|file|data):/i.test(s)) return s;
  if (/^[^\s]+\.[^\s]+$/.test(s) && !s.includes(' ')) return 'https://' + s;
  if (s === 'localhost' || /^localhost[:/]/.test(s)) return 'http://' + s;
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(s);
}

/** Validate + normalize a /browser request body → { ok, value | error }. */
function validateBrowserPayload(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be a JSON object' };
  const action = typeof body.action === 'string' ? body.action.trim() : '';
  if (!ALL_ACTIONS.has(action)) {
    return {
      ok: false,
      error: `unknown action: ${action || '(none)'} — one of navigate|click|type|read|readPage|screenshot`,
    };
  }
  const value = { action };
  if (action === 'navigate') {
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!url) return { ok: false, error: 'navigate requires a url' };
    value.url = url;
  }
  if (action === 'click' || action === 'type' || action === 'read') {
    const selector = typeof body.selector === 'string' ? body.selector.trim() : '';
    // ADP-884 — `findText` seçicinin ALTERNATİFİ (kullanıcı CSS bilmez, GÖRDÜĞÜ yazıyı
    // söyler). İkisi de yoksa eski hata mesajı aynen korunur.
    const findText = typeof body.findText === 'string' ? body.findText.trim() : '';
    if (!selector && !findText) return { ok: false, error: `${action} requires a selector` };
    if (selector) value.selector = selector;
    if (findText) value.findText = findText;
  }
  // ADP-884 — kaydırma: miktar (dy/dx) ya da uç nokta (scrollTo). Hiçbiri yoksa
  // yürütücü makul varsayılanı uygular (görev §7: "miktar yoksa makul varsayılan").
  if (action === 'scroll') {
    if (Number.isFinite(Number(body.dy))) value.dy = Number(body.dy);
    if (Number.isFinite(Number(body.dx))) value.dx = Number(body.dx);
    if (body.scrollTo === 'top' || body.scrollTo === 'bottom') value.scrollTo = body.scrollTo;
  }
  if (action === 'type') {
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text) return { ok: false, error: 'type requires text' };
    value.text = text;
  }
  if (typeof body.agentId === 'string' && body.agentId.trim()) value.agentId = body.agentId.trim();
  // ADP-341 — oturum izni anahtarı görev bazlıdır: `(delegationId ?? agentId) × origin`.
  // MCP göndermezse agentId'ye düşülür (ADR-026 §2.4).
  if (typeof body.delegationId === 'string' && body.delegationId.trim()) {
    value.delegationId = body.delegationId.trim();
  }
  return { ok: true, value };
}

// ── guest-side expression builders (run via Runtime.evaluate) ──────────────────
function clickPointExpr(sel) {
  return `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if(!el) return null; try { el.scrollIntoView({block:'center',inline:'center'}); } catch(e){} const r = el.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`;
}
function selectorReadExpr(sel) {
  return `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if(!el) return null; const t = el.tagName; return (t==='INPUT'||t==='TEXTAREA'||t==='SELECT') ? (el.value||'') : (el.innerText||el.textContent||''); })()`;
}
function focusExpr(sel) {
  return `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if(!el) return false; if (el.focus) el.focus(); return true; })()`;
}
/**
 * ADP-341 (ADR-026 §2.2) — HASSASİYET PROBU. Hedef elemanın risk sinyallerini eylemden
 * ÖNCE okur: parola alanı mı, `autocomplete=cc-number` mı, "Öde"/"Sil" butonu mu?
 *
 * Elemanın DEĞERİ (`el.value`) bilerek OKUNMAZ — audit'e sızmasın (sayfada zaten yazılı
 * olan bir parolayı main'e taşımanın hiçbir faydası yok, riski var).
 * Eleman yoksa `null` döner (çağıran: "eleman bulunamadı" hatası; hüküm verilmez).
 */
function elementInfoExpr(sel) {
  return `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if(!el) return null; const a = (n) => (el.getAttribute && el.getAttribute(n)) || ''; return { tag: (el.tagName||'').toLowerCase(), type: (a('type')||'').toLowerCase(), autocomplete: a('autocomplete'), name: a('name'), id: el.id || '', ariaLabel: a('aria-label'), placeholder: a('placeholder'), role: a('role'), innerText: String(el.innerText || el.textContent || '').trim().slice(0, 200) }; })()`;
}

/**
 * Hedef elemanı CDP ile ölç. → `{ found:true, elementInfo }` · `{ found:false }` (eleman yok).
 * Prob KOŞAMAZSA (CDP hatası) throw eder: çağıran güvenli varsayılana (SOR) düşer —
 * "okuyamadım, o zaman serbesttir" ASLA denmez.
 */
async function readElementInfo(dbg, selector) {
  await ensureAttached(dbg);
  const info = await evaluate(dbg, elementInfoExpr(selector));
  if (!info) return { found: false, elementInfo: null };
  return { found: true, elementInfo: info };
}

// ── ADP-884 — KAYDIRMA + METİNLE ÖGE BULMA (guest tarafı ifadeleri) ──────────

/**
 * Sayfayı kaydır ve KANITI döndür. Son-koşul disiplini (ADP-395): "kaydırdım"
 * demek yetmez — `before`/`after` gerçek `scrollY` değerleridir, çağıran ikisini
 * karşılaştırıp "sayfa kaydı mı" sorusunu VERİYLE cevaplar.
 *
 * `atEnd` (zaten dipte/tepede) AYRI bir gerçektir: değişmemiş scrollY bir ARIZA
 * değil, sayfanın sonuna gelmiş olmaktır — ikisini karıştırmak yanlış hata üretirdi.
 */
function scrollExpr({ dy = 0, dx = 0, to = null }) {
  return `(() => {
    const el = document.scrollingElement || document.documentElement || document.body;
    if (!el) return null;
    const before = { y: el.scrollTop | 0, x: el.scrollLeft | 0 };
    const max = { y: Math.max(0, (el.scrollHeight | 0) - (el.clientHeight | 0)), x: Math.max(0, (el.scrollWidth | 0) - (el.clientWidth | 0)) };
    ${to === 'bottom'
      ? 'el.scrollTop = max.y;'
      : to === 'top'
        ? 'el.scrollTop = 0;'
        : `el.scrollTop = Math.max(0, Math.min(max.y, before.y + (${Number(dy) || 0})));
           el.scrollLeft = Math.max(0, Math.min(max.x, before.x + (${Number(dx) || 0})));`}
    const after = { y: el.scrollTop | 0, x: el.scrollLeft | 0 };
    return { before, after, max, atEnd: after.y >= max.y, atTop: after.y <= 0, scrollable: max.y > 0 };
  })()`;
}

/**
 * GÖRÜNEN METİNLE öge bul ve BENZERSİZ bir seçici döndür.
 *
 * Neden "bul + işaretle": bulunan ögeye geçici bir nitelik (`data-adp-find`) yazıp
 * onun seçicisini döndürüyoruz — böylece tıklama/yazma yolunun TAMAMI (ADP-395
 * iniş kanıtı, ADP-341 hassasiyet probu, onay kapısı) DEĞİŞMEDEN çalışır. İkinci bir
 * tıklama mekanizması yazmak o kapıların hepsini atlamak olurdu.
 *
 * Sıra: (1) tam eşleşme, (2) başlayan, (3) içeren — her adımda YALNIZ görünür ögeler.
 * `kind='field'` ise arama yüzeyi form alanlarıdır (placeholder/aria-label/ad/etiket).
 */
function findByTextExpr(text, token, kind) {
  const needle = JSON.stringify(String(text || '').toLocaleLowerCase('tr'));
  const attr = JSON.stringify(token);
  const field = kind === 'field';
  return `(() => {
    const needle = ${needle};
    const low = (s) => String(s == null ? '' : s).toLocaleLowerCase('tr').replace(/\\s+/g, ' ').trim();
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const sel = ${field}
      ? 'input, textarea, select, [contenteditable="true"], [role="textbox"], [role="searchbox"], [role="combobox"]'
      : 'a, button, [role="button"], [role="link"], input[type="submit"], input[type="button"], summary, [onclick]';
    const nodes = Array.from(document.querySelectorAll(sel)).filter(visible);
    const label = (el) => ${field}
      ? low([el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.getAttribute('name'), el.getAttribute('title'), el.id, (el.labels && el.labels[0] ? el.labels[0].innerText : '')].filter(Boolean).join(' '))
      : low(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '');
    let hit = nodes.find((el) => label(el) === needle)
      || nodes.find((el) => label(el).startsWith(needle))
      || nodes.find((el) => label(el).includes(needle));
    // Alan aranıyor ve hiçbiri eşleşmediyse: TEK bir görünür metin alanı varsa o
    // kastedilmiştir (arama kutusu vakası). Birden çoksa TAHMİN ETME — null dön.
    if (!hit && ${field}) {
      const typed = nodes.filter((el) => !el.type || /^(text|search|email|url|tel|password|number)$/i.test(el.type));
      if (typed.length === 1) hit = typed[0];
    }
    if (!hit) return null;
    hit.setAttribute(${attr}, '1');
    return { selector: '[' + ${attr} + ']', text: low(hit.innerText || label(hit)).slice(0, 120), tag: (hit.tagName || '').toLowerCase() };
  })()`;
}

/** İşaretleyici niteliği temizle (sayfada kalıcı iz bırakma). */
function clearFindExpr(token) {
  return `(() => { const n = document.querySelectorAll('[' + ${JSON.stringify(token)} + ']'); n.forEach((el) => el.removeAttribute(${JSON.stringify(token)})); return n.length; })()`;
}

let findSeq = 0;
function nextFindToken() {
  return `data-adp-find${++findSeq}`;
}

/**
 * `findText` verilmişse ögeyi bul ve geçici seçicisini döndür; yoksa gelen
 * `selector`ı aynen kullan. Bulunamazsa AÇIK hata (uydurma seçiciyle tıklamak
 * "yanlış ögeye tıkladım" demektir).
 * @returns {Promise<{selector:string, token:string|null, found:object|null}>}
 */
async function resolveTarget(dbg, action) {
  if (!action.findText) return { selector: action.selector, token: null, found: null };
  const token = nextFindToken();
  const kind = action.action === 'type' ? 'field' : 'clickable';
  const found = await evaluate(dbg, findByTextExpr(action.findText, token, kind));
  if (!found || !found.selector) {
    throw new Error(`selector not found: "${action.findText}" yazılı bir öge bulamadım`);
  }
  return { selector: found.selector, token, found };
}

function dispatchInputExpr(sel) {
  return `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if(!el) return false; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`;
}

// ADP-398 — TYPE son-koşulu (ADP-395 korunur): alanı yaz sonrası oku, metin indi mi karar ver.
// `readAfter` OKUYAMAZSA `undefined` döner (kanıt yok → hüküm verme). `judgeTyped`:
//   'ok'      — metin alanda VAR ya da değer değişti,
//   'failed'  — okunabildi ama metin yok VE hiç değişmedi,
//   'unknown' — alan okunamadı (uydurma hata üretme).
async function readAfter(dbg, selector) {
  return evaluate(dbg, selectorReadExpr(selector)).catch(() => undefined);
}
function judgeTyped(after, before, text) {
  if (after === undefined) return 'unknown';
  const got = after == null ? '' : String(after);
  const bef = before == null ? '' : String(before);
  return got.includes(text) || got !== bef ? 'ok' : 'failed';
}

// ── ADP-395 — SON-KOŞUL DOĞRULAMASI (sessiz sahte başarının sonu) ─────────────
//
// ADP-392 ölçümü: kompoze edilmeyen (display:none) bir guest'in viewport'u 0×0 olur;
// `getBoundingClientRect()` (0,0) döner → seçici "bulundu" sayılır → fare boşluğa iner →
// eylem yine de `ok:true` raporlar. Ajan "tıkladım" der, sayfa değişmez, tekrar dener.
//
// Kural (ADP-342'nin düzeltmesi): EKRAN GÖRÜNTÜSÜ kanıttır (alınamazsa eylem koşar),
// ama TIKLAMA bir KAPIDIR — indiği KANITLANMADAN `ok:true` DÖNÜLMEZ.

/** Guest'in görünür alanı. 0×0 = guest kompoze edilmiyor (çizilmiyor) → hiçbir eylem sürülemez. */
function viewportExpr() {
  return `(() => ({ w: window.innerWidth|0, h: window.innerHeight|0 }))()`;
}

/**
 * Tıklamanın hedefe İNDİĞİNİ ölçen sayaç. Kanıt sayfanın NE YAPTIĞI değil (tıklama hiçbir
 * şeyi değiştirmiyor olabilir — bu bizi ilgilendirmez), fare olayının hedefe ULAŞMASIDIR.
 *   • onTarget: pointerdown hedefin kendisine/altına indi
 *   • anyDown : pointerdown sayfaya indi ama başka bir öğeye (üstte overlay var)
 */
// ⚠ Sayaç EYLEM BAŞINA benzersiz olmalı: onaylar TOPLU verilebiliyor (ADP-342) → iki tıklama
// AYNI ANDA koşar. Tek bir global (`window.__adpLanding`) kullanılırsa ikinci eylem birincinin
// defterini ezer ve birinci "tıklama inmedi" diye YANLIŞ hata verir (adp342 spec'i yakaladı).
let landSeq = 0;
function nextLandToken() {
  return `__adpLand${++landSeq}`;
}
function armLandingExpr(sel, token) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const st = { any: 0, target: 0 };
    const h = (e) => { st.any++; const t = e.target; if (t === el || (el.contains && el.contains(t)) || (t && t.contains && t.contains(el))) st.target++; };
    document.addEventListener('pointerdown', h, true);
    window[${JSON.stringify(token)}] = { st, off: () => { try { document.removeEventListener('pointerdown', h, true); } catch (e) {} } };
    const r = el.getBoundingClientRect();
    return { w: r.width, h: r.height };
  })()`;
}
function readLandingExpr(token) {
  return `(() => { const rec = window[${JSON.stringify(token)}]; if (!rec) return { any: 0, target: 0 }; try { rec.off(); } catch(e){} delete window[${JSON.stringify(token)}]; return rec.st; })()`;
}

// Kompoze edilmeyen guest'te `Input.dispatchMouseEvent` ~5 sn asılıyor (ADP-392 ölçümü).
// Üst sınır: asılma bir HATA'dır, "yavaşlık" değil.
const INPUT_TIMEOUT_MS = 3000;

async function sendCapped(dbg, method, params, ms = INPUT_TIMEOUT_MS) {
  let timer;
  const capped = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${method} ${ms}ms içinde dönmedi — guest kare üretmiyor (kompoze edilmiyor)`)), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    return await Promise.race([dbg.sendCommand(method, params), capped]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ADP-394 — guest'in görünür alanı ({w,h}). main bunu "sekme kompoze edildi mi?" beklerken
 * yoklar (0×0 → henüz çizilmiyor). Prob koşamazsa {w:0,h:0} döner (güvenli varsayılan).
 */
async function readViewport(dbg) {
  await ensureAttached(dbg);
  const vp = await evaluate(dbg, viewportExpr()).catch(() => null);
  return { w: (vp && vp.w) | 0, h: (vp && vp.h) | 0 };
}

/**
 * Eylemden ÖNCE: guest çiziliyor mu? 0×0 ise fare olayı fiziksel olarak inemez → net hata.
 * (Çağıran main, bunu görmeden önce sekmeyi kompoze etmeye ÇALIŞIR — ADP-394.)
 */
async function assertComposited(dbg) {
  const vp = await evaluate(dbg, viewportExpr()).catch(() => null);
  if (!vp || (vp.w | 0) * (vp.h | 0) === 0) {
    throw new Error(
      'tıklama inmedi: hedef görünmez / guest kompoze edilmiyor (viewport 0×0 — sekme display:none olabilir)',
    );
  }
  return vp;
}

// ADP-398 — ATTACH/ENABLE ÖNBELLEĞİ (gecikme bütçesi). ensureAttached her eylemde 4 CDP
// komutu yolluyordu; tek bir click aynı istekte 3 kez ensureAttached'e uğruyor (prob →
// kompozisyon probu → runCdpAction) = ~12 gereksiz round-trip. Domain enable'ları OTURUM
// başına BİR kez yeterli (idempotent, ama round-trip pahalı). Debugger halâ attach'lıysa
// ve daha önce enable ettiysek → 0 komut.
//   • Anahtar = debugger nesnesi (webContents.debugger her erişimde AYNI instance; guest
//     yok olunca GC → WeakSet girdisi otomatik silinir, sızıntı yok).
//   • Yeniden attach (cross-process doküman takası debugger'ı ayırabilir) enable'ları
//     SIFIRLAR → cache'i geçersiz kıl, taze enable et. "attach'lı + enable'lı" tek güvenli
//     atlama koşulu.
const enabledDebuggers = new WeakSet();

async function ensureAttached(dbg) {
  const attached = dbg.isAttached && dbg.isAttached();
  if (!attached) {
    dbg.attach('1.3');
    enabledDebuggers.delete(dbg); // taze attach = domain'ler resetlendi
  } else if (enabledDebuggers.has(dbg)) {
    return; // zaten attach'lı ve enable edilmiş → CDP round-trip YOK
  }
  // Enable the domains we use; idempotent + best-effort (already-enabled is fine).
  await dbg.sendCommand('Page.enable').catch(() => {});
  await dbg.sendCommand('Runtime.enable').catch(() => {});
  await dbg.sendCommand('DOM.enable').catch(() => {});
  // Treat the guest page as focused even when the OS window is backgrounded — so
  // el.focus() + Input.insertText (typing) actually land in the focused field.
  // Without this, typing silently no-ops whenever the app window isn't frontmost.
  await dbg.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  enabledDebuggers.add(dbg);
}

async function evaluate(dbg, expression) {
  const res = await dbg.sendCommand('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res && res.exceptionDetails) {
    throw new Error('guest eval failed: ' + (res.exceptionDetails.text || 'exception'));
  }
  return res && res.result ? res.result.value : undefined;
}

// ADP-342 — ekran görüntüsü KANIT'tır, KAPI değil. `Page.captureScreenshot`, guest kare
// üretmiyorsa (arka plan sekmesi — ADP-333 ajan sekmelerini arka planda açıyor — ya da
// pencere örtülü/compositor uykuda) HİÇ dönmez: promise sonsuza kadar asılı kalır. Her
// eylem (navigate/click/type/screenshot) sonunda bunu çağırdığı için TÜM otomasyon
// donuyordu — bridge yanıtı asla dönmüyor, ajan orada kilitleniyordu (2026-07-14 e2e'de
// canlı ölçüldü: `readPage` anında dönerken `click` 25sn+ yanıtsız).
// Kural: görüntü alınamıyorsa eylem yine de KOŞAR ve `screenshot: null` döner.
const SHOT_TIMEOUT_MS = 4000;
// Hata-kanıtı çekimi: guest çiziliyorsa <200ms döner; çizmiyorsa uzun bekleme anlamsız
// (boş kareyi zaten alamayız) → daha kısa sınır (ADP-398).
const ERROR_SHOT_TIMEOUT_MS = 1500;

async function captureShot(dbg, saveScreenshot, tag, ms = SHOT_TIMEOUT_MS) {
  let timer;
  const shot = dbg.sendCommand('Page.captureScreenshot', { format: 'png' });
  const capped = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  const res = await Promise.race([shot.catch(() => null), capped]);
  clearTimeout(timer);
  const data = res && res.data ? res.data : '';
  if (!data) return null;
  return typeof saveScreenshot === 'function' ? saveScreenshot(data, tag) : null;
}

/**
 * Execute one validated browser action against a guest debugger via CDP.
 *
 * ADP-398 — EKRAN GÖRÜNTÜSÜ POLİTİKASI (gecikme bütçesi). Eskiden HER eylem sonunda diske
 * bir PNG yazılıyordu. Artık ADP-395 son-koşul doğrulaması (landing/postcondition) BAŞARININ
 * KANITIDIR — görüntü değil. Dolayısıyla:
 *   • başarılı sessiz eylem (navigate/click/type) → çekim YOK (screenshot: null),
 *   • `screenshot` eylemi → açık istek, her zaman çeker,
 *   • HATA → kanıt için en-iyi-çaba çekim (ADP-342 gereksinimi korunur; guest çizmiyorsa
 *     kısa sınırla null döner, hata yolunu uzatmaz).
 * @param {{isAttached?:Function, attach:Function, sendCommand:Function}} dbg
 * @param {{action:string, url?:string, selector?:string, text?:string}} action
 * @param {{saveScreenshot?:(b64:string,tag:string)=>string|null, log?:(m:string)=>void}} [helpers]
 * @returns {Promise<object>} a result describing what happened (+ screenshot path).
 */
async function runCdpAction(dbg, action, helpers = {}) {
  const { saveScreenshot, log = () => {} } = helpers;
  try {
    return await dispatchAction(dbg, action, helpers);
  } catch (err) {
    // ADP-398 — başarıda çekim almıyoruz; HATA'da kanıt şart (ADP-342). En kötü durumda
    // (guest kompoze değil) kısa sınırla null döner → hata yanıtını geciktirmez.
    try {
      const shot = await captureShot(dbg, saveScreenshot, `error-${action.action}`, ERROR_SHOT_TIMEOUT_MS);
      if (shot) {
        err.screenshot = shot;
        log(`browser ${action.action} HATA — kanıt görüntüsü: ${shot}`);
      }
    } catch { /* kanıt en-iyi-çaba; asıl hata korunur */ }
    throw err;
  }
}

async function dispatchAction(dbg, action, helpers = {}) {
  const { saveScreenshot, log = () => {} } = helpers;
  await ensureAttached(dbg);
  const a = action.action;

  if (a === 'navigate') {
    const url = normalizeUrl(action.url);
    if (!url) throw new Error('navigate requires a url');
    // Navigate via the webContents (helpers.navigate → guest.loadURL), NOT CDP
    // Page.navigate: a Page.navigate can swap the render target out from under our
    // debugger session ("target closed while handling command"). loadURL keeps the
    // debugger bound to the same webContents; we just re-ensure attach afterwards
    // in case a cross-process document swap briefly detached it.
    if (typeof helpers.navigate === 'function') {
      await helpers.navigate(url);
    } else {
      await dbg.sendCommand('Page.navigate', { url });
    }
    await ensureAttached(dbg);
    log(`browser navigate → ${url}`);
    // ADP-398 — başarılı navigate'te otomatik çekim YOK (ajan gerekirse `screenshot`/`readPage`).
    return { ok: true, action: a, url, screenshot: null };
  }

  if (a === 'read' || a === 'readPage') {
    // ADP-884 — `read` çoklu seçiciyi de okur ("h1, h2, h3" → başlıklar). Tek öge
    // okuyan eski yol (selectorReadExpr) KORUNUR; çoklu ise satır satır birleştirilir.
    const sel = action.selector || '';
    const multi = a === 'read' && /[,\s>+~]/.test(sel.trim());
    const expr = a !== 'read'
      ? `document.body ? document.body.innerText : ''`
      : multi
        ? `(() => { const n = Array.from(document.querySelectorAll(${JSON.stringify(sel)})); if (!n.length) return null; return n.map((el) => String(el.innerText || el.textContent || '').trim()).filter(Boolean).join('\\n'); })()`
        : selectorReadExpr(sel);
    const text = await evaluate(dbg, expr);
    if (a === 'read' && (text === null || text === undefined)) {
      throw new Error('selector not found: ' + sel);
    }
    const out = text == null ? '' : String(text);
    log(`browser ${a}${a === 'read' ? ' ' + sel : ''} → ${out.length} chars`);
    return { ok: true, action: a, text: out };
  }

  // ADP-884 — KAYDIRMA. Kanıt son-koşuldur (ADP-395 disiplini): scrollY GERÇEKTEN
  // değişti mi? Değişmediyse iki ayrı gerçek var — sayfa zaten uçtaydı (bu bir
  // BAŞARIDIR, kullanıcıya öyle söylenir) ya da sayfa hiç kaydırılamıyor (ARIZA).
  if (a === 'scroll') {
    const to = action.scrollTo === 'top' || action.scrollTo === 'bottom' ? action.scrollTo : null;
    const dy = Number.isFinite(Number(action.dy)) ? Number(action.dy) : to ? 0 : 600;
    const dx = Number.isFinite(Number(action.dx)) ? Number(action.dx) : 0;
    const res = await evaluate(dbg, scrollExpr({ dy, dx, to }));
    if (!res) throw new Error('sayfa kaydırılamadı: kaydırılabilir bir kök öge yok');
    const moved = res.after.y !== res.before.y || res.after.x !== res.before.x;
    if (!moved && res.scrollable === false) {
      throw new Error('sayfa kaydırılamadı: sayfa kaydırılabilir değil (içerik ekrana sığıyor)');
    }
    log(`browser scroll ${to || `dy=${dy}`} → ${res.before.y} → ${res.after.y} (max ${res.max.y})`);
    return {
      ok: true, action: a, moved, from: res.before.y, to: res.after.y, max: res.max.y,
      atEnd: !!res.atEnd, atTop: !!res.atTop, screenshot: null,
    };
  }

  if (a === 'screenshot') {
    const screenshot = await captureShot(dbg, saveScreenshot, 'screenshot');
    if (!screenshot) throw new Error('screenshot failed (empty capture / no sink)');
    log(`browser screenshot → ${screenshot}`);
    return { ok: true, action: a, screenshot };
  }

  if (a === 'click') {
    // ADP-395 — KAPI 1: guest çiziliyor mu? (0×0 → fare inemez; eskiden sessizce ok:true)
    await assertComposited(dbg);
    // ADP-884 — hedef METİNLE de verilebilir; çözüm BURADA biter, aşağıdaki tüm
    // kapılar (iniş kanıtı dâhil) değişmeden aynı seçici üzerinde koşar.
    const resolved = await resolveTarget(dbg, action);
    const selector = resolved.selector;
    const token = nextLandToken(); // eşzamanlı eylemler birbirinin defterini ezmesin
    const armed = await evaluate(dbg, armLandingExpr(selector, token));
    if (!armed) throw new Error('selector not found: ' + selector);
    // KAPI 2: hedefin ölçülebilir bir kutusu var mı? (görünmez/0×0 eleman tıklanamaz)
    if (!(armed.w > 0 && armed.h > 0)) {
      await evaluate(dbg, readLandingExpr(token)).catch(() => {});
      throw new Error(`tıklama inmedi: hedef görünmez (${selector} kutusu ${armed.w}×${armed.h})`);
    }
    const pt = await evaluate(dbg, clickPointExpr(selector));
    if (!pt) throw new Error('selector not found: ' + selector);
    // Real headed mouse via CDP Input (the user sees the click land in the panel).
    try {
      await sendCapped(dbg, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
      await sendCapped(dbg, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
      await sendCapped(dbg, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    } catch (err) {
      await evaluate(dbg, readLandingExpr(token)).catch(() => {});
      throw err;
    }
    // KAPI 3 (asıl kanıt): pointerdown HEDEFE ULAŞTI MI? Sayfanın ne yaptığı bizi
    // ilgilendirmez — ulaşmadıysa bu bir BAŞARISIZLIKTIR, ajan tekrar denemesin diye söyle.
    const landing = (await evaluate(dbg, readLandingExpr(token)).catch(() => null)) || { any: 0, target: 0 };
    if (!landing.target) {
      throw new Error(
        landing.any
          ? `tıklama hedefe inmedi: (${Math.round(pt.x)},${Math.round(pt.y)}) noktasında başka bir öğe var (üstte overlay?) — ${selector}`
          : `tıklama inmedi: guest fare olayını almadı (sekme kompoze edilmiyor / hedef görünmez) — ${selector}`,
      );
    }
    if (resolved.token) await evaluate(dbg, clearFindExpr(resolved.token)).catch(() => {});
    log(`browser click ${selector} @(${Math.round(pt.x)},${Math.round(pt.y)}) → indi (pointerdown=${landing.target})`);
    // ADP-398 — kanıt landing (pointerdown=target), görüntü değil → başarıda çekim YOK.
    return { ok: true, action: a, selector, matchedText: resolved.found ? resolved.found.text : null, landed: true, screenshot: null };
  }

  if (a === 'type') {
    // ADP-395 — yazma da bir KAPI: alan görünmüyorsa/guest çizilmiyorsa dürüstçe patla.
    await assertComposited(dbg);
    // ADP-884 — alan METİNLE de verilebilir ("arama kutusu"); tek görünür metin alanı
    // varsa o kastedilmiştir, birden çoksa TAHMİN YOK (findByTextExpr null döner).
    const resolvedField = await resolveTarget(dbg, action);
    const selector = resolvedField.selector;
    // Focus the field with a REAL mouse click (mouse input is known to land in the
    // guest) — programmatic el.focus() alone doesn't reliably take input focus when
    // the OS window is backgrounded. Fall back to el.focus() if it isn't clickable.
    const pt = await evaluate(dbg, clickPointExpr(selector));
    if (!pt) throw new Error('selector not found: ' + selector);
    const before = await evaluate(dbg, selectorReadExpr(selector)).catch(() => '');
    await sendCapped(dbg, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    await sendCapped(dbg, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    await evaluate(dbg, focusExpr(selector)).catch(() => {});
    const text = String(action.text);
    // ADP-398 — HIZLI YOL: metnin tamamını TEK CDP round-trip'iyle gir (Input.insertText).
    // Eskiden karakter başına 2 komut (keyDown+keyUp) yollanıyordu → 10 karakter = 20
    // round-trip (375–2136ms ölçüldü). insertText çoğu alan için yeterli; framework'ler
    // için input/change'i biz ateşliyoruz.
    await sendCapped(dbg, 'Input.insertText', { text }).catch(() => {});
    await evaluate(dbg, dispatchInputExpr(selector)).catch(() => {});
    // SON-KOŞUL (ADP-395): metin gerçekten alana indi mi? Alanı yeniden oku. (Bazı alanlar
    // girdiyi biçimlendirir → birebir eşitlik ARAMA; "hiç değişmedi VE metni içermiyor" = inmedi.)
    let verdict = judgeTyped(await readAfter(dbg, selector), before, text);
    if (verdict === 'failed') {
      // YEDEK YOL: bazı alanlar (per-keystroke filtreleyenler, contenteditable'lar)
      // insertText'i yutar → Puppeteer/Playwright'ın kullandığı karakter-başı tuş olaylarına dön.
      for (const ch of text) {
        // keyDown WITH text inserts the character; a separate 'char' event would
        // insert it a SECOND time (doubling). keyUp just releases.
        await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch }).catch(() => {});
        await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', unmodifiedText: ch }).catch(() => {});
      }
      await evaluate(dbg, dispatchInputExpr(selector)).catch(() => {});
      verdict = judgeTyped(await readAfter(dbg, selector), before, text);
      if (verdict === 'failed') {
        throw new Error(`yazı inmedi: ${selector} alanı değişmedi (odak başka yerde / alan yazılamaz?)`);
      }
    }
    if (resolvedField.token) await evaluate(dbg, clearFindExpr(resolvedField.token)).catch(() => {});
    log(`browser type ${selector} ← ${text.length} chars → indi`);
    // ADP-398 — kanıt son-koşuldur (alan değeri), görüntü değil → başarıda çekim YOK.
    return { ok: true, action: a, selector, matchedText: resolvedField.found ? resolvedField.found.text : null, landed: true, screenshot: null };
  }

  throw new Error('unhandled action: ' + a);
}

module.exports = {
  APPROVAL_ACTIONS,
  AUTO_ACTIONS,
  ALL_ACTIONS,
  requiresApproval,
  normalizeUrl,
  validateBrowserPayload,
  runCdpAction,
  readElementInfo, // ADP-341 — hassasiyet probu (eylemden ÖNCE)
  readViewport, // ADP-394 — guest kompoze ediliyor mu? (0×0 = hayır)
  // exported for tests / reuse
  viewportExpr,
  clickPointExpr,
  selectorReadExpr,
  focusExpr,
  elementInfoExpr,
};
