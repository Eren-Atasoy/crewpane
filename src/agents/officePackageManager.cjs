'use strict';
/**
 * STARTER-OFFICE-01 — Ofis paketi (.crewpane-office.zip) main-process yöneticisi.
 *
 * SORUMLULUK SINIRI (bilerek dar):
 *   • Bu modül ZIP KABUĞUdur — dosyayı yazar/okur, yol hapsini ve boyut tavanını
 *     uygular, skill gövdelerinin sha256'sını DOĞRULAR.
 *   • ŞEMA DOĞRULAMASI burada DEĞİL: tek gerçek `src/app/lib/officePack.ts`
 *     (`validateOfficePack`) — saf TS leaf, `node --test` ile koşulur ve renderer
 *     ile AYNI kodu çalıştırır. İki yerde iki ayrı şema kapısı = iki ayrı gerçek.
 *     Burada yalnız "bu dosya bir ofis paketi mi" düzeyinde ucuz bir ön eleme var.
 *
 * ⚠️ SIR YAZMAZ / OKUMAZ: paket JSON'u renderer'dan GELDİĞİ GİBİ yazılır; bu modül
 * hiçbir ortam değişkenini, anahtar dosyasını ya da ayar deposunu okumaz.
 *
 * ⚠️ CREWPANE_HOME DİKİŞİ: çıktı `<home>/Downloads` altına düşer ve `home`
 * `CREWPANE_HOME`u ÖNCELER — izole profille koşan e2e'nin zip'i GERÇEK ~/Downloads'a
 * düşmesin (AVATAR-PACK-01 Tur 4'te ölçülen arıza).
 *
 * GERİ ALMA: bu modül yalnız DOSYA üretir/okur; kurulum yapmaz. "Geri alma" =
 * üretilen zip'i silmek. Yarım kalan zip hata yolunda diskte BIRAKILMAZ.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createWriteStream } = require('node:fs');
const { extractZipSimple } = require('./avatarPackageManager.cjs');

const FORMAT = 'crewpane-office-pack';
const FORMAT_VERSION = 1;
const MANIFEST = 'office-pack.json';
const SKILLS_DIR = 'skills';
const EXT = '.crewpane-office.zip';

const MAX_ZIP_BYTES = 8 * 1024 * 1024;      // 8 MB — paket METİNDİR, bayt taşımaz
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_SKILL_BYTES = 256 * 1024;         // 256 KB / SKILL.md
const MAX_SKILLS = 100;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function homeDir(homedirArg) {
  return homedirArg || process.env.CREWPANE_HOME || os.homedir();
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Zip girdisi kökten ÇIKAMAZ ve beklenen şemayı izlemek zorunda. */
function safeSkillEntry(name) {
  if (typeof name !== 'string') return null;
  if (name.includes('..') || name.startsWith('/') || name.includes('\\')) return null;
  const m = /^skills\/([a-z0-9][a-z0-9-]{0,63})\/SKILL\.md$/.exec(name);
  return m ? m[1] : null;
}

/** Dosya adında kullanılabilir ASCII parça (paket adından türetilir). */
function fileSlug(input) {
  return String(input || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'office';
}

/**
 * Ofis paketini zip olarak yazar.
 *
 * @param {object} pack        Renderer'ın ÜRETTİĞİ ve TEMİZLEDİĞİ paket nesnesi.
 * @param {Array<{name:string,text:string}>} skillBodies  SKILL.md gövdeleri.
 * @param {{homeDir?:string|null, outDir?:string|null}} opts
 * @returns {Promise<{ok:boolean, path?:string, bytes?:number, sha256?:string, error?:string}>}
 */
async function handleExportOfficePack(pack, skillBodies = [], opts = {}) {
  let zipPath = null;
  try {
    if (!pack || typeof pack !== 'object' || Array.isArray(pack)) {
      throw new Error('Paket nesnesi gerekli');
    }
    if (pack.format !== FORMAT || pack.formatVersion !== FORMAT_VERSION) {
      throw new Error(`Beklenmeyen paket biçimi (${String(pack.format)} v${String(pack.formatVersion)})`);
    }
    if (!pack.meta || !String(pack.meta.license || '').trim()) {
      throw new Error('Lisans alanı zorunlu');
    }
    if (!Array.isArray(pack.teams) || pack.teams.length === 0) {
      throw new Error('Pakette en az bir takım olmalı');
    }

    const bodies = Array.isArray(skillBodies) ? skillBodies : [];
    if (bodies.length > MAX_SKILLS) throw new Error(`Çok fazla skill (${bodies.length})`);

    // Manifest'in `skills[]` kaydı GÖVDELERLE birebir uyuşmak zorunda — yoksa
    // içe aktarım "yolu var ama dosyası yok" diye yarım paket görür.
    const declared = Array.isArray(pack.skills) ? pack.skills : [];
    const bodyByName = new Map();
    for (const b of bodies) {
      if (!b || !NAME_RE.test(String(b.name || ''))) throw new Error(`Geçersiz skill adı: ${b && b.name}`);
      const text = String(b.text ?? '');
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > MAX_SKILL_BYTES) throw new Error(`Skill çok büyük: ${b.name} (${bytes})`);
      bodyByName.set(b.name, text);
    }
    for (const d of declared) {
      if (!bodyByName.has(d.name)) throw new Error(`Skill gövdesi eksik: ${d.name}`);
      const text = bodyByName.get(d.name);
      const actual = sha256(Buffer.from(text, 'utf8'));
      if (d.sha256 && d.sha256.toLowerCase() !== actual) {
        throw new Error(`Skill sha256 uyuşmuyor: ${d.name}`);
      }
    }

    const manifestText = JSON.stringify(pack, null, 2);
    if (Buffer.byteLength(manifestText, 'utf8') > MAX_MANIFEST_BYTES) {
      throw new Error('Paket manifesti çok büyük');
    }

    const outDir = opts.outDir || path.join(homeDir(opts.homeDir), 'Downloads');
    fs.mkdirSync(outDir, { recursive: true });
    zipPath = path.join(outDir, `${fileSlug(pack.meta.name)}-${Date.now()}${EXT}`);

    const archiver = require('archiver');
    const output = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    await new Promise((resolve, reject) => {
      output.on('close', resolve);
      output.on('error', reject);
      archive.on('error', reject);
      archive.pipe(output);
      archive.append(manifestText, { name: MANIFEST });
      for (const d of declared) {
        archive.append(bodyByName.get(d.name), { name: `${SKILLS_DIR}/${d.name}/SKILL.md` });
      }
      archive.finalize();
    });

    const bytes = fs.statSync(zipPath).size;
    return { ok: true, path: zipPath, bytes, sha256: sha256(fs.readFileSync(zipPath)) };
  } catch (err) {
    // Yarım zip diskte BIRAKILMAZ — bir sonraki içe aktarım onu bozuk paket sanmasın.
    if (zipPath) { try { fs.rmSync(zipPath, { force: true }); } catch { /* best-effort */ } }
    return { ok: false, error: err.message };
  }
}

/**
 * Zip'i okur, manifesti ayrıştırır, skill gövdelerini sha256 ile DOĞRULAR.
 * ŞEMAYI doğrulamaz (o iş renderer'ın `validateOfficePack`ıdır) — burada yalnız
 * "açılabilir mi, kökten çıkan girdi var mı, gövde manifeste uyuyor mu".
 *
 * @returns {Promise<{ok:boolean, pack?:object, skills?:Array, warnings?:string[], error?:string}>}
 */
async function handleReadOfficePack(zipPath) {
  try {
    if (!zipPath || typeof zipPath !== 'string') throw new Error('Dosya yolu gerekli');
    const stat = fs.statSync(zipPath);
    if (stat.size > MAX_ZIP_BYTES) throw new Error(`Paket çok büyük (${stat.size} > ${MAX_ZIP_BYTES})`);

    // ⚠️ `extractZipSimple` bir **Map** döner (düz nesne değil) — düz nesne gibi
    // okumak her girdiyi "yok" gösterir ve paket sessizce boş görünür.
    const { files } = await extractZipSimple(zipPath);
    const manifestBuf = files.get(MANIFEST);
    if (!manifestBuf) throw new Error(`${MANIFEST} bulunamadı — bu bir CrewPane ofis paketi değil`);
    if (manifestBuf.length > MAX_MANIFEST_BYTES) throw new Error('Paket manifesti çok büyük');

    let pack;
    try {
      pack = JSON.parse(manifestBuf.toString('utf8'));
    } catch (e) {
      throw new Error(`Paket manifesti okunamadı: ${e.message}`);
    }
    if (!pack || pack.format !== FORMAT) {
      throw new Error('Bu dosya bir CrewPane ofis paketi değil');
    }

    const warnings = [];
    const declared = Array.isArray(pack.skills) ? pack.skills : [];
    const declaredByName = new Map(declared.map((d) => [d.name, d]));
    const skills = [];
    for (const [entryName, buf] of files) {
      if (entryName === MANIFEST) continue;
      const skillName = safeSkillEntry(entryName);
      if (!skillName) {
        // Beklenmeyen/GÜVENSİZ girdi SESSİZCE atlanmaz — kullanıcı görsün.
        warnings.push(`Pakette beklenmeyen dosya atlandı: ${entryName}`);
        continue;
      }
      if (buf.length > MAX_SKILL_BYTES) {
        warnings.push(`Skill çok büyük, atlandı: ${skillName}`);
        continue;
      }
      const text = buf.toString('utf8');
      const actual = sha256(buf);
      const decl = declaredByName.get(skillName);
      if (!decl) {
        warnings.push(`Manifestte yazmayan skill atlandı: ${skillName}`);
        continue;
      }
      if (String(decl.sha256 || '').toLowerCase() !== actual) {
        // BOZUK/DEĞİŞTİRİLMİŞ gövde KURULMAZ — sessiz kabul, imzayı anlamsız kılar.
        warnings.push(`Skill özeti uyuşmuyor, atlandı: ${skillName}`);
        continue;
      }
      skills.push({ name: skillName, text, sha256: actual, bytes: buf.length });
    }
    for (const d of declared) {
      if (!skills.some((s) => s.name === d.name)) {
        warnings.push(`Manifestte yazan skill pakette yok: ${d.name}`);
      }
    }

    return { ok: true, pack, skills, warnings };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  handleExportOfficePack,
  handleReadOfficePack,
  // test/dikiş
  fileSlug,
  safeSkillEntry,
  sha256,
  FORMAT,
  FORMAT_VERSION,
  MANIFEST,
  EXT,
};
