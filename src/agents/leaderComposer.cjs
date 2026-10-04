// CrewPane — ADP-659/667: lider composer idle-guard'ı (saf, leaf).
//
// NEDEN MAIN'DE: ADP-575 bu guard'ı `src/app/lib/delegationFollow.ts`'e (renderer/TS)
// koydu. ADP-659 supervisor'ı MAIN'de yaşıyor (renderer reload'unu atlatmak ZORUNDA)
// ve main CJS'ten renderer TS'i require edilemez. Guard buraya port edildi ve
// `IDLE_FIXTURES` ile DRIFT-GUARD altına alındı: `delegationFollow.test.mts` +
// `delegationSupervisor.test.cjs` AYNI tabloyu koşar, iki uygulama ayrışırsa test
// KIRMIZI verir ([[leaf-module-node-test]] deseni).
//
// ─────────────────────────────────────────────────────────────────────────────
// ADP-667 — "BEN YAZARKEN ARAYA GİRİYOR" ÖLÇÜLEN KÖK NEDENİ
// ─────────────────────────────────────────────────────────────────────────────
// Guard VARDI ama composer'a hiç BAKMIYORDU: yalnız "görünür SON satır" heuristiği
// koşuyordu. claude/codex TUI'si composer'ı bir KUTUNUN İÇİNE çizer:
//
//     ╭──────────────────────────────────────╮
//     │ > ADP-667 görevini wheeljack'e ver   │   ← kullanıcının YARIM prompt'u
//     ╰──────────────────────────────────────╯   ← görünür SON satır
//       ? for shortcuts
//
// Son satır ya kutunun ALT KENARI (`╰───╯`) ya da ipucu satırıdır. ADP-659'un
// "son satırda harf/rakam yoksa orada kullanıcı metni yoktur" kuralı alt kenarı
// ÇIPLAK PROMPT sanıyordu → guard "yazmak güvenli" diyordu ve mesaj yarım prompt'un
// üstüne düşüyordu. (Ölçüldü: `leaderComposerIdle(frame, frame) === true` — oysa
// composer'da yazılmış metin duruyordu.) Ters yönde de bozuktu: ipucu satırı
// ("? for shortcuts") harf taşıdığı için BOŞ composer "meşgul" sayılıyor, lider
// hiç uyandırılamıyordu — ADP-575'in "pratikte ulaşmıyor" şikâyetinin ikinci yarısı.
//
// ADP-667 DÜZELTMESİ: guard artık COMPOSER'I bulur. Kutu çizilmişse (TUI modu) alt
// kenarları/ipucu satırlarını atlayıp kutu içindeki prompt satırını okur; kutu
// yoksa (düz shell) eski tek-satır mantığı aynen koşar. Bulamazsa → BİLİNMİYOR =
// ERTELE. Ayrıca "esc to interrupt" (motor bir turu KOŞUYOR) da meşgul sayılır:
// çalışan bir tura yazmak hem turu bozar hem mesajı kuyruğa iter.
//
// Sözleşme (ADP-575'ten, korunuyor): iki ARDIŞIK ham pty buffer okuması al; yalnız
// (1) buffer STABİL ve (2) composer BOŞ ise true. Emin değilsen false = ERTELE —
// ertelemek asla yarım-prompt clobber etmez, kalıcı notify-log completion'ı zaten
// taşır. ADP-667 buna ÜÇÜNCÜ bir sinyal ekler: `leaderWakeSafe` son TUŞ BASIMINDAN
// beri sessiz geçen süreyi de arar (main pty:input'ta damgalar) — buffer henüz
// echo etmemiş olsa bile insan yazıyorsa yazım ertelenir.

'use strict';

// delegationFollow.ts:IDLE_ANSI ile BİREBİR aynı (ESC/CSI + parametre + ARA BAYT + final).
//
// ENG-01 — iki delik kapatıldı (ikisi de codex TUI'sinde ÖLÇÜLDÜ):
//  (1) ARA BAYT sınıfı ([\x20-\x2f]*) yoktu. codex imleç-şekli için DECSCUSR
//      (`ESC [ 0 SP q`) basar — 5 dakikalık gerçek oturumda 1085 kez. Desen SP'de
//      ölür, geriye `0 q` ARTIĞI kalır: PURE_BORDER tutmaz, PROMPT_MARK tutmaz →
//      "composer boş mu?" sorusu KİRLİ metinle cevaplanır (yanlış ERTELE ya da
//      daha kötüsü yanlış "boş" → yarım-prompt clobber).
//  (2) OSC (`ESC ] … BEL|ST`) HİÇ süzülmüyordu. codex/claude pencere başlığını
//      OSC ile yazar; başlık metni satır içine düz metin gibi düşer (başlıkta
//      `>` varsa PROMPT_MARK'ı bile kandırabilir).
// Not: OSC ÖNCE süzülür (limitDetect.stripAnsi ile aynı sıra) — yoksa CSI deseni
// OSC gövdesini parçalar ve sonlandırıcı yetim kalır.
// eslint-disable-next-line no-control-regex
const IDLE_OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const IDLE_ANSI = /[\x1b\x9b][[()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[\x20-\x2f]*[\dA-PRZcf-nqry=><~]/g;

/** Composer'ın prompt işaretçileri (kutu içi ve düz). */
const PROMPT_MARK = /^([>❯›])\s*(.*)$/u;
/** Yalnız kutu/çizgi/boşluktan oluşan satır (alt-üst kenar, kutu içi boş satır). */
const PURE_BORDER = /^[╭╮╰╯┌┐└┘─━═│┃|┆┊\s]*$/u;
/** Kutu içinde mi (satır dikey çubukla başlıyor)? */
const IN_BOX = /^\s*[│┃┆┊]/u;
/** Kutu çizildi mi (TUI modu)? */
const HAS_BOX = /[╭╮╰╯┌┐└┘│┃]/u;
/**
 * Motor BİR TURU KOŞUYOR imzaları. Bu haldeyken yazmak turu böler ve mesaj kuyruğa
 * düşer → hem lider bozulur hem mesaj gecikir. ERTELE (backoff zaten tekrar dener).
 */
const RUNNING_HINTS = /(esc to interrupt|ctrl\+c to (stop|interrupt))/i;
/** TUI'nin kutu ALTINA bastığı BİLİNEN ipucu/durum satırları (girinti kuralının yedeği). */
const KNOWN_HINT = /(for shortcuts|bypass permissions|to confirm|to cancel|to interrupt|auto-compact|shift\+tab)/i;
/** Görünür kuyruğun taranacağı satır sayısı (composer birkaç satır yukarıda olabilir). */
const TAIL_ROWS = 16;

/** Ham buffer → görünür satırlar (ANSI temiz, `\r` üzerine-yazma + `\b` uygulanmış). */
function visibleRows(buffer) {
  const clean = String(buffer)
    .replace(IDLE_OSC, '')
    .replace(IDLE_ANSI, '')
    .replace(/\r\n/g, '\n');
  const rows = [];
  for (const raw of clean.split('\n')) {
    // Terminal `\r`'de satırı başa sarıp ÜZERİNE yazar → görsel satır = son DOLU segment.
    const segs = raw.split('\r');
    let seg = '';
    for (let i = segs.length - 1; i >= 0; i--) {
      if (segs[i].trim() !== '') { seg = segs[i]; break; }
    }
    // Shell echo'su satırı yeniden çizerken `\b` (backspace) basar → uygula.
    let line = '';
    for (const ch of seg) line = ch === '\b' ? line.slice(0, -1) : line + ch;
    rows.push(line.replace(/\s+$/u, ''));
  }
  while (rows.length && rows[rows.length - 1] === '') rows.pop();
  return rows;
}

/** Düz-shell (kutusuz) modun tek-satır hükmü — ADP-575/659 mantığı, değişmedi. */
function bareLineIdle(line) {
  const l = line.replace(/[\s│┃|]+$/u, '');
  if (l === '') return false;
  if (/[%$#>❯›]$/u.test(l)) return true;
  if (/[>❯›][\s│┃|]*$/u.test(l)) return true;
  // ADP-659 — SEMBOL PROMPT'LARI (Starship/p10k/oh-my-zsh: "∙", "➜", "λ", "→").
  // Yazılmış bir komut neredeyse her zaman ALFANUMERİK içerir; görünür satırda hiç
  // harf/rakam yoksa orada kullanıcı metni YOKtur. (Yarım komut "∙ git st" taşır.)
  if (!/[\p{L}\p{N}]/u.test(l)) return true;
  return false; // satırda yazılmış metin var → composer meşgul
}

/**
 * AXP-12 — claude 2.1.27x composer'ı KUTU DEĞİL, iki YATAY ÇİZGİ arasındadır:
 *
 *     ───────────────────────────────────────
 *     ❯ <yazılan metin | boş>
 *     ───────────────────────────────────────
 *       ⏸ manual mode on · ? for shortcuts · ← for agents
 *
 * Çizgi satırı = yalnız `─━═`den oluşan uzun satır. Composer = tail'de EN SON
 * "[çizgi, `❯ …`]" bitişikliği. Menü/izin diyaloğu da tek çizgi çizer ama çizginin
 * ALTINDA `❯` yerine " Bash command" gibi metin gelir → bitişiklik tutmaz → menü.
 */
const RULE_LINE = /^\s*[─━═]{8,}\s*$/u;
/**
 * AXP-12 — MENÜ İMLECİ: `❯ 1. Yes` / `> 2. No, exit`. Prompt işaretçisi + numaralı
 * seçenek = AÇIK MENÜ, yazılmış metin DEĞİL. Eski kod bunu PROMPT_MARK ile 'text'
 * okuyordu → submitOutcome 'pending' → Enter tekrarı menüden SEÇİM yapardı (ölçüldü:
 * limit menüsü fixture'ı 'text' dönüyordu). Prompt ayrıştırmasından ÖNCE denenir.
 */
const MENU_CURSOR = /^\s*[>❯›]\s*\d{1,2}[.)]\s/u;

/**
 * ENT-F1 — composer'ın İNCE hâli (main tarafı). `src/app/lib/delegationFollow.ts`
 * `composerScan`inin BİREBİR ikizidir; `composerState` artık BUNDAN türer, yani
 * main'de composer'ı okuyan TEK ayrıştırma bu fonksiyondur (üçüncü kopya YOK).
 *
 * NEDEN İNCE HÂL MAIN'E DE GEREKLİ: `electron/submitOutcome.cjs` (ENT-F1) "benim
 * Enter'ım işledi mi" sorusunu ana süreçte de cevaplamak zorunda — ve o sorunun
 * cevabı 'busy'nin İÇİNDE saklı: 'text' (asılı prompt → Enter TEKRARLA) ile
 * 'menu' (açık seçim → Enter basmak SEÇİM yapar, ASLA tekrarlama) aynı 'busy'ye
 * düşüyordu. Kaba hâl ile teslim doğrulaması yazılamaz.
 *
 *   'empty'   — prompt işaretçisi var, İÇİ BOŞ
 *   'text'    — prompt işaretçisinin YANINDA metin (`> [Pasted text #1 …]`)
 *   'menu'    — kutu içi prompt-olmayan içerik / sütun-0 echo / menü imleci → Enter TEHLİKELİ
 *   'running' — motor bir turu koşuyor (`esc to interrupt`)
 *   'unknown' — okunamadı
 *
 * `opts.ignoreRunning` — koşu kısa-devresini ATLA ve composer'ın KENDİSİNİ oku
 * (AD-DELEG-01: ekrandaki `esc to interrupt` ESKİ turun kanıtıdır, bizim
 * Enter'ımızın DEĞİL).
 *
 * AXP-12 — GİRDİ SÖZLEŞMESİ: `buffer` ya ham pty akışıdır (düz shell / `\n` basan
 * TUI'ler) ya da VT EKRAN METNİDİR (`paneScreen.liveLines().join('\n')`). claude
 * 2.1.27x alternatif ekranda mutlak imleçle çizer ve `\n` basmaz; onun HAM akışı
 * burada okunamaz (tek satıra çöker) — çağıran ekran metnini vermelidir
 * (main.js `paneScreenText`). Bu fonksiyon ikisini de aynı grammarla okur.
 * @param {string} buffer
 * @param {{ignoreRunning?:boolean}} [opts]
 * @returns {'empty'|'text'|'menu'|'running'|'unknown'}
 */
function composerScan(buffer, opts) {
  return composerDiag(buffer, opts).verdict;
}

/**
 * AXP-12 — `composerScan`in TEŞHİSLİ hâli: hükmü HANGİ satır, HANGİ dal verdi?
 * Makbuz `verdictTrail`i ve log bunu taşır ki "menü açık" hükmü bir daha kanıtsız
 * kalmasın (#YHL8/#6QG5'te ham satır saklanmamıştı, hüküm çelişkiyle çürütüldü).
 *
 * Dallar: blank · running · rule-empty/rule-text (çizgi-composer) · menu-cursor ·
 * bare-empty/bare-menu (düz shell, dal a) · box-out-prompt/box-out-hint→devam/
 * box-out-menu (dal b) · box-in-prompt/box-in-menu (dal c) · box-unknown.
 * @returns {{verdict:'empty'|'text'|'menu'|'running'|'unknown', branch:string, row:string, rows:string[]}}
 */
function composerDiag(buffer, opts) {
  if (typeof buffer !== 'string' || buffer.trim() === '') return { verdict: 'unknown', branch: 'blank', row: '', rows: [] };
  const rows = visibleRows(buffer);
  if (rows.length === 0) return { verdict: 'unknown', branch: 'blank', row: '', rows: [] };
  const tail = rows.slice(-TAIL_ROWS);
  const out = (verdict, branch, row) => ({ verdict, branch, row: row == null ? '' : row, rows: tail });
  // Motor bir turu koşuyorsa composer'ın boş görünmesi ALDATICIDIR.
  if (!(opts && opts.ignoreRunning)) {
    const run = tail.find((r) => RUNNING_HINTS.test(r));
    if (run !== undefined) return out('running', 'running', run);
  }
  // AXP-12 — claude 2.1.27x: EN SON "[çizgi, ❯ …]" bitişikliği composer'dır (kutu yok).
  for (let i = tail.length - 1; i >= 1; i--) {
    if (!RULE_LINE.test(tail[i - 1])) continue;
    const row = tail[i];
    if (MENU_CURSOR.test(row)) return out('menu', 'menu-cursor', row);
    const m = PROMPT_MARK.exec(row.replace(/\s+$/u, ''));
    if (!m) continue;
    if (m[2].trim() !== '') return out('text', 'rule-text', row);
    // İşaretçi boş; composer çok satırlıysa devam satırları alttaki çizgiye kadar sürer.
    for (let j = i + 1; j < tail.length && !RULE_LINE.test(tail[j]); j++) {
      if (tail[j].trim() !== '') return out('text', 'rule-text', tail[j]);
    }
    return out('empty', 'rule-empty', row);
  }
  if (!tail.some((r) => HAS_BOX.test(r))) {
    // Düz shell: yalnız görünür SON satır konuşur (üstündeki çıktı satırları değil).
    // 'text' düz-shell'de HİÇ dönmez ('menu'ye düşer): kabuk pane'ine kendiliğinden
    // Enter basmak bir KOMUT çalıştırabilir.
    const last = tail[tail.length - 1];
    if (MENU_CURSOR.test(last)) return out('menu', 'menu-cursor', last);
    return bareLineIdle(last) ? out('empty', 'bare-empty', last) : out('menu', 'bare-menu', last);
  }
  // TUI modu: kenar/ipucu satırlarını atla, KUTU İÇİNDEKİ composer satırını bul.
  for (let i = tail.length - 1; i >= 0; i--) {
    const row = tail[i];
    if (row === '' || PURE_BORDER.test(row)) continue;
    if (!IN_BOX.test(row)) {
      // Kutu dışı satır: prompt işaretçisiyle başlıyorsa composer'ın kendisidir
      // (kutunun sol çubuğu her zaman yakalanmaz).
      const bare = row.replace(/[\s│┃┆┊]+$/u, '');
      if (MENU_CURSOR.test(bare)) return out('menu', 'menu-cursor', row);
      const bm = PROMPT_MARK.exec(bare);
      if (bm) return bm[2].trim() === '' ? out('empty', 'box-out-prompt', row) : out('text', 'box-out-prompt', row);
      // ADP-667 (2. tur, e2e ile ölçüldü) — kutunun ALTINDAKİ metin İKİ ŞEY olabilir:
      // (a) TUI'nin ipucu/durum satırı ("? for shortcuts", "⏵⏵ bypass permissions on"),
      // (b) KULLANICININ o an yazdığı, terminalin echo ettiği metin (canonical modda
      //     satır çekirdekte bekler, TUI'ye HİÇ ulaşmaz → kutu BOŞ görünür ama kullanıcı
      //     yazıyordur). (b)'yi ipucu sanmak tam da Eren'in şikâyetini üretir.
      // Ayrım: TUI ipuçları GİRİNTİLİ basılır ("  ? for shortcuts"), terminal echo'su
      // sütun 0'dan başlar. Girintisiz + bilinmeyen metin → EMİN DEĞİLİZ → ERTELE.
      if (/^\s/.test(row) || KNOWN_HINT.test(row)) continue;
      return out('menu', 'box-out-menu', row);
    }
    const content = row.replace(/^\s*[│┃┆┊]\s?/u, '').replace(/[\s│┃┆┊]+$/u, '');
    if (content === '') continue; // kutu içi boş satır
    if (MENU_CURSOR.test(content)) return out('menu', 'menu-cursor', row);
    const m = PROMPT_MARK.exec(content);
    if (m) return m[2].trim() === '' ? out('empty', 'box-in-prompt', row) : out('text', 'box-in-prompt', row);
    return out('menu', 'box-in-menu', row); // kutu içi metin: çok satırlı composer içeriği ya da AÇIK MENÜ
  }
  return out('unknown', 'box-unknown', ''); // kutu var ama composer okunamadı → EMİN DEĞİLİZ → ERTELE
}

function composerState(buffer) {
  const scan = composerScan(buffer);
  if (scan === 'empty') return 'empty';
  if (scan === 'unknown') return 'unknown';
  return 'busy';
}

/**
 * Lider composer'ı enjeksiyona GÜVENLİ mi? (prev/cur = iki ardışık HAM buffer okuması;
 * ÇAĞIRAN aralarında GERÇEK bir gecikme bırakmalı — aynı anda alınan iki okuma
 * "stabil" der ama hiçbir şey kanıtlamaz.)
 * @returns {boolean} true → yazmak güvenli; false → ertele.
 */
function leaderComposerIdle(prevBuffer, curBuffer) {
  if (typeof curBuffer !== 'string' || curBuffer.trim().length === 0) return false;
  if (prevBuffer !== curBuffer) return false; // hâlâ render / insan yazıyor → ertele
  return composerState(curBuffer) === 'empty';
}

/** `leaderWakeSafe` varsayılan sessizlik penceresi (son tuş basımından beri). */
const DEFAULT_INPUT_QUIET_MS = 2000;

/**
 * ADP-692 — TASLAK penceresi. "Son ENTER'dan beri tuş basıldı" hâli SÜRESİZ sürmemeli:
 * kullanıcı yarım bir şey yazıp gidebilir (ya da bir ESC/ok tuşu basıp bırakabilir) ve
 * enjeksiyon sonsuza dek kilitlenirse OTOPİLOT durur. Bu süre dolduktan sonra kilit
 * kalkar — ama composer sinyali (`composerState`) hâlâ koşar: gerçekten yazılmış bir
 * taslak zaten 'busy' okunur, yani kilit yalnız GÖRÜNMEZ taslağın belt'idir.
 */
const DEFAULT_DRAFT_GRACE_MS = 30_000;

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ADP-692 — İNSAN VARLIĞI (Eren'in P0 şikâyeti: "yarım prompt'um gönderiliyor")
 * ─────────────────────────────────────────────────────────────────────────────
 * ADP-667'nin üç sinyali (stabil buffer + boş composer + tuş sessizliği) MİKRO YARIŞA
 * açıktı: nöbetçi t=0'da "boş" der, kullanıcı t=0.1'de yazmaya başlar, t=0.2'de mesaj
 * kutuya düşer. Kök sebep, sinyallerin hepsinin EKRANI okumasıydı — oysa bir tuş basımı
 * ile onun TUI'de çizilmesi arasında pencere vardır (canonical modda satır çekirdekte
 * bekler, TUI'ye HİÇ ulaşmaz).
 *
 * Bu fonksiyon ekrana DEĞİL, main'in kendi tuş defterine bakar ve ikisini ayırır:
 *
 *   • lastInputAt  — bu pane'e en son NE ZAMAN tuş basıldı (renderer `pty:input`;
 *                    lider pane'ine delegasyon/recycler ASLA yazmaz → ≈ İNSAN).
 *   • lastSubmitAt — o tuşların en son NE ZAMAN bir ENTER (CR/LF) ile GÖNDERİLDİĞİ.
 *
 * `lastInputAt > lastSubmitAt` ⇒ son gönderimden BERİ tuş basılmış ⇒ UÇUŞTA BİR TASLAK
 * VAR. Bu hüküm ilk tuşun EKRANA ÇİZİLMESİNİ BEKLEMEZ — yarışın kaynağı olan pencereyi
 * yapısal olarak kapatır. Requirement (2)'nin "yalnız gönderim sonrası boşluk (TASLAK
 * VARSA ASLA)" kuralının tam karşılığıdır.
 *
 * @param {{lastInputAt?:number|null, lastSubmitAt?:number|null, now?:number,
 *          quietMs?:number, draftGraceMs?:number}} [o]
 * @returns {{present:boolean, reason:'draft'|'quiet'|'none'}}
 */
function humanPresence(o) {
  const opts = o || {};
  const lastInputAt = typeof opts.lastInputAt === 'number' && opts.lastInputAt > 0 ? opts.lastInputAt : 0;
  if (!lastInputAt) return { present: false, reason: 'none' };
  const lastSubmitAt =
    typeof opts.lastSubmitAt === 'number' && opts.lastSubmitAt > 0 ? opts.lastSubmitAt : 0;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const quiet = typeof opts.quietMs === 'number' ? opts.quietMs : DEFAULT_INPUT_QUIET_MS;
  const grace = typeof opts.draftGraceMs === 'number' ? opts.draftGraceMs : DEFAULT_DRAFT_GRACE_MS;
  // (1) TASLAK UÇUŞTA — son ENTER'dan sonra tuş basılmış. Kullanıcı prompt YAZIYOR.
  if (lastInputAt > lastSubmitAt && now - lastInputAt < grace) return { present: true, reason: 'draft' };
  // (2) AZ ÖNCE tuşladı (gönderdi ama hâlâ klavyede) → kısa nefes payı.
  if (now - lastInputAt < quiet) return { present: true, reason: 'quiet' };
  return { present: false, reason: 'none' };
}

/**
 * ADP-692 — ENJEKSİYON KAPISI (kanal B: otopilot). `leaderWakeSafe`'in üstüne İNSAN
 * VARLIĞI şartını koyar: kullanıcı bu lider pane'iyle etkileşimdeyse HİÇ yazılmaz —
 * lider bitişleri kanal A ile (tur-başı brifing) zaten öğrenir, mesaj kaybolmaz.
 *
 * @returns {{safe:boolean, reason:'ok'|'composer'|'draft'|'quiet'}}
 */
function injectionGate(prevBuffer, curBuffer, o) {
  const presence = humanPresence(o);
  if (presence.present) {
    // ADP-692 İYİLEŞTİRME: presence 'draft' diyorsa ama ekran stabil, composer kutusu
    // tamamen BOŞ ('empty') ve son tuşun üzerinden sessizlik süresi geçmişse,
    // ortada gerçek bir taslak yoktur (silinmiş/boş/yön tuşu kalıntısı).
    // Otopilotu gereksiz kitlemeyip yazıma devam edilir.
    const quiet = (o && typeof o.quietMs === 'number') ? o.quietMs : DEFAULT_INPUT_QUIET_MS;
    const now = (o && typeof o.now === 'number') ? o.now : Date.now();
    const lastInputAt = (o && typeof o.lastInputAt === 'number') ? o.lastInputAt : 0;
    const isQuiet = (now - lastInputAt) >= quiet;
    if (presence.reason === 'draft' && isQuiet && leaderComposerIdle(prevBuffer, curBuffer)) {
      // Ekranda taslak YOK, tuş sessizliği tamam → güvenli
    } else {
      return { safe: false, reason: presence.reason };
    }
  }
  if (!leaderWakeSafe(prevBuffer, curBuffer, o)) return { safe: false, reason: 'composer' };
  return { safe: true, reason: 'ok' };
}

/**
 * ADP-667 — ÜÇ SİNYALLİ yazım kapısı. Buffer sinyali tek başına yetmiyor: bir tuş
 * basımı ile onun ekrana echo'su arasında pencere vardır (özellikle uzak/ağır TUI'de),
 * o pencerede buffer "stabil ve boş" görünür. Main `pty:input`'ta her insan tuşunu
 * damgalar; burada son tuştan beri en az `quietMs` geçmiş olmalı.
 *
 * @param {string} prevBuffer  ardışık okuma 1
 * @param {string} curBuffer   ardışık okuma 2 (aralarında gerçek gecikme olmalı)
 * @param {{lastInputAt?:number|null, now?:number, quietMs?:number}} [o]
 * @returns {boolean} true → yaz; false → ERTELE (emin değilsek hep false).
 */
function leaderWakeSafe(prevBuffer, curBuffer, o) {
  const opts = o || {};
  if (!leaderComposerIdle(prevBuffer, curBuffer)) return false;
  const lastInputAt = opts.lastInputAt;
  if (typeof lastInputAt === 'number' && lastInputAt > 0) {
    const now = typeof opts.now === 'number' ? opts.now : Date.now();
    const quiet = typeof opts.quietMs === 'number' ? opts.quietMs : DEFAULT_INPUT_QUIET_MS;
    if (now - lastInputAt < quiet) return false; // insan AZ ÖNCE tuşladı → ertele
  }
  return true;
}

/**
 * DRIFT-GUARD tablosu — main (CJS) ve renderer (TS) uygulamaları AYNI cevabı vermeli.
 * Her giriş: [ad, prevBuffer, curBuffer, beklenen].
 */
const CLAUDE_BOX = (line) =>
  '\x1b[2m╭──────────────────────────────────────╮\x1b[22m\r\n' +
  `\x1b[2m│\x1b[22m ${line}${' '.repeat(Math.max(0, 34 - line.length))}\x1b[2m│\x1b[22m\r\n` +
  '\x1b[2m╰──────────────────────────────────────╯\x1b[22m\r\n';

// ENG-01 — GERÇEK codex çerçevesi: aynı kutu, ama her yeniden çizimde DECSCUSR
// (`ESC [ 0 SP q` — ara baytlı) ve pencere başlığı OSC'si basılır. Ölçüm: 5 dakikalık
// gerçek codex oturumunda DECSCUSR 1085 kez (CODEX-01 §2.5). Ara-bayt sınıfı olmayan
// süzgeç bunları TAM YEMEZ; geriye `0 q` artığı kalır → satır ne PURE_BORDER'a ne de
// PROMPT_MARK'a uyar → boş composer "dolu" görünür (lider hiç uyandırılamaz).
const CODEX_BOX = (line) =>
  '\x1b]0;codex — crewpane\x07' + // pencere başlığı (OSC) — süzülmezse satır içine düşer
  '\x1b[0 q' + // DECSCUSR: imleç şekli (ara bayt = SP)
  '\x1b[2m╭──────────────────────────────────────╮\x1b[22m\r\n' +
  `\x1b[2m│\x1b[22m \x1b[0 q${line}${' '.repeat(Math.max(0, 34 - line.length))}\x1b[2m│\x1b[22m\r\n` +
  '\x1b[2m╰──────────────────────────────────────╯\x1b[22m\r\n\x1b[0 q';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * AXP-12 — GERÇEK claude 2.1.278 EKRAN KARELERİ (Haiku 4.5 · 119×55 pty · 19.09.2026)
 * ─────────────────────────────────────────────────────────────────────────────
 * Bare node-pty ile alındı (ürün kopyası değil; Eren'in canlı app'i açıktı). Bu
 * sürüm ALTERNATİF EKRANDA (`ESC[?1049h`) mutlak imleç adresiyle çizer: ham akışta
 * `\n` HİÇ YOK (1012 baytlık açılış karesinde 0 `\n`, 10 `\r`). `visibleRows` ham
 * akışı TEK satıra çökertir ("⏸ manual mode on · ? for shortcuts …") → düz-shell dalı
 * → 'menu' = #YHL8/#6QG5'in yanlış-pozitifi. Doğru girdi VT EKRANIDIR (main.js her
 * pane için `paneScreen` = xterm-headless koşturur; `liveLines().join('\n')` aşağıdaki
 * metinlerin kendisidir). Composer artık kutu (`│`) değil iki YATAY ÇİZGİ arasındadır.
 * Yol kısaltıldı (`/…/CrewPane`), gerisi birebir. Kaynak: docs/agent-results/AXP-12-ratchet.md §2.
 */
const RULE = '─'.repeat(119);
const CLAUDE_2127_SCREENS = Object.freeze({
  /** açılış sonrası boşta — eski kod: 'menu' (yanlış-pozitif) */
  idle: [
    ' ▐▛███▛█   Claude Code v2.1.278',
    '▝▜██████▀  Haiku 4.5 · Claude Max',
    '  ▝▝ ▝▝    /…/CrewPane',
    '                                                                                 auto mode unavailable for this model',
    RULE,
    '❯ ',
    RULE,
    '  ⏸ manual mode on · ? for shortcuts · ← for agents',
  ].join('\n'),
  /** metin yapıştırıldı (bracketed paste), Enter HENÜZ basılmadı */
  text: [
    ' ▐▛███▛█   Claude Code v2.1.278',
    '▝▜██████▀  Haiku 4.5 · Claude Max',
    '  ▝▝ ▝▝    /…/CrewPane',
    '                                                                                 auto mode unavailable for this model',
    RULE,
    "❯ Sadece tek kelime 'selam' yaz, başka hiçbir şey yazma ve araç kullanma.",
    RULE,
    '  ⏸ manual mode on',
  ].join('\n'),
  /** Enter +400 ms: tur koşuyor (ipucu satırında `esc to interrupt`) */
  running: [
    ' ▐▛███▛█   Claude Code v2.1.278',
    '▝▜██████▀  Haiku 4.5 · Claude Max',
    '  ▝▝ ▝▝    /…/CrewPane',
    "❯ Sadece tek kelime 'selam' yaz, başka hiçbir şey yazma ve araç kullanma.",
    '✽ Generating…',
    '                                                                                 auto mode unavailable for this model',
    RULE,
    '❯ ',
    RULE,
    '  ⏸ manual mode on · esc to interrupt · ← for agents',
  ].join('\n'),
  /** cevap geldi, boşta (#6QG5 15:07:32 hâli) — eski kod: 'menu' */
  answered: [
    ' ▐▛███▛█   Claude Code v2.1.278',
    '▝▜██████▀  Haiku 4.5 · Claude Max',
    '  ▝▝ ▝▝    /…/CrewPane',
    "❯ Sadece tek kelime 'selam' yaz, başka hiçbir şey yazma ve araç kullanma.",
    '⏺ selam',
    '✻ Sautéed for 1s · done 9:00 PM',
    "                                        You've used 86% of your weekly limit · resets Sep 25 at 6am (Europe/Istanbul)",
    RULE,
    '❯ ',
    RULE,
    '  ⏸ manual mode on · ? for shortcuts · ← for agents',
  ].join('\n'),
  /** uzun cevap ekranı doldurdu (1..70), boşta — eski kod: 'menu' */
  longIdle: [
    '  64', '  65', '  66', '  67', '  68', '  69', '  70',
    '✻ Worked for 2s · done 9:00 PM',
    RULE,
    '❯ ',
    RULE,
    '  ⏸ manual mode on · ? for shortcuts · ← for agents',
  ].join('\n'),
  /** GERÇEK izin menüsü (`permissions.ask` kuralıyla üretildi) — kutu YOK, tek çizgi */
  permission: [
    ' ▐▛███▛█   Claude Code v2.1.278',
    '▝▜██████▀  Haiku 4.5 · Claude Max',
    '  ▝▝ ▝▝    /…/CrewPane',
    '❯ Bash aracıyla şu komutu çalıştır: mkdir -p yeni && echo merhaba > yeni/a.txt && cat yeni/a.txt',
    '  Creating directory and file with content, then displaying file',
    '  ⎿  $ mkdir -p yeni && echo merhaba > yeni/a.txt && cat yeni/a.txt',
    RULE,
    ' Bash command',
    '   mkdir -p yeni && echo merhaba > yeni/a.txt && cat yeni/a.txt',
    '   Create directory and file with content, then display file',
    ' Permission rule Bash(mkdir *) requires confirmation for this command.',
    ' /permissions to update rules',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
    ' Esc to cancel · Tab to amend',
  ].join('\n'),
});

/**
 * AXP-12 — TAM HÜKÜM tablosu: [ad, buffer, opts, beklenen composerScan]. IDLE_FIXTURES
 * yalnız boolean'a iner ('text' ile 'menu' aynı "busy"), oysa Enter tekrarının güvenliği
 * tam da o ayrımdadır. Renderer ikizi de bu tabloyu koşar (delegationFollow.test.mts).
 */
const SCAN_FIXTURES = Object.freeze([
  ['claude 2.1.278: boşta', CLAUDE_2127_SCREENS.idle, undefined, 'empty'],
  ['claude 2.1.278: metin yazıldı, Enter yok', CLAUDE_2127_SCREENS.text, undefined, 'text'],
  ['claude 2.1.278: tur koşuyor', CLAUDE_2127_SCREENS.running, undefined, 'running'],
  ['claude 2.1.278: tur koşuyor, composer kendisi', CLAUDE_2127_SCREENS.running, { ignoreRunning: true }, 'empty'],
  ['claude 2.1.278: cevap sonrası boşta', CLAUDE_2127_SCREENS.answered, undefined, 'empty'],
  ['claude 2.1.278: uzun cevap ekranda, boşta', CLAUDE_2127_SCREENS.longIdle, undefined, 'empty'],
  ['claude 2.1.278: GERÇEK izin menüsü', CLAUDE_2127_SCREENS.permission, undefined, 'menu'],
  ['claude 2.1.278: izin menüsü (ignoreRunning)', CLAUDE_2127_SCREENS.permission, { ignoreRunning: true }, 'menu'],
  ['menü imleci kutu içinde (limit sorusu) → text DEĞİL menu',
    '╭────────────────────────────╮\r\n│ What would you like to do? │\r\n│ ❯ 1. Stop and wait         │\r\n╰────────────────────────────╯\r\n', undefined, 'menu'],
  ['menü imleci kutusuz (güven diyaloğu) → menu', 'Do you trust the files in this folder?\r\n❯ 1. Yes, proceed\r\n  2. No, exit\r\n', undefined, 'menu'],
  ['ADP-667 kutu: boş composer', CLAUDE_BOX('>'), undefined, 'empty'],
  ['ADP-667 kutu: yarım prompt', CLAUDE_BOX('> ADP-667 görevini ver'), undefined, 'text'],
  ['ADP-667 kutu: sütun-0 echo', `${CLAUDE_BOX('>')}  ? for shortcuts\r\nYARIM-PROMPT-667`, undefined, 'menu'],
  ['düz shell: çıplak prompt', 'user@mac ~ % ', undefined, 'empty'],
  ['düz shell: yarım komut (text HİÇ dönmez)', 'user@mac ~ % git st', undefined, 'menu'],
  ['boş', '', undefined, 'unknown'],
]);

const IDLE_FIXTURES = Object.freeze([
  ['boş buffer', '', '', false],
  ['stabil çıplak shell prompt', 'user@mac ~ % ', 'user@mac ~ % ', true],
  ['değişen buffer (render/tuşlama)', 'user@mac ~ % ', 'user@mac ~ % l', false],
  ['yarım yazılmış prompt', 'user@mac ~ % git st', 'user@mac ~ % git st', false],
  ['claude boş composer', '> ', '> ', true],
  ['claude boş composer + kutu', '> │', '> │', true],
  ['claude composer dolu', '> merhaba', '> merhaba', false],
  ['CR overwrite → çıplak prompt', 'çalışıyor…\r% ', 'çalışıyor…\r% ', true],
  ['CR overwrite → dolu satır', 'x\r% deneme', 'x\r% deneme', false],
  ['backspace ile temizlenmiş', '% ab\b\b', '% ab\b\b', true],
  ['ANSI renkli çıplak prompt', '\x1b[32m%\x1b[39m ', '\x1b[32m%\x1b[39m ', true],
  ['spinner satırı (meşgul)', '✳ Boogieing… thinking', '✳ Boogieing… thinking', false],
  // ADP-659 — gerçek dünyadaki sembol prompt'ları (sigil listesi kapalı küme olamaz)
  ['sembol prompt ∙ (Starship/p10k)', '\x1b[90m∙\x1b[0m ', '\x1b[90m∙\x1b[0m ', true],
  ['sembol prompt ➜ (oh-my-zsh)', '➜  ', '➜  ', true],
  ['sembol prompt + yarım komut', '∙ git comm', '∙ git comm', false],
  ['sembol prompt + tek harf', '∙ l', '∙ l', false],
  // ── ADP-667 — GERÇEK claude/codex TUI çerçeveleri (kutulu composer) ──────────
  // Kök neden fixture'ı: alt kenar görünür SON satır; ADP-659 kuralı bunu ÇIPLAK
  // PROMPT sanıp yarım prompt'un üstüne yazıyordu.
  ['TUI: kutu içinde YARIM prompt (alt kenar son satır)', CLAUDE_BOX('> ADP-667 görevini ver'), CLAUDE_BOX('> ADP-667 görevini ver'), false],
  ['TUI: kutu içinde BOŞ composer', CLAUDE_BOX('>'), CLAUDE_BOX('>'), true],
  [
    'TUI: BOŞ composer + ipucu satırı (eskiden sonsuza dek "meşgul")',
    `${CLAUDE_BOX('>')}  ? for shortcuts\r\n`,
    `${CLAUDE_BOX('>')}  ? for shortcuts\r\n`,
    true,
  ],
  [
    'TUI: YARIM prompt + ipucu satırı',
    `${CLAUDE_BOX('> git log yaz')}  ? for shortcuts\r\n`,
    `${CLAUDE_BOX('> git log yaz')}  ? for shortcuts\r\n`,
    false,
  ],
  [
    'TUI: motor KOŞUYOR (esc to interrupt) → boş composer olsa da ertele',
    `${CLAUDE_BOX('>')}  ✳ Working… (esc to interrupt)\r\n`,
    `${CLAUDE_BOX('>')}  ✳ Working… (esc to interrupt)\r\n`,
    false,
  ],
  [
    'TUI: AÇIK MENÜ (limit sorusu) → asla yazma',
    '╭────────────────────────────╮\r\n│ What would you like to do? │\r\n│ ❯ 1. Stop and wait         │\r\n╰────────────────────────────╯\r\n',
    '╭────────────────────────────╮\r\n│ What would you like to do? │\r\n│ ❯ 1. Stop and wait         │\r\n╰────────────────────────────╯\r\n',
    false,
  ],
  [
    'TUI: çok satırlı composer içeriği (2. satırda metin)',
    '╭──────────────╮\r\n│ > satır bir  │\r\n│   satır iki  │\r\n╰──────────────╯\r\n',
    '╭──────────────╮\r\n│ > satır bir  │\r\n│   satır iki  │\r\n╰──────────────╯\r\n',
    false,
  ],
  [
    'TUI: kutu var ama composer okunamadı → BİLİNMİYOR = ertele',
    '╭──────────────╮\r\n╰──────────────╯\r\n',
    '╭──────────────╮\r\n╰──────────────╯\r\n',
    false,
  ],
  // ADP-667 (2. tur, gerçek e2e'de ölçüldü): pane CANONICAL modda ise kullanıcının
  // yazdığı satır ÇEKİRDEKTE bekler, TUI'ye hiç ulaşmaz → kutu BOŞ görünür ama
  // terminal echo'su kutunun ALTINDA sütun 0'da durur. İpucu sanılırsa mesaj tam da
  // yarım prompt'un üstüne düşer (Eren'in şikâyeti).
  [
    'TUI: kutu boş ama ALTINDA sütun-0 echo (kullanıcı yazıyor) → ertele',
    `${CLAUDE_BOX('>')}  ? for shortcuts\r\nYARIM-PROMPT-667`,
    `${CLAUDE_BOX('>')}  ? for shortcuts\r\nYARIM-PROMPT-667`,
    false,
  ],
  [
    'TUI: kutu boş + GİRİNTİLİ bilinmeyen durum satırı → yazılabilir',
    `${CLAUDE_BOX('>')}  ⏵⏵ bypass permissions on\r\n`,
    `${CLAUDE_BOX('>')}  ⏵⏵ bypass permissions on\r\n`,
    true,
  ],
  [
    'shell: son satır ÇIKTI (komut koşuyor) → yazma',
    'user@mac ~ % npm test\r\nRunning 42 tests…',
    'user@mac ~ % npm test\r\nRunning 42 tests…',
    false,
  ],
  // ── ENG-01 — codex TUI: ara-baytlı DECSCUSR + OSC başlık ────────────────────
  // Fix'ten ÖNCE: `0 q` artığı composer satırına yapışır → BOŞ kutu "dolu" okunur
  // (lider uyandırılamaz), YARIM prompt ise artık yüzünden yine false verir (doğru
  // cevap ama YANLIŞ sebeple). Fix sonrası ikisi de claude ile AYNI cevabı verir.
  ['codex: kutu içinde BOŞ composer (DECSCUSR + OSC)', CODEX_BOX('>'), CODEX_BOX('>'), true],
  [
    'codex: kutu içinde YARIM prompt (DECSCUSR + OSC)',
    CODEX_BOX('> ENG-01 görevini ver'),
    CODEX_BOX('> ENG-01 görevini ver'),
    false,
  ],
  [
    'codex: BOŞ composer + ipucu satırı (DECSCUSR redraw)',
    `${CODEX_BOX('>')}  ? for shortcuts\r\n\x1b[0 q`,
    `${CODEX_BOX('>')}  ? for shortcuts\r\n\x1b[0 q`,
    true,
  ],
  [
    'codex: motor KOŞUYOR (esc to interrupt) → boş composer olsa da ertele',
    `${CODEX_BOX('>')}  ⠹ Working… (esc to interrupt)\r\n\x1b[0 q`,
    `${CODEX_BOX('>')}  ⠹ Working… (esc to interrupt)\r\n\x1b[0 q`,
    false,
  ],
  [
    'codex: OSC pencere başlığı satır içine SIZMAMALI (boş prompt boş kalsın)',
    '\x1b]0;> crewpane — codex\x07% ',
    '\x1b]0;> crewpane — codex\x07% ',
    true,
  ],
  [
    'codex: OSC başlığı + YARIM prompt → yine ertele (yanlış-pozitif yok)',
    '\x1b]0;codex — crewpane\x07% git st',
    '\x1b]0;codex — crewpane\x07% git st',
    false,
  ],
  // ── AXP-12 — GERÇEK claude 2.1.278 ekran metni (VT satırları; iki çizgi arası composer) ──
  ['claude 2.1.278: boş composer (eskiden "menu" → lider hiç uyanmazdı)', CLAUDE_2127_SCREENS.idle, CLAUDE_2127_SCREENS.idle, true],
  ['claude 2.1.278: metin yazılmış', CLAUDE_2127_SCREENS.text, CLAUDE_2127_SCREENS.text, false],
  ['claude 2.1.278: tur koşuyor → ertele', CLAUDE_2127_SCREENS.running, CLAUDE_2127_SCREENS.running, false],
  ['claude 2.1.278: cevap sonrası boş', CLAUDE_2127_SCREENS.answered, CLAUDE_2127_SCREENS.answered, true],
  ['claude 2.1.278: uzun cevap ekranda, boş', CLAUDE_2127_SCREENS.longIdle, CLAUDE_2127_SCREENS.longIdle, true],
  ['claude 2.1.278: GERÇEK izin menüsü → asla yazma', CLAUDE_2127_SCREENS.permission, CLAUDE_2127_SCREENS.permission, false],
]);

/**
 * ADP-692 — İNSAN VARLIĞI tablosu. Her giriş: [ad, opts, beklenen reason].
 * `now` her fixture'da 100_000 kabul edilir (mutlak saat testte anlamsız).
 */
const PRESENCE_FIXTURES = Object.freeze([
  ['hiç tuş basılmadı (otopilot)', { lastInputAt: 0, lastSubmitAt: 0 }, 'none'],
  ['tuşlar GÖNDERİLDİ + sessizlik geçti', { lastInputAt: 50_000, lastSubmitAt: 50_000 }, 'none'],
  ['son ENTER sonrası TUŞ VAR (yazıyor)', { lastInputAt: 60_000, lastSubmitAt: 50_000 }, 'draft'],
  ['tam ŞU AN yazmaya başladı (echo YOK)', { lastInputAt: 99_950, lastSubmitAt: 50_000 }, 'draft'],
  ['gönderdi ama tuş çok taze', { lastInputAt: 99_500, lastSubmitAt: 99_500 }, 'quiet'],
  ['taslak ama SÜRESİ DOLDU (kilit kalkar)', { lastInputAt: 100_000 - 11 * 60_000, lastSubmitAt: 0 }, 'none'],
  ['submit damgası YOK ama tuş var (bilinmiyor → taslak say)', { lastInputAt: 60_000, lastSubmitAt: 0 }, 'draft'],
]);

module.exports = {
  leaderComposerIdle,
  leaderWakeSafe,
  humanPresence,
  injectionGate,
  composerState,
  composerScan,
  composerDiag,
  visibleRows,
  DEFAULT_INPUT_QUIET_MS,
  DEFAULT_DRAFT_GRACE_MS,
  IDLE_FIXTURES,
  SCAN_FIXTURES,
  CLAUDE_2127_SCREENS,
  PRESENCE_FIXTURES,
};
