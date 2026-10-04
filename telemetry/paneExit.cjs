// SEN-F2 — WORKER PANE ÇIKIŞI: NE RAPOR EDİLİR, NE GÜRÜLTÜDÜR (saf karar).
//
// ─── ÖLÇÜM (SEN-01 §4 madde 4) ───────────────────────────────────────────────
// crewpane-prod'daki EN YÜKSEK FREKANSLI iki kayıt pane çıkışlarıydı:
//   PROD-3 · 40 olay · "çalışan pane'i 129 koduyla sonlandı (motor: ?)"
//   PROD-2 ·  4 olay · "çalışan pane'i 1 koduyla sonlandı (motor: claude)"
// İkisi de 0 kullanıcı etkisiyle işaretliydi ve PROD-3 "escalating" alt-statüsüne
// geçmişti — yani panoyu, gerçekten bakılması gereken PROD-9'un önünde tutuyordu.
//
// ─── KARAR 1: SEVİYE ZATEN DOĞRUYDU, DEĞİŞTİRİLMEDİ ─────────────────────────
// Görev "error seviyesinde loglanıyorsa düşür" diyordu. Ölçüldü: `main.js` bu
// olayı ZATEN `level: 'warning'` ile üretiyor (OBS-02 kararı) ve Sentry etiketi de
// `level: warning`. Yani seviye düşürmek yanlış teşhise verilmiş doğru ilaç olurdu;
// gürültünün kaynağı seviye DEĞİL, SINIFLANDIRMA hatasıydı.
//
// ─── KARAR 2: 128+N = SİNYAL ÖLÜMÜ, ARIZA DEĞİL ─────────────────────────────
// Mevcut kapılardan biri "sinyal varsa raporlama" (biz öldürdük) diyordu. Ama
// node-pty macOS'ta sinyalle ölen bir kabuğu SIKÇA `exitCode=128+N, signal=0`
// olarak bildirir — POSIX kabuk sözleşmesinin ta kendisi (`$?` = 128+sinyal).
// 129 = 128+SIGHUP: pane'in tty'si/ebeveyni gitti, yani KAPANIŞ. Kapı `!signal`
// olduğu için bu 40 olay hepsinden sızıyordu. Sinyal, kodun içinden okunuyorsa da
// SİNYALDİR: aynı kapıya düşer.
//
// ─── KARAR 3: `motor: ?` BİR TELEMETRİ AÇIĞIYDI ─────────────────────────────
// Motor adı yalnız pane KAYIT DEFTERİNDEN (`ptys.get(paneId).command`) okunuyordu;
// kayıt çıkıştan önce düşerse ad `?` oluyordu — 40 olayın hepsinde öyle oldu ve
// "hangi motor sürekli ölüyor" sorusu YANITSIZ kaldı. Artık defter boşsa spawn
// planındaki motor anahtarı (closure'da her zaman var) yedek kaynaktır.
//
// Saf: electron bağı yok → `node --test`.

'use strict';

/** POSIX kabuk sözleşmesi: 128+N = N numaralı sinyalle ölüm. 128..192 dışı normal koddur. */
const SIGNAL_EXIT_BASE = 128;
const SIGNAL_EXIT_MAX = 192; // 128 + 64 (gerçek sinyal numaralarının üst sınırı bolca)

/** Sık görülen sinyaller — mesajı okunur kılmak için (bilinmeyen numara olduğu gibi yazılır). */
const SIGNAL_NAMES = Object.freeze({
  1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 9: 'SIGKILL',
  13: 'SIGPIPE', 15: 'SIGTERM',
});

/**
 * Çıkış kodu bir sinyal ölümünü mü kodluyor?
 * @param {number} exitCode
 * @returns {{signal:number, name:string}|null}
 */
function signalFromExitCode(exitCode) {
  if (!Number.isInteger(exitCode)) return null;
  if (exitCode <= SIGNAL_EXIT_BASE || exitCode > SIGNAL_EXIT_MAX) return null;
  const n = exitCode - SIGNAL_EXIT_BASE;
  return { signal: n, name: SIGNAL_NAMES[n] || `SIG${n}` };
}

/* ── WIN-EXIT-01 · WINDOWS'UN İYİ HUYLU NTSTATUS KODLARI ────────────────────────
 * ÖLÇÜM: 0.2.43'te Sentry'ye 4 ayrı issue / 25 olay düştü (PROD-T 11, PROD-W 2,
 * PROD-R 1, PROD-S 11), hepsi `os.name:win32`, hepsi `Users Impacted: 0`. Yani
 * kullanıcıya hiçbir şey olmuyordu; yalnız pano kirleniyordu — ve Windows en
 * kalabalık platform olduğu için bu gürültü GERÇEK bir arızayı maskeleyebilirdi.
 *
 * NEDEN AYRI BİR KAPI: SEN-F2'nin POSIX kapısı `128 < code <= 192` aralığına bakar
 * (`$?` = 128+sinyal sözleşmesi). Windows sinyal kullanmaz; konsol süreci Ctrl+C ile
 * öldüğünde çekirdek NTSTATUS döndürür ve bu kodlar o aralığın ÇOK dışındadır →
 * hiçbirine takılmadan `report:true`ya sızıyorlardı.
 *
 * ⚠ BU BİR "NEGATİF KODLARI ELE" KAPISI DEĞİLDİR. `0xC0000005` (ACCESS_VIOLATION)
 * da negatiftir ve GERÇEK bir çökmedir; raporlanmaya devam eder. Yalnızca aşağıda
 * ADI GEÇEN kodlar elenir.
 *
 * PLATFORM OKUNMAZ (`lesson_windows_platform_testing`): bu değerler POSIX'te
 * ÜRETİLEMEZ (orada çıkış kodu 0..255'tir), yani kodun kendisi platformu ele verir.
 * Böylece kapı macOS'ta da birebir test edilebilir — `process.platform`a bağlı bir
 * dal, yalnız Windows'ta koşabilen ve bu yüzden hiç ölçülmeyen bir dal olurdu.
 */
const BENIGN_NTSTATUS = Object.freeze({
  // Konsol süreci Ctrl+C ile sonlandı. POSIX'teki 130 = 128+SIGINT'in birebir
  // karşılığı; orada zaten eleniyordu, burada elenmiyordu. 25 olayın 14'ü buydu.
  0xc000013a: 'STATUS_CONTROL_C_EXIT',
  // Borunun öteki ucu kapandı. Pane kapanırken PTY borusunun kopması bu koda düşer:
  // "karşı taraf gitti" demektir, "motor çöktü" demek DEĞİLDİR.
  // 📌 WIN-EXIT-01 kartı bu sabiti `0xC000013B` diye yazmıştı — o değer
  // STATUS_LOCAL_DISCONNECT'tir (ağ taşıması bağlantıyı kapattı), PIPE_BROKEN değil.
  // Kartın NİYETİ (boru kopması) doğru sabitle uygulandı; ayrıntı raporda §3.2.
  // Ölçülen olaylarda bu kod GÖRÜLMEDİ — önleyici olarak eklendi.
  0xc000014b: 'STATUS_PIPE_BROKEN',
});

/**
 * Çıkış kodu Windows'un iyi huylu sonlanmalarından biri mi?
 *
 * node-pty aynı NTSTATUS'u İŞARETLİ (`-1073741510`) ya da İŞARETSİZ (`3221225786`)
 * verebilir. İki ayrı sabit listesi tutmak yerine `>>> 0` ile her ikisini de aynı
 * işaretsiz 32-bit değere indirgeyip TEK listede arıyoruz.
 *
 * @param {number} exitCode
 * @returns {{code:number, name:string}|null}
 */
function benignWindowsExit(exitCode) {
  if (!Number.isInteger(exitCode)) return null;
  const unsigned = exitCode >>> 0;
  const name = BENIGN_NTSTATUS[unsigned];
  return name ? { code: unsigned, name } : null;
}

/**
 * Bu pane çıkışı hata takibine gider mi, giderse ne yazar?
 *
 * @param {object} e
 * @param {number} e.exitCode
 * @param {number|string|null} [e.signal]   node-pty'nin bildirdiği sinyal (0/undefined = yok)
 * @param {boolean} [e.quitting]            uygulama kapanıyor
 * @param {boolean} [e.preserve]            restart-resume için saklanan pane
 * @param {string} [e.engine]               kayıt defterindeki motor adı
 * @param {string} [e.plannedEngine]        spawn planındaki motor anahtarı (yedek kaynak)
 * @returns {{report:false, reason:string} | {report:true, level:'warning', message:string, engine:string}}
 */
function classifyPaneExit(e = {}) {
  const exitCode = Number(e.exitCode);
  if (exitCode === 0) return { report: false, reason: 'normal-exit' };
  if (e.signal) return { report: false, reason: 'signalled' };
  if (e.quitting) return { report: false, reason: 'app-quitting' };
  if (e.preserve) return { report: false, reason: 'preserved' };

  // WIN-EXIT-01 FAZ 2 — ÇIKIŞ KODU SAYI DEĞİL.
  // ÖLÇÜLDÜ (PROD-S, 11 olay): node-pty Windows'ta `exitCode`u TANIMSIZ bırakabiliyor
  // → `Number(undefined)` = NaN → `NaN === 0` yanlış, `signalFromExitCode(NaN)` null →
  // olay "pane'i NaN koduyla sonlandı" diye raporlanıyordu. Bu uyarı SIFIR bilgi taşır:
  // arıza mı değil mi söylemez, gerçekten arıza olsa bile teşhis ettirmez. Yerel iz
  // KAYBOLMAZ — `main.js` sınıflandırmadan ÖNCE `pty exit … code=undefined` satırını
  // zaten günlüğe düşürür (bkz. rapor §3.4); Sentry'ye gitmeyen şey gürültüdür, kanıt değil.
  if (!Number.isFinite(exitCode)) return { report: false, reason: 'unknown-exit-code' };

  const encoded = signalFromExitCode(exitCode);
  // SEN-F2 — PROD-3'ün 40 olayı tam olarak burada elenir (129 = 128+SIGHUP).
  if (encoded) return { report: false, reason: `signalled-in-code:${encoded.name}` };

  // WIN-EXIT-01 FAZ 1 — SEN-F2'nin Windows karşılığı: iyi huylu NTSTATUS elemesi.
  const benign = benignWindowsExit(exitCode);
  if (benign) return { report: false, reason: `benign-win-exit:${benign.name}` };

  // Motor adı: defter → plan → '?'. Üçüncüsüne düşmek artık bir HATA sinyalidir,
  // sessiz bir varsayılan değil (mesajda ayırt edilebilir kalması bilerek).
  const engine = String(e.engine || e.plannedEngine || '?');
  return {
    report: true,
    level: 'warning',
    engine,
    message: `çalışan pane'i ${exitCode} koduyla sonlandı (motor: ${engine})`,
  };
}

module.exports = {
  classifyPaneExit, signalFromExitCode, benignWindowsExit,
  SIGNAL_EXIT_BASE, SIGNAL_EXIT_MAX, SIGNAL_NAMES, BENIGN_NTSTATUS,
};
