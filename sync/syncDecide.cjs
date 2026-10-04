// SYNC-F1-3 (Wheeljack) — KARAR ÇEKİRDEĞİ: motorun düşündüğü her şey, SAF hâlde.
//                         Tasarım: SYNC-F1-TASARIM.md §3.1 · §3.2 · §2.5 · §5.4 · §4.4
//
// ═══════════════════════════════════════════════════════════════════════════════
// TASARIMDAN SAPMA (bilinçli, §16'da da yazılı): §2.1'in modül haritasında bu dosya YOK.
// ═══════════════════════════════════════════════════════════════════════════════
// Gerekçe ölçülebilir: LWW, mutabakat planı, sır kapısı ve gövde çözümü `syncEngine`
// içinde kalsaydı bu dört kararın HİÇBİRİ ağsız/disksiz sınanamazdı — motoru sınamak
// için sahte bir istemci + sahte bir dosya sistemi kurmak gerekirdi ve testler
// "kararın doğruluğunu" değil "kurgunun doğruluğunu" ölçerdi. `deltaCore` ile aynı
// duruş: saf çekirdek ayrı dosyada, motor onu ÇAĞIRIR.
//
// ─────────────────────────────────────────────────────────────────────────────
// LWW ÜÇÜNCÜ BASAMAK ESTETİK DEĞİL, DÖNGÜ KIRICI (§3.1)
// ─────────────────────────────────────────────────────────────────────────────
// İki cihaz aynı satır için FARKLI kazanan seçerse dosyayı birbirine iter (ping-pong)
// ve senkron sonsuza dek trafik üretir. `rev` -> `updated_at` -> `sha256` sırası her
// iki cihazda AYNI cevabı verir; üçüncü basamak olmadan `rev` ve damga eşit olduğunda
// karar "kim önce sordu"ya kalırdı.
//
// BAYT EŞİTLİĞİ ÖNCE: `sha` aynıysa çakışma YOKTUR. İki ajan aynı olguyu aynı şekilde
// yazmış olabilir (SYNC-R1 §3.2) — bunu çakışma saymak defteri gürültüyle doldururdu.

'use strict';

const nodeCrypto = require('node:crypto');

/**
 * §5.4 kapısı — FAZ 0 reçetesindeki grep'in istemci karşılığı.
 *
 * ÖLÇÜLDÜ (tasarım §5.4 + §12.5): bugünkü 1.420 dosyalık külliyatta 1 eşleşme var ve
 * o bir YANLIŞ POZİTİF (kapının kendi regex'ini ANLATAN bir hafıza dosyası). Bu yüzden
 * kapı BEKLETİR, BLOKLAMAZ: dosya yüklenmez, `sync_conflicts(kind='secret-hold')`
 * yazılır, kullanıcı onaylarsa sha256 yerel izin listesine girer.
 */
const SECRET_PATTERNS = [
  { name: 'openai-proj', re: /sk-proj-[A-Za-z0-9_-]{12,}/ },
  { name: 'openai-legacy', re: /sk-[a-f0-9]{20,}/ },
  { name: 'anthropic', re: /sk-ant-[A-Za-z0-9_-]{12,}/ },
  { name: 'github-pat', re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\./ },
  { name: 'aws-akid', re: /AKIA[0-9A-Z]{16}/ },
];

/** DB `body` kolonu tavanı — satır içi gövde 64 KB (§1.3). */
const INLINE_BODY_MAX = 65536;

/** `sync_conflicts.loser_body` tavanı — aynı sayı, ayrı isim (ikisi ayrı ayrı değişebilir). */
const LOSER_BODY_MAX = 65536;

function sha256Of(buf, crypto = nodeCrypto) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Sır taraması. Satır numarası DÖNER — kullanıcıya "satır 28" demek, "bu dosyada
 * bir şey var" demekten ölçülebilir biçimde daha kullanışlıdır.
 * @returns {Array<{pattern:string, line:number}>}
 */
function scanSecrets(text) {
  if (typeof text !== 'string' || !text) return [];
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(lines[i])) hits.push({ pattern: p.name, line: i + 1 });
    }
  }
  return hits;
}

/**
 * LWW (§3.1). `a` ve `b` = `{sha256, rev, updated_at}`.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 🔴 `rev` BASAMAĞI YALNIZ İKİ TARAF DA SUNUCU DAMGALI OLDUĞUNDA ÇALIŞIR
 * ═════════════════════════════════════════════════════════════════════════════
 * Tasarım §3.1 "önce `rev`" diyor ve iki BULUT gözlemini karşılaştırırken doğrudur.
 * Ama PUSH çakışmasında (`rev=eq.<base>` 0 satır döndü) taraflardan biri YEREL BİR
 * DOSYADIR ve onun sunucu `rev`i YOKTUR. `rev` yokluğunu `-1` sayıp basamağı yine
 * de işletmek, uzak satırı (rev >= 0) HER ZAMAN kazandırırdı: LWW çöker, "en son
 * yazan" değil "buluta ilk ulaşan" kazanır ve kullanıcının az önce yazdığı dosya
 * sessizce ezilirdi. Bu yüzden basamak, taraflardan birinde `rev` yoksa ATLANIR ve
 * karar damgaya + sha'ya kalır. Damga saate bağlıdır (iki cihazın saati farklı
 * olabilir) — bu bilinen bir sınırdır, kaybeden bayt bu yüzden `sync_conflicts`
 * defterine KONUR ve geri alınabilir.
 *
 * @returns {'a'|'b'|'equal'}
 */
function decideWinner(a, b) {
  if (!a) return 'b';
  if (!b) return 'a';
  if (a.sha256 && a.sha256 === b.sha256) return 'equal'; // BAYT EŞİTLİĞİ ÖNCE

  const bothStamped = Number.isFinite(a.rev) && Number.isFinite(b.rev);
  const ar = Number.isFinite(a.rev) ? a.rev : -1;
  const br = Number.isFinite(b.rev) ? b.rev : -1;
  if (bothStamped && ar !== br) return ar > br ? 'a' : 'b';

  const at = a.updated_at ? Date.parse(a.updated_at) : NaN;
  const bt = b.updated_at ? Date.parse(b.updated_at) : NaN;
  const av = Number.isFinite(at) ? at : -1;
  const bv = Number.isFinite(bt) ? bt : -1;
  if (av !== bv) return av > bv ? 'a' : 'b';

  // ÜÇÜNCÜ BASAMAK — döngü kırıcı. Deterministik ve simetrik.
  const as = String(a.sha256 || '');
  const bs = String(b.sha256 || '');
  if (as === bs) return 'equal';
  return as > bs ? 'a' : 'b';
}

/**
 * Uzak satırın gövdesini BAYTA çevir ve `sha256` ile DOĞRULA.
 *
 * Doğrulama sürpriz değil sözleşmedir: `sha256` kolonu DÜZ METİN baytlarının
 * hash'idir (§1.3 yorumu). Uyuşmazsa satır bozuktur ve diske YAZILMAZ —
 * `kind='decode'` çakışması olarak deftere düşer. Sessizce yazmak, bir sonraki
 * taramada "yerel değişmiş" sanılıp geri itilmesine ve sonsuz bir tura yol açardı.
 *
 * @returns {{ok:true, buf:Buffer}|{ok:false, reason:string, detail?:string}}
 */
function decodeBody(row, crypto = nodeCrypto) {
  if (!row || typeof row !== 'object') return { ok: false, reason: 'no-row' };
  if (row.body == null) {
    // Gövde yok: FAZ 2 Storage satırı ya da tombstone. İkisi de "yazacak bayt yok".
    return { ok: false, reason: row.storage_path ? 'storage-body-phase2' : 'null-body' };
  }
  const enc = row.body_encoding === 'base64' ? 'base64' : 'utf8';
  let buf;
  try { buf = Buffer.from(String(row.body), enc); } catch (err) { return { ok: false, reason: 'decode-failed', detail: String(err && err.message) }; }
  const got = sha256Of(buf, crypto);
  if (row.sha256 && got !== row.sha256) {
    return { ok: false, reason: 'sha-mismatch', detail: `beklenen ${row.sha256}, hesaplanan ${got}` };
  }
  if (Number.isFinite(row.size_bytes) && row.size_bytes !== buf.length) {
    return { ok: false, reason: 'size-mismatch', detail: `beklenen ${row.size_bytes}, gerçek ${buf.length}` };
  }
  return { ok: true, buf };
}

/**
 * Yerel baytı satır gövdesine çevir (§4.4 — DÖNÜŞTÜRME YOK, yalnız TAŞIMA).
 * CRLF -> LF gibi bir "iyileştirme" YAPILMAZ: hash ham bayta bağlıdır, dönüştürmek
 * iki cihazı sonsuza dek birbirine iterdi.
 */
function encodeBody(buf, encoding) {
  const enc = encoding === 'base64' ? 'base64' : 'utf8';
  const body = buf.toString(enc);
  return { body, encoding: enc, tooLarge: Buffer.byteLength(body, 'utf8') > INLINE_BODY_MAX };
}

/** Kaybeden gövde deftere sığıyor mu? Sığmıyorsa YALNIZ sha durur (§3.2 kurtarma notu). */
function loserBodyFor(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  const s = buf.toString('utf8');
  if (Buffer.byteLength(s, 'utf8') > LOSER_BODY_MAX) return null;
  if (s.includes('\u0000')) return null; // `text` kolonu NUL taşıyamaz (§12.9 ölçümü)
  return s;
}

/**
 * ZEMİN MUTABAKATI (§2.5) — dosya sürümü.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NEDEN `deltaCore.planReconcile` YETMEZ
 * ═════════════════════════════════════════════════════════════════════════════
 * O fonksiyon SATIR kimliğiyle (id) çalışır ve "bizde var, sunucuda yok = DROP"
 * der. Dosyada bu ÇIKARIM YANLIŞTIR: yerelde olup sunucuda olmayan bir dosya iki
 * ayrı şey olabilir —
 *     (a) uzakta SİLİNDİ (tombstone perdesi arkasında)  -> yerelde de silinmeli
 *     (b) HİÇ YÜKLENMEDİ (yeni yazılmış)                -> yüklenmeli
 * Ayrımı yapan tek şey DEFTERdir (`ledger`): daha önce senkronladığımız satırın
 * id'sini biliyoruz. Defterdeki bir yol manifestten düştüyse (a); defterde hiç
 * yoksa (b). Defter olmadan senkron, yeni yazılan her dosyayı silerdi.
 *
 * ÜÇÜNCÜ DURUM — uzakta silindi AMA yerelde o silmeden sonra DEĞİŞTİ:
 * yerel sha, defterdeki sha'dan farklıdır. O dosya SİLİNMEZ, yeniden YÜKLENİR.
 * Gerekçe: kullanıcı az önce yazdı; "başka bir cihaz dün sildi" diye bugünkü
 * yazımı çöpe atmak sessiz veri kaybıdır.
 *
 * @param {{ledger:Object, manifest:Array, localByKey:Object, keyOf:Function}} input
 * @returns {{pull:Array, deleteLocal:Array, push:Array, ledgerDrop:Array}}
 */
function planFileReconcile(input = {}) {
  const ledger = input.ledger && typeof input.ledger === 'object' ? input.ledger : {};
  const manifest = Array.isArray(input.manifest) ? input.manifest : [];
  const localByKey = input.localByKey && typeof input.localByKey === 'object' ? input.localByKey : {};
  const keyOf = typeof input.keyOf === 'function' ? input.keyOf : (c, p) => `${c}|${p}`;

  const pull = [];
  const deleteLocal = [];
  const push = [];
  const ledgerDrop = [];
  const serverKeys = new Set();

  for (const row of manifest) {
    if (!row || typeof row.rel_path !== 'string' || typeof row.class !== 'string') continue;
    const key = keyOf(row.class, row.rel_path);
    serverKeys.add(key);
    const local = localByKey[key];
    if (!local || local.sha256 !== row.sha256) {
      pull.push({ key, class: row.class, relPath: row.rel_path, id: row.id, sha256: row.sha256, rev: row.rev, updated_at: row.updated_at });
    }
  }

  for (const key of Object.keys(ledger)) {
    if (serverKeys.has(key)) continue;
    const entry = ledger[key];
    if (!entry || typeof entry.relPath !== 'string') { ledgerDrop.push(key); continue; }
    const local = localByKey[key];
    if (!local) { ledgerDrop.push(key); continue; }          // iki tarafta da yok
    if (local.sha256 === entry.sha256) {
      deleteLocal.push({ key, class: entry.class, relPath: entry.relPath, sha256: local.sha256 });
    } else {
      // Uzakta silindi, YERELDE DEĞİŞTİ -> yerel kazanır, yeniden yüklenir.
      push.push({ key, class: entry.class, relPath: entry.relPath, sha256: local.sha256, reason: 'local-edit-after-remote-delete' });
    }
  }

  for (const key of Object.keys(localByKey)) {
    if (serverKeys.has(key)) continue;
    if (ledger[key]) continue; // yukarıdaki döngü zaten karar verdi
    const sep = key.indexOf('|');
    push.push({
      key,
      class: sep > 0 ? key.slice(0, sep) : null,
      relPath: sep > 0 ? key.slice(sep + 1) : key,
      sha256: localByKey[key].sha256,
      reason: 'never-uploaded',
    });
  }

  return { pull, deleteLocal, push, ledgerDrop };
}

module.exports = {
  SECRET_PATTERNS,
  INLINE_BODY_MAX,
  LOSER_BODY_MAX,
  sha256Of,
  scanSecrets,
  decideWinner,
  decodeBody,
  encodeBody,
  loserBodyFor,
  planFileReconcile,
};
