// ADP-749 — sesli asistanın KULLANICI-YÜZÜ adı: TEK KAYNAK, İKİ SÜREÇ.
//
// NEDEN BURADA (electron/) VE NEDEN src/ DEĞİL:
// ADP-708 adı `src/app/lib/voiceName.ts`e koydu; renderer'ın bütün etiketleri oradan
// okuyor. Ama adı kullanan İKİNCİ bir yüzey var: ANA SÜREÇ. `requireCredential.cjs`
// "anahtar yok" cümlesini üretir (`missingMessage`) ve o cümle köprüyle renderer'a
// gider (`jarvis:config.keyMissingMessage`). Main, `src/`i OKUYAMAZ: paketleme
// listesi (electron/package.json → build.files) yalnız `*.js`, `*.cjs`, `renderer/**`
// ve `package.json` alır — `src/` asar'a HİÇ girmez. Yani `src/app/lib/voiceName.ts`
// çalışma zamanında main tarafından require EDİLEMEZ (dev'de olur, müşteri
// build'inde ölür — ADP-725'in "fixture yeşil, paket kırmızı" sınıfı).
//
// Bu yüzden kanonik değer `*.cjs` olarak BURADA yaşar (asar'a girer) ve renderer
// tarafı (`src/app/lib/voiceName.ts`) bunu import edip yeniden export eder. Yön
// TERS DEĞİL: main src'yi okuyamaz, renderer electron/'u bundle'layabilir.
//
// ADP-708 (TELİF) arka planı: eski ad "Jarvis" (Marvel) telifliydi ve müşteri
// paketinde görünüyordu. Marka-güvenli "Agent X" ile değiştirildi. Adı değiştirmek
// TEK SATIR — kullanıcıya görünen her metin buradan okur.
//
// İç tanımlayıcılar (`jarvisApi`, `jarvis:*` IPC kanalları, `data-jarvis-*` DOM
// nitelikleri, dosya adları) KASITLI olarak "jarvis" kalır — CSS değişkeni/utility
// sınıfları HARİÇ: onlar vendored demo paketiyle müşteri-yüzüne sızdığı için
// ADP-839'da `--assistant` ailesine çevrildi (bkz. globals.css)
// — bunlar müşteri-yüzü DEĞİLDİR. Kullanıcı-görünür metin taramasının kapsamı da
// budur (bkz. `voiceNameLeak.test.cjs`).
//
// WAKE-WORD UYARISI (ADP-708 takip): hands-free wake, openWakeWord `hey_jarvis_v0.1`
// AKUSTİK modeliyle çalışır — model fiziksel olarak "hey jarvis" sesine tetiklenir,
// bu weight'lere gömülüdür (dosya adı değişse de değişmez). WAKE_PHRASE addan
// TÜRETİLİR, yani ekranda "Hey Agent X" yazar ama fiziksel tetik hâlâ "hey jarvis"tir.
// MODELİ DEĞİŞTİRMEK bu görevin kapsamı DEĞİL (yeniden-eğitim ayrı iş); yalnız
// GÖRÜNEN etiket tek kaynağa bağlıdır.

'use strict';

/** Sesli asistanın kullanıcıya görünen adı. Tek kaynak. */
const VOICE_NAME = 'Agent X';

/** Uyandırma ifadesi — addan TÜRETİLİR (akustik model ayrı, bkz. yukarı). */
const WAKE_PHRASE = `Hey ${VOICE_NAME}`;

/** Ayarlar'daki ses kategorisinin etiketi — hem panel hem kapı metni bunu kullanır. */
const VOICE_SETTINGS_LABEL = `Ses & ${VOICE_NAME}`;

/**
 * ARTIK KULLANILMAYAN adlar. Kullanıcı-görünür metin taraması bunları arar:
 *   • 'Jarvis'         → ADP-708'de "Agent X" oldu (telif)
 *   • 'CrewPane Voice' → ADP-361'de "AgentVoice" oldu (rebrand)
 * Yeni bir yeniden-adlandırmada eski adı buraya EKLE — tarama kendiliğinden korur.
 */
const RETIRED_USER_FACING_NAMES = Object.freeze(['Jarvis', 'CrewPane Voice']);

module.exports = {
  VOICE_NAME,
  WAKE_PHRASE,
  VOICE_SETTINGS_LABEL,
  RETIRED_USER_FACING_NAMES,
};
