'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('skillsApi', {
  /**
   * → { ok, enabled, workspaceRoot, roots:{published,drafts}, engines:[{engine,dir}],
   *     counts:{published,draft,invalid},
   *     skills:[{ name, description, source:'user'|'ai', status, scope:'published'|'draft',
   *               path, file, ok, errors, warnings, origin, author, version, task,
   *               sourceMemory, reviewedBy, reviewedAt, license, updatedAt,
   *               engines:[{ engine, dir, state }] }] }
   * `state`: linked | copy | absent | dangling | conflict | exposed | disabled
   * (DEPO değil DİSK ölçülür: "yayında" ile "motor görüyor" ayrışabilir.)
   */
  list: () => ipcRenderer.invoke('skills:list'),
  /** Tek skillin tam kaydı + `body`/`text` (ham SKILL.md). Yoksa null. */
  read: (name, scope) => ipcRenderer.invoke('skills:read', name, scope),
  /**
   * SKL-B0 — MOTOR başına görünüm (SALT OKUNUR; hiçbir bağ kurmaz):
   * → { enabled, workspaceRoot, canonicalRoot, published:[ad],
   *     engines:[{ engine, dir, exists, sharedWith, linked:[ad], missing:[ad],
   *                conflicts:[{name,kind,blocking}], caveat:{state,reason}|null, ok }] }
   * `ok:true` → ENG-10 dilinde rozet ÜRETİLMEZ (tam çalışan motor sessizdir).
   */
  engineViews: () => ipcRenderer.invoke('skills:engineViews'),
  /**
   * SKL-B0 — [Şimdi eşitle]: reconcile'ı ELLE koştur. → { ok, reason, summary, report }
   * `summary` taze `engineViews` çıktısıdır (UI ikinci çağrı yapmaz).
   * Taslak YAYINLAMAZ — yalnız yayındakilerin motor bağlarını kurar/temizler.
   */
  syncEngines: () => ipcRenderer.invoke('skills:syncEngines'),
  /**
   * SK-04 — TASLAĞI YAYINA AL (insan onayı). Tek çağıran: onay kartındaki tıklama.
   * → { ok, name, dir, file, version, engines, errors, warnings }
   * `ok:false` + `errors[0].code`: `draft-missing` · `already-published` (→ `overwrite`
   * ile ikinci onay) · lint kodları (kırmızı taslak YAYINLANMAZ).
   * ONAYLAYAN damgasını main yazar — burada gönderilemez (kanıt uydurulamamalı).
   */
  publish: (name, opts) => ipcRenderer.invoke('skills:publish', name, opts),
  /**
   * SK-05 — TASLAK KAYDET ("Yeni Skill" formu + "Düzenle"). Girdi:
   * `{ name, description, body, mode:'create'|'update' }`.
   * → { ok, name, dir, file, scope:'draft', forkedFromPublished, errors, warnings }
   * `ok:false` + `errors[0].code`: `name-empty` · `name-invalid` (+`suggestion`) ·
   * `name-taken` (+`scope`) · `skill-missing` · `no-workspace` · lint kodları.
   * YAZAN damgasını main yazar. Yayına yazmaz: `mode:'update'` yayındaki bir skille
   * çağrılırsa taslağa ÇATALLANIR (`forkedFromPublished:true`) — canlı dosya durur.
   */
  saveDraft: (input) => ipcRenderer.invoke('skills:saveDraft', input),
  /**
   * SK-08 — YAYIN GEÇMİŞİ (salt okunur). → { name, versions:[{version, at, action,
   * reviewedBy, path, change:{added,removed,changed,first}, exists}], count }
   * En YENİ önce. `action`: 'publish' | 'rollback'.
   */
  history: (name) => ipcRenderer.invoke('skills:history', name),
  /**
   * SK-08 — GERİ ALMA: yayındaki skilli geçmiş bir sürümüne döndür (insan tıklaması).
   * → { ok, name, version, restoredFrom, engines, history, errors }
   * `ok:false` + code: `version-missing` · `restored-by-required` · lint · `secret-detected`.
   * 🔑 Onay kapısı DELİNMEZ: hedef metin geçmişte insan onayıyla yayınlanmış olandır;
   * geri alan kişinin damgasını main yazar (burada gönderilemez).
   */
  rollback: (name, version) => ipcRenderer.invoke('skills:rollback', name, version),
  /**
   * SK-08 — DIŞA AKTAR: paylaşılabilir SKILL.md metni. → { ok, name, text, errors }
   * Sır taramasından geçer: bulgu varsa metin VERİLMEZ (`blockedBy:'secret-scan'`).
   */
  export: (name, scope) => ipcRenderer.invoke('skills:export', name, scope),
  /**
   * SK-08 — İÇE AKTAR: `{ text }` ya da `{ filePath }` (+ `name`, `overwriteDraft`).
   * → { ok, name, scope:'draft', pendingApproval:true, errors }
   * 🔴 SONUÇ HER ZAMAN TASLAKTIR — bu ucun yayına giden bir yolu YOKTUR. Yabancı onay
   * damgaları ve "published" iddiası DÜŞÜRÜLÜR; provenans (`imported`) yazılır.
   */
  import: (payload) => ipcRenderer.invoke('skills:import', payload),
  /**
   * SK-08 — ONAY KAPISI DENETİMİ (T6). → { ok, checked, findings:[{kind,name,file,message}] }
   * `kind`: `unapproved-published` (damgasız yayın) · `invalid-published` ·
   * `draft-exposed` · `agent-written` · `dangling`. Merkez bunu uyarı şeridi yapar:
   * kapıyı atlatan bir yayın SESSİZ kalmasın.
   */
  audit: () => ipcRenderer.invoke('skills:audit'),
  /**
   * SKL-B6 — DAHİLİ KATALOG (paketle gelen skill'ler), SALT OKUNUR:
   * → { ok, dir, catalogVersion, counts:{total,installed,pending,forked},
   *     skills:[{ name, description, license, source, requires, riskNotes, sha256,
   *               state, installed, ours, modified, optedOut, file, installedSha,
   *               catalogSha, sourceCatalog, suggestion? }] }
   * `state`: absent · opted-out · installed · update-available · forked ·
   *          forked-update · conflict · tampered · orphan · missing-catalog
   */
  builtinList: () => ipcRenderer.invoke('skills:builtinList'),
  /**
   * SKL-B6 — DAHİLİ SKILL'İ KUR/GÜNCELLE. `opts`: `{ installAs, force }`.
   * → { ok, changed, action:'installed'|'updated'|'unchanged'|'none', name, file, errors }
   * `ok:false` + `errors[0].code`: `name-conflict` (+`suggestion`) · `user-modified`
   * (çatal — `force` ikinci onayı ister) · `builtin-tampered` · `secret-scan` ·
   * `not-in-catalog` · `no-workspace`.
   * 🔴 Sessiz üzerine yazma YOK: kullanıcının kendi skill'i ve DÜZENLEDİĞİ kopya
   * bu uçtan ezilemez. ONAYLAYAN damgasını main yazar (burada gönderilemez).
   */
  builtinInstall: (name, opts) => ipcRenderer.invoke('skills:builtinInstall', name, opts),
  /**
   * SKL-B6 — DAHİLİ SKILL'İ KALDIR: kurulu kopya + motor bağları gider ve tercih
   * KALICI olur (bir sonraki açılış geri kurmaz). Yalnız `origin: builtin` kopyayı
   * siler — kullanıcının kendi skill'ine dokunmaz (`not-ours`).
   * → { ok, changed, action:'removed'|'unchanged', name, errors }
   */
  builtinUninstall: (name) => ipcRenderer.invoke('skills:builtinUninstall', name),
});

// ═══════════════════════════════════════════════════════════════════════════════
// SYNC-F1-6 — BULUT SENKRONU köprüsü (Ayarlar → Senkron)
// ═══════════════════════════════════════════════════════════════════════════════
// 🔴 GÖVDE BU KÖPRÜDEN GEÇMEZ. Çakışma listesi hafıza dosyalarının İÇERİĞİNİ
// taşıyabilirdi (`loser_body` 64 KB'a kadar); `syncIpc.conflictView` onu keser ve
// "kaybedeni yanına yaz" eylemi baytı MAIN tarafında diske yazıp renderer'a yalnız
// YAZILAN YOLU söyler. Böylece hafıza içeriği DevTools'a, bir XSS yüzeyine ya da
// bir renderer log satırına hiç girmez.
