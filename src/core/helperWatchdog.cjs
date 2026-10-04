// ADP-727 — ÇOCUK TARAFI NÖBETÇİ (katman B, bkz. helperReaper.cjs başlığı).
//
// Gömülü Next sunucusuna `NODE_OPTIONS=--require <bu dosya>` ile enjekte edilir.
// İş: kendi ebeveynini yokla; ebeveyn ÖLDÜYSE kendini sonlandır.
//
// Neden `process.ppid === 1` yetmez: macOS'ta yetim süreç `launchd`e (pid 1)
// devredilir — bu güvenilir sinyaldir. Ama e2e/dev'de süreç zaten pid 1'in altında
// başlatılmış olabilir, o yüzden BEKLENEN ebeveyn pid'i env ile verilir ve yalnız
// "başlangıçtaki ebeveyn artık yok" durumunda çıkılır (yanlış-pozitif yok).
//
// Bu dosya ÇOCUK süreçte koşar; Electron API'si YOKTUR, hiçbir şey require etmez.

const PARENT = Number(process.env.CREWPANE_PARENT_PID || 0);
const EVERY_MS = Number(process.env.CREWPANE_WATCHDOG_MS || 5000);

if (PARENT > 1) {
  const parentAlive = () => {
    try { process.kill(PARENT, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  };
  const timer = setInterval(() => {
    if (!parentAlive()) {
      // stderr'e tek satır: yetimin NEDEN öldüğü loglarda görünsün.
      try { process.stderr.write(`[crewpane-watchdog] parent ${PARENT} gone → exiting helper ${process.pid}\n`); } catch { /* closed */ }
      process.exit(0);
    }
  }, EVERY_MS);
  // Nöbetçi süreci HAYATTA TUTMASIN — sunucu kendi soketiyle yaşar.
  if (typeof timer.unref === 'function') timer.unref();
}

module.exports = { PARENT, EVERY_MS };
