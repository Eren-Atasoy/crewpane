// CrewPane — ADP-735: KANIT YOLU ÇOKLU-ADAY ÇÖZÜMÜ.
//
// ─────────────────────────────────────────────────────────────────────────────
// KÖK NEDEN (2026-07-29 canlı defterinden ölçüldü)
// ─────────────────────────────────────────────────────────────────────────────
// Kanıt yolu TEK bir köke çözülüyordu (main.js dlgsup:record):
//     base = rec.cwd || pane.cwd || agentWorkspaceRoot || REPO_ROOT
// Kurulu makinede bu köklerin HEPSİ workspace PARENT'ı ("CrewPane Apps"), çünkü
// `DEPARTMENT_SUBPATH.crewpane = []` (departmentDirs.cjs) → crewpane pane'i
// workspace kökünde açılır (live-panes.json: her pane cwd = ".../CrewPane Apps").
// Worker ise raporunu ofis konvansiyonuna göre ALT-PROJEYE yazar:
//     <ws>/crewpane/docs/agent-results/<KOD>-<ajan>.md
// Kayıtlı yol ise `<ws>/docs/agent-results/<KOD>-<ajan>.md` idi ve `<ws>/docs`
// dizini MAKİNEDE HİÇ YOK. Sonuç: kanıt kapısı 9 kaydın 9'unda da ateşlenemedi,
// hepsi "beklenen çıktı yok" ile BAŞARISIZ damgalandı — üçü raporunu YAZMIŞ VE
// COMMIT'LEMİŞ olmasına rağmen (ADP-729/730/732).
//
// ÇÖZÜM: tek yol yerine ADAY LİSTESİ. Aynı desen ADP-545'te notify-log için zaten
// kanıtlandı (`notifyPath.cjs` → `<ws>/crewpane/docs` probe'u); burada kanıt
// dosyası için TEKRARLANIR, `dirForDepartment` ile paylaşılan tek kaynaktan.
//
// GÜVENLİK: üretilen her aday workspace kökünün İÇİNDE olmak ZORUNDA (path
// traversal yüzeyi yok — `../../../etc/passwd` boş liste döner).
//
// Leaf modül (yalnız node builtins + departmentDirs.cjs) → `node --test` doğrudan koşar.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { dirForDepartment } = require('../agents/departmentDirs.cjs');
const { resultRootsUnder } = require('./resultRoot.cjs'); // RES-IDX-01 — `<root>/*/docs/agent-results` taraması

/**
 * Aday üst sınırı — defter şişmesin, probe maliyeti sabit kalsın.
 * RES-IDX-01: 6 → 12. Tarama (`resultRootsUnder`) bu workspace'te 10+ proje kökü
 * bulur; 6'da gerçek aday listeden düşerdi. Probe = stat başına ~µs, defter satırı
 * başına ≤12 yol — hâlâ sabit ve ucuz.
 */
const MAX_CANDIDATES = 12;

/** `abs`, `root` ağacının içinde mi? (root yoksa kısıt uygulanmaz.) */
function withinRoot(abs, root) {
  if (!root) return true;
  const r = path.resolve(root);
  const a = path.resolve(abs);
  return a === r || a.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/**
 * Bir kanıt yolunun (mutlak ya da göreli) bakılacak MUTLAK adaylarını üret.
 *
 * Sıra = güven sırası; çağıran ilkini "birincil" kabul edip hepsini yoklar:
 *   0. Yol zaten MUTLAK ise → tek aday odur (lider açıkça söylemiş; dokunma).
 *   1. `<cwd>/<rel>`                     — bugünkü davranış (geriye dönük uyum)
 *   2. `<deptDir>/<rel>`                 — departmanın proje dizini (chatflow/skool)
 *   3. `<workspaceRoot>/crewpane/<rel>` — ADP-545'in protokol hedefi: kurulu
 *      workspace'te crewpane PROJESİ kökün ALTINDADIR ama dept eşlemesi kökü verir
 *   4. `<workspaceRoot>/<rel>`           — dev checkout (kök = crewpane klonu)
 *
 * DİZİNİ VAR OLAN adaylar öne alınır (var olmayan bir `docs/agent-results/` altına
 * hiçbir worker yazmaz — o aday ölü ağırlıktır), ama HİÇBİRİ elenmez: rapor dizini
 * worker tarafından sonradan yaratılabilir.
 *
 * Saf-ish (gerçek fs.statSync dizin probe'u). ASLA throw etmez.
 *
 * B-01 (bulgu F-7) — `worktreePaths`: AKTİF İZOLE AĞAÇLAR. Bir görev kendi git
 * worktree'sinde koşarken raporunu O ağaca yazar. Pane'in cwd'si zaten worktree
 * olduğu için (1) çoğu hâlde yeter — ama supervisor kaydı cwd TAŞIMIYORSA (ya da
 * lider kaydı ana ağaçtan açtıysa) worktree hiçbir adayda GEÇMEZ ve izole koşan HER
 * görev "beklenen çıktı yok" ile SAHTE-FAIL alır. Bu yüzden aktif worktree'ler
 * (kaynak: yerel defter, MAIN tarafı) açıkça aday tabanı olarak geçirilir.
 * Kök kısıtı (`withinRoot`) bu adaylara da AYNEN uygulanır — worktree'nin workspace
 * İÇİNDE olması (K4) zaten bu guard'ın dayattığı kısıttır.
 *
 * @param {string} evidencePath  lider/motor tarafından verilen yol
 * @param {{cwd?:string, workspaceRoot?:string, department?:string, mapping?:object,
 *          repoRoot?:string, worktreePaths?:string[]}} opts
 * @returns {string[]} mutlak aday yollar (0..MAX_CANDIDATES), tekilleştirilmiş
 */
function resolveEvidenceCandidates(evidencePath, opts) {
  const o = opts || {};
  const raw = typeof evidencePath === 'string' ? evidencePath.trim() : '';
  if (!raw) return [];
  const root = typeof o.workspaceRoot === 'string' && o.workspaceRoot ? o.workspaceRoot : null;

  // RES-IDX-01 — MUTLAK yol artık TEK aday değil: BİRİNCİL aday odur (lider/kural
  // açıkça söyledi, sırası değişmez) ama worker raporu yine de başka bir repoya
  // düşürebilir (aynı sprintte üç yer ölçüldü). Ofis sözleşmesinin sabit kuyruğu
  // (`docs/agent-results/<ad>`) mutlak yoldan ÇIKARILIR ve o kuyruk aday köklerde
  // (aşağıdaki liste + `<root>/*/docs/agent-results` taraması) ALTERNATİF olarak
  // yoklanır. Sözleşme kuyruğu taşımayan mutlak yol eski gibi tek adaydır.
  let primaryAbs = null;
  let rel;
  if (path.isAbsolute(raw)) {
    const abs = path.normalize(raw);
    // Mutlak yol için kök kısıtı UYGULANMAZ olsaydı traversal yüzeyi açılırdı; ama
    // workspace kökü yapılandırılmamışsa (ADP-232-C) tek adayı da düşürmemeliyiz.
    if (root && !withinRoot(abs, root)) return [];
    const tail = resultsTail(abs);
    if (!tail || !root) return [abs];
    primaryAbs = abs;
    rel = tail;
  } else {
    rel = raw.replace(/^\.\//, '');
  }

  const bases = [];
  const pushBase = (b) => {
    if (typeof b === 'string' && b) bases.push(b);
  };

  pushBase(o.cwd);
  // B-01 F-7 — aktif izole ağaçlar. cwd'den HEMEN sonra: pane cwd'si worktree ise
  // (normal hâl) zaten birinci aday odur ve bu satırlar tekilleştirmede düşer;
  // cwd yoksa/başkaysa worktree yine de YOKLANIR.
  if (Array.isArray(o.worktreePaths)) {
    for (const wt of o.worktreePaths) pushBase(wt);
  }
  if (root) {
    if (typeof o.department === 'string' && o.department.trim()) {
      try {
        const deptDir = dirForDepartment(o.department, root, o.mapping);
        // deptDir === root ise (crewpane / bilinmeyen dept) aday değil: (3) ve (4)
        // zaten o kökü iki farklı şekilde deniyor.
        if (deptDir && path.resolve(deptDir) !== path.resolve(root)) pushBase(deptDir);
      } catch {
        /* dept çözümü best-effort */
      }
    }
    pushBase(path.join(root, 'crewpane'));
    pushBase(root);
    // RES-IDX-01 — TARAMA: kökün altındaki `docs/agent-results/` dizini OLAN her proje
    // (skool, chatflow, crewpane-com …). Sabit liste (cwd/dept/crewpane/kök) raporun
    // "mantıklı ama beklenmeyen" bir repoya düşüşünü kaçırıyordu; supervisor artık
    // "iş yapılmadı" demeden önce bu kökleri de yoklar ve bulursa yolu raporlar.
    // Sıra sabit listeden SONRA: bilinen kökler öncelik, tarama emniyet ağı.
    if (o.scanRoots !== false) {
      for (const r of resultRootsUnder(root)) pushBase(r);
    }
  }
  pushBase(o.repoRoot);

  // ── STAT-D1 §KN-6 — SIRALAMA ÜÇ KADEMELİ: DOLU > VAR > YOK ────────────────
  // ESKİDEN iki kademeydi (dizin VAR / YOK) ve bu, kurulu makinede BİRİNCİL adayı
  // yanlış köke düşürüyordu. Ölçüldü (STAT-R1 §KN-6): her crewpane pane'inin cwd'si
  // workspace PARENT'ı (`…/CrewPane Apps`), worker ise raporunu
  // `…/CrewPane Apps/crewpane/docs/agent-results/` altına yazıyor. Parent'ta da
  // `docs/agent-results/` dizini VAR — ama BOŞ (11 Ağu'da yaratılmış). "Dizini var"
  // kuralı o boş dizini birinci seçiyor, doğru yol `evidenceAlt[0]`a düşüyor ve
  // kullanıcıya giden mesaj VAR OLMAYAN bir yol gösteriyordu (bugün 4 örnek).
  //
  // Bir rapor dizininin BOŞ olması güçlü bir sinyaldir: oraya hiçbir worker yazmamış.
  // Dolu olan ise o sözleşmenin GERÇEKTEN yaşadığı yerdir. Hiçbiri elenmez — yalnız
  // sıra değişir (worker dizini sonradan da yaratabilir).
  const seen = new Set();
  const populated = [];
  const exists = [];
  const missing = [];
  // RES-IDX-01 — mutlak birincil aday sıralamaya GİRMEZ: hep ilk sıradadır (kural
  // "yol tek ve tam" dediyse supervisor da önce oraya bakar, DOLU/VAR kademesi onu
  // geriye itemez). Alternatifler eski üç-kademeli sırayla arkasına dizilir.
  if (primaryAbs) seen.add(primaryAbs);
  for (const base of bases) {
    let abs;
    try { abs = path.resolve(base, rel); } catch { continue; }
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (!withinRoot(abs, root)) continue; // traversal / workspace dışı → ASLA
    let dirOk = false;
    try { dirOk = fs.statSync(path.dirname(abs)).isDirectory(); } catch { dirOk = false; }
    if (!dirOk) { missing.push(abs); continue; }
    let hasEntries = false;
    try {
      // Tam listeleme değil, VARLIK sorusu: ilk girdide dur (büyük dizinlerde ucuz).
      const it = fs.opendirSync(path.dirname(abs));
      try { hasEntries = it.readSync() !== null; } finally { it.closeSync(); }
    } catch { hasEntries = false; }
    (hasEntries ? populated : exists).push(abs);
  }
  const ranked = [...populated, ...exists, ...missing];
  return (primaryAbs ? [primaryAbs, ...ranked] : ranked).slice(0, MAX_CANDIDATES);
}

/**
 * RES-IDX-01 — mutlak bir yolun ofis-sözleşmesi KUYRUĞU: `…/docs/agent-results/<ad>`
 * → `docs/agent-results/<ad>` (alt dizinli kanıt: `docs/agent-results/X-evidence/a.txt`
 * de korunur). Sözleşme dizini geçmiyorsa null. Saf.
 */
function resultsTail(abs) {
  const parts = String(abs || '').split(/[\\/]+/);
  for (let i = 0; i + 1 < parts.length; i++) {
    if (parts[i] === 'docs' && parts[i + 1] === 'agent-results' && i + 2 < parts.length) {
      return parts.slice(i).join('/');
    }
  }
  return null;
}

/**
 * ADP-735 — bir supervisor kaydının kanıt alanlarını ÜRET. `dlgsup:record` (main.js) ve
 * regresyon fixture'ı BU fonksiyonu paylaşır; iki uygulama olsaydı test üretimi değil
 * KENDİNİ doğrulardı ([[typed-import-not-drift-proof]] dersi).
 *
 * Girdi kaydını MUTASYONA UĞRATMAZ; {evidencePath, evidenceAlt, evidenceBaselines,
 * evidenceBaseline} alanları eklenmiş YENİ bir obje döner. `evidencePath` yoksa kayıt
 * olduğu gibi döner (marker-only alt-görev — ADP-158 mirası).
 *
 * @param {object} rec                 renderer'dan gelen ham kayıt
 * @param {object} ctx                 {cwd, workspaceRoot, department, mapping, repoRoot,
 *                                      worktreePaths, fingerprint}
 *   `worktreePaths` (B-01 F-7): main YALNIZ bu görevin kendi izole ağacını geçirmeli
 *   (tüm aktif worktree'leri değil) — aday listesi MAX_CANDIDATES ile sınırlıdır ve
 *   alakasız ağaçlar gerçek adayı listeden düşürebilir.
 */
function shapeEvidenceRecord(rec, ctx) {
  const r = { ...(rec || {}) };
  if (!r.evidencePath) return r;
  const c = ctx || {};
  const cands = resolveEvidenceCandidates(r.evidencePath, {
    cwd: r.cwd || c.cwd,
    workspaceRoot: c.workspaceRoot,
    department: r.department || c.department,
    mapping: c.mapping,
    repoRoot: c.repoRoot,
    worktreePaths: r.worktreePath ? [r.worktreePath] : c.worktreePaths,
  });
  if (cands.length === 0) return r; // çözülemedi (workspace dışı) → ham hâliyle bırak
  const fp = typeof c.fingerprint === 'function' ? c.fingerprint : () => null;
  const baselines = {};
  for (const p of cands) {
    try { baselines[p] = fp(p); } catch { baselines[p] = null; }
  }
  r.evidencePath = cands[0];
  r.evidenceAlt = cands.slice(1);
  r.evidenceBaselines = baselines;
  r.evidenceBaseline = baselines[cands[0]];
  return r;
}

/**
 * DF-03 — bir kanıt yolunun ÇOK-ADAYLI VARLIK + TAZELİK sondası.
 *
 * NEDEN: sprint tarafı kanıtı RENDERER'dan, tek kökle yokluyordu
 * (`fileApiEvidenceChecker` → `fileApi.read(<ws>/<rel>)`). Kurulu makinede o kök
 * workspace PARENT'ı; worker ise raporunu ALT-PROJEYE yazar. 2026-08-11 gecesinde
 * ÖLÇÜLDÜ: `<ws>/docs/agent-results/` dizini VAR ama BOŞ, raporların hepsi
 * `<ws>/crewpane/docs/agent-results/` altında → 10 sprint task'ının 10'u da
 * "pane exited (code 129) ve beklenen çıktı yok" ile başarısız damgalandı ve
 * hepsi İKİNCİ kez spawn edildi (ikiz dalga). Supervisor AYNI dosyaları
 * `resolveEvidenceCandidates` sayesinde buluyordu — yani hata sondanın kendisinde
 * değil, sprint'in o sondayı kullanmamasındaydı (ADP-735'in sprint yolundaki ikizi).
 *
 * Bu fonksiyon supervisor'ın kullandığı ADAY ÜRETİMİNİ aynen çağırır (ikinci bir
 * çözüm YAZILMAZ) ve üstüne tek bir kural koyar: dosya VAR + BOŞ DEĞİL + (istenirse)
 * `since`'ten SONRA yazılmış.
 *
 * `since` verilmezse (0/undefined) yalnız varlık aranır — eski rehydrate semantiği.
 * Bulunmayan ama VAR OLAN bayat bir aday varsa `stale:true` ile döner: çağıran
 * "dosya var ama bu denemeden önce yazılmış" ayrımını yapabilsin (ikiz denemede
 * önceki turun raporunu 'done' saymamak için ŞART).
 *
 * @param {string} evidencePath
 * @param {{cwd?:string, workspaceRoot?:string, department?:string, mapping?:object,
 *          repoRoot?:string, worktreePaths?:string[], since?:number}} opts
 * @returns {{found:boolean, path:string|null, mtimeMs:number, size:number,
 *            stale:boolean, candidates:string[]}}
 */
function probeEvidence(evidencePath, opts) {
  const o = opts || {};
  const candidates = resolveEvidenceCandidates(evidencePath, o);
  const since = Number.isFinite(o.since) && o.since > 0 ? o.since : 0;
  const miss = { found: false, path: null, mtimeMs: 0, size: 0, stale: false, candidates };
  let stale = null;
  for (const abs of candidates) {
    let st = null;
    try { st = fs.statSync(abs); } catch { continue; }
    if (!st.isFile() || st.size <= 0) continue; // boş dosya kanıt DEĞİL (renderer sondasıyla aynı kural)
    // ">=" bilerek: dispatch ile yazım aynı milisaniyeye düşebilir (ADP-735 ile aynı gerekçe).
    if (!since || st.mtimeMs >= since) {
      return { found: true, path: abs, mtimeMs: st.mtimeMs, size: st.size, stale: false, candidates };
    }
    if (!stale) stale = { found: false, path: abs, mtimeMs: st.mtimeMs, size: st.size, stale: true, candidates };
  }
  return stale || miss;
}

module.exports = {
  resultsTail, MAX_CANDIDATES, resolveEvidenceCandidates, shapeEvidenceRecord, probeEvidence };
