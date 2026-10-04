// CrewPane — ADP-870 (SPRINT-MEMORY-SEARCH · Faz 2) gömme motoru.
//
// MODEL: `Xenova/bge-m3`, dtype **q8**, pooling **cls**, normalize **true**, ön-ek YOK.
// Bu dörtlü ADP-869'da ÖLÇÜLEN kazanan yapılandırmanın BİREBİR aynısı
// (docs/research/rag-embed-bench/bench.mjs MODELS['bge-m3-q8']). Biri değişirse
// ölçülen %66.7 recall@5 rakamı bu boru hattı için GEÇERSİZDİR.
//
// ÇALIŞMA ZAMANI PAKETE GÖMÜLÜ DEĞİL — bilerek. `@huggingface/transformers` +
// `onnxruntime-node` platform başına derlenmiş ikili taşır (ölçüldü: darwin 65 MB,
// win32 67 MB, linux 76 MB) ve model ağırlığı 543 MB. İkisini de app.asar'a koymak
// dağıtım kararıdır — Eren'in kararı (görev spec'i madde 5). O yüzden burada
// whisperLocal.cjs deseninin AYNISI uygulanıyor:
//   • ağır şeyler pakette DEĞİL, cihaz-paylaşımlı `~/.crewpane/models/` altında
//   • bulunamazsa özellik SESSİZCE ÇÖKMEZ, açık bir `reason` ile KAPANIR
//   • tek indirme yolu `scripts/fetch-embed-model.mjs`
// Karar "pakete göm" çıkarsa yalnız resolve* fonksiyonlarına bir aday eklenir.
//
// ── WIN-W6A — ÜÇÜNCÜ BASAMAK: BARINDIRILAN (hosted) API ────────────────────
// Yukarıdaki "bulunamazsa açık bir `reason` ile KAPANIR" kuralı Windows'ta ölçüldü
// (WIN-R1 §W6): yerel yol hiç kurulmadığı için hafızanın anlam katmanı ölüydü.
// Eren'in kararı (2026-08-20) bu kapanışın ÖNÜNE bir basamak koydu:
//     yerel çalışma zamanı + model VAR → YEREL  (ücretsiz, çevrimdışı, bge-m3)
//     yok + kullanıcının anahtarı VAR  → HOSTED (memoryEmbedHosted.cjs)
//     ikisi de yok                     → DÜRÜST mesajla kapanır (kural korunur)
// YEREL ÖNCELİK BOZULMAZ: macOS'ta model kuruluysa hiçbir ağ çağrısı yapılmaz ve
// davranış bit-bit aynıdır. Hosted'ı kapatmak için `CREWPANE_EMBED_HOSTED=0`.
//
// SAF yardımcılar (resolve*) Electron'suz test edilir; durum tutan kısım
// `loadImpl` seam'iyle test edilir (gerçek model yüklenmeden).

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const instancePaths = require('../config/instancePaths.cjs');
const chunker = require('./memoryChunker.cjs'); // ONNX-CRASH-01 — sayaç yedeği (saf)
const hostedEmbed = require('./memoryEmbedHosted.cjs'); // WIN-W6A — yerel yoksa barındırılan basamak
const limits = require('./memoryEmbedLimits.cjs'); // ONNX-CRASH-01 — girdi tavanı (tek kaynak)

// ADP-869 kazananı — DEĞİŞTİRME (ölçüm bu yapılandırmaya ait).
const MODEL_ID = 'Xenova/bge-m3';
const DTYPE = 'q8';
const POOLING = 'cls';
const DIM = 1024;
const RUNTIME_PKG = '@huggingface/transformers';

/** Cihaz-paylaşımlı gömme dizini: ~/.crewpane/models/embed (instance'lar paylaşır). */
function sharedEmbedDir(homedir = os.homedir()) {
  return path.join(homedir, '.crewpane', 'models', 'embed');
}

/**
 * Model ağırlıklarının kök dizini (HF cache düzeni: <kök>/Xenova/bge-m3/...).
 * Sıra: açık env → bu instance'ın evi → cihaz-paylaşımlı dizin.
 * AÇIKÇA verilen yol yoksa BAŞKA adaya DÜŞMEZ (whisperLocal kuralı: "oraya koydum"
 * diyen ölçüm, yanlış modelle sessizce koşmamalı).
 */
function resolveModelsDir({ env = process.env, homedir = os.homedir(), exists = fs.existsSync } = {}) {
  const explicit = env.CREWPANE_EMBED_MODELS_DIR;
  if (explicit) {
    try {
      return modelPresent(String(explicit), exists) ? String(explicit) : '';
    } catch {
      return '';
    }
  }
  const cands = [];
  try {
    cands.push(path.join(instancePaths.instanceHome(homedir), 'models', 'embed'));
  } catch {
    /* instancePaths env'e bakar; patlarsa sıradaki aday */
  }
  cands.push(sharedEmbedDir(homedir));
  for (const c of cands) {
    try {
      if (modelPresent(c, exists)) return c;
    } catch {
      /* yok say */
    }
  }
  return '';
}

/**
 * ADP-900 — 🪤 DİZİNİN VARLIĞI "MODEL KURULU" DEMEK DEĞİLDİR. Ölçüldü (ADP-900 e2e,
 * tam-indirme koşusu): indirme daha ilk iki küçük dosyayı yazmışken (16 MB / 560 MB)
 * `availability()` **ok** dedi, çünkü yalnız `<kök>/Xenova/bge-m3` dizinine bakıyordu.
 * Sonuç yarım kurulumun "hazır" görünmesiydi — hem UI hem indeksleyici için yalan.
 *
 * Doğru soru AĞIRLIK DOSYASI orada mı: indirici dosyayı önce `.part` olarak yazıp
 * boyutu ölçülen değere karşı doğruladıktan SONRA yerine koyar (memoryEmbedInstall),
 * yani nihai adın varlığı "tam indi"nin kendisidir. Yarım iş `.part` adında durur ve
 * bu kontrolü GEÇEMEZ.
 */
function modelPresent(root, exists = fs.existsSync) {
  const base = path.join(String(root || ''), ...MODEL_ID.split('/'));
  return Boolean(exists(base) && exists(path.join(base, 'onnx', 'model_quantized.onnx')));
}

/**
 * transformers.js çalışma zamanının çözülebileceği dizin (içinde node_modules olan).
 * Sıra: açık env → instance evi → cihaz-paylaşımlı → repo (kaynaktan koşarken
 * Faz 1 düzeneğinin zaten kurulu kopyası; PAKETLİ app'te bu yol YOKTUR).
 */
function runtimeCandidates({ env = process.env, homedir = os.homedir(), repoRoot = null } = {}) {
  const out = [];
  if (env.CREWPANE_EMBED_RUNTIME_DIR) out.push(String(env.CREWPANE_EMBED_RUNTIME_DIR));
  try {
    out.push(path.join(instancePaths.instanceHome(homedir), 'models', 'embed-runtime'));
  } catch {
    /* yok say */
  }
  out.push(path.join(sharedEmbedDir(homedir), 'runtime'));
  if (repoRoot) out.push(path.join(repoRoot, 'docs', 'research', 'rag-embed-bench'));
  return out;
}

/**
 * transformers.js'i çöz. Bulunursa { ok:true, dir, entry }, yoksa { ok:false, reason }.
 * `resolveImpl` seam'i testte gerçek paket olmadan çözümlemeyi taklit eder.
 */
function resolveRuntime({ env = process.env, homedir = os.homedir(), repoRoot = null, resolveImpl = null } = {}) {
  const tried = [];
  for (const dir of runtimeCandidates({ env, homedir, repoRoot })) {
    tried.push(dir);
    try {
      const entry = resolveImpl
        ? resolveImpl(RUNTIME_PKG, dir)
        : require.resolve(RUNTIME_PKG, { paths: [dir] });
      if (entry) return { ok: true, dir, entry };
    } catch {
      /* sıradaki aday */
    }
  }
  return { ok: false, reason: 'runtime_not_installed', tried };
}

/** YEREL motorun kullanılabilirlik raporu (ağa HİÇ çıkmaz, saf dosya sistemi). */
function localAvailability(opts = {}) {
  const runtime = resolveRuntime(opts);
  const modelsDir = resolveModelsDir(opts);
  if (!runtime.ok) return { ok: false, reason: 'runtime_not_installed', runtimeTried: runtime.tried, modelsDir };
  if (!modelsDir) return { ok: false, reason: 'model_not_downloaded', runtimeDir: runtime.dir };
  return { ok: true, kind: 'local', runtimeDir: runtime.dir, modelsDir, model: MODEL_ID, dtype: DTYPE, dim: DIM };
}

/**
 * Gömme motorunun kullanılabilirlik raporu — UI/ilerleme yüzeyleri bunu gösterir.
 *
 * WIN-W6A — İKİ BASAMAK, TEK CEVAP. Yerel kuruluysa hosted'a HİÇ BAKILMAZ (ağ
 * çağrısı yok, anahtar sorgusu yok): macOS'un bugünkü davranışı bit-bit korunur.
 * Yerel yoksa kullanıcının anahtarı SORULUR — ama yalnız kapıdan, yalnız yerel
 * kaynaklardan (bu fonksiyon da ağa çıkmaz; anahtarın GEÇERLİ olduğunu iddia etmez,
 * yalnız VAR olduğunu söyler).
 *
 * `reason` alanı bilerek YEREL nedeni taşır (geriye uyum: çağıranlar
 * `runtime_not_installed` / `model_not_downloaded` bekliyor); hosted tarafının
 * durumu `kind` + `hostedReason` + `message` ile ayrıca gelir.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.hosted=true] false → yalnız yerel (test/kaçış valfi)
 */
function availability(opts = {}) {
  const local = localAvailability(opts);
  if (local.ok) return local;
  if (opts.hosted === false) return { ...local, kind: 'none' };

  const picked = hostedEmbed.resolveHostedProvider({
    env: opts.env || process.env,
    ...(opts.gate ? { gate: opts.gate } : {}),
    ctx: opts.credentialCtx || {},
  });
  if (picked.ok) {
    return {
      ok: true,
      kind: 'hosted',
      provider: picked.provider.id,
      model: picked.provider.model,
      dtype: `api:${picked.provider.id}`,
      dim: picked.provider.dim,
      keySource: picked.source,
      // Yerelin NEDEN devrede olmadığı kaybolmasın: kullanıcı "neden ağ kullanıyorum"
      // sorusunun cevabını aynı nesnede görsün (Windows'ta bu her zaman dolu olacak).
      localReason: local.reason,
    };
  }
  return {
    ...local,
    kind: 'none',
    hostedReason: picked.reason,
    // SESSİZ ÖLÜM YASAK — gösterilecek cümle ve Ayarlar hedefi burada.
    message: picked.message,
    settingsTarget: picked.settingsTarget || null,
  };
}

/**
 * Gömme motorunu yükle. Döner: { ok, embed(texts)->Float32Array[], dim, close() }
 * veya { ok:false, reason }.
 *
 * `embed` L2-normalize edilmiş vektör döndürür (depoda kosinüs = iç çarpım).
 * Model ilk çağrıda yüklenir (~1-2 sn) ve süreç boyunca canlı kalır — indeksleyici
 * çocuğu iş bitince ölür, yani RAM otomatik geri döner (ADP-869: tepe 2.5 GB).
 */
async function createLocalEmbedder({ env = process.env, homedir = os.homedir(), repoRoot = null, allowRemote = false } = {}) {
  const runtime = resolveRuntime({ env, homedir, repoRoot });
  if (!runtime.ok) return { ok: false, reason: 'runtime_not_installed', tried: runtime.tried };
  const modelsDir = resolveModelsDir({ env, homedir });
  if (!modelsDir && !allowRemote) return { ok: false, reason: 'model_not_downloaded' };

  const mod = await import(require('node:url').pathToFileURL(runtime.entry).href);
  const tf = mod.default && mod.default.pipeline ? mod.default : mod;
  // Ağırlıklar `<kök>/Xenova/bge-m3/{config.json,tokenizer.json,onnx/…}` düzeninde —
  // transformers.js'in HEM cacheDir HEM localModelPath düzeni bu, yani Faz 1'in
  // indirdiği 2.7 GB'lık kopya OLDUĞU GİBİ kullanılır (yeniden indirme YOK).
  // Fark: bench `allowRemoteModels` açık koşuyordu (eksik dosyayı sessizce indirirdi);
  // ÜRÜNDE varsayılan KAPALI — müşterinin makinesi arka planda 543 MB çekmesin, eksikse
  // açıkça `model_not_downloaded` densin. Yüklenen dosyalar aynı → ölçüm geçerli.
  const root = modelsDir || sharedEmbedDir(homedir);
  tf.env.cacheDir = root;
  tf.env.localModelPath = root;
  tf.env.allowLocalModels = true;
  tf.env.allowRemoteModels = Boolean(allowRemote);

  // ── ONNX-CRASH-02 · BFC ARENA KAPALI ──────────────────────────────────────
  // ÖLÇÜLDÜ (06.09.2026, aynı makine, iş yükü ONNX-CRASH-01 tavanına UYAN parti:
  // 16 dizi × 463 jeton; A/B iç içe koşuldu, yük sapması için 2 tur):
  //   arena AÇIK  → tepe RSS 1490 / 1950 / 2081 / 2273 / 2377 / 2399 MB (yayılım 909 MB)
  //   arena KAPALI→ tepe RSS 1557 / 1564 / 1608 MB                      (yayılım  51 MB)
  //   parti gecikmesi p50: açık 4943–5133 ms · kapalı 4812–4889 ms → FARK YOK
  // (Tek koşuda görülen "%44 yavaşlama" makinenin o anki yüküydü; iç içe A/B onu
  //  çürüttü — ölçüm hatasını bulguya çevirmiyoruz.)
  //
  // NEDEN ÖNEMLİ: 5 SIGTRAP kaydının hepsinde istenen değer TAM 0x80000000 = 2 GiB
  // ve yığın `ExecutionFrame::ExecutionFrame → BFCArena::Alloc → BFCArena::Extend →
  // CPUAllocator::Alloc → posix_memalign`. Bu 2 GiB TEK BİR TENSÖR DEĞİL: BFCArena
  // bölgelerini İKİYE KATLAYARAK büyütür (1 MB → 2 → 4 … → 1 GiB → 2 GiB), yani
  // tavana UYAN bir iş yükü bile arenayı bu boya sürükler. Ölçüm bunu doğruladı:
  // partiyi 16'dan 8'e indirmek tepeyi 2399 → 2273 MB yaptı (yani parti boyutu DEĞİL
  // arenanın büyümesi tepeyi belirliyor). Electron'da başarısız bir malloc `nullptr`
  // DÖNDÜRMEZ — Chromium'un OOM kesme noktası (`brk 0`) süreci anında düşürür, bu
  // yüzden onnxruntime'ın "isteği yarıya indir" kurtarma yolu HİÇ koşamıyor.
  // Arena kapalıyken BFCArena hiç kurulmaz → 2 GiB'lık bitişik bölge isteği YAPI
  // GEREĞİ oluşamaz.
  //
  // KAÇIŞ VALFİ = KONTROL KOLU: `CREWPANE_EMBED_CPU_ARENA=1` eski davranışı geri
  // getirir (düzeltmeyi söküp çökmeyi geri çağırmak için).
  const cpuArena = String(env.CREWPANE_EMBED_CPU_ARENA || '') === '1';
  const extractor = await tf.pipeline('feature-extraction', MODEL_ID, {
    dtype: DTYPE,
    device: 'cpu',
    ...(cpuArena ? {} : { session_options: { enableCpuMemArena: false } }),
  });

  // ── ONNX-CRASH-01 — GİRDİ TAVANI ──────────────────────────────────────────
  // Tavan modelin BEYANINDAN değil ölçülen bellek eğrisinden gelir; beyan yalnız
  // üst sınır olarak okunur (gerekçe + rakamlar: memoryEmbedLimits.cjs başlığı).
  const tokenizer = extractor.tokenizer || null;
  const maxTokens = limits.resolveMaxTokens(tokenizer && tokenizer.model_max_length);
  // 🔴 KEMER — bizim bölücümüz yanılsa bile burası tutar. transformers.js
  // `max_length = Math.min(max_length, this.model_max_length)` uyguluyor (tokenizers.js
  // §2867), yani bu atama HEM truncation'ı HEM `padding:true` dolgusunu tavana çeker.
  // Ölçülen 8192'lik varsayılan bırakılsaydı tek bir dizi 8+ GB isteyebilirdi.
  if (tokenizer) tokenizer.model_max_length = maxTokens;
  // Sayaç kırpmadan sayar (padding+truncation kapalıyken transformers.js dolgu/kırpma
  // bloğuna hiç girmez) — yoksa her metin "tam tavan" görünür ve bölme anlamsızlaşırdı.
  const countTokens = tokenizer
    ? (s) => {
      try {
        return tokenizer(s, { padding: false, truncation: false }).input_ids.dims.at(-1);
      } catch {
        return chunker.estimateTokens(s); // tokenizer patlarsa tahmine düş, sessiz kalma
      }
    }
    : chunker.estimateTokens;

  let lastPlan = null; // son embed çağrısının kırpma/parça raporu (çağıran loglar)

  async function runBatch(pieces) {
    try {
      const out = await extractor(pieces, { pooling: POOLING, normalize: true });
      const data = out.data;
      const dim = out.dims[out.dims.length - 1];
      const vecs = [];
      for (let i = 0; i < pieces.length; i++) vecs.push(Float32Array.from(data.slice(i * dim, (i + 1) * dim)));
      return vecs;
    } catch (err) {
      // ONNX'in bellek hatası C++ tarafından gelir ve mesajı kriptiktir; çağıranın
      // ("bu belge zehirli mi") karar verebilmesi için sınıflandırılmış hata atıyoruz.
      const e = new Error(`embed_failed: ${(err && err.message) || err}`);
      e.code = 'embed_failed';
      e.seqs = pieces.length;
      e.maxTokens = Math.max(...pieces.map((p) => countTokens(p)));
      throw e;
    }
  }

  /**
   * Metinleri vektöre çevir. UZUN metin ÇÖKMEZ, PARÇALANIR:
   * parçalar ayrı ayrı gömülür, L2-normalize vektörlerin ORTALAMASI alınır ve
   * yeniden normalize edilir (parça-gömme ortalaması — kosinüs uzayı korunur).
   * Neden ortalama, "ilk parça" değil: ilk parça uzun bir belgenin yalnız başlığını
   * temsil eder; ortalama belgenin tamamını temsil eder ve mevcut tek-vektör
   * şemasını (memoryIndexStore) DEĞİŞTİRMEZ.
   */
  async function embed(texts) {
    const list = Array.isArray(texts) ? texts : [texts];
    if (!list.length) return [];
    const plans = list.map((t) => limits.planInput(String(t == null ? '' : t), { countTokens, maxTokens }));
    lastPlan = {
      inputs: list.length,
      pieces: plans.reduce((n, p) => n + p.pieces.length, 0),
      split: plans.filter((p) => p.pieces.length > 1).length,
      truncated: plans.filter((p) => p.truncated).length,
      clipped: plans.filter((p) => p.clipped).length,
      maxTokens,
    };

    // Jeton sayıları planlamada ZATEN ölçüldü — ikinci bir tokenize turu yapmıyoruz
    // (tokenizer maliyeti süperdoğrusal, bkz. memoryEmbedLimits.cjs başlığı).
    const flat = [];
    plans.forEach((p, owner) => p.pieces.forEach((text, k) => flat.push({ owner, text, tokens: p.pieceTokens[k] })));
    const acc = list.map(() => null);

    for (const b of limits.planBatches(flat.map((f) => f.tokens))) {
      const slice = flat.slice(b.start, b.end);
      const vecs = await runBatch(slice.map((f) => f.text));
      slice.forEach((f, j) => {
        const v = vecs[j];
        if (!acc[f.owner]) acc[f.owner] = new Float64Array(v.length);
        for (let d = 0; d < v.length; d++) acc[f.owner][d] += v[d];
      });
    }

    return acc.map((sum) => {
      if (!sum) return new Float32Array(DIM);
      let norm = 0;
      for (let d = 0; d < sum.length; d++) norm += sum[d] * sum[d];
      norm = Math.sqrt(norm) || 1;
      const v = new Float32Array(sum.length);
      for (let d = 0; d < sum.length; d++) v[d] = sum[d] / norm;
      return v;
    });
  }

  return {
    ok: true,
    kind: 'local',
    model: MODEL_ID,
    dtype: DTYPE,
    dim: DIM,
    maxTokens, // ONNX-CRASH-01 — çağıran tavanı GÖRSÜN (log/rapor uydurmasın)
    cpuMemArena: cpuArena, // ONNX-CRASH-02 — hangi ayırıcıyla koştuğu BEYAN edilir
    modelsDir: tf.env.cacheDir,
    runtimeDir: runtime.dir,
    embed,
    lastEmbedPlan: () => lastPlan,
    async close() {
      try {
        await extractor.dispose?.();
      } catch {
        /* dispose yoksa süreç zaten ölecek */
      }
    },
  };
}

/**
 * WIN-W6A — ÜÇ DALLI motor seçimi. Çağıranlar (indeksleyici + arama çocuğu) hangi
 * dalın koştuğunu BİLMEZ: dönen sözleşme her dalda aynıdır
 * (`{ok, model, dtype, dim, embed, close}`).
 *
 *   1. YEREL kurulu       → yerel motor. Ağ YOK, anahtar SORULMAZ, ücret YOK.
 *   2. Yerel yok + anahtar → barındırılan motor (memoryEmbedHosted.cjs).
 *   3. İkisi de yok        → `{ok:false}` + `message` (kullanıcıya gösterilecek
 *                            cümle) + `settingsTarget` (Ayarlar'a derin bağlantı).
 *
 * 🪤 `dtype` dala göre DEĞİŞİR (`q8` / `api:openai` / `api:gemini`) ve indeks
 * parmak izine girer — iki farklı uzayın vektörleri aynı indekste karışamaz
 * (bkz. memoryEmbedHosted.cjs başlığı ve memoryIndexWorker.fingerprint).
 *
 * @param {object} [opts]
 * @param {boolean} [opts.hosted=true] false → yalnız yerel dal denenir
 */
async function createEmbedder(opts = {}) {
  const local = await createLocalEmbedder(opts);
  if (local.ok) return local;
  if (opts.hosted === false) return local;

  const remote = await hostedEmbed.createHostedEmbedder({
    env: opts.env || process.env,
    ...(opts.gate ? { gate: opts.gate } : {}),
    ctx: opts.credentialCtx || {},
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (remote.ok) return { ...remote, kind: 'hosted', localReason: local.reason };

  return {
    ok: false,
    kind: 'none',
    // Geriye uyum: `reason` YEREL nedeni taşımaya devam eder (indeksleyici bunu
    // `lexicalOnly` gerekçesi olarak yazıyor). Hosted'ın neden olmadığı ayrı alanda.
    reason: local.reason,
    tried: local.tried || [],
    hostedReason: remote.reason,
    message: remote.message,
    settingsTarget: remote.settingsTarget || null,
  };
}

module.exports = {
  MODEL_ID,
  DTYPE,
  POOLING,
  DIM,
  RUNTIME_PKG,
  sharedEmbedDir,
  resolveModelsDir,
  runtimeCandidates,
  resolveRuntime,
  localAvailability,
  availability,
  createLocalEmbedder,
  createEmbedder,
};
