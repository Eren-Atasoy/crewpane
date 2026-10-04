// CrewPane — ADP-900 (SPRINT-MEMORY-SEARCH) ONAYLI GÖMME MOTORU KURULUMU.
//
// NEDEN VAR: ADP-870/871/872 hibrit aramayı kurdu ama ANLAM yarısı hiçbir müşteri
// makinesinde koşmuyordu — gömme motoru pakete girmiyor, tek indirme yolu bir
// geliştirici betiğiydi (`scripts/fetch-embed-model.mjs`). Eren'in kararı: model
// OTOMATİK İNMEZ; kullanıcıya NE KADAR VERİ ineceği gösterilir ve ONAY alınır
// (interneti sınırlı/pahalı kullanıcılar var).
//
// ÜÇ SÖZLEŞME — üçü de bu modülün var olma sebebi:
//
//  1. ONAYSIZ TEK BAYT İNMEZ. `start()` açık bir onay damgası olmadan HİÇBİR ağ
//     gövdesi indirmez (`consent_required`). Damga MODELE + BOYUTA bağlıdır
//     (`consentMatches`): kullanıcı "bge-m3 · 559 MB" için onay verdi, gelecekte
//     başka/daha büyük bir model gelirse o onay GEÇERSİZDİR ve yeniden sorulur.
//     (Aynı ders: shared/policy-stamp-outlives-module — damganın SAHİBİ olur.)
//
//  2. BOYUT KODA YAZILMAZ, ÖLÇÜLÜR. `probePlan()` her dosyanın boyutunu sunucunun
//     kendi başlığından okur (HEAD → content-length / x-linked-size). Model dosyası
//     değişirse ekrandaki sayı kendiliğinden doğrulanır. Sunucuya ulaşılamazsa
//     SAYI UYDURULMAZ — `ok:false` + dürüst sebep döner.
//     🪤 HEAD İSTEĞİ GÖVDESİZDİR: boyut sormak "indirme" değildir; diske hiçbir şey
//     yazılmaz. Kanıt yüzeyi = onay reddedildikten sonra model dizini 0 bayt.
//
//  3. YARIM İŞ SESSİZCE "KURULU" SAYILMAZ. Her dosya `.part` olarak iner, boyutu
//     doğrulanır, sonra yerine konur. İptal `.part`i BIRAKIR → sonraki deneme
//     HTTP Range ile KALDIĞI YERDEN devam eder.
//
// İKİ PARÇA İNER ve boyutları AYRI ÖLÇÜLÜR (kullanıcı ikisini de görmeli):
//   • MODEL ağırlıkları  → huggingface.co, HEAD ile TAM ölçülür.
//   • ÇALIŞMA ZAMANI     → npm (`@huggingface/transformers` + onnxruntime). Boyutu
//     npm kayıt defterinin `dist.unpackedSize` alanından toplanır — YAKLAŞIKTIR
//     (bağımlılık ağacı kurulumda çözülür) ve `approx:true` ile öyle raporlanır.
//     Zaten çözülebiliyorsa (kaynaktan koşan geliştirici, önceki kurulum) 0 bayt.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const embedder = require('./memoryEmbedder.cjs');
const { resolveBinaryState, execArgs } = require('../../platform/binResolve.cjs');
const { withAugmentedPath } = require('../../platform/envPath.cjs');

/** Model deposunun sürümü — ADP-870'te ölçülen kopya. */
const REVISION = 'main';

/**
 * q8 yolu için GEREKEN dosyalar (fp32'nin 2.1 GB'lık `model.onnx_data`'sı ALINMAZ).
 * TEK KAYNAK: `scripts/fetch-embed-model.mjs` de bu listeyi buradan okur — iki liste
 * olsaydı biri güncellenip diğeri unutulur ve "kurulu" bayrağı yalan söylerdi.
 */
const MODEL_FILES = Object.freeze([
  { rel: 'config.json' },
  { rel: 'tokenizer.json' },
  { rel: 'tokenizer_config.json' },
  { rel: 'onnx/model_quantized.onnx', minBytes: 500 * 1024 * 1024 },
]);

/** npm'den kurulacak çalışma zamanı — sürüm ADP-869 ölçümünün koştuğu sürüm. */
const RUNTIME_PKG = embedder.RUNTIME_PKG;
const RUNTIME_VERSION = '3.8.1';
/**
 * Boyut toplamına giren doğrudan bağımlılıklar. Derinlik 2'de durulur: asıl kütle
 * bunlarda (onnxruntime-node ~208 MB, onnxruntime-web ~89 MB), alt bağımlılıkları
 * birkaç MB. Bu yüzden sonuç `approx:true`.
 */
const RUNTIME_DEPS = Object.freeze(['onnxruntime-node', 'onnxruntime-web', 'sharp', '@huggingface/jinja']);

/**
 * ÇALIŞMA BELLEĞİ — ÖLÇÜLDÜ, tahmin değil: ADP-869 bench'inde bge-m3/q8 çıkarımı
 * ~1,6 GB yerleşik bellekle koştu (indeksleme tepe 2,5 GB, docs/agent-results/
 * ADP-870-*). İNDİRME boyutunun aksine bu değer indirmeden ÖNCE ölçülemez — o yüzden
 * sabittir ve kullanıcıya "ölçülen değer" olarak sunulur. Model değişirse bu sayı da
 * yeniden ölçülmelidir (MODEL_ID ile birlikte durur).
 */
const EXPECTED_RSS_MB = 1600;

const HF_HOST = 'huggingface.co';
const NPM_REGISTRY = 'https://registry.npmjs.org';

/**
 * Model ağırlıklarının indirileceği kök (cihaz-paylaşımlı: instance'lar TEK kopya
 * kullanır — 560 MB iki kez inmesin).
 *
 * `CREWPANE_EMBED_MODELS_DIR` verilmişse ORASI kullanılır. Bu, okuma tarafının
 * (memoryEmbedder.resolveModelsDir) zaten tanıdığı AYNI değişkendir: yazan ve okuyan
 * ayrı yerlere bakarsa "indirdim ama bulunamıyor" sınıfı bir hata doğar. Ayrıca e2e'nin
 * gerçek indirmeyi kullanıcının evine dokunmadan koşturmasını sağlar.
 */
function installRoot(homedir = os.homedir(), env = process.env) {
  const explicit = env && env.CREWPANE_EMBED_MODELS_DIR;
  return explicit ? String(explicit) : embedder.sharedEmbedDir(homedir);
}

/** `<kök>/Xenova/bge-m3/<rel>` */
function modelFileDest(root, rel) {
  return path.join(root, ...embedder.MODEL_ID.split('/'), ...rel.split('/'));
}

function modelFileUrl(rel) {
  return `https://${HF_HOST}/${embedder.MODEL_ID}/resolve/${REVISION}/${rel}`;
}

/** Çalışma zamanının npm ile kurulacağı dizin (memoryEmbedder.runtimeCandidates ile aynı yer). */
function runtimeDir(homedir = os.homedir(), env = process.env) {
  return path.join(installRoot(homedir, env), 'runtime');
}

/** Bir dizinin toplam boyutu (bayt). Okunamayan girdi yok sayılır. Saf-ish. */
function dirSize(dir, { statImpl = fs.statSync, readdirImpl = fs.readdirSync } = {}) {
  let total = 0;
  const walk = (d) => {
    let ents = [];
    try {
      ents = readdirImpl(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          total += statImpl(p).size;
        } catch {
          /* yarışta silinmiş */
        }
      }
    }
  };
  walk(dir);
  return total;
}

// ── HATA-15 — npm ÇAĞRISI: ÇÖZ, SAR, SINIFLANDIR ───────────────────────────
//
// KAPATILAN SINIF (müşteri, Windows, 08.09): ürün "İndirme tamamlanamadı
// (spawn npm ENOENT). Bağlantını kontrol edip tekrar dene" diyordu. İKİ yalan:
//
//  1. `execFile('npm', …)` KABUKSUZ çağrılıyordu. Windows'ta npm başlatıcısı
//     `npm.cmd`'dir — batch dosyası, CreateProcess onu doğrudan çalıştıramaz,
//     üstelik çıplak `npm` adı PATHEXT genişletmesi olmadan zaten bulunamaz.
//     Dönen hata tam olarak `spawn npm ENOENT`'tir. Ürün bu tuzağı ZATEN
//     biliyordu (`binResolve.execArgs`, ADP-893) — burada YENİ sarmalayıcı
//     yazılmaz, o çağrılır.
//  2. Metin "bağlantını kontrol et" diyordu. Bağlantı gayet iyiydi; npm yoktu.
//     Yanlış teşhis → yanlış tavsiye → müşteri saatlerce modem yeniden başlatır.
//
// ⚠️ İKİNCİ (SESSİZ) YARISI macOS'TA DA CANLIYDI: Dock'tan açılan paketli app
// launchd'nin çıplak PATH'ini (`/usr/bin:/bin:/usr/sbin:/sbin`) miras alır
// (ENG-ACC-P0 §2.2) — Homebrew/nvm ile kurulu `npm` orada YOKTUR. `withAugmentedPath`
// tam olarak bunun için var; kurulum yolu onu hiç çağırmıyordu.

/** npm bulunamadığında kullanılan sebep — arayüz bunun için AYRI metin gösterir. */
const REASON_MISSING_RUNTIME = 'missing_runtime';

/**
 * npm kurulumunun ÇALIŞTIRILABİLİR biçimi: çözülmüş ikili + platforma göre
 * sarılmış argv + zenginleştirilmiş env. SAF — hiçbir şey çalıştırmaz.
 *
 * → { ok:true,  file, argv, env, windowsVerbatimArguments?, resolved }
 * → { ok:false, reason:'missing_runtime', env, resolved }   (npm ÖLÇÜLDÜ, yok)
 *
 * `unknown` (ÖLÇEMEDİM: PATH yok, beklenmedik fs hatası) "yok" SAYILMAZ — çıplak
 * ad ile denenir. Ölçemediğimiz için kullanıcıya "Node kurulu değil" demek,
 * düzelttiğimiz yalanın aynısını ters yönde söylemek olurdu (ADR-W7).
 *
 * @param {string[]} args npm argümanları (`install …`)
 * @param {{env?:object, platform?:string, fs?:object}} deps enjekte edilebilir — win32 dalı macOS'ta koşturulur
 */
function npmInstallCommand(args, deps = {}) {
  const platform = deps.platform || process.platform;
  const baseEnv = deps.env || process.env;
  // Hem ARAMAYA hem ÇALIŞTIRMAYA uygulanır: yalnız birini düzeltmek yalanın
  // yarısını bırakır (ENG-ACC-P1 ile aynı ders).
  const env = withAugmentedPath(baseEnv, { platform });
  const resolved = resolveBinaryState('npm', env, { platform, fs: deps.fs });
  if (resolved.state === 'absent') return { ok: false, reason: REASON_MISSING_RUNTIME, env, resolved };
  const target = resolved.state === 'present' ? resolved.path : 'npm';
  const wrapped = execArgs(target, args, { platform, env });
  return {
    ok: true,
    file: wrapped.file,
    argv: wrapped.argv,
    env,
    resolved,
    // ADP-893 (a): sarmalayıcı bunu döndürdüyse çağıran GEÇİRMEK ZORUNDA.
    ...(wrapped.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  };
}

/** Ağ katmanının "ulaşamadım" dediği errno'lar (npm da bunları `code` ile yazar). */
const NETWORK_CODES = Object.freeze([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EPROTO', 'ERR_SOCKET_TIMEOUT',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED',
]);
const DISK_CODES = Object.freeze(['ENOSPC', 'EDQUOT', 'EFBIG', 'EROFS']);
const PERM_CODES = Object.freeze(['EACCES', 'EPERM']);

/**
 * npm hatasını SINIFLANDIR — "hepsi ağdır" varsayımının yerine geçer. SAF.
 *
 * İki ayrı kaynak okunur ve karıştırılmaz:
 *   • `err.code` DİZEYSE bu bir SPAWN errno'sudur (süreç hiç doğmadı).
 *     `err.code` SAYIYSA npm koştu ve sıfırdan farklı çıktı — o zaman sebep
 *     `err.message`e iliştirilmiş npm stderr'ındadır (`npm ERR! code XXX`).
 *   • Metinden okunan ENOENT "npm yok" DEMEK DEĞİLDİR (npm kendi eksik dosyası
 *     için de ENOENT yazar) — `missing_runtime` YALNIZ spawn katmanından gelir.
 *
 * → 'missing_runtime' | 'runtime_network_failed' | 'runtime_disk_full'
 *   | 'runtime_permission_denied' | 'runtime_install_failed'
 */
function classifyRuntimeError(err) {
  const spawnCode = err && typeof err.code === 'string' ? err.code.toUpperCase() : null;
  const text = String((err && err.message) || err || '');
  // Süreç DOĞMADI + ENOENT ⇒ çalıştırılacak program yok. Tek `missing_runtime` yolu.
  if (spawnCode === 'ENOENT' || /\bspawn\b[^\n]*\bENOENT\b/i.test(text)) return REASON_MISSING_RUNTIME;

  const codes = new Set();
  if (spawnCode) codes.add(spawnCode);
  // npm stderr deyimi: `npm ERR! code ENOTFOUND` / `npm ERR! errno EACCES`
  for (const m of text.matchAll(/\b(?:code|errno)\s+([A-Z][A-Z0-9_]{2,})\b/g)) codes.add(m[1]);

  const has = (list) => list.some((c) => codes.has(c));
  if (has(DISK_CODES) || /no space left on device/i.test(text)) return 'runtime_disk_full';
  if (has(PERM_CODES) || /permission denied|EACCES/i.test(text)) return 'runtime_permission_denied';
  if (has(NETWORK_CODES) || /\bnetwork\b|request to .* failed|getaddrinfo/i.test(text)) return 'runtime_network_failed';
  return 'runtime_install_failed';
}

/**
 * classifyRuntimeError'ın dönebileceği sebeplerin TAMAMI — arayüz sözleşmesi.
 *
 * Bu liste yalnız belge değil KAPIDIR: renderer tarafındaki metin tablosu
 * (src/app/lib/semanticFailure.ts) buna karşı ölçülür. Buraya yeni bir sebep
 * eklenip arayüze karşılığı yazılmazsa `semanticFailure.test.mts` KIRILIR —
 * yani yeni bir sebep sessizce "bağlantını kontrol et" metnine düşemez.
 */
const RUNTIME_ERROR_REASONS = Object.freeze([
  REASON_MISSING_RUNTIME,
  'runtime_network_failed',
  'runtime_disk_full',
  'runtime_permission_denied',
  'runtime_install_failed',
]);

/**
 * NET-01 — `err.message` tek başına "fetch failed" der, asıl neden `err.cause`
 * (undici'nin AggregateError'ı: ETIMEDOUT/EHOSTUNREACH + hangi adrese) YUTULUR ve
 * kullanıcı internete bağlıyken "internete bağlandığında tekrar dene" görür. Saf
 * fonksiyon: err'i mutasyona uğratmaz, `message` + varsa cause'un kod(lar)ını ve
 * ilk 2-3 FARKLI `kod adres` çiftini tek satırda birleştirir.
 */
function describeFetchError(err) {
  const base = String((err && err.message) || err || 'unknown error');
  const cause = err && err.cause;
  if (!cause) return base;
  const parts = [];
  const seen = new Set();
  const push = (code, address) => {
    if (!code) return;
    const label = address ? `${code} ${address}` : code;
    if (seen.has(label)) return;
    seen.add(label);
    parts.push(label);
  };
  const errs = Array.isArray(cause.errors) ? cause.errors : null;
  if (errs && errs.length) {
    for (const e of errs) {
      if (parts.length >= 3) break;
      push(e && e.code, e && e.address);
    }
  } else if (cause.code) {
    push(cause.code, cause.address);
  } else if (cause.message) {
    parts.push(String(cause.message));
  }
  return parts.length ? `${base} — ${parts.join(', ')}` : base;
}

/** Dosya boyutu ya da 0 (yoksa). */
function sizeOf(file, statImpl = fs.statSync) {
  try {
    return statImpl(file).size;
  } catch {
    return 0;
  }
}

/**
 * Uzak dosya boyutunu SUNUCUDAN sor. Gövde İNDİRİLMEZ (HEAD).
 * HF, LFS dosyalarında 302 döndürür; `fetch` yönlendirmeyi izler ve
 * `content-length` CDN'den gelir. Yönlendirme izlenemezse `x-linked-size` yedeği var.
 * @returns {Promise<number>} bayt (bilinemezse 0)
 */
async function remoteSize(url, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: 'HEAD', signal: ctl.signal });
    if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : '?'}`);
    const linked = Number(res.headers.get('x-linked-size') || 0);
    const len = Number(res.headers.get('content-length') || 0);
    return linked > 0 ? linked : len;
  } finally {
    clearTimeout(t);
  }
}

/**
 * MODEL PLANI — her dosya için: sunucudaki boyut, diskteki tam/yarım boyut.
 * @returns {Promise<{ok:boolean, files:Array, totalBytes:number, remainingBytes:number,
 *                    complete:boolean, reason?:string, message?:string}>}
 */
async function probeModel({ homedir = os.homedir(), env = process.env, fetchImpl = fetch, statImpl = fs.statSync, timeoutMs = 15000 } = {}) {
  const root = installRoot(homedir, env);
  const files = [];
  let total = 0;
  let remaining = 0;
  for (const f of MODEL_FILES) {
    const dest = modelFileDest(root, f.rel);
    const localBytes = sizeOf(dest, statImpl);
    const partBytes = sizeOf(`${dest}.part`, statImpl);
    let bytes = 0;
    try {
      bytes = await remoteSize(modelFileUrl(f.rel), { fetchImpl, timeoutMs });
    } catch (err) {
      // SAYI UYDURMA: tek dosya bile ölçülemediyse toplam yalan olur.
      return {
        ok: false,
        reason: 'probe_failed',
        message: describeFetchError(err),
        files,
        totalBytes: 0,
        remainingBytes: 0,
        complete: false,
      };
    }
    const complete = bytes > 0 && localBytes >= bytes;
    files.push({ rel: f.rel, bytes, localBytes, partBytes, complete });
    total += bytes;
    if (!complete) remaining += Math.max(0, bytes - partBytes);
  }
  return { ok: true, files, totalBytes: total, remainingBytes: remaining, complete: remaining === 0 && total > 0 };
}

/** npm kayıt defterinden bir paketin açılmış boyutu (bayt). Bilinemezse 0. */
async function registrySize(spec, { fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${NPM_REGISTRY}/${spec}`, { signal: ctl.signal });
    if (!res || !res.ok) return 0;
    const json = await res.json();
    return Number(json?.dist?.unpackedSize || 0);
  } catch {
    return 0;
  } finally {
    clearTimeout(t);
  }
}

/**
 * ÇALIŞMA ZAMANI PLANI. Zaten çözülebiliyorsa 0 bayt (dev ağacı ya da önceki kurulum).
 * Değilse boyut npm kayıt defterinden TOPLANIR → `approx:true` (ağaç kurulumda çözülür).
 */
async function probeRuntime({ homedir = os.homedir(), repoRoot = null, env = process.env, fetchImpl = fetch, resolveImpl = null } = {}) {
  const r = embedder.resolveRuntime({ env, homedir, repoRoot, resolveImpl });
  if (r.ok) return { ok: true, installed: true, bytes: 0, approx: false, dir: r.dir, packages: [] };
  const specs = [`${RUNTIME_PKG}/${RUNTIME_VERSION}`, ...RUNTIME_DEPS.map((d) => `${d}/latest`)];
  const sizes = await Promise.all(specs.map((s) => registrySize(s, { fetchImpl })));
  const packages = specs.map((s, i) => ({ spec: s, bytes: sizes[i] }));
  const bytes = sizes.reduce((a, b) => a + b, 0);
  return {
    ok: bytes > 0,
    installed: false,
    bytes,
    approx: true,
    dir: runtimeDir(homedir, env),
    packages,
    ...(bytes > 0 ? {} : { reason: 'registry_unreachable' }),
  };
}

/**
 * KULLANICIYA GÖSTERİLEN PLAN. Onay kartındaki HER SAYI buradan gelir.
 * @returns {Promise<{ok, model, runtime, totalBytes, remainingBytes, ramMb, ready, consentKey, reason?}>}
 */
async function probePlan(opts = {}) {
  const model = await probeModel(opts);
  const runtime = await probeRuntime(opts);
  const ok = model.ok; // model ölçülemediyse plan gösterilemez
  const totalBytes = (model.totalBytes || 0) + (runtime.bytes || 0);
  const remainingBytes = (model.remainingBytes || 0) + (runtime.installed ? 0 : runtime.bytes || 0);
  return {
    ok,
    reason: ok ? undefined : model.reason,
    message: ok ? undefined : model.message,
    model: { id: embedder.MODEL_ID, dtype: embedder.DTYPE, host: HF_HOST, ...model },
    runtime,
    totalBytes,
    remainingBytes,
    ramMb: EXPECTED_RSS_MB,
    // "Kurulu" = model TAM + çalışma zamanı ÇÖZÜLEBİLİR. İkisinden biri eksikse
    // katman koşmaz; UI'da yarım kurulumu "hazır" göstermek yalan olurdu.
    ready: Boolean(model.complete && runtime.installed),
    consentKey: consentKeyOf({ totalBytes }),
  };
}

/**
 * ONAY DAMGASI. Modele + ölçülen boyuta bağlıdır: model ya da boyut değişirse eski
 * onay geçersizdir ve kullanıcıya YENİDEN sorulur (kimse 559 MB'a onay verip 2 GB
 * indirmemeli). Boyut 5 MB'lık kovalara yuvarlanır — sunucudaki bir baytlık fark
 * onayı düşürmesin.
 */
function consentKeyOf({ totalBytes = 0 } = {}) {
  const bucket = Math.round(Number(totalBytes || 0) / (5 * 1024 * 1024));
  return `${embedder.MODEL_ID}@${embedder.DTYPE}#${bucket}`;
}

/** Kayıtlı onay bu plana geçerli mi? */
function consentMatches(consent, plan) {
  if (!consent || typeof consent !== 'object') return false;
  if (consent.granted !== true) return false;
  return String(consent.key || '') === String(plan?.consentKey || '');
}

/** İnsan okunur boyut. Saf — UI ve CLI aynı biçimi kullansın diye burada. */
function humanBytes(bytes) {
  const n = Number(bytes || 0);
  if (n <= 0) return '0 MB';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  const mb = n / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

/**
 * KURULUM YÖNETİCİSİ (main tarafı). Tekil: aynı anda tek kurulum.
 *
 * @param {object} o
 * @param {(e:object)=>void} [o.onEvent] her ilerleme adımında çağrılır (main → renderer)
 * @param {Function} [o.fetchImpl] test dikişi
 * @param {Function} [o.execFileImpl] test dikişi — imza `child_process.execFile`in AYNISI:
 *        (file, args, opts, cb) → child. (HATA-15'ten önce `npmImpl` idi ve komutun
 *        DOSYASINI hiç görmüyordu; Windows'ta kırılan tam olarak o parçaydı.)
 * @param {string} [o.platform] win32 dalı macOS'ta koşturulabilsin diye AÇIK geçilir
 */
function createInstaller({
  homedir = os.homedir(),
  repoRoot = null,
  env = process.env,
  platform = process.platform,
  onEvent = () => {},
  logLine = () => {},
  fetchImpl = null,
  execFileImpl = null,
  planImpl = null,
} = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  let running = false;
  let controller = null;
  let npmChild = null;
  let state = {
    phase: 'idle', // idle|probing|runtime|downloading|verifying|done|error|cancelled
    file: null,
    receivedBytes: 0,
    totalBytes: 0,
    startedAt: null,
    finishedAt: null,
    reason: null,
    message: null,
  };

  function publish(patch) {
    state = { ...state, ...patch };
    try {
      onEvent({ ...state });
    } catch (err) {
      logLine(`memoryEmbedInstall onEvent failed: ${err.message}`);
    }
  }

  function status() {
    return { ...state, running };
  }

  /** npm ile çalışma zamanını kur. İlerleme: dizin boyutu / beklenen boyut. */
  function installRuntime({ expectedBytes }) {
    const dir = runtimeDir(homedir, env);
    fs.mkdirSync(dir, { recursive: true });
    const pkg = path.join(dir, 'package.json');
    if (!fs.existsSync(pkg)) {
      fs.writeFileSync(pkg, JSON.stringify({ name: 'crewpane-embed-runtime', private: true, version: '1.0.0' }, null, 2));
    }
    return new Promise((resolve) => {
      const args = ['install', '--no-audit', '--no-fund', `${RUNTIME_PKG}@${RUNTIME_VERSION}`];
      const cmd = npmInstallCommand(args, { env, platform });
      // npm ÖLÇÜLDÜ ve YOK → tek bayt indirmeye kalkmadan dürüst sebep. Buraya
      // gelmeden önce hiçbir süreç doğmaz; kullanıcı "bağlantını kontrol et"
      // yerine "Node.js kurulu değil" metnini görür (HATA-15).
      if (!cmd.ok) {
        return resolve({ ok: false, reason: cmd.reason, message: null });
      }
      const spawnNpm = execFileImpl || execFile;
      let settled = false;
      const finish = (out) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        npmChild = null;
        resolve(out);
      };
      const opts = {
        cwd: dir,
        env: cmd.env,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        ...(cmd.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      };
      npmChild = spawnNpm(cmd.file, cmd.argv, opts, (err) => {
        if (err) {
          // İptal edilmişse bu bir hata değil — çağıran zaten cancelled yazacak.
          if (state.phase === 'cancelled') {
            finish({ ok: false, reason: 'cancelled', message: err.message });
            return;
          }
          // "Hepsi ağdır" varsayımı BURADA ölüyor (HATA-15).
          finish({ ok: false, reason: classifyRuntimeError(err), message: err.message });
          return;
        }
        finish({ ok: true });
      });
      // GERÇEK ilerleme: npm kendi yüzdesini vermez, ama dizin BÜYÜR.
      const poll = setInterval(() => {
        const got = dirSize(dir);
        publish({ phase: 'runtime', file: RUNTIME_PKG, receivedBytes: got, totalBytes: Math.max(expectedBytes || 0, got) });
      }, 1500);
      poll.unref?.();
    });
  }

  /**
   * Tek dosyayı indir — YARIM KALANI SÜRDÜREREK.
   * @returns {Promise<{ok:boolean, reason?:string, message?:string}>}
   */
  async function downloadFile({ rel, bytes, minBytes, baseReceived, planTotal }) {
    const dest = modelFileDest(installRoot(homedir, env), rel);
    const part = `${dest}.part`;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const have = sizeOf(dest);
    if (bytes > 0 && have >= bytes) return { ok: true, skipped: true };

    let from = sizeOf(part);
    // Yarım dosya sunucudakinden BÜYÜKSE (model değişmiş) baştan al.
    if (bytes > 0 && from >= bytes) {
      try {
        fs.rmSync(part, { force: true });
      } catch {
        /* yok say */
      }
      from = 0;
    }

    const headers = from > 0 ? { Range: `bytes=${from}-` } : {};
    const res = await doFetch(modelFileUrl(rel), { headers, signal: controller.signal });
    if (!res || !(res.status === 200 || res.status === 206)) {
      return { ok: false, reason: 'http_error', message: `HTTP ${res ? res.status : '?'} (${rel})` };
    }
    // Sunucu Range'i yok saydıysa (200) baştan yazmalıyız, yoksa dosya bozulur.
    const append = res.status === 206 && from > 0;
    if (!append) from = 0;

    const out = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
    let got = from;
    try {
      for await (const chunk of res.body) {
        if (!out.write(Buffer.from(chunk))) {
          await new Promise((r) => out.once('drain', r));
        }
        got += chunk.length;
        publish({
          phase: 'downloading',
          file: rel,
          receivedBytes: baseReceived + got,
          totalBytes: planTotal,
        });
      }
    } catch (err) {
      out.destroy();
      const aborted = err && (err.name === 'AbortError' || String(err.message).includes('aborted'));
      // İPTALDE `.part` KALIR — sonraki deneme kaldığı yerden sürer.
      return { ok: false, reason: aborted ? 'cancelled' : 'stream_error', message: String((err && err.message) || err) };
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));

    const finalSize = sizeOf(part);
    // Taban ÖNCE ölçülen boyuttan gelir: sunucu bize dosyanın tam boyunu söyledi,
    // sabit `minBytes` yalnız ölçüm alınamadığında kullanılan kaba emniyettir.
    const floor = bytes > 0 ? bytes : minBytes || 0;
    if (floor && finalSize < floor) {
      // Yarım dosya "kurulu" SAYILMAZ; ama silmiyoruz — sürdürülebilir.
      return { ok: false, reason: 'short_file', message: `${rel}: ${finalSize} < ${floor}` };
    }
    fs.renameSync(part, dest);
    return { ok: true, bytes: finalSize };
  }

  /**
   * KURULUMU BAŞLAT. `consent.granted !== true` ya da damga plana uymuyorsa
   * TEK BAYT İNMEZ.
   */
  async function start({ consent } = {}) {
    if (running) return { ok: false, reason: 'already_running' };
    running = true;
    controller = new AbortController();
    publish({ phase: 'probing', reason: null, message: null, file: null, receivedBytes: 0, totalBytes: 0, startedAt: Date.now(), finishedAt: null });
    try {
      const plan = planImpl ? await planImpl() : await probePlan({ homedir, repoRoot, env, fetchImpl: doFetch });
      if (!plan.ok) {
        publish({ phase: 'error', reason: plan.reason || 'probe_failed', message: plan.message || null, finishedAt: Date.now() });
        return { ok: false, reason: plan.reason || 'probe_failed', message: plan.message };
      }
      // ── ONAY KAPISI ──────────────────────────────────────────────────────
      if (!consentMatches(consent, plan)) {
        publish({ phase: 'error', reason: 'consent_required', message: null, finishedAt: Date.now() });
        return { ok: false, reason: 'consent_required', plan };
      }

      const planTotal = plan.remainingBytes || plan.totalBytes;
      // 1) Çalışma zamanı (varsa atlanır).
      if (!plan.runtime.installed) {
        publish({ phase: 'runtime', file: RUNTIME_PKG, receivedBytes: 0, totalBytes: plan.runtime.bytes || 0 });
        const rt = await installRuntime({ expectedBytes: plan.runtime.bytes || 0 });
        if (!rt.ok) {
          publish({ phase: rt.reason === 'cancelled' ? 'cancelled' : 'error', reason: rt.reason, message: rt.message || null, finishedAt: Date.now() });
          return rt;
        }
      }

      // 2) Model dosyaları.
      let base = 0;
      for (const f of plan.model.files) {
        if (controller.signal.aborted) {
          publish({ phase: 'cancelled', reason: 'cancelled', finishedAt: Date.now() });
          return { ok: false, reason: 'cancelled' };
        }
        const spec = MODEL_FILES.find((m) => m.rel === f.rel) || {};
        publish({ phase: 'downloading', file: f.rel, receivedBytes: base, totalBytes: planTotal });
        const r = await downloadFile({ rel: f.rel, bytes: f.bytes, minBytes: spec.minBytes, baseReceived: base, planTotal });
        if (!r.ok) {
          publish({ phase: r.reason === 'cancelled' ? 'cancelled' : 'error', reason: r.reason, message: r.message || null, finishedAt: Date.now() });
          return r;
        }
        base += r.skipped ? 0 : Math.max(0, f.bytes - f.partBytes);
      }

      // 3) DOĞRULA — "indi" demek yetmez, motor GERÇEKTEN çözülebiliyor mu.
      publish({ phase: 'verifying', file: null });
      const avail = embedder.availability({ env, homedir, repoRoot });
      if (!avail.ok) {
        publish({ phase: 'error', reason: avail.reason, message: null, finishedAt: Date.now() });
        return { ok: false, reason: avail.reason };
      }
      publish({ phase: 'done', file: null, receivedBytes: planTotal, totalBytes: planTotal, finishedAt: Date.now(), reason: null });
      return { ok: true, modelsDir: avail.modelsDir, runtimeDir: avail.runtimeDir };
    } catch (err) {
      const aborted = err && err.name === 'AbortError';
      const message = aborted ? String((err && err.message) || err) : describeFetchError(err);
      publish({ phase: aborted ? 'cancelled' : 'error', reason: aborted ? 'cancelled' : 'install_failed', message, finishedAt: Date.now() });
      return { ok: false, reason: aborted ? 'cancelled' : 'install_failed', message };
    } finally {
      running = false;
      controller = null;
    }
  }

  /** İptal. `.part` dosyaları KALIR — sonraki `start()` kaldığı yerden sürer. */
  function cancel() {
    if (!running) return { ok: false, reason: 'not_running' };
    publish({ phase: 'cancelled', reason: 'cancelled' });
    try {
      controller?.abort();
    } catch {
      /* zaten kapandı */
    }
    try {
      npmChild?.kill?.('SIGTERM');
    } catch {
      /* zaten öldü */
    }
    return { ok: true };
  }

  /**
   * KALDIR — kullanıcı katmanı kapatınca YERİ GERİ KAZANIR. Ne silinir: model
   * ağırlıkları, yarım `.part`ler ve npm ile KURULMUŞ çalışma zamanı. Dev ağacındaki
   * (repo) çalışma zamanına DOKUNULMAZ — o bizim kurmadığımız bir şey.
   * @returns {{ok:boolean, freedBytes:number}}
   */
  function remove({ includeRuntime = true } = {}) {
    if (running) return { ok: false, reason: 'already_running' };
    const root = installRoot(homedir, env);
    const modelDir = path.join(root, ...embedder.MODEL_ID.split('/'));
    const rtDir = runtimeDir(homedir, env);
    let freed = 0;
    for (const dir of includeRuntime ? [modelDir, rtDir] : [modelDir]) {
      const before = dirSize(dir);
      if (!before) continue;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        freed += before;
      } catch (err) {
        logLine(`memoryEmbedInstall: silinemedi ${dir}: ${err.message}`);
      }
    }
    publish({ phase: 'idle', file: null, receivedBytes: 0, totalBytes: 0, reason: null, message: null });
    return { ok: true, freedBytes: freed };
  }

  return { start, cancel, remove, status, installRoot: () => installRoot(homedir, env) };
}

module.exports = {
  MODEL_FILES,
  REVISION,
  RUNTIME_PKG,
  RUNTIME_VERSION,
  RUNTIME_DEPS,
  EXPECTED_RSS_MB,
  HF_HOST,
  installRoot,
  runtimeDir,
  modelFileDest,
  modelFileUrl,
  dirSize,
  describeFetchError,
  npmInstallCommand,
  classifyRuntimeError,
  REASON_MISSING_RUNTIME,
  RUNTIME_ERROR_REASONS,
  remoteSize,
  registrySize,
  probeModel,
  probeRuntime,
  probePlan,
  consentKeyOf,
  consentMatches,
  humanBytes,
  createInstaller,
};
