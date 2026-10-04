// CrewPane — ONNX-CRASH-02 · ÇOCUK SÜREÇTE IPC GÜVENLİĞİ (tek kaynak).
//
// NEDEN VAR (ölçüldü, tahmin değil): 05–06.09.2026'da gömme/indeksleme çocuğu 20 kez
// SIGABRT ile öldü. Yeniden üretilen zincir (repro çıktısı raporda):
//
//   ebeveyn gider (uygulama kapanır / komşu `pkill` / e2e koşusu biter)
//     → çocuğun IPC kanalı KAPANIR
//     → çocuk model yüklemesini bitirince `process.send({type:'ready'})` çağırır
//     → Node kanal kapalıyken SENKRON HATA FIRLATMAZ: `process.nextTick`te
//       process üzerine bir **'error' olayı** yayar (ERR_IPC_CHANNEL_CLOSED)
//     → dinleyicisi olmayan 'error' olayı Node'da SÜRECİ ÖLDÜRÜR (uncaughtException)
//     → `node::Environment::Exit` → `exit` → `__cxa_finalize_ranges`
//     → onnxruntime'ın statik yıkıcıları iş parçacığı havuzu AYAKTAYKEN koşar
//     → `std::terminate` → **abort (SIGABRT)** → macOS ÇÖKME DİYALOĞU.
//
// 🪤 `try { process.send(...) } catch {}` BU KUSURU TUTMAZ — hata senkron değildir.
//    (Aynı tuzak main tarafında memorySearchService.stopChild başlığında da yazılı;
//    çocuk tarafına uygulanmamıştı.) Doğru fren `process.send`in **geri çağrı**
//    biçimidir: kanal kapalıysa hata 'error' olayı yerine geri çağrıya gider.
//
// İKİNCİ KEMER: `uncaughtException` / `unhandledRejection` kancaları. Bunlar
// (a) gerçek mesajı ebeveyne `{type:'error', fatal:true}` olarak taşır — bir dahaki
// olayda "hangi istisna" sorusu kanıtsız kalmasın, (b) `process.exit` ÇAĞIRMAZ
// (ADP-870 §7: exit, ONNX havuzu ayaktayken abort demektir), (c) süreç bir nedenle
// boşalmazsa SIGKILL ile biter — SIGKILL yıkıcı koşturmaz, .ips ÜRETMEZ, kullanıcıya
// diyalog GÖSTERMEZ.

'use strict';

/** Boşalmayan süreç bu süre sonunda SIGKILL ile biter (memoryIndexWorker.finish ile aynı). */
const DEFAULT_GRACE_MS = 8000;

/**
 * Ebeveyne mesaj yolla. Kanal kapalıysa SESSİZCE false döner — süreç ölmez.
 * IPC kanalı hiç yoksa (elle koşturma/ölçüm) satır stdout'a JSONL olarak düşer.
 * @returns {boolean} mesaj kanala verildiyse true
 */
function safeSend(msg, proc = process) {
  const send = proc && proc.send;
  if (typeof send !== 'function') {
    try {
      proc.stdout.write(`${JSON.stringify(msg)}\n`);
    } catch {
      /* stdout da kapalıysa yapacak bir şey yok */
    }
    return false;
  }
  // `connected === false` → kanal kapandı; geri çağrı biçimi zaten tutardı ama
  // gereksiz nextTick üretmeyelim.
  if (proc.connected === false) return false;
  try {
    // 🔴 DÖRDÜNCÜ ARGÜMAN ŞART: geri çağrı verilince Node hatayı ORAYA verir,
    // process üzerine 'error' YAYMAZ. Boş geri çağrı bilerek boş.
    send.call(proc, msg, undefined, undefined, () => {});
    return true;
  } catch {
    return false;
  }
}

/**
 * Yakalanmamış istisna/vaat kancalarını kur.
 *
 * @param {object} o
 * @param {NodeJS.Process} [o.proc]
 * @param {(msg:object)=>void} [o.send] ebeveyne mesaj yollayan işlev (varsayılan safeSend)
 * @param {string} [o.label] stderr satırının ön eki
 * @param {number} [o.graceMs] bu süre sonunda SIGKILL (0 → güvenlik ağı yok)
 * @returns {(kind:string, err:any)=>void} test için doğrudan çağrılabilir raporlayıcı
 */
function installChildGuards({
  proc = process,
  send = null,
  label = 'child',
  graceMs = DEFAULT_GRACE_MS,
  exitCode = 1,
} = {}) {
  const emit = send || ((msg) => safeSend(msg, proc));
  let reported = false;

  const report = (kind, err) => {
    const message = (err && err.message) || String(err);
    // stderr ebeveyne BAĞLI (stdio: pipe) — main bunu log'a yazıyor. Yığın burada
    // kalır ki bir dahaki olayda "gerçek istisna neydi" sorusu cevaplansın.
    try {
      proc.stderr.write(`[${label}] ${kind}: ${(err && err.stack) || message}\n`);
    } catch {
      /* stderr kopmuş */
    }
    emit({ type: 'error', fatal: true, kind, reason: message });
    if (reported) return; // ikinci istisna tek kapanışı iki kez kurmasın
    reported = true;
    proc.exitCode = exitCode;
    try {
      if (proc.connected) proc.disconnect();
    } catch {
      /* kanal zaten kapalı */
    }
    if (graceMs > 0) {
      // Güvenlik ağı: olay döngüsü boşalmazsa (ONNX havuzu takılırsa) süreci
      // SIGKILL ile bitir — yıkıcı koşmaz, .ips üretilmez, diyalog çıkmaz.
      const t = setTimeout(() => {
        try {
          proc.kill(proc.pid, 'SIGKILL');
        } catch {
          /* zaten ölmüş */
        }
      }, graceMs);
      if (t && typeof t.unref === 'function') t.unref();
    }
  };

  proc.on('uncaughtException', (err) => report('uncaughtException', err));
  proc.on('unhandledRejection', (err) => report('unhandledRejection', err));
  return report;
}

/** Yetim nöbetçisinin SIGKILL güvenlik ağı (işbirlikçi durma bu kadar bekler). */
const DEFAULT_ORPHAN_GRACE_MS = Number(process.env.CREWPANE_ORPHAN_GRACE_MS || 10000);

/**
 * MEMIDX-LEAK-01 — YETİM NÖBETÇİSİ (ADP-727 katman B'nin IPC'li ikizi).
 *
 * NEDEN VAR (ölçüldü, tahmin değil). 07.09.2026 gecesi makinede 48 yetim
 * `memoryIndexWorker` birikti (ppid 1, %13–76 CPU, loadavg 229/14 çekirdek). Sebep
 * bir DÖNGÜ değildi: her bare-run açılış bir indeksleme çocuğu fork ediyor, uygulama
 * kapanınca çocuk ebeveynsiz kalıp indekslemeye SAATLERCE devam ediyordu.
 *
 * 🪤 BU KUSURU ONNX-CRASH-02 AÇTI — ve bunu bilmek şart, yoksa "eskiden çalışıyordu"
 *    sorusu cevapsız kalır. 0.2.42'de (paketten okundu) çocuk ÇIPLAK `process.send`
 *    kullanıyordu: ebeveyn gidince kanal kapanıyor, bir sonraki ilerleme satırı
 *    dinleyicisiz 'error' olayı yayıyor ve çocuk SIGABRT ile ÖLÜYORDU. Yani yetim,
 *    ÇÖKEREK temizleniyordu. ONNX-CRASH-02 o çökmeyi (haklı olarak) durdurdu —
 *    ve çöken çocuğu ÖLÜMSÜZ bir yetime çevirdi. Sağlamlaştırmanın bedeli budur:
 *    artık çıkışı AÇIKÇA yazmak zorundayız.
 *
 * Sinyal: IPC kanalının 'disconnect'i. Ebeveyn nasıl giderse gitsin (app.quit,
 * SIGKILL, Force Quit, e2e koşusunun bitişi) kanalın FD'si kapanır ve Node çocukta
 * 'disconnect' yayar — `process.ppid === 1` yoklamasının aksine yarış yoktur ve
 * e2e/dev'de yanlış-pozitif vermez.
 *
 * Çıkış İŞBİRLİKÇİDİR: `onOrphan()` işi DOSYA SINIRINDA durdurur (yarım doküman
 * yazılmaz), sonra süreç kendiliğinden biter. `process.exit` ÇAĞRILMAZ — ADP-870 §7:
 * exit, onnxruntime havuzu ayaktayken SIGABRT demektir. Boşalmayan süreç için
 * güvenlik ağı SIGKILL'dir (yıkıcı koşturmaz → .ips YOK).
 *
 * @returns {boolean} nöbetçi kuruldu mu (IPC kanalı yoksa false — elle koşturma
 *   ve ölçüm yolları AYNEN kalır, tek satırı değişmez)
 */
function installOrphanGuard({
  proc = process,
  onOrphan = () => {},
  label = 'child',
  graceMs = DEFAULT_ORPHAN_GRACE_MS,
} = {}) {
  // IPC kanalı hiç yoksa (elle `node electron/memoryIndexWorker.cjs …` ölçümü)
  // nöbetçi KURULMAZ: 'disconnect' hiç gelmez, ama niyeti de burada belgeliyoruz.
  if (!proc || typeof proc.on !== 'function' || typeof proc.send !== 'function') return false;
  proc.on('disconnect', () => {
    try {
      proc.stderr.write(`[${label}] ebeveyn gitti (IPC disconnect) → iş durduruluyor
`);
    } catch {
      /* stderr de kopmuş */
    }
    try {
      onOrphan();
    } catch {
      /* durdurucu patlarsa güvenlik ağı yine bitirir */
    }
    proc.exitCode = 0; // yetim kalmak bir HATA değil; çıkış kodu yalan söylemesin
    if (graceMs > 0) {
      const t = setTimeout(() => {
        try {
          proc.kill(proc.pid, 'SIGKILL');
        } catch {
          /* zaten ölmüş */
        }
      }, graceMs);
      // unref: nöbetçi tek başına süreci HAYATTA TUTMASIN.
      if (t && typeof t.unref === 'function') t.unref();
    }
  });
  return true;
}

module.exports = { DEFAULT_GRACE_MS, DEFAULT_ORPHAN_GRACE_MS, safeSend, installChildGuards, installOrphanGuard };
