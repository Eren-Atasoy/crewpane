// ADP-816 (SPRINT-AGENTX-VOICE · Faz 4) — TAŞINABİLİR SES WIDGET'I: saf karar katmanı.
//
// Widget, ana pencerenin DIŞINDA yaşayan frameless/always-on-top küçük bir
// penceredir (BrowserWindow tarafı main.js'te, ADP-593 pop-out kalıbının
// birebir uyarlaması). Bu dosyada pencere YOK — yalnız test edilebilir saf
// kararlar:
//
//   • normalizeSnapshot() — renderer'dan gelen durum fotoğrafının şekil/uzunluk
//     nöbeti. Widget penceresi bu fotoğrafı EKRANA basar; kirli/dev bir metin
//     doğrudan bir pencereye gitmemeli.
//   • defaultBounds()    — ilk açılışta pencere NEREYE konur (sağ-üst köşe;
//     ortalanmış bir overlay altındaki uygulamayı kapatır).
//   • nextPosition()     — sürükleme sonucu konum + "ekran dışına kaçmasın"
//     kelepçesi. Widget'ın en az bir tutamağı her zaman çalışma alanında kalır,
//     yoksa kullanıcı onu geri getiremez (frameless → pencere menüsü de yok).
//
// popoutBounds.cjs'in KONUM DEFTERİ aynen kullanılır (yeni depo icat edilmedi);
// oradaki MIN_SIZE (360×240) bu widget'ın ölçüsünü de belirledi — daha küçüğü
// defter tarafından "geçersiz" sayılıp hiç hatırlanmazdı.

'use strict';

/** Widget penceresinin sabit ölçüsü (resizable:false — transparan pencere + macOS). */
const SIZE = Object.freeze({ width: 400, height: 260 });
/** Ekran kenarından ilk açılış boşluğu. */
const MARGIN = 24;
/** Sürüklerken çalışma alanında kalması ZORUNLU en küçük görünür parça. */
const KEEP_VISIBLE = 64;
/** Ekrana basılan metinlerin tavanı (widget bir konsol değil, bir bakış penceresi). */
const TEXT_MAX = 400;

/** Widget'ın gösterebileceği durumlar (renderer'ın JarvisState'i ile aynı sözlük). */
const STATES = Object.freeze(['idle', 'listening', 'thinking', 'speaking', 'error']);

function finite(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Tek satır metin nöbeti: string değilse null, uzunsa kırpılır (kırpma görünür). */
function cleanText(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX - 1)}…` : t;
}

/** { text, source } biçimli mesaj satırı (kirli girdi → null). */
function cleanLine(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = cleanText(raw.text);
  if (!text) return null;
  const source = typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim().slice(0, 24) : 'desktop';
  return { text, source };
}

/**
 * Renderer → main → widget penceresi yolunda taşınan durum fotoğrafı.
 * ŞEKİL GARANTİSİ: her alan HER ZAMAN vardır (widget "alan yok" dalı taşımaz).
 * `live` alanı main tarafından yazılır (yayıncı pencere hâlâ açık mı) — renderer
 * kendi canlılığını iddia edemez.
 */
function normalizeSnapshot(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const state = STATES.includes(src.state) ? src.state : 'idle';
  return {
    state,
    // Kısmi hipotezin HAM hâli taşınır; yazma efektini widget penceresi KENDİ
    // çalıştırır (typewriterStep) → IPC trafiği ~2/sn kalır, 20/sn değil.
    partial: cleanText(src.partial) || '',
    // ADP-912 (b) — bu metin ARTIK hipotez değil, FİNALE HİZALANMIŞ hâli mi?
    // Üç yüzey aynı gerçeği çizmek zorunda (ADP-814 2. tur sözleşmesi): bayrak
    // taşınmazsa taşınabilir pencere düzeltmeyi hipotez gibi gösterirdi.
    aligned: src.aligned === true,
    user: cleanLine(src.user),
    reply: cleanLine(src.reply),
    action: cleanText(src.action),
    ack: cleanText(src.ack),
    at: finite(src.at) ? src.at : 0,
  };
}

/** Hiç yayın olmamışken widget'ın gösterdiği boş fotoğraf. */
function emptySnapshot() {
  return normalizeSnapshot(null);
}

/**
 * İlk açılış konumu: çalışma alanının SAĞ-ÜST köşesi (ADP-138'in tersi bilinçli —
 * ana pencerenin kendi widget'ı sol-altta yaşıyor; ikisi üst üste binmesin).
 * workArea yoksa konumsuz döner → Electron ortalar (davranış hâlâ geçerli).
 */
function defaultBounds(workArea, size = SIZE) {
  const w = size.width;
  const h = size.height;
  if (!workArea || ![workArea.x, workArea.y, workArea.width, workArea.height].every(finite)) {
    return { width: w, height: h };
  }
  return {
    x: Math.round(workArea.x + workArea.width - w - MARGIN),
    y: Math.round(workArea.y + MARGIN),
    width: w,
    height: h,
  };
}

/**
 * Sürükleme sonrası konum. dx/dy EKRAN koordinatında delta'dır (widget renderer'ı
 * pointer olaylarından hesaplar). Kelepçe: pencerenin en az KEEP_VISIBLE kadarı
 * çalışma alanında kalır — frameless bir pencere ekran dışına kaçarsa geri
 * getirilemez (başlık çubuğu yok).
 */
function nextPosition(bounds, dx, dy, workArea) {
  const b = bounds && typeof bounds === 'object' ? bounds : {};
  const x0 = finite(b.x) ? b.x : 0;
  const y0 = finite(b.y) ? b.y : 0;
  const w = finite(b.width) ? b.width : SIZE.width;
  const h = finite(b.height) ? b.height : SIZE.height;
  let x = Math.round(x0 + (finite(dx) ? dx : 0));
  let y = Math.round(y0 + (finite(dy) ? dy : 0));
  if (workArea && [workArea.x, workArea.y, workArea.width, workArea.height].every(finite)) {
    const minX = Math.round(workArea.x - (w - KEEP_VISIBLE));
    const maxX = Math.round(workArea.x + workArea.width - KEEP_VISIBLE);
    const minY = Math.round(workArea.y); // üstte menü çubuğunun altına kilitle
    const maxY = Math.round(workArea.y + workArea.height - KEEP_VISIBLE);
    x = Math.min(Math.max(x, minX), maxX);
    y = Math.min(Math.max(y, minY), maxY);
  }
  return { x, y, width: w, height: h };
}

module.exports = {
  SIZE,
  MARGIN,
  KEEP_VISIBLE,
  TEXT_MAX,
  STATES,
  cleanText,
  cleanLine,
  normalizeSnapshot,
  emptySnapshot,
  defaultBounds,
  nextPosition,
};
