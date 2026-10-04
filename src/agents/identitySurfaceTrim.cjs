// TOKEN-BUDGET-01 — YÜZEY-KOŞULLU KİMLİK BÖLÜMLERİ.
//
// ÖLÇÜLEN KUSUR. Kimliğin bazı bölümleri "her ajana verilen ortak katman" diye
// KOŞULSUZ ekleniyor, ama anlattıkları YÜZEY o çalışma alanında OLMAYABİLİR.
// En net örneği mobil doğrulama kapısı (`## Mobil doğrulama (DoD):` — 548 karakter,
// ÖLÇÜLDÜ 264 jeton): `cd mobile && npm run mobile:verify` diyor, oysa bu çalışma
// alanının kökünde `mobile/` diye bir dizin YOK. Yani o pane, her isteğinde,
// koşamayacağı bir komutun talimatını taşıyor.
//
// Tek bir müşteride 264 jeton küçük görünür; ürün ölçeğinde değildir: mobil
// uygulaması OLMAYAN her çalışma alanındaki HER pane, HER istekte bunu ödüyor.
//
// ─────────────────────────────────────────────────────────────────────────────
// NEDEN BURADA (main) VE NEDEN METİN AMELİYATI DEĞİL
//
// Kimlik metni renderer'da örülüyor (`src/app/lib/agentIdentity.ts`) ve orada
// dosya sistemi YOK — "bu çalışma alanında mobile/ var mı" sorusu ancak main'de
// cevaplanır. Bu yüzden kesim burada yapılır, ama KÖR BİR `replace` ile değil:
// bölüm sınırları kimliğin KENDİ sözleşmesinden (satır başındaki `## ` başlıkları)
// okunur — `buildIdentitySections`ın ürettiği yapının aynısı. Başlık bulunamazsa
// metin BİR KARAKTER bile değişmez (sessiz bozma yasağı).
//
// KONTROL KOLU: `CREWPANE_IDENTITY_SURFACE_TRIM=off` → hiçbir bölüm düşmez.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const OFF_ENV = 'CREWPANE_IDENTITY_SURFACE_TRIM';

/**
 * Yüzey-koşullu bölümler. `heading` kimliğin kendi başlığıdır (birebir önek),
 * `requiresDir` o bölümü ANLAMLI kılan dizindir (pane cwd'sine ya da çalışma
 * alanı köküne göre aranır — ikisinden birinde varsa bölüm KALIR).
 *
 * ⚠️ Buraya yalnız "yüzey yoksa talimat UYGULANAMAZ" olan bölümler girer.
 * Davranış kuralları (süreç, rapor, protokol, kimlik mührü) ASLA girmez:
 * onlar yüzeyden bağımsızdır ve düşerlerse sessiz kalite kaybı olur.
 */
const SURFACE_SECTIONS = Object.freeze([
  Object.freeze({ key: 'mobile', heading: '## Mobil doğrulama', requiresDir: 'mobile' }),
]);

/** Metni satır başındaki `## ` başlıklarına göre parçala (kimliğin kendi sözleşmesi). */
function splitSections(text) {
  const lines = text.split('\n');
  const marks = [];
  for (let i = 0; i < lines.length; i += 1) if (lines[i].startsWith('## ')) marks.push(i);
  return { lines, marks };
}

/** `dir` bir dizin mi (dosya/DEĞİL/erişilemez → false). */
function hasDir(base, name) {
  if (!base) return false;
  try {
    return fs.statSync(path.join(base, name)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Yüzeyi olmayan bölümleri düşür.
 *
 * @returns {{ text: string, dropped: Array<{key:string, chars:number}> }}
 *   Hiçbir şey düşmediyse `text` GİRDİYLE BİREBİR AYNI nesnedir.
 */
function trimIdentityToSurfaces(text, { cwd, workspaceRoot, env = process.env, log = null } = {}) {
  const out = { text, dropped: [] };
  if (typeof text !== 'string' || !text) return out;
  if (`${(env && env[OFF_ENV]) || ''}`.trim().toLowerCase() === 'off') return out;

  const missing = SURFACE_SECTIONS.filter((s) => !hasDir(cwd, s.requiresDir) && !hasDir(workspaceRoot, s.requiresDir));
  if (!missing.length) return out;

  const { lines, marks } = splitSections(text);
  if (!marks.length) return out;
  const drop = new Set();
  for (const s of missing) {
    const at = marks.findIndex((m) => lines[m].startsWith(s.heading));
    if (at < 0) continue; // başlık yok → bu kimlikte o bölüm zaten yoktu
    const from = marks[at];
    const to = at + 1 < marks.length ? marks[at + 1] : lines.length;
    let chars = 0;
    for (let i = from; i < to; i += 1) {
      drop.add(i);
      chars += lines[i].length + 1;
    }
    out.dropped.push({ key: s.key, chars });
  }
  if (!drop.size) return out;
  out.text = lines.filter((_, i) => !drop.has(i)).join('\n');
  if (typeof log === 'function') {
    log(
      `[identity-surface] düşürüldü: ${out.dropped
        .map((d) => `${d.key} (${d.chars} ch)`)
        .join(', ')} — bu çalışma alanında o yüzey YOK`,
    );
  }
  return out;
}

module.exports = { OFF_ENV, SURFACE_SECTIONS, trimIdentityToSurfaces, splitSections, hasDir };
