// CrewPane — Mobile Gateway Static Web UI Server (Phase 4.12)
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { WEB_MIME } = require('./constants.js');

/**
 * ADP-556 — statik web dosyası sun. Yol webRoot İÇİNDE kalmak zorunda (normalize +
 * prefix kontrolü traversal'ı yapısal keser); dosya yoksa SPA fallback → index.html
 * (tarayıcıda uygulama-içi rotayı yenilemek de açılır). Hash'li expo çıktıları
 * (_expo/, assets/) içerik-adresli → 1 yıl immutable cache; index.html no-store
 * (yeni build'de taze bundle'a işaret eden tek dosya odur).
 * Dönüş: audit notu için webRoot'a göre servis edilen dosya yolu — ya da
 * `null`: istenen VARLIK (uzantılı yol) yok, çağıran 404 döndürmeli.
 */
function serveWeb(pathname, res, webRoot) {
  let rel = '/';
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    /* bozuk kaçış → SPA fallback */
  }
  const resolved = path.normalize(path.join(webRoot, rel.replace(/\\/g, '/')));
  let file = null;
  if (resolved === webRoot || resolved.startsWith(webRoot + path.sep)) {
    try {
      if (fs.statSync(resolved).isFile()) file = resolved;
    } catch {
      /* yok → SPA fallback */
    }
  }
  const isSpaFallback = !file;
  // MOB-UX-M1 (M1-a) — VARLIK YOLU SPA'ya DÜŞMEZ. Eskiden bulunamayan HER yol
  // 200 + index.html dönüyordu: yanlış yazılmış bir `manifest.webmanifest` /
  // `icon-192.png` hata vermeden HTML alıyordu ve PWA kabuğu SESSİZCE bozuluyordu
  // (ölçüldü — MOB-UX-R1 §7.1: `/sw.js` → "unsupported MIME type ('text/html')").
  // Kural yola bakar, ada değil: uzantısı olan ve `.html` OLMAYAN yol bir dosya
  // talebidir → yoksa 404. Uzantısız yollar (SPA rotaları) eskisi gibi index.html.
  const ext = path.extname(rel).toLowerCase();
  if (isSpaFallback && ext && ext !== '.html' && ext !== '.htm') return null;
  if (!file) file = path.join(webRoot, 'index.html');
  const body = fs.readFileSync(file);
  const hashed = !isSpaFallback && (rel.startsWith('/_expo/') || rel.startsWith('/assets/'));
  res.writeHead(200, {
    'content-type': WEB_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': body.length,
    'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
  return path.relative(webRoot, file);
}

module.exports = {
  serveWeb,
};
