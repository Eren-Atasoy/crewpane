// CrewPane — B-01 Faz A: BRANCH ADI TÜRETME + DOĞRULAMA (GIT-BACKBONE-SPEC §2.3, K3).
//
// branch = `task/<kod-slug>`  →  `task/b-01k`, `task/adp-927`, `task/task-msosasha4hpbw`
//
// ─────────────────────────────────────────────────────────────────────────────
// NEDEN DOĞRULAMA BU KADAR SERT (G-2: argüman enjeksiyonu)
// ─────────────────────────────────────────────────────────────────────────────
// Üretilen ad birazdan `execFile('git', ['worktree','add','-b', <ad>, …])` argümanı
// olacak. Kabuk yok, yani `;`/`|` zararsız — ama GIT'İN KENDİ argüman ayrıştırıcısı
// hâlâ bir yüzeydir: `-` ile başlayan bir değer git tarafından BAYRAK sanılır
// (`--upload-pack=…` sınıfı). Bu yüzden:
//   • ad `^task/[a-z0-9][a-z0-9._-]{0,60}$` regex'inden geçmek ZORUNDA (baş karakter
//     harf/rakam → `-` ile başlayamaz),
//   • ayrıca git'in KENDİ ref kurallarını (git-check-ref-format) SAF olarak uygularız
//     (`..`, `@{`, boşluk, kontrol karakteri, `.lock` soneki, `//`, sonu `.`/`/`),
//   • ve çağıran istersе gerçek `git check-ref-format --branch`'i ENJEKTE eder
//     (`opts.checkRefFormat`) — modül fs/child_process bilmez, saf kalır.
//
// Üç kat aynı şeyi kontrol ediyor gibi görünüyor; öyle DEĞİL: regex bizim ad
// politikamız, saf ref kuralları git'in gramerinin kopyası, enjekte edilen çağrı ise
// GERÇEK git'in hükmü. İlk ikisi test edilebilir, üçüncüsü sürüm farklarını yakalar.
//
// SAF: `taskCode.cjs` dışında bağımlılık yok → `node --test` doğrudan koşar.

'use strict';

const taskCode = require('../agents/taskCode.cjs');

/** Branch ön eki — TEK yerde. Değişirse eski branch'ler yetim kalır, bilerek sabit. */
const BRANCH_PREFIX = 'task/';

/** Ad politikası (§2.3). Baş karakter harf/rakam → git argümanı olarak asla bayrak değil. */
const BRANCH_RE = /^task\/[a-z0-9][a-z0-9._-]{0,60}$/;

/** Çakışmada denenecek sonek üst sınırı (§2.3: `-2`..`-10`, sonra hata). */
const MAX_SUFFIX = 10;

/**
 * git-check-ref-format kurallarının SAF kopyası (bizim dar alfabemizde geçerli olan
 * alt küme). Dönen değer: hata dizesi ya da null (geçerli).
 */
function refFormatError(name) {
  if (typeof name !== 'string' || !name) return 'boş ad';
  if (name.length > 200) return 'ad çok uzun';
  if (name.startsWith('-')) return "'-' ile başlıyor (git argümanı olarak bayrak sanılır)";
  if (name.startsWith('/') || name.endsWith('/')) return "'/' ile başlıyor/bitiyor";
  if (name.endsWith('.')) return "'.' ile bitiyor";
  if (name.endsWith('.lock')) return "'.lock' ile bitiyor";
  if (name.includes('..')) return "'..' içeriyor";
  if (name.includes('//')) return "'//' içeriyor";
  if (name.includes('@{')) return "'@{' içeriyor";
  if (name === '@') return "yalnız '@'";
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return 'yasak karakter (boşluk/kontrol/~^:?*[\\)';
  for (const seg of name.split('/')) {
    if (!seg) return 'boş yol parçası';
    if (seg.startsWith('.')) return "yol parçası '.' ile başlıyor";
    if (seg.endsWith('.lock')) return "yol parçası '.lock' ile bitiyor";
  }
  return null;
}

/**
 * Bir branch adı BİZİM politikamıza ve git gramerine uyuyor mu? (SAF)
 *
 * @param {unknown} name
 * @param {{checkRefFormat?: (name:string)=>boolean}} [opts] gerçek git doğrulayıcı (enjekte)
 * @returns {{ok:true, name:string} | {ok:false, why:string}}
 */
function validateBranchName(name, opts = {}) {
  if (typeof name !== 'string' || !name) return { ok: false, why: 'branch adı boş' };
  if (!BRANCH_RE.test(name)) {
    return { ok: false, why: `politika dışı ad: ${JSON.stringify(name)} (beklenen ${BRANCH_RE})` };
  }
  const refErr = refFormatError(name);
  if (refErr) return { ok: false, why: `git ref kuralı: ${refErr}` };
  if (typeof opts.checkRefFormat === 'function') {
    let ok = false;
    try {
      ok = opts.checkRefFormat(name) === true;
    } catch {
      ok = false; // git çağrısı patladıysa GEÇİRME (fail-closed)
    }
    if (!ok) return { ok: false, why: 'git check-ref-format --branch reddetti' };
  }
  return { ok: true, name };
}

/**
 * Görev kodundan branch adı türet (SAF). Kod çıkarılamaz/geçersizse null döner —
 * "bir şey uydur" YOK: adsız görev izole KOŞMAZ (fail-closed, §2.1 ilke 3).
 *
 * @param {unknown} code `taskCode.taskCodeOf` çıktısı ya da ham kod
 * @returns {string|null} `task/b-01k`
 */
function branchNameFor(code) {
  const slug = taskCode.codeSlug(code);
  if (!slug) return null;
  const name = BRANCH_PREFIX + slug;
  return BRANCH_RE.test(name) && !refFormatError(name) ? name : null;
}

/** Etiketten doğrudan branch adı (kod çıkarımı + türetme tek çağrıda). */
function branchNameForLabel(label) {
  return branchNameFor(taskCode.taskCodeOf(label));
}

/**
 * ÇAKIŞMA ÇÖZÜMÜ (§2.3 / H-6) — SAF.
 *
 * Kural: ref zaten varsa ve deftere göre BAŞKA göreve aitse `-2`, `-3` … denenir;
 * AYNI göreve aitse ad OLDUĞU GİBİ yeniden kullanılır (yeni branch açmak, ajanın
 * kendi işini ikinci bir dala bölmek olurdu — H-6).
 *
 * @param {unknown} code görev kodu
 * @param {{
 *   exists?: (branch:string)=>boolean,   // ref var mı (git)
 *   ownerOf?: (branch:string)=>string|null, // defterdeki sahip görev id'si
 *   taskId?: string|null,                // bu istek hangi göreve ait
 * }} deps
 * @returns {{ok:true, branch:string, reused:boolean} | {ok:false, why:string}}
 */
function resolveBranchName(code, deps = {}) {
  const base = branchNameFor(code);
  if (!base) return { ok: false, why: `görev kodundan branch adı türetilemedi: ${JSON.stringify(code)}` };
  const exists = typeof deps.exists === 'function' ? deps.exists : () => false;
  const ownerOf = typeof deps.ownerOf === 'function' ? deps.ownerOf : () => null;
  const taskId = typeof deps.taskId === 'string' && deps.taskId ? deps.taskId : null;

  for (let i = 1; i <= MAX_SUFFIX; i++) {
    const name = i === 1 ? base : `${base}-${i}`;
    if (!BRANCH_RE.test(name)) break; // sonekle uzunluk taştıysa dur
    let taken = false;
    try {
      taken = exists(name) === true;
    } catch {
      taken = true; // ölçemiyorsak DOLU say (fail-closed): var olan bir dalı ezmek yasak
    }
    if (!taken) return { ok: true, branch: name, reused: false };
    let owner = null;
    try {
      owner = ownerOf(name);
    } catch {
      owner = null;
    }
    if (taskId && owner === taskId) return { ok: true, branch: name, reused: true };
    if (!owner && i === 1 && !taskId) {
      // Sahipsiz mevcut dal + görev kimliği bilinmiyor → yeniden kullanmak yerine
      // sonek dene: yabancı bir dala yazmak veri kaybı üretir (H-6).
      continue;
    }
  }
  return {
    ok: false,
    why: `${base} ve ${MAX_SUFFIX - 1} sonek denemesinin hepsi başka göreve ait — elle temizlik gerekir`,
  };
}

module.exports = {
  BRANCH_PREFIX,
  BRANCH_RE,
  MAX_SUFFIX,
  refFormatError,
  validateBranchName,
  branchNameFor,
  branchNameForLabel,
  resolveBranchName,
};
