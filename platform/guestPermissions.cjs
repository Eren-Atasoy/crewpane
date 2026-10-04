// WIN-FIX-01 (W5) — İÇ TARAYICI MİSAFİRİNİN İZİN POLİTİKASI (bugüne dek YOKTU).
//
// ÖLÇÜLEN DURUM (kod okumasıyla, hipotez değil):
//   • `main.js` `setPermissionRequestHandler`ı YALNIZ uygulama penceresinin
//     oturumuna bağlıyor (`win.webContents.session`, main.js §createWindow) ve
//     orada yalnız `media`ya izin veriyor — bu doğru ve dar.
//   • İç tarayıcı ise AYRI bir oturumda koşuyor: `<webview partition=
//     "persist:crewpane-browser">` (src/app/components/InternalBrowser.tsx:51).
//     O oturuma HİÇBİR handler bağlanmıyor.
//   • Electron'da handler BAĞLANMAMIŞ bir oturumda izin isteği VARSAYILAN OLARAK
//     ONAYLANIR. Yani iç tarayıcıda açılan HERHANGİ bir site bugün mikrofon,
//     kamera, konum, bildirim ve MIDI iznini SORULMADAN alıyor.
//
// WINDOWS'TA GÖRÜNEN YÜZÜ (WIN-R1 §W5 — "izin filan istemiş, takılmışlar burda"):
// Chromium izni verdiği anda çağrı İŞLETİM SİSTEMİNE iner. Windows 11 kamera/
// mikrofonu UYGULAMA seviyesinde kapılar ve bildirimleri Focus Assist'e bağlar →
// kullanıcı BİZİM hiç sormadığımız, sayfanın tetiklediği SİSTEM diyaloglarıyla
// karşılaşır. macOS'ta aynı şey TCC diyaloğu olarak çıkar ama tester Windows'taydı.
//
// KARAR: VARSAYILAN RET + ÇOK DAR BİR BEYAZ LİSTE.
// Bu, güvenlik duruşunu GEVŞETMEZ — TERSİNE sıkar (bugün hepsi onaylı). Görevin
// "yeni izin TÜRÜ ekleme, sadece spam'i kes" şartı bu yönde birebir sağlanıyor:
// beyaz listede YALNIZ görüntüleme için zorunlu, cihaz/veri erişimi OLMAYAN
// izinler var.
//
// BEYAZ LİSTE ve NEDENİ (her biri tek tek gerekçeli — "her ihtimale karşı" YOK):
//   • fullscreen               → video sitelerinde tam ekran; reddedilirse
//                                YouTube/Vimeo tam ekran düğmesi ÖLÜR (ADP-905
//                                tam-ekran nöbetçisi zaten bu yolu bekliyor).
//   • clipboard-sanitized-write→ "kopyala" düğmeleri. Yalnız YAZMA ve yalnız
//                                temizlenmiş içerik; OKUMA (`clipboard-read`)
//                                beyaz listede DEĞİLDİR (pano hırsızlığı).
//   • pointerLock              → tarayıcı içi harita/oyun sürüklemesi; cihaz
//                                erişimi yok, kullanıcı ESC ile her an çıkar.
//
// AÇIKÇA REDDEDİLENLER (bugün hepsi ONAYLI): media (kamera/mikrofon), geolocation,
// notifications, midi/midiSysex, hid, serial, usb, bluetooth, clipboard-read,
// idle-detection, window-management, openExternal, display-capture.
//
// SAF MODÜL: hiçbir Electron API'si çağırmaz → birim testi hermetik.
// Çalıştır: node --test electron/platform/guestPermissions.test.cjs
'use strict';

/**
 * Görüntüleme için zorunlu, cihaz/veri erişimi OLMAYAN izinler.
 * Yeni bir ad eklemek GÜVENLİK KARARIDIR — gerekçesi yukarıdaki bloğa yazılmadan
 * eklenmez (nöbetçi test listenin uzunluğunu da kilitler).
 */
const ALLOWED = Object.freeze(['fullscreen', 'clipboard-sanitized-write', 'pointerLock']);

/**
 * Bugün SESSİZCE onaylanan, artık reddedilecek izinler. Yalnız raporlama/test
 * içindir (karar `decide` fonksiyonunundur, bu liste onu ETKİLEMEZ).
 */
const NOTABLE_DENIED = Object.freeze([
  'media',
  'geolocation',
  'notifications',
  'midi',
  'midiSysex',
  'hid',
  'serial',
  'usb',
  'clipboard-read',
  'idle-detection',
  'window-management',
  'display-capture',
  'openExternal',
]);

/**
 * TEK KARAR NOKTASI. `{ granted, reason }` döner — `reason` log'a yazılır, çünkü
 * "site X iznini istedi ve reddedildi" kullanıcının göreceği tek ipucudur
 * (Electron reddi sayfaya sessiz bir hata olarak döndürür).
 *
 * @param {string} permission Electron'un izin adı
 * @returns {{granted:boolean, reason:string}}
 */
function decide(permission) {
  const p = typeof permission === 'string' ? permission : '';
  if (ALLOWED.includes(p)) return { granted: true, reason: 'allowlist' };
  return { granted: false, reason: p ? 'not-allowlisted' : 'unknown-permission' };
}

module.exports = { ALLOWED, NOTABLE_DENIED, decide };
