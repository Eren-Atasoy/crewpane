// CrewPane — SK-04 (ADR-SKILL-CENTER Karar 2/4) TASLAK → YAYIN: İNSAN ONAYININ
// TEK UYGULAMA-İÇİ KAPISI.
//
// Bu modül yayın mantığını YENİDEN YAZMAZ. SK-02'nin iki fiilini SIRAYLA çağırır:
//
//   skillStore.publishDraft      → lint + taşı (kopya bırakmaz) + sürüm/onaylayan damgası
//   skillEngineView.reconcile…   → motor görünümlerini (sembolik bağ) kanonikle eşitle
//
// 🔑 NEDEN İKİSİ BİRDEN VE NEDEN BURADA: SK-03'ün okuma katmanı (`skillCenter.cjs`)
// SALT OKUNUR olmaya SÖZ VERDİ — paneli açmak diski değiştirmez, `reconcile` orada
// bilerek çağrılmaz. Ama "yayında" bir depo durumu, "motor görüyor" ise DİSKTEKİ bağ
// durumudur: yalnız `publishDraft` çağıran bir onay düğmesi, kullanıcıya "yayınlandı"
// der ve skill hiçbir ajanda GÖRÜNMEZ. Bu yüzden mutasyon TEK bir yerde, İNSANIN
// açıkça onayladığı bu fiilde toplanır — okuma yolu temiz kalır, yayın eksik kalmaz.
//
// Otomatik yayın YOK: bu fonksiyonun tek çağıranı bir kullanıcı tıklamasıdır (IPC
// `skills:publish`). Ajanların yazma yolu `skillStore.writeDraft`tir ve o yalnız
// `skill-drafts/`e yazabilir.
//
// fs'e Electron üzerinden değil, çağrılan modüller üzerinden dokunur (unit test tmp
// dizinlerle koşar).

'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const skillStore = require('./skillStore.cjs');
const engineView = require('./skillEngineView.cjs');
const secretScan = require('./skillSecretScan.cjs');
const versions = require('./skillVersions.cjs');
const F = require('./skillFormat.cjs');

/**
 * Bir taslağı yayına al (insan onayı).
 *
 * @param {object}  o
 * @param {string}  o.workspaceRoot
 * @param {string}  o.name           taslak adı (slug'lanır)
 * @param {string} [o.reviewedBy]    ONAYLAYAN — çağıran süreçte ÖLÇÜLÜR (renderer'dan
 *                                   gelen bir isme güvenilmez; damga bir kanıttır)
 * @param {string} [o.reviewedAt]    ISO damga
 * @param {boolean}[o.overwrite]     aynı adlı yayın varsa üzerine yaz (ikinci onay)
 * @returns {{ok:boolean, name?:string, dir?:string, file?:string, version?:string,
 *            engines?:object, errors:Array, warnings:Array}}
 *
 * Lint kırmızıysa terfi YOKTUR — `publishDraft` hata döner ve BU FONKSİYON DİSKE
 * DOKUNMADAN çıkar (reconcile hiç çağrılmaz): yarım yayın bırakmayız.
 */
function approveDraft({ workspaceRoot, name, reviewedBy, reviewedAt, overwrite = false, env = process.env, homedir = os.homedir(), codexHome, platform = process.platform } = {}) {
  // ── SK-08 (b) — YAYIN KAPISINDA SIR TARAMASI ───────────────────────────────
  // Yazma boğazı (skillAuthor) zaten tarıyor; burası İKİNCİ ve BAĞIMSIZ halkadır.
  // Neden gerekli: taslak dosyası diskte DÜZ METİNDİR — kullanıcı (ya da bir ajan)
  // `.crewpane/skill-drafts/<ad>/SKILL.md`'i elle düzenleyip boğazı hiç çağırmadan
  // içine jeton koyabilir. Yayın = o metni tüm ajanların bağlamına dağıtmaktır, yani
  // sızıntının KALICI olduğu an burasıdır. Tarama diskteki GERÇEK metin üzerinde yapılır.
  const draftRec = skillStore.readSkill(workspaceRoot, name, 'draft');
  if (draftRec && draftRec.exists) {
    const scan = secretScan.scanSkillText(draftRec.text);
    if (!scan.ok) {
      return { ok: false, errors: secretScan.toErrors(scan), warnings: [], blockedBy: 'secret-scan' };
    }
  }

  // Geri alma/geçmiş için ÖNCEKİ yayın metnini yayından ÖNCE oku (publishDraft onu ezer).
  const prevPublished = skillStore.readSkill(workspaceRoot, name, 'published');
  const prevText = prevPublished && prevPublished.exists ? prevPublished.text : null;

  const res = skillStore.publishDraft(workspaceRoot, name, { reviewedBy, reviewedAt, overwrite });
  if (!res.ok) {
    return { ok: false, errors: res.errors || [], warnings: res.warnings || [] };
  }

  // ── SK-08 (2) — YAYIN GEÇMİŞİ ──────────────────────────────────────────────
  // 🪤 Defter yazımı yayını GERİ ALMAZ: buradaki bir hata "yayın olmadı" demek değil.
  // Bu yüzden `historyError` AYRI bir alandır ve `ok` HÂLÂ true'dur — yalanı önlemek
  // için hata gizlenmez, ama gerçekleşmiş bir yayın da başarısız gösterilmez.
  let history = null;
  let historyError = null;
  try {
    const publishedText = fs.readFileSync(res.file, 'utf8');
    const rec = versions.recordVersion({
      workspaceRoot,
      name: res.name,
      version: res.version,
      text: publishedText,
      prevText,
      reviewedBy,
      at: reviewedAt,
      action: 'publish',
    });
    if (rec.ok) history = rec.entry;
    else historyError = rec.error;
  } catch (err) {
    historyError = err && err.message ? err.message : String(err);
  }

  // Motor görünümü: yayınlandı ama bağlanamadıysa bunu GİZLEME. Yayın gerçekleşti
  // (dosya taşındı) — dönen kayıt hem onu hem bağın akıbetini taşır ki UI "yayında
  // ama motor görmüyor" hâlini söyleyebilsin.
  let engines = null;
  let engineError = null;
  try {
    engines = engineView.reconcileEngineViews({ workspaceRoot, env, homedir, codexHome, platform });
  } catch (err) {
    engineError = err && err.message ? err.message : String(err);
  }

  return {
    ok: true,
    name: res.name,
    dir: res.dir,
    file: res.file,
    version: res.version,
    engines,
    engineError,
    history,
    historyError,
    errors: [],
    warnings: res.warnings || [],
  };
}

/**
 * SK-08 (2) — GERİ ALMA: yayındaki skilli geçmiş bir sürümüne döndür.
 *
 * 🔑 NEDEN BU FİİL YAYINA DOĞRUDAN YAZABİLİR (ve onay kapısını DELMİYOR):
 * geri almanın hedefi, geçmişte İNSAN ONAYIYLA yayınlanmış bir metindir — defterde
 * ancak `approveDraft` bir kayıt bırakabilir. Yani buradan yayına inen her metin
 * daha önce onaylanmıştır; üstelik fiilin kendisi bir insan tıklamasıdır (IPC
 * `skills:rollback`). Değişmez korunuyor: **yayındaki hiçbir metin onaysız değildir.**
 * Bir ajan bu fiili çağırsa bile yeni bir içerik üretemez, yalnız onaylanmış bir
 * geçmişe döner — bu yüzden `restoredBy` damgası ZORUNLUDUR (kim döndürdü, kanıt).
 *
 * @returns {{ok:boolean, name?:string, version?:string, restoredFrom?:string, errors:Array}}
 */
function rollbackToVersion({ workspaceRoot, name, version, restoredBy, at, env = process.env, homedir = os.homedir(), codexHome, platform = process.platform } = {}) {
  const slug = F.safeName(name);
  const dst = skillStore.skillDir(workspaceRoot, slug, 'published');
  if (!dst) return { ok: false, errors: [{ code: 'no-workspace', message: 'workspaceRoot yok/geçersiz' }] };
  if (!restoredBy) {
    return { ok: false, errors: [{ code: 'restored-by-required', message: 'Geri almayı KİMİN yaptığı kaydedilmeden geri alma yapılmaz' }] };
  }

  const found = versions.readVersionText(workspaceRoot, slug, version);
  if (!found) {
    return { ok: false, errors: [{ code: 'version-missing', message: `Geçmişte böyle bir sürüm yok: ${slug} v${version}` }] };
  }

  // Geçmişteki metin de LİNT'ten geçer: defterdeki bir dosya elle bozulmuş olabilir.
  const check = F.validateSkill({ text: found.text, dirName: slug, entries: [] });
  if (!check.ok) return { ok: false, errors: check.errors, warnings: check.warnings };
  // İkinci halka: geçmiş metin sır taşıyorsa geri alma da YAPILMAZ (o sürüm eski bir
  // tarama kuralından kaçmış olabilir — kural bugünkü kuraldır).
  const scan = secretScan.scanSkillText(found.text);
  if (!scan.ok) return { ok: false, errors: secretScan.toErrors(scan), blockedBy: 'secret-scan' };

  const prev = skillStore.readSkill(workspaceRoot, slug, 'published');
  const prevText = prev && prev.exists ? prev.text : null;
  const iso = at || new Date().toISOString();

  fs.mkdirSync(dst, { recursive: true });
  // Sürüm sayacı GERİ GİTMEZ: "v2'ye dönmek" v2'yi yeniden yayınlamak değil, v2'nin
  // metniyle YENİ bir yayın yapmaktır (aksi hâlde defterde iki farklı v2 olurdu).
  const prevNum = prev && prev.exists && prev.version ? parseInt(prev.version, 10) : 0;
  const nextVersion = String((Number.isFinite(prevNum) && prevNum > 0 ? prevNum : 0) + 1);
  const restamped = found.text.replace(/^(\s*crewpane\.version:).*$/m, `$1 ${nextVersion}`);
  const { atomicWriteFileSync } = require('../../platform/atomicWrite.cjs');
  atomicWriteFileSync(path.join(dst, F.SKILL_FILE), restamped, { encoding: 'utf8' });

  let engines = null;
  let engineError = null;
  try {
    engines = engineView.reconcileEngineViews({ workspaceRoot, env, homedir, codexHome, platform });
  } catch (err) {
    engineError = err && err.message ? err.message : String(err);
  }

  const rec = versions.recordVersion({
    workspaceRoot,
    name: slug,
    version: nextVersion,
    text: restamped,
    prevText,
    reviewedBy: restoredBy,
    at: iso,
    action: 'rollback',
    note: `v${version} sürümüne geri alındı`,
  });

  return {
    ok: true,
    name: slug,
    version: nextVersion,
    restoredFrom: String(version),
    file: path.join(dst, F.SKILL_FILE),
    engines,
    engineError,
    history: rec.ok ? rec.entry : null,
    historyError: rec.ok ? null : rec.error,
    errors: [],
    warnings: check.warnings || [],
  };
}

module.exports = { approveDraft, rollbackToVersion };
