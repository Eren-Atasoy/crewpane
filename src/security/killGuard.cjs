#!/usr/bin/env node
// CrewPane — KILL-GUARD-01: "patronun uygulamasını kapatma" TALİMATININ yerine KAPI.
//
// ── NEDEN VAR ────────────────────────────────────────────────────────────────
// 2026-09-08 gecesi bir worker, kartında AÇIKÇA "Eren'in çalışan uygulamasını
// KAPATMA" yazmasına rağmen iki kez `killall CrewPane` çalıştırdı:
//   20:30:30.581Z  killall CrewPane 2>/dev/null || true
//   20:33:10.023Z  killall CrewPane "CrewPane Dev" …
// Uygulama DÜZENLİ kapandı (çökme değil: `quit: screen tail persisted`,
// `live-pane registry snapshot written (12 pane)`, ana süreç için `.ips` YOK) ve
// aynı anda koşan ÜÇ worker pane'iyle birlikte öldü; üçünün de işi sıfırlandı.
//
// Ders (aynı sınıf iki ay önce de ölçülmüştü — hafıza `ref_e2e_neighbor_pkill_kills_
// your_electron`): prompt'a yazılan yasak bir KAPI DEĞİLDİR. Bu modül o kapının
// KARAR çekirdeğidir: saf, I/O'suz, senkron — hem claude'un PreToolUse hook'u hem de
// PATH'e konan `killall`/`pkill` sarmalayıcıları AYNI cevabı buradan alır (iki
// uygulayıcı, tek gerçek; desen listesi ikiye ayrılırsa kapı yalancı olur).
//
// ── KAPININ SINIRI (dürüstçe) ────────────────────────────────────────────────
// Bu bir GÜVENLİK duvarı değil, KAZA duvarıdır. Kararlı bir düşman `/bin/kill`i
// doğrudan çağırıp bunu aşar. Hedef kitle "yanlışlıkla komşusunu öldüren ajan";
// ölçülen arıza tam olarak buydu.

'use strict';

/**
 * Korunan SÜREÇ ADLARI. Bir izole kopya da "CrewPane"/"Electron" adını taşır —
 * bu yüzden AD-TABANLI öldürme (killall / pkill'in -f'siz hâli) HİÇBİR ZAMAN
 * "yalnız benim kopyam" anlamına gelemez ve koşulsuz reddedilir (R1).
 */
const PROTECTED_NAMES = Object.freeze(['crewpane', 'crewpane', 'electron']);

/**
 * KURULU örneğin adresi. Bu dize geçen hiçbir öldürme komutu izin markörüyle bile
 * kurtulamaz: `/Applications/CrewPane.app` tanım gereği patronun uygulamasıdır.
 */
const INSTALLED_PATH_MARKERS = Object.freeze([
  '/applications/',            // macOS — `/Applications/CrewPane.app`
  // WIN-PARITY-01 — Windows kurulum hedefleri ÖLÇÜLDÜ (electron-builder nsis
  // `perMachine:false` → per-user): `%LOCALAPPDATA%\\Programs\\CrewPane`.
  // Makine geneli kurulum (`perMachine:true` / elle) `Program Files` altına iner.
  // Karşılaştırma ters-bölüleri düzleştirilmiş metin üzerinde yapılır (normPath).
  '/appdata/local/programs/',
  '/program files',            // "program files" + "program files (x86)"
]);

/**
 * İZOLE KOPYA MARKÖRLERİ — `pkill -f <desen>` deseninde bunlardan biri geçiyorsa
 * hedef, worker'ın KENDİ doğurduğu ayrık örnektir ve komut GEÇER.
 *
 * Liste repodaki GERÇEK meşru kullanımlardan türetildi (uydurma değil):
 *   e2e/office-click-wander.spec.cjs:286  pkill -f 'crewpane-e2e-udd'
 *   e2e/env-04-login.spec.cjs:401         pkill -f <userDataDir>
 *   scripts/lx-login-lab/probe.sh:326     pkill -KILL -f crewpane   ← Linux laboratuvarı
 * Üçüncüsü markörsüzdür ve bu kapının altında REDDEDİLİR; o betikler pane'de değil
 * elle koşuyor (kapı yalnız ajan pane'lerine kurulur), ama not düşülür.
 */
const ISOLATION_MARKERS = Object.freeze([
  'crewpane_e2e',
  'crewpane_e2e',
  '--user-data-dir',
  'user-data-dir',
  'e2e-udd',
  '/e2e/',
  'e2e',
  'worktree',
  '/tmp/',
  '/private/tmp/',
  '/var/folders/', // macOS os.tmpdir()
  // WIN-PARITY-01 — Windows `os.tmpdir()` = `%LOCALAPPDATA%\\Temp`; POSIX'teki
  // `/tmp/` markörünün dengi. Bu satır olmadan Windows'ta MEŞRU e2e temizliği
  // (ayrı user-data-dir bir tmp yolundadır) kapıya takılırdı — yanlış pozitif
  // bir kapıyı kapattırır ve arıza geri gelir.
  '/appdata/local/temp/',
  '/windows/temp/',
  'instance=test',
  'crewpane-dev-copy',
]);

/** POSIX öldürme fiilleri (yol ön eki soyulduktan sonraki ÇIPLAK ad). */
const KILL_VERBS = Object.freeze(['kill', 'killall', 'pkill', 'skill']);

/**
 * WINDOWS öldürme fiilleri — WIN-PARITY-01'de ÖLÇÜLEREK çıkarıldı (kod okumasıyla
 * değil: her biri `where.exe` / `Get-Command` ile Windows CI'da aranır ve ölçüm
 * `scripts/xplat/platformRiskProbe.cjs`e yazılır).
 *
 *   taskkill      — System32\taskkill.exe. `/IM <ad>` ad-tabanlı, `/PID <n>` pid,
 *                   `/T` ağacı, `/F` zorla. Windows'un `killall`ıdır.
 *   tskill        — eski oturum-tabanlı öldürücü (Windows Server/eski sürümler).
 *   stop-process  — PowerShell CMDLET'i. `-Name` / `-Id` / boru hattı.
 *   kill, spps    — `Stop-Process`in PowerShell TAKMA ADLARI. `kill` zaten
 *                   KILL_VERBS'te; ama POSIX `kill` yalnız pid alır, PowerShell'de
 *                   AD alır → `kill` fiilinin AD dalı da kapatılmak zorunda.
 *   wmic … delete — WMI üzerinden süreç sonlandırma; ayrı ele alınır (fiil tek
 *                   başına yıkıcı değil, `delete`/`terminate` fiiliyle yıkıcı).
 *
 * ⚠️ SINIR (dürüstçe): `Stop-Process`/`kill`/`spps` PowerShell'in KENDİ komutlarıdır;
 * PATH'e konan sarmalayıcı (KAPI 2) onları GÖREMEZ — cmdlet çözümü PATH'ten ÖNCE
 * gelir. Onları yalnız KAPI 1 (araç-öncesi kanca) yakalar. `taskkill`/`wmic`/`tskill`
 * gerçek `.exe`lerdir ve HER İKİ kapı da yakalar. Bu asimetri beyanlıdır.
 */
const WIN_KILL_VERBS = Object.freeze(['taskkill', 'tskill', 'stop-process', 'spps']);

/** İki sözlüğün birleşimi — R6 (boru hattı) ve sondalar bunu okur. */
const ALL_KILL_VERBS = Object.freeze([...new Set([...KILL_VERBS, ...WIN_KILL_VERBS])]);

/** Boru hattında öldürme NİYETİNİ ele veren fiiller (segmentin başında OLMAYAN). */
const PIPELINE_KILL_RE = /\b(kill|killall|pkill|taskkill|tskill|stop-process|spps)\b|invoke-cimmethod/;

/** Komutun başındaki anlamsız sarmalayıcılar (`sudo -n env A=B command exec …`). */
const WRAPPER_WORDS = Object.freeze(['sudo', 'doas', 'command', 'exec', 'nohup', 'time', 'builtin']);

const RULES = Object.freeze({
  NAME_KILL: 'R1-ad-tabanli-oldurme',
  PATTERN_KILL: 'R2-desen-tabanli-oldurme',
  QUIT_APP: 'R3-osascript-quit-app',
  HOST_PID: 'R4-uygulama-pid',
  NUKE: 'R5-toplu-oldurme',
  PIPELINE: 'R6-boru-hatti',
  WIN_KILL: 'R7-windows-oldurme',
  LAUNCH: 'R8-canli-app-varken-acilis',
});

/** Worker'a "ne yapması gerektiğini" söyleyen TEK reçete (kapı kilitlemez, yol gösterir). */
const RECIPE =
  'Karşılaştırma/temizlik gerekiyorsa İZOLE kopya kullan: ayrı `--user-data-dir`, ayrı worktree, ' +
  '`CREWPANE_E2E=1` ile kendi doğurduğun süreç — ve yalnız KENDİ pid\'ini öldür ' +
  '(`kill <spawn ettiğin pid>`) ya da `pkill -f <o kopyaya özgü yol/dizin>` kullan. ' +
  'Kurulu uygulamanın kapanması gerekiyorsa Eren\'e sor; sen kapatma.';

function lower(s) {
  return String(s == null ? '' : s).toLowerCase();
}

/**
 * Kabuk satırını BAĞIMSIZ parçalara böl. Amaç ayrıştırmak değil, YALITMAK: bir
 * segmentin markörü komşu segmentin yasağını affetmesin (`echo /tmp/x && killall
 * CrewPane` gibi ucuz bir kaçış yolunu kapatır).
 *
 * `|` bilerek AYIRICI DEĞİL: `pgrep -f CrewPane | xargs kill` tek bir niyettir ve
 * R6 onu bütün olarak görmek zorundadır.
 */
function segments(command) {
  return String(command == null ? '' : command)
    .split(/(?:&&|\|\||;|\n|\r)+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Bir segmentteki ilk gerçek komut adı (sarmalayıcılar + `A=B` atamaları soyulur). */
function commandWords(segment) {
  const words = segment.split(/\s+/).filter(Boolean);
  const out = [];
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i++; continue; } // env ataması
    if (WRAPPER_WORDS.includes(lower(w))) { i++; continue; }
    if (lower(w) === '-n' || lower(w) === '--') { i++; continue; }
    out.push(...words.slice(i));
    break;
  }
  return out;
}

/** `/usr/bin/killall` → `killall` · tırnak/backtick artıkları temizlenir. */
function bareName(word) {
  const w = String(word || '').replace(/^["'`(]+|["'`)]+$/g, '');
  const base = w.split(/[\\/]/).pop() || w;
  return lower(base);
}

function hasProtectedName(text) {
  const t = lower(text);
  return PROTECTED_NAMES.some((n) => t.includes(n));
}

/**
 * YOL KARŞILAŞTIRMASI İÇİN düzleştirme: ters-bölü → bölü. Windows yolları
 * (`C:\\Program Files\\CrewPane`) POSIX markörleriyle AYNI sözlükten sorulabilsin
 * diye. İki ayrı markör listesi tutmak, listelerin ıraksamasıyla kapıyı yalancı
 * yapardı (killGuard'ın kuruluş ilkesi: iki uygulayıcı, TEK desen listesi).
 */
function normPath(text) {
  return lower(text).replace(/\\/g, '/');
}

function hasInstalledPath(text) {
  const t = normPath(text);
  return INSTALLED_PATH_MARKERS.some((m) => t.includes(m));
}

function hasIsolationMarker(text) {
  const t = normPath(text);
  return ISOLATION_MARKERS.some((m) => t.includes(m));
}

/**
 * Segmentteki çıplak sayıları (olası pid'ler) topla — `-9`, `-TERM` gibi bayraklar
 * hariç. WIN-PARITY-01: Windows biçimleri de aynı sepete girer —
 * `taskkill /PID 1234`, `Stop-Process -Id 1234`, `Stop-Process -Id 12,34`
 * (virgüllü liste PowerShell'de GEÇERLİ bir dizi yazımıdır).
 */
function pidsIn(segment) {
  const out = [];
  for (const w of segment.split(/[\s,]+/)) {
    const clean = w.replace(/^["'`]+|["'`,;]+$/g, '');
    if (/^\d{1,7}$/.test(clean)) out.push(Number(clean));
  }
  return out;
}

function deny(rule, reason) {
  return { allowed: false, rule, reason, hint: RECIPE };
}

const ALLOW = Object.freeze({ allowed: true, rule: null, reason: null, hint: null });

/**
 * TEK KARAR NOKTASI.
 *
 * @param {string} command  Çalıştırılmak istenen kabuk satırı (ham).
 * @param {object} [ctx]
 * @param {number|string} [ctx.hostPid]   Uygulamanın ana süreç pid'i (CREWPANE_HOST_PID).
 * @param {Array<number|string>} [ctx.panePids] Kardeş pane pid'leri (varsa).
 * @returns {{allowed:boolean, rule:string|null, reason:string|null, hint:string|null}}
 */
function inspectCommand(command, ctx = {}) {
  const raw = String(command == null ? '' : command);
  if (!raw.trim()) return ALLOW;

  const hostPid = Number(ctx.hostPid) > 0 ? Number(ctx.hostPid) : null;
  const panePids = new Set(
    (Array.isArray(ctx.panePids) ? ctx.panePids : [])
      .map((p) => Number(p))
      .filter((p) => Number.isInteger(p) && p > 0),
  );

  // ── R8 — LAUNCH-GUARD-01: canlı app varken açılış/e2e koşumu (öldürme fiili
  // gerektirmez; ölçülen arıza AÇILIŞIN KENDİSİYDİ). Öldürme kurallarından ÖNCE.
  const launch = inspectLaunch(raw, ctx);
  if (!launch.allowed) return launch;

  const segs = segments(raw);
  for (const seg of segs) {
    const words = commandWords(seg);
    if (!words.length) continue;
    const verb = bareName(words[0]);
    const rest = words.slice(1).join(' ');
    // WIN-PARITY-01 — `wmic` TEK BAŞINA yıkıcı değil: yıkım `wmic process where … delete`
    // (ya da `call terminate`) biçimindedir. Fiili değil NİYETİ ölçüyoruz.
    const isWmicKill = verb === 'wmic' && /\b(delete|terminate)\b/.test(lower(rest));
    const isWinVerb = WIN_KILL_VERBS.includes(verb) || isWmicKill;

    // ── R3 — osascript ile "quit app" ──────────────────────────────────────
    if (verb === 'osascript' && /quit\s+app/i.test(seg) && hasProtectedName(seg)) {
      return deny(
        RULES.QUIT_APP,
        'AppleScript ile korunan bir uygulamaya `quit` gönderiliyor. Bu, uygulamayı ' +
          'DÜZENLİ kapatır (çökme izi bırakmaz) — 08.09 gecesindeki arızanın ta kendisi.',
      );
    }

    if (!KILL_VERBS.includes(verb) && !isWinVerb) {
      // ── R6 — BORU HATTI: `pgrep -f CrewPane | xargs kill -9` ya da Windows
      // dengi `Get-Process CrewPane | Stop-Process -Force` gibi, öldürme fiili
      // segmentin BAŞINDA olmayan biçimler. Segmentin tamamına bakılır.
      if (PIPELINE_KILL_RE.test(lower(seg)) && (hasProtectedName(seg) || hasInstalledPath(seg))) {
        if (hasInstalledPath(seg) || !hasIsolationMarker(seg)) {
          return deny(
            RULES.PIPELINE,
            'Komut, korunan bir uygulama adını bir öldürme komutuna BESLİYOR ' +
              '(boru hattı/`xargs` biçimi). Hedefin izole bir kopya olduğunu gösteren ' +
              'hiçbir işaret yok.',
          );
        }
      }
      continue;
    }

    // ── R7 — WINDOWS ÖLDÜRME FİİLLERİ ───────────────────────────────────────
    // WIN-PARITY-01: 08.09'un `killall CrewPane`i Windows'ta `taskkill /IM
    // CrewPane.exe /F` olarak yazılır ve 09.09 ölçümünde BEŞ yazılışın BEŞİ DE
    // kapıdan geçiyordu (XPLAT-01 §2 satır 6: "0/5"). Müşteri cihan Windows'ta.
    // Sıra POSIX dalıyla AYNI mantığı izler: joker → pid → kurulu yol → ad.
    if (isWinVerb) {
      // R5 dengi — joker hedef: `taskkill /F /IM *` ya da `Stop-Process -Name *`
      // makinedeki HER süreci (uygulamayı ve kardeş pane'leri) kapsar.
      if (rest.includes('*')) {
        return deny(
          RULES.NUKE,
          'Joker (`*`) hedefli bir Windows süreç sonlandırma. Bu, uygulamayı ve ' +
            'kardeş pane\'leri de kapsar — "yalnız benim kopyam" anlamına gelemez.',
        );
      }
      // R4 dengi — PID HATTI. `taskkill /PID <n>` ve `Stop-Process -Id <n>` ad
      // desenini tümüyle atlar; ikinci hat (CREWPANE_HOST_PID) Windows'ta da
      // ısırmak zorundadır (kartın 1. maddesi bunu AÇIKÇA istiyor).
      for (const p of pidsIn(rest)) {
        if (hostPid && p === hostPid) {
          return deny(
            RULES.HOST_PID,
            `pid ${p} CrewPane'in ANA SÜRECİDİR (CREWPANE_HOST_PID). Onu öldürmek ` +
              'senin pane\'in dahil bütün ofisi kapatır.',
          );
        }
        if (panePids.has(p)) {
          return deny(RULES.HOST_PID, `pid ${p} bir KARDEŞ pane'e ait; başka bir ajanın işini keser.`);
        }
      }
      if (hasInstalledPath(seg)) {
        return deny(
          RULES.WIN_KILL,
          'Komut doğrudan KURULU uygulamanın yolunu (`%LOCALAPPDATA%\\Programs\\…` / ' +
            '`Program Files`) hedefliyor. Kurulu örnek her zaman patronun oturumudur.',
        );
      }
      if (!hasProtectedName(rest)) continue; // başka bir süreci öldürüyor — bizi ilgilendirmez
      if (!hasIsolationMarker(rest)) {
        return deny(
          RULES.WIN_KILL,
          'Windows süreç sonlandırma komutu korunan bir uygulama adını hedefliyor ' +
            '(`taskkill /IM` · `Stop-Process -Name` · `wmic process … delete`) ve hedefin ' +
            'İZOLE bir kopya olduğunu gösteren hiçbir işaret yok. Bu komut, ad-tabanlı ' +
            'olduğu için patronun uygulamasına da uyar — `killall`ın Windows\'taki ta kendisi.',
        );
      }
      continue; // izole kopya temizliği — GEÇER
    }

    // ── R5 — toplu imha: hedefsiz kullanıcı/`-1` süpürmesi ──────────────────
    if ((verb === 'pkill' || verb === 'killall') && /(^|\s)-u(\s|$)/.test(` ${rest} `) && !hasIsolationMarker(seg)) {
      return deny(
        RULES.NUKE,
        'Kullanıcının TÜM süreçlerini hedefleyen bir süpürme (`-u`). Bu, uygulamayı ve ' +
          'kardeş pane\'leri de kapsar.',
      );
    }
    // `kill … -1` — hedef "-1" oturumdaki HER süreç demektir (bir sinyal adı DEĞİL:
    // `-9 -1`de `-9` sinyal, `-1` hedeftir). Token olarak aranır: `kill -9 -1` gibi
    // araya sinyal giren yazılışı bir regex penceresi kaçırırdı.
    if (verb === 'kill' && words.slice(1).some((w) => w.replace(/^["']|["']$/g, '') === '-1')) {
      return deny(RULES.NUKE, 'Bu komut oturumdaki HER süreci öldürür (`kill -1`).');
    }

    // ── R4 — PID HATTI (ad-tabanlı desenden BAĞIMSIZ ikinci savunma) ─────────
    // `CREWPANE_HOST_PID` uygulama tarafından pane env'ine yazılır: worker
    // uygulamayı adıyla değil, pid'iyle hedeflese bile kapı ısırır.
    if (verb === 'kill') {
      const pids = pidsIn(rest);
      for (const p of pids) {
        if (hostPid && p === hostPid) {
          return deny(
            RULES.HOST_PID,
            `pid ${p} CrewPane'in ANA SÜRECİDİR (CREWPANE_HOST_PID). Onu öldürmek ` +
              'senin pane\'in dahil bütün ofisi kapatır.',
          );
        }
        if (panePids.has(p)) {
          return deny(RULES.HOST_PID, `pid ${p} bir KARDEŞ pane'e ait; başka bir ajanın işini keser.`);
        }
      }
      // WIN-PARITY-01 — `kill` PowerShell'de `Stop-Process`in TAKMA ADIDIR ve orada
      // pid değil AD alır (`kill -Name CrewPane`). POSIX'te de aynı satır bir
      // kaçış yoludur: `kill $(pgrep CrewPane)` ad desenini komut ikamesiyle
      // gizler. İki durumu tek kural kapatır — hedefin izole olduğunu gösteren bir
      // işaret yoksa korunan AD geçen bir `kill` reddedilir.
      if (hasInstalledPath(rest)) {
        return deny(RULES.WIN_KILL, 'Komut KURULU uygulamanın yolunu hedefliyor; kurulu örnek patronundur.');
      }
      if (hasProtectedName(rest) && !hasIsolationMarker(rest)) {
        return deny(
          RULES.WIN_KILL,
          '`kill` korunan bir uygulama ADINI taşıyor. PowerShell\'de `kill` = ' +
            '`Stop-Process` (ad alır); POSIX\'te ise ad ancak bir komut ikamesiyle ' +
            '(`kill $(pgrep …)`) buraya girer — ikisi de "yalnız benim kopyam" demek değil.',
        );
      }
      continue; // düz `kill <pid>` başka türlü serbesttir
    }

    // ── R2 — pkill -f <desen> ───────────────────────────────────────────────
    if (verb === 'pkill') {
      const byPattern = /(^|\s)-[a-zA-Z]*f/.test(` ${rest}`);
      if (!hasProtectedName(rest) && !hasInstalledPath(rest)) continue; // bizi ilgilendirmiyor
      if (hasInstalledPath(rest)) {
        return deny(
          RULES.PATTERN_KILL,
          'Desen doğrudan KURULU uygulamayı (`/Applications/…`) hedefliyor. Kurulu örnek ' +
            'her zaman patronun oturumudur.',
        );
      }
      if (!byPattern) {
        return deny(
          RULES.NAME_KILL,
          '`pkill` desen bayrağı (`-f`) olmadan AD ile eşleşir; izole kopya da aynı adı ' +
            'taşıdığı için bu komut patronun uygulamasını da öldürür.',
        );
      }
      if (!hasIsolationMarker(rest)) {
        return deny(
          RULES.PATTERN_KILL,
          'Desen korunan bir uygulama adı içeriyor ama hedefin İZOLE kopya olduğunu ' +
            'gösteren hiçbir işaret yok (ayrı user-data-dir / worktree / e2e / tmp yolu). ' +
            'Bu desen kurulu uygulamaya da uyar.',
        );
      }
      continue; // izole kopya temizliği — GEÇER
    }

    // ── R1 — killall (+ `skill`) : AD-TABANLI, kapsamlanamaz ────────────────
    if (verb === 'killall' || verb === 'skill') {
      if (!hasProtectedName(rest)) continue;
      return deny(
        RULES.NAME_KILL,
        '`killall` süreçleri ADIYLA öldürür ve izole bir kopya da aynı adı taşır — ' +
          'yani bu komut hiçbir zaman "yalnız benim kopyam" anlamına gelemez. 08.09 ' +
          'gecesinde tam bu komut patronun uygulamasını iki kez kapattı ve 3 worker\'ın ' +
          'işini sıfırladı.',
      );
    }
  }

  return ALLOW;
}

// ── LAUNCH-GUARD-01 — "CANLI APP VARKEN ÜRÜN KOPYASI/E2E AÇMA" (R8) ──────────
//
// ÖLÇÜLEN ARIZA (16.09 18:51:32, launchd kaydı — tahmin değil):
//   [gui/501/application.com.crewpane.crewpane… [23689]:] exited due to SIGTERM
//   | sent by Electron[81688], ran for 57826827ms
// 81688 = bir worker'ın İZOLE worktree'sinden koşan bare-run Electron
// (.crewpane-regress0246/electron/node_modules/electron/dist/…). Yani: izolasyon
// (ayrı worktree + ayrı CREWPANE_HOME + ayrı profil) Eren'in 16 saatlik
// oturumunu KORUMADI — kopya açılışta koşan bir süpürge canlı app'in SÜREÇ
// AĞACINI biçti (kök neden ayrıca kapatıldı: orphanElectron/mcpProcess).
//
// BURADAKİ KAPI O KÖK NEDENİN DEĞİL, SINIFIN kapısıdır: canlı app varken ikinci
// bir kopya/e2e koşumu açmanın ölçülmüş bedeli 68 dk + 16 saatlik oturum. İzin
// yalnız Eren'den gelir (CREWPANE_LIVE_OK=1).
//
// 🔴 İZOLASYON MARKÖRLERİ BU KURALI AFFETMEZ (R1/R2'den AYRILDIĞI yer): 18:51
// koşumu zaten izoleydi. "Ayrı user-data-dir kullanıyorum" bir muafiyet DEĞİL,
// arızanın ta kendisiydi.

/** Kurulu ürün ikilisinin ÇIPLAK adları (verb konumunda görülürse açılıştır). */
const APP_BINARY_NAMES = Object.freeze(['crewpane', 'crewpane.exe', 'crewpane dev']);

/** Bir koşum betiğini/ürünü ÇALIŞTIRAN yürütücüler (salt-okunur araçlar burada YOK). */
const RUNNER_VERBS = Object.freeze([
  'node', 'npx', 'npm', 'pnpm', 'yarn', 'bun', 'deno',
  'electron', 'playwright', 'bash', 'sh', 'zsh', 'python', 'python3',
]);

/**
 * E2E / DUMAN KOŞUMU işaretleri. Kart listesinin birebir karşılığı.
 * ⚠️ Yalnız bir YÜRÜTÜCÜ verb'ü ile birlikte aranır: `grep -rn playwright e2e/` ya da
 * `cat foo.spec.cjs` KAPIYA TAKILMAZ. (Bu kartı yazarken mevcut R6 kuralı bir `grep`i
 * reddetti — sürekli yanlış-pozitif veren kapı kapatılır, o yüzden verb şart.)
 */
const E2E_RUN_RE = /(^|[\s/"'])e2e[/\\]run\.cjs|[\w.-]+\.spec\.cjs(\s|$|["'])|\bplaywright\b|smoke_boot\.sh|\belectron\s+\.(\s|$)/;

/** `npm run e2e…` / `pnpm run test:e2e` / `yarn smoke…` biçimi (betik gövdesi görünmez). */
const PKG_SCRIPT_RE = /\brun\s+[\w:.-]*(e2e|smoke)[\w:.-]*/;

/** Verb'ün KENDİSİ bir koşum betiği mi (`./e2e/foo.spec.cjs`, `smoke_boot.sh`)? */
const RUNNER_FILE_RE = /\.spec\.cjs$|^smoke_boot\.sh$|^run\.cjs$/;

/**
 * Bir segment ÜRÜN KOPYASI AÇIYOR ya da E2E/DUMAN koşumu başlatıyor mu?
 * SAF: yalnız metne bakar, hiçbir şey ölçmez. Yoksa `null`.
 * @returns {{kind:string, what:string}|null}
 */
function launchIntent(seg) {
  const words = commandWords(seg);
  if (!words.length) return null;
  const first = String(words[0] || '').replace(/^["'`(]+|["'`)]+$/g, '');
  const verb = bareName(first);
  const rest = words.slice(1).join(' ');
  const restPath = normPath(rest);

  // (a) Kurulu/paketli ürün ikilisi DOĞRUDAN çalıştırılıyor.
  if (/\.app\/contents\/macos\/crewpane/.test(normPath(first)) || APP_BINARY_NAMES.includes(verb)) {
    return { kind: 'app-binary', what: 'ürün ikilisi doğrudan çalıştırılıyor' };
  }
  // (b) `open -a CrewPane` / `open …/CrewPane.app`
  if (verb === 'open' && (/(^|\s)-a(\s|$)/.test(` ${rest} `) || /\.app(\/|\s|$|["'])/.test(restPath)) && hasProtectedName(rest)) {
    return { kind: 'open-app', what: '`open` ile ürün açılıyor' };
  }
  // (c) `hdiutil attach …CrewPane…dmg` — DMG bağlamak kurulu kopyayla aynı
  //     bundle-id'li ikinci bir uygulamayı erişilebilir kılar (ENV-08 sınıfı).
  if (verb === 'hdiutil' && /\battach\b/.test(lower(rest)) && hasProtectedName(rest)) {
    return { kind: 'dmg-attach', what: 'CrewPane DMG\'si bağlanıyor' };
  }
  // (d) Verb'ün kendisi bir koşum betiği.
  if (RUNNER_FILE_RE.test(verb)) return { kind: 'e2e-run', what: `koşum betiği (${verb})` };
  // (e) Yürütücü + e2e/duman işareti.
  if (RUNNER_VERBS.includes(verb)) {
    if (verb === 'playwright' || verb === 'electron') return { kind: 'e2e-run', what: `\`${verb}\` çalıştırılıyor` };
    if (E2E_RUN_RE.test(seg)) return { kind: 'e2e-run', what: 'e2e/duman koşumu' };
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(verb) && PKG_SCRIPT_RE.test(lower(seg))) {
      return { kind: 'e2e-run', what: 'paket betiği (e2e/smoke)' };
    }
  }
  return null;
}

/** R8'in tek satırlık reçetesi — kapı yasak koymaz, İZİN YOLUNU gösterir. */
const LAUNCH_RECIPE =
  'Eren\'e sor; onay verirse `CREWPANE_LIVE_OK=1 <komut>` ile koş. ' +
  'Onay yoksa canlı app kapanana kadar bu adımı BEKLET, bloke OLMAYAN işe devam et.';

/**
 * R8 KARARI — SAF. Canlılık ÖLÇÜMÜ çağırana aittir (`ctx.installedAppAlive`),
 * bu modül I/O yapmaz; kontrol kolları böylece süreç açmadan koşar.
 *
 * @param {string} command
 * @param {{installedAppAlive?:boolean, allowLive?:boolean}} [ctx]
 */
function inspectLaunch(command, ctx = {}) {
  const raw = String(command == null ? '' : command);
  if (!raw.trim()) return ALLOW;
  if (ctx.allowLive) return ALLOW;          // CREWPANE_LIVE_OK=1 — açık insan onayı
  if (ctx.installedAppAlive !== true) return ALLOW; // canlı app yok → serbest
  for (const seg of segments(raw)) {
    const hit = launchIntent(seg);
    if (!hit) continue;
    return {
      allowed: false,
      rule: RULES.LAUNCH,
      reason:
        'Eren\'in CrewPane\'i açık; ürün kopyası/e2e/duman testi onu kapatabilir '
        + `(bu komut: ${hit.what}). 16.09 18:51'de izole bir worktree'den koşan e2e `
        + 'Electron\'u canlı app\'e SIGTERM gönderip 16 saatlik oturumu düşürdü — '
        + 'ayrı profil/worktree bu sınıfı ENGELLEMİYOR.',
      hint: LAUNCH_RECIPE,
    };
  }
  return ALLOW;
}

/**
 * CANLI APP ÖLÇÜMÜ — R8'in TEK impure fonksiyonu (karar çekirdeği saf KALIR).
 *
 * NEDEN `ps` YOK (bilinçli): kapı HER Bash çağrısında koşar; süreç listesi
 * çekmek hem pahalı hem de `platform/procProbe.cjs`i kancanın paket bağımlılık
 * zincirine sokardı (o dosya afterPack unpack nöbetinde DEĞİL → paketli kancada
 * sessiz `Cannot find module` = kapı YOK). Bunun yerine uygulamanın KENDİ yazdığı
 * iki kayıt okunur:
 *
 *   1. `CREWPANE_HOST_PID` — app, her pane'in env'ine kendi ana pid'ini yazar.
 *      Bu pane bir CrewPane oturumunun İÇİNDE koşuyorsa cevap burada biter.
 *   2. `~/.crewpane/bridge.json` — kurulu PROD örneğin köprü kaydı (`instance`,
 *      `pid`). DİKKAT: `os.homedir()` bilerek kullanılır, `CREWPANE_HOME` DEĞİL —
 *      soru "benim izole kopyam ayakta mı" değil, "EREN'IN app'i ayakta mı".
 *
 * `kill(pid, 0)` sinyal göndermez, yalnız varlığı sorar; EPERM = süreç VAR.
 * Ölçemezsek `false` döneriz (fail-open): kapının kendi arızası ajanı durdurmaz.
 *
 * @param {object} [deps] test enjeksiyonu: { env, alive, homedir, readFile }
 */
function installedAppAlive(deps = {}) {
  const env = deps.env || process.env;
  const alive = deps.alive || ((pid) => {
    try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; }
  });
  const hostPid = Number(env.CREWPANE_HOST_PID || 0);
  if (Number.isInteger(hostPid) && hostPid > 1 && alive(hostPid)) return true;

  try {
    const readFile = deps.readFile || ((f) => require('node:fs').readFileSync(f, 'utf8'));
    const homedir = deps.homedir || (() => require('node:os').homedir());
    const path = require('node:path');
    const rec = JSON.parse(readFile(path.join(homedir(), '.crewpane', 'bridge.json')));
    const pid = Number(rec && rec.pid);
    if (String(rec && rec.instance) === 'prod' && Number.isInteger(pid) && pid > 1 && alive(pid)) return true;
  } catch { /* kayıt yok/bozuk → ölçemedik */ }
  return false;
}

/** Komutta R8'i ilgilendiren bir AÇILIŞ niyeti var mı? SAF — ölçüm çağrısını ÜCRETLENDİRMEZ. */
function hasLaunchIntent(command) {
  return segments(command).some((seg) => launchIntent(seg) !== null);
}

/** Worker'ın ekranında görünecek tek paragraflık ret metni. */
function denyMessage(verdict) {
  if (!verdict || verdict.allowed) return '';
  return (
    `⛔ CrewPane kill-guard [${verdict.rule}] — bu komut ÇALIŞTIRILMADI.\n` +
    `${verdict.reason}\n` +
    `→ ${verdict.hint}`
  );
}

/** Pane env'inden karar bağlamını çıkar (hook ve sarmalayıcı AYNI yoldan okur). */
function contextFromEnv(env) {
  const e = env || process.env;
  const pid = e.CREWPANE_HOST_PID || e.CREWPANE_HOST_PID || '';
  const panes = e.CREWPANE_PANE_PIDS || e.CREWPANE_PANE_PIDS || '';
  return {
    // CREWPANE_LIVE_OK=1 — R8'in TEK muafiyeti. Bu değişkeni yalnız Eren verir;
    // ajanın kendi kendine yazması bir KARAR değil, kartın ihlalidir.
    allowLive: String(e.CREWPANE_LIVE_OK || '') === '1',
    hostPid: Number(pid) > 0 ? Number(pid) : null,
    panePids: String(panes)
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0),
  };
}

/** KILL-SWITCH — bir P0 alt-sistemi kapatılabilir olmalı (ADP-659/667/692 emsali). */
function isEnabled(env) {
  const e = env || process.env;
  return (e.CREWPANE_KILL_GUARD || e.CREWPANE_KILL_GUARD || '') !== '0';
}

module.exports = {
  PROTECTED_NAMES,
  ISOLATION_MARKERS,
  INSTALLED_PATH_MARKERS,
  KILL_VERBS,
  WIN_KILL_VERBS,
  ALL_KILL_VERBS,
  RULES,
  RECIPE,
  segments,
  APP_BINARY_NAMES,
  RUNNER_VERBS,
  E2E_RUN_RE,
  LAUNCH_RECIPE,
  launchIntent,
  hasLaunchIntent,
  installedAppAlive,
  inspectLaunch,
  inspectCommand,
  denyMessage,
  contextFromEnv,
  isEnabled,
};
