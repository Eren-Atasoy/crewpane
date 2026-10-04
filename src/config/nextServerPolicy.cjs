// SMOKE-ISO-01 — GÖMÜLÜ NEXT SUNUCUSU BEKLENMEDİK ÖLDÜĞÜNDE NE YAPILIR.
//
// ÖLÇÜLEN ARIZA (16.09, CRASH-R1 §2 + bu kartın kontrol kolu): gömülü Next
// sunucusuna DIŞARIDAN tek bir SIGTERM gelmesi TÜM UYGULAMAYI kapatıyor.
// Ölçüm (kaynak koşumu, dev HEAD): `kill -TERM <next-pid>` →
//   next server exited code=143 → [crash-r1] kapanış sebebi: next-server-gone
//   → [quit] kapanış hunisi → süreç yok.
// 11 pane, açık oturumlar, yazılmamış her şey onunla birlikte gider.
//
// NEDEN "her ölümde kapat" YANLIŞ: ADP-334 bu dalı, sunucusuz kalan pencerenin
// beyaz ekrana düşmesini engellemek için koydu — ama "sunucu öldü" ile "sunucu
// bir daha kalkmıyor" AYNI ŞEY DEĞİLDİR. Bir kerelik ölüm (dış sinyal, OOM,
// port çakışması) kurtarılabilir; kapanış geri alınamaz.
//
// NEDEN SINIRSIZ YENİDEN BAŞLATMA DA YANLIŞ: gerçekten bozuk bir paket
// (standalone eksik, port alınamıyor) sonsuz döngüye girer ve kullanıcı
// beyaz ekranla baş başa kalır — ADP-334'ün kapattığı delik yeniden açılır.
//
// KURAL: PENCERE BAŞINA 1 YENİDEN BAŞLATMA. Sunucu pencereyi (varsayılan 60 sn)
// sağ atlatırsa bütçe tazelenir; aynı pencerede ikinci ölüm = kalıcı arıza → quit.
//
// Bu dosya SAF: Electron/fs/net YOK. Çalıştır: node --test electron/nextServerPolicy.test.cjs

'use strict';

/** Aynı pencere içinde ikinci ölüm "kalıcı arıza" sayılır. */
const DEFAULT_WINDOW_MS = 60_000;
/** Pencere başına izin verilen yeniden başlatma sayısı. */
const DEFAULT_MAX_RESTARTS = 1;

/** Boş durum — çağıran bunu bir değişkende taşır. */
function initialState() {
  return { restarts: 0, windowStartedAt: null };
}

/**
 * Beklenmedik ölümden sonraki karar.
 *
 * @param {{restarts:number, windowStartedAt:number}} state önceki durum
 * @param {number} now Date.now()
 * @param {{windowMs?:number, maxRestarts?:number}} [opts]
 * @returns {{action:'restart'|'quit', attempt:number, state:object, why:string}}
 */
function decideOnUnexpectedExit(state, now, opts = {}) {
  const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : DEFAULT_WINDOW_MS;
  const maxRestarts = Number.isFinite(opts.maxRestarts) ? opts.maxRestarts : DEFAULT_MAX_RESTARTS;
  const prev = state && Number.isFinite(state.restarts) ? state : initialState();

  // Pencere kapandıysa bütçe tazelenir: saatler sonraki ikinci bir ölüm,
  // "sunucu hiç kalkmıyor" DEĞİLDİR.
  // ⚠️ `null` SENTINEL ŞART, `0` DEĞİL: `!windowStartedAt` yazıldığında `now===0`
  // olan her koşuda pencere SONSUZ tazeleniyordu (birim test kırmızı verdi) —
  // testte sahte saat 0'dan başlar, üründe Date.now() başlar; kusur ölçüm
  // aracında değil KURALDAYDI.
  const fresh = prev.windowStartedAt === null || prev.windowStartedAt === undefined
    || (now - prev.windowStartedAt) > windowMs;
  const restarts = fresh ? 0 : prev.restarts;
  const windowStartedAt = fresh ? now : prev.windowStartedAt;

  if (restarts < maxRestarts) {
    return {
      action: 'restart',
      attempt: restarts + 1,
      state: { restarts: restarts + 1, windowStartedAt },
      why: `1. ölüm (pencere ${Math.round(windowMs / 1000)} sn) → yeniden başlat`,
    };
  }
  return {
    action: 'quit',
    attempt: restarts,
    state: { restarts, windowStartedAt },
    why: `${restarts + 1}. ölüm aynı ${Math.round(windowMs / 1000)} sn içinde → kalıcı arıza`,
  };
}

module.exports = { initialState, decideOnUnexpectedExit, DEFAULT_WINDOW_MS, DEFAULT_MAX_RESTARTS };
