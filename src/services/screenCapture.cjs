// ADP-817 (FAZ 5, ADR-016) — Agent X'in EKRAN GÖRÜNTÜSÜ eylemi: main-ipc çekirdeği.
//
// 804 §6 satır 8: "ekran görüntüsü al ve bir ajana bağlamla ilet" bugün YOK —
// `screenshotApi` ADP-440'ta preload'dan kaldırıldı (özellik AgentShot'a taşındı).
// Bu modül o ÜRÜN yüzeyini geri getirmez (galeri/tray/annotator/⌘⇧2 YOK): yalnız
// sesli komutun ihtiyaç duyduğu tek şeyi yapar — bir kare al, diske yaz, yolunu ver.
//
// NEDEN shot-core DEĞİL: `packages/shot-core/capture.cjs` bu deponun kanıtlı
// yakalama motorudur AMA CrewPane onu ADP-440'ta TÜKETMEYİ BIRAKTI ve bunu bir
// guard'la sabitledi (`shotCorePackaging.test.cjs`: main.js shot-core require
// EDEMEZ + build fileset/asarUnpack onu TAŞIMAZ). Geri bağlamak paketleme
// fileset'i + afterPack guard'ı geri getirmeyi gerektirir — paketli app'te eksik
// require sessiz ölümdür (ADP-753 sınıfı). O motorun getirdiği şey de bize gerekmiyor:
// bölge overlay'i, ekran-başına donmuş kareler, crop matematiği. Bize gereken TEK
// satır: ana ekranı bir dosyaya yaz. Bu yüzden burada aynı BİRİNCİL yolu
// (`/usr/sbin/screencapture`, sabit argümanlar → shell yok, injection yok)
// doğrudan çağırıyoruz; motor "fork"u değil, tek komut.
//
// TESLİM MANTIĞI DA YOK: yakalanan dosyanın ajana iletilmesi renderer'da,
// `tell`in kullandığı TEK huniden (sendCommandToAgent) geçer — bkz. actionBus.ts
// `executeScreen`. Bu modül dosya üretir, kimseye göndermez.
//
// Saf + DI (shot-core deseni): fs/execFile/pencere-yakalayıcı `deps` ile gelir →
// `node --test` altında Electron'suz koşar.

'use strict';

const nodePath = require('node:path');

/** Yakalama kapsamı: tüm ekran (TCC ister) · yalnız uygulama penceresi (izin İSTEMEZ). */
const CAPTURE_SCOPES = ['screen', 'window'];

/** Not/bağlam metni tavanı — pane'e yazılacak satır, roman değil. */
const MAX_NOTE_LEN = 500;
/** agentId/ad alanı tavanı (renderer zaten roster'dan çözer; yine de girişi şekillendir). */
const MAX_AGENT_LEN = 120;

/**
 * Renderer'dan gelen ham isteği doğrula (inputSim.validateInputAction deseni).
 * → { ok:true, req:{ scope, agentId, note } } | { ok:false, error }
 */
function validateCaptureRequest(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const scope = r.scope === undefined || r.scope === null ? 'screen' : String(r.scope);
  if (!CAPTURE_SCOPES.includes(scope)) {
    return { ok: false, error: `bilinmeyen kapsam '${scope}' (${CAPTURE_SCOPES.join('|')})` };
  }
  const agentId = typeof r.agentId === 'string' && r.agentId.trim() ? r.agentId.trim() : null;
  if (agentId && agentId.length > MAX_AGENT_LEN) return { ok: false, error: 'agentId çok uzun' };
  const note = typeof r.note === 'string' && r.note.trim() ? r.note.trim() : null;
  if (note && note.length > MAX_NOTE_LEN) return { ok: false, error: `not çok uzun (tavan ${MAX_NOTE_LEN})` };
  return { ok: true, req: { scope, agentId, note } };
}

/**
 * Dosya adı: sıralanabilir + ':' içermez (macOS Finder ':' → '/' gösterir) +
 * kapsamı taşır. `date` verilir (test determinizmi; Date.now() gizli girdi olmaz).
 */
function shotFileName(date, scope) {
  const d = date instanceof Date ? date : new Date(date || 0);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp =
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `agentx-${stamp}-${CAPTURE_SCOPES.includes(scope) ? scope : 'screen'}.png`;
}

/**
 * @param {object} opts
 *   dir    yakalanan PNG'lerin kalıcı dizini (hesap kökü — ADP-703 crewpaneHome())
 *   deps   { fs, execFile, captureWindow?: () => Promise<nativeImage|null>,
 *            platform?: string, now?: () => Date, log?: (line) => void }
 */
function createScreenCapture(opts) {
  const { dir, deps } = opts || {};
  const log = (deps && deps.log) || (() => {});
  const now = (deps && deps.now) || (() => new Date());
  const platform = (deps && deps.platform) || process.platform;

  /** `/usr/sbin/screencapture -x -m <dest>` → ana ekran, sessiz, tek dosya. */
  function runScreencapture(dest) {
    return new Promise((resolve) => {
      deps.execFile('/usr/sbin/screencapture', ['-x', '-m', dest], { timeout: 10000 }, (err) => {
        resolve(err ? { ok: false, error: err.message } : { ok: true });
      });
    });
  }

  /**
   * Bir kare al ve `dir` altına yaz.
   * → { ok:true, path, bytes, scope } | { ok:false, reason, error }
   *
   * DÜRÜST HATA KURALI: boş kare "sessizce başka motora düş" DEĞİL, kullanıcıya
   * neyin eksik olduğunu SÖYLEYEN bir ret üretir (ADP-813 fallback dersi) —
   * macOS'ta boş kare pratikte TEK bir şey demektir: Ekran Kaydı izni yok.
   */
  async function capture(req) {
    const v = validateCaptureRequest(req);
    if (!v.ok) return { ok: false, reason: 'invalid', error: v.error };
    const { scope } = v.req;
    try {
      deps.fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      return { ok: false, reason: 'write-failed', error: `dizin açılamadı: ${e.message}` };
    }
    const dest = nodePath.join(dir, shotFileName(now(), scope));

    if (scope === 'window') {
      if (!deps.captureWindow) return { ok: false, reason: 'no-window', error: 'uygulama penceresi yok' };
      let img;
      try {
        img = await deps.captureWindow();
      } catch (e) {
        return { ok: false, reason: 'capture-failed', error: `pencere karesi alınamadı: ${e.message}` };
      }
      if (!img || (typeof img.isEmpty === 'function' && img.isEmpty())) {
        return { ok: false, reason: 'capture-failed', error: 'pencere karesi boş' };
      }
      try {
        const buf = img.toPNG();
        deps.fs.writeFileSync(dest, buf);
        log(`screen.capture: window → ${dest} (${buf.length} bayt)`);
        return { ok: true, path: dest, bytes: buf.length, scope };
      } catch (e) {
        return { ok: false, reason: 'write-failed', error: `yazılamadı: ${e.message}` };
      }
    }

    // scope === 'screen' — native `screencapture` (macOS'a özel; başka platformda
    // pencere kapsamı çalışır, ekran kapsamı DÜRÜSTÇE reddedilir).
    if (platform !== 'darwin') {
      if (deps && deps.captureWindow) {
        log('screen.capture: Windows platformunda pencere yakalamaya yonlendirildi');
        return capture({ ...req, scope: 'window' });
      }
      return {
        ok: false,
        reason: 'unsupported',
        error: 'Tüm-ekran yakalama şimdilik yalnız macOS\'ta — "pencerenin ekran görüntüsünü al" diyebilirsin.',
      };
    }
    const run = await runScreencapture(dest);
    if (!run.ok) return { ok: false, reason: 'capture-failed', error: `ekran karesi alınamadı: ${run.error}` };
    // TCC reddinde `screencapture` ÇIKIŞ KODU 0 verip dosyayı hiç yazmayabilir ya da
    // boş bırakabilir → "komut hata vermedi" kanıt DEĞİL; dosyayı ÖLÇ (ADP-813 dersi:
    // sessizce başka yola düşme, eksik olanı SÖYLE).
    let bytes = 0;
    try { bytes = deps.fs.statSync(dest).size; } catch { bytes = 0; }
    if (!bytes) {
      try { deps.fs.unlinkSync(dest); } catch { /* best-effort */ }
      return {
        ok: false,
        reason: 'no-permission',
        error:
          'Ekran karesi boş geldi — macOS Ekran Kaydı izni verilmemiş olabilir ' +
          '(Sistem Ayarları → Gizlilik ve Güvenlik → Ekran Kaydı). Uygulama penceresini ' +
          'istiyorsan "pencerenin ekran görüntüsünü al" diyebilirsin.',
      };
    }
    log(`screen.capture: screen → ${dest} (${bytes} bayt)`);
    return { ok: true, path: dest, bytes, scope };
  }

  return { capture };
}

module.exports = {
  CAPTURE_SCOPES,
  MAX_NOTE_LEN,
  validateCaptureRequest,
  shotFileName,
  createScreenCapture,
};
