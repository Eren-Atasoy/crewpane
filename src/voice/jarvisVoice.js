'use strict';

// ADP-121 (ADR-009 Faz 120a) — Jarvis voice core (MAIN side).
//
// Three capabilities, each a THIN wrapper over an existing local/remote facility
// (ADR-009 "reuse over rebuild"):
//   • STT   — OpenAI Whisper (whisper-1). Key read from crewpane/.env.local ONLY
//             (never put into process.env → never leaks to spawned agent panes;
//             never logged/committed — .env.local is gitignored).
//   • Brain — Claude orchestrator via `claude -p` (headless) → a STRICT JSON
//             decision {action, department, objective, speak}. Falls back to a
//             deterministic Turkish intent parser when claude is unavailable
//             (offline / not authed / slow) so the chain never hard-fails.
//   • TTS   — macOS `say` (Yelda tr_TR, local/free — ADR-009 POC PASS) → .aiff +
//             afplay playback. Barge-in via stopPlayback().
//
// EXECUTION (delegate / status) lives in the RENDERER (window.crewpaneDelegation
// reuse + window.ptyApi) — this module only DECIDES + SPEAKS. The pure helpers
// (env parse, JSON extraction, decision normalize, intent parse) are exported and
// unit-tested with `node --test` (no Electron, fakes for fetch/spawn).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto'); // ADP-812 — TTS önbellek anahtarı (sha1)
const { spawn, execFile, execFileSync } = require('node:child_process');
// augmentedPath: same PATH fix agentRunner uses — GUI apps get truncated launchd PATH,
// so `claude` isn't found without explicitly adding Homebrew/npm dirs.
const { augmentedPath } = require('../agents/agentRunner.js');
// ADP-322 — yürütücü/fan-out politikası (saf, deterministik). Beynin iyi niyetine
// GÜVENİLMEZ: kullanıcı direktifi burada, kodla zorlanır (bkz. applyExecutorPolicy).
const fanoutPolicy = require('../agents/fanoutPolicy.cjs');
// ADP-444 — prompt'suz toplu terminal: sayı/motor parse'ı + onay politikası SAF modülde
// (LLM yalnız niyet sınıflandırır; sayılar transkriptten deterministik çıkar).
const spawnSpec = require('../agents/spawnSpec.cjs');
// E2E-MUTE-01 — test koşusunda hoparlöre giden çıkışı kapatan kapı. SENTEZ KALIR
// (kanıt baytı üretilir), yalnız `say` doğrudan-oynatması ve `afplay` açılmaz.
// Ürün yolunda bayrak yoktur → isTtsMuted() false → davranış birebir eski.
const ttsMute = require('./ttsMute.cjs');
// ADP-854 — TÜRKÇE MORFOLOJİ. Kural yolundaki fiil eşleşmeleri artık çıplak alt-dize
// DEĞİL, ek izin listesiyle jeton eşleşmesidir: "kapatma" ≠ "kapat", "açıklama" ≠ "aç".
// ADP-885/st1 — i18n-exempt: intent-token. Bu dosyadaki Türkçe regex öbekleri
// KULLANICININ SÖYLEDİĞİ kalıplardır (girdi), arayüz metni değil → çevrilmez.
// Kelime kümesi `intentLexicon.cjs`te; buradaki desenler dilbilgisel kalıptır.
const morph = require('./turkishMorph.cjs');
// ADP-854 — hedef çözümleme (ad / yakın-ad / ROL) + rapor id öneki. Bulunamayan hedef
// SESSİZCE başkasına gitmez: `unresolvedName`/`unresolvedRole` ile SORULUR.
const entityResolve = require('../services/entityResolve.cjs');
// ADP-883 — AÇILABİLİR YÜZEY KAYDI (Ayarlar + 12 alt kategori, org paneli, dock
// görünümleri). Kural yolu da yürütücü de AYNI kaydı okur; yeni bir ayar sayfası
// eklendiğinde burada tek satır büyür, yeni `if` yazılmaz.
const uiSurfaces = require('../services/uiSurfaces.cjs');
// ADP-921 — SESLE YÖNETİLEBİLİR KONTROL KAYDI (ekranın İÇİNDEKİ kontroller: dil,
// tema, workspace). `uiSurfaces` EKRANI açar, bu kayıt ekranın kontrolünü SÜRER.
// Kural yolu op listesi, normalize doğrulaması ve beynin prompt satırı ÜÇÜ DE
// buradan türer — elle yazılmış ikinci bir liste yok (ADR-AGENTX-ACTION-REGISTRY).
const uiControls = require('../services/uiControls.cjs');
// ADP-749 — kullanıcıya GÖRÜNEN/DUYULAN ad tek kaynaktan (ADP-708 bu iki yüzeyi
// kaçırmıştı: TTS önizlemesi "Ben Jarvis" diye SESLİ söylüyordu, beyin sistem promptu
// da kendini "Jarvis" tanıtıyordu → asistan yanıtlarında telifli adı kullanıyordu).
const { VOICE_NAME } = require('./voiceName.cjs');
// ADP-813 (Faz 1) — yerel STT (whisper.cpp kalıcı sunucusu). Bulut yolu fallback.
const whisperLocal = require('./whisperLocal.cjs');
// ADP-815 (Faz 3) — kalıcı `claude` oturumu (KATMAN 2 beyni). Taşıyıcı; karar
// ayrıştırma/normalizasyon bu dosyada (tek kaynak) kalır.
const claudeBrainSession = require('../agents/claudeBrainSession.cjs');
// ADP-848 — TTS SAĞLAYICI KAYDI (ElevenLabs / Azure / OpenAI / yerel `say`) +
// dürüst maliyet + Türkçe önizleme cümlesi. Bu dosya yalnız TESLİMİ (oynatma,
// önbellek, barge-in) sahiplenir; hangi motorun ne kadar tuttuğu ORADA yaşar.
const ttsProviders = require('./ttsProviders.cjs');
// AGENTX-RT-3 — AKAN TTS (ilk bayt çalar, son bayt beklenmez). Ölçüm modülün başında.
const ttsStream = require('./ttsStream.cjs');
// ADP-915 — YETENEK → MOTOR kaydı (beyin / STT / TTS + fatura kime çıkar).
// STT motorlarının listesi ve varsayılanı ORADA yaşar; bu dosya onu OKUR.
const engineCatalog = require('../agents/engineCatalog.cjs');

const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';
const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech';
const WHISPER_MODEL = 'whisper-1';
const SAY_VOICE = 'Yelda'; // tr_TR (ADR-009 POC: 156KB .aiff produced, PASS)
const CLAUDE_TIMEOUT_MS = 30000;

// OpenAI TTS — available voices + defaults.
const TTS_VOICES = ['alloy', 'echo', 'fable', 'nova', 'onyx', 'shimmer'];
const DEFAULT_TTS_VOICE = 'nova';
// ADP-812 (Faz 0) — varsayılan `tts-1-hd` DEĞİL. ADP-804 ölçümü: tts-1-hd 2454–3585 ms,
// gpt-4o-mini-tts 944–1890 ms — aynı metin, aynı makine. Kalite farkı bu üründeki
// kısa cümlelerde duyulmuyor, gecikme farkı duyuluyor. Ayarlardan `jarvis.ttsModel`
// ile geri alınabilir.
const DEFAULT_TTS_MODEL = 'gpt-4o-mini-tts';
const TTS_PREVIEW_TEXT = `Merhaba! Ben ${VOICE_NAME}. Nasıl yardımcı olabilirim?`;

// ADP-812 (Faz 0) — VAD kuyruk-sessizliği. ADP-132'de 2500 ms'ye çıkarılmıştı
// ("cümlemi bitirmeden kesiyor"); ADP-804 ölçtü ki bu tek başına algılanan
// gecikmenin ~1.9 s'si. Kesilme koruması artık SÜREYE değil `minRecordMs` +
// `minSpeechMs` TABANLARINA dayanıyor (onlar değişmedi), o yüzden pencere
// kısaltılabiliyor. Kullanıcı yavaş konuşuyorsa Ayarlar → `jarvis.silenceMs`.
//
// 🔴 ADP-854B — 600 ms ÖLÇÜMLE ÇÜRÜTÜLDÜ. Eren'in kendi sesiyle kayıtlı 20 Türkçe
// cümlede (docs/agent-results/ADP-331-bench/audio/real/quiet) ürünün KENDİ VAD
// parametreleriyle ölçülen cümle-İÇİ duraklamalar: 32 duraklama · p50 1500 ms ·
// p90 2000 ms · maks 2200 ms; 20 cümlenin 20'sinde en az bir duraklama ≥600 ms.
// Yani sabit 600 ms bu korpustaki her cümleyi ortadan kesebiliyordu.
// ÇÖZÜM sabiti büyütmek DEĞİL (endpointing gecikmesi her cevaba birebir eklenir):
// TABAN 900 ms + cümle ortası ipucu varken TAVANA (2500 ms) çıkan UYARLANABİLİR
// pencere. Karar renderer'daki saf modülde: src/app/lib/voiceEndpoint.ts.
//
// 🔴 ADP-916 — 900 ms TABANI ÖLÇÜMLE ÇÜRÜTÜLDÜ (şikâyet: "konuşmanın bitişinde
// erken kesiyor"). ADP-854B'nin uyarlanabilir katmanı doğru ama YETMİYOR: tavana
// çıkmak için canlı kısmi transkriptin sonunda Türkçe bir "devam" ipucu (bağlaç/
// edat/yarım ek) GEREKİYOR. Kullanıcı tamamlanmış GÖRÜNEN bir öbekten sonra
// duraklarsa ipucu YOKTUR ve pencere tabanda kalır — yani 900 ms, ölçülen
// cümle-içi duraklama MEDYANININ (1500 ms) altında.
//
// Aynı korpusta (ADP-331 real/quiet, 20 cümle) ürünün kendi VAD parametreleriyle
// ölçülen sonuç:
//     taban  900 ms → 1/20 cümle ORTADAN KESİLDİ (s02, 12,8 sn'lik cümle 8,0 sn'de)
//     taban 2000 ms → 0/20
// Canlı uygulamada da birebir üretildi: s02 kaydı gerçek MediaRecorder/VAD
// zincirinden geçirildiğinde kayıt 7949 ms'de kapandı (uygulanan pencereler:
// 900 ms 'base' → 1300 ms 'long-utterance'). Kanıt: ADP-916 e2e + sonuç raporu.
//
// Yeni taban 2000 ms ölçülen p90'ı (2000 ms) kapatır; uzun-söyleyiş payıyla
// (+400 ms) ölçülen MAKSİMUM duraklamayı (2200 ms) da geçer. Bedeli dürüstçe
// yazıyoruz: cümle-sonu gecikmesi her tura ~1,1 sn ekler (ADP-804'ün ölçtüğü
// birebir ekleme). Kesilen cümleyi baştan tekrarlamak bundan pahalıdır — karar
// kullanıcının şikâyetine dayanıyor, tahmine değil. Yavaş/hızlı konuşan
// kullanıcı Ayarlar → `jarvis.silenceMs` ile kendi değerini verir.
//
// 🔴 ADP-902 — O BEDEL FATURA OLDU ("dün iyiydi bugün kötü"). Taban HER tura
// eklenir, ama turların çoğu 1–3 sn'lik KISA komuttur ve orada cümle-ortası
// kesilme riski YOKTUR. ADP-916'nın KENDİ korpusunda (20 uzun cümle) ölçüldü:
//     taban  900 · uzun 1300 → 1/20 kesildi   ·   taban 2000 · uzun 2400 → 0/20
//     taban  900 · uzun 2400 → 0/20           ·   (taban 900 · uzun 2000 → 1/20 ✗)
// Yani koruma TABANDAN değil, uzun-söyleyiş dalının ULAŞTIĞI pencereden geliyor.
// Taban kısa turun penceresine (900 ms) döndü; uzun söyleyişte uygulanan pencere
// ADP-916'nınkiyle BİREBİR aynı kaldı (2400 ms) — payı renderer'daki saf modül
// ekler: src/app/lib/voiceEndpoint.ts LONG_UTTERANCE_BONUS_MS = 1500.
const DEFAULT_SILENCE_MS = 900;
const MIN_SILENCE_MS = 300;
const MAX_SILENCE_MS = 6000;
/**
 * ADP-854B — cümle ORTASINDAYKEN beklenecek tavan (ms).
 * ADP-916 — 2500 → 3000: taban 2000'e çıkınca 2500'lük tavan ipucu katmanını
 * neredeyse no-op yapardı (500 ms pay). Tavan tabanın ÜSTÜNDE kalmak ZORUNDA,
 * yoksa "…görevini ver ve" gibi tartışmasız yarım cümlelerde kazanılan süre
 * kaybolur (ADP-916 e2e G1 bunu ölçer).
 */
const DEFAULT_ENDPOINT_MAX_MS = 3000;
/** ADP-854B — OTURUM uyku eşiği (ms). Cümle-sonu eşiğiyle KARIŞTIRILMAZ. */
const DEFAULT_SLEEP_AFTER_MS = 45000;
const MIN_SLEEP_AFTER_MS = 5000;
const MAX_SLEEP_AFTER_MS = 600000;

/** Ayarlardan gelen VAD penceresini güvenli aralığa sıkıştır (bozuk değer → varsayılan). */
function normalizeSilenceMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SILENCE_MS;
  if (n <= 0) return DEFAULT_SILENCE_MS;
  return Math.min(MAX_SILENCE_MS, Math.max(MIN_SILENCE_MS, Math.round(n)));
}

/**
 * ADP-854B — uyarlanabilir pencerenin TAVANI. Tabandan küçük bir tavan anlamsızdır
 * (kullanıcı iki alanı ters girebilir) → taban verilirse ona yükseltilir.
 */
function normalizeEndpointMaxMs(value, baseMs) {
  const base = normalizeSilenceMs(baseMs);
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return Math.max(base, DEFAULT_ENDPOINT_MAX_MS);
  return Math.max(base, Math.min(MAX_SILENCE_MS, Math.max(MIN_SILENCE_MS, Math.round(n))));
}

/** ADP-854B — OTURUM uyku eşiği (ms) güvenli aralığa sıkıştırılır. */
function normalizeSleepAfterMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SLEEP_AFTER_MS;
  return Math.min(MAX_SLEEP_AFTER_MS, Math.max(MIN_SLEEP_AFTER_MS, Math.round(n)));
}

// ── ADP-916 — "hiç konuşulmadı" eşiği de AYARDAN gelir ──────────────────────
//
// ADP-818 bu sayıyı renderer'a SABİT yazmıştı (`JARVIS_NO_SPEECH_MS = 8000`).
// Ölçüldü (ADP-916): şikâyet edilen davranışı üreten değer o değildi — masa
// sessizliğinde kayıt gerçekten 8,1 sn açık kalıyor. Ama sayı ürünün ayar
// yüzeyinde HİÇ yoktu: kullanıcı "bana 8 sn çok/az" diyemiyordu ve teşhis
// sırasında UYGULANAN değer hiçbir yerden okunamıyordu. Diğer üç eşikle aynı
// kapıdan geçsin (tek kaynak main, renderer kendi sabitini uydurmaz).
//
// Taban 2000 ms: bundan kısası "cümleye başlamadan önce düşünen" kullanıcıyı
// keser (minRecordMs 1500 + minSpeechMs 600 tabanlarıyla anlamsız çakışır).
/** Mikrofon açıldıktan sonra TEK KELİME duyulmazsa kaydın kapanma süresi (ms). */
const DEFAULT_NO_SPEECH_MS = 8000;
const MIN_NO_SPEECH_MS = 2000;
const MAX_NO_SPEECH_MS = 60000;

/** ADP-916 — "hiç konuşulmadı" eşiği (ms) güvenli aralığa sıkıştırılır. */
function normalizeNoSpeechMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_NO_SPEECH_MS;
  return Math.min(MAX_NO_SPEECH_MS, Math.max(MIN_NO_SPEECH_MS, Math.round(n)));
}

// ---------------------------------------------------------------------------
// ADP-628 (P0 · FATURA KORUMASI) — anahtar artık BU DOSYADA çözümlenmez.
//
// ÖNCE: `.env.local` → `process.env.OPENAI_API_KEY` → Ayarlar sırasıyla okunuyordu.
// Bu zincir bir MÜŞTERİ makinesinde geliştiricinin (.env.local'daki) anahtarına
// düşebilirdi → kullanım Eren'in hesabından faturalanırdı. Artık tek boğaz
// `requireCredential.cjs`: vault (şifreli) → Ayarlar → (YALNIZ dev instance)
// .env.local. Prod'da ortam dalı KAPALI — .env.local sızsa bile OKUNMAZ.
//
// `parseEnvFile`/`loadEnvLocal` geriye-uyum için duruyor ama TEK uygulama kapıda;
// `loadEnvLocal` prod'da bilerek BOŞ döner (dosyaya dokunulmaz).
// ---------------------------------------------------------------------------

const credentialGate = require('../security/requireCredential.cjs');

/** Parse a dotenv-style file body → { KEY: value }. Strips quotes + comments. */
const parseEnvFile = credentialGate.parseEnvFile;

/**
 * DEV-ONLY `.env.local` görünümü. Prod/test instance'ta `{}` döner (kapı kapalı) —
 * eskiden burada olan "her koşulda oku" davranışı fatura riskiydi.
 */
function loadEnvLocal(rootDir) {
  return credentialGate.devEnvLocal(rootDir);
}

/**
 * Jarvis'in OpenAI anahtarı — KULLANICININ kendi anahtarı (vault/Ayarlar), dev'de
 * ek olarak `.env.local`. Anahtar yoksa '' döner; çağıran (transcribeWhisper /
 * speakOpenAI) NET bir `no-openai-key` hatası üretir (sessiz başarısızlık yok).
 */
function openAiKey(rootDir) {
  const r = credentialGate.resolveCredential('openai', { rootDir });
  return r.ok ? r.secret : '';
}

/** Anahtar yokken kullanıcıya gösterilecek metin (Ayarlar'a yönlendirir). */
function openAiKeyMissingMessage() {
  return credentialGate.missingMessageFor('openai');
}

/**
 * ADP-749 — metnin MAKİNE ikizi: "Ayarlar'ı aç" düğmesinin gideceği {category, field}.
 * Renderer kendi kategori adını UYDURMAZ (eski hata: hardcoded 'engines' → OpenAI
 * alanı olmayan sekme). Kaynak requireCredential.cjs SERVICES kaydı.
 */
function openAiKeySettingsTarget() {
  return credentialGate.settingsTargetFor('openai');
}

// ---------------------------------------------------------------------------
// STT — OpenAI Whisper
// ---------------------------------------------------------------------------

// ADP-312 — Whisper dosya tipini DOSYA ADININ UZANTISINDAN belirler (content-type'ı
// yok sayar). Ölçüldü: aynı AAC baytları `audio.m4a` adıyla transkript oluyor,
// `audio.mp4` adıyla "Invalid file format" 400'ü alıyor — mp4 desteklenenler
// listesinde yazsa bile. Telefon (expo-audio, iOS/Android) m4a üretir → uzantı m4a olmalı.
function extForMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('webm')) return 'webm';
  if (m.includes('ogg') || m.includes('oga')) return 'ogg';
  if (m.includes('m4a') || m.includes('mp4')) return 'm4a';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('wav')) return 'wav';
  if (m.includes('flac')) return 'flac';
  return 'wav';
}

// Whisper'ın kabul ettiği uzantılar (mp4 BİLEREK yok: ses-only mp4 400 alıyor → m4a'ya çevrilir).
const STT_EXTS = new Set(['flac', 'm4a', 'mp3', 'mpeg', 'mpga', 'oga', 'ogg', 'wav', 'webm']);

/**
 * Gönderilecek dosya uzantısı. mime tanınıyorsa o belirler; tanınmıyorsa (octet-stream /
 * boş) kaydın kendi uzantısına düşülür — telefon bazen ham bayt + jenerik tip yollar.
 */
function resolveExt(mimeType, fileName) {
  const m = String(mimeType || '').toLowerCase();
  const known = /webm|ogg|oga|m4a|mp4|mpeg|mp3|wav|flac/.test(m);
  if (known) return extForMime(m);
  const fromName = (String(fileName || '').match(/\.([a-z0-9]{2,5})$/i) || [, ''])[1].toLowerCase(); // eslint-disable-line no-sparse-arrays -- intentional hole
  if (fromName === 'mp4') return 'm4a';
  return STT_EXTS.has(fromName) ? fromName : extForMime(m);
}

/** STT `reason` → patronun anlayacağı Türkçe. Ham OpenAI gövdesi kullanıcıya gitmez. */
function sttErrorMessage(reason, detail) {
  const r = String(reason || 'bilinmiyor');
  // ADP-628 §1d — anahtarsız özelliğe basınca kullanıcı NE yapacağını görsün
  // (sessiz başarısızlık yasak). Metnin tek kaynağı kapının kendisi.
  if (r === 'no-openai-key') return credentialGate.missingMessageFor('openai');
  if (r === 'no-audio' || r === 'empty-audio') return 'ses boş geldi — kayıt alınamamış.';
  if (r === 'bad-audio') return 'ses verisi bozuk (base64 çözülemedi).';
  if (r === 'empty-transcript' || r === 'no-speech') return 'ses algılanmadı — sessiz kayıt ya da çok kısa.';
  if (r === 'network') return 'OpenAI\'a ulaşılamadı (ağ).';
  // ADP-813 — yerel STT sebepleri KULLANICIYA çıkmaz (buluta düşüldüğü için görünmez);
  // yalnız her iki yol da başarısızsa görünür → o zaman da bilgilendirici olsun.
  if (r === 'local-no-model') return 'yerel ses modeli yok (scripts/fetch-whisper-model.sh) ve bulut da kullanılamadı.';
  if (r === 'local-no-binary') return 'whisper-server bulunamadı (brew install whisper-cpp) ve bulut da kullanılamadı.';
  if (r === 'local-no-ffmpeg') return 'ffmpeg bulunamadı (brew install ffmpeg) ve bulut da kullanılamadı.';
  if (r.startsWith('local-')) return `yerel ses çözümleyici çalışmadı (${r}).`;
  if (r.startsWith('http-')) {
    // Format reddi en sık hata → kullanıcıya net söyle (anahtar ASLA burada değil).
    if (/invalid file format/i.test(String(detail || ''))) return 'ses formatı desteklenmiyor.';
    return `OpenAI reddetti (${r}).`;
  }
  return `ses çözümlenemedi (${r}).`;
}

/**
 * ADP-642 — KULLANICI METNİ SONUCUN İÇİNDE GİDER.
 *
 * ADP-626 §K5b ölçtü: ADP-628'in yönlendirme cümlesi ("… Ayarlar → AI Motorları'ndan
 * ekle.") YALNIZ mobil yolda kullanılıyordu; masaüstü renderer'ı köprüden gelen HAM
 * sebep kodunu kendi cümlesine gömüyordu ("anlaşılamadı (no-openai-key)") — kullanıcı
 * anahtarını girmesi gerektiğini ekranda HİÇ görmüyordu.
 *
 * Çözüm metni ikinci kez yazmak DEĞİL, taşımaktır: her başarısız STT sonucuna kapının
 * KENDİ cümlesi (`message`) ve eksik servis (`credential`) eklenir. Renderer yalnız
 * basar — metnin tek kaynağı `requireCredential.cjs` olarak kalır.
 */
function withUserMessage(result) {
  if (!result || result.ok) return result;
  const reason = result.reason;
  const out = { ...result, message: sttErrorMessage(reason, result.detail || result.error) };
  // Eksik anahtar, "tekrar dene"nin çözemeyeceği TEK sınıftır: renderer bunu görünce
  // kullanıcıyı Ayarlar'a götüren düğmeyi gösterir (ADP-636 deseni).
  // ADP-749 — düğmenin HEDEFİ de sonuçla birlikte gider: cümle ile varış noktası tek
  // kayıttan türer, renderer sekme adı seçmez.
  if (reason === 'no-openai-key') {
    out.credential = 'openai';
    out.credentialTarget = credentialGate.settingsTargetFor('openai');
  }
  return out;
}

// Ses ayıklama (opt-in): CREWPANE_STT_DEBUG=1 iken gelen ses diske yazılır, böylece
// formatı `file`/`ffprobe` ile ÖLÇÜLEBİLİR. Varsayılan KAPALI — ses mahremdir, patronun
// konuşması istenmeden diske düşmemeli.
function dumpAudioForDebug(buf, name, log) {
  if (String(process.env.CREWPANE_STT_DEBUG || '') !== '1') return null;
  try {
    const dir = path.join(require('../config/instancePaths.cjs').crewpaneHome(), 'stt-debug');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${name}`);
    fs.writeFileSync(file, buf);
    if (typeof log === 'function') log(`stt debug: ${buf.length}B → ${file}`);
    return file;
  } catch {
    return null; // debug best-effort; asla akışı bozmaz
  }
}

// ADP-314 — SÖZLÜK İPUCU. Whisper'ın `prompt` alanı, modele "bu kayıtta şu özel
// isimler geçebilir" der (komut DEĞİL: yalnız yazım/vocab önyargısı). Ajan isimleri
// (Wheeljack, Bumblebee…) ipucusuz "Wilcek/Vic Check" gibi çıkıyordu → sesli prompt
// yanlış ajanı yazıyordu. Cümle olarak verilir (OpenAI önerisi) ve kırpılır.
const VOCAB_PROMPT_MAX = 240;

function buildVocabPrompt(names) {
  const seen = new Set();
  const clean = [];
  for (const raw of Array.isArray(names) ? names : []) {
    const n = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
    // Sadece isim-benzeri kısa parçalar (uzun serbest metin ipucu olmaz, gürültü olur).
    if (!n || n.length > 32) continue;
    const key = n.toLocaleLowerCase('tr');
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(n);
  }
  if (!clean.length) return '';
  let out = `CrewPane ekibi: ${clean.join(', ')}.`;
  if (out.length > VOCAB_PROMPT_MAX) out = `${out.slice(0, VOCAB_PROMPT_MAX - 1)}…`;
  return out;
}

/**
 * Transcribe base64 audio via Whisper → { ok, text } | { ok:false, reason }.
 * `fetchImpl` is injectable for unit tests (default = global fetch, Electron 42).
 * `prompt` (ADP-314) is Whisper's vocabulary hint — NEVER an instruction.
 * NEVER logs the apiKey.
 */
async function transcribeWhisper({
  audioBase64,
  mimeType,
  fileName,
  apiKey,
  language = 'tr',
  prompt,
  fetchImpl = fetch,
  log,
}) {
  if (!apiKey) return { ok: false, reason: 'no-openai-key' };
  if (!audioBase64) return { ok: false, reason: 'no-audio' };
  let buf;
  try {
    buf = Buffer.from(audioBase64, 'base64');
  } catch {
    return { ok: false, reason: 'bad-audio' };
  }
  if (!buf.length) return { ok: false, reason: 'empty-audio' };

  const type = mimeType || 'audio/wav';
  const name = `audio.${resolveExt(type, fileName)}`;
  dumpAudioForDebug(buf, name, log);
  const form = new FormData();
  form.append('file', new Blob([buf], { type }), name);
  form.append('model', WHISPER_MODEL);
  if (language) form.append('language', language);
  // ADP-314 — sözlük ipucu (ajan isimleri). Kırpılır: aşırı uzun prompt transkripti
  // ipucunun diline/üslubuna çeker (Whisper prompt'u "önceki metin" gibi okur).
  {
    const hint = String(prompt == null ? '' : prompt).trim().slice(0, VOCAB_PROMPT_MAX);
    if (hint) form.append('prompt', hint);
  }
  // verbose_json = json + segment metrikleri. `no_speech_prob` olmadan SESSİZ kaydı
  // ayırt edemiyoruz: Whisper sessizliğe uydurma metin basıyor (ölçüldü: 2sn sessizlik →
  // "Altyazı M.K.") ve Jarvis o hayalet komutu ÇALIŞTIRIYORDU.
  form.append('response_format', 'verbose_json');

  let res;
  try {
    res = await fetchImpl(OPENAI_TRANSCRIBE_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
    });
  } catch (e) {
    return { ok: false, reason: 'network', detail: String((e && e.message) || e) };
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    return { ok: false, reason: `http-${res.status}`, detail };
  }
  let json;
  try {
    json = await res.json();
  } catch {
    return { ok: false, reason: 'bad-json' };
  }
  const text = json && typeof json.text === 'string' ? json.text.trim() : '';
  if (isHallucinatedSilence(json)) return { ok: false, reason: 'no-speech', detail: text.slice(0, 80) };
  // ADP-909 (c) — BULUT YOLU DA SÜZÜLÜR. Bu yol bugüne kadar YALNIZ
  // `no_speech_prob`'a güveniyordu; o metrik ancak model "burada konuşma yok"
  // dediğinde çalışır — halüsinasyonun tanımı ise modelin bunu DEMEMESİDİR.
  // Süzgeç metin tabanlı ve motordan bağımsız olduğu için iki yolda da aynı.
  const filtered = whisperLocal.hallucinationGuard.filterResult({ ok: true, text });
  if (!filtered.ok && typeof log === 'function') {
    log(`[stt:openai] halüsinasyon süzgeci: "${text.slice(0, 60)}" ≡ "${filtered.hallucination}" → reddedildi`);
  }
  return filtered;
}

// ---------------------------------------------------------------------------
// ADP-813 (Faz 1) — STT YÖNLENDİRİCİ: önce YEREL, olmazsa BULUT
// ---------------------------------------------------------------------------
// `jarvis:transcribe` IPC'sinin imzası değişmedi; değişen tek şey bu fonksiyonun
// hangi motoru çağırdığı. Sonuç şekli aynı ({ok,text} / {ok:false,reason}) + ek
// alanlar (engine/ms/localReason) — eski çağıranlar (mobil köprü, e2e) etkilenmez.
//
// Neden yerel önce: ADP-804 ölçümü — bulut 944–1472 ms, yerel kalıcı sunucu
// 446–592 ms ve $0. Bulut, yerel yol KURULU DEĞİLSE ya da çökerse devreye girer.

// ADP-915 — motor KAYDI (hangi STT motorları var, hangisi ücretsiz, hangisi
// anahtar ister) artık `engineCatalog.cjs`te. Buradaki iki satırlık `if` ile
// Ayarlar'ın "Motorlar & Maliyet" ekranı İKİ AYRI liste olurdu; biri motor
// eklenince sessizce bayatlardı. Davranış bit-bit aynı: 'local' | 'openai',
// tanınmayan değer ücretsiz varsayılana düşer.
const DEFAULT_STT_ENGINE = engineCatalog.DEFAULT_STT_ENGINE; // 'local' (ayar: jarvis.sttEngine)

/** Ayarlardan STT motoru (ADP-812 kuralı: varsayılan `defaults()`te SABİTLENMEZ). */
function resolveSttEngine(settings) {
  return engineCatalog.resolveSttEngine(settings);
}

/**
 * Konuşmayı metne çevir. Yerel motor → başarısızsa bulut.
 * `no-speech` BULUTA DÜŞMEZ (kullanıcı konuşmadıysa bulut da bulamaz; para+gecikme).
 */
async function transcribeSpeech(payload = {}) {
  const settings = payload.settings || null;
  const engine = payload.engine || resolveSttEngine(settings);
  const deps = { settings, log: payload.log };
  if (engine === 'local') {
    const local = await whisperLocal.transcribeLocal(payload, deps);
    if (local.ok) return local;
    if (!whisperLocal.shouldFallbackToCloud(local.reason)) return local;
    if (typeof payload.log === 'function') {
      payload.log(`[stt] yerel başarısız (${local.reason}) → bulut fallback`);
    }
    const cloud = await transcribeWhisper(payload);
    return { ...cloud, engine: 'openai', localReason: local.reason };
  }
  const cloud = await transcribeWhisper(payload);
  return { ...cloud, engine: 'openai' };
}

// Ölçüm (gerçek Whisper, tr): konuşma no_speech_prob ≈ 0.01–0.05 · 0.4sn gürültü ≈ 0.58 ·
// 2sn sessizlik ≈ 0.94. Eşik 0.5 ve "HİÇBİR segmentte konuşma yok" koşulu → gerçek kaydın
// sessiz kuyruğu yüzünden yanlış-red olmaz.
const NO_SPEECH_PROB = 0.5;

function isHallucinatedSilence(json) {
  const segs = json && Array.isArray(json.segments) ? json.segments : [];
  if (!segs.length) return false; // metrik yok (eski format/sahte fetch) → karar verme
  return segs.every((s) => Number(s && s.no_speech_prob) >= NO_SPEECH_PROB);
}

// ---------------------------------------------------------------------------
// Brain — Claude orchestrator (`claude -p`) with a deterministic fallback parser
// ---------------------------------------------------------------------------

// ADP-132 (ADR-009) — Jarvis is now a GENEL orchestrator over the WHOLE CrewPane:
// every team (Marvel HQ / Education / CrewPane + dynamic departments) AND real
// terminal control (close/focus/new-shell), not just CrewPane-scoped delegation.
// The decision shape grew two fields:
//   • action: + "terminal" (control a live pane).
//   • op:     "kill" | "focus" | "new-shell"  (terminal action verb).
//   • target: a pane/agent/team name OR "all"  (which pane(s) the op hits).
// Destructive ops (kill) on a BUSY pane are approval-gated in the renderer; the
// brain only DECIDES — the executor enforces the busy-guard + onay-kapısı.
const ORCH_SYSTEM = [
  `Sen "${VOICE_NAME}", TÜM CrewPane CrewPane sanal-ofisinin sesli GENEL orkestratörüsün.`,
  'Yetkin yalnız CrewPane ile sınırlı DEĞİL: herhangi bir takıma (Marvel HQ, Education, CrewPane veya başka departman) komut verebilir, herhangi bir terminali/pane kontrol edebilirsin.',
  'Kullanıcının Türkçe sesli komutunu analiz et ve SADECE tek bir JSON nesnesi döndür (başka metin yok):',
  '{"action":"self|delegate|tell|spawn|status|reply|terminal|browser|navigate|input|board|sprint|settings|memory|report|agent|screen|office|chain","department":<takım-id|null>,"objective":<delege/iletilecek/terfi metni|null>,"browserTask":<true|false>,"op":<"kill"|"focus"|"new-shell"|"open"|"search"|"click"|"read"|"back"|"forward"|"reload"|"team"|"tab"|"tab-close"|"file"|"surface"|"type"|"scroll"|"create"|"status"|"assign"|"list"|"start"|"theme"|"workspace"|"locale"|"what"|"promote"|"last-message"|"capture"|"window"|"select"|"say"|null>,"target":<pane/ajan/takım/sekme adı|"all"|null>,"count":<1-8|null>,"engine":<"claude"|"codex"|null>,"url":<açılacak adres|null>,"query":<arama metni|null>,"selector":<CSS seçici|null>,"findText":<sayfada GÖRÜNEN metinle öge bulma|null>,"scrollTo":<"top"|"bottom"|null>,"path":<dosya/klasör yolu|null>,"x":<sayı|null>,"y":<sayı|null>,"dx":<sayı|null>,"dy":<sayı|null>,"taskId":<TASK/ADP id|null>,"title":<yeni görev başlığı|null>,"taskStatus":<"backlog"|"todo"|"in_progress"|"review"|"done"|null>,"assignee":<ajan id|null>,"theme":<tema preset id|null>,"value":<kayıtlı bir ayar kontrolünün değeri|null>,"steps":<[çok-adımlı plan için aynı şemada nesneler]|null>,"speak":<kısa Türkçe sesli yanıt>}',
  // ── ADP-322 — YÜRÜTÜCÜ KURALI (her şeyden ÖNCE gelir) ──────────────────────
  'YÜRÜTÜCÜ KURALI (EN ÖNCELİKLİ — diğer tüm kuralları ezer):',
  '  1. Kullanıcı yürütücüyü AÇIKÇA söylediyse bu HER ZAMAN kazanır; hiçbir sezgin bunu ezemez:',
  '     "sen yap"/"kendin yap"/"kendin hallet"/"ajan açma"/"delege etme" → action="self" (SEN yaparsın, ajan AÇILMAZ).',
  '     "tek ajana ver"/"tek kişi baksın"/"sadece X yapsın" → action="tell" (TAM 1 ajan).',
  '     "takıma ver"/"ekibe dağıt"/"paralel çalışsın" → action="delegate".',
  '  2. Kullanıcı bir şey söylemediyse: fan-out VARSAYILAN DEĞİLDİR. Ajan açmak İSTİSNADIR.',
  '     Adımlar sıralıysa ("önce X sonra Y", "yaz ve test et") ya da aynı dosyalara dokunuyorsa → TEK yürütücü (bölme!).',
  '     Yalnız parçalar GERÇEKTEN bağımsızsa (ayrık dosyalar, "ayrı ayrı"/"paralel" denmişse) takım düşünülür.',
  '  3. Şüphedeysen BÖLME: az ajan geri alınabilir, çok ajan geri alınamaz (token yanar, ajanlar birbirinin işini yer).',
  '- "self": kullanıcı İŞİ SENİN yapmanı istiyor ("sen yap", "kendin yap", "ajan açma") ya da iş zaten senin kataloğunla (browser/navigate/board/report/memory/terminal/settings) tek oturumda bitiyor. İşi KENDİ eylemlerine indir: tek adımsa o eylemin JSON\'unu steps içinde tek eleman olarak ver, çok adımsa steps=[...] (en çok 5). Yapamıyorsan steps=null bırak + speak ile DÜRÜSTÇE söyle — ASLA delegate\'e düşme.',
  '  Örnek: "trendyol\'u aç ve ilk ürüne tıkla, sen kendin yap" → {"action":"self","steps":[{"action":"browser","op":"open","url":"trendyol.com"},{"action":"browser","op":"click","selector":"a"}],"speak":"Tamam, kendim yapıyorum."}',
  '- "delegate": kullanıcı bir takıma/ekibe görev veriyor. department = HANGİ takım (aşağıdaki listeden id seç); objective = yapılacak iş; speak = kısa onay ("Tamam, ... takımına ilettim"). DİKKAT: sadece objective var diye delegate SEÇME — yukarıdaki YÜRÜTÜCÜ KURALI\'nı uygula. 1\'den fazla ajan açılacaksa kullanıcıya OTOMATİK onay kartı çıkar (sen karar verirsin, kapıyı yürütücü kurar).',
  '- "tell": kullanıcı TEK BİR ajana mesaj/komut iletiyor ("X\'e şunu söyle", "X\'e şu işi yaptır"). target=ajan adı, objective=iletilecek metin. Takıma iş vermek delege\'dir; TEK ajana söz iletmek tell\'dir.',
  '- "spawn": kullanıcı N adet YENİ ajan/CLI istiyor ("5 tane claude başlat ve şu promptu ver", "3 codex terminali aç"). count=N, engine="claude"|"codex" (söylenmediyse null), objective=her birine verilecek prompt — PROMPT SÖYLENMEDİYSE null bırak (boş/idle terminaller açılır, prompt uydurma). Sayılar/motorlar zaten koddan yeniden çıkarılır; sen yalnız NİYETİ sınıflandır. Var olan bir ajana iş vermek tell/delege\'dir; spawn yalnız YENİ pane açtırmaktır.',
  '  - browserTask: delege edilen iş ÇOK ADIMLI bir WEB işiyse (bir sitede gez + ürün bul + SEPETE EKLE + satın al/sipariş ver, ya da "siteye gir ve şunu yap") true yap → görünür dahili tarayıcıyı süren bir ajana gider. Sadece kod/araştırma/dosya işiyse false (veya yok).',
  '  - ÖNEMLİ: tek adımlık "şu siteyi aç" / "internette ara" → action="browser" (sen yaparsın). Ama "ürünü bul ve sepete ekle" gibi gez-karar-tıkla zinciri → action="delegate" + browserTask=true (bir ajan otonom sürer).',
  '- "status": kullanıcı durum/rapor istiyor ("ne durumdayız", "kim çalışıyor"). Tüm takımlar/pane özetlenir. objective=null; speak boş bırakılabilir.',
  '- "terminal": kullanıcı terminal/pane kontrolü istiyor. op="kill" (kapat/sonlandır/durdur), "focus" (odakla/göster/öne al), "new-shell" (yeni terminal aç). target = hangi pane: bir ajan/takım adı, ya da "all" (tümü/hepsi). Yıkıcı op (kill) çalışan pane\'de OTOMATİK onay kapısına takılır — yine de op=kill döndür.',
  '- "browser": kullanıcı DAHİLİ TARAYICIDA bir iş istiyor. op="open" (bir siteyi aç → url doldur), "search" (web\'de ara → query doldur), "read" (açık sayfayı oku/özetle; istenirse selector), "click" (sayfada bir ögeye tıkla → selector VEYA findText; tıklama OTOMATİK onay kapısına takılır), "type" (sayfadaki bir alana yaz → objective=yazılacak metin, findText=alanın adı/etiketi; yazma da onay kapısına takılır), "scroll" (sayfayı kaydır → dy pozitif=aşağı, negatif=yukarı; ya da scrollTo="top"|"bottom"), "back" (önceki sayfa), "forward" (ileri), "reload" (sayfayı yenile). speak = kısa onay.',
  '  Örnekler: "github.com sitesini aç" → {"action":"browser","op":"open","url":"github.com",...}. "internette pixel art ara" → {"action":"browser","op":"search","query":"pixel art",...}. "bu sayfayı oku" → {"action":"browser","op":"read",...}. "ilk bağlantıya tıkla" → {"action":"browser","op":"click","selector":"a",...}. "geri git" → {"action":"browser","op":"back",...}.',
  '  ADP-884 örnekleri: "aşağı kaydır" → {"action":"browser","op":"scroll","dy":600,...}. "sayfanın sonuna git" → {"action":"browser","op":"scroll","scrollTo":"bottom",...}. "giriş yap düğmesine bas" → {"action":"browser","op":"click","findText":"giriş yap",...}. "arama kutusuna pixel art yaz" → {"action":"browser","op":"type","findText":"arama","objective":"pixel art",...}. "başlıkları söyle" → {"action":"browser","op":"read","selector":"h1, h2, h3",...}. "sayfayı yenile" → {"action":"browser","op":"reload",...}.',
  '  DİKKAT: findText = kullanıcının EKRANDA GÖRDÜĞÜ yazı (CSS seçici DEĞİL). Kullanıcı seçici söylemediyse selector UYDURMA, findText kullan.',
  '- "navigate": kullanıcı UYGULAMA İÇİNDE gezinmek istiyor (ADP-263). op="team" (bir takıma/kanata geç → department=takım id), "tab" (bir dock sekmesini aç/öne getir → target=sekme adı: ofis, terminal, kod, tarayıcı, görevler, raporlar, hafıza), "tab-close" (sekmeyi kapat → target), "file" (bir dosyayı kod editöründe aç → path=dosya yolu). speak = kısa onay.',
  '  Örnekler: "CrewPane takımına geç" → {"action":"navigate","op":"team","department":"crewpane",...}. "Görevler sekmesini aç" → {"action":"navigate","op":"tab","target":"görevler",...}. "tarayıcı sekmesini kapat" → {"action":"navigate","op":"tab-close","target":"tarayıcı",...}. "package.json\'ı aç" → {"action":"navigate","op":"file","path":"package.json",...}.',
  '  op="surface" (ADP-883): uygulamanın bir EKRANINI/panelini aç — Ayarlar ve TÜM alt kategorileri (Genel, Görünüm, Kısayollar, Ses, AI Motorları, Entegrasyonlar, Bildirimler, Cihazlar, Güven, Takım İzinleri, Hesap, Sistem Durumu), şirket ağacı / takım yönetimi, "yeni takım", "yeni çalışan". target = KULLANICININ SÖYLEDİĞİ ekran adı (id ezberleme, çeviri yapma).',
  '  Örnekler: "ayarları aç" → {"action":"navigate","op":"surface","target":"ayarlar",...}. "ses ayarlarını aç" → {"action":"navigate","op":"surface","target":"ses ayarları",...}. "şirket ağacını göster" → {"action":"navigate","op":"surface","target":"şirket ağacı",...}. "yeni çalışan ekle" → {"action":"navigate","op":"surface","target":"yeni çalışan",...}.',
  '  ÖNEMLİ: olmayan bir ekran istenirse UYDURMA ve en yakınını AÇMA — action="reply" ile "öyle bir ekran bulamadım" de.',
  '  DİKKAT: "Bumblebee\'nin terminalini odakla/göster" → action="terminal", op="focus" (navigate değil). "github\'ı aç" gibi web adresi → action="browser", op="open".',
  '- "input": kullanıcı UYGULAMA PENCERESİ İÇİNDE ham fare/klavye istiyor (ADP-265; SON ÇARE — sekme/dosya/takım gibi kataloğu olan işler navigate/terminal/browser\'dır). op="click" (koordinata tıkla → x,y zorunlu; kullanıcı söylemediyse action="reply" ile koordinat iste), "type" (odaklı yere klavyeden yaz → objective=metin), "scroll" (kaydır → dy pozitif=aşağı, örn 400). click/type OTOMATİK onay kapısına takılır; OS-genel (uygulama dışı) input YASAKTIR, isteneni reddet ve söyle.',
  '  Örnekler: "400 300 noktasına tıkla" → {"action":"input","op":"click","x":400,"y":300,...}. "klavyeden merhaba yaz" → {"action":"input","op":"type","objective":"merhaba",...}. "aşağı kaydır" → {"action":"input","op":"scroll","dy":400,...}.',
  '- "board": GÖREV PANOSU (ADP-291). op="create" (yeni görev aç → title=başlık), "status" (durum değiştir → taskId + taskStatus: backlog|todo|in_progress|review|done), "assign" (ata → taskId + assignee=ajan id), "list" (listele; istenirse taskStatus filtresi).',
  '  Örnekler: "yeni görev aç: login hatası" → {"action":"board","op":"create","title":"login hatası",...}. "ADP-123\'ü done yap" → {"action":"board","op":"status","taskId":"ADP-123","taskStatus":"done",...}. "ADP-123\'ü Wheeljack\'e ata" → {"action":"board","op":"assign","taskId":"ADP-123","assignee":"wheeljack",...}. "backlog\'da ne var" → {"action":"board","op":"list","taskStatus":"backlog",...}.',
  '- "sprint": UZUN SPRINT orkestratörü (ADP-242). op="start" (objective=sprint hedefi; UZUN koşu → OTOMATİK onay kapısına takılır) veya "status" (çalışan sprintleri özetle).',
  '  Örnekler: "sprint başlat: mobil sesli komut" → {"action":"sprint","op":"start","objective":"mobil sesli komut",...}. "sprint durumu" → {"action":"sprint","op":"status",...}.',
  // ADP-921 — BU SATIR ELLE YAZILMAZ, KAYITTAN ÜRETİLİR (`uiControls.cjs`). Elle
  // yazılıydı ve ADP-899 dil seçiciyi eklediğinde güncellenmedi: beyin dil diye
  // bir op olduğunu HİÇ öğrenmedi ("Dil değiştirme için bir katalog eylemi yok").
  // Üretilen satır kaydın kendisiyle ayrışamaz.
  `- "settings": AYARLAR. ${uiControls.promptOpsLine('settings')}. theme=preset id (gece-vardiyasi, derin, komur, fosfor, kagit, gunduz); path=yeni klasör (yeniden başlatınca geçerli). theme/workspace OTOMATİK onay kapısına takılır; dil anında uygulanır.`,
  '  Örnekler: "temayı Fosfor yap" → {"action":"settings","op":"theme","theme":"fosfor",...}. "koyu tema" → en yakın koyu preset\'i seç (örn. fosfor). "dili İngilizce yap" → {"action":"settings","op":"locale","value":"en",...}. "arayüzü Türkçeye al" → {"action":"settings","op":"locale","value":"tr",...}.',
  '  DİKKAT: bir ayar EKRANINI açmak → action="navigate", op="surface" ("Görünüm ve Dil\'e git"). Bir ayarın DEĞERİNİ değiştirmek → action="settings" ("dili İngilizce yap").',
  '- "memory": AJAN HAFIZASI (ADR-017). op="what" (target=ajan → ne öğrenmiş, oku) veya "promote" (target=ajan + objective=deneyim → KALICI KURAL\'a yükselt; terfi İNSAN ONAYI ister, otomatik onaylanamaz).',
  '  Örnekler: "Bumblebee ne öğrendi" → {"action":"memory","op":"what","target":"bumblebee",...}. "şunu Bumblebee için kurala yükselt: her PR\'da typecheck koş" → {"action":"memory","op":"promote","target":"bumblebee","objective":"her PR\'da typecheck koş",...}.',
  '- "report": SONUÇ RAPORLARI. op="read" (özetle/oku; taskId verilmezse EN SON rapor), "open" (editörde aç), "list" (kaç rapor var).',
  '  Örnekler: "son raporu oku" → {"action":"report","op":"read",...}. "ADP-289 raporunu aç" → {"action":"report","op":"open","taskId":"ADP-289",...}.',
  '- "agent": BİR AJANIN SON MESAJI (ADP-306). op="last-message", target=ajan adı. Kullanıcı bir ajanın en son NE DEDİĞİNİ/RAPORLADIĞINI sorduğunda bunu seç — terminalindeki CLI motoru (claude, codex…) fark etmez, mesajı ben okurum.',
  '  Örnekler: "Wheeljack\'in son mesajını oku" → {"action":"agent","op":"last-message","target":"wheeljack",...}. "Ratchet ne dedi" → {"action":"agent","op":"last-message","target":"ratchet",...}. "Bumblebee\'nin son raporu neydi" → {"action":"agent","op":"last-message","target":"bumblebee",...}.',
  '  DİKKAT: bir AJANIN son mesajı → action="agent". Dosyaya yazılmış SONUÇ RAPORU ("son raporu oku", "ADP-289 raporu") → action="report". Ajanın ÖĞRENDİKLERİ/hafızası → action="memory".',
  '- "screen": EKRAN GÖRÜNTÜSÜ (ADP-817). op="capture" (tüm ekran — varsayılan) veya "window" (yalnız uygulama penceresi). Kullanıcı çekimi BİR AJANA göndersin diyorsa target=ajan adı, objective=ajana iletilecek bağlam notu (yoksa null). Yakalama OTOMATİK onay kapısına takılır — sen yine op döndür.',
  '  Örnekler: "ekran görüntüsü al" → {"action":"screen","op":"capture",...}. "ekran görüntüsü al ve Ratchet\'e gönder" → {"action":"screen","op":"capture","target":"ratchet","objective":"ekranda gördüğüm sorun",...}. "uygulamanın ekran görüntüsünü al" → {"action":"screen","op":"window",...}.',
  '- "office": PİXEL OFİS (ADP-817). op="select" (ofiste bir çalışana odaklan/tıkla → target=ajan adı), "say" (o çalışanın üstünde konuşma balonu → target=ajan, objective=balon metni).',
  '  Örnekler: "ofiste Ratchet\'e odaklan" → {"action":"office","op":"select","target":"ratchet",...}. "Bumblebee\'nin üstünde \'toplantı\' yazsın" → {"action":"office","op":"say","target":"bumblebee","objective":"toplantı",...}.',
  '  DİKKAT: ajanın TERMİNALİNİ öne almak → action="terminal", op="focus". Ofis HARİTASINDA birine odaklanmak → action="office", op="select". Bir ajana İŞ vermek → tell/delegate (office DEĞİL).',
  '- "chain": ÇOK ADIMLI komut ("önce X sonra Y"). steps=[her adım için AYNI şemada bir JSON nesnesi] (en çok 5 adım; adımlar sırayla koşar, TEK onay kartı çıkar). Zincir İÇİNDE zincir YASAK. Tek adımlık iş için chain KULLANMA.',
  '  Örnek: "Görevler sekmesini aç ve ADP-123\'ü done yap" → {"action":"chain","steps":[{"action":"navigate","op":"tab","target":"görevler"},{"action":"board","op":"status","taskId":"ADP-123","taskStatus":"done"}],...}.',
  '- "reply": komut anlaşılmadı veya sohbet. speak = kısa yanıt. Kataloğa girmeyen bir istek gelirse (OS-genel fare, serbest kod çalıştırma, dosya silme) NAZİKÇE reddet ve yapabileceğinin en yakınını öner.',
  'Bir takım/ajan adı açıkça geçiyorsa department\'ı o takımın id\'sine ayarla. Geçmiyorsa department=null (varsayılan takım kullanılır).',
  'op sadece action="terminal", "browser", "navigate", "input", "board", "sprint", "settings", "memory", "report", "agent", "screen", "office" için; url/query/selector sadece "browser" için; path "navigate" op="file" ve "settings" op="workspace" için; target "terminal" (pane/ajan), "tell"/"memory"/"office" (ajan adı), "screen" (teslim edilecek ajan) ve "navigate" (sekme adı) için; count/engine sadece "spawn" için; x/y/dx/dy sadece "input" için; taskId/title/taskStatus/assignee sadece "board"/"report" için; theme ve value sadece "settings" için (value = op="locale" gibi kayıtlı kontrollerin değeri); steps sadece "chain" için. Kullanılmayan alanları null bırak.',
].join('\n');

/**
 * ADP-815 — ÇIKTI KURALI. Şema 25 alanlı; boş alanları yazdırmak SAF çözme
 * (decode) maliyetidir. ÖLÇÜLDÜ (aynı 6 komut, kalıcı oturum): çıktı 148–177 →
 * 30–59 jeton, tur p50 3985 → 2511 ms. Karar kalitesi değişmedi (6/6 aynı action).
 * `normalizeDecision` eksik alanları zaten tolere ediyor (hepsi null'a düşer).
 */
const BRAIN_TERSE_RULE =
  'ÇIKTI KURALI: JSON\'da SADECE değeri null OLMAYAN alanları yaz; null alanları HİÇ yazma. "action" ve "speak" her zaman olsun.';

/**
 * ADP-815 — KALICI oturumun sistem promptu (oturum ömrü boyunca BİR KEZ verilir).
 *
 * 804 §11.4 `--append-system-prompt` ile 4/4 turda "sadece JSON" kuralını
 * tutturamamıştı. Buradaki fark: `--system-prompt` varsayılan sistem promptunu
 * EKLEMEZ, DEĞİŞTİRİR — bu koşuda 6/6 (spike-shape) + 8/8 (spike-persistent)
 * tuttu. Soğuk yol (`claude -p`) talimatı mesajın İÇİNDE taşımaya devam eder.
 */
function buildBrainSystemPrompt() {
  return `${ORCH_SYSTEM}\n${BRAIN_TERSE_RULE}`;
}

/**
 * ADP-815 — kalıcı oturuma gönderilen TUR mesajı: yalnız DEĞİŞEN kısım
 * (takımlar/pane'ler + komut). Talimat burada TEKRARLANMAZ; tekrarlamak bağlamı
 * tur başına ~6k jeton büyütüyordu (cacheRead 27899→46286 vs 23607→23992, ÖLÇÜLDÜ).
 */
function buildBrainTurnMessage(transcript, context = {}) {
  const lines = [];
  const depts = Array.isArray(context.departments) ? context.departments : [];
  if (depts.length) {
    lines.push(
      'Mevcut takımlar (id → ad): ' +
        depts.map((d) => `${d.id}${d.label ? ` (${d.label})` : ''}`).join(', '),
    );
  }
  if (context.defaultDepartment) lines.push(`Varsayılan/aktif takım: ${context.defaultDepartment}`);
  // ADP-132 — current live panes so the brain can name a real terminal target.
  const panes = Array.isArray(context.panes) ? context.panes : [];
  if (panes.length) {
    lines.push(
      'Açık terminaller: ' +
        panes
          .map((p) => `${p.label || p.agentId || p.paneId}${p.status ? ` [${p.status}]` : ''}`)
          .join(', '),
    );
  }
  lines.push('', `Kullanıcı komutu: "${String(transcript || '').replace(/"/g, "'")}"`);
  lines.push('', 'JSON:');
  return lines.join('\n');
}

/**
 * Build the one-shot prompt for `claude -p` (system rules + context + komut).
 * SOĞUK YOL — kalıcı oturum yokken/çöktüğünde kullanılır. Talimat mesajın
 * İÇİNDE gider (tek atışlık süreçte oturum-seviyesi prompt yok).
 */
function buildBrainPrompt(transcript, context = {}) {
  return `${ORCH_SYSTEM}\n${BRAIN_TERSE_RULE}\n\n${buildBrainTurnMessage(transcript, context)}`;
}

/**
 * Extract the first balanced JSON object from a string (tolerates ```json fences
 * and surrounding prose). Returns the parsed object or null.
 */
function extractJsonObject(text) {
  if (typeof text !== 'string') return null;
  // Try the fenced ```json block first, then the whole string. The fence body of a
  // claude ENVELOPE contains backslash-escaped inner JSON (invalid on its own), so
  // only accept a candidate that actually parses — falling through to the full
  // string lets `JSON.parse(envelope)` succeed and the caller unwrap `.result`.
  const candidates = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);
  candidates.push(text);
  for (const body of candidates) {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

/**
 * Parse `claude -p --output-format json` stdout into a normalized decision.
 * The envelope is {type:'result', result:'<assistant text>', ...}; the assistant
 * text is our JSON. Falls back to treating the envelope itself as the decision.
 */
function parseClaudeDecision(stdout) {
  const envelope = extractJsonObject(stdout);
  if (!envelope) return null;
  let inner = null;
  if (typeof envelope.result === 'string') inner = extractJsonObject(envelope.result);
  const candidate = inner || (envelope.action ? envelope : null);
  return normalizeDecision(candidate);
}

const TERMINAL_OPS = ['kill', 'focus', 'new-shell'];
// ADP-135 — internal-browser control verbs (only meaningful for action="browser").
// ADP-884 — dört fiil EKLENDİ: sayfa gerçekten kaydırılabilsin (scroll), forma
// yazılabilsin (type), ileri/yenile yapılabilsin. Bunlar bugüne kadar YOKTU:
// "aşağı kaydır" ya `reply`e düşüyordu ya da app penceresine giden input.scroll'a
// (guest <webview> onu HİÇ görmez — ayrı webContents).
const BROWSER_OPS = ['open', 'search', 'click', 'type', 'read', 'back', 'forward', 'reload', 'scroll'];
// ADP-263 — in-app navigation verbs (only meaningful for action="navigate").
// ADP-883 — 'surface': KAYIT tabanlı yüzey açma (Ayarlar + 12 alt kategori, şirket
// ağacı, +Takım/+Çalışan, dock görünümleri). target = `uiSurfaces.cjs` id'si ya da
// kullanıcının söylediği ad (yürütücü kayıttan çözer — ADP-263 "beyne id ezberletme").
const NAVIGATE_OPS = ['team', 'tab', 'tab-close', 'file', 'surface'];
// ADP-265 — input-sim verbs (only meaningful for action="input").
const INPUT_OPS = ['click', 'type', 'scroll'];
// ADP-291 — orchestra verbs.
const BOARD_OPS = ['create', 'status', 'assign', 'list'];
const SPRINT_OPS = ['start', 'status'];
// ADP-921 — ELLE YAZILMIŞ LİSTE DEĞİL: op kümesi kayıttan TÜRER. Kayda yeni bir
// kontrol satırı eklemek bu listeyi de, beynin prompt satırını da otomatik
// büyütür; "üç yerden birini unutmak" sınıfı burada yapısal olarak kapanır.
const SETTINGS_OPS = uiControls.opsFor('settings');
const MEMORY_OPS = ['what', 'promote'];
const REPORT_OPS = ['open', 'read', 'list'];
// ADP-306 — ajanın son mesajı (motor-bağımsız okuma).
const AGENT_OPS = ['last-message'];
// ADP-817 (FAZ 5) — ekran görüntüsü kapsamı + ofis fiilleri.
const SCREEN_OPS = ['capture', 'window'];
const OFFICE_OPS = ['select', 'say'];
const BOARD_STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'done'];

// ADP-263'ün "eklemeyi unutma" tuzağı bir SABİTE bağlandı: whitelist'te olmayan action
// sessizce reply'a düşer (ya da beter: yanlış sınıfa). ADP-291 bunu canlı yakaladı —
// 'input' hiç eklenmemişti, dolayısıyla beyin op='click' ürettiğinde karar BROWSER_OPS'a
// denk gelip action='browser' oluyordu: sesli "400 300'e tıkla" tarayıcı tıklamasına
// dönüşüyordu (e2e kaçırdı, çünkü runDecision'ı doğrudan çağırıyor — beyni değil).
const JARVIS_ACTIONS = [
  // ADP-322 — 'self': işi Jarvis KENDİ araçlarıyla yapar (0 delegasyon, 0 pane).
  'self',
  'delegate', 'tell', 'spawn', 'status', 'reply', 'terminal', 'browser', 'navigate', 'input',
  'board', 'sprint', 'settings', 'memory', 'report', 'agent', 'chain',
  // ADP-817 — eksik kontrol yüzeyi (804 §6 satır 8-9).
  'screen', 'office',
];

/** Trimmed string or null (the brain likes to emit "" / undefined). */
function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Fall back to a spoken question instead of running a half-specified action. */
function reply(department, speak) {
  return { action: 'reply', department, objective: null, op: null, target: null, speak };
}

/** ADP-265 — input sim: x/y (click) · objective (type) · dx/dy (scroll). */
function normalizeInputDecision(d, rawOp, { objective, speak }) {
  if (!INPUT_OPS.includes(rawOp)) return reply(null, speak || 'Fare/klavye komutunu anlayamadım.');
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  if (rawOp === 'click') {
    const x = num(d.x);
    const y = num(d.y);
    // Koordinatsız tıklama YOK — nereye tıklayacağını uydurma, sor.
    if (x === null || y === null) return reply(null, speak || 'Nereye tıklayayım? Koordinat (x, y) söyler misin?');
    return { action: 'input', department: null, objective: null, op: 'click', target: null, x, y, speak };
  }
  if (rawOp === 'type') {
    if (!objective) return reply(null, speak || 'Ne yazayım?');
    return { action: 'input', department: null, objective, op: 'type', target: null, speak };
  }
  return { action: 'input', department: null, objective: null, op: 'scroll', target: null, dx: num(d.dx), dy: num(d.dy), speak };
}

/** ADP-291 — board: create (title) · status (taskId+taskStatus) · assign (taskId+assignee) · list. */
function normalizeBoardDecision(d, rawOp, { department, objective, target, speak }) {
  if (!BOARD_OPS.includes(rawOp)) return reply(department, speak || 'Görev komutunu anlayamadım — görev aç, durum değiştir, ata ya da listele diyebilirsin.');
  const taskId = str(d.taskId) || target;
  const rawStatus = str(d.taskStatus) || str(d.status);
  const taskStatus = rawStatus && BOARD_STATUSES.includes(rawStatus.toLowerCase().replace(/\s+/g, '_'))
    ? rawStatus.toLowerCase().replace(/\s+/g, '_')
    : null;

  if (rawOp === 'create') {
    const title = str(d.title) || objective;
    if (!title) return reply(department, speak || 'Görevin başlığı ne olsun?');
    return { action: 'board', department, objective: null, op: 'create', target: null, title, speak };
  }
  if (rawOp === 'status') {
    if (!taskId) return reply(department, speak || 'Hangi görevin durumunu değiştireyim?');
    if (!taskStatus) return reply(department, speak || 'Hangi duruma alayım? (backlog, todo, in_progress, review, done)');
    return { action: 'board', department, objective: null, op: 'status', target: null, taskId, taskStatus, speak };
  }
  if (rawOp === 'assign') {
    const assignee = str(d.assignee);
    if (!taskId) return reply(department, speak || 'Hangi görevi atayayım?');
    if (!assignee) return reply(department, speak || 'Kime atayayım?');
    return { action: 'board', department, objective: null, op: 'assign', target: null, taskId, assignee, speak };
  }
  return { action: 'board', department, objective: null, op: 'list', target: null, taskStatus, speak };
}

/** Coerce a raw decision-ish object into the strict shape, or null if unusable. */
function normalizeDecision(d) {
  if (!d || typeof d !== 'object') return null;
  let action = String(d.action || '').toLowerCase().trim();
  if (!JARVIS_ACTIONS.includes(action)) {
    // ADP-135 — infer from fields when the brain omitted/garbled `action`.
    const opl = typeof d.op === 'string' ? d.op.toLowerCase().trim().replace(/[\s_]+/g, '-') : '';
    if (Array.isArray(d.steps) && d.steps.length) action = 'chain';
    // ADP-306 — 'last-message' AGENT_OPS'a özel: whitelist tuzağına (ADP-291) düşmesin,
    // aksi hâlde aşağıdaki `d.op` dalı kararı 'terminal' sanardı.
    else if (AGENT_OPS.includes(opl) || opl === 'lastmessage') action = 'agent';
    // ADP-817 — ADP-291 whitelist tuzağı yine: 'capture'/'window'/'select'/'say'
    // aşağıdaki `d.op` catch-all'ına düşerse sesli "ekran görüntüsü al" TERMİNAL
    // komutu sanılırdı. Sınıflarını ADIYLA sabitle.
    else if (SCREEN_OPS.includes(opl) || opl === 'screenshot' || opl === 'ekran-goruntusu') action = 'screen';
    else if (OFFICE_OPS.includes(opl) || opl === 'bubble' || opl === 'balon') action = 'office';
    else if (NAVIGATE_OPS.includes(opl) || d.path) action = 'navigate';
    else if (BROWSER_OPS.includes(opl) || d.url || d.query) action = 'browser';
    else if (d.op) action = 'terminal';
    // ADP-322 — CATCH-ALL KAPATILDI. Eskiden `d.objective` TEK BAŞINA delegate demekti
    // (satır 491: hattın çöp toplayıcısı) — bir iş tarifi taşıyan ve başka hiçbir dala
    // uymayan HER komut, "sen kendin yap" dâhil, delegasyona düşüyordu. Artık objective
    // varlığı delegasyon GEREKÇESİ değil: hedef ajan bilinen bir işse TEK ajana (tell),
    // aksi hâlde SOR (reply). Delegasyon ancak beyin AÇIKÇA action='delegate' derse olur.
    else if (d.objective && typeof d.target === 'string' && d.target.trim()) action = 'tell';
    else if (d.objective) action = 'reply';
    else action = 'reply';
  }
  const department =
    typeof d.department === 'string' && d.department.trim() ? d.department.trim() : null;
  const objective =
    typeof d.objective === 'string' && d.objective.trim() ? d.objective.trim() : null;
  const speak = typeof d.speak === 'string' && d.speak.trim() ? d.speak.trim() : null;
  // The raw op (lowercased, spaces→hyphens) — kept un-aliased so browser 'open'
  // isn't rewritten to the terminal 'new-shell' below.
  // ADP-306 — alt-çizgi de tireye: beyin 'last_message'/'lastMessage' de üretebiliyor.
  const rawOp =
    typeof d.op === 'string' && d.op.trim()
      ? d.op.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/^lastmessage$/, 'last-message')
      : null;
  // ADP-132 — terminal-control fields (only meaningful for action="terminal").
  let op = rawOp;
  if (op === 'newshell' || op === 'shell' || op === 'open') op = 'new-shell';
  if (op === 'close' || op === 'kapat') op = 'kill';
  const target =
    typeof d.target === 'string' && d.target.trim() ? d.target.trim() : null;

  if (action === 'terminal') {
    if (!TERMINAL_OPS.includes(op)) {
      return { action: 'reply', department, objective: null, op: null, target: null, speak: speak || 'Terminal komutunu anlayamadım — kapat, odakla ya da yeni terminal aç diyebilirsin.' };
    }
    return { action: 'terminal', department, objective: null, op, target, speak };
  }
  // ADP-264 — tell: tek ajana söz iletme. target (kime) + objective (ne) ŞART;
  // eksikse reply'a düş (beyin yalnız niyet çıkarır, eksik alanı kullanıcıya sorar).
  if (action === 'tell') {
    if (!target) {
      return { action: 'reply', department, objective, op: null, target: null, speak: speak || 'Kime ileteyim?' };
    }
    if (!objective) {
      return { action: 'reply', department, objective: null, op: null, target, speak: speak || 'Ne söyleyeyim?' };
    }
    return { action: 'tell', department, objective, op: null, target, speak };
  }
  // ADP-264 — spawn: N adet yeni CLI pane. engine yalnız claude|codex (başka değer →
  // null → executor claude varsayar).
  // Onay kapısı BURADA DEĞİL — executor kurar (kill-busy emsali; brain karar verir).
  // PANE-CAP-01 — SAYI TAVANI KALDIRILDI (eski: SPAWN_HARD_CAP=16 clamp). Beynin
  // duyduğu sayı KIRPILMAZ; yalnız şekli zorlanır (en az 1, tam sayı). ">12" artık
  // bir ret ya da kırpma değil ONAY KARTIDIR (spawnApprovalNeeded), kaynak tarafını
  // main'deki resourceGovernor ölçümle korur. Asıl sayılar zaten
  // applyExecutorPolicy'de transkriptten deterministik ÜSTÜNE yazılır.
  if (action === 'spawn') {
    const rawCount = Number(d.count);
    const count = Number.isFinite(rawCount) ? Math.max(1, Math.round(rawCount)) : 1;
    const rawEngine = typeof d.engine === 'string' ? d.engine.toLowerCase().trim() : '';
    const engine = rawEngine === 'claude' || rawEngine === 'codex' ? rawEngine : null;
    return { action: 'spawn', department, objective, op: null, target: null, count, engine, speak };
  }
  if (action === 'browser') {
    return normalizeBrowserDecision(d, rawOp, speak);
  }
  if (action === 'navigate') {
    return normalizeNavigateDecision(d, rawOp, { department, target, speak });
  }
  // ADP-265/291 — rawOp KULLAN: yukarıdaki genel alias 'open'ı 'new-shell'e çevirir,
  // bu da report.open / browser.open sınıfını bozar.
  if (action === 'input') {
    return normalizeInputDecision(d, rawOp, { objective, speak });
  }
  if (action === 'board') {
    return normalizeBoardDecision(d, rawOp, { department, objective, target, speak });
  }
  if (action === 'sprint') {
    if (!SPRINT_OPS.includes(rawOp)) return reply(department, speak || 'Sprint komutunu anlayamadım — "sprint başlat" ya da "sprint durumu" diyebilirsin.');
    if (rawOp === 'start' && !objective) return reply(department, speak || 'Sprint hedefi ne olsun?');
    return { action: 'sprint', department, objective, op: rawOp, target: null, speak };
  }
  if (action === 'settings') {
    if (!SETTINGS_OPS.includes(rawOp)) return reply(department, speak || 'Ayar komutunu anlayamadım.');
    if (rawOp === 'theme') {
      const theme = str(d.theme) || target;
      if (!theme) return reply(department, speak || 'Hangi temayı yapayım? (Gece Vardiyası, Derin, Kömür, Fosfor, Kâğıt, Gündüz)');
      return { action: 'settings', department, objective: null, op: 'theme', target: null, theme, speak };
    }
    // ADP-921 — KAYIT TABANLI enum kontrolleri (bugün: dil). Şema doğrulaması
    // kayıttan gelir: beyin uydurma bir değer yollarsa ("dili Almanca yap")
    // sessizce uygulanmaz, kullanıcıya SORULUR. Yeni bir enum kontrolü eklemek
    // bu dalı büyütmez — `uiControls.cjs`e bir satır ekler.
    {
      const control = uiControls.controlByOp('settings', rawOp);
      if (control && control.param.kind === 'enum') {
        const allowed = uiControls.allowedValues(control);
        const spoken = str(d.value) || str(d[control.param.name]) || target;
        const value = allowed.includes(spoken)
          ? spoken
          : uiControls.resolveControlValue(control, String(spoken || ''));
        if (!value) {
          return reply(department, speak || `${control.label} için hangi değer? (${allowed.join(', ')})`);
        }
        return { action: 'settings', department, objective: null, op: rawOp, target: null, value, speak };
      }
    }
    const path = str(d.path);
    if (!path) return reply(department, speak || 'Hangi klasör olsun?');
    return { action: 'settings', department, objective: null, op: 'workspace', target: null, path, speak };
  }
  if (action === 'memory') {
    if (!MEMORY_OPS.includes(rawOp)) return reply(department, speak || 'Hafıza komutunu anlayamadım.');
    if (!target) return reply(department, speak || 'Hangi ajanın hafızası?');
    if (rawOp === 'promote' && !objective) return reply(department, speak || 'Hangi deneyimi kurala çevireyim?');
    return { action: 'memory', department, objective, op: rawOp, target, speak };
  }
  if (action === 'report') {
    if (!REPORT_OPS.includes(rawOp)) return reply(department, speak || 'Rapor komutunu anlayamadım.');
    return { action: 'report', department, objective: null, op: rawOp, target: null, taskId: str(d.taskId) || target, speak };
  }
  // ADP-306 — agent.lastMessage: hedef ŞART (kimin mesajı?). Motor bilgisi karara
  // GİRMEZ — hangi CLI olduğunu executor pane'den okur (motor-bağımsızlık orada).
  if (action === 'agent') {
    if (!AGENT_OPS.includes(rawOp)) {
      return reply(department, speak || 'Ajan komutunu anlayamadım — "X\'in son mesajını oku" diyebilirsin.');
    }
    if (!target) return reply(department, speak || 'Kimin son mesajını okuyayım?');
    return { action: 'agent', department, objective: null, op: 'last-message', target, speak };
  }
  // ADP-817 — EKRAN GÖRÜNTÜSÜ. op: 'capture' (tüm ekran, varsayılan) | 'window'
  // (yalnız uygulama penceresi). target = İSTEĞE BAĞLI teslim hedefi (bir ajan),
  // objective = ajana gidecek bağlam notu. Hedefsiz çekim de geçerli ("ekran
  // görüntüsü al" → yalnız dosya). Yakalama onay kapısına yürütücüde takılır.
  if (action === 'screen') {
    const op = SCREEN_OPS.includes(rawOp) ? rawOp : 'capture';
    return { action: 'screen', department, objective, op, target, speak };
  }
  // ADP-817 — OFİS. op='select' (birine odaklan) | 'say' (konuşma balonu).
  // target ŞART (kim?); 'say' için metin objective'de. Kimse belli değilse SOR —
  // "en yakınına tıkla" tahmini ofiste yanlış kişiyi seçmek demektir.
  if (action === 'office') {
    let op = rawOp;
    if (op === 'focus' || op === 'odakla' || op === 'click' || op === 'tıkla' || op === 'tikla') op = 'select';
    if (op === 'bubble' || op === 'balon' || op === 'speak' || op === 'söyle' || op === 'soyle' || op === 'talk') op = 'say';
    if (!OFFICE_OPS.includes(op)) op = objective ? 'say' : 'select';
    if (!target) return reply(department, speak || 'Ofiste kime bakayım?');
    if (op === 'say' && !objective) return reply(department, speak || 'Baloncukta ne yazsın?');
    return { action: 'office', department, objective: op === 'say' ? objective : null, op, target, speak };
  }
  // ADP-322 — 'self': "sen kendin yap". İşi Jarvis KENDİ eylem-otobüsüyle yapar; ajan
  // AÇILMAZ. Motoru yeniden yazmıyoruz — `chain` zaten "kendin yap"ın motoru (tek onay
  // kartı + sıralı adımlar): steps'i normalize edip 'self' etiketiyle taşıyoruz, yürütücü
  // executeChain'e verir. Adım üretilemediyse (katalog dışı: kod yazımı, dosya düzenleme)
  // DÜRÜST RET — sessizce delegasyona geri dönmek ADP-321'in kök nedeniydi.
  if (action === 'self') {
    const raw = Array.isArray(d.steps) ? d.steps : [];
    const steps = raw
      .map((s) => normalizeDecision(s))
      .filter((s) => s && s.action !== 'chain' && s.action !== 'self' && s.action !== 'reply' && s.action !== 'delegate');
    if (!steps.length) {
      return {
        action: 'reply',
        department,
        objective,
        op: null,
        target: null,
        executor: 'self',
        speak: speak || 'Bunu kendi araçlarımla yapamıyorum (kod/dosya yazımı gerekiyor). Tek ajana vereyim mi?',
      };
    }
    // TEK adımlık iş zincire sarılmaz: `executeChain` her zaman bir plan onay kartı açar
    // (jarvisVoice.ts/actionBusOrchestra), tek eylem için o kart FAZLADAN bir karttır —
    // eylemin kendi kapısı (browser click, settings, memory promote…) zaten var. TEK KART
    // kuralı: kart yağmuru yok.
    if (steps.length === 1) {
      return { ...steps[0], executor: 'self', speak: speak || steps[0].speak };
    }
    return { action: 'self', department, objective, op: null, target: null, steps, executor: 'self', speak };
  }
  if (action === 'chain') {
    // Adım tavanı + iç-içe zincir reddi executeChain'de de var (savunma derinliği);
    // burada beynin ürettiği ham adımları normalize ederek girişte temizliyoruz.
    const raw = Array.isArray(d.steps) ? d.steps : [];
    const steps = raw
      .map((s) => normalizeDecision(s))
      .filter((s) => s && s.action !== 'chain' && s.action !== 'reply');
    if (!steps.length) return reply(department, speak || 'Planı anlayamadım — adımları tek tek söyler misin?');
    return { action: 'chain', department, objective, op: null, target: null, steps, speak };
  }
  if (action === 'delegate' && !objective) {
    return { action: 'reply', department, objective: null, op: null, target: null, speak: speak || 'Görevi anlayamadım, tekrar eder misin?' };
  }
  if (action === 'delegate') {
    // ADP-146 — brain-flagged multi-step web task OR a strong web-action cue in the
    // objective → route to a browser-capable worker (headed internal-browser driver).
    const browserTask = d.browserTask === true || d.browserTask === 'true' || BROWSER_TASK_RE.test(String(objective));
    return { action, department, objective, browserTask, op: null, target: null, speak };
  }
  return { action, department, objective, op: null, target: null, speak };
}

/** ADP-135 — normalize a browser decision (op synonyms + url/query/selector). */
function normalizeBrowserDecision(d, rawOp, speak) {
  let op = rawOp;
  if (op === 'navigate' || op === 'goto' || op === 'go-to' || op === 'visit' || op === 'open-url' || op === 'git' || op === 'aç') op = 'open';
  if (op === 'find' || op === 'google' || op === 'ara') op = 'search';
  if (op === 'readpage' || op === 'read-page' || op === 'summarize' || op === 'oku' || op === 'özetle' || op === 'ozetle') op = 'read';
  if (op === 'goback' || op === 'go-back' || op === 'geri') op = 'back';
  // ADP-884 — yeni fiillerin eş anlamlıları (beyin Türkçe/İngilizce karışık üretiyor).
  if (op === 'goforward' || op === 'go-forward' || op === 'ileri' || op === 'next') op = 'forward';
  if (op === 'refresh' || op === 'yenile' || op === 'tazele') op = 'reload';
  if (op === 'kaydır' || op === 'kaydir' || op === 'scroll-to' || op === 'scrollto') op = 'scroll';
  if (op === 'yaz' || op === 'fill' || op === 'input' || op === 'doldur') op = 'type';
  const url = typeof d.url === 'string' && d.url.trim() ? d.url.trim() : null;
  const query = typeof d.query === 'string' && d.query.trim() ? d.query.trim() : null;
  const selector = typeof d.selector === 'string' && d.selector.trim() ? d.selector.trim() : null;
  const objective = typeof d.objective === 'string' && d.objective.trim() ? d.objective.trim() : null;
  // ADP-884 — METİNLE ÖGE BULMA: kullanıcı CSS seçici bilmez, ekranda GÖRDÜĞÜ yazıyı
  // söyler. Seçiciye ÇEVİRME işi guest tarafında (browserCdp) — burada yalnız taşınır.
  const findText = typeof d.findText === 'string' && d.findText.trim() ? d.findText.trim() : null;
  const scrollTo = d.scrollTo === 'top' || d.scrollTo === 'bottom' ? d.scrollTo : null;
  const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
  const dy = num(d.dy);
  const dx = num(d.dx);
  if (!BROWSER_OPS.includes(op)) {
    op = url ? 'open' : query ? 'search' : scrollTo || dy != null ? 'scroll' : selector || findText ? 'click' : 'read';
  }
  // Cross-fix obvious field/op mismatches before validating.
  if (op === 'open' && !url && query) op = 'search';
  if (op === 'search' && !query && url) op = 'open';
  const reply = (msg) => ({ action: 'reply', department: null, objective: null, op: null, target: null, speak: speak || msg });
  if (op === 'open' && !url) return reply('Hangi siteyi açayım?');
  if (op === 'search' && !query) return reply('Ne aramamı istersin?');
  if (op === 'click' && !selector && !findText) return reply('Sayfada neye tıklayayım?');
  if (op === 'type' && !objective) return reply('Ne yazmamı istiyorsun?');
  return {
    action: 'browser', department: null,
    // `objective` YALNIZ type için anlamlı (yazılacak metin) — diğer fiillerde
    // beynin serbest metnini taşımak yürütücüde yanlış alana düşerdi.
    objective: op === 'type' ? objective : null,
    op, target: null, url, query, selector, findText,
    ...(op === 'scroll' ? { scrollTo, dy: dy != null ? dy : scrollTo ? null : SCROLL_STEP_DEFAULT, dx } : {}),
    speak,
  };
}

/**
 * ADP-263 — normalize a navigate decision (op synonyms + required-field checks).
 * Uses rawOp (un-aliased) so the terminal aliasing ('open'→'new-shell') can't
 * mangle a navigate verb. Turkish tab-name → dock viewId mapping is RENDERER
 * work (navigationActions.normalizeTabTarget) — the brain passes what was said.
 */
function normalizeNavigateDecision(d, rawOp, { department, target, speak }) {
  let op = rawOp;
  if (op === 'takım' || op === 'takim' || op === 'wing' || op === 'kanat' || op === 'switch-team' || op === 'switchteam') op = 'team';
  if (op === 'sekme' || op === 'view' || op === 'open-tab' || op === 'opentab') op = 'tab';
  if (op === 'sekme-kapat' || op === 'close-tab' || op === 'closetab' || op === 'tab-kapat' || op === 'tabclose') op = 'tab-close';
  if (op === 'dosya' || op === 'open-file' || op === 'openfile' || op === 'edit') op = 'file';
  const path = typeof d.path === 'string' && d.path.trim() ? d.path.trim() : null;
  if (!NAVIGATE_OPS.includes(op)) {
    // infer from fields when the brain omitted/garbled the verb
    op = path ? 'file' : department && !target ? 'team' : target ? 'tab' : null;
  }
  const reply = (msg) => ({ action: 'reply', department, objective: null, op: null, target: null, speak: speak || msg });
  if (op === 'team' && !department && !target) return reply('Hangi takıma geçeyim?');
  if ((op === 'tab' || op === 'tab-close') && !target) return reply('Hangi sekmeyi açayım?');
  if (op === 'file' && !path) return reply('Hangi dosyayı açayım?');
  // ADP-883 — 'surface': hedef ya kayıt id'si ('settings.voice') ya da kullanıcının
  // söylediği ad ("ses ayarları"). ÇÖZÜM burada YAPILMAZ: yürütücü (renderer) aynı
  // kaydı okuyup çözer ve bulamazsa DÜRÜSTÇE "öyle bir ekran yok" der (ADP-263 kuralı).
  if (op === 'surface' && !target) return reply('Hangi ekranı açayım?');
  if (!op) return reply('Nereye gideyim, anlayamadım.');
  return { action: 'navigate', department, objective: null, op, target, path, speak };
}

/** Spawn `claude -p` and resolve a decision, or {ok:false} on any failure. */
function decideWithClaude({
  transcript,
  context,
  // ADP-915 — beynin ikilisi motor kaydından gelir: Ayarlar'daki "Motorlar &
  // Maliyet" ekranı da aynı sabiti okur, yani ekran ile gerçekten çalıştırılan
  // komut ayrışamaz.
  claudeBin = engineCatalog.BRAIN_CLI,
  timeoutMs = CLAUDE_TIMEOUT_MS,
  spawnImpl = spawn,
}) {
  return new Promise((resolve) => {
    const prompt = buildBrainPrompt(transcript, context);
    const args = ['-p', prompt, '--output-format', 'json'];
    let child;
    try {
      const brainEnv = { ...process.env, PATH: augmentedPath(process.env.PATH) };
      // ADP-812 (Faz 0) — stdin'i KAPAT. Boru olarak açık bırakılınca `claude`
      // 3 saniye boyunca stdin'den veri bekliyor ("Warning: no stdin data received
      // in 3s, proceeding without it...") ve promptu ancak ondan sonra işliyordu.
      // ADP-804 ölçümü: aynı prompt 8855–9895 ms → 5890–8436 ms. Tek satır, 1.5–3 s.
      child = spawnImpl(claudeBin, args, { env: brainEnv, stdio: ['ignore', 'pipe', 'pipe'] });
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
        /* already gone */
      }
      finish({ ok: false, reason: 'timeout' });
    }, timeoutMs);
    child.stdout && child.stdout.on('data', (d) => (stdout += d));
    child.stderr && child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) =>
      finish({ ok: false, reason: 'proc-error', detail: String((e && e.message) || e) }),
    );
    child.on('close', () => {
      const decision = parseClaudeDecision(stdout);
      if (decision) finish({ ok: true, decision });
      else finish({ ok: false, reason: 'parse-failed', detail: (stderr || stdout).slice(0, 200) });
    });
  });
}

// ADP-854 — FİİL KÖKÜ SÖZLÜĞÜ. Aşağıdaki `hasV/negV` yardımcıları çıplak alt-dize
// regex'lerinin YERİNİ alır (bkz. turkishMorph.cjs başlığı: "kapatma" ≠ "kapat",
// "açıklama" ≠ "aç", "kurtar" ≠ "kur", "arasında" ≠ "ara").
//
// ADP-885/st1 — KELİMELER ARTIK BURADA YAŞAMIYOR: tek gerçek `intentLexicon.cjs`.
// Sebep: bu kelimeler arayüz metni değil KULLANICININ SÖYLEDİĞİ jetonlardır ve bir
// i18n turunda sessizce sözlüğe taşınırlarsa Türkçe sesli komut tip hatası VERMEDEN
// ölür. Tek dosyada toplanınca hem `npm run check:intent` kapısı onları imzalayabilir
// hem de "yeni komut nasıl eklenir" reçetesi tek yerde durur.
const { ACTION_VERB_STEMS: STEMS, SCROLL_EN, STOP_VERB_STEMS, THEME_BASE_WORDS } = require('../agents/intentLexicon.cjs');
// AXP-01 — NİYET YÖNLENDİRİCİ (aksiyon / prompt / belirsiz / yok). Saf modül; katalog
// kararı (parseIntent) ona DIŞARIDAN verilir. Bağlanma noktası: applyExecutorPolicy'nin
// SONU (routePromptClass) — beyin ve tüm kural kapıları koştuktan sonra, tek karar noktası.
const promptRouter = require('../agents/promptRouter.cjs');

/** OLUMLU bir fiil eşleşmesi var mı? ("kapatma" burada FALSE döner.) */
function hasV(toks, key) {
  return morph.hasVerb(toks, STEMS[key]);
}
/** Kök OLUMSUZ biçimde mi geçiyor? ("kapatma", "başlatma", "özetleme") */
function negV(toks, key) {
  return morph.hasNegatedVerb(toks, STEMS[key]);
}

// ADP-854 — "özetle" ÖBEK listesinden çıkarıldı: /özetle/ alt-dizesi olumsuz
// "özetleme"yi de yakalıyordu. Fiil artık morfolojiyle ayrı sorulur (hasV).
const STATUS_RE =
  /(ne durum|durum ne|durumday|durumda m|ne yap[ıi]yor|neler oluyor|kim çal[ıi]ş|çal[ıi]ş[ae]n|rapor ver|durum raporu|nas[ıi]l gidiyor)/i;
const DELEGATE_RE =
  /(görev ver|görevi ver|delege|delegasyon|atayal|ata\b|başlat|söyle|takım[ıi]na|ekibine|worker|çal[ıi]şt[ıi]r|yapt[ıi]r|hallet)/i;
// ADP-291 — orkestra niyetleri (beyin çökerse deterministik fallback). Kasten DAR:
// yalnız tartışmasız ipuçlarında tetiklenir, normal delege/status komutunu çalmaz.
const THEME_RE = /(tema|theme)/i;
// AXP-08 — DEĞİŞTİRME ipucu. Küme ADP-921 kayıt dalındaki `changed` ile BİREBİR aynı
// (orada da tema/dil aynı cümlelerle söyleniyor); "al" ve "ayarla" buraya AXP-08'de
// geldi: "Temayı koyuya AL" korpusta vardı ama tema dalı 'al'ı görmüyordu (ölçüldü).
const THEME_CHANGE_CUE_RE = /(yap|değiştir|degistir|çevir|cevir|geç|gec\b|olsun|al\b|ayarla|aç)/;
// AXP-08 — OLUMSUZ biçim ("temayı koyu YAPMA") eylem DEĞİLDİR. İki kat koruma:
// morfoloji (negV: yap/geç/aç kökleri) + burada yalnız morfolojinin GÖRMEDİĞİ biçimler.
// 🪤 'al' KASTEN morfolojide yok (ADP-854: "altı" → "al"+"tı" gibi görünüyor), bu yüzden
//    "alma" biçimi yalnız burada, SÖZCÜK olarak aranır.
const THEME_NEG_RE = /(^|\s)(değiştirme|degistirme|yapma|çevirme|cevirme|alma|ayarlama)(\s|$|[.,!?…])/;
// AXP-08 — TABAN SÖZCÜĞÜ → O TABANIN VARSAYILAN PRESET'İ.
//
// `theme` alanı HER ZAMAN bir preset id taşır (executeSettings değişmedi: `preset`
// bekliyor ve `getPreset` ile çözüyor) — yani taban sözcüğü BURADA id'ye indirilir.
// İki id'nin gerekçesi ve tek gerçeği `src/app/lib/theme.ts`:
//   dark  → DEFAULT_PRESET ('kutup') — ürünün KENDİ beyan ettiği varsayılan
//           (theme.ts:29, Eren kararı 2026-07-20). Kullanıcı açık temadan
//           "koyu yap" dediğinde ürünün varsayılanına döner, hiç seçmediği bir
//           temaya değil.
//   light → THEME_PRESETS'teki İLK `base:'light'` girdisi ('kagit'). Açık taraf
//           için beyan edilmiş bir varsayılan YOK; tek gerçek sıralamadır.
// ⚠️ Bu iki id burada YAZILI ama SERBEST DEĞİL: `intentRegression.test.cjs`
//    "AXP-08 SÜRÜKLENME" kapısı theme.ts'i okuyup ikisini de doğruluyor
//    (id var mı · base doğru mu · dark gerçekten DEFAULT_PRESET mi · light
//    gerçekten ilk açık preset mi). Biri yeniden adlandırılırsa kapı KIRMIZI.
const THEME_BASE_PRESET = Object.freeze({ dark: 'kutup', light: 'kagit' });

/** Taban sözcüklerini SÖZCÜK BAŞINDAN arar (ek serbest: "koyuya", "karanlığa"). */
function themeBaseRe(words) {
  const alt = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`(^|[^\\p{L}\\p{N}])(${alt})`, 'u');
}
const THEME_BASE_RES = Object.freeze({
  dark: themeBaseRe(THEME_BASE_WORDS.dark),
  light: themeBaseRe(THEME_BASE_WORDS.light),
});

/**
 * Cümlede geçen tema TABANI ('dark'|'light'|null).
 * İkisi de geçiyorsa SONRAKİ kazanır: "koyu temadan açığa geç" → açık (hedef sonda).
 *
 * 🪤 İKİ KÜÇÜLTME BİRDEN (ölçüldü, AXP-08): parseIntent metni
 * `toLocaleLowerCase('tr')` ile küçültür — bu Türkçe için DOĞRU ama BÜYÜK harfle
 * yazılmış/dikte edilmiş metinde 'I' harfini NOKTASIZ ı yapar:
 *   'LIGHT' → 'lıght' · 'SIYAH' → 'sıyah' · 'ACIK' → 'acık'
 * ve sözlükteki 'light'/'siyah'/'acik' ile eşleşmez. Sözlüğe her sözcüğün noktasız
 * ikizini eklemek yerine metin İKİ biçimde birden aranır (ürünün kendi deseni:
 * `lowEn` — jarvisVoice.js'te başka dallarda da var). Nöbetçi:
 * intentRegression.test.cjs "AXP-08 TÜRKÇE KÜÇÜLTME" (iki büyütme kolu birden).
 */
function detectThemeBase(low, lowEn) {
  const ara = (s) => {
    const d = s.search(THEME_BASE_RES.dark);
    const l = s.search(THEME_BASE_RES.light);
    if (d < 0 && l < 0) return null;
    if (d < 0) return 'light';
    if (l < 0) return 'dark';
    return l > d ? 'light' : 'dark';
  };
  return ara(low) ?? (lowEn && lowEn !== low ? ara(lowEn) : null);
}

const SPRINT_START_RE = /sprint[^]*?(başlat|baslat|aç\b|start)/i;
const SPRINT_STATUS_RE = /sprint[^]*?(durum|status|nerede|ne oldu)/i;
const BOARD_NEW_RE = /(yeni )?(görev|gorev|task)[^]*?(aç|ac\b|oluştur|olustur|ekle)/i;
const BOARD_LIST_RE = /(görev|gorev|task|backlog|panoda|board)[^]*?(liste|listele|ne var|neler var|göster)/i;
const BOARD_STATUS_RE = /\b(backlog|todo|in[_ ]?progress|review|done|bitti|tamam(landı)?)\b/i;
const REPORT_RE = /(rapor|report)/i;
const MEMORY_WHAT_RE = /(ne öğrendi|ne ogrendi|neler öğrendi|hafızasında ne|hafizasinda ne)/i;
const MEMORY_PROMOTE_RE = /(kurala (yükselt|yukselt|çevir|cevir)|kural(a| olarak) (ekle|kaydet)|terfi et)/i;
// ADP-306 — "X'in son mesajını oku" / "X ne dedi". Ajan adı ZORUNLU (aşağıda aranır):
// adsız "ne dedi" bir mesaj hedefi vermez, o zaman eski dallara düşer.
const AGENT_LAST_RE = /(son mesaj|son cevab|son cevap|son yanıt|son yanit|ne dedi|ne diyor|ne demiş|ne demis|son raporu ne|en son ne)/i;
const TASK_ID_RE = /\b((?:TASK|ADP|CF|AD)-[A-Z0-9-]+)\b/i;

// ADP-132 — terminal-control intent (deterministic fallback for the brain).
const TERMINAL_RE = /(terminal|pane|konsol|shell|oturum)/i;
// ADP-854 — TERM_KILL_RE KALDIRILDI: /kapat/ alt-dizesi olumsuz "kapatma"yı da
// yakalıyordu. Kapatma niyeti artık `hasV(toks, 'close')` ile morfolojik sorulur.
const TERM_FOCUS_RE = /(odakla|odaklan|focus|öne al|öne getir|göster\b)/i;
// ADP-854 — TERM_NEW_RE KALDIRILDI: "terminal aç" alt-dizesi "terminal açıklaması"nı
// da yakalıyordu; yeni-shell dalı artık `mentionsTerminal && hasV(toks,'open')`.
const ALL_RE = /(tüm[üu]?|bütün|hepsi|hepsin|herkes)/i;
// ADP-135 — internal-browser control intent (deterministic fallback for the brain).
const BROWSER_BACK_RE = /(geri (git|dön|al|gel|dönelim)|önceki sayfa)/i;
const BROWSER_CLICK_RE = /(tıkla|tıkl[ae]\b|tıklay)/i;
const BROWSER_READ_RE = /((sayfa|içerik|metin|metni|yazı|bunu|şunu|burayı)[^]*?(oku|özetle|özet)|sayfayı (oku|özetle))/i;
const BROWSER_SEARCH_RE = /(\bara\b|\barat\b|arasana|arama yap|aratır mısın|arar mısın|diye ara|internette? ?ar|google['’]?(da|de|den)? ?ar|web['’]?de ?ar)/i;
const BROWSER_OPEN_RE = /(aç\b|açar m|aç[ıi]ver|git\b|gir\b|göster\b|getir\b|ziyaret et)/i;
const BROWSER_CUE_RE = /(site|sayfa|tarayıc|web sayfa|web site|internet|google|link|bağlant|url|https?:\/\/)/i;
// ADP-146 — a delegated MULTI-STEP web task (drive the headed browser: find a
// product, add to cart, buy) → browserTask=true. Distinct from the single-step
// BROWSER_* cues above (those are Jarvis-self). Matches strong e-commerce/automation
// verbs so a plain "kod yaz" delegation is never mis-flagged.
const BROWSER_TASK_RE = /(sepete (ekle|at|koy)|sepete\b|satın al|satin al|sipariş ver|siparis ver|satın alma|ürün bul|urun bul|ürünü bul|trendyol|hepsiburada|amazon|aliexpress|alışveriş|alisveris|siteye (gir|gidip)|sitesine (gir|gidip)|tarayıcıda (gez|dolaş|gezin|bul|alışveriş)|web sitesinde (gez|bul|ara))/i;
const HOST_RE = /\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?)\b/i;

// ── ADP-884 — TARAYICIDA GERÇEK ETKİLEŞİM (kaydırma · metinle tıklama · form) ──
//
// KAYDIRMA yön sözcüğü BAŞLI BAŞINA niyettir ("biraz aşağı") — fiil şart değil.
// 🪤 "aşağıdaki tabloyu" bir SIFATtır, emir değil: `-daki/-deki` eki dışlanır.
const SCROLL_CUE_RE =
  /(^|\s)(aşağ[ıi](?!daki|dakini)|yukar[ıi](?!daki|dakini)|dibe|en (alt|üst|başa|sona)|sayfan[ıi]n (sonu|sonuna|dibi|dibine|başı|başına|altı|altına|üstü|üstüne)|başa dön|sona git)/i;
/** Kaydırma yönü/uç noktası. `to` verilirse miktar YOK SAYILIR (uca git). */
const SCROLL_TOP_RE = /(yukar[ıi]|başa|üste|üstüne|başı|başına|üstü)/i;
const SCROLL_END_RE = /(sayfan[ıi]n (sonu|sonuna|dibi|dibine|alt[ıi]|alt[ıi]na)|en (alta|sona)|dibe|sona git|en alt)/i;
const SCROLL_START_RE = /(sayfan[ıi]n (baş[ıi]|baş[ıi]na|üst[üu]|üst[üu]ne)|en (üste|başa)|başa dön|en üst)/i;
/** "biraz/azıcık" → küçük adım · söylenmezse MAKUL VARSAYILAN (görev §7). */
const SCROLL_SMALL_RE = /(biraz|az[ıi]c[ıi]k|hafif|bir tık|yavaş)/i;
const SCROLL_BIG_RE = /(çok|iyice|epey|bayağ[ıi])/i;
const SCROLL_STEP_DEFAULT = 600;
const SCROLL_STEP_SMALL = 300;
const SCROLL_STEP_BIG = 1200;

// ── ADP-884/jazz — İNGİLİZCE KAYDIRMA (aynı sınıf, ikinci dil) ──────────────
//
// Kelimeler leksikondan gelir (`SCROLL_EN`), buradaki yalnız DESENDİR — bu dosya
// zaten "kural yolu öbek desenleri" gerekçesiyle korunan yüzey (intentLexicon §7).
// Desenler leksikondan TÜRETİLİR: elle yazılmış ikinci bir liste, kapının imzaladığı
// kümeden sessizce ayrışırdı (ADP-883'ün "el-yazması ikiz kapı değildir" dersi).
const escRe = (w) => String(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const anyOf = (words) => words.map(escRe).join('|');
/** Kaydırma niyeti: fiil ("scroll") · "page down/up" · "go/jump to the top/bottom". */
const EN_SCROLL_CUE_RE = new RegExp(
  `\\b(?:${anyOf(SCROLL_EN.verbs)})\\b` +
    `|\\bpage\\s+(?:${anyOf([...SCROLL_EN.down, ...SCROLL_EN.up])})\\b` +
    `|\\b(?:go|jump|take me|move)\\s+(?:to\\s+)?(?:the\\s+)?(?:${anyOf([...SCROLL_EN.bottom, ...SCROLL_EN.top])})\\b`,
  'i',
);
const EN_SCROLL_DOWN_RE = new RegExp(`\\b(?:${anyOf(SCROLL_EN.down)})\\b`, 'i');
const EN_SCROLL_UP_RE = new RegExp(`\\b(?:${anyOf(SCROLL_EN.up)})\\b`, 'i');
const EN_SCROLL_BOTTOM_RE = new RegExp(`\\b(?:${anyOf(SCROLL_EN.bottom)})\\b`, 'i');
const EN_SCROLL_TOP_RE = new RegExp(`\\b(?:${anyOf(SCROLL_EN.top)})\\b`, 'i');
const EN_SCROLL_SMALL_RE = new RegExp(`\\b(?:${anyOf(SCROLL_EN.small)})\\b`, 'i');
const EN_SCROLL_BIG_RE = new RegExp(`\\b(?:${anyOf(SCROLL_EN.big)})\\b`, 'i');
/**
 * 🪤 İNGİLİZCE OLUMSUZLAMA EKTE DEĞİL AYRI SÖZCÜKTE: `negV` (turkishMorph) "don't
 * scroll down" cümlesini OLUMLU görür — yani ADP-854'ün kapattığı sınıf İngilizce
 * tarafta AÇIK kalırdı. `don't` kesme işareti düz/kıvrık/eksik olabilir (STT).
 */
const EN_NEG_RE = new RegExp(`(?:\\bdo\\s*n['’]?t\\b|\\b(?:${anyOf(SCROLL_EN.negation)})\\b)`, 'i');
/**
 * 🔴 ADP-884 2. TUR (jazz QA) — "scroll" TEK BAŞINA NİYET DEĞİLDİR.
 * ÖLÇÜLDÜ: yön sözcüğü aranmadığı için `scroll` ADI geçen HER cümle sayfayı 600px
 * aşağı kaydırıyordu — "the scroll bar is broken" · "I fixed the scroll issue" ·
 * "tell wheeljack to fix the scroll bug" (TR delegasyon freni `isDelegate`
 * İngilizce cümle yapısını görmez). Bu, ADP-854'ün Türkçe tarafta kapattığı
 * "kök alt-dizesi = komut" tuzağının İngilizce ikizidir.
 * KAPI: İngilizce dal yalnız NİTELENMİŞ cümlede konuşur — yön/uç-nokta/miktar
 * sözcüğü VAR, ya da cümle çıplak emirdir ("scroll", "scroll please").
 */
const EN_BARE_SCROLL_RE = new RegExp(
  `^(?:(?:hey|ok|okay|please|jarvis|agent\\s*x)[\\s,]+)*(?:${anyOf(SCROLL_EN.verbs)})(?:[\\s,]+(?:please|now|a\\s*bit))?[.!?]*$`,
  'i',
);

/**
 * 🔴 ADP-884 2. TUR (jazz QA) — ÇEVRESEL OLUMSUZLAMA: "<fiil>mayı BIRAK".
 * ÖLÇÜLDÜ: `negV` yalnız EK ile olumsuzlamayı görüyor — `classifyToken('kaydırma')`
 * = negative AMA `classifyToken('kaydırmayı')` = **null** (fiilimsi + hâl eki artık
 * fiil biçimi değil). Sonuç: "aşağı kaydırma" duruyordu, "yukarı kaydırmayı bırak"
 * cümlesi SAYFAYI KAYDIRIYORDU — yani ADP-854'ün kapattığı sınıf, olumsuzluk
 * FİİLLE (bırak/durdur/kes/vazgeç) kurulduğunda hâlâ açıktı.
 * DAR: fiilimsi biçim ŞART — "bırak aşağı kaydır" (bırak = söylem parçacığı, kaydır
 * EMİR) kaydırmaya devam eder. Çift olumsuz da bedava: "kaydırmayı bırakma" →
 * `hasVerb` olumsuz biçimde false döner → kaydırma yaşar.
 * Kelimeler icat edilmedi: kesme fiilleri leksikonun `stop.verbs` kümesinden gelir.
 */
const SCROLL_GERUND_RE = new RegExp(`\\b(?:${anyOf(STEMS.scroll)})m[ae][a-zçğıöşü]*\\b`, 'i');
function isStoppedScroll(low, toks) {
  return SCROLL_GERUND_RE.test(low) && morph.hasVerb(toks, STOP_VERB_STEMS);
}

/** "<metin> düğmesine bas" / "<metin> bağlantısına tıkla" → tıklanacak ÖGE METNİ. */
const CLICK_BY_TEXT_RE =
  /(?:^|\s)([\p{L}\p{N} .,'’-]{2,60}?)\s*(?:adl[ıi]|isimli|yaz[ıi]l[ıi])?\s*(düğme|dugme|buton|button|bağlant|baglant|link|sekme|kutu|alan)[\p{L}]*\s*(?:tıkla|tikla|bas|seç|sec)/iu;
/** "arama kutusuna X yaz" → { field:'arama', text:'X' }. Alan adı yoksa null. */
const TYPE_INTO_RE =
  /(?:^|\s)([\p{L}\p{N} -]{2,40}?)\s*(?:kutusuna|kutucuğuna|alan[ıi]na|kutusu|alan[ıi]|input(?:una)?)\s+([\s\S]{1,200}?)\s*(?:yaz|gir|doldur)[a-zçğıöşü]*\s*$/iu;
/** Alan adı SÖYLENMEDEN yazma: "şunu yaz: merhaba" / "merhaba yaz". */
const TYPE_PLAIN_RE = /(?:^|\s)(?:şunu|sunu|bunu)?\s*["'“”]?([\s\S]{1,200}?)["'“”]?\s*(?:yaz|gir|doldur)[a-zçğıöşü]*\s*$/iu;
/** "başlıkları oku/söyle" → sayfanın başlık ögeleri. */
const HEADINGS_RE = /(başl[ıi]k|baslik|heading)/i;
const HEADINGS_SELECTOR = 'h1, h2, h3';
/** "ileri git" / "sonraki sayfaya geç" (geri'nin ikizi). */
const BROWSER_FORWARD_RE = /(ileri (git|gel|al)|sonraki sayfa|ileriye git)/i;
/** "sayfayı yenile" / "tazele" / "F5". */
const BROWSER_RELOAD_RE = /(yenile|tazele|refresh|f5)/i;

// ── ADP-883 — YÜZEY AÇMA ────────────────────────────────────────────────────
/** "…ekranını/panelini/sayfasını aç" — kayıtta YOKSA "bulamadım" demenin sinyali. */
const SCREEN_NOUN_RE = /(ekran|panel|sayfas[ıi]|pencere|bölüm|sekme|ayar)/i;

/** Best-effort department detection from aliases (agent/team names) + ids/labels. */
/**
 * ADP-291 — spoken agent NAME → agent id (fallback parser). The renderer sends the whole
 * roster as aliases ({match: display name, id, department}); ids are matched too so
 * "wheeljack'e ata" works even when the display name is styled differently.
 */
function detectAgentName(low, context = {}) {
  const aliases = Array.isArray(context.aliases) ? context.aliases : [];
  for (const a of aliases) {
    if (!a) continue;
    const name = String(a.match || '').toLocaleLowerCase('tr');
    const id = String(a.id || '').toLocaleLowerCase('tr');
    if (name && name.length > 2 && low.includes(name)) return a.id || name;
    if (id && id.length > 2 && low.includes(id)) return a.id;
  }
  return null;
}

/** ADP-291 — konuşulan durum kelimesi → board status id ("bitti" → done). */
function normalizeBoardStatusWord(word) {
  const w = String(word || '').toLocaleLowerCase('tr').replace(/\s+/g, '_');
  if (w === 'bitti' || w === 'tamam' || w === 'tamamlandı' || w === 'done') return 'done';
  if (w === 'inprogress' || w === 'in_progress') return 'in_progress';
  return BOARD_STATUSES.includes(w) ? w : null;
}

function detectDepartment(low, context = {}) {
  const aliases = Array.isArray(context.aliases) ? context.aliases : [];
  for (const a of aliases) {
    if (a && a.match && low.includes(String(a.match).toLocaleLowerCase('tr'))) return a.department;
  }
  const depts = Array.isArray(context.departments) ? context.departments : [];
  for (const d of depts) {
    if (!d) continue;
    if (d.id && low.includes(String(d.id).toLocaleLowerCase('tr'))) return d.id;
    if (d.label && low.includes(String(d.label).toLocaleLowerCase('tr'))) return d.id;
    if (d.shortLabel && low.includes(String(d.shortLabel).toLocaleLowerCase('tr'))) return d.id;
    // distinctive label tokens (>3 chars) — "CrewPane Marvel HQ" → matches "marvel".
    const label = String(d.label || '').toLocaleLowerCase('tr');
    for (const tok of label.split(/\s+/)) {
      if (tok.length > 3 && tok !== 'crewpane' && tok !== 'takım' && low.includes(tok)) return d.id;
    }
  }
  return null;
}

function departmentLabel(id, context = {}) {
  const depts = Array.isArray(context.departments) ? context.departments : [];
  const hit = depts.find((d) => d && d.id === id);
  return (hit && hit.label) || id;
}

/**
 * Deterministic Turkish intent parser — the brain fallback (and a fast path for
 * tests). Pure; mirrors the claude decision shape.
 *
 * 🔴 ADP-857 SÖZLEŞMESİ — `speak` ALANI SONUÇ CÜMLESİ DEĞİLDİR.
 * Bu fonksiyon eylemden ÖNCE koşar; yürütücüler ise dönen `speak`i eylemden SONRA
 * söyler (`speak: decision.speak || '<geçmiş zamanlı yedek>'`). Dolayısıyla burada
 * yazılan her cümle, iş BİTTİKTEN sonra duyulur ve doğru geçmiş-zamanlı yedeği ÖLÜ
 * KODA çevirir. Kural: eylemin SONUCUNU anlatan bir cümle buraya YAZILMAZ (`null`
 * bırakılır) — sonucu, veriyi gören yürütücü söyler. Yalnız SORU/RET metinleri
 * (parametre eksik: "Kime ileteyim?") burada üretilebilir; onlar sonuç iddiası
 * taşımaz. Kapı: `electron/intentRegression.test.cjs` → "ADP-857 kip kapısı".
 */
function parseIntent(transcript, context = {}) {
  const t = String(transcript || '').trim();
  const low = t.toLocaleLowerCase('tr');
  // ADP-854 — jetonlar BİR KEZ çıkarılır; tüm morfoloji sorguları bunun üstünde koşar.
  const toks = morph.tokens(low);
  const isStatus = STATUS_RE.test(low) || hasV(toks, 'summarize');
  // ADP-322 — KULLANICI DİREKTİFİ, DELEGATE_RE'DEN ÖNCE. Kök neden (ADP-321 §1b):
  // DELEGATE_RE 'yaptır|hallet|delege|başlat' içeriyor ve OLUMSUZLAMA görmüyordu →
  // "sen hallet" / "delege etme" cümleleri kural-tabanlı yedek yolda da delegasyona
  // düşüyordu (beyin çökse bile yanlış cevap). Direktif 'self' ise delegasyon YASAK.
  // Açık "tek ajana ver" / "takıma dağıt" direktifi ZATEN bir delegasyon niyetidir —
  // DELEGATE_RE'nin fiil listesine ("görev ver", "ata") uymasa bile.
  const directive = fanoutPolicy.detectDirective(t);
  const isDelegate =
    (DELEGATE_RE.test(low) || directive === 'single' || directive === 'team') &&
    directive !== 'self' &&
    // ADP-854 — DELEGATE_RE'nin fiilleri ("başlat|söyle|hallet|çalıştır|yaptır|ata")
    // OLUMSUZ biçimlerini de yakalıyordu: "bunu söyleme" bir DELEGASYON sanılıyordu.
    !negV(toks, 'delegateVerb');
  const mentionsTerminal = TERMINAL_RE.test(low);

  // ── ADP-854 §1 — KAPATMA, AÇMADAN ÖNCE ────────────────────────────────────
  // Kök neden (ekrandaki vaka): "Açtığın kodeks terminallerini kapatır mısın?"
  // cümlesi ÖNCE spawn kapısına düşüyordu — "Açtığın" içindeki "aç" alt-dizesi
  // açma fiili sanılıyor, "kodeks" motor adı sayılıyor ve asistan kapatmak yerine
  // YENİ BİR CODEX PANE AÇIYORDU. İki bağımsız düzeltme birlikte gerekli:
  //   (a) SIRA: kapatma niyeti spawn/new-shell'den ÖNCE değerlendirilir,
  //   (b) MORFOLOJİ: hasV/negV "kapat" ile "kapatma"yı ayırır (turkishMorph).
  // Bu dal olumsuzlamada KASTEN sessizdir: "terminali kapatma" → burada kill YOK.
  if (mentionsTerminal && hasV(toks, 'close')) {
    const all = ALL_RE.test(low);
    const target = all ? 'all' : detectDepartment(low, context) || null;
    // ADP-857 — NİYET METNİ ≠ SONUÇ METNİ. Buradaki `speak` eylemden ÖNCE üretilir
    // ama yürütücü onu eylemden SONRA söyler (`speak: decision.speak || …`), yani
    // şimdiki zamanlı bir cümle ("Terminalleri kapatıyorum.") iş BİTTİKTEN sonra
    // duyulurdu — kullanıcıya işin sürdüğü söyleniyordu. Kural yolu artık sonuç
    // cümlesi YAZMAZ: `null` bırakınca yürütücünün VERİDEN türeyen geçmiş-zamanlı
    // cümlesi konuşur ("3 terminali kapattım" — sayıyı da taşır).
    const speak = null;
    return {
      action: 'terminal',
      department: target && target !== 'all' ? target : null,
      objective: null,
      op: 'kill',
      target,
      speak,
    };
  }

  // ADP-444 — PROMPT'SUZ toplu terminal kuralı (beyin çökse de deterministik çalışır):
  // "5 codex terminali aç" / "3 claude 2 codex başlat" → spawn, objective=null (boş/idle
  // CLI pane'leri). Dar tutulur: (a) sayı AÇIKÇA söylendi VEYA terminal kelimesi geçti,
  // (b) açma fiili var, (c) "görev/prompt ver" geçmiyor (prompted spawn'ın objective'ini
  // kural katmanı uyduramaz — o LLM yolunda kalır). DELEGATE_RE'den ÖNCE: "başlat" fiili
  // orada da var, terminal-sayı deseni delegasyona düşmemeli.
  const spawnParsed = spawnSpec.parseSpawnBatches(t);
  // ADP-854 — "bir terminal aç" ≠ TOPLU SPAWN. `bir` Türkçede sayı değil BELİRTEÇtir;
  // spawnSpec onu 1 sayıyor ve "yeni BİR terminal aç" spawn'a düşüyordu (aynı cümle
  // "bir"siz söylendiğinde new-shell'e gidiyordu — aynı niyet, iki farklı sonuç).
  // Kural: spawn dalı ya ÇOK pane ister ya da motorun ADIYLA söylenmesini.
  const namedEngine = /\b(claude|klod|codex|kodeks)\b/i.test(low);
  const spawnWorthy = spawnParsed.total >= 2 || (spawnParsed.batches.length > 0 && namedEngine);
  if (
    spawnParsed.batches.length > 0 &&
    spawnWorthy &&
    (spawnParsed.explicit || mentionsTerminal) &&
    // ADP-854 — açma fiili MORFOLOJİK: "başlatma"/"açma" (olumsuz) artık spawn AÇMAZ.
    hasV(toks, 'open') &&
    !/(görev|gorev|prompt|şu işi|su isi|şunu yap|sunu yap|delege)/.test(low)
  ) {
    return {
      action: 'spawn',
      department: detectDepartment(low, context) || null,
      objective: null,
      op: null,
      target: null,
      count: spawnParsed.total,
      engine: spawnParsed.batches.length === 1 ? spawnParsed.batches[0].engine : null,
      batches: spawnParsed.batches,
      explicitCount: spawnParsed.explicit,
      speak: null,
    };
  }

  // ── ADP-854 §7 — SEKME GEZİNME (navigate) ─────────────────────────────────
  // Kural yolunda navigate dalı HİÇ YOKTU: "Görevler sekmesine geç" cümlesi
  // hiçbir dala uymayıp `reply`e düşüyordu; "Raporlar sekmesini aç" ise `rapor`
  // + `aç` yüzünden RAPOR AÇIYORDU (yanlış eylem, sessizce).
  // Ayırt edici sinyal "sekme/panel" ismidir ve rapor/board dallarından ÖNCE bakılır.
  // Sekme adını NORMALİZE ETMEYİZ — bu renderer'ın işi (actionBus.normalizeTabTarget,
  // ADP-263 kararı: beyne/kural yoluna sekme id'si ezberletme).
  {
    const tabIdx = toks.findIndex((tok) => morph.hasNoun([tok], ['sekme', 'panel', 'tab']));
    if (tabIdx > 0) {
      const target = toks[tabIdx - 1];
      if (hasV(toks, 'close')) {
        return { action: 'navigate', department: null, objective: null, op: 'tab-close', target, path: null, speak: null };
      }
      if (hasV(toks, 'open') || hasV(toks, 'goto') || hasV(toks, 'show')) {
        return { action: 'navigate', department: null, objective: null, op: 'tab', target, path: null, speak: null };
      }
    }
  }

  // ADP-291 — orkestra sınıfları. Terminal/browser'dan ÖNCE, çünkü ipuçları daha
  // spesifik ("sprint başlat", "temayı fosfor yap", "son raporu oku"); hepsi dar
  // regex'lerle korunuyor, eşleşmezse akış aşağıdaki eski dallara devam eder.
  // ── ADP-921 — KAYIT TABANLI AYAR KONTROLÜ (beyin gerekmeden) ─────────────
  // Tema dalından ÖNCE ama ondan DAR: üç şart birden aranır — (1) kayıtta bir
  // kontrol ifadesi geçiyor, (2) o kontrolün KAYITLI bir DEĞERİ geçiyor, (3) bir
  // değiştirme fiili var. Üçü birden olmazsa akış aşağı devam eder, yani "Görünüm
  // ve Dil'e git" bu dala DÜŞMEZ (değer yok) ve yüzey açma dalına gider.
  //
  // 🪤 Tema BU DALA DÜŞMEZ çünkü `param.kind='text'` → değer çözülmez (preset
  // adları ADP-448'in kendi regex'inde kalır; ikinci bir liste yazılmadı).
  {
    const hit = uiControls.resolveControl(toks);
    const value = hit ? uiControls.resolveControlValue(hit.control, toks) : null;
    const changed = /(yap|değiştir|degistir|çevir|cevir|geç|gec\b|olsun|al\b|ayarla)/.test(low);
    // ADP-854 sınıfı: OLUMSUZ biçim eylem DEĞİLDİR ("dili değiştirme").
    const negated = negV(toks, 'mark') || /(değiştirme|degistirme|yapma|çevirme|cevirme)/.test(low);
    if (hit && value && changed && !negated) {
      return {
        action: hit.control.action,
        department: null,
        objective: null,
        op: hit.control.op,
        target: null,
        value,
        speak: null,
      };
    }
  }
  if (THEME_RE.test(low) && THEME_CHANGE_CUE_RE.test(low)) {
    // AXP-08 — OLUMSUZ biçim önce elenir: "Temayı koyu YAPMA" / "temaya GEÇME"
    // hiçbir tema üretmez. (Bugün de sessizdi ama SEBEBİ "koyu"nun tanınmamasıydı;
    // taban sözcükleri tanınır tanınmaz bu kapı GEREKLİ hâle geldi — ADP-854 sınıfı.)
    const themeNegated = negV(toks, 'mark') || negV(toks, 'open') || negV(toks, 'change') || THEME_NEG_RE.test(low);
    // Preset adını THEME_PRESETS'ten değil, konuşulan metinden çıkar — id eşlemesi
    // renderer'ın işi (getPreset + LEGACY_PRESET_MAP); burada yalnız kelimeyi
    // yakalayıp id biçimine indiririz. ADP-448 — tema v3 adları (Türkçe aksanlı
    // söyleyişler dahil); v2 adları da yakalanır, executor halefine çözer.
    // AXP-08 — ADP-519'un 8 KONFOR teması (kutup/fıstık/yosun/pastel/gülkurusu/
    // atölye/kumsal/sedef) bu listeye HİÇ eklenmemişti: "Temayı Kutup yap" kural
    // yolunda ölçüldü ve düşüyordu (varsayılan temanın ADI bile söylenemiyordu).
    const m = low.match(/(gece ?vardiyas[ıi]|derin|k[öo]m[üu]r|fosfor|k[âa][ğg][ıi]t|g[üu]nd[üu]z|sentetik ?gece|sonar|amber ?konsol|sepya|sera|bulut|grafit|obsidyen|espresso|duman|bordo|orman|beton|lavanta|kutup|f[ıi]st[ıi]k|yosun|pastel|g[üu]lkurusu|at[öo]lye|kumsal|sedef)/);
    if (m && !themeNegated) {
      const spoken = m[1].replace(/\s+/g, '-');
      const theme = /^gece-?vardiyas/.test(spoken) ? 'gece-vardiyasi'
        : /^k[öo]m[üu]r$/.test(spoken) ? 'komur'
        : /^k[âa][ğg][ıi]t$/.test(spoken) ? 'kagit'
        : /^g[üu]nd[üu]z$/.test(spoken) ? 'gunduz'
        : /^f[ıi]st[ıi]k$/.test(spoken) ? 'fistik'
        : /^g[üu]lkurusu$/.test(spoken) ? 'gulkurusu'
        : /^at[öo]lye$/.test(spoken) ? 'atolye'
        : spoken;
      return { action: 'settings', department: null, objective: null, op: 'theme', target: null, theme, speak: null };
    }
    // AXP-08 — preset ADI yoksa TABAN sözcüğüne bak ("koyu/karanlık/gece/siyah",
    // "açık/aydınlık/gündüz/beyaz"). Sıra ÖNEMLİ: ad önce, taban sonra — yoksa
    // "Gece Vardiyası temasına geç" taban 'gece'ye düşer ve yanlış preset gelirdi.
    if (!m && !themeNegated) {
      const base = detectThemeBase(low, t.toLowerCase());
      if (base) {
        return { action: 'settings', department: null, objective: null, op: 'theme', target: null, theme: THEME_BASE_PRESET[base], speak: null };
      }
    }
  }
  if (SPRINT_STATUS_RE.test(low)) {
    return { action: 'sprint', department: null, objective: null, op: 'status', target: null, speak: null };
  }
  // ADP-854 — "sprint başlatma" sprint BAŞLATMAZ (olumsuz biçim).
  if (SPRINT_START_RE.test(low) && hasV(toks, 'open')) {
    const objective = t.replace(/^[^]*?sprint\s*(başlat|baslat|aç|ac|start)\s*:?\s*/i, '').trim();
    if (objective) {
      return { action: 'sprint', department: detectDepartment(low, context) || null, objective, op: 'start', target: null, speak: null };
    }
  }
  if (MEMORY_PROMOTE_RE.test(low)) {
    const who = detectAgentName(low, context);
    const text = t.replace(/^[^]*?(kurala (yükselt|yukselt|çevir|cevir)|kural(a| olarak) (ekle|kaydet)|terfi et)\s*:?\s*/i, '').trim();
    if (who && text) {
      return { action: 'memory', department: null, objective: text, op: 'promote', target: who, speak: null };
    }
  }
  if (MEMORY_WHAT_RE.test(low)) {
    const who = detectAgentName(low, context);
    if (who) return { action: 'memory', department: null, objective: null, op: 'what', target: who, speak: null };
  }
  // ADP-306 — ajanın son mesajı. REPORT'tan ÖNCE: "Bumblebee'nin son raporu neydi"
  // cümlesi 'rapor' kelimesi yüzünden dosya-raporu dalına kaçardı. Ajan adı şart —
  // adsızsa aşağıdaki rapor/board dalları eskisi gibi çalışır (davranış korunur).
  if (AGENT_LAST_RE.test(low)) {
    const who = detectAgentName(low, context);
    if (who) {
      return { action: 'agent', department: null, objective: null, op: 'last-message', target: who, speak: null };
    }
  }
  if (REPORT_RE.test(low)) {
    // ADP-854 §6 — ÇIPLAK NUMARA da bir referanstır: "854 raporunu aç". Eskiden id
    // deseni `ADP-` önekini ŞART koşuyordu → referans null kalıyor, yürütücü sessizce
    // EN SON raporu açıyordu (kullanıcı yanlış raporu okuduğunu fark etmiyor).
    // `allowBare` yalnız BU dalda açık: "5 codex aç" cümlesindeki 5 id sanılmasın.
    const taskId = entityResolve.parseTaskRef(t, { allowBare: true });
    if (hasV(toks, 'list')) {
      return { action: 'report', department: null, objective: null, op: 'list', target: null, taskId: null, speak: null };
    }
    if (hasV(toks, 'open') || hasV(toks, 'show') || /editör/.test(low)) {
      return { action: 'report', department: null, objective: null, op: 'open', target: null, taskId, speak: null };
    }
    if (hasV(toks, 'read') || /(özet\b|ne diyor)/.test(low)) {
      return { action: 'report', department: null, objective: null, op: 'read', target: null, taskId, speak: null };
    }
  }
  // ADP-854 — "listeleme"/"gösterme" olumsuz biçimleri listelemez.
  if (BOARD_LIST_RE.test(low) && (hasV(toks, 'list') || hasV(toks, 'show') || /(ne var|neler var|liste\b)/.test(low))) {
    const sm = low.match(BOARD_STATUS_RE);
    const taskStatus = sm ? normalizeBoardStatusWord(sm[1]) : null;
    return { action: 'board', department: null, objective: null, op: 'list', target: null, taskStatus, speak: null };
  }
  {
    const idm = t.match(TASK_ID_RE);
    if (idm) {
      const taskId = idm[1].toUpperCase();
      const who = detectAgentName(low, context);
      // ADP-854 — atama fiili morfolojik doğrulanır ("atama kuralları" ≠ "ata").
      if (/(ata\b|ataya|atayalım|ver\b|devret)/.test(low) && hasV(toks, 'giveVerb') && who) {
        return { action: 'board', department: null, objective: null, op: 'assign', target: null, taskId, assignee: who, speak: null };
      }
      const sm = low.match(BOARD_STATUS_RE);
      // ADP-854 — durum değiştirme fiili morfolojik doğrulanır ("yapma" ≠ "yap").
      if (sm && /(yap|al\b|geç|gec\b|taşı|tasi|işaretle|isaretle)/.test(low) && (hasV(toks, 'mark') || /\bal\b/.test(low))) {
        const taskStatus = normalizeBoardStatusWord(sm[1]);
        if (taskStatus) {
          return { action: 'board', department: null, objective: null, op: 'status', target: null, taskId, taskStatus, speak: null };
        }
      }
    }
  }
  // ADP-854 — BOARD_NEW_RE'nin `(aç|oluştur|ekle)` alt-dizesi "görev açıklaması yaz"
  // gibi cümleleri de yakalıyordu (türev çakışması). Fiil artık morfolojik doğrulanır.
  if (BOARD_NEW_RE.test(low) && !mentionsTerminal && (hasV(toks, 'open') || hasV(toks, 'create'))) {
    const title = t.replace(/^[^]*?(görev|gorev|task)\s*(aç|ac|oluştur|olustur|ekle)\s*:?\s*/i, '').trim();
    if (title) {
      return { action: 'board', department: detectDepartment(low, context) || null, objective: null, op: 'create', target: null, title, speak: null };
    }
  }

  // ADP-132 — terminal control (checked before delegate so "terminali kapat" /
  // "yeni terminal aç" never falls through to a delegation).
  // ADP-854 — kapatma dalı YUKARI TAŞINDI (spawn'dan önce, §1). Burada yalnız
  // yeni-shell/odak kaldı; açma fiili yine morfolojik doğrulanır ("terminal açma"
  // yeni pane AÇMAZ).
  if (mentionsTerminal && hasV(toks, 'open') && !negV(toks, 'open')) {
    return { action: 'terminal', department: null, objective: null, op: 'new-shell', target: null, speak: null };
  }
  // ADP-854 — "odaklanma"/"gösterme" olumsuz biçimleri odaklamaz.
  if (mentionsTerminal && TERM_FOCUS_RE.test(low) && (hasV(toks, 'focus') || hasV(toks, 'show') || /öne (al|getir)/.test(low))) {
    const target = detectDepartment(low, context) || null;
    return { action: 'terminal', department: target, objective: null, op: 'focus', target, speak: null };
  }

  // ADP-135 — internal-browser control. Checked before status/delegate, but only on
  // STRONG, unambiguous cues (a host token, "geri git", "sayfayı oku", "… diye ara",
  // "ilk linke tıkla") so a normal delegation/status command is never stolen. The
  // brain (claude) handles the natural-language long tail; this is the safe fallback.
  const hostMatch = t.match(HOST_RE);
  // ADP-854 — "geri gitme" geri GİTMEZ.
  const wantsBack = BROWSER_BACK_RE.test(low) && (hasV(toks, 'goto') || /önceki sayfa/.test(low));
  // ADP-854 — "tıklama" (olumsuz) artık tıklatmaz.
  const wantsClick =
    BROWSER_CLICK_RE.test(low) && hasV(toks, 'click') && /(bağlant|link|buton|düğme|sonuç|sonuc|["'“”])/.test(low);
  // ADP-854 — "Sayfayı okuma, ben okurum": /oku/ alt-dizesi olumsuz biçimi de
  // yakalıyordu → asistan "okuma" derken sayfayı OKUYORDU.
  const wantsRead = BROWSER_READ_RE.test(low) && hasV(toks, 'read');
  const wantsSearch = BROWSER_SEARCH_RE.test(low) && !isDelegate;
  const wantsOpen = !!hostMatch && (BROWSER_OPEN_RE.test(low) || BROWSER_CUE_RE.test(low)) && !isDelegate;

  if (wantsBack) {
    return { action: 'browser', department: null, objective: null, op: 'back', target: null, url: null, query: null, selector: null, speak: null };
  }
  if (wantsClick) {
    let selector = null;
    const quoted = t.match(/["'“”]([^"'“”]{1,80})["'“”]/);
    if (/(ilk|birinci|baştaki|ilkine|birincisine)/.test(low) && /(bağlant|link|sonuç|sonuc)/.test(low)) selector = 'a';
    else if (quoted) selector = quoted[1].trim();
    else if (/(buton|düğme|button)/.test(low)) selector = 'button';
    else if (/(bağlant|link)/.test(low)) selector = 'a';
    if (selector) {
      return { action: 'browser', department: null, objective: null, op: 'click', target: null, url: null, query: null, selector, speak: null };
    }
  }
  if (wantsRead) {
    return { action: 'browser', department: null, objective: null, op: 'read', target: null, url: null, query: null, selector: null, speak: null };
  }
  if (wantsSearch) {
    const query = t
      .replace(/\b(internette|internetten|web['’]?de|web['’]?den|google['’]?(?:da|de|den)?|tarayıcıda|sitede)\b/gi, ' ')
      .replace(/\bdiye\b/gi, ' ')
      .replace(/\b(arasana|aratır mısın|arar mısın|arama yap|aratt?[ıi]r|arat|ara)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (query) {
      return { action: 'browser', department: null, objective: null, op: 'search', target: null, url: null, query, selector: null, speak: null };
    }
  }
  if (wantsOpen && hostMatch) {
    const url = hostMatch[1];
    return { action: 'browser', department: null, objective: null, op: 'open', target: null, url, query: null, selector: null, speak: null };
  }

  // ── ADP-884 — TARAYICIDA GERÇEK ETKİLEŞİM ─────────────────────────────────
  // Sıra ÖNEMLİ: yukarıdaki eski dallar (wantsClick/wantsRead/wantsSearch) önce
  // koşar — "İlk linke tıkla" hâlâ selector='a' üretir, buradaki metin-tabanlı
  // arama onu EZMEZ (davranış regresyonu yok, korpus H3/H5 kilitli).
  {
    // KAYDIRMA. Yön sözcüğü tek başına niyettir; fiil opsiyoneldir ("biraz aşağı").
    // 🪤 OLUMSUZLAMA: "aşağı kaydırma" kaydırmaz — fiil olumsuzsa dal SESSİZ kalır.
    if (
      !isDelegate && SCROLL_CUE_RE.test(low) &&
      !negV(toks, 'scroll') && !negV(toks, 'move') && !negV(toks, 'goto') &&
      !isStoppedScroll(low, toks)  // ADP-884 2. tur: "yukarı kaydırmayı bırak"
    ) {
      const to = SCROLL_END_RE.test(low) ? 'bottom' : SCROLL_START_RE.test(low) ? 'top' : null;
      const step = SCROLL_SMALL_RE.test(low) ? SCROLL_STEP_SMALL : SCROLL_BIG_RE.test(low) ? SCROLL_STEP_BIG : SCROLL_STEP_DEFAULT;
      const up = !to && SCROLL_TOP_RE.test(low);
      return {
        action: 'browser', department: null, objective: null, op: 'scroll', target: null,
        url: null, query: null, selector: null,
        scrollTo: to, dy: to ? null : up ? -step : step, speak: null,
      };
    }
    // ── ADP-884/jazz — AYNI KAYDIRMA, İNGİLİZCE ─────────────────────────────
    // TR dalı YUKARIDA ve DEĞİŞMEDİ (bayt-aynı) → Türkçe davranışta sıfır regresyon;
    // bu dal yalnız TR eşleşmediğinde konuşur.
    // 🪤 `low` TÜRKÇE küçültmedir: 'A LITTLE'.toLocaleLowerCase('tr') → 'a lıttle'
    // (noktasız ı) ve İngilizce desen KAÇAR. Büyük harfli STT çıktısı (ve "I") bu
    // yüzden AYRI, yerelden bağımsız bir küçültmeyle sorulur.
    const lowEn = t.toLowerCase();
    // ADP-884 2. tur — NİTELENMEMİŞ "scroll" (yön/uç/miktar YOK, çıplak emir de değil)
    // bir KOMUT DEĞİL, bir isimdir ("the scroll bar is broken"). Kapı yukarıda.
    const enQualified =
      EN_SCROLL_DOWN_RE.test(lowEn) || EN_SCROLL_UP_RE.test(lowEn) ||
      EN_SCROLL_BOTTOM_RE.test(lowEn) || EN_SCROLL_TOP_RE.test(lowEn) ||
      EN_SCROLL_SMALL_RE.test(lowEn) || EN_SCROLL_BIG_RE.test(lowEn) ||
      EN_BARE_SCROLL_RE.test(t.trim());
    if (!isDelegate && EN_SCROLL_CUE_RE.test(lowEn) && !EN_NEG_RE.test(lowEn) && enQualified) {
      const to = EN_SCROLL_BOTTOM_RE.test(lowEn) ? 'bottom' : EN_SCROLL_TOP_RE.test(lowEn) ? 'top' : null;
      const step = EN_SCROLL_SMALL_RE.test(lowEn)
        ? SCROLL_STEP_SMALL
        : EN_SCROLL_BIG_RE.test(lowEn)
          ? SCROLL_STEP_BIG
          : SCROLL_STEP_DEFAULT;
      // Yön söylenmediyse AŞAĞI: "scroll" tek başına konuşma dilinde aşağıdır
      // (TR tarafında yön sözcüğü ZORUNLUdur; orada varsayılan üretilmez).
      const up = !to && EN_SCROLL_UP_RE.test(lowEn) && !EN_SCROLL_DOWN_RE.test(lowEn);
      return {
        action: 'browser', department: null, objective: null, op: 'scroll', target: null,
        url: null, query: null, selector: null,
        scrollTo: to, dy: to ? null : up ? -step : step, speak: null,
      };
    }
    // İLERİ / YENİLE — "geri git"in ikizleri (bugüne kadar YOKTU).
    if (!isDelegate && BROWSER_FORWARD_RE.test(low) && (hasV(toks, 'goto') || /ileri/.test(low)) && !negV(toks, 'goto')) {
      return { action: 'browser', department: null, objective: null, op: 'forward', target: null, url: null, query: null, selector: null, speak: null };
    }
    if (!isDelegate && BROWSER_RELOAD_RE.test(low) && hasV(toks, 'reload') && BROWSER_CUE_RE.test(low)) {
      return { action: 'browser', department: null, objective: null, op: 'reload', target: null, url: null, query: null, selector: null, speak: null };
    }
    // BAŞLIKLARI OKU — "sayfayı oku"nun dar kardeşi (seçici kullanıcıdan değil bizden).
    // 🪤 `!isDelegate` KULLANILAMAZ: "başlıkları SÖYLE" cümlesindeki 'söyle'
    // DELEGATE_RE'nin fiilidir (yani her zaman isDelegate=true olur). Ayırt edici
    // sinyal AD/TAKIM yokluğudur — "Bumblebee'ye başlıkları söyle" delegasyondur.
    if (
      HEADINGS_RE.test(low) &&
      (hasV(toks, 'read') || hasV(toks, 'tellVerb') || hasV(toks, 'list')) &&
      !detectAgentName(low, context) &&
      !detectDepartment(low, context)
    ) {
      return {
        action: 'browser', department: null, objective: null, op: 'read', target: null,
        url: null, query: null, selector: HEADINGS_SELECTOR, speak: null,
      };
    }
    // METİNLE TIKLAMA — kullanıcı CSS seçici söyleyemez; gördüğü YAZIYI söyler.
    // Onay kapısı DEĞİŞMEZ: tıklama hâlâ `onay-gerekli` (görev §8).
    if (!isDelegate && (hasV(toks, 'click') || hasV(toks, 'press')) && !negV(toks, 'click') && !negV(toks, 'press')) {
      const m = t.match(CLICK_BY_TEXT_RE);
      const findText = m ? m[1].trim().toLocaleLowerCase('tr') : null;
      if (findText && findText.length >= 2) {
        return {
          action: 'browser', department: null, objective: null, op: 'click', target: null,
          url: null, query: null, selector: null, findText, speak: null,
        };
      }
    }
    // FORM DOLDURMA — "arama kutusuna X yaz". Yazma da `onay-gerekli` kalır.
    if (!isDelegate && hasV(toks, 'write') && !negV(toks, 'write')) {
      const into = t.match(TYPE_INTO_RE);
      if (into) {
        return {
          action: 'browser', department: null, objective: into[2].trim(), op: 'type', target: null,
          url: null, query: null, selector: null, findText: into[1].trim().toLocaleLowerCase('tr'), speak: null,
        };
      }
      // Alan söylenmediyse yalnız GÜÇLÜ tarayıcı ipucu varken üstlen (yoksa bu cümle
      // bir delegasyon olabilir: "şu dosyaya şunu yaz").
      const plain = BROWSER_CUE_RE.test(low) ? t.match(TYPE_PLAIN_RE) : null;
      if (plain && plain[1].trim()) {
        return {
          action: 'browser', department: null, objective: plain[1].trim(), op: 'type', target: null,
          url: null, query: null, selector: null, findText: null, speak: null,
        };
      }
    }
  }

  // ── ADP-883 §2 — YÜZEY AÇMA (KAYIT TABANLI, tek tek özel durum YOK) ───────
  //
  // GEÇ konumlandırıldı BİLEREK: yukarıdaki tüm eski dallar (terminal/spawn/sekme/
  // rapor/pano/tarayıcı) önce koşar, yani bu blok YALNIZCA eskiden `reply`e düşen
  // cümleleri yakalar. Davranış regresyonu yapısal olarak imkânsız.
  //
  // Üç çıkış: (a) kayıtta VAR + olumlu açma fiili → yüzeyi aç · (b) kayıtta var ama
  // fiil OLUMSUZ ("ayarları açma") → dal sessiz (aşağıda reply) · (c) kullanıcı bir
  // EKRAN istiyor ama kayıtta YOK → DÜRÜST "bulamadım" (uydurma yok, görev §5).
  {
    const opensSurface = hasV(toks, 'open') || hasV(toks, 'show') || hasV(toks, 'goto');
    const negatedOpen = negV(toks, 'open') || negV(toks, 'show') || negV(toks, 'goto');
    const hit = uiSurfaces.resolveSurface(toks);
    if (hit && !negatedOpen && (opensSurface || (hit.surface.selfActuating && hasV(toks, 'create')))) {
      return {
        action: 'navigate', department: null, objective: null, op: 'surface',
        target: hit.surface.id, path: null, speak: null,
      };
    }
    // (c) "Muhasebe ekranını aç" — ekran ADI var, kayıt YOK. Sessizce en yakınını
    // AÇMAK yanlış ekranı açmaktır; kullanıcıya ne bulamadığımızı söyleriz.
    if (!hit && opensSurface && SCREEN_NOUN_RE.test(low) && !isDelegate && !mentionsTerminal) {
      const words = toks.filter((tk) => tk.length > 3 && !SCREEN_NOUN_RE.test(tk));
      const unknown = words.length ? words[0] : null;
      if (unknown) {
        const near = uiSurfaces.suggestSurface(toks);
        return {
          action: 'reply', department: null, objective: null, op: null, target: null,
          unknownSurface: unknown,
          speak: near
            ? `Öyle bir ekran bulamadım. "${near.label}" ekranını mı demek istedin?`
            : 'Öyle bir ekran bulamadım.',
        };
      }
    }
  }

  if (isStatus && !isDelegate) {
    return { action: 'status', department: detectDepartment(low, context), objective: null, op: null, target: null, speak: null };
  }

  // ── ADP-854 §4/§5 — KİME? (ad · yakın-ad · ROL) ───────────────────────────
  // Kök neden: hedefleme fiili ("söyle"/"ver") DELEGATE_RE'de olduğu için
  // "Reis'e söyle …" cümlesi doğrudan TAKIM delegasyonuna düşüyordu; ad hiç
  // sorulmuyordu (→ iş BAŞKA ajana gidiyordu). Rol diye bir kavram ise hiç yoktu.
  //
  // ÖNCELİK: "X takımına ver" cümlesinde takım ADI bir ajan adıyla aynı olsa bile
  // TAKIM kazanır (mevcut davranış — "Stark takımına yaptır" testi bunu kilitliyor).
  // SORU DEĞİL, EMİR olmalı: "Jazz'a ne verdin?" bir görev atama isteği değildir.
  // Dar kapı — soru zamiri VE soru işareti birlikte aranır ki "Wheeljack'e görev
  // verir misin?" (kibar emir) yanlışlıkla elenmesin.
  const isQuestion =
    /\?\s*$/.test(t) && /(^|\s)(ne|kim|kime|kimin|hangi|neden|niye|nasıl|nasil|nerede|kaç|kac)(\s|\?|$)/.test(low);
  const wantsHandoff = isDelegate || hasV(toks, 'tellVerb') || hasV(toks, 'giveVerb');
  if (wantsHandoff && !isQuestion && directive !== 'self') {
    const deptHint = detectDepartment(low, context);
    // VETO yalnız TAKIM YÖNELME hâlinde: "Stark takımına yaptır" → takım.
    // "Jazz'a söyle regresyon takımını koşsun" → takım kelimesi İŞİN parçası,
    // hedef yine Jazz. (Çıplak "takım" araması bu cümleyi de vetoluyordu — ölçüldü.)
    const teamDative = /(takım|takim|ekib?|ekip)[ıiu]?n?[ae]\b/.test(low);
    if (!(teamDative && deptHint)) {
      const who = entityResolve.resolveAgent(t, context);
      if (who.id) {
        return {
          action: 'tell',
          department: who.department || deptHint || context.defaultDepartment || null,
          objective: t,
          op: null,
          target: who.id,
          executor: 'single',
          resolvedVia: who.via,
          speak: null,
        };
      }
      // BULAMADIYSA UYDURUP BAŞKASINA VERME (görev §4) — dürüst soru.
      if (who.unresolvedName) {
        return {
          action: 'reply', department: null, objective: t, op: null, target: null,
          unresolvedTarget: who.unresolvedName,
          speak: `"${who.unresolvedName}" adında bir ajan bulamadım. Kimi kastettin?`,
        };
      }
      if (who.unresolvedRole) {
        return {
          action: 'reply', department: null, objective: t, op: null, target: null,
          unresolvedRole: who.unresolvedRole,
          speak: `Ekipte bu rolde bir ajan yok. Kime vereyim?`,
        };
      }
    }
  }

  if (isDelegate) {
    const department = detectDepartment(low, context) || context.defaultDepartment || null;
    const speak = department
      ? `Tamam, ${departmentLabel(department, context)} takımına görevi ilettim.`
      : 'Tamam, görevi takıma ilettim.';
    // ADP-146 — flag a multi-step web objective so the executor routes it to a
    // browser-capable worker (headed internal-browser driver), not a headless one.
    const browserTask = BROWSER_TASK_RE.test(low);
    return { action: 'delegate', department, objective: t, browserTask, op: null, target: null, speak };
  }
  if (low.includes('durum')) {
    return { action: 'status', department: detectDepartment(low, context), objective: null, op: null, target: null, speak: null };
  }
  // ADP-322 — "sen kendin yap" dendi ama kural-tabanlı parser bir katalog eylemi
  // bulamadı (yukarıdaki browser/navigate/board/terminal dallarının hiçbiri tutmadı).
  // DÜRÜST RET: sessizce delegasyona dönmek tam da onarılan bug'dı.
  if (directive === 'self') {
    return {
      action: 'reply',
      department: null,
      objective: t,
      op: null,
      target: null,
      executor: 'self',
      speak: 'Bunu kendi araçlarımla yapamıyorum (kod/dosya yazımı gerekiyor). Tek ajana vereyim mi?',
    };
  }
  // AXP-01 — "ANLADIM" YOLU KAPALI. Bu dal "hiçbir katalog dalı tutmadı" demektir;
  // "Anladım." deyip boş durmak G1'in yasakladığı şeydir. Karar `unclassified` ile
  // işaretlenir: beyin cevaplarsa beyin konuşur; beyin de bilemezse yönlendirici bunu
  // `belirsiz`e çevirir ve TEK SORU sorar (routePromptClass). `speak` burada YOKTUR.
  return { action: 'reply', department: null, objective: null, op: null, target: null, speak: null, unclassified: true };
}

/** Ajan AÇAN (ya da bir ajanın pane'ini kullanan) eylemler — 'self' direktifi bunları YASAKLAR. */
const AGENT_OPENING_ACTIONS = ['delegate', 'spawn', 'tell', 'prompt'];

/**
 * ADP-322 — YÜRÜTÜCÜ POLİTİKASI (deterministik kapı; beynin çıktısının ÜSTÜNDE koşar).
 *
 * ORCH_SYSTEM'e yönerge yazmak YETMEZ: beyin onu yok sayabilir (ADP-321'in canlı vakası
 * tam olarak buydu — Eren "sen kendin yap" dedi, beyin yine delegate seçti). Bu yüzden
 * direktif SAF KODLA zorlanır:
 *
 *   • 'self'  → ajan açan HER eylem (delegate/spawn/tell) BLOKLANIR. Önce kural-tabanlı
 *               parser'a sorulur: iş Jarvis'in kataloğuna iniyor mu (browser/navigate/
 *               board/terminal…)? İniyorsa Jarvis KENDİSİ yapar. İnmiyorsa DÜRÜST RET
 *               ("kendim yapamam, tek ajana vereyim mi?") — sessiz delegasyon YOK.
 *   • 'single'/'team' → yalnız delegate'i etiketler; genişliği yürütücü (renderer)
 *               planWidth ile hesaplar, >1 ise ONAY KARTI çıkarır.
 *
 * Saf: karar nesnesini mutasyona uğratmaz, yenisini döner.
 */
/**
 * ADP-854 §3 — KURAL YOLU ↔ LLM ÖNCELİĞİ (NET KURAL, tek yerde yazılı)
 *
 * VARSAYILAN: **LLM KAZANIR.** `decide()` sırası kalıcı oturum → soğuk `claude -p` →
 * kural parser; kural yolu yalnız beyin hiç cevap veremediğinde devreye girer.
 * Sebebi ölçülmüş: [[two-layer-brain-815]] §6 — kural katmanı 8 cümlenin 5'inde niyeti
 * bulamıyor. Yani kural yolu GENEL bir sınıflandırıcı DEĞİLDİR.
 *
 * İSTİSNA: aşağıdaki DÖRT tartışmasız desende kural EZER (yüksek güvenli kapılar).
 * Listede olmayan hiçbir şeyde kural beynin kararına dokunmaz — ŞÜPHEDE LLM'E BIRAKILIR.
 *
 *   1. YÜRÜTÜCÜ DİREKTİFİ ('sen yap' / 'tek ajana' / 'takıma')        — ADP-322
 *   2. SPAWN SAYISI ve MOTORU (kullanıcının söylediği sayı kazanır)   — ADP-444
 *   3. KAPATMA NİYETİ: terminal ismi + OLUMLU kapatma fiili varken beyin ajan AÇAN
 *      bir eylem (spawn/delegate/tell) ya da `new-shell` döndüyse                — ADP-854
 *   4. OLUMSUZLAMA: açma fiili OLUMSUZ ("açma"/"başlatma") iken beyin spawn/new-shell
 *      seçtiyse eylem DÜŞER (dürüst ret)                                        — ADP-854
 *
 * 3 ve 4 neden burada, `parseIntent` içinde değil: beyin de aynı hatayı yapıyor
 * (ORCH_SYSTEM'e cümle eklemek bir kapı DEĞİLDİR — ADP-322'nin ölçülmüş dersi).
 */
function applyRulePriorityGates(decision, transcript, context) {
  const low = morph.trLower(transcript);
  const toks = morph.tokens(low);
  const mentionsTerminal = TERMINAL_RE.test(low);
  const opensAgent = AGENT_OPENING_ACTIONS.includes(decision.action);
  const opensShell = decision.action === 'terminal' && decision.op === 'new-shell';

  // §3 — KAPATMA, AÇMAYI EZER.
  if (mentionsTerminal && hasV(toks, 'close') && (opensAgent || opensShell)) {
    const local = parseIntent(transcript, context);
    if (local && local.action === 'terminal' && local.op === 'kill') {
      return { ...local, rulePriority: 'close-over-open' };
    }
  }

  // ── ADP-884/jazz §8 — OLUMSUZLANMIŞ KAYDIRMA BEYNİ DE BAĞLAR ──────────────
  // ADP-883 §6'nın (negated-surface-open) kaydırma ikizi. Aynı ölçülmüş gerekçe:
  // ORCH_SYSTEM'e "olumsuzluğa dikkat et" YAZMAK BİR KAPI DEĞİLDİR (ADP-322) —
  // beyin "aşağı kaydırma" / "don't scroll down" cümlelerinde rahatlıkla
  // browser/scroll üretir. Kural yolu bunu ZATEN reddediyordu; kapı artık beyin
  // kararının da üstünde.
  if (decision.action === 'browser' && decision.op === 'scroll') {
    // ADP-884 2. tur: EK ile olumsuzlama (negV) + FİİL ile olumsuzlama (isStoppedScroll,
    // "kaydırmayı bırak") — ikisi de beynin kararını bağlar; ikizi EN 'stop' sözcüğüdür.
    const negTr = negV(toks, 'scroll') || negV(toks, 'move') || negV(toks, 'goto') || isStoppedScroll(low, toks);
    if (negTr || EN_NEG_RE.test(String(transcript || ''))) {
      return {
        action: 'reply', department: null, objective: null, op: null, target: null,
        rulePriority: 'negated-scroll',
        speak: 'Kaydırmamamı istedin, o yüzden kaydırmadım.',
      };
    }
  }

  // ── ADP-884/jazz §10 — MİKTAR SÖZCÜĞÜ BEYNİ EZER ──────────────────────────
  // CANLIDA ÖLÇÜLDÜ (e2e/adp884-voice-scroll T1): "Biraz aşağı kaydır" için beyin
  // dy=600 döndürüyordu — yani "biraz" ile "aşağı" AYNI mesafeyi kaydırıyordu ve
  // kullanıcının söylediği miktar sessizce KAYBOLUYORDU. Kural yolu doğru değeri
  // (300) zaten üretiyor; birim testler bunu göremezdi çünkü canlıda karar beynin.
  // Desen ADP-444'ten kopyalandı, icat edilmedi: "kullanıcının söylediği SAYI her
  // zaman kazanır" — LLM tahmini sayısal parametrede belirleyici olamaz.
  // KAPI DAR: yalnız cümlede AÇIK bir miktar sözcüğü varsa ("biraz"/"çok"/"a bit"/
  // "a lot") devreye girer; miktarsız kaydırmalarda beynin kararına dokunmaz.
  if (decision.action === 'browser' && decision.op === 'scroll') {
    const lowEnRaw = String(transcript || '').toLowerCase();
    const hasAmountCue =
      SCROLL_SMALL_RE.test(low) || SCROLL_BIG_RE.test(low) ||
      EN_SCROLL_SMALL_RE.test(lowEnRaw) || EN_SCROLL_BIG_RE.test(lowEnRaw);
    if (hasAmountCue) {
      const local = parseIntent(transcript, context);
      if (local && local.action === 'browser' && local.op === 'scroll' && local.dy != null && local.dy !== decision.dy) {
        return { ...decision, dy: local.dy, scrollTo: null, rulePriority: 'scroll-amount' };
      }
    }
  }

  // §5 — HEDEF ÇÖZÜMLEME BEYİN YOLUNDA DA GEÇERLİ.
  // e2e'nin CANLI uygulamada bulduğu boşluk: ad/rol çözümlemesi yalnız kural yolundaydı,
  // ama kural yolu neredeyse hiç koşmuyor (beyin cevap veriyor) → "Test mühendisi bir
  // ajana ver" gerçek uygulamada `reply` dönüyordu. Birim testler bunu GÖREMEZDİ.
  // Kapı DAR: yalnız hedef-belirsiz eylemlerde (reply/delegate/tell) ve yalnız kural
  // yolu SOMUT bir ajan çözebildiyse devreye girer.
  if (['reply', 'delegate', 'tell'].includes(decision.action)) {
    const local = parseIntent(transcript, context);
    const same =
      decision.action === 'tell' &&
      morph.trLower(decision.target || '') === morph.trLower(local.target || '');
    if (local.action === 'tell' && local.target && !same) {
      return { ...local, rulePriority: 'entity-resolution', speak: decision.speak || local.speak };
    }
    // Çözülemeyen hedef: beyin bunu TAKIMA dağıtmasın — SOR (görev §4).
    if (local.action === 'reply' && (local.unresolvedTarget || local.unresolvedRole) && decision.action !== 'reply') {
      return { ...local, rulePriority: 'unresolved-target' };
    }
  }

  // ── ADP-883 §6 — YÜZEY AÇMA: OLUMSUZLAMA BEYNİ DE BAĞLAR ──────────────────
  // "Ayarları açma" cümlesinde beyin rahatlıkla navigate/tab|surface üretir (ölçüldü:
  // ORCH_SYSTEM'e "olumsuzluğa dikkat et" yazmak KAPI DEĞİLDİR — ADP-322 dersi).
  const negatedSurfaceOpen = negV(toks, 'open') || negV(toks, 'show') || negV(toks, 'goto');
  if (
    decision.action === 'navigate' &&
    (decision.op === 'surface' || decision.op === 'tab') &&
    negatedSurfaceOpen
  ) {
    return {
      action: 'reply', department: null, objective: null, op: null, target: null,
      rulePriority: 'negated-surface-open',
      speak: 'Açmamamı istedin, o yüzden açmadım.',
    };
  }

  // ── ADP-883 §7 — BEYİN ANLAYAMADIYSA KAYIT ÇÖZER ─────────────────────────
  // §5'in (hedef çözümleme) aynı kalıbı: kural yolu neredeyse hiç koşmaz (beyin
  // cevap veriyor), dolayısıyla kayıt YALNIZ parseIntent'e bağlanırsa canlıda ölü
  // kalır. Kapı DAR: yalnız beyin `reply` döndüyse (yani anlamadıysa) ve kural yolu
  // SOMUT bir yüzey çözebiliyorsa devreye girer. Beynin doğru bulduğu hiçbir karara
  // dokunmaz — şüphede LLM kazanır (ADP-854 §3 sözleşmesi).
  if (decision.action === 'reply' && !negatedSurfaceOpen) {
    const local = parseIntent(transcript, context);
    if (local && local.action === 'navigate' && local.op === 'surface' && local.target) {
      return { ...local, rulePriority: 'surface-registry' };
    }
    if (local && local.action === 'reply' && local.unknownSurface) {
      return { ...local, rulePriority: 'unknown-surface' };
    }
    // ADP-884/jazz §9 — KAYDIRMA da aynı kurtarma hattına bağlanır: beyin cümleyi
    // anlamadıysa ("scroll down" gibi İngilizce bir ifadede ölçüldü) ve kural yolu
    // SOMUT bir kaydırma çözebiliyorsa, sessiz `reply` yerine sayfa GERÇEKTEN kayar.
    // Beynin doğru bulduğu hiçbir karara dokunmaz (yalnız reply dalında).
    if (local && local.action === 'browser' && local.op === 'scroll') {
      return { ...local, rulePriority: 'scroll-fallback' };
    }
  }

  // §4 — OLUMSUZLANMIŞ AÇMA fiili varken pane açılmaz.
  if ((decision.action === 'spawn' || opensShell) && negV(toks, 'open')) {
    return {
      action: 'reply',
      department: null,
      objective: null,
      op: null,
      target: null,
      rulePriority: 'negated-open',
      speak: 'Açmamamı istedin, o yüzden yeni bir terminal açmadım.',
    };
  }

  return decision;
}

function applyExecutorPolicy(decision, transcript, context = {}) {
  if (!decision || typeof decision !== 'object') return decision;
  const policed = applyExecutorPolicyInner(decision, transcript, context);
  // AXP-01 — SON SÖZ yönlendiricinin: tell/delegate → prompt (taşınır), olumsuz → yok,
  // sınıflandırılamayan → tek soru. Kural kapıları ve fan-out politikası yukarıda
  // koşmuştur; yönlendirici onların ürettiği hedefi/yürütücüyü OLDUĞU GİBİ taşır.
  return routePromptClass(policed, transcript, context);
}

/** AXP-06 EK(a) — yankı kapısının hedefi: kararın hedefi OLDUĞU GİBİ (id ise takımı alias'tan). */
function echoTarget(decision, context) {
  if (decision.action === 'tell' && decision.target) {
    const aliases = Array.isArray(context && context.aliases) ? context.aliases : [];
    const a = aliases.find((x) => x && x.id === decision.target);
    if (a) return { agentId: a.id, teamId: a.department || null };
  }
  return promptRouter.brainTarget(decision, context);
}

/**
 * AXP-01 — NİYET YÖNLENDİRİCİSİNİN KARARA BAĞLANMASI.
 *
 * Kural yolu (`promptRouter.classify`, katalog = parseIntent) beyinden BAĞIMSIZ koşar;
 * `mergeBrain` beynin (ya da kural yolunun) kararıyla birleştirir:
 *   • `yok`       → reply, kısa sesli onay ("Tamam, dokunmadım."), beynin kararı DÜŞER.
 *   • `prompt`    → action:'prompt' + route (hedef/gövde). Beyin `tell/delegate` dediyse
 *                   hedefi ORADAN taşınır — yeniden türetilmez (agimen döngüsünün ilacı).
 *                   `executor`/`department`/`browserTask` gibi alanlar korunur (AXP-01
 *                   köprüsü teslimi bugünkü tell/delegate ilkelleriyle yapar).
 *   • `belirsiz`  → action:'prompt' + question (tek soru, iki seçenek). Yan etki YOK.
 *   • `aksiyon`   → karar AYNEN (aksiyon yolu dokunulmaz); yalnız `route` eklenir.
 *   • karar yok   → beynin sohbet cevabı aynen.
 */
function routePromptClass(decision, transcript, context) {
  if (!decision || typeof decision !== 'object') return decision;
  if (decision.action === 'prompt' && decision.route) return decision; // idempotent
  // MERGE-04 / CANCEL-01 §4.1 bulgusu — KAPI SIRASI: negated-* → yönlendirici.
  // ADP-883/884 kapıları ("aşağı kaydırma", "terminal açma") zaten DÜRÜST ve ÖZEL bir ret
  // üretmiştir ("…o yüzden kaydırmadım"). Yönlendiricinin `yok` sınıfı aynı kutupta ama
  // jenerik ("Tamam, dokunmadım.") — onun üstüne YAZILMAZ; kapının kararı aynen döner,
  // yalnız sınıf gözlemlenebilirlik için `route` olarak eklenir (korpus `yok` sayar).
  if (decision.action === 'reply' && /^negated-/.test(String(decision.rulePriority || ''))) {
    if (decision.route) return decision;
    return { ...decision, route: { cls: promptRouter.CLS.NONE, via: `gate:${decision.rulePriority}`, target: null, body: null } };
  }
  let catalog = null;
  let rule = null;
  try {
    catalog = parseIntent(transcript, context);
    rule = promptRouter.classify(transcript, context, { catalog });
  } catch {
    return decision; // yönlendirici patlarsa ürün eski yolunda devam eder (sessiz ölüm değil: test kapısı ayrıca ölçer)
  }
  // Beyin mi, kural yolunun kendi kararı mı? Beyin çalışmadığında (`via:'rule'`, testler)
  // buraya gelen karar parseIntent'in kendisidir; onu "beynin hedefi" sanmak kural yolunun
  // eski tell/delegate refleksini yönlendiricinin belirsiz hükmünün ÜSTÜNE çıkarırdı
  // (ÖLÇÜLDÜ: STT'nin bozduğu "Fakıha söyle …" cümlesi takıma delegasyona düşüyordu).
  const isRuleOwn =
    !!catalog &&
    decision.action === catalog.action &&
    (decision.objective ?? null) === (catalog.objective ?? null) &&
    (decision.target ?? null) === (catalog.target ?? null);
  // Kural yolunun kendi kararı beyin SAYILMAZ; yalnız "sınıflandırılamadı" işareti geçer
  // (o işaret beyin de bilemediğinde belirsiz sorusunu açar — "Anladım" yolu kapalı).
  const brainView = isRuleOwn ? (catalog.unclassified ? { action: 'reply', unclassified: true } : null) : decision;
  let route = promptRouter.mergeBrain(rule, brainView, transcript, context);
  // AXP-06 EK(a) — YANKI KAPISI (kural VE beyin kolu): karar `tell/delegate` ve objective
  // cümlenin KENDİSİ ise ("Kamil amcaya söyler misin?", "Şunu hallet.") o cümle hiçbir yolda
  // gövde olamaz. Eskiden `route=null` → karar AYNEN → `executeTell/delegate` → cümle hedefin
  // terminaline / boştaki ajana yeni pane olarak düşüyordu (AXP-05 B1, AXP-09 §2.5). Şimdi:
  // hedef varsa hedefli+gövdesiz taslak ("Dinliyorum. X için işi söyle"), yoksa taslak hedef sorar.
  const handoff = decision.action === 'tell' || decision.action === 'delegate';
  const echoed = handoff && promptRouter.isEchoObjective(decision.objective, transcript, context);
  if (!route && echoed) {
    route = { cls: promptRouter.CLS.PROMPT, via: 'echo-no-body', target: echoTarget(decision, context), body: null };
  }
  if (!route) return decision;
  if (echoed && route.cls === promptRouter.CLS.PROMPT && route.body && morph.trLower(route.body) === morph.trLower(String(decision.objective).trim())) {
    route = { ...route, body: null }; // mergeBrain 'brain' dalı gövde=objective taşımıştı — cümlenin kendisi
  }
  // Beyin bir İŞ GÖVDESİ çıkardıysa (cümlenin kendisi DEĞİL) ve kural yolu gövde bulamadıysa,
  // beynin gövdesi taşınır. Cümlenin aynısı gövde SAYILMAZ — "Stark'a bir iş vereceğim"
  // cümlesinin kendisi terminale düşmesin (AXP-00 B02).
  if (route.cls === promptRouter.CLS.PROMPT && !route.body && !isRuleOwn && decision.objective && !echoed) {
    const obj = String(decision.objective).trim();
    if (obj && morph.trLower(obj) !== morph.trLower(transcript)) route = { ...route, body: obj };
  }
  if (route.cls === promptRouter.CLS.ACTION) return { ...decision, route };
  if (route.cls === promptRouter.CLS.NONE) {
    return {
      action: 'reply', department: null, objective: null, op: null, target: null,
      route, rulePriority: 'prompt-router-none', speak: promptRouter.NONE_ACK,
    };
  }
  const target = route.target || null;
  const base = {
    action: 'prompt',
    department: (target && target.teamId) || decision.department || context.defaultDepartment || null,
    // Yankılanan objective (cümlenin kendisi) hiçbir yola TAŞINMAZ — takım/hedefsiz dalda
    // renderer `objective`i delegasyon gövdesi olarak okur (deliverPrompt).
    objective: route.body || (handoff && !echoed ? decision.objective : null) || null,
    op: null,
    target: (target && target.agentId) || null,
    route,
    speak: null,
  };
  if (route.cls === promptRouter.CLS.UNCLEAR) return { ...base, executor: null };
  // prompt — yürütücü genişliği/tarayıcı bayrağı beynin (ya da kural yolunun) kararından taşınır.
  const carried = {};
  if (decision.executor) carried.executor = decision.executor;
  if (decision.fanoutReason) carried.fanoutReason = decision.fanoutReason;
  if (decision.browserTask) carried.browserTask = decision.browserTask;
  if (decision.resolvedVia) carried.resolvedVia = decision.resolvedVia;
  if (!carried.executor) {
    carried.executor = target && target.agentId ? 'single' : fanoutPolicy.decideExecutor({ transcript, objective: base.objective || transcript }).executor;
  }
  return { ...base, ...carried };
}

function applyExecutorPolicyInner(decision, transcript, context = {}) {
  // ADP-854 — yüksek güvenli kural kapıları, fan-out politikasından ÖNCE
  // (kapatma kararı bir "yürütücü genişliği" sorusu değildir).
  const gated = applyRulePriorityGates(decision, transcript, context);
  if (gated !== decision) return gated;

  // ADP-444 — SPAWN SAYILARI DETERMİNİSTİK (ADP-322 §1 kalıbı: LLM'in çıktısının
  // üstünde saf kapı). Beyin "spawn" dediyse sayılar/motorlar TRANSKRİPTTEN yeniden
  // çıkarılır ve beynin tahminini EZER ("3 claude 2 codex" karışımı LLM şemasına
  // sığmaz; kullanıcının söylediği sayı her zaman kazanır). Takım adı geçiyorsa o
  // departman (detectDepartment), geçmiyorsa beynin dediği / aktif departman kalır.
  if (decision.action === 'spawn') {
    const parsed = spawnSpec.parseSpawnBatches(transcript);
    const low = String(transcript || '').toLocaleLowerCase('tr');
    decision = {
      ...decision,
      department: detectDepartment(low, context) || decision.department || null,
      ...(parsed.batches.length > 0
        ? {
            batches: parsed.batches,
            count: parsed.total,
            engine: parsed.batches.length === 1 ? parsed.batches[0].engine : null,
            explicitCount: parsed.explicit,
          }
        : { explicitCount: false }),
    };
  }

  const { executor, reason } = fanoutPolicy.decideExecutor({
    transcript,
    objective: decision.objective || transcript,
  });

  if (executor === 'self') {
    if (decision.action === 'self') return { ...decision, executor: 'self', fanoutReason: reason };
    if (AGENT_OPENING_ACTIONS.includes(decision.action)) {
      // Beyin direktifi yok saydı. Katalog eylemine indirilebiliyor mu? (kural-tabanlı
      // parser browser/navigate/board/terminal/report/memory dallarını zaten biliyor)
      const local = parseIntent(transcript, context);
      const usable =
        local &&
        !AGENT_OPENING_ACTIONS.includes(local.action) &&
        local.action !== 'reply' &&
        local.action !== 'self';
      if (usable) return { ...local, executor: 'self', fanoutReason: reason, speak: local.speak || decision.speak };
      return {
        action: 'reply',
        department: decision.department ?? null,
        objective: decision.objective ?? null,
        op: null,
        target: null,
        executor: 'self',
        fanoutReason: reason,
        speak: 'Bunu kendi araçlarımla yapamıyorum (kod/dosya yazımı gerekiyor). Tek ajana vereyim mi?',
      };
    }
    // Zaten ajan açmayan bir eylem (browser/navigate/board/chain/status/reply) — Jarvis
    // bunu HER HÂLDE kendisi yapıyor; sadece etiketle.
    return { ...decision, executor: 'self', fanoutReason: reason };
  }

  if (decision.action === 'delegate') {
    return { ...decision, executor, fanoutReason: reason };
  }
  return decision;
}

// ---------------------------------------------------------------------------
// ADP-815 (Faz 3) — KATMAN 2: kalıcı `claude` oturumu (singleton) + çökme gözcüsü
// ---------------------------------------------------------------------------

/**
 * TEK oturum (çökme kısıtı: bu makinede ikinci bir `claude` süreci açılmaz).
 * Oturum ölürse `ask` BEKLEMEDEN {ok:false} döner → o tur SOĞUK yola düşer
 * (`claude -p`), oturum ARKA PLANDA yeniden kurulur. Böylece bir çökme
 * kullanıcıya "hiç cevap yok" değil "bir tur yavaş" olarak yansır.
 */
let _brainSession = null;

function brainSession() {
  if (!_brainSession) _brainSession = claudeBrainSession.createSession({});
  return _brainSession;
}

/**
 * Oturumu kur + ilk turu öde. ADP-813'ün dersi: ısıtma tetiği BOOT değil NİYET —
 * main bunu `jarvis:sttWarmup` ile AYNI anda (kayıt başlarken) çağırır, böylece
 * hiç konuşmayan kullanıcı 4–13 s'lik açılışı ödemez ve konuşan kullanıcı
 * bedeli konuşma süresine gizler.
 */
async function warmupBrain(opts = {}) {
  const s = brainSession();
  if (s.isReady()) return { ok: true, already: true };
  if (s.isBusy()) return { ok: false, reason: 'busy' };
  return s.warmup({ systemPrompt: buildBrainSystemPrompt(), model: opts.model || null });
}

/** Uygulama kapanırken (before-quit) — yetim `claude` süreci bırakma. */
function stopBrain() {
  if (!_brainSession) return false;
  return _brainSession.stop('quit');
}

function brainStats() {
  return _brainSession ? _brainSession.stats() : { alive: false, ready: false, busy: false, turns: 0 };
}

/** Kasıtlı öldürme — çökme gözcüsünün GERÇEK testi (ölçüm/e2e kaçış kapısı). */
function killBrainForTest(signal) {
  return _brainSession ? _brainSession.killForTest(signal) : false;
}

/** Kalıcı oturumdan bir karar iste. Oturum yoksa/ölüyse {ok:false} (beklemez). */
async function decideWithSession({ transcript, context, timeoutMs, session }) {
  const s = session || brainSession();
  // "Oturum ayakta mı" kontrolü BURADA YAPILMAZ: `ask` zaten yapıyor VE soğuk yola
  // düşüşü SAYIYOR. Burada erken dönmek sayacı sessizce yalancı yapıyordu (ölçüldü:
  // e2e'de oturum öldürüldü, tur soğuk yoldan cevapladı, `coldFallbacks` yine 0).
  const r = await s.ask(buildBrainTurnMessage(transcript, context), timeoutMs ? { timeoutMs } : {});
  if (!r.ok) return r;
  const decision = parseClaudeDecision(r.raw);
  if (!decision) return { ok: false, reason: 'parse-failed', detail: String(r.raw || '').slice(0, 200) };
  return { ok: true, decision, ms: r.ms, ttftMs: r.ttftMs };
}

/**
 * Decide what to do with a transcript: try the Claude brain, fall back to the
 * deterministic parser. Returns { ok, decision, via:'session'|'claude'|'rule' }.
 *
 * ADP-322 — her iki yol da AYNI deterministik yürütücü kapısından geçer: beyin de
 * kural-parser'ı da kullanıcının açık direktifini EZEMEZ.
 *
 * ADP-815 — üç kademe: KALICI oturum (p50 2.5 s) → SOĞUK `claude -p` (p50 ~6 s,
 * oturum çöktüğünde/soğumadayken) → kural parser (0 ms, beyin hiç yoksa).
 */
// ── ADP-902 (K1) — YEREL HIZLI YOL: beyni ATLAYAN deterministik kararlar ─────
//
// ÖLÇÜM (e2e adp902 "before", gerçek ses + gerçek STT): kullanıcının komutu ile
// ilk tepki arasındaki sürenin EZİCİ çoğunluğu beyindi — "yeni terminal aç" 1.824
// ms, "şu an ne durumdayız?" 7.069 ms (soğuk yol). VAD 900 ms + STT 450 ms'in
// yanında beyin tek başına gecikmenin %80'iydi. Oysa bu komutların kararı
// `parseIntent` ile 0 ms'de ve DETERMİNİST olarak verilebiliyor.
//
// ÇİZGİ (rastgele değil): hızlı yol YALNIZ okuma-yazma dengesi güvenli olan
// eylemleri alır — salt-okunur sorgular + geri alınabilir arayüz/terminal
// kontrolü. İŞ DEVREDEN, PANE DOĞURAN ya da DEFTERE YAZAN hiçbir eylem burada
// yok (delegate · tell · spawn · board create/assign/status · memory promote ·
// sprint start · settings · browser click/type): onlar niyetin nüansına bakar ve
// beyinde kalır. Yıkıcı `terminal/kill` LİSTEDE, çünkü kararı ADP-854'te
// morfolojik olarak sertleştirildi VE yürütücüdeki meşguliyet/onay kapısı
// (busy-guard) fark etmeksizin koşar — hızlı yol o kapıyı ATLAMAZ.
const FAST_LOCAL_OPS = {
  terminal: new Set(['new-shell', 'focus', 'kill']),
  navigate: new Set(['surface', 'tab', 'tab-close']),
  browser: new Set(['back', 'forward', 'reload', 'scroll', 'read', 'open', 'search']),
  report: new Set(['list', 'open', 'read']),
  board: new Set(['list']),
  memory: new Set(['what']),
  sprint: new Set(['status']),
  agent: new Set(['last-message']),
};
/** `op` taşımayan ama salt-okunur olan eylemler. */
const FAST_LOCAL_NO_OP = new Set(['status']);

/**
 * Kural parser'ı bu transkripti GÜVENLE karara bağlayabiliyor mu?
 *
 * `null` dönerse beyin yolu aynen koşar — yani bu fonksiyon bir OPTİMİZASYON
 * kapısıdır, bir davranış değişikliği değil. `parseIntent` eşleşme bulamazsa
 * `action:'reply'` döndürür ve o BİLEREK listede yok: "anlamadım" bir hızlı
 * yol cevabı olamaz, tam da beynin gerektiği yerdir.
 */
function fastLocalDecision(transcript, context) {
  let d;
  try {
    d = parseIntent(transcript, context);
  } catch {
    return null; // kural katmanı patlarsa beyin yolu KESİNTİSİZ devam eder
  }
  if (!d || !d.action) return null;
  if (FAST_LOCAL_NO_OP.has(d.action) && !d.op) return d;
  const ops = FAST_LOCAL_OPS[d.action];
  if (ops && d.op && ops.has(d.op)) return d;
  return null;
}

/** Hızlı yol açık mı? (A/B ÖLÇÜMÜ + beyni ölçen spec'ler için kapatılabilir seam.) */
function fastPathEnabled(opts = {}) {
  if (opts.fastPath === false) return false;
  // `spawnImpl` verilmişse çağıran SOĞUK BEYİN yolunu BİLEREK sürüyor (bu dosyanın
  // `wantSession` seam'iyle aynı sözleşme: enjekte edilmiş spawn = "beyni ölç").
  // Hızlı yol o niyeti sessizce ezmez.
  if (opts.spawnImpl) return false;
  const env = String(process.env.CREWPANE_VOICE_FAST_PATH ?? '').trim();
  if (env === '0' || env.toLowerCase() === 'false') return false;
  return true;
}

async function decide(opts = {}) {
  let transcript = String(opts.transcript || '').trim();
  if (!transcript) return { ok: false, reason: 'empty-transcript' };
  // AXP-01 — "Uygulamada yap" seçildi: kullanıcının açık direktifi cümleye EKLENİR ki
  // fanoutPolicy (SELF_RE) ve beyin aynı şeyi görsün — ikinci bir direktif kanalı
  // yazmak iki gerçek doğururdu (ADP-322 dersi). Yönlendirici bu kalıbı görünce
  // prompt/belirsiz ÜRETMEZ; kural yolu/beyin uygulama eylemini seçer ya da dürüst ret verir.
  if (opts.directive === 'self' && !fanoutPolicy.detectDirective(transcript)) {
    transcript = `${transcript} — sen kendin yap`;
  }
  const context = opts.context || {};
  const finish = (decision, via, extra) => ({
    ok: true,
    decision: applyExecutorPolicy(decision, transcript, context),
    via,
    ...(extra || {}),
  });
  // ADP-902 — HIZLI YOL, beyinden ÖNCE. Ölçülen kazanç raporda (K1 tablosu).
  if (fastPathEnabled(opts) && opts.useClaude !== false) {
    const fast = fastLocalDecision(transcript, context);
    if (fast) return finish(fast, 'fast-rule', { brainMs: 0, fastPath: true });
  }
  // `spawnImpl` verilmişse çağıran SOĞUK yolu bilerek sürüyor (test/A-B seam'i):
  // kalıcı oturuma ne sorulur ne de arka planda kurulur. Aksi hâlde enjekte edilmiş
  // spawn'lı bir çağrı GERÇEK bir `claude` süreci doğururdu — seam'in anlamı biterdi.
  const wantSession = opts.useSession !== false && !opts.spawnImpl;
  if (opts.useClaude !== false) {
    // 1) Kalıcı oturum. `useSession:false` = A/B ölçümü için eski davranışı ZORLA
    // (ADP-812 §5 dersi: kodu geri almadan A/B mümkün olsun).
    if (wantSession) {
      const s = await decideWithSession({
        transcript,
        context,
        timeoutMs: opts.sessionTimeoutMs,
        session: opts.session,
      });
      if (s.ok && s.decision) return finish(s.decision, 'session', { brainMs: s.ms, ttftMs: s.ttftMs });
      // Oturum ölü/soğumada → arka planda yeniden kur; BU tur soğuk yolla ilerler.
      if (!opts.session && s.reason !== 'busy') {
        void warmupBrain().catch(() => {});
      }
    }
    // 2) Soğuk yol — oturum yoksa, çöktüyse ya da JSON ayrıştırılamadıysa.
    const c = await decideWithClaude({
      transcript,
      context,
      claudeBin: opts.claudeBin,
      timeoutMs: opts.timeoutMs,
      spawnImpl: opts.spawnImpl,
    });
    if (c.ok && c.decision) return finish(c.decision, 'claude');
  }
  // 3) Kural parser — beyin hiç yoksa (0 ms, deterministik).
  return finish(parseIntent(transcript, context), 'rule');
}

// ---------------------------------------------------------------------------
// TTS — macOS `say` (Yelda tr_TR) → .aiff + afplay
// ---------------------------------------------------------------------------

let _currentPlayback = null;

// ---------------------------------------------------------------------------
// TTS-ORPHAN-01 — YEREL SES ÇOCUKLARI (`say` / `afplay`) TEK YERDEN ÖLÜR
// ---------------------------------------------------------------------------
//
// ÖLÇÜLEN KUSUR (07.09.2026 gecesi, tahmin değil): makinede 6 ebeveynsiz
//   `say -v Yelda -o …/crewpane-jarvis/say-*.aiff "Tamam."`
// birikti — ppid 1, biri 1 sa 30 dk asılı, üçer üçer. Kaynak `speakSay` DOSYA
// modudur: çocuk spawn ediliyor, ama (a) hiçbir yerde TUTULMUYOR, (b) ebeveyn
// çıkışında kimse öldürmüyor, (c) süresi SINIRSIZ. Ebeveyn Electron gidince
// çocuk launchd'ye (ppid 1) düşüyor ve makine yüklüyken saatlerce koşuyor.
// (`_currentPlayback` yalnız OYNATMA tutamağıdır — dosya modundaki `say -o`
// çocuğu ona hiç yazılmaz; MEMIDX-LEAK-01'in kapatma listesi de yalnız indeks/
// gömme/arama çocuklarını kapsıyordu, `say` o listede DEĞİLDİ.)
//
// ÜÇ KATMAN:
//   A) KAYIT + ÇIKIŞTA ÖLDÜR — canlı her `say`/`afplay` çocuğu bu kümededir;
//      `killLocalAudioChildren()` hepsini SIGKILL eder. Ana süreç `before-quit`te
//      çağırır (main.js, MEMIDX-LEAK-01 kancasının yanında); modül ayrıca kendi
//      `process.on('exit'|'SIGTERM'|'SIGINT')` ağını kurar — böylece Electron
//      DIŞINDA (birim testi, ölçüm aleti, e2e yardımcısı) de yetim kalmaz.
//   B) ZAMAN AŞIMI — tek kelimelik render dakikalar sürmez. `SAY_TIMEOUT_MS`
//      geçilirse çocuk SIGKILL edilir ve `{ ok:false, reason:'say-timeout' }`
//      döner: asılı bir çocuk artık sonsuza kadar CPU yakamaz.
//   C) KUYRUK — dosya render'ları SIRAYA girer (aynı anda tek `say`). Gece
//      görülen "üçer üçer" tablo buydu: eşzamanlı render'lar birbirini ve
//      makineyi yavaşlatıyor, pencere büyüdükçe yetim ihtimali artıyordu.
//
// 🔴 DÜRÜST SINIR: ebeveyn SIGKILL/Force Quit ile giderse hiçbir JS kancası
//    koşmaz ve `say` bir SİSTEM İKİLİSİDİR — MEMIDX-LEAK-01'in "katman B"si
//    (çocuğun içine nöbetçi koymak) burada MÜMKÜN DEĞİL. Bu yüzden pencere
//    KÜÇÜLTÜLDÜ: render'lar sıraya girer, süresi sınırlıdır ve ISITMA TURU
//    ARTIK HİÇ `say` AÇMAZ (aşağıda `speakWithSettings`).

/** Yerel ses çocuğu bu kadar sürerse asılmış sayılır (tek cümle saniyeler sürer). */
const SAY_TIMEOUT_MS = Number(process.env.CREWPANE_SAY_TIMEOUT_MS || 20000);

/** Canlı `say`/`afplay` çocukları (katman A). */
const _localAudioChildren = new Set();
/** Çocuk → onu kayıttan düşürüp bekçisini iptal eden fonksiyon. */
const _releaseLocalAudioChild = new WeakMap();
let _exitHooksInstalled = false;

function _installExitHooksOnce() {
  if (_exitHooksInstalled) return;
  _exitHooksInstalled = true;
  // 'exit' SENKRONDUR: burada yalnız kill çağrılır (I/O yok).
  try { process.on('exit', () => { killLocalAudioChildren(); }); } catch { /* kancasız ortam */ }
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    try {
      process.on(sig, () => {
        killLocalAudioChildren();
        // Varsayılan davranışı geri ver: başka dinleyici yoksa süreç bitmeli.
        if (process.listenerCount(sig) <= 1) process.exit(0);
      });
    } catch { /* kancasız ortam */ }
  }
}

/**
 * Çocuğu kayda al; kendiliğinden bitince kayıttan düş. `timeoutMs > 0` ise
 * asılma sınırı da kurulur (`onTimeout` çağrılır, sonra SIGKILL).
 */
function trackLocalAudioChild(child, { timeoutMs = 0, onTimeout } = {}) {
  if (!child || typeof child.on !== 'function') return child;
  _installExitHooksOnce();
  _localAudioChildren.add(child);
  let timer = null;
  const forget = () => {
    _localAudioChildren.delete(child);
    if (timer) { clearTimeout(timer); timer = null; }
  };
  _releaseLocalAudioChild.set(child, forget);
  child.on('close', forget);
  child.on('exit', forget);
  child.on('error', forget);
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timer = null;
      // SIRA ÖNEMLİ: önce sonucu bildir, SONRA öldür. Ters sırada, öldürülen
      // çocuğun 'close'u yarışı kazanabilir ve sebep `say-exit-<kod>` diye
      // yalan söyler — asılma teşhisi kaybolur.
      try { if (typeof onTimeout === 'function') onTimeout(); } catch { /* çağıran patlamasın */ }
      try { child.kill('SIGKILL'); } catch { /* zaten ölmüş */ }
      _localAudioChildren.delete(child);
    }, timeoutMs);
    // 🔴 BEKÇİ unref EDİLMEZ — ve bu bilerekdir. unref'li bir zamanlayıcı, olay
    // döngüsünde başka iş kalmayınca HİÇ ATEŞLENMEZ; oysa bekçinin var oluş
    // sebebi tam olarak o an (çocuk asılı, yapacak başka iş yok). Ek ömür de
    // getirmez: koşan bir çocuğun stdio tutamakları döngüyü zaten ayakta tutar
    // ve bekçi çocuk kapanır kapanmaz temizlenir (`forget`).
  }
  return child;
}

/**
 * Çocuğu kayıttan düşür + bekçisini iptal et (öldürmeden). Sonucu ÇÖZÜLMÜŞ bir
 * render için çağrılır: 'close' olayına güvenmek yetmez — sahte/farklı emitter
 * uygulamalarında olay yutulabilir ve bekçi boşa asılı kalır.
 */
function untrackLocalAudioChild(child) {
  const release = child && _releaseLocalAudioChild.get(child);
  if (release) release();
  else if (child) _localAudioChildren.delete(child);
}

/** Katman A — canlı tüm yerel ses çocuklarını bitir. @returns öldürülen sayısı */
function killLocalAudioChildren() {
  let n = 0;
  for (const child of Array.from(_localAudioChildren)) {
    try { child.kill('SIGKILL'); n += 1; } catch { /* zaten ölmüş */ }
    _localAudioChildren.delete(child);
  }
  if (_currentPlayback) _currentPlayback = null;
  return n;
}

/** Ölçüm/test için: şu an kayıtlı canlı çocuk sayısı. */
function liveLocalAudioChildren() {
  return _localAudioChildren.size;
}

/**
 * TTS-ORPHAN-01 · katman D — AÇILIŞTA YETİM SÜPÜRGESİ.
 *
 * Katman A yalnız NAZİK çıkışta koşar. Ebeveyn SIGKILL/Force Quit ile giderse
 * hiçbir JS kancası koşmaz ve `say` bir SİSTEM İKİLİSİDİR: MEMIDX-LEAK-01'in
 * "çocuğun içine nöbetçi koy" çözümü burada MÜMKÜN DEĞİL. Kalan tek doğru yer
 * BİR SONRAKİ AÇILIŞTIR: o an ppid 1'e düşmüş, bizim tmp dizinimize yazan
 * `say` süreçleri kesin olarak bizimdir ve kesin olarak sahipsizdir.
 *
 * 🔴 KAPI ÜÇ KOŞULLU (yanlışlıkla kullanıcının kendi `say`ini öldürmeyelim):
 *   1. komut `say` ile başlar,
 *   2. komut satırında `-o …/crewpane-jarvis/say-` geçer (bizim çıktı yolumuz),
 *   3. ppid === 1 (ebeveyni gitmiş; CANLI bir uygulamanın çocuğuna dokunulmaz).
 *
 * 🔴 WIN-TTS-SWEEP-01 — SÜPÜRGE YALNIZ macOS'TA KOŞAR.
 *
 * ÖLÇÜLEN GÜRÜLTÜ (FB-1006 logu, APP-FB-TRIAGE-01 §5-Ö3): Windows'ta `ps` diye
 * bir ikili yoktur, bu yüzden süpürge HER AÇILIŞTA ENOENT ile düşüyor ve
 * `main.js` bunu "yetim süpürgesi koşamadı — ps-failed: …" satırıyla yazıyordu.
 * Gerçek arızaları saklayan bir gürültü; üstelik ARADIĞI ŞEY DE ORADA YOK.
 *
 * NEDEN "atla" DOĞRU CEVAP (ölçüldü, tahmin değil): süpürgenin avladığı iki
 * ikili de macOS'a özgüdür — `say` (jarvisVoice.js speakSay) ve `afplay`
 * (deliverAudioBuffer). Windows'ta ikisi de YOKTUR: yerel yol spawn anında
 * ENOENT verir, ayakta kalan bir çocuk OLUŞMAZ, dolayısıyla YETİM DE OLUŞMAZ.
 * Bulut sağlayıcı yolunda ses `deliver:'renderer'` ile HTMLAudioElement'te
 * çalar — orada da süreç çocuğu yok. Yani Windows için `tasklist`/`wmic`
 * karşılığı yazmak, var olmayan bir sınıfı süpürmek olurdu.
 * (Windows'ta yerel TTS'in HİÇ olmaması ayrı bir eksiktir — raporda açık soru.)
 *
 * `platform` AÇIKÇA enjekte edilir (PIPE-03 dersi): host mac olsa bile win32
 * davranışı birimde gerçekten sınanır.
 *
 * @returns {{ scanned:number, killed:number[], skipped?:boolean, reason?:string }}
 */
function sweepOrphanSayProcesses({ execFileSyncImpl = execFileSync, killImpl, marker = path.join('crewpane-jarvis', 'say-'), platform = process.platform } = {}) {
  if (platform !== 'darwin') {
    // Bilerek ATLANDI — ARIZA DEĞİL. `ps` çağrılmaz; çağıran bunu `skipped` ile
    // ayırt eder ve "koşamadı" diye yazmaz (main.js açılış log'u).
    return { scanned: 0, killed: [], skipped: true, reason: `platform-${platform}` };
  }
  const kill = killImpl || ((pid) => process.kill(pid, 'SIGKILL'));
  let out = '';
  try {
    out = String(execFileSyncImpl('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }) || '');
  } catch (e) {
    return { scanned: 0, killed: [], reason: `ps-failed: ${(e && e.message) || e}` };
  }
  const killed = [];
  let scanned = 0;
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    scanned += 1;
    const [, pidStr, ppidStr, cmd] = m;
    if (!/^say(\s|$)/.test(cmd)) continue;
    if (!cmd.includes(marker)) continue;
    if (Number(ppidStr) !== 1) continue;
    try { kill(Number(pidStr)); killed.push(Number(pidStr)); } catch { /* zaten ölmüş */ }
  }
  return { scanned, killed };
}

// Katman C — DOSYA RENDER KUYRUĞU. Aynı anda tek `say -o`; sıradaki bekler.
let _sayRenderChain = Promise.resolve();
function queueSayRender(fn) {
  const next = _sayRenderChain.then(fn, fn);
  _sayRenderChain = next.then(() => {}, () => {});
  return next;
}

/**
 * Speak `text` with `say -v Yelda`.
 *
 * İKİ mod:
 *   • 'direct' (ADP-812, `play` açıkken VARSAYILAN) — `say` sesi DOĞRUDAN çalar.
 *     Dosya yok, `afplay` yok. ADP-804 ölçümü: dosya+afplay yolu ilk sese ~1400 ms
 *     harcıyor (417–781 ms `say -o` + ~890 ms afplay süreç açılışı), doğrudan
 *     oynatmada ilk ses ~500 ms. Barge-in aynı: `_currentPlayback` bu kez `say`
 *     sürecinin kendisi, `stopPlayback()` onu öldürür.
 *   • 'file' — .aiff üretir (kanıt / önizleme / yeniden kullanım). `play:false`
 *     her zaman bu moda düşer; `play:true` + `mode:'file'` eski (afplay) yolu.
 *
 * Resolves { ok, path?, bytes?, ms, mode } | { ok:false }.
 * `say` runs WITHOUT a shell (args array) → no command injection.
 */
function speakSay({
  text,
  voice = SAY_VOICE,
  play = true,
  mode,
  outDir,
  uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  spawnImpl = spawn,
  execFileImpl = execFile,
  // E2E-MUTE-01 — enjekte edilebilir (birim testi env kirletmeden ölçsün).
  muted = ttsMute.isTtsMuted(),
  // TTS-ORPHAN-01 — dosya render'ının asılma sınırı (0 = sınırsız, ölçüm yolu).
  timeoutMs = SAY_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve) => {
    const clean = String(text == null ? '' : text).trim();
    if (!clean) {
      resolve({ ok: false, reason: 'empty-text' });
      return;
    }
    // E2E-MUTE-01 — susturmada DOĞRUDAN OYNATMA YOK: `say` sesi hoparlöre veren
    // TEK yol odur (dosya yolu `-o` ile sessizdir). Bunun yerine dosyaya sentezle
    // → `bytes` kanıtı üretilir, `afplay` de açılmaz (aşağıdaki play kapısı).
    const useMode = muted ? 'file' : (mode || (play ? 'direct' : 'file'));
    if (process.platform === 'win32') {
      const t0 = Date.now();
      let child;
      try {
        stopPlayback();
        const psScript = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $text = [Console]::In.ReadToEnd(); if ($text) { $s.Speak($text) }`;
        child = trackLocalAudioChild(spawnImpl('powershell', ['-NoProfile', '-Command', psScript]));
        child.stdin.write(clean);
        child.stdin.end();
      } catch (e) {
        resolve({ ok: false, reason: 'say-spawn-failed', detail: String((e && e.message) || e) });
        return;
      }
      _currentPlayback = child;
      ttsMute.noteAudibleOutput('say-direct');
      child.on('error', () => {
        if (_currentPlayback === child) _currentPlayback = null;
      });
      child.on('close', () => {
        if (_currentPlayback === child) _currentPlayback = null;
      });
      resolve({ ok: true, ms: Date.now() - t0, voice: 'Windows System.Speech', mode: 'direct', path: null, bytes: 0 });
      return;
    }
    if (useMode === 'direct') {
      const t0 = Date.now();
      let child;
      try {
        stopPlayback();
        // TTS-ORPHAN-01 — doğrudan oynatma da bir ÇOCUKTUR: uygulama kapanınca
        // konuşmaya devam etmemeli. Zaman aşımı YOK (uzun cevap meşru olarak
        // dakikalarca çalabilir); kapatma listesine girmesi yeter.
        child = trackLocalAudioChild(spawnImpl('say', ['-v', voice, clean]));
      } catch (e) {
        resolve({ ok: false, reason: 'say-spawn-failed', detail: String((e && e.message) || e) });
        return;
      }
      _currentPlayback = child;
      ttsMute.noteAudibleOutput('say-direct');
      child.on('error', () => {
        if (_currentPlayback === child) _currentPlayback = null;
      });
      child.on('close', () => {
        if (_currentPlayback === child) _currentPlayback = null;
      });
      // Ses ÇALMAYA başladı; bitmesini beklemiyoruz (barge-in için tutamak yukarıda).
      resolve({ ok: true, ms: Date.now() - t0, voice, mode: 'direct', path: null, bytes: 0 });
      return;
    }
    const dir = outDir || path.join(os.tmpdir(), 'crewpane-jarvis');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* best-effort */
    }
    const file = path.join(dir, `say-${uniq}.aiff`);
    // TTS-ORPHAN-01 · katman C — DOSYA RENDER'LARI SIRAYA GİRER. Gece ölçülen
    // tablo "üçer üçer" idi: eşzamanlı `say -o` çocukları hem birbirini hem
    // makineyi yavaşlatıyor, render penceresi uzadıkça yetim ihtimali artıyordu.
    queueSayRender(() => new Promise((settle) => {
      const t0 = Date.now();
      let child;
      try {
        child = spawnImpl('say', ['-v', voice, '-o', file, clean]);
      } catch (e) {
        settle({ ok: false, reason: 'say-spawn-failed', detail: String((e && e.message) || e) });
        return;
      }
      let settled = false;
      const done = (val) => {
        if (settled) return;
        settled = true;
        untrackLocalAudioChild(child); // bekçi işini bitirdi: zamanlayıcı asılı kalmasın
        settle(val);
      };
      // TTS-ORPHAN-01 · katman A+B — kayda al (çıkışta ölür) ve asılmayı sınırla.
      trackLocalAudioChild(child, {
        timeoutMs,
        onTimeout: () => done({ ok: false, reason: 'say-timeout', ms: Date.now() - t0, timeoutMs }),
      });
      child.on('error', (e) => done({ ok: false, reason: 'say-error', detail: String((e && e.message) || e) }));
      child.on('close', (code) => {
        if (code !== 0) {
          done({ ok: false, reason: `say-exit-${code}` });
          return;
        }
        let bytes = 0;
        try {
          bytes = fs.statSync(file).size;
        } catch {
          /* file missing → bytes 0 */
        }
        if (bytes) ttsMute.noteSynthesized(bytes);
        if (play && muted) {
          // E2E-MUTE-01 — ses ÜRETİLDİ (bytes), hoparlöre GİTMEDİ.
          ttsMute.noteSuppressedOutput('say-afplay');
        } else if (play) {
          try {
            stopPlayback();
            ttsMute.noteAudibleOutput('afplay');
            _currentPlayback = trackLocalAudioChild(execFileImpl('afplay', [file], () => {
              _currentPlayback = null;
            }));
          } catch {
            /* playback best-effort (e.g. no audio device in CI) */
          }
        }
        done({ ok: true, path: file, bytes, ms: Date.now() - t0, voice, mode: 'file', muted: muted || undefined, playIn: play && muted ? 'none' : undefined });
      });
    })).then(resolve, (e) => resolve({ ok: false, reason: 'say-queue-failed', detail: String((e && e.message) || e) }));
  });
}

// ---------------------------------------------------------------------------
// ADP-812 — kısa/tekrar eden cümleler için TTS önbelleği (disk)
// ---------------------------------------------------------------------------
// YALNIZ kısa metinler: uzun cevaplar her seferinde farklıdır, önbellek şişer.
// Anahtar = model + ses + metin; bunlardan biri değişirse ses de değişmeli.
const TTS_CACHE_MAX_CHARS = 64;

function ttsCacheDir(cacheDir) {
  return cacheDir || path.join(os.tmpdir(), 'crewpane-jarvis', 'tts-cache');
}

function ttsCacheFile({ text, model, voice, cacheDir }) {
  if (typeof text !== 'string' || text.length === 0 || text.length > TTS_CACHE_MAX_CHARS) return null;
  const key = crypto.createHash('sha1').update(`${model}|${voice}|${text}`).digest('hex');
  return path.join(ttsCacheDir(cacheDir), `${key}.mp3`);
}

/** Önbellekten mp3 → { buf } | null. Bozuk/eksik dosya = önbellek yok (sessiz). */
function readTtsCache(args) {
  const f = ttsCacheFile(args);
  if (!f) return null;
  try {
    const buf = fs.readFileSync(f);
    return buf && buf.length > 0 ? { buf, file: f } : null;
  } catch {
    return null;
  }
}

/** Önbelleğe yaz (best-effort: disk hatası SESİ engellemez). */
function writeTtsCache(args) {
  const f = ttsCacheFile(args);
  if (!f || !args.buf || !args.buf.length) return false;
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, args.buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * Speak `text` via OpenAI TTS API → MP3.
 *
 * ADP-812 (Faz 0) — oynatma yeri artık seçilebilir:
 *   • `deliver:'renderer'` → mp3 base64 olarak DÖNER, main hiçbir süreç açmaz.
 *     Renderer `HTMLAudioElement` ile çalar. Kazanç: `afplay` süreç açılışı
 *     ~826–925 ms (ADP-804 + ADP-812 ölçümü, `afinfo` süresiyle çıkarılmış).
 *   • aksi halde eski yol: dosyaya yaz + `afplay`.
 * Falls back gracefully: no key → { ok:false, reason:'no-openai-key' }.
 */
async function speakOpenAI({
  text,
  voice = DEFAULT_TTS_VOICE,
  model = DEFAULT_TTS_MODEL,
  apiKey,
  outDir,
  play = true,
  deliver = 'main',
  cacheDir,
  fetchImpl = fetch,
  execFileImpl = execFile,
  muted = ttsMute.isTtsMuted(), // E2E-MUTE-01
} = {}) {
  const clean = String(text == null ? '' : text).trim();
  if (!clean) return { ok: false, reason: 'empty-text' };
  if (!apiKey) return { ok: false, reason: 'no-openai-key' };

  const dir = outDir || path.join(os.tmpdir(), 'crewpane-jarvis');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }

  const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const file = path.join(dir, `tts-${uniq}.mp3`);
  const t0 = Date.now();

  // ADP-812 — KISA + TEKRAR EDEN cümleler diskte önbelleklenir. Ölçüldü: eylem-öncesi
  // ACK ("Bakıyorum…") bulut TTS'iyle 1.7–5.2 s sürüyordu, yani eylem çoğu zaman
  // ondan ÖNCE bitiyordu ve ACK hiç duyulmuyordu (ilk e2e koşusunda 4 ACK'ten 3'ü
  // düştü). ACK metinleri SABİT bir kümedir → ilk turdan sonra ağ turu HİÇ yok.
  const cached = readTtsCache({ text: clean, model, voice, cacheDir });
  const buf0 = cached ? cached.buf : null;

  let res;
  if (!buf0) {
    try {
      res = await fetchImpl(OPENAI_TTS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, voice, input: clean }),
      });
    } catch (e) {
      return { ok: false, reason: 'tts-fetch-failed', detail: String((e && e.message) || e) };
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, reason: `tts-api-${res.status}`, detail };
    }
  }

  try {
    const buf = buf0 || Buffer.from(await res.arrayBuffer());
    const bytes = buf.length;
    if (bytes) ttsMute.noteSynthesized(bytes); // E2E-MUTE-01 — sentez kanıtı
    if (!buf0) writeTtsCache({ text: clean, model, voice, cacheDir, buf });

    // ADP-812 — renderer oynatmasında diske YAZMIYORUZ da: dosya yalnız afplay
    // içindi. Süreç açılışı + disk yazımı birlikte kalkıyor.
    if (deliver === 'renderer') {
      // Main tarafında çalan bir ses varsa (önceki tur / say fallback) sustur:
      // barge-in davranışı iki yolda da aynı kalsın.
      stopPlayback();
      return {
        ok: true,
        path: null,
        bytes,
        ms: Date.now() - t0,
        voice,
        engine: 'openai',
        playIn: 'renderer',
        mime: 'audio/mpeg',
        audioBase64: buf.toString('base64'),
        cached: !!buf0,
        // E2E-MUTE-01 — renderer sesi ÇALAR ama `<audio>.muted` ile; olay/zamanlama
        // kanıtı aynen kalsın diye oynatma iptal EDİLMEZ, yalnız kısılır.
        muted: muted || undefined,
      };
    }

    fs.writeFileSync(file, buf);
    if (play && muted) {
      ttsMute.noteSuppressedOutput('afplay'); // E2E-MUTE-01 — dosya var, ses yok
    } else if (play) {
      try {
        stopPlayback();
        ttsMute.noteAudibleOutput('afplay');
        _currentPlayback = trackLocalAudioChild(execFileImpl('afplay', [file], () => { _currentPlayback = null; }));
      } catch { /* best-effort: no audio device in CI */ }
    }

    return { ok: true, path: file, bytes, ms: Date.now() - t0, voice, engine: 'openai', playIn: play && muted ? 'none' : 'main', cached: !!buf0, muted: muted || undefined };
  } catch (e) {
    return { ok: false, reason: 'tts-write-failed', detail: String((e && e.message) || e) };
  }
}

/**
 * ADP-848 — hazır ses BAYTLARINI teslim et: renderer'a base64 ya da diske + afplay.
 *
 * Neden ayrı fonksiyon: yeni bulut motorları (ElevenLabs/Azure) yalnız BAYT üretir;
 * teslim (barge-in + oynatma yeri + dosya) tek yerde kalsın istiyoruz.
 * `speakOpenAI` BİLEREK yeniden yazılmadı — orada TTS önbelleği var ve ADP-812'nin
 * ölçülmüş ACK yolunu bozmak regresyon riskidir (ADR: en küçük doğru değişiklik).
 */
function deliverAudioBuffer({
  buf,
  mime = 'audio/mpeg',
  ext = 'mp3',
  engine,
  voice,
  ms = 0,
  play = true,
  deliver = 'main',
  outDir,
  execFileImpl = execFile,
  uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  muted = ttsMute.isTtsMuted(), // E2E-MUTE-01
} = {}) {
  const bytes = buf ? buf.length : 0;
  if (!bytes) return { ok: false, reason: 'empty-audio', engine };
  ttsMute.noteSynthesized(bytes); // E2E-MUTE-01 — sentez kanıtı (motordan bağımsız)
  if (deliver === 'renderer') {
    stopPlayback(); // barge-in davranışı her motorda aynı
    return { ok: true, path: null, bytes, ms, voice, engine, playIn: 'renderer', mime, audioBase64: buf.toString('base64'), muted: muted || undefined };
  }
  const dir = outDir || path.join(os.tmpdir(), 'crewpane-jarvis');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
  const file = path.join(dir, `tts-${engine}-${uniq}.${ext}`);
  try {
    fs.writeFileSync(file, buf);
  } catch (e) {
    return { ok: false, reason: 'tts-write-failed', detail: String((e && e.message) || e), engine };
  }
  if (play && muted) {
    ttsMute.noteSuppressedOutput('afplay'); // E2E-MUTE-01
  } else if (play) {
    try {
      stopPlayback();
      ttsMute.noteAudibleOutput('afplay');
      _currentPlayback = trackLocalAudioChild(execFileImpl('afplay', [file], () => { _currentPlayback = null; }));
    } catch { /* best-effort: no audio device in CI */ }
  }
  return { ok: true, path: file, bytes, ms, voice, engine, playIn: play && muted ? 'none' : 'main', mime, muted: muted || undefined };
}

/**
 * Choose TTS engine from settings and speak.
 *
 * ADP-848 — artık bir SAĞLAYICI DAĞITICISI: say | openai | elevenlabs | azure.
 * 🔴 FAIL-SAFE YÖN DEĞİŞMEDİ: hangi motor seçilirse seçilsin, anahtar yoksa ya da
 * çağrı patlarsa ÜCRETSİZ yerel sese (`say`) düşülür — ses hiç çıkmaması bir
 * seçenek değil. Fark şu: düşüş artık SESSİZ DEĞİL. Dönen sonuç `fallback`
 * (hangi motordan, neden) ve oturumda BİR KEZ dolan `notice` metnini taşır;
 * çağıran onu kullanıcıya gösterir (ADP-848 kuralı 7).
 *
 * 🔴 ADP-902 — `notify:false` = "BU TUR KULLANICIYA GÖRÜNMEZ, bildirimi harcama".
 * GERÇEK UYGULAMADA ÖLÇÜLDÜ: widget açılışta ACK cümlelerini sessizce ISITIYOR
 * (JarvisWidget.preloadAck → `speak({play:false})`). ElevenLabs bozukken o ısıtma
 * turu "oturumda bir kez" bildirimini TÜKETİYOR, kullanıcının GERÇEK turunda
 * `notice` null geliyor ve ekranda hiçbir şey çıkmıyordu — yani sessiz düşüşün
 * ikinci katmanı. Kayıt (`fallback.from/reason/detail`) `notify:false`'ta da
 * tutulur; yalnız KULLANICI CÜMLESİ üretilmez ve jeton yanmaz.
 */
async function speakWithSettings({ text, play = true, deliver = 'main', settings, apiKey, outDir, fetchImpl = fetch, ctx, notify = true, noticeOnce = true, speakSayImpl = speakSay } = {}) {
  const j = (settings && settings.jarvis) || {};
  const engine = ttsProviders.resolveTtsEngine(settings);
  let fallback = null;
  // 🔴 TTS-01 — `noticeOnce:false` = BU TUR KULLANICININ AÇIK JESTİ (Ayarlar →
  // "Dinle"). "Oturumda bir kez" kuralı kendiliğinden konuşan turlar için doğru,
  // ama kullanıcının bilerek sorduğu bir soruya "sana bunu bir kez söylemiştim"
  // diye susmak, onu çıplak sebep koduna mahkûm ediyordu (Eren'in 0.2.31 ekranı:
  // "ElevenLabs çalışmadı (no-voice)"). Karar ÇAĞIRANINDIR; metin tek yerde kalır.
  const notice = (eng, reason, opts) => (
    notify ? ttsProviders.fallbackNotice(eng, reason, { once: noticeOnce, ...(opts || {}) }) : null
  );

  if (engine === 'openai') {
    if (apiKey) {
      const res = await speakOpenAI({
        text, play, deliver, apiKey, outDir,
        voice: j.ttsVoice || DEFAULT_TTS_VOICE,
        model: j.ttsModel || DEFAULT_TTS_MODEL,
      });
      if (res.ok) return res;
      fallback = { from: 'openai', reason: res.reason || 'tts-failed', notice: notice('openai', res.reason || 'tts-failed') };
    } else {
      fallback = { from: 'openai', reason: 'no-key', notice: notice('openai', 'no-key') };
    }
  } else if (engine === 'elevenlabs' || engine === 'azure') {
    const spec = ttsProviders.TTS_PROVIDERS[engine];
    const res = await ttsProviders.synthesizeCloud({ engine, text, settings, ctx, fetchImpl, notify, noticeOnce });
    if (res.ok) {
      const out = deliverAudioBuffer({
        buf: res.buf, mime: res.mime, ext: spec.ext, engine, voice: res.voice,
        ms: res.ms, play, deliver, outDir,
      });
      if (out.ok) return out;
      fallback = { from: engine, reason: out.reason, notice: notice(engine, out.reason) };
    } else {
      fallback = { from: engine, reason: res.reason, notice: res.notice || null, detail: res.detail || null };
    }
  }

  // 🔴 TTS-ORPHAN-01 — ISITMA TURU `say` AÇMAZ (kusurun GERÇEK kaynağı buydu).
  //
  // ÖLÇÜLDÜ: `${os.tmpdir()}/crewpane-jarvis` altında 1168 adet atıl `say-*.aiff`
  // vardı ve gecenin yetimleri hep aynı metni taşıyordu: "Tamam." — yani ACK
  // ısıtma turu (JarvisWidget.preloadAck → `speak({ play:false, deliver:'renderer' })`).
  // Isıtmanın AMACI bulut motorunun disk mp3 ÖNBELLEĞİNİ doldurmaktır (ADP-812);
  // bulut düşünce buraya, `say`e düşülüyordu. Ama `say`in ÖNBELLEĞİ YOK: üretilen
  // .aiff hiçbir zaman çalınmıyor, okunmuyor, ikinci turda kullanılmıyor —
  // tek etkisi bir çocuk süreç + çöp dosyaydı. Isıtma bir OPTİMİZASYONDUR;
  // duyulmayacak bir sesi sentezlemek için süreç açmaz.
  //
  // Kapı DAR: yalnız "hoparlöre gitmeyecek VE renderer'a tampon istenen" tur,
  // yani ısıtma. `play:false` ile dosya isteyen ÖNİZLEME/KANIT yolu (deliver
  // 'main') AYNEN korunur — birim testi bunu ölçer.
  if (play === false && deliver === 'renderer') {
    return { ok: false, reason: 'warm-skip-say', engine: 'say', ...(fallback ? { fallback } : {}) };
  }
  // ÜCRETSİZ yol — her koşulda çalışır. `say` MAIN'de çalar (renderer'a verilecek
  // bir tampon yok); ADP-812 doğrudan-oynatma modu burada da devrede.
  const sayRes = { ...(await speakSayImpl({ text, play, outDir })), engine: 'say' };
  return fallback ? { ...sayRes, fallback } : sayRes;
}

/**
 * AGENTX-RT-3 — AKAN TTS. Ses, dosya bitmeden çalmaya başlar.
 *
 * Eski yol (`speakWithSettings`) SON baytı bekler; bu yol İLK baytı `onChunk`e
 * verir. Ölçüm ve gerekçe `ttsStream.cjs` başlığındadır (pcm + tek istek).
 *
 * 🔴 ADP-812 ÖNBELLEĞİ BOZULMADI: kısa/tekrar eden cümle (ACK'ler) diskte mp3
 * olarak duruyor ve AĞ TURU BİLE GEREKTİRMİYOR. Akış onu geçseydi ısıtılmış
 * ACK'ler yavaşlardı — o yüzden önbellek ÖNCE sorulur ve dolu ise mp3 aynen
 * döner (çağıran onu eski yoldan çalar). Akış yalnız önbellekte OLMAYAN,
 * yani gerçekten yeni cümle için devreye girer.
 *
 * 🔴 SESSİZ DÜŞÜŞ YOK: akış kurulamıyorsa (motor openai değil, anahtar yok,
 * kapalı bayrak, HTTP hatası) `{ ok:false, reason }` döner — çağıran ESKİ yola
 * düşer ve kullanıcı sessiz kalmaz.
 *
 * 🔴 E2E-MUTE-01: susturulmuş koşuda sentez AYNEN yapılır, parçalar SIFIRLANIR
 * (aynı uzunluk, aynı zamanlama, hoparlöre tek örnek gitmez).
 */
async function speakStreamWithSettings({
  text, settings, apiKey, onChunk, signal, fetchImpl = fetch, cacheDir,
  muted = ttsMute.isTtsMuted(), env = process.env,
} = {}) {
  const clean = String(text == null ? '' : text).trim();
  if (!clean) return { ok: false, reason: 'empty-text' };
  if (typeof onChunk !== 'function') return { ok: false, reason: 'no-sink' };
  // KONTROL KOLU — akan yolu tek değişkenle sök (gecikme eski değerine dönmeli).
  if (env && (env.CREWPANE_TTS_STREAM === '0' || env.CREWPANE_TTS_STREAM === 'off')) {
    return { ok: false, reason: 'stream-disabled' };
  }
  const engine = ttsProviders.resolveTtsEngine(settings);
  // ElevenLabs/Azure'ün de akan uçları var ama bu kartın kapsamı openai; diğerleri
  // BİLEREK eski yola düşer (yalan söylemektense düşmek).
  if (engine !== 'openai') return { ok: false, reason: `stream-unsupported-${engine}` };
  if (!apiKey) return { ok: false, reason: 'no-openai-key' };

  const j = (settings && settings.jarvis) || {};
  const voice = j.ttsVoice || DEFAULT_TTS_VOICE;
  const model = j.ttsModel || DEFAULT_TTS_MODEL;

  const cached = readTtsCache({ text: clean, model, voice, cacheDir });
  if (cached) {
    if (cached.buf.length) ttsMute.noteSynthesized(cached.buf.length);
    return {
      ok: true, cached: true, engine: 'openai', voice, model, playIn: 'renderer',
      mime: 'audio/mpeg', audioBase64: cached.buf.toString('base64'),
      bytes: cached.buf.length, ms: 0, muted: muted || undefined,
    };
  }

  let first = true;
  const res = await ttsStream.streamOpenAiSpeech({
    text: clean, voice, model, apiKey, fetchImpl, signal,
    onChunk: (c) => {
      if (first) {
        first = false;
        if (muted) ttsMute.noteSuppressedOutput('renderer-pcm');
        else ttsMute.noteAudibleOutput('renderer-pcm');
      }
      // Susturma: ZAMANLAMA ve UZUNLUK korunur, örnekler sıfırlanır.
      onChunk(muted ? { ...c, base64: Buffer.alloc(c.bytes).toString('base64') } : c);
    },
  });
  if (res.bytes) ttsMute.noteSynthesized(res.bytes);
  return { ...res, engine: 'openai', voice, model, playIn: 'renderer', muted: muted || undefined };
}

/**
 * ADP-848 — AYARLARDAKİ SESLİ ÖNİZLEME: aynı Türkçe cümleyi İSTENEN motorda
 * seslendir. Karar tabloyla değil KULAKLA verilecek.
 *
 * 🔴 Önizlemede dürüstlük hayati: anahtar yoksa yine ses çıkar (ücretsiz motor),
 * ama sonuç `engine` alanında GERÇEKTEN konuşan motoru ve `fallback`/`notice` ile
 * nedenini taşır — kullanıcı `say`'i ElevenLabs sanmasın.
 *
 * 🔴 TTS-01 — ÖNİZLEMEDE `notice` HER SEFERİNDE DOLAR (`noticeOnce:false`).
 * Sözleşme budur: düşüş olduysa `fallback.notice` bir CÜMLEDİR, asla `null`
 * değildir. Çağıran (Ayarlar paneli) bu sayede çıplak sebep koduna düşmez.
 */
async function ttsPreview({ engine, voice, settings, apiKey, outDir, deliver = 'main', play = true, fetchImpl = fetch, ctx, text } = {}) {
  const wanted = ttsProviders.TTS_PROVIDERS[engine] ? engine : ttsProviders.resolveTtsEngine(settings);
  const previewText = (typeof text === 'string' && text.trim()) ? text.trim() : ttsProviders.TTS_PREVIEW_TEXT_TR;
  const j = (settings && settings.jarvis) || {};
  // 🔴 ADP-848-B — SESİN GİTTİĞİ ALAN MOTORA GÖRE DEĞİŞİR.
  // Eski hâli `voice`'u YALNIZ `ttsVoice`'a yazıyordu; ama ElevenLabs `elevenVoiceId`,
  // Azure `azureVoice` okur. Yani "Dinle"de hangi sesi seçersen seç ElevenLabs
  // hep AYNI sesi konuşurdu ve kullanıcı bunu ancak kulağıyla fark ederdi —
  // ADP-848'de üç örnek dosyanın birebir aynı çıkması bu sınıfın kardeşiydi.
  // Artık üstyazım İSTENEN MOTORUN alanına yazılır; diğer alanlar korunur.
  const voiceOverride = typeof voice === 'string' && voice.trim() ? voice.trim() : null;
  const perEngineVoice = {};
  if (voiceOverride) {
    if (wanted === 'elevenlabs') perEngineVoice.elevenVoiceId = voiceOverride;
    else if (wanted === 'azure') perEngineVoice.azureVoice = voiceOverride;
    else perEngineVoice.ttsVoice = voiceOverride; // say / openai
  }
  // Önizleme AYARI DEĞİŞTİRMEZ: seçilen motor tek seferlik olarak uygulanır.
  const previewSettings = { ...(settings || {}), jarvis: { ...j, ttsEngine: wanted, ...perEngineVoice } };
  const res = await speakWithSettings({
    text: previewText, play, deliver, settings: previewSettings, apiKey, outDir, fetchImpl, ctx,
    noticeOnce: false, // TTS-01 — kullanıcının açık jesti: cevabı her tıklamada ver
  });
  return {
    ...res,
    requested: wanted,
    text: previewText,
    // "Kim konuştu?" sorusunun makine cevabı — UI etiketi bunu okur.
    spokenBy: res.engine || (res.ok ? wanted : null),
  };
}

/** Barge-in / cancel: kill any in-flight afplay playback. */
function stopPlayback() {
  if (_currentPlayback) {
    try {
      _currentPlayback.kill('SIGKILL');
    } catch {
      /* already done */
    }
    _currentPlayback = null;
  }
}

module.exports = {
  // AXP-08 — tema TABAN eşlemesi + tespiti (sürüklenme kapısı testten okur)
  THEME_BASE_PRESET,
  detectThemeBase,
  // env / kimlik bilgisi (ADP-628 — çözümleme requireCredential.cjs'te)
  parseEnvFile,
  loadEnvLocal,
  openAiKey,
  openAiKeyMissingMessage,
  openAiKeySettingsTarget,
  // stt
  transcribeWhisper,
  // ADP-813 — yerel-önce yönlendirici + yerel motor yüzeyi (main quit'te stopServer)
  transcribeSpeech,
  resolveSttEngine,
  DEFAULT_STT_ENGINE,
  whisperLocal,
  extForMime,
  resolveExt,
  sttErrorMessage,
  withUserMessage,
  isHallucinatedSilence,
  buildVocabPrompt,
  // brain
  buildBrainPrompt,
  // ADP-815 — kalıcı oturum yüzeyi (Katman 2)
  buildBrainSystemPrompt,
  buildBrainTurnMessage,
  BRAIN_TERSE_RULE,
  claudeBrainSession,
  decideWithSession,
  warmupBrain,
  stopBrain,
  brainStats,
  killBrainForTest,
  extractJsonObject,
  parseClaudeDecision,
  normalizeDecision,
  parseIntent,
  // ADP-902 (K1) — beyni atlayan yerel hızlı yol (ölçüm/kapı için dışa açık)
  fastLocalDecision,
  fastPathEnabled,
  detectDepartment,
  decideWithClaude,
  decide,
  // ADP-322 — yürütücü politikası (deterministik kapı; testler doğrudan çağırır)
  applyExecutorPolicy,
  routePromptClass,
  // tts
  speakSay,
  // TTS-ORPHAN-01
  SAY_TIMEOUT_MS,
  trackLocalAudioChild,
  untrackLocalAudioChild,
  killLocalAudioChildren,
  liveLocalAudioChildren,
  sweepOrphanSayProcesses,
  speakOpenAI,
  // ADP-812 — TTS önbelleği (kısa/tekrar eden cümleler)
  readTtsCache,
  writeTtsCache,
  ttsCacheFile,
  TTS_CACHE_MAX_CHARS,
  speakWithSettings,
  // AGENTX-RT-3 — akan TTS (pcm parçaları renderer'a; ilk bayt çalar)
  speakStreamWithSettings,
  ttsStream,
  stopPlayback,
  // ADP-848 — sağlayıcı katmanı (ElevenLabs/Azure/OpenAI/yerel) + sesli önizleme.
  // `ttsProviders` yeniden dışa veriliyor ki main tek modül require etsin.
  ttsProviders,
  deliverAudioBuffer,
  ttsPreview,
  // E2E-MUTE-01 — susturma kapısı + çıkış sayacı (main tek modül require etsin).
  ttsMute,
  TTS_PREVIEW_TEXT_TR: ttsProviders.TTS_PREVIEW_TEXT_TR,
  // const
  SAY_VOICE,
  WHISPER_MODEL,
  TTS_VOICES,
  TTS_PREVIEW_TEXT,
  DEFAULT_TTS_VOICE,
  DEFAULT_TTS_MODEL,
  // ADP-812 — VAD penceresi (ayarlanabilir; jarvis:config üzerinden renderer'a gider)
  DEFAULT_SILENCE_MS,
  MIN_SILENCE_MS,
  MAX_SILENCE_MS,
  normalizeSilenceMs,
  normalizeEndpointMaxMs,
  normalizeSleepAfterMs,
  // ADP-916 — "hiç konuşulmadı" eşiği artık ayardan gelir (renderer sabiti değil).
  normalizeNoSpeechMs,
  DEFAULT_NO_SPEECH_MS,
  MIN_NO_SPEECH_MS,
  MAX_NO_SPEECH_MS,
  DEFAULT_ENDPOINT_MAX_MS,
  DEFAULT_SLEEP_AFTER_MS,
};
