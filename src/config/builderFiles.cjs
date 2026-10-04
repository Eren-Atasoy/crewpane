'use strict';
// LX-32 — platforma özel `files` DIŞLAMALARINI yerleştiren TEK GERÇEK.
//
// NEDEN AYRI BİR MODÜL: `win-builder.cjs` bu mantığı ADP-831'de kendi içinde yazdı;
// `linux-builder.cjs` aynısına ihtiyaç duyuyor. Kopyalamak İKİ GERÇEK demek olurdu —
// biri düzeltilir, diğeri sessizce eski tuzağı taşımaya devam ederdi. ADR §3.4 bu
// yüzden "kopyalanmaz, ORTAKLAŞTIRILIR" diyor.
//
// ── Korunan iki tuzak (ikisi de ÖLÇÜLDÜ, hipotez değil) ────────────────────
// 1) ADP-629 — NEGASYON SIRASI. electron-builder `files` dizisini `normalizeFiles()`
//    ile "fileset"lere böler; araya bir `{from:…}` OBJESİ girdiğinde ondan SONRA yazılan
//    string'ler YENİ bir fileset açar ve `mergeFileSets()` birleştirirken YENİ fileset'in
//    kalıplarını BAŞA geçirir. `minimatchAll()` include'dan ÖNCE gelen negasyonu HİÇ
//    değerlendirmediği için o negasyonlar SESSİZCE ETKİSİZ kalır (0.2.14'te app.asar'a
//    72 `*.test.cjs` sızdı). ⇒ Dışlamalar ilk `{from:…}` objesinden ÖNCE araya sokulur.
// 2) ADP-831 §2.5 — YALNIZ-NEGASYON LİSTE KAPSAMI PATLATIR. Dışlamalar platform bloğuna
//    (`build.win.files`) konduğunda electron-builder listenin başına örtük `**/*` ekledi;
//    "her şeyi al" anlamına gelen bu liste kökteki daraltıcı include'ları etkisiz bıraktı
//    → kurulum 1,09 GB, app.asar 1,4 GB (içinde mac DMG'leri). ⇒ Dışlamalar platform
//    bloğuna DEĞİL, kök `files` listesinin TÜRETİLMİŞ kopyasına yazılır.

/**
 * Platforma özel dışlama kalıplarını, kök `files` listesinin kopyasına ADP-629
 * kuralına uyarak yerleştirir (ilk `{from:…}` fileset objesinden ÖNCE).
 *
 * @param {Array<string|object>} files kök `build.files` listesi (DEĞİŞTİRİLMEZ)
 * @param {string[]} excludes `!`-önekli dışlama kalıpları
 * @returns {Array<string|object>} yeni liste
 */
function withPlatformExcludes(files, excludes) {
  if (!Array.isArray(files)) {
    throw new TypeError('withPlatformExcludes: `files` bir dizi olmalı');
  }
  const bad = (excludes || []).filter((p) => typeof p !== 'string' || !p.startsWith('!'));
  if (bad.length) {
    throw new TypeError(
      `withPlatformExcludes: dışlama kalıpları '!' ile başlamalı (${bad.join(', ')}) — ` +
        "'!'siz bir kalıp DIŞLAMA değil INCLUDE'dur ve kapsamı sessizce genişletir",
    );
  }
  const firstFileSetIndex = files.findIndex((f) => f && typeof f === 'object');
  if (firstFileSetIndex === -1) return [...files, ...excludes];
  return [
    ...files.slice(0, firstFileSetIndex),
    ...excludes,
    ...files.slice(firstFileSetIndex),
  ];
}

// ── YABANCI-MİMARİ KOFFI DIŞLAMASI — TEK GERÇEK (REL-0243-BUILD) ───────────
// ÖLÇÜLDÜ (hipotez değil): 0.2.43 x64 koşusunda native-ikili kapısı KIRMIZI verdi —
//   ⨯ YABANCI: node_modules/@koromix/koffi-darwin-arm64/darwin_arm64/koffi.node
//     → macho/arm64 (cputype 0x100000c)
// Kök neden: `koffi` (HAND-A2 ile girdi, el kontrolü CGEvent imleci) mimariye özel
// OPSİYONEL bağımlılıklar taşır ve npm YALNIZ HOST mimarisininkini kurar. Bu makine
// arm64 olduğu için node_modules'ta yalnız `@koromix/koffi-darwin-arm64` var; x64 /
// win / linux paketleri onu olduğu gibi içine alıyordu. node-pty'nin karşı-mimari
// prebuild'leriyle AYNI sınıf: yabancı ikili = ölü ağırlık + AV yanlış-pozitif yüzeyi.
// AKTİF ZARAR YOK: `handCursor.cjs`'in `require('koffi')` çağrıları try/catch içinde
// (darwin ~48, win32 ~119) ve hata `error()` ile yüzeye çıkar — modül yoksa el
// kontrolü kapalı kalır, uygulama açılır. El kontrolü 0.2.43'te zaten dev-only.
// arm64 hattı bu listeyi KULLANMAZ: orada ikili DOĞRU mimaridir ve pakette kalır.
const FOREIGN_KOFFI_EXCLUDES = ['!**/@koromix/koffi-darwin-arm64/**'];

// ── WINDOWS DIŞLAMALARI — TEK GERÇEK (WIN-PKG-01) ──────────────────────────
// ADP-831'de bu liste `win-builder.cjs` içinde YEREL bir sabitti. WIN-PKG-01 ikinci
// bir Windows hattı açtı (dev kanalı, `win-dev-builder.cjs`); listeyi kopyalamak
// bu modülün varlık sebebine (§LX-32 "kopyalanmaz, ORTAKLAŞTIRILIR") aykırı olurdu —
// biri düzeltilir, öteki eski tuzağı sessizce taşırdı. Davranış DEĞİŞMEDİ: prod
// Windows hattı birebir aynı kalıpları alır.
const WIN_ONLY_EXCLUDES = [
  // macOS'ta electron-rebuild ile derlenen Mach-O `build/Release/pty.node`.
  // node-pty yükleyicisi ÖNCE build/Release'e bakar (utils.js loadNativeModule);
  // Windows'ta o dosya require'da patlar ve sıra prebuilds'e gelir — yani zararsız
  // ama pakette işi yok: ölü ağırlık + AV yanlış-pozitif yüzeyi (792 §2.3).
  '!**/node-pty/build/**',
  // Windows paketinde macOS prebuild'lerinin işi yok (~200 KB).
  '!**/node-pty/prebuilds/darwin-*/**',
  // LX-32 — `scripts/build-linux-pty.sh` artık node_modules'a bir ELF `linux-x64/pty.node`
  // BIRAKIYOR. Windows paketinde işi yok; dışlanmazsa Linux hattı Windows kurulumunu
  // sessizce şişirirdi (aynı sınıf: yabancı platform ikilisi = ölü ağırlık + AV yüzeyi).
  '!**/node-pty/prebuilds/linux-*/**',
  // Hata ayıklama sembolleri (~28 MB) — çalışma zamanında hiç okunmuyor.
  '!**/node-pty/prebuilds/**/*.pdb',
  // NATIVE-GUARD-01 — electron-rebuild'in YEREL önbelleği
  // (`node-pty/bin/darwin-arm64-146/node-pty.node` → Mach-O arm64, ölçüldü).
  // node-pty yükleyicisi `bin/`e HİÇ bakmaz (lib/utils.js `loadNativeModule`:
  // build/Release → build/Debug → prebuilds/<platform>-<arch>) ⇒ ulaşılamaz ölü
  // ağırlık + AV yanlış-pozitif yüzeyi; koffi ile AYNI sınıf. `linux-builder` ve
  // `mac-x64-builder` bu kalıbı zaten taşıyordu; Windows hattında EKSİKTİ ve
  // `guard:natives:win` yanlış dizine baktığı için kimse görmedi (REL-0243-BUILD
  // §3.4). Kapı görür hâle gelince ilk yakaladığı şey bu oldu.
  '!**/node-pty/bin/**',
  // REL-0243 — host mimarisinin koffi ikilisi (yukarıdaki blok).
  ...FOREIGN_KOFFI_EXCLUDES,
];

module.exports = { withPlatformExcludes, WIN_ONLY_EXCLUDES, FOREIGN_KOFFI_EXCLUDES };
