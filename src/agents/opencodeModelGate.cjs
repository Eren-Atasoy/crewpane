// ENG-OPENCODE-PROVIDER-01 — MODEL ÖN-DOĞRULAMA KAPISI (OC-DESIGN-0919 §5(f)-F1,
// §6-B kapı 1, §11 karar 1).
//
// NEDEN (ÖLÇÜLDÜ, RESEARCH-OC-01 §2.7 `07-model-fallback.txt`): `-m opencode/bu-model-yok`
// verildiğinde opencode TUI'de "Model … is not valid" yazıp turu makinede GİRİŞ
// YAPILMIŞ ilk bulut sağlayıcıya (ölçümde Eren'in OpenAI hesabı, ~8k jeton) SESSİZCE
// gönderdi. "Kod dışarı çıkmasın" diye yerel model seçen müşteri için bu bir gizlilik
// ihlalidir — en pahalı arıza sınıfı. Motor bunu kendisi kapatmıyor; ürün spawn'dan
// ÖNCE kapatır.
//
// ÜÇ KAPI, TEK HÜKÜM (`evaluate`, saf):
//   1. LİSTE — ajan modeli (`provider/model`) `opencode models` çıktısında satır olarak
//      VAR MI? Yoksa spawn YOK + pane'e dürüst satır (`not-listed`).
//   2. ADRES POLİTİKASI (Eren kararı 1, 19.09) — modelin sağlayıcısı kullanıcının
//      opencode.json'unda özel bir `baseURL` taşıyorsa: https serbest; http YALNIZ
//      loopback'te koşulsuz; özel IP aralıkları (10/8, 172.16/12, 192.168/16, `.local`)
//      YALNIZ onay bayrağıyla (`engines.opencode.lanHttpAck: true` — kafe Wi-Fi'da kod
//      düz metin gider, kullanıcı bunu BİLEREK kabul eder); internet adresinde http
//      SERT RET (bayrak açmaz).
//   3. ERİŞİLEBİLİRLİK — uç 3 sn içinde HERHANGİ bir HTTP cevabı vermiyorsa spawn YOK
//      (`unreachable`). ÖLÇÜLDÜ (§2.6 B/C kolları): bağlantı yok / 5xx'te motor stdout'a
//      HİÇBİR ŞEY yazmadan ≥45 sn sessizce yeniden dener; pane "çalışıyor" görünür. Bu
//      kapı o sessiz retry'ın yerine geçen DUVAR SAATİ zaman aşımıdır — tek istek,
//      tek zaman aşımı, sonuç kullanıcıya SÖYLENİR.
//
// FAIL-OPEN NEREDE (ADR §5(f)-F1): liste ÖLÇÜLEMİYORSA (ikili yok, zaman aşımı, exit≠0)
// spawn engellenmez ama `reason:'unmeasured'` + log — "motor kurulu ama koşmuyor" arızası
// doğurmamak için. Fail-CLOSED nerede: liste ölçüldü ve model YOK; adres politikası
// reddetti; uç cevap vermedi. Sessiz olan hiçbir dal yok.
//
// TEK KAYNAK (§4-1): motor adına göre `if` YOK. Kapı yalnız descriptor'ı `modelGate`
// beyan eden motorda koşar; komut/argüman/zaman aşımı/ayar anahtarı oradan okunur.
//
// SIR HİJYENİ: `opencode debug config` çıktısı `apiKey` DAHİL gelir. Buradan yalnız
// `provider.<id>.options.baseURL` okunur; çözülmüş belge ne hükme ne banner'a ne log'a
// girer (test: SIR HİJYENİ).
//
// ÜRÜN KULLANICI DOSYASINA YAZMAZ (§4-6): bu modül yalnız OKUR ve motora sorar.
//
// Windows/Linux: mac'te ölçüldü. `bin` çağırandan gelir (`engineInstall.resolveBinary`,
// ADP-833 `installed:null` → bin null → `unmeasured` fail-open + log). win32'de `.cmd`
// sarmalayıcısı `execArgs` ile açılır (main'in spawn hattıyla aynı kural) — ölçülmedi.

'use strict';

const { spawnSync, spawn } = require('node:child_process');
const http = require('node:http');
const https = require('node:https');
const binResolve = require('../../platform/binResolve.cjs');

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CACHE_MS = 60_000;
const DEFAULT_PROBE_TIMEOUT_MS = 3000;
/** Probe cevabından okunan en fazla bayt — gövde zaten kullanılmaz, yalnız "cevap geldi" ölçülür. */
const PROBE_MAX_BYTES = 64 * 1024;
/** Liste komutunun stdout tavanı (model listesi birkaç KB'dır; şişkin çıktı = bozuk ölçüm). */
const LIST_MAX_BYTES = 512 * 1024;

const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '[::1]', '::1']);
/** Karar 1'in ÖZEL aralıkları — bunlar dışında kalan her http adresi "internet" sayılır. */
const PRIVATE_V4 = Object.freeze([
  { base: [10, 0, 0, 0], bits: 8 },
  { base: [172, 16, 0, 0], bits: 12 },
  { base: [192, 168, 0, 0], bits: 16 },
]);

// ─── Saf yardımcılar ──────────────────────────────────────────────────────────

/** `opencode models` çıktısı → `provider/model` satırları (uyarı/boş satırlar düşer). */
function parseModelList(stdout) {
  if (typeof stdout !== 'string') return [];
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(l));
}

/** Tam eşleşme — motor da tam ad ister; büyük/küçük harf ve kısmi ad KABUL EDİLMEZ. */
function modelAvailable(list, id) {
  if (!Array.isArray(list) || typeof id !== 'string' || !id) return false;
  return list.includes(id);
}

/** `opencode debug config` çıktısı → nesne (bozuk / nesne-olmayan → null). */
function parseResolvedConfig(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) return null;
  try {
    const v = JSON.parse(stdout);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** Sağlayıcının özel adresi (`provider.<id>.options.baseURL`) — yoksa null. Başka HİÇBİR alan okunmaz. */
function providerBaseUrl(config, providerId) {
  if (!config || typeof config !== 'object' || typeof providerId !== 'string' || !providerId) return null;
  const p = config.provider && typeof config.provider === 'object' ? config.provider[providerId] : null;
  const url = p && p.options && typeof p.options === 'object' ? p.options.baseURL : null;
  return typeof url === 'string' && url.trim() ? url.trim() : null;
}

function parseV4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n >= 0 && n <= 255) ? o : null;
}

function inV4Range(octets, range) {
  const ip = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const base = ((range.base[0] << 24) | (range.base[1] << 16) | (range.base[2] << 8) | range.base[3]) >>> 0;
  const mask = range.bits === 0 ? 0 : (0xffffffff << (32 - range.bits)) >>> 0;
  return (ip & mask) === (base & mask);
}

/**
 * Konak sınıfı — WHATWG `URL` ile NORMALİZE edilmiş hostname üstünde (`2130706433`,
 * `0300.0250.1.1` gibi gösterimler ayrıştırıcıda çözülür; ham dizgeye bakan bir
 * sınıflandırıcı kaçış yolu bırakırdı).
 * @returns {'loopback'|'private'|'public'}
 */
function classifyHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (LOOPBACK_HOSTS.includes(h)) return 'loopback';
  const v4 = parseV4(h);
  if (v4) {
    if (v4[0] === 127) return 'loopback';
    return PRIVATE_V4.some((r) => inV4Range(v4, r)) ? 'private' : 'public';
  }
  if (h.endsWith('.local')) return 'private';
  return 'public';
}

/**
 * Karar 1 — adres politikası.
 * @returns {{ok:true, kind:'https'|'loopback'|'lan', host:string}|{ok:false, reason:'invalid-url'|'lan-http-needs-ack'|'internet-http', host?:string}}
 */
function httpPolicy(raw, o = {}) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return { ok: false, reason: 'invalid-url' };
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: 'invalid-url' };
  // Kimlik bilgisi URL'de → motorun argv/log'una ve `ps` çıktısına düşer (customProvider kuralı).
  if (u.username || u.password) return { ok: false, reason: 'invalid-url' };
  const host = u.hostname.toLowerCase();
  if (u.protocol === 'https:') return { ok: true, kind: 'https', host };
  const cls = classifyHost(host);
  if (cls === 'loopback') return { ok: true, kind: 'loopback', host };
  if (cls === 'private') {
    return o.lanHttpAck === true ? { ok: true, kind: 'lan', host } : { ok: false, reason: 'lan-http-needs-ack', host };
  }
  return { ok: false, reason: 'internet-http', host };
}

/** Kimlik bilgisi/sorgu taşımayan, banner'a basılabilir adres. */
function displayUrl(raw) {
  try {
    const u = new URL(String(raw));
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return '(geçersiz adres)';
  }
}

// ─── Ölçüm: liste + config (senkron/asenkron) ────────────────────────────────

function createCache() {
  return new Map();
}
const sharedCache = createCache();

/** Config'i etkileyen ortam anahtarları — önbellek parmak izi (pane belgesi HARİÇ, aşağıda açıklanır). */
// 🪤 ÖLÇÜLDÜ (06-model-gate-real-binary ilk koşum): `opencode models` OPENCODE_DB'yi AÇAR —
// dizini yoksa "Error: Unexpected error / unable to open database file" + exit 1 → kapı
// `unmeasured` (fail-open + log). Liste DB'den DEĞİL config'ten gelir, bu yüzden DB yolu
// önbellek anahtarında YOK (IPC ön-uçuşu varsayılan DB ile, spawnPty pane DB'siyle koşsa
// da aynı liste). Pane DB dizinini `applyPaneIsolationEnv` spawn'dan önce mkdir eder.
const CONFIG_ENV_KEYS = Object.freeze(['HOME', 'XDG_CONFIG_HOME', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'USERPROFILE']);

function probeEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (typeof v === 'string') out[k] = v;
  }
  // 🔑 PANE BELGESİ ÇIKARILIR: ürün belgesi (`OPENCODE_CONFIG_CONTENT`) `mcp` bloğu taşır —
  // liste komutu o belgeyle koşarsa köprü MCP sunucularını doğurabilir (yan etki).
  // Çıkarmak hükmü DEĞİŞTİRMEZ: §6-C negatif kapısı ürün belgesinin provider/model/
  // disabled_providers/agent taşımadığını her PR'da kanıtlar → sağlayıcı listesi
  // belgeden bağımsızdır. Kullanıcının kendi config yolu (XDG/OPENCODE_CONFIG*) KORUNUR.
  delete out.OPENCODE_CONFIG_CONTENT;
  out.OPENCODE_DISABLE_AUTOUPDATE = '1';
  return out;
}

function cacheKey(bin, env, cwd, argv) {
  const fp = CONFIG_ENV_KEYS.map((k) => `${k}=${env && env[k] ? env[k] : ''}`).join('|');
  return `${bin}\u0000${cwd || ''}\u0000${argv.join(' ')}\u0000${fp}`;
}

/** Varsayılan SENKRON çalıştırıcı — win32 `.cmd` sarmalayıcısı main'in spawn hattıyla aynı kuralla açılır. */
function defaultExecSync(file, argv, o) {
  const target = binResolve.execArgs(file, argv);
  const r = spawnSync(target.file, target.argv, {
    cwd: o.cwd,
    env: o.env,
    // stdin KAPALI: ÖLÇÜLDÜ (04-concurrency-stdin-trap.txt) — açık PIPE'ta opencode hiç başlamıyor.
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: o.timeoutMs,
    maxBuffer: LIST_MAX_BYTES,
    encoding: 'utf8',
    windowsHide: true,
    windowsVerbatimArguments: target.windowsVerbatimArguments === true,
  });
  const timedOut = !!(r.error && (r.error.code === 'ETIMEDOUT' || r.signal === 'SIGTERM'));
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error || null, timedOut };
}

/** Varsayılan ASENKRON çalıştırıcı — aynı sözleşme, main sürecini bloklamaz. */
function defaultExecAsync(file, argv, o) {
  return new Promise((resolve) => {
    let child;
    try {
      const target = binResolve.execArgs(file, argv);
      child = spawn(target.file, target.argv, {
        cwd: o.cwd,
        env: o.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: target.windowsVerbatimArguments === true,
      });
    } catch (error) {
      resolve({ status: null, stdout: '', stderr: '', error, timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let done = false;
    const finish = (status, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr, error: error || null, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* zaten ölmüş */ }
      finish(null, null);
    }, o.timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.stdout.on('data', (d) => { if (stdout.length < LIST_MAX_BYTES) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < LIST_MAX_BYTES) stderr += d; });
    child.on('error', (e) => finish(null, e));
    child.on('close', (code) => finish(code, null));
  });
}

function runResultToList(r, detailPrefix) {
  if (!r) return { ok: false, reason: 'unmeasured', detail: `${detailPrefix}: no-result` };
  if (r.timedOut) return { ok: false, reason: 'unmeasured', detail: `${detailPrefix}: timeout` };
  if (r.error) return { ok: false, reason: 'unmeasured', detail: `${detailPrefix}: ${r.error.code || r.error.message || 'error'}` };
  if (r.status !== 0) return { ok: false, reason: 'unmeasured', detail: `${detailPrefix}: exit-${r.status}` };
  const models = parseModelList(r.stdout);
  if (!models.length) return { ok: false, reason: 'unmeasured', detail: `${detailPrefix}: empty-list` };
  return { ok: true, models };
}

function gateSpec(descriptor) {
  const g = descriptor && descriptor.modelGate;
  if (!g || typeof g !== 'object' || !Array.isArray(g.listArgs)) return null;
  return {
    listArgs: g.listArgs,
    configArgs: Array.isArray(g.configArgs) ? g.configArgs : null,
    timeoutMs: typeof g.timeoutMs === 'number' ? g.timeoutMs : DEFAULT_TIMEOUT_MS,
    cacheMs: typeof g.cacheMs === 'number' ? g.cacheMs : DEFAULT_CACHE_MS,
    probeTimeoutMs: typeof g.probeTimeoutMs === 'number' ? g.probeTimeoutMs : DEFAULT_PROBE_TIMEOUT_MS,
    lanHttpAckSetting: typeof g.lanHttpAckSetting === 'string' ? g.lanHttpAckSetting : null,
    guide: typeof g.guide === 'string' ? g.guide : null,
  };
}

function cachedRun(o, argv, run) {
  const spec = gateSpec(o.descriptor);
  if (!spec) return { ok: false, reason: 'unmeasured', detail: 'descriptor: no modelGate' };
  if (!o.bin || typeof o.bin !== 'string') return { ok: false, reason: 'unmeasured', detail: `${argv.join(' ')}: binary-missing` };
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const cache = o.cache || sharedCache;
  const key = cacheKey(o.bin, o.env, o.cwd, argv);
  const hit = cache.get(key);
  if (hit && now() - hit.at < spec.cacheMs) return hit.value;
  const env = probeEnv(o.env);
  const opts = { cwd: o.cwd, env, timeoutMs: spec.timeoutMs };
  const store = (value) => {
    // Yalnız ÖLÇÜLEN sonuç önbelleğe girer: zaman aşımı/hata bir sonraki spawn'da yeniden denenir.
    if (value && value.ok) cache.set(key, { at: now(), value });
    return value;
  };
  return run(o.bin, argv, opts, store);
}

/** SENKRON liste — `{ok:true, models[]}` | `{ok:false, reason:'unmeasured', detail}`; 60 sn önbellek. */
function listModels(o = {}) {
  const spec = gateSpec(o.descriptor);
  const exec = typeof o.exec === 'function' ? o.exec : defaultExecSync;
  return cachedRun(o, spec ? spec.listArgs : [], (bin, argv, opts, store) => store(runResultToList(exec(bin, argv, opts), argv.join(' '))));
}

/** ASENKRON liste — aynı sözleşme; IPC yolunda main'i bloklamadan ön-ısıtır. */
async function listModelsAsync(o = {}) {
  const spec = gateSpec(o.descriptor);
  const exec = typeof o.execAsync === 'function' ? o.execAsync : defaultExecAsync;
  return cachedRun(o, spec ? spec.listArgs : [], async (bin, argv, opts, store) => store(runResultToList(await exec(bin, argv, opts), argv.join(' '))));
}

function runResultToConfig(r) {
  if (!r || r.timedOut || r.error || r.status !== 0) return { ok: false, config: null };
  const config = parseResolvedConfig(r.stdout);
  return config ? { ok: true, config } : { ok: false, config: null };
}

/** SENKRON çözülmüş config (yalnız sağlayıcı adresi için okunur; sır hükme girmez). */
function resolvedConfig(o = {}) {
  const spec = gateSpec(o.descriptor);
  if (!spec || !spec.configArgs) return { ok: false, config: null };
  const exec = typeof o.exec === 'function' ? o.exec : defaultExecSync;
  return cachedRun(o, spec.configArgs, (bin, argv, opts, store) => store(runResultToConfig(exec(bin, argv, opts))));
}

async function resolvedConfigAsync(o = {}) {
  const spec = gateSpec(o.descriptor);
  if (!spec || !spec.configArgs) return { ok: false, config: null };
  const exec = typeof o.execAsync === 'function' ? o.execAsync : defaultExecAsync;
  return cachedRun(o, spec.configArgs, async (bin, argv, opts, store) => store(runResultToConfig(await exec(bin, argv, opts))));
}

// ─── Erişilebilirlik probu (yalnız asenkron yol) ─────────────────────────────

/**
 * Tek GET `<baseURL>/models`, zaman aşımı, yönlendirme YOK, gövde ≤64 KB, Authorization
 * YOK (anahtar bu koddan geçmez). HERHANGİ bir HTTP cevabı (401/404 dahil) = erişilebilir;
 * yalnız bağlantı hatası / zaman aşımı / TLS hatası = erişilemez.
 * Hedef KULLANICININ KENDİ config dosyasındaki adrestir (renderer'dan gelmez) ve motor
 * zaten oraya anahtarla bağlanacaktır — SSRF sınıfı yüzey açılmaz (customProvider notu).
 */
function defaultProbe(url, o = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let u;
    try {
      u = new URL(url);
      u.pathname = `${u.pathname.replace(/\/+$/, '')}/models`;
      u.search = '';
      u.hash = '';
      u.username = '';
      u.password = '';
    } catch {
      resolve({ ok: false, error: 'invalid-url', ms: 0 });
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve({ ...v, ms: Date.now() - t0 }); } };
    let req;
    try {
      req = mod.request(u, { method: 'GET', timeout: o.timeoutMs || DEFAULT_PROBE_TIMEOUT_MS, headers: { accept: 'application/json' } }, (res) => {
        // Cevap BAŞLIĞI geldi = uç canlı. Gövde OKUNMAZ (en fazla PROBE_MAX_BYTES'a kadar
        // akıp kesilir): sonsuz akış yapan bir uç bu isteği açık tutamaz.
        let n = 0;
        res.on('data', (d) => { n += d.length; if (n > PROBE_MAX_BYTES) req.destroy(); });
        res.on('error', () => {});
        finish({ ok: true, status: res.statusCode });
        setTimeout(() => { try { req.destroy(); } catch { /* kapanmış */ } }, 200).unref();
      });
    } catch (e) {
      finish({ ok: false, error: (e && e.code) || 'request-failed' });
      return;
    }
    req.on('timeout', () => { req.destroy(new Error('timeout')); finish({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => finish({ ok: false, error: (e && e.code) || (e && e.message) || 'error' }));
    req.end();
  });
}

// ─── Hüküm (saf) ─────────────────────────────────────────────────────────────

const ESC = '\u001b';
const warn = (s) => `${ESC}[33m${s}${ESC}[0m`;
const cyan = (s) => `${ESC}[36m${s}${ESC}[0m`;
const dim = (s) => `${ESC}[2m${s}${ESC}[0m`;

/** Kapı KAPALIYKEN pane'e basılan iki dilli metin (winShellPrereq.missingShellBanner kalıbı). */
function blockedBanner(v, o = {}) {
  const t = typeof o.t === 'function' ? o.t : () => '';
  const first = o.locale === 'en' ? 'en' : 'tr';
  const second = first === 'tr' ? 'en' : 'tr';
  const label = o.label || 'OpenCode';
  const params = {
    model: v.model,
    label,
    host: v.host || '',
    url: v.url || '',
    error: v.detail || '',
    timeout: String(Math.round((v.probeTimeoutMs || DEFAULT_PROBE_TIMEOUT_MS) / 1000)),
    setting: v.lanHttpAckSetting || '',
  };
  const bodyKey = {
    'not-listed': 'main.pane.modelGate.notListed',
    'internet-http': 'main.pane.modelGate.internetHttp',
    'lan-http-needs-ack': 'main.pane.modelGate.lanHttpNeedsAck',
    'unreachable': 'main.pane.modelGate.unreachable',
    'invalid-url': 'main.pane.modelGate.invalidUrl',
  }[v.reason] || 'main.pane.modelGate.notListed';
  const block = (loc) => [
    warn(`⚠  ${t('main.pane.modelGate.title', params, loc)}`),
    '',
    t(bodyKey, params, loc),
    '',
    `    ${cyan(t('main.pane.modelGate.guide', { guide: v.guide || '' }, loc))}`,
    '',
    dim(t('main.pane.modelGate.after', params, loc)),
  ];
  return ['', ...block(first), '', dim('────────'), '', ...block(second), ''].join('\r\n') + '\r\n';
}

/**
 * SAF HÜKÜM. Girdiler ölçümdür (liste/config/probe), çıktı karardır.
 * @param {{descriptor:object, model:string|null, list?:object, config?:object|null,
 *   probe?:{ok:boolean,status?:number,error?:string,ms:number}|null, lanHttpAck?:boolean,
 *   t?:Function, locale?:string, label?:string}} o
 * @returns {{blocked:boolean, reason:string, model:string|null, detail?:string, banner?:string|null,
 *   providerId?:string|null, url?:string|null, host?:string|null, policy?:object|null, probe?:string}}
 */
function evaluate(o = {}) {
  const spec = gateSpec(o.descriptor);
  const model = typeof o.model === 'string' && o.model.trim() ? o.model.trim() : null;
  if (!model) return { blocked: false, reason: 'no-model', model: null, banner: null };
  if (!spec) return { blocked: false, reason: 'not-gated', model, banner: null };
  const stamp = { cwd: typeof o.cwd === 'string' ? o.cwd : null };
  const list = o.list;
  const common = { model, lanHttpAckSetting: spec.lanHttpAckSetting, guide: spec.guide, probeTimeoutMs: spec.probeTimeoutMs };
  if (!list || !list.ok) {
    return { blocked: false, reason: 'unmeasured', model, ...stamp, detail: (list && list.detail) || 'list: no-result', banner: null };
  }
  if (!modelAvailable(list.models, model)) {
    const v = { blocked: true, reason: 'not-listed', ...common, ...stamp, detail: `${list.models.length} satır, '${model}' yok` };
    v.banner = blockedBanner(v, o);
    return v;
  }
  const providerId = model.split('/')[0] || null;
  const url = providerBaseUrl(o.config || null, providerId);
  if (!url) {
    // Özel adres yok (satıcı sağlayıcısı ya da config okunamadı) → politika/probe uygulanmaz.
    return { blocked: false, reason: 'listed', model, ...stamp, providerId, url: null, policy: null, probe: 'n/a', banner: null };
  }
  const policy = httpPolicy(url, { lanHttpAck: o.lanHttpAck === true });
  const shown = displayUrl(url);
  if (!policy.ok) {
    const v = { blocked: true, reason: policy.reason, ...common, ...stamp, providerId, url: shown, host: policy.host || null, policy, detail: policy.reason };
    v.banner = blockedBanner(v, o);
    return v;
  }
  const probe = o.probe;
  if (probe && probe.ok === false) {
    const v = { blocked: true, reason: 'unreachable', ...common, ...stamp, providerId, url: shown, host: policy.host, policy, detail: String(probe.error || 'no-response'), probe: 'unreachable' };
    v.banner = blockedBanner(v, o);
    return v;
  }
  return {
    blocked: false,
    reason: 'listed',
    model,
    ...stamp,
    providerId,
    url: shown,
    host: policy.host,
    policy,
    probe: probe && probe.ok ? `http-${probe.status}` : 'unmeasured',
    banner: null,
  };
}

/** `a.b.c` yol okuması (engineBilling.pickSetting ikizi — throw ETMEZ). */
function pickSetting(obj, dotted) {
  if (!obj || typeof obj !== 'object' || typeof dotted !== 'string' || !dotted) return undefined;
  let cur = obj;
  for (const seg of dotted.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

function lanAckOf(descriptor, settings) {
  const spec = gateSpec(descriptor);
  return !!(spec && spec.lanHttpAckSetting && pickSetting(settings, spec.lanHttpAckSetting) === true);
}

/**
 * SENKRON hüküm — spawnPty içinden (holder-pane kalıbı). Liste + config senkron ölçülür
 * (önbellek sıcaksa sıfır maliyet), erişilebilirlik probu BU YOLDA ATLANIR (`probe:'unmeasured'`,
 * log söyler) — senkron yol yalnız restore/respawn gibi daha önce doğrulanmış pane'lerde koşar;
 * kullanıcı/delegasyon spawn'ı IPC'de `preflight` ile gelir.
 */
function verdictSync(o = {}) {
  const spec = gateSpec(o.descriptor);
  const model = typeof o.model === 'string' && o.model.trim() ? o.model.trim() : null;
  if (!model || !spec) return evaluate({ descriptor: o.descriptor, model });
  const list = listModels(o);
  const cfg = list.ok ? resolvedConfig(o) : { ok: false, config: null };
  return evaluate({ ...o, model, list, config: cfg.config, lanHttpAck: lanAckOf(o.descriptor, o.settings), probe: null });
}

/** ASENKRON ön-uçuş — IPC yolunda; liste + config + erişilebilirlik probu (`o.probeFn` enjekte edilebilir). Sonuç `evaluate` hükmüdür. */
async function preflight(o = {}) {
  const spec = gateSpec(o.descriptor);
  const model = typeof o.model === 'string' && o.model.trim() ? o.model.trim() : null;
  if (!model || !spec) return evaluate({ descriptor: o.descriptor, model });
  const list = await listModelsAsync(o);
  const cfg = list.ok ? await resolvedConfigAsync(o) : { ok: false, config: null };
  const lanHttpAck = lanAckOf(o.descriptor, o.settings);
  // Probe yalnız politika GEÇTİYSE atılır (reddedilen adrese istek bile gitmez).
  let probe = null;
  const pre = evaluate({ ...o, model, list, config: cfg.config, lanHttpAck, probe: null });
  if (!pre.blocked && pre.url) {
    const doProbe = typeof o.probeFn === 'function' ? o.probeFn : defaultProbe;
    try {
      probe = await doProbe(providerBaseUrl(cfg.config, pre.providerId), { timeoutMs: spec.probeTimeoutMs });
    } catch (e) {
      probe = { ok: false, error: (e && e.code) || (e && e.message) || 'probe-failed', ms: 0 };
    }
  }
  return evaluate({ ...o, model, list, config: cfg.config, lanHttpAck, probe });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_CACHE_MS,
  DEFAULT_PROBE_TIMEOUT_MS,
  LOOPBACK_HOSTS,
  parseModelList,
  modelAvailable,
  parseResolvedConfig,
  providerBaseUrl,
  classifyHost,
  httpPolicy,
  displayUrl,
  createCache,
  listModels,
  listModelsAsync,
  resolvedConfig,
  resolvedConfigAsync,
  defaultProbe,
  evaluate,
  blockedBanner,
  verdictSync,
  preflight,
};
