'use strict';
/**
 * ADP-737 — Avatar paketi yöneticisi (main process).
 *
 * Sorumluluklar:
 * - Zip paketi aç + manifest doğrula
 * - ~/.crewpane/sprites/<key>/ dizinine PNG'leri yaz (atomik, yol hapsi)
 * - Paket kaldırma (kullanan ajan varsa uyar)
 * - Paket dışa aktarma (kütüphaneden → zip)
 *
 * Senkron: Cihaza özgü (SYNC-KAPSAM cihaz yok → v3 eşdeğerine düşme).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createReadStream, createWriteStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { resolveSpriteSheet, pngDimensions, MAX_MANIFEST_BYTES } = require('./spriteSheetContract.cjs');

const SPRITES_SUBPATH = ['.crewpane', 'sprites'];
const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const MAX_SPRITES = 300;
const MAX_FILE_SIZE = 512 * 1024;

// ── AVATAR-PACK-SAMPLE-01 — SAYFA IZGARASI + ŞEMA DAMGASI NÖBETİ ────────────
//
// ÖLÇÜLDÜ (AVATAR-PACK-SAMPLE-01): doğrulayıcı yalnız PNG İMZASINA bakıyordu.
// 64×64 düz bir PNG "geçerli karakter" sayılıp kuruluyor, hata da uyarı da
// verilmiyordu; arıza ancak OFİSTE görülüyordu — `SpriteFrame` ve
// `PixelOfficeInner` bu dosyayı 3 sütun × 4 satır YÜRÜME IZGARASI olarak
// kırpar (`background-size: 300% 400%`), yani ızgarası olmayan bir görsel
// karakterin çeyreğini gösterir. Kullanıcı "karakter kırık çiziliyor" der ve
// sebebini bilemez. ADP-866 kuralı bunu yasaklar: sessiz kırık kare YOK —
// paket KURULURKEN, sebebi ölçüyle birlikte söylenir.
//
// Sözleşme dosya ADINDAN değil IZGARADAN gelir: `48x48.png` 48×48 piksel
// DEĞİLDİR, 48 mantıksal birimlik KARENİN sayfasıdır (ürünün kendi seti
// 288×384 = 96px kare; 16x16.png 96×128 = 32px kare).
//
// KURAL NEDEN "BÖLÜNEBİLİRLİK", NEDEN "KARE KARE" DEĞİL — ölçüldü: paketli 204
// sprite dosyasının 6'sı kare-OLMAYAN kare taşıyor (`falconwings` 576×384 →
// 192×96 geniş kanat, `hulk` 288×576 → 96×144 uzun) ve ürün bunları DOĞRU
// çiziyor: `registerIdleFrame` kareyi sheet'in GERÇEK boyutundan türetir
// (ADP-097). "Kare kare" şartı koysaydık ürünün KENDİ dışa aktardığı bu
// paketler geri yüklenemezdi. Kapı yalnız ürünün gerçekten dayattığı şeyi
// dayatır: 3 sütun × 4 satıra TAM bölünmek.
const SHEET_COLS = 3;
const SHEET_ROWS = 4;
const MIN_CELL = 16;

// Şema damgası. YOKLUĞU geçerlidir (v1 örtük) — bu alan sonradan doğdu ve eski
// paketleri kırmak yok. VARSA ve tanınmıyorsa paket REDDEDİLİR: tanınmayan bir
// şema, alan adlarının kaymış olabileceği anlamına gelir; onu "bildiğimiz gibi"
// okumak sessizce yanlış paket kurar.
const SUPPORTED_SCHEMA_VERSIONS = new Set(['1', '1.0']);

/** PNG IHDR'den ölçü oku. null = başlık okunamadı (bozuk/kesik dosya). */
function pngSize(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
}

/**
 * Sprite sayfası ızgara sözleşmesini ölç.
 * @returns {string|null} null = uygun; string = insan-okunur sebep (ölçüyle).
 */
function sheetGridProblem(buf) {
  const size = pngSize(buf);
  if (!size) return 'PNG header could not be read';
  const { width, height } = size;
  if (width % SHEET_COLS !== 0 || height % SHEET_ROWS !== 0) {
    return `${width}x${height} is not a ${SHEET_COLS}x${SHEET_ROWS} sheet `
      + `(width must divide by ${SHEET_COLS}, height by ${SHEET_ROWS})`;
  }
  const cellW = width / SHEET_COLS;
  const cellH = height / SHEET_ROWS;
  if (cellW < MIN_CELL || cellH < MIN_CELL) {
    return `${width}x${height} yields ${cellW}x${cellH} frames, minimum is ${MIN_CELL}px per side`;
  }
  return null;
}

function homeDir(homedir) {
  return homedir || process.env.CREWPANE_HOME || os.homedir();
}

function localSpritesDir(homedir) {
  return path.join(homeDir(homedir), ...SPRITES_SUBPATH);
}

function isValidKey(key) {
  return typeof key === 'string' && KEY_RE.test(key) && !key.includes('..');
}

function sanitizePath(base, ...segments) {
  // Yol hapsi: ../.. veya / ile başlayan dizini engelle
  const full = path.normalize(path.join(base, ...segments));
  if (!full.startsWith(base + path.sep) && full !== base) {
    throw new Error(`Path traversal attempt: ${full}`);
  }
  return full;
}

// ── AVATAR-PACK-01 Tur 4 — PAKET DEFTERİ ────────────────────────────────────
//
// NEDEN AYRI BİR DEFTER: karakter PNG'leri ADP-736 kütüphanesinin DÜZ şemasına
// (`~/.crewpane/sprites/<charKey>/48x48.png`) yazılmak ZORUNDA — ofis, seçici
// ve `localSprites.cjs` yalnız o şemayı okur; başka bir yere yazmak "paket
// yüklendi ama ajana atanamıyor / ofiste görünmüyor" demekti (ADP-866 sınıfı).
// Ama o şema paketi TEMSİL EDEMEZ: manifest (ad/yazar/lisans) ve "hangi karakter
// hangi pakete ait" bilgisi kaybolur → "Paketlerim" listesi boş kalır, kaldırma
// ve dışa aktarma çalışamaz. Bu yüzden paket kimliği KÜTÜPHANENİN YANINDA ayrı
// bir deftere yazılır:
//
//     ~/.crewpane/avatar-packages/<pkgKey>.json
//
// Defter sprites dizinin İÇİNDE DEĞİL: orası `localSprites.cjs`in taradığı yer;
// oraya konan her klasör "geçersiz key" olarak atlanır ve her açılışta log'a
// gürültü yazardı.
const PACKAGES_SUBPATH = ['.crewpane', 'avatar-packages'];

function packagesDir(homedir) {
  return path.join(homeDir(homedir), ...PACKAGES_SUBPATH);
}

/** manifest → paket anahtarı (kayıt dosyası adı). `key` yoksa addan türetilir. */
function packageKeyFromManifest(manifest) {
  if (isValidKey(manifest && manifest.key)) return manifest.key;
  const slug = String((manifest && manifest.name) || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (!isValidKey(slug)) {
    throw new Error('manifest.name cannot be turned into a package key');
  }
  return slug;
}

/** Tek paket kaydını oku (bozuksa null). */
function readPackageRecord(homedir, pkgKey) {
  if (!isValidKey(pkgKey)) return null;
  try {
    const file = sanitizePath(packagesDir(homedir), `${pkgKey}.json`);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!rec || typeof rec !== 'object' || !Array.isArray(rec.characters)) return null;
    return rec;
  } catch {
    return null;
  }
}

/** Defterdeki tüm paket anahtarları (dosya adı = anahtar). */
function packageKeys(homedir) {
  try {
    return fs
      .readdirSync(packagesDir(homedir), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => e.name.slice(0, -'.json'.length))
      .filter(isValidKey);
  } catch {
    return [];
  }
}

/**
 * ZIP'i parse et (merkezi dizin + yerel başlık).
 *
 * AVATAR-PACK-01 Tur 4 — İKİ KÖK NEDEN BURADAYDI:
 *  1. Yalnız `method=0` (STORED) destekleniyordu. Ürünün KENDİ dışa aktarımı
 *     (archiver, zlib level 9) DEFLATE yazar → dışa aktar → geri yükle turu
 *     "manifest.json not found" ile ölüyordu. Artık `method=8` inflateRawSync
 *     ile açılır.
 *  2. Boyutlar YEREL başlıktan okunuyordu. Akış halinde yazan üreticiler
 *     (archiver dahil) genel-amaçlı bayrağın 3. bitini kurar ve boyutları
 *     yerel başlıkta 0 bırakır (gerçek değerler veri tanımlayıcısındadır).
 *     Merkezi dizin HER ZAMAN gerçek boyutları taşır → boyutlar oradan okunur.
 *
 * @param zipPath Zip dosyasının yolu
 * @returns { files: Map<filename, Buffer> }
 */
async function extractZipSimple(zipPath) {
  const buffer = fs.readFileSync(zipPath);
  const files = new Map();

  // ZIP merkezi dizin imzası bul (0x504B0506 — end of central directory)
  let pos = buffer.length - 22;
  while (pos >= 0) {
    if (
      buffer[pos] === 0x50 &&
      buffer[pos + 1] === 0x4b &&
      buffer[pos + 2] === 0x05 &&
      buffer[pos + 3] === 0x06
    ) {
      break;
    }
    pos--;
  }

  if (pos < 0) {
    throw new Error('Invalid ZIP file (no central directory signature)');
  }

  const centralDirStart = buffer.readUInt32LE(pos + 16);
  let cdPos = centralDirStart;

  while (cdPos < pos) {
    // Central file header signature (0x504B0102)
    if (
      buffer[cdPos] !== 0x50 ||
      buffer[cdPos + 1] !== 0x4b ||
      buffer[cdPos + 2] !== 0x01 ||
      buffer[cdPos + 3] !== 0x02
    ) {
      break;
    }

    const fileNameLen = buffer.readUInt16LE(cdPos + 28);
    const extraLen = buffer.readUInt16LE(cdPos + 30);
    const commentLen = buffer.readUInt16LE(cdPos + 32);
    const localHeaderOffset = buffer.readUInt32LE(cdPos + 42);

    const fileName = buffer.toString('utf8', cdPos + 46, cdPos + 46 + fileNameLen);

    // Boyut/yöntem MERKEZİ DİZİNDEN (yerel başlık akış modunda 0 taşır).
    const compressionMethod = buffer.readUInt16LE(cdPos + 10);
    const compressedSize = buffer.readUInt32LE(cdPos + 20);
    const uncompressedSize = buffer.readUInt32LE(cdPos + 24);

    // Veri konumu için yalnız yerel başlığın ad/extra uzunlukları gerekir
    // (extra alanı yerelde ve merkezde FARKLI uzunlukta olabilir — bu yüzden
    // merkezdeki `extraLen` ile veri başlangıcı hesaplanamaz).
    const localFileNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
    const fileDataStart = localHeaderOffset + 30 + localFileNameLen + localExtraLen;

    if (compressionMethod === 0) {
      files.set(fileName, buffer.subarray(fileDataStart, fileDataStart + uncompressedSize));
    } else if (compressionMethod === 8) {
      const raw = buffer.subarray(fileDataStart, fileDataStart + compressedSize);
      let inflated;
      try {
        inflated = zlib.inflateRawSync(raw);
      } catch (e) {
        throw new Error(`ZIP entry could not be inflated: ${fileName} (${e.message})`);
      }
      if (uncompressedSize && inflated.length !== uncompressedSize) {
        throw new Error(`ZIP entry size mismatch: ${fileName}`);
      }
      files.set(fileName, inflated);
    } else {
      throw new Error(`Unsupported ZIP compression method ${compressionMethod} for ${fileName}`);
    }

    cdPos += 46 + fileNameLen + extraLen + commentLen;
  }

  return { files };
}

/**
 * Manifest ve karakterleri doğrula.
 * @param zipBuffer Zip buffer
 * @returns { manifest, characters: [{key, src48, src16?, portraitSrc?}], warnings }
 */
async function validatePackage(files) {
  const manifestBuf = files.get('manifest.json');
  if (!manifestBuf) {
    throw new Error('manifest.json not found');
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestBuf.toString('utf8'));
  } catch (e) {
    throw new Error(`manifest.json parse error: ${e.message}`);
  }

  // ŞEMA DAMGASI ÖNCE okunur: tanınmayan bir şemada alan adları kaymış olabilir,
  // o yüzden alanları doğrulamaya kalkmadan dururuz.
  if (manifest.schemaVersion !== undefined && manifest.schemaVersion !== null) {
    const stamp = String(manifest.schemaVersion);
    if (!SUPPORTED_SCHEMA_VERSIONS.has(stamp)) {
      throw new Error(
        `Unsupported manifest schemaVersion "${stamp}" — this version reads schemaVersion 1 `
        + '(a manifest with no schemaVersion field is read as 1).',
      );
    }
  }

  if (!manifest.name || typeof manifest.name !== 'string') {
    throw new Error('manifest.name is required');
  }
  if (!manifest.author || typeof manifest.author !== 'string') {
    throw new Error('manifest.author is required');
  }
  if (!manifest.version || typeof manifest.version !== 'string') {
    throw new Error('manifest.version is required');
  }
  if (!manifest.license || typeof manifest.license !== 'string' || manifest.license.trim() === '') {
    throw new Error('manifest.license is required (copyright notice)');
  }
  if (!Array.isArray(manifest.characters) || manifest.characters.length === 0) {
    throw new Error('manifest.characters array is required');
  }

  const warnings = [];
  const characters = [];
  const seenKeys = new Set();

  for (const char of manifest.characters) {
    if (!isValidKey(char.key)) {
      throw new Error(`Invalid character key: ${char.key}`);
    }
    if (seenKeys.has(char.key)) {
      throw new Error(`Duplicate character key: ${char.key}`);
    }
    seenKeys.add(char.key);

    const file48 = files.get(`characters/${char.key}/48x48.png`);
    if (!file48) {
      throw new Error(`Missing 48x48.png for ${char.key}`);
    }

    // PNG imza kontrolü
    if (file48.length < 8 || file48[0] !== 0x89 || file48[1] !== 0x50 || file48[2] !== 0x4e || file48[3] !== 0x47) {
      throw new Error(`Invalid PNG signature for ${char.key}/48x48.png`);
    }

    if (file48.length > MAX_FILE_SIZE) {
      throw new Error(`File too large: ${char.key}/48x48.png`);
    }

    // IZGARA: imza "PNG mi" der, bu "YÜRÜME SAYFASI mı" der. İkincisi olmadan
    // paket kurulur ama ofiste karakterin çeyreği çizilir (sessiz arıza).
    let gridProblem48 = sheetGridProblem(file48);
    const imageSize = pngDimensions(file48);
    if (!gridProblem48 && char.spriteSheet === undefined) {
      const legacy = imageSize ? resolveSpriteSheet(imageSize.width, imageSize.height) : { ok: false, error: 'Invalid PNG header' };
      if (!legacy.ok) gridProblem48 = legacy.error;
    }
    if (char.spriteSheet !== undefined) {
      if (Buffer.byteLength(JSON.stringify(char.spriteSheet)) > MAX_MANIFEST_BYTES) throw new Error('Sprite metadata is too large');
      const size = pngDimensions(file48);
      const resolved = size ? resolveSpriteSheet(size.width, size.height, char.spriteSheet) : { ok: false, error: 'Invalid PNG header' };
      gridProblem48 = resolved.ok ? null : resolved.error;
    }
    if (gridProblem48) {
      throw new Error(
        `Not a walk sheet: ${char.key}/48x48.png — ${gridProblem48}. `
        + 'Expected a 3x4 walk grid (down/left/right/up x 3 frames), e.g. 288x384 for 96px frames.',
      );
    }

    characters.push({
      key: char.key,
      displayName: char.displayName || char.key,
      tags: char.tags || [],
      files48: file48,
      ...(char.spriteSheet !== undefined ? { spriteSheet: char.spriteSheet } : {}),
    });

    // 16x16 varsa oku ama eklemediyse uyar
    const file16 = files.get(`characters/${char.key}/16x16.png`);
    if (file16) {
      if (file16[0] === 0x89 && file16[1] === 0x50 && file16[2] === 0x4e && file16[3] === 0x47) {
        const gridProblem16 = sheetGridProblem(file16);
        if (gridProblem16) {
          // İSTEĞE BAĞLI dosya → paketi düşürmez; 48'lik sayfadan küçültülür.
          warnings.push(`Not a walk sheet: ${char.key}/16x16.png (${gridProblem16}), skipped`);
        } else if (file16.length <= MAX_FILE_SIZE) {
          characters[characters.length - 1].files16 = file16;
        } else {
          warnings.push(`16x16.png too large for ${char.key}, skipped`);
        }
      } else {
        warnings.push(`Invalid PNG signature for ${char.key}/16x16.png, skipped`);
      }
    }

    // Portrait varsa oku ama eklemediyse uyar
    const filePortrait = files.get(`characters/${char.key}/portrait.png`);
    if (filePortrait) {
      if (
        filePortrait[0] === 0x89 &&
        filePortrait[1] === 0x50 &&
        filePortrait[2] === 0x4e &&
        filePortrait[3] === 0x47
      ) {
        if (filePortrait.length <= MAX_FILE_SIZE) {
          characters[characters.length - 1].filePortrait = filePortrait;
        } else {
          warnings.push(`portrait.png too large for ${char.key}, skipped`);
        }
      } else {
        warnings.push(`Invalid PNG signature for ${char.key}/portrait.png, skipped`);
      }
    }
  }

  return { manifest, characters, warnings };
}

/**
 * Paketi ~/.crewpane/sprites/<key>/ dizinine yaz.
 * @param homeDir Ev dizini
 * @param characters Doğrulanmış karakterler
 */
async function installPackage(homeDir, characters, manifest) {
  const spritesDir = localSpritesDir(homeDir);

  // Dizin oluştur
  fs.mkdirSync(spritesDir, { recursive: true });

  for (const char of characters) {
    const charDir = sanitizePath(spritesDir, char.key);
    fs.mkdirSync(charDir, { recursive: true });

    // 48x48.png yaz
    fs.writeFileSync(path.join(charDir, '48x48.png'), char.files48);
    const metadataPath = path.join(charDir, 'sprite.json');
    if (char.spriteSheet !== undefined) {
      const tempDir = fs.mkdtempSync(path.join(charDir, '.sprite-metadata-'));
      try {
        const tmp = path.join(tempDir, 'sprite.json');
        fs.writeFileSync(tmp, JSON.stringify(char.spriteSheet), { flag: 'wx' });
        fs.renameSync(tmp, metadataPath);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } else if (fs.lstatSync(metadataPath, { throwIfNoEntry: false })) {
      // Explicit legacy package install replaces the previous atlas definition too.
      fs.unlinkSync(metadataPath);
    }

    // 16x16 varsa yaz
    if (char.files16) {
      fs.writeFileSync(path.join(charDir, '16x16.png'), char.files16);
    }

    // portrait varsa yaz
    if (char.filePortrait) {
      fs.writeFileSync(path.join(charDir, 'portrait.png'), char.filePortrait);
    }
  }

  // Paket defterine kaydet (manifest + hangi karakterler bu pakete ait).
  // Karakter BAYTLARI deftere GİRMEZ — tek kaynak sprites dizinidir.
  const pkgKey = packageKeyFromManifest(manifest);
  const dir = packagesDir(homeDir);
  fs.mkdirSync(dir, { recursive: true });
  const record = {
    key: pkgKey,
    manifest: {
      name: manifest.name,
      author: manifest.author,
      version: manifest.version,
      license: manifest.license,
    },
    characters: characters.map((c) => ({ key: c.key, displayName: c.displayName, tags: c.tags || [] })),
    installedAt: new Date().toISOString(),
  };
  const file = sanitizePath(dir, `${pkgKey}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
  fs.renameSync(tmp, file); // atomik: yarım kayıt "paket eksik" gibi görünmesin
  return pkgKey;
}

/**
 * IPC handler — Zip paketi yükle.
 * @param zipPath Zip dosyasının tam yolu
 * @param homeDir (isteğe bağlı) Ev dizini override
 * @returns { ok: boolean, manifest, warnings?, error? }
 */
async function handleInstallPackage(zipPath, homeDir = null) {
  try {
    const { files } = await extractZipSimple(zipPath);
    const { manifest, characters, warnings } = await validatePackage(files);
    const key = await installPackage(homeDir, characters, manifest);

    return {
      ok: true,
      key,
      manifest,
      warnings,
    };
  } catch (e) {
    return {
      ok: false,
      error: e.message,
    };
  }
}

/**
 * Paketi kaldır.
 * @param key Karakter key'i
 * @param homeDir (isteğe bağlı) Ev dizini override
 * @returns { ok: boolean, error? }
 */
function handleRemovePackage(key, homeDir = null) {
  try {
    if (!isValidKey(key)) {
      throw new Error(`Invalid key: ${key}`);
    }

    const spritesDir = localSpritesDir(homeDir);
    const record = readPackageRecord(homeDir, key);

    if (record) {
      // BAŞKA paketin de kullandığı karakter SİLİNMEZ (iki paket aynı anahtarı
      // taşıyabilir; birini kaldırmak diğerini kırık kare bırakamaz).
      const claimedElsewhere = new Set();
      for (const other of packageKeys(homeDir)) {
        if (other === key) continue;
        const rec = readPackageRecord(homeDir, other);
        for (const c of (rec && rec.characters) || []) claimedElsewhere.add(c.key);
      }

      for (const char of record.characters) {
        if (!isValidKey(char.key) || claimedElsewhere.has(char.key)) continue;
        const charDir = sanitizePath(spritesDir, char.key);
        fs.rmSync(charDir, { recursive: true, force: true });
      }
      fs.rmSync(sanitizePath(packagesDir(homeDir), `${key}.json`), { force: true });
      return { ok: true };
    }

    // Defterde kayıt yok → tek bir sprite klasörü kaldırma (ADP-736 kütüphanesi).
    const charDir = sanitizePath(spritesDir, key);
    if (!fs.existsSync(charDir)) {
      throw new Error(`Package not found: ${key}`);
    }

    fs.rmSync(charDir, { recursive: true, force: true });

    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: e.message,
    };
  }
}

/**
 * Yüklü paketleri defterden listele (Ayarlar → Karakterler).
 *
 * Karakter baytları defterde DEĞİL, sprites dizinindedir: dizinde olmayan bir
 * karakter `missing` listesine düşer → UI "Paket Eksik" rozetini gösterir
 * (ADP-866 kuralı: sessizce boş kare YASAK).
 *
 * @param {string|null} homedir Ev dizini (null → os.homedir())
 * @returns {{ ok: boolean, dir: string, packages: object[], skipped: string[], error?: string }}
 */
function listPackages(homedir = null) {
  try {
    const records = packageKeys(homedir).map(key => ({ key, record: readPackageRecord(homedir, key) }));
    const selectedKeys = new Set(records.flatMap(({ record }) => record?.characters.map(c => c.key).filter(isValidKey) ?? []));
    const library = new Map(require('./localSprites.cjs').listLocalSprites(homedir, selectedKeys).sprites.map(s => [s.key, s]));
    const packages = [];
    const skipped = [];

    for (const { key, record } of records) {
      if (!record) {
        skipped.push(key);
        continue;
      }

      const characters = [];
      const missing = [];
      for (const char of record.characters) {
        if (!isValidKey(char.key)) {
          missing.push(String(char.key));
          continue;
        }
        const localSprite = library.get(char.key);
        const src48 = localSprite?.url48 ?? null;
        if (!src48) {
          missing.push(char.key);
          continue;
        }
        characters.push({
          key: char.key,
          displayName: char.displayName || char.key,
          tags: char.tags || [],
          src48,
          sheet: localSprite.sheet,
        });
      }

      packages.push({
        key: record.key || key,
        manifest: record.manifest,
        characters,
        missing,
        installedAt: record.installedAt || null,
      });
    }

    packages.sort((a, b) => a.key.localeCompare(b.key));
    return { ok: true, dir: packagesDir(homedir), packages, skipped };
  } catch (err) {
    return { ok: false, dir: '', packages: [], error: err.message, skipped: [] };
  }
}

/**
 * Paketleri zip olarak dışa aktar.
 *
 * AVATAR-PACK-01 Tur 4 — ÇIKTI ŞEMASI, GİRDİ ŞEMASIYLA AYNI OLMAK ZORUNDA.
 * Önceki sürüm girişleri `<pkgKey>/manifest.json` diye yazıyordu; `validatePackage`
 * ise KÖKTE `manifest.json` arar → ürünün kendi ZIP'i ürüne geri yüklenemiyordu
 * ("manifest.json not found"). Artık kök şema yazılır:
 *
 *     manifest.json
 *     characters/<charKey>/48x48.png  (+ 16x16.png, portrait.png varsa)
 *
 * Birden çok paket seçilirse tek bir BİRLEŞİK manifest üretilir (format tek
 * manifest taşır); lisans satırları paket paket korunur — telif bilgisi
 * dışa aktarımda KAYBOLAMAZ.
 *
 * @param {string[]} keys Paket anahtarları (defterdeki kayıtlar)
 * @param {string|null} homeDir Ev dizini (null → os.homedir())
 * @returns {{ ok: boolean, path?: string, error?: string }}
 */
async function handleExportPackage(keys, homeDirArg = null) {
  let zipPath = null;
  try {
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new Error('No packages to export');
    }

    const archiver = require('archiver');
    const spritesDir = localSpritesDir(homeDirArg);

    // Hangi dosyalar zip'e girecek: ÖNCE topla, sonra yaz. Eksik dosya varsa
    // yarım bir zip diske hiç düşmez.
    const records = [];
    const entries = []; // { src, name }
    const chars = [];   // birleşik manifest için
    const seen = new Set();

    for (const key of keys) {
      if (!isValidKey(key)) throw new Error(`Invalid key: ${key}`);
      const record = readPackageRecord(homeDirArg, key);
      if (!record) throw new Error(`Package not found: ${key}`);
      records.push(record);

      for (const char of record.characters) {
        if (!isValidKey(char.key) || seen.has(char.key)) continue;
        const charDir = sanitizePath(spritesDir, char.key);
        const src48 = path.join(charDir, '48x48.png');
        if (!fs.existsSync(src48)) {
          throw new Error(`Package files missing: ${key}/${char.key}`);
        }
        seen.add(char.key);
        entries.push({ src: src48, name: `characters/${char.key}/48x48.png` });
        for (const extra of ['16x16.png', 'portrait.png']) {
          const p = path.join(charDir, extra);
          if (fs.existsSync(p)) entries.push({ src: p, name: `characters/${char.key}/${extra}` });
        }
        const metadataPath = path.join(charDir, 'sprite.json');
        let spriteSheet;
        const st = fs.lstatSync(metadataPath, { throwIfNoEntry: false });
        if (st) {
          if (!st.isFile() || st.size > MAX_MANIFEST_BYTES) throw new Error(`Invalid sprite metadata for ${char.key}`);
          spriteSheet = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
          const size = pngDimensions(fs.readFileSync(src48));
          const resolved = size ? resolveSpriteSheet(size.width, size.height, spriteSheet) : { ok: false };
          if (!resolved.ok) throw new Error(`Invalid sprite atlas for ${char.key}`);
        }
        chars.push({ key: char.key, displayName: char.displayName || char.key, tags: char.tags || [],
          ...(spriteSheet !== undefined ? { spriteSheet } : {}) });
      }
    }

    if (chars.length === 0) throw new Error('No characters to export');

    const first = records[0].manifest || {};
    const manifest =
      records.length === 1
        ? { schemaVersion: '1', ...first, key: records[0].key, characters: chars }
        : {
            schemaVersion: '1',
            name: records.map((r) => (r.manifest || {}).name).filter(Boolean).join(' + '),
            author: records.map((r) => (r.manifest || {}).author).filter(Boolean).join(', '),
            version: first.version || '1.0.0',
            license: records
              .map((r) => `${(r.manifest || {}).name}: ${(r.manifest || {}).license}`)
              .join(' | '),
            characters: chars,
          };

    // CREWPANE_HOME DİKİŞİNDEN geç: `os.homedir()`i doğrudan çağırmak, izole bir
    // profille koşan e2e'nin (ve ayrı veri kökü kullanan test kopyasının) zip'ini
    // GERÇEK ~/Downloads'a düşürüyordu — ölçüldü (AVATAR-PACK-01 Tur 4, koşu 5).
    const downloadDir = path.join(homeDir(homeDirArg), 'Downloads');
    fs.mkdirSync(downloadDir, { recursive: true });
    zipPath = path.join(downloadDir, `crewpane-avatars-${Date.now()}.zip`);

    const output = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    await new Promise((resolve, reject) => {
      output.on('close', resolve);
      output.on('error', reject);
      archive.on('error', reject);
      archive.pipe(output);
      archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
      for (const e of entries) archive.file(e.src, { name: e.name });
      archive.finalize();
    });

    return { ok: true, path: zipPath, count: chars.length };
  } catch (err) {
    // Yarım kalan zip diskte BIRAKILMAZ — bir dahaki içe aktarma onu bozuk
    // paket sanmasın.
    if (zipPath) { try { fs.rmSync(zipPath, { force: true }); } catch { /* best-effort */ } }
    return { ok: false, error: err.message };
  }
}

module.exports = {
  handleInstallPackage,
  handleRemovePackage,
  handleExportPackage,
  listPackages,
  localSpritesDir,
  packagesDir,
  packageKeyFromManifest,
  // test/seam
  extractZipSimple,
  validatePackage,
  isValidKey,
  pngSize,
  sheetGridProblem,
};
