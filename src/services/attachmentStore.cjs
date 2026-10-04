// BOARD-IMG-2 (Wheeljack) — GÖREV EKİ DEPOSU: içerik-adresli, hesap-kapsamlı, KALICI.
//                            (board: TASK-MT058G0PJT5W3 · BOARD-B1 · tasarım §4/§5)
//
// ═══════════════════════════════════════════════════════════════════════════════
// NE YAPAR
// ═══════════════════════════════════════════════════════════════════════════════
// Bir görsel dosyasını (ya da bayt yığınını) alır, DOĞRULAR, içerik adresiyle diske
// yazar ve satıra yazılacak METADATA'yı döndürür. Baytları DB'ye koymaz: satır
// yalnız metadata + 160px mikro küçük-resim taşır (tasarım §1.3 ölçümü: ~5.9 KB).
//
// ⚠️ BU MODÜL DB'YE YAZMAZ. INSERT'i çağıran yapar — renderer kendi supabase
//    istemcisiyle, MCP kendi PostgREST yoluyla. İkisi de ZATEN bu işi yapıyor
//    (yorum ekleme / görev açma); üçüncü bir DB istemcisi icat etmeyiz.
//
// ═══════════════════════════════════════════════════════════════════════════════
// NEDEN TEK YUTAK (ingest sink)
// ═══════════════════════════════════════════════════════════════════════════════
// Küçük-resim üretimi Electron'un `nativeImage`ini ister; MCP ayrı bir Node
// sürecidir ve onu çağıramaz. İki ayrı ingest yazsaydık iki farklı "geçerli ek"
// tanımı doğardı (biri sha üretir öbürü üretmez, biri MIME'ı uzantıdan okur…).
// Bu yüzden ingest BURADADIR ve MCP köprüden (POST /task-attachment) buraya gelir.
//
// ═══════════════════════════════════════════════════════════════════════════════
// GÜVENLİK SINIRLARI (hepsi yapısal, hepsi ÖLÇÜLEN bir dersin karşılığı)
// ═══════════════════════════════════════════════════════════════════════════════
//   • Tür beyaz listesi UZANTIYA DEĞİL MAGIC BAYTLARA bakar (mobileUploads.cjs'in
//     `sniffImage` duruşu). Çağıranın beyan ettiği ad/mime hiçbir karara girmez.
//   • `taskId` yola girmeden ÖNCE süzülür + çözülen yol kök-kontrolünden geçer →
//     '../..' ile dizin gezme YAPISAL olarak imkânsız (mobileUploads `resolveUpload`).
//   • Boyut tavanı 25 MB (tempImageStore IMG_MAX_BYTES ile aynı sayı).
//   • ⛔ TTL / otomatik silme YOKTUR. WIN-IMG-01 dersi: süreli silme dosyayı
//     kullanıcının altından çeker. Ekler `deleted_at` ile MANTIKSAL silinir;
//     baytlar ancak AÇIK bir "diskten de sil" eylemiyle gider.
//
// Saf + DI: `fs`/`path`/`crypto`/`now`/`makeThumb` enjekte edilebilir → `node --test`
// ile gerçek disk ve Electron olmadan sınanır (tempImageStore.cjs'in kalıbı).

'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const nodeCrypto = require('node:crypto');

/** Depo kökünün hesap kökü altındaki adı — `local_rel_path` bununla başlar. */
const STORE_DIR = 'task-attachments';

/** Tek ek için üst sınır (tempImageStore IMG_MAX_BYTES ile aynı disiplin). */
const MAX_BYTES = 25 * 1024 * 1024;

/** DB'nin `mime` CHECK'i ile BİREBİR aynı küme — ikisi senkron kalmalı. */
const MIME_BY_KIND = Object.freeze({
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
});

const EXT_BY_MIME = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
});

/**
 * MAGIC BAYTLARDAN tür. Uzantı ve çağıranın `type` beyanı BİLEREK okunmaz:
 * ".png" adı taşıyan bir PDF de, "image/png" diyen bir HTML de buradan geçemez.
 * @returns {'png'|'jpeg'|'webp'|'gif'|null}
 */
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('ascii', 0, 3) === 'GIF') return 'gif';
  return null;
}

/**
 * `task_id` yol parçası olmadan ÖNCE süzülür. `tasks.id` çağıran tarafından
 * verilen serbest bir TEXT'tir (`genTaskId()` üretir ama DB zorlamaz) — yani
 * '../../.ssh' de gelebilir. Beyaz liste + uzunluk tavanı; boş kalırsa null.
 */
function safeTaskDir(taskId) {
  const cleaned = String(taskId == null ? '' : taskId)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64);
  return cleaned || null;
}

/** IPC'den gelen yükü (ArrayBuffer / typed array / number[]) Buffer'a çevir. */
function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) return Buffer.from(data);
  return null;
}

/**
 * Ek deposu.
 *
 * @param {object} deps
 *   `root`      — depo kökünün ÜST dizini (hesap kökü). Zorunlu.
 *   `makeThumb` — (buffer, mime) → { dataUrl, width, height } | null. Electron
 *                 tarafında `nativeImage`; testte sahte. Yoksa küçük-resim
 *                 üretilmez ve satır `thumb_data_url: null` ile yazılır (kapak
 *                 yalnız EKLEYEN cihazda görünür — SESSİZ değil, alan boş kalır).
 *   `deviceId`  — `origin_device` etiketi ("baytlar bu cihazda yok" mesajı için).
 *   `fs`,`path`,`crypto`,`log`,`maxBytes` — opsiyonel.
 */
function createAttachmentStore(deps = {}) {
  const fs = deps.fs || nodeFs;
  const path = deps.path || nodePath;
  const crypto = deps.crypto || nodeCrypto;
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const maxBytes = Number.isFinite(deps.maxBytes) ? deps.maxBytes : MAX_BYTES;
  const makeThumb = typeof deps.makeThumb === 'function' ? deps.makeThumb : null;
  const deviceId = typeof deps.deviceId === 'string' && deps.deviceId ? deps.deviceId : null;

  if (!deps.root || typeof deps.root !== 'string') {
    throw new Error('attachmentStore: `root` (hesap kökü) zorunlu');
  }
  const storeRoot = path.join(deps.root, STORE_DIR);

  /** Çözülen yol depo kökünün ALTINDA mı? (traversal nöbeti — tek boğaz.) */
  function withinStore(abs) {
    const base = path.resolve(storeRoot);
    const p = path.resolve(abs);
    return p === base || p.startsWith(base + path.sep);
  }

  /**
   * `local_rel_path` → mutlak yol. Geçersiz/kök-dışı yol için null (renderer'a
   * genel bir dosya oracle'ı AÇILMAZ). Mutlak yol GELİRSE reddedilir: DB'de
   * mutlak yol olmamalı, olan bir satır bayat/şüphelidir.
   */
  function resolveRel(relPath) {
    const rel = String(relPath == null ? '' : relPath).trim();
    if (!rel || path.isAbsolute(rel) || rel.includes('\0')) return null;
    // rel `task-attachments/…` ile başlar → kökün ÜSTÜNE (hesap kökü) eklenir.
    const abs = path.resolve(deps.root, rel);
    return withinStore(abs) ? abs : null;
  }

  /**
   * Bayt yığınını depoya al.
   * @returns {{ok:true, …metadata}|{ok:false, reason:string, detail?:string}}
   */
  function ingestBuffer({ data, taskId, title, kind, source, createdBy } = {}) {
    try {
      const buf = toBuffer(data);
      if (!buf) return { ok: false, reason: 'bad-data' };
      if (buf.length === 0) return { ok: false, reason: 'empty' };
      if (buf.length > maxBytes) {
        return { ok: false, reason: 'too-large', detail: `${buf.length} bayt (tavan ${maxBytes})` };
      }
      const sniffed = sniffImage(buf);
      if (!sniffed) return { ok: false, reason: 'unsupported-type' };
      const mime = MIME_BY_KIND[sniffed];
      const ext = EXT_BY_MIME[mime];

      const dir = safeTaskDir(taskId);
      if (!dir) return { ok: false, reason: 'bad-task-id' };

      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      const relPath = `${STORE_DIR}/${dir}/${sha256}.${ext}`;
      const abs = path.join(storeRoot, dir, `${sha256}.${ext}`);
      if (!withinStore(abs)) return { ok: false, reason: 'bad-task-id' };

      // İÇERİK ADRESLİ: aynı görsel ikinci kez eklenirse tek bayt kümesi kalır.
      // Var olanı YENİDEN YAZMAYIZ — dosya kimliği zaten içeriğidir.
      let reused = false;
      if (fs.existsSync(abs)) {
        reused = true;
      } else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, buf);
      }

      let thumbDataUrl = null;
      let width = null;
      let height = null;
      if (makeThumb) {
        try {
          const t = makeThumb(buf, mime);
          if (t && typeof t.dataUrl === 'string' && t.dataUrl) thumbDataUrl = t.dataUrl;
          if (Number.isFinite(t && t.width) && t.width > 0) width = Math.round(t.width);
          if (Number.isFinite(t && t.height) && t.height > 0) height = Math.round(t.height);
        } catch (err) {
          // Küçük-resim ÜRETİLEMEDİ ≠ ek eklenemedi. Satır yazılır, kapak yalnız
          // bu cihazda görünür. Sessiz değil: sebep log'a düşer.
          log(`[attach] küçük-resim üretilemedi (${err && err.message}) — thumb_data_url boş kalacak`);
        }
      }

      log(`[attach] ${reused ? 'yeniden kullanıldı' : 'yazıldı'}: ${relPath} (${buf.length} bayt, ${mime})`);
      return {
        ok: true,
        reused,
        sha256,
        mime,
        bytes: buf.length,
        width,
        height,
        localRelPath: relPath,
        absPath: abs,
        thumbDataUrl,
        originDevice: deviceId,
        // DB satırının doldurulacak alanları — çağıran bunları AYNEN geçirir.
        title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 200) : null,
        kind: ['screenshot', 'evidence', 'reference', 'other'].includes(kind) ? kind : 'screenshot',
        source: ['user', 'agent', 'mobile', 'import'].includes(source) ? source : 'user',
        createdBy: typeof createdBy === 'string' && createdBy.trim() ? createdBy.trim().slice(0, 80) : null,
      };
    } catch (err) {
      log(`[attach] ingest hatası: ${err && err.message}`);
      return { ok: false, reason: 'write-failed', detail: err && err.message };
    }
  }

  /**
   * Diskteki bir dosyayı depoya AL (KOPYALAR — kaynak dosyaya bağımlılık kurmaz;
   * kullanıcı /tmp'deki çekimi silince ek ölmesin).
   */
  function ingestFile({ sourcePath, taskId, title, kind, source, createdBy } = {}) {
    const src = String(sourcePath == null ? '' : sourcePath).trim();
    if (!src) return { ok: false, reason: 'no-path' };
    let stat;
    try {
      stat = fs.statSync(src);
    } catch {
      return { ok: false, reason: 'not-found', detail: src };
    }
    if (!stat.isFile()) return { ok: false, reason: 'not-a-file', detail: src };
    if (stat.size > maxBytes) {
      return { ok: false, reason: 'too-large', detail: `${stat.size} bayt (tavan ${maxBytes})` };
    }
    let data;
    try {
      data = fs.readFileSync(src);
    } catch (err) {
      return { ok: false, reason: 'unreadable', detail: err && err.message };
    }
    const out = ingestBuffer({
      data,
      taskId,
      // Başlık verilmediyse kaynak dosyanın adı iyi bir varsayılandır (galeri altyazısı).
      title: title || path.basename(src),
      kind,
      source,
      createdBy,
    });
    return out;
  }

  /**
   * `local_rel_path` → data-URI (renderer'a fs AÇILMAZ; localSprites.cjs deseni).
   * Baytlar bu cihazda yoksa `ok:false, reason:'missing'` — SESSİZCE boş dönmez,
   * çünkü UI'ın "bu cihazda yok (kaynak: …)" diyebilmesi için sebebi bilmesi gerekir.
   */
  function readDataUrl(relPath) {
    const abs = resolveRel(relPath);
    if (!abs) return { ok: false, reason: 'bad-path' };
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      return { ok: false, reason: 'missing' };
    }
    const sniffed = sniffImage(buf);
    if (!sniffed) return { ok: false, reason: 'unsupported-type' };
    const mime = MIME_BY_KIND[sniffed];
    return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}`, mime, bytes: buf.length };
  }

  /** Baytlar bu cihazda var mı? (UI'ın "tam çözünürlük burada" kararı.) */
  function hasBytes(relPath) {
    const abs = resolveRel(relPath);
    if (!abs) return false;
    try {
      return fs.statSync(abs).isFile();
    } catch {
      return false;
    }
  }

  /**
   * BAYTLARI DİSKTEN SİL — yalnız AÇIK bir kullanıcı eylemiyle çağrılır.
   * Satırın kendisi (tombstone) çağıranın işidir; bu yalnız dosyayı kaldırır.
   */
  function removeBytes(relPath) {
    const abs = resolveRel(relPath);
    if (!abs) return { ok: false, reason: 'bad-path' };
    try {
      fs.rmSync(abs, { force: true });
      log(`[attach] baytlar silindi: ${relPath}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: 'remove-failed', detail: err && err.message };
    }
  }

  return {
    root: storeRoot,
    ingestBuffer,
    ingestFile,
    readDataUrl,
    hasBytes,
    removeBytes,
    resolveRel,
  };
}

module.exports = {
  createAttachmentStore,
  sniffImage,
  safeTaskDir,
  toBuffer,
  STORE_DIR,
  MAX_BYTES,
  MIME_BY_KIND,
  EXT_BY_MIME,
};
