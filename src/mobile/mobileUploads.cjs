// ADP-371 — MOBİL GÖRSEL YÜKLEMELERİ (telefon → Mac diski → claude pane'ine yol).
//
// Akış: telefon POST /m/uploads (multipart, command scope) → bu modül baytları
// ~/.crewpane*/mobile-uploads/YYYY-MM-DD/ altına yazar → uploadId döner → telefon
// prompt'a `attachments: [uploadId]` iliştirir → gateway id'yi BURADAN mutlak yola
// çözer → renderer prompt metnine "[Ekli görsel — Read aracıyla aç: <yol>]" ekler →
// claude pane'i görseli Read ile GERÇEKTEN görür (ADP-371 araştırmasında kanıtlandı;
// HEIC Read'de AÇILMAZ → beyaz liste yalnız JPEG/PNG, dönüşüm TELEFONDA yapılır).
//
// GÜVENLİK SINIRLARI (hepsi yapısal):
//   • Tür beyaz listesi UZANTIYA DEĞİL MAGIC BAYTLARA bakar (FFD8FF=JPEG, 8950=PNG) —
//     istemcinin beyan ettiği dosya adı/mime hiçbir karara girmez.
//   • uploadId SUNUCUDA üretilir ve çözümleme regex + path.resolve kök-kontrolüyle
//     yapılır → telefondan gelen id ile dizin gezme (path traversal) imkânsız.
//   • Boyut tavanı MAX_IMAGE_BYTES (gateway okuma sınırıyla aynı kaynak).
//   • Günlük dosya kotası (MAX_FILES_PER_DAY) → disk-doldurma DoS'u kesilir.
//   • Temizlik: KEEP_DAYS'ten eski gün klasörleri silinir (gateway açılışında +
//     periyodik süpürme main'de).

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const instancePaths = require('../config/instancePaths.cjs');

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB ham görsel (telefon zaten ~2048px'e küçültür)
const MAX_ATTACHMENTS = 4; // tek prompt'a iliştirilebilecek görsel sayısı
const KEEP_DAYS = 7; // gün klasörü ömrü
const MAX_FILES_PER_DAY = 100; // disk-doldurma DoS önlemi
const ID_RE = /^u_[a-z0-9]{6,16}_[a-f0-9]{8}\.(jpg|png)$/;

/** Yüklemelerin kökü (instance-farkında: ~/.crewpane · ~/.crewpane-test …). */
function uploadsRoot(homedir) {
  return path.join(instancePaths.crewpaneHome(homedir), 'mobile-uploads');
}

/** Magic baytlardan tür: yalnız claude Read'in AÇABİLDİĞİ türler (HEIC bilerek yok). */
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.readUInt32BE(0) === 0x89504e47) return 'png';
  return null;
}

/** YYYY-MM-DD (yerel gün — temizlik/kota bu klasör adına göre işler). */
function dayName(at) {
  const d = at instanceof Date ? at : new Date(at ?? Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Telefondan gelen görseli diske yaz. Dosya adı SUNUCUDA üretilir (istemcinin
 * fileName'i yalnız audit notu olur, yola asla girmez).
 * @returns {{ok:true, uploadId:string, bytes:number, kind:'jpeg'|'png'}|{ok:false, error:string}}
 */
function saveUpload({ buffer, homedir, at } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { ok: false, error: 'görsel gövdesi boş' };
  if (buffer.length > MAX_IMAGE_BYTES) return { ok: false, error: 'görsel çok büyük (tavan 10MB)' };
  const kind = sniffImage(buffer);
  if (!kind) return { ok: false, error: 'desteklenmeyen görsel türü (yalnız JPEG/PNG; HEIC telefonda JPEG\'e çevrilmeli)' };
  const day = dayName(at);
  const dir = path.join(uploadsRoot(homedir), day);
  fs.mkdirSync(dir, { recursive: true });
  const existing = fs.readdirSync(dir).filter((f) => ID_RE.test(f));
  if (existing.length >= MAX_FILES_PER_DAY) return { ok: false, error: 'günlük yükleme kotası doldu' };
  const stamp = (at instanceof Date ? at.getTime() : Number(at) || Date.now()).toString(36);
  const uploadId = `u_${stamp}_${crypto.randomBytes(4).toString('hex')}.${kind === 'jpeg' ? 'jpg' : 'png'}`;
  fs.writeFileSync(path.join(dir, uploadId), buffer);
  return { ok: true, uploadId, bytes: buffer.length, kind };
}

/**
 * uploadId → mutlak dosya yolu (yoksa/geçersizse null). Regex + kök-kontrolü:
 * id yalnız sunucunun ürettiği biçimde olabilir, çözülen yol uploads kökünün
 * DIŞINA çıkamaz (path traversal yapısal olarak imkânsız).
 */
function resolveUpload(uploadId, { homedir } = {}) {
  const id = String(uploadId ?? '').trim();
  if (!ID_RE.test(id)) return null;
  const root = uploadsRoot(homedir);
  let days = [];
  try {
    days = fs.readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  } catch {
    return null; // kök yok → hiç yükleme yapılmamış
  }
  for (const day of days.sort().reverse()) {
    const file = path.resolve(root, day, id);
    if (!file.startsWith(root + path.sep)) return null; // kemer-askı: kök dışına asla
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/** KEEP_DAYS'ten eski gün klasörlerini sil. @returns silinen klasör sayısı */
function sweepUploads({ homedir, now } = {}) {
  const root = uploadsRoot(homedir);
  let days = [];
  try {
    days = fs.readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  } catch {
    return 0;
  }
  const cutoff = dayName(new Date((now ?? Date.now()) - KEEP_DAYS * 24 * 60 * 60 * 1000));
  let removed = 0;
  for (const day of days) {
    if (day >= cutoff) continue; // sözlük sırası = tarih sırası (YYYY-MM-DD)
    try {
      fs.rmSync(path.join(root, day), { recursive: true, force: true });
      removed++;
    } catch {
      /* kilitli dosya vs. → bir sonraki süpürmede tekrar denenir */
    }
  }
  return removed;
}

module.exports = {
  MAX_IMAGE_BYTES,
  MAX_ATTACHMENTS,
  KEEP_DAYS,
  MAX_FILES_PER_DAY,
  uploadsRoot,
  sniffImage,
  saveUpload,
  resolveUpload,
  sweepUploads,
};
