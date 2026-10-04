// HAND-BUG-01 — EL KONTROLÜ KAMERA SEÇİM POLİTİKASI (saf karar katmanı).
//
// KÖK NEDEN (DEMO-02 §2.2 + bu kartın A/B bölümü, 03.09'da yeniden ölçüldü):
// `HandDetectEngine` `getUserMedia`'yı `deviceId` VERMEDEN çağırıyordu →
// Chromium sistem sırasındaki İLK videoinput'u açar. Bu makinede o cihaz OBS
// Virtual Camera olduğunda akış canlı GÖRÜNÜR (kare sayacı artar, rozet yeşile
// döner) ama kareler DONMUŞ tek bir resimdir → MediaPipe hiçbir zaman el
// görmez ve kullanıcının düzeltme yolu yoktur. "Sahte yeşil" budur.
//
// ⚠️ MARKA-İSİM YASAĞI (feedback_no_hardcoded_brand_cases): karar İSİMDEN değil
// DURUMDAN çıkar. Sıralama dört katmanlıdır; güçlüden zayıfa:
//
//   1. KULLANICI SEÇİMİ — `handControl.camera.{deviceId,label}`. Her şeyi yener;
//      boş ölçülse bile elenmez (kullanıcı bilerek seçmiş olabilir), yalnız
//      dürüst uyarı verilir.
//   2. ÖLÇÜM (probe) — akış CANLI mı? Tamamen isimsiz ve platformdan bağımsız
//      tek KESİN sinyal; asıl kararı bu verir. İki ölü biçim ayrılır:
//        · boş  : uzamsal varyans ≈ 0 (tek renk / siyah kare)
//        · donmuş: ardışık kareler BAYT BAYT aynı (zamansal fark = 0 VE
//                  varyans yayılımı = 0). Gerçek sensörde gürültü hep vardır.
//      03.09 gerçek ölçümü (electron/probe, 640×480@30, 2 sn):
//        C922      tempDelta 0.0463  varSpread 419.0   → CANLI
//        FaceTime  tempDelta 3.7540  varSpread 3128.1  → CANLI
//        iPhone    tempDelta 0.6956  varSpread 485.6   → CANLI
//        OBS       tempDelta 0.0000  varSpread   0.000 → DONMUŞ (varyans 1277
//                  yani kare SİYAH DEĞİL — "karanlık mı" diye bakmak bu kusuru
//                  KAÇIRIRDI; ayırt eden şey kareler arası DEĞİŞİM'dir)
//   3. DONANIM SINIFI — macOS `system_profiler SPCameraDataType` "Model ID"
//      alanı. Bu kullanıcıya görünen etiket DEĞİL, sürücünün donanım kimliği:
//        `UVC Camera VendorID_1133 ProductID_2140` → USB donanımı (C922)
//        `FaceTime HD Camera`                      → dahili
//        `iPhone17,1`                              → Continuity (kablosuz)
//        `OBS Camera Extension`                    → CoreMediaIO EKLENTİSİ
//      Elenen şey "OBS markası" değil, "donanım transportu olmayan eklenti".
//   4. SON ÇARE — etiket sezgisi (`VIRTUAL_LABEL_HINTS`). TEK YERDE durur,
//      yalnız 1-3 karar veremediğinde sıralamayı iter, hiçbir cihazı TAMAMEN
//      elemez. Kullanıcı her zaman elle seçebilir.
//
// Ek yapısal sinyal (platformdan bağımsız, YALNIZ ARTI puan): videoinput'un
// `groupId`'si bir audioinput ile paylaşılıyorsa cihaz mikrofonlu fiziksel bir
// kameradır (C922 ölçüldü). Eksi puan olarak KULLANILMAZ — dahili FaceTime
// mikrofonuyla grup paylaşmıyor (ölçüldü), ceza yanlış olurdu.

'use strict';

// --- Ölü akış eşikleri (yukarıdaki gerçek ölçümden; gözle ayar YASAK) --------
// İki koşul da sağlanmalı → "donmuş" hükmü YANLIŞ POZİTİF vermesin: canlı bir
// kamerayı düşürmek, sanal bir kamerayı denemekten daha pahalı bir hatadır.
const BLANK_VARIANCE_MAX = 1.0; // uzamsal varyans (0-255 parlaklık²) bunun altı = tek renk
const FROZEN_TEMPORAL_MAX = 0.005; // ardışık kare ortalama farkı (en düşük canlı ölçüm 0.0463)
const FROZEN_SPREAD_MAX = 0.5; // varyans max-min yayılımı (en düşük canlı ölçüm 419)
const PROBE_MS = 1600; // aday başına ölçüm penceresi (~45 kare @30fps)
const PROBE_MIN_FRAMES = 12; // bu kadar kare toplanmadan hüküm verilmez
const DEAD_WARN_MS = 3000; // kart şartı: akış ≥3 sn ölü kalırsa dürüst uyarı

// Chromium'un takma cihazları — gerçek bir aygıt değil, "varsayılan"ın kendisi.
// Bunları açmak tam da düzeltmeye çalıştığımız körlemesine seçimdir.
const PSEUDO_DEVICE_IDS = Object.freeze(['', 'default', 'communications']);

// SON ÇARE etiket sezgisi. Buraya marka eklemek bir DÜZELTME DEĞİL, kabul
// edilmiş bir yenilgidir: önce 2. ve 3. katmanın neden karar veremediğine bak.
const VIRTUAL_LABEL_HINTS = Object.freeze([
  /\bvirtual\b/i, /\bobs\b/i, /\bndi\b/i, /\bmanycam\b/i, /\bcamo\b/i,
  /\bepoccam\b/i, /\bdroidcam\b/i, /\bloopback\b/i, /screen ?capture/i,
]);

// Model ID (donanım kimliği) sınıflandırması. SIRA ÖNEMLİ: USB önce bakılır,
// böylece adında "extension" geçen gerçek bir UVC aygıtı sanal sanılmaz.
const MODEL_ID_USB = /vendorid[_ ]?\d+|productid[_ ]?\d+|\buvc\b/i;
const MODEL_ID_BUILTIN = /facetime|studio display camera|desk view/i;
const MODEL_ID_WIRELESS = /^(iphone|ipad)\d/i;
const MODEL_ID_VIRTUAL = /extension|virtual|plug-?in|software|camera plugin/i;

const KIND_SCORE = Object.freeze({
  usb: 60,
  builtin: 50,
  wireless: -20, // fiziksel ama uzakta/uyanmamış olabilir: dahilinin ALTINDA
  virtual: -300,
  unknown: 0,
});

const SCORE = Object.freeze({
  preferredId: 1000, // kullanıcı bu aygıtı SEÇTİ
  preferredLabel: 900, // deviceId tuzu değişmiş olabilir → etiketten yakala
  probeLive: 200,
  probeDead: -500,
  probeFailed: -800,
  sharesAudioGroup: 40, // mikrofonlu fiziksel aygıt (yalnız ARTI)
  virtualLabelHint: -80, // SON ÇARE
});

/** Etiket/isim normalizasyonu: "C922 Pro Stream Webcam (046d:085c)" → "c922prostreamwebcam" */
function normalizeName(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/\([^)]*\)\s*$/, '') // Chromium'un eklediği (vendor:product) kuyruğu
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/** `system_profiler SPCameraDataType` "Model ID" → donanım sınıfı. */
function classifyModelId(modelId) {
  const s = typeof modelId === 'string' ? modelId.trim() : '';
  if (!s) return 'unknown';
  if (MODEL_ID_USB.test(s)) return 'usb';
  if (MODEL_ID_BUILTIN.test(s)) return 'builtin';
  if (MODEL_ID_WIRELESS.test(s)) return 'wireless';
  if (MODEL_ID_VIRTUAL.test(s)) return 'virtual';
  return 'unknown';
}

/**
 * `system_profiler SPCameraDataType` çıktısını ayrıştır.
 * Girdi kirliyse/boşsa [] döner — ASLA fırlatmaz (sınıflandırma bir BONUS'tur,
 * politikanın omurgası ölçümdür; bu adım düşerse seçim yine doğru çalışır).
 */
function parseSystemProfilerCameras(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const out = [];
  let cur = null;
  for (const rawLine of text.split('\n')) {
    const kv = rawLine.match(/^\s+(Model ID|Unique ID):\s*(.+?)\s*$/);
    if (kv && cur) {
      if (kv[1] === 'Model ID') cur.modelId = kv[2];
      else cur.uniqueId = kv[2];
      continue;
    }
    const head = rawLine.match(/^\s+([^:]+):\s*$/);
    if (head) {
      const name = head[1].trim();
      if (!name || name === 'Camera') continue;
      cur = { name, modelId: '', uniqueId: '' };
      out.push(cur);
    }
  }
  return out.map((c) => ({ ...c, kind: classifyModelId(c.modelId) }));
}

/** Ölçülen kare istatistiğinden ÖLÜ AKIŞ hükmü. Yetersiz örnek → hüküm YOK. */
function verdictFromStats(stats) {
  if (!stats || typeof stats !== 'object') return { dead: false, reason: null };
  const frames = Number(stats.frames) || 0;
  if (frames < PROBE_MIN_FRAMES) return { dead: false, reason: null };
  const varianceMedian = Number(stats.varianceMedian);
  const temporalDelta = Number(stats.temporalDelta);
  const varianceSpread = Number(stats.varianceSpread);
  if (Number.isFinite(varianceMedian) && varianceMedian < BLANK_VARIANCE_MAX) {
    return { dead: true, reason: 'blank' }; // tek renk / siyah
  }
  if (
    Number.isFinite(temporalDelta) && temporalDelta <= FROZEN_TEMPORAL_MAX
    && Number.isFinite(varianceSpread) && varianceSpread <= FROZEN_SPREAD_MAX
  ) {
    return { dead: true, reason: 'frozen' }; // kareler bayt bayt aynı
  }
  return { dead: false, reason: null };
}

function matchesPreferred(device, preferred) {
  if (!preferred) return null;
  if (preferred.deviceId && device.deviceId === preferred.deviceId) return 'deviceId';
  const want = normalizeName(preferred.label);
  if (want && normalizeName(device.label) === want) return 'label';
  return null;
}

/** enumerateDevices etiketini system_profiler adıyla eşle (iki yönlü içerme). */
function findHardware(label, hardware) {
  const n = normalizeName(label);
  if (!n || !Array.isArray(hardware)) return null;
  for (const hw of hardware) {
    const h = normalizeName(hw.name);
    if (h && (h === n || h.includes(n) || n.includes(h))) return hw;
  }
  return null;
}

/**
 * Adayları sıralar. SAF fonksiyon — cihaz açmaz, komut çalıştırmaz.
 *
 * @param {object} input
 * @param {Array}  input.devices    enumerateDevices() videoinput listesi
 * @param {Array}  [input.hardware] parseSystemProfilerCameras() çıktısı
 * @param {object} [input.probes]   { [deviceId]: { frames, varianceMedian, varianceSpread, temporalDelta } | { failed: true } }
 * @param {object} [input.preferred] { deviceId, label } — kullanıcı ayarı
 * @param {Array}  [input.audioGroupIds] audioinput groupId listesi (yapısal bonus)
 * @returns {Array} puanı düşene doğru sıralı aday listesi
 */
function rankDevices(input) {
  const devices = Array.isArray(input && input.devices) ? input.devices : [];
  const hardware = Array.isArray(input && input.hardware) ? input.hardware : [];
  const probes = (input && input.probes) || {};
  const preferred = (input && input.preferred) || null;
  const audioGroups = new Set(Array.isArray(input && input.audioGroupIds) ? input.audioGroupIds : []);

  const seen = new Set();
  const out = [];
  for (let i = 0; i < devices.length; i++) {
    const d = devices[i] || {};
    const deviceId = typeof d.deviceId === 'string' ? d.deviceId : '';
    // Takma kimlikler ve kopyalar: "varsayılanı aç" tam da bu kartın kusuru.
    if (PSEUDO_DEVICE_IDS.includes(deviceId) || seen.has(deviceId)) continue;
    seen.add(deviceId);

    const label = typeof d.label === 'string' ? d.label : '';
    const hw = findHardware(label, hardware);
    const kind = hw ? hw.kind : 'unknown';
    const reasons = [];
    let score = 0;

    // Kullanıcı seçimi PUAN DEĞİL, SERT ÖNCELİKTİR: puan olsaydı yeterince iyi
    // ölçülen başka bir cihaz onu geçebilirdi (birim testte ölçüldü) — o da
    // "seçtim ama yine başkasını açıyor" diyen ikinci bir kusur olurdu.
    const pref = matchesPreferred({ deviceId, label }, preferred);
    const pinned = pref !== null;
    if (pref === 'deviceId') { score += SCORE.preferredId; reasons.push('kullanıcı seçimi'); }
    else if (pref === 'label') { score += SCORE.preferredLabel; reasons.push('kullanıcı seçimi (etiket)'); }

    const probe = probes[deviceId];
    let verdict = { dead: false, reason: null };
    if (probe && probe.failed) {
      score += SCORE.probeFailed;
      reasons.push('açılamadı');
    } else if (probe) {
      verdict = verdictFromStats(probe);
      if (verdict.dead) {
        score += SCORE.probeDead;
        reasons.push(verdict.reason === 'frozen' ? 'ölçüldü: kareler donmuş' : 'ölçüldü: kare boş');
      } else if ((Number(probe.frames) || 0) >= PROBE_MIN_FRAMES) {
        score += SCORE.probeLive;
        reasons.push('ölçüldü: canlı');
      }
    }

    score += KIND_SCORE[kind] ?? 0;
    if (kind !== 'unknown') reasons.push(`donanım: ${kind}`);

    if (d.groupId && audioGroups.has(d.groupId)) {
      score += SCORE.sharesAudioGroup;
      reasons.push('mikrofonla aynı aygıt grubu');
    }

    // SON ÇARE — yalnız donanım sınıfı bilinmiyorsa devreye girer.
    if (kind === 'unknown' && VIRTUAL_LABEL_HINTS.some((re) => re.test(label))) {
      score += SCORE.virtualLabelHint;
      reasons.push('etiket sezgisi: sanal olabilir');
    }

    out.push({ deviceId, label, groupId: d.groupId || null, kind, score, order: i, pinned, dead: verdict.dead, deadReason: verdict.reason, reasons });
  }

  // Sabitlenmiş (kullanıcı seçimi) her zaman başta; sonra puan; eşitlikte
  // kaynağın sırası korunur (kararlı sıralama: aynı girdi → aynı çıktı).
  out.sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.score - a.score) || (a.order - b.order));
  return out;
}

module.exports = {
  BLANK_VARIANCE_MAX,
  FROZEN_TEMPORAL_MAX,
  FROZEN_SPREAD_MAX,
  PROBE_MS,
  PROBE_MIN_FRAMES,
  DEAD_WARN_MS,
  PSEUDO_DEVICE_IDS,
  VIRTUAL_LABEL_HINTS,
  KIND_SCORE,
  SCORE,
  normalizeName,
  classifyModelId,
  parseSystemProfilerCameras,
  verdictFromStats,
  rankDevices,
};
