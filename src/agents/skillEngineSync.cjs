// CrewPane — SKL-B0: motor görünümlerinin EŞİTLEME TETİĞİ + DURUM ÖZETİ.
//
// ── ÖLÇÜLMÜŞ KÖK NEDEN (SKILL-LIBRARY-DESIGN §6.2) ─────────────────────────
// `skillEngineView.reconcileEngineViews` YALNIZ bir yayın/geri-alma fiilinden
// (`skillApprove`) çağrılıyordu. Motor defteri ENG-13/ENG-14 ile büyüyünce
// (gemini · qwen · droid) o fiil bir daha koşmadı ⇒ bu üç motorun skill dizini
// HİÇ oluşmadı. Ölçüm (2026-08-18, gerçek kurulum):
//
//   $ ls .gemini/skills .qwen/skills ~/.factory/skills   → ÜÇÜ DE: dizin yok
//   $ GEMINI_CLI_TRUST_WORKSPACE=true gemini skills list → "No skills discovered."
//
// Yani ürün "yayında" diyor, motor hiçbir şey görmüyor ve bunu söyleyen bir
// rozet de yok. Bu dosya o boşluğu kapatır ve İKİ İŞ yapar:
//
//   1) `syncEngineViews`  — reconcile'ı ÇAĞIRIR (yeniden yazmaz!) ve tek satırlık
//      ölçülebilir bir özet loglar. Açılışta ve çalışma alanı değişince koşar.
//   2) `engineViewSummary` — SALT OKUNUR durum: hangi motorun dizini var/yok,
//      hangi skiller bağlı, hangi yabancı girdi yolu tutuyor, hangi motorda
//      `partial` uyarısı var. Skill Merkezi başlığı bunu çizer.
//
// ── SÖZLEŞMELER ────────────────────────────────────────────────────────────
// • MEVCUT FİİL YENİDEN YAZILMAZ: bağ kurma/silme kararı tek yerde kalır
//   (`skillEngineView`). Burada yalnız ÇAĞRI ve ÖZET vardır.
// • `engineViewSummary` DİSKE YAZMAZ (mkdir dahil) — `skillCenter` sözleşmesinin
//   aynısı: bir paneli açmak mutasyon olamaz.
// • Kill-switch `CREWPANE_SKILLS=0`: hiçbir bağ kurulmaz, hiçbir şey silinmez.
// • Yabancı girdilere DOKUNULMAZ; yalnız `conflicts[]` içinde GÖRÜNÜR kılınır.
//   Nokta ile başlayan girdiler (codex'in `.system`i) motorun KENDİ iç dizinidir
//   → çakışma sayılmaz; onları rapora katmak rozeti gürültüye boğardı.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const skillStore = require('./skillStore.cjs');
const engineView = require('./skillEngineView.cjs');
const engineRegistry = require('./engineRegistry.cjs');

/**
 * ENG-10 rozet dili — motorun `skillsDir` yeteneği KISMİ mi?
 * Tam çalışan motor rozet ÜRETMEZ: `null` döner.
 * Kaynak defterdir (`partial.skillsDir`), burada ikinci bir gerekçe yazılmaz.
 */
function skillsDirCaveat(engine, registry = engineRegistry) {
  try {
    const items = registry.unsupportedCapabilities(engine) || [];
    const hit = items.find((i) => i && i.capability === 'skillsDir');
    if (!hit) return null;
    return { state: hit.state, reason: hit.reason };
  } catch {
    return null;
  }
}

/**
 * SALT OKUNUR motor görünümü özeti.
 *
 * Dönen:
 * ```
 * { enabled, workspaceRoot, canonicalRoot, published:[ad], engines:[{
 *     engine, dir, exists, sharedWith,
 *     linked:[ad], missing:[ad],
 *     conflicts:[{ name, kind, blocking }],   // blocking = YAYINDAKİ bir adın yolunu tutuyor
 *     caveat:{ state, reason }|null,
 *     ok                                       // rozet ÜRETİLMEZ ise true
 *   }] }
 * ```
 */
function engineViewSummary({ workspaceRoot, env = process.env, homedir = os.homedir(), codexHome, registry = engineRegistry } = {}) {
  const enabled = engineView.skillsEnabled(env);
  const canonicalRoot = skillStore.skillsRoot(workspaceRoot);
  const paths = engineView.skillEnginePaths({ workspaceRoot, env, homedir, codexHome });
  const published = canonicalRoot ? engineView.publishableNames(workspaceRoot) : [];
  const desired = new Set(published);

  // Aynı dizini paylaşan motorlar (claude + copilot + goose → `.claude/skills`)
  // dizini BİR KEZ okur; ikinci motor AYNI sonucu `sharedWith` ile taşır. Boş
  // sonuç döndürmek "copilot skill görmüyor" yalanını üretirdi (ENG-12 dersi).
  const byDir = new Map();
  const engines = [];

  for (const { engine, dir } of paths) {
    const caveat = skillsDirCaveat(engine, registry);
    if (byDir.has(dir)) {
      const base = byDir.get(dir);
      engines.push({ ...base, engine, sharedWith: base.engine, caveat, ok: base.ok && !caveat });
      continue;
    }

    let entries = null; // null = dizin okunamadı (yok)
    try {
      entries = fs.readdirSync(dir);
    } catch {
      entries = null;
    }
    const exists = entries !== null;
    const linked = [];
    const conflicts = [];

    for (const name of entries || []) {
      if (name.startsWith('.')) continue; // motorun KENDİ iç dizini (codex `.system`) — çakışma değil
      const c = canonicalRoot ? engineView.classifyEntry(path.join(dir, name), canonicalRoot) : { kind: 'absent' };
      if (c.kind === 'ours-link' || c.kind === 'ours-copy') {
        if (desired.has(name)) linked.push(name);
        continue;
      }
      if (c.kind === 'ours-link-dangling') continue; // bayat bağ: reconcile temizler, çakışma değil
      conflicts.push({ name, kind: c.kind, blocking: desired.has(name) });
    }

    const missing = published.filter((n) => !linked.includes(n));
    const entry = {
      engine,
      dir,
      exists,
      sharedWith: null,
      linked,
      missing,
      conflicts,
      caveat,
      // "Rozet üretilmez" eşiği: dizin var · yayındaki her skill bağlı · yabancı
      // girdi yok · defterde kısmi uyarı yok.
      ok: exists && missing.length === 0 && conflicts.length === 0 && !caveat,
    };
    byDir.set(dir, entry);
    engines.push(entry);
  }

  return { enabled, workspaceRoot: workspaceRoot || null, canonicalRoot, published, engines };
}

/** Tek satırlık log özeti — "koştu mu, ne yaptı" sorusu greplenebilir olsun. */
function summarizeReport(report) {
  if (!report || !Array.isArray(report.engines)) return 'motor yok';
  return report.engines
    .map((e) => {
      const bits = [];
      if (e.sharedWith) bits.push(`= ${e.sharedWith}`);
      else {
        bits.push(`+${(e.linked || []).length}`);
        if ((e.removed || []).length) bits.push(`-${e.removed.length}`);
        if ((e.conflicts || []).length) bits.push(`çakışma:${e.conflicts.length}`);
        if ((e.failed || []).length) bits.push(`düştü:${e.failed.length}`);
      }
      return `${e.engine}(${bits.join(' ')})`;
    })
    .join(' · ');
}

/**
 * SKL-B0'ın TETİĞİ — reconcile'ı çağır, sonucu ölçülebilir biçimde söyle.
 *
 * `reason` çağrı noktasını adlandırır (`boot` · `workspace-switch` · `manual`):
 * log satırı "hangi yol koştu" sorusuna tahminle değil kayıtla cevap verir.
 * `appVersion` DAMGALANIR: motor defteri bir sürümle büyüdüğünde, o sürümün
 * açılışında eşitlemenin koştuğu log'dan doğrulanabilir olmalı (kart adım 2 —
 * uygulama sürümü SÜREÇ İÇİNDE değişemediği için açılış koşusu bunu kapsar).
 *
 * ASLA FIRLATMAZ: eşitleme bir açılış adımıdır; düşerse uygulama açılmaya devam
 * eder ve gerekçe log'a düşer (sessiz başarısızlık yok, açılış çökmesi de yok).
 */
function syncEngineViews({
  workspaceRoot,
  appVersion = null,
  reason = 'manual',
  env = process.env,
  homedir = os.homedir(),
  codexHome,
  platform = process.platform,
  log = null,
} = {}) {
  const say = (line) => {
    if (typeof log === 'function') {
      try { log(line); } catch { /* log yolu koşuyu düşüremez */ }
    }
  };
  const stamp = `skill-views[${reason}${appVersion ? ` v${appVersion}` : ''}]`;

  if (!engineView.skillsEnabled(env)) {
    say(`${stamp} atlandı — CREWPANE_SKILLS=0 (kill-switch)`);
    return { ran: false, reason: 'kill-switch', report: null, summary: null };
  }
  if (!workspaceRoot || typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
    say(`${stamp} atlandı — çalışma alanı yok`);
    return { ran: false, reason: 'no-workspace', report: null, summary: null };
  }

  let report;
  try {
    report = engineView.reconcileEngineViews({ workspaceRoot, env, homedir, codexHome, platform });
  } catch (err) {
    say(`${stamp} DÜŞTÜ: ${(err && err.message) || String(err)}`);
    return { ran: false, reason: 'error', error: (err && err.message) || String(err), report: null, summary: null };
  }
  if (!report.enabled) {
    say(`${stamp} atlandı — ${report.reason}`);
    return { ran: false, reason: report.reason || 'disabled', report, summary: null };
  }

  const summary = engineViewSummary({ workspaceRoot, env, homedir, codexHome });
  say(`${stamp} ${summarizeReport(report)}`);
  return { ran: true, reason: null, report, summary };
}

module.exports = {
  skillsDirCaveat,
  engineViewSummary,
  summarizeReport,
  syncEngineViews,
};
