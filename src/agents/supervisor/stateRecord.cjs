'use strict';

const { STORE_VERSION, SETTLE_SOURCES } = require('./constants.cjs');

/** Kayıt anahtarı — delegasyon+alt-görev tekildir. */
function recordKey(delegationId, subtaskId) {
  return `${delegationId}:${subtaskId}`;
}

/** Şekil toleransı: defter her zaman { version, records:{} }. */
function normalizeState(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const src = s.records && typeof s.records === 'object' ? s.records : {};
  const records = {};
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && typeof v.delegationId === 'string' && typeof v.subtaskId === 'string') {
      records[k] = v;
    }
  }
  return { version: STORE_VERSION, records };
}

/**
 * TESLİM HÜKMÜ MERDİVENİ (saf). Transcript birincil kanıt; pane tamponu İKİNCİL ve
 * yalnız POZİTİF yönde geçerli. claude alt-ekranda (`?1049h`) koşar ve prompt'u ekrana
 * echo ETMEZ ([[claude-cli-altscreen-no-history]]) → tamponda GÖRMEMEK teslim
 * edilmediğini KANITLAMAZ. Yokluk-kanıtı zayıf, varlık-kanıtı güçlü: yalnız null→true
 * yükseltmesi yapılır, null→false ASLA.
 *
 * @param {{transcript:boolean|null, buffer?:string, signature?:string|null}} ev
 * @returns {boolean|null} true=teslim kanıtlı · false=defter baktı, YOK · null=bakılamadı
 */
function deliveryVerdict(ev) {
  const transcript = ev && (ev.transcript === true || ev.transcript === false) ? ev.transcript : null;
  if (transcript !== null) return transcript;
  const sig = ev && typeof ev.signature === 'string' ? ev.signature : '';
  const buf = ev && typeof ev.buffer === 'string' ? ev.buffer : '';
  if (sig && buf && buf.includes(sig)) return true;
  return null;
}

/**
 * Bir uyandırma denemesinin ZAMANI geldi mi? Saf — backoff tablosu + son deneme anı.
 * @returns {boolean}
 */
function wakeDue(wake, now, backoff, ackWindowMs, busyRetryMs) {
  if (!wake || wake.ackedAt) return false;
  const attempts = wake.attempts || 0;
  const last = wake.lastAt || 0;
  if (wake.busyAt && wake.busyAt === last) {
    return now - last >= (typeof busyRetryMs === 'number' ? busyRetryMs : 5_000);
  }
  if (attempts === 0) return true;
  let waitMs;
  if (wake.deliveredAt === last) waitMs = ackWindowMs;
  else waitMs = backoff[Math.min(attempts, backoff.length - 1)];
  return now - last >= waitMs;
}

/**
 * "Sen yokken" özeti — lider pane'ine yazılacak tek satırlık uyandırma metni.
 * Saf: kayıt listesinden metin üretir (IO yok).
 */
function wakeTextFor(records) {
  const seen = new Set();
  const uniq = [];
  for (const r of records) {
    const key = `${r.status}|${r.taskCode || ''}|${r.evidencePath || r.subtaskId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(r);
  }
  const done = uniq.filter((r) => r.status === 'done');
  const bad = uniq.filter((r) => r.status && r.status !== 'done');
  const parts = [];
  if (done.length) {
    parts.push(
      `${done.length} alt-görev BİTTİ (${done
        .map((r) => `${r.taskCode || r.subtaskId}${r.evidencePath ? ` → ${r.evidencePath}` : ''}`)
        .join(', ')})`,
    );
  }
  if (bad.length) {
    parts.push(
      `${bad.length} alt-görev sorunlu (${bad.map((r) => `${r.taskCode || r.subtaskId}: ${r.status}`).join(', ')})`,
    );
  }
  const detected = uniq.some((r) => r.settledBy && r.settledBy !== SETTLE_SOURCES.RENDERER);
  const notes = uniq.map((r) => (r.note ? String(r.note).replace(/\s+/g, ' ').trim() : '')).filter(Boolean);
  return (
    `[CrewPane supervisor] ${parts.join(' · ')}. ` +
    (detected ? 'Bunu supervisor tespit etti (motor sinyali gelmedi). ' : '') +
    (notes.length ? `${notes.join(' | ').slice(0, 600)} ` : '') +
    'Kuyruk otomatik ilerletildi. Çıktıları incele ve patrona raporla.'
  );
}

module.exports = {
  recordKey,
  normalizeState,
  deliveryVerdict,
  wakeDue,
  wakeTextFor,
};
