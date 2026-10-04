'use strict';
// ADP-736 — YEREL (paket-dışı) karakter sprite kütüphanesi.
//
// NEDEN (Eren, ADP-736): "müşteri seti / bizim setimiz ayrımı YAPILAMAZ — ben de
// uygulamayı aynı yerden indiriyorum, silip yeniden kursam avatarlarım gitmiş
// olacak." Doğru: paket TEK ve güvenli set taşır (herkes aynı DMG'yi indirir),
// kişisel/telifli avatarlar PAKETE DEĞİL kullanıcının kendi diskine yazılır:
//
//     ~/.crewpane/sprites/<key>/48x48.png   (+ isteğe bağlı 16x16.png)
//
// Böylece (a) uygulamayı silip yeniden kurmak avatarları SİLMEZ — dizin uygulamanın
// dışında yaşar, (b) biz telifli varlık DAĞITMAYIZ — o dosyalar hiçbir zaman
// DMG'ye girmez, kullanıcının makinesinde durur.
//
// GÜVENLİK: renderer'a ham fs verilmez. Bu modül dizini TARAR, key'i doğrular
// (sadece [a-z0-9._-], path-traversal yok), boyut/sayı tavanı uygular ve PNG'leri
// data-URI olarak döndürür (sheet'ler 3-6 KB; 200 sprite ≈ 1 MB — tek seferlik).
//
// İKİZ: renderer tarafı `src/app/lib/localSprites.ts` (aynı sözleşme, IPC üzerinden).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pngDimensions, resolveSpriteSheet, MAX_MANIFEST_BYTES } = require('./spriteSheetContract.cjs');

const SUBPATH = Object.freeze(['.crewpane', 'sprites']);
const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const MAX_SPRITES = 300;
const MAX_BYTES = 512 * 1024; // tek PNG tavanı (gerçek sheet'ler ~3-6 KB)
const VARIANTS = Object.freeze(['48x48.png', '16x16.png']);

/** Kullanıcı ev dizini — CREWPANE_HOME seam'i (e2e relocation; instancePaths deseni). */
function homeDir(homedir) {
  return homedir || process.env.CREWPANE_HOME || os.homedir();
}

/** Yerel sprite kütüphanesinin mutlak yolu: `<home>/.crewpane/sprites`. */
function localSpritesDir(homedir) {
  return path.join(homeDir(homedir), ...SUBPATH);
}

/** Bir klasör adı geçerli sprite key'i mi? (traversal/garip ad savunması) */
function isValidKey(key) {
  return typeof key === 'string' && KEY_RE.test(key) && !key.includes('..');
}

function readPngDataUrl(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.size === 0 || st.size > MAX_BYTES) return null;
  const buf = fs.readFileSync(file);
  // PNG imza kontrolü — uzantıya değil İÇERİĞE bak (rastgele dosya enjekte edilmesin).
  if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  return `data:image/png;base64,${buf.toString('base64')}`;
}

/**
 * Yerel kütüphaneyi tara.
 * @returns {{dir:string, sprites:Array<{key:string,url48:string,url16:string|null,bytes:number}>, skipped:string[]}}
 *   Dizin yoksa `sprites: []` döner (hata DEĞİL — normal durum).
 */
// selectedKeys is internal package validation scope; the interactive picker keeps its cap.
function listLocalSprites(homedir, selectedKeys = null) {
  const dir = localSpritesDir(homedir);
  const sprites = [];
  const skipped = [];
  const issues = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { dir, sprites, skipped, issues };
  }
  for (const ent of entries) {
    if (selectedKeys && !selectedKeys.has(ent.name)) continue;
    if (!selectedKeys && sprites.length >= MAX_SPRITES) { skipped.push(`(tavan ${MAX_SPRITES} aşıldı)`); break; }
    if (!ent.isDirectory()) continue;
    const key = ent.name;
    if (!isValidKey(key)) { skipped.push(`${key}: geçersiz key`); continue; }
    const [f48, f16] = VARIANTS.map((v) => path.join(dir, key, v));
    let url48 = null;
    try { url48 = fs.existsSync(f48) ? readPngDataUrl(f48) : null; } catch { url48 = null; }
    if (!url48) { skipped.push(`${key}: 48x48.png yok/geçersiz`); continue; }
    let spriteSheet;
    let sheet;
    try {
      const metadataPath = path.join(dir, key, 'sprite.json');
      const st = fs.lstatSync(metadataPath, { throwIfNoEntry: false });
      if (st) {
        if (!st.isFile() || st.size > MAX_MANIFEST_BYTES) throw new Error('Sprite metadata file is invalid or too large');
        spriteSheet = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      }
      const size = pngDimensions(Buffer.from(url48.split(',')[1], 'base64'));
      if (!size) throw new Error('Sprite PNG header could not be read');
      const resolved = resolveSpriteSheet(size.width, size.height, spriteSheet);
      if (!resolved.ok) throw new Error(resolved.error);
      sheet = resolved.layout;
    } catch (error) {
      const reason = error instanceof SyntaxError ? 'Sprite metadata JSON could not be read' : String(error.message);
      skipped.push(`${key}: ${reason}`);
      issues.push({ key, reason });
      continue;
    }
    let url16 = null;
    try { url16 = fs.existsSync(f16) ? readPngDataUrl(f16) : null; } catch { url16 = null; }
    sprites.push({ key, url48, url16, bytes: url48.length, sheet, ...(spriteSheet !== undefined ? { spriteSheet } : {}) });
  }
  sprites.sort((a, b) => a.key.localeCompare(b.key));
  return { dir, sprites, skipped, issues };
}

/** Sadece key listesi (data-URI yükü olmadan; ucuz sağlık kontrolü / testler için). */
function localSpriteKeys(homedir) {
  return listLocalSprites(homedir).sprites.map((s) => s.key);
}

module.exports = {
  SUBPATH,
  MAX_SPRITES,
  MAX_BYTES,
  localSpritesDir,
  isValidKey,
  listLocalSprites,
  localSpriteKeys,
};
