// SYNC-F1-2 (Wheeljack) — `src/app/lib/deltaSync.ts`'in CJS İKİZİ (parite testli).
//                          Tasarım: SYNC-F1-TASARIM.md §2.1 sonu · §2.5
//
// ═══════════════════════════════════════════════════════════════════════════════
// NEDEN İKİZ — VE NEDEN YENİDEN YAZILMADI
// ═══════════════════════════════════════════════════════════════════════════════
// Tasarım §2.1: "deltaSync.ts'in saf çekirdeği AYNEN kullanılır — yeniden yazılmaz".
// Ama `deltaSync.ts` renderer tarafında ESM/TS'tir; `electron/sync/` ise asar içinde
// CJS olarak `require` edilir. İki seçenek vardı:
//   (a) esbuild ile derle → paketlemeye yeni bir adım ve asar/ESM tuzağı,
//   (b) BİREBİR TAŞI + PARİTE TESTİ → `crewpanePaths` ikiz sözleşmesinin aynısı.
// Tasarımın önerisi (b) idi, uygulanan da budur.
//
// 🔴 PARİTE BİR İDDİA DEĞİL, TESTTİR: `deltaCore.test.cjs` TS ikizini esbuild ile
//    ANINDA derler ve HER İKİ uygulamayı AYNI vektörlerle koşturup çıktıları
//    karşılaştırır. Yani "birebir taşındı" cümlesi her `npm run test:unit`te
//    yeniden kanıtlanır; biri değişip öbürü unutulursa test KIRMIZI yanar.
//    (DB-ENG-01 dersinin dosya karşılığı: ikiz açılmadığında arıza kullanıcıda patlar.)
//
// ⚠️ BU DOSYAYI ELLE DEĞİŞTİRME. Davranış değişecekse ÖNCE `src/app/lib/deltaSync.ts`
//    değişir, sonra buraya taşınır. Ters yön paritenin anlamını yok eder.
//
// Aşağıdaki yorumlar TS ikizinin ölçülmüş gerekçelerinin ÖZETİdir; tam metin orada.

'use strict';

/** Cursor'ın kaç ms geriden sorulacağı — commit görünürlük yarışı payı. */
const CURSOR_OVERLAP_MS = 5000;

/**
 * Satır kümesindeki EN BÜYÜK damga — bir sonraki delta sorgusunun cursor'ı.
 * Karşılaştırma ZAMAN olarak yapılır (Postgres `timestamptz`'i farklı ondalık
 * hassasiyetle basabilir: `.1+00` vs `.100000+00`). Çözümlenemeyen damga cursor'ı
 * KİRLETMEZ.
 * @param {Iterable<string|null|undefined>} stamps
 * @param {string|null} [previous]
 * @returns {string|null}
 */
function maxStamp(stamps, previous = null) {
  let best = previous;
  let bestMs = previous ? Date.parse(previous) : Number.NEGATIVE_INFINITY;
  if (!Number.isFinite(bestMs)) bestMs = Number.NEGATIVE_INFINITY;
  for (const s of stamps) {
    if (typeof s !== 'string' || !s) continue;
    const ms = Date.parse(s);
    if (!Number.isFinite(ms)) continue;
    if (ms > bestMs) {
      bestMs = ms;
      best = s;
    }
  }
  return best;
}

/**
 * Delta sorgusuna verilecek alt sınır: cursor eksi örtüşme payı.
 * Cursor yoksa `null` — çağıran bunu "henüz temel yok, TAM yükle" olarak okur.
 * @param {string|null} cursor
 * @param {number} [overlapMs]
 * @returns {string|null}
 */
function cursorFloor(cursor, overlapMs = CURSOR_OVERLAP_MS) {
  if (!cursor) return null;
  const ms = Date.parse(cursor);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms - Math.max(0, overlapMs)).toISOString();
}

/**
 * Gelen (değişmiş) satırları mevcut listeye işle. Hiçbir şey değişmediyse `prev`
 * REFERANSI aynen döner (ADP-284 sözleşmesi). Örtüşme payı yüzünden aynı satır
 * arka arkaya iki kez gelebilir → "aynı içerik" kontrolü şart.
 */
function applyDelta(prev, incoming, keyOf, isEqual, sort) {
  if (incoming.length === 0) return prev;
  const index = new Map();
  for (let i = 0; i < prev.length; i++) index.set(keyOf(prev[i]), i);

  let next = null;
  for (const row of incoming) {
    const key = keyOf(row);
    const at = index.get(key);
    if (at === undefined) {
      next = next ?? [...prev];
      index.set(key, next.length);
      next.push(row);
    } else if (!isEqual((next ?? prev)[at], row)) {
      next = next ?? [...prev];
      next[at] = row;
    }
  }
  return next ? sort(next) : prev;
}

/** Verilen anahtarları listeden düşür. Hiçbiri yoksa `prev` referansı korunur. */
function dropRows(prev, dropIds, keyOf) {
  if (dropIds.length === 0) return prev;
  const gone = new Set(dropIds);
  const next = prev.filter((row) => !gone.has(keyOf(row)));
  return next.length === prev.length ? prev : next;
}

/**
 * Yerel liste ile sunucu manifestosunu karşılaştır.
 *   · Sunucuda VAR, bizde YOK → refetch (kaçan INSERT)
 *   · Damgalar FARKLI         → refetch (kaçan UPDATE; cursor ilerlememiş olabilir)
 *   · Bizde VAR, sunucuda YOK → drop    (kaçan DELETE)
 * Boş manifest GEÇERLİdir (tablo boşaldı) — çağıran sorgu HATASINDA bu fonksiyonu
 * çağırmamalıdır (hata ≠ boş manifest).
 * @returns {{refetchIds:string[], dropIds:string[]}}
 */
function planReconcile(local, manifest, keyOf, stampOf) {
  const localStamps = new Map();
  for (const row of local) localStamps.set(keyOf(row), stampOf(row));

  const refetchIds = [];
  const serverIds = new Set();
  for (const row of manifest) {
    if (!row || typeof row.id !== 'string') continue;
    serverIds.add(row.id);
    if (!localStamps.has(row.id)) {
      refetchIds.push(row.id);
      continue;
    }
    const mine = localStamps.get(row.id) ?? null;
    const theirs = row.updated_at ?? null;
    if (!sameStamp(mine, theirs)) refetchIds.push(row.id);
  }

  const dropIds = [];
  for (const id of localStamps.keys()) if (!serverIds.has(id)) dropIds.push(id);

  return { refetchIds, dropIds };
}

/** İki damga aynı ANI mı gösteriyor? (Postgres'in ondalık basımı değişebilir.) */
function sameStamp(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const am = Date.parse(a);
  const bm = Date.parse(b);
  if (!Number.isFinite(am) || !Number.isFinite(bm)) return false;
  return am === bm;
}

/**
 * Yedek poll aralığı: realtime KANITLANMIŞken seyrek, kanıtsızken sık.
 * DİKKAT (OFS-01): `realtimeHealthy` kanal DURUMU değil, `realtimeProven()` çıktısıdır.
 */
function backupPollMs(realtimeHealthy, fastMs, slowMs) {
  return realtimeHealthy ? Math.max(fastMs, slowMs) : fastMs;
}

/**
 * OFS-01 — SUBSCRIBED ≠ CANLI. Kanalın "sağlıklı" sayılması için OLAY GÖRMÜŞ olması
 * şart (ölçülen arıza: `app` şeması publication'da yok → kanal SUBSCRIBED döner ama
 * tek olay gelmez; yedek poll 5 sn → 60 sn'ye seyrelir ve tek canlılık kanalı, tam da
 * realtime hiç çalışmadığı ortamda YAVAŞLAR).
 */
function realtimeProven(subscribed, eventsSeen) {
  return subscribed && Number.isFinite(eventsSeen) && eventsSeen > 0;
}

/** Zemin mutabakatının zamanı geldi mi? `lastAt<=0` ⇒ hiç koşmadı ⇒ evet. */
function shouldReconcile(lastAt, now, everyMs) {
  if (!Number.isFinite(lastAt) || lastAt <= 0) return true;
  return now - lastAt >= everyMs;
}

module.exports = {
  CURSOR_OVERLAP_MS,
  maxStamp,
  cursorFloor,
  applyDelta,
  dropRows,
  planReconcile,
  backupPollMs,
  realtimeProven,
  shouldReconcile,
};
