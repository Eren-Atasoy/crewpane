// PROV-01 — Groq /responses SANITIZING shim (codex-cli 0.147+).
//
// WHY THIS EXISTS (ÖLÇÜLDÜ, tahmin değil — 2026-08-18, codex-cli 0.147.0):
// providers.cjs'in ADP-580 notu "Groq native Responses konuşur ⇒ needsShim:false,
// DOĞRUDAN çalışır" diyordu ve bu codex 0.144'te DOĞRUYDU. codex 0.147 ile ARTIK
// DEĞİL: codex'in /responses gövdesi Groq'un kabul ettiği şemadan BEŞ noktada sapıyor
// ve Groq 400 veriyor. Yakalanan gerçek gövde ile alan-alan daraltıldı:
//
//   alan/öge                              Groq'un cevabı
//   ------------------------------------  ------------------------------------------
//   reasoning.summary = "auto"            400 "Field 'reasoning.summary' is not supported"
//   include = ["reasoning.encrypted_…"]   400 "Field 'include' is not supported"
//   client_metadata = {...}               400 "unknown field `client_metadata` …"
//   tools[] type="namespace"              400 "invalid JSON body"   ← ŞEFFAF DEĞİL
//   tools[] type="web_search"             400 "invalid JSON body"   ← ŞEFFAF DEĞİL
//
// 🪤 TUZAK: bilinmeyen bir TOOL TİPİ Groq'ta alan adı vermeyen jenerik "invalid JSON
// body" üretir. Yani hata metni tek başına teşhis ETTİRMEZ; gövdeyi toplu silerek
// değil, EKLEYEREK (additive bisect) daraltmak gerekti.
//
// codex'in kendi ayarları bu farkı KAPATMAYA YETMEZ (ölçüldü):
//   -c model_reasoning_summary="none"  → reasoning.summary DÜŞER  ✅
//   -c features.multi_agent=false      → "namespace" tool'u DÜŞER ✅
//   -c tools.web_search=false          → ETKİSİZ, web_search tool KALIR ❌
//   `include` ve `client_metadata` için knob YOK                    ❌
// ⇒ konfigürasyonla değil, TEL ÜSTÜNDE temizlemekle çözülür. Bu dosya odur.
//
// KAPSAM: bu bir PROTOKOL ÇEVİRİSİ DEĞİL (adapter.cjs'in DeepSeek/Kimi için yaptığı
// Responses→ChatCompletions işi ondan ayrıdır ve burada YAPILMAZ). Burada yapılan tek
// şey Responses gövdesini Groq'un kabul ettiği alt kümeye KISMAK ve upstream'e aynen
// iletmek — akış (SSE) dahil gövde bit-bit geri verilir.
//
// GÜVENLİK: anahtar bu süreçte SAKLANMAZ. codex `Authorization` başlığını kendisi
// yollar (env_key=GROQ_API_KEY), shim başlıkları olduğu gibi geçirir ve HİÇBİR
// başlığı/gövdeyi loglamaz.

'use strict';

const net = require('node:net');
const http = require('node:http');
const https = require('node:https');

const UPSTREAM_HOST = 'api.groq.com';
const UPSTREAM_PROTOCOL = 'https:';

/** codex'in gönderdiği, Groq'un TANIMADIĞI üst-düzey alanlar. */
const UNSUPPORTED_FIELDS = Object.freeze(['client_metadata', 'include']);

/** Groq'un /responses ucunda kabul ettiği tek tool tipi (ölçüldü). */
const SUPPORTED_TOOL_TYPES = Object.freeze(['function']);

// KOTA: bu anahtarın katmanında TPM = 8000 (ölçüldü: x-ratelimit-limit-tokens).
// codex'in TEK bir turu ~6.8k girdi tokeni harcıyor ⇒ ajan döngüsünün İKİNCİ isteği
// aynı dakika içinde neredeyse KESİN 429 alır. codex'in kendi yeniden-denemesi kısa
// aralıklı olduğu için "exceeded retry limit" ile düşüyordu. Groq 429'da pencerenin
// ne zaman sıfırlanacağını SÖYLÜYOR (`x-ratelimit-reset-tokens: 41.22s`); shim o
// süreyi bekleyip isteği aynen tekrarlar. Gövde zaten tamponlandığı için tekrar
// güvenli; HİÇBİR başlık yazılmadan önce yapılır (yanıt akışı bozulmaz).
const RETRY_STATUS = 429;
const MAX_RETRIES = 3;
const MAX_WAIT_MS = 90_000;

// 🪤 ÖLÜM SARMALI (ölçüldü): tepkisel yeniden-deneme TEK BAŞINA YETMEZ. Ajan döngüsünün
// ikinci turu 429 alır, codex akışı kopar ve YENİDEN BAĞLANIR — her yeniden bağlanma
// aynı ~6.8k'lık gövdeyi tekrar yollar, pencereyi bir daha doldurur ve süreç ilerlemeden
// döner durur (gözlendi: "Reconnecting 1/10" + shim'de 11s→29s→50s büyüyen bekleme).
// Çözüm İSTEKTEN ÖNCE beklemektir: Groq her cevapta kalan token bütçesini söylüyor
// (`x-ratelimit-remaining-tokens`). Kalan, bu isteğin tahmini maliyetinden azsa pencere
// sıfırlanana kadar HİÇ göndermeden bekleriz — böylece 429 hiç doğmaz, akış hiç kopmaz.
// Tahmin kabası: 4 karakter ≈ 1 token (gövde JSON'u üzerinden). Fazla tahmin etmek
// güvenli yöndür (erken göndermektense biraz fazla beklemek).
const CHARS_PER_TOKEN = 4;

/**
 * Bir codex /responses gövdesini Groq'un kabul ettiği alt kümeye kısar. SAF fonksiyon
 * (girdi mutasyona uğramaz) — `node --test` doğrudan yükler.
 *
 * Kısma DAR tutulur: tanınmayanı düşürür, tanınanı ASLA yeniden yazmaz. `instructions`,
 * `input`, `tool_choice`, `parallel_tool_calls`, `store`, `stream`, `prompt_cache_key`
 * ve `reasoning.effort` gerçek koşuda 200 aldı (bkz. yukarıdaki ölçüm) ⇒ dokunulmaz.
 *
 * @param {any} body
 * @returns {{body:any, dropped:string[]}} temizlenmiş gövde + NE düşürüldüğü (teşhis
 *   için; çağıran bunu loglayabilir — değerler değil yalnız ALAN ADLARI).
 */
function sanitizeGroqResponsesBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { body, dropped: [] };
  const out = { ...body };
  const dropped = [];

  for (const f of UNSUPPORTED_FIELDS) {
    if (f in out) {
      delete out[f];
      dropped.push(f);
    }
  }

  // reasoning: `summary` desteklenmiyor; nesnenin kendisi (ör. {effort:…}) destekleniyor.
  if (out.reasoning && typeof out.reasoning === 'object' && !Array.isArray(out.reasoning)) {
    if ('summary' in out.reasoning) {
      out.reasoning = { ...out.reasoning };
      delete out.reasoning.summary;
      dropped.push('reasoning.summary');
    }
  }

  // tools: yalnız `function` tipini geçir. Boş kalırsa alanı TAMAMEN düşür — boş dizi
  // göndermek "araç yok" demenin garantili yolu değil, alanı hiç göndermemek öyle.
  if (Array.isArray(out.tools)) {
    const kept = out.tools.filter((t) => t && SUPPORTED_TOOL_TYPES.includes(t.type));
    if (kept.length !== out.tools.length) {
      for (const t of out.tools) {
        if (!kept.includes(t)) dropped.push(`tools[type=${(t && t.type) || 'null'}]`);
      }
    }
    if (kept.length) out.tools = kept;
    else delete out.tools;
  }

  return { body: out, dropped };
}

/**
 * Groq'un 429 başlıklarından beklenecek süreyi (ms) çıkar. Sıra: `retry-after`
 * (saniye) → `x-ratelimit-reset-tokens` (ör. "41.22s", "1m16.8s"). Okunamazsa null
 * döner ⇒ çağıran TEKRAR DENEMEZ (körlemesine beklemek 429'u gizlemekten kötüdür).
 *
 * 🪤 Gereken süre tavanı AŞARSA da null döner — tavana KISIP erken tekrar denemek
 * sessizce ikinci bir 429 üretir ve tek yeniden-deneme hakkını çöpe atardı.
 */
function capped(ms) {
  return ms > MAX_WAIT_MS ? null : ms;
}

function parseRetryAfterMs(headers) {
  const h = headers || {};
  const ra = h['retry-after'];
  if (ra && !Number.isNaN(Number(ra))) return capped(Number(ra) * 1000);
  const reset = h['x-ratelimit-reset-tokens'] || h['x-ratelimit-reset-requests'];
  if (typeof reset === 'string') {
    const m = reset.match(/(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?/);
    if (m && (m[1] || m[2])) {
      const ms = (Number(m[1] || 0) * 60 + Number(m[2] || 0)) * 1000;
      // +1sn pay: pencere tam sınırda hâlâ dolu olabilir.
      if (ms > 0) return capped(ms + 1000);
    }
  }
  return null;
}

/** Bind-then-close ile boş port seç (adapter.cjs ile aynı desen — yarış yok). */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const sock = net.createServer();
    sock.listen(0, '127.0.0.1', () => {
      const port = sock.address().port;
      sock.close(() => resolve(port));
    });
    sock.on('error', reject);
  });
}

/**
 * Yerel sanitize-eden geçiş sunucusu. codex buraya bağlanır, biz Groq'a iletiriz.
 *
 * @param {{port?:number, log?:(s:string)=>void, upstreamHost?:string,
 *           upstreamProtocol?:'https:'|'http:'}} [opts] — `upstreamProtocol` YALNIZ
 *   testte kullanılır (sahte upstream düz http konuşur); üretimde https sabittir.
 * @returns {Promise<{port:number, close:()=>Promise<void>}>}
 */
async function startGroqShim(opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  // Upstream'in son söylediği bütçe. `null` = daha hiç cevap görmedik ⇒ bekleme YOK
  // (ilk isteği kör beklemeyle geciktirmek kullanıcıyı boşuna bekletirdi).
  let budget = null; // {remaining:number, resetMs:number, at:number}
  const upstreamHost = opts.upstreamHost || UPSTREAM_HOST;
  const transport = (opts.upstreamProtocol || UPSTREAM_PROTOCOL) === 'http:' ? http : https;
  const port = opts.port || (await pickFreePort());

  /** Groq'un bütçe başlıklarını kaydet (her cevapta gelir). */
  const rememberBudget = (headers) => {
    const rem = Number(headers && headers['x-ratelimit-remaining-tokens']);
    const resetMs = parseRetryAfterMs(headers);
    if (!Number.isNaN(rem) && headers && headers['x-ratelimit-remaining-tokens'] !== undefined) {
      budget = { remaining: rem, resetMs: resetMs || 0, at: Date.now() };
    }
  };

  /** Bu gövdeyi göndermek için beklenmesi gereken süre (ms); 0 = hemen gönder. */
  const paceMs = (payloadLen) => {
    if (!budget) return 0;
    const need = Math.ceil(payloadLen / CHARS_PER_TOKEN);
    if (budget.remaining >= need) return 0;
    const elapsed = Date.now() - budget.at;
    const left = budget.resetMs - elapsed;
    return left > 0 ? Math.min(left + 1000, MAX_WAIT_MS) : 0;
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let payload = Buffer.concat(chunks);
      // Yalnız JSON gövdeli /responses çağrısını temizle; kalan her yol saf geçiştir
      // (ör. /models). Ayrıştırılamayan gövdeye DOKUNMA — upstream'in hatası bizim
      // uydurduğumuz hatadan daha doğrudur.
      if (payload.length) {
        try {
          const parsed = JSON.parse(payload.toString('utf8'));
          const { body: clean, dropped } = sanitizeGroqResponsesBody(parsed);
          if (dropped.length) log(`[groq-shim] düşürülen: ${dropped.join(', ')}`);
          payload = Buffer.from(JSON.stringify(clean), 'utf8');
        } catch {
          /* JSON değil → aynen geçir */
        }
      }
      const headers = { ...req.headers, host: upstreamHost };
      // Gövde uzunluğu DEĞİŞTİ; bayat content-length upstream'i kilitler.
      delete headers['content-length'];
      if (payload.length) headers['content-length'] = String(payload.length);
      delete headers['accept-encoding']; // gövdeyi bit-bit geri verebilmek için

      const wait = paceMs(payload.length);
      if (wait) {
        log(`[groq-shim] kota penceresi dolu — ${Math.round(wait / 1000)}sn beklenip gönderilecek`);
        await sleep(wait);
      }

      const forward = (attempt) => {
        const [hostOnly, hostPort] = upstreamHost.split(':');
        const up = transport.request(
          { host: hostOnly, port: hostPort || undefined, path: req.url, method: req.method, headers },
          (r) => {
            rememberBudget(r.headers);
            // KOTA yeniden-denemesi: yalnız 429'da, yalnız süre OKUNABİLİYORSA ve
            // yalnız daha hiçbir bayt yazılmamışken. Yanıt gövdesi tüketilmeli, yoksa
            // soket sızar.
            if (r.statusCode === RETRY_STATUS && attempt < MAX_RETRIES && !res.headersSent) {
              const waitMs = parseRetryAfterMs(r.headers);
              if (waitMs) {
                r.resume();
                log(`[groq-shim] 429 — ${Math.round(waitMs / 1000)}sn sonra tekrar (${attempt + 1}/${MAX_RETRIES})`);
                setTimeout(() => forward(attempt + 1), waitMs);
                return;
              }
            }
            res.writeHead(r.statusCode || 502, r.headers);
            r.pipe(res); // SSE dahil akış aynen geçer
          },
        );
        up.on('error', (e) => {
          log(`[groq-shim] upstream hatası: ${e.message}`);
          if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `groq-shim upstream: ${e.message}` } }));
        });
        up.end(payload);
      };
      forward(0);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

module.exports = {
  sanitizeGroqResponsesBody,
  parseRetryAfterMs,
  startGroqShim,
  pickFreePort,
  UNSUPPORTED_FIELDS,
  SUPPORTED_TOOL_TYPES,
};
