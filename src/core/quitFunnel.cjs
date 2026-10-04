// HATA-14 — TEK KAPANIŞ HUNİSİ (ana süreç ayağı).
//
// ÖLÇÜLEN ARIZA (müşteri, Windows, 12.09): pencere kapatıldıktan sonra
// `CrewPane (9) · 1.107,8 MB` Görev Yöneticisi'nde yaşamaya devam ediyor.
// DISC-TRIAGE-03 §4.9 kodda İKİ ayrı ayak ölçtü; bu dosya İKİNCİSİDİR (ana
// süreç). Torun/ConPTY ayağı ayrı karttadır (WIN-CONPTY-01) ve buraya girmez.
//
// İZOLE SONDA (bare Electron, kendi --user-data-dir'i) iki bağımsız kök neden
// ölçtü — ikisi de kontrol kollu:
//
//   KÖK NEDEN 1 — YARDIMCI PENCERE `window-all-closed`i TAMAMEN SUSTURUYOR.
//     KOL A (yardımcı pencere YOK): ana pencere kapandı → `window-all-closed`
//       +4ms içinde ateşledi → quit → exit=0.
//     KOL B (jarvis widget bayraklarıyla bir yardımcı pencere AÇIK):
//       ana pencere kapandı → `window-all-closed` HİÇ ateşlemedi; süreç 9 sn
//       sonra hâlâ canlıydı (pencere=1, ekranda görünen hiçbir şey yok).
//     Üründeki karşılığı: `main.js` ses widget'ını ana pencere kapansa da
//     KASITLI olarak yaşatır (ADP-816). macOS'ta bu doğrudur (uygulama Dock'ta
//     sürer, ADP-334/905); Windows/Linux'ta ise uygulamayı GÖRÜNMEZ ama CANLI
//     bırakır — müşterinin gördüğü tam olarak budur. Bu yüzden çıkış kararı
//     "hiç pencere kalmadı mı"ya değil, "ANA pencere kapandı mı"ya bağlanır.
//
//   KÖK NEDEN 2 — NORMAL KAPANIŞTA ADP-876 FRENİ YOK.
//     KOL C (`before-quit` preventDefault, fren yok): süreç 9 sn sonra hâlâ
//       canlı (pencere=0 — yani ekranda hiçbir iz yokken).
//     KOL D (aynı askı + fren): 3 sn sonra `app.exit(0)`, exit=0.
//     Üründe bu fren YALNIZ hesap değiştirme yolunda vardı (main.js ADP-876);
//     normal kapanış (X düğmesi / menüden Çıkış) frensizdi.
//
// TASARIM: karar ve fren SAF fonksiyonlardadır (electron import'u YOK), böylece
// win32 dalı platform ENJEKTE EDİLEREK test edilir — Windows'ta koşmaya gerek
// kalmadan davranış kilitlenir.

/**
 * ANA PENCERE KAPANDI — uygulama çıkmalı mı?
 *
 * Mevcut ürün davranışı KORUNUR (HATA-14 kartı: "Kapat = çıkış mı tray mi"
 * kararı Eren'indir, bu kart davranışı DEĞİŞTİRMEZ):
 *   · darwin  → HAYIR. Uygulama Dock'ta yaşar, pane'ler sürer (ADP-334/905).
 *   · win32/linux → EVET. Uygulamada tepsi (tray) YOKTUR — `main.js` içinde tek
 *     bir `Tray` örneği bile oluşturulmaz (ADP-440'ta kaldırıldı) — yani pencere
 *     kapanınca kullanıcının uygulamaya dönebileceği hiçbir yüzey kalmaz.
 *     "Pencere kapalı ama süreç canlı" durumu bu platformlarda bir ÜRÜN DURUMU
 *     DEĞİL, sızıntıdır.
 *   · AUTOTEST → EVET (darwin'de de): `keepPanesAliveOnWindowClose()` ile AYNI
 *     kural (main.js) — otomasyon koşusu yetim Electron bırakmamalı.
 *
 * ⚠ AUTOTEST DALI GERÇEK ÜRÜNDE ULAŞILAMAZ — ve bu bir SAHTE YEŞİL tuzağıdır
 * (14.09 ölçüldü): `main.js#resolveMode()` içinde AUTOTEST, `CREWPANE_MODE`u
 * EZER ve MODE='spike' olur; spike dalı `createSpikeWindow()` açar, yani bu
 * kararın çağrıldığı `createAppWindow` hiç koşmaz. Üstelik spike dalında 20
 * sn'lik "autotest watchdog" app.quit() çağırır. `CREWPANE_SPIKE_AUTOTEST=1`
 * ile yazılan bir e2e bu yüzden YEŞİL görünür ama ölçtüğü şey watchdog'dur.
 * Gerçek ürün kanıtı AUTOTEST'SİZ alınır (e2e/hata14-quit-funnel.spec.cjs).
 *
 * DEĞİŞEN TEK ŞEY: karar artık AÇIK Kalan pencere sayısına BAKMAZ. Eskiden
 * çıkış yalnız `window-all-closed` üzerinden gelirdi ve o olay, yaşayan bir
 * yardımcı pencere varken hiç ateşlemiyordu (KÖK NEDEN 1).
 */
function decideQuitOnMainWindowClose({ platform, autotest } = {}) {
  if (autotest) return { quit: true, reason: 'autotest' };
  if (platform === 'darwin') return { quit: false, reason: 'darwin-dock' };
  return { quit: true, reason: 'no-tray-surface' };
}

/**
 * ADP-876 FRENİ — GENELLEŞTİRİLMİŞ. `app.quit()` KİBAR BİR İSTEKTİR: bir
 * `before-quit` dinleyicisi, `beforeunload` kutusu ya da asılı bir renderer onu
 * yutarsa süreç yarı-kapalı yaşamaya devam eder (KOL C). Bu fren BİLİNMEYENİ
 * kapatır: `ms` içinde kapanış bitmediyse süreç ZORLA sonlandırılır.
 *
 * TEK SEFERLİK: `state` çağıran tarafından tutulur (`{ armed:false }`); ikinci
 * çağrı yeni zamanlayıcı KURMAZ. Yoksa her quit denemesi bir timer daha yığar.
 *
 * `unref` ZORUNLU: fren normal (hızlı) kapanışı `ms` kadar GECİKTİRMEMELİDİR.
 */
function armForceExit(state, deps = {}) {
  if (!state || state.armed) return { armed: false, already: true };
  const ms = Number.isFinite(deps.ms) ? deps.ms : 5000;
  const setTimer = deps.setTimer || setTimeout;
  const exit = deps.exit || (() => {});
  const log = deps.log || (() => {});
  const label = deps.label || 'quit';
  state.armed = true;
  const timer = setTimer(() => {
    log(`[${label}] kapanış ${ms} ms içinde tamamlanmadı — süreç ZORLA sonlandırılıyor (HATA-14/ADP-876)`);
    exit(0);
  }, ms);
  if (timer && typeof timer.unref === 'function') timer.unref();
  state.timer = timer;
  return { armed: true, already: false, ms };
}

/**
 * KAPANIŞ HUNİSİNİN SIRASI — SÖZLEŞME.
 *
 * Sıra keyfi değildir, her adımın gerekçesi `main.js`teki yorumlardadır:
 *   1. persist-screen-tails  — ADP-386: ekran kuyruğu defterden ÖNCE yazılır
 *   2. quit-snapshot         — write-ahead pane defteri (teardown'dan ÖNCE)
 *   3. global-shortcuts      — kayıtlı kısayolları bırak
 *   4. pty-resume-daemon     — pty'lere dokunulmadan ÖNCE zamanlayıcıları durdur
 *   5. adapter               — Responses→ChatCompletions köprüsü
 *   6. whisper-local         — ADP-813, ~1.5 GB tutan ÇOCUK süreç
 *   7. jarvis-brain          — ADP-815, kalıcı `claude` ÇOCUK süreci
 *   8. next-server           — ADP-727, SIGTERM → 3 sn → SIGKILL/taskkill
 *   9. ptys                  — pane'ler (preserve=true, restore defteri korunur)
 *  10. delegation-bridge     — HTTP köprüsü
 *
 * Testin kilitlediği şey: (a) bu sıra, (b) bir adımın ATMASI kalan adımları
 * ASLA iptal etmez (bir yetim süreç, sonrakilerin hepsini yetim bırakamaz).
 */
const TEARDOWN_ORDER = [
  'persist-screen-tails', 'quit-snapshot', 'global-shortcuts', 'pty-resume-daemon',
  'adapter', 'whisper-local', 'jarvis-brain', 'next-server', 'ptys', 'delegation-bridge',
];

/**
 * Adımları SIRAYLA koştur; her adımın hatası YUTULUR ve loglanır.
 * Dönen: `{ ran:[isim], failed:[{name,error}] }` — sessiz atlama yok.
 */
function runTeardown(steps, deps = {}) {
  const log = deps.log || (() => {});
  const ran = [];
  const failed = [];
  for (const step of steps) {
    if (!step || typeof step.run !== 'function') continue;
    try {
      step.run();
      ran.push(step.name);
    } catch (e) {
      failed.push({ name: step.name, error: e && e.message ? e.message : String(e) });
      log(`[quit] adım BAŞARISIZ (${step.name}): ${e && e.message} — kapanış DEVAM ediyor`);
    }
  }
  return { ran, failed };
}

module.exports = { decideQuitOnMainWindowClose, armForceExit, runTeardown, TEARDOWN_ORDER };
