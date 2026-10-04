// AGENTX-RT-3 — AKAN TTS: ses, DOSYA BİTMEDEN çalmaya başlar.
//
// ── ÖLÇÜLEN SORUN (tahmin değil) ────────────────────────────────────────────
// Bugünkü yol (`speakOpenAI`, ADP-812) şudur:
//     fetch(...) → await res.arrayBuffer() → base64 → renderer <audio>
// Yani ilk örnek hoparlöre gitmeden ÖNCE SON bayt beklenir. AGENTX-RT-R1 bunu
// 2454–3048 ms olarak ölçmüştü.
//
// ── ÖLÇÜM 1: format (2026-09-06, aynı makine/anahtar, 81 karakter) ──────────
//   model            format  ilk bayt   son bayt
//   tts-1-hd         mp3      2996 ms    3390 ms
//   tts-1-hd         pcm      2263 ms    2833 ms
//   gpt-4o-mini-tts  mp3       872 ms    1916 ms
//   gpt-4o-mini-tts  pcm       512 ms    1945 ms
// → `response_format:'pcm'` ilk baytı mp3'ten ERKEN verir (mp3 kodlayıcı tampon
//   biriktiriyor, ham PCM biriktirmiyor) ve son baytı beklemek ilk baytın
//   ÜSTÜNE 0.6–1.4 s bindiriyor. Kazanç buradadır.
//
// ── ÖLÇÜM 2: KARTIN VARSAYIMINI ÇÜRÜTEN ÖLÇÜM ──────────────────────────────
// Kart "cümle/soluk sınırında böl, ilk kısa parça erken çalsın" diyordu. Ölçtük:
//   metin:            6c     18c    46c    81c    160c
//   tts-1-hd ilkBayt  2557   2737   2053   2543   2490 ms   (üretilen ses 3.2→12.8 s)
//   4o-mini  ilkBayt   476    657    629   2740   1077 ms   (üretilen ses 5.3→18.6 s)
// İLK BAYT GECİKMESİ METİN UZUNLUĞUNDAN BAĞIMSIZ. Sunucu üretirken akıtıyor;
// dalgalanma sunucu gürültüsü, uzunluk eğilimi YOK. Sonuç: metni bölmek ilk sesi
// ERKENE ALMAZ — üstüne her grup için bir HTTP turu daha ekler ve cümle ortasından
// kesilen prozodiyi bozar. Bu yüzden VARSAYILAN BÖLME KAPALIDIR (`max` 400 karakter):
// tipik cevap TEK istektir ve ilk baytından itibaren çalar.
// Bölme makinesi yine de duruyor ve iki yerde gerekiyor: (a) gerçekten uzun metin
// (tek isteğin sesi dakikaları bulur, iptal maliyeti büyür), (b) metnin PARÇA PARÇA
// geldiği gelecek yol (RT-4 erken niyet / akan beyin) — kuyruk oradan beslenecek.
//
// ── NEDEN PCM (mp3 değil) ───────────────────────────────────────────────────
// Yarım mp3 çalınamaz: çerçeve hizası ve MediaSource gerekir. Ham PCM'in
// konteyneri YOKTUR → her bayt çifti bir örnektir, akış istediğin yerden
// kesilip çalınabilir. Üstelik bu üründe PCM kuyruğunu çalan oynatıcı ZATEN VAR
// (ADP-827 `grokPlayer`): yeniden yazılmadı, ÇAĞRILDI.
//
// ── SÖZLEŞME ────────────────────────────────────────────────────────────────
// • `onChunk` ses biriktikçe çağrılır. İLK parça "ilk bayt" DEĞİL, KESİNTİSİZ
//   çalınabilecek ilk 100 ms'tir (START_BYTES) — gerekçe orada, e2e ölçtü.
// • `signal` iptal edildiğinde yoldaki istek DE kesilir (jeton/bant yanmaz) ve
//   `onChunk` bir daha ASLA çağrılmaz.
// • Metin KAYBOLMAZ: `splitBreathGroups(t).join(' ')` normalize edildiğinde t'ye
//   eşittir (birim testi bunu ölçer). Sessiz kırpma bu kartın en kötü kusuru
//   olurdu — kapı orada.
'use strict';

const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech';

/** OpenAI `response_format:'pcm'` = 24 kHz, 16-bit signed LE, mono (sabit). */
const PCM_RATE = 24000;

/**
 * Grup üst sınırı — ÖLÇÜMLE seçildi, sezgiyle değil. İlk bayt uzunluktan bağımsız
 * olduğu için bölmek ilk sesi erkene almıyor; 400 karakter tipik cevabı TEK
 * istekte bırakır. Bunun üstü gerçekten uzun metindir: orada bölmek iptal
 * maliyetini ve tek isteğin başarısızlık yükünü düşürür.
 */
const GROUP_MAX = 400;
/** Bir grup en az bu kadar karakter olmadan soluk sınırından bölünmez. */
const GROUP_MIN = 24;

/** İlk parçadan SONRA parçalar bu boyuta ulaşana kadar birleştirilir (IPC israfı). */
const COALESCE_BYTES = 3840; // 1920 örnek ≈ 80 ms @24 kHz
/** …ama en fazla bu kadar beklenir: ağ damlıyorsa ses kesilmesin. */
const COALESCE_MAX_MS = 60;
/**
 * 🔴 BAŞLANGIÇ ÖN-TAMPONU — GERÇEK UYGULAMADA ÖLÇÜLEN KUSURUN İLACI.
 *
 * İlk sürüm "ilk bayt gelir gelmez çal" diyordu ve e2e onu KIRMIZI yaptı:
 * `enBüyükBoşluk = 958 ms`. Sebep ölçüldü — OpenAI'nin ilk gönderdiği şey
 * 180 baytlık bir BAŞLIK PARÇASI (≈3.8 ms ses); ASIL üretim ondan ~950 ms
 * sonra akmaya başlıyor. O 3.8 ms'i çalmak "tık… (bir saniye sessizlik) …cümle"
 * demekti: beklemekten DAHA KÖTÜ.
 *
 * Doğru kural "ilk BAYT" değil, "KESİNTİSİZ çalınabilecek ilk ses": 100 ms'lik
 * ses birikene kadar (ya da akış bitene kadar) beklenir. Veri gerçek zamandan
 * ~7 kat hızlı aktığı için bu eşik ilk sese ölçülebilir bir gecikme EKLEMEZ,
 * ama deliği tamamen kapatır.
 */
const START_BYTES = 4800; // 2400 örnek = 100 ms @24 kHz

// Cümle sonu: . ! ? … — ama ondalık sayının ("24.99") ve kısaltmanın ortasında değil.
const SENTENCE_END = /([.!?…]+)(\s+|$)/g;
// Soluk sınırı: virgül/noktalı virgül/iki nokta/tire — cümle çok uzunsa burada bölünür.
const BREATH_MARK = /[,;:—–]\s/g;

/**
 * Metni soluk gruplarına böl (cümle sınırı > soluk sınırı; kelime ortası ASLA).
 *
 * ÖLÇÜM 2 gereği varsayılan `max` büyüktür: tipik cevap TEK grup olur ve ilk
 * baytından itibaren çalar. Bölme yalnız gerçekten uzun metinde ve metnin parça
 * parça geldiği yolda devreye girer.
 *
 * Sözleşme: dönen grupların birleşimi, boşluk normalizasyonu dışında girdiye
 * EŞİTTİR. Tek bir kelimenin bile düşmesi "asistan cümlenin yarısını yuttu"
 * demektir — testte ölçülür.
 */
function splitBreathGroups(text, { max = GROUP_MAX, min = GROUP_MIN } = {}) {
  const clean = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!clean) return [];

  // 1) Cümlelere ayır (noktalama cümlede KALIR — prozodi ona bağlı).
  const sentences = [];
  let last = 0;
  SENTENCE_END.lastIndex = 0;
  let m;
  while ((m = SENTENCE_END.exec(clean)) !== null) {
    const endIdx = m.index + m[1].length;
    const before = clean[m.index - 1];
    const after = clean[endIdx + (m[2] ? m[2].length : 0)];
    // "24.99" / "3.5" — iki rakam arasındaki nokta cümle sonu DEĞİLDİR.
    if (m[1] === '.' && /\d/.test(before || '') && /\d/.test(after || '')) continue;
    sentences.push(clean.slice(last, endIdx).trim());
    last = endIdx;
  }
  if (last < clean.length) sentences.push(clean.slice(last).trim());

  // 2) `max`ı aşan TEK cümleyi soluk sınırından böl (kelime ortasından değil).
  const parts = [];
  for (const s of sentences) {
    if (!s) continue;
    let rest = s;
    while (rest.length > max) {
      const cut = breathCut(rest, max, min);
      if (cut <= 0) break;
      parts.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) parts.push(rest);
  }

  // 3) Küçük cümleleri `max`a kadar birleştir — her grup bir HTTP turudur ve
  //    ölçüm gereği fazladan tur ilk sesi erkene ALMAZ, yalnız maliyet ekler.
  const groups = [];
  for (const p of parts) {
    const prev = groups.length ? groups[groups.length - 1] : null;
    if (prev !== null && prev.length + 1 + p.length <= max) groups[groups.length - 1] = `${prev} ${p}`;
    else groups.push(p);
  }
  return groups.filter(Boolean);
}

/** `limit`i aşmayan en iyi kesme noktası: önce soluk işareti, sonra kelime sonu. */
function breathCut(s, limit, min) {
  let best = -1;
  BREATH_MARK.lastIndex = 0;
  let m;
  while ((m = BREATH_MARK.exec(s)) !== null) {
    const idx = m.index + 1; // noktalama parçada KALIR
    if (idx > limit) break;
    if (idx >= min) best = idx;
  }
  if (best > 0) return best;
  // Soluk işareti yok → son kelime sınırı.
  const space = s.lastIndexOf(' ', limit);
  if (space >= min) return space;
  // Tek uzun kelime: bölme (kelimeyi ikiye ayırmak sesi bozar).
  return -1;
}

/** PCM16 bayt sayısı → saniye. */
function pcmSeconds(bytes, rate = PCM_RATE) {
  return bytes / 2 / rate;
}

/**
 * Bir soluk grubunu OpenAI'den AKITARAK sesler; her PCM parçasını `onChunk`e verir.
 * Dönüş: { ok, bytes, firstByteMs, ms } | { ok:false, reason, detail }.
 */
async function streamGroup({ res, index, group, onChunk, t0, signal, rate = PCM_RATE, coalesceBytes = COALESCE_BYTES, coalesceMaxMs = COALESCE_MAX_MS, startBytes = START_BYTES, now = Date.now }) {
  const reader = res.body.getReader();
  let carry = null;            // tek sayıda bayt kaldıysa (yarım örnek) taşınır
  let pending = [];            // birleştirme tamponu
  let pendingBytes = 0;
  let pendingSince = 0;
  let bytes = 0;
  let firstByteMs = null;
  let emitted = 0;

  const flush = (first) => {
    if (!pendingBytes) return;
    const buf = Buffer.concat(pending, pendingBytes);
    pending = [];
    pendingBytes = 0;
    onChunk({ index, group, base64: buf.toString('base64'), rate, bytes: buf.length, first: !!first, ms: now() - t0 });
    emitted += 1;
  };

  for (;;) {
    if (signal && signal.aborted) { try { await reader.cancel(); } catch { /* zaten kapalı */ } return { ok: false, reason: 'cancelled', bytes, firstByteMs, emitted }; }
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || !value.length) continue;
    let chunk = Buffer.from(value);
    if (carry) { chunk = Buffer.concat([carry, chunk]); carry = null; }
    if (chunk.length % 2 === 1) { carry = chunk.subarray(chunk.length - 1); chunk = chunk.subarray(0, chunk.length - 1); }
    if (!chunk.length) continue;
    bytes += chunk.length;
    pending.push(chunk);
    pendingBytes += chunk.length;
    if (firstByteMs === null) firstByteMs = now() - t0; // ağ payı (kanıt/teşhis)
    if (!emitted) {
      // BAŞLANGIÇ: kesintisiz çalınabilecek kadar ses birikmeden BAŞLAMA
      // (180 baytlık başlık parçasını çalmak 958 ms'lik delik üretiyordu).
      if (pendingBytes >= startBytes) {
        flush(true);
        pendingSince = now();
      }
      continue;
    }
    if (pendingBytes >= coalesceBytes || now() - pendingSince >= coalesceMaxMs) {
      flush(false);
      pendingSince = now();
    }
  }
  flush(!emitted); // akış eşiğe hiç ulaşmadıysa biriken ses YİNE çalınır (kayıp yok)
  return { ok: true, bytes, firstByteMs, emitted };
}

/**
 * AKAN TTS — metni soluk gruplarına böler, gruplar SIRAYLA çalınacak şekilde
 * PCM parçalarını `onChunk`e akıtır; bir sonraki grup önceki çalarken sentezlenir.
 *
 * Boru hattı: aynı anda en çok 2 istek uçar (şu anki + bir sonraki). Hepsini
 * birden atmak jeton/limit riskidir; hiç önden atmamak ise gruplar arasında
 * DUYULUR boşluk demektir (ölçülüyor: `gapMs`).
 */
async function streamOpenAiSpeech({
  text,
  voice,
  model,
  apiKey,
  fetchImpl = fetch,
  signal,
  onChunk,
  max = GROUP_MAX,
  rate = PCM_RATE,
  coalesceBytes = COALESCE_BYTES,
  coalesceMaxMs = COALESCE_MAX_MS,
  now = Date.now,
  url = OPENAI_TTS_URL,
} = {}) {
  const clean = String(text == null ? '' : text).trim();
  if (!clean) return { ok: false, reason: 'empty-text' };
  if (!apiKey) return { ok: false, reason: 'no-openai-key' };
  if (typeof onChunk !== 'function') return { ok: false, reason: 'no-sink' };

  const groups = splitBreathGroups(clean, { max });
  if (!groups.length) return { ok: false, reason: 'empty-text' };

  const t0 = now();
  const inflight = new Map();
  const send = (i) => {
    if (i >= groups.length || inflight.has(i)) return;
    inflight.set(i, fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, voice, input: groups[i], response_format: 'pcm' }),
      signal,
    }).catch((e) => ({ __err: String((e && e.message) || e) })));
  };
  send(0);
  send(1); // boru hattı: ilk grup çalarken ikincisi zaten yolda

  let bytes = 0;
  let firstByteMs = null;
  let emitted = 0;
  const groupFirstByteMs = [];

  for (let i = 0; i < groups.length; i++) {
    if (signal && signal.aborted) return { ok: firstByteMs !== null, reason: 'cancelled', groups: groups.length, groupsDone: i, bytes, firstByteMs, emitted, ms: now() - t0, groupFirstByteMs };
    const res = await inflight.get(i);
    send(i + 2);
    if (!res || res.__err) {
      const reason = 'tts-fetch-failed';
      if (i === 0) return { ok: false, reason, detail: res && res.__err, groups: groups.length };
      return { ok: true, truncated: true, failedAt: i, reason, groups: groups.length, groupsDone: i, bytes, firstByteMs, emitted, ms: now() - t0, groupFirstByteMs };
    }
    if (!res.ok) {
      const detail = await (res.text ? res.text().catch(() => '') : Promise.resolve(''));
      const reason = `tts-api-${res.status}`;
      if (i === 0) return { ok: false, reason, detail, groups: groups.length };
      return { ok: true, truncated: true, failedAt: i, reason, detail, groups: groups.length, groupsDone: i, bytes, firstByteMs, emitted, ms: now() - t0, groupFirstByteMs };
    }
    const out = await streamGroup({ res, index: i, group: groups[i], onChunk, t0, signal, rate, coalesceBytes, coalesceMaxMs, now });
    bytes += out.bytes;
    emitted += out.emitted;
    groupFirstByteMs.push(out.firstByteMs);
    if (firstByteMs === null && out.firstByteMs !== null) firstByteMs = out.firstByteMs;
    if (!out.ok) return { ok: firstByteMs !== null, reason: out.reason, groups: groups.length, groupsDone: i, bytes, firstByteMs, emitted, ms: now() - t0, groupFirstByteMs };
  }

  return {
    ok: true,
    groups: groups.length,
    groupsDone: groups.length,
    bytes,
    firstByteMs,
    emitted,
    ms: now() - t0,
    groupFirstByteMs,
    seconds: pcmSeconds(bytes, rate),
    rate,
  };
}

module.exports = {
  splitBreathGroups,
  breathCut,
  streamOpenAiSpeech,
  streamGroup,
  pcmSeconds,
  OPENAI_TTS_URL,
  PCM_RATE,
  GROUP_MAX,
  COALESCE_BYTES,
  COALESCE_MAX_MS,
  START_BYTES,
};
