// FDBK-01 (jazz) — GERİ BİLDİRİM FORMUNUN MAIN UCU (saf + DI, Electron'suz).
//
// Üç dar iş yapar, üçü de SALT-OKUNUR:
//   1) `logExcerpt()`   — uygulama log'unun SON N satırı, MASKELENMİŞ hâlde.
//   2) `recentShots()`  — AgentShot'un son çekimleri (ad + zaman + küçük resim).
//   3) `shotPreview()`  — seçilen çekimin okunabilir JPEG data-URI'si + sha256.
//
// ⛔ RENDERER'A GENEL BİR DOSYA ORACLE'I AÇILMAZ. `recentShots`/`shotPreview`
//    yalnız AgentShot'un çekim klasörünü görür ve gelen ad `basename`e indirgenir
//    → `../../.ssh/id_rsa` gibi bir istek klasörün DIŞINA çıkamaz (traversal
//    nöbeti attachmentStore.withinStore deseninin aynısı, tek klasör ölçeğinde).
//
// 🔴 MASKELEME BURADA BAŞLAR, RENDERER'DA BİTER. Log kesiti kullanıcıya
//    GÖSTERİLMEDEN önce maskelenir (demo: "göndermeden önce içeriği görebilirsin"
//    — gösterilen metin ile gönderilen metin AYNI olmalı, yoksa rıza sahtedir).
//    İkinci geçiş renderer'da (src/app/lib/feedback.ts `maskSecrets`) koşar.
//
// Koş: node --test electron/feedbackBridge.test.cjs

'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const nodeCrypto = require('node:crypto');
const scrub = require('../../telemetry/scrub.cjs');

/** Kesitte kaç satır gönderilir. Demo "son 5 dakika" der; log satırları ZAMAN
 *  DAMGASI TAŞIMADIĞI için (electron/main.js `logLine`) dakika penceresi
 *  ölçülemez — ürün metni de bu yüzden "son N satır" der. Yalancı bir vaat
 *  ("5 dakika") kurmaktansa doğru olanı söylemek tercih edildi. */
const LOG_LINES = 200;
/** Üst sınır DB CHECK'i ile aynı (migration: length(log_excerpt) <= 20000). */
const LOG_MAX_CHARS = 20000;
/** Formda önerilen çekim sayısı (demo §02: "AgentShot'tan seç"). */
const SHOT_LIMIT = 6;
/** Bir çekim data-URI'si için üst sınır (DB CHECK: 800000). */
const SHOT_MAX_CHARS = 800000;

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
/** Sürükle-bırakla gelen dosyanın bayt tavanı (attachmentStore ile aynı ölçek). */
const DROP_MAX_BYTES = 25 * 1024 * 1024;

/**
 * ÖNEKLİ ENV ATAMALARI — `scrub.scrubString`'in KAPSAMADIĞI tek boşluk.
 *
 * Ölçüldü: scrub.cjs'in atama deseni `\b(api[_-]?key|…)\b` ile başlar; gerçek
 * hayattaki adların çoğu `OPENAI_API_KEY=` / `SUPABASE_SERVICE_TOKEN=`
 * biçimindedir ve `_` bir KELİME KARAKTERİ olduğu için baştaki `\b` orada
 * eşleşmez → değer maskelenmeden kalır. scrub.cjs telemetri (Sentry) yüzeyinin
 * dosyasıdır ve bu görevin kapsamı DEĞİL; burada yalnız geri bildirim kesiti
 * için ek bir geçiş yapılır ve boşluk raporda takibe bırakılır.
 */
const PREFIXED_ASSIGNMENT_RE =
  /((?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|apikey|secret|token|password|passwd|pwd|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|session[_-]?id|cookie))(\s*[:=]\s*)("?)([^\s"',;]{4,})\3/gi;

/**
 * FDBK-LOG-IP-01 — IP ADRESLERİ → `[ip]`.
 *
 * ÖLÇÜLDÜ (FB-TRIAGE-01 §4): bir müşterinin log kesitinde Tailscale adresi
 * (100.64/10) açık geçti; yollar maskeleniyordu, IP'ler değildi. Özel ağ
 * aralıklarını (10/8, 172.16/12, 192.168/16, 100.64/10, fe80::/10, fc00::/7)
 * ayrı ayrı saymak yerine kural TERS kurulur: kimliksiz olan üç adres
 * (127/8, 0.0.0.0, ::1) DIŞINDA her IP maskelenir — genel IP de bir konumdur
 * ve bunu yalnız "hangi aralık" diye listeleyen bir süzgeç yarın yeni bir
 * VPN aralığında yine delik verir. PORT KALIR (`[ip]:7823`): çakışan portun
 * hangisi olduğu hata ayıklama bilgisidir, kimlik değil.
 *
 * Yanlış-pozitif nöbeti (kontrol kolu testte): sürüm numaraları (`0.2.46`,
 * `140.0.7339.80`) 4 sekizlik + sınır kuralına takılmaz; saat damgaları
 * (`12:34:56`) IPv6 önekine (fe8x/fcxx/fdxx/2xxx/3xxx) uymaz.
 */
const IP_MASK = '[ip]';
const IPV4_RE =
  /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\w|\.\d)/g;
// Önek: link-local (fe80–febf) · ULA (fc00–fdff) · genel tek-yayın (2000::/3).
// Ardından 1–7 grup (`::` sıkıştırması boş grup olarak yakalanır) + isteğe
// bağlı bölge kimliği (`%en0`).
const IPV6_RE =
  /(?<![\w:.])(?:fe[89ab][0-9a-f]|f[cd][0-9a-f]{2}|[23][0-9a-f]{3})(?::[0-9a-f]{0,4}){1,7}(?:%\w+)?(?![\w:])/gi;
const IP_KEEP_RE = /^(?:127\.|0\.0\.0\.0$)/;

function maskIps(text) {
  return String(text)
    .replace(IPV6_RE, IP_MASK)
    .replace(IPV4_RE, (m) => (IP_KEEP_RE.test(m) ? m : IP_MASK));
}

/** Üç geçişli maskeleme: deponun kanonik süzgeci + önekli atama yaması + IP. */
function maskLogText(text) {
  const once = scrub.scrubString(String(text == null ? '' : text));
  const twice = String(once).replace(PREFIXED_ASSIGNMENT_RE, (_m, key, sep, quote) => `${key}${sep}${quote}${scrub.MASK}${quote}`);
  return maskIps(twice);
}

/** Aynı satır bu kadar kez ARDIŞIK tekrar edince tek satıra katlanır. */
const FOLD_MIN_RUN = 3;
/** Özdeş bir satır kesitte (katlanmış girdiler dahil) en fazla bu kadar kez görünür. */
const PATTERN_MAX_ENTRIES = 10;

/**
 * FDBK-LOG-01 — tekrar eden satır katlaması.
 *
 * Neden: FB-1003'te (BUG-R2 K-3) senkron spam'i alıntının 127 satırının
 * 116'sını doldurdu ve bildirilen hataya dair 0 satır kaldı — 20K kuyruk
 * penceresi tek bir desene gitti. Kırpmadan ÖNCE katlanır ki pencere gerçek
 * olaylara kalsın. MASKELENMİŞ metin üzerinde koşar (maskeleme sırası değişmez;
 * maske özdeş satırları özdeş bırakır, katlamayı bozmaz).
 *
 * İki mekanizma:
 *   1) Ardışık özdeş koşu ≥ FOLD_MIN_RUN → tek satır + ` … (×N)` notu.
 *   2) Desen tavanı: aynı içerik (koşular dahil) PATTERN_MAX_ENTRIES girdiyi
 *      aşınca sonraki tekrarlar atılır; atım SESSİZ değildir — ilk aşımda tek
 *      bir `… (desen tavanı …)` notu düşülür.
 */
function foldRepeatedLines(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const out = [];
  const entries = new Map(); // içerik → kesite giren girdi sayısı
  const capped = new Set(); // tavan notu düşülen içerikler
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let j = i;
    while (j < lines.length && lines[j] === line) j += 1;
    const run = j - i;
    const seen = entries.get(line) || 0;
    if (seen >= PATTERN_MAX_ENTRIES) {
      if (!capped.has(line)) {
        capped.add(line);
        out.push(`… (desen tavanı ${PATTERN_MAX_ENTRIES}: özdeş satırın sonraki tekrarları atıldı)`);
      }
    } else if (run >= FOLD_MIN_RUN) {
      out.push(`${line} … (×${run})`);
      entries.set(line, seen + 1);
    } else {
      for (let k = 0; k < run; k += 1) out.push(line);
      entries.set(line, seen + run);
    }
    i = j;
  }
  return out.join('\n');
}

/**
 * Geri bildirim köprüsü.
 *
 * @param {object} deps
 *   `logPath`   — uygulama log dosyası (main'de LOG_PATH). Yoksa kesit boş döner.
 *   `shotsDir`  — AgentShot çekim klasörü (~/.agentshot/shots).
 *   `makeImage` — (buffer) → { dataUrl(width,quality), size } benzeri sarmalayıcı;
 *                 Electron'da nativeImage, testte sahte. Yoksa küçük resim/önizleme
 *                 üretilmez ve alan `null` kalır (SESSİZ değil — çağıran görür).
 *   `fs`,`path`,`crypto` — testte enjekte edilir.
 */
function createFeedbackBridge(deps = {}) {
  const fs = deps.fs || nodeFs;
  const path = deps.path || nodePath;
  const crypto = deps.crypto || nodeCrypto;
  const makeImage = typeof deps.makeImage === 'function' ? deps.makeImage : null;
  const logPath = typeof deps.logPath === 'function' ? deps.logPath : () => deps.logPath || null;
  const shotsDir = typeof deps.shotsDir === 'function' ? deps.shotsDir : () => deps.shotsDir || null;

  /**
   * Log'un son satırları, maskelenmiş.
   * @returns {{ok:boolean, text:string|null, lines:number, reason?:string}}
   */
  function logExcerpt({ lines = LOG_LINES } = {}) {
    const p = logPath();
    if (!p) return { ok: false, text: null, lines: 0, reason: 'no-log' };
    let raw;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch (err) {
      return { ok: false, text: null, lines: 0, reason: 'unreadable', detail: err && err.message };
    }
    const all = String(raw).split('\n');
    const n = Math.max(1, Math.min(2000, Number(lines) || LOG_LINES));
    const tail = all.slice(Math.max(0, all.length - n)).join('\n');
    let masked = foldRepeatedLines(maskLogText(tail).trim());
    if (masked.length > LOG_MAX_CHARS) {
      masked = `…(kırpıldı)\n${masked.slice(masked.length - LOG_MAX_CHARS + 16)}`;
    }
    return { ok: true, text: masked, lines: Math.min(n, all.length) };
  }

  /** Klasör dışına çıkamayan ad çözümü. Geçersizse null. */
  function resolveShot(name) {
    const dir = shotsDir();
    if (!dir) return null;
    const clean = path.basename(String(name == null ? '' : name));
    if (!clean || clean === '.' || clean === '..' || clean.includes('\0')) return null;
    if (!IMAGE_EXT.has(path.extname(clean).toLowerCase())) return null;
    const abs = path.join(dir, clean);
    // `basename` zaten çıkışı keser; bu ikinci kontrol sembolik-bağ/sürpriz
    // birleştirmelere karşı ucuz bir sigorta.
    if (path.dirname(path.resolve(abs)) !== path.resolve(dir)) return null;
    return abs;
  }

  /**
   * Son çekimler — en yeniden eskiye.
   * @returns {{ok:boolean, shots:Array<{name:string,at:number,thumbDataUrl:string|null}>, reason?:string}}
   */
  function recentShots({ limit = SHOT_LIMIT } = {}) {
    const dir = shotsDir();
    if (!dir) return { ok: false, shots: [], reason: 'no-dir' };
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      // AgentShot kurulu değil → ÖZELLİK KAPANIR, hata değil (sürükle-bırak kalır).
      return { ok: false, shots: [], reason: 'no-dir' };
    }
    const n = Math.max(1, Math.min(24, Number(limit) || SHOT_LIMIT));
    const rows = [];
    for (const name of names) {
      if (!IMAGE_EXT.has(path.extname(name).toLowerCase())) continue;
      const abs = path.join(dir, name);
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (!st.isFile || !st.isFile()) continue;
      rows.push({ name, at: Number(st.mtimeMs) || 0, bytes: st.size });
    }
    rows.sort((a, b) => b.at - a.at);
    const top = rows.slice(0, n);
    for (const r of top) {
      r.thumbDataUrl = null;
      if (!makeImage) continue;
      try {
        const buf = fs.readFileSync(path.join(dir, r.name));
        const img = makeImage(buf, { width: 160, quality: 60 });
        if (img && typeof img.dataUrl === 'string') r.thumbDataUrl = img.dataUrl;
      } catch {
        /* tek çekimin küçük resmi üretilemedi → listede resimsiz durur */
      }
    }
    return { ok: true, shots: top };
  }

  /**
   * Seçilen çekimin KAYDA GİRECEK hâli: okunabilir genişlikte JPEG data-URI.
   *
   * Neden bayt yüklemiyoruz: yeni bir depolama servisi (Storage bucket + kota +
   * temizlik politikası) açmak bu görevin kapsamı değil. Satırın içinde taşınan
   * ~1000px'lik bir kare, Eren'in "ne görmüş" sorusunu cevaplamaya yeter ve
   * kullanıcının diskinde ayrıca durur.
   */
  function shotPreview({ name, path: dropPath, width = 1000, quality = 62 } = {}) {
    // İKİ GİRİŞ, TEK ÇIKIŞ:
    //   • `name`  → AgentShot klasöründen seçim (klasör dışına çıkamaz, §resolveShot).
    //   • `path`  → KULLANICININ SÜRÜKLEDİĞİ dosya. Bu bir dosya oracle'ı DEĞİL:
    //     yol renderer'ın uydurduğu bir şey değil, kullanıcının native drop'undan
    //     gelir (ADP-143 fileDropApi) — `attachment:ingest`in bugün zaten kabul
    //     ettiği güven modelinin aynısı. Yine de görsel uzantı + bayt tavanı
    //     zorlanır ve dosya OKUNUR, listelenmez (dizin gezilemez).
    let abs = null;
    if (typeof dropPath === 'string' && dropPath) {
      const clean = String(dropPath);
      if (clean.includes('\0') || !path.isAbsolute(clean)) return { ok: false, reason: 'bad-name' };
      if (!IMAGE_EXT.has(path.extname(clean).toLowerCase())) return { ok: false, reason: 'not-an-image' };
      let st;
      try {
        st = fs.statSync(clean);
      } catch (err) {
        return { ok: false, reason: 'unreadable', detail: err && err.message };
      }
      if (!st.isFile || !st.isFile()) return { ok: false, reason: 'not-an-image' };
      if (st.size > DROP_MAX_BYTES) return { ok: false, reason: 'too-large' };
      abs = clean;
    } else {
      abs = resolveShot(name);
    }
    if (!abs) return { ok: false, reason: 'bad-name' };
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch (err) {
      return { ok: false, reason: 'unreadable', detail: err && err.message };
    }
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    if (!makeImage) return { ok: false, reason: 'no-image-api', sha256 };
    let img;
    try {
      img = makeImage(buf, { width, quality });
    } catch (err) {
      return { ok: false, reason: 'encode-failed', detail: err && err.message, sha256 };
    }
    if (!img || typeof img.dataUrl !== 'string' || !img.dataUrl) {
      return { ok: false, reason: 'encode-failed', sha256 };
    }
    if (img.dataUrl.length > SHOT_MAX_CHARS) {
      // Sınırı aşan kare SESSİZCE kırpılmaz — DB CHECK'i zaten reddederdi ve
      // kullanıcı sebebini göremezdi. Daha dar bir kareyle bir kez daha denenir.
      let narrow = null;
      try {
        narrow = makeImage(buf, { width: 640, quality: 55 });
      } catch {
        narrow = null;
      }
      if (!narrow || typeof narrow.dataUrl !== 'string' || narrow.dataUrl.length > SHOT_MAX_CHARS) {
        return { ok: false, reason: 'too-large', sha256 };
      }
      img = narrow;
    }
    return {
      ok: true,
      name: path.basename(abs),
      dataUrl: img.dataUrl,
      sha256,
      width: img.width ?? null,
      height: img.height ?? null,
    };
  }

  return { logExcerpt, recentShots, shotPreview, resolveShot };
}

module.exports = {
  createFeedbackBridge,
  maskLogText,
  foldRepeatedLines,
  FOLD_MIN_RUN,
  PATTERN_MAX_ENTRIES,
  LOG_LINES,
  LOG_MAX_CHARS,
  SHOT_LIMIT,
  SHOT_MAX_CHARS,
  DROP_MAX_BYTES,
};
