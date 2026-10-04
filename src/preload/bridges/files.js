'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('imageApi', {
  saveTemp: (payload) => ipcRenderer.invoke('image:saveTemp', payload),
  /** → { ok, missing:[], foreign:[], present:[] } */
  verify: (paths) => ipcRenderer.invoke('image:verify', paths),
});

// BOARD-IMG-3 — GÖREV KARTI EKLERİ köprüsü (task_attachments).
// `imageApi` ile karıştırılmasın: o OTURUMLUK bir temp dosyası üretir (ajana yol
// verilir, kapanışta silinir); bu KALICI bir ek deposudur (kart kanıtı yıllarca
// durur). Renderer'a fs AÇILMAZ — baytlar main'de doğrulanır, geri yalnız
// metadata + data-URI gelir.

contextBridge.exposeInMainWorld('attachmentApi', {
  /**
   * Bir görseli depoya al. `path` (native drop / MCP) YA DA `data` (⌘V, dosya
   * seçici) verilir. → { ok, sha256, mime, bytes, width, height, localRelPath,
   * thumbDataUrl, originDevice, title, kind, source } | { ok:false, reason }
   */
  ingest: (payload) => ipcRenderer.invoke('attachment:ingest', payload),
  /** local_rel_path → { ok, dataUrl, mime, bytes } | { ok:false, reason:'missing' } */
  read: (relPath) => ipcRenderer.invoke('attachment:read', relPath),
  /** → { ok, present } — tam çözünürlük BU cihazda var mı? */
  hasBytes: (relPath) => ipcRenderer.invoke('attachment:hasBytes', relPath),
  /** Baytları diskten sil (satırın tombstone'u ÇAĞIRANIN işi). */
  removeBytes: (relPath) => ipcRenderer.invoke('attachment:removeBytes', relPath),
});

// FDBK-01 — UYGULAMA İÇİ GERİ BİLDİRİM köprüsü (salt-okunur, üç uç).
// Renderer'a fs AÇILMAZ: log kesiti MASKELENMİŞ metin, çekimler data-URI olarak
// gelir. Kaydın kendisini (INSERT) renderer supabase istemcisiyle yazar.

contextBridge.exposeInMainWorld('officePackApi', {
  /** → { ok, path, bytes, sha256 } | { ok:false, error } */
  exportPack: (pack, skills) => ipcRenderer.invoke('office:exportPack', { pack, skills }),
  /** → { ok, pack, skills:[{name,text,sha256,bytes}], warnings } | { ok:false, error } */
  readPack: (zipPath) => ipcRenderer.invoke('office:readPack', zipPath),
});

// ADP-440 — screenshotApi kaldırıldı: ekran görüntüsü özelliği AgentShot'a
// taşındı (ayrı ürün). fileDropApi AŞAĞIDA KALIR — AgentShot panelinden pane'e
// native dosya sürüklemesi bu köprüyü kullanır.
// ADP-143 (ADR-008 Faz 2 fix) — drop-path bridge. Electron 32+ REMOVED `File.path`, so
// the tray's NATIVE file drag (webContents.startDrag) drops a File whose `.path` is now
// `undefined` → the old screenshotDrop native branch resolved to null → "tray görseli
// terminale eklenmiyor" (Eren). `webUtils.getPathForFile(file)` is the documented
// replacement: it returns the real on-disk path for an OS-originated File. Renderer-safe
// (webUtils is exposed to the preload), read-only, no fs surface leaked.

contextBridge.exposeInMainWorld('fileDropApi', {
  /** Resolve a dropped File's absolute on-disk path (replaces removed File.path). */
  getPathForFile: (file) => {
    try {
      return webUtils && typeof webUtils.getPathForFile === 'function'
        ? webUtils.getPathForFile(file)
        : '';
    } catch {
      return '';
    }
  },
});

// ADP-082 (ADR-006 Karar 1) — workspace file bridge for the embedded code editor.
// A minimal, whitelisted, root-guarded fs surface (main-side enforces the
// workspace-root boundary + size cap + symlink-escape rejection). The renderer
// stays sandboxed (no raw fs) — these three channels are the only file access.

contextBridge.exposeInMainWorld('fileApi', {
  /** Read a workspace file as UTF-8 → { ok, content, encoding, path } | { ok:false, reason }. */
  read: (p) => ipcRenderer.invoke('file:read', p),
  /** Write UTF-8 content to a workspace file → { ok, bytes, path } | { ok:false, reason }. */
  write: (p, content) => ipcRenderer.invoke('file:write', { path: p, content }),
  /** List a workspace directory → { ok, dir, entries:[{name,path,type}] } | { ok:false, reason }. */
  list: (dir) => ipcRenderer.invoke('file:list', dir),
  /**
   * ADP-103 — open the OS directory picker; the chosen dir becomes a new active root
   * (the only way to browse outside the workspace) → { ok, root, name } | { ok:false, reason }.
   */
  openDialog: () => ipcRenderer.invoke('file:openDialog'),
  /**
   * ADP-108 — live-watch: grant the editor read access to a WATCHED pane's cwd and
   * learn that cwd (+ home + workspace root) so the renderer can rebase the relative
   * path the agent prints to the absolute file it wrote → { ok, cwd, home,
   * workspaceRoot } | { ok:false, reason }. Keyed to a main-spawned paneId (no path
   * is supplied by the renderer), so the ADP-103 sandbox model is preserved.
   */
  allowPaneRoot: (paneId) => ipcRenderer.invoke('file:allowPaneRoot', paneId),
  /**
   * ADP-109 — editor start-experience persistence (last-session + recent). SYNC get
   * (so the renderer reads it during mount without an async flash) + async set. Stored
   * in userData main-side because the embedded server's RANDOM per-launch port makes
   * the renderer origin (and thus localStorage) change on every restart.
   */
  getEditorState: () => ipcRenderer.sendSync('file:editorState:get'),
  setEditorState: (state) => ipcRenderer.invoke('file:editorState:set', state),
});

// ADP-538 — worker-completion notify emit: delegasyon follow-loop'u (renderer)
// completion olayını main'e taşır, main notify-log'a legacy-uyumlu DONE/FAIL/
// TIMEOUT/REPORT satırı ekler (liderlerin Monitor tail'inin ateşlendiği dosya).

// ADP-694 — PANO KÖPRÜSÜ. `navigator.clipboard.writeText` Electron penceresi odakta
// değilken REDDEDİLİYOR (gerçek e2e'de ölçüldü: "Kopyala" sessizce hiçbir şey
// kopyalamıyordu). Masaüstü uygulamasında doğru yol main'in `clipboard` modülüdür.
// TEK YÖN: yalnız YAZMA açık — pano OKUMA ucu bilerek yok.
contextBridge.exposeInMainWorld('clipboardApi', {
  /** Düz metni panoya yaz → { ok } (main tarafında boy sınırlı). */
  write: (text) => ipcRenderer.invoke('clipboard:write', text),
  /**
   * ADP-894 — ODAKLI yüzeye YAPIŞTIR → { ok, kind }. Windows'ta Ctrl+V'yi xterm
   * `\x16` olarak yutuyor (ölçüldü) → yapıştırma hiç çalışmıyordu; macOS'ta
   * aynı işi Electron'un varsayılan Edit menüsü `webContents.paste()` ile
   * yapıyor. Bu uç o menü öğesinin ta kendisidir.
   *
   * ADP-925 — panoda GÖRÜNTÜ varsa (ve metin yoksa) main bir TESLİMAT DİREKTİFİ
   * döner; `paneId` verilirse motoruna göre karar verir:
   *   • `{ kind:'engine-keys', keys }` → çağıran bu baytı pane'e YAZAR; motor
   *     panoyu kendisi okur (ölçüldü: claude `\x16` → `[Image #1]`).
   *   • `{ kind:'image', path }`       → main görüntüyü temp PNG'ye yazdı;
   *     çağıran YOLU pane'e yapıştırır (kabuk pane'leri).
   *   • `{ kind:'text' }`              → metin yolu main'de zaten koştu.
   *
   * GÜVENLİK: pano İÇERİĞİ renderer'a GEÇMEZ — metinde main yalnız yerel
   * "yapıştır" komutunu çalıştırır; görüntüde geçen şey ya sabit bir kontrol
   * baytı ya da temp dosya YOLUdur. "Okuma ucu yok" duruşu (yukarıda) korunur.
   */
  pasteFocused: (opts) => ipcRenderer.invoke('clipboard:pasteFocused', opts),
});

// ADP-935 — PANO GEÇMİŞİ KÖPRÜSÜ. Yukarıdaki "pano OKUMA ucu YOK" duruşunun
// bilinçli ve DAR bir istisnası: renderer hâlâ SİSTEM panosunu okuyamaz — yalnız
// main'in KENDİ tuttuğu, gizlilik kapısından geçmiş geçmişi okur. `list` tam metin
// DEĞİL önizleme döndürür; tam metin yalnız kullanıcı bir öğeyi TIKLADIĞINDA
// (`deliver`) ve yalnız o öğe için geçer.

contextBridge.exposeInMainWorld('clipApi', {
  /** → { ok, items:[{id,kind,at,preview,chars,width,height,bytes,thumb}] } (en yeni başta). */
  list: () => ipcRenderer.invoke('clip:list'),
  /**
   * Öğeyi panoya geri koy + pane'e nasıl ineceğini söyle → aynı sözleşme
   * `clipboard:pasteFocused` ile (ADP-925):
   *   • `{ kind:'text', text }`        → çağıran metni pane'e YAPIŞTIRIR (Enter YOK)
   *   • `{ kind:'engine-keys', keys }` → çağıran kontrol baytını yazar, motor panoyu okur
   *   • `{ kind:'image', path }`       → çağıran temp PNG YOLUnu yapıştırır (kabuk pane'i)
   */
  deliver: (itemId, paneId) => ipcRenderer.invoke('clip:deliver', { itemId, paneId }),
  /** Tek öğeyi geçmişten sil → { ok }. */
  remove: (itemId) => ipcRenderer.invoke('clip:remove', itemId),
  /** Geçmişin tamamını sil → { ok, removed }. */
  clear: () => ipcRenderer.invoke('clip:clear'),
  /** Geçmiş değişti (yeni kopya / silme). Aboneliği bırakan fonksiyon döner. */
  onChanged: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('clip:changed', listener);
    return () => ipcRenderer.removeListener('clip:changed', listener);
  },
});


contextBridge.exposeInMainWorld('officeStateApi', {
  get: () => ipcRenderer.sendSync('office:state:get'),
  set: (state) => ipcRenderer.invoke('office:state:set', state),
});

// FDBK-F1 — geri bildirim bildiriminin FİLİGRANI ({ [kod]: updated_at }).
// officeStateApi ile AYNI gerekçe ve aynı şekil: rastgele per-launch port →
// origin her açılışta değişir → localStorage silinir. Filigran silinince zil,
// kullanıcının açık kayıtlarını HER açılışta yeniden duyururdu. SYNC get (zil
// mount'ta okur, async titreme olmasın) + async set.
