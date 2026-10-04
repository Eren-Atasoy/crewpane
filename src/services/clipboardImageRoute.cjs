'use strict';

// WIN-IMG-01 — "PANODAKİ GÖRÜNTÜ PANE'E NASIL İNER?" kararı (saf + platformlu).
//
// ADP-925 bu kararı `main.js` içinde, tek satırlık bir tabloyla veriyordu:
//
//     const ENGINE_CLIPBOARD_IMAGE_KEYS = Object.freeze({ claude: '\x16' });
//
// Tablo PLATFORMSUZDU ama ölçüm DEĞİLDİ: `\x16` → `[Image #1]` davranışı YALNIZ
// macOS'ta, gerçek claude TUI'sinde ölçülmüştü. Windows'ta aynı bayt pane'e
// yazılıyor ve karşılığı OLMAYABİLİYOR — o durumda kullanıcıya HİÇBİR ŞEY
// olmuyor, log'a bile bir şey düşmüyor (ham kontrol karakteri sessizce yutulur).
// Müşteri kanıtı (Windows, v0.2.31 — bu sürüm ADP-925'i İÇERİR): "Terminalden
// hiç iletilmiyor zaten."
//
// KARAR: tablo artık PLATFORM × MOTOR. Yalnız ÖLÇÜLEN hücre motor-tuşu yolunu
// kullanır; ölçülmemiş her hücre ÖLÇÜLMÜŞ İKİNCİ yola düşer — geçici PNG + YOL
// yapıştırma (sürükle-bırakın ta kendisi; ADP-371'de claude'un yolu Read ile
// GERÇEKTEN açtığı renk-bandı kanıtıyla ölçüldü). Yol yapıştırma en kötü ihtimalle
// kullanıcının GÖREBİLECEĞİ bir metin bırakır; görünmez kontrol baytı bırakmaz.
//
// Üçüncü yol WINDOWS'A ÖZGÜ ve bugüne kadar HİÇ YOKTU: Explorer'da bir görsele
// Ctrl+C basmak panoya BİTMAP koymaz, DOSYA LİSTESİ (CF_HDROP / `FileNameW`)
// koyar. `clipboard.readImage()` orada BOŞ döner, `readText()` de boş ⇒ eski kod
// `webContents.paste()` çağırıp hiçbir şey yapmıyordu. Artık dosya yolu tanınır.
//
// Saf modül: Electron'a bağlı değil, `node --test` ile üç platform da sınanır.

/** ÖLÇÜLMÜŞ hücreler: platform → motor → motorun kendi pano-görüntü tuşu. */
const ENGINE_CLIPBOARD_IMAGE_KEYS = Object.freeze({
  // ADP-925, gerçek claude v2.1.223 TUI'si, macOS: `\x16` → `[Image #1]`.
  darwin: Object.freeze({ claude: '\x16' }),
  // win32 / linux: ÖLÇÜLMEDİ ⇒ hücre YOK ⇒ yol yapıştırmaya düşer (bilerek boş).
});

/** Bu yol ajana verilebilecek bir görsel mi? (renderer'daki `isImagePath` ile aynı kural.) */
function isImagePath(p) {
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(String(p || '').trim());
}

/**
 * Yapıştırma yolunu seç.
 *
 * @param {object} input
 * @param {'darwin'|'win32'|'linux'} input.platform
 * @param {string|null} input.engine  pane'in KOŞTURDUĞU CLI (`ptys` kaydından — çağıranın iddiasından değil)
 * @param {boolean} input.hasImage    panoda bitmap var mı (`clipboard.readImage()` dolu)
 * @param {boolean} input.hasText     panoda düz metin var mı (metin ÖNCELİKLİ — ADP-925 duruşu)
 * @param {string[]} [input.filePaths] panodaki dosya listesi (Windows `FileNameW`)
 * @returns {{kind:'text'}|{kind:'engine-keys',keys:string}|{kind:'image'}|{kind:'file-path',paths:string[]}}
 */
function routeClipboardPaste(input) {
  const platform = input && input.platform;
  const engine = input && input.engine;
  // 1. METİN ÖNCELİKLİ. Bir web sayfasından "kopyala" çoğu zaman metinle BİRLİKTE
  //    görüntü bırakır; kullanıcının beklediği metindir (ADP-925 kararı korunur).
  if (input && input.hasText) return { kind: 'text' };

  // 2. Panoda BİTMAP.
  if (input && input.hasImage) {
    const keys = (ENGINE_CLIPBOARD_IMAGE_KEYS[platform] || {})[engine];
    if (keys) return { kind: 'engine-keys', keys };
    return { kind: 'image' }; // ölçülmemiş hücre → geçici PNG + YOL (görünür yol)
  }

  // 3. Panoda DOSYA (Windows Explorer kopyası). Bitmap yok ama gerçek bir dosya var:
  //    yolu doğrudan yapıştırılır — geçici kopya yazmaya gerek YOK.
  const files = (input && input.filePaths) || [];
  const images = files.map((p) => String(p || '').trim()).filter((p) => p && isImagePath(p));
  if (images.length) return { kind: 'file-path', paths: images };

  // 4. Aksi hâlde bugünkü metin yolu, DEĞİŞMEDEN.
  return { kind: 'text' };
}

module.exports = { routeClipboardPaste, isImagePath, ENGINE_CLIPBOARD_IMAGE_KEYS };
