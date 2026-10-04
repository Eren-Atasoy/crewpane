// CrewPane — SK-08 (ADR-SKILL-CENTER §10 SK-08) YAYIN GEÇMİŞİ + GERİ ALMA.
//
// SK-02 sürüm defterini bilerek yazmamıştı ("gerçek geçmiş git'tir"). SK-08'de bu
// gerekçe ÖLÇÜLDÜ ve ÇÜRÜDÜ: bu depoda `.gitignore:67` **`.crewpane/`** satırı var
// → skill dosyaları git'e HİÇ girmiyor. Yani "git log'a bak" cevabı bu üründe boş bir
// cevaptı: yayındaki bir skill değiştiğinde kim/ne zaman/ne değiştirdi sorusunun
// HİÇBİR yerde karşılığı yoktu ve eski sürüme dönmenin yolu da yoktu.
//
//   <workspace>/.crewpane/
//   ├── skills/            YAYINDA (motorlar burayı görür)
//   ├── skill-drafts/      TASLAK
//   └── skill-history/     🆕 SK-08 — YAYIN ANLARININ DEFTERİ (motor yoluna bağlı DEĞİL)
//       └── <ad>/
//           ├── history.json          sürüm kayıtları (kim/ne zaman/ne değişti)
//           └── v<N>-<damga>/SKILL.md o sürümün TAM metni (geri alma kaynağı)
//
// 🔑 NEDEN TAM METİN, "diff" DEĞİL: geri alma bir onarım fiilidir ve onarım anında
// diff zincirini yeniden oynatmak (her halkanın sağlam olmasını ummak) en kırılgan
// yoldur. Sürüm başına tam metin birkaç kilobayt tutar; karşılığında geri alma TEK
// dosya kopyasıdır. `changedLines` yalnız İNSAN İÇİN bir özettir, geri almanın girdisi
// değildir.
//
// 🔴 GEÇMİŞ MOTOR YOLUNA BAĞLANMAZ: `skill-history/` de tıpkı `skill-drafts/` gibi
// hiçbir sembolik bağın hedefi değildir (skillEngineView yalnız `skills/` bağlar).
// Yoksa "eski sürüm" ajanların bağlamına ikinci bir gerçek olarak sızardı.
//
// fs kullanır, Electron'a bağımlı DEĞİL (unit test tmp dizinlerle koşar).

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteFileSync } = require('../../platform/atomicWrite.cjs');
const F = require('./skillFormat.cjs');

const HISTORY_SUBPATH = Object.freeze(['.crewpane', 'skill-history']);
const HISTORY_FILE = 'history.json';

const HISTORY_README =
  '# Yayın geçmişi — motorlara AÇIK DEĞİL\n\n' +
  'Her yayın (ve her geri alma) burada tam metniyle saklanır. Bu dizin hiçbir motor\n' +
  'yoluna bağlanmaz; buradaki bir dosya hiçbir ajanın bağlamına giremez.\n' +
  'Geri alma: Skill Merkezi → sürüm listesi → "Bu sürüme dön" (insan kararı).\n';

function historyRoot(workspaceRoot) {
  const root = typeof workspaceRoot === 'string' && workspaceRoot.trim() ? workspaceRoot : null;
  return root ? path.join(root, ...HISTORY_SUBPATH) : null;
}

/** Bir skillin geçmiş dizini. Kök DIŞINA çıkan ad reddedilir (`../` savunması). */
function skillHistoryDir(workspaceRoot, name) {
  const root = historyRoot(workspaceRoot);
  if (!root) return null;
  const dir = path.join(root, F.safeName(name));
  const rel = path.relative(root, dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return dir;
}

/** Dosya-sistemi için güvenli damga: `2026-08-08T02:15:33.123Z` → `20260808T021533`. */
function stampSlug(iso) {
  const s = String(iso || '').replace(/[-:]/g, '').replace(/\.\d+Z?$/, '').replace(/Z$/, '');
  return /^\d{8}T\d{6}$/.test(s) ? s : String(Date.now());
}

function readHistoryFile(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, HISTORY_FILE), 'utf8'));
    return Array.isArray(j.versions) ? j : { versions: [] };
  } catch {
    return { versions: [] };
  }
}

/**
 * İki metin arasındaki değişimin İNSAN İÇİN özeti. Geri almanın girdisi DEĞİLDİR.
 * Satır kümesi farkı: sıra değişimi "değişiklik" sayılmaz (gürültü olurdu).
 */
function summarizeChange(prevText, nextText) {
  const norm = (t) => String(t == null ? '' : t).split('\n').map((l) => l.trimEnd());
  const a = norm(prevText);
  const b = norm(nextText);
  const countOf = (lines) => {
    const m = new Map();
    for (const l of lines) m.set(l, (m.get(l) || 0) + 1);
    return m;
  };
  const ca = countOf(a);
  const cb = countOf(b);
  let added = 0;
  let removed = 0;
  for (const [l, n] of cb) added += Math.max(0, n - (ca.get(l) || 0));
  for (const [l, n] of ca) removed += Math.max(0, n - (cb.get(l) || 0));
  return { added, removed, changed: added + removed, prevLines: a.length, nextLines: b.length };
}

/**
 * Bir YAYIN ANINI deftere yaz. `skillApprove` bunu yayın BAŞARILI olduktan SONRA çağırır.
 *
 * @param {object} o
 * @param {string} o.workspaceRoot
 * @param {string} o.name
 * @param {string} o.version      yayın sonrası sürüm ("3")
 * @param {string} o.text         YAYINLANAN tam SKILL.md metni
 * @param {string} [o.prevText]   önceki yayın metni (ilk yayında yok) → değişim özeti
 * @param {string} [o.reviewedBy] ONAYLAYAN (kanıt damgası)
 * @param {string} [o.at]         ISO damga
 * @param {'publish'|'rollback'} [o.action]
 * @param {string} [o.note]
 * @returns {{ok:boolean, entry?:object, dir?:string, error?:string}}
 *
 * 🪤 Defter yazımı yayını GERİ ALMAZ: burada bir hata olursa yayın yine gerçekleşmiştir.
 * Bu yüzden çağıran `ok:false`u "yayın başarısız" diye okumamalı — `historyError` olarak
 * taşımalı (skillApprove aynen böyle yapar).
 */
function recordVersion({ workspaceRoot, name, version, text, prevText, reviewedBy, at, action = 'publish', note } = {}) {
  const dir = skillHistoryDir(workspaceRoot, name);
  if (!dir) return { ok: false, error: 'no-workspace' };

  const iso = at || new Date().toISOString();
  const verDir = path.join(dir, `v${String(version)}-${stampSlug(iso)}`);
  try {
    fs.mkdirSync(verDir, { recursive: true });
    const readme = path.join(historyRoot(workspaceRoot), 'README.md');
    if (!fs.existsSync(readme)) atomicWriteFileSync(readme, HISTORY_README, { encoding: 'utf8' });
    atomicWriteFileSync(path.join(verDir, F.SKILL_FILE), String(text == null ? '' : text), { encoding: 'utf8' });

    const hist = readHistoryFile(dir);
    const entry = {
      version: String(version),
      at: iso,
      action,
      reviewedBy: reviewedBy || null,
      path: path.relative(dir, path.join(verDir, F.SKILL_FILE)),
      ...(note ? { note } : {}),
      change: prevText == null ? { added: null, removed: null, changed: null, first: true } : summarizeChange(prevText, text),
    };
    hist.versions.push(entry);
    atomicWriteFileSync(path.join(dir, HISTORY_FILE), `${JSON.stringify(hist, null, 2)}\n`, { encoding: 'utf8' });
    return { ok: true, entry, dir: verDir };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

/**
 * Bir skillin yayın geçmişi — en YENİ önce.
 * @returns {{name:string, versions:Array, count:number}}
 */
function listVersions(workspaceRoot, name) {
  const slug = F.safeName(name);
  const dir = skillHistoryDir(workspaceRoot, slug);
  if (!dir) return { name: slug, versions: [], count: 0 };
  const hist = readHistoryFile(dir);
  const versions = hist.versions
    .slice()
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
    .map((v) => ({ ...v, exists: fs.existsSync(path.join(dir, v.path || '')) }));
  return { name: slug, versions, count: versions.length };
}

/** Bir geçmiş sürümün TAM metni (geri almanın ve "farkı göster"in kaynağı). */
function readVersionText(workspaceRoot, name, version) {
  const slug = F.safeName(name);
  const dir = skillHistoryDir(workspaceRoot, slug);
  if (!dir) return null;
  const hist = readHistoryFile(dir);
  // Aynı sürüm numarası birden çok kez görünebilir (geri alma yeni bir kayıt yazar) →
  // EN YENİSİ değil, o sürümün İLK yazımı doğru kaynaktır: "v2'ye dön" demek
  // "v2 olarak yayınlanan metin" demektir.
  const rows = hist.versions.filter((v) => String(v.version) === String(version));
  if (!rows.length) return null;
  const row = rows.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')))[0];
  try {
    return { text: fs.readFileSync(path.join(dir, row.path), 'utf8'), entry: row };
  } catch {
    return null;
  }
}

module.exports = {
  HISTORY_SUBPATH,
  HISTORY_FILE,
  historyRoot,
  skillHistoryDir,
  stampSlug,
  summarizeChange,
  recordVersion,
  listVersions,
  readVersionText,
};
