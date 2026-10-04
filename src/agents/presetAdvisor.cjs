// B-06 — "Ne geliştirmek istiyorsun?" → MODEL ÖNERİSİ (ONBOARDING-PRESETS-SPEC §4.2'nin v2'si).
//
// ADP-695 v1 yerel/deterministik bir kelime eşleştiricidir (teamPresets.recommendPreset)
// ve KALIYOR — bu dosya onun ÜSTÜNE bir katman koyar, yerine geçmez:
//
//   yazılan metin → (bu modül) claude -p + KATI JSON → doğrulama → presetId + gerekçe
//                 → başarısızsa çağıran YEREL eşleşmeye, o da yoksa VARSAYILAN şablona düşer
//
// ÜÇ KURAL (spec §4.2 + §1.3 "tek LLM çağrısı yetmez, doğrulama ayrı adımdır"):
//   1. ÇIKTI KATALOĞA HAPSEDİLİR — model uydurma bir `presetId` döndürürse cevap
//      REDDEDİLİR (kurulum ekranında var olmayan bir şablona düşmek, sessiz bir
//      "hiçbir şey olmadı" ekranı demektir).
//   2. ZAMAN AŞIMI KISA — onboarding'in ortasındayız; 15 sn'yi geçen bir öneri,
//      öneri değil engeldir. Süre dolunca reason='timeout' döner, UI yerel yola geçer.
//   3. MOTOR YOKSA HİÇ DENENMEZ — `claude` kurulu değilken spawn hatası beklemek
//      kullanıcıya boşuna 15 sn bekletir; çağıran `jarvis:config` ile zaten biliyor.
//
// GİZLİLİK: serbest metin kullanıcının KENDİ motoruna gider (bizim bir servisimize
// değil) ve hiçbir yere yazılmaz — ne log'a ne DB'ye (spec §4.2 "Gizlilik" satırı).
//
// Bu dosya SAF + enjekte edilebilir (spawnImpl) → electron/presetAdvisor.test.cjs
// gerçek CLI olmadan hem başarı hem her hata sınıfını koşar.

const { spawn } = require('node:child_process');

/** Onboarding'de kabul edilebilir üst sınır (bkz. kural 2). */
const ADVISOR_TIMEOUT_MS = 15000;

/**
 * Modele giden TEK çağrının promptu. Katalog PROMPTA GÖMÜLÜ gelir (renderer
 * gönderir) — böylece şablon listesi büyüdüğünde bu dosya değişmez.
 *
 * @param {string} text        kullanıcının serbest metni
 * @param {Array<{id:string,name:string,tagline:string}>} presets
 * @param {'tr'|'en'} locale   gerekçenin yazılacağı dil
 */
function buildAdvisorPrompt(text, presets, locale) {
  const list = presets
    .map((p) => `- ${p.id}: ${p.name} — ${p.tagline}`)
    .join('\n');
  const reasonLang = locale === 'en' ? 'English' : 'Turkish';
  return [
    'You are helping a new user of a virtual AI office app pick a starter team template.',
    '',
    'The user wrote what they want to build:',
    `"""${String(text).slice(0, 600)}"""`,
    '',
    'Available templates (id: name — description):',
    list,
    '',
    'Pick the SINGLE best template for this user.',
    `Answer with ONLY a JSON object, no prose, no markdown fence:`,
    `{"presetId":"<one id from the list above>","reason":"<1-2 short sentences in ${reasonLang} explaining why>"}`,
    'The presetId MUST be one of the ids listed above. Never invent one.',
  ].join('\n');
}

/**
 * `claude -p --output-format json` çıktısından JSON nesnesini çıkarır.
 *
 * İki katman: dış zarf (`{"result":"..."}`) ve zarfın İÇİNDEKİ model metni. CLI
 * sürümleri arasında zarf değişebildiği için önce ham metinde, sonra zarfın
 * `result` alanında aranır — ikisi de olmazsa null.
 */
function extractJsonObject(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const candidates = [];
  const trimmed = raw.trim();
  candidates.push(trimmed);
  try {
    const envelope = JSON.parse(trimmed);
    if (envelope && typeof envelope === 'object') {
      if (typeof envelope.result === 'string') candidates.push(envelope.result.trim());
      // Zarfın kendisi zaten cevabı taşıyor olabilir.
      if (typeof envelope.presetId === 'string') return envelope;
    }
  } catch {
    /* zarf değil — ham metinde ararız */
  }
  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    for (let cut = end; cut > start; cut = candidate.lastIndexOf('}', cut - 1)) {
      try {
        const parsed = JSON.parse(candidate.slice(start, cut + 1));
        if (parsed && typeof parsed === 'object' && typeof parsed.presetId === 'string') {
          return parsed;
        }
      } catch {
        /* bir sonraki kapanış parantezini dene */
      }
    }
  }
  return null;
}

/**
 * Model cevabını KATALOĞA HAPSEDEREK doğrular (kural 1).
 *
 * @returns {{ok:true,presetId:string,reason:string}|{ok:false,reason:string,detail?:string}}
 */
function parseAdvisorResponse(raw, allowedIds) {
  const parsed = extractJsonObject(raw);
  if (!parsed) return { ok: false, reason: 'parse-failed', detail: String(raw || '').slice(0, 200) };
  const presetId = String(parsed.presetId || '').trim();
  if (!allowedIds.includes(presetId)) {
    return { ok: false, reason: 'unknown-preset', detail: presetId.slice(0, 60) };
  }
  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, 400) : '';
  return { ok: true, presetId, reason };
}

/**
 * Tek çağrı. Hata SINIFLARI ayrı döner (spawn-failed / timeout / parse-failed /
 * unknown-preset) — UI hepsini aynı görünür yedeğe indirger ama teşhis kaybolmaz.
 */
function recommendWithClaude({
  text,
  presets,
  locale = 'tr',
  claudeBin = 'claude',
  timeoutMs = ADVISOR_TIMEOUT_MS,
  spawnImpl = spawn,
  env = process.env,
}) {
  return new Promise((resolve) => {
    const list = Array.isArray(presets) ? presets : [];
    if (!String(text || '').trim() || list.length === 0) {
      resolve({ ok: false, reason: 'empty-input' });
      return;
    }
    const allowedIds = list.map((p) => String(p.id));
    const prompt = buildAdvisorPrompt(text, list, locale);
    let child;
    try {
      // stdin KAPALI: açık boru `claude`ı 3 sn stdin beklemeye sokuyor (ADP-812).
      child = spawnImpl(claudeBin, ['-p', prompt, '--output-format', 'json'], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ ok: false, reason: 'spawn-failed', detail: String((e && e.message) || e) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(val);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* zaten gitmiş */
      }
      finish({ ok: false, reason: 'timeout' });
    }, timeoutMs);
    child.stdout && child.stdout.on('data', (d) => (stdout += d));
    child.stderr && child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) =>
      finish({ ok: false, reason: 'proc-error', detail: String((e && e.message) || e) }),
    );
    child.on('close', () => {
      const parsed = parseAdvisorResponse(stdout, allowedIds);
      if (parsed.ok) finish(parsed);
      else finish({ ...parsed, detail: parsed.detail || stderr.slice(0, 200) });
    });
  });
}

module.exports = {
  ADVISOR_TIMEOUT_MS,
  buildAdvisorPrompt,
  extractJsonObject,
  parseAdvisorResponse,
  recommendWithClaude,
};
