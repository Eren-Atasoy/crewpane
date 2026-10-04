'use strict';

// ADP-909 — SESSİZLİK/GÜRÜLTÜ KAPISI: konuşma İÇERMEYEN ses STT'ye HİÇ GİTMESİN.
//
// ŞİKÂYET (Eren): "konuşmadığım hâlde bana 'abone olmayı unutma' gibi cümleler
// atfediliyor." Bu bir kod hatası değil, Whisper'ın konuşma-dışı seste YouTube
// altyazı külliyatına düşmesidir. Türkçede tam olarak bu cümleler çıkıyor.
//
// 🔴 ÖLÇÜLDÜ (ADP-909, üretim yolu · gerçek whisper-server large-v3-turbo + base ·
// Eren'in KENDİ mikrofonuyla kaydedilmiş gerçek oda tonu). Konuşma-dışı sese
// modelin verdiği metinler:
//   "İzlediğiniz için teşekkür ederim."                      (final, 5 farklı klip)
//   "Bu videolara da yorumlara da beğenmeyi unutmayın."       (taslak)  ← şikâyetin TA KENDİSİ
//   "Bu videoyu beğenmeyi izlemeye çalışın."                  (taslak)
//   "Altyazı M.K."                                           (final, dijital sessizlik dahil)
// Yani sınıf gerçek ve üretilebilir. Ayrıntı: docs/agent-results/ADP-909-inferno.md
//
// ── NEDEN YALNIZ RMS EŞİĞİ YETMEZ ──────────────────────────────────────────
// Eski kapı (whisperLocal.hasSpeech) tek ölçüte bakıyordu: 20 ms'lik karelerden
// kaçı 0,009 RMS'i aşıyor. ÖLÇÜM bunun YETMEDİĞİNİ gösterdi — Eren'in gerçek oda
// tonu 6 kat yükseltilince (fan/klima/uzak uğultu rejimi) kapı GEÇİRİYOR ve model
// yukarıdaki cümleleri üretiyor:
//   tone-x06  rms 0,0085  speechMs 1020  → GEÇTİ → "İzlediğiniz için teşekkür ederim."
//   pink-0,06 rms 0,0116  speechMs 12500 → GEÇTİ → "İzlediğiniz için teşekkür ederim."
// Eşiği YÜKSELTMEK çözüm DEĞİL: uzaktan/alçak sesle söylenen GERÇEK konuşma da
// aynı bantta (far30db rms 0,0047 — model onu DOĞRU yazıyor). Yani seviye tek
// başına konuşmayı gürültüden ayırmıyor.
//
// ── AYIRT EDİCİ: KARE ENERJİSİNİN DİNAMİĞİ ─────────────────────────────────
// Konuşma hece/duraklama ile modüle olur; fan/pembe gürültü DÜZ gider. Kare-RMS
// dağılımının p90/p10 oranı (dB) bunu ölçer. ÖLÇÜLDÜ (40+ klip):
//   durağan gürültü (oda tonu ×1..×80, pembe/kahve/beyaz/mavi, fan) : 0,5 – 6,4 dB
//   gerçek cümle (yakın VE −30 dB uzak dahil)                       : 39,6 – 46,9 dB
//   gerçek kısa kelime (doğal başlangıç/bitişle)                    : 15,2 dB
// → 12 dB eşiği iki sınıfı da ~2 kat marjla ayırıyor.
//
// 🪤 AMA DİNAMİK TEK BAŞINA DA YETMEZ — ve bunu ölçmeden teslim etseydim GERÇEK
// konuşmayı reddederdim: bir cümlenin EN YÜKSEK ENERJİLİ 0,5 sn'lik iç penceresi
// (kesintisiz ötümlü ses, duraklama yok) 3,8 dB'ye kadar düşüyor — yani durağan
// gürültü bandının TAM İÇİNDE (20 gerçek cümlenin 20'sinde ölçüldü: 3,8–21,9 dB).
// Ayırt edici olan şey o pencerelerin AYNI ZAMANDA ÇOK YÜKSEK olması (p90 0,26–0,50;
// ölçülen hiçbir gürültü klibi 0,117'yi geçmedi).
//
// ── KARAR (iki boyutlu) ────────────────────────────────────────────────────
//   1. Hiç enerji yok (speechMs < minSpeechMs)        → 'silence'      (STT'ye GİTMEZ)
//   2. Açıkça duyulur seviye (p90 ≥ loudFloor)        → 'speech'       (bugünkü davranış; regresyon yok)
//   3. Alçak seviye + DÜZ enerji (dyn < minDynamicDb) → 'steady-noise' (STT'ye GİTMEZ)
//   4. Aksi hâlde                                     → 'speech'
// Böylece kapı YALNIZ modelin halüsinasyon ürettiği alçak-seviye bandında sertleşir;
// duyulur her ses bugünkü yolundan gider.
//
// ── EŞİKLER ÇİVİLENMEZ ─────────────────────────────────────────────────────
// Hepsi `jarvis.silenceGate.*` ayarından geçersiz kılınabilir. [[clip-prod-path-default-divergence]]
// kuralı gereği varsayılanlar `agentSettings.defaults()`te SABİTLENMEZ (null kalır) —
// tek gerçek burasıdır, yoksa diskteki eski değer motorun varsayılanını sonsuza dek ezer.

// 20 ms @ 16 kHz — whisper.cpp'nin beslendiği format.
const FRAME_MS = 20;
const SAMPLE_RATE = 16000;

const DEFAULTS = Object.freeze({
  // Kare "konuşma sayılır" enerji eşiği. ADP-813'ten devralındı ve tarayıcı
  // VAD'ıyla (src/app/lib/jarvisVoice.ts) AYNI olmak zorunda: kaydı bitiren
  // mantıkla transkripti reddeden mantık aynı fikirde olsun.
  rmsThreshold: 0.009,
  // Bundan az "konuşmalı" kare = kimse konuşmadı. 5 kare.
  minSpeechMs: 100,
  // p90 bunun üstündeyse ses AÇIKÇA DUYULUR → dinamik testi UYGULANMAZ.
  // Ölçüm: en gürültülü klip p90 0,117 · en sessiz gerçek konuşma penceresi p90 0,19.
  loudFloor: 0.15,
  // Alçak seviyede konuşma sayılmak için gereken en az dinamik (dB, p90/p10).
  // Ölçüm: gürültü ≤ 6,4 dB · gerçek konuşma ≥ 15,2 dB.
  minDynamicDb: 12,
  // ── ADP-912 (a) — TASLAK KATMANI İÇİN AYRI (DAHA SIKI) DİNAMİK EŞİĞİ ──────
  //
  // 🔴 ADP-909'un gürültü tavanı (6,4 dB) SENTETİK ve BENCH sesinden ölçülmüştü.
  // ADP-912'de Eren'in masasındaki mikrofondan CANLI kaydedilen GERÇEK sessizlik
  // bunu çürüttü: kimse konuşmazken kümülatif pencerelerin dinamiği 13,8–19,8 dB
  // (2 kayıt · 160 pencere · 120/120'si kapıyı GEÇTİ) — yani gerçek oda tonu
  // 12 dB eşiğinin ÜSTÜNDE yaşayabiliyor ve `base` modeli o sese cümle uyduruyor
  // ("Evet.", "Kıvılcılar.", "Şimdi ben de bir şey yapayım." — ölçüldü).
  //
  // 🔑 EŞİĞİ HERKES İÇİN YÜKSELTMEK YANLIŞ OLURDU: ADP-909'un en zayıf gerçek
  // konuşma verisi 15,2 dB'de duruyor. Ama bu sertleşme YALNIZ TASLAK katmanına
  // konabilir, çünkü katmanların BEDELİ farklı:
  //   • final (large-v3-turbo) → komutu üretir; yanlış-negatifi kullanıcıya PAHALI.
  //   • taslak (base)          → yalnız canlı ALTYAZI; yanlış-negatifi = altyazı
  //                              bir tur geç görünür, komut ETKİLENMEZ.
  // Ölçülen marj: fantom tavanı 19,8 dB ↔ eşik 24 ↔ gerçek konuşmanın p05'i
  // 32,6 dB (703 gerçek pencere, 0/−20/−30 dB seviyelerinde). Bedel: gerçek
  // pencerelerin %1,3'ü (turun İLK 1,5–5 sn'si) altyazıda bir tur gecikir.
  //
  // 🔴 FİNAL KATMAN BU DEĞERİ HİÇ GÖRMEZ (tier==='draft' değilse minDynamicDb).
  draftMinDynamicDb: 24,
});

/**
 * Sonlu ve pozitif bir sayı mı? (ayar dosyasından gelen çöp değerleri eler)
 *
 * 🔴 ADP-912 — BURASI KAPIYI TAMAMEN ÖLDÜRÜYORDU. `Number(null) === 0` (finite!)
 * ve `agentSettings.defaults()` bu alanlara BİLEREK `null` yazıyor ([[clip-prod-
 * path-default-divergence]] kuralı: "motor ne diyorsa o"). Sonuç: ayar dosyası
 * bir kez yazıldığı ANDAN itibaren dört eşik de 0'a düşüyordu →
 *   `p90 ≥ loudFloor(0)` her zaman DOĞRU → verdict='speech' → ADP-909 kapısı
 *   hiçbir sesi durdurmuyordu. Kullanıcının gerçek uygulamasından ölçülen log:
 *   `kapı: verdict=speech tier=draft/0dB … (p90 0.0024 ≥ loudFloor 0)`
 * ADP-909'un testleri bunu göremedi çünkü hepsi `resolveGateConfig(null)` (ayar
 * NESNESİ yok) çağırıyordu — orada `Number(undefined)=NaN` olduğu için varsayılan
 * doğru çalışıyor. YOKLUK iki farklı değerle ifade ediliyordu ve yalnız biri
 * ölçülmüştü.
 *
 * Kural: `null`/`undefined`/boş dize = "AYAR YOK" → motor varsayılanı. Kullanıcının
 * bilerek yazdığı `0` hâlâ 0'dır (ölçüm kaçış kapıları buna dayanıyor).
 */
function num(v, fallback, { min = 0 } = {}) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/**
 * Ayarlardan eşikleri çöz. Verilmeyen/bozuk her alan motor varsayılanına düşer.
 * `deps.minSpeechMs` (çağrı başına kaçış kapısı) ayarın da ÜSTÜNDEDİR — ölçüm
 * scriptleri ve testler kapıyı tek çağrı için kapatabilsin.
 *
 * ADP-912 — `tier` KATMANI SEÇER, İKİNCİ BİR KAPI DEĞİLDİR: 'draft' verilince
 * yalnız dinamik eşiği `draftMinDynamicDb`'ye çıkar (gerekçe DEFAULTS'ta).
 * Açık `overrides.minDynamicDb` yine HER ŞEYİ ezer (ölçüm kaçış kapısı).
 */
function resolveGateConfig(settings, overrides = {}, tier = 'final') {
  const raw = (settings && settings.jarvis && settings.jarvis.silenceGate) || {};
  const draft = tier === 'draft';
  const dynDefault = draft
    ? num(raw.draftMinDynamicDb, DEFAULTS.draftMinDynamicDb, { min: 0 })
    : num(raw.minDynamicDb, DEFAULTS.minDynamicDb, { min: 0 });
  const cfg = {
    rmsThreshold: num(raw.rmsThreshold, DEFAULTS.rmsThreshold, { min: 0 }),
    minSpeechMs: num(raw.minSpeechMs, DEFAULTS.minSpeechMs, { min: 0 }),
    loudFloor: num(raw.loudFloor, DEFAULTS.loudFloor, { min: 0 }),
    minDynamicDb: dynDefault,
    tier: draft ? 'draft' : 'final',
  };
  if (overrides && overrides.minSpeechMs !== undefined) {
    cfg.minSpeechMs = num(overrides.minSpeechMs, cfg.minSpeechMs, { min: 0 });
  }
  // Dinamik testini tek çağrı için kapatma kapısı (ölçüm/karşılaştırma koşuları).
  if (overrides && overrides.minDynamicDb !== undefined) {
    cfg.minDynamicDb = num(overrides.minDynamicDb, cfg.minDynamicDb, { min: 0 });
  }
  return cfg;
}

/** WAV `data` chunk'ının başlangıcı (44 bayt SABİT DEĞİL — ffmpeg LIST chunk'ı ekler). */
function findWavDataOffset(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return -1;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') return off + 8;
    off += 8 + size + (size % 2);
  }
  return -1;
}

/** Sıralı diziden yüzdelik. */
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

/**
 * 16-bit PCM WAV → kare istatistikleri. SAF (Buffer girer, sayı çıkar).
 *
 * `rms/peak/speechMs/frames` ADP-813'ün `pcmSpeechStats`'ıyla BİREBİR aynıdır
 * (whisperLocal oradan buraya devretti; eski testler aynen geçer). Yeni alanlar:
 * `p10/p50/p90/dynamicDb` — konuşmayı durağan gürültüden ayıran ölçüt.
 */
function frameStats(wav, { rmsThreshold = DEFAULTS.rmsThreshold } = {}) {
  const buf = Buffer.isBuffer(wav) ? wav : Buffer.from(wav || []);
  const empty = { rms: 0, peak: 0, speechMs: 0, frames: 0, p10: 0, p50: 0, p90: 0, dynamicDb: 0 };
  const dataOffset = findWavDataOffset(buf);
  if (dataOffset < 0 || buf.length - dataOffset < 2) return empty;
  const samples = Math.floor((buf.length - dataOffset) / 2);
  const frameLen = Math.round((SAMPLE_RATE * FRAME_MS) / 1000);
  let peak = 0;
  let sumSq = 0;
  let speechFrames = 0;
  const frameRms = [];
  for (let f = 0; f + frameLen <= samples; f += frameLen) {
    let fs2 = 0;
    for (let i = 0; i < frameLen; i += 1) {
      const v = buf.readInt16LE(dataOffset + (f + i) * 2) / 32768;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      fs2 += v * v;
    }
    sumSq += fs2;
    const r = Math.sqrt(fs2 / frameLen);
    frameRms.push(r);
    if (r > rmsThreshold) speechFrames += 1;
  }
  const frames = frameRms.length;
  if (!frames) return empty;
  const sorted = [...frameRms].sort((a, b) => a - b);
  const p10 = percentile(sorted, 10);
  const p50 = percentile(sorted, 50);
  const p90 = percentile(sorted, 90);
  // 🪤 p10 = 0 olabilir ve bu İKİ ÇOK FARKLI ŞEY demektir:
  //   • p90 da 0 → hiç enerji yok (dijital sessizlik)          → dinamik 0
  //   • p90 > 0  → bazı kareler TAM SIFIR, bazıları dolu       → dinamik ÇOK YÜKSEK
  // İkincisi donanım gürültü kapılı (noise gate) mikrofonlarda gerçek konuşmanın
  // normal imzasıdır — kendi sentetik konuşma üreticim bunu ortaya çıkardı. Oranı
  // körü körüne 0 saymak o kullanıcıların sesini "durağan gürültü" diye REDDEDERDİ.
  // Payda 16-bit'in en küçük adımına (1 LSB) sıkıştırılır: sonsuz yok, ama yüksek.
  const LSB = 1 / 32768;
  const dynamicDb = p90 > 0 ? 20 * Math.log10(p90 / Math.max(p10, LSB)) : 0;
  return {
    rms: Math.sqrt(sumSq / (frames * frameLen)),
    peak,
    speechMs: speechFrames * FRAME_MS,
    frames,
    p10,
    p50,
    p90,
    dynamicDb,
  };
}

/**
 * Bu ses STT'ye gitmeli mi?
 * → { speech, verdict:'silence'|'steady-noise'|'speech', why, stats, cfg }
 *
 * `verdict` teşhis içindir ve LOGA yazılır (ADP-909 (a) maddesi): "sessizlikte
 * ne oldu?" sorusu ancak kapının NE gördüğü ve NE karar verdiği kayıtlıysa
 * cevaplanabilir.
 */
function classifySegment(stats, cfg = DEFAULTS) {
  const s = stats || {};
  const speechMs = Number(s.speechMs) || 0;
  const p90 = Number(s.p90) || 0;
  const dyn = Number(s.dynamicDb) || 0;
  if (speechMs < cfg.minSpeechMs) {
    return { speech: false, verdict: 'silence', why: `speechMs ${speechMs} < ${cfg.minSpeechMs}` };
  }
  if (p90 >= cfg.loudFloor) {
    return { speech: true, verdict: 'speech', why: `p90 ${p90.toFixed(4)} ≥ loudFloor ${cfg.loudFloor}` };
  }
  if (dyn < cfg.minDynamicDb) {
    return {
      speech: false,
      verdict: 'steady-noise',
      why: `alçak seviye (p90 ${p90.toFixed(4)}) + düz enerji (${dyn.toFixed(1)} dB < ${cfg.minDynamicDb} dB)`,
    };
  }
  return { speech: true, verdict: 'speech', why: `dinamik ${dyn.toFixed(1)} dB ≥ ${cfg.minDynamicDb} dB` };
}

/**
 * Tek adımda: WAV → { speech, verdict, why, stats, cfg }.
 * Çağıranın (whisperLocal / jarvisVoice) tek ihtiyacı budur.
 */
function evaluateWav(wav, { settings = null, overrides = {}, tier = 'final' } = {}) {
  const cfg = resolveGateConfig(settings, overrides, tier);
  const stats = frameStats(wav, { rmsThreshold: cfg.rmsThreshold });
  const decision = classifySegment(stats, cfg);
  return { ...decision, stats, cfg };
}

/** Loga tek satır — sır içermez, yalnız sayı. (ADP-909 (a): kanıt üretilebilir olsun.) */
function describe(evaluation) {
  const s = (evaluation && evaluation.stats) || {};
  const cfg = (evaluation && evaluation.cfg) || {};
  return [
    `verdict=${evaluation && evaluation.verdict}`,
    // ADP-912 — hangi KATMANIN eşiğiyle karar verildiği loga yazılır; yoksa
    // "kapı neden geçirdi/durdurdu" sorusu kayıttan cevaplanamaz.
    `tier=${cfg.tier || 'final'}/${cfg.minDynamicDb === undefined ? '-' : cfg.minDynamicDb}dB`,
    `rms=${(Number(s.rms) || 0).toFixed(5)}`,
    `peak=${(Number(s.peak) || 0).toFixed(4)}`,
    `p90=${(Number(s.p90) || 0).toFixed(4)}`,
    `dyn=${(Number(s.dynamicDb) || 0).toFixed(1)}dB`,
    `speechMs=${Number(s.speechMs) || 0}`,
    `frames=${Number(s.frames) || 0}`,
    `(${(evaluation && evaluation.why) || '-'})`,
  ].join(' ');
}

module.exports = {
  FRAME_MS,
  SAMPLE_RATE,
  DEFAULTS,
  resolveGateConfig,
  findWavDataOffset,
  percentile,
  frameStats,
  classifySegment,
  evaluateWav,
  describe,
};
