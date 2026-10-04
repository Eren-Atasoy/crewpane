// CrewPane — ADP-705: PANE ⇄ OTURUM ÇAPASI (bayat sessionId'nin kalıcı çözümü).
//
// ─────────────────────────────────────────────────────────────────────────────
// KANITLANMIŞ KÖK NEDEN (2026-07-28, gerçek transcript'lerden ölçüldü)
// ─────────────────────────────────────────────────────────────────────────────
// Bir agent pane'i `agentRunner.appendSessionId` ile `--session-id <uuid>`
// alarak doğar; main o id'yi pty defterine yazar ve TÜM transcript probları
// (ADP-280 teslim doğrulaması, ADP-306 son-mesaj, okuma modu, mobil defter)
// o id'den dosya yolu türetir.
//
// Pane REUSE edildiğinde paneRecycler önce `/clear` yazar (ADP-266/667). claude
// `/clear`'da AYNI süreçte YENİ BİR OTURUM açar: yeni uuid, yeni jsonl dosyası —
// ve bunu kimseye söylemez. Defterdeki id o andan itibaren BAYATTIR.
//
// Ölçülen sonuç (jazz, ADP-698, 2026-07-28 20:09):
//   • 17:08:46.060Z  `/clear`            → yeni oturum a98ce929-… doğdu
//   • 17:08:46.468Z  görev prompt'u      → YENİ oturumun defterine DÜŞTÜ (teslim OK)
//   • teslim probu   ESKİ uuid'in dosyasını okudu → "yok" → `undelivered` YALANI
//   • kuyruk 1 kez yeniden gönderdi → AYNI eski dosyaya baktı → yine "yok"
//   • alt-görev BAŞARISIZ damgalandı ve GERÇEKTEN ÇALIŞAN worker öldürüldü.
// Liderin elle "pane'i kapat → yeniden delege et"i 5/5 çalışıyordu çünkü TAZE
// pane TAZE `--session-id` ile doğuyor ve defter yeniden DOĞRU oluyordu.
//
// ─────────────────────────────────────────────────────────────────────────────
// BU MODÜL
// ─────────────────────────────────────────────────────────────────────────────
// Konuşma sıfırlaması yazılan pane'i "oturumu BİLİNMİYOR" olarak işaretler ve
// proje dizinindeki oturum künyelerinden YENİ oturumu bulur:
//   • yalnız SIFIRLAMADAN DOĞMUŞ (`/clear`|`/new` satırıyla başlayan) dosyalar,
//   • başka bir pane'in SAHİPLENDİĞİ id'ler hariç,
//   • sıfırlama anına yakın doğanlar; iki aday ayırt edilemeyecek kadar yakınsa
//     hüküm VERİLMEZ.
//
// 🔴 KİLİT DÜRÜSTLÜK KURALI: çözülemeyen pane için `null` döneriz — çağıran bunu
// "bakılamadı" okur (ADP-280 sözleşmesi) ve ASLA `undelivered` üretmez. Yani bu
// modül çalışmasa bile YALAN üretilmez; çalıştığında doğrulama geri kazanılır.
//
// Motor-agnostik: sıfırlama komutları ve zamanlamalar parametre; isim-bazlı
// hiçbir kontrol yok — davranış pane'in DURUMUNDAN türer.
//
// TÜM IO ENJEKTE (fs/electron require'ı YOK) → `node --test` doğrudan koşar.

'use strict';

const DEFAULTS = Object.freeze({
  /** Sıfırlama anından bu kadar ÖNCE doğmuş dosya da aday sayılır (saat kayması). */
  bornBackMs: 5_000,
  /** Sıfırlama anından bu kadar SONRAYA kadar doğanlar aday. */
  bornWindowMs: 120_000,
  /** İki aday arasındaki en küçük ayırt edici fark; altındaysa hüküm YOK. */
  ambiguityMarginMs: 1_500,
  /** Çözülene kadar iki dosya-sistemi taraması arasındaki en kısa süre. */
  minScanGapMs: 1_000,
  /**
   * "Sıfırlama TUTMADI" hükmünün kanıt eşiği: eski oturum dosyası sıfırlama anından
   * bu kadar SONRA hâlâ yazılıyorsa konuşma değişmemiştir. paneRecycler'ın reset
   * grace'inden (3sn) kısa olamaz: prompt zaten o kadar sonra yazılır.
   */
  stillLiveAfterMs: 3_000,
});

/** Motorun konuşma-sıfırlama komutları (paneRecycler.resetCommandFor ile aynı küme). */
const RESET_COMMANDS = Object.freeze(['/clear', '/new']);

/**
 * Yazılan baytlar bir konuşma sıfırlaması mı? (saf)
 *
 * paneRecycler sıfırlama komutunu TEK parça yazar (`api.write(paneId, '/clear')`),
 * insan ise harf harf yazar — tek harf hiçbir zaman eşleşmez. Elle YAPIŞTIRILAN
 * `/clear` de eşleşir ve bu DOĞRUDUR: oturum gerçekten değişir.
 * @param {unknown} data
 * @param {ReadonlyArray<string>} [commands]
 * @returns {string|null} eşleşen komut ya da null
 */
function resetCommandIn(data, commands = RESET_COMMANDS) {
  if (typeof data !== 'string') return null;
  const t = data.trim().toLowerCase();
  for (const cmd of commands) {
    if (t === cmd) return cmd;
  }
  return null;
}

/**
 * Sıfırlamadan doğan oturumu SEÇ (saf çekirdek — tüm karar burada).
 *
 * @param {Array<{sessionId:string, bornAt:number|null, resetCommand:string|null}>} candidates
 * @param {number} resetAt sıfırlama komutunun yazıldığı an (epoch ms)
 * @param {{claimedIds?:Set<string>|Array<string>, bornBackMs?:number, bornWindowMs?:number, ambiguityMarginMs?:number}} [opts]
 * @returns {string|null} çözülen sessionId; emin değilsek null (ASLA tahmin etme)
 */
function pickResetSession(candidates, resetAt, opts) {
  const o = opts || {};
  const backMs = o.bornBackMs ?? DEFAULTS.bornBackMs;
  const windowMs = o.bornWindowMs ?? DEFAULTS.bornWindowMs;
  const marginMs = o.ambiguityMarginMs ?? DEFAULTS.ambiguityMarginMs;
  const claimed = o.claimedIds instanceof Set ? o.claimedIds : new Set(o.claimedIds || []);
  if (!Array.isArray(candidates) || !Number.isFinite(resetAt)) return null;

  const inWindow = candidates.filter(
    (c) =>
      c &&
      typeof c.sessionId === 'string' &&
      c.sessionId &&
      !claimed.has(c.sessionId) &&
      // 🔴 SIFIRLAMADAN DOĞMUŞ olmalı: taze spawn edilen bir pane'in oturumu da bu
      // dizinde ve bu pencerede doğar; onu çalmak iki pane'i aynı deftere bağlardı.
      typeof c.resetCommand === 'string' &&
      c.resetCommand &&
      typeof c.bornAt === 'number' &&
      c.bornAt >= resetAt - backMs &&
      c.bornAt <= resetAt + windowMs,
  );
  if (!inWindow.length) return null;
  const dist = (c) => Math.abs(c.bornAt - resetAt);
  const sorted = [...inWindow].sort((a, b) => dist(a) - dist(b));
  // İki sıfırlama aynı anda olduysa (kuyruk iki pane'i birlikte ilerletti) hangisinin
  // hangisi olduğu ÖLÇÜLEMEZ → sessizce yanlış eşleştirmektense hüküm verme.
  if (sorted.length > 1 && dist(sorted[1]) - dist(sorted[0]) < marginMs) return null;
  return sorted[0].sessionId;
}

/**
 * Sıfırlama sonrası pane'in GÜNCEL oturumu (saf).
 *
 * İki hâl vardır ve ikisi de gerçektir (canlı pty kaydında ölçüldü):
 *   1. SIFIRLAMA TUTTU  → yeni bir oturum doğdu; onu seç.
 *   2. SIFIRLAMA TUTMADI → `/clear` motorun slash-komut menüsüne düştü ve konuşma
 *      hiç değişmedi. Bu hâlde YENİ oturum YOKTUR; eski id hâlâ DOĞRUDUR. Kanıtı:
 *      eski oturum dosyası sıfırlama anından SONRA yazılmaya devam etmiştir
 *      (gerçek bir `/clear`'da eski dosya bir daha hiç yazılmaz — komut satırı bile
 *      YENİ deftere düşer).
 *
 * Hiçbiri kanıtlanamıyorsa null → çağıran "bakılamadı" der (yalan üretmez).
 *
 * @returns {{sessionId:string, why:'reset-born'|'reset-no-op'}|null}
 */
function resolveAfterReset(candidates, resetAt, opts) {
  const o = opts || {};
  const born = pickResetSession(candidates, resetAt, o);
  if (born) return { sessionId: born, why: 'reset-born' };
  const known = o.knownSessionId;
  if (!known || !Array.isArray(candidates)) return null;
  const stillLiveAfterMs = o.stillLiveAfterMs ?? DEFAULTS.stillLiveAfterMs;
  const h = candidates.find((c) => c && c.sessionId === known);
  if (h && typeof h.mtimeMs === 'number' && h.mtimeMs > resetAt + stillLiveAfterMs) {
    return { sessionId: known, why: 'reset-no-op' };
  }
  return null;
}

/**
 * Çapa defteri. deps:
 *   listSessionHeads(cwd, sinceMs) → [{sessionId, bornAt, resetCommand}]
 *   now()                          → epoch ms
 *   log(line)                      → void
 *   opts                           → DEFAULTS override
 */
function createSessionAnchor(deps) {
  const d = deps || {};
  const cfg = { ...DEFAULTS, ...(d.opts || {}) };
  const now = d.now || (() => Date.now());
  const log = d.log || (() => {});
  const listSessionHeads = d.listSessionHeads || (() => []);

  /** paneId → { at, lastScanAt } — oturumu BİLİNMEYEN pane'ler. */
  const pending = new Map();

  /** Bu pane'e bir konuşma sıfırlaması yazıldı: oturum artık bilinmiyor. */
  function markReset(paneId, at) {
    if (typeof paneId !== 'string' || !paneId) return false;
    const t = typeof at === 'number' ? at : now();
    pending.set(paneId, { at: t, lastScanAt: 0 });
    log(`session-anchor: ${paneId} konuşması sıfırlandı — oturum id'si artık BİLİNMİYOR (yeniden çapalanacak)`);
    return true;
  }

  /** Oturumu şu an bilinmiyor mu? */
  function isPending(paneId) {
    return pending.has(paneId);
  }

  /** Pane kapandı/yeniden doğdu → defteri unut. */
  function forget(paneId) {
    return pending.delete(paneId);
  }

  /**
   * Bu pane'in GÜNCEL oturum id'sini çözmeyi dene.
   * @param {string} paneId
   * @param {{cwd?:string|null, claimedIds?:Set<string>|Array<string>}} ctx
   * @returns {string|null} çözüldüyse yeni id (defterden düşer), aksi hâlde null
   */
  function resolve(paneId, ctx) {
    const rec = pending.get(paneId);
    if (!rec) return null;
    const c = ctx || {};
    if (!c.cwd) return null;
    const t = now();
    // Dosya-sistemi taraması ucuz değil ve bu yol her teslim kontrolünde çağrılır.
    if (rec.lastScanAt && t - rec.lastScanAt < cfg.minScanGapMs) return null;
    rec.lastScanAt = t;
    let heads = [];
    try {
      heads = listSessionHeads(c.cwd, rec.at - cfg.bornBackMs) || [];
    } catch {
      heads = [];
    }
    const picked = resolveAfterReset(heads, rec.at, {
      claimedIds: c.claimedIds,
      knownSessionId: c.knownSessionId || null,
      bornBackMs: cfg.bornBackMs,
      bornWindowMs: cfg.bornWindowMs,
      ambiguityMarginMs: cfg.ambiguityMarginMs,
      stillLiveAfterMs: cfg.stillLiveAfterMs,
    });
    if (!picked) return null;
    pending.delete(paneId);
    log(
      picked.why === 'reset-no-op'
        ? `session-anchor: ${paneId} sıfırlaması TUTMAMIŞ (eski defter hâlâ yazılıyor) → oturum ${picked.sessionId} korundu`
        : `session-anchor: ${paneId} yeniden çapalandı → oturum ${picked.sessionId}`,
    );
    return picked.sessionId;
  }

  /** Test/gözlem yüzeyi. */
  function snapshot() {
    return [...pending.entries()].map(([paneId, r]) => ({ paneId, at: r.at }));
  }

  return { markReset, isPending, forget, resolve, snapshot, config: () => ({ ...cfg }) };
}

module.exports = {
  DEFAULTS,
  RESET_COMMANDS,
  resetCommandIn,
  pickResetSession,
  resolveAfterReset,
  createSessionAnchor,
};
