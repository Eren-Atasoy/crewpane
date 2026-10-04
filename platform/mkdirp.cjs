// PIPE-10 — ÖZYİNELİ DİZİN KURMANIN TEK BOĞAZI (`fs.mkdirSync(recursive:true)`
// yerine). Var olma sebebi bir HATA DEĞİL bir ASILMA: Linux'ta `mkdirSync(...,
// {recursive:true})` SONSUZ DÖNGÜYE girebilir ve `try/catch` bunu YAKALAYAMAZ.
//
// ÖLÇÜM (PIPE-10 §1, linux/amd64 + linux/arm64 konteyner, node 22):
//   fs.mkdirSync('/proc/nonexistent/nope', { recursive: true })  → HİÇ DÖNMEZ
//   (sys zamanı %80+, kullanıcı kodu ilerlemez; 60 sn test timeout'u kesene kadar)
//   Aynı çağrı macOS'ta 1 ms'de EPERM ile döner. Kırmızı YALNIZ Linux'ta.
//
// MEKANİZMA. Node'un özyineli mkdir'i (node_file.cc `MKDirpSync`) `ENOENT`i
// "üst dizin yok" olarak yorumlar: üst dizini yığına iter, kurar, sonra ÇOCUĞU
// YENİDEN dener. Linux procfs'te `mkdir("/proc/nonexistent")` üst dizin VAR olduğu
// hâlde `ENOENT` verir (procfs yeni girdi kabul etmez). Zincir şu hâle gelir:
//   mkdir /proc/nonexistent → ENOENT → mkdir /proc → EEXIST(dizin, tamam)
//   → mkdir /proc/nonexistent → ENOENT → mkdir /proc → EEXIST → …  ⟳ SONSUZ
// macOS'ta `/proc` HİÇ YOK; `mkdir("/proc")` EPERM/EROFS verir, EPERM `MKDirpSync`
// içinde erken `return` dalıdır ⇒ döngü kurulamaz. Platform farkı buradan doğuyor.
//
// ÇÖZÜM — SEGMENT SEGMENT, ÖZYİNELEMESİZ. Yol parçalara ayrılır ve her parça
// ÖZYİNELEMESİZ `mkdirSync` ile kurulur. Üstü ZATEN biz kurduğumuz için bir
// parçada gelen `ENOENT` artık "üstü yok" değil "dosya sistemi REDDEDİYOR"
// demektir ⇒ FIRLATILIR. Döngü adım sayısı parça sayısıyla SINIRLI ⇒ yapısal
// olarak asılamaz. Çağıranın `catch`i yine çalışır, sözleşme değişmez.
//
// HIZLI YOL: hedef zaten dizinse tek `statSync` ile döner (sıcak yol tek syscall).
//
// SEAM: `opts.fs` — testin patolojik dosya sistemini (her mkdir'e ENOENT) enjekte
// edip döngüsüzlüğü HER platformda ölçebilmesi için. Üretimde daima node:fs.
'use strict';

const nodeFs = require('node:fs');
const path = require('node:path');

/**
 * `mkdir -p` — özyinelemesiz, asılmayan sürüm.
 *
 * @param {string} dir kurulacak dizin (göreli yol `path.resolve` ile mutlaklaşır)
 * @param {{ fs?: typeof nodeFs }} [opts] test dikişi
 * @returns {string} kurulan (ya da zaten var olan) mutlak dizin yolu
 * @throws bugünkü `fs.mkdirSync`in fırlattığı hatanın AYNISI (kod/mesaj korunur)
 */
function mkdirpSync(dir, opts) {
  const fs = (opts && opts.fs) || nodeFs;
  const target = path.resolve(String(dir));

  try {
    if (fs.statSync(target).isDirectory()) return target;
  } catch {
    // yok / okunamıyor → aşağıda kurmayı dene
  }

  const root = path.parse(target).root;
  const segments = target.slice(root.length).split(path.sep).filter(Boolean);

  let cur = root;
  for (let i = 0; i < segments.length; i += 1) {
    cur = path.join(cur, segments[i]);
    try {
      fs.mkdirSync(cur);
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      // Var olan girdi DİZİN ise devam.
      let st = null;
      try { st = fs.statSync(cur); } catch { throw err; }
      if (st && st.isDirectory()) continue;
      // Girdi var ama DİZİN DEĞİL. Node'un özyineli sürümüyle HATA PARİTESİ:
      //   • hedefin kendisi bir dosyaysa → EEXIST (node da öyle verir)
      //   • ARA bir parça dosyaysa → ENOTDIR.
      if (i === segments.length - 1) throw err;
      // 🔴 PIPE-03 — WINDOWS PARİTE AÇIĞI (gerçek Windows CI'da ölçüldü: koşu
      // 33085246277, not ok 2991). POSIX'te bir sonraki turun `mkdirSync`i dosyanın
      // ALTINA yazmaya çalışıp işletim sisteminin GERÇEK `ENOTDIR`ını fırlatıyordu
      // (PIPE-10 §2.3 ölçümü) — ama Windows aynı çağrıya `ENOENT` verir, oysa node'un
      // KENDİ özyineli mkdir'i orada da `ENOTDIR` döner. Sözleşme "node ne veriyorsa
      // o" olduğu için kod burada NORMALİZE edilir: davranış POSIX'te bit-bit aynı
      // kalır (zaten ENOTDIR'dı), Windows'ta node ile hizalanır.
      const notDir = new Error(`ENOTDIR: not a directory, mkdir '${target}'`);
      notDir.code = 'ENOTDIR';
      notDir.syscall = 'mkdir';
      notDir.path = target;
      throw notDir;
    }
  }
  return target;
}

module.exports = { mkdirpSync };
