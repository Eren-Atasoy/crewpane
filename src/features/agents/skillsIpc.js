'use strict';

const os = require('node:os');

/**
 * Skills & Skill Center IPC Handlers (Faz 3.5 — Sıra 8)
 * Channels:
 *   - skills:list
 *   - skills:engineViews
 *   - skills:syncEngines
 *   - skills:read
 *   - skills:publish
 *   - skills:saveDraft
 *   - skills:history
 *   - skills:rollback
 *   - skills:export
 *   - skills:import
 *   - skills:builtinList
 *   - skills:builtinInstall
 *   - skills:builtinUninstall
 *   - skills:audit
 */
function registerSkillsIpc({
  ipcMain,
  app,
  skillCenter,
  skillEngineSync,
  skillApprove,
  skillAuthor,
  skillVersions,
  skillShare,
  builtinSkills,
  skillGuard,
  skillEngineView,
  getWorkspaceRoot = () => null,
  getBoundAccount = () => null,
  syncSkillEngineViews = () => {},
  logLine = () => {},
}) {
  // SK-03 (ADR-SKILL-CENTER §8) — SKİLL MERKEZİ'nin okuma ucu. `memory:graph`in
  // kardeşi: dosya-tabanlı skill deposunu (yayın + taslak) tarar ve her skillin
  // BUGÜN hangi motor tarafından görüldüğünü de söyler. SALT OKUNUR — bu uç
  // hiçbir bağ kurmaz/silmez (`reconcileEngineViews` bilerek çağrılmaz: paneli
  // açmak bir mutasyon olamaz). Hata → boş liste değil, `ok:false` + gerekçe.
  ipcMain.handle('skills:list', () => {
    const agentWorkspaceRoot = getWorkspaceRoot();
    try {
      return skillCenter.listSkillCenter({ workspaceRoot: agentWorkspaceRoot });
    } catch (err) {
      logLine(`skills:list failed: ${err.message}`);
      return { ok: false, reason: err.message, enabled: true, workspaceRoot: agentWorkspaceRoot, roots: null, engines: [], counts: { published: 0, draft: 0, invalid: 0 }, skills: [] };
    }
  });

  // SKL-B0 — MOTOR GÖRÜNÜMLERİ (salt okunur): hangi motorun dizini var/yok, yayındaki
  // skiller bağlı mı, hangi yabancı girdi yolu tutuyor, defterde `partial` uyarısı var mı.
  // `skills:list`in kardeşi ama AYRI bir uç: liste SKİLL başına, bu MOTOR başına konuşur.
  ipcMain.handle('skills:engineViews', () => {
    const agentWorkspaceRoot = getWorkspaceRoot();
    try {
      return skillEngineSync.engineViewSummary({ workspaceRoot: agentWorkspaceRoot });
    } catch (err) {
      logLine(`skills:engineViews failed: ${err.message}`);
      return { enabled: true, workspaceRoot: agentWorkspaceRoot, canonicalRoot: null, published: [], engines: [], reason: err.message };
    }
  });

  // SKL-B0 — [Şimdi eşitle]: kullanıcının ELİYLE tetiklediği reconcile. Açılış
  // tetiği zaten var; bu düğme "az önce yayınladım/bir şey bozuldu, ŞİMDİ düzelt"
  // içindir ve sonucu ANINDA taze özetle döner (UI ikinci çağrı yapmasın).
  // Yayın kapısına DOKUNMAZ: taslak yayınlamaz, yalnız YAYINDAKİLERİ bağlar.
  ipcMain.handle('skills:syncEngines', () => {
    const agentWorkspaceRoot = getWorkspaceRoot();
    try {
      const r = skillEngineSync.syncEngineViews({
        workspaceRoot: agentWorkspaceRoot,
        appVersion: app.getVersion(),
        reason: 'manual',
        log: (line) => logLine(line),
      });
      return { ok: r.ran, reason: r.reason, summary: r.summary, report: r.report };
    } catch (err) {
      logLine(`skills:syncEngines failed: ${err.message}`);
      return { ok: false, reason: err.message, summary: null, report: null };
    }
  });

  // SK-03 — TEK skillin tam kaydı (SKILL.md gövdesi dahil). Liste ucuz kalsın diye
  // gövde ayrı çağrıda gelir (`memory:fact` emsali). Yok/geçersiz → null.
  ipcMain.handle('skills:read', (_event, name, scope) => {
    const agentWorkspaceRoot = getWorkspaceRoot();
    try {
      return skillCenter.readSkillCenter({ workspaceRoot: agentWorkspaceRoot, name, scope });
    } catch (err) {
      logLine(`skills:read failed: ${err.message}`);
      return null;
    }
  });

  // SK-04 (ADR-SKILL-CENTER Karar 2) — TASLAK → YAYIN. Uygulamadaki TEK terfi
  // noktası; yalnız kullanıcının onay kartındaki tıklamasıyla çağrılır (otomatik
  // yayın YOK). İşin kendisi SK-02'nin fiillerinde (skillApprove yalnız sırayı
  // kurar: publishDraft → reconcileEngineViews).
  //
  // ONAYLAYAN damgası BURADA ölçülür: renderer'ın gönderdiği bir isim kabul
  // edilmez, `boundAccount` (bu süreçte bağlı hesap) yazılır — damga bir kanıt
  // olacaksa uydurulabilir olmamalıdır.
  ipcMain.handle('skills:publish', (_event, name, opts) => {
    const agentWorkspaceRoot = getWorkspaceRoot();
    const boundAccount = getBoundAccount();
    try {
      const reviewedBy = (boundAccount && (boundAccount.email || boundAccount.userId)) || os.userInfo().username || 'human';
      return skillApprove.approveDraft({
        workspaceRoot: agentWorkspaceRoot,
        name,
        reviewedBy,
        reviewedAt: new Date().toISOString(),
        overwrite: !!(opts && opts.overwrite),
      });
    } catch (err) {
      logLine(`skills:publish failed: ${err.message}`);
      return { ok: false, errors: [{ code: 'publish-failed', message: err.message }], warnings: [] };
    }
  });

  // SK-05 (ADR-SKILL-CENTER Karar 2) — KULLANICININ YAZMA UCU: "Yeni Skill" formu ve
  // "Düzenle". Bu uç YAYIN dizinine ASLA yazmaz: her iki kip de `skill-drafts/`e iner
  // (yayındaki bir skill düzenlenirse taslağa ÇATALLANIR, canlı dosyaya dokunulmaz) —
  // yayın hâlâ tek bir yerden, SK-04'ün onay kartından geçer.
  //
  // YAZAN damgası BURADA ölçülür (`skills:publish` emsali): renderer'dan gelen bir
  // isim kabul edilmez; provenans uydurulabilir olmamalı.
  ipcMain.handle('skills:saveDraft', (_event, input) => {
    const agentWorkspaceRoot = getWorkspaceRoot();
    const boundAccount = getBoundAccount();
    try {
      const author = (boundAccount && (boundAccount.email || boundAccount.userId)) || os.userInfo().username || 'human';
      return skillAuthor.saveDraft({
        workspaceRoot: agentWorkspaceRoot,
        name: input && input.name,
        description: input && input.description,
        body: input && input.body,
        mode: input && input.mode === 'update' ? 'update' : 'create',
        author,
      });
    } catch (err) {
      logLine(`skills:saveDraft failed: ${err.message}`);
      return { ok: false, errors: [{ code: 'save-failed', message: err.message }], warnings: [] };
    }
  });

  // ── SK-08 — YAYIN GEÇMİŞİ / GERİ ALMA / PAYLAŞIM / DENETİM ─────────────────

  // SK-08 (2) — bir skillin yayın geçmişi (kim/ne zaman/ne değişti). SALT OKUNUR.
  ipcMain.handle('skills:history', (_event, name) => {
    const agentWorkspaceRoot = getWorkspaceRoot();
    try {
      return skillVersions.listVersions(agentWorkspaceRoot, name);
    } catch (err) {
      logLine(`skills:history failed: ${err.message}`);
      return { name, versions: [], count: 0 };
    }
  });

  // SK-08 (2) — GERİ ALMA. `skills:publish` emsali: geri alanın damgası BURADA
  // ölçülür (renderer'ın gönderdiği isim kabul edilmez). Hedef metin, geçmişte
  // insan onayıyla yayınlanmış bir sürümdür → onay değişmezi korunur.
  ipcMain.handle('skills:rollback', (_event, name, version) => {
    const agentWorkspaceRoot = getWorkspaceRoot();
    const boundAccount = getBoundAccount();
    try {
      const restoredBy = (boundAccount && (boundAccount.email || boundAccount.userId)) || os.userInfo().username || 'human';
      return skillApprove.rollbackToVersion({
        workspaceRoot: agentWorkspaceRoot,
        name,
        version,
        restoredBy,
        at: new Date().toISOString(),
      });
    } catch (err) {
      logLine(`skills:rollback failed: ${err.message}`);
      return { ok: false, errors: [{ code: 'rollback-failed', message: err.message }] };
    }
  });

  // SK-08 (4) — DIŞA AKTARIM: paylaşılabilir SKILL.md metni (sır taramasından geçer).
  ipcMain.handle('skills:export', (_event, name, scope) => {
    const agentWorkspaceRoot = getWorkspaceRoot();
    try {
      return skillShare.exportSkill({ workspaceRoot: agentWorkspaceRoot, name, scope: scope === 'draft' ? 'draft' : 'published' });
    } catch (err) {
      logLine(`skills:export failed: ${err.message}`);
      return { ok: false, errors: [{ code: 'export-failed', message: err.message }] };
    }
  });

  // SK-08 (4) — İÇE AKTARIM. 🔴 Sonuç HER ZAMAN taslaktır; bu ucun yayın yapan bir
  // yolu YOKTUR (skillShare yalnız yazma boğazını çağırır). Alan kim olduğu burada
  // ölçülür — provenans uydurulabilir olmamalı.
  ipcMain.handle('skills:import', (_event, payload) => {
    const agentWorkspaceRoot = getWorkspaceRoot();
    const boundAccount = getBoundAccount();
    try {
      const importedBy = (boundAccount && (boundAccount.email || boundAccount.userId)) || os.userInfo().username || 'human';
      const p = payload || {};
      if (p.filePath) {
        return skillShare.importSkillFile({ workspaceRoot: agentWorkspaceRoot, filePath: p.filePath, name: p.name, importedBy, overwriteDraft: !!p.overwriteDraft });
      }
      return skillShare.importSkillText({ workspaceRoot: agentWorkspaceRoot, text: p.text, name: p.name, source: p.source, importedBy, overwriteDraft: !!p.overwriteDraft });
    } catch (err) {
      logLine(`skills:import failed: ${err.message}`);
      return { ok: false, errors: [{ code: 'import-failed', message: err.message }] };
    }
  });

  // SKL-B6 — DAHİLİ KATALOG (salt okunur): paketle gelen skill'ler + her birinin bu
  // çalışma alanındaki GERÇEK durumu (kurulu · güncelleme var · çatal · çakışma).
  ipcMain.handle('skills:builtinList', () => {
    const agentWorkspaceRoot = getWorkspaceRoot();
    try {
      return builtinSkills.listCatalog({ workspaceRoot: agentWorkspaceRoot });
    } catch (err) {
      logLine(`skills:builtinList failed: ${err.message}`);
      return { ok: false, reason: err.message, catalogVersion: null, dir: null, skills: [] };
    }
  });

  // SKL-B6 — KUR / GÜNCELLE. Kurulum bir YAYIN fiilidir (kullanıcının tıklaması ADR'nin
  // istediği insan onayıdır), bu yüzden bağların kurulması için reconcile HEMEN tetiklenir.
  // ONAYLAYAN damgası `skills:publish` emsaliyle BURADA yazılır: renderer'ın gönderdiği
  // bir isim kabul edilmez.
  ipcMain.handle('skills:builtinInstall', (_event, name, opts) => {
    const agentWorkspaceRoot = getWorkspaceRoot();
    const boundAccount = getBoundAccount();
    try {
      const reviewedBy = (boundAccount && (boundAccount.email || boundAccount.userId)) || os.userInfo().username || 'human';
      const res = builtinSkills.install({
        workspaceRoot: agentWorkspaceRoot,
        name,
        installAs: (opts && opts.installAs) || null,
        force: !!(opts && opts.force),
        reviewedBy,
      });
      if (res.ok && res.changed) syncSkillEngineViews('builtin-install');
      return res;
    } catch (err) {
      logLine(`skills:builtinInstall failed: ${err.message}`);
      return { ok: false, changed: false, action: 'none', errors: [{ code: 'exception', message: err.message }] };
    }
  });

  // SKL-B6 — KALDIR: kurulu kopya silinir, tercih kaydedilir (açılış geri kurmaz) ve
  // reconcile bayat motor bağını temizler ("bayat bağ 0" kart md.5).
  ipcMain.handle('skills:builtinUninstall', (_event, name) => {
    const agentWorkspaceRoot = getWorkspaceRoot();
    try {
      const res = builtinSkills.uninstall({ workspaceRoot: agentWorkspaceRoot, name });
      if (res.ok && res.changed) syncSkillEngineViews('builtin-uninstall');
      return res;
    } catch (err) {
      logLine(`skills:builtinUninstall failed: ${err.message}`);
      return { ok: false, changed: false, action: 'none', errors: [{ code: 'exception', message: err.message }] };
    }
  });

  // SK-08 (1)/T6 — ONAY KAPISI DENETİMİ: yayındaki her skill kapıdan mı geçti, motor
  // dizinlerinde kaçak giriş var mı? Merkez bunu bir uyarı şeridi olarak gösterir →
  // atlatma SESSİZ kalmaz (kapının "UI ayağı").
  ipcMain.handle('skills:audit', () => {
    const agentWorkspaceRoot = getWorkspaceRoot();
    try {
      // İki AYRI soru, iki AYRI nöbetçi (ikisi de var olanı çağırır, yenisini yazmaz):
      //   • damga  → skillGuard.auditPublished      ("yayındaki dosya kapıdan mı geçti")
      //   • motor  → skillEngineView.auditEngineViews (SK-03/R8: taslak sızmış mı, kaçak dizin var mı)
      //   • dahili → builtinSkills.auditBuiltin        (SKL-B6: `builtin-tampered` · `builtin-orphan`)
      const published = skillGuard.auditPublished(agentWorkspaceRoot);
      const engines = skillEngineView.auditEngineViews({ workspaceRoot: agentWorkspaceRoot });
      const builtin = builtinSkills.auditBuiltin({ workspaceRoot: agentWorkspaceRoot });
      const findings = [
        ...published.findings,
        ...(engines.violations || []).map((v) => ({ kind: v.code, name: v.name, file: v.path, engine: v.engine, message: v.message })),
        ...(builtin.violations || []).map((v) => ({ kind: v.code, name: v.name, file: v.path, where: v.where, message: v.message })),
      ];
      // `builtin-forked` (kullanıcının düzenlediği dahili kopya) BULGU DEĞİL: §2.5 onu
      // açıkça korur. Ayrı bir alanda taşınır ki Merkez "güncelleme var ama senin
      // düzenlemen duruyor" diyebilsin — uyarı şeridini kırmızıya boyamadan.
      return { ok: findings.length === 0, checked: published.checked, findings, info: builtin.info || [], engineDirs: engines.checked || [] };
    } catch (err) {
      logLine(`skills:audit failed: ${err.message}`);
      return { ok: true, checked: 0, findings: [], reason: err.message };
    }
  });
}

module.exports = { registerSkillsIpc };
