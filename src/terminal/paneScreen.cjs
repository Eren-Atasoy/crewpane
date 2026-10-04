'use strict';
// ADP-324 — pane çıktısının MOBİL görünümü: satır listesi değil, EKRAN DURUMU.
//
// KÖK NEDEN (ADP-323 §A ölçtü). Ajan CLI'ları (claude/codex) tam-ekran TUI'dir: ilerleme
// satırını `\r` + `\x1b[2K` ile YERİNDE yeniden çizer, `\n` basmaz. Eski `cleanPaneTail()`
// akışı yalnız `\n`'de bölüyordu → 175.000 karakterlik TEK DEV SATIR → mobilde "boş geçmiş".
// Terminal çıktısı bir satır akışı DEĞİL, bir ekran durumudur; masaüstünde doğru görünmesinin
// tek sebebi xterm.js'in VT emülatörü olmasıdır. Burada aynı motoru (@xterm/headless, renderer
// ile AYNI 6.0.0) main süreçte pane başına bir kez koşturup ekranı satırlaştırıyoruz.
//
// SATIR KESİNLEŞMESİ. Bir satır ancak viewport'un ÜSTÜNE kaydığında (yani `buffer.baseY`'nin
// üstünde kaldığında) değişmez olur — orada TUI'nin imleci artık ona erişemez. Viewport'takiler
// "canlı"dır (seq YOK): claude imleci yukarı taşıyıp bloğunu YENİDEN ÇİZEBİLİR, erken seq vermek
// defteri kirletirdi. Kesinleşen satır deftere `seq` ile yazılır → `seq` KALICI: sayfalama
// (`before`) ve kopan bağlantıda boşluk doldurma (`since`) güvenle çalışır.
//
// İKİ HASAT KİPİ — çünkü claude ALTERNATİF EKRANDA koşuyor (ÖLÇÜLDÜ, tahmin değil):
//
//   $ claude --dangerously-skip-permissions        → ham akışta `\x1b[?1049h`
//     buffer.type = "alternate" · baseY = 0 (hep) · scrollback = YOK
//
//   • NORMAL buffer (düz shell, `\n` basan her şey): satır viewport'un üstüne kayınca
//     scrollback'e girer ve DEĞİŞMEZ olur → hasat imleci bir xterm MARKER'ıdır (kendi
//     sayacımız DEĞİL: `onScroll` kaydırma-bölgesi (DECSTBM) kaydırmalarında da ateşlediği
//     için satır kaybettiriyordu — ölçüldü). Marker'ı buffer kırpılınca xterm kendisi kaydırır.
//
//   • ALTERNATE buffer (claude/codex TUI): kayan satır HİÇBİR YERE gitmez, motor onu ATAR.
//     "Üste kayanı deftere yaz" kuralı burada SIFIR satır üretir — yani özellik tam da işe
//     yaraması gereken yerde ölürdü (ADP-323'ün tasarımı bu ayrıntıyı atlamış). Bu yüzden
//     ekranı her flush'ta SNAPSHOT'layıp KAYMAYI TESPİT ediyoruz: ekran k satır yukarı
//     kaydıysa, üstten çıkan k satır artık geri gelmez → deftere yazılır. Kayma yoksa
//     (TUI yalnız kutusunu yeniden çiziyorsa) hiçbir şey yazılmaz — defter kirlenmez.
//
// Kapsam notu: masaüstü terminali ham pty baytlarını renderer'daki xterm'den almaya DEVAM eder
// ve lider `cleanPaneTail()`'i kullanmaya devam eder — bu modül yalnız MOBİL okuma kanalını
// besler (regresyon yüzeyi kasten dar tutuldu).
//
// ═══════════════════════════════════════════════════════════════════════════════════════
// ADP-362 — "MOBİL TERMİNAL OKUNMUYOR, SATIRLAR ÜST ÜSTE BİNİYOR" (Eren, P0) · 2026-07-14
//
// KÖK NEDEN — ÖLÇÜLDÜ, TAHMİN EDİLMEDİ. İki BAĞIMSIZ katman vardı:
//
//  1) BU DOSYA: VT genişliği SABİTTİ (`COLS = 100`) ve pty'nin gerçek genişliğini hiç
//     bilmiyordu. Oysa pty `cols`'u masaüstü xterm'inin FitAddon'undan gelir (main.js
//     spawn `{cols, rows}`; Terminal.tsx:260 her yeniden boyutlandırmada `pty:resize`) →
//     pencereye göre 120, 154… olabilir. Ajan CLI'ı (claude) TUI'sini PTY'nin cols'una
//     çizer. VT dar kalınca o satırları SARAR; claude ALTERNATİF ekranda koştuğu için de
//     hasat `harvestAlt()`'tan geçer ve orası her EKRAN SATIRINI ayrı bir mantıksal satır
//     sayıyordu → tek satır defterde İKİYE BÖLÜNÜYORDU.
//
//     ÖLÇÜM (alternatif ekran, aynı girdi):
//       pty=154 · VT=100 (eski) → 14 defter satırı, 7'si tam 100 karakterde KESİK
//       pty=154 · VT=154        → 12 defter satırı, kesik YOK
//     Sarma-birleştirme eklendikten sonra pty=154 · VT=100'de kesik 0'a düştü ama defter
//     41 satıra ŞİŞTİ (yeniden çizim tekrarları) → yani İKİ düzeltme de gerekliydi:
//       • `resize(cols, rows)`: VT artık PTY'yi İZLER (main.js spawn + 'pty:resize').
//       • `harvestAlt()` SARMA FARKINDA: `isWrapped` devam satırları birleştirilir → cols
//         uyuşmazlığı (resize'dan önceki yarış anları) satırı asla BÖLEMEZ.
//
//     NEDEN PTY'Yİ TAKİP EDİYORUZ, TELEFONU DEĞİL: "telefonun sütun sayısını gateway'e
//     bildir, VT'yi onunla koştur" yolu YANLIŞTIR — claude yine PTY'nin genişliğine çizer
//     (VT'yi daraltmak onu dar çizmeye ikna etmez, sadece sarar), üstelik pty'yi telefona
//     göre daraltmak AYNI pty'yi kullanan masaüstü terminalini bozardı. Terminalin
//     genişliği ajanın terminalinin genişliğidir; telefon onu OKUR.
//
//  2) İSTEMCİ (mobile/src/screens/WorkScreen.tsx): satırlar `<Text>` ile YUMUŞAK SARILIYORDU
//     → 120 karakterlik TUI satırı 390px'te ~4 görsel satıra bölünüyor, girinti ve kutu
//     çizgileri kayıyordu ("üst üste binmiş" görüntü). Düzeltme: sarma KAPALI
//     (`numberOfLines={1}`) + YATAY KAYDIRMA; okunabilirlik yatay yerden gelir → font
//     kademesi (11/12.5/14pt, cihazda kalıcı) + TAM EKRAN + yatay (landscape) çevirme.
//
// KANIT (gerçek tarayıcı, 390×844, ölçülmüş — ekran görüntüsü tek başına kanıt sayılmadı):
//   mobile/e2e/adp362-terminal-read.spec.cjs → GREEN
//     ✓ 5 geniş TUI satırının hepsi TEK görsel satır (h=18px = satır yüksekliği; sarma YOK)
//     ✓ yatay taşma kaydırılabilir: içerik 920px > görünür 326px (satır kırpılmıyor)
//     ✓ font 3 kademe 12.5 → 14 → 11pt, min 11pt korunuyor, yenilemeden sonra da kalıcı
//     ✓ tam ekran: terminal 491px → 810px, sekme+komut çubuğu gizli, ÇIK geri alıyor
//     ✓ yatayda görünür genişlik 820px (dikeyde 326px) → daha çok sütun, sarma yine yok
//   npm test → 772/772 · paneScreen birim testleri 13/13 · iki typecheck temiz
// ═══════════════════════════════════════════════════════════════════════════════════════

const { Terminal } = require('@xterm/headless');
const { createSupervisor } = require('../agents/moduleGuard.cjs');

// ADP-335 — TEST-ONLY hata enjeksiyonu. `CREWPANE_FAULT_INJECT=vt` ile harvest, Eren'in
// gördüğü çökmenin AYNISINI (ReferenceError) atar; amaç: hata sınırının GERÇEKTEN tuttuğunu
// çalışan uygulamada kanıtlamak. Env yoksa tek satır bile çalışmaz.
const FAULT_INJECT = String(process.env.CREWPANE_FAULT_INJECT || '').split(',').map((s) => s.trim());

const COLS = 100;
const ROWS = 30;
const SCROLLBACK = 2000;
/** Defterde tutulan azami satır (pane başına ~200-400 KB). */
const LEDGER_MAX = 2000;
/** Tek satır tavanı — mobil ağ + RN render'ı (bir TUI satırı kilobaytlarca olabilir). */
const LINE_MAX_CHARS = 1000;
/** Tek tail cevabı için toplam bayt tavanı. */
const TAIL_BYTES_MAX = 64 * 1024;
/** /m/panes listesindeki `lastLine` tavanı (766 KB'lık liste bu yüzden şişiyordu). */
const LAST_LINE_MAX = 200;
const TAIL_DEFAULT = 200;

const clampLine = (s) => (s.length > LINE_MAX_CHARS ? `${s.slice(0, LINE_MAX_CHARS - 1)}…` : s);

/**
 * Bir pane için VT ekranı + seq'li satır defteri.
 * @param {object} [opts]
 * @param {(entry:{seq:number,text:string}) => void} [opts.onLine]  satır KESİNLEŞTİĞİNDE (SSE)
 * @param {(text:string) => void} [opts.onLive]  viewport'un son satırı değiştiğinde (ilerleme)
 */
function createPaneScreen(opts = {}) {
  // ADP-362 — cols/rows ARTIK SABİT DEĞİL: pty'nin gerçek boyutuyla doğar ve `resize()` ile
  // onu izler (main.js: spawn + ipc 'pty:resize'). Gerekçe dosya başlığında.
  let cols = opts.cols || COLS;
  let rows = opts.rows || ROWS;
  const scrollback = opts.scrollback == null ? SCROLLBACK : opts.scrollback;
  const ledgerMax = opts.ledgerMax || LEDGER_MAX;

  const term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });

  // ADP-335 — bu PANE'in hata sınırı. 5 ardışık harvest hatası → bu pane'in VT defteri durur
  // (mobil o pane için "degrade" görür); pty, masaüstü terminali ve diğer pane'ler etkilenmez.
  const supervisor = createSupervisor({
    name: `vt-harvest${opts.paneId ? `:${opts.paneId}` : ''}`,
    onFault: (fault) => { if (opts.onFault) { try { opts.onFault(fault); } catch { /* yut */ } } },
    log: opts.log || (() => {}),
  });

  /** Hasat imleci: SON hasat edilen buffer satırına çakılı xterm marker'ı (bkz. başlık). */
  let marker = null;

  // ALT EKRAN: snapshot'ı HER KAYMADA al. `onScroll` parse SIRASINDA, kayan satır başına
  // senkron ateşlenir → ekranın ara hâllerini görürüz. Snapshot'ı yalnız write bitiminde
  // alsaydık (ilk tasarım), claude cevabını TEK CHUNK'ta basınca aradaki 37 satır hiç
  // gözlemlenmeden kayıp giderdi — GERÇEK claude koşusunda tam olarak bu oldu (defter=0).
  term.onScroll(() => { if (buf().type === 'alternate') harvestAlt(); });
  /** Yarım kalan mantıksal satır (satır sarması buffer sınırına denk gelirse). */
  let pending = null;
  /** Tavanı aşan sarmalı satırın kalan parçaları atlanıyor. */
  let skipping = false;
  /** ALTERNATE kip: bir önceki ekran görüntüsü (kayma tespiti için). */
  let prevRows = [];

  const ledger = []; // [{seq, text}] — seq monoton, KALICI
  let seq = 0;
  let dropped = 0;   // defterden düşen (tavan) satır sayısı
  let lostRows = 0;  // biz hasat edemeden buffer'dan kırpılan satır (patolojik)
  let lastLive = '';

  const buf = () => term.buffer.active;

  // PERF-BG-01 — canlı-satır hesabı gerekli mi? Çağıran (main.js) mobil abone
  // sayısını bilir; modül bilmez. KONTROL KOLU: CREWPANE_PANESCREEN_ALWAYS_LIVE=1
  // ile eski davranışa (her hasatta hesapla) dönülür.
  const wantsLive = process.env.CREWPANE_PANESCREEN_ALWAYS_LIVE === '1'
    ? () => true
    : (typeof opts.wantsLive === 'function' ? opts.wantsLive : () => true);

  function push(text) {
    const t = text.replace(/[ \t]+$/, '');
    if (!t.trim()) return; // TUI yeniden-çizimi bol boş satır bırakır — mobile taşımıyoruz
    ledger.push({ seq: ++seq, text: clampLine(t) });
    if (ledger.length > ledgerMax) { ledger.shift(); dropped += 1; }
    if (opts.onLine) { try { opts.onLine(ledger[ledger.length - 1]); } catch { /* dinleyici hatası akışı düşürmez */ } }
  }

  /**
   * Kesinleşmiş satırları (viewport üstü) deftere geçir. Satır sarması (isWrapped) bir MANTIKSAL
   * satıra birleştirilir: devam satırı henüz kesinleşmediyse `pending`'de bekletilir.
   */
  /**
   * ALTERNATE buffer hasadı — "EKRANDAN DÜŞEN satır" tespiti (ölçümle şekillendi).
   *
   * ÖLÇÜLEN GERÇEK: claude terminali KAYDIRMIYOR (tüm oturumda 1 adet `onScroll`); ekranı
   * kendi penceresiyle YENİDEN ÇİZİYOR ve kareler arasında büyük sıçramalar var
   * (banner → "4,5,6…" → "38,39,40…"). Yani "k satır kaydı" varsayımı yapısal olarak
   * YANLIŞ; kayan-satır sayacı da, sabit-k eşleştirmesi de burada sıfır satır üretir.
   *
   * DOĞRU MODEL: iki kare arasında EK YERİNİ bul — önceki ekranın en uzun SONEKİ, yeni
   * ekranın ÖNEKİNE eşitse pencere oradan ilerlemiş demektir. Hizanın ÖNÜNDE kalan satırlar
   * ekrandan DÜŞMÜŞTÜR → deftere yazılır. Hâlâ ekranda görünen satır (claude'un ALTTA sabit
   * duran giriş kutusu/ipucu çubuğu) asla yazılmaz → yeniden çizim defteri kirletmez.
   */
  function harvestAlt() {
    const b = buf();
    const cur = [];
    // ADP-362 — SARMA FARKINDA OKUMA. Eskiden her EKRAN SATIRI ayrı bir mantıksal satır
    // sayılıyordu: VT cols'u pty cols'undan darsa (eski hâlde VT hep 100'dü, pty ise
    // masaüstü xterm'inin fit'iyle 120-154 olabiliyor) claude'un tek satırı VT'de İKİ
    // ekran satırına sarılıyor ve deftere İKİ PARÇA olarak giriyordu → telefonda satırlar
    // "üst üste binmiş"/kırık görünüyordu (ölçüldü: 105 krlık satır 100'de kesiliyor).
    // Artık `isWrapped` devam satırları mantıksal satıra BİRLEŞTİRİLİR (liveLines() ile aynı
    // kural) → cols uyuşmazlığı satır BÖLEMEZ. resize() zaten uyuşmazlığı kapatıyor; bu,
    // yarış anları (resize henüz gelmeden akan çıktı) için ikinci savunma hattıdır.
    let acc = null;
    for (let i = 0; i < rows; i += 1) {
      const line = b.getLine(b.baseY + i);
      if (!line) continue;
      const text = line.translateToString(true);
      const next = b.getLine(b.baseY + i + 1);
      acc = acc == null ? text : acc + text;
      if (next && next.isWrapped) continue; // mantıksal satır sürüyor
      const t = clampLine(acc.replace(/[ \t]+$/, ''));
      if (t.trim()) cur.push(t);
      acc = null;
    }
    if (acc != null) {
      const t = clampLine(acc.replace(/[ \t]+$/, ''));
      if (t.trim()) cur.push(t);
    }

    if (prevRows.length) {
      const onScreen = new Set(cur); // hâlâ görünen satır DÜŞMEMİŞTİR
      // Ekranda KALAN ilk satır = pencerenin yeni üst sınırı. Onun ÜSTÜNDEKİLER düşmüştür.
      // Altında kalan değişiklikler YERİNDE çizimdir (spinner "✳ Flummoxing… 5s", giriş
      // kutusu, ipucu çubuğu) — bunlar tarih değildir, deftere ASLA girmez.
      const firstRetained = prevRows.findIndex((l) => onScreen.has(l));
      if (firstRetained > 0) {
        for (const line of prevRows.slice(0, firstRetained)) push(line);
      } else if (firstRetained === -1) {
        // Hiçbir satır tutmadı: ekran komple değişti (sıçrama / temizleme). Önceki içerik
        // kalıcı olarak gitti → yaz. Sabit kutu `onScreen`'de olduğu için zaten süzülür.
        for (const line of prevRows) if (!onScreen.has(line)) push(line);
      }
    }
    prevRows = cur;
  }

  /**
   * ADP-335 — HATA SINIRI. Bu fonksiyon xterm'in write callback'inden (ASENKRON) çağrılır:
   * içinde atılan sıradan bir kod hatası çağrı yerindeki try/catch'e UĞRAMAZ, doğrudan
   * uncaughtException olur ve TÜM UYGULAMAYI çökertirdi (Eren'in vakası: ReferenceError
   * `totalScrolled`). Artık supervisor içinde koşuyor: patlarsa YALNIZ bu pane'in defteri
   * bozulur (degraded), pty/masaüstü terminali/gateway/diğer pane'ler ÇALIŞMAYA DEVAM EDER.
   */
  function harvest() {
    supervisor.run('harvest', () => {
      if (FAULT_INJECT.includes('vt')) {
        // eslint-disable-next-line no-undef
        throw new ReferenceError('totalScrolled is not defined'); // sentetik (yalnız env ile)
      }
      if (buf().type === 'alternate') harvestAlt();
      else harvestNormal();

      // PERF-BG-01 — CANLI SATIR YALNIZ İZLEYEN VARSA HESAPLANIR.
      // `liveLines()` viewport'un TAMAMINI (≈40 satır × translateToString) yeniden
      // kurar ve bu, YAZILAN HER SATIR için tekrarlanıyordu: 1.200 satır/sn'lik tek
      // bir pane'de 48.000 satır dönüşümü/sn → ölçüldü, 60 sn'de 450 ms ANA SÜREÇ
      // CPU'su (scratchpad/perf-bg-01/onDataBench.cjs). Oysa tek tüketicisi
      // `onLive` (mobil SSE) ve o, abone yokken zaten ilk satırda geri dönüyordu —
      // yani bu iş kimsenin görmediği bir çıktı için yapılıyordu.
      // DEFTER (kesinleşen satır) YOLU DEĞİŞMEDİ: `push()` yukarıda koşar, mobil
      // sonradan bağlandığında geçmişi eksiksiz bulur. Kapanan tek şey CANLI
      // (kesinleşmemiş) satırın anlık yayını — onu dinleyen yokken anlamsızdır.
      if (wantsLive()) {
        const live = liveLines();
        const last = live.length ? live[live.length - 1] : '';
        if (last !== lastLive) {
          lastLive = last;
          if (last && opts.onLive) { try { opts.onLive(last); } catch { /* yut */ } }
        }
      }
    });
  }

  /** NORMAL buffer hasadı — kesinleşme = viewport üstüne kayma (marker imleci). */
  function harvestNormal() {
    const b = buf();
    if (prevRows.length) prevRows = []; // alt ekrandan normale döndük (TUI çıktı)
    // Kesinleşmiş bölge = [from, baseY-1]. `from` = marker'ın BİR ALTI. Marker düştüyse
    // (kırpma bizi geçti) baştan başlarız ve kaybı bildiririz.
    let from;
    if (marker && !marker.isDisposed && marker.line >= 0) {
      from = marker.line + 1;
    } else {
      if (marker) { lostRows += 1; pending = null; skipping = false; }
      from = 0;
    }
    for (let i = from; i < b.baseY; i += 1) {
      const line = b.getLine(i);
      if (!line) continue;
      const next = b.getLine(i + 1); // viewport'un ilk satırı da okunabilir
      const wraps = !!(next && next.isWrapped);
      if (skipping) { if (!wraps) skipping = false; continue; } // tavanı aşan satırın kuyruğu
      const text = line.translateToString(true);
      pending = pending == null ? text : pending + text;
      if (wraps) {
        // Ekrandan uzun tek mantıksal satır: tavana gelince BASILIR, kuyruğu atılır
        // (yoksa `pending` viewport'u aşar ve satır hiç deftere düşmez).
        if (pending.length >= LINE_MAX_CHARS) {
          push(`${pending.slice(0, LINE_MAX_CHARS - 1)}…`); // '…' = kuyruğu atıldı
          pending = null;
          skipping = true;
        }
        continue; // mantıksal satır sürüyor
      }
      push(pending);
      pending = null;
    }
    // İmleci son kesinleşmiş satıra çak. registerMarker OFFSET'i İMLECE göredir:
    // marker.line = baseY + cursorY + offset → offset = -1 - cursorY ⇒ baseY - 1.
    if (b.baseY > 0) {
      const fresh = term.registerMarker(-1 - b.cursorY);
      if (fresh) {
        if (marker && !marker.isDisposed) { try { marker.dispose(); } catch { /* yut */ } }
        marker = fresh;
      }
    }
  }

  /** Viewport'ta duran (HENÜZ kesinleşmemiş — TUI yeniden çizebilir) satırlar. */
  function liveLines() {
    const b = buf();
    const out = [];
    let acc = null;
    for (let i = b.baseY; i < b.length; i += 1) {
      const line = b.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      const next = b.getLine(i + 1);
      acc = acc == null ? text : acc + text;
      if (next && next.isWrapped) continue;
      const t = acc.replace(/[ \t]+$/, '');
      if (t.trim()) out.push(clampLine(t));
      acc = null;
    }
    if (acc != null && acc.trim()) out.push(clampLine(acc.replace(/[ \t]+$/, '')));
    return out;
  }

  /**
   * pty verisi → ekran. xterm'in write'ı ASENKRONDUR; hasat parse bitince yapılır.
   *
   * Veri SATIR SATIR beslenir (chunk bütün olarak değil): claude cevabını tek chunk'ta
   * basınca ekranın ARA HÂLLERİ hiç gözlemlenmiyor ve aradaki satırlar (ölçüm: 8…37)
   * hiçbir kareye düşmeden kayboluyordu. xterm'in ayrıştırıcısı akışkandır (parçalı besleme
   * güvenli); her satır sonrasında hasat edince pencerenin her adımı görülür.
   */
  //
  // ASK-CARD-01 — CHUNK'LAR SIRAYA GİRER (ölçülen kusur). `term.write` asenkron olduğu
  // için art arda gelen iki pty chunk'ının satırları birbirine KARIŞIYORDU: 1. chunk'ın
  // 2. satırı ancak 1. satırın callback'inde yazılırken, 2. chunk'ın 1. satırı çoktan
  // xterm kuyruğuna girmiş oluyordu (gerçek pty + 2 chunk'lık claude-benzeri çıktıda
  // 6 koşumun 3'ünde composer kutusu içerik satırlarının ARASINA çizildi). Yazımlar
  // artık tek zincirde: bir chunk'ın tüm satırları bitmeden sonraki başlamaz. Hasat
  // hatası zinciri KİLİTLEMEZ (supervisor zaten yutar; yine de link başına catch).
  let chain = Promise.resolve();
  function write(data, cb) {
    const parts = String(data).split(/(?<=\n)/); // '\n'DEN SONRA böl (escape dizisi bölünmez)
    chain = chain.then(() => new Promise((resolve) => {
      let i = 0;
      const step = () => {
        if (i >= parts.length) { if (cb) { try { cb(); } catch { /* dinleyici hatası zinciri düşürmez */ } } resolve(); return; }
        const part = parts[i];
        i += 1;
        if (!part) { step(); return; }
        term.write(part, () => {
          try { harvest(); } catch { /* supervisor yutar; zincir sürer */ }
          step();
        });
      };
      try { step(); } catch { resolve(); }
    })).catch(() => { /* zincir asla kırılmaz */ });
  }

  /**
   * Seq'li tail. Üç mod:
   *   (varsayılan) son N kesinleşmiş satır + canlı satırlar
   *   before=<seq>  → seq'ten ÖNCEKİ son N satır (geriye sayfalama)
   *   since=<seq>   → seq'ten SONRAKİ satırlar (kopan SSE'de boşluk doldurma)
   * Bayt tavanı aşılırsa EN ESKİ satırlar düşürülür (`bytesCapped`).
   */
  function tail(opts2 = {}) {
    // ADP-335 — okuma sınırı: ekran bozuksa defter (zaten toplanmış satırlar) yine döner,
    // `live` boş kalır ve `degraded:true` gider. Mobil rota 500 yerine DÜRÜST cevap alır.
    return supervisor.run('tail', () => tailUnsafe(opts2), {
      entries: ledger.slice(-(Number(opts2.lines) || TAIL_DEFAULT)),
      lines: ledger.slice(-(Number(opts2.lines) || TAIL_DEFAULT)),
      live: [],
      firstSeq: 0,
      lastSeq: seq,
      hasMore: false,
      gapped: false,
      bytesCapped: false,
      truncated: true,
      degraded: true,
      fault: supervisor.state().lastFault,
    });
  }

  function tailUnsafe({ lines = TAIL_DEFAULT, before = null, since = null } = {}) {
    const n = Math.max(1, Math.min(ledgerMax, Number(lines) || TAIL_DEFAULT));
    let picked;
    let gapped = false;
    if (since != null) {
      const s = Number(since);
      picked = ledger.filter((e) => e.seq > s).slice(0, n);
      // İstenen seq defterden düşmüşse aradaki satırlar KAYIP — istemci tam tail çekmeli.
      gapped = ledger.length > 0 && s < ledger[0].seq - 1;
    } else if (before != null) {
      const b = Number(before);
      picked = ledger.filter((e) => e.seq < b).slice(-n);
    } else {
      picked = ledger.slice(-n);
    }

    let bytes = picked.reduce((a, e) => a + Buffer.byteLength(e.text) + 12, 0);
    let bytesCapped = false;
    while (picked.length > 1 && bytes > TAIL_BYTES_MAX) {
      const gone = picked.shift();
      bytes -= Buffer.byteLength(gone.text) + 12;
      bytesCapped = true;
    }

    const oldestSeq = ledger.length ? ledger[0].seq : 0;
    return {
      entries: picked,
      lines: picked.map((e) => e.text), // geri-uyum: eski istemci düz string dizisi bekler
      live: since != null ? [] : liveLines(),
      firstSeq: picked.length ? picked[0].seq : 0,
      lastSeq: picked.length ? picked[picked.length - 1].seq : 0,
      // `before` ile daha eskiye gidilebilir mi? (defterde hâlâ satır var mı)
      hasMore: picked.length ? picked[0].seq > oldestSeq : false,
      gapped,
      bytesCapped,
      truncated: dropped > 0 || lostRows > 0,
      // ADP-335 — bu pane'in VT defteri bir kod hatası yüzünden DURDU. Yalan söylemiyoruz:
      // istemci "bu pane'in geçmişi bozuk" diyebilsin (uygulama ve diğer pane'ler sağlam).
      degraded: supervisor.isStopped(),
      fault: supervisor.state().lastFault,
      totalSeq: seq,
    };
  }

  /**
   * /m/panes listesi için: en son görünen satır (canlı varsa o), KIRPILMIŞ.
   * ADP-335 — OKUMA da sınırın içinde: bozuk bir ekran, kendisini SORAN kodu (gateway'in
   * pane listesi, mobil tail rotası) çökertemez; boş/degrade döner.
   */
  function lastLine() {
    return supervisor.run('lastLine', () => {
      const live = liveLines();
      const text = live.length ? live[live.length - 1] : ledger.length ? ledger[ledger.length - 1].text : '';
      return text.length > LAST_LINE_MAX ? `${text.slice(0, LAST_LINE_MAX - 1)}…` : text;
    }, '');
  }

  function stats() {
    const base = { seq, ledger: ledger.length, dropped, lostRows, cols, rows, scrollback, degraded: supervisor.isStopped() };
    return { ...base, baseY: supervisor.run('stats', () => buf().baseY, -1) };
  }

  /**
   * ADP-362 — VT'yi PTY'nin boyutuna EŞİTLE (main.js her 'pty:resize'ta çağırır).
   *
   * NEDEN pty (telefon değil): ajan CLI'ı (claude) TUI'sini PTY'nin cols'una göre çizer.
   * VT'yi telefonun dar sütun sayısına kursaydık claude yine geniş çizmeye devam eder,
   * VT o satırları sarar ve okuma yine bozulurdu — üstelik masaüstü terminali AYNI pty'yi
   * paylaştığı için pty'yi telefona göre daraltmak masaüstünü bozardı. Doğru tek-kaynak
   * PTY'dir; telefon okunabilirliği İSTEMCİDE çözülür (sarma kapalı + yatay kaydırma +
   * font kademesi + tam ekran) — bkz. mobile/src/screens/WorkScreen.tsx.
   *
   * xterm'in resize'ı buffer'ı yeniden akıtır; defterdeki (kesinleşmiş) satırlar METİN
   * olarak saklandığı için etkilenmez. Kayma tespitinin referans karesi geçersizleşir →
   * prevRows sıfırlanır (yeniden çizilen ekran yanlışlıkla "düşmüş" sayılmasın).
   */
  function resize(nextCols, nextRows) {
    // GEÇERSİZ girdi REDDEDİLİR — kırpılmaz. (İlk hâlinde clamp 0/NaN'ı 20×5'e çeviriyordu:
    // ölü bir pane'den gelen bozuk bir resize, VT'yi 20 sütuna düşürüp defteri bölerdi.)
    const rawC = Number(nextCols);
    const rawR = Number(nextRows);
    if (!Number.isFinite(rawC) || !Number.isFinite(rawR) || rawC < 1 || rawR < 1) return false;
    const c = Math.max(20, Math.min(500, Math.trunc(rawC)));
    const r = Math.max(5, Math.min(200, Math.trunc(rawR)));
    if (c === cols && r === rows) return false;
    return supervisor.run('resize', () => {
      term.resize(c, r);
      cols = c;
      rows = r;
      prevRows = [];
      pending = null;
      skipping = false;
      return true;
    }, false);
  }

  function dispose() { try { term.dispose(); } catch { /* best-effort */ } }

  return { write, tail, lastLine, liveLines, resize, stats, dispose, get term() { return term; } };
}

module.exports = {
  createPaneScreen,
  COLS, ROWS, SCROLLBACK, LEDGER_MAX, LINE_MAX_CHARS, TAIL_BYTES_MAX, LAST_LINE_MAX, TAIL_DEFAULT,
};
