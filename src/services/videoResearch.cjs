// SKL-B1 (SPRINT-SKILLHUB-01) — düşük-token VİDEO ARAŞTIRMA yardımcısı.
//
// SORU: bir ajan "şu videoyu araştır" dediğinde en ucuz DOĞRU yol nedir?
// Cevap ölçüldü (docs/agent-results/SKL-R2-perceptor.md, aynı video/model/prompt):
//
//   yol                          girdi tok   USD      yerel araç   ekrandaki kodu gördü mü?
//   A  transcript-first              642    0,0053   yt-dlp       ❌ hayır — ÜSTELİK SESSİZCE UYDURDU
//   B  tam video                  11.710    0,0120   yok          ✅ en iyi
//   C  yalnız kareler             11.066    0,0127   yt-dlp+ffmpeg ⚠️ videoda olmayan iddia üretti
//   H2 transcript + 13 kare@LOW    4.063    0,0057   yt-dlp+ffmpeg ✅ evet
//   H3 video fps=0.2               4.978    0,0069   **yok**      ✅ evet
//
// ── DEĞİŞMEZ KURAL: HAM MEDYA AJANIN BAĞLAMINA ASLA GİRMEZ ────────────────────
// 10 kareyi doğrudan ajana okutmak 11.000 token yakar (ölçüldü); aynı iş Gemini'ye
// devredilince ajana ~300 token'lık ÖZET döner — 37× az bağlam. Piyasadaki hazır
// araçlar (claude-video ~7K yıldız) tam da bunu vermiyor; bu yüzden hazır araç
// ALINMADI. Bu modül ham transcript'i, kareyi, sesi ASLA döndürmez.
//
// ── NEDEN ÜRÜN KODU, SKILL DEĞİL (§4.2) ──────────────────────────────────────
// Reçete 4 kabuk çağrısı + 1 HTTP POST — yani KOD. v1 skill sözleşmesi `scripts/`
// yasaklıyor (T4). Makineyi ürüne koyduk: T4 hiç gevşemedi, kod birim-testlendi,
// app imzasıyla geliyor. Skill (SKL-B2) yalnız PROSEDÜRÜ taşır.
//
// ── K-7(b): v1'de yt-dlp YOK ─────────────────────────────────────────────────
// Varsayılan yol H3'tür ve YEREL ARAÇ GEREKTİRMEZ. yt-dlp bu makinede kurulu
// değil; ürün onu İNDİRMEZ de (K-7(b), v1.1'de (a)). Kullanıcının kendi kurduğu
// bir yt-dlp VARSA transcript yolu açılır (uzun videoda ~9× ucuz) — yoksa uzun
// videoda CLI TEK CÜMLEYLE DURUR. Sessiz pahalı çağrı YASAK.
//
// ── K-4: sıfır yeni ayar ─────────────────────────────────────────────────────
// Tavan 60.000 token'da SABİT (Ayarlar'a alan açılmadı). `--budget` yalnız CLI
// bayrağıdır; model/fps/çözünürlük kullanıcıya HİÇ sorulmaz (R2'nin kendi kuralı:
// "ölçülmüş teknik detayı kullanıcıya sormak yalnızca yanlış cevap alma yolu").
//
// ── ANAHTAR ──────────────────────────────────────────────────────────────────
// GEMINI_API_KEY. Yeni sır yüzeyi AÇILMADI: settings.json → apiKeys.gemini (SKL-B3
// oraya alan koyacak) kazanır, yoksa ~/.crewpane/keys.env (PROV-01 okuyucusu),
// yoksa ortam. Anahtar ASLA loglanmaz/çıktıya yazılmaz — `scrubSecrets` her metin
// çıkışını süzer (savunmanın ikinci katmanı; birincisi hiç basmamaktır).

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ── ölçülmüş sabitler ────────────────────────────────────────────────────────

/** Modeller SABİT — kullanıcıya SORULMAZ (R2 §2.5: transkripsiyon bir muhakeme işi
 *  değil; düşünen modele verilirse para DÜŞÜNMEYE gider — 23× fark ölçüldü). */
const MODELS = Object.freeze({
  analysis: 'gemini-3.6-flash',
  transcription: 'gemini-3.1-flash-lite',
});

/** ai.google.dev/gemini-api/docs/pricing, 2026-08-18 ölçümü. USD / 1M token.
 *  ⚠️ 2027-01-01'de 2×'e çıkıyor — tavanın gerekçesi budur. */
const PRICING = Object.freeze({
  'gemini-3.6-flash': Object.freeze({ in: 0.75, inAudio: 0.75, out: 3.75 }),
  'gemini-3.1-flash-lite': Object.freeze({ in: 0.25, inAudio: 0.50, out: 1.50 }),
});

/**
 * 🪤 ÖLÇÜLDÜ — token/saniye ÜÇ farklı videoda SABİT çıktı, yani süreden token
 * tahmini güvenilir bir ÖN ölçümdür (çağrı yapılıp fatura görülmesine gerek yok):
 *
 *   yol             128 sn    18d40      1s56d      tok/sn
 *   full (varsay.)  13.177    115.360    718.938    102,9 / 103,0 / 103,3
 *   sparse fps=0.2   5.935     51.744    322.474     46,4 /  46,2 /  46,3
 *   transcript         550      4.177     25.093      4,3 /   3,7 /   3,6
 *
 * ⚠️ TASARIM KARTINDAN SAPMA (bilinçli, raporda gerekçeli): kart "süre × 103"
 * diyor; ama 103 YALNIZ `full` yolunun hızıdır. Sparse (H3) yolu ölçülmüş olarak
 * 46,4 tok/sn koşuyor ve K-7'nin gerekçesi "18 dk video $0,04'e araştırılıyor"
 * diyor — 103 ile ölçseydik o 18 dk'lık video (115k > 60k) REDDEDİLİRDİ, oysa
 * gerçek maliyeti 51.744 token'dır ve tavanın ALTINDADIR. Tavan, SEÇİLEN YOLUN
 * ölçülmüş hızıyla değerlendirilir; tahmin hâlâ ÖNDEN ve çağrısızdır.
 */
const TOKENS_PER_SEC = Object.freeze({ full: 103, sparse: 46.4, transcript: 4.3 });

/** H3'ün kaldıracı. `mediaResolution` VİDEODA aşağı inmiyor (ölçüldü: LOW=MEDIUM=
 *  varsayılan); aşağı inmenin tek yolu `fps`. */
const SPARSE_FPS = 0.2;

/** K-4 — sabit tavan. Ayar DEĞİL; `--budget` ile çağrı başına gevşetilebilir. */
const DEFAULT_BUDGET = 60000;

/** Gemini 1M bağlam ⇒ 103 tok/sn'de ~2s50d SERT tavan (R2 §2.2). Bütçe ne olursa
 *  olsun bunun üstü tek çağrıya SIĞMAZ — API'ye sormaya gerek yok. */
const HARD_CONTEXT_TOKENS = 1048576;

const DEPTHS = Object.freeze(['auto', 'none', 'sparse', 'full']);

/** R2'nin ölçüm prompt'u — BİREBİR aynı, yoksa sayılar R2 tablosuyla kıyaslanamaz. */
const ANALYSIS_PROMPT = (
  'Summarize this technical video for an engineer who has not seen it. '
  + 'Output exactly: (1) one-sentence thesis, (2) 5 bullet key claims, '
  + '(3) any code/API names or on-screen text you can identify, '
  + '(4) 3 named tools/libraries mentioned. Be terse.'
);

/** Transcript yolunda ZORUNLU ek: R2 §0.2 — metin yolu `useState` dedi, transcript'te
 *  YOKTU; bu sefer doğru tutturdu, bilinmeyen bir API'de YANLIŞ tutturacaktı ve
 *  "tahmin" diye işaretlenmeyecekti. Sessiz uydurma, maliyetten büyük risk. */
const TRANSCRIPT_ONLY_CAUTION = (
  '\n\nIMPORTANT: you are seeing ONLY the spoken transcript, not the screen. '
  + 'Any API name, code identifier or on-screen text you report MUST be marked '
  + '"(not seen on screen — inferred)" unless it literally appears in the transcript.'
);

const YOUTUBE_URL = 'https://www.youtube.com/watch?v=';

// ── sır hijyeni ───────────────────────────────────────────────────────────────

/** Google API anahtarı deseni (AIza…) + çağıranın verdiği gerçek değer. Basmamak
 *  birinci savunma; bu SÜZGEÇ ikincisi — modelin çıktısı, HTTP hata gövdesi ya da
 *  bir yığın izi anahtarı geri yansıtırsa kullanıcıya ULAŞMAZ. */
function scrubSecrets(text, extra = []) {
  let s = String(text == null ? '' : text);
  for (const v of extra) {
    if (typeof v === 'string' && v.length >= 8) s = s.split(v).join('«gizli»');
  }
  return s.replace(/AIza[0-9A-Za-z_-]{10,}/g, '«gizli»');
}

// ── URL ───────────────────────────────────────────────────────────────────────

/**
 * v1 KAPSAMI: yalnız YouTube. Gemini'nin `file_data.file_uri` yolu YouTube'a
 * ÖZELDİR; Vimeo/Loom/mp4 indirip Files API'ye yüklemeyi gerektirir ve ÖLÇÜLMEDİ
 * (R2 §8-2). Ölçülmemiş bir yolu "destekliyoruz" demek yanlış vaattir.
 * @returns {{ok:true,videoId:string,url:string}|{ok:false,reason:string}}
 */
function parseVideoUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { ok: false, reason: 'video URL\'i gerekir: crewpaneCli video <youtube-url>' };
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return { ok: true, videoId: s, url: YOUTUBE_URL + s };
  let u;
  try {
    u = new URL(s.includes('://') ? s : `https://${s}`);
  } catch {
    return { ok: false, reason: `URL çözümlenemedi: "${s}"` };
  }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  let id = '';
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    id = u.searchParams.get('v') || '';
    if (!id) {
      const m = u.pathname.match(/\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
      if (m) id = m[1];
    }
  } else {
    return {
      ok: false,
      reason: `v1 yalnız YouTube destekliyor (gelen: ${host}). Diğer kaynaklar indirme + Files API yükleme ister; ölçülmedi.`,
    };
  }
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return { ok: false, reason: `YouTube video kimliği bulunamadı: "${s}"` };
  return { ok: true, videoId: id, url: YOUTUBE_URL + id };
}

// ── maliyet ───────────────────────────────────────────────────────────────────

/** ⚠️ DÜŞÜNME TOKEN'I ÇIKTI FİYATINDAN faturalanır (ölçüldü) — çıktı = candidates + thoughts. */
function usdFor({ model, promptTokens = 0, outputTokens = 0, audioTokens = 0 } = {}) {
  const p = PRICING[model];
  if (!p) return null;
  const text = Math.max(0, promptTokens - audioTokens);
  return (text * p.in + audioTokens * p.inAudio + outputTokens * p.out) / 1e6;
}

function usageTokens(usage = {}) {
  const prompt = Number(usage.promptTokenCount) || 0;
  const out = (Number(usage.candidatesTokenCount) || 0) + (Number(usage.thoughtsTokenCount) || 0);
  let audio = 0;
  for (const d of usage.promptTokensDetails || []) {
    if (d && d.modality === 'AUDIO') audio += Number(d.tokenCount) || 0;
  }
  return { prompt, out, audio };
}

/** Çıktının SON SATIRI. §4.6: v1'de maliyet ÇAĞRI BAŞINA gösterilir; kullanıcı ilk
 *  kullanımda tek sayıyı görünce "bu ne kadar tutuyor" sorusu cevaplanmış olur. */
function formatCostLine({ model, usage } = {}) {
  const t = usageTokens(usage || {});
  const usd = usdFor({ model, promptTokens: t.prompt, outputTokens: t.out, audioTokens: t.audio });
  const money = usd == null ? '?' : `$${usd.toFixed(5)}`;
  return `girdi ${t.prompt} tok · çıktı ${t.out} tok · ${money}`;
}

// ── karar ağacı (SAF — birim testlenebilir) ──────────────────────────────────

function estimateInputTokens(durationSec, pathName) {
  const rate = TOKENS_PER_SEC[pathName];
  if (!rate || !(durationSec > 0)) return null;
  return Math.round(durationSec * rate);
}

/**
 * §4.4 karar ağacı. SAF fonksiyon: ağ yok, dosya yok — tavan/derinlik/araç-var-yok
 * matrisi doğrudan test edilir.
 *
 * @param {{durationSec:number, depth?:string, hasYtDlp?:boolean, budget?:number}} o
 * @returns {{path:'sparse'|'full'|'transcript'|'stop', estimatedInputTokens:number|null,
 *            budget:number, reason:string, fps?:number, downgraded?:boolean}}
 */
function decidePath({ durationSec, depth = 'auto', hasYtDlp = false, budget = DEFAULT_BUDGET } = {}) {
  const cap = Number(budget) > 0 ? Number(budget) : DEFAULT_BUDGET;
  const d = DEPTHS.includes(depth) ? depth : 'auto';
  const secs = Number(durationSec);
  if (!(secs > 0)) {
    return { path: 'stop', estimatedInputTokens: null, budget: cap, reason: 'video süresi ölçülemedi — kör bir çağrı yapmam.' };
  }
  const est = (p) => estimateInputTokens(secs, p);
  const mins = Math.round(secs / 6) / 10;

  // (1) "görsel gerekmiyor" AÇIKÇA istendi → transcript yolu. Yerel araç şart.
  if (d === 'none') {
    if (!hasYtDlp) {
      return {
        path: 'stop',
        estimatedInputTokens: est('transcript'),
        budget: cap,
        reason: 'transcript yolu yt-dlp ister, bu makinede kurulu değil. Görsel gerekmiyorsa bile en ucuz kurulumsuz yol `--depth sparse`.',
      };
    }
    return { path: 'transcript', estimatedInputTokens: est('transcript'), budget: cap, reason: `--depth none: yalnız transcript (~${est('transcript')} tok).` };
  }

  // (2) görsel gerekiyor → varsayılan H3 (kurulum sıfır). `full` yalnız açıkça istenirse.
  const wanted = d === 'full' ? 'full' : 'sparse';
  const wantedEst = est(wanted);
  if (wantedEst <= cap && wantedEst <= HARD_CONTEXT_TOKENS) {
    return {
      path: wanted,
      fps: wanted === 'sparse' ? SPARSE_FPS : undefined,
      estimatedInputTokens: wantedEst,
      budget: cap,
      reason: wanted === 'sparse'
        ? `H3: tek Gemini çağrısı, video fps=${SPARSE_FPS} (yerel araç gerekmez) — ~${wantedEst} tok.`
        : `--depth full: tam video (varsayılan fps) — ~${wantedEst} tok.`,
    };
  }

  // (3) tavan aşıldı. yt-dlp VARSA transcript'e düş; YOKSA çağrı YAPMADAN dur.
  const trEst = est('transcript');
  if (hasYtDlp && trEst <= cap) {
    return {
      path: 'transcript',
      estimatedInputTokens: trEst,
      budget: cap,
      downgraded: true,
      reason: `${mins} dk'lık video görsel yolda ~${wantedEst} tok eder (tavan ${cap}); transcript yoluna düşüldü (~${trEst} tok) — ekranda görülenler KAYBOLUR, çıktı bunu işaretler.`,
    };
  }
  return {
    path: 'stop',
    estimatedInputTokens: wantedEst,
    budget: cap,
    reason: hasYtDlp
      ? `${mins} dk'lık video hiçbir yolda tavana sığmıyor (görsel ~${wantedEst}, transcript ~${trEst} tok; tavan ${cap}). --budget ile yükseltin.`
      : `${mins} dk'lık video için ~${wantedEst} girdi token'ı gerekiyor, tavan ${cap}. Bu uzunlukta transcript yolu gerekiyor; yt-dlp kurulu değil. Çağrı YAPILMADI (--budget ile yükseltebilirsiniz).`,
  };
}

// ── json3 / info.json süzgeçleri (R2 scripts/json3_to_text.py portu) ─────────

/**
 * 540 KB ham `info.json` ≈ 135k token — ASLA ham verilmez. Yalnız dört alan.
 * (yt-dlp yolu K-7(b) ile v1'de KAPALI; süzgeç yine de burada yaşar ki o yol
 * açıldığında "hepsini yolla" refleksi kod içinde asla mümkün olmasın.)
 */
function filterInfoJson(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const chapters = Array.isArray(o.chapters)
    ? o.chapters.map((c) => ({ title: String(c && c.title || ''), start: Number(c && c.start_time) || 0 }))
    : [];
  const desc = String(o.description || '');
  return {
    title: String(o.title || ''),
    duration: Number(o.duration) || 0,
    chapters,
    description: desc.length > 2000 ? `${desc.slice(0, 2000)}…` : desc,
  };
}

/**
 * YouTube auto-caption KAYAN PENCEREYLE aynı kelimeleri her cue'da yineler:
 * 51.110 bayt json3 → 2.551 bayt metin (%95 düşüş, ölçüldü). Ekleme-farkı algoritması.
 * `stamped` ⇒ 30 sn'lik `[mm:ss]` bloklar (ajanın "şu ana bak" diyebilmesi için, +40 bayt).
 */
function json3ToText(doc, { stamped = false, chunkSec = 30 } = {}) {
  const events = (doc && Array.isArray(doc.events)) ? doc.events : [];
  const cues = [];
  for (const e of events) {
    if (!e || !Array.isArray(e.segs)) continue;
    const t = e.segs.map((s) => (s && s.utf8) || '').join('').replace(/\n/g, ' ').trim();
    if (!t) continue;
    cues.push([Number(e.tStartMs) || 0, t]);
  }
  const pieces = [];
  let prev = '';
  for (const [ms, t] of cues) {
    if (t === prev) continue;
    const add = (prev && t.startsWith(prev)) ? t.slice(prev.length).trim() : t;
    prev = t;
    if (add) pieces.push([ms, add]);
  }
  if (!stamped) return pieces.map((p) => p[1]).join(' ');
  const blocks = [];
  let cur = [];
  let start = 0;
  for (const [ms, add] of pieces) {
    if (ms - start >= chunkSec * 1000 && cur.length) {
      blocks.push([start, cur.join(' ')]);
      cur = [];
      start = ms;
    }
    cur.push(add);
  }
  if (cur.length) blocks.push([start, cur.join(' ')]);
  return blocks
    .map(([ms, b]) => `[${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}] ${b.replace(/\s+/g, ' ').trim()}`)
    .join('\n');
}

// ── anahtar çözümü ────────────────────────────────────────────────────────────

/**
 * Gemini anahtarını çözümler — **ADP-628 kapısının üzerinden**.
 *
 * 🔴 CI-GREEN-01 — TEK KAYNAK. Bu fonksiyon eskiden KENDİ zincirini yürütüyordu
 * (settings.json → keys.env → ortam) ve `env.GEMINI_API_KEY`i DOĞRUDAN okuyordu.
 * SKL-B3, `gemini`yi `requireCredential.SERVICES` defterine kaydedince aynı zincir
 * İKİ YERDE yaşamaya başladı — `requireCredential.test.cjs`in yapısal nöbeti
 * ("kapı DIŞINDA doğrudan anahtar okuması YOK") bunu kırmızıya düşürdü.
 * Sadece ortam okumasını silmek sürüklenmeyi gizlerdi; zincirin TAMAMI kapıya devredildi.
 *
 * 🔒 DAVRANIŞ DEĞİŞİKLİĞİ (bilinçli SIKILAŞTIRMA): ortam değişkeni artık
 * `envFallbackAllowed()` kapısına tabidir — MÜŞTERİ build'inde ve `prod` instance'ında
 * `GEMINI_API_KEY` OKUNMAZ. ADP-628'in ta kendisi budur: geliştiricinin `.env.local`i
 * müşteri kopyasına sızsa bile faturası bize çıkan bir çağrı açamaz. Kullanıcı yolları
 * (Ayarlar → AI Motorları, `~/.crewpane/keys.env`) BİT-BİT AYNI kalır — K-8 geriye-uyumu
 * `SERVICES.gemini.keysEnvFile: true` beyanıyla kapının kendi zincirinde yaşar.
 *
 * @param {object} [opts] - `env` · `home` · `settingsFile` · `keysFile` · `rootDir` (test dikişleri)
 * @param {object} [deps] - `readFile` · `createCredentialGate` (test dikişleri)
 * @returns {{key:string, source:'vault'|'settings'|'keys.env'|'env'|null}} — `key` çağıran
 *   dışına ASLA çıkmaz; loglanabilir olan yalnız `source` ADIdur.
 */
function resolveGeminiKey(opts = {}, deps = {}) {
  const env = opts.env || process.env;
  const readFile = deps.readFile || ((f) => fs.readFileSync(f, 'utf8'));
  const home = opts.home || os.homedir();
  const settingsFile = opts.settingsFile || defaultSettingsFile(home, env);
  const keysFile = opts.keysFile || path.join(home, '.crewpane', 'keys.env');

  const createGate =
    deps.createCredentialGate || require('../security/requireCredential.cjs').createCredentialGate;
  const gate = createGate({
    processEnv: env,
    // Instance, anahtarın okunduğu ORTAM NESNESİNDEN türetilir: enjekte edilmiş bir env
    // ile hem `dev` hem `prod` dalı sınanabilsin (üründe env === process.env, fark yok).
    instanceId: () =>
      require('../config/instancePaths.cjs').normalize(env.CREWPANE_INSTANCE) || 'prod',
    ...(opts.rootDir ? { rootDir: opts.rootDir } : {}),
    // Ayarlar okuması videoResearch'in `readFile` dikişine bağlı kalır (aynı dosya,
    // aynı yol — agentSettings ile çakışma yok: kapı yalnız `apiKeys.gemini`ye bakar).
    readSettings: () => {
      try { return JSON.parse(readFile(settingsFile)); } catch { return {}; }
    },
    // `providers.cjs`e gemini HÂLÂ eklenmedi (yeni sır yüzeyi açılmadı): dosya HAM
    // `parseEnvFile` ile okunur, kapıya yalnız bu tek kayıt verilir.
    readKeysEnvFile: () => {
      try {
        const map = require('../config/providerKeysEnvFile.cjs').parseEnvFile(readFile(keysFile));
        return map.GEMINI_API_KEY ? { gemini: map.GEMINI_API_KEY } : {};
      } catch { return {}; }
    },
  });

  const res = gate.resolveCredential('gemini');
  if (!res.ok) return { key: '', source: null };
  const SOURCE = { vault: 'vault', settings: 'settings', 'keys-env': 'keys.env', 'env-dev': 'env' };
  return { key: res.secret, source: SOURCE[res.source] || res.source };
}

function defaultSettingsFile(home, env) {
  try {
    return path.join(require('../config/instancePaths.cjs').crewpaneHome(), 'settings.json');
  } catch {
    const inst = (env && (env.CREWPANE_INSTANCE)) || '';
    const dir = inst && inst !== 'prod' ? `.crewpane-${inst}` : '.crewpane';
    return path.join(home, dir, 'settings.json');
  }
}

/** yt-dlp GERÇEKTEN var mı — ada göre değil, PATH'e bakarak. */
function hasYtDlp(deps = {}) {
  if (deps.hasYtDlp !== undefined) return !!deps.hasYtDlp;
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exists = deps.exists || fs.existsSync;
  return dirs.some((d) => {
    try {
      return exists(path.join(d, 'yt-dlp'));
    } catch {
      return false;
    }
  });
}

// ── ÖN ÖLÇÜM: süre + başlık (anahtarsız, ücretsiz, yerel araçsız) ────────────

/**
 * ⚠️ ÖLÇÜLDÜ: yt-dlp OLMADAN süreyi almanın yolu izleme sayfasındaki
 * `"lengthSeconds":"128"` alanıdır (curl ile doğrulandı: 200, 1,2 MB, 128 sn,
 * "React in 100 Seconds"). oEmbed başlığı verir ama SÜREYİ VERMEZ — süre olmadan
 * tavan kontrolü yapılamaz, tavan kontrolü olmadan da sessiz pahalı çağrı riski
 * geri gelir. Bu yüzden izleme sayfası.
 *
 * İndirilen HTML AJANIN BAĞLAMINA GİRMEZ; yalnız iki alan çıkarılır.
 */
async function probeVideoMeta(url, deps = {}) {
  const doFetch = deps.fetchImpl || ((...a) => globalThis.fetch(...a));
  let res;
  try {
    res = await doFetch(url, {
      headers: {
        'accept-language': 'en-US,en;q=0.9',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
      },
    });
  } catch (err) {
    return { ok: false, reason: `videoya ulaşılamadı (ağ): ${scrubSecrets(err && err.message ? err.message : String(err))}` };
  }
  if (!res || !res.ok) return { ok: false, reason: `video sayfası okunamadı (HTTP ${res && res.status})` };
  const html = await res.text();
  const len = html.match(/"lengthSeconds":"(\d+)"/);
  const title = html.match(/<meta name="title" content="([^"]*)"/)
    || html.match(/"title":"([^"]{1,200}?)","lengthSeconds"/);
  if (!len) {
    return { ok: false, reason: 'video süresi sayfadan okunamadı (özel/yaşa-kısıtlı video olabilir) — kör çağrı yapmam.' };
  }
  return {
    ok: true,
    durationSec: Number(len[1]),
    title: title ? decodeHtml(title[1]) : '',
  };
}

function decodeHtml(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\\u0026/g, '&');
}

// ── Gemini çağrısı + 429 geri-çekilmesi ──────────────────────────────────────

/**
 * TEK çağrı. 429/5xx'te geri-çekilme: R2'nin ~25 çağrısında hiç 429 görülmedi ama
 * Google model başına RPM/TPM YAYINLAMIYOR (R2 §7-3) — "görmedik" ile "yok" farklı
 * şeyler; toplu araştırmada 429 BEKLENMELİ.
 */
async function callGemini({ model, body, apiKey, op = 'generateContent' }, deps = {}) {
  const doFetch = deps.fetchImpl || ((...a) => globalThis.fetch(...a));
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const maxAttempts = deps.maxAttempts || 4;
  const baseDelay = deps.baseDelayMs === undefined ? 2000 : deps.baseDelayMs;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${op}`;
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let res;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
      });
    } catch (err) {
      last = { status: 0, text: scrubSecrets(err && err.message ? err.message : String(err), [apiKey]) };
      if (attempt < maxAttempts) { await sleep(baseDelay * (2 ** (attempt - 1))); continue; }
      break;
    }
    if (res.ok) {
      try {
        return { ok: true, json: await res.json(), attempts: attempt };
      } catch (err) {
        return { ok: false, status: res.status, error: `cevap çözümlenemedi: ${scrubSecrets(err && err.message ? err.message : String(err), [apiKey])}` };
      }
    }
    const text = scrubSecrets(await res.text().catch(() => ''), [apiKey]).slice(0, 400);
    last = { status: res.status, text };
    const retryable = res.status === 429 || res.status === 503 || res.status === 500;
    if (!retryable || attempt === maxAttempts) break;
    const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
    await sleep(ra > 0 ? ra * 1000 : baseDelay * (2 ** (attempt - 1)));
  }
  const hint = last && last.status === 429
    ? ' (kota/hız sınırı — geri-çekilmeyle 4 kez denendi)'
    : (last && (last.status === 401 || last.status === 403) ? ' (anahtar reddedildi)' : '');
  return { ok: false, status: last && last.status, error: `Gemini çağrısı başarısız (HTTP ${last && last.status})${hint}: ${last && last.text ? last.text : ''}`.trim() };
}

// ── istek gövdeleri ───────────────────────────────────────────────────────────

function buildAnalysisRequest({ url, fps, question }) {
  const prompt = question ? `${ANALYSIS_PROMPT}\n\nAlso answer specifically: ${question}` : ANALYSIS_PROMPT;
  const filePart = { file_data: { file_uri: url } };
  if (fps) filePart.video_metadata = { fps };
  return { contents: [{ role: 'user', parts: [{ text: prompt }, filePart] }] };
}

function buildTranscriptRequest({ transcript, question }) {
  const prompt = (question ? `${ANALYSIS_PROMPT}\n\nAlso answer specifically: ${question}` : ANALYSIS_PROMPT)
    + TRANSCRIPT_ONLY_CAUTION;
  return { contents: [{ role: 'user', parts: [{ text: prompt }, { text: `TRANSCRIPT:\n${transcript}` }] }] };
}

// ── uçtan uca ─────────────────────────────────────────────────────────────────

function hhmmss(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(ss).padStart(2, '0')}`;
}

const PATH_LABEL = Object.freeze({
  sparse: `H3 · video fps=${SPARSE_FPS} (yerel araç yok)`,
  full: 'B · tam video (varsayılan fps)',
  transcript: 'A · yalnız transcript',
});

/**
 * Ajanın bağlamına DÖNEN tek şey. ~300 token hedefi: özet + zaman damgaları +
 * maliyet satırı. Ham medya YOK.
 */
function renderReport({ title, durationSec, decision, summary, costLine, keySource }) {
  return [
    `🎬 ${title || '(başlıksız)'} · ${hhmmss(durationSec)}`,
    `yol: ${PATH_LABEL[decision.path] || decision.path}${decision.downgraded ? ' (tavan aşımı → düşürüldü)' : ''}`,
    decision.path === 'transcript' ? '⚠️ ekranda görülenler bu yolda YOK — "(not seen on screen — inferred)" işaretlerine güvenin.' : '',
    '',
    String(summary || '').trim(),
    '',
    costLine,
    keySource ? `anahtar kaynağı: ${keySource}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * @param {{url:string, depth?:string, budget?:number, question?:string}} opts
 * @returns {Promise<{ok:boolean, code?:number, data?:object, text?:string, error?:string}>}
 */
async function researchVideo(opts = {}, deps = {}) {
  const parsed = parseVideoUrl(opts.url);
  if (!parsed.ok) return { ok: false, code: 2, error: parsed.reason };

  const depth = opts.depth === undefined || opts.depth === null || opts.depth === '' ? 'auto' : String(opts.depth);
  if (!DEPTHS.includes(depth)) {
    return { ok: false, code: 2, error: `geçersiz --depth "${depth}" — şunlardan biri: ${DEPTHS.join(', ')}` };
  }
  const budget = opts.budget === undefined || opts.budget === null || opts.budget === '' ? DEFAULT_BUDGET : Number(opts.budget);
  if (!(budget > 0)) return { ok: false, code: 2, error: `geçersiz --budget "${opts.budget}" — pozitif bir token sayısı verin.` };

  // SIRA BİLİNÇLİ: anahtar ÖNCE, ön ölçüm SONRA. Anahtarsız bir kullanıcı
  // YouTube'a boşuna istek atmasın ve aldığı hata TEK CÜMLE olsun (yığın izi yok).
  const { key, source } = deps.resolveKey ? deps.resolveKey() : resolveGeminiKey({ env: opts.env }, deps);
  if (!key) {
    return {
      ok: false,
      code: 2,
      error: 'GEMINI_API_KEY bulunamadı. Ayarlar\'da Gemini anahtarını girin ya da ~/.crewpane/keys.env dosyasına `GEMINI_API_KEY=…` satırını ekleyin.',
    };
  }

  const meta = await probeVideoMeta(parsed.url, deps);
  if (!meta.ok) return { ok: false, code: 1, error: meta.reason };

  const decision = decidePath({
    durationSec: meta.durationSec,
    depth,
    hasYtDlp: hasYtDlp(deps),
    budget,
  });

  // TAVAN: çağrı YAPILMADAN durulur. "Sessiz pahalı çağrı" bu satırda ölür.
  if (decision.path === 'stop') {
    return {
      ok: false,
      code: 1,
      error: `${meta.title || parsed.videoId} (${hhmmss(meta.durationSec)}): ${decision.reason}`,
      data: {
        videoId: parsed.videoId,
        title: meta.title,
        durationSec: meta.durationSec,
        decision,
        called: false,
      },
    };
  }

  if (decision.path === 'transcript') {
    // K-7(b): v1'de bu yola YALNIZ kullanıcının kendi kurduğu yt-dlp ile girilir.
    // Ürün yt-dlp İNDİRMEZ. Çekim boğazı `deps.fetchTranscript` seam'idir; v1'de
    // kablolanmadı — vaadi olmayan bir yolu "çalışıyor" diye sunmak yanlış olurdu.
    if (typeof deps.fetchTranscript !== 'function') {
      return {
        ok: false,
        code: 1,
        error: `transcript yolu v1'de kablolanmadı (K-7(b): ürün yt-dlp indirmez). ${decision.reason}`,
        data: { videoId: parsed.videoId, decision, called: false },
      };
    }
    const tr = await deps.fetchTranscript(parsed);
    if (!tr || !tr.ok) return { ok: false, code: 1, error: `transcript alınamadı: ${tr && tr.reason ? tr.reason : 'bilinmeyen'}`, data: { called: false } };
    const res = await callGemini({ model: MODELS.analysis, apiKey: key, body: buildTranscriptRequest({ transcript: tr.text, question: opts.question }) }, deps);
    return finish({ res, key, source, parsed, meta, decision, opts });
  }

  const body = buildAnalysisRequest({
    url: parsed.url,
    fps: decision.path === 'sparse' ? SPARSE_FPS : undefined,
    question: opts.question,
  });
  const res = await callGemini({ model: MODELS.analysis, apiKey: key, body }, deps);
  return finish({ res, key, source, parsed, meta, decision, opts });
}

function finish({ res, key, source, parsed, meta, decision, opts }) {
  if (!res.ok) return { ok: false, code: 1, error: scrubSecrets(res.error, [key]) };
  const gen = res.json || {};
  const summary = scrubSecrets(
    (gen.candidates || [])
      .flatMap((c) => ((c.content && c.content.parts) || []).map((p) => p.text || ''))
      .join('')
      .trim(),
    [key],
  );
  const usage = gen.usageMetadata || {};
  const t = usageTokens(usage);
  const costLine = formatCostLine({ model: MODELS.analysis, usage });
  if (!summary) {
    return { ok: false, code: 1, error: `Gemini boş cevap döndü (${costLine}) — video özel/işlenemez olabilir.` };
  }
  const text = renderReport({
    title: meta.title,
    durationSec: meta.durationSec,
    decision,
    summary,
    costLine,
    keySource: source,
  });
  return {
    ok: true,
    code: 0,
    data: {
      videoId: parsed.videoId,
      url: parsed.url,
      title: meta.title,
      durationSec: meta.durationSec,
      path: decision.path,
      fps: decision.fps || null,
      model: MODELS.analysis,
      estimatedInputTokens: decision.estimatedInputTokens,
      budget: decision.budget,
      called: true,
      attempts: res.attempts || 1,
      usage: { inputTokens: t.prompt, outputTokens: t.out, audioTokens: t.audio },
      usd: Number((usdFor({ model: MODELS.analysis, promptTokens: t.prompt, outputTokens: t.out, audioTokens: t.audio }) || 0).toFixed(6)),
      costLine,
      keySource: source,
      summary,
      question: opts.question || null,
    },
    text,
  };
}

module.exports = {
  MODELS,
  PRICING,
  TOKENS_PER_SEC,
  SPARSE_FPS,
  DEFAULT_BUDGET,
  HARD_CONTEXT_TOKENS,
  DEPTHS,
  ANALYSIS_PROMPT,
  TRANSCRIPT_ONLY_CAUTION,
  scrubSecrets,
  parseVideoUrl,
  usdFor,
  usageTokens,
  formatCostLine,
  estimateInputTokens,
  decidePath,
  filterInfoJson,
  json3ToText,
  resolveGeminiKey,
  hasYtDlp,
  probeVideoMeta,
  callGemini,
  buildAnalysisRequest,
  buildTranscriptRequest,
  renderReport,
  researchVideo,
};
