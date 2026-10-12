// AD-001 spike / ADP-003 — PRELOAD bridge (runs in a sandboxed context).
// Exposes ONLY a minimal, whitelisted, typed-ish pty API to the renderer.
// No raw Node, no fs, no ipcRenderer leak — just named channels.
//
// ADP-003: the API is now multi-pane. `spawn` mints a `paneId` (returned in the
// resolved object); every other call is keyed by that paneId so a single window
// can drive N independent terminals. onData/onExit deliver `{ paneId, ... }` so
// each xterm instance routes only its own pty's bytes.

const { contextBridge: electronContextBridge, ipcRenderer, webUtils } = require('electron');

// SEC-EL-03 (SEC-SCAN P2-6) — PENCERE BAŞINA KÖPRÜ KÜMESİ (en az yetki).
// Bu preload bütün tam-yetkili pencerelere gider; hangi köprülerin AÇILACAĞINA ana
// süreç karar verir (electron/windowBridgeProfiles.cjs) ve listeyi additionalArguments
// ile geçirir: `--agentspace-bridges=*` (hepsi) ya da `--agentspace-bridges=a,b,c`.
// Bayrak YOKSA hiçbir köprü açılmaz (fail-closed) — beyansız bir pencere sessizce tam
// yetki almasın. Sandboxed preload relative require yapamaz → çözümleme burada INLINE,
// windowBridgeProfiles.decodeArgv ile ikiz (windowBridgeProfiles.test.cjs nöbetler).
// Aşağıdaki her `contextBridge.exposeInMainWorld(...)` bu kapıdan geçer: yerel
// `contextBridge` yalnız izinli adları gerçek köprüye iletir.
// ⚠ Bu bir KAPIDIR: bir pencerenin kullandığı köprü listeden düşerse özellik sessizce
// ölür ([[ref_preload_whitelist_is_a_gate]]) — listeyi ölçmeden daraltma.
// Liste öğesi `ad` köprünün tamamını, `ad.uç` yalnız o ucu açar (ör. `appApi.reportFault`:
// el pencereleri renderer hatasını günlüğe yazabilsin ama relaunch/rebuild uçlarını görmesin).
const BRIDGES_FLAG = '--agentspace-bridges=';
const CREWPANE_BRIDGES_FLAG = '--crewpane-bridges=';
const bridgesHit = (process.argv || []).find((a) => typeof a === 'string' && (a.startsWith(BRIDGES_FLAG) || a.startsWith(CREWPANE_BRIDGES_FLAG)));
const flagUsed = bridgesHit && bridgesHit.startsWith(CREWPANE_BRIDGES_FLAG) ? CREWPANE_BRIDGES_FLAG : BRIDGES_FLAG;
const bridgesRaw = bridgesHit ? bridgesHit.slice(flagUsed.length) : '';
const bridgesAll = !bridgesHit || bridgesRaw === '*';
const bridgesAllowed = new Set();
const bridgeKeysAllowed = new Map();
for (const item of bridgesRaw && !bridgesAll ? bridgesRaw.split(',') : []) {
  const dot = item.indexOf('.');
  if (dot === -1) { if (item) bridgesAllowed.add(item); continue; }
  const ns = item.slice(0, dot);
  if (!bridgeKeysAllowed.has(ns)) bridgeKeysAllowed.set(ns, []);
  bridgeKeysAllowed.get(ns).push(item.slice(dot + 1));
}
const contextBridge = {
  exposeInMainWorld(name, api) {
    if (bridgesAll || bridgesAllowed.has(name)) {
      electronContextBridge.exposeInMainWorld(name, api);
      return;
    }
    const keys = bridgeKeysAllowed.get(name);
    if (!keys || !api || typeof api !== 'object') return;
    const subset = {};
    for (const k of keys) if (Object.prototype.hasOwnProperty.call(api, k)) subset[k] = api[k];
    electronContextBridge.exposeInMainWorld(name, subset);
  },
};

// ADP-305 — hangi Supabase? Renderer'ın NEXT_PUBLIC_* değerleri BUILD-TIME gömülü
// olduğu için env ile canlı ofis DB'sinden koparılamıyordu: e2e spec'leri gerçek
// ofise sahte masa + hayalet ajan yazdı (ADP-300/302/305). main.js hedefi
// additionalArguments ile buraya geçiyor (sandboxed preload'a process.argv olarak
// ulaşır), biz de sayfanın İLK script'inden önce açığa çıkarıyoruz — src/lib/supabase.ts
// bunu build-time değerlere TERCİH eder. Bayrak yoksa: davranış aynen eskisi gibi (canlı).
// Salt-okunur veri; yetki/IPC kanalı DEĞİL.
//
// NOT: bu preload SANDBOXED — require() yalnız 'electron' ve birkaç node builtin'ini
// çözer, relative require ATAR (ve preload çökerse ptyApi dahil TÜM köprü gider).
// Bu yüzden çözümleme electron/supabaseTarget.cjs'in ikizi olarak burada INLINE
// (kodlama: base64(JSON); atob sandbox'ta var, Buffer'a güvenmiyoruz).
const SUPABASE_DB_FLAG = '--agentspace-db=';
const CREWPANE_DB_FLAG = '--crewpane-db=';
function decodeSupabaseDbTarget(argv) {
  const hit = (argv || []).find((a) => typeof a === 'string' && (a.startsWith(SUPABASE_DB_FLAG) || a.startsWith(CREWPANE_DB_FLAG)));
  if (!hit) {
    // Graceful fallback for local dev / unpackaged
    return {
      url: 'http://127.0.0.1:54321',
      anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
      schema: 'public',
      channel: 'dev',
      isE2E: false,
    };
  }
  const flag = hit.startsWith(SUPABASE_DB_FLAG) ? SUPABASE_DB_FLAG : CREWPANE_DB_FLAG;
  try {
    const bin = atob(hit.slice(flag.length));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const t = JSON.parse(new TextDecoder('utf-8').decode(bytes));
    return t && t.url ? t : null;
  } catch {
    return {
      url: 'http://127.0.0.1:54321',
      anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
      schema: 'public',
      channel: 'dev',
      isE2E: false,
    };
  }
}
// ADP-837 (P7, 793 B13) — RENDERER'IN PLATFORMU. Kısayol varsayılanları ve
// tuş etiketleri (⌘ mi Ctrl mi) platforma bağlı; bugüne kadar renderer'da
// platformu SÖYLEYEN hiçbir kanal yoktu (ölçüldü: src/app altında tek bir
// `navigator.platform`/`isMac` kullanımı bile yok) → tüm etiketler macOS'a
// sabitlenmişti. Bu SENKRON bir global: kısayol biçimlendirmesi ilk boyamada
// gerekir, `app:info` gibi async bir IPC'yi bekleyemez.
// Salt-okunur bilgi; yetki DEĞİL. Sandboxed preload'da `process.platform` var
// (aynı `process.argv` gibi — yukarıdaki Supabase hedefi de oradan okunuyor).
contextBridge.exposeInMainWorld('agentspacePlatform', String(process.platform || ''));

// UI-TITLEBAR-01 — ANA PENCERENİN BAŞLIK ÇUBUĞU MODU. main yalnız ana pencereye
// `--agentspace-titlebar=<mac|overlay|native>` geçirir (electron/titleBarChrome.cjs;
// sandboxed preload relative require yapamaz → decode burada INLINE ikiz). Mod
// SENKRON gerekir: layout'un boot betiği <html data-titlebar>'ı ilk boyamadan önce
// damgalar, yoksa üst satır bir kare boyunca trafik ışıklarının altında kalır.
const TITLEBAR_FLAG = '--agentspace-titlebar=';
const CREWPANE_TITLEBAR_FLAG = '--crewpane-titlebar=';
const titleBarHit = (process.argv || []).find((a) => typeof a === 'string' && (a.startsWith(TITLEBAR_FLAG) || a.startsWith(CREWPANE_TITLEBAR_FLAG)));
const titleBarMode = titleBarHit ? titleBarHit.slice(titleBarHit.indexOf('=') + 1) : (process.platform === 'darwin' ? 'mac' : 'overlay');

// Son tam ekran durumu burada tutulur: main onu `did-finish-load`'da yollar, React
// effect'i daha sonra abone olabilir — abone olunca son değer hemen verilir.
let fullScreen = false;
const fsListeners = new Set();
ipcRenderer.on('titlebar:fullscreen', (_e, on) => {
  fullScreen = !!on;
  for (const cb of fsListeners) cb(fullScreen);
});
const titleBarApi = {
  mode: titleBarMode,
  /** mac: tam ekrana girince/çıkınca (trafik ışıkları gizlenir/geri gelir). */
  onFullScreen(cb) {
    fsListeners.add(cb);
    cb(fullScreen);
    return () => fsListeners.delete(cb);
  },
  /** overlay (Windows): sistem düğmelerinin zemin + simge rengi (#rrggbb). */
  setOverlayColors(colors) {
    ipcRenderer.send('titlebar:overlay-colors', colors);
  },
};
contextBridge.exposeInMainWorld('agentspaceTitleBar', titleBarApi);

// PERF-BG-01 — TERMİNAL BOYAMA BÜTÇESİ (kontrol kolu).
//
// ÖLÇÜLDÜ (docs/agent-results/PERF-BG-01-evidence): akan HER pane, pty baytlarını
// `requestAnimationFrame` başına bir kez xterm'e yazıyordu — yani EKRANIN TAZELEME
// HIZINDA. Bu makinede (ProMotion, 120 Hz) pane başına +117 rAF/sn ve +5,5 puan
// renderer CPU'su demek; 4 akan pane'de renderer %13 → %35'e çıkıyor ve aynı
// oranda pencere-sunucusu (WindowServer) kompozisyonu doğuyor. Kullanıcı saniyede
// 120 kez tazelenen bir günlüğü zaten OKUYAMAZ: kap görsel bir kayıp değil.
//
// `agentspacePlatform` ile AYNI gerekçe zinciri (senkron global): kap ilk boyamada
// gerekir ve `NEXT_PUBLIC_*` build-time gömülüdür → env ile kapatılamazdı.
//   AGENTSPACE_TERM_FLUSH_HZ=0        → kap KAPALI (eski davranış: her karede yaz)
//   AGENTSPACE_TERM_FLUSH_HZ=<sayı>   → görünür pane için üst sınır (varsayılan 30)
//   AGENTSPACE_TERM_HIDDEN_FLUSH_HZ=<sayı> → GÖRÜNMEYEN pane için (varsayılan 4)
const perfNum = (name, fallback) => {
  const raw = String(process.env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
//
// TERM-LOCK-01 — YAZMA KUYRUĞU KİLİDİ KURTARMASI (kontrol kolu, aynı köprü).
// xterm 6.0.0'ın `WriteBuffer._innerWrite`'ı istisna-güvenli değildir: ayrıştırıcı
// senkron atarsa kuyruk bir daha ZAMANLANMAZ ve pane kalıcı olarak ölür (ekran
// donar, yazılan görünmez, kapat-aç gerekir). Nöbetçi bunu görüp yerinde açar.
//   AGENTSPACE_TERM_WRITE_RECOVERY=0 → kurtarma KAPALI (eski, kilitlenen davranış)
const perfFlag = (name, fallback) => {
  const raw = String(process.env[name] ?? '').trim();
  if (!raw) return fallback;
  return raw !== '0' && raw.toLowerCase() !== 'false';
};
contextBridge.exposeInMainWorld('agentspacePerf', {
  termFlushHz: perfNum('AGENTSPACE_TERM_FLUSH_HZ', 30),
  termHiddenFlushHz: perfNum('AGENTSPACE_TERM_HIDDEN_FLUSH_HZ', 4),
  termWriteRecovery: perfFlag('AGENTSPACE_TERM_WRITE_RECOVERY', true),
  // TERM-BLANK-01 — boş/kopuk pane'in yerinde kurtarılması (kontrol kolu).
  termBlankRecovery: perfFlag('AGENTSPACE_TERM_BLANK_RECOVERY', true),
  // PERF-PTY-RESIZE-01 — aynı boyutu pty'ye her fit'te yeniden basan eski yol (kontrol kolu: =1).
  ptyResizeAlways: perfFlag('AGENTSPACE_PTY_RESIZE_ALWAYS', false),
  // PERF-OFFICE-SWITCH-01 — takım geçişinde ofisin eski "her şeyi baştan kur" yolu (kontrol kolu).
  officeSwitchLegacy: perfFlag('AGENTSPACE_OFFICE_SWITCH_LEGACY', false),
  // PERF-OFFICE-GATE-01 — gizli açılan ofisin eski uyutma sırası (kontrol kolu).
  officeGateLegacy: perfFlag('AGENTSPACE_OFFICE_GATE_LEGACY', false),
  // PERF-MEM-01 — görünür ama 10 sn dokunulmayan ofisin kare hızı (kontrol kolu: =30 ya da =0 → boşta da 30).
  officeIdleFps: perfNum('AGENTSPACE_OFFICE_IDLE_FPS', 10),
  // PERF-OFFICE-IDLE-01 — çizime giren durum değişmediyse ofis karesi çizilmez (kontrol kolu: =0 → her kare çizilir).
  officeRenderSkip: perfFlag('AGENTSPACE_OFFICE_RENDER_SKIP', true),
  // OFFICE-GPU-01 — ofis Graphics dolguları Quad batch'inden (kontrol kolu: =0 → eski TriFlat yolu).
  officeQuadFill: perfFlag('AGENTSPACE_OFFICE_QUAD_FILL', true),
  // OFFICE-HIDE-DEEP-01 — gizli ofis N dk sonra sökülür (oyun + dokular + WebGL bağlamı bırakılır);
  // gizliyken takım geçişi ofise ulaşmaz (kontrol kolu: =0 → sökme yok / donma yok).
  officeDeepHideMin: perfNum('AGENTSPACE_OFFICE_DEEP_HIDE_MIN', 2),
  officeHideFreeze: perfFlag('AGENTSPACE_OFFICE_HIDE_FREEZE', true),
  // PERF-MEM-01 — iç tarayıcıda N dk dokunulmayan arka plan sekmesi uyur (kontrol kolu: =0 → uyutma yok).
  browserTabSleepMin: perfNum('AGENTSPACE_BROWSER_TAB_SLEEP_MIN', 15),
  // PERF-COVERS-01 — görev kapaklarının eski "her takım geçişinde hepsini yeniden çek" yolu (kontrol kolu).
  coversLegacy: perfFlag('AGENTSPACE_COVERS_LEGACY', false),
  // PERF-SHARED-HOOKS-01 — motor/kimlik/karar kancalarının eski "her örnek kendi işini açar" yolu (kontrol kolu).
  sharedHooksLegacy: perfFlag('AGENTSPACE_SHARED_HOOKS_LEGACY', false),
  // PERF-TASKS-LEAN-01 — pano görevlerini eski "select=*" (detay metni dahil) yoluyla çek (kontrol kolu).
  tasksFullSelect: perfFlag('AGENTSPACE_TASKS_FULL_SELECT', false),
  // PERF-DOCK-FREEZE-01 — arkadaki Görevler/Raporlar/Kararlar/Hafıza/Skiller bekler (kontrol kolu: =0).
  dockFreeze: perfFlag('AGENTSPACE_DOCK_FREEZE', true),
  // PERF-TASK-EVENT-01 — tek görev güncellemesi: yalnız değişen pano kartı çizilir, görev kodu araması
  // dizinli, sıralama anahtarı değişmeyen satır yeniden sıralanmaz (kontrol kolu: =0 → üçü de eski yol).
  taskEventFast: perfFlag('AGENTSPACE_TASK_EVENT_FAST', true),
  // PERF-SWITCH-STAGE-01 — takım geçişinde pane'ler kare kare etkinleşir (odaklı önce) ve gizliyken
  // düzeni değişen pane boşta önceden boyutlanır (kontrol kolu: =0 → ikisi de eski yol).
  switchStage: perfFlag('AGENTSPACE_SWITCH_STAGE', true),
  // UI-CHAT-TAB-01 — takım sohbeti kendi dock sekmesi (varsayılan: solda sohbet, ortada Ofis) +
  // Yardımcı paneli kendiliğinden daralır (kontrol kolu: =0 → sohbet ofisin içinde, eski varsayılan düzen).
  uiChatTab: perfFlag('AGENTSPACE_UI_CHAT_TAB', true),
  // BOARD-PERF-01 — Görevler panosu: kapsam tıkları (sprint, Pano/Liste, daha göster) geçiş olarak
  // dilimlenir ve konum değişmiyorsa kaydırma yazılmaz (kontrol kolu: =0 → ikisi de eski yol).
  boardPerf: perfFlag('AGENTSPACE_BOARD_PERF', true),
  // PERF-SWITCH-STAGE-02 — gizlenen takımın terminalleri WebGL bağlamını tutar (bütçe dolunca önce
  // gizliler gider), bırakılan bağlam hemen serbest kalır (kontrol kolu: =0 → her geçişte yeniden kurulur).
  switchStage2: perfFlag('AGENTSPACE_SWITCH_STAGE2', true),
  // PANE-RESIZE-PERF-01 — pane aç/kapat/büyüt/ayraç: terminal yeniden boyutu tek gözlemci + kare bütçeli
  // kuyrukta (odak önce, sığmayan sonraki kareye, büyüt geçişi bitince bir kez) (kontrol kolu: =0 → eski yol).
  paneResizePerf: perfFlag('AGENTSPACE_PANE_RESIZE_PERF', true),
  // PERF-IDLE-POLISH-01 — ofis araç çubuğu yalnız eylem takılınca/sökülünce ölçer (boyut değişimini
  // ResizeObserver getirir), ipucu kartı yalnız bekleyen ipucu varken yoklar (kontrol kolu: =0 → ikisi de eski yol).
  idlePolish: perfFlag('AGENTSPACE_IDLE_POLISH', true),
});

// PERF-RSTALL-01 — RENDERER DONMA İZİ (kalp atışı + LoAF özeti). Electron `unresponsive`
// olayını ancak ~16 sn donmadan sonra atıyor; 0.3.2'deki 19-41 sn'lik kilitlenmelerin
// süresi ve suçlusu günlükte YOKTU. 250 ms'de bir `perf:heartbeat` (renderer'ın
// monotonik saatiyle) gider; ana süreç boşluğu ölçer (çekirdek
// electron/rendererStallTracker.cjs, testli). Boşluktan dönünce burada toplanan
// long-animation-frame kayıtlarının özeti (süre, betik/çizim payı, en ağır 3 betik)
// `perf:stall-detail` ile gider. requestIdleCallback: atış yalnız sayfa boşaldığında
// çıkar; `timeout` normal boşluğu ~350 ms'de sınırlar.
// Sandboxed preload relative require yapamaz → mantık inline ve yalnız sayı/kod adı taşır.
//   AGENTSPACE_RENDERER_STALL_TRACE=0 → atış yok, satır yok (kontrol kolu).
if (perfFlag('AGENTSPACE_RENDERER_STALL_TRACE', true)) {
  const PERIOD_MS = 250;
  const RIC_TIMEOUT_MS = 100;
  const CANDIDATE_GAP_MS = 500;
  const LOAF_KEEP_MS = 200;
  const DETAIL_DELAY_MS = 150;
  const loafs = [];
  let observer = null;
  const keep = (entries) => {
    for (const e of entries) {
      if (e.duration < LOAF_KEEP_MS) continue;
      loafs.push(e);
      if (loafs.length > 16) loafs.shift();
    }
  };
  try {
    observer = new PerformanceObserver((list) => keep(list.getEntries()));
    observer.observe({ type: 'long-animation-frame', buffered: false });
  } catch { observer = null; /* LoAF yok → ana süreç boşluk süresini kullanır */ }
  // URL'nin yalnız dosya adı: yol/sorgu günlüğe girmez.
  const fileOf = (url) => String(url || '').split(/[?#]/)[0].split(/[\\/]/).pop();
  const summarize = (from, to) => {
    if (observer) { try { keep(observer.takeRecords()); } catch { /* yok */ } }
    let loafMs = 0;
    let scriptMs = 0;
    let renderMs = 0;
    const byScript = new Map();
    for (const e of loafs) {
      const end = e.startTime + e.duration;
      if (end <= from || e.startTime >= to) continue;
      loafMs += e.duration;
      if (e.renderStart > 0) renderMs += end - e.renderStart;
      for (const s of e.scripts || []) {
        scriptMs += s.duration;
        const label = `${s.sourceFunctionName || s.invoker || '?'}@${fileOf(s.sourceURL)}:${s.sourceCharPosition}`;
        byScript.set(label, (byScript.get(label) || 0) + s.duration);
      }
    }
    const top = [...byScript.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    return { to, loafMs, scriptMs, renderMs, top };
  };
  let lastT = null;
  const beat = () => {
    const t = performance.now();
    try { ipcRenderer.send('perf:heartbeat', { t }); } catch { /* iz asla sayfayı düşürmez */ }
    if (lastT !== null && t - lastT >= CANDIDATE_GAP_MS) {
      const from = lastT;
      setTimeout(() => {
        try { ipcRenderer.send('perf:stall-detail', summarize(from, t)); } catch { /* aynı */ }
      }, DETAIL_DELAY_MS);
    }
    lastT = t;
    setTimeout(() => {
      if (typeof requestIdleCallback === 'function') requestIdleCallback(beat, { timeout: RIC_TIMEOUT_MS });
      else beat();
    }, PERIOD_MS);
  };
  beat();
  // Takım geçişi React çizmeden ÖNCE bildirilir (WorkspaceView): geçişin kendisi
  // donarsa mesaj ana sürece donmadan önce ulaşmış olur.
  contextBridge.exposeInMainWorld('agentspaceStallTrace', {
    noteTeam: (team) => {
      try { ipcRenderer.send('perf:team', String(team ?? '').slice(0, 64)); } catch { /* aynı */ }
    },
  });
}

// ADP-888 (ADP-885 Faz A) — RENDERER'IN ARAYÜZ DİLİ. Aynı gerekçe zinciri:
// `NEXT_PUBLIC_*` build-time gömülüdür (env ile dil verilemez) ve dil İLK
// BOYAMADA gerekir — `settings:get` gibi async bir IPC beklenirse kullanıcı önce
// yanlış dilde bir kare görür. Bu yüzden main dili additionalArguments ile geçirir
// ve burada SENKRON açığa çıkarılır. Salt-okunur bilgi; yetki/IPC kanalı DEĞİL.
//
// ⚠️ Sandboxed preload relative `require` ATAR → electron/i18n/index.cjs'in
// decodeArgv'si burada INLINE ikizdir (supabaseTarget ile birebir aynı desen).
// Biçim kasten en yalın: "--agentspace-locale=<etkin>:<tercih>".
const LOCALE_FLAG = '--agentspace-locale=';
const CREWPANE_LOCALE_FLAG = '--crewpane-locale=';
function decodeLocale(argv) {
  const hit = (argv || []).find((a) => typeof a === 'string' && (a.startsWith(LOCALE_FLAG) || a.startsWith(CREWPANE_LOCALE_FLAG)));
  if (!hit) return null;
  const flag = hit.startsWith(LOCALE_FLAG) ? LOCALE_FLAG : CREWPANE_LOCALE_FLAG;
  const parts = hit.slice(flag.length).split(':');
  const locale = parts[0];
  const preference = parts[1];
  if (locale !== 'tr' && locale !== 'en') return null;
  return {
    locale,
    preference: preference === 'tr' || preference === 'en' || preference === 'system' ? preference : 'system',
  };
}
// LOCALE-RELOAD-01 — argv pencere AÇILIRKEN donar; `win.reload()` aynı argv'yi
// tekrar verir ve oturumda seçilen dil kaybolurdu. Önce main'e SENKRON sor (her
// yüklemede güncel), cevap yoksa/bozuksa argv'ye düş. Doğrulama argv ile AYNI kural.
function liveLocale() {
  try {
    const s = ipcRenderer.sendSync('locale:get');
    if (!s || typeof s !== 'object') return null;
    return decodeLocale([`${LOCALE_FLAG}${s.locale}:${s.preference}`]);
  } catch {
    return null;
  }
}
const localeState = liveLocale() || decodeLocale(process.argv) || { locale: 'tr', preference: 'system' };
if (localeState) {
  contextBridge.exposeInMainWorld('agentspaceLocale', localeState);
}

const supabaseDbTarget = decodeSupabaseDbTarget(process.argv);
if (supabaseDbTarget) {
  const dbApi = {
    url: supabaseDbTarget.url,
    anonKey: supabaseDbTarget.anonKey,
    // ADP-621 — hangi SCHEMA: bulut muratify-id'de uygulama tabloları `app` altında
    // (`public` = üyelik/fatura), yerel + e2e stack'lerde `public`te. Bu alan kabloda
    // düşerse renderer bulutta yanlış schema'yı sorgular ve HER sorgu 404 döner.
    schema: supabaseDbTarget.schema || undefined,
    // ADP-622 — KİMLİK: 'muratify-id' ise app DB, jetonu imzalayan projeyle AYNI
    // projedir (ADP-621 kararı) → istemci her isteğe kullanıcının access token'ını
    // takar ve `auth.uid()` app schema'sında çözülür. Alan yoksa/başka değerse
    // istemci bugünkü gibi ANON key ile kurulur (yerel 54321, e2e 55321).
    auth: supabaseDbTarget.auth === 'muratify-id' ? 'muratify-id' : undefined,
    // Jetonu main ÜRETİR (safeStorage'daki oturumdan, süresi dolmuşsa SESSİZ
    // yenileyerek). Renderer jetonu saklamaz — her ihtiyaçta buradan ister; bu
    // yüzden `auth` kanalı bir DEĞER değil bir FONKSİYONDUR (bayat jeton olmasın).
    getAccessToken: () => ipcRenderer.invoke('appdb:token'),
    isE2E: !!supabaseDbTarget.isE2E,
    // ADP-723 — kanal rozeti (DataSourceBadge): "hangi kopya + hangi veri kaynağı"
    // ekranda görünsün. Alan yoksa (eski shell) rozet sessizce gizlenir.
    channel: typeof supabaseDbTarget.channel === 'string' ? supabaseDbTarget.channel : undefined,
    customerBuild: supabaseDbTarget.customerBuild === true ? true : undefined,
    mixed: supabaseDbTarget.mixed && typeof supabaseDbTarget.mixed === 'object'
      ? { reason: supabaseDbTarget.mixed.reason }
      : undefined,
    env: supabaseDbTarget.env && typeof supabaseDbTarget.env === 'object'
      ? {
        profile: supabaseDbTarget.env.profile || undefined,
        scheme: supabaseDbTarget.env.scheme || undefined,
        dbUrl: supabaseDbTarget.env.dbUrl || undefined,
        dbSchema: supabaseDbTarget.env.dbSchema || undefined,
        authUrl: supabaseDbTarget.env.authUrl || undefined,
        loginUrl: supabaseDbTarget.env.loginUrl || undefined,
        mailUrl: supabaseDbTarget.env.mailUrl || undefined,
      }
      : undefined,
  };
  contextBridge.exposeInMainWorld('agentspaceDb', dbApi);
}

// ADP-265 — Jarvis input simülasyonu köprüsü: TEK dar kanal (jarvis:input-event).
// Yalnız app penceresi içi (yapısal — sendInputEvent kendi webContents'imize gider);
// şema/sınır/rate-limit main'de, onay kartı renderer'da (actionBus onay-gerekli).
contextBridge.exposeInMainWorld('jarvisInputSim', {
  run: (action) => ipcRenderer.invoke('jarvis:input-event', action),
});

// ADP-817 — Agent X ekran görüntüsü köprüsü: TEK dar kanal (jarvis:screen-capture).
// Renderer YOL vermez ({scope}) — dosya adı/dizin main'in kararı; dönüş {ok, path, bytes}.
// Onay kartı renderer'da (actionBus 'onay-gerekli' sınıfı).
contextBridge.exposeInMainWorld('jarvisScreenCapture', {
  run: (req) => ipcRenderer.invoke('jarvis:screen-capture', req),
});

contextBridge.exposeInMainWorld('ptyApi', {
  /**
   * Ask main to spawn a pty. ADP-013: opts may carry an agent-aware shape
   * `{ cols, rows, command: 'shell'|'claude'|'codex', args, cwd, env, agentId,
   * department, label }`. With no `command` it stays the ADP-003 login shell.
   * A disallowed `command` REJECTS the promise (main-side RCE guard).
   * Resolves to `{ paneId, pid, command, shell, agentId, department }`.
   */
  spawn: (opts) => ipcRenderer.invoke('pty:spawn', opts),

  /**
   * ADP-028 — attach to an existing pane (instead of spawning). Resolves to
   * `{ ok, buffer, seq, agentId, department, command, label }` so the renderer
   * can replay recent output and dedupe live events. `{ ok:false }` if the pane
   * is gone (caller falls back to a fresh spawn).
   */
  attach: (paneId) => ipcRenderer.invoke('pty:attach', paneId),

  /**
   * TERM-BLANK-01 — pane'in AKIŞ DEFTERİ: `{ ok, bytes, lastDataAt }`.
   * Nöbetçi "pty üretti ama bu renderer hiç almadı" hükmünü buradan kurar
   * (renderer kendi ALMADIĞINI ölçemez). Salt-okunur; pane yoksa `{ ok:false }`.
   */
  streamStat: (paneId) => ipcRenderer.invoke('pty:streamStat', paneId),

  /**
   * ADP-280 — teslim-doğrulama: pane'in claude transcript'inde `needle` geçiyor mu?
   * → { found, checked, file }. checked=false = transcript henüz yok/bakılamadı
   * (yanlış 'undelivered' üretme). Pane→sessionId/cwd çözümü main'de.
   */
  transcriptContains: (paneId, needle) => ipcRenderer.invoke('pty:transcriptContains', paneId, needle),

  /**
   * WIN-CODEX-1061-01 Faz B — codex pane'inin tur durumu motorun DEFTERİNDEN (rollout
   * `task_complete`) → { promptAt, completeAt, idle } · null = bilinmiyor. Hazır kapısı
   * ekrandan tur-sonu okunamadığında (Windows ConPTY) bunu "hazır" sinyali sayar.
   */
  engineTurn: (paneId) => ipcRenderer.invoke('pty:engineTurn', paneId),

  /**
   * ADP-306 — pane'in claude transcript'indeki SON asistan mesajı
   * → { checked, text, file, engine }. checked=false = transcript yok/bakılamadı
   * (motor claude değil ya da henüz yazmadı) → çağıran buffer-parse'a düşer.
   */
  lastTranscriptMessage: (paneId) => ipcRenderer.invoke('pty:lastTranscriptMessage', paneId),

  /**
   * ADP-401 — masaüstü OKUMA MODU sayfası: pane'in claude oturum defterinden
   * yapılandırılmış sohbet öğeleri (mobil transcript ile aynı çekirdek).
   * `opts = { limit?, before? }` (before = bayt imleci, geriye sayfalama).
   * → { supported, items, firstOff, hasMore, file } · null = pane yok.
   * supported:false → çağıran ham VT görünümüne düşer (codex/shell).
   */
  transcriptPage: (paneId, opts) => ipcRenderer.invoke('pty:transcriptPage', paneId, opts),

  /**
   * ADP-887 — pane'in JETON/MALİYET künyesi (başlıktaki 'i' kartı).
   * → { engine, engineLabel, billing, measured, session:{tokens,usd,models},
   *     total:{…}, priceSource, plan, match } · null = pane yok.
   * 🔴 `usd: null` HATA DEĞİLDİR (abonelik / fiyatsız motor / ölçülemedi) —
   * çağıran sayı yerine gerekçeyi yazar; 0$ basmak YASAK.
   */
  tokenUsage: (paneId) => ipcRenderer.invoke('pty:tokenUsage', paneId),
  // TOK-C — pane bütçesi: oku / kur / "devam et". Karar MAIN'de verilir; renderer
  // yalnız gösterir ve düğmeye basar (eşik hesabı renderer'da KOPYALANMAZ).
  budget: (payload) => ipcRenderer.invoke('pty:budget', payload),

  /* TOK-B (D-03) — DAĞITIM POLİTİKASI: yeni iş gelince "aynı pane'de sürdür" mü
     "taze oturum" mu. Karar MAIN'de, ÖLÇÜMLE verilir (bağlam/boşta/istek/ilişki);
     renderer yalnız uygular. Eşikler `modelPricing.contextEconomics.dispatch`. */
  /** Plan al: `{action:'continue'|'refresh'|'unmeasured', handoff, code, reasons…}` · null = pane yok. */
  dispatchPlan: (payload) => ipcRenderer.invoke('pty:dispatchPlan', payload),
  /** Kararı UYGULA: (varsa) tek istekle devir özeti + `/clear`. Kararı main yeniden ölçer. */
  dispatchRefresh: (payload) => ipcRenderer.invoke('pty:dispatchRefresh', payload),
  /** İş pane'e YAZILDI — bir sonraki ilişki ölçümünün kıyas tabanı (fire-and-forget). */
  dispatchRecord: (paneId, text) => ipcRenderer.send('pty:dispatchRecord', { paneId, text }),
  /** DLG-CLEAR-ARGS-01 — iş metni yazılmadan önce: istemde Enter'ı yutulmuş `/clear` kaldı mı?
      Kaldıysa main Enter'ı doğrulayarak tekrarlar; komut istemde KALIRSA hüküm 'stuck' (yazma). */
  resetSettle: (paneId, opts) => ipcRenderer.invoke('pty:resetSettle', { paneId, ...(opts || {}) }),

  /* DELEG-DELIVER-01 — HAZIR-KAPI KARARI MAIN LOG'A. Bu yolun (taze pane'e prompt
     yazımı) üretimde TEK BİR log satırı yoktu: `engineReadyRunner` `console.info`
     basıyor, o da main log'a düşmüyor ([renderer console] köprüsü yalnız AUTOTEST'te
     bağlanır) → 06.09'un 6 teslim düşüşünde yazımın NE ZAMAN ve pane HANGİ durumdayken
     yapıldığı görülemedi. Tek yön, ateşle-unut; hiçbir şey döndürmez. */
  /** `{paneId, verdict, waitedMs, tailLen, sawBytes, blockers}` → main log satırı. */
  deliveryTrace: (payload) => ipcRenderer.send('pty:deliveryTrace', payload),

  /* D-07 (SPRINT-TOK-01) — AŞAMA B: HAFIZA SEÇKİSİ GÖREV METNİYLE.
     Spawn'da seçki YAPILMAZ (görev metni o an yok — D-04'ün ölçtüğü kök neden);
     iş dağıtılmadan hemen önce burası çağrılır ve seçki İŞİN KENDİSİYLE yapılır.
     Eşiği geçen kayıt yoksa `text:''` döner → prompt'a hiçbir şey eklenmez. */
  /** → `{ ok, text, slugs, stats:{kept, considered, threshold, reason, chars} }` */
  memoryTaskBlock: (payload) => ipcRenderer.invoke('memory:taskBlock', payload),

  /**
   * ADP-013 — list live panes for this window, optionally filtered by
   * department (team→pane-set for ADP-012). Resolves to an array of
   * `{ paneId, agentId, department, command, label, pid, startedAt, status }`.
   */
  list: (department) => ipcRenderer.invoke('pty:list', department),

  /**
   * ORPHAN-ELECTRON-01 — YETİM Electron biçme (süpervizör yolu).
   * `{op:'baseline'}` → `{ok, pids, scanned}` (dispatch anındaki taban)
   * `{op:'reap', excludePids, olderThanMs}` → `{ok, reaped:[{pid, how, …}], scanned}`
   * Karar MAIN'de verilir (süreç ölçümü orada); renderer yalnız sorar.
   */
  reapOrphanElectrons: (payload) => ipcRenderer.invoke('pty:reapOrphanElectrons', payload),

  /** ADP-013 — (re)bind a live pane to an agent/department/label after spawn. */
  bind: (paneId, binding) =>
    ipcRenderer.send('pty:bind', { paneId, ...(binding || {}) }),

  /**
   * Keyboard / paste input from xterm → pty (routed by paneId).
   *
   * TOK-C (D-02 v2) — `opts.origin:'system'` bu yazımın İNSAN TUŞU DEĞİL otomasyon
   * olduğunu beyan eder (görev dağıtımı: taskAssignment → sendCommand). Main o
   * beyanı görürse bütçe frenini uygular. Beyan YOKSA yazım insan sayılır ve
   * geçer — güvenli taraf budur (yanlış tarafa düşmenin bedeli, kullanıcının
   * tuşunun sessizce yutulmasıdır).
   */
  write: (paneId, data, opts) =>
    ipcRenderer.send('pty:input', {
      paneId,
      data,
      origin: opts && opts.origin === 'system' ? 'system' : undefined,
    }),

  /**
   * ADP-692 — KORUMALI yazım: "kendiliğinden" gönderilen her metin (lider uyandırması)
   * bu yoldan geçer. Kapı (insan yazıyor mu / composer boş mu) ile yazım main'de AYNI
   * senkron blokta koşar → kullanıcının yarım prompt'unun ardına ASLA eklenemez.
   * `seenBuffer` = çağıranın son gördüğü buffer (CAS); değiştiyse yazım reddedilir.
   */
  writeGuarded: (paneId, text, opts) =>
    ipcRenderer.invoke('pty:writeGuarded', {
      paneId,
      text,
      seenBuffer: opts && typeof opts.seenBuffer === 'string' ? opts.seenBuffer : undefined,
      submit: !(opts && opts.submit === false),
    }),

  /** xterm fit → pty resize (routed by paneId). */
  resize: (paneId, size) =>
    ipcRenderer.send('pty:resize', { paneId, cols: size.cols, rows: size.rows }),

  /** Kill a single pty by paneId (terminal closed in the UI). */
  // DLG-TRUTH-01 — yalnız `closedBy:'user'` geçer (kullanıcının kendi kapatması); main yine doğrular.
  kill: (paneId, opts) =>
    ipcRenderer.send('pty:kill', paneId, opts && opts.closedBy === 'user' ? { closedBy: 'user' } : undefined),

  /** Subscribe to pty output for ALL panes. cb gets { paneId, data }. Returns unsubscribe. */
  onData: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('pty:data', listener);
    return () => ipcRenderer.removeListener('pty:data', listener);
  },

  /** Subscribe to pty exit for ALL panes. cb gets { paneId, code }. Returns unsubscribe. */
  onExit: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('pty:exit', listener);
    return () => ipcRenderer.removeListener('pty:exit', listener);
  },

  /**
   * ADP-303 — main asked for a pane to be brought to the front (the leader's
   * `agentspace_pane focus` → bridge → main). cb gets { paneId }. Returns unsubscribe.
   */
  onFocusRequest: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('pane:focus', listener);
    return () => ipcRenderer.removeListener('pane:focus', listener);
  },

  /**
   * ADP-192 — restart-resume notice: fired once on launch after main re-spawns the
   * agents that were running before shutdown. cb gets { count, agents:[{ agentId,
   * department, paneId, engine, resumed }] }. Returns unsubscribe.
   */
  onPanesRestored: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('panes:restored', listener);
    return () => ipcRenderer.removeListener('panes:restored', listener);
  },

  /**
   * ADP-734 Kapı 2 — KURTARILABİLİR PANE TEKLİFİ. Açılışta bulunan bayat bir kayıt
   * ya da defterin sessizce boşalması: main pane AÇMAZ, bunu yollar. cb gets
   * { count, reason, source, agents:[{agentId, department, engine, sessionId}] }.
   * Kabul → `restoreRecoverablePanes()`. Returns unsubscribe.
   */
  onPanesRecoverable: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('panes:recoverable', listener);
    return () => ipcRenderer.removeListener('panes:recoverable', listener);
  },

  /** ADP-734 — teklifi uygula: bekleyen pane'leri gerçekten aç. */
  restoreRecoverablePanes: () => ipcRenderer.invoke('panes:restoreRecoverable'),

  /**
   * ADP-335 — MODÜL HATASI. main'deki bir modül (VT harvest, gateway, store…)
   * kod hatası verdi: uygulama YAŞIYOR, o özellik degrade. cb gets
   * { module, label, message, location:'electron/paneScreen.cjs:87', stopped, at }.
   * Bildirim merkezinde dürüst tek satır olarak görünür; tıklanınca log açılır.
   */
  onModuleFault: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('module:fault', listener);
    return () => ipcRenderer.removeListener('module:fault', listener);
  },
  /** Bildirime tıklanınca: hata log'unu aç (dosya:satır zaten bildirimde). */
  openFaultLog: () => ipcRenderer.invoke('module:openLog'),
  /** Açılışta kaçırılan hatalar (son 20). */
  moduleFaults: () => ipcRenderer.invoke('module:faults'),

  /**
   * ADP-428 — limit auto-resume yaşam döngüsü olayları (main pty daemon).
   * cb gets { kind: 'continue'|'respawn'|'select'|'fail', paneId, agentId, detail }.
   * 'fail' = daemon gönderim bütçesini tüketti → UI yapışkan uyarı göstermeli
   * (ajan İNSAN "devam et"i bekliyor). Returns unsubscribe.
   */
  onResumeEvent: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('resume:event', listener);
    return () => ipcRenderer.removeListener('resume:event', listener);
  },

  /**
   * LR03-SIG-01 — motor limit sinyali (main hub'ı). `limitSignal(paneId)` →
   * {limited, resetAt, source, observedAt, engine, window, via} | null;
   * `limitSignalSnapshot()` → {paneId: signal}; `onLimitSignal(cb)` sinyal değişince
   * {paneId, signal} ile çağrılır. Returns unsubscribe.
   */
  limitSignal: (paneId) => ipcRenderer.invoke('limitSignal:get', paneId),
  limitSignalSnapshot: () => ipcRenderer.invoke('limitSignal:snapshot'),
  onLimitSignal: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('limitSignal:changed', listener);
    return () => ipcRenderer.removeListener('limitSignal:changed', listener);
  },

  /**
   * LR03-PARK-01 — limit parkı (main gözetmeni). `limitParkSnapshot()` → {mode, parks};
   * `onLimitPark(cb)` park durumu değişince {mode, park} ile çağrılır. `on` kipinde
   * renderer delegasyonu ve sprint limit devamını YAZMAZ, durumu buradan yansıtır.
   */
  limitParkSnapshot: () => ipcRenderer.invoke('limitPark:snapshot'),
  onLimitPark: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('limitPark:changed', listener);
    return () => ipcRenderer.removeListener('limitPark:changed', listener);
  },

  /**
   * TOK-C (D-02 v2) — BÜTÇE OLAYLARI (main → renderer).
   * cb gets { kind:'blocked', source, paneId, agentId, budget }.
   *
   * Neden olay, neden yalnız ölçüm turu değil: ölçüm turu 90 saniyede bir koşar;
   * duraklatmanın GERÇEKTEN olduğu an ise sistemin o pane'e yazmaya çalıştığı
   * andır. Ofis balonu o anda çıkmazsa kullanıcı, durmuş bir ajanın sprite'ında
   * bir buçuk dakika boyunca "çalışıyor" okur. Returns unsubscribe.
   */
  onBudgetEvent: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('pty:budget-event', listener);
    return () => ipcRenderer.removeListener('pty:budget-event', listener);
  },
  /**
   * DLG-16 — lider otomatik tazeleme olayları (main `pty:dispatch-event`): kullanıcı
   * "Lider hafızasını tazeledi" satırını ANINDA görür. Returns unsubscribe.
   */
  onDispatchEvent: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('pty:dispatch-event', listener);
    return () => ipcRenderer.removeListener('pty:dispatch-event', listener);
  },
});

// ADP-593 — pane POP-OUT köprüsü: bir terminal pane'ini ayrı bir macOS penceresine
// çıkar / geri koy. YALNIZ PENCERE yönetir — pty spawn/kill YOK, dolayısıyla dışarı
// çıkarma da geri koyma da koşan ajanın oturumunu ASLA öldürmez (ADP-593 §2).
contextBridge.exposeInMainWorld('popoutApi', {
  /** Pane'i ayrı pencereye çıkar. `{ paneId, title?, agentId? }` → { ok, paneId } | { ok:false, error }. */
  open: (payload) => ipcRenderer.invoke('popout:open', payload),
  /** Pop-out penceresini kapat = pane eski hücresine döner. → { ok } | { ok:false, error }. */
  close: (paneId) => ipcRenderer.invoke('popout:close', paneId),
  /** Şu an dışarıda olan paneId'ler (reload sonrası durum hidrasyonu). → string[]. */
  list: () => ipcRenderer.invoke('popout:list'),
  /** Pop-out penceresi kapandı (kullanıcı ⌘W/kırmızı düğme/"Geri koy"). cb gets { paneId }. Returns unsubscribe. */
  onClosed: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('popout:closed', listener);
    return () => ipcRenderer.removeListener('popout:closed', listener);
  },
  /** ADP-712 — pencereyi büyüt/eski boyutuna getir (ızgaradaki "zoom"un karşılığı). */
  toggleMaximize: (paneId) => ipcRenderer.invoke('popout:toggleMaximize', paneId),
  /** ADP-712 — pencerenin şu anki durumu → { paneId, maximized } | null. */
  state: (paneId) => ipcRenderer.invoke('popout:state', paneId),
  /** ADP-712 — pencere native düğmeyle büyütüldü/küçültüldü. cb gets { paneId, maximized }. */
  onState: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('popout:state', listener);
    return () => ipcRenderer.removeListener('popout:state', listener);
  },
});

// AUID-KABLO — TASARIM TURU PENCERESİ köprüsü. `popoutApi` ile aynı desen ama
// pane/pty BAĞI YOK: tasarım penceresi kendi başına bir yüzeydir (`/design`).
// Tekillik kararı MAIN'de: ikinci `openWindow()` yeni pencere doğurmaz, var olanı
// öne getirir ve `reused:true` döner — renderer bunu tahmin etmez, ÖLÇER.
// DEMO-04 — TANITIM TURUNUN ÖRNEK SİTESİ. Sayfa kurulumla gelir ve `file:`
// şemasıyla gömülü tarayıcıda açılır; adresi YALNIZ main bilir (paketli yol
// `process.resourcesPath` altındadır, renderer'da böyle bir bilgi yok).
// Salt-okunur bir SORU: renderer yol vermez, yalnız dil seçer.
contextBridge.exposeInMainWorld('demoSiteApi', {
  /** Örnek sitenin adresi. → { ok:true, url } | { ok:false } (dosya pakette yoksa).
   *  ONB-F2 — `goal` senaryonun sayfasını seçer; main kapalı kümeye daraltır. */
  url: (lang, goal) => ipcRenderer.invoke('demo:siteUrl', { lang, goal }),
});

contextBridge.exposeInMainWorld('designApi', {
  /**
   * Tasarım turunu ayrı pencerede aç (zaten açıksa öne getirir). → { ok, reused? } | { ok:false, error }.
   * RPT5-05 — `target = { task, version?, region? }` → o görevin o sürümü seçili açılır (şekli main
   * doğrular). Parametresiz çağrı eskisi gibi.
   */
  openWindow: (target) => ipcRenderer.invoke('design:openWindow', target),
  /** RPT5-05 — bekleyen hedef (pencere açılırken çekilir). → { task, version, region, seq } | null. */
  currentTarget: () => ipcRenderer.invoke('design:currentTarget'),
  /** RPT5-05 — açık pencereye yeni hedef geldi. cb gets { task, version, region, seq }. Returns unsubscribe. */
  onTarget: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('design:target', listener);
    return () => ipcRenderer.removeListener('design:target', listener);
  },
  /** RPT5-05 — tasarım turu yazdı (ölçüm, onay, yeni sürüm). cb gets { task }. Returns unsubscribe. */
  onChanged: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('design:changed', listener);
    return () => ipcRenderer.removeListener('design:changed', listener);
  },
  /** Tasarım penceresini kapat. → { ok } | { ok:false, error }. */
  closeWindow: () => ipcRenderer.invoke('design:closeWindow'),
  /** Pencere şu an açık mı → { open }. */
  isWindowOpen: () => ipcRenderer.invoke('design:isWindowOpen'),
  /** Pencere açıldı/kapandı (giriş düğmesi gerçeği yansıtsın). cb gets { open }. Returns unsubscribe. */
  onOpenState: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('design:openState', listener);
    return () => ipcRenderer.removeListener('design:openState', listener);
  },
  /**
   * AUID-M4A (ARIZA-1) — TÜM pencerelerdeki ajan-bağlı pane'ler. `ptyApi.list`
   * SAHİP PENCEREYE göre süzer ve tasarım penceresi hiçbir pty'nin sahibi
   * olmadığı için ona hep BOŞ dönüyordu. → { ok, panes }.
   */
  listAgents: () => ipcRenderer.invoke('design:listAgents'),
  /**
   * AUID-M4A — bir tasarım görevi klasörü aç (`docs/design/<görev>`). `fileApi`
   * mkdir yapamaz; demo tohumu ve üretim modu buna muhtaç. → { ok, created }.
   */
  ensureTaskDir: (rel) => ipcRenderer.invoke('design:ensureTaskDir', rel),
});

// ADP-712 — PANE GÖRÜNÜM DURUMU (okunabilir mod) köprüsü. Aynı pane'in ızgaradaki
// hücresi ile ayrı penceresi TEK tercihi paylaşır: durum main'de yaşar, her
// değişim tüm pencerelere yayınlanır ("pty tek, iki görünüm" — ADP-593 ilkesinin
// görünüm katmanındaki karşılığı). pty'ye DOKUNMAZ.
contextBridge.exposeInMainWorld('paneViewApi', {
  /** → { readable } (bilinmeyen pane için varsayılan). */
  get: (paneId) => ipcRenderer.invoke('paneView:get', paneId),
  /** Durumu yaz + yayınla. `patch = { readable }` → { ok, paneId, readable, changed }. */
  set: (paneId, patch) => ipcRenderer.invoke('paneView:set', { paneId, ...(patch || {}) }),
  /** Başka bir pencere durumu değiştirdi. cb gets { paneId, readable }. Returns unsubscribe. */
  onChanged: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('paneView:changed', listener);
    return () => ipcRenderer.removeListener('paneView:changed', listener);
  },
});

// ADP-786 — GÖNDERİLMEMİŞ PROMPT TASLAĞI köprüsü. Okunabilir moddaki prompt
// kutusunun metni renderer'da YAŞAMAZ: pop-out ayrı bir renderer'dır ve mod
// değişimi okuyucuyu unmount eder — ikisi de kullanıcının yazdığını siler.
// Taslak main'deki deftere yazılır, her mount'ta oradan okunur. pty'ye DOKUNMAZ:
// bu metin HENÜZ GÖNDERİLMEMİŞTİR, gönderme kararı kullanıcınındır (ADP-155).
contextBridge.exposeInMainWorld('paneDraftApi', {
  /** → taslak metin (bilinmeyen pane için ''). */
  get: (paneId) => ipcRenderer.invoke('paneDraft:get', paneId),
  /** Taslağı yaz + (gerçekten değiştiyse) yayınla → { ok, paneId, text, changed }. */
  set: (paneId, text) => ipcRenderer.invoke('paneDraft:set', { paneId, text }),
  /** Aynı pane'i gösteren başka yüzey taslağı değiştirdi. cb: { paneId, text }. */
  onChanged: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('paneDraft:changed', listener);
    return () => ipcRenderer.removeListener('paneDraft:changed', listener);
  },
});

// ASK-CARD-01 — LİDERİN KARAR SORUSU köprüsü (paneDraftApi kardeşi). Defter main'de
// (electron/paneAsk.cjs); kart, pane rozeti, ofis işareti ve Yardımcı listesi AYNI
// anlık görüntüyü okur. Cevap BURADAN pane'e gitmez: main ENT-F1 primitifiyle yazar
// (metin bir kez), renderer yalnız seçimi taşır.
// 🔴 Yeni kanal = bu listeye satır; düşerse özellik SESSİZCE ölür
// ([[ref_preload_whitelist_is_a_gate]]).
contextBridge.exposeInMainWorld('paneAskApi', {
  /** → açık sorular (PaneAsk[]). */
  list: () => ipcRenderer.invoke('paneAsk:list'),
  /** Seçenek (choiceId) ya da serbest metin (text) → { ok, delivered?, reason?, ask? }. */
  answer: (payload) => ipcRenderer.invoke('paneAsk:answer', payload || {}),
  /** Kartı cevapsız kapat → { ok, reason? }. */
  dismiss: (askId) => ipcRenderer.invoke('paneAsk:dismiss', askId),
  /** Defter değişti (açıldı / hatırlatma / kapandı). cb: { type, ask }. Returns unsubscribe. */
  onChanged: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('paneAsk:changed', listener);
    return () => ipcRenderer.removeListener('paneAsk:changed', listener);
  },
});

// OFFICE-CHAT-TEAM-01 — TAKIM ODASI köprüsü. Oda main'de yaşar (electron/officeRoom.cjs):
// patron mesajı buradan girer, ajanın cevabı `officeRoom:changed` ile geri gelir.
// Teslim BURADAN yapılmaz — main AXP-03 yolunu çağırır; renderer yalnız metni taşır.
// 🔴 Yeni kanal = bu listeye satır; düşerse özellik SESSİZCE ölür
// ([[ref_preload_whitelist_is_a_gate]]). Köprü yoksa oda SUSAR (kontrol kolu).
contextBridge.exposeInMainWorld('officeRoomApi', {
  /**
   * CHAT-FIX-04 — odayı ADIYLA iste: `{ team, archive?, aliases? }` → `{ team, messages, accepted,
   * archiveCount }` (eskiden yeniye). Oda adı yoksa boş oda; tüm defter renderer'a hiç gelmez.
   */
  get: (req) => ipcRenderer.invoke('officeRoom:get', req || {}),
  /**
   * Patron odaya yazdı. `{ text, source?, bossLabel?, ctx:{aliases,departments,activeDepartment}, attachPaths? }`
   * → { ok, message, intent, results } | { ok:false, kind:'no-text'|'unknown-address'|'no-target'|'no-image-target' }.
   * OCV3-05 — `text` boş olabilir, yeter ki görsel olsun (yalnız görsel gönderimi).
   * `ctx.aliases` agentx:deliver ile AYNI şekildir (ikinci roster sözlüğü yok).
   */
  say: (req) => ipcRenderer.invoke('officeRoom:say', req || {}),
  /**
   * OCV3-01 — "Kime:" önizlemesi: `{ text, aliases }` → `{ to, unknown, ambiguous, broadcast }`.
   * Teslimin kullandığı ayrıştırıcının KENDİSİ (ikinci kopya yok). Yan etkisiz.
   */
  preview: (req) => ipcRenderer.invoke('officeRoom:preview', req || {}),
  /**
   * CHAT-RICH-02 — sohbet eki: `{ id, ext, variant:'thumb'|'full' }` →
   * `{ ok, dataUrl?, present? } | { ok:false, reason:'missing'|'bad-key'|… }`. Yol taşımaz.
   */
  attachment: (req) => ipcRenderer.invoke('officeRoom:attachment', req || {}),
  /** CHAT-RICH-02 — dosya kartı: `{ id, ext, reveal? }` → sistem uygulamasında aç / klasörde göster. */
  openAttachment: (req) => ipcRenderer.invoke('officeRoom:attachmentOpen', req || {}),
  /** OFC-02 — teslimi kabul et: `{ deliveryId }` → `{ ok, at? } | { ok:false, reason }`. */
  accept: (req) => ipcRenderer.invoke('officeRoom:accept', req || {}),
  /** OFC-16 — ajan satırına tepki: `{ id, emoji, on? }` → `{ ok, reactions? } | { ok:false, reason }`. Ajana GİTMEZ. */
  react: (req) => ipcRenderer.invoke('officeRoom:react', req || {}),
  /** OFC-03 — lidere ulaşılamayan aktarımı yeniden dene: `{ id, ctx:{aliases}, bossLabel?, imageCapable? }` → `{ ok, reason? }`. */
  retryHandoff: (req) => ipcRenderer.invoke('officeRoom:retryHandoff', req || {}),
  // CHAT-FIX-02 — odanın sorusu: "terminali açayım mı?" / "kartta çalışana araya yazayım mı?".
  answerAsk: (req) => ipcRenderer.invoke('officeRoom:answerAsk', req || {}),
  /**
   * CHAT-Q-01 — karar kartını cevapla (docs/design/SOHBET-KARAR-KARTI-V1.md §4):
   * `{ id?, secim?, metin?, rootId?, ctx:{aliases}, bossLabel?, imageCapable? }` →
   * `{ ok, state?, decision? } | { ok:false, reason }`.
   */
  answerDecision: (req) => ipcRenderer.invoke('officeRoom:answerDecision', req || {}),
  /**
   * INT-OAUTH-SEND-01 — e-posta onay kartı: `{ id, action:'send'|'cancel', edit?:{to,subject,body} }` →
   * `{ ok, state, line?, task?, error? } | { ok:false, reason }`. Gönderimin TEK yolu (köprüde yok).
   */
  mailDecide: (req) => ipcRenderer.invoke('officeRoom:mailDecide', req || {}),
  /** INT-OAUTH-SEND-01 — "Düzenle" için tam taslak: `{ id }` → `{ ok, to, subject, body }`. */
  mailDraft: (req) => ipcRenderer.invoke('officeRoom:mailDraft', req || {}),
  /** PERM-MENU-METRICS-01 — "İzin soruları (7 gün)": yalnız sayılar + en sık eylem (kişisel veri yok). */
  permMenuWeek: () => ipcRenderer.invoke('officeRoom:permMenuWeek'),
  /**
   * Oda değişti. CHAT-FIX-04 — cb: `{ team? }` (satır YOK): hangi oda değişti (null arşiv, yok =
   * herhangi biri); pencere kendi odasını `get` ile yeniden ister. Returns unsubscribe.
   */
  onChanged: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('officeRoom:changed', listener);
    return () => ipcRenderer.removeListener('officeRoom:changed', listener);
  },
});

// AXP-02 — AGENT X İŞ TASLAĞI köprüsü (paneDraftApi kardeşi). Taslak main'deki
// durum makinesinde yaşar (electron/agentxDraft.cjs); widget ses/klavye girdisini
// yazar, ana pencere ve pop-out aynası aynı fotoğrafı okur. Karar burada VERİLMEZ:
// bu köprü metni taşır, "ekle mi / teyit mi / gönder mi" cevabı main'den döner.
// 🔴 Yeni kanal = bu listeye satır; düşerse özellik SESSİZCE ölür
// ([[ref_preload_whitelist_is_a_gate]]); kablo taraması agentxDraft.test.cjs'te.
contextBridge.exposeInMainWorld('agentxDraftApi', {
  /** → DraftSnapshot { state, text, units, target, revision, pending, notice, … } */
  get: () => ipcRenderer.invoke('agentxDraft:get'),
  /** RouteDecision (cls:'prompt') → taslağı aç / gövdeyi ekle. AXD-04 `opts.review`: açılış geri okuma olarak söylenecek. */
  open: (route, at, opts) => ipcRenderer.invoke('agentxDraft:open', { route, at, review: !!(opts && opts.review) }),
  /** Sonlandırılmış cümle. `startedAt` = KAYDIN başladığı an (spokenAt kapısı buna bakar). */
  hear: (text, opts) => ipcRenderer.invoke('agentxDraft:hear', { text, ...(opts || {}) }),
  /** Klavye: metnin tamamı (ses ve klavye AYNI defter). */
  edit: (text) => ipcRenderer.invoke('agentxDraft:edit', { text }),
  setTarget: (target) => ipcRenderer.invoke('agentxDraft:setTarget', { target }),
  /** "dur/bekle": taslak DURAKSAR. Sessizlik (noSpeech) en fazla geri okuma + soru açar — asla göndermez. */
  pause: (at) => ipcRenderer.invoke('agentxDraft:pause', { at }),
  noSpeech: (at) => ipcRenderer.invoke('agentxDraft:noSpeech', { at }),
  /** Gönder düğmesi / kapanış sözü → hedef sorusu ya da teyit. */
  finish: (at) => ipcRenderer.invoke('agentxDraft:finish', { at }),
  /**
   * TTS soruyu BİTİRDİ: bundan önce başlayan kayıt cevap sayılmaz. AXD-04 `said` = GERÇEKTEN
   * söylenen cümle — kutup ve geri okuma kapsamı ondan ölçülür; düşerse sesle gönderim kapanır.
   */
  spoken: (id, at, said) => ipcRenderer.invoke('agentxDraft:spoken', { id, at, said: typeof said === 'string' ? said : null }),
  /** Düğme: 'send' | 'edit' | 'cancel'. */
  resolve: (id, choice, at) => ipcRenderer.invoke('agentxDraft:resolve', { id, choice, at }),
  cancel: (at) => ipcRenderer.invoke('agentxDraft:cancel', { at }),
  undo: (at) => ipcRenderer.invoke('agentxDraft:undo', { at }),
  tick: (at) => ipcRenderer.invoke('agentxDraft:tick', { at }),
  // OFC-06 — yeniden açılışta geri gelen taslağı bu oturuma al ("Devam et"; gönderim yok).
  ackResume: () => ipcRenderer.invoke('agentxDraft:ackResume', {}),
  /** Fotoğraf değişti (her yüzey). cb: DraftSnapshot */
  onChanged: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('agentxDraft:changed', listener);
    return () => ipcRenderer.removeListener('agentxDraft:changed', listener);
  },
  /** "evet" dendi → draft:confirmed { id, revision, digest, target, text }. AXP-03 tüketir. */
  onConfirmed: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('agentxDraft:confirmed', listener);
    return () => ipcRenderer.removeListener('agentxDraft:confirmed', listener);
  },
});

// AXMT-04 — TASLAK DEMETİ köprüsü (agentxDraftApi kardeşi): tek sözden çıkan birden çok iş,
// toplu geri okuma + TEK onay + kısmi düzeltme. Defter main'de (electron/agentxBundle.cjs).
// 🔴 Yeni kanal = bu listeye satır; kablo taraması agentxBundle.test.cjs'te.
contextBridge.exposeInMainWorld('agentxBundleApi', {
  get: () => ipcRenderer.invoke('agentxBundle:get'),
  /** RouteDecision (cls:'plan') → demeti aç. `context` = classify bağlamı (takım/ajan etiketleri). */
  open: (route, at, context) => ipcRenderer.invoke('agentxBundle:open', { route, at, context }),
  /** Sonlandırılmış cümle. `startedAt` = KAYDIN başladığı an (spokenAt kapısı). */
  hear: (text, opts) => ipcRenderer.invoke('agentxBundle:hear', { text, ...(opts || {}) }),
  /** TTS soruyu BİTİRDİ. `said` = GERÇEKTEN söylenen cümle — kalem kapsamı ve kutup ondan ölçülür. */
  spoken: (id, at, said) => ipcRenderer.invoke('agentxBundle:spoken', { id, at, said: typeof said === 'string' ? said : null }),
  /** HEDEF SORUSU cevabı çözüldü → n. kalemin hedefi. */
  setTarget: (n, target, at) => ipcRenderer.invoke('agentxBundle:setTarget', { n, target, at }),
  editItem: (n, text, at) => ipcRenderer.invoke('agentxBundle:editItem', { n, text, at }),
  removeItem: (n, at) => ipcRenderer.invoke('agentxBundle:removeItem', { n, at }),
  finish: (at) => ipcRenderer.invoke('agentxBundle:finish', { at }),
  noSpeech: (at) => ipcRenderer.invoke('agentxBundle:noSpeech', { at }),
  tick: (at) => ipcRenderer.invoke('agentxBundle:tick', { at }),
  /** Düğme: 'send' | 'edit' | 'cancel'. */
  resolve: (id, choice, at) => ipcRenderer.invoke('agentxBundle:resolve', { id, choice, at }),
  cancel: (at) => ipcRenderer.invoke('agentxBundle:cancel', { at }),
  undo: (at) => ipcRenderer.invoke('agentxBundle:undo', { at }),
  ackResume: () => ipcRenderer.invoke('agentxBundle:ackResume', {}),
  onChanged: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('agentxBundle:changed', listener);
    return () => ipcRenderer.removeListener('agentxBundle:changed', listener);
  },
  /** TEK onay → { items:[…], statusesAfter:[…] } — AXMT-05 ışık turu + teslim tüketir. */
  onConfirmed: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('agentxBundle:confirmed', listener);
    return () => ipcRenderer.removeListener('agentxBundle:confirmed', listener);
  },
});

// ADP-035 — multimodal prompt image bridge. saveTemp writes a renderer-supplied
// image blob to a temp file (main-side fs) and resolves to `{ ok, path, bytes }`
// (or `{ ok:false, reason }`). The prompt box injects the returned PATH into the
// prompt for the claude CLI (path injection, not base64 — UX-UI-V2 §5).
// WIN-IMG-01 — `verify` EKLENDİ: gönderimden hemen önce "bu görseller hâlâ diskte
// mi?" sorusu. Sessiz başarısızlık yasağı (ajanın "erişemiyorum" deyip kendi
// yorumunu yaptığı, kullanıcının sebebi bilmediği durum). Main YALNIZ kendi görsel
// köküne bakar → renderer'a genel bir dosya varlık-oracle'ı açılmaz.
contextBridge.exposeInMainWorld('imageApi', {
  saveTemp: (payload) => ipcRenderer.invoke('image:saveTemp', payload),
  /** → { ok, missing:[], foreign:[], present:[] } */
  verify: (paths) => ipcRenderer.invoke('image:verify', paths),
});

// BOARD-IMG-3 — GÖREV KARTI EKLERİ köprüsü (task_attachments).
// `imageApi` ile karıştırılmasın: o OTURUMLUK bir temp dosyası üretir (ajana yol
// verilir, kapanışta silinir); bu KALICI bir ek deposudur (kart kanıtı yıllarca
// durur). Renderer'a fs AÇILMAZ — baytlar main'de doğrulanır, geri yalnız
// metadata + data-URI gelir.
contextBridge.exposeInMainWorld('attachmentApi', {
  /**
   * Bir görseli depoya al. `path` (native drop / MCP) YA DA `data` (⌘V, dosya
   * seçici) verilir. → { ok, sha256, mime, bytes, width, height, localRelPath,
   * thumbDataUrl, originDevice, title, kind, source } | { ok:false, reason }
   */
  ingest: (payload) => ipcRenderer.invoke('attachment:ingest', payload),
  /** local_rel_path → { ok, dataUrl, mime, bytes } | { ok:false, reason:'missing' } */
  read: (relPath) => ipcRenderer.invoke('attachment:read', relPath),
  /** → { ok, present } — tam çözünürlük BU cihazda var mı? */
  hasBytes: (relPath) => ipcRenderer.invoke('attachment:hasBytes', relPath),
  /** ATTACH-COVER-FULLRES — tam boy HAM bayt → { ok, bytes: Uint8Array, mime } | { ok:false, reason:'missing' } */
  readBytes: (relPath) => ipcRenderer.invoke('attachment:readBytes', relPath),
  /** Önbellekteki önizleme → { ok, dataUrl } | { ok:false, reason:'miss'|'missing' } */
  preview: (relPath, width) => ipcRenderer.invoke('attachment:preview', relPath, width),
  /** Renderer'ın ürettiği WebP önizlemeyi önbelleğe yaz. */
  savePreview: (relPath, width, data) => ipcRenderer.invoke('attachment:savePreview', relPath, width, data),
  /** Baytları diskten sil (satırın tombstone'u ÇAĞIRANIN işi). */
  removeBytes: (relPath) => ipcRenderer.invoke('attachment:removeBytes', relPath),
  // ATTACH-CLOUD-01 — buluta yükleme döngüsünün renderer ucu (WebP kodlama burada).
  /** → { ok, items:[{relPath, companyId, sha256, mime, bytes}] } | { ok:false, reason } */
  cloudPending: (opts) => ipcRenderer.invoke('attachment:cloudPending', opts || {}),
  /** { relPath, companyId, sha256, data } → { ok, storagePath, existed } | { ok:false, reason } */
  cloudUpload: (req) => ipcRenderer.invoke('attachment:cloudUpload', req || {}),
  /** Yeni ek alındı → döngü turu. Dinleyiciyi söken fonksiyon döner. */
  onCloudKick: (cb) => {
    const h = () => { try { cb(); } catch { /* dinleyici hatası köprüyü düşürmez */ } };
    ipcRenderer.on('attachment:cloudKick', h);
    return () => ipcRenderer.removeListener('attachment:cloudKick', h);
  },
});

// FDBK-01 — UYGULAMA İÇİ GERİ BİLDİRİM köprüsü (salt-okunur, üç uç).
// Renderer'a fs AÇILMAZ: log kesiti MASKELENMİŞ metin, çekimler data-URI olarak
// gelir. Kaydın kendisini (INSERT) renderer supabase istemcisiyle yazar.
contextBridge.exposeInMainWorld('feedbackApi', {
  /** → { ok, text, lines } | { ok:false, reason:'no-log'|'unreadable' } */
  logExcerpt: (opts) => ipcRenderer.invoke('feedback:logExcerpt', opts || {}),
  /** → { ok, shots:[{name, at, bytes, thumbDataUrl}] } | { ok:false, reason:'no-dir' } */
  recentShots: (opts) => ipcRenderer.invoke('feedback:recentShots', opts || {}),
  /** → { ok, name, dataUrl, sha256, width, height } | { ok:false, reason } */
  shotPreview: (opts) => ipcRenderer.invoke('feedback:shotPreview', opts || {}),
});

// ADP-736 — YEREL sprite kütüphanesi köprüsü. Pakete tek/güvenli set girer; kişisel
// (telifli olabilen) avatarlar `~/.agentspace/sprites/<key>/48x48.png`ten OKUNUR —
// uygulama silinip yeniden kurulsa bile kalırlar ve DMG'ye hiç girmezler.
// Salt-okunur tek kanal: main tarafı key'i doğrular, PNG imzasını kontrol eder ve
// data-URI döner (renderer'a fs açılmaz).
contextBridge.exposeInMainWorld('localSpriteApi', {
  /** → { ok, dir, sprites:[{key,url48,url16,bytes}] } */
  list: () => ipcRenderer.invoke('sprites:listLocal'),

  /**
   * AVATAR-PACK-01 — Yüklü PAKETLER (manifest + lisans + karakterler + eksikler).
   * `list` ile aynı diski okur ama başka soruyu yanıtlar: `list` "hangi sprite
   * anahtarları çizilebilir", bu ise "hangi paket kurulu ve neyi vaat ediyor".
   * → { ok, dir, packages:[{key,manifest,characters,missing}], skipped }
   */
  listPackages: () => ipcRenderer.invoke('sprites:listPackages'),

  /** ADP-737 — Paket yükle (zip dosyası). → { ok, key?, manifest?, warnings?, error? } */
  installPackage: (zipPath) => ipcRenderer.invoke('sprites:installPackage', zipPath),

  /** ADP-737 — Paketi kaldır (key). → { ok, error? } */
  removePackage: (key) => ipcRenderer.invoke('sprites:removePackage', key),

  /** ADP-737 — Paketi dışa aktar (karakterleri zip'le). → { ok, path?, error? } */
  exportPackage: (keys) => ipcRenderer.invoke('sprites:exportPackage', keys),
});

// STARTER-OFFICE-01 — OFİS PAKETİ köprüsü (.agentspace-office.zip).
// İki uç, ikisi de DAR: `exportPack` renderer'ın ÜRETTİĞİ+TEMİZLEDİĞİ paket
// nesnesini diske yazar; `readPack` bir zip'i açıp manifest + skill gövdelerini
// döner. Kurulum bu köprüden GEÇMEZ — o iş renderer'da `installPreset`indir
// (kurulum sözleşmesinin ikinci bir kopyası doğmasın).
contextBridge.exposeInMainWorld('officePackApi', {
  /** → { ok, path, bytes, sha256 } | { ok:false, error } */
  exportPack: (pack, skills) => ipcRenderer.invoke('office:exportPack', { pack, skills }),
  /** → { ok, pack, skills:[{name,text,sha256,bytes}], warnings } | { ok:false, error } */
  readPack: (zipPath) => ipcRenderer.invoke('office:readPack', zipPath),
});

// TEAM-DELETE-01 — takım silmenin bu makinedeki yarısı (hafıza klasörü, raporlar, yedek zip).
// Sunucu yarısı delete_team RPC'sidir. Ana süreç kanalları yalnız ana pencereden kabul eder.
contextBridge.exposeInMainWorld('teamDeleteApi', {
  /** {agentIds, roster} → { ok, memoryAgents, memoryFiles, reports, workspace } */
  localPlan: (req) => ipcRenderer.invoke('team-delete:local-plan', req),
  /** {agentIds, roster, team, tasks, include:{memory,reports}} → { ok, path, bytes, counts } */
  backup: (req) => ipcRenderer.invoke('team-delete:backup', req),
  /** {agentIds, roster, memory, reports:'keep'|'archive'|'delete', teamSlug} → { ok, memory, reports, errors } */
  localApply: (req) => ipcRenderer.invoke('team-delete:local-apply', req),
  /** Yedek zip'ini Finder/Gezgin'de göster (yalnız yedek klasörünün içi). */
  showBackup: (file) => ipcRenderer.invoke('team-delete:show-backup', file),
});

// ADP-440 — screenshotApi kaldırıldı: ekran görüntüsü özelliği AgentShot'a
// taşındı (ayrı ürün). fileDropApi AŞAĞIDA KALIR — AgentShot panelinden pane'e
// native dosya sürüklemesi bu köprüyü kullanır.
// ADP-143 (ADR-008 Faz 2 fix) — drop-path bridge. Electron 32+ REMOVED `File.path`, so
// the tray's NATIVE file drag (webContents.startDrag) drops a File whose `.path` is now
// `undefined` → the old screenshotDrop native branch resolved to null → "tray görseli
// terminale eklenmiyor" (Murat). `webUtils.getPathForFile(file)` is the documented
// replacement: it returns the real on-disk path for an OS-originated File. Renderer-safe
// (webUtils is exposed to the preload), read-only, no fs surface leaked.
contextBridge.exposeInMainWorld('fileDropApi', {
  /** Resolve a dropped File's absolute on-disk path (replaces removed File.path). */
  getPathForFile: (file) => {
    try {
      return webUtils && typeof webUtils.getPathForFile === 'function'
        ? webUtils.getPathForFile(file)
        : '';
    } catch {
      return '';
    }
  },
});

// ADP-082 (ADR-006 Karar 1) — workspace file bridge for the embedded code editor.
// A minimal, whitelisted, root-guarded fs surface (main-side enforces the
// workspace-root boundary + size cap + symlink-escape rejection). The renderer
// stays sandboxed (no raw fs) — these three channels are the only file access.
contextBridge.exposeInMainWorld('fileApi', {
  /** Read a workspace file as UTF-8 → { ok, content, encoding, path } | { ok:false, reason }. */
  read: (p) => ipcRenderer.invoke('file:read', p),
  /** PERF-STALLPROBE-01 — size+mtime without reading content → { ok, exists, size?, mtimeMs? } | { ok:false, reason }. */
  stat: (p) => ipcRenderer.invoke('file:stat', p),
  /** Write UTF-8 content to a workspace file → { ok, bytes, path } | { ok:false, reason }. */
  write: (p, content) => ipcRenderer.invoke('file:write', { path: p, content }),
  /** List a workspace directory → { ok, dir, entries:[{name,path,type}] } | { ok:false, reason }. */
  list: (dir) => ipcRenderer.invoke('file:list', dir),
  /**
   * ADP-103 — open the OS directory picker; the chosen dir becomes a new active root
   * (the only way to browse outside the workspace) → { ok, root, name } | { ok:false, reason }.
   */
  openDialog: () => ipcRenderer.invoke('file:openDialog'),
  /**
   * ADP-108 — live-watch: grant the editor read access to a WATCHED pane's cwd and
   * learn that cwd (+ home + workspace root) so the renderer can rebase the relative
   * path the agent prints to the absolute file it wrote → { ok, cwd, home,
   * workspaceRoot } | { ok:false, reason }. Keyed to a main-spawned paneId (no path
   * is supplied by the renderer), so the ADP-103 sandbox model is preserved.
   */
  allowPaneRoot: (paneId) => ipcRenderer.invoke('file:allowPaneRoot', paneId),
  /**
   * ADP-109 — editor start-experience persistence (last-session + recent). SYNC get
   * (so the renderer reads it during mount without an async flash) + async set. Stored
   * in userData main-side because the embedded server's RANDOM per-launch port makes
   * the renderer origin (and thus localStorage) change on every restart.
   */
  getEditorState: () => ipcRenderer.sendSync('file:editorState:get'),
  setEditorState: (state) => ipcRenderer.invoke('file:editorState:set', state),
});

// EDITOR-HIFI-F2c — editörün "Belgeyi biçimlendir" komutu: projenin KENDİ Prettier'ı ana
// süreçte çalışır (renderer'a biçimlendirici yüklenmez). Yol main'de aynı sandbox'tan geçer.
contextBridge.exposeInMainWorld('formatApi', {
  /** Bu dosyanın projesinde Prettier var mı → { ok, available, version? } | { ok:false, reason }. */
  status: (p) => ipcRenderer.invoke('format:status', p),
  /** İçeriği biçimlendir (diske YAZMAZ) → { ok, text, changed } | { ok:false, reason, detail? }. */
  format: (p, content) => ipcRenderer.invoke('format:document', { path: p, content }),
});

// ADP-538 — worker-completion notify emit: delegasyon follow-loop'u (renderer)
// completion olayını main'e taşır, main notify-log'a legacy-uyumlu DONE/FAIL/
// TIMEOUT/REPORT satırı ekler (liderlerin Monitor tail'inin ateşlendiği dosya).
contextBridge.exposeInMainWorld('workerNotifyApi', {
  emit: (evt) => ipcRenderer.invoke('notify:workerEvent', evt),
});

// ADP-625 — SİSTEM DURUMU: ilk açılış doktorunun raporu (Ayarlar → Sistem Durumu).
// Salt-okunur teşhis; hiçbir sır geçmez (rapor e-posta/anahtar taşımaz, ham hata
// metni yalnız destek alanı `raw`da kalır ve UI onu göstermez).
contextBridge.exposeInMainWorld('agentspaceDoctor', {
  /** → { generatedAt, overall:'ok'|'warn'|'fail', checks:[{id,label,status,detail,…}] } */
  run: () => ipcRenderer.invoke('doctor:run'),
  /**
   * ADP-907 — yabancı kancanın yazılı olduğu AYAR DOSYASINI kullanıcının editöründe aç.
   * Yalnız AÇAR: uygulama o dosyaya ASLA yazmaz. Gönderilen yol main'de doktorun kendi
   * aday listesiyle doğrulanır (listede yoksa açılmaz) → rastgele dosya açtırılamaz.
   * → { ok:true, via:'editor'|'folder' } | { ok:false, reason }
   */
  openHookSettings: (filePath) => ipcRenderer.invoke('doctor:openHookSettings', filePath),
});

// ADP-597 — AI MOTORU HESABI: kurulu mu (ADP-463-B) + oturum açık mı, ve oturumu
// Ayarlar'dan aç/kapat. Kullanıcı terminale hiç dokunmaz.
//
// ⚠️ `check()` köprüsü ADP-463-F'den beri EKSİKTİ: main'de `engine:check` handler'ı
// vardı ama preload onu hiç expose etmemişti, dolayısıyla sihirbazın motor-kontrol
// adımı her zaman "atlandı" (unavailable) çiziyordu — sessiz ölü köprü. Aynı alan
// olduğu için burada birlikte bağlanıyor.
//
// GÜVENLİK: bu köprüden hiçbir SIR geçmez. Dışarı çıkanlar: durum alanları + bir
// OAuth authorize URL'i. `submitCode` TEK YÖNDÜR — kullanıcının tarayıcıdan aldığı
// kodu main'e iletir, karşılığında yalnız {ok} döner; kod hiçbir yere yazılmaz.
// ADP-694 — PANO KÖPRÜSÜ. `navigator.clipboard.writeText` Electron penceresi odakta
// değilken REDDEDİLİYOR (gerçek e2e'de ölçüldü: "Kopyala" sessizce hiçbir şey
// kopyalamıyordu). Masaüstü uygulamasında doğru yol main'in `clipboard` modülüdür.
// TEK YÖN: yalnız YAZMA açık — pano OKUMA ucu bilerek yok.
contextBridge.exposeInMainWorld('clipboardApi', {
  /** Düz metni panoya yaz → { ok } (main tarafında boy sınırlı). */
  write: (text) => ipcRenderer.invoke('clipboard:write', text),
  /**
   * ADP-894 — ODAKLI yüzeye YAPIŞTIR → { ok, kind }. Windows'ta Ctrl+V'yi xterm
   * `\x16` olarak yutuyor (ölçüldü) → yapıştırma hiç çalışmıyordu; macOS'ta
   * aynı işi Electron'un varsayılan Edit menüsü `webContents.paste()` ile
   * yapıyor. Bu uç o menü öğesinin ta kendisidir.
   *
   * ADP-925 — panoda GÖRÜNTÜ varsa (ve metin yoksa) main bir TESLİMAT DİREKTİFİ
   * döner; `paneId` verilirse motoruna göre karar verir:
   *   • `{ kind:'engine-keys', keys }` → çağıran bu baytı pane'e YAZAR; motor
   *     panoyu kendisi okur (ölçüldü: claude `\x16` → `[Image #1]`).
   *   • `{ kind:'image', path }`       → main görüntüyü temp PNG'ye yazdı;
   *     çağıran YOLU pane'e yapıştırır (kabuk pane'leri).
   *   • `{ kind:'text' }`              → metin yolu main'de zaten koştu.
   *
   * GÜVENLİK: pano İÇERİĞİ renderer'a GEÇMEZ — metinde main yalnız yerel
   * "yapıştır" komutunu çalıştırır; görüntüde geçen şey ya sabit bir kontrol
   * baytı ya da temp dosya YOLUdur. "Okuma ucu yok" duruşu (yukarıda) korunur.
   */
  pasteFocused: (opts) => ipcRenderer.invoke('clipboard:pasteFocused', opts),
});

// ADP-935 — PANO GEÇMİŞİ KÖPRÜSÜ. Yukarıdaki "pano OKUMA ucu YOK" duruşunun
// bilinçli ve DAR bir istisnası: renderer hâlâ SİSTEM panosunu okuyamaz — yalnız
// main'in KENDİ tuttuğu, gizlilik kapısından geçmiş geçmişi okur. `list` tam metin
// DEĞİL önizleme döndürür; tam metin yalnız kullanıcı bir öğeyi TIKLADIĞINDA
// (`deliver`) ve yalnız o öğe için geçer.
contextBridge.exposeInMainWorld('clipApi', {
  /** → { ok, items:[{id,kind,at,preview,chars,width,height,bytes,thumb}] } (en yeni başta). */
  list: () => ipcRenderer.invoke('clip:list'),
  /**
   * Öğeyi panoya geri koy + pane'e nasıl ineceğini söyle → aynı sözleşme
   * `clipboard:pasteFocused` ile (ADP-925):
   *   • `{ kind:'text', text }`        → çağıran metni pane'e YAPIŞTIRIR (Enter YOK)
   *   • `{ kind:'engine-keys', keys }` → çağıran kontrol baytını yazar, motor panoyu okur
   *   • `{ kind:'image', path }`       → çağıran temp PNG YOLUnu yapıştırır (kabuk pane'i)
   */
  deliver: (itemId, paneId) => ipcRenderer.invoke('clip:deliver', { itemId, paneId }),
  /** Tek öğeyi geçmişten sil → { ok }. */
  remove: (itemId) => ipcRenderer.invoke('clip:remove', itemId),
  /** Geçmişin tamamını sil → { ok, removed }. */
  clear: () => ipcRenderer.invoke('clip:clear'),
  /** Geçmiş değişti (yeni kopya / silme). Aboneliği bırakan fonksiyon döner. */
  onChanged: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('clip:changed', listener);
    return () => ipcRenderer.removeListener('clip:changed', listener);
  },
});

contextBridge.exposeInMainWorld('engineApi', {
  /**
   * ADP-463-B — CLI kurulu mu → { engines:[{id,name,found,state,path,installUrl}], anyFound, anyUnknown }.
   * ADP-833 (ADR-W7): `state` üç-durumlu ('present'|'absent'|'unknown'); 'unknown' =
   * ölçemedik (UI onu "kurulu değil" diye GÖSTERMEZ).
   */
  check: () => ipcRenderer.invoke('engine:check'),
  /**
   * ENG-10 — motor YETENEK MATRİSİ: { ok, engines: { <id>: { engine, label, matrix } } }.
   * Ayarlar motor kartı ve entegrasyon hub'ı rozetlerini bundan çizer (pane açmadan).
   * Sır/dosya yolu DÖNMEZ — yalnız hüküm + motorun kendi beyan metni.
   */
  capabilityMatrix: () => ipcRenderer.invoke('engine:capabilityMatrix'),
  /**
   * ENG-19 — LİDER-UYGUNLUK + otomatik öneri:
   * { ok, engines:{<id>:{class:'full'|'fallback'|'never', auth, eligible, gaps, blockers, requirements}},
   *   order, recommended, recommendedClass, warning }
   * Hüküm descriptor'dan TÜRETİLİR (motor adına bakılmaz); giriş motorun KENDİ
   * durum komutundan okunur. Sır DÖNMEZ.
   */
  leadership: () => ipcRenderer.invoke('engine:leadership'),
  /**
   * ENG-21 — SUNULABİLİRLİK + DELEGASYON VATANDAŞLIĞI:
   * { ok, engines:{<id>:{offered, delegation:{class,capable,badge,blockers,warnings}}} }
   * `offered` = ENG-05 `engines.enabled` hükmünün ürünle gelen aynası (renderer
   * tabloyu okuyabilirse üstüne yazar). `delegation` = ENG-17 hükmü. Sır DÖNMEZ.
   */
  availability: () => ipcRenderer.invoke('engine:availability'),
  /** → { engines:[{engine,label,installed,loggedIn,method,account,plan,needsCode,error}] }. */
  authStatus: () => ipcRenderer.invoke('engineAuth:status'),
  /** Yönetilen giriş akışını başlatır (tarayıcıyı main açar) → { ok, session }. */
  login: (engine, profileId) => ipcRenderer.invoke('engineAuth:login', { engine, profileId }),
  /** Tarayıcı sayfasının verdiği kodu iletir (yalnız claude akışı) → { ok }. */
  submitCode: (code) => ipcRenderer.invoke('engineAuth:submitCode', { code }),
  /** Devam eden giriş akışını iptal eder → { ok }. */
  cancelLogin: () => ipcRenderer.invoke('engineAuth:cancel'),
  /** Oturumu kapatır; sonuç motorun kendi durum komutuyla DOĞRULANIR → { ok, status }. */
  logout: (engine, profileId) => ipcRenderer.invoke('engineAuth:logout', { engine, profileId }),

  // ── ENG-08 — API ANAHTARI YEDEĞİ (abonelik birinci sınıf, bu YEDEK yol) ────
  // Anahtar TEK YÖN akar: renderer → main → vault. Geri dönen yüzeyde sır YOKTUR
  // (yalnız `{ ok, error, status }`); `status.apiKeySaved` bir BAYRAKtır, değer değil.
  /** Motorun API anahtarını kaydeder ve motorun KENDİ komutuyla doğrular → { ok, error, status }. */
  setApiKey: (engine, key, profileId) => ipcRenderer.invoke('engineAuth:setApiKey', { engine, key, profileId }),
  /** Kayıtlı anahtarı siler → { ok, status }. */
  clearApiKey: (engine, profileId) => ipcRenderer.invoke('engineAuth:clearApiKey', { engine, profileId }),
  /** Akış ilerledikçe main'in ittiği anlık-görüntü. Dönen fn dinleyiciyi kaldırır. */
  onChanged: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('engineAuth:changed', handler);
    return () => ipcRenderer.removeListener('engineAuth:changed', handler);
  },

  // ── ADP-936 — HESAPLAR (çok-hesap geçişi) ──────────────────────────────────
  // Renderer YALNIZ profil KİMLİĞİ konuşur. Dizin yolu, Keychain yuvası ve jeton
  // bu köprüden HİÇ geçmez — çözüm main'de (electron/engineProfiles.cjs).
  /** → { ok, autoSwitchOnLimit, engines:[{engine,label,active,profiles:[…]}] }. */
  accounts: () => ipcRenderer.invoke('engineProfiles:list'),
  /** Yeni hesap kutusu açar → { ok, profileId }. Girişi çağıran `login` ile başlatır. */
  accountAdd: (engine, label) => ipcRenderer.invoke('engineProfiles:add', { engine, label }),
  /**
   * Aktif hesabı değiştirir → { ok, active, stalePanes }. Canlı pane'ler etkilenmez
   * (env başlangıçta okunur); ACCT-FIX-01 — `stalePanes` eski hesapla koşmaya devam
   * eden ajan pane'lerinin listesidir (paneId · agentId · label · profileId · limited).
   */
  accountSwitch: (engine, profileId) => ipcRenderer.invoke('engineProfiles:switch', { engine, profileId }),
  /**
   * ACCT-FIX-01 — seçilen pane'leri KAPATIP hedef hesapla, aynı oturumdan (`--resume`)
   * yeniden açar → { ok, results:[{paneId, ok, newPaneId, resumed}] }. Kullanıcı onayı
   * renderer'da alınır; bu köprü yol/dizin taşımaz, yalnız kimlikler.
   */
  accountRespawnPanes: (engine, profileId, paneIds) =>
    ipcRenderer.invoke('engineProfiles:respawnPanes', { engine, profileId, paneIds }),
  /** Hesabın kullanıcı etiketini yazar → { ok }. */
  accountLabel: (engine, profileId, label) => ipcRenderer.invoke('engineProfiles:setLabel', { engine, profileId, label }),
  /** Hesabı kaldırır (önce o profilde çıkış, sonra defter+dizin) → { ok, active }. */
  accountRemove: (engine, profileId) => ipcRenderer.invoke('engineProfiles:remove', { engine, profileId }),
  /** "Limitte otomatik geç" tercihi → { ok, autoSwitchOnLimit }. */
  setAutoSwitch: (enabled) => ipcRenderer.invoke('engineProfiles:setAutoSwitch', { enabled }),
  /** ACCT-SWITCH-02 — motor başına "limit dolunca": 'sor' | 'otomatik-gec' | 'kapali' → { ok, policy }. */
  setLimitPolicy: (engine, policy) => ipcRenderer.invoke('engineProfiles:setLimitPolicy', { engine, policy }),
  /** ACCT-SWITCH-02 — teklif kartında "Geç": pane'i hedef hesaba ŞİMDİ taşır → { ok, newPaneId, toName }. */
  confirmLimitSwitch: (paneId, profileId) => ipcRenderer.invoke('engineProfiles:confirmLimitSwitch', { paneId, profileId }),
  /** ACCT-SWITCH-02 — hafif hesap durumu (CLI çağrısı yok) → { ok, engines:{[engine]:{policy,active,accounts,panes}} }. */
  accountsState: () => ipcRenderer.invoke('engineProfiles:state'),
  // ── HATA-12 — AJANLARIN GÜNCEL MOTOR AYNASI ────────────────────────────────
  // Renderer `employees.engine`'i canlı okur; harita DEĞİŞTİĞİNDE main'e iter. Main
  // onu geri-yükleme defterinin yanına yazar ve bir sonraki açılışta pane'i ESKİ
  // motorla diriltmez (HATA-12'nin "yeniden başlatmak da kurtarmıyor" yarısı).
  /** `{agentId: motor}` → { ok, count }. Yalnız KAYITLI motorlar diske iner. */
  syncAgentEngines: (map) => ipcRenderer.invoke('agentEngines:sync', map),

  /** Hesap defteri değişince main iter (liste kendiliğinden tazelensin). */
  onAccountsChanged: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('engineProfiles:changed', handler);
    return () => ipcRenderer.removeListener('engineProfiles:changed', handler);
  },
});

// ADP-437 — office layout/floor/custom-asset persistence. Stored in userData
// main-side because the embedded server's RANDOM per-launch port makes the renderer
// origin (and thus localStorage) change on every restart — Edit-mode furniture saved
// to localStorage silently vanished on relaunch. SYNC get (read during mount, no
// async flash) + async set, same shape as fileApi's editorState pair.
contextBridge.exposeInMainWorld('officeStateApi', {
  get: () => ipcRenderer.sendSync('office:state:get'),
  set: (state) => ipcRenderer.invoke('office:state:set', state),
  /** ACCT-OFFICE-01 — 'account' (kayıt bu hesabın) | 'shared' (girişsiz/ortak kök). SYNC. */
  scope: () => ipcRenderer.sendSync('office:state:scope'),
  // OFC-MIG-01 — geçiş yedeği (hesap köküne atomik) + sonuç satırı main logu için.
  // BEYAZ LİSTE KAPIDIR ([[ref_preload_whitelist_is_a_gate]]): officeMigrationRunner bu üç adı arar.
  backupWrite: (json, fromVersion) => ipcRenderer.invoke('office:backup:write', { json, fromVersion }),
  backupRead: (file) => ipcRenderer.invoke('office:backup:read', { file }),
  migrationReport: (report) => ipcRenderer.send('office:migration:report', report),
});

// FDBK-F1 — geri bildirim bildiriminin FİLİGRANI ({ [kod]: updated_at }).
// officeStateApi ile AYNI gerekçe ve aynı şekil: rastgele per-launch port →
// origin her açılışta değişir → localStorage silinir. Filigran silinince zil,
// kullanıcının açık kayıtlarını HER açılışta yeniden duyururdu. SYNC get (zil
// mount'ta okur, async titreme olmasın) + async set.
contextBridge.exposeInMainWorld('feedbackSeenApi', {
  get: () => ipcRenderer.sendSync('feedback:seen:get'),
  set: (state) => ipcRenderer.invoke('feedback:seen:set', state),
});

// KRR-DRAFT-PERSIST-01 — karar taslakları (seçim + not). feedbackSeenApi ile AYNI gerekçe ve şekil:
// localStorage'daki taslak her açılışta (yeni port → yeni origin) kayboluyordu. SYNC get (rapor ve
// Kararlar sekmesi mount'ta okur) + async set. Kontrol kolu: AGENTSPACE_DECISION_DRAFTS_LEGACY=1 →
// köprü HİÇ açılmaz, renderer eski localStorage deposuna düşer (düzeltme öncesi davranış).
if (!perfFlag('AGENTSPACE_DECISION_DRAFTS_LEGACY', false)) {
  contextBridge.exposeInMainWorld('decisionDraftsApi', {
    get: () => ipcRenderer.sendSync('decision:drafts:get'),
    set: (state) => ipcRenderer.invoke('decision:drafts:set', state),
  });
}

// RENDERER-STATE-01 — renderer'ın kişisel durumu için adlı kalıcı depo (hesap kökü
// `renderer-state/<ad>.json`, ad beyaz listesi main'de). feedbackSeenApi ile AYNI gerekçe:
// localStorage her açılışta (yeni port → yeni origin) boşalıyordu. SYNC get (modül yüklenirken
// okuyanlar var: Tek Ofis, birleşik çizim) + async set + öbür pencerenin yazım duyurusu.
// Kontrol kolu: AGENTSPACE_RENDERER_STATE_LEGACY=1 → köprü HİÇ açılmaz, renderer eski
// localStorage yoluna düşer (düzeltme öncesi davranış).
if (!perfFlag('AGENTSPACE_RENDERER_STATE_LEGACY', false)) {
  contextBridge.exposeInMainWorld('rendererStateApi', {
    get: (name) => ipcRenderer.sendSync('renderer-state:get', name),
    set: (name, value) => ipcRenderer.invoke('renderer-state:set', name, value),
    onChanged: (cb) => {
      const handler = (_e, payload) => { try { cb(payload); } catch { /* dinleyici hatası köprüyü düşürmez */ } };
      ipcRenderer.on('renderer-state:changed', handler);
      return () => ipcRenderer.removeListener('renderer-state:changed', handler);
    },
  });
}

// ADP-206 — editor code-intelligence: git diff (committed vs working tree) + workspace
// file list (⌘P quick-open) + content grep (⌘⇧F). Read-only; main shells out to `git`.
// EDITOR-HIFI-F2d — kod editörünün ajan bağı: hangi ajan hangi dosyaya yazdı (main defteri:
// pty beslemesi + git). `list()` → { ok, files:[{ path, alsoPath, agentId, paneId, taskCode,
// lastWriteAt, eventAt, plus, minus }] }; `onChanged(cb)` aynı listeyi değişince verir.
// 🔴 Köprü yoksa editör noktasız/şeritsiz çizer (kontrol kolu) — yedek yol yok.
contextBridge.exposeInMainWorld('agentFilesApi', {
  list: () => ipcRenderer.invoke('agentFiles:list'),
  onChanged: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('agentFiles:changed', listener);
    return () => ipcRenderer.removeListener('agentFiles:changed', listener);
  },
});

contextBridge.exposeInMainWorld('codeIntelApi', {
  /** Diff one file vs HEAD → { ok, tracked, relPath, committedText, added, modified, removed, summary }. */
  diff: (filePath) => ipcRenderer.invoke('git:diff', filePath),
  /** Files in the active workspace (scoped to its git repo) → { ok, files:[path…] }.
   *  `root` (TASK-MQTIVZSDYPNRH) = the editor's active file/folder; main scopes to it. */
  listFiles: (root) => ipcRenderer.invoke('workspace:listFiles', root),
  /** Literal case-insensitive content search in the active workspace → { ok, hits:[{file,
   *  line, text}], truncated }. `root` scopes the search (active file/folder). */
  grep: (query, root) => ipcRenderer.invoke('workspace:grep', { query, root }),
  /** ADP-402 — pane header git-branch rozeti: cwd → saran repo'nun branch'i
   *  ({ ok, branch: string|null }; git değilse/root dışıysa branch yok). */
  // B-02 — `opts.force` TTL cache'ini atlar: görev değişimi / attach / merge
  // sonrası rozet 5 saniye bayat kalmasın (poll YOK, yalnız olay).
  branch: (cwd, opts) => ipcRenderer.invoke('git:branch', cwd, opts),
  /** EDITOR-HIFI-F1b — ağacın git renkleri: kök → { ok, repo, files:{ 'kök-göreli/yol': 'M'|'U'|'D'|'A' },
   *  total, truncated }. `opts.watch` = kökü izle; değişince onStatusChanged ≤2 sn içinde haber verir. */
  status: (root, opts) => ipcRenderer.invoke('git:status', root, opts),
  /** EDITOR-HIFI-F1b — bu pencerenin kök izleyicisini kapat (ağaç kapandı / editör söküldü). */
  unwatchStatus: () => ipcRenderer.invoke('git:status:unwatch'),
  /** EDITOR-HIFI-F1b — izlenen kökte git durumu değişmiş olabilir → cb({ root }). Dönüş: abonelikten çık. */
  onStatusChanged: (cb) => {
    const l = (_e, p) => { try { cb(p); } catch { /* dinleyici hatası köprüyü düşürmez */ } };
    ipcRenderer.on('git:status:changed', l);
    return () => ipcRenderer.removeListener('git:status:changed', l);
  },
  /** EDITOR-HIFI-F2b — proje araması: { query, caseSensitive, wholeWord, regex, root } →
   *  { ok, searchId, engine, hits:[{ file, line, text, matches:[{col,len}], clipped }], truncated, partial, ms, reason? } */
  search: (opts) => ipcRenderer.invoke('workspace:search', opts),
  /** EDITOR-HIFI-F2b — son aramanın "sonra" metinleri: { searchId, replacement } → { ok, reps:[[metin…]…] } */
  replacePreview: (searchId, replacement) => ipcRenderer.invoke('workspace:replacePreview', { searchId, replacement }),
  /** EDITOR-HIFI-F2b — onay öncesi: { ok, files:[{ file, ageMs, changed, writable }] } */
  replaceCheck: (searchId) => ipcRenderer.invoke('workspace:replaceCheck', { searchId }),
  /** EDITOR-HIFI-F2b — yalnız gösterilen satırlarda değiştir (ana süreç yazar, yedekler):
   *  → { ok, opId, replaced, files:[{file,count}], skipped:[{file,reason}] } */
  replaceApply: (searchId, replacement, files) => ipcRenderer.invoke('workspace:replaceApply', { searchId, replacement, files }),
  /** EDITOR-HIFI-F2b — tek adımda geri al → { ok, restored:[file…], skipped:[{file,reason}] } */
  replaceUndo: (opId) => ipcRenderer.invoke('workspace:replaceUndo', { opId }),
  /** EDITOR-HIFI-F2b — Değişiklikler paneli: { ok, repo, top, branch, files:[{ file, code, add, del, dir }], total, truncated } */
  changes: (root) => ipcRenderer.invoke('git:changes', root),
});

// ADP-050 (ADR-004 §A1) — delegation bridge renderer side. Main forwards a
// loopback-HTTP delegate/status request here over IPC; the renderer handler
// (delegationBridgeClient) calls the EXISTING window.agentdeskDelegation engine
// and sends the result back, correlated by requestId. Whitelisted channels only.
contextBridge.exposeInMainWorld('delegationBridge', {
  /** Subscribe to delegate requests from main. cb gets { requestId, objective, leaderId, department, workers? }. */
  onStart: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('delegation:start', l);
    return () => ipcRenderer.removeListener('delegation:start', l);
  },
  /** Reply to a delegate request: { requestId, ok, delegationId?, error? }. */
  startResult: (res) => ipcRenderer.send('delegation:start:result', res),
  /** Subscribe to status requests from main. cb gets { requestId, id? }. */
  onStatus: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('delegation:status', l);
    return () => ipcRenderer.removeListener('delegation:status', l);
  },
  /** Reply to a status request: { requestId, ok, snapshot }. */
  statusResult: (res) => ipcRenderer.send('delegation:status:result', res),
  // ADP-242 — sprint kanalları (MCP agentdesk_sprint → bridge → renderer orkestratörü).
  /** Subscribe to sprint-start requests. cb gets { requestId, objective, leaderId, department, tasks, maxConcurrent? }. */
  onSprintStart: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('sprint:start', l);
    return () => ipcRenderer.removeListener('sprint:start', l);
  },
  /** Reply: { requestId, ok, sprintId?, error? }. */
  sprintStartResult: (res) => ipcRenderer.send('sprint:start:result', res),
  /** Subscribe to sprint-status requests. cb gets { requestId, id? }. */
  onSprintStatus: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('sprint:status', l);
    return () => ipcRenderer.removeListener('sprint:status', l);
  },
  /** Reply: { requestId, ok, status }. */
  sprintStatusResult: (res) => ipcRenderer.send('sprint:status:result', res),
  // TEAM-COMPOSE-ROLE-01 — kapsam kapısından ÖNCE takım adı → kanonik slug (renderer'ın takım tablosu).
  /** Subscribe to team-name resolve requests. cb gets { requestId, department }. */
  onTeamsResolve: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('teams:resolve', l);
    return () => ipcRenderer.removeListener('teams:resolve', l);
  },
  /** Reply: { requestId, ok, scope? } | { requestId, ok:false, reason, message? }. */
  teamsResolveResult: (res) => ipcRenderer.send('teams:resolve:result', res),
  // DF-03 — sprint durdurma kanalı (agentspace_sprint action:"stop").
  /** Subscribe to sprint-stop requests. cb gets { requestId, id?, reason? }. */
  onSprintStop: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('sprint:stop', l);
    return () => ipcRenderer.removeListener('sprint:stop', l);
  },
  /** Reply: { requestId, ok, sprintId?, summary?, wasLive?, error? }. */
  sprintStopResult: (res) => ipcRenderer.send('sprint:stop:result', res),
});

// ── TC-01 — TAKIM KURUCU KÖPRÜSÜ ────────────────────────────────────────────
// Sözleşme: docs/design/TEAM-COMPOSER-R1/IPC-CONTRACT.md §3
//
// 🔴 BEYAZ LİSTE KAPIDIR. Aşağıdaki satırlar olmadan özellik SESSİZCE ÖLÜR:
// main kanala yazar, renderer hiçbir şey duymaz, kullanıcı hata da GÖREMEZ
// ([[ref_preload_whitelist_is_a_gate]]). Kanal adları sözleşmede donmuştur.
contextBridge.exposeInMainWorld('composeBridge', {
  // — main → renderer TURLARI (köprü: MCP aracı → main → burası) —
  /** Satır kurma isteği. cb: { requestId, objective, roles, mode, teamName, department, leaderId, maxEmployees, rejectedRoles }. */
  onPropose: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('team-compose:propose', l);
    return () => ipcRenderer.removeListener('team-compose:propose', l);
  },
  /** Cevap: { requestId, ok, teamName?, rows?, targetTeamId?, catalogSlugs?, error? }. */
  proposeResult: (res) => ipcRenderer.send('team-compose:propose:result', res),
  /** Kurulum isteği. cb: { requestId, proposalId, mode, teamName, rows, targetTeamId }. */
  onApply: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('team-compose:apply', l);
    return () => ipcRenderer.removeListener('team-compose:apply', l);
  },
  /** Cevap: { requestId, ok, teamId?, createdTeam?, employeeIds?, names?, … }. */
  applyResult: (res) => ipcRenderer.send('team-compose:apply:result', res),
  /** Geri alma isteği. cb: { requestId, teamId, createdTeam, employeeIds }. */
  onUndo: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('team-compose:undo', l);
    return () => ipcRenderer.removeListener('team-compose:undo', l);
  },
  /** Cevap: { requestId, ok, removedEmployees, removedTeam, error? }. */
  undoResult: (res) => ipcRenderer.send('team-compose:undo:result', res),

  // — KART YÜZEYİ (TC-02 bunları kullanır) —
  /** Onay kartı olayı. cb: { proposalId, mode, teamName, rows, expiresAt, planNote, source, autonomy }. */
  onProposal: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('team-compose:proposal', l);
    return () => ipcRenderer.removeListener('team-compose:proposal', l);
  },
  /** Kurulum sonrası şerit olayı. cb: { proposalId, teamName, names, wingSlug, undoExpiresAt }. */
  onApplied: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('team-compose:applied', l);
    return () => ipcRenderer.removeListener('team-compose:applied', l);
  },
  /**
   * Kullanıcının kararı → main. { proposalId, decision:'approve'|'reject', teamName?, rows?, mode?, catalogSlugs? }
   * Dönen `approvalToken` MAIN'de doğar; kart onu üretemez.
   */
  decide: (req) => ipcRenderer.invoke('team-compose:decision', req),
  /** Ayar kademesi (§9.7): { ok, autonomy:'ask'|'small-auto'|'auto' }. */
  autonomy: () => ipcRenderer.invoke('team-compose:autonomy'),
  /**
   * TC-02 — KULLANICININ şeritten geri alması. §3.6 bunu yalnız main→renderer
   * yönünde tanımlıyordu; şeridin düğmesi ters yönü ister. → { ok, error? }
   */
  undoRequest: (proposalId) => ipcRenderer.invoke('team-compose:undo-request', { proposalId }),
  /**
   * ENGINE-BULK-01 — patronun "Motoru değiştir"i (ofis kanadı başlığı). Main TC-07
   * önerisini açar; onay kartı `team-compose:proposal` olayıyla gelir.
   * { department, engine, leaderId?, leaderIds? } → { ok, proposalId?, rows?, code?, reason? }
   * ENGINE-BULK-ALL-01 — department '*' = "Tüm ofisler" (leaderIds: yerinde kalan liderler).
   */
  engineSwitch: (req) => ipcRenderer.invoke('team-compose:engine-switch', req),
});

// ADP-136 — team window auto-switch. The delegate path asks main to bring the
// target team's tmux window forward so the operator SEES the work start. Returns a
// typed best-effort result ({ ok, target?, reason? }); never throws.
contextBridge.exposeInMainWorld('windowApi', {
  /** Switch the tmux session's active window to the team that owns `department`. */
  selectForDepartment: (department) => ipcRenderer.invoke('tmux:selectWindow', department),
});

// ADP-139 (DOGFOOD Engel #2) — self-host dev affordances. `info()` lets the
// renderer show the right control (HMR badge in dev vs a one-click Rebuild button
// in prod-from-source). `rebuildRelaunch()` runs the FIXED build script in main and
// relaunches the app; `onRebuildProgress` streams its log lines for a spinner.
contextBridge.exposeInMainWorld('appApi', {
  /** → { mode:'dev'|'prod'|'spike', packaged, rebuildSupported }. */
  info: () => ipcRenderer.invoke('app:info'),
  /** One-click rebuild (electron:build:prep) + relaunch. → { ok, started } | { ok:false, reason }. */
  rebuildRelaunch: () => ipcRenderer.invoke('app:rebuildRelaunch'),
  /** ADP-232 — plain relaunch (NO rebuild) to apply restart-gated settings (workspaceRoot). → { ok }. */
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  /** Subscribe to rebuild progress. cb gets { phase:'start'|'log'|'done'|'error', line }. Returns unsubscribe. */
  onRebuildProgress: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('app:rebuild:progress', l);
    return () => ipcRenderer.removeListener('app:rebuild:progress', l);
  },
  /** ADP-284 — pencere görünürlüğü (minimize/hide → false). Canvas render kapıları için; returns unsubscribe. */
  onWindowVisible: (cb) => {
    const l = (_e, visible) => cb(!!visible);
    ipcRenderer.on('app:window-visible', l);
    return () => ipcRenderer.removeListener('app:window-visible', l);
  },
  /**
   * ADP-901 — RENDERER MODÜL HATASI → uygulama günlüğü + bildirim merkezi.
   * ADP-335 sınırı yalnız MAIN'deki modülleri kapsıyordu; ofis tuvali öldüğünde
   * (GL bağlam kaybı) uygulamanın gününde TEK BİR İZ kalmıyordu — teşhis, olayın
   * kendisinden değil ekran görüntüsünden başlamak zorunda kaldı. Artık renderer
   * de aynı deftere yazar. `{ label, message, location?, stopped? }`.
   */
  reportFault: (fault) => ipcRenderer.invoke('module:reportRenderer', fault),
  /**
   * OBS-01 — ÜRÜN ANALİTİĞİ: "hangi panel/sekme kullanılıyor".
   * Gövde `{ event:'panel_view', panel:'<dock sekme kimliği>' }` ile SINIRLI —
   * main tarafı olay adını ve panel kimliğini kapalı kümeye indirir, ortak damgayı
   * (sürüm/platform/katman) kendisi ekler. Serbest metin taşıyan bir alan YOK.
   */
  track: (payload) => ipcRenderer.invoke('analytics:track', payload),
  // HATA-06 — kurtarma merdiveninin KABUK basamakları (sayfa-içi yol yetmediğinde).
  // Renderer PARAMETRE GEÇİREMEZ: yalnız kapalı bir eylem adı gönderir; hangi
  // pencerenin yenileneceğine/yaratılacağına main karar verir (capability modeli).
  officeRecover: (action) => ipcRenderer.invoke('office:recover', { action }),
});

// TOUR-02-A — "İlk 10 Dakika" görev günlüğünün KALICILIĞI.
// Köprü İKİ ham kaydı verir (yerel dosya + taşınabilir tercih projeksiyonu) ve
// birleşmiş kaydı geri alır: LWW kuralı renderer'da TEK yerde yaşar
// (src/app/lib/onboardingQuests.ts `mergeProgress`, birim testli). Burada
// taşınacak bir SIR yok — gövde yalnız madde numaraları, damgalar ve üç boolean.
contextBridge.exposeInMainWorld('onboardingApi', {
  /** → { ok, local: kayıt|null, portable: kayıt|null } */
  load: () => ipcRenderer.invoke('onboarding:load'),
  /** → { ok, local, portable, error } */
  save: (progress) => ipcRenderer.invoke('onboarding:save', progress),
  // TOUR-02-C — bağlamsal ipuçları AYNI köprüde, AYRI kayıt: "hangi ipucu
  // gösterildi" ile "hangi görev bitti" iki farklı şemadır ve tek dosyada
  // birleştirilseydi biri diğerinin bilinmeyen alanını düşürürdü.
  /** → { ok, local: kayıt|null, portable: kayıt|null } */
  loadTips: () => ipcRenderer.invoke('onboarding:tips:load'),
  /** → { ok, local, portable, error } */
  saveTips: (tips) => ipcRenderer.invoke('onboarding:tips:save', tips),
  /** ONB-EDGE-01 — mikrofon izni (yalnız okuma, istem açmaz) → { ok, status, platform }. */
  micStatus: () => ipcRenderer.invoke('onboarding:micStatus'),
});

// B-01 (GIT-BACKBONE-SPEC §2.10) — GÖREV ↔ BRANCH ↔ MERGE yüzeyi. B-02/B-03'ün
// kart UI'sı bunu tüketir. Renderer YALNIZ görev kimliği ve onay verir; branch adı,
// worktree yolu ve merge hedefi main'de görev kaydından türer (G-1) — bu köprüde
// bilerek "yol ver / dal ver" parametresi YOKTUR.
contextBridge.exposeInMainWorld('worktreeApi', {
  /** → { ok, worktrees:[{taskId, project, code, branch, path, baseCommit, owner, state, livePaneId}] } */
  list: () => ipcRenderer.invoke('worktree:list'),
  /**
   * İnceleme kartının verisi — HİÇBİR ŞEYİ DEĞİŞTİRMEZ.
   * → { ok, branch, target, commitCount, commits, files, diffStat, conflict, conflictFiles,
   *     secretScan:{ok,findings}, approval:{approver,auto,blocked,why}, preconditions }
   * `secretScan.findings` yalnız DOSYA + TÜR taşır; sırrın DEĞERİ asla dönmez (G-4).
   */
  review: (input) => ipcRenderer.invoke('worktree:review', input),
  /** Merge et. Kapılar burada TEKRAR koşar; `approvedBy:true` patron onayıdır. */
  merge: (input) => ipcRenderer.invoke('worktree:merge', input),
  /** Merge sonrası ağacı kaldır. Kirli ağaç yalnız `force:true` ile (patron onayı, G-9). */
  release: (input) => ipcRenderer.invoke('worktree:release', input),
  /** Temizlik taraması: kayıp/bayat kayıtlar + defter DIŞI yönetilen ağaçlar. */
  reap: () => ipcRenderer.invoke('worktree:reap'),
});

// PR-INCELEME-F1b — İNCELEME EKRANI (salt-okur). Özet çağrısı görev kimliği + kart
// kodu/projesi/metni alır (yalnız aday); dal, hedef ve depo main'de çözülür. Dosya ve
// kontrol çağrıları YALNIZ görev kimliği alır — dal adı ya da kontrol sonucu bu köprüden
// main'e gitmez. Sözleşme: electron/reviewDiff.cjs (summary/fileDiff/checks).
contextBridge.exposeInMainWorld('reviewApi', {
  /** { taskId, code?, project?, description?, target? } → summary (state: ready|empty|wrong-target|no-branch|no-target|no-repo) */
  summary: (input) => ipcRenderer.invoke('review:summary', input),
  /** { taskId, path } → { ok, path, status, original, modified, binary?, tooLarge? } */
  file: (input) => ipcRenderer.invoke('review:file', input),
  /** { taskId } → { ok, at, checks:[{id, state, value, record:{at, lines}}] } */
  checks: (input) => ipcRenderer.invoke('review:checks', input),
  // PR-INCELEME-F1a — panonun inceleme listesi; kontrol sonucu buradan GİRİLMEZ (ana süreç ölçer).
  /** { items:[{taskId, code?, status?, project?, description?}] } → { ok, at, ms, items:[{taskId, state, branch, head, target, ahead, files, plus, minus, checks}] } */
  list: (input) => ipcRenderer.invoke('review:list', input),
  // PR-INCELEME-F1c — kontrol/çakışma/sır sonucu buradan GİRİLMEZ; ana süreç her çağrıda yeniden ölçer.
  /** { taskId, agentId? } → { ok, live, agentId } — ajanın canlı pane'i var mı */
  agentPane: (input) => ipcRenderer.invoke('review:agentPane', input),
  /** { taskId, agentId?, code?, round, body, comments:[{path,line,kind,body}], mergeState } → { ok, delivery, text, head, base, nextRound, mergeState } */
  requestChanges: (input) => ipcRenderer.invoke('review:requestChanges', input),
  /** { taskId, prevHead, prevBase? } → { ok, samePatch, base:{from,to,moved,commits}, files:[{path,state}], newCommits } */
  rounds: (input) => ipcRenderer.invoke('review:rounds', input),
  /** { taskId, expectedHead?, setting? } → { ok, head, blocked, blockers, approval, checks, targetIsMain, ... } */
  mergePlan: (input) => ipcRenderer.invoke('review:mergePlan', input),
  /** { taskId, expectedHead, cleanup?, actor?, code?, title?, mergeState? } → { ok, mergedCommit, verified, cleanup, mergeState } | { ok:false, code, why } */
  merge: (input) => ipcRenderer.invoke('review:merge', input),
});

// GIT-BB-CLOUD-01 — AYARLAR → PROJELER: izolasyonun YEREL yarısı.
// Buluttaki `projects` satırını ekran kendisi yazar (takımın gördüğü ayar); burası
// spawn anında main'in BAKTIĞI yerdir (settings.projectIsolation + worktrees.json).
// Renderer yol DAYATAMAZ — repoPath'i main çözer ve yalnız GÖSTERMEK için döner.
contextBridge.exposeInMainWorld('projectConfigApi', {
  /** → { ok, workspaceRoot, projects:[{slug, isolation, defaultBranch, repoPath, repoSource}] } */
  get: (slugs) => ipcRenderer.invoke('project:config:get', { slugs }),
  /** { slug, isolation:'worktree'|'off', defaultBranch? } → { ok, persisted, branchSaved, repoPath, why } */
  set: (input) => ipcRenderer.invoke('project:config:set', input),
  // PROJ-REGISTRY-01 — proje = klasör kaydı. Renderer YOL GÖNDEREMEZ: klasörü işletim
  // sisteminin penceresinde kullanıcı seçer, main seçimi tek kullanımlık bilete bağlar.
  /** { name } → { ok, slug } — kısa ad TEK yerde (main) üretilir. */
  slugFor: (name) => ipcRenderer.invoke('project:slug', { name }),
  /** → { ok, folders:[{slug, path, state:'ok'|'missing'|'not-dir', git, branch}] } */
  // PROJECT-B1a — `{ department }` verilirse cevapta `teamProject` (Yeni pane menüsünün varsayılanı) + `root`.
  folders: (input) => ipcRenderer.invoke('project:folder:list', input && typeof input === 'object' ? { department: input.department } : undefined),
  /** Klasör penceresini aç → { ok, pickId, path (yalnız gösterim), name, suggestedSlug, git, branch } */
  pickFolder: () => ipcRenderer.invoke('project:folder:pick'),
  /** { slug, pickId } → { ok, slug, path, git, branch, changed, why } */
  assignFolder: (input) => ipcRenderer.invoke('project:folder:assign', input),
  // PROJECT-B1 — takımın varsayılan projesi (bu cihazdaki ayna). Yalnız takım anahtarı + kısa ad.
  /** { department, slug|null } → { ok, changed, why } */
  setTeamDefault: (input) =>
    ipcRenderer.invoke('project:team-default:set', {
      department: input && input.department,
      slug: input && (input.slug === null || typeof input.slug === 'string') ? input.slug : null,
      names: input && input.names && typeof input.names === 'object' ? input.names : undefined,
    }),
  // PROJECT-POLISH-01 (FB-MEM-05) — proje / çalışma alanı değişince eski projede kalan pane'ler.
  // Olay: { id, kind:'workspace'|'team', count, team, from:{slug,label}, to:{slug,label} }.
  // Yeniden açma yalnız olayın KİMLİĞİNİ taşır: hangi pane'in nereye açılacağını main kendi
  // kaydından bilir; renderer pane listesi ya da yol dayatamaz.
  onPaneDrift: (cb) => {
    const l = (_e, payload) => {
      try { cb(payload); } catch { /* dinleyicinin hatası köprüyü düşürmez */ }
    };
    ipcRenderer.on('panes:project-drift', l);
    return () => ipcRenderer.removeListener('panes:project-drift', l);
  },
  /** { id } → { ok, results:[{paneId, ok, skipped?:'busy'|'gone', newPaneId?}] } */
  reopenDriftPanes: (id) => ipcRenderer.invoke('panes:project-drift:reopen', { id: typeof id === 'string' ? id : '' }),
  /** { id } → { ok } — "Böyle kalsın": kayıt düşer, pane'lere dokunulmaz. */
  dismissDrift: (id) => ipcRenderer.invoke('panes:project-drift:dismiss', { id: typeof id === 'string' ? id : '' }),
});

// CIDX-1 — KOD İNDEKSİ (proje başına aç/kapa, VARSAYILAN KAPALI).
//
// Bu köprüden SIR GEÇMEZ ve geçmesi de gerekmez: `codebase-memory-mcp` %100 yereldir,
// bulut/API anahtarı istemez (CODE-INDEX-R1 §6) → integrationsApi'nin "kasa" yarısı
// burada YOKTUR, yalnız enjeksiyon yarısı vardır. Renderer bir YOL da dayatamaz (G-1):
// yalnız proje slug'ı gider; ikilinin ve deponun yolunu main çözer ve GÖSTERMEK için
// döndürür. Anahtar bir sonraki pane'den itibaren geçerlidir (MCP argv spawn anında
// bağlanır) — `set` bunu `restartHint` ile SÖYLER, sessizce bırakmaz.
contextBridge.exposeInMainWorld('codeIndexApi', {
  /**
   * → { ok, installed, binPath, binName, installUrl,
   *     projects:[{slug, repoPath, enabled, indexedSha, lastIndexedAt,
   *                state:'not-indexed'|'fresh'|'stale'|'unknown', staleFiles, indexing}] }
   * `state:'unknown'` "ölçemedim" demektir ve "taze" diye YUVARLANMAZ (CIDX-0 §4b).
   */
  list: (slugs) => ipcRenderer.invoke('codeIndex:list', { slugs }),
  /** { slug, enabled } → { ok, enabled, persisted, restartHint }. */
  set: (slug, enabled) => ipcRenderer.invoke('codeIndex:set', { slug, enabled }),
  /** Arka planda indeksle → { ok, started, repoPath } | { ok:false, why }. */
  index: (slug) => ipcRenderer.invoke('codeIndex:index', { slug }),
  /** İlerleme/bitiş: { slug, running, ok?, exitCode?, tail? }. */
  onProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('codeIndex:progress', handler);
    return () => ipcRenderer.removeListener('codeIndex:progress', handler);
  },
});

// ADP-203 — user Settings (~/.agentdesk/settings.json): workspace root, OpenAI key,
// push-to-talk key, wake-model path. `get` returns NO secret values (only hasOpenAiKey).
contextBridge.exposeInMainWorld('settingsApi', {
  /** → { ok, workspaceRoot, resolvedWorkspaceRoot, repoRoot, firstRunRequired, defaultWorkspaceDir, pushToTalkKey, pushToTalkKeys, wakeModelPath, hasOpenAiKey, mcpServers, theme }. */
  get: () => ipcRenderer.invoke('settings:get'),
  /** Merge-patch + persist. patch = { workspaceRoot?, apiKeys?:{openai?,…}, pushToTalkKey?, wakeModelPath?, mcpServers?, theme?, notifications?, engines?:{<id>:{vendorHosted:'allow'|'block'}} }. */
  set: (patch) => ipcRenderer.invoke('settings:set', patch),
  /**
   * WN-01 — açılış anlık görüntüsü (karşılama sırası). → { ok, previousVersion,
   * currentVersion, signals: { productTourDone, onboardingGuideDone, officeKeys[],
   * onboardingFile } | null }. Süreç başına sabit (main memo).
   */
  launchInfo: () => ipcRenderer.invoke('app:launchInfo'),
  /**
   * SKL-B3 — ürünün KENDİ API anahtarını (bugün: gemini) GERÇEKTEN sağlayıcıya sorar.
   * Renderer yalnız SERVİS ADINI verir; anahtar bu köprüden hiçbir yönde geçmez.
   * → { ok:true, source, status, count } | { ok:false, reason:'no-key'|'rejected'|
   *    'unreachable'|'unsupported', … }
   */
  verifyAppKey: (service) => ipcRenderer.invoke('appkey:verify', service),
  /**
   * ADP-232-C — ilk-açılış "çalışma alanı seç": { mode:'create'|'pick' }.
   * 'create' önerilen ~/AgentSpace'i oluşturur; 'pick' OS klasör dialog'u açar
   * (yol renderer'dan asla gelmez). → { ok, root, restartRequired } | { ok:false, reason }.
   */
  provisionWorkspace: (req) => ipcRenderer.invoke('workspace:provision', req),
  /**
   * ADP-232-B — CANLI çalışma alanı geçişi (yeniden başlatmadan). req:
   *   { mode:'pick' }    → OS klasör dialog'u (yol renderer'dan gelmez),
   *   { mode:'current' } → Ayarlar'ın settings.workspaceRoot'a yazdığı kökü canlı uygula,
   *   { root:'…' }       → doğrudan yol (Ayarlar input'u; settings:set ile aynı güven sınırı).
   * → { ok, root, previous, changed, grandfathered[] } | { ok:false, reason }.
   * Açık pane'ler/çalışan işler ESKİ kökte kalır; yeni işler yeni kökte açılır.
   */
  switchWorkspace: (req) => ipcRenderer.invoke('workspace:switch', req),
  /**
   * ADP-737 — TAKIM KAPSAMI KAPISI (renderer ucu). Delegasyon yolunda her worker'ın
   * KENDİ takımı için sorulur: hedef takım liderin takımı değilse main sahibe onay
   * kartı çıkarır ve cevabı bekler. Karar renderer'da ASLA verilmez — burada yalnız
   * sorulur (`{action:'delegate'|'manage', leaderId, targetScope}` → `{ok, code?, reason?}`).
   */
  authorizeTeamScope: (req) => ipcRenderer.invoke('teamScope:authorize', req),
  // TEAM-PERM-HINT-01 — şablon kurulumu: tek liderin lidersiz takımlara izni ({leaderId, scopes}).
  grantPresetLeaderScope: (req) => ipcRenderer.invoke('teamScope:grantPresetLeader', req),
  // TEAM-PERM-EXISTING-01 — mevcut ofis: açılışta bir kez sorulan izin kartı. Karar main'de;
  // renderer adayı bildirir ({companyId, leaderId, leaderLabel, ownScope, targets}) ve cevabı
  // iletir ({leaderId, yes}). İzin verilecek takımlar teklif anındaki kayıttan gelir.
  offerExistingTeamScope: (req) => ipcRenderer.invoke('teamScope:offerExisting', req),
  answerTeamScopeOffer: (req) => ipcRenderer.invoke('teamScope:answerOffer', req),
  /**
   * ADP-888 — ARAYÜZ DİLİ canlı değişince main push eder: cb({ locale, preference }).
   * Route değişmez, ağaç yeniden render olur → açık pane/terminal durumu KORUNUR.
   * Returns unsubscribe.
   */
  onLocaleChanged: (cb) => {
    const l = (_e, payload) => cb(payload || {});
    ipcRenderer.on('app:locale-changed', l);
    return () => ipcRenderer.removeListener('app:locale-changed', l);
  },
  /** ADP-232-B — kök CANLI değişince main push eder: cb({ root, previous, grandfathered[], at }). Returns unsubscribe. */
  onWorkspaceChanged: (cb) => {
    const l = (_e, payload) => cb(payload || {});
    ipcRenderer.on('workspace:changed', l);
    return () => ipcRenderer.removeListener('workspace:changed', l);
  },
});

// ADP-533/ADP-553 — güncelleme köprüsü. İndirme URL'i/parametresi renderer'dan ASLA
// gelmez (capability modeli). İki mod: 'updater' (imzalı build — uygulama içinde
// indir + kullanıcı onayıyla kur) ve 'notify' (Faz 1 fallback — tarayıcıda indir).
contextBridge.exposeInMainWorld('updateApi', {
  /** → { checked, updateAvailable, latestVersion, currentVersion, lastCheckedAt, autoCheck, dismissed, downloadUrl, mode, phase, progressPercent }. */
  get: () => ipcRenderer.invoke('update:get'),
  /** Manuel kontrol (Ayarlar "Şimdi kontrol et"; toggle'dan bağımsız koşar). → aynı durum nesnesi. */
  checkNow: () => ipcRenderer.invoke('update:checkNow'),
  /** updater modu: uygulama içinde indir (progress push'ları gelir); notify modu: tarayıcıda SABİT DMG URL'i. */
  download: () => ipcRenderer.invoke('update:download'),
  /** ADP-553 — İNDİRİLMİŞ güncellemeyi kullanıcı onayıyla kur (yeniden başlatır). phase!=='downloaded' → no-op. */
  install: () => ipcRenderer.invoke('update:install'),
  /** "Bu sürüm için sonra" — sürüm-bazlı kalıcı dismiss (settings.json). → durum. */
  dismiss: () => ipcRenderer.invoke('update:dismiss'),
  /** Main durum push'u (kontrol sonucu/dismiss) → rozet CANLI güncellenir. Returns unsubscribe. */
  onState: (cb) => {
    const l = (_e, s) => cb(s);
    ipcRenderer.on('update:state', l);
    return () => ipcRenderer.removeListener('update:state', l);
  },
});

// ADP-675 — uygulama-içi DUYURU köprüsü. Renderer yalnız duyuru ID'si gönderir;
// aksiyonun adresini MAIN kendi normalize kopyasından çözer ve https'i doğrular
// (updateApi ile aynı capability modeli — ele geçmiş renderer site açtıramaz).
contextBridge.exposeInMainWorld('announceApi', {
  /** → { checked, fromCache, lastCheckedAt, currentVersion, items:[{id,level,title,body,action,read,hidden,…}] }. */
  get: () => ipcRenderer.invoke('announce:get'),
  /** Feed'i şimdi çek (Ayarlar/geliştirici tetiği). → aynı durum nesnesi. */
  checkNow: () => ipcRenderer.invoke('announce:checkNow'),
  /** "Okudum" — KALICI (settings.json); bir daha şerit çıkmaz. → durum. */
  markRead: (id) => ipcRenderer.invoke('announce:markRead', id),
  /** Şeridin ✕'i — OTURUMLUK gizleme (diske yazılmaz, yeniden açılışta geri gelir). */
  hide: (id) => ipcRenderer.invoke('announce:hide', id),
  /** Aksiyon düğmesi: adresi MAIN çözer + https doğrular + shell.openExternal. */
  openAction: (id) => ipcRenderer.invoke('announce:openAction', id),
  /** Gövde içi link: main adresin O duyurunun gövdesinde GERÇEKTEN geçtiğini doğrular. */
  openLink: (id, url) => ipcRenderer.invoke('announce:openLink', id, url),
  /** Main durum push'u (yeni feed / okundu) → UI CANLI güncellenir. Returns unsubscribe. */
  onState: (cb) => {
    const l = (_e, s) => cb(s);
    ipcRenderer.on('announce:state', l);
    return () => ipcRenderer.removeListener('announce:state', l);
  },
});

// A-10 — uygulama-içi "Yenilikler" (changelog) köprüsü. Salt-okunur: renderer'dan
// main'e hiçbir ID/adres gitmez (announceApi'nin aksine aksiyon linki yok).
contextBridge.exposeInMainWorld('changelogApi', {
  /** → { checked, fromCache, lastCheckedAt, recentCount, recentWindowDays, items:[{date,category,version,product,url,tr,en}] }. */
  get: () => ipcRenderer.invoke('changelog:get'),
  /** Feed'i şimdi çek (geliştirici tetiği). → aynı durum nesnesi. */
  checkNow: () => ipcRenderer.invoke('changelog:checkNow'),
  /** Sürüm notu linki: main renderer'ın gönderdiği adresi KENDİ kayıt listesiyle doğrular. */
  openUrl: (url) => ipcRenderer.invoke('changelog:openUrl', url),
  /** Main durum push'u (periyodik tazeleme) → UI CANLI güncellenir. Returns unsubscribe. */
  onState: (cb) => {
    const l = (_e, s) => cb(s);
    ipcRenderer.on('changelog:state', l);
    return () => ipcRenderer.removeListener('changelog:state', l);
  },
});

// ADP-390 (ADR-027 / G9) — Muratify hesabı köprüsü (Ayarlar → Hesap).
// Bu köprüden SIR GEÇMEZ: access/refresh token ve lisans jetonu MAIN'de (safeStorage)
// kalır; renderer yalnız DURUMU görür (e-posta, lisans, seat, aktif ürünler). Giriş
// sistem tarayıcısında açılır — uygulama içinde gömülü login webview'i YASAK (RFC 8252).
contextBridge.exposeInMainWorld('muratifyApi', {
  /** → { ok, signedIn, email, licenseStatus:'none'|'fresh'|'grace'|'expired'|'invalid', seat, products[], requireSeat }. */
  get: () => ipcRenderer.invoke('muratify:get'),
  /** Sistem tarayıcısında PKCE girişini başlat → { ok, url }. */
  signIn: () => ipcRenderer.invoke('muratify:signIn'),
  /**
   * Hesaptan çık (sunucuda revoke + yerel oturum & lisans jetonu silinir).
   *
   * ADP-863 — SEÇENEKLER ARTIK KABLODA TAŞINIR (eskiden hiç iletilmiyordu, bu yüzden
   * `force` yolu arayüzden ERİŞİLEMEZDİ → çalışan pane varken çıkış SESSİZCE reddedilirdi):
   *   `{ probe:true }` → çıkmadan "ne kapanacak" sayıları + onay metni
   *   `{ force:true }` → kullanıcı onay diyaloğunu onayladı, çalışan pane'lere rağmen çık
   */
  signOut: (opts) => ipcRenderer.invoke('muratify:signOut', opts),
  /** Lisans jetonunu yeniden çek (ağ hatasında cached jeton KORUNUR — offline ≠ kilit). */
  refresh: () => ipcRenderer.invoke('muratify:refresh'),
  /**
   * SEC-01 — hesaba bağlı cihazlar → { ok, devices:[…], currentDeviceId }.
   * `currentDeviceId` listede "bu cihaz"ı işaretlemek için: kullanıcı oturduğu
   * makineyi yanlışlıkla çıkarmasın.
   */
  devices: () => ipcRenderer.invoke('muratify:devices'),
  /**
   * SEC-01 — cihazı hesaptan çıkar → { ok, device } | { ok:false, reason }.
   * Cihazdaki hiçbir veri silinmez; yalnız o kurulum yeni lisans jetonu alamaz.
   * Başarıda main lisansı kendiliğinden tazeler (ret çözüldüyse hemen düşsün).
   */
  revokeDevice: (deviceId) => ipcRenderer.invoke('muratify:deviceRevoke', deviceId),
  /**
   * SEC-02 — DİĞER CİHAZLARI BIRAK → { ok, released } | { ok:false, reason }.
   * `revokeDevice`ten AYRI: koltuğu boşaltır, cihazı hesapta BIRAKIR. Uyuyan ya
   * da çöken bir makine kirasını bırakamadığında kullanıcının kaçış kapısıdır.
   * Başarıda main lisansı kendiliğinden tazeler (ret çözüldüyse hemen düşsün).
   */
  releaseOtherDevices: () => ipcRenderer.invoke('muratify:deviceReleaseOthers'),
  /** ADP-646 — "Paket al": faturalandırma sayfasını SİSTEM TARAYICISINDA aç → { ok, url }. */
  openBilling: () => ipcRenderer.invoke('muratify:openBilling'),
  /**
   * ADP-719 — giriş dönüşü (agentspace://) DOĞRU uygulamaya mı geliyor?
   * → { ok, severity:'blocking'|'warn'|null, ownsDefault, conflicts:[{path,bundleId,name}], reason }
   * `{ repair:true }` şema sahipliğini bu uygulamaya geri alır (kullanıcı tıkı).
   */
  schemeHealth: (opts) => ipcRenderer.invoke('muratify:schemeHealth', opts),
  /**
   * LX-SAFESTORAGE-01 — bu makinede oturum SAKLANABİLİR Mİ?
   * → { ok, measured, available, backend, plaintext, canStore, reasonKey }
   * `canStore:false` ise giriş duvarı kullanıcıya SEBEBİNİ söyler (her açılışta
   * yeniden giriş isteneceğini). SIR TAŞIMAZ: yalnız arka ucun adı + hüküm.
   * `canStore:null` = ölçülemedi ("kapalı" DEĞİL — ADP-721).
   */
  secretBackend: () => ipcRenderer.invoke('muratify:secretBackend'),
  /**
   * ADP-719 — İKİNCİ GİRİŞ YOLU: deep-link dönmediyse tarayıcının adres
   * çubuğundaki dönüş bağlantısı elle verilir; deep-link ile AYNI yoldan işlenir.
   */
  pasteCallback: (url) => ipcRenderer.invoke('muratify:pasteCallback', url),
  /** Main durum değişince push eder (giriş/çıkış/jeton) → Ayarlar CANLI güncellenir. */
  onState: (cb) => {
    const l = (_e, s) => cb(s);
    ipcRenderer.on('muratify:state', l);
    return () => ipcRenderer.removeListener('muratify:state', l);
  },

  // ── RESET-03 — KURULUMU SIFIRLA ───────────────────────────────────────────
  //
  // 🔴 BEYAZ LİSTE KAPIDIR ([[ref_preload_whitelist_is_a_gate]]) — ve KAPININ
  // İKİ KATI VAR. İlk yazımda bu iki metot AYRI bir `window.resetApi` globaline
  // konmuştu: kanal adları doğruydu, main handler'ı vardı, kanal kapısı YEŞİLDİ
  // — ama RESET-02 köprüyü `window.muratifyApi` ÜZERİNDE arıyor
  // (`resetFlow.resetApiFrom(muratifyApi())`) ve bulamayınca "Gelişmiş" bölümünü
  // HİÇ ÇİZMİYOR. Yani özellik sessizce ölüyordu. Kanalın VAR olması yetmez;
  // KARŞI TARAFIN BAKTIĞI YERDE olması gerekir.
  //
  // KARAR BURADA VERİLMEZ. Onay sözcüğünü MAIN karşılaştırır (dil main'de
  // bilinir, renderer'a güvenilmez); bu köprü yalnız kullanıcının yazdığı metni
  // taşır. Yol/hedef alanları main'de DÜŞER (resetGate.sanitizeRequest).
  /**
   * KURU KOŞUM — hiçbir şey silinmez. `{ level }`
   * → { ok, level, bytesTotal:number|null, targets:[{kind,bytes,entries}],
   *     keeps:[{label}], warnings:[string], confirmWord, panes, terminals, agents }
   * `bytesTotal:null` = "hesaplanamadı" (0 DEĞİL).
   */
  resetPlan: (opts) => ipcRenderer.invoke('reset:plan', opts),
  /**
   * SIFIRLAMA İSTEĞİ — { level:'session'|'full', confirmText, keepLogs }.
   * → { ok:true, restarting:true } | { ok:false, reason:'bad_confirm'|'bad_level'|… }
   * Çalışan süreçte hiçbir kullanıcı dosyası silinmez: main işaretçi yazar ve
   * uygulama yeniden başlar; silme yeni sürecin EN BAŞINDA olur (Windows kilidi).
   */
  resetRequest: (req) => ipcRenderer.invoke('reset:request', req),
});

// ADP-660 — PLAN LİMİTİ köprüsü (nudge + Ayarlar özeti).
// Karar burada VERİLMEZ: `onLimit` main'in ZATEN reddettiği bir eylemi ve onun
// kullanıcı metnini taşır (ikinci bir "limit aşıldı mı" mantığı = iki gerçek).
// Bu köprü hiçbir şeyi ZORLAMAZ — dişler main'de (pty:spawn / integ:add / supervisor).
contextBridge.exposeInMainWorld('planApi', {
  /** → { ok, enforced, tier, tierLabel, fallback, features{agents,integrations,autopilot}, billingUrl }. */
  get: () => ipcRenderer.invoke('plan:get'),
  /**
   * BL-03 — "yükselttim, hâlâ kilitli mi?" → jetonu TAZELE + reddin KENDİ ölçüsünü
   * yeniden karara sok. → { ok, refreshed, allowed, tier, tierLabel, requiredTierLabel }.
   * Karar yine main'dedir (planLimits.decide); burası yalnız reddin (feature,current)
   * çiftini geri taşır — renderer ikinci bir tavan mantığı KURMAZ.
   */
  recheck: (feature, current) => ipcRenderer.invoke('plan:recheck', { feature, current }),
  /** Main bir eylemi plan limiti yüzünden reddettiğinde push eder (kapatılabilir nudge). */
  onLimit: (cb) => {
    const l = (_e, d) => cb(d);
    ipcRenderer.on('plan:limit', l);
    return () => ipcRenderer.removeListener('plan:limit', l);
  },
});

// PANE-CAP-01 — KAYNAK BEKÇİSİ köprüsü. Sabit pane tavanı (24/16) KALKTI; yerine
// ölçülen bellek baskısı geldi. Bu köprü hiçbir şeye KARAR VERMEZ: durumu okur,
// kullanıcının kararını (yine de aç / eşik / kapat / bitmiş pane'leri kapat) main'e
// taşır. Renderer'da ikinci bir "yeterli kaynak var mı" mantığı YOKTUR.
contextBridge.exposeInMainWorld('resourceApi', {
  /** → { ok, state } — state: { level, freePct, reasons, waiting[], settings, … }. */
  state: () => ipcRenderer.invoke('resource:state'),
  /** "Yine de aç": kullanıcı HER ZAMAN açabilir. Onay süre-kutulu (ms; boş → varsayılan). */
  allowAnyway: (ms) => ipcRenderer.invoke('resource:allowAnyway', ms),
  /** Ayarlar: { enabled?, warnFreePct?, criticalFreePct? } → { ok, state }. Diske yazılır. */
  configure: (patch) => ipcRenderer.invoke('resource:configure', patch),
  /** Bitmiş (terminal + >15 dk sessiz) pane'ler. `department` verilirse yalnız o takım. */
  finishedPanes: (opts) => ipcRenderer.invoke('resource:finishedPanes', opts || {}),
  /** ONAYLI kapatma — main her paneId'yi yeniden ölçer (canlanan pane öldürülmez). */
  closeFinished: (paneIds) => ipcRenderer.invoke('resource:closeFinished', { paneIds }),
  /** STRAY-PROC-01 — sahipsiz kalmış test/derleme koşucuları (yalnız liste). */
  strayProcesses: () => ipcRenderer.invoke('resource:strayProcesses'),
  /** STRAY-PROC-01 — ONAYLI tek kapatma; main pid'i yeniden ölçer (yeniden kullanılmış pid'e dokunmaz). */
  closeStray: (pid, startedAt) => ipcRenderer.invoke('resource:closeStray', { pid, startedAt }),
  /** Baskı seviyesi ya da bekleme kuyruğu değişince push. Dönen fonksiyon aboneliği bırakır. */
  onPressure: (cb) => {
    const l = (_e, state) => cb(state);
    ipcRenderer.on('resource:pressure', l);
    return () => ipcRenderer.removeListener('resource:pressure', l);
  },
});

// ADP-298 — Raporlar canlı yenileme: main rapor dizinlerini izler, değişince olay atar.
// Renderer poll ETMEZ; olayı yalnız sekme görünürken listeye çevirir (ADP-284 disiplini).
contextBridge.exposeInMainWorld('reportsApi', {
  /** cb: ({ at }) => void — abonelikten çıkmak için dönen fonksiyonu çağır. */
  onChanged: (cb) => {
    const l = (_e, payload) => cb(payload || { at: Date.now() });
    ipcRenderer.on('reports:changed', l);
    return () => ipcRenderer.removeListener('reports:changed', l);
  },
  /**
   * RPT5-01 — "rapor yazıldı": hangi rapor, hangi ajan, hüküm, okur, sürüm, tür
   * (new|version|writing). Yük sözleşmesi: electron/reportWrittenEvent.d.cts.
   * cb: (payload) => void — abonelikten çıkmak için dönen fonksiyonu çağır.
   */
  onWritten: (cb) => {
    const l = (_e, payload) => { if (payload && typeof payload === 'object') cb(payload); };
    ipcRenderer.on('report:written', l);
    return () => ipcRenderer.removeListener('report:written', l);
  },
  /**
   * RPT5-04 — `agentspace://rapor/<proje>/<kimlik>`. Main bekleyen bağlantıyı tutar; renderer
   * mount'ta ve `onOpenLink` dürtüsünde `takeOpenLink()` ile ÇEKER →
   * { project, id, filename, found } | null (tek tüketim).
   */
  takeOpenLink: () => ipcRenderer.invoke('reports:takeOpenLink'),
  onOpenLink: (cb) => {
    const l = () => cb();
    ipcRenderer.on('report:open-link', l);
    return () => ipcRenderer.removeListener('report:open-link', l);
  },
  /** Terminalde tıklanan bağlantı → main'in aynı ayrıştırıcısı → { ok }. */
  openLink: (url) => ipcRenderer.invoke('reports:openLink', url),
  /** "Bağlantıyı kopyala": bu kopyanın şemasıyla bağlantı → string | null. */
  linkFor: (project, filename) => ipcRenderer.invoke('reports:linkFor', { project, filename }),
  /**
   * REPORT-READ-WIDE-01 — "Tarayıcıda aç": { html, name } → main geçici dizine yazar (dış ağı kapalı
   * belge şartı, electron/reportBrowserCopy.cjs) ve varsayılan tarayıcıda açar → { ok, reason? }.
   */
  openCopy: (html, name) => ipcRenderer.invoke('reports:openCopy', { html, name }),
  /**
   * RPT-OPEN-INAPP-01 — "Tarayıcıda aç" yeni tarif: { filename, project?, target:'inapp'|'external',
   * html? } → main raporu kendi dizinlerinde çözer; iç tarayıcıda `agentspace-sayfa://` sekmesi açar
   * ya da kaynak dosyayı / kalıcı dışa aktarımı dış tarayıcıda açar → { ok, reason?, url? }.
   * `html` yalnız metin raporunda (okuyucunun çizdiği, dış ağı kapalı kopya).
   */
  openPage: (req) => ipcRenderer.invoke('reports:openPage', req),
  /** RPT-OPEN-INAPP-01 — "Bağlantıyı kopyala ▸": { rapor, sayfa, dosya } (olmayan biçim null). */
  pageLinks: (project, filename) => ipcRenderer.invoke('reports:pageLinks', { project, filename }),
  /**
   * REPORT-READER-01 — "PDF olarak kaydet": { filename, project?, html? } → main kaydetme penceresini
   * açar, raporu ağa kapalı gizli pencerede basar → { ok, path?, reason? } ('vazgecildi' = kullanıcı vazgeçti).
   */
  savePdf: (req) => ipcRenderer.invoke('reports:savePdf', req),
  /** REPORT-READER-01 — "Klasörde göster": { filename, project? } → raporun dosyası dosya yöneticisinde seçili. */
  showInFolder: (req) => ipcRenderer.invoke('reports:showInFolder', req),
  /**
   * RPT4-08 — rapor yorumunu ajana TEK satır ilet (KRR-04 haber yolu, main `decisionRelay.enqueue`).
   * n: { hedef, kimlik, metin, gorevleMetin?, parca:{status, taskCode, evidencePath} } →
   * { ok, key, yeni, sonuc, erteleme }.
   */
  forwardComment: (n) => ipcRenderer.invoke('report-comment:forward', n),
  /** RPT4-08 — iletilen yorum satırlarının son durumu: { [key]: { sonuc, erteleme } | null }. */
  commentStatus: (keys) => ipcRenderer.invoke('report-comment:status', keys),
  /**
   * RPT-SYNC-LIVE-01 — sayfa → Raporlar eşitleyicisi (main kendiliğinden koşturur): durum
   * { durum, sonKosum, yeni, yerel, hata } · "Şimdi eşitle" (bitince durum) · durum değişimi olayı.
   */
  pageSyncStatus: () => ipcRenderer.invoke('reports:pageSyncStatus'),
  pageSyncRun: () => ipcRenderer.invoke('reports:pageSyncRun'),
  onPageSyncStatus: (cb) => {
    const l = (_e, payload) => { if (payload && typeof payload === 'object') cb(payload); };
    ipcRenderer.on('reports:pageSyncStatus', l);
    return () => ipcRenderer.removeListener('reports:pageSyncStatus', l);
  },
});

// ADP-844 — bildirimler yalnız ekranda (zil + toast) ve mobil uygulamada yaşar;
// renderer'a dış mesajlaşma servisi açan HİÇBİR köprü yoktur.

// ADP-242 — uzun-sprint kalıcılığı: run durumu her transition'da main'e iner
// (sprintStore atomik yazar); rehydrate list+load ile başlar. Path'i main kurar.
// QUEUE-PERSIST — meşgul-kuyruğu + paused-delegasyon kalıcılığı (delegationRunner
// her kuyruk/pause değişiminde durumu main'e indirir; rehydrate boot'ta load eder).
contextBridge.exposeInMainWorld('delegationQueueApi', {
  /** { queued:[], paused:[] } → { ok, file?, error? }. */
  save: (state) => ipcRenderer.invoke('dlgqueue:save', state),
  /** → { ok, state: { queued:[], paused:[] } }. */
  load: () => ipcRenderer.invoke('dlgqueue:load'),
});

// DLG-11 — MAKİNE BÜTÇESİ: kabul anında ayar + (ağır iş için) tek atım sağlık okuması.
// SENKRON: dispatch kapısı (delegationRunner.startTeamDelegationEx) senkrondur.
contextBridge.exposeInMainWorld('machineBudgetApi', {
  /** ({health?: boolean, ownPaneIds?: string[]}) → { ok, config, health|null, foreign[] }. */
  check: (opts) => ipcRenderer.sendSync('machinebudget:check', opts || {}),
  /** RG-MODE-01 — ({mode?:'off'|'auto'|'strict', heavySlots?:number|null, cap?:number|null, otherMachine?:boolean}) → { ok, config }. Ayarlar → Kaynak koruması. */
  configure: (patch) => ipcRenderer.invoke('machinebudget:configure', patch || {}),
  /** QUEUE-NEVER-STUCK-01 — ayar dosyası/ayar değişti → kuyruk hemen yeniden denensin. */
  onChanged: (cb) => {
    const l = (_e, payload) => cb(payload);
    ipcRenderer.on('machinebudget:changed', l);
    return () => ipcRenderer.removeListener('machinebudget:changed', l);
  },
});

// SUP-UI-01 — KUYRUK PANELİ (salt-okur). Üç defter + canlı pane damgaları tek
// tabloda. Köprü YALNIZ okur: kuyruğun canlı sahibi renderer'daki delegationRunner
// olduğu için iptal/öne alma/duraklat oradadır — iki yazar = iki gerçek.
contextBridge.exposeInMainWorld('queueBoardApi', {
  /** → { ok, board: {waiting, inflight, done, warnings, counts}, sources }. */
  get: () => ipcRenderer.invoke('queueboard:get'),
});

// ADP-659 — DELEGASYON SUPERVISOR köprüsü. Renderer'ın motoru efemerdir (reload =
// tüm nöbetler ölür); bu kanal her dispatch'i MAIN'in kalıcı defterine yazar ve
// main'in "bu iş bitti, kuyruğu ilerlet" push'unu geri taşır. Köprü YOKSA
// (eski preload) renderer sessizce eski davranışa düşer — supervisor opsiyoneldir,
// asla dispatch'i bloklamaz.
contextBridge.exposeInMainWorld('delegationSupervisorApi', {
  /** Dispatch anında: alt-görevi main defterine yaz (kanıt yolu + prompt imzası dahil). */
  record: (input) => ipcRenderer.invoke('dlgsup:record', input),
  /** Motor kendi settle etti → defteri hizala (supervisor çift notify/nudge yapmasın). */
  settle: (p) => ipcRenderer.invoke('dlgsup:settle', p),
  /** Lider durumu okudu → bekleyen uyandırmalar kapanır. */
  ack: (leaderId) => ipcRenderer.invoke('dlgsup:ack', leaderId),
  /**
   * OFC-04 — sohbetten iş yönetimi: ({delegationId, subtaskId, action:'stop'|'pause'|'resume'|'cancel',
   * confirmed?}) → {ok, reason?, state?, result?}. İptal `confirmed:true` olmadan reddedilir.
   */
  control: (p) => ipcRenderer.invoke('dlgsup:control', p || {}),
  /**
   * DLG-13b — iş kilidi (SENKRON tek atım; dispatch boğazı senkron). Köprü dışı yollar:
   * ({jobId, objective, leaderId, origin}) → {ok, verdict, jobId, claimId, sentence, …} | null.
   */
  claimSync: (input) => ipcRenderer.sendSync('dlgsup:claim', input || {}),
  /** DLG-13b — dağıtım hiç başlamadıysa talebi bırak (SENKRON). */
  releaseSync: (claimId, why) => ipcRenderer.sendSync('dlgsup:release', { claimId, why }),
  /** e2e/teşhis: defteri oku, tick'i elle sür. */
  debug: (action) => ipcRenderer.invoke('dlgsup:debug', action),
  /**
   * main → renderer: "şu alt-görev bitti (supervisor tespit etti), defterini hizala
   * ve kuyruğu ilerlet". Renderer İŞLEDİKTEN SONRA cevap verir; cevap gelmezse main
   * bir sonraki tick'te yeniden dener (iş asla sessizce düşmez).
   */
  onAdvance: (cb) => {
    const handler = (_e, msg) => {
      Promise.resolve()
        .then(() => cb(msg))
        .then((ok) => ipcRenderer.send('dlgsup:advance:result', { requestId: msg && msg.requestId, ok: ok !== false }))
        .catch(() => ipcRenderer.send('dlgsup:advance:result', { requestId: msg && msg.requestId, ok: false }));
    };
    ipcRenderer.on('dlgsup:advance', handler);
    return () => ipcRenderer.removeListener('dlgsup:advance', handler);
  },
});

// ADP-293 — MOBİL GATEWAY köprüsü (iki yön):
//   (a) main → renderer SORU ('office' | 'delegations' | 'tasks') → cevap requestId ile,
//   (b) renderer → main CANLI OLAY (delegasyon/limit/onay) → gateway SSE'sine yayılır.
// Gateway'in kendisi main'de yaşar; renderer'ın ona doğrudan erişimi YOKTUR (yüzey
// ayrımı: mobil token'ı ve cihaz defteri renderer'a asla sızmaz).
contextBridge.exposeInMainWorld('mobileBridge', {
  /** main'in veri sorularını dinle. cb: ({ requestId, kind }) => void */
  onQuery: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('mobile:query', l);
    return () => ipcRenderer.removeListener('mobile:query', l);
  },
  /** Cevap: { requestId, data }. */
  queryResult: (res) => ipcRenderer.send('mobile:query:result', res),
  /** Canlı olay (MobileEvent) → SSE. */
  event: (event) => ipcRenderer.send('mobile:event', event),
  /**
   * ADP-296 — YAZMA komutları (prompt/delegate/tasks/jarvis/approve/stop). Renderer
   * MEVCUT motorları çağırır; gateway yalnız taşır. cb: ({ requestId, kind, payload }).
   */
  onCommand: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('mobile:command', l);
    return () => ipcRenderer.removeListener('mobile:command', l);
  },
  /** Cevap: { requestId, result }. */
  commandResult: (res) => ipcRenderer.send('mobile:command:result', res),
});

// ADP-293 — masaüstü "Mobil erişim" yönetimi (ADP-294 UI'ı kullanır): aç/kapa
// (kill-switch), QR eşleşme kodu üret, cihaz iptal et, durum oku.
contextBridge.exposeInMainWorld('mobileAdmin', {
  status: () => ipcRenderer.invoke('mobile:status'),
  enable: () => ipcRenderer.invoke('mobile:enable'),
  disable: () => ipcRenderer.invoke('mobile:disable'),
  createPairing: () => ipcRenderer.invoke('mobile:pair'),
  // MOB-UX-M1 (M1-b) — sihirbazın ölçümü: { tailnet:{state,address?,dnsName?},
  // gateway:{running,…}, peers:{available,phones?} }. Gateway KAPALIYKEN de çalışır.
  probe: () => ipcRenderer.invoke('mobile:probe'),
  revoke: (deviceId) => ipcRenderer.invoke('mobile:revoke', deviceId),
  // ADP-308 — cihaz yetkisi read ⇄ command (yalnız masaüstünden; telefonun kendini
  // yükseltebileceği bir rota YOK — ADP-293 §4 kapsam kuralı).
  setScope: (deviceId, scope) => ipcRenderer.invoke('mobile:scope', deviceId, scope),
});

// ADP-586 (Entegrasyon Merkezi / Dalga 0) — "Bağlı Hesaplar" köprüsü.
//
// KIRMIZI ÇİZGİ: bu köprüden DÜZ-METİN ANAHTAR GEÇMEZ. `add` sırrı MAIN'e YOLLAR
// (tek yön; oradan şifreli vault'a girer), ama hiçbir çağrı sırrı GERİ getirmez —
// `list`/`add` dönüşündeki kayıtta yalnız `meta.masked` ("sbp••••4f2a") vardır.
// muratifyApi (jeton main'de kalır) ve settingsApi (`hasOpenAiKey` bayrağı) ile aynı
// duruş. Girdi doğrulama main'de (integrationIpc.cjs) — renderer'a güvenilmez.
// JIRA-IMPORT-01 — "Masaya al" (Görevler → Jira'dan al). Anahtar bu köprüden GEÇMEZ (main kasadan
// çözer). Ticket gövdesi yalnız `ticket` ile, yalnız bu bilgisayardaki yerel defterden gelir.
// LINEAR-OAUTH-01 — aynı köprü Linear'ı da taşır: her çağrının girdisinde `source` ('jira' varsayılan
// | 'linear'). Linear'ın jetonu/anahtarı da bu köprüden geçmez.
contextBridge.exposeInMainWorld('jiraImportApi', {
  /** { source? } → { ok, connected, site } */
  status: (input) => ipcRenderer.invoke('jira:status', input),
  /** { source? } → { ok, site, projects:[{key,name,mappedTo}] } | { ok:false, cause } */
  projects: (input) => ipcRenderer.invoke('jira:projects', input),
  /** { projectKey } → { ok, mappedTo, issues:[{key,summary,status,type,url,importedTaskId}] } */
  issues: (input) => ipcRenderer.invoke('jira:issues', input),
  /** { projectKey, keys, project } → { ok, items:[{taskId,key,summary,url,branch,branchCreated}], missing, skipped } */
  prepare: (input) => ipcRenderer.invoke('jira:prepare', input),
  /** { imported:[taskId], failed:[taskId] } → { ok, imported, reverted } */
  finish: (input) => ipcRenderer.invoke('jira:finish', input),
  /** { taskId } → { ok, local, key, url, branch, body } */
  ticket: (input) => ipcRenderer.invoke('jira:ticket', input),
});

// PR-GITHUB-F3 — "GitHub'da PR aç" (isteğe bağlı, tek yön). Anahtar bu köprüden GEÇMEZ: main kasadan
// çözer ve GitHub isteğinin başlığına koyar. Dal ve hedef de buradan alınmaz (main, inceleme özetinden
// çözer); renderer yalnız görev kimliği + "sahip/depo" adayı + başlık/gövde verir. Dal gönderimi yalnız
// `push: true` ile (pencere her seferinde sorar, varsayılan kapalı).
contextBridge.exposeInMainWorld('githubPrApi', {
  /** { taskId, slug? } → { ok, connected, slug, slugSource, branch, target, canPush } */
  status: (input) => ipcRenderer.invoke('github:status', input),
  /** { taskId, slug, title, body, draft, push } → { ok, number, url, state, existed, pushed } | { ok:false, code, why, permission? } */
  open: (input) => ipcRenderer.invoke('github:open', input),
  /** { slug, number } → { ok, state, url, notModified } (ETag'li koşullu yoklama) */
  sync: (input) => ipcRenderer.invoke('github:sync', input),
  /** { slug, number } → { ok, state } (taslak → incelemeye hazır) */
  ready: (input) => ipcRenderer.invoke('github:ready', input),
});

contextBridge.exposeInMainWorld('integrationsApi', {
  /** → { ok, available, records:[{id,service,scope,env,authKind,envVar,meta}], catalog:[…] }. */
  list: () => ipcRenderer.invoke('integ:list'),
  /**
   * Yeni bağlantı: { service, secret, scope?, env?, keyLabel?, scopeHint?, userFields? }
   * → { ok, record } (record MASKELİ) | { ok:false, reason, error }.
   */
  add: (input) => ipcRenderer.invoke('integ:add', input),
  /** Bağlantıyı kes: cred_… → { ok, removed, restartHint } (açık pane'ler yeniden başlatılmalı). */
  remove: (id) => ipcRenderer.invoke('integ:remove', id),

  // ── MCP-COST-01 — MALIYET GORUNURLUGU + OTOMATIK ACILMA ISARETI ───────────
  // Ikisi de SIR TASIMAZ. `mcpStats` yalniz sayar (surec/RSS), `autostart`
  // yalniz bir sonraki pane acilisini etkiler — baglantiyi KOPARMAZ.
  /**
   * Su anki MCP maliyeti →
   * { ok, measured, paneCount, totalMb, services:{ <servis>:{panes,procs,wrappers,rssMb,orphans} } }
   * `measured:false` = `ps` okunamadi (UI sifir yazmamali, "olculemedi" demeli).
   */
  mcpStats: () => ipcRenderer.invoke('integ:mcpStats'),
  /**
   * Otomatik acilma isareti.
   *   ()                                        → { ok, map }
   *   ({ op:'set', service, enabled:false })     → { ok, map, restartHint }
   * Yazili olmayan servis ACIKTIR (varsayilan degismedi).
   */
  autostart: (payload) => ipcRenderer.invoke('integ:autostart', payload),
  /**
   * Gerçek MCP handshake ile dene: { service, env?, scope?, secret?, userFields? }
   * → { ok, tools, serverName, durationMs, reason?, error? }. `secret` verilirse
   * KAYDETMEDEN test edilir. `npx` paketi indirebileceği için uzun sürebilir.
   */
  test: (input) => ipcRenderer.invoke('integ:test', input),

  // ── ADR-INT-OAUTH — HESABINLA GİRİŞ (Gmail) ──────────────────────────────
  // 🔴 Jeton bu köprüden HİÇ geçmez (ne içeri ne dışarı): bağlanma tarayıcıda olur,
  // izin main'de kasaya girer. Renderer yalnız durum + hesap e-postası görür.
  /** → { ok, dry, services:[{ service, label, clientReady, connected, needsReauth, connecting, account, connectedAt }] } */
  oauthStatus: () => ipcRenderer.invoke('integ:oauthStatus'),
  /** Tarayıcıda Google onayını açar, dönüşü bekler → { ok, account } | { ok:false, reason } */
  oauthConnect: (service) => ipcRenderer.invoke('integ:oauthConnect', service),
  /** Açık bağlanma akışını bırak → { ok } */
  oauthCancel: (service) => ipcRenderer.invoke('integ:oauthCancel', service),
  /** Tek yerden kes: kasadan sil + sağlayıcıda iptal → { ok, removed, revokedAtProvider } */
  oauthDisconnect: (service) => ipcRenderer.invoke('integ:oauthDisconnect', service),

  // ── INT-OBS-01 — TELEMETRİ OTOMATİK KURULUMU ──────────────────────────────
  // 🔴 Bu üç çağrının HİÇBİRİ jeton TAŞIMAZ — ne içeri ne dışarı. Jeton zaten
  // kasadadır; main onu kendi çözer. Renderer yalnız "hangi servis" der ve
  // maskeli bir SONUÇ alır. `add`ten farkı budur (o, sırrı bir kez içeri yollar).
  /**
   * Kurulumu çalıştır: { service:'sentry'|'posthog', orgSlug?, teamSlug? }
   * → { ok, org, channels, notes } | { ok:false, code:'choose-org', orgs:[…] }
   *   | { ok:false, code, message }  (message KULLANICI CÜMLESİDİR, hata kodu değil)
   */
  provision: (input) => ipcRenderer.invoke('telemetry:provision', input),
  /**
   * Doğrulama olayı gönder + panoda göründüğünü OKU:
   * → { ok, channel, sent, confirmed, method, message }.
   * `confirmed:false` "gönderildi ama göremedim" demektir — sahte yeşil YOK.
   */
  verifyTelemetry: (input) => ipcRenderer.invoke('telemetry:verify', input),
  /** Durum yüzeyi → { ok, channel, services:[{service, connected, org, channels:[{channel,project,masked}], lastVerify}] }. */
  provisionStatus: () => ipcRenderer.invoke('telemetry:provisionStatus'),
});

contextBridge.exposeInMainWorld('sprintApi', {
  /** run objesini kalıcıla → { ok, file? , error? }. */
  save: (run) => ipcRenderer.invoke('sprint:save', run),
  /** id → { ok, run|null }. */
  load: (id) => ipcRenderer.invoke('sprint:load', id),
  /** → { ok, runs: [{id, settled, updatedAt, objective, taskCount}] }. */
  list: () => ipcRenderer.invoke('sprint:list'),
  /**
   * DF-03 — ÇOK-ADAYLI kanıt sondası (supervisor'ın ADP-735 çözümünün aynısı).
   * { department?, items:[{taskId, evidencePath, agentId?, since?}] }
   *   → { ok, items:[{taskId, found, path?, mtimeMs?, stale?}] }
   * Renderer'ın tek-köklü `fileApi` sondası kurulu makinede YANLIŞ köke bakıyordu.
   */
  probeEvidence: (req) => ipcRenderer.invoke('sprint:evidence', req),
  /**
   * RES-IDX-01 — SONUÇ KÖKÜ görevin projesinden (main `resultRoot.cjs`; renderer tahmin
   * etmez). { project?, codes?:[…] } → { ok, root, source, fallback, existing:[…], hasIndexScript }.
   * Worker'a rapor yolu bu kökle MUTLAK + TEK yazılır; supervisor aynı kökü birincil
   * aday yapar (BUG-R3 #8: raporlar üç yere düşüyordu).
   */
  resultRoot: (req) => ipcRenderer.invoke('sprint:resultRoot', req),
});

// SK-03 (ADR-SKILL-CENTER §8) — SKİLL MERKEZİ. `memoryApi` ile aynı desen: dosya
// tabanlı skill deposunu OKUR; SK-04 ile onaya, SK-05 ile yazmaya açıldı.
//
// ⚠️ İKİ YAZMA UCU VAR VE İKİSİ DE KAPININ AYNI TARAFINDA: `saveDraft` YALNIZ
// `.agentspace/skill-drafts`e yazar (yayına yazan bir API yok), `publish` ise insanın
// onay kartındaki tıklamasıdır. Buraya "yayına doğrudan yaz" diyen bir uç eklemek
// ADR §3'ün kapısını renderer'dan delerdi.
contextBridge.exposeInMainWorld('skillsApi', {
  /**
   * → { ok, enabled, workspaceRoot, roots:{published,drafts}, engines:[{engine,dir}],
   *     counts:{published,draft,invalid},
   *     skills:[{ name, description, source:'user'|'ai', status, scope:'published'|'draft',
   *               path, file, ok, errors, warnings, origin, author, version, task,
   *               sourceMemory, reviewer:'catalog'|'self'|'person'|null, reviewedAt, license, updatedAt,
   *               engines:[{ engine, dir, state }] }] }
   * `state`: linked | copy | absent | dangling | conflict | exposed | disabled
   * (DEPO değil DİSK ölçülür: "yayında" ile "motor görüyor" ayrışabilir.)
   */
  list: () => ipcRenderer.invoke('skills:list'),
  /** Tek skillin tam kaydı + `body`/`text` (ham SKILL.md). Yoksa null. */
  read: (name, scope) => ipcRenderer.invoke('skills:read', name, scope),
  /**
   * SKL-B0 — MOTOR başına görünüm (SALT OKUNUR; hiçbir bağ kurmaz):
   * → { enabled, workspaceRoot, canonicalRoot, published:[ad],
   *     engines:[{ engine, dir, exists, sharedWith, linked:[ad], missing:[ad],
   *                conflicts:[{name,kind,blocking}], caveat:{state,reason}|null, ok }] }
   * `ok:true` → ENG-10 dilinde rozet ÜRETİLMEZ (tam çalışan motor sessizdir).
   */
  engineViews: () => ipcRenderer.invoke('skills:engineViews'),
  /**
   * SKL-B0 — [Şimdi eşitle]: reconcile'ı ELLE koştur. → { ok, reason, summary, report }
   * `summary` taze `engineViews` çıktısıdır (UI ikinci çağrı yapmaz).
   * Taslak YAYINLAMAZ — yalnız yayındakilerin motor bağlarını kurar/temizler.
   */
  syncEngines: () => ipcRenderer.invoke('skills:syncEngines'),
  /**
   * SK-04 — TASLAĞI YAYINA AL (insan onayı). Tek çağıran: onay kartındaki tıklama.
   * → { ok, name, dir, file, version, engines, errors, warnings }
   * `ok:false` + `errors[0].code`: `draft-missing` · `already-published` (→ `overwrite`
   * ile ikinci onay) · lint kodları (kırmızı taslak YAYINLANMAZ).
   * ONAYLAYAN damgasını main yazar — burada gönderilemez (kanıt uydurulamamalı).
   */
  publish: (name, opts) => ipcRenderer.invoke('skills:publish', name, opts),
  /**
   * SK-05 — TASLAK KAYDET ("Yeni Skill" formu + "Düzenle"). Girdi:
   * `{ name, description, body, mode:'create'|'update' }`.
   * → { ok, name, dir, file, scope:'draft', forkedFromPublished, errors, warnings }
   * `ok:false` + `errors[0].code`: `name-empty` · `name-invalid` (+`suggestion`) ·
   * `name-taken` (+`scope`) · `skill-missing` · `no-workspace` · lint kodları.
   * YAZAN damgasını main yazar. Yayına yazmaz: `mode:'update'` yayındaki bir skille
   * çağrılırsa taslağa ÇATALLANIR (`forkedFromPublished:true`) — canlı dosya durur.
   */
  saveDraft: (input) => ipcRenderer.invoke('skills:saveDraft', input),
  /**
   * SK-08 — YAYIN GEÇMİŞİ (salt okunur). → { name, versions:[{version, at, action,
   * reviewedBy, path, change:{added,removed,changed,first}, exists}], count }
   * En YENİ önce. `action`: 'publish' | 'rollback'.
   */
  history: (name) => ipcRenderer.invoke('skills:history', name),
  /**
   * SK-08 — GERİ ALMA: yayındaki skilli geçmiş bir sürümüne döndür (insan tıklaması).
   * → { ok, name, version, restoredFrom, engines, history, errors }
   * `ok:false` + code: `version-missing` · `restored-by-required` · lint · `secret-detected`.
   * 🔑 Onay kapısı DELİNMEZ: hedef metin geçmişte insan onayıyla yayınlanmış olandır;
   * geri alan kişinin damgasını main yazar (burada gönderilemez).
   */
  rollback: (name, version) => ipcRenderer.invoke('skills:rollback', name, version),
  /**
   * SK-08 — DIŞA AKTAR: paylaşılabilir SKILL.md metni. → { ok, name, text, errors }
   * Sır taramasından geçer: bulgu varsa metin VERİLMEZ (`blockedBy:'secret-scan'`).
   */
  export: (name, scope) => ipcRenderer.invoke('skills:export', name, scope),
  /**
   * SEC-IPC-02 — DOSYA SEÇ: yerel diyaloğu ANA süreç açar, yol renderer'a hiç gelmez.
   * → { ok:true, token, fileName, bytes } | { ok:false, canceled? , errors }
   * `token` tek kullanımlık, 5 dk ömürlü; `import({ token })` ile harcanır.
   */
  pickFile: () => ipcRenderer.invoke('skills:pickFile'),
  /**
   * SK-08 — İÇE AKTAR: `{ text }` ya da `{ token }` (pickFile'dan; + `name`, `overwriteDraft`).
   * Ham `{ filePath }` REDDEDİLİR (`raw-path-rejected`, SEC-IPC-02).
   * → { ok, name, scope:'draft', pendingApproval:true, errors }
   * 🔴 SONUÇ HER ZAMAN TASLAKTIR — bu ucun yayına giden bir yolu YOKTUR. Yabancı onay
   * damgaları ve "published" iddiası DÜŞÜRÜLÜR; provenans (`imported`) yazılır.
   */
  import: (payload) => ipcRenderer.invoke('skills:import', payload),
  /**
   * SK-08 — ONAY KAPISI DENETİMİ (T6). → { ok, checked, findings:[{kind,name,file,message}] }
   * `kind`: `unapproved-published` (damgasız yayın) · `invalid-published` ·
   * `draft-exposed` · `agent-written` · `dangling`. Merkez bunu uyarı şeridi yapar:
   * kapıyı atlatan bir yayın SESSİZ kalmasın.
   */
  audit: () => ipcRenderer.invoke('skills:audit'),
  /**
   * SKL-B6 — DAHİLİ KATALOG (paketle gelen skill'ler), SALT OKUNUR:
   * → { ok, dir, catalogVersion, counts:{total,installed,pending,forked},
   *     skills:[{ name, description, license, source, requires, riskNotes, sha256,
   *               state, installed, ours, modified, optedOut, file, installedSha,
   *               catalogSha, sourceCatalog, suggestion? }] }
   * `state`: absent · opted-out · installed · update-available · forked ·
   *          forked-update · conflict · tampered · orphan · missing-catalog
   */
  builtinList: () => ipcRenderer.invoke('skills:builtinList'),
  /**
   * SKL-B6 — DAHİLİ SKILL'İ KUR/GÜNCELLE. `opts`: `{ installAs, force }`.
   * → { ok, changed, action:'installed'|'updated'|'unchanged'|'none', name, file, errors }
   * `ok:false` + `errors[0].code`: `name-conflict` (+`suggestion`) · `user-modified`
   * (çatal — `force` ikinci onayı ister) · `builtin-tampered` · `secret-scan` ·
   * `not-in-catalog` · `no-workspace`.
   * 🔴 Sessiz üzerine yazma YOK: kullanıcının kendi skill'i ve DÜZENLEDİĞİ kopya
   * bu uçtan ezilemez. ONAYLAYAN damgasını main yazar (burada gönderilemez).
   */
  builtinInstall: (name, opts) => ipcRenderer.invoke('skills:builtinInstall', name, opts),
  /**
   * SKL-B6 — DAHİLİ SKILL'İ KALDIR: kurulu kopya + motor bağları gider ve tercih
   * KALICI olur (bir sonraki açılış geri kurmaz). Yalnız `origin: builtin` kopyayı
   * siler — kullanıcının kendi skill'ine dokunmaz (`not-ours`).
   * → { ok, changed, action:'removed'|'unchanged', name, errors }
   */
  builtinUninstall: (name) => ipcRenderer.invoke('skills:builtinUninstall', name),
});

// ═══════════════════════════════════════════════════════════════════════════════
// SYNC-F1-6 — BULUT SENKRONU köprüsü (Ayarlar → Senkron)
// ═══════════════════════════════════════════════════════════════════════════════
// 🔴 GÖVDE BU KÖPRÜDEN GEÇMEZ. Çakışma listesi hafıza dosyalarının İÇERİĞİNİ
// taşıyabilirdi (`loser_body` 64 KB'a kadar); `syncIpc.conflictView` onu keser ve
// "kaybedeni yanına yaz" eylemi baytı MAIN tarafında diske yazıp renderer'a yalnız
// YAZILAN YOLU söyler. Böylece hafıza içeriği DevTools'a, bir XSS yüzeyine ya da
// bir renderer log satırına hiç girmez.
contextBridge.exposeInMainWorld('syncApi', {
  /** Rozet + kuruluş görüntüsü. → { ok, enabled, state, queued, conflictsOpen, realtimeProven, plan, setup } */
  status: () => ipcRenderer.invoke('sync:status'),
  /** "Şimdi eşitle" — gerçek tur (jeton tazelenir, yedek tur yeniden planlanır). */
  now: (opts) => ipcRenderer.invoke('sync:now', opts || {}),
  /** Açık çakışmalar (GÖVDESİZ). → { ok, rows:[{id,relPath,class,kind,winnerSha,loserSha,recoverable,…}], count } */
  conflicts: (opts) => ipcRenderer.invoke('sync:conflicts', opts || {}),
  /** "Kaybedeni yanına yaz" — üzerine YAZMAZ, `<ad>.conflict-<8hex>.<uzantı>` açar. → { ok, path } */
  restoreLoser: (id) => ipcRenderer.invoke('sync:restoreLoser', { id }),
  /** Kullanıcı kararını deftere yaz: 'kept-winner' | 'restored-loser' | 'merged-manual'. */
  resolveConflict: (id, resolution) => ipcRenderer.invoke('sync:resolveConflict', { id, resolution }),
  /** §5.4 sır kapısı: "bu dosyada sır yok, yükle" (sha256 ile). */
  approveSecret: (sha256) => ipcRenderer.invoke('sync:approveSecret', { sha256 }),
  /** Yeniden girişten sonra DURMUŞ kuyruğu sürdür. */
  resumeQueue: () => ipcRenderer.invoke('sync:resumeQueue'),
  /** Tercih kaydedildikten sonra motoru yeniden çöz (kapatma ANINDA söker). */
  refresh: (opts) => ipcRenderer.invoke('sync:refresh', opts || {}),
});

// ═══════════════════════════════════════════════════════════════════════════════
// SYNC-F1-7 — TAŞINABİLİR TERCİH köprüsü (renderer ekseni: `localStorage`)
// ═══════════════════════════════════════════════════════════════════════════════
// Renderer'ın `localStorage`ı main'den okunamaz; düzen/sekme tercihleri bu ince
// köprüden geçer. Sınır DAR ve TEK YÖNLÜ GÜVENLİDİR: `publish` main tarafında
// `publishRenderer` süzgecinden geçer ve YALNIZ beyaz listede `renderer` kaynaklı
// anahtarları kabul eder. Yani bu köprüden `locale`, `workspaceRoot` ya da bir
// sır projeksiyona SOKULAMAZ — bir XSS yüzeyi bile listeyi genişletemez.
contextBridge.exposeInMainWorld('prefsApi', {
  /** Bu cihazın localStorage tercihlerini projeksiyona bildir. → { ok, changed, dropped } */
  publish: (values) => ipcRenderer.invoke('prefs:publish', { values }),
  /** Projeksiyondaki renderer tercihleri + beyaz liste. → { ok, values, keys, status } */
  pull: () => ipcRenderer.invoke('prefs:pull'),
  /** Ayarlar → Senkron satırının gerçeği. → { ok, exists, keyCount, lastApplied, file } */
  status: () => ipcRenderer.invoke('prefs:status'),
  /**
   * Uzak tercihler UYGULANDI. `applied` = settings.json'a yazılan anahtarlar;
   * renderer ekseni için `pull()` çağrılır (gövde sinyalle taşınmaz — ADP-712).
   */
  onChanged: (cb) => {
    const h = (_e, payload) => { try { cb(payload); } catch { /* dinleyici hatası köprüyü düşürmez */ } };
    ipcRenderer.on('prefs:changed', h);
    return () => ipcRenderer.removeListener('prefs:changed', h);
  },
});

// ADP-243 (ADR-014 Karar 5) — the in-app "Hafıza" (Memory) view reads the file-based
// memory as a node-link graph. Read-only.
// SEARCH-2 (bumblebee) — GENEL ARAMA İNDEKSİ. `memoryApi.search` ile KARIŞTIRMA:
// o hibrit (anlam+kelime) ve yalnız HAFIZAYA bakar; bu salt kelime (FTS5) ama DÖRT
// kaynağa bakar (rapor gövdesi · hafıza · görev · ajan CLI oturumları).
//
// 🔴 BU BEYAZ LİSTE BİR KAPIDIR: burada unutulan bir metot, renderer'da sessizce
// `undefined` olur ve özellik hiçbir hata vermeden ölür (ref: preload beyaz listesi).
contextBridge.exposeInMainWorld('searchApi', {
  /**
   * → { ok:true, groups:{ [type]: { total, hits:[{type,key,title,path,line,snippet,meta,mtime,score}] } },
   *     total, ms, fts } | { ok:false, reason:'index_not_built'|'fts_unavailable'|… }
   * `ok:false` "sonuç yok" DEĞİLDİR — indeks kurulmadıysa arayüz bunu söylemeli.
   */
  query: (payload) => ipcRenderer.invoke('searchIndex:query', payload),
  /** → { running, phase, sessionsEnabled, dbFile, dbBytes, stats, lastResult }. */
  status: () => ipcRenderer.invoke('searchIndex:status'),
  /** Arka plan kurulumunu başlat → { ok, dbFile } | { ok:false, reason }. */
  reindex: () => ipcRenderer.invoke('searchIndex:reindex'),
  /** Board anlık görüntüsü (işçi Supabase'e bağlanmaz) → { ok, rows }. */
  syncTasks: (rows) => ipcRenderer.invoke('searchIndex:syncTasks', rows),
  /** OPT-OUT: false → oturum belgeleri indeksten SİLİNİR (gizlenmez). */
  setSessionsEnabled: (enabled) => ipcRenderer.invoke('searchIndex:setSessionsEnabled', enabled),
  /** İlerleme akışı: { phase:'start'|'progress'|'done'|'error'|'exit', source?, … }. */
  onEvent: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('searchIndex:event', listener);
    return () => ipcRenderer.removeListener('searchIndex:event', listener);
  },
});

contextBridge.exposeInMainWorld('memoryApi', {
  /** → { nodes:[{slug,name,type,scope,desc}], edges:[{from,to}], counts, scopes }. */
  graph: () => ipcRenderer.invoke('memory:graph'),
  /** ADP-277 — one fact's full body: (scope, slug) → { slug, scope, name, description, type, body } | null. */
  fact: (scope, slug) => ipcRenderer.invoke('memory:fact', scope, slug),
  // MEM-CORRECT-04 — kullanıcı kaydı panelden geçersiz sayar ya da düzeltir (kayıt silinmez).
  /** (scope, slug, { undo?, note? }) → { ok:true, slug, superseded } | { ok:false, reason }. */
  markWrong: (scope, slug, opts) => ipcRenderer.invoke('memory:markWrong', scope, slug, opts),
  /** (scope, slug, { description?, body? }) → { ok:true, slug, description } | { ok:false, reason }. */
  editFact: (scope, slug, patch) => ipcRenderer.invoke('memory:editFact', scope, slug, patch),
  // FB-MEM-03 — "Hakkımda": kullanıcı hakkındaki kalıcı bilgiler (listele / sil; düzeltme editFact('global', …)).
  /** → { ok:true, items:[{ slug, description }] } | { ok:false, reason }. */
  profile: () => ipcRenderer.invoke('memory:profile'),
  /** (slug) → { ok:true, slug } | { ok:false, reason }. */
  profileDelete: (slug) => ipcRenderer.invoke('memory:profileDelete', slug),

  // ADP-870 (Faz 2) — hafıza RAG indeksi. İndeksleme AYRI SÜREÇTE koşar; buradaki
  // çağrılar yalnız onu başlatır/durdurur ve ilerlemesini dinler (UI donmaz).
  /** → { running, phase, startedAt, lastEvent, lastResult, reason, dbFile }. */
  indexStatus: () => ipcRenderer.invoke('memoryIndex:status'),
  /** Arka plan indekslemeyi başlat → { ok, dbFile } | { ok:false, reason }. */
  indexStart: () => ipcRenderer.invoke('memoryIndex:start'),
  /** Nazik durdur (dosya sınırında) → { ok } | { ok:false, reason:'not_running' }. */
  indexStop: () => ipcRenderer.invoke('memoryIndex:stop'),
  /**
   * İlerleme akışı. cb gets { phase, done?, total?, chunks?, file?, rssMb?, reason? }.
   * phase: scanned|planned|indexing|done|exit|stopped|unavailable|error. Returns unsubscribe.
   */
  onIndexEvent: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('memoryIndex:event', listener);
    return () => ipcRenderer.removeListener('memoryIndex:event', listener);
  },

  // ADP-871 (Faz 3) — hibrit arama (kelime + anlam). ADP-854'ün dosya-adı eşleşmesi
  // yerinde DURUYOR; bu onun yanına gelen ikinci bir yüzey.
  /**
   * → { ok:true, results:[{ name, docPath, headingPath, lineStart, lineEnd, excerpt,
   *     matchedBy:['anlam'|'kelime'], score }], text, degraded, sources }
   *   | { ok:false, reason:'index_not_built'|'empty_query'|… }
   * `degraded:true` = anlam katmanı bu sorguya katılamadı (model ısınıyor ya da kurulu
   * değil) → sonuçlar yalnız kelime katmanından. `text` doğrudan gösterilebilir; sonuç
   * yoksa "Hafızada bunu bulamadım." der (uydurma yok).
   */
  search: (query, k) => ipcRenderer.invoke('memoryIndex:search', query, k),
  /** → { embedderReady, embedderRunning, unavailable, semanticEnabled, openIndexes }. */
  searchStatus: () => ipcRenderer.invoke('memoryIndex:searchStatus'),

  // ── ADP-900 — ANLAM KATMANI: ONAYLI İNDİRME ───────────────────────────────
  // Kural: onay verilmeden TEK BAYT inmez ve kapı MAIN tarafındadır (renderer'a
  // güvenilmez). `embedPlan` yalnız BOYUT sorar (HEAD; gövde inmez, disk yazılmaz).
  /** → { ok, prefs:{semanticEnabled,autoIndex,consent}, available, reason, model, ramMb, diskBytes, install, search }. */
  embedState: () => ipcRenderer.invoke('memoryEmbed:state'),
  /** Sunucudan ÖLÇÜLEN plan → { ok, model:{files,totalBytes,…}, runtime, totalBytes, remainingBytes, ramMb, ready, consentKey }. */
  embedPlan: () => ipcRenderer.invoke('memoryEmbed:plan'),
  /** Kullanıcının kararını damgala (granted=false → kapalı kalır, hiçbir şey inmez). */
  embedConsent: (granted, key) => ipcRenderer.invoke('memoryEmbed:consent', granted, key),
  /** İndirmeyi başlat (damga plana uymuyorsa `consent_required` döner). */
  embedInstall: () => ipcRenderer.invoke('memoryEmbed:install'),
  /** İptal — yarım dosya KALIR, sonraki deneme kaldığı yerden sürer. */
  embedCancel: () => ipcRenderer.invoke('memoryEmbed:cancel'),
  /** Model + çalışma zamanını sil → { ok, freedBytes }. */
  embedRemove: () => ipcRenderer.invoke('memoryEmbed:remove'),
  /** { semanticEnabled?, autoIndex? } → { ok, prefs }. */
  embedSetPrefs: (patch) => ipcRenderer.invoke('memoryEmbed:setPrefs', patch),
  /** Kurulum ilerlemesi: { phase, file, receivedBytes, totalBytes, reason, message }. Aboneliği bırakır. */
  onEmbedEvent: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('memoryEmbed:event', listener);
    return () => ipcRenderer.removeListener('memoryEmbed:event', listener);
  },

  // ADP-862 (st1) — ÜRÜN UCU. `search`in ham çıktısının üstünde üç GARANTİ verir:
  // her sonuçta kaynak (dosya+satır) + alıntı · sonuç yoksa "Hafızada bunu
  // bulamadım." (uydurma yok) · gösterilen metin sır maskesinden geçmiş.
  /**
   * → { ok, found, query, results:[{ source, name, scope, heading, lineStart,
   *     lineEnd, excerpt, matchedBy, score }], text, degraded, masked, reason? }
   */
  recall: (query, k) => ipcRenderer.invoke('memory:recall', query, k),
});

// ADP-095 (ADR-006 — headed automation) — browser-control bridge renderer side.
// Main asks the renderer to APPROVE a click/type before driving the internal
// browser via CDP, and pushes an activity feed for the in-panel log. Whitelisted
// channels only; the guest <webview> cannot see any of this (app-window context).
contextBridge.exposeInMainWorld('browserControlBridge', {
  /** Subscribe to approval requests. cb gets { requestId, action, selector?, text?, agentId? }. */
  onApproval: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('browser:approval', l);
    return () => ipcRenderer.removeListener('browser:approval', l);
  },
  /**
   * Reply to an approval request: { requestId, approved, scope? }.
   * ADP-341 — `scope:'session'` = "bu görev boyunca izin ver" (yalnız kapı `scope:'session'`
   * teklif ettiyse geçerlidir; TTL 30dk + eylem tavanı, diske YAZILMAZ). Yoksa tek eylemlik.
   */
  approvalResult: (res) => ipcRenderer.send('browser:approval:result', res),
  /**
   * ADP-341 (ADR-026 §3.3) — DURDUR: tüm görev-başı izinleri iptal eder ve bekleyen onay
   * varsa onu da geçersiz kılar. → { revoked, epoch }
   */
  stop: () => ipcRenderer.invoke('browser:stop'),
  /**
   * ADP-343 (ADR-026 §2.5) — OTOMASYON MODU: süre sınırlı "bu oturumda sorma" (Ayarlar → Güven).
   * `minutes` null/0 → kapat. Oturumluk: diske yazılmaz, DURDUR kapatır, hassas hedef ve yasak
   * origin bundan ETKİLENMEZ. → { active, until, remainingMs, minutes:[…] }
   */
  setAutomation: (minutes) => ipcRenderer.invoke('browser:trust:automation', { minutes }),
  /** ADP-343 — otomasyon modunun canlı durumu (geri sayım). */
  automationStatus: () => ipcRenderer.invoke('browser:trust:status'),
  /** Subscribe to the agent's browser activity feed. cb gets { action, selector?, agentId?, at }. */
  onActivity: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('browser:activity', l);
    return () => ipcRenderer.removeListener('browser:activity', l);
  },
  /**
   * BROWSER-HIFI-F3 — ajan şeridi: { agentId, op: 'pause'|'resume'|'takeover'|'stop'|'tab-closed'|'cert' }.
   * Bekletilen ajanın sonraki tarayıcı eylemi nedenini taşıyan cevapla döner. → { ok, holds }
   */
  agentControl: (p) => ipcRenderer.invoke('browser:agent-control', p),
  /** BROWSER-HIFI-F3 — bekletme defterinin anlık görüntüsü. → { holds:[{agentId,kind,since}] } */
  agentHolds: () => ipcRenderer.invoke('browser:agent-holds'),
  /** BROWSER-HIFI-F3 — main → renderer: bekletme değişti (dokunma main'de yakalanır). */
  onAgentHold: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('browser:agent-hold', l);
    return () => ipcRenderer.removeListener('browser:agent-hold', l);
  },
  /** BROWSER-HIFI-F3 — ajanın tıkladığı nokta: { guestId, agentId, x, y, at } ("sayfada imleç"). */
  onAgentPointer: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('browser:agent-pointer', l);
    return () => ipcRenderer.removeListener('browser:agent-pointer', l);
  },
  /** BROWSER-HIFI-F3 — kilide tık: { url } → { level, permissions:{media,geolocation,notifications} }. */
  siteInfo: (p) => ipcRenderer.invoke('browser:site-info', p),
  /** BROWSER-HIFI-F3 (G5) — "Ajana düzelttir" özeti sır tarayıcısından geçer → maskeli özet + açıklama. */
  fixPrepare: (raw) => ipcRenderer.invoke('browser:fix-prepare', raw),
  /** BROWSER-HIFI-F3 — adresi sistem tarayıcısında aç (yalnız http/https). → { ok } */
  openExternal: (url) => ipcRenderer.invoke('browser:open-external', { url }),
  /**
   * BROWSER-HIFI-F4 — cihaz önizleme: { guestId, device:'desktop'|'tablet'|'phone', scale, viewHeight,
   * reload? } → { ok, device }. Gerçek emülasyon main'de (mobil ekran + kullanıcı aracısı + dokunma).
   */
  emulate: (p) => ipcRenderer.invoke('browser:emulate', p),
  /** BROWSER-HIFI-F4 — geliştirici panelinin Ağ sekmesi: { guestId } → { entries, failed }. */
  netLog: (p) => ipcRenderer.invoke('browser:net-log', p),
  /** BROWSER-HIFI-F4 (G5) — ekran görüntüsü / öğe seçimi sır taraması: { texts, strings } → { hits, strings, masked }. */
  shotScan: (p) => ipcRenderer.invoke('browser:shot-scan', p),
  /**
   * ADP-135 — run a browser action (navigate/click/type/read/readPage/screenshot/
   * back) against the live internal-browser guest. Used by Jarvis voice
   * (jarvisVoice.executeBrowser). Resolves { ok, result? } | { ok:false, error }.
   */
  run: (value) => ipcRenderer.invoke('browser:action', value),
  /**
   * ADP-150 (multi-tab) — main asks the renderer to open a new IN-APP browser tab
   * when a guest does target=_blank / window.open (instead of the OS browser). cb
   * gets { url }. Returns an unsubscribe fn.
   */
  onNewTab: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('browser:new-tab', l);
    return () => ipcRenderer.removeListener('browser:new-tab', l);
  },
  /**
   * ADP-150 (multi-tab) — tell main which <webview> guest (by webContents id) is the
   * active tab, so headed automation (ADP-095) drives the visible tab. Main only
   * accepts an id it tracked at attach time (never the app renderer).
   */
  setActiveGuest: (id) => ipcRenderer.send('browser:setActiveGuest', id),
  /**
   * ACCT-OFFICE-01 — bu hesabın + kanalın iç tarayıcı bölümü (`persist:…`). SYNC: `<webview>`
   * takılmadan önce İLK DOM'da olmalı. main will-attach'te aynı adı zorlar.
   */
  partition: () => ipcRenderer.sendSync('browser:partition'),
  /**
   * ADP-333 — main, bir AJANA ait sekme açılmasını ister (ajan kendi sekmesine kilitli;
   * kullanıcının sekmesine asla girmez). cb { agentId, url } alır. Sekme ARKA PLANDA
   * açılır: patronun baktığı sayfa değişmez.
   */
  onAgentTab: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('browser:agent-tab', l);
    return () => ipcRenderer.removeListener('browser:agent-tab', l);
  },
  /**
   * WINCLOSE-GUARD-01 — sayfanın İÇİNDE ⌘W basıldı: main bu misafirin sekmesini kapatmamızı
   * ister. cb { guestId, action:'close' } alır. (⌘R'yi main kendisi yapar: yalnız o sayfa.)
   * BROWSER-HIFI-F1 — `action` artık tarayıcı tablosunun her eylemi olabilir (new, reopen,
   * focusAddress, back, forward, next, prev, nth:N, allTabs, devtools…).
   */
  onGuestShortcut: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('browser:guest-shortcut', l);
    return () => ipcRenderer.removeListener('browser:guest-shortcut', l);
  },
  /**
   * BROWSER-HIFI-F1 — sekme simgesi: main sayfanın simgesini sayfanın oturumuyla indirip
   * veri adresine çevirir. cb { guestId, dataUrl } alır (yalnız data:image/…).
   */
  onFavicon: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('browser:favicon', l);
    return () => ipcRenderer.removeListener('browser:favicon', l);
  },
  /** ADP-333 — bu sekmenin SAHİBİ şu ajan: { guestId, agentId }. */
  setTabOwner: (payload) => ipcRenderer.send('browser:setTabOwner', payload),
  /** PERF-BROWSER-TABS-01 — sekme başı süreç/bellek: { tabs: [{ id (guest webContents id), pid, mb, host, owner, ageMin, shared }], totalMb, processCount }. */
  tabMetrics: () => ipcRenderer.invoke('browser:tab-metrics'),
  /**
   * BROWSER-HIFI-F2 — GEÇMİŞ (hesap kökünde, yalnız bu bilgisayarda). Defter yalnız main'in
   * gezinme olayından yazılır; renderer adres GÖNDEREMEZ, yalnız okur / siler / temizler.
   *   historyList({ q, filter:'all'|'agents'|'local' }) → { enabled, total, entries:[{id,url,title,at,owner,host}] }
   *   historyClear('hour'|'today'|'all') → { ok, removed } — o kökenlerin çerez + site verisi de silinir
   */
  historyList: (p) => ipcRenderer.invoke('browser:history:list', p),
  historyRemove: (id) => ipcRenderer.invoke('browser:history:remove', id),
  historyClear: (range) => ipcRenderer.invoke('browser:history:clear', { range }),
  historySetEnabled: (on) => ipcRenderer.invoke('browser:history:setEnabled', on),
  /** Yeni sekme sayfası: son açılan farklı adresler (küçük resim veri adresiyle) → { enabled, items }. */
  historyRecent: () => ipcRenderer.invoke('browser:history:recent'),
  onHistoryChanged: (cb) => {
    const l = () => cb();
    ipcRenderer.on('browser:history:changed', l);
    return () => ipcRenderer.removeListener('browser:history:changed', l);
  },
  /** Yeni sekme sayfası: terminalde duyurulmuş yerel sunucular + yoklama → [{ origin, host, port, name, up, agentId, seenAt }]. */
  devServers: () => ipcRenderer.invoke('browser:devServers'),
  /**
   * ADP-394 — HAYALET MOD: main, bir guest'in KOMPOZE EDİLMESİNİ ister (otomasyon koşarken).
   * cb { guestId, on } alır. `display:none` bir <webview> kare üretmez → tıklama inmez
   * (ADP-392). Renderer o sekmeyi görünmez ama çizilen bir katmana çevirir; boşta kapatır.
   */
  onComposite: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('browser:composite', l);
    return () => ipcRenderer.removeListener('browser:composite', l);
  },
});

// ADP-121 (ADR-009 Faz 120a) — Jarvis voice core bridge. The renderer widget
// captures mic audio + runs the state machine; main owns the API key (Whisper),
// the Claude brain (`claude -p`), and macOS `say` TTS. Whitelisted channels only;
// the OpenAI key never crosses to the renderer (only a boolean `hasOpenAiKey`).
// B-06 — ONBOARDING ŞABLON ÖNERİSİ: TEK dar kanal (presets:recommend). Genel
// amaçlı "modele sor" köprüsü DEĞİL — istek yalnız serbest metin + şablon
// kataloğu taşır, cevap yalnız o kataloğun içinden bir id olabilir (main tarafı
// doğrular). Köprü yoksa (web/dev-next) renderer YEREL eşleştirmeye düşer.
contextBridge.exposeInMainWorld('presetAdvisorApi', {
  recommend: (payload) => ipcRenderer.invoke('presets:recommend', payload),
});

contextBridge.exposeInMainWorld('jarvisApi', {
  /** Capability probe → { ok, hasOpenAiKey, voice, claudeBin, voiceMode, grok }. */
  config: () => ipcRenderer.invoke('jarvis:config'),
  /**
   * ADP-827 (Faz 7) — GROK VOICE oturumu. xAI anahtarı MAIN'de kalır: renderer
   * yalnız 16 kHz PCM16 base64 parçası yollar ve olay alır. `audio` bilerek
   * `send` (invoke DEĞİL) — 20 ms'lik parçada yanıt beklemek kuyruk kurar.
   */
  grok: {
    connect: () => ipcRenderer.invoke('grok:connect'),
    audio: (base64) => ipcRenderer.send('grok:audio', base64),
    /** BİZİM cevabımızı söylet (karar bizde kalır — `force_message`). */
    say: (text) => ipcRenderer.invoke('grok:say', text),
    /** Barge-in: modelin yanıtını kes + yoldaki sesi at. */
    interrupt: () => ipcRenderer.invoke('grok:interrupt'),
    /** Oturumu kapat → { ok, usage:{seconds, usd} } (fatura şeffaflığı). */
    close: () => ipcRenderer.invoke('grok:close'),
    status: () => ipcRenderer.invoke('grok:status'),
    /** Sunucu olayları: ready · transcript · audio · error · closed · usage. */
    onEvent: (cb) => {
      const l = (_e, evt) => cb(evt);
      ipcRenderer.on('grok:event', l);
      return () => ipcRenderer.removeListener('grok:event', l);
    },
  },
  /** STT: base64 audio → { ok, text } | { ok:false, reason }. Whisper, main-side. */
  transcribe: (payload) => ipcRenderer.invoke('jarvis:transcribe', payload),
  /** A12-SES-MALIYET — ücretli yedek izni (oturumluk): { decision:'allow'|'deny', scope? }. */
  paidFallbackConsent: (payload) => ipcRenderer.invoke('jarvis:paidFallbackConsent', payload),
  /** AXF-04 — yerel ses tanıma durumu (kurulu mu, kurulum sürüyor mu). SIR İÇERMEZ. */
  localSttStatus: () => ipcRenderer.invoke('jarvis:localSttStatus'),
  /** AXF-04 — yerel ses tanıma modelini indir (yalnız kullanıcının düğmesiyle). */
  installLocalStt: () => ipcRenderer.invoke('jarvis:installLocalStt'),
  /** A12-SES-MALIYET — aylık ses bütçesi bildirimi (%80 / %100, ayda bir kez). Returns unsubscribe. */
  onVoiceBudget: (cb) => {
    const l = (_e, b) => cb(b);
    ipcRenderer.on('voice:budget', l);
    return () => ipcRenderer.removeListener('voice:budget', l);
  },
  /**
   * ADP-813 — YEREL STT ISITMA: kayıt BAŞLADIĞI an çağrılır. whisper.cpp sunucusu
   * ayağa kalkarken (~600 ms + model yükleme) kullanıcı zaten konuşuyor → ilk turun
   * soğuk bedeli (ölçüldü 1301 ms → 549 ms) kullanıcının konuşma süresine gizlenir.
   * Ateşle-unut: dönüşü beklenmeden kayıt devam eder.
   */
  warmupStt: () => ipcRenderer.invoke('jarvis:sttWarmup'),
  /**
   * ADP-815 — KATMAN 2 (kalıcı `claude` beyni) ISITMA: kayıt başlarken çağrılır.
   * Soğuk ilk tur 4–13 s, ısınmış tur p50 2.5 s (ÖLÇÜLDÜ) → bedel kullanıcının
   * konuşma süresine gizlenir. Ateşle-unut; oturum kurulamazsa karar zinciri
   * soğuk `claude -p` yoluna düşer.
   */
  warmupBrain: () => ipcRenderer.invoke('jarvis:brainWarmup'),
  /** ADP-815 — gözcü durumu (e2e/ölçüm): { alive, ready, turns, coldFallbacks, rssMb }. */
  brainStats: () => ipcRenderer.invoke('jarvis:brainStats'),
  /** ADP-815 — kalıcı oturumu KASTEN öldür (çökme→soğuk-yol testinin kaçış kapısı). */
  brainKill: (payload) => ipcRenderer.invoke('jarvis:brainKill', payload),
  /**
   * ADP-814 — AKIŞ STT: kayıt SÜRERKEN o ana kadarki kümülatif ses → hızlı `base`
   * modelinden kısmi hipotez (ölçüldü p50 ~136 ms). Yalnız EKRANA yazılır; komut
   * olarak asla çalıştırılmaz. Yerel yol kapalıysa sebep döner (bulut kullanılmaz).
   */
  transcribePartial: (payload) => ipcRenderer.invoke('jarvis:transcribePartial', payload),
  /**
   * ADP-816 (Faz 4) — TAŞINABİLİR SES WIDGET'I (ayrı, frameless, always-on-top
   * pencere). Bu köprü YALNIZ pencere + görüntü taşır: ses/kayıt/karar zincirine
   * hiçbir ucu dokunmaz. Widget penceresinin renderer'ı da AYNI preload'u yükler,
   * yani `snapshot`/`onChanged`/`move` uçlarını oradan çağırır.
   */
  widget: {
    /** Widget penceresini aç (odak ÇALMAZ — main showInactive kullanır). */
    open: () => ipcRenderer.invoke('jarvisWidget:open'),
    close: () => ipcRenderer.invoke('jarvisWidget:close'),
    toggle: () => ipcRenderer.invoke('jarvisWidget:toggle'),
    isOpen: () => ipcRenderer.invoke('jarvisWidget:isOpen'),
    /** ANA pencere → main: ses yüzeyinin son durumu (durum, kısmi metin, son çift). */
    publish: (snapshot) => ipcRenderer.invoke('jarvisWidget:publish', snapshot),
    /** WIDGET penceresi → main: mount'ta son fotoğraf (boş açılmasın). */
    snapshot: () => ipcRenderer.invoke('jarvisWidget:snapshot'),
    /** WIDGET penceresi: sürükleme deltası (frameless pencerenin taşınma yolu). */
    move: (delta) => ipcRenderer.invoke('jarvisWidget:move', delta),
    /** WIDGET penceresi: ana pencereyi göster/yeniden yarat (kullanıcı tıklaması). */
    showApp: () => ipcRenderer.invoke('jarvisWidget:showApp'),
    /** e2e/ölçüm: pencerenin GERÇEK bayrakları (alwaysOnTop/focusable/bounds). */
    debug: () => ipcRenderer.invoke('jarvisWidget:debug'),
    /** WIDGET penceresi: durum fotoğrafı değişti. Returns unsubscribe. */
    onChanged: (cb) => {
      const l = (_e, snapshot) => cb(snapshot);
      ipcRenderer.on('jarvisWidget:changed', l);
      return () => ipcRenderer.removeListener('jarvisWidget:changed', l);
    },
    /** ANA pencere: widget açıldı/kapandı (düğme gerçeği yansıtsın). */
    onOpenState: (cb) => {
      const l = (_e, payload) => cb(payload);
      ipcRenderer.on('jarvisWidget:openState', l);
      return () => ipcRenderer.removeListener('jarvisWidget:openState', l);
    },
  },
  /** Brain: { transcript, context } → { ok, decision, via } (claude or rule). */
  think: (payload) => ipcRenderer.invoke('jarvis:think', payload),
  /** A9 — sohbet cümlesi: { text, context } → { kind:'command'|'ambiguous'|'message', decision?, reason? } (beyinsiz). */
  chatIntent: (payload) => ipcRenderer.invoke('jarvis:chatIntent', payload),
  /** TTS: { text, play? } → { ok, path, bytes, ms } | { ok:false }. Uses settings engine. */
  speak: (payload) => ipcRenderer.invoke('jarvis:speak', payload),
  /** Preview a specific TTS voice with a sample sentence. { voice } → { ok, ... }. */
  preview: (payload) => ipcRenderer.invoke('jarvis:tts-preview', payload),
  /** List available TTS voices → string[]. */
  voices: () => ipcRenderer.invoke('jarvis:voices'),
  /**
   * ADP-848-B — ElevenLabs ses listesi KULLANICININ hesabından çekilir
   * ({ engine:'elevenlabs' } → { ok, voices, counts, status }). Sır DÖNMEZ.
   * Anahtar yoksa/çağrı patlarsa `status` ne olduğunu Türkçe söyler.
   */
  voiceList: (payload) => ipcRenderer.invoke('jarvis:tts-voice-list', payload),
  /**
   * AGENTX-RT-3 — AKAN TTS. `speak` SON baytı bekler; bu İLK baytı yollar.
   * Dönüş özet ({ ok, cached, firstByteMs, bytes, groups, ms }); ses PARÇALARI
   * `onSpeechChunk` ile akar. Önbellekte varsa akış YOKTUR ve `audioBase64`
   * doğrudan döner (ADP-812 yolu korunur).
   * Eski preload'larda YOK → çağıran `?.` ile korur: köprü yoksa ses sessizce
   * eski (bekleyen) yoldan çıkar, zincir kırılmaz.
   */
  speakStream: (payload) => ipcRenderer.invoke('jarvis:speakStream', payload),
  /** Akan TTS'in PCM parçaları ({ streamId, index, base64, rate, first }). Returns unsubscribe. */
  onSpeechChunk: (cb) => {
    const l = (_e, chunk) => cb(chunk);
    ipcRenderer.on('jarvis:speech-chunk', l);
    return () => ipcRenderer.removeListener('jarvis:speech-chunk', l);
  },
  /**
   * AXP-16b — MAIN'de çalan sesin GERÇEK bitişi ({ speechId, reason, at }).
   * `speak({ speechId })` ile istenir; mikrofon kapısı bunu bekler ve kestirim
   * (`sayHoldMs`) yalnız YEDEKTİR. Eski preload'larda YOK → çağıran `?.` ile
   * korur ve sessizce kestirime düşer. Returns unsubscribe.
   */
  onSpeechEnded: (cb) => {
    const l = (_e, payload) => cb(payload);
    ipcRenderer.on('jarvis:speech-ended', l);
    return () => ipcRenderer.removeListener('jarvis:speech-ended', l);
  },
  /** Akan TTS'i kes: yoldaki HTTP isteği de iptal edilir (jeton/bant yanmaz). */
  cancelSpeakStream: (streamId) => ipcRenderer.send('jarvis:speakStreamCancel', streamId),
  /** Barge-in / Esc — stop any in-flight playback. */
  stopSpeaking: () => ipcRenderer.send('jarvis:stopSpeaking'),
  // ADP-317 — KONUŞMA DEFTERİ (tek gerçek main'de). Panel de telefon da buradan
  // beslenir: masaüstünde yazılan satır telefona, telefondan gelen satır panele düşer.
  conv: {
    /** Defterin tamamı → { turns, approvals } (mount'ta hydrate; restart'ı atlatır). */
    get: () => ipcRenderer.invoke('jarvis:conv:get'),
    /** Satır ekle → { id, who, text, source, action, at } (idempotent: aynı id yok sayılır). */
    append: (turn) => ipcRenderer.invoke('jarvis:conv:append', turn),
    /** Onay kartı aç — İKİ uçta birden görünür. */
    openApproval: (approval) => ipcRenderer.invoke('jarvis:conv:approval', approval),
    /** Onayı kapat. null dönerse: BAŞKA uç zaten cevaplamış (çift çalıştırma yok). */
    resolve: (payload) => ipcRenderer.invoke('jarvis:conv:resolve', payload),
    clear: () => ipcRenderer.invoke('jarvis:conv:clear'),
    /** Defter değişti (satır/onay/çözüm) → canlı akış. Returns unsubscribe. */
    onChanged: (cb) => {
      const l = (_e, event) => cb(event);
      ipcRenderer.on('jarvis:conv:changed', l);
      return () => ipcRenderer.removeListener('jarvis:conv:changed', l);
    },
  },
  /** Global hotkey (toggle activation) pushed from main. Returns unsubscribe. */
  onHotkey: (cb) => {
    const l = () => cb();
    ipcRenderer.on('jarvis:hotkey', l);
    return () => ipcRenderer.removeListener('jarvis:hotkey', l);
  },
  /**
   * AXP-03 — AGENT X'TEN AJANA PROMPT TESLİMİ + MAKBUZ. Teslim MAIN'de yapılır
   * (ENT-F1 primitifi + transcript hükmü); renderer yalnız taslağı verir, makbuzu alır.
   * `deliver` AXP-02'nin `draft:confirmed`ını taşır: { from:{userId?,surface,kind}, target:
   * {agentId?|role?|teamId?|text?}, text, digest?, revision?, ctx:{aliases,departments,
   * activeDepartment} } → { ok:true, receipt } | { ok:false, kind:'ambiguous'|'unknown'|
   * 'denied'|'no-text'|'digest-mismatch', … }. Makbuz gövdeyi TAŞIMAZ (yalnız digest).
   * Eski preload'larda YOK → çağıran `?.` ile korur.
   */
  agentx: {
    deliver: (req) => ipcRenderer.invoke('agentx:deliver', req),
    /** Teslimsiz hedef çözümü (HEDEF SORUSU'ndan önce): { target, ctx } → resolveTarget çıktısı. */
    resolve: (req) => ipcRenderer.invoke('agentx:resolve', req),
    /** AXP-14 — uçuş-öncesi yoklama (yazmaz): { target, ctx } → { resolved, pane, state: idle|busy|menu|fresh|text|none }. */
    probe: (req) => ipcRenderer.invoke('agentx:probe', req),
    /** "Son işlemler" — oturum içi makbuz defteri (en yeni önde). */
    receipts: () => ipcRenderer.invoke('agentx:receipts'),
    retry: (id) => ipcRenderer.invoke('agentx:retry', id),
    cancel: (id) => ipcRenderer.invoke('agentx:cancel', id),
    /** ENG-BLOCK-02 — engel kartından menü seçimi: { id, digest, index } → { ok, reason?, receipt? }. */
    answerMenu: (req) => ipcRenderer.invoke('agentx:answerMenu', req),
    answerMode: (req) => ipcRenderer.invoke('agentx:answerMode', req), // ENG-BLOCK-03 — kip kartı
    /** Makbuz üretildi/değişti (ana pencere + pop-out aynı olayı dinler). Returns unsubscribe. */
    onReceipt: (cb) => {
      const l = (_e, receipt) => cb(receipt);
      ipcRenderer.on('agentx:receipt', l);
      return () => ipcRenderer.removeListener('agentx:receipt', l);
    },
    /**
     * A8-SESLI-SONUC — bir iş bitti: {id, agentId, agentName, outcome:'done'|'failed'|'unclear',
     * text, summary}. Yalnız ana pencereye gelir (tek konuşan). Returns unsubscribe.
     */
    onResult: (cb) => {
      const l = (_e, result) => cb(result);
      ipcRenderer.on('agentx:result', l);
      return () => ipcRenderer.removeListener('agentx:result', l);
    },
    /** A8 — sonuç söylendi → "ona söyle …" cevabının hedefi bu ajan olur. */
    resultSpoken: (p) => ipcRenderer.invoke('agentx:resultSpoken', p),
    /**
     * A23-ICTARAYICI — sonucun sayfasını İÇ TARAYICIDA aç. Yalnız sonuç KİMLİĞİ gider;
     * yol/URL main'deki defterden çıkar. → {ok, kind, label, deduped?} | {ok:false, reason}.
     */
    openResult: (p) => ipcRenderer.invoke('agentx:openResult', { id: p && typeof p.id === 'string' ? p.id : '' }),
    // ── AXP-04 — IŞIK ─────────────────────────────────────────────────────────
    /** Kaynak ölçümü: {orbCss} (ana pencere CSS px) → {ok, mode, origin, drawOrigin, overlay, mainContent, mainZoom}. */
    beamSource: (p) => ipcRenderer.invoke('agentx:beam:source', p),
    /** Pencere DIŞI parça için masaüstü katmanı (yalnız macOS + popout-outside). */
    beamShow: (seg) => ipcRenderer.invoke('agentx:beam:show', seg),
    beamClear: () => ipcRenderer.invoke('agentx:beam:clear'),
    /** POP-OUT penceresi: main gösterge dikdörtgenini ister; cevap `beamMeasured` ile. Returns unsubscribe. */
    onBeamMeasure: (cb) => {
      const l = (_e, p) => cb(p);
      ipcRenderer.on('agentx:beam:measure', l);
      return () => ipcRenderer.removeListener('agentx:beam:measure', l);
    },
    beamMeasured: (p) => ipcRenderer.send('agentx:beam:measured', p),
  },
});

// HAND-A1 — "EL KONTROLÜ" EKRAN ÜSTÜ GÖRSELLEŞTİRME KATMANI köprüsü.
// İki tüketicisi var: (1) overlay penceresinin renderer'ı (init/onEvents/
// onConfig/cost); (2) tespit kaynağı — D döngüsünün gizli penceresi ya da dev
// besleyici (feed). Kamera görüntüsü bu köprüden GEÇEMEZ: yalnız normalize
// telemetri olayları taşınır (şekil nöbeti main'de, handOverlayContract.cjs).
contextBridge.exposeInMainWorld('handOverlayApi', {
  /** Tespit kaynağı → main: telemetri olay(lar)ı. Katman kapalıysa (ayar açıkken) açar. */
  feed: (events) => ipcRenderer.invoke('handOverlay:feed', events),
  /** OVERLAY penceresi mount'ta: hangi ekran, hangi yoğunluk. */
  init: () => ipcRenderer.invoke('handOverlay:init'),
  isOpen: () => ipcRenderer.invoke('handOverlay:isOpen'),
  close: () => ipcRenderer.invoke('handOverlay:close'),
  /** OVERLAY penceresi → main: çizim bedeli (ms/kare) — log + rapor için. */
  cost: (payload) => ipcRenderer.invoke('handOverlay:cost', payload),
  /** e2e/kanıt: pencerelerin gerçek bayrakları (alwaysOnTop/bounds/görünürlük). */
  debug: () => ipcRenderer.invoke('handOverlay:debug'),
  /** OVERLAY penceresi: telemetri olayları geldi. Returns unsubscribe. */
  onEvents: (cb) => {
    const l = (_e, events) => cb(events);
    ipcRenderer.on('handOverlay:events', l);
    return () => ipcRenderer.removeListener('handOverlay:events', l);
  },
  /** OVERLAY penceresi: ayar (yoğunluk) canlı değişti. Returns unsubscribe. */
  onConfig: (cb) => {
    const l = (_e, overlay) => cb(overlay);
    ipcRenderer.on('handOverlay:config', l);
    return () => ipcRenderer.removeListener('handOverlay:config', l);
  },
});

// HAND-A2 — EL KONTROLÜ köprüleri. İki ayrı yüzey:
// (1) handDetectApi — YALNIZ gizli tespit penceresi kullanır (main sender'ı
//     doğrular; başka pencereden gelen kare işlenmez). Kamera KARESİ geçmez,
//     yalnız 21 landmark sayısı + zaman damgası.
// (2) handControlApi — arayüz pencereleri: başlat/durdur/rozet durumu.
contextBridge.exposeInMainWorld('handDetectApi', {
  /** Sayfa ısınmayı bitirdi (kamerasız): { ms, delegate }. */
  ready: (info) => ipcRenderer.invoke('handDetect:ready', info),
  /** 30 Hz tespit karesi: { t, hand, landmarks:[{x,y}×21], hands:[[{x,y}×21]×n] }
   *  — fire-and-forget. `hands` HAND-G1 iki-el zoom girdisi; `landmarks` tek-el
   *  yolu için KALIR. Yük BÜTÜN olarak geçer (alan beyaz listesi YOK) — yeni
   *  alan burada düşmez, şekil nöbeti main'de (handControlCore/onFrame). */
  frame: (payload) => ipcRenderer.send('handDetect:frame', payload),
  /** HAND-BUG-01 — cihaz seçim planı: sayfa enumerateDevices() sonucunu (+ varsa
   *  ölçtüğü kare istatistiklerini) verir, main SIRALI aday listesini döndürür.
   *  Karar main'de (handCameraPolicy) — sayfa yalnız uygular. */
  plan: (payload) => ipcRenderer.invoke('handDetect:plan', payload),
  /** Kamera yaşam döngüsü: { status: 'started'|'stopped'|'blank'|'error',
   *  label?, deviceId?, kind?, dead?, deadReason?, stats?, error? }. */
  camera: (info) => ipcRenderer.invoke('handDetect:camera', info),
  /** main → sayfa komutları: { cmd: 'start-camera'|'stop-camera' }. */
  onCommand: (cb) => {
    const l = (_e, msg) => cb(msg);
    ipcRenderer.on('handDetect:command', l);
    return () => ipcRenderer.removeListener('handDetect:command', l);
  },
});

contextBridge.exposeInMainWorld('handControlApi', {
  start: () => ipcRenderer.invoke('handControl:start'),
  stop: () => ipcRenderer.invoke('handControl:stop'),
  status: () => ipcRenderer.invoke('handControl:status'),
  /** HAND-BUG-01 — rozetteki cihaz seçici. { deviceId, label } ya da null
   *  (null = otomatik seçime dön). Seçim KALICI ayara yazılır. */
  selectCamera: (sel) => ipcRenderer.invoke('handControl:selectCamera', sel),
  /** Rozet canlı durumu (her faz değişiminde yayınlanır). Returns unsubscribe. */
  onStatus: (cb) => {
    const l = (_e, st) => cb(st);
    ipcRenderer.on('handControl:status', l);
    return () => ipcRenderer.removeListener('handControl:status', l);
  },
  // ── HAND-G4 — AYAR KLİNİĞİ (poz örnekleyici + kanyon) ─────────────────────
  /** `{ms?, label?}` → süre dolunca `{ok, frames, fps, metrics:{ad:{min,med,max,n}}}`.
   *  Kamera karesi ya da landmark DÖNMEZ — yalnız kapı metriklerinin özeti. */
  samplePose: (opts) => ipcRenderer.invoke('handControl:samplePose', opts || {}),
  /** İki özet → metrik metrik bantlar + kanyonlar + önerilen kesim. */
  compareSamples: (a, b) => ipcRenderer.invoke('handControl:compareSamples', { a, b }),

  // ── HAND-G2 — UYGULAMA İÇİ ZOOM ────────────────────────────────────────────
  // Beyaz liste KAPIDIR: bu iki satır olmadan zoom sessizce ölür ve kullanıcı
  // hatayı göremez ([[preload-whitelist-is-a-gate]]).
  /** Öndeki sekmenin zoom yüzeyi: 'office' | 'terminal' | null (yüzey yok).
   *  main hangi sekmenin önde olduğunu bilemez — pencere kendi bildirir. */
  reportZoomSurface: (surface) => ipcRenderer.invoke('handControl:zoomSurface', surface),
  /** main → pencere zoom yükü: { phase, surface, scale, delta, x, y }.
   *  Yalnız AgentSpace ÖNDEYKEN gelir; değilken zoom OS'a iner (HAND-G1). */
  onZoom: (cb) => {
    const l = (_e, payload) => cb(payload);
    ipcRenderer.on('handControl:zoom', l);
    return () => ipcRenderer.removeListener('handControl:zoom', l);
  },
});

// Autotest-only instrumentation channels (proof harness, not product API).
contextBridge.exposeInMainWorld('spikeProbe', {
  rendered: (chunk) => ipcRenderer.send('spike:rendered', chunk),
  done: (summary) => ipcRenderer.send('spike:done', summary),
});
